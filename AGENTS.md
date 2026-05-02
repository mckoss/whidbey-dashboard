# AGENTS.md — Whidbey Dashboard

Context and design decisions for AI agents working on this project.

## What This Is

An ambient TV dashboard for Mike Koss's Whidbey Island beach house. Single-screen, no-scroll, dark-themed, always-on. Shows weather, tides, and ferry status for the Clinton/Mukilteo corridor.

## Hard Rules

1. **`npm test` green before every `git commit`.** No exceptions.
2. **Commit at feature completion, not turn-by-turn.** Interactive sessions involve many back-and-forth turns to refine a feature. Don't commit after every edit — wait until the feature or fix feels complete. When you think it's a good checkpoint, ask: "Shall I commit now?" and wait for confirmation before running `git commit`. **Exception:** if Mike hasn't responded in 15+ minutes and there are uncommitted changes at a clean stopping point, go ahead and commit without asking.
2. **No bundlers.** Single-file frontend (`public/index.html`), plain Express server (`server.js`). This is intentional.
3. **No scrolling.** `height: 100vh; overflow: hidden` on body. Everything must fit one TV screen.
4. **Restart after server changes.** `bash restart.sh` kills the old process and starts fresh.
5. **Bump the version before every push.** The version string lives in `public/index.html` in the `<h1>` tag (e.g. `v1.2.0`). Increment the patch for fixes, minor for features. This is how Mike confirms which build is deployed on Railway.
6. **Every commit message must include the current version number** in the format `(vX.Y.Z)` — even README-only or server-only commits that don't bump the version. Use the current version at time of commit, e.g. `README: fix ferry interval (v1.4.3)`. This lets Mike find and revert to any point in history by version.

## Architecture

```
public/index.html  — All HTML + CSS + JS (single file, ~1000 lines)
server.js          — Express server, in-memory cache, API proxying
test/api.test.js   — Integration tests (spawns own server on :3001)
restart.sh         — Kill old server, start new one on :3000
.env               — WSF_API_KEY (not committed)
```

**No build step.** Edit → restart → refresh.

## Design History & Decisions

### Layout (fit-to-TV)

The dashboard went through several rounds of shrinking to fit a TV without scrolling. Padding, gaps, font sizes, and section heights were all reduced iteratively. Key constraints:
- Body: `height: 100vh; overflow: hidden`
- Tides: exactly 4 rows via CSS `grid-template-rows: repeat(4, 1fr)` — no partial clipping
- Weather: flex layout with `space-evenly` to fill vertical space
- Ferry panels: `height: fit-content` to hug content

### Ferry: Two-Panel Bidirectional

Originally one panel (Clinton→Mukilteo only). Split into two side-by-side cards because both directions are useful at the beach house (going to and coming from the island).

**Display logic:** Last departed + next 3 sailings (count-based, not time-window). This was chosen over time-window because:
- It naturally handles end-of-day (the "last sailed" card persists)
- "🔔 Last" label only fires on the truly last sailing of the entire day schedule
- Countdown badge advances every 30s by walking the full sailing list

**Slide animation:** When the next sailing transitions (current time passes a departure), old cards slide left and new card enters from right (420/450ms ease).

