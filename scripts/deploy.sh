#!/usr/bin/env bash
# Build locally and push to the server. Usage: npm run deploy   (or HOST=1.2.3.4 npm run deploy)
set -euo pipefail
HOST="${HOST:-2ndorder.live}"
cd "$(dirname "$0")/.."

npm run build
rsync -az --delete \
  --exclude node_modules --exclude data --exclude .git --exclude .env --exclude .claude --exclude .DS_Store \
  ./ "root@${HOST}:/opt/second-order/"
ssh "root@${HOST}" 'cd /opt/second-order \
  && npm ci --omit=dev --no-audit --no-fund \
  && chown -R root:root /opt/second-order && chmod 644 .env \
  && systemctl restart second-order-sim second-order \
  && systemctl is-active second-order \
  && curl -fsS --retry 10 --retry-delay 1 --retry-connrefused http://127.0.0.1:3000/api/health && echo'
