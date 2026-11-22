import {
  api,
  type EpisodeOut,
  type JimakuEntry,
  type JimakuFile,
  type OpenMissedPanelMessage,
  type StartAutoSyncMessage,
  type StartAutoSyncResponse,
  verifyServerConnection,
} from '../../src/api/client';
import { formatBinding, HOTKEY_ACTIONS, HOTKEY_LABELS } from '../../src/lib/hotkeys';
import {
  describeJimakuFileWarning,
  findNextImportableFile,
  formatJimakuError,
  formatJimakuFileSize,
  guessAnimeQueryFromTitle,
  isJimakuFileDimmed,
  pickDefaultJimakuFile,
  suggestNextEpisodeNumber,
} from '../../src/lib/jimaku';
import { getKeyboardLayoutMap } from '../../src/lib/keyboard-layout';
import {
  getSettings,
  isServerUrlConfigured,
  saveSettings,
  type TranslationDisplayMode,
} from '../../src/lib/settings';
import {
  buildPrimingUrl,
  extractUrlEpisodeInfo,
  filterEpisodes,
  resolveEpisodeForUrl,
} from '../../src/lib/url-mapping';

const healthBadge = document.getElementById('health-badge') as HTMLSpanElement;
const setupCard = document.getElementById('setup-card') as HTMLDivElement;
const setupForm = document.getElementById('setup-form') as HTMLFormElement;
const setupServerUrl = document.getElementById('setup-server-url') as HTMLInputElement;
const setupApiToken = document.getElementById('setup-api-token') as HTMLInputElement;
const setupStatus = document.getElementById('setup-status') as HTMLDivElement;
const serverUrlText = document.getElementById('server-url-text') as HTMLSpanElement;
const dictText = document.getElementById('dict-text') as HTMLSpanElement;
const llmText = document.getElementById('llm-text') as HTMLSpanElement;
const tabEnableToggle = document.getElementById('tab-enable-toggle') as HTMLInputElement;
const autoPauseToggle = document.getElementById('auto-pause-toggle') as HTMLInputElement;
const translationModeSelect = document.getElementById(
  'translation-mode-select',
) as HTMLSelectElement;
const pagePatternText = document.getElementById('page-pattern-text') as HTMLSpanElement;
const suggestBanner = document.getElementById('suggest-banner') as HTMLDivElement;
const suggestText = document.getElementById('suggest-text') as HTMLSpanElement;
const applySuggestBtn = document.getElementById('apply-suggest-btn') as HTMLButtonElement;
const episodeSearch = document.getElementById('episode-search') as HTMLInputElement;
const episodeSelect = document.getElementById('episode-select') as HTMLSelectElement;
const autoSyncWrap = document.getElementById('auto-sync-wrap') as HTMLDivElement;
const autoSyncBtn = document.getElementById('auto-sync-btn') as HTMLButtonElement;
const autoSyncStatus = document.getElementById('auto-sync-status') as HTMLDivElement;
const primeEpisodeBtn = document.getElementById('prime-episode-btn') as HTMLButtonElement;
const missedEpisodeBtn = document.getElementById('missed-episode-btn') as HTMLButtonElement;
const uploadForm = document.getElementById('upload-form') as HTMLFormElement;
const uploadAnime = document.getElementById('upload-anime') as HTMLInputElement;
const uploadEpNum = document.getElementById('upload-ep-num') as HTMLInputElement;
const uploadFile = document.getElementById('upload-file') as HTMLInputElement;
const uploadStatus = document.getElementById('upload-status') as HTMLDivElement;
const jimakuDetails = document.getElementById('jimaku-details') as HTMLDetailsElement;
const jimakuSearchForm = document.getElementById('jimaku-search-form') as HTMLFormElement;
const jimakuQuery = document.getElementById('jimaku-query') as HTMLInputElement;
const jimakuEntriesEl = document.getElementById('jimaku-entries') as HTMLDivElement;
const jimakuFilesSection = document.getElementById('jimaku-files-section') as HTMLDivElement;
const jimakuEpNum = document.getElementById('jimaku-ep-num') as HTMLInputElement;
const jimakuRefetchFilesBtn = document.getElementById(
  'jimaku-refetch-files-btn',
) as HTMLButtonElement;
const jimakuFilesEl = document.getElementById('jimaku-files') as HTMLDivElement;
const jimakuImportBtn = document.getElementById('jimaku-import-btn') as HTMLButtonElement;
const jimakuStatus = document.getElementById('jimaku-status') as HTMLDivElement;
const openOptionsBtn = document.getElementById('open-options-btn') as HTMLButtonElement;
const hotkeySummary = document.getElementById('hotkey-summary') as HTMLDivElement;

