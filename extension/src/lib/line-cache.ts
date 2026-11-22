import type {
  ApiCallResponse,
  EpisodeOut,
  LineOut,
  WordStatus,
} from '../api/client';
import { updateWordStatusInLines } from './highlight';

export interface SessionStorageLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove?(key: string): Promise<void>;
}

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
    for (const [epId, epLines] of this.lines.entries()) {
      const updated = updateWordStatusInLines(epLines, wordId, status);
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
    const cached = this.episodes.get(episodeId);
    if (cached) {
      await this.setEpisode({ ...cached, sub_offset_ms: subOffsetMs });
      return;
    }
    if (this.sessionStorage) {
      try {
        const key = this.epKey(episodeId);
        const stored = await this.sessionStorage.get(key);
        const ep = stored?.[key] as EpisodeOut | undefined;
        if (ep && typeof ep.id === 'number') {
          await this.setEpisode({ ...ep, sub_offset_ms: subOffsetMs });
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
  }
}

export function shouldLoadTranscriptForFrame(params: {
  hasQualifyingVideo: boolean;
  tabEnabled: boolean;
  episodeId: number | null;
}): boolean {
  return params.hasQualifyingVideo && params.tabEnabled && params.episodeId !== null;
}
