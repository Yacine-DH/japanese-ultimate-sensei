import type {
  ApiCallResponse,
  EpisodeOut,
  LineOut,
  SyncPoint,
  WordStatus,
} from '../api/client';
import { updateWordStatusesInLines } from './highlight';
import { countTranslatedLines } from './llm';

export interface SessionStorageLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove?(key: string): Promise<void>;
}

const CACHED_LINE_IDS_KEY = 'sensei_cache_line_ids';

export class EpisodeTranscriptCache {
  private readonly episodes = new Map<number, EpisodeOut>();
  private readonly lines = new Map<number, LineOut[]>();
  private readonly inflightEpisodes = new Map<
    number,
    Promise<ApiCallResponse<EpisodeOut>>
  >();
  private readonly inflightLines = new Map<
    number,
    Promise<ApiCallResponse<LineOut[]>>
  >();
  private readonly sessionStorage: SessionStorageLike | null;

  constructor(sessionStorage: SessionStorageLike | null = null) {
    this.sessionStorage = sessionStorage;
  }

  private epKey(episodeId: number): string {
    return `sensei_cache_ep_${episodeId}`;
  }

  private linesKey(episodeId: number): string {
    return `sensei_cache_lines_${episodeId}`;
  }

  private async readCachedLineIds(): Promise<number[]> {
    const ids = new Set<number>(this.lines.keys());
    if (this.sessionStorage) {
      try {
        const stored = await this.sessionStorage.get(CACHED_LINE_IDS_KEY);
        const raw = stored?.[CACHED_LINE_IDS_KEY];
        if (Array.isArray(raw)) {
          for (const item of raw) {
            if (typeof item === 'number' && Number.isInteger(item)) {
              ids.add(item);
            }
          }
        }
      } catch {
        // Ignore session storage errors
      }
    }
    return Array.from(ids);
  }

  private async recordCachedLineId(episodeId: number): Promise<void> {
    if (!this.sessionStorage) return;
    try {
      const ids = await this.readCachedLineIds();
      if (!ids.includes(episodeId)) {
        ids.push(episodeId);
      }
      await this.sessionStorage.set({ [CACHED_LINE_IDS_KEY]: ids });
    } catch {
      // Ignore session storage errors
    }
  }

  private async removeCachedLineId(episodeId: number): Promise<void> {
    if (!this.sessionStorage) return;
    try {
      const ids = (await this.readCachedLineIds()).filter((id) => id !== episodeId);
      await this.sessionStorage.set({ [CACHED_LINE_IDS_KEY]: ids });
    } catch {
      // Ignore session storage errors
    }
  }

  private async readCachedLinesForEpisode(episodeId: number): Promise<LineOut[] | null> {
    const inMemory = this.lines.get(episodeId);
    if (inMemory) {
      return inMemory;
    }
    if (!this.sessionStorage) {
      return null;
    }
    try {
      const key = this.linesKey(episodeId);
      const stored = await this.sessionStorage.get(key);
      const storedLines = stored?.[key] as LineOut[] | undefined;
      if (Array.isArray(storedLines)) {
        this.lines.set(episodeId, storedLines);
        return storedLines;
      }
    } catch {
      // Ignore session storage read errors
    }
    return null;
  }

  async getEpisode(
    episodeId: number,
    fetcher: () => Promise<ApiCallResponse<EpisodeOut>>,
  ): Promise<ApiCallResponse<EpisodeOut>> {
    const cached = this.episodes.get(episodeId);
    if (cached) {
      return { ok: true, status: 200, data: cached };
    }

    if (this.sessionStorage) {
      try {
        const key = this.epKey(episodeId);
        const stored = await this.sessionStorage.get(key);
        const ep = stored?.[key] as EpisodeOut | undefined;
        if (ep && typeof ep.id === 'number') {
          this.episodes.set(episodeId, ep);
          return { ok: true, status: 200, data: ep };
        }
      } catch {
        // Ignore session storage read errors
      }
    }

    const existing = this.inflightEpisodes.get(episodeId);
    if (existing) {
      return existing;
    }

    const promise = fetcher()
      .then(async (res) => {
        if (res.ok && res.data) {
          this.episodes.set(episodeId, res.data);
          if (this.sessionStorage) {
            try {
              await this.sessionStorage.set({ [this.epKey(episodeId)]: res.data });
            } catch {
              // Ignore quota/session errors
            }
          }
        }
        return res;
      })
      .finally(() => {
        this.inflightEpisodes.delete(episodeId);
      });

    this.inflightEpisodes.set(episodeId, promise);
    return promise;
  }

