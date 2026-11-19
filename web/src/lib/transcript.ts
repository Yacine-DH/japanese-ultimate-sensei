import type {
  DictEntry,
  EpisodeOut,
  LineOut,
  Sense,
  TokenOut,
  Understanding,
  WordStatus,
} from '../api/client';
import type { GlossLanguage } from './settings';

export interface AnimeGroup {
  key: string;
  animeId: number | null;
  title: string;
  episodes: EpisodeOut[];
}

export function groupEpisodesByAnime(episodes: readonly EpisodeOut[]): AnimeGroup[] {
  const groups = new Map<string, AnimeGroup>();

  for (const ep of episodes) {
    const title = ep.anime_title?.trim() || 'Untitled Anime';
    const key = ep.anime_id !== null ? `id:${ep.anime_id}` : `title:${title.toLowerCase()}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        animeId: ep.anime_id,
        title,
        episodes: [],
      };
      groups.set(key, group);
    }
    group.episodes.push(ep);
  }

  const result = Array.from(groups.values());
  for (const g of result) {
    g.episodes.sort((a, b) => {
      if (a.number !== null && b.number !== null && a.number !== b.number) {
        return a.number - b.number;
      }
      if (a.number !== null && b.number === null) return -1;
      if (a.number === null && b.number !== null) return 1;
      return a.id - b.id;
    });
  }

  result.sort((a, b) => a.title.localeCompare(b.title));
  return result;
}

export function formatTimestampMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}

export function isWordUnderstood(status: TokenOut['status']): boolean {
  return status === 'known' || status === 'ignored';
}

export function shouldShowFurigana(
  token: Pick<TokenOut, 'status'>,
  ruby: string | null,
): boolean {
  if (!ruby) return false;
  return !isWordUnderstood(token.status);
}

export function buildRomajiLine(tokens: readonly Pick<TokenOut, 'romaji'>[]): string {
  return tokens
    .map((t) => t.romaji.trim())
    .filter((r) => r.length > 0)
    .join(' ');
}

export function lineHasUnknownContentWord(line: Pick<LineOut, 'tokens'>): boolean {
  return line.tokens.some((tok) => tok.is_content && !isWordUnderstood(tok.status));
}

export function filterTranscriptLines(
  lines: readonly LineOut[],
  query: string,
  onlyUnknown: boolean,
): LineOut[] {
  const q = query.trim().toLowerCase();
  return lines.filter((line) => {
    if (onlyUnknown && !lineHasUnknownContentWord(line)) {
      return false;
    }
    if (!q) {
      return true;
    }
    if (line.text.toLowerCase().includes(q)) {
      return true;
    }
    return line.tokens.some(
      (t) =>
        t.lemma.toLowerCase().includes(q) ||
        t.reading.toLowerCase().includes(q) ||
        t.lemma_reading.toLowerCase().includes(q) ||
        t.romaji.toLowerCase().includes(q),
    );
  });
}

export function updateWordStatusInTranscript(
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

export function pickEntrySenses(
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

export function computeBarSegments(u: Understanding): {
  knownPct: number;
  learningPct: number;
} {
  if (u.total_tokens <= 0) {
    return { knownPct: 0, learningPct: 0 };
  }
  const knownPct = Math.max(0, Math.min(100, u.token_pct));
  const rawLearning = (u.learning_tokens / u.total_tokens) * 100;
  const learningPct = Math.max(0, Math.min(100 - knownPct, Number(rawLearning.toFixed(1))));
  return { knownPct, learningPct };
}