let activeTabId: number | null = null;
let activeTabUrl = '';
let activeTabTitle = '';
let allEpisodes: EpisodeOut[] = [];
let attachedEpisodeId: number | null = null;
let suggestedEpisode: EpisodeOut | null = null;
let currentServerUrl = '';
let jimakuSelectedEntry: JimakuEntry | null = null;
let jimakuFiles: JimakuFile[] = [];
let jimakuSelectedFileName = '';
let guessedEpFromTab: number | null = null;

function updatePrimerButton(): void {
  const url =
    attachedEpisodeId !== null ? buildPrimingUrl(currentServerUrl, attachedEpisodeId) : null;
  autoSyncWrap.style.display = attachedEpisodeId !== null ? 'block' : 'none';
  if (attachedEpisodeId === null) {
    autoSyncStatus.style.display = 'none';
    autoSyncStatus.textContent = '';
  }
  primeEpisodeBtn.style.display = url ? 'block' : 'none';
  missedEpisodeBtn.style.display = url ? 'block' : 'none';
}

function formatEpisodeLabel(ep: EpisodeOut): string {
  const anime = ep.anime_title ?? 'Anime';
  const num = ep.number !== null ? ` Ep ${ep.number}` : '';
  return `${anime}${num} (${ep.line_count} lines)`;
}

function renderEpisodeOptions(): void {
  const filtered = filterEpisodes(allEpisodes, episodeSearch.value);
  episodeSelect.innerHTML = '<option value="">None (detached)</option>';
  for (const ep of filtered) {
    const opt = document.createElement('option');
    opt.value = String(ep.id);
    opt.textContent = formatEpisodeLabel(ep);
    if (attachedEpisodeId === ep.id) {
      opt.selected = true;
    }
    episodeSelect.appendChild(opt);
  }
}

async function applyTabSelection(episodeId: number | null, enabled: boolean): Promise<void> {
  if (activeTabId === null) return;
  attachedEpisodeId = episodeId;
  tabEnableToggle.checked = enabled && episodeId !== null;
  await api.setTabState({
    tabId: activeTabId,
    pageUrl: activeTabUrl,
    episodeId,
    enabled: enabled && episodeId !== null,
  });
  renderEpisodeOptions();
  updatePrimerButton();
}

