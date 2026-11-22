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
  canUseNativeUpdater,
  interpretStatusResponse,
  sendNativeUpdaterMessage,
} from '../../src/lib/native-updater';
import {
  type GlossLanguage,
  getSettings,
  isServerUrlConfigured,
  saveSettings,
  type TranslationDisplayMode,
} from '../../src/lib/settings';
import { formatVersionLine, getBuildCommit, getExtensionVersion } from '../../src/lib/update';

const form = document.getElementById('settings-form') as HTMLFormElement;
const extensionVersionEl = document.getElementById('extension-version') as HTMLParagraphElement;
const checkUpdaterBtn = document.getElementById('check-updater-btn') as HTMLButtonElement;
const updaterStatusBox = document.getElementById('updater-status') as HTMLDivElement;
const updaterInstallBox = document.getElementById('updater-install-box') as HTMLDivElement;
const updaterInstallCmd = document.getElementById('updater-install-cmd') as HTMLElement;
const copyUpdaterInstallBtn = document.getElementById(
  'copy-updater-install-btn',
) as HTMLButtonElement;
const serverUrlInput = document.getElementById('server-url') as HTMLInputElement;
const apiTokenInput = document.getElementById('api-token') as HTMLInputElement;
const extensionFolderInput = document.getElementById('extension-folder') as HTMLInputElement;
const glossLangSelect = document.getElementById('gloss-lang') as HTMLSelectElement;
const translationModeSelect = document.getElementById('translation-mode') as HTMLSelectElement;
const llmStatusHint = document.getElementById('llm-status-hint') as HTMLParagraphElement;
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
const ankiImportDeckSelect = document.getElementById('anki-import-deck') as HTMLSelectElement;
const ankiImportFieldInput = document.getElementById('anki-import-field') as HTMLInputElement;
const ankiImportPreviewBtn = document.getElementById('anki-import-preview-btn') as HTMLButtonElement;
const ankiImportConfirmBtn = document.getElementById('anki-import-confirm-btn') as HTMLButtonElement;
const ankiImportStatus = document.getElementById('anki-import-status') as HTMLDivElement;

function showAnkiStatus(message: string, ok: boolean): void {
  ankiStatus.textContent = message;
  ankiStatus.className = `status ${ok ? 'ok' : 'err'}`;
}

function showAnkiImportStatus(message: string, ok: boolean): void {
  ankiImportStatus.textContent = message;
  ankiImportStatus.className = `status ${ok ? 'ok' : 'err'}`;
}

function populateAnkiImportDecks(decks: string[] | undefined): void {
  const prev = ankiImportDeckSelect.value;
  ankiImportDeckSelect.innerHTML = '';
  if (!decks || decks.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No Anki decks loaded (open Anki & click Test AnkiConnect)';
    ankiImportDeckSelect.appendChild(opt);
    return;
  }
  for (const name of decks) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    ankiImportDeckSelect.appendChild(opt);
  }
  if (prev && decks.includes(prev)) {
    ankiImportDeckSelect.value = prev;
  }
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

async function refreshLlmHint(serverUrl: string): Promise<void> {
  if (!isServerUrlConfigured(serverUrl)) {
    llmStatusHint.textContent =
      'Tip: leave Off and use the Reveal Translation hotkey to peek at a single line.';
    return;
  }
  const res = await api.getLlmStatus();
  if (!res.ok || !res.data) {
    return;
  }
  if (!res.data.configured) {
    llmStatusHint.textContent =
      'Server LLM not configured — set up a model on the server to enable translations & Explain Line.';
  } else if (res.data.reachable) {
    llmStatusHint.textContent = `Server LLM ready (${res.data.model}). Tip: leave Off and use the Reveal Translation hotkey to peek.`;
  } else {
    llmStatusHint.textContent = `Server LLM configured (${res.data.model}) but unreachable: ${res.data.detail}`;
  }
}

async function init(): Promise<void> {
  extensionVersionEl.textContent = formatVersionLine(getBuildCommit(), getExtensionVersion());
  if (!canUseNativeUpdater()) {
    checkUpdaterBtn.style.display = 'none';
  }
  const settings = await getSettings();
  serverUrlInput.value = settings.serverUrl;
  apiTokenInput.value = settings.apiToken;
  extensionFolderInput.value = settings.extensionFolder;
  glossLangSelect.value = settings.glossLang;
  translationModeSelect.value = settings.translationMode;
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
  void refreshLlmHint(settings.serverUrl);
  const probe = await api.testAnkiConnect(settings.ankiConnectUrl);
  updateAnkiQueueBadge(probe.queueLength);
  if (probe.reachable) {
    populateAnkiImportDecks(probe.decks);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const saved = await saveSettings({
    serverUrl: serverUrlInput.value,
    apiToken: apiTokenInput.value,
    extensionFolder: extensionFolderInput.value,
    glossLang: glossLangSelect.value as GlossLanguage,
    translationMode: translationModeSelect.value as TranslationDisplayMode,
    highlightLimit: Number(highlightLimitInput.value),
    hoverDelayMs: Number(hoverDelayInput.value),
    pauseOnHover: pauseOnHoverToggle.checked,
    requireShiftForHover: shiftHoverToggle.checked,
    autoPauseEachLine: autoPauseToggle.checked,
    romaji: romajiToggle.checked,
  });
  serverUrlInput.value = saved.serverUrl;
  extensionFolderInput.value = saved.extensionFolder;
  highlightLimitInput.value = String(saved.highlightLimit);
  hoverDelayInput.value = String(saved.hoverDelayMs);
  updateFirstRunBanner(saved.serverUrl);
  showStatus('Settings saved.', true);
});

