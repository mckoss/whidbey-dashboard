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
    const [k, v] = line.split('=');
    if (k && v) process.env[k.trim()] = v.trim();
  }
} catch {}

const app = express();
const PORT = process.env.PORT || 3000;
const WSF_API_KEY = process.env.WSF_API_KEY || '';

// Config
const CONFIG = {
  // NOAA Hansville station (closest to south Whidbey)
  NOAA_STATION: '9445526',
  // Whidbey beach house coords (Clinton, WA)
  LAT: 47.9748,
  LON: -122.3534,
  // WSF terminal IDs (from API): Clinton=5, Mukilteo=14
  WSF_DEPARTING_TERMINAL: 5,   // Clinton (Whidbey side)
  WSF_ARRIVING_TERMINAL: 14,   // Mukilteo (mainland side)
  TIMEZONE: 'America/Los_Angeles',
};

app.use(express.static(join(__dirname, 'public')));

// --- Tides ---
app.get('/api/tides', async (req, res) => {
  try {
    const today = new Date();
    const begin = formatDate(today);
    const end = formatDate(new Date(today.getTime() + 3 * 86400000));
    const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` +
      `?begin_date=${begin}&end_date=${end}` +
      `&station=${CONFIG.NOAA_STATION}` +
      `&product=predictions&datum=MLLW&time_zone=lst_ldt` +
      `&interval=hilo&units=english&application=whidbey_dashboard&format=json`;
    const r = await fetch(url);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Weather (Open-Meteo, no key needed) ---
app.get('/api/weather', async (req, res) => {
  try {
    const url = `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${CONFIG.LAT}&longitude=${CONFIG.LON}` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,wind_direction_10m_dominant` +
      `&hourly=temperature_2m,weather_code,wind_speed_10m` +
      `&current=temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,relative_humidity_2m` +
      `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch` +
      `&timezone=${encodeURIComponent(CONFIG.TIMEZONE)}&forecast_days=3`;
    const r = await fetch(url);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Ferry Schedule (WSF) ---
app.get('/api/ferry', async (req, res) => {
  if (!WSF_API_KEY) {
    return res.json({ error: 'WSF_API_KEY not configured', sailings: [] });
  }
  try {
    const today = new Date().toISOString().split('T')[0];
    const url = `https://www.wsdot.wa.gov/ferries/api/schedule/rest/scheduletoday` +
      `/${CONFIG.WSF_DEPARTING_TERMINAL}/${CONFIG.WSF_ARRIVING_TERMINAL}/false` +
      `?apiaccesscode=${WSF_API_KEY}`;
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Ferry Wait Times (WSF Terminals) ---
app.get('/api/ferry/wait', async (req, res) => {
  if (!WSF_API_KEY) {
    return res.json({ error: 'WSF_API_KEY not configured' });
  }
  try {
    const url = `https://www.wsdot.wa.gov/ferries/api/terminals/rest/terminaldepartures` +
      `/${CONFIG.WSF_DEPARTING_TERMINAL}?apiaccesscode=${WSF_API_KEY}`;
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function formatDate(d) {
  return d.toISOString().split('T')[0].replace(/-/g, '');
}

app.listen(PORT, () => {
  console.log(`Whidbey Dashboard running at http://localhost:${PORT}`);
});
