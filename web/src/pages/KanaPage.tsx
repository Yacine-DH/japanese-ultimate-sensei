import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient, type LookupResult } from '../api/client';
import {
  buildKanaDrillDeck,
  extractTrickyKana,
  GOJUON_ROWS,
  isRomajiAnswerCorrect,
  type KanaDrillItem,
  type KanaDrillMode,
} from '../lib/kana';
import { type GlossLanguage, loadWebSettings } from '../lib/settings';
import { emitIsland } from '../scene/bus';

const DECK_SIZE = 10;

function pickGlossSummary(lookup: LookupResult | undefined, lang: GlossLanguage): string | null {
  const entry = lookup?.entries[0];
  if (!entry) return null;
  const preferred = entry.senses[lang];
  const fallback = entry.senses.eng ?? entry.senses.ger ?? Object.values(entry.senses)[0];
  const chosen = preferred && preferred.length > 0 ? preferred : fallback;
  const first = chosen?.[0];
  if (!first) return null;
  return first.glosses.slice(0, 3).join('; ');
}

function speakJapanese(text: string): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'ja-JP';
    utter.rate = 0.9;
    window.speechSynthesis.speak(utter);
  } catch {
    // Ignore unsupported TTS environments
  }
}

export function KanaPage() {
  const [mode, setMode] = useState<KanaDrillMode>('mixed');
  const [selectedAnimeId, setSelectedAnimeId] = useState<number | null>(null);
  const [includeKanjiReadings, setIncludeKanjiReadings] = useState(true);
  const [showChart, setShowChart] = useState(false);
  const [roundSeed, setRoundSeed] = useState(0);
  const [customDeck, setCustomDeck] = useState<KanaDrillItem[] | null>(null);

  const [index, setIndex] = useState(0);
  const [answerInput, setAnswerInput] = useState('');
  const [resultState, setResultState] = useState<'idle' | 'correct' | 'wrong' | 'skipped'>('idle');
  const [correctCount, setCorrectCount] = useState(0);
  const [streak, setStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [missedItems, setMissedItems] = useState<KanaDrillItem[]>([]);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const settings = useMemo(() => loadWebSettings(), []);
  const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window;

  const animeQuery = useQuery({
    queryKey: ['anime-list'],
    queryFn: () => apiClient.listAnime(),
  });

  const wordsQuery = useQuery({
    queryKey: ['kana-words', selectedAnimeId],
    queryFn: () =>
      apiClient.listWords({
        animeId: selectedAnimeId,
        limit: 200,
      }),
  });

  const generatedDeck = useMemo(() => {
    void roundSeed;
    return buildKanaDrillDeck(wordsQuery.data?.items ?? [], {
      mode,
      includeKanjiReadings,
      deckSize: DECK_SIZE,
    });
  }, [wordsQuery.data?.items, mode, includeKanjiReadings, roundSeed]);

  const deck = customDeck ?? generatedDeck;
  const isFinished = deck.length > 0 && index >= deck.length;
  const currentItem = !isFinished ? deck[index] : undefined;

  // Lookup gloss only after answering so we enrich the feedback without spoiling
  const lookupQuery = useQuery({
    queryKey: ['kana-lookup', currentItem?.wordId, currentItem?.lemma, currentItem?.reading],
    queryFn: () =>
      apiClient.lookupDictionary(currentItem!.lemma, currentItem!.reading, 2, currentItem!.wordId),
    enabled: Boolean(currentItem && resultState !== 'idle'),
    staleTime: 60_000,
  });

  const animeWordCount = useMemo(
    () => deck.filter((item) => item.source === 'anime').length,
    [deck],
  );

  const trickyKana = useMemo(
    () => extractTrickyKana(missedItems.map((m) => m.prompt)),
    [missedItems],
  );

  function resetRound(nextCustomDeck: KanaDrillItem[] | null = null, bumpSeed = false): void {
    setCustomDeck(nextCustomDeck);
    if (bumpSeed) {
      setRoundSeed((s) => s + 1);
    }
    setIndex(0);
    setAnswerInput('');
    setResultState('idle');
    setCorrectCount(0);
    setStreak(0);
    setBestStreak(0);
    setMissedItems([]);
  }

  useEffect(() => {
    if (resultState === 'idle' && !isFinished) {
      inputRef.current?.focus();
    }
  }, [index, resultState, isFinished]);

  function advanceToNext(): void {
    setIndex((prev) => prev + 1);
    setAnswerInput('');
    setResultState('idle');
  }

  function handleSubmit(e: FormEvent): void {
    e.preventDefault();
    if (!currentItem) return;

    if (resultState !== 'idle') {
      advanceToNext();
      return;
    }

    const trimmed = answerInput.trim();
    if (!trimmed) return;

    if (isRomajiAnswerCorrect(trimmed, currentItem.prompt)) {
      setResultState('correct');
      emitIsland({ type: 'kana', ok: true });
      setCorrectCount((c) => c + 1);
      setStreak((s) => {
        const next = s + 1;
        setBestStreak((best) => Math.max(best, next));
        return next;
      });
    } else {
      setResultState('wrong');
      emitIsland({ type: 'kana', ok: false });
      setStreak(0);
      setMissedItems((prev) =>
        prev.some((m) => m.id === currentItem.id) ? prev : [...prev, currentItem],
      );
    }
  }

  function handleRevealAnswer(): void {
    if (!currentItem || resultState !== 'idle') return;
    setResultState('skipped');
    setStreak(0);
    setMissedItems((prev) =>
      prev.some((m) => m.id === currentItem.id) ? prev : [...prev, currentItem],
    );
  }

  const glossSummary =
    pickGlossSummary(lookupQuery.data, settings.glossLang) ?? currentItem?.hintEn ?? null;

  return (
    <div className="space-y-6">
      <div className="headline flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Kana Trainer</h1>
          <p className="text-sm text-muted mt-1">
            Short daily hiragana &amp; katakana drills pulled from the anime you&apos;re watching — drop romaji faster.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowChart((v) => !v)}
          className="btn px-3 py-1.5 text-xs font-medium text-ink transition"
        >
          {showChart ? 'Hide Kana Chart' : 'Show Kana Chart'}
        </button>
      </div>

      {/* Mode & Anime controls */}
      <div className="card p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {(
            [
              { id: 'mixed', label: 'Mixed (あ / ア)' },
              { id: 'hiragana', label: 'Hiragana (あ)' },
              { id: 'katakana', label: 'Katakana (ア)' },
            ] as const
          ).map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => {
                setMode(opt.id);
                resetRound(null, true);
              }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
                mode === opt.id
                  ? 'bg-sun/40 border-torii/80 text-torii-ink'
                  : 'bg-field border-line text-muted hover:text-ink'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs">
          <select
            aria-label="Filter drill words by anime"
            value={selectedAnimeId ?? ''}
            onChange={(e) => {
              const val = e.target.value;
              setSelectedAnimeId(val ? Number(val) : null);
              resetRound(null, true);
            }}
            className="field px-2.5 py-1.5 text-ink text-xs"
          >
            <option value="">All Anime</option>
            {(animeQuery.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.title}
              </option>
            ))}
          </select>

          {mode !== 'katakana' && (
            <label className="flex items-center gap-1.5 text-ink-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={includeKanjiReadings}
                onChange={(e) => {
                  setIncludeKanjiReadings(e.target.checked);
                  resetRound(null, true);
                }}
                className="rounded border-line-2 bg-field text-torii-ink"
              />
              Include kanji readings
            </label>
          )}
        </div>
      </div>

      {/* Optional Kana Reference Chart */}
      {showChart && (
        <section className="card p-4 space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">Basic Kana Reference (Gojūon)</h2>
            <span className="text-xs text-faint">Hiragana · Katakana · Romaji</span>
          </div>
          <div className="overflow-x-auto">
            <div className="grid grid-cols-5 gap-1.5 min-w-[340px]">
              {GOJUON_ROWS.flatMap((row) =>
                row.cells.map((cell, cIdx) =>
                  cell.hira ? (
                    <div
                      key={`${row.row}-${cIdx}`}
                      className="bg-field border border-line rounded-lg px-2 py-1.5 flex items-center justify-between text-xs"
                    >
                      <span className="text-ink font-semibold text-sm">
                        {cell.hira} <span className="text-torii-ink">{cell.kata}</span>
                      </span>
                      <span className="text-muted font-mono">{cell.romaji}</span>
                    </div>
                  ) : (
                    <div key={`${row.row}-${cIdx}`} className="rounded-lg bg-field/60" />
                  ),
                ),
              )}
            </div>
          </div>
        </section>
      )}

      {/* Main Drill Card or Summary */}
      {wordsQuery.isLoading && deck.length === 0 ? (
        <div className="card h-64 animate-pulse" />
      ) : isFinished ? (
        <section className="card p-6 sm:p-8 text-center space-y-5">
          <div className="space-y-1">
            <div className="text-xs uppercase tracking-wider text-leaf-ink font-semibold">
              Round Complete
            </div>
            <h2 className="text-3xl font-bold text-ink">
              {correctCount} / {deck.length} correct (
              {Math.round((correctCount / Math.max(1, deck.length)) * 100)}%)
            </h2>
            <p className="text-sm text-muted">
              Best streak: <strong className="text-ink">{bestStreak}</strong>
              {animeWordCount > 0 && ` · ${animeWordCount} words from your anime library`}
            </p>
          </div>

          {trickyKana.length > 0 && (
            <div className="max-w-lg mx-auto bg-field border border-line rounded-xl p-4 space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wider text-gold-ink">
                Tricky characters to review
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                {trickyKana.map((k) => (
                  <div
                    key={k.char}
                    className="px-3 py-1.5 rounded-lg bg-paper border border-line-2 text-sm flex items-center gap-2"
                  >
                    <span className="text-lg font-bold text-ink">{k.char}</span>
                    <span className="font-mono text-xs text-torii-ink">{k.romaji}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-wrap justify-center gap-3 pt-2">
            {missedItems.length > 0 && (
              <button
                type="button"
                onClick={() => resetRound(missedItems, false)}
                className="btn btn-gold px-4 py-2 text-sm font-semibold transition"
              >
                Retry {missedItems.length} missed {missedItems.length === 1 ? 'word' : 'words'}
              </button>
            )}
            <button
              type="button"
              onClick={() => resetRound(null, true)}
              className="btn btn-sun px-4 py-2 text-sm font-semibold transition"
            >
              Start new {DECK_SIZE}-word round
            </button>
          </div>
        </section>
      ) : currentItem ? (
        <section className="card p-6 sm:p-8 space-y-6">
          {/* Progress header */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-ink">
                  Word {index + 1} of {deck.length}
                </span>
                <span
                  className={`px-2 py-0.5 rounded-full border text-[11px] ${
                    currentItem.source === 'anime'
                      ? 'bg-sun/30 border-torii/60 text-torii-ink'
                      : 'bg-chip border-line-2 text-muted'
                  }`}
                >
                  {currentItem.source === 'anime'
                    ? `From your anime${currentItem.occurrences ? ` · seen ${currentItem.occurrences}×` : ''}`
                    : 'Starter anime deck'}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span>
                  Streak: <strong className="text-leaf-ink">{streak}</strong>
                </span>
                <span>
                  Score:{' '}
                  <strong className="text-ink">
                    {correctCount}/{index + (resultState !== 'idle' ? 1 : 0)}
                  </strong>
                </span>
              </div>
            </div>
            <div className="h-1.5 rounded-full bg-chip overflow-hidden">
              <div
                className="h-full bg-torii transition-all duration-200"
                style={{ width: `${Math.round(((index + (resultState !== 'idle' ? 1 : 0)) / deck.length) * 100)}%` }}
              />
            </div>
          </div>

          {/* Prompt display */}
          <div className="text-center py-4 space-y-3">
            <div className="text-xs uppercase tracking-widest text-faint">
              {currentItem.script === 'katakana' ? 'Katakana' : 'Hiragana'}
            </div>
            <div className="font-display text-5xl sm:text-6xl tracking-wide text-ink select-all">
              {currentItem.prompt}
            </div>
            {canSpeak && (
              <button
                type="button"
                onClick={() => speakJapanese(currentItem.prompt)}
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs border border-line-2 bg-field text-ink-2 hover:border-torii/70 hover:text-torii-ink transition"
              >
                <span aria-hidden="true">🔊</span> Listen
              </button>
            )}
          </div>

          {/* Answer form */}
          <form onSubmit={handleSubmit} className="max-w-md mx-auto space-y-3">
            <div className="flex gap-2">
              <input
                ref={inputRef}
                type="text"
                value={answerInput}
                onChange={(e) => setAnswerInput(e.target.value)}
                readOnly={resultState !== 'idle'}
                placeholder="Type romaji (e.g. arigatou)..."
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                className={`flex-1 rounded-xl px-4 py-3 text-base font-mono bg-field border outline-none transition ${
                  resultState === 'correct'
                    ? 'border-leaf text-leaf-ink'
                    : resultState === 'wrong' || resultState === 'skipped'
                      ? 'border-rose text-rose-ink'
                      : 'border-line-2 text-ink focus:border-torii'
                }`}
              />
              {resultState === 'idle' ? (
                <button
                  type="submit"
                  className="btn btn-sun px-5 py-3 font-semibold text-sm transition shrink-0"
                >
                  Check
                </button>
              ) : (
                <button
                  type="submit"
                  className="btn btn-leaf px-5 py-3 font-semibold text-sm transition shrink-0"
                >
                  Next →
                </button>
              )}
            </div>

            {resultState === 'idle' && (
              <div className="flex items-center justify-between text-xs text-faint px-1">
                <span>Press Enter to check · Hepburn &amp; Kunrei accepted</span>
                <button
                  type="button"
                  onClick={handleRevealAnswer}
                  className="text-muted hover:text-ink underline underline-offset-2"
                >
                  Show answer
                </button>
              </div>
            )}
          </form>

          {/* Post-answer feedback + vocabulary meaning */}
          {resultState !== 'idle' && (
            <div
              className={`max-w-md mx-auto rounded-xl p-4 border text-sm space-y-1.5 ${
                resultState === 'correct'
                  ? 'bg-leaf/25 border-leaf/80 text-leaf-ink'
                  : 'bg-rose/25 border-rose/80 text-rose-ink'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">
                  {resultState === 'correct'
                    ? 'Correct!'
                    : resultState === 'skipped'
                      ? 'Answer'
                      : 'Not quite'}
                </span>
                <span className="font-mono text-base font-bold text-torii-ink">
                  {currentItem.romaji}
                </span>
              </div>

              {currentItem.lemma !== currentItem.prompt && (
                <div className="text-xs text-ink-2">
                  Written in kanji: <strong className="text-ink">{currentItem.lemma}</strong>
                </div>
              )}

              {glossSummary && (
                <div className="text-xs text-ink-2">
                  Meaning: <span className="text-ink">{glossSummary}</span>
                </div>
              )}

              <div className="text-[11px] text-muted pt-1">Press Enter for the next word</div>
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
