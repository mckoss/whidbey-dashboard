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
  assert.equal(d.retentionDays, 30, 'uses default 30-day retention');

  const bad = await fetch(`${BASE}/api/ferry/history?date=today`);
  assert.equal(bad.status, 400, 'rejects non-ISO dates');
  const badBody = await bad.json();
  assert.match(badBody.error, /YYYY-MM-DD/, 'explains date format');
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
  assert.match(source, /!vessel\.atDock &&[\s\S]*?vessel\.leftDockMs &&[\s\S]*?!vessel\.arrivingTerminalId/,
    'allows underway vessels with blank arriving terminal to match by departure terminal and left-dock time');
  assert.match(source, /observedVesselName \|\| next\.vesselName/,
    'uses the observed vessel name after actual departure so live dots can attach to trail lines');
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
  }, 'valid-admin-token');
  assert.equal(updated.res.status, 200, 'updates message for authorized admin');
  assert.equal(updated.data.message.text, 'Bring firewood and kindling', 'stores updated plain text only');
  assert.equal(updated.data.message.startDate, null, 'blank omitted start date clears start date');
  assert.equal(updated.data.message.endDate, '2999-11-30', 'updates end date');
  assert.equal(updated.data.message.color, '', 'drops unsafe CSS color text');

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
  assert.match(html, /#ferry-alert-ticker\s*\{[\s\S]*?min-width:\s*0;/, 'ticker grid item cannot widen the dashboard');
  assert.match(html, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*minmax\(0,\s*1fr\)/, 'main grid columns can shrink to viewport');
  assert.ok(html.includes('Whidbey'), 'mentions Whidbey');
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
  assert.match(html, /id="version"/, 'shows app version in the header');
  assert.match(html, /\/api\/config/, 'loads app version from config API');
  assert.match(html, /id="prev-date"/, 'has previous date control');
  assert.match(html, /id="next-date"/, 'has next date control');
  assert.match(html, /id="date-input"[^>]+type="date"/, 'has date picker');
  assert.match(html, /\/api\/ferry\/history\?date=/, 'loads history API by URL date');
  assert.match(html, /Clinton to Mukilteo/, 'has Clinton to Mukilteo table column');
  assert.match(html, /Mukilteo to Clinton/, 'has Mukilteo to Clinton table column');
  assert.match(html, /Trip min/, 'has trip duration column');
  assert.match(html, /Dock min/, 'has dock duration column');
  assert.match(html, /function formatMinutes/, 'formats durations as fractional minutes');
  assert.match(html, /Time Distance/, 'has diagram section');
  assert.match(html, /terminalProgress/, 'can plot current vessel position from coordinates');
  assert.match(html, /scheduled-estimate/, 'renders schedule-only trips as subdued estimate lines');
  assert.match(html, /\.trip-line\.scheduled-estimate\s*\{[\s\S]*?stroke-width:\s*1\.8;/, 'schedule-only trips are thinner than observed routes');
  assert.match(html, /\.trip-line\.scheduled-estimate\s*\{[\s\S]*?opacity:\s*0\.44;/, 'schedule-only trips remain visible dashed context');
  assert.match(html, /rgba\(148, 163, 184, 0\.75\)/, 'renders schedule-only trips in neutral gray instead of vessel colors');
  assert.match(html, /observed/, 'renders observed trips as emphasized history lines');
  assert.match(html, /observed \/.*schedule-only/, 'summarizes observed trips separately from schedule-only context');
  assert.match(html, /function splitTimeline/, 'splits the time-distance chart into two equal timeline columns');
  assert.match(html, /left:\s*92/, 'leaves enough left gutter for unclipped first-column time labels');
  assert.match(html, /ceilToHalfHour\(segment\.startMs\)/, 'starts grid lines on the next half-hour boundary');
  assert.match(html, /ms \+= HALF_HOUR_MS/, 'draws grid lines every half hour, including hourly lines');
  assert.match(html, /hour-grid/, 'styles hourly grid lines more strongly than half-hour lines');
  assert.match(html, /ms \+= HOUR_MS\)[\s\S]*?formatTimeMs\(ms\)/, 'labels every hour on each time segment');
  assert.match(html, /const HALF_HOUR_MS = 30 \* 60 \* 1000/, 'defines half-hour grid interval');
  assert.match(html, /schedule-departure-tick/, 'draws yellow scheduled departure ticks outside the terminal axes');
  assert.match(html, /scheduledDepartureTick\(trip, segment, height, pad\)/, 'renders scheduled departure ticks per split timeline segment');
  assert.match(html, /trip\.fromTerminalName === 'Clinton'/, 'places Clinton and Mukilteo departure ticks on opposite outside edges');
  assert.match(html, /midpointMs = bounds\.startMs \+ \(bounds\.endMs - bounds\.startMs\) \/ 2/, 'splits at the timeline midpoint rather than hard-coded noon');
  assert.match(html, /clipStart = Math\.max\(departMs, segment\.startMs\)/, 'clips trip lines at the start of each half-day segment');
  assert.match(html, /clipEnd = Math\.min\(lineEndMs, segment\.endMs\)/, 'clips trip lines at the end of each half-day segment');
  assert.match(html, /segments\.map\(segment => lineForTrip\(trip, segment\)\)/, 'renders each trip separately inside each time segment');
  assert.match(html, /function terminalXForId/, 'maps docked current vessels by terminal id');
  assert.doesNotMatch(html, /departingTerminalId === 5 \|\| vessel\.arrivingTerminalId === 5/, 'does not place docked vessels by either endpoint');
  assert.match(html, /function currentVesselPoint/, 'shares current vessel placement for dots and underway trail lines');
  assert.match(html, /isUnderwayTrip\(trip, nowMs\)/, 'shortens underway observed trip lines to the live vessel point');
  assert.match(html, /lineEndMs = nowMs/, 'underway trail stops at the current report time');

  const scriptMatch = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'found ferry history script block');
  assert.doesNotThrow(() => new Function(scriptMatch[1]), 'ferry history inline JS should parse without syntax errors');
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

test('late ferry logic — delay propagates through later sailings in schedule order', async () => {
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
    leftDockMs: Date.UTC(2026, 5, 8, 0, 40), // 5:40 PM PDT actual departure
  }] });

  const timings = context.__lateTest.computeSailingTimings(sailings, vesselMap, 14);
  assert.equal(timings[0].effectiveMs, Date.UTC(2026, 5, 8, 0, 40), 'first late sailing uses vessel estimate');
  assert.equal(timings[1].effectiveMs, Date.UTC(2026, 5, 8, 1, 10), 'later sailing inherits the same delay');
  assert.equal(timings[2].effectiveMs, Date.UTC(2026, 5, 8, 1, 40), 'delay continues through subsequent sailings');
  assert.ok(timings[0].effectiveMs < timings[1].effectiveMs, 'effective times stay in schedule order');

  const list = context.__lateTest.buildDisplayList(sailings, vesselMap, 14);
  assert.equal(list[0].sailTime.getTime(), firstMs, 'late first sailing remains the next card');

  const card = context.__lateTest.sailingCard(sailings[1], sailings, {}, vesselMap, 14);
  assert.match(card, /1:10 PM|6:10 PM/, 'renders the propagated estimate instead of duplicating 5:40 PM');
  assert.doesNotMatch(card, /5:40 PM.*was 5:35 PM/s, 'does not apply the same estimate to the next scheduled card');
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
