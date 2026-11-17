import { api } from '../../src/api/client';
import { type GlossLanguage, getSettings, saveSettings } from '../../src/lib/settings';

const form = document.getElementById('settings-form') as HTMLFormElement;
const serverUrlInput = document.getElementById('server-url') as HTMLInputElement;
const apiTokenInput = document.getElementById('api-token') as HTMLInputElement;
const glossLangSelect = document.getElementById('gloss-lang') as HTMLSelectElement;
const highlightLimitInput = document.getElementById('highlight-limit') as HTMLInputElement;
const romajiToggle = document.getElementById('romaji-toggle') as HTMLInputElement;
const testBtn = document.getElementById('test-btn') as HTMLButtonElement;
const statusBox = document.getElementById('status-box') as HTMLDivElement;

function showStatus(message: string, ok: boolean): void {
  statusBox.textContent = message;
  statusBox.className = `status ${ok ? 'ok' : 'err'}`;
}

async function init(): Promise<void> {
  const settings = await getSettings();
  serverUrlInput.value = settings.serverUrl;
  apiTokenInput.value = settings.apiToken;
  glossLangSelect.value = settings.glossLang;
  highlightLimitInput.value = String(settings.highlightLimit);
  romajiToggle.checked = settings.romaji;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const saved = await saveSettings({
    serverUrl: serverUrlInput.value,
    apiToken: apiTokenInput.value,
    glossLang: glossLangSelect.value as GlossLanguage,
    highlightLimit: Number(highlightLimitInput.value),
    romaji: romajiToggle.checked,
  });
  serverUrlInput.value = saved.serverUrl;
  highlightLimitInput.value = String(saved.highlightLimit);
  showStatus('Settings saved.', true);
});

testBtn.addEventListener('click', async () => {
  await saveSettings({
    serverUrl: serverUrlInput.value,
    apiToken: apiTokenInput.value,
    glossLang: glossLangSelect.value as GlossLanguage,
    highlightLimit: Number(highlightLimitInput.value),
    romaji: romajiToggle.checked,
  });

  const res = await api.getHealth();
  if (res.ok && res.data) {
    const h = res.data;
    showStatus(
      `Connected: v${h.version} · dictionary: ${h.dictionary ? 'ready' : 'missing'} · auth: ${h.auth ? 'on' : 'off'}`,
      true,
    );
  } else {
    showStatus(`Connection failed: ${res.error ?? 'Unknown error'}`, false);
  }
});

void init();
