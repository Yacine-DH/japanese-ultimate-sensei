import type { components, paths } from './schema';
import { type WebSettings, loadWebSettings, resolveApiBaseUrl } from '../lib/settings';

export type { components, paths };

export type Health = components['schemas']['Health'];
export type EpisodeOut = components['schemas']['EpisodeOut'];
export type EpisodeCreated = components['schemas']['EpisodeCreated'];
export type EpisodePatch = components['schemas']['EpisodePatch'];
export type LineOut = components['schemas']['LineOut'];
export type TokenOut = components['schemas']['TokenOut'];
export type FuriganaSegment = components['schemas']['FuriganaSegment'];
export type Understanding = components['schemas']['Understanding'];
export type LookupResult = components['schemas']['LookupResult'];
export type DictEntry = components['schemas']['DictEntry'];
export type Sense = components['schemas']['Sense'];
export type WordOut = components['schemas']['WordOut'];
export type WordStatus = components['schemas']['WordStatus'];
export type WordListItem = components['schemas']['WordListItem'];
export type WordPage = components['schemas']['WordPage'];
export type BulkStatusIn = components['schemas']['BulkStatusIn'];
export type BulkStatusOut = components['schemas']['BulkStatusOut'];
export type CardCreate = components['schemas']['CardCreate'];
export type CardCreated = components['schemas']['CardCreated'];
export type CardOut = components['schemas']['CardOut'];
export type EpisodeRef = components['schemas']['EpisodeRef'];
export type MediaKind = components['schemas']['MediaKind'];
export type MediaOut = components['schemas']['MediaOut'];
export type ReviewCard = components['schemas']['ReviewCard'];
export type ReviewQueue = components['schemas']['ReviewQueue'];
export type ReviewIn = components['schemas']['ReviewIn'];
export type ReviewOut = components['schemas']['ReviewOut'];
export type JimakuEntry = components['schemas']['JimakuEntry'];
export type JimakuFile = components['schemas']['JimakuFile'];
export type JimakuImport = components['schemas']['JimakuImport'];
export type ActivityDayOut = components['schemas']['ActivityDayOut'];
export type ActivityTotals = components['schemas']['ActivityTotals'];
export type ActivityOut = components['schemas']['ActivityOut'];
export type AnimeOut = components['schemas']['AnimeOut'];
export type ProgressPoint = components['schemas']['ProgressPoint'];
export type EpisodeProgress = components['schemas']['EpisodeProgress'];
export type AnimeProgress = components['schemas']['AnimeProgress'];

export class SenseiApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'SenseiApiError';
    this.status = status;
  }
}

export function buildAuthHeaders(
  settings: Pick<WebSettings, 'apiToken'>,
  extra?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(extra ?? {}),
  };
  const token = settings.apiToken.trim();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
    headers['X-Sensei-Token'] = token;
  }
  return headers;
}

