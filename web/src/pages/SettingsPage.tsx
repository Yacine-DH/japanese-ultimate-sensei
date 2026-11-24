import { type FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  apiClient,
  SenseiApiError,
  verifyWebConnection,
  type WebConnectionCheck,
} from '../api/client';
import { ImportWordsPanel } from '../components/ImportWordsPanel';
import { loadIslandSettings, saveIslandSettings, type SceneQuality } from '../lib/island';
import {
  type GlossLanguage,
  loadWebSettings,
  saveWebSettings,
} from '../lib/settings';
import { emitIsland } from '../scene/bus';

function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [sceneQuality, setSceneQuality] = useState(() => loadIslandSettings().quality);
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

  const sttStatusQuery = useQuery({
    queryKey: ['stt-status', savedSettings.serverUrl, savedSettings.apiToken],
    queryFn: () => apiClient.getSttStatus(),
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
    // The island lives across pages, so it has to pick up the new server or token right away.
    void queryClient.invalidateQueries();
  }

  return (
    <div className="space-y-4">
      <div className="headline">
        <h1 className="text-2xl font-bold text-ink">Settings</h1>
        <p className="text-sm text-muted mt-1">
          Configure the Sensei server connection, API token, and reading preferences.
        </p>
      </div>

      <div className="card p-5 flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-ink-2">Server Status (/health)</div>
          {healthQuery.isLoading ? (
            <div className="text-xs text-muted mt-1">Checking connection...</div>
          ) : healthQuery.data?.state === 'connected' ? (
            <div className="space-y-1 mt-1">
              <div className="text-xs text-leaf-ink">
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
                      ? 'text-plum-ink'
                      : 'text-muted'
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
              {sttStatusQuery.data && (
                <div
                  className={`text-xs ${
                    sttStatusQuery.data.configured && sttStatusQuery.data.reachable
                      ? 'text-leaf-ink'
                      : 'text-muted'
                  }`}
                >
                  STT (Whisper):{' '}
                  {!sttStatusQuery.data.configured
                    ? 'Not configured (set SENSEI_STT_BASE_URL)'
                    : sttStatusQuery.data.reachable
                      ? `Ready${sttStatusQuery.data.model ? ` (${sttStatusQuery.data.model})` : ''}`
                      : `Unreachable — start whisper-server on the laptop (${sttStatusQuery.data.detail})`}
                </div>
              )}
            </div>
          ) : healthQuery.data?.state === 'unauthorized' ? (
            <div className="text-xs text-gold-ink mt-1">{healthQuery.data.message}</div>
          ) : healthQuery.data?.state === 'unreachable' ? (
            <div className="text-xs text-rose-ink mt-1">
              Server unreachable: {healthQuery.data.message}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => {
            void healthQuery.refetch();
            void llmStatusQuery.refetch();
            void sttStatusQuery.refetch();
          }}
          className="btn px-3 py-1.5 text-xs font-semibold text-ink cursor-pointer"
        >
          Refresh
        </button>
      </div>

      <form
        onSubmit={handleSubmit}
        className="card p-6 space-y-5"
      >
        <div>
          <label
            htmlFor="server-url"
            className="block text-sm font-medium text-ink mb-1.5"
          >
            Server URL
          </label>
          <input
            id="server-url"
            type="text"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder="Same origin (leave empty when served by FastAPI)"
            className="field w-full px-3.5 py-2 text-sm text-ink"
          />
          <p className="text-xs text-faint mt-1">
            Defaults to this page&apos;s origin. Set an explicit URL (e.g.
            http://homeserver:8000) only when running the web dev server separately.
          </p>
        </div>

        <div>
          <label
            htmlFor="api-token"
            className="block text-sm font-medium text-ink mb-1.5"
          >
            API Token (SENSEI_API_TOKEN)
          </label>
          <input
            id="api-token"
            type="password"
            value={apiToken}
            onChange={(e) => setApiToken(e.target.value)}
            placeholder="Bearer token for protected endpoints"
            className="field w-full px-3.5 py-2 text-sm text-ink"
          />
        </div>

        <div>
          <label
            htmlFor="gloss-lang"
            className="block text-sm font-medium text-ink mb-1.5"
          >
            Dictionary Gloss Language
          </label>
          <select
            id="gloss-lang"
            value={glossLang}
            onChange={(e) => setGlossLang(e.target.value as GlossLanguage)}
            className="field w-full px-3.5 py-2 text-sm text-ink"
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
            className="h-4 w-4 rounded border-line-2 bg-field text-torii-ink"
          />
          <span className="text-sm text-ink">
            Show Romaji below Japanese lines
          </span>
        </label>

        <div className="pt-2 flex flex-wrap items-center gap-3">
          <button
            type="submit"
            className="btn btn-sun px-4 py-2 font-semibold text-sm cursor-pointer"
          >
            Save Settings
          </button>
          <button
            type="button"
            onClick={() => void handleTestConnection()}
            className="btn px-4 py-2 text-ink font-semibold text-sm cursor-pointer"
          >
            Test Connection
          </button>
          {savedNotice && (
            <span className="text-xs text-leaf-ink font-medium">{savedNotice}</span>
          )}
        </div>

        {testResult.state === 'testing' && (
          <div className="text-xs text-muted">Testing connection...</div>
        )}
        {testResult.state === 'connected' && (
          <div className="text-xs text-leaf-ink">
            Connected: v{testResult.health.version} · JMdict:{' '}
            {testResult.health.dictionary ? 'Ready' : 'Missing'} · Auth:{' '}
            {testResult.health.auth ? 'Verified' : 'Open'}
          </div>
        )}
        {testResult.state === 'unauthorized' && (
          <div className="text-xs text-gold-ink">{testResult.message}</div>
        )}
        {testResult.state === 'unreachable' && (
          <div className="text-xs text-rose-ink">Server unreachable: {testResult.message}</div>
        )}
      </form>

      <section className="card p-5 space-y-2">
        <label htmlFor="scene-quality" className="block text-sm font-medium text-ink">
          3D island
        </label>
        <select
          id="scene-quality"
          value={sceneQuality}
          onChange={(e) => {
            const quality = e.target.value as SceneQuality;
            setSceneQuality(quality);
            saveIslandSettings({ quality });
            emitIsland({ type: 'quality' });
          }}
          className="field w-full px-3.5 py-2 text-sm text-ink"
        >
          <option value="full">Full: shadows and smooth motion</option>
          <option value="light">Light: for phones and older laptops</option>
          <option value="off">Off: painted sky only</option>
        </select>
        <p className="text-xs text-muted">Saved on this device. It never runs while you watch a video.</p>
      </section>

      {/* Anki Export (.apkg) — W-8 (#76) */}
      <section className="card p-5 space-y-4">
        <div>
          <h2 className="text-base font-semibold text-ink">Export Cards to Anki (.apkg)</h2>
          <p className="text-xs text-muted mt-1">
            Download your saved Sensei cards with screenshots, MP3 audio, and clips. Re-importing a
            newer export into Anki updates existing notes without creating duplicates.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <label className="space-y-1">
            <span className="block text-muted">Anki Deck Name</span>
            <input
              type="text"
              value={exportDeck}
              onChange={(e) => setExportDeck(e.target.value)}
              placeholder="Sensei"
              className="field w-full px-3 py-2 text-ink"
            />
          </label>
          <label className="space-y-1">
            <span className="block text-muted">Only cards created since (optional)</span>
            <input
              type="date"
              value={exportSince}
              onChange={(e) => setExportSince(e.target.value)}
              className="field w-full px-3 py-2 text-ink"
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={exportAnkiMutation.isPending}
            onClick={() => exportAnkiMutation.mutate()}
            className="btn btn-sun px-4 py-2 font-semibold text-xs disabled:opacity-50 cursor-pointer"
          >
            {exportAnkiMutation.isPending ? 'Building .apkg…' : 'Download .apkg'}
          </button>
          {exportMessage && (
            <span
              className={`text-xs ${exportMessage.ok ? 'text-leaf-ink' : 'text-gold-ink'}`}
            >
              {exportMessage.text}
            </span>
          )}
        </div>
      </section>

      {/* Anki / Word-List Known-Word Import — W-8 (#76) */}
      <div className="space-y-2">
        {ankiNotice && (
          <div className="text-xs px-3 py-2 rounded-lg bg-leaf/30 border border-leaf/50 text-leaf-ink">
            {ankiNotice}
          </div>
        )}
        <ImportWordsPanel onImported={(summary) => setAnkiNotice(summary)} />
      </div>
    </div>
  );
}
