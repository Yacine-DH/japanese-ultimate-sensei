import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  apiClient,
  SenseiApiError,
  type WordListItem,
  type WordStatus,
} from '../api/client';
import { type GlossLanguage, loadWebSettings } from '../lib/settings';
import { pickEntrySenses } from '../lib/transcript';
import { ImportWordsPanel } from '../components/ImportWordsPanel';
import {
  computePagination,
  extractAnimeOptions,
  toggleAllSelection,
  toggleIdSelection,
  WORD_STATUS_OPTIONS,
} from '../lib/words';

const PAGE_SIZE = 50;

function statusBadgeClass(status: WordStatus): string {
  switch (status) {
    case 'known':
      return 'bg-leaf/30 text-leaf-ink border-leaf/50';
    case 'learning':
      return 'bg-gold/30 text-gold-ink border-gold/50';
    case 'ignored':
      return 'bg-chip text-muted border-line-2';
    default:
      return 'bg-sun/30 text-torii-ink border-torii/50';
  }
}

export function WordsPage() {
  const queryClient = useQueryClient();
  const initialSettings = loadWebSettings();

  const [statusFilter, setStatusFilter] = useState<WordStatus | ''>('');
  const [animeId, setAnimeId] = useState<number | null>(null);
  const [episodeId, setEpisodeId] = useState<number | null>(null);
  const [searchText, setSearchText] = useState('');
  const [sortMode, setSortMode] = useState<'' | 'frequency'>('');
  const [offset, setOffset] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const [activeWord, setActiveWord] = useState<WordListItem | null>(null);
  const [glossLang, setGlossLang] = useState<GlossLanguage>(initialSettings.glossLang);
  const [notice, setNotice] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);

  const episodesQuery = useQuery({
    queryKey: ['episodes'],
    queryFn: () => apiClient.listEpisodes(),
    retry: false,
    staleTime: 60_000,
  });

  const animeOptions = extractAnimeOptions(episodesQuery.data ?? []);
  const selectedAnime = animeOptions.find((a) => a.id === animeId) ?? null;

  const wordsQuery = useQuery({
    queryKey: ['words', statusFilter, animeId, episodeId, searchText, sortMode, offset],
    queryFn: () =>
      apiClient.listWords({
        status: statusFilter,
        animeId,
        episodeId,
        q: searchText,
        sort: sortMode,
        limit: PAGE_SIZE,
        offset,
      }),
    retry: false,
  });

  const lookupQuery = useQuery({
    queryKey: ['dict-lookup', activeWord?.id, activeWord?.lemma, activeWord?.reading],
    queryFn: () =>
      apiClient.lookupDictionary(activeWord!.lemma, activeWord!.reading, 5, activeWord!.id),
    enabled: activeWord !== null,
    retry: false,
  });

  const bulkStatusMutation = useMutation({
    mutationFn: ({ ids, status }: { ids: number[]; status: WordStatus }) =>
      apiClient.bulkWordStatus(ids, status),
    onSuccess: (res, vars) => {
      setSelectedIds(new Set());
      setNotice(`Updated ${res.updated} word${res.updated === 1 ? '' : 's'} → ${vars.status}.`);
      void queryClient.invalidateQueries({ queryKey: ['words'] });
      void queryClient.invalidateQueries({ queryKey: ['understanding'] });
    },
  });

  const singleStatusMutation = useMutation({
    mutationFn: ({ wordId, status }: { wordId: number; status: WordStatus }) =>
      apiClient.setWordStatus(wordId, status),
    onSuccess: (updated) => {
      setActiveWord((prev) => (prev && prev.id === updated.id ? { ...prev, status: updated.status } : prev));
      setNotice(`Marked "${updated.lemma}" as ${updated.status}.`);
      void queryClient.invalidateQueries({ queryKey: ['words'] });
      void queryClient.invalidateQueries({ queryKey: ['understanding'] });
    },
  });

  const addCardMutation = useMutation({
    mutationFn: (wordId: number) =>
      apiClient.createCard({ word_id: wordId, line_id: null, media_ids: [] }),
    onSuccess: (created) => {
      setNotice(
        created.created
          ? 'Added card to review queue.'
          : 'Card already exists in review queue.',
      );
      void queryClient.invalidateQueries({ queryKey: ['words'] });
      void queryClient.invalidateQueries({ queryKey: ['reviews-due'] });
    },
  });

  const exportAnkiMutation = useMutation({
    mutationFn: () => apiClient.downloadAnkiApkg({ deck: 'Sensei' }),
    onSuccess: ({ blob, filename }) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setNotice(`Downloaded ${filename}.`);
    },
    onError: (err) => {
      setNotice(
        err instanceof SenseiApiError
          ? err.status === 404
            ? 'No saved cards to export yet.'
            : `Export failed: ${err.message}`
          : 'Export failed.',
      );
    },
  });

  const items = wordsQuery.data?.items ?? [];
  const total = wordsQuery.data?.total ?? 0;
  const visibleIds = items.map((w) => w.id);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const pagination = computePagination(total, PAGE_SIZE, offset);
  const showOccurrences = animeId !== null || episodeId !== null;

  function resetPageAndSelection() {
    setOffset(0);
    setSelectedIds(new Set());
  }

  return (
    <div className="space-y-6">
      <div className="headline flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-ink">Vocabulary</h1>
          <p className="text-sm text-muted mt-1">
            Filter words by status, anime, or episode; search by kanji/reading; and bulk-update
            known words.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {notice && (
            <div className="text-xs px-3 py-1.5 rounded-lg bg-leaf/30 border border-leaf/50 text-leaf-ink">
              {notice}
            </div>
          )}
          <button
            type="button"
            disabled={exportAnkiMutation.isPending}
            onClick={() => exportAnkiMutation.mutate()}
            className="btn px-3.5 py-2 text-xs font-semibold text-ink disabled:opacity-50 transition cursor-pointer"
          >
            {exportAnkiMutation.isPending ? 'Exporting…' : 'Export Anki (.apkg)'}
          </button>
          <button
            type="button"
            onClick={() => setShowImport((v) => !v)}
            className="btn btn-sun px-3.5 py-2 text-xs font-semibold transition cursor-pointer"
          >
            {showImport ? 'Hide Import' : 'Import Anki / Words'}
          </button>
        </div>
      </div>

      {showImport && (
        <ImportWordsPanel
          onImported={(summary) => setNotice(summary)}
          onClose={() => setShowImport(false)}
        />
      )}

      {/* Filters */}
      <div className="card p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {WORD_STATUS_OPTIONS.map((opt) => (
              <button
                key={opt.value || 'all'}
                type="button"
                onClick={() => {
                  setStatusFilter(opt.value);
                  resetPageAndSelection();
                }}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition cursor-pointer ${
                  statusFilter === opt.value
                    ? 'bg-sun/40 border-torii text-torii-ink'
                    : 'bg-field border-line text-muted hover:text-ink'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => {
              setSortMode((prev) => (prev === 'frequency' ? '' : 'frequency'));
              resetPageAndSelection();
            }}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition cursor-pointer ${
              sortMode === 'frequency'
                ? 'bg-plum/40 border-plum text-plum-ink'
                : 'bg-field border-line text-muted hover:text-ink'
            }`}
          >
            {sortMode === 'frequency' ? 'Sorted: Most Useful (Zipf)' : 'Sort by Frequency (Zipf)'}
          </button>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <input
            type="text"
            value={searchText}
            onChange={(e) => {
              setSearchText(e.target.value);
              resetPageAndSelection();
            }}
            placeholder="Search lemma or reading..."
            className="field px-3 py-1.5 text-sm text-ink"
          />

          <select
            value={animeId ?? ''}
            onChange={(e) => {
              const next = e.target.value ? Number(e.target.value) : null;
              setAnimeId(next);
              setEpisodeId(null);
              resetPageAndSelection();
            }}
            className="field px-3 py-1.5 text-sm text-ink"
          >
            <option value="">All Anime (newest first)</option>
            {animeOptions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.title} (most frequent first)
              </option>
            ))}
          </select>

          <select
            value={episodeId ?? ''}
            disabled={!selectedAnime}
            onChange={(e) => {
              setEpisodeId(e.target.value ? Number(e.target.value) : null);
              resetPageAndSelection();
            }}
            className="field px-3 py-1.5 text-sm text-ink disabled:opacity-50"
          >
            <option value="">All Episodes in Anime</option>
            {selectedAnime?.episodes.map((ep) => (
              <option key={ep.id} value={ep.id}>
                {ep.number !== null ? `Ep ${ep.number}` : `Episode #${ep.id}`}
                {ep.title ? ` — ${ep.title}` : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="bg-sun/25 border border-torii/60 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm font-semibold text-torii-ink">
            {selectedIds.size} word{selectedIds.size === 1 ? '' : 's'} selected
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={bulkStatusMutation.isPending}
              onClick={() =>
                bulkStatusMutation.mutate({ ids: Array.from(selectedIds), status: 'known' })
              }
              className="btn btn-leaf px-3 py-1.5 text-xs font-semibold cursor-pointer"
            >
              Mark Known
            </button>
            <button
              type="button"
              disabled={bulkStatusMutation.isPending}
              onClick={() =>
                bulkStatusMutation.mutate({ ids: Array.from(selectedIds), status: 'learning' })
              }
              className="btn btn-gold px-3 py-1.5 text-xs font-semibold cursor-pointer"
            >
              Mark Learning
            </button>
            <button
              type="button"
              disabled={bulkStatusMutation.isPending}
              onClick={() =>
                bulkStatusMutation.mutate({ ids: Array.from(selectedIds), status: 'ignored' })
              }
              className="btn px-3 py-1.5 border border-line-2 text-ink text-xs font-semibold cursor-pointer"
            >
              Mark Ignored
            </button>
            <button
              type="button"
              disabled={bulkStatusMutation.isPending}
              onClick={() =>
                bulkStatusMutation.mutate({ ids: Array.from(selectedIds), status: 'new' })
              }
              className="btn px-3 py-1.5 text-ink-2 text-xs font-semibold cursor-pointer"
            >
              Reset New
            </button>
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="px-2 py-1.5 text-xs text-muted hover:text-ink cursor-pointer"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Main split: table + dictionary inspector */}
      <div className="grid gap-6 lg:grid-cols-[1fr_320px] items-start">
        <div className="card overflow-hidden">
          {wordsQuery.isLoading ? (
            <div className="p-6 text-sm text-muted">Loading vocabulary...</div>
          ) : wordsQuery.isError ? (
            <div className="p-6 text-sm text-rose-ink">
              {wordsQuery.error instanceof SenseiApiError && wordsQuery.error.status === 401 ? (
                <>
                  API token is missing or wrong (401). Update it in{' '}
                  <Link to="/settings" className="underline text-torii-ink">
                    Settings
                  </Link>
                  .
                </>
              ) : (
                <>Failed to load words: {(wordsQuery.error as Error)?.message ?? 'Error'}</>
              )}
            </div>
          ) : items.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted">
              No words match the current filters.
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-line bg-field text-xs text-muted">
                      <th className="py-2.5 pl-4 pr-2 w-9">
                        <input
                          type="checkbox"
                          checked={allVisibleSelected}
                          onChange={() =>
                            setSelectedIds((prev) => toggleAllSelection(prev, visibleIds))
                          }
                          aria-label="Select all visible words"
                          className="rounded border-line-2 bg-field"
                        />
                      </th>
                      <th className="py-2.5 px-3 font-semibold">Word</th>
                      <th className="py-2.5 px-3 font-semibold">Reading</th>
                      <th className="py-2.5 px-3 font-semibold">POS</th>
                      {showOccurrences && (
                        <th className="py-2.5 px-3 font-semibold text-right">Freq</th>
                      )}
                      <th className="py-2.5 pl-3 pr-4 font-semibold text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {items.map((word) => {
                      const isChecked = selectedIds.has(word.id);
                      const isActive = activeWord?.id === word.id;
                      return (
                        <tr
                          key={word.id}
                          onClick={() => setActiveWord(word)}
                          className={`cursor-pointer transition ${
                            isActive
                              ? 'bg-sun/30'
                              : isChecked
                                ? 'bg-chip'
                                : 'hover:bg-chip'
                          }`}
                        >
                          <td
                            className="py-2.5 pl-4 pr-2"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() =>
                                setSelectedIds((prev) => toggleIdSelection(prev, word.id))
                              }
                              aria-label={`Select ${word.lemma}`}
                              className="rounded border-line-2 bg-field"
                            />
                          </td>
                          <td className="py-2.5 px-3 font-semibold text-ink">
                            <span>{word.lemma}</span>
                            {word.common && (
                              <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-sun/30 text-torii-ink font-medium">
                                common
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-ink-2">{word.reading}</td>
                          <td className="py-2.5 px-3 text-xs text-muted">{word.pos}</td>
                          {showOccurrences && (
                            <td className="py-2.5 px-3 text-right font-mono text-xs text-ink-2">
                              {word.occurrences ?? '-'}
                            </td>
                          )}
                          <td className="py-2.5 pl-3 pr-4 text-right">
                            <span
                              className={`inline-block text-xs px-2 py-0.5 rounded border capitalize ${statusBadgeClass(word.status)}`}
                            >
                              {word.status}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="border-t border-line px-4 py-3 flex items-center justify-between text-xs text-muted">
                <span>
                  Showing {pagination.start}–{pagination.end} of {total} words (Page{' '}
                  {pagination.page} / {pagination.totalPages})
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={!pagination.hasPrev}
                    onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
                    className="btn px-3 py-1 disabled:opacity-40 text-ink font-semibold cursor-pointer"
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    disabled={!pagination.hasNext}
                    onClick={() => setOffset((o) => o + PAGE_SIZE)}
                    className="btn px-3 py-1 disabled:opacity-40 text-ink font-semibold cursor-pointer"
                  >
                    Next
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Sticky Dictionary & Quick Action Inspector */}
        <aside className="card p-5 lg:sticky lg:top-20 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted uppercase tracking-wider">
              Word Inspector
            </span>
            <select
              value={glossLang}
              onChange={(e) => setGlossLang(e.target.value as GlossLanguage)}
              className="field px-2 py-1 text-xs text-ink"
            >
              <option value="eng">EN</option>
              <option value="ger">DE</option>
            </select>
          </div>

          {!activeWord ? (
            <p className="text-xs text-faint">
              Click any word in the table to inspect its JMdict EN/DE meanings, update its status,
              or create a review card.
            </p>
          ) : (
            <>
              <div>
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-2xl font-bold text-ink">{activeWord.lemma}</span>
                  {activeWord.reading && activeWord.reading !== activeWord.lemma && (
                    <span className="text-sm text-torii-ink">{activeWord.reading}</span>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-1.5 text-xs">
                  <span className="px-2 py-0.5 rounded bg-chip text-ink-2">
                    {activeWord.pos}
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded border capitalize ${statusBadgeClass(activeWord.status)}`}
                  >
                    {activeWord.status}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  disabled={singleStatusMutation.isPending}
                  onClick={() =>
                    singleStatusMutation.mutate({ wordId: activeWord.id, status: 'known' })
                  }
                  className="btn py-1.5 text-xs font-semibold border border-leaf/60 text-leaf-ink cursor-pointer"
                >
                  Known
                </button>
                <button
                  type="button"
                  disabled={singleStatusMutation.isPending}
                  onClick={() =>
                    singleStatusMutation.mutate({ wordId: activeWord.id, status: 'ignored' })
                  }
                  className="btn py-1.5 text-xs font-semibold text-ink-2 cursor-pointer"
                >
                  Ignore
                </button>
                <button
                  type="button"
                  disabled={addCardMutation.isPending}
                  onClick={() => addCardMutation.mutate(activeWord.id)}
                  className="btn py-1.5 text-xs font-semibold border border-torii/60 text-torii-ink cursor-pointer"
                >
                  + Card
                </button>
              </div>

              <div className="border-t border-line pt-3 space-y-3">
                {lookupQuery.isLoading ? (
                  <div className="text-xs text-muted">Looking up in JMdict...</div>
                ) : lookupQuery.isError ? (
                  <div className="text-xs text-rose-ink">
                    {(lookupQuery.error as Error)?.message ?? 'Dictionary unavailable'}
                  </div>
                ) : lookupQuery.data && lookupQuery.data.entries.length > 0 ? (
                  lookupQuery.data.entries.slice(0, 3).map((entry) => {
                    const { lang, senses } = pickEntrySenses(entry, glossLang);
                    return (
                      <div key={entry.id} className="space-y-1">
                        <div className="flex items-center justify-between text-xs text-muted">
                          <span>
                            {entry.kanji[0] ?? entry.kana[0]} ({entry.kana[0]})
                          </span>
                          <span className="uppercase text-[10px] text-faint">{lang}</span>
                        </div>
                        <ol className="list-decimal list-inside text-sm text-ink space-y-1">
                          {senses.slice(0, 5).map((sense, i) => (
                            <li key={i}>{sense.glosses.join('; ')}</li>
                          ))}
                        </ol>
                      </div>
                    );
                  })
                ) : (
                  <div className="text-xs text-faint">No dictionary entries found.</div>
                )}
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
