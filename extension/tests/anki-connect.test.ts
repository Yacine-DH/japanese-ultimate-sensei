import { describe, expect, it, vi } from 'vitest';
import type { AnkiModel, AnkiNotePayload } from '../src/api/client';
import {
  AnkiPushQueue,
  chunkArray,
  importDeckFromAnkiConnect,
  invokeAnkiConnect,
  pickExpressionFieldName,
  pushCardToAnki,
  testAnkiConnect,
} from '../src/lib/anki-connect';

const SAMPLE_MODEL: AnkiModel = {
  modelName: 'Sensei Japanese',
  inOrderFields: ['Word', 'Reading', 'MeaningEN', 'MeaningDE', 'Sentence', 'SenseiId'],
  css: '.card {}',
  isCloze: false,
  cardTemplates: [{ Name: 'Recognition', Front: '{{Word}}', Back: '{{MeaningEN}}' }],
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
    const { fetchImpl: onlineFetch } = makeAnkiFetch({
      version: () => 6,
      modelNames: () => ['Sensei Japanese'],
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
