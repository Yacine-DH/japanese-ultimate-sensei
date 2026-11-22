import type { AutoImportOut } from '../api/client';
import { guessAnimeQueryFromTitle } from './jimaku';
import { extractUrlEpisodeInfo, normalizePageUrlPattern } from './url-mapping';

export const MAX_PLAUSIBLE_EPISODE_NUMBER = 2500;

export function isPlausibleEpisodeNumber(value: number | null | undefined): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_PLAUSIBLE_EPISODE_NUMBER
  );
}

function isExplicitEpisodeQueryPrefix(prefixPattern: string): boolean {
  return /[?&](?:ep|episode)=\*/i.test(prefixPattern);
}

/**
 * Extracts a stable series-level URL prefix pattern (e.g. `site.to/watch/frieren-ep-*` or
 * `hianime.to/watch/frieren-18542?ep=*`) suitable for remembering `prefixPattern → anime_id`.
 * Ignores implausible trailing numeric path IDs (e.g. `/watch/frieren-18542` without `?ep=`).
 */
export function extractSeriesPrefixPattern(pageUrl: string): string | null {
  const pattern = normalizePageUrlPattern(pageUrl);
  if (!pattern) {
    return null;
  }
  const urlInfo = extractUrlEpisodeInfo(pattern);
  if (!urlInfo) {
    return null;
  }
  if (isPlausibleEpisodeNumber(urlInfo.episodeNumber)) {
    return urlInfo.prefixPattern;
  }
  if (isExplicitEpisodeQueryPrefix(urlInfo.prefixPattern)) {
    return urlInfo.prefixPattern;
  }
  return null;
}

export interface PageEpisodeInfo {
  pattern: string | null;
  prefixPattern: string | null;
  episodeNumber: number | null;
  episodeFromUrl: boolean;
  titleQuery: string;
}

/**
 * Resolves the normalized page pattern, series prefix pattern, anime title guess, and
 * episode number (URL first, then tab title).
 */
export function resolvePageEpisodeInfo(pageUrl: string, pageTitle: string): PageEpisodeInfo {
  const pattern = normalizePageUrlPattern(pageUrl);
  const titleGuess = guessAnimeQueryFromTitle(pageTitle);
  const titleQuery = titleGuess.query.trim();

  if (!pattern) {
    return {
      pattern: null,
      prefixPattern: null,
      episodeNumber: null,
      episodeFromUrl: false,
      titleQuery,
    };
  }

  const urlInfo = extractUrlEpisodeInfo(pattern);
  if (urlInfo && isPlausibleEpisodeNumber(urlInfo.episodeNumber)) {
    return {
      pattern,
      prefixPattern: urlInfo.prefixPattern,
      episodeNumber: urlInfo.episodeNumber,
      episodeFromUrl: true,
      titleQuery,
    };
  }

  const prefixPattern =
    urlInfo && isExplicitEpisodeQueryPrefix(urlInfo.prefixPattern)
      ? urlInfo.prefixPattern
      : null;
  const episodeNumber = isPlausibleEpisodeNumber(titleGuess.episodeNumber)
    ? titleGuess.episodeNumber
    : null;

  return {
    pattern,
    prefixPattern,
    episodeNumber,
    episodeFromUrl: false,
    titleQuery,
  };
}

export const STALE_TITLE_WAIT_MS = 5_000;

export interface TabTitleWatchState {
  pattern: string | null;
  lastTitle: string;
  staleTitleFromPrevPattern: string | null;
  urlChangedAtMs: number | null;
  gaveUpOnStaleTitle: boolean;
}

export type TitleReadinessDecision = 'ready' | 'wait' | 'give_up';

/**
 * Returns true when this URL requires reading the episode number from the tab title
 * (e.g. opaque `?ep=107258` streaming IDs or slug-only watch pages).
 */
export function requiresTitleForEpisodeNumber(pageUrl: string): boolean {
  const pattern = normalizePageUrlPattern(pageUrl);
  if (!pattern) return false;
  const urlInfo = extractUrlEpisodeInfo(pattern);
  if (urlInfo && isPlausibleEpisodeNumber(urlInfo.episodeNumber)) {
    return false;
  }
  return true;
}

