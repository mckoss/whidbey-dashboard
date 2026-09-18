// Structure extraction for nationalgeographic.com.
//
// DESIGN NOTE — why this is strategy-based rather than selector-based:
// A publisher's markup changes without notice, and a kiosk that silently shows
// an empty issue is worse than one that fails loudly. So every field is
// gathered by several independent strategies, each of which reports what it
// found. `probePage()` turns those reports into the structural summary printed
// by `npm run verify`, which is how you confirm (or correct, via
// config `overrides`) what the live site is actually serving.
//
// Strategy priority, highest first:
//   1. ld+json     — schema.org Article / ImageObject / ItemList
//   2. embedded    — __NEXT_DATA__ and other JSON blobs, walked structurally
//   3. figure      — <figure>/<figcaption> pairs in the rendered DOM
//   4. meta        — og:/twitter: tags (hero image + headline fallback)

import {
  decodeEntities, findBlocks, findScriptJson, findTags, stripTags, walkJson,
} from './html.js';
import { compileOverride } from './config.js';
import { bestFromSrcset, inferredWidth, normalizeImageUrl, parseSrcset } from './images.js';

const IMAGE_EXT = /\.(?:jpe?g|png|webp|avif|tiff?)(?:$|[?#])/i;
// Default hint for NatGeo's image CDN. Extension matching is the primary test;
// this only rescues extensionless CDN URLs. Override via config.
const DEFAULT_IMAGE_HOST = /(?:^|\.)(?:natgeofe|nationalgeographic)\.com$/i;

const CAPTION_KEYS = ['caption', 'dsc', 'description', 'captiontext', 'alttext', 'alt', 'summary'];
const CREDIT_KEYS = ['credit', 'creditline', 'photographer', 'byline', 'attribution', 'copyrightholder', 'author'];
const URL_KEYS = ['url', 'src', 'uri', 'href', 'contenturl', 'imageurl', 'originalurl'];
const TITLE_KEYS = ['title', 'headline', 'name', 'displaytitle', 'socialtitle'];

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
const ISSUE_LABEL_RE = new RegExp(`\\b(${MONTHS.join('|')})\\s+((?:19|20)\\d{2})\\b`, 'i');

function lower(key) {
  return String(key).toLowerCase().replace(/[-_\s]/g, '');
}

function firstStringByKeys(node, keys) {
  if (!node || typeof node !== 'object') return '';
  for (const key of Object.keys(node)) {
    if (!keys.includes(lower(key))) continue;
    const value = node[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    // schema.org often nests: {"author": {"name": "..."}}
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = value.name || value.text || value.value;
      if (typeof nested === 'string' && nested.trim()) return nested.trim();
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.trim()) return item.trim();
        if (item && typeof item === 'object') {
          const nested = item.name || item.text;
          if (typeof nested === 'string' && nested.trim()) return nested.trim();
        }
      }
    }
  }
  return '';
}

export function looksLikeImageUrl(value, imageHostPattern = DEFAULT_IMAGE_HOST) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('data:')) return false;
  if (!/^https?:\/\//i.test(trimmed) && !trimmed.startsWith('//') && !trimmed.startsWith('/')) {
    return false;
  }
  if (IMAGE_EXT.test(trimmed.split('?')[0])) return true;
  try {
    const url = new URL(trimmed, 'https://www.nationalgeographic.com');
    if (imageHostPattern && imageHostPattern.test(url.hostname)) {
      // CDN host, but only if the path or query smells like an image render.
      return /image|photo|img|\.(?:jpe?g|png|webp|avif)/i.test(url.pathname + url.search);
    }
  } catch {
    return false;
  }
  return false;
}

export function absolute(url, base) {
  if (!url) return '';
  try {
    return new URL(String(url).trim(), base).toString();
  } catch {
    return '';
  }
}

// ── Strategy: ld+json ────────────────────────────────────────────────────────

export function readJsonLd(html) {
  const docs = [];
  for (const script of findScriptJson(html)) {
    if (script.kind !== 'ld+json') continue;
    const data = script.data;
    const queue = Array.isArray(data) ? [...data] : [data];
    while (queue.length) {
      const node = queue.shift();
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node['@graph'])) queue.push(...node['@graph']);
      docs.push(node);
    }
  }
  return docs;
}

// ── Strategy: embedded JSON ──────────────────────────────────────────────────

