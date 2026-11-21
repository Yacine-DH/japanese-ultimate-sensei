import type {
  ApiCallResponse,
  CardCreate,
  CardCreated,
  LineOut,
  MediaKind,
  MediaOut,
} from '../api/client';

export const MAX_SCREENSHOT_WIDTH = 640;
export const MIN_CAPTURE_MS = 400;
export const MAX_CAPTURE_MS = 12_000;

export const AUDIO_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
] as const;

export const CLIP_MIME_CANDIDATES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
] as const;

export interface ScaledSize {
  width: number;
  height: number;
}

export function computeScaledDimensions(
  sourceWidth: number,
  sourceHeight: number,
  maxWidth: number = MAX_SCREENSHOT_WIDTH,
): ScaledSize {
  const w = Math.max(1, Math.round(sourceWidth));
  const h = Math.max(1, Math.round(sourceHeight));
  if (w <= maxWidth) {
    return { width: w, height: h };
  }
  const scale = maxWidth / w;
  return {
    width: Math.round(maxWidth),
    height: Math.max(1, Math.round(h * scale)),
  };
}

export interface CropRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

export function computeVideoCropRect(
  videoRect: { left: number; top: number; width: number; height: number },
  devicePixelRatio: number,
  imageWidth: number,
  imageHeight: number,
): CropRect {
  const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
  const rawLeft = Math.round(videoRect.left * dpr);
  const rawTop = Math.round(videoRect.top * dpr);
  const rawW = Math.round(videoRect.width * dpr);
  const rawH = Math.round(videoRect.height * dpr);

  const sx = Math.max(0, Math.min(rawLeft, imageWidth - 1));
  const sy = Math.max(0, Math.min(rawTop, imageHeight - 1));
  const sw = Math.max(1, Math.min(rawW, imageWidth - sx));
  const sh = Math.max(1, Math.min(rawH, imageHeight - sy));
  return { sx, sy, sw, sh };
}

export interface CaptureWindow {
  startSec: number;
  endMs: number;
  durationMs: number;
}

export function computeCaptureWindow(
  line: Pick<LineOut, 'start_ms' | 'end_ms'>,
  subOffsetMs: number,
): CaptureWindow {
  const shiftedStartMs = Math.max(0, line.start_ms + subOffsetMs);
  const shiftedEndMs = Math.max(shiftedStartMs + MIN_CAPTURE_MS, line.end_ms + subOffsetMs);
  const rawDuration = shiftedEndMs - shiftedStartMs;
  const durationMs = Math.max(MIN_CAPTURE_MS, Math.min(MAX_CAPTURE_MS, Math.round(rawDuration)));
  return {
    startSec: shiftedStartMs / 1000,
    endMs: shiftedStartMs + durationMs,
    durationMs,
  };
}

export function pickRecorderMimeType(
  candidates: readonly string[],
  isTypeSupported?: (mime: string) => boolean,
): string {
  const check =
    isTypeSupported ??
    ((mime: string) =>
      typeof MediaRecorder !== 'undefined' &&
      typeof MediaRecorder.isTypeSupported === 'function' &&
      MediaRecorder.isTypeSupported(mime));

  for (const mime of candidates) {
    if (check(mime)) {
      return mime;
    }
  }
  return '';
}

export interface VideoWithCaptureStream {
  captureStream?: () => MediaStream;
  mozCaptureStream?: () => MediaStream;
}

export function getVideoCaptureStream(video: VideoWithCaptureStream): MediaStream | null {
  try {
    if (typeof video.captureStream === 'function') {
      return video.captureStream();
    }
    if (typeof video.mozCaptureStream === 'function') {
      return video.mozCaptureStream();
    }
  } catch {
    // DRM / cross-origin media may throw SecurityError
  }
  return null;
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export interface CapturedBlob {
  kind: MediaKind;
  blob: Blob;
  mimeType: string;
  filename: string;
}

export interface CapturedScreenshot extends CapturedBlob {
  kind: 'screenshot';
  thumbnailDataUrl: string;
  source: 'canvas' | 'tab-crop';
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), mimeType, quality);
    } catch {
      resolve(null);
    }
  });
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode tab screenshot'));
    img.src = dataUrl;
  });
}

