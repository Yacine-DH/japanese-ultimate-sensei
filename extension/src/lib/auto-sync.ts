import type { ApiCallResponse, EpisodeOut, SyncOut, SyncPoint } from '../api/client';
import {
  AUDIO_MIME_CANDIDATES,
  getVideoCaptureStream,
  pickRecorderMimeType,
  type VideoWithCaptureStream,
} from './capture';
import { normalizeSyncPoints } from './timing';

export const AUTO_SYNC_DURATION_MS = 45_000;
export const AUTO_SYNC_MAX_BUFFERING_MS = 1_000;
export const AUTO_SYNC_MAX_DRIFT_MS = 250;
export const AUTO_SYNC_MIN_SEARCH_MS = 10_000;

export const BACKGROUND_SYNC_INTERVAL_MS = 180_000;
export const BACKGROUND_SYNC_SEEK_THRESHOLD_MS = 30_000;
export const BACKGROUND_SYNC_SEEK_SETTLE_MS = 1_500;
export const BACKGROUND_SYNC_SEEK_BURST_MS = 2_500;
export const BACKGROUND_SYNC_TOAST_MIN_DELTA_MS = 100;
export const BACKGROUND_SYNC_MAX_TICK_STEP_MS = 10_000;

export type AutoSyncRunMode = 'manual' | 'background';
export type BackgroundSyncTriggerReason = 'periodic' | 'seek';

export const AUTO_SYNC_ABORT_MESSAGE = 'Keep it playing at 1× while syncing';
export const AUTO_SYNC_DIALOGUE_HINT = 'Try during dialogue, not during the opening song.';

export type AutoSyncPhase = 'idle' | 'recording' | 'uploading' | 'done' | 'aborted';

export type AutoSyncAbortReason =
  | 'paused'
  | 'ended'
  | 'seeked'
  | 'rate_changed'
  | 'buffered'
  | 'drifted'
  | 'cancelled'
  | 'unavailable'
  | 'recorder_error'
  | 'episode_changed'
  | 'upload_error';

export interface SyncDriftCheckInput {
  videoStartMs: number;
  videoEndMs: number;
  wallStartMs: number;
  wallEndMs: number;
  maxDriftMs?: number;
}

export interface SyncDriftCheckResult {
  ok: boolean;
  driftMs: number;
  videoProgressMs: number;
  wallDurationMs: number;
}

/**
 * Compare video-time progress against recorded wall-clock duration (#102).
 * Catches cumulative short stalls (< 1 s each), missed seeks, and throttled tabs
 * that shift recorded audio relative to `video_start_ms`.
 */
export function checkSyncPlaybackDrift(input: SyncDriftCheckInput): SyncDriftCheckResult {
  const maxDriftMs = Math.max(0, input.maxDriftMs ?? AUTO_SYNC_MAX_DRIFT_MS);
  const videoProgressMs = input.videoEndMs - input.videoStartMs;
  const wallDurationMs = input.wallEndMs - input.wallStartMs;
  if (!Number.isFinite(videoProgressMs) || !Number.isFinite(wallDurationMs)) {
    return {
      ok: false,
      driftMs: Number.POSITIVE_INFINITY,
      videoProgressMs: 0,
      wallDurationMs: 0,
    };
  }
  const driftMs = Math.abs(videoProgressMs - wallDurationMs);
  return {
    ok: driftMs <= maxDriftMs,
    driftMs,
    videoProgressMs,
    wallDurationMs,
  };
}

export interface AutoSyncPlaybackCheck {
  paused: boolean;
  ended: boolean;
  playbackRate: number;
}

export interface AutoSyncSnapshot {
  phase: AutoSyncPhase;
  startedAtMs: number | null;
  remainingMs: number;
  remainingSeconds: number;
  videoStartMs: number | null;
  bufferingSinceMs: number | null;
  abortReason: AutoSyncAbortReason | null;
  abortMessage: string | null;
  result: SyncOut | null;
  error: string | null;
}

export interface AutoSyncOptions {
  durationMs?: number;
  maxBufferingMs?: number;
}

function isNormalPlaybackRate(rate: number): boolean {
  return Number.isFinite(rate) && Math.abs(rate - 1) <= 1e-4;
}

