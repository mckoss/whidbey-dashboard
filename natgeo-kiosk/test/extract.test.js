import { strict as assert } from 'assert';
import { test } from 'node:test';
import {
  cleanCredit, extractArticle, extractIssue, findIssueLabel, isPlausibleArticleUrl,
  issueIdFromLabel, looksLikeImageUrl, probePage, readMeta,
} from '../lib/extract.js';
import { DEFAULTS } from '../lib/config.js';
import * as F from './fixtures.js';

const config = { ...DEFAULTS };
const base = 'https://www.nationalgeographic.com/magazine';

test('issue label is read from schema.org and turned into a sortable id', () => {
  const found = findIssueLabel(F.MAGAZINE_JSONLD);
  assert.equal(found.label, 'October 2026');
  assert.equal(found.issueId, '2026-10');
});

test('issue label falls back to headings when no metadata carries it', () => {
  assert.equal(findIssueLabel(F.MAGAZINE_NEXTDATA).label, 'November 2026');
  assert.equal(findIssueLabel(F.MAGAZINE_ANCHORS_ONLY).issueId, '2026-12');
});

test('issueIdFromLabel handles every month', () => {
  assert.equal(issueIdFromLabel('January 2027'), '2027-01');
  assert.equal(issueIdFromLabel('december 1999'), '1999-12');
  assert.equal(issueIdFromLabel('not an issue'), '');
});

test('articles come from JSON-LD item lists', () => {
  const result = extractIssue(F.MAGAZINE_JSONLD, { base, config });
  const urls = result.articles.map((a) => a.url);
  assert.ok(urls.includes('https://www.nationalgeographic.com/magazine/article/deep-sea-vents'));
  assert.ok(urls.includes('https://www.nationalgeographic.com/magazine/article/sahara-nomads'));
  assert.equal(result.articles.find((a) => a.url.endsWith('deep-sea-vents')).headline, 'Life at the Vents');
});

test('articles come from embedded __NEXT_DATA__ when there is no JSON-LD', () => {
  const result = extractIssue(F.MAGAZINE_NEXTDATA, { base, config });
  const urls = result.articles.map((a) => a.url);
  assert.ok(urls.some((u) => u.endsWith('/ice-cores')));
  assert.ok(urls.some((u) => u.endsWith('/urban-foxes')));
  assert.ok(!urls.some((u) => u.includes('/newsletters')), 'deny-listed path must be dropped');
});

test('articles fall back to plain anchors, skipping navigation', () => {
  const result = extractIssue(F.MAGAZINE_ANCHORS_ONLY, { base, config });
  const urls = result.articles.map((a) => a.url);
  assert.ok(urls.some((u) => u.endsWith('/river-dolphins')));
  assert.ok(urls.some((u) => u.endsWith('/pompeii-dig')));
  assert.ok(!urls.some((u) => u.includes('/subscribe')));
  assert.ok(!urls.some((u) => u.includes('/tag/')));
  assert.ok(!urls.some((u) => u.endsWith('/magazine')), 'section index is not an article');
});

test('article URL plausibility rejects sections, nav, and other hosts', () => {
  const opts = { origin: 'https://www.nationalgeographic.com', denyList: DEFAULTS.articlePathDenyList };
  assert.ok(isPlausibleArticleUrl('https://www.nationalgeographic.com/magazine/article/x-y', opts));
  assert.ok(!isPlausibleArticleUrl('https://www.nationalgeographic.com/magazine', opts));
  assert.ok(!isPlausibleArticleUrl('https://example.com/magazine/article/x', opts));
  assert.ok(!isPlausibleArticleUrl('https://www.nationalgeographic.com/subscribe/now', opts));
});

test('figure/figcaption articles yield the largest srcset variant with caption and credit', () => {
  const parsed = extractArticle(F.ARTICLE_FIGURES, {
    url: 'https://www.nationalgeographic.com/magazine/article/deep-sea-vents', config,
  });
  assert.equal(parsed.headline, 'Life at the Vents');
  const vent1 = parsed.images.find((i) => i.url.includes('vent-01'));
  assert.ok(vent1, 'first figure image extracted');
  assert.match(vent1.url, /w=2400/, 'picks the widest srcset candidate');
  assert.match(vent1.caption, /giant tubeworms/);
  assert.ok(!/Photograph by/i.test(vent1.caption), 'credit markup is stripped out of the caption');
  assert.equal(vent1.credit, 'Maria Chen', 'credit is the name only');

  const vent2 = parsed.images.find((i) => i.url.includes('vent-02'));
  assert.match(vent2.caption, /black smoker/);
  assert.equal(vent2.credit, 'Maria Chen', 'falls back to the article-level credit');
});

