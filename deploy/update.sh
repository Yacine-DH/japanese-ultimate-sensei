#!/usr/bin/env bash
# Pull the latest master, install deps, rebuild the web app, restart the service.
# Run:  bash deploy/update.sh
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
git pull --ff-only
(cd server && uv sync --frozen)
(cd web && pnpm install --frozen-lockfile && pnpm build)
systemctl --user restart sensei  # migrates the DB on start (backs it up first)
sleep 2
curl -fsS "http://localhost:${SENSEI_PORT:-8000}/health" && echo
