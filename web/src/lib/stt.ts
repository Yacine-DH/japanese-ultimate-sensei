import type { SttJobOut, SttStatus } from '../api/client';

export type SttJobStatus = SttJobOut['status'];

export const STT_POLL_INTERVAL_MS = 5_000;

export const STT_ACCEPT_ATTR =
  'video/*,audio/*,.mkv,.mp4,.webm,.mov,.avi,.m4v,.mp3,.wav,.flac,.ogg,.m4a,.opus';

export const STT_PIPELINE_STEPS = [
  'queued',
  'extracting',
  'transcribing',
  'importing',
  'done',
] as const;

export type SttPipelineStep = (typeof STT_PIPELINE_STEPS)[number];

export const STT_STEP_LABELS: Record<SttJobStatus, string> = {
  queued: 'Queued',
  extracting: 'Extracting audio',
  transcribing: 'Transcribing',
  importing: 'Importing',
  done: 'Done',
  error: 'Error',
};

export function isSttJobTerminal(status: SttJobStatus): boolean {
  return status === 'done' || status === 'error';
}

export function isSttJobActive(job: Pick<SttJobOut, 'status'> | null | undefined): boolean {
  return Boolean(job && !isSttJobTerminal(job.status));
}

export function getSttJobPollInterval(
  job: Pick<SttJobOut, 'status'> | null | undefined,
  pollMs = STT_POLL_INTERVAL_MS,
): number | false {
  return isSttJobActive(job) ? pollMs : false;
}

export function getSttListPollInterval(
  jobs: readonly Pick<SttJobOut, 'status'>[] | undefined,
  pollMs = STT_POLL_INTERVAL_MS,
): number | false {
  if (!jobs || jobs.length === 0) return false;
  return jobs.some((job) => isSttJobActive(job)) ? pollMs : false;
}

export function getSttStepIndex(status: SttJobStatus): number {
  const idx = (STT_PIPELINE_STEPS as readonly string[]).indexOf(status);
  return idx;
}

export type SttStepVisualState = 'done' | 'active' | 'pending' | 'error';

export function getSttStepVisualState(
  step: SttPipelineStep,
  currentStatus: SttJobStatus,
): SttStepVisualState {
  if (currentStatus === 'error') {
    return step === 'queued' ? 'error' : 'pending';
  }
  const stepIdx = getSttStepIndex(step);
  const currentIdx = getSttStepIndex(currentStatus);
  if (currentStatus === 'done') {
    return 'done';
  }
  if (stepIdx < currentIdx) return 'done';
  if (stepIdx === currentIdx) return 'active';
  return 'pending';
}

export function computeSttElapsedMs(
  job: Pick<SttJobOut, 'created_at' | 'started_at' | 'finished_at'>,
  nowMs: number,
): number | null {
  const startIso = job.started_at ?? job.created_at;
  const startMs = Date.parse(startIso);
  if (!Number.isFinite(startMs)) return null;
  const endMs = job.finished_at ? Date.parse(job.finished_at) : nowMs;
  if (!Number.isFinite(endMs)) return null;
  return Math.max(0, endMs - startMs);
}