async function refreshPopup(): Promise<void> {
  const settings = await getSettings();
  currentServerUrl = settings.serverUrl;
  const configured = isServerUrlConfigured(settings.serverUrl);
  serverUrlText.textContent = configured
    ? settings.serverUrl.replace(/^https?:\/\//, '')
    : 'Not configured';
  setupServerUrl.value = settings.serverUrl;
  setupApiToken.value = settings.apiToken;
  autoPauseToggle.checked = settings.autoPauseEachLine;
  translationModeSelect.value = settings.translationMode;

  void getKeyboardLayoutMap().then((layoutMap) => {
    hotkeySummary.innerHTML = '';
    for (const action of HOTKEY_ACTIONS) {
      const row = document.createElement('div');
      row.className = 'row';
      const label = document.createElement('span');
      label.className = 'muted';
      label.textContent = HOTKEY_LABELS[action];
      const keyEl = document.createElement('span');
      keyEl.className = 'pattern-pill';
      keyEl.textContent = formatBinding(settings.hotkeys[action], layoutMap);
      row.appendChild(label);
      row.appendChild(keyEl);
      hotkeySummary.appendChild(row);
    }
  });

  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const currentTab = tabs[0];
  activeTabId = currentTab?.id ?? null;
  activeTabUrl = currentTab?.url ?? '';
  activeTabTitle = currentTab?.title ?? '';

  const titleGuess = guessAnimeQueryFromTitle(activeTabTitle);
  const urlEpInfo = extractUrlEpisodeInfo(activeTabUrl);
  guessedEpFromTab = urlEpInfo?.episodeNumber ?? titleGuess.episodeNumber;
  if (!jimakuQuery.value && titleGuess.query) {
    jimakuQuery.value = titleGuess.query;
  }
  if (!jimakuEpNum.value && guessedEpFromTab !== null) {
    jimakuEpNum.value = String(guessedEpFromTab);
  }

  const tabState = await api.getTabState(activeTabId ?? undefined, activeTabUrl);
  attachedEpisodeId = tabState.episodeId;
  tabEnableToggle.checked = tabState.enabled;
  pagePatternText.textContent = tabState.pattern ?? 'unsupported page';
  if (attachedEpisodeId === null) {
    jimakuDetails.open = true;
  }
  updatePrimerButton();

  if (!configured) {
    healthBadge.textContent = 'Setup needed';
    healthBadge.className = 'badge offline';
    dictText.textContent = '-';
    llmText.textContent = '-';
    setupCard.classList.add('visible');
    return;
  }

  const healthRes = await api.getHealth();
  if (healthRes.ok && healthRes.data) {
    const h = healthRes.data;
    healthBadge.textContent = h.status === 'ok' ? `Online v${h.version}` : h.status;
    healthBadge.className = 'badge online';
    dictText.textContent = h.dictionary ? 'Ready' : 'Not built';
    setupCard.classList.remove('visible');
  } else {
    healthBadge.textContent = 'Offline';
    healthBadge.className = 'badge offline';
    dictText.textContent = healthRes.error ?? 'Unreachable';
    llmText.textContent = '-';
    setupCard.classList.add('visible');
    setupStatus.textContent = healthRes.error ?? 'Could not reach server';
    setupStatus.className = 'setup-status err';
    return;
  }

  void api.getLlmStatus().then((llmRes) => {
    if (llmRes.ok && llmRes.data) {
      if (!llmRes.data.configured) {
        llmText.textContent = 'Not configured';
        llmText.title = 'Set up a model on the server';
      } else if (llmRes.data.reachable) {
        llmText.textContent = llmRes.data.model ?? 'Ready';
        llmText.title = llmRes.data.detail;
      } else {
        llmText.textContent = 'Unreachable';
        llmText.title = llmRes.data.detail;
      }
    } else {
      llmText.textContent = '-';
    }
  });

  const episodesRes = await api.listEpisodes();
  if (episodesRes.ok && episodesRes.data) {
    allEpisodes = episodesRes.data;
    renderEpisodeOptions();

    const resolved = resolveEpisodeForUrl(
      activeTabUrl,
      settings.urlMappings,
      allEpisodes,
    );
    if (attachedEpisodeId === null && resolved.suggestedEpisode) {
      suggestedEpisode = resolved.suggestedEpisode;
      suggestText.textContent = `Next up: ${formatEpisodeLabel(suggestedEpisode)}`;
      suggestBanner.className = 'suggest-banner visible';
    } else {
      suggestedEpisode = null;
      suggestBanner.className = 'suggest-banner';
    }
  } else if (episodesRes.status === 401) {
    setupCard.classList.add('visible');
    setupStatus.textContent = 'Connected to server, but API token is missing or invalid (401).';
    setupStatus.className = 'setup-status err';
  }
}

setupForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const nextUrl = setupServerUrl.value.trim();
  if (!isServerUrlConfigured(nextUrl)) {
    setupStatus.textContent = 'Please enter a valid http:// or https:// server URL.';
    setupStatus.className = 'setup-status err';
    return;
  }
  setupStatus.textContent = 'Testing connection...';
  setupStatus.className = 'setup-status';

  await saveSettings({
    serverUrl: nextUrl,
    apiToken: setupApiToken.value.trim(),
  });

  const check = await verifyServerConnection(api, nextUrl);
  if (check.state === 'unreachable' || check.state === 'unconfigured') {
    setupStatus.textContent = `Server unreachable: ${check.message}`;
    setupStatus.className = 'setup-status err';
    return;
  }
  if (check.state === 'unauthorized') {
    setupStatus.textContent = check.message;
    setupStatus.className = 'setup-status err';
    return;
  }

  setupStatus.textContent = `Connected & authenticated (v${check.health.version}).`;
  setupStatus.className = 'setup-status ok';
  await refreshPopup();
});

