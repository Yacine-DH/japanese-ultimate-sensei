import { describe, expect, it } from 'vitest';
import type { EpisodeOut } from '../src/api/client';
import {
  computePagination,
  extractAnimeOptions,
  toggleAllSelection,
  toggleIdSelection,
} from '../src/lib/words';

function makeEpisode(overrides: Partial<EpisodeOut> = {}): EpisodeOut {
  return {
    id: 1,
    anime_id: 1,
    anime_title: 'Frieren',
    number: 1,
    title: null,
    source: 'upload',
    source_filename: 'frieren.ass',
    sub_offset_ms: 0,
    sync_points: [],
    line_count: 250,
    created_at: '2026-11-19T00:00:00Z',
    ...overrides,
  };
}

describe('words table helpers (W-4, #25)', () => {
  it('extracts sorted unique anime options with sorted episodes', () => {
    const opts = extractAnimeOptions([
      makeEpisode({ id: 3, anime_id: 2, anime_title: 'Frieren', number: 2 }),
      makeEpisode({ id: 2, anime_id: 2, anime_title: 'Frieren', number: 1 }),
      makeEpisode({ id: 1, anime_id: 1, anime_title: 'Bocchi the Rock', number: 1 }),
      makeEpisode({ id: 4, anime_id: null, anime_title: 'Unlinked', number: 1 }),
    ]);

    expect(opts.map((a) => a.title)).toEqual(['Bocchi the Rock', 'Frieren']);
    expect(opts[1]?.episodes.map((e) => e.number)).toEqual([1, 2]);
  });

  it('toggles single and page-wide selections cleanly', () => {
    let sel = new Set<number>();
    sel = toggleIdSelection(sel, 10);
    expect(Array.from(sel)).toEqual([10]);
    sel = toggleIdSelection(sel, 10);
    expect(Array.from(sel)).toEqual([]);

    // Select all visible
    sel = toggleAllSelection(sel, [1, 2, 3]);
    expect(Array.from(sel).sort()).toEqual([1, 2, 3]);
    // Toggle all again unselects only visible ids
    sel.add(99);
    sel = toggleAllSelection(sel, [1, 2, 3]);
    expect(Array.from(sel)).toEqual([99]);
  });

  it('computes pagination bounds accurately', () => {
    expect(computePagination(0, 50, 0)).toEqual({
      page: 1,
      totalPages: 1,
      start: 0,
      end: 0,
      hasPrev: false,
      hasNext: false,
    });
    expect(computePagination(125, 50, 50)).toEqual({
      page: 2,
      totalPages: 3,
      start: 51,
      end: 100,
      hasPrev: true,
      hasNext: true,
    });
  });
});
