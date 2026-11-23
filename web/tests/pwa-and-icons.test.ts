import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const PUBLIC_DIR = resolve(__dirname, '../public');
const INDEX_HTML_PATH = resolve(__dirname, '../index.html');

function readPngDimensions(filePath: string): { width: number; height: number } {
  const buf = readFileSync(filePath);
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  expect(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
    true,
  );
  // IHDR width & height at bytes 16..23 (big-endian uint32)
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

describe('web favicon & PWA manifest (#133)', () => {
  it('ships valid favicon.ico and expected PNG icon dimensions in web/public/', () => {
    const icoPath = resolve(PUBLIC_DIR, 'favicon.ico');
    expect(existsSync(icoPath)).toBe(true);
    const ico = readFileSync(icoPath);
    // ICO header: reserved=0, type=1 (icon), count>=1
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBeGreaterThanOrEqual(2);

    const expectedPngs: Array<[string, number]> = [
      ['favicon-16x16.png', 16],
      ['favicon-32x32.png', 32],
      ['apple-touch-icon.png', 180],
      ['icon-192.png', 192],
      ['icon-512.png', 512],
      ['icon-512-maskable.png', 512],
    ];

    for (const [file, size] of expectedPngs) {
      const fullPath = resolve(PUBLIC_DIR, file);
      expect(existsSync(fullPath), `missing ${file}`).toBe(true);
      expect(readPngDimensions(fullPath)).toEqual({ width: size, height: size });
    }
  });

  it('defines an installable manifest.webmanifest with 192/512 icons, standalone display, and #c0392b theme', () => {
    const manifestPath = resolve(PUBLIC_DIR, 'manifest.webmanifest');
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      name: string;
      short_name: string;
      display: string;
      theme_color: string;
      icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
    };

    expect(manifest.name).toBe('Sensei');
    expect(manifest.short_name).toBe('Sensei');
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color).toBe('#c0392b');

    const sizes = manifest.icons.map((i) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');

    for (const icon of manifest.icons) {
      const rel = icon.src.replace(/^\/+/, '');
      expect(existsSync(resolve(PUBLIC_DIR, rel)), `manifest icon missing: ${icon.src}`).toBe(true);
    }
  });

  it('links favicon, apple-touch-icon, manifest, and mobile PWA meta tags in web/index.html', () => {
    const html = readFileSync(INDEX_HTML_PATH, 'utf-8');
    expect(html).toContain('href="/favicon.ico"');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain('href="/apple-touch-icon.png"');
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('href="/manifest.webmanifest"');
    expect(html).toContain('name="theme-color" content="#c0392b"');
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
  });
});
