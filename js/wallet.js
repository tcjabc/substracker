// The Money tab's Wallet view: one card per group, stacked like a wallet so only each card's top
// band shows (name, item count, total); the front card shows a share bar and its biggest items.
// Drag or fling to move through the stack (it settles on a band), tap a card to open it to all its
// items while the others slide away, tap an item to edit it. DOM + CSS 3D transforms, driven by a
// small loop that runs only while something moves, so text stays sharp and idle costs nothing.
// With "Reduce motion and effects" it's a plain list on the page's own scroll, opening instantly.
// The numbers and colours come from js/wallet-math.js.

import { springStep } from './tab-pill.js';
import {
  cardPose, maxScroll, rubberBand, releasePlan, sampleVelocity, collapsedHeight, GEOM, MOTION,
  fitCard, parseColour, hexOf, othersText, periodCash,
} from './wallet-math.js';
import { esc, money, isIncome, isOnce, nextRenewal, renewalText, parseDate, shortDate, daysUntil } from './util.js';
import { t, formatLocale } from './i18n.js';

const CHEVRON = '<svg class="w-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => t * t * (3 - 2 * t);
const css = (rgb, a) => (a == null ? `rgb(${rgb.join(' ')})` : `rgb(${rgb.join(' ')} / ${a})`);

/**
 * Mount the wallet in `host` (an empty element; it becomes the stack). Options:
 *   overlays      the app's overlay stack (js/overlays.js): an open card is an overlay, so Back closes it
 *   isShown()     whether the wallet is on screen (Money tab, Wallet view), for Back and Escape
 *   reduced()     "Reduce motion and effects"
 *   viewport()    { height, inset }: the stack's height and the strip at its bottom kept clear of
 *                 the floating buttons when the stack is scrolled to its end
 *   logo(s, size) logo markup for an item (deferred, on a neutral tile)
 *   loadLogos(el) start loading the deferred logos inside `el`
 *   total(el, g, near)  optional: after each draw, for every card's total element (`near`: on or
 *                 near the screen), so the app can roll the figure when it changes
 *   onFront(g, { settled })  optional: the front card's group (the open card while one is open;
 *                 null with no cards) whenever it or `settled` changes. `settled` is true once the
 *                 stack has stopped (no drag, spring or opening), so the app can announce it once.
 * update(data) draws the cards; see app.js renderSubs for its shape.
 */