// Walk every JSON blob on the page and collect nodes that structurally look
// like an image record: some key holding an image URL, optionally alongside
// caption/credit keys.
export function collectJsonImages(html, { base, imageHostPattern } = {}) {
  const found = [];
  for (const script of findScriptJson(html)) {
    walkJson(script.data, (node) => {
      if (Array.isArray(node)) return;
      let url = '';
      for (const key of Object.keys(node)) {
        if (!URL_KEYS.includes(lower(key))) continue;
        const value = node[key];
        if (looksLikeImageUrl(value, imageHostPattern)) { url = value.trim(); break; }
        if (value && typeof value === 'object' && looksLikeImageUrl(value.url, imageHostPattern)) {
          url = String(value.url).trim();
          break;
        }
      }
      if (!url) return;
      const caption = firstStringByKeys(node, CAPTION_KEYS);
      const credit = firstStringByKeys(node, CREDIT_KEYS);
      const absoluteUrl = absolute(url, base);
      const width = Number(node.width || node.originalWidth || node.maxWidth || 0)
        || inferredWidth(absoluteUrl);
      found.push({
        url: absoluteUrl,
        caption: caption ? stripTags(caption) : '',
        credit: credit ? stripTags(credit) : '',
        width,
        source: script.id ? `json:${script.id}` : `json:${script.kind}`,
      });
    });
  }
  return found;
}

// ── Strategy: figures / img tags ─────────────────────────────────────────────

export function readFigures(html, { base, imageHostPattern } = {}) {
  const out = [];
  for (const figure of findBlocks(html, 'figure')) {
    const captionBlocks = findBlocks(figure.inner, 'figcaption');
    const captionHtml = captionBlocks.map((c) => c.inner).join(' ');
    const creditFromMarkup = extractCreditMarkup(captionHtml) || extractCreditMarkup(figure.inner);
    const captionText = stripTags(stripCreditMarkup(captionHtml));
    const picked = pickImageFromMarkup(figure.inner, { base, imageHostPattern });
    if (!picked) continue;
    out.push({
      ...picked,
      caption: captionText || picked.caption,
      credit: creditFromMarkup || picked.credit,
      source: 'figure',
    });
  }
  return out;
}

// Bare <img>/<picture> outside a <figure>.
export function readLooseImages(html, { base, imageHostPattern } = {}) {
  const withoutFigures = findBlocks(html, 'figure')
    .reduce((acc, fig) => acc.replace(fig.html, ' '), html);
  const out = [];
  for (const img of findTags(withoutFigures, 'img')) {
    const picked = pickImageFromTagAttrs(img.attrs, { base, imageHostPattern });
    if (picked) out.push({ ...picked, source: 'img' });
  }
  return out;
}

function pickImageFromMarkup(markup, opts) {
  // <picture><source srcset> beats <img src> for resolution.
  const candidates = [];
  for (const source of findTags(markup, 'source')) {
    const best = bestFromSrcset(source.attrs.srcset || source.attrs['data-srcset'] || '');
    if (best) {
      const url = absolute(best.url, opts.base);
      candidates.push({ url, width: best.width || inferredWidth(url), caption: '', credit: '' });
    }
  }
  for (const img of findTags(markup, 'img')) {
    const picked = pickImageFromTagAttrs(img.attrs, opts);
    if (picked) candidates.push(picked);
  }
  const usable = candidates.filter((c) => c.url && looksLikeImageUrl(c.url, opts.imageHostPattern));
  if (!usable.length) return null;
  usable.sort((a, b) => (b.width || 0) - (a.width || 0));
  return usable[0];
}

function pickImageFromTagAttrs(attrs, { base, imageHostPattern } = {}) {
  const srcset = attrs.srcset || attrs['data-srcset'] || '';
  const best = bestFromSrcset(srcset);
  const rawUrl = best?.url || attrs.src || attrs['data-src'] || attrs['data-lazy-src'] || '';
  const url = absolute(rawUrl, base);
  if (!url || !looksLikeImageUrl(url, imageHostPattern)) return null;
  return {
    url,
    width: best?.width || Number(attrs.width) || inferredWidth(url),
    caption: stripTags(attrs['data-caption'] || attrs.alt || ''),
    credit: stripTags(attrs['data-credit'] || ''),
  };
}

