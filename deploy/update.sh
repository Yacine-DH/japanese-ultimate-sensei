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
# Serve the newest zips from the web app (http://<server>:8000/downloads/…) for
# scripts/update-extension.ps1 on the laptop; version.json lets the extension spot updates.
DL="$REPO/web/dist/downloads"
mkdir -p "$DL"
for z in "$REPO"/extension/.output/*-chrome.zip "$REPO"/extension/.output/*-firefox.zip; do
  [ -f "$z" ] && cp "$z" "$DL/sensei-extension-${z##*-}"
done
cp "$REPO/scripts/update-extension.ps1" "$DL/"
# extension_commit = last commit that changed extension/, so server-only deploys don't make the
# popup announce an update (the extension stamps itself the same way at build time).
printf '{"commit":"%s","extension_commit":"%s","built_at":"%s"}\n' "$(git rev-parse --short=7 HEAD)" \
  "$(git log -1 --format=%h --abbrev=7 -- extension)" "$(date -u +%FT%TZ)" > "$DL/version.json"
systemctl --user restart sensei  # migrates the DB on start (backs it up first)
sleep 2
curl -fsS "http://localhost:${SENSEI_PORT:-8000}/health" && echo
