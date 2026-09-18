#!/bin/bash
# Kill whatever is holding the port and start fresh. Needed after server.js
# edits, the same as in whidbey-dashboard.
fuser -k "${PORT:-3000}/tcp" 2>/dev/null
sleep 1
node "$(dirname "$0")/server.js"
