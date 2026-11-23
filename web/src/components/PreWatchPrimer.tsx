import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  apiClient,
  type LineOut,
  type MissedWord,
  type ReviewCard,
  type TokenOut,
  type Understanding,
  type WordStatus,
} from '../api/client';
import {
  estimateCoverageGainPct,
  formatPrepGlosses,
  indexAudioUrlsByLineAndWord,
  PRIMING_WORD_LIMIT,
  resolveExampleLine,
  resolvePrepAudioUrl,
} from '../lib/priming';
import { formatReviewSentenceTranslation } from '../lib/review';
import { type GlossLanguage, loadWebSettings } from '../lib/settings';
import { formatTimestampMs, updateWordStatusInTranscript } from '../lib/transcript';

interface PreWatchPrimerProps {
  episodeId: number;
  lines: readonly LineOut[];
  understanding: Understanding | undefined;
  glossLang: GlossLanguage;
  onClose: () => void;
}

function PrepExampleSentence({
  item,
  line,
  glossLang,
}: {
  item: MissedWord;
  line: LineOut | null;
  glossLang: GlossLanguage;
}) {
  if (!line && !item.example) {
    return null;
  }

  const startMs = line?.start_ms ?? item.example?.start_ms ?? null;
  const translation = line ? formatReviewSentenceTranslation(line, glossLang) : null;

  return (
    <div className="bg-slate-900/80 border border-slate-800 rounded-lg px-3.5 py-2.5 space-y-1">
      <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
        <span>Example in this episode</span>
        {startMs !== null && (
          <span className="font-mono text-slate-500">{formatTimestampMs(startMs)}</span>
        )}
      </div>
      {line ? (
        <div className="text-sm sm:text-base leading-loose text-slate-200 break-words">
          {line.tokens.map((tok: TokenOut, idx: number) => {
            const isTarget =
              tok.word_id === item.word.id ||
              (tok.lemma === item.word.lemma && tok.lemma_reading === item.word.reading);
            return (
              <span
                key={idx}
                className={
                  isTarget
                    ? 'px-0.5 rounded bg-sky-500/25 text-sky-200 border-b border-sky-400 font-semibold'
                    : undefined
                }
              >
                {tok.furigana.map((seg, sIdx) =>
                  seg.ruby ? (
                    <ruby key={sIdx}>
                      {seg.text}
                      <rt className="text-[10px] text-slate-400 font-normal">{seg.ruby}</rt>
                    </ruby>
                  ) : (
                    <span key={sIdx}>{seg.text}</span>
                  ),
                )}
              </span>
            );
          })}
        </div>
      ) : (
        <div className="text-sm text-slate-200 break-words">{item.example?.text}</div>
      )}
      {translation && (
        <div className="text-xs text-slate-400">
          <span className="inline-block mr-1 px-1 py-0.5 rounded bg-slate-800 text-[10px] font-semibold text-slate-400">
            {translation.primary.lang}
          </span>
          {translation.primary.text}
        </div>
      )}
    </div>
  );
}