export function formatOffsetSeconds(offsetMs: number): string {
  if (!Number.isFinite(offsetMs)) {
    return '0.0 s';
  }
  const tenths = Math.round(offsetMs / 100) / 10;
  if (tenths === 0 || Object.is(tenths, -0)) {
    return '0.0 s';
  }
  const sign = tenths > 0 ? '+' : '';
  return `${sign}${tenths.toFixed(1)} s`;
}

export function formatSyncTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return '0:00';
  }
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function findOwningSyncPointAt(
  atMs: number,
  syncPoints: readonly SyncPoint[] | undefined,
): SyncPoint | null {
  const normalized = normalizeSyncPoints(syncPoints);
  let owner: SyncPoint | null = null;
  for (const pt of normalized) {
    if (pt.at_ms <= atMs) {
      owner = pt;
    } else {
      break;
    }
  }
  return owner;
}

/**
 * Quiet toast for a background re-sync result (#138).
 * Returns null when not applied or when a refinement barely changed the active offset.
 */
export function formatBackgroundSyncToast(
  result: Pick<
    SyncOut,
    'applied' | 'action' | 'offset_ms' | 'previous_offset_ms' | 'at_ms' | 'sync_points'
  >,
): string | null {
  if (!result.applied) {
    return null;
  }
  const deltaMs = Math.abs(result.offset_ms - result.previous_offset_ms);
  if (result.action !== 'point' && deltaMs < BACKGROUND_SYNC_TOAST_MIN_DELTA_MS) {
    return null;
  }
  const offsetText = formatOffsetSeconds(result.offset_ms);
  if (result.action === 'point') {
    const owner = findOwningSyncPointAt(result.at_ms, result.sync_points);
    const ts = formatSyncTimestamp(owner?.at_ms ?? result.at_ms);
    return `Re-synced ${offsetText} from ${ts}`;
  }
  if (result.action === 'refined') {
    const owner = findOwningSyncPointAt(result.at_ms, result.sync_points);
    if (owner) {
      return `Re-synced ${offsetText} from ${formatSyncTimestamp(owner.at_ms)}`;
    }
  }
  return `Re-synced ${offsetText}`;
}

export interface SyncSummaryPresentation {
  headline: string;
  pointCount: number;
  pointLabels: string[];
  canReset: boolean;
}

export function formatSyncSummary(
  episode: Pick<EpisodeOut, 'sub_offset_ms' | 'sync_points'> | null | undefined,
): SyncSummaryPresentation {
  if (!episode) {
    return {
      headline: 'Default timing (0.0 s)',
      pointCount: 0,
      pointLabels: [],
      canReset: false,
    };
  }

  const baseMs = Number.isFinite(episode.sub_offset_ms) ? Math.round(episode.sub_offset_ms) : 0;
  const points = normalizeSyncPoints(episode.sync_points);
  const canReset = baseMs !== 0 || points.length > 0;

  if (points.length === 0) {
    return {
      headline: baseMs !== 0 ? `Offset ${formatOffsetSeconds(baseMs)}` : 'Default timing (0.0 s)',
      pointCount: 0,
      pointLabels: [],
      canReset,
    };
  }

  const pointWord = points.length === 1 ? 'sync point' : 'sync points';
  const pointLabels: string[] = [];
  if (baseMs !== 0) {
    pointLabels.push(`0:00 → ${formatOffsetSeconds(baseMs)}`);
  }
  for (const pt of points) {
    pointLabels.push(`${formatSyncTimestamp(pt.at_ms)} → ${formatOffsetSeconds(pt.offset_ms)}`);
  }

  return {
    headline: `${points.length} ${pointWord}`,
    pointCount: points.length,
    pointLabels,
    canReset,
  };
}

export function formatSyncProgressText(snapshot: Pick<AutoSyncSnapshot, 'phase' | 'remainingSeconds'>): string {
  if (snapshot.phase === 'recording') {
    return `Syncing… ${Math.max(0, snapshot.remainingSeconds)} s`;
  }
  if (snapshot.phase === 'uploading') {
    return 'Syncing… analyzing audio';
  }
  return '';
}

export function formatSyncConfidenceMeta(
  result: Pick<SyncOut, 'confidence' | 'runner_up'>,
): string {
  return `conf ${result.confidence.toFixed(1)} · runner-up ${result.runner_up.toFixed(1)}`;
}

export function formatManualApplyToast(offsetMs: number): string {
  return `Synced: subtitles shifted by ${formatOffsetSeconds(offsetMs)}`;
}

