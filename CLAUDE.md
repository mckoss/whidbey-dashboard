# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See `AGENTS.md` for full design history, decisions, and pitfalls — read it before any non-trivial change. `README.md` documents user-facing behavior and data sources.

## Hard rules (from AGENTS.md)

1. `npm test` must be green before every `git commit`.
2. **Bump the version before every push.** The version string lives in `<h1>` of `public/index.html` (e.g. `v1.4.20`) and in `package.json`. Patch for fixes, minor for features.
3. **Every commit message must include the current version** in the format `(vX.Y.Z)` — even commits that don't bump the version (e.g. `README: fix ferry interval (v1.4.3)`). This is how Mike reverts to a known build.
4. **Commit at feature completion, not turn-by-turn.** Ask "Shall I commit now?" at clean stopping points and wait for confirmation. Exception: if Mike hasn't responded in 15+ minutes and there are uncommitted changes at a clean checkpoint, commit without asking.
5. **No bundlers, no build step.** `public/index.html` is a single file with all HTML/CSS/JS. `server.js` is plain Express. Keep it that way.
6. **No scrolling.** Body is `height: 100vh; overflow: hidden` — everything must fit one TV screen.

## Commands

```bash
npm install
npm start              # node server.js, port 3000
npm run dev            # node --watch server.js (auto-restart on edits)
npm test               # node --test test/api.test.js (spawns its own server on :3001)
bash restart.sh        # kill old :3000 process and start fresh — needed after server.js edits
```

To run a single test, use the node test runner's name filter: `node --test --test-name-pattern="<name>" test/api.test.js`.

The dev server caches API responses in-memory; `restart.sh` is the only way to fully clear them.

## Architecture (big picture)

- `public/index.html` (~1000 lines) — entire frontend in one file. No frameworks. Globals like `window._sunriseMs` / `window._sunsetMs` are deliberately shared between the weather card and the sparkline's day/night rendering.
- `server.js` — Express server. Each upstream endpoint has its own in-memory cache with a TTL matching the client's refresh interval. Uses **stale-while-revalidate**: if a fresh fetch fails, the cached value is returned with `_stale: true`. NOAA sometimes returns HTTP 200 with an error body — the server checks `.error` before caching to avoid poisoning the cache.
- `test/api.test.js` — integration tests. Spawn a server on :3001 and hit real endpoints. Transient upstream failures can cause flakes; retry once before investigating.
- `check-*.js` and `test-*.sh` — ad-hoc diagnostic scripts (apis, ferry, tides, midnight rollover). Not part of `npm test`.

### Data flow specifics worth knowing

- **Tides:** NOAA station 9445526 (Hansville) is a *subordinate* station — it only returns hi/lo predictions, not hourly data. The server generates 52h of hourly points via **cosine interpolation** between hi/lo events (smoother than linear, closer to real tidal curves) and serves them at `/api/tides/hourly`.
- **Ferry:** WSF API uses `/Date(ms)/` timestamp format that needs regex extraction. The schedule endpoint is `scheduletoday` — only today's sailings. Display logic uses *count-based* "last departed + next 3" (not a time window), so end-of-day handling and the 🔔 Last marker work naturally.
- **Moon phase:** rendered client-side as pure-geometry SVG (two overlapping ellipses, dark side unfilled so card background shows through). No images, no API.
- **Staleness indicators:** per-source thresholds — fresh ≤1×, amber 1.5×, red/pulsing 2.5× the refresh interval. Server cache TTLs match client refresh intervals; query windows include headroom (e.g. tides fetches 52h for a 48h display).

## Common pitfalls (from AGENTS.md)

1. The `Edit` tool struggles with emoji matching in `old_string`. For complex HTML edits involving emoji, prefer rewriting a larger surrounding block.
2. NOAA returns 200-with-error-body — always check for `.error` before caching.
3. SVG variable ordering: shared time-range variables (`startMs2`, `totalMs`, etc.) must be declared before any block that uses them. Past bug: daylight shading broke when time-range vars were defined after the code that needed them.
4. `preserveAspectRatio="none"` on sparkline and thermometer SVGs is intentional — they stretch to fill their flex containers. Don't "fix" it.
5. After editing `server.js`, the in-memory cache persists until you `bash restart.sh`. `npm run dev` (node --watch) handles this automatically.
