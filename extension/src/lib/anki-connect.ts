import type {
  AnkiModel,
  AnkiNotePayload,
  ApiCallResponse,
} from '../api/client';
import type { ExtensionSettings } from './settings';

export const ANKI_CONNECT_VERSION = 6;
export const ANKI_QUEUE_STORAGE_KEY = 'sensei_anki_push_queue';
export const MAX_ANKI_QUEUE_ITEMS = 200;

export type AnkiErrorKind = 'unreachable' | 'duplicate' | 'api_error';

export class AnkiConnectError extends Error {
  readonly kind: AnkiErrorKind;

  constructor(kind: AnkiErrorKind, message: string) {
    super(message);
    this.name = 'AnkiConnectError';
    this.kind = kind;
  }
}

export function isDuplicateAnkiError(message: string): boolean {
  return /duplicate/i.test(message);
}

export async function invokeAnkiConnect<T = unknown>(
  ankiUrl: string,
  action: string,
  params: Record<string, unknown> = {},
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(ankiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        version: ANKI_CONNECT_VERSION,
        params,
      }),
    });
  } catch (err) {
    throw new AnkiConnectError(
      'unreachable',
      err instanceof Error ? err.message : 'AnkiConnect unreachable',
    );
  }

  if (!response.ok) {
    throw new AnkiConnectError('api_error', `AnkiConnect HTTP ${response.status}`);
  }

  let parsed: { result?: T; error?: string | null };
  try {
    parsed = (await response.json()) as { result?: T; error?: string | null };
  } catch (err) {
    throw new AnkiConnectError(
      'api_error',
      `Invalid AnkiConnect JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (parsed.error) {
    const kind: AnkiErrorKind = isDuplicateAnkiError(parsed.error) ? 'duplicate' : 'api_error';
    throw new AnkiConnectError(kind, parsed.error);
  }

  return parsed.result as T;
}

export interface AnkiConnectionStatus {
  reachable: boolean;
  version?: number;
  decks?: string[];
  models?: string[];
  error?: string;
}

export async function testAnkiConnect(
  ankiUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AnkiConnectionStatus> {
  try {
    const version = await invokeAnkiConnect<number>(ankiUrl, 'version', {}, fetchImpl);
    const [decks, models] = await Promise.all([
      invokeAnkiConnect<string[]>(ankiUrl, 'deckNames', {}, fetchImpl),
      invokeAnkiConnect<string[]>(ankiUrl, 'modelNames', {}, fetchImpl),
    ]);
    return { reachable: true, version, decks, models };
  } catch (err) {
    return {
      reachable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface PushCardResult {
  status: 'pushed' | 'duplicate' | 'queued' | 'disabled' | 'error';
  noteId?: number;
  message?: string;
}

export interface PushCardDeps {
  cardId: number;
  settings: Pick<
    ExtensionSettings,
    'ankiConnectEnabled' | 'ankiConnectUrl' | 'ankiDeckName' | 'ankiModelName'
  >;
  fetchCardNote: (cardId: number, deck: string) => Promise<ApiCallResponse<AnkiNotePayload>>;
  fetchAnkiModel: () => Promise<ApiCallResponse<AnkiModel>>;
  fetchImpl?: typeof fetch;
}

/**
 * Push a saved Sensei card to Anki via AnkiConnect (E-6):
 * 1. Fetch note + signed media URLs from Sensei server (`GET /cards/{id}/anki-note`)
 * 2. Ensure model exists (`modelNames` → `createModel` via `GET /anki/model` if missing)
 * 3. Ensure deck exists (`createDeck`)
 * 4. Store each media file (`storeMediaFile`)
 * 5. Add note (`addNote`), treating duplicate errors as already synced
 */
export async function pushCardToAnki(deps: PushCardDeps): Promise<PushCardResult> {
  const { cardId, settings, fetchCardNote, fetchAnkiModel, fetchImpl = fetch } = deps;
  if (!settings.ankiConnectEnabled) {
    return { status: 'disabled' };
  }

  const deck = settings.ankiDeckName.trim() || 'Sensei';
  const modelName = settings.ankiModelName.trim() || 'Sensei Japanese';

  const noteRes = await fetchCardNote(cardId, deck);
  if (!noteRes.ok || !noteRes.data) {
    return {
      status: 'error',
      message: noteRes.error ?? 'Failed to fetch Anki note payload from server',
    };
  }

  const payload = noteRes.data;

  try {
    const models = await invokeAnkiConnect<string[]>(
      settings.ankiConnectUrl,
      'modelNames',
      {},
      fetchImpl,
    );
    if (!Array.isArray(models) || !models.includes(modelName)) {
      const modelRes = await fetchAnkiModel();
      if (!modelRes.ok || !modelRes.data) {
        return {
          status: 'error',
          message: modelRes.error ?? 'Failed to fetch Sensei Anki note type from server',
        };
      }
      await invokeAnkiConnect(
        settings.ankiConnectUrl,
        'createModel',
        {
          ...modelRes.data,
          modelName,
        },
        fetchImpl,
      );
    }

    await invokeAnkiConnect(settings.ankiConnectUrl, 'createDeck', { deck }, fetchImpl);

    for (const media of payload.media) {
      await invokeAnkiConnect(
        settings.ankiConnectUrl,
        'storeMediaFile',
        {
          filename: media.filename,
          url: media.url,
        },
        fetchImpl,
      );
    }

    const noteId = await invokeAnkiConnect<number>(
      settings.ankiConnectUrl,
      'addNote',
      {
        note: {
          ...payload.note,
          deckName: deck,
          modelName,
        },
      },
      fetchImpl,
    );

    return { status: 'pushed', noteId };
  } catch (err) {
    if (err instanceof AnkiConnectError) {
      if (err.kind === 'duplicate') {
        return { status: 'duplicate', message: err.message };
      }
      if (err.kind === 'unreachable') {
        return { status: 'queued', message: 'Anki is not running; queued for retry' };
      }
      return { status: 'error', message: err.message };
    }
    return { status: 'queued', message: err instanceof Error ? err.message : String(err) };
  }
}

export interface QueuedAnkiCard {
  cardId: number;
  enqueuedAt: number;
  attempts: number;
  lastError?: string;
}

export interface LocalStorageLike {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface FlushQueueSummary {
  ankiReachable: boolean;
  pushed: number;
  duplicates: number;
  remaining: number;
  errors: number;
}

export class AnkiPushQueue {
  private memoryQueue: QueuedAnkiCard[] = [];
  private readonly storage: LocalStorageLike | null;

  constructor(storage: LocalStorageLike | null = null) {
    this.storage = storage;
  }

  async list(): Promise<QueuedAnkiCard[]> {
    if (!this.storage) {
      return [...this.memoryQueue];
    }
    const raw = await this.storage.get(ANKI_QUEUE_STORAGE_KEY);
    const arr = raw?.[ANKI_QUEUE_STORAGE_KEY];
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (item): item is QueuedAnkiCard =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as { cardId?: unknown }).cardId === 'number',
    );
  }

  private async save(items: QueuedAnkiCard[]): Promise<void> {
    const trimmed = items.slice(-MAX_ANKI_QUEUE_ITEMS);
    if (!this.storage) {
      this.memoryQueue = trimmed;
      return;
    }
    await this.storage.set({ [ANKI_QUEUE_STORAGE_KEY]: trimmed });
  }

  async enqueue(cardId: number, lastError?: string, nowMs = Date.now()): Promise<number> {
    const items = await this.list();
    const existing = items.find((i) => i.cardId === cardId);
    if (existing) {
      existing.attempts += 1;
      existing.lastError = lastError;
    } else {
      items.push({ cardId, enqueuedAt: nowMs, attempts: 1, lastError });
    }
    await this.save(items);
    return items.length;
  }

  async remove(cardId: number): Promise<number> {
    const items = (await this.list()).filter((i) => i.cardId !== cardId);
    await this.save(items);
    return items.length;
  }

  async flush(deps: Omit<PushCardDeps, 'cardId'>): Promise<FlushQueueSummary> {
    const items = await this.list();
    if (items.length === 0) {
      return { ankiReachable: true, pushed: 0, duplicates: 0, remaining: 0, errors: 0 };
    }
    if (!deps.settings.ankiConnectEnabled) {
      return { ankiReachable: false, pushed: 0, duplicates: 0, remaining: items.length, errors: 0 };
    }

    const fetchImpl = deps.fetchImpl ?? fetch;
    // Quick probe before looping through queued cards
    try {
      await invokeAnkiConnect<number>(deps.settings.ankiConnectUrl, 'version', {}, fetchImpl);
    } catch {
      return { ankiReachable: false, pushed: 0, duplicates: 0, remaining: items.length, errors: 0 };
    }

    let pushed = 0;
    let duplicates = 0;
    let errors = 0;
    const remaining: QueuedAnkiCard[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item) continue;
      const res = await pushCardToAnki({ ...deps, cardId: item.cardId });
      if (res.status === 'pushed') {
        pushed += 1;
      } else if (res.status === 'duplicate') {
        duplicates += 1;
      } else if (res.status === 'queued') {
        // Anki went offline mid-flush: preserve this item and the rest of the queue
        remaining.push({ ...item, attempts: item.attempts + 1, lastError: res.message });
        remaining.push(...items.slice(i + 1));
        await this.save(remaining);
        return {
          ankiReachable: false,
          pushed,
          duplicates,
          remaining: remaining.length,
          errors,
        };
      } else {
        errors += 1;
        // Keep up to 5 retries for non-offline errors
        if (item.attempts < 5) {
          remaining.push({ ...item, attempts: item.attempts + 1, lastError: res.message });
        }
      }
    }

    await this.save(remaining);
    return {
      ankiReachable: true,
      pushed,
      duplicates,
      remaining: remaining.length,
      errors,
    };
  }
}
