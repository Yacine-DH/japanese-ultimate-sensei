import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../api/client';
import { overallUnderstanding, type PagodaFloor, pagodaFloors } from '../lib/island';

export interface IslandData {
  state: 'loading' | 'ready' | 'offline';
  due: number;
  streak: number | null;
  knownWords: number;
  understanding: number | null;
  animeCount: number;
  floors: PagodaFloor[];
}

/** Everything the island shows, from the same queries the pages already use. */
export function useIslandData(): IslandData {
  const animeQuery = useQuery({
    queryKey: ['anime-list'],
    queryFn: () => apiClient.listAnime(),
    retry: false,
    staleTime: 30_000,
  });
  const online = animeQuery.isSuccess;
  const activityQuery = useQuery({
    queryKey: ['activity'],
    queryFn: () => apiClient.getActivity(),
    enabled: online,
    retry: false,
    staleTime: 30_000,
  });
  const dueQuery = useQuery({
    // Not the review page's own key: that session must not be reset by a background refetch.
    queryKey: ['reviews-due-count'],
    queryFn: () => apiClient.getDueReviews(1),
    enabled: online,
    retry: false,
    staleTime: 15_000,
  });
  const knownQuery = useQuery({
    queryKey: ['words', 'known-total'],
    queryFn: () => apiClient.listWords({ status: 'known', limit: 1 }),
    enabled: online,
    retry: false,
    staleTime: 30_000,
  });

  const anime = animeQuery.data ?? [];
  return {
    state: animeQuery.isError ? 'offline' : animeQuery.isLoading ? 'loading' : 'ready',
    due: dueQuery.data?.due_total ?? 0,
    streak: activityQuery.data?.current_streak ?? null,
    knownWords: knownQuery.data?.total ?? 0,
    understanding: overallUnderstanding(anime),
    animeCount: anime.length,
    floors: pagodaFloors(anime),
  };
}