testBtn.addEventListener('click', async () => {
  const saved = await saveSettings({
    serverUrl: serverUrlInput.value,
    apiToken: apiTokenInput.value,
    extensionFolder: extensionFolderInput.value,
    glossLang: glossLangSelect.value as GlossLanguage,
    translationMode: translationModeSelect.value as TranslationDisplayMode,
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
    void refreshLlmHint(saved.serverUrl);
  } else if (check.state === 'unauthorized') {
    showStatus(check.message, false);
  } else {
    showStatus(`Server unreachable: ${check.message}`, false);
  }
});

let currentUpdaterInstallCmd = '';

checkUpdaterBtn.addEventListener('click', async () => {
  checkUpdaterBtn.disabled = true;
  updaterInstallBox.style.display = 'none';
  currentUpdaterInstallCmd = '';
  updaterStatusBox.textContent = 'Checking updater…';
  updaterStatusBox.className = 'status ok';
  try {
    const res = await sendNativeUpdaterMessage({ action: 'status' });
    const ui = interpretStatusResponse(res, serverUrlInput.value.trim());
    updaterStatusBox.innerHTML = '';
    const summaryEl = document.createElement('div');
    summaryEl.textContent = ui.summary;
    updaterStatusBox.appendChild(summaryEl);

    if (ui.details) {
      const lines = [
        `Folder: ${ui.details.folder}`,
        `Installed: ${ui.details.installedVersion}`,
        `Latest: ${ui.details.latestVersion}`,
      ];
      for (const line of lines) {
        const lineEl = document.createElement('div');
        lineEl.className = 'updater-detail-line';
        lineEl.textContent = line;
        updaterStatusBox.appendChild(lineEl);
      }
    }

    updaterStatusBox.className = `status ${ui.ok ? 'ok' : 'err'}`;
    if (ui.installCommand) {
      currentUpdaterInstallCmd = ui.installCommand;
      updaterInstallCmd.textContent = ui.installCommand;
      updaterInstallBox.style.display = 'block';
    }
  } finally {
    checkUpdaterBtn.disabled = false;
  }
});

copyUpdaterInstallBtn.addEventListener('click', async () => {
  if (!currentUpdaterInstallCmd) return;
  try {
    await navigator.clipboard.writeText(currentUpdaterInstallCmd);
    copyUpdaterInstallBtn.textContent = 'Copied';
    setTimeout(() => {
      copyUpdaterInstallBtn.textContent = 'Copy';
    }, 1500);
  } catch {
    copyUpdaterInstallBtn.textContent = 'Copy failed';
    setTimeout(() => {
      copyUpdaterInstallBtn.textContent = 'Copy';
    }, 1500);
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
    populateAnkiImportDecks(res.decks);
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

async function runAnkiImport(dryRun: boolean): Promise<void> {
  const deck = ankiImportDeckSelect.value.trim();
  if (!deck) {
    showAnkiImportStatus('Pick an Anki deck first (click Test AnkiConnect to load decks).', false);
    return;
  }
  ankiImportPreviewBtn.disabled = true;
  ankiImportConfirmBtn.disabled = true;
  showAnkiImportStatus(
    dryRun ? `Previewing "${deck}"…` : `Importing known words from "${deck}"…`,
    true,
  );
  try {
    const res = await api.importAnkiDeck({
      deck,
      fieldName: ankiImportFieldInput.value.trim() || undefined,
      matureDays: 21,
      dryRun,
    });
    if (!res.ok || !res.report) {
      showAnkiImportStatus(`Import failed: ${res.error ?? 'Unknown error'}`, false);
      return;
    }
    if (dryRun && !ankiImportFieldInput.value.trim() && res.fieldUsed) {
      ankiImportFieldInput.value = res.fieldUsed;
    }
    const r = res.report;
    const verb = dryRun ? 'Preview (nothing saved): would update' : 'Imported! Updated';
    const fieldsHint =
      res.fields && res.fields.length > 0
        ? ` · field "${res.fieldUsed || 'auto'}" (available: ${res.fields.slice(0, 6).join(', ')})`
        : '';
    showAnkiImportStatus(
      `${verb} ${r.updated} words (${r.matched} matched, ${r.already} already set, ${r.skipped_new} unstudied skipped, ${r.unmatched_count} unmatched)${fieldsHint}.`,
      true,
    );
  } finally {
    ankiImportPreviewBtn.disabled = false;
    ankiImportConfirmBtn.disabled = false;
  }
}

ankiImportPreviewBtn.addEventListener('click', () => void runAnkiImport(true));
ankiImportConfirmBtn.addEventListener('click', () => void runAnkiImport(false));
