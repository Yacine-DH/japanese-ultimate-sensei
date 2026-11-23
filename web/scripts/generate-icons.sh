#!/usr/bin/env bash
# Generate the Sensei (先生) web favicons and PWA icons into web/public/.
# Uses the same deep-red (#c0392b) hanko seal design as extension/public/icon/.
# Requires ImageMagick (`magick`) and a Japanese font (default: Droid Sans Fallback).
# Run from repo root or anywhere: bash web/scripts/generate-icons.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${1:-$SCRIPT_DIR/../public}"
FONT="${SENSEI_ICON_FONT:-/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf}"
BG_COLOR="#c0392b"

if ! command -v magick >/dev/null 2>&1; then
  echo "error: ImageMagick 'magick' is required to regenerate icons." >&2
  exit 1
fi

if [[ ! -f "$FONT" ]]; then
  FONT="$(fc-match -f '%{file}' ':lang=ja' 2>/dev/null || true)"
  if [[ -z "$FONT" || ! -f "$FONT" ]]; then
    echo "error: no Japanese font found; set SENSEI_ICON_FONT=/path/to/font.ttf" >&2
    exit 1
  fi
fi

mkdir -p "$OUT_DIR"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# 512x512 rounded-square hanko stamp (stacked vertical 先生)
magick -size 512x512 xc:none \
  -fill "$BG_COLOR" -draw "roundrectangle 8,8 503,503 100,100" \
  -font "$FONT" -fill white -stroke white -strokewidth 5 \
  -pointsize 202 -gravity center -annotate +0-104 "先" \
  -pointsize 202 -gravity center -annotate +0+110 "生" \
  -depth 8 -strip "$OUT_DIR/icon-512.png"

# 192x192 rounded-square hanko stamp (downsampled from 512x512 for crisp AA)
magick "$OUT_DIR/icon-512.png" -resize 192x192 -depth 8 -strip "$OUT_DIR/icon-192.png"

# 512x512 maskable icon (opaque full-bleed #c0392b; 先生 inside inner 80% safe zone)
magick -size 512x512 "xc:$BG_COLOR" \
  -font "$FONT" -fill white -stroke white -strokewidth 4 \
  -pointsize 168 -gravity center -annotate +0-86 "先" \
  -pointsize 168 -gravity center -annotate +0+90 "生" \
  -depth 8 -strip "$OUT_DIR/icon-512-maskable.png"

# 180x180 apple-touch-icon (opaque #c0392b so iOS applies its native squircle mask cleanly)
magick -size 512x512 "xc:$BG_COLOR" \
  -font "$FONT" -fill white -stroke white -strokewidth 5 \
  -pointsize 196 -gravity center -annotate +0-100 "先" \
  -pointsize 196 -gravity center -annotate +0+106 "生" \
  -resize 180x180 -depth 8 -strip "$OUT_DIR/apple-touch-icon.png"

# 48x48 stacked vertical 先生 (used inside multi-res favicon.ico)
magick -size 384x384 xc:none \
  -fill "$BG_COLOR" -draw "roundrectangle 6,6 377,377 76,76" \
  -font "$FONT" -fill white -stroke white -strokewidth 5 \
  -pointsize 152 -gravity center -annotate +0-78 "先" \
  -pointsize 152 -gravity center -annotate +0+82 "生" \
  -resize 48x48 -depth 8 -strip "$TMP_DIR/48.png"

# 32x32 single kanji 先
magick -size 256x256 xc:none \
  -fill "$BG_COLOR" -draw "roundrectangle 4,4 251,251 50,50" \
  -font "$FONT" -fill white -stroke white -strokewidth 6 \
  -pointsize 196 -gravity center -annotate +0+4 "先" \
  -resize 32x32 -depth 8 -strip "$OUT_DIR/favicon-32x32.png"

# 16x16 single kanji 先
magick -size 256x256 xc:none \
  -fill "$BG_COLOR" -draw "roundrectangle 0,0 255,255 48,48" \
  -font "$FONT" -fill white -stroke white -strokewidth 5 \
  -pointsize 200 -gravity center -annotate +0+4 "先" \
  -resize 16x16 -unsharp 0x0.5+0.6+0 -depth 8 -strip "$OUT_DIR/favicon-16x16.png"

# Multi-resolution favicon.ico (16, 32, 48)
magick "$OUT_DIR/favicon-16x16.png" "$OUT_DIR/favicon-32x32.png" "$TMP_DIR/48.png" \
  "$OUT_DIR/favicon.ico"

echo "Generated Sensei web & PWA icons in $OUT_DIR:"
ls -lh "$OUT_DIR"/favicon.ico "$OUT_DIR"/favicon-*.png "$OUT_DIR"/apple-touch-icon.png "$OUT_DIR"/icon-*.png
