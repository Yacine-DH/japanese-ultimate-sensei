import { type FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, type EpisodeOut, SenseiApiError } from '../api/client';
import { JimakuImportPanel } from '../components/JimakuImportPanel';
import { TranscribePanel } from '../components/TranscribePanel';
import { computeBarSegments, groupEpisodesByAnime } from '../lib/transcript';
import { emitIsland } from '../scene/bus';

function EpisodeUnderstandingBar({ episodeId }: { episodeId: number }) {
  const { data, isLoading } = useQuery({
    queryKey: ['understanding', episodeId],
    queryFn: () => apiClient.getEpisodeUnderstanding(episodeId),
    retry: false,
    staleTime: 30_000,
  });

  if (isLoading || !data) {
    return (
      <div className="space-y-1.5">
        <div className="h-2 w-full rounded-full bg-chip overflow-hidden" />
        <div className="text-xs text-faint">Calculating understanding...</div>
      </div>
    );
  }

  const { knownPct, learningPct } = computeBarSegments(data);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="font-semibold text-leaf-ink">
          {data.token_pct.toFixed(1)}% understood
        </span>
        <span className="text-muted">
          {data.known_unique}/{data.unique_words} unique words
          {data.learning_unique > 0 ? ` · ${data.learning_unique} learning` : ''}
        </span>
      </div>
      <div className="h-2 w-full rounded-full bg-chip overflow-hidden flex">
        <div
          className="bg-leaf transition-all"
          style={{ width: `${knownPct}%` }}
          title={`Known: ${knownPct}%`}
        />
        <div
          className="bg-gold transition-all"
          style={{ width: `${learningPct}%` }}
          title={`Learning: ${learningPct}%`}
        />
      </div>
    </div>
  );
}

function EpisodeCard({
  episode,
  onDelete,
}: {
  episode: EpisodeOut;
  onDelete: (id: number) => void;
}) {
  return (
    <div className="card p-4 flex flex-col justify-between gap-3 transition">
      <div className="flex items-start justify-between gap-2">
        <Link to={`/episodes/${episode.id}`} className="group flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {episode.number !== null && (
              <span className="text-xs px-2 py-0.5 rounded bg-sun/30 text-torii-ink font-semibold">
                Ep {episode.number}
              </span>
            )}
            <span className="font-semibold text-ink group-hover:text-torii-ink transition truncate">
              {episode.title ?? episode.source_filename ?? `Episode #${episode.id}`}
            </span>
          </div>
          <div className="text-xs text-muted mt-1">
            {episode.line_count} lines · offset {episode.sub_offset_ms} ms
          </div>
        </Link>
        <button
          type="button"
          onClick={() => onDelete(episode.id)}
          className="text-xs text-faint hover:text-rose-ink px-2 py-1 rounded hover:bg-chip cursor-pointer"
          title="Delete episode"
        >
          Delete
        </button>
      </div>

      <EpisodeUnderstandingBar episodeId={episode.id} />

      <div className="flex justify-end">
        <Link
          to={`/episodes/${episode.id}`}
          className="text-xs font-semibold text-torii-ink hover:text-torii-ink"
        >
          Open Transcript &rarr;
        </Link>
      </div>
    </div>
  );
}

