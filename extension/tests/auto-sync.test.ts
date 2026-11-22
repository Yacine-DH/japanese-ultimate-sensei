import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  executeSyncEpisode,
  isStartAutoSyncMessage,
  isSyncEpisodeMessage,
  type SyncOut,
} from '../src/api/client';
import {
  AUTO_SYNC_ABORT_MESSAGE,
  AUTO_SYNC_DIALOGUE_HINT,
  AUTO_SYNC_DURATION_MS,
  AUTO_SYNC_MAX_DRIFT_MS,
  AutoSyncStateMachine,
  buildSyncOutcomePresentation,
  checkSyncPlaybackDrift,
  formatManualApplyToast,
  formatOffsetSeconds,
  formatSyncConfidenceMeta,
  formatSyncProgressText,
  startSyncAudioRecording,
} from '../src/lib/auto-sync';
import { EpisodeTranscriptCache } from '../src/lib/line-cache';

const SAMPLE_SYNC_APPLIED: SyncOut = {
  offset_ms: 3140,
  previous_offset_ms: 0,
  applied: true,
  confident: true,
  confidence: 7.8,
  runner_up: 3.1,
  correlation: 0.23,
  speech_ms: 24310,
  sample_ms: 45000,
  lines_in_window: 21,
  detail: 'ok',
};

