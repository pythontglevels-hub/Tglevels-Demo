#!/usr/bin/env bash
# Updates the code with no downtime. Run on the server from the code folder:
#   bash deploy/update.sh
# Historical data is in HISTORICAL_DIR (outside this folder) and is not touched.
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
npm ci --omit=dev
npm test
pm2 reload deploy/ecosystem.config.js --update-env
pm2 save
echo "Updated. Check: curl -fsS http://127.0.0.1:3000/api/config > /dev/null && echo OK"
