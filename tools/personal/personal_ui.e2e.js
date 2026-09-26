#!/usr/bin/env node
/* ===========================================================================
   THE PERSONAL RESEARCH TERMINAL, IN A REAL BROWSER, ON A PHONE AND A DESK.

   The shipped app.html and lib/edgedesk_personal_ui.js in Chromium, with the
   database answered at the HTTP boundary by an in-memory PostgREST (the same
   query grammar tools/lib/fake_pgrest.js parses) so every request the page
   makes is recorded and asserted:

     1  onboarding opens for an account with no preferences, and saving it
        writes user_preferences and alert_preferences — or skipping writes
        onboarding_status = skipped
     2  the research desk shows the live proof metrics, the Top 5 with its
        numbers, "why it's worth researching", "possible concern" and the
        "Research matchup" action, then My Watchlist
     3  the star adds a game (POST watchlist_games), removes it (DELETE) and
        re-adds it; the watchlist count follows
     4  the bell counts unread alerts; dismissing one PATCHes it
     5  "Log decision" POSTs a journal entry carrying the state's own numbers
     6  the journal and decision-quality tabs render without a profit figure
     7  settings: research alerts change a threshold; the partner program shows
        the partner's link
     8  the landing page states the whole offer on every trial CTA, records the
        visit, and shows a creator discount only from Stripe's record
     9  nothing scrolls sideways at 390px
    10  onboarding asks "What best describes how you research?" first; a reader
        who skipped it is asked once on the desk, and the answer reorders it
    11  Compare My Number: the reader's number beside EdgeDesk's and the
        market's, the differences, the inputs, saved to the journal
    12  a research card drawn at 1600×900 and 1080×1080 and recorded
    13  the trial actions and the acquisition claim reach their doors
    14  the public sample page, signed out: the research, the locked list and
        the offer; a game that is not public says so

   Run: node tools/personal/personal_ui.e2e.js           (add --shots DIR for screenshots)
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..', '..');
const P = require(path.join(ROOT, 'lib', 'edgedesk_personal.js'));
const X = require(path.join(ROOT, 'lib', 'edgedesk_pricing.js'));
const { parseQuery, matches, cmp } = require(path.join(ROOT, 'tools', 'lib', 'fake_pgrest.js'));
const MINE = require(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_mine.js'));
const si = process.argv.indexOf('--shots');
const SHOTS = si >= 0 ? (process.argv[si + 1] || path.join(ROOT, '.personal-shots')) : null;

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; console.log('  ok   ' + name); return; } fail++; failures.push(name); console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 300) : '')); }
function done() {
  console.log('\n' + (fail === 0 ? 'PASS | personal research UI | ' + pass + ' assertions' : 'FAIL | personal research UI | ' + pass + ' passed, ' + fail + ' failed'));
  process.exit(fail === 0 ? 0 : 1);
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function siteHandler(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  let file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (file.startsWith(ROOT) && fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(fs.readFileSync(file));
}
const serve = (h) => new Promise((r) => { const s = http.createServer(h); s.listen(0, '127.0.0.1', () => r({ srv: s, port: s.address().port })); });
/* a request the page makes a moment after what it shows: poll for it */
async function eventually(cond, ms) { const until = Date.now() + (ms || 5000); while (Date.now() < until) { if (cond()) return true; await new Promise((r) => setTimeout(r, 100)); } return cond(); }

/* ── the slate the server would have written ─────────────────────────────── */
const UID = '00000000-0000-0000-0000-0000000000e2';
const KO = (d) => new Date(Date.now() + d * 864e5).toISOString();
function mk(o) {
  return P.normalizeState(Object.assign({
    sport: 'cfb', status: 'RESEARCH', projected: true, computed_at: new Date(Date.now() - 20 * 60000).toISOString(),
    market: { kind: 'live', book: 'DraftKings', books: 4, stale: false, age_h: 0.5, captured_at: new Date(Date.now() - 30 * 60000).toISOString() },
    reliability: { score: 88, grade: 'STRONG', tier: 'STRONG', scored: true, stability: { tier: 'HIGH' } },
    research_label: 'WORTH_RESEARCHING', win_prob_home: 0.46,
    qb: { home: { name: 'Home QB', status: 'CONFIRMED', confirmed: true }, away: { name: 'Away QB', status: 'CONFIRMED', confirmed: true }, confirmed_both: true, unknown: false },
    injuries: { home: { known: true, out: [], doubtful: [], questionable: [] }, away: { known: true, out: ['WR One (WR)'], doubtful: [], questionable: [] } },
    movement: {}, drivers: [{ text: 'rushing matchup', points: 3.4 }], flags: ['LARGE_DISAGREEMENT'], qualifiers: []
  }, o));
}
const STATES = [
  mk({ game_key: 'cfb|9001', game_id: '9001', home: 'Florida', away: 'Ole Miss', kickoff_at: KO(1.5), fair: { home_line: 1.7, text: 'Ole Miss -1.7', model_version: 'edgedesk_cfb_p4_v1.0.0' },
    market: { home_line: -2.5, text: 'Florida -2.5', kind: 'live', book: 'DraftKings', books: 4, captured_at: new Date(Date.now() - 30 * 60000).toISOString() }, gap: { points: 4.2 },
    priority: { eligible: true, rank: 1, score: 71.4, why_code: 'favorite_flip', why_text: 'Model flips the market favorite: EdgeDesk has Ole Miss by 1.7, the market has Florida by 2.5.' },
    key_reason: 'Model flips the market favorite.' }),
  mk({ game_key: 'cfb|9002', game_id: '9002', home: 'Texas Tech', away: 'Baylor', kickoff_at: KO(2), fair: { home_line: -7.1, text: 'Texas Tech -7.1' },
    market: { home_line: -4.5, text: 'Texas Tech -4.5', kind: 'live', book: 'FanDuel', books: 3 }, gap: { points: 2.6 }, reliability: { score: 74, grade: 'ADEQUATE', tier: 'ADEQUATE', scored: true },
    priority: { eligible: true, rank: 2, score: 55.2, why_code: 'large_disagreement', why_text: 'Model and market disagree by 2.6 points with 80% data coverage.' } }),
  mk({ game_key: 'nfl|2026_05_BUF_MIA', sport: 'nfl', game_id: '2026_05_BUF_MIA', home: 'Miami Dolphins', away: 'Buffalo Bills', kickoff_at: KO(3),
    fair: { home_line: 1.5 }, market: { home_line: 3.5, kind: 'consensus', book: null, books: null }, gap: { points: 2.0 },
    reliability: { score: null, scored: false, note: 'the NFL model publishes no reliability score' }, research_label: null,
    priority: { eligible: true, rank: 1, score: 40.1, why_text: 'Model sees this matchup much closer than the market does.' } })
];

