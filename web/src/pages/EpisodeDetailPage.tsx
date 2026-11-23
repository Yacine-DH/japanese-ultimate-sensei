import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  apiClient,
  type LineExplanation,
  type LineOut,
  type TokenOut,
  type WordStatus,
} from '../api/client';
import { MarkdownContent } from '../components/MarkdownContent';
import { MissedWordsPanel } from '../components/MissedWordsPanel';
import { PreWatchPrimer } from '../components/PreWatchPrimer';
import { shouldOpenPrepFromSearchParams } from '../lib/priming';
import {
  computeTranslationProgress,
  countTranslatedLines,
  glossLangToLlmLang,
  isTranslationJobActive,
  type LlmLang,
  pickLineTranslation,
} from '../lib/llm';
import { type GlossLanguage, loadWebSettings } from '../lib/settings';
import {
  computeBarSegments,
  filterTranscriptLines,
  formatTimestampMs,
  getTranscriptLineRomaji,
  isTokenLookupable,
  pickEntrySenses,
  shouldShowFurigana,
  updateWordStatusInTranscript,
} from '../lib/transcript';

function tokenClassName(token: TokenOut, isSelected: boolean): string {
  const base = 'inline-block px-0.5 rounded transition';
  const selectedRing = isSelected ? ' ring-2 ring-sky-400 bg-sky-500/25' : '';
  if (token.is_proper_noun) {
    return `${base} cursor-pointer text-slate-200 hover:bg-slate-800${selectedRing}`;
  }
  if (!token.is_content) {
    return `${base} text-slate-300`;
  }
  if (token.status === 'known') {
    return `${base} cursor-pointer text-slate-100 hover:bg-slate-800${selectedRing}`;
  }
  if (token.status === 'ignored') {
    return `${base} cursor-pointer text-slate-500 hover:bg-slate-800${selectedRing}`;
  }
  if (token.status === 'learning') {
    return `${base} cursor-pointer text-amber-200 border-b-2 border-dotted border-amber-400 hover:bg-amber-500/15${selectedRing}`;
  }
  if ((token.zipf ?? 0) >= 4.0 || token.common) {
    return `${base} cursor-pointer text-sky-200 border-b-2 border-sky-400 hover:bg-sky-500/15${selectedRing}`;
  }
  return `${base} cursor-pointer text-indigo-200 border-b border-dashed border-indigo-400/70 hover:bg-indigo-500/15${selectedRing}`;
}

