import type { components, paths } from './schema';
import {
  type ExtensionSettings,
  getSettings,
  isServerUrlConfigured,
  normalizeServerUrl,
} from '../lib/settings';

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
export type CardCreate = components['schemas']['CardCreate'];
export type CardCreated = components['schemas']['CardCreated'];
export type CardOut = components['schemas']['CardOut'];
export type MediaKind = components['schemas']['MediaKind'];
export type MediaOut = components['schemas']['MediaOut'];
export type JimakuEntry = components['schemas']['JimakuEntry'];
export type JimakuFile = components['schemas']['JimakuFile'];
export type JimakuImport = components['schemas']['JimakuImport'];
export type WatchIn = components['schemas']['WatchIn'];
export type WatchOut = components['schemas']['WatchOut'];

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

export interface TabEpisodeState {
  tabId: number | null;
  pageUrl: string;
  pattern: string | null;
  episodeId: number | null;
  enabled: boolean;
}

export interface GetTabStateMessage {
  type: 'SENSEI_GET_TAB_STATE';
  tabId?: number;
  pageUrl?: string;
}

export interface SetTabStateMessage {
  type: 'SENSEI_SET_TAB_STATE';
  tabId: number;
  pageUrl: string;
  episodeId: number | null;
  enabled: boolean;
}

export interface UploadSubtitleMessage {
  type: 'SENSEI_UPLOAD_SUBTITLE';
  filename: string;
  contentBase64: string;
  animeTitle: string;
  episodeNumber?: number | null;
  title?: string | null;
}

export interface UploadMediaMessage {
  type: 'SENSEI_UPLOAD_MEDIA';
  kind: MediaKind;
  filename: string;
  mimeType: string;
  contentBase64: string;
  cardId?: number | null;
}

export interface CaptureVisibleTabMessage {
  type: 'SENSEI_CAPTURE_VISIBLE_TAB';
}

export interface CaptureVisibleTabResponse {
  ok: boolean;
  dataUrl?: string;
  error?: string;
}

export interface TabStateChangedMessage {
  type: 'SENSEI_TAB_STATE_CHANGED';
  state: TabEpisodeState;
}

export function isApiCallMessage(msg: unknown): msg is ApiCallMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'SENSEI_API_CALL' &&
    typeof (msg as { path?: unknown }).path === 'string'
  );
}

export function isGetTabStateMessage(msg: unknown): msg is GetTabStateMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'SENSEI_GET_TAB_STATE'
  );
}

export function isSetTabStateMessage(msg: unknown): msg is SetTabStateMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'SENSEI_SET_TAB_STATE' &&
    typeof (msg as { tabId?: unknown }).tabId === 'number'
  );
}

export function isUploadSubtitleMessage(msg: unknown): msg is UploadSubtitleMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'SENSEI_UPLOAD_SUBTITLE' &&
    typeof (msg as { filename?: unknown }).filename === 'string' &&
    typeof (msg as { contentBase64?: unknown }).contentBase64 === 'string' &&
    typeof (msg as { animeTitle?: unknown }).animeTitle === 'string'
  );
}

export function isUploadMediaMessage(msg: unknown): msg is UploadMediaMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'SENSEI_UPLOAD_MEDIA' &&
    typeof (msg as { kind?: unknown }).kind === 'string' &&
    typeof (msg as { filename?: unknown }).filename === 'string' &&
    typeof (msg as { contentBase64?: unknown }).contentBase64 === 'string'
  );
}

export function isCaptureVisibleTabMessage(msg: unknown): msg is CaptureVisibleTabMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'SENSEI_CAPTURE_VISIBLE_TAB'
  );
}

export function isTabStateChangedMessage(msg: unknown): msg is TabStateChangedMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'SENSEI_TAB_STATE_CHANGED'
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
  if (!isServerUrlConfigured(baseUrl)) {
    return {
      ok: false,
      status: 0,
      error: 'Server URL not configured',
    };
  }
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

