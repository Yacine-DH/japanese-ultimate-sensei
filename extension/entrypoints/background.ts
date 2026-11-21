import {
  type AnkiFlushQueueResponse,
  type AnkiModel,
  type AnkiNotePayload,
  type AnkiPushCardResponse,
  type AnkiTestResponse,
  type CaptureVisibleTabResponse,
  type EpisodeOut,
  executeApiCall,
  executeMediaUpload,
  executeSubtitleUpload,
  type ImportReport,
  isAnkiFlushQueueMessage,
  isAnkiImportDeckMessage,
  isAnkiPushCardMessage,
  isAnkiTestMessage,
  isApiCallMessage,
  isCaptureVisibleTabMessage,
  isGetTabStateMessage,
  isSetTabStateMessage,
  isUploadMediaMessage,
  isUploadSubtitleMessage,
  type LineOut,
  markAsBackgroundContext,
  type TabEpisodeState,
  type TabStateChangedMessage,
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
import { EpisodeTranscriptCache, type SessionStorageLike } from '../src/lib/line-cache';
import { getSettings, saveSettings } from '../src/lib/settings';
import { normalizePageUrlPattern } from '../src/lib/url-mapping';

interface TabOverride {
  episodeId: number | null;
  enabled: boolean;
}

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

export default defineBackground(() => {
  markAsBackgroundContext();

  const tabOverrides = new Map<number, TabOverride>();
  const transcriptCache = new EpisodeTranscriptCache(getSessionStorage());
  const ankiQueue = new AnkiPushQueue(getLocalStorage());

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

  async function resolveTabState(
    tabId: number | null,
    pageUrl: string,
  ): Promise<TabEpisodeState> {
    const settings = await getSettings();
    const pattern = normalizePageUrlPattern(pageUrl);
    const mappedEpisodeId = pattern ? (settings.urlMappings[pattern] ?? null) : null;
    const override = tabId !== null ? tabOverrides.get(tabId) : undefined;

    if (override) {
      const episodeId = override.episodeId ?? mappedEpisodeId;
      return {
        tabId,
        pageUrl,
        pattern,
        episodeId,
        enabled: override.enabled && episodeId !== null,
      };
    }

    return {
      tabId,
      pageUrl,
      pattern,
      episodeId: mappedEpisodeId,
      enabled: mappedEpisodeId !== null,
    };
  }

  browser.runtime.onMessage.addListener(
    (message: unknown, sender: { tab?: { id?: number; url?: string; windowId?: number } }) => {
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
        return resolveTabState(tabId, pageUrl);
      }

      if (isSetTabStateMessage(message)) {
        return (async () => {
          const settings = await getSettings();
          const pattern = normalizePageUrlPattern(message.pageUrl);
          const nextMappings = { ...settings.urlMappings };

          if (pattern) {
            if (message.episodeId !== null) {
              nextMappings[pattern] = message.episodeId;
            } else {
              delete nextMappings[pattern];
            }
            await saveSettings({ urlMappings: nextMappings });
          }

          tabOverrides.set(message.tabId, {
            episodeId: message.episodeId,
            enabled: message.enabled && message.episodeId !== null,
          });

          const state: TabEpisodeState = {
            tabId: message.tabId,
            pageUrl: message.pageUrl,
            pattern,
            episodeId: message.episodeId,
            enabled: message.enabled && message.episodeId !== null,
          };

          try {
            await browser.tabs.sendMessage(message.tabId, {
              type: 'SENSEI_TAB_STATE_CHANGED',
              state,
            } satisfies TabStateChangedMessage);
          } catch {
            // Content script might not be loaded on non-web tabs
          }

          return state;
        })();
      }

      return undefined;
    },
  );
});