**Space occupancy:** Shows vessel name + fill bar (using WSF's hex colors) + space count. When all spaces are open (no cars booked), shows "N open" in green text without a bar — this distinguishes "empty ferry" from "no data."

### Tides: Sparkline + Thermometer

NOAA station 9445526 (Hansville) is a subordinate station — it only provides hi/lo predictions, not hourly readings. The server generates hourly points via **cosine interpolation** between hi/lo events (smoother than linear, closer to real tidal curves).

**Sparkline:** 48h of hourly data rendered as SVG. Key features:
- Gradient fill matching the thermometer (teal → deep navy)
- Time markers at 6am, noon, 6pm, midnight (bold/dashed distinction)
- Now-line (white dashed vertical)
- Day/night background: full-height rectangles behind the gradient — blue-tinted white (`rgba(173,216,255,0.25)`) for day, black for night, with 1-hour gradient transitions at sunrise/sunset
- Refreshes visually every 1 minute without re-fetching (uses cached `_lastHourlyPredictions` global)

**Thermometer:** Vertical bar alongside the sparkline.
- Rounded tube outline with subtle stroke (same contrast as gridlines)
- Flat inset fill rect (not rounded) with gap from tube walls — so the tube outline is visible
- Fill uses same gradient as sparkline
- SVG triangle arrow (not text) with base at the waterline level, ▲ rising / ▼ falling
- Axis labels: blue (`#38bdf8`) for high, purple (`#a78bfa`) for low — matching the tide table row colors
- Arrow and labels are in separate columns (arrow doesn't overlap tube, labels don't overlap arrow)

### Staleness Indicators

Each card has an inline age tag after its title. The staleness system is **per-source** — each data type only warns when it's older than its own refresh interval:

| Source | Refresh | Amber (⚠) | Red (pulsing ⚠) |
|--------|---------|-----------|-----------------|
| Weather | 1 hour | >90 min (1.5×) | >2.5 hours (2.5×) |
| Tides | 2 hours | >3 hours (1.5×) | >5 hours (2.5×) |
| Ferry | 5 min | >7.5 min (1.5×) | >12.5 min (2.5×) |

Server-side cache TTLs match client refresh intervals. Data query windows include headroom (e.g., tide hourly fetches 52h for 48h display + 2h refresh buffer).

NOAA sometimes returns HTTP 200 with an error body — the server guards against caching these by checking for `.error` in the response.

### Sunrise/Sunset

Added to the weather card header (☀️/🌙 icons, stacked vertically). Data comes from Open-Meteo's `daily.sunrise/sunset` fields — no separate endpoint. Values stored as `window._sunriseMs` / `window._sunsetMs` globals, shared by the weather card and the sparkline day/night rendering.

### Color Palette

- `--accent: #38bdf8` (sky blue) — tide highs, accents
- `--tide-low: #a78bfa` (purple) — tide lows
- `#f87171` (red) — tide arrow, danger states
- `#0c1a2e` (deep navy) — card backgrounds, tube fills
- Day background: `rgba(173,216,255,0.25)` (blue-tinted white at 25%)
- Night background: `#000000`

## Git Workflow

- **Prefer rebase over merge** to keep a clean linear history. When integrating a feature branch: `git rebase master` on the branch, then fast-forward merge (`git merge --ff-only`).
- Feature branches live in worktrees under `~/projects/whidbey-dashboard-<feature>/`.
- `.env` is git-ignored — copy it manually into each new worktree before testing.

## Common Pitfalls

1. **Unicode in `edit` tool:** The `edit` tool struggles with emoji matching in `oldText`. For complex HTML edits involving emoji, use Python string replacement scripts or rewrite the full section.
2. **NOAA error-in-200:** The NOAA API sometimes returns `200 OK` with `{"error":{"message":"..."}}`. Always check for `.error` before caching.
3. **SVG variable ordering:** If adding computed SVG elements, make sure shared variables (like `startMs2`, `totalMs`) are declared before all blocks that use them. A past bug had daylight shading broken because time-range variables were defined after the code that needed them.
4. **`preserveAspectRatio="none"`:** Both sparkline and thermometer SVGs use this intentionally — they stretch to fill flex containers. Don't remove it.
5. **Ferry schedule API:** WSF uses `scheduletoday` — returns only today's sailings. The `/Date(ms)/` format in space data needs regex extraction.
6. **Stale restart:** After editing `server.js`, the old in-memory cache persists until restart. Always `bash restart.sh`.

## Testing

```bash
npm test  # Runs: node --test test/api.test.js
```

Tests spawn their own server on port 3001 (separate from the dev server on 3000). Tests cover all API endpoints + HTML structure. Transient network failures from upstream APIs can cause flaky test runs — retry once before investigating.
