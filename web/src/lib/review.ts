import type { LineOut, MediaOut } from '../api/client';
import { type GlossLanguage, resolveApiBaseUrl } from './settings';

export type ReviewRating = 1 | 2 | 3 | 4;

export interface RatingMeta {
  rating: ReviewRating;
  key: '1' | '2' | '3' | '4';
  label: string;
  colorClass: string;
}

export const RATING_BUTTONS: readonly RatingMeta[] = [
  {
    rating: 1,
    key: '1',
    label: 'Again',
    colorClass: 'border-rose-500/50 bg-rose-500/15 hover:bg-rose-500/25 text-rose-200',
  },
  {
    rating: 2,
    key: '2',
    label: 'Hard',
    colorClass: 'border-amber-500/50 bg-amber-500/15 hover:bg-amber-500/25 text-amber-200',
  },
  {
    rating: 3,
    key: '3',
    label: 'Good',
    colorClass: 'border-emerald-500/50 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200',
  },
  {
    rating: 4,
    key: '4',
    label: 'Easy',
    colorClass: 'border-sky-500/50 bg-sky-500/15 hover:bg-sky-500/25 text-sky-200',
  },
];

/** Formats an ISO timestamp from `next_due["1".."4"]` into a compact interval label ("1m", "6m", "7d", "2.1mo"). */
export function formatIntervalFromIso(
  dueIso: string | undefined,
  nowMs: number = Date.now(),
): string {
  if (!dueIso) return '';
  const dueMs = Date.parse(dueIso);
  if (!Number.isFinite(dueMs)) return '';

  const diffSec = Math.max(0, Math.round((dueMs - nowMs) / 1000));
  if (diffSec < 60) {
    return '<1m';
  }
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) {
    return `${diffMin}m`;
  }
  const diffHours = diffSec / 3600;
  if (diffHours < 24) {
    return `${Math.round(diffHours)}h`;
  }
  const diffDays = diffSec / 86400;
  if (diffDays < 30) {
    return `${Math.round(diffDays)}d`;
  }
  const diffMonths = diffDays / 30;
  if (diffMonths < 12) {
    return `${Number(diffMonths.toFixed(1))}mo`;
  }
  const diffYears = diffDays / 365;
  return `${Number(diffYears.toFixed(1))}y`;
}

export function resolveMediaUrl(relativeUrl: string, configuredServerUrl: string): string {
  if (/^https?:\/\//.test(relativeUrl)) {
    return relativeUrl;
  }
  const base = resolveApiBaseUrl(configuredServerUrl);
  const path = relativeUrl.startsWith('/') ? relativeUrl : `/${relativeUrl}`;
  return `${base}${path}`;
}

export interface GroupedCardMedia {
  screenshot: MediaOut | null;
  audio: MediaOut | null;
  clip: MediaOut | null;
}

export function groupCardMedia(media: readonly MediaOut[]): GroupedCardMedia {
  let screenshot: MediaOut | null = null;
  let audio: MediaOut | null = null;
  let clip: MediaOut | null = null;
  for (const m of media) {
    if (m.kind === 'screenshot' && !screenshot) screenshot = m;
    else if (m.kind === 'audio' && !audio) audio = m;
    else if (m.kind === 'clip' && !clip) clip = m;
  }
  return { screenshot, audio, clip };
}

export interface ReviewTranslationEntry {
  lang: 'EN' | 'DE';
  text: string;
}

export interface ReviewSentenceTranslation {
  primary: ReviewTranslationEntry;
  secondary: ReviewTranslationEntry | null;
}

/**
 * Formats a review card's sentence translation for the answer side according to
 * the user's gloss language setting (`eng` or `ger`).
 * Returns `null` when the line is missing or has no non-empty translations.
 */
export function formatReviewSentenceTranslation(
  line: Pick<LineOut, 'translation_en' | 'translation_de'> | null | undefined,
  glossLang: GlossLanguage,
): ReviewSentenceTranslation | null {
  if (!line) return null;
  const en = line.translation_en?.trim() ?? '';
  const de = line.translation_de?.trim() ?? '';
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

export type ReviewHotkeyResult =
  | { type: 'reveal' }
  | { type: 'rate'; rating: ReviewRating }
  | { type: 'replay' }
  | null;

export interface ReviewKeyEventLike {
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export function resolveReviewHotkey(
  event: ReviewKeyEventLike,
  revealed: boolean,
): ReviewHotkeyResult {
  if (event.altKey || event.ctrlKey || event.shiftKey || event.metaKey) {
    return null;
  }
  if (event.code === 'KeyR') {
    return { type: 'replay' };
  }
  if (!revealed) {
    if (event.code === 'Space' || event.code === 'Enter') {
      return { type: 'reveal' };
    }
    return null;
  }
  if (event.code === 'Digit1' || event.code === 'Numpad1') return { type: 'rate', rating: 1 };
  if (event.code === 'Digit2' || event.code === 'Numpad2') return { type: 'rate', rating: 2 };
  if (event.code === 'Digit3' || event.code === 'Numpad3') return { type: 'rate', rating: 3 };
  if (event.code === 'Digit4' || event.code === 'Numpad4') return { type: 'rate', rating: 4 };
  return null;
}
