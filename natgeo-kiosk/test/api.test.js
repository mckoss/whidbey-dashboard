// Integration tests for the served kiosk: spawns the app on an ephemeral port
// and hits the real endpoints, the way the TV browser does.

import { strict as assert } from 'assert';
import { test } from 'node:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildHealth, createApp, nextRunAt, startScheduler } from '../server.js';
import { IssueStore } from '../lib/store.js';
import { DEFAULTS, ROOT } from '../lib/config.js';

async function serve(overrides = {}, seed = true) {
  const dir = await mkdtemp(join(tmpdir(), 'natgeo-api-'));
  const config = {
    ...DEFAULTS, dataDir: dir, root: ROOT, version: '0.0.0-test',
    natgeoCookie: 'session=abc', anthropicApiKey: 'key', ...overrides,
  };
  const store = await new IssueStore(dir).init();
  if (seed) {
    const staged = await store.beginIssue('2026-10');
    await staged.addImage('001.jpg', Buffer.from('jpeg-bytes-here'));
    staged.addSlide({
      id: '2026-10-001', image: '/images/2026-10/001.jpg', width: 3000, height: 2000,
      headline: 'Life at the Vents', location: 'Galápagos Rift',
      short_caption: 'Tubeworms crowd a deep-sea vent', credit: 'Maria Chen',
      articleUrl: 'https://www.nationalgeographic.com/magazine/article/deep-sea-vents',
    });
    await staged.commit({ issueLabel: 'October 2026' });
  }
  const server = createApp(config, { store }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, config, store,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('the slideshow page is served and never cached', async () => {
  const kiosk = await serve();
  try {
    const res = await fetch(`${kiosk.base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control') || '', /no-store/);
    const html = await res.text();
    assert.match(html, /id="lower-third"/, 'lower-third overlay present');
    assert.match(html, /id="layer-a"/, 'crossfade layers present');
    assert.match(html, /overflow:\s*hidden/, 'no scrolling on the TV');
  } finally {
    await kiosk.close();
  }
});

test('/api/slides returns the current issue with overlay fields', async () => {
  const kiosk = await serve();
  try {
    const data = await fetch(`${kiosk.base}/api/slides`).then((r) => r.json());
    assert.equal(data.issueId, '2026-10');
    assert.equal(data.issueLabel, 'October 2026');
    assert.equal(data.slides.length, 1);
    const [slide] = data.slides;
    for (const field of ['image', 'headline', 'location', 'short_caption', 'credit']) {
      assert.ok(field in slide, `slide is missing ${field}`);
    }
    assert.equal(data.health.ok, true);
  } finally {
    await kiosk.close();
  }
});

test('/api/config exposes the version and the timing the page needs', async () => {
  const kiosk = await serve();
  try {
    const cfg = await fetch(`${kiosk.base}/api/config`).then((r) => r.json());
    assert.equal(cfg.version, '0.0.0-test');
    assert.ok(cfg.slideDurationMs > 0);
    assert.ok(cfg.crossfadeMs > 0);
    assert.ok(cfg.captionDelayMs > 0);
  } finally {
    await kiosk.close();
  }
});

test('harvested images are served from the data volume', async () => {
  const kiosk = await serve();
  try {
    const res = await fetch(`${kiosk.base}/images/2026-10/001.jpg`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'jpeg-bytes-here');
    assert.equal((await fetch(`${kiosk.base}/images/2026-10/missing.jpg`)).status, 404);
  } finally {
    await kiosk.close();
  }
});

test('image serving rejects path traversal', async () => {
  const kiosk = await serve();
  try {
    for (const path of ['/images/2026-10/..%2F..%2Fstate.json', '/images/..%2F..%2Fetc/passwd']) {
      const res = await fetch(`${kiosk.base}${path}`);
      assert.ok(res.status === 400 || res.status === 404, `${path} returned ${res.status}`);
    }
  } finally {
    await kiosk.close();
  }
});

test('an expired session surfaces on the API while slides keep serving', async () => {
  const kiosk = await serve();
  try {
    await kiosk.store.recordError('NATGEO_SESSION_EXPIRED', 'cookie died');
    const data = await fetch(`${kiosk.base}/api/slides`).then((r) => r.json());

    assert.equal(data.slides.length, 1, 'the last good issue still plays');
    assert.equal(data.health.ok, false);
    const problem = data.health.problems.find((p) => p.code === 'NATGEO_SESSION_EXPIRED');
    assert.ok(problem, 'the expiry is reported to the screen');
    assert.equal(problem.level, 'error');
    assert.match(problem.message, /Refresh NATGEO_COOKIE/);

    const status = await fetch(`${kiosk.base}/api/status`).then((r) => r.json());
    assert.equal(status.state.lastError.code, 'NATGEO_SESSION_EXPIRED');
    assert.equal(status.slideCount, 1);
  } finally {
    await kiosk.close();
  }
});

test('an empty kiosk says so instead of showing nothing', async () => {
  const kiosk = await serve({}, false);
  try {
    const data = await fetch(`${kiosk.base}/api/slides`).then((r) => r.json());
    assert.equal(data.slides.length, 0);
    assert.ok(data.health.problems.some((p) => p.code === 'NO_ISSUE'));
  } finally {
    await kiosk.close();
  }
});

test('buildHealth flags a missing cookie and a very old issue', () => {
  const config = { ...DEFAULTS, natgeoCookie: '' };
  const noCookie = buildHealth(config, { lastStatus: 'ok' }, { slideCount: 3, harvestedAt: new Date().toISOString() });
  assert.ok(noCookie.problems.some((p) => p.code === 'NO_COOKIE'));

  const old = buildHealth(
    { ...DEFAULTS, natgeoCookie: 'x', staleAfterHours: 36 },
    { lastStatus: 'ok' },
    { slideCount: 3, harvestedAt: new Date(Date.now() - 200 * 3600000).toISOString() },
  );
  assert.ok(old.problems.some((p) => p.code === 'ISSUE_STALE'));

  const healthy = buildHealth(
    { ...DEFAULTS, natgeoCookie: 'x' },
    { lastStatus: 'ok' },
    { slideCount: 3, harvestedAt: new Date().toISOString() },
  );
  assert.equal(healthy.ok, true);
});

test('the daily schedule resolves to the configured local hour', () => {
  const config = { ...DEFAULTS, harvestHourLocal: 4, timezone: 'America/Los_Angeles' };
  const next = nextRunAt(config, new Date('2026-09-18T20:00:00Z')); // 1pm Pacific
  const localHour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone, hour: 'numeric', hour12: false,
  }).format(next)) % 24;
  assert.equal(localHour, 4);
  assert.ok(next.getTime() > Date.parse('2026-09-18T20:00:00Z'));
});

test('the scheduler harvests on startup only when the issue is stale', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'natgeo-sched-'));
  try {
    const store = await new IssueStore(dir).init();
    const config = { ...DEFAULTS, dataDir: dir, harvestOnStartIfStale: true, staleAfterHours: 36 };

    let runs = 0;
    const runHarvest = async () => { runs += 1; return { ok: true }; };

    const fresh = await store.beginIssue('2026-10');
    await fresh.addImage('001.jpg', Buffer.from('x'));
    fresh.addSlide({ id: 'a', image: '/images/2026-10/001.jpg' });
    await fresh.commit({ issueLabel: 'October 2026' });

    const a = startScheduler(config, { store, runHarvest });
    await new Promise((resolve) => setTimeout(resolve, 50));
    a.stop();
    assert.equal(runs, 0, 'a fresh issue is not re-harvested on boot');

    // Backdate the manifest so it reads as stale.
    const manifest = await store.currentManifest();
    manifest.harvestedAt = new Date(Date.now() - 100 * 3600000).toISOString();
    const { writeFile } = await import('fs/promises');
    await writeFile(join(dir, 'issues', '2026-10', 'manifest.json'), JSON.stringify(manifest));

    const b = startScheduler(config, { store, runHarvest });
    await new Promise((resolve) => setTimeout(resolve, 50));
    b.stop();
    assert.equal(runs, 1, 'a stale issue triggers a startup harvest');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