export type SyncOutcomePresentation =
  | {
      kind: 'applied';
      offsetMs: number;
      title: string;
      meta: string;
    }
  | {
      kind: 'not_applied';
      offsetMs: number;
      title: string;
      hint: string;
      meta: string;
      useAnywayLabel: string;
    }
  | {
      kind: 'error';
      title: string;
    };

export function buildSyncOutcomePresentation(
  res: ApiCallResponse<SyncOut>,
): SyncOutcomePresentation {
  if (!res.ok || !res.data) {
    return {
      kind: 'error',
      title: `Auto-sync failed: ${res.error || 'Request failed'}`,
    };
  }

  const data = res.data;
  const formattedOffset = formatOffsetSeconds(data.offset_ms);
  const meta = formatSyncConfidenceMeta(data);

  if (data.applied) {
    const owner =
      data.action === 'point' ? findOwningSyncPointAt(data.at_ms, data.sync_points) : null;
    const title =
      data.action === 'point'
        ? `Re-synced ${formattedOffset} from ${formatSyncTimestamp(owner?.at_ms ?? data.at_ms)}`
        : `Synced: subtitles shifted by ${formattedOffset}`;
    return {
      kind: 'applied',
      offsetMs: data.offset_ms,
      title,
      meta,
    };
  }

  const detail = data.detail?.trim() || 'Could not confidently match subtitles';
  return {
    kind: 'not_applied',
    offsetMs: data.offset_ms,
    title: detail,
    hint: AUTO_SYNC_DIALOGUE_HINT,
    meta,
    useAnywayLabel: `Use anyway (${formattedOffset})`,
  };
}

export function defaultAbortMessage(reason: AutoSyncAbortReason): string {
  switch (reason) {
    case 'paused':
    case 'ended':
    case 'seeked':
    case 'rate_changed':
    case 'buffered':
    case 'drifted':
      return AUTO_SYNC_ABORT_MESSAGE;
    case 'cancelled':
      return 'Auto-sync cancelled';
    case 'episode_changed':
      return 'Auto-sync cancelled (episode changed)';
    case 'unavailable':
      return 'Cannot capture audio from this video';
    case 'recorder_error':
      return 'Audio recording failed';
    case 'upload_error':
      return 'Auto-sync upload failed';
  }
}

export class AutoSyncStateMachine {
  readonly durationMs: number;
  readonly maxBufferingMs: number;
  private state: AutoSyncSnapshot;

  constructor(options: AutoSyncOptions = {}) {
    this.durationMs = Math.max(1_000, Math.round(options.durationMs ?? AUTO_SYNC_DURATION_MS));
    this.maxBufferingMs = Math.max(
      100,
      Math.round(options.maxBufferingMs ?? AUTO_SYNC_MAX_BUFFERING_MS),
    );
    this.state = this.createIdleState();
  }

  private createIdleState(): AutoSyncSnapshot {
    return {
      phase: 'idle',
      startedAtMs: null,
      remainingMs: this.durationMs,
      remainingSeconds: Math.ceil(this.durationMs / 1000),
      videoStartMs: null,
      bufferingSinceMs: null,
      abortReason: null,
      abortMessage: null,
      result: null,
      error: null,
    };
  }

  getState(): AutoSyncSnapshot {
    return { ...this.state };
  }

  isActive(): boolean {
    return this.state.phase === 'recording' || this.state.phase === 'uploading';
  }

  isRecording(): boolean {
    return this.state.phase === 'recording';
  }

  checkPlayback(
    playback: AutoSyncPlaybackCheck,
  ): { ok: true } | { ok: false; reason: AutoSyncAbortReason; message: string } {
    if (playback.ended) {
      return { ok: false, reason: 'ended', message: AUTO_SYNC_ABORT_MESSAGE };
    }
    if (playback.paused) {
      return { ok: false, reason: 'paused', message: AUTO_SYNC_ABORT_MESSAGE };
    }
    if (!isNormalPlaybackRate(playback.playbackRate)) {
      return { ok: false, reason: 'rate_changed', message: AUTO_SYNC_ABORT_MESSAGE };
    }
    return { ok: true };
  }

