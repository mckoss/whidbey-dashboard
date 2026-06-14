import express from 'express';
import fetch from 'node-fetch';
import { OAuth2Client } from 'google-auth-library';
import morgan from 'morgan';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
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
const configuredSessionSecret = String(configValue('sessionSecret', '')).trim();
const CONFIG = {
  configFile: CONFIG_FILE,
  port: Number(configValue('port', 3000)),
  dataDir,
  cacheFile: join(dataDir, 'cache.json'),
  messageFile: join(dataDir, 'messages.json'),
  alertContextFile: join(dataDir, 'alert-context.json'),
  ferryHistoryDir: join(dataDir, 'ferry-history'),
  wsfApiKey: String(configValue('wsfApiKey', '')).trim(),
  gaMeasurementId: configValue('gaMeasurementId', null),
  googleClientId: String(configValue('googleClientId', '')).trim(),
  adminUsers: parseAuthorizedUsers(configValue('adminUsers', [])),
  adminTestTokens: parseJsonObject(configValue('adminTestTokens', {})),
  sessionSecret: configuredSessionSecret || randomUUID(),
  sessionSecretConfigured: Boolean(configuredSessionSecret),
  noaaStation: String(configValue('noaaStation', '9445526')),
  lat: Number(configValue('lat', 47.9748)),
  lon: Number(configValue('lon', -122.3534)),
  wsfDepartingTerminal: Number(configValue('wsfDepartingTerminal', 5)),
  wsfArrivingTerminal: Number(configValue('wsfArrivingTerminal', 14)),
  wsfRouteId: Number(configValue('wsfRouteId', 7)),
  timezone: String(configValue('timezone', 'America/Los_Angeles')),
  ferryHistoryRetentionDays: Number(configValue('ferryHistoryRetentionDays', 30)),
  ferryHistorySampleMs: Number(configValue('ferryHistorySampleMs', 60 * 1000)),
  ferryHistoryDayStartHour: Number(configValue('ferryHistoryDayStartHour', 2)),
};

const ADMIN_SESSION_COOKIE = 'whidbey_admin_session';
const ADMIN_SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

if (!CONFIG.sessionSecretConfigured && process.env.NODE_ENV !== 'test') {
  console.warn('[auth] sessionSecret is not configured; admin sessions will not survive server restarts or deploys.');
}

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

function parseCookies(req) {
  const header = req.get('cookie') || '';
  return Object.fromEntries(header
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const index = part.indexOf('=');
      if (index === -1) return [part, ''];
      const key = part.slice(0, index);
      const value = part.slice(index + 1);
      try {
        return [key, decodeURIComponent(value)];
      } catch {
        return [key, value];
      }
    }));
}

function signSessionPayload(payload) {
  return createHmac('sha256', CONFIG.sessionSecret)
    .update(payload)
    .digest('base64url');
}

function createAdminSession(admin) {
  const expiresAt = Date.now() + ADMIN_SESSION_DURATION_MS;
  const payload = Buffer.from(JSON.stringify({
    email: admin.email,
    exp: expiresAt,
  })).toString('base64url');
  return {
    cookieValue: `${payload}.${signSessionPayload(payload)}`,
    expiresAt,
  };
}

function verifyAdminSessionCookie(req) {
  const value = parseCookies(req)[ADMIN_SESSION_COOKIE] || '';
  const [payload, signature] = value.split('.');
  if (!payload || !signature) return null;

  const expected = signSessionPayload(payload);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const email = String(session.email || '').trim().toLowerCase();
    if (!email || !session.exp || Date.now() > Number(session.exp)) return null;
    const users = adminUsers();
    if (users.size === 0 || !users.has(email)) return null;
    return { email, emailVerified: true, expiresAt: Number(session.exp) };
  } catch {
    return null;
  }
}

function adminCookieOptions(req) {
  return {
    httpOnly: true,
    secure: req.secure || req.get('x-forwarded-proto') === 'https',
    sameSite: 'lax',
    maxAge: ADMIN_SESSION_DURATION_MS,
    path: '/',
  };
}

function setAdminSessionCookie(req, res, admin) {
  const session = createAdminSession(admin);
  res.cookie(ADMIN_SESSION_COOKIE, session.cookieValue, adminCookieOptions(req));
  return session;
}

function clearAdminSessionCookie(req, res) {
  res.clearCookie(ADMIN_SESSION_COOKIE, {
    httpOnly: true,
    secure: req.secure || req.get('x-forwarded-proto') === 'https',
    sameSite: 'lax',
    path: '/',
  });
}

function assertAuthorizedAdmin(admin) {
  const users = adminUsers();
  return admin?.emailVerified && admin.email && users.size > 0 && users.has(admin.email);
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
    const sessionAdmin = verifyAdminSessionCookie(req);
    if (sessionAdmin) {
      req.admin = sessionAdmin;
      return next();
    }

    const token = bearerToken(req);
    if (!token) return res.status(401).json({ error: 'Google sign-in is required.' });

    const admin = await verifyAdminToken(token);
    if (!assertAuthorizedAdmin(admin)) {
      return res.status(403).json({ error: 'Not authorized to manage crawl messages.' });
    }

    req.admin = admin;
    setAdminSessionCookie(req, res, admin);
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
        startDate: sanitizeMessageDate(m.startDate),
        endDate: sanitizeMessageDate(m.endDate),
        color: normalizeCssColor(m.color || ''),
        createdAt: m.createdAt || null,
        updatedAt: m.updatedAt || null,
      }))
      .filter(m => m.id && m.text);
  } catch (e) {
    console.warn(`[messages] ignoring persisted messages: ${e.message}`);
    return [];
  }
}

function sanitizeMessageDate(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() + 1 !== Number(month) ||
    date.getUTCDate() !== Number(day)
  ) {
    return null;
  }
  return text;
}

function messageScheduleFromBody(body = {}) {
  const startDate = sanitizeMessageDate(body.startDate);
  const endDate = sanitizeMessageDate(body.endDate);
  const color = normalizeCssColor(body.color || '');
  if (body.startDate && !startDate) {
    const error = new Error('Start date must use YYYY-MM-DD.');
    error.statusCode = 400;
    throw error;
  }
  if (body.endDate && !endDate) {
    const error = new Error('End date must use YYYY-MM-DD.');
    error.statusCode = 400;
    throw error;
  }
  if (startDate && endDate && startDate > endDate) {
    const error = new Error('Start date must be on or before end date.');
    error.statusCode = 400;
    throw error;
  }
  return { startDate, endDate, color };
}

function formatCalendarDate(d) {
  const s = d.toLocaleString('sv-SE', { timeZone: CONFIG.timezone });
  return s.slice(0, 10);
}

function isUserMessageActive(message, today = formatCalendarDate(new Date())) {
  if (message.startDate && today < message.startDate) return false;
  if (message.endDate && today > message.endDate) return false;
  return true;
}

function writeUserMessages(messages) {
  mkdirSync(CONFIG.dataDir, { recursive: true });
  writeFileSync(CONFIG.messageFile, JSON.stringify(messages, null, 2));
}

const DEFAULT_FERRY_ALERT_CONTEXTS = [
  {
    id: 'low-tide-loading-restrictions',
    query: 'Low Tide loading restrictions',
    additionalInfo: 'oversized/low-clearance vehicles may be delayed Jun 13-18',
  },
  {
    id: 'pets-on-washington-state-ferries-effective-may-20',
    query: 'Pets on Washington State Ferries effective May 20',
    additionalInfo: 'new pet areas/rules take effect July 1',
  },
  {
    id: 'construction-activity-at-clinton-terminal-june-8-july-3',
    query: 'Construction activity at Clinton terminal June 8 - July 3',
    additionalInfo: 'soil testing; operations continue',
  },
];

