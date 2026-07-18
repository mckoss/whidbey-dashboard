# South Whidbey Island Dashboard

Ambient dashboard for the Whidbey Island beach house. Designed for always-on TV display — fits a single screen with no scrolling (`height: 100vh; overflow: hidden`).

See the hosted version at [whidbey-dashboard.mckoss.com](https://whidbey-dashboard.mckoss.com)

## Features

- 🕐 Real-time digital clock (12-hour, am/pm)
- 🌤 3-day weather forecast with current conditions (NWS primary, Open-Meteo fallback)
- 🌊 Observed seawater temperature from NOAA Port Townsend in the weather header
- 🌅 Sunrise & sunset times (calculated locally, shown in weather card header)
- 🌕 Moon phase display — SVG rendered client-side with pure geometry, no images
- 🌊 Tide predictions — hi/lo table + sparkline + thermometer (NOAA Hansville station)
- ⛴ Bidirectional ferry: Clinton→Mukilteo and Mukilteo→Clinton, with live space occupancy
- ⚠ Per-source data staleness indicators

## Setup

```bash
npm install
cp config.example.json config.json
# Edit config.json — add your WSDOT API key and Google admin settings
npm start
# Open http://localhost:3000
```

## Configuration

Runtime configuration lives in ignored `config.json`. Copy
`config.example.json` and edit it for local development or production deploys:

```json
{
  "port": 3000,
  "dataDir": "data",
  "noaaStation": "9445526",
  "noaaBaseUrl": "https://api.tidesandcurrents.noaa.gov",
  "lat": 47.9748,
  "lon": -122.3534,
  "timezone": "America/Los_Angeles",
  "wsfApiKey": "your_wsdot_api_key_here",
  "wsfDepartingTerminal": 5,
  "wsfArrivingTerminal": 14,
  "wsfRouteId": 7,
  "wsfApiMinIntervalMs": 60000,
  "wsfRawLogDir": "data/wsf-raw",
  "gaMeasurementId": null,
  "analyticsGeoUrl": "https://ipapi.co/{ip}/json/",
  "googleClientId": "your-google-oauth-client-id.apps.googleusercontent.com",
  "sessionSecret": "replace-with-a-long-random-session-secret",
  "adminUsers": [
    "mike@example.com"
  ]
}
```

The WSDOT ferry API key is free from https://www.wsdot.wa.gov/traffic/api/.
For Railway, set the same JSON object as a `CONFIG_JSON` environment variable.
`config.json` and `CONFIG_JSON` use the same canonical keys.
WSF ferry API calls are limited to at most one outbound request per endpoint and
parameter set per minute. Raw WSF responses are appended under `wsfRawLogDir` as
2 AM operational-day JSONL files named `yyyy/mm/yyyy-mm-dd-wsfdata.jsonl`; each
record includes the response timestamp, sanitized call parameters, HTTP status,
and raw JSON response.

Weather and tides work without any API keys.

Dashboard view analytics are written as append-only JSONL files under
`dataDir/analytics`. Public views and admin-authenticated views are stored in
separate files, and first-seen IP addresses are logged under `analytics/ips`.
The server attempts a best-effort geolocation lookup for public IP addresses
using `analyticsGeoUrl`; set that value to `null` or an empty string to disable
geolocation.

## Admin

Visit `/admin` to sign in with Google and manage the dashboard. Admin tools can
add/edit/delete user-managed messages in the bottom crawl, including optional
scheduling and CSS color text, and edit WSF alert parenthetical context shown
after the first matching query substring, including an optional CSS color string
for matched alert text.

Signed-in admins can open `/admin/tracking` from the admin page to review recent
dashboard view analytics, newest first.

User messages are separate from WSF ferry alerts in storage and management, but
they render in the same single-line marquee: WSF alerts first, then user-added
messages, then the duplicate wrap copy. User messages use the dashboard heading
blue (`--accent`) so they are visually distinct from WSF warning yellow and
disruption red.

User messages can optionally include `startDate` and/or `endDate` as
`YYYY-MM-DD` Pacific dates, using the configured `timezone`
(`America/Los_Angeles` by default). The public crawl only includes messages
active on the current Pacific calendar date: before `startDate` is hidden, after
`endDate` is hidden, and blank dates are open-ended. Date boundaries switch at
midnight in that Pacific timezone, so a message with an `endDate` remains active
through that whole Pacific calendar day. User messages can also include optional
safe CSS color text such as `orange`, `#38bdf8`, or `var(--accent)`. The admin
page includes inactive messages so scheduled or expired entries can still be
edited or deleted.

Ferry alert parentheticals are stored in `alert-context.json` under `dataDir`.
The server seeds defaults for known WSF alert text when that file does not
exist, and admin edits replace those defaults with the saved file. Each entry
has a query substring, parenthetical text, and optional color. The first query
that appears anywhere in the normalized WSF alert title or text wins; matches
are case-insensitive and are not combined. The optional color field accepts safe
CSS color text such as `orange`, `#f59e0b`, `rgb(245 158 11)`, `oklch(80% 0.14
85)`, or `var(--danger)`.

Admin auth uses Google Identity Services. Create a Google OAuth web client and
put the public client ID plus the approved `adminUsers` list in `config.json`.
After Google sign-in, the server sets a 30-day `HttpOnly`, `Secure`,
`SameSite=Lax` admin session cookie so `/admin` stays signed in across page
reloads and deploys. Set a stable, long random `sessionSecret` in `config.json`
or Railway `CONFIG_JSON`; changing or omitting that secret logs admins out on
server restart.

### Google OAuth Client Setup

The admin page uses a Google OAuth **web client ID** only. It does not use a
client secret or service account because the browser gets a Google ID token and
the server verifies that token against the configured client ID.

1. Open [Google Cloud Console OAuth clients](https://console.cloud.google.com/auth/clients)
   and select the project that should own the dashboard auth settings.
2. If that URL does not land on the client list, open the navigation menu and go
   to **APIs & Services** → **Credentials**, then click **Create credentials** →
   **OAuth client ID**. The same screen may also appear as **Google Auth
   Platform** → **Clients** in newer Cloud Console navigation.
3. If Google asks for the OAuth consent screen first, go to **Google Auth
   Platform** → **Branding** or **OAuth consent screen** and complete the
   required fields:
   - App name: `Whidbey Dashboard`
   - User support email: your Google account
   - Audience: **External** with test users for a personal Gmail account, or
     **Internal** only if you are using a Google Workspace organization
   - Test users: add the same Google email addresses that will be listed in
     `adminUsers`
4. Return to **Clients** or **Credentials** → **Create credentials** → **OAuth
   client ID**.
5. Set **Application type** to **Web application** and name it
   `Whidbey Dashboard Admin`.
6. Under **Authorized JavaScript origins**, add every origin that will serve the
   admin page. Use only the scheme, host, and optional port; do not include a
   path or trailing slash:
   - `http://localhost:3000`
   - `https://whidbey-dashboard.mckoss.com`
7. Leave **Authorized redirect URIs** empty for this app. The dashboard uses the
   Google Identity Services sign-in button and sends the resulting ID token to
   the server; it does not run a redirect callback flow.
8. Click **Create**, then copy the generated **Client ID** ending in
   `.apps.googleusercontent.com` into `config.json` or Railway `CONFIG_JSON`:

```json
{
  "googleClientId": "your-client-id.apps.googleusercontent.com",
  "sessionSecret": "replace-with-a-long-random-session-secret",
  "adminUsers": [
    "mike@example.com"
  ]
}
```

Only emails listed in `adminUsers` can add or delete dashboard crawl messages,
even if another Google account successfully signs in.

## Architecture

**Single-file frontend:** `public/index.html` — all HTML, CSS, and JS in one file. No build step, no bundler.

**Server:** `server.js` — Express, ignored `config.json` or Railway `CONFIG_JSON` for runtime settings, memory-first cache per endpoint persisted to `data/cache.json`, stale-while-revalidate pattern. If a fresh fetch fails, serves stale data with `_stale: true` flag.

**Tests:** `npm test` runs `node --test test/api.test.js`. Tests spawn their own server on port 3001.

> **Rule:** Always run `npm test` green before `git commit`.

## Data Sources & Refresh

| Data | Source | API Key | Client Refresh | Server Cache |
|------|--------|---------|---------------|-------------|
| Weather | [NWS API](https://api.weather.gov) primary, [Open-Meteo](https://open-meteo.com) fallback | No | 1 hour | 1 hour |
| Seawater temperature | [NOAA CO-OPS](https://tidesandcurrents.noaa.gov) station 9444900 (Port Townsend) | No | 10 min | 10 min |
| Tides (hi/lo) | [NOAA CO-OPS](https://tidesandcurrents.noaa.gov) station 9445526 | No | 2 hours | 2 hours |
| Tides (hourly) | NOAA (cosine-interpolated from hi/lo) | No | 2 hours | 2 hours |
| Ferry schedule | [WSDOT Traveler API](https://www.wsdot.wa.gov/ferries/api/) | Yes (free) | 30 sec | 30 sec |
| Ferry space | WSDOT Traveler API | Yes (free) | 30 sec | 30 sec |

Data windows include headroom beyond the refresh interval (e.g., tide hourly fetches 52h for a 48h display with 2h refresh cycle).

Ferry history records raw WSDOT vessel GPS samples when `/api/ferry/history`
is hit. Production also uses `scripts/ferry-history-keepalive.sh` from system
cron once per minute to keep recording through low-traffic periods, especially
the midnight-to-2 AM tail of the operational ferry day.
History files are retained permanently by the app and written under dated
folders such as `data/ferry-history/2026/06/2026-06-20.json`. There is no
automated history cleanup; manually remove old files from the data volume if
you want to reclaim space.

Each ferry-history sample also stores the dashboard model's departure
projection for visible upcoming sailings. The history page uses those snapshots
to chart departure-estimate error for each recorded trip: minutes before actual
departure on the x-axis and prediction error in minutes on the y-axis, with the
dashboard model and WSF scheduled departure shown together for comparison.

Cache files are written to `dataDir` in `config.json`, or local `./data` when
`dataDir` is omitted. For Railway persistence across deploys, mount a Railway
Volume at `/app/data` and set `"dataDir": "/app/data"` in `config.json`; local
development will keep using the repo's `data/` directory unless configured
otherwise.

## Staleness Indicators

Cards stay quiet during normal refreshes and short-lived cache use. Inline
warnings appear only for persistent or actionable feed problems:

- **Weather:** hidden unless weather data is at least 3 hours old.
- **Ferry:** hidden unless ferry data is at least 10 minutes old.
- **Tides:** hidden while future tide forecast coverage reaches at least 48
  hours plus 1 hour of lead time. The sparkline may show the whole cached tide
  series, including past context; the warning is about the future forecast end.

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/weather` | 3-day forecast + current conditions + sunrise/sunset |
| `GET /api/seawater-temperature` | Latest observed seawater temperature from NOAA Port Townsend |
| `GET /api/tides` | Hi/lo predictions, 3 days |
| `GET /api/tides/hourly` | Cosine-interpolated hourly predictions, 52h |
| `GET /api/ferry/clinton` | Clinton→Mukilteo schedule (today) |
| `GET /api/ferry/mukilteo` | Mukilteo→Clinton schedule (today) |
| `GET /api/ferry/clinton/space` | Drive-up space by departure (Clinton) |
| `GET /api/ferry/mukilteo/space` | Drive-up space by departure (Mukilteo) |
| `GET /api/ferry` | Legacy alias for `/api/ferry/clinton` |
| `GET /api/ferry/departure-metrics` | Departure prediction error series for the history page |
| `GET /api/messages` | Active user-managed crawl messages; admins may pass `?includeInactive=1` |
| `POST /api/messages` | Add a user-managed crawl message, with optional `startDate`/`endDate`/`color` (Google admin auth required) |
| `PUT /api/messages/:id` | Update a user-managed crawl message, including optional `startDate`/`endDate`/`color` (Google admin auth required) |
| `DELETE /api/messages/:id` | Delete a user-managed crawl message (Google admin auth required) |
| `GET /api/alert-contexts` | WSF alert query → parenthetical text mappings |
| `POST /api/alert-contexts` | Add a WSF alert parenthetical (Google admin auth required) |
| `PUT /api/alert-contexts/:id` | Update a WSF alert parenthetical (Google admin auth required) |
| `DELETE /api/alert-contexts/:id` | Delete a WSF alert parenthetical (Google admin auth required) |
| `GET /api/cache-status` | Debug: cache metadata for all endpoints |

## Moon Phase Display

The moon phase SVG is calculated entirely client-side — no API, no images. A pure-geometry approach draws only the lit crescent/gibbous portion using two overlapping ellipses:

- The terminator ellipse is scaled from full (new moon) to flat (full moon) and flipped for waxing vs. waning
- Dark side: no fill — the card background shows through, giving a natural look
- Lit side: white fill with a thin grey outline
- Only the lit portion is drawn; the shadow side is implied by absence

This keeps the frontend fully self-contained and avoids any external moon-image asset.

## Ferry Display

- Two panels: one per direction, each in its own card
- Shows last departed + next 3 sailings (count-based)
- "🔔 Last" label on the final sailing of the day
- Live countdown badge, advances every 30s
- Slide animation when the next sailing transitions
- Space occupancy: vessel name, fill bar (WSF hex colors), space count
- Empty ferry (all spaces open) shows "N open" text without a bar
- Route delay: when recent departures in a direction have been consistently
  late, upcoming chips show the projected (tilde-prefixed) departure time in
  amber with the scheduled time underneath — inferred from GPS, distinct from a
  red, boat-specific confirmed delay. The chip does not show a separate
  "N min late" status label.

## Tide Display

- Hi/lo table: exactly 4 rows, past events dimmed
- Sparkline: 48h of cosine-interpolated hourly data
- Thermometer: vertical bar with gradient fill matching sparkline, inset from rounded tube outline
- Arrow (▲/▼) at waterline indicates rising/falling
- Axis labels: blue for high, purple for low (matching table colors)
- Time markers: 6am, noon, 6pm, midnight — bold for noon/midnight, dashed for 6am/6pm
- Now-line: white dashed vertical line at current time
- Visual refreshes every 1 minute without re-fetching data

## Key Technical Notes

- NOAA station 9445526 (Hansville) is a subordinate station — only provides hi/lo predictions, not hourly. Hourly data is generated server-side via cosine interpolation.
- NOAA sometimes returns HTTP 200 with an error body instead of a proper error code. The server guards against caching these.
- Weather uses NWS as the primary source and Open-Meteo as fallback. Sunrise/sunset are calculated server-side from latitude/longitude.
- `window._sunriseMs` / `window._sunsetMs` are globals used by both the sparkline and the weather card.
- Ferry WSF API uses `/Date(ms)/` format for timestamps.
- The `preserveAspectRatio="none"` on sparkline/thermometer SVGs is intentional — they stretch to fill their flex containers.
