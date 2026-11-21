import type { WatchIn } from '../api/client';

export const HEARTBEAT_FLUSH_MS = 30_000;
export const MIN_HEARTBEAT_SECONDS = 1;
export const MAX_HEARTBEAT_SECONDS = 600;
/** Cap a single timer delta to guard against system sleep / tab suspension jumps. */
export const MAX_TICK_DELTA_MS = 65_000;

export interface WatchPlaybackSnapshot {
  episodeId: number | null;
  overlayEnabled: boolean;
  isPlaying: boolean;
  isBuffering: boolean;
  isCapturing: boolean;
  tabVisible: boolean;
  isAudible: boolean;
}

export function isCountablePlayback(snapshot: WatchPlaybackSnapshot): boolean {
  return (
    snapshot.episodeId !== null &&
    snapshot.overlayEnabled &&
    snapshot.isPlaying &&
    !snapshot.isBuffering &&
    !snapshot.isCapturing &&
    (snapshot.tabVisible || snapshot.isAudible)
  );
}

/**
 * Pure wall-clock watch-time accumulator for POST /activity/watch heartbeats (#65).
 *
 * Uses wall-clock deltas while playback is active (not paused, not buffering,
 * not capturing, tab visible or video audible), so seeking and playbackRate
 * changes never distort watch time.
 */
export class WatchHeartbeatAccumulator {
  private activeEpisodeId: number | null = null;
  private counting = false;
  private lastTickMs: number | null = null;
  private accumulatedMs = 0;
  private readonly flushThresholdMs: number;

  constructor(flushThresholdMs: number = HEARTBEAT_FLUSH_MS) {
    this.flushThresholdMs = Math.max(1_000, flushThresholdMs);
  }

  private advance(nowMs: number): void {
    if (!this.counting || this.lastTickMs === null) {
      return;
    }
    const rawDelta = nowMs - this.lastTickMs;
    if (rawDelta > 0) {
      this.accumulatedMs += Math.min(rawDelta, MAX_TICK_DELTA_MS);
    }
    this.lastTickMs = nowMs;
  }

  /**
   * Synchronize playback state at `nowMs`. Returns a heartbeat payload if a flush
   * should be sent now (e.g., episode detached/changed, playback paused, or 30s reached).
   */
  update(snapshot: WatchPlaybackSnapshot, nowMs: number): WatchIn | null {
    this.advance(nowMs);

    const episodeDetachedOrChanged =
      this.activeEpisodeId !== null &&
      (!snapshot.overlayEnabled || snapshot.episodeId !== this.activeEpisodeId);

    if (episodeDetachedOrChanged) {
      const payload = this.flush(nowMs, true);
      this.counting = false;
      this.lastTickMs = null;
      this.activeEpisodeId = snapshot.overlayEnabled ? snapshot.episodeId : null;
      if (isCountablePlayback(snapshot)) {
        this.counting = true;
        this.lastTickMs = nowMs;
      }
      return payload;
    }

    const shouldCount = isCountablePlayback(snapshot);

    if (shouldCount) {
      this.activeEpisodeId = snapshot.episodeId;
      if (!this.counting) {
        this.counting = true;
        this.lastTickMs = nowMs;
      }
      if (this.accumulatedMs >= this.flushThresholdMs) {
        return this.flush(nowMs, false);
      }
      return null;
    }

    // Stopped counting (paused, buffering, capturing, or hidden & muted)
    const wasCounting = this.counting;
    this.counting = false;
    this.lastTickMs = null;

    // Flush immediately when the user pauses or stops playback; keep accumulated
    // time across brief buffering or scene-capture interruptions.
    if (!snapshot.isPlaying && (wasCounting || this.accumulatedMs >= 1_000)) {
      return this.flush(nowMs, false);
    }

    return null;
  }

  /** Periodic tick (e.g., every 5s) that flushes once `flushThresholdMs` is accumulated. */
  tick(nowMs: number): WatchIn | null {
    if (!this.counting || this.lastTickMs === null) {
      return null;
    }
    this.advance(nowMs);
    if (this.accumulatedMs >= this.flushThresholdMs) {
      return this.flush(nowMs, false);
    }
    return null;
  }

  /**
   * Flush accumulated whole seconds for the active episode (clamped 1..600).
   * Returns `null` if less than 1 second has accumulated or no episode is active.
   */
  flush(nowMs?: number, resetRemainder = false): WatchIn | null {
    if (nowMs !== undefined) {
      this.advance(nowMs);
    }
    if (this.activeEpisodeId === null) {
      this.accumulatedMs = 0;
      return null;
    }
    const wholeSeconds = Math.floor(this.accumulatedMs / 1_000);
    if (wholeSeconds < MIN_HEARTBEAT_SECONDS) {
      if (resetRemainder) {
        this.accumulatedMs = 0;
      }
      return null;
    }
    const seconds = Math.min(MAX_HEARTBEAT_SECONDS, wholeSeconds);
    if (resetRemainder || wholeSeconds > MAX_HEARTBEAT_SECONDS) {
      this.accumulatedMs = 0;
    } else {
      this.accumulatedMs -= seconds * 1_000;
    }
    return {
      episode_id: this.activeEpisodeId,
      seconds,
    };
  }

  getAccumulatedMs(): number {
    return this.accumulatedMs;
  }

  isCounting(): boolean {
    return this.counting;
  }

  reset(): void {
    this.activeEpisodeId = null;
    this.counting = false;
    this.lastTickMs = null;
    this.accumulatedMs = 0;
  }
}
