#!/bin/sh
set -e
mkdir -p /app/data
if [ "$(id -u)" = "0" ]; then
  chown -R node:node /app/data 2>/dev/null || true
  exec gosu node node server.js
fi
exec node server.js
