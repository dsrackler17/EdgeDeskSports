#!/usr/bin/env node
/* ===========================================================================
   THE BETTOR DECISION LAYER, IN A REAL BROWSER (desktop and a 390 px phone).

   app.html in Chromium, its own loaders, the REAL captured CFB quotes from
   football/cfb_terminal/games.json replayed as the Supabase signals rows the
   page reads (the harness of tools/football/quote_ev_ui.e2e.js), and the
   committed football/cfb_terminal/decisions.json. It proves:

     - every FBS board row carries the one decision chip beside its EV line
     - a game card opens with EDGEDESK ACTION above the research, and the
       summary's Decision cell says the same thing as the card
     - the EdgeDesk Card page: counts, filters, sort, onboarding once, bankroll
       → dollars, beginner mode, BET PLACED against the frozen recommendation
     - a BET (built in the page by the real engine on a synthetic model — the
       live slate has none) renders side, line, price, units, dollars and the
       playable boundary, and the NFL card says NO DECISION with its reason
     - a phone never scrolls sideways and the decision comes first

   Needs Playwright with Chromium; prints SKIPPED and exits 0 without one.
   Run:  node tools/bettor/decision_ui.e2e.js [--shots <dir>]
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
function finish() {
  console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' | bettor decision layer (browser) | ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

const FIXTURE = path.join(ROOT, 'tools', 'football', 'fixtures', 'fbs_schedule_sample.csv');
const GAMES = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'cfb_terminal', 'games.json'), 'utf8'));
const NFL = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'nfl', 'slate.json'), 'utf8'));
const NOW = Date.now();
function signalsFor() {
  const rows = [];
  Object.keys(GAMES.games).forEach((gid) => {
    const g = GAMES.games[gid], mk = g.market || {}, quotes = (mk.quotes || []).filter((q) => q.home_line != null && q.price_home != null && q.price_away != null);
    if (!quotes.length) return;
    const ev = 'e2e_' + gid, at = new Date(NOW - 6 * 60000).toISOString(), t = g.kickoff, seen = {};
    const dec = (a) => (a > 0 ? 1 + a / 100 : 1 + 100 / -a);
    quotes.forEach((q) => {
      [['home', q.home_line, q.price_home], ['away', -q.home_line, q.price_away]].forEach(([s, pt, pr]) => {
        const sel = s === 'home' ? g.game.home : g.game.away, k = sel + '|' + pt;
        if (seen[k] && seen[k].best_dec >= dec(pr)) return;
        seen[k] = { event_id: ev, market: 'spreads', selection: sel, point: pt, best_dec: +dec(pr).toFixed(4), first_best_dec: +dec(pr).toFixed(4), first_seen_at: at,
          best_book: String(q.book || 'draftkings').replace(/^./, (c) => c.toUpperCase()), n_books: 1, home_team: g.game.home, away_team: g.game.away, commence_time: t, last_seen_at: at };
      });
    });
    Object.keys(seen).forEach((k) => rows.push(seen[k]));
  });
  return rows;
}
function nflGamesCsv() {
  const cols = ['game_id', 'season', 'game_type', 'week', 'gameday', 'gametime', 'away_team', 'away_score', 'home_team', 'home_score', 'away_rest', 'home_rest',
    'away_moneyline', 'home_moneyline', 'spread_line', 'total_line', 'div_game', 'roof', 'surface', 'temp', 'wind', 'away_qb_id', 'home_qb_id', 'away_qb_name', 'home_qb_name'];
  const rows = NFL.games.map((g) => { const r = g.reference_market || {};
    return [g.game_id, g.season, g.game_type || 'REG', g.week, g.gameday, g.gametime_et, g.away_code, 'NA', g.home_code, 'NA', g.away_rest, g.home_rest,
      r.away_ml == null ? 'NA' : r.away_ml, r.home_ml == null ? 'NA' : r.home_ml, r.home_margin == null ? 'NA' : r.home_margin, r.total == null ? 'NA' : r.total,
      g.div_game ? 1 : 0, g.roof || 'NA', g.surface || 'NA', 'NA', 'NA',
      (g.away_starter && g.away_starter.player_id) || 'NA', (g.home_starter && g.home_starter.player_id) || 'NA',
      (g.away_starter && g.away_starter.player_name) || 'NA', (g.home_starter && g.home_starter.player_name) || 'NA'].join(','); });
  return cols.join(',') + '\n' + rows.join('\n') + '\n';
}
function nflSignals() {
  const at = new Date(NOW - 4 * 60000).toISOString(), dec = (a) => +(a > 0 ? 1 + a / 100 : 1 + 100 / -a).toFixed(4), out = [];
  NFL.games.forEach((g) => { const r = g.reference_market || {}; if (r.home_line == null || Date.parse(g.kickoff) < NOW) return;
    const ev = 'e2e_nfl_' + g.game_id;
    [[g.home_team, r.home_line, -110], [g.away_team, -r.home_line, -110]].forEach(([sel, pt, pr]) => {
      out.push({ event_id: ev, market: 'spreads', selection: sel, point: pt, best_dec: dec(pr), first_best_dec: dec(pr), first_seen_at: at, best_book: 'FixtureBookA', n_books: 3,
        home_team: g.home_team, away_team: g.away_team, commence_time: g.kickoff, last_seen_at: at }); }); });
  return out;
}
const SIGNALS = signalsFor(), NFL_SIGNALS = nflSignals();
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.csv': 'text/csv; charset=utf-8' };
function siteHandler(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/app.html';
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(fs.readFileSync(file));
}

/* the synthetic BET, built in the page by the REAL engine and the REAL quote-EV
   arithmetic on a normal margin model (raw fair Wake Forest −4, calibrated
   Wake Forest −4.4, against NC State +6.5): no number is typed in */
