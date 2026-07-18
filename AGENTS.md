# AGENTS.md — Whidbey Dashboard

Context and design decisions for AI agents working on this project.

## What This Is

An ambient TV dashboard for Mike Koss's Whidbey Island beach house. Single-screen, no-scroll, dark-themed, always-on. Shows weather, tides, and ferry status for the Clinton/Mukilteo corridor.

## Hard Rules

1. **`npm test` green before every `git commit`.** No exceptions.
2. **Commit and push completed green work.** Interactive sessions involve many back-and-forth turns to refine a feature. Don't commit after every edit — wait until the requested feature or fix is complete. Once Mike's requested operation is complete, `npm test` and `git diff --check` pass, and there are no open questions or blockers, commit and push immediately without asking for a separate confirmation. Ask before committing only when scope is ambiguous, tests cannot be run/pass, there are unresolved product questions, or committing could include unrelated work.
2. **No bundlers.** Single-file frontend (`public/index.html`), plain Express server (`server.js`). This is intentional.
3. **No scrolling.** `height: 100vh; overflow: hidden` on body. Everything must fit one TV screen.
4. **Restart after server changes.** `bash restart.sh` kills the old process and starts fresh.
5. **Bump the version before every push.** The version string comes from `package.json` via `/api/config` and displays in the page header. Use semantic versioning with judgment: bump **major** for incompatible configuration/API changes, **minor** for new user-visible features, and **patch** for bug fixes or small improvements. Most UI work here will be minor or patch; major is rare. This is how Mike confirms which build is deployed on Railway.
6. **Every commit message must include the current version number** in the format `(vX.Y.Z)` — even README-only or server-only commits that don't bump the version. Use the current version at time of commit, e.g. `README: fix ferry interval (v1.5.0)`. This lets Mike find and revert to any point in history by version.

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

### Product Judgment Before Code Completeness

This is a glanceable ambient dashboard, not a generic web page. Passing tests and matching CSS selectors is not enough. Before calling a UI change done, evaluate whether the result makes sense to someone reading the TV from across the room.

For every visible UI change:
- Check semantic meaning, not just consistency. Color, motion, size, and emphasis must communicate the right thing.
- Prefer existing design tokens and page patterns before adding new visual language.
- Treat red as a local alarm state. It should apply only to the specific item that is dangerous or disrupted, not to nearby informational content.
- Treat yellow as warning/informational attention. Ordinary WSF notices, all-routes policy messages, and non-disruption updates should stay yellow unless their own text indicates cancellation/outage/mechanical/one-boat disruption.
- Test mixed-content cases when severity can vary within one component. Example: one ferry cancellation plus one all-routes pets notice must render the cancellation red and the pets notice yellow.
- Ask whether a technically neat simplification changes the product meaning. A single global severity class may be simpler, but it is wrong when unrelated messages need different meanings.

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

**Route-level inferred delay:** Per-boat lateness only surfaces once a specific sailing has a direct signal (a confirmed/observed departure or a matched live vessel). That left upcoming chips reading "on time" even when every recent departure was running 15–20 min late. The server now derives a per-direction route delay (`ferryRouteDelaySummary`) and publishes server-resolved chip rows (`resolvedSailings` in `/api/ferry/departures`) with status, effective time, vessel name, and source. The client renders those resolved rows instead of rebuilding ferry scheduling decisions from raw vessel positions. Projected departures render as an amber, tilde-prefixed time with the scheduled time underneath; do not add a separate "~N min late" status note. Amber = inferred expectation, red = a real tracked delay. Direct signals and server-confirmed missed slots always win, so an inferred delay never reframes a Departed or Missed chip. Directions with too few recent departures (startup, schedule gaps, end of day, GPS offline) emit nothing, avoiding false positives.

**Vessel-label confidence (`resolveVesselName`):** A chip's vessel name has a confidence tier. *Direct* evidence — a server-confirmed departure, a recent GPS vessel correction, or a matched live vessel location — is trusted unconditionally. A name taken only from the WSF space/schedule row is *low-confidence*: WSF's `terminalsailingspace` feed sometimes repeats the same `VesselName` across several consecutive future departures before the real assignment is firm. A single boat cannot make two same-direction departures inside one round trip (`MIN_SAME_VESSEL_GAP_MS`, 45 min — the half-hour schedule legitimately re-runs a boat every ~60 min with two boats alternating), so a low-confidence label that would repeat a vessel inside that window is dropped rather than shown. Direct labels are never dropped, and non-conflicting low-confidence labels (true alternating boats 60 min apart) are preserved. This prevents the physically-impossible "same boat on three back-to-back half-hour chips" seen when a route delay pushed all the projected times out.

