import { buildUpdateOneLiner, formatVersionTag, reloadExtension } from './update';

export const NATIVE_UPDATER_HOST = 'com.sensei.updater';
export const DEFAULT_RELOAD_DELAY_MS = 400;

export type UpdaterActionRequest = { action: 'status' } | { action: 'update' };

export interface NativeMessageTransportResult {
  reply?: unknown;
  runtimeError?: string | null;
}

export type PopupUpdateMode =
  | 'idle'
  | 'manual-only'
  | 'updating'
  | 'reloading'
  | 'not-installed'
  | 'error';

export interface PopupUpdateUiState {
  mode: PopupUpdateMode;
  showUpdateNow: boolean;
  updateNowDisabled: boolean;
  updateNowLabel: string;
  progressText: string | null;
  isSuccessProgress: boolean;
  errorMessage: string | null;
  setupTitle: string | null;
  setupCommand: string | null;
  setupHint: string | null;
  showFallbackCommand: boolean;
  fallbackCommand: string;
  shouldReload: boolean;
  updatedVersion: string | null;
}

export interface UpdaterStatusDetails {
  hostVersion: number | null;
  folder: string;
  server: string | null;
  installedVersion: string;
  latestVersion: string;
  latestError: string | null;
}

export interface UpdaterStatusUiState {
  state: 'ready' | 'not-installed' | 'error';
  ok: boolean;
  summary: string;
  installCommand: string | null;
  details: UpdaterStatusDetails | null;
}

export interface UpdateResponseContext {
  serverUrl: string;
  extensionFolder?: string | null;
}

interface ChromeRuntimeNativeLike {
  sendNativeMessage?: (
    application: string,
    message: object,
    responseCallback?: (response: unknown) => void,
  ) => void;
  lastError?: { message?: string };
  getManifest?: () => { version?: string; permissions?: unknown[] };
}

interface BrowserRuntimeNativeLike {
  sendNativeMessage?: (application: string, message: object) => Promise<unknown>;
  getManifest?: () => { version?: string; permissions?: unknown[] };
}

export function buildInstallUpdaterCommand(serverUrl: string): string {
  const cleanServer = serverUrl.trim().replace(/\/+$/, '') || 'http://homeserver:8000';
  return `iwr ${cleanServer}/downloads/install-updater.ps1 -OutFile $env:TEMP\\i.ps1; powershell -ExecutionPolicy Bypass -File $env:TEMP\\i.ps1`;
}

export function isHostNotFoundError(message: string | null | undefined): boolean {
  if (typeof message !== 'string') return false;
  const lower = message.trim().toLowerCase();
  if (!lower) return false;
  return (
    lower.includes('native messaging host not found') ||
    lower.includes('no such native application') ||
    (lower.includes('native messaging') && lower.includes('not found'))
  );
}

export function canUseNativeUpdater(): boolean {
  const g = globalThis as unknown as {
    browser?: { runtime?: BrowserRuntimeNativeLike };
    chrome?: { runtime?: ChromeRuntimeNativeLike };
  };
  const manifest =
    g.browser?.runtime?.getManifest?.() ?? g.chrome?.runtime?.getManifest?.() ?? null;
  if (manifest && Array.isArray(manifest.permissions)) {
    if (!manifest.permissions.includes('nativeMessaging')) {
      return false;
    }
  }
  return (
    typeof g.chrome?.runtime?.sendNativeMessage === 'function' ||
    typeof g.browser?.runtime?.sendNativeMessage === 'function'
  );
}