export function EpisodeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const episodeId = Number(id);
  const queryClient = useQueryClient();

  const initialSettings = loadWebSettings();
  const [showPrimer, setShowPrimer] = useState(() => shouldOpenPrepFromSearchParams(searchParams));
  const [showMissed, setShowMissed] = useState(() => searchParams.get('missed') === '1');
  const [search, setSearch] = useState('');
  const [onlyUnknown, setOnlyUnknown] = useState(false);
  const [showRomaji, setShowRomaji] = useState(initialSettings.romaji);
  const [glossLang, setGlossLang] = useState<GlossLanguage>(initialSettings.glossLang);
  const [showAllTranslations, setShowAllTranslations] = useState(false);
  const [lineTranslationOverrides, setLineTranslationOverrides] = useState<Record<number, boolean>>(
    {},
  );
  const [selectedToken, setSelectedToken] = useState<TokenOut | null>(null);
  const [selectedLineId, setSelectedLineId] = useState<number | null>(null);
  const [inspectorTab, setInspectorTab] = useState<'word' | 'explain'>('word');
  const [explainedLine, setExplainedLine] = useState<LineOut | null>(null);
  const [explainCache, setExplainCache] = useState<Record<string, LineExplanation>>({});
  const [explainError, setExplainError] = useState<string | null>(null);
  const [cardNotice, setCardNotice] = useState<string | null>(null);

  const llmLang: LlmLang = glossLangToLlmLang(glossLang);

  const episodeQuery = useQuery({
    queryKey: ['episode', episodeId],
    queryFn: () => apiClient.getEpisode(episodeId),
    enabled: Number.isFinite(episodeId),
    retry: false,
  });

  const linesQuery = useQuery({
    queryKey: ['episode-lines', episodeId],
    queryFn: () => apiClient.getEpisodeLines(episodeId),
    enabled: Number.isFinite(episodeId),
    retry: false,
  });

  const understandingQuery = useQuery({
    queryKey: ['understanding', episodeId],
    queryFn: () => apiClient.getEpisodeUnderstanding(episodeId),
    enabled: Number.isFinite(episodeId),
    retry: false,
  });

  const llmStatusQuery = useQuery({
    queryKey: ['llm-status'],
    queryFn: () => apiClient.getLlmStatus(),
    retry: false,
    staleTime: 30_000,
  });

  const translationJobQuery = useQuery({
    queryKey: ['episode-translation-job', episodeId],
    queryFn: () => apiClient.getTranslationJob(episodeId),
    enabled: Number.isFinite(episodeId),
    retry: false,
    refetchInterval: (query) => (isTranslationJobActive(query.state.data) ? 2500 : false),
  });

  const prevJobSnapshotRef = useRef<{ translated: number; active: boolean } | null>(null);
  useEffect(() => {
    const job = translationJobQuery.data;
    if (!job) return;
    const active = isTranslationJobActive(job);
    const prev = prevJobSnapshotRef.current;
    if (prev && (job.translated_lines !== prev.translated || (prev.active && !active))) {
      void queryClient.invalidateQueries({ queryKey: ['episode-lines', episodeId] });
    }
    prevJobSnapshotRef.current = { translated: job.translated_lines, active };
  }, [translationJobQuery.data, episodeId, queryClient]);

  const startTranslationMutation = useMutation({
    mutationFn: () => apiClient.startEpisodeTranslation(episodeId),
    onSuccess: (job) => {
      queryClient.setQueryData(['episode-translation-job', episodeId], job);
      setShowAllTranslations(true);
      setLineTranslationOverrides({});
    },
  });

  const explainRequestSeqRef = useRef(0);
  const explainMutation = useMutation({
    mutationFn: async ({
      lineId,
      lang,
      refresh,
    }: {
      lineId: number;
      lang: LlmLang;
      refresh: boolean;
    }) => {
      const seq = ++explainRequestSeqRef.current;
      const data = await apiClient.explainLine(lineId, lang, refresh);
      return { seq, data };
    },
    onSuccess: ({ seq, data }) => {
      setExplainCache((prev) => ({
        ...prev,
        [`${data.line_id}:${data.lang}`]: data,
      }));
      if (seq === explainRequestSeqRef.current) {
        setExplainError(null);
      }
    },
    onError: (err) => {
      setExplainError(err instanceof Error ? err.message : 'Failed to explain line');
    },
  });

  function requestExplainLine(line: LineOut, lang: LlmLang, refresh = false) {
    setExplainedLine(line);
    setInspectorTab('explain');
    setExplainError(null);
    const key = `${line.id}:${lang}`;
    if (!refresh && explainCache[key]) {
      return;
    }
    explainMutation.mutate({ lineId: line.id, lang, refresh });
  }

  function isLineTranslationExpanded(lineId: number): boolean {
    if (lineId in lineTranslationOverrides) {
      return lineTranslationOverrides[lineId]!;
    }
    return showAllTranslations;
  }

  function toggleLineTranslation(lineId: number) {
    const currentlyExpanded = isLineTranslationExpanded(lineId);
    setLineTranslationOverrides((prev) => ({ ...prev, [lineId]: !currentlyExpanded }));
  }

  const lookupQuery = useQuery({
    queryKey: [
      'dict-lookup',
      selectedToken?.word_id,
      selectedToken?.lemma,
      selectedToken?.lemma_reading,
    ],
    queryFn: () =>
      apiClient.lookupDictionary(
        selectedToken!.lemma,
        selectedToken!.lemma_reading,
        5,
        selectedToken!.word_id,
      ),
    enabled: selectedToken !== null,
    retry: false,
  });

  const statusMutation = useMutation({
    mutationFn: ({ wordId, status }: { wordId: number; status: WordStatus }) =>
      apiClient.setWordStatus(wordId, status),
    onSuccess: (updatedWord) => {
      queryClient.setQueryData<LineOut[]>(['episode-lines', episodeId], (prev) =>
        prev ? updateWordStatusInTranscript(prev, updatedWord.id, updatedWord.status) : prev,
      );
      setSelectedToken((prev) =>
        prev && prev.word_id === updatedWord.id
          ? { ...prev, status: updatedWord.status }
          : prev,
      );
      setCardNotice(null);
      void queryClient.invalidateQueries({ queryKey: ['understanding', episodeId] });
    },
  });

  const saveCardMutation = useMutation({
    mutationFn: ({ wordId, lineId }: { wordId: number; lineId: number | null }) =>
      apiClient.createCard({ word_id: wordId, line_id: lineId, media_ids: [] }),
    onSuccess: (created) => {
      queryClient.setQueryData<LineOut[]>(['episode-lines', episodeId], (prev) =>
        prev ? updateWordStatusInTranscript(prev, created.word_id, 'learning') : prev,
      );
      setSelectedToken((prev) =>
        prev && prev.word_id === created.word_id ? { ...prev, status: 'learning' } : prev,
      );
      setCardNotice(created.created ? 'Added flashcard to review queue.' : 'Card already in review queue.');
      void queryClient.invalidateQueries({ queryKey: ['understanding', episodeId] });
      void queryClient.invalidateQueries({ queryKey: ['reviews-due'] });
    },
  });

  const reprocessMutation = useMutation({
    mutationFn: () => apiClient.reprocessEpisode(episodeId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['episode', episodeId] });
      void queryClient.invalidateQueries({ queryKey: ['episode-lines', episodeId] });
      void queryClient.invalidateQueries({ queryKey: ['understanding', episodeId] });
      void queryClient.invalidateQueries({ queryKey: ['episodes'] });
    },
  });

  if (!Number.isFinite(episodeId)) {
    return (
      <div className="text-sm text-rose-400">
        Invalid episode ID.{' '}
        <Link to="/" className="underline text-sky-300">
          Back to Library
        </Link>
      </div>
    );
  }

  const lines = linesQuery.data ?? [];
  const filteredLines = filterTranscriptLines(lines, search, onlyUnknown);
  const ep = episodeQuery.data;
  const understanding = understandingQuery.data;
  const segments = understanding ? computeBarSegments(understanding) : null;
  const llmStatus = llmStatusQuery.data;
  const llmConfigured = llmStatus?.configured ?? false;
  const llmUnconfigured = llmStatus !== undefined && !llmStatus.configured;
  const translationJob = translationJobQuery.data;
  const translationActive = isTranslationJobActive(translationJob);
  const translationPct = computeTranslationProgress(translationJob);
  const translatedLineCount = countTranslatedLines(lines);
  const allLinesTranslated =
    translationJob !== undefined &&
    translationJob.total_lines > 0 &&
    translationJob.translated_lines >= translationJob.total_lines;
  const currentExplainKey = explainedLine ? `${explainedLine.id}:${llmLang}` : null;
  const currentExplanation = currentExplainKey ? explainCache[currentExplainKey] ?? null : null;
  const isExplainingCurrent =
    explainMutation.isPending &&
    explainMutation.variables?.lineId === explainedLine?.id &&
    explainMutation.variables?.lang === llmLang;

  const translateBtnLabel = translationJob?.running
    ? `Translating… (${translationJob.translated_lines}/${translationJob.total_lines})`
    : translationJob?.queued
      ? 'Queued for translation…'
      : allLinesTranslated
        ? 'Translated ✓'
        : translationJob && translationJob.translated_lines > 0
          ? `Resume Translation (${translationJob.translated_lines}/${translationJob.total_lines})`
          : 'Translate Episode';

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <Link to="/" className="text-xs font-medium text-sky-400 hover:text-sky-300">
            &larr; Back to Library
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to={`/episodes/${episodeId}/watch`}
              className="px-3 py-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-200 border border-emerald-500/40 text-xs font-bold"
            >
              Watch Video File
            </Link>
            <button
              type="button"
              onClick={() => setShowPrimer((v) => !v)}
              className="px-3 py-1.5 rounded-lg bg-sky-400 hover:bg-sky-300 text-slate-950 text-xs font-bold cursor-pointer"
            >
              {showPrimer ? 'Hide Prep' : 'Prep this episode (10 words)'}
            </button>
            <button
              type="button"
              onClick={() => setShowMissed((v) => !v)}
              className="px-3 py-1.5 rounded-lg bg-amber-400/20 hover:bg-amber-400/30 text-amber-200 border border-amber-400/50 text-xs font-bold cursor-pointer"
            >
              {showMissed ? 'Hide Missed Words' : 'Words You Missed'}
            </button>
            <button
              type="button"
              disabled={
                !llmConfigured ||
                translationActive ||
                allLinesTranslated ||
                startTranslationMutation.isPending
              }
              onClick={() => startTranslationMutation.mutate()}
              className="px-3 py-1.5 rounded-lg bg-indigo-500/20 hover:bg-indigo-500/30 disabled:opacity-50 disabled:cursor-not-allowed text-indigo-200 border border-indigo-400/50 text-xs font-bold cursor-pointer"
              title={
                llmUnconfigured
                  ? 'Set up a model on the server'
                  : llmStatus && !llmStatus.reachable
                    ? `LLM unreachable: ${llmStatus.detail}`
                    : 'Translate untranslated lines (EN + DE) in the background using the server LLM'
              }
            >
              {startTranslationMutation.isPending ? 'Starting…' : translateBtnLabel}
            </button>
            <button
              type="button"
              disabled={reprocessMutation.isPending}
              onClick={() => reprocessMutation.mutate()}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-xs font-semibold text-slate-200 border border-slate-700 cursor-pointer"
              title="Re-tokenize lines with the latest server tokenizer, romaji grouping, and name detection"
            >
              {reprocessMutation.isPending ? 'Reprocessing...' : 'Reprocess Episode'}
            </button>
          </div>
        </div>
        {llmUnconfigured && (
          <div className="text-xs text-slate-400">
            LLM translations &amp; grammar notes disabled — set up a model on the server (
            <code>SENSEI_LLM_BASE_URL</code> + <code>SENSEI_LLM_MODEL</code>).
          </div>
        )}
        {startTranslationMutation.isError && (
          <div className="text-xs text-rose-400">
            Translation could not start:{' '}
            {(startTranslationMutation.error as Error)?.message ?? 'Error'}
          </div>
        )}
        {translationJob &&
          (translationActive ||
            Boolean(translationJob.error) ||
            translationJob.failed_lines > 0 ||
            (translationJob.translated_lines > 0 && !allLinesTranslated)) && (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-3.5 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-2 font-medium text-slate-200">
                  {translationActive && (
                    <span className="inline-block w-3 h-3 rounded-full border-2 border-indigo-400 border-t-transparent animate-spin" />
                  )}
                  <span>
                    {translationJob.running
                      ? 'Translating episode in background…'
                      : translationJob.queued
                        ? 'Translation queued (waiting for active episode job)…'
                        : translationJob.error
                          ? 'Translation stopped with an error'
                          : 'Episode translation progress'}
                  </span>
                </div>
                <span className="font-mono text-slate-400">
                  {translationJob.translated_lines}/{translationJob.total_lines} lines (
                  {translationPct}%)
                </span>
              </div>
              <div className="h-2 w-full rounded-full bg-slate-800 overflow-hidden">
                <div
                  className={`h-full transition-all ${
                    translationJob.error ? 'bg-rose-500' : 'bg-indigo-400'
                  }`}
                  style={{ width: `${translationPct}%` }}
                />
              </div>
              {translationJob.error && (
                <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-1.5">
                  Error: {translationJob.error}
                </div>
              )}
              {translationJob.failed_lines > 0 && (
                <div className="text-xs text-amber-300">
                  {translationJob.failed_lines} line
                  {translationJob.failed_lines === 1 ? '' : 's'} skipped in the last run — click{' '}
                  <strong>Resume Translation</strong> to retry.
                </div>
              )}
            </div>
          )}
        {reprocessMutation.isError && (
          <div className="text-xs text-rose-400">
            Reprocess failed: {(reprocessMutation.error as Error)?.message ?? 'Error'}
          </div>
        )}

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5 flex-wrap">
              <h1 className="text-2xl font-bold text-slate-100">
                {ep?.anime_title ?? `Episode #${episodeId}`}
              </h1>
              {ep?.number !== null && ep?.number !== undefined && (
                <span className="text-sm px-2.5 py-0.5 rounded-md bg-sky-500/15 text-sky-300 font-semibold">
                  Ep {ep.number}
                </span>
              )}
            </div>
            {ep?.title && <p className="text-sm text-slate-400 mt-1">{ep.title}</p>}
          </div>

          {understanding && segments && (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 min-w-[260px] space-y-2">
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-xl font-bold text-emerald-400">
                  {understanding.token_pct.toFixed(1)}%
                </span>
                <span className="text-xs text-slate-400">
                  {understanding.unique_pct.toFixed(1)}% unique ({understanding.known_unique}/
                  {understanding.unique_words})
                </span>
              </div>
              <div className="h-2 w-full rounded-full bg-slate-800 overflow-hidden flex">
                <div
                  className="bg-emerald-500 transition-all"
                  style={{ width: `${segments.knownPct}%` }}
                />
                <div
                  className="bg-amber-400 transition-all"
                  style={{ width: `${segments.learningPct}%` }}
                />
              </div>
              <div className="text-[11px] text-slate-500 flex justify-between">
                <span>{understanding.known_tokens} known tokens</span>
                <span>{understanding.learning_tokens} learning</span>
                <span>{understanding.total_tokens} total</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Pre-Watch Primer (#35) */}
      {showPrimer && (
        <PreWatchPrimer
          episodeId={episodeId}
          lines={lines}
          understanding={understanding}
          glossLang={glossLang}
          onClose={() => setShowPrimer(false)}
        />
      )}

      {/* Post-Watch Missed Words (E-7 / #29) */}
      {showMissed && (
        <MissedWordsPanel
          episodeId={episodeId}
          glossLang={glossLang}
          onClose={() => setShowMissed(false)}
        />
      )}

      {/* Controls toolbar */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-wrap items-center gap-4">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search Japanese, reading, or romaji..."
          className="flex-1 min-w-[200px] rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-sky-400"
        />
        <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
          <input
            type="checkbox"
            checked={onlyUnknown}
            onChange={(e) => setOnlyUnknown(e.target.checked)}
            className="rounded border-slate-700 bg-slate-950"
          />
          <span>Pre-study (unknown words only)</span>
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
          <input
            type="checkbox"
            checked={showRomaji}
            onChange={(e) => setShowRomaji(e.target.checked)}
            className="rounded border-slate-700 bg-slate-950"
          />
          <span>Romaji</span>
        </label>
        <label
          className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer"
          title={
            translatedLineCount === 0
              ? 'No translations saved for this episode yet'
              : 'Expand or collapse translations under every transcript line'
          }
        >
          <input
            type="checkbox"
            checked={showAllTranslations}
            onChange={(e) => {
              setShowAllTranslations(e.target.checked);
              setLineTranslationOverrides({});
            }}
            className="rounded border-slate-700 bg-slate-950"
          />
          <span>
            Translations
            {translatedLineCount > 0 ? ` (${translatedLineCount}/${lines.length})` : ''}
          </span>
        </label>
        <select
          value={glossLang}
          onChange={(e) => setGlossLang(e.target.value as GlossLanguage)}
          className="rounded-lg bg-slate-950 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-100"
        >
          <option value="eng">Gloss: EN</option>
          <option value="ger">Gloss: DE</option>
        </select>
        <span className="text-xs text-slate-500">
          {filteredLines.length}/{lines.length} lines
        </span>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-4 text-xs text-slate-400">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-0.5 bg-sky-400" /> New (common)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-0.5 border-b border-dashed border-indigo-400" /> New
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-0.5 border-b-2 border-dotted border-amber-400" />{' '}
          Learning
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-2 h-2 rounded-full bg-slate-200" /> Known (furigana
          hidden)
        </span>
      </div>

      {/* Main split layout: transcript + dictionary inspector */}
      <div className="grid gap-6 lg:grid-cols-[1fr_340px] items-start">
        <div className="space-y-2">
          {linesQuery.isLoading ? (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 text-sm text-slate-400">
              Loading transcript...
            </div>
          ) : linesQuery.isError ? (
            <div className="bg-slate-900 border border-rose-900/60 rounded-xl p-6 text-sm text-rose-300">
              Failed to load lines: {(linesQuery.error as Error)?.message ?? 'Unknown error'}
            </div>
          ) : filteredLines.length === 0 ? (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 text-sm text-slate-400">
              No transcript lines match the current filter.
            </div>
          ) : (
            filteredLines.map((line) => {
              const translation = pickLineTranslation(line, glossLang);
              const translationExpanded = translation !== null && isLineTranslationExpanded(line.id);
              const isExplainedRow = explainedLine?.id === line.id && inspectorTab === 'explain';
              return (
                <div
                  key={line.id}
                  className={`bg-slate-900/80 border rounded-xl px-4 py-3 flex gap-3 items-baseline transition ${
                    isExplainedRow ? 'border-indigo-400/70 bg-indigo-950/20' : 'border-slate-800/80'
                  }`}
                >
                  <span className="text-xs font-mono text-slate-500 shrink-0 w-12">
                    {formatTimestampMs(line.start_ms)}
                  </span>
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="text-lg leading-loose tracking-wide break-words">
                      {line.tokens.map((token, idx) => {
                        const isSelected =
                          selectedToken !== null &&
                          ((token.word_id !== null && token.word_id === selectedToken.word_id) ||
                            (token.lemma === selectedToken.lemma &&
                              token.lemma_reading === selectedToken.lemma_reading));
                        return (
                          <span
                            key={`${line.id}-${idx}`}
                            className={tokenClassName(token, isSelected)}
                            onClick={() => {
                              if (isTokenLookupable(token)) {
                                setSelectedToken(token);
                                setSelectedLineId(line.id);
                                setInspectorTab('word');
                                setCardNotice(null);
                              }
                            }}
                          >
                            {token.furigana.map((seg, sIdx) =>
                              shouldShowFurigana(token, seg.ruby) ? (
                                <ruby key={sIdx}>
                                  {seg.text}
                                  <rt className="text-[11px] text-slate-400 font-normal">
                                    {seg.ruby}
                                  </rt>
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
                      <div className="text-xs text-slate-400 font-mono">
                        {getTranscriptLineRomaji(line)}
                      </div>
                    )}
                    {translation && (
                      <div className="pt-0.5">
                        {translationExpanded ? (
                          <div className="flex items-start justify-between gap-2 text-xs text-sky-200/90 bg-slate-950/60 border border-slate-800/80 rounded-lg px-2.5 py-1.5">
                            <span className="leading-relaxed">
                              <span className="uppercase text-[10px] font-semibold text-sky-400 mr-1.5">
                                {translation.lang}
                              </span>
                              {translation.text}
                            </span>
                            <button
                              type="button"
                              onClick={() => toggleLineTranslation(line.id)}
                              className="text-[11px] text-slate-500 hover:text-slate-300 shrink-0 cursor-pointer"
                            >
                              Hide
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => toggleLineTranslation(line.id)}
                            className="text-[11px] text-slate-500 hover:text-sky-300 cursor-pointer"
                          >
                            ▸ Translation ({translation.lang.toUpperCase()})
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    disabled={!llmConfigured}
                    onClick={() => requestExplainLine(line, llmLang)}
                    title={
                      llmUnconfigured
                        ? 'Set up a model on the server'
                        : 'Explain this line (translation, word breakdown & grammar notes)'
                    }
                    className={`shrink-0 px-2 py-1 rounded-md text-[11px] font-semibold border transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                      isExplainedRow
                        ? 'bg-indigo-500/25 border-indigo-400 text-indigo-200'
                        : 'bg-slate-800/80 border-slate-700 text-slate-300 hover:text-indigo-200 hover:border-indigo-400/60'
                    }`}
                  >
                    Explain
                  </button>
                </div>
              );
            })
          )}
        </div>

        {/* Sticky Dictionary & Line Explanation Inspector */}
        <aside className="bg-slate-900 border border-slate-800 rounded-xl p-5 lg:sticky lg:top-20 space-y-4">
          {selectedToken && explainedLine && (
            <div className="grid grid-cols-2 gap-1.5 bg-slate-950 p-1 rounded-lg border border-slate-800 text-xs font-semibold">
              <button
                type="button"
                onClick={() => setInspectorTab('word')}
                className={`py-1 rounded-md cursor-pointer transition ${
                  inspectorTab === 'word'
                    ? 'bg-slate-800 text-sky-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Word Lookup
              </button>
              <button
                type="button"
                onClick={() => setInspectorTab('explain')}
                className={`py-1 rounded-md cursor-pointer transition ${
                  inspectorTab === 'explain'
                    ? 'bg-slate-800 text-indigo-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Explain Line
              </button>
            </div>
          )}

          {inspectorTab === 'explain' && explainedLine ? (
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-indigo-300">
                      Explain Line ({llmLang.toUpperCase()})
                    </span>
                    <span className="text-[11px] font-mono text-slate-500">
                      {formatTimestampMs(explainedLine.start_ms)}
                    </span>
                  </div>
                  <div className="text-base font-medium text-slate-100 mt-1 break-words">
                    {explainedLine.text}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setExplainedLine(null);
                    setInspectorTab('word');
                  }}
                  className="text-xs text-slate-500 hover:text-slate-300 shrink-0 cursor-pointer"
                >
                  Close
                </button>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={!llmConfigured || isExplainingCurrent}
                  onClick={() => requestExplainLine(explainedLine, llmLang, true)}
                  className="px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-xs text-slate-200 border border-slate-700 cursor-pointer"
                >
                  {currentExplanation ? 'Regenerate' : `Explain (${llmLang.toUpperCase()})`}
                </button>
                {currentExplanation && (
                  <span className="text-[11px] text-slate-500">
                    {currentExplanation.model} · {currentExplanation.cached ? 'Cached' : 'Fresh'}
                  </span>
                )}
              </div>

              <div className="border-t border-slate-800 pt-3">
                {isExplainingCurrent ? (
                  <div className="flex items-start gap-2.5 text-xs text-slate-300 py-2">
                    <span className="inline-block w-4 h-4 mt-0.5 rounded-full border-2 border-indigo-400 border-t-transparent animate-spin shrink-0" />
                    <div>
                      <div className="font-medium text-indigo-200">Explaining this line…</div>
                      <div className="text-slate-500 mt-0.5">
                        Uncached calls can take 10–60 s on a small local model.
                      </div>
                    </div>
                  </div>
                ) : explainError ? (
                  <div className="space-y-2">
                    <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg p-2.5">
                      {explainError}
                    </div>
                    <button
                      type="button"
                      disabled={!llmConfigured}
                      onClick={() => requestExplainLine(explainedLine, llmLang, false)}
                      className="px-3 py-1 rounded-md bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-200 border border-indigo-400/50 text-xs font-semibold cursor-pointer"
                    >
                      Retry
                    </button>
                  </div>
                ) : currentExplanation ? (
                  <MarkdownContent text={currentExplanation.text} />
                ) : (
                  <div className="text-xs text-slate-400 space-y-2">
                    <p>No {llmLang.toUpperCase()} explanation loaded yet for this line.</p>
                    <button
                      type="button"
                      disabled={!llmConfigured}
                      onClick={() => requestExplainLine(explainedLine, llmLang, false)}
                      className="px-3 py-1.5 rounded-lg bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-200 border border-indigo-400/50 text-xs font-semibold cursor-pointer"
                    >
                      Explain in {llmLang.toUpperCase()}
                    </button>
                  </div>
                )}
              </div>
            </div>
          ) : !selectedToken ? (
            <div className="text-sm text-slate-400 space-y-1">
              <div className="font-semibold text-slate-200">Dictionary &amp; Grammar Inspector</div>
              <p className="text-xs text-slate-500">
                Click any content word in the transcript for JMdict EN/DE definitions, or click{' '}
                <strong className="text-slate-300">Explain</strong> on any line for an LLM grammar
                breakdown.
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-2xl font-bold text-slate-100">
                      {selectedToken.lemma}
                    </span>
                    {selectedToken.lemma_reading &&
                      selectedToken.lemma_reading !== selectedToken.lemma && (
                        <span className="text-sm text-sky-400">{selectedToken.lemma_reading}</span>
                      )}
                  </div>
                  <div className="flex items-center gap-2 mt-1 text-xs">
                    <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                      {selectedToken.pos}
                    </span>
                    {selectedToken.is_proper_noun && (
                      <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300">Name</span>
                    )}
                    {selectedToken.common && (
                      <span className="px-2 py-0.5 rounded bg-sky-500/15 text-sky-300">
                        Common
                      </span>
                    )}
                    {selectedToken.status && (
                      <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-400 capitalize">
                        {selectedToken.status}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedToken(null)}
                  className="text-xs text-slate-500 hover:text-slate-300 cursor-pointer"
                >
                  Close
                </button>
              </div>

              {selectedToken.word_id !== null && (
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    disabled={statusMutation.isPending}
                    onClick={() =>
                      statusMutation.mutate({
                        wordId: selectedToken.word_id!,
                        status: 'known',
                      })
                    }
                    className={`py-1.5 rounded-lg text-xs font-semibold border cursor-pointer transition ${
                      selectedToken.status === 'known'
                        ? 'bg-emerald-500/20 border-emerald-400 text-emerald-300'
                        : 'bg-slate-800 border-slate-700 text-emerald-300 hover:bg-slate-700'
                    }`}
                  >
                    Known
                  </button>
                  <button
                    type="button"
                    disabled={statusMutation.isPending}
                    onClick={() =>
                      statusMutation.mutate({
                        wordId: selectedToken.word_id!,
                        status: 'ignored',
                      })
                    }
                    className={`py-1.5 rounded-lg text-xs font-semibold border cursor-pointer transition ${
                      selectedToken.status === 'ignored'
                        ? 'bg-slate-700 border-slate-400 text-slate-200'
                        : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    Ignore
                  </button>
                  <button
                    type="button"
                    disabled={saveCardMutation.isPending}
                    onClick={() =>
                      saveCardMutation.mutate({
                        wordId: selectedToken.word_id!,
                        lineId: selectedLineId,
                      })
                    }
                    className={`py-1.5 rounded-lg text-xs font-semibold border cursor-pointer transition ${
                      selectedToken.status === 'learning'
                        ? 'bg-amber-500/20 border-amber-400 text-amber-300'
                        : 'bg-slate-800 border-slate-700 text-sky-300 hover:bg-slate-700'
                    }`}
                  >
                    Save Card
                  </button>
                </div>
              )}
              {cardNotice && <div className="text-xs text-emerald-400">{cardNotice}</div>}

              <div className="border-t border-slate-800 pt-3 space-y-3">
                {lookupQuery.isLoading ? (
                  <div className="text-xs text-slate-400">Looking up in JMdict...</div>
                ) : lookupQuery.isError ? (
                  <div className="text-xs text-rose-400">
                    {(lookupQuery.error as Error)?.message ?? 'Dictionary unavailable'}
                  </div>
                ) : lookupQuery.data && lookupQuery.data.entries.length > 0 ? (
                  lookupQuery.data.entries.slice(0, 3).map((entry) => {
                    const { lang, senses } = pickEntrySenses(entry, glossLang);
                    return (
                      <div key={entry.id} className="space-y-1">
                        <div className="flex items-center justify-between text-xs text-slate-400">
                          <span>
                            {entry.kanji[0] ?? entry.kana[0]} ({entry.kana[0]})
                          </span>
                          <span className="uppercase text-[10px] text-slate-500">{lang}</span>
                        </div>
                        <ol className="list-decimal list-inside text-sm text-slate-200 space-y-1">
                          {senses.slice(0, 5).map((sense, i) => (
                            <li key={i}>{sense.glosses.join('; ')}</li>
                          ))}
                        </ol>
                      </div>
                    );
                  })
                ) : (
                  <div className="text-xs text-slate-500">No dictionary entries found.</div>
                )}
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
