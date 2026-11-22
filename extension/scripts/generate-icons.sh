#!/usr/bin/env bash
# Generate the Sensei (先生) extension icons (16, 32, 48, 128 px) into public/icon/.
# Requires ImageMagick (`magick`) and a Japanese font (default: Droid Sans Fallback).
# Run from extension/ or anywhere: bash extension/scripts/generate-icons.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${1:-$SCRIPT_DIR/../public/icon}"
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

# 128x128: stacked vertical 先生 (hanko stamp style), rendered at 4x (512px) for crisp AA
magick -size 512x512 xc:none \
  -fill "$BG_COLOR" -draw "roundrectangle 8,8 503,503 100,100" \
  -font "$FONT" -fill white -stroke white -strokewidth 5 \
  -pointsize 202 -gravity center -annotate +0-104 "先" \
  -pointsize 202 -gravity center -annotate +0+110 "生" \
  -resize 128x128 -depth 8 -strip "$OUT_DIR/128.png"

# 48x48: stacked vertical 先生, rendered at 8x (384px)
magick -size 384x384 xc:none \
  -fill "$BG_COLOR" -draw "roundrectangle 6,6 377,377 76,76" \
  -font "$FONT" -fill white -stroke white -strokewidth 5 \
  -pointsize 152 -gravity center -annotate +0-78 "先" \
  -pointsize 152 -gravity center -annotate +0+82 "生" \
  -resize 48x48 -depth 8 -strip "$OUT_DIR/48.png"

# 32x32: single kanji 先 (two kanji become unreadable below 48px), rendered at 8x (256px)
magick -size 256x256 xc:none \
  -fill "$BG_COLOR" -draw "roundrectangle 4,4 251,251 50,50" \
  -font "$FONT" -fill white -stroke white -strokewidth 6 \
  -pointsize 196 -gravity center -annotate +0+4 "先" \
  -resize 32x32 -depth 8 -strip "$OUT_DIR/32.png"

# 16x16: single kanji 先, rendered at 16x (256px) and lightly sharpened for toolbar clarity
magick -size 256x256 xc:none \
  -fill "$BG_COLOR" -draw "roundrectangle 0,0 255,255 48,48" \
  -font "$FONT" -fill white -stroke white -strokewidth 5 \
  -pointsize 200 -gravity center -annotate +0+4 "先" \
  -resize 16x16 -unsharp 0x0.5+0.6+0 -depth 8 -strip "$OUT_DIR/16.png"

echo "Generated Sensei icons in $OUT_DIR:"
ls -lh "$OUT_DIR"/{16,32,48,128}.png
