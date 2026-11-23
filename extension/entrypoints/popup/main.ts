import {
  api,
  type AutoImportOut,
  type EpisodeOut,
  isNativeUpdateStateChangedMessage,
  isTabStateChangedMessage,
  type JimakuEntry,
  type JimakuFile,
  type OpenMissedPanelMessage,
  type StartAutoSyncMessage,
  type StartAutoSyncResponse,
  verifyServerConnection,
} from '../../src/api/client';
import {
  buildAutoSuggestionPresentation,
  decideAutoAttach,
  resolvePageEpisodeInfo,
} from '../../src/lib/auto-attach';
import { formatBinding, HOTKEY_ACTIONS, HOTKEY_LABELS } from '../../src/lib/hotkeys';
import {
  describeJimakuFileWarning,
  findNextImportableFile,
  formatJimakuError,
  formatJimakuFileSize,
  isJimakuFileDimmed,
  pickDefaultJimakuFile,
  suggestNextEpisodeNumber,
} from '../../src/lib/jimaku';
import { getKeyboardLayoutMap } from '../../src/lib/keyboard-layout';
import {
  canUseNativeUpdater,
  createInitialPopupUpdateState,
  createUpdatingPopupUpdateState,
  interpretUpdateResponse,
  type PopupUpdateUiState,
} from '../../src/lib/native-updater';
import {
  extractOverlayHostKey,
  getOverlayPositionForHost,
  withOverlayPositionForHost,
} from '../../src/lib/overlay-position';
import {
  getSettings,
  isServerUrlConfigured,
  saveSettings,
  type TranslationDisplayMode,
} from '../../src/lib/settings';
import {
  buildUpdateOneLiner,
  evaluateUpdateStatus,
  formatPopupFooterVersion,
  formatUpdateHeadline,
  formatVersionTag,
  getBuildCommit,
  getExtensionVersion,
  parseVersionInfo,
  reloadExtension,
} from '../../src/lib/update';
import {
  buildMissedUrl,
  buildPrepUrl,
  filterEpisodes,
  resolveEpisodeForUrl,
} from '../../src/lib/url-mapping';

const healthBadge = document.getElementById('health-badge') as HTMLSpanElement;
const updateBanner = document.getElementById('update-banner') as HTMLDivElement;
const updateBannerTitle = document.getElementById('update-banner-title') as HTMLDivElement;
const updateBannerMeta = document.getElementById('update-banner-meta') as HTMLDivElement;
const updateNativeRow = document.getElementById('update-native-row') as HTMLDivElement;
const updateNowBtn = document.getElementById('update-now-btn') as HTMLButtonElement;
const updateProgressText = document.getElementById('update-progress-text') as HTMLSpanElement;
const updateErrorText = document.getElementById('update-error-text') as HTMLDivElement;
const updateSetupBox = document.getElementById('update-setup-box') as HTMLDivElement;
const updateSetupTitle = document.getElementById('update-setup-title') as HTMLDivElement;
const updateSetupCmd = document.getElementById('update-setup-cmd') as HTMLElement;
const copySetupCmdBtn = document.getElementById('copy-setup-cmd-btn') as HTMLButtonElement;
const updateSetupHint = document.getElementById('update-setup-hint') as HTMLDivElement;
const updateFallbackBox = document.getElementById('update-fallback-box') as HTMLDivElement;
const updateCmdEl = document.getElementById('update-cmd') as HTMLElement;
const copyUpdateCmdBtn = document.getElementById('copy-update-cmd-btn') as HTMLButtonElement;
const reloadExtensionBtn = document.getElementById('reload-extension-btn') as HTMLButtonElement;
const popupVersionEl = document.getElementById('popup-version') as HTMLDivElement;
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
const romajiToggle = document.getElementById('romaji-toggle') as HTMLInputElement;
const translationModeSelect = document.getElementById(
  'translation-mode-select',
) as HTMLSelectElement;
const resetPositionBtn = document.getElementById('reset-position-btn') as HTMLButtonElement;
const pagePatternText = document.getElementById('page-pattern-text') as HTMLSpanElement;
const autoSuggestCard = document.getElementById('auto-suggest-card') as HTMLDivElement;
const autoSuggestTitle = document.getElementById('auto-suggest-title') as HTMLDivElement;
const autoSuggestSub = document.getElementById('auto-suggest-sub') as HTMLDivElement;
const autoSuggestMeta = document.getElementById('auto-suggest-meta') as HTMLDivElement;
const autoSuggestAttachBtn = document.getElementById(
  'auto-suggest-attach-btn',
) as HTMLButtonElement;
const autoSuggestManualBtn = document.getElementById(
  'auto-suggest-manual-btn',
) as HTMLButtonElement;
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
let pendingAutoSuggestion: AutoImportOut | null = null;
let autoSuggestSeq = 0;
let currentServerUrl = '';
let currentExtensionFolder = '';
let currentUpdateCommand = '';
let currentSetupCommand = '';
let isUpdatingExtension = false;
let backgroundUpdateState: PopupUpdateUiState | null = null;
let updatePollTimer: ReturnType<typeof setInterval> | null = null;
let jimakuSelectedEntry: JimakuEntry | null = null;
let jimakuFiles: JimakuFile[] = [];
let jimakuSelectedFileName = '';
let guessedEpFromTab: number | null = null;
let updateCheckSeq = 0;

