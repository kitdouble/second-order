#!/usr/bin/env bash
# Create an invite on the live server. Usage: npm run invite:prod -- --name "Full Name" --email a@b.com [--admin]
set -euo pipefail
HOST="${HOST:-2ndorder.live}"
ssh "root@${HOST}" "cd /opt/second-order && sudo -u secondorder node --disable-warning=ExperimentalWarning --env-file=.env scripts/invite.js $(printf '%q ' "$@")"
