#!/usr/bin/env node
// Daily harvest: magazine page -> current issue's articles -> images + captions
// -> condensed caption JSON -> staged issue -> atomic swap.
//
// Exit codes (so a scheduler can alert on the right thing):
//   0  success
//   2  session cookie expired or missing  (needs a human)
//   3  page structure not recognised      (needs a code/config change)
//   4  network or upstream failure        (retry later)
//   5  nothing usable harvested

import { extractArticle, extractIssue, slug } from '../lib/extract.js';
import { fetchBestImage, extensionFor } from '../lib/images.js';
import {
  FetchFailedError, SessionExpiredError, buildHeaders, fetchPage, reportSessionExpired, sleep,
} from '../lib/fetch-natgeo.js';
import { CaptionCondenser } from '../lib/condense.js';
import { IssueStore } from '../lib/store.js';
import { loadConfig } from '../lib/config.js';
import { log } from '../lib/log.js';

export const EXIT = {
  OK: 0, SESSION: 2, STRUCTURE: 3, NETWORK: 4, EMPTY: 5,
};

export async function harvest(config, {
  fetchImpl = fetch, store = null, condenser = null, force = false,
} = {}) {
  const issueStore = await (store || new IssueStore(config.dataDir)).init();

  if (!config.natgeoCookie) {
    const err = new SessionExpiredError('NATGEO_COOKIE is not set', { url: config.magazineUrl });
    reportSessionExpired(err, config);
    await issueStore.recordError(err.code, err.message, { details: err.details });
    return { ok: false, exitCode: EXIT.SESSION, code: err.code };
  }

  log.info('HARVEST_START', config.magazineUrl, { dataDir: config.dataDir });

  // 1. Magazine landing page -> issue identity + article list.
  let index;
  try {
    const page = await fetchPage(config.magazineUrl, config, { fetchImpl });
    index = extractIssue(page.html, { base: page.finalUrl, config });
    log.info('ISSUE_FOUND', index.issueLabel || '(unlabelled)', {
      issueId: index.issueId,
      labelSource: index.issueLabelSource,
      articles: index.articles.length,
      ...index.report,
    });
  } catch (err) {
    return await failRun(issueStore, err, config);
  }

  if (!index.articles.length) {
    const message =
      'No article links found on the magazine page. The page structure has ' +
      'probably changed — run `npm run verify` and set config overrides.';
    log.error('STRUCTURE_UNRECOGNISED', message, { url: config.magazineUrl, report: index.report });
    await issueStore.recordError('STRUCTURE_UNRECOGNISED', message, { report: index.report });
    return { ok: false, exitCode: EXIT.STRUCTURE, code: 'STRUCTURE_UNRECOGNISED' };
  }

  const issueId = index.issueId || slug(index.issueLabel) || `issue-${new Date().toISOString().slice(0, 7)}`;
  const state = await issueStore.readState();
  const existing = await issueStore.readManifest(issueId);
  if (!force && existing && state.currentIssueId === issueId && state.lastStatus === 'ok') {
    log.info('ISSUE_UNCHANGED', `${issueId} already harvested`, {
      slideCount: existing.slideCount, harvestedAt: existing.harvestedAt,
    });
    await issueStore.writeState({ lastRunAt: new Date().toISOString(), lastStatus: 'ok', lastError: null });
    return { ok: true, exitCode: EXIT.OK, issueId, unchanged: true, slideCount: existing.slideCount };
  }

  // 2. Each article -> images with captions and credits.
  const captions = condenser || new CaptionCondenser(config, { store: issueStore });
  await captions.load();
  const staged = await issueStore.beginIssue(issueId);
  const imageHeaders = buildHeaders(config, { Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' });
  const seenImages = new Set();
  const articleReports = [];
  let index0 = 0;

  try {
    for (const article of index.articles) {
      await sleep(config.requestDelayMs);
      let page;
      try {
        page = await fetchPage(article.url, config, { fetchImpl });
      } catch (err) {
        if (err instanceof SessionExpiredError) throw err;
        log.warn('ARTICLE_FETCH_FAILED', err.message, { url: article.url });
        articleReports.push({ url: article.url, error: err.code || 'fetch-failed' });
        continue;
      }

      const parsed = extractArticle(page.html, { url: page.finalUrl, config });
      const headline = parsed.headline || article.headline || index.issueLabel;
      log.info('ARTICLE_PARSED', headline.slice(0, 70), {
        url: article.url, images: parsed.images.length, ...parsed.report,
      });
      articleReports.push({ url: article.url, headline, ...parsed.report });

      for (const image of parsed.images) {
        const dedupeKey = image.url.split('?')[0];
        if (seenImages.has(dedupeKey)) continue;
        seenImages.add(dedupeKey);

        const fetched = await fetchBestImage(image.url, {
          targetWidth: config.targetImageWidth,
          minBytes: config.minImageBytes,
          minWidth: config.minImageWidth,
          headers: imageHeaders,
          fetchImpl,
        });
        if (!fetched.ok) {
          log.debug('IMAGE_SKIPPED', fetched.reason || 'fetch-failed', { url: image.url });
          continue;
        }

        index0 += 1;
        const filename = `${String(index0).padStart(3, '0')}${extensionFor(fetched.type, fetched.contentType)}`;
        await staged.addImage(filename, fetched.buffer);

        const condensed = await captions.condense({
          headline,
          caption: image.caption,
          credit: image.credit || parsed.credit,
          altText: image.caption,
          articleUrl: article.url,
        });

        staged.addSlide({
          id: `${issueId}-${String(index0).padStart(3, '0')}`,
          image: `/images/${issueId}/${filename}`,
          width: fetched.width,
          height: fetched.height,
          bytes: fetched.bytes,
          sourceUrl: fetched.url,
          articleUrl: article.url,
          articleHeadline: headline,
          originalCaption: image.caption,
          ...condensed,
        });
        log.info('SLIDE_ADDED', filename, {
          width: fetched.width, height: fetched.height, kb: Math.round(fetched.bytes / 1024),
        });

        if (staged.slides.length >= (config.maxArticles || 24) * (config.maxImagesPerArticle || 12)) break;
      }
    }
  } catch (err) {
    await staged.abort();
    await captions.save();
    return await failRun(issueStore, err, config);
  }

  await captions.save();

  if (!staged.slides.length) {
    await staged.abort();
    const message =
      'Articles were reachable but no usable images were extracted. Existing ' +
      'issue left in place. Run `npm run verify` to inspect page structure.';
    log.error('NO_IMAGES_HARVESTED', message, { articles: articleReports.length });
    await issueStore.recordError('NO_IMAGES_HARVESTED', message, { articles: articleReports });
    return { ok: false, exitCode: EXIT.EMPTY, code: 'NO_IMAGES_HARVESTED' };
  }

  const manifest = await staged.commit({
    issueLabel: index.issueLabel,
    issueUrl: config.magazineUrl,
    articleCount: articleReports.length,
    condenseStats: captions.stats,
  });

  log.info('HARVEST_DONE', `${issueId} (${manifest.slideCount} slides)`, {
    issueLabel: index.issueLabel,
    articles: articleReports.length,
    condense: captions.stats,
  });
  return { ok: true, exitCode: EXIT.OK, issueId, slideCount: manifest.slideCount, manifest };
}

async function failRun(store, err, config) {
  if (err instanceof SessionExpiredError) {
    reportSessionExpired(err, config);
    await store.recordError(err.code, err.message, { details: err.details });
    return { ok: false, exitCode: EXIT.SESSION, code: err.code };
  }
  if (err instanceof FetchFailedError) {
    log.error(err.code, err.message, err.details);
    await store.recordError(err.code, err.message, { details: err.details });
    return { ok: false, exitCode: EXIT.NETWORK, code: err.code };
  }
  log.error('HARVEST_FAILED', err.stack || err.message, {});
  await store.recordError('HARVEST_FAILED', err.message);
  return { ok: false, exitCode: EXIT.NETWORK, code: 'HARVEST_FAILED' };
}

// Run directly: `npm run harvest [-- --force]`
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const force = process.argv.includes('--force');
  harvest(config, { force })
    .then((result) => process.exit(result.exitCode))
    .catch((err) => {
      log.error('HARVEST_CRASH', err.stack || err.message);
      process.exit(EXIT.NETWORK);
    });
}
