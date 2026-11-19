import type { FuriganaSegment, LineOut, TokenOut } from '../api/client';

export function isWordUnderstood(
  status: TokenOut['status'],
): boolean {
  return status === 'known' || status === 'ignored';
}

export function shouldShowRuby(
  token: Pick<TokenOut, 'status'>,
  segment: FuriganaSegment,
): boolean {
  if (!segment.ruby) {
    return false;
  }
  return !isWordUnderstood(token.status);
}

export function renderTokenSegments(
  token: Pick<TokenOut, 'status' | 'furigana'>,
): FuriganaSegment[] {
  return token.furigana.map((seg) => ({
    text: seg.text,
    ruby: shouldShowRuby(token, seg) ? seg.ruby : null,
  }));
}

export function buildLineRomaji(tokens: readonly Pick<TokenOut, 'romaji'>[]): string {
  return tokens
    .map((t) => t.romaji.trim())
    .filter((r) => r.length > 0)
    .join(' ');
}

/** Prefer server-grouped LineOut.romaji (#8); fall back to joining token romaji only if absent. */
export function getLineRomaji(line: Pick<LineOut, 'romaji' | 'tokens'>): string {
  const grouped = line.romaji?.trim();
  if (grouped) {
    return grouped;
  }
  return buildLineRomaji(line.tokens);
}