**GPS-dominant ferry status:** When fresh live GPS is available for the assigned or otherwise matched vessel, treat it as the dominant signal for current and predicted ferry status. The WSF schedule is context for labels and baseline times; it is not proof that a vessel departed, missed, or can no longer serve an overdue sailing. Observed actual departure evidence still wins, because GPS/LeftDock proves the boat really left. Otherwise, live vessel position plus the route's turnaround-time and transit-speed heuristics should outrank schedule-derived `missed`, `unknown`, `scheduled`, `Departed?`, or space-row inference. Do not show `Departed`, `Departed?`, or `Missed` when live GPS shows the assigned/matched vessel has not reached or left the departure terminal; render it as GPS-projected/late or explicitly unknown without implying departure. Keep server `resolvedSailings` behavior and browser fallback behavior aligned, and add regression tests before changing this precedence.

**Smooth underway ETA (prefer WSF's published ETA):** An underway vessel's projected departure used to be `latest.ms + remaining_pct / instantaneous_slope`, where the slope came from the last 2–3 GPS fixes (~2 min). Dividing by that tiny, noisy slope made the projected time swing 30–50 min sample-to-sample, and collapse-to-schedule whenever the slope briefly read zero. An offline replay of every recorded trip (reconstruct day state at each 60s snapshot, read `resolvedSailings[key].effectiveDepartureMs`) showed worst-case frame-to-frame jumps of ~59 min (Whidbey) / ~81 min (Bainbridge). The fix: `ferryVesselStatusSummary` now prefers WSDOT's own `etaMs` from the GPS sample (already smoothed) for the arrival ETA, falling back to a least-squares slope (`ferryRobustProgressPerMinute`, over `FERRY_GPS_VELOCITY_WINDOW_MS`) only when WSF gives no ETA — which is the case in tests, so their exact derived values are unchanged. This roughly halved Bainbridge >10-min jumps and cut Whidbey's worst spike to ~35 min. The residual jumps are the projected↔scheduled on/off flap (a slot losing its anchoring vessel for a frame); fixing that needs a stateful hold of the last projection and was left as follow-up. Do not revert to instantaneous-slope ETA.

**Whole-day WSF schedule rows:** WSF schedule payloads may include the full service day, including AM departures long after the display has moved into PM service. Old `missed` rows are valid raw history, but they are not visible dashboard context. The card list should use the last real departed/unknown row plus upcoming rows; never promote a stale `missed` AM row into the previous-sailing slot just because it is the last row before now. Ferry API JSON should also be served with no-store headers so browsers and edge caches do not keep an old service-day payload after the live resolver has advanced.

**Compiled history is ferry chip truth:** The ferry history table reconciles GPS tracks into scheduled-vs-actual trip rows. The main dashboard chips should consume that same server-compiled trip truth through `/api/.../ferry/departures` before applying live projections. Do not rebuild a competing browser-side or schedule-row/vessel-name matching algorithm for chip identity when compiled history rows or server `resolvedSailings` exist. A GPS track may prove that a vessel left a terminal, but an approaching vessel with `arrivingTerminalId` must not be interpreted as departing that terminal.

Repo-specific ferry-status lessons like this belong in this `AGENTS.md`, not in OpenClaw workspace memory. OpenClaw session memory may record what changed or what was pushed, but durable rules for this codebase should live with the repo.

### Tides: Sparkline + Thermometer

NOAA station 9445526 (Hansville) is a subordinate station — it only provides hi/lo predictions, not hourly readings. The server generates hourly points via **cosine interpolation** between hi/lo events (smoother than linear, closer to real tidal curves).

**Sparkline:** fixed 72h window of hourly data rendered as SVG. The x-axis
domain must not stretch when the available prediction range is shorter; draw
the data through its real end time and mark the missing right edge in amber.
Old NOAA fetch age is not itself a warning because tide predictions are
deterministic, but missing coverage within the fixed display window should be
visible. Key features:
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

Each card has an inline age tag after its title, but quiet is the normal state.
Do not show freshness or slightly-stale badges. The dashboard should warn only
when a feed problem is persistent enough to matter to someone glancing at it:

| Source | Refresh | Visible Warning |
|--------|---------|-----------------|
| Weather | 1 hour | Weather data at least 3 hours old |
| Tides | 2 hours | Tide data is expired, unavailable, or ending within 1h |
| Ferry | 30 sec | Ferry data at least 10 minutes old |

Server-side cache TTLs match client refresh intervals. Data query windows include headroom. Tide predictions are deterministic; when NOAA is stale/unavailable, regenerate hourly sparkline points from cached high/low predictions before falling back to a stale hourly cache. Do not show an alert merely because the NOAA fetch age is old or because less than 48h of future tide predictions remain.

NOAA sometimes returns HTTP 200 with an error body — the server guards against caching these by checking for `.error` in the response.

### Sunrise/Sunset

Added to the weather card header (☀️/🌙 icons, stacked vertically). Data comes from Open-Meteo's `daily.sunrise/sunset` fields — no separate endpoint. Values stored as `window._sunriseMs` / `window._sunsetMs` globals, shared by the weather card and the sparkline day/night rendering.

### Seawater Temperature

The Whidbey weather card includes observed seawater temperature from NOAA CO-OPS Port Townsend station `9444900`. Hansville `9445526` is still the right local tide-prediction station, but it does not publish the `water_temperature` product. Keep seawater temperature as a compact right-aligned weather-title badge so it does not add height to the weather card.

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
