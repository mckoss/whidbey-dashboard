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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import vm from 'node:vm';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = 'http://localhost:3001'; // use 3001 to avoid conflicting with running server
let serverProcess;
let dataDir;

// ── Server lifecycle ───────────────────────────────────────────────────
before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'whidbey-dashboard-test-'));
  const configFile = join(dataDir, 'config.json');
  await writeFile(configFile, JSON.stringify({
    port: 3001,
    dataDir,
    googleClientId: 'test-google-client-id',
    adminUsers: ['mike@example.com'],
    adminTestTokens: {
      'valid-admin-token': 'mike@example.com',
      'unauthorized-admin-token': 'someone@example.com',
    },
    sessionSecret: 'test-session-secret-for-admin-cookies',
  }, null, 2));

  serverProcess = spawn('node', [join(__dirname, '../server.js')], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      CONFIG_FILE: configFile,
    },
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
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

// ── Helpers ────────────────────────────────────────────────────────────
async function getJson(path) {
  const res = await fetch(`${BASE}${path}`);
  assert.ok(res.ok, `HTTP ${res.status} for ${path}`);
  return res.json();
}

async function getJsonAllowError(path) {
  const res = await fetch(`${BASE}${path}`);
  return res.json();
}

async function getJsonWithToken(path, token = '') {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { headers });
  const data = await res.json();
  return { res, data };
}

async function sendJson(path, method, body, token = '', cookie = '') {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { res, data };
}

