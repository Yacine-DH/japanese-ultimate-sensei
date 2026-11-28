import type { LineOut, LLMStatus, TranslationJob, WordStatus } from '../api/client';
import { findLineToReplay } from './replay';
import type { GlossLanguage, TranslationDisplayMode } from './settings';
import { findActiveLines } from './timing';

export const TRANSLATION_POLL_INTERVAL_MS = 60_000;

export type LlmLang = 'en' | 'de';

export type TranslationProgressStatus =
  | 'ready'
  | 'translating'
  | 'queued'
  | 'offline'
  | 'unconfigured'
  | 'error'
  | 'partial'
  | 'not_started';

export type TranslationProgressTone = 'ok' | 'active' | 'warn' | 'muted';

export interface TranslationProgressPresentation {
  status: TranslationProgressStatus;
  text: string;
  tone: TranslationProgressTone;
  progressPct: number;
  showProgressBar: boolean;
  showSettingsLink: boolean;
  shouldPoll: boolean;
  detail: string | null;
}

export interface OverlayTranslation {
  text: string;
  lang: LlmLang;
}

export function isTranslationUnreachable(
  job: Pick<TranslationJob, 'error' | 'retry_at'>,
  llmStatus: Pick<LLMStatus, 'configured' | 'reachable'> | null = null,
): boolean {
  if (job.retry_at) {
    return true;
  }
  if (typeof job.error === 'string' && /unreachable/i.test(job.error)) {
    return true;
  }
  if (llmStatus && llmStatus.configured && !llmStatus.reachable) {
    return true;
  }
  return false;
}

export function formatTranslationProgress(
  job: TranslationJob,
  llmStatus: Pick<LLMStatus, 'configured' | 'reachable' | 'detail'> | null = null,
): TranslationProgressPresentation | null {
  if (job.total_lines <= 0) {
    return null;
  }

  const total = job.total_lines;
  const translated = Math.max(0, Math.min(job.translated_lines, total));
  const progressPct = Math.round((translated / total) * 100);

  if (translated >= total && !job.running) {
    return {
      status: 'ready',
      text: 'Translations ready',
      tone: 'ok',
      progressPct: 100,
      showProgressBar: false,
      showSettingsLink: false,
      shouldPoll: false,
      detail: null,
    };
  }

  if (isTranslationUnreachable(job, llmStatus)) {
    const detailParts: string[] = [];
    if (translated > 0) {
      detailParts.push(`${translated}/${total} translated so far`);
    }
    const reason = job.error?.trim() || llmStatus?.detail?.trim() || '';
    if (reason) {
      detailParts.push(reason);
    }
    return {
      status: 'offline',
      text: 'Laptop offline, translations will continue later',
      tone: 'warn',
      progressPct,
      showProgressBar: translated > 0,
      showSettingsLink: true,
      shouldPoll: Boolean(job.queued || job.running),
      detail: detailParts.length > 0 ? detailParts.join(' · ') : null,
    };
  }

  if (job.running) {
    return {
      status: 'translating',
      text: `Translating ${translated}/${total}`,
      tone: 'active',
      progressPct,
      showProgressBar: true,
      showSettingsLink: false,
      shouldPoll: true,
      detail: null,
    };
  }

  if (job.queued) {
    return {
      status: 'queued',
      text: `Translating ${translated}/${total} (queued)`,
      tone: 'active',
      progressPct,
      showProgressBar: true,
      showSettingsLink: false,
      shouldPoll: true,
      detail: null,
    };
  }

  if (llmStatus !== null && !llmStatus.configured) {
    return {
      status: 'unconfigured',
      text:
        translated > 0
          ? `Translated ${translated}/${total} (LLM not configured)`
          : 'Translations unavailable (LLM not configured)',
      tone: 'muted',
      progressPct,
      showProgressBar: false,
      showSettingsLink: true,
      shouldPoll: false,
      detail: llmStatus.detail?.trim() || 'Set up a model on the server',
    };
  }

  if (job.error) {
    return {
      status: 'error',
      text: `Translation paused (${translated}/${total})`,
      tone: 'warn',
      progressPct,
      showProgressBar: translated > 0,
      showSettingsLink: true,
      shouldPoll: false,
      detail: job.error,
    };
  }

  if (translated > 0) {
    const skipped = job.failed_lines > 0 ? ` (${job.failed_lines} skipped)` : '';
    return {
      status: 'partial',
      text: `Translated ${translated}/${total}${skipped}`,
      tone: 'muted',
      progressPct,
      showProgressBar: true,
      showSettingsLink: false,
      shouldPoll: false,
      detail: null,
    };
  }

  return {
    status: 'not_started',
    text: `Not translated yet (0/${total})`,
    tone: 'muted',
    progressPct: 0,
    showProgressBar: false,
    showSettingsLink: false,
    shouldPoll: false,
    detail: null,
  };
}

