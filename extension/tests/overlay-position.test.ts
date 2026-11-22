import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  boxPixelsToFraction,
  clampBoxPixels,
  computeDraggedOverlayPlacement,
  extractOverlayHostKey,
  fractionToBoxPixels,
  getOverlayPositionForHost,
  sanitizeOverlayPosition,
  sanitizeOverlayPositions,
  shouldPlacePopupBelow,
  withOverlayPositionForHost,
} from '../src/lib/overlay-position';

describe('overlay-position pure math (#111)', () => {
  it('extracts lowercase host keys from http/https URLs and ignores non-web URLs', () => {
    expect(extractOverlayHostKey('https://HiAnime.to/watch/frieren?ep=123')).toBe('hianime.to');
    expect(extractOverlayHostKey('http://localhost:8000/player')).toBe('localhost:8000');
    expect(extractOverlayHostKey('chrome://extensions')).toBeNull();
    expect(extractOverlayHostKey('not a url')).toBeNull();
    expect(extractOverlayHostKey('')).toBeNull();
  });

  it('sanitizes stored overlay positions and clamps out-of-range fractions', () => {
    expect(sanitizeOverlayPosition({ x: 0.5, y: 0.8 })).toEqual({ x: 0.5, y: 0.8 });
    expect(sanitizeOverlayPosition({ x: -0.5, y: 1.8 })).toEqual({ x: 0, y: 1 });
    expect(sanitizeOverlayPosition({ x: Number.NaN, y: 0.5 })).toBeNull();
    expect(sanitizeOverlayPosition('bad')).toBeNull();

    expect(
      sanitizeOverlayPositions({
        'HiAnime.to': { x: 0.5, y: 0.72 },
        '': { x: 0.5, y: 0.5 },
        'broken.site': { x: 'nope', y: 0.5 },
      }),
    ).toEqual({
      'hianime.to': { x: 0.5, y: 0.72 },
    });
  });

  it('clamps subtitle box pixels strictly inside the video container bounds', () => {
    const container = { width: 1280, height: 720 };
    const box = { width: 400, height: 80 };

    expect(clampBoxPixels(-50, -20, container, box, 8)).toEqual({ left: 8, top: 8 });
    expect(clampBoxPixels(1100, 700, container, box, 8)).toEqual({ left: 872, top: 632 });
    expect(clampBoxPixels(440, 500, container, box, 8)).toEqual({ left: 440, top: 500 });

    // When box is wider/taller than container, falls back to 0 without NaN
    expect(clampBoxPixels(50, 50, { width: 300, height: 60 }, box, 8)).toEqual({
      left: 0,
      top: 0,
    });
  });

  it('round-trips fraction <-> pixel placement and preserves relative position on resize/fullscreen', () => {
    const small = { width: 800, height: 450 };
    const fullscreen = { width: 1920, height: 1080 };
    const box = { width: 320, height: 64 };

    // Dragged above site subtitles: centered horizontally, bottom at 75% of video height
    const frac = boxPixelsToFraction(240, 273.5, small, box, 8);
    expect(frac.x).toBeCloseTo(0.5, 3);
    expect(frac.y).toBeCloseTo(0.75, 2);

    // Re-projected onto 1080p fullscreen
    const fsPixels = fractionToBoxPixels(frac, fullscreen, box, 8);
    expect(fsPixels.left).toBe(Math.round(1920 * frac.x - box.width / 2));
    expect(fsPixels.top).toBe(Math.round(1080 * frac.y - box.height));
  });

  it('computes dragged placement with clamping at container edges', () => {
    const result = computeDraggedOverlayPlacement({
      startBox: { left: 300, top: 500 },
      deltaX: 120,
      deltaY: -200,
      container: { width: 1000, height: 600 },
      box: { width: 300, height: 70 },
    });
    expect(result.pixels).toEqual({ left: 420, top: 300 });
    expect(result.fraction).toEqual({ x: 0.57, y: 0.6167 });

    // Dragging past top-left clamps to margin (8, 8)
    const clamped = computeDraggedOverlayPlacement({
      startBox: { left: 50, top: 50 },
      deltaX: -400,
      deltaY: -400,
      container: { width: 1000, height: 600 },
      box: { width: 300, height: 70 },
    });
    expect(clamped.pixels).toEqual({ left: 8, top: 8 });
  });

  it('flips hover dictionary popup below when subtitle box is near the top of the video', () => {
    expect(shouldPlacePopupBelow(20, 720)).toBe(true);
    expect(shouldPlacePopupBelow(180, 720)).toBe(true);
    expect(shouldPlacePopupBelow(500, 720)).toBe(false);
    expect(shouldPlacePopupBelow(50, 0)).toBe(false);
  });

  it('reads, updates, and resets per-host positions immutably', () => {
    const initial = { 'site-a.to': { x: 0.5, y: 0.7 } };
    expect(getOverlayPositionForHost(initial, 'Site-A.to')).toEqual({ x: 0.5, y: 0.7 });
    expect(getOverlayPositionForHost(initial, 'site-b.to')).toBeNull();

    const updated = withOverlayPositionForHost(initial, 'site-b.to', { x: 0.4, y: 0.6 });
    expect(updated).toEqual({
      'site-a.to': { x: 0.5, y: 0.7 },
      'site-b.to': { x: 0.4, y: 0.6 },
    });
    expect(initial).toEqual({ 'site-a.to': { x: 0.5, y: 0.7 } });

    const reset = withOverlayPositionForHost(updated, 'SITE-A.TO', null);
    expect(reset).toEqual({ 'site-b.to': { x: 0.4, y: 0.6 } });
  });

  it('wires popup romaji toggle and reset overlay position button in popup/index.html', () => {
    const html = readFileSync(resolve(__dirname, '../entrypoints/popup/index.html'), 'utf8');
    expect(html).toContain('id="romaji-toggle"');
    expect(html).toContain('id="reset-position-btn"');
    expect(html).toContain('Reset overlay position');
  });
});
