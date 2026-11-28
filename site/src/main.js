const $ = (s, e = document) => e.querySelector(s);
const $$ = (s, e = document) => [...e.querySelectorAll(s)];
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
let ink = null;

/* The painted stand-in for an anime screenshot. */
function still(cv, hue, k) {
  const g = cv.getContext('2d');
  const W = cv.width;
  const H = cv.height;
  const u = W / 640;
  const sk = g.createLinearGradient(0, 0, 0, H);
  sk.addColorStop(0, `hsl(${hue + 30} 45% 26%)`);
  sk.addColorStop(0.62, `hsl(${hue} 62% 62%)`);
  sk.addColorStop(1, `hsl(${hue - 18} 70% 76%)`);
  g.fillStyle = sk;
  g.fillRect(0, 0, W, H);
  g.fillStyle = `hsl(${hue - 10} 90% 90% / .95)`;
  g.beginPath();
  g.arc(W * (0.28 + k * 0.06), H * 0.42, 52 * u, 0, 7);
  g.fill();
  for (let l = 0; l < 4; l++) {
    g.fillStyle = `hsl(${hue + 24} ${40 - l * 4}% ${46 - l * 11}%)`;
    g.beginPath();
    g.moveTo(0, H);
    for (let x = 0; x <= W; x += 8) g.lineTo(x, H * (0.56 + l * 0.11) - Math.sin((x / u) * 0.008 * (l + 1.2) + k * 2 + l) * 26 * u - Math.sin((x / u) * 0.03 + l * 4 + k) * 7 * u);
    g.lineTo(W, H);
    g.fill();
  }
  g.fillStyle = `hsl(${hue + 30} 40% 9%)`;
  [[0.6, 1], [0.7, 0.86]].forEach(([fx, s], n) => {
    g.save();
    g.translate(W * fx, H * 0.8);
    g.scale(s * u, s * u);
    g.beginPath();
    g.moveTo(-26, 90);
    g.quadraticCurveTo(-20, -60, -9, -78);
    g.lineTo(9, -78);
    g.quadraticCurveTo(20, -60, 26, 90);
    g.fill();
    g.beginPath();
    g.arc(0, -94, 16, 0, 7);
    g.fill();
    if (!n) {
      g.beginPath();
      g.moveTo(-34, -98);
      g.lineTo(0, -122);
      g.lineTo(34, -98);
      g.fill();
      g.fillRect(14, -52, 62, 4);
    }
    g.restore();
  });
}

/* ---- subtitle demo ---- */
const player = $('.player');
const lines = $$('.line', player);
const pop = $('.pop', player);
const saveBtn = $('.save', player);
const saveLabel = saveBtn.textContent;
let li = 0;
const paint = () => still($('.still', player), +lines[li].dataset.hue, li);
paint();
function show(w) {
  $$('.w', player).forEach((x) => x.classList.toggle('on', x === w));
  $('.pw b', pop).textContent = w.dataset.w;
  $('.pw span', pop).textContent = w.dataset.r === w.dataset.w ? '' : w.dataset.r;
  $('.pg', pop).textContent = w.dataset.de ? `${w.dataset.en} · ${w.dataset.de}` : w.dataset.en;
  saveBtn.textContent = saveLabel;
  saveBtn.disabled = false;
  pop.hidden = false;
  player.classList.add('paused');
  const pr = player.getBoundingClientRect();
  const r = w.getBoundingClientRect();
  const x = Math.min(pr.width - pop.offsetWidth - 10, Math.max(10, r.left - pr.left + r.width / 2 - pop.offsetWidth / 2));
  pop.style.left = `${x}px`;
  pop.style.bottom = `${pr.bottom - r.top + 10}px`;
}
function hide() {
  pop.hidden = true;
  player.classList.remove('paused');
  $$('.w.on', player).forEach((x) => x.classList.remove('on'));
}
$$('.w', player).forEach((w) => {
  w.addEventListener('pointerenter', () => show(w));
  w.addEventListener('focus', () => show(w));
  w.addEventListener('click', () => show(w));
});
player.addEventListener('pointerleave', hide);
player.addEventListener('keydown', (e) => e.key === 'Escape' && hide());
saveBtn.addEventListener('click', () => {
  saveBtn.textContent = player.dataset.saved;
  saveBtn.disabled = true;
  ink?.splash(true);
});
$('.next', player).addEventListener('click', () => {
  hide();
  lines[li].hidden = true;
  li = (li + 1) % lines.length;
  lines[li].hidden = false;
  paint();
});

