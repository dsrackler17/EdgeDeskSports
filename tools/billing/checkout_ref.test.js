#!/usr/bin/env node
/* ===========================================================================
   lib/edgedesk_ref.js — the creator's code a visitor checks out with.

     ?ref=CODE is kept, with its click time, once the server says CODE is live;
     the last valid code clicked wins and an unknown one never replaces it; it
     expires 30 days after the click; every storage access survives a browser
     that refuses storage; and the pages are wired to it (index.html loads it
     and sends what it keeps as affiliate_code; the other public pages load it
     only when the URL has a code).

   Run: node tools/billing/checkout_ref.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require('../personal/_pg.js');
const REF = require('../../lib/edgedesk_ref.js');

const T = PG.kit('checkout ref');
const chk = T.chk;
const DAY = 864e5;

function memoryStorage() {
  const m = {};
  return { m, getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; } };
}
// a page at `search`, whose server knows the codes in `live`
function page(search, live, opts) {
  const o = opts || {};
  const calls = [];
  const win = {
    location: { search, pathname: '/' },
    localStorage: o.storage || memoryStorage(),
    fetch: o.fetch || (async (url, init) => {
      calls.push({ url, init });
      const code = JSON.parse(init.body).p_code;
      const ok = live.indexOf(code) >= 0;
      return { ok: true, json: async () => (ok ? { ok: true, code, campaign: true } : { ok: false }) };
    }),
  };
  return { win, calls };
}

(async () => {
  const t0 = Date.UTC(2026, 9, 16, 12);
  const LIVE = ['CONNOR10', 'OTHER20'];

  /* ── keeping a code ───────────────────────────────────────────────────── */
  const st = memoryStorage();
  let p = page('?ref=connor10&utm_source=x', LIVE, { storage: st });
  let kept = await REF.capture({ root: p.win, now: t0 });
  chk('a live code on the URL is kept, upper-cased', kept === 'CONNOR10' && REF.read({ root: p.win, now: t0 }) === 'CONNOR10', kept);
  chk('with its click time, under its own key', JSON.parse(st.m[REF.KEY]).at === t0 && REF.KEY === 'edgedesk_checkout_ref', st.m);
  chk('it asked the server (affiliate_offer) with the anon key, as POST, without credentials',
    p.calls.length === 1 && /\/rest\/v1\/rpc\/affiliate_offer$/.test(p.calls[0].url) && p.calls[0].init.method === 'POST'
      && p.calls[0].init.credentials === 'omit' && JSON.parse(p.calls[0].init.body).p_code === 'CONNOR10');
  chk('it never touches the marketing first touch', !('edgedesk_attribution' in st.m));

  p = page('?ref=other20', LIVE, { storage: st });
  await REF.capture({ root: p.win, now: t0 + 5 * DAY });
  chk('the LAST valid code clicked wins', REF.read({ root: p.win, now: t0 + 5 * DAY }) === 'OTHER20');
  p = page('?ref=TYPO99', LIVE, { storage: st });
  kept = await REF.capture({ root: p.win, now: t0 + 6 * DAY });
  chk('a code the server does not know never replaces a valid one', kept === null && REF.read({ root: p.win, now: t0 + 6 * DAY }) === 'OTHER20');
  p = page('?ref=%3Cscript%3E', LIVE, { storage: st });
  kept = await REF.capture({ root: p.win, now: t0 + 6 * DAY });
  chk('a malformed code is not even sent', kept === null && p.calls.length === 0);
  p = page('?via=connor10', LIVE, { storage: st });
  await REF.capture({ root: p.win, now: t0 + 7 * DAY });
  chk('the link\'s older spellings (via=, partner=) count as a click too', REF.read({ root: p.win, now: t0 + 7 * DAY }) === 'CONNOR10');
  p = page('?utm_source=x', LIVE, { storage: st });
  kept = await REF.capture({ root: p.win, now: t0 + 8 * DAY });
  chk('a page without a code keeps what was kept', kept === null && p.calls.length === 0 && REF.read({ root: p.win, now: t0 + 8 * DAY }) === 'CONNOR10');

  /* ── 30 days from the click ──────────────────────────────────────────── */
  const clicked = t0 + 7 * DAY;
  chk('still kept on day 30', REF.read({ root: p.win, now: clicked + 30 * DAY }) === 'CONNOR10');
  chk('gone a moment after 30 days, and removed', REF.read({ root: p.win, now: clicked + 30 * DAY + 1 }) === null && !(REF.KEY in st.m));
  st.m[REF.KEY] = JSON.stringify({ code: 'CONNOR10', at: t0 + 90 * DAY });
  chk('a click dated in the future is not believed', REF.read({ root: p.win, now: t0 }) === null && !(REF.KEY in st.m));
  st.m[REF.KEY] = '{not json';
  chk('an unreadable value is dropped', REF.read({ root: p.win, now: t0 }) === null && !(REF.KEY in st.m));
  st.m[REF.KEY] = JSON.stringify({ code: 'x y', at: t0 });
  chk('an impossible code is dropped', REF.read({ root: p.win, now: t0 }) === null);

  /* ── a browser that refuses storage, or a network that fails ─────────── */
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('denied'); } };
  p = page('?ref=CONNOR10', LIVE, { storage: throwing });
  let threw = null;
  try { kept = await REF.capture({ root: p.win, now: t0 }); } catch (e) { threw = e; }
  chk('storage that throws: capture resolves to null, never throws', threw === null && kept === null);
  chk('read and write survive it too', REF.read({ root: p.win }) === null && REF.write('CONNOR10', { root: p.win }) === false);
  const noStorage = { location: { search: '?ref=CONNOR10' }, fetch: page('', LIVE).win.fetch };
  Object.defineProperty(noStorage, 'localStorage', { get() { throw new Error('SecurityError'); } });
  threw = null;
  try { kept = await REF.capture({ root: noStorage }); REF.read({ root: noStorage }); } catch (e) { threw = e; }
  chk('a page where even reading localStorage throws (blocked site data) carries on', threw === null && kept === null);
  const st2 = memoryStorage();
  REF.write('CONNOR10', { root: { localStorage: st2 }, now: t0 });
  p = page('?ref=OTHER20', LIVE, { storage: st2, fetch: async () => { throw new Error('offline'); } });
  kept = await REF.capture({ root: p.win, now: t0 + DAY });
  chk('the server cannot be reached: nothing is replaced', kept === null && REF.read({ root: p.win, now: t0 + DAY }) === 'CONNOR10');
  p = page('?ref=OTHER20', LIVE, { storage: st2, fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
  kept = await REF.capture({ root: p.win, now: t0 + DAY });
  chk('nor when the program is not installed (404)', kept === null && REF.read({ root: p.win, now: t0 + DAY }) === 'CONNOR10');

  /* ── the pages are wired to it ────────────────────────────────────────── */
  const ROOT = path.join(__dirname, '..', '..');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const pub = fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_public.js'), 'utf8');
  const ver = /\/lib\/edgedesk_ref\.js\?v=([A-Za-z0-9]+)/.exec(html);
  chk('index.html loads lib/edgedesk_ref.js', !!ver);
  chk('and sends what it keeps to the checkout as affiliate_code', /affiliateCode=window\.EDRef\?EDRef\.read\(\):null/.test(html)
    && /affiliate_code:affiliateCode\|\|undefined/.test(html));
  chk('no page sends the old first-touch promo_code any more', !/promo_code:/.test(html));
  chk('the public pages load the same build of it', ver && pub.indexOf("'/lib/edgedesk_ref.js?v=" + ver[1] + "'") >= 0);

  const PUB = require('../../lib/edgedesk_public.js');
  const appended = [];
  const fakeDoc = { createElement: (n) => ({ tag: n }), head: { appendChild: (el) => appended.push(el) } };
  const saved = { document: global.document, EDRef: global.EDRef };
  global.document = fakeDoc;
  try {
    delete global.EDRef;
    chk('a public page opened on ?ref=CODE loads the keeper', PUB.loadRefKeeper({ ref: 'connor10' }) === true
      && appended.length === 1 && appended[0].async === true && /\/lib\/edgedesk_ref\.js\?v=/.test(appended[0].src));
    chk('and a page without a code does not', PUB.loadRefKeeper({ ref: null }) === false && appended.length === 1);
    global.EDRef = REF;
    chk('nor twice', PUB.loadRefKeeper({ ref: 'connor10' }) === false && appended.length === 1);
  } finally {
    global.document = saved.document; if (saved.EDRef) global.EDRef = saved.EDRef; else delete global.EDRef;
  }
  process.exit(T.done());
})().catch((e) => { console.error(e); process.exit(1); });
