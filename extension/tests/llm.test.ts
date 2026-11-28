import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LineOut, LLMStatus, TranslationJob } from '../src/api/client';
import {
  applyWordStatusOverrides,
  countTranslatedLines,
  findLineForAction,
  formatTranslationProgress,
  glossLangToLlmLang,
  isTranslationJobComplete,
  isTranslationUnreachable,
  parseInlineMarkdown,
  parseMarkdown,
  pickLineTranslationForLang,
  renderMarkdownToFragment,
  resolveOverlayTranslation,
  shouldPollTranslationProgress,
  shouldRefreshTranslations,
  TRANSLATION_POLL_INTERVAL_MS,
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

  it('hides overlay translation row when line is untranslated or whitespace-only (#135)', () => {
    const emptyLine = makeLine({ translation_en: null, translation_de: null });
    const blankLine = makeLine({ translation_en: '   ', translation_de: '\n\t' });
    const revealed = new Set<number>([10]);

    expect(resolveOverlayTranslation(emptyLine, 'en', revealed, 'eng')).toBeNull();
    expect(resolveOverlayTranslation(emptyLine, 'de', revealed, 'ger')).toBeNull();
    expect(resolveOverlayTranslation(blankLine, 'en', new Set(), 'eng')).toBeNull();
    expect(resolveOverlayTranslation(blankLine, 'off', revealed, 'ger')).toBeNull();
  });
});

function makeJob(overrides: Partial<TranslationJob> = {}): TranslationJob {
  return {
    episode_id: 7,
    total_lines: 379,
    translated_lines: 0,
    queued: false,
    running: false,
    error: null,
    failed_lines: 0,
    retry_at: null,
    ...overrides,
  };
}

function makeLlmStatus(overrides: Partial<LLMStatus> = {}): LLMStatus {
  return {
    configured: true,
    reachable: true,
    model: 'gemma3:4b',
    base_url: 'http://precision:11434/v1',
    detail: 'ok',
    ...overrides,
  };
}

