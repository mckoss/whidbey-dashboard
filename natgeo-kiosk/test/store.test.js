import { strict as assert } from 'assert';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { IssueStore } from '../lib/store.js';

async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), 'natgeo-store-'));
  return { dir, store: await new IssueStore(dir).init() };
}

test('a committed issue becomes current and is readable', async () => {
  const { dir, store } = await tempStore();
  try {
    const staged = await store.beginIssue('2026-10');
    await staged.addImage('001.jpg', Buffer.from('fake-jpeg-bytes'));
    staged.addSlide({ id: '2026-10-001', image: '/images/2026-10/001.jpg', headline: 'A' });
    const manifest = await staged.commit({ issueLabel: 'October 2026' });

    assert.equal(manifest.slideCount, 1);
    assert.equal((await store.readState()).currentIssueId, '2026-10');
    assert.equal((await store.currentManifest()).issueLabel, 'October 2026');
    assert.ok(existsSync(join(dir, 'issues', '2026-10', 'images', '001.jpg')));
    assert.equal(await readFile(join(dir, 'issues', '2026-10', 'images', '001.jpg'), 'utf8'), 'fake-jpeg-bytes');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a new issue replaces the old one and prunes its files', async () => {
  const { dir, store } = await tempStore();
  try {
    const first = await store.beginIssue('2026-10');
    await first.addImage('001.jpg', Buffer.from('old'));
    first.addSlide({ id: 'a', image: '/images/2026-10/001.jpg' });
    await first.commit({ issueLabel: 'October 2026' });

    const second = await store.beginIssue('2026-11');
    await second.addImage('001.jpg', Buffer.from('new'));
    second.addSlide({ id: 'b', image: '/images/2026-11/001.jpg' });
    await second.commit({ issueLabel: 'November 2026' });

    assert.deepEqual(await store.listIssues(), ['2026-11']);
    assert.ok(!existsSync(join(dir, 'issues', '2026-10')), 'old issue removed');
    assert.equal((await store.currentManifest()).issueId, '2026-11');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an empty issue is refused, leaving the previous issue intact', async () => {
  const { dir, store } = await tempStore();
  try {
    const good = await store.beginIssue('2026-10');
    await good.addImage('001.jpg', Buffer.from('keep-me'));
    good.addSlide({ id: 'a', image: '/images/2026-10/001.jpg' });
    await good.commit({ issueLabel: 'October 2026' });

    const empty = await store.beginIssue('2026-11');
    await assert.rejects(() => empty.commit(), /zero slides/);
    await empty.abort();

    assert.equal((await store.currentManifest()).issueId, '2026-10', 'kiosk still has an issue');
    assert.equal(await readFile(join(dir, 'issues', '2026-10', 'images', '001.jpg'), 'utf8'), 'keep-me');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a recorded error does not disturb the stored issue', async () => {
  const { dir, store } = await tempStore();
  try {
    const staged = await store.beginIssue('2026-10');
    await staged.addImage('001.jpg', Buffer.from('x'));
    staged.addSlide({ id: 'a', image: '/images/2026-10/001.jpg' });
    await staged.commit({ issueLabel: 'October 2026' });

    await store.recordError('NATGEO_SESSION_EXPIRED', 'cookie died');
    const state = await store.readState();
    assert.equal(state.lastStatus, 'error');
    assert.equal(state.lastError.code, 'NATGEO_SESSION_EXPIRED');
    assert.equal(state.currentIssueId, '2026-10', 'current issue pointer survives a failure');
    assert.equal((await store.currentManifest()).slideCount, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the store self-heals when state.json is lost but an issue is on disk', async () => {
  const { dir, store } = await tempStore();
  try {
    const staged = await store.beginIssue('2026-10');
    await staged.addImage('001.jpg', Buffer.from('x'));
    staged.addSlide({ id: 'a', image: '/images/2026-10/001.jpg' });
    await staged.commit({ issueLabel: 'October 2026' });

    await rm(join(dir, 'state.json'));
    assert.equal((await store.currentManifest()).issueId, '2026-10');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the condense cache round-trips and is keyed by content', async () => {
  const { dir, store } = await tempStore();
  try {
    const key = IssueStore.cacheKey({ caption: 'a long caption', model: 'claude-opus-5' });
    assert.equal(key, IssueStore.cacheKey({ caption: 'a long caption', model: 'claude-opus-5' }));
    assert.notEqual(key, IssueStore.cacheKey({ caption: 'different', model: 'claude-opus-5' }));
    await store.writeCache({ [key]: { short_caption: 'short' } });
    assert.equal((await store.readCache())[key].short_caption, 'short');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
