#!/usr/bin/env node
// Live structural probe. Fetches the magazine page and a couple of articles
// with the real session cookie and prints what the page actually looks like:
// which JSON blobs exist, which schema.org types, which meta tags, how many
// figures/captions, and what each extraction strategy produced.
//
// This is the tool to run first after any NatGeo redesign — and the tool whose
// output tells you what to put in config `overrides`.
//
// Usage:
//   npm run verify                 # magazine page + 2 articles
//   npm run verify -- --articles 5
//   npm run verify -- --url https://www.nationalgeographic.com/magazine/article/...
//   npm run verify -- --save page.html

import { writeFile } from 'fs/promises';
import { extractArticle, extractIssue, probePage } from '../lib/extract.js';
import { SessionExpiredError, fetchPage, reportSessionExpired, sleep } from '../lib/fetch-natgeo.js';
import { loadConfig } from '../lib/config.js';
import { upgradeCandidates } from '../lib/images.js';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function heading(text) {
  console.log(`\n${'─'.repeat(72)}\n${text}\n${'─'.repeat(72)}`);
}

function show(label, value) {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

export async function verify(config, { fetchImpl = fetch } = {}) {
  const report = { checkedAt: new Date().toISOString(), pages: [] };
  const articleLimit = Number(arg('articles', '2'));
  const singleUrl = arg('url');
  const savePath = arg('save');

  heading('SESSION');
  show('Cookie configured', config.natgeoCookie ? `yes (${config.natgeoCookie.length} chars)` : 'NO');
  show('API key configured', config.anthropicApiKey ? 'yes' : 'no (captions will be truncated)');
  show('Magazine URL', singleUrl || config.magazineUrl);

  const startUrl = singleUrl || config.magazineUrl;
  const page = await fetchPage(startUrl, config, { fetchImpl });
  if (savePath) {
    await writeFile(savePath, page.html);
    show('Saved HTML to', savePath);
  }

  const probe = probePage(page.html, page.finalUrl);
  report.pages.push({ role: singleUrl ? 'article' : 'magazine', probe });

  heading(`PAGE STRUCTURE — ${page.finalUrl}`);
  show('HTTP status', page.status);
  show('Bytes', probe.bytes.toLocaleString());
  show('<title>', probe.title.slice(0, 80));
  show('Session confidence', `${page.session.confidence} (${page.session.evidence.join(', ') || 'no markers'})`);
  console.log('\n  JSON script blocks:');
  for (const script of probe.jsonScripts) {
    console.log(`    - ${script.kind} id=${script.id || '(none)'} ${script.bytes.toLocaleString()}B`);
    console.log(`      top keys: ${script.topKeys.join(', ') || '(none)'}`);
  }
  if (!probe.jsonScripts.length) console.log('    (none)');
  console.log(`\n  JSON-LD @types: ${probe.jsonLdTypes.join(', ') || '(none)'}`);
  console.log('\n  Meta tags:');
  for (const [key, value] of Object.entries(probe.metaTags)) {
    console.log(`    ${key.padEnd(24)} ${String(value).slice(0, 80)}`);
  }
  console.log('\n  Element counts:');
  for (const [key, value] of Object.entries(probe.counts)) show(`  ${key}`, value);
  if (probe.sampleSrcsets.length) {
    console.log('\n  Sample srcsets (widths offered):');
    for (const set of probe.sampleSrcsets) {
      console.log(`    ${set.map((s) => `${s.width || s.density + 'x'}`).join(', ')}`);
      console.log(`      e.g. ${set[set.length - 1]?.url?.slice(0, 100)}`);
    }
  }

  if (singleUrl) {
    const parsed = extractArticle(page.html, { url: page.finalUrl, config });
    printArticle(parsed);
    report.pages[0].extracted = parsed;
    return report;
  }

  const index = extractIssue(page.html, { base: page.finalUrl, config });
  report.issue = index;

  heading('ISSUE IDENTIFICATION');
  show('Issue label', index.issueLabel || '(not found)');
  show('Issue id', index.issueId || '(not derived)');
  show('Label source', index.issueLabelSource || '(none)');
  show('Article candidates', index.articles.length);
  show('Candidate sources', JSON.stringify(index.report.bySource));
  console.log('\n  First article candidates:');
  for (const article of index.articles.slice(0, 10)) {
    console.log(`    [${article.source}] ${article.url}`);
    if (article.headline) console.log(`        ${article.headline.slice(0, 80)}`);
  }

  for (const article of index.articles.slice(0, articleLimit)) {
    await sleep(config.requestDelayMs);
    try {
      const articlePage = await fetchPage(article.url, config, { fetchImpl });
      const articleProbe = probePage(articlePage.html, articlePage.finalUrl);
      const parsed = extractArticle(articlePage.html, { url: articlePage.finalUrl, config });
      heading(`ARTICLE — ${article.url}`);
      show('Session confidence', articlePage.session.confidence);
      show('figure/figcaption', `${articleProbe.counts.figure}/${articleProbe.counts.figcaption}`);
      show('img/srcset', `${articleProbe.counts.img}/${articleProbe.counts.srcset}`);
      printArticle(parsed);
      report.pages.push({ role: 'article', probe: articleProbe, extracted: parsed });
    } catch (err) {
      heading(`ARTICLE — ${article.url}`);
      console.log(`  FAILED: ${err.code || err.name}: ${err.message}`);
      report.pages.push({ role: 'article', url: article.url, error: err.message });
    }
  }

  return report;
}

function printArticle(parsed) {
  show('Headline', parsed.headline.slice(0, 80) || '(none)');
  show('Article credit', parsed.credit.slice(0, 60) || '(none)');
  show('Images extracted', parsed.images.length);
  show('With caption', parsed.report.withCaption);
  show('With credit', parsed.report.withCredit);
  show('By strategy', JSON.stringify(parsed.report.bySource));
  for (const image of parsed.images.slice(0, 3)) {
    console.log(`\n    url      ${image.url.slice(0, 110)}`);
    console.log(`    upgrade  ${upgradeCandidates(image.url, { targetWidth: 4096 })[0]?.slice(0, 110)}`);
    console.log(`    caption  ${(image.caption || '(none)').slice(0, 110)}`);
    console.log(`    credit   ${image.credit || '(none)'}`);
    console.log(`    via      ${image.sources.join(', ')}`);
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  verify(config)
    .then(async (report) => {
      await writeFile('verify-report.json', `${JSON.stringify(report, null, 2)}\n`);
      console.log('\nFull machine-readable report written to verify-report.json\n');
    })
    .catch((err) => {
      if (err instanceof SessionExpiredError) {
        reportSessionExpired(err, loadConfig());
        process.exit(2);
      }
      console.error(`\nVERIFY FAILED: ${err.stack || err.message}\n`);
      process.exit(1);
    });
}
