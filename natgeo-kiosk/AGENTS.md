# AGENTS.md — natgeo-kiosk

Context and design decisions for AI agents working on this project. Sibling
project to `whidbey-dashboard`, same house, same TV, same conventions.

## What This Is

A National Geographic magazine slideshow for Mike Koss's Whidbey Island beach
house TV. A daily harvester caches the current issue's photographs and captions;
a full-screen page crossfades through them with a lower-third overlay.

## Hard Rules

1. **`npm test` green before every `git commit`.** No exceptions.
2. **Bump the version in `package.json` before every push.** The version comes
   from `package.json` via `/api/config` and renders in the page corner. Major
   for incompatible config/API changes, minor for user-visible features, patch
   for fixes.
3. **Every commit message includes the current version** as `(vX.Y.Z)`, even
   commits that don't bump it.
4. **No bundlers, no build step.** `public/index.html` is one file with all
   HTML/CSS/JS. `server.js` is plain Express. Keep it that way.
5. **No scrolling.** `height: 100vh; overflow: hidden`. It's a TV.
6. **Never let a failed harvest degrade the display silently.** See below.

## The Central Invariant

> A harvest that fails, finds nothing, or hits an expired cookie must leave the
> stored issue **byte-for-byte unchanged**, and must make the failure visible.

Everything about the store's design follows from this:

- Images and the manifest are written to a **staging directory**. The live issue
  directory is only ever replaced by a `rename` of a complete staging directory.
- `StagedIssue.commit()` **refuses to commit zero slides**.
- If the rename fails partway, the retired issue is renamed back.
- Failures are recorded in `state.json` without touching `currentIssueId`.
- `buildHealth()` in `server.js` is the single place that decides what the TV
  warns about; both `/api/slides` and `/api/status` report it.

There are regression tests for each of these. Do not "simplify" the staging
dance away — writing images directly into the live directory would mean a
mid-harvest crash leaves a half-issue on the TV.

## Design History & Decisions

### Extraction is structural, not selector-based

The harvester was written without access to the live site (see **Unverified
Against Live**, below), and a publisher's markup changes without notice anyway.
So there is **not one NatGeo class name in this codebase**. Four independent
strategies gather candidates and merge them by normalized URL: `ld+json`,
embedded JSON blobs (walked for image-shaped nodes), `<figure>`/`<figcaption>`,
and Open Graph tags.

Each strategy reports what it found, and `probePage()` turns those reports into
the structural summary that `npm run verify` prints. That command is the tool
for diagnosing a redesign, and its output tells you what to put in config
`overrides` — the intent is that a redesign is a config change, not a code
change.

**Do not replace this with a couple of CSS selectors** even if you can see the
live HTML and it looks tidier. The kiosk runs unattended for months.

### No DOM parser dependency

`lib/html.js` does tolerant tag scanning rather than pulling in cheerio/jsdom.
This matches the sibling dashboard's minimal-dependency shape. `sliceBalanced()`
walks braces while respecting string literals, which is what makes
`window.__X__ = {...}` extraction safe. If you ever need real parsing, that's a
deliberate decision to make explicitly, not a drive-by `npm install`.

### Resolution by measurement

Early versions trusted the `?w=` parameter. They don't any more: `fetchBestImage`
builds a ladder of candidate URLs, fetches in order, reads real dimensions from
the JPEG/PNG/WebP header (`imageSize`), and keeps the largest pixel area. It
stops early once a candidate meets `targetImageWidth`, so the common case is one
request per image.

`looksLikeImageResponse()` rejects an HTML body served with a 200 — the classic
paywall symptom, and the thing that would otherwise fill the volume with broken
"images".

### Session expiry vs. a footer promo

`classifyResponse()` deliberately requires corroboration. A 401/403 or a redirect
to an auth path is high-confidence expiry. Paywall copy only counts when nothing
on the page says you're signed in, because a subscriber page can legitimately
carry a "start your subscription" promo in the footer. A false expiry would stop
the kiosk updating for no reason, so err toward "authenticated" on weak evidence
— a genuinely locked page yields no images and fails loudly anyway.

### Caption condensing uses a strict tool, not free-text JSON

`CONDENSE_TOOL` has `strict: true` and `additionalProperties: false`, and the
request forces that tool. Schema validity is the API's job; this codebase never
parses model prose. Results are cached by content hash so re-harvesting costs
nothing, and any failure degrades to an 18-word truncation rather than dropping
the slide.

The model is instructed never to invent a place or a name. An empty field is a
correct answer, and the overlay omits empty fields rather than showing a label
with nothing after it.

### Two-child layers (a real bug, fixed)

Each crossfade layer holds a `.backdrop` (blurred, `cover`) and a `.photo`
(sharp, `contain`) as **siblings**. The first version put the photo on the layer
itself and the backdrop as a `z-index: -1` child — which renders the blur *on
top of* the photo, because inside a stacking context a negative-z child paints
above the parent's background but below its content. The whole TV showed nothing
but blur. If you touch the layer CSS, screenshot it before believing it works.

`background-size: contain` is intentional: a magazine photograph is composed,
and cropping it to fill a 16:9 frame is worse than pillarboxing it against a
blurred copy of itself.

### Caption timing

The caption is hidden *before* the image changes and fades back in
`crossfadeMs + captionDelayMs` after the new image starts arriving, so every
photograph gets a few seconds on its own before any text appears. Requirement,
not decoration.

## Scheduling lives in the server

The harvester needs the data volume, so it runs in-process (a 10-minute timer
that fires once per day at `harvestHourLocal`) rather than in GitHub Actions. A
stale issue on boot triggers an immediate harvest. `npm run harvest` does the
same thing by hand.

## Unverified Against Live

**As of v0.1.0 the harvester has never run against nationalgeographic.com.** The
session that wrote it had `www.nationalgeographic.com` blocked by an egress
policy, and had neither the subscriber cookie nor an API key. Every test uses
fixtures and fakes.

What this means in practice:

- The four extraction strategies are shapes a modern publisher CMS emits, not
  observed NatGeo markup. `i.natgeofe.com` appears only as a *hint* for
  extensionless CDN URLs; extension matching is the primary test.
- The first live run should be `npm run verify`, not `npm run harvest`. Read the
  structural report, then set `overrides` if any strategy came up empty.
- If you are the agent that finally runs it against the live site: **replace this
  section** with what you actually found — the real JSON blob ids and their top
  keys, the real schema.org types, whether captions live in `figcaption` or in
  JSON, and the CDN's real width parameter. That is the single most valuable
  edit anyone can make to this file.

## Common Pitfalls

1. **Screenshot the page after any CSS change.** The stacking-context bug above
   passed every test and looked like a working kiosk in the DOM.
2. **`npm test` needs no network and no API key.** Keep it that way — a test
   that hits the live site will be flaky and will leak the cookie into CI.
3. **Don't write images into the live issue directory.** Staging exists for a
   reason (see **The Central Invariant**).
4. **Secrets never go in `config.json`.** `loadConfig()` reads them only from the
   environment, so a config file can be pasted into a Railway variable safely.
5. **`decodeEntities` runs twice** to handle double-encoded caption text. If you
   see `&amp;` surviving in a caption, that's the place to look.
6. **The fake-site helper in tests matches the longest URL prefix.** The magazine
   URL is a prefix of its own article URLs; a naive `startsWith` silently serves
   the index page as every article.
