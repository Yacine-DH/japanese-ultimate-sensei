import type { LineOut } from '../api/client';
import { findActiveLines } from './timing';

export const SLOW_REPLAY_RATE = 0.75;

export interface SlowReplayState {
  startMs: number;
  endMs: number;
  originalRate: number;
}

/**
 * Finds the line to replay: the currently active line if inside one, otherwise the most recently
 * finished line so hitting Replay right after hearing a sentence jumps back to it.
 */
export function findLineToReplay(
  lines: readonly LineOut[],
  videoMs: number,
  subOffsetMs: number,
): LineOut | null {
  if (lines.length === 0) {
    return null;
  }
  const active = findActiveLines(lines, videoMs, subOffsetMs);
  if (active.length > 0) {
    return active[0]!;
  }

  let recent: LineOut | null = null;
  for (const line of lines) {
    const shiftedStart = line.start_ms + subOffsetMs;
    if (shiftedStart <= videoMs) {
      recent = line;
    } else {
      break;
    }
  }
  return recent;
}

export function computeReplaySeekSeconds(
  line: Pick<LineOut, 'start_ms'>,
  subOffsetMs: number,
): number {
  return Math.max(0, (line.start_ms + subOffsetMs) / 1000);
}

export function createSlowReplayState(
  line: Pick<LineOut, 'start_ms' | 'end_ms'>,
  subOffsetMs: number,
  originalRate: number,
): SlowReplayState {
  return {
    startMs: Math.max(0, line.start_ms + subOffsetMs),
    endMs: Math.max(0, line.end_ms + subOffsetMs),
    originalRate: originalRate > 0 ? originalRate : 1,
  };
}

export function shouldRestorePlaybackRate(
  state: SlowReplayState | null,
  videoMs: number,
): boolean {
  if (!state) {
    return false;
  }
  return videoMs >= state.endMs || videoMs < state.startMs - 500;
}

export function shouldAutoPauseAfterLine(
  prevActiveIds: readonly number[],
  nextActiveIds: readonly number[],
  enabled: boolean,
): boolean {
  if (!enabled || prevActiveIds.length === 0) {
    return false;
  }
  const nextSet = new Set(nextActiveIds);
  return prevActiveIds.some((id) => !nextSet.has(id));
}
