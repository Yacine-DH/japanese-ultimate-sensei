import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnkiModel, AnkiNotePayload } from '../src/api/client';
import {
  AnkiPushQueue,
  chunkArray,
  importDeckFromAnkiConnect,
  invokeAnkiConnect,
  pickExpressionFieldName,
  pushCardToAnki,
  resetAnkiModelCache,
  testAnkiConnect,
} from '../src/lib/anki-connect';

const OLD_FIELDS = [
  'Word',
  'Reading',
  'MeaningEN',
  'MeaningDE',
  'Sentence',
  'SentenceRomaji',
  'Screenshot',
  'Audio',
  'Clip',
  'Source',
  'SenseiId',
];

const UPGRADED_FIELDS = [...OLD_FIELDS, 'SentenceEN', 'SentenceDE'];

const SAMPLE_MODEL: AnkiModel = {
  modelName: 'Sensei Japanese',
  inOrderFields: UPGRADED_FIELDS,
  css: '.card { color: #f8fafc; } .sentence-tr { opacity: 0.85; }',
  isCloze: false,
  cardTemplates: [
    {
      Name: 'Recognition',
      Front: '{{Screenshot}}{{Word}}{{Sentence}}',
      Back: '{{FrontSide}}<hr id=answer>{{MeaningEN}}{{SentenceEN}}{{SentenceDE}}',
    },
  ],
};

const SAMPLE_PAYLOAD: AnkiNotePayload = {
  note: {
    deckName: 'Sensei',
    modelName: 'Sensei Japanese',
    fields: { Word: '食べる', Reading: 'たべる', MeaningEN: 'to eat', SenseiId: '7' },
    tags: ['sensei', 'sensei::Frieren'],
    options: { allowDuplicate: false, duplicateScope: 'deck' },
  },
  media: [
    { filename: 'sensei-3.webp', url: 'http://homeserver:8000/media/3?sig=abc' },
    { filename: 'sensei-4.mp3', url: 'http://homeserver:8000/media/4?sig=def&format=mp3' },
  ],
};