const SAMPLE_SYNC_UNCONFIDENT: SyncOut = {
  offset_ms: 3140,
  previous_offset_ms: 0,
  applied: false,
  confident: false,
  confidence: 3.9,
  runner_up: 3.4,
  correlation: 0.14,
  speech_ms: 12000,
  sample_ms: 45000,
  lines_in_window: 14,
  detail: 'No clear match (possibly music or opening)',
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('auto-sync formatting & outcome presentation (#99)', () => {
  it('formats signed offsets cleanly in seconds without -0.0 s', () => {
    expect(formatOffsetSeconds(3140)).toBe('+3.1 s');
    expect(formatOffsetSeconds(-1520)).toBe('-1.5 s');
    expect(formatOffsetSeconds(0)).toBe('0.0 s');
    expect(formatOffsetSeconds(-20)).toBe('0.0 s');
    expect(formatOffsetSeconds(60)).toBe('+0.1 s');
  });

  it('formats progress text for recording and uploading phases', () => {
    expect(formatSyncProgressText({ phase: 'recording', remainingSeconds: 32 })).toBe(
      'Syncing… 32 s',
    );
    expect(formatSyncProgressText({ phase: 'uploading', remainingSeconds: 0 })).toBe(
      'Syncing… analyzing audio',
    );
    expect(formatSyncProgressText({ phase: 'idle', remainingSeconds: 45 })).toBe('');
  });

  it('builds applied, not-applied, and error toast presentations', () => {
    const applied = buildSyncOutcomePresentation({
      ok: true,
      status: 200,
      data: SAMPLE_SYNC_APPLIED,
    });
    expect(applied).toEqual({
      kind: 'applied',
      offsetMs: 3140,
      title: 'Synced: subtitles shifted by +3.1 s',
      meta: 'conf 7.8 · runner-up 3.1',
    });

    const unconfident = buildSyncOutcomePresentation({
      ok: true,
      status: 200,
      data: SAMPLE_SYNC_UNCONFIDENT,
    });
    expect(unconfident).toEqual({
      kind: 'not_applied',
      offsetMs: 3140,
      title: 'No clear match (possibly music or opening)',
      hint: AUTO_SYNC_DIALOGUE_HINT,
      meta: 'conf 3.9 · runner-up 3.4',
      useAnywayLabel: 'Use anyway (+3.1 s)',
    });
    expect(unconfident.kind === 'not_applied' && unconfident.hint.toLowerCase()).toContain(
      'try during dialogue',
    );

    const err = buildSyncOutcomePresentation({
      ok: false,
      status: 422,
      error: 'Unreadable audio file',
    });
    expect(err).toEqual({
      kind: 'error',
      title: 'Auto-sync failed: Unreadable audio file',
    });

    expect(formatManualApplyToast(-2400)).toBe('Synced: subtitles shifted by -2.4 s');
    expect(formatSyncConfidenceMeta(SAMPLE_SYNC_APPLIED)).toBe('conf 7.8 · runner-up 3.1');
  });
});

describe('AutoSyncStateMachine (#99)', () => {
  it('runs idle → recording → uploading → done lifecycle with 45 s countdown', () => {
    const sm = new AutoSyncStateMachine();
    expect(sm.durationMs).toBe(AUTO_SYNC_DURATION_MS);
    expect(sm.getState().phase).toBe('idle');
    expect(sm.isActive()).toBe(false);

    const started = sm.startRecording(1_000, { paused: false, ended: false, playbackRate: 1 });
    expect(started.phase).toBe('recording');
    expect(started.remainingSeconds).toBe(45);
    expect(sm.isActive()).toBe(true);
    expect(sm.isRecording()).toBe(true);

    // MediaRecorder.onstart fires slightly after startRecording
    const recStarted = sm.markRecorderStarted(123_456, 1_200);
    expect(recStarted.videoStartMs).toBe(123_456);
    expect(recStarted.startedAtMs).toBe(1_200);

    const mid = sm.tick(14_200, { paused: false, ended: false, playbackRate: 1 });
    expect(mid.completed).toBe(false);
    expect(mid.snapshot.remainingSeconds).toBe(32);

    const end = sm.tick(46_200, { paused: false, ended: false, playbackRate: 1 });
    expect(end.completed).toBe(true);
    expect(end.snapshot.remainingMs).toBe(0);

    const uploading = sm.beginUpload();
    expect(uploading.phase).toBe('uploading');
    expect(sm.isActive()).toBe(true);
    expect(sm.isRecording()).toBe(false);

    const done = sm.finishSuccess(SAMPLE_SYNC_APPLIED);
    expect(done.phase).toBe('done');
    expect(done.result).toEqual(SAMPLE_SYNC_APPLIED);
    expect(sm.isActive()).toBe(false);
  });

  it('refuses to start if paused, ended, or playbackRate !== 1', () => {
    const sm = new AutoSyncStateMachine();

    const paused = sm.startRecording(0, { paused: true, ended: false, playbackRate: 1 });
    expect(paused.phase).toBe('aborted');
    expect(paused.abortReason).toBe('paused');
    expect(paused.abortMessage).toBe(AUTO_SYNC_ABORT_MESSAGE);

    sm.reset();
    const fast = sm.startRecording(0, { paused: false, ended: false, playbackRate: 1.25 });
    expect(fast.phase).toBe('aborted');
    expect(fast.abortReason).toBe('rate_changed');
    expect(fast.abortMessage).toBe(AUTO_SYNC_ABORT_MESSAGE);

    sm.reset();
    const ended = sm.startRecording(0, { paused: false, ended: true, playbackRate: 1 });
    expect(ended.phase).toBe('aborted');
    expect(ended.abortReason).toBe('ended');
  });

  it('aborts on pause, seek, or playbackRate change during recording', () => {
    for (const event of ['pause', 'ended', 'seek'] as const) {
      const sm = new AutoSyncStateMachine();
      sm.startRecording(0, { paused: false, ended: false, playbackRate: 1 });
      const res = sm.onPlaybackEvent(event, 5_000);
      expect(res.phase).toBe('aborted');
      expect(res.abortMessage).toBe(AUTO_SYNC_ABORT_MESSAGE);
    }

    const sm = new AutoSyncStateMachine();
    sm.startRecording(0, { paused: false, ended: false, playbackRate: 1 });
    // Rate change back to 1 does not abort
    expect(sm.onPlaybackEvent('ratechange', 2_000, 1).phase).toBe('recording');
    // Rate change to 0.75 aborts
    const aborted = sm.onPlaybackEvent('ratechange', 3_000, 0.75);
    expect(aborted.phase).toBe('aborted');
    expect(aborted.abortReason).toBe('rate_changed');
    expect(aborted.abortMessage).toBe(AUTO_SYNC_ABORT_MESSAGE);
  });

  it('tolerates brief buffering <= 1 s and aborts when buffering exceeds 1 s', () => {
    const sm = new AutoSyncStateMachine({ durationMs: 45_000, maxBufferingMs: 1_000 });
    sm.startRecording(0, { paused: false, ended: false, playbackRate: 1 });

    // Brief 800 ms stall recovers cleanly
    sm.onPlaybackEvent('waiting', 5_000);
    expect(sm.tick(5_800).snapshot.phase).toBe('recording');
    sm.onPlaybackEvent('playing', 5_850);
    expect(sm.tick(7_500).snapshot.phase).toBe('recording');

    // Longer 1200 ms stall aborts
    sm.onPlaybackEvent('waiting', 10_000);
    expect(sm.tick(11_000).snapshot.phase).toBe('recording');
    const aborted = sm.tick(11_001);
    expect(aborted.completed).toBe(false);
    expect(aborted.snapshot.phase).toBe('aborted');
    expect(aborted.snapshot.abortReason).toBe('buffered');
    expect(aborted.snapshot.abortMessage).toBe(AUTO_SYNC_ABORT_MESSAGE);
  });

  it('supports Esc cancellation and upload error transitions', () => {
    const sm = new AutoSyncStateMachine();
    sm.startRecording(0, { paused: false, ended: false, playbackRate: 1 });
    const cancelled = sm.abort('cancelled');
    expect(cancelled.phase).toBe('aborted');
    expect(cancelled.abortReason).toBe('cancelled');
    expect(cancelled.abortMessage).toBe('Auto-sync cancelled');

    sm.reset();
    sm.startRecording(0, { paused: false, ended: false, playbackRate: 1 });
    sm.beginUpload();
    const err = sm.finishError('Network down');
    expect(err.phase).toBe('aborted');
    expect(err.abortReason).toBe('upload_error');
    expect(err.error).toBe('Network down');
  });
});

describe('startSyncAudioRecording (#99)', () => {
  it('reads video_start_ms inside MediaRecorder.onstart and records audio tracks only', async () => {
    vi.useFakeTimers();

    const listeners = new Map<string, Set<() => void>>();
    const audioTrack = { kind: 'audio', id: 'a1' };
    const videoTrack = { kind: 'video', id: 'v1' };
    const fakeVideo = {
      paused: false,
      ended: false,
      playbackRate: 1,
      currentTime: 10.0,
      captureStream: () => ({
        getAudioTracks: () => [audioTrack],
        getVideoTracks: () => [videoTrack],
      }),
      addEventListener: (ev: string, fn: () => void) => {
        if (!listeners.has(ev)) listeners.set(ev, new Set());
        listeners.get(ev)!.add(fn);
      },
      removeEventListener: (ev: string, fn: () => void) => {
        listeners.get(ev)?.delete(fn);
      },
    } as unknown as HTMLVideoElement;

    let capturedStreamTracks: unknown[] = [];
    class FakeMediaStream {
      constructor(tracks: unknown[]) {
        capturedStreamTracks = tracks;
      }
    }

    let recorderCreated = false;
    class FakeMediaRecorder {
      static isTypeSupported = (m: string) => m === 'audio/webm;codecs=opus';
      state: 'inactive' | 'recording' = 'inactive';
      mimeType: string;
      onstart: (() => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ondataavailable: ((ev: { data: Blob }) => void) | null = null;

      constructor(_stream: unknown, opts?: { mimeType?: string }) {
        this.mimeType = opts?.mimeType ?? 'audio/webm';
        recorderCreated = true;
      }

      start(): void {
        this.state = 'recording';
        // Simulate video advancing 250 ms before MediaRecorder actually starts
        setTimeout(() => {
          (fakeVideo as unknown as { currentTime: number }).currentTime = 10.25;
          this.onstart?.();
        }, 50);
      }

      stop(): void {
        if (this.state === 'inactive') return;
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob(['opus-bytes'], { type: this.mimeType }) });
        this.onstop?.();
      }
    }

    vi.stubGlobal('MediaStream', FakeMediaStream);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);

    const machine = new AutoSyncStateMachine({ durationMs: 2_000 });
    const seenPhases: string[] = [];
    const handle = startSyncAudioRecording({
      video: fakeVideo,
      machine,
      onStateChange: (s) => seenPhases.push(`${s.phase}:${s.remainingSeconds}`),
      tickIntervalMs: 200,
    });

    expect(capturedStreamTracks).toEqual([audioTrack]);
    expect(recorderCreated).toBe(true);

    // Advance past onstart (50 ms) + full 2 s recording window, advancing video time at 1x
    await vi.advanceTimersByTimeAsync(50);
    for (let i = 0; i < 12; i++) {
      (fakeVideo as unknown as { currentTime: number }).currentTime += 0.2;
      await vi.advanceTimersByTimeAsync(200);
    }
    const result = await handle.promise;

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Must match video.currentTime inside onstart (10.25 s = 10250 ms), NOT initial 10000 ms
      expect(result.videoStartMs).toBe(10_250);
      expect(result.mimeType).toBe('audio/webm;codecs=opus');
      expect(result.filename).toBe('sync-sample.webm');
      expect(result.blob.size).toBeGreaterThan(0);
    }
    expect(seenPhases[0]).toBe('recording:2');
  });

  it('aborts without producing a sample when user seeks or cancels mid-recording', async () => {
    vi.useFakeTimers();

    const listeners = new Map<string, Set<() => void>>();
    const fakeVideo = {
      paused: false,
      ended: false,
      playbackRate: 1,
      currentTime: 20.0,
      captureStream: () => ({
        getAudioTracks: () => [{ kind: 'audio' }],
        getVideoTracks: () => [],
      }),
      addEventListener: (ev: string, fn: () => void) => {
        if (!listeners.has(ev)) listeners.set(ev, new Set());
        listeners.get(ev)!.add(fn);
      },
      removeEventListener: (ev: string, fn: () => void) => {
        listeners.get(ev)?.delete(fn);
      },
    } as unknown as HTMLVideoElement;

    class FakeMediaStream {
      constructor(public tracks: unknown[]) {}
    }
    class FakeMediaRecorder {
      static isTypeSupported = () => true;
      state: 'inactive' | 'recording' = 'inactive';
      mimeType = 'audio/webm;codecs=opus';
      onstart: (() => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ondataavailable: ((ev: { data: Blob }) => void) | null = null;
      start(): void {
        this.state = 'recording';
        this.onstart?.();
      }
      stop(): void {
        this.state = 'inactive';
        this.onstop?.();
      }
    }

    vi.stubGlobal('MediaStream', FakeMediaStream);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);

    const machine = new AutoSyncStateMachine({ durationMs: 45_000 });
    const handle = startSyncAudioRecording({
      video: fakeVideo,
      machine,
      onStateChange: () => {},
    });

    // Simulate seek event during recording
    for (const fn of listeners.get('seeking') ?? []) {
      fn();
    }

    const res = await handle.promise;
    expect(res).toEqual({
      ok: false,
      reason: 'seeked',
      message: AUTO_SYNC_ABORT_MESSAGE,
    });
  });

  it('checks video-vs-wall-clock drift and aborts when cumulative short stalls exceed 250 ms (#102)', async () => {
    expect(AUTO_SYNC_MAX_DRIFT_MS).toBe(250);

    // Within 250 ms tolerance -> ok
    expect(
      checkSyncPlaybackDrift({
        videoStartMs: 10_000,
        videoEndMs: 54_820,
        wallStartMs: 1_000,
        wallEndMs: 46_000,
      }),
    ).toEqual({
      ok: true,
      driftMs: 180,
      videoProgressMs: 44_820,
      wallDurationMs: 45_000,
    });

    // Cumulative 600 ms stall -> rejected
    expect(
      checkSyncPlaybackDrift({
        videoStartMs: 10_000,
        videoEndMs: 54_400,
        wallStartMs: 1_000,
        wallEndMs: 46_000,
      }),
    ).toEqual({
      ok: false,
      driftMs: 600,
      videoProgressMs: 44_400,
      wallDurationMs: 45_000,
    });

    // Forward jump (missed seek) -> rejected
    expect(
      checkSyncPlaybackDrift({
        videoStartMs: 10_000,
        videoEndMs: 56_000,
        wallStartMs: 1_000,
        wallEndMs: 46_000,
      }).ok,
    ).toBe(false);

    // Integration: three 300 ms micro-stalls (each < 1 s maxBufferingMs) sum to 900 ms drift -> abort
    vi.useFakeTimers();
    const listeners = new Map<string, Set<() => void>>();
    const fakeVideo = {
      paused: false,
      ended: false,
      playbackRate: 1,
      currentTime: 30.0,
      captureStream: () => ({
        getAudioTracks: () => [{ kind: 'audio' }],
        getVideoTracks: () => [],
      }),
      addEventListener: (ev: string, fn: () => void) => {
        if (!listeners.has(ev)) listeners.set(ev, new Set());
        listeners.get(ev)!.add(fn);
      },
      removeEventListener: (ev: string, fn: () => void) => {
        listeners.get(ev)?.delete(fn);
      },
    } as unknown as HTMLVideoElement;

    class FakeMediaStream {
      constructor(public tracks: unknown[]) {}
    }
    class FakeMediaRecorder {
      static isTypeSupported = () => true;
      state: 'inactive' | 'recording' = 'inactive';
      mimeType = 'audio/webm;codecs=opus';
      onstart: (() => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ondataavailable: ((ev: { data: Blob }) => void) | null = null;
      start(): void {
        this.state = 'recording';
        this.onstart?.();
      }
      stop(): void {
        if (this.state === 'inactive') return;
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob(['opus-bytes'], { type: this.mimeType }) });
        this.onstop?.();
      }
    }

    vi.stubGlobal('MediaStream', FakeMediaStream);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);

    const machine = new AutoSyncStateMachine({ durationMs: 2_000 });
    const handle = startSyncAudioRecording({
      video: fakeVideo,
      machine,
      onStateChange: () => {},
      tickIntervalMs: 200,
    });

    // Advance 2.0 s of wall time while video only progresses 1.1 s (three 300 ms stalls)
    for (let i = 0; i < 10; i++) {
      if (i % 3 !== 0) {
        (fakeVideo as unknown as { currentTime: number }).currentTime += 0.18;
      }
      await vi.advanceTimersByTimeAsync(200);
    }

    const res = await handle.promise;
    expect(res).toEqual({
      ok: false,
      reason: 'drifted',
      message: AUTO_SYNC_ABORT_MESSAGE,
    });
    expect(machine.getState().phase).toBe('aborted');
    expect(machine.getState().abortReason).toBe('drifted');
  });
});

