const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const kb = (n) => `${Math.round(n / 1024)} KB`;

/** The subtitle demo. Same Japanese on both pages; glosses in English and German. */
export const LINES = [
  {
    hue: 18,
    en: 'You promised, didn’t you?',
    words: [
      ['約束', 'やくそく', 'promise', 'Versprechen', 1],
      ['した', '', 'did, made (past of する)', 'machte'],
      ['じゃないか', '', 'didn’t you? isn’t it?', 'nicht wahr?'],
      ['。'],
    ],
  },
  {
    hue: 205,
    en: 'I’d do anything to protect my friends.',
    words: [
      ['仲間', 'なかま', 'companion, comrade', 'Gefährte', 1],
      ['を'],
      ['守る', 'まもる', 'to protect', 'beschützen', 1],
      ['ため', '', 'for the sake of', 'um … willen'],
      ['なら', '', 'if it is'],
      ['、'],
      ['何でも', 'なんでも', 'anything', 'alles'],
      ['する', '', 'to do', 'tun'],
      ['。'],
    ],
  },
  {
    hue: 262,
    en: 'It’s still too early to give up.',
    words: [
      ['諦める', 'あきらめる', 'to give up', 'aufgeben', 1],
      ['のは'],
      ['、'],
      ['まだ', '', 'still, yet', 'noch'],
      ['早い', 'はやい', 'early', 'früh'],
      ['。'],
    ],
  },
];

function lineHtml(line) {
  return line.words
    .map(([w, r, en, de, mark]) => {
      const t = r ? `<ruby>${w}<rt>${r}</rt></ruby>` : w;
      return en ? `<button type="button" class="w${mark ? ' mark' : ''}" data-w="${w}" data-r="${r || w}" data-en="${esc(en)}" data-de="${esc(de || '')}">${t}</button>` : `<span>${t}</span>`;
    })
    .join('');
}