/* ── the database, in memory, speaking PostgREST ──────────────────────────── */
function makeDb() {
  const T = {
    user_preferences: [], alert_preferences: [], watchlist_games: [], research_journal: [],
    user_alerts: [
      { id: 1, user_id: UID, game_key: 'cfb|9001', kind: 'qb_confirmed', title: 'QB status confirmed · Ole Miss @ Florida', body: 'QB status confirmed for Florida. Reliability increased from 76 to 86.', severity: 'notable', payload: {}, created_at: new Date(Date.now() - 36e5).toISOString(), read_at: null, dismissed_at: null },
      { id: 2, user_id: UID, game_key: 'cfb|9002', kind: 'fair_move', title: 'EdgeDesk fair line moved · Baylor @ Texas Tech', body: 'Texas Tech moved from -5.8 fair to -7.1 fair.', severity: 'info', payload: {}, created_at: new Date(Date.now() - 2 * 36e5).toISOString(), read_at: null, dismissed_at: null }
    ],
    game_research_state: STATES.map((s) => Object.assign(P.stateRow(s), { priority_rank: s.priority.rank })),
    subscriptions: [{ user_id: UID, status: 'trialing', price_id: 'price_e2e', current_period_end: KO(5), cancel_at_period_end: false, stripe_customer_id: 'cus_e2e' }]
  };
  const log = [];
  let jid = 1;
  function view(name) {
    if (name === 'my_watchlist') return T.watchlist_games.map((w) => {
      const s = T.game_research_state.find((x) => x.game_key === w.game_key) || {};
      return Object.assign({}, w, { state: s.state || null, state_hash: s.state_hash || null, kickoff_at: s.kickoff_at || w.kickoff_at,
        changed: !!(w.seen_hash && s.state_hash && w.seen_hash !== s.state_hash) });
    });
    return T[name] || [];
  }
  function handle(method, table, qs, body, prefer) {
    log.push({ method, table, qs, body });
    const q = parseQuery(qs);
    if (table.startsWith('rpc/')) {
      const fn = table.slice(4);
      if (fn === 'edgedesk_proof_metrics') return { games_on_slate: 3, games_analyzed: 3, research_grade: 3, qb_confirmed: 3, active_market_quotes: 212, books_represented: 9,
        avg_reliability: 81, reliability_scored: 2, model_updated_at: new Date(Date.now() - 20 * 60000).toISOString(), market_updated_at: new Date(Date.now() - 30 * 60000).toISOString() };
      if (fn === 'affiliate_my_dashboard') return { ok: true, account: { code: 'COACHBIGGS', status: 'active', commission_rate: 0.25, created_at: KO(-30) },
        settings: { hold_days: 30, commission_duration_months: 12 }, stats: { clicks: 120, clicks_30d: 40, signups: 12, trials: 9, paid_customers: 4, active_paid: 3, canceled: 1,
          pending_cents: 3999, approved_cents: 2000, paid_cents: 6000, eligible_now_cents: 0 } };
      if (fn === 'affiliate_claim') return { ok: true, code: 'COACHBIGGS' };
      if (fn === 'edp_track' || fn === 'acq_claim' || fn === 'acq_track_visit') return { ok: true };
      if (fn === 'affiliate_offer') return { ok: true, code: 'COACHBIGGS', campaign: true, checkout_code: 'COACHBIGGS',
        discount: { type: 'percent', percent_off: 20, duration: 'repeating', duration_in_months: 3, source: 'stripe' } };
      if (fn === 'public_sample_research') {
        if (!body || body.p_game_key !== 'cfb|9001') return { ok: false, reason: 'not_public' };
        const s0 = STATES[0];
        return { ok: true, game_key: s0.game_key, sport: 'cfb', home: s0.home, away: s0.away, kickoff_at: s0.kickoff_at, started: false, computed_at: s0.computed_at,
          model_version: 'edgedesk_cfb_p4_v1.0.0', fair: { home_line: 1.7, text: 'Ole Miss -1.7', total: 51.5 },
          market: { home_line: -2.5, text: 'Florida -2.5', total: 49.5, kind: 'live', book: 'DraftKings', captured_at: s0.market.captured_at, stale: false, books: 4 },
          gap: { points: 4.2, toward: 'away' }, reliability: { score: 88, grade: 'STRONG', scored: true, main_deduction: null },
          research_label: 'WORTH_RESEARCHING', research_grade: true, key_reason: 'Model flips the market favorite.',
          drivers: [{ text: 'rushing matchup', points: 3.4 }], qb: { home: { name: 'Home QB', confirmed: true }, away: { name: 'Away QB', confirmed: true }, confirmed_both: true },
          availability: { home: { known: true, out: 0, doubtful: 0, questionable: 0 }, away: { known: true, out: 1, doubtful: 0, questionable: 0 } },
          locked: ['win probability', 'the research-priority ranking and why', 'the full driver breakdown', 'line movement since the open', 'the rest of the board', 'watchlist, alerts and journal', 'the AI research desk'] };
      }
      if (fn === 'public_sample_list') return [{ game_key: 'cfb|9001', sport: 'cfb', home: 'Florida', away: 'Ole Miss', kickoff_at: STATES[0].kickoff_at, fair_text: 'Ole Miss -1.7', market_text: 'Florida -2.5', gap_pts: 4.2, reliability_score: 88 }];
      if (fn === 'newsletter_my_preferences') return { ok: true };
      return null;
    }
    const base = table === 'my_watchlist' ? view(table) : (T[table] = T[table] || []);
    if (method === 'GET') {
      let rows = base.filter((r) => q.filters.every((f) => matches(r, f)));
      if (q.order) rows = rows.slice().sort((a, b) => { const c = cmp(a[q.order.col], b[q.order.col]); return q.order.dir === 'desc' ? -c : c; });
      if (q.limit != null) rows = rows.slice(0, q.limit);
      return rows;
    }
    if (method === 'POST') {
      const keys = String(q.onConflict || '').split(',').filter(Boolean);
      const out = [];
      (body || []).forEach((r0) => {
        const r = Object.assign({}, r0);
        if (table !== 'game_research_state' && !r.user_id) r.user_id = UID;
        if (table === 'research_journal') { r.entry_id = 'j' + (jid++); r.created_at = new Date().toISOString(); }
        const hit = keys.length ? base.find((x) => keys.every((k) => String(x[k]) === String(r[k]))) : null;
        if (hit) { if (/ignore-duplicates/.test(prefer || '')) return; Object.assign(hit, r); out.push(hit); }
        else { base.push(r); out.push(r); }
      });
      return /return=representation/.test(prefer || '') ? out : null;
    }
    if (method === 'PATCH') { base.filter((r) => q.filters.every((f) => matches(r, f))).forEach((r) => Object.assign(r, body)); return null; }
    if (method === 'DELETE') { const keep = base.filter((r) => !q.filters.every((f) => matches(r, f))); T[table] = keep; return null; }
    return null;
  }
  return { T, log, handle };
}

