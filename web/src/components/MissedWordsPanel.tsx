import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  apiClient,
  type LineOut,
  type MissedWord,
  type WordStatus,
} from '../api/client';
import type { GlossLanguage } from '../lib/settings';
import { formatTimestampMs, updateWordStatusInTranscript } from '../lib/transcript';

interface MissedWordsPanelProps {
  episodeId: number;
  glossLang: GlossLanguage;
  onClose: () => void;
}

function pickGloss(item: MissedWord, lang: GlossLanguage): string {
  return lang === 'ger'
    ? (item.gloss_de ?? item.gloss_en ?? '')
    : (item.gloss_en ?? item.gloss_de ?? '');
}

export function MissedWordsPanel({ episodeId, glossLang, onClose }: MissedWordsPanelProps) {
  const queryClient = useQueryClient();
  const [includeLearning, setIncludeLearning] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const [notice, setNotice] = useState<string | null>(null);

  const missedQuery = useQuery({
    queryKey: ['missed-words', episodeId, includeLearning],
    queryFn: () => apiClient.getEpisodeMissedWords(episodeId, 30, includeLearning),
    retry: false,
  });

  const items = missedQuery.data ?? [];

  function invalidateAll(): void {
    void queryClient.invalidateQueries({ queryKey: ['missed-words', episodeId] });
    void queryClient.invalidateQueries({ queryKey: ['understanding', episodeId] });
    void queryClient.invalidateQueries({ queryKey: ['words'] });
    void queryClient.invalidateQueries({ queryKey: ['reviews-due'] });
  }

  const bulkStatusMutation = useMutation({
    mutationFn: ({ ids, status }: { ids: number[]; status: WordStatus }) =>
      apiClient.bulkWordStatus(ids, status),
    onSuccess: (res, vars) => {
      queryClient.setQueryData<LineOut[]>(['episode-lines', episodeId], (prev) => {
        if (!prev) return prev;
        let next = prev;
        for (const wid of vars.ids) {
          next = updateWordStatusInTranscript(next, wid, vars.status);
        }
        return next;
      });
      setSelectedIds(new Set());
      setNotice(`Marked ${res.updated} word${res.updated === 1 ? '' : 's'} as ${vars.status}.`);
      invalidateAll();
    },
  });

  const bulkSaveCardsMutation = useMutation({
    mutationFn: async (chosen: MissedWord[]) => {
      let saved = 0;
      let existing = 0;
      const savedIds: number[] = [];
      for (const item of chosen) {
        const res = await apiClient.createCard({
          word_id: item.word.id,
          line_id: item.example?.line_id ?? null,
          media_ids: [],
        });
        savedIds.push(item.word.id);
        if (res.created) saved += 1;
        else existing += 1;
      }
      return { saved, existing, savedIds };
    },
    onSuccess: ({ saved, existing, savedIds }) => {
      queryClient.setQueryData<LineOut[]>(['episode-lines', episodeId], (prev) => {
        if (!prev) return prev;
        let next = prev;
        for (const wid of savedIds) {
          next = updateWordStatusInTranscript(next, wid, 'learning');
        }
        return next;
      });
      setSelectedIds(new Set());
      setNotice(
        `Saved ${saved} new card${saved === 1 ? '' : 's'}${existing ? ` (${existing} already in review)` : ''}.`,
      );
      invalidateAll();
    },
  });

  function toggleOne(wordId: number): void {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(wordId)) next.delete(wordId);
      else next.add(wordId);
      return next;
    });
  }

  const busy = bulkStatusMutation.isPending || bulkSaveCardsMutation.isPending;
  const selectedItems = items.filter((i) => selectedIds.has(i.word.id));

  return (
    <section className="bg-paper border border-gold/60 rounded-2xl p-5 space-y-4 shadow-lg">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-gold-ink">
            Post-Watch: Words You Missed (Most Useful First)
          </h2>
          <p className="text-xs text-muted mt-0.5">
            Ranked by general Japanese frequency (Zipf) plus how often they appear in this episode
            and anime.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-ink-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={includeLearning}
              onChange={(e) => {
                setIncludeLearning(e.target.checked);
                setSelectedIds(new Set());
              }}
              className="rounded border-line-2 bg-field text-gold-ink"
            />
            Include learning
          </label>
          <button
            type="button"
            onClick={onClose}
            className="btn text-xs px-2.5 py-1 text-ink-2 cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>

      {notice && (
        <div className="text-xs px-3 py-2 rounded-lg bg-leaf/30 border border-leaf/50 text-leaf-ink">
          {notice}
        </div>
      )}

      {missedQuery.isLoading ? (
        <div className="text-sm text-muted py-4">Ranking missed words…</div>
      ) : missedQuery.isError ? (
        <div className="text-sm text-rose-ink py-2">
          Could not load missed words: {(missedQuery.error as Error)?.message ?? 'Error'}
        </div>
      ) : items.length === 0 ? (
        <div className="text-sm text-leaf-ink py-3">
          No remaining unknown words in this episode — great job!
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setSelectedIds(new Set(items.slice(0, 5).map((i) => i.word.id)))}
                className="btn px-2.5 py-1 text-ink-2 cursor-pointer"
              >
                Select Top 5
              </button>
              <button
                type="button"
                onClick={() => setSelectedIds(new Set(items.map((i) => i.word.id)))}
                className="btn px-2.5 py-1 text-ink-2 cursor-pointer"
              >
                Select All ({items.length})
              </button>
              <button
                type="button"
                onClick={() => setSelectedIds(new Set())}
                className="btn px-2.5 py-1 text-muted cursor-pointer"
              >
                Clear
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={selectedItems.length === 0 || busy}
                onClick={() => bulkSaveCardsMutation.mutate(selectedItems)}
                className="btn btn-sun px-3 py-1.5 disabled:opacity-40 font-bold cursor-pointer"
              >
                Save Cards ({selectedItems.length})
              </button>
              <button
                type="button"
                disabled={selectedItems.length === 0 || busy}
                onClick={() =>
                  bulkStatusMutation.mutate({
                    ids: selectedItems.map((i) => i.word.id),
                    status: 'known',
                  })
                }
                className="btn btn-leaf px-3 py-1.5 disabled:opacity-40 font-semibold cursor-pointer"
              >
                Mark Known ({selectedItems.length})
              </button>
              <button
                type="button"
                disabled={selectedItems.length === 0 || busy}
                onClick={() =>
                  bulkStatusMutation.mutate({
                    ids: selectedItems.map((i) => i.word.id),
                    status: 'ignored',
                  })
                }
                className="btn px-3 py-1.5 disabled:opacity-40 text-ink-2 font-semibold cursor-pointer"
              >
                Ignore ({selectedItems.length})
              </button>
            </div>
          </div>

          <div className="divide-y divide-line border border-line rounded-xl overflow-hidden bg-field max-h-[420px] overflow-y-auto">
            {items.map((item) => {
              const checked = selectedIds.has(item.word.id);
              const gloss = pickGloss(item, glossLang);
              return (
                <label
                  key={item.word.id}
                  className={`flex items-start gap-3 px-4 py-3 cursor-pointer transition-colors ${
                    checked ? 'bg-sun/20' : 'hover:bg-paper'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleOne(item.word.id)}
                    className="mt-1 rounded border-line-2 bg-field text-torii-ink"
                  />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="text-base font-bold text-ink">
                          {item.word.lemma}
                        </span>
                        {item.word.reading && item.word.reading !== item.word.lemma && (
                          <span className="text-xs text-torii-ink">{item.word.reading}</span>
                        )}
                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-paper border border-line text-muted">
                          {item.word.pos}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-muted">
                        {item.word.zipf !== null && item.word.zipf !== undefined && (
                          <span className="px-1.5 py-0.5 rounded bg-plum/30 text-plum-ink border border-plum/50">
                            Zipf {item.word.zipf.toFixed(1)}
                          </span>
                        )}
                        <span>×{item.word.occurrences ?? 1} ep</span>
                        <span>×{item.anime_occurrences} anime</span>
                      </div>
                    </div>
                    {gloss && <div className="text-xs text-ink">{gloss}</div>}
                    {item.example && (
                      <div className="text-xs text-muted">
                        <span className="font-mono text-[11px] text-faint mr-1.5">
                          [{formatTimestampMs(item.example.start_ms)}]
                        </span>
                        {item.example.text}
                      </div>
                    )}
                  </div>
                </label>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
