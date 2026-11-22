import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  apiClient,
  type EpisodeOut,
  type JimakuEntry,
  type JimakuFile,
  SenseiApiError,
} from '../api/client';
import {
  describeJimakuFileWarning,
  findNextImportableFile,
  formatJimakuError,
  formatJimakuFileSize,
  isJimakuFileDimmed,
  pickDefaultJimakuFile,
  suggestNextEpisodeNumber,
} from '../lib/jimaku';

interface JimakuImportPanelProps {
  existingEpisodes: readonly EpisodeOut[];
  onClose: () => void;
}

export function JimakuImportPanel({ existingEpisodes, onClose }: JimakuImportPanelProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<JimakuEntry[]>([]);
  const [selectedEntry, setSelectedEntry] = useState<JimakuEntry | null>(null);
  const [episodeNumber, setEpisodeNumber] = useState<string>('1');
  const [files, setFiles] = useState<JimakuFile[]>([]);
  const [selectedFileName, setSelectedFileName] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const searchMutation = useMutation({
    mutationFn: (q: string) => apiClient.searchJimaku(q),
    onSuccess: (res) => {
      setErrorMsg(null);
      setEntries(res);
      setSelectedEntry(null);
      setFiles([]);
      setSelectedFileName('');
    },
    onError: (err) => {
      const status = err instanceof SenseiApiError ? err.status : undefined;
      setErrorMsg(formatJimakuError(status, err instanceof Error ? err.message : undefined));
    },
  });

  const filesMutation = useMutation({
    mutationFn: ({ entryId, ep }: { entryId: number; ep: number | null }) =>
      apiClient.listJimakuFiles(entryId, ep),
    onSuccess: (res) => {
      setErrorMsg(null);
      setFiles(res);
      const def = pickDefaultJimakuFile(res);
      setSelectedFileName(def?.name ?? '');
    },
    onError: (err) => {
      const status = err instanceof SenseiApiError ? err.status : undefined;
      setErrorMsg(formatJimakuError(status, err instanceof Error ? err.message : undefined));
    },
  });

  const importMutation = useMutation({
    mutationFn: () => {
      if (!selectedEntry || !selectedFileName) {
        throw new Error('Select a subtitle file first.');
      }
      const epNum = episodeNumber.trim() ? Number(episodeNumber) : null;
      return apiClient.importFromJimaku({
        entry_id: selectedEntry.id,
        file_name: selectedFileName,
        episode_number: epNum !== null && Number.isFinite(epNum) ? epNum : null,
      });
    },
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ['episodes'] });
      onClose();
      navigate(`/episodes/${created.id}`);
    },
    onError: (err) => {
      const status = err instanceof SenseiApiError ? err.status : undefined;
      setErrorMsg(formatJimakuError(status, err instanceof Error ? err.message : undefined));
      if (status === 422 && selectedFileName) {
        const nextFile = findNextImportableFile(files, selectedFileName);
        if (nextFile) {
          setSelectedFileName(nextFile.name);
        }
      }
    },
  });

  function handleSearchSubmit(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    searchMutation.mutate(query.trim());
  }

  function handleSelectEntry(entry: JimakuEntry) {
    setSelectedEntry(entry);
    const nextEp = suggestNextEpisodeNumber(entry, existingEpisodes);
    setEpisodeNumber(String(nextEp));
    filesMutation.mutate({ entryId: entry.id, ep: nextEp });
  }

  function handleFetchFilesForEpisode() {
    if (!selectedEntry) return;
    const parsed = episodeNumber.trim() ? Number(episodeNumber) : null;
    filesMutation.mutate({
      entryId: selectedEntry.id,
      ep: parsed !== null && Number.isFinite(parsed) ? parsed : null,
    });
  }

  return (
    <div className="bg-slate-900 border border-sky-500/40 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-sky-300">Search Japanese Subtitles on Jimaku.cc</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Search an anime title, pick the episode number, and import in one click.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-xs px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 cursor-pointer"
        >
          Close
        </button>
      </div>

      {/* Step 1: Search */}
      <form onSubmit={handleSearchSubmit} className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Anime title (e.g. Frieren, 葬送のフリーレン)..."
          required
          className="flex-1 rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-sky-400"
        />
        <button
          type="submit"
          disabled={searchMutation.isPending}
          className="px-4 py-2 rounded-lg bg-sky-400 hover:bg-sky-300 disabled:opacity-50 text-slate-950 font-semibold text-sm cursor-pointer"
        >
          {searchMutation.isPending ? 'Searching...' : 'Search'}
        </button>
      </form>

      {errorMsg && (
        <div className="text-xs px-3 py-2 rounded-lg bg-rose-500/15 border border-rose-500/40 text-rose-300">
          {errorMsg}
        </div>
      )}

      {/* Search results */}
      {entries.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-semibold text-slate-400">
            1. Select Anime ({entries.length} found)
          </div>
          <div className="grid gap-2 sm:grid-cols-2 max-h-56 overflow-y-auto pr-1">
            {entries.map((entry) => {
              const active = selectedEntry?.id === entry.id;
              return (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => handleSelectEntry(entry)}
                  className={`text-left p-3 rounded-lg border transition cursor-pointer ${
                    active
                      ? 'bg-sky-500/15 border-sky-400 text-slate-100'
                      : 'bg-slate-950 border-slate-800 hover:border-slate-700 text-slate-200'
                  }`}
                >
                  <div className="font-semibold text-sm truncate">
                    {entry.english_name || entry.name}
                  </div>
                  <div className="text-xs text-slate-400 truncate mt-0.5">
                    {[entry.japanese_name, entry.english_name ? entry.name : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Step 2 & 3: Episode number + Ranked files */}
      {selectedEntry && (
        <div className="border-t border-slate-800 pt-4 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                2. Episode Number (blank = all files)
              </label>
              <input
                type="number"
                step="0.5"
                min="0"
                value={episodeNumber}
                onChange={(e) => setEpisodeNumber(e.target.value)}
                className="w-36 rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-sky-400"
              />
            </div>
            <button
              type="button"
              disabled={filesMutation.isPending}
              onClick={handleFetchFilesForEpisode}
              className="px-3.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 border border-slate-700 cursor-pointer"
            >
              {filesMutation.isPending ? 'Loading files...' : 'Find Files'}
            </button>
          </div>

          {files.length > 0 ? (
            <div className="space-y-2">
              <div className="text-xs font-semibold text-slate-400">
                3. Pick Subtitle File ({files.length} files)
              </div>
              <div className="space-y-1.5 max-h-60 overflow-y-auto pr-1">
                {files.map((file) => {
                  const warning = describeJimakuFileWarning(file);
                  const disabled = !file.supported;
                  const dimmed = isJimakuFileDimmed(file);
                  const checked = selectedFileName === file.name;
                  return (
                    <label
                      key={file.name}
                      title={warning ?? undefined}
                      className={`flex items-start gap-2.5 p-2.5 rounded-lg border text-xs transition ${
                        disabled
                          ? 'opacity-45 cursor-not-allowed bg-slate-950/60 border-slate-800/70'
                          : dimmed
                            ? checked
                              ? 'opacity-80 cursor-pointer bg-sky-500/15 border-sky-400'
                              : 'opacity-65 cursor-pointer bg-slate-950/70 border-slate-800 hover:border-slate-700'
                            : checked
                              ? 'cursor-pointer bg-sky-500/15 border-sky-400'
                              : 'cursor-pointer bg-slate-950 border-slate-800 hover:border-slate-700'
                      }`}
                    >
                      <input
                        type="radio"
                        name="jimaku-file"
                        disabled={disabled}
                        checked={checked}
                        onChange={() => setSelectedFileName(file.name)}
                        className="mt-0.5"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="font-mono text-slate-200 break-all">{file.name}</div>
                        <div className="flex flex-wrap items-center gap-1.5 mt-1">
                          {file.recommended && (
                            <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-semibold">
                              Recommended
                            </span>
                          )}
                          {file.web_source && (
                            <span className="px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 font-semibold">
                              Web
                            </span>
                          )}
                          {file.dual_language && (
                            <span
                              title="Contains non-Japanese lines"
                              className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 font-semibold"
                            >
                              JP+EN
                            </span>
                          )}
                          <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 uppercase">
                            {file.format}
                          </span>
                          <span className="text-slate-500">{formatJimakuFileSize(file.size)}</span>
                          {warning && <span className="text-amber-400">· {warning}</span>}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>

              <div className="pt-2">
                <button
                  type="button"
                  disabled={!selectedFileName || importMutation.isPending}
                  onClick={() => importMutation.mutate()}
                  className="px-4 py-2 rounded-lg bg-sky-400 hover:bg-sky-300 disabled:opacity-50 text-slate-950 font-bold text-sm cursor-pointer"
                >
                  {importMutation.isPending
                    ? 'Downloading & Tokenizing...'
                    : 'Import & Open Transcript'}
                </button>
              </div>
            </div>
          ) : !filesMutation.isPending ? (
            <div className="text-xs text-slate-500">
              No subtitle files found for episode {episodeNumber || '(all)'}. Try clearing the
              episode number to browse all files.
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