  startRecording(nowMs: number, playback: AutoSyncPlaybackCheck): AutoSyncSnapshot {
    const check = this.checkPlayback(playback);
    if (!check.ok) {
      this.state = {
        ...this.createIdleState(),
        phase: 'aborted',
        abortReason: check.reason,
        abortMessage: check.message,
      };
      return this.getState();
    }

    this.state = {
      phase: 'recording',
      startedAtMs: nowMs,
      remainingMs: this.durationMs,
      remainingSeconds: Math.ceil(this.durationMs / 1000),
      videoStartMs: null,
      bufferingSinceMs: null,
      abortReason: null,
      abortMessage: null,
      result: null,
      error: null,
    };
    return this.getState();
  }

  markRecorderStarted(videoStartMs: number, nowMs?: number): AutoSyncSnapshot {
    if (this.state.phase !== 'recording') {
      return this.getState();
    }
    this.state.videoStartMs = Math.max(0, Math.round(videoStartMs));
    if (nowMs !== undefined) {
      this.state.startedAtMs = nowMs;
      this.state.remainingMs = this.durationMs;
      this.state.remainingSeconds = Math.ceil(this.durationMs / 1000);
    }
    return this.getState();
  }

  onPlaybackEvent(
    event: 'pause' | 'ended' | 'seek' | 'waiting' | 'playing' | 'ratechange',
    nowMs: number,
    playbackRate?: number,
  ): AutoSyncSnapshot {
    if (this.state.phase !== 'recording') {
      return this.getState();
    }

    switch (event) {
      case 'pause':
        return this.abort('paused');
      case 'ended':
        return this.abort('ended');
      case 'seek':
        return this.abort('seeked');
      case 'ratechange':
        if (playbackRate !== undefined && !isNormalPlaybackRate(playbackRate)) {
          return this.abort('rate_changed');
        }
        return this.getState();
      case 'waiting':
        if (this.state.bufferingSinceMs === null) {
          this.state.bufferingSinceMs = nowMs;
        }
        return this.getState();
      case 'playing':
        this.state.bufferingSinceMs = null;
        return this.getState();
    }
  }

  tick(
    nowMs: number,
    playback?: Partial<AutoSyncPlaybackCheck>,
  ): { snapshot: AutoSyncSnapshot; completed: boolean } {
    if (this.state.phase !== 'recording') {
      return { snapshot: this.getState(), completed: false };
    }

    if (playback?.ended) {
      return { snapshot: this.abort('ended'), completed: false };
    }
    if (playback?.paused) {
      return { snapshot: this.abort('paused'), completed: false };
    }
    if (playback?.playbackRate !== undefined && !isNormalPlaybackRate(playback.playbackRate)) {
      return { snapshot: this.abort('rate_changed'), completed: false };
    }

    if (
      this.state.bufferingSinceMs !== null &&
      nowMs - this.state.bufferingSinceMs > this.maxBufferingMs
    ) {
      return { snapshot: this.abort('buffered'), completed: false };
    }

    const startedAt = this.state.startedAtMs ?? nowMs;
    const elapsed = Math.max(0, nowMs - startedAt);
    const remainingMs = Math.max(0, this.durationMs - elapsed);
    this.state.remainingMs = remainingMs;
    this.state.remainingSeconds = Math.ceil(remainingMs / 1000);

    return {
      snapshot: this.getState(),
      completed: remainingMs <= 0,
    };
  }

  beginUpload(): AutoSyncSnapshot {
    if (this.state.phase !== 'recording') {
      return this.getState();
    }
    this.state = {
      ...this.state,
      phase: 'uploading',
      remainingMs: 0,
      remainingSeconds: 0,
      bufferingSinceMs: null,
    };
    return this.getState();
  }

  finishSuccess(result: SyncOut): AutoSyncSnapshot {
    if (this.state.phase !== 'uploading') {
      return this.getState();
    }
    this.state = {
      ...this.state,
      phase: 'done',
      result,
      error: null,
    };
    return this.getState();
  }

  finishError(error: string): AutoSyncSnapshot {
    if (this.state.phase !== 'uploading') {
      return this.getState();
    }
    this.state = {
      ...this.state,
      phase: 'aborted',
      abortReason: 'upload_error',
      abortMessage: error,
      error,
    };
    return this.getState();
  }

  abort(reason: AutoSyncAbortReason, customMessage?: string): AutoSyncSnapshot {
    const message = customMessage ?? defaultAbortMessage(reason);
    this.state = {
      ...this.state,
      phase: 'aborted',
      bufferingSinceMs: null,
      abortReason: reason,
      abortMessage: message,
      error: reason === 'upload_error' ? message : this.state.error,
    };
    return this.getState();
  }