popupVersionEl.textContent = formatPopupFooterVersion(getExtensionVersion(), getBuildCommit());

function renderUpdateBannerState(ui: PopupUpdateUiState): void {
  updateNativeRow.style.display = ui.showUpdateNow || ui.progressText ? 'flex' : 'none';
  updateNowBtn.style.display = ui.showUpdateNow ? '' : 'none';
  updateNowBtn.disabled = ui.updateNowDisabled;
  updateNowBtn.textContent = ui.updateNowLabel;

  updateProgressText.textContent = ui.progressText ?? '';
  updateProgressText.className = ui.isSuccessProgress
    ? 'update-progress-text ok'
    : 'update-progress-text';

  if (ui.errorMessage) {
    updateErrorText.textContent = ui.errorMessage;
    updateErrorText.style.display = 'block';
  } else {
    updateErrorText.textContent = '';
    updateErrorText.style.display = 'none';
  }

  if (ui.setupCommand) {
    currentSetupCommand = ui.setupCommand;
    updateSetupTitle.textContent = ui.setupTitle ?? 'One-time setup';
    updateSetupCmd.textContent = ui.setupCommand;
    updateSetupHint.textContent = ui.setupHint ?? 'Run it, then click Update now again';
    updateSetupBox.style.display = 'block';
  } else {
    currentSetupCommand = '';
    updateSetupBox.style.display = 'none';
  }

  currentUpdateCommand = ui.fallbackCommand;
  updateCmdEl.textContent = ui.fallbackCommand;
  updateFallbackBox.style.display = ui.showFallbackCommand ? 'block' : 'none';
}

function stopUpdatePoll(): void {
  if (updatePollTimer !== null) {
    clearInterval(updatePollTimer);
    updatePollTimer = null;
  }
}

function ensureUpdatePoll(): void {
  if (updatePollTimer !== null) return;
  updatePollTimer = setInterval(() => {
    void api.getNativeUpdateState().then((res) => {
      if (res.state) {
        applyBackgroundUpdateState(res.state);
      } else {
        stopUpdatePoll();
      }
    });
  }, 1500);
}

function applyBackgroundUpdateState(state: PopupUpdateUiState | null): void {
  backgroundUpdateState = state;
  isUpdatingExtension = state?.mode === 'updating' || state?.mode === 'reloading';
  if (state?.mode === 'updating') {
    ensureUpdatePoll();
  } else {
    stopUpdatePoll();
  }
  if (!state) return;

  if (state.mode === 'updating' || state.mode === 'reloading') {
    if (!updateBannerTitle.textContent) {
      updateBannerTitle.textContent = 'Updating extension…';
    }
    updateBanner.className = 'update-banner visible';
    renderUpdateBannerState(state);
    return;
  }

  if (updateBanner.classList.contains('visible')) {
    renderUpdateBannerState(state);
  }
}

