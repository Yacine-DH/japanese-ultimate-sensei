import type { EpisodeOut, JimakuEntry, JimakuFile } from '../api/client';

export interface TitleGuess {
  query: string;
  episodeNumber: number | null;
}

/**
 * Extracts a clean anime search query and optional episode number from a streaming tab title,
 * e.g. "Watch Frieren: Beyond Journey's End Episode 4 English Sub | HiAnime"
 * → { query: "Frieren: Beyond Journey's End", episodeNumber: 4 }.
 */
export function guessAnimeQueryFromTitle(pageTitle: string): TitleGuess {
  let cleaned = pageTitle.trim();
  if (!cleaned) {
    return { query: '', episodeNumber: null };
  }

  // Drop trailing site suffix separated by | or " - " (e.g. "| HiAnime", "- Watch Anime Online")
  cleaned = cleaned.replace(/\s*[|·•]\s*[^|·•]+$/, '').trim();
  cleaned = cleaned.replace(/\s+-\s+(?:watch|stream|anime|free).*$/i, '').trim();
  // Drop leading "Watch "
  cleaned = cleaned.replace(/^watch\s+/i, '').trim();

  let episodeNumber: number | null = null;
  const epRegex = /\b(?:episode|ep\.?)\s*(\d+(?:\.\d+)?)\b/i;
  const epMatch = epRegex.exec(cleaned);
  if (epMatch) {
    episodeNumber = Number(epMatch[1]);
    cleaned = cleaned.slice(0, epMatch.index).trim();
  }

  // Strip trailing punctuation / sub/dub noise
  cleaned = cleaned
    .replace(/\b(?:english\s+sub(?:bed)?|eng\s+sub|subbed|dubbed|online|free|hd)\b/gi, '')
    .replace(/[\s\-–—:|]+$/, '')
    .trim();

  return { query: cleaned, episodeNumber };
}

export function suggestNextEpisodeNumber(
  entry: Pick<JimakuEntry, 'name' | 'english_name' | 'japanese_name'>,
  existingEpisodes: readonly EpisodeOut[],
): number {
  const names = new Set(
    [entry.english_name, entry.name, entry.japanese_name]
      .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
      .map((s) => s.trim().toLowerCase()),
  );

  let maxNum = 0;
  for (const ep of existingEpisodes) {
    const epTitle = ep.anime_title?.trim().toLowerCase();
    if (epTitle && names.has(epTitle) && ep.number !== null && ep.number > maxNum) {
      maxNum = ep.number;
    }
  }
  return maxNum > 0 ? Math.floor(maxNum) + 1 : 1;
}

export function pickDefaultJimakuFile(files: readonly JimakuFile[]): JimakuFile | null {
  const rec = files.find((f) => f.recommended);
  if (rec) return rec;
  const usable = files.find((f) => f.supported && !f.multi_episode);
  if (usable) return usable;
  return files.find((f) => f.supported) ?? null;
}

export function findNextImportableFile(
  files: readonly JimakuFile[],
  failedFileName: string,
): JimakuFile | null {
  const idx = files.findIndex((f) => f.name === failedFileName);
  const after = idx >= 0 ? files.slice(idx + 1) : files;
  return (
    after.find((f) => f.supported && !f.multi_episode) ??
    after.find((f) => f.supported) ??
    null
  );
}

export function describeJimakuFileWarning(file: Pick<JimakuFile, 'supported' | 'multi_episode' | 'format'>): string | null {
  if (!file.supported) {
    return `Unsupported format (.${file.format}) — cannot be imported`;
  }
  if (file.multi_episode) {
    return 'Multi-episode bundle — prefer a single-episode subtitle file';
  }
  return null;
}

export function formatJimakuFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatJimakuError(status: number, detail?: string): string {
  if (status === 503) {
    return 'Jimaku search is not configured on the server — add SENSEI_JIMAKU_API_KEY to server/.env.';
  }
  if (status === 502) {
    return 'jimaku.cc is unreachable or rejected the server API key (502).';
  }
  if (status === 422) {
    return `${detail || 'This file could not be imported'} — try the next file in the list.`;
  }
  return detail || `Request failed (HTTP ${status})`;
}
