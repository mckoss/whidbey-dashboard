# Whidbey Island Dashboard

Ambient dashboard for the Whidbey Island beach house. Displays:

- 🕐 Real-time digital clock
- 🌤 3-day weather forecast (Open-Meteo, no API key needed)
- 🌊 Tide predictions — Hansville NOAA station (closest to south Whidbey)
- ⛴ Clinton → Mukilteo ferry schedule + drive-up space estimate

## Setup

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env — add your WSDOT API key (free, see below)

# Run
npm start
# Open http://localhost:3000
```

## WSDOT Ferry API Key

The ferry schedule requires a free API key from WSDOT:

1. Register at https://www.wsdot.wa.gov/traffic/api/
2. Add `WSF_API_KEY=your_key` to your `.env` file

Weather and tides work without any API keys.

## Data sources

| Data | Source | Key required |
|------|--------|-------------|
| Weather | [Open-Meteo](https://open-meteo.com) | No |
| Tides | [NOAA CO-OPS](https://tidesandcurrents.noaa.gov) station 9445526 (Hansville) | No |
| Ferry schedule | [WSDOT Traveler API](https://www.wsdot.wa.gov/ferries/api/) | Yes (free) |

## Display

Designed for always-on display on a TV or monitor. Dark theme, auto-refreshes:
- Weather: every 10 minutes
- Tides: every 30 minutes
- Ferry: every 5 minutes
