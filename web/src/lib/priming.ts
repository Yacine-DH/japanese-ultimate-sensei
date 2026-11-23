import type {
  LineOut,
  MissedWord,
  ReviewCard,
  Understanding,
  WordListItem,
} from '../api/client';
import { groupCardMedia, resolveMediaUrl } from './review';
import type { GlossLanguage } from './settings';

export const PRIMING_WORD_LIMIT = 10;

export interface PrepGlossEntry {
  lang: 'EN' | 'DE';
  text: string;
}

export interface PrepGlosses {
  primary: PrepGlossEntry;
  secondary: PrepGlossEntry | null;
}

export interface PrepAudioIndex {
  byLineId: Map<number, string>;
  byWordId: Map<number, string>;
}

export function findFirstLineForWord(
  lines: readonly LineOut[],
  wordId: number,
): LineOut | null {
  for (const line of lines) {
    if (line.tokens.some((t) => t.word_id === wordId)) {
      return line;
    }
  }
  return null;
}

/**
 * Matches a prep/missed word's example line against the loaded episode lines
 * (for furigana token rendering), falling back to the first line containing the word.
 */
export function resolveExampleLine(
  item: Pick<MissedWord, 'word' | 'example'>,
  lines: readonly LineOut[],
): LineOut | null {
  const exampleLineId = item.example?.line_id;
  if (typeof exampleLineId === 'number') {
    const exact = lines.find((line) => line.id === exampleLineId);
    if (exact) return exact;
  }
  return findFirstLineForWord(lines, item.word.id);
}

/**
 * Formats a prep word's EN/DE glosses according to the user's gloss language setting.
 * Returns `null` when both glosses are missing/empty.
 */
export function formatPrepGlosses(
  item: Pick<MissedWord, 'gloss_en' | 'gloss_de'>,
  glossLang: GlossLanguage,
): PrepGlosses | null {
  const en = item.gloss_en?.trim() ?? '';
  const de = item.gloss_de?.trim() ?? '';
  if (!en && !de) return null;

  if (glossLang === 'ger') {
    if (de) {
      return {
        primary: { lang: 'DE', text: de },
        secondary: en && en !== de ? { lang: 'EN', text: en } : null,
      };
    }
    return { primary: { lang: 'EN', text: en }, secondary: null };
  }

  if (en) {
    return {
      primary: { lang: 'EN', text: en },
      secondary: de && de !== en ? { lang: 'DE', text: de } : null,
    };
  }
  return { primary: { lang: 'DE', text: de }, secondary: null };
}

/**
 * Indexes pre-signed line audio URLs from existing review cards by both `line.id` and `word.id`.
 */
export function indexAudioUrlsByLineAndWord(
  cards: readonly ReviewCard[],
  configuredServerUrl: string,
): PrepAudioIndex {
  const byLineId = new Map<number, string>();
  const byWordId = new Map<number, string>();

  for (const card of cards) {
    const { audio } = groupCardMedia(card.media);
    if (!audio?.url) continue;
    const resolved = resolveMediaUrl(audio.url, configuredServerUrl);
    if (card.line && !byLineId.has(card.line.id)) {
      byLineId.set(card.line.id, resolved);
    } else if (card.card.line_id !== null && !byLineId.has(card.card.line_id)) {
      byLineId.set(card.card.line_id, resolved);
    }
    if (!byWordId.has(card.word.id)) {
      byWordId.set(card.word.id, resolved);
    }
  }

  return { byLineId, byWordId };
}

export function resolvePrepAudioUrl(
  item: Pick<MissedWord, 'word' | 'example'>,
  index: PrepAudioIndex,
): string | null {
  const lineId = item.example?.line_id;
  if (typeof lineId === 'number') {
    const byLine = index.byLineId.get(lineId);
    if (byLine) return byLine;
  }
  return index.byWordId.get(item.word.id) ?? null;
}

export function shouldOpenPrepFromSearchParams(params: URLSearchParams): boolean {
  return params.get('prep') === '1' || params.get('prime') === '1';
}

export function sumPrimingOccurrences(words: readonly WordListItem[]): number {
  return words.reduce((acc, w) => acc + Math.max(0, w.occurrences ?? 0), 0);
}

export function estimateCoverageGainPct(
  understanding: Pick<Understanding, 'total_tokens'> | null | undefined,
  words: readonly WordListItem[],
): number {
  if (!understanding || understanding.total_tokens <= 0) {
    return 0;
  }
  const coveredTokens = sumPrimingOccurrences(words);
  return Number(((coveredTokens / understanding.total_tokens) * 100).toFixed(1));
}
