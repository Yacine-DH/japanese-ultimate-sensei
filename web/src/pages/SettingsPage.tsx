import { type FormEvent, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../api/client';
import {
  type GlossLanguage,
  loadWebSettings,
  saveWebSettings,
} from '../lib/settings';

export function SettingsPage() {
  const initial = loadWebSettings();
  const [serverUrl, setServerUrl] = useState(initial.serverUrl);
  const [apiToken, setApiToken] = useState(initial.apiToken);
  const [glossLang, setGlossLang] = useState<GlossLanguage>(initial.glossLang);
  const [romaji, setRomaji] = useState(initial.romaji);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  const healthQuery = useQuery({
    queryKey: ['health', serverUrl, apiToken],
    queryFn: () => apiClient.getHealth({ serverUrl, apiToken }),
    retry: false,
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const saved = saveWebSettings({
      serverUrl,
      apiToken,
      glossLang,
      romaji,
    });
    setServerUrl(saved.serverUrl);
    setSavedNotice('Settings saved to local storage.');
    void healthQuery.refetch();
  }

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-100">Settings</h1>
        <p className="text-sm text-slate-400 mt-1">
          Configure the Sensei server connection, API token, and reading preferences.
        </p>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-slate-300">Server Status (/health)</div>
          {healthQuery.isLoading ? (
            <div className="text-xs text-slate-400 mt-1">Checking connection...</div>
          ) : healthQuery.isError ? (
            <div className="text-xs text-rose-400 mt-1">
              Offline: {(healthQuery.error as Error)?.message ?? 'Unreachable'}
            </div>
          ) : healthQuery.data ? (
            <div className="text-xs text-emerald-400 mt-1">
              v{healthQuery.data.version} · JMdict:{' '}
              {healthQuery.data.dictionary ? 'Ready' : 'Missing'} · Auth:{' '}
              {healthQuery.data.auth ? 'Required' : 'Open'}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => void healthQuery.refetch()}
          className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 border border-slate-700"
        >
          Refresh
        </button>
      </div>

      <form
        onSubmit={handleSubmit}
        className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-5"
      >
        <div>
          <label
            htmlFor="server-url"
            className="block text-sm font-medium text-slate-200 mb-1.5"
          >
            Server URL
          </label>
          <input
            id="server-url"
            type="text"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder="http://<tailscale-host>:8000"
            className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3.5 py-2 text-sm text-slate-100 focus:outline-none focus:border-sky-400"
          />
          <p className="text-xs text-slate-500 mt-1">
            Leave empty to use the current origin when served directly by FastAPI.
          </p>
        </div>

        <div>
          <label
            htmlFor="api-token"
            className="block text-sm font-medium text-slate-200 mb-1.5"
          >
            API Token (SENSEI_API_TOKEN)
          </label>
          <input
            id="api-token"
            type="password"
            value={apiToken}
            onChange={(e) => setApiToken(e.target.value)}
            placeholder="Bearer token for protected endpoints"
            className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3.5 py-2 text-sm text-slate-100 focus:outline-none focus:border-sky-400"
          />
        </div>

        <div>
          <label
            htmlFor="gloss-lang"
            className="block text-sm font-medium text-slate-200 mb-1.5"
          >
            Dictionary Gloss Language
          </label>
          <select
            id="gloss-lang"
            value={glossLang}
            onChange={(e) => setGlossLang(e.target.value as GlossLanguage)}
            className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3.5 py-2 text-sm text-slate-100 focus:outline-none focus:border-sky-400"
          >
            <option value="eng">English (EN)</option>
            <option value="ger">German (DE)</option>
          </select>
        </div>

        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={romaji}
            onChange={(e) => setRomaji(e.target.checked)}
            className="h-4 w-4 rounded border-slate-700 bg-slate-950 text-sky-400"
          />
          <span className="text-sm text-slate-200">
            Show Romaji below Japanese lines
          </span>
        </label>

        <div className="pt-2 flex items-center gap-4">
          <button
            type="submit"
            className="px-4 py-2 rounded-lg bg-sky-400 hover:bg-sky-300 text-slate-950 font-semibold text-sm cursor-pointer"
          >
            Save Settings
          </button>
          {savedNotice && (
            <span className="text-xs text-emerald-400 font-medium">{savedNotice}</span>
          )}
        </div>
      </form>
    </div>
  );
}