function makeAnkiFetch(handlers: Record<string, (params: Record<string, unknown>) => unknown>) {
  const calls: { action: string; params: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      action: string;
      params: Record<string, unknown>;
    };
    calls.push({ action: body.action, params: body.params });
    const handler = handlers[body.action];
    if (!handler) {
      return new Response(JSON.stringify({ result: null, error: `unexpected ${body.action}` }));
    }
    const outcome = handler(body.params);
    if (outcome instanceof Error) {
      return new Response(JSON.stringify({ result: null, error: outcome.message }));
    }
    return new Response(JSON.stringify({ result: outcome, error: null }));
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

describe('AnkiConnect client & E-6 card push', () => {
  beforeEach(() => {
    resetAnkiModelCache();
  });

  it('creates missing model + deck, stores media files, and adds the note', async () => {
    const { fetchImpl, calls } = makeAnkiFetch({
      modelNames: () => ['Basic'],
      createModel: () => ({ id: 1 }),
      createDeck: () => 42,
      storeMediaFile: () => 'ok',
      addNote: () => 999,
    });

    const res = await pushCardToAnki({
      cardId: 7,
      settings: {
        ankiConnectEnabled: true,
        ankiConnectUrl: 'http://localhost:8765',
        ankiDeckName: 'Anime::Frieren',
        ankiModelName: 'Sensei Japanese',
      },
      fetchCardNote: async () => ({ ok: true, status: 200, data: SAMPLE_PAYLOAD }),
      fetchAnkiModel: async () => ({ ok: true, status: 200, data: SAMPLE_MODEL }),
      fetchImpl,
    });

    expect(res).toEqual({ status: 'pushed', noteId: 999 });
    expect(calls.map((c) => c.action)).toEqual([
      'modelNames',
      'createModel',
      'createDeck',
      'storeMediaFile',
      'storeMediaFile',
      'addNote',
    ]);
    expect(calls[2]?.params).toEqual({ deck: 'Anime::Frieren' });
    expect((calls[5]?.params.note as { deckName: string }).deckName).toBe('Anime::Frieren');
  });

  it('treats duplicate note errors from addNote as already synced', async () => {
    const { fetchImpl } = makeAnkiFetch({
      modelNames: () => ['Sensei Japanese'],
      modelFieldNames: () => UPGRADED_FIELDS,
      createDeck: () => 1,
      storeMediaFile: () => 'ok',
      addNote: () => new Error('cannot create note because it is a duplicate'),
    });

    const res = await pushCardToAnki({
      cardId: 7,
      settings: {
        ankiConnectEnabled: true,
        ankiConnectUrl: 'http://localhost:8765',
        ankiDeckName: 'Sensei',
        ankiModelName: 'Sensei Japanese',
      },
      fetchCardNote: async () => ({ ok: true, status: 200, data: SAMPLE_PAYLOAD }),
      fetchAnkiModel: async () => ({ ok: true, status: 200, data: SAMPLE_MODEL }),
      fetchImpl,
    });

    expect(res.status).toBe('duplicate');
  });

  it('queues cards gracefully when AnkiConnect is offline and drains once Anki starts', async () => {
    const offlineFetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    const queue = new AnkiPushQueue(null);
    const settings = {
      ankiConnectEnabled: true,
      ankiConnectUrl: 'http://localhost:8765',
      ankiDeckName: 'Sensei',
      ankiModelName: 'Sensei Japanese',
    };

    const offlineRes = await pushCardToAnki({
      cardId: 11,
      settings,
      fetchCardNote: async () => ({ ok: true, status: 200, data: SAMPLE_PAYLOAD }),
      fetchAnkiModel: async () => ({ ok: true, status: 200, data: SAMPLE_MODEL }),
      fetchImpl: offlineFetch,
    });
    expect(offlineRes.status).toBe('queued');

    await queue.enqueue(11, offlineRes.message, 1000);
    await queue.enqueue(11, 'retry', 2000); // deduplicated
    await queue.enqueue(12, 'offline', 3000);
    expect((await queue.list()).map((i) => i.cardId)).toEqual([11, 12]);

    // Still offline -> queue untouched
    const stillOffline = await queue.flush({
      settings,
      fetchCardNote: async () => ({ ok: true, status: 200, data: SAMPLE_PAYLOAD }),
      fetchAnkiModel: async () => ({ ok: true, status: 200, data: SAMPLE_MODEL }),
      fetchImpl: offlineFetch,
    });
    expect(stillOffline).toEqual({
      ankiReachable: false,
      pushed: 0,
      duplicates: 0,
      remaining: 2,
      errors: 0,
    });

    // Anki comes online: card 11 pushes, card 12 is a duplicate -> queue empties!
    let addCalls = 0;
    const { fetchImpl: onlineFetch, calls: onlineCalls } = makeAnkiFetch({
      version: () => 6,
      modelNames: () => ['Sensei Japanese'],
      modelFieldNames: () => UPGRADED_FIELDS,
      createDeck: () => 1,
      storeMediaFile: () => 'ok',
      addNote: () => {
        addCalls += 1;
        return addCalls === 1 ? 5001 : new Error('cannot create note because it is a duplicate');
      },
    });

    const drained = await queue.flush({
      settings,
      fetchCardNote: async () => ({ ok: true, status: 200, data: SAMPLE_PAYLOAD }),
      fetchAnkiModel: async () => ({ ok: true, status: 200, data: SAMPLE_MODEL }),
      fetchImpl: onlineFetch,
    });
    expect(drained).toEqual({
      ankiReachable: true,
      pushed: 1,
      duplicates: 1,
      remaining: 0,
      errors: 0,
    });
    expect(await queue.list()).toEqual([]);
    // Model was checked only once across both flushed cards (session cache)
    expect(onlineCalls.filter((c) => c.action === 'modelNames')).toHaveLength(1);
    expect(onlineCalls.filter((c) => c.action === 'modelFieldNames')).toHaveLength(1);
  });

  it('upgrades an existing note type with missing SentenceEN/SentenceDE fields, templates, and styling once per session (#154)', async () => {
    const ankiFields = [...OLD_FIELDS];
    const fetchAnkiModel = vi.fn(async () => ({
      ok: true,
      status: 200,
      data: SAMPLE_MODEL,
    }));

    const { fetchImpl, calls } = makeAnkiFetch({
      modelNames: () => ['Basic', 'Sensei Japanese'],
      modelFieldNames: () => [...ankiFields],
      modelFieldAdd: (params) => {
        const fieldName = String(params.fieldName);
        const index = Number(params.index);
        ankiFields.splice(index, 0, fieldName);
        return null;
      },
      updateModelTemplates: () => null,
      updateModelStyling: () => null,
      createDeck: () => 42,
      storeMediaFile: () => 'ok',
      addNote: () => 1001,
    });

    const settings = {
      ankiConnectEnabled: true,
      ankiConnectUrl: 'http://localhost:8765',
      ankiDeckName: 'Sensei',
      ankiModelName: 'Sensei Japanese',
    };

    const first = await pushCardToAnki({
      cardId: 7,
      settings,
      fetchCardNote: async () => ({ ok: true, status: 200, data: SAMPLE_PAYLOAD }),
      fetchAnkiModel,
      fetchImpl,
    });
    expect(first).toEqual({ status: 'pushed', noteId: 1001 });
    expect(ankiFields).toEqual(UPGRADED_FIELDS);
    expect(fetchAnkiModel).toHaveBeenCalledTimes(1);

    expect(calls.map((c) => c.action)).toEqual([
      'modelNames',
      'modelFieldNames',
      'modelFieldAdd',
      'modelFieldAdd',
      'updateModelTemplates',
      'updateModelStyling',
      'createDeck',
      'storeMediaFile',
      'storeMediaFile',
      'addNote',
    ]);

    expect(calls[1]?.params).toEqual({ modelName: 'Sensei Japanese' });
    expect(calls[2]?.params).toEqual({
      modelName: 'Sensei Japanese',
      fieldName: 'SentenceEN',
      index: 11,
    });
    expect(calls[3]?.params).toEqual({
      modelName: 'Sensei Japanese',
      fieldName: 'SentenceDE',
      index: 12,
    });
    expect(calls[4]?.params).toEqual({
      model: {
        name: 'Sensei Japanese',
        templates: {
          Recognition: {
            Front: SAMPLE_MODEL.cardTemplates[0]!.Front,
            Back: SAMPLE_MODEL.cardTemplates[0]!.Back,
          },
        },
      },
    });
    expect(calls[5]?.params).toEqual({
      model: {
        name: 'Sensei Japanese',
        css: SAMPLE_MODEL.css,
      },
    });

    // Second push in the same session uses the cache and skips model inspection/upgrade completely
    calls.length = 0;
    const second = await pushCardToAnki({
      cardId: 8,
      settings,
      fetchCardNote: async () => ({ ok: true, status: 200, data: SAMPLE_PAYLOAD }),
      fetchAnkiModel,
      fetchImpl,
    });
    expect(second).toEqual({ status: 'pushed', noteId: 1001 });
    expect(fetchAnkiModel).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.action)).toEqual([
      'createDeck',
      'storeMediaFile',
      'storeMediaFile',
      'addNote',
    ]);
  });

  it('skips template/styling updates when existing note type already has all fields (#154)', async () => {
    const { fetchImpl, calls } = makeAnkiFetch({
      modelNames: () => ['Sensei Japanese'],
      modelFieldNames: () => [...UPGRADED_FIELDS],
      createDeck: () => 42,
      storeMediaFile: () => 'ok',
      addNote: () => 2002,
    });

    const res = await pushCardToAnki({
      cardId: 7,
      settings: {
        ankiConnectEnabled: true,
        ankiConnectUrl: 'http://localhost:8765',
        ankiDeckName: 'Sensei',
        ankiModelName: 'Sensei Japanese',
      },
      fetchCardNote: async () => ({ ok: true, status: 200, data: SAMPLE_PAYLOAD }),
      fetchAnkiModel: async () => ({ ok: true, status: 200, data: SAMPLE_MODEL }),
      fetchImpl,
    });

    expect(res).toEqual({ status: 'pushed', noteId: 2002 });
    expect(calls.map((c) => c.action)).toEqual([
      'modelNames',
      'modelFieldNames',
      'createDeck',
      'storeMediaFile',
      'storeMediaFile',
      'addNote',
    ]);
  });

  it('deduplicates concurrent model upgrades and retries after a failed upgrade attempt (#154)', async () => {
    const settings = {
      ankiConnectEnabled: true,
      ankiConnectUrl: 'http://localhost:8765',
      ankiDeckName: 'Sensei',
      ankiModelName: 'Sensei Japanese',
    };

    // First attempt fails during modelFieldAdd -> must NOT poison the session cache
    const { fetchImpl: failingFetch } = makeAnkiFetch({
      modelNames: () => ['Sensei Japanese'],
      modelFieldNames: () => [...OLD_FIELDS],
      modelFieldAdd: () => new Error('Anki busy'),
    });

    const failed = await pushCardToAnki({
      cardId: 7,
      settings,
      fetchCardNote: async () => ({ ok: true, status: 200, data: SAMPLE_PAYLOAD }),
      fetchAnkiModel: async () => ({ ok: true, status: 200, data: SAMPLE_MODEL }),
      fetchImpl: failingFetch,
    });
    expect(failed).toEqual({ status: 'error', message: 'Anki busy' });

    // Next attempt (two concurrent pushes) upgrades once and pushes both cards
    const ankiFields = [...OLD_FIELDS];
    let noteCounter = 3000;
    const { fetchImpl: okFetch, calls } = makeAnkiFetch({
      modelNames: () => ['Sensei Japanese'],
      modelFieldNames: () => [...ankiFields],
      modelFieldAdd: (params) => {
        ankiFields.splice(Number(params.index), 0, String(params.fieldName));
        return null;
      },
      updateModelTemplates: () => null,
      updateModelStyling: () => null,
      createDeck: () => 42,
      storeMediaFile: () => 'ok',
      addNote: () => ++noteCounter,
    });

    const [a, b] = await Promise.all([
      pushCardToAnki({
        cardId: 7,
        settings,
        fetchCardNote: async () => ({ ok: true, status: 200, data: SAMPLE_PAYLOAD }),
        fetchAnkiModel: async () => ({ ok: true, status: 200, data: SAMPLE_MODEL }),
        fetchImpl: okFetch,
      }),
      pushCardToAnki({
        cardId: 8,
        settings,
        fetchCardNote: async () => ({ ok: true, status: 200, data: SAMPLE_PAYLOAD }),
        fetchAnkiModel: async () => ({ ok: true, status: 200, data: SAMPLE_MODEL }),
        fetchImpl: okFetch,
      }),
    ]);

    expect(a.status).toBe('pushed');
    expect(b.status).toBe('pushed');
    expect(calls.filter((c) => c.action === 'modelNames')).toHaveLength(1);
    expect(calls.filter((c) => c.action === 'modelFieldAdd')).toHaveLength(2);
    expect(calls.filter((c) => c.action === 'updateModelTemplates')).toHaveLength(1);
    expect(calls.filter((c) => c.action === 'updateModelStyling')).toHaveLength(1);
    expect(calls.filter((c) => c.action === 'addNote')).toHaveLength(2);
  });

  it('tests AnkiConnect connectivity and returns version, decks, and models', async () => {
    const { fetchImpl } = makeAnkiFetch({
      version: () => 6,
      deckNames: () => ['Default', 'Sensei'],
      modelNames: () => ['Basic', 'Sensei Japanese'],
    });
    const status = await testAnkiConnect('http://localhost:8765', fetchImpl);
    expect(status).toEqual({
      reachable: true,
      version: 6,
      decks: ['Default', 'Sensei'],
      models: ['Basic', 'Sensei Japanese'],
    });

    await expect(
      invokeAnkiConnect('http://localhost:8765', 'version', {}, (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch),
    ).rejects.toMatchObject({ kind: 'unreachable' });
  });

  it('imports studied AnkiConnect deck cards in chunks and aggregates ImportReport (#76)', async () => {
    expect(pickExpressionFieldName(['Meaning', 'Vocab', 'Reading'])).toBe('Vocab');
    expect(pickExpressionFieldName(['Meaning', 'Vocab'], 'reading')).toBe('Vocab');
    expect(pickExpressionFieldName(['Meaning', 'Vocab'], 'meaning')).toBe('Meaning');
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);

    const { fetchImpl } = makeAnkiFetch({
      findCards: () => [101, 102, 103],
      cardsInfo: () => [
        {
          interval: 45,
          type: 2,
          fields: {
            Meaning: { value: 'to eat', order: 0 },
            Word: { value: '食べる', order: 1 },
          },
        },
        {
          interval: 5,
          type: 1,
          fields: {
            Meaning: { value: 'magic', order: 0 },
            Word: { value: '魔法', order: 1 },
          },
        },
        {
          interval: 0,
          type: 0,
          fields: {
            Meaning: { value: 'unstudied', order: 0 },
            Word: { value: '海賊', order: 1 },
          },
        },
      ],
    });

    const sentChunks: { count: number; dryRun: boolean }[] = [];
    const res = await importDeckFromAnkiConnect({
      ankiUrl: 'http://localhost:8765',
      deck: 'Japanese::Core',
      matureDays: 21,
      dryRun: true,
      chunkSize: 2,
      fetchImpl,
      sendChunk: async (payload) => {
        sentChunks.push({ count: payload.cards.length, dryRun: payload.dry_run });
        const studied = payload.cards.filter((c) => c.studied);
        return {
          ok: true,
          status: 200,
          data: {
            total: studied.length,
            matched: studied.length,
            updated: studied.length,
            already: 0,
            unmatched_count: 0,
            unmatched: [],
            skipped_new: payload.cards.length - studied.length,
            dry_run: payload.dry_run,
            note_types: [],
            decks: [],
          },
        };
      },
    });

    expect(res.ok).toBe(true);
    expect(res.fieldUsed).toBe('Word');
    expect(res.fields).toEqual(['Meaning', 'Word']);
    expect(sentChunks).toEqual([
      { count: 2, dryRun: true },
      { count: 1, dryRun: true },
    ]);
    expect(res.report).toMatchObject({
      total: 2,
      matched: 2,
      updated: 2,
      skipped_new: 1,
      dry_run: true,
    });
  });
});