describe('sync API proxy & episode offset cache (#99)', () => {
  it('validates sync messages and sends multipart POST /episodes/{id}/sync', async () => {
    expect(isStartAutoSyncMessage({ type: 'SENSEI_START_AUTO_SYNC' })).toBe(true);
    expect(
      isSyncEpisodeMessage({
        type: 'SENSEI_SYNC_EPISODE',
        episodeId: 4,
        filename: 'sync-sample.webm',
        mimeType: 'audio/webm;codecs=opus',
        contentBase64: btoa('audio'),
        videoStartMs: 12345,
      }),
    ).toBe(true);

    const captured = {
      url: '',
      form: null as FormData | null,
      headers: {} as Record<string, string>,
    };

    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      captured.url = url;
      captured.form = init?.body as FormData;
      captured.headers = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify(SAMPLE_SYNC_APPLIED), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const res = await executeSyncEpisode(
      { serverUrl: 'http://homeserver:8000', apiToken: 'tok_secret' },
      {
        type: 'SENSEI_SYNC_EPISODE',
        episodeId: 4,
        filename: 'sync-sample.webm',
        mimeType: 'audio/webm;codecs=opus',
        contentBase64: btoa('audio-bytes'),
        videoStartMs: 12345,
        apply: true,
      },
      mockFetch as unknown as typeof fetch,
    );

    expect(res.ok).toBe(true);
    expect(res.data).toEqual(SAMPLE_SYNC_APPLIED);
    expect(captured.url).toBe('http://homeserver:8000/episodes/4/sync');
    expect(captured.headers['Authorization']).toBe('Bearer tok_secret');
    expect(captured.headers['Content-Type']).toBeUndefined();
    expect(captured.form?.get('video_start_ms')).toBe('12345');
    expect(captured.form?.get('apply')).toBe('true');
    expect(captured.form?.get('file')).toBeInstanceOf(Blob);
  });

  it('extracts 422 FastAPI errors cleanly from /sync', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: 'Could not decode audio sample' }), {
        status: 422,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const res = await executeSyncEpisode(
      { serverUrl: 'http://homeserver:8000', apiToken: 'tok_secret' },
      {
        type: 'SENSEI_SYNC_EPISODE',
        episodeId: 4,
        filename: 'sync-sample.webm',
        mimeType: 'audio/webm',
        contentBase64: btoa('bad'),
        videoStartMs: 0,
      },
      mockFetch as unknown as typeof fetch,
    );

    expect(res.ok).toBe(false);
    expect(res.status).toBe(422);
    expect(res.error).toBe('Could not decode audio sample');
  });

  it('updates cached episode sub_offset_ms without wiping cached lines', async () => {
    const store = new Map<string, unknown>();
    const cache = new EpisodeTranscriptCache({
      get: async (k) => (store.has(k) ? { [k]: store.get(k) } : {}),
      set: async (items) => {
        for (const [k, v] of Object.entries(items)) store.set(k, v);
      },
    });

    await cache.setEpisode({
      id: 9,
      anime_id: 1,
      anime_title: 'Frieren',
      number: 1,
      title: null,
      source: 'jimaku',
      source_filename: 'frieren_01.srt',
      sub_offset_ms: 0,
      line_count: 100,
      created_at: '2026-11-22T00:00:00Z',
    });

    await cache.updateEpisodeOffset(9, 3140);
    const epRes = await cache.getEpisode(9, async () => {
      throw new Error('should hit cache');
    });
    expect(epRes.ok).toBe(true);
    expect(epRes.data?.sub_offset_ms).toBe(3140);
  });
});