episodeSearch.addEventListener('input', () => {
  renderEpisodeOptions();
});

episodeSelect.addEventListener('change', async () => {
  const val = episodeSelect.value;
  const epId = val ? Number(val) : null;
  await applyTabSelection(epId, epId !== null);
});

tabEnableToggle.addEventListener('change', async () => {
  if (attachedEpisodeId === null) {
    tabEnableToggle.checked = false;
    return;
  }
  await applyTabSelection(attachedEpisodeId, tabEnableToggle.checked);
});

autoPauseToggle.addEventListener('change', async () => {
  await saveSettings({ autoPauseEachLine: autoPauseToggle.checked });
});

translationModeSelect.addEventListener('change', async () => {
  await saveSettings({ translationMode: translationModeSelect.value as TranslationDisplayMode });
});

applySuggestBtn.addEventListener('click', async () => {
  if (!suggestedEpisode) return;
  suggestBanner.className = 'suggest-banner';
  await applyTabSelection(suggestedEpisode.id, true);
});

uploadForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = uploadFile.files?.[0];
  if (!file) return;

  uploadStatus.textContent = 'Uploading & tokenizing...';
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  const contentBase64 = btoa(binary);

  const res = await api.uploadSubtitle({
    filename: file.name,
    contentBase64,
    animeTitle: uploadAnime.value.trim(),
    episodeNumber: uploadEpNum.value ? Number(uploadEpNum.value) : null,
  });

  if (res.ok && res.data) {
    uploadStatus.textContent = `Uploaded (${res.data.line_count} lines, ${res.data.understanding.token_pct}% known)`;
    allEpisodes = [res.data, ...allEpisodes];
    await applyTabSelection(res.data.id, true);
    uploadForm.reset();
  } else {
    uploadStatus.textContent = `Error: ${res.error ?? 'Upload failed'}`;
  }
});

primeEpisodeBtn.addEventListener('click', () => {
  if (attachedEpisodeId === null) return;
  const url = buildPrimingUrl(currentServerUrl, attachedEpisodeId);
  if (url) {
    void browser.tabs.create({ url });
  }
});

autoSyncBtn.addEventListener('click', async () => {
  if (attachedEpisodeId === null || activeTabId === null) return;
  autoSyncBtn.disabled = true;
  autoSyncStatus.style.display = 'block';
  autoSyncStatus.textContent = 'Starting 45 s audio sync on the video…';
  try {
    const res = (await browser.tabs.sendMessage(activeTabId, {
      type: 'SENSEI_START_AUTO_SYNC',
    } satisfies StartAutoSyncMessage)) as StartAutoSyncResponse | undefined;
    if (res?.ok) {
      window.close();
      return;
    }
    autoSyncStatus.textContent =
      res?.error ?? 'No active video player found on this tab. Start playback at 1× first.';
  } catch {
    autoSyncStatus.textContent =
      'No active video player found on this tab. Start playback at 1× first.';
  } finally {
    autoSyncBtn.disabled = false;
  }
});

