#!/usr/bin/env node
/* ===========================================================================
   PLAYER PROP RESEARCH ON EVERY MATCHUP PAGE, IN A REAL BROWSER.

   The pages a reader actually researches a game on — not a section injected
   into an empty div:
     research  the canonical CFB research page, /research/cfb/#/game/<id>,
               for EVERY game the research terminal carries
     cfb       the app's FBS game card, opened the way "Research matchup"
               opens it (fbOpenGame → the Power 4 board → the card)
     nfl       the app's NFL game card, opened the same way

   Each game's expected state is computed here, in Node, by the same
   lib/edgedesk_opportunity.js over the committed summaries
   (football/props/<lg>/summary.json), joined on the schedule id the pages
   use; the page must render exactly that state under PLAYER PROP RESEARCH:
     A  research-grade props: the cards, Research prop, Add to Card, View all N props
     B  props evaluated, none meet the research threshold, View all props
     C  sportsbook prop markets not released (View projections)
     D  PLAYER PROP PRICING UNAVAILABLE — one college game's capture is set to
        a failed request and classified by EDOpportunity.eventCaptureState
     E  outside the prop capture window / not captured yet / not on the board
   The section is never missing, is open, sits beside the game's decision on
   the card, and never loads the 1-2 MB board until asked.

   The committed summaries change hourly, so the games are picked by state; a
   state the committed data holds no game in is said, not faked (D is always
   present). The page clock is pinned ten minutes after the summaries' build.
   Needs Playwright with Chromium; prints SKIPPED and exits 0 without one.
   Run:  node tools/opportunity/matchup_props.e2e.js [--shots <dir>]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const SHOTS = args.indexOf('--shots') >= 0 ? args[args.indexOf('--shots') + 1] : null;

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 700) : ''));
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.csv': 'text/csv; charset=utf-8' };
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const X = require(path.join(ROOT, 'lib', 'edgedesk_opportunity.js'));
const CFB = read('football/props/cfb/summary.json'), NFLS = read('football/props/nfl/summary.json');
const GAMES = read('football/cfb_terminal/games.json'), SLATE = read('football/nfl/slate.json');
const NOW = Math.max(Date.parse(CFB.generated_at), Date.parse(NFLS.generated_at)) + 10 * 60000;
const SCHED = path.join(ROOT, 'tools', 'football', 'fixtures', 'fbs_schedule_sample.csv');

/* D: one college game whose sportsbook request failed, classified by the engine itself */
const D_GID = Object.keys(CFB.events).find((k) => CFB.events[k].capture.state !== 'PRICED' && GAMES.games[k]);
if (D_GID) {
  const ev = CFB.events[D_GID];
  ev.provider_event_id = 'e2e_failed_' + D_GID;
  ev.capture = X.eventCaptureState({ event_id: ev.provider_event_id }, { status: 'SUCCESS', reason: 'QUOTES_WRITTEN', window_h: 96 },
    { last_run: CFB.generated_at, requests: [{ event_id: ev.provider_event_id, http: 500, error: 'HTTP 500 from the odds provider' }] }, 0);
}

/* the state a page must show for a game, from the summary at NOW */
function stateOf(S, gid) {
  const ev = X.eventFromSummary(S, gid, NOW);
  if (!ev) return 'MISSING';
  if ((ev.top_opportunities || []).some((x) => x.research && x.research.grade)) return 'A';
  const st = ev.capture && ev.capture.state;
  return st === 'PRICED' ? 'B' : st === 'NOT_RELEASED' ? 'C' : st === 'CAPTURE_FAILED' || st === 'CAPTURE_OFF' ? 'D' : 'E';
}
const LABEL = {
  A: /TOP PROP OPPORTUNITIES/,
  B: /\d+ props? evaluated[\s\S]*No player props currently meet EdgeDesk.s research threshold/,
  C: /Sportsbook prop markets not released/,
  D: /PLAYER PROP PRICING UNAVAILABLE/,
  E: /Outside the prop capture window|Prices not captured yet/,
  MISSING: /Outside the prop capture window|Not on the player-prop board|Player props closed/
};
const STATES = ['A', 'B', 'C', 'D', 'E', 'MISSING'];
function stateText(t) { return STATES.filter((k) => LABEL[k].test(t)); }