function hideUpdateBanner(): void {
  if (isUpdatingExtension) return;
  updateBanner.className = 'update-banner';
  updateBannerTitle.textContent = '';
  updateBannerMeta.textContent = '';
  updateNativeRow.style.display = 'none';
  updateErrorText.style.display = 'none';
  updateSetupBox.style.display = 'none';
  updateFallbackBox.style.display = 'none';
}

async function checkForExtensionUpdate(): Promise<void> {
  const seq = ++updateCheckSeq;
  const [res, bgStateRes] = await Promise.all([
    api.getExtensionVersion(),
    api.getNativeUpdateState(),
  ]);
  if (seq !== updateCheckSeq) return;
  if (bgStateRes.state) {
    applyBackgroundUpdateState(bgStateRes.state);
  }
  if (!res.ok) {
    if (!isUpdatingExtension) {
      hideUpdateBanner();
    }
    return;
  }
  const info = parseVersionInfo(res.data);
  const status = evaluateUpdateStatus(getBuildCommit(), info);
  if (!status?.updateAvailable) {
    if (!isUpdatingExtension) {
      hideUpdateBanner();
    }
    return;
  }
  updateBannerTitle.textContent = formatUpdateHeadline(status);
  const currentVerTag = formatVersionTag(getExtensionVersion());
  const latestVerTag = formatVersionTag(status.latestVersion);
  updateBannerMeta.textContent =
    currentVerTag && latestVerTag
      ? `${currentVerTag} → ${latestVerTag} (${status.currentCommit} → ${status.latestCommit})`
      : `Installed ${status.currentCommit} → server ${status.latestCommit}`;
  if (backgroundUpdateState) {
    renderUpdateBannerState(backgroundUpdateState);
  } else {
    renderUpdateBannerState(
      createInitialPopupUpdateState({
        nativeSupported: canUseNativeUpdater(),
        serverUrl: currentServerUrl,
        extensionFolder: currentExtensionFolder,
      }),
    );
  }
  updateBanner.className = 'update-banner visible';
}

function hideAutoSuggestCard(): void {
  pendingAutoSuggestion = null;
  autoSuggestCard.className = 'auto-suggest-card';
  autoSuggestTitle.textContent = '';
  autoSuggestSub.textContent = '';
  autoSuggestMeta.textContent = '';
}

function showAutoSuggestLoading(title: string, subtitle: string): void {
  pendingAutoSuggestion = null;
  autoSuggestTitle.textContent = title;
  autoSuggestSub.textContent = subtitle;
  autoSuggestMeta.textContent = '';
  autoSuggestAttachBtn.style.display = 'none';
  autoSuggestManualBtn.textContent = 'Search manually';
  autoSuggestCard.className = 'auto-suggest-card visible';
}

function showAutoSuggestMatch(result: AutoImportOut): void {
  pendingAutoSuggestion = result;
  const pres = buildAutoSuggestionPresentation(result);
  autoSuggestTitle.textContent = pres.headline;
  autoSuggestSub.textContent = pres.subtitle;
  autoSuggestSub.style.display = pres.subtitle ? 'block' : 'none';
  autoSuggestMeta.textContent = pres.meta;
  autoSuggestMeta.style.display = pres.meta ? 'block' : 'none';
  autoSuggestAttachBtn.style.display = '';
  autoSuggestAttachBtn.disabled = false;
  autoSuggestManualBtn.textContent = 'Wrong anime? Search manually';
  autoSuggestCard.className = 'auto-suggest-card visible';
}

function openManualJimakuSearch(statusMessage?: string): void {
  autoSuggestSeq += 1;
  hideAutoSuggestCard();
  jimakuDetails.open = true;
  if (statusMessage) {
    jimakuStatus.textContent = statusMessage;
  }
  jimakuQuery.focus();
}

function upsertEpisode(ep: EpisodeOut): void {
  const existingIdx = allEpisodes.findIndex((item) => item.id === ep.id);
  if (existingIdx >= 0) {
    allEpisodes[existingIdx] = ep;
  } else {
    allEpisodes = [ep, ...allEpisodes];
  }
}