export async function apiRequest<T>(
  path: string,
  options?: {
    method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
    json?: unknown;
    formData?: FormData;
    settings?: Pick<WebSettings, 'serverUrl' | 'apiToken'>;
    fetchImpl?: typeof fetch;
  },
): Promise<T> {
  const settings = options?.settings ?? loadWebSettings();
  const fetchFn = options?.fetchImpl ?? fetch;
  const base = resolveApiBaseUrl(settings.serverUrl);
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = `${base}${normalizedPath}`;

  const extraHeaders: Record<string, string> = {};
  let body: BodyInit | undefined;

  if (options?.json !== undefined) {
    extraHeaders['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json);
  } else if (options?.formData) {
    body = options.formData;
  }

  const response = await fetchFn(url, {
    method: options?.method ?? 'GET',
    headers: buildAuthHeaders(settings, extraHeaders),
    body,
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json')
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const detail =
      typeof payload === 'object' && payload !== null && 'detail' in payload
        ? String((payload as { detail: unknown }).detail)
        : typeof payload === 'string' && payload
          ? payload
          : `HTTP ${response.status}`;
    throw new SenseiApiError(response.status, detail);
  }

  return payload as T;
}

export const apiClient = {
  getHealth: (settings?: Pick<WebSettings, 'serverUrl' | 'apiToken'>) =>
    apiRequest<Health>('/health', { settings }),

  listEpisodes: () => apiRequest<EpisodeOut[]>('/episodes'),

  getEpisode: (id: number) => apiRequest<EpisodeOut>(`/episodes/${id}`),

  uploadEpisode: (params: {
    subtitle: File;
    animeTitle: string;
    episodeNumber?: number;
    title?: string;
  }) => {
    const formData = new FormData();
    formData.append('subtitle', params.subtitle);
    formData.append('anime_title', params.animeTitle);
    if (params.episodeNumber !== undefined) {
      formData.append('episode_number', String(params.episodeNumber));
    }
    if (params.title) {
      formData.append('title', params.title);
    }
    return apiRequest<EpisodeCreated>('/episodes', {
      method: 'POST',
      formData,
    });
  },

  deleteEpisode: (id: number) => apiRequest<void>(`/episodes/${id}`, { method: 'DELETE' }),

  reprocessEpisode: (id: number) =>
    apiRequest<EpisodeCreated>(`/episodes/${id}/reprocess`, { method: 'POST' }),

  getEpisodeLines: (id: number) => apiRequest<LineOut[]>(`/episodes/${id}/lines`),

  getEpisodeUnderstanding: (id: number) =>
    apiRequest<Understanding>(`/episodes/${id}/understanding`),

  lookupDictionary: (q: string, reading?: string | null, limit = 5) => {
    const params = new URLSearchParams({ q, limit: String(limit) });
    if (reading) params.set('reading', reading);
    return apiRequest<LookupResult>(`/dictionary/lookup?${params.toString()}`);
  },

  listWords: (params?: {
    status?: WordStatus | '';
    animeId?: number | null;
    episodeId?: number | null;
    q?: string;
    limit?: number;
    offset?: number;
  }) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set('status', params.status);
    if (params?.animeId !== undefined && params.animeId !== null) {
      qs.set('anime_id', String(params.animeId));
    }
    if (params?.episodeId !== undefined && params.episodeId !== null) {
      qs.set('episode_id', String(params.episodeId));
    }
    if (params?.q && params.q.trim()) qs.set('q', params.q.trim());
    if (params?.limit !== undefined) qs.set('limit', String(params.limit));
    if (params?.offset !== undefined) qs.set('offset', String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return apiRequest<WordPage>(`/words${suffix}`);
  },

  bulkWordStatus: (wordIds: number[], status: WordStatus) =>
    apiRequest<BulkStatusOut>('/words/bulk-status', {
      method: 'POST',
      json: { word_ids: wordIds, status } satisfies BulkStatusIn,
    }),

  setWordStatus: (wordId: number, status: WordStatus) =>
    apiRequest<WordOut>(`/words/${wordId}/status`, {
      method: 'POST',
      json: { status },
    }),

  createCard: (payload: CardCreate) =>
    apiRequest<CardCreated>('/cards', {
      method: 'POST',
      json: payload,
    }),

  deleteCard: (cardId: number) => apiRequest<void>(`/cards/${cardId}`, { method: 'DELETE' }),

  getDueReviews: (limit = 20) => apiRequest<ReviewQueue>(`/reviews/due?limit=${limit}`),

  submitReview: (payload: ReviewIn) =>
    apiRequest<ReviewOut>('/reviews', {
      method: 'POST',
      json: payload,
    }),

  searchJimaku: (q: string) =>
    apiRequest<JimakuEntry[]>(`/subs/search?${new URLSearchParams({ q }).toString()}`),

  listJimakuFiles: (entryId: number, episode?: number | null) => {
    const qs =
      episode !== undefined && episode !== null
        ? `?episode=${encodeURIComponent(String(episode))}`
        : '';
    return apiRequest<JimakuFile[]>(`/subs/${entryId}/files${qs}`);
  },

  importFromJimaku: (payload: JimakuImport) =>
    apiRequest<EpisodeCreated>('/episodes/from-jimaku', {
      method: 'POST',
      json: payload,
    }),

  getActivity: (params?: { from?: string; to?: string }) => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return apiRequest<ActivityOut>(`/activity${suffix}`);
  },

  listAnime: () => apiRequest<AnimeOut[]>('/anime'),

  getAnimeProgress: (animeId: number) => apiRequest<AnimeProgress>(`/anime/${animeId}/progress`),
};

export type WebConnectionCheck =
  | { state: 'connected'; health: Health }
  | { state: 'unauthorized'; health: Health; message: string }
  | { state: 'unreachable'; message: string };

export async function verifyWebConnection(
  settings: Pick<WebSettings, 'serverUrl' | 'apiToken'>,
  fetchImpl: typeof fetch = fetch,
): Promise<WebConnectionCheck> {
  let health: Health;
  try {
    health = await apiRequest<Health>('/health', { settings, fetchImpl });
  } catch (err) {
    return {
      state: 'unreachable',
      message: err instanceof Error ? err.message : 'Server unreachable',
    };
  }

  if (health.auth) {
    try {
      await apiRequest<EpisodeOut[]>('/episodes', { settings, fetchImpl });
    } catch (err) {
      if (err instanceof SenseiApiError && err.status === 401) {
        return {
          state: 'unauthorized',
          health,
          message: 'Server reachable, but API token is missing or wrong (401).',
        };
      }
      return {
        state: 'unreachable',
        message: err instanceof Error ? err.message : 'Server error',
      };
    }
  }

  return { state: 'connected', health };
}
