#!/bin/bash
fuser -k 3000/tcp 2>/dev/null
sleep 1
node /home/mckoss/projects/whidbey-dashboard/server.js
