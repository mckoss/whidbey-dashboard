import express from 'express';
import fetch from 'node-fetch';
import { OAuth2Client } from 'google-auth-library';
import morgan from 'morgan';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = resolve(process.env.CONFIG_FILE || join(__dirname, 'config.json'));

// package.json is the single source of truth for the version string;
// the client reads it via /api/config and renders it in the header.
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));

const app = express();
const rootConfig = loadRootConfig();
const dataDir = resolve(configValue('dataDir', 'data'));
const CONFIG = {
  configFile: CONFIG_FILE,
  port: Number(configValue('port', 3000)),
  dataDir,
  cacheFile: join(dataDir, 'cache.json'),
  messageFile: join(dataDir, 'messages.json'),
  alertContextFile: join(dataDir, 'alert-context.json'),
  wsfApiKey: String(configValue('wsfApiKey', '')).trim(),
  gaMeasurementId: configValue('gaMeasurementId', null),
  googleClientId: String(configValue('googleClientId', '')).trim(),
  adminUsers: parseAuthorizedUsers(configValue('adminUsers', [])),
  adminTestTokens: parseJsonObject(configValue('adminTestTokens', {})),
  noaaStation: String(configValue('noaaStation', '9445526')),
  lat: Number(configValue('lat', 47.9748)),
  lon: Number(configValue('lon', -122.3534)),
  wsfDepartingTerminal: Number(configValue('wsfDepartingTerminal', 5)),
  wsfArrivingTerminal: Number(configValue('wsfArrivingTerminal', 14)),
  wsfRouteId: Number(configValue('wsfRouteId', 7)),
  timezone: String(configValue('timezone', 'America/Los_Angeles')),
};

// ── Request logging (stdout → Railway Log Explorer) ───────────────────
app.use(morgan('combined'));
app.use(express.json({ limit: '16kb' }));

// ── Cache: memory first, persisted for restart/deploy continuity ────────
const cache = loadPersistentCache();

function getCached(key) {
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) return null;
  return entry;
}

function setCache(key, data, ttlMs) {
  cache[key] = { data, cachedAt: Date.now(), expiresAt: Date.now() + ttlMs, stale: false };
  writePersistentCache();
}

function clearCache(key) {
  if (cache[key]) {
    delete cache[key];
    writePersistentCache();
  }
}

function getStale(key) {
  return cache[key] || null;
}

function loadPersistentCache() {
  try {
    if (!existsSync(CONFIG.cacheFile)) return {};
    const parsed = JSON.parse(readFileSync(CONFIG.cacheFile, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      console.log(`[cache] loaded ${Object.keys(parsed).length} persisted entries from ${CONFIG.cacheFile}`);
      return parsed;
    }
  } catch (e) {
    console.warn(`[cache] ignoring persisted cache: ${e.message}`);
  }
  return {};
}

function writePersistentCache() {
  try {
    mkdirSync(CONFIG.dataDir, { recursive: true });
    writeFileSync(CONFIG.cacheFile, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.warn(`[cache] could not persist cache: ${e.message}`);
  }
}

function loadRootConfig() {
  try {
    if (process.env.CONFIG_JSON) {
      const parsed = JSON.parse(process.env.CONFIG_JSON);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    }
    if (!existsSync(CONFIG_FILE)) return {};
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    const source = process.env.CONFIG_JSON ? 'CONFIG_JSON' : CONFIG_FILE;
    console.warn(`[config] ignoring ${source}: ${e.message}`);
    return {};
  }
}

function configValue(key, defaultValue = null) {
  const value = rootConfig[key];
  if (value !== undefined && value !== null && value !== '') return value;
  return defaultValue;
}

function parseJsonObject(value) {
  if (!value) return {};
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    console.warn(`[config] invalid JSON object: ${e.message}`);
    return {};
  }
}

function parseAuthorizedUsers(value) {
  if (!value) return [];
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed)
      ? parsed.map(user => String(user).trim().toLowerCase()).filter(Boolean)
      : [];
  } catch (e) {
    console.warn(`[config] invalid adminUsers JSON: ${e.message}`);
    return [];
  }
}