export function createWallet(host, opts) {
  host.classList.add('wallet');
  host.setAttribute('role', 'group');
  host.setAttribute('aria-label', t('wallet.label'));
  const live = document.createElement('p');
  live.className = 'sr-only';
  live.setAttribute('aria-live', 'polite');

  let cards = [];        // { g, el, band, preview, detail, sheen, last, cur, openH, near }
  let data = null;
  const lifts = [];
  const S = { f: 0, v: 0, mode: 'idle', target: 0, tau: 0.3, e: -1, p: 0, pv: 0, pT: 0 };
  let H = 400, W = 360, maxF = 0, inset = 0, dpr = window.devicePixelRatio || 1;
  const C = collapsedHeight();
  let raf = 0, lastT = 0, dragActive = false, frames = 0, destroyed = false;
  let io = null;
  const reduced = () => !!opts.reduced?.();

  /* Cards ---------------------------------------------------------------------------------- */
  // Wording by period ("this month" or "this year"). Every card is an expense group: income has its
  // own card above the stack (app.js renderIncomeCard).
  const yearly = () => data?.period === 'annual';
  const items = (n) => t('common.items', { count: n });
  const periodWord = () => (yearly() ? t('wallet.period.year') : t('wallet.period.month'));
  const dueWord = () => (yearly() ? t('wallet.due.year') : t('wallet.due.month'));
  const nothingWord = () => (yearly() ? t('wallet.nothingDue.year') : t('wallet.nothingDue.month'));
  const notWord = () => (yearly() ? t('wallet.notDue.year') : t('wallet.notDue.month'));
  // In sentences read aloud: "NT$30,000 this month", "NT$30,000 due this month".
  const amountWord = (g, { due = false } = {}) => {
    const amount = money(g.total, data.currency);
    if (due) return yearly() ? t('wallet.amount.due.year', { amount }) : t('wallet.amount.due.month', { amount });
    return yearly() ? t('wallet.amount.year', { amount }) : t('wallet.amount.month', { amount });
  };
  const nothingLower = () => (yearly() ? t('wallet.band.nothingDue.year') : t('wallet.band.nothingDue.month'));

  function totalLine(g) {
    const others = othersText(g.others);
    if (g.total > 0) return { total: money(g.total, data.currency), sub: [dueWord(), others].filter(Boolean).join(' · ') };
    if (others) return { total: others, sub: dueWord() };
    return { total: t('wallet.nothingDue'), sub: periodWord() };
  }
  function bandLabel(g) {
    const amount = g.total > 0 ? amountWord(g) : nothingLower();
    const others = g.others.map((o) => t('wallet.band.otherCurrency', { count: o.count, currency: o.currency })).join(t('common.listSep'));
    return others
      ? t('wallet.band.withOthers', { name: g.label, items: items(g.items.length), amount, others })
      : t('wallet.band', { name: g.label, items: items(g.items.length), amount });
  }
  function dueText(s) {
    if (isOnce(s)) { const d = parseDate(s.date); return d ? shortDate(d) : ''; }
    const d = nextRenewal(s);
    return d ? renewalText(d, isIncome(s)) : t('wallet.noDate');
  }
  const soon = (s) => { const d = !isOnce(s) && nextRenewal(s); return d ? daysUntil(d) <= 7 : false; };
  const cycleWord = (s) => (isOnce(s) ? t('wallet.cycle.once') : s.cycle === 'annual' ? t('wallet.cycle.annual') : t('wallet.cycle.monthly'));
  const per = (s) => (isOnce(s) ? '' : s.cycle === 'annual' ? t('wallet.per.year') : t('wallet.per.month'));

  function cardHTML(g) {
    const line = totalLine(g);
    const top = g.ranked.slice(0, 3);
    const more = g.items.length - top.length;
    const chip = `<span class="w-logos" aria-hidden="true">${top.map((s) => opts.logo(s, 'xs')).join('')}${more ? `<span class="w-logos-more">+${more}</span>` : ''}</span>`;
    // Front preview: a share bar of what moves cash this period, the two biggest items.
    const dueNow = g.ranked.filter((s) => s.currency === data.currency && g.cash(s) > 0);
    const shares = dueNow.map((s, k) => `<i style="flex: ${g.cash(s)} 1 0; opacity: ${[0.95, 0.6, 0.4, 0.28][Math.min(k, 3)]}"></i>`).join('');
    let rows;
    if (!dueNow.length && !g.others.length) {
      const next = g.items.map((s) => ({ s, d: isOnce(s) ? parseDate(s.date) : nextRenewal(s) })).filter((x) => x.d).sort((a, b) => a.d - b.d)[0];
      rows = `<div class="w-pv-row"><span>${esc(nothingWord())}</span><span></span></div>`
        + (next ? `<div class="w-pv-row"><span>${esc(t('wallet.next', { name: next.s.name }))}</span><span>${esc(shortDate(next.d))}</span></div>` : '');
    } else {
      rows = g.ranked.slice(0, 2).map((s) => {
        const c = g.cash(s);
        return `<div class="w-pv-row"><span>${esc(s.name)}</span><span>${esc(c > 0 ? money(c, s.currency) : dueText(s))}</span></div>`;
      }).join('');
      if (g.items.length === 1) { const s = g.items[0]; rows += `<div class="w-pv-row"><span>${esc(cycleWord(s))}</span><span>${esc(dueText(s))}</span></div>`; }
    }
    const moreText = g.items.length > 2 ? `<span class="w-bar-more">${esc(t('wallet.more', { count: g.items.length - 2 }))}</span>` : '';
    // Open: this month's and this year's cash, then every item.
    const y = data.year, m = data.month, cur = data.currency;
    const sum = (period) => g.items.filter((s) => s.currency === cur).reduce((a, s) => a + periodCash(s, period, y, m), 0);
    const monthName = new Date(y, m, 1).toLocaleDateString(formatLocale(), { month: 'long' });
    const rowsHTML = g.ranked.map((s) => {
      const c = g.cash(s);
      const notes = [cycleWord(s), s.plan ? s.plan : '', s.currency !== cur ? t('wallet.notInTotals', { currency: cur }) : '', c > 0 ? '' : notWord()].filter(Boolean);
      return `<li><button type="button" class="w-item" data-id="${esc(s.id)}" aria-label="${esc(t('common.editItem', { name: s.name }))}">
        ${opts.logo(s, 'sm')}
        <span class="w-i-name">${esc(s.name)}</span>
        <span class="w-i-amt">${esc(money(s.price, s.currency))}${per(s) ? `<span class="w-i-meta"> ${esc(per(s))}</span>` : ''}</span>
        <span class="w-i-meta">${esc(notes.join(' · '))}</span>
        <span class="w-i-due${soon(s) ? ' w-soon' : ''}">${esc(dueText(s))}</span>
      </button></li>`;
    }).join('');
    return `
      <button type="button" class="w-band" aria-expanded="false" aria-label="${esc(bandLabel(g))}">
        <span class="w-name"><span>${esc(g.label)}</span>${CHEVRON}</span>${chip}<span class="w-total">${esc(line.total)}</span>
        <span class="w-meta">${esc(items(g.items.length))}</span><span class="w-sub">${esc(line.sub)}</span>
      </button>
      <div class="w-preview" aria-hidden="true"><div class="w-bar"><div class="w-bar-track">${shares}</div>${moreText}</div>${rows}</div>
      <div class="w-detail" inert>
        <div class="w-stats">
          <div><div class="w-stat-k">${esc(t('wallet.stat.dueIn', { when: monthName }))}</div><div class="w-stat-v">${esc(money(sum('monthly'), cur))}</div></div>
          <div><div class="w-stat-k">${esc(t('wallet.stat.dueInYear', { year: y }))}</div><div class="w-stat-v">${esc(money(sum('annual'), cur))}</div></div>
        </div>
        <ul class="w-items" aria-label="${esc(t('wallet.itemsLabel', { name: g.label }))}">${rowsHTML}</ul>
      </div>
      <div class="w-sheen" aria-hidden="true"></div>`;
  }

  /* Colours: the fill's text colour and depth, fitted for 4.5:1 (js/wallet-math.js fitCard). */
  function colour(c) {
    const cs = getComputedStyle(document.documentElement);
    const fill = parseColour(cs.getPropertyValue(c.g.fillVar)) || [128, 128, 128];
    const sheen = parseFloat(cs.getPropertyValue('--wallet-sheen')) || 0.07;
    const k = fitCard(fill, { sheen });
    const st = c.el.style;
    st.setProperty('--card', hexOf(fill));
    st.setProperty('--card-top', hexOf(k.top));
    st.setProperty('--card-bot', hexOf(k.bot));
    st.setProperty('--sheen-a', String(k.sh));
    st.setProperty('--ink', css(k.ink));
    st.setProperty('--ink-2', css(k.ink2));
    st.setProperty('--ink-line', css(k.ink, k.ink[0] > 128 ? 0.24 : 0.16));
    c.fit = k;
  }

  function build() {
    const focus = rememberFocus();
    io?.disconnect();
    host.textContent = '';
    lifts.length = 0;
    cards = data.groups.map((g, i) => {
      const el = document.createElement('article');
      el.className = 'w-card';
      el.dataset.key = g.key;
      el.dataset.i = i;
      el.innerHTML = cardHTML(g);
      host.append(el);
      const c = { g, el, band: el.querySelector('.w-band'), preview: el.querySelector('.w-preview'), detail: el.querySelector('.w-detail'), sheen: el.querySelector('.w-sheen'), last: {}, near: false };
      colour(c);
      return c;
    });
    for (let k = 0; k < 3; k++) {
      const d = document.createElement('div');
      d.className = 'w-lift';
      d.setAttribute('aria-hidden', 'true');
      host.append(d);
      lifts.push({ el: d, last: {} });
    }
    host.append(live);
    if (cards.length) cards[cards.length - 1].el.classList.add('w-last');
    // Logos load only for cards on or near the screen.
    io = new IntersectionObserver((entries) => entries.forEach((en) => {
      if (!en.isIntersecting) return;
      const c = cards.find((x) => x.el === en.target);
      if (c && !c.near) { c.near = true; opts.loadLogos(c.el); }
      io.unobserve(en.target);
    }), { root: reduced() ? null : host, rootMargin: '50% 0px' });
    cards.forEach((c) => io.observe(c.el));
    restoreFocus(focus);
  }
  function rememberFocus() {
    const a = document.activeElement;
    if (!a || !host.contains(a)) return null;
    return { key: a.closest('.w-card')?.dataset.key, id: a.closest('.w-item')?.dataset.id };
  }
  function restoreFocus(f) {
    if (!f) return;
    const c = cards.find((x) => x.g.key === f.key);
    const target = (f.id && c?.el.querySelector(`.w-item[data-id="${CSS.escape(f.id)}"]`)) || c?.band;
    target?.focus({ preventScroll: true });
  }

  /**
   * Whether card `i`'s band is on screen or just off it (the same idea as the deferred logos): in
   * the stack, from where it sits; with a card open, only that card; reduced, a plain list (no rolls
   * then anyway).
   */
  function nearScreen(i) {
    if (reduced()) return true;
    if (S.e >= 0) return i === S.e;
    const d = i - S.f;
    return d > -1.5 && cardPose(d).y < H + GEOM.band;
  }

  /* Geometry ------------------------------------------------------------------------------ */
  function measure() {
    dpr = window.devicePixelRatio || 1;
    if (reduced()) { host.style.height = ''; return; }
    const vp = opts.viewport?.() ?? { height: 480, inset: 0 };
    H = Math.round(vp.height);
    inset = Math.max(0, vp.inset || 0);
    host.style.height = `${H}px`;
    W = cards[0]?.el.offsetWidth || W;
    maxF = maxScroll(cards.length, H, inset);
    S.f = clamp(S.f, 0, maxF);
    if (S.mode === 'idle') S.f = Math.round(S.f);
    if (S.e >= 0) sizeOpen(cards[S.e]);
  }
  function sizeOpen(c) {
    const stats = c.detail.querySelector('.w-stats');
    const list = c.detail.querySelector('.w-items');
    const need = GEOM.band + stats.offsetHeight + list.scrollHeight + 2;
    c.openH = Math.round(Math.min(H, Math.max(C + 40, need)));
    c.el.style.height = `${c.openH}px`;
  }

  /* The front card ---------------------------------------------------------------------------- */
  // The open card while one is open, else the card in the front slot (the first card in the plain
  // list of Reduce motion and effects). `settled`: nothing moves, so the app can announce it once.
  let lastFront = null;
  const frontIndex = () => (S.e >= 0 ? S.e : clamp(Math.round(S.f), 0, Math.max(0, cards.length - 1)));
  function reportFront() {
    if (!opts.onFront) return;
    const g = cards[frontIndex()]?.g ?? null;
    const settled = (reduced() || (S.mode === 'idle' && !dragActive)) && S.p === S.pT && !S.pv;
    const key = g?.key ?? null;
    if (lastFront && lastFront.key === key && lastFront.settled === settled && lastFront.g === g) return;
    lastFront = { key, settled, g };
    opts.onFront(g, { settled });
  }

  /* Render ---------------------------------------------------------------------------------- */
  const px = (v) => Math.round(v * dpr) / dpr;
  function render() {
    if (reduced()) { reportFront(); return; }
    const e = S.e, pe = clamp(S.p, 0, 1);
    const de = e >= 0 ? e - S.f : 0;
    cards.forEach((c, i) => {
      const d = i - S.f;
      let { y, s, rx, o } = cardPose(d);
      const z = 200 + 2 * Math.floor(d + 0.5); // even; the shadow plate under a card is z - 1
      if (e >= 0) {
        if (i === e) { y = lerp(y, 0, pe); s = lerp(s, 1, pe); rx = lerp(rx, 0, pe); o = Math.max(o, pe); } else {
          const below = d > de;
          y += pe * (H * 0.45 + (below ? (d - de) * 16 : 0));
          o *= clamp(1 - pe * (below ? 1.25 : 1.8), 0, 1);
        }
      }
      // Never visibility:hidden: off-screen and faded cards must stay focusable for Tab and the arrow keys.
      const L = c.last;
      const tf = `translate3d(0,${px(y)}px,0)${rx ? ` rotateX(${rx.toFixed(2)}deg)` : ''}${s !== 1 ? ` scale(${s.toFixed(4)})` : ''}`;
      if (tf !== L.tf) { c.el.style.transform = tf; L.tf = tf; }
      const os = o >= 0.999 ? '' : o.toFixed(3);
      if (os !== L.o) { c.el.style.opacity = os; L.o = os; }
      if (z !== L.z) { c.el.style.zIndex = z; L.z = z; }
      c.cur = { tf, o, z };
      // Sheen: slides against the card as it rises, so the light seems fixed. Constant outside
      // −1…2, so only the 3–4 cards near the top ever change (and only they get a layer).
      const dd = clamp(d, -1, 2), liveSheen = d > -1.3 && d < 2.3;
      if (liveSheen !== L.live) { c.sheen.classList.toggle('is-live', liveSheen); L.live = liveSheen; }
      const sx = `translate3d(${(-(dd - 0.5) * W * 0.13).toFixed(1)}px,0,0)`;
      if (sx !== L.sx) { c.sheen.style.transform = sx; L.sx = sx; }
      if (i === e) {
        const clipB = (c.openH - C) * (1 - pe);
        const cp = clipB > 0.5 ? `inset(0 0 ${clipB.toFixed(1)}px 0 round var(--radius-lg))` : '';
        if (cp !== L.cp) { c.el.style.clipPath = cp; L.cp = cp; }
        c.preview.style.opacity = clamp(1 - pe * 2, 0, 1).toFixed(3);
        const dq = clamp((pe - 0.25) / 0.75, 0, 1);
        c.detail.style.opacity = dq.toFixed(3);
        c.detail.style.transform = dq < 1 ? `translateY(${((1 - ease(dq)) * 14).toFixed(1)}px)` : '';
      }
    });
    renderLifts(e, pe);
    reportFront();
  }
  // The big drop shadow on separate plates (transform and opacity only): under the front card,
  // crossfading to the next as it rises; the open card takes it all.
  function renderLifts(e, pe) {
    const w = new Map();
    const add = (i, v) => { if (i >= 0 && i < cards.length && v > 0.002) w.set(i, (w.get(i) || 0) + v); };
    const fl = Math.floor(S.f), fr = S.f - fl, q = e >= 0 ? 1 - pe : 1;
    add(fl, (1 - fr) * q); add(fl + 1, fr * q); if (e >= 0) add(e, pe);
    const list = [...w.entries()].slice(0, lifts.length);
    lifts.forEach((lf, k) => {
      const L = lf.last, ent = list[k];
      if (!ent) { if (L.o !== '0') { lf.el.style.opacity = '0'; L.o = '0'; } return; }
      const [i, wt] = ent, c = cards[i], cur = c.cur;
      const open = i === e && c.openH;
      const h = open ? c.openH : C;
      if (h !== L.h) { lf.el.style.height = `${h}px`; L.h = h; }
      const tf = open ? `${cur.tf} scaleY(${((C + (c.openH - C) * pe) / c.openH).toFixed(4)})` : cur.tf;
      if (tf !== L.tf) { lf.el.style.transform = tf; L.tf = tf; }
      const os = clamp(wt * cur.o, 0, 1).toFixed(3);
      if (os !== L.o) { lf.el.style.opacity = os; L.o = os; }
      if (cur.z - 1 !== L.z) { lf.el.style.zIndex = cur.z - 1; L.z = cur.z - 1; }
    });
  }
  function clearInline() {
    for (const c of cards) {
      for (const k of ['transform', 'opacity', 'zIndex', 'clipPath', 'height']) c.el.style[k] = '';
      c.preview.style.opacity = ''; c.detail.style.opacity = ''; c.detail.style.transform = '';
      c.sheen.style.transform = ''; c.sheen.classList.remove('is-live');
      c.last = {};
    }
    for (const lf of lifts) { lf.el.style.cssText = ''; lf.last = {}; }
  }

  /* Loop: runs only while something moves ------------------------------------------------- */
  const requestFrame = () => { if (!raf && !destroyed) raf = requestAnimationFrame(tick); };
  function stepScroll(dt) {
    if (S.mode === 'coast') {
      let x = S.f - S.target;
      x *= Math.exp(-dt / S.tau);
      S.v = -x / S.tau;
      S.f = S.target + x;
      if (Math.abs(x) * GEOM.band < MOTION.coastHandoverPx) S.mode = 'spring'; // no long sub-pixel tail
    } else if (S.mode === 'spring') {
      [S.f, S.v] = springStep(S.f, S.v, S.target, MOTION.snapOmega, dt);
      if (Math.abs(S.f - S.target) * GEOM.band < MOTION.restPx && Math.abs(S.v) * GEOM.band < MOTION.restSpeedPx) {
        S.f = S.target; S.v = 0; S.mode = 'idle';
      }
    }
    return S.mode === 'coast' || S.mode === 'spring';
  }
  function stepOpen(dt) {
    if (S.p === S.pT && !S.pv) return false;
    [S.p, S.pv] = springStep(S.p, S.pv, S.pT, MOTION.openOmega, dt);
    if (Math.abs(S.p - S.pT) * H < MOTION.openRestPx && Math.abs(S.pv) * H < MOTION.openRestSpeedPx) {
      S.p = S.pT; S.pv = 0;
      if (S.pT) afterOpen(); else afterClose();
      return false;
    }
    return true;
  }
  function tick(now) {
    raf = 0;
    if (destroyed) return;
    const dt = lastT ? Math.min((now - lastT) / 1000, 1 / 30) : 1 / 60;
    lastT = now;
    const a = stepScroll(dt), b = stepOpen(dt);
    render();
    frames++;
    if (a || b) requestFrame(); else lastT = 0;
  }

  /* Scroll input -------------------------------------------------------------------------- */
  function springTo(target, v = S.v) { S.target = target; S.v = v; S.mode = 'spring'; requestFrame(); }
  function release(v) {
    const plan = releasePlan(S.f, v, maxF);
    if (plan.mode === 'coast') { S.target = plan.target; S.tau = plan.tau; S.mode = 'coast'; requestFrame(); } else springTo(plan.target, v);
  }
  function scrollToCard(i) {
    if (reduced()) return;
    const tgt = clamp(i, 0, maxF);
    if (tgt !== S.target || (S.mode === 'idle' && tgt !== S.f)) springTo(tgt);
  }

  let drag = null, suppressClick = false;
  const unsuppress = () => setTimeout(() => { suppressClick = false; }, 0);
  host.addEventListener('pointerdown', (ev) => {
    if (reduced() || S.e >= 0 || ev.button !== 0) return;
    const wasMoving = S.mode !== 'idle' && Math.abs(S.v) > 1.2;
    if (S.mode !== 'idle') { S.mode = 'idle'; S.v = 0; } // catch a moving stack
    drag = { id: ev.pointerId, x0: ev.clientX, y0: ev.clientY, f0: S.f, moved: false, wasMoving, samples: [[ev.timeStamp, S.f]] };
    dragActive = true;
  });
  host.addEventListener('pointermove', (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    const dy = ev.clientY - drag.y0, dx = ev.clientX - drag.x0;
    if (!drag.moved) {
      if (Math.abs(dy) < MOTION.dragPx || Math.abs(dy) < Math.abs(dx)) return;
      drag.moved = true;
      drag.y0 = ev.clientY;
      try { host.setPointerCapture(ev.pointerId); } catch { /* already released */ }
    }
    const raw = drag.f0 - (ev.clientY - drag.y0) / GEOM.band;
    S.f = rubberBand(raw, maxF);
    drag.samples.push([ev.timeStamp, raw]);
    if (drag.samples.length > 8) drag.samples.shift();
    requestFrame();
  });
  function endDrag(ev, cancelled) {
    if (!drag || ev.pointerId !== drag.id) return;
    const d = drag;
    drag = null; dragActive = false;
    if (d.moved) { suppressClick = true; unsuppress(); release(cancelled ? 0 : sampleVelocity(d.samples, ev.timeStamp)); } else if (d.wasMoving) { suppressClick = true; unsuppress(); release(0); } else requestFrame();
  }
  host.addEventListener('pointerup', (ev) => endDrag(ev, false));
  host.addEventListener('pointercancel', (ev) => endDrag(ev, true));
  host.addEventListener('click', (ev) => { if (suppressClick) { ev.preventDefault(); ev.stopPropagation(); suppressClick = false; } }, true);

  let wheelTimer = 0;
  host.addEventListener('wheel', (ev) => {
    if (reduced() || S.e >= 0) return;
    ev.preventDefault();
    const dy = ev.deltaY * (ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? H : 1);
    const notch = ev.deltaMode !== 0 || (Math.abs(dy) >= 50 && Number.isInteger(dy));
    if (notch) springTo(clamp((S.mode === 'idle' ? Math.round(S.f) : S.target) + Math.sign(dy), 0, maxF));
    else { // trackpad: follow, snap when it stops
      S.mode = 'idle'; S.v = 0; S.f = clamp(S.f + dy / GEOM.band, 0, maxF); requestFrame();
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => springTo(clamp(Math.round(S.f), 0, maxF), 0), 120);
    }
  }, { passive: false });

  /* Open and close ------------------------------------------------------------------------- */
  const OVERLAY = 'wallet-card';
  function announce(msg) { live.textContent = ''; setTimeout(() => { live.textContent = msg; }, 30); }
  function openedText(c) {
    const g = c.g;
    const amount = g.total > 0 ? amountWord(g, { due: true }) : nothingLower();
    return t('wallet.opened', { name: g.label, items: items(g.items.length), amount });
  }
  function markOpen(c, on) {
    c.el.classList.toggle('is-open', on);
    c.band.setAttribute('aria-expanded', String(on));
    c.detail.inert = !on;
    cards.forEach((o) => { if (o !== c) o.el.inert = on; });
    host.classList.toggle('has-open', on);
  }
  function expand(i, { instant = false, quiet = false } = {}) {
    if (S.e >= 0) return;
    const c = cards[i];
    if (!c) return;
    if (!reduced() && i - S.f < -0.5) { scrollToCard(i); return; } // a card in the pile: bring it back first
    S.e = i;
    if (S.mode !== 'idle') { S.mode = 'idle'; S.v = 0; }
    markOpen(c, true);
    if (!c.near) { c.near = true; opts.loadLogos(c.el); }
    opts.overlays?.open(OVERLAY, { close: () => collapse(), isOpen: () => S.e >= 0 && S.pT === 1, isShown: () => opts.isShown?.() !== false });
    if (!quiet) announce(openedText(c));
    if (reduced()) {
      c.rmScroll = window.scrollY;
      S.p = S.pT = 1;
      host.scrollIntoView?.({ block: 'start' });
      reportFront();
      return;
    }
    sizeOpen(c);
    c.last.cp = null;
    c.el.classList.add('is-anim');
    S.pT = 1;
    if (instant) { S.p = 1; S.pv = 0; render(); afterOpen(); } else requestFrame();
  }
  function afterOpen() {
    const c = cards[S.e];
    if (!c) return;
    c.el.classList.remove('is-anim');
    c.el.style.clipPath = '';
    c.last.cp = '';
  }
  function collapse({ instant = false, quiet = false } = {}) {
    if (S.e < 0 || S.pT === 0) return;
    const c = cards[S.e];
    opts.overlays?.remove(OVERLAY);
    markOpen(c, false);
    c.detail.inert = true;
    if (!quiet) announce(t('wallet.closed', { name: c.g.label }));
    if (document.activeElement && c.detail.contains(document.activeElement)) c.band.focus({ preventScroll: true });
    if (reduced()) {
      S.p = S.pT = 0;
      afterClose();
      if (c.rmScroll != null) window.scrollTo({ top: c.rmScroll });
      reportFront();
      return;
    }
    c.el.classList.add('is-anim');
    S.pT = 0;
    // Closed before the opening drew a frame (Escape straight after the tap): nothing to animate back.
    if (instant || (S.p === 0 && !S.pv)) { S.p = 0; S.pv = 0; render(); afterClose(); } else requestFrame();
  }
  function afterClose() {
    const c = cards[S.e];
    S.e = -1;
    if (!c) return;
    c.el.classList.remove('is-anim');
    c.el.style.height = ''; c.el.style.clipPath = '';
    c.last.cp = '';
    c.preview.style.opacity = ''; c.detail.style.opacity = ''; c.detail.style.transform = '';
    cards.forEach((o) => { o.el.inert = false; });
    if (!reduced() && S.f !== Math.round(S.f)) springTo(clamp(Math.round(S.f), 0, maxF), 0);
  }

  host.addEventListener('click', (ev) => {
    const cardEl = ev.target.closest('.w-card');
    if (!cardEl || ev.target.closest('.w-item')) return; // item rows: the app opens the edit sheet (data-id)
    const i = +cardEl.dataset.i;
    if (ev.target.closest('.w-band')) { if (S.e === i) collapse(); else if (S.e < 0) expand(i); return; }
    if (S.e < 0) expand(i);
  });

  /* Keyboard ------------------------------------------------------------------------------ */
  host.addEventListener('keydown', (ev) => {
    if (S.e >= 0) return;
    const b = ev.target.closest('.w-band');
    if (!b) return;
    const i = +b.closest('.w-card').dataset.i;
    const n = cards.length;
    let j = null;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowRight') j = Math.min(n - 1, i + 1);
    else if (ev.key === 'ArrowUp' || ev.key === 'ArrowLeft') j = Math.max(0, i - 1);
    else if (ev.key === 'Home') j = 0;
    else if (ev.key === 'End') j = n - 1;
    if (j == null) return;
    ev.preventDefault();
    cards[j].band.focus({ preventScroll: true });
    if (reduced()) cards[j].el.scrollIntoView?.({ block: 'nearest' }); else scrollToCard(j);
  });
  host.addEventListener('focusin', (ev) => {
    const b = ev.target.closest('.w-band');
    if (!b || S.e >= 0 || reduced()) return;
    host.scrollTop = 0; // focus can nudge an overflow:hidden box; the cards are placed by transform
    if (b.matches(':focus-visible')) scrollToCard(+b.closest('.w-card').dataset.i);
  });
  const onKey = (ev) => {
    if (ev.key !== 'Escape' || S.e < 0 || opts.overlays?.top() !== OVERLAY) return;
    ev.preventDefault();
    collapse();
  };
  document.addEventListener('keydown', onKey);
  const onResize = () => { if (data) { measure(); render(); } };
  window.addEventListener('resize', onResize);

  /* API ----------------------------------------------------------------------------------- */
  const api = {
    /**
     * Draw `next` = { groups (each with fillVar), currency, period, year, month }. The open card
     * stays open (redrawn without animation) while its group exists; otherwise it closes.
     * `reorder`: the groups are in a new order (Sort changed). An open card stays open and becomes
     * the front card, so closing it puts it back where it can be seen; with none open the stack
     * goes back to the top, where the new order starts.
     */
    update(next, { reorder = false } = {}) {
      const openKey = S.e >= 0 && S.pT === 1 ? cards[S.e]?.g.key : null;
      if (S.e >= 0) { opts.overlays?.remove(OVERLAY); S.e = -1; S.p = S.pT = 0; S.pv = 0; }
      if (raf) { cancelAnimationFrame(raf); raf = 0; lastT = 0; }
      if (S.mode !== 'idle') { S.f = clamp(Math.round(S.target), 0, Math.max(0, next.groups.length - 1)); S.mode = 'idle'; S.v = 0; }
      data = next;
      host.classList.toggle('is-reduced', reduced());
      host.classList.remove('has-open');
      build();
      measure();
      const again = openKey ? cards.findIndex((c) => c.g.key === openKey) : -1;
      if (reorder && !reduced()) { S.f = again >= 0 ? clamp(again, 0, maxF) : 0; S.target = S.f; }
      if (again >= 0) expand(again, { instant: true, quiet: true });
      else if (openKey) announce(t('wallet.gone'));
      render();
      // Card totals: the app's rolling totals (js/count-anim.js), told which cards can be seen.
      if (opts.total) cards.forEach((c, i) => opts.total(c.band.querySelector('.w-total'), c.g, nearScreen(i)));
    },
    /** The theme changed: refit every card's colours. */
    recolour() { cards.forEach(colour); },
    /** Reduce motion and effects changed (or the layout did): redraw in the right mode. */
    relayout() {
      if (!data) return;
      const open = S.e >= 0 ? cards[S.e]?.g.key : null;
      if (S.e >= 0) collapse({ instant: true, quiet: true });
      clearInline();
      if (data) api.update(data);
      const i = open ? cards.findIndex((c) => c.g.key === open) : -1;
      if (i >= 0) expand(i, { instant: true, quiet: true });
    },
    /** Close the open card at once (leaving the Wallet view). */
    close() { if (S.e >= 0) collapse({ instant: true, quiet: true }); },
    /** The space above the stack changed (the income card opened or closed): measure again. */
    resize() { if (data) { measure(); render(); } },
    isOpen: () => S.e >= 0,
    /** The front card's group (see onFront), or null. */
    front: () => cards[frontIndex()]?.g ?? null,
    destroy() {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      io?.disconnect();
      opts.overlays?.remove(OVERLAY);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    },
    /** For tests: the engine's state. */
    state: () => ({
      f: S.f, mode: S.mode, open: S.e >= 0 ? cards[S.e]?.g.key ?? null : null, progress: S.p, front: cards[frontIndex()]?.g.key ?? null,
      animating: !!raf, frames, maxScroll: maxF, height: H, count: cards.length,
      fits: cards.map((c) => ({ key: c.g.key, ink: hexOf(c.fit.ink), ratio: c.fit.ratio, ratio2: c.fit.ratio2 })),
    }),
  };
  return api;
}
