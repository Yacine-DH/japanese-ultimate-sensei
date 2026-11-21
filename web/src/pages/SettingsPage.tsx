import { type FormEvent, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { verifyWebConnection, type WebConnectionCheck } from '../api/client';
import {
  type GlossLanguage,
  loadWebSettings,
  saveWebSettings,
} from '../lib/settings';

function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function SettingsPage() {
  const [savedSettings, setSavedSettings] = useState(() => loadWebSettings());
  const [serverUrl, setServerUrl] = useState(savedSettings.serverUrl);
  const [apiToken, setApiToken] = useState(savedSettings.apiToken);
  const [glossLang, setGlossLang] = useState<GlossLanguage>(savedSettings.glossLang);
  const [romaji, setRomaji] = useState(savedSettings.romaji);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<
    { state: 'idle' } | { state: 'testing' } | WebConnectionCheck
  >({ state: 'idle' });

  // Only queries against saved settings — never re-fires on form keystrokes (#7).
  const healthQuery = useQuery({
    queryKey: ['connection', savedSettings.serverUrl, savedSettings.apiToken],
    queryFn: () =>
      verifyWebConnection({
        serverUrl: savedSettings.serverUrl,
        apiToken: savedSettings.apiToken,
      }),
    retry: false,
  });

  async function handleTestConnection() {
    setTestResult({ state: 'testing' });
    const res = await verifyWebConnection({ serverUrl, apiToken });
    setTestResult(res);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const saved = saveWebSettings({
      serverUrl,
      apiToken,
      glossLang,
      romaji,
    });
    setSavedSettings(saved);
    setServerUrl(saved.serverUrl);
    setTestResult({ state: 'idle' });
    setSavedNotice('Settings saved to local storage.');
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
          ) : healthQuery.data?.state === 'connected' ? (
            <div className="text-xs text-emerald-400 mt-1">
              v{healthQuery.data.health.version} · JMdict:{' '}
              {healthQuery.data.health.dictionary ? 'Ready' : 'Missing'} · ffmpeg:{' '}
              {healthQuery.data.health.ffmpeg ? 'Ready' : 'Missing'} · Media:{' '}
              {formatBytes(healthQuery.data.health.media_bytes)} · Auth:{' '}
              {healthQuery.data.health.auth ? 'Verified' : 'Open'}
            </div>
          ) : healthQuery.data?.state === 'unauthorized' ? (
            <div className="text-xs text-amber-400 mt-1">{healthQuery.data.message}</div>
          ) : healthQuery.data?.state === 'unreachable' ? (
            <div className="text-xs text-rose-400 mt-1">
              Server unreachable: {healthQuery.data.message}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => void healthQuery.refetch()}
          className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 border border-slate-700 cursor-pointer"
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
            placeholder="Same origin (leave empty when served by FastAPI)"
            className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3.5 py-2 text-sm text-slate-100 focus:outline-none focus:border-sky-400"
          />
          <p className="text-xs text-slate-500 mt-1">
            Defaults to this page&apos;s origin. Set an explicit URL (e.g.
            http://homeserver:8000) only when running the web dev server separately.
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

        <div className="pt-2 flex flex-wrap items-center gap-3">
          <button
            type="submit"
            className="px-4 py-2 rounded-lg bg-sky-400 hover:bg-sky-300 text-slate-950 font-semibold text-sm cursor-pointer"
          >
            Save Settings
          </button>
          <button
            type="button"
            onClick={() => void handleTestConnection()}
            className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-100 font-semibold text-sm border border-slate-700 cursor-pointer"
          >
            Test Connection
          </button>
          {savedNotice && (
            <span className="text-xs text-emerald-400 font-medium">{savedNotice}</span>
          )}
        </div>

        {testResult.state === 'testing' && (
          <div className="text-xs text-slate-400">Testing connection...</div>
        )}
        {testResult.state === 'connected' && (
          <div className="text-xs text-emerald-400">
            Connected: v{testResult.health.version} · JMdict:{' '}
            {testResult.health.dictionary ? 'Ready' : 'Missing'} · Auth:{' '}
            {testResult.health.auth ? 'Verified' : 'Open'}
          </div>
        )}
        {testResult.state === 'unauthorized' && (
          <div className="text-xs text-amber-400">{testResult.message}</div>
        )}
        {testResult.state === 'unreachable' && (
          <div className="text-xs text-rose-400">Server unreachable: {testResult.message}</div>
        )}
      </form>
    </div>
  );
}
