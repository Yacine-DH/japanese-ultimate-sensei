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
