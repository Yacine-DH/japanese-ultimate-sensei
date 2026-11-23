import type { EpisodePatch, LineOut, SyncPoint } from '../api/client';

export const OFFSET_STEP_MS = 100;

/**
 * Normalize piecewise sync points to match the server contract (#137):
 * integer ms, `at_ms > 0`, deduplicated by `at_ms` (last wins), sorted ascending.
 */
export function normalizeSyncPoints(
  points: readonly SyncPoint[] | null | undefined,
): SyncPoint[] {
  if (!points || points.length === 0) {
    return [];
  }
  const byAt = new Map<number, number>();
  for (const pt of points) {
    if (!pt || !Number.isFinite(pt.at_ms) || !Number.isFinite(pt.offset_ms)) {
      continue;
    }
    const atMs = Math.round(pt.at_ms);
    if (atMs <= 0) {
      continue;
    }
    byAt.set(atMs, Math.round(pt.offset_ms));
  }
  return Array.from(byAt.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([at_ms, offset_ms]) => ({ at_ms, offset_ms }));
}

/**
 * Resolve the subtitle offset in effect at `videoMs` (#137, #138):
 * `offset_ms` of the last sync point with `at_ms <= videoMs`, else `baseOffsetMs`.
 */
export function resolveOffsetAt(
  videoMs: number,
  baseOffsetMs: number,
  syncPoints: readonly SyncPoint[] = [],
): number {
  let offset = baseOffsetMs;
  let bestAtMs = -1;
  for (const pt of syncPoints) {
    if (pt.at_ms > 0 && pt.at_ms <= videoMs && pt.at_ms >= bestAtMs) {
      bestAtMs = pt.at_ms;
      offset = pt.offset_ms;
    }
  }
  return offset;
}

export interface StretchOffsetUpdate {
  subOffsetMs: number;
  syncPoints: SyncPoint[];
  target: 'base' | 'point';
  pointAtMs: number | null;
  offsetMs: number;
  patch: Pick<EpisodePatch, 'sub_offset_ms' | 'sync_points'>;
}

/**
 * Apply a manual offset change to the stretch currently in effect at `videoMs` (#138):
 * before the first sync point (or with no points) updates `sub_offset_ms`;
 * otherwise updates only the active sync point without changing earlier/later stretches.
 */
export function applyOffsetToActiveStretch(
  videoMs: number,
  baseOffsetMs: number,
  syncPoints: readonly SyncPoint[],
  nextOffsetMs: number,
): StretchOffsetUpdate {
  const normalized = normalizeSyncPoints(syncPoints);
  const roundedOffset = Math.round(nextOffsetMs);

  let ownerIdx = -1;
  for (let i = 0; i < normalized.length; i++) {
    if (normalized[i]!.at_ms <= videoMs) {
      ownerIdx = i;
    } else {
      break;
    }
  }

  if (ownerIdx < 0) {
    return {
      subOffsetMs: roundedOffset,
      syncPoints: normalized,
      target: 'base',
      pointAtMs: null,
      offsetMs: roundedOffset,
      patch: { sub_offset_ms: roundedOffset },
    };
  }

  const owner = normalized[ownerIdx]!;
  const updatedPoints = normalized.map((pt, idx) =>
    idx === ownerIdx ? { at_ms: pt.at_ms, offset_ms: roundedOffset } : pt,
  );
  return {
    subOffsetMs: Math.round(baseOffsetMs),
    syncPoints: updatedPoints,
    target: 'point',
    pointAtMs: owner.at_ms,
    offsetMs: roundedOffset,
    patch: { sync_points: updatedPoints },
  };
}

export function isLineActive(
  line: Pick<LineOut, 'start_ms' | 'end_ms'>,
  videoMs: number,
  subOffsetMs: number,
): boolean {
  const start = line.start_ms + subOffsetMs;
  const end = line.end_ms + subOffsetMs;
  return videoMs >= start && videoMs < end;
}

export function findActiveLines(
  lines: readonly LineOut[],
  videoMs: number,
  subOffsetMs: number,
): LineOut[] {
  if (lines.length === 0) {
    return [];
  }

  // Binary search for the last line with start_ms + subOffsetMs <= videoMs
  let lo = 0;
  let hi = lines.length - 1;
  let upperIdx = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const line = lines[mid]!;
    if (line.start_ms + subOffsetMs <= videoMs) {
      upperIdx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (upperIdx < 0) {
    return [];
  }

  const active: LineOut[] = [];
  for (let i = 0; i <= upperIdx; i++) {
    const line = lines[i]!;
    if (isLineActive(line, videoMs, subOffsetMs)) {
      active.push(line);
    }
  }
  return active;
}

export function findActiveLine(
  lines: readonly LineOut[],
  videoMs: number,
  subOffsetMs: number,
): LineOut | null {
  return findActiveLines(lines, videoMs, subOffsetMs)[0] ?? null;
}

export function formatActiveLinesKey(lines: readonly Pick<LineOut, 'id'>[]): string {
  return lines.map((l) => l.id).join(',');
}

export function findReferenceLineForSync(
  lines: readonly LineOut[],
  videoMs: number,
  subOffsetMs: number,
): LineOut | null {
  if (lines.length === 0) {
    return null;
  }
  const active = findActiveLine(lines, videoMs, subOffsetMs);
  if (active) {
    return active;
  }

  let best: LineOut = lines[0]!;
  let bestDist = Math.abs(best.start_ms + subOffsetMs - videoMs);

  for (let i = 1; i < lines.length; i++) {
    const candidate = lines[i]!;
    const dist = Math.abs(candidate.start_ms + subOffsetMs - videoMs);
    if (dist < bestDist) {
      best = candidate;
      bestDist = dist;
    }
  }
  return best;
}

export function adjustOffsetMs(currentOffsetMs: number, deltaMs: number): number {
  return Math.round(currentOffsetMs + deltaMs);
}

export function computeSyncOffsetMs(
  videoMs: number,
  line: Pick<LineOut, 'start_ms'>,
): number {
  return Math.round(videoMs) - line.start_ms;
}

export interface Debouncer {
  (fn: () => void): void;
  cancel(): void;
}

/** Debounce helper for persisting offset changes (one PATCH after a burst of key presses). */
export function createDebouncer(delayMs: number): Debouncer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = ((fn: () => void) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, delayMs);
  }) as Debouncer;
  schedule.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return schedule;
}
