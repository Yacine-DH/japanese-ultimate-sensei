import { DEFAULT_HOTKEYS, type HotkeyBindings, sanitizeHotkeys } from './hotkeys';
import { DEFAULT_HOVER_CONFIG, sanitizeHoverDelayMs } from './hover-intent';

export type GlossLanguage = 'eng' | 'ger';

export interface ExtensionSettings {
  serverUrl: string;
  apiToken: string;
  glossLang: GlossLanguage;
  romaji: boolean;
  highlightLimit: number;
  hoverDelayMs: number;
  pauseOnHover: boolean;
  requireShiftForHover: boolean;
  urlMappings: Record<string, number>;
  hotkeys: HotkeyBindings;
}

export const DEFAULT_SERVER_URL = 'http://<tailscale-host>:8000';

export const DEFAULT_SETTINGS: ExtensionSettings = {
  serverUrl: DEFAULT_SERVER_URL,
  apiToken: '',
  glossLang: 'eng',
  romaji: false,
  highlightLimit: 3,
  hoverDelayMs: DEFAULT_HOVER_CONFIG.hoverDelayMs,
  pauseOnHover: DEFAULT_HOVER_CONFIG.pauseOnHover,
  requireShiftForHover: DEFAULT_HOVER_CONFIG.requireShiftForHover,
  urlMappings: {},
  hotkeys: DEFAULT_HOTKEYS,
};

export const SETTINGS_STORAGE_KEY = 'sensei_settings';

export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed || DEFAULT_SERVER_URL;
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
  const rawLimit = Number(merged.highlightLimit);
  const highlightLimit = Number.isFinite(rawLimit)
    ? Math.max(0, Math.min(20, Math.round(rawLimit)))
    : DEFAULT_SETTINGS.highlightLimit;

  return {
    serverUrl: normalizeServerUrl(String(merged.serverUrl ?? DEFAULT_SERVER_URL)),
    apiToken: String(merged.apiToken ?? '').trim(),
    glossLang,
    romaji: Boolean(merged.romaji),
    highlightLimit,
    hoverDelayMs: sanitizeHoverDelayMs(merged.hoverDelayMs),
    pauseOnHover: Boolean(merged.pauseOnHover),
    requireShiftForHover: Boolean(merged.requireShiftForHover),
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