/**
 * When a streaming site uses an opaque numeric `?ep=107257` query ID, the real episode number
 * has to come from the tab title. While the tab is still loading (e.g. during an SPA transition),
 * wait until `status === 'complete'` or a title update so we don't read the previous episode's title.
 */
export function shouldWaitForTabTitle(pageUrl: string, tabStatus?: string): boolean {
  const pattern = normalizePageUrlPattern(pageUrl);
  if (!pattern) return false;
  const urlInfo = extractUrlEpisodeInfo(pattern);
  if (!urlInfo) return false;
  if (isPlausibleEpisodeNumber(urlInfo.episodeNumber)) {
    return false;
  }
  return isExplicitEpisodeQueryPrefix(urlInfo.prefixPattern) && tabStatus !== 'complete';
}

/**
 * Pure per-tab SPA title-freshness state machine (#113).
 *
 * Prevents opaque `?ep=<id>` sites from reading episode N's stale `tab.title` right after
 * `history.pushState` updates the URL while `tab.status` is already `'complete'`.
 * - For URL-derived episode numbers (`/watch/frieren-ep-5`), always returns `'ready'`.
 * - When the URL pattern changes on a title-derived URL without a new title, records the
 *   previous title as stale and returns `'wait'` until a different non-empty title arrives.
 * - If the title remains unchanged after `STALE_TITLE_WAIT_MS` (~5 s), returns `'give_up'`
 *   so auto-attach silently skips instead of permanently saving the wrong episode mapping.
 */
export function advanceTabTitleWatch(params: {
  prevState: TabTitleWatchState | undefined;
  pageUrl: string;
  tabTitle: string;
  tabStatus?: string;
  urlChanged: boolean;
  titleChanged: boolean;
  nowMs: number;
  staleWaitMs?: number;
}): { nextState: TabTitleWatchState; readiness: TitleReadinessDecision } {
  const pattern = normalizePageUrlPattern(params.pageUrl);
  const currentTitle = params.tabTitle.trim();
  const waitMs = params.staleWaitMs ?? STALE_TITLE_WAIT_MS;
  const prev = params.prevState;
  const patternChanged = pattern !== (prev?.pattern ?? null);
  const needsTitle = requiresTitleForEpisodeNumber(params.pageUrl);

  // Start from previous state or blank slate.
  let nextState: TabTitleWatchState = prev
    ? { ...prev }
    : {
        pattern: null,
        lastTitle: '',
        staleTitleFromPrevPattern: null,
        urlChangedAtMs: null,
        gaveUpOnStaleTitle: false,
      };

  if (patternChanged) {
    // Remember the title that belonged to the previous pattern so we don't reuse it.
    // Even if `prev` is missing (e.g. MV3 service worker woke up on `history.pushState`),
    // a `changeInfo.url` arriving while `tab.status === 'complete'` without `changeInfo.title`
    // means `tab.title` is still the previous page's title.
    let staleTitle: string | null = null;
    if (needsTitle) {
      const prevKnownTitle = prev?.lastTitle.trim() ?? '';
      if (prevKnownTitle && (!params.titleChanged || currentTitle === prevKnownTitle)) {
        staleTitle = prevKnownTitle;
      } else if (
        params.urlChanged &&
        !params.titleChanged &&
        params.tabStatus === 'complete' &&
        currentTitle !== ''
      ) {
        staleTitle = currentTitle;
      }
    }

    nextState = {
      pattern,
      lastTitle: staleTitle ? prev?.lastTitle ?? '' : currentTitle,
      staleTitleFromPrevPattern: staleTitle,
      urlChangedAtMs: staleTitle ? params.nowMs : null,
      gaveUpOnStaleTitle: false,
    };
  }

  if (!pattern || !needsTitle) {
    if (currentTitle) {
      nextState.lastTitle = currentTitle;
    }
    nextState.staleTitleFromPrevPattern = null;
    nextState.urlChangedAtMs = null;
    nextState.gaveUpOnStaleTitle = false;
    return { nextState, readiness: 'ready' };
  }

  // If we are waiting for the title to change away from the previous episode's title:
  if (nextState.staleTitleFromPrevPattern !== null) {
    if (currentTitle !== '' && currentTitle !== nextState.staleTitleFromPrevPattern) {
      // Real new title arrived — clear stale guard and proceed.
      nextState.lastTitle = currentTitle;
      nextState.staleTitleFromPrevPattern = null;
      nextState.urlChangedAtMs = null;
      nextState.gaveUpOnStaleTitle = false;
      return { nextState, readiness: 'ready' };
    }

    const elapsed = params.nowMs - (nextState.urlChangedAtMs ?? params.nowMs);
    if (elapsed >= waitMs) {
      nextState.gaveUpOnStaleTitle = true;
      return { nextState, readiness: 'give_up' };
    }

    return { nextState, readiness: 'wait' };
  }

  if (nextState.gaveUpOnStaleTitle) {
    return { nextState, readiness: 'give_up' };
  }

  if (currentTitle) {
    nextState.lastTitle = currentTitle;
  }

  if (!params.titleChanged && shouldWaitForTabTitle(params.pageUrl, params.tabStatus)) {
    return { nextState, readiness: 'wait' };
  }

  return { nextState, readiness: 'ready' };
}