export async function captureVideoScreenshot(
  video: HTMLVideoElement,
  captureVisibleTab: () => Promise<{ ok: boolean; dataUrl?: string; error?: string }>,
): Promise<CapturedScreenshot | null> {
  // 1. Try direct canvas drawImage (fast, exact video pixels for hls.js / MSE / same-origin)
  if (video.videoWidth > 0 && video.videoHeight > 0) {
    try {
      const { width, height } = computeScaledDimensions(video.videoWidth, video.videoHeight);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0, width, height);
        // Throws SecurityError immediately on tainted cross-origin media
        const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
        const blob =
          (await canvasToBlob(canvas, 'image/webp', 0.82)) ??
          (await canvasToBlob(canvas, 'image/jpeg', 0.85));
        if (blob) {
          const isWebp = blob.type === 'image/webp';
          return {
            kind: 'screenshot',
            blob,
            mimeType: blob.type || (isWebp ? 'image/webp' : 'image/jpeg'),
            filename: isWebp ? 'scene.webp' : 'scene.jpg',
            thumbnailDataUrl: dataUrl,
            source: 'canvas',
          };
        }
      }
    } catch {
      // Tainted canvas (SecurityError) — fall through to tabs.captureVisibleTab + crop
    }
  }

  // 2. Fallback: captureVisibleTab via background worker + crop to video rect
  const tabCapture = await captureVisibleTab();
  if (!tabCapture.ok || !tabCapture.dataUrl) {
    return null;
  }

  try {
    const img = await loadImage(tabCapture.dataUrl);
    const rect = video.getBoundingClientRect();
    const crop = computeVideoCropRect(
      rect,
      window.devicePixelRatio || 1,
      img.naturalWidth || img.width,
      img.naturalHeight || img.height,
    );
    const { width, height } = computeScaledDimensions(crop.sw, crop.sh);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, width, height);
    const thumb = canvas.toDataURL('image/jpeg', 0.8);
    const blob =
      (await canvasToBlob(canvas, 'image/webp', 0.82)) ??
      (await canvasToBlob(canvas, 'image/png'));
    if (!blob) return null;
    const isWebp = blob.type === 'image/webp';
    return {
      kind: 'screenshot',
      blob,
      mimeType: blob.type || (isWebp ? 'image/webp' : 'image/png'),
      filename: isWebp ? 'scene.webp' : 'scene.png',
      thumbnailDataUrl: thumb,
      source: 'tab-crop',
    };
  } catch {
    return null;
  }
}

export interface RecordedLineMedia {
  audio: CapturedBlob | null;
  clip: CapturedBlob | null;
}

function startRecorder(
  stream: MediaStream,
  mimeType: string,
): { recorder: MediaRecorder; stopAndCollect: () => Promise<Blob | null> } | null {
  if (typeof MediaRecorder === 'undefined') {
    return null;
  }
  try {
    const options: MediaRecorderOptions = mimeType ? { mimeType } : {};
    const recorder = new MediaRecorder(stream, options);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) {
        chunks.push(ev.data);
      }
    };
    const stopped = new Promise<Blob | null>((resolve) => {
      recorder.onstop = () => {
        if (chunks.length === 0) {
          resolve(null);
          return;
        }
        resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || 'video/webm' }));
      };
      recorder.onerror = () => resolve(null);
    });
    recorder.start();
    return {
      recorder,
      stopAndCollect: () => {
        if (recorder.state !== 'inactive') {
          try {
            recorder.stop();
          } catch {
            // Already stopped
          }
        }
        return stopped;
      },
    };
  } catch {
    return null;
  }
}

