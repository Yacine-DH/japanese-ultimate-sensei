/** Pages tell the island what happened; the island reacts. No scene running = nobody listens. */
export type IslandEvent =
  | { type: 'reveal' }
  | { type: 'rate'; rating: number }
  | { type: 'graduate' }
  | { type: 'kana'; ok: boolean }
  | { type: 'floor'; animeId: number | null }
  | { type: 'quality' }
  | { type: 'time'; value: number };

type Listener = (event: IslandEvent) => void;

const listeners = new Set<Listener>();

export function emitIsland(event: IslandEvent): void {
  for (const fn of listeners) fn(event);
}

export function onIsland(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
