import type {
  AnkiCardIn,
  AnkiCardsImport,
  AnkiImportDeckResponse,
  AnkiModel,
  AnkiNotePayload,
  ApiCallResponse,
  ImportReport,
} from '../api/client';
import type { ExtensionSettings } from './settings';

export const ANKI_CONNECT_VERSION = 6;
export const ANKI_QUEUE_STORAGE_KEY = 'sensei_anki_push_queue';
export const MAX_ANKI_QUEUE_ITEMS = 200;
export const ANKI_IMPORT_CHUNK_SIZE = 5000;
const ANKI_CARDS_INFO_BATCH = 1000;
const FIELD_HINT_RE = /expression|vocab|word|kanji|term|japanese|front|単語|語彙|表現|日本語/i;

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
  /** Optional per-session cache of ensured `(ankiUrl, modelName)` keys; defaults to module cache. */
  ensuredModels?: Set<string>;
}

const sessionEnsuredModels = new Set<string>();
const inFlightEnsuresByCache = new WeakMap<Set<string>, Map<string, Promise<string | null>>>();

function buildModelCacheKey(ankiUrl: string, modelName: string): string {
  return `${ankiUrl.trim().replace(/\/+$/, '')}\0${modelName}`;
}

function getInFlightMap(cache: Set<string>): Map<string, Promise<string | null>> {
  let map = inFlightEnsuresByCache.get(cache);
  if (!map) {
    map = new Map<string, Promise<string | null>>();
    inFlightEnsuresByCache.set(cache, map);
  }
  return map;
}

/** Reset the in-memory session cache of ensured/upgraded Anki note types (useful in tests). */
export function resetAnkiModelCache(): void {
  sessionEnsuredModels.clear();
  inFlightEnsuresByCache.delete(sessionEnsuredModels);
}

/**
 * Ensure the Sensei note type exists in Anki and has every field/template/CSS from `GET /anki/model`.
 * - Missing model → `createModel`.
 * - Existing model → `modelFieldNames`; for any missing field in `inOrderFields`, call
 *   `modelFieldAdd {modelName, fieldName, index}`, and if any field was added, update
 *   templates (`updateModelTemplates`) and CSS (`updateModelStyling`).
 * - Cached once per session per `(ankiUrl, modelName)` once verified/upgraded.
 * Returns `null` on success, or a server-error message if `GET /anki/model` failed.
 */
async function ensureAnkiModel(
  ankiUrl: string,
  modelName: string,
  fetchAnkiModel: () => Promise<ApiCallResponse<AnkiModel>>,
  fetchImpl: typeof fetch,
  cache: Set<string>,
): Promise<string | null> {
  const cacheKey = buildModelCacheKey(ankiUrl, modelName);
  if (cache.has(cacheKey)) {
    return null;
  }

  const inFlightMap = getInFlightMap(cache);
  const existingPromise = inFlightMap.get(cacheKey);
  if (existingPromise) {
    return existingPromise;
  }

  const task = (async (): Promise<string | null> => {
    const models = await invokeAnkiConnect<string[]>(ankiUrl, 'modelNames', {}, fetchImpl);
    const modelRes = await fetchAnkiModel();
    if (!modelRes.ok || !modelRes.data) {
      return modelRes.error ?? 'Failed to fetch Sensei Anki note type from server';
    }
    const serverModel = modelRes.data;

    if (!Array.isArray(models) || !models.includes(modelName)) {
      await invokeAnkiConnect(
        ankiUrl,
        'createModel',
        {
          ...serverModel,
          modelName,
        },
        fetchImpl,
      );
      cache.add(cacheKey);
      return null;
    }

    const rawFieldNames = await invokeAnkiConnect<string[]>(
      ankiUrl,
      'modelFieldNames',
      { modelName },
      fetchImpl,
    );
    const existingFields = Array.isArray(rawFieldNames) ? rawFieldNames : [];
    const existingFieldSet = new Set(existingFields);
    let currentFieldCount = existingFields.length;
    let addedAnyField = false;

    for (let expectedIndex = 0; expectedIndex < serverModel.inOrderFields.length; expectedIndex++) {
      const fieldName = serverModel.inOrderFields[expectedIndex]!;
      if (existingFieldSet.has(fieldName)) {
        continue;
      }
      await invokeAnkiConnect(
        ankiUrl,
        'modelFieldAdd',
        {
          modelName,
          fieldName,
          index: Math.min(expectedIndex, currentFieldCount),
        },
        fetchImpl,
      );
      existingFieldSet.add(fieldName);
      currentFieldCount += 1;
      addedAnyField = true;
    }

    if (addedAnyField) {
      const templates: Record<string, { Front: string; Back: string }> = {};
      for (const tpl of serverModel.cardTemplates) {
        templates[tpl.Name] = { Front: tpl.Front, Back: tpl.Back };
      }
      await invokeAnkiConnect(
        ankiUrl,
        'updateModelTemplates',
        {
          model: {
            name: modelName,
            templates,
          },
        },
        fetchImpl,
      );
      await invokeAnkiConnect(
        ankiUrl,
        'updateModelStyling',
        {
          model: {
            name: modelName,
            css: serverModel.css,
          },
        },
        fetchImpl,
      );
    }

    cache.add(cacheKey);
    return null;
  })();

  inFlightMap.set(cacheKey, task);
  try {
    return await task;
  } finally {
    inFlightMap.delete(cacheKey);
  }
}