function googleClientId() {
  return CONFIG.googleClientId;
}

function adminUsers() {
  return new Set(CONFIG.adminUsers);
}

function parseAdminTestTokens() {
  if (process.env.NODE_ENV !== 'test') return {};
  return CONFIG.adminTestTokens;
}

const googleClients = new Map();

function googleClientFor(clientId) {
  if (!googleClients.has(clientId)) {
    googleClients.set(clientId, new OAuth2Client(clientId));
  }
  return googleClients.get(clientId);
}

function bearerToken(req) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

async function verifyAdminToken(token) {
  const testTokens = parseAdminTestTokens();
  if (testTokens[token]) {
    return { email: String(testTokens[token]).trim().toLowerCase(), emailVerified: true };
  }

  const clientId = googleClientId();
  if (!clientId) {
    throw Object.assign(new Error('Google Sign-In is not configured.'), { statusCode: 503 });
  }

  const ticket = await googleClientFor(clientId).verifyIdToken({
    idToken: token,
    audience: clientId,
  });
  const payload = ticket.getPayload();
  return {
    email: String(payload?.email || '').trim().toLowerCase(),
    emailVerified: payload?.email_verified === true,
  };
}

async function requireAdmin(req, res, next) {
  try {
    const token = bearerToken(req);
    if (!token) return res.status(401).json({ error: 'Google sign-in is required.' });

    const admin = await verifyAdminToken(token);
    const users = adminUsers();
    if (!admin.emailVerified || !admin.email || users.size === 0 || !users.has(admin.email)) {
      return res.status(403).json({ error: 'Not authorized to manage crawl messages.' });
    }

    req.admin = admin;
    next();
  } catch (e) {
    const statusCode = e.statusCode || 401;
    res.status(statusCode).json({ error: e.message || 'Google sign-in failed.' });
  }
}

