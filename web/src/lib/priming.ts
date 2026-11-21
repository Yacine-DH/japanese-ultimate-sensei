import type { LineOut, Understanding, WordListItem } from '../api/client';

export const PRIMING_WORD_LIMIT = 10;

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
