/* ===========================================================================
   THE TERMINAL'S NAVIGATION, DRIVEN THE WAY A READER DRIVES IT (browser tests).

   app.html has ONE navigation in two shapes (lib/edgedesk_shell.js,
   docs/research-os/DESIGN.md §1):
     ≥ 1024 px   a sidebar with every seat
     < 1024 px   a bottom bar with Overview · Research · Signals · Card ·
                 Portfolio and Menu; every other seat (Market Foresight,
                 Simulator, Performance, Process, More) is in Menu's sheet
   and Research has its own row: Football · Props · Edges · Other, where
   Other opens a second row (UFC, Baseball, NHL, NBA, Lines, Engine, …).

   Every helper here taps what is ON SCREEN at the page's width: a seat that
   is not drawn is reached through Menu, never clicked through, forced, or
   routed around with show() / researchGo(). Each one then waits until the
   destination itself is drawn, so a suite reads the screen a reader would
   be reading. A seat that cannot be reached that way fails here, by name.

   It owns no assertion of its own beyond "the destination opened": a suite
   checks what it always checked, after arriving the way a reader arrives.

     const NAV = require('<root>/tools/app/nav_helper.js');
     await NAV.go(page, 'process');           // sidebar, bar, or Menu → Process
     await NAV.research(page, 'pprops');      // Research › Props
     await NAV.research(page, 'nhl');         // Research › Other › NHL
     await NAV.seatShown(page, 'simulator');  // lit where the reader can see it
                                              // (on a phone, Menu is lit for it)
   =========================================================================== */
'use strict';

const WIDE = 1024;   /* lib/edgedesk_shell.css: the sidebar from 1024 px */
/* the view each seat opens (show(v) in app.html) */
const VIEW = { overview: 'v-overview', research: 'v-research', signals: 'v-signals', foresight: 'v-foresight', simulator: 'v-simulator',
  card: 'v-card', portfolio: 'v-portfolio', performance: 'v-performance', process: 'v-process', more: 'v-more' };
/* Research's own row; every other panel is behind Other */
const MAIN_SUBS = { football: 1, pprops: 1, edges: 1 };

/* Each in-page callback below declares the same "drawn" test, because a
   function passed to page.evaluate is sent as source and closes over nothing:
   laid out, not visibility:hidden, with a box inside the viewport. */

/* 'sidebar' (≥ 1024 px) or 'bar' */
async function shape(page) {
  return page.evaluate((w) => (window.matchMedia('(min-width: ' + w + 'px)').matches ? 'sidebar' : 'bar'), WIDE);
}
async function drawn(page, sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el || !el.getClientRects().length || getComputedStyle(el).visibility === 'hidden') return false;
    const b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0 && b.right > 1 && b.left < window.innerWidth - 1 && b.bottom > 1 && b.top < window.innerHeight - 1;
  }, sel);
}
async function seatDrawn(page, v) { return drawn(page, '#edNav button[data-v="' + v + '"]'); }

/* what the navigation shows right now */
async function state(page) {
  return page.evaluate((w) => {
    const d = (el) => { if (!el || !el.getClientRects().length || getComputedStyle(el).visibility === 'hidden') return false; const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 && b.right > 1 && b.left < window.innerWidth - 1 && b.bottom > 1 && b.top < window.innerHeight - 1; };
    const nav = document.getElementById('edNav'), menu = document.getElementById('navMenuBtn');
    const seats = [...document.querySelectorAll('#edNav button[data-v]')];
    return {
      shape: window.matchMedia('(min-width: ' + w + 'px)').matches ? 'sidebar' : 'bar',
      views: [...document.querySelectorAll('section.view')].filter((x) => !x.classList.contains('hide')).map((x) => x.id),
      lit: seats.filter((b) => b.classList.contains('on')).map((b) => b.dataset.v),
      current: seats.filter((b) => b.getAttribute('aria-current') === 'page').map((b) => b.dataset.v),
      drawn: seats.filter(d).map((b) => b.dataset.v),
      menuDrawn: d(menu), menuLit: !!(menu && menu.classList.contains('on')),
      sheetOpen: !!(nav && nav.classList.contains('open')),
      hash: location.hash
    };
  }, WIDE);
}

