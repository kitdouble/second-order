#!/usr/bin/env bash
# Read feedback notes on the live server. Usage: npm run feedback:prod -- [--status all]
set -euo pipefail
HOST="${HOST:-2ndorder.live}"
ssh "root@${HOST}" "cd /opt/second-order && sudo -u secondorder node --disable-warning=ExperimentalWarning --env-file=.env scripts/feedback.js $(printf '%q ' "$@")"
