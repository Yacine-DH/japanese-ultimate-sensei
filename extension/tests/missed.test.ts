import { describe, expect, it, vi } from 'vitest';
import type { MissedWord } from '../src/api/client';
import {
  bulkSaveMissedWords,
  formatMissedTimestamp,
  pickMissedGloss,
  shouldPromptMissedWordsPanel,
} from '../src/lib/missed';

function makeMissed(id: number, lemma: string, lineId: number | null = 100 + id): MissedWord {
  return {
    word: {
      id,
      lemma,
      reading: lemma,
      pos: '名詞',
      jmdict_id: null,
      common: true,
      zipf: 5.2,
      status: 'new',
      occurrences: 4,
    },
    score: 10.5,
    anime_occurrences: 9,
    example: lineId ? { line_id: lineId, text: `${lemma}の例文`, start_ms: 95_000 } : null,
    gloss_en: 'english meaning',
    gloss_de: 'deutsche Bedeutung',
  };
}

describe('post-episode missed words helpers (E-7)', () => {
  it('auto-prompts once when episode ends or enters credits of a >=5 min video', () => {
    expect(
      shouldPromptMissedWordsPanel({
        currentTimeSec: 600,
        durationSec: 1440,
        ended: false,
        alreadyPrompted: false,
        overlayEnabled: true,
        episodeId: 1,
      }),
    ).toBe(false);

    // Final 90s of a 24-min episode -> triggers
    expect(
      shouldPromptMissedWordsPanel({
        currentTimeSec: 1360,
        durationSec: 1440,
        ended: false,
        alreadyPrompted: false,
        overlayEnabled: true,
        episodeId: 1,
      }),
    ).toBe(true);

    // Short video doesn't trigger early, only on ended
    expect(
      shouldPromptMissedWordsPanel({
        currentTimeSec: 50,
        durationSec: 60,
        ended: false,
        alreadyPrompted: false,
        overlayEnabled: true,
        episodeId: 1,
      }),
    ).toBe(false);
    expect(
      shouldPromptMissedWordsPanel({
        currentTimeSec: 60,
        durationSec: 60,
        ended: true,
        alreadyPrompted: false,
        overlayEnabled: true,
        episodeId: 1,
      }),
    ).toBe(true);

    // Never re-prompts once shown for the episode
    expect(
      shouldPromptMissedWordsPanel({
        currentTimeSec: 1440,
        durationSec: 1440,
        ended: true,
        alreadyPrompted: true,
        overlayEnabled: true,
        episodeId: 1,
      }),
    ).toBe(false);
  });

  it('picks preferred language gloss with fallback and formats timestamps', () => {
    const item = makeMissed(1, '魔法');
    expect(pickMissedGloss(item, 'eng')).toBe('english meaning');
    expect(pickMissedGloss(item, 'ger')).toBe('deutsche Bedeutung');
    expect(pickMissedGloss({ ...item, gloss_de: null }, 'ger')).toBe('english meaning');
    expect(formatMissedTimestamp(95_000)).toBe('1:35');
  });

  it('bulk-saves checked missed words with their example line_id', async () => {
    const items = [makeMissed(1, '魔法', 501), makeMissed(2, '勇者', 502), makeMissed(3, '冒険', null)];
    const createCard = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 201, data: { id: 10, word_id: 1, created: true } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { id: 11, word_id: 2, created: false } })
      .mockResolvedValueOnce({ ok: false, status: 500, error: 'boom' });

    const result = await bulkSaveMissedWords(items, createCard);
    expect(result).toEqual({
      saved: 1,
      existing: 1,
      failed: 1,
      savedWordIds: [1, 2],
    });
    expect(createCard).toHaveBeenNthCalledWith(1, { word_id: 1, line_id: 501, media_ids: [] });
    expect(createCard).toHaveBeenNthCalledWith(3, { word_id: 3, line_id: null, media_ids: [] });
  });
});