export async function sendNativeUpdaterMessage(
  request: UpdaterActionRequest,
  host: string = NATIVE_UPDATER_HOST,
): Promise<NativeMessageTransportResult> {
  const g = globalThis as unknown as {
    browser?: { runtime?: BrowserRuntimeNativeLike };
    chrome?: { runtime?: ChromeRuntimeNativeLike };
  };
  const chromeRuntime = g.chrome?.runtime;
  if (typeof chromeRuntime?.sendNativeMessage === 'function') {
    return new Promise<NativeMessageTransportResult>((resolve) => {
      let settled = false;
      const finish = (res: NativeMessageTransportResult): void => {
        if (settled) return;
        settled = true;
        resolve(res);
      };
      try {
        chromeRuntime.sendNativeMessage!(host, request, (reply: unknown) => {
          const runtimeError = chromeRuntime.lastError?.message ?? null;
          finish({ reply, runtimeError });
        });
      } catch (err) {
        finish({
          runtimeError: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  const browserRuntime = g.browser?.runtime;
  if (typeof browserRuntime?.sendNativeMessage === 'function') {
    try {
      const reply = await browserRuntime.sendNativeMessage(host, request);
      return { reply, runtimeError: null };
    } catch (err) {
      return {
        runtimeError: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return {
    runtimeError: 'Native messaging is not available in this browser.',
  };
}

export function createInitialPopupUpdateState(options: {
  nativeSupported: boolean;
  serverUrl: string;
  extensionFolder?: string | null;
}): PopupUpdateUiState {
  const browserTarget = options.nativeSupported ? 'chrome' : 'firefox';
  const fallbackCommand = buildUpdateOneLiner(
    options.serverUrl,
    options.extensionFolder,
    browserTarget,
  );
  if (!options.nativeSupported) {
    return {
      mode: 'manual-only',
      showUpdateNow: false,
      updateNowDisabled: false,
      updateNowLabel: 'Update now',
      progressText: null,
      isSuccessProgress: false,
      errorMessage: null,
      setupTitle: null,
      setupCommand: null,
      setupHint: null,
      showFallbackCommand: true,
      fallbackCommand,
      shouldReload: false,
      updatedVersion: null,
    };
  }
  return {
    mode: 'idle',
    showUpdateNow: true,
    updateNowDisabled: false,
    updateNowLabel: 'Update now',
    progressText: null,
    isSuccessProgress: false,
    errorMessage: null,
    setupTitle: null,
    setupCommand: null,
    setupHint: null,
    showFallbackCommand: false,
    fallbackCommand,
    shouldReload: false,
    updatedVersion: null,
  };
}

export function createUpdatingPopupUpdateState(
  context: UpdateResponseContext,
): PopupUpdateUiState {
  return {
    mode: 'updating',
    showUpdateNow: true,
    updateNowDisabled: true,
    updateNowLabel: 'Updating…',
    progressText: 'Downloading & unpacking update (5–30 s)…',
    isSuccessProgress: false,
    errorMessage: null,
    setupTitle: null,
    setupCommand: null,
    setupHint: null,
    showFallbackCommand: false,
    fallbackCommand: buildUpdateOneLiner(context.serverUrl, context.extensionFolder, 'chrome'),
    shouldReload: false,
    updatedVersion: null,
  };
}

function asRecord(val: unknown): Record<string, unknown> | null {
  if (typeof val !== 'object' || val === null || Array.isArray(val)) return null;
  return val as Record<string, unknown>;
}

function readNonEmptyString(val: unknown): string | null {
  if (typeof val !== 'string') return null;
  const trimmed = val.trim();
  return trimmed || null;
}

export function interpretUpdateResponse(
  result: NativeMessageTransportResult,
  context: UpdateResponseContext,
): PopupUpdateUiState {
  const fallbackCommand = buildUpdateOneLiner(
    context.serverUrl,
    context.extensionFolder,
    'chrome',
  );

  const runtimeError = readNonEmptyString(result.runtimeError);
  if (runtimeError) {
    if (isHostNotFoundError(runtimeError)) {
      return {
        mode: 'not-installed',
        showUpdateNow: true,
        updateNowDisabled: false,
        updateNowLabel: 'Update now',
        progressText: null,
        isSuccessProgress: false,
        errorMessage: null,
        setupTitle: 'One-time setup',
        setupCommand: buildInstallUpdaterCommand(context.serverUrl),
        setupHint: 'Run it, then click Update now again',
        showFallbackCommand: false,
        fallbackCommand,
        shouldReload: false,
        updatedVersion: null,
      };
    }
    return {
      mode: 'error',
      showUpdateNow: true,
      updateNowDisabled: false,
      updateNowLabel: 'Update now',
      progressText: null,
      isSuccessProgress: false,
      errorMessage: runtimeError,
      setupTitle: null,
      setupCommand: null,
      setupHint: null,
      showFallbackCommand: true,
      fallbackCommand,
      shouldReload: false,
      updatedVersion: null,
    };
  }

  const reply = asRecord(result.reply);
  if (!reply) {
    return {
      mode: 'error',
      showUpdateNow: true,
      updateNowDisabled: false,
      updateNowLabel: 'Update now',
      progressText: null,
      isSuccessProgress: false,
      errorMessage: 'Updater closed without replying.',
      setupTitle: null,
      setupCommand: null,
      setupHint: null,
      showFallbackCommand: true,
      fallbackCommand,
      shouldReload: false,
      updatedVersion: null,
    };
  }

  if (reply.ok === true) {
    const version = readNonEmptyString(reply.version);
    const commit = readNonEmptyString(reply.commit);
    const label = version ? formatVersionTag(version) : commit;
    return {
      mode: 'reloading',
      showUpdateNow: false,
      updateNowDisabled: true,
      updateNowLabel: 'Updating…',
      progressText: label ? `Updated to ${label}, reloading` : 'Updated, reloading',
      isSuccessProgress: true,
      errorMessage: null,
      setupTitle: null,
      setupCommand: null,
      setupHint: null,
      showFallbackCommand: false,
      fallbackCommand,
      shouldReload: true,
      updatedVersion: version,
    };
  }

  if (reply.ok === false) {
    const error = readNonEmptyString(reply.error) ?? 'Update failed.';
    return {
      mode: 'error',
      showUpdateNow: true,
      updateNowDisabled: false,
      updateNowLabel: 'Update now',
      progressText: null,
      isSuccessProgress: false,
      errorMessage: error,
      setupTitle: null,
      setupCommand: null,
      setupHint: null,
      showFallbackCommand: true,
      fallbackCommand,
      shouldReload: false,
      updatedVersion: null,
    };
  }

  return {
    mode: 'error',
    showUpdateNow: true,
    updateNowDisabled: false,
    updateNowLabel: 'Update now',
    progressText: null,
    isSuccessProgress: false,
    errorMessage: 'Unexpected reply from updater.',
    setupTitle: null,
    setupCommand: null,
    setupHint: null,
    showFallbackCommand: true,
    fallbackCommand,
    shouldReload: false,
    updatedVersion: null,
  };
}

export function interpretStatusResponse(
  result: NativeMessageTransportResult,
  serverUrl: string,
): UpdaterStatusUiState {
  const runtimeError = readNonEmptyString(result.runtimeError);
  if (runtimeError) {
    if (isHostNotFoundError(runtimeError)) {
      return {
        state: 'not-installed',
        ok: false,
        summary:
          'One-time setup needed: native updater host is not installed. Run this in PowerShell, then click Check updater again.',
        installCommand: buildInstallUpdaterCommand(serverUrl),
        details: null,
      };
    }
    return {
      state: 'error',
      ok: false,
      summary: `Updater error: ${runtimeError}`,
      installCommand: null,
      details: null,
    };
  }

  const reply = asRecord(result.reply);
  if (!reply) {
    return {
      state: 'error',
      ok: false,
      summary: 'Updater closed without replying.',
      installCommand: null,
      details: null,
    };
  }

  if (reply.ok === false) {
    const error = readNonEmptyString(reply.error) ?? 'Unknown updater error.';
    return {
      state: 'error',
      ok: false,
      summary: `Updater error: ${error}`,
      installCommand: null,
      details: null,
    };
  }

  if (reply.ok !== true) {
    return {
      state: 'error',
      ok: false,
      summary: 'Unexpected reply from updater.',
      installCommand: null,
      details: null,
    };
  }

  const hostVersion =
    typeof reply.host_version === 'number' && Number.isFinite(reply.host_version)
      ? reply.host_version
      : null;
  const folder = readNonEmptyString(reply.folder) ?? '(unknown)';
  const server = readNonEmptyString(reply.server);
  const installedObj = asRecord(reply.installed);
  const installedRaw = installedObj ? readNonEmptyString(installedObj.version) : null;
  const installedVersion = installedRaw ? formatVersionTag(installedRaw) : 'Not found in folder';

  const latestObj = asRecord(reply.latest);
  const latestError = readNonEmptyString(reply.latest_error);
  let latestVersion = 'Unknown';
  if (latestObj) {
    const latestVerRaw = readNonEmptyString(latestObj.version);
    const latestCommit =
      readNonEmptyString(latestObj.extension_commit) ?? readNonEmptyString(latestObj.commit);
    const latestTag = latestVerRaw ? formatVersionTag(latestVerRaw) : '';
    if (latestTag && latestCommit) {
      latestVersion = `${latestTag} (${latestCommit})`;
    } else if (latestTag) {
      latestVersion = latestTag;
    } else if (latestCommit) {
      latestVersion = latestCommit;
    }
  } else if (latestError) {
    latestVersion = `Unavailable (${latestError})`;
  }

  return {
    state: 'ready',
    ok: true,
    summary: hostVersion !== null ? `Updater ready (host v${hostVersion})` : 'Updater ready',
    installCommand: null,
    details: {
      hostVersion,
      folder,
      server,
      installedVersion,
      latestVersion,
      latestError,
    },
  };
}

export interface BackgroundNativeUpdaterDeps {
  sendNativeMessage?: (
    request: UpdaterActionRequest,
    host?: string,
  ) => Promise<NativeMessageTransportResult>;
  reloadExtension?: () => boolean;
  onStateChange?: (state: PopupUpdateUiState) => void;
  reloadDelayMs?: number;
  scheduleTimeout?: (cb: () => void, ms: number) => unknown;
}

/**
 * Orchestrates the native updater in the extension background worker so closing
 * the popup mid-update cannot cancel the native host or lose the final reload (#144).
 */
export class BackgroundNativeUpdater {
  private state: PopupUpdateUiState | null = null;
  private inFlight: Promise<PopupUpdateUiState> | null = null;
  private readonly sendNativeMessage: (
    request: UpdaterActionRequest,
    host?: string,
  ) => Promise<NativeMessageTransportResult>;
  private readonly triggerReload: () => boolean;
  private readonly onStateChange?: (state: PopupUpdateUiState) => void;
  private readonly reloadDelayMs: number;
  private readonly scheduleTimeout: (cb: () => void, ms: number) => unknown;

  constructor(deps: BackgroundNativeUpdaterDeps = {}) {
    this.sendNativeMessage = deps.sendNativeMessage ?? sendNativeUpdaterMessage;
    this.triggerReload = deps.reloadExtension ?? reloadExtension;
    this.onStateChange = deps.onStateChange;
    this.reloadDelayMs = deps.reloadDelayMs ?? DEFAULT_RELOAD_DELAY_MS;
    this.scheduleTimeout = deps.scheduleTimeout ?? ((cb, ms) => setTimeout(cb, ms));
  }

  getState(): PopupUpdateUiState | null {
    return this.state;
  }

  isRunning(): boolean {
    return this.inFlight !== null || this.state?.mode === 'reloading';
  }

  waitForCurrentUpdate(): Promise<PopupUpdateUiState | null> {
    if (this.inFlight) {
      return this.inFlight;
    }
    return Promise.resolve(this.state);
  }

  startUpdate(context: UpdateResponseContext): PopupUpdateUiState {
    if (this.state && (this.inFlight !== null || this.state.mode === 'reloading')) {
      return this.state;
    }

    const updatingState = createUpdatingPopupUpdateState(context);
    this.state = updatingState;
    this.emitState(updatingState);

    const task = (async (): Promise<PopupUpdateUiState> => {
      let result: NativeMessageTransportResult;
      try {
        result = await this.sendNativeMessage({ action: 'update' }, NATIVE_UPDATER_HOST);
      } catch (err) {
        result = {
          runtimeError: err instanceof Error ? err.message : String(err),
        };
      }
      const nextState = interpretUpdateResponse(result, context);
      this.state = nextState;
      this.emitState(nextState);

      if (nextState.shouldReload) {
        if (this.reloadDelayMs <= 0) {
          this.triggerReload();
        } else {
          this.scheduleTimeout(() => {
            this.triggerReload();
          }, this.reloadDelayMs);
        }
      }

      return nextState;
    })();

    this.inFlight = task.finally(() => {
      this.inFlight = null;
    });

    return updatingState;
  }

  private emitState(state: PopupUpdateUiState): void {
    try {
      this.onStateChange?.(state);
    } catch {
      // Never let a listener failure break the update lifecycle
    }
  }
}
