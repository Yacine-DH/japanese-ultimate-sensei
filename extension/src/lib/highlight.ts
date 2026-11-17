import type { DictEntry, LineOut, Sense, TokenOut, WordStatus } from '../api/client';
import type { GlossLanguage } from './settings';
import { isWordUnderstood } from './furigana';

export function isUnknownContentToken(
  token: Pick<TokenOut, 'is_content' | 'status'>,
): boolean {
  return token.is_content && !isWordUnderstood(token.status);
}

export function rankHighlightedTokenIndices(
  tokens: readonly TokenOut[],
  maxHighlights = 3,
): Set<number> {
  const limit = Math.max(0, Math.floor(maxHighlights));
  if (limit === 0) {
    return new Set();
  }

  const candidates = tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token }) => isUnknownContentToken(token));

  candidates.sort((a, b) => {
    if (a.token.common !== b.token.common) {
      return a.token.common ? -1 : 1;
    }
    return a.index - b.index;
  });

  const selectedIndices = new Set<number>();
  const seenWords = new Set<string>();

  for (const { token, index } of candidates) {
    const key =
      token.word_id !== null
        ? `id:${token.word_id}`
        : `lemma:${token.lemma}:${token.lemma_reading}`;
    if (seenWords.has(key)) {
      selectedIndices.add(index);
      continue;
    }
    if (seenWords.size >= limit) {
      continue;
    }
    seenWords.add(key);
    selectedIndices.add(index);
  }

  return selectedIndices;
}

export function selectSensesForLanguage(
  entry: Pick<DictEntry, 'senses'>,
  preferredLang: GlossLanguage,
): { lang: GlossLanguage; senses: Sense[] } {
  const primary = entry.senses[preferredLang];
  if (primary && primary.length > 0) {
    return { lang: preferredLang, senses: primary };
  }
  const fallbackLang: GlossLanguage = preferredLang === 'ger' ? 'eng' : 'ger';
  const fallback = entry.senses[fallbackLang] ?? [];
  return { lang: fallback.length > 0 ? fallbackLang : preferredLang, senses: fallback };
}

export function updateWordStatusInLines(
  lines: readonly LineOut[],
  wordId: number,
  status: WordStatus,
): LineOut[] {
  return lines.map((line) => {
    let changed = false;
    const nextTokens = line.tokens.map((tok) => {
      if (tok.word_id === wordId && tok.status !== status) {
        changed = true;
        return { ...tok, status };
      }
      return tok;
    });
    return changed ? { ...line, tokens: nextTokens } : line;
  });
}
