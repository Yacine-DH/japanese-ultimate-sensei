import type { EpisodeOut, JimakuEntry, JimakuFile } from '../api/client';

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
  const usable = files.find((f) => f.supported && !f.multi_episode && !f.dual_language);
  if (usable) return usable;
  const singleEp = files.find((f) => f.supported && !f.multi_episode);
  if (singleEp) return singleEp;
  return files.find((f) => f.supported) ?? null;
}

export function findNextImportableFile(
  files: readonly JimakuFile[],
  failedFileName: string,
): JimakuFile | null {
  const idx = files.findIndex((f) => f.name === failedFileName);
  const after = idx >= 0 ? files.slice(idx + 1) : files;
  return (
    after.find((f) => f.supported && !f.multi_episode && !f.dual_language) ??
    after.find((f) => f.supported && !f.multi_episode) ??
    after.find((f) => f.supported) ??
    null
  );
}

export function isJimakuFileDimmed(
  file: Pick<JimakuFile, 'supported' | 'multi_episode' | 'dual_language'>,
): boolean {
  return !file.supported || file.multi_episode || Boolean(file.dual_language);
}

export function describeJimakuFileWarning(
  file: Pick<JimakuFile, 'supported' | 'multi_episode' | 'dual_language' | 'format'>,
): string | null {
  if (!file.supported) {
    return `Unsupported format (.${file.format}) — cannot be imported`;
  }
  if (file.multi_episode && file.dual_language) {
    return 'Multi-episode bundle · Contains non-Japanese lines';
  }
  if (file.multi_episode) {
    return 'Multi-episode bundle — prefer a single-episode subtitle file';
  }
  if (file.dual_language) {
    return 'Contains non-Japanese lines';
  }
  return null;
}

export function formatJimakuFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatJimakuError(status: number | undefined, detail?: string): string {
  if (status === 503) {
    return 'Jimaku is not configured on the server — add SENSEI_JIMAKU_API_KEY to server/.env.';
  }
  if (status === 502) {
    return 'jimaku.cc is unreachable or rejected the server API key (502).';
  }
  if (status === 422) {
    return `${detail || 'This file could not be imported'} — try selecting the next file below.`;
  }
  return detail || 'Jimaku request failed';
}
