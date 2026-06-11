#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ferry-history-keepalive.sh [--url URL] [--timeout SECONDS]

Ping the Whidbey Dashboard ferry-history endpoint so production keeps recording
raw GPS samples through low-traffic periods, including the midnight-to-2 AM
operational-day tail.

Options:
  --url URL            Endpoint to ping.
                       Default: https://whidbey-dashboard.mckoss.com/api/ferry/history
  --timeout SECONDS    curl timeout in seconds. Default: 20
  -h, --help           Show this help.
EOF
}

URL="https://whidbey-dashboard.mckoss.com/api/ferry/history"
TIMEOUT="20"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url)
      URL="${2:-}"
      [[ -n "$URL" ]] || { echo "--url requires a value" >&2; exit 2; }
      shift 2
      ;;
    --timeout)
      TIMEOUT="${2:-}"
      [[ "$TIMEOUT" =~ ^[0-9]+$ ]] || { echo "--timeout requires an integer" >&2; exit 2; }
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

curl --fail --silent --show-error --max-time "$TIMEOUT" "$URL" >/dev/null
