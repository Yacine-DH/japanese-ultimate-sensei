import type { EpisodeOut } from '../api/client';

const EPISODE_QUERY_KEYS = ['ep', 'episode', 'id', 'v'];

export function normalizePageUrlPattern(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    const host = url.host.toLowerCase();
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const keptParams: string[] = [];
    for (const key of EPISODE_QUERY_KEYS) {
      const val = url.searchParams.get(key);
      if (val !== null && val.trim() !== '') {
        keptParams.push(`${key}=${val.trim()}`);
      }
    }
    const querySuffix = keptParams.length > 0 ? `?${keptParams.join('&')}` : '';
    return `${host}${path}${querySuffix}`;
  } catch {
    return null;
  }
}

export interface UrlEpisodeInfo {
  prefixPattern: string;
  episodeNumber: number;
}

export function extractUrlEpisodeInfo(patternOrUrl: string): UrlEpisodeInfo | null {
  const pattern = patternOrUrl.includes('://')
    ? normalizePageUrlPattern(patternOrUrl)
    : patternOrUrl;
  if (!pattern) {
    return null;
  }

  // Query param like ?ep=3 or &ep=3
  const queryMatch = /^(.*[?&](?:ep|episode)=)(\d+(?:\.\d+)?)(.*)$/i.exec(pattern);
  if (queryMatch) {
    return {
      prefixPattern: `${queryMatch[1]}*${queryMatch[3]}`,
      episodeNumber: Number(queryMatch[2]),
    };
  }

  // Path suffix like /frieren-ep-3, /frieren-episode-03, /frieren/3, /frieren-03
  const pathMatch =
    /^(.*?(?:[-_/]ep(?:isode)?[-_/]?|[-_/]))(\d+(?:\.\d+)?)([/-]?)$/i.exec(pattern);
  if (pathMatch) {
    return {
      prefixPattern: `${pathMatch[1]}*${pathMatch[3]}`,
      episodeNumber: Number(pathMatch[2]),
    };
  }

  return null;
}

export interface ResolvedUrlEpisode {
  pattern: string | null;
  matchedEpisodeId: number | null;
  suggestedEpisode: EpisodeOut | null;
}

export function resolveEpisodeForUrl(
  pageUrl: string,
  urlMappings: Record<string, number>,
  episodes: readonly EpisodeOut[],
): ResolvedUrlEpisode {
  const pattern = normalizePageUrlPattern(pageUrl);
  if (!pattern) {
    return { pattern: null, matchedEpisodeId: null, suggestedEpisode: null };
  }

  const exactId = urlMappings[pattern];
  if (typeof exactId === 'number') {
    return { pattern, matchedEpisodeId: exactId, suggestedEpisode: null };
  }

  const info = extractUrlEpisodeInfo(pattern);
  if (!info) {
    return { pattern, matchedEpisodeId: null, suggestedEpisode: null };
  }

  const episodeById = new Map<number, EpisodeOut>();
  for (const ep of episodes) {
    episodeById.set(ep.id, ep);
  }

  for (const [mappedPattern, mappedEpId] of Object.entries(urlMappings)) {
    const mappedInfo = extractUrlEpisodeInfo(mappedPattern);
    if (!mappedInfo || mappedInfo.prefixPattern !== info.prefixPattern) {
      continue;
    }
    const mappedEp = episodeById.get(mappedEpId);
    if (!mappedEp) {
      continue;
    }

    const candidate = episodes.find(
      (ep) =>
        ep.number === info.episodeNumber &&
        ((mappedEp.anime_id !== null && ep.anime_id === mappedEp.anime_id) ||
          (mappedEp.anime_title !== null &&
            ep.anime_title?.toLowerCase() === mappedEp.anime_title.toLowerCase())),
    );
    if (candidate) {
      return {
        pattern,
        matchedEpisodeId: null,
        suggestedEpisode: candidate,
      };
    }
  }

  return { pattern, matchedEpisodeId: null, suggestedEpisode: null };
}

export function buildPrimingUrl(serverUrl: string, episodeId: number): string | null {
  const base = serverUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/.+/.test(base)) {
    return null;
  }
  return `${base}/episodes/${episodeId}?prime=1`;
}

export function buildPrepUrl(serverUrl: string, episodeId: number): string | null {
  const base = serverUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/.+/.test(base)) {
    return null;
  }
  return `${base}/episodes/${episodeId}?prep=1`;
}

export function buildMissedUrl(serverUrl: string, episodeId: number): string | null {
  const base = serverUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/.+/.test(base)) {
    return null;
  }
  return `${base}/episodes/${episodeId}?missed=1`;
}

export function filterEpisodes(
  episodes: readonly EpisodeOut[],
  query: string,
): EpisodeOut[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return [...episodes];
  }
  return episodes.filter((ep) => {
    const anime = (ep.anime_title ?? '').toLowerCase();
    const title = (ep.title ?? '').toLowerCase();
    const file = (ep.source_filename ?? '').toLowerCase();
    const num = ep.number !== null ? `${ep.number}` : '';
    return (
      anime.includes(q) ||
      title.includes(q) ||
      file.includes(q) ||
      `ep ${num}`.includes(q) ||
      num === q
    );
  });
}