/**
 * Drops both the exact URL mapping (`urlMappings[pattern]`) and the remembered series prefix
 * mapping (`animeMappings[prefixPattern]`) when the user detaches a tab (#113), so a wrong
 * match won't keep auto-attaching on subsequent episodes.
 */
export function removeMappingsForDetach(
  pageUrl: string,
  urlMappings: Readonly<Record<string, number>>,
  animeMappings: Readonly<Record<string, number>>,
): {
  urlMappings: Record<string, number>;
  animeMappings: Record<string, number>;
  changed: boolean;
} {
  const pattern = normalizePageUrlPattern(pageUrl);
  const prefixPattern = extractSeriesPrefixPattern(pageUrl);
  const nextUrlMappings = { ...urlMappings };
  const nextAnimeMappings = { ...animeMappings };
  let changed = false;

  if (pattern && Object.prototype.hasOwnProperty.call(nextUrlMappings, pattern)) {
    delete nextUrlMappings[pattern];
    changed = true;
  }
  if (prefixPattern && Object.prototype.hasOwnProperty.call(nextAnimeMappings, prefixPattern)) {
    delete nextAnimeMappings[prefixPattern];
    changed = true;
  }

  return {
    urlMappings: nextUrlMappings,
    animeMappings: nextAnimeMappings,
    changed,
  };
}

export interface AutoAttachInput {
  pageUrl: string;
  pageTitle: string;
  /** Exact normalized URL pattern → episode_id mappings (E-4). */
  urlMappings: Record<string, number>;
  /** Series URL prefixPattern → anime_id mappings (E-11). */
  animeMappings: Record<string, number>;
  /** True when the current tab already has an episode attached. */
  isTabAttached?: boolean;
}

export type AutoAttachDecision =
  | {
      mode: 'already_attached';
      pattern: string | null;
      episodeId: number | null;
    }
  | {
      /** Remembered series prefix + episode number: auto-attach in background. */
      mode: 'auto';
      pattern: string;
      prefixPattern: string;
      animeId: number;
      episodeNumber: number;
    }
  | {
      /** New series with title guess + episode number: one-click suggestion in popup. */
      mode: 'suggest';
      pattern: string;
      prefixPattern: string | null;
      query: string;
      episodeNumber: number;
    }
  | {
      /** Unsupported URL, missing episode number, or no usable query/mapping: manual flow. */
      mode: 'manual';
      pattern: string | null;
      prefixPattern: string | null;
      query: string;
      episodeNumber: number | null;
    };

/**
 * Pure E-11 decision logic:
 * 1. Already attached / exact URL mapping → `already_attached`
 * 2. No episode number (URL first, then title) → `manual`
 * 3. Remembered `prefixPattern → anime_id` → `auto`
 * 4. Title guess + episode number → `suggest` (never auto-attach on a title guess alone)
 * 5. Otherwise → `manual`
 */
