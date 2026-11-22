import type { LineOut, TokenOut, WatchIn } from '../api/client';

export const PLAYER_OFFSET_STEP_MS = 100;
export const PLAYER_SLOW_REPLAY_RATE = 0.75;
export const PLAYER_HEARTBEAT_FLUSH_MS = 30_000;
export const PLAYER_MAX_TICK_DELTA_MS = 65_000;
export const PLAYER_MAX_HEARTBEAT_SECONDS = 600;

const VIDEO_EXT_RE = /\.(mp4|m4v|webm|mkv|mov|ogv|ogg)$/i;

export function isSupportedVideoFile(file: { name: string; type: string }): boolean {
  if (file.type && file.type.startsWith('video/')) {
    return true;
  }
  return VIDEO_EXT_RE.test(file.name);
}

/**
 * Find all subtitle lines active at `videoMs` given `subOffsetMs`
 * (`display when start_ms + subOffsetMs <= videoMs < end_ms + subOffsetMs`).
 */
export function findActivePlayerLines(
  lines: readonly LineOut[],
  videoMs: number,
  subOffsetMs = 0,
): LineOut[] {
  if (lines.length === 0) return [];
  const subTimeMs = videoMs - subOffsetMs;

  // Binary search for the first line with start_ms > subTimeMs
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const line = lines[mid];
    if (line && line.start_ms <= subTimeMs) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  const active: LineOut[] = [];
  // Scan backward from lo - 1 across any overlapping lines
  for (let i = lo - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    if (line.start_ms <= subTimeMs && subTimeMs < line.end_ms) {
      active.push(line);
    } else if (subTimeMs - line.start_ms > 60_000) {
      break;
    }
  }

  active.reverse();
  return active;
}

export function isPlayerUnknownContentToken(
  token: Pick<TokenOut, 'is_content' | 'is_proper_noun' | 'status'>,
): boolean {
  if (token.is_proper_noun || !token.is_content) {
    return false;
  }
  return token.status !== 'known' && token.status !== 'ignored';
}

/**
 * Rank top N unknown content tokens per line by Zipf frequency descending
 * (tie-breaking on `common`, then token index).
 */
export function rankPlayerHighlightIndices(
  tokens: readonly TokenOut[],
  maxHighlights = 3,
): Set<number> {
  const limit = Math.max(0, Math.floor(maxHighlights));
  if (limit === 0) return new Set();

  const candidates = tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token }) => isPlayerUnknownContentToken(token));

  candidates.sort((a, b) => {
    const zipfA = a.token.zipf ?? -1;
    const zipfB = b.token.zipf ?? -1;
    if (zipfA !== zipfB) return zipfB - zipfA;
    if (a.token.common !== b.token.common) return a.token.common ? -1 : 1;
    return a.index - b.index;
  });

  const selected = new Set<number>();
  const seenKeys = new Set<string>();
  for (const { token, index } of candidates) {
    const key =
      token.word_id !== null
        ? `id:${token.word_id}`
        : `lemma:${token.lemma}:${token.lemma_reading}`;
    if (seenKeys.has(key)) {
      selected.add(index);
      continue;
    }
    if (seenKeys.size >= limit) continue;
    seenKeys.add(key);
    selected.add(index);
  }
  return selected;
}

export function findPlayerLineToReplay(
  lines: readonly LineOut[],
  videoMs: number,
  subOffsetMs = 0,
): LineOut | null {
  const active = findActivePlayerLines(lines, videoMs, subOffsetMs);
  if (active.length > 0) {
    return active[active.length - 1] ?? null;
  }
  const subTimeMs = videoMs - subOffsetMs;
  let lastEnded: LineOut | null = null;
  for (const line of lines) {
    if (line.start_ms <= subTimeMs) {
      lastEnded = line;
    } else {
      break;
    }
  }
  return lastEnded;
}

export function computePlayerSeekSeconds(line: Pick<LineOut, 'start_ms'>, subOffsetMs = 0): number {
  return Math.max(0, (line.start_ms + subOffsetMs) / 1000);
}

export function findReferenceLineForSync(
  lines: readonly LineOut[],
  videoMs: number,
  subOffsetMs = 0,
): LineOut | null {
  const active = findActivePlayerLines(lines, videoMs, subOffsetMs);
  if (active.length > 0) return active[0] ?? null;

  const subTimeMs = videoMs - subOffsetMs;
  let best: LineOut | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    const dist = Math.abs(line.start_ms - subTimeMs);
    if (dist < bestDist) {
      bestDist = dist;
      best = line;
    }
  }
  return best;
}

export function computeSyncOffsetMs(videoMs: number, line: Pick<LineOut, 'start_ms'>): number {
  return Math.round(videoMs - line.start_ms);
}

export function shouldAutoPauseAfterLine(
  prevActiveIds: readonly number[],
  nextActiveIds: readonly number[],
  enabled: boolean,
): boolean {
  if (!enabled || prevActiveIds.length === 0) return false;
  const nextSet = new Set(nextActiveIds);
  return prevActiveIds.some((id) => !nextSet.has(id));
}

export function formatOffsetLabel(offsetMs: number): string {
  const sign = offsetMs > 0 ? '+' : '';
  return `${sign}${offsetMs} ms`;
}

export function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}

/**
 * Pure wall-clock watch-time accumulator for the built-in web player (POST /activity/watch).
 */
export class PlayerWatchAccumulator {
  private episodeId: number | null = null;
  private counting = false;
  private lastTickMs: number | null = null;
  private accumulatedMs = 0;
  private readonly flushThresholdMs: number;

