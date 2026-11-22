import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildInstallUpdaterCommand,
  canUseNativeUpdater,
  createInitialPopupUpdateState,
  createUpdatingPopupUpdateState,
  interpretStatusResponse,
  interpretUpdateResponse,
  isHostNotFoundError,
  NATIVE_UPDATER_HOST,
  sendNativeUpdaterMessage,
} from '../src/lib/native-updater';

describe('native updater helpers (#141)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    const g = globalThis as Record<string, unknown>;
    delete g.browser;
    delete g.chrome;
  });

  it('builds the one-time setup PowerShell command for the configured server', () => {
    expect(buildInstallUpdaterCommand('http://barkhausstr64:8000/')).toBe(
      'iwr http://barkhausstr64:8000/downloads/install-updater.ps1 -OutFile $env:TEMP\\i.ps1; powershell -ExecutionPolicy Bypass -File $env:TEMP\\i.ps1',
    );
    expect(buildInstallUpdaterCommand('   ')).toBe(
      'iwr http://homeserver:8000/downloads/install-updater.ps1 -OutFile $env:TEMP\\i.ps1; powershell -ExecutionPolicy Bypass -File $env:TEMP\\i.ps1',
    );
  });

  it('recognizes Chrome/Edge native messaging host-not-found errors', () => {
    expect(isHostNotFoundError('Specified native messaging host not found.')).toBe(true);
    expect(isHostNotFoundError('specified native messaging host not found')).toBe(true);
    expect(isHostNotFoundError('No such native application com.sensei.updater')).toBe(true);
    expect(isHostNotFoundError('Native host has exited.')).toBe(false);
    expect(isHostNotFoundError(null)).toBe(false);
    expect(isHostNotFoundError('')).toBe(false);
  });

  it('checks manifest permissions and runtime API when deciding whether native updater is supported', () => {
    expect(canUseNativeUpdater()).toBe(false);

    // Chrome build with nativeMessaging permission
    (globalThis as Record<string, unknown>).chrome = {
      runtime: {
        getManifest: () => ({
          version: '0.1.32',
          permissions: ['storage', 'activeTab', 'tabs', 'nativeMessaging'],
        }),
        sendNativeMessage: vi.fn(),
      },
    };
    expect(canUseNativeUpdater()).toBe(true);

    // Firefox build without nativeMessaging permission keeps manual flow
    delete (globalThis as Record<string, unknown>).chrome;
    (globalThis as Record<string, unknown>).browser = {
      runtime: {
        getManifest: () => ({
          version: '0.1.32',
          permissions: ['storage', 'activeTab', 'tabs'],
        }),
        sendNativeMessage: vi.fn(),
      },
    };
    expect(canUseNativeUpdater()).toBe(false);
  });

  it('sends messages via chrome.runtime.sendNativeMessage and surfaces lastError', async () => {
    const sendNativeMessage = vi.fn(
      (host: string, msg: object, cb: (reply: unknown) => void) => {
        expect(host).toBe(NATIVE_UPDATER_HOST);
        expect(msg).toEqual({ action: 'update' });
        cb({ ok: true, version: '0.1.33', commit: 'abc1234', files: 12, removed: 1 });
      },
    );
    (globalThis as Record<string, unknown>).chrome = {
      runtime: { sendNativeMessage, lastError: undefined },
    };

    const okRes = await sendNativeUpdaterMessage({ action: 'update' });
    expect(okRes).toEqual({
      reply: { ok: true, version: '0.1.33', commit: 'abc1234', files: 12, removed: 1 },
      runtimeError: null,
    });

    // Simulate Chrome setting chrome.runtime.lastError when host is missing
    const missingFn = vi.fn((_host: string, _msg: object, cb: (reply: unknown) => void) => {
      ((globalThis as Record<string, unknown>).chrome as { runtime: { lastError?: { message: string } } }).runtime.lastError = {
        message: 'Specified native messaging host not found.',
      };
      cb(undefined);
    });
    (globalThis as Record<string, unknown>).chrome = {
      runtime: { sendNativeMessage: missingFn, lastError: undefined },
    };

    const errRes = await sendNativeUpdaterMessage({ action: 'status' });
    expect(errRes).toEqual({
      reply: undefined,
      runtimeError: 'Specified native messaging host not found.',
    });
  });

  it('produces initial Chrome (Update now) and Firefox (manual-only) popup banner states', () => {
    const chromeState = createInitialPopupUpdateState({
      nativeSupported: true,
      serverUrl: 'http://barkhausstr64:8000',
      extensionFolder: 'C:\\Sensei',
    });
    expect(chromeState.mode).toBe('idle');
    expect(chromeState.showUpdateNow).toBe(true);
    expect(chromeState.showFallbackCommand).toBe(false);

    const firefoxState = createInitialPopupUpdateState({
      nativeSupported: false,
      serverUrl: 'http://barkhausstr64:8000',
      extensionFolder: 'C:\\Sensei',
    });
    expect(firefoxState.mode).toBe('manual-only');
    expect(firefoxState.showUpdateNow).toBe(false);
    expect(firefoxState.showFallbackCommand).toBe(true);
    expect(firefoxState.fallbackCommand).toContain('sensei-extension-firefox.zip');

    const updatingState = createUpdatingPopupUpdateState({
      serverUrl: 'http://barkhausstr64:8000',
      extensionFolder: 'C:\\Sensei',
    });
    expect(updatingState.mode).toBe('updating');
    expect(updatingState.updateNowDisabled).toBe(true);
    expect(updatingState.progressText).toContain('5–30 s');
  });

  it('interprets {ok: true, version} update reply into reloading state', () => {
    const ui = interpretUpdateResponse(
      {
        reply: { ok: true, version: '0.1.33', commit: '9988776', files: 18, removed: 2 },
        runtimeError: null,
      },
      { serverUrl: 'http://barkhausstr64:8000', extensionFolder: 'C:\\Sensei' },
    );
    expect(ui.mode).toBe('reloading');
    expect(ui.shouldReload).toBe(true);
    expect(ui.progressText).toBe('Updated to v0.1.33, reloading');
    expect(ui.isSuccessProgress).toBe(true);
    expect(ui.updatedVersion).toBe('0.1.33');
    expect(ui.showFallbackCommand).toBe(false);
  });

  it('interprets {ok: false, error} update reply into error state with copy-command fallback', () => {
    const ui = interpretUpdateResponse(
      {
        reply: { ok: false, error: 'Download check failed (sha256 mismatch).' },
        runtimeError: null,
      },
      { serverUrl: 'http://barkhausstr64:8000', extensionFolder: 'D:\\Sensei' },
    );
    expect(ui.mode).toBe('error');
    expect(ui.shouldReload).toBe(false);
    expect(ui.errorMessage).toBe('Download check failed (sha256 mismatch).');
    expect(ui.showFallbackCommand).toBe(true);
    expect(ui.showUpdateNow).toBe(true);
    expect(ui.fallbackCommand).toContain('D:\\Sensei');
    expect(ui.fallbackCommand).toContain('http://barkhausstr64:8000/downloads/sensei-extension-chrome.zip');
  });

  it('interprets host-not-found runtimeError into one-time setup state', () => {
    const ui = interpretUpdateResponse(
      {
        reply: undefined,
        runtimeError: 'Specified native messaging host not found.',
      },
      { serverUrl: 'http://barkhausstr64:8000/' },
    );
    expect(ui.mode).toBe('not-installed');
    expect(ui.shouldReload).toBe(false);
    expect(ui.setupTitle).toBe('One-time setup');
    expect(ui.setupCommand).toBe(
      'iwr http://barkhausstr64:8000/downloads/install-updater.ps1 -OutFile $env:TEMP\\i.ps1; powershell -ExecutionPolicy Bypass -File $env:TEMP\\i.ps1',
    );
    expect(ui.setupHint).toBe('Run it, then click Update now again');
    expect(ui.showUpdateNow).toBe(true);
    expect(ui.showFallbackCommand).toBe(false);
  });

  it('interprets other runtime errors and empty replies into error state with fallback', () => {
    const exited = interpretUpdateResponse(
      { reply: undefined, runtimeError: 'Native host has exited.' },
      { serverUrl: 'http://barkhausstr64:8000' },
    );
    expect(exited.mode).toBe('error');
    expect(exited.errorMessage).toBe('Native host has exited.');
    expect(exited.showFallbackCommand).toBe(true);

    const empty = interpretUpdateResponse(
      { reply: undefined, runtimeError: null },
      { serverUrl: 'http://barkhausstr64:8000' },
    );
    expect(empty.mode).toBe('error');
    expect(empty.errorMessage).toBe('Updater closed without replying.');
    expect(empty.showFallbackCommand).toBe(true);
  });

  it('interprets status reply with folder, installed version, and latest version', () => {
    const ui = interpretStatusResponse(
      {
        reply: {
          ok: true,
          host_version: 1,
          folder: 'C:\\Users\\owner\\Documents\\sensei-extension',
          server: 'http://barkhausstr64:8000',
          installed: { version: '0.1.32' },
          latest: {
            version: '0.1.33',
            commit: 'deadbee',
            extension_commit: 'abc1234',
            built_at: '2026-11-22T22:00:00Z',
          },
          latest_error: null,
        },
        runtimeError: null,
      },
      'http://barkhausstr64:8000',
    );
    expect(ui).toEqual({
      state: 'ready',
      ok: true,
      summary: 'Updater ready (host v1)',
      installCommand: null,
      details: {
        hostVersion: 1,
        folder: 'C:\\Users\\owner\\Documents\\sensei-extension',
        server: 'http://barkhausstr64:8000',
        installedVersion: 'v0.1.32',
        latestVersion: 'v0.1.33 (abc1234)',
        latestError: null,
      },
    });
  });

  it('interprets status reply when installed manifest is missing or latest fetch failed', () => {
    const ui = interpretStatusResponse(
      {
        reply: {
          ok: true,
          host_version: 1,
          folder: 'C:\\Sensei',
          server: 'http://barkhausstr64:8000',
          installed: null,
          latest: null,
          latest_error: 'Unable to connect to the remote server',
        },
        runtimeError: null,
      },
      'http://barkhausstr64:8000',
    );
    expect(ui.state).toBe('ready');
    expect(ui.details?.installedVersion).toBe('Not found in folder');
    expect(ui.details?.latestVersion).toBe(
      'Unavailable (Unable to connect to the remote server)',
    );
  });

  it('interprets status host-not-found and host errors cleanly', () => {
    const missing = interpretStatusResponse(
      { runtimeError: 'Specified native messaging host not found.' },
      'http://barkhausstr64:8000',
    );
    expect(missing.state).toBe('not-installed');
    expect(missing.ok).toBe(false);
    expect(missing.installCommand).toContain('install-updater.ps1');

    const hostErr = interpretStatusResponse(
      { reply: { ok: false, error: 'config.json missing' }, runtimeError: null },
      'http://barkhausstr64:8000',
    );
    expect(hostErr.state).toBe('error');
    expect(hostErr.ok).toBe(false);
    expect(hostErr.summary).toContain('config.json missing');
  });

  it('wires Update now, One-time setup, popup version footer, and Options Check updater', () => {
    const popupHtml = readFileSync(resolve(__dirname, '../entrypoints/popup/index.html'), 'utf-8');
    const popupMain = readFileSync(resolve(__dirname, '../entrypoints/popup/main.ts'), 'utf-8');
    const optionsHtml = readFileSync(
      resolve(__dirname, '../entrypoints/options/index.html'),
      'utf-8',
    );
    const optionsMain = readFileSync(
      resolve(__dirname, '../entrypoints/options/main.ts'),
      'utf-8',
    );

    expect(popupHtml).toContain('id="update-now-btn"');
    expect(popupHtml).toContain('id="update-setup-box"');
    expect(popupHtml).toContain('id="popup-version"');
    expect(popupMain).toContain("sendNativeUpdaterMessage({ action: 'update' })");
    expect(popupMain).toContain('interpretUpdateResponse');
    expect(popupMain).toContain('formatPopupFooterVersion');

    expect(optionsHtml).toContain('id="check-updater-btn"');
    expect(optionsHtml).toContain('id="updater-status"');
    expect(optionsMain).toContain("sendNativeUpdaterMessage({ action: 'status' })");
    expect(optionsMain).toContain('interpretStatusResponse');
  });
});