export function countTranslatedLines(lines: readonly LineOut[]): number {
  let count = 0;
  for (const line of lines) {
    if (line.translation_en?.trim() || line.translation_de?.trim()) {
      count += 1;
    }
  }
  return count;
}

export function isTranslationJobComplete(
  job: Pick<TranslationJob, 'translated_lines' | 'total_lines'> | null | undefined,
): boolean {
  if (!job || !Number.isFinite(job.total_lines) || job.total_lines <= 0) {
    return true;
  }
  if (!Number.isFinite(job.translated_lines)) {
    return false;
  }
  return job.translated_lines >= job.total_lines;
}

/**
 * Decide whether the overlay should refetch `/episodes/{id}/lines` after a
 * `GET /episodes/{id}/translate` poll returned `job`.
 */
export function shouldRefreshTranslations(
  prevTranslatedLines: number,
  job: Pick<TranslationJob, 'translated_lines' | 'total_lines'> | null | undefined,
): boolean {
  if (!job || !Number.isFinite(job.total_lines) || job.total_lines <= 0) {
    return false;
  }
  if (!Number.isFinite(job.translated_lines) || job.translated_lines <= 0) {
    return false;
  }
  const prev = Number.isFinite(prevTranslatedLines) ? Math.max(0, Math.floor(prevTranslatedLines)) : 0;
  return job.translated_lines > prev;
}

export interface TranslationPollCheckParams {
  episodeId: number | null;
  overlayEnabled: boolean;
  totalLines: number;
  translatedLines: number;
  complete: boolean;
  isPlaying: boolean;
  tabVisible: boolean;
  inFlight: boolean;
  nowMs: number;
  lastPollAtMs: number | null;
  intervalMs?: number;
}

/**
 * Decide whether the content script should poll `GET /episodes/{id}/translate` now.
 * Polls only while the episode has untranslated lines, the video is playing,
 * and the tab is visible, at most once per `intervalMs` (default 60 s).
 */
export function shouldPollTranslationProgress(params: TranslationPollCheckParams): boolean {
  if (
    params.episodeId === null ||
    !params.overlayEnabled ||
    params.totalLines <= 0 ||
    params.complete ||
    params.translatedLines >= params.totalLines ||
    !params.isPlaying ||
    !params.tabVisible ||
    params.inFlight
  ) {
    return false;
  }
  if (params.lastPollAtMs === null) {
    return true;
  }
  const intervalMs = params.intervalMs ?? TRANSLATION_POLL_INTERVAL_MS;
  return params.nowMs - params.lastPollAtMs >= intervalMs;
}

/**
 * Apply locally-changed word statuses on top of freshly-fetched lines so
 * in-flight translation refreshes never clobber recent Known/Ignore/Save clicks.
 */
export function applyWordStatusOverrides(
  lines: readonly LineOut[],
  overrides: ReadonlyMap<number, WordStatus>,
): LineOut[] {
  if (overrides.size === 0 || lines.length === 0) {
    return lines as LineOut[];
  }
  let anyChanged = false;
  const nextLines = lines.map((line) => {
    let lineChanged = false;
    const nextTokens = line.tokens.map((token) => {
      if (token.word_id === null) return token;
      const override = overrides.get(token.word_id);
      if (override === undefined || token.status === override) {
        return token;
      }
      lineChanged = true;
      return { ...token, status: override };
    });
    if (!lineChanged) {
      return line;
    }
    anyChanged = true;
    return { ...line, tokens: nextTokens };
  });
  return anyChanged ? nextLines : (lines as LineOut[]);
}

