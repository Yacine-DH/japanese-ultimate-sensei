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
    <section className="bg-slate-900 border border-amber-500/40 rounded-2xl p-5 space-y-4 shadow-lg">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-amber-300">
            Post-Watch: Words You Missed (Most Useful First)
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Ranked by general Japanese frequency (Zipf) plus how often they appear in this episode
            and anime.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={includeLearning}
              onChange={(e) => {
                setIncludeLearning(e.target.checked);
                setSelectedIds(new Set());
              }}
              className="rounded border-slate-600 bg-slate-950 text-amber-400"
            />
            Include learning
          </label>
          <button
            type="button"
            onClick={onClose}
            className="text-xs px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>

      {notice && (
        <div className="text-xs px-3 py-2 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300">
          {notice}
        </div>
      )}

      {missedQuery.isLoading ? (
        <div className="text-sm text-slate-400 py-4">Ranking missed words…</div>
      ) : missedQuery.isError ? (
        <div className="text-sm text-rose-400 py-2">
          Could not load missed words: {(missedQuery.error as Error)?.message ?? 'Error'}
        </div>
      ) : items.length === 0 ? (
        <div className="text-sm text-emerald-300 py-3">
          No remaining unknown words in this episode — great job!
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setSelectedIds(new Set(items.slice(0, 5).map((i) => i.word.id)))}
                className="px-2.5 py-1 rounded-lg bg-slate-950 border border-slate-700 text-slate-300 hover:bg-slate-800 cursor-pointer"
              >
                Select Top 5
              </button>
              <button
                type="button"
                onClick={() => setSelectedIds(new Set(items.map((i) => i.word.id)))}
                className="px-2.5 py-1 rounded-lg bg-slate-950 border border-slate-700 text-slate-300 hover:bg-slate-800 cursor-pointer"
              >
                Select All ({items.length})
              </button>
              <button
                type="button"
                onClick={() => setSelectedIds(new Set())}
                className="px-2.5 py-1 rounded-lg bg-slate-950 border border-slate-700 text-slate-400 hover:bg-slate-800 cursor-pointer"
              >
                Clear
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={selectedItems.length === 0 || busy}
                onClick={() => bulkSaveCardsMutation.mutate(selectedItems)}
                className="px-3 py-1.5 rounded-lg bg-sky-400 hover:bg-sky-300 disabled:opacity-40 text-slate-950 font-bold cursor-pointer"
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
                className="px-3 py-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 disabled:opacity-40 border border-emerald-500/40 text-emerald-200 font-semibold cursor-pointer"
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
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 border border-slate-700 text-slate-300 font-semibold cursor-pointer"
              >
                Ignore ({selectedItems.length})
              </button>
            </div>
          </div>

          <div className="divide-y divide-slate-800/80 border border-slate-800 rounded-xl overflow-hidden bg-slate-950/50 max-h-[420px] overflow-y-auto">
            {items.map((item) => {
              const checked = selectedIds.has(item.word.id);
              const gloss = pickGloss(item, glossLang);
              return (
                <label
                  key={item.word.id}
                  className={`flex items-start gap-3 px-4 py-3 cursor-pointer transition-colors ${
                    checked ? 'bg-sky-500/10' : 'hover:bg-slate-900/60'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleOne(item.word.id)}
                    className="mt-1 rounded border-slate-600 bg-slate-950 text-sky-400"
                  />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="text-base font-bold text-slate-100">
                          {item.word.lemma}
                        </span>
                        {item.word.reading && item.word.reading !== item.word.lemma && (
                          <span className="text-xs text-sky-300">{item.word.reading}</span>
                        )}
                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-slate-900 border border-slate-800 text-slate-400">
                          {item.word.pos}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-slate-400">
                        {item.word.zipf !== null && item.word.zipf !== undefined && (
                          <span className="px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300 border border-indigo-500/30">
                            Zipf {item.word.zipf.toFixed(1)}
                          </span>
                        )}
                        <span>×{item.word.occurrences ?? 1} ep</span>
                        <span>×{item.anime_occurrences} anime</span>
                      </div>
                    </div>
                    {gloss && <div className="text-xs text-slate-200">{gloss}</div>}
                    {item.example && (
                      <div className="text-xs text-slate-400">
                        <span className="font-mono text-[11px] text-slate-500 mr-1.5">
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
