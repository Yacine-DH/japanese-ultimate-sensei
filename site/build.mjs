// Builds the public website into site/dist. No framework: two static pages, one script, one scene.
//   node build.mjs                 SITE_URL, SITE_REPO_PUBLIC=1 and SITE_VERSION are optional
// Put release zips into site/downloads/ first to offer them for download.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import en from './copy.en.mjs';
import ja from './copy.ja.mjs';
import { assertPublishable } from './guard.mjs';
import { selectDownloads } from './src/downloads.mjs';
import { LINES, notFound, page } from './src/template.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, 'dist');
const at = (...p) => join(HERE, ...p);
const REPO = 'https://github.com/Yacine-DH/japanese-ultimate-sensei';
const SITE = `${(process.env.SITE_URL || 'https://yacine-dh.github.io/japanese-ultimate-sensei').replace(/\/+$/, '')}/`;

rmSync(DIST, { recursive: true, force: true });
mkdirSync(join(DIST, 'ja'), { recursive: true });
mkdirSync(join(DIST, 'fonts'), { recursive: true });

// ---- downloads (only what was put into site/downloads, and only if it is safe to publish)
const downloads = {};
let serverZip = null;
let version = process.env.SITE_VERSION?.replace(/^v/, '') || '';
if (existsSync(at('downloads'))) {
  const picked = selectDownloads(readdirSync(at('downloads')), version);
  version = picked.version;
  for (const [browser, entry] of Object.entries(picked.browsers)) {
    const buf = readFileSync(at('downloads', entry.file));
    assertPublishable(entry.file, buf);
    downloads[browser] = {
      file: entry.file,
      version: entry.version,
      bytes: buf.length,
      sha256: createHash('sha256').update(buf).digest('hex'),
    };
    mkdirSync(join(DIST, 'downloads'), { recursive: true });
    cpSync(at('downloads', entry.file), join(DIST, 'downloads', entry.file));
  }
  if (picked.serverZip) {
    const buf = readFileSync(at('downloads', picked.serverZip));
    assertPublishable(picked.serverZip, buf);
    serverZip = picked.serverZip;
    mkdirSync(join(DIST, 'downloads'), { recursive: true });
    cpSync(at('downloads', serverZip), join(DIST, 'downloads', serverZip));
  }
}

// ---- pages
const ctx = { site: SITE, downloads, version, repoUrl: REPO, repoPublic: process.env.SITE_REPO_PUBLIC === '1', serverZip };
const pages = {
  'index.html': page(en, { ...ctx, root: '' }),
  'ja/index.html': page(ja, { ...ctx, root: '../' }),
  '404.html': notFound(en, ja, ctx),
};
for (const [f, html] of Object.entries(pages)) writeFileSync(join(DIST, f), html);

// ---- fonts: keep only the slices that contain characters the site really uses
const used = new Set([...Object.values(pages).join(''), ...JSON.stringify(LINES), ...'先生聴景流技道守始問約束仲間諦'].map((c) => c.codePointAt(0)));
const inRange = (range) =>
  range.split(',').some((part) => {
    const [a, b] = part.trim().replace(/^U\+/i, '').split('-').map((x) => parseInt(x, 16));
    for (let c = a; c <= (b ?? a) && c - a < 70000; c++) if (used.has(c)) return true;
    return false;
  });
let fontCss = '';
for (const [pkg, weights] of [['yuji-boku', [400]], ['shippori-mincho', [500, 700]]]) {
  for (const w of weights) {
    const css = readFileSync(at('node_modules', '@fontsource', pkg, `${w}.css`), 'utf8');
    for (const block of css.match(/@font-face\s*{[^}]*}/g) ?? []) {
      const range = block.match(/unicode-range:\s*([^;]+);/)?.[1];
      const file = block.match(/files\/([^)]+?\.woff2)/)?.[1];
      if (!file || (range && !inRange(range))) continue;
      cpSync(at('node_modules', '@fontsource', pkg, 'files', file), join(DIST, 'fonts', file));
      fontCss += block.replace(/src:[^;]+;/, `src: url(fonts/${file}) format('woff2');`).replace(/\s+/g, ' ') + '\n';
    }
  }
}
writeFileSync(join(DIST, 'fonts.css'), fontCss);

// ---- script + style
await build({ entryPoints: [at('src/main.js')], bundle: true, splitting: true, format: 'esm', minify: true, target: 'es2022', outdir: DIST, legalComments: 'eof', logLevel: 'warning' });
await build({ entryPoints: [at('src/style.css')], minify: true, outdir: DIST, logLevel: 'warning' });

// ---- everything else a site needs
cpSync(at('public'), DIST, { recursive: true });
for (const f of ['favicon.ico', 'favicon-32x32.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png']) cpSync(at('..', 'web', 'public', f), join(DIST, f));
writeFileSync(join(DIST, '.nojekyll'), '');
writeFileSync(join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE}sitemap.xml\n`);
const alt = `<xhtml:link rel="alternate" hreflang="en" href="${SITE}"/><xhtml:link rel="alternate" hreflang="ja" href="${SITE}ja/"/>`;
writeFileSync(join(DIST, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml"><url><loc>${SITE}</loc>${alt}</url><url><loc>${SITE}ja/</loc>${alt}</url></urlset>\n`);
writeFileSync(join(DIST, 'site.webmanifest'), JSON.stringify({ name: 'Sensei', short_name: 'Sensei', start_url: './', display: 'browser', background_color: '#e6e9e7', theme_color: '#e6e9e7', icons: [192, 512].map((n) => ({ src: `icon-${n}.png`, sizes: `${n}x${n}`, type: 'image/png' })) }));
console.log(`site: ${SITE}  version: ${version || '-'}  downloads: ${Object.keys(downloads).join(', ') || 'none'}${serverZip ? ' + server' : ''}  repo link: ${ctx.repoPublic ? 'yes' : 'no'}`);