function loadUserMessages() {
  try {
    if (!existsSync(CONFIG.messageFile)) return [];
    const parsed = JSON.parse(readFileSync(CONFIG.messageFile, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(m => m && typeof m === 'object' && typeof m.text === 'string')
      .map(m => ({
        id: String(m.id || ''),
        text: stripHtml(m.text).slice(0, 280),
        createdAt: m.createdAt || null,
        updatedAt: m.updatedAt || null,
      }))
      .filter(m => m.id && m.text);
  } catch (e) {
    console.warn(`[messages] ignoring persisted messages: ${e.message}`);
    return [];
  }
}

function writeUserMessages(messages) {
  mkdirSync(CONFIG.dataDir, { recursive: true });
  writeFileSync(CONFIG.messageFile, JSON.stringify(messages, null, 2));
}

const DEFAULT_FERRY_ALERT_CONTEXTS = [
  {
    id: 'low-tide-loading-restrictions',
    title: 'Low Tide loading restrictions',
    additionalInfo: 'oversized/low-clearance vehicles may be delayed Jun 13-18',
  },
  {
    id: 'pets-on-washington-state-ferries-effective-may-20',
    title: 'Pets on Washington State Ferries effective May 20',
    additionalInfo: 'new pet areas/rules take effect July 1',
  },
  {
    id: 'construction-activity-at-clinton-terminal-june-8-july-3',
    title: 'Construction activity at Clinton terminal June 8 - July 3',
    additionalInfo: 'soil testing; operations continue',
  },
];

function normalizeAlertContext(entry = {}) {
  const title = stripHtml(entry.title || '').slice(0, 160);
  const additionalInfo = stripHtml(entry.additionalInfo || '').slice(0, 220);
  const color = normalizeCssColor(entry.color || '');
  if (!title || !additionalInfo) return null;
  return {
    id: String(entry.id || randomUUID()),
    title,
    additionalInfo,
    color,
    createdAt: entry.createdAt || new Date().toISOString(),
    updatedAt: entry.updatedAt || entry.createdAt || new Date().toISOString(),
  };
}

function normalizeCssColor(value = '') {
  const color = stripHtml(value).slice(0, 80).trim();
  if (!color) return '';
  return /^[a-zA-Z0-9#(),.%\s/+_-]+$/.test(color) ? color : '';
}

function loadAlertContexts() {
  try {
    if (!existsSync(CONFIG.alertContextFile)) {
      return DEFAULT_FERRY_ALERT_CONTEXTS
        .map(entry => normalizeAlertContext(entry))
        .filter(Boolean);
    }
    const parsed = JSON.parse(readFileSync(CONFIG.alertContextFile, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('alert context file is not an array');
    return parsed.map(entry => normalizeAlertContext(entry)).filter(Boolean);
  } catch (e) {
    console.warn(`[alert-context] ignoring persisted alert contexts: ${e.message}`);
    return DEFAULT_FERRY_ALERT_CONTEXTS
      .map(entry => normalizeAlertContext(entry))
      .filter(Boolean);
  }
}

function writeAlertContexts(contexts) {
  mkdirSync(CONFIG.dataDir, { recursive: true });
  writeFileSync(CONFIG.alertContextFile, JSON.stringify(contexts, null, 2));
  clearCache('ferry_alerts');
}

function ferryAlertContext(title = '') {
  const normalizedTitle = String(title).trim();
  return loadAlertContexts().find(entry => entry.title === normalizedTitle) || {};
}

// ── Fetch with retry ────────────────────────────────────────────────────
async function fetchWithRetry(url, options = {}, retries = 1) {
  try {
    const res = await fetch(url, options);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } catch (err) {
    if (retries > 0) {
      console.warn(`[retry] ${url} — ${err.message}`);
      await new Promise(r => setTimeout(r, 1000));
      return fetchWithRetry(url, options, retries - 1);
    }
    throw err;
  }
}

// ── Cache-aware handler factory ────────────────────────────────────────
function cachedEndpoint(cacheKey, ttlMs, fetcher) {
  return async (req, res) => {
    const hit = getCached(cacheKey);
    if (hit) {
      return res.json(hit.data);
    }
    try {
      const data = await fetcher(req);
      setCache(cacheKey, data, ttlMs);
      res.json(data);
    } catch (e) {
      const stale = getStale(cacheKey);
      if (stale) {
        console.warn(`[stale] serving stale ${cacheKey}: ${e.message}`);
        const ageMin = Math.round((Date.now() - stale.cachedAt) / 60000);
        return res.json({ ...stale.data, _stale: true, _staleAgeMinutes: ageMin });
      }
      res.status(500).json({ error: e.message });
    }
  };
}

app.use(express.static(join(__dirname, 'public')));

app.get('/admin', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'admin.html'));
});

app.get('/api/messages', (req, res) => {
  res.json({ messages: loadUserMessages() });
});

app.post('/api/messages', requireAdmin, (req, res) => {
  const text = stripHtml(req.body?.text || '').slice(0, 280);
  if (!text) return res.status(400).json({ error: 'Message text is required.' });

  const messages = loadUserMessages();
  const now = new Date().toISOString();
  const message = {
    id: randomUUID(),
    text,
    createdAt: now,
    updatedAt: now,
  };
  messages.push(message);
  writeUserMessages(messages);
  res.status(201).json({ message });
});

app.delete('/api/messages/:id', requireAdmin, (req, res) => {
  const messages = loadUserMessages();
  const next = messages.filter(m => m.id !== req.params.id);
  if (next.length === messages.length) {
    return res.status(404).json({ error: 'Message not found.' });
  }
  writeUserMessages(next);
  res.json({ ok: true, messages: next });
});

app.get('/api/alert-contexts', (req, res) => {
  res.json({ contexts: loadAlertContexts() });
});

app.post('/api/alert-contexts', requireAdmin, (req, res) => {
  const now = new Date().toISOString();
  const context = normalizeAlertContext({
    id: randomUUID(),
    title: req.body?.title,
    additionalInfo: req.body?.additionalInfo,
    color: req.body?.color,
    createdAt: now,
    updatedAt: now,
  });
  if (!context) return res.status(400).json({ error: 'Alert title and parenthetical text are required.' });

  const contexts = loadAlertContexts();
  if (contexts.some(entry => entry.title === context.title)) {
    return res.status(409).json({ error: 'Alert context already exists for that title.' });
  }
  contexts.push(context);
  writeAlertContexts(contexts);
  res.status(201).json({ context, contexts });
});

app.put('/api/alert-contexts/:id', requireAdmin, (req, res) => {
  const contexts = loadAlertContexts();
  const index = contexts.findIndex(entry => entry.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Alert context not found.' });

  const now = new Date().toISOString();
  const next = normalizeAlertContext({
    ...contexts[index],
    title: req.body?.title,
    additionalInfo: req.body?.additionalInfo,
    color: req.body?.color,
    updatedAt: now,
  });
  if (!next) return res.status(400).json({ error: 'Alert title and parenthetical text are required.' });
  if (contexts.some((entry, i) => i !== index && entry.title === next.title)) {
    return res.status(409).json({ error: 'Alert context already exists for that title.' });
  }

  contexts[index] = next;
  writeAlertContexts(contexts);
  res.json({ context: next, contexts });
});

app.delete('/api/alert-contexts/:id', requireAdmin, (req, res) => {
  const contexts = loadAlertContexts();
  const next = contexts.filter(entry => entry.id !== req.params.id);
  if (next.length === contexts.length) {
    return res.status(404).json({ error: 'Alert context not found.' });
  }
  writeAlertContexts(next);
  res.json({ ok: true, contexts: next });
});

// ── Tides (hi/lo, 3 days) ─────────────────────────────────────────────
app.get('/api/tides', cachedEndpoint('tides', 2 * 60 * 60 * 1000, async () => {
  const today = new Date();
  // Include yesterday so early-morning displays have a previous tide event for
  // current-height/thermometer interpolation before today's first high/low.
  const begin = formatDate(new Date(today.getTime() - 86400000));
  const end = formatDate(new Date(today.getTime() + 3 * 86400000));
  const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` +
    `?begin_date=${begin}&end_date=${end}` +
    `&station=${CONFIG.noaaStation}` +
    `&product=predictions&datum=MLLW&time_zone=lst_ldt` +
    `&interval=hilo&units=english&application=whidbey_dashboard&format=json`;
  const r = await fetchWithRetry(url);
  const data = await r.json();
  if (data.error) throw new Error(data.error.message || 'NOAA returned error');
  // Stamp each prediction with explicit Pacific offset so clients parse unambiguously
  const offset = pacificOffset();
  const predictions = data.predictions.map(p => ({ ...p, t: p.t.replace(' ', 'T') + ':00' + offset }));
  return { ...data, predictions };
}));

// ── Tides (hourly interpolated, 48h) — for sparkline graph ──────────────
// Station 9445526 is a subordinate station (hi/lo only).
// We generate smooth hourly points via cosine interpolation between hi/lo events.
app.get('/api/tides/hourly', cachedEndpoint('tides_hourly', 2 * 60 * 60 * 1000, async () => {
  const today = new Date();
  // Include yesterday so the hourly interpolation has a real event before the
  // first tide of the current day instead of flattening to that first event.
  const begin = formatDate(new Date(today.getTime() - 86400000));
  const end = formatDate(new Date(today.getTime() + 3 * 86400000));
  const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` +
    `?begin_date=${begin}&end_date=${end}` +
    `&station=${CONFIG.noaaStation}` +
    `&product=predictions&datum=MLLW&time_zone=lst_ldt` +
    `&interval=hilo&units=english&application=whidbey_dashboard&format=json`;
  const r = await fetchWithRetry(url);
  const data = await r.json();
  if (data.error) throw new Error(data.error.message || 'NOAA returned error');
  if (!data.predictions) throw new Error('NOAA returned no predictions');

  // NOAA returns lst_ldt Pacific times like "2026-04-24 14:00". Treat as fake-UTC
  // (append Z) so all arithmetic is consistent regardless of server timezone.
  const events = data.predictions.map(p => ({
    t: new Date(p.t.replace(' ', 'T') + 'Z').getTime(),
    v: parseFloat(p.v),
  }));

  // Get current Pacific hour as a fake-UTC epoch so loop ms values stay in Pacific space.
  const offset = pacificOffset();
  const predictions = [];
  const nowPac = new Date().toLocaleString('sv-SE', { timeZone: CONFIG.timezone });
  const startMs = new Date(nowPac.slice(0, 13) + ':00:00Z').getTime();
  const endMs = startMs + 72 * 3600 * 1000; // 48h display + 24h headroom

  for (let ms = startMs; ms <= endMs; ms += 3600 * 1000) {
    // Find surrounding events
    let before = null, after = null;
    for (let i = 0; i < events.length; i++) {
      if (events[i].t <= ms) before = events[i];
      if (events[i].t > ms && !after) after = events[i];
    }
    let v;
    if (before && after) {
      const t = (ms - before.t) / (after.t - before.t);
      v = before.v + (after.v - before.v) * (1 - Math.cos(Math.PI * t)) / 2;
    } else if (before) {
      v = before.v;
    } else if (after) {
      v = after.v;
    } else {
      continue;
    }
    const dt = new Date(ms);
    // ms is fake-UTC (Pacific wall-clock value treated as UTC), so getUTC* returns Pacific values
    // Append explicit offset so clients parse the timestamp unambiguously regardless of their timezone
    const tStr = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,'0')}-${String(dt.getUTCDate()).padStart(2,'0')}` +
      `T${String(dt.getUTCHours()).padStart(2,'0')}:${String(dt.getUTCMinutes()).padStart(2,'0')}:00${offset}`;
    predictions.push({ t: tStr, v: v.toFixed(3) });
  }

  return { predictions, interpolated: true };
}));

// ── Weather (Open-Meteo) ───────────────────────────────────────────────
app.get('/api/weather', cachedEndpoint('weather', 60 * 60 * 1000, async () => {
  const url = `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${CONFIG.lat}&longitude=${CONFIG.lon}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,wind_direction_10m_dominant,sunrise,sunset` +
    `&hourly=temperature_2m,weather_code,wind_speed_10m` +
    `&current=temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,relative_humidity_2m` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch` +
    `&timezone=${encodeURIComponent(CONFIG.timezone)}&forecast_days=3`;
  const r = await fetchWithRetry(url);
  const data = await r.json();
  // Stamp sunrise/sunset with explicit Pacific offset so clients parse unambiguously
  const offset = pacificOffset();
  if (data.daily?.sunrise) {
    data.daily.sunrise = data.daily.sunrise.map(s => s + ':00' + offset);
    data.daily.sunset  = data.daily.sunset.map(s  => s + ':00' + offset);
  }
  return data;
}));

// ── Ferry schedule helper (reusable for either direction) ────────────

function stripHtml(value = '') {
  return String(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripFerryAlertRoutePrefix(value = '') {
  return String(value)
    .replace(/^(?:all routes|(?:[a-z]+\/[a-z]+)(?:\s+[a-z]+\/[a-z]+)*)\s*[-–—:]+\s*/i, '')
    .trim();
}

app.get('/api/ferry/alerts', cachedEndpoint('ferry_alerts', 30 * 1000, async () => {
  if (!CONFIG.wsfApiKey) return { error: 'WSF API key not configured', alerts: [] };
  const url = `https://www.wsdot.wa.gov/ferries/api/schedule/rest/alerts?apiaccesscode=${CONFIG.wsfApiKey}`;
  const r = await fetchWithRetry(url, { headers: { Accept: 'application/json' } });
  const data = await r.json();
  const alerts = (Array.isArray(data) ? data : [])
    .filter(alertAppliesToRoute)
    .sort((a, b) => (a.SortSeq ?? 9999) - (b.SortSeq ?? 9999))
    .map(a => {
      const title = stripFerryAlertRoutePrefix(stripHtml(a.AlertFullTitle || a.RouteAlertText || a.AlertDescription || ''));
      const context = ferryAlertContext(title);
      return {
        id: a.BulletinID,
        title,
        text: stripFerryAlertRoutePrefix(stripHtml(a.RouteAlertText || a.DisruptionDescription || a.BulletinText || a.AlertFullText || '')),
        additionalInfo: context.additionalInfo || '',
        color: context.color || '',
        publishedAt: a.PublishDate || null,
        affectedRouteIds: Array.isArray(a.AffectedRouteIDs) ? a.AffectedRouteIDs : [],
        allRoutes: Boolean(a.AllRoutesFlag),
      };
    });
  return { alerts };
}));

function alertAppliesToRoute(alert = {}) {
  if (alert.AllRoutesFlag) return true;
  const routeIds = Array.isArray(alert.AffectedRouteIDs) ? alert.AffectedRouteIDs : [];
  return routeIds.includes(CONFIG.wsfRouteId);
}
//
// Midnight carry-over fix (issue #18):
// After midnight, scheduletoday flips to the new day and drops late-night
// sailings (e.g. the 12:35 AM boat) that are still in the future.
// We retain those sailings from the previous response until they depart.
//
// Per-direction store: cacheKey → array of sailing Time objects from last fetch
const previousSailingsStore = new Map();
const MIDNIGHT_CARRY_OVER_WINDOW_MS = 90 * 60 * 1000;

// Extract the departure epoch ms from a WSF Times entry
function parseDepartureMs(timeEntry) {
  const m = timeEntry?.DepartingTime?.match(/\/Date\((\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function timeZoneOffsetMs(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const byType = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const localAsUtc = Date.UTC(
    Number(byType.year),
    Number(byType.month) - 1,
    Number(byType.day),
    Number(byType.hour),
    Number(byType.minute),
    Number(byType.second)
  );
  return localAsUtc - ms;
}

function startOfLocalDayMs(ms, timeZone = CONFIG.timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const byType = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const localDayAsUtc = Date.UTC(Number(byType.year), Number(byType.month) - 1, Number(byType.day));
  return localDayAsUtc - timeZoneOffsetMs(localDayAsUtc, timeZone);
}

function shouldCarryOverSailing(departureMs, nowMs = Date.now()) {
  if (departureMs == null || departureMs <= nowMs) return false;
  const todayStartMs = startOfLocalDayMs(nowMs, CONFIG.timezone);
  const tomorrowStartMs = todayStartMs + 24 * 60 * 60 * 1000;
  const nowIsNearMidnight = nowMs - todayStartMs <= MIDNIGHT_CARRY_OVER_WINDOW_MS;
  const departureIsNearMidnight = departureMs >= todayStartMs &&
    departureMs - todayStartMs <= MIDNIGHT_CARRY_OVER_WINDOW_MS;
  return nowIsNearMidnight && departureIsNearMidnight && departureMs < tomorrowStartMs;
}

function ferryScheduleEndpoint(cacheKey, fromTerminal, toTerminal) {
  return cachedEndpoint(cacheKey, 30 * 1000, async () => {
    if (!CONFIG.wsfApiKey) return { error: 'WSF API key not configured', sailings: [] };
    const url = `https://www.wsdot.wa.gov/ferries/api/schedule/rest/scheduletoday` +
      `/${fromTerminal}/${toTerminal}/false?apiaccesscode=${CONFIG.wsfApiKey}`;
    const r = await fetchWithRetry(url, { headers: { Accept: 'application/json' } });
    const data = await r.json();

    // Merge carry-over sailings into the new response
    const combo = data?.TerminalCombos?.[0];
    if (combo && Array.isArray(combo.Times)) {
      const now = Date.now();
      const newSailings = combo.Times;

      // Build a set of departure timestamps from the fresh response for dedup
      const newMs = new Set(
        newSailings.map(parseDepartureMs).filter(ms => ms !== null)
      );

      // Keep previous sailings that are still in the future but absent from the new response
      const previous = previousSailingsStore.get(cacheKey) || cachedSailingsFor(cacheKey);
      const carryOver = previous.filter(s => {
        const ms = parseDepartureMs(s);
        return shouldCarryOverSailing(ms, now) && !newMs.has(ms);
      });

      if (carryOver.length > 0) {
        console.log(`[ferry:${cacheKey}] carrying over ${carryOver.length} late-night sailing(s) past midnight`);
      }

      // Merge and sort by departure time
      const merged = [...carryOver, ...newSailings].sort(
        (a, b) => (parseDepartureMs(a) || 0) - (parseDepartureMs(b) || 0)
      );

      // Save merged set for the next fetch cycle
      previousSailingsStore.set(cacheKey, merged);

      // Return response with merged Times, preserving original shape
      return {
        ...data,
        TerminalCombos: [
          { ...combo, Times: merged },
          ...data.TerminalCombos.slice(1),
        ],
      };
    }

    return data;
  });
}

function cachedSailingsFor(cacheKey) {
  return cache[cacheKey]?.data?.TerminalCombos?.[0]?.Times || [];
}

// ── Ferry space helper (reusable for either terminal) ─────────────────
function ferrySpaceEndpoint(cacheKey, fromTerminal, toTerminal) {
  return cachedEndpoint(cacheKey, 30 * 1000, async () => {
    if (!CONFIG.wsfApiKey) return { error: 'WSF API key not configured' };
    const url = `https://www.wsdot.wa.gov/ferries/api/terminals/rest/terminalsailingspace` +
      `/${fromTerminal}?apiaccesscode=${CONFIG.wsfApiKey}`;
    const r = await fetchWithRetry(url, { headers: { Accept: 'application/json' } });
    const data = await r.json();
    const byDeparture = {};
    for (const dep of (data.DepartingSpaces || [])) {
      const ms = dep.Departure?.match(/\/Date\((\d+)/)?.[1];
      if (!ms) continue;
      const space = dep.SpaceForArrivalTerminals?.find(t => t.TerminalID === toTerminal);
      byDeparture[ms] = {
        vesselName: dep.VesselName,
        driveUpSpaces: space?.DriveUpSpaceCount ?? null,
        maxSpaces: dep.MaxSpaceCount,
        hexColor: space?.DriveUpSpaceHexColor ?? null,
      };
    }
    return byDeparture;
  });
}

// Clinton → Mukilteo
app.get('/api/ferry/clinton', ferryScheduleEndpoint('ferry_clinton', CONFIG.wsfDepartingTerminal, CONFIG.wsfArrivingTerminal));
app.get('/api/ferry/clinton/space', ferrySpaceEndpoint('ferry_clinton_space', CONFIG.wsfDepartingTerminal, CONFIG.wsfArrivingTerminal));

// Mukilteo → Clinton
app.get('/api/ferry/mukilteo', ferryScheduleEndpoint('ferry_mukilteo', CONFIG.wsfArrivingTerminal, CONFIG.wsfDepartingTerminal));
app.get('/api/ferry/mukilteo/space', ferrySpaceEndpoint('ferry_mukilteo_space', CONFIG.wsfArrivingTerminal, CONFIG.wsfDepartingTerminal));

// Legacy alias (keep working during transition)
app.get('/api/ferry', ferryScheduleEndpoint('ferry_clinton', CONFIG.wsfDepartingTerminal, CONFIG.wsfArrivingTerminal));
app.get('/api/ferry/space', ferrySpaceEndpoint('ferry_clinton_space', CONFIG.wsfDepartingTerminal, CONFIG.wsfArrivingTerminal));

// ── Vessel locations (Clinton–Mukilteo route) ─────────────────────────
// Used by the client to detect late departures and update the displayed time.
function parseWsfMs(d) {
  if (!d) return null;
  if (typeof d === 'string') {
    const m = d.match(/\/Date\((\d+)/);
    if (m) return parseInt(m[1], 10);
    const t = new Date(d).getTime();
    return isNaN(t) ? null : t;
  }
  return null;
}

app.get('/api/ferry/vessels', cachedEndpoint('ferry_vessels', 30 * 1000, async () => {
  if (!CONFIG.wsfApiKey) return { error: 'WSF API key not configured', vessels: [] };
  const url = `https://www.wsdot.wa.gov/ferries/api/vessels/rest/vessellocations?apiaccesscode=${CONFIG.wsfApiKey}`;
  const r = await fetchWithRetry(url, { headers: { Accept: 'application/json' } });
  const data = await r.json();
  const routeTerminals = new Set([CONFIG.wsfDepartingTerminal, CONFIG.wsfArrivingTerminal]);
  const vessels = (Array.isArray(data) ? data : [])
    .filter(v => routeTerminals.has(v.DepartingTerminalID) || routeTerminals.has(v.ArrivingTerminalID))
    .map(v => ({
      vesselId: v.VesselID,
      vesselName: v.VesselName,
      atDock: v.AtDock,
      inService: v.InService,
      departingTerminalId: v.DepartingTerminalID,
      arrivingTerminalId: v.ArrivingTerminalID,
      scheduledDepartureMs: parseWsfMs(v.ScheduledDeparture),
      leftDockMs: parseWsfMs(v.LeftDock),
      etaMs: parseWsfMs(v.Eta),
      etaBasis: v.EtaBasis,
      speed: v.Speed,
    }));
  return { vessels };
}));

// ── Client config (feature flags, analytics ID) ──────────────────────
app.get('/api/config', (req, res) => {
  res.json({
    gaMeasurementId: CONFIG.gaMeasurementId,
    googleClientId: googleClientId() || null,
    version: pkg.version,
  });
});

// ── Cache status (debug) ───────────────────────────────────────────────
app.get('/api/cache-status', (req, res) => {
  const status = {};
  for (const [key, entry] of Object.entries(cache)) {
    status[key] = {
      cachedAt: new Date(entry.cachedAt).toISOString(),
      expiresAt: new Date(entry.expiresAt).toISOString(),
      expired: Date.now() > entry.expiresAt,
    };
  }
  res.json(status);
});

// Returns the current Pacific UTC offset string: "-07:00" (PDT) or "-08:00" (PST)
function pacificOffset() {
  const now = new Date();
  const pacStr = now.toLocaleString('sv-SE', { timeZone: CONFIG.timezone });
  const pacEpoch = new Date(pacStr.replace(' ', 'T') + 'Z').getTime();
  const diffH = Math.round((pacEpoch - now.getTime()) / 3600000);
  return diffH >= 0 ? `+${String(diffH).padStart(2,'0')}:00` : `-${String(-diffH).padStart(2,'0')}:00`;
}

function formatDate(d) {
  // Always use the Pacific calendar date regardless of server timezone
  const s = d.toLocaleString('sv-SE', { timeZone: CONFIG.timezone });
  return s.slice(0, 10).replace(/-/g, ''); // "YYYYMMDD"
}

// Hosting providers such as Railway inject the socket port at runtime.
// App settings still live in config.json; PORT is deployment plumbing.
const listenPort = Number(process.env.PORT || CONFIG.port);
app.listen(listenPort, () => {
  console.log(`Whidbey Dashboard running at http://localhost:${listenPort}`);
});
