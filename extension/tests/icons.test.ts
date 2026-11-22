import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import wxtConfig, {
  CHROME_MANIFEST_PUBLIC_KEY,
  EXTENSION_ICONS,
  FIREFOX_GECKO_ID,
} from '../wxt.config';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPngDimensions(filePath: string): { width: number; height: number } {
  const buf = readFileSync(filePath);
  expect(buf.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  expect(buf.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

describe('extension icons (#124)', () => {
  it('commits valid PNGs at 16, 32, 48 and 128 px in public/icon/', () => {
    for (const size of [16, 32, 48, 128] as const) {
      const rel = EXTENSION_ICONS[size];
      expect(rel).toBe(`icon/${size}.png`);
      const fullPath = resolve(__dirname, '../public', rel);
      expect(readPngDimensions(fullPath)).toEqual({ width: size, height: size });
    }
  });

  it('wires manifest.icons and toolbar action default_icon for Chrome MV3 and Firefox MV2 without changing stable IDs', () => {
    const manifestFn = wxtConfig.manifest;
    expect(typeof manifestFn).toBe('function');
    if (typeof manifestFn !== 'function') return;

    const chromeManifest = manifestFn({
      browser: 'chrome',
      manifestVersion: 3,
      command: 'build',
      mode: 'production',
    } as never) as Record<string, unknown>;

    expect(chromeManifest.icons).toEqual(EXTENSION_ICONS);
    expect(chromeManifest.action).toEqual({ default_icon: EXTENSION_ICONS });
    expect(chromeManifest.browser_action).toBeUndefined();
    expect(chromeManifest.key).toBe(CHROME_MANIFEST_PUBLIC_KEY);

    const firefoxManifest = manifestFn({
      browser: 'firefox',
      manifestVersion: 2,
      command: 'build',
      mode: 'production',
    } as never) as Record<string, unknown>;

    expect(firefoxManifest.icons).toEqual(EXTENSION_ICONS);
    expect(firefoxManifest.browser_action).toEqual({ default_icon: EXTENSION_ICONS });
    expect(firefoxManifest.action).toBeUndefined();
    expect(firefoxManifest.browser_specific_settings).toEqual({
      gecko: { id: FIREFOX_GECKO_ID },
    });
  });

  it('displays the Sensei icon in the popup header', () => {
    const popupHtml = readFileSync(resolve(__dirname, '../entrypoints/popup/index.html'), 'utf-8');
    expect(popupHtml).toContain('class="header-icon"');
    expect(popupHtml).toContain('/icon/48.png');
  });
});
