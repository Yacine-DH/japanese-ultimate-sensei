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
    <div className="bg-paper border border-line rounded-lg px-3.5 py-2.5 space-y-1">
      <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-wider text-faint font-semibold">
        <span>Example in this episode</span>
        {startMs !== null && (
          <span className="font-mono text-faint">{formatTimestampMs(startMs)}</span>
        )}
      </div>
      {line ? (
        <div className="text-sm sm:text-base leading-loose text-ink break-words">
          {line.tokens.map((tok: TokenOut, idx: number) => {
            const isTarget =
              tok.word_id === item.word.id ||
              (tok.lemma === item.word.lemma && tok.lemma_reading === item.word.reading);
            return (
              <span
                key={idx}
                className={
                  isTarget
                    ? 'px-0.5 rounded bg-sun/50 text-torii-ink border-b border-torii font-semibold'
                    : undefined
                }
              >
                {tok.furigana.map((seg, sIdx) =>
                  seg.ruby ? (
                    <ruby key={sIdx}>
                      {seg.text}
                      <rt className="text-[10px] text-muted font-normal">{seg.ruby}</rt>
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
        <div className="text-sm text-ink break-words">{item.example?.text}</div>
      )}
      {translation && (
        <div className="text-xs text-muted">
          <span className="inline-block mr-1 px-1 py-0.5 rounded bg-chip text-[10px] font-semibold text-muted">
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
    <section className="bg-paper border border-torii/60 rounded-2xl p-4 sm:p-5 space-y-4 shadow-lg">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-bold text-torii-ink">
              Prep this episode — {PRIMING_WORD_LIMIT} most useful words
            </h2>
            {potentialGainPct > 0 && (
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-leaf/30 text-leaf-ink border border-leaf/50 font-semibold">
                +{potentialGainPct}% episode coverage
              </span>
            )}
            {items.length > 0 && (
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-chip text-ink-2 font-mono">
                {decidedCount}/{items.length} prepped
              </span>
            )}
          </div>
          <p className="text-xs text-muted mt-0.5">
            Warm up on the highest-value unknown words (frequency + episode &amp; anime repeats)
            before pressing play.
            {deltaPct > 0 && (
              <span className="ml-2 text-leaf-ink font-semibold">
                Understood jumped +{deltaPct.toFixed(1)}% so far!
              </span>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="btn text-xs px-2.5 py-1 text-ink-2 cursor-pointer"
        >
          Close Prep
        </button>
      </div>

      {actionError && (
        <div className="text-xs px-3 py-2 rounded-lg bg-rose/20 border border-rose/50 text-rose-ink">
          {actionError}
        </div>
      )}

      {prepQuery.isLoading ? (
        <div className="text-sm text-muted py-4">Ranking the 10 most useful words…</div>
      ) : prepQuery.isError ? (
        <div className="text-sm text-rose-ink py-2">
          Could not load prep words: {(prepQuery.error as Error)?.message ?? 'Unknown error'}
        </div>
      ) : items.length === 0 ? (
        <div className="text-sm text-leaf-ink py-3">
          No unknown words left in this episode — you&apos;re ready to watch!
        </div>
      ) : (
        <div className="space-y-3">
          {allDone && (
            <div className="bg-leaf/20 border border-leaf/50 rounded-xl p-4 text-center space-y-2">
              <div className="text-base font-bold text-leaf-ink">
                Prep complete! ({items.length}/{items.length} words)
              </div>
              <p className="text-xs text-ink-2">
                Episode understanding is now{' '}
                <strong className="text-leaf-ink">{currentPct.toFixed(1)}%</strong>
                {deltaPct > 0 ? ` (+${deltaPct.toFixed(1)}% from prep)` : ''}. Enjoy the episode!
              </p>
              <div className="pt-1 flex flex-wrap justify-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setDecided({});
                    void prepQuery.refetch();
                  }}
                  className="btn px-3 py-1.5 text-xs font-semibold text-torii-ink cursor-pointer"
                >
                  Load next 10 words
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="btn btn-sun px-3 py-1.5 text-xs font-semibold cursor-pointer"
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
                      ? 'bg-leaf/25 border-leaf/50'
                      : decision === 'learning'
                        ? 'bg-sun/25 border-torii/50'
                        : 'bg-field border-line'
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="text-xs font-mono text-faint">#{idx + 1}</span>
                        <span className="text-2xl font-bold text-ink">{item.word.lemma}</span>
                        {item.word.reading && item.word.reading !== item.word.lemma && (
                          <span className="text-sm text-torii-ink font-medium">
                            {item.word.reading}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                        <span className="px-1.5 py-0.5 rounded bg-chip text-ink-2">
                          {item.word.pos}
                        </span>
                        {item.word.zipf !== null && item.word.zipf !== undefined && (
                          <span className="px-1.5 py-0.5 rounded bg-plum/30 text-plum-ink border border-plum/50">
                            Zipf {item.word.zipf.toFixed(1)}
                          </span>
                        )}
                        <span className="px-1.5 py-0.5 rounded bg-gold/30 text-gold-ink font-semibold">
                          ×{item.word.occurrences ?? 1} ep
                        </span>
                        {item.anime_occurrences > (item.word.occurrences ?? 1) && (
                          <span className="px-1.5 py-0.5 rounded bg-paper border border-line text-muted">
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
                          className="btn px-2.5 py-1.5 text-torii-ink text-xs font-semibold cursor-pointer"
                        >
                          {playingWordId === item.word.id ? '■ Stop audio' : '▶ Play audio'}
                        </button>
                      )}
                      {decision === 'learning' ? (
                        <span className="px-2.5 py-1.5 rounded-lg bg-sun/30 border border-torii/60 text-torii-ink text-xs font-semibold">
                          Added to Learn ✓
                        </span>
                      ) : decision === 'known' ? (
                        <span className="px-2.5 py-1.5 rounded-lg bg-leaf/30 border border-leaf/60 text-leaf-ink text-xs font-semibold">
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
                            className="btn btn-sun px-3 py-1.5 disabled:opacity-50 text-xs font-bold cursor-pointer"
                          >
                            Learn
                          </button>
                          <button
                            type="button"
                            disabled={isBusyThis}
                            onClick={() =>
                              statusMutation.mutate({ wordId: item.word.id, status: 'known' })
                            }
                            className="btn btn-leaf px-3 py-1.5 disabled:opacity-50 text-xs font-semibold cursor-pointer"
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
                      <div className="text-sm text-ink">
                        <span className="inline-block mr-1.5 px-1.5 py-0.5 rounded bg-chip text-[10px] font-semibold text-muted align-middle">
                          {glosses.primary.lang}
                        </span>
                        <span>{glosses.primary.text}</span>
                      </div>
                      {glosses.secondary && (
                        <div className="text-xs text-muted">
                          <span className="inline-block mr-1.5 px-1.5 py-0.5 rounded bg-chip text-[10px] font-semibold text-faint align-middle">
                            {glosses.secondary.lang}
                          </span>
                          <span>{glosses.secondary.text}</span>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-xs text-faint">No dictionary gloss available.</div>
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
