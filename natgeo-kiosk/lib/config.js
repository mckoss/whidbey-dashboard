// Runtime configuration, mirroring the whidbey-dashboard pattern:
//   config.json  (git-ignored, local dev)   OR
//   CONFIG_JSON  (a single env var holding the same object, for Railway)
// Secrets live in .env (git-ignored) or the real environment, never in config.

import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(join(here, '..'));

export const DEFAULTS = {
  port: 3000,
  dataDir: 'data',
  magazineUrl: 'https://www.nationalgeographic.com/magazine',
  origin: 'https://www.nationalgeographic.com',
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  harvestHourLocal: 4,
  timezone: 'America/Los_Angeles',
  harvestOnStartIfStale: true,
  staleAfterHours: 36,
  maxArticles: 24,
  maxImagesPerArticle: 12,
  minImageBytes: 40000,
  minImageWidth: 1200,
  targetImageWidth: 4096,
  requestDelayMs: 1500,
  condenseModel: 'claude-opus-5',
  condenseEffort: 'low',
  slideDurationMs: 12000,
  crossfadeMs: 2000,
  captionDelayMs: 3000,
  // Paths that are never magazine articles. Extraction also has structural
  // rules; this list only removes known-noise sections.
  articlePathDenyList: [
    '/subscribe', '/account', '/newsletters', '/podcasts', '/video',
    '/photography/photo-of-the-day', '/tag/', '/author/', '/shop',
  ],
  // Optional extraction overrides. Everything here is empty by default: the
  // extractor is structural, not selector-driven. These exist so a NatGeo
  // redesign can be handled by editing config instead of shipping code.
  // See `npm run verify` output for what to put here.
  overrides: {
    articleLinkPattern: null,   // regex source string, matched against pathname
    issueLabelPattern: null,    // regex source string with one capture group
    imageHostPattern: null,     // regex source string, matched against hostname
  },
};

// Minimal .env reader — avoids a dependency for a five-line job.
// Supports KEY=value, KEY="value", # comments, and blank lines.
export function parseEnvFile(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadDotEnv(root = ROOT) {
  const file = join(root, '.env');
  if (!existsSync(file)) return {};
  const parsed = parseEnvFile(readFileSync(file, 'utf8'));
  // The real environment wins over the file, so Railway variables override a
  // stray .env left in an image.
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return parsed;
}

function loadRootConfig(root) {
  if (process.env.CONFIG_JSON) {
    try {
      return { source: 'CONFIG_JSON', values: JSON.parse(process.env.CONFIG_JSON) };
    } catch (err) {
      throw new Error(`CONFIG_JSON is not valid JSON: ${err.message}`);
    }
  }
  const file = resolve(process.env.CONFIG_FILE || join(root, 'config.json'));
  if (existsSync(file)) {
    return { source: file, values: JSON.parse(readFileSync(file, 'utf8')) };
  }
  return { source: 'defaults', values: {} };
}

export function loadConfig({ root = ROOT, env = process.env } = {}) {
  loadDotEnv(root);
  const { source, values } = loadRootConfig(root);
  const config = { ...DEFAULTS, ...values };
  config.overrides = { ...DEFAULTS.overrides, ...(values.overrides || {}) };
  config.configSource = source;
  config.root = root;
  config.dataDir = resolve(root, config.dataDir);
  config.port = Number(env.PORT || config.port);

  // Secrets never come from config.json — only the environment.
  config.natgeoCookie = String(env.NATGEO_COOKIE || '').trim();
  config.anthropicApiKey = String(env.ANTHROPIC_API_KEY || '').trim();

  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  config.version = pkg.version;
  return config;
}

export function compileOverride(source) {
  if (!source) return null;
  try {
    return new RegExp(source, 'i');
  } catch {
    return null;
  }
}
