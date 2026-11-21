import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  apiClient,
  type LineOut,
  type Understanding,
  type WordListItem,
  type WordStatus,
} from '../api/client';
import {
  estimateCoverageGainPct,
  findFirstLineForWord,
  PRIMING_WORD_LIMIT,
} from '../lib/priming';
import type { GlossLanguage } from '../lib/settings';
import { pickEntrySenses, updateWordStatusInTranscript } from '../lib/transcript';

interface PreWatchPrimerProps {
  episodeId: number;
  lines: readonly LineOut[];
  understanding: Understanding | undefined;
  glossLang: GlossLanguage;
  onClose: () => void;
}

export function PreWatchPrimer({
  episodeId,
  lines,
  understanding,
  glossLang,
  onClose,
}: PreWatchPrimerProps) {
  const queryClient = useQueryClient();
  const [baselinePct] = useState<number | null>(() =>
    understanding ? understanding.token_pct : null,
  );
  const [cursor, setCursor] = useState(0);
  const [decided, setDecided] = useState<
    Record<number, 'known' | 'ignored' | 'saved' | 'skipped'>
  >({});

  const primingQuery = useQuery({
    queryKey: ['priming-words', episodeId],
    queryFn: () =>
      apiClient.listWords({
        episodeId,
        status: 'new',
        limit: PRIMING_WORD_LIMIT,
        offset: 0,
      }),
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const words: WordListItem[] = primingQuery.data?.items ?? [];
  const currentWord: WordListItem | null = words[cursor] ?? null;

  const lookupQuery = useQuery({
    queryKey: ['dict-lookup', currentWord?.id, currentWord?.lemma, currentWord?.reading],
    queryFn: () =>
      apiClient.lookupDictionary(currentWord!.lemma, currentWord!.reading, 3, currentWord!.id),
    enabled: currentWord !== null,
    retry: false,
  });

  function advanceCursor(nextDecidedCount: number) {
    if (cursor + 1 < words.length) {
      setCursor((c) => c + 1);
    } else if (nextDecidedCount < words.length) {
      const nextUndecided = words.findIndex((w, i) => i !== cursor && !decided[w.id]);
      if (nextUndecided >= 0) {
        setCursor(nextUndecided);
      }
    }
  }

  const statusMutation = useMutation({
    mutationFn: ({ wordId, status }: { wordId: number; status: WordStatus }) =>
      apiClient.setWordStatus(wordId, status),
    onSuccess: (updated) => {
      queryClient.setQueryData<LineOut[]>(['episode-lines', episodeId], (prev) =>
        prev ? updateWordStatusInTranscript(prev, updated.id, updated.status) : prev,
      );
      void queryClient.invalidateQueries({ queryKey: ['understanding', episodeId] });
      void queryClient.invalidateQueries({ queryKey: ['words'] });

      const tag = updated.status === 'known' ? 'known' : 'ignored';
      const nextDecided = { ...decided, [updated.id]: tag as 'known' | 'ignored' };
      setDecided(nextDecided);
      advanceCursor(Object.keys(nextDecided).length);
    },
  });

  const saveCardMutation = useMutation({
    mutationFn: ({ wordId, lineId }: { wordId: number; lineId: number | null }) =>
      apiClient.createCard({ word_id: wordId, line_id: lineId, media_ids: [] }),
    onSuccess: (created) => {
      queryClient.setQueryData<LineOut[]>(['episode-lines', episodeId], (prev) =>
        prev ? updateWordStatusInTranscript(prev, created.word_id, 'learning') : prev,
      );
      void queryClient.invalidateQueries({ queryKey: ['understanding', episodeId] });
      void queryClient.invalidateQueries({ queryKey: ['words'] });
      void queryClient.invalidateQueries({ queryKey: ['reviews-due'] });

      const nextDecided = { ...decided, [created.word_id]: 'saved' as const };
      setDecided(nextDecided);
      advanceCursor(Object.keys(nextDecided).length);
    },
  });

  const decidedCount = Object.keys(decided).length;
  const allDone = words.length > 0 && decidedCount >= words.length;
  const potentialGainPct = estimateCoverageGainPct(understanding, words);
  const currentPct = understanding?.token_pct ?? baselinePct ?? 0;
  const deltaPct =
    baselinePct !== null ? Math.max(0, Number((currentPct - baselinePct).toFixed(1))) : 0;

  const exampleLine = currentWord ? findFirstLineForWord(lines, currentWord.id) : null;
  const topEntry = lookupQuery.data?.entries[0] ?? null;
  const pickedSenses = topEntry ? pickEntrySenses(topEntry, glossLang) : null;

  return (
    <section className="bg-slate-900 border border-sky-500/40 rounded-2xl p-5 space-y-4 shadow-lg">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold text-sky-300">
              Pre-Watch Primer — Top {PRIMING_WORD_LIMIT} Unknown Words
            </h2>
            {potentialGainPct > 0 && (
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-semibold">
                +{potentialGainPct}% episode coverage
              </span>
            )}
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            2-minute warm-up of the most frequent new words before pressing play.
            {deltaPct > 0 && (
              <span className="ml-2 text-emerald-400 font-semibold">
                Understood jumped +{deltaPct.toFixed(1)}% so far!
              </span>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-xs px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 cursor-pointer"
        >
          Close Primer
        </button>
      </div>

      {primingQuery.isLoading ? (
        <div className="text-sm text-slate-400 py-4">Loading top unknown words...</div>
      ) : primingQuery.isError ? (
        <div className="text-sm text-rose-400 py-2">
          Could not load priming words:{' '}
          {(primingQuery.error as Error)?.message ?? 'Unknown error'}
        </div>
      ) : words.length === 0 ? (
        <div className="text-sm text-emerald-300 py-3">
          You have no remaining &ldquo;new&rdquo; words in this episode — ready to watch!
        </div>
      ) : allDone ? (
        <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-5 text-center space-y-2">
          <div className="text-lg font-bold text-emerald-300">
            Primer complete! ({words.length}/{words.length} words reviewed)
          </div>
          <p className="text-xs text-slate-300">
            Episode understanding is now{' '}
            <strong className="text-emerald-300">{currentPct.toFixed(1)}%</strong>
            {deltaPct > 0 ? ` (+${deltaPct.toFixed(1)}% from priming)` : ''}. Enjoy the episode!
          </p>
          <div className="pt-1 flex justify-center gap-2">
            <button
              type="button"
              onClick={() => {
                setDecided({});
                setCursor(0);
                void primingQuery.refetch();
              }}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-sky-300 border border-slate-700 cursor-pointer"
            >
              Load Next 10 Unknown Words
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg bg-sky-400 hover:bg-sky-300 text-slate-950 text-xs font-semibold cursor-pointer"
            >
              Done
            </button>
          </div>
        </div>
      ) : currentWord ? (
        <div className="space-y-4">
          {/* Word progress pills */}
          <div className="flex flex-wrap gap-1.5">
            {words.map((w, idx) => {
              const state = decided[w.id];
              const isCurrent = idx === cursor;
              let pillClass = 'bg-slate-950 border-slate-800 text-slate-400';
              if (isCurrent) {
                pillClass = 'bg-sky-500/20 border-sky-400 text-sky-200 font-semibold';
              } else if (state === 'known') {
                pillClass = 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300';
              } else if (state === 'saved') {
                pillClass = 'bg-amber-500/15 border-amber-500/40 text-amber-300';
              } else if (state === 'ignored' || state === 'skipped') {
                pillClass = 'bg-slate-900 border-slate-800 text-slate-500 line-through';
              }
              return (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => setCursor(idx)}
                  className={`px-2 py-0.5 rounded-md border text-xs cursor-pointer transition ${pillClass}`}
                >
                  {idx + 1}. {w.lemma}
                </button>
              );
            })}
          </div>

          {/* Active priming card */}
          <div className="bg-slate-950 border border-slate-800 rounded-xl p-5 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-baseline gap-2.5 flex-wrap">
                  <span className="text-3xl font-bold text-slate-100">{currentWord.lemma}</span>
                  {currentWord.reading && currentWord.reading !== currentWord.lemma && (
                    <span className="text-base text-sky-400">{currentWord.reading}</span>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-1.5 text-xs">
                  <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                    {currentWord.pos}
                  </span>
                  {currentWord.common && (
                    <span className="px-2 py-0.5 rounded bg-sky-500/15 text-sky-300">Common</span>
                  )}
                  {currentWord.occurrences !== null && currentWord.occurrences !== undefined && (
                    <span className="px-2 py-0.5 rounded bg-amber-500/15 text-amber-300 font-semibold">
                      Spoken {currentWord.occurrences}× in episode
                    </span>
                  )}
                </div>
              </div>
              <span className="text-xs text-slate-500 font-mono">
                {cursor + 1} / {words.length}
              </span>
            </div>

            {/* Meanings from JMdict */}
            <div className="space-y-1">
              {lookupQuery.isLoading ? (
                <div className="text-xs text-slate-400">Looking up meaning...</div>
              ) : pickedSenses && pickedSenses.senses.length > 0 ? (
                <ol className="list-decimal list-inside text-sm text-slate-200 space-y-0.5">
                  {pickedSenses.senses.slice(0, 4).map((s, i) => (
                    <li key={i}>{s.glosses.join('; ')}</li>
                  ))}
                </ol>
              ) : (
                <div className="text-xs text-slate-500">No JMdict entry found.</div>
              )}
            </div>

            {/* Example line from episode */}
            {exampleLine && (
              <div className="bg-slate-900/80 border border-slate-800 rounded-lg px-3.5 py-2.5 space-y-0.5">
                <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
                  Example in this episode
                </div>
                <div className="text-sm text-slate-200">{exampleLine.text}</div>
                {exampleLine.romaji && (
                  <div className="text-xs text-slate-400 font-mono">{exampleLine.romaji}</div>
                )}
              </div>
            )}

            {/* Quick actions */}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                disabled={statusMutation.isPending || saveCardMutation.isPending}
                onClick={() =>
                  statusMutation.mutate({ wordId: currentWord.id, status: 'known' })
                }
                className="flex-1 min-w-[95px] py-2 px-3 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-400/50 text-emerald-200 text-xs font-semibold cursor-pointer"
              >
                Known
              </button>
              <button
                type="button"
                disabled={statusMutation.isPending || saveCardMutation.isPending}
                onClick={() =>
                  saveCardMutation.mutate({
                    wordId: currentWord.id,
                    lineId: exampleLine?.id ?? null,
                  })
                }
                className="flex-1 min-w-[95px] py-2 px-3 rounded-lg bg-sky-400 hover:bg-sky-300 text-slate-950 text-xs font-bold cursor-pointer"
              >
                Save Card
              </button>
              <button
                type="button"
                disabled={statusMutation.isPending || saveCardMutation.isPending}
                onClick={() =>
                  statusMutation.mutate({ wordId: currentWord.id, status: 'ignored' })
                }
                className="py-2 px-3 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-xs font-semibold cursor-pointer"
              >
                Ignore
              </button>
              <button
                type="button"
                onClick={() => {
                  const next = { ...decided, [currentWord.id]: 'skipped' as const };
                  setDecided(next);
                  advanceCursor(Object.keys(next).length);
                }}
                className="py-2 px-3 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-400 text-xs font-semibold cursor-pointer"
              >
                Skip
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