/* The reader can see where they are: the seat is lit and marked current, and
   it is either drawn (the sidebar, or a bar seat) or, being off the phone's
   bar, Menu is drawn and lit for it. */
async function seatShown(page, v) {
  const s = await state(page);
  if (s.lit.join() !== v || s.current.join() !== v) return false;
  if (s.drawn.indexOf(v) >= 0) return true;
  return s.shape === 'bar' && s.menuDrawn && s.menuLit;
}

/* a view is open and drawn (its section is shown and on screen) */
async function viewOpen(page, id) {
  return page.evaluate((x) => {
    const el = document.getElementById(x);
    if (!el || el.classList.contains('hide') || !el.getClientRects().length) return false;
    const b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0;
  }, id);
}
function waitView(page, id, timeout) {
  return page.waitForFunction((x) => {
    const el = document.getElementById(x), nav = document.getElementById('edNav');
    if (!el || el.classList.contains('hide') || !el.getClientRects().length) return false;
    const b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0 && !(nav && nav.classList.contains('open'));
  }, id, { timeout });
}

/* Tap seat `v`. Returns how it was reached: 'sidebar', 'bar' or 'menu'.
   opts.view: the view the tap must open, when it is not the seat's own
   (default VIEW[v]); opts.timeout (ms, default 10000). */
async function go(page, v, opts) {
  opts = opts || {};
  const timeout = opts.timeout || 10000;
  if (!VIEW[v]) throw new Error('nav_helper: "' + v + '" is not a seat (' + Object.keys(VIEW).join(', ') + ')');
  const sh = await shape(page);
  let via = sh;
  if (!(await seatDrawn(page, v))) {
    if (sh === 'sidebar') throw new Error('nav_helper: the ' + v + ' seat is not drawn in the sidebar at this width');
    if (!(await drawn(page, '#navMenuBtn'))) throw new Error('nav_helper: the ' + v + ' seat is not on the bar, and Menu is not drawn');
    await page.click('#navMenuBtn');
    await page.waitForSelector('#edNav.open button[data-v="' + v + '"]', { state: 'visible', timeout });
    if (!(await seatDrawn(page, v))) throw new Error('nav_helper: Menu opened, but the ' + v + ' seat is not drawn in its sheet');
    via = 'menu';
  }
  await page.click('#edNav button[data-v="' + v + '"]');
  await waitView(page, opts.view || VIEW[v], timeout);
  return via;
}

/* Open a Research panel the way a reader does: the Research seat if Research
   is not on screen, then its row (Football · Props · Edges), or Other and the
   panel in the second row. Waits until the panel is shown and its tab lit. */
async function research(page, sub, opts) {
  opts = opts || {};
  const timeout = opts.timeout || 15000;
  if (!(await viewOpen(page, 'v-research'))) await go(page, 'research', { timeout });
  const sel = MAIN_SUBS[sub] ? '.research-sub button[data-sub="' + sub + '"]' : '#rsOther button[data-sub="' + sub + '"]';
  /* Other is a toggle: open its row only when the row itself is closed (a tap on an open row folds it) */
  if (!MAIN_SUBS[sub] && await page.evaluate(() => { const r = document.getElementById('rsOther'); return !r || r.classList.contains('hide'); })) {
    if (!(await drawn(page, '#rsOtherBtn'))) await page.locator('#rsOtherBtn').scrollIntoViewIfNeeded({ timeout }).catch(() => {});
    if (!(await drawn(page, '#rsOtherBtn'))) throw new Error('nav_helper: Research › Other is not drawn');
    await page.click('#rsOtherBtn');
    await page.waitForSelector(sel, { state: 'visible', timeout });
  }
  if (!(await drawn(page, sel))) await page.locator(sel).scrollIntoViewIfNeeded({ timeout }).catch(() => {});
  if (!(await drawn(page, sel))) throw new Error('nav_helper: Research › ' + sub + ' is not drawn');
  await page.click(sel);
  await page.waitForFunction(([s, p]) => {
    const b = document.querySelector(s), el = document.getElementById('v-' + p), r = document.getElementById('v-research');
    return !!b && b.classList.contains('on') && !!el && !el.classList.contains('hide') && !!r && !r.classList.contains('hide');
  }, [sel, sub], { timeout });
}

module.exports = { WIDE, VIEW, shape, state, go, research, seatShown, seatDrawn, viewOpen, drawn };
