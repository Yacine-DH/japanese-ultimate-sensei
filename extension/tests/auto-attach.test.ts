import { describe, expect, it } from 'vitest';
import type { AutoImportOut } from '../src/api/client';
import {
  buildAutoSuggestionPresentation,
  decideAutoAttach,
  extractSeriesPrefixPattern,
  formatAutoAttachFailureNotice,
  formatAutoAttachSuccessToast,
  isPlausibleEpisodeNumber,
  resolvePageEpisodeInfo,
  shouldWaitForTabTitle,
} from '../src/lib/auto-attach';

function makeAutoImportOut(overrides: Partial<AutoImportOut> = {}): AutoImportOut {
  return {
    existing: false,
    file_name: '[SubsPlease] Sousou no Frieren - 05 (1080p)_ja.srt',
    entry: {
      id: 729,
      name: 'Sousou no Frieren',
      english_name: "Frieren: Beyond Journey's End",
      japanese_name: '葬送のフリーレン',
      anilist_id: 154587,
      movie: false,
    },
    episode: {
      id: 15,
      anime_id: 1,
      anime_title: 'Frieren',
      number: 5,
      title: null,
      source: 'jimaku',
      source_filename: '[SubsPlease] Sousou no Frieren - 05 (1080p)_ja.srt',
      sub_offset_ms: 0,
      line_count: 305,
      created_at: '2026-11-22T17:00:00Z',
      understanding: {
        episode_id: 15,
        total_tokens: 1200,
        unique_words: 400,
        known_tokens: 480,
        known_unique: 140,
        learning_tokens: 60,
        learning_unique: 20,
        token_pct: 40,
        unique_pct: 35,
      },
    },
    ...overrides,
  };
}