function updatePrimerButton(): void {
  const url =
    attachedEpisodeId !== null ? buildPrepUrl(currentServerUrl, attachedEpisodeId) : null;
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

async function applyTabSelection(
  episodeId: number | null,
  enabled: boolean,
  explicitAnimeId?: number | null,
): Promise<void> {
  if (activeTabId === null) return;
  if (episodeId !== null) {
    autoSuggestSeq += 1;
    hideAutoSuggestCard();
    suggestBanner.className = 'suggest-banner';
  }
  attachedEpisodeId = episodeId;
  tabEnableToggle.checked = enabled && episodeId !== null;
  const resolvedAnimeId =
    explicitAnimeId ??
    (episodeId !== null ? (allEpisodes.find((e) => e.id === episodeId)?.anime_id ?? null) : null);
  await api.setTabState({
    tabId: activeTabId,
    pageUrl: activeTabUrl,
    episodeId,
    enabled: enabled && episodeId !== null,
    animeId: resolvedAnimeId,
  });
  renderEpisodeOptions();
  updatePrimerButton();
}

async function runPopupAutoSuggestion(
  query: string,
  episodeNumber: number,
  seq: number,
): Promise<void> {
  showAutoSuggestLoading(
    `Finding "${query}" · episode ${episodeNumber}…`,
    'Checking library and jimaku.cc (first import takes a few seconds).',
  );
  const res = await api.autoImportEpisode({
    query,
    episode_number: episodeNumber,
  });
  if (seq !== autoSuggestSeq || attachedEpisodeId !== null) {
    return;
  }
  if (res.ok && res.data) {
    showAutoSuggestMatch(res.data);
  } else {
    const msg =
      res.status === 404
        ? res.error || 'No matching episode found on jimaku.cc — search manually below.'
        : formatJimakuError(res.status, res.error);
    openManualJimakuSearch(msg);
  }
}

async function runPopupAutoAttach(
  tabId: number,
  episodeNumber: number,
  seq: number,
): Promise<void> {
  showAutoSuggestLoading(
    `Auto-attaching episode ${episodeNumber}…`,
    'Using remembered series for this site.',
  );
  const res = await api.triggerAutoAttach(tabId, activeTabUrl, activeTabTitle);
  if (seq !== autoSuggestSeq || attachedEpisodeId !== null) {
    return;
  }
  if (res.status === 'attached' && res.episode) {
    upsertEpisode(res.episode);
    attachedEpisodeId = res.episode.id;
    tabEnableToggle.checked = true;
    hideAutoSuggestCard();
    suggestBanner.className = 'suggest-banner';
    jimakuDetails.open = false;
    renderEpisodeOptions();
    updatePrimerButton();
    return;
  }
  if (res.status === 'error') {
    const msg =
      res.httpStatus === 404
        ? res.error || 'No Japanese subtitles found for this episode.'
        : formatJimakuError(res.httpStatus ?? 0, res.error);
    openManualJimakuSearch(msg);
    return;
  }
  hideAutoSuggestCard();
  jimakuDetails.open = true;
}

async function refreshPopup(): Promise<void> {
  const settings = await getSettings();
  currentServerUrl = settings.serverUrl;
  currentExtensionFolder = settings.extensionFolder;
  const configured = isServerUrlConfigured(settings.serverUrl);
  serverUrlText.textContent = configured
    ? settings.serverUrl.replace(/^https?:\/\//, '')
    : 'Not configured';
  setupServerUrl.value = settings.serverUrl;
  setupApiToken.value = settings.apiToken;
  autoPauseToggle.checked = settings.autoPauseEachLine;
  romajiToggle.checked = settings.romaji;
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

  const activeHostKey = extractOverlayHostKey(activeTabUrl);
  const hasSavedPosition = Boolean(
    activeHostKey && getOverlayPositionForHost(settings.overlayPositions, activeHostKey),
  );
  resetPositionBtn.disabled = !hasSavedPosition;
  resetPositionBtn.textContent = 'Reset overlay position';
  resetPositionBtn.title = hasSavedPosition
    ? `Reset saved overlay position for ${activeHostKey}`
    : 'Overlay is at the default bottom position';

  const pageInfo = resolvePageEpisodeInfo(activeTabUrl, activeTabTitle);
  guessedEpFromTab = pageInfo.episodeNumber;
  if (!jimakuQuery.value && pageInfo.titleQuery) {
    jimakuQuery.value = pageInfo.titleQuery;
  }
  if (!jimakuEpNum.value && guessedEpFromTab !== null) {
    jimakuEpNum.value = String(guessedEpFromTab);
  }

  const [tabState, forcedManualSearch, bgUpdateRes] = await Promise.all([
    api.getTabState(activeTabId ?? undefined, activeTabUrl),
    activeTabId !== null ? api.consumeManualSearchFlag(activeTabId) : Promise.resolve(false),
    api.getNativeUpdateState(),
  ]);
  if (bgUpdateRes.state) {
    applyBackgroundUpdateState(bgUpdateRes.state);
  }
  attachedEpisodeId = tabState.episodeId;
  tabEnableToggle.checked = tabState.enabled;
  pagePatternText.textContent = tabState.pattern ?? 'unsupported page';
  hideAutoSuggestCard();
  updatePrimerButton();

  if (!configured) {
    healthBadge.textContent = 'Setup needed';
    healthBadge.className = 'badge offline';
    dictText.textContent = '-';
    llmText.textContent = '-';
    hideUpdateBanner();
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
    void checkForExtensionUpdate();
  } else {
    healthBadge.textContent = 'Offline';
    healthBadge.className = 'badge offline';
    dictText.textContent = healthRes.error ?? 'Unreachable';
    llmText.textContent = '-';
    hideUpdateBanner();
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

    if (attachedEpisodeId !== null) {
      suggestedEpisode = null;
      suggestBanner.className = 'suggest-banner';
      jimakuDetails.open = false;
      return;
    }

    if (forcedManualSearch || tabState.autoAttachNotice?.kind === 'error') {
      suggestedEpisode = null;
      suggestBanner.className = 'suggest-banner';
      openManualJimakuSearch(
        tabState.autoAttachNotice?.kind === 'error' ? tabState.autoAttachNotice.title : undefined,
      );
      return;
    }

    const decision = decideAutoAttach({
      pageUrl: activeTabUrl,
      pageTitle: activeTabTitle,
      urlMappings: settings.urlMappings,
      animeMappings: settings.animeMappings,
      isTabAttached: false,
    });

    if (decision.mode === 'auto' && activeTabId !== null) {
      suggestedEpisode = null;
      suggestBanner.className = 'suggest-banner';
      jimakuDetails.open = false;
      const seq = ++autoSuggestSeq;
      void runPopupAutoAttach(activeTabId, decision.episodeNumber, seq);
      return;
    }

    if (decision.mode === 'suggest') {
      suggestedEpisode = null;
      suggestBanner.className = 'suggest-banner';
      jimakuDetails.open = false;
      const seq = ++autoSuggestSeq;
      void runPopupAutoSuggestion(decision.query, decision.episodeNumber, seq);
      return;
    }

    // Manual flow (no episode number or no guess)
    jimakuDetails.open = true;
    const resolved = resolveEpisodeForUrl(activeTabUrl, settings.urlMappings, allEpisodes);
    if (resolved.suggestedEpisode) {
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

romajiToggle.addEventListener('change', async () => {
  await saveSettings({ romaji: romajiToggle.checked });
});

translationModeSelect.addEventListener('change', async () => {
  await saveSettings({ translationMode: translationModeSelect.value as TranslationDisplayMode });
});

resetPositionBtn.addEventListener('click', async () => {
  const host = extractOverlayHostKey(activeTabUrl);
  if (!host) return;
  const current = await getSettings();
  const nextPositions = withOverlayPositionForHost(current.overlayPositions, host, null);
  await saveSettings({ overlayPositions: nextPositions });
  resetPositionBtn.disabled = true;
  resetPositionBtn.textContent = 'Position reset';
  setTimeout(() => {
    resetPositionBtn.textContent = 'Reset overlay position';
  }, 1500);
});

autoSuggestAttachBtn.addEventListener('click', async () => {
  if (!pendingAutoSuggestion) return;
  const chosen = pendingAutoSuggestion.episode;
  autoSuggestAttachBtn.disabled = true;
  upsertEpisode(chosen);
  hideAutoSuggestCard();
  await applyTabSelection(chosen.id, true, chosen.anime_id);
  jimakuDetails.open = false;
});

autoSuggestManualBtn.addEventListener('click', () => {
  openManualJimakuSearch();
});

applySuggestBtn.addEventListener('click', async () => {
  if (!suggestedEpisode) return;
  const ep = suggestedEpisode;
  suggestBanner.className = 'suggest-banner';
  await applyTabSelection(ep.id, true, ep.anime_id);
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
    upsertEpisode(res.data);
    await applyTabSelection(res.data.id, true, res.data.anime_id);
    uploadForm.reset();
  } else {
    uploadStatus.textContent = `Error: ${res.error ?? 'Upload failed'}`;
  }
});

primeEpisodeBtn.addEventListener('click', () => {
  if (attachedEpisodeId === null) return;
  const url = buildPrepUrl(currentServerUrl, attachedEpisodeId);
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
    upsertEpisode(res.data);
    await applyTabSelection(res.data.id, true, res.data.anime_id);
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

updateNowBtn.addEventListener('click', async () => {
  if (isUpdatingExtension) return;
  const ctx = {
    serverUrl: currentServerUrl,
    extensionFolder: currentExtensionFolder,
  };
  applyBackgroundUpdateState(createUpdatingPopupUpdateState(ctx));
  const res = await api.startNativeUpdate();
  if (res.state) {
    applyBackgroundUpdateState(res.state);
  } else {
    applyBackgroundUpdateState(
      interpretUpdateResponse(
        { runtimeError: res.error ?? 'Extension background worker unavailable.' },
        ctx,
      ),
    );
  }
});

copySetupCmdBtn.addEventListener('click', async () => {
  if (!currentSetupCommand) return;
  try {
    await navigator.clipboard.writeText(currentSetupCommand);
    copySetupCmdBtn.textContent = 'Copied';
    setTimeout(() => {
      copySetupCmdBtn.textContent = 'Copy';
    }, 1500);
  } catch {
    copySetupCmdBtn.textContent = 'Copy failed';
    setTimeout(() => {
      copySetupCmdBtn.textContent = 'Copy';
    }, 1500);
  }
});

copyUpdateCmdBtn.addEventListener('click', async () => {
  const cmd =
    currentUpdateCommand || buildUpdateOneLiner(currentServerUrl, currentExtensionFolder);
  try {
    await navigator.clipboard.writeText(cmd);
    copyUpdateCmdBtn.textContent = 'Copied';
    setTimeout(() => {
      copyUpdateCmdBtn.textContent = 'Copy';
    }, 1500);
  } catch {
    copyUpdateCmdBtn.textContent = 'Copy failed';
    setTimeout(() => {
      copyUpdateCmdBtn.textContent = 'Copy';
    }, 1500);
  }
});

reloadExtensionBtn.addEventListener('click', () => {
  reloadExtension();
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
  const url = buildMissedUrl(currentServerUrl, attachedEpisodeId);
  if (url) {
    void browser.tabs.create({ url });
  }
});

browser.runtime.onMessage.addListener((msg: unknown) => {
  if (isNativeUpdateStateChangedMessage(msg)) {
    applyBackgroundUpdateState(msg.state);
    return;
  }
  if (isTabStateChangedMessage(msg) && msg.state.tabId === activeTabId) {
    if (msg.state.episodeId !== attachedEpisodeId) {
      attachedEpisodeId = msg.state.episodeId;
      tabEnableToggle.checked = msg.state.enabled;
      if (attachedEpisodeId !== null) {
        autoSuggestSeq += 1;
        hideAutoSuggestCard();
        suggestBanner.className = 'suggest-banner';
        jimakuDetails.open = false;
        if (!allEpisodes.some((e) => e.id === attachedEpisodeId)) {
          void api.listEpisodes().then((res) => {
            if (res.ok && res.data) {
              allEpisodes = res.data;
              renderEpisodeOptions();
            }
          });
        }
      }
      renderEpisodeOptions();
      updatePrimerButton();
    }
  }
});

void refreshPopup();