function normalizeAlertContext(entry = {}) {
  const query = stripHtml(entry.query ?? entry.title ?? '').slice(0, 160);
  const additionalInfo = stripHtml(entry.additionalInfo || '').slice(0, 220);
  const color = normalizeCssColor(entry.color || '');
  if (!query || !additionalInfo) return null;
  return {
    id: String(entry.id || randomUUID()),
    query,
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

function ferryAlertContext(...messageParts) {
  const message = messageParts
    .map(part => String(part || '').trim())
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (!message) return {};
  return loadAlertContexts().find(entry => message.includes(entry.query.toLowerCase())) || {};
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

const backgroundRefreshes = new Map();

function refreshCacheInBackground(cacheKey, ttlMs, fetcher, req) {
  if (backgroundRefreshes.has(cacheKey)) return;
  const refresh = (async () => {
    try {
      const data = await fetcher(req);
      setCache(cacheKey, data, ttlMs);
    } catch (e) {
      console.warn(`[stale] background refresh failed for ${cacheKey}: ${e.message}`);
    } finally {
      backgroundRefreshes.delete(cacheKey);
    }
  })();
  backgroundRefreshes.set(cacheKey, refresh);
}

function cachedEndpointStaleWhileRefresh(cacheKey, ttlMs, fetcher) {
  return async (req, res) => {
    const hit = getCached(cacheKey);
    if (hit) {
      return res.json(hit.data);
    }

    const stale = getStale(cacheKey);
    if (stale) {
      refreshCacheInBackground(cacheKey, ttlMs, fetcher, req);
      const ageMin = Math.round((Date.now() - stale.cachedAt) / 60000);
      return res.json({ ...stale.data, _stale: true, _staleAgeMinutes: ageMin, _refreshing: true });
    }

    try {
      const data = await fetcher(req);
      setCache(cacheKey, data, ttlMs);
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  };
}

app.use(express.static(join(__dirname, 'public')));

app.get('/admin', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'admin.html'));
});

app.get('/api/admin/session', (req, res) => {
  const admin = verifyAdminSessionCookie(req);
  if (!admin) return res.status(401).json({ signedIn: false });
  res.json({
    signedIn: true,
    admin: { email: admin.email },
    expiresAt: new Date(admin.expiresAt).toISOString(),
  });
});

app.post('/api/admin/session', async (req, res) => {
  try {
    const token = bearerToken(req);
    if (!token) return res.status(401).json({ error: 'Google sign-in is required.' });

    const admin = await verifyAdminToken(token);
    if (!assertAuthorizedAdmin(admin)) {
      return res.status(403).json({ error: 'Not authorized to manage crawl messages.' });
    }

    const session = setAdminSessionCookie(req, res, admin);
    res.status(201).json({
      signedIn: true,
      admin: { email: admin.email },
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
  } catch (e) {
    const statusCode = e.statusCode || 401;
    res.status(statusCode).json({ error: e.message || 'Google sign-in failed.' });
  }
});

app.delete('/api/admin/session', (req, res) => {
  clearAdminSessionCookie(req, res);
  res.json({ ok: true });
});

app.get('/api/messages', (req, res) => {
  const respond = () => {
    const messages = loadUserMessages();
    res.json({
      messages: req.query.includeInactive ? messages : messages.filter(message => isUserMessageActive(message)),
    });
  };
  if (req.query.includeInactive) return requireAdmin(req, res, respond);
  respond();
});

app.post('/api/messages', requireAdmin, (req, res) => {
  const text = stripHtml(req.body?.text || '').slice(0, 280);
  if (!text) return res.status(400).json({ error: 'Message text is required.' });
  let schedule;
  try {
    schedule = messageScheduleFromBody(req.body);
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.message });
  }

  const messages = loadUserMessages();
  const now = new Date().toISOString();
  const message = {
    id: randomUUID(),
    text,
    ...schedule,
    createdAt: now,
    updatedAt: now,
  };
  messages.push(message);
  writeUserMessages(messages);
  res.status(201).json({ message });
});

app.put('/api/messages/:id', requireAdmin, (req, res) => {
  const text = stripHtml(req.body?.text || '').slice(0, 280);
  if (!text) return res.status(400).json({ error: 'Message text is required.' });
  let schedule;
  try {
    schedule = messageScheduleFromBody(req.body);
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.message });
  }

  const messages = loadUserMessages();
  const index = messages.findIndex(m => m.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Message not found.' });

  const next = {
    ...messages[index],
    text,
    ...schedule,
    updatedAt: new Date().toISOString(),
  };
  messages[index] = next;
  writeUserMessages(messages);
  res.json({ message: next, messages });
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
    query: req.body?.query ?? req.body?.title,
    additionalInfo: req.body?.additionalInfo,
    color: req.body?.color,
    createdAt: now,
    updatedAt: now,
  });
  if (!context) return res.status(400).json({ error: 'Alert query and parenthetical text are required.' });

  const contexts = loadAlertContexts();
  if (contexts.some(entry => entry.query.toLowerCase() === context.query.toLowerCase())) {
    return res.status(409).json({ error: 'Alert context already exists for that query.' });
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
    query: req.body?.query ?? req.body?.title,
    additionalInfo: req.body?.additionalInfo,
    color: req.body?.color,
    updatedAt: now,
  });
  if (!next) return res.status(400).json({ error: 'Alert query and parenthetical text are required.' });
  if (contexts.some((entry, i) => i !== index && entry.query.toLowerCase() === next.query.toLowerCase())) {
    return res.status(409).json({ error: 'Alert context already exists for that query.' });
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

async function fetchWsfFerryScheduleData(fromTerminal, toTerminal) {
  if (!CONFIG.wsfApiKey) return { error: 'WSF API key not configured', sailings: [] };
  const url = `https://www.wsdot.wa.gov/ferries/api/schedule/rest/scheduletoday` +
    `/${fromTerminal}/${toTerminal}/false?apiaccesscode=${CONFIG.wsfApiKey}`;
  const r = await fetchWithRetry(url, { headers: { Accept: 'application/json' } });
  return r.json();
}

async function fetchWsfFerrySpaceData(fromTerminal, toTerminal) {
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
}

async function fetchFerryVesselsData() {
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
      latitude: typeof v.Latitude === 'number' ? v.Latitude : null,
      longitude: typeof v.Longitude === 'number' ? v.Longitude : null,
    }));
  return { vessels };
}

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
      const text = stripFerryAlertRoutePrefix(stripHtml(a.RouteAlertText || a.DisruptionDescription || a.BulletinText || a.AlertFullText || ''));
      const context = ferryAlertContext(title, text);
      return {
        id: a.BulletinID,
        title,
        text,
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
  return cachedEndpointStaleWhileRefresh(cacheKey, 30 * 1000, async () => {
    const data = await fetchWsfFerryScheduleData(fromTerminal, toTerminal);

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
    return fetchWsfFerrySpaceData(fromTerminal, toTerminal);
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

app.get('/api/ferry/vessels', cachedEndpoint('ferry_vessels', 30 * 1000, fetchFerryVesselsData));

// ── Ferry history persistence ─────────────────────────────────────────
const FERRY_HISTORY_RETENTION_DAYS = CONFIG.ferryHistoryRetentionDays;
const FERRY_HISTORY_SAMPLE_INTERVAL_MS = CONFIG.ferryHistorySampleMs;
const FERRY_CROSSING_ESTIMATE_MS = 20 * 60 * 1000;
const FERRY_TURNAROUND_ESTIMATE_MS = 15 * 60 * 1000;
const FERRY_OPERATIONAL_TURNAROUND_MS = 10 * 60 * 1000;
const FERRY_OPERATIONAL_INTERVAL_MS = 30 * 60 * 1000;
const FERRY_HISTORY_DEPARTURE_MATCH_MS = 20 * 60 * 1000;
const FERRY_VESSEL_CORRECTION_LOOKAHEAD_MS = 4 * 60 * 60 * 1000;
const FERRY_VESSEL_CORRECTION_RECENCY_MS = 2 * 60 * 60 * 1000;
const FERRY_MIN_SAME_VESSEL_GAP_MS = 55 * 60 * 1000;
const FERRY_GPS_TERMINAL_ZONE_PCT = 0.12;
const FERRY_GPS_STARTUP_IGNORE_MS = 10 * 60 * 1000;
const FERRY_GPS_FIRST_DEPARTURE_GRACE_MS = 15 * 60 * 1000;
const FERRY_GPS_TRAILING_MISSED_GRACE_MS = 10 * 60 * 1000;
const FERRY_OPERATIONAL_HORIZON_MS = 4 * 60 * 60 * 1000;
const FERRY_GPS_STATE_SAMPLE_COUNT = 3;
const FERRY_GPS_STATE_RECENCY_MS = 30 * 60 * 1000;
const FERRY_GPS_MIN_PROGRESS_PER_MINUTE = 0.0025;
// Route-level delay inferred from recent observed departures: how far back to
// look, how many samples are required for confidence, and the median-delay floor
// below which the route is treated as on time.
const FERRY_ROUTE_DELAY_RECENCY_MS = 90 * 60 * 1000;
const FERRY_ROUTE_DELAY_MIN_SAMPLES = 2;
const FERRY_ROUTE_DELAY_THRESHOLD_MS = 8 * 60 * 1000;
const CLINTON_TERMINAL = { name: 'Clinton', lat: 47.9755, lon: -122.3493 };
const MUKILTEO_TERMINAL = { name: 'Mukilteo', lat: 47.9485, lon: -122.3046 };
const TERMINAL_NAMES = new Map([
  [CONFIG.wsfDepartingTerminal, 'Clinton'],
  [CONFIG.wsfArrivingTerminal, 'Mukilteo'],
]);

function pacificDateForMs(ms = Date.now()) {
  return new Date(ms).toLocaleString('sv-SE', { timeZone: CONFIG.timezone }).slice(0, 10);
}

function ferryHistoryDateForMs(ms = Date.now()) {
  return pacificDateForMs(ms - CONFIG.ferryHistoryDayStartHour * 60 * 60 * 1000);
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function localDateStartMs(date, timeZone = CONFIG.timezone) {
  if (!isIsoDate(date)) return null;
  const [year, month, day] = date.split('-').map(Number);
  const localDayAsUtc = Date.UTC(year, month - 1, day);
  return localDayAsUtc - timeZoneOffsetMs(localDayAsUtc, timeZone);
}

function ferryHistoryDayStartMs(date) {
  const startMs = localDateStartMs(date, CONFIG.timezone);
  return startMs === null ? null : startMs + CONFIG.ferryHistoryDayStartHour * 60 * 60 * 1000;
}

function ferryHistoryOperationalDay(date) {
  const startMs = ferryHistoryDayStartMs(date);
  if (startMs === null) return null;
  const endMs = startMs + 24 * 60 * 60 * 1000;
  return {
    timezone: CONFIG.timezone,
    startHour: CONFIG.ferryHistoryDayStartHour,
    startMs,
    endMs,
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(endMs).toISOString(),
  };
}

function ferryHistoryFile(date) {
  return join(CONFIG.ferryHistoryDir, `${date}.json`);
}

function emptyFerryHistoryDay(date) {
  return {
    date,
    operationalDay: ferryHistoryOperationalDay(date),
    generatedAt: null,
    trips: [],
    currentVessels: [],
    vesselSamples: [],
  };
}

function readFerryHistoryDay(date) {
  try {
    if (!existsSync(ferryHistoryFile(date))) return emptyFerryHistoryDay(date);
    const parsed = JSON.parse(readFileSync(ferryHistoryFile(date), 'utf8'));
    return normalizeFerryHistoryDay({
      ...emptyFerryHistoryDay(date),
      ...(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}),
      date,
      trips: Array.isArray(parsed?.trips) ? parsed.trips : [],
      currentVessels: Array.isArray(parsed?.currentVessels) ? parsed.currentVessels : [],
      vesselSamples: Array.isArray(parsed?.vesselSamples) ? parsed.vesselSamples : [],
    });
  } catch (e) {
    console.warn(`[ferry-history] ignoring ${date}: ${e.message}`);
    return emptyFerryHistoryDay(date);
  }
}

function normalizeFerryHistoryDay(day) {
  const reportMs = day.sampledAtMs || Date.parse(day.generatedAt || '') || Date.now();
  const operationalDay = day.operationalDay && Number.isFinite(day.operationalDay.startMs) && Number.isFinite(day.operationalDay.endMs)
    ? day.operationalDay
    : ferryHistoryOperationalDay(day.date);
  return {
    ...day,
    operationalDay,
    vesselSamples: Array.isArray(day.vesselSamples) ? day.vesselSamples : [],
    trips: (day.trips || []).map(trip => {
      if (!trip.actualDepartureMs ||
          trip.actualDepartureMs >= trip.scheduledDepartureMs - FERRY_HISTORY_DEPARTURE_MATCH_MS) {
        const observedVessel = observedVesselForTrip(trip, trip.actualDepartureMs);
        const normalized = observedVessel ? {
          ...trip,
          vesselName: observedVessel.vesselName,
          vesselId: observedVessel.vesselId,
        } : trip;
        return {
          ...normalized,
          status: ferryHistoryTripStatus(normalized, null, reportMs),
        };
      }
      const normalized = {
        ...trip,
        actualDepartureMs: null,
        arrivalMs: trip.scheduledDepartureMs + FERRY_CROSSING_ESTIMATE_MS,
        arrivalBasis: 'scheduled-estimate',
      };
      return {
        ...normalized,
        status: ferryHistoryTripStatus(normalized, null, reportMs),
      };
    }),
  };
}

function ferryDepartureKey(fromTerminalId, scheduledDepartureMs) {
  return `${fromTerminalId}:${scheduledDepartureMs}`;
}

function ferryDepartureSummary(day) {
  const departures = {};
  for (const trip of day?.trips || []) {
    if (!trip?.actualDepartureMs) continue;
    departures[ferryDepartureKey(trip.fromTerminalId, trip.scheduledDepartureMs)] = {
      departed: true,
      direction: trip.direction,
      fromTerminalId: trip.fromTerminalId,
      toTerminalId: trip.toTerminalId,
      scheduledDepartureMs: trip.scheduledDepartureMs,
      actualDepartureMs: trip.actualDepartureMs,
      delayMs: Math.max(0, trip.actualDepartureMs - trip.scheduledDepartureMs),
      vesselName: trip.vesselName || '',
      vesselId: trip.vesselId || null,
      status: trip.status || null,
    };
  }
  for (const { trip, departure } of ferryGpsScheduleObservations(day).matched) {
    const key = ferryDepartureKey(trip.fromTerminalId, trip.scheduledDepartureMs);
    if (departures[key]) continue;
    departures[key] = {
      departed: true,
      source: 'gps-sequence',
      direction: trip.direction,
      fromTerminalId: trip.fromTerminalId,
      toTerminalId: trip.toTerminalId,
      scheduledDepartureMs: trip.scheduledDepartureMs,
      actualDepartureMs: departure.ms,
      delayMs: Math.max(0, departure.ms - trip.scheduledDepartureMs),
      vesselName: departure.vesselName || trip.vesselName || '',
      vesselId: departure.vesselId || trip.vesselId || null,
      status: 'gps-observed',
    };
  }
  return departures;
}

function ferryMissedDepartureSummary(day) {
  const missedDepartures = {};
  for (const trip of ferryGpsScheduleObservations(day).missed) {
    missedDepartures[ferryDepartureKey(trip.fromTerminalId, trip.scheduledDepartureMs)] = {
      missed: true,
      source: 'gps-sequence',
      direction: trip.direction,
      fromTerminalId: trip.fromTerminalId,
      toTerminalId: trip.toTerminalId,
      scheduledDepartureMs: trip.scheduledDepartureMs,
      status: 'missed',
    };
  }
  return missedDepartures;
}

function medianMs(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// Infer a per-direction route delay from the recent observed departures so that
// upcoming chips can warn "running ~N min late" before any boat has been matched
// to them directly. Robust to a single late outlier and to recovery: a tight
// recency window plus a median over >= MIN_SAMPLES departures means a couple of
// on-time runs pull the figure back down. Directions with too few recent
// departures (startup, schedule gaps, end of day, GPS offline) emit nothing.
function ferryRouteDelaySummary(day, nowMs = Date.now()) {
  const routeDelays = {};
  if (!Number.isFinite(nowMs)) return routeDelays;
  const byTerminal = new Map();
  for (const departure of Object.values(ferryDepartureSummary(day))) {
    if (!departure?.departed || !Number.isFinite(departure.actualDepartureMs)) continue;
    if (departure.actualDepartureMs > nowMs) continue;
    if (departure.actualDepartureMs < nowMs - FERRY_ROUTE_DELAY_RECENCY_MS) continue;
    const list = byTerminal.get(departure.fromTerminalId) || [];
    list.push(departure);
    byTerminal.set(departure.fromTerminalId, list);
  }
  for (const [fromTerminalId, departures] of byTerminal) {
    if (departures.length < FERRY_ROUTE_DELAY_MIN_SAMPLES) continue;
    departures.sort((a, b) => a.actualDepartureMs - b.actualDepartureMs);
    const delayMs = medianMs(departures.map(d => Math.max(0, d.delayMs || 0)));
    if (delayMs < FERRY_ROUTE_DELAY_THRESHOLD_MS) continue;
    const latest = departures[departures.length - 1];
    routeDelays[fromTerminalId] = {
      fromTerminalId,
      direction: latest.direction,
      delayMs,
      sampleCount: departures.length,
      latestActualDepartureMs: latest.actualDepartureMs,
      latestDelayMs: Math.max(0, latest.delayMs || 0),
      basis: 'recent-observed-departures',
    };
  }
  return routeDelays;
}

function ferryGpsScheduleObservations(day) {
  const scheduledTrips = (day?.trips || [])
    .filter(trip => Number.isFinite(trip?.scheduledDepartureMs) && trip.direction)
    .sort((a, b) => a.scheduledDepartureMs - b.scheduledDepartureMs);
  if (!scheduledTrips.length) return { matched: [], missed: [] };
  const firstScheduledMs = scheduledTrips[0].scheduledDepartureMs;
  const serviceDepartures = ferryGpsObservedDepartures(day)
    .filter(departure => departure.ms >= firstScheduledMs - FERRY_GPS_STARTUP_IGNORE_MS);
  const nowMs = day?.sampledAtMs || Date.parse(day?.generatedAt || '') || null;
  return allocateFerryGpsDeparturesToSchedule(serviceDepartures, scheduledTrips, nowMs);
}

function ferryGpsObservedDepartures(day) {
  return ferryGpsTracks(day)
    .flatMap(track => ferryGpsObservedDeparturesForTrack(track))
    .sort((a, b) => a.ms - b.ms);
}

function ferryGpsTracks(day) {
  const byVessel = new Map();
  for (const sample of compatibleFerryGpsSamples(day)) {
    addFerryGpsSample(byVessel, sample, sample.vesselName || 'Unknown', sample.vesselId || sample.vesselName || 'Unknown');
  }
  return [...byVessel.values()]
    .map(track => ({
      ...track,
      points: track.points.sort((a, b) => a.ms - b.ms),
    }))
    .filter(track => track.points.length > 1);
}

function compatibleFerryGpsSamples(day) {
  const rawSamples = Array.isArray(day?.vesselSamples) ? day.vesselSamples : [];
  if (!rawSamples.length) return legacyFerryGpsSamples(day);
  const firstRawMs = Math.min(...rawSamples
    .map(sample => Date.parse(sample?.observedAt || ''))
    .filter(Number.isFinite));
  if (!Number.isFinite(firstRawMs)) return rawSamples;
  const legacyBackfill = legacyFerryGpsSamples(day)
    .filter(sample => {
      const ms = Date.parse(sample?.observedAt || '');
      return Number.isFinite(ms) && ms < firstRawMs;
    });
  return [...legacyBackfill, ...rawSamples];
}

function legacyFerryGpsSamples(day) {
  return (day?.trips || []).flatMap(trip =>
    (trip.observations || [])
      .filter(observation =>
        typeof observation?.latitude === 'number' &&
        typeof observation?.longitude === 'number'
      )
      .map(observation => ({
        ...observation,
        vesselName: observation.vesselName || trip.vesselName || 'Unknown',
        vesselId: observation.vesselId || trip.vesselId || observation.vesselName || trip.vesselName || 'Unknown',
      }))
  );
}

function addFerryGpsSample(byVessel, sample, vesselName, vesselId) {
  const ms = Date.parse(sample?.observedAt || '');
  if (!Number.isFinite(ms) ||
      typeof sample?.latitude !== 'number' ||
      typeof sample?.longitude !== 'number') {
    return;
  }
  const name = vesselName || 'Unknown';
  const id = vesselId || name;
  const key = `${id}:${name}`;
  const track = byVessel.get(key) || { key, name, id, points: [], seen: new Set() };
  const sampleKey = [
    ms,
    sample.latitude.toFixed(5),
    sample.longitude.toFixed(5),
  ].join(':');
  if (!track.seen.has(sampleKey)) {
    track.seen.add(sampleKey);
    track.points.push({
      ms,
      pct: ferryTerminalProgress(sample.latitude, sample.longitude),
      latitude: sample.latitude,
      longitude: sample.longitude,
      atDock: sample.atDock ?? null,
      speed: sample.speed ?? null,
      etaMs: sample.etaMs || null,
      leftDockMs: sample.leftDockMs || null,
      departingTerminalId: sample.departingTerminalId ?? null,
      arrivingTerminalId: sample.arrivingTerminalId ?? null,
    });
  }
  byVessel.set(key, track);
}

function ferryGpsObservedDeparturesForTrack(track) {
  let terminal = '';
  let pendingDeparture = null;
  const departures = [];
  for (const point of track.points) {
    const currentTerminal = ferryGpsTerminalZone(point.pct);
    if (terminal && !currentTerminal && !pendingDeparture) {
      pendingDeparture = {
        direction: terminal === 'Clinton' ? 'clinton-to-mukilteo' : 'mukilteo-to-clinton',
        ms: point.ms,
        fromTerminal: terminal,
        toTerminal: terminal === 'Clinton' ? 'Mukilteo' : 'Clinton',
        vesselName: track.name,
        vesselId: track.id,
      };
    }
    if (!currentTerminal) continue;
    if (pendingDeparture && currentTerminal === pendingDeparture.toTerminal) {
      departures.push(pendingDeparture);
    }
    pendingDeparture = null;
    terminal = currentTerminal;
  }
  return departures;
}

function allocateFerryGpsDeparturesToSchedule(departures, scheduledTrips, nowMs = null) {
  const tripsByDirection = scheduledTrips.reduce((byDirection, trip) => {
    const trips = byDirection.get(trip.direction) || [];
    trips.push(trip);
    byDirection.set(trip.direction, trips);
    return byDirection;
  }, new Map());
  const nextTripIndexByDirection = new Map();
  const matchedDirections = new Set();
  const matched = [];
  const missed = [];
  for (const departure of departures) {
    const directionTrips = tripsByDirection.get(departure.direction) || [];
    let tripIndex = nextTripIndexByDirection.get(departure.direction) || 0;
    let trip = directionTrips[tripIndex];
    if (!trip) continue;
    if (tripIndex === 0 && departure.ms < trip.scheduledDepartureMs - FERRY_GPS_FIRST_DEPARTURE_GRACE_MS) continue;
    while (tripIndex + 1 < directionTrips.length &&
           departure.ms >= directionTrips[tripIndex + 1].scheduledDepartureMs) {
      missed.push(directionTrips[tripIndex]);
      tripIndex += 1;
      trip = directionTrips[tripIndex];
    }
    nextTripIndexByDirection.set(departure.direction, tripIndex + 1);
    matchedDirections.add(departure.direction);
    matched.push({ trip, departure });
  }

  // Trailing missed slots: the sample clock acts as a virtual departure. Once a
  // slot's *successor* is also overdue (its scheduled time has elapsed past the
  // sample time by a grace) and no boat ever served it, the run was missed —
  // the overtaking rule above only fires when a later boat is observed, so a
  // route that simply stops or skips its tail end would otherwise never surface.
  // Restricted to directions that already produced a real departure (proof GPS
  // tracking was live, not just offline), and the latest still-due slot is left
  // unflagged so a boat merely running late is never prematurely called missed.
  if (Number.isFinite(nowMs)) {
    for (const [direction, directionTrips] of tripsByDirection) {
      if (!matchedDirections.has(direction)) continue;
      let tripIndex = nextTripIndexByDirection.get(direction) || 0;
      while (tripIndex + 1 < directionTrips.length &&
             directionTrips[tripIndex + 1].scheduledDepartureMs <= nowMs - FERRY_GPS_TRAILING_MISSED_GRACE_MS) {
        missed.push(directionTrips[tripIndex]);
        tripIndex += 1;
      }
      nextTripIndexByDirection.set(direction, tripIndex);
    }
  }

  return { matched, missed };
}

function ferryGpsTerminalZone(pct) {
  if (pct <= FERRY_GPS_TERMINAL_ZONE_PCT) return 'Clinton';
  if (pct >= 1 - FERRY_GPS_TERMINAL_ZONE_PCT) return 'Mukilteo';
  return '';
}

function ferryTerminalProgress(lat, lon) {
  const ax = CLINTON_TERMINAL.lon;
  const ay = CLINTON_TERMINAL.lat;
  const bx = MUKILTEO_TERMINAL.lon;
  const by = MUKILTEO_TERMINAL.lat;
  const dx = bx - ax;
  const dy = by - ay;
  return clampNumber(((lon - ax) * dx + (lat - ay) * dy) / (dx * dx + dy * dy), 0, 1);
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function ferryVesselCorrectionSummary(day, nowMs = Date.now()) {
  const corrections = {};
  const trips = [...(day?.trips || [])]
    .filter(trip => trip?.scheduledDepartureMs)
    .sort((a, b) => a.scheduledDepartureMs - b.scheduledDepartureMs || a.direction.localeCompare(b.direction));
  const latestObservedTrip = trips
    .filter(trip => trip.actualDepartureMs && trip.vesselName && (nowMs - trip.actualDepartureMs) <= FERRY_VESSEL_CORRECTION_RECENCY_MS)
    .sort((a, b) => b.actualDepartureMs - a.actualDepartureMs)[0];
  if (!latestObservedTrip) return corrections;

  let expectedFromTerminalId = latestObservedTrip.toTerminalId;
  const horizonMs = nowMs + FERRY_VESSEL_CORRECTION_LOOKAHEAD_MS;
  for (const trip of trips) {
    if (trip.scheduledDepartureMs <= latestObservedTrip.scheduledDepartureMs ||
        trip.scheduledDepartureMs < nowMs - FERRY_HISTORY_DEPARTURE_MATCH_MS ||
        trip.scheduledDepartureMs > horizonMs ||
        trip.actualDepartureMs ||
        trip.fromTerminalId !== expectedFromTerminalId) {
      continue;
    }
    corrections[ferryDepartureKey(trip.fromTerminalId, trip.scheduledDepartureMs)] = {
      direction: trip.direction,
      fromTerminalId: trip.fromTerminalId,
      toTerminalId: trip.toTerminalId,
      scheduledDepartureMs: trip.scheduledDepartureMs,
      vesselName: latestObservedTrip.vesselName,
      vesselId: latestObservedTrip.vesselId || null,
      sourceScheduledDepartureMs: latestObservedTrip.scheduledDepartureMs,
      sourceActualDepartureMs: latestObservedTrip.actualDepartureMs,
      basis: 'recent-gps-chain',
    };
    expectedFromTerminalId = trip.toTerminalId;
  }
  return corrections;
}

function terminalNameForId(terminalId) {
  return TERMINAL_NAMES.get(terminalId) || String(terminalId || '');
}

function terminalIdForName(name) {
  if (name === 'Clinton') return CONFIG.wsfDepartingTerminal;
  if (name === 'Mukilteo') return CONFIG.wsfArrivingTerminal;
  return null;
}

function ferryDirectionForTerminals(fromTerminalId, toTerminalId) {
  if (fromTerminalId === CONFIG.wsfDepartingTerminal && toTerminalId === CONFIG.wsfArrivingTerminal) {
    return 'clinton-to-mukilteo';
  }
  if (fromTerminalId === CONFIG.wsfArrivingTerminal && toTerminalId === CONFIG.wsfDepartingTerminal) {
    return 'mukilteo-to-clinton';
  }
  return `${terminalNameForId(fromTerminalId).toLowerCase()}-to-${terminalNameForId(toTerminalId).toLowerCase()}`;
}

function ferryOperationalScheduleBounds(day) {
  const byTerminal = new Map();
  for (const trip of day?.trips || []) {
    if (!Number.isFinite(trip?.scheduledDepartureMs)) continue;
    const bounds = byTerminal.get(trip.fromTerminalId) || {
      fromTerminalId: trip.fromTerminalId,
      toTerminalId: trip.toTerminalId,
      direction: trip.direction || ferryDirectionForTerminals(trip.fromTerminalId, trip.toTerminalId),
      firstScheduledMs: trip.scheduledDepartureMs,
      finalScheduledMs: trip.scheduledDepartureMs,
    };
    bounds.firstScheduledMs = Math.min(bounds.firstScheduledMs, trip.scheduledDepartureMs);
    bounds.finalScheduledMs = Math.max(bounds.finalScheduledMs, trip.scheduledDepartureMs);
    byTerminal.set(trip.fromTerminalId, bounds);
  }
  return byTerminal;
}

function ferryRecentPassageVesselIds(day, nowMs) {
  const ids = new Set();
  for (const departure of ferryGpsObservedDepartures(day)) {
    if (!Number.isFinite(departure?.ms)) continue;
    if (departure.ms > nowMs || nowMs - departure.ms > FERRY_GPS_STATE_RECENCY_MS) continue;
    ids.add(departure.vesselId || departure.vesselName || 'Unknown');
  }
  return ids;
}

function ferryOneBoatOperationalMode(day, nowMs) {
  if (!Number.isFinite(nowMs)) return { active: false, vesselIds: new Set() };
  const bounds = ferryOperationalScheduleBounds(day);
  const clinton = bounds.get(CONFIG.wsfDepartingTerminal);
  const mukilteo = bounds.get(CONFIG.wsfArrivingTerminal);
  if (!clinton || !mukilteo) return { active: false, vesselIds: new Set() };
  if (nowMs < clinton.firstScheduledMs + FERRY_OPERATIONAL_INTERVAL_MS ||
      nowMs < mukilteo.firstScheduledMs + FERRY_OPERATIONAL_INTERVAL_MS) {
    return { active: false, vesselIds: new Set() };
  }
  const vesselIds = ferryRecentPassageVesselIds(day, nowMs);
  return { active: vesselIds.size === 1, vesselIds };
}

function ferryVesselStatusSummary(day, nowMs = Date.now()) {
  const statuses = {};
  if (!Number.isFinite(nowMs)) return statuses;
  const oneBoatMode = ferryOneBoatOperationalMode(day, nowMs);
  for (const track of ferryGpsTracks(day)) {
    const recent = track.points
      .filter(point => point.ms <= nowMs && nowMs - point.ms <= FERRY_GPS_STATE_RECENCY_MS)
      .slice(-FERRY_GPS_STATE_SAMPLE_COUNT);
    if (!recent.length) continue;
    const latest = recent[recent.length - 1];
    const terminalName = ferryGpsTerminalZone(latest.pct);
    const latestTerminalId = terminalIdForName(terminalName);
    const vesselId = track.id || track.name || 'Unknown';
    if (oneBoatMode.active && !oneBoatMode.vesselIds.has(vesselId)) continue;

    if (latestTerminalId) {
      statuses[track.key] = {
        vesselName: track.name,
        vesselId: track.id,
        status: latestTerminalId === CONFIG.wsfDepartingTerminal ? 'at-clinton-dock' : 'at-mukilteo-dock',
        terminalId: latestTerminalId,
        terminalName: terminalNameForId(latestTerminalId),
        availableTerminalId: latestTerminalId,
        availableMs: nowMs,
        observedAtMs: latest.ms,
        progressPct: latest.pct,
        basis: 'gps-vessel-state',
      };
      continue;
    }

    if (recent.length < 2) {
      statuses[track.key] = ferryReturningStatus(track, latest, 'insufficient-gps-motion');
      continue;
    }

    const first = recent[0];
    const elapsedMinutes = (latest.ms - first.ms) / 60000;
    const progressPerMinute = elapsedMinutes > 0 ? (latest.pct - first.pct) / elapsedMinutes : 0;
    const segmentDirections = [];
    for (let i = 1; i < recent.length; i += 1) {
      const delta = recent[i].pct - recent[i - 1].pct;
      if (Math.abs(delta) >= FERRY_GPS_MIN_PROGRESS_PER_MINUTE) segmentDirections.push(Math.sign(delta));
    }
    const reversed = segmentDirections.length > 1 && new Set(segmentDirections).size > 1;
    const expectedTerminalId = latest.arrivingTerminalId === CONFIG.wsfDepartingTerminal ||
      latest.arrivingTerminalId === CONFIG.wsfArrivingTerminal
      ? latest.arrivingTerminalId
      : null;
    const expectedSign = expectedTerminalId === CONFIG.wsfDepartingTerminal ? -1 :
      (expectedTerminalId === CONFIG.wsfArrivingTerminal ? 1 : 0);
    const motionSign = Math.abs(progressPerMinute) >= FERRY_GPS_MIN_PROGRESS_PER_MINUTE ? Math.sign(progressPerMinute) : 0;
    if (reversed ||
        motionSign === 0 ||
        (expectedSign && motionSign !== expectedSign)) {
      statuses[track.key] = ferryReturningStatus(track, latest, reversed ? 'gps-motion-reversal' : 'not-making-way-to-expected-dock');
      continue;
    }

    const destinationTerminalId = motionSign > 0 ? CONFIG.wsfArrivingTerminal : CONFIG.wsfDepartingTerminal;
    const remainingProgress = motionSign > 0 ? 1 - latest.pct : latest.pct;
    const etaMs = latest.ms + Math.round((remainingProgress / Math.abs(progressPerMinute)) * 60000);
    statuses[track.key] = {
      vesselName: track.name,
      vesselId: track.id,
      status: destinationTerminalId === CONFIG.wsfDepartingTerminal ? 'underway-to-clinton' : 'underway-to-mukilteo',
      terminalId: null,
      terminalName: null,
      destinationTerminalId,
      destinationTerminalName: terminalNameForId(destinationTerminalId),
      availableTerminalId: destinationTerminalId,
      etaMs,
      availableMs: etaMs + FERRY_OPERATIONAL_TURNAROUND_MS,
      observedAtMs: latest.ms,
      progressPct: latest.pct,
      progressPerMinute,
      basis: 'gps-vessel-state',
    };
  }
  return statuses;
}

function ferryReturningStatus(track, latest, reason) {
  const expectedTerminalId = latest.arrivingTerminalId === CONFIG.wsfDepartingTerminal ||
    latest.arrivingTerminalId === CONFIG.wsfArrivingTerminal
    ? latest.arrivingTerminalId
    : null;
  const expectedFromTerminalId = expectedTerminalId === CONFIG.wsfDepartingTerminal
    ? CONFIG.wsfArrivingTerminal
    : (expectedTerminalId === CONFIG.wsfArrivingTerminal ? CONFIG.wsfDepartingTerminal : null);
  return {
    vesselName: track.name,
    vesselId: track.id,
    status: 'returning',
    terminalId: null,
    terminalName: null,
    expectedTerminalId,
    expectedTerminalName: expectedTerminalId ? terminalNameForId(expectedTerminalId) : null,
    expectedFromTerminalId,
    expectedFromTerminalName: expectedFromTerminalId ? terminalNameForId(expectedFromTerminalId) : null,
    availableTerminalId: null,
    availableMs: null,
    observedAtMs: latest.ms,
    progressPct: latest.pct,
    basis: 'gps-vessel-state',
    reason,
  };
}

function closestScheduledAtOrBefore(trips, projectedMs) {
  let match = null;
  for (const trip of trips) {
    if (trip.scheduledDepartureMs <= projectedMs) match = trip;
    else break;
  }
  return match || trips[0] || null;
}

function operationalReferenceTrip(trips, projectedMs, usedKeys) {
  const closest = closestScheduledAtOrBefore(trips, projectedMs);
  const startIndex = Math.max(0, closest ? trips.indexOf(closest) : 0);
  for (let i = startIndex; i < trips.length; i += 1) {
    const trip = trips[i];
    if (!usedKeys.has(ferryDepartureKey(trip.fromTerminalId, trip.scheduledDepartureMs))) return trip;
  }
  return null;
}

function ferryOperationalPredictions(day, nowMs = Date.now(), vesselStatuses = ferryVesselStatusSummary(day, nowMs)) {
  const predictions = {};
  if (!Number.isFinite(nowMs)) return predictions;
  const tripsByTerminal = new Map();
  for (const trip of [...(day?.trips || [])].sort((a, b) => a.scheduledDepartureMs - b.scheduledDepartureMs)) {
    if (!Number.isFinite(trip?.scheduledDepartureMs) ||
        trip.actualDepartureMs ||
        trip.scheduledDepartureMs < nowMs - FERRY_HISTORY_DEPARTURE_MATCH_MS) {
      continue;
    }
    const trips = tripsByTerminal.get(trip.fromTerminalId) || [];
    trips.push(trip);
    tripsByTerminal.set(trip.fromTerminalId, trips);
  }
  const scheduleBounds = ferryOperationalScheduleBounds(day);
  const departures = Object.values(ferryDepartureSummary(day));
  const observedKeys = new Set(departures.map(departure =>
    ferryDepartureKey(departure.fromTerminalId, departure.scheduledDepartureMs)));
  const usedKeys = new Set(observedKeys);
  const states = Object.values(vesselStatuses)
    .filter(status => status.availableTerminalId && Number.isFinite(status.availableMs))
    .map(status => ({
      vesselName: status.vesselName,
      vesselId: status.vesselId,
      nextFromTerminalId: status.availableTerminalId,
      availableMs: status.availableMs,
      sourceStatus: status.status,
      sourceObservedAtMs: status.observedAtMs,
    }))
    .sort((a, b) => a.availableMs - b.availableMs);

  let guard = 0;
  while (guard < 96 && states.length) {
    guard += 1;
    states.sort((a, b) => a.availableMs - b.availableMs || String(a.vesselName).localeCompare(String(b.vesselName)));
    const state = states.shift();
    const directionTrips = tripsByTerminal.get(state.nextFromTerminalId) || [];
    const bounds = scheduleBounds.get(state.nextFromTerminalId);
    if (!directionTrips.length || !bounds) continue;
    const closeMs = bounds.finalScheduledMs + FERRY_OPERATIONAL_INTERVAL_MS;
    const projectedBaseMs = Math.max(state.availableMs, nowMs);
    const referenceTrip = operationalReferenceTrip(directionTrips, projectedBaseMs, usedKeys);
    if (!referenceTrip) continue;
    const projectedDepartureMs = Math.max(projectedBaseMs, referenceTrip.scheduledDepartureMs);
    if (projectedDepartureMs > closeMs || projectedDepartureMs > nowMs + FERRY_OPERATIONAL_HORIZON_MS) continue;
    const key = ferryDepartureKey(referenceTrip.fromTerminalId, referenceTrip.scheduledDepartureMs);
    if (!observedKeys.has(key) && !predictions[key]) {
      predictions[key] = {
        direction: referenceTrip.direction,
        fromTerminalId: referenceTrip.fromTerminalId,
        toTerminalId: referenceTrip.toTerminalId,
        scheduledDepartureMs: referenceTrip.scheduledDepartureMs,
        scheduledReferenceMs: referenceTrip.scheduledDepartureMs,
        displayScheduledMs: referenceTrip.scheduledDepartureMs,
        projectedDepartureMs,
        delayMs: Math.max(0, projectedDepartureMs - referenceTrip.scheduledDepartureMs),
        vesselName: state.vesselName,
        vesselId: state.vesselId,
        sourceStatus: state.sourceStatus,
        sourceObservedAtMs: state.sourceObservedAtMs,
        basis: 'gps-vessel-state',
      };
    }
    usedKeys.add(key);
    state.nextFromTerminalId = referenceTrip.toTerminalId;
    state.availableMs = projectedDepartureMs + FERRY_CROSSING_ESTIMATE_MS + FERRY_OPERATIONAL_TURNAROUND_MS;
    state.sourceStatus = 'operational-chain';
    states.push(state);
  }

  return predictions;
}

function ferryPredictedDepartureSummary(day, nowMs = Date.now()) {
  const vesselStatuses = ferryVesselStatusSummary(day, nowMs);
  const predictions = ferryOperationalPredictions(day, nowMs, vesselStatuses);
  if (Object.keys(predictions).length) return predictions;
  const legacyPredictions = {};
  if (!Number.isFinite(nowMs)) return predictions;
  const departures = Object.values(ferryDepartureSummary(day))
    .filter(departure =>
      departure?.departed &&
      departure.vesselName &&
      Number.isFinite(departure.actualDepartureMs) &&
      departure.actualDepartureMs <= nowMs &&
      nowMs - departure.actualDepartureMs <= FERRY_VESSEL_CORRECTION_RECENCY_MS
    )
    .sort((a, b) => a.actualDepartureMs - b.actualDepartureMs);
  if (!departures.length) return legacyPredictions;

  const statesByVessel = new Map();
  for (const departure of departures) {
    const key = departure.vesselId ? `id:${departure.vesselId}` : `name:${departure.vesselName}`;
    statesByVessel.set(key, {
      key,
      vesselName: departure.vesselName,
      vesselId: departure.vesselId || null,
      nextFromTerminalId: departure.toTerminalId,
      availableMs: departure.actualDepartureMs + FERRY_CROSSING_ESTIMATE_MS + FERRY_TURNAROUND_ESTIMATE_MS,
      sourceScheduledDepartureMs: departure.scheduledDepartureMs,
      sourceActualDepartureMs: departure.actualDepartureMs,
    });
  }
  const states = [...statesByVessel.values()];
  if (!states.length) return legacyPredictions;

  const routeDelays = ferryRouteDelaySummary(day, nowMs);
  const horizonMs = nowMs + FERRY_VESSEL_CORRECTION_LOOKAHEAD_MS;
  const trips = [...(day?.trips || [])]
    .filter(trip =>
      trip?.scheduledDepartureMs &&
      !trip.actualDepartureMs &&
      trip.scheduledDepartureMs <= horizonMs
    )
    .sort((a, b) => a.scheduledDepartureMs - b.scheduledDepartureMs || a.direction.localeCompare(b.direction));

  for (const trip of trips) {
    const routeDelayMs = routeDelays[trip.fromTerminalId]?.delayMs || 0;
    const routeProjectedMs = trip.scheduledDepartureMs + routeDelayMs;
    if (Math.max(routeProjectedMs, trip.scheduledDepartureMs) < nowMs - FERRY_HISTORY_DEPARTURE_MATCH_MS) continue;

    const candidates = states
      .filter(state => state.nextFromTerminalId === trip.fromTerminalId)
      .map(state => ({
        state,
        projectedDepartureMs: Math.max(routeProjectedMs, state.availableMs),
      }))
      .filter(candidate => candidate.projectedDepartureMs <= horizonMs + FERRY_CROSSING_ESTIMATE_MS)
      .sort((a, b) => a.projectedDepartureMs - b.projectedDepartureMs);
    if (!candidates.length) continue;

    const { state, projectedDepartureMs } = candidates[0];
    legacyPredictions[ferryDepartureKey(trip.fromTerminalId, trip.scheduledDepartureMs)] = {
      direction: trip.direction,
      fromTerminalId: trip.fromTerminalId,
      toTerminalId: trip.toTerminalId,
      scheduledDepartureMs: trip.scheduledDepartureMs,
      projectedDepartureMs,
      delayMs: Math.max(0, projectedDepartureMs - trip.scheduledDepartureMs),
      vesselName: state.vesselName,
      vesselId: state.vesselId,
      sourceScheduledDepartureMs: state.sourceScheduledDepartureMs,
      sourceActualDepartureMs: state.sourceActualDepartureMs,
      basis: 'gps-vessel-forecast',
    };

    state.nextFromTerminalId = trip.toTerminalId;
    state.availableMs = projectedDepartureMs + FERRY_CROSSING_ESTIMATE_MS + FERRY_TURNAROUND_ESTIMATE_MS;
    state.sourceScheduledDepartureMs = trip.scheduledDepartureMs;
    state.sourceActualDepartureMs = projectedDepartureMs;
  }

  return legacyPredictions;
}

function returningVesselForTrip(trip, vesselStatuses = {}, nowMs = Date.now()) {
  const candidates = Object.values(vesselStatuses)
    .filter(status =>
      status?.status === 'returning' &&
      status.expectedFromTerminalId === trip.fromTerminalId &&
      status.expectedTerminalId === trip.toTerminalId &&
      Number.isFinite(status.observedAtMs) &&
      Math.abs(nowMs - trip.scheduledDepartureMs) <= FERRY_HISTORY_DEPARTURE_MATCH_MS
    )
    .sort((a, b) => Math.abs(a.observedAtMs - trip.scheduledDepartureMs) - Math.abs(b.observedAtMs - trip.scheduledDepartureMs));
  return candidates[0] || null;
}

function ferryResolvedVesselSummary(day, nowMs = Date.now(), summaries = {}) {
  const resolved = {};
  const departures = summaries.departures || ferryDepartureSummary(day);
  const predictions = summaries.predictedDepartures || ferryPredictedDepartureSummary(day, nowMs);
  const corrections = summaries.vesselCorrections || ferryVesselCorrectionSummary(day, nowMs);
  const vesselStatuses = summaries.vesselStatuses || ferryVesselStatusSummary(day, nowMs);
  const trips = [...(day?.trips || [])]
    .filter(trip => Number.isFinite(trip?.scheduledDepartureMs))
    .sort((a, b) => a.scheduledDepartureMs - b.scheduledDepartureMs || a.direction.localeCompare(b.direction));

  for (const trip of trips) {
    const key = ferryDepartureKey(trip.fromTerminalId, trip.scheduledDepartureMs);
    const departure = departures[key];
    const prediction = predictions[key];
    const correction = corrections[key];
    const returning = returningVesselForTrip(trip, vesselStatuses, nowMs);
    const vesselName = departure?.vesselName ||
      prediction?.vesselName ||
      correction?.vesselName ||
      returning?.vesselName ||
      trip.vesselName ||
      '';
    let source = '';
    if (departure?.vesselName) source = 'observed-departure';
    else if (prediction?.vesselName) source = 'predicted-departure';
    else if (correction?.vesselName) source = 'recent-gps-chain';
    else if (returning?.vesselName) source = 'returning-vessel';
    else if (trip.vesselName) source = 'schedule-row';
    else source = 'none';

    resolved[key] = {
      direction: trip.direction,
      fromTerminalId: trip.fromTerminalId,
      toTerminalId: trip.toTerminalId,
      scheduledDepartureMs: trip.scheduledDepartureMs,
      vesselName,
      vesselId: departure?.vesselId || prediction?.vesselId || correction?.vesselId || returning?.vesselId || trip.vesselId || null,
      source,
    };
  }

  for (const [key, entry] of Object.entries(resolved)) {
    if (entry.source !== 'schedule-row' || !entry.vesselName) continue;
    const conflict = Object.entries(resolved).some(([otherKey, other]) => {
      if (otherKey === key ||
          other.source !== 'schedule-row' ||
          other.vesselName !== entry.vesselName ||
          other.fromTerminalId !== entry.fromTerminalId) {
        return false;
      }
      return Math.abs(other.scheduledDepartureMs - entry.scheduledDepartureMs) < FERRY_MIN_SAME_VESSEL_GAP_MS;
    });
    if (conflict) {
      resolved[key] = {
        ...entry,
        vesselName: '',
        vesselId: null,
        source: 'suppressed-schedule-row',
        suppressedReason: 'same-vessel-same-direction-too-close',
      };
    }
  }

  return resolved;
}

function ferryResolvedSailingSummary(day, nowMs = Date.now(), summaries = {}) {
  const departures = summaries.departures || ferryDepartureSummary(day);
  const missedDepartures = summaries.missedDepartures || ferryMissedDepartureSummary(day);
  const predictedDepartures = summaries.predictedDepartures || ferryPredictedDepartureSummary(day, nowMs);
  const vesselStatuses = summaries.vesselStatuses || ferryVesselStatusSummary(day, nowMs);
  const resolvedVessels = summaries.resolvedVessels ||
    ferryResolvedVesselSummary(day, nowMs, { departures, predictedDepartures, vesselCorrections: summaries.vesselCorrections, vesselStatuses });
  const routeDelays = summaries.routeDelays || ferryRouteDelaySummary(day, nowMs);
  const resolved = {};
  const trips = [...(day?.trips || [])]
    .filter(trip => Number.isFinite(trip?.scheduledDepartureMs))
    .sort((a, b) => a.scheduledDepartureMs - b.scheduledDepartureMs || a.direction.localeCompare(b.direction));

  for (const trip of trips) {
    const key = ferryDepartureKey(trip.fromTerminalId, trip.scheduledDepartureMs);
    const departure = departures[key];
    const missed = missedDepartures[key];
    const prediction = predictedDepartures[key];
    const returning = returningVesselForTrip(trip, vesselStatuses, nowMs);
    const routeDelay = routeDelays[trip.fromTerminalId];
    const routeProjectedMs = routeDelay ? trip.scheduledDepartureMs + routeDelay.delayMs : null;
    const routeProjectionEligible = routeProjectedMs &&
      routeProjectionMsIsUseful(routeProjectedMs, trip.scheduledDepartureMs, nowMs);
    const projectedDepartureMs = prediction?.projectedDepartureMs ||
      (routeProjectionEligible ? routeProjectedMs : null);
    const effectiveDepartureMs = departure?.actualDepartureMs ||
      projectedDepartureMs ||
      trip.scheduledDepartureMs;
    const delayMs = departure?.delayMs ??
      prediction?.delayMs ??
      (routeProjectionEligible ? Math.max(0, routeProjectedMs - trip.scheduledDepartureMs) : 0);
    let status = 'scheduled';
    let timingSource = 'schedule-row';
    if (missed) {
      status = 'missed';
      timingSource = missed.source || 'missed-departure';
    } else if (departure) {
      status = 'departed';
      timingSource = departure.source || 'observed-departure';
    } else if (returning) {
      status = 'returning';
      timingSource = returning.reason || 'gps-returning';
    } else if (prediction) {
      status = 'projected';
      timingSource = prediction.basis || 'gps-vessel-forecast';
    } else if (routeProjectionEligible) {
      status = 'projected';
      timingSource = routeDelay.basis || 'recent-observed-departures';
    }
    if (status === 'scheduled' && effectiveDepartureMs < nowMs) {
      status = 'unknown';
      timingSource = 'server-unconfirmed';
    }

    const vessel = resolvedVessels[key] || {};
    resolved[key] = {
      direction: trip.direction,
      fromTerminalId: trip.fromTerminalId,
      toTerminalId: trip.toTerminalId,
      scheduledDepartureMs: trip.scheduledDepartureMs,
      scheduledReferenceMs: prediction?.scheduledReferenceMs || trip.scheduledDepartureMs,
      displayScheduledMs: prediction?.displayScheduledMs || trip.scheduledDepartureMs,
      effectiveDepartureMs,
      displayDepartureMs: effectiveDepartureMs,
      delayMs: Math.max(0, delayMs || 0),
      status,
      timingSource,
      isProjected: status === 'projected',
      isDeparted: status === 'departed',
      isMissed: status === 'missed',
      isUnknown: status === 'unknown',
      isReturning: status === 'returning',
      vesselName: vessel.vesselName || '',
      vesselId: vessel.vesselId || null,
      vesselSource: vessel.source || 'none',
    };
  }

  return resolved;
}

function routeProjectionMsIsUseful(projectedMs, scheduledMs, nowMs) {
  return Number.isFinite(projectedMs) &&
    projectedMs >= nowMs &&
    projectedMs - scheduledMs >= FERRY_ROUTE_DELAY_THRESHOLD_MS;
}

function observedVesselForTrip(trip, actualDepartureMs) {
  if (!actualDepartureMs || !Array.isArray(trip?.observations)) return null;
  const observations = trip.observations
    .filter(observation => observation?.vesselName && observation?.vesselId)
    .map(observation => ({
      vesselName: observation.vesselName,
      vesselId: observation.vesselId,
      leftDockMs: observation.leftDockMs || null,
      observedMs: Date.parse(observation.observedAt || ''),
    }));
  if (!observations.length) return null;
  const departureMatch = observations.find(observation =>
    observation.leftDockMs &&
    Math.abs(observation.leftDockMs - actualDepartureMs) <= FERRY_HISTORY_DEPARTURE_MATCH_MS
  );
  if (departureMatch) return {
    vesselName: departureMatch.vesselName,
    vesselId: departureMatch.vesselId,
  };
  const counts = new Map();
  for (const observation of observations) {
    const key = `${observation.vesselId}:${observation.vesselName}`;
    const count = counts.get(key) || {
      vesselName: observation.vesselName,
      vesselId: observation.vesselId,
      count: 0,
      latestMs: 0,
    };
    count.count += 1;
    count.latestMs = Math.max(count.latestMs, Number.isFinite(observation.observedMs) ? observation.observedMs : 0);
    counts.set(key, count);
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || b.latestMs - a.latestMs)[0] || null;
}

function writeFerryHistoryDay(day) {
  mkdirSync(CONFIG.ferryHistoryDir, { recursive: true });
  writeFileSync(ferryHistoryFile(day.date), JSON.stringify(day, null, 2));
}

function pruneFerryHistory(nowMs = Date.now()) {
  try {
    if (!existsSync(CONFIG.ferryHistoryDir)) return;
    const cutoffMs = startOfLocalDayMs(nowMs, CONFIG.timezone) - (FERRY_HISTORY_RETENTION_DAYS - 1) * 24 * 60 * 60 * 1000;
    for (const name of readdirSync(CONFIG.ferryHistoryDir)) {
      const match = name.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
      if (!match) continue;
      const dayMs = localDateStartMs(match[1], CONFIG.timezone);
      if (dayMs !== null && dayMs < cutoffMs) unlinkSync(join(CONFIG.ferryHistoryDir, name));
    }
  } catch (e) {
    console.warn(`[ferry-history] prune failed: ${e.message}`);
  }
}

async function ferryScheduleDataForHistory(cacheKey, fromTerminal, toTerminal) {
  return cachedDataForHistory(cacheKey, 30 * 1000, () =>
    fetchWsfFerryScheduleData(fromTerminal, toTerminal));
}

async function ferrySpaceDataForHistory(cacheKey, fromTerminal, toTerminal) {
  return cachedDataForHistory(cacheKey, 30 * 1000, () =>
    fetchWsfFerrySpaceData(fromTerminal, toTerminal));
}

async function cachedDataForHistory(cacheKey, ttlMs, fetcher) {
  const hit = getCached(cacheKey);
  if (hit) return hit.data;

  const stale = getStale(cacheKey);
  if (stale) {
    refreshCacheInBackground(cacheKey, ttlMs, fetcher, null);
    return stale.data;
  }

  const data = await fetcher();
  setCache(cacheKey, data, ttlMs);
  return data;
}

function tripId(date, direction, scheduledDepartureMs) {
  return `${date}:${direction}:${scheduledDepartureMs}`;
}

function tripBelongsToFerryHistoryDate(scheduledDepartureMs, date) {
  const operationalDay = ferryHistoryOperationalDay(date);
  if (!operationalDay) return false;
  return scheduledDepartureMs >= operationalDay.startMs && scheduledDepartureMs < operationalDay.endMs;
}

function vesselDirectionMatchesTrip(vessel, trip) {
  if (!vessel || !trip) return false;
  if (vessel.departingTerminalId !== trip.fromTerminalId) return false;
  if (vessel.arrivingTerminalId === trip.toTerminalId) return true;
  return !vessel.atDock &&
    vessel.leftDockMs &&
    !vessel.arrivingTerminalId;
}

function vesselMatchesTrip(vessel, trip, nowMs) {
  if (!vessel || !trip) return false;
  if (!vesselDirectionMatchesTrip(vessel, trip)) return false;
  if (vessel.scheduledDepartureMs && Math.abs(vessel.scheduledDepartureMs - trip.scheduledDepartureMs) <= FERRY_HISTORY_DEPARTURE_MATCH_MS) return true;
  if (vessel.leftDockMs && Math.abs(vessel.leftDockMs - trip.scheduledDepartureMs) <= FERRY_HISTORY_DEPARTURE_MATCH_MS) return true;
  if (vessel.vesselName && trip.vesselName && vessel.vesselName === trip.vesselName) {
    return !vessel.scheduledDepartureMs &&
      !vessel.leftDockMs &&
      Math.abs(nowMs - trip.scheduledDepartureMs) <= FERRY_HISTORY_DEPARTURE_MATCH_MS;
  }
  return false;
}

function vesselMatchKey(vessel) {
  return vessel?.vesselId || `${vessel?.vesselName || 'Unknown'}:${vessel?.departingTerminalId || ''}:${vessel?.arrivingTerminalId || ''}`;
}

function ferryVesselSampleKey(sample) {
  return [
    sample?.observedAt || '',
    sample?.vesselId || sample?.vesselName || 'Unknown',
    sample?.latitude ?? '',
    sample?.longitude ?? '',
  ].join(':');
}

function mergeFerryVesselSamples(existingSamples = [], vessels = [], nowMs = Date.now()) {
  const nextSamples = vessels
    .filter(vessel => typeof vessel.latitude === 'number' && typeof vessel.longitude === 'number')
    .map(vessel => ({
      observedAt: new Date(nowMs).toISOString(),
      vesselId: vessel.vesselId || null,
      vesselName: vessel.vesselName || 'Unknown',
      atDock: vessel.atDock ?? null,
      speed: vessel.speed ?? null,
      etaMs: vessel.etaMs || null,
      leftDockMs: vessel.leftDockMs || null,
      departingTerminalId: vessel.departingTerminalId ?? null,
      arrivingTerminalId: vessel.arrivingTerminalId ?? null,
      scheduledDepartureMs: vessel.scheduledDepartureMs || null,
      latitude: vessel.latitude,
      longitude: vessel.longitude,
    }));
  const byKey = new Map();
  for (const sample of [...existingSamples, ...nextSamples]) {
    if (!sample || typeof sample.latitude !== 'number' || typeof sample.longitude !== 'number') continue;
    byKey.set(ferryVesselSampleKey(sample), sample);
  }
  return [...byKey.values()]
    .sort((a, b) => Date.parse(a.observedAt || '') - Date.parse(b.observedAt || ''));
}

function vesselMatchScore(vessel, trip, nowMs) {
  if (!vesselMatchesTrip(vessel, trip, nowMs)) return null;
  if (vessel.scheduledDepartureMs) return Math.abs(vessel.scheduledDepartureMs - trip.scheduledDepartureMs);
  if (vessel.leftDockMs) return Math.abs(vessel.leftDockMs - trip.scheduledDepartureMs);
  return Math.abs(nowMs - trip.scheduledDepartureMs);
}

function vesselMatchPriority(vessel) {
  if (!vessel) return 9;
  if (vessel.leftDockMs && !vessel.atDock) return 0;
  if (vessel.leftDockMs) return 1;
  if (vessel.scheduledDepartureMs && !vessel.atDock) return 2;
  if (vessel.etaMs && !vessel.atDock) return 3;
  if (vessel.scheduledDepartureMs) return 4;
  if (vessel.atDock) return 5;
  return 8;
}

function assignVesselsToTrips(vessels, trips, nowMs) {
  const candidates = [];
  for (const vessel of vessels) {
    const key = vesselMatchKey(vessel);
    for (const trip of trips) {
      const score = vesselMatchScore(vessel, trip, nowMs);
      if (score !== null) candidates.push({ key, vessel, tripId: trip.id, score, priority: vesselMatchPriority(vessel) });
    }
  }
  candidates.sort((a, b) => a.priority - b.priority || a.score - b.score);
  const usedVessels = new Set();
  const usedTrips = new Set();
  const assigned = new Map();
  for (const candidate of candidates) {
    if (usedVessels.has(candidate.key) || usedTrips.has(candidate.tripId)) continue;
    usedVessels.add(candidate.key);
    usedTrips.add(candidate.tripId);
    assigned.set(candidate.tripId, candidate.vessel);
  }
  return assigned;
}

function ferryHistoryTripStatus(trip, vessel, nowMs) {
  if (!trip.actualDepartureMs) {
    return trip.scheduledDepartureMs < nowMs ? 'scheduled-past' : 'scheduled';
  }
  const arrivalMs = trip.arrivalMs || trip.actualDepartureMs + FERRY_CROSSING_ESTIMATE_MS;
  if (arrivalMs <= nowMs ||
      (vessel?.atDock && vessel?.arrivingTerminalId === trip.toTerminalId && nowMs > trip.actualDepartureMs)) {
    return 'completed';
  }
  return 'in-progress';
}

function mergeTripObservation(existing, next, vessel, nowMs) {
  const actualDepartureMs = existing.actualDepartureMs || vessel?.leftDockMs || null;
  const vesselProvidedDeparture = vessel?.leftDockMs && vessel.leftDockMs === actualDepartureMs;
  const observedVesselName = vesselProvidedDeparture && vessel?.vesselName ? vessel.vesselName : null;
  const observedVesselId = vesselProvidedDeparture && vessel?.vesselId ? vessel.vesselId : null;
  const persistedObservedVessel = observedVesselForTrip(existing, actualDepartureMs);
  const persistedObservedVesselName = persistedObservedVessel?.vesselName || (actualDepartureMs ? existing.vesselName : '');
  const persistedObservedVesselId = persistedObservedVessel?.vesselId || (actualDepartureMs ? existing.vesselId : null);
  const observedArrivalMs = actualDepartureMs &&
    vessel?.atDock &&
    vessel?.arrivingTerminalId === next.toTerminalId &&
    nowMs > actualDepartureMs
    ? nowMs
    : null;
  const arrivalMs = observedArrivalMs ||
    (existing.arrivalBasis === 'observed-at-dock' ? existing.arrivalMs : null) ||
    vessel?.etaMs ||
    existing.arrivalMs ||
    next.scheduledDepartureMs + FERRY_CROSSING_ESTIMATE_MS;
  const arrivalBasis = observedArrivalMs
    ? 'observed-at-dock'
    : (existing.arrivalBasis === 'observed-at-dock' ? existing.arrivalBasis : (vessel?.etaMs ? 'wsf-eta' : (existing.arrivalBasis || 'scheduled-estimate')));
  const status = ferryHistoryTripStatus({ ...existing, ...next, actualDepartureMs, arrivalMs }, vessel, nowMs);
  const observation = vessel ? {
    observedAt: new Date(nowMs).toISOString(),
    vesselId: vessel.vesselId || null,
    vesselName: vessel.vesselName || next.vesselName || existing.vesselName || '',
    atDock: vessel.atDock ?? null,
    speed: vessel.speed ?? null,
    etaMs: vessel.etaMs || null,
    leftDockMs: vessel.leftDockMs || null,
    latitude: vessel.latitude ?? null,
    longitude: vessel.longitude ?? null,
  } : null;
  return {
    ...existing,
    ...next,
    space: mergeTripSpace(existing.space, next.space),
    departureSpace: mergeTripDepartureSpace(existing.departureSpace, existing.space, next.space, actualDepartureMs),
    vesselName: observedVesselName || persistedObservedVesselName || next.vesselName || vessel?.vesselName || '',
    vesselId: observedVesselId || persistedObservedVesselId || vessel?.vesselId || null,
    actualDepartureMs,
    arrivalMs,
    arrivalBasis,
    status,
    observations: [
      ...(Array.isArray(existing.observations) ? existing.observations : []),
      ...(observation ? [observation] : []),
    ].slice(-24),
  };
}

function mergeTripSpace(existing = {}, next = {}) {
  const hasNextSpace = next &&
    (Number.isFinite(next.driveUpSpaces) ||
     Number.isFinite(next.maxSpaces) ||
     next.hexColor);
  return hasNextSpace ? next : (existing || next || {});
}

function mergeTripDepartureSpace(existing = {}, existingSpace = {}, nextSpace = {}, actualDepartureMs = null) {
  if (hasTripSpace(existing)) return existing;
  if (!actualDepartureMs) return existing || {};
  const candidate = hasTripSpace(existingSpace) ? existingSpace : nextSpace;
  return hasTripSpace(candidate) ? { ...candidate } : (existing || {});
}

function hasTripSpace(space = {}) {
  return Boolean(space) &&
    (Number.isFinite(space.driveUpSpaces) ||
     Number.isFinite(space.maxSpaces) ||
     space.hexColor);
}

function tripsFromSchedule(date, direction, fromTerminal, toTerminal, schedule, spaceByDeparture = {}) {
  const times = schedule?.TerminalCombos?.[0]?.Times || [];
  return times
    .map(time => {
      const scheduledDepartureMs = parseDepartureMs(time);
      if (!scheduledDepartureMs || !tripBelongsToFerryHistoryDate(scheduledDepartureMs, date)) return null;
      const space = spaceByDeparture[String(scheduledDepartureMs)] || {};
      const vesselName = space.vesselName || time.VesselName || time.VesselNameOverride || '';
      return {
        id: tripId(date, direction, scheduledDepartureMs),
        date,
        direction,
        fromTerminalId: fromTerminal,
        toTerminalId: toTerminal,
        fromTerminalName: TERMINAL_NAMES.get(fromTerminal) || String(fromTerminal),
        toTerminalName: TERMINAL_NAMES.get(toTerminal) || String(toTerminal),
        scheduledDepartureMs,
        actualDepartureMs: null,
        arrivalMs: scheduledDepartureMs + FERRY_CROSSING_ESTIMATE_MS,
        arrivalBasis: 'scheduled-estimate',
        vesselName,
        vesselId: null,
        status: 'scheduled',
        space: {
          driveUpSpaces: space.driveUpSpaces ?? null,
          maxSpaces: space.maxSpaces ?? null,
          hexColor: space.hexColor ?? null,
        },
        observations: [],
      };
    })
    .filter(Boolean);
}

async function recordFerryHistoryDay(date = ferryHistoryDateForMs(), nowMs = Date.now()) {
  if (!isIsoDate(date)) throw new Error('date must be YYYY-MM-DD');
  const existing = readFerryHistoryDay(date);
  if (existing.sampledAtMs && nowMs - existing.sampledAtMs < FERRY_HISTORY_SAMPLE_INTERVAL_MS) {
    return existing;
  }

  const [clintonSchedule, clintonSpace, mukilteoSchedule, mukilteoSpace, vesselData] = await Promise.all([
    ferryScheduleDataForHistory('ferry_clinton', CONFIG.wsfDepartingTerminal, CONFIG.wsfArrivingTerminal),
    ferrySpaceDataForHistory('ferry_clinton_space', CONFIG.wsfDepartingTerminal, CONFIG.wsfArrivingTerminal),
    ferryScheduleDataForHistory('ferry_mukilteo', CONFIG.wsfArrivingTerminal, CONFIG.wsfDepartingTerminal),
    ferrySpaceDataForHistory('ferry_mukilteo_space', CONFIG.wsfArrivingTerminal, CONFIG.wsfDepartingTerminal),
    fetchFerryVesselsData(),
  ]);

  const scheduledTrips = [
    ...tripsFromSchedule(date, 'clinton-to-mukilteo', CONFIG.wsfDepartingTerminal, CONFIG.wsfArrivingTerminal, clintonSchedule, clintonSpace),
    ...tripsFromSchedule(date, 'mukilteo-to-clinton', CONFIG.wsfArrivingTerminal, CONFIG.wsfDepartingTerminal, mukilteoSchedule, mukilteoSpace),
  ];

  const vessels = Array.isArray(vesselData?.vessels) ? vesselData.vessels : [];
  const byId = new Map((existing.trips || []).map(trip => [trip.id, trip]));
  const assignmentTrips = scheduledTrips.map(scheduled => ({ ...byId.get(scheduled.id), ...scheduled }));
  const assignedVessels = assignVesselsToTrips(vessels, assignmentTrips, nowMs);
  for (const scheduled of scheduledTrips) {
    const existingTrip = byId.get(scheduled.id) || {};
    const vessel = assignedVessels.get(scheduled.id);
    byId.set(scheduled.id, mergeTripObservation(existingTrip, scheduled, vessel, nowMs));
  }

  const day = {
    date,
    operationalDay: ferryHistoryOperationalDay(date),
    generatedAt: new Date(nowMs).toISOString(),
    sampledAtMs: nowMs,
    retentionDays: FERRY_HISTORY_RETENTION_DAYS,
    trips: [...byId.values()]
      .filter(trip => trip.date === date)
      .sort((a, b) => a.scheduledDepartureMs - b.scheduledDepartureMs || a.direction.localeCompare(b.direction)),
    currentVessels: vessels,
    vesselSamples: mergeFerryVesselSamples(existing.vesselSamples, vessels, nowMs),
    errors: [clintonSchedule, clintonSpace, mukilteoSchedule, mukilteoSpace, vesselData]
      .map(value => value?.error)
      .filter(Boolean),
  };
  writeFerryHistoryDay(day);
  pruneFerryHistory(nowMs);
  return day;
}

app.get('/api/ferry/history', async (req, res) => {
  const date = String(req.query.date || ferryHistoryDateForMs()).trim();
  if (!isIsoDate(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  try {
    const today = ferryHistoryDateForMs();
    const day = date === today ? await recordFerryHistoryDay(date) : readFerryHistoryDay(date);
    res.json(day);
  } catch (e) {
    const existing = readFerryHistoryDay(date);
    res.status(existing.generatedAt ? 200 : 500).json({
      ...existing,
      error: e.message,
    });
  }
});

app.get('/api/ferry/departures', async (req, res) => {
  const date = String(req.query.date || ferryHistoryDateForMs()).trim();
  if (!isIsoDate(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  try {
    const today = ferryHistoryDateForMs();
    const day = date === today ? await recordFerryHistoryDay(date) : readFerryHistoryDay(date);
    const departures = ferryDepartureSummary(day);
    const missedDepartures = ferryMissedDepartureSummary(day);
    const vesselCorrections = ferryVesselCorrectionSummary(day, day.sampledAtMs || Date.now());
    const vesselStatuses = ferryVesselStatusSummary(day, day.sampledAtMs || Date.now());
    const predictedDepartures = ferryPredictedDepartureSummary(day, day.sampledAtMs || Date.now());
    const routeDelays = ferryRouteDelaySummary(day, day.sampledAtMs || Date.now());
    const resolvedVessels = ferryResolvedVesselSummary(day, day.sampledAtMs || Date.now(), { departures, predictedDepartures, vesselCorrections, vesselStatuses });
    res.json({
      date: day.date,
      generatedAt: day.generatedAt,
      sampledAtMs: day.sampledAtMs || null,
      departures,
      missedDepartures,
      vesselCorrections,
      vesselStatuses,
      predictedDepartures,
      resolvedVessels,
      resolvedSailings: ferryResolvedSailingSummary(day, day.sampledAtMs || Date.now(), { departures, missedDepartures, predictedDepartures, vesselCorrections, vesselStatuses, resolvedVessels, routeDelays }),
      routeDelays,
    });
  } catch (e) {
    const existing = readFerryHistoryDay(date);
    const departures = ferryDepartureSummary(existing);
    const missedDepartures = ferryMissedDepartureSummary(existing);
    const vesselCorrections = ferryVesselCorrectionSummary(existing, existing.sampledAtMs || Date.now());
    const vesselStatuses = ferryVesselStatusSummary(existing, existing.sampledAtMs || Date.now());
    const predictedDepartures = ferryPredictedDepartureSummary(existing, existing.sampledAtMs || Date.now());
    const routeDelays = ferryRouteDelaySummary(existing, existing.sampledAtMs || Date.now());
    const resolvedVessels = ferryResolvedVesselSummary(existing, existing.sampledAtMs || Date.now(), { departures, predictedDepartures, vesselCorrections, vesselStatuses });
    res.status(existing.generatedAt ? 200 : 500).json({
      date: existing.date,
      generatedAt: existing.generatedAt,
      sampledAtMs: existing.sampledAtMs || null,
      departures,
      missedDepartures,
      vesselCorrections,
      vesselStatuses,
      predictedDepartures,
      resolvedVessels,
      resolvedSailings: ferryResolvedSailingSummary(existing, existing.sampledAtMs || Date.now(), { departures, missedDepartures, predictedDepartures, vesselCorrections, vesselStatuses, resolvedVessels, routeDelays }),
      routeDelays,
      error: e.message,
    });
  }
});

app.get('/ferry-history', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'ferry-history.html'));
});

// ── Client config (feature flags, analytics ID) ──────────────────────
app.get('/api/config', (req, res) => {
  res.json({
    ferryHistorySampleMs: FERRY_HISTORY_SAMPLE_INTERVAL_MS,
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
  return formatCalendarDate(d).replace(/-/g, ''); // "YYYYMMDD"
}

// Hosting providers such as Railway inject the socket port at runtime.
// App settings still live in config.json; PORT is deployment plumbing.
const listenPort = Number(process.env.PORT || CONFIG.port);
app.listen(listenPort, () => {
  console.log(`Whidbey Dashboard running at http://localhost:${listenPort}`);
  const sample = () => {
    recordFerryHistoryDay().catch(e => console.warn(`[ferry-history] sample failed: ${e.message}`));
  };
  setTimeout(sample, 15 * 1000).unref?.();
  setInterval(sample, FERRY_HISTORY_SAMPLE_INTERVAL_MS).unref?.();
});
