import type { LineOut } from '../api/client';

export const OFFSET_STEP_MS = 100;

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

/** Debounce helper for persisting offset changes (one PATCH after a burst of key presses). */
export function createDebouncer(delayMs: number): (fn: () => void) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (fn) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, delayMs);
  };
}