async function withPage(browser, site, viewport, db, init) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await ctx.addInitScript((a) => {
    try {
      localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
      localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'e2e', refresh_token: 'e2e', expires_at: Math.floor(Date.now() / 1000) + 86400,
        user: { id: a.uid, email: 'reader@edgedesk.test' } }));
      if (a.ref) localStorage.setItem('edgedesk_attribution', JSON.stringify({ ref: a.ref }));
      localStorage.setItem('edgedesk_visitor', 'visitorabcdefghijklmnop');
    } catch (e) { /* private mode */ }
  }, Object.assign({ uid: UID }, init || {}));
  await ctx.route('**/*', async (route) => {
    const req = route.request(), url = req.url();
    if (url.indexOf('127.0.0.1') >= 0) return route.continue();
    const m = /supabase\.co\/rest\/v1\/([^?]+)\??(.*)$/.exec(url);
    if (m) {
      let body = null; try { body = req.postData() ? JSON.parse(req.postData()) : null; } catch (_) { body = null; }
      const out = db.handle(req.method(), decodeURIComponent(m[1]), m[2] || '', body, req.headers().prefer || '');
      return route.fulfill({ status: out === null && req.method() !== 'GET' ? 201 : 200, contentType: 'application/json', body: out === null ? '' : JSON.stringify(out) });
    }
    if (/functions\/v1\/edgedesk_ai/.test(url)) {
      let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (_) { body = {}; }
      db.log.push({ method: 'POST', table: 'fn/edgedesk_ai', body });
      const intent = MINE.classify(body.question || '');
      if (!intent) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ answer: '', error: 'not in this fixture' }) });
      const T = db.T;
      const watch = T.watchlist_games.map((w) => Object.assign({}, w, { state: (T.game_research_state.find((x) => x.game_key === w.game_key) || {}).state || null }));
      const out = MINE.answer(intent, { watchlist: watch, alerts: T.user_alerts, journal: T.research_journal, top: STATES, slate: STATES, history: [] }, { question: body.question });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ answer: out.text, model: null, mine: out, deterministic_mine_answer: out.text, narration: { ok: true, prose: 'DETERMINISTIC' } }) });
    }
    if (/supabase\.co/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    return route.fulfill({ status: 204, body: '' });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message).slice(0, 240)));
  return { ctx, page, errors };
}

