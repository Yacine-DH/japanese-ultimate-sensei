import { api, verifyServerConnection } from '../../src/api/client';
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
import {
  type GlossLanguage,
  getSettings,
  isServerUrlConfigured,
  saveSettings,
} from '../../src/lib/settings';

const form = document.getElementById('settings-form') as HTMLFormElement;
const serverUrlInput = document.getElementById('server-url') as HTMLInputElement;
const apiTokenInput = document.getElementById('api-token') as HTMLInputElement;
const glossLangSelect = document.getElementById('gloss-lang') as HTMLSelectElement;
const highlightLimitInput = document.getElementById('highlight-limit') as HTMLInputElement;
const hoverDelayInput = document.getElementById('hover-delay') as HTMLInputElement;
const pauseOnHoverToggle = document.getElementById('pause-on-hover-toggle') as HTMLInputElement;
const shiftHoverToggle = document.getElementById('shift-hover-toggle') as HTMLInputElement;
const autoPauseToggle = document.getElementById('auto-pause-toggle') as HTMLInputElement;
const romajiToggle = document.getElementById('romaji-toggle') as HTMLInputElement;
const testBtn = document.getElementById('test-btn') as HTMLButtonElement;
const statusBox = document.getElementById('status-box') as HTMLDivElement;
const firstRunBanner = document.getElementById('first-run-banner') as HTMLDivElement;
const ankiForm = document.getElementById('anki-form') as HTMLFormElement;
const ankiEnabledToggle = document.getElementById('anki-enabled-toggle') as HTMLInputElement;
const ankiUrlInput = document.getElementById('anki-url') as HTMLInputElement;
const ankiDeckInput = document.getElementById('anki-deck') as HTMLInputElement;
const ankiModelInput = document.getElementById('anki-model') as HTMLInputElement;
const ankiTestBtn = document.getElementById('anki-test-btn') as HTMLButtonElement;
const ankiSyncBtn = document.getElementById('anki-sync-btn') as HTMLButtonElement;
const ankiStatus = document.getElementById('anki-status') as HTMLDivElement;

function showAnkiStatus(message: string, ok: boolean): void {
  ankiStatus.textContent = message;
  ankiStatus.className = `status ${ok ? 'ok' : 'err'}`;
}

function updateAnkiQueueBadge(count: number): void {
  ankiSyncBtn.textContent = `Sync Queue (${count})`;
}

function updateFirstRunBanner(url: string): void {
  if (!isServerUrlConfigured(url)) {
    firstRunBanner.className = 'status err';
  } else {
    firstRunBanner.className = 'status';
  }
}

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
  hoverDelayInput.value = String(settings.hoverDelayMs);
  pauseOnHoverToggle.checked = settings.pauseOnHover;
  shiftHoverToggle.checked = settings.requireShiftForHover;
  autoPauseToggle.checked = settings.autoPauseEachLine;
  romajiToggle.checked = settings.romaji;
  ankiEnabledToggle.checked = settings.ankiConnectEnabled;
  ankiUrlInput.value = settings.ankiConnectUrl;
  ankiDeckInput.value = settings.ankiDeckName;
  ankiModelInput.value = settings.ankiModelName;
  updateFirstRunBanner(settings.serverUrl);
  const probe = await api.testAnkiConnect(settings.ankiConnectUrl);
  updateAnkiQueueBadge(probe.queueLength);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const saved = await saveSettings({
    serverUrl: serverUrlInput.value,
    apiToken: apiTokenInput.value,
    glossLang: glossLangSelect.value as GlossLanguage,
    highlightLimit: Number(highlightLimitInput.value),
    hoverDelayMs: Number(hoverDelayInput.value),
    pauseOnHover: pauseOnHoverToggle.checked,
    requireShiftForHover: shiftHoverToggle.checked,
    autoPauseEachLine: autoPauseToggle.checked,
    romaji: romajiToggle.checked,
  });
  serverUrlInput.value = saved.serverUrl;
  highlightLimitInput.value = String(saved.highlightLimit);
  hoverDelayInput.value = String(saved.hoverDelayMs);
  updateFirstRunBanner(saved.serverUrl);
  showStatus('Settings saved.', true);
});