export function page(t, ctx) {
  const { site, root, downloads, version, repoUrl, repoPublic, serverZip } = ctx;
  const url = site + t.dir;
  const other = t.lang === 'en' ? 'ja/' : '../';
  const alt = `<link rel="alternate" hreflang="en" href="${site}"><link rel="alternate" hreflang="ja" href="${site}ja/"><link rel="alternate" hreflang="x-default" href="${site}">`;
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Sensei',
    description: t.description,
    url,
    inLanguage: t.lang,
    applicationCategory: 'EducationalApplication',
    operatingSystem: 'Microsoft Edge, Google Chrome, Mozilla Firefox',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' },
    ...(version ? { softwareVersion: version } : {}),
  };
  const sec = (id, side, kanji, inner, extra = '') => `<section id="${id}" class="scene ${side}" data-kanji="${kanji}" data-side="${side}" ${extra}><div class="in">${inner}</div></section>`;
  const dl = (k) => {
    const d = downloads[k];
    return `<div class="dl"><h3>${t.download[k]}</h3>${d ? `<p>${t.download.version} ${esc(version)} · ${kb(d.bytes)}</p><a class="btn" href="${root}downloads/${d.file}" download>${t.download.zip}</a><p class="sha"><span>${t.download.sha}</span> <code>${d.sha256}</code></p>` : `<p>${t.download.missing}</p>`}</div>`;
  };
  return `<!doctype html>
<html lang="${t.lang}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(t.title)}</title>
<meta name="description" content="${esc(t.description)}">
<link rel="canonical" href="${url}">${alt}
<meta name="theme-color" content="#e6e9e7"><meta name="color-scheme" content="light">
<meta property="og:type" content="website"><meta property="og:site_name" content="Sensei"><meta property="og:title" content="${esc(t.title)}"><meta property="og:description" content="${esc(t.description)}"><meta property="og:url" content="${url}"><meta property="og:image" content="${site}og-${t.lang}.jpg"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:locale" content="${t.lang === 'ja' ? 'ja_JP' : 'en_US'}"><meta property="og:locale:alternate" content="${t.lang === 'ja' ? 'en_US' : 'ja_JP'}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="${root}favicon.ico" sizes="any"><link rel="icon" type="image/png" sizes="32x32" href="${root}favicon-32x32.png"><link rel="apple-touch-icon" href="${root}apple-touch-icon.png"><link rel="manifest" href="${root}site.webmanifest">
<link rel="preload" href="${root}fonts.css" as="style"><link rel="stylesheet" href="${root}fonts.css"><link rel="stylesheet" href="${root}style.css">
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>
</head><body>
<a class="skip" href="#main">${t.skip}</a>
<canvas id="ink" aria-hidden="true"></canvas>
<header class="top">
  <a class="seal" href="#hero" lang="ja" aria-label="Sensei">先生</a>
  <nav aria-label="Main"><a href="#try">${t.nav.try}</a><a href="#how">${t.nav.how}</a><a href="#features">${t.nav.features}</a><a href="#faq">${t.nav.faq}</a></nav>
  <div class="right"><a class="lang" lang="${t.otherLang}" hreflang="${t.otherLang}" href="${other}" aria-label="${t.otherAria}">${t.otherLabel}</a><a class="btn small" href="#download">${t.nav.download}</a></div>
</header>
<main id="main">
${sec(
  'hero',
  'left',
  '先生',
  `<p class="tate" lang="ja" aria-hidden="true">${t.hero.tategaki.join('<br>')}</p><h1>${t.hero.h1.map((l) => `<span>${l}</span>`).join('')}</h1><p class="lead">${t.hero.p}</p><div class="cta"><a class="btn" href="#download">${t.hero.primary}</a><a class="link" href="#try">${t.hero.secondary}</a></div><p class="note">${t.hero.note}</p>`,
)}
${sec(
  'try',
  'left wide',
  t.try.kanji,
  `<h2>${t.try.h2}</h2><p>${t.try.p}</p>
  <div class="player" data-saved="${esc(t.try.saved)}"><canvas class="still" width="960" height="540" role="img" aria-label="${t.try.scene}"></canvas>
    ${LINES.map((l, i) => `<div class="line" data-hue="${l.hue}" lang="ja"${i ? ' hidden' : ''}><p class="jp">${lineHtml(l)}</p>${t.lang === 'en' ? `<p class="tr" lang="en">${esc(l.en)}</p>` : ''}</div>`).join('')}
    <div class="pop" role="status" hidden><p class="pw" lang="ja"><b></b> <span></span></p><p class="pg"></p><button type="button" class="save">${t.try.save}</button></div>
    <p class="cap">${t.try.hint}</p><button type="button" class="next">${t.try.replay}</button></div>`,
)}
${sec(
  'review',
  'right',
  t.review.kanji,
  `<h2>${t.review.h2}</h2><p>${t.review.p}</p>
  <div class="kake" data-state="front" data-due="${t.review.due}" data-done="${esc(t.review.done)}"><p class="due"><b>3</b> ${t.review.due}</p><figure><canvas class="still" width="640" height="360" role="img" aria-label="${t.try.scene}"></canvas><figcaption>${t.review.caption}</figcaption></figure><p class="sent" lang="ja"></p><div class="act"><button type="button" class="btn show">${t.review.show}</button><div class="ans" hidden><p class="word" lang="ja"></p><p class="gl"></p><div class="rates">${t.review.rates.map(([n, d], i) => `<button type="button" data-r="${i + 1}"><b>${n}</b><small>${d}</small></button>`).join('')}</div></div></div></div>`,
)}
${sec('how', 'left', t.how.kanji, `<h2>${t.how.h2}</h2><ol class="steps">${t.how.steps.map(([k, h, p]) => `<li><span class="k" lang="ja" aria-hidden="true">${k}</span><div><h3>${h}</h3><p>${p}</p></div></li>`).join('')}</ol>`)}
${sec('features', 'right', t.features.kanji, `<h2>${t.features.h2}</h2><dl class="feats">${t.features.items.map(([h, p]) => `<div><dt>${h}</dt><dd>${p}</dd></div>`).join('')}</dl>`)}
${sec('progress', 'left', t.progress.kanji, `<h2>${t.progress.h2}</h2><p>${t.progress.p}</p><p class="big"><b>46%</b> <span>${t.progress.stat}</span></p>`, 'data-enso="0.46"')}
${sec('privacy', 'right', t.privacy.kanji, `<h2>${t.privacy.h2}</h2><p>${t.privacy.p}</p>`)}
${sec(
  'download',
  'left',
  t.download.kanji,
  `<h2>${t.download.h2}</h2><p>${t.download.p}</p><div class="dls">${dl('chrome')}${dl('firefox')}</div>
  <h3>${t.download.s1.h3}</h3><ol class="plain">${t.download.s1.chrome.map((s) => `<li>${s}</li>`).join('')}</ol><p>${t.download.s1.firefox}</p>
  <h3>${t.download.s2.h3}</h3><p>${t.download.s2.p}</p>${repoPublic ? `<p>${t.download.s2.publicP} <a class="link" href="${repoUrl}">${t.download.s2.publicLink}</a></p>` : serverZip ? `<p><a class="link" href="${root}downloads/${serverZip}" download>${t.download.s2.bundle}</a></p>` : `<p class="aside">${t.download.s2.privateP}</p>`}`,
)}
<section id="faq" class="scene right" data-side="right" data-kanji="問"><div class="in"><h2>${t.faq.h2}</h2>${t.faq.items.map(([q, a]) => `<details><summary>${q}</summary><p>${a}</p></details>`).join('')}</div></section>
</main>
<footer><div><p class="fl">${t.footer.line}</p><p>${t.footer.noAffil}</p><details><summary>${t.footer.credits}</summary><p>${t.footer.creditsHtml}</p></details></div><p class="fr">${repoPublic ? `<a href="${repoUrl}">${t.footer.github}</a>` : ''}<a href="#hero">${t.footer.top}</a></p></footer>
<script type="module" src="${root}main.js"></script>
</body></html>
`;
}

export function notFound(en, ja, ctx) {
  // GitHub Pages serves 404.html from any depth, so every address here is absolute.
  const s = ctx.site;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>404 · Sensei</title><link rel="icon" href="${s}favicon.ico"><link rel="stylesheet" href="${s}fonts.css"><link rel="stylesheet" href="${s}style.css"></head><body class="lost"><main><p class="lk" lang="ja" aria-hidden="true">迷</p><h1>${en.notFound.h1}</h1><p>${en.notFound.p} <a class="link" href="${s}">${en.notFound.back}</a></p><div lang="ja"><p>${ja.notFound.h1} <a class="link" href="${s}ja/">${ja.notFound.back}</a></p></div></main></body></html>\n`;
}
