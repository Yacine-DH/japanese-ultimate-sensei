import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, type SttJobOut, type UploadProgressInfo } from '../api/client';
import {
  describeSttAvailability,
  formatSttElapsedSummary,
  formatTransferBytes,
  getSttJobPollInterval,
  getSttListPollInterval,
  getSttStepVisualState,
  isSttJobActive,
  mergeSttJobIntoList,
  parseEpisodeMetadataFromFilename,
  STT_ACCEPT_ATTR,
  STT_PIPELINE_STEPS,
  STT_STEP_LABELS,
} from '../lib/stt';

export interface TranscribePanelProps {
  /** Pre-selected local video/audio file (e.g. opened in the built-in player). */
  initialFile?: File | null;
  /** Optional custom card heading. */
  heading?: string;
  /** Called once when an active transcription finishes with a new episode_id. */
  onEpisodeReady?: (episodeId: number) => void;
  /** Show an "Attach to Player" button on completed jobs. */
  showAttachButton?: boolean;
  /** Optional close button handler. */
  onClose?: () => void;
}

function StatusBadge({ status }: { status: SttJobOut['status'] }) {
  const styles: Record<SttJobOut['status'], string> = {
    queued: 'bg-slate-800 text-slate-300 border-slate-700',
    extracting: 'bg-sky-500/15 text-sky-300 border-sky-500/40',
    transcribing: 'bg-indigo-500/20 text-indigo-300 border-indigo-400/50',
    importing: 'bg-amber-500/15 text-amber-300 border-amber-400/40',
    done: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
    error: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
  };
  return (
    <span
      className={`text-[11px] px-2 py-0.5 rounded-full border font-semibold ${styles[status]}`}
    >
      {STT_STEP_LABELS[status]}
    </span>
  );
}