testBtn.addEventListener('click', async () => {
  const saved = await saveSettings({
    serverUrl: serverUrlInput.value,
    apiToken: apiTokenInput.value,
    glossLang: glossLangSelect.value as GlossLanguage,
    highlightLimit: Number(highlightLimitInput.value),
    hoverDelayMs: Number(hoverDelayInput.value),
    pauseOnHover: pauseOnHoverToggle.checked,
    requireShiftForHover: shiftHoverToggle.checked,
    autoPauseEachLine: autoPauseToggle.checked,
    romaji: romajiToggle.checked,
  });
  updateFirstRunBanner(saved.serverUrl);

  const check = await verifyServerConnection(api, saved.serverUrl);
  if (check.state === 'connected') {
    const h = check.health;
    showStatus(
      `Connected: v${h.version} · dictionary: ${h.dictionary ? 'ready' : 'missing'} · auth: ${h.auth ? 'verified' : 'off'}`,
      true,
    );
  } else if (check.state === 'unauthorized') {
    showStatus(check.message, false);
  } else {
    showStatus(`Server unreachable: ${check.message}`, false);
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

// ---- AnkiConnect (E-6) ----
ankiForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const saved = await saveSettings({
    ankiConnectEnabled: ankiEnabledToggle.checked,
    ankiConnectUrl: ankiUrlInput.value,
    ankiDeckName: ankiDeckInput.value,
    ankiModelName: ankiModelInput.value,
  });
  ankiUrlInput.value = saved.ankiConnectUrl;
  ankiDeckInput.value = saved.ankiDeckName;
  ankiModelInput.value = saved.ankiModelName;
  showAnkiStatus(
    saved.ankiConnectEnabled
      ? `AnkiConnect enabled → deck "${saved.ankiDeckName}" (${saved.ankiModelName}).`
      : 'AnkiConnect push disabled (settings saved).',
    true,
  );
});

ankiTestBtn.addEventListener('click', async () => {
  const saved = await saveSettings({
    ankiConnectEnabled: ankiEnabledToggle.checked,
    ankiConnectUrl: ankiUrlInput.value,
    ankiDeckName: ankiDeckInput.value,
    ankiModelName: ankiModelInput.value,
  });
  const res = await api.testAnkiConnect(saved.ankiConnectUrl);
  updateAnkiQueueBadge(res.queueLength);
  if (res.reachable) {
    const deckCount = res.decks?.length ?? 0;
    const hasModel = res.models?.includes(saved.ankiModelName) ?? false;
    showAnkiStatus(
      `Connected to AnkiConnect v${res.version} · ${deckCount} decks · note type "${saved.ankiModelName}": ${hasModel ? 'ready' : 'will be created on first push'} · queue: ${res.queueLength}.`,
      true,
    );
  } else {
    showAnkiStatus(
      `AnkiConnect unreachable at ${saved.ankiConnectUrl}: ${res.error ?? 'Is Anki open with AnkiConnect installed?'}`,
      false,
    );
  }
});

ankiSyncBtn.addEventListener('click', async () => {
  const res = await api.flushAnkiQueue();
  updateAnkiQueueBadge(res.remaining);
  if (!res.ankiReachable) {
    showAnkiStatus(
      `Anki is not reachable yet (${res.remaining} card${res.remaining === 1 ? '' : 's'} still queued).`,
      false,
    );
    return;
  }
  showAnkiStatus(
    `Synced queue: ${res.pushed} pushed, ${res.duplicates} already in Anki, ${res.remaining} remaining${res.errors ? `, ${res.errors} errors` : ''}.`,
    res.errors === 0,
  );
});
