#!/usr/bin/env bash
# Pull the latest master, install deps, rebuild the web app + extension zip, restart the service.
# Run:  bash deploy/update.sh
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
git pull --ff-only
(cd server && uv sync --frozen)
(cd web && pnpm install --frozen-lockfile && pnpm build)
# Extension zips for the laptop (Edge/Chrome + Firefox); a failure here never blocks the deploy.
(cd extension && pnpm install --frozen-lockfile && pnpm zip && pnpm zip:firefox) \
  && ls -1 "$REPO"/extension/.output/*.zip || echo "warning: extension build failed" >&2
systemctl --user restart sensei  # migrates the DB on start (backs it up first)
sleep 2
curl -fsS "http://localhost:${SENSEI_PORT:-8000}/health" && echo