// ---- Jimaku.cc subtitle search & 1-click import (#60) ----
function renderJimakuFiles(): void {
  jimakuFilesEl.innerHTML = '';
  jimakuImportBtn.disabled = !jimakuSelectedFileName;

  for (const file of jimakuFiles) {
    const warning = describeJimakuFileWarning(file);
    const btn = document.createElement('button');
    btn.type = 'button';
    const classes = ['jimaku-item'];
    if (!file.supported) {
      classes.push('disabled');
      btn.disabled = true;
    } else if (isJimakuFileDimmed(file)) {
      classes.push('dimmed');
    }
    if (jimakuSelectedFileName === file.name) {
      classes.push('active');
    }
    btn.className = classes.join(' ');
    if (warning) {
      btn.title = warning;
    }

    const nameEl = document.createElement('div');
    nameEl.textContent = file.name;
    nameEl.style.wordBreak = 'break-all';
    btn.appendChild(nameEl);

    const tags = document.createElement('div');
    tags.className = 'jimaku-tags';
    if (file.recommended) {
      const t = document.createElement('span');
      t.className = 'tag rec';
      t.textContent = 'Recommended';
      tags.appendChild(t);
    }
    if (file.web_source) {
      const t = document.createElement('span');
      t.className = 'tag web';
      t.textContent = 'Web';
      tags.appendChild(t);
    }
    if (file.dual_language) {
      const t = document.createElement('span');
      t.className = 'tag warn';
      t.textContent = 'JP+EN';
      t.title = 'Contains non-Japanese lines';
      tags.appendChild(t);
    }
    const fmt = document.createElement('span');
    fmt.className = 'tag';
    fmt.textContent = `${file.format.toUpperCase()} · ${formatJimakuFileSize(file.size)}`;
    tags.appendChild(fmt);
    if (!file.supported) {
      const w = document.createElement('span');
      w.className = 'tag warn';
      w.textContent = 'Unsupported';
      tags.appendChild(w);
    } else if (file.multi_episode) {
      const w = document.createElement('span');
      w.className = 'tag warn';
      w.textContent = 'Multi-ep';
      tags.appendChild(w);
    }
    btn.appendChild(tags);

    btn.addEventListener('click', () => {
      if (!file.supported) return;
      jimakuSelectedFileName = file.name;
      renderJimakuFiles();
    });
    jimakuFilesEl.appendChild(btn);
  }
}

async function fetchJimakuFilesForSelected(): Promise<void> {
  if (!jimakuSelectedEntry) return;
  const epVal = jimakuEpNum.value.trim() ? Number(jimakuEpNum.value) : null;
  jimakuStatus.textContent = 'Loading subtitle files...';
  jimakuFilesEl.innerHTML = '';
  jimakuImportBtn.disabled = true;

  const res = await api.listJimakuFiles(
    jimakuSelectedEntry.id,
    epVal !== null && Number.isFinite(epVal) ? epVal : null,
  );
  if (!res.ok || !res.data) {
    jimakuStatus.textContent = formatJimakuError(res.status, res.error);
    return;
  }

  jimakuFiles = res.data;
  const def = pickDefaultJimakuFile(jimakuFiles);
  jimakuSelectedFileName = def?.name ?? '';
  renderJimakuFiles();
  jimakuStatus.textContent =
    jimakuFiles.length > 0
      ? `${jimakuFiles.length} file(s) found.`
      : 'No files for this episode number (clear Ep # to see all).';
}

jimakuSearchForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const q = jimakuQuery.value.trim();
  if (!q) return;
  jimakuStatus.textContent = 'Searching jimaku.cc...';
  jimakuEntriesEl.innerHTML = '';
  jimakuFilesSection.style.display = 'none';
  jimakuSelectedEntry = null;
  jimakuFiles = [];
  jimakuSelectedFileName = '';

  const res = await api.searchJimaku(q);
  if (!res.ok || !res.data) {
    jimakuStatus.textContent = formatJimakuError(res.status, res.error);
    return;
  }
  if (res.data.length === 0) {
    jimakuStatus.textContent = 'No matching anime found on jimaku.cc.';
    return;
  }

  jimakuStatus.textContent = `Found ${res.data.length} anime — pick one:`;
  for (const entry of res.data) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'jimaku-item';

    const title = document.createElement('div');
    title.style.fontWeight = '600';
    title.textContent = entry.english_name || entry.name;
    btn.appendChild(title);

    const subText = [entry.japanese_name, entry.english_name ? entry.name : null]
      .filter(Boolean)
      .join(' · ');
    if (subText) {
      const sub = document.createElement('div');
      sub.className = 'jimaku-sub';
      sub.textContent = subText;
      btn.appendChild(sub);
    }

    btn.addEventListener('click', () => {
      jimakuSelectedEntry = entry;
      for (const child of Array.from(jimakuEntriesEl.children)) {
        child.classList.remove('active');
      }
      btn.classList.add('active');
      jimakuFilesSection.style.display = 'block';
      const epNum =
        guessedEpFromTab ?? suggestNextEpisodeNumber(entry, allEpisodes);
      jimakuEpNum.value = String(epNum);
      void fetchJimakuFilesForSelected();
    });
    jimakuEntriesEl.appendChild(btn);
  }
});

jimakuRefetchFilesBtn.addEventListener('click', () => {
  void fetchJimakuFilesForSelected();
});

jimakuImportBtn.addEventListener('click', async () => {
  if (!jimakuSelectedEntry || !jimakuSelectedFileName) return;
  jimakuImportBtn.disabled = true;
  jimakuStatus.textContent = 'Downloading & tokenizing...';
  const epVal = jimakuEpNum.value.trim() ? Number(jimakuEpNum.value) : null;

  const res = await api.importFromJimaku({
    entry_id: jimakuSelectedEntry.id,
    file_name: jimakuSelectedFileName,
    episode_number: epVal !== null && Number.isFinite(epVal) ? epVal : null,
  });

  if (res.ok && res.data) {
    jimakuStatus.textContent = `Imported & attached (${res.data.line_count} lines, ${res.data.understanding.token_pct}% known).`;
    allEpisodes = [res.data, ...allEpisodes];
    await applyTabSelection(res.data.id, true);
    jimakuDetails.open = false;
  } else {
    jimakuStatus.textContent = formatJimakuError(res.status, res.error);
    if (res.status === 422) {
      const next = findNextImportableFile(jimakuFiles, jimakuSelectedFileName);
      if (next) {
        jimakuSelectedFileName = next.name;
        renderJimakuFiles();
      }
    }
    jimakuImportBtn.disabled = !jimakuSelectedFileName;
  }
});

openOptionsBtn.addEventListener('click', () => {
  void browser.runtime.openOptionsPage();
});

missedEpisodeBtn.addEventListener('click', async () => {
  if (attachedEpisodeId === null) return;
  if (activeTabId !== null) {
    try {
      const res = (await browser.tabs.sendMessage(activeTabId, {
        type: 'SENSEI_OPEN_MISSED_PANEL',
      } satisfies OpenMissedPanelMessage)) as { ok?: boolean } | undefined;
      if (res?.ok) {
        window.close();
        return;
      }
    } catch {
      // Fallback to opening the web episode detail page with ?missed=1
    }
  }
  const url = buildPrimingUrl(currentServerUrl, attachedEpisodeId);
  if (url) {
    void browser.tabs.create({ url: url.replace('?prime=1', '?missed=1') });
  }
});

void refreshPopup();
