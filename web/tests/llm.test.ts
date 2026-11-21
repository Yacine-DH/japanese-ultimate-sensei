import { describe, expect, it } from 'vitest';
import type { LineOut, TranslationJob } from '../src/api/client';
import {
  computeTranslationProgress,
  countTranslatedLines,
  glossLangToLlmLang,
  isTranslationJobActive,
  parseInlineMarkdown,
  parseMarkdown,
  pickLineTranslation,
} from '../src/lib/llm';

function makeLine(overrides: Partial<LineOut> = {}): LineOut {
  return {
    id: 1,
    idx: 0,
    start_ms: 1000,
    end_ms: 3000,
    text: '何か食べたい',
    romaji: 'nanika tabetai',
    translation_en: 'I want to eat something.',
    translation_de: 'Ich möchte etwas essen.',
    tokens: [],
    ...overrides,
  };
}

describe('web LLM helpers (W-9, #87)', () => {
  it('picks translation in preferred gloss language with fallback', () => {
    expect(glossLangToLlmLang('eng')).toBe('en');
    expect(glossLangToLlmLang('ger')).toBe('de');

    const full = makeLine();
    expect(pickLineTranslation(full, 'eng')).toEqual({
      text: 'I want to eat something.',
      lang: 'en',
      isFallback: false,
    });
    expect(pickLineTranslation(full, 'ger')).toEqual({
      text: 'Ich möchte etwas essen.',
      lang: 'de',
      isFallback: false,
    });

    const enOnly = makeLine({ translation_de: null });
    expect(pickLineTranslation(enOnly, 'ger')).toEqual({
      text: 'I want to eat something.',
      lang: 'en',
      isFallback: true,
    });

    const none = makeLine({ translation_en: null, translation_de: '   ' });
    expect(pickLineTranslation(none, 'eng')).toBeNull();
  });

  it('computes translation progress and job activity state', () => {
    const runningJob: TranslationJob = {
      episode_id: 1,
      total_lines: 255,
      translated_lines: 120,
      queued: false,
      running: true,
      error: null,
      failed_lines: 0,
    };
    expect(isTranslationJobActive(runningJob)).toBe(true);
    expect(computeTranslationProgress(runningJob)).toBe(47);

    expect(
      isTranslationJobActive({ ...runningJob, running: false, queued: true }),
    ).toBe(true);
    expect(
      isTranslationJobActive({ ...runningJob, running: false, queued: false }),
    ).toBe(false);
    expect(
      computeTranslationProgress({ translated_lines: 0, total_lines: 0 }),
    ).toBe(0);
    expect(
      computeTranslationProgress({ translated_lines: 300, total_lines: 255 }),
    ).toBe(100);

    expect(
      countTranslatedLines([
        makeLine({ id: 1 }),
        makeLine({ id: 2, translation_en: null, translation_de: null }),
        makeLine({ id: 3, translation_en: null, translation_de: 'Hallo' }),
      ]),
    ).toBe(2);
  });

  it('parses LLM Markdown explanations safely into structured AST blocks', () => {
    const md = [
      '### Übersetzung',
      '**Übersetzung:** Ich möchte etwas essen.',
      '',
      '- **何か** – etwas',
      '- **食べたい** – essen wollen (`〜たい`)',
      '',
      '```',
      '食べ + たい = 食べたい',
      '```',
    ].join('\n');

    const blocks = parseMarkdown(md);
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'ul', 'code']);
    expect(blocks[0]).toEqual({
      type: 'heading',
      level: 3,
      inlines: [{ type: 'text', text: 'Übersetzung' }],
    });
    expect(blocks[3]).toEqual({
      type: 'code',
      text: '食べ + たい = 食べたい',
    });

    expect(parseInlineMarkdown('Use `〜てしまう` for **regret** or *completion*.')).toEqual([
      { type: 'text', text: 'Use ' },
      { type: 'code', text: '〜てしまう' },
      { type: 'text', text: ' for ' },
      { type: 'bold', text: 'regret' },
      { type: 'text', text: ' or ' },
      { type: 'italic', text: 'completion' },
      { type: 'text', text: '.' },
    ]);
  });
});
