# South Whidbey Island Dashboard

Ambient dashboard for the Whidbey Island beach house. Designed for always-on TV display — fits a single screen with no scrolling (`height: 100vh; overflow: hidden`).

See the hosted version at [whidbey-dashboard.mckoss.com](https://whidbey-dashboard.mckoss.com)

## Features

- 🕐 Real-time digital clock (12-hour, am/pm)
- 🌤 3-day weather forecast with current conditions (Open-Meteo)
- 🌅 Sunrise & sunset times (from Open-Meteo daily data, shown in weather card header)
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
  "lat": 47.9748,
  "lon": -122.3534,
  "timezone": "America/Los_Angeles",
  "wsfApiKey": "your_wsdot_api_key_here",
  "wsfDepartingTerminal": 5,
  "wsfArrivingTerminal": 14,
  "wsfRouteId": 7,
  "gaMeasurementId": null,
  "googleClientId": "your-google-oauth-client-id.apps.googleusercontent.com",
  "adminUsers": [
    "mike@example.com"
  ]
}
```

The WSDOT ferry API key is free from https://www.wsdot.wa.gov/traffic/api/.
For Railway, set the same JSON object as a `CONFIG_JSON` environment variable.
`config.json` and `CONFIG_JSON` use the same canonical keys.

Weather and tides work without any API keys.

## Admin

Visit `/admin` to sign in with Google and manage the dashboard. Admin tools can
add/edit/delete user-managed messages in the bottom crawl and edit WSF alert
parenthetical context shown after the first matching query substring, including
an optional CSS color string for matched alert text.

User messages are separate from WSF ferry alerts in storage and management, but
they render in the same single-line marquee: WSF alerts first, then user-added
messages, then the duplicate wrap copy. User messages use the dashboard heading
blue (`--accent`) so they are visually distinct from WSF warning yellow and
disruption red.

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
| Weather | [Open-Meteo](https://open-meteo.com) | No | 1 hour | 1 hour |
| Tides (hi/lo) | [NOAA CO-OPS](https://tidesandcurrents.noaa.gov) station 9445526 | No | 2 hours | 2 hours |
| Tides (hourly) | NOAA (cosine-interpolated from hi/lo) | No | 2 hours | 2 hours |
| Ferry schedule | [WSDOT Traveler API](https://www.wsdot.wa.gov/ferries/api/) | Yes (free) | 30 sec | 30 sec |
| Ferry space | WSDOT Traveler API | Yes (free) | 30 sec | 30 sec |

Data windows include headroom beyond the refresh interval (e.g., tide hourly fetches 52h for a 48h display with 2h refresh cycle).

Cache files are written to `dataDir` in `config.json`, or local `./data` when
`dataDir` is omitted. For Railway persistence across deploys, mount a Railway
Volume at `/app/data` and set `"dataDir": "/app/data"` in `config.json`; local
development will keep using the repo's `data/` directory unless configured
otherwise.

## Staleness Indicators

Each card shows an inline age tag after the title. Thresholds are per-source:

- **Fresh (✓ live):** within 1× the refresh interval
- **Amber (⚠ Xm old):** 1.5× the refresh interval
- **Red/pulsing (⚠ Xm old):** beyond 2.5× the refresh interval

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/weather` | 3-day forecast + current conditions + sunrise/sunset |
| `GET /api/tides` | Hi/lo predictions, 3 days |
| `GET /api/tides/hourly` | Cosine-interpolated hourly predictions, 52h |
| `GET /api/ferry/clinton` | Clinton→Mukilteo schedule (today) |
| `GET /api/ferry/mukilteo` | Mukilteo→Clinton schedule (today) |
| `GET /api/ferry/clinton/space` | Drive-up space by departure (Clinton) |
| `GET /api/ferry/mukilteo/space` | Drive-up space by departure (Mukilteo) |
| `GET /api/ferry` | Legacy alias for `/api/ferry/clinton` |
| `GET /api/messages` | User-managed crawl messages |
| `POST /api/messages` | Add a user-managed crawl message (Google admin auth required) |
| `PUT /api/messages/:id` | Update a user-managed crawl message (Google admin auth required) |
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
- `window._sunriseMs` / `window._sunsetMs` are globals used by both the sparkline and the weather card.
- Ferry WSF API uses `/Date(ms)/` format for timestamps.
- The `preserveAspectRatio="none"` on sparkline/thermometer SVGs is intentional — they stretch to fill their flex containers.