const BET_BUILDER = () => {
  const Q = window.EDQuoteEV, D = window.EDDecision;
  function Phi(z) { const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; }
  function cover(mu, sd) { const pmf = {}; let tot = 0; for (let k = -90; k <= 90; k++) { const p = Phi((k + 0.5 - mu) / sd) - Phi((k - 0.5 - mu) / sd); pmf[k] = p; tot += p; }
    Object.keys(pmf).forEach((k) => { pmf[k] /= tot; });
    return (t) => { let win = 0, push = 0; for (let k = -90; k <= 90; k++) { if (Math.abs(k - t) < 1e-9) push += pmf[k]; else if (k > t) win += pmf[k]; } return { win, push, lose: 1 - win - push }; }; }
  const now = Date.now(), at = new Date(now - 8 * 60000).toISOString(), kick = new Date(now + 2 * 864e5).toISOString();
  const cc = cover(4.4, 14);
  const model = { sport: 'CFB', available: true, model_version: 'synthetic_e2e', fair_home_margin: 4, home_cover: cover(4, 14), tail: { validated_within_pts: 3 },
    adjusted: { available: true, label: 'CALIBRATED', version: 'synthetic_cal', maturity: 'SHADOW', side_prob: (s, l) => Q.sideProb(cc, s, l) } };
  const q = (side, line, am, book) => ({ game_id: 'e2e-bet', side, line, american: am, book: book || 'FanDuel', captured_at: at, fresh: true, n_books: 1 });
  return D.decide({ now, sport: 'CFB', market_type: 'spread',
    game: { game_id: 'e2e-bet', home: 'Wake Forest', away: 'NC State', kickoff: kick, mapping_ok: true, orientation_ok: true },
    model, quotes: [q('away', 6.5, -102), q('home', -6.5, -118), q('away', 6, -110, 'DraftKings'), q('home', -6, -110, 'DraftKings')],
    research: { status: 'WORTH_RESEARCHING', gap_pts: 5.5, gap_toward_side: 'away', verification: 'NOT_REQUIRED' },
    integrity: { gates: [{ id: 'a', status: 'PASS' }] }, market: { consensus_home_line: -6.5, n_books_fresh: 2, dispersion: 0.5 },
    reliability: { score: 79, grade: 'STRONG' }, confidence: { score: 70 }, projection: { stability: 'STABLE', uncertainty_score: 20 },
    qb: { known: true }, availability: { known: true }, support: { by_side: { away: 2, home: 0 } }, anomaly: {}, governance: { policy_status: 'SHADOW' } });
};

