import { describe, expect, it } from 'vitest';
import type { DictEntry, LineOut, TokenOut } from '../src/api/client';
import {
  isLookupableToken,
  isUnknownContentToken,
  rankHighlightedTokenIndices,
  selectSensesForLanguage,
  updateWordStatusInLines,
} from '../src/lib/highlight';

function makeToken(overrides: Partial<TokenOut> = {}): TokenOut {
  return {
    surface: '魔法',
    lemma: '魔法',
    reading: 'まほう',
    lemma_reading: 'まほう',
    pos: '名詞',
    pos_detail: ['一般'],
    furigana: [{ text: '魔法', ruby: 'まほう' }],
    romaji: 'mahou',
    is_content: true,
    is_proper_noun: false,
    word_id: 1,
    status: 'new',
    common: true,
    ...overrides,
  };
}

describe('unknown content token highlighting (E-3, #9)', () => {
  it('identifies unknown content tokens and excludes particles, proper nouns, known, and ignored', () => {
    expect(isUnknownContentToken(makeToken({ is_content: true, status: 'new' }))).toBe(true);
    expect(isUnknownContentToken(makeToken({ is_content: true, status: 'learning' }))).toBe(true);
    expect(isUnknownContentToken(makeToken({ is_content: true, status: 'known' }))).toBe(false);
    expect(isUnknownContentToken(makeToken({ is_content: true, status: 'ignored' }))).toBe(false);
    expect(isUnknownContentToken(makeToken({ is_content: false, status: null }))).toBe(false);

    // Character/place names (#9) are never highlighted as unknown, yet remain lookupable
    const nameTok = makeToken({
      surface: 'フリーレン',
      lemma: 'フリーレン',
      is_content: false,
      is_proper_noun: true,
      word_id: 99,
      status: 'new',
    });
    expect(isUnknownContentToken(nameTok)).toBe(false);
    expect(isUnknownContentToken({ ...nameTok, is_content: true })).toBe(false);
    expect(isLookupableToken(nameTok)).toBe(true);
  });

  it('ranks common unknown content words first up to limit N', () => {
    const tokens: TokenOut[] = [
      makeToken({ surface: '私', lemma: '私', word_id: 10, status: 'known', common: true }),
      makeToken({ surface: 'は', lemma: 'は', is_content: false, word_id: null, status: null }),
      makeToken({ surface: '魔導書', lemma: '魔導書', word_id: 11, status: 'new', common: false }),
      makeToken({ surface: '集める', lemma: '集める', word_id: 12, status: 'new', common: true }),
      makeToken({ surface: '旅', lemma: '旅', word_id: 13, status: 'new', common: true }),
      makeToken({ surface: '出る', lemma: '出る', word_id: 14, status: 'new', common: true }),
    ];

    const top3 = rankHighlightedTokenIndices(tokens, 3);
    // Tokens at indices 3, 4, 5 have common=true, while index 2 has common=false
    expect(Array.from(top3).sort()).toEqual([3, 4, 5]);

    const top1 = rankHighlightedTokenIndices(tokens, 1);
    expect(Array.from(top1)).toEqual([3]);
  });

  it('selects dictionary senses for preferred language with fallback', () => {
    const entry: DictEntry = {
      id: '1358280',
      common: true,
      kanji: ['食べる'],
      kana: ['たべる'],
      senses: {
        eng: [{ pos: ['v1'], misc: [], glosses: ['to eat'] }],
        ger: [{ pos: [], misc: [], glosses: ['essen', 'speisen'] }],
      },
    };

    expect(selectSensesForLanguage(entry, 'ger')).toEqual({
      lang: 'ger',
      senses: [{ pos: [], misc: [], glosses: ['essen', 'speisen'] }],
    });
    expect(selectSensesForLanguage(entry, 'eng')).toEqual({
      lang: 'eng',
      senses: [{ pos: ['v1'], misc: [], glosses: ['to eat'] }],
    });

    const engOnly: DictEntry = {
      ...entry,
      senses: { eng: [{ pos: ['n'], misc: [], glosses: ['grimoire'] }] },
    };
    expect(selectSensesForLanguage(engOnly, 'ger')).toEqual({
      lang: 'eng',
      senses: [{ pos: ['n'], misc: [], glosses: ['grimoire'] }],
    });
  });

  it('updates word status across all lines in an episode', () => {
    const lines: LineOut[] = [
      {
        id: 1,
        idx: 0,
        start_ms: 0,
        end_ms: 2000,
        text: '魔法',
        romaji: 'mahou',
        tokens: [makeToken({ word_id: 77, status: 'new' })],
        translation_en: null,
        translation_de: null,
      },
    ];
    const updated = updateWordStatusInLines(lines, 77, 'known');
    expect(updated[0]?.tokens[0]?.status).toBe('known');
  });
});
