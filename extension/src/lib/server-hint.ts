import type { SessionStorageLike } from './line-cache';
import { isServerUrlConfigured } from './settings';

export const UNCONFIGURED_HINT_SESSION_KEY = 'sensei_unconfigured_server_hint_shown';

export interface UnconfiguredServerHintContent {
  title: string;
  hint: string;
  actionLabel: string;
  fallbackToast: string;
  durationMs: number;
}

export function buildUnconfiguredServerHintContent(): UnconfiguredServerHintContent {
  return {
    title: 'Sensei server not configured',
    hint: 'Open the Sensei popup from your toolbar to set your server URL and token.',
    actionLabel: 'Open popup',
    fallbackToast: 'Click the Sensei extension icon in your toolbar to configure your server.',
    durationMs: 12_000,
  };
}

export function shouldRequestUnconfiguredServerHint(params: {
  hasVideo: boolean;
  serverUrl: string | null | undefined;
  alreadyCheckedInFrame: boolean;
}): boolean {
  if (!params.hasVideo || params.alreadyCheckedInFrame) {
    return false;
  }
  return !isServerUrlConfigured(params.serverUrl ?? '');
}

/**
 * Tracks whether the one-time "server not configured" video-page toast has
 * already been shown in the current browser session. Backed by
 * `browser.storage.session` (with an in-memory fallback when session storage
 * is unavailable, e.g. MV2 Firefox) and serialized so concurrent video tabs
 * cannot both claim the one-time hint.
 */
export class UnconfiguredServerHintTracker {
  private shownInMemory = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly storage: SessionStorageLike | null) {}

  async claimIfEligible(serverUrl: string): Promise<boolean> {
    if (isServerUrlConfigured(serverUrl)) {
      return false;
    }

    let result = false;
    const next = this.queue.then(async () => {
      if (this.shownInMemory) {
        result = false;
        return;
      }

      if (this.storage) {
        try {
          const data = await this.storage.get(UNCONFIGURED_HINT_SESSION_KEY);
          if (data?.[UNCONFIGURED_HINT_SESSION_KEY] === true) {
            this.shownInMemory = true;
            result = false;
            return;
          }
        } catch {
          // Fall back to in-memory tracking if session storage read fails
        }
      }

      this.shownInMemory = true;
      if (this.storage) {
        try {
          await this.storage.set({ [UNCONFIGURED_HINT_SESSION_KEY]: true });
        } catch {
          // Best-effort persistence across service worker restarts
        }
      }
      result = true;
    });

    this.queue = next.catch(() => undefined);
    await next;
    return result;
  }
}