export type InlineNode =
  | { type: 'text'; text: string }
  | { type: 'bold'; text: string }
  | { type: 'italic'; text: string }
  | { type: 'code'; text: string };

export type MarkdownBlock =
  | { type: 'heading'; level: 1 | 2 | 3; inlines: InlineNode[] }
  | { type: 'paragraph'; inlines: InlineNode[] }
  | { type: 'ul'; items: InlineNode[][] }
  | { type: 'ol'; items: InlineNode[][] }
  | { type: 'blockquote'; inlines: InlineNode[] }
  | { type: 'code'; text: string };

export function glossLangToLlmLang(glossLang: GlossLanguage): LlmLang {
  return glossLang === 'ger' ? 'de' : 'en';
}

export function pickLineTranslationForLang(
  line: Pick<LineOut, 'translation_en' | 'translation_de'>,
  preferred: LlmLang,
): OverlayTranslation | null {
  const en = line.translation_en?.trim() ?? '';
  const de = line.translation_de?.trim() ?? '';

  if (preferred === 'de') {
    if (de) return { text: de, lang: 'de' };
    if (en) return { text: en, lang: 'en' };
    return null;
  }

  if (en) return { text: en, lang: 'en' };
  if (de) return { text: de, lang: 'de' };
  return null;
}

/**
 * Determine whether a line's translation should be displayed on the video overlay.
 * - When `mode` is `'en'` or `'de'`, always show in that language (falling back to the other).
 * - When `mode` is `'off'`, show only if the line is temporarily revealed via the hotkey,
 *   using `glossLang` to pick EN or DE.
 */
export function resolveOverlayTranslation(
  line: Pick<LineOut, 'id' | 'translation_en' | 'translation_de'>,
  mode: TranslationDisplayMode,
  revealedLineIds: ReadonlySet<number>,
  glossLang: GlossLanguage,
): OverlayTranslation | null {
  if (mode === 'off') {
    if (!revealedLineIds.has(line.id)) {
      return null;
    }
    return pickLineTranslationForLang(line, glossLangToLlmLang(glossLang));
  }
  return pickLineTranslationForLang(line, mode);
}

/** Pick the active subtitle line if one is visible, else fall back to the most recent line. */
export function findLineForAction(
  lines: readonly LineOut[],
  videoMs: number,
  subOffsetMs: number,
): LineOut | null {
  const active = findActiveLines(lines, videoMs, subOffsetMs);
  if (active.length > 0) {
    return active[0]!;
  }
  return findLineToReplay(lines, videoMs, subOffsetMs);
}

export function parseInlineMarkdown(input: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|(?<!\w)_[^_\n]+_(?!\w))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(input)) !== null) {
    if (match.index > lastIndex) {
      nodes.push({ type: 'text', text: input.slice(lastIndex, match.index) });
    }
    const token = match[0];
    if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push({ type: 'code', text: token.slice(1, -1) });
    } else if (
      (token.startsWith('**') && token.endsWith('**')) ||
      (token.startsWith('__') && token.endsWith('__'))
    ) {
      nodes.push({ type: 'bold', text: token.slice(2, -2) });
    } else if (
      (token.startsWith('*') && token.endsWith('*')) ||
      (token.startsWith('_') && token.endsWith('_'))
    ) {
      nodes.push({ type: 'italic', text: token.slice(1, -1) });
    } else {
      nodes.push({ type: 'text', text: token });
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < input.length) {
    nodes.push({ type: 'text', text: input.slice(lastIndex) });
  }

  return nodes.length > 0 ? nodes : [{ type: 'text', text: input }];
}

