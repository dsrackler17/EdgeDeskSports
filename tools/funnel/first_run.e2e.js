#!/usr/bin/env node
/* ===========================================================================
   THE TERMINAL'S FIRST RUN, IN A REAL BROWSER (lib/edgedesk_first_run.js).

   app.html as it ships, a brand-new trialing account, the database in memory
   speaking PostgREST (game_research_state with its state-> aliases,
   user_preferences, subscriptions, ed_first_run_state, ed_track):

     1  the entitled terminal opens → terminal_opened; the inline panel
        "Here's what EdgeDesk found today." appears in Research, above the
        board, with the largest disagreements, research-grade games,
        research-grade props, incomplete games and changed markets — each
        from the rows, never invented — and first_run_viewed
     2  the six-step onboarding modal waits while the panel's preferences
        are pending (one welcome, not two stacked)
     3  preferences are optional: saving writes leagues, focus, books and a
        favorite team (from this week's slate) and preferences_saved; the
        panel then leads with the reader's focus and stars the team
     4  the five-step progress reflects what the reader did (opening a game
        ticks "Open a game")
     5  Hide is remembered on the account (first_run_done_at)
     6  an account older than two weeks never sees it
     7  at 390 px nothing is wider than the screen
     8  on a slate where no prop qualifies, the prop card says so and lists
        none

   The published board (/football/home/board.json) is answered from
   tools/funnel/fixtures/home_board.json, a real publish with research-grade
   props, with its times moved relative to the browser's clock — not from the
   committed file, whose props the pipeline replaces every run.

   Needs Playwright with Chromium; prints SKIPPED and exits 0 without one.

   Run:  node tools/funnel/first_run.e2e.js [--shots <dir>]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const SHOTS = args.indexOf('--shots') >= 0 ? args[args.indexOf('--shots') + 1] : null;
const P = require(path.join(ROOT, 'lib', 'edgedesk_personal.js'));
const { parseQuery, matches, cmp } = require(path.join(ROOT, 'tools', 'lib', 'fake_pgrest.js'));

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; return; }
  fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 500) : ''));
}
async function eventually(cond, ms) { const until = Date.now() + (ms || 6000); while (Date.now() < until) { if (await cond()) return true; await new Promise((r) => setTimeout(r, 100)); } return !!(await cond()); }

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.csv': 'text/csv' };
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(file));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

const UID = '00000000-0000-0000-0000-0000000000f1';
const KO = (d) => new Date(Date.now() + d * 864e5).toISOString();
const AGO = (m) => new Date(Date.now() - m * 60e3).toISOString();
function mk(o) {
  return P.normalizeState(Object.assign({
    sport: 'cfb', status: 'RESEARCH', projected: true, computed_at: AGO(12), first_seen_at: AGO(60 * 30),
    market: { kind: 'live', book: 'draftkings', books: 4, stale: false, captured_at: AGO(25) },
    reliability: { score: 82, grade: 'STRONG', tier: 'STRONG', scored: true }, research_label: 'WORTH_RESEARCHING', win_prob_home: 0.44,
    qb: { confirmed_both: true }, movement: {}, drivers: [], flags: [], qualifiers: []
  }, o));
}
const STATES = [
  mk({ game_key: 'cfb|9101', game_id: '9101', home: 'Iowa', away: 'Ohio State', kickoff_at: KO(1.2), fair: { home_line: 7.7, text: 'Ohio State -7.7' },
    market: { home_line: 14, text: 'Ohio State -14.0', kind: 'live', book: 'fanduel', books: 5, stale: false, captured_at: AGO(25) }, gap: { points: 6.3, toward: 'home' },
    priority: { eligible: true, rank: 1, score: 70 }, key_reason: 'EdgeDesk is 6.3 points closer to Iowa than the market.', movement: { spread_moved: 1.5, toward_model: true } }),
  mk({ game_key: 'cfb|9102', game_id: '9102', home: 'Iowa State', away: 'West Virginia', kickoff_at: KO(1.4), fair: { home_line: -10.1, text: 'Iowa State -10.1' },
    market: { home_line: -3.5, text: 'Iowa State -3.5', kind: 'live', book: 'draftkings', books: 3, stale: false, captured_at: AGO(40) }, gap: { points: 6.6, toward: 'home' },
    priority: { eligible: true, rank: 2, score: 64 } }),
  mk({ game_key: 'nfl|2026_05_KC_BUF', sport: 'nfl', game_id: '2026_05_KC_BUF', home: 'Buffalo Bills', away: 'Kansas City Chiefs', kickoff_at: KO(3), research_label: null, status: 'INVESTIGATE',
    fair: { home_line: -6.5 }, market: { home_line: -2.5, kind: 'consensus', book: null, books: null }, gap: { points: 4.0 }, reliability: { score: null, scored: false },
    priority: { eligible: true, rank: 3, score: 40 } }),
  mk({ game_key: 'cfb|9103', game_id: '9103', home: 'Rice', away: 'Tulsa', kickoff_at: KO(2), status: 'NO MARKET', research_label: 'NO_MARKET', fair: { home_line: -2.0, text: 'Rice -2.0' },
    market: {}, gap: {}, priority: { eligible: false, rank: null, score: null } })
];
/* research_grade is the state job's own call; normalizeState derives it */
function rows() {
  return STATES.map((s) => {
    const r = Object.assign(P.stateRow(s), { priority_rank: s.priority && s.priority.rank != null ? s.priority.rank : null, first_seen_at: s.first_seen_at || AGO(60 * 30) });
    r.research_grade = s.game_key === 'cfb|9101' || s.game_key === 'cfb|9102';
    return r;
  });
}

