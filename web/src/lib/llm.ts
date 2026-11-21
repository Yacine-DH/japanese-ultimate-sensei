import type { LineOut, TranslationJob } from '../api/client';
import type { GlossLanguage } from './settings';

export type LlmLang = 'en' | 'de';

export interface ResolvedTranslation {
  text: string;
  lang: LlmLang;
  isFallback: boolean;
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

export function pickLineTranslation(
  line: Pick<LineOut, 'translation_en' | 'translation_de'>,
  glossLang: GlossLanguage,
): ResolvedTranslation | null {
  const preferred = glossLangToLlmLang(glossLang);
  const en = line.translation_en?.trim() ?? '';
  const de = line.translation_de?.trim() ?? '';

  if (preferred === 'de') {
    if (de) return { text: de, lang: 'de', isFallback: false };
    if (en) return { text: en, lang: 'en', isFallback: true };
    return null;
  }

  if (en) return { text: en, lang: 'en', isFallback: false };
  if (de) return { text: de, lang: 'de', isFallback: true };
  return null;
}

export function countTranslatedLines(
  lines: readonly Pick<LineOut, 'translation_en' | 'translation_de'>[],
): number {
  let count = 0;
  for (const line of lines) {
    if ((line.translation_en && line.translation_en.trim()) || (line.translation_de && line.translation_de.trim())) {
      count += 1;
    }
  }
  return count;
}

export function isTranslationJobActive(job: TranslationJob | null | undefined): boolean {
  return Boolean(job && (job.running || job.queued));
}

export function computeTranslationProgress(
  job: Pick<TranslationJob, 'translated_lines' | 'total_lines'> | null | undefined,
): number {
  if (!job || job.total_lines <= 0) return 0;
  const pct = (job.translated_lines / job.total_lines) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

/**
 * Parse inline Markdown (`**bold**`, `__bold__`, `*italic*`, `_italic_`, `` `code` ``)
 * into safe structured nodes without ever evaluating raw HTML.
 */
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

/**
 * Lightweight, XSS-safe Markdown block parser tailored for LLM grammar explanations
 * (headings, bullet lists, numbered lists, blockquotes, fenced code blocks, paragraphs).
 */
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

    // Fenced code block
    if (trimmed.startsWith('```')) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trim().startsWith('```')) {
        codeLines.push(lines[i]!);
        i += 1;
      }
      if (i < lines.length) i += 1; // skip closing fence
      blocks.push({ type: 'code', text: codeLines.join('\n') });
      continue;
    }

    // Heading (#, ##, ###)
    const headingMatch = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      const level = Math.min(3, headingMatch[1]!.length) as 1 | 2 | 3;
      blocks.push({ type: 'heading', level, inlines: parseInlineMarkdown(headingMatch[2]!.trim()) });
      i += 1;
      continue;
    }

    // Blockquote (> ...)
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('>')) {
        quoteLines.push(lines[i]!.trim().replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push({ type: 'blockquote', inlines: parseInlineMarkdown(quoteLines.join(' ')) });
      continue;
    }

    // Unordered list (-, *, •)
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

    // Ordered list (1. ..., 2) ...)
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

    // Paragraph (join consecutive plain lines until blank line or structural block)
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
