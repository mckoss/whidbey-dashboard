// End-to-end harvest against a fake National Geographic, exercising the whole
// pipeline: magazine page -> articles -> images -> condensed captions ->
// atomic issue swap. No network, no API key.

import { strict as assert } from 'assert';
import { test } from 'node:test';
import { mkdtemp, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EXIT, harvest } from '../bin/harvest.js';
import { IssueStore } from '../lib/store.js';
import { CONDENSE_TOOL, CaptionCondenser } from '../lib/condense.js';
import { DEFAULTS } from '../lib/config.js';
import * as F from './fixtures.js';

function jpeg(width, height) {
  const buf = Buffer.alloc(2048, 7);
  buf[0] = 0xff; buf[1] = 0xd8;
  buf[2] = 0xff; buf[3] = 0xc0;
  buf.writeUInt16BE(17, 4);
  buf[6] = 8;
  buf.writeUInt16BE(height, 7);
  buf.writeUInt16BE(width, 9);
  return buf;
}

// Any image URL resolves; any *.jpg with a width knob reports that width.
function fakeSite({ pages, imageWidth = 3000, onFetch = () => {} } = {}) {
  return async (url) => {
    onFetch(url);
    const bare = url.split('?')[0];
    if (/\.(jpg|jpeg|png|webp)$/i.test(bare)) {
      const width = Number(new URL(url, 'https://x').searchParams.get('w')) || imageWidth;
      const buffer = jpeg(Math.min(width, imageWidth), Math.round(Math.min(width, imageWidth) * 0.66));
      return {
        ok: true, status: 200, url,
        headers: { get: () => 'image/jpeg' },
        arrayBuffer: async () => buffer,
      };
    }
    // Longest prefix wins — the magazine URL is a prefix of its article URLs.
    const key = Object.keys(pages)
      .filter((k) => url.split('?')[0].replace(/\/$/, '') === k || url.startsWith(`${k}/`))
      .sort((a, b) => b.length - a.length)[0];
    if (!key) return { ok: false, status: 404, url, text: async () => 'not found' };
    return { ok: true, status: 200, url, text: async () => pages[key] };
  };
}

async function setup(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'natgeo-harvest-'));
  const config = {
    ...DEFAULTS,
    dataDir: dir,
    natgeoCookie: 'session=abc',
    anthropicApiKey: '',
    requestDelayMs: 0,
    minImageBytes: 100,
    minImageWidth: 500,
    magazineUrl: 'https://www.nationalgeographic.com/magazine',
    ...overrides,
  };
  return { dir, config, store: await new IssueStore(dir).init() };
}

const SITE = {
  'https://www.nationalgeographic.com/magazine': F.MAGAZINE_JSONLD,
  'https://www.nationalgeographic.com/magazine/article/deep-sea-vents': F.ARTICLE_FIGURES,
  'https://www.nationalgeographic.com/magazine/article/sahara-nomads': F.ARTICLE_JSON_EMBEDDED,
};