/* the published board (football/home/board.json) is answered from a committed
   fixture (tools/funnel/fixtures/home_board.json), never the live snapshot: a
   data commit with nothing research-grade (props.items {}) is a valid slate,
   and the panel's prop card would then be empty for reasons of the day's
   data. Moved so its newest price is 4 minutes old and its first kickoff a
   day out. */
const BOARD = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'home_board.json'), 'utf8'));
const BOARD_PLAYERS = Object.values(BOARD.props.items).map((p) => p.player.name);
function shiftedStat(board) {
  const s = JSON.stringify(board);
  const re = /"(captured_at|last_success_at|evaluated_at|generated_at|summary_at)":"([^"]+)"/g;
  const ts = [...s.matchAll(re)].map((m) => Date.parse(m[2])).filter(isFinite);
  const d = (Date.now() - 4 * 60e3) - Math.max(...ts);
  const ko = /"(kickoff_at|kickoff)":"([^"]+)"/g;
  const ks = [...s.matchAll(ko)].map((m) => Date.parse(m[2])).filter(isFinite);
  const kd = ks.length ? (Date.now() + 24 * 3600e3) - Math.min(...ks) : 0;
  return s.replace(re, (m, k, v) => '"' + k + '":"' + new Date(Date.parse(v) + d).toISOString() + '"')
    .replace(ko, (m, k, v) => '"' + k + '":"' + new Date(Date.parse(v) + kd).toISOString() + '"');
}
/* the same board on a slate where no prop qualifies, as a data commit can
   publish it: no items, no top lists, zero research-grade */
function nothingQualifies(board) {
  const b = JSON.parse(JSON.stringify(board));
  b.props.items = {}; b.props.top = [];
  Object.values(b.props.counts).forEach((c) => { c.research_grade = 0; });
  Object.values(b.props.by_game).forEach((g) => { g.research_grade = 0; delete g.top; });
  return b;
}

