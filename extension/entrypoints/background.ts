import {
  type AnkiFlushQueueResponse,
  type AnkiModel,
  type AnkiNotePayload,
  type AnkiPushCardResponse,
  type AnkiTestResponse,
  type AutoAttachNoticeMessage,
  type AutoImport,
  type AutoImportOut,
  type CaptureVisibleTabResponse,
  type EpisodeOut,
  type EpisodeSyncUpdatedMessage,
  executeApiCall,
  executeMediaUpload,
  executeSubtitleUpload,
  executeSyncEpisode,
  type ImportReport,
  isAnkiFlushQueueMessage,
  isAnkiImportDeckMessage,
  isAnkiPushCardMessage,
  isAnkiTestMessage,
  isApiCallMessage,
  isCaptureVisibleTabMessage,
  isConsumeAutoAttachNoticeMessage,
  isConsumeManualSearchFlagMessage,
  isGetNativeUpdateStateMessage,
  isGetTabStateMessage,
  isOpenPopupSearchMessage,
  isSetTabStateMessage,
  isStartNativeUpdateMessage,
  isSyncEpisodeMessage,
  isTriggerAutoAttachMessage,
  isUploadMediaMessage,
  isUploadSubtitleMessage,
  type LineOut,
  markAsBackgroundContext,
  type NativeUpdateStateChangedMessage,
  type NativeUpdateStateResponse,
  type OpenPopupSearchResponse,
  type SyncPoint,
  type TabEpisodeState,
  type TabStateChangedMessage,
  type TriggerAutoAttachResponse,
  type WordOut,
  type WordStatus,
} from '../src/api/client';
import {
  AnkiPushQueue,
  importDeckFromAnkiConnect,
  type LocalStorageLike,
  pushCardToAnki,
  testAnkiConnect,
} from '../src/lib/anki-connect';
import {
  advanceTabTitleWatch,
  type AutoAttachNotice,
  decideAutoAttach,
  extractSeriesPrefixPattern,
  formatAutoAttachFailureNotice,
  formatAutoAttachSuccessToast,
  removeMappingsForDetach,
  type TabTitleWatchState,
} from '../src/lib/auto-attach';
import { EpisodeTranscriptCache, type SessionStorageLike } from '../src/lib/line-cache';
import { BackgroundNativeUpdater, type PopupUpdateUiState } from '../src/lib/native-updater';
import { getSettings, isServerUrlConfigured, saveSettings } from '../src/lib/settings';
import { normalizePageUrlPattern } from '../src/lib/url-mapping';

interface TabOverride {
  pattern: string | null;
  episodeId: number | null;
  enabled: boolean;
}

interface PendingNoticeEntry {
  pattern: string;
  notice: AutoAttachNotice;
  createdAt: number;
}

const NOTICE_TTL_MS = 30_000;
const MANUAL_SEARCH_FLAG_TTL_MS = 30_000;

function getSessionStorage(): SessionStorageLike | null {
  const g = globalThis as unknown as {
    browser?: { storage?: { session?: SessionStorageLike } };
    chrome?: { storage?: { session?: SessionStorageLike } };
  };
  return g.browser?.storage?.session ?? g.chrome?.storage?.session ?? null;
}

function getLocalStorage(): LocalStorageLike | null {
  const g = globalThis as unknown as {
    browser?: { storage?: { local?: LocalStorageLike } };
    chrome?: { storage?: { local?: LocalStorageLike } };
  };
  return g.browser?.storage?.local ?? g.chrome?.storage?.local ?? null;
}

async function tryOpenActionPopup(): Promise<boolean> {
  const g = globalThis as unknown as {
    browser?: {
      action?: { openPopup?: () => Promise<void> };
      browserAction?: { openPopup?: () => Promise<void> };
    };
    chrome?: {
      action?: { openPopup?: () => Promise<void> };
      browserAction?: { openPopup?: () => Promise<void> };
    };
  };
  const openPopup =
    g.browser?.action?.openPopup ??
    g.browser?.browserAction?.openPopup ??
    g.chrome?.action?.openPopup ??
    g.chrome?.browserAction?.openPopup;
  if (typeof openPopup !== 'function') {
    return false;
  }
  try {
    await openPopup();
    return true;
  } catch {
    return false;
  }
}