export function PreWatchPrimer({
  episodeId,
  lines,
  understanding,
  glossLang,
  onClose,
}: PreWatchPrimerProps) {
  const queryClient = useQueryClient();
  const settings = loadWebSettings();
  const [baselinePct] = useState<number | null>(() =>
    understanding ? understanding.token_pct : null,
  );
  const [decided, setDecided] = useState<Record<number, 'known' | 'learning'>>({});
  const [extraCards, setExtraCards] = useState<ReviewCard[]>([]);
  const [playingWordId, setPlayingWordId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    return () => {
      audioElRef.current?.pause();
    };
  }, []);

  const prepQuery = useQuery({
    queryKey: ['prep-words', episodeId],
    queryFn: () => apiClient.getEpisodeMissedWords(episodeId, PRIMING_WORD_LIMIT, false),
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  // Soft lookup of existing cards so we can play the line's audio if a card with audio exists.
  const dueCardsQuery = useQuery({
    queryKey: ['prep-card-audio'],
    queryFn: () => apiClient.getDueReviews(100),
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const items: MissedWord[] = useMemo(() => prepQuery.data ?? [], [prepQuery.data]);
  const words = useMemo(() => items.map((item) => item.word), [items]);

  const audioIndex = useMemo(() => {
    const combined: ReviewCard[] = [...(dueCardsQuery.data?.cards ?? []), ...extraCards];
    return indexAudioUrlsByLineAndWord(combined, settings.serverUrl);
  }, [dueCardsQuery.data?.cards, extraCards, settings.serverUrl]);

  const statusMutation = useMutation({
    mutationFn: ({ wordId, status }: { wordId: number; status: WordStatus }) =>
      apiClient.setWordStatus(wordId, status),
    onSuccess: (updated) => {
      setActionError(null);
      queryClient.setQueryData<LineOut[]>(['episode-lines', episodeId], (prev) =>
        prev ? updateWordStatusInTranscript(prev, updated.id, updated.status) : prev,
      );
      void queryClient.invalidateQueries({ queryKey: ['understanding', episodeId] });
      void queryClient.invalidateQueries({ queryKey: ['words'] });
      void queryClient.invalidateQueries({ queryKey: ['missed-words', episodeId] });
      setDecided((prev) => ({ ...prev, [updated.id]: 'known' }));
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : 'Failed to update word status');
    },
  });

  const learnMutation = useMutation({
    mutationFn: async ({ wordId, lineId }: { wordId: number; lineId: number | null }) => {
      const created = await apiClient.createCard({
        word_id: wordId,
        line_id: lineId,
        media_ids: [],
      });
      let existingCard: ReviewCard | null = null;
      if (!created.created) {
        try {
          existingCard = await apiClient.getCard(created.id);
        } catch {
          // Non-fatal: card still exists
        }
      }
      return { created, existingCard };
    },
    onSuccess: ({ created, existingCard }) => {
      setActionError(null);
      if (existingCard) {
        setExtraCards((prev) =>
          prev.some((c) => c.card.id === existingCard.card.id) ? prev : [...prev, existingCard],
        );
      }
      queryClient.setQueryData<LineOut[]>(['episode-lines', episodeId], (prev) =>
        prev ? updateWordStatusInTranscript(prev, created.word_id, 'learning') : prev,
      );
      void queryClient.invalidateQueries({ queryKey: ['understanding', episodeId] });
      void queryClient.invalidateQueries({ queryKey: ['words'] });
      void queryClient.invalidateQueries({ queryKey: ['reviews-due'] });
      void queryClient.invalidateQueries({ queryKey: ['missed-words', episodeId] });
      setDecided((prev) => ({ ...prev, [created.word_id]: 'learning' }));
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : 'Failed to add card');
    },
  });

  function playLineAudio(wordId: number, url: string) {
    if (audioElRef.current) {
      audioElRef.current.pause();
    }
    if (playingWordId === wordId) {
      setPlayingWordId(null);
      return;
    }
    const audio = new Audio(url);
    audioElRef.current = audio;
    setPlayingWordId(wordId);
    audio.onended = () => setPlayingWordId((cur) => (cur === wordId ? null : cur));
    audio.onerror = () => setPlayingWordId((cur) => (cur === wordId ? null : cur));
    void audio.play().catch(() => {
      setPlayingWordId((cur) => (cur === wordId ? null : cur));
    });
  }

  const decidedCount = items.filter((item) => Boolean(decided[item.word.id])).length;
  const allDone = items.length > 0 && decidedCount >= items.length;
  const potentialGainPct = estimateCoverageGainPct(understanding, words);
  const currentPct = understanding?.token_pct ?? baselinePct ?? 0;
  const deltaPct =
    baselinePct !== null ? Math.max(0, Number((currentPct - baselinePct).toFixed(1))) : 0;

  return (
    <section className="bg-slate-900 border border-sky-500/40 rounded-2xl p-4 sm:p-5 space-y-4 shadow-lg">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-bold text-sky-300">
              Prep this episode — {PRIMING_WORD_LIMIT} most useful words
            </h2>
            {potentialGainPct > 0 && (
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-semibold">
                +{potentialGainPct}% episode coverage
              </span>
            )}
            {items.length > 0 && (
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 font-mono">
                {decidedCount}/{items.length} prepped
              </span>
            )}
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Warm up on the highest-value unknown words (frequency + episode &amp; anime repeats)
            before pressing play.
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
          Close Prep
        </button>
      </div>

      {actionError && (
        <div className="text-xs px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300">
          {actionError}
        </div>
      )}

      {prepQuery.isLoading ? (
        <div className="text-sm text-slate-400 py-4">Ranking the 10 most useful words…</div>
      ) : prepQuery.isError ? (
        <div className="text-sm text-rose-400 py-2">
          Could not load prep words: {(prepQuery.error as Error)?.message ?? 'Unknown error'}
        </div>
      ) : items.length === 0 ? (
        <div className="text-sm text-emerald-300 py-3">
          No unknown words left in this episode — you&apos;re ready to watch!
        </div>
      ) : (
        <div className="space-y-3">
          {allDone && (
            <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-4 text-center space-y-2">
              <div className="text-base font-bold text-emerald-300">
                Prep complete! ({items.length}/{items.length} words)
              </div>
              <p className="text-xs text-slate-300">
                Episode understanding is now{' '}
                <strong className="text-emerald-300">{currentPct.toFixed(1)}%</strong>
                {deltaPct > 0 ? ` (+${deltaPct.toFixed(1)}% from prep)` : ''}. Enjoy the episode!
              </p>
              <div className="pt-1 flex flex-wrap justify-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setDecided({});
                    void prepQuery.refetch();
                  }}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-sky-300 border border-slate-700 cursor-pointer"
                >
                  Load next 10 words
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
          )}

          <div className="space-y-3">
            {items.map((item, idx) => {
              const decision = decided[item.word.id];
              const glosses = formatPrepGlosses(item, glossLang);
              const exampleLine = resolveExampleLine(item, lines);
              const audioUrl = resolvePrepAudioUrl(item, audioIndex);
              const isBusyThis =
                (statusMutation.isPending && statusMutation.variables?.wordId === item.word.id) ||
                (learnMutation.isPending && learnMutation.variables?.wordId === item.word.id);

              return (
                <article
                  key={item.word.id}
                  className={`rounded-xl border p-4 space-y-3 transition ${
                    decision === 'known'
                      ? 'bg-emerald-950/20 border-emerald-500/30'
                      : decision === 'learning'
                        ? 'bg-sky-950/20 border-sky-500/30'
                        : 'bg-slate-950 border-slate-800'
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="text-xs font-mono text-slate-500">#{idx + 1}</span>
                        <span className="text-2xl font-bold text-slate-100">{item.word.lemma}</span>
                        {item.word.reading && item.word.reading !== item.word.lemma && (
                          <span className="text-sm text-sky-400 font-medium">
                            {item.word.reading}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                        <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                          {item.word.pos}
                        </span>
                        {item.word.zipf !== null && item.word.zipf !== undefined && (
                          <span className="px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300 border border-indigo-500/30">
                            Zipf {item.word.zipf.toFixed(1)}
                          </span>
                        )}
                        <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 font-semibold">
                          ×{item.word.occurrences ?? 1} ep
                        </span>
                        {item.anime_occurrences > (item.word.occurrences ?? 1) && (
                          <span className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-800 text-slate-400">
                            ×{item.anime_occurrences} anime
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {audioUrl && (
                        <button
                          type="button"
                          onClick={() => playLineAudio(item.word.id, audioUrl)}
                          className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-sky-300 border border-slate-700 text-xs font-semibold cursor-pointer"
                        >
                          {playingWordId === item.word.id ? '■ Stop audio' : '▶ Play audio'}
                        </button>
                      )}
                      {decision === 'learning' ? (
                        <span className="px-2.5 py-1.5 rounded-lg bg-sky-500/15 border border-sky-400/40 text-sky-300 text-xs font-semibold">
                          Added to Learn ✓
                        </span>
                      ) : decision === 'known' ? (
                        <span className="px-2.5 py-1.5 rounded-lg bg-emerald-500/15 border border-emerald-400/40 text-emerald-300 text-xs font-semibold">
                          Known ✓
                        </span>
                      ) : (
                        <>
                          <button
                            type="button"
                            disabled={isBusyThis}
                            onClick={() =>
                              learnMutation.mutate({
                                wordId: item.word.id,
                                lineId: exampleLine?.id ?? item.example?.line_id ?? null,
                              })
                            }
                            className="px-3 py-1.5 rounded-lg bg-sky-400 hover:bg-sky-300 disabled:opacity-50 text-slate-950 text-xs font-bold cursor-pointer"
                          >
                            Learn
                          </button>
                          <button
                            type="button"
                            disabled={isBusyThis}
                            onClick={() =>
                              statusMutation.mutate({ wordId: item.word.id, status: 'known' })
                            }
                            className="px-3 py-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 disabled:opacity-50 border border-emerald-400/50 text-emerald-200 text-xs font-semibold cursor-pointer"
                          >
                            I know it
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Meanings (EN / DE) */}
                  {glosses ? (
                    <div className="space-y-0.5">
                      <div className="text-sm text-slate-100">
                        <span className="inline-block mr-1.5 px-1.5 py-0.5 rounded bg-slate-800 text-[10px] font-semibold text-slate-400 align-middle">
                          {glosses.primary.lang}
                        </span>
                        <span>{glosses.primary.text}</span>
                      </div>
                      {glosses.secondary && (
                        <div className="text-xs text-slate-400">
                          <span className="inline-block mr-1.5 px-1.5 py-0.5 rounded bg-slate-800/70 text-[10px] font-semibold text-slate-500 align-middle">
                            {glosses.secondary.lang}
                          </span>
                          <span>{glosses.secondary.text}</span>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-xs text-slate-500">No dictionary gloss available.</div>
                  )}

                  {/* Example sentence with furigana */}
                  <PrepExampleSentence item={item} line={exampleLine} glossLang={glossLang} />
                </article>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