export function parseMarkdown(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i]!;
    const trimmed = raw.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    if (trimmed.startsWith('```')) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trim().startsWith('```')) {
        codeLines.push(lines[i]!);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ type: 'code', text: codeLines.join('\n') });
      continue;
    }

    const headingMatch = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      const level = Math.min(3, headingMatch[1]!.length) as 1 | 2 | 3;
      blocks.push({ type: 'heading', level, inlines: parseInlineMarkdown(headingMatch[2]!.trim()) });
      i += 1;
      continue;
    }

    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('>')) {
        quoteLines.push(lines[i]!.trim().replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push({ type: 'blockquote', inlines: parseInlineMarkdown(quoteLines.join(' ')) });
      continue;
    }

    if (/^\s*[-*•]\s+/.test(raw)) {
      const items: InlineNode[][] = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i]!)) {
        const text = lines[i]!.replace(/^\s*[-*•]\s+/, '').trim();
        items.push(parseInlineMarkdown(text));
        i += 1;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(raw)) {
      const items: InlineNode[][] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i]!)) {
        const text = lines[i]!.replace(/^\s*\d+[.)]\s+/, '').trim();
        items.push(parseInlineMarkdown(text));
        i += 1;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }

    const paraLines: string[] = [];
    while (i < lines.length) {
      const cur = lines[i]!;
      const curTrim = cur.trim();
      if (
        !curTrim ||
        curTrim.startsWith('```') ||
        /^#{1,3}\s+/.test(curTrim) ||
        curTrim.startsWith('>') ||
        /^\s*[-*•]\s+/.test(cur) ||
        /^\s*\d+[.)]\s+/.test(cur)
      ) {
        break;
      }
      paraLines.push(curTrim);
      i += 1;
    }
    blocks.push({ type: 'paragraph', inlines: parseInlineMarkdown(paraLines.join(' ')) });
  }

  return blocks;
}

function appendInlines(doc: Document, parent: Node, inlines: readonly InlineNode[]): void {
  for (const node of inlines) {
    if (node.type === 'bold') {
      const strong = doc.createElement('strong');
      strong.textContent = node.text;
      parent.appendChild(strong);
    } else if (node.type === 'italic') {
      const em = doc.createElement('em');
      em.textContent = node.text;
      parent.appendChild(em);
    } else if (node.type === 'code') {
      const code = doc.createElement('code');
      code.textContent = node.text;
      parent.appendChild(code);
    } else {
      parent.appendChild(doc.createTextNode(node.text));
    }
  }
}

/** Render Markdown safely into a DOM DocumentFragment (no raw HTML injection). */
export function renderMarkdownToFragment(doc: Document, markdown: string): DocumentFragment {
  const frag = doc.createDocumentFragment();
  const blocks = parseMarkdown(markdown);

  for (const block of blocks) {
    if (block.type === 'heading') {
      const tag = block.level === 1 ? 'h3' : block.level === 2 ? 'h4' : 'h5';
      const el = doc.createElement(tag);
      appendInlines(doc, el, block.inlines);
      frag.appendChild(el);
    } else if (block.type === 'ul') {
      const ul = doc.createElement('ul');
      for (const item of block.items) {
        const li = doc.createElement('li');
        appendInlines(doc, li, item);
        ul.appendChild(li);
      }
      frag.appendChild(ul);
    } else if (block.type === 'ol') {
      const ol = doc.createElement('ol');
      for (const item of block.items) {
        const li = doc.createElement('li');
        appendInlines(doc, li, item);
        ol.appendChild(li);
      }
      frag.appendChild(ol);
    } else if (block.type === 'blockquote') {
      const bq = doc.createElement('blockquote');
      appendInlines(doc, bq, block.inlines);
      frag.appendChild(bq);
    } else if (block.type === 'code') {
      const pre = doc.createElement('pre');
      pre.textContent = block.text;
      frag.appendChild(pre);
    } else {
      const p = doc.createElement('p');
      appendInlines(doc, p, block.inlines);
      frag.appendChild(p);
    }
  }

  return frag;
}
