import type { components, paths } from './schema';
import type { AutoAttachNotice } from '../lib/auto-attach';
import type { PopupUpdateUiState } from '../lib/native-updater';
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
export type AutoImport = components['schemas']['AutoImport'];
export type AutoImportOut = components['schemas']['AutoImportOut'];
export type WatchIn = components['schemas']['WatchIn'];
export type WatchOut = components['schemas']['WatchOut'];
export type AnkiModel = components['schemas']['AnkiModel'];
export type AnkiNotePayload = components['schemas']['AnkiNotePayload'];
export type AnkiConnectNote = components['schemas']['AnkiConnectNote'];
export type AnkiMediaFile = components['schemas']['AnkiMediaFile'];
export type AnkiCardIn = components['schemas']['AnkiCardIn'];
export type AnkiCardsImport = components['schemas']['AnkiCardsImport'];
export type ImportReport = components['schemas']['ImportReport'];
export type BulkStatusIn = components['schemas']['BulkStatusIn'];
export type BulkStatusOut = components['schemas']['BulkStatusOut'];
export type ExampleLine = components['schemas']['ExampleLine'];
export type MissedWord = components['schemas']['MissedWord'];
export type LLMStatus = components['schemas']['LLMStatus'];
export type TranslationJob = components['schemas']['TranslationJob'];
export type LineExplanation = components['schemas']['LineExplanation'];
export type SyncOut = components['schemas']['SyncOut'];
export type SyncPoint = components['schemas']['SyncPoint'];

export interface ApiCallInit {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  json?: unknown;
  cache?: RequestCache;
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
  autoAttachStatus?: 'idle' | 'loading' | 'attached' | 'error';
  autoAttachNotice?: AutoAttachNotice | null;
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
  animeId?: number | null;
}

export interface AutoAttachNoticeMessage {
  type: 'SENSEI_AUTO_ATTACH_NOTICE';
  notice: AutoAttachNotice;
}

export interface TriggerAutoAttachMessage {
  type: 'SENSEI_TRIGGER_AUTO_ATTACH';
  tabId: number;
  pageUrl: string;
  pageTitle: string;
}

export interface TriggerAutoAttachResponse {
  status: 'attached' | 'error' | 'skipped';
  episode?: EpisodeCreated;
  error?: string;
  httpStatus?: number;
}

export interface OpenPopupSearchMessage {
  type: 'SENSEI_OPEN_POPUP_SEARCH';
}

export interface OpenPopupSearchResponse {
  ok: boolean;
}

export interface ConsumeManualSearchFlagMessage {
  type: 'SENSEI_CONSUME_MANUAL_SEARCH_FLAG';
  tabId: number;
}