export function formatSttDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) {
    return '';
  }
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${minutes}:${pad(seconds)}`;
}

export function formatSttElapsedSummary(
  job: Pick<SttJobOut, 'status' | 'created_at' | 'started_at' | 'finished_at' | 'duration_ms'>,
  nowMs: number,
): string {
  const elapsedMs = computeSttElapsedMs(job, nowMs);
  const elapsedText = elapsedMs !== null ? formatSttDurationMs(elapsedMs) : '';
  const durationText = formatSttDurationMs(job.duration_ms);
  const parts: string[] = [];

  if (elapsedText) {
    if (job.status === 'done') {
      parts.push(`Finished in ${elapsedText}`);
    } else if (job.status === 'error') {
      parts.push(`Failed after ${elapsedText}`);
    } else {
      parts.push(`Elapsed ${elapsedText}`);
    }
  }

  if (durationText) {
    parts.push(`audio ${durationText}`);
  }

  return parts.join(' · ');
}

export function formatTransferBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export interface SttAvailability {
  available: boolean;
  configured: boolean;
  reachable: boolean;
  headline: string;
  hint: string;
}

export function describeSttAvailability(
  status: SttStatus | null | undefined,
  isError = false,
): SttAvailability {
  if (isError) {
    return {
      available: false,
      configured: false,
      reachable: false,
      headline: 'Could not check speech-to-text status.',
      hint: 'Check your server connection and ensure whisper-server is running on the laptop.',
    };
  }
  if (!status) {
    return {
      available: false,
      configured: false,
      reachable: false,
      headline: 'Checking speech-to-text server…',
      hint: '',
    };
  }
  if (!status.configured) {
    return {
      available: false,
      configured: false,
      reachable: false,
      headline: 'Speech-to-text is not configured on the server.',
      hint: 'Set SENSEI_STT_BASE_URL on the server and start whisper-server on the laptop.',
    };
  }
  if (!status.reachable) {
    return {
      available: false,
      configured: true,
      reachable: false,
      headline: status.detail
        ? `Speech-to-text server unreachable (${status.detail}).`
        : 'Speech-to-text server is unreachable.',
      hint: 'Start whisper-server on the laptop.',
    };
  }
  return {
    available: true,
    configured: true,
    reachable: true,
    headline: status.model ? `STT ready (${status.model})` : 'STT ready',
    hint: '',
  };
}

/**
 * Extracts a clean anime title and episode number from a local video/audio filename
 * (e.g. `[SubsPlease] Sousou no Frieren - 02 (1080p) [F02B9CEE].mkv`).
 */
export function parseEpisodeMetadataFromFilename(filename: string): {
  animeTitle: string;
  episodeNumber: string;
} {
  const withoutExt = filename.replace(/\.[^./\\]+$/, '').trim();
  if (!withoutExt) {
    return { animeTitle: '', episodeNumber: '' };
  }

  // Strip release group tags `[...]` and quality parens `(...)`
  let cleaned = withoutExt
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Replace dots when filename is dot-separated (e.g. `Dungeon.Meshi.S01E07.1080p`)
  if (!cleaned.includes(' ') && cleaned.includes('.')) {
    cleaned = cleaned.replace(/\.+/g, ' ').trim();
  }

  let episodeNumber = '';
  let titlePart = cleaned;

  const patterns: RegExp[] = [
    // S01E07 / S1E12.5
    /\bS\d{1,2}\s*E(\d{1,4}(?:\.\d+)?)(?:v\d+)?\b/i,
    // Episode 07 / Ep. 7 / Ep07
    /\b(?:episode|ep\.?)\s*(\d{1,4}(?:\.\d+)?)(?:v\d+)?\b/i,
    // `Title - 02` (classic anime fansub separator)
    /\s[-–—]\s*(\d{1,4}(?:\.\d+)?)(?:v\d+)?(?:\s|$)/,
    // Trailing standalone episode number `Title 05`
    /\s(\d{1,4}(?:\.\d+)?)(?:v\d+)?$/,
  ];

  for (const re of patterns) {
    const match = re.exec(cleaned);
    if (match && match[1]) {
      const parsed = Number(match[1]);
      if (Number.isFinite(parsed) && parsed <= 2500) {
        episodeNumber = String(parsed);
        const before = cleaned.slice(0, match.index).trim();
        if (before) {
          titlePart = before;
        }
        break;
      }
    }
  }

  // Strip common trailing quality/codec tokens from the title portion
  titlePart = titlePart
    .replace(/\b(?:2160p|1080p|720p|480p|web-?dl|webrip|bluray|bdrip|x264|x265|hevc|aac|flac)\b.*$/i, '')
    .replace(/[\s.\-–—]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    animeTitle: titlePart,
    episodeNumber,
  };
}

/**
 * Inserts or updates a job in a newest-first list without duplicates.
 */
export function mergeSttJobIntoList(
  jobs: readonly SttJobOut[],
  updated: SttJobOut,
): SttJobOut[] {
  const exists = jobs.some((j) => j.id === updated.id);
  const merged = exists
    ? jobs.map((j) => (j.id === updated.id ? updated : j))
    : [updated, ...jobs];
  return [...merged].sort((a, b) => b.id - a.id);
}
