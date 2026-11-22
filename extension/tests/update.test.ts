import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeApiCall } from '../src/api/client';
import {
  evaluateUpdateStatus,
  formatBuiltAt,
  formatUpdateHeadline,
  formatVersionLine,
  getBuildCommit,
  isSameCommit,
  parseVersionInfo,
  reloadExtension,
  UPDATE_POWERSHELL_COMMAND,
} from '../src/lib/update';
import wxtConfig, { CHROME_MANIFEST_PUBLIC_KEY, FIREFOX_GECKO_ID } from '../wxt.config';

describe('extension update helpers (#110)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    const g = globalThis as Record<string, unknown>;
    delete g.browser;
    delete g.chrome;
  });

  it('parses valid version.json payloads and rejects HTML or malformed responses', () => {
    expect(
      parseVersionInfo({ commit: '00e5b8c', built_at: '2026-11-22T17:40:00Z' }),
    ).toEqual({
      commit: '00e5b8c',
      built_at: '2026-11-22T17:40:00Z',
    });

    expect(
      parseVersionInfo('{"commit":" 00e5b8c ","built_at":"2026-11-22T17:40:00Z"}'),
    ).toEqual({
      commit: '00e5b8c',
      built_at: '2026-11-22T17:40:00Z',
    });

    expect(parseVersionInfo({ commit: '00e5b8c' })).toEqual({
      commit: '00e5b8c',
      built_at: null,
    });

    expect(parseVersionInfo('<!doctype html><html><body>SPA</body></html>')).toBeNull();
    expect(parseVersionInfo({ commit: '   ' })).toBeNull();
    expect(parseVersionInfo(null)).toBeNull();
    expect(parseVersionInfo(['00e5b8c'])).toBeNull();
  });

  it('compares short and full git commits cleanly', () => {
    expect(isSameCommit('00e5b8c', '00e5b8c')).toBe(true);
    expect(isSameCommit('00E5B8C', '00e5b8c')).toBe(true);
    expect(isSameCommit('00e5b8c', '00e5b8c9a1b2')).toBe(true);
    expect(isSameCommit('a8afb70', '00e5b8c')).toBe(false);
    expect(isSameCommit('', '00e5b8c')).toBe(false);
  });

  it('evaluates update availability without false positives for unknown local builds', () => {
    const outdated = evaluateUpdateStatus('a8afb70', {
      commit: '00e5b8c',
      built_at: '2026-11-22T17:40:00Z',
    });
    expect(outdated).toEqual({
      currentCommit: 'a8afb70',
      latestCommit: '00e5b8c',
      builtAt: '2026-11-22T17:40:00Z',
      updateAvailable: true,
    });

    const current = evaluateUpdateStatus('00e5b8c', {
      commit: '00e5b8c',
      built_at: '2026-11-22T17:40:00Z',
    });
    expect(current?.updateAvailable).toBe(false);

    const unknownLocal = evaluateUpdateStatus('unknown', {
      commit: '00e5b8c',
      built_at: '2026-11-22T17:40:00Z',
    });
    expect(unknownLocal?.updateAvailable).toBe(false);

    expect(evaluateUpdateStatus('a8afb70', null)).toBeNull();
  });

  it('formats build timestamp, update headline, and options version line', () => {
    expect(formatBuiltAt('2026-11-22T17:40:12Z')).toBe('2026-11-22 17:40 UTC');
    expect(formatBuiltAt('not-a-date')).toBe('');
    expect(formatBuiltAt(null)).toBe('');

    expect(
      formatUpdateHeadline({
        currentCommit: 'a8afb70',
        latestCommit: '00e5b8c',
        builtAt: '2026-11-22T17:40:12Z',
        updateAvailable: true,
      }),
    ).toBe('Update available (built 2026-11-22 17:40 UTC)');

    expect(
      formatUpdateHeadline({
        currentCommit: 'a8afb70',
        latestCommit: '00e5b8c',
        builtAt: null,
        updateAvailable: true,
      }),
    ).toBe('Update available (00e5b8c)');

    expect(formatVersionLine('a8afb70')).toBe('Version: a8afb70');
    expect(formatVersionLine('')).toBe('Version: unknown');
    expect(getBuildCommit('  00e5b8c  ')).toBe('00e5b8c');
    expect(getBuildCommit('')).toBe('unknown');
  });

  it('invokes browser.runtime.reload() or chrome.runtime.reload() when reloading', () => {
    expect(reloadExtension()).toBe(false);

    const browserReload = vi.fn();
    (globalThis as Record<string, unknown>).browser = { runtime: { reload: browserReload } };
    expect(reloadExtension()).toBe(true);
    expect(browserReload).toHaveBeenCalledTimes(1);

    delete (globalThis as Record<string, unknown>).browser;
    const chromeReload = vi.fn();
    (globalThis as Record<string, unknown>).chrome = { runtime: { reload: chromeReload } };
    expect(reloadExtension()).toBe(true);
    expect(chromeReload).toHaveBeenCalledTimes(1);
  });

  it('forwards cache: no-store when fetching /downloads/version.json', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ commit: '00e5b8c', built_at: '2026-11-22T17:40:00Z' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const res = await executeApiCall(
      { serverUrl: 'http://sensei:8000', apiToken: '' },
      '/downloads/version.json',
      { cache: 'no-store' },
      mockFetch as unknown as typeof fetch,
    );

    expect(res.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://sensei:8000/downloads/version.json',
      expect.objectContaining({ method: 'GET', cache: 'no-store' }),
    );
  });
});

describe('manifest stable ID and update UI wiring (#110)', () => {
  it('sets Chromium manifest key and Firefox gecko ID cleanly per target browser', () => {
    const manifestFn = wxtConfig.manifest;
    expect(typeof manifestFn).toBe('function');
    if (typeof manifestFn !== 'function') return;

    const chromeManifest = manifestFn({ browser: 'chrome', manifestVersion: 3, command: 'build', mode: 'production' } as never) as Record<string, unknown>;
    expect(chromeManifest.key).toBe(CHROME_MANIFEST_PUBLIC_KEY);
    expect(CHROME_MANIFEST_PUBLIC_KEY.startsWith('MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A')).toBe(true);
    expect(chromeManifest.browser_specific_settings).toBeUndefined();

    const firefoxManifest = manifestFn({ browser: 'firefox', manifestVersion: 2, command: 'build', mode: 'production' } as never) as Record<string, unknown>;
    expect(firefoxManifest.key).toBeUndefined();
    expect(firefoxManifest.browser_specific_settings).toEqual({
      gecko: { id: FIREFOX_GECKO_ID },
    });
  });

  it('wires update banner, PowerShell command, Reload button, and options version line', () => {
    const popupHtml = readFileSync(resolve(__dirname, '../entrypoints/popup/index.html'), 'utf-8');
    const popupMain = readFileSync(resolve(__dirname, '../entrypoints/popup/main.ts'), 'utf-8');
    const optionsHtml = readFileSync(resolve(__dirname, '../entrypoints/options/index.html'), 'utf-8');
    const optionsMain = readFileSync(resolve(__dirname, '../entrypoints/options/main.ts'), 'utf-8');

    expect(popupHtml).toContain('id="update-banner"');
    expect(popupHtml).toContain('id="reload-extension-btn"');
    expect(popupHtml).toContain(UPDATE_POWERSHELL_COMMAND);
    expect(popupMain).toContain('checkForExtensionUpdate');
    expect(popupMain).toContain('reloadExtension()');

    expect(optionsHtml).toContain('id="extension-version"');
    expect(optionsMain).toContain('formatVersionLine(getBuildCommit())');
  });
});