  reset(): AutoSyncSnapshot {
    this.state = this.createIdleState();
    return this.getState();
  }
}

export type RecordedSyncSampleResult =
  | {
      ok: true;
      blob: Blob;
      mimeType: string;
      filename: string;
      videoStartMs: number;
    }
  | {
      ok: false;
      reason: AutoSyncAbortReason;
      message: string;
    };

export interface ActiveSyncRecordingHandle {
  promise: Promise<RecordedSyncSampleResult>;
  cancel: (reason?: AutoSyncAbortReason, message?: string) => void;
}

/**
 * Records an audio-only sample (default 45 s) from `<video>.captureStream()` via MediaRecorder.
 * Reads `video_start_ms` inside `MediaRecorder.onstart` and aborts cleanly (without uploading)
 * on pause, seek, playbackRate != 1, buffering > 1 s, or user cancellation.
 */
export function startSyncAudioRecording(params: {
  video: HTMLVideoElement;
  machine: AutoSyncStateMachine;
  onStateChange: (snapshot: AutoSyncSnapshot) => void;
  now?: () => number;
  tickIntervalMs?: number;
  maxDriftMs?: number;
}): ActiveSyncRecordingHandle {
  const { video, machine, onStateChange } = params;
  const now = params.now ?? (() => Date.now());
  const tickIntervalMs = params.tickIntervalMs ?? 250;
  const maxDriftMs = params.maxDriftMs ?? AUTO_SYNC_MAX_DRIFT_MS;

  const initial = machine.startRecording(now(), {
    paused: video.paused,
    ended: video.ended,
    playbackRate: video.playbackRate,
  });
  onStateChange(initial);

  if (initial.phase === 'aborted') {
    return {
      promise: Promise.resolve({
        ok: false,
        reason: initial.abortReason ?? 'paused',
        message: initial.abortMessage ?? AUTO_SYNC_ABORT_MESSAGE,
      }),
      cancel: () => {},
    };
  }

  if (typeof MediaRecorder === 'undefined' || typeof MediaStream === 'undefined') {
    const aborted = machine.abort('unavailable', 'Audio recording is not supported in this browser');
    onStateChange(aborted);
    return {
      promise: Promise.resolve({
        ok: false,
        reason: 'unavailable',
        message: aborted.abortMessage ?? defaultAbortMessage('unavailable'),
      }),
      cancel: () => {},
    };
  }

  const stream = getVideoCaptureStream(video as unknown as VideoWithCaptureStream);
  const audioTracks = stream?.getAudioTracks() ?? [];
  if (!stream || audioTracks.length === 0) {
    const aborted = machine.abort(
      'unavailable',
      'Cannot capture audio from this video (DRM or no audio track)',
    );
    onStateChange(aborted);
    return {
      promise: Promise.resolve({
        ok: false,
        reason: 'unavailable',
        message: aborted.abortMessage ?? defaultAbortMessage('unavailable'),
      }),
      cancel: () => {},
    };
  }

  const mimeType = pickRecorderMimeType(AUDIO_MIME_CANDIDATES);
  let recorder: MediaRecorder;
  try {
    const audioOnlyStream = new MediaStream(audioTracks);
    const options: MediaRecorderOptions = mimeType ? { mimeType } : {};
    recorder = new MediaRecorder(audioOnlyStream, options);
  } catch {
    const aborted = machine.abort('recorder_error', 'Could not start audio recorder');
    onStateChange(aborted);
    return {
      promise: Promise.resolve({
        ok: false,
        reason: 'recorder_error',
        message: aborted.abortMessage ?? defaultAbortMessage('recorder_error'),
      }),
      cancel: () => {},
    };
  }

  let settled = false;
  let finishing = false;
  let recordedVideoStartMs: number | null = null;
  let recordedWallStartMs: number | null = null;
  let lastProgressSec = initial.remainingSeconds;
  const chunks: Blob[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let resolveResult!: (res: RecordedSyncSampleResult) => void;

  const promise = new Promise<RecordedSyncSampleResult>((resolve) => {
    resolveResult = resolve;
  });

  const cleanupListeners = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    video.removeEventListener('pause', onPause);
    video.removeEventListener('ended', onEnded);
    video.removeEventListener('seeking', onSeek);
    video.removeEventListener('seeked', onSeek);
    video.removeEventListener('ratechange', onRateChange);
    video.removeEventListener('waiting', onWaiting);
    video.removeEventListener('stalled', onWaiting);
    video.removeEventListener('playing', onPlaying);
    video.removeEventListener('canplay', onPlaying);
  };

  const stopRecorderSilently = () => {
    if (recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        // Already stopped
      }
    }
  };

  const abortRecording = (reason: AutoSyncAbortReason, customMessage?: string) => {
    if (settled) return;
    settled = true;
    cleanupListeners();
    const aborted = machine.abort(reason, customMessage);
    onStateChange(aborted);
    stopRecorderSilently();
    resolveResult({
      ok: false,
      reason,
      message: aborted.abortMessage ?? defaultAbortMessage(reason),
    });
  };

  const onPause = () => {
    const next = machine.onPlaybackEvent('pause', now());
    if (next.phase === 'aborted') {
      abortRecording(next.abortReason ?? 'paused', next.abortMessage ?? undefined);
    }
  };
  const onEnded = () => {
    const next = machine.onPlaybackEvent('ended', now());
    if (next.phase === 'aborted') {
      abortRecording(next.abortReason ?? 'ended', next.abortMessage ?? undefined);
    }
  };
  const onSeek = () => {
    const next = machine.onPlaybackEvent('seek', now());
    if (next.phase === 'aborted') {
      abortRecording(next.abortReason ?? 'seeked', next.abortMessage ?? undefined);
    }
  };
  const onRateChange = () => {
    const next = machine.onPlaybackEvent('ratechange', now(), video.playbackRate);
    if (next.phase === 'aborted') {
      abortRecording(next.abortReason ?? 'rate_changed', next.abortMessage ?? undefined);
    }
  };
  const onWaiting = () => {
    machine.onPlaybackEvent('waiting', now());
  };
  const onPlaying = () => {
    machine.onPlaybackEvent('playing', now());
  };

  video.addEventListener('pause', onPause);
  video.addEventListener('ended', onEnded);
  video.addEventListener('seeking', onSeek);
  video.addEventListener('seeked', onSeek);
  video.addEventListener('ratechange', onRateChange);
  video.addEventListener('waiting', onWaiting);
  video.addEventListener('stalled', onWaiting);
  video.addEventListener('playing', onPlaying);
  video.addEventListener('canplay', onPlaying);

  recorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) {
      chunks.push(ev.data);
    }
  };

  recorder.onstart = () => {
    if (settled) return;
    const startWall = now();
    recordedWallStartMs = startWall;
    recordedVideoStartMs = Math.max(0, Math.round(video.currentTime * 1000));
    const started = machine.markRecorderStarted(recordedVideoStartMs, startWall);
    lastProgressSec = started.remainingSeconds;
    onStateChange(started);
  };

  recorder.onerror = () => {
    abortRecording('recorder_error', 'Audio recording error');
  };

  recorder.onstop = () => {
    if (settled) return;
    settled = true;
    cleanupListeners();
    if (!finishing) {
      const aborted = machine.abort('recorder_error', 'Audio recording stopped unexpectedly');
      onStateChange(aborted);
      resolveResult({
        ok: false,
        reason: 'recorder_error',
        message: aborted.abortMessage ?? defaultAbortMessage('recorder_error'),
      });
      return;
    }
    if (chunks.length === 0) {
      const aborted = machine.abort('recorder_error', 'No audio data captured');
      onStateChange(aborted);
      resolveResult({
        ok: false,
        reason: 'recorder_error',
        message: aborted.abortMessage ?? defaultAbortMessage('recorder_error'),
      });
      return;
    }
    if (recordedVideoStartMs !== null && recordedWallStartMs !== null) {
      const drift = checkSyncPlaybackDrift({
        videoStartMs: recordedVideoStartMs,
        videoEndMs: Math.max(0, Math.round(video.currentTime * 1000)),
        wallStartMs: recordedWallStartMs,
        wallEndMs: now(),
        maxDriftMs,
      });
      if (!drift.ok) {
        const aborted = machine.abort('drifted');
        onStateChange(aborted);
        resolveResult({
          ok: false,
          reason: 'drifted',
          message: aborted.abortMessage ?? AUTO_SYNC_ABORT_MESSAGE,
        });
        return;
      }
    }
    const finalMime = recorder.mimeType || mimeType || 'audio/webm';
    const blob = new Blob(chunks, { type: finalMime });
    const filename = finalMime.includes('ogg') ? 'sync-sample.ogg' : 'sync-sample.webm';
    const fallbackStartMs = Math.max(0, Math.round(video.currentTime * 1000 - machine.durationMs));
    resolveResult({
      ok: true,
      blob,
      mimeType: finalMime,
      filename,
      videoStartMs: recordedVideoStartMs ?? fallbackStartMs,
    });
  };

  try {
    recorder.start(1000);
  } catch {
    abortRecording('recorder_error', 'Could not start audio recorder');
    return { promise, cancel: () => {} };
  }

  timer = setInterval(() => {
    if (settled || finishing) return;
    const { snapshot, completed } = machine.tick(now(), {
      paused: video.paused,
      ended: video.ended,
      playbackRate: video.playbackRate,
    });
    if (snapshot.phase === 'aborted') {
      abortRecording(snapshot.abortReason ?? 'buffered', snapshot.abortMessage ?? undefined);
      return;
    }
    if (snapshot.remainingSeconds !== lastProgressSec) {
      lastProgressSec = snapshot.remainingSeconds;
      onStateChange(snapshot);
    }
    if (completed) {
      finishing = true;
      cleanupListeners();
      stopRecorderSilently();
    }
  }, tickIntervalMs);

  return {
    promise,
    cancel: (reason: AutoSyncAbortReason = 'cancelled', customMessage?: string) => {
      abortRecording(reason, customMessage);
    },
  };
}

