import { type FormEvent, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  apiClient,
  SenseiApiError,
  verifyWebConnection,
  type WebConnectionCheck,
} from '../api/client';
import { ImportWordsPanel } from '../components/ImportWordsPanel';
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
  const [ankiNotice, setAnkiNotice] = useState<string | null>(null);
  const [exportDeck, setExportDeck] = useState('Sensei');
  const [exportSince, setExportSince] = useState('');
  const [exportMessage, setExportMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [testResult, setTestResult] = useState<
    { state: 'idle' } | { state: 'testing' } | WebConnectionCheck
  >({ state: 'idle' });

  const exportAnkiMutation = useMutation({
    mutationFn: () =>
      apiClient.downloadAnkiApkg({
        deck: exportDeck.trim() || 'Sensei',
        since: exportSince ? `${exportSince}T00:00:00Z` : undefined,
      }),
    onSuccess: ({ blob, filename }) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setExportMessage({ ok: true, text: `Downloaded ${filename}.` });
    },
    onError: (err) => {
      const msg =
        err instanceof SenseiApiError
          ? err.status === 404
            ? 'No saved cards match this filter yet.'
            : err.message
          : 'Failed to export .apkg.';
      setExportMessage({ ok: false, text: msg });
    },
  });

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

  const llmStatusQuery = useQuery({
    queryKey: ['llm-status', savedSettings.serverUrl, savedSettings.apiToken],
    queryFn: () => apiClient.getLlmStatus(),
    enabled: healthQuery.data?.state === 'connected',
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
    <div className="max-w-2xl mx-auto space-y-6">
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
            <div className="space-y-1 mt-1">
              <div className="text-xs text-emerald-400">
                v{healthQuery.data.health.version} · JMdict:{' '}
                {healthQuery.data.health.dictionary ? 'Ready' : 'Missing'} · ffmpeg:{' '}
                {healthQuery.data.health.ffmpeg ? 'Ready' : 'Missing'} · Media:{' '}
                {formatBytes(healthQuery.data.health.media_bytes)} · Auth:{' '}
                {healthQuery.data.health.auth ? 'Verified' : 'Open'}
              </div>
              {llmStatusQuery.data && (
                <div
                  className={`text-xs ${
                    llmStatusQuery.data.configured && llmStatusQuery.data.reachable
                      ? 'text-indigo-300'
                      : 'text-slate-400'
                  }`}
                >
                  LLM:{' '}
                  {!llmStatusQuery.data.configured
                    ? 'Not configured (set up a model on the server)'
                    : llmStatusQuery.data.reachable
                      ? `Ready (${llmStatusQuery.data.model})`
                      : `Configured (${llmStatusQuery.data.model}), unreachable: ${llmStatusQuery.data.detail}`}
                </div>
              )}
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
          onClick={() => {
            void healthQuery.refetch();
            void llmStatusQuery.refetch();
          }}
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

      {/* Anki Export (.apkg) — W-8 (#76) */}
      <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <div>
          <h2 className="text-base font-semibold text-slate-100">Export Cards to Anki (.apkg)</h2>
          <p className="text-xs text-slate-400 mt-1">
            Download your saved Sensei cards with screenshots, MP3 audio, and clips. Re-importing a
            newer export into Anki updates existing notes without creating duplicates.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <label className="space-y-1">
            <span className="block text-slate-400">Anki Deck Name</span>
            <input
              type="text"
              value={exportDeck}
              onChange={(e) => setExportDeck(e.target.value)}
              placeholder="Sensei"
              className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-slate-100"
            />
          </label>
          <label className="space-y-1">
            <span className="block text-slate-400">Only cards created since (optional)</span>
            <input
              type="date"
              value={exportSince}
              onChange={(e) => setExportSince(e.target.value)}
              className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-slate-100"
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={exportAnkiMutation.isPending}
            onClick={() => exportAnkiMutation.mutate()}
            className="px-4 py-2 rounded-lg bg-sky-400 hover:bg-sky-300 text-slate-950 font-semibold text-xs disabled:opacity-50 cursor-pointer"
          >
            {exportAnkiMutation.isPending ? 'Building .apkg…' : 'Download .apkg'}
          </button>
          {exportMessage && (
            <span
              className={`text-xs ${exportMessage.ok ? 'text-emerald-400' : 'text-amber-300'}`}
            >
              {exportMessage.text}
            </span>
          )}
        </div>
      </section>

      {/* Anki / Word-List Known-Word Import — W-8 (#76) */}
      <div className="space-y-2">
        {ankiNotice && (
          <div className="text-xs px-3 py-2 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300">
            {ankiNotice}
          </div>
        )}
        <ImportWordsPanel onImported={(summary) => setAnkiNotice(summary)} />
      </div>
    </div>
  );
}