// Credit is usually a distinct element or a trailing "Photograph by X".
const CREDIT_TAG_RE = /<(span|div|p|cite)\b[^>]*(?:class|data-testid)\s*=\s*["'][^"']*(credit|byline|photograph)[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i;
const CREDIT_TEXT_RE = /\b(?:photographs?|photo|images?|illustrations?|composite|video)\s+by\s+([^.<|]{2,120})/i;

export function extractCreditMarkup(markup) {
  if (!markup) return '';
  const tagged = markup.match(CREDIT_TAG_RE);
  if (tagged) {
    const text = stripTags(tagged[3]);
    if (text) return cleanCredit(text);
  }
  const inline = stripTags(markup).match(CREDIT_TEXT_RE);
  if (inline) return cleanCredit(inline[0]);
  return '';
}

function stripCreditMarkup(markup) {
  if (!markup) return '';
  return markup.replace(CREDIT_TAG_RE, ' ');
}

// `credit` is always just the name — the overlay supplies the "Photograph by"
// wording itself, so a credit that already carries it would read twice.
export function cleanCredit(text) {
  return decodeEntities(String(text))
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;—–-]+/, '')
    .replace(/^(?:photographs?|photos?|images?|illustrations?|video)\s+by\s+/i, '')
    .replace(/[\s,;]+$/, '')  // not '.' — it would eat the period in "Ada L."

    .trim();
}

// ── Strategy: meta tags ──────────────────────────────────────────────────────

export function readMeta(html) {
  const meta = {};
  for (const tag of findTags(html, 'meta')) {
    const key = (tag.attrs.property || tag.attrs.name || tag.attrs.itemprop || '').toLowerCase();
    if (!key || !tag.attrs.content) continue;
    if (meta[key] === undefined) meta[key] = tag.attrs.content;
  }
  return meta;
}

// ── Issue page ───────────────────────────────────────────────────────────────

export function issueIdFromLabel(label) {
  const match = String(label || '').match(ISSUE_LABEL_RE);
  if (!match) return '';
  const month = String(match[1]).toLowerCase();
  return `${match[2]}-${String(MONTHS.indexOf(month) + 1).padStart(2, '0')}`;
}

export function findIssueLabel(html, { overridePattern } = {}) {
  const candidates = [];
  const push = (value, source) => {
    if (!value) return;
    const text = stripTags(String(value));
    if (overridePattern) {
      const custom = text.match(overridePattern);
      if (custom) candidates.push({ label: (custom[1] || custom[0]).trim(), source });
      return;
    }
    const match = text.match(ISSUE_LABEL_RE);
    if (match) candidates.push({ label: `${titleCase(match[1])} ${match[2]}`, source });
  };

  const meta = readMeta(html);
  push(meta['og:title'], 'meta:og:title');
  push(meta['twitter:title'], 'meta:twitter:title');
  push(meta.description, 'meta:description');

  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title) push(title[1], 'title');

  for (const level of ['h1', 'h2']) {
    for (const block of findBlocks(html, level)) push(block.inner, level);
  }
  for (const doc of readJsonLd(html)) {
    push(doc.name || doc.headline || doc.issueNumber || doc.datePublished, 'ld+json');
  }
  // Last resort: any month-year string in the top of the document.
  push(stripTags(html.slice(0, 40000)), 'body-scan');

  const best = candidates[0];
  return best ? { ...best, issueId: issueIdFromLabel(best.label) || slug(best.label) } : null;
}

function titleCase(word) {
  return String(word).charAt(0).toUpperCase() + String(word).slice(1).toLowerCase();
}

export function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
}

export function readAnchors(html, base) {
  const out = [];
  for (const block of findBlocks(html, 'a')) {
    const href = block.attrs.href;
    if (!href) continue;
    const url = absolute(href, base);
    if (!url) continue;
    out.push({ url, text: stripTags(block.inner), index: block.index });
  }
  // Anchors that never close (or that wrap block content) still matter.
  for (const tag of findTags(html, 'a')) {
    const url = absolute(tag.attrs.href, base);
    if (url && !out.some((a) => a.url === url)) out.push({ url, text: '', index: tag.index });
  }
  return out;
}

export function isPlausibleArticleUrl(url, { origin, denyList = [], overridePattern } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const originHost = (() => {
    try { return new URL(origin).hostname; } catch { return ''; }
  })();
  if (originHost && parsed.hostname !== originHost) return false;
  const path = parsed.pathname.replace(/\/+$/, '');
  if (!path || path === '/') return false;
  if (overridePattern) return overridePattern.test(path);
  if (denyList.some((deny) => path.startsWith(deny) || path.includes(deny))) return false;
  const segments = path.split('/').filter(Boolean);
  // Articles are at least two segments deep and end in a slug, not a section.
  if (segments.length < 2) return false;
  const last = segments[segments.length - 1];
  if (!/[a-z]/i.test(last)) return false;
  if (/^(?:page|\d+)$/i.test(last)) return false;
  return true;
}