export async function executeSubtitleUpload(
  settings: Pick<ExtensionSettings, 'serverUrl' | 'apiToken'>,
  msg: UploadSubtitleMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<ApiCallResponse<EpisodeCreated>> {
  const baseUrl = normalizeServerUrl(settings.serverUrl);
  if (!isServerUrlConfigured(baseUrl)) {
    return {
      ok: false,
      status: 0,
      error: 'Server URL not configured',
    };
  }
  const url = `${baseUrl}/episodes`;
  const headers = buildApiHeaders(settings);
  delete headers['Content-Type'];

  const binary = atob(msg.contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  const form = new FormData();
  form.append('subtitle', new Blob([bytes]), msg.filename);
  form.append('anime_title', msg.animeTitle);
  if (msg.episodeNumber !== undefined && msg.episodeNumber !== null) {
    form.append('episode_number', String(msg.episodeNumber));
  }
  if (msg.title) {
    form.append('title', msg.title);
  }

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: form,
    });
    const contentType = response.headers.get('content-type') ?? '';
    const isJson = contentType.includes('application/json');
    const parsed = isJson ? await response.json() : await response.text();

    if (!response.ok) {
      const detail =
        typeof parsed === 'object' && parsed !== null && 'detail' in parsed
          ? String((parsed as { detail: unknown }).detail)
          : `HTTP ${response.status}`;
      return { ok: false, status: response.status, error: detail };
    }
    return { ok: true, status: response.status, data: parsed as EpisodeCreated };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function executeMediaUpload(
  settings: Pick<ExtensionSettings, 'serverUrl' | 'apiToken'>,
  msg: UploadMediaMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<ApiCallResponse<MediaOut>> {
  const baseUrl = normalizeServerUrl(settings.serverUrl);
  if (!isServerUrlConfigured(baseUrl)) {
    return {
      ok: false,
      status: 0,
      error: 'Server URL not configured',
    };
  }
  const url = `${baseUrl}/media`;
  const headers = buildApiHeaders(settings);
  delete headers['Content-Type'];

  const binary = atob(msg.contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  const form = new FormData();
  form.append('file', new Blob([bytes], { type: msg.mimeType || 'application/octet-stream' }), msg.filename);
  form.append('kind', msg.kind);
  if (msg.cardId !== undefined && msg.cardId !== null) {
    form.append('card_id', String(msg.cardId));
  }

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: form,
    });
    const contentType = response.headers.get('content-type') ?? '';
    const isJson = contentType.includes('application/json');
    const parsed = isJson ? await response.json() : await response.text();

    if (!response.ok) {
      const detail =
        typeof parsed === 'object' && parsed !== null && 'detail' in parsed
          ? String((parsed as { detail: unknown }).detail)
          : `HTTP ${response.status}`;
      return { ok: false, status: response.status, error: detail };
    }
    return { ok: true, status: response.status, data: parsed as MediaOut };
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
    if (isBackgroundContext) {
      const settings = await getSettings();
      return executeApiCall<T>(settings, path, init);
    }

    const runtime = getBrowserRuntime();
    if (!runtime?.sendMessage) {
      return {
        ok: false,
        status: 0,
        error: 'Extension background worker unavailable',
      };
    }

    try {
      const res = (await runtime.sendMessage({
        type: 'SENSEI_API_CALL',
        path,
        init,
      } satisfies ApiCallMessage)) as ApiCallResponse<T> | undefined;
      if (res && typeof res.ok === 'boolean') {
        return res;
      }
      return {
        ok: false,
        status: 0,
        error: 'Extension background worker returned an invalid response',
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        status: 0,
        error: `Extension background worker unavailable: ${detail}`,
      };
    }
  },

  async getTabState(tabId?: number, pageUrl?: string): Promise<TabEpisodeState> {
    const runtime = getBrowserRuntime();
    if (runtime?.sendMessage) {
      const res = (await runtime.sendMessage({
        type: 'SENSEI_GET_TAB_STATE',
        tabId,
        pageUrl,
      } satisfies GetTabStateMessage)) as TabEpisodeState | undefined;
      if (res && typeof res.enabled === 'boolean') {
        return res;
      }
    }
    return { tabId: tabId ?? null, pageUrl: pageUrl ?? '', pattern: null, episodeId: null, enabled: false };
  },

  async setTabState(msg: Omit<SetTabStateMessage, 'type'>): Promise<TabEpisodeState> {
    const runtime = getBrowserRuntime();
    if (runtime?.sendMessage) {
      const res = (await runtime.sendMessage({
        type: 'SENSEI_SET_TAB_STATE',
        ...msg,
      } satisfies SetTabStateMessage)) as TabEpisodeState | undefined;
      if (res && typeof res.enabled === 'boolean') {
        return res;
      }
    }
    return {
      tabId: msg.tabId,
      pageUrl: msg.pageUrl,
      pattern: null,
      episodeId: msg.episodeId,
      enabled: msg.enabled,
    };
  },

  async uploadSubtitle(
    msg: Omit<UploadSubtitleMessage, 'type'>,
  ): Promise<ApiCallResponse<EpisodeCreated>> {
    if (isBackgroundContext) {
      const settings = await getSettings();
      return executeSubtitleUpload(settings, { type: 'SENSEI_UPLOAD_SUBTITLE', ...msg });
    }

    const runtime = getBrowserRuntime();
    if (!runtime?.sendMessage) {
      return {
        ok: false,
        status: 0,
        error: 'Extension background worker unavailable',
      };
    }

    try {
      const res = (await runtime.sendMessage({
        type: 'SENSEI_UPLOAD_SUBTITLE',
        ...msg,
      } satisfies UploadSubtitleMessage)) as ApiCallResponse<EpisodeCreated> | undefined;
      if (res && typeof res.ok === 'boolean') {
        return res;
      }
      return {
        ok: false,
        status: 0,
        error: 'Extension background worker returned an invalid response',
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        status: 0,
        error: `Extension background worker unavailable: ${detail}`,
      };
    }
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

  reprocessEpisode(episodeId: number): Promise<ApiCallResponse<EpisodeCreated>> {
    return api.call<EpisodeCreated>(`/episodes/${episodeId}/reprocess`, {
      method: 'POST',
    });
  },

  createCard(payload: CardCreate): Promise<ApiCallResponse<CardCreated>> {
    return api.call<CardCreated>('/cards', {
      method: 'POST',
      json: payload,
    });
  },

  searchJimaku(q: string): Promise<ApiCallResponse<JimakuEntry[]>> {
    const params = new URLSearchParams({ q });
    return api.call<JimakuEntry[]>(`/subs/search?${params.toString()}`);
  },

  listJimakuFiles(
    entryId: number,
    episode?: number | null,
  ): Promise<ApiCallResponse<JimakuFile[]>> {
    const qs =
      episode !== undefined && episode !== null ? `?episode=${encodeURIComponent(String(episode))}` : '';
    return api.call<JimakuFile[]>(`/subs/${entryId}/files${qs}`);
  },

  importFromJimaku(payload: JimakuImport): Promise<ApiCallResponse<EpisodeCreated>> {
    return api.call<EpisodeCreated>('/episodes/from-jimaku', {
      method: 'POST',
      json: payload,
    });
  },

  sendWatchHeartbeat(payload: WatchIn): Promise<ApiCallResponse<WatchOut>> {
    return api.call<WatchOut>('/activity/watch', {
      method: 'POST',
      json: payload,
    });
  },

  async uploadMedia(
    msg: Omit<UploadMediaMessage, 'type'>,
  ): Promise<ApiCallResponse<MediaOut>> {
    if (isBackgroundContext) {
      const settings = await getSettings();
      return executeMediaUpload(settings, { type: 'SENSEI_UPLOAD_MEDIA', ...msg });
    }

    const runtime = getBrowserRuntime();
    if (!runtime?.sendMessage) {
      return {
        ok: false,
        status: 0,
        error: 'Extension background worker unavailable',
      };
    }

    try {
      const res = (await runtime.sendMessage({
        type: 'SENSEI_UPLOAD_MEDIA',
        ...msg,
      } satisfies UploadMediaMessage)) as ApiCallResponse<MediaOut> | undefined;
      if (res && typeof res.ok === 'boolean') {
        return res;
      }
      return {
        ok: false,
        status: 0,
        error: 'Extension background worker returned an invalid response',
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        status: 0,
        error: `Extension background worker unavailable: ${detail}`,
      };
    }
  },

  async captureVisibleTab(): Promise<CaptureVisibleTabResponse> {
    const runtime = getBrowserRuntime();
    if (!runtime?.sendMessage) {
      return { ok: false, error: 'Extension background worker unavailable' };
    }
    try {
      const res = (await runtime.sendMessage({
        type: 'SENSEI_CAPTURE_VISIBLE_TAB',
      } satisfies CaptureVisibleTabMessage)) as CaptureVisibleTabResponse | undefined;
      if (res && typeof res.ok === 'boolean') {
        return res;
      }
      return { ok: false, error: 'Invalid capture response' };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

export type ConnectionCheckResult =
  | { state: 'unconfigured'; message: string }
  | { state: 'unreachable'; message: string }
  | { state: 'unauthorized'; health: Health; message: string }
  | { state: 'connected'; health: Health };

export async function verifyServerConnection(
  client: Pick<typeof api, 'getHealth' | 'listEpisodes'> = api,
  configuredServerUrl?: string,
): Promise<ConnectionCheckResult> {
  if (configuredServerUrl !== undefined && !isServerUrlConfigured(configuredServerUrl)) {
    return { state: 'unconfigured', message: 'Server URL is not configured yet.' };
  }
  const healthRes = await client.getHealth();
  if (!healthRes.ok || !healthRes.data) {
    return {
      state: 'unreachable',
      message: healthRes.error ?? 'Server unreachable',
    };
  }
  const health = healthRes.data;
  if (health.auth) {
    const authProbe = await client.listEpisodes();
    if (authProbe.status === 401) {
      return {
        state: 'unauthorized',
        health,
        message: 'Server reachable, but API token is missing or wrong (401).',
      };
    }
  }
  return { state: 'connected', health };
}
