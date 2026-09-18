// Image URL handling: resolution selection, width-parameter upgrading, download
// with verification, and intrinsic size probing.
//
// "Highest available resolution" is settled by measurement, not by trusting a
// CDN parameter: candidate URLs are fetched and the one with the largest real
// pixel area wins.

import { createWriteStream } from 'fs';
import { mkdir, rename, rm, stat } from 'fs/promises';
import { dirname } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

// Common CDN width knobs. Upgrading is attempted in this order.
const WIDTH_PARAMS = ['w', 'width', 'maxwidth', 'max-w', 'wid'];
const QUALITY_PARAMS = ['q', 'quality'];

export function parseSrcset(srcset) {
  if (!srcset) return [];
  const out = [];
  // Split on commas that separate candidates, not commas inside URLs.
  for (const part of String(srcset).split(/\s*,\s*(?=(?:https?:)?\/|\/|[\w.~-]+\/)/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const pieces = trimmed.split(/\s+/);
    const url = pieces[0];
    if (!url) continue;
    let width = 0;
    let density = 0;
    for (const piece of pieces.slice(1)) {
      const w = piece.match(/^(\d+)w$/i);
      if (w) width = Number(w[1]);
      const x = piece.match(/^([\d.]+)x$/i);
      if (x) density = Number(x[1]);
    }
    out.push({ url, width, density });
  }
  return out;
}

export function bestFromSrcset(srcset) {
  const parsed = parseSrcset(srcset);
  if (!parsed.length) return null;
  const sorted = [...parsed].sort((a, b) => {
    if (b.width !== a.width) return b.width - a.width;
    return (b.density || 0) - (a.density || 0);
  });
  return sorted[0];
}

// The width a URL asks the CDN for. Used to compare two renditions of the same
// photograph when the markup gives no explicit width.
export function inferredWidth(url) {
  try {
    const parsed = new URL(url, 'https://www.nationalgeographic.com');
    for (const param of WIDTH_PARAMS) {
      const value = Number(parsed.searchParams.get(param));
      if (Number.isFinite(value) && value > 0) return value;
    }
    const inPath = parsed.pathname.match(/\/w_(\d+)/i);
    if (inPath) return Number(inPath[1]);
  } catch { /* fall through */ }
  return 0;
}

// Used as the dedupe key: same image rendered at different widths is one image.
export function normalizeImageUrl(url) {
  try {
    const parsed = new URL(url, 'https://www.nationalgeographic.com');
    for (const param of [...WIDTH_PARAMS, ...QUALITY_PARAMS, 'h', 'height', 'dpr', 'fit', 'crop', 'auto', 'fm', 'format']) {
      parsed.searchParams.delete(param);
    }
    parsed.hash = '';
    // CDN paths that encode a size segment, e.g. /.../w_1600/image.jpg
    parsed.pathname = parsed.pathname.replace(/\/(?:w|h)_\d+(?:,[^/]*)?\//gi, '/');
    return parsed.toString();
  } catch {
    return String(url);
  }
}

// Build a ladder of candidate URLs, highest resolution first.
export function upgradeCandidates(url, { targetWidth = 4096 } = {}) {
  const candidates = [];
  const push = (value) => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };
  let parsed;
  try {
    parsed = new URL(url, 'https://www.nationalgeographic.com');
  } catch {
    return [url];
  }

  const widthParam = WIDTH_PARAMS.find((p) => parsed.searchParams.has(p));
  if (widthParam) {
    const current = Number(parsed.searchParams.get(widthParam)) || 0;
    for (const width of [targetWidth, 3200, 2560, 2048].filter((w) => w > current)) {
      const candidate = new URL(parsed);
      candidate.searchParams.set(widthParam, String(width));
      for (const q of QUALITY_PARAMS) {
        if (candidate.searchParams.has(q)) candidate.searchParams.set(q, '90');
      }
      push(candidate.toString());
    }
  }

  // Path-encoded sizes: /w_1600/ -> /w_4096/, and the unsized original.
  if (/\/(?:w|h)_\d+/i.test(parsed.pathname)) {
    const raised = new URL(parsed);
    raised.pathname = parsed.pathname.replace(/\/w_\d+/gi, `/w_${targetWidth}`);
    push(raised.toString());
    const stripped = new URL(parsed);
    stripped.pathname = parsed.pathname.replace(/\/(?:w|h)_\d+(?:,[^/]*)?\//gi, '/');
    push(stripped.toString());
  }

  push(parsed.toString());
  return candidates;
}

// ── Intrinsic dimensions ─────────────────────────────────────────────────────
// Enough header parsing to compare candidate resolutions without a dependency.

export function imageSize(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 16) return null;

  // PNG: 8-byte signature, then IHDR.
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // GIF
  if (buf.slice(0, 3).toString('ascii') === 'GIF') {
    return { type: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }

  // WebP: RIFF....WEBP
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') {
    const chunk = buf.slice(12, 16).toString('ascii');
    if (chunk === 'VP8 ' && buf.length > 30) {
      return { type: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L' && buf.length > 25) {
      const bits = buf.readUInt32LE(21);
      return { type: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X' && buf.length > 30) {
      const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { type: 'webp', width, height };
    }
    return { type: 'webp', width: 0, height: 0 };
  }

  // JPEG: walk segments to a start-of-frame marker.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) { offset += 1; continue; }
      const marker = buf[offset + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const length = buf.readUInt16BE(offset + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf &&
        marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        return { type: 'jpeg', height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
      }
      if (marker === 0xda) break; // start of scan — no frame header found
      offset += 2 + length;
    }
    return { type: 'jpeg', width: 0, height: 0 };
  }

  // AVIF / HEIF share the ISO-BMFF box layout; dimensions live deep in meta
  // boxes, so report the type without guessing a size.
  if (buf.slice(4, 8).toString('ascii') === 'ftyp') {
    return { type: buf.slice(8, 12).toString('ascii').trim().toLowerCase(), width: 0, height: 0 };
  }
  return null;
}

export function extensionFor(type, contentType = '') {
  const known = { jpeg: '.jpg', png: '.png', webp: '.webp', gif: '.gif', avif: '.avif' };
  if (known[type]) return known[type];
  const fromMime = String(contentType).split(';')[0].trim().toLowerCase();
  const mimeMap = {
    'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
    'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif',
  };
  return mimeMap[fromMime] || '.jpg';
}

// ── Download ─────────────────────────────────────────────────────────────────

export async function fetchImage(url, { headers = {}, timeoutMs = 45000, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { headers, redirect: 'follow', signal: controller.signal });
    if (!response.ok) {
      return { ok: false, status: response.status, url };
    }
    const contentType = response.headers.get('content-type') || '';
    const buffer = Buffer.from(await response.arrayBuffer());
    const size = imageSize(buffer);
    return {
      ok: true,
      status: response.status,
      url,
      contentType,
      buffer,
      bytes: buffer.length,
      width: size?.width || 0,
      height: size?.height || 0,
      type: size?.type || '',
    };
  } catch (err) {
    return { ok: false, status: 0, url, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// Try candidates from highest to lowest resolution and keep the best real one.
// "Best" = largest pixel area, falling back to byte size when a format's
// dimensions can't be read (AVIF/HEIF).
export async function fetchBestImage(url, {
  targetWidth = 4096, minBytes = 0, minWidth = 0, headers = {}, fetchImpl = fetch,
} = {}) {
  const attempts = [];
  let best = null;
  for (const candidate of upgradeCandidates(url, { targetWidth })) {
    const result = await fetchImage(candidate, { headers, fetchImpl });
    attempts.push({
      url: candidate, ok: result.ok, status: result.status,
      bytes: result.bytes || 0, width: result.width || 0, height: result.height || 0,
    });
    if (!result.ok || !result.bytes) continue;
    if (!looksLikeImageResponse(result)) continue;
    const score = (result.width * result.height) || result.bytes;
    if (!best || score > best.score) best = { ...result, score };
    // An upgraded URL that already meets the target is good enough; stop early
    // so we make one request per image in the common case.
    if (best && best.width >= targetWidth) break;
  }
  if (!best) return { ok: false, url, attempts, reason: 'no-candidate-fetched' };
  if (minBytes && best.bytes < minBytes) {
    return { ok: false, url, attempts, reason: `below-min-bytes(${best.bytes})`, best };
  }
  if (minWidth && best.width && best.width < minWidth) {
    return { ok: false, url, attempts, reason: `below-min-width(${best.width})`, best };
  }
  return { ok: true, ...best, attempts };
}

export function looksLikeImageResponse({ contentType = '', type = '', buffer }) {
  if (type) return true;
  if (/^image\//i.test(contentType)) return true;
  // An HTML error page served with a 200 is the classic paywall symptom.
  if (buffer && buffer.slice(0, 200).toString('utf8').trim().toLowerCase().startsWith('<!doctype html')) {
    return false;
  }
  return false;
}

export async function writeFileAtomic(path, buffer) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await pipeline(Readable.from(buffer), createWriteStream(tmp));
  try {
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  const stats = await stat(path);
  return stats.size;
}