export interface ConsumeAutoAttachNoticeMessage {
  type: 'SENSEI_CONSUME_AUTO_ATTACH_NOTICE';
  noticeId: string;
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

export interface OpenMissedPanelMessage {
  type: 'SENSEI_OPEN_MISSED_PANEL';
}

export interface StartAutoSyncMessage {
  type: 'SENSEI_START_AUTO_SYNC';
}

export interface StartAutoSyncResponse {
  ok: boolean;
  error?: string;
}

export interface SyncEpisodeMessage {
  type: 'SENSEI_SYNC_EPISODE';
  episodeId: number;
  filename: string;
  mimeType: string;
  contentBase64: string;
  videoStartMs: number;
  apply?: boolean;
  searchMs?: number;
}

export interface EpisodeSyncUpdatedMessage {
  type: 'SENSEI_EPISODE_SYNC_UPDATED';
  episodeId: number;
  subOffsetMs: number;
  syncPoints: SyncPoint[];
}

export interface AnkiPushCardMessage {
  type: 'SENSEI_ANKI_PUSH_CARD';
  cardId: number;
}

export interface AnkiPushCardResponse {
  status: 'pushed' | 'duplicate' | 'queued' | 'disabled' | 'error';
  noteId?: number;
  message?: string;
  queueLength: number;
}

export interface AnkiFlushQueueMessage {
  type: 'SENSEI_ANKI_FLUSH_QUEUE';
}

export interface AnkiFlushQueueResponse {
  ankiReachable: boolean;
  pushed: number;
  duplicates: number;
  remaining: number;
  errors: number;
}

export interface AnkiTestMessage {
  type: 'SENSEI_ANKI_TEST';
  url?: string;
}

export interface AnkiTestResponse {
  reachable: boolean;
  version?: number;
  decks?: string[];
  models?: string[];
  queueLength: number;
  error?: string;
}

export interface AnkiImportDeckMessage {
  type: 'SENSEI_ANKI_IMPORT_DECK';
  deck: string;
  fieldName?: string;
  matureDays?: number;
  dryRun: boolean;
}

export interface AnkiImportDeckResponse {
  ok: boolean;
  report?: ImportReport;
  fields?: string[];
  fieldUsed?: string;
  cardCount?: number;
  error?: string;
}

export interface StartNativeUpdateMessage {
  type: 'SENSEI_START_NATIVE_UPDATE';
}

export interface GetNativeUpdateStateMessage {
  type: 'SENSEI_GET_NATIVE_UPDATE_STATE';
}

export interface NativeUpdateStateChangedMessage {
  type: 'SENSEI_NATIVE_UPDATE_STATE_CHANGED';
  state: PopupUpdateUiState;
}

export interface NativeUpdateStateResponse {
  state: PopupUpdateUiState | null;
  error?: string;
}

export interface ClaimUnconfiguredHintMessage {
  type: 'SENSEI_CLAIM_UNCONFIGURED_HINT';
}

export interface ClaimUnconfiguredHintResponse {
  show: boolean;
}

export interface OpenSetupPopupMessage {
  type: 'SENSEI_OPEN_SETUP_POPUP';
}

export interface OpenSetupPopupResponse {
  ok: boolean;
  opened: 'popup' | 'options' | 'none';
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

export function isAutoAttachNoticeMessage(msg: unknown): msg is AutoAttachNoticeMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'SENSEI_AUTO_ATTACH_NOTICE'
  );
}

export function isTriggerAutoAttachMessage(msg: unknown): msg is TriggerAutoAttachMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'SENSEI_TRIGGER_AUTO_ATTACH' &&
    typeof (msg as { tabId?: unknown }).tabId === 'number' &&
    typeof (msg as { pageUrl?: unknown }).pageUrl === 'string'
  );
}

export function isOpenPopupSearchMessage(msg: unknown): msg is OpenPopupSearchMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'SENSEI_OPEN_POPUP_SEARCH'
  );
}

export function isConsumeManualSearchFlagMessage(
  msg: unknown,
): msg is ConsumeManualSearchFlagMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'SENSEI_CONSUME_MANUAL_SEARCH_FLAG' &&
    typeof (msg as { tabId?: unknown }).tabId === 'number'
  );
}

export function isConsumeAutoAttachNoticeMessage(
  msg: unknown,
): msg is ConsumeAutoAttachNoticeMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'SENSEI_CONSUME_AUTO_ATTACH_NOTICE' &&
    typeof (msg as { noticeId?: unknown }).noticeId === 'string'
  );
}

export function isOpenMissedPanelMessage(msg: unknown): msg is OpenMissedPanelMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'SENSEI_OPEN_MISSED_PANEL'
  );
}

export function isStartAutoSyncMessage(msg: unknown): msg is StartAutoSyncMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'SENSEI_START_AUTO_SYNC'
  );
}

export function isSyncEpisodeMessage(msg: unknown): msg is SyncEpisodeMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'SENSEI_SYNC_EPISODE' &&
    typeof (msg as { episodeId?: unknown }).episodeId === 'number' &&
    typeof (msg as { filename?: unknown }).filename === 'string' &&
    typeof (msg as { contentBase64?: unknown }).contentBase64 === 'string' &&
    typeof (msg as { videoStartMs?: unknown }).videoStartMs === 'number'
  );
}

