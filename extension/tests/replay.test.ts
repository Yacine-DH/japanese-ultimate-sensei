import { describe, expect, it } from 'vitest';
import type { LineOut } from '../src/api/client';
import {
  computeReplaySeekSeconds,
  createSlowReplayState,
  findLineToReplay,
  shouldAutoPauseAfterLine,
  shouldRestorePlaybackRate,
  SLOW_REPLAY_RATE,
} from '../src/lib/replay';

function makeLine(id: number, startMs: number, endMs: number, text = '台詞'): LineOut {
  return {
    id,
    idx: id,
    start_ms: startMs,
    end_ms: endMs,
    text,
    tokens: [],
    translation_en: null,
    translation_de: null,
  };
}

describe('listening-practice replay & slow-replay (#33)', () => {
  const lines = [
    makeLine(1, 1000, 3000, 'おはよう'),
    makeLine(2, 5000, 7500, '今日もいい天気ですね'),
  ];

  it('replays the currently active line, or falls back to the most recently finished line in a gap', () => {
    // Inside line 1
    expect(findLineToReplay(lines, 1800, 0)?.id).toBe(1);
    // In the gap after line 1 (4000ms) -> replays line 1
    expect(findLineToReplay(lines, 4000, 0)?.id).toBe(1);
    // Before first line -> null
    expect(findLineToReplay(lines, 500, 0)).toBeNull();
    // With +500ms offset, line 2 starts at 5500ms
    expect(computeReplaySeekSeconds(lines[1]!, 500)).toBe(5.5);
  });

  it('tracks 0.75x slow replay and restores original playbackRate at line end', () => {
    expect(SLOW_REPLAY_RATE).toBe(0.75);
    const state = createSlowReplayState(lines[1]!, 200, 1.0);
    expect(state).toEqual({ startMs: 5200, endMs: 7700, originalRate: 1.0 });

    expect(shouldRestorePlaybackRate(state, 5500)).toBe(false);
    expect(shouldRestorePlaybackRate(state, 7699)).toBe(false);
    expect(shouldRestorePlaybackRate(state, 7700)).toBe(true);
    // Seeking backwards well before the line also cancels slow replay
    expect(shouldRestorePlaybackRate(state, 4000)).toBe(true);
  });

  it('triggers auto-pause only when enabled and crossing out of an active line', () => {
    expect(shouldAutoPauseAfterLine([1], [], true)).toBe(true);
    expect(shouldAutoPauseAfterLine([1], [2], true)).toBe(true);
    expect(shouldAutoPauseAfterLine([1], [1], true)).toBe(false);
    expect(shouldAutoPauseAfterLine([], [1], true)).toBe(false);
    expect(shouldAutoPauseAfterLine([1], [], false)).toBe(false);
  });
});
