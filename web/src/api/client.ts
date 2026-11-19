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

  getEpisodeLines: (id: number) => apiRequest<LineOut[]>(`/episodes/${id}/lines`),

  getEpisodeUnderstanding: (id: number) =>
    apiRequest<Understanding>(`/episodes/${id}/understanding`),

  lookupDictionary: (q: string, reading?: string | null, limit = 5) => {
    const params = new URLSearchParams({ q, limit: String(limit) });
    if (reading) params.set('reading', reading);
    return apiRequest<LookupResult>(`/dictionary/lookup?${params.toString()}`);
  },

  setWordStatus: (wordId: number, status: WordStatus) =>
    apiRequest<WordOut>(`/words/${wordId}/status`, {
      method: 'POST',
      json: { status },
    }),
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
