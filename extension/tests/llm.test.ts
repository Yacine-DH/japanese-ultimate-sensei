import { describe, expect, it } from 'vitest';
import type { LineOut } from '../src/api/client';
import {
  findLineForAction,
  glossLangToLlmLang,
  parseInlineMarkdown,
  parseMarkdown,
  pickLineTranslationForLang,
  renderMarkdownToFragment,
  resolveOverlayTranslation,
} from '../src/lib/llm';
import { sanitizeSettings } from '../src/lib/settings';

function makeLine(overrides: Partial<LineOut> = {}): LineOut {
  return {
    id: 10,
    idx: 0,
    start_ms: 1000,
    end_ms: 3500,
    text: '何か食べたい',
    romaji: 'nanika tabetai',
    translation_en: 'I want to eat something.',
    translation_de: 'Ich möchte etwas essen.',
    tokens: [],
    ...overrides,
  };
}

describe('extension LLM helpers (E-9, #87)', () => {
  it('sanitizes translationMode to off by default and allows en/de', () => {
    expect(sanitizeSettings({}).translationMode).toBe('off');
    expect(sanitizeSettings({ translationMode: 'en' }).translationMode).toBe('en');
    expect(sanitizeSettings({ translationMode: 'de' }).translationMode).toBe('de');
    expect(
      sanitizeSettings({ translationMode: 'fr' as unknown as 'off' }).translationMode,
    ).toBe('off');
  });

  it('maps gloss language and resolves overlay translation respecting off/en/de and temporary reveal', () => {
    expect(glossLangToLlmLang('eng')).toBe('en');
    expect(glossLangToLlmLang('ger')).toBe('de');

    const line = makeLine();
    const emptyReveal = new Set<number>();
    const revealed = new Set<number>([10]);

    // Default off hides translation unless temporarily revealed
    expect(resolveOverlayTranslation(line, 'off', emptyReveal, 'eng')).toBeNull();
    expect(resolveOverlayTranslation(line, 'off', revealed, 'eng')).toEqual({
      text: 'I want to eat something.',
      lang: 'en',
    });
    expect(resolveOverlayTranslation(line, 'off', revealed, 'ger')).toEqual({
      text: 'Ich möchte etwas essen.',
      lang: 'de',
    });

    // Always-on EN or DE modes
    expect(resolveOverlayTranslation(line, 'en', emptyReveal, 'ger')).toEqual({
      text: 'I want to eat something.',
      lang: 'en',
    });
    expect(resolveOverlayTranslation(line, 'de', emptyReveal, 'eng')).toEqual({
      text: 'Ich möchte etwas essen.',
      lang: 'de',
    });

    // Fallback when preferred language is missing
    const enOnly = makeLine({ translation_de: null });
    expect(pickLineTranslationForLang(enOnly, 'de')).toEqual({
      text: 'I want to eat something.',
      lang: 'en',
    });
    expect(pickLineTranslationForLang(makeLine({ translation_en: null, translation_de: null }), 'en')).toBeNull();
  });

  it('finds active line or falls back to most recent spoken line for Explain / Reveal', () => {
    const lines = [
      makeLine({ id: 1, start_ms: 1000, end_ms: 3000 }),
      makeLine({ id: 2, start_ms: 5000, end_ms: 8000 }),
    ];
    expect(findLineForAction(lines, 2000, 0)?.id).toBe(1);
    // In gap right after line 1 ended
    expect(findLineForAction(lines, 4000, 0)?.id).toBe(1);
    // Before first line
    expect(findLineForAction(lines, 500, 0)).toBeNull();
  });

  it('parses Markdown blocks and inline syntax safely into DOM without raw HTML injection', () => {
    const md = [
      '## Grammar Note',
      '**Translation:** I want to eat something.',
      '',
      '- **何か** (`なにか`) – *something*',
      '- **食べたい** – want to eat (`〜たい` form)',
      '',
      '1. Take stem `食べ`',
      '2. Add `たい`',
      '',
      '> Note: `<script>alert(1)</script>` must stay plain text.',
    ].join('\n');

    const blocks = parseMarkdown(md);
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'ul', 'ol', 'blockquote']);

    const inline = parseInlineMarkdown('**食べ** (`たべ`) *desire*');
    expect(inline).toEqual([
      { type: 'bold', text: '食べ' },
      { type: 'text', text: ' (' },
      { type: 'code', text: 'たべ' },
      { type: 'text', text: ') ' },
      { type: 'italic', text: 'desire' },
    ]);

    const frag = renderMarkdownToFragment(document, md);
    const container = document.createElement('div');
    container.appendChild(frag);
    expect(container.querySelector('h4')?.textContent).toBe('Grammar Note');
    expect(container.querySelectorAll('ul li')).toHaveLength(2);
    expect(container.querySelectorAll('ol li')).toHaveLength(2);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('blockquote')?.textContent).toContain('<script>alert(1)</script>');
  });
});
