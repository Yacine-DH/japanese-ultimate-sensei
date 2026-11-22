/**
 * Pure position math for the draggable subtitle overlay (E-13, #111).
 *
 * Positions are stored per site (`host`) as fractions of the video container box so
 * window resizes and fullscreen transitions preserve the relative placement:
 * - `x`: horizontal center of the subtitle box / container width (`0..1`, default `0.5`)
 * - `y`: bottom edge of the subtitle box / container height (`0..1`)
 */

export interface OverlayPosition {
  /** Horizontal center as fraction of video width (0..1). */
  x: number;
  /** Bottom edge as fraction of video height (0..1). */
  y: number;
}

export interface Size2D {
  width: number;
  height: number;
}

export interface PixelPoint {
  left: number;
  top: number;
}

export const OVERLAY_EDGE_MARGIN_PX = 8;
export const OVERLAY_DEFAULT_BOTTOM_PX = 44;
export const HOVER_POPUP_FLIP_THRESHOLD_PX = 210;

export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (min > max) return min;
  return Math.min(max, Math.max(min, value));
}

export function extractOverlayHostKey(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    const host = parsed.host.trim().toLowerCase();
    return host || null;
  } catch {
    return null;
  }
}

export function sanitizeOverlayPosition(raw: unknown): OverlayPosition | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const x = Number(obj.x);
  const y = Number(obj.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  return {
    x: clampNumber(x, 0, 1),
    y: clampNumber(y, 0, 1),
  };
}

export function sanitizeOverlayPositions(raw: unknown): Record<string, OverlayPosition> {
  if (typeof raw !== 'object' || raw === null) {
    return {};
  }
  const clean: Record<string, OverlayPosition> = {};
  for (const [host, pos] of Object.entries(raw as Record<string, unknown>)) {
    const key = host.trim().toLowerCase();
    if (!key) continue;
    const valid = sanitizeOverlayPosition(pos);
    if (valid) {
      clean[key] = valid;
    }
  }
  return clean;
}

/**
 * Clamps a subtitle box's top-left pixel coordinates so the entire box stays within
 * the video container bounds (with an optional inner margin).
 */
export function clampBoxPixels(
  left: number,
  top: number,
  container: Size2D,
  box: Size2D,
  margin = OVERLAY_EDGE_MARGIN_PX,
): PixelPoint {
  const cw = Math.max(0, container.width);
  const ch = Math.max(0, container.height);
  const bw = Math.max(0, box.width);
  const bh = Math.max(0, box.height);
  const safeMarginX = bw + margin * 2 <= cw ? margin : 0;
  const safeMarginY = bh + margin * 2 <= ch ? margin : 0;

  const maxLeft = Math.max(safeMarginX, cw - bw - safeMarginX);
  const maxTop = Math.max(safeMarginY, ch - bh - safeMarginY);

  return {
    left: Math.round(clampNumber(left, safeMarginX, maxLeft)),
    top: Math.round(clampNumber(top, safeMarginY, maxTop)),
  };
}

/**
 * Converts a stored fractional overlay position to clamped top-left pixel coordinates
 * inside the video container.
 */
export function fractionToBoxPixels(
  pos: OverlayPosition,
  container: Size2D,
  box: Size2D,
  margin = OVERLAY_EDGE_MARGIN_PX,
): PixelPoint {
  const desiredLeft = pos.x * container.width - box.width / 2;
  const desiredTop = pos.y * container.height - box.height;
  return clampBoxPixels(desiredLeft, desiredTop, container, box, margin);
}

/**
 * Converts a subtitle box's top-left pixel coordinates inside the video container
 * into a clamped fractional `OverlayPosition` suitable for storage.
 */
export function boxPixelsToFraction(
  left: number,
  top: number,
  container: Size2D,
  box: Size2D,
  margin = OVERLAY_EDGE_MARGIN_PX,
): OverlayPosition {
  if (container.width <= 0 || container.height <= 0) {
    return { x: 0.5, y: 0.9 };
  }
  const clamped = clampBoxPixels(left, top, container, box, margin);
  const centerX = clamped.left + box.width / 2;
  const bottomY = clamped.top + box.height;
  return {
    x: Number(clampNumber(centerX / container.width, 0, 1).toFixed(4)),
    y: Number(clampNumber(bottomY / container.height, 0, 1).toFixed(4)),
  };
}

/**
 * Computes the next clamped pixel position + fractional coordinates during a pointer drag.
 */
export function computeDraggedOverlayPlacement(params: {
  startBox: PixelPoint;
  deltaX: number;
  deltaY: number;
  container: Size2D;
  box: Size2D;
  margin?: number;
}): { pixels: PixelPoint; fraction: OverlayPosition } {
  const margin = params.margin ?? OVERLAY_EDGE_MARGIN_PX;
  const pixels = clampBoxPixels(
    params.startBox.left + params.deltaX,
    params.startBox.top + params.deltaY,
    params.container,
    params.box,
    margin,
  );
  const fraction = boxPixelsToFraction(
    pixels.left,
    pixels.top,
    params.container,
    params.box,
    margin,
  );
  return { pixels, fraction };
}

/**
 * Returns true when the subtitle box is close enough to the top of the video that the
 * dictionary hover popup should render below the subtitle box instead of above it.
 */
export function shouldPlacePopupBelow(
  boxTopPx: number,
  containerHeightPx: number,
  thresholdPx = HOVER_POPUP_FLIP_THRESHOLD_PX,
): boolean {
  if (containerHeightPx <= 0) return false;
  return boxTopPx < Math.min(thresholdPx, containerHeightPx * 0.42);
}

export function getOverlayPositionForHost(
  positions: Readonly<Record<string, OverlayPosition>>,
  host: string | null,
): OverlayPosition | null {
  if (!host) return null;
  const key = host.trim().toLowerCase();
  return positions[key] ?? null;
}

export function withOverlayPositionForHost(
  positions: Readonly<Record<string, OverlayPosition>>,
  host: string,
  pos: OverlayPosition | null,
): Record<string, OverlayPosition> {
  const key = host.trim().toLowerCase();
  const next: Record<string, OverlayPosition> = { ...positions };
  if (!key) return next;
  if (pos === null) {
    delete next[key];
  } else {
    next[key] = pos;
  }
  return next;
}