/* ---- review card demo ---- */
const kake = $('.kake');
let queue = lines.map((_, i) => i);
function card() {
  const i = queue[0];
  const ans = $('.ans', kake);
  const btn = $('.show', kake);
  if (i === undefined) {
    kake.dataset.state = 'done';
    $('.due', kake).textContent = kake.dataset.done;
    ans.hidden = true;
    btn.textContent = kake.dataset.restart;
    btn.hidden = false;
    return;
  }
  kake.dataset.state = 'front';
  $('.due', kake).innerHTML = `<b>${queue.length}</b> ${kake.dataset.due}`;
  const mark = $('.mark', lines[i]);
  let highlighted = false;
  $('.sent', kake).innerHTML = $('.jp', lines[i]).innerHTML
    .replace(/<button[^>]*class="w( mark)?[^"]*"[^>]*>/g, (_, m) => {
      const tgt = Boolean(m) && !highlighted;
      if (tgt) highlighted = true;
      return `<span${tgt ? ' class="tgt"' : ''}>`;
    })
    .replace(/<\/button>/g, '</span>');
  $('.word', kake).innerHTML = `<ruby>${mark.dataset.w}<rt>${mark.dataset.r}</rt></ruby>`;
  $('.gl', kake).textContent = `${mark.dataset.en} · ${mark.dataset.de}`;
  still($('.still', kake), +lines[i].dataset.hue, i);
  ans.hidden = true;
  btn.textContent = kake.dataset.show;
  btn.hidden = false;
}
$('.show', kake).addEventListener('click', () => {
  if (kake.dataset.state === 'done') {
    queue = lines.map((_, i) => i);
    card();
    return;
  }
  kake.dataset.state = 'back';
  $('.show', kake).hidden = true;
  $('.ans', kake).hidden = false;
  ink?.write($('.mark', lines[queue[0]]).dataset.w.replace(/[ぁ-ん]/g, '').slice(0, 2));
  $('[data-r]', kake).focus({ preventScroll: true });
});
$$('[data-r]', kake).forEach((b) =>
  b.addEventListener('click', () => {
    const again = b.dataset.r === '1';
    const i = queue.shift();
    if (again) queue.push(i);
    ink?.splash(again);
    card();
    $('.show', kake).focus({ preventScroll: true });
  }),
);
card();

/* ---- keep the reader's place when switching language ---- */
$('.lang').addEventListener('click', (e) => {
  e.currentTarget.href = e.currentTarget.getAttribute('href').split('#')[0] + (current ? `#${current.id}` : '');
});

/* ---- the ink follows the section in view ---- */
const sections = $$('.scene');
let current = null;
function track() {
  const mid = innerHeight * 0.45;
  let best = sections[0];
  for (const s of sections) if (s.getBoundingClientRect().top <= mid) best = s;
  ink?.scroll(scrollY);
  if (best === current) return;
  current = best;
  ink?.section(best.dataset.kanji, best.dataset.side.startsWith('left') ? 'left' : 'right', +(best.dataset.enso || 0));
  $$('.top nav a').forEach((a) => (a.getAttribute('href') === `#${best.id}` ? a.setAttribute('aria-current', 'true') : a.removeAttribute('aria-current')));
}
addEventListener('scroll', track, { passive: true });
track();

const brush = document.fonts ? Promise.race([document.fonts.load('200px "Yuji Boku"', '先生'), new Promise((r) => setTimeout(r, 2500))]) : Promise.resolve();
brush
  .catch(() => {})
  .then(() => import('./scene.js'))
  .then(({ createInk }) => {
    ink = createInk($('#ink'), { reduced });
    document.body.classList.add('inked');
    current = null;
    track();
    // the remaining kanji live in other font slices; have them ready before they are written
    const rest = sections.map((s) => s.dataset.kanji).join('') + '約束仲間諦';
    document.fonts?.load('200px "Yuji Boku"', rest).then(() => ink?.rewrite()).catch(() => {});
  })
  .catch((err) => console.warn('The ink scene could not start; the page works without it.', err));
