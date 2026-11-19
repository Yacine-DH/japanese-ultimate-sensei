import { describe, expect, it } from 'vitest';
import type { DictEntry, EpisodeOut, LineOut, TokenOut, Understanding } from '../src/api/client';
import {
  buildRomajiLine,
  computeBarSegments,
  filterTranscriptLines,
  formatTimestampMs,
  groupEpisodesByAnime,
  pickEntrySenses,
  shouldShowFurigana,
  updateWordStatusInTranscript,
} from '../src/lib/transcript';

function makeEpisode(overrides: Partial<EpisodeOut> = {}): EpisodeOut {
  return {
    id: 1,
    anime_id: 1,
    anime_title: 'Frieren',
    number: 1,
    title: null,
    source: 'upload',
    source_filename: 'frieren_01.ass',
    sub_offset_ms: 0,
    line_count: 300,
    created_at: '2026-11-17T00:00:00Z',
    ...overrides,
  };
}

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
    word_id: 42,
    status: 'new',
    common: true,
    ...overrides,
  };
}

function makeLine(id: number, text: string, tokens: TokenOut[]): LineOut {
  return {
    id,
    idx: id,
    start_ms: id * 1000,
    end_ms: id * 1000 + 2000,
    text,
    tokens,
    translation_en: null,
    translation_de: null,
  };
}

describe('web library & transcript helpers (W-2, #23)', () => {
  it('groups episodes by anime and sorts episodes ascending by episode number', () => {
    const groups = groupEpisodesByAnime([
      makeEpisode({ id: 3, anime_id: 1, anime_title: 'Frieren', number: 3 }),
      makeEpisode({ id: 1, anime_id: 1, anime_title: 'Frieren', number: 1 }),
      makeEpisode({ id: 4, anime_id: 2, anime_title: 'Dungeon Meshi', number: 1 }),
      makeEpisode({ id: 2, anime_id: 1, anime_title: 'Frieren', number: 2 }),
    ]);

    expect(groups.map((g) => g.title)).toEqual(['Dungeon Meshi', 'Frieren']);
    expect(groups[1]?.episodes.map((e) => e.number)).toEqual([1, 2, 3]);
  });

  it('formats timestamps in MM:SS and H:MM:SS', () => {
    expect(formatTimestampMs(0)).toBe('00:00');
    expect(formatTimestampMs(125_000)).toBe('02:05');
    expect(formatTimestampMs(3_661_000)).toBe('1:01:01');
  });

  it('hides furigana on known/ignored words and filters lines for pre-study', () => {
    const knownTok = makeToken({
      word_id: 1,
      status: 'known',
      surface: '私',
      lemma: '私',
      reading: 'わたし',
      lemma_reading: 'わたし',
      romaji: 'watashi',
    });
    const newTok = makeToken({ word_id: 2, status: 'new', lemma: '魔法', reading: 'まほう' });

    expect(shouldShowFurigana(knownTok, 'わたし')).toBe(false);
    expect(shouldShowFurigana(newTok, 'まほう')).toBe(true);
    expect(shouldShowFurigana(newTok, null)).toBe(false);

    const lines = [
      makeLine(1, '私', [knownTok]),
      makeLine(2, '魔法', [newTok]),
    ];

    expect(filterTranscriptLines(lines, '', true).map((l) => l.id)).toEqual([2]);
    expect(filterTranscriptLines(lines, 'mahou', false).map((l) => l.id)).toEqual([2]);
    expect(buildRomajiLine([newTok])).toBe('mahou');

    const updated = updateWordStatusInTranscript(lines, 2, 'known');
    expect(updated[1]?.tokens[0]?.status).toBe('known');
    expect(filterTranscriptLines(updated, '', true)).toEqual([]);
  });

  it('selects gloss senses in preferred language with fallback and computes progress bar segments', () => {
    const entry: DictEntry = {
      id: '1',
      common: true,
      kanji: ['魔法'],
      kana: ['まほう'],
      senses: {
        eng: [{ pos: ['n'], misc: [], glosses: ['magic'] }],
        ger: [{ pos: [], misc: [], glosses: ['Magie', 'Zauberei'] }],
      },
    };
    expect(pickEntrySenses(entry, 'ger').lang).toBe('ger');
    expect(pickEntrySenses(entry, 'eng').lang).toBe('eng');

    const u: Understanding = {
      episode_id: 1,
      total_tokens: 200,
      unique_words: 80,
      known_tokens: 100,
      known_unique: 40,
      learning_tokens: 20,
      learning_unique: 8,
      token_pct: 50,
      unique_pct: 50,
    };
    expect(computeBarSegments(u)).toEqual({ knownPct: 50, learningPct: 10 });
  });
});
