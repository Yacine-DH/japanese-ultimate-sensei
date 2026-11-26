import { describe, expect, it } from 'vitest';

import type { SessionStorageLike } from '../src/lib/line-cache';
import {
  buildUnconfiguredServerHintContent,
  shouldRequestUnconfiguredServerHint,
  UNCONFIGURED_HINT_SESSION_KEY,
  UnconfiguredServerHintTracker,
} from '../src/lib/server-hint';

function createMemorySessionStorage(
  initial: Record<string, unknown> = {},
  delayMs = 0,
): { storage: SessionStorageLike; store: Map<string, unknown> } {
  const store = new Map<string, unknown>(Object.entries(initial));
  const wait = () =>
    delayMs > 0 ? new Promise<void>((resolve) => setTimeout(resolve, delayMs)) : Promise.resolve();

  const storage: SessionStorageLike = {
    async get(key: string) {
      await wait();
      return store.has(key) ? { [key]: store.get(key) } : {};
    },
    async set(items) {
      await wait();
      for (const [k, v] of Object.entries(items)) {
        store.set(k, v);
      }
    },
    async remove(key: string) {
      store.delete(key);
    },
  };
  return { storage, store };
}

describe('shouldRequestUnconfiguredServerHint', () => {
  it('returns true only when a video is present, server URL is empty/invalid, and frame has not checked yet', () => {
    expect(
      shouldRequestUnconfiguredServerHint({
        hasVideo: true,
        serverUrl: '',
        alreadyCheckedInFrame: false,
      }),
    ).toBe(true);

    expect(
      shouldRequestUnconfiguredServerHint({
        hasVideo: true,
        serverUrl: 'http://<host>:8000',
        alreadyCheckedInFrame: false,
      }),
    ).toBe(true);

    expect(
      shouldRequestUnconfiguredServerHint({
        hasVideo: false,
        serverUrl: '',
        alreadyCheckedInFrame: false,
      }),
    ).toBe(false);

    expect(
      shouldRequestUnconfiguredServerHint({
        hasVideo: true,
        serverUrl: '',
        alreadyCheckedInFrame: true,
      }),
    ).toBe(false);

    expect(
      shouldRequestUnconfiguredServerHint({
        hasVideo: true,
        serverUrl: 'http://localhost:8000',
        alreadyCheckedInFrame: false,
      }),
    ).toBe(false);
  });
});

describe('UnconfiguredServerHintTracker', () => {
  it('claims once per session and persists to session storage', async () => {
    const { storage, store } = createMemorySessionStorage();
    const tracker = new UnconfiguredServerHintTracker(storage);

    expect(await tracker.claimIfEligible('')).toBe(true);
    expect(store.get(UNCONFIGURED_HINT_SESSION_KEY)).toBe(true);
    expect(await tracker.claimIfEligible('')).toBe(false);

    // Cold service worker restart reads persisted flag from session storage
    const restartedTracker = new UnconfiguredServerHintTracker(storage);
    expect(await restartedTracker.claimIfEligible('')).toBe(false);
  });

  it('does not claim or consume the one-time hint when a server URL is configured', async () => {
    const { storage, store } = createMemorySessionStorage();
    const tracker = new UnconfiguredServerHintTracker(storage);

    expect(await tracker.claimIfEligible('https://sensei.example.com')).toBe(false);
    expect(store.has(UNCONFIGURED_HINT_SESSION_KEY)).toBe(false);

    // If the user later clears the URL in the same session, the hint can still show once
    expect(await tracker.claimIfEligible('')).toBe(true);
    expect(await tracker.claimIfEligible('')).toBe(false);
  });

  it('serializes concurrent claims so two video tabs do not both show the hint', async () => {
    const { storage } = createMemorySessionStorage({}, 10);
    const tracker = new UnconfiguredServerHintTracker(storage);

    const results = await Promise.all([
      tracker.claimIfEligible(''),
      tracker.claimIfEligible(''),
      tracker.claimIfEligible(''),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('falls back to in-memory tracking when session storage is unavailable or throws', async () => {
    const inMemoryOnly = new UnconfiguredServerHintTracker(null);
    expect(await inMemoryOnly.claimIfEligible('')).toBe(true);
    expect(await inMemoryOnly.claimIfEligible('')).toBe(false);

    const brokenStorage: SessionStorageLike = {
      async get() {
        throw new Error('storage disabled');
      },
      async set() {
        throw new Error('storage disabled');
      },
      async remove() {
        throw new Error('storage disabled');
      },
    };
    const tracker = new UnconfiguredServerHintTracker(brokenStorage);
    expect(await tracker.claimIfEligible('')).toBe(true);
    expect(await tracker.claimIfEligible('')).toBe(false);
  });
});

describe('buildUnconfiguredServerHintContent', () => {
  it('points the user to the popup with English copy and a reasonable timeout', () => {
    const content = buildUnconfiguredServerHintContent();
    expect(content.title.toLowerCase()).toContain('server');
    expect(content.hint.toLowerCase()).toContain('popup');
    expect(content.actionLabel).toBeTruthy();
    expect(content.fallbackToast.toLowerCase()).toContain('toolbar');
    expect(content.durationMs).toBeGreaterThanOrEqual(8000);
  });
});
