// Express server — same shape as the whidbey-dashboard: plain Express, no
// bundler, no build step, config from config.json or Railway CONFIG_JSON,
// port from PORT. Serves the slideshow page, the slide manifest, and the
// harvested images off the data volume.

import express from 'express';
import { existsSync } from 'fs';
import { join, normalize, resolve } from 'path';
import { harvest } from './bin/harvest.js';
import { IssueStore } from './lib/store.js';
import { loadConfig } from './lib/config.js';
import { log } from './lib/log.js';

export function createApp(config, { store } = {}) {
  const app = express();
  const issueStore = store || new IssueStore(config.dataDir);
  app.set('trust proxy', true);

  const noStore = (res) => {
    res.set('Cache-Control', 'no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
  };

  app.get(['/', '/index.html'], (req, res) => {
    noStore(res);
    res.sendFile(join(config.root, 'public', 'index.html'));
  });

  app.get('/api/config', (req, res) => {
    noStore(res);
    res.json({
      version: config.version,
      slideDurationMs: config.slideDurationMs,
      crossfadeMs: config.crossfadeMs,
      captionDelayMs: config.captionDelayMs,
    });
  });

  // The slideshow payload. Always reports the health of the last harvest so
  // the page can warn on screen instead of quietly looping a stale issue.
  app.get('/api/slides', async (req, res) => {
    noStore(res);
    try {
      const [manifest, state] = await Promise.all([
        issueStore.currentManifest(), issueStore.readState(),
      ]);
      res.json({
        issueId: manifest?.issueId || '',
        issueLabel: manifest?.issueLabel || '',
        harvestedAt: manifest?.harvestedAt || null,
        slides: manifest?.slides || [],
        health: buildHealth(config, state, manifest),
      });
    } catch (err) {
      log.error('SLIDES_FAILED', err.message);
      res.status(500).json({ error: err.message, slides: [] });
    }
  });

  app.get('/api/status', async (req, res) => {
    noStore(res);
    const [manifest, state] = await Promise.all([
      issueStore.currentManifest(), issueStore.readState(),
    ]);
    res.json({
      version: config.version,
      issueId: manifest?.issueId || '',
      issueLabel: manifest?.issueLabel || '',
      slideCount: manifest?.slideCount || 0,
      harvestedAt: manifest?.harvestedAt || null,
      cookieConfigured: Boolean(config.natgeoCookie),
      apiKeyConfigured: Boolean(config.anthropicApiKey),
      state,
      health: buildHealth(config, state, manifest),
    });
  });

  // Harvested images live on the data volume, outside the repo.
  app.get('/images/:issueId/:filename', (req, res) => {
    const { issueId, filename } = req.params;
    if (!/^[\w.-]+$/.test(issueId) || !/^[\w.-]+$/.test(filename)) {
      return res.status(400).end();
    }
    const imagesRoot = resolve(issueStore.issueDir(issueId), 'images');
    const path = resolve(normalize(join(imagesRoot, filename)));
    if (!path.startsWith(`${imagesRoot}`) || !existsSync(path)) return res.status(404).end();
    // Filenames are stable within an issue and the issue is replaced wholesale.
    res.set('Cache-Control', 'public, max-age=86400');
    return res.sendFile(path);
  });

  app.use(express.static(join(config.root, 'public'), {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) noStore(res);
    },
  }));

  return app;
}

// One place that decides what the TV should warn about.
export function buildHealth(config, state, manifest, now = Date.now()) {
  const problems = [];
  if (!config.natgeoCookie) {
    problems.push({
      level: 'error', code: 'NO_COOKIE',
      message: 'NATGEO_COOKIE is not configured — the harvester cannot sign in.',
    });
  }
  if (state?.lastError?.code === 'NATGEO_SESSION_EXPIRED') {
    problems.push({
      level: 'error', code: 'NATGEO_SESSION_EXPIRED',
      message: 'National Geographic session cookie expired — showing the last good issue. Refresh NATGEO_COOKIE.',
      since: state.lastError.at,
    });
  } else if (state?.lastStatus === 'error') {
    problems.push({
      level: 'warn', code: state.lastError?.code || 'HARVEST_ERROR',
      message: state.lastError?.message || 'The last harvest failed.',
      since: state.lastError?.at,
    });
  }
  if (!manifest || !manifest.slideCount) {
    problems.push({
      level: 'error', code: 'NO_ISSUE',
      message: 'No issue has been harvested yet. Run `npm run harvest`.',
    });
  } else {
    const ageHours = (now - Date.parse(manifest.harvestedAt || 0)) / 3600000;
    if (Number.isFinite(ageHours) && ageHours > (config.staleAfterHours || 36) * 2) {
      problems.push({
        level: 'warn', code: 'ISSUE_STALE',
        message: `Issue last harvested ${Math.round(ageHours)}h ago.`,
      });
    }
  }
  return { ok: problems.length === 0, problems };
}

// ── Daily schedule ───────────────────────────────────────────────────────────
// A single in-process timer, checked every 10 minutes. The harvester must run
// where the data volume is mounted, so it runs here rather than in CI.

export function nextRunAt(config, from = new Date()) {
  const hour = Number(config.harvestHourLocal ?? 4);
  const localHour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: config.timezone, hour: 'numeric', hour12: false,
    }).format(from),
  ) % 24;
  const hoursAhead = (hour - localHour + 24) % 24 || 24;
  return new Date(from.getTime() + hoursAhead * 3600000);
}

export function startScheduler(config, { store, runHarvest = harvest } = {}) {
  const issueStore = store || new IssueStore(config.dataDir);
  let running = false;
  let lastRunHour = null;

  const tick = async () => {
    if (running) return;
    const now = new Date();
    const localHour = Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: config.timezone, hour: 'numeric', hour12: false,
      }).format(now),
    ) % 24;
    const key = `${now.toISOString().slice(0, 10)}T${localHour}`;
    if (localHour !== Number(config.harvestHourLocal ?? 4) || lastRunHour === key) return;
    lastRunHour = key;
    running = true;
    try {
      log.info('SCHEDULED_HARVEST', `local hour ${localHour}`);
      await runHarvest(config, { store: issueStore });
    } catch (err) {
      log.error('SCHEDULED_HARVEST_FAILED', err.stack || err.message);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, 10 * 60 * 1000);
  timer.unref?.();

  if (config.harvestOnStartIfStale) {
    (async () => {
      const manifest = await issueStore.currentManifest();
      const ageHours = manifest
        ? (Date.now() - Date.parse(manifest.harvestedAt || 0)) / 3600000
        : Infinity;
      if (!(ageHours > (config.staleAfterHours || 36))) return;
      running = true;
      try {
        log.info('STARTUP_HARVEST', manifest ? `issue is ${Math.round(ageHours)}h old` : 'no issue on disk');
        await runHarvest(config, { store: issueStore });
      } catch (err) {
        log.error('STARTUP_HARVEST_FAILED', err.stack || err.message);
      } finally {
        running = false;
      }
    })();
  }

  return { tick, stop: () => clearInterval(timer) };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const store = await new IssueStore(config.dataDir).init();
  const app = createApp(config, { store });
  app.listen(config.port, () => {
    log.info('LISTENING', `http://localhost:${config.port}`, {
      version: config.version, dataDir: config.dataDir, configSource: config.configSource,
    });
  });
  startScheduler(config, { store });
}
