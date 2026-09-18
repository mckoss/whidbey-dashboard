import { strict as assert } from 'assert';
import { test } from 'node:test';
import { SessionExpiredError, buildHeaders, classifyResponse, fetchPage } from '../lib/fetch-natgeo.js';
import { DEFAULTS } from '../lib/config.js';
import * as F from './fixtures.js';

const config = { ...DEFAULTS, natgeoCookie: 'session=abc; user=1' };

function response({ status = 200, url, body = '' }) {
  return { ok: status >= 200 && status < 300, status, url, text: async () => body };
}

test('a 401 or 403 is an expired session', () => {
  for (const status of [401, 403]) {
    const result = classifyResponse({ status, requestedUrl: 'https://x/a', finalUrl: 'https://x/a' });
    assert.ok(result.expired);
    assert.equal(result.confidence, 'high');
  }
});

test('a redirect to a login or subscribe page is an expired session', () => {
  for (const path of ['/auth/login', '/signin', '/subscribe/offers', '/identity/start']) {
    const result = classifyResponse({
      status: 200, requestedUrl: 'https://x/magazine/article/a', finalUrl: `https://x${path}`,
    });
    assert.ok(result.expired, `${path} should read as expired`);
  }
});

test('paywall copy on a page with no signed-in markers is an expired session', () => {
  const result = classifyResponse({
    status: 200, requestedUrl: 'https://x/a', finalUrl: 'https://x/a', html: F.ARTICLE_PAYWALLED,
  });
  assert.ok(result.expired);
  assert.equal(result.confidence, 'high', 'several markers raise confidence');
});

test('a subscribe promo on a signed-in page is NOT an expired session', () => {
  const html = '<a href="/account">My Account</a><footer>Start your subscription today</footer>';
  const result = classifyResponse({
    status: 200, requestedUrl: 'https://x/a', finalUrl: 'https://x/a', html,
  });
  assert.ok(!result.expired, 'a footer promo must not trigger a false expiry');
  assert.ok(result.authenticated);
});

test('an entitlement flag in embedded JSON counts as signed in', () => {
  const html = '<script>window.__D__={"isSubscriber":true}</script><p>subscriber-only</p>';
  assert.ok(!classifyResponse({ status: 200, requestedUrl: 'https://x/a', finalUrl: 'https://x/a', html }).expired);
});

test('the cookie is sent on every request', () => {
  const headers = buildHeaders(config);
  assert.equal(headers.Cookie, 'session=abc; user=1');
  assert.equal(headers['User-Agent'], DEFAULTS.userAgent);
  assert.ok(!buildHeaders({ ...config, natgeoCookie: '' }).Cookie);
});

test('fetchPage throws SessionExpiredError with actionable detail', async () => {
  const fetchImpl = async () => response({ status: 200, url: 'https://x/auth/login', body: '' });
  await assert.rejects(
    () => fetchPage('https://x/magazine', config, { fetchImpl }),
    (err) => {
      assert.ok(err instanceof SessionExpiredError);
      assert.equal(err.code, 'NATGEO_SESSION_EXPIRED');
      assert.equal(err.details.finalUrl, 'https://x/auth/login');
      assert.ok(err.details.evidence.length);
      return true;
    },
  );
});

test('fetchPage returns html for a healthy signed-in page', async () => {
  const fetchImpl = async (url) => response({ status: 200, url, body: F.ARTICLE_FIGURES });
  const page = await fetchPage('https://x/magazine/article/a', config, { fetchImpl });
  assert.equal(page.status, 200);
  assert.match(page.html, /tubeworms/);
  assert.ok(!page.session.expired);
});

test('a non-auth HTTP error is reported as a fetch failure, not a session problem', async () => {
  const fetchImpl = async (url) => response({ status: 503, url, body: 'upstream down' });
  await assert.rejects(
    () => fetchPage('https://x/magazine', config, { fetchImpl }),
    (err) => err.code === 'NATGEO_FETCH_FAILED',
  );
});