export function LibraryPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [showUpload, setShowUpload] = useState(false);
  const [showJimaku, setShowJimaku] = useState(false);
  const [showTranscribe, setShowTranscribe] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [animeTitle, setAnimeTitle] = useState('');
  const [episodeNumber, setEpisodeNumber] = useState('');
  const [episodeTitle, setEpisodeTitle] = useState('');
  const [subtitleFile, setSubtitleFile] = useState<File | null>(null);

  const episodesQuery = useQuery({
    queryKey: ['episodes'],
    queryFn: () => apiClient.listEpisodes(),
    retry: false,
  });

  const uploadMutation = useMutation({
    mutationFn: () => {
      if (!subtitleFile) throw new Error('Please choose a Japanese subtitle file.');
      return apiClient.uploadEpisode({
        subtitle: subtitleFile,
        animeTitle: animeTitle.trim(),
        episodeNumber: episodeNumber.trim() ? Number(episodeNumber) : undefined,
        title: episodeTitle.trim() || undefined,
      });
    },
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ['episodes'] });
      setAnimeTitle('');
      setEpisodeNumber('');
      setEpisodeTitle('');
      setSubtitleFile(null);
      setShowUpload(false);
      navigate(`/episodes/${created.id}`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiClient.deleteEpisode(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['episodes'] });
    },
  });

  function handleUploadSubmit(event: FormEvent) {
    event.preventDefault();
    uploadMutation.mutate();
  }

  function handleDelete(id: number) {
    if (window.confirm('Delete this episode and its parsed transcript?')) {
      deleteMutation.mutate(id);
    }
  }

  const allGroups = groupEpisodesByAnime(episodesQuery.data ?? []);
  const q = searchQuery.trim().toLowerCase();
  const visibleGroups = q
    ? allGroups.filter(
        (g) =>
          g.title.toLowerCase().includes(q) ||
          g.episodes.some(
            (e) =>
              (e.title ?? '').toLowerCase().includes(q) ||
              (e.source_filename ?? '').toLowerCase().includes(q),
          ),
      )
    : allGroups;

  return (
    <div className="space-y-4">
      <div className="headline flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Anime Library</h1>
          <p className="text-sm text-muted mt-1">
            Upload Japanese subtitles, track your % understood per episode, and pre-study
            transcripts.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setShowJimaku((v) => !v);
              setShowUpload(false);
              setShowTranscribe(false);
            }}
            className="btn btn-sun px-4 py-2 font-semibold text-sm cursor-pointer"
          >
            {showJimaku ? 'Close Jimaku Search' : '+ Search Jimaku'}
          </button>
          <button
            type="button"
            onClick={() => {
              setShowUpload((v) => !v);
              setShowJimaku(false);
              setShowTranscribe(false);
            }}
            className="btn px-4 py-2 text-ink font-semibold text-sm cursor-pointer"
          >
            {showUpload ? 'Close Upload' : '+ Upload File'}
          </button>
          <button
            type="button"
            onClick={() => {
              setShowTranscribe((v) => !v);
              setShowJimaku(false);
              setShowUpload(false);
            }}
            className="btn btn-plum px-4 py-2 font-semibold text-sm cursor-pointer"
          >
            {showTranscribe ? 'Close Transcribe' : '+ Transcribe File'}
          </button>
        </div>
      </div>

      {showJimaku && (
        <JimakuImportPanel
          existingEpisodes={episodesQuery.data ?? []}
          onClose={() => setShowJimaku(false)}
        />
      )}

      {showTranscribe ? (
        <TranscribePanel onClose={() => setShowTranscribe(false)} />
      ) : (
        <div className="bg-paper border border-line rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-ink-2">
            <span className="font-semibold text-plum-ink">
              No Japanese subtitles? Transcribe the episode file
            </span>{' '}
            <span className="text-muted">
              — generate a Japanese transcript from video or audio using Whisper.
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              setShowTranscribe(true);
              setShowJimaku(false);
              setShowUpload(false);
            }}
            className="btn px-3 py-1.5 text-plum-ink font-semibold text-xs border border-plum/60 cursor-pointer"
          >
            Open Transcriber
          </button>
        </div>
      )}

      {showUpload && (
        <form
          onSubmit={handleUploadSubmit}
          className="bg-paper border border-torii/60 rounded-xl p-5 space-y-4"
        >
          <div className="text-sm font-semibold text-torii-ink">
            Upload Japanese Subtitle (.srt / .ass / .ssa / .vtt)
          </div>
          <div className="grid gap-4">
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
                className="field w-full px-3 py-2 text-sm text-ink"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-2 mb-1">
                Episode Number
              </label>
              <input
                type="number"
                step="0.5"
                value={episodeNumber}
                onChange={(e) => setEpisodeNumber(e.target.value)}
                placeholder="e.g. 1"
                className="field w-full px-3 py-2 text-sm text-ink"
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
                placeholder="e.g. The Journey's End"
                className="field w-full px-3 py-2 text-sm text-ink"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1">
              Subtitle File *
            </label>
            <input
              type="file"
              required
              accept=".srt,.ass,.ssa,.vtt"
              onChange={(e) => setSubtitleFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm text-ink-2 file:mr-4 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-chip file:text-torii-ink hover:file:bg-chip-2"
            />
          </div>

          {uploadMutation.isError && (
            <div className="text-xs text-rose-ink">
              Upload failed: {(uploadMutation.error as Error)?.message ?? 'Unknown error'}
            </div>
          )}

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={uploadMutation.isPending}
              className="btn btn-sun px-4 py-2 disabled:opacity-50 font-semibold text-sm cursor-pointer"
            >
              {uploadMutation.isPending ? 'Tokenizing & Ingesting...' : 'Upload & Open Transcript'}
            </button>
          </div>
        </form>
      )}

      {episodesQuery.data && episodesQuery.data.length > 0 && (
        <div>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter anime or episodes..."
            className="w-full sm:w-80 rounded-lg bg-paper border border-line px-3.5 py-2 text-sm text-ink placeholder:text-faint focus:outline-none focus:border-torii"
          />
        </div>
      )}

      {episodesQuery.isLoading ? (
        <div className="card p-6 text-sm text-muted">
          Loading episodes...
        </div>
      ) : episodesQuery.isError ? (
        <div
          className={`bg-paper rounded-xl p-6 text-sm ${
            episodesQuery.error instanceof SenseiApiError && episodesQuery.error.status === 401
              ? 'border border-gold/60 text-gold-ink'
              : 'border border-rose/80 text-rose-ink'
          }`}
        >
          {episodesQuery.error instanceof SenseiApiError && episodesQuery.error.status === 401 ? (
            <>
              API token is missing or wrong (401). Set <code>SENSEI_API_TOKEN</code> in{' '}
              <Link to="/settings" className="underline text-torii-ink">
                Settings
              </Link>
              .
            </>
          ) : (
            <>
              Server unreachable: {(episodesQuery.error as Error)?.message ?? 'Error'}. Check your
              Server URL in{' '}
              <Link to="/settings" className="underline text-torii-ink">
                Settings
              </Link>
              .
            </>
          )}
        </div>
      ) : visibleGroups.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-ink-2 font-medium">
            {episodesQuery.data && episodesQuery.data.length > 0
              ? 'No episodes match your filter'
              : 'No episodes uploaded yet'}
          </p>
          <p className="text-xs text-faint mt-1">
            Use &ldquo;+ Upload File&rdquo; to add a Japanese .srt or .ass file.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {visibleGroups.map((group) => (
            <section
              key={group.key}
              className="card p-4 space-y-3"
              onPointerEnter={() =>
                emitIsland({ type: 'floor', animeId: group.episodes[0]?.anime_id ?? null })
              }
            >
              <div className="flex items-baseline justify-between border-b border-line pb-2">
                <h2 className="text-lg font-bold text-ink">{group.title}</h2>
                <span className="text-xs text-faint">
                  {group.episodes.length} episode{group.episodes.length === 1 ? '' : 's'}
                </span>
              </div>
              <div className="grid gap-2">
                {group.episodes.map((ep) => (
                  <EpisodeCard key={ep.id} episode={ep} onDelete={handleDelete} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