test('the og:image hero is included and marked', () => {
  const parsed = extractArticle(F.ARTICLE_FIGURES, { url: 'https://x.test/a/b', config });
  const hero = parsed.images.find((i) => i.url.includes('hero-vents'));
  assert.ok(hero, 'hero image present');
  assert.equal(parsed.images[0].url, hero.url, 'hero sorts first');
});

test('embedded JSON images are extracted with caption and credit keys', () => {
  const parsed = extractArticle(F.ARTICLE_JSON_EMBEDDED, {
    url: 'https://www.nationalgeographic.com/magazine/article/sahara-nomads', config,
  });
  assert.equal(parsed.headline, 'The Last Nomads');
  const salt = parsed.images.find((i) => i.url.includes('nomad-02'));
  assert.ok(salt, 'window.__PAGE__ image extracted');
  assert.match(salt.caption, /Salt slabs/);
  assert.equal(salt.credit, 'Amara Diallo');
  const hero = parsed.images.find((i) => i.url.includes('nomad-hero'));
  assert.match(hero.caption, /caravan crosses the dunes/);
});

test('the same image at different widths is merged into one slide', () => {
  const html = `<html><body>
    <figure><img src="https://i.natgeofe.com/n/x.jpg?w=400" alt="small"><figcaption>Cap</figcaption></figure>
    <figure><img src="https://i.natgeofe.com/n/x.jpg?w=2000" alt="big"><figcaption>Cap</figcaption></figure>
  </body></html>`;
  const parsed = extractArticle(html, { url: 'https://x.test/a/b', config });
  const xImages = parsed.images.filter((i) => i.url.includes('/x.jpg'));
  assert.equal(xImages.length, 1, 'deduped by normalized URL');
  assert.match(xImages[0].url, /w=2000/, 'keeps the widest variant');
});

test('non-image assets are not treated as photographs', () => {
  assert.ok(looksLikeImageUrl('https://i.natgeofe.com/n/a.jpg'));
  assert.ok(looksLikeImageUrl('/local/photo.webp'));
  assert.ok(!looksLikeImageUrl('https://www.nationalgeographic.com/magazine/article/x'));
  assert.ok(!looksLikeImageUrl('data:image/png;base64,AAAA'));
  assert.ok(!looksLikeImageUrl(''));
  assert.ok(!looksLikeImageUrl(null));
});

test('credit cleanup trims separators and whitespace', () => {
  assert.equal(cleanCredit('  — Photograph by Ada L.  '), 'Ada L.');
  assert.equal(cleanCredit('Photographs by Ada L.'), 'Ada L.');
  assert.equal(cleanCredit('Ada L.,'), 'Ada L.');
});

test('meta tags are read from both property and name attributes', () => {
  const meta = readMeta(F.ARTICLE_FIGURES);
  assert.equal(meta['og:title'], 'Life at the Vents');
  assert.equal(meta.description, 'Hydrothermal vents teem with life.');
});

test('probePage summarizes structure without throwing on odd markup', () => {
  const probe = probePage(F.ARTICLE_FIGURES, 'https://x.test/a');
  assert.equal(probe.counts.figure, 2);
  assert.equal(probe.counts.figcaption, 2);
  assert.ok(probe.counts.img >= 2);
  assert.ok(probe.sampleSrcsets.length >= 1);
  assert.doesNotThrow(() => probePage('<html><body><img src=', 'https://x.test/a'));
  assert.doesNotThrow(() => probePage('', 'https://x.test/a'));
});

test('extraction never throws on empty or broken input', () => {
  assert.doesNotThrow(() => extractIssue('', { base, config }));
  assert.doesNotThrow(() => extractArticle('<html>', { url: base, config }));
  assert.equal(extractIssue('', { base, config }).articles.length, 0);
});
