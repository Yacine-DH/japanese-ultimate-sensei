import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../api/client';

export function LibraryPage() {
  const episodesQuery = useQuery({
    queryKey: ['episodes'],
    queryFn: () => apiClient.listEpisodes(),
    retry: false,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Anime Library</h1>
          <p className="text-sm text-slate-400 mt-1">
            Episodes ingested with Japanese subtitles and vocabulary understanding metrics.
          </p>
        </div>
      </div>

      {episodesQuery.isLoading ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 text-sm text-slate-400">
          Loading episodes...
        </div>
      ) : episodesQuery.isError ? (
        <div className="bg-slate-900 border border-rose-900/60 rounded-xl p-6 text-sm text-rose-300">
          Could not load episodes: {(episodesQuery.error as Error)?.message ?? 'Error'}. Check your
          Server URL and API Token in Settings.
        </div>
      ) : episodesQuery.data && episodesQuery.data.length === 0 ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-8 text-center">
          <p className="text-slate-300 font-medium">No episodes uploaded yet</p>
          <p className="text-xs text-slate-500 mt-1">
            Upload a Japanese .srt or .ass subtitle file to start tracking comprehension.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {episodesQuery.data?.map((ep) => (
            <div
              key={ep.id}
              className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-2"
            >
              <div className="flex items-center justify-between">
                <span className="font-semibold text-slate-100">
                  {ep.anime_title ?? 'Untitled Anime'}
                </span>
                {ep.number !== null && (
                  <span className="text-xs px-2 py-0.5 rounded bg-slate-800 text-sky-400 font-medium">
                    Ep {ep.number}
                  </span>
                )}
              </div>
              <div className="text-xs text-slate-400">
                {ep.line_count} subtitle lines · offset {ep.sub_offset_ms} ms
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