export interface BackgroundAutoSyncSchedulerOptions {
  enabled?: boolean;
  intervalMs?: number;
  seekThresholdMs?: number;
  seekSettleMs?: number;
  seekBurstMs?: number;
}

export interface BackgroundSyncTickInput {
  nowMs: number;
  videoMs: number;
  episodeId: number | null;
  overlayEnabled: boolean;
  isPlaying: boolean;
  isSeeking: boolean;
  playbackRate: number;
  isBuffering: boolean;
  isCapturing: boolean;
  isSyncActive: boolean;
  autoPauseEachLine: boolean;
}

/**
 * Decides when to quietly kick off a 45 s background re-sync sample (#138):
 * - Periodically after ~3 minutes of normal 1× playback with subtitles attached.
 * - Right after any seek (or rapid scrub burst) of more than 30 s, once playback settles.
 */
export class BackgroundAutoSyncScheduler {
  readonly intervalMs: number;
  readonly seekThresholdMs: number;
  readonly seekSettleMs: number;
  readonly seekBurstMs: number;

  private enabled: boolean;
  private episodeId: number | null = null;
  private unavailableForVideo = false;
  private playingMsSinceLastSync = 0;
  private lastTickWallMs: number | null = null;
  private lastSteadyVideoMs: number | null = null;
  private seekOriginVideoMs: number | null = null;
  private lastSeekWallMs: number | null = null;
  private pendingSeekSyncAtMs: number | null = null;

  constructor(options: BackgroundAutoSyncSchedulerOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.intervalMs = Math.max(1_000, Math.round(options.intervalMs ?? BACKGROUND_SYNC_INTERVAL_MS));
    this.seekThresholdMs = Math.max(
      1_000,
      Math.round(options.seekThresholdMs ?? BACKGROUND_SYNC_SEEK_THRESHOLD_MS),
    );
    this.seekSettleMs = Math.max(
      0,
      Math.round(options.seekSettleMs ?? BACKGROUND_SYNC_SEEK_SETTLE_MS),
    );
    this.seekBurstMs = Math.max(0, Math.round(options.seekBurstMs ?? BACKGROUND_SYNC_SEEK_BURST_MS));
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.pendingSeekSyncAtMs = null;
      this.seekOriginVideoMs = null;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  markUnavailableForVideo(): void {
    this.unavailableForVideo = true;
    this.pendingSeekSyncAtMs = null;
    this.seekOriginVideoMs = null;
  }

  resetForVideo(): void {
    this.unavailableForVideo = false;
    this.playingMsSinceLastSync = 0;
    this.lastTickWallMs = null;
    this.lastSteadyVideoMs = null;
    this.seekOriginVideoMs = null;
    this.lastSeekWallMs = null;
    this.pendingSeekSyncAtMs = null;
  }

  resetForEpisode(episodeId: number | null): void {
    this.episodeId = episodeId;
    this.playingMsSinceLastSync = 0;
    this.lastTickWallMs = null;
    this.lastSteadyVideoMs = null;
    this.seekOriginVideoMs = null;
    this.lastSeekWallMs = null;
    this.pendingSeekSyncAtMs = null;
  }

  markSyncStarted(nowMs: number): void {
    this.playingMsSinceLastSync = 0;
    this.pendingSeekSyncAtMs = null;
    this.seekOriginVideoMs = null;
    this.lastSeekWallMs = null;
    this.lastTickWallMs = nowMs;
  }

  markSyncFinished(nowMs: number): void {
    this.playingMsSinceLastSync = 0;
    this.lastTickWallMs = nowMs;
  }

  onSeeked(newVideoMs: number, nowMs: number, options?: { isCapturing?: boolean }): boolean {
    if (!Number.isFinite(newVideoMs) || newVideoMs < 0) {
      return false;
    }
    if (options?.isCapturing) {
      this.lastSteadyVideoMs = newVideoMs;
      return false;
    }
    if (!this.enabled || this.unavailableForVideo || this.episodeId === null) {
      this.lastSteadyVideoMs = newVideoMs;
      return false;
    }

    const inBurst =
      this.seekOriginVideoMs !== null &&
      this.lastSeekWallMs !== null &&
      nowMs - this.lastSeekWallMs <= this.seekBurstMs;

    const originMs = inBurst ? this.seekOriginVideoMs : this.lastSteadyVideoMs;
    this.lastSeekWallMs = nowMs;
    this.lastSteadyVideoMs = newVideoMs;

    if (originMs === null) {
      return false;
    }
    if (!inBurst) {
      this.seekOriginVideoMs = originMs;
    }

    const jumpMs = Math.abs(newVideoMs - originMs);
    if (jumpMs > this.seekThresholdMs) {
      this.pendingSeekSyncAtMs = nowMs + this.seekSettleMs;
      return true;
    }
    return false;
  }

  tick(input: BackgroundSyncTickInput): BackgroundSyncTriggerReason | null {
    if (input.episodeId !== this.episodeId) {
      this.resetForEpisode(input.episodeId);
    }

    if (!input.isSeeking && !input.isCapturing && Number.isFinite(input.videoMs) && input.videoMs >= 0) {
      this.lastSteadyVideoMs = input.videoMs;
    }

    if (
      this.seekOriginVideoMs !== null &&
      this.pendingSeekSyncAtMs === null &&
      this.lastSeekWallMs !== null &&
      input.nowMs - this.lastSeekWallMs > this.seekBurstMs
    ) {
      this.seekOriginVideoMs = null;
    }

    const canRun =
      this.enabled &&
      !this.unavailableForVideo &&
      input.overlayEnabled &&
      input.episodeId !== null &&
      !input.isCapturing &&
      !input.isSyncActive &&
      !input.autoPauseEachLine;

    const playbackEligible =
      canRun &&
      input.isPlaying &&
      !input.isSeeking &&
      !input.isBuffering &&
      isNormalPlaybackRate(input.playbackRate);

    if (!playbackEligible) {
      this.lastTickWallMs = input.nowMs;
      return null;
    }

    if (this.pendingSeekSyncAtMs !== null) {
      if (input.nowMs >= this.pendingSeekSyncAtMs) {
        this.pendingSeekSyncAtMs = null;
        this.seekOriginVideoMs = null;
        this.lastSeekWallMs = null;
        this.playingMsSinceLastSync = 0;
        this.lastTickWallMs = input.nowMs;
        return 'seek';
      }
      this.lastTickWallMs = input.nowMs;
      return null;
    }

    if (this.lastTickWallMs !== null) {
      const rawDelta = Math.max(0, input.nowMs - this.lastTickWallMs);
      this.playingMsSinceLastSync += Math.min(rawDelta, BACKGROUND_SYNC_MAX_TICK_STEP_MS);
    }
    this.lastTickWallMs = input.nowMs;

    if (this.playingMsSinceLastSync >= this.intervalMs) {
      this.playingMsSinceLastSync = 0;
      this.pendingSeekSyncAtMs = null;
      this.seekOriginVideoMs = null;
      this.lastSeekWallMs = null;
      return 'periodic';
    }

    return null;
  }

  getPlayingMsSinceLastSync(): number {
    return this.playingMsSinceLastSync;
  }

  hasPendingSeekSync(): boolean {
    return this.pendingSeekSyncAtMs !== null;
  }
}
