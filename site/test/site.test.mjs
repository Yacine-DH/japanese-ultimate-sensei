import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import en from '../copy.en.mjs';
import ja from '../copy.ja.mjs';
import { assertPublishable, findPrivate } from '../guard.mjs';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const read = (f) => readFileSync(join(DIST, f), 'utf8');

function shape(v) {
  if (Array.isArray(v)) return v.map(shape);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)]));
  return typeof v;
}

test('English and Japanese have exactly the same structure', () => {
  assert.deepEqual(shape(ja), shape(en));
});

test('no text was left empty or untranslated', () => {
  const walk = (a, b, path) => {
    if (typeof a === 'string') {
      assert.ok(a.trim() || path.endsWith('.dir'), `${path} is empty`);
      if (a.length > 24 && !/tategaki/.test(path)) assert.notEqual(a, b, `${path} is the same in both languages`);
    } else for (const k of Object.keys(a)) walk(a[k], b[k], `${path}.${k}`);
  };
  walk(en, ja, 'copy');
  walk(ja, en, 'copy');
});

for (const [file, lang] of [['index.html', 'en'], ['ja/index.html', 'ja']]) {
  test(`${file}: head, language links and local files`, () => {
    const html = read(file);
    assert.match(html, new RegExp(`<html lang="${lang}">`));
    for (const need of ['rel="canonical"', 'hreflang="en"', 'hreflang="ja"', 'hreflang="x-default"', 'og:image"', 'name="description"', 'application/ld+json']) assert.ok(html.includes(need), need);
    JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1]);
    assert.equal((html.match(/<h1/g) || []).length, 1);
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    for (const [, href] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      if (href.startsWith('#')) assert.ok(ids.has(href.slice(1)), `missing target ${href}`);
      else if (!/^https?:/.test(href)) {
        let p = resolve(DIST, dirname(file), href);
        if (href.endsWith('/')) p = join(p, 'index.html');
        assert.ok(existsSync(p), `${file} links to missing ${href}`);
      }
    }
  });

  test(`${file}: loads nothing from other sites`, () => {
    const html = read(file);
    for (const [tag] of html.matchAll(/<(?:script|img|iframe|source)[^>]*>/g)) assert.doesNotMatch(tag, /(?:src|srcset)="https?:/, tag);
    for (const [tag] of html.matchAll(/<link[^>]*rel="(?:stylesheet|preload|icon)"[^>]*>/g)) assert.doesNotMatch(tag, /href="https?:/, tag);
    assert.doesNotMatch(read('style.css') + read('fonts.css'), /url\(["']?https?:/);
  });
}

test('the brush font covers every kanji the ink writes', () => {
  const ranges = [...read('fonts.css').matchAll(/@font-face {[^}]*Yuji Boku[^}]*unicode-range: ([^;]+);/g)].flatMap((m) => m[1].split(','));
  const has = (c) => ranges.some((r) => { const [a, b] = r.trim().slice(2).split('-').map((x) => parseInt(x, 16)); return c >= a && c <= (b ?? a); });
  const kanji = [...read('index.html').matchAll(/data-kanji="([^"]+)"/g)].map((m) => m[1]).join('') + '約束仲間諦';
  for (const c of kanji) assert.ok(has(c.codePointAt(0)), c);
});

test('404, sitemap, robots, manifest and share images are there', () => {
  for (const f of ['404.html', 'sitemap.xml', 'robots.txt', 'site.webmanifest', '.nojekyll', 'og-en.jpg', 'og-ja.jpg', 'favicon.ico']) assert.ok(existsSync(join(DIST, f)), f);
  assert.doesNotMatch(read('404.html'), /href="(?!https:)/);
});

function zip(name, text) {
  const data = deflateRawSync(Buffer.from(text));
  const n = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt16LE(n.length, 26);
  const dir = Buffer.alloc(46);
  dir.writeUInt32LE(0x02014b50, 0);
  dir.writeUInt16LE(8, 10);
  dir.writeUInt32LE(data.length, 20);
  dir.writeUInt16LE(n.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(30 + n.length + data.length, 16);
  return Buffer.concat([local, n, data, dir, n, end]);
}

test('private details can never be published in a download', () => {
  assert.deepEqual(findPrivate(zip('a.js', 'fetch("http://localhost:8000")')), []);
  for (const bad of ['http://barkhausstr64:8000', 'http://100.64.1.2:8000', 'https://box.tail1234.ts.net', '/home/someone/x', 'C:\\Users\\Someone', 'SENSEI_API_TOKEN=abcdefghijklmnop1234']) {
    assert.throws(() => assertPublishable('x.zip', zip('a.js', bad)), /Refusing to publish/, bad);
  }
  assert.throws(() => assertPublishable('x.zip', zip('server/.env', 'A=1')), /environment file/);
});