/**
 * Push a saved Sensei card to Anki via AnkiConnect (E-6, E-19):
 * 1. Fetch note + signed media URLs from Sensei server (`GET /cards/{id}/anki-note`)
 * 2. Ensure model exists & is upgraded with any new fields/templates/CSS (once per session)
 * 3. Ensure deck exists (`createDeck`)
 * 4. Store each media file (`storeMediaFile`)
 * 5. Add note (`addNote`), treating duplicate errors as already synced
 */
export async function pushCardToAnki(deps: PushCardDeps): Promise<PushCardResult> {
  const {
    cardId,
    settings,
    fetchCardNote,
    fetchAnkiModel,
    fetchImpl = fetch,
    ensuredModels = sessionEnsuredModels,
  } = deps;
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
    const modelError = await ensureAnkiModel(
      settings.ankiConnectUrl,
      modelName,
      fetchAnkiModel,
      fetchImpl,
      ensuredModels,
    );
    if (modelError) {
      return {
        status: 'error',
        message: modelError,
      };
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
      if (/model was not found/i.test(err.message)) {
        ensuredModels.delete(buildModelCacheKey(settings.ankiConnectUrl, modelName));
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

export function pickExpressionFieldName(
  fieldNames: readonly string[],
  preferred?: string,
): string {
  const wanted = preferred?.trim();
  if (wanted) {
    const exact = fieldNames.find((f) => f.toLowerCase() === wanted.toLowerCase());
    if (exact) return exact;
  }
  const hinted = fieldNames.find((f) => FIELD_HINT_RE.test(f));
  return hinted ?? fieldNames[0] ?? '';
}

export function chunkArray<T>(items: readonly T[], size = ANKI_IMPORT_CHUNK_SIZE): T[][] {
  const safeSize = Math.max(1, size);
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += safeSize) {
    chunks.push(items.slice(i, i + safeSize));
  }
  return chunks;
}

interface AnkiConnectCardInfo {
  interval?: number;
  type?: number;
  fields?: Record<string, { value?: string; order?: number }>;
}

export interface ImportAnkiDeckDeps {
  ankiUrl: string;
  deck: string;
  fieldName?: string;
  matureDays?: number;
  dryRun: boolean;
  sendChunk: (payload: AnkiCardsImport) => Promise<ApiCallResponse<ImportReport>>;
  fetchImpl?: typeof fetch;
  chunkSize?: number;
}

/**
 * Read cards from an Anki deck via AnkiConnect (`findCards` + `cardsInfo`) and submit them
 * to `POST /import/anki/cards` in chunks of <= 5000 cards (#76).
 */
export async function importDeckFromAnkiConnect(
  deps: ImportAnkiDeckDeps,
): Promise<AnkiImportDeckResponse> {
  const {
    ankiUrl,
    deck,
    fieldName,
    matureDays = 21,
    dryRun,
    sendChunk,
    fetchImpl = fetch,
    chunkSize = ANKI_IMPORT_CHUNK_SIZE,
  } = deps;

  const escapedDeck = deck.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  let cardIds: number[];
  try {
    cardIds = await invokeAnkiConnect<number[]>(
      ankiUrl,
      'findCards',
      { query: `deck:"${escapedDeck}"` },
      fetchImpl,
    );
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!Array.isArray(cardIds) || cardIds.length === 0) {
    return {
      ok: true,
      cardCount: 0,
      fields: [],
      fieldUsed: '',
      report: {
        total: 0,
        matched: 0,
        updated: 0,
        already: 0,
        unmatched_count: 0,
        unmatched: [],
        skipped_new: 0,
        dry_run: dryRun,
        note_types: [],
        decks: [deck],
      },
    };
  }

  const allInfos: AnkiConnectCardInfo[] = [];
  for (const batch of chunkArray(cardIds, ANKI_CARDS_INFO_BATCH)) {
    try {
      const infos = await invokeAnkiConnect<AnkiConnectCardInfo[]>(
        ankiUrl,
        'cardsInfo',
        { cards: batch },
        fetchImpl,
      );
      if (Array.isArray(infos)) {
        allInfos.push(...infos);
      }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const fieldSet = new Set<string>();
  for (const info of allInfos) {
    if (!info.fields) continue;
    const ordered = Object.entries(info.fields).sort(
      (a, b) => (a[1]?.order ?? 0) - (b[1]?.order ?? 0),
    );
    for (const [name] of ordered) {
      fieldSet.add(name);
    }
  }
  const fields = Array.from(fieldSet);
  const primaryFieldUsed = pickExpressionFieldName(fields, fieldName);

  const cardsToSend: AnkiCardIn[] = [];
  for (const info of allInfos) {
    if (!info.fields) continue;
    const orderedNames = Object.entries(info.fields)
      .sort((a, b) => (a[1]?.order ?? 0) - (b[1]?.order ?? 0))
      .map(([name]) => name);
    const chosen = pickExpressionFieldName(orderedNames, fieldName);
    const expression = info.fields[chosen]?.value ?? '';
    if (!expression.trim()) continue;
    cardsToSend.push({
      expression,
      interval_days: Math.max(0, Math.round(Number(info.interval) || 0)),
      studied: Number(info.type ?? 0) !== 0,
    });
  }

  const combined: ImportReport = {
    total: 0,
    matched: 0,
    updated: 0,
    already: 0,
    unmatched_count: 0,
    unmatched: [],
    skipped_new: 0,
    dry_run: dryRun,
    note_types: [],
    decks: [deck],
  };

  for (const chunk of chunkArray(cardsToSend, chunkSize)) {
    const res = await sendChunk({
      cards: chunk,
      mature_days: matureDays,
      dry_run: dryRun,
    });
    if (!res.ok || !res.data) {
      return {
        ok: false,
        fields,
        fieldUsed: primaryFieldUsed,
        cardCount: cardsToSend.length,
        error: res.error ?? 'Server rejected Anki card import',
      };
    }
    combined.total += res.data.total;
    combined.matched += res.data.matched;
    combined.updated += res.data.updated;
    combined.already += res.data.already;
    combined.unmatched_count += res.data.unmatched_count;
    combined.skipped_new += res.data.skipped_new;
    for (const u of res.data.unmatched) {
      if (combined.unmatched.length < 200) {
        combined.unmatched.push(u);
      }
    }
  }

  return {
    ok: true,
    report: combined,
    fields,
    fieldUsed: primaryFieldUsed,
    cardCount: cardsToSend.length,
  };
}