export function extractIssue(html, { base, config = {} } = {}) {
  const origin = config.origin || 'https://www.nationalgeographic.com';
  const overrideLink = compileOverride(config.overrides?.articleLinkPattern);
  const overrideIssue = compileOverride(config.overrides?.issueLabelPattern);
  const issue = findIssueLabel(html, { overridePattern: overrideIssue });

  const seen = new Map();
  const consider = (url, text, source) => {
    const clean = absolute(url, base || origin);
    if (!clean) return;
    const key = clean.split('#')[0].replace(/\/+$/, '');
    if (seen.has(key)) {
      if (text && !seen.get(key).headline) seen.get(key).headline = text;
      return;
    }
    if (!isPlausibleArticleUrl(key, {
      origin, denyList: config.articlePathDenyList || [], overridePattern: overrideLink,
    })) return;
    seen.set(key, { url: key, headline: text || '', source });
  };

  // 1. schema.org ItemList / hasPart
  for (const doc of readJsonLd(html)) {
    const lists = [doc.itemListElement, doc.hasPart, doc.mainEntity].filter(Array.isArray);
    for (const list of lists) {
      for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue;
        const item = entry.item && typeof entry.item === 'object' ? entry.item : entry;
        consider(item.url || item['@id'], stripTags(item.name || item.headline || ''), 'ld+json');
      }
    }
  }

  // 2. embedded JSON records that pair a URL with a title
  for (const script of findScriptJson(html)) {
    if (script.kind === 'ld+json') continue;
    walkJson(script.data, (node) => {
      if (Array.isArray(node)) return;
      const url = firstStringByKeys(node, ['url', 'uri', 'href', 'canonicalurl', 'permalink']);
      if (!url || looksLikeImageUrl(url)) return;
      const title = firstStringByKeys(node, TITLE_KEYS);
      consider(url, stripTags(title), script.id ? `json:${script.id}` : 'json');
    });
  }

  // 3. plain anchors
  for (const anchor of readAnchors(html, base || origin)) {
    consider(anchor.url, anchor.text, 'anchor');
  }

  const articles = [...seen.values()].slice(0, config.maxArticles || 24);
  return {
    issueId: issue?.issueId || '',
    issueLabel: issue?.label || '',
    issueLabelSource: issue?.source || '',
    articles,
    report: {
      jsonLdDocs: readJsonLd(html).length,
      jsonBlobs: findScriptJson(html).length,
      anchors: readAnchors(html, base || origin).length,
      articleCandidates: articles.length,
      bySource: countBy(articles, 'source'),
    },
  };
}

// ── Article page ─────────────────────────────────────────────────────────────

