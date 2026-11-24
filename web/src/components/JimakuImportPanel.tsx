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
    <div className="bg-paper border border-torii/60 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-torii-ink">Search Japanese Subtitles on Jimaku.cc</h2>
          <p className="text-xs text-muted mt-0.5">
            Search an anime title, pick the episode number, and import in one click.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="btn text-xs px-2.5 py-1 text-ink-2 cursor-pointer"
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
          className="field flex-1 px-3 py-2 text-sm text-ink"
        />
        <button
          type="submit"
          disabled={searchMutation.isPending}
          className="btn btn-sun px-4 py-2 disabled:opacity-50 font-semibold text-sm cursor-pointer"
        >
          {searchMutation.isPending ? 'Searching...' : 'Search'}
        </button>
      </form>

      {errorMsg && (
        <div className="text-xs px-3 py-2 rounded-lg bg-rose/30 border border-rose/60 text-rose-ink">
          {errorMsg}
        </div>
      )}

      {/* Search results */}
      {entries.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-semibold text-muted">
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
                      ? 'bg-sun/30 border-torii text-ink'
                      : 'bg-field border-line hover:border-line-2 text-ink'
                  }`}
                >
                  <div className="font-semibold text-sm truncate">
                    {entry.english_name || entry.name}
                  </div>
                  <div className="text-xs text-muted truncate mt-0.5">
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
        <div className="border-t border-line pt-4 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-xs font-medium text-ink-2 mb-1">
                2. Episode Number (blank = all files)
              </label>
              <input
                type="number"
                step="0.5"
                min="0"
                value={episodeNumber}
                onChange={(e) => setEpisodeNumber(e.target.value)}
                className="field w-36 px-3 py-1.5 text-sm text-ink"
              />
            </div>
            <button
              type="button"
              disabled={filesMutation.isPending}
              onClick={handleFetchFilesForEpisode}
              className="btn px-3.5 py-1.5 text-xs font-semibold text-ink cursor-pointer"
            >
              {filesMutation.isPending ? 'Loading files...' : 'Find Files'}
            </button>
          </div>

          {files.length > 0 ? (
            <div className="space-y-2">
              <div className="text-xs font-semibold text-muted">
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
                          ? 'opacity-45 cursor-not-allowed bg-field border-line'
                          : dimmed
                            ? checked
                              ? 'opacity-80 cursor-pointer bg-sun/30 border-torii'
                              : 'opacity-65 cursor-pointer bg-field border-line hover:border-line-2'
                            : checked
                              ? 'cursor-pointer bg-sun/30 border-torii'
                              : 'cursor-pointer bg-field border-line hover:border-line-2'
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
                        <div className="font-mono text-ink break-all">{file.name}</div>
                        <div className="flex flex-wrap items-center gap-1.5 mt-1">
                          {file.recommended && (
                            <span className="px-1.5 py-0.5 rounded bg-leaf/40 text-leaf-ink font-semibold">
                              Recommended
                            </span>
                          )}
                          {file.web_source && (
                            <span className="px-1.5 py-0.5 rounded bg-sun/30 text-torii-ink font-semibold">
                              Web
                            </span>
                          )}
                          {file.dual_language && (
                            <span
                              title="Contains non-Japanese lines"
                              className="px-1.5 py-0.5 rounded bg-gold/30 text-gold-ink font-semibold"
                            >
                              JP+EN
                            </span>
                          )}
                          <span className="px-1.5 py-0.5 rounded bg-chip text-muted uppercase">
                            {file.format}
                          </span>
                          <span className="text-faint">{formatJimakuFileSize(file.size)}</span>
                          {warning && <span className="text-gold-ink">· {warning}</span>}
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
                  className="btn btn-sun px-4 py-2 disabled:opacity-50 font-bold text-sm cursor-pointer"
                >
                  {importMutation.isPending
                    ? 'Downloading & Tokenizing...'
                    : 'Import & Open Transcript'}
                </button>
              </div>
            </div>
          ) : !filesMutation.isPending ? (
            <div className="text-xs text-faint">
              No subtitle files found for episode {episodeNumber || '(all)'}. Try clearing the
              episode number to browse all files.
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
