import type { LineOut } from '../api/client';
import { findLineToReplay } from './replay';
import type { GlossLanguage, TranslationDisplayMode } from './settings';
import { findActiveLines } from './timing';

export type LlmLang = 'en' | 'de';

export interface OverlayTranslation {
  text: string;
  lang: LlmLang;
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