describe('E-11 auto-attach decision logic (#107)', () => {
  it('auto-attaches when the URL prefix is remembered and has an episode number', () => {
    const decision = decideAutoAttach({
      pageUrl: 'https://site.to/watch/frieren-ep-5',
      pageTitle: 'Watch Frieren Episode 5 English Sub | Site',
      urlMappings: { 'site.to/watch/frieren-ep-4': 14 },
      animeMappings: { 'site.to/watch/frieren-ep-*': 1 },
    });

    expect(decision).toEqual({
      mode: 'auto',
      pattern: 'site.to/watch/frieren-ep-5',
      prefixPattern: 'site.to/watch/frieren-ep-*',
      animeId: 1,
      episodeNumber: 5,
    });
  });

  it('auto-attaches on opaque ?ep=<id> streaming URLs by using remembered prefix + tab title episode number', () => {
    const decision = decideAutoAttach({
      pageUrl: 'https://hianime.to/watch/frieren-18542?ep=107258',
      pageTitle: "Watch Frieren: Beyond Journey's End Episode 5 English Sub | HiAnime",
      urlMappings: {},
      animeMappings: { 'hianime.to/watch/frieren-18542?ep=*': 1 },
    });

    expect(decision).toEqual({
      mode: 'auto',
      pattern: 'hianime.to/watch/frieren-18542?ep=107258',
      prefixPattern: 'hianime.to/watch/frieren-18542?ep=*',
      animeId: 1,
      episodeNumber: 5,
    });
  });

  it('prefers URL episode number over tab title episode number', () => {
    const info = resolvePageEpisodeInfo(
      'https://site.to/watch/frieren-ep-6',
      'Watch Frieren Episode 5 | Site',
    );
    expect(info.episodeNumber).toBe(6);
    expect(info.episodeFromUrl).toBe(true);
    expect(info.prefixPattern).toBe('site.to/watch/frieren-ep-*');
  });

  it('returns one-click suggestion (never auto) for an unremembered series with title guess + episode number', () => {
    const decision = decideAutoAttach({
      pageUrl: 'https://site.to/watch/frieren-ep-4',
      pageTitle: "Watch Frieren: Beyond Journey's End Episode 4 English Sub | HiAnime",
      urlMappings: {},
      animeMappings: {},
    });

    expect(decision).toEqual({
      mode: 'suggest',
      pattern: 'site.to/watch/frieren-ep-4',
      prefixPattern: 'site.to/watch/frieren-ep-*',
      query: "Frieren: Beyond Journey's End",
      episodeNumber: 4,
    });
  });

  it('returns one-click suggestion when episode number comes only from the tab title', () => {
    const decision = decideAutoAttach({
      pageUrl: 'https://stream.example/player/abcxyz',
      pageTitle: 'Dungeon Meshi Ep. 12 - Watch Anime Online',
      urlMappings: {},
      animeMappings: {},
    });

    expect(decision).toEqual({
      mode: 'suggest',
      pattern: 'stream.example/player/abcxyz',
      prefixPattern: null,
      query: 'Dungeon Meshi',
      episodeNumber: 12,
    });
  });

  it('falls back to manual flow when neither URL nor tab title has an episode number', () => {
    const noNumber = decideAutoAttach({
      pageUrl: 'https://site.to/anime/frieren',
      pageTitle: "Frieren: Beyond Journey's End | Site",
      urlMappings: {},
      animeMappings: { 'site.to/watch/frieren-ep-*': 1 },
    });
    expect(noNumber.mode).toBe('manual');
    if (noNumber.mode === 'manual') {
      expect(noNumber.episodeNumber).toBeNull();
      expect(noNumber.query).toBe("Frieren: Beyond Journey's End");
    }

    // Series page with a 5-digit database ID in path is NOT treated as an episode number
    const seriesIdPage = decideAutoAttach({
      pageUrl: 'https://site.to/watch/frieren-18542',
      pageTitle: 'Frieren | Site',
      urlMappings: {},
      animeMappings: {},
    });
    expect(seriesIdPage.mode).toBe('manual');
    expect(extractSeriesPrefixPattern('https://site.to/watch/frieren-18542')).toBeNull();
  });

  it('falls back to manual flow on unsupported schemes or missing title guess without remembered prefix', () => {
    expect(
      decideAutoAttach({
        pageUrl: 'chrome://extensions',
        pageTitle: 'Extensions',
        urlMappings: {},
        animeMappings: {},
      }).mode,
    ).toBe('manual');

    expect(
      decideAutoAttach({
        pageUrl: 'https://site.to/watch/ep-3',
        pageTitle: '   ',
        urlMappings: {},
        animeMappings: {},
      }),
    ).toEqual({
      mode: 'manual',
      pattern: 'site.to/watch/ep-3',
      prefixPattern: 'site.to/watch/ep-*',
      query: '',
      episodeNumber: 3,
    });
  });

  it('returns already_attached when the exact URL is mapped or the tab is already attached', () => {
    expect(
      decideAutoAttach({
        pageUrl: 'https://site.to/watch/frieren-ep-4',
        pageTitle: 'Frieren Episode 4',
        urlMappings: { 'site.to/watch/frieren-ep-4': 14 },
        animeMappings: { 'site.to/watch/frieren-ep-*': 1 },
      }),
    ).toEqual({
      mode: 'already_attached',
      pattern: 'site.to/watch/frieren-ep-4',
      episodeId: 14,
    });

    expect(
      decideAutoAttach({
        pageUrl: 'https://site.to/watch/frieren-ep-5',
        pageTitle: 'Frieren Episode 5',
        urlMappings: {},
        animeMappings: { 'site.to/watch/frieren-ep-*': 1 },
        isTabAttached: true,
      }),
    ).toEqual({
      mode: 'already_attached',
      pattern: 'site.to/watch/frieren-ep-5',
      episodeId: null,
    });
  });

  it('waits for tab title only on opaque ?ep=<big-id> URLs while still loading', () => {
    expect(shouldWaitForTabTitle('https://hianime.to/watch/frieren-18542?ep=107258', 'loading')).toBe(
      true,
    );
    expect(
      shouldWaitForTabTitle('https://hianime.to/watch/frieren-18542?ep=107258', 'complete'),
    ).toBe(false);
    expect(shouldWaitForTabTitle('https://site.to/watch/frieren-ep-5', 'loading')).toBe(false);
    expect(isPlausibleEpisodeNumber(0)).toBe(true);
    expect(isPlausibleEpisodeNumber(107258)).toBe(false);
    expect(isPlausibleEpisodeNumber(-1)).toBe(false);
  });

  it('formats auto-attach toasts and one-click suggestion presentation cleanly', () => {
    const out = makeAutoImportOut();
    expect(formatAutoAttachSuccessToast(out)).toBe('Frieren ep 5 · subtitles attached');

    const fail = formatAutoAttachFailureNotice(404, 'No Japanese subtitle file for episode 99');
    expect(fail.title).toBe('No Japanese subtitle file for episode 99');
    expect(fail.actionLabel).toBe('Search manually');

    const pres = buildAutoSuggestionPresentation(out);
    expect(pres.headline).toBe('Sousou no Frieren · episode 5');
    expect(pres.subtitle).toContain('葬送のフリーレン');
    expect(pres.meta).toBe('[SubsPlease] Sousou no Frieren - 05 (1080p)_ja.srt');

    const existingPres = buildAutoSuggestionPresentation(
      makeAutoImportOut({ existing: true, file_name: null }),
    );
    expect(existingPres.meta).toBe('Already in your library');
  });
});