export default defineBackground(() => {
  markAsBackgroundContext();

  const tabOverrides = new Map<number, TabOverride>();
  const lastTabPattern = new Map<number, string | null>();
  const tabTitleWatch = new Map<number, TabTitleWatchState>();
  const inFlightAutoAttach = new Map<string, Promise<TriggerAutoAttachResponse>>();
  const attemptedAutoAttach = new Map<number, string>();
  const pendingNotices = new Map<number, PendingNoticeEntry>();
  const manualSearchTabs = new Map<number, number>();
  const transcriptCache = new EpisodeTranscriptCache(getSessionStorage());
  const ankiQueue = new AnkiPushQueue(getLocalStorage());

  async function broadcastNativeUpdateState(state: PopupUpdateUiState): Promise<void> {
    try {
      await browser.runtime.sendMessage({
        type: 'SENSEI_NATIVE_UPDATE_STATE_CHANGED',
        state,
      } satisfies NativeUpdateStateChangedMessage);
    } catch {
      // Popup is closed or no extension page is listening
    }
  }

  async function broadcastEpisodeSyncUpdated(
    episodeId: number,
    subOffsetMs: number,
    syncPoints: SyncPoint[],
  ): Promise<void> {
    try {
      await browser.runtime.sendMessage({
        type: 'SENSEI_EPISODE_SYNC_UPDATED',
        episodeId,
        subOffsetMs,
        syncPoints,
      } satisfies EpisodeSyncUpdatedMessage);
    } catch {
      // Popup is closed or no extension page is listening
    }
  }

  const nativeUpdater = new BackgroundNativeUpdater({
    onStateChange: (state) => {
      void broadcastNativeUpdateState(state);
    },
  });

  async function flushAnkiQueueNow(): Promise<AnkiFlushQueueResponse> {
    const settings = await getSettings();
    return ankiQueue.flush({
      settings,
      fetchCardNote: (cardId, deck) =>
        executeApiCall<AnkiNotePayload>(
          settings,
          `/cards/${cardId}/anki-note?${new URLSearchParams({ deck }).toString()}`,
        ),
      fetchAnkiModel: () => executeApiCall<AnkiModel>(settings, '/anki/model'),
    });
  }

  // Opportunistically retry queued Anki cards when the background worker starts & periodically.
  void flushAnkiQueueNow();
  setInterval(() => {
    void ankiQueue.list().then((items) => {
      if (items.length > 0) {
        void flushAnkiQueueNow();
      }
    });
  }, 60_000);

  function getActiveNotice(tabId: number | null, pattern: string | null): AutoAttachNotice | null {
    if (tabId === null || !pattern) return null;
    const entry = pendingNotices.get(tabId);
    if (!entry) return null;
    if (entry.pattern !== pattern || Date.now() - entry.createdAt > NOTICE_TTL_MS) {
      pendingNotices.delete(tabId);
      return null;
    }
    return entry.notice;
  }

  async function resolveTabState(
    tabId: number | null,
    pageUrl: string,
  ): Promise<TabEpisodeState> {
    const settings = await getSettings();
    const pattern = normalizePageUrlPattern(pageUrl);
    const mappedEpisodeId = pattern ? (settings.urlMappings[pattern] ?? null) : null;
    const rawOverride = tabId !== null ? tabOverrides.get(tabId) : undefined;
    const override = rawOverride && rawOverride.pattern === pattern ? rawOverride : undefined;
    if (rawOverride && rawOverride.pattern !== pattern && tabId !== null) {
      tabOverrides.delete(tabId);
    }

    const autoKey = tabId !== null && pattern ? `${tabId}:${pattern}` : null;
    const isLoadingAuto = autoKey !== null && inFlightAutoAttach.has(autoKey);
    const activeNotice = getActiveNotice(tabId, pattern);

    if (override) {
      const episodeId = override.episodeId ?? mappedEpisodeId;
      return {
        tabId,
        pageUrl,
        pattern,
        episodeId,
        enabled: override.enabled && episodeId !== null,
        autoAttachStatus: isLoadingAuto ? 'loading' : 'idle',
        autoAttachNotice: activeNotice,
      };
    }

    return {
      tabId,
      pageUrl,
      pattern,
      episodeId: mappedEpisodeId,
      enabled: mappedEpisodeId !== null,
      autoAttachStatus: isLoadingAuto
        ? 'loading'
        : activeNotice?.kind === 'attached'
          ? 'attached'
          : activeNotice?.kind === 'error'
            ? 'error'
            : 'idle',
      autoAttachNotice: activeNotice,
    };
  }

  async function notifyTabState(tabId: number, state: TabEpisodeState): Promise<void> {
    try {
      await browser.tabs.sendMessage(tabId, {
        type: 'SENSEI_TAB_STATE_CHANGED',
        state,
      } satisfies TabStateChangedMessage);
    } catch {
      // Content script might not be loaded on non-web tabs or not booted yet
    }
  }

  async function notifyTabAutoAttachNotice(
    tabId: number,
    notice: AutoAttachNotice,
  ): Promise<void> {
    try {
      await browser.tabs.sendMessage(tabId, {
        type: 'SENSEI_AUTO_ATTACH_NOTICE',
        notice,
      } satisfies AutoAttachNoticeMessage);
    } catch {
      // Content script will pick it up via getTabState() once mounted
    }
  }

  async function rememberEpisodeMappings(
    pageUrl: string,
    episodeId: number,
    explicitAnimeId?: number | null,
  ): Promise<void> {
    const pattern = normalizePageUrlPattern(pageUrl);
    const prefixPattern = extractSeriesPrefixPattern(pageUrl);
    if (!pattern && !prefixPattern) return;

    let animeId =
      typeof explicitAnimeId === 'number' && Number.isFinite(explicitAnimeId)
        ? explicitAnimeId
        : null;

    if (prefixPattern && animeId === null) {
      const epRes = await transcriptCache.getEpisode(episodeId, async () => {
        const s = await getSettings();
        return executeApiCall<EpisodeOut>(s, `/episodes/${episodeId}`);
      });
      if (epRes.ok && epRes.data && typeof epRes.data.anime_id === 'number') {
        animeId = epRes.data.anime_id;
      }
    }

    const latest = await getSettings();
    const patch: Partial<typeof latest> = {};
    if (pattern) {
      patch.urlMappings = { ...latest.urlMappings, [pattern]: episodeId };
    }
    if (prefixPattern && animeId !== null) {
      patch.animeMappings = { ...latest.animeMappings, [prefixPattern]: animeId };
    }
    if (patch.urlMappings || patch.animeMappings) {
      await saveSettings(patch);
    }
  }

  async function runAutoAttachForTab(
    tabId: number,
    pageUrl: string,
    pageTitle: string,
    forceRetry = false,
  ): Promise<TriggerAutoAttachResponse> {
    const settings = await getSettings();
    if (!isServerUrlConfigured(settings.serverUrl)) {
      return { status: 'skipped' };
    }

    const pattern = normalizePageUrlPattern(pageUrl);
    if (!pattern) {
      return { status: 'skipped' };
    }

    const existingOverride = tabOverrides.get(tabId);
    if (existingOverride && existingOverride.pattern === pattern) {
      return { status: 'skipped' };
    }

    const decision = decideAutoAttach({
      pageUrl,
      pageTitle,
      urlMappings: settings.urlMappings,
      animeMappings: settings.animeMappings,
      isTabAttached: false,
    });
    if (decision.mode !== 'auto') {
      return { status: 'skipped' };
    }

    const key = `${tabId}:${decision.pattern}`;
    const existingFlight = inFlightAutoAttach.get(key);
    if (existingFlight) {
      return existingFlight;
    }

    if (!forceRetry && attemptedAutoAttach.get(tabId) === decision.pattern) {
      return { status: 'skipped' };
    }

    const task = (async (): Promise<TriggerAutoAttachResponse> => {
      attemptedAutoAttach.set(tabId, decision.pattern);

      const res = await executeApiCall<AutoImportOut>(settings, '/episodes/auto', {
        method: 'POST',
        json: {
          anime_id: decision.animeId,
          episode_number: decision.episodeNumber,
        } satisfies AutoImport,
      });

      // Respect any manual action taken by the user while /episodes/auto was in flight.
      const overrideNow = tabOverrides.get(tabId);
      if (overrideNow && overrideNow.pattern === decision.pattern) {
        return { status: 'skipped' };
      }

      if (res.ok && res.data) {
        const { episode } = res.data;
        await transcriptCache.setEpisode(episode);
        await rememberEpisodeMappings(
          pageUrl,
          episode.id,
          episode.anime_id ?? decision.animeId,
        );

        // Verify the tab is still on this episode page before pushing UI state/toast.
        const currentTab = await browser.tabs.get(tabId).catch(() => null);
        const currentPattern = currentTab?.url ? normalizePageUrlPattern(currentTab.url) : null;
        if (currentTab && currentPattern && currentPattern !== decision.pattern) {
          return { status: 'attached', episode };
        }

        const notice: AutoAttachNotice = {
          id: `auto-ok-${tabId}-${episode.id}-${Date.now()}`,
          kind: 'attached',
          title: formatAutoAttachSuccessToast(res.data),
        };
        pendingNotices.set(tabId, {
          pattern: decision.pattern,
          notice,
          createdAt: Date.now(),
        });

        const state: TabEpisodeState = {
          tabId,
          pageUrl,
          pattern: decision.pattern,
          episodeId: episode.id,
          enabled: true,
          autoAttachStatus: 'attached',
          autoAttachNotice: notice,
        };
        await notifyTabState(tabId, state);
        return { status: 'attached', episode };
      }

      // Show actionable failure toast (e.g. 404 detail + "Search manually") if still on this page.
      if (res.status === 404 || res.status === 422 || res.status === 502 || res.status === 503) {
        const currentTab = await browser.tabs.get(tabId).catch(() => null);
        const currentPattern = currentTab?.url ? normalizePageUrlPattern(currentTab.url) : null;
        if (!currentTab || !currentPattern || currentPattern === decision.pattern) {
          const failure = formatAutoAttachFailureNotice(res.status, res.error);
          const notice: AutoAttachNotice = {
            id: `auto-err-${tabId}-${Date.now()}`,
            kind: 'error',
            title: failure.title,
            hint: failure.hint,
            actionLabel: failure.actionLabel,
          };
          pendingNotices.set(tabId, {
            pattern: decision.pattern,
            notice,
            createdAt: Date.now(),
          });
          await notifyTabAutoAttachNotice(tabId, notice);
        }
      }

      return {
        status: 'error',
        error: res.error,
        httpStatus: res.status,
      };
    })();

    inFlightAutoAttach.set(key, task);
    try {
      return await task;
    } finally {
      inFlightAutoAttach.delete(key);
    }
  }

  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const currentUrl = changeInfo.url ?? tab.url ?? '';
    const pattern = normalizePageUrlPattern(currentUrl);
    const prevPattern = lastTabPattern.get(tabId) ?? null;

    if (changeInfo.url) {
      if (pattern !== prevPattern) {
        lastTabPattern.set(tabId, pattern);
        const prevOverride = tabOverrides.get(tabId);
        if (prevOverride && prevOverride.pattern !== pattern) {
          tabOverrides.delete(tabId);
        }
        attemptedAutoAttach.delete(tabId);
        pendingNotices.delete(tabId);

        // On SPA navigation, push the new URL's state immediately so stale subtitles clear
        // (or switch immediately if the target URL already has an exact mapping).
        void resolveTabState(tabId, currentUrl).then((state) => notifyTabState(tabId, state));
      }
    } else if (changeInfo.status === 'loading') {
      // Full page reload: allow auto-attach to run again if unattached.
      attemptedAutoAttach.delete(tabId);
    }

    const { nextState, readiness } = advanceTabTitleWatch({
      prevState: tabTitleWatch.get(tabId),
      pageUrl: currentUrl,
      tabTitle: changeInfo.title ?? tab.title ?? '',
      tabStatus: tab.status,
      urlChanged: Boolean(changeInfo.url),
      titleChanged: Boolean(changeInfo.title),
      nowMs: Date.now(),
    });
    tabTitleWatch.set(tabId, nextState);

    if (!pattern) return;
    if (changeInfo.url || changeInfo.status === 'complete' || changeInfo.title) {
      if (readiness === 'ready') {
        void runAutoAttachForTab(tabId, currentUrl, changeInfo.title ?? tab.title ?? '');
      }
    }
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    tabOverrides.delete(tabId);
    lastTabPattern.delete(tabId);
    tabTitleWatch.delete(tabId);
    attemptedAutoAttach.delete(tabId);
    pendingNotices.delete(tabId);
    manualSearchTabs.delete(tabId);
  });

  browser.runtime.onMessage.addListener(
    (
      message: unknown,
      sender: { tab?: { id?: number; url?: string; title?: string; status?: string; windowId?: number } },
    ) => {
      if (isApiCallMessage(message)) {
        const method = (message.init?.method ?? 'GET').toUpperCase();
        const epMatch = /^\/episodes\/(\d+)$/.exec(message.path);
        const reprocessMatch = /^\/episodes\/(\d+)\/reprocess$/.exec(message.path);
        const linesMatch = /^\/episodes\/(\d+)\/lines$/.exec(message.path);
        const wordStatusMatch = /^\/words\/(\d+)\/status$/.exec(message.path);
        const isBulkWordStatus = message.path === '/words/bulk-status';

        if (method === 'POST' && reprocessMatch) {
          const epId = Number(reprocessMatch[1]);
          return (async () => {
            const settings = await getSettings();
            const res = await executeApiCall(settings, message.path, message.init);
            if (res.ok) {
              await transcriptCache.invalidateEpisode(epId);
            }
            return res;
          })();
        }

        if (method === 'GET' && epMatch) {
          const epId = Number(epMatch[1]);
          return transcriptCache.getEpisode(epId, async () => {
            const settings = await getSettings();
            return executeApiCall<EpisodeOut>(settings, message.path, message.init);
          });
        }

        if (method === 'GET' && linesMatch) {
          const epId = Number(linesMatch[1]);
          return transcriptCache.getLines(epId, async () => {
            const settings = await getSettings();
            return executeApiCall<LineOut[]>(settings, message.path, message.init);
          });
        }

        if (method === 'PATCH' && epMatch) {
          return (async () => {
            const settings = await getSettings();
            const res = await executeApiCall<EpisodeOut>(
              settings,
              message.path,
              message.init,
            );
            if (res.ok && res.data) {
              await transcriptCache.setEpisode(res.data);
              void broadcastEpisodeSyncUpdated(
                res.data.id,
                res.data.sub_offset_ms,
                res.data.sync_points ?? [],
              );
            }
            return res;
          })();
        }

        if (method === 'DELETE' && epMatch) {
          const epId = Number(epMatch[1]);
          return (async () => {
            const settings = await getSettings();
            const res = await executeApiCall(settings, message.path, message.init);
            if (res.ok) {
              await transcriptCache.invalidateEpisode(epId);
            }
            return res;
          })();
        }

        if (method === 'POST' && wordStatusMatch) {
          const wordId = Number(wordStatusMatch[1]);
          return (async () => {
            const settings = await getSettings();
            const res = await executeApiCall<WordOut>(
              settings,
              message.path,
              message.init,
            );
            if (res.ok) {
              const status =
                res.data?.status ??
                ((message.init?.json as { status?: WordStatus } | undefined)?.status ??
                  'known');
              await transcriptCache.updateWordStatus(wordId, status);
            }
            return res;
          })();
        }

        if (method === 'POST' && isBulkWordStatus) {
          return (async () => {
            const settings = await getSettings();
            const res = await executeApiCall(settings, message.path, message.init);
            if (res.ok) {
              const body = message.init?.json as
                | { word_ids?: number[]; status?: WordStatus }
                | undefined;
              if (Array.isArray(body?.word_ids) && body.status) {
                for (const wid of body.word_ids) {
                  await transcriptCache.updateWordStatus(wid, body.status);
                }
              }
            }
            return res;
          })();
        }

        return getSettings().then((settings) =>
          executeApiCall(settings, message.path, message.init),
        );
      }

      if (isUploadSubtitleMessage(message)) {
        return getSettings().then((settings) => executeSubtitleUpload(settings, message));
      }

      if (isUploadMediaMessage(message)) {
        return getSettings().then((settings) => executeMediaUpload(settings, message));
      }

      if (isSyncEpisodeMessage(message)) {
        return (async () => {
          const settings = await getSettings();
          const res = await executeSyncEpisode(settings, message);
          if (res.ok && res.data?.applied) {
            await transcriptCache.updateEpisodeSync(
              message.episodeId,
              res.data.sub_offset_ms,
              res.data.sync_points ?? [],
            );
            void broadcastEpisodeSyncUpdated(
              message.episodeId,
              res.data.sub_offset_ms,
              res.data.sync_points ?? [],
            );
          }
          return res;
        })();
      }

      if (isAnkiPushCardMessage(message)) {
        return (async (): Promise<AnkiPushCardResponse> => {
          const settings = await getSettings();
          if (!settings.ankiConnectEnabled) {
            const queued = await ankiQueue.list();
            return { status: 'disabled', queueLength: queued.length };
          }
          const res = await pushCardToAnki({
            cardId: message.cardId,
            settings,
            fetchCardNote: (cardId, deck) =>
              executeApiCall<AnkiNotePayload>(
                settings,
                `/cards/${cardId}/anki-note?${new URLSearchParams({ deck }).toString()}`,
              ),
            fetchAnkiModel: () => executeApiCall<AnkiModel>(settings, '/anki/model'),
          });
          if (res.status === 'queued') {
            const queueLength = await ankiQueue.enqueue(message.cardId, res.message);
            return { ...res, queueLength };
          }
          if (res.status === 'pushed' || res.status === 'duplicate') {
            await ankiQueue.remove(message.cardId);
            // Anki is confirmed running — drain any previously queued cards in the background
            void flushAnkiQueueNow();
          }
          const queued = await ankiQueue.list();
          return { ...res, queueLength: queued.length };
        })();
      }

      if (isAnkiFlushQueueMessage(message)) {
        return flushAnkiQueueNow();
      }

      if (isAnkiTestMessage(message)) {
        return (async (): Promise<AnkiTestResponse> => {
          const settings = await getSettings();
          const url = message.url?.trim() || settings.ankiConnectUrl;
          const [status, queued] = await Promise.all([testAnkiConnect(url), ankiQueue.list()]);
          return { ...status, queueLength: queued.length };
        })();
      }

      if (isAnkiImportDeckMessage(message)) {
        return (async () => {
          const settings = await getSettings();
          return importDeckFromAnkiConnect({
            ankiUrl: settings.ankiConnectUrl,
            deck: message.deck,
            fieldName: message.fieldName,
            matureDays: message.matureDays ?? 21,
            dryRun: message.dryRun,
            sendChunk: (payload) =>
              executeApiCall<ImportReport>(settings, '/import/anki/cards', {
                method: 'POST',
                json: payload,
              }),
          });
        })();
      }

      if (isCaptureVisibleTabMessage(message)) {
        return (async (): Promise<CaptureVisibleTabResponse> => {
          try {
            const dataUrl = await browser.tabs.captureVisibleTab(sender.tab?.windowId, {
              format: 'png',
            });
            return { ok: true, dataUrl };
          } catch (err) {
            return {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        })();
      }

      if (isGetTabStateMessage(message)) {
        const tabId = message.tabId ?? sender.tab?.id ?? null;
        const pageUrl = message.pageUrl ?? sender.tab?.url ?? '';
        return (async () => {
          const state = await resolveTabState(tabId, pageUrl);
          if (tabId !== null && sender.tab?.id === tabId && pageUrl) {
            const { nextState, readiness } = advanceTabTitleWatch({
              prevState: tabTitleWatch.get(tabId),
              pageUrl,
              tabTitle: sender.tab?.title ?? '',
              tabStatus: sender.tab?.status,
              urlChanged: false,
              titleChanged: false,
              nowMs: Date.now(),
            });
            tabTitleWatch.set(tabId, nextState);
            lastTabPattern.set(tabId, state.pattern);

            // Opportunistically trigger auto-attach when a content script boots on an unattached tab
            // (handles worker restarts or already-loaded pages when the extension reloads).
            if (state.episodeId === null && readiness === 'ready') {
              void runAutoAttachForTab(tabId, pageUrl, sender.tab?.title ?? '');
            }
          }
          return state;
        })();
      }

      if (isSetTabStateMessage(message)) {
        return (async () => {
          const settings = await getSettings();
          const pattern = normalizePageUrlPattern(message.pageUrl);
          pendingNotices.delete(message.tabId);

          if (message.episodeId !== null) {
            await rememberEpisodeMappings(message.pageUrl, message.episodeId, message.animeId);
          } else {
            const detached = removeMappingsForDetach(
              message.pageUrl,
              settings.urlMappings,
              settings.animeMappings,
            );
            if (detached.changed) {
              await saveSettings({
                urlMappings: detached.urlMappings,
                animeMappings: detached.animeMappings,
              });
            }
          }

          tabOverrides.set(message.tabId, {
            pattern,
            episodeId: message.episodeId,
            enabled: message.enabled && message.episodeId !== null,
          });
          lastTabPattern.set(message.tabId, pattern);

          // Seed the tab's title watch so a subsequent SPA next-episode transition knows this page's title.
          const currentTab = await browser.tabs.get(message.tabId).catch(() => null);
          if (currentTab?.title) {
            const { nextState } = advanceTabTitleWatch({
              prevState: tabTitleWatch.get(message.tabId),
              pageUrl: message.pageUrl,
              tabTitle: currentTab.title,
              tabStatus: currentTab.status,
              urlChanged: false,
              titleChanged: false,
              nowMs: Date.now(),
            });
            tabTitleWatch.set(message.tabId, nextState);
          }

          const state: TabEpisodeState = {
            tabId: message.tabId,
            pageUrl: message.pageUrl,
            pattern,
            episodeId: message.episodeId,
            enabled: message.enabled && message.episodeId !== null,
          };

          await notifyTabState(message.tabId, state);
          return state;
        })();
      }

      if (isTriggerAutoAttachMessage(message)) {
        const { nextState, readiness } = advanceTabTitleWatch({
          prevState: tabTitleWatch.get(message.tabId),
          pageUrl: message.pageUrl,
          tabTitle: message.pageTitle,
          tabStatus: 'complete',
          urlChanged: false,
          titleChanged: false,
          nowMs: Date.now(),
        });
        tabTitleWatch.set(message.tabId, nextState);
        if (readiness !== 'ready') {
          return Promise.resolve({ status: 'skipped' } satisfies TriggerAutoAttachResponse);
        }
        return runAutoAttachForTab(message.tabId, message.pageUrl, message.pageTitle, false);
      }

      if (isOpenPopupSearchMessage(message)) {
        return (async (): Promise<OpenPopupSearchResponse> => {
          const tabId = sender.tab?.id;
          if (typeof tabId === 'number') {
            manualSearchTabs.set(tabId, Date.now());
          }
          const ok = await tryOpenActionPopup();
          return { ok };
        })();
      }

      if (isConsumeManualSearchFlagMessage(message)) {
        const ts = manualSearchTabs.get(message.tabId);
        manualSearchTabs.delete(message.tabId);
        const openManualSearch =
          typeof ts === 'number' && Date.now() - ts <= MANUAL_SEARCH_FLAG_TTL_MS;
        return Promise.resolve({ openManualSearch });
      }

      if (isConsumeAutoAttachNoticeMessage(message)) {
        const tabId = sender.tab?.id;
        if (typeof tabId === 'number') {
          const entry = pendingNotices.get(tabId);
          if (entry && entry.notice.id === message.noticeId) {
            pendingNotices.delete(tabId);
          }
        }
        return Promise.resolve({ ok: true });
      }

      if (isStartNativeUpdateMessage(message)) {
        return (async (): Promise<NativeUpdateStateResponse> => {
          const settings = await getSettings();
          const state = nativeUpdater.startUpdate({
            serverUrl: settings.serverUrl,
            extensionFolder: settings.extensionFolder,
          });
          return { state };
        })();
      }

      if (isGetNativeUpdateStateMessage(message)) {
        return Promise.resolve({
          state: nativeUpdater.getState(),
        } satisfies NativeUpdateStateResponse);
      }

      return undefined;
    },
  );
});
