import type { EpisodeOut, WordStatus } from '../api/client';

export interface AnimeOption {
  id: number;
  title: string;
  episodes: EpisodeOut[];
}

export function extractAnimeOptions(episodes: readonly EpisodeOut[]): AnimeOption[] {
  const byId = new Map<number, AnimeOption>();

  for (const ep of episodes) {
    if (ep.anime_id === null) continue;
    let opt = byId.get(ep.anime_id);
    if (!opt) {
      opt = {
        id: ep.anime_id,
        title: ep.anime_title?.trim() || `Anime #${ep.anime_id}`,
        episodes: [],
      };
      byId.set(ep.anime_id, opt);
    }
    opt.episodes.push(ep);
  }

  const list = Array.from(byId.values());
  for (const opt of list) {
    opt.episodes.sort((a, b) => {
      if (a.number !== null && b.number !== null && a.number !== b.number) {
        return a.number - b.number;
      }
      if (a.number !== null && b.number === null) return -1;
      if (a.number === null && b.number !== null) return 1;
      return a.id - b.id;
    });
  }
  list.sort((a, b) => a.title.localeCompare(b.title));
  return list;
}

export function toggleIdSelection(selected: ReadonlySet<number>, id: number): Set<number> {
  const next = new Set(selected);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
}

export function toggleAllSelection(
  selected: ReadonlySet<number>,
  visibleIds: readonly number[],
): Set<number> {
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const next = new Set(selected);
  if (allSelected) {
    for (const id of visibleIds) {
      next.delete(id);
    }
  } else {
    for (const id of visibleIds) {
      next.add(id);
    }
  }
  return next;
}

export interface PaginationInfo {
  page: number;
  totalPages: number;
  start: number;
  end: number;
  hasPrev: boolean;
  hasNext: boolean;
}

export function computePagination(
  total: number,
  limit: number,
  offset: number,
): PaginationInfo {
  const safeLimit = Math.max(1, limit);
  const safeTotal = Math.max(0, total);
  const safeOffset = Math.max(0, Math.min(offset, Math.max(0, safeTotal - 1)));
  const page = Math.floor(safeOffset / safeLimit) + 1;
  const totalPages = Math.max(1, Math.ceil(safeTotal / safeLimit));
  const start = safeTotal === 0 ? 0 : safeOffset + 1;
  const end = Math.min(safeTotal, safeOffset + safeLimit);
  return {
    page,
    totalPages,
    start,
    end,
    hasPrev: safeOffset > 0,
    hasNext: safeOffset + safeLimit < safeTotal,
  };
}

export const WORD_STATUS_OPTIONS: ReadonlyArray<{ value: WordStatus | ''; label: string }> = [
  { value: '', label: 'All' },
  { value: 'new', label: 'New' },
  { value: 'learning', label: 'Learning' },
  { value: 'known', label: 'Known' },
  { value: 'ignored', label: 'Ignored' },
];
