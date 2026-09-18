// Authenticated page fetching, plus the one diagnosis that matters most:
// telling "the session cookie expired" apart from "the page changed".
//
// Requirement 4 of this project: never silently show a stale or empty issue.
// Everything here fails loudly and in a way the caller can classify.

import { log } from './log.js';

export const SESSION_EXPIRED = 'NATGEO_SESSION_EXPIRED';
export const FETCH_FAILED = 'NATGEO_FETCH_FAILED';

export class SessionExpiredError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SessionExpiredError';
    this.code = SESSION_EXPIRED;
    this.details = details;
  }
}

export class FetchFailedError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'FetchFailedError';
    this.code = FETCH_FAILED;
    this.details = details;
  }
}

// URL paths that mean "you are not logged in".
const AUTH_PATH_RE = /\/(?:auth|login|signin|sign-in|subscribe|subscription|paywall|register|identity)\b/i;

// Text markers of a locked article. Any one of these alone is weak evidence;
// `classifyResponse` requires corroboration before declaring expiry.
const PAYWALL_MARKERS = [
  /subscriber[- ]only/i,
  /to continue reading[, ]/i,
  /already a subscriber\?\s*sign in/i,
  /this (?:story|article) is (?:for|available to) subscribers/i,
  /unlock this (?:story|article)/i,
  /\bpaywall\b/i,
  /start your subscription/i,
];

const SIGNED_IN_MARKERS = [
  /"(?:isSubscriber|hasSubscription|isEntitled|isAuthenticated|loggedIn)"\s*:\s*true/i,
  /data-(?:user|auth)-state\s*=\s*["'](?:authenticated|subscriber|loggedin)["']/i,
  /\bsign\s*out\b/i,
  /\blog\s*out\b/i,
  /\bmy account\b/i,
];

export function classifyResponse({ status, finalUrl, requestedUrl, html = '' }) {
  const evidence = [];

  if (status === 401 || status === 403) {
    return {
      authenticated: false, expired: true, confidence: 'high',
      evidence: [`http-${status}`],
    };
  }

  let redirectedToAuth = false;
  try {
    const from = new URL(requestedUrl);
    const to = new URL(finalUrl || requestedUrl);
    if (to.href !== from.href && AUTH_PATH_RE.test(to.pathname)) {
      redirectedToAuth = true;
      evidence.push(`redirect-to-auth:${to.pathname}`);
    }
  } catch { /* ignore malformed URLs */ }

  if (redirectedToAuth) {
    return { authenticated: false, expired: true, confidence: 'high', evidence };
  }

  const paywallHits = PAYWALL_MARKERS.filter((re) => re.test(html)).map((re) => re.source);
  const signedInHits = SIGNED_IN_MARKERS.filter((re) => re.test(html)).map((re) => re.source);
  if (paywallHits.length) evidence.push(...paywallHits.map((s) => `paywall:${s}`));
  if (signedInHits.length) evidence.push(...signedInHits.map((s) => `signed-in:${s}`));

  // A subscriber page can still say "subscribe" in a footer promo, so a paywall
  // marker only counts as expiry when nothing says we are signed in.
  if (paywallHits.length >= 1 && signedInHits.length === 0) {
    return {
      authenticated: false,
      expired: true,
      confidence: paywallHits.length > 1 ? 'high' : 'medium',
      evidence,
    };
  }

  return { authenticated: true, expired: false, confidence: signedInHits.length ? 'high' : 'low', evidence };
}

export function buildHeaders(config, extra = {}) {
  const headers = {
    'User-Agent': config.userAgent,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    ...extra,
  };
  if (config.natgeoCookie) headers.Cookie = config.natgeoCookie;
  return headers;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchPage(url, config, { fetchImpl = fetch, timeoutMs = 45000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      headers: buildHeaders(config),
      redirect: 'follow',
      signal: controller.signal,
    });
  } catch (err) {
    throw new FetchFailedError(`Network error fetching ${url}: ${err.message}`, { url });
  } finally {
    clearTimeout(timer);
  }

  const html = await response.text();
  const finalUrl = response.url || url;
  const session = classifyResponse({
    status: response.status, finalUrl, requestedUrl: url, html,
  });

  if (session.expired) {
    throw new SessionExpiredError(
      `National Geographic session rejected for ${url}`,
      { url, finalUrl, status: response.status, ...session },
    );
  }

  if (!response.ok) {
    throw new FetchFailedError(`HTTP ${response.status} fetching ${url}`, {
      url, finalUrl, status: response.status,
    });
  }

  log.debug('FETCH_OK', url, { status: response.status, bytes: html.length, confidence: session.confidence });
  return { url, finalUrl, status: response.status, html, session };
}

// The message Mike actually needs to see when the cookie dies.
export function reportSessionExpired(err, config) {
  log.banner(SESSION_EXPIRED, [
    'The National Geographic subscriber session cookie is no longer valid.',
    '',
    `  URL        : ${err.details?.url || '(unknown)'}`,
    `  Final URL  : ${err.details?.finalUrl || '(none)'}`,
    `  HTTP status: ${err.details?.status ?? '(none)'}`,
    `  Confidence : ${err.details?.confidence || 'unknown'}`,
    `  Evidence   : ${(err.details?.evidence || []).join(', ') || '(none)'}`,
    `  Cookie set : ${config.natgeoCookie ? `yes (${config.natgeoCookie.length} chars)` : 'NO — NATGEO_COOKIE is empty'}`,
    '',
    'The cached issue was left untouched — nothing was overwritten with empty',
    'or partial data. The slideshow keeps showing the last good issue and now',
    'displays an on-screen warning banner.',
    '',
    'To fix: sign in at nationalgeographic.com in a browser, copy the full',
    'cookie header from DevTools > Application > Cookies, and update',
    'NATGEO_COOKIE in .env (or the Railway variable), then run `npm run harvest`.',
  ]);
}
