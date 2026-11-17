export type GlossLanguage = 'eng' | 'ger';

export interface WebSettings {
  serverUrl: string;
  apiToken: string;
  glossLang: GlossLanguage;
  romaji: boolean;
}

export const SETTINGS_STORAGE_KEY = 'sensei_web_settings';

export const DEFAULT_WEB_SETTINGS: WebSettings = {
  serverUrl: 'http://localhost:8000',
  apiToken: '',
  glossLang: 'eng',
  romaji: false,
};

export function normalizeServerUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

export function sanitizeWebSettings(partial?: Partial<WebSettings> | null): WebSettings {
  const merged = { ...DEFAULT_WEB_SETTINGS, ...(partial ?? {}) };
  return {
    serverUrl: normalizeServerUrl(String(merged.serverUrl ?? DEFAULT_WEB_SETTINGS.serverUrl)),
    apiToken: String(merged.apiToken ?? '').trim(),
    glossLang: merged.glossLang === 'ger' ? 'ger' : 'eng',
    romaji: Boolean(merged.romaji),
  };
}

export function loadWebSettings(): WebSettings {
  try {
    const raw = globalThis.localStorage?.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_WEB_SETTINGS };
    return sanitizeWebSettings(JSON.parse(raw) as Partial<WebSettings>);
  } catch {
    return { ...DEFAULT_WEB_SETTINGS };
  }
}

export function saveWebSettings(patch: Partial<WebSettings>): WebSettings {
  const current = loadWebSettings();
  const next = sanitizeWebSettings({ ...current, ...patch });
  try {
    globalThis.localStorage?.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage errors in restricted environments
  }
  return next;
}