export function decideAutoAttach(input: AutoAttachInput): AutoAttachDecision {
  const info = resolvePageEpisodeInfo(input.pageUrl, input.pageTitle);

  if (!info.pattern) {
    return {
      mode: 'manual',
      pattern: null,
      prefixPattern: null,
      query: info.titleQuery,
      episodeNumber: null,
    };
  }

  const exactEpisodeId = input.urlMappings[info.pattern];
  if (input.isTabAttached || typeof exactEpisodeId === 'number') {
    return {
      mode: 'already_attached',
      pattern: info.pattern,
      episodeId: typeof exactEpisodeId === 'number' ? exactEpisodeId : null,
    };
  }

  if (info.episodeNumber === null) {
    return {
      mode: 'manual',
      pattern: info.pattern,
      prefixPattern: info.prefixPattern,
      query: info.titleQuery,
      episodeNumber: null,
    };
  }

  if (info.prefixPattern !== null) {
    const rememberedAnimeId = input.animeMappings[info.prefixPattern];
    if (typeof rememberedAnimeId === 'number' && Number.isFinite(rememberedAnimeId)) {
      return {
        mode: 'auto',
        pattern: info.pattern,
        prefixPattern: info.prefixPattern,
        animeId: rememberedAnimeId,
        episodeNumber: info.episodeNumber,
      };
    }
  }

  if (info.titleQuery !== '') {
    return {
      mode: 'suggest',
      pattern: info.pattern,
      prefixPattern: info.prefixPattern,
      query: info.titleQuery,
      episodeNumber: info.episodeNumber,
    };
  }

  return {
    mode: 'manual',
    pattern: info.pattern,
    prefixPattern: info.prefixPattern,
    query: '',
    episodeNumber: info.episodeNumber,
  };
}

export interface AutoAttachNotice {
  id: string;
  kind: 'attached' | 'error';
  title: string;
  hint?: string;
  actionLabel?: string;
}

export function formatAutoAttachSuccessToast(result: AutoImportOut): string {
  const title =
    result.episode.anime_title?.trim() ||
    result.entry.english_name?.trim() ||
    result.entry.name?.trim() ||
    'Episode';
  const epPart = result.episode.number !== null ? ` ep ${result.episode.number}` : '';
  return `${title}${epPart} · subtitles attached`;
}

export function formatAutoAttachFailureNotice(
  status: number,
  detail?: string,
): { title: string; hint: string; actionLabel: string } {
  const trimmed = detail?.trim();
  let title: string;
  if (trimmed) {
    title = trimmed;
  } else if (status === 404) {
    title = 'No Japanese subtitles found for this episode';
  } else if (status === 503) {
    title = 'Jimaku search is not configured on the server';
  } else if (status === 502) {
    title = 'jimaku.cc is unreachable right now';
  } else {
    title = `Auto-attach failed (HTTP ${status || 'offline'})`;
  }

  return {
    title,
    hint: 'Click Search manually or open the Sensei extension icon.',
    actionLabel: 'Search manually',
  };
}

export interface AutoSuggestionPresentation {
  headline: string;
  subtitle: string;
  meta: string;
}

export function buildAutoSuggestionPresentation(
  result: AutoImportOut,
): AutoSuggestionPresentation {
  const name = result.entry.name?.trim() || result.entry.english_name?.trim() || 'Anime';
  const epNum = result.episode.number;
  const headline = epNum !== null ? `${name} · episode ${epNum}` : name;

  const subParts: string[] = [];
  if (result.entry.japanese_name?.trim()) {
    subParts.push(result.entry.japanese_name.trim());
  }
  if (
    result.entry.english_name?.trim() &&
    result.entry.english_name.trim().toLowerCase() !== name.toLowerCase()
  ) {
    subParts.push(result.entry.english_name.trim());
  }

  const meta = result.existing
    ? 'Already in your library'
    : result.file_name
      ? result.file_name
      : `${result.episode.line_count} lines`;

  return {
    headline,
    subtitle: subParts.join(' · '),
    meta,
  };
}
