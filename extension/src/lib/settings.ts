export type GlossLanguage = 'eng' | 'ger';

export interface ExtensionSettings {
  serverUrl: string;
  apiToken: string;
  glossLang: GlossLanguage;
  romaji: boolean;
  highlightLimit: number;
  activeEpisodeId: number | null;
}

export const DEFAULT_SERVER_URL = 'http://<tailscale-host>:8000';

export const DEFAULT_SETTINGS: ExtensionSettings = {
  serverUrl: DEFAULT_SERVER_URL,
  apiToken: '',
  glossLang: 'eng',
  romaji: false,
  highlightLimit: 3,
  activeEpisodeId: null,
};

export const SETTINGS_STORAGE_KEY = 'sensei_settings';

export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed || DEFAULT_SERVER_URL;
}

export function sanitizeSettings(partial?: Partial<ExtensionSettings> | null): ExtensionSettings {
  const merged = { ...DEFAULT_SETTINGS, ...(partial ?? {}) };
  const glossLang: GlossLanguage = merged.glossLang === 'ger' ? 'ger' : 'eng';
  const rawLimit = Number(merged.highlightLimit);
  const highlightLimit = Number.isFinite(rawLimit)
    ? Math.max(0, Math.min(20, Math.round(rawLimit)))
    : DEFAULT_SETTINGS.highlightLimit;
  const activeEpisodeId =
    typeof merged.activeEpisodeId === 'number' && Number.isFinite(merged.activeEpisodeId)
      ? merged.activeEpisodeId
      : null;

  return {
    serverUrl: normalizeServerUrl(String(merged.serverUrl ?? DEFAULT_SERVER_URL)),
    apiToken: String(merged.apiToken ?? '').trim(),
    glossLang,
    romaji: Boolean(merged.romaji),
    highlightLimit,
    activeEpisodeId,
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
    return { ...memorySettings };
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
