import {
  executeApiCall,
  executeSubtitleUpload,
  isApiCallMessage,
  isGetTabStateMessage,
  isSetTabStateMessage,
  isUploadSubtitleMessage,
  markAsBackgroundContext,
  type TabEpisodeState,
  type TabStateChangedMessage,
} from '../src/api/client';
import { getSettings, saveSettings } from '../src/lib/settings';
import { normalizePageUrlPattern } from '../src/lib/url-mapping';

interface TabOverride {
  episodeId: number | null;
  enabled: boolean;
}

export default defineBackground(() => {
  markAsBackgroundContext();

  const tabOverrides = new Map<number, TabOverride>();

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
    (message: unknown, sender: { tab?: { id?: number; url?: string } }) => {
    if (isApiCallMessage(message)) {
      return getSettings().then((settings) =>
        executeApiCall(settings, message.path, message.init),
      );
    }

    if (isUploadSubtitleMessage(message)) {
      return getSettings().then((settings) => executeSubtitleUpload(settings, message));
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
