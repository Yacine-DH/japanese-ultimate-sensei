import { describe, expect, it } from 'vitest';
import type { AutoImportOut } from '../src/api/client';
import {
  advanceTabTitleWatch,
  buildAutoSuggestionPresentation,
  decideAutoAttach,
  extractSeriesPrefixPattern,
  formatAutoAttachFailureNotice,
  formatAutoAttachSuccessToast,
  isPlausibleEpisodeNumber,
  removeMappingsForDetach,
  requiresTitleForEpisodeNumber,
  resolvePageEpisodeInfo,
  shouldWaitForTabTitle,
  STALE_TITLE_WAIT_MS,
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
      sync_points: [],
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
      replaced: false,
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

  it('waits when SPA pushState changes an opaque ?ep= URL while tab.title is still from episode N (#113)', () => {
    // 1. Initial episode 4 settled
    const ep4 = advanceTabTitleWatch({
      prevState: undefined,
      pageUrl: 'https://hianime.to/watch/frieren-18542?ep=107257',
      tabTitle: 'Watch Frieren Episode 4 English Sub | HiAnime',
      tabStatus: 'complete',
      urlChanged: false,
      titleChanged: false,
      nowMs: 1000,
    });
    expect(ep4.readiness).toBe('ready');

    // 2. SPA "Auto Next" pushState to episode 5: tab.status is still 'complete' and title is still episode 4!
    const nav = advanceTabTitleWatch({
      prevState: ep4.nextState,
      pageUrl: 'https://hianime.to/watch/frieren-18542?ep=107258',
      tabTitle: 'Watch Frieren Episode 4 English Sub | HiAnime',
      tabStatus: 'complete',
      urlChanged: true,
      titleChanged: false,
      nowMs: 2000,
    });
    expect(nav.readiness).toBe('wait');

    // 3. Another event 1s later with the same stale title STILL waits
    const stillStale = advanceTabTitleWatch({
      prevState: nav.nextState,
      pageUrl: 'https://hianime.to/watch/frieren-18542?ep=107258',
      tabTitle: 'Watch Frieren Episode 4 English Sub | HiAnime',
      tabStatus: 'complete',
      urlChanged: false,
      titleChanged: false,
      nowMs: 3000,
    });
    expect(stillStale.readiness).toBe('wait');

    // 4. Real title for episode 5 arrives -> becomes ready immediately
    const freshTitle = advanceTabTitleWatch({
      prevState: stillStale.nextState,
      pageUrl: 'https://hianime.to/watch/frieren-18542?ep=107258',
      tabTitle: 'Watch Frieren Episode 5 English Sub | HiAnime',
      tabStatus: 'complete',
      urlChanged: false,
      titleChanged: true,
      nowMs: 3200,
    });
    expect(freshTitle.readiness).toBe('ready');
    expect(freshTitle.nextState.staleTitleFromPrevPattern).toBeNull();
  });

  it('guards against stale title even after an MV3 service worker cold wake on SPA pushState (#113)', () => {
    // No prevState in memory, yet changeInfo.url arrives while tab.status === 'complete' without changeInfo.title
    const coldNav = advanceTabTitleWatch({
      prevState: undefined,
      pageUrl: 'https://hianime.to/watch/frieren-18542?ep=107258',
      tabTitle: 'Watch Frieren Episode 4 English Sub | HiAnime',
      tabStatus: 'complete',
      urlChanged: true,
      titleChanged: false,
      nowMs: 10_000,
    });
    expect(coldNav.readiness).toBe('wait');

    // Gives up silently after ~5s if the title never updates instead of guessing episode 4
    const timedOut = advanceTabTitleWatch({
      prevState: coldNav.nextState,
      pageUrl: 'https://hianime.to/watch/frieren-18542?ep=107258',
      tabTitle: 'Watch Frieren Episode 4 English Sub | HiAnime',
      tabStatus: 'complete',
      urlChanged: false,
      titleChanged: false,
      nowMs: 10_000 + STALE_TITLE_WAIT_MS,
    });
    expect(timedOut.readiness).toBe('give_up');
  });

  it('does not wait for tab title when the episode number comes directly from the URL (#113)', () => {
    expect(requiresTitleForEpisodeNumber('https://site.to/watch/frieren-ep-5')).toBe(false);
    expect(requiresTitleForEpisodeNumber('https://hianime.to/watch/frieren-18542?ep=107258')).toBe(
      true,
    );

    const ep4 = advanceTabTitleWatch({
      prevState: undefined,
      pageUrl: 'https://site.to/watch/frieren-ep-4',
      tabTitle: 'Frieren Episode 4',
      tabStatus: 'complete',
      urlChanged: false,
      titleChanged: false,
      nowMs: 1000,
    });
    const ep5 = advanceTabTitleWatch({
      prevState: ep4.nextState,
      pageUrl: 'https://site.to/watch/frieren-ep-5',
      tabTitle: 'Frieren Episode 4', // stale title doesn't matter because URL has ep-5
      tabStatus: 'complete',
      urlChanged: true,
      titleChanged: false,
      nowMs: 2000,
    });
    expect(ep5.readiness).toBe('ready');
  });

  it('drops both exact urlMappings and remembered animeMappings prefix on detach (#113)', () => {
    const urlMappings = {
      'hianime.to/watch/frieren-18542?ep=107257': 14,
      'site.to/watch/other-ep-1': 99,
    };
    const animeMappings = {
      'hianime.to/watch/frieren-18542?ep=*': 7,
      'site.to/watch/other-ep-*': 2,
    };

    const res = removeMappingsForDetach(
      'https://hianime.to/watch/frieren-18542?ep=107257',
      urlMappings,
      animeMappings,
    );

    expect(res.changed).toBe(true);
    expect(res.urlMappings).toEqual({ 'site.to/watch/other-ep-1': 99 });
    expect(res.animeMappings).toEqual({ 'site.to/watch/other-ep-*': 2 });
    // Original objects stay unmutated
    expect(urlMappings['hianime.to/watch/frieren-18542?ep=107257']).toBe(14);
    expect(animeMappings['hianime.to/watch/frieren-18542?ep=*']).toBe(7);

    // Detaching an unmapped page is a no-op
    const noop = removeMappingsForDetach(
      'https://hianime.to/watch/frieren-18542?ep=107257',
      res.urlMappings,
      res.animeMappings,
    );
    expect(noop.changed).toBe(false);
  });
});
