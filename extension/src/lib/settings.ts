import { DEFAULT_HOTKEYS, type HotkeyBindings, sanitizeHotkeys } from './hotkeys';
import { DEFAULT_HOVER_CONFIG, sanitizeHoverDelayMs } from './hover-intent';

export type GlossLanguage = 'eng' | 'ger';
export type TranslationDisplayMode = 'off' | 'en' | 'de';

export interface ExtensionSettings {
  serverUrl: string;
  apiToken: string;
  glossLang: GlossLanguage;
  translationMode: TranslationDisplayMode;
  romaji: boolean;
  highlightLimit: number;
  hoverDelayMs: number;
  pauseOnHover: boolean;
  requireShiftForHover: boolean;
  autoPauseEachLine: boolean;
  ankiConnectEnabled: boolean;
  ankiConnectUrl: string;
  ankiDeckName: string;
  ankiModelName: string;
  urlMappings: Record<string, number>;
  hotkeys: HotkeyBindings;
}

export const DEFAULT_SERVER_URL = '';
export const DEFAULT_ANKI_CONNECT_URL = 'http://localhost:8765';
export const DEFAULT_ANKI_DECK_NAME = 'Sensei';
export const DEFAULT_ANKI_MODEL_NAME = 'Sensei Japanese';

export const DEFAULT_SETTINGS: ExtensionSettings = {
  serverUrl: DEFAULT_SERVER_URL,
  apiToken: '',
  glossLang: 'eng',
  translationMode: 'off',
  romaji: false,
  highlightLimit: 3,
  hoverDelayMs: DEFAULT_HOVER_CONFIG.hoverDelayMs,
  pauseOnHover: DEFAULT_HOVER_CONFIG.pauseOnHover,
  requireShiftForHover: DEFAULT_HOVER_CONFIG.requireShiftForHover,
  autoPauseEachLine: false,
  ankiConnectEnabled: false,
  ankiConnectUrl: DEFAULT_ANKI_CONNECT_URL,
  ankiDeckName: DEFAULT_ANKI_DECK_NAME,
  ankiModelName: DEFAULT_ANKI_MODEL_NAME,
  urlMappings: {},
  hotkeys: DEFAULT_HOTKEYS,
};

export const SETTINGS_STORAGE_KEY = 'sensei_settings';

export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed || trimmed.includes('<') || trimmed.includes('>')) {
    return '';
  }
  return trimmed;
}

export function isServerUrlConfigured(raw: string): boolean {
  const url = normalizeServerUrl(raw);
  return /^https?:\/\/.+/.test(url);
}

export function sanitizeUrlMappings(raw: unknown): Record<string, number> {
  if (typeof raw !== 'object' || raw === null) {
    return {};
  }
  const clean: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k === 'string' && k.trim() !== '' && typeof v === 'number' && Number.isFinite(v)) {
      clean[k] = v;
    }
  }
  return clean;
}

export function sanitizeSettings(partial?: Partial<ExtensionSettings> | null): ExtensionSettings {
  const merged = { ...DEFAULT_SETTINGS, ...(partial ?? {}) };
  const glossLang: GlossLanguage = merged.glossLang === 'ger' ? 'ger' : 'eng';
  const translationMode: TranslationDisplayMode =
    merged.translationMode === 'en' || merged.translationMode === 'de'
      ? merged.translationMode
      : 'off';
  const rawLimit = Number(merged.highlightLimit);
  const highlightLimit = Number.isFinite(rawLimit)
    ? Math.max(0, Math.min(20, Math.round(rawLimit)))
    : DEFAULT_SETTINGS.highlightLimit;

  const ankiUrl = normalizeServerUrl(String(merged.ankiConnectUrl ?? DEFAULT_ANKI_CONNECT_URL));
  const ankiDeck = String(merged.ankiDeckName ?? DEFAULT_ANKI_DECK_NAME).trim();
  const ankiModel = String(merged.ankiModelName ?? DEFAULT_ANKI_MODEL_NAME).trim();

  return {
    serverUrl: normalizeServerUrl(String(merged.serverUrl ?? DEFAULT_SERVER_URL)),
    apiToken: String(merged.apiToken ?? '').trim(),
    glossLang,
    translationMode,
    romaji: Boolean(merged.romaji),
    highlightLimit,
    hoverDelayMs: sanitizeHoverDelayMs(merged.hoverDelayMs),
    pauseOnHover: Boolean(merged.pauseOnHover),
    requireShiftForHover: Boolean(merged.requireShiftForHover),
    autoPauseEachLine: Boolean(merged.autoPauseEachLine),
    ankiConnectEnabled: Boolean(merged.ankiConnectEnabled),
    ankiConnectUrl: isServerUrlConfigured(ankiUrl) ? ankiUrl : DEFAULT_ANKI_CONNECT_URL,
    ankiDeckName: ankiDeck || DEFAULT_ANKI_DECK_NAME,
    ankiModelName: ankiModel || DEFAULT_ANKI_MODEL_NAME,
    urlMappings: sanitizeUrlMappings(merged.urlMappings),
    hotkeys: sanitizeHotkeys(merged.hotkeys),
  };
}

interface StorageAreaLike {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

function getBrowserStorage(): StorageAreaLike | null {
  const g = globalThis as unknown as {
    browser?: { storage?: { local?: StorageAreaLike } };
    chrome?: { storage?: { local?: StorageAreaLike } };
  };
  return g.browser?.storage?.local ?? g.chrome?.storage?.local ?? null;
}

let memorySettings: ExtensionSettings = { ...DEFAULT_SETTINGS };

export async function getSettings(): Promise<ExtensionSettings> {
  const storage = getBrowserStorage();
  if (!storage) {
    return {
      ...memorySettings,
      urlMappings: { ...memorySettings.urlMappings },
    };
  }
  const result = await storage.get(SETTINGS_STORAGE_KEY);
  const raw = result?.[SETTINGS_STORAGE_KEY] as Partial<ExtensionSettings> | undefined;
  return sanitizeSettings(raw);
}

export async function saveSettings(
  patch: Partial<ExtensionSettings>,
): Promise<ExtensionSettings> {
  const current = await getSettings();
  const next = sanitizeSettings({ ...current, ...patch });
  const storage = getBrowserStorage();
  if (!storage) {
    memorySettings = next;
    return next;
  }
  await storage.set({ [SETTINGS_STORAGE_KEY]: next });
  return next;
}
