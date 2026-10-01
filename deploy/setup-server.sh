#!/usr/bin/env bash
# One-time setup for a fresh Ubuntu 24.04+ BinaryLane VPS (safe to re-run). Run as root:
#   ssh root@<server-ip> 'bash -s' < deploy/setup-server.sh
set -euo pipefail
DOMAIN="${DOMAIN:-2ndorder.live}"

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get upgrade -yq
apt-get install -yq curl rsync ufw unattended-upgrades

# Node 24 (needs >= 22.13 for node:sqlite)
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -yq nodejs

# Caddy: HTTPS reverse proxy with automatic Let's Encrypt certificates.
# From Ubuntu's own archive (patched by unattended-upgrades); Caddy's apt repo key had expired.
apt-get install -yq caddy

# App user and directories: code in /opt, database in /var/lib
id secondorder &>/dev/null || useradd --system --home /opt/second-order --shell /usr/sbin/nologin secondorder
# Simulations run experiment code as their own user, in the secondorder group so the app can reach the socket.
id secondorder-sim &>/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin --gid secondorder secondorder-sim
mkdir -p /opt/second-order /var/lib/second-order
chown secondorder:secondorder /var/lib/second-order
chmod 700 /var/lib/second-order

if [ ! -f /opt/second-order/.env ]; then
  cat > /opt/second-order/.env <<ENV
APP_ORIGIN=https://${DOMAIN}
RUN_ORIGIN=https://run.${DOMAIN}
API_PORT=3000
DB_PATH=/var/lib/second-order/second-order.db
SIM_SOCKET=/run/second-order-sim/sim.sock
ENV
fi
grep -q '^SIM_SOCKET=' /opt/second-order/.env || echo 'SIM_SOCKET=/run/second-order-sim/sim.sock' >> /opt/second-order/.env

cat > /etc/systemd/system/second-order.service <<'UNIT'
[Unit]
Description=Second Order
After=network.target second-order-sim.service
Wants=second-order-sim.service

[Service]
User=secondorder
WorkingDirectory=/opt/second-order
Environment=NODE_ENV=production
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning --env-file=/opt/second-order/.env server/index.js
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/second-order -/run/second-order-sim

[Install]
WantedBy=multi-user.target
UNIT

# Simulated participants run untrusted experiment code: no network, no data, read-only, capped memory.
cat > /etc/systemd/system/second-order-sim.service <<'UNIT'
[Unit]
Description=Second Order simulations
After=network.target

[Service]
User=secondorder-sim
Group=secondorder
WorkingDirectory=/opt/second-order
Environment=SIM_SOCKET=/run/second-order-sim/sim.sock
ExecStart=/usr/bin/node server/sim/service.js
Restart=on-failure
RuntimeDirectory=second-order-sim
RuntimeDirectoryMode=0750
PrivateNetwork=true
RestrictAddressFamilies=AF_UNIX
IPAddressDeny=any
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
InaccessiblePaths=/var/lib/second-order /var/backups -/opt/second-order/.env
MemoryMax=700M
TasksMax=64
CPUQuota=150%

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable second-order-sim second-order

cat > /etc/caddy/Caddyfile <<CADDY
${DOMAIN}, run.${DOMAIN} {
	encode gzip
	header Strict-Transport-Security "max-age=31536000"
	reverse_proxy 127.0.0.1:3000
}
CADDY
systemctl reload caddy || systemctl restart caddy

# SSH: keys only. 00- sorts first, and sshd uses the first value it reads.
# Make sure your key is in /root/.ssh/authorized_keys before running this script.
cat > /etc/ssh/sshd_config.d/00-hardening.conf <<'SSHD'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
SSHD
sshd -t && systemctl reload ssh

ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# Daily database backup, keep 14 days (local only; copy off-server later)
cat > /etc/cron.daily/second-order-backup <<'CRON'
#!/bin/sh
mkdir -p /var/backups/second-order
sqlite_db=/var/lib/second-order/second-order.db
[ -f "$sqlite_db" ] && /usr/bin/node -e "
  const { DatabaseSync } = require('node:sqlite');
  new DatabaseSync('$sqlite_db').exec(\"VACUUM INTO '/var/backups/second-order/'||strftime('%Y-%m-%d','now')||'.db'\");
" 2>/dev/null
find /var/backups/second-order -name '*.db' -mtime +14 -delete
CRON
chmod 755 /etc/cron.daily/second-order-backup

echo "Server ready. Now run scripts/deploy.sh from your Mac."