  async getLines(
    episodeId: number,
    fetcher: () => Promise<ApiCallResponse<LineOut[]>>,
  ): Promise<ApiCallResponse<LineOut[]>> {
    const cached = this.lines.get(episodeId);
    if (cached) {
      return { ok: true, status: 200, data: cached };
    }

    if (this.sessionStorage) {
      try {
        const key = this.linesKey(episodeId);
        const stored = await this.sessionStorage.get(key);
        const storedLines = stored?.[key] as LineOut[] | undefined;
        if (Array.isArray(storedLines)) {
          this.lines.set(episodeId, storedLines);
          return { ok: true, status: 200, data: storedLines };
        }
      } catch {
        // Ignore session storage read errors
      }
    }

    const existing = this.inflightLines.get(episodeId);
    if (existing) {
      return existing;
    }

    const promise = fetcher()
      .then(async (res) => {
        if (res.ok && res.data) {
          this.lines.set(episodeId, res.data);
          if (this.sessionStorage) {
            try {
              await this.sessionStorage.set({ [this.linesKey(episodeId)]: res.data });
              await this.recordCachedLineId(episodeId);
            } catch {
              // Ignore quota/session errors
            }
          }
        }
        return res;
      })
      .finally(() => {
        this.inflightLines.delete(episodeId);
      });

    this.inflightLines.set(episodeId, promise);
    return promise;
  }

  async updateWordStatus(wordId: number, status: WordStatus): Promise<void> {
    await this.updateWordStatuses([wordId], status);
  }

  async updateWordStatuses(wordIds: readonly number[], status: WordStatus): Promise<void> {
    const idSet = new Set(wordIds.filter((id) => Number.isInteger(id)));
    if (idSet.size === 0) return;

    const episodeIds = await this.readCachedLineIds();
    for (const epId of episodeIds) {
      const epLines = await this.readCachedLinesForEpisode(epId);
      if (!epLines) continue;
      const updated = updateWordStatusesInLines(epLines, idSet, status);
      if (updated !== epLines) {
        this.lines.set(epId, updated);
        if (this.sessionStorage) {
          try {
            await this.sessionStorage.set({ [this.linesKey(epId)]: updated });
          } catch {
            // Ignore session storage errors
          }
        }
      }
    }
  }

  async invalidateLines(episodeId: number): Promise<void> {
    this.lines.delete(episodeId);
    if (this.sessionStorage?.remove) {
      try {
        await this.sessionStorage.remove(this.linesKey(episodeId));
      } catch {
        // Ignore session storage errors
      }
    }
    await this.removeCachedLineId(episodeId);
  }

  async noteTranslationProgress(episodeId: number, translatedLines: number): Promise<boolean> {
    if (!Number.isFinite(translatedLines) || translatedLines <= 0) {
      return false;
    }
    const cached = await this.readCachedLinesForEpisode(episodeId);
    if (!cached) {
      return false;
    }
    if (countTranslatedLines(cached) < translatedLines) {
      await this.invalidateLines(episodeId);
      return true;
    }
    return false;
  }

  async setEpisode(episode: EpisodeOut): Promise<void> {
    this.episodes.set(episode.id, episode);
    if (this.sessionStorage) {
      try {
        await this.sessionStorage.set({ [this.epKey(episode.id)]: episode });
      } catch {
        // Ignore session storage errors
      }
    }
  }

  async updateEpisodeOffset(episodeId: number, subOffsetMs: number): Promise<void> {
    await this.updateEpisodeSync(episodeId, subOffsetMs);
  }

  async updateEpisodeSync(
    episodeId: number,
    subOffsetMs: number,
    syncPoints?: SyncPoint[],
  ): Promise<void> {
    const patchEpisode = (ep: EpisodeOut): EpisodeOut => ({
      ...ep,
      sub_offset_ms: subOffsetMs,
      ...(syncPoints !== undefined ? { sync_points: syncPoints } : {}),
    });

    const cached = this.episodes.get(episodeId);
    if (cached) {
      await this.setEpisode(patchEpisode(cached));
      return;
    }
    if (this.sessionStorage) {
      try {
        const key = this.epKey(episodeId);
        const stored = await this.sessionStorage.get(key);
        const ep = stored?.[key] as EpisodeOut | undefined;
        if (ep && typeof ep.id === 'number') {
          await this.setEpisode(patchEpisode(ep));
        }
      } catch {
        // Ignore session storage errors
      }
    }
  }

  async invalidateEpisode(episodeId: number): Promise<void> {
    this.episodes.delete(episodeId);
    this.lines.delete(episodeId);
    if (this.sessionStorage?.remove) {
      try {
        await this.sessionStorage.remove(this.epKey(episodeId));
        await this.sessionStorage.remove(this.linesKey(episodeId));
      } catch {
        // Ignore session storage errors
      }
    }
    await this.removeCachedLineId(episodeId);
  }
}

export function shouldLoadTranscriptForFrame(params: {
  hasQualifyingVideo: boolean;
  tabEnabled: boolean;
  episodeId: number | null;
}): boolean {
  return params.hasQualifyingVideo && params.tabEnabled && params.episodeId !== null;
}
