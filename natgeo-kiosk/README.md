# natgeo-kiosk

A National Geographic magazine slideshow for the Whidbey TV. Full-screen
crossfade through the current issue's photographs, with a lower-third overlay
carrying the headline, location, and photographer credit.

Built to be deployed and operated exactly like
[whidbey-dashboard](https://github.com/mckoss/whidbey-dashboard): plain Express,
a single-file frontend, no bundler, no build step, config from `config.json` or
a Railway `CONFIG_JSON` variable.

```
npm install
cp .env.example .env         # add NATGEO_COOKIE and ANTHROPIC_API_KEY
npm run verify               # probe the live site, print what it found
npm run harvest              # fetch the current issue
npm start                    # serve the slideshow on :3000
```

## How it works

```
nationalgeographic.com/magazine
        │  (authenticated fetch with your subscriber cookie)
        ▼
  identify the current issue  ──►  2026-10 "October 2026"
        │
        ▼
  each article page  ──►  image URLs + captions + credits + headline
        │
        ▼
  download at the highest resolution the CDN will serve
        │
        ▼
  condense each caption with the Claude API
        │      { location, short_caption, headline, credit }
        ▼
  stage the whole issue, then swap it in atomically
        │
        ▼
  /api/slides  ──►  the TV
```

The harvester runs daily (see **Scheduling**), keeps **only the current issue**,
and replaces the whole set when a new issue appears.

## Configuration

Secrets live in `.env` (git-ignored) or the real environment. Everything else
lives in `config.json` (git-ignored, copy `config.example.json`) or, on Railway,
in a `CONFIG_JSON` variable holding the same JSON object.

| Variable | Purpose |
|---|---|
| `NATGEO_COOKIE` | Your full subscriber cookie header from a logged-in browser. |
| `ANTHROPIC_API_KEY` | Used to condense captions. Optional — without it, captions are truncated instead. |
| `PORT` | Overrides `config.port`. Railway sets this. |
| `CONFIG_JSON` | The whole config object, for Railway. |

Notable config keys:

| Key | Default | Meaning |
|---|---|---|
| `dataDir` | `data` | Where issues and images are written. On Railway, mount a Volume and set this to `/app/data`. |
| `harvestHourLocal` | `4` | Local hour to run the daily harvest. |
| `timezone` | `America/Los_Angeles` | Timezone for that hour. |
| `maxArticles` / `maxImagesPerArticle` | `24` / `12` | Harvest ceiling. |
| `targetImageWidth` | `4096` | Width requested from the image CDN. |
| `minImageWidth` / `minImageBytes` | `1200` / `40000` | Quality floor; smaller renditions are skipped. |
| `slideDurationMs` | `12000` | Time on screen per slide. |
| `crossfadeMs` | `2000` | Crossfade duration. |
| `captionDelayMs` | `3000` | How long after the image settles the caption fades in. |
| `condenseModel` | `claude-opus-5` | Model used for caption condensing. |
| `overrides.*` | `null` | Regex escape hatches for a NatGeo redesign — see **When the site changes**. |

### Getting the cookie

Sign in at nationalgeographic.com, open DevTools → Application → Cookies →
`https://www.nationalgeographic.com`, and copy the **entire** cookie header
(every `name=value` pair, semicolon-separated) into `NATGEO_COOKIE`. A single
cookie is not enough. Expect to refresh it periodically — the kiosk tells you
loudly when it stops working.

## Hosting

Same as the dashboard: Railway, `npm start`, `PORT` from the environment.

1. Point a Railway service at this repo.
2. Set `NATGEO_COOKIE`, `ANTHROPIC_API_KEY`, and `CONFIG_JSON`.
3. Mount a Railway Volume at `/app/data` and put `"dataDir": "/app/data"` in
   `CONFIG_JSON` — harvested images must survive deploys, or every deploy would
   re-download the whole issue.
4. Point the TV browser at the service URL in full-screen / kiosk mode.

The page needs no interaction: it polls `/api/slides` every 15 minutes, picks up
a new issue on its own, and recovers from a server restart without anyone
touching the remote. Arrow keys step slides manually while you're setting it up.

## Scheduling

The harvester must run where the data volume is mounted, so it runs inside the
server process rather than in CI: a single timer checks every 10 minutes and
harvests once per day at `harvestHourLocal`. On boot, if the stored issue is
older than `staleAfterHours`, it harvests immediately.

You can also run it by hand:

```bash
npm run harvest             # skips work if the current issue is already stored
npm run harvest -- --force  # re-harvest the current issue from scratch
```

Exit codes, so a wrapper script can alert on the right thing:

| Code | Meaning |
|---|---|
| 0 | Success (including "already up to date") |
| 2 | Session cookie expired or missing — **needs you** |
| 3 | Page structure not recognized — needs a config override or a code change |
| 4 | Network or upstream failure — retry later |
| 5 | Nothing usable harvested |

## When the cookie expires

This is the failure mode the project is designed around: it never silently shows
a stale or empty issue.

- The harvester **fails closed**. A failed run cannot overwrite the stored issue;
  a staged issue is only swapped in once it is complete and non-empty.
- The log gets an unmissable banner naming the URL, the HTTP status, the
  evidence, and exactly how to fix it.
- The run exits with code **2**.
- `/api/slides` and `/api/status` report the problem in `health.problems`.
- The TV shows a **red banner across the top** — `NATGEO SESSION EXPIRED` —
  while continuing to play the last good issue underneath.

Expiry is detected from a 401/403, a redirect to a login or subscribe page, or
paywall copy on a page with no signed-in markers. A "subscribe" promo in the
footer of a page you *are* signed in to does not trip it.

## When the site changes

`npm run verify` fetches the magazine page and a couple of articles with your
real cookie and prints the page's actual structure: every JSON script block and
its top-level keys, the schema.org types, the Open Graph tags, element counts,
sample `srcset` widths, and what each extraction strategy produced. It writes
`verify-report.json` alongside.

```bash
npm run verify
npm run verify -- --articles 5
npm run verify -- --url https://www.nationalgeographic.com/magazine/article/...
npm run verify -- --save page.html     # keep the raw HTML to work against
```

Extraction is **structural, not selector-based** — there is not a single NatGeo
class name in this codebase. Images, captions, and credits are gathered by four
independent strategies and merged, highest-confidence first:

1. **`ld+json`** — schema.org `Article` / `ImageObject` / `ItemList`.
2. **embedded JSON** — `__NEXT_DATA__`, `<script type="application/json">`, and
   `window.__X__ = {...}` assignments, walked for any node that pairs an image
   URL with caption/credit-shaped keys.
3. **`<figure>` / `<figcaption>`** — including `<picture><source srcset>`.
4. **meta tags** — `og:image` / `og:title` as the hero fallback.

If a redesign defeats all four, you have two escape hatches before touching
code, both under `overrides` in config:

| Override | What it does |
|---|---|
| `articleLinkPattern` | Regex matched against a link's pathname to decide what counts as an article. |
| `issueLabelPattern` | Regex (one capture group) for the issue label, if it stops being "Month YYYY". |
| `imageHostPattern` | Regex matched against an image URL's hostname, for a new CDN. |

## Image resolution

"Highest available resolution" is settled by measurement, not by trusting a CDN
parameter. For each image the harvester builds a ladder of candidate URLs —
raising `?w=`/`width=` toward `targetImageWidth`, raising a `/w_1600/` path
segment, and trying the unsized original — fetches them in order, reads the real
pixel dimensions out of the JPEG/PNG/WebP header, and keeps the largest. The
same photograph offered at several widths is deduplicated to one slide.

An HTML body served with a 200 in place of an image (the classic paywall
symptom) is detected and rejected rather than stored as a broken file.

## Caption condensing

Magazine captions run two or three sentences — unreadable from a couch. Each one
goes to the Claude API and comes back as the four fields the overlay renders:

```json
{
  "location": "Galápagos Rift, Pacific Ocean",
  "short_caption": "Giant tubeworms crowd a hydrothermal vent two miles below the surface",
  "headline": "Life at the Vents",
  "credit": "Maria Chen"
}
```

- Uses a **strict tool** (`record_caption`), so arguments are schema-validated by
  the API — a malformed response is an error, not a parsing bug here.
- Results are **cached on disk** by content hash, so re-harvesting the same issue
  costs nothing.
- The model is told never to invent a place or a name — an unknown field comes
  back empty and the overlay simply omits it.
- If the API fails or no key is set, the caption is truncated to 18 words
  instead. The slide is never dropped.

## API

| Endpoint | Returns |
|---|---|
| `GET /` | The slideshow page (never cached). |
| `GET /api/slides` | Current issue, its slides, and `health`. |
| `GET /api/status` | Version, issue, last-run state, and `health`. |
| `GET /api/config` | Version and the slideshow timing values. |
| `GET /images/:issueId/:file` | A harvested image off the data volume. |

## Layout on disk

```
data/
  state.json                  last run, last error, current issue pointer
  condense-cache.json         caption condensing cache, keyed by content hash
  issues/
    2026-10/
      manifest.json           slides with all overlay fields
      images/001.jpg …
```

Only the current issue is kept; committing a new one prunes the rest.

## Development

```bash
npm test          # 69 tests, no network, no API key needed
npm run dev       # node --watch server.js
bash restart.sh   # kill the old process and start fresh
```

Tests cover extraction against fixture pages for every strategy, resolution
selection and image-header parsing, session-expiry classification, the atomic
store (including "a failed harvest must not blank the kiosk"), caption
condensing with a stubbed client, a full end-to-end harvest against a fake
National Geographic, and the served HTTP endpoints.

## A note on sources

This fetches your own subscriber content with your own session for display on
your own television. Nothing is redistributed; the repo is private and the
images live on your server's volume. National Geographic's terms of service
govern that use, and the cookie is yours to manage.