/* the NFL schedule feed the app reads, rebuilt from the committed slate */
function nflGamesCsv() {
  const cols = ['game_id', 'season', 'game_type', 'week', 'gameday', 'gametime', 'away_team', 'away_score', 'home_team', 'home_score', 'away_rest', 'home_rest',
    'away_moneyline', 'home_moneyline', 'spread_line', 'total_line', 'div_game', 'roof', 'surface', 'temp', 'wind', 'away_qb_id', 'home_qb_id', 'away_qb_name', 'home_qb_name'];
  const rows = SLATE.games.map((g) => { const r = g.reference_market || {};
    return [g.game_id, g.season, g.game_type || 'REG', g.week, g.gameday, g.gametime_et, g.away_code, 'NA', g.home_code, 'NA', g.away_rest, g.home_rest,
      r.away_ml == null ? 'NA' : r.away_ml, r.home_ml == null ? 'NA' : r.home_ml, r.home_margin == null ? 'NA' : r.home_margin, r.total == null ? 'NA' : r.total,
      g.div_game ? 1 : 0, g.roof || 'NA', g.surface || 'NA', 'NA', 'NA',
      (g.away_starter && g.away_starter.player_id) || 'NA', (g.home_starter && g.home_starter.player_id) || 'NA',
      (g.away_starter && g.away_starter.player_name) || 'NA', (g.home_starter && g.home_starter.player_name) || 'NA'].join(','); });
  return cols.join(',') + '\n' + rows.join('\n') + '\n';
}