describe('popup translation progress helpers (E-16, #135)', () => {
  it('formats active translation progress and enables polling', () => {
    const pres = formatTranslationProgress(
      makeJob({ translated_lines: 120, total_lines: 379, running: true }),
      makeLlmStatus(),
    );
    expect(pres).toEqual({
      status: 'translating',
      text: 'Translating 120/379',
      tone: 'active',
      progressPct: 32,
      showProgressBar: true,
      showSettingsLink: false,
      shouldPoll: true,
      detail: null,
    });
  });

  it('formats queued translation progress and polls until started/done', () => {
    const pres = formatTranslationProgress(
      makeJob({ translated_lines: 0, total_lines: 379, queued: true }),
      makeLlmStatus(),
    );
    expect(pres).toMatchObject({
      status: 'queued',
      text: 'Translating 0/379 (queued)',
      tone: 'active',
      progressPct: 0,
      showProgressBar: true,
      showSettingsLink: false,
      shouldPoll: true,
    });
  });

  it('shows "Translations ready" when all lines are translated, even if laptop is offline', () => {
    const pres = formatTranslationProgress(
      makeJob({ translated_lines: 379, total_lines: 379, running: false }),
      makeLlmStatus({ reachable: false, detail: 'Connection refused' }),
    );
    expect(pres).toEqual({
      status: 'ready',
      text: 'Translations ready',
      tone: 'ok',
      progressPct: 100,
      showProgressBar: false,
      showSettingsLink: false,
      shouldPoll: false,
      detail: null,
    });
  });

  it('reports laptop offline with Settings link when retry_at, unreachable error, or unreachable LLM status is present', () => {
    const viaRetryAt = formatTranslationProgress(
      makeJob({
        translated_lines: 48,
        total_lines: 379,
        queued: true,
        error: 'LLM unreachable (connection timed out)',
        retry_at: '2026-11-23T16:50:00Z',
      }),
      null,
    );
    expect(viaRetryAt).toMatchObject({
      status: 'offline',
      text: 'Laptop offline, translations will continue later',
      tone: 'warn',
      showProgressBar: true,
      showSettingsLink: true,
      shouldPoll: true,
    });
    expect(viaRetryAt?.detail).toContain('48/379 translated so far');

    const viaLlmStatus = formatTranslationProgress(
      makeJob({ translated_lines: 0, total_lines: 379, queued: false }),
      makeLlmStatus({ configured: true, reachable: false, detail: 'timed out' }),
    );
    expect(viaLlmStatus).toMatchObject({
      status: 'offline',
      text: 'Laptop offline, translations will continue later',
      tone: 'warn',
      showProgressBar: false,
      showSettingsLink: true,
      shouldPoll: false,
      detail: 'timed out',
    });

    expect(
      isTranslationUnreachable(
        makeJob({ error: 'upstream server unreachable' }),
        null,
      ),
    ).toBe(true);
  });

  it('handles unconfigured LLM, non-unreachable errors, partial/idle jobs, and empty episodes', () => {
    const unconfigured = formatTranslationProgress(
      makeJob({ translated_lines: 0, total_lines: 200 }),
      makeLlmStatus({ configured: false, reachable: false, model: null, detail: 'not configured' }),
    );
    expect(unconfigured).toMatchObject({
      status: 'unconfigured',
      showSettingsLink: true,
      shouldPoll: false,
    });

    const otherErr = formatTranslationProgress(
      makeJob({ translated_lines: 10, total_lines: 200, error: 'HTTP 500 internal error' }),
      makeLlmStatus(),
    );
    expect(otherErr).toMatchObject({
      status: 'error',
      text: 'Translation paused (10/200)',
      showSettingsLink: true,
      detail: 'HTTP 500 internal error',
    });

    const partial = formatTranslationProgress(
      makeJob({ translated_lines: 180, total_lines: 200, failed_lines: 4 }),
      makeLlmStatus(),
    );
    expect(partial).toMatchObject({
      status: 'partial',
      text: 'Translated 180/200 (4 skipped)',
      shouldPoll: false,
    });

    const notStarted = formatTranslationProgress(
      makeJob({ translated_lines: 0, total_lines: 200 }),
      makeLlmStatus(),
    );
    expect(notStarted).toMatchObject({
      status: 'not_started',
      text: 'Not translated yet (0/200)',
      shouldPoll: false,
    });

    expect(formatTranslationProgress(makeJob({ total_lines: 0 }), makeLlmStatus())).toBeNull();
  });

  it('wires translation progress and Settings link into the popup', () => {
    const popupHtml = readFileSync(resolve(__dirname, '../entrypoints/popup/index.html'), 'utf-8');
    const popupMain = readFileSync(resolve(__dirname, '../entrypoints/popup/main.ts'), 'utf-8');
    expect(popupHtml).toContain('id="translation-progress-wrap"');
    expect(popupHtml).toContain('id="translation-settings-link"');
    expect(popupMain).toContain('getTranslationJob');
    expect(popupMain).toContain('formatTranslationProgress');
    expect(popupMain).toContain('buildSettingsUrl');
  });
});

