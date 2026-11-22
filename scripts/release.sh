#!/usr/bin/env bash
# Publish a GitHub release for the current extension build. Called by deploy/update.sh after the
# zips are built; also fine to run by hand. Never fails the deploy (exits 0 on any skip).
#   bash scripts/release.sh <version> <downloads-dir>      DRY_RUN=1 prints instead of publishing
# One release per extension version (v0.1.N, N = commits that touched extension/), so server-only
# deploys don't create releases; their changes show up in the next release's notes.
set -euo pipefail
VERSION="$1"
DL="$2"
TAG="v$VERSION"
cd "$(dirname "${BASH_SOURCE[0]}")/.."
command -v gh >/dev/null || { echo "release: gh not installed, skipped"; exit 0; }
if gh release view "$TAG" >/dev/null 2>&1; then echo "release: $TAG already published"; exit 0; fi
git fetch -q --tags origin master
SHA="$(git rev-parse HEAD)"
git merge-base --is-ancestor "$SHA" origin/master || { echo "release: HEAD isn't on origin/master, skipped"; exit 0; }
PREV="$(gh release list --limit 1 --exclude-drafts --json tagName --jq '.[0].tagName // ""')"
[ -n "$PREV" ] && ! git rev-parse -q --verify "refs/tags/$PREV" >/dev/null && PREV=""
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
python3 scripts/release_notes.py "$VERSION" "$PREV" > "$WORK/notes.md"
ASSETS=()
for b in chrome firefox; do
  if [ -f "$DL/sensei-extension-$b.zip" ]; then
    cp "$DL/sensei-extension-$b.zip" "$WORK/sensei-extension-$VERSION-$b.zip"
    ASSETS+=("$WORK/sensei-extension-$VERSION-$b.zip")
  fi
done
if [ "${DRY_RUN:-}" = 1 ]; then
  echo "release (dry run): $TAG at ${SHA:0:7}, previous: ${PREV:-none}, assets: ${ASSETS[*]##*/}"
  cat "$WORK/notes.md"
  exit 0
fi
gh release create "$TAG" --target "$SHA" --title "Sensei $VERSION" --notes-file "$WORK/notes.md" "${ASSETS[@]}"