export function isEpisodeSyncUpdatedMessage(msg: unknown): msg is EpisodeSyncUpdatedMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'SENSEI_EPISODE_SYNC_UPDATED' &&
    typeof (msg as { episodeId?: unknown }).episodeId === 'number' &&
    typeof (msg as { subOffsetMs?: unknown }).subOffsetMs === 'number' &&
    Array.isArray((msg as { syncPoints?: unknown }).syncPoints)
  );
}

export function isAnkiPushCardMessage(msg: unknown): msg is AnkiPushCardMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'SENSEI_ANKI_PUSH_CARD' &&
    typeof (msg as { cardId?: unknown }).cardId === 'number'
  );
}

export function isAnkiFlushQueueMessage(msg: unknown): msg is AnkiFlushQueueMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'SENSEI_ANKI_FLUSH_QUEUE'
  );
}

export function isAnkiTestMessage(msg: unknown): msg is AnkiTestMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'SENSEI_ANKI_TEST'
  );
}

export function isAnkiImportDeckMessage(msg: unknown): msg is AnkiImportDeckMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'SENSEI_ANKI_IMPORT_DECK' &&
    typeof (msg as { deck?: unknown }).deck === 'string'
  );
}

export function isStartNativeUpdateMessage(msg: unknown): msg is StartNativeUpdateMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'SENSEI_START_NATIVE_UPDATE'
  );
}

export function isGetNativeUpdateStateMessage(msg: unknown): msg is GetNativeUpdateStateMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'SENSEI_GET_NATIVE_UPDATE_STATE'
  );
}

export function isClaimUnconfiguredHintMessage(
  msg: unknown,
): msg is ClaimUnconfiguredHintMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'SENSEI_CLAIM_UNCONFIGURED_HINT'
  );
}

export function isOpenSetupPopupMessage(msg: unknown): msg is OpenSetupPopupMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'SENSEI_OPEN_SETUP_POPUP'
  );
}

export function isNativeUpdateStateChangedMessage(
  msg: unknown,
): msg is NativeUpdateStateChangedMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'SENSEI_NATIVE_UPDATE_STATE_CHANGED' &&
    typeof (msg as { state?: unknown }).state === 'object' &&
    (msg as { state?: unknown }).state !== null
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
    const fetchInit: RequestInit = {
      method: init?.method ?? 'GET',
      headers,
      body,
    };
    if (init?.cache) {
      fetchInit.cache = init.cache;
    }
    const response = await fetchImpl(url, fetchInit);

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

function extractApiErrorDetail(parsed: unknown, status: number): string {
  if (typeof parsed === 'object' && parsed !== null && 'detail' in parsed) {
    const detail = (parsed as { detail: unknown }).detail;
    if (typeof detail === 'string' && detail.trim()) {
      return detail;
    }
    if (Array.isArray(detail) && detail.length > 0) {
      const msgs = detail
        .map((item) =>
          typeof item === 'object' && item !== null && 'msg' in item
            ? String((item as { msg: unknown }).msg)
            : String(item),
        )
        .filter(Boolean);
      if (msgs.length > 0) {
        return msgs.join('; ');
      }
    }
    return String(detail);
  }
  if (typeof parsed === 'string' && parsed.trim()) {
    return parsed;
  }
  return `HTTP ${status}`;
}

