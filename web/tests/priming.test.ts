import { describe, expect, it } from 'vitest';
import type { LineOut, WordListItem } from '../src/api/client';
import {
  estimateCoverageGainPct,
  findFirstLineForWord,
  sumPrimingOccurrences,
} from '../src/lib/priming';

describe('pre-watch priming helpers (#35)', () => {
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
    },
  ];

  it('sums priming word occurrences and estimates episode coverage gain %', () => {
    expect(sumPrimingOccurrences(words)).toBe(20);
    expect(estimateCoverageGainPct({ total_tokens: 200 }, words)).toBe(10);
    expect(estimateCoverageGainPct({ total_tokens: 0 }, words)).toBe(0);
    expect(estimateCoverageGainPct(null, words)).toBe(0);
  });

  it('finds the first episode line containing a priming word for example context & card linking', () => {
    const lines: LineOut[] = [
      {
        id: 1,
        idx: 0,
        start_ms: 0,
        end_ms: 2000,
        text: 'おはよう',
        romaji: 'ohayou',
        tokens: [],
        translation_en: null,
        translation_de: null,
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
        translation_en: null,
        translation_de: null,
      },
    ];

    expect(findFirstLineForWord(lines, 10)?.id).toBe(2);
    expect(findFirstLineForWord(lines, 999)).toBeNull();
  });
});
