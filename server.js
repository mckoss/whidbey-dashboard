import express from 'express';
import fetch from 'node-fetch';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env manually (no bundler)
try {
  const env = readFileSync(join(__dirname, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const [k, ...rest] = line.split('=');
    const v = rest.join('=');
    // Don't overwrite env vars already set (e.g. PORT passed via spawn)
    if (k && v && !process.env[k.trim()]) process.env[k.trim()] = v.trim();
  }
} catch {}

const app = express();
const PORT = process.env.PORT || 3000;
const WSF_API_KEY = process.env.WSF_API_KEY || '';

// Config
const CONFIG = {
  NOAA_STATION: '9445526',        // Hansville (closest to south Whidbey)
  LAT: 47.9748,
  LON: -122.3534,
  WSF_DEPARTING_TERMINAL: 5,      // Clinton (Whidbey side)
  WSF_ARRIVING_TERMINAL: 14,      // Mukilteo (mainland side)
  TIMEZONE: 'America/Los_Angeles',
};

// ── In-memory cache ────────────────────────────────────────────────────
const cache = {};

function getCached(key) {
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) return null;
  return entry;
}

function setCache(key, data, ttlMs) {
  cache[key] = { data, cachedAt: Date.now(), expiresAt: Date.now() + ttlMs, stale: false };
}

function getStale(key) {
  return cache[key] || null;
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

// ── Tides (hi/lo, 3 days) ─────────────────────────────────────────────
app.get('/api/tides', cachedEndpoint('tides', 60 * 60 * 1000, async () => {
  const today = new Date();
  const begin = formatDate(today);
  const end = formatDate(new Date(today.getTime() + 3 * 86400000));
  const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` +
    `?begin_date=${begin}&end_date=${end}` +
    `&station=${CONFIG.NOAA_STATION}` +
    `&product=predictions&datum=MLLW&time_zone=lst_ldt` +
    `&interval=hilo&units=english&application=whidbey_dashboard&format=json`;
  const r = await fetchWithRetry(url);
  return r.json();
}));

// ── Tides (hourly interpolated, 48h) — for sparkline graph ──────────────
// Station 9445526 is a subordinate station (hi/lo only).
// We generate smooth hourly points via cosine interpolation between hi/lo events.
app.get('/api/tides/hourly', cachedEndpoint('tides_hourly', 60 * 60 * 1000, async () => {
  const today = new Date();
  const begin = formatDate(today);
  const end = formatDate(new Date(today.getTime() + 3 * 86400000));
  const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` +
    `?begin_date=${begin}&end_date=${end}` +
    `&station=${CONFIG.NOAA_STATION}` +
    `&product=predictions&datum=MLLW&time_zone=lst_ldt` +
    `&interval=hilo&units=english&application=whidbey_dashboard&format=json`;
  const r = await fetchWithRetry(url);
  const data = await r.json();

  if (!data.predictions) return data; // pass through error

  // Cosine interpolation between hi/lo events → hourly points
  const events = data.predictions.map(p => ({
    t: new Date(p.t).getTime(),
    v: parseFloat(p.v),
  }));

  const predictions = [];
  const startDt = new Date(today);
  startDt.setMinutes(0, 0, 0);
  const startMs = startDt.getTime();
  const endMs = startMs + 48 * 3600 * 1000;

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
    const tStr = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')} ` +
      `${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`;
    predictions.push({ t: tStr, v: v.toFixed(3) });
  }

  return { predictions, interpolated: true };
}));

// ── Weather (Open-Meteo) ───────────────────────────────────────────────
app.get('/api/weather', cachedEndpoint('weather', 10 * 60 * 1000, async () => {
  const url = `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${CONFIG.LAT}&longitude=${CONFIG.LON}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,wind_direction_10m_dominant` +
    `&hourly=temperature_2m,weather_code,wind_speed_10m` +
    `&current=temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,relative_humidity_2m` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch` +
    `&timezone=${encodeURIComponent(CONFIG.TIMEZONE)}&forecast_days=3`;
  const r = await fetchWithRetry(url);
  return r.json();
}));

// ── Ferry Schedule (WSF) ───────────────────────────────────────────────
app.get('/api/ferry', cachedEndpoint('ferry', 5 * 60 * 1000, async () => {
  if (!WSF_API_KEY) return { error: 'WSF_API_KEY not configured', sailings: [] };
  const url = `https://www.wsdot.wa.gov/ferries/api/schedule/rest/scheduletoday` +
    `/${CONFIG.WSF_DEPARTING_TERMINAL}/${CONFIG.WSF_ARRIVING_TERMINAL}/false` +
    `?apiaccesscode=${WSF_API_KEY}`;
  const r = await fetchWithRetry(url, { headers: { Accept: 'application/json' } });
  return r.json();
}));

// ── Ferry Wait Times ───────────────────────────────────────────────────
app.get('/api/ferry/wait', cachedEndpoint('ferry_wait', 2 * 60 * 1000, async () => {
  if (!WSF_API_KEY) return { error: 'WSF_API_KEY not configured' };
  const url = `https://www.wsdot.wa.gov/ferries/api/terminals/rest/terminaldepartures` +
    `/${CONFIG.WSF_DEPARTING_TERMINAL}?apiaccesscode=${WSF_API_KEY}`;
  const r = await fetchWithRetry(url, { headers: { Accept: 'application/json' } });
  return r.json();
}));

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

function formatDate(d) {
  return d.toISOString().split('T')[0].replace(/-/g, '');
}

app.listen(PORT, () => {
  console.log(`Whidbey Dashboard running at http://localhost:${PORT}`);
});
