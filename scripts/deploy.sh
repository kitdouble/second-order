#!/usr/bin/env bash
# Build locally and push to the server. Usage: npm run deploy   (or HOST=1.2.3.4 npm run deploy)
set -euo pipefail
HOST="${HOST:-2ndorder.live}"
cd "$(dirname "$0")/.."

npm run check:tools
npm run build
rsync -az --delete \
  --exclude node_modules --exclude data --exclude .git --exclude .env --exclude .claude --exclude .DS_Store \
  ./ "root@${HOST}:/opt/second-order/"
ssh "root@${HOST}" bash -s <<'REMOTE'
set -euo pipefail
cd /opt/second-order
npm ci --omit=dev --no-audit --no-fund
chown -R root:root /opt/second-order && chmod 644 .env
DOMAIN=$(sed -n 's#^APP_ORIGIN=https\{0,1\}://##p' .env | head -1)
# The self-service ESM site: Caddy serves esm.<host> (its certificate comes once DNS points there), and the
# app moves sign-up and owner links to it once the name resolves here, so links never point at a missing site.
if [ -n "$DOMAIN" ] && ! grep -q "esm\.${DOMAIN}" /etc/caddy/Caddyfile; then
  sed -i "1s/^\(.*\) {\$/\1, esm.${DOMAIN} {/" /etc/caddy/Caddyfile
  systemctl reload caddy
fi
if [ -n "$DOMAIN" ] && ! grep -q '^ESM_ORIGIN=' .env && getent hosts "esm.${DOMAIN}" >/dev/null; then
  echo "ESM_ORIGIN=https://esm.${DOMAIN}" >> .env
fi
grep -q '^ESM_ORIGIN=' .env && echo "ESM site: on ($(grep '^ESM_ORIGIN=' .env | cut -d= -f2))" || echo "ESM site: waiting for DNS for esm.${DOMAIN}"
systemctl restart second-order-sim second-order
systemctl is-active second-order
curl -fsS --retry 10 --retry-delay 1 --retry-connrefused http://127.0.0.1:3000/api/health && echo
REMOTE