  constructor(flushThresholdMs = PLAYER_HEARTBEAT_FLUSH_MS) {
    this.flushThresholdMs = Math.max(1_000, flushThresholdMs);
  }

  private advance(nowMs: number): void {
    if (!this.counting || this.lastTickMs === null) return;
    const delta = nowMs - this.lastTickMs;
    if (delta > 0) {
      this.accumulatedMs += Math.min(delta, PLAYER_MAX_TICK_DELTA_MS);
    }
    this.lastTickMs = nowMs;
  }

  update(episodeId: number | null, isPlaying: boolean, nowMs: number): WatchIn | null {
    this.advance(nowMs);
    if (this.episodeId !== null && episodeId !== this.episodeId) {
      const prev = this.flush(nowMs, true);
      this.episodeId = episodeId;
      this.counting = Boolean(episodeId !== null && isPlaying);
      this.lastTickMs = this.counting ? nowMs : null;
      return prev;
    }

    if (episodeId !== null && isPlaying) {
      this.episodeId = episodeId;
      if (!this.counting) {
        this.counting = true;
        this.lastTickMs = nowMs;
      }
      if (this.accumulatedMs >= this.flushThresholdMs) {
        return this.flush(nowMs, false);
      }
      return null;
    }

    const wasCounting = this.counting;
    this.counting = false;
    this.lastTickMs = null;
    if (wasCounting || this.accumulatedMs >= 1_000) {
      return this.flush(nowMs, false);
    }
    return null;
  }

  tick(nowMs: number): WatchIn | null {
    if (!this.counting || this.lastTickMs === null) return null;
    this.advance(nowMs);
    if (this.accumulatedMs >= this.flushThresholdMs) {
      return this.flush(nowMs, false);
    }
    return null;
  }

  flush(nowMs?: number, resetRemainder = false): WatchIn | null {
    if (nowMs !== undefined) {
      this.advance(nowMs);
    }
    if (this.episodeId === null) {
      this.accumulatedMs = 0;
      return null;
    }
    const whole = Math.floor(this.accumulatedMs / 1_000);
    if (whole < 1) {
      if (resetRemainder) this.accumulatedMs = 0;
      return null;
    }
    const seconds = Math.min(PLAYER_MAX_HEARTBEAT_SECONDS, whole);
    if (resetRemainder || whole > PLAYER_MAX_HEARTBEAT_SECONDS) {
      this.accumulatedMs = 0;
    } else {
      this.accumulatedMs -= seconds * 1_000;
    }
    return { episode_id: this.episodeId, seconds };
  }
}

/**
 * Capture a clean PNG screenshot from a local `<video>` via offscreen canvas.
 * Local `blob:` URLs are same-origin so canvas export never hits CORS tainting.
 */
export async function captureLocalVideoScreenshot(
  video: HTMLVideoElement,
): Promise<{ blob: Blob; filename: string } | null> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, width, height);

  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        resolve(null);
        return;
      }
      resolve({ blob, filename: 'screenshot.png' });
    }, 'image/png');
  });
}

type CaptureStreamVideo = HTMLVideoElement & {
  captureStream?: () => MediaStream;
  mozCaptureStream?: () => MediaStream;
};

/**
 * Record the audio track of a subtitle line from a local `<video>` element.
 */
export async function recordLocalLineAudio(
  video: HTMLVideoElement,
  line: Pick<LineOut, 'start_ms' | 'end_ms'>,
  subOffsetMs = 0,
): Promise<{ blob: Blob; filename: string } | null> {
  if (typeof MediaRecorder === 'undefined' || typeof MediaStream === 'undefined') {
    return null;
  }
  const v = video as CaptureStreamVideo;
  const stream =
    typeof v.captureStream === 'function'
      ? v.captureStream()
      : typeof v.mozCaptureStream === 'function'
        ? v.mozCaptureStream()
        : null;
  const audioTracks = stream?.getAudioTracks() ?? [];
  if (!stream || audioTracks.length === 0) return null;

  const durationMs = Math.max(800, Math.min(20_000, line.end_ms - line.start_ms + 300));
  const startSec = computePlayerSeekSeconds(line, subOffsetMs);
  const wasPaused = video.paused;
  const origTime = video.currentTime;
  const origRate = video.playbackRate;

  const mimeCandidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  const mimeType = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';

  let recorder: MediaRecorder;
  try {
    const audioStream = new MediaStream(audioTracks);
    recorder = new MediaRecorder(audioStream, mimeType ? { mimeType } : {});
  } catch {
    return null;
  }

  return new Promise((resolve) => {
    const chunks: Blob[] = [];
    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunks.push(ev.data);
    };
    recorder.onerror = () => {
      video.playbackRate = origRate;
      video.currentTime = origTime;
      if (wasPaused) video.pause();
      resolve(null);
    };
    recorder.onstop = () => {
      video.playbackRate = origRate;
      video.currentTime = origTime;
      if (wasPaused) video.pause();
      if (chunks.length === 0) {
        resolve(null);
        return;
      }
      const finalMime = recorder.mimeType || mimeType || 'audio/webm';
      const ext = finalMime.includes('ogg') ? 'ogg' : 'webm';
      resolve({ blob: new Blob(chunks, { type: finalMime }), filename: `line-audio.${ext}` });
    };

    video.playbackRate = 1;
    video.currentTime = startSec;
    recorder.start();
    void video.play().catch(() => {});
    setTimeout(() => {
      if (recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          resolve(null);
        }
      }
    }, durationMs);
  });
}