export async function executeSyncEpisode(
  settings: Pick<ExtensionSettings, 'serverUrl' | 'apiToken'>,
  msg: SyncEpisodeMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<ApiCallResponse<SyncOut>> {
  const baseUrl = normalizeServerUrl(settings.serverUrl);
  if (!isServerUrlConfigured(baseUrl)) {
    return {
      ok: false,
      status: 0,
      error: 'Server URL not configured',
    };
  }
  const url = `${baseUrl}/episodes/${msg.episodeId}/sync`;
  const headers = buildApiHeaders(settings);
  delete headers['Content-Type'];

  const binary = atob(msg.contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  const form = new FormData();
  form.append(
    'file',
    new Blob([bytes], { type: msg.mimeType || 'audio/webm' }),
    msg.filename,
  );
  form.append('video_start_ms', String(Math.max(0, Math.round(msg.videoStartMs))));
  form.append('apply', (msg.apply ?? true) ? 'true' : 'false');
  if (msg.searchMs !== undefined) {
    form.append('search_ms', String(Math.max(10_000, Math.round(msg.searchMs))));
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
      return {
        ok: false,
        status: response.status,
        error: extractApiErrorDetail(parsed, response.status),
      };
    }
    return { ok: true, status: response.status, data: parsed as SyncOut };
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

  getExtensionVersion(): Promise<ApiCallResponse<unknown>> {
    return api.call<unknown>('/downloads/version.json', { cache: 'no-store' });
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

  getEpisodeMissedWords(
    episodeId: number,
    limit = 30,
    includeLearning = false,
  ): Promise<ApiCallResponse<MissedWord[]>> {
    const params = new URLSearchParams({
      limit: String(limit),
      include_learning: includeLearning ? 'true' : 'false',
    });
    return api.call<MissedWord[]>(`/episodes/${episodeId}/missed?${params.toString()}`);
  },

  getLlmStatus(): Promise<ApiCallResponse<LLMStatus>> {
    return api.call<LLMStatus>('/llm/status');
  },

  getTranslationJob(episodeId: number): Promise<ApiCallResponse<TranslationJob>> {
    return api.call<TranslationJob>(`/episodes/${episodeId}/translate`);
  },

  explainLine(
    lineId: number,
    lang: 'en' | 'de' = 'en',
    refresh = false,
  ): Promise<ApiCallResponse<LineExplanation>> {
    const params = new URLSearchParams({ lang });
    if (refresh) params.set('refresh', 'true');
    return api.call<LineExplanation>(`/lines/${lineId}/explain?${params.toString()}`, {
      method: 'POST',
    });
  },

  lookupDictionary(
    q: string,
    reading?: string | null,
    limit = 5,
    wordId?: number | null,
  ): Promise<ApiCallResponse<LookupResult>> {
    const params = new URLSearchParams({ q, limit: String(limit) });
    if (reading) {
      params.set('reading', reading);
    }
    if (wordId !== undefined && wordId !== null) {
      params.set('word_id', String(wordId));
    }
    return api.call<LookupResult>(`/dictionary/lookup?${params.toString()}`);
  },

  setWordStatus(wordId: number, status: WordStatus): Promise<ApiCallResponse<WordOut>> {
    return api.call<WordOut>(`/words/${wordId}/status`, {
      method: 'POST',
      json: { status },
    });
  },

  bulkWordStatus(wordIds: number[], status: WordStatus): Promise<ApiCallResponse<BulkStatusOut>> {
    return api.call<BulkStatusOut>('/words/bulk-status', {
      method: 'POST',
      json: { word_ids: wordIds, status } satisfies BulkStatusIn,
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

  autoImportEpisode(payload: AutoImport): Promise<ApiCallResponse<AutoImportOut>> {
    return api.call<AutoImportOut>('/episodes/auto', {
      method: 'POST',
      json: payload,
    });
  },

  async triggerAutoAttach(
    tabId: number,
    pageUrl: string,
    pageTitle: string,
  ): Promise<TriggerAutoAttachResponse> {
    const runtime = getBrowserRuntime();
    if (!runtime?.sendMessage) {
      return { status: 'skipped' };
    }
    try {
      const res = (await runtime.sendMessage({
        type: 'SENSEI_TRIGGER_AUTO_ATTACH',
        tabId,
        pageUrl,
        pageTitle,
      } satisfies TriggerAutoAttachMessage)) as TriggerAutoAttachResponse | undefined;
      if (res && typeof res.status === 'string') {
        return res;
      }
      return { status: 'skipped' };
    } catch (err) {
      return {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async openPopupSearch(): Promise<OpenPopupSearchResponse> {
    const runtime = getBrowserRuntime();
    if (!runtime?.sendMessage) {
      return { ok: false };
    }
    try {
      const res = (await runtime.sendMessage({
        type: 'SENSEI_OPEN_POPUP_SEARCH',
      } satisfies OpenPopupSearchMessage)) as OpenPopupSearchResponse | undefined;
      return { ok: Boolean(res?.ok) };
    } catch {
      return { ok: false };
    }
  },

  async consumeManualSearchFlag(tabId: number): Promise<boolean> {
    const runtime = getBrowserRuntime();
    if (!runtime?.sendMessage) {
      return false;
    }
    try {
      const res = (await runtime.sendMessage({
        type: 'SENSEI_CONSUME_MANUAL_SEARCH_FLAG',
        tabId,
      } satisfies ConsumeManualSearchFlagMessage)) as { openManualSearch?: boolean } | undefined;
      return Boolean(res?.openManualSearch);
    } catch {
      return false;
    }
  },

  async consumeAutoAttachNotice(noticeId: string): Promise<void> {
    const runtime = getBrowserRuntime();
    if (!runtime?.sendMessage) {
      return;
    }
    try {
      await runtime.sendMessage({
        type: 'SENSEI_CONSUME_AUTO_ATTACH_NOTICE',
        noticeId,
      } satisfies ConsumeAutoAttachNoticeMessage);
    } catch {
      // Ignore background unavailability
    }
  },

  sendWatchHeartbeat(payload: WatchIn): Promise<ApiCallResponse<WatchOut>> {
    return api.call<WatchOut>('/activity/watch', {
      method: 'POST',
      json: payload,
    });
  },

  getAnkiModel(): Promise<ApiCallResponse<AnkiModel>> {
    return api.call<AnkiModel>('/anki/model');
  },

  getAnkiNote(cardId: number, deck = 'Sensei'): Promise<ApiCallResponse<AnkiNotePayload>> {
    const params = new URLSearchParams({ deck });
    return api.call<AnkiNotePayload>(`/cards/${cardId}/anki-note?${params.toString()}`);
  },

  async pushCardToAnki(cardId: number): Promise<AnkiPushCardResponse> {
    const runtime = getBrowserRuntime();
    if (!runtime?.sendMessage) {
      return { status: 'error', message: 'Extension background worker unavailable', queueLength: 0 };
    }
    try {
      const res = (await runtime.sendMessage({
        type: 'SENSEI_ANKI_PUSH_CARD',
        cardId,
      } satisfies AnkiPushCardMessage)) as AnkiPushCardResponse | undefined;
      if (res && typeof res.status === 'string') {
        return res;
      }
      return { status: 'error', message: 'Invalid Anki push response', queueLength: 0 };
    } catch (err) {
      return {
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
        queueLength: 0,
      };
    }
  },

  async flushAnkiQueue(): Promise<AnkiFlushQueueResponse> {
    const runtime = getBrowserRuntime();
    if (!runtime?.sendMessage) {
      return { ankiReachable: false, pushed: 0, duplicates: 0, remaining: 0, errors: 0 };
    }
    try {
      const res = (await runtime.sendMessage({
        type: 'SENSEI_ANKI_FLUSH_QUEUE',
      } satisfies AnkiFlushQueueMessage)) as AnkiFlushQueueResponse | undefined;
      if (res && typeof res.ankiReachable === 'boolean') {
        return res;
      }
      return { ankiReachable: false, pushed: 0, duplicates: 0, remaining: 0, errors: 0 };
    } catch {
      return { ankiReachable: false, pushed: 0, duplicates: 0, remaining: 0, errors: 0 };
    }
  },

  async testAnkiConnect(url?: string): Promise<AnkiTestResponse> {
    const runtime = getBrowserRuntime();
    if (!runtime?.sendMessage) {
      return { reachable: false, queueLength: 0, error: 'Extension background worker unavailable' };
    }
    try {
      const res = (await runtime.sendMessage({
        type: 'SENSEI_ANKI_TEST',
        url,
      } satisfies AnkiTestMessage)) as AnkiTestResponse | undefined;
      if (res && typeof res.reachable === 'boolean') {
        return res;
      }
      return { reachable: false, queueLength: 0, error: 'Invalid Anki test response' };
    } catch (err) {
      return {
        reachable: false,
        queueLength: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async importAnkiDeck(msg: Omit<AnkiImportDeckMessage, 'type'>): Promise<AnkiImportDeckResponse> {
    const runtime = getBrowserRuntime();
    if (!runtime?.sendMessage) {
      return { ok: false, error: 'Extension background worker unavailable' };
    }
    try {
      const res = (await runtime.sendMessage({
        type: 'SENSEI_ANKI_IMPORT_DECK',
        ...msg,
      } satisfies AnkiImportDeckMessage)) as AnkiImportDeckResponse | undefined;
      if (res && typeof res.ok === 'boolean') {
        return res;
      }
      return { ok: false, error: 'Invalid Anki import response' };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
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

  async syncEpisode(
    msg: Omit<SyncEpisodeMessage, 'type'>,
  ): Promise<ApiCallResponse<SyncOut>> {
    if (isBackgroundContext) {
      const settings = await getSettings();
      return executeSyncEpisode(settings, { type: 'SENSEI_SYNC_EPISODE', ...msg });
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
        type: 'SENSEI_SYNC_EPISODE',
        ...msg,
      } satisfies SyncEpisodeMessage)) as ApiCallResponse<SyncOut> | undefined;
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

  async startNativeUpdate(): Promise<NativeUpdateStateResponse> {
    const runtime = getBrowserRuntime();
    if (!runtime?.sendMessage) {
      return { state: null, error: 'Extension background worker unavailable' };
    }
    try {
      const res = (await runtime.sendMessage({
        type: 'SENSEI_START_NATIVE_UPDATE',
      } satisfies StartNativeUpdateMessage)) as NativeUpdateStateResponse | undefined;
      if (res && 'state' in res) {
        return res;
      }
      return { state: null, error: 'Invalid update response from background worker' };
    } catch (err) {
      return {
        state: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async getNativeUpdateState(): Promise<NativeUpdateStateResponse> {
    const runtime = getBrowserRuntime();
    if (!runtime?.sendMessage) {
      return { state: null };
    }
    try {
      const res = (await runtime.sendMessage({
        type: 'SENSEI_GET_NATIVE_UPDATE_STATE',
      } satisfies GetNativeUpdateStateMessage)) as NativeUpdateStateResponse | undefined;
      if (res && 'state' in res) {
        return res;
      }
      return { state: null };
    } catch {
      return { state: null };
    }
  },

  async claimUnconfiguredHint(): Promise<ClaimUnconfiguredHintResponse> {
    const runtime = getBrowserRuntime();
    if (!runtime?.sendMessage) {
      return { show: false };
    }
    try {
      const res = (await runtime.sendMessage({
        type: 'SENSEI_CLAIM_UNCONFIGURED_HINT',
      } satisfies ClaimUnconfiguredHintMessage)) as ClaimUnconfiguredHintResponse | undefined;
      if (res && typeof res.show === 'boolean') {
        return res;
      }
      return { show: false };
    } catch {
      return { show: false };
    }
  },

  async openSetupPopup(): Promise<OpenSetupPopupResponse> {
    const runtime = getBrowserRuntime();
    if (!runtime?.sendMessage) {
      return { ok: false, opened: 'none' };
    }
    try {
      const res = (await runtime.sendMessage({
        type: 'SENSEI_OPEN_SETUP_POPUP',
      } satisfies OpenSetupPopupMessage)) as OpenSetupPopupResponse | undefined;
      if (res && typeof res.ok === 'boolean') {
        return res;
      }
      return { ok: false, opened: 'none' };
    } catch {
      return { ok: false, opened: 'none' };
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