(async function main() {
  let pw = null;
  try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }
  const site = await serve(siteHandler);
  let browser = null;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) {
    const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (fs.existsSync(exe)) browser = await pw.chromium.launch({ headless: true, executablePath: exe });
    else { console.log('SKIPPED: no Chromium'); site.srv.close(); process.exit(0); }
  }
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false }); };

  try {
    for (const vp of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
      console.log('\n== ' + vp.name + ' (' + vp.width + 'px) ==');
      const db = makeDb();
      const { ctx, page, errors } = await withPage(browser, site, { width: vp.width, height: vp.height }, db, { ref: 'coachbiggs' });
      await page.goto(`http://127.0.0.1:${site.port}/app.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.EDMine && window.EDMine.S && window.EDMine.S.ready, null, { timeout: 40000 });

      /* 1 onboarding */
      await page.waitForSelector('#edmOnb.on', { timeout: 15000 });
      chk('onboarding opens for an account with no preferences', true);
      const onbText = await page.textContent('#edmOnb');
      chk('it starts with the one persona question and can be skipped', /What best describes how you research\?/.test(onbText) && /I build my own numbers/.test(onbText)
        && /I create betting content/.test(onbText) && /Skip for now/.test(onbText) && /Step 1 of 6/.test(onbText), onbText.slice(0, 300));
      await shot(page, vp.name + '-1-onboarding');
      if (vp.name === 'mobile') {
        /* the other path: skipping is one tap, stored, and the desk still works */
        await page.click('#edmOnb button:has-text("Skip for now")');
        await page.waitForFunction(() => !document.getElementById('edmOnb').classList.contains('on'));
        const sk = db.T.user_preferences[0] || {};
        chk('skipping onboarding is stored, so it does not reopen', sk.onboarding_status === 'skipped', sk);
        chk('and writes no alert thresholds the reader never chose', db.T.alert_preferences.length === 0);
        await page.evaluate(() => window.researchGo('rdesk'));
      } else {
      await page.click('#edmOnb .edm-chip:has-text("I research games before betting")');
      chk('a persona is one tap, and it stays chosen', await page.$eval('#edmOnb .edm-chip.on', (e) => e.textContent) === 'I research games before betting');
      await page.click('#edmOnb button:has-text("Continue")');
      await page.waitForFunction(() => /What do you research\?/.test(document.getElementById('edmOnb').textContent));
      await page.click('#edmOnb .edm-chip:has-text("Both")');
      await page.click('#edmOnb button:has-text("Continue")');
      await page.waitForFunction(() => /sportsbooks/.test(document.getElementById('edmOnb').textContent));
      await page.click('#edmOnb .edm-chip:has-text("DraftKings")');
      await page.click('#edmOnb button:has-text("Continue")');
      await page.click('#edmOnb .edm-chip:has-text("CLV tracking")');
      await page.click('#edmOnb button:has-text("Continue")');
      await page.fill('#onbGap', '2.5');
      /* the page styles every input as a full-width field; the step-4
         checkboxes must keep their own size and sit beside their words */
      const cbs = await page.evaluate(() => [...document.querySelectorAll('#edmOnb .edm-cb')].map((l) => {
        const i = l.querySelector('input').getBoundingClientRect(), t = l.querySelector('span').getBoundingClientRect(), r = l.getBoundingClientRect();
        return { w: i.width, left: i.left - r.left, gap: t.left - i.right };
      }));
      chk('the alert checkboxes are box-sized, at the left, beside their text', cbs.length === 3 && cbs.every((c) => c.w <= 24 && c.left < 24 && c.gap >= 0 && c.gap < 24), cbs);
      await shot(page, vp.name + '-1b-alerts-step');
      await page.click('#edmOnb button:has-text("Continue")');
      await page.click('#edmOnb button:has-text("Go to my research desk")');
      await page.waitForFunction(() => !document.getElementById('edmOnb').classList.contains('on'));
      const prefs = db.T.user_preferences[0] || {};
      chk('onboarding saved the leagues, books and interests', JSON.stringify(prefs.leagues) === '["cfb","nfl"]' && prefs.books.indexOf('draftkings') >= 0 && prefs.interests.indexOf('clv') >= 0 && prefs.onboarding_status === 'completed', prefs);
      chk('and the persona', prefs.persona === 'researcher', prefs);
      chk('and the alert threshold chosen on step 4', +(db.T.alert_preferences[0] || {}).gap_min_pts === 2.5, db.T.alert_preferences[0]);
      }
      chk('the claim for the partner code was made once, with the visitor id', db.log.filter((l) => l.table === 'rpc/affiliate_claim').length === 1
        && db.log.find((l) => l.table === 'rpc/affiliate_claim').body.p_code === 'COACHBIGGS');
      await page.waitForFunction(() => true);
      let acq = db.log.filter((l) => l.table === 'rpc/acq_claim');
      await eventually(() => db.log.some((l) => l.table === 'rpc/acq_claim'));
      chk('the acquisition claim is made once, with the visitor and the stored first touch', db.log.filter((l) => l.table === 'rpc/acq_claim').length === 1 && acq.length <= 1 && (acq = db.log.filter((l) => l.table === 'rpc/acq_claim')).length === 1 && acq[0].body.p_visitor === 'visitorabcdefghijklmnop'
        && acq[0].body.p_first && acq[0].body.p_first.ref === 'coachbiggs', acq.map((x) => x.body));
      chk('a visit is recorded as a trial action', db.log.some((l) => l.table === 'rpc/edp_track' && l.body.p_kind === 'visit'));

      /* 2 the desk */
      await page.waitForSelector('#edmTop5 .edm-top', { timeout: 15000 }).catch(async (e) => {
        const dbg = await page.evaluate(() => ({ sub: window.RESEARCH_SUB, host: (document.getElementById('rdeskHost') || {}).innerHTML ? document.getElementById('rdeskHost').innerHTML.slice(0, 600) : null,
          top: (document.getElementById('edmDeskTop') || {}).innerHTML ? document.getElementById('edmDeskTop').innerHTML.slice(0, 900) : null, prefs: window.EDMine && window.EDMine.S.prefs, ready: window.EDMine && window.EDMine.S.ready, schema: window.EDMine && window.EDMine.S.schema, serverTop: window.EDMine && (window.EDMine.S.serverTop || []).length,
          vis: (function () { var v = document.getElementById('v-rdesk'); return v ? v.className : null; })() }));
        console.log('DEBUG', JSON.stringify(dbg));
        throw e;
      });
      const top = await page.textContent('#edmTop5');
      chk('the Top 5 is on the desk, first', /Top 5 Games to Research/.test(top));
      chk('its first entry shows EdgeDesk, market, gap and reliability', /Ole Miss @ Florida/.test(top) && /Ole Miss -1\.7/.test(top) && /Florida -2\.5/.test(top) && /4\.2 pts/.test(top) && /88/.test(top), top.slice(0, 400));
      chk('with "why it’s worth researching" from the state’s own fields', /Why it’s worth researching/.test(top) && /confirmed QB status on both sides/.test(top));
      chk('and a possible concern', /Possible concern/.test(top) && /leans heavily on one input: rushing matchup/.test(top));
      chk('and the research CTA, never "best bets"', /Research matchup/.test(top) && !/best bet|lock|smash|guarantee/i.test(top));
      await page.waitForFunction(() => /games analyzed/.test((document.getElementById('edmProof') || {}).textContent || ''), null, { timeout: 8000 }).catch(() => null);
      const proof = await page.textContent('#edmProof');
      chk('the live proof metrics are real counts', /3 games analyzed/.test(proof) && /212 active market quotes/.test(proof) && /9 sportsbooks represented/.test(proof), proof);
      chk('and carry no user count or profit', !/users|customers|profit|roi|won/i.test(proof));
      const desk = await page.textContent('#rdeskHost');
      const order = ['Top 5 Games to Research', 'My Watchlist', 'Active research opportunities', 'Recent meaningful changes', 'My decision quality'].map((t) => desk.indexOf(t));
      chk('the desk reads Top 5 → watchlist → board → changes → decision quality', order.every((x, i) => x >= 0 && (i === 0 || x > order[i - 1])), order);
      chk('the Top 5 on the desk is recorded as opened', await eventually(() => db.log.some((l) => l.table === 'rpc/edp_track' && l.body.p_kind === 'top5_opened')));
      if (vp.name === 'desktop') chk('the desk says it is arranged for how the reader researches', /Arranged for how you research/.test(desk) && /I research games before betting/.test(desk));
      chk('Compare My Number and share cards are on the desk too', /Compare My Number/.test(desk) && /Share research cards/.test(desk));
      chk('the bell counts two unread alerts', (await page.textContent('#edmBell .edm-badge')) === '2');
      chk('the trial chip says how long the trial has left', /Trial · \d+ days? left/.test(await page.textContent('#edmAcct')));
      await shot(page, vp.name + '-2-desk');

      /* 3 the star */
      await page.click('#edmTop5 .edm-top >> nth=0 >> .edm-star');
      await page.waitForFunction(() => document.querySelector('#edmTop5 .edm-star.on'));
      chk('the star adds the game to the watchlist', db.T.watchlist_games.length === 1 && db.T.watchlist_games[0].game_key === 'cfb|9001', db.T.watchlist_games);
      chk('it stores the state the reader saw with it', db.T.watchlist_games[0].seen_hash === STATES[0].state_hash);
      await page.waitForFunction(() => /My Watchlist/.test(document.getElementById('rdeskHost').textContent) && /1 game/.test(document.getElementById('rdeskHost').textContent));
      chk('My Watchlist shows it', true);
      await page.click('#edmTop5 .edm-top >> nth=0 >> .edm-star');
      await page.waitForFunction(() => !document.querySelector('#edmTop5 .edm-star.on'));
      chk('tapping again removes it (DELETE)', db.T.watchlist_games.length === 0 && db.log.some((l) => l.method === 'DELETE' && l.table === 'watchlist_games'));
      await page.click('#edmTop5 .edm-top >> nth=0 >> .edm-star');
      await page.waitForFunction(() => document.querySelector('#edmTop5 .edm-star.on'));

      /* 4 alerts */
      await page.click('#edmBell');
      await page.waitForSelector('#edmPanel.on .edm-al');
      chk('the bell opens the alerts', /QB status confirmed for Florida\. Reliability increased from 76 to 86\./.test(await page.textContent('#edmPanel')));
      await shot(page, vp.name + '-3-alerts');
      await page.click('#edmPanel .edm-al >> nth=1 >> button:has-text("Dismiss")');
      await page.waitForFunction(() => document.querySelectorAll('#edmPanel .edm-al').length === 1);
      chk('dismissing PATCHes the alert', db.log.some((l) => l.method === 'PATCH' && l.table === 'user_alerts' && l.body && l.body.dismissed_at));
      await page.click('#edmPanel button[role=tab]:has-text("Watchlist")');
      await page.waitForSelector('#edmPanel .edm-wr');
      const wl = await page.textContent('#edmPanel');
      chk('the watchlist row carries QB, availability, win probability and the key reason',
        /Quarterbacks/.test(wl) && /Availability/.test(wl) && /Win probability/.test(wl) && /Why EdgeDesk disagrees/.test(wl), wl.slice(0, 300));
      await shot(page, vp.name + '-4-watchlist');
      await page.click('#edmPanel .edm-x');

      /* 5 the journal */
      await page.click('#edmTop5 .edm-top >> nth=0 >> button:has-text("Log decision")');
      await page.waitForSelector('#edmJModal.on');
      chk('the decision form shows EdgeDesk’s numbers at this moment', /EdgeDesk at this moment/.test(await page.textContent('#edmJModal')));
      await page.click('#edmJDec .edm-chip:has-text("Wagered")');
      await page.selectOption('#edmJMkt', 'spread');
      await page.selectOption('#edmJSel', 'home');
      await page.fill('#edmJLine', '-2.5');
      await page.fill('#edmJOdds', '-110');
      await page.fill('#edmJNotes', 'Market has Florida; EdgeDesk has Ole Miss.');
      await shot(page, vp.name + '-5-journal');
      await page.click('#edmJSave');
      await page.waitForFunction(() => !document.getElementById('edmJModal').classList.contains('on'));
      const j = db.T.research_journal[0] || {};
      chk('the entry is saved with the state’s own numbers frozen', j.decision === 'wagered' && j.snap_fair_home_line === 1.7 && j.snap_market_home_line === -2.5
        && j.snap_reliability_score === 88 && j.snap_model_version === 'edgedesk_cfb_p4_v1.0.0' && /^js1-/.test(j.snapshot_hash) && j.snapshot && j.snapshot.qb.confirmed_both === true, j);
      chk('and the bet as entered', j.market_type === 'spread' && j.selection === 'home' && j.line === -2.5 && j.price_american === -110);

      /* 11 Compare My Number */
      await page.click('#edmTop5 .edm-top >> nth=0 >> button:has-text("Compare my number")');
      await page.waitForSelector('#edmCModal.on');
      chk('Compare my number opens on the game', /Ole Miss @ Florida/.test(await page.textContent('#edmCModal')) && await page.$eval('#edmCSave', (b) => b.disabled));
      await page.selectOption('#edmCTeam', 'home');
      await page.fill('#edmCLine', '-3.5');
      await page.fill('#edmCTotal', '47');
      await page.waitForFunction(() => /Where you differ/.test(document.getElementById('edmCOut').textContent));
      const cmp = await page.textContent('#edmCOut');
      chk('it sets the reader\'s number beside EdgeDesk\'s and the market\'s', /Florida -3\.5/.test(cmp) && /Ole Miss -1\.7/.test(cmp) && /Florida -2\.5/.test(cmp), cmp.slice(0, 300));
      chk('with the three differences', /Your number is 5\.2 pts more favourable to Florida than EdgeDesk’s/.test(cmp) && /than the market’s/.test(cmp) && /EdgeDesk’s number is 4\.2 pts more favourable to Ole Miss than the market’s/.test(cmp));
      chk('where they agree and differ, and the measured inputs behind it', /Where you differ/.test(cmp) && /measured inputs/.test(cmp) && /rushing matchup/.test(cmp));
      chk('and never a verdict on either number', /Neither number is declared right/.test(cmp) && !/\b(correct|wrong|better number|smarter)\b/i.test(cmp));
      chk('using it is recorded as a trial action', await eventually(() => db.log.some((l) => l.table === 'rpc/edp_track' && l.body.p_kind === 'compare_my_number' && l.body.p_game_key === 'cfb|9001')));
      await shot(page, vp.name + '-9-compare');
      await page.click('#edmCSave');
      await page.waitForFunction(() => !document.getElementById('edmCModal').classList.contains('on'));
      const cj = db.T.research_journal.find((x) => x.my_home_line != null) || {};
      chk('saving puts the reader\'s number in the journal beside EdgeDesk\'s numbers of that moment', cj.my_home_line === -3.5 && cj.my_total === 47 && cj.snap_fair_home_line === 1.7
        && cj.snap_market_home_line === -2.5 && cj.decision === 'researching' && /^js1-/.test(cj.snapshot_hash), cj);

      /* 12 a research card */
      await page.click('#edmTop5 .edm-top >> nth=0 >> button:has-text("Share card")');
      await page.waitForSelector('#edmSModal.on canvas');
      await page.waitForFunction(() => { const c = document.getElementById('edmSCanvas'); return c && c.width === 1600; }, null, { timeout: 8000 });
      await page.waitForFunction(() => true);
      const cardDims = await page.$eval('#edmSCanvas', (c) => ({ w: c.width, h: c.height, css: c.getBoundingClientRect().width }));
      chk('the card is drawn at 1600×900 for X and shown to fit the screen', cardDims.w === 1600 && cardDims.h === 900 && cardDims.css <= vp.width, cardDims);
      await page.waitForFunction(() => true);
      await eventually(() => (db.T.share_cards || []).length > 0);
      let sc = (db.T.share_cards || [])[0] || {};
      chk('the card is recorded with exactly what it printed', sc.game_key === 'cfb|9001' && sc.format === 'x_landscape' && sc.content && sc.content.tagline === 'Research, not picks.'
        && sc.content.site === 'edgedesksports.com' && sc.fair_home_line === 1.7 && /^sc1-/.test(sc.content_hash), sc);
      await shot(page, vp.name + '-10-card');
      await page.click('#edmSFmt button:has-text("Square")');
      await page.waitForFunction(() => document.getElementById('edmSCanvas').height === 1080);
      chk('the square format is 1080×1080 and recorded too', await eventually(() => (db.T.share_cards || []).some((x) => x.format === 'square')));
      chk('the card can be downloaded, posted on X or copied', /Download image/.test(await page.textContent('#edmSModal')) && /Post on X/.test(await page.textContent('#edmSModal')));
      await page.click('#edmSModal .edm-x');

      /* 6 journal and decision quality */
      await page.evaluate(() => window.EDMine.open('journal'));
      await page.waitForSelector('#edmPanel .edm-jr');
      const jt = await page.textContent('#edmPanel');
      chk('the journal lists it with the numbers from decision time', /EdgeDesk then/.test(jt));
      chk('and the reader\'s own number, with the close still to come', /Your number/.test(jt) && /Florida -3\.5 · total 47/.test(jt) && /the close is recorded after kickoff/.test(jt), jt.slice(0, 400));
      await page.click('#edmPanel button[role=tab]:has-text("Decision quality")');
      const q = await page.textContent('#edmPanel');
      chk('decision quality separates process from result', /Beat closing line/.test(q) && /Process and result are kept apart/.test(q));
      chk('and sets the reader\'s numbers beside EdgeDesk\'s and the close, declaring neither right', /Your numbers, EdgeDesk’s and the close/.test(q) && /declares neither number right/.test(q));
      chk('and shows no profit or celebration', !/profit|\broi\b|streak|congrat|winning streak/i.test(q));
      await shot(page, vp.name + '-6-quality');
      await page.click('#edmPanel .edm-x');

      /* 7 settings */
      await page.evaluate(() => { window.show('settings'); window.setGo('researchalerts'); });
      await page.waitForFunction(() => /Model-market gap exceeds/.test(document.getElementById('setPanel').textContent));
      const sa = await page.textContent('#setPanel');
      chk('research alerts are editable in Settings', /Reliability reaches at least/.test(sa) && /Quarterback confirmed or changed/.test(sa) && /In the app/.test(sa), sa.slice(0, 300));
      await page.fill('#setPanel input[aria-label=gap_min_pts]', '4');
      await page.dispatchEvent('#setPanel input[aria-label=gap_min_pts]', 'change');
      await page.waitForTimeout(400);
      chk('a changed threshold is saved', +(db.T.alert_preferences[0] || {}).gap_min_pts === 4, db.T.alert_preferences[0]);
      await page.evaluate(() => window.setGo('partner'));
      await page.waitForFunction(() => /COACHBIGGS/.test(document.getElementById('setPanel').textContent), null, { timeout: 8000 });
      const pp = await page.textContent('#setPanel');
      chk('the partner program shows the link and real counts', /edgedesksports\.com\/\?ref=COACHBIGGS/.test(pp) && /Trials started/.test(pp) && /\$60\.00/.test(pp));
      await shot(page, vp.name + '-7-partner');

      /* the AI desk: a question about the reader's own research goes to the
         server, and the answer is rendered from the reader's rows */
      await page.evaluate(() => window.EDAI.open());
      await page.waitForSelector('#edaiPanel.open', { timeout: 10000 });
      const beforeFn = db.log.filter((l) => l.table === 'fn/edgedesk_ai').length;
      await page.evaluate(() => { document.getElementById('edaiText').value = 'What is on my watchlist?'; return window.EDAI.sendText(); });
      await page.waitForFunction(() => /Your research/.test(document.getElementById('edaiLog').textContent), null, { timeout: 15000 });
      const aiText = await page.evaluate(() => { const n = [...document.querySelectorAll('#edaiLog .edai-msg.a')]; return n[n.length - 1].innerText; });
      chk('the AI question went to the desk, not the open card', db.log.filter((l) => l.table === 'fn/edgedesk_ai').length === beforeFn + 1);
      chk('the AI reads the watchlist: the watched game with EdgeDesk’s numbers', /You are watching 1 upcoming game/.test(aiText) && /Ole Miss @ Florida/.test(aiText) && /reliability 88/.test(aiText), aiText.slice(0, 300));
      chk('the AI answer says it came from the reader’s rows, no model', /EdgeDesk’s rows and words, no model/.test(aiText));
      chk('asking the AI desk is recorded as a trial action', await eventually(() => db.log.some((l) => l.table === 'rpc/edp_track' && l.body.p_kind === 'ai_research_used')));
      await shot(page, vp.name + '-8-ai');
      await page.evaluate(() => { try { window.EDAI.close(); } catch (_) { } });

      if (vp.name === 'mobile') {
        await page.evaluate(() => window.researchGo('rdesk'));
        await page.waitForSelector('#edmTop5');
        /* 10 the reader who skipped onboarding is asked once, on the desk */
        await page.waitForSelector('#edmPersonaAsk', { timeout: 8000 });
        chk('a reader who skipped onboarding is asked the persona question on the desk', /What best describes how you research\?/.test(await page.textContent('#edmPersonaAsk')));
        await page.click('#edmPersonaAsk .edm-chip:has-text("I build my own numbers")');
        await page.waitForFunction(() => !document.getElementById('edmPersonaAsk'));
        const pp2 = db.T.user_preferences[0] || {};
        chk('the answer is saved', pp2.persona === 'model_builder', pp2);
        const order2 = await page.evaluate(() => { const t = document.getElementById('rdeskHost').textContent; return [t.indexOf('Compare My Number'), t.indexOf('Top 5 Games to Research')]; });
        chk('and a model builder\'s desk now opens with Compare My Number, the Top 5 still below it', order2[0] >= 0 && order2[1] > order2[0], order2);
        await shot(page, vp.name + '-11-persona-desk');
        const sw = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
        chk('nothing scrolls sideways at 390px', sw.sw <= sw.w + 1, sw);
        await page.evaluate(() => window.EDMine.open('watchlist'));
        await page.waitForSelector('#edmPanel.on');
        const pw2 = await page.evaluate(() => document.querySelector('#edmPanel .edm-modal').getBoundingClientRect().width);
        chk('the panel fits the phone', pw2 <= 391, pw2);
      }
      const mine = errors.filter((e) => /EDMine|EDPersonal|edm|personal/i.test(e));
      chk('no page error from the personal layer', mine.length === 0, mine);
      await ctx.close();
    }

    /* 8 the landing page states the whole offer */
    console.log('\n== landing page ==');
    const db = makeDb();
    const { ctx, page } = await withPage(browser, site, { width: 1280, height: 900 }, db, {});
    await page.addInitScript(() => { try { localStorage.removeItem('edgedesk_session'); } catch (e) { } });
    await page.goto(`http://127.0.0.1:${site.port}/index.html?ref=COACHBIGGS`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    const lines = await page.$$eval('[data-ed-price="cta"]', (els) => els.map((e) => e.textContent.trim()));
    chk('every trial CTA carries the whole offer, verbatim', lines.length >= 4 && lines.every((t) => t === X.CTA_LINE), lines);
    chk('the nav price says what follows the free week', /then \$79\.99\/mo/.test(await page.textContent('.navprice')));
    chk('a partner link is counted as a click', db.log.some((l) => l.table === 'rpc/affiliate_track_click' && l.body.p_code === 'COACHBIGGS' && /^[A-Za-z0-9_-]{16,64}$/.test(l.body.p_visitor)));
    chk('the visit is recorded for acquisition with the signals it came with', db.log.some((l) => l.table === 'rpc/acq_track_visit' && l.body.p_touch && l.body.p_touch.ref === 'coachbiggs'));
    await page.waitForFunction(() => { const e = document.getElementById('edOffer'); return e && !e.hidden; }, null, { timeout: 8000 }).catch(() => null);
    chk('a creator discount is shown in Stripe\'s words, beside the unchanged offer', (await page.textContent('#edOffer')) === 'Code COACHBIGGS: 20% off your first 3 months after the free trial, applied by Stripe at checkout.');
    const html = await page.content();
    chk('no countdown timer or scarcity language', !/class="[^"]*countdown|id="[^"]*countdown|only \d+ (spots|seats|left)|offer expires|limited time|hurry/i.test(html));
    await ctx.close();

    /* 14 the public sample page, signed out */
    console.log('\n== public sample research ==');
    for (const vp of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      const db3 = makeDb();
      const w = await withPage(browser, site, vp, db3, {});
      await w.page.addInitScript(() => { try { localStorage.removeItem('edgedesk_session'); } catch (e) { } });
      await w.page.goto(`http://127.0.0.1:${site.port}/research/sample/?game=cfb%7C9001&ref=coachbiggs`, { waitUntil: 'domcontentloaded' });
      await w.page.waitForFunction(() => /Key matchup evidence/.test(document.getElementById('main').textContent), null, { timeout: 10000 });
      const t = await w.page.textContent('#main');
      chk(vp.width + 'px: a public game shows the fair line, the market, the gap and reliability', /Ole Miss -1\.7/.test(t) && /Florida -2\.5/.test(t) && /4\.2 pts/.test(t) && /Reliability\s*88/.test(t), t.slice(0, 300));
      chk(vp.width + 'px: the key matchup evidence and the method', /Model flips the market favorite/.test(t) && /rushing matchup/.test(t) && /How EdgeDesk builds this/.test(t) && /not a probability/.test(t));
      chk(vp.width + 'px: what stays behind the account is named', /Win probability/.test(t) && /The AI research desk/.test(t));
      chk(vp.width + 'px: "Research the full board" with the whole offer', /Research the full board/.test(t) && t.indexOf(X.CTA_LINE) >= 0);
      const href = await w.page.$eval('.cta a.btn', (a) => a.getAttribute('href'));
      chk(vp.width + 'px: the CTA carries the partner code on to the landing page', href === '/?ref=coachbiggs#subscribe', href);
      chk(vp.width + 'px: the visit is recorded for acquisition', await eventually(() => db3.log.some((l) => l.table === 'rpc/acq_track_visit' && l.body.p_touch.landing === '/research/sample/')));
      const sw3 = await w.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
      chk(vp.width + 'px: nothing scrolls sideways', sw3.sw <= sw3.w + 1, sw3);
      if (SHOTS) await w.page.screenshot({ path: path.join(SHOTS, 'sample-' + vp.width + '.png'), fullPage: true });
      await w.page.goto(`http://127.0.0.1:${site.port}/research/sample/?game=cfb%7C9002`, { waitUntil: 'domcontentloaded' });
      await w.page.waitForFunction(() => /isn’t public/.test(document.getElementById('main').textContent), null, { timeout: 10000 });
      chk(vp.width + 'px: a game that is not public says so, with the offer', /isn’t public/.test(await w.page.textContent('#main')) && /Research the full board/.test(await w.page.textContent('#main')));
      await w.ctx.close();
    }
  } catch (e) {
    chk('the suite ran without an unexpected error', false, String(e && e.stack).slice(0, 600));
  } finally {
    await browser.close();
    site.srv.close();
  }
  done();
})();