describe('overlay live translation refresh helpers (#186)', () => {
  it('counts translated lines ignoring null and whitespace-only values', () => {
    const sample = [
      makeLine({ id: 1, translation_en: 'Hello', translation_de: null }),
      makeLine({ id: 2, translation_en: null, translation_de: 'Hallo' }),
      makeLine({ id: 3, translation_en: '   ', translation_de: '\n' }),
      makeLine({ id: 4, translation_en: null, translation_de: null }),
    ];
    expect(countTranslatedLines(sample)).toBe(2);
    expect(countTranslatedLines([])).toBe(0);
  });

  it('refreshes translations only when translated_lines grew past previous count', () => {
    expect(shouldRefreshTranslations(10, makeJob({ translated_lines: 22, total_lines: 300 }))).toBe(
      true,
    );
    expect(shouldRefreshTranslations(10, makeJob({ translated_lines: 10, total_lines: 300 }))).toBe(
      false,
    );
    expect(shouldRefreshTranslations(10, makeJob({ translated_lines: 5, total_lines: 300 }))).toBe(
      false,
    );
    expect(shouldRefreshTranslations(0, makeJob({ translated_lines: 0, total_lines: 300 }))).toBe(
      false,
    );
    expect(shouldRefreshTranslations(0, makeJob({ translated_lines: 5, total_lines: 0 }))).toBe(
      false,
    );
    expect(shouldRefreshTranslations(0, null)).toBe(false);
  });

  it('detects translation job completion', () => {
    expect(isTranslationJobComplete(makeJob({ translated_lines: 300, total_lines: 300 }))).toBe(
      true,
    );
    expect(isTranslationJobComplete(makeJob({ translated_lines: 299, total_lines: 300 }))).toBe(
      false,
    );
    expect(isTranslationJobComplete(makeJob({ translated_lines: 0, total_lines: 0 }))).toBe(true);
    expect(isTranslationJobComplete(null)).toBe(true);
  });

  it('polls only while playing, tab visible, incomplete, and interval elapsed', () => {
    const base = {
      episodeId: 42,
      overlayEnabled: true,
      totalLines: 300,
      translatedLines: 10,
      complete: false,
      isPlaying: true,
      tabVisible: true,
      inFlight: false,
      nowMs: 120_000,
      lastPollAtMs: 50_000,
    };

    expect(shouldPollTranslationProgress(base)).toBe(true);
    expect(shouldPollTranslationProgress({ ...base, lastPollAtMs: null })).toBe(true);
    expect(
      shouldPollTranslationProgress({
        ...base,
        nowMs: 50_000 + TRANSLATION_POLL_INTERVAL_MS - 1,
      }),
    ).toBe(false);
    expect(
      shouldPollTranslationProgress({
        ...base,
        nowMs: 50_000 + TRANSLATION_POLL_INTERVAL_MS,
      }),
    ).toBe(true);

    // Stops when complete, paused, hidden, detached, inFlight, or all translated
    expect(shouldPollTranslationProgress({ ...base, complete: true })).toBe(false);
    expect(shouldPollTranslationProgress({ ...base, translatedLines: 300 })).toBe(false);
    expect(shouldPollTranslationProgress({ ...base, isPlaying: false })).toBe(false);
    expect(shouldPollTranslationProgress({ ...base, tabVisible: false })).toBe(false);
    expect(shouldPollTranslationProgress({ ...base, inFlight: true })).toBe(false);
    expect(shouldPollTranslationProgress({ ...base, overlayEnabled: false })).toBe(false);
    expect(shouldPollTranslationProgress({ ...base, episodeId: null })).toBe(false);
    expect(shouldPollTranslationProgress({ ...base, totalLines: 0 })).toBe(false);
  });

  it('preserves local word-status overrides when swapping in freshly-translated lines', () => {
    const freshLines: LineOut[] = [
      makeLine({
        id: 1,
        translation_en: 'Freshly translated!',
        tokens: [
          {
            surface: '食べる',
            reading: 'たべる',
            lemma: '食べる',
            lemma_reading: 'たべる',
            pos: '動詞',
            pos_detail: [],
            romaji: 'taberu',
            is_content: true,
            is_proper_noun: false,
            word_id: 101,
            status: 'new',
            common: true,
            zipf: 5.2,
            furigana: [],
          },
          {
            surface: '猫',
            reading: 'ねこ',
            lemma: '猫',
            lemma_reading: 'ねこ',
            pos: '名詞',
            pos_detail: [],
            romaji: 'neko',
            is_content: true,
            is_proper_noun: false,
            word_id: 202,
            status: 'new',
            common: true,
            zipf: 4.8,
            furigana: [],
          },
        ],
      }),
    ];

    const overrides = new Map<number, 'known' | 'learning' | 'ignored' | 'new'>([
      [101, 'known'],
    ]);
    const merged = applyWordStatusOverrides(freshLines, overrides);
    expect(merged[0]?.translation_en).toBe('Freshly translated!');
    expect(merged[0]?.tokens[0]?.status).toBe('known');
    expect(merged[0]?.tokens[1]?.status).toBe('new');

    // Preserves array reference when no overrides apply
    const unchanged = applyWordStatusOverrides(freshLines, new Map([[999, 'ignored']]));
    expect(unchanged).toBe(freshLines);
  });
});
