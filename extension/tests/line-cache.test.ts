import { describe, expect, it, vi } from 'vitest';
import type { EpisodeOut, LineOut } from '../src/api/client';
import {
  EpisodeTranscriptCache,
  type SessionStorageLike,
  shouldLoadTranscriptForFrame,
} from '../src/lib/line-cache';

function makeEpisode(id = 1): EpisodeOut {
  return {
    id,
    anime_id: 1,
    anime_title: 'Frieren',
    number: 1,
    title: null,
    source: 'upload',
    source_filename: 'frieren.ass',
    sub_offset_ms: 0,
    line_count: 1,
    created_at: '2026-11-17T00:00:00Z',
  };
}

function makeLines(): LineOut[] {
  return [
    {
      id: 10,
      idx: 0,
      start_ms: 1000,
      end_ms: 2500,
      text: '魔法',
      romaji: 'mahou',
      tokens: [
        {
          surface: '魔法',
          lemma: '魔法',
          reading: 'まほう',
          lemma_reading: 'まほう',
          pos: '名詞',
          pos_detail: ['一般'],
          furigana: [{ text: '魔法', ruby: 'まほう' }],
          romaji: 'mahou',
          is_content: true,
          is_proper_noun: false,
          word_id: 55,
          status: 'new',
          common: true,
        },
      ],
      translation_en: null,
      translation_de: null,
    },
  ];
}

describe('lazy transcript loading and background cache (#3)', () => {
  it('only loads transcript when frame has a qualifying video AND tab has an enabled episode', () => {
    expect(
      shouldLoadTranscriptForFrame({
        hasQualifyingVideo: false,
        tabEnabled: true,
        episodeId: 1,
      }),
    ).toBe(false);
    expect(
      shouldLoadTranscriptForFrame({
        hasQualifyingVideo: true,
        tabEnabled: false,
        episodeId: 1,
      }),
    ).toBe(false);
    expect(
      shouldLoadTranscriptForFrame({
        hasQualifyingVideo: true,
        tabEnabled: true,
        episodeId: null,
      }),
    ).toBe(false);
    expect(
      shouldLoadTranscriptForFrame({
        hasQualifyingVideo: true,
        tabEnabled: true,
        episodeId: 1,
      }),
    ).toBe(true);
  });

  it('caches episode and lines across concurrent and sequential calls, and updates on word status change', async () => {
    const store = new Map<string, unknown>();
    const session: SessionStorageLike = {
      async get(key) {
        return store.has(key) ? { [key]: store.get(key) } : {};
      },
      async set(items) {
        for (const [k, v] of Object.entries(items)) {
          store.set(k, v);
        }
      },
      async remove(key) {
        store.delete(key);
      },
    };

    const cache = new EpisodeTranscriptCache(session);
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      data: makeLines(),
    });

    // Two concurrent requests share one fetch
    const [r1, r2] = await Promise.all([
      cache.getLines(1, fetcher),
      cache.getLines(1, fetcher),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(r1.data).toHaveLength(1);
    expect(r2.data).toHaveLength(1);

    // Updating word status updates cached lines in place and in session storage
    await cache.updateWordStatus(55, 'known');
    const r3 = await cache.getLines(1, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(r3.data?.[0]?.tokens[0]?.status).toBe('known');

    // A fresh cache instance reading from sessionStorage also gets the updated status without fetching
    const cacheAfterRestart = new EpisodeTranscriptCache(session);
    const r4 = await cacheAfterRestart.getLines(1, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(r4.data?.[0]?.tokens[0]?.status).toBe('known');

    // Episode metadata caching and invalidation
    const epFetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      data: makeEpisode(1),
    });
    await cache.getEpisode(1, epFetcher);
    await cache.getEpisode(1, epFetcher);
    expect(epFetcher).toHaveBeenCalledTimes(1);

    await cache.invalidateEpisode(1);
    await cache.getEpisode(1, epFetcher);
    expect(epFetcher).toHaveBeenCalledTimes(2);
  });
});
