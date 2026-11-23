import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LineOut, MissedWord, ReviewCard, WordListItem } from '../src/api/client';
import {
  estimateCoverageGainPct,
  findFirstLineForWord,
  formatPrepGlosses,
  indexAudioUrlsByLineAndWord,
  PRIMING_WORD_LIMIT,
  resolveExampleLine,
  resolvePrepAudioUrl,
  shouldOpenPrepFromSearchParams,
  sumPrimingOccurrences,
} from '../src/lib/priming';

describe('episode prep / pre-watch priming helpers (#35, #134)', () => {
  const words: WordListItem[] = [
    {
      id: 10,
      lemma: '魔法',
      reading: 'まほう',
      pos: '名詞',
      jmdict_id: '1523060',
      common: true,
      status: 'new',
      occurrences: 14,
      zipf: 4.5,
    },
    {
      id: 11,
      lemma: '冒険',
      reading: 'ぼうけん',
      pos: '名詞',
      jmdict_id: '1515770',
      common: true,
      status: 'new',
      occurrences: 6,
      zipf: 4.2,
    },
  ];

  const lines: LineOut[] = [
    {
      id: 1,
      idx: 0,
      start_ms: 0,
      end_ms: 2000,
      text: 'おはよう',
      romaji: 'ohayou',
      tokens: [],
      translation_en: 'Good morning',
      translation_de: 'Guten Morgen',
    },
    {
      id: 2,
      idx: 1,
      start_ms: 2000,
      end_ms: 4000,
      text: '魔法を使う',
      romaji: 'mahou wo tsukau',
      tokens: [
        {
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
          word_id: 10,
          status: 'new',
          common: true,
        },
      ],
      translation_en: 'Use magic',
      translation_de: 'Magie benutzen',
    },
  ];

  it('sums priming word occurrences and estimates episode coverage gain %', () => {
    expect(PRIMING_WORD_LIMIT).toBe(10);
    expect(sumPrimingOccurrences(words)).toBe(20);
    expect(estimateCoverageGainPct({ total_tokens: 200 }, words)).toBe(10);
    expect(estimateCoverageGainPct({ total_tokens: 0 }, words)).toBe(0);
    expect(estimateCoverageGainPct(null, words)).toBe(0);
  });

  it('matches example line by example.line_id first, then falls back to first line containing word (#134)', () => {
    expect(findFirstLineForWord(lines, 10)?.id).toBe(2);
    expect(findFirstLineForWord(lines, 999)).toBeNull();

    const exactItem: Pick<MissedWord, 'word' | 'example'> = {
      word: words[0]!,
      example: { line_id: 1, text: 'おはよう', start_ms: 0 },
    };
    expect(resolveExampleLine(exactItem, lines)?.id).toBe(1);

    const fallbackItem: Pick<MissedWord, 'word' | 'example'> = {
      word: words[0]!,
      example: null,
    };
    expect(resolveExampleLine(fallbackItem, lines)?.id).toBe(2);
  });

  it('formats EN/DE prep glosses according to gloss language with fallback and null omission (#134)', () => {
    expect(
      formatPrepGlosses({ gloss_en: 'magic; sorcery', gloss_de: 'Magie; Zauberei' }, 'eng'),
    ).toEqual({
      primary: { lang: 'EN', text: 'magic; sorcery' },
      secondary: { lang: 'DE', text: 'Magie; Zauberei' },
    });

    expect(
      formatPrepGlosses({ gloss_en: 'magic; sorcery', gloss_de: 'Magie; Zauberei' }, 'ger'),
    ).toEqual({
      primary: { lang: 'DE', text: 'Magie; Zauberei' },
      secondary: { lang: 'EN', text: 'magic; sorcery' },
    });

    expect(formatPrepGlosses({ gloss_en: 'magic', gloss_de: null }, 'ger')).toEqual({
      primary: { lang: 'EN', text: 'magic' },
      secondary: null,
    });
    expect(formatPrepGlosses({ gloss_en: null, gloss_de: null }, 'eng')).toBeNull();
  });

  it('indexes and resolves line/word audio URLs when a card with audio exists (#134)', () => {
    const mockCard: ReviewCard = {
      card: {
        id: 7,
        word_id: 10,
        line_id: 2,
        sentence: '魔法を使う',
        state: 'learning',
        due: '2026-11-23T12:00:00Z',
        stability: 1,
        difficulty: 5,
        reps: 1,
        created_at: '2026-11-23T10:00:00Z',
      },
      word: words[0]!,
      line: lines[1]!,
      episode: { id: 1, anime_title: 'Frieren', number: 1 },
      entry: null,
      media: [
        { id: 1, kind: 'screenshot', mime: 'image/webp', url: '/media/1?sig=a', bytes: 1000, ready: true },
        { id: 2, kind: 'audio', mime: 'audio/ogg', url: '/media/2?sig=b', bytes: 2000, ready: true },
      ],
      next_due: {},
    };

    const index = indexAudioUrlsByLineAndWord([mockCard], 'http://homeserver:8000/');
    expect(
      resolvePrepAudioUrl(
        { word: words[1]!, example: { line_id: 2, text: '魔法を使う', start_ms: 2000 } },
        index,
      ),
    ).toBe('http://homeserver:8000/media/2?sig=b');
    expect(resolvePrepAudioUrl({ word: words[0]!, example: null }, index)).toBe(
      'http://homeserver:8000/media/2?sig=b',
    );
    expect(resolvePrepAudioUrl({ word: words[1]!, example: null }, index)).toBeNull();
  });

  it('opens Prep view for both ?prep=1 and legacy ?prime=1 and wires required actions (#134)', () => {
    expect(shouldOpenPrepFromSearchParams(new URLSearchParams('prep=1'))).toBe(true);
    expect(shouldOpenPrepFromSearchParams(new URLSearchParams('prime=1'))).toBe(true);
    expect(shouldOpenPrepFromSearchParams(new URLSearchParams('missed=1'))).toBe(false);

    const primerSrc = readFileSync(
      resolve(__dirname, '../src/components/PreWatchPrimer.tsx'),
      'utf-8',
    );
    expect(primerSrc).toContain('getEpisodeMissedWords(episodeId, PRIMING_WORD_LIMIT, false)');
    expect(primerSrc).toContain('Learn');
    expect(primerSrc).toContain('I know it');
    expect(primerSrc).toContain('<ruby');
  });
});