(async function main() {
  let pw = null;
  try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }
  if (!fs.existsSync(FIXTURE)) { console.log('SKIPPED: no schedule fixture'); process.exit(0); }
  if (!fs.existsSync(path.join(ROOT, 'football', 'cfb_terminal', 'decisions.json'))) { console.log('SKIPPED: football/cfb_terminal/decisions.json not built'); process.exit(0); }
  const srv = await new Promise((resolve) => { const s = http.createServer(siteHandler); s.listen(0, '127.0.0.1', () => resolve(s)); });
  const port = srv.address().port;
  let browser;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) {
    const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (fs.existsSync(exe)) browser = await pw.chromium.launch({ headless: true, executablePath: exe });
    else { console.log('SKIPPED: no Chromium'); srv.close(); process.exit(0); }
  }
  async function open(viewport, opts) {
    opts = opts || {};
    const ctx = await browser.newContext({ viewport });
    await ctx.addInitScript((o) => {
      try {
        localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
        localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'e2e', refresh_token: 'e2e', expires_at: Math.floor(Date.now() / 1000) + 86400, user: { id: 'e2e-reader', email: 'e2e@edgedesk.test' } }));
        if (o.onboarded) localStorage.setItem('edgedesk_decision_onboarded_v1', JSON.stringify('2026-01-01T00:00:00Z'));
      } catch (e) {}
    }, opts);
    const sched = fs.readFileSync(FIXTURE);
    await ctx.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.indexOf('127.0.0.1') >= 0) return route.continue();
      if (/cfb_schedules_\d{4}\.csv/.test(url)) return route.fulfill({ status: 200, contentType: 'text/csv', body: sched });
      if (/nfldata\/master\/data\/games\.csv/.test(url)) return route.fulfill({ status: 200, contentType: 'text/csv', body: nflGamesCsv() });
      if (/stats_team_week_(\d{4})\.csv/.test(url)) return route.fulfill({ status: 200, contentType: 'text/csv', body: fs.readFileSync(path.join(ROOT, 'football', 'nfl', 'stats_team_week_2026.csv')) });
      if (/cfb_rosters_\d{4}\.csv/.test(url)) return route.fulfill({ status: 404, body: 'not published' });
      if (/open-meteo/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      if (/supabase\.co/.test(url)) {
        if (/\/subscriptions/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify([{ status: 'active', price_id: 'price_e2e', current_period_end: new Date(Date.now() + 30 * 864e5).toISOString(), cancel_at_period_end: false, stripe_customer_id: 'cus_e2e' }]) });
        if (/\/signals\?/.test(url) && /americanfootball_ncaaf/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SIGNALS) });
        if (/\/signals\?/.test(url) && /americanfootball_nfl/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(NFL_SIGNALS) });
        return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message).slice(0, 300)));
    await page.goto(`http://127.0.0.1:${port}/app.html#research/football`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.fbSetSport === 'function' && !!window.EDDecisionUI, null, { timeout: 30000 });
    await page.evaluate(() => { try { window.researchGo('football'); } catch (e) {} });
    await page.evaluate(() => window.fbSetSport('p4'));
    await page.waitForFunction(() => { const b = document.getElementById('fbBody'); return b && /FBS FOOTBALL OPERATIONS/.test(b.innerHTML); }, null, { timeout: 60000 });
    await page.waitForFunction(() => !!(window.EDQuoteEV && window.EDEV), null, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await page.click('text=Skip for now', { timeout: 2000 }).catch(() => {});
    return { ctx, page, errors };
  }

  console.log('\n== desktop 1280 ==');
  const A = await open({ width: 1280, height: 2000 });
  const page = A.page;
  if (args.indexOf('--dbg') >= 0) { await page.waitForTimeout(500); console.log(JSON.stringify(await page.evaluate(() => { window.fbDecisionsLive(); const L = window.EDDecisionUI.mergedDecisions(); const c = {}; L.forEach((d) => { const k = d.decision + ':' + d.action_reason_code; c[k] = (c[k] || 0) + 1; }); return { c, waits: L.filter((d) => d.decision === 'WAIT').map((d) => [d.away + ' @ ' + d.home, d.sport, d.action_reason_code, (d.waiting_on || []).map((w) => w.text).join(';')]) }; }), null, 1)); process.exit(0); }
  const board = await page.evaluate(() => {
    const subs = Array.from(document.querySelectorAll('.qev-sub'));
    const chips = subs.map((x) => x.querySelector('.edd-chip')).filter(Boolean);
    return { subs: subs.length, chips: chips.length, labels: chips.map((c) => c.querySelector('b').textContent),
      bets: chips.filter((c) => /^BET/.test(c.querySelector('b').textContent)).length };
  });
  chk('every priced FBS row carries the decision chip beside its EV line', board.subs > 0 && board.chips === board.subs, board);
  chk('chips speak only the five decision words', board.labels.every((l) => /^(BET · \d|LEAN|WATCH|PASS|NO DECISION)/.test(l)), board.labels.slice(0, 10));
  chk('no BET on the live slate while every calibrated EV is negative', board.bets === 0, board);

  /* a priced game: the action card above the research, and one decision on the page */
  const gid = await page.evaluate(() => { const el = Array.from(document.querySelectorAll('.qev-sub')).find((x) => /Best price/.test(x.textContent)); const m = el ? (el.getAttribute('onclick') || '').match(/fbP4Gate\('([^']+)'\)/) : null; return m ? m[1] : null; });
  await page.evaluate((g) => window.fbP4Gate(g), gid);
  await page.waitForTimeout(700);
  const card = await page.evaluate((g) => {
    const host = document.getElementById('p4gate-' + g); if (!host) return null;
    const act = host.querySelector('.edd-act'), res = host.querySelector('[data-edd-research]');
    const cells = Array.from(host.querySelectorAll('.gx-c')).find((c) => /^Decision/.test((c.querySelector('.l') || {}).textContent || ''));
    return { hasAct: !!act, before: !!(act && res && (act.compareDocumentPosition(res) & 4)), actText: act ? act.textContent.replace(/\s+/g, ' ') : '',
      badge: act ? act.querySelector('.edd-badge').textContent : null, cell: cells ? cells.textContent.replace(/\s+/g, ' ') : null };
  }, gid);
  chk('the game card opens with EDGEDESK ACTION', card && card.hasAct, card);
  chk('the action card sits above the full research', card && card.before);
  chk('the summary’s Decision cell says what the action card says', card && card.cell && card.cell.indexOf(card.badge) >= 0, { badge: card && card.badge, cell: card && card.cell });
  chk('a PASS names the price, the calibrated and raw EV, why, and the bet trigger', card && (card.badge !== 'PASS' || (/Current price does not justify a wager/.test(card.actText) && /CALIBRATED EV/.test(card.actText) && /RAW EV/.test(card.actText) && /WHY PASS/.test(card.actText))), card && card.actText.slice(0, 500));
  chk('the card says when it was last evaluated', card && /Last evaluated \d/.test(card.actText));
  chk('no tout language on the card', card && !/\b(lock|guarantee|free money|can.?t miss|safe bet|best bet)\b/i.test(card.actText));
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); const el = await page.$('#p4gate-' + gid + ' .edd-act'); if (el) await el.screenshot({ path: path.join(SHOTS, 'action_card_pass_desktop.png') }); }

  /* the EdgeDesk Card page: onboarding once, counts, filters */
  await page.evaluate(() => window.show('card'));
  await page.waitForTimeout(600);
  const onb = await page.evaluate(() => { const m = document.getElementById('eddModal'); return m && m.classList.contains('on') ? m.textContent.replace(/\s+/g, ' ') : null; });
  chk('the first visit shows the onboarding, page 1', onb && /WELCOME TO EDGEDESK/.test(onb) && /separates research from betting decisions/i.test(onb), onb);
  await page.click('[data-edd-act="onb-next"]');
  const onb2 = await page.evaluate(() => document.getElementById('eddModal').textContent.replace(/\s+/g, ' '));
  chk('page 2 sets the unit (1 unit = 1% of bankroll)', /SET YOUR UNIT/.test(onb2) && /1 unit = 1% of bankroll/.test(onb2), onb2.slice(0, 200));
  await page.fill('#eddModal [data-edd-in="bankroll_amount"]', '2500');
  const unitNow = await page.evaluate(() => document.querySelector('#eddModal [data-edd-out="unit"]').textContent);
  chk('a $2,500 bankroll shows a $25 unit as it is typed', unitNow === '$25.00', unitNow);
  await page.click('[data-edd-act="onb-next"]');
  const onb3 = await page.evaluate(() => document.getElementById('eddModal').textContent.replace(/\s+/g, ' '));
  chk('page 3 reads the five actions', ['BET', 'LEAN', 'WATCH', 'PASS', 'NO DECISION'].every((w) => onb3.indexOf(w) >= 0) && /Do not bet yet/i.test(onb3));
  await page.click('[data-edd-act="onb-next"]');
  const onb4 = await page.evaluate(() => document.getElementById('eddModal').textContent.replace(/\s+/g, ' '));
  chk('page 4: price matters', /PRICE MATTERS/.test(onb4) && /\+4\.5/.test(onb4) && /do not use the earlier recommendation/.test(onb4));
  await page.click('[data-edd-act="onb-done"]');
  const after = await page.evaluate(() => ({ modal: document.getElementById('eddModal').classList.contains('on'), flag: localStorage.getItem('edgedesk_decision_onboarded_v1'), s: JSON.parse(localStorage.getItem('edgedesk_bankroll_v1') || '{}') }));
  chk('onboarding closes, is remembered, and saved the bankroll', !after.modal && !!after.flag && after.s.bankroll_amount === 2500, after);
  await page.waitForFunction(() => { const h = document.getElementById('eddCardHost'); return h && /EDGEDESK CARD/.test(h.textContent) && !/Loading the latest decisions/.test(h.textContent); }, null, { timeout: 15000 }).catch(() => {});
  const cp = await page.evaluate(() => {
    const h = document.getElementById('eddCardHost'), t = h.textContent.replace(/\s+/g, ' ');
    const k = Array.from(h.querySelectorAll('.edd-kpi b')).map((b) => b.textContent);
    return { t: t.slice(0, 400), kpis: k, rows: h.querySelectorAll('.edd-row').length, n: window.EDDecisionUI.mergedDecisions().length };
  });
  chk('the card page renders the header counts', /EDGEDESK CARD/.test(cp.t) && cp.kpis.length === 6, cp);
  chk('every decided game appears exactly once under BET / LEAN / WATCHING / PASS / NO DECISION', cp.rows === cp.n && cp.n > 0, cp);
  chk('an empty BET section says so plainly', /No current price clears EdgeDesk’s betting thresholds/.test(await page.evaluate(() => document.getElementById('eddCardHost').textContent)));

  /* a BET, from the engine, on the card and as an action card */
  const bet = await page.evaluate((src) => { const f = eval('(' + src + ')'); const d = f(); window.EDDecisionUI.observe(d); return d; }, BET_BUILDER.toString());
  chk('the engine produces the synthetic BET in the page', bet && bet.decision === 'BET' && bet.recommended_units > 0, bet && { d: bet.decision, code: bet.action_reason_code, u: bet.recommended_units });
  await page.evaluate(() => window.show('card'));
  await page.waitForTimeout(300);
  const cb = await page.evaluate(() => { const h = document.getElementById('eddCardHost'); const r = h.querySelector('.edd-r-bet'); return { row: r ? r.textContent.replace(/\s+/g, ' ') : null, kpi: h.querySelector('.edd-kpi-bet b').textContent, exp: h.querySelector('.edd-kpis').textContent.replace(/\s+/g, ' ') }; });
  chk('the BET row shows units, side, line, price, book, dollars and playable-to', cb.row && /0\.50U NC State \+6\.5 \(-102\) FanDuel \$12\.50/.test(cb.row) && /Playable to: [+−-]?\d/.test(cb.row), cb);
  chk('the header counts the bet and its exposure in units and dollars', cb.kpi === '1' && /0\.50U/.test(cb.exp) && /\$12\.50/.test(cb.exp), cb);
  await page.click('[data-edd-act="filter"][data-edd-v="watching"]');
  const onlyWait = await page.evaluate(() => Array.from(document.querySelectorAll('#eddCardHost .edd-row')).every((r) => r.classList.contains('edd-r-watch')));
  chk('the Watching filter shows only WATCH rows', onlyWait);
  await page.click('[data-edd-act="filter"][data-edd-v="bets"]');
  const onlyBet = await page.evaluate(() => { const rs = Array.from(document.querySelectorAll('#eddCardHost .edd-row')); return rs.length === 1 && rs[0].classList.contains('edd-r-bet'); });
  chk('the Bets filter shows only BET rows', onlyBet);
  await page.click('[data-edd-act="filter"][data-edd-v="all"]');
  /* the BET as an action card, then BET PLACED at a worse number */
  await page.evaluate(() => { const d = window.EDDecisionUI._state.registry['e2e-bet']; const host = document.createElement('div'); host.id = 'eddTestHost'; document.getElementById('v-card').appendChild(host); host.innerHTML = window.EDDecisionUI.actionCardHTML(d); });
  const ac = await page.evaluate(() => document.getElementById('eddTestHost').textContent.replace(/\s+/g, ' '));
  chk('BET · 0.5U, the selection in capitals, price and book', /BET · 0\.5U/.test(ac) && /NC STATE \+6\.5/.test(ac) && /-102 · FanDuel/.test(ac), ac.slice(0, 300));
  chk('the dollars, based on the reader’s unit', /\$12\.50 based on your \$25\.00 unit/.test(ac), ac.match(/\$[\d.]+ based on your[^.]*/));
  chk('PLAYABLE TO names the worst line and price', /PLAYABLE TO\?? [+−-]?\d+(\.5)? · max [+−-]\d+/.test(ac), ac.match(/PLAYABLE TO.{0,60}/));
  chk('stake tier, decision confidence, probability source, model fair, calibrated EV, reliability, market and projection', ['STAKE TIER', 'DECISION CONFIDENCE', 'PROBABILITY', 'MODEL FAIR', 'CALIBRATED EV', 'RELIABILITY', 'MARKET', 'PROJECTION'].every((w) => ac.indexOf(w) >= 0));
  chk('why it qualifies and what cancels it', /WHY IT QUALIFIES/.test(ac) && /WHAT CANCELS IT/.test(ac) && /material QB change/.test(ac));
  chk('every price type is named apart', ['BEST AVAILABLE', 'CONSENSUS', 'EDGEDESK BET PRICE', 'PLAYABLE TO', 'MODEL FAIR'].every((w) => ac.indexOf(w) >= 0));
  await page.click('#eddTestHost [data-edd-act="placed"]');
  await page.fill('#eddTestHost [data-edd-in="line"]', '5');
  await page.fill('#eddTestHost [data-edd-in="odds"]', '-110');
  await page.click('#eddTestHost [data-edd-act="placed-save"]');
  await page.evaluate(() => { const d = window.EDDecisionUI._state.registry['e2e-bet']; document.getElementById('eddTestHost').innerHTML = window.EDDecisionUI.actionCardHTML(d); });
  const pl = await page.evaluate(() => ({ t: document.getElementById('eddTestHost').textContent.replace(/\s+/g, ' '), n: JSON.parse(localStorage.getItem('edgedesk_bets_placed_v1') || '[]') }));
  chk('BET PLACED is stored apart, with the recommendation frozen beside it', pl.n.length === 1 && pl.n[0].line === 5 && pl.n[0].recommendation && pl.n[0].recommendation.selected_line === 6.5, pl.n[0]);
  chk('a worse entry reads OUTSIDE EdgeDesk range against the frozen recommendation', /YOUR PRICE/.test(pl.t) && /EDGEDESK PRICE/.test(pl.t) && /Outside EdgeDesk range/.test(pl.t), pl.t.match(/YOUR PRICE.{0,200}/));
  if (SHOTS) { const el = await page.$('#eddTestHost .edd-act'); if (el) await el.screenshot({ path: path.join(SHOTS, 'action_card_bet_desktop.png') }); await page.screenshot({ path: path.join(SHOTS, 'edgedesk_card_desktop.png'), fullPage: false }); }
  /* beginner mode: the decision first, the research on request */
  await page.check('#eddCardHost [data-edd-act="beginner"]');
  const bm = await page.evaluate(() => { const d = window.EDDecisionUI._state.registry['e2e-bet']; const h = document.createElement('div'); h.innerHTML = window.EDDecisionUI.actionCardHTML(d); const s = h.querySelector('.edd-act'); return { begin: s.classList.contains('edd-begin'), open: s.querySelector('.edd-reason').open, why: /WHY Current price clears/.test(s.textContent) }; });
  chk('beginner mode: one sentence, the reasoning behind a toggle', bm.begin && !bm.open && bm.why, bm);
  await page.uncheck('#eddCardHost [data-edd-act="beginner"]');
  chk('no page errors on desktop', A.errors.length === 0, A.errors);

  /* the NFL: decided by the same engine — never NO DECISION for want of calibration */
  await page.evaluate(() => { window.researchGo('football'); window.fbSetSport('nfl'); });
  await page.waitForFunction(() => document.querySelectorAll('[id^="fbg-nfl-"]').length > 0, null, { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(800);
  const nfl = await page.evaluate(() => { const c = document.querySelector('[id^="fbg-nfl-"] .edd-act'); return c ? c.textContent.replace(/\s+/g, ' ') : null; });
  chk('an NFL card carries the action card', !!nfl, nfl);
  chk('the NFL action card decides (BET / LEAN / WATCH / PASS), or names an essential blocker', nfl && (/\b(BET|LEAN|WATCH|PASS)\b/.test(nfl.slice(0, 200)) || (/NO DECISION/.test(nfl) && /BLOCKER/.test(nfl))) && !/no NFL decision engine/.test(nfl), nfl && nfl.slice(0, 300));
  chk('the NFL card never says calibration is missing as a reason not to decide', nfl && !/No validated probability calibration/.test(nfl));
  await A.ctx.close();

  console.log('\n== phone 390 ==');
  const B = await open({ width: 390, height: 844 }, { onboarded: true });
  const p2 = B.page;
  await p2.evaluate((src) => { const f = eval('(' + src + ')'); window.EDDecisionUI.saveSettings({ bankroll_amount: 2500 }); window.EDDecisionUI.observe(f()); }, BET_BUILDER.toString());
  await p2.evaluate(() => window.show('card'));
  await p2.waitForTimeout(800);
  const m1 = await p2.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, first: (document.querySelector('#eddCardHost .edd-row') || {}).className }));
  chk('the card page never scrolls sideways on a phone', m1.sw <= m1.cw + 1, m1);
  chk('the first row on the phone is the BET', /edd-r-bet/.test(m1.first || ''), m1);
  await p2.evaluate(() => { const d = window.EDDecisionUI._state.registry['e2e-bet']; const host = document.createElement('div'); host.id = 'eddTestHost'; document.getElementById('v-card').appendChild(host); host.innerHTML = window.EDDecisionUI.actionCardHTML(d, { mobile: true }); });
  const m2 = await p2.evaluate(() => { const s = document.querySelector('#eddTestHost .edd-act'), r = s.getBoundingClientRect(); return { w: r.width, right: r.right, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, open: s.querySelector('.edd-reason').open,
    top: s.textContent.replace(/\s+/g, ' ').slice(0, 140) }; });
  chk('the phone action card fits the screen', m2.right <= m2.cw + 1 && m2.sw <= m2.cw + 1, m2);
  chk('the phone card leads with the decision, the price and the dollars; reasoning folds', /BET · 0\.5U/.test(m2.top) && /NC STATE \+6\.5/.test(m2.top) && /\$12\.50/.test(m2.top) && m2.open === false, m2);
  await p2.click('#eddTestHost .edd-reason > summary');
  const m3 = await p2.evaluate(() => ({ open: document.querySelector('#eddTestHost .edd-reason').open, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  chk('"View reasoning" expands in place, still without sideways scroll', m3.open && m3.sw <= m3.cw + 1, m3);
  if (SHOTS) { const el = await p2.$('#eddTestHost .edd-act'); if (el) await el.screenshot({ path: path.join(SHOTS, 'action_card_bet_phone.png') }); await p2.evaluate(() => { const h = document.getElementById('eddTestHost'); if (h) h.remove(); window.scrollTo(0, 0); }); await p2.screenshot({ path: path.join(SHOTS, 'edgedesk_card_phone.png') }); }
  chk('no page errors on the phone', B.errors.length === 0, B.errors);
  await B.ctx.close();
  await browser.close(); srv.close();
  finish();
})().catch((e) => { console.error(e); process.exit(1); });