function makeDb(createdAt) {
  const T = { user_preferences: [], watchlist_games: [], research_journal: [], user_alerts: [], alert_preferences: [], game_research_state: rows(),
    subscriptions: [{ user_id: UID, status: 'trialing', price_id: 'price_e2e', current_period_end: KO(6), cancel_at_period_end: false, stripe_customer_id: 'cus_e2e' }] };
  const events = [];
  function handle(method, table, qs, body, prefer) {
    const q = parseQuery(qs);
    if (table.startsWith('rpc/')) {
      const fn = table.slice(4);
      if (fn === 'ed_track') { (body && body.p_events || []).forEach((e) => events.push(e)); return { ok: true, accepted: (body.p_events || []).length }; }
      if (fn === 'ed_first_run_state') {
        const p = T.user_preferences[0] || null;
        const names = events.map((e) => e.event);
        return { ok: true, total: 5, account_created_at: createdAt, previous_visit_at: null,
          steps: { board: names.includes('board_viewed') || names.includes('first_run_viewed'), game: names.includes('game_opened'), prop: names.includes('prop_opened'),
            price: names.includes('ev_viewed') || names.includes('custom_price_checked'), save: names.includes('research_saved') },
          prefs: p ? { leagues: p.leagues || null, books: p.books || null, research_focus: p.research_focus || null, favorite_teams: p.favorite_teams || null,
            onboarding_status: p.onboarding_status || 'pending', first_run_seen_at: p.first_run_seen_at || null, first_run_done_at: p.first_run_done_at || null } : null };
      }
      return null;
    }
    const base = (T[table] = T[table] || []);
    if (method === 'GET') {
      let out = base.filter((r) => q.filters.every((f) => matches(r, f)));
      if (q.order) out = out.slice().sort((a, b) => { const c = cmp(a[q.order.col], b[q.order.col]); return q.order.dir === 'desc' ? -c : c; });
      if (q.limit != null) out = out.slice(0, q.limit);
      /* PostgREST's `alias:state->key` */
      const al = String(q.select || '').split(',').map((x) => /^([a-z_]+):state->([a-z_]+)$/.exec(x)).filter(Boolean);
      if (al.length) out = out.map((r) => { const o = Object.assign({}, r); al.forEach((m) => { o[m[1]] = r.state ? r.state[m[2]] : null; }); return o; });
      return out;
    }
    if (method === 'POST') {
      const keys = String(q.onConflict || '').split(',').filter(Boolean);
      (body || []).forEach((r0) => {
        const r = Object.assign({}, r0); if (!r.user_id && table !== 'game_research_state') r.user_id = UID;
        const hit = keys.length ? base.find((x) => keys.every((k) => String(x[k]) === String(r[k]))) : null;
        if (hit) Object.assign(hit, r); else base.push(r);
      });
      return null;
    }
    if (method === 'PATCH') { base.filter((r) => q.filters.every((f) => matches(r, f))).forEach((r) => Object.assign(r, body)); return null; }
    if (method === 'DELETE') { T[table] = base.filter((r) => !q.filters.every((f) => matches(r, f))); return null; }
    return null;
  }
  return { T, events, handle };
}

