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
import { mkdtemp, rm } from 'node:fs/promises';
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
  serverProcess = spawn('node', [join(__dirname, '../server.js')], {
    env: { ...process.env, PORT: '3001', DATA_DIR: dataDir },
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
  const d = await getJsonAllowError('/api/ferry/clinton/space');
  if (d.error === 'WSF_API_KEY not configured') {
    console.log('  (skipping clinton space assertions — WSF_API_KEY not set)');
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
  if (d.error === 'WSF_API_KEY not configured') {
    console.log('  (skipping mukilteo space assertions — WSF_API_KEY not set)');
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
  if (d.error === 'WSF_API_KEY not configured') {
    console.log('  (skipping legacy ferry alias — WSF_API_KEY not set)');
    return;
  }
  assert.ok(!d.error, 'no error in legacy ferry response');
  assert.ok(d.TerminalCombos, 'legacy alias returns TerminalCombos');
});

test('ferry/alerts endpoint — returns normalized route alerts', async () => {
  const d = await getJson('/api/ferry/alerts');
  if (d.error === 'WSF_API_KEY not configured') {
    console.log('  (skipping ferry alerts assertions — WSF_API_KEY not set)');
    return;
  }
  assert.ok(Array.isArray(d.alerts), 'alerts is an array');
  for (const alert of d.alerts) {
    assert.ok(alert.id, 'alert has id');
    assert.ok(typeof alert.title === 'string', 'alert has normalized title');
    assert.ok(!alert.title.includes('<'), 'alert title is plain text');
    assert.ok(!alert.text.includes('<'), 'alert text is plain text');
    assert.ok(
      alert.allRoutes || alert.affectedRouteIds?.includes(7),
      `alert applies to Mukilteo/Clinton route 7 or all routes: ${alert.title}`
    );
  }
});

test('ferry/vessels endpoint — normalized vessel location data', async () => {
  const d = await getJson('/api/ferry/vessels');
  if (d.error === 'WSF_API_KEY not configured') {
    console.log('  (skipping vessel assertions — WSF_API_KEY not set)');
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
      title: 'Muk/Clin - One vessel canceled',
      text: 'The 8:30 PM sailing is canceled due to mechanical issues.',
    },
    { title: 'All Routes - Pets', text: 'New pet rules effective May 20.' },
    { title: 'Muk/Clin - Low tide warning', text: 'Loading may be restricted.' },
    { title: 'Muk/Clin - Terminal status', text: '2 Hour Wait for Drivers' },
    { title: 'Muk/Clin - General notice', text: 'Good morning. How are you doing?' },
  ];
  const ticker = context.__alertTest.renderFerryAlerts(alerts);
  const visibleText = alerts
    .map(a => (a.text && a.text !== a.title) ? `${a.title} ${a.text}` : a.title)
    .join('   ');
  const expectedTickerDuration = Math.max(4, Math.round(visibleText.length / 15));
  assert.match(ticker, /ferry-alert-ticker/, 'renders one shared ticker container');
  assert.match(ticker, /ferry-alert-title/, 'renders title span');
  assert.match(ticker, /ferry-alert-detail/, 'renders detail span');
  assert.match(ticker, /Good morning\. How are you doing\?/, 'renders general WSF notice text');
  assert.match(ticker, new RegExp(`--ticker-duration: ${expectedTickerDuration}s`), 'sets ticker speed from visible text at 15 cps');
  assert.equal((ticker.match(/ferry-alert-copy/g) || []).length, 2, 'duplicates content so the scroll wraps');
  assert.doesNotMatch(ticker, /ferry-alert-ticker danger/, 'mixed ticker does not make every alert red');
  assert.match(ticker, /ferry-alert-item danger[\s\S]*One vessel canceled/, 'disruptive alert item is red');
  assert.match(ticker, /ferry-alert-item(?! danger)[^>]*><span class="ferry-alert-title">All Routes - Pets/, 'informational all-routes item stays yellow');
  assert.match(html, /\.ferry-alert-item\s*\{[\s\S]*?color:\s*inherit;/, 'alert item text inherits ticker severity color');
  assert.match(html, /\.ferry-alert-item\.danger\s*\{[\s\S]*?color:\s*var\(--danger\);/, 'only disruptive alert items use danger red');
  assert.match(html, /\.ferry-alert-title\s*\{[\s\S]*?color:\s*inherit;/, 'alert titles use the ticker severity color');
  assert.match(html, /\.ferry-alert-detail\s*\{[\s\S]*?color:\s*inherit;/, 'alert details use the same severity color as titles');
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
    atDock: true,
    departingTerminalId: 14,
    arrivingTerminalId: 5,
    scheduledDepartureMs: Date.UTC(2026, 5, 8, 0, 40), // 5:40 PM PDT
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