test('a full harvest stores images, captions, and an atomic manifest', async () => {
  const { dir, config, store } = await setup();
  try {
    const result = await harvest(config, { fetchImpl: fakeSite({ pages: SITE }), store });
    assert.ok(result.ok, `harvest failed: ${result.code}`);
    assert.equal(result.issueId, '2026-10');
    assert.ok(result.slideCount >= 4, `expected several slides, got ${result.slideCount}`);

    const manifest = await store.currentManifest();
    assert.equal(manifest.issueLabel, 'October 2026');
    for (const slide of manifest.slides) {
      assert.match(slide.image, /^\/images\/2026-10\/\d{3}\.jpg$/);
      assert.ok(existsSync(join(dir, 'issues', '2026-10', 'images', slide.image.split('/').pop())));
      assert.ok(slide.width >= 500, 'stored images meet the resolution floor');
      assert.ok('location' in slide && 'short_caption' in slide && 'credit' in slide);
      assert.ok(slide.articleUrl.startsWith('https://www.nationalgeographic.com/'));
    }
    const tubeworms = manifest.slides.find((s) => /tubeworm/i.test(s.originalCaption || ''));
    assert.ok(tubeworms, 'the figcaption made it into the slide');
    assert.equal(tubeworms.credit, 'Maria Chen');

    const state = await store.readState();
    assert.equal(state.lastStatus, 'ok');
    assert.equal(state.lastError, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the highest-resolution rendition is downloaded, not the one in the markup', async () => {
  const { dir, config, store } = await setup({ targetImageWidth: 4096 });
  try {
    const requested = [];
    await harvest(config, {
      fetchImpl: fakeSite({ pages: SITE, imageWidth: 4096, onFetch: (u) => requested.push(u) }),
      store,
    });
    assert.ok(
      requested.some((u) => /\.jpg\?w=4096/.test(u)),
      'the upgrade ladder asked the CDN for the target width',
    );
    const manifest = await store.currentManifest();
    assert.ok(manifest.slides.every((s) => s.width >= 1200), 'slides are high resolution');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('captions are condensed through the Claude API when a key is present', async () => {
  const { dir, config, store } = await setup({ anthropicApiKey: 'test-key' });
  try {
    let calls = 0;
    const client = {
      messages: {
        create: async ({ tools, tool_choice, model, output_config }) => {
          calls += 1;
          assert.equal(model, 'claude-opus-5');
          assert.equal(tools[0].name, CONDENSE_TOOL.name);
          assert.equal(tools[0].strict, true);
          assert.equal(tool_choice.name, CONDENSE_TOOL.name);
          assert.equal(output_config.effort, 'low');
          return {
            stop_reason: 'tool_use',
            content: [{
              type: 'tool_use',
              name: CONDENSE_TOOL.name,
              input: {
                location: 'Galápagos Rift',
                short_caption: 'Tubeworms crowd a deep-sea vent',
                headline: 'Life at the Vents',
                credit: 'Maria Chen',
              },
            }],
          };
        },
      },
    };
    const condenser = new CaptionCondenser(config, { client, store });
    const result = await harvest(config, { fetchImpl: fakeSite({ pages: SITE }), store, condenser });
    assert.ok(result.ok);
    assert.ok(calls > 0, 'the API was called');
    const manifest = await store.currentManifest();
    assert.ok(manifest.slides.every((s) => s.location === 'Galápagos Rift'));
    assert.ok(manifest.slides.every((s) => s.short_caption === 'Tubeworms crowd a deep-sea vent'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an expired cookie leaves the previous issue untouched and exits with code 2', async () => {
  const { dir, config, store } = await setup();
  try {
    await harvest(config, { fetchImpl: fakeSite({ pages: SITE }), store });
    const before = await store.currentManifest();
    assert.ok(before.slideCount > 0);

    // Now the site starts redirecting everything to a login page.
    const expired = async (url) => ({
      ok: true, status: 200, url: 'https://www.nationalgeographic.com/auth/login',
      text: async () => '<html>sign in</html>',
    });
    const result = await harvest(config, { fetchImpl: expired, store, force: true });

    assert.ok(!result.ok);
    assert.equal(result.exitCode, EXIT.SESSION);
    assert.equal(result.code, 'NATGEO_SESSION_EXPIRED');

    const after = await store.currentManifest();
    assert.deepEqual(after, before, 'the cached issue is byte-for-byte unchanged');
    const state = await store.readState();
    assert.equal(state.lastError.code, 'NATGEO_SESSION_EXPIRED');
    assert.equal(state.currentIssueId, '2026-10');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing cookie fails immediately without touching the network', async () => {
  const { dir, config, store } = await setup({ natgeoCookie: '' });
  try {
    let called = false;
    const result = await harvest(config, {
      fetchImpl: async () => { called = true; throw new Error('should not fetch'); }, store,
    });
    assert.equal(result.exitCode, EXIT.SESSION);
    assert.equal(called, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an unrecognized page structure is reported, not silently accepted', async () => {
  const { dir, config, store } = await setup();
  try {
    const result = await harvest(config, {
      fetchImpl: fakeSite({
        pages: { 'https://www.nationalgeographic.com/magazine': '<html><body>redesigned</body></html>' },
      }),
      store,
    });
    assert.equal(result.exitCode, EXIT.STRUCTURE);
    const state = await store.readState();
    assert.equal(state.lastError.code, 'STRUCTURE_UNRECOGNISED');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('articles that yield no usable images do not blank an existing issue', async () => {
  const { dir, config, store } = await setup();
  try {
    await harvest(config, { fetchImpl: fakeSite({ pages: SITE }), store });
    const before = await store.currentManifest();

    // Same article list, but every image download now 404s.
    const noImages = async (url) => {
      const bare = url.split('?')[0];
      if (/\.(jpg|jpeg|png|webp)$/i.test(bare)) return { ok: false, status: 404, url, arrayBuffer: async () => Buffer.alloc(0) };
      const key = Object.keys(SITE)
        .filter((k) => url.split('?')[0].replace(/\/$/, '') === k || url.startsWith(`${k}/`))
        .sort((a, b) => b.length - a.length)[0];
      if (!key) return { ok: false, status: 404, url, text: async () => '' };
      return { ok: true, status: 200, url, text: async () => SITE[key] };
    };
    const result = await harvest(config, { fetchImpl: noImages, store, force: true });
    assert.equal(result.exitCode, EXIT.EMPTY);
    assert.deepEqual(await store.currentManifest(), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a re-run on the same issue is a no-op unless forced', async () => {
  const { dir, config, store } = await setup();
  try {
    await harvest(config, { fetchImpl: fakeSite({ pages: SITE }), store });
    let fetches = 0;
    const result = await harvest(config, {
      fetchImpl: fakeSite({ pages: SITE, onFetch: () => { fetches += 1; } }), store,
    });
    assert.ok(result.unchanged, 'the issue was recognized as already harvested');
    assert.equal(fetches, 1, 'only the magazine index was fetched');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a new issue replaces the previous one end to end', async () => {
  const { dir, config, store } = await setup();
  try {
    await harvest(config, { fetchImpl: fakeSite({ pages: SITE }), store });
    assert.equal((await store.currentManifest()).issueId, '2026-10');

    const nextMonth = {
      'https://www.nationalgeographic.com/magazine': F.MAGAZINE_NEXTDATA,
      'https://www.nationalgeographic.com/magazine/article/ice-cores': F.ARTICLE_FIGURES,
      'https://www.nationalgeographic.com/magazine/article/urban-foxes': F.ARTICLE_JSON_EMBEDDED,
    };
    const result = await harvest(config, { fetchImpl: fakeSite({ pages: nextMonth }), store });
    assert.ok(result.ok);
    assert.equal(result.issueId, '2026-11');
    assert.deepEqual(await store.listIssues(), ['2026-11'], 'only the current issue is kept');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
