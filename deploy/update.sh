#!/usr/bin/env bash
# Pull the latest master, install deps, rebuild the web app + extension zip, restart the service.
# Run:  bash deploy/update.sh
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
git pull --ff-only
(cd server && uv sync --frozen)
(cd web && pnpm install --frozen-lockfile && pnpm build)
# Extension version 0.1.N, N = commits that touched extension/: it only changes when the
# extension does (wxt.config.ts reads SENSEI_EXT_VERSION), and names the GitHub release.
export SENSEI_EXT_VERSION="0.1.$(git rev-list --count HEAD -- extension)"
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
cp "$REPO/scripts/update-extension.ps1" "$REPO/scripts/install-updater.ps1" "$DL/"
# The laptop-side updater (native messaging host) that install-updater.ps1 downloads.
mkdir -p "$DL/updater"
cp "$REPO"/scripts/sensei-updater/sensei-updater.{ps1,cmd} "$DL/updater/"
sha() { [ -f "$1" ] && sha256sum "$1" | cut -d' ' -f1 || true; }
# extension_commit = last commit that changed extension/, so server-only deploys don't make the
# popup announce an update (the extension stamps itself the same way at build time).
# sha256_* lets the updater verify the zip it downloaded.
printf '{"version":"%s","commit":"%s","extension_commit":"%s","built_at":"%s","sha256_chrome":"%s","sha256_firefox":"%s"}\n' \
  "$SENSEI_EXT_VERSION" "$(git rev-parse --short=7 HEAD)" "$(git log -1 --format=%h --abbrev=7 -- extension)" \
  "$(date -u +%FT%TZ)" "$(sha "$DL/sensei-extension-chrome.zip")" "$(sha "$DL/sensei-extension-firefox.zip")" \
  > "$DL/version.json"
# GitHub release for a new extension version (zips + notes); never blocks the deploy.
bash "$REPO/scripts/release.sh" "$SENSEI_EXT_VERSION" "$DL" || echo "warning: GitHub release failed" >&2
systemctl --user restart sensei  # migrates the DB on start (backs it up first)
# A migration backs the DB up first, so startup can take a while: wait up to 60 s.
for _ in $(seq 30); do
  curl -fsS "http://localhost:${SENSEI_PORT:-8000}/health" 2>/dev/null && echo && exit 0
  sleep 2
done
echo "server did not answer /health within 60 s: journalctl --user -u sensei -n 50" >&2
exit 1
