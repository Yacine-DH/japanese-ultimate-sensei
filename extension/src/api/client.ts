import type { components, paths } from './schema';
import { type ExtensionSettings, getSettings, normalizeServerUrl } from '../lib/settings';

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

export interface ApiCallInit {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  json?: unknown;
}

export interface ApiCallResponse<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

export interface ApiCallMessage {
  type: 'SENSEI_API_CALL';
  path: string;
  init?: ApiCallInit;
}

export function isApiCallMessage(msg: unknown): msg is ApiCallMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'SENSEI_API_CALL' &&
    typeof (msg as { path?: unknown }).path === 'string'
  );
}

export function buildApiHeaders(
  settings: Pick<ExtensionSettings, 'apiToken'>,
  init?: ApiCallInit,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(init?.headers ?? {}),
  };

  if (init?.json !== undefined && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const token = settings.apiToken.trim();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
    headers['X-Sensei-Token'] = token;
  }

  return headers;
}

export async function executeApiCall<T = unknown>(
  settings: Pick<ExtensionSettings, 'serverUrl' | 'apiToken'>,
  path: string,
  init?: ApiCallInit,
  fetchImpl: typeof fetch = fetch,
): Promise<ApiCallResponse<T>> {
  const baseUrl = normalizeServerUrl(settings.serverUrl);
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = `${baseUrl}${normalizedPath}`;
  const headers = buildApiHeaders(settings, init);
  const body = init?.json !== undefined ? JSON.stringify(init.json) : init?.body;

  try {
    const response = await fetchImpl(url, {
      method: init?.method ?? 'GET',
      headers,
      body,
    });

    if (response.status === 204) {
      return { ok: true, status: 204 };
    }

    const contentType = response.headers.get('content-type') ?? '';
    const isJson = contentType.includes('application/json');
    const parsed = isJson ? await response.json() : await response.text();

    if (!response.ok) {
      const detail =
        typeof parsed === 'object' && parsed !== null && 'detail' in parsed
          ? String((parsed as { detail: unknown }).detail)
          : typeof parsed === 'string' && parsed
            ? parsed
            : `HTTP ${response.status}`;
      return {
        ok: false,
        status: response.status,
        error: detail,
      };
    }

    return {
      ok: true,
      status: response.status,
      data: parsed as T,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

interface RuntimeLike {
  sendMessage(message: unknown): Promise<unknown>;
}

function getBrowserRuntime(): RuntimeLike | null {
  const g = globalThis as unknown as {
    browser?: { runtime?: RuntimeLike };
    chrome?: { runtime?: RuntimeLike };
  };
  return g.browser?.runtime ?? g.chrome?.runtime ?? null;
}

let isBackgroundContext = false;

export function markAsBackgroundContext(): void {
  isBackgroundContext = true;
}

export const api = {
  async call<T = unknown>(path: string, init?: ApiCallInit): Promise<ApiCallResponse<T>> {
    const runtime = getBrowserRuntime();
    if (!isBackgroundContext && runtime?.sendMessage) {
      try {
        const res = (await runtime.sendMessage({
          type: 'SENSEI_API_CALL',
          path,
          init,
        } satisfies ApiCallMessage)) as ApiCallResponse<T> | undefined;
        if (res && typeof res.ok === 'boolean') {
          return res;
        }
      } catch {
        // Fallback to direct call if background worker isn't reachable in current context
      }
    }
    const settings = await getSettings();
    return executeApiCall<T>(settings, path, init);
  },

  getHealth(): Promise<ApiCallResponse<Health>> {
    return api.call<Health>('/health');
  },

  listEpisodes(): Promise<ApiCallResponse<EpisodeOut[]>> {
    return api.call<EpisodeOut[]>('/episodes');
  },

  getEpisode(episodeId: number): Promise<ApiCallResponse<EpisodeOut>> {
    return api.call<EpisodeOut>(`/episodes/${episodeId}`);
  },

  patchEpisode(episodeId: number, patch: EpisodePatch): Promise<ApiCallResponse<EpisodeOut>> {
    return api.call<EpisodeOut>(`/episodes/${episodeId}`, {
      method: 'PATCH',
      json: patch,
    });
  },

  getEpisodeLines(episodeId: number): Promise<ApiCallResponse<LineOut[]>> {
    return api.call<LineOut[]>(`/episodes/${episodeId}/lines`);
  },

  getEpisodeUnderstanding(episodeId: number): Promise<ApiCallResponse<Understanding>> {
    return api.call<Understanding>(`/episodes/${episodeId}/understanding`);
  },

  lookupDictionary(
    q: string,
    reading?: string | null,
    limit = 5,
  ): Promise<ApiCallResponse<LookupResult>> {
    const params = new URLSearchParams({ q, limit: String(limit) });
    if (reading) {
      params.set('reading', reading);
    }
    return api.call<LookupResult>(`/dictionary/lookup?${params.toString()}`);
  },

  setWordStatus(wordId: number, status: WordStatus): Promise<ApiCallResponse<WordOut>> {
    return api.call<WordOut>(`/words/${wordId}/status`, {
      method: 'POST',
      json: { status },
    });
  },
};
