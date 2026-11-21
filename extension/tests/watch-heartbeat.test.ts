import { describe, expect, it } from 'vitest';
import {
  HEARTBEAT_FLUSH_MS,
  isCountablePlayback,
  MAX_HEARTBEAT_SECONDS,
  MAX_TICK_DELTA_MS,
  WatchHeartbeatAccumulator,
  type WatchPlaybackSnapshot,
} from '../src/lib/watch-heartbeat';

function playingSnapshot(overrides: Partial<WatchPlaybackSnapshot> = {}): WatchPlaybackSnapshot {
  return {
    episodeId: 42,
    overlayEnabled: true,
    isPlaying: true,
    isBuffering: false,
    isCapturing: false,
    tabVisible: true,
    isAudible: true,
    ...overrides,
  };
}

describe('isCountablePlayback', () => {
  it('requires attached episode, enabled overlay, playing, not buffering/capturing, and visible or audible', () => {
    expect(isCountablePlayback(playingSnapshot())).toBe(true);
    expect(isCountablePlayback(playingSnapshot({ episodeId: null }))).toBe(false);
    expect(isCountablePlayback(playingSnapshot({ overlayEnabled: false }))).toBe(false);
    expect(isCountablePlayback(playingSnapshot({ isPlaying: false }))).toBe(false);
    expect(isCountablePlayback(playingSnapshot({ isBuffering: true }))).toBe(false);
    expect(isCountablePlayback(playingSnapshot({ isCapturing: true }))).toBe(false);
    // Background tab still counts when audible, not when muted
    expect(isCountablePlayback(playingSnapshot({ tabVisible: false, isAudible: true }))).toBe(true);
    expect(isCountablePlayback(playingSnapshot({ tabVisible: false, isAudible: false }))).toBe(false);
    // Visible muted tab counts (user reading subtitles)
    expect(isCountablePlayback(playingSnapshot({ tabVisible: true, isAudible: false }))).toBe(true);
  });
});

describe('WatchHeartbeatAccumulator', () => {
  it('flushes every 30s and tracks a 10-minute session accurately with zero drift', () => {
    const acc = new WatchHeartbeatAccumulator(HEARTBEAT_FLUSH_MS);
    let now = 1_000_000;
    let totalSent = 0;

    expect(acc.update(playingSnapshot(), now)).toBeNull();

    // Tick every 5s for 10 minutes (120 ticks)
    for (let i = 0; i < 120; i++) {
      now += 5_000;
      const payload = acc.tick(now);
      if (payload) {
        expect(payload.episode_id).toBe(42);
        expect(payload.seconds).toBe(30);
        totalSent += payload.seconds;
      }
    }

    expect(totalSent).toBe(600);
    expect(acc.getAccumulatedMs()).toBe(0);
  });

  it('flushes immediately on pause and skips sub-second durations', () => {
    const acc = new WatchHeartbeatAccumulator();
    let now = 10_000;

    // 400ms play then pause -> skip 0s
    acc.update(playingSnapshot(), now);
    now += 400;
    expect(acc.update(playingSnapshot({ isPlaying: false }), now)).toBeNull();

    // Resume for 12.6s -> flush 13s? No, 12.6 + 0.4 = 13.0s -> 13s
    now += 5_000; // paused for 5s (not counted)
    acc.update(playingSnapshot(), now);
    now += 12_600;
    expect(acc.update(playingSnapshot({ isPlaying: false }), now)).toEqual({
      episode_id: 42,
      seconds: 13,
    });
  });

  it('does not count buffering or scene-capture intervals', () => {
    const acc = new WatchHeartbeatAccumulator();
    let now = 50_000;

    acc.update(playingSnapshot(), now);
    now += 15_000;
    // Enter buffering for 20s
    expect(acc.update(playingSnapshot({ isBuffering: true }), now)).toBeNull();
    now += 20_000;
    expect(acc.tick(now)).toBeNull();
    // Resume playing
    expect(acc.update(playingSnapshot({ isBuffering: false }), now)).toBeNull();
    now += 10_000;
    // Enter scene capture for 12s
    expect(acc.update(playingSnapshot({ isCapturing: true }), now)).toBeNull();
    now += 12_000;
    // Resume for 5s -> 15 + 10 + 5 = 30s -> flushes!
    expect(acc.update(playingSnapshot({ isCapturing: false }), now)).toBeNull();
    now += 5_000;
    expect(acc.tick(now)).toEqual({ episode_id: 42, seconds: 30 });
  });

  it('ignores seeking and playback-rate changes by measuring wall-clock playing time', () => {
    const acc = new WatchHeartbeatAccumulator();
    let now = 100_000;

    // Play 18s (regardless of whether the user sought or changed playbackRate to 0.75x / 1.5x)
    acc.update(playingSnapshot(), now);
    now += 18_000;
    const flushed = acc.flush(now, true);
    expect(flushed).toEqual({ episode_id: 42, seconds: 18 });
  });

  it('flushes previous episode and resets remainder on episode detach or switch', () => {
    const acc = new WatchHeartbeatAccumulator();
    let now = 200_000;

    acc.update(playingSnapshot({ episodeId: 7 }), now);
    now += 14_700;

    // Switch to episode 8 -> flushes episode 7 (14s) and discards 700ms remainder
    const payload = acc.update(playingSnapshot({ episodeId: 8 }), now);
    expect(payload).toEqual({ episode_id: 7, seconds: 14 });
    expect(acc.getAccumulatedMs()).toBe(0);

    // Watch episode 8 for 5s then detach overlay
    now += 5_000;
    const detachPayload = acc.update(playingSnapshot({ episodeId: 8, overlayEnabled: false }), now);
    expect(detachPayload).toEqual({ episode_id: 8, seconds: 5 });
    expect(acc.isCounting()).toBe(false);
  });

  it('caps single sleep-jump deltas and enforces 600s max per heartbeat', () => {
    const acc = new WatchHeartbeatAccumulator(900_000);
    let now = 1_000_000;

    acc.update(playingSnapshot(), now);
    // Simulate laptop sleep for 3 hours between ticks -> capped to MAX_TICK_DELTA_MS
    now += 3 * 3_600_000;
    const afterSleep = acc.flush(now, true);
    expect(afterSleep).toEqual({
      episode_id: 42,
      seconds: Math.floor(MAX_TICK_DELTA_MS / 1_000),
    });

    // Accumulate 700s across normal 50s ticks without auto-flushing, then manual flush caps at 600s
    acc.update(playingSnapshot(), now);
    for (let i = 0; i < 14; i++) {
      now += 50_000;
      acc.tick(now);
    }
    const capped = acc.flush(now, true);
    expect(capped).toEqual({
      episode_id: 42,
      seconds: MAX_HEARTBEAT_SECONDS,
    });
    expect(acc.getAccumulatedMs()).toBe(0);
  });
});
