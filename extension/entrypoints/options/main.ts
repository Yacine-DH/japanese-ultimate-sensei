import { api } from '../../src/api/client';
import {
  bindingFromEvent,
  DEFAULT_HOTKEYS,
  findConflicts,
  formatBinding,
  HOTKEY_ACTIONS,
  HOTKEY_LABELS,
  type HotkeyAction,
} from '../../src/lib/hotkeys';
import { getKeyboardLayoutMap, type LayoutMap } from '../../src/lib/keyboard-layout';
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

// ---- Hotkeys (#4) ----
const hotkeyList = document.getElementById('hotkey-list') as HTMLDivElement;
const hotkeyResetBtn = document.getElementById('hotkey-reset-btn') as HTMLButtonElement;
const hotkeyStatus = document.getElementById('hotkey-status') as HTMLDivElement;
let recordingAction: HotkeyAction | null = null;
let layoutMap: LayoutMap = null;

function showHotkeyStatus(message: string, ok: boolean): void {
  hotkeyStatus.textContent = message;
  hotkeyStatus.className = `status ${ok ? 'ok' : 'err'}`;
}

async function renderHotkeys(): Promise<void> {
  const { hotkeys } = await getSettings();
  const conflicts = new Set(findConflicts(hotkeys));
  hotkeyList.innerHTML = '';
  for (const action of HOTKEY_ACTIONS) {
    const row = document.createElement('div');
    row.className = 'hotkey-row';
    const label = document.createElement('span');
    label.textContent = HOTKEY_LABELS[action];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.action = action;
    if (recordingAction === action) {
      btn.textContent = 'Press keys…';
      btn.className = 'recording';
    } else {
      btn.textContent = formatBinding(hotkeys[action], layoutMap);
      btn.className = conflicts.has(action) ? 'conflict' : '';
      btn.title = conflicts.has(action) ? 'Same key as another action' : '';
    }
    btn.addEventListener('click', () => {
      recordingAction = action;
      void renderHotkeys();
    });
    row.appendChild(label);
    row.appendChild(btn);
    hotkeyList.appendChild(row);
  }
}

window.addEventListener(
  'keydown',
  async (event) => {
    if (!recordingAction) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.code === 'Escape') {
      recordingAction = null;
      await renderHotkeys();
      return;
    }
    const binding = bindingFromEvent(event);
    if (!binding) return; // modifier alone: keep waiting
    const action = recordingAction;
    recordingAction = null;
    const { hotkeys } = await getSettings();
    const saved = await saveSettings({ hotkeys: { ...hotkeys, [action]: binding } });
    await renderHotkeys();
    const conflicts = findConflicts(saved.hotkeys);
    if (conflicts.length > 0) {
      showHotkeyStatus('Two actions share the same key; change one of them.', false);
    } else {
      showHotkeyStatus(`Saved: ${formatBinding(binding, layoutMap)}`, true);
    }
  },
  { capture: true },
);

hotkeyResetBtn.addEventListener('click', async () => {
  recordingAction = null;
  await saveSettings({ hotkeys: DEFAULT_HOTKEYS });
  await renderHotkeys();
  showHotkeyStatus('Hotkeys reset to defaults.', true);
});

void getKeyboardLayoutMap().then((map) => {
  layoutMap = map;
  void renderHotkeys();
});
