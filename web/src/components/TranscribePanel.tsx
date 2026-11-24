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
    queued: 'bg-chip text-ink-2 border-line-2',
    extracting: 'bg-sun/30 text-torii-ink border-torii/60',
    transcribing: 'bg-plum/40 text-plum-ink border-plum/70',
    importing: 'bg-gold/30 text-gold-ink border-gold/60',
    done: 'bg-leaf/40 text-leaf-ink border-leaf/60',
    error: 'bg-rose/40 text-rose-ink border-rose/60',
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
    <section className="bg-paper border border-plum/60 rounded-xl p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-plum-ink">{heading}</h2>
          <p className="text-xs text-muted mt-0.5">
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
            className="btn text-xs px-2.5 py-1 text-ink-2 cursor-pointer"
          >
            Refresh
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="btn text-xs px-2.5 py-1 text-ink-2 cursor-pointer"
            >
              Close
            </button>
          )}
        </div>
      </div>

      {/* Availability status / graceful degradation banner */}
      {!availability.available ? (
        <div className="rounded-lg bg-gold/20 border border-gold/55 px-3.5 py-2.5 text-xs space-y-1">
          <div className="font-semibold text-gold-ink">{availability.headline}</div>
          {availability.hint && <div className="text-gold-ink">{availability.hint}</div>}
        </div>
      ) : (
        <div className="text-xs text-leaf-ink flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full bg-leaf" />
          <span>{availability.headline}</span>
        </div>
      )}

      {/* Upload & Submit Form */}
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3">
        <fieldset disabled={!availability.available || uploading} className="space-y-3 disabled:opacity-55">
          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1">
              Episode Video / Audio File *
            </label>
            {initialFile && file === initialFile ? (
              <div className="field flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs">
                <span className="text-ink truncate">
                  {file.name}{' '}
                  <span className="text-muted">({formatTransferBytes(file.size)})</span>
                </span>
                <label className="text-torii-ink hover:text-torii-ink font-semibold cursor-pointer">
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
                className="block w-full text-xs text-ink-2 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-chip file:text-plum-ink hover:file:bg-chip-2"
              />
            )}
            {file && !initialFile && (
              <div className="text-[11px] text-muted mt-1">
                Selected: {file.name} ({formatTransferBytes(file.size)}) — files up to 4 GB
                supported.
              </div>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className="block text-xs font-medium text-ink-2 mb-1">
                Anime Title *
              </label>
              <input
                type="text"
                required
                value={animeTitle}
                onChange={(e) => setAnimeTitle(e.target.value)}
                placeholder="e.g. Sousou no Frieren"
                className="field w-full px-3 py-1.5 text-sm text-ink focus:border-plum"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-2 mb-1">
                Episode Number
              </label>
              <input
                type="number"
                step="0.5"
                min="0"
                value={episodeNumber}
                onChange={(e) => setEpisodeNumber(e.target.value)}
                placeholder="e.g. 2"
                className="field w-full px-3 py-1.5 text-sm text-ink focus:border-plum"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-2 mb-1">
                Episode Title (optional)
              </label>
              <input
                type="text"
                value={episodeTitle}
                onChange={(e) => setEpisodeTitle(e.target.value)}
                placeholder="Optional"
                className="field w-full px-3 py-1.5 text-sm text-ink focus:border-plum"
              />
            </div>
          </div>
        </fieldset>

        {/* Upload progress bar */}
        {uploading && uploadProgress && (
          <div className="rounded-lg bg-field border border-plum/60 p-3 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-plum-ink">
                Uploading episode file…
                {uploadProgress.percent !== null ? ` ${uploadProgress.percent}%` : ''}
              </span>
              <span className="text-muted">
                {formatTransferBytes(uploadProgress.loaded)}
                {uploadProgress.total > 0 ? ` / ${formatTransferBytes(uploadProgress.total)}` : ''}
              </span>
            </div>
            <div className="h-2 w-full rounded-full bg-chip overflow-hidden">
              <div
                className="h-full bg-plum transition-all duration-150"
                style={{ width: `${uploadProgress.percent ?? 15}%` }}
              />
            </div>
          </div>
        )}

        {submitError && (
          <div className="text-xs px-3 py-2 rounded-lg bg-rose/30 border border-rose/60 text-rose-ink">
            {submitError}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={!availability.available || !file || !animeTitle.trim() || uploading}
            className="btn btn-plum px-4 py-2 disabled:opacity-45 disabled:cursor-not-allowed font-semibold text-sm cursor-pointer"
          >
            {uploading ? 'Uploading…' : 'Transcribe Episode'}
          </button>
          {uploading && (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className="btn px-3 py-2 text-xs font-semibold text-ink cursor-pointer"
            >
              Cancel Upload
            </button>
          )}
        </div>
      </form>

      {/* Active / Focused Job Status Stepper */}
      {focusedJob && (
        <div className="rounded-xl bg-field border border-line p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-ink truncate">
                #{focusedJob.id} · {focusedJob.anime_title}
                {focusedJob.episode_number !== null ? ` Ep ${focusedJob.episode_number}` : ''}
              </div>
              <div className="text-[11px] text-muted truncate">{focusedJob.filename}</div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-muted font-mono">
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
                  ? 'bg-leaf'
                  : visual === 'active'
                    ? 'bg-plum animate-pulse'
                    : visual === 'error'
                      ? 'bg-rose'
                      : 'bg-chip';
              const labelClass =
                visual === 'done'
                  ? 'text-leaf-ink'
                  : visual === 'active'
                    ? 'text-plum-ink font-semibold'
                    : visual === 'error'
                      ? 'text-rose-ink'
                      : 'text-faint';
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
            <div className="text-xs px-3 py-2 rounded-lg bg-rose/30 border border-rose/60 text-rose-ink">
              {focusedJob.error ?? 'Transcription failed.'}
            </div>
          )}

          {focusedJob.status === 'done' && focusedJob.episode_id !== null && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {showAttachButton && onEpisodeReady && (
                <button
                  type="button"
                  onClick={() => onEpisodeReady(focusedJob.episode_id!)}
                  className="btn btn-leaf px-3 py-1.5 font-semibold text-xs cursor-pointer"
                >
                  Attach to Player
                </button>
              )}
              <Link
                to={`/episodes/${focusedJob.episode_id}`}
                className="btn btn-sun px-3 py-1.5 font-semibold text-xs"
              >
                Open Episode Transcript &rarr;
              </Link>
            </div>
          )}
        </div>
      )}

      {/* Recent Transcriptions List */}
      {allJobs.length > 0 && (
        <div className="border-t border-line pt-3 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-ink-2">
              Transcriptions ({allJobs.length})
            </span>
            <span className="text-[11px] text-faint">
              Runs one at a time · clears on server restart
            </span>
          </div>
          <div className="space-y-1.5 max-h-52 overflow-y-auto pr-1">
            {allJobs.map((job) => (
              <div
                key={job.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-field border border-line px-3 py-2 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-ink truncate">
                      {job.anime_title}
                      {job.episode_number !== null ? ` Ep ${job.episode_number}` : ''}
                    </span>
                    <StatusBadge status={job.status} />
                  </div>
                  <div className="text-[11px] text-muted truncate mt-0.5">
                    {job.filename}
                    {formatSttElapsedSummary(job, nowMs)
                      ? ` · ${formatSttElapsedSummary(job, nowMs)}`
                      : ''}
                  </div>
                  {job.status === 'error' && job.error && (
                    <div className="text-[11px] text-rose-ink mt-0.5">{job.error}</div>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {isSttJobActive(job) && activeJobId !== job.id && (
                    <button
                      type="button"
                      onClick={() => setActiveJobId(job.id)}
                      className="btn text-xs px-2 py-1 text-plum-ink cursor-pointer"
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
                          className="btn btn-leaf text-xs px-2.5 py-1 font-semibold cursor-pointer"
                        >
                          Attach
                        </button>
                      )}
                      <Link
                        to={`/episodes/${job.episode_id}`}
                        className="text-xs font-semibold text-torii-ink hover:text-torii-ink"
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