export function TranscribePanel({
  initialFile = null,
  heading = 'No Japanese subtitles? Transcribe the episode file',
  onEpisodeReady,
  showAttachButton = false,
  onClose,
}: TranscribePanelProps) {
  const queryClient = useQueryClient();

  const [file, setFile] = useState<File | null>(initialFile);
  const [animeTitle, setAnimeTitle] = useState(() =>
    initialFile ? parseEpisodeMetadataFromFilename(initialFile.name).animeTitle : '',
  );
  const [episodeNumber, setEpisodeNumber] = useState(() =>
    initialFile ? parseEpisodeMetadataFromFilename(initialFile.name).episodeNumber : '',
  );
  const [episodeTitle, setEpisodeTitle] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgressInfo | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [activeJobId, setActiveJobId] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const abortRef = useRef<AbortController | null>(null);
  const notifiedDoneIdsRef = useRef(new Set<number>());

  // Keep form in sync if the player switches to a different local file.
  useEffect(() => {
    if (!initialFile) return;
    setFile(initialFile);
    const guessed = parseEpisodeMetadataFromFilename(initialFile.name);
    setAnimeTitle(guessed.animeTitle);
    setEpisodeNumber(guessed.episodeNumber);
  }, [initialFile]);

  const statusQuery = useQuery({
    queryKey: ['stt-status'],
    queryFn: () => apiClient.getSttStatus(),
    staleTime: 30_000,
    retry: false,
  });

  const availability = describeSttAvailability(statusQuery.data, statusQuery.isError);

  const jobsQuery = useQuery({
    queryKey: ['stt-jobs'],
    queryFn: () => apiClient.listSttJobs(),
    retry: false,
    refetchInterval: (query) => getSttListPollInterval(query.state.data),
  });

  const activeJobQuery = useQuery({
    queryKey: ['stt-job', activeJobId],
    queryFn: () => apiClient.getSttJob(activeJobId!),
    enabled: activeJobId !== null,
    retry: false,
    refetchInterval: (query) => getSttJobPollInterval(query.state.data),
  });

  const allJobs = useMemo(() => {
    const base = jobsQuery.data ?? [];
    return activeJobQuery.data ? mergeSttJobIntoList(base, activeJobQuery.data) : base;
  }, [jobsQuery.data, activeJobQuery.data]);

  // Auto-focus an already-running server job if none is selected yet.
  useEffect(() => {
    if (activeJobId !== null) return;
    const running = (jobsQuery.data ?? []).find((j) => isSttJobActive(j));
    if (running) {
      setActiveJobId(running.id);
    }
  }, [activeJobId, jobsQuery.data]);

  const focusedJob = useMemo(() => {
    if (activeJobId !== null) {
      return activeJobQuery.data ?? allJobs.find((j) => j.id === activeJobId) ?? null;
    }
    return allJobs.find((j) => isSttJobActive(j)) ?? null;
  }, [activeJobId, activeJobQuery.data, allJobs]);

  const hasAnyActiveJob = useMemo(
    () => isSttJobActive(focusedJob) || allJobs.some((j) => isSttJobActive(j)),
    [focusedJob, allJobs],
  );

  // Live 1-second timer for elapsed time while any job is running.
  useEffect(() => {
    if (!hasAnyActiveJob) return;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [hasAnyActiveJob]);

  // Refresh episodes list (and optionally attach in PlayerPage) once a job finishes.
  useEffect(() => {
    const job = activeJobQuery.data;
    if (!job || job.status !== 'done' || job.episode_id === null) return;
    if (notifiedDoneIdsRef.current.has(job.id)) return;
    notifiedDoneIdsRef.current.add(job.id);
    void queryClient.invalidateQueries({ queryKey: ['episodes'] });
    void queryClient.invalidateQueries({ queryKey: ['stt-jobs'] });
    onEpisodeReady?.(job.episode_id);
  }, [activeJobQuery.data, queryClient, onEpisodeReady]);

  // Abort any in-flight upload on unmount.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  function handleFileChange(nextFile: File | null): void {
    setFile(nextFile);
    setSubmitError(null);
    if (!nextFile) return;
    const guessed = parseEpisodeMetadataFromFilename(nextFile.name);
    if (guessed.animeTitle) {
      setAnimeTitle(guessed.animeTitle);
    }
    if (guessed.episodeNumber) {
      setEpisodeNumber(guessed.episodeNumber);
    }
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!availability.available || !file || !animeTitle.trim() || uploading) return;

    setSubmitError(null);
    setUploading(true);
    setUploadProgress({ loaded: 0, total: file.size, percent: 0 });
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const epNum = episodeNumber.trim() ? Number(episodeNumber) : null;
      const created = await apiClient.submitSttJob({
        file,
        animeTitle: animeTitle.trim(),
        episodeNumber: epNum !== null && Number.isFinite(epNum) ? epNum : null,
        title: episodeTitle.trim() || null,
        onProgress: (info) => setUploadProgress(info),
        signal: controller.signal,
      });

      setActiveJobId(created.id);
      queryClient.setQueryData(['stt-job', created.id], created);
      queryClient.setQueryData<SttJobOut[]>(['stt-jobs'], (prev) =>
        mergeSttJobIntoList(prev ?? [], created),
      );
      setEpisodeTitle('');
      if (!initialFile) {
        setFile(null);
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to start transcription.');
    } finally {
      abortRef.current = null;
      setUploading(false);
      setUploadProgress(null);
    }
  }

  return (
    <section className="bg-slate-900 border border-indigo-500/40 rounded-xl p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-indigo-300">{heading}</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Upload a video or audio file to generate Japanese subtitles via Whisper and import it
            straight into your library.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              void statusQuery.refetch();
              void jobsQuery.refetch();
            }}
            className="text-xs px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 cursor-pointer"
          >
            Refresh
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="text-xs px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 cursor-pointer"
            >
              Close
            </button>
          )}
        </div>
      </div>

      {/* Availability status / graceful degradation banner */}
      {!availability.available ? (
        <div className="rounded-lg bg-amber-500/10 border border-amber-500/35 px-3.5 py-2.5 text-xs space-y-1">
          <div className="font-semibold text-amber-200">{availability.headline}</div>
          {availability.hint && <div className="text-amber-300/85">{availability.hint}</div>}
        </div>
      ) : (
        <div className="text-xs text-emerald-400 flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
          <span>{availability.headline}</span>
        </div>
      )}

      {/* Upload & Submit Form */}
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3">
        <fieldset disabled={!availability.available || uploading} className="space-y-3 disabled:opacity-55">
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Episode Video / Audio File *
            </label>
            {initialFile && file === initialFile ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-xs">
                <span className="text-slate-200 truncate">
                  {file.name}{' '}
                  <span className="text-slate-400">({formatTransferBytes(file.size)})</span>
                </span>
                <label className="text-sky-400 hover:text-sky-300 font-semibold cursor-pointer">
                  Choose another
                  <input
                    type="file"
                    accept={STT_ACCEPT_ATTR}
                    className="hidden"
                    onChange={(e) => handleFileChange(e.target.files?.[0] ?? null)}
                  />
                </label>
              </div>
            ) : (
              <input
                type="file"
                accept={STT_ACCEPT_ATTR}
                onChange={(e) => handleFileChange(e.target.files?.[0] ?? null)}
                className="block w-full text-xs text-slate-300 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-slate-800 file:text-indigo-300 hover:file:bg-slate-700"
              />
            )}
            {file && !initialFile && (
              <div className="text-[11px] text-slate-400 mt-1">
                Selected: {file.name} ({formatTransferBytes(file.size)}) — files up to 4 GB
                supported.
              </div>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Anime Title *
              </label>
              <input
                type="text"
                required
                value={animeTitle}
                onChange={(e) => setAnimeTitle(e.target.value)}
                placeholder="e.g. Sousou no Frieren"
                className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-indigo-400"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Episode Number
              </label>
              <input
                type="number"
                step="0.5"
                min="0"
                value={episodeNumber}
                onChange={(e) => setEpisodeNumber(e.target.value)}
                placeholder="e.g. 2"
                className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-indigo-400"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Episode Title (optional)
              </label>
              <input
                type="text"
                value={episodeTitle}
                onChange={(e) => setEpisodeTitle(e.target.value)}
                placeholder="Optional"
                className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-indigo-400"
              />
            </div>
          </div>
        </fieldset>

        {/* Upload progress bar */}
        {uploading && uploadProgress && (
          <div className="rounded-lg bg-slate-950 border border-indigo-500/40 p-3 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-indigo-200">
                Uploading episode file…
                {uploadProgress.percent !== null ? ` ${uploadProgress.percent}%` : ''}
              </span>
              <span className="text-slate-400">
                {formatTransferBytes(uploadProgress.loaded)}
                {uploadProgress.total > 0 ? ` / ${formatTransferBytes(uploadProgress.total)}` : ''}
              </span>
            </div>
            <div className="h-2 w-full rounded-full bg-slate-800 overflow-hidden">
              <div
                className="h-full bg-indigo-400 transition-all duration-150"
                style={{ width: `${uploadProgress.percent ?? 15}%` }}
              />
            </div>
          </div>
        )}

        {submitError && (
          <div className="text-xs px-3 py-2 rounded-lg bg-rose-500/15 border border-rose-500/40 text-rose-300">
            {submitError}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={!availability.available || !file || !animeTitle.trim() || uploading}
            className="px-4 py-2 rounded-lg bg-indigo-400 hover:bg-indigo-300 disabled:opacity-45 disabled:cursor-not-allowed text-slate-950 font-semibold text-sm cursor-pointer"
          >
            {uploading ? 'Uploading…' : 'Transcribe Episode'}
          </button>
          {uploading && (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 border border-slate-700 cursor-pointer"
            >
              Cancel Upload
            </button>
          )}
        </div>
      </form>

      {/* Active / Focused Job Status Stepper */}
      {focusedJob && (
        <div className="rounded-xl bg-slate-950/90 border border-slate-800 p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-slate-100 truncate">
                #{focusedJob.id} · {focusedJob.anime_title}
                {focusedJob.episode_number !== null ? ` Ep ${focusedJob.episode_number}` : ''}
              </div>
              <div className="text-[11px] text-slate-400 truncate">{focusedJob.filename}</div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-slate-400 font-mono">
                {formatSttElapsedSummary(focusedJob, nowMs)}
              </span>
              <StatusBadge status={focusedJob.status} />
            </div>
          </div>

          <div className="grid grid-cols-5 gap-1.5">
            {STT_PIPELINE_STEPS.map((step) => {
              const visual = getSttStepVisualState(step, focusedJob.status);
              const barClass =
                visual === 'done'
                  ? 'bg-emerald-500'
                  : visual === 'active'
                    ? 'bg-indigo-400 animate-pulse'
                    : visual === 'error'
                      ? 'bg-rose-500'
                      : 'bg-slate-800';
              const labelClass =
                visual === 'done'
                  ? 'text-emerald-300'
                  : visual === 'active'
                    ? 'text-indigo-200 font-semibold'
                    : visual === 'error'
                      ? 'text-rose-300'
                      : 'text-slate-500';
              return (
                <div key={step} className="space-y-1">
                  <div className={`h-1.5 rounded-full ${barClass}`} />
                  <div className={`text-[10px] truncate ${labelClass}`}>
                    {STT_STEP_LABELS[step]}
                  </div>
                </div>
              );
            })}
          </div>

          {focusedJob.status === 'error' && (
            <div className="text-xs px-3 py-2 rounded-lg bg-rose-500/15 border border-rose-500/40 text-rose-300">
              {focusedJob.error ?? 'Transcription failed.'}
            </div>
          )}

          {focusedJob.status === 'done' && focusedJob.episode_id !== null && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {showAttachButton && onEpisodeReady && (
                <button
                  type="button"
                  onClick={() => onEpisodeReady(focusedJob.episode_id!)}
                  className="px-3 py-1.5 rounded-lg bg-emerald-400 hover:bg-emerald-300 text-slate-950 font-semibold text-xs cursor-pointer"
                >
                  Attach to Player
                </button>
              )}
              <Link
                to={`/episodes/${focusedJob.episode_id}`}
                className="px-3 py-1.5 rounded-lg bg-sky-400 hover:bg-sky-300 text-slate-950 font-semibold text-xs"
              >
                Open Episode Transcript &rarr;
              </Link>
            </div>
          )}
        </div>
      )}

      {/* Recent Transcriptions List */}
      {allJobs.length > 0 && (
        <div className="border-t border-slate-800 pt-3 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-slate-300">
              Transcriptions ({allJobs.length})
            </span>
            <span className="text-[11px] text-slate-500">
              Runs one at a time · clears on server restart
            </span>
          </div>
          <div className="space-y-1.5 max-h-52 overflow-y-auto pr-1">
            {allJobs.map((job) => (
              <div
                key={job.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-950/70 border border-slate-800 px-3 py-2 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-slate-200 truncate">
                      {job.anime_title}
                      {job.episode_number !== null ? ` Ep ${job.episode_number}` : ''}
                    </span>
                    <StatusBadge status={job.status} />
                  </div>
                  <div className="text-[11px] text-slate-400 truncate mt-0.5">
                    {job.filename}
                    {formatSttElapsedSummary(job, nowMs)
                      ? ` · ${formatSttElapsedSummary(job, nowMs)}`
                      : ''}
                  </div>
                  {job.status === 'error' && job.error && (
                    <div className="text-[11px] text-rose-400 mt-0.5">{job.error}</div>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {isSttJobActive(job) && activeJobId !== job.id && (
                    <button
                      type="button"
                      onClick={() => setActiveJobId(job.id)}
                      className="text-xs px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-indigo-300 cursor-pointer"
                    >
                      Track
                    </button>
                  )}
                  {job.status === 'done' && job.episode_id !== null && (
                    <>
                      {showAttachButton && onEpisodeReady && (
                        <button
                          type="button"
                          onClick={() => onEpisodeReady(job.episode_id!)}
                          className="text-xs px-2.5 py-1 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-200 hover:bg-emerald-500/30 font-semibold cursor-pointer"
                        >
                          Attach
                        </button>
                      )}
                      <Link
                        to={`/episodes/${job.episode_id}`}
                        className="text-xs font-semibold text-sky-400 hover:text-sky-300"
                      >
                        Open &rarr;
                      </Link>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
