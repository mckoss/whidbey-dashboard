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
cp .env.example .env
# Edit .env — add your WSDOT API key (free, see below)
npm start
# Open http://localhost:3000
```

## WSDOT Ferry API Key

Free key from https://www.wsdot.wa.gov/traffic/api/ — add as `WSF_API_KEY=your_key` in `.env`.

Weather and tides work without any API keys.

## User Crawl Messages

Visit `/message` to add or delete user-managed messages in the bottom crawl. The
`From` field is an email address typed into a password-style input; the server
accepts changes only from configured senders.

User messages are separate from WSF ferry alerts in storage and management, but
they render in the same single-line marquee: WSF alerts first, then user-added
messages, then the duplicate wrap copy. User messages use the dashboard heading
blue (`--accent`) so they are visually distinct from WSF warning yellow and
disruption red.

Production configuration uses JSON in `AUTHORIZED_MESSAGE_EMAIL_USERS`, either
as an array or an object with `authorizedMessageEmailUsers`:

```bash
AUTHORIZED_MESSAGE_EMAIL_USERS='["mike@example.com"]'
```

For local development, copy `config.example.json` to ignored `config.json` in
the repo root and edit the email list:

```json
{
  "authorizedMessageEmailUsers": [
    "mike@example.com"
  ]
}
```

## Architecture

**Single-file frontend:** `public/index.html` — all HTML, CSS, and JS in one file. No build step, no bundler.

**Server:** `server.js` — Express, memory-first cache per endpoint persisted to `data/cache.json`, stale-while-revalidate pattern. If a fresh fetch fails, serves stale data with `_stale: true` flag.

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

Cache files are written to `DATA_DIR`, then `RAILWAY_VOLUME_MOUNT_PATH`,
then local `./data` as a fallback. For Railway persistence across deploys,
mount a Railway Volume at `/app/data`; local development will keep using the
repo's `data/` directory.

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
| `POST /api/messages` | Add an authorized user-managed crawl message |
| `DELETE /api/messages/:id` | Delete an authorized user-managed crawl message |
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