function pacificDate(date = new Date()) {
  return date.toLocaleString('sv-SE', { timeZone: 'America/Los_Angeles' }).slice(0, 10);
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
  if (d.error === 'WSF API key not configured') {
    console.log(`  (skipping ${label} assertions — WSF API key not set)`);
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
  const d = await getJsonAllowError('/api/ferry/clinton/space');
  if (d.error === 'WSF API key not configured') {
    console.log('  (skipping clinton space assertions — WSF API key not set)');
    return;
  }
  if (d.error) {
    console.log(`  (skipping clinton space assertions — upstream WSDOT error: ${d.error})`);
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
  const d = await getJsonAllowError('/api/ferry/mukilteo/space');
  if (d.error === 'WSF API key not configured') {
    console.log('  (skipping mukilteo space assertions — WSF API key not set)');
    return;
  }
  if (d.error) {
    console.log(`  (skipping mukilteo space assertions — upstream WSDOT error: ${d.error})`);
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
  if (d.error === 'WSF API key not configured') {
    console.log('  (skipping legacy ferry alias — WSF API key not set)');
    return;
  }
  assert.ok(!d.error, 'no error in legacy ferry response');
  assert.ok(d.TerminalCombos, 'legacy alias returns TerminalCombos');
});

test('ferry/alerts endpoint — returns normalized route alerts', async () => {
  const d = await getJson('/api/ferry/alerts');
  if (d.error === 'WSF API key not configured') {
    console.log('  (skipping ferry alerts assertions — WSF API key not set)');
    return;
  }
  assert.ok(Array.isArray(d.alerts), 'alerts is an array');
  for (const alert of d.alerts) {
    assert.ok(alert.id, 'alert has id');
    assert.ok(typeof alert.title === 'string', 'alert has normalized title');
    assert.ok(!alert.title.includes('<'), 'alert title is plain text');
    assert.ok(!alert.text.includes('<'), 'alert text is plain text');
    assert.ok(typeof alert.additionalInfo === 'string', 'alert has deterministic additionalInfo string');
    assert.ok(!alert.additionalInfo.includes('<'), 'alert additionalInfo is plain text');
    assert.doesNotMatch(alert.title, /^(?:all routes|(?:[a-z]+\/[a-z]+)(?:\s+[a-z]+\/[a-z]+)*)\s*[-–—:]+/i, 'alert title does not expose WSF route prefix');
    assert.doesNotMatch(alert.text, /^(?:all routes|(?:[a-z]+\/[a-z]+)(?:\s+[a-z]+\/[a-z]+)*)\s*[-–—:]+/i, 'alert text does not expose WSF route prefix');
    assert.ok(
      alert.allRoutes || alert.affectedRouteIds?.includes(7),
      `alert applies to Mukilteo/Clinton route 7 or all routes: ${alert.title}`
    );
  }
});

test('ferry/vessels endpoint — normalized vessel location data', async () => {
  const d = await getJson('/api/ferry/vessels');
  if (d.error === 'WSF API key not configured') {
    console.log('  (skipping vessel assertions — WSF API key not set)');
    return;
  }
  assert.ok(Array.isArray(d.vessels), 'vessels is an array');
  for (const v of d.vessels) {
    assert.ok(typeof v.vesselName === 'string' && v.vesselName.length > 0, 'vessel has name');
    assert.ok(typeof v.atDock === 'boolean', 'vessel has atDock boolean');
    assert.ok(typeof v.inService === 'boolean', 'vessel has inService boolean');
    assert.ok(v.departingTerminalId === 5 || v.departingTerminalId === 14 || v.arrivingTerminalId === 5 || v.arrivingTerminalId === 14,
      'vessel is associated with Clinton/Mukilteo route');
  }
});

test('ferry/history endpoint — returns a dated trip log shell and validates date parameter', async () => {
  const today = pacificDate();
  const d = await getJson(`/api/ferry/history?date=${today}`);
  assert.equal(d.date, today, 'returns requested Pacific date');
  assert.ok(Array.isArray(d.trips), 'history has trips array');
  assert.ok(Array.isArray(d.currentVessels), 'history has current vessel array');
  assert.ok(Array.isArray(d.vesselSamples), 'history has raw vessel GPS samples array');
  assert.equal(d.operationalDay?.startHour, 2, 'history file carries its own operational-day start hour');
  assert.equal(d.operationalDay?.timezone, 'America/Los_Angeles', 'history file carries its own operational-day timezone');
  assert.ok(Number.isFinite(d.operationalDay?.startMs), 'history file carries its own start timestamp');
  assert.ok(Number.isFinite(d.operationalDay?.endMs), 'history file carries its own end timestamp');
  assert.equal(d.operationalDay.endMs - d.operationalDay.startMs, 24 * 60 * 60 * 1000, 'history file defines a 24-hour span');
  assert.equal(d.retentionDays, 30, 'uses default 30-day retention');

  const bad = await fetch(`${BASE}/api/ferry/history?date=today`);
  assert.equal(bad.status, 400, 'rejects non-ISO dates');
  const badBody = await bad.json();
  assert.match(badBody.error, /YYYY-MM-DD/, 'explains date format');

  const source = await readFile(join(__dirname, '../server.js'), 'utf8');
  assert.match(source, /ferryHistoryDayStartHour: Number\(configValue\('ferryHistoryDayStartHour', 2\)\)/, 'defines ferry history day boundary once in server config');
  assert.match(source, /function ferryHistoryDateForMs/, 'uses an operational history date instead of raw calendar date');
  assert.match(source, /function ferryHistoryOperationalDay/, 'stores the operational-day span in each history response');
  assert.match(source, /operationalDay: ferryHistoryOperationalDay\(date\)/, 'history files are self-describing about their day span');
  assert.match(source, /tripBelongsToFerryHistoryDate\(scheduledDepartureMs, date\)/, 'assigns trips by 2 AM history-day window');
  assert.match(source, /req\.query\.date \|\| ferryHistoryDateForMs\(\)/, 'history API default date follows the 2 AM boundary');
  assert.match(source, /function mergeTripSpace/, 'preserves captured WSF vehicle-space counts in history rows');
  assert.match(source, /space: mergeTripSpace\(existing\.space, next\.space\)/, 'does not wipe old non-null space counts when the WSF space feed drops past sailings');
  assert.match(source, /function mergeTripDepartureSpace/, 'freezes vehicle-space data once a departure is observed');
  assert.match(source, /departureSpace: mergeTripDepartureSpace\(existing\.departureSpace, existing\.space, next\.space, actualDepartureMs\)/, 'persists a departure-time space snapshot separately from the latest schedule space');
  assert.match(source, /departureSpace: hasTripSpace\(trip\.departureSpace\) \? trip\.departureSpace : null/, 'normalizes empty departure-space snapshots away');
  assert.match(source, /function applyGpsDepartureSpaceSnapshots/, 'freezes vehicle-space data from GPS-observed table departures');
  assert.match(source, /const observations = ferryGpsScheduleObservations\(day\)/, 'uses the same GPS schedule allocation path for departure-space snapshots');
  assert.match(source, /observedDepartureMs: departure\.ms/, 'stores the GPS-observed departure time with the frozen vehicle-space snapshot');
  assert.match(source, /applyGpsDepartureSpaceSnapshots\(day\)/, 'applies departure-space snapshots before writing history files');
  assert.match(source, /writeFerryHistoryDay\(day\)/, 'writes the enriched history day to disk');
  assert.match(source, /const tmpFile = `\$\{file\}\.\$\{process\.pid\}\.\$\{Date\.now\(\)\}\.tmp`/, 'writes history files through a temp file first');
  assert.match(source, /renameSync\(tmpFile, file\)/, 'atomically replaces the durable history file after the write completes');
});

test('bainbridge ferry endpoints — use separate route metadata and history storage', async () => {
  const historyDate = '2026-06-30';
  const d = await getJson(`/api/bainbridge/ferry/history?date=${historyDate}`);

  assert.equal(d.date, historyDate, 'Bainbridge history date matches request');
  assert.equal(d.routeKey, 'bainbridge', 'Bainbridge history is tagged with the experimental route');
  assert.equal(d.route.apiPrefix, '/api/bainbridge/ferry', 'Bainbridge history points clients at the Bainbridge API');
  assert.equal(d.route.terminals.primary.name, 'Seattle', 'Bainbridge primary terminal is Seattle');
  assert.equal(d.route.terminals.primary.id, 7, 'Bainbridge primary terminal uses the WSF Seattle terminal ID');
  assert.equal(d.route.terminals.primary.lat, 47.602501, 'Bainbridge primary terminal uses the Seattle terminal latitude, not Bremerton');
  assert.equal(d.route.terminals.secondary.name, 'Bainbridge Island', 'Bainbridge secondary terminal is Bainbridge Island');
  assert.equal(d.route.weatherLabel, 'Bainbridge Island, WA', 'Bainbridge dashboard labels local weather correctly');
  assert.equal(d.route.tideLabel, 'Seattle', 'Bainbridge dashboard labels the closest NOAA tide station');
  assert.equal(d.route.weatherPath, '/api/bainbridge/ferry/weather', 'Bainbridge dashboard has a separate weather endpoint');
  assert.equal(d.route.tidesPath, '/api/bainbridge/ferry/tides', 'Bainbridge dashboard has a separate tide endpoint');
  assert.equal(d.route.historyDisplay.leftTerminalSlug, 'bainbridge', 'Bainbridge history renders west terminal on the left');
  assert.equal(d.route.historyDisplay.rightTerminalSlug, 'seattle', 'Bainbridge history renders east terminal on the right');
  assert.deepEqual(d.route.historyDisplay.terminalLabelLines.bainbridge, ['Bainbridge', 'Island'], 'Bainbridge Island history label wraps to two lines');

  const departures = await getJson(`/api/bainbridge/ferry/departures?date=${historyDate}`);
  assert.equal(departures.date, historyDate, 'Bainbridge departures date matches request');
  assert.deepEqual(departures.departures, {}, 'empty Bainbridge history has no observed departures');

  const source = await readFile(join(__dirname, '../server.js'), 'utf8');
  assert.match(source, /function routeHasBothTerminals/, 'filters ferry vessels by both route terminals');
  assert.match(source, /\.filter\(v => routeHasBothTerminals\(v, route\)\)/, 'Bainbridge vessel state cannot admit Seattle-Bremerton boats that only share Seattle');
  assert.match(source, /if \(alert\.AllRoutesFlag\) return true;/,
    'all-routes WSF alerts still appear on both ferry dashboards');
  assert.match(source, /return routeIds\.includes\(route\.routeId\);/,
    'route-specific WSF alerts only appear on dashboards for that WSF route');

  const historyHtml = await readFile(join(__dirname, '../public/ferry-history.html'), 'utf8');
  assert.match(historyHtml, /const LEFT_TERMINAL = TERMINALS_BY_SLUG\.get\(HISTORY_DISPLAY\.leftTerminalSlug\) \|\| PRIMARY_TERMINAL;/,
    'history SVG supports a route-specific left terminal');
  assert.match(historyHtml, /displayProgressPct\(point\.pct\)/,
    'history SVG reverses GPS track coordinates when display order differs from data order');
});

test('bainbridge ferry history — excludes saved Bremerton vessel samples', async () => {
  const historyDate = '2026-07-01';
  const sampledAtMs = Date.UTC(2026, 6, 1, 16, 0);
  const historyDir = join(dataDir, 'ferry-history-bainbridge');
  await mkdir(historyDir, { recursive: true });
  await writeFile(join(historyDir, `${historyDate}.json`), JSON.stringify({
    date: historyDate,
    routeKey: 'bainbridge',
    generatedAt: new Date(sampledAtMs).toISOString(),
    sampledAtMs,
    trips: [],
    currentVessels: [],
    vesselSamples: [
      ferryTestSample(Date.UTC(2026, 6, 1, 15, 50), 'Tacoma', 37, 0.35, {
        departingTerminalId: 3,
        arrivingTerminalId: 7,
      }),
      ferryTestSample(Date.UTC(2026, 6, 1, 15, 55), 'Tacoma', 37, 0.45, {
        departingTerminalId: 3,
        arrivingTerminalId: 7,
      }),
      ferryTestSample(Date.UTC(2026, 6, 1, 15, 50), 'Puyallup', 30, 0.35, {
        departingTerminalId: 4,
        arrivingTerminalId: 7,
      }),
      ferryTestSample(Date.UTC(2026, 6, 1, 15, 55), 'Chimacum', 32, 0.45, {
        departingTerminalId: 7,
        arrivingTerminalId: 4,
      }),
    ],
  }, null, 2));

  const d = await getJson(`/api/bainbridge/ferry/history?date=${historyDate}`);
  const vesselNames = new Set(d.vesselSamples.map(sample => sample.vesselName));
  assert.ok(vesselNames.has('Tacoma'), 'keeps saved Seattle-Bainbridge vessel samples');
  assert.ok(!vesselNames.has('Puyallup'), 'drops saved Seattle-Bremerton vessel samples from Bainbridge history');
  assert.ok(!vesselNames.has('Chimacum'), 'drops saved Seattle-Bremerton vessel samples from Bainbridge legend data');

  const source = await readFile(join(__dirname, '../server.js'), 'utf8');
  assert.match(source, /function filterFerrySamplesForRoute/, 'normalizes historical vessel samples through route filtering');
  assert.match(source, /vesselSamples: filterFerrySamplesForRoute\(day\.vesselSamples, route\)/,
    'history responses do not expose saved off-route vessel samples to the legend');
});

test('ferry/history endpoint — ignores impossible early actual departures from stale vessel matches', async () => {
  const historyDate = '2026-06-08';
  const scheduledDepartureMs = Date.UTC(2026, 5, 8, 20, 0);
  const staleActualDepartureMs = scheduledDepartureMs - 55 * 60 * 1000;
  const historyDir = join(dataDir, 'ferry-history');
  await mkdir(historyDir, { recursive: true });
  await writeFile(join(historyDir, `${historyDate}.json`), JSON.stringify({
    date: historyDate,
    generatedAt: '2026-06-08T20:30:00.000Z',
    trips: [{
      id: `${historyDate}:clinton-to-mukilteo:${scheduledDepartureMs}`,
      date: historyDate,
      direction: 'clinton-to-mukilteo',
      fromTerminalId: 5,
      toTerminalId: 14,
      fromTerminalName: 'Clinton',
      toTerminalName: 'Mukilteo',
      scheduledDepartureMs,
      actualDepartureMs: staleActualDepartureMs,
      arrivalMs: scheduledDepartureMs + 5 * 60 * 1000,
      arrivalBasis: 'observed-at-dock',
      vesselName: 'Tokitae',
      status: 'arrived',
      observations: [],
    }, {
      id: `${historyDate}:mukilteo-to-clinton:${scheduledDepartureMs}`,
      date: historyDate,
      direction: 'mukilteo-to-clinton',
      fromTerminalId: 14,
      toTerminalId: 5,
      fromTerminalName: 'Mukilteo',
      toTerminalName: 'Clinton',
      scheduledDepartureMs,
      actualDepartureMs: scheduledDepartureMs + 2 * 60 * 1000,
      arrivalMs: scheduledDepartureMs + 20 * 60 * 1000,
      arrivalBasis: 'observed-at-dock',
      vesselName: 'Suquamish',
      status: 'in-progress',
      observations: [],
    }],
    currentVessels: [],
  }, null, 2));

  const d = await getJson(`/api/ferry/history?date=${historyDate}`);
  assert.equal(d.trips[0].actualDepartureMs, null, 'drops actual departure that predates schedule by too much');
  assert.equal(d.trips[0].arrivalBasis, 'scheduled-estimate', 'restores schedule-only arrival basis');
  assert.equal(d.trips[0].arrivalMs, scheduledDepartureMs + 20 * 60 * 1000, 'restores normal crossing estimate');
  assert.equal(d.trips[0].status, 'scheduled-past', 'stale match is no longer labeled underway or arrived');
  assert.equal(d.trips[1].status, 'completed', 'finished observed trip is not left labeled underway');
});

test('ferry/history recorder — matches swapped underway vessels with blank WSF arrival terminal', async () => {
  const source = await readFile(join(__dirname, '../server.js'), 'utf8');
  assert.match(source, /function vesselDirectionMatchesTrip/, 'centralizes trip direction matching');
  assert.match(source, /function vesselMatchPriority/, 'ranks competing vessel matches by signal quality');
  assert.match(source, /a\.priority - b\.priority \|\| a\.score - b\.score/,
    'moving left-dock GPS evidence outranks a scheduled vessel still sitting at the dock');
  assert.match(source, /function mergeFerryVesselSamples/, 'persists raw vessel GPS samples outside scheduled trips');
  assert.match(source, /const vesselSamples = mergeFerryVesselSamples\(existing\.vesselSamples, vessels, nowMs\)/,
    'records raw vessel GPS samples for the history graph independent of trip matching');
  assert.match(source, /!vessel\.atDock &&[\s\S]*?vessel\.leftDockMs &&[\s\S]*?!vessel\.arrivingTerminalId/,
    'allows underway vessels with blank arriving terminal to match by departure terminal and left-dock time');
  assert.match(source, /vesselProvidedDeparture && vessel\?\.vesselName/,
    'uses live left-dock telemetry to replace stale schedule-assigned vessel names');
  assert.match(source, /observedVesselForTrip\(existing, actualDepartureMs\)/,
    'keeps the observed vessel name on later samples so live dots can attach to trail lines');
  assert.doesNotMatch(source, /ferryReturningStatus\(track, latest, 'insufficient-gps-motion'\)/,
    'does not label a vessel returning just because recent GPS motion is missing');
  assert.match(source, /expectedSign && motionSign !== 0 && motionSign !== expectedSign/,
    'returning requires active motion away from the expected destination');
  assert.match(source, /if \(motionSign === 0\) continue;/,
    'idle or dock-adjacent vessels are not treated as returning');
});

test('ferry/history endpoint — normalizes stale scheduled vessel names from observations', async () => {
  const historyDate = '2026-06-07';
  const scheduledDepartureMs = Date.UTC(2026, 5, 8, 4, 0); // Jun 7 9:00 PM PDT
  const actualDepartureMs = scheduledDepartureMs + 23 * 1000;
  const historyDir = join(dataDir, 'ferry-history');
  await mkdir(historyDir, { recursive: true });
  await writeFile(join(historyDir, `${historyDate}.json`), JSON.stringify({
    date: historyDate,
    generatedAt: '2026-06-08T04:20:00.000Z',
    trips: [{
      id: `${historyDate}:mukilteo-to-clinton:${scheduledDepartureMs}`,
      date: historyDate,
      direction: 'mukilteo-to-clinton',
      fromTerminalId: 14,
      toTerminalId: 5,
      fromTerminalName: 'Mukilteo',
      toTerminalName: 'Clinton',
      scheduledDepartureMs,
      actualDepartureMs,
      arrivalMs: scheduledDepartureMs + 16 * 60 * 1000,
      arrivalBasis: 'wsf-eta',
      vesselName: 'Tokitae',
      vesselId: 75,
      status: 'completed',
      observations: [{
        observedAt: '2026-06-08T04:15:00.000Z',
        vesselId: 75,
        vesselName: 'Suquamish',
        atDock: false,
        speed: 6.7,
        leftDockMs: actualDepartureMs,
        latitude: 47.96,
        longitude: -122.33,
      }],
    }],
    currentVessels: [],
  }, null, 2));

  const d = await getJson(`/api/ferry/history?date=${historyDate}`);
  assert.equal(d.trips[0].vesselName, 'Suquamish', 'uses observed vessel name instead of stale schedule name');
  assert.equal(d.trips[0].vesselId, 75, 'keeps the observed vessel id');
});

test('ferry/departures endpoint — exposes server-confirmed actual departures by schedule key', async () => {
  const historyDate = '2026-06-06';
  const scheduledDepartureMs = Date.UTC(2026, 5, 6, 15, 0);
  const actualDepartureMs = scheduledDepartureMs + 4 * 60 * 1000;
  const futureDepartureMs = Date.UTC(2026, 5, 6, 15, 35);
  const historyDir = join(dataDir, 'ferry-history');
  await mkdir(historyDir, { recursive: true });
  await writeFile(join(historyDir, `${historyDate}.json`), JSON.stringify({
    date: historyDate,
    generatedAt: '2026-06-06T15:10:00.000Z',
    sampledAtMs: Date.UTC(2026, 5, 6, 15, 20),
    trips: [{
      id: `${historyDate}:clinton-to-mukilteo:${scheduledDepartureMs}`,
      date: historyDate,
      direction: 'clinton-to-mukilteo',
      fromTerminalId: 5,
      toTerminalId: 14,
      fromTerminalName: 'Clinton',
      toTerminalName: 'Mukilteo',
      scheduledDepartureMs,
      actualDepartureMs,
      arrivalMs: actualDepartureMs + 20 * 60 * 1000,
      arrivalBasis: 'scheduled-estimate',
      vesselName: 'Suquamish',
      vesselId: 123,
      observations: [],
    }, {
      id: `${historyDate}:mukilteo-to-clinton:${futureDepartureMs}`,
      date: historyDate,
      direction: 'mukilteo-to-clinton',
      fromTerminalId: 14,
      toTerminalId: 5,
      fromTerminalName: 'Mukilteo',
      toTerminalName: 'Clinton',
      scheduledDepartureMs: futureDepartureMs,
      actualDepartureMs: null,
      arrivalMs: futureDepartureMs + 20 * 60 * 1000,
      arrivalBasis: 'scheduled-estimate',
      vesselName: 'Scheduled Boat',
      vesselId: null,
      observations: [],
    }],
    currentVessels: [],
  }, null, 2));

  const d = await getJson(`/api/ferry/departures?date=${historyDate}`);
  const key = `5:${scheduledDepartureMs}`;
  assert.equal(d.departures[key].departed, true, 'marks the scheduled sailing departed');
  assert.equal(d.departures[key].actualDepartureMs, actualDepartureMs, 'exposes server-confirmed departure time');
  assert.equal(d.departures[key].delayMs, 4 * 60 * 1000, 'exposes schedule-relative delay');
  assert.equal(d.departures[key].vesselName, 'Suquamish', 'carries vessel identity from history');
  const correctionKey = `14:${futureDepartureMs}`;
  assert.equal(d.vesselCorrections[correctionKey].vesselName, 'Suquamish', 'feeds recent GPS-confirmed vessel identity forward to the next schedule row');
  assert.equal(d.vesselCorrections[correctionKey].basis, 'recent-gps-chain', 'labels vessel corrections separately from departed sailings');
});

test('ferry/departures endpoint — GPS-chain corrections never assign one vessel to simultaneous terminal departures', async () => {
  const historyDate = '2026-06-24';
  const sampledAtMs = Date.UTC(2026, 5, 24, 22, 15);
  const m1505 = Date.UTC(2026, 5, 24, 22, 5);
  const c1535 = Date.UTC(2026, 5, 24, 22, 35);
  const m1535 = Date.UTC(2026, 5, 24, 22, 35);
  const m1605 = Date.UTC(2026, 5, 24, 23, 5);
  const historyDir = join(dataDir, 'ferry-history');
  await mkdir(historyDir, { recursive: true });
  await writeFile(join(historyDir, `${historyDate}.json`), JSON.stringify({
    date: historyDate,
    generatedAt: new Date(sampledAtMs).toISOString(),
    sampledAtMs,
    trips: [
      ferryTestTrip(historyDate, 'mukilteo-to-clinton', 14, 5, m1505, {
        actualDepartureMs: m1505 + 4 * 60 * 1000,
        vesselName: 'Suquamish',
        vesselId: 75,
      }),
      ferryTestTrip(historyDate, 'clinton-to-mukilteo', 5, 14, c1535),
      ferryTestTrip(historyDate, 'mukilteo-to-clinton', 14, 5, m1535),
      ferryTestTrip(historyDate, 'mukilteo-to-clinton', 14, 5, m1605),
    ],
    currentVessels: [],
  }, null, 2));

  const d = await getJson(`/api/ferry/departures?date=${historyDate}`);
  assert.equal(d.vesselCorrections[`5:${c1535}`].vesselName, 'Suquamish',
    'the observed vessel can be corrected onto its next departure terminal');
  assert.equal(d.vesselCorrections[`14:${m1535}`], undefined,
    'the same vessel is not also corrected onto the opposite terminal at the same scheduled time');
  assert.equal(d.vesselCorrections[`14:${m1605}`].vesselName, 'Suquamish',
    'the correction chain may continue only at the next later scheduled time');
});

test('ferry/departures endpoint — exposes GPS-observed departures and missed schedule slots', async () => {
  const historyDate = '2026-06-07';
  const firstMs = Date.UTC(2026, 5, 7, 14, 30);
  const secondMs = Date.UTC(2026, 5, 7, 15, 0);
  const historyDir = join(dataDir, 'ferry-history');
  await mkdir(historyDir, { recursive: true });
  await writeFile(join(historyDir, `${historyDate}.json`), JSON.stringify({
    date: historyDate,
    generatedAt: '2026-06-07T15:40:00.000Z',
    sampledAtMs: Date.UTC(2026, 5, 7, 15, 40),
    trips: [firstMs, secondMs].map(scheduledDepartureMs => ({
      id: `${historyDate}:clinton-to-mukilteo:${scheduledDepartureMs}`,
      date: historyDate,
      direction: 'clinton-to-mukilteo',
      fromTerminalId: 5,
      toTerminalId: 14,
      fromTerminalName: 'Clinton',
      toTerminalName: 'Mukilteo',
      scheduledDepartureMs,
      actualDepartureMs: null,
      arrivalMs: scheduledDepartureMs + 20 * 60 * 1000,
      arrivalBasis: 'scheduled-estimate',
      vesselName: '',
      vesselId: null,
      observations: [],
    })),
    vesselSamples: [{
      observedAt: new Date(Date.UTC(2026, 5, 7, 14, 55)).toISOString(),
      vesselName: 'Tokitae',
      vesselId: 68,
      latitude: 47.9755,
      longitude: -122.3493,
    }, {
      observedAt: new Date(Date.UTC(2026, 5, 7, 15, 0)).toISOString(),
      vesselName: 'Tokitae',
      vesselId: 68,
      latitude: 47.968,
      longitude: -122.336,
    }, {
      observedAt: new Date(Date.UTC(2026, 5, 7, 15, 24)).toISOString(),
      vesselName: 'Tokitae',
      vesselId: 68,
      latitude: 47.9485,
      longitude: -122.3046,
    }],
    currentVessels: [],
  }, null, 2));

  const d = await getJson(`/api/ferry/departures?date=${historyDate}`);
  const missedKey = `5:${firstMs}`;
  const observedKey = `5:${secondMs}`;
  assert.equal(d.missedDepartures[missedKey].missed, true, 'marks the skipped earlier schedule slot missed');
  assert.equal(d.missedDepartures[missedKey].source, 'gps-sequence', 'labels missed slots from GPS sequence allocation');
  assert.equal(d.departures[observedKey].departed, true, 'maps the GPS departure to the later schedule slot');
  assert.equal(d.departures[observedKey].source, 'gps-sequence', 'labels GPS-observed departures separately from WSF LeftDock');
  assert.equal(d.departures[observedKey].vesselName, 'Tokitae', 'carries vessel identity from GPS track');
});

test('ferry/departures endpoint — accumulating lateness skips the overtaken schedule slot', async () => {
  const historyDate = '2026-06-12';
  const scheduleMs = [
    Date.UTC(2026, 5, 12, 14, 0),
    Date.UTC(2026, 5, 12, 14, 30),
    Date.UTC(2026, 5, 12, 15, 0),
    Date.UTC(2026, 5, 12, 15, 30),
  ];
  const departureMs = [
    scheduleMs[0] + 10 * 60 * 1000,
    scheduleMs[1] + 20 * 60 * 1000,
    scheduleMs[2] + 30 * 60 * 1000,
  ];
  const historyDir = join(dataDir, 'ferry-history');
  await mkdir(historyDir, { recursive: true });
  await writeFile(join(historyDir, `${historyDate}.json`), JSON.stringify({
    date: historyDate,
    generatedAt: '2026-06-12T15:50:00.000Z',
    sampledAtMs: Date.UTC(2026, 5, 12, 15, 50),
    trips: scheduleMs.map(scheduledDepartureMs => ({
      id: `${historyDate}:clinton-to-mukilteo:${scheduledDepartureMs}`,
      date: historyDate,
      direction: 'clinton-to-mukilteo',
      fromTerminalId: 5,
      toTerminalId: 14,
      fromTerminalName: 'Clinton',
      toTerminalName: 'Mukilteo',
      scheduledDepartureMs,
      actualDepartureMs: null,
      arrivalMs: scheduledDepartureMs + 20 * 60 * 1000,
      arrivalBasis: 'scheduled-estimate',
      observations: [],
    })),
    vesselSamples: departureMs.flatMap((departMs, index) => {
      const vesselId = 200 + index;
      const vesselName = `Late Boat ${index + 1}`;
      return [{
        observedAt: new Date(departMs - 2 * 60 * 1000).toISOString(),
        vesselName,
        vesselId,
        latitude: 47.9755,
        longitude: -122.3493,
      }, {
        observedAt: new Date(departMs).toISOString(),
        vesselName,
        vesselId,
        latitude: 47.968,
        longitude: -122.336,
      }, {
        observedAt: new Date(departMs + 20 * 60 * 1000).toISOString(),
        vesselName,
        vesselId,
        latitude: 47.9485,
        longitude: -122.3046,
      }];
    }),
    currentVessels: [],
  }, null, 2));

  const d = await getJson(`/api/ferry/departures?date=${historyDate}`);
  assert.equal(d.departures[`5:${scheduleMs[0]}`].actualDepartureMs, departureMs[0], 'first late departure maps to the first slot');
  assert.equal(d.departures[`5:${scheduleMs[1]}`].actualDepartureMs, departureMs[1], 'second later departure maps to the second slot');
  assert.equal(d.missedDepartures[`5:${scheduleMs[2]}`].missed, true, 'third slot is missed once service slips to the fourth slot');
  assert.equal(d.departures[`5:${scheduleMs[3]}`].actualDepartureMs, departureMs[2], 'overtaking departure maps to the fourth slot');
  assert.equal(Object.keys(d.missedDepartures).length, 1, 'only the overtaken slot is counted missed');
});

test('ferry/departures endpoint — trailing schedule slots are missed when service stops with no overtaking boat', async () => {
  const historyDate = '2026-06-11';
  // Clinton→Mukilteo: one boat serves the 14:00 slot, then service stops.
  const c2mSlots = [
    Date.UTC(2026, 5, 11, 14, 0),
    Date.UTC(2026, 5, 11, 14, 30),
    Date.UTC(2026, 5, 11, 15, 0),
    Date.UTC(2026, 5, 11, 15, 30),
  ];
  // Mukilteo→Clinton: schedule exists but GPS never tracked a departure (offline).
  const m2cSlots = [
    Date.UTC(2026, 5, 11, 14, 15),
    Date.UTC(2026, 5, 11, 14, 45),
    Date.UTC(2026, 5, 11, 15, 15),
  ];
  const mkTrip = (direction, fromTerminalId, toTerminalId, scheduledDepartureMs) => ({
    id: `${historyDate}:${direction}:${scheduledDepartureMs}`,
    date: historyDate,
    direction,
    fromTerminalId,
    toTerminalId,
    fromTerminalName: fromTerminalId === 5 ? 'Clinton' : 'Mukilteo',
    toTerminalName: toTerminalId === 5 ? 'Clinton' : 'Mukilteo',
    scheduledDepartureMs,
    actualDepartureMs: null,
    arrivalMs: scheduledDepartureMs + 20 * 60 * 1000,
    arrivalBasis: 'scheduled-estimate',
    vesselName: '',
    vesselId: null,
    observations: [],
  });
  const historyDir = join(dataDir, 'ferry-history');
  await mkdir(historyDir, { recursive: true });
  await writeFile(join(historyDir, `${historyDate}.json`), JSON.stringify({
    date: historyDate,
    generatedAt: '2026-06-11T15:45:00.000Z',
    sampledAtMs: Date.UTC(2026, 5, 11, 15, 45),
    trips: [
      ...c2mSlots.map(ms => mkTrip('clinton-to-mukilteo', 5, 14, ms)),
      ...m2cSlots.map(ms => mkTrip('mukilteo-to-clinton', 14, 5, ms)),
    ],
    // One Clinton departure (terminal -> channel -> terminal) for the 14:00 slot.
    vesselSamples: [{
      observedAt: new Date(Date.UTC(2026, 5, 11, 14, 8)).toISOString(),
      vesselName: 'Tokitae', vesselId: 68, latitude: 47.9755, longitude: -122.3493,
    }, {
      observedAt: new Date(Date.UTC(2026, 5, 11, 14, 12)).toISOString(),
      vesselName: 'Tokitae', vesselId: 68, latitude: 47.968, longitude: -122.336,
    }, {
      observedAt: new Date(Date.UTC(2026, 5, 11, 14, 30)).toISOString(),
      vesselName: 'Tokitae', vesselId: 68, latitude: 47.9485, longitude: -122.3046,
    }],
    currentVessels: [],
  }, null, 2));

  const d = await getJson(`/api/ferry/departures?date=${historyDate}`);
  assert.equal(d.departures[`5:${c2mSlots[0]}`].departed, true, 'the one observed boat serves the 14:00 slot');
  assert.equal(d.missedDepartures[`5:${c2mSlots[1]}`].missed, true, 'overdue 14:30 trailing slot is missed');
  assert.equal(d.missedDepartures[`5:${c2mSlots[2]}`].missed, true, 'overdue 15:00 trailing slot is missed');
  assert.equal(d.missedDepartures[`5:${c2mSlots[2]}`].source, 'gps-sequence', 'trailing missed slots are labeled from sequence allocation');
  assert.equal(d.missedDepartures[`5:${c2mSlots[3]}`], undefined, 'latest still-due slot (15:30) is not prematurely called missed');
  assert.equal(d.departures[`5:${c2mSlots[1]}`], undefined, 'missed trailing slots are not reported as departed');
  // Mukilteo→Clinton had no observed departure at all: do not invent missed runs
  // (GPS may simply have been offline for that direction).
  const m2cMissed = Object.keys(d.missedDepartures).filter(k => k.startsWith('14:'));
  assert.equal(m2cMissed.length, 0, 'a direction with no observed departures is never flagged missed');
});

test('ferry/departures endpoint — infers a per-direction route delay from recent late departures', async () => {
  const historyDate = '2026-06-10';
  const sampledAtMs = Date.UTC(2026, 5, 10, 15, 30);
  // Clinton→Mukilteo: two recent departures running ~20 min late, plus one stale
  // on-time departure outside the recency window that must not drag the median.
  const c2m = [
    { sched: Date.UTC(2026, 5, 10, 14, 30), delay: 18 },   // recent, late
    { sched: Date.UTC(2026, 5, 10, 15, 0), delay: 22 },    // recent, late
    { sched: Date.UTC(2026, 5, 10, 13, 0), delay: 2 },     // 2.5h ago — excluded
  ];
  // Mukilteo→Clinton: running on time — must not be flagged as delayed.
  const m2c = [
    { sched: Date.UTC(2026, 5, 10, 14, 45), delay: 3 },
    { sched: Date.UTC(2026, 5, 10, 15, 10), delay: 4 },
  ];
  const mkTrip = (direction, fromTerminalId, toTerminalId, { sched, delay }) => ({
    id: `${historyDate}:${direction}:${sched}`,
    date: historyDate,
    direction,
    fromTerminalId,
    toTerminalId,
    fromTerminalName: fromTerminalId === 5 ? 'Clinton' : 'Mukilteo',
    toTerminalName: toTerminalId === 5 ? 'Clinton' : 'Mukilteo',
    scheduledDepartureMs: sched,
    actualDepartureMs: sched + delay * 60 * 1000,
    arrivalMs: sched + delay * 60 * 1000 + 20 * 60 * 1000,
    arrivalBasis: 'scheduled-estimate',
    vesselName: 'Tokitae',
    vesselId: 68,
    observations: [],
  });
  const historyDir = join(dataDir, 'ferry-history');
  await mkdir(historyDir, { recursive: true });
  await writeFile(join(historyDir, `${historyDate}.json`), JSON.stringify({
    date: historyDate,
    generatedAt: new Date(sampledAtMs).toISOString(),
    sampledAtMs,
    trips: [
      ...c2m.map(t => mkTrip('clinton-to-mukilteo', 5, 14, t)),
      ...m2c.map(t => mkTrip('mukilteo-to-clinton', 14, 5, t)),
    ],
    currentVessels: [],
  }, null, 2));

  const d = await getJson(`/api/ferry/departures?date=${historyDate}`);
  assert.ok(d.routeDelays, 'response includes a routeDelays map');
  assert.equal(d.routeDelays['5'].delayMs, 20 * 60 * 1000, 'reports the median of the two recent late departures');
  assert.equal(d.routeDelays['5'].sampleCount, 2, 'the stale on-time departure is excluded from the recency window');
  assert.equal(d.routeDelays['5'].basis, 'recent-observed-departures', 'labels the route delay as inferred from observed departures');
  assert.equal(d.routeDelays['14'], undefined, 'an on-time direction is never flagged with a route delay');
});

test('ferry/departures endpoint — a single late departure is not enough to claim a route delay', async () => {
  const historyDate = '2026-06-09';
  const sampledAtMs = Date.UTC(2026, 5, 9, 15, 30);
  const sched = Date.UTC(2026, 5, 9, 15, 0);
  const historyDir = join(dataDir, 'ferry-history');
  await mkdir(historyDir, { recursive: true });
  await writeFile(join(historyDir, `${historyDate}.json`), JSON.stringify({
    date: historyDate,
    generatedAt: new Date(sampledAtMs).toISOString(),
    sampledAtMs,
    trips: [{
      id: `${historyDate}:clinton-to-mukilteo:${sched}`,
      date: historyDate,
      direction: 'clinton-to-mukilteo',
      fromTerminalId: 5,
      toTerminalId: 14,
      fromTerminalName: 'Clinton',
      toTerminalName: 'Mukilteo',
      scheduledDepartureMs: sched,
      actualDepartureMs: sched + 20 * 60 * 1000,
      arrivalMs: sched + 40 * 60 * 1000,
      arrivalBasis: 'scheduled-estimate',
      vesselName: 'Tokitae',
      vesselId: 68,
      observations: [],
    }],
    currentVessels: [],
  }, null, 2));

  const d = await getJson(`/api/ferry/departures?date=${historyDate}`);
  assert.equal(d.routeDelays['5'], undefined, 'one late departure alone does not establish a route delay');
});

test('ferry/departures endpoint — modest repeated lateness is diagnostic without an inbound vessel forecast', async () => {
  const historyDate = '2026-06-20';
  const sampledAtMs = Date.UTC(2026, 5, 20, 18, 0);
  const recent = [
    Date.UTC(2026, 5, 20, 17, 0),
    Date.UTC(2026, 5, 20, 17, 30),
  ];
  const nextMs = Date.UTC(2026, 5, 20, 18, 0);
  const historyDir = join(dataDir, 'ferry-history');
  await mkdir(historyDir, { recursive: true });
  await writeFile(join(historyDir, `${historyDate}.json`), JSON.stringify({
    date: historyDate,
    generatedAt: new Date(sampledAtMs).toISOString(),
    sampledAtMs,
    trips: [
      ...recent.map(sched => ferryTestTrip(historyDate, 'clinton-to-mukilteo', 5, 14, sched, {
        actualDepartureMs: sched + 5 * 60 * 1000,
        arrivalMs: sched + 25 * 60 * 1000,
      })),
      ferryTestTrip(historyDate, 'clinton-to-mukilteo', 5, 14, nextMs),
    ],
    currentVessels: [],
  }, null, 2));

  const d = await getJson(`/api/ferry/departures?date=${historyDate}`);
  assert.equal(d.routeDelays['5'].delayMs, 5 * 60 * 1000, 'two five-minute late departures establish a modest route delay');
  assert.equal(d.predictedDepartures[`5:${nextMs}`], undefined, 'recent lateness alone does not forecast a chip without vessel availability');
  assert.equal(d.resolvedSailings[`5:${nextMs}`].status, 'scheduled', 'next chip stays scheduled until an inbound vessel forecast exists');
  assert.equal(d.resolvedSailings[`5:${nextMs}`].effectiveDepartureMs, nextMs, 'next chip does not project by route delay alone');
});

test('ferry/departures endpoint — prior departures do not create schedule-derived arrival forecasts', async () => {
  const historyDate = '2026-06-27';
  const sampledAtMs = Date.UTC(2026, 5, 27, 16, 0);
  const c1535 = Date.UTC(2026, 5, 27, 15, 35);
  const m1605 = Date.UTC(2026, 5, 27, 16, 5);
  const historyDir = join(dataDir, 'ferry-history');
  await mkdir(historyDir, { recursive: true });
  await writeFile(join(historyDir, `${historyDate}.json`), JSON.stringify({
    date: historyDate,
    generatedAt: new Date(sampledAtMs).toISOString(),
    sampledAtMs,
    trips: [
      ferryTestTrip(historyDate, 'clinton-to-mukilteo', 5, 14, c1535, {
        actualDepartureMs: c1535 + 5 * 60 * 1000,
        arrivalMs: c1535 + 25 * 60 * 1000,
        arrivalBasis: 'scheduled-estimate',
        vesselName: 'Tokitae',
        vesselId: 68,
      }),
      ferryTestTrip(historyDate, 'mukilteo-to-clinton', 14, 5, m1605),
    ],
    vesselSamples: [],
    currentVessels: [],
  }, null, 2));

  const d = await getJson(`/api/ferry/departures?date=${historyDate}`);
  assert.deepEqual(d.vesselStatuses, {}, 'without current GPS state there is no server vessel availability');
  assert.equal(d.predictedDepartures[`14:${m1605}`], undefined,
    'does not infer the next departure from actual departure plus a standard crossing estimate');
  assert.equal(d.resolvedSailings[`14:${m1605}`].status, 'scheduled',
    'the chip remains scheduled instead of pretending the prior boat arrival is known');
});

function ferryTestTrip(historyDate, direction, fromTerminalId, toTerminalId, scheduledDepartureMs, overrides = {}) {
  return {
    id: `${historyDate}:${direction}:${scheduledDepartureMs}`,
    date: historyDate,
    direction,
    fromTerminalId,
    toTerminalId,
    fromTerminalName: fromTerminalId === 5 ? 'Clinton' : 'Mukilteo',
    toTerminalName: toTerminalId === 5 ? 'Clinton' : 'Mukilteo',
    scheduledDepartureMs,
    actualDepartureMs: null,
    arrivalMs: scheduledDepartureMs + 20 * 60 * 1000,
    arrivalBasis: 'scheduled-estimate',
    vesselName: '',
    vesselId: null,
    observations: [],
    ...overrides,
  };
}

function ferryTestPoint(pct) {
  const clinton = { lat: 47.9755, lon: -122.3493 };
  const mukilteo = { lat: 47.9485, lon: -122.3046 };
  return {
    latitude: clinton.lat + (mukilteo.lat - clinton.lat) * pct,
    longitude: clinton.lon + (mukilteo.lon - clinton.lon) * pct,
  };
}

function bainbridgeTestPoint(pct) {
  const seattle = { lat: 47.602501, lon: -122.340472 };
  const bainbridge = { lat: 47.622339, lon: -122.509617 };
  return {
    latitude: seattle.lat + (bainbridge.lat - seattle.lat) * pct,
    longitude: seattle.lon + (bainbridge.lon - seattle.lon) * pct,
  };
}

function ferryTestSample(ms, vesselName, vesselId, pct, extra = {}) {
  return {
    observedAt: new Date(ms).toISOString(),
    vesselName,
    vesselId,
    ...ferryTestPoint(pct),
    ...extra,
  };
}

function bainbridgeTestSample(ms, vesselName, vesselId, pct, extra = {}) {
  return {
    observedAt: new Date(ms).toISOString(),
    vesselName,
    vesselId,
    ...bainbridgeTestPoint(pct),
    ...extra,
  };
}

test('ferry/departures endpoint — GPS vessel state forecasts destination departure with schedule context', async () => {
  const historyDate = '2026-06-15';
  const sampledAtMs = Date.UTC(2026, 5, 15, 16, 0);
  const m1535 = Date.UTC(2026, 5, 15, 15, 35);
  const m1605 = Date.UTC(2026, 5, 15, 16, 5);
  const m1635 = Date.UTC(2026, 5, 15, 16, 35);
  const expectedDepartureMs = Date.UTC(2026, 5, 15, 16, 32, 30);
  const historyDir = join(dataDir, 'ferry-history');
  await mkdir(historyDir, { recursive: true });
  await writeFile(join(historyDir, `${historyDate}.json`), JSON.stringify({
    date: historyDate,
    generatedAt: new Date(sampledAtMs).toISOString(),
    sampledAtMs,
    trips: [m1535, m1605, m1635].map(ms =>
      ferryTestTrip(historyDate, 'mukilteo-to-clinton', 14, 5, ms)),
    vesselSamples: [
      ferryTestSample(Date.UTC(2026, 5, 15, 15, 50), 'Tokitae', 68, 0.35, { arrivingTerminalId: 14 }),
      ferryTestSample(Date.UTC(2026, 5, 15, 15, 55), 'Tokitae', 68, 0.45, { arrivingTerminalId: 14 }),
      ferryTestSample(sampledAtMs, 'Tokitae', 68, 0.55, { arrivingTerminalId: 14 }),
    ],
    currentVessels: [],
  }, null, 2));

  const d = await getJson(`/api/ferry/departures?date=${historyDate}`);
  const status = Object.values(d.vesselStatuses).find(v => v.vesselName === 'Tokitae');
  assert.equal(status.status, 'underway-to-mukilteo', 'classifies the vessel as inbound to Mukilteo from GPS motion');
  assert.equal(status.availableTerminalId, 14, 'the next availability is the Mukilteo terminal');
  assert.equal(status.availableMs, expectedDepartureMs, 'availability is GPS ETA plus ten minutes');
  assert.equal(status.destinationTerminalId, 14, 'server exposes the destination terminal in vessel state');
  assert.equal(status.estimatedDockArrivalMs, status.etaMs, 'server exposes the estimated dock arrival');
  assert.equal(status.estimatedDockDepartureMs, expectedDepartureMs, 'server exposes the estimated departure after turnaround');
  assert.equal(typeof status.position.distanceToDestinationMeters, 'number',
    'server exposes terminal distance for the client instead of making the client infer it');
  assert.deepEqual(d.vesselStates, d.vesselStatuses, 'server also exposes vesselStates as the explicit state payload');
  const prediction = d.predictedDepartures[`14:${m1605}`];
  assert.equal(prediction.projectedDepartureMs, expectedDepartureMs, 'forecasts the Mukilteo departure from vessel-state availability');
  assert.equal(prediction.scheduledReferenceMs, m1605, 'maps the projection to the closest prior scheduled slot');
  assert.equal(d.resolvedSailings[`14:${m1605}`].displayScheduledMs, m1605, 'resolved sailings expose the scheduled display context');
  assert.equal(d.resolvedSailings[`14:${m1605}`].timingSource, 'gps-vessel-state', 'resolved sailings identify the new forecast basis');
});

test('bainbridge departures — overdue assigned vessel inbound to terminal stays projected, not unknown', async () => {
  const historyDate = '2026-06-18';
  const sampledAtMs = Date.UTC(2026, 5, 19, 1, 5); // 6:05 PM PDT
  const b0445 = Date.UTC(2026, 5, 18, 11, 45); // 4:45 AM PDT
  const b1735 = Date.UTC(2026, 5, 19, 0, 35); // 5:35 PM PDT, more than 20 minutes old
  const b1840 = Date.UTC(2026, 5, 19, 1, 40);
  const historyDir = join(dataDir, 'ferry-history-bainbridge');
  await mkdir(historyDir, { recursive: true });
  await writeFile(join(historyDir, `${historyDate}.json`), JSON.stringify({
    date: historyDate,
    routeKey: 'bainbridge',
    generatedAt: new Date(sampledAtMs).toISOString(),
    sampledAtMs,
    trips: [
      ferryTestTrip(historyDate, 'bainbridge-to-seattle', 3, 7, b0445, {
        routeKey: 'bainbridge',
        fromTerminalName: 'Bainbridge Island',
        toTerminalName: 'Seattle',
        vesselName: 'Tacoma',
        vesselId: 13,
      }),
      ferryTestTrip(historyDate, 'bainbridge-to-seattle', 3, 7, b1735, {
        routeKey: 'bainbridge',
        fromTerminalName: 'Bainbridge Island',
        toTerminalName: 'Seattle',
        vesselName: 'Tacoma',
        vesselId: 13,
      }),
      ferryTestTrip(historyDate, 'bainbridge-to-seattle', 3, 7, b1840, {
        routeKey: 'bainbridge',
        fromTerminalName: 'Bainbridge Island',
        toTerminalName: 'Seattle',
        vesselName: 'Wenatchee',
        vesselId: 64,
      }),
    ],
    vesselSamples: [
      bainbridgeTestSample(Date.UTC(2026, 5, 19, 0, 55), 'Tacoma', 13, 0.84, { arrivingTerminalId: 3, atDock: false }),
      bainbridgeTestSample(Date.UTC(2026, 5, 19, 1, 0), 'Tacoma', 13, 0.89, { arrivingTerminalId: 3, atDock: false }),
      bainbridgeTestSample(sampledAtMs, 'Tacoma', 13, 0.94, { arrivingTerminalId: 3, atDock: false }),
    ],
    currentVessels: [],
  }, null, 2));

  const d = await getJson(`/api/bainbridge/ferry/departures?date=${historyDate}`);
  const status = Object.values(d.vesselStatuses).find(v => v.vesselName === 'Tacoma');
  assert.equal(status.status, 'underway-to-bainbridge', 'Tacoma is still inbound to Bainbridge');
  assert.equal(status.availableTerminalId, 3, 'Tacoma is next available from Bainbridge');
  const resolved = d.resolvedSailings[`3:${b1735}`];
  assert.equal(resolved.status, 'projected', 'overdue Bainbridge departure remains projected from GPS');
  assert.equal(resolved.vesselName, 'Tacoma', 'keeps the assigned inbound vessel');
  assert.ok(resolved.effectiveDepartureMs > sampledAtMs, 'projects after the current GPS sample time');
  const oldResolved = d.resolvedSailings[`3:${b0445}`];
  assert.notEqual(oldResolved.status, 'projected', 'old same-vessel Bainbridge row is not resurrected by current GPS');
  assert.notEqual(oldResolved.timingSource, 'gps-vessel-state', 'old row does not use current GPS timing');
  assert.ok(oldResolved.effectiveDepartureMs < sampledAtMs, 'old row remains in the past');
});

test('ferry/departures endpoint — approach-zone vessel is not available until docked or ETA plus turnaround', async () => {
  const historyDate = '2026-06-25';
  const sampledAtMs = Date.UTC(2026, 5, 25, 16, 0);
  const m1605 = Date.UTC(2026, 5, 25, 16, 5);
  const expectedEtaMs = Date.UTC(2026, 5, 25, 16, 2, 49, 231);
  const expectedDepartureMs = expectedEtaMs + 10 * 60 * 1000;
  const historyDir = join(dataDir, 'ferry-history');
  await mkdir(historyDir, { recursive: true });
  await writeFile(join(historyDir, `${historyDate}.json`), JSON.stringify({
    date: historyDate,
    generatedAt: new Date(sampledAtMs).toISOString(),
    sampledAtMs,
    trips: [
      ferryTestTrip(historyDate, 'mukilteo-to-clinton', 14, 5, m1605),
    ],
    vesselSamples: [
      ferryTestSample(Date.UTC(2026, 5, 25, 15, 50), 'Tokitae', 68, 0.90, { arrivingTerminalId: 14, atDock: false }),
      ferryTestSample(Date.UTC(2026, 5, 25, 15, 55), 'Tokitae', 68, 0.95, { arrivingTerminalId: 14, atDock: false }),
      ferryTestSample(sampledAtMs, 'Tokitae', 68, 0.978, { arrivingTerminalId: 14, atDock: false }),
    ],
    currentVessels: [],
  }, null, 2));

  const d = await getJson(`/api/ferry/departures?date=${historyDate}`);
  const status = Object.values(d.vesselStatuses).find(v => v.vesselName === 'Tokitae');
  assert.equal(status.status, 'underway-to-mukilteo',
    'a vessel inside the broad approach zone but not docked is still underway');
  assert.equal(status.etaMs, expectedEtaMs, 'uses GPS motion to estimate remaining approach time');
  assert.equal(status.availableMs, expectedDepartureMs,
    'availability waits for ETA plus the terminal turnaround instead of using now');
  assert.equal(status.estimatedDockArrivalMs, expectedEtaMs,
    'approach-zone vessel state exposes estimated dock arrival');
  assert.equal(status.estimatedDockDepartureMs, expectedDepartureMs,
    'approach-zone vessel state exposes ETA plus expected docked time');
  assert.equal(d.predictedDepartures[`14:${m1605}`].projectedDepartureMs, expectedDepartureMs,
    'does not project the Mukilteo departure at the raw scheduled time before docking');
});

test('ferry/departures endpoint — newly docked vessel waits for terminal turnaround before availability', async () => {
  const historyDate = '2026-06-26';
  const sampledAtMs = Date.UTC(2026, 5, 26, 16, 0);
  const dockArrivalMs = Date.UTC(2026, 5, 26, 15, 58);
  const m1605 = Date.UTC(2026, 5, 26, 16, 5);
  const expectedDepartureMs = dockArrivalMs + 10 * 60 * 1000;
  const historyDir = join(dataDir, 'ferry-history');
  await mkdir(historyDir, { recursive: true });
  await writeFile(join(historyDir, `${historyDate}.json`), JSON.stringify({
    date: historyDate,
    generatedAt: new Date(sampledAtMs).toISOString(),
    sampledAtMs,
    trips: [
      ferryTestTrip(historyDate, 'mukilteo-to-clinton', 14, 5, m1605),
    ],
    vesselSamples: [
      ferryTestSample(Date.UTC(2026, 5, 26, 15, 54), 'Tokitae', 68, 0.94, { arrivingTerminalId: 14, atDock: false }),
      ferryTestSample(dockArrivalMs, 'Tokitae', 68, 1, { arrivingTerminalId: 14, atDock: true }),
      ferryTestSample(sampledAtMs, 'Tokitae', 68, 1, { arrivingTerminalId: 14, atDock: true }),
    ],
    currentVessels: [],
  }, null, 2));

  const d = await getJson(`/api/ferry/departures?date=${historyDate}`);
  const status = Object.values(d.vesselStatuses).find(v => v.vesselName === 'Tokitae');
  assert.equal(status.status, 'at-mukilteo-dock', 'classifies the vessel as docked only once docked');
  assert.equal(status.dockedTerminalId, 14, 'server exposes the docked terminal');
  assert.equal(status.dockArrivalMs, dockArrivalMs, 'server exposes when the current docked period began');
  assert.equal(status.estimatedDockDepartureMs, expectedDepartureMs,
    'server estimates the end of the docked load/unload cycle');
  assert.equal(status.availableMs, expectedDepartureMs,
    'a newly docked vessel is not immediately available for a departure forecast');
  assert.equal(d.predictedDepartures[`14:${m1605}`].projectedDepartureMs, expectedDepartureMs,
    'forecast waits for the docked turnaround instead of using the scheduled time');
});

test('ferry/departures endpoint — still-docked vessel keeps a future departure floor after dwell estimate expires', async () => {
  const historyDate = '2026-06-28';
  const sampledAtMs = Date.UTC(2026, 5, 28, 16, 0);
  const dockArrivalMs = Date.UTC(2026, 5, 28, 15, 40);
  const m1545 = Date.UTC(2026, 5, 28, 15, 45);
  const expectedDepartureMs = sampledAtMs + 60 * 1000;
  const historyDir = join(dataDir, 'ferry-history');
  await mkdir(historyDir, { recursive: true });
  await writeFile(join(historyDir, `${historyDate}.json`), JSON.stringify({
    date: historyDate,
    generatedAt: new Date(sampledAtMs).toISOString(),
    sampledAtMs,
    vesselSamples: [
      ferryTestSample(dockArrivalMs, 'Tokitae', 68, 1, { arrivingTerminalId: 14, atDock: true }),
      ferryTestSample(Date.UTC(2026, 5, 28, 15, 50), 'Tokitae', 68, 1, { arrivingTerminalId: 14, atDock: true }),
      ferryTestSample(sampledAtMs, 'Tokitae', 68, 1, { arrivingTerminalId: 14, atDock: true }),
    ],
    currentVessels: [],
    trips: [
      ferryTestTrip(historyDate, 'mukilteo-to-clinton', 14, 5, m1545),
    ],
  }, null, 2));

  const d = await getJson(`/api/ferry/departures?date=${historyDate}`);
  const status = Object.values(d.vesselStatuses).find(v => v.vesselName === 'Tokitae');
  assert.equal(status.estimatedDwellCompleteMs, dockArrivalMs + 10 * 60 * 1000,
    'keeps the learned dwell target for diagnostics');
  assert.equal(status.availableMs, expectedDepartureMs,
    'a vessel still reported at dock is projected slightly into the future after dwell expires');
  assert.equal(d.predictedDepartures[`14:${m1545}`].projectedDepartureMs, expectedDepartureMs,
    'the chip does not show an at-dock vessel as departed before GPS confirms departure');
});

test('ferry/departures endpoint — inbound vessel forecast uses recent same-terminal docked time', async () => {
  const historyDate = '2026-06-21';
  const sampledAtMs = Date.UTC(2026, 5, 21, 18, 0);
  const m1630 = Date.UTC(2026, 5, 21, 16, 30);
  const c1700 = Date.UTC(2026, 5, 21, 17, 0);
  const m1725 = Date.UTC(2026, 5, 21, 17, 25);
  const c1800 = Date.UTC(2026, 5, 21, 18, 0);
  const historyDir = join(dataDir, 'ferry-history');
  await mkdir(historyDir, { recursive: true });
  await writeFile(join(historyDir, `${historyDate}.json`), JSON.stringify({
    date: historyDate,
    generatedAt: new Date(sampledAtMs).toISOString(),
    sampledAtMs,
    trips: [
      ferryTestTrip(historyDate, 'mukilteo-to-clinton', 14, 5, m1630, {
        actualDepartureMs: Date.UTC(2026, 5, 21, 16, 40),
        arrivalMs: Date.UTC(2026, 5, 21, 16, 58),
        arrivalBasis: 'observed-at-dock',
        vesselName: 'Suquamish',
        vesselId: 75,
      }),
      ferryTestTrip(historyDate, 'clinton-to-mukilteo', 5, 14, c1700, {
        actualDepartureMs: c1700 + 10 * 60 * 1000,
        arrivalMs: Date.UTC(2026, 5, 21, 17, 30),
        arrivalBasis: 'observed-at-dock',
        vesselName: 'Suquamish',
        vesselId: 75,
      }),
      ferryTestTrip(historyDate, 'mukilteo-to-clinton', 14, 5, m1725, {
        actualDepartureMs: Date.UTC(2026, 5, 21, 17, 42),
        arrivalMs: Date.UTC(2026, 5, 21, 18, 0),
        arrivalBasis: 'scheduled-estimate',
        vesselName: 'Suquamish',
        vesselId: 75,
      }),
      ferryTestTrip(historyDate, 'clinton-to-mukilteo', 5, 14, c1800),
    ],
    vesselSamples: [
      ferryTestSample(Date.UTC(2026, 5, 21, 17, 50), 'Tokitae', 68, 0.35, { arrivingTerminalId: 5 }),
      ferryTestSample(Date.UTC(2026, 5, 21, 17, 55), 'Tokitae', 68, 0.25, { arrivingTerminalId: 5 }),
      ferryTestSample(sampledAtMs, 'Tokitae', 68, 0.15, { arrivingTerminalId: 5 }),
    ],
    currentVessels: [],
  }, null, 2));

  const d = await getJson(`/api/ferry/departures?date=${historyDate}`);
  assert.equal(d.terminalTurnarounds['5'].turnaroundMs, 12 * 60 * 1000,
    'learns Clinton turnaround from the last vessel that arrived then departed there');
  const status = Object.values(d.vesselStatuses).find(v => v.vesselName === 'Tokitae');
  assert.equal(status.status, 'underway-to-clinton', 'detects the next scheduled vessel inbound to Clinton');
  assert.equal(status.turnaroundMs, 12 * 60 * 1000, 'underway availability uses the learned Clinton docked time');
  assert.equal(d.predictedDepartures[`5:${c1800}`].projectedDepartureMs, Date.UTC(2026, 5, 21, 18, 19, 30),
    'projects the next Clinton departure as GPS arrival ETA plus learned docked time');
  assert.equal(d.resolvedSailings[`5:${c1800}`].timingSource, 'gps-vessel-state',
    'the chip labels the forecast as vessel-state based');
});

test('ferry/departures endpoint — operational forecast chains every 30 minutes and stops after close', async () => {
  const historyDate = '2026-06-16';
  const sampledAtMs = Date.UTC(2026, 5, 16, 16, 0);
  const m1605 = Date.UTC(2026, 5, 16, 16, 5);
  const m1635 = Date.UTC(2026, 5, 16, 16, 35);
  const m1705 = Date.UTC(2026, 5, 16, 17, 5);
  const c1635 = Date.UTC(2026, 5, 16, 16, 35);
  const c1705 = Date.UTC(2026, 5, 16, 17, 5);
  const historyDir = join(dataDir, 'ferry-history');
  await mkdir(historyDir, { recursive: true });
  await writeFile(join(historyDir, `${historyDate}.json`), JSON.stringify({
    date: historyDate,
    generatedAt: new Date(sampledAtMs).toISOString(),
    sampledAtMs,
    trips: [
      ...[m1605, m1635, m1705].map(ms => ferryTestTrip(historyDate, 'mukilteo-to-clinton', 14, 5, ms)),
      ...[c1635, c1705].map(ms => ferryTestTrip(historyDate, 'clinton-to-mukilteo', 5, 14, ms)),
    ],
    vesselSamples: [
      ferryTestSample(Date.UTC(2026, 5, 16, 15, 50), 'Suquamish', 75, 1, { atDock: true }),
      ferryTestSample(Date.UTC(2026, 5, 16, 15, 55), 'Suquamish', 75, 1, { atDock: true }),
      ferryTestSample(sampledAtMs, 'Suquamish', 75, 1, { atDock: true }),
    ],
    currentVessels: [],
  }, null, 2));

  const d = await getJson(`/api/ferry/departures?date=${historyDate}`);
  assert.equal(d.predictedDepartures[`14:${m1605}`].projectedDepartureMs, m1605, 'at-dock vessel waits for the first due Mukilteo slot');
  assert.equal(d.predictedDepartures[`5:${c1635}`].projectedDepartureMs, c1635, 'the same operational chain continues 30 minutes later at Clinton');
  assert.equal(d.predictedDepartures[`14:${m1705}`].projectedDepartureMs, m1705, 'the vessel returns to Mukilteo another 30 minutes later');
  assert.equal(d.predictedDepartures[`5:${c1705}`].projectedDepartureMs, c1705 + 30 * 60 * 1000,
    'a final Clinton row may be projected no more than 30 minutes after the scheduled close');
  const tooLate = Object.values(d.predictedDepartures)
    .filter(p => p.fromTerminalId === 14 && p.projectedDepartureMs > m1705 + 30 * 60 * 1000);
  assert.equal(tooLate.length, 0, 'does not project Mukilteo departures beyond the final scheduled slot plus 30 minutes');
});

test('ferry/departures endpoint — two vessels at one terminal consume separate forecast slots', async () => {
  const historyDate = '2026-06-19';
  const sampledAtMs = Date.UTC(2026, 5, 19, 16, 0);
  const m1605 = Date.UTC(2026, 5, 19, 16, 5);
  const m1635 = Date.UTC(2026, 5, 19, 16, 35);
  const c1635 = Date.UTC(2026, 5, 19, 16, 35);
  const c1705 = Date.UTC(2026, 5, 19, 17, 5);
  const historyDir = join(dataDir, 'ferry-history');
  await mkdir(historyDir, { recursive: true });
  await writeFile(join(historyDir, `${historyDate}.json`), JSON.stringify({
    date: historyDate,
    generatedAt: new Date(sampledAtMs).toISOString(),
    sampledAtMs,
    trips: [
      ...[m1605, m1635].map(ms => ferryTestTrip(historyDate, 'mukilteo-to-clinton', 14, 5, ms)),
      ...[c1635, c1705].map(ms => ferryTestTrip(historyDate, 'clinton-to-mukilteo', 5, 14, ms)),
    ],
    vesselSamples: [
      ferryTestSample(Date.UTC(2026, 5, 19, 15, 50), 'First Boat', 301, 1, { atDock: true }),
      ferryTestSample(sampledAtMs, 'First Boat', 301, 1, { atDock: true }),
      ferryTestSample(Date.UTC(2026, 5, 19, 15, 50), 'Second Boat', 302, 1, { atDock: true }),
      ferryTestSample(sampledAtMs, 'Second Boat', 302, 1, { atDock: true }),
    ],
    currentVessels: [],
  }, null, 2));

  const d = await getJson(`/api/ferry/departures?date=${historyDate}`);
  assert.equal(d.predictedDepartures[`14:${m1605}`].projectedDepartureMs, m1605, 'first vessel takes the first Mukilteo slot');
  assert.equal(d.predictedDepartures[`14:${m1635}`].projectedDepartureMs, m1635, 'second vessel takes the next Mukilteo slot');
  assert.notEqual(d.predictedDepartures[`14:${m1605}`].vesselName, d.predictedDepartures[`14:${m1635}`].vesselName,
    'the two same-terminal chips are assigned to different vessels');
});

test('ferry/departures endpoint — one-boat operation does not invent the missing vessel schedule', async () => {
  const historyDate = '2026-06-17';
  const sampledAtMs = Date.UTC(2026, 5, 17, 16, 0);
  const c1400 = Date.UTC(2026, 5, 17, 14, 0);
  const m1415 = Date.UTC(2026, 5, 17, 14, 15);
  const c1605 = Date.UTC(2026, 5, 17, 16, 5);
  const c1635 = Date.UTC(2026, 5, 17, 16, 35);
  const m1605 = Date.UTC(2026, 5, 17, 16, 5);
  const m1635 = Date.UTC(2026, 5, 17, 16, 35);
  const historyDir = join(dataDir, 'ferry-history');
  await mkdir(historyDir, { recursive: true });
  await writeFile(join(historyDir, `${historyDate}.json`), JSON.stringify({
    date: historyDate,
    generatedAt: new Date(sampledAtMs).toISOString(),
    sampledAtMs,
    trips: [
      ...[c1400, c1605, c1635].map(ms => ferryTestTrip(historyDate, 'clinton-to-mukilteo', 5, 14, ms)),
      ...[m1415, m1605, m1635].map(ms => ferryTestTrip(historyDate, 'mukilteo-to-clinton', 14, 5, ms)),
    ],
    vesselSamples: [
      ferryTestSample(Date.UTC(2026, 5, 17, 15, 35), 'Active Boat', 101, 0),
      ferryTestSample(Date.UTC(2026, 5, 17, 15, 42), 'Active Boat', 101, 0.45),
      ferryTestSample(Date.UTC(2026, 5, 17, 15, 55), 'Active Boat', 101, 1, { atDock: true }),
      ferryTestSample(Date.UTC(2026, 5, 17, 15, 50), 'Missing Boat', 202, 0, { atDock: true }),
      ferryTestSample(Date.UTC(2026, 5, 17, 15, 55), 'Missing Boat', 202, 0, { atDock: true }),
      ferryTestSample(sampledAtMs, 'Missing Boat', 202, 0, { atDock: true }),
    ],
    currentVessels: [],
  }, null, 2));

  const d = await getJson(`/api/ferry/departures?date=${historyDate}`);
  assert.equal(d.predictedDepartures[`14:${m1605}`].vesselName, 'Active Boat', 'the recent passage vessel continues from Mukilteo');
  assert.equal(d.predictedDepartures[`5:${c1605}`], undefined, 'does not invent the missing Clinton-side alternating boat');
  assert.equal(d.predictedDepartures[`5:${c1635}`].vesselName, 'Active Boat', 'the active boat can forecast Clinton only after crossing back');
  assert.equal(Object.values(d.vesselStatuses).some(v => v.vesselName === 'Missing Boat'), false,
    'one-boat operational mode suppresses the other vessel from forecasting');
});

test('ferry/departures endpoint — GPS reversal is surfaced as returning without a departure', async () => {
  const historyDate = '2026-06-29';
  const sampledAtMs = Date.UTC(2026, 5, 29, 16, 0);
  const c1550 = Date.UTC(2026, 5, 29, 15, 50);
  const m1605 = Date.UTC(2026, 5, 29, 16, 5);
  const historyDir = join(dataDir, 'ferry-history');
  await mkdir(historyDir, { recursive: true });
  await writeFile(join(historyDir, `${historyDate}.json`), JSON.stringify({
    date: historyDate,
    generatedAt: new Date(sampledAtMs).toISOString(),
    sampledAtMs,
    trips: [
      ferryTestTrip(historyDate, 'clinton-to-mukilteo', 5, 14, c1550),
      ferryTestTrip(historyDate, 'mukilteo-to-clinton', 14, 5, m1605),
    ],
    vesselSamples: [
      ferryTestSample(Date.UTC(2026, 5, 29, 15, 50), 'Tokitae', 68, 0.2, { arrivingTerminalId: 14 }),
      ferryTestSample(Date.UTC(2026, 5, 29, 15, 55), 'Tokitae', 68, 0.35, { arrivingTerminalId: 14 }),
      ferryTestSample(sampledAtMs, 'Tokitae', 68, 0.28, { arrivingTerminalId: 14 }),
    ],
    currentVessels: [],
  }, null, 2));

  const d = await getJson(`/api/ferry/departures?date=${historyDate}`);
  const status = Object.values(d.vesselStatuses).find(v => v.vesselName === 'Tokitae');
  assert.equal(status.status, 'returning', 'reversed GPS motion is surfaced as returning');
  assert.equal(status.reason, 'gps-motion-reversal', 'the returning status explains the reversal');
  assert.equal(d.departures[`5:${c1550}`], undefined, 'a mid-course reversal is not marked as a completed departure');
  assert.equal(d.resolvedSailings[`5:${c1550}`].status, 'returning', 'the affected schedule chip is marked returning');
  assert.equal(d.resolvedSailings[`5:${c1550}`].vesselName, 'Tokitae', 'the returning chip keeps the vessel label');
  assert.equal(Object.keys(d.predictedDepartures).length, 0, 'returning vessels are not used for departure forecasts');
});

test('messages endpoint — Google-authorized admins can add and delete crawl messages', async () => {
  const unauthenticated = await sendJson('/api/messages', 'POST', {
    text: 'Private party at 7',
  });
  assert.equal(unauthenticated.res.status, 401, 'rejects requests without Google credential');

  const unauthorized = await sendJson('/api/messages', 'POST', {
    text: 'Private party at 7',
  }, 'unauthorized-admin-token');
  assert.equal(unauthorized.res.status, 403, 'rejects signed-in users outside admin allowlist');

  const created = await sendJson('/api/messages', 'POST', {
    text: '<b>Bring firewood</b>',
    startDate: '2000-01-01',
    endDate: '2999-12-31',
    color: 'oklch(80% 0.14 85)',
  }, 'valid-admin-token');
  assert.equal(created.res.status, 201, 'creates message for authorized admin');
  assert.equal(created.data.message.text, 'Bring firewood', 'stores plain text only');
  assert.equal(created.data.message.startDate, '2000-01-01', 'stores start date');
  assert.equal(created.data.message.endDate, '2999-12-31', 'stores end date');
  assert.equal(created.data.message.color, 'oklch(80% 0.14 85)', 'stores safe CSS color text');
  assert.deepEqual(created.data.message.routeKeys, ['whidbey', 'bainbridge'], 'defaults crawl messages to both ferry feeds');
  assert.ok(created.data.message.id, 'created message has id');

  const future = await sendJson('/api/messages', 'POST', {
    text: 'Future crawl message',
    startDate: '2999-01-01',
  }, 'valid-admin-token');
  assert.equal(future.res.status, 201, 'creates future-dated message');

  const expired = await sendJson('/api/messages', 'POST', {
    text: 'Expired crawl message',
    endDate: '2000-01-01',
  }, 'valid-admin-token');
  assert.equal(expired.res.status, 201, 'creates expired message');

  const today = pacificDate();
  const todayOnly = await sendJson('/api/messages', 'POST', {
    text: 'Today-only crawl message',
    startDate: today,
    endDate: today,
  }, 'valid-admin-token');
  assert.equal(todayOnly.res.status, 201, 'creates today-only message');

  const list = await getJson('/api/messages');
  assert.deepEqual(
    list.messages.map(m => m.text),
    ['Bring firewood', 'Today-only crawl message'],
    'includes messages through their full Pacific end date'
  );

  const bainbridgeOnly = await sendJson('/api/messages', 'POST', {
    text: 'Bainbridge-only crawl message',
    startDate: '2000-01-01',
    endDate: '2999-12-31',
    routeKeys: ['bainbridge'],
  }, 'valid-admin-token');
  assert.equal(bainbridgeOnly.res.status, 201, 'creates route-targeted crawl message');
  assert.deepEqual(bainbridgeOnly.data.message.routeKeys, ['bainbridge'], 'stores selected crawl feeds');

  const whidbeyMessages = await getJson('/api/messages?route=whidbey');
  assert.ok(!whidbeyMessages.messages.some(m => m.text === 'Bainbridge-only crawl message'),
    'Whidbey crawl excludes Bainbridge-only messages');
  const bainbridgeMessages = await getJson('/api/messages?route=bainbridge');
  assert.ok(bainbridgeMessages.messages.some(m => m.text === 'Bainbridge-only crawl message'),
    'Bainbridge crawl includes Bainbridge-only messages');
  const invalidRouteQuery = await fetch(`${BASE}/api/messages?route=bremerton`);
  assert.equal(invalidRouteQuery.status, 400, 'rejects unknown crawl message feed query');
  const invalidRouteBody = await sendJson('/api/messages', 'POST', {
    text: 'Bad target',
    routeKeys: ['bremerton'],
  }, 'valid-admin-token');
  assert.equal(invalidRouteBody.res.status, 400, 'rejects unknown crawl message feed on write');
  await sendJson(`/api/messages/${bainbridgeOnly.data.message.id}`, 'DELETE', {}, 'valid-admin-token');

  const includeInactive = await getJsonWithToken('/api/messages?includeInactive=1', 'valid-admin-token');
  assert.equal(includeInactive.res.status, 200, 'admin can include inactive messages');
  assert.deepEqual(
    includeInactive.data.messages.map(m => m.text),
    ['Bring firewood', 'Future crawl message', 'Expired crawl message', 'Today-only crawl message'],
    'admin includeInactive sees active, future, and expired crawl messages'
  );

  const publicIncludeInactive = await getJsonWithToken('/api/messages?includeInactive=1');
  assert.equal(publicIncludeInactive.res.status, 401, 'includeInactive requires admin auth');

  const invalidRange = await sendJson('/api/messages', 'POST', {
    text: 'Invalid range',
    startDate: '2026-07-01',
    endDate: '2026-06-01',
  }, 'valid-admin-token');
  assert.equal(invalidRange.res.status, 400, 'rejects start date after end date');

  const updated = await sendJson(`/api/messages/${created.data.message.id}`, 'PUT', {
    text: '<i>Bring firewood and kindling</i>',
    endDate: '2999-11-30',
    color: 'var(--danger); background:red',
    routeKeys: ['whidbey'],
  }, 'valid-admin-token');
  assert.equal(updated.res.status, 200, 'updates message for authorized admin');
  assert.equal(updated.data.message.text, 'Bring firewood and kindling', 'stores updated plain text only');
  assert.equal(updated.data.message.startDate, null, 'blank omitted start date clears start date');
  assert.equal(updated.data.message.endDate, '2999-11-30', 'updates end date');
  assert.equal(updated.data.message.color, '', 'drops unsafe CSS color text');
  assert.deepEqual(updated.data.message.routeKeys, ['whidbey'], 'updates selected crawl feeds');

  const deleted = await sendJson(`/api/messages/${created.data.message.id}`, 'DELETE', {}, 'valid-admin-token');
  assert.equal(deleted.res.status, 200, 'deletes message for authorized admin');
  assert.deepEqual(deleted.data.messages.map(m => m.text), ['Future crawl message', 'Expired crawl message', 'Today-only crawl message'], 'returns remaining messages');
  await sendJson(`/api/messages/${future.data.message.id}`, 'DELETE', {}, 'valid-admin-token');
  await sendJson(`/api/messages/${expired.data.message.id}`, 'DELETE', {}, 'valid-admin-token');
  await sendJson(`/api/messages/${todayOnly.data.message.id}`, 'DELETE', {}, 'valid-admin-token');
});

test('admin session endpoint — persists Google admin auth in a 30-day HttpOnly cookie', async () => {
  const unauthenticated = await sendJson('/api/admin/session', 'POST', {});
  assert.equal(unauthenticated.res.status, 401, 'rejects session creation without Google credential');

  const unauthorized = await sendJson('/api/admin/session', 'POST', {}, 'unauthorized-admin-token');
  assert.equal(unauthorized.res.status, 403, 'rejects non-admin Google credential');

  const created = await sendJson('/api/admin/session', 'POST', {}, 'valid-admin-token');
  assert.equal(created.res.status, 201, 'creates session for authorized admin');
  assert.equal(created.data.signedIn, true, 'session response is signed in');
  assert.equal(created.data.admin.email, 'mike@example.com', 'returns signed-in admin email');

  const setCookie = created.res.headers.get('set-cookie') || '';
  assert.match(setCookie, /whidbey_admin_session=/, 'sets admin session cookie');
  assert.match(setCookie, /HttpOnly/i, 'session cookie is HttpOnly');
  assert.match(setCookie, /SameSite=Lax/i, 'session cookie is SameSite=Lax');
  assert.match(setCookie, /Max-Age=2592000/i, 'session cookie lasts 30 days');

  const cookie = setCookie.split(';')[0];
  const restored = await fetch(`${BASE}/api/admin/session`, { headers: { Cookie: cookie } });
  assert.equal(restored.status, 200, 'restores session from cookie');
  const restoredData = await restored.json();
  assert.equal(restoredData.signedIn, true, 'restored session is signed in');
  assert.equal(restoredData.admin.email, 'mike@example.com', 'restored session includes admin email');

  const createdMessage = await sendJson('/api/messages', 'POST', {
    text: 'Cookie-backed message',
  }, '', cookie);
  assert.equal(createdMessage.res.status, 201, 'admin write works with session cookie and no bearer token');

  const deletedMessage = await sendJson(`/api/messages/${createdMessage.data.message.id}`, 'DELETE', {}, '', cookie);
  assert.equal(deletedMessage.res.status, 200, 'admin delete works with session cookie and no bearer token');

  const signedOut = await sendJson('/api/admin/session', 'DELETE', {}, '', cookie);
  assert.equal(signedOut.res.status, 200, 'sign out endpoint succeeds');
  assert.match(signedOut.res.headers.get('set-cookie') || '', /whidbey_admin_session=;/, 'sign out clears session cookie in the browser');
});

test('alert-contexts endpoint — Google-authorized admins can manage ferry alert parentheticals', async () => {
  const defaults = await getJson('/api/alert-contexts');
  assert.ok(Array.isArray(defaults.contexts), 'lists alert contexts');
  assert.ok(defaults.contexts.some(context => context.query === 'Low Tide loading restrictions'), 'includes default low tide context');
  assert.ok(defaults.contexts.some(context => context.additionalInfo === 'soil testing; operations continue'), 'includes default construction context');

  const unauthenticated = await sendJson('/api/alert-contexts', 'POST', {
    query: 'Test ferry alert',
    additionalInfo: 'test parenthetical',
  });
  assert.equal(unauthenticated.res.status, 401, 'rejects context writes without Google credential');

  const unauthorized = await sendJson('/api/alert-contexts', 'POST', {
    query: 'Test ferry alert',
    additionalInfo: 'test parenthetical',
  }, 'unauthorized-admin-token');
  assert.equal(unauthorized.res.status, 403, 'rejects context writes from non-admin users');

  const created = await sendJson('/api/alert-contexts', 'POST', {
    query: '<b>Test ferry alert</b>',
    additionalInfo: '<i>test parenthetical</i>',
    color: 'oklch(80% 0.14 85)',
  }, 'valid-admin-token');
  assert.equal(created.res.status, 201, 'creates alert context for authorized admin');
  assert.equal(created.data.context.query, 'Test ferry alert', 'stores plain query only');
  assert.equal(created.data.context.additionalInfo, 'test parenthetical', 'stores plain parenthetical only');
  assert.equal(created.data.context.color, 'oklch(80% 0.14 85)', 'stores safe CSS color text');

  const updated = await sendJson(`/api/alert-contexts/${created.data.context.id}`, 'PUT', {
    query: 'Updated ferry alert',
    additionalInfo: 'updated parenthetical',
    color: 'var(--danger); background:red',
  }, 'valid-admin-token');
  assert.equal(updated.res.status, 200, 'updates alert context for authorized admin');
  assert.equal(updated.data.context.query, 'Updated ferry alert', 'updates query');
  assert.equal(updated.data.context.additionalInfo, 'updated parenthetical', 'updates parenthetical');
  assert.equal(updated.data.context.color, '', 'drops unsafe CSS color text');

  const duplicate = await sendJson(`/api/alert-contexts/${created.data.context.id}`, 'PUT', {
    query: 'low tide loading restrictions',
    additionalInfo: 'duplicate query',
    color: 'orange',
  }, 'valid-admin-token');
  assert.equal(duplicate.res.status, 409, 'rejects duplicate alert queries case-insensitively');

  const deleted = await sendJson(`/api/alert-contexts/${created.data.context.id}`, 'DELETE', {}, 'valid-admin-token');
  assert.equal(deleted.res.status, 200, 'deletes alert context for authorized admin');
  assert.ok(!deleted.data.contexts.some(context => context.id === created.data.context.id), 'deleted context is removed');
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
  assert.ok(html.includes('(space API N/A)'), 'has ferry space warning text');
  assert.ok(html.includes('ferry-alert'), 'has ferry route alert styling');
  assert.match(html, /<a class="text-link" id="history-link" href="\/ferry-history">History<\/a>/, 'links to ferry history from the dashboard header');
  assert.match(html, /#ferry-alert-ticker\s*\{[\s\S]*?min-width:\s*0;/, 'ticker grid item cannot widen the dashboard');
  assert.match(html, /\/api\/messages\?route=\$\{encodeURIComponent\(FERRY_ROUTE\.key\)\}/,
    'dashboard fetches crawl messages for the active ferry route');
  assert.match(html, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*minmax\(0,\s*1fr\)/, 'main grid columns can shrink to viewport');
  assert.ok(html.includes('Whidbey'), 'mentions Whidbey');
});

test('bainbridge pages — serve the shared dashboard with Bainbridge route config', async () => {
  const dashboardRes = await fetch(`${BASE}/bainbridge`);
  assert.ok(dashboardRes.ok, 'Bainbridge dashboard responds OK');
  const dashboardHtml = await dashboardRes.text();
  assert.match(dashboardHtml, /window\.__FERRY_ROUTE__=/, 'Bainbridge dashboard injects route config');
  assert.match(dashboardHtml, /"key":"bainbridge"/, 'Bainbridge dashboard route key is injected');
  assert.match(dashboardHtml, /"apiPrefix":"\/api\/bainbridge\/ferry"/, 'Bainbridge dashboard uses Bainbridge ferry API');
  assert.match(dashboardHtml, /"historyPath":"\/bainbridge\/ferry-history"/, 'Bainbridge dashboard links to Bainbridge history');
  assert.match(dashboardHtml, /"weatherPath":"\/api\/bainbridge\/ferry\/weather"/, 'Bainbridge dashboard uses Bainbridge weather API');
  assert.match(dashboardHtml, /"tidesPath":"\/api\/bainbridge\/ferry\/tides"/, 'Bainbridge dashboard uses Bainbridge tide API');
  assert.match(dashboardHtml, /"weatherLabel":"Bainbridge Island, WA"/, 'Bainbridge dashboard labels local weather');
  assert.match(dashboardHtml, /"tideLabel":"Seattle"/, 'Bainbridge dashboard labels the Seattle tide station');
  assert.match(dashboardHtml, /"name":"Seattle"/, 'Bainbridge dashboard includes Seattle terminal');
  assert.match(dashboardHtml, /"name":"Bainbridge Island"/, 'Bainbridge dashboard includes Bainbridge terminal');
  assert.doesNotMatch(dashboardHtml, /47\.561847/, 'Bainbridge dashboard no longer carries Bremerton coordinates for Seattle');

  const historyRes = await fetch(`${BASE}/bainbridge/ferry-history`);
  assert.ok(historyRes.ok, 'Bainbridge history page responds OK');
  const historyHtml = await historyRes.text();
  assert.match(historyHtml, /window\.__FERRY_ROUTE__=/, 'Bainbridge history injects route config');
  assert.match(historyHtml, /"historyTitle":"Bainbridge Ferry History"/, 'Bainbridge history title is injected');
  assert.match(historyHtml, /"dashboardPath":"\/bainbridge"/, 'Bainbridge history links back to Bainbridge dashboard');
});

test('admin page — serves Google-authenticated admin surface', async () => {
  const res = await fetch(`${BASE}/admin`);
  assert.ok(res.ok, 'admin page responds OK');
  const html = await res.text();

  assert.match(html, /Whidbey Dashboard Admin/, 'page is named admin');
  assert.match(html, /accounts\.google\.com\/gsi\/client/, 'loads Google Identity Services');
  assert.doesNotMatch(html, /id="from"/, 'does not expose old email/password-style field');
  assert.match(html, /id="app-version"/, 'shows app version in the admin header');
  assert.match(html, /<h2><button id="sign-in"[^>]*>Sign In<\/button><\/h2>/, 'uses the sign-in title as the compact sign-in control');
  assert.doesNotMatch(html, /renderButton/, 'does not render Google branded sign-in button');
  assert.match(html, /<textarea[^>]+id="text"/, 'has message text field');
  assert.match(html, /id="message-start-date"[^>]+type="date"/, 'has message start date field');
  assert.match(html, /id="message-end-date"[^>]+type="date"/, 'has message end date field');
  assert.match(html, /Start date \(Pacific\)/, 'labels message start date as Pacific');
  assert.match(html, /End date \(Pacific\)/, 'labels message end date as Pacific');
  assert.match(html, /id="message-color"/, 'has message color field');
  assert.match(html, /name="routeKeys"[^>]+value="whidbey"/, 'has Whidbey crawl feed targeting');
  assert.match(html, /name="routeKeys"[^>]+value="bainbridge"/, 'has Bainbridge crawl feed targeting');
  assert.match(html, /selectedMessageRouteKeys/, 'submits selected crawl message feeds');
  assert.match(html, /messageRoutesText/, 'shows selected crawl message feeds in the admin list');
  assert.match(html, /includeInactive=1/, 'admin message list can include inactive scheduled messages');
  assert.match(html, /Ferry Alert Parentheticals/, 'has ferry alert parenthetical editor');
  assert.match(html, /id="alert-query"/, 'has alert query field');
  assert.match(html, /id="alert-info"/, 'has alert parenthetical field');
  assert.match(html, /id="alert-color"/, 'has alert color field');
  assert.match(html, /message-edit edit-form hidden/, 'message rows have hidden edit forms');
  assert.match(html, /context-edit edit-form hidden/, 'alert context rows have hidden edit forms');
  assert.match(html, /Delete/, 'has delete controls');
  assert.match(html, /Edit/, 'has edit controls');
  assert.match(html, /\/api\/messages/, 'uses user message API');
  assert.match(html, /routeKeys/, 'persists crawl message feed targeting through the admin API');
  assert.match(html, /\/api\/alert-contexts/, 'uses alert context API');
  assert.match(html, /\/api\/admin\/session/, 'uses cookie-backed admin session API');
  assert.match(html, /credentials:\s*'same-origin'/, 'sends same-origin session cookies with admin requests');
  assert.match(html, /h1,\s*h2\s*\{[\s\S]*?color:\s*var\(--accent\);/, 'admin headings use dashboard heading blue');

  const scriptMatch = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'found admin script block');
  assert.doesNotThrow(() => new Function(scriptMatch[1]), 'admin inline JS should parse without syntax errors');

  const old = await fetch(`${BASE}/message`);
  assert.equal(old.status, 404, 'old /message link is intentionally gone');
});

test('ferry history page — serves dated table and time-distance diagram UI', async () => {
  const res = await fetch(`${BASE}/ferry-history?date=2026-06-08`);
  assert.ok(res.ok, 'ferry history page responds OK');
  const html = await res.text();

  assert.match(html, /Ferry History/, 'page is named ferry history');
  assert.match(html, /class="page-logo"/, 'shows a compact ferry logo in the history page title');
  assert.match(html, /aria-label="Washington state ferry in profile"/, 'ferry logo has an accessible description');
  assert.match(html, /id="version"/, 'shows app version in the header');
  assert.match(html, /id="clock"/, 'shows the shared dashboard clock in the header');
  assert.match(html, /id="date-display"/, 'shows the shared dashboard date in the header');
  assert.match(html, /\/api\/config/, 'loads app version from config API');
  assert.match(html, /setInterval\(refreshHistory,\s*historyRefreshMs\)/, 'refreshes history data without reloading the page');
  assert.match(html, /cache:\s*'no-store'/, 'history refresh bypasses browser cache');
  assert.match(html, /id="prev-date"/, 'has previous date control');
  assert.match(html, /id="next-date"/, 'has next date control');
  assert.match(html, /id="date-input"[^>]+type="date"/, 'has date picker');
  assert.match(html, /<div class="title-row">[\s\S]*?<a class="text-link" id="main-link" href="\/">Dashboard<\/a>[\s\S]*?<\/div>/, 'dashboard navigation is tucked under the history title');
  assert.match(html, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*auto\s*minmax\(0,\s*1fr\)/, 'header centers date controls between title and clock');
  assert.match(html, /\.nav\s*\{[\s\S]*?justify-content:\s*center;/, 'date controls are centered in the header');
  assert.match(html, /<p class="summary" id="summary"><\/p>/, 'summary renders as a compact paragraph');
  assert.doesNotMatch(html, /function metric/, 'summary no longer renders large metric chips');
  assert.doesNotMatch(html, /metric\('Date'/, 'summary does not duplicate the selected date');
  assert.doesNotMatch(html, /id="gps-track-toggle"/, 'GPS track is the only chart mode now');
  assert.match(html, /\$\{FERRY_ROUTE\.apiPrefix\}\/history\?date=/, 'loads history API by URL date from the active route');
  assert.match(html, /<h2>Vehicle Loads<\/h2>/, 'adds vehicle-load charts below the GPS tracks');
  assert.match(html, /id="load-charts"/, 'renders vehicle-load charts into their own container');
  assert.match(html, /\.load-charts\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/, 'shows the two terminal load charts side by side on wider screens');
  assert.match(html, /@media \(max-width:\s*760px\)[\s\S]*?\.load-charts\s*\{[\s\S]*?grid-template-columns:\s*1fr/, 'stacks load charts on mobile');
  assert.match(html, /function renderVehicleLoadCharts/, 'renders vehicle load charts from observed table trips');
  assert.match(html, /vehicleLoadChart\(terminal,\s*chartTrips,\s*vessels,\s*bounds,\s*day\.date\)/, 'renders one vehicle chart per departure terminal');
  assert.match(html, /const chartTrips = trips\.filter\(trip => actualDepartureMs\(trip\) && carLoad\(trip\)\)/, 'only charts recorded departures with vehicle-load data');
  assert.match(html, /const bounds = timeBounds\(day\)/, 'uses the whole history operational day as the chart extent');
  assert.match(html, /vehicleLoadSvg\(terminal, rows, vessels, bounds, maxCapacity, dayDate\)/, 'labels load chart day boundaries using the history date');
  assert.match(html, /colorFor\(trip\.vesselName, vessels\)/, 'uses the same vessel colors as the GPS track legend');
  assert.match(html, /id="trip-tables"/, 'renders trip tables into a grouped container');
  assert.match(html, /function terminalTable/, 'renders separate history tables by departure terminal');
  assert.match(html, /const TERMINAL_ORDER = \[SECONDARY_TERMINAL\.name, PRIMARY_TERMINAL\.name\]/, 'renders secondary departures then primary departures');
  assert.match(html, /<span>\$\{escapeHtml\(terminal\)\}<\/span>/, 'labels each terminal table with just the terminal name');
  assert.match(html, /fromTerminalName === terminal/, 'groups rows by departure terminal');
  assert.doesNotMatch(html, /vesselTable|vessel-heading/, 'does not group the lower history table by vessel');
  assert.doesNotMatch(html, /<th aria-label="Direction"><\/th>/, 'terminal tables do not need a direction arrow column');
  assert.doesNotMatch(html, /function directionGlyph/, 'does not keep direction glyph code for single-direction terminal tables');
  assert.doesNotMatch(html, /class="direction"/, 'does not render direction cells inside terminal tables');
  assert.match(html, /<th>Vessel<\/th>/, 'keeps vessel as a row column inside each terminal table');
  assert.match(html, /<th>Sched<\/th>/, 'has scheduled departure column');
  assert.match(html, /<th>Actual<\/th>/, 'has actual departure column');
  assert.match(html, /<th>Travel<\/th>/, 'has travel duration column');
  assert.match(html, /<th>Docked<\/th>/, 'has dock duration column');
  assert.match(html, /<th>Cars<\/th>/, 'has vehicle load column');
  assert.match(html, /function formatCarLoad/, 'formats filled vehicle spaces from WSF space data');
  assert.match(html, /max - open/, 'computes cars carried from max spaces minus open drive-up spaces');
  assert.match(html, /const departureSpace = usableVehicleSpace\(scheduledTrip\?\.departureSpace\)/, 'ignores empty frozen departure-space objects');
  assert.match(html, /space: departureSpace \|\| scheduleSpace \|\| null/, 'uses frozen departure-space before falling back to matched schedule space');
  assert.match(html, /usableVehicleSpace\(trip\?\.departureSpace\) \|\| usableVehicleSpace\(trip\?\.space\)/, 'formats vehicle load from usable frozen departure-space when present');
  assert.match(html, /actual-sailing/, 'uses row background color for actual sailings');
  assert.doesNotMatch(html, /scheduled-sailing/, 'does not render schedule-only rows in the lower tables');
  assert.doesNotMatch(html, /missed-sailing/, 'does not render missed schedule slots as lower-table rows');
  assert.doesNotMatch(html, /<span class="missed">Missed<\/span>/, 'does not put missed schedule labels in the GPS-observed table');
  assert.match(html, /function actualDepartureMs/, 'isolates confirmed actual departure timestamps');
  assert.match(html, /function actualArrivalMs/, 'isolates observed actual arrival timestamps');
  assert.match(html, /gps-observed-terminal/, 'uses GPS-observed arrivals to fill actual travel and dock durations');
  assert.match(html, /function tableTripFromGpsDeparture/, 'builds lower table rows from GPS-observed crossings');
  assert.match(html, /if \(pendingDeparture\) departures\.push\(pendingDeparture\)/, 'shows in-progress GPS-observed departures before the crossing completes');
  assert.match(html, /observedTrips/, 'uses GPS-observed trips as the lower-table row source');
  assert.match(html, /tableTripRows\(gpsScheduleStats, departureData\?\.resolvedSailings\)/, 'passes resolved departure truth into the GPS-observed lower-table row builder');
  assert.match(html, /function applyResolvedDepartureTruth/, 'shares resolved sailing departure timestamps with the history table');
  assert.match(html, /terminalTable\(terminal, tableTrips, tableTrips\)/, 'computes dock time from the GPS-observed table rows');
  assert.doesNotMatch(html, /matchedTrips/, 'does not build lower-table rows by overlaying GPS onto scheduled rows');
  assert.doesNotMatch(html, /unscheduledTrips/, 'does not distinguish GPS-only rows from the normal observed-row source');
  assert.match(html, /no confirmed departure/, 'explains blank travel durations for unconfirmed trips');
  assert.doesNotMatch(html, /tableTripRows\(trips/, 'does not build lower-table rows from scheduled API trips');
  assert.doesNotMatch(html, /actualDepartureMs:\s*trip\.scheduledDepartureMs/, 'does not fill actual departures from the schedule');
  assert.doesNotMatch(html, /departed \+ 20 \* 60 \* 1000/, 'does not fabricate table arrivals from default travel time');
  assert.doesNotMatch(html, /<th>Status<\/th>/, 'does not render a status column');
  assert.doesNotMatch(html, /function statusText/, 'does not render status chip text');
  assert.match(html, /function formatMinutes/, 'formats durations as fractional minutes');
  assert.match(html, /GPS Tracks/, 'labels the diagram as GPS tracks');
  assert.doesNotMatch(html, /Time Distance/, 'does not use the old time-distance label');
  assert.match(html, /style="aspect-ratio:\$\{width\} \/ \$\{height\}"/, 'uses the SVG viewBox ratio instead of fixed vertical whitespace');
  assert.match(html, /top:\s*48/, 'keeps graph top padding tight');
  assert.match(html, /bottom:\s*18/, 'keeps graph bottom padding tight');
  assert.doesNotMatch(html, /const DAY_START_HOUR = 2/, 'history page does not hardcode the operational-day boundary');
  assert.doesNotMatch(html, /ferryHistoryDayStartHour/, 'history page does not read the operational-day boundary from global config');
  assert.match(html, /day\?\.operationalDay\?\.startMs/, 'history page reads graph start from the history file');
  assert.match(html, /day\?\.operationalDay\?\.endMs/, 'history page reads graph end from the history file');
  assert.match(html, /const LEGACY_OPERATIONAL_DAY_START_HOUR = 2/, 'keeps a 2 AM fallback for older logs without operationalDay metadata');
  assert.match(html, /function legacyOperationalDayBounds/, 'has a named legacy fallback for missing day-span metadata');
  assert.match(html, /zonedDateTimeMs\(dateText, LEGACY_OPERATIONAL_DAY_START_HOUR, 0\)/, 'legacy fallback uses a 2 AM Pacific day boundary');
  assert.match(html, /formatGraphTimeMs/, 'formats graph times with operational-day labels');
  assert.match(html, /\$\{timeText\}\+1/, 'appends +1 to graph labels after midnight');
  assert.match(html, /terminalProgress/, 'can plot current vessel position from coordinates');
  assert.match(html, /scheduled-estimate/, 'renders missing GPS coverage as subdued schedule context lines');
  assert.match(html, /\.trip-line\.scheduled-estimate\s*\{[\s\S]*?stroke-width:\s*1\.8;/, 'schedule context trips are thinner than GPS tracks');
  assert.match(html, /\.trip-line\.scheduled-estimate\s*\{[\s\S]*?opacity:\s*0\.44;/, 'schedule context remains visible dashed context');
  assert.match(html, /rgba\(148, 163, 184, 0\.75\)/, 'renders schedule-only trips in neutral gray instead of vessel colors');
  assert.match(html, /scheduled trips/, 'labels trip count as scheduled trips');
  assert.match(html, /\$\{sampleCount\} GPS samples/, 'summarizes GPS data as a sample count');
  assert.doesNotMatch(html, /schedule gaps/, 'does not expose schedule fallback gaps in summary text');
  assert.match(html, /const TIMELINE_COLUMN_COUNT = 4/, 'splits the time-distance chart into four timeline columns');
  assert.match(html, /const TIMELINE_COLUMN_HOURS = 6/, 'uses 6-hour timeline columns');
  assert.match(html, /left:\s*54/, 'keeps the left time-label gutter compact');
  assert.match(html, /const GRID_TICK_EXTENT = 8/, 'limits grid lines to short ticks outside terminal axes');
  assert.match(html, /segment\.leftX - GRID_TICK_EXTENT/, 'starts grid lines near the left terminal axis');
  assert.match(html, /segment\.rightX \+ GRID_TICK_EXTENT/, 'ends grid lines near the right terminal axis');
  assert.match(html, /ceilToHalfHour\(segment\.startMs\)/, 'starts grid lines on the next half-hour boundary');
  assert.match(html, /ms \+= HALF_HOUR_MS/, 'draws grid lines every half hour, including hourly lines');
  assert.match(html, /hour-grid/, 'styles hourly grid lines more strongly than half-hour lines');
  assert.match(html, /ms \+= HOUR_MS\)[\s\S]*?formatGraphTimeMs\(ms, day\.date\)/, 'labels every hour with 24-hour operational-day labels');
  assert.match(html, /const HALF_HOUR_MS = 30 \* 60 \* 1000/, 'defines half-hour grid interval');
  assert.match(html, /schedule-departure-tick/, 'draws yellow scheduled departure ticks outside the terminal axes');
  assert.match(html, /scheduledDepartureTick\(trip, segment, height, pad\)/, 'renders scheduled departure ticks per split timeline segment');
  assert.match(html, /trip\.fromTerminalName === LEFT_TERMINAL\.name/, 'places displayed route terminals on opposite outside edges');
  assert.match(html, /Array\.from\(\{ length: TIMELINE_COLUMN_COUNT \}/, 'builds timeline columns from the configured count');
  assert.match(html, /index \* TIMELINE_COLUMN_HOURS \* HOUR_MS/, 'splits graph columns into fixed 6-hour periods');
  assert.match(html, /return \{ startMs, endMs \}/, 'uses the history file span as graph bounds');
  assert.match(html, /gpsObservedScheduleStats\(gpsTracks, trips\)/, 'summarizes GPS crossings that match scheduled trips');
  assert.match(html, /GPS-observed scheduled crossings/, 'labels track-derived crossings as schedule-matched');
  assert.match(html, /missed scheduled trips/, 'surfaces skipped scheduled departures separately from observed crossings');
  assert.doesNotMatch(html, /GPS_STARTUP_IGNORE_MS/, 'does not drop real early GPS crossings before the first published schedule row');
  assert.match(html, /const GPS_FIRST_DEPARTURE_GRACE_MS = 15 \* 60 \* 1000/, 'uses a first-departure grace before service alignment starts');
  assert.match(html, /function gpsObservedDepartures/, 'counts confirmed GPS departures instead of arrival-side crossings');
  assert.match(html, /allocateGpsDeparturesToSchedule/, 'allocates GPS departures forward through scheduled service');
  assert.match(html, /tripsByDirection/, 'keeps independent schedule sequences for each route direction');
  assert.match(html, /nextTripIndexByDirection/, 'matches each GPS departure to the next remaining schedule in its direction');
  assert.match(html, /departure\.ms >= directionTrips\[tripIndex \+ 1\]\.scheduledDepartureMs/, 'counts a skipped slot when service slips into the next scheduled departure time');
  assert.doesNotMatch(html, /missedTrips\.push/, 'does not pass overtaken scheduled departures into the lower table renderer');
  assert.doesNotMatch(html, /GPS_SCHEDULED_CROSSING_MATCH_MS/, 'does not use a brittle per-row timing window for delayed service');
  assert.match(html, /WSF LeftDock matches/, 'labels WSDOT matched dock timestamps precisely');
  assert.doesNotMatch(html, /actual departures/, 'does not describe LeftDock matches as actual departures');
  assert.match(html, /const GPS_TERMINAL_ZONE_PCT = 0\.12/, 'uses a stable terminal zone threshold for GPS crossing counts');
  assert.match(html, /const GPS_ARRIVAL_TERMINAL_ZONE_PCT = 0\.04/, 'uses a tighter GPS threshold before filling actual arrival and travel time');
  assert.match(html, /atDock: sample\.atDock \?\? null/, 'carries WSF dock state into client-side GPS track points');
  assert.match(html, /point\.atDock === false/, 'uses WSF dock departure state instead of waiting to leave the broad GPS terminal zone');
  assert.match(html, /arrivalTerminal === pendingDeparture\.toTerminal && point\.atDock !== false/, 'requires dock-side GPS confirmation before closing an in-progress crossing');
  assert.match(html, /function gpsTerminalZone/, 'classifies terminal zones for GPS crossing counts');
  assert.match(html, /clipStart = Math\.max\(departMs, segment\.startMs\)/, 'clips schedule fallback lines at the start of each half-day segment');
  assert.match(html, /clipEnd = Math\.min\(arriveMs, segment\.endMs\)/, 'clips schedule fallback lines at the end of each half-day segment');
  assert.match(html, /day\?\.vesselSamples/, 'uses raw persisted vessel GPS samples for observed route paths');
  assert.match(html, /compatibleGpsSamples\(day, rawSamples\)/, 'combines raw vessel samples with pre-migration legacy GPS backfill');
  assert.match(html, /ms < firstRawMs/, 'uses legacy observations only before the first raw sample on mixed-format days');
  assert.match(html, /addGpsSample\(byVessel, sample/, 'collects GPS vessel tracks independent of scheduled trips');
  assert.match(html, /function legacyGpsSamples/, 'can render older history files that predate vesselSamples');
  assert.match(html, /function renderGpsTrackLines/, 'renders GPS polylines from raw vessel samples');
  assert.match(html, /gps-track-line/, 'marks GPS tracks separately from schedule context lines');
  assert.match(html, /GPS_TRACK_GAP_MS/, 'breaks GPS tracks across large sampling gaps');
  assert.match(html, /function tripHasUsableGpsCoverage/, 'detects trips already covered by GPS tracks');
  assert.match(html, /GPS_ROUTE_COVERAGE_MIN/, 'requires meaningful terminal-to-terminal GPS progress before suppressing schedule fallback');
  assert.match(html, /!tripHasUsableGpsCoverage\(trip\)/, 'draws dashed schedule context only for trips without usable GPS coverage');
  assert.match(html, /function scheduleContextLine/, 'draws dashed schedule fallback for future or missed trips');
  assert.doesNotMatch(html, /function terminalXForId/, 'does not render live current-vessel dots in GPS track chart');
  assert.doesNotMatch(html, /departingTerminalId === 5 \|\| vessel\.arrivingTerminalId === 5/, 'does not place docked vessels by either endpoint');
  assert.doesNotMatch(html, /function currentVesselPoint/, 'does not impute current vessel positions into GPS track chart');

  const scriptMatch = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'found ferry history script block');
  assert.doesNotThrow(() => new Function(scriptMatch[1]), 'ferry history inline JS should parse without syntax errors');
});

test('ferry history page — atDock false starts an observed departure before leaving terminal zone', async () => {
  const { readFileSync } = await import('fs');
  const { dirname: dn, join: jn } = await import('path');
  const { fileURLToPath: fu } = await import('url');
  const dir = dn(fu(import.meta.url));
  const html = readFileSync(jn(dir, '..', 'public', 'ferry-history.html'), 'utf8');
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];

  const element = {
    style: {},
    hidden: false,
    textContent: '',
    innerHTML: '',
    value: '',
    addEventListener: () => {},
  };
  const context = {
    console,
    Date,
    URL,
    URLSearchParams,
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval: () => {},
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    document: {
      hidden: false,
      addEventListener: () => {},
      getElementById: () => element,
    },
    window: {
      location: {
        search: '',
        href: 'https://example.test/ferry-history',
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(script + `\nthis.__historyTest = { gpsObservedDeparturesForTrack };`, context);

  const departMs = Date.UTC(2026, 5, 14, 22, 54, 26);
  const departures = context.__historyTest.gpsObservedDeparturesForTrack({
    key: '68:Tokitae',
    name: 'Tokitae',
    points: [
      { ms: Date.UTC(2026, 5, 14, 22, 53, 26), pct: 0.99, atDock: true },
      { ms: departMs, pct: 0.99, atDock: false },
      { ms: Date.UTC(2026, 5, 14, 22, 56, 27), pct: 0.95, atDock: false },
      { ms: Date.UTC(2026, 5, 14, 23, 10, 0), pct: 0.03, atDock: true },
    ],
  });

  assert.equal(departures.length, 1, 'detects the Mukilteo departure');
  assert.equal(departures[0].ms, departMs, 'uses the first atDock false sample as actual departure time');
  assert.equal(departures[0].direction, 'mukilteo-to-clinton');
  assert.equal(departures[0].fromTerminal, 'Mukilteo');
  assert.equal(departures[0].toTerminal, 'Clinton');
});

test('ferry history page — matched WSF actual departure can beat GPS departure sample', async () => {
  const { readFileSync } = await import('fs');
  const { dirname: dn, join: jn } = await import('path');
  const { fileURLToPath: fu } = await import('url');
  const dir = dn(fu(import.meta.url));
  const html = readFileSync(jn(dir, '..', 'public', 'ferry-history.html'), 'utf8');
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];

  const element = {
    style: {},
    hidden: false,
    textContent: '',
    innerHTML: '',
    value: '',
    addEventListener: () => {},
  };
  const context = {
    console,
    Date,
    URL,
    URLSearchParams,
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval: () => {},
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    document: {
      hidden: false,
      addEventListener: () => {},
      getElementById: () => element,
    },
    window: {
      location: {
        search: '',
        href: 'https://example.test/ferry-history',
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(script + `\nthis.__historyTest = { gpsObservedScheduleStats, tableTripRows };`, context);

  const scheduledMs = Date.UTC(2026, 5, 14, 22, 35);
  const wsfActualMs = Date.UTC(2026, 5, 14, 22, 53, 52);
  const gpsActualMs = Date.UTC(2026, 5, 14, 22, 54, 26);
  const stats = context.__historyTest.gpsObservedScheduleStats([{
    key: '68:Tokitae',
    name: 'Tokitae',
    points: [
      { ms: Date.UTC(2026, 5, 14, 22, 53, 26), pct: 0.99, atDock: true },
      { ms: gpsActualMs, pct: 0.99, atDock: false },
      { ms: Date.UTC(2026, 5, 14, 23, 10, 0), pct: 0.03, atDock: true },
    ],
  }], [{
    direction: 'mukilteo-to-clinton',
    fromTerminalName: 'Mukilteo',
    toTerminalName: 'Clinton',
    scheduledDepartureMs: scheduledMs,
    actualDepartureMs: wsfActualMs,
    vesselName: 'Tokitae',
  }]);
  const rows = context.__historyTest.tableTripRows(stats);

  assert.equal(rows.length, 1, 'builds one table row for the observed trip');
  assert.equal(rows[0].actualDepartureMs, wsfActualMs,
    'uses the earlier server-confirmed WSF actual departure over the later GPS sample');
});

test('ferry history page — lower table uses same resolved departure time as departure chips', async () => {
  const { readFileSync } = await import('fs');
  const { dirname: dn, join: jn } = await import('path');
  const { fileURLToPath: fu } = await import('url');
  const dir = dn(fu(import.meta.url));
  const html = readFileSync(jn(dir, '..', 'public', 'ferry-history.html'), 'utf8');
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];

  const element = { innerHTML: '', textContent: '', hidden: false, value: '', addEventListener: () => {} };
  const context = {
    console,
    Date,
    URL,
    URLSearchParams,
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval: () => {},
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    document: {
      hidden: false,
      addEventListener: () => {},
      getElementById: () => element,
    },
    window: {
      location: {
        search: '',
        href: 'https://example.test/ferry-history',
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(script + `\nthis.__historyTest = { gpsObservedScheduleStats, tableTripRows };`, context);

  const scheduledMs = Date.UTC(2026, 5, 14, 22, 35);
  const chipActualMs = Date.UTC(2026, 5, 14, 22, 53, 52);
  const gpsArtifactMs = Date.UTC(2026, 5, 14, 22, 57);
  const stats = context.__historyTest.gpsObservedScheduleStats([{
    key: '68:Tokitae',
    name: 'Tokitae',
    points: [
      { ms: Date.UTC(2026, 5, 14, 22, 53, 26), pct: 0.99, atDock: true },
      { ms: gpsArtifactMs, pct: 0.87, atDock: false },
      { ms: Date.UTC(2026, 5, 14, 23, 10, 0), pct: 0.03, atDock: true },
    ],
  }], [{
    direction: 'mukilteo-to-clinton',
    fromTerminalName: 'Mukilteo',
    toTerminalName: 'Clinton',
    scheduledDepartureMs: scheduledMs,
    actualDepartureMs: null,
    vesselName: 'Tokitae',
  }]);
  const rows = context.__historyTest.tableTripRows(stats, {
    [`14:${scheduledMs}`]: {
      isDeparted: true,
      effectiveDepartureMs: chipActualMs,
      timingSource: 'observed-departure',
      vesselName: 'Tokitae',
      vesselId: 68,
    },
  });

  assert.equal(rows.length, 1, 'builds one table row for the observed trip');
  assert.equal(rows[0].actualDepartureMs, chipActualMs,
    'uses the same resolved departure timestamp as the main departure chip');
});

test('config example — documents runtime and Google admin auth configuration', async () => {
  const { readFileSync } = await import('fs');
  const { dirname: dn, join: jn } = await import('path');
  const { fileURLToPath: fu } = await import('url');
  const dir = dn(fu(import.meta.url));
  const config = JSON.parse(readFileSync(jn(dir, '..', 'config.example.json'), 'utf8'));

  assert.equal(config.port, 3000, 'example has port');
  assert.ok(config.dataDir, 'example has dataDir');
  assert.ok(config.noaaStation, 'example has noaaStation');
  assert.equal(typeof config.lat, 'number', 'example has latitude');
  assert.equal(typeof config.lon, 'number', 'example has longitude');
  assert.ok(config.timezone, 'example has timezone');
  assert.ok(config.wsfApiKey, 'example has wsfApiKey placeholder');
  assert.equal(typeof config.wsfDepartingTerminal, 'number', 'example has departing terminal ID');
  assert.equal(typeof config.wsfArrivingTerminal, 'number', 'example has arriving terminal ID');
  assert.equal(typeof config.wsfRouteId, 'number', 'example has route ID');
  assert.equal(config.ferryHistoryRetentionDays, 30, 'example documents ferry history retention');
  assert.equal(config.ferryHistorySampleMs, 60000, 'example documents ferry history sampling interval');
  assert.equal(config.ferryHistoryDayStartHour, 2, 'example documents ferry history operational-day boundary');
  assert.ok('gaMeasurementId' in config, 'example documents optional Google Analytics ID');
  assert.ok(config.googleClientId, 'example has googleClientId placeholder');
  assert.ok(config.sessionSecret, 'example has sessionSecret placeholder');
  assert.ok(Array.isArray(config.adminUsers), 'example has adminUsers array');
  assert.ok(config.adminUsers.length > 0, 'example includes at least one admin email placeholder');
});

test('server config — accepts canonical CONFIG_JSON for Railway-style deploys', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'whidbey-dashboard-config-json-test-'));
  const port = 3012;
  const proc = spawn('node', [join(__dirname, '../server.js')], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      CONFIG_JSON: JSON.stringify({
        port,
        dataDir: tempDir,
        googleClientId: 'config-json-client-id',
        adminUsers: ['mike@example.com'],
      }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch(`http://localhost:${port}/api/config`);
        if (res.ok) {
          const json = await res.json();
          assert.equal(json.googleClientId, 'config-json-client-id');
          assert.equal(json.ferryHistorySampleMs, 60000);
          assert.equal(json.ferryHistoryDayStartHour, undefined);
          return;
        }
      } catch {}
      await sleep(300);
    }
    assert.fail('server did not start from CONFIG_JSON');
  } finally {
    proc.kill('SIGTERM');
    await sleep(500);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('static HTML — inline JavaScript parses without errors', async () => {
  const { readFileSync } = await import('fs');
  const { dirname: dn, join: jn } = await import('path');
  const { fileURLToPath: fu } = await import('url');
  const dir = dn(fu(import.meta.url));
  const html = readFileSync(jn(dir, '..', 'public', 'index.html'), 'utf8');
  const scriptMatch = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'found a <script> block');
  assert.doesNotThrow(() => new Function(scriptMatch[1]), 'inline JS should parse without syntax errors');
});

test('static HTML — ferry alerts render as a single scrolling ticker with title and detail', async () => {
  const { readFileSync } = await import('fs');
  const { dirname: dn, join: jn } = await import('path');
  const { fileURLToPath: fu } = await import('url');
  const dir = dn(fu(import.meta.url));
  const html = readFileSync(jn(dir, '..', 'public', 'index.html'), 'utf8');
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];

  const nullEl = { style: {}, className: '', textContent: '', innerHTML: '', querySelector: () => null };
  const context = {
    console,
    Date,
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval: () => {},
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    document: {
      getElementById: () => nullEl,
      querySelector: () => nullEl,
      createElement: () => ({}),
      head: { appendChild: () => {} },
    },
    window: {},
  };
  vm.createContext(context);
  vm.runInContext(script + `\nthis.__alertTest = { renderFerryAlerts };`, context);

  const alerts = [
    {
      title: 'One vessel canceled',
      text: 'The 8:30 PM sailing is canceled due to mechanical issues.',
    },
    { title: 'Pets', text: 'New pet rules effective May 20.' },
    { title: 'Low tide warning', text: 'Loading may be restricted.' },
    {
      title: 'Construction activity at Clinton terminal June 8 - July 3',
      text: 'Construction activity at Clinton terminal June 8 - July 3.',
      additionalInfo: 'soil testing; operations continue',
      color: 'var(--danger)',
    },
    { title: 'Title-only advisory', text: '' },
    { title: 'Terminal status', text: '2 Hour Wait for Drivers' },
    { title: 'General notice', text: 'Good morning. How are you doing?' },
    { title: '', text: 'Dinner at 6:30.', color: 'orange', userMessage: true },
  ];
  const ticker = context.__alertTest.renderFerryAlerts(alerts);
  const visibleAlertText = (a) => {
    const title = String(a.title || '').trim();
    const detail = String(a.text || '').trim();
    const additionalInfo = String(a.additionalInfo || '').trim();
    const normalize = (value) => String(value).replace(/\s+/g, ' ').replace(/[.。]+$/g, '').trim();
    if (a.userMessage) return detail;
    const text = detail && normalize(detail) !== normalize(title) ? `${title || detail}: ${detail}` : (title || detail);
    return additionalInfo ? `${text} (${additionalInfo})` : text;
  };
  const visibleText = alerts
    .map(visibleAlertText)
    .join('   ');
  const expectedTickerDuration = Math.max(4, Math.round(visibleText.length / 15));
  assert.match(ticker, /ferry-alert-ticker/, 'renders one shared ticker container');
  assert.equal((ticker.match(/<div class="ferry-alert-ticker"/g) || []).length, 1, 'renders one ticker row for WSF and user messages together');
  assert.match(ticker, /ferry-alert-title/, 'renders title span');
  assert.match(ticker, /ferry-alert-detail/, 'renders detail span');
  assert.match(ticker, /<span class="ferry-alert-detail">Low tide warning: Loading may be restricted\.<\/span>/, 'meaningfully different detail uses title-colon-detail text');
  assert.doesNotMatch(ticker, /<span class="ferry-alert-title">Low tide warning<\/span>/, 'meaningfully different title is not rendered bold separately');
  assert.match(ticker, /Good morning\. How are you doing\?/, 'renders general WSF notice text');
  assert.match(ticker, /Dinner at 6:30\./, 'renders user-added crawl messages');
  assert.doesNotMatch(ticker, /Dinner at 6:30\.: Dinner at 6:30\./, 'user-added crawl messages are not formatted as duplicated title/detail text');
  assert.match(ticker, /Good morning\. How are you doing\?[\s\S]*Dinner at 6:30\./, 'user-added crawl messages are appended after WSF alerts before the wrap copy');
  assert.match(ticker, new RegExp(`--ticker-duration: ${expectedTickerDuration}s`), 'sets ticker speed from visible text at 15 cps');
  assert.equal((ticker.match(/ferry-alert-copy/g) || []).length, 2, 'duplicates content so the scroll wraps');
  assert.doesNotMatch(ticker, /ferry-alert-ticker danger/, 'mixed ticker does not make every alert red');
  assert.match(ticker, /ferry-alert-item danger[\s\S]*One vessel canceled/, 'disruptive alert item is red');
  assert.match(ticker, /ferry-alert-item(?! danger)[^>]*><span class="ferry-alert-detail">Pets: New pet rules effective May 20\./, 'informational all-routes item stays yellow');
  assert.match(ticker, /Construction activity at Clinton terminal June 8 - July 3 \(soil testing; operations continue\)/, 'deterministic additional info renders as parenthetical');
  assert.match(ticker, /ferry-alert-item" style="color: var\(--danger\)"/, 'editable alert context color renders as item color');
  assert.match(ticker, /ferry-alert-item user-message" style="color: orange"><span class="ferry-alert-detail">Dinner at 6:30\./, 'user message color renders as item color');
  assert.equal(
    (ticker.match(/Construction activity at Clinton terminal June 8 - July 3/g) || []).length,
    2,
    'trailing punctuation differences do not duplicate alert title/detail within each ticker copy'
  );
  assert.match(html, /\.ferry-alert-item\s*\{[\s\S]*?color:\s*inherit;/, 'alert item text inherits ticker severity color');
  assert.match(html, /\.ferry-alert-item\.danger\s*\{[\s\S]*?color:\s*var\(--danger\);/, 'only disruptive alert items use danger red');
  assert.match(html, /\.ferry-alert-item\.user-message\s*\{[\s\S]*?color:\s*var\(--accent\);/, 'user-added crawl messages use dashboard heading blue');
  assert.match(html, /\.ferry-alert-title\s*\{[\s\S]*?color:\s*inherit;/, 'alert titles use the ticker severity color');
  assert.match(html, /\.ferry-alert-detail\s*\{[\s\S]*?color:\s*inherit;/, 'alert details use the same severity color as titles');
  assert.match(html, /@media \(min-width:\s*1000px\) and \(min-height:\s*600px\)[\s\S]*?\.ferry-alert-item\s*\{[\s\S]*?font-size:\s*1\.56rem;/, 'large displays double the ferry crawl font size');
});

test('static HTML — ferry ticker scrolls by measured copy width', async () => {
  const { readFileSync } = await import('fs');
  const { dirname: dn, join: jn } = await import('path');
  const { fileURLToPath: fu } = await import('url');
  const dir = dn(fu(import.meta.url));
  const html = readFileSync(jn(dir, '..', 'public', 'index.html'), 'utf8');

  assert.match(html, /--ticker-copy-width/, 'pins both ticker copies to one measured width');
  assert.match(html, /--ticker-translate/, 'uses a measured pixel distance for the loop');
  assert.doesNotMatch(html, /to\s*\{\s*transform:\s*translateX\(-50%\)/, 'does not animate by percentage width');
});

test('static HTML — ferry alert refresh swaps at the marquee loop boundary', async () => {
  const { readFileSync } = await import('fs');
  const { dirname: dn, join: jn } = await import('path');
  const { fileURLToPath: fu } = await import('url');
  const dir = dn(fu(import.meta.url));
  const html = readFileSync(jn(dir, '..', 'public', 'index.html'), 'utf8');

  assert.match(html, /currentFerryAlertSignature/, 'tracks current visible alert text');
  assert.match(html, /pendingFerryAlerts/, 'queues changed alert text instead of snapping mid-scroll');
  assert.match(html, /animationiteration/, 'applies queued alert text at the loop boundary');
  assert.match(html, /signature === currentFerryAlertSignature/, 'unchanged polls do not rebuild the ticker');
});

test('late ferry logic — inbound arrival enforces 15 minute turn-around and red delayed card', async () => {
  const { readFileSync } = await import('fs');
  const { dirname: dn, join: jn } = await import('path');
  const { fileURLToPath: fu } = await import('url');
  const dir = dn(fu(import.meta.url));
  const html = readFileSync(jn(dir, '..', 'public', 'index.html'), 'utf8');
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];

  const fixedNow = Date.UTC(2026, 4, 13, 23, 35); // 4:35 PM PDT-ish for relative math
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  }
  Object.assign(FakeDate, Date);

  const nullEl = { style: {}, className: '', textContent: '', innerHTML: '', querySelector: () => null };
  const context = {
    console,
    Date: FakeDate,
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval: () => {},
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    document: {
      getElementById: () => nullEl,
      querySelector: () => nullEl,
      createElement: () => ({}),
      head: { appendChild: () => {} },
    },
    window: {},
  };
  vm.createContext(context);
  vm.runInContext(script + `\nthis.__lateTest = { buildVesselMap, getSailingTiming, buildDisplayList, sailingCard };`, context);

  const schedMs = fixedNow - 5 * 60 * 1000;      // scheduled 5 min ago
  const etaMs = fixedNow + 25 * 60 * 1000;        // inbound arrival in 25 min
  const sailing = { sailTime: new Date(schedMs), DepartingTime: `/Date(${schedMs})/` };
  const later = { sailTime: new Date(fixedNow + 120 * 60 * 1000), DepartingTime: `/Date(${fixedNow + 120 * 60 * 1000})/` };
  const vesselMap = context.__lateTest.buildVesselMap({ vessels: [{
    vesselName: 'Test Boat',
    inService: true,
    atDock: false,
    departingTerminalId: 14,
    arrivingTerminalId: 5,
    etaMs,
  }] });

  const timing = context.__lateTest.getSailingTiming(sailing, vesselMap, 5);
  assert.equal(timing.effectiveMs, etaMs + 15 * 60 * 1000, 'departure estimate is ETA + 15 min');
  assert.ok(timing.lateInfo.delayMs > 5 * 60 * 1000, 'marked late beyond threshold');

  const list = context.__lateTest.buildDisplayList([sailing, later], vesselMap, 5);
  assert.equal(list[0], sailing, 'late-but-not-departed sailing remains the next displayed sailing');

  const card = context.__lateTest.sailingCard(sailing, [sailing, later], {}, vesselMap, 5);
  assert.match(card, /sail-time-est/, 'renders estimated time');
  assert.match(card, /sail-time-sched">\(was /, 'renders original time as parenthetical below');
  assert.match(card, /sail-vessel">Test Boat<\/div>/, 'keeps the matched vessel name on delayed card');
  assert.doesNotMatch(card, /Delayed/, 'does not render redundant delayed status text');
});

test('late ferry logic — a full (no drive-up space) upcoming sailing is flagged red', async () => {
  const { readFileSync } = await import('fs');
  const { dirname: dn, join: jn } = await import('path');
  const { fileURLToPath: fu } = await import('url');
  const dir = dn(fu(import.meta.url));
  const html = readFileSync(jn(dir, '..', 'public', 'index.html'), 'utf8');
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];

  const fixedNow = Date.UTC(2026, 5, 12, 15, 0);
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  }
  Object.assign(FakeDate, Date);

  const nullEl = { style: {}, className: '', textContent: '', innerHTML: '', querySelector: () => null };
  const context = {
    console,
    Date: FakeDate,
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval: () => {},
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    document: {
      getElementById: () => nullEl,
      querySelector: () => nullEl,
      createElement: () => ({}),
      head: { appendChild: () => {} },
    },
    window: {},
  };
  vm.createContext(context);
  vm.runInContext(script + `\nthis.__lateTest = { buildVesselMap, sailingCard };`, context);

  const fullMs = fixedNow + 20 * 60 * 1000;  // upcoming, no drive-up space
  const openMs = fixedNow + 50 * 60 * 1000;  // upcoming, space available
  const sailings = [fullMs, openMs].map(ms => ({ sailTime: new Date(ms), DepartingTime: `/Date(${ms})/` }));
  const spaceMap = {
    [String(fullMs)]: { maxSpaces: 100, driveUpSpaces: 0 },
    [String(openMs)]: { maxSpaces: 100, driveUpSpaces: 40 },
  };
  const vesselMap = context.__lateTest.buildVesselMap({ vessels: [] });

  const fullCard = context.__lateTest.sailingCard(sailings[0], sailings, spaceMap, vesselMap, 5);
  const openCard = context.__lateTest.sailingCard(sailings[1], sailings, spaceMap, vesselMap, 5);

  assert.match(fullCard, /sail-fill-label" style="color:var\(--danger\)">Full</, 'full sailing labels drive-up space as Full in danger red');
  assert.match(fullCard, /background:#ef4444/, 'full sailing fill bar is red at capacity');
  assert.match(openCard, /sail-fill-label[^>]*>40 open</, 'a sailing with space shows the open count');
  assert.doesNotMatch(openCard, /color:var\(--danger\)/, 'a sailing with space is not flagged red');
});

test('late ferry logic — current vessel position does not resurrect old morning sailings', async () => {
  const { readFileSync } = await import('fs');
  const { dirname: dn, join: jn } = await import('path');
  const { fileURLToPath: fu } = await import('url');
  const dir = dn(fu(import.meta.url));
  const html = readFileSync(jn(dir, '..', 'public', 'index.html'), 'utf8');
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];

  const fixedNow = Date.UTC(2026, 5, 8, 0, 27); // 5:27 PM PDT
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  }
  Object.assign(FakeDate, Date);

  const nullEl = { style: {}, className: '', textContent: '', innerHTML: '', querySelector: () => null };
  const context = {
    console,
    Date: FakeDate,
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval: () => {},
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    document: {
      getElementById: () => nullEl,
      querySelector: () => nullEl,
      createElement: () => ({}),
      head: { appendChild: () => {} },
    },
    window: {},
  };
  vm.createContext(context);
  vm.runInContext(script + `\nthis.__lateTest = { buildVesselMap, buildDisplayList };`, context);

  const morningMs = Date.UTC(2026, 5, 7, 13, 0); // 6:00 AM PDT
  const priorMs = Date.UTC(2026, 5, 8, 0, 10);   // 5:10 PM PDT
  const nextMs = Date.UTC(2026, 5, 8, 0, 40);    // 5:40 PM PDT
  const laterMs = Date.UTC(2026, 5, 8, 1, 10);   // 6:10 PM PDT
  const sailings = [morningMs, priorMs, nextMs, laterMs].map(ms => ({
    sailTime: new Date(ms),
    DepartingTime: `/Date(${ms})/`,
  }));
  const vesselMap = context.__lateTest.buildVesselMap({ vessels: [{
    vesselName: 'Test Boat',
    inService: true,
    atDock: true,
    departingTerminalId: 14,
    arrivingTerminalId: 5,
    scheduledDepartureMs: laterMs,
  }] });

  const list = context.__lateTest.buildDisplayList(sailings, vesselMap, 14);
  assert.equal(list[0].sailTime.getTime(), priorMs, 'last departed is the prior evening sailing');
  assert.ok(!list.some(s => s.sailTime.getTime() === morningMs), 'old morning sailing is not shown as late');
});

test('late ferry logic — vessel scheduled departure does not delay nearby earlier sailing', async () => {
  const { readFileSync } = await import('fs');
  const { dirname: dn, join: jn } = await import('path');
  const { fileURLToPath: fu } = await import('url');
  const dir = dn(fu(import.meta.url));
  const html = readFileSync(jn(dir, '..', 'public', 'index.html'), 'utf8');
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];

  const fixedNow = Date.UTC(2026, 5, 8, 12, 50); // 5:50 AM PDT
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  }
  Object.assign(FakeDate, Date);

  const nullEl = { style: {}, className: '', textContent: '', innerHTML: '', querySelector: () => null };
  const context = {
    console,
    Date: FakeDate,
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval: () => {},
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    document: {
      getElementById: () => nullEl,
      querySelector: () => nullEl,
      createElement: () => ({}),
      head: { appendChild: () => {} },
    },
    window: {},
  };
  vm.createContext(context);
  vm.runInContext(script + `\nthis.__lateTest = { buildVesselMap, computeSailingTimings };`, context);

  const earlierMs = Date.UTC(2026, 5, 8, 12, 30); // 5:30 AM PDT
  const nextMs = Date.UTC(2026, 5, 8, 13, 0);     // 6:00 AM PDT
  const sailings = [earlierMs, nextMs].map(ms => ({
    sailTime: new Date(ms),
    DepartingTime: `/Date(${ms})/`,
  }));
  const vesselMap = context.__lateTest.buildVesselMap({ vessels: [{
    vesselName: 'Tokitae',
    inService: true,
    atDock: true,
    departingTerminalId: 5,
    arrivingTerminalId: 14,
    scheduledDepartureMs: nextMs,
  }] });

  const timings = context.__lateTest.computeSailingTimings(sailings, vesselMap, 5);
  assert.equal(timings[0].effectiveMs, earlierMs, 'nearby earlier sailing keeps its scheduled time');
  assert.equal(timings[0].lateInfo, null, 'nearby earlier sailing is not marked delayed');
  assert.equal(timings[1].effectiveMs, nextMs, 'exact scheduled sailing still matches normally');
});

test('late ferry logic — small departure jitter does not propagate to later sailings', async () => {
  const { readFileSync } = await import('fs');
  const { dirname: dn, join: jn } = await import('path');
  const { fileURLToPath: fu } = await import('url');
  const dir = dn(fu(import.meta.url));
  const html = readFileSync(jn(dir, '..', 'public', 'index.html'), 'utf8');
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];

  const fixedNow = Date.UTC(2026, 5, 9, 14, 41); // 7:41 AM PDT
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  }
  Object.assign(FakeDate, Date);

  const nullEl = { style: {}, className: '', textContent: '', innerHTML: '', querySelector: () => null };
  const context = {
    console,
    Date: FakeDate,
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval: () => {},
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    document: {
      getElementById: () => nullEl,
      querySelector: () => nullEl,
      createElement: () => ({}),
      head: { appendChild: () => {} },
    },
    window: {},
  };
  vm.createContext(context);
  vm.runInContext(script + `\nthis.__lateTest = { buildVesselMap, computeSailingTimings, buildDisplayList, sailingCard };`, context);

  const firstMs = Date.UTC(2026, 5, 9, 14, 30);  // 7:30 AM PDT
  const secondMs = Date.UTC(2026, 5, 9, 15, 0);  // 8:00 AM PDT
  const thirdMs = Date.UTC(2026, 5, 9, 15, 30);  // 8:30 AM PDT
  const sailings = [firstMs, secondMs, thirdMs].map(ms => ({
    sailTime: new Date(ms),
    DepartingTime: `/Date(${ms})/`,
  }));
  const vesselMap = context.__lateTest.buildVesselMap({ vessels: [{
    vesselName: 'Suquamish',
    inService: true,
    atDock: false,
    departingTerminalId: 5,
    arrivingTerminalId: 14,
    leftDockMs: firstMs + 3 * 60 * 1000,
  }] });

  const timings = context.__lateTest.computeSailingTimings(sailings, vesselMap, 5);
  assert.equal(timings[0].effectiveMs, firstMs + 3 * 60 * 1000, 'minor actual departure jitter can confirm the just-departed sailing');
  assert.equal(timings[0].lateInfo, null, 'minor actual departure jitter is not marked late');
  assert.equal(timings[1].effectiveMs, secondMs, 'minor actual departure jitter does not move the next sailing');
  assert.equal(timings[1].lateInfo, null, 'next sailing remains normal');

  const list = context.__lateTest.buildDisplayList(sailings, vesselMap, 5);
  assert.equal(list[0].sailTime.getTime(), firstMs, 'last departed card remains the 7:30 sailing');
  assert.equal(list[1].sailTime.getTime(), secondMs, 'next card remains the scheduled 8:00 sailing');

  const card = context.__lateTest.sailingCard(sailings[1], sailings, {}, vesselMap, 5);
  assert.match(card, /<div class="sail-time">8:00 AM<\/div>/, 'renders the next sailing at scheduled time');
  assert.doesNotMatch(card, /was 8:00 AM/, 'does not render a false delay parenthetical');
});

test('late ferry logic — server-confirmed departure overrides raw client inference', async () => {
  const { readFileSync } = await import('fs');
  const { dirname: dn, join: jn } = await import('path');
  const { fileURLToPath: fu } = await import('url');
  const dir = dn(fu(import.meta.url));
  const html = readFileSync(jn(dir, '..', 'public', 'index.html'), 'utf8');
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];

  const fixedNow = Date.UTC(2026, 5, 9, 14, 41); // 7:41 AM PDT
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  }
  Object.assign(FakeDate, Date);

  const nullEl = { style: {}, className: '', textContent: '', innerHTML: '', querySelector: () => null };
  const context = {
    console,
    Date: FakeDate,
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval: () => {},
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    document: {
      getElementById: () => nullEl,
      querySelector: () => nullEl,
      createElement: () => ({}),
      head: { appendChild: () => {} },
    },
    window: {},
  };
  vm.createContext(context);
  vm.runInContext(script + `\nthis.__lateTest = { buildVesselMap, computeSailingTimings, buildDisplayList, sailingCard };`, context);

  const firstMs = Date.UTC(2026, 5, 9, 14, 30);  // 7:30 AM PDT
  const secondMs = Date.UTC(2026, 5, 9, 15, 0);  // 8:00 AM PDT
  const actualDepartureMs = firstMs + 3 * 60 * 1000;
  const sailings = [firstMs, secondMs].map(ms => ({
    sailTime: new Date(ms),
    DepartingTime: `/Date(${ms})/`,
  }));
  const vesselMap = context.__lateTest.buildVesselMap({ vessels: [] }, {
    departures: {
      [`5:${firstMs}`]: {
        departed: true,
        fromTerminalId: 5,
        toTerminalId: 14,
        scheduledDepartureMs: firstMs,
        actualDepartureMs,
        vesselName: 'Suquamish',
        vesselId: 123,
      },
    },
  });

  const timings = context.__lateTest.computeSailingTimings(sailings, vesselMap, 5);
  assert.equal(timings[0].effectiveMs, actualDepartureMs, 'uses the server-confirmed actual departure');
  assert.equal(timings[0].vessel.vesselName, 'Suquamish', 'uses vessel identity from the server departure signal');
  assert.equal(timings[1].effectiveMs, secondMs, 'server-confirmed prior departure does not move the next sailing');

  const list = context.__lateTest.buildDisplayList(sailings, vesselMap, 5);
  assert.equal(list[0].sailTime.getTime(), firstMs, 'server-confirmed departed sailing is the history card');
  assert.equal(list[1].sailTime.getTime(), secondMs, 'next sailing remains scheduled');

  const card = context.__lateTest.sailingCard(sailings[0], sailings, {}, vesselMap, 5);
  assert.match(card, /departed-confirmed/, 'server-confirmed departure marks the card departed');
  assert.match(card, /sail-vessel">Suquamish<\/div>/, 'renders server-confirmed vessel name');
});

test('late ferry logic — live resolved departure table uses server effective departure time', async () => {
  const { readFileSync } = await import('fs');
  const { dirname: dn, join: jn } = await import('path');
  const { fileURLToPath: fu } = await import('url');
  const dir = dn(fu(import.meta.url));
  const html = readFileSync(jn(dir, '..', 'public', 'index.html'), 'utf8');
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];

  const fixedNow = Date.UTC(2026, 5, 14, 23, 0); // 4:00 PM PDT
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  }
  Object.assign(FakeDate, Date);

  const nullEl = { style: {}, className: '', textContent: '', innerHTML: '', querySelector: () => null };
  const context = {
    console,
    Date: FakeDate,
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval: () => {},
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    document: {
      getElementById: () => nullEl,
      querySelector: () => nullEl,
      createElement: () => ({}),
      head: { appendChild: () => {} },
    },
    window: {},
  };
  vm.createContext(context);
  vm.runInContext(script + `\nthis.__lateTest = { buildVesselMap, computeSailingTimings, sailingCard };`, context);

  const scheduledMs = Date.UTC(2026, 5, 14, 22, 35); // 3:35 PM PDT
  const actualMs = Date.UTC(2026, 5, 14, 22, 53, 52);
  const laterGpsMs = Date.UTC(2026, 5, 14, 22, 57);
  const sailings = [{
    sailTime: new Date(scheduledMs),
    DepartingTime: `/Date(${scheduledMs})/`,
  }];
  const vesselMap = context.__lateTest.buildVesselMap(null, {
    resolvedSailings: {
      [`14:${scheduledMs}`]: {
        direction: 'mukilteo-to-clinton',
        fromTerminalId: 14,
        toTerminalId: 5,
        scheduledDepartureMs: scheduledMs,
        effectiveDepartureMs: actualMs,
        delayMs: actualMs - scheduledMs,
        status: 'departed',
        timingSource: 'observed-departure',
        isDeparted: true,
        vesselName: 'Tokitae',
        vesselId: 68,
      },
    },
    departures: {
      [`14:${scheduledMs}`]: {
        departed: true,
        fromTerminalId: 14,
        toTerminalId: 5,
        scheduledDepartureMs: scheduledMs,
        actualDepartureMs: laterGpsMs,
        vesselName: 'Tokitae',
        vesselId: 68,
      },
    },
  });

  const [timing] = context.__lateTest.computeSailingTimings(sailings, vesselMap, 14);
  assert.equal(timing.effectiveMs, actualMs, 'uses the live resolvedSailings time, not a later legacy GPS timestamp');

  const card = context.__lateTest.sailingCard(sailings[0], sailings, {}, vesselMap, 14);
  assert.match(card, /3:53 PM/, 'renders the earlier server-resolved actual departure in the main table chip');
  assert.doesNotMatch(card, /3:57 PM/, 'does not render the later GPS-zone or refresh artifact');
});

test('late ferry logic — server-reported missed departure renders as missed chip', async () => {
  const { readFileSync } = await import('fs');
  const { dirname: dn, join: jn } = await import('path');
  const { fileURLToPath: fu } = await import('url');
  const dir = dn(fu(import.meta.url));
  const html = readFileSync(jn(dir, '..', 'public', 'index.html'), 'utf8');
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];

  const fixedNow = Date.UTC(2026, 5, 9, 15, 45); // 8:45 AM PDT
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  }
  Object.assign(FakeDate, Date);

  const nullEl = { style: {}, className: '', textContent: '', innerHTML: '', querySelector: () => null };
  const context = {
    console,
    Date: FakeDate,
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval: () => {},
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    document: {
      getElementById: () => nullEl,
      querySelector: () => nullEl,
      createElement: () => ({}),
      head: { appendChild: () => {} },
    },
    window: {},
  };
  vm.createContext(context);
  vm.runInContext(script + `\nthis.__lateTest = { buildVesselMap, sailingCard };`, context);

  const missedMs = Date.UTC(2026, 5, 9, 15, 0); // 8:00 AM PDT
  const nextMs = Date.UTC(2026, 5, 9, 15, 30);   // 8:30 AM PDT
  const sailings = [missedMs, nextMs].map(ms => ({
    sailTime: new Date(ms),
    DepartingTime: `/Date(${ms})/`,
  }));
  const vesselMap = context.__lateTest.buildVesselMap({ vessels: [] }, {
    missedDepartures: {
      [`5:${missedMs}`]: {
        missed: true,
        source: 'gps-sequence',
        fromTerminalId: 5,
        toTerminalId: 14,
        scheduledDepartureMs: missedMs,
      },
    },
  });
  const spaceMap = {
    [String(missedMs)]: { maxSpaces: 100, driveUpSpaces: 25 },
  };

  const card = context.__lateTest.sailingCard(sailings[0], sailings, spaceMap, vesselMap, 5);
  assert.match(card, /missed-departure/, 'uses the missed departure class');
  assert.match(card, /<div class="sail-status">Missed<\/div>/, 'labels the skipped schedule slot missed');
  assert.doesNotMatch(card, /departed-unknown/, 'does not leave server-reported misses as ambiguous departures');
  assert.doesNotMatch(card, /sail-fill-wrap/, 'does not show stale capacity on missed trips');
});

test('late ferry logic — server-reported returning vessel renders as returning chip', async () => {
  const { readFileSync } = await import('fs');
  const { dirname: dn, join: jn } = await import('path');
  const { fileURLToPath: fu } = await import('url');
  const dir = dn(fu(import.meta.url));
  const html = readFileSync(jn(dir, '..', 'public', 'index.html'), 'utf8');
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];

  const fixedNow = Date.UTC(2026, 5, 9, 15, 45); // 8:45 AM PDT
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  }
  Object.assign(FakeDate, Date);

  const nullEl = { style: {}, className: '', textContent: '', innerHTML: '', querySelector: () => null };
  const context = {
    console,
    Date: FakeDate,
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval: () => {},
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    document: {
      getElementById: () => nullEl,
      querySelector: () => nullEl,
      createElement: () => ({}),
      head: { appendChild: () => {} },
    },
    window: {},
  };
  vm.createContext(context);
  vm.runInContext(script + `\nthis.__lateTest = { buildVesselMap, sailingCard };`, context);

  const returningMs = Date.UTC(2026, 5, 9, 15, 35); // 8:35 AM PDT
  const sailings = [{
    sailTime: new Date(returningMs),
    DepartingTime: `/Date(${returningMs})/`,
  }];
  const vesselMap = context.__lateTest.buildVesselMap({ vessels: [] }, {
    resolvedSailings: {
      [`5:${returningMs}`]: {
        status: 'returning',
        fromTerminalId: 5,
        toTerminalId: 14,
        scheduledDepartureMs: returningMs,
        effectiveDepartureMs: returningMs,
        displayScheduledMs: returningMs,
        vesselName: 'Tokitae',
        vesselId: 68,
      },
    },
  });

  const card = context.__lateTest.sailingCard(sailings[0], sailings, {}, vesselMap, 5);
  assert.match(card, /class="sailing returning"/, 'uses the returning class');
  assert.match(card, /<div class="sail-status">Returning<\/div>/, 'labels the chip returning');
  assert.match(card, /sail-vessel">Tokitae<\/div>/, 'keeps the returning vessel label');
});

test('late ferry logic — live inbound vessel suppresses schedule-derived missed/departed labels', async () => {
  const { readFileSync } = await import('fs');
  const { dirname: dn, join: jn } = await import('path');
  const { fileURLToPath: fu } = await import('url');
  const dir = dn(fu(import.meta.url));
  const html = readFileSync(jn(dir, '..', 'public', 'index.html'), 'utf8');
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];

  const fixedNow = Date.UTC(2026, 5, 19, 0, 50); // 5:50 PM PDT
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  }
  Object.assign(FakeDate, Date);

  const nullEl = { style: {}, className: '', textContent: '', innerHTML: '', querySelector: () => null };
  const context = {
    console,
    Date: FakeDate,
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval: () => {},
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    document: {
      getElementById: () => nullEl,
      querySelector: () => nullEl,
      createElement: () => ({}),
      head: { appendChild: () => {} },
    },
    window: {},
  };
  vm.createContext(context);
  vm.runInContext(script + `\nthis.__lateTest = { buildVesselMap, sailingCard };`, context);

  const overdueMs = Date.UTC(2026, 5, 19, 0, 35); // 5:35 PM PDT
  const nextMs = Date.UTC(2026, 5, 19, 1, 45);
  const projectedMs = Date.UTC(2026, 5, 19, 1, 5);
  const sailings = [overdueMs, nextMs].map(ms => ({
    sailTime: new Date(ms),
    DepartingTime: `/Date(${ms})/`,
    VesselName: ms === overdueMs ? 'Tacoma' : 'Wenatchee',
  }));
  const vesselMap = context.__lateTest.buildVesselMap({ vessels: [] }, {
    resolvedSailings: {
      [`3:${overdueMs}`]: {
        status: 'missed',
        fromTerminalId: 3,
        toTerminalId: 7,
        scheduledDepartureMs: overdueMs,
        effectiveDepartureMs: overdueMs,
        displayScheduledMs: overdueMs,
        vesselName: 'Tacoma',
        vesselId: 13,
        isMissed: true,
      },
    },
    vesselStatuses: {
      tacoma: {
        vesselName: 'Tacoma',
        vesselId: 13,
        status: 'underway-to-bainbridge',
        availableTerminalId: 3,
        availableMs: projectedMs,
        basis: 'gps-vessel-state',
      },
    },
  });

  const card = context.__lateTest.sailingCard(sailings[0], sailings, {}, vesselMap, 3);
  assert.doesNotMatch(card, /Departed\?/, 'does not mark the inbound vessel as ambiguously departed');
  assert.doesNotMatch(card, /<div class="sail-status">Missed<\/div>/, 'does not let schedule-derived missed status outrank live GPS');
  assert.match(card, /sail-time-est-route">~6:05 PM<\/span>/, 'shows the GPS-projected departure time');
  assert.match(card, /<div class="sail-status">▶ Next<\/div>/, 'keeps the overdue inbound vessel as the next effective departure');
});

test('late ferry logic — overtaken missed slot does not propagate lateness to next chip', async () => {
  const { readFileSync } = await import('fs');
  const { dirname: dn, join: jn } = await import('path');
  const { fileURLToPath: fu } = await import('url');
  const dir = dn(fu(import.meta.url));
  const html = readFileSync(jn(dir, '..', 'public', 'index.html'), 'utf8');
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];

  const fixedNow = Date.UTC(2026, 5, 12, 15, 45); // 8:45 AM PDT
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  }
  Object.assign(FakeDate, Date);

  const nullEl = { style: {}, className: '', textContent: '', innerHTML: '', querySelector: () => null };
  const context = {
    console,
    Date: FakeDate,
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval: () => {},
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    document: {
      getElementById: () => nullEl,
      querySelector: () => nullEl,
      createElement: () => ({}),
      head: { appendChild: () => {} },
    },
    window: {},
  };
  vm.createContext(context);
  vm.runInContext(script + `\nthis.__lateTest = { buildVesselMap, sailingCard };`, context);

  const missedMs = Date.UTC(2026, 5, 12, 15, 0);   // 8:00 AM PDT
  const observedMs = Date.UTC(2026, 5, 12, 15, 30); // 8:30 AM PDT
  const nextMs = Date.UTC(2026, 5, 12, 16, 0);      // 9:00 AM PDT
  const sailings = [missedMs, observedMs, nextMs].map(ms => ({
    sailTime: new Date(ms),
    DepartingTime: `/Date(${ms})/`,
  }));
  const vesselMap = context.__lateTest.buildVesselMap({ vessels: [{
    vesselName: 'Scheduled Boat',
    inService: true,
    atDock: true,
    departingTerminalId: 5,
    arrivingTerminalId: 14,
    scheduledDepartureMs: nextMs,
    leftDockMs: null,
    etaMs: null,
  }] }, {
    departures: {
      [`5:${observedMs}`]: {
        departed: true,
        source: 'gps-sequence',
        fromTerminalId: 5,
        toTerminalId: 14,
        scheduledDepartureMs: observedMs,
        actualDepartureMs: observedMs,
        vesselName: 'Late Boat 3',
        vesselId: 203,
      },
    },
    missedDepartures: {
      [`5:${missedMs}`]: {
        missed: true,
        source: 'gps-sequence',
        fromTerminalId: 5,
        toTerminalId: 14,
        scheduledDepartureMs: missedMs,
      },
    },
  });

  const missedCard = context.__lateTest.sailingCard(sailings[0], sailings, {}, vesselMap, 5);
  const observedCard = context.__lateTest.sailingCard(sailings[1], sailings, {}, vesselMap, 5);
  const nextCard = context.__lateTest.sailingCard(sailings[2], sailings, {}, vesselMap, 5);

  assert.match(missedCard, /missed-departure/, 'overtaken schedule slot renders missed');
  assert.match(missedCard, /<div class="sail-status">Missed<\/div>/, 'overtaken chip is labeled missed');
  assert.match(observedCard, /departed-confirmed/, 'overtaking GPS departure renders as a confirmed departure');
  assert.match(observedCard, /sail-vessel">Late Boat 3<\/div>/, 'overtaking departure keeps its observed vessel label');
  assert.match(nextCard, /class="sailing next"/, 'following future chip remains the next sailing');
  assert.match(nextCard, /<div class="sail-time">9:00 AM<\/div>/, 'following chip keeps its scheduled time');
  assert.doesNotMatch(nextCard, /sail-time-est|sail-time-sched|was 9:00 AM/, 'following chip does not inherit the prior lateness');
});

test('late ferry logic — vessel forecast projects onto upcoming chips with no direct signal', async () => {
  const { readFileSync } = await import('fs');
  const { dirname: dn, join: jn } = await import('path');
  const { fileURLToPath: fu } = await import('url');
  const dir = dn(fu(import.meta.url));
  const html = readFileSync(jn(dir, '..', 'public', 'index.html'), 'utf8');
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];

  const fixedNow = Date.UTC(2026, 5, 10, 15, 30); // 8:30 AM PDT
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  }
  Object.assign(FakeDate, Date);

  const nullEl = { style: {}, className: '', textContent: '', innerHTML: '', querySelector: () => null };
  const context = {
    console,
    Date: FakeDate,
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval: () => {},
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    document: {
      getElementById: () => nullEl,
      querySelector: () => nullEl,
      createElement: () => ({}),
      head: { appendChild: () => {} },
    },
    window: {},
  };
  vm.createContext(context);
  vm.runInContext(script + `\nthis.__lateTest = { buildVesselMap, computeSailingTimings, sailingCard };`, context);

  const departedMs = Date.UTC(2026, 5, 10, 15, 0);  // 8:00 AM PDT — already departed (direct signal)
  const missedMs = Date.UTC(2026, 5, 10, 15, 25);   // 8:25 AM PDT — server-confirmed missed
  const nextMs = Date.UTC(2026, 5, 10, 15, 35);     // 8:35 AM PDT — upcoming, no direct signal
  const laterMs = Date.UTC(2026, 5, 10, 16, 5);     // 9:05 AM PDT — upcoming, no direct signal
  const sailings = [departedMs, missedMs, nextMs, laterMs].map(ms => ({
    sailTime: new Date(ms),
    DepartingTime: `/Date(${ms})/`,
  }));
  const vesselMap = context.__lateTest.buildVesselMap({ vessels: [{
    vesselName: 'Scheduled Boat',
    inService: true,
    atDock: true,
    departingTerminalId: 5,
    arrivingTerminalId: 14,
    scheduledDepartureMs: nextMs,
    leftDockMs: null,
    etaMs: null,
  }] }, {
    departures: {
      [`5:${departedMs}`]: {
        departed: true,
        fromTerminalId: 5,
        toTerminalId: 14,
        scheduledDepartureMs: departedMs,
        actualDepartureMs: departedMs + 20 * 60 * 1000,
        vesselName: 'Tokitae',
        vesselId: 68,
      },
    },
    missedDepartures: {
      [`5:${missedMs}`]: {
        missed: true,
        source: 'gps-sequence',
        fromTerminalId: 5,
        toTerminalId: 14,
        scheduledDepartureMs: missedMs,
      },
    },
    predictedDepartures: {
      [`5:${nextMs}`]: {
        direction: 'clinton-to-mukilteo',
        fromTerminalId: 5,
        toTerminalId: 14,
        scheduledDepartureMs: nextMs,
        projectedDepartureMs: nextMs + 20 * 60 * 1000,
        delayMs: 20 * 60 * 1000,
        vesselName: '',
        basis: 'gps-vessel-state',
      },
      [`5:${laterMs}`]: {
        direction: 'clinton-to-mukilteo',
        fromTerminalId: 5,
        toTerminalId: 14,
        scheduledDepartureMs: laterMs,
        projectedDepartureMs: laterMs + 20 * 60 * 1000,
        delayMs: 20 * 60 * 1000,
        vesselName: '',
        basis: 'gps-vessel-state',
      },
    },
  });

  const timings = context.__lateTest.computeSailingTimings(sailings, vesselMap, 5);
  const byMs = ms => timings.find(t => t.scheduledMs === ms);

  assert.equal(byMs(nextMs).propagatedDelayMs, 20 * 60 * 1000, 'upcoming chip uses the vessel forecast delay');
  assert.equal(byMs(nextMs).effectiveMs, nextMs + 20 * 60 * 1000, 'projected departure pushes the effective (countdown) time out');
  assert.equal(byMs(nextMs).routeDelayInfo.delayMs, 20 * 60 * 1000, 'exposes the vessel forecast delay for display');
  assert.equal(byMs(nextMs).hasDirectVesselSignal, false, 'a schedule-only WSF vessel assignment is not direct evidence');
  assert.equal(byMs(laterMs).propagatedDelayMs, 20 * 60 * 1000, 'later predicted chips use their own vessel forecast entries');
  assert.equal(byMs(departedMs).propagatedDelayMs, 0, 'a chip with a confirmed departure is not overwritten by the inferred delay');
  assert.equal(byMs(departedMs).effectiveMs, departedMs + 20 * 60 * 1000, 'departed chip keeps its actual departure time');
  assert.equal(byMs(missedMs).propagatedDelayMs, 0, 'a server-confirmed missed slot is never reframed as a late upcoming boat');

  const nextCard = context.__lateTest.sailingCard(sailings[2], sailings, {}, vesselMap, 5);
  assert.match(nextCard, /class="sail-time-est-route"/, 'forecast time uses the amber projected style, not the red confirmed-late style');
  assert.match(nextCard, /~8:55 AM/, 'shows the projected (tilde) departure time');
  assert.doesNotMatch(nextCard, /sail-route-delay|~20m late/, 'does not add a separate delay label');
  assert.match(nextCard, /\(sched 8:35 AM\)/, 'keeps the scheduled time visible for reference');
  assert.doesNotMatch(nextCard, /Scheduled Boat/, 'does not render a stale schedule-only vessel label on a delayed chip');
  assert.doesNotMatch(nextCard, /class="sail-time-est"/, 'does not use the red confirmed-late styling for an inferred delay');

  const missedCard = context.__lateTest.sailingCard(sailings[1], sailings, {}, vesselMap, 5);
  assert.match(missedCard, /<div class="sail-status">Missed<\/div>/, 'missed slot still renders as missed, with no route-delay note');
  assert.doesNotMatch(missedCard, /sail-route-delay/, 'missed slot does not show an inferred delay note');
});

test('late ferry logic — small projected departure drift renders as normal schedule time', async () => {
  const { readFileSync } = await import('fs');
  const { dirname: dn, join: jn } = await import('path');
  const { fileURLToPath: fu } = await import('url');
  const dir = dn(fu(import.meta.url));
  const html = readFileSync(jn(dir, '..', 'public', 'index.html'), 'utf8');
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];

  const fixedNow = Date.UTC(2026, 5, 10, 15, 30); // 8:30 AM PDT
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  }
  Object.assign(FakeDate, Date);

  const nullEl = { style: {}, className: '', textContent: '', innerHTML: '', querySelector: () => null };
  const context = {
    console,
    Date: FakeDate,
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval: () => {},
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    document: {
      getElementById: () => nullEl,
      querySelector: () => nullEl,
      createElement: () => ({}),
      head: { appendChild: () => {} },
    },
    window: {},
  };
  vm.createContext(context);
  vm.runInContext(script + `\nthis.__lateTest = { buildVesselMap, computeSailingTimings, sailingCard };`, context);

  const sailingMs = Date.UTC(2026, 5, 10, 15, 35); // 8:35 AM PDT
  const projectedMs = sailingMs + 4 * 60 * 1000;
  const sailing = {
    sailTime: new Date(sailingMs),
    DepartingTime: `/Date(${sailingMs})/`,
  };
  const vesselMap = context.__lateTest.buildVesselMap(null, {
    resolvedSailings: {
      [`5:${sailingMs}`]: {
        scheduledDepartureMs: sailingMs,
        effectiveDepartureMs: projectedMs,
        delayMs: projectedMs - sailingMs,
        status: 'projected',
        timingSource: 'gps-vessel-state',
        isProjected: true,
        isDeparted: false,
        isMissed: false,
        isUnknown: false,
        vesselName: 'Suquamish',
        vesselId: 75,
        vesselSource: 'predicted-departure',
      },
    },
  });

  const [timing] = context.__lateTest.computeSailingTimings([sailing], vesselMap, 5);
  assert.equal(timing.routeDelayInfo, null, 'sub-5-minute projected drift is not exposed for display');

  const card = context.__lateTest.sailingCard(sailing, [sailing], {}, vesselMap, 5);
  assert.match(card, /<div class="sail-time">8:35 AM<\/div>/, 'renders the scheduled time normally');
  assert.match(card, /sail-vessel">Suquamish<\/div>/, 'keeps the vessel name visible');
  assert.doesNotMatch(card, /sail-time-est-route|~8:39 AM|\(sched 8:35 AM\)/,
    'does not spend chip space on a small projected estimate');
});

// Regression for the screenshot bug: WSF's space rows labeled three consecutive
// half-hour Mukilteo→Clinton departures (7:35 / 8:05 / 8:35) all "Tokitae".
// One vessel cannot make three back-to-back same-direction crossings, so those
// low-confidence labels must not all render.
test('late ferry logic — a repeated space-row vessel is not shown on consecutive same-direction sailings', async () => {
  const { readFileSync } = await import('fs');
  const { dirname: dn, join: jn } = await import('path');
  const { fileURLToPath: fu } = await import('url');
  const dir = dn(fu(import.meta.url));
  const html = readFileSync(jn(dir, '..', 'public', 'index.html'), 'utf8');
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];

  const fixedNow = Date.UTC(2026, 5, 13, 2, 20); // 7:20 PM PDT
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  }
  Object.assign(FakeDate, Date);

  const nullEl = { style: {}, className: '', textContent: '', innerHTML: '', querySelector: () => null };
  const context = {
    console,
    Date: FakeDate,
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval: () => {},
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    document: {
      getElementById: () => nullEl,
      querySelector: () => nullEl,
      createElement: () => ({}),
      head: { appendChild: () => {} },
    },
    window: {},
  };
  vm.createContext(context);
  vm.runInContext(script + `\nthis.__lateTest = { buildVesselMap, sailingCard };`, context);

  const departedMs = Date.UTC(2026, 5, 13, 2, 5);   // 7:05 PM — Suquamish, confirmed departed
  const s735 = Date.UTC(2026, 5, 13, 2, 35);        // 7:35 PM — upcoming
  const s805 = Date.UTC(2026, 5, 13, 3, 5);         // 8:05 PM — upcoming
  const s835 = Date.UTC(2026, 5, 13, 3, 35);        // 8:35 PM — upcoming
  const sailings = [departedMs, s735, s805, s835].map(ms => ({
    sailTime: new Date(ms),
    DepartingTime: `/Date(${ms})/`,
  }));

  // The WSF space feed repeats "Tokitae" across all three upcoming departures.
  const spaceMap = {
    [String(departedMs)]: { vesselName: 'Suquamish', maxSpaces: 144, driveUpSpaces: 0 },
    [String(s735)]: { vesselName: 'Tokitae', maxSpaces: 144, driveUpSpaces: 98 },
    [String(s805)]: { vesselName: 'Tokitae', maxSpaces: 144, driveUpSpaces: 141 },
    [String(s835)]: { vesselName: 'Tokitae', maxSpaces: 144, driveUpSpaces: 141 },
  };

  const vesselMap = context.__lateTest.buildVesselMap({ vessels: [] }, {
    departures: {
      [`14:${departedMs}`]: {
        departed: true,
        fromTerminalId: 14,
        toTerminalId: 5,
        scheduledDepartureMs: departedMs,
        actualDepartureMs: departedMs + 8 * 60 * 1000,
        vesselName: 'Suquamish',
        vesselId: 1,
      },
    },
    predictedDepartures: {
      [`14:${s735}`]: {
        fromTerminalId: 14,
        toTerminalId: 5,
        direction: 'mukilteo-to-clinton',
        scheduledDepartureMs: s735,
        projectedDepartureMs: s735 + 8 * 60 * 1000,
        delayMs: 8 * 60 * 1000,
        vesselName: '',
        basis: 'gps-vessel-state',
      },
    },
  });

  const [departedCard, c735, c805, c835] =
    sailings.map(s => context.__lateTest.sailingCard(s, sailings, spaceMap, vesselMap, 14));

  // The confirmed departure keeps its real, directly-observed identity.
  assert.match(departedCard, /sail-vessel">Suquamish</, 'confirmed departed sailing keeps its real vessel name');

  // The forecast is surfaced by the amber projected time, not a separate "N min
  // late" status label.
  assert.match(c735, /class="sail-time-est-route"/, 'upcoming chip still shows the forecast through the projected time');
  assert.doesNotMatch(c735, /sail-route-delay|~8m late/, 'upcoming chip does not show a separate forecast-delay label');

  // The bug: Tokitae must not be stamped on every consecutive upcoming sailing.
  const tokitaeCount = [c735, c805, c835].filter(card => /sail-vessel">Tokitae</.test(card)).length;
  assert.equal(tokitaeCount, 0,
    'a low-confidence space label is dropped when it would repeat a vessel across physically impossible consecutive sailings');

  // Open-space counts are independent of the vessel label and remain visible.
  assert.match(c805, /141 open/, 'drive-up space is still shown even when the vessel label is suppressed');
});

// Guard against over-suppression: when the same vessel legitimately re-departs an
// hour later (two boats alternating on the half-hour schedule), both labels must
// survive — only physically-impossible repeats inside one round trip are dropped.
test('late ferry logic — alternating vessels on the half-hour schedule are preserved', async () => {
  const { readFileSync } = await import('fs');
  const { dirname: dn, join: jn } = await import('path');
  const { fileURLToPath: fu } = await import('url');
  const dir = dn(fu(import.meta.url));
  const html = readFileSync(jn(dir, '..', 'public', 'index.html'), 'utf8');
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];

  const fixedNow = Date.UTC(2026, 5, 13, 2, 20); // 7:20 PM PDT
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  }
  Object.assign(FakeDate, Date);

  const nullEl = { style: {}, className: '', textContent: '', innerHTML: '', querySelector: () => null };
  const context = {
    console,
    Date: FakeDate,
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval: () => {},
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    document: {
      getElementById: () => nullEl,
      querySelector: () => nullEl,
      createElement: () => ({}),
      head: { appendChild: () => {} },
    },
    window: {},
  };
  vm.createContext(context);
  vm.runInContext(script + `\nthis.__lateTest = { buildVesselMap, sailingCard };`, context);

  const s735 = Date.UTC(2026, 5, 13, 2, 35); // 7:35 PM — Tokitae
  const s805 = Date.UTC(2026, 5, 13, 3, 5);  // 8:05 PM — Suquamish
  const s835 = Date.UTC(2026, 5, 13, 3, 35); // 8:35 PM — Tokitae again (60 min after 7:35)
  const sailings = [s735, s805, s835].map(ms => ({
    sailTime: new Date(ms),
    DepartingTime: `/Date(${ms})/`,
  }));
  const spaceMap = {
    [String(s735)]: { vesselName: 'Tokitae', maxSpaces: 144, driveUpSpaces: 90 },
    [String(s805)]: { vesselName: 'Suquamish', maxSpaces: 144, driveUpSpaces: 90 },
    [String(s835)]: { vesselName: 'Tokitae', maxSpaces: 144, driveUpSpaces: 90 },
  };
  const vesselMap = context.__lateTest.buildVesselMap({ vessels: [] });

  const [c735, c805, c835] =
    sailings.map(s => context.__lateTest.sailingCard(s, sailings, spaceMap, vesselMap, 14));

  assert.match(c735, /sail-vessel">Tokitae</, 'first Tokitae sailing keeps its label');
  assert.match(c805, /sail-vessel">Suquamish</, 'the alternating Suquamish sailing keeps its label');
  assert.match(c835, /sail-vessel">Tokitae</, 'a legitimate same-vessel re-departure an hour later is preserved');
});

test('late ferry logic — moving substituted vessel outranks scheduled docked vessel', async () => {
  const { readFileSync } = await import('fs');
  const { dirname: dn, join: jn } = await import('path');
  const { fileURLToPath: fu } = await import('url');
  const dir = dn(fu(import.meta.url));
  const html = readFileSync(jn(dir, '..', 'public', 'index.html'), 'utf8');
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];

  const fixedNow = Date.UTC(2026, 5, 10, 4, 43); // 9:43 PM PDT
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  }
  Object.assign(FakeDate, Date);

  const nullEl = { style: {}, className: '', textContent: '', innerHTML: '', querySelector: () => null };
  const context = {
    console,
    Date: FakeDate,
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval: () => {},
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    document: {
      getElementById: () => nullEl,
      querySelector: () => nullEl,
      createElement: () => ({}),
      head: { appendChild: () => {} },
    },
    window: {},
  };
  vm.createContext(context);
  vm.runInContext(script + `\nthis.__lateTest = { buildVesselMap, computeSailingTimings, sailingCard };`, context);

  const sailingMs = Date.UTC(2026, 5, 10, 4, 30); // 9:30 PM PDT
  const leftDockMs = Date.UTC(2026, 5, 10, 4, 35, 42);
  const sailings = [{
    sailTime: new Date(sailingMs),
    DepartingTime: `/Date(${sailingMs})/`,
    VesselName: 'Suquamish',
  }];
  const vesselMap = context.__lateTest.buildVesselMap({ vessels: [
    {
      vesselId: 75,
      vesselName: 'Suquamish',
      inService: true,
      atDock: true,
      departingTerminalId: 5,
      arrivingTerminalId: 14,
      scheduledDepartureMs: sailingMs,
      leftDockMs: null,
      speed: 0,
    },
    {
      vesselId: 68,
      vesselName: 'Tokitae',
      inService: true,
      atDock: false,
      departingTerminalId: 5,
      arrivingTerminalId: null,
      scheduledDepartureMs: null,
      leftDockMs,
      speed: 15.1,
    },
  ] });

  const [timing] = context.__lateTest.computeSailingTimings(sailings, vesselMap, 5);
  assert.equal(timing.effectiveMs, leftDockMs, 'uses the moving vessel left-dock time');
  assert.equal(timing.vessel.vesselName, 'Tokitae', 'uses the moving substituted vessel instead of scheduled docked vessel');

  const card = context.__lateTest.sailingCard(sailings[0], sailings, {}, vesselMap, 5);
  assert.match(card, /sail-vessel">Tokitae<\/div>/, 'renders the moving substituted vessel on the card');
  assert.doesNotMatch(card, /sail-vessel">Suquamish<\/div>/, 'does not keep the stale scheduled vessel label');
});

test('late ferry logic — GPS vessel correction overrides stale scheduled vessel label', async () => {
  const { readFileSync } = await import('fs');
  const { dirname: dn, join: jn } = await import('path');
  const { fileURLToPath: fu } = await import('url');
  const dir = dn(fu(import.meta.url));
  const html = readFileSync(jn(dir, '..', 'public', 'index.html'), 'utf8');
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];

  const fixedNow = Date.UTC(2026, 5, 10, 6, 16); // 11:16 PM PDT
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  }
  Object.assign(FakeDate, Date);

  const nullEl = { style: {}, className: '', textContent: '', innerHTML: '', querySelector: () => null };
  const context = {
    console,
    Date: FakeDate,
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval: () => {},
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    document: {
      getElementById: () => nullEl,
      querySelector: () => nullEl,
      createElement: () => ({}),
      head: { appendChild: () => {} },
    },
    window: {},
  };
  vm.createContext(context);
  vm.runInContext(script + `\nthis.__lateTest = { buildVesselMap, sailingCard };`, context);

  const sailingMs = Date.UTC(2026, 5, 10, 6, 30); // 11:30 PM PDT
  const sailing = {
    sailTime: new Date(sailingMs),
    DepartingTime: `/Date(${sailingMs})/`,
    VesselName: 'Suquamish',
  };
  const vesselMap = context.__lateTest.buildVesselMap({ vessels: [] }, {
    vesselCorrections: {
      [`5:${sailingMs}`]: {
        vesselName: 'Tokitae',
        vesselId: 68,
        basis: 'recent-gps-chain',
      },
    },
  });
  const spaceMap = {
    [String(sailingMs)]: { vesselName: 'Suquamish', maxSpaces: 124, driveUpSpaces: 80 },
  };

  const card = context.__lateTest.sailingCard(sailing, [sailing], spaceMap, vesselMap, 5);
  assert.match(card, /sail-vessel">Tokitae<\/div>/, 'renders GPS-corrected vessel name on future schedule row');
  assert.doesNotMatch(card, /sail-vessel">Suquamish<\/div>/, 'does not show stale scheduled or space vessel name');
});

test('late ferry logic — regenerated vessel forecast overrides stale GPS-chain correction', async () => {
  const { readFileSync } = await import('fs');
  const { dirname: dn, join: jn } = await import('path');
  const { fileURLToPath: fu } = await import('url');
  const dir = dn(fu(import.meta.url));
  const html = readFileSync(jn(dir, '..', 'public', 'index.html'), 'utf8');
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];

  const fixedNow = Date.UTC(2026, 5, 13, 2, 55); // 7:55 PM PDT
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  }
  Object.assign(FakeDate, Date);

  const nullEl = { style: {}, className: '', textContent: '', innerHTML: '', querySelector: () => null };
  const context = {
    console,
    Date: FakeDate,
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval: () => {},
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    document: {
      getElementById: () => nullEl,
      querySelector: () => nullEl,
      createElement: () => ({}),
      head: { appendChild: () => {} },
    },
    window: {},
  };
  vm.createContext(context);
  vm.runInContext(script + `\nthis.__lateTest = { buildVesselMap, sailingCard };`, context);

  const sailingMs = Date.UTC(2026, 5, 13, 3, 5); // 8:05 PM PDT
  const projectedMs = Date.UTC(2026, 5, 13, 3, 11); // 8:11 PM PDT
  const sailing = {
    sailTime: new Date(sailingMs),
    DepartingTime: `/Date(${sailingMs})/`,
    VesselName: 'Tokitae',
  };
  const vesselMap = context.__lateTest.buildVesselMap(null, {
    vesselCorrections: {
      [`14:${sailingMs}`]: {
        vesselName: 'Tokitae',
        vesselId: 68,
        basis: 'recent-gps-chain',
      },
    },
    predictedDepartures: {
      [`14:${sailingMs}`]: {
        vesselName: 'Suquamish',
        vesselId: 106,
        scheduledDepartureMs: sailingMs,
        projectedDepartureMs: projectedMs,
        delayMs: projectedMs - sailingMs,
        basis: 'gps-vessel-forecast',
      },
    },
    resolvedVessels: {
      [`14:${sailingMs}`]: {
        vesselName: 'Suquamish',
        vesselId: 106,
        scheduledDepartureMs: sailingMs,
        source: 'predicted-departure',
      },
    },
    resolvedSailings: {
      [`14:${sailingMs}`]: {
        scheduledDepartureMs: sailingMs,
        effectiveDepartureMs: projectedMs,
        delayMs: projectedMs - sailingMs,
        status: 'projected',
        timingSource: 'gps-vessel-forecast',
        isProjected: true,
        isDeparted: false,
        isMissed: false,
        isUnknown: false,
        vesselName: 'Suquamish',
        vesselId: 106,
        vesselSource: 'predicted-departure',
      },
    },
  });

  const card = context.__lateTest.sailingCard(sailing, [sailing], {}, vesselMap, 14);
  assert.match(card, /sail-vessel">Suquamish<\/div>/, 'renders regenerated vessel forecast for the future row');
  assert.doesNotMatch(card, /sail-vessel">Tokitae<\/div>/, 'does not let stale GPS-chain correction override the forecast');
});

test('late ferry logic — projected chips keep the forecast time after it slips just into the past', async () => {
  const { readFileSync } = await import('fs');
  const { dirname: dn, join: jn } = await import('path');
  const { fileURLToPath: fu } = await import('url');
  const dir = dn(fu(import.meta.url));
  const html = readFileSync(jn(dir, '..', 'public', 'index.html'), 'utf8');
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];

  const sailingMs = Date.UTC(2026, 5, 13, 3, 5); // 8:05 PM PDT
  const projectedMs = Date.UTC(2026, 5, 13, 3, 11); // 8:11 PM PDT
  const fixedNow = projectedMs + 90 * 1000;
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  }
  Object.assign(FakeDate, Date);

  const nullEl = { style: {}, className: '', textContent: '', innerHTML: '', querySelector: () => null };
  const context = {
    console,
    Date: FakeDate,
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval: () => {},
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    document: {
      getElementById: () => nullEl,
      querySelector: () => nullEl,
      createElement: () => ({}),
      head: { appendChild: () => {} },
    },
    window: {},
  };
  vm.createContext(context);
  vm.runInContext(script + `\nthis.__lateTest = { buildVesselMap, sailingCard };`, context);

  const sailing = {
    sailTime: new Date(sailingMs),
    DepartingTime: `/Date(${sailingMs})/`,
  };
  const vesselMap = context.__lateTest.buildVesselMap(null, {
    resolvedSailings: {
      [`14:${sailingMs}`]: {
        scheduledDepartureMs: sailingMs,
        effectiveDepartureMs: projectedMs,
        delayMs: projectedMs - sailingMs,
        status: 'projected',
        timingSource: 'gps-vessel-state',
        isProjected: true,
        isDeparted: false,
        isMissed: false,
        isUnknown: false,
        vesselName: 'Suquamish',
        vesselId: 75,
        vesselSource: 'predicted-departure',
      },
    },
  });

  const card = context.__lateTest.sailingCard(sailing, [sailing], {}, vesselMap, 14);
  assert.match(card, /class="sail-time-est-route"/, 'keeps the projected style while the server still marks the row projected');
  assert.match(card, /~8:11 PM/, 'continues to show the projected time instead of snapping back to the scheduled time');
  assert.match(card, /\(sched 8:05 PM\)/, 'keeps the scheduled baseline visible');
  assert.doesNotMatch(card, /<div class="sail-time">8:05 PM<\/div>/, 'does not render the bare scheduled time for a stale projected row');
});

test('late ferry logic — direct delay does not propagate to later sailings', async () => {
  const { readFileSync } = await import('fs');
  const { dirname: dn, join: jn } = await import('path');
  const { fileURLToPath: fu } = await import('url');
  const dir = dn(fu(import.meta.url));
  const html = readFileSync(jn(dir, '..', 'public', 'index.html'), 'utf8');
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];

  const fixedNow = Date.UTC(2026, 5, 8, 0, 15); // 5:15 PM PDT
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  }
  Object.assign(FakeDate, Date);

  const nullEl = { style: {}, className: '', textContent: '', innerHTML: '', querySelector: () => null };
  const context = {
    console,
    Date: FakeDate,
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval: () => {},
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    document: {
      getElementById: () => nullEl,
      querySelector: () => nullEl,
      createElement: () => ({}),
      head: { appendChild: () => {} },
    },
    window: {},
  };
  vm.createContext(context);
  vm.runInContext(script + `\nthis.__lateTest = { buildVesselMap, computeSailingTimings, buildDisplayList, sailingCard };`, context);

  const firstMs = Date.UTC(2026, 5, 8, 0, 5);   // 5:05 PM PDT
  const secondMs = Date.UTC(2026, 5, 8, 0, 35); // 5:35 PM PDT
  const thirdMs = Date.UTC(2026, 5, 8, 1, 5);   // 6:05 PM PDT
  const sailings = [firstMs, secondMs, thirdMs].map(ms => ({
    sailTime: new Date(ms),
    DepartingTime: `/Date(${ms})/`,
  }));
  const vesselMap = context.__lateTest.buildVesselMap({ vessels: [{
    vesselName: 'Tokitae',
    inService: true,
    atDock: false,
    departingTerminalId: 14,
    arrivingTerminalId: 5,
    scheduledDepartureMs: firstMs,
    leftDockMs: Date.UTC(2026, 5, 8, 0, 40), // 5:40 PM PDT actual departure
  }] });

  const timings = context.__lateTest.computeSailingTimings(sailings, vesselMap, 14);
  assert.equal(timings[0].effectiveMs, Date.UTC(2026, 5, 8, 0, 40), 'first late sailing uses vessel estimate');
  assert.equal(timings[1].effectiveMs, secondMs, 'later sailing keeps its scheduled time');
  assert.equal(timings[2].effectiveMs, thirdMs, 'subsequent sailing also keeps its scheduled time');
  assert.equal(timings[1].lateInfo, null, 'later sailing is not marked delayed by the earlier departure');
  assert.equal(timings[2].lateInfo, null, 'subsequent sailing is not marked delayed by the earlier departure');

  const list = context.__lateTest.buildDisplayList(sailings, vesselMap, 14);
  assert.equal(list[0].sailTime.getTime(), firstMs, 'late first sailing remains the next card');

  const card = context.__lateTest.sailingCard(sailings[1], sailings, {}, vesselMap, 14);
  assert.match(card, /<div class="sail-time">5:35 PM<\/div>/, 'renders the later sailing at scheduled time');
  assert.doesNotMatch(card, /was 5:35 PM/, 'does not render propagated delay text on the later sailing');
});

test('late ferry logic — departed delayed sailing shows actual and scheduled times muted', async () => {
  const { readFileSync } = await import('fs');
  const { dirname: dn, join: jn } = await import('path');
  const { fileURLToPath: fu } = await import('url');
  const dir = dn(fu(import.meta.url));
  const html = readFileSync(jn(dir, '..', 'public', 'index.html'), 'utf8');
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];

  const fixedNow = Date.UTC(2026, 5, 8, 0, 50); // 5:50 PM PDT
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  }
  Object.assign(FakeDate, Date);

  const nullEl = { style: {}, className: '', textContent: '', innerHTML: '', querySelector: () => null };
  const context = {
    console,
    Date: FakeDate,
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval: () => {},
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    document: {
      getElementById: () => nullEl,
      querySelector: () => nullEl,
      createElement: () => ({}),
      head: { appendChild: () => {} },
    },
    window: {},
  };
  vm.createContext(context);
  vm.runInContext(script + `\nthis.__lateTest = { buildVesselMap, sailingCard };`, context);

  const scheduledMs = Date.UTC(2026, 5, 8, 0, 5); // 5:05 PM PDT
  const leftDockMs = Date.UTC(2026, 5, 8, 0, 40); // 5:40 PM PDT
  const nextMs = Date.UTC(2026, 5, 8, 1, 5);      // 6:05 PM PDT
  const sailing = { sailTime: new Date(scheduledMs), DepartingTime: `/Date(${scheduledMs})/` };
  const next = { sailTime: new Date(nextMs), DepartingTime: `/Date(${nextMs})/` };
  const vesselMap = context.__lateTest.buildVesselMap({ vessels: [{
    vesselName: 'Tokitae',
    inService: true,
    atDock: false,
    departingTerminalId: 14,
    arrivingTerminalId: 5,
    scheduledDepartureMs: scheduledMs,
    leftDockMs,
  }] });
  const spaceMap = {
    [String(scheduledMs)]: { maxSpaces: 100, driveUpSpaces: 0 },
  };

  const card = context.__lateTest.sailingCard(sailing, [sailing, next], spaceMap, vesselMap, 14);
  assert.match(card, /departed-confirmed/, 'confirmed past departure');
  assert.match(card, /sail-vessel">Tokitae<\/div>/, 'uses matched live vessel name when schedule/space row lacks vessel name');
  assert.match(card, /sail-time-actual">5:40 PM/, 'shows the actual/best-known departure time');
  assert.match(card, /sail-time-sched">\(was 5:05 PM\)/, 'keeps the scheduled time for history');
  assert.doesNotMatch(card, /sail-time-est/, 'confirmed historical delay is not styled as red estimate');
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
