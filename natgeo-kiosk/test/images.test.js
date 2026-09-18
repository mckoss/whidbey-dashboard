import { strict as assert } from 'assert';
import { test } from 'node:test';
import {
  bestFromSrcset, extensionFor, fetchBestImage, imageSize, inferredWidth,
  looksLikeImageResponse, normalizeImageUrl, parseSrcset, upgradeCandidates,
} from '../lib/images.js';

function pngBuffer(width, height) {
  const buf = Buffer.alloc(33);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function jpegBuffer(width, height) {
  const buf = Buffer.alloc(24, 0);
  buf[0] = 0xff; buf[1] = 0xd8;          // SOI
  buf[2] = 0xff; buf[3] = 0xc0;          // SOF0
  buf.writeUInt16BE(17, 4);              // segment length
  buf[6] = 8;                            // precision
  buf.writeUInt16BE(height, 7);
  buf.writeUInt16BE(width, 9);
  return buf;
}

test('srcset parsing keeps widths and densities', () => {
  const parsed = parseSrcset('https://a/b.jpg?x=1,2 480w, https://a/c.jpg 1600w');
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].width, 480);
  assert.equal(parsed[1].width, 1600);
  assert.equal(bestFromSrcset('https://a/b.jpg 480w, https://a/c.jpg 1600w').width, 1600);
  assert.equal(bestFromSrcset('/a.jpg 1x, /b.jpg 3x').url, '/b.jpg');
  assert.equal(bestFromSrcset(''), null);
});

test('URL normalization collapses size variants to one key', () => {
  const a = normalizeImageUrl('https://i.natgeofe.com/n/p.jpg?w=400&q=70');
  const b = normalizeImageUrl('https://i.natgeofe.com/n/p.jpg?w=2400&q=90&fit=crop');
  const c = normalizeImageUrl('https://i.natgeofe.com/n/w_800/p.jpg');
  assert.equal(a, b);
  assert.equal(c, 'https://i.natgeofe.com/n/p.jpg');
});

test('inferredWidth reads the width a URL asks for', () => {
  assert.equal(inferredWidth('https://x/p.jpg?w=1600'), 1600);
  assert.equal(inferredWidth('https://x/w_2048/p.jpg'), 2048);
  assert.equal(inferredWidth('https://x/p.jpg'), 0);
});

test('upgrade ladder asks for the target width first and keeps the original last', () => {
  const candidates = upgradeCandidates('https://i.natgeofe.com/n/p.jpg?w=500&q=70', { targetWidth: 4096 });
  assert.match(candidates[0], /w=4096/);
  assert.match(candidates[0], /q=90/);
  assert.equal(candidates[candidates.length - 1], 'https://i.natgeofe.com/n/p.jpg?w=500&q=70');
  // A URL with no width knob still yields exactly one candidate.
  assert.deepEqual(upgradeCandidates('https://x/p.jpg'), ['https://x/p.jpg']);
});

test('image headers are parsed for png and jpeg', () => {
  assert.deepEqual(imageSize(pngBuffer(1234, 567)), { type: 'png', width: 1234, height: 567 });
  assert.deepEqual(imageSize(jpegBuffer(3000, 2000)), { type: 'jpeg', width: 3000, height: 2000 });
  assert.equal(imageSize(Buffer.from('nope')), null);
});

test('extensionFor prefers the sniffed type, then the content type', () => {
  assert.equal(extensionFor('jpeg'), '.jpg');
  assert.equal(extensionFor('', 'image/webp; charset=binary'), '.webp');
  assert.equal(extensionFor('', 'text/html'), '.jpg');
});

test('an HTML body served as an image is rejected', () => {
  assert.ok(!looksLikeImageResponse({ contentType: 'text/html', buffer: Buffer.from('<!DOCTYPE html><html>') }));
  assert.ok(looksLikeImageResponse({ type: 'jpeg' }));
  assert.ok(looksLikeImageResponse({ contentType: 'image/jpeg' }));
});

function fakeFetch(map) {
  return async (url) => {
    const entry = map[url];
    if (!entry) return { ok: false, status: 404, headers: new Map([['content-type', '']]), arrayBuffer: async () => Buffer.alloc(0) };
    return {
      ok: true,
      status: 200,
      url,
      headers: { get: () => entry.contentType || 'image/jpeg' },
      arrayBuffer: async () => entry.buffer,
    };
  };
}

test('fetchBestImage takes the highest-resolution candidate that exists', async () => {
  const fetchImpl = fakeFetch({
    // The 4096 upgrade is not available; 3200 is.
    'https://i.natgeofe.com/n/p.jpg?w=3200&q=90': { buffer: jpegBuffer(3200, 2000) },
    'https://i.natgeofe.com/n/p.jpg?w=800&q=70': { buffer: jpegBuffer(800, 500) },
  });
  const result = await fetchBestImage('https://i.natgeofe.com/n/p.jpg?w=800&q=70', {
    targetWidth: 4096, fetchImpl,
  });
  assert.ok(result.ok);
  assert.equal(result.width, 3200);
  assert.match(result.url, /w=3200/);
});

test('fetchBestImage falls back to the original URL when no upgrade works', async () => {
  const fetchImpl = fakeFetch({
    'https://i.natgeofe.com/n/p.jpg?w=800&q=70': { buffer: jpegBuffer(800, 500) },
  });
  const result = await fetchBestImage('https://i.natgeofe.com/n/p.jpg?w=800&q=70', {
    targetWidth: 4096, fetchImpl,
  });
  assert.ok(result.ok);
  assert.equal(result.width, 800);
});

test('images below the quality floor are rejected, not silently accepted', async () => {
  const fetchImpl = fakeFetch({
    'https://i.natgeofe.com/n/tiny.jpg': { buffer: jpegBuffer(120, 80) },
  });
  const result = await fetchBestImage('https://i.natgeofe.com/n/tiny.jpg', {
    minWidth: 1200, fetchImpl,
  });
  assert.ok(!result.ok);
  assert.match(result.reason, /below-min-width/);
});

test('a paywall HTML body returned in place of an image is not stored', async () => {
  const fetchImpl = fakeFetch({
    'https://i.natgeofe.com/n/p.jpg': {
      buffer: Buffer.from('<!DOCTYPE html><html>sign in</html>'), contentType: 'text/html',
    },
  });
  const result = await fetchBestImage('https://i.natgeofe.com/n/p.jpg', { fetchImpl });
  assert.ok(!result.ok);
});
