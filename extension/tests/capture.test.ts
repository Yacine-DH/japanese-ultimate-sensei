import { describe, expect, it, vi } from 'vitest';
import {
  AUDIO_MIME_CANDIDATES,
  CLIP_MIME_CANDIDATES,
  computeCaptureWindow,
  computeScaledDimensions,
  computeVideoCropRect,
  getVideoCaptureStream,
  pickRecorderMimeType,
  saveWordWithSceneCapture,
} from '../src/lib/capture';

describe('scene capture pure logic (E-5, #21)', () => {
  it('scales screenshots down to maxWidth without upscaling', () => {
    expect(computeScaledDimensions(1920, 1080, 640)).toEqual({ width: 640, height: 360 });
    expect(computeScaledDimensions(480, 270, 640)).toEqual({ width: 480, height: 270 });
  });

  it('computes DPR-aware clamped crop rectangles for captureVisibleTab fallback', () => {
    const crop = computeVideoCropRect(
      { left: 100, top: 50, width: 640, height: 360 },
      2,
      1920,
      1080,
    );
    expect(crop).toEqual({ sx: 200, sy: 100, sw: 1280, sh: 720 });

    // Clamps when video extends outside viewport bounds
    const clamped = computeVideoCropRect(
      { left: -50, top: 900, width: 800, height: 500 },
      1,
      1000,
      1000,
    );
    expect(clamped).toEqual({ sx: 0, sy: 900, sw: 800, sh: 100 });
  });

  it('computes clamped capture window using line start/end + subOffsetMs', () => {
    expect(computeCaptureWindow({ start_ms: 1000, end_ms: 3500 }, 200)).toEqual({
      startSec: 1.2,
      endMs: 3700,
      durationMs: 2500,
    });
    // Very short line clamps to MIN_CAPTURE_MS (400)
    expect(computeCaptureWindow({ start_ms: 5000, end_ms: 5100 }, 0).durationMs).toBe(400);
    // Excessively long line clamps to MAX_CAPTURE_MS (12000)
    expect(computeCaptureWindow({ start_ms: 1000, end_ms: 50_000 }, 0).durationMs).toBe(12_000);
  });

  it('picks best supported MediaRecorder mime types and supports Chrome + Firefox captureStream', () => {
    expect(
      pickRecorderMimeType(AUDIO_MIME_CANDIDATES, (m) => m === 'audio/webm'),
    ).toBe('audio/webm');
    expect(
      pickRecorderMimeType(CLIP_MIME_CANDIDATES, (m) => m === 'video/webm;codecs=vp8'),
    ).toBe('video/webm;codecs=vp8');
    expect(pickRecorderMimeType(AUDIO_MIME_CANDIDATES, () => false)).toBe('');

    const fakeStream = {} as MediaStream;
    expect(getVideoCaptureStream({ captureStream: () => fakeStream })).toBe(fakeStream);
    expect(getVideoCaptureStream({ mozCaptureStream: () => fakeStream })).toBe(fakeStream);
    expect(
      getVideoCaptureStream({
        captureStream: () => {
          throw new Error('SecurityError');
        },
      }),
    ).toBeNull();
  });

  it('uploads screenshot, line audio, and clip to POST /media and creates card with media_ids', async () => {
    const uploadMedia = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        data: { id: 101, kind: 'screenshot', mime: 'image/webp', url: '/media/101?sig=a', bytes: 30000, ready: true },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        data: { id: 102, kind: 'audio', mime: 'audio/ogg', url: '/media/102?sig=b', bytes: 18000, ready: true },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        data: { id: 103, kind: 'clip', mime: 'video/webm', url: '/media/103?sig=c', bytes: 200000, ready: false },
      });

    const createCard = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      data: {
        id: 7,
        word_id: 42,
        line_id: 10,
        sentence: '何か食べたい',
        state: 'learning',
        due: '2026-11-21T13:30:00Z',
        stability: null,
        difficulty: null,
        reps: 0,
        created_at: '2026-11-21T13:25:00Z',
        created: true,
      },
    });

    const result = await saveWordWithSceneCapture({
      wordId: 42,
      line: { id: 10, start_ms: 1000, end_ms: 3500, text: '何か食べたい' },
      captureScreenshot: async () => ({
        kind: 'screenshot',
        blob: new Blob(['img'], { type: 'image/webp' }),
        mimeType: 'image/webp',
        filename: 'scene.webp',
        thumbnailDataUrl: 'data:image/jpeg;base64,AAA',
        source: 'canvas',
      }),
      captureLineMedia: async () => ({
        audio: {
          kind: 'audio',
          blob: new Blob(['aud'], { type: 'audio/webm' }),
          mimeType: 'audio/webm',
          filename: 'line-audio.webm',
        },
        clip: {
          kind: 'clip',
          blob: new Blob(['vid'], { type: 'video/webm' }),
          mimeType: 'video/webm',
          filename: 'line-clip.webm',
        },
      }),
      uploader: { uploadMedia, createCard },
      encodeBlob: async () => 'ZmFrZQ==',
    });

    expect(result.cardRes.ok).toBe(true);
    expect(result.mediaIds).toEqual([101, 102, 103]);
    expect(result.capturedKinds).toEqual(['screenshot', 'audio', 'clip']);
    expect(result.thumbnailDataUrl).toBe('data:image/jpeg;base64,AAA');
    expect(createCard).toHaveBeenCalledWith({
      word_id: 42,
      line_id: 10,
      media_ids: [101, 102, 103],
      sentence: '何か食べたい',
    });
  });

  it('still creates the card gracefully when media upload fails or capture is unavailable', async () => {
    const uploadMedia = vi.fn().mockResolvedValue({ ok: false, status: 503, error: 'no ffmpeg' });
    const createCard = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      data: { id: 8, word_id: 42, created: true },
    });

    const result = await saveWordWithSceneCapture({
      wordId: 42,
      line: { id: 10, start_ms: 1000, end_ms: 2000, text: '魔法' },
      captureScreenshot: async () => ({
        kind: 'screenshot',
        blob: new Blob(['img'], { type: 'image/png' }),
        mimeType: 'image/png',
        filename: 'scene.png',
        thumbnailDataUrl: 'data:image/jpeg;base64,BBB',
        source: 'tab-crop',
      }),
      captureLineMedia: async () => ({ audio: null, clip: null }),
      uploader: { uploadMedia, createCard },
      encodeBlob: async () => 'ZmFrZQ==',
    });

    expect(result.cardRes.ok).toBe(true);
    expect(result.mediaIds).toEqual([]);
    expect(createCard).toHaveBeenCalledWith({
      word_id: 42,
      line_id: 10,
      media_ids: [],
      sentence: '魔法',
    });
  });
});
