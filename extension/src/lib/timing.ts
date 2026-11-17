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

export function findActiveLine(
  lines: readonly LineOut[],
  videoMs: number,
  subOffsetMs: number,
): LineOut | null {
  for (const line of lines) {
    if (isLineActive(line, videoMs, subOffsetMs)) {
      return line;
    }
  }
  return null;
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

export type HotkeyAction =
  | { type: 'step'; deltaMs: number }
  | { type: 'sync_now' };

export function resolveHotkeyAction(key: string): HotkeyAction | null {
  if (key === '[') {
    return { type: 'step', deltaMs: -OFFSET_STEP_MS };
  }
  if (key === ']') {
    return { type: 'step', deltaMs: OFFSET_STEP_MS };
  }
  if (key === '\\') {
    return { type: 'sync_now' };
  }
  return null;
}
