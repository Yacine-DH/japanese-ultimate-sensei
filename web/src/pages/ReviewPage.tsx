import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  apiClient,
  type ReviewCard,
  SenseiApiError,
  type TokenOut,
} from '../api/client';
import {
  formatIntervalFromIso,
  formatReviewSentenceTranslation,
  groupCardMedia,
  RATING_BUTTONS,
  resolveMediaUrl,
  resolveReviewHotkey,
  type ReviewRating,
} from '../lib/review';
import { type GlossLanguage, loadWebSettings } from '../lib/settings';
import { getTranscriptLineRomaji } from '../lib/transcript';
import { emitIsland } from '../scene/bus';

function isEditableElement(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable === true
  );
}

function ReviewSentence({
  card,
  showFurigana,
  showRomaji,
  showTranslation,
  glossLang,
}: {
  card: ReviewCard;
  showFurigana: boolean;
  showRomaji: boolean;
  showTranslation: boolean;
  glossLang: GlossLanguage;
}) {
  if (!card.line) {
    if (!card.card.sentence) return null;
    return (
      <div className="text-lg sm:text-xl leading-relaxed text-ink text-center">
        {card.card.sentence}
      </div>
    );
  }

  const translation = showTranslation
    ? formatReviewSentenceTranslation(card.line, glossLang)
    : null;

  return (
    <div className="space-y-2 text-center">
      <div className="text-lg sm:text-2xl leading-loose tracking-wide text-ink">
        {card.line.tokens.map((tok: TokenOut, idx: number) => {
          const isTarget =
            tok.word_id === card.word.id ||
            (tok.lemma === card.word.lemma && tok.lemma_reading === card.word.reading);
          return (
            <span
              key={idx}
              className={
                isTarget
                  ? 'px-1 rounded bg-sun/50 text-torii-ink border-b-2 border-torii font-semibold'
                  : undefined
              }
            >
              {tok.furigana.map((seg, sIdx) =>
                showFurigana && seg.ruby ? (
                  <ruby key={sIdx}>
                    {seg.text}
                    <rt className="text-[11px] text-muted font-normal">{seg.ruby}</rt>
                  </ruby>
                ) : (
                  <span key={sIdx}>{seg.text}</span>
                ),
              )}
            </span>
          );
        })}
      </div>
      {showRomaji && (
        <div className="text-xs sm:text-sm text-muted font-mono">
          {getTranscriptLineRomaji(card.line)}
        </div>
      )}
      {translation && (
        <div className="pt-1 space-y-1">
          <div className="text-sm sm:text-base text-ink">
            <span className="inline-block mr-1.5 px-1.5 py-0.5 rounded bg-chip text-[10px] font-semibold text-muted align-middle">
              {translation.primary.lang}
            </span>
            <span>{translation.primary.text}</span>
          </div>
          {translation.secondary && (
            <div className="text-xs sm:text-sm text-muted">
              <span className="inline-block mr-1.5 px-1.5 py-0.5 rounded bg-chip text-[10px] font-semibold text-faint align-middle">
                {translation.secondary.lang}
              </span>
              <span>{translation.secondary.text}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ReviewPage() {
  const queryClient = useQueryClient();
  const settings = loadWebSettings();
  const [glossLang, setGlossLang] = useState<GlossLanguage>(settings.glossLang);
  const [showRomaji, setShowRomaji] = useState(settings.romaji);
  const [revealed, setRevealed] = useState(false);
  const [queue, setQueue] = useState<ReviewCard[]>([]);
  const [initialDueTotal, setInitialDueTotal] = useState(0);
  const [reviewedCount, setReviewedCount] = useState(0);
  const [graduatedCount, setGraduatedCount] = useState(0);
  const [celebrationWord, setCelebrationWord] = useState<string | null>(null);
  const [imageErrorForCardId, setImageErrorForCardId] = useState<number | null>(null);
  const [showClip, setShowClip] = useState(false);

  const cardShownAtRef = useRef<number>(Date.now());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const dueQuery = useQuery({
    queryKey: ['reviews-due'],
    queryFn: () => apiClient.getDueReviews(20),
    retry: false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (dueQuery.data) {
      setQueue(dueQuery.data.cards);
      setInitialDueTotal(dueQuery.data.due_total);
      setRevealed(false);
      setShowClip(false);
      cardShownAtRef.current = Date.now();
    }
  }, [dueQuery.data]);

  const currentCard: ReviewCard | null = queue[0] ?? null;

  useEffect(() => {
    if (revealed) emitIsland({ type: 'reveal' });
  }, [revealed]);

  const replayMedia = useCallback(() => {
    if (showClip && videoRef.current) {
      videoRef.current.currentTime = 0;
      void videoRef.current.play().catch(() => {});
      return;
    }
    if (audioRef.current) {
      audioRef.current.currentTime = 0;
      void audioRef.current.play().catch(() => {});
    }
  }, [showClip]);

  const submitMutation = useMutation({
    mutationFn: ({ card, rating }: { card: ReviewCard; rating: ReviewRating }) => {
      const durationMs = Math.max(0, Date.now() - cardShownAtRef.current);
      return apiClient.submitReview({
        card_id: card.card.id,
        rating,
        duration_ms: durationMs,
      });
    },
    onSuccess: (res, vars) => {
      emitIsland(res.graduated ? { type: 'graduate' } : { type: 'rate', rating: vars.rating });
      void queryClient.invalidateQueries({ queryKey: ['reviews-due-count'] });
      setReviewedCount((c) => c + 1);
      if (res.graduated) {
        setGraduatedCount((c) => c + 1);
        setCelebrationWord(vars.card.word.lemma);
      } else {
        setCelebrationWord(null);
      }
      setRevealed(false);
      setShowClip(false);
      setImageErrorForCardId(null);
      cardShownAtRef.current = Date.now();
      setQueue((prev) => {
        const remaining = prev.slice(1);
        if (remaining.length === 0) {
          void queryClient.invalidateQueries({ queryKey: ['reviews-due'] });
        }
        return remaining;
      });
      void queryClient.invalidateQueries({ queryKey: ['words'] });
      void queryClient.invalidateQueries({ queryKey: ['understanding'] });
    },
  });

  const handleRate = useCallback(
    (rating: ReviewRating) => {
      if (!currentCard || !revealed || submitMutation.isPending) return;
      submitMutation.mutate({ card: currentCard, rating });
    },
    [currentCard, revealed, submitMutation],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.isComposing || isEditableElement(event.target) || !currentCard) {
        return;
      }
      const action = resolveReviewHotkey(event, revealed);
      if (!action) return;

      event.preventDefault();
      if (action.type === 'reveal') {
        setRevealed(true);
      } else if (action.type === 'rate') {
        handleRate(action.rating);
      } else if (action.type === 'replay') {
        replayMedia();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [currentCard, revealed, handleRate, replayMedia]);

  if (dueQuery.isLoading) {
    return (
      <div className="card p-8 text-center text-sm text-muted">
        Loading due FSRS review cards...
      </div>
    );
  }

  if (dueQuery.isError) {
    const is401 =
      dueQuery.error instanceof SenseiApiError && dueQuery.error.status === 401;
    return (
      <div className="card card-warn p-6 text-sm text-rose-ink">
        {is401 ? (
          <>
            API token is missing or wrong (401). Set it in{' '}
            <Link to="/settings" className="underline text-torii-ink">
              Settings
            </Link>
            .
          </>
        ) : (
          <>Could not load reviews: {(dueQuery.error as Error)?.message ?? 'Error'}</>
        )}
      </div>
    );
  }

  if (!currentCard) {
    return (
      <div className="space-y-6">
        {celebrationWord && (
          <div className="bg-leaf/30 border border-leaf/70 rounded-xl px-4 py-3 text-center text-sm text-leaf-ink font-semibold">
            🎉 Graduated! &ldquo;{celebrationWord}&rdquo; is now marked Known!
          </div>
        )}
        <div className="card p-8 text-center space-y-4">
          <div className="text-3xl">✨</div>
          <h1 className="text-2xl font-bold text-ink">
            {reviewedCount > 0 ? 'Session Complete!' : 'All Caught Up!'}
          </h1>
          <p className="text-sm text-muted">
            {reviewedCount > 0
              ? `You reviewed ${reviewedCount} card${reviewedCount === 1 ? '' : 's'}${
                  graduatedCount > 0 ? ` and graduated ${graduatedCount} word(s) to Known` : ''
                }.`
              : 'No cards are due right now. Save words while watching anime or from an episode transcript to build your review deck.'}
          </p>
          <div className="flex flex-wrap justify-center gap-3 pt-2">
            <Link
              to="/library"
              className="btn btn-sun px-4 py-2 font-semibold text-sm"
            >
              Browse Library
            </Link>
            <Link
              to="/words"
              className="btn px-4 py-2 text-ink font-semibold text-sm"
            >
              Manage Vocabulary
            </Link>
            <button
              type="button"
              onClick={() => void dueQuery.refetch()}
              className="btn px-4 py-2 text-ink-2 font-semibold text-sm cursor-pointer"
            >
              Check Again
            </button>
          </div>
        </div>
      </div>
    );
  }

  const media = groupCardMedia(currentCard.media);
  const screenshotUrl = media.screenshot
    ? resolveMediaUrl(media.screenshot.url, settings.serverUrl)
    : null;
  const audioUrl = media.audio
    ? resolveMediaUrl(media.audio.url, settings.serverUrl)
    : null;
  const clipUrl = media.clip
    ? resolveMediaUrl(media.clip.url, settings.serverUrl)
    : null;

  const progressDenom = Math.max(1, initialDueTotal);
  const progressPct = Math.min(100, Math.round((reviewedCount / progressDenom) * 100));

  const primaryLang: GlossLanguage = glossLang;
  const secondaryLang: GlossLanguage = glossLang === 'ger' ? 'eng' : 'ger';
  const primarySenses = currentCard.entry?.senses[primaryLang] ?? [];
  const secondarySenses = currentCard.entry?.senses[secondaryLang] ?? [];

  return (
    <div className="space-y-4">
      {/* Top session bar */}
      <div className="headline flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-ink">Review</h1>
          <span className="text-xs px-2.5 py-1 rounded-full bg-paper border border-line text-ink-2">
            {queue.length} due · {reviewedCount} done
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <label className="flex items-center gap-1.5 text-muted cursor-pointer">
            <input
              type="checkbox"
              checked={showRomaji}
              onChange={(e) => setShowRomaji(e.target.checked)}
              className="rounded border-line-2 bg-field"
            />
            <span>Romaji</span>
          </label>
          <select
            value={glossLang}
            onChange={(e) => setGlossLang(e.target.value as GlossLanguage)}
            className="rounded bg-paper border border-line-2 px-2 py-1 text-xs text-ink"
          >
            <option value="eng">Primary: EN</option>
            <option value="ger">Primary: DE</option>
          </select>
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-3 w-full rounded-full bg-paper border-2 border-ink overflow-hidden">
        <div
          className="h-full bg-torii transition-all duration-300"
          style={{ width: `${progressPct}%` }}
        />
      </div>

      {/* Graduation celebration toast */}
      {celebrationWord && (
        <div className="bg-leaf/30 border border-leaf/70 rounded-xl px-4 py-2.5 text-center text-sm text-leaf-ink font-semibold">
          🎉 Graduated! &ldquo;{celebrationWord}&rdquo; reached 21+ days stability and is now Known!
        </div>
      )}

      {/* Main Flashcard */}
      <div className="card overflow-hidden">
        {/* Episode metadata bar */}
        <div className="px-4 sm:px-5 py-2.5 sm:py-3 border-b border-line bg-field flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
          <span className="min-w-0 break-words">
            {currentCard.episode
              ? `${currentCard.episode.anime_title ?? 'Anime'}${
                  currentCard.episode.number !== null ? ` · Ep ${currentCard.episode.number}` : ''
                }`
              : 'Vocabulary Card'}
          </span>
          <span className="capitalize px-2 py-0.5 rounded bg-chip text-ink-2 shrink-0">
            {currentCard.card.state} · {currentCard.card.reps} reps
          </span>
        </div>

        {/* Scene Media (Screenshot / Clip / Placeholder until S-2 #14 lands) */}
        <div className="bg-field border-b border-line">
          {showClip && clipUrl ? (
            <video
              ref={videoRef}
              src={clipUrl}
              controls
              autoPlay
              className="w-full max-h-52 object-contain bg-black"
            />
          ) : screenshotUrl && imageErrorForCardId !== currentCard.card.id ? (
            <img
              src={screenshotUrl}
              alt={currentCard.word.lemma}
              onError={() => setImageErrorForCardId(currentCard.card.id)}
              className="w-full max-h-64 object-contain bg-chip"
            />
          ) : (
            <div className="h-20 flex flex-col items-center justify-center text-faint px-4 text-center">
              <span className="text-xs uppercase tracking-wider font-semibold text-faint">
                Scene Media
              </span>
              <span className="text-xs mt-1">
                {currentCard.media.length > 0
                  ? 'Media preview unavailable until media serving (#14) is active.'
                  : 'No scene screenshot attached to this card yet.'}
              </span>
            </div>
          )}

          {(audioUrl || clipUrl) && (
            <div className="px-4 py-2 bg-paper border-t border-line flex items-center justify-center gap-3">
              {audioUrl && (
                <>
                  <audio ref={audioRef} src={audioUrl} preload="auto" />
                  <button
                    type="button"
                    onClick={replayMedia}
                    className="btn px-3 py-1 text-xs font-semibold text-torii-ink cursor-pointer"
                  >
                    ▶ Replay Audio (R)
                  </button>
                </>
              )}
              {clipUrl && (
                <button
                  type="button"
                  onClick={() => setShowClip((v) => !v)}
                  className="btn px-3 py-1 text-xs font-semibold text-ink cursor-pointer"
                >
                  {showClip ? 'Show Screenshot' : 'Play Clip'}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Card Front: Target Word + Context Sentence */}
        <div className="p-4 sm:p-5 space-y-4">
          <div className="text-center space-y-2">
            <div className="font-display text-3xl sm:text-4xl text-ink tracking-wide break-words">
              {currentCard.word.lemma}
            </div>
            {revealed && currentCard.word.reading && (
              <div className="text-xl text-torii-ink font-medium">{currentCard.word.reading}</div>
            )}
            {revealed && (
              <div className="flex justify-center gap-2 text-xs pt-1">
                <span className="px-2 py-0.5 rounded bg-chip text-ink-2">
                  {currentCard.word.pos}
                </span>
                {currentCard.word.common && (
                  <span className="px-2 py-0.5 rounded bg-sun/30 text-torii-ink">Common</span>
                )}
              </div>
            )}
          </div>

          <ReviewSentence
            card={currentCard}
            showFurigana={revealed}
            showRomaji={revealed && showRomaji}
            showTranslation={revealed}
            glossLang={glossLang}
          />

          {/* Revealed Meanings */}
          {revealed ? (
            <div className="border-t border-line pt-4 space-y-3">
              {primarySenses.length > 0 ? (
                <div className="space-y-1.5">
                  <div className="text-[11px] uppercase tracking-wider text-faint font-semibold">
                    {primaryLang === 'ger' ? 'German (DE)' : 'English (EN)'}
                  </div>
                  <ol className="list-decimal list-inside space-y-1 text-base text-ink">
                    {primarySenses.slice(0, 5).map((sense, i) => (
                      <li key={i}>{sense.glosses.join('; ')}</li>
                    ))}
                  </ol>
                </div>
              ) : null}

              {secondarySenses.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[11px] uppercase tracking-wider text-faint font-semibold">
                    {secondaryLang === 'ger' ? 'German (DE)' : 'English (EN)'}
                  </div>
                  <ol className="list-decimal list-inside space-y-0.5 text-sm text-muted">
                    {secondarySenses.slice(0, 3).map((sense, i) => (
                      <li key={i}>{sense.glosses.join('; ')}</li>
                    ))}
                  </ol>
                </div>
              )}

              {primarySenses.length === 0 && secondarySenses.length === 0 && (
                <div className="text-sm text-faint text-center">
                  No JMdict glosses linked for this word.
                </div>
              )}

              {/* FSRS Rating Buttons (1-4) */}
              <div className="pt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-2.5">
                {RATING_BUTTONS.map((btn) => {
                  const interval = formatIntervalFromIso(currentCard.next_due[btn.key]);
                  return (
                    <button
                      key={btn.rating}
                      type="button"
                      disabled={submitMutation.isPending}
                      onClick={() => handleRate(btn.rating)}
                      className={`min-h-[56px] py-3 px-2 rounded-xl border font-semibold transition cursor-pointer touch-manipulation disabled:opacity-50 flex flex-col items-center justify-center gap-0.5 ${btn.colorClass}`}
                    >
                      <span className="text-sm">
                        {btn.label}{' '}
                        <kbd className="hidden sm:inline text-[10px] opacity-75 ml-0.5">({btn.key})</kbd>
                      </span>
                      <span className="text-xs opacity-85 font-mono">{interval || '—'}</span>
                    </button>
                  );
                })}
              </div>

              {submitMutation.isError && (
                <div className="text-xs text-rose-ink text-center">
                  Failed to save review: {(submitMutation.error as Error)?.message ?? 'Error'}
                </div>
              )}
            </div>
          ) : (
            <div className="pt-2">
              <button
                type="button"
                onClick={() => setRevealed(true)}
                className="btn btn-sun w-full min-h-[48px] py-3.5 font-bold text-base cursor-pointer touch-manipulation transition"
              >
                Show Answer{' '}
                <span className="hidden sm:inline text-xs font-medium opacity-75 ml-1">(Space)</span>
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="hidden sm:block text-center text-xs text-faint">
        Shortcuts: <kbd className="px-1.5 py-0.5 rounded bg-paper border border-line">Space</kbd> reveal ·{' '}
        <kbd className="px-1.5 py-0.5 rounded bg-paper border border-line">1</kbd>–
        <kbd className="px-1.5 py-0.5 rounded bg-paper border border-line">4</kbd> rate ·{' '}
        <kbd className="px-1.5 py-0.5 rounded bg-paper border border-line">R</kbd> replay audio
      </div>
    </div>
  );
}