(async function main() {
  let pw = null;
  try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }
  console.log('committed summaries · college ' + CFB.generated_at + ' · NFL ' + NFLS.generated_at + ' · page clock ' + new Date(NOW).toISOString() + ' · capture failed: ' + D_GID);
  const served = { '/football/props/cfb/summary.json': JSON.stringify(CFB) };
  const boardReads = [];
  function siteHandler(req, res) {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/app.html';
    if (p.endsWith('/')) p += 'index.html';
    if (/\/football\/props\/(nfl|cfb)\/board\.json$/.test(p)) boardReads.push(p);
    if (served[p]) { res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' }); res.end(served[p]); return; }
    const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(file));
  }
  const srv = await new Promise((resolve) => { const s = http.createServer(siteHandler); s.listen(0, '127.0.0.1', () => resolve(s)); });
  const port = srv.address().port, base = 'http://127.0.0.1:' + port;
  let browser;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) {
    const exe = ['/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((x) => fs.existsSync(x) && fs.statSync(x).isFile());
    if (exe) browser = await pw.chromium.launch({ headless: true, executablePath: exe });
    else { console.log('SKIPPED: no Chromium'); srv.close(); process.exit(0); }
  }
  async function open(viewport) {
    const ctx = await browser.newContext({ viewport });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
        localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'e2e', refresh_token: 'e2e', expires_at: Math.floor(Date.now() / 1000) + 86400 * 400, user: { id: 'e2e-reader', email: 'e2e@edgedesk.test' } }));
        localStorage.setItem('edgedesk_decision_onboarded_v1', JSON.stringify('2026-01-01T00:00:00Z'));
      } catch (e) { /* storage */ }
    });
    const sched = fs.readFileSync(SCHED), nflCsv = nflGamesCsv();
    await ctx.route('**/*', (route) => {
      const u = route.request().url();
      if (u.startsWith(base)) return route.continue();
      if (/cfb_schedules_\d{4}\.csv/.test(u)) return route.fulfill({ status: 200, contentType: 'text/csv', body: sched });
      if (/nfldata\/master\/data\/games\.csv/.test(u)) return route.fulfill({ status: 200, contentType: 'text/csv', body: nflCsv });
      if (/supabase\.co/.test(u)) {
        if (/subscriptions/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ status: 'active', price_id: 'price_e2e', current_period_end: '2027-06-01T00:00:00Z', cancel_at_period_end: false, stripe_customer_id: 'cus_e2e' }]) });
        return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      }
      return route.fulfill({ status: 404, body: '' });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message).slice(0, 300)));
    await page.clock.setFixedTime(new Date(NOW));
    return { ctx, page, errors };
  }
  const shot = async (page, name, sel) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    if (sel) await page.evaluate((s) => { const x = document.querySelector(s); if (x) window.scrollTo(0, x.getBoundingClientRect().top + window.scrollY - 140); }, sel);
    await page.screenshot({ path: path.join(SHOTS, name + '.png') });
  };
  const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

  try {
    /* ------------------------------------------ the canonical research page */
    console.log('research page (/research/cfb/#/game/<id>)');
    let { ctx, page, errors } = await open({ width: 1280, height: 1000 });
    const ids = Object.keys(GAMES.games), seen = {}, wrong = [];
    for (let i = 0; i < ids.length; i++) {
      const gid = ids[i], want = stateOf(CFB, gid);
      await page.goto(base + '/research/cfb/#/game/' + encodeURIComponent(gid), { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => { const s = document.querySelector('#s-props [data-pp-gsec]'); return s && (s.querySelector('.pp-pstate') || s.querySelector('.pp-rsec-h.sub')); }, null, { timeout: 20000 }).catch(() => {});
      const r = await page.evaluate(() => { const s = document.querySelector('#s-props'); return s ? { open: s.open, t: s.innerText, head: /PLAYER PROP RESEARCH/.test(s.innerText) } : null; });
      const got = r ? stateText(r.t) : [];
      if (!r || !r.open || !r.head || got.indexOf(want) < 0 || (want !== 'E' && want !== 'MISSING' && got.length !== 1)) wrong.push({ gid, want, got, open: r && r.open, text: r && r.t.slice(0, 200) });
      if (!seen[want]) seen[want] = gid;
    }
    chk('every game the research terminal carries (' + ids.length + ') opens with PLAYER PROP RESEARCH, open, in its own state', wrong.length === 0, wrong.slice(0, 3));
    console.log('     states on the research page: ' + STATES.map((k) => k + '=' + (seen[k] || '—')).join(' '));
    chk('no research page read the prop board', boardReads.length === 0, boardReads);
    for (const k of STATES) {
      const gid = seen[k];
      if (!gid) { console.log('  --   state ' + k + ': no game in the committed data holds it right now'); continue; }
      await page.goto(base + '/research/cfb/#/game/' + encodeURIComponent(gid), { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => { const s = document.querySelector('#s-props [data-pp-gsec]'); return s && (s.querySelector('.pp-pstate') || s.querySelector('.pp-rsec-h.sub')); }, null, { timeout: 20000 });
      const v = await page.evaluate(() => { const s = document.querySelector('#s-props'); return { t: s.innerText, cards: s.querySelectorAll('.pp-rc').length, btns: Array.from(s.querySelectorAll('button')).map((b) => b.textContent) }; });
      const ev = X.eventFromSummary(CFB, gid, NOW);
      if (k === 'A') {
        chk('A · ' + gid + ': the best research-grade props in full (1-4 cards) with Research prop and Add to Card', v.cards >= 1 && v.cards <= 4 && v.btns.indexOf('Research prop') >= 0 && v.btns.indexOf('Add to Card') >= 0, v.btns);
        ['EdgeDesk projection', 'Best price', 'EV', 'Edge', 'Confidence', 'Research score'].forEach((f) => chk('A · a card shows ' + f, new RegExp(f, 'i').test(v.t)));
        chk('A · "View all ' + ev.total_props + ' props"', v.btns.indexOf('View all ' + ev.total_props + ' props') >= 0, v.btns);
        const add = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('#s-props .pp-rc-acts button')).find((x) => x.textContent === 'Add to Card'); b.click(); const e = JSON.parse(localStorage.getItem('edgedesk_card_opportunities_v1') || '[]'); return { label: b.textContent, n: e.length, e: e[0] ? { type: e[0].type, line: e[0].line, book: e[0].book, pending: e[0].pending_upload } : null }; });
        chk('A · Add to Card saves the frozen snapshot to the device Card the app reads (to upload when signed in)', add.label === 'Added to Card' && add.n === 1 && add.e.type === 'PLAYER_PROP' && add.e.line != null && add.e.book && add.e.pending === true, add);
      } else if (k === 'B') {
        chk('B · ' + gid + ': "' + ev.evaluated_props + ' props evaluated" and none meet the threshold, with View all props', new RegExp(ev.evaluated_props + ' props? evaluated').test(v.t) && /No player props currently meet EdgeDesk.s research threshold/.test(v.t) && v.btns.indexOf('View all props') >= 0 && v.cards === 0, v);
      } else if (k === 'C' || k === 'D' || k === 'E') {
        chk(k + ' · ' + gid + ': says ' + (k === 'C' ? 'the markets are not released' : k === 'D' ? 'PLAYER PROP PRICING UNAVAILABLE, not "not released"' : 'it is outside the capture window') + (ev.projected_props ? ', with View projections' : ''),
          LABEL[k].test(v.t) && (k !== 'D' || !/not released/i.test(v.t)) && (!ev.projected_props || v.btns.indexOf('View projections') >= 0), v);
      } else chk('MISSING · ' + gid + ': a game the prop board does not carry says why', LABEL.MISSING.test(v.t), v.t.slice(0, 300));
      await shot(page, 'research_' + k + '_' + gid, '#s-props');
    }
    if (seen.B) {
      await page.goto(base + '/research/cfb/#/game/' + encodeURIComponent(seen.B), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#s-props .pp-pstate', { timeout: 20000 });
      await Promise.all([page.waitForURL(/\/app\.html#playerprops\/cfb\/game\//, { timeout: 15000, waitUntil: 'commit' }), page.click('#s-props button:has-text("View all props")')]);
      chk('"View all props" opens the app\'s Player Props page on that game', new RegExp('#playerprops/cfb/game/' + seen.B + '$').test(page.url()), page.url());
    }
    chk('no page errors on the research pages', errors.length === 0, errors);
    await ctx.close();

    /* phone: the section fits */
    ({ ctx, page, errors } = await open({ width: 390, height: 844 }));
    const phoneGid = seen.A || seen.B || seen.E;
    await page.goto(base + '/research/cfb/#/game/' + encodeURIComponent(phoneGid), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#s-props [data-pp-gsec] .pp-gfoot', { timeout: 20000 });
    chk('no horizontal scroll with PLAYER PROP RESEARCH on a phone', await noHScroll(page));
    await shot(page, 'research_phone_' + phoneGid, '#s-props');
    await ctx.close();

    /* ------------------------------------------ the app's FBS game card */
    console.log('app · FBS game card (fbOpenGame)');
    ({ ctx, page, errors } = await open({ width: 1280, height: 1000 }));
    await page.goto(base + '/app.html#research/football', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.fbSetSport === 'function' && !!window.EDDecisionUI && !!window.EDPropsUI, null, { timeout: 30000 });
    await page.evaluate(() => { try { window.researchGo('football'); } catch (e) { /* shell */ } window.fbSetSport('p4'); });
    await page.waitForFunction(() => { const b = document.getElementById('fbBody'); return b && /FBS FOOTBALL OPERATIONS/.test(b.innerHTML); }, null, { timeout: 90000 });
    await page.waitForTimeout(800);
    await page.click('text=Skip for now', { timeout: 1500 }).catch(() => {});
    /* the cards on the board: a game that has kicked off has left it (fbKickedOff) */
    const up = await page.evaluate(() => (FB.p4.up || []).filter((u) => u.t > Date.now()).map((u) => String(u.g.game_id)));
    const pick = {};
    up.forEach((g) => { const k = stateOf(CFB, g); if (!pick[k]) pick[k] = g; });
    console.log('     states among the board\'s games: ' + STATES.map((k) => k + '=' + (pick[k] || '—')).join(' '));
    const reads0 = boardReads.length;
    for (const k of STATES) {
      const gid = pick[k]; if (!gid) continue;
      await page.evaluate((g) => window.fbOpenGame('p4', g), gid);
      await page.waitForFunction((g) => { const e = document.getElementById('p4gate-' + g); const s = e && e.querySelector('[data-pp-gsec]'); return s && (s.querySelector('.pp-pstate') || s.querySelector('.pp-rsec-h.sub')); }, gid, { timeout: 30000 }).catch(() => {});
      const c = await page.evaluate((g) => {
        const e = document.getElementById('p4gate-' + g); if (!e) return null;
        const s = e.querySelector('[data-pp-gsec]'), act = e.querySelector('.edd-act'), res = e.querySelector('[data-edd-research]');
        return { t: s ? s.innerText : '', open: !!(s && s.closest('.gx-sec.open')), afterDecision: !act || !!(s && (act.compareDocumentPosition(s) & 4)),
          outsideResearch: !(res && s && res.contains(s)), n: e.querySelectorAll('[data-pp-gsec]').length };
      }, gid);
      chk(k + ' · FBS card ' + gid + ': one PLAYER PROP RESEARCH section, open, beside the decision (outside the collapsible research), in its state',
        c && c.n === 1 && c.open && c.afterDecision && c.outsideResearch && /PLAYER PROP RESEARCH/.test(c.t) && LABEL[k].test(c.t), c);
      await shot(page, 'app_cfb_' + k + '_' + gid, '#p4gate-' + gid + ' [data-pp-gsec]');
    }
    chk('the FBS cards never read the prop board on their own', boardReads.length === reads0, boardReads.slice(reads0));
    const loadGid = pick.A || pick.B;
    if (loadGid) {
      await page.evaluate((g) => window.fbOpenGame('p4', g), loadGid);
      await page.evaluate((g) => { const b = Array.from(document.querySelectorAll('#p4gate-' + g + ' [data-pp-gsec] button')).find((x) => x.textContent === 'Load player props'); b.click(); }, loadGid);
      await page.waitForFunction((g) => /props projected/.test((document.querySelector('#p4gate-' + g + ' [data-pp-gsec]') || {}).innerText || ''), loadGid, { timeout: 30000 });
      const full = await page.evaluate((g) => document.querySelector('#p4gate-' + g + ' [data-pp-gsec]').innerText, loadGid);
      chk('"Load player props" re-prices every priced prop in place (groups, headline projections), same header', /PLAYER PROP RESEARCH/.test(full) && /props projected/.test(full) && /All props for this game/.test(full), full.slice(0, 300));
    }
    chk('no page errors on the FBS cards', errors.length === 0, errors);
    await ctx.close();

    /* ------------------------------------------ the app's NFL game card */
    console.log('app · NFL game card (fbOpenGame)');
    ({ ctx, page, errors } = await open({ width: 1280, height: 1000 }));
    await page.goto(base + '/app.html#research/football', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.fbOpenGame === 'function' && !!window.EDPropsUI, null, { timeout: 30000 });
    await page.evaluate(() => { try { window.researchGo('football'); } catch (e) { /* shell */ } });
    const npick = {};
    Object.keys(NFLS.events).forEach((g) => { const k = stateOf(NFLS, g); if (!npick[k]) npick[k] = g; });
    console.log('     states among the NFL summary\'s games: ' + STATES.map((k) => k + '=' + (npick[k] || '—')).join(' '));
    const reads1 = boardReads.length;
    for (const k of STATES) {
      const gid = npick[k]; if (!gid) continue;
      await page.evaluate((g) => window.fbOpenGame('nfl', g), gid);
      await page.waitForFunction((g) => { const e = document.getElementById('fbg-nfl-' + g); const s = e && e.querySelector('[data-pp-gsec]'); return s && (s.querySelector('.pp-pstate') || s.querySelector('.pp-rsec-h.sub')); }, gid, { timeout: 90000 }).catch(() => {});
      const c = await page.evaluate((g) => { const e = document.getElementById('fbg-nfl-' + g); if (!e) return null; const d = e.querySelector('details.fb-props'), s = e.querySelector('[data-pp-gsec]'); return { t: s ? s.innerText : '', open: !!(d && d.open), n: e.querySelectorAll('[data-pp-gsec]').length }; }, gid);
      chk(k + ' · NFL card ' + gid + ': one PLAYER PROP RESEARCH section, open, in its state', c && c.n === 1 && c.open && /PLAYER PROP RESEARCH/.test(c.t) && LABEL[k].test(c.t), c);
      if (k === 'A') {
        const n = await page.evaluate((g) => document.querySelectorAll('#fbg-nfl-' + g + ' [data-pp-gsec] .pp-rc').length, gid);
        chk('A · NFL card shows the best research-grade props directly (1-4) and "View all ' + NFLS.events[gid].total_props + ' props"', n >= 1 && n <= 4 && c.t.indexOf('View all ' + NFLS.events[gid].total_props + ' props') >= 0, { n });
      }
      await shot(page, 'app_nfl_' + k + '_' + gid, '#fbg-nfl-' + gid + ' details.fb-props');
    }
    chk('the NFL cards never read the prop board on their own', boardReads.length === reads1, boardReads.slice(reads1));
    chk('no page errors on the NFL cards', errors.length === 0, errors);
    await ctx.close();
  } catch (e) {
    fail++; console.log('  FAIL (threw) ' + (e && e.stack || e));
  } finally {
    await browser.close(); srv.close();
  }
  console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' | player prop research on every matchup page (browser) | ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