(async function main() {
  let pw = null;
  try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }
  const site = await serve();
  let browser = null;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) {
    const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (fs.existsSync(exe)) browser = await pw.chromium.launch({ headless: true, executablePath: exe });
    else { console.log('SKIPPED: no Chromium'); site.srv.close(); process.exit(0); }
  }
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const STAT = shiftedStat(BOARD);

  async function open(viewport, createdDaysAgo, stat) {
    const created = new Date(Date.now() - createdDaysAgo * 864e5).toISOString();
    const db = makeDb(created);
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    await ctx.addInitScript((a) => {
      try {
        localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'e2e', refresh_token: 'e2e', expires_at: Math.floor(Date.now() / 1000) + 86400,
          user: { id: a.uid, email: 'reader@edgedesk.test', created_at: a.created } }));
        localStorage.setItem('edgedesk_visitor', 'visitorabcdefghijklmnop');
      } catch (e) { /* private mode */ }
    }, { uid: UID, created });
    await ctx.route('**/*', async (route) => {
      const req = route.request(), url = req.url();
      if (url.indexOf('127.0.0.1') >= 0) {
        if (/\/football\/home\/board\.json/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: stat || STAT });
        return route.continue();
      }
      const m = /supabase\.co\/rest\/v1\/([^?]+)\??(.*)$/.exec(url);
      if (m) {
        let body = null; try { body = req.postData() ? JSON.parse(req.postData()) : null; } catch (_) { body = null; }
        const out = db.handle(req.method(), decodeURIComponent(m[1]), m[2] || '', body, req.headers().prefer || '');
        return route.fulfill({ status: out === null && req.method() !== 'GET' ? 201 : 200, contentType: 'application/json', body: out === null ? '' : JSON.stringify(out) });
      }
      if (/supabase\.co/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      return route.fulfill({ status: 204, body: '' });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message).slice(0, 240)));
    await page.goto('http://127.0.0.1:' + site.port + '/app.html', { waitUntil: 'domcontentloaded' });
    return { ctx, page, db, errors };
  }

  for (const vp of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const w = vp.width;
    const S = await open(vp, 1);
    const { page, db } = S;
    const shown = await eventually(() => page.evaluate(() => { const h = document.getElementById('edFirstRun'); return !!(h && /Here’s what EdgeDesk found today\./.test(h.textContent) && h.querySelector('.edfr-grid')); }), 30000);
    chk(w + ': a new trialing account sees "Here’s what EdgeDesk found today."', shown);
    if (!shown) { chk(w + ': (script errors)', false, S.errors); await S.ctx.close(); continue; }
    const r = await page.evaluate(() => {
      const h = document.getElementById('edFirstRun');
      const card = (t) => [...h.querySelectorAll('.edfr-card')].find((c) => c.querySelector('h4').textContent.indexOf(t) === 0);
      const items = (t) => { const c = card(t); return c ? [...c.querySelectorAll('.edfr-item')].map((b) => b.innerText.replace(/\s+/g, ' ').trim()) : null; };
      const research = document.getElementById('v-research');
      return {
        inResearch: !!(research && research.contains(h)), beforeSearch: !!(document.getElementById('rsSearchWrap') && (h.compareDocumentPosition(document.getElementById('rsSearchWrap')) & Node.DOCUMENT_POSITION_FOLLOWING)),
        sub: (h.querySelector('.edfr-sub') || {}).textContent || '',
        dis: items('Largest model'), games: items('Research-grade game'), props: items('Research-grade player'), inc: items('Games with incomplete'), chg: items('Recently changed'),
        steps: [...h.querySelectorAll('.edfr-steps li')].map((li) => li.className), prefsOpen: h.querySelector('.edfr-prefs').open,
        onb: !!(document.getElementById('edmOnb') && document.getElementById('edmOnb').classList.contains('on')),
        text: h.innerText
      };
    });
    chk(w + ': the panel sits in Research, above the board search', r.inResearch && r.beforeSearch, [r.inResearch, r.beforeSearch]);
    chk(w + ': it counts the slate from the rows', /4 games analyzed/.test(r.sub) && /2 game-market/.test(r.sub), r.sub);
    chk(w + ': the NFL game the state did not grade is WATCH', r.dis.some((t) => /Kansas City Chiefs @ Buffalo Bills WATCH/.test(t)), r.dis);
    chk(w + ': largest disagreements, widest first, with market and capture time', r.dis && r.dis.length === 3 && /West Virginia @ Iowa State/.test(r.dis[0]) && /40 min ago/.test(r.dis[0]), r.dis);
    chk(w + ': an NFL consensus market says what it is', r.dis.some((t) => /consensus reference, not a captured quote/.test(t)), r.dis);
    chk(w + ': research-grade games are the research-grade rows', r.games && r.games.length === 2 && r.games.every((t) => /RESEARCH/.test(t)), r.games);
    chk(w + ': research-grade props come from the published board, each with its price and age', r.props && r.props.length > 0 && r.props.every((t) => /RESEARCH|WATCH/.test(t) && /min ago|just now/.test(t)
      && BOARD_PLAYERS.some((n) => t.indexOf(n + ' · ') === 0)), r.props);
    chk(w + ': an incomplete game says why', r.inc && r.inc.length === 1 && /Tulsa @ Rice/.test(r.inc[0]) && /No current sportsbook market/.test(r.inc[0]), r.inc);
    chk(w + ': a moved market says how far and which way', r.chg && r.chg.length === 1 && /moved 1\.5 pts toward EdgeDesk/.test(r.chg[0]), r.chg);
    chk(w + ': five steps, the first already done by viewing the panel', r.steps.length === 5, r.steps);
    chk(w + ': preferences are offered, open, and optional', r.prefsOpen && /optional/.test(r.text) && /Skip/.test(r.text));
    chk(w + ': the six-step onboarding modal waits (one welcome, not two)', !r.onb);
    chk(w + ': never a pick', !/\b(lock|guarantee|best bet)\b/i.test(r.text) && /never a pick/.test(r.text));
    await eventually(() => db.events.some((e) => e.event === 'first_run_viewed'), 5000);
    const names = db.events.map((e) => e.event);
    chk(w + ': terminal_opened and first_run_viewed recorded once each', names.filter((n) => n === 'terminal_opened').length === 1 && names.filter((n) => n === 'first_run_viewed').length === 1, names);
    chk(w + ': the account remembers the panel was seen', !!(db.T.user_preferences[0] && db.T.user_preferences[0].first_run_seen_at));
    if (w === 390) {
      const ov = await page.evaluate(() => {
        const W = window.innerWidth; const h = document.getElementById('edFirstRun');
        return [...h.querySelectorAll('*')].filter((el) => { const b = el.getBoundingClientRect(); return b.width && (b.right > W + 1 || b.left < -1); }).map((el) => el.className || el.tagName).slice(0, 5);
      });
      chk('390: nothing in the panel is wider than the screen', ov.length === 0, ov);
    }
    if (SHOTS) { await page.evaluate(() => document.getElementById('edFirstRun').scrollIntoView()); await page.screenshot({ path: path.join(SHOTS, 'first-run-' + w + '.png'), fullPage: false }); }

    if (w === 1280) {
      /* 3 preferences */
      await page.click('#edFirstRun input[name="lg"][value="cfb"]');
      await page.click('#edFirstRun input[name="focus"][value="player_props"]');
      const book = await page.$('#edFirstRun input[name="book"]');
      if (book) await book.click();
      await page.fill('#edfrTeam', 'Iowa');
      await page.click('#edFirstRun [data-fr="team-add"]');
      await page.click('#edFirstRun [data-fr="save"]');
      await eventually(() => db.events.some((e) => e.event === 'preferences_saved'), 5000);
      const pref = db.T.user_preferences[0] || {};
      chk('saving writes leagues, focus, books and the team key', JSON.stringify(pref.leagues) === '["cfb"]' && pref.research_focus === 'player_props' && Array.isArray(pref.books) && pref.books.length === 1
        && JSON.stringify(pref.favorite_teams) === '["cfb:iowa"]' && pref.onboarding_status === 'completed', pref);
      chk('and records preferences_saved', db.events.some((e) => e.event === 'preferences_saved' && e.props && e.props.focus === 'player_props'));
      const after = await page.evaluate(() => {
        const h = document.getElementById('edFirstRun');
        return { first: h.querySelector('.edfr-card h4').textContent, star: [...h.querySelectorAll('.edfr-item .fav')].length, msg: (h.querySelector('[data-fr-msg]') || {}).textContent };
      });
      chk('a props reader\'s panel now leads with props', /^Research-grade player props/.test(after.first), after.first);
      chk('and stars the favorite team\'s games', after.star > 0, after);
      await page.waitForTimeout(3500);
      chk('the six-step onboarding modal does not ask a second time', !(await page.evaluate(() => { const o = document.getElementById('edmOnb'); return !!(o && o.classList.contains('on')); })));
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'first-run-saved-1280.png'), fullPage: false });

      /* 4 progress */
      await page.click('#edFirstRun [data-fr="step"][data-k="game"]');
      const ticked = await eventually(() => page.evaluate(() => { const li = document.querySelector('#edFirstRun .edfr-steps li:nth-child(2)'); return !!(li && li.classList.contains('done')); }), 8000);
      chk('opening a game ticks "Open a game"', ticked, db.events.map((e) => e.event));
      await eventually(() => db.events.some((e) => e.event === 'game_opened'), 5000);
      chk('…and records game_opened for that game', db.events.some((e) => e.event === 'game_opened' && e.props && /9102|9101/.test(e.props.entity || '')), db.events.filter((e) => e.event === 'game_opened'));

      /* 5 hide */
      await page.evaluate(() => { if (typeof window.researchGo === 'function') window.researchGo('football'); });
      await page.evaluate(() => { const b = document.querySelector('#edFirstRun [data-fr="hide"]'); if (b) b.click(); });
      await eventually(() => !!(db.T.user_preferences[0] && db.T.user_preferences[0].first_run_done_at), 5000);
      chk('Hide removes the panel and is remembered on the account', await page.evaluate(() => { const h = document.getElementById('edFirstRun'); return !h || h.hidden || !h.textContent.trim(); }) && !!db.T.user_preferences[0].first_run_done_at);
    } else {
      await page.click('#edFirstRun [data-fr="skip"]');
      await eventually(() => db.events.some((e) => e.event === 'onboarding_skipped'), 5000);
      chk('390: Skip is one tap, recorded, and stored', db.events.some((e) => e.event === 'onboarding_skipped') && (db.T.user_preferences[0] || {}).onboarding_status === 'skipped', db.T.user_preferences[0]);
      await page.waitForTimeout(3500);
      chk('390: after Skip the onboarding modal does not open either', !(await page.evaluate(() => { const o = document.getElementById('edmOnb'); return !!(o && o.classList.contains('on')); })));
    }
    chk(w + ': no script errors', S.errors.length === 0, S.errors);
    await S.ctx.close();
  }

  /* 6 an older account */
  {
    const S = await open({ width: 1280, height: 900 }, 30);
    await eventually(() => S.db.events.some((e) => e.event === 'terminal_opened'), 20000);
    await S.page.waitForTimeout(1500);
    const has = await S.page.evaluate(() => { const h = document.getElementById('edFirstRun'); return !!(h && h.textContent.trim()); });
    chk('an account older than two weeks goes straight to the terminal', !has && S.db.events.some((e) => e.event === 'terminal_opened') && !S.db.events.some((e) => e.event === 'first_run_viewed'));
    chk('older account: no script errors', S.errors.length === 0, S.errors);
    await S.ctx.close();
  }

  /* 8 a slate where no prop qualifies: the panel says so, and invents none */
  {
    const S = await open({ width: 390, height: 844 }, 1, shiftedStat(nothingQualifies(BOARD)));
    const shown = await eventually(() => S.page.evaluate(() => { const h = document.getElementById('edFirstRun'); return !!(h && h.querySelector('.edfr-grid')); }), 30000);
    const r = shown ? await S.page.evaluate(() => {
      const c = [...document.querySelectorAll('#edFirstRun .edfr-card')].find((x) => x.querySelector('h4').textContent.indexOf('Research-grade player') === 0);
      return c ? { head: c.querySelector('h4').textContent, items: c.querySelectorAll('.edfr-item').length, empty: (c.querySelector('.edfr-empty') || {}).textContent || '' } : null;
    }) : null;
    chk('nothing qualifies: the panel still opens on the games', shown, S.errors);
    chk('nothing qualifies: the prop card lists no prop and says none clears the threshold', r && r.items === 0 && /No player prop clears the research threshold right now\./.test(r.empty), r);
    chk('nothing qualifies: and claims no count', r && r.head === 'Research-grade player props', r);
    chk('nothing qualifies: no script errors', S.errors.length === 0, S.errors);
    await S.ctx.close();
  }

  await browser.close(); site.srv.close();
  console.log((fail ? 'FAILED' : 'ALL GREEN') + ' terminal first run (browser) — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL | ' + (e && e.stack || e)); process.exit(1); });
