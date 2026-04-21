/**
 * Whidbey Dashboard — API test suite
 * Run with: node --test test/api.test.js
 *
 * Requires a running server on localhost:3000.
 * Start it first: npm start &
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = 'http://localhost:3001'; // use 3001 to avoid conflicting with running server
let serverProcess;

// ── Server lifecycle ───────────────────────────────────────────────────
before(async () => {
  serverProcess = spawn('node', [join(__dirname, '../server.js')], {
    env: { ...process.env, PORT: '3001' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout.on('data', d => process.stdout.write(`[server] ${d}`));
  serverProcess.stderr.on('data', d => process.stderr.write(`[server] ${d}`));

  // Wait for server to be ready
  for (let i = 0; i < 30; i++) {
    try {
      await fetch(`${BASE}/api/weather`);
      break;
    } catch {
      await sleep(300);
    }
  }
  console.log('Test server ready on port 3001');
});

after(async () => {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    await sleep(500);
  }
});

// ── Helpers ────────────────────────────────────────────────────────────
async function getJson(path) {
  const res = await fetch(`${BASE}${path}`);
  assert.ok(res.ok, `HTTP ${res.status} for ${path}`);
  return res.json();
}

// ── Tests ──────────────────────────────────────────────────────────────

test('weather endpoint — returns current temperature and 3-day forecast', async () => {
  const d = await getJson('/api/weather');

  // current conditions
  assert.ok(d.current, 'has current object');
  assert.ok(typeof d.current.temperature_2m === 'number', 'current.temperature_2m is a number');
  assert.ok(d.current.temperature_2m > -50 && d.current.temperature_2m < 150,
    `temperature ${d.current.temperature_2m}°F is in plausible range`);
  assert.ok(typeof d.current.weather_code === 'number', 'current.weather_code is a number');

  // daily forecast
  assert.ok(d.daily, 'has daily object');
  assert.ok(Array.isArray(d.daily.time), 'daily.time is array');
  assert.ok(d.daily.time.length >= 3, `at least 3 forecast days (got ${d.daily.time.length})`);
  assert.ok(Array.isArray(d.daily.temperature_2m_max), 'daily.temperature_2m_max is array');
  assert.ok(Array.isArray(d.daily.temperature_2m_min), 'daily.temperature_2m_min is array');
  assert.ok(d.daily.temperature_2m_max[0] >= d.daily.temperature_2m_min[0],
    'daily max >= daily min');
});

test('tides endpoint — returns predictions array with H/L types', async () => {
  const d = await getJson('/api/tides');

  assert.ok(d.predictions, 'has predictions array');
  assert.ok(Array.isArray(d.predictions), 'predictions is array');
  assert.ok(d.predictions.length >= 4, `at least 4 predictions (got ${d.predictions.length})`);

  for (const p of d.predictions.slice(0, 4)) {
    // type must be H or L
    assert.ok(p.type === 'H' || p.type === 'L', `type is H or L (got ${p.type})`);
    // value is numeric
    const v = parseFloat(p.v);
    assert.ok(!isNaN(v), `tide value is numeric (got ${p.v})`);
    assert.ok(v > -5 && v < 30, `tide height ${v} ft is in plausible range`);
    // time string is present
    assert.ok(p.t && typeof p.t === 'string', `tide has time string (got ${p.t})`);
  }
});

test('tides/hourly endpoint — returns hourly predictions', async () => {
  const d = await getJson('/api/tides/hourly');

  assert.ok(d.predictions, 'has predictions array');
  assert.ok(Array.isArray(d.predictions), 'predictions is array');
  assert.ok(d.predictions.length >= 24, `at least 24 hourly points (got ${d.predictions.length})`);

  // hourly predictions have numeric values
  const v = parseFloat(d.predictions[0].v);
  assert.ok(!isNaN(v), 'first prediction has numeric value');
});

// ── Ferry schedule helper ──────────────────────────────────────────────
function assertFerrySchedule(d, label) {
  if (d.error === 'WSF_API_KEY not configured') {
    console.log(`  (skipping ${label} assertions — WSF_API_KEY not set)`);
    return false;
  }
  assert.ok(!d.error, `no error in ${label} response (got: ${d.error})`);
  assert.ok(d.TerminalCombos, `${label} has TerminalCombos`);
  assert.ok(Array.isArray(d.TerminalCombos), `${label} TerminalCombos is array`);
  assert.ok(d.TerminalCombos.length > 0, `${label} has at least one terminal combo`);
  const combo = d.TerminalCombos[0];
  assert.ok(combo.Times && Array.isArray(combo.Times) && combo.Times.length > 0,
    `${label} has Times array with entries`);
  const firstTime = combo.Times[0].DepartingTime || combo.Times[0].DepartureTime || '';
  assert.ok(firstTime, `${label} first sailing has time field`);
  assert.match(firstTime, /\/Date\(\d+/, `${label} time is in .NET JSON date format`);
  return true;
}

test('ferry/clinton endpoint — Clinton→Mukilteo schedule', async () => {
  const d = await getJson('/api/ferry/clinton');
  assertFerrySchedule(d, 'clinton ferry');
});

test('ferry/mukilteo endpoint — Mukilteo→Clinton schedule', async () => {
  const d = await getJson('/api/ferry/mukilteo');
  assertFerrySchedule(d, 'mukilteo ferry');
});

test('ferry/clinton/space endpoint — vessel name and capacity per sailing', async () => {
  const d = await getJson('/api/ferry/clinton/space');
  if (d.error === 'WSF_API_KEY not configured') {
    console.log('  (skipping clinton space assertions — WSF_API_KEY not set)');
    return;
  }
  assert.ok(typeof d === 'object', 'returns an object');
  const keys = Object.keys(d);
  assert.ok(keys.length > 0, 'has at least one departure entry');
  // Keys should be ms timestamps (all digits)
  assert.ok(keys.every(k => /^\d+$/.test(k)), 'keys are numeric ms timestamps');
  const first = d[keys[0]];
  assert.ok(typeof first.vesselName === 'string' && first.vesselName.length > 0,
    `vesselName is a non-empty string (got: ${first.vesselName})`);
  assert.ok(typeof first.maxSpaces === 'number' && first.maxSpaces > 0,
    `maxSpaces is a positive number (got: ${first.maxSpaces})`);
  assert.ok(first.driveUpSpaces === null || typeof first.driveUpSpaces === 'number',
    `driveUpSpaces is null or number (got: ${first.driveUpSpaces})`);
  if (first.driveUpSpaces !== null) {
    assert.ok(first.driveUpSpaces >= 0 && first.driveUpSpaces <= first.maxSpaces,
      `driveUpSpaces (${first.driveUpSpaces}) is between 0 and maxSpaces (${first.maxSpaces})`);
  }
});

test('ferry/mukilteo/space endpoint — vessel name and capacity per sailing', async () => {
  const d = await getJson('/api/ferry/mukilteo/space');
  if (d.error === 'WSF_API_KEY not configured') {
    console.log('  (skipping mukilteo space assertions — WSF_API_KEY not set)');
    return;
  }
  assert.ok(typeof d === 'object', 'returns an object');
  const keys = Object.keys(d);
  assert.ok(keys.length > 0, 'has at least one departure entry');
  assert.ok(keys.every(k => /^\d+$/.test(k)), 'keys are numeric ms timestamps');
});

test('ferry legacy alias — /api/ferry still works', async () => {
  const d = await getJson('/api/ferry');
  // Should return same shape as /api/ferry/clinton
  if (d.error === 'WSF_API_KEY not configured') {
    console.log('  (skipping legacy ferry alias — WSF_API_KEY not set)');
    return;
  }
  assert.ok(!d.error, 'no error in legacy ferry response');
  assert.ok(d.TerminalCombos, 'legacy alias returns TerminalCombos');
});

test('cache-status endpoint — returns cache metadata', async () => {
  const d = await getJson('/api/cache-status');
  // After above tests ran, we should have weather and tides cached
  assert.ok(typeof d === 'object', 'returns an object');
  // At minimum weather should be cached
  assert.ok('weather' in d, 'weather key in cache status');
  assert.ok(d.weather.cachedAt, 'weather has cachedAt');
  assert.ok(d.weather.expiresAt, 'weather has expiresAt');
  assert.ok(d.weather.expired === false, 'weather is not expired');
});

test('static HTML — index.html contains required elements', async () => {
  const res = await fetch(`${BASE}/`);
  assert.ok(res.ok, 'index.html responds OK');
  const html = await res.text();

  assert.ok(html.includes('id="clock"'), 'has #clock element');
  assert.ok(html.includes('id="weather"'), 'has #weather element');
  assert.ok(html.includes('id="tides"'), 'has #tides element');
  assert.ok(html.includes('id="ferry"'), 'has #ferry container');
  // Two-panel layout
  assert.ok(html.includes('id="ferry-clinton"'), 'has #ferry-clinton panel');
  assert.ok(html.includes('id="ferry-mukilteo"'), 'has #ferry-mukilteo panel');
  assert.ok(html.includes('Whidbey'), 'mentions Whidbey');
});

test('weather endpoint — second request is served from cache', async () => {
  // First request populates cache, second should be faster
  const t0 = Date.now();
  await getJson('/api/weather');
  const t1 = Date.now();
  await getJson('/api/weather');
  const t2 = Date.now();

  const firstMs = t1 - t0;
  const cachedMs = t2 - t1;
  console.log(`  First: ${firstMs}ms, Cached: ${cachedMs}ms`);
  // Cached response should be much faster (< 100ms vs potentially 500ms+)
  assert.ok(cachedMs < firstMs || cachedMs < 100,
    `cached response (${cachedMs}ms) should be fast`);
});
