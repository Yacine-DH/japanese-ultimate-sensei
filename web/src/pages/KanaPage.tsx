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
    queryKey: ['kana-lookup', currentItem?.lemma, currentItem?.reading],
    queryFn: () => apiClient.lookupDictionary(currentItem!.lemma, currentItem!.reading, 2),
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
      setCorrectCount((c) => c + 1);
      setStreak((s) => {
        const next = s + 1;
        setBestStreak((best) => Math.max(best, next));
        return next;
      });
    } else {
      setResultState('wrong');
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
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Kana Trainer</h1>
          <p className="text-sm text-slate-400 mt-1">
            Short daily hiragana &amp; katakana drills pulled from the anime you&apos;re watching — drop romaji faster.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowChart((v) => !v)}
          className="px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800 transition"
        >
          {showChart ? 'Hide Kana Chart' : 'Show Kana Chart'}
        </button>
      </div>

      {/* Mode & Anime controls */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
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
                  ? 'bg-sky-500/20 border-sky-400/60 text-sky-200'
                  : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:text-slate-200'
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
            className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-200 text-xs"
          >
            <option value="">All Anime</option>
            {(animeQuery.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.title}
              </option>
            ))}
          </select>

          {mode !== 'katakana' && (
            <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={includeKanjiReadings}
                onChange={(e) => {
                  setIncludeKanjiReadings(e.target.checked);
                  resetRound(null, true);
                }}
                className="rounded border-slate-600 bg-slate-950 text-sky-400"
              />
              Include kanji readings
            </label>
          )}
        </div>
      </div>

      {/* Optional Kana Reference Chart */}
      {showChart && (
        <section className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-200">Basic Kana Reference (Gojūon)</h2>
            <span className="text-xs text-slate-500">Hiragana · Katakana · Romaji</span>
          </div>
          <div className="overflow-x-auto">
            <div className="grid grid-cols-5 gap-1.5 min-w-[340px]">
              {GOJUON_ROWS.flatMap((row) =>
                row.cells.map((cell, cIdx) =>
                  cell.hira ? (
                    <div
                      key={`${row.row}-${cIdx}`}
                      className="bg-slate-950/70 border border-slate-800 rounded-lg px-2 py-1.5 flex items-center justify-between text-xs"
                    >
                      <span className="text-slate-100 font-semibold text-sm">
                        {cell.hira} <span className="text-sky-300">{cell.kata}</span>
                      </span>
                      <span className="text-slate-400 font-mono">{cell.romaji}</span>
                    </div>
                  ) : (
                    <div key={`${row.row}-${cIdx}`} className="rounded-lg bg-slate-950/20" />
                  ),
                ),
              )}
            </div>
          </div>
        </section>
      )}

      {/* Main Drill Card or Summary */}
      {wordsQuery.isLoading && deck.length === 0 ? (
        <div className="h-64 rounded-2xl bg-slate-900 border border-slate-800 animate-pulse" />
      ) : isFinished ? (
        <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 sm:p-8 text-center space-y-5">
          <div className="space-y-1">
            <div className="text-xs uppercase tracking-wider text-emerald-400 font-semibold">
              Round Complete
            </div>
            <h2 className="text-3xl font-bold text-slate-100">
              {correctCount} / {deck.length} correct (
              {Math.round((correctCount / Math.max(1, deck.length)) * 100)}%)
            </h2>
            <p className="text-sm text-slate-400">
              Best streak: <strong className="text-slate-200">{bestStreak}</strong>
              {animeWordCount > 0 && ` · ${animeWordCount} words from your anime library`}
            </p>
          </div>

          {trickyKana.length > 0 && (
            <div className="max-w-lg mx-auto bg-slate-950/70 border border-slate-800 rounded-xl p-4 space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wider text-amber-300">
                Tricky characters to review
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                {trickyKana.map((k) => (
                  <div
                    key={k.char}
                    className="px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-sm flex items-center gap-2"
                  >
                    <span className="text-lg font-bold text-slate-100">{k.char}</span>
                    <span className="font-mono text-xs text-sky-300">{k.romaji}</span>
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
                className="px-4 py-2 rounded-lg text-sm font-semibold bg-amber-500/20 border border-amber-400/50 text-amber-200 hover:bg-amber-500/30 transition"
              >
                Retry {missedItems.length} missed {missedItems.length === 1 ? 'word' : 'words'}
              </button>
            )}
            <button
              type="button"
              onClick={() => resetRound(null, true)}
              className="px-4 py-2 rounded-lg text-sm font-semibold bg-sky-500 text-slate-950 hover:bg-sky-400 transition"
            >
              Start new {DECK_SIZE}-word round
            </button>
          </div>
        </section>
      ) : currentItem ? (
        <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 sm:p-8 space-y-6">
          {/* Progress header */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-slate-200">
                  Word {index + 1} of {deck.length}
                </span>
                <span
                  className={`px-2 py-0.5 rounded-full border text-[11px] ${
                    currentItem.source === 'anime'
                      ? 'bg-sky-500/15 border-sky-500/40 text-sky-300'
                      : 'bg-slate-800 border-slate-700 text-slate-400'
                  }`}
                >
                  {currentItem.source === 'anime'
                    ? `From your anime${currentItem.occurrences ? ` · seen ${currentItem.occurrences}×` : ''}`
                    : 'Starter anime deck'}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span>
                  Streak: <strong className="text-emerald-300">{streak}</strong>
                </span>
                <span>
                  Score:{' '}
                  <strong className="text-slate-200">
                    {correctCount}/{index + (resultState !== 'idle' ? 1 : 0)}
                  </strong>
                </span>
              </div>
            </div>
            <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
              <div
                className="h-full bg-sky-400 transition-all duration-200"
                style={{ width: `${Math.round(((index + (resultState !== 'idle' ? 1 : 0)) / deck.length) * 100)}%` }}
              />
            </div>
          </div>

          {/* Prompt display */}
          <div className="text-center py-4 space-y-3">
            <div className="text-xs uppercase tracking-widest text-slate-500">
              {currentItem.script === 'katakana' ? 'Katakana' : 'Hiragana'}
            </div>
            <div className="text-5xl sm:text-6xl font-bold tracking-wide text-slate-50 select-all">
              {currentItem.prompt}
            </div>
            {canSpeak && (
              <button
                type="button"
                onClick={() => speakJapanese(currentItem.prompt)}
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs border border-slate-700 bg-slate-950/70 text-slate-300 hover:border-sky-500/50 hover:text-sky-300 transition"
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
                className={`flex-1 rounded-xl px-4 py-3 text-base font-mono bg-slate-950 border outline-none transition ${
                  resultState === 'correct'
                    ? 'border-emerald-500 text-emerald-200'
                    : resultState === 'wrong' || resultState === 'skipped'
                      ? 'border-rose-500 text-rose-200'
                      : 'border-slate-700 text-slate-100 focus:border-sky-400'
                }`}
              />
              {resultState === 'idle' ? (
                <button
                  type="submit"
                  className="px-5 py-3 rounded-xl font-semibold text-sm bg-sky-500 text-slate-950 hover:bg-sky-400 transition shrink-0"
                >
                  Check
                </button>
              ) : (
                <button
                  type="submit"
                  className="px-5 py-3 rounded-xl font-semibold text-sm bg-emerald-500 text-slate-950 hover:bg-emerald-400 transition shrink-0"
                >
                  Next →
                </button>
              )}
            </div>

            {resultState === 'idle' && (
              <div className="flex items-center justify-between text-xs text-slate-500 px-1">
                <span>Press Enter to check · Hepburn &amp; Kunrei accepted</span>
                <button
                  type="button"
                  onClick={handleRevealAnswer}
                  className="text-slate-400 hover:text-slate-200 underline underline-offset-2"
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
                  ? 'bg-emerald-950/40 border-emerald-700/60 text-emerald-100'
                  : 'bg-rose-950/40 border-rose-700/60 text-rose-100'
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
                <span className="font-mono text-base font-bold text-sky-300">
                  {currentItem.romaji}
                </span>
              </div>

              {currentItem.lemma !== currentItem.prompt && (
                <div className="text-xs text-slate-300">
                  Written in kanji: <strong className="text-slate-100">{currentItem.lemma}</strong>
                </div>
              )}

              {glossSummary && (
                <div className="text-xs text-slate-300">
                  Meaning: <span className="text-slate-100">{glossSummary}</span>
                </div>
              )}

              <div className="text-[11px] text-slate-400 pt-1">Press Enter for the next word</div>
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