export function extractArticle(html, { url, config = {} } = {}) {
  const imageHostPattern = compileOverride(config.overrides?.imageHostPattern) || DEFAULT_IMAGE_HOST;
  const base = url || config.origin;
  const meta = readMeta(html);
  const jsonLd = readJsonLd(html);

  const article = jsonLd.find((d) => /article|report|newsarticle/i.test(String(d['@type'] || '')));
  const headline = stripTags(
    article?.headline || article?.name || meta['og:title'] || meta['twitter:title'] ||
    (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || ''),
  );

  const articleCredit = cleanCredit(
    firstStringByKeys(article || {}, CREDIT_KEYS) || extractCreditMarkup(html) || '',
  );

  // Gather from every strategy, then merge by normalized URL.
  const layers = [
    { priority: 1, items: jsonLdImages(jsonLd, { base, imageHostPattern }) },
    { priority: 2, items: collectJsonImages(html, { base, imageHostPattern }) },
    { priority: 3, items: readFigures(html, { base, imageHostPattern }) },
    { priority: 4, items: readLooseImages(html, { base, imageHostPattern }) },
  ];

  const merged = new Map();
  for (const layer of layers) {
    for (const item of layer.items) {
      if (!item.url) continue;
      const key = normalizeImageUrl(item.url);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { ...item, key, priority: layer.priority, sources: [item.source] });
        continue;
      }
      existing.sources.push(item.source);
      if (!existing.caption && item.caption) existing.caption = item.caption;
      if (!existing.credit && item.credit) existing.credit = item.credit;
      if ((item.width || 0) > (existing.width || 0)) {
        existing.width = item.width;
        existing.url = item.url;
      }
    }
  }

  const heroUrl = absolute(meta['og:image'] || article?.image?.url || '', base);
  if (heroUrl && looksLikeImageUrl(heroUrl, imageHostPattern)) {
    const key = normalizeImageUrl(heroUrl);
    if (!merged.has(key)) {
      merged.set(key, {
        key, url: heroUrl, caption: stripTags(meta['og:description'] || ''),
        credit: articleCredit, width: 0, priority: 5, sources: ['meta:og:image'], hero: true,
      });
    } else {
      merged.get(key).hero = true;
    }
  }

  const images = [...merged.values()]
    .map((item) => ({
      url: item.url,
      caption: item.caption || '',
      credit: cleanCredit(item.credit || articleCredit || ''),
      width: item.width || 0,
      hero: Boolean(item.hero),
      sources: [...new Set(item.sources)],
    }))
    .filter((item) => item.url)
    .sort((a, b) => (b.hero ? 1 : 0) - (a.hero ? 1 : 0));

  return {
    url,
    headline,
    credit: articleCredit,
    images: images.slice(0, config.maxImagesPerArticle || 12),
    report: {
      jsonLdDocs: jsonLd.length,
      jsonBlobs: findScriptJson(html).length,
      figures: findBlocks(html, 'figure').length,
      imgTags: findTags(html, 'img').length,
      metaKeys: Object.keys(meta).filter((k) => k.startsWith('og:') || k.startsWith('twitter:')),
      imagesFound: images.length,
      withCaption: images.filter((i) => i.caption).length,
      withCredit: images.filter((i) => i.credit).length,
      bySource: countBy(images.flatMap((i) => i.sources.map((s) => ({ source: s }))), 'source'),
    },
  };
}

function jsonLdImages(docs, { base, imageHostPattern }) {
  const out = [];
  for (const doc of docs) {
    walkJson(doc, (node) => {
      if (Array.isArray(node)) return;
      const type = String(node['@type'] || '').toLowerCase();
      const isImage = type.includes('imageobject') || type.includes('photograph');
      const urlValue = node.contentUrl || node.url || node.image;
      const url = typeof urlValue === 'string' ? urlValue
        : (urlValue && typeof urlValue === 'object' ? urlValue.url || urlValue.contentUrl : '');
      if (!url || !looksLikeImageUrl(url, imageHostPattern)) return;
      if (!isImage && !node.caption && !node.description) return;
      out.push({
        url: absolute(url, base),
        caption: stripTags(firstStringByKeys(node, CAPTION_KEYS)),
        credit: stripTags(firstStringByKeys(node, CREDIT_KEYS)),
        width: Number(node.width) || inferredWidth(absolute(url, base)),
        source: 'ld+json',
      });
    });
  }
  return out;
}

function countBy(items, key) {
  const out = {};
  for (const item of items) {
    const value = item[key] || 'unknown';
    out[value] = (out[value] || 0) + 1;
  }
  return out;
}

// ── Structural probe (powers `npm run verify`) ───────────────────────────────

export function probePage(html, url) {
  const meta = readMeta(html);
  const scripts = findScriptJson(html);
  return {
    url,
    bytes: html.length,
    title: stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''),
    jsonScripts: scripts.map((s) => ({ kind: s.kind, id: s.id, bytes: s.bytes, topKeys: topKeys(s.data) })),
    jsonLdTypes: readJsonLd(html).map((d) => String(d['@type'] || '(untyped)')),
    metaTags: Object.fromEntries(
      Object.entries(meta).filter(([k]) => /^(og:|twitter:|article:|description$|author$)/.test(k)),
    ),
    counts: {
      figure: findBlocks(html, 'figure').length,
      figcaption: findBlocks(html, 'figcaption').length,
      img: findTags(html, 'img').length,
      picture: findTags(html, 'picture').length,
      source: findTags(html, 'source').length,
      srcset: findTags(html, 'img').filter((t) => t.attrs.srcset).length +
        findTags(html, 'source').filter((t) => t.attrs.srcset).length,
      anchors: findTags(html, 'a').length,
    },
    sampleSrcsets: [...findTags(html, 'source'), ...findTags(html, 'img')]
      .map((t) => t.attrs.srcset || t.attrs['data-srcset'])
      .filter(Boolean)
      .slice(0, 3)
      .map((s) => parseSrcset(s).slice(0, 4)),
  };
}

function topKeys(data) {
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data)) return [`[array ${data.length}]`];
  return Object.keys(data).slice(0, 12);
}
