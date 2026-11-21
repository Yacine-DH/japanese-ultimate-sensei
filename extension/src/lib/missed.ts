import type { ApiCallResponse, CardCreate, CardCreated, MissedWord } from '../api/client';
import type { GlossLanguage } from './settings';

export interface MissedPromptTriggerInput {
  currentTimeSec: number;
  durationSec: number;
  ended: boolean;
  alreadyPrompted: boolean;
  overlayEnabled: boolean;
  episodeId: number | null;
}

/**
 * Decide whether to auto-open the post-episode "Words you missed" panel (E-7).
 * Opens once per episode when playback ends, or when reaching the final 5% / last 90 s
 * of an episode that is at least 5 minutes long (credits roll).
 */
export function shouldPromptMissedWordsPanel(input: MissedPromptTriggerInput): boolean {
  if (!input.overlayEnabled || input.episodeId === null || input.alreadyPrompted) {
    return false;
  }
  if (input.ended) {
    return true;
  }
  if (!Number.isFinite(input.durationSec) || input.durationSec < 300) {
    return false;
  }
  const remaining = input.durationSec - input.currentTimeSec;
  const ratio = input.currentTimeSec / input.durationSec;
  return remaining <= 90 || ratio >= 0.95;
}

export function pickMissedGloss(item: MissedWord, lang: GlossLanguage): string {
  if (lang === 'ger') {
    return item.gloss_de ?? item.gloss_en ?? '';
  }
  return item.gloss_en ?? item.gloss_de ?? '';
}

export function formatMissedTimestamp(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export interface BulkAddCardsResult {
  saved: number;
  existing: number;
  failed: number;
  savedWordIds: number[];
}

export async function bulkSaveMissedWords(
  selected: readonly MissedWord[],
  createCard: (payload: CardCreate) => Promise<ApiCallResponse<CardCreated>>,
): Promise<BulkAddCardsResult> {
  let saved = 0;
  let existing = 0;
  let failed = 0;
  const savedWordIds: number[] = [];

  for (const item of selected) {
    const res = await createCard({
      word_id: item.word.id,
      line_id: item.example?.line_id ?? null,
      media_ids: [],
    });
    if (res.ok && res.data) {
      savedWordIds.push(item.word.id);
      if (res.data.created) {
        saved += 1;
      } else {
        existing += 1;
      }
    } else {
      failed += 1;
    }
  }

  return { saved, existing, failed, savedWordIds };
}
