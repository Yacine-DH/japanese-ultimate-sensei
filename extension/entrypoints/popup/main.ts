import { api, type EpisodeOut, verifyServerConnection } from '../../src/api/client';
import { formatBinding, HOTKEY_ACTIONS, HOTKEY_LABELS } from '../../src/lib/hotkeys';
import { getKeyboardLayoutMap } from '../../src/lib/keyboard-layout';
import { getSettings, isServerUrlConfigured, saveSettings } from '../../src/lib/settings';
import { filterEpisodes, resolveEpisodeForUrl } from '../../src/lib/url-mapping';

const healthBadge = document.getElementById('health-badge') as HTMLSpanElement;
const setupCard = document.getElementById('setup-card') as HTMLDivElement;
const setupForm = document.getElementById('setup-form') as HTMLFormElement;
const setupServerUrl = document.getElementById('setup-server-url') as HTMLInputElement;
const setupApiToken = document.getElementById('setup-api-token') as HTMLInputElement;
const setupStatus = document.getElementById('setup-status') as HTMLDivElement;
const serverUrlText = document.getElementById('server-url-text') as HTMLSpanElement;
const dictText = document.getElementById('dict-text') as HTMLSpanElement;
const tabEnableToggle = document.getElementById('tab-enable-toggle') as HTMLInputElement;
const autoPauseToggle = document.getElementById('auto-pause-toggle') as HTMLInputElement;
const pagePatternText = document.getElementById('page-pattern-text') as HTMLSpanElement;
const suggestBanner = document.getElementById('suggest-banner') as HTMLDivElement;
const suggestText = document.getElementById('suggest-text') as HTMLSpanElement;
const applySuggestBtn = document.getElementById('apply-suggest-btn') as HTMLButtonElement;
const episodeSearch = document.getElementById('episode-search') as HTMLInputElement;
const episodeSelect = document.getElementById('episode-select') as HTMLSelectElement;
const uploadForm = document.getElementById('upload-form') as HTMLFormElement;
const uploadAnime = document.getElementById('upload-anime') as HTMLInputElement;
const uploadEpNum = document.getElementById('upload-ep-num') as HTMLInputElement;
const uploadFile = document.getElementById('upload-file') as HTMLInputElement;
const uploadStatus = document.getElementById('upload-status') as HTMLDivElement;
const openOptionsBtn = document.getElementById('open-options-btn') as HTMLButtonElement;
const hotkeySummary = document.getElementById('hotkey-summary') as HTMLDivElement;

let activeTabId: number | null = null;
let activeTabUrl = '';
let allEpisodes: EpisodeOut[] = [];
let attachedEpisodeId: number | null = null;
let suggestedEpisode: EpisodeOut | null = null;

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
}

async function refreshPopup(): Promise<void> {
  const settings = await getSettings();
  const configured = isServerUrlConfigured(settings.serverUrl);
  serverUrlText.textContent = configured
    ? settings.serverUrl.replace(/^https?:\/\//, '')
    : 'Not configured';
  setupServerUrl.value = settings.serverUrl;
  setupApiToken.value = settings.apiToken;
  autoPauseToggle.checked = settings.autoPauseEachLine;

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

  const tabState = await api.getTabState(activeTabId ?? undefined, activeTabUrl);
  attachedEpisodeId = tabState.episodeId;
  tabEnableToggle.checked = tabState.enabled;
  pagePatternText.textContent = tabState.pattern ?? 'unsupported page';

  if (!configured) {
    healthBadge.textContent = 'Setup needed';
    healthBadge.className = 'badge offline';
    dictText.textContent = '-';
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
    setupCard.classList.add('visible');
    setupStatus.textContent = healthRes.error ?? 'Could not reach server';
    setupStatus.className = 'setup-status err';
    return;
  }

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

openOptionsBtn.addEventListener('click', () => {
  void browser.runtime.openOptionsPage();
});

void refreshPopup();
