import pw from '/home/mckoss/.npm-global/lib/node_modules/playwright/index.js';
const { chromium } = pw;
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(__dirname, 'screenshots');

const VIEWPORTS = [
  { name: 'TV-960x540',                w: 960,  h: 540, mustNotScroll: true  },
  { name: 'Tesla-1050x700',            w: 1050, h: 700, mustNotScroll: true  },
  { name: 'Pixel10ProLandscape-932x412', w: 932,  h: 412, mustNotScroll: false },
  { name: 'Pixel10ProPortrait-412x932',  w: 412,  h: 932, mustNotScroll: false },
  { name: 'iPhone14ProLandscape-852x393', w: 852,  h: 393, mustNotScroll: false },
  { name: 'iPhone14ProPortrait-393x852',  w: 393,  h: 852, mustNotScroll: false },
  { name: 'Desktop-1920x1080',         w: 1920, h: 1080, mustNotScroll: true },
];

const URL = process.env.URL || 'http://localhost:3000/';

const browser = await chromium.launch();
const results = [];

for (const v of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: v.w, height: v.h }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('pageerror', e => consoleErrors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  await page.goto(URL, { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
  // give the JS a moment to render after data fetches
  await page.waitForTimeout(1500);

  const metrics = await page.evaluate(() => {
    const html = document.documentElement;
    const body = document.body;
    const scrollH = Math.max(html.scrollHeight, body.scrollHeight);
    const clientH = html.clientHeight;
    const scrollW = Math.max(html.scrollWidth, body.scrollWidth);
    const clientW = html.clientWidth;
    // Look for content presence
    const visible = sel => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight + 1;
    };
    const fullyInViewport = sel => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.bottom <= window.innerHeight + 1 && r.right <= window.innerWidth + 1 &&
             r.top >= -1 && r.left >= -1;
    };
    return {
      scrollH, clientH, scrollW, clientW,
      hasWeather: !!document.querySelector('#weather'),
      hasTides: !!document.querySelector('#tides'),
      hasFerry: !!document.querySelector('#ferry'),
      hasClock: !!document.querySelector('#clock'),
      weatherInView: fullyInViewport('#weather'),
      tidesInView: fullyInViewport('#tides'),
      ferryInView: fullyInViewport('#ferry'),
      clockText: document.querySelector('#clock')?.textContent?.trim() || '',
      tideRows: document.querySelectorAll('.tide-list .tide-row, .tide-list > *').length,
      sailings: document.querySelectorAll('.sailing').length,
      // Count sailings whose rendered card is at least 60px tall AND mostly inside viewport
      visibleSailings: Array.from(document.querySelectorAll('.sailing')).filter(el => {
        const r = el.getBoundingClientRect();
        const tallEnough = r.height >= 60;
        const inViewport = r.top < window.innerHeight && r.bottom > 0 && r.left < window.innerWidth && r.right > 0;
        return tallEnough && inViewport;
      }).length,
      // Count sailings rendered ≥60px tall regardless of scroll position
      // (for scrollable viewports, content below the fold is still "visible" via scrolling)
      renderedSailings: Array.from(document.querySelectorAll('.sailing')).filter(el => {
        const r = el.getBoundingClientRect();
        return r.height >= 60 && r.width >= 40;
      }).length,
      // Largest .sailing time text size — squished panels show tiny or 0
      sailingTimeFont: (() => {
        const el = document.querySelector('.sailing .sail-time');
        if (!el) return 0;
        return parseFloat(getComputedStyle(el).fontSize);
      })(),
      bodyOverflowY: getComputedStyle(document.body).overflowY,
      htmlOverflowY: getComputedStyle(document.documentElement).overflowY,
    };
  });

  const scrollsV = metrics.scrollH > metrics.clientH + 1;
  const scrollsH = metrics.scrollW > metrics.clientW + 1;

  const shotPath = path.join(SHOTS, `${v.name}.png`);
  await page.screenshot({ path: shotPath, fullPage: false });

  // For scrollable viewports, also capture a full-page shot so we can confirm
  // the ferry sailings are reachable below the fold.
  if (!v.mustNotScroll) {
    const fullShotPath = path.join(SHOTS, `${v.name}-full.png`);
    await page.screenshot({ path: fullShotPath, fullPage: true });
  }

  const issues = [];
  if (v.mustNotScroll && scrollsV) issues.push(`SCROLLS VERTICALLY (${metrics.scrollH} > ${metrics.clientH})`);
  if (scrollsH) issues.push(`SCROLLS HORIZONTALLY (${metrics.scrollW} > ${metrics.clientW})`);
  if (!metrics.hasWeather) issues.push('weather card missing');
  if (!metrics.hasTides) issues.push('tides card missing');
  if (!metrics.hasFerry) issues.push('ferry card missing');
  if (!metrics.hasClock) issues.push('clock missing');
  if (v.mustNotScroll) {
    if (!metrics.weatherInView) issues.push('weather not fully in viewport');
    if (!metrics.tidesInView) issues.push('tides not fully in viewport');
    if (!metrics.ferryInView) issues.push('ferry not fully in viewport');
  }
  // For mustNotScroll viewports, every sailing must be visible in the initial viewport.
  // For scrollable viewports, sailings can be below the fold but must be properly rendered (tall enough).
  if (v.mustNotScroll) {
    if (metrics.sailings > 0 && metrics.visibleSailings < 4) {
      issues.push(`only ${metrics.visibleSailings}/${metrics.sailings} sailings in initial viewport (need ≥4)`);
    }
  } else {
    if (metrics.sailings > 0 && metrics.renderedSailings < 4) {
      issues.push(`only ${metrics.renderedSailings}/${metrics.sailings} sailings rendered ≥60px tall (squished panel)`);
    }
  }
  if (metrics.sailingTimeFont > 0 && metrics.sailingTimeFont < 12) {
    issues.push(`sailing time font ${metrics.sailingTimeFont}px is unreadably small`);
  }

  results.push({ v, metrics, scrollsV, scrollsH, issues, consoleErrors });

  await ctx.close();
}

await browser.close();

let pass = 0, fail = 0;
for (const r of results) {
  const status = r.issues.length === 0 ? 'PASS' : 'FAIL';
  if (status === 'PASS') pass++; else fail++;
  console.log(`\n[${status}] ${r.v.name}  ${r.v.w}x${r.v.h}`);
  console.log(`  scrollH=${r.metrics.scrollH}  clientH=${r.metrics.clientH}  scrollW=${r.metrics.scrollW}  clientW=${r.metrics.clientW}`);
  console.log(`  scrollsV=${r.scrollsV}  scrollsH=${r.scrollsH}  mustNotScroll=${r.v.mustNotScroll}`);
  console.log(`  weatherInView=${r.metrics.weatherInView}  tidesInView=${r.metrics.tidesInView}  ferryInView=${r.metrics.ferryInView}`);
  console.log(`  tideRows=${r.metrics.tideRows}  sailings=${r.metrics.sailings}  inView=${r.metrics.visibleSailings}  rendered=${r.metrics.renderedSailings}  sailFont=${r.metrics.sailingTimeFont}px  clock="${r.metrics.clockText}"`);
  if (r.consoleErrors.length) console.log(`  errors=${JSON.stringify(r.consoleErrors).slice(0,200)}`);
  if (r.issues.length) console.log(`  ISSUES: ${r.issues.join(' | ')}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