export async function recordLineMedia(
  video: HTMLVideoElement,
  line: Pick<LineOut, 'start_ms' | 'end_ms'>,
  subOffsetMs: number,
  hooks?: { onStart?: () => void; onEnd?: () => void },
): Promise<RecordedLineMedia> {
  const stream = getVideoCaptureStream(video as unknown as VideoWithCaptureStream);
  if (!stream) {
    return { audio: null, clip: null };
  }

  const audioTracks = stream.getAudioTracks();
  const videoTracks = stream.getVideoTracks();
  if (audioTracks.length === 0 && videoTracks.length === 0) {
    return { audio: null, clip: null };
  }

  const win = computeCaptureWindow(line, subOffsetMs);
  const wasPaused = video.paused;
  const originalTime = video.currentTime;
  const originalRate = video.playbackRate;

  hooks?.onStart?.();
  try {
    // Rewind to line start and wait briefly for seek
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          video.removeEventListener('seeked', done);
          resolve();
        }
      };
      video.addEventListener('seeked', done, { once: true });
      video.currentTime = win.startSec;
      setTimeout(done, 250);
    });

    const audioMime = pickRecorderMimeType(AUDIO_MIME_CANDIDATES);
    const clipMime = pickRecorderMimeType(CLIP_MIME_CANDIDATES);

    const audioRec =
      audioTracks.length > 0 && typeof MediaStream !== 'undefined'
        ? startRecorder(new MediaStream(audioTracks), audioMime)
        : null;
    const clipRec =
      videoTracks.length > 0 && typeof MediaStream !== 'undefined'
        ? startRecorder(new MediaStream(videoTracks), clipMime)
        : null;

    if (!audioRec && !clipRec) {
      return { audio: null, clip: null };
    }

    video.playbackRate = 1;
    await video.play().catch(() => {});

    // Record until line end or safety duration
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, win.durationMs + 80);

      const onTime = () => {
        if (video.currentTime * 1000 >= win.endMs || video.ended) {
          cleanup();
          resolve();
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        video.removeEventListener('timeupdate', onTime);
        video.removeEventListener('ended', onTime);
      };
      video.addEventListener('timeupdate', onTime);
      video.addEventListener('ended', onTime);
    });

    video.pause();

    const [audioBlob, clipBlob] = await Promise.all([
      audioRec ? audioRec.stopAndCollect() : Promise.resolve(null),
      clipRec ? clipRec.stopAndCollect() : Promise.resolve(null),
    ]);

    return {
      audio: audioBlob
        ? {
            kind: 'audio',
            blob: audioBlob,
            mimeType: audioBlob.type || 'audio/webm',
            filename: 'line-audio.webm',
          }
        : null,
      clip: clipBlob
        ? {
            kind: 'clip',
            blob: clipBlob,
            mimeType: clipBlob.type || 'video/webm',
            filename: 'line-clip.webm',
          }
        : null,
    };
  } finally {
    video.playbackRate = originalRate;
    video.currentTime = originalTime;
    if (wasPaused) {
      video.pause();
    } else {
      void video.play().catch(() => {});
    }
    hooks?.onEnd?.();
  }
}

export interface MediaUploader {
  uploadMedia(params: {
    kind: MediaKind;
    filename: string;
    mimeType: string;
    contentBase64: string;
  }): Promise<ApiCallResponse<MediaOut>>;
  createCard(payload: CardCreate): Promise<ApiCallResponse<CardCreated>>;
}

export interface SceneSaveResult {
  cardRes: ApiCallResponse<CardCreated>;
  mediaIds: number[];
  capturedKinds: MediaKind[];
  thumbnailDataUrl: string | null;
}

/**
 * Orchestrates screenshot + line audio/clip capture, uploads each piece via `POST /media`
 * (behind `uploader.uploadMedia`), then calls `POST /cards` with the returned `media_ids`.
 */
export async function saveWordWithSceneCapture(params: {
  wordId: number;
  line: Pick<LineOut, 'id' | 'start_ms' | 'end_ms' | 'text'> | null;
  captureScreenshot: () => Promise<CapturedScreenshot | null>;
  captureLineMedia: () => Promise<RecordedLineMedia>;
  uploader: MediaUploader;
  encodeBlob?: (blob: Blob) => Promise<string>;
}): Promise<SceneSaveResult> {
  const encode = params.encodeBlob ?? blobToBase64;

  const screenshot = await params.captureScreenshot().catch(() => null);
  const recorded = params.line
    ? await params.captureLineMedia().catch(() => ({ audio: null, clip: null }))
    : { audio: null, clip: null };

  const pieces: CapturedBlob[] = [];
  if (screenshot) pieces.push(screenshot);
  if (recorded.audio) pieces.push(recorded.audio);
  if (recorded.clip) pieces.push(recorded.clip);

  const mediaIds: number[] = [];
  const capturedKinds: MediaKind[] = [];

  for (const piece of pieces) {
    try {
      const contentBase64 = await encode(piece.blob);
      const res = await params.uploader.uploadMedia({
        kind: piece.kind,
        filename: piece.filename,
        mimeType: piece.mimeType,
        contentBase64,
      });
      if (res.ok && res.data) {
        mediaIds.push(res.data.id);
        capturedKinds.push(piece.kind);
      }
    } catch {
      // Never block card creation if an optional media upload fails
    }
  }

  const cardRes = await params.uploader.createCard({
    word_id: params.wordId,
    line_id: params.line?.id ?? null,
    media_ids: mediaIds,
    sentence: params.line?.text ?? null,
  });

  return {
    cardRes,
    mediaIds,
    capturedKinds,
    thumbnailDataUrl: screenshot?.thumbnailDataUrl ?? null,
  };
}
