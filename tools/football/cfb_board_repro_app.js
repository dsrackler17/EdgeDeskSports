#!/usr/bin/env node
/* ============================================================================
   REPRODUCE THE FBS BOARD'S MARKET BUGS WITH THE BOARD'S OWN CODE — READ-ONLY.

   The live board computes its "Market" column, its price line ("Best price")
   and the staleness text in the browser, from public.signals rows. Rather than
   describe what that code would do, this lifts the functions out of app.html
   VERBATIM (brace-matched by name, never re-typed), runs them in a sandbox
   with lib/edgedesk_canon.js and lib/edgedesk_quote_ev.js, and feeds them the
   rows each reported failure needs. Nothing is written anywhere.

     node tools/football/cfb_board_repro_app.js [--json]

   Scenarios (rows shaped exactly like fbSignals returns them):
     pitt_vt       yesterday's modal rows still refreshed by one book, the
                   market at -3.5 on seven books           -> bug 2
     miami_clemson a month-old opener row that never went away -> bug 3
     unt_tulsa     an alternate ladder stored under 'spreads'  -> bugs 2, 4, 6
   The freshness rule is stubbed with the page's `far` rung (180 min), which is
   what applies two days before kickoff; the cover model is a stand-in normal
   (sd 14) — only WHICH quote each rule picks is under test here.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');

function extract(name) {
  const i = APP.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('app.html has no function ' + name);
  let d = 0;
  for (let k = APP.indexOf('{', i); k < APP.length; k++) {
    const c = APP[k];
    if (c === '{') d++;
    else if (c === '}') { d--; if (d === 0) return APP.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

function sandbox() {
  const ctx = { console, Date, Math, JSON, isFinite, parseFloat, Object, Array, String, Number, window: {} };
  ctx.window.window = ctx.window;
  ctx.window.EDCanon = require(path.join(ROOT, 'lib', 'edgedesk_canon.js'));
  ctx.window.EDQuoteEV = require(path.join(ROOT, 'lib', 'edgedesk_quote_ev.js'));
  ctx.window.EDINTEL = { quoteState: (o) => { const a = (Date.now() - Date.parse(o.captured_at)) / 6e4; return { actionable: a < 180, status: a < 90 ? 'CURRENT' : (a < 180 ? 'AGING' : 'STALE') }; } };
  ctx.FBQEV = { alt: {} };
  vm.createContext(ctx);
  vm.runInContext(['fbNorm', 'fbNum', 'fbWMedian', 'fbBooksBehind', 'fbLatestCapture', 'fbMarketFromEvent', 'fbQevQuotes', 'fbQevAltState'].map(extract).join('\n')
    + '\nthis.fbMarketFromEvent = fbMarketFromEvent; this.fbQevQuotes = fbQevQuotes;', ctx);
  return ctx;
}

const Phi = (z) => { const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; };
function standIn(fairHomeMargin) {
  return { sport: 'CFB', available: true, model_version: 'stand-in', projection_timestamp: new Date().toISOString(), fair_home_margin: fairHomeMargin,
    home_cover: (t) => { const l = Phi((t - fairHomeMargin) / 14); return { win: 1 - l, push: 0, lose: l }; } };
}

function scenarios(now) {
  const T = (m) => new Date(now - m * 60000).toISOString();
  const K = (h) => new Date(now + h * 3600e3).toISOString();
  const mk = (home, away, kick) => (sel, pt, o) => Object.assign({ event_id: 'e', market: 'spreads', selection: sel, point: pt, best_dec: 1.91,
    first_best_dec: 1.91, best_book: 'draftkings', n_books: 1, home_team: home, away_team: away, commence_time: kick,
    first_seen_at: T(3000), last_seen_at: T(5), point_is_modal: false }, o || {});
  const pv = mk('Virginia Tech Hokies', 'Pittsburgh Panthers', K(51));
  const mc = mk('Clemson Tigers', 'Miami Hurricanes', K(52));
  const nt = mk('Tulsa Golden Hurricane', 'North Texas Mean Green', K(29));
  return [
    { key: 'pitt_vt', game: 'Pittsburgh @ Virginia Tech', home: 'Virginia Tech', away: 'Pittsburgh', fair: 0.79, kick: K(51),
      ev: { home: 'Virginia Tech Hokies', away: 'Pittsburgh Panthers', t: K(51), rows: [
        pv('Pittsburgh Panthers', 3, { n_books: 2, best_dec: 1.95, best_book: 'fanduel' }),
        pv('Pittsburgh Panthers', 3.5, { n_books: 7 }),
        pv('Pittsburgh Panthers', 6.5, { point_is_modal: true, last_seen_at: T(20) }),
        pv('Virginia Tech Hokies', -6.5, { point_is_modal: true, last_seen_at: T(20) }),
        pv('Virginia Tech Hokies', -3.5, { n_books: 7 })] } },
    { key: 'miami_clemson', game: 'Miami @ Clemson', home: 'Clemson', away: 'Miami', fair: -11.9, kick: K(52),
      ev: { home: 'Clemson Tigers', away: 'Miami Hurricanes', t: K(52), rows: [
        mc('Clemson Tigers', 7, { first_seen_at: T(37184), last_seen_at: T(37184) }),
        mc('Clemson Tigers', 16.5, { n_books: 6, point_is_modal: true, last_seen_at: T(3) }),
        mc('Miami Hurricanes', -16.5, { n_books: 6, point_is_modal: true, last_seen_at: T(3) }),
        mc('Miami Hurricanes', -7, { first_seen_at: T(37184), last_seen_at: T(37184) })] } },
    { key: 'unt_tulsa', game: 'North Texas @ Tulsa', home: 'Tulsa', away: 'North Texas', fair: 0.4, kick: K(29),
      ev: { home: 'Tulsa Golden Hurricane', away: 'North Texas Mean Green', t: K(29), rows: [
        nt('North Texas Mean Green', -3.5, { best_dec: 2.6 }), nt('North Texas Mean Green', 1.5, { n_books: 5, point_is_modal: true }),
        nt('North Texas Mean Green', 7.5, { best_dec: 1.35 }), nt('North Texas Mean Green', 25.5, { best_dec: 1.02 }),
        nt('Tulsa Golden Hurricane', -25.5, { best_dec: 10.6 }), nt('Tulsa Golden Hurricane', -7.5, { best_dec: 3.1 }),
        nt('Tulsa Golden Hurricane', -1.5, { n_books: 5, point_is_modal: true }), nt('Tulsa Golden Hurricane', 3.5, { best_dec: 1.5 })] } }
  ];
}

function sideText(home, away, marginLine) {       /* the board's margin convention: + = home favoured */
  if (marginLine == null) return '—';
  return marginLine > 0 ? home + ' -' + marginLine : (marginLine < 0 ? away + ' -' + (-marginLine) : 'PK');
}

function run() {
  const ctx = sandbox(), Q = ctx.window.EDQuoteEV, now = Date.now();
  return scenarios(now).map((s) => {
    const m = ctx.fbMarketFromEvent(s.ev, s.ev.home);
    const qs = ctx.fbQevQuotes(s.ev, s.key, Date.parse(s.kick), 'cfb');
    const G = Q.evaluateGame(standIn(s.fair), qs, { game: { game_id: s.key, home: s.home, away: s.away, kickoff: s.kick }, now: now });
    const be = G.best_ev_quote;
    const stale = ['home', 'away'].map((x) => (G.sides[x] ? G.sides[x].quotes : [])).reduce((a, b) => a.concat(b), [])
      .filter((q) => q.ev_unavailable_reason && /captured \d+ min ago/.test(q.ev_unavailable_reason || q.reason || ''));
    const staleText = stale.length ? stale[0].team + ' ' + (stale[0].line > 0 ? '+' : '') + stale[0].line + ' — ' + stale[0].ev_unavailable_reason : null;
    const n = { home: s.ev.rows.filter((r) => r.selection === s.ev.home).length, away: s.ev.rows.filter((r) => r.selection === s.ev.away).length };
    return { scenario: s.key, game: s.game,
      market_column: sideText(s.home, s.away, m.spread_line), market_stale: m.stale,
      price_line_main: { home: G.main_line.home, away: G.main_line.away },
      best_price_shown: be ? be.team + ' ' + (be.line > 0 ? '+' : '') + be.line + ' ' + (be.american_odds > 0 ? '+' : '') + be.american_odds + ' (' + be.sportsbook + ')' : null,
      best_price_is_main_market_number: be ? Math.abs(be.line - G.main_line[be.side]) < 1e-9 : null,
      stale_reason_shown: staleText, rows_per_side: n };
  });
}

if (require.main === module) {
  const out = run();
  if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 1));
  else out.forEach((o) => {
    console.log('== ' + o.game + ' (' + o.scenario + ')');
    console.log('   Market column      : ' + o.market_column + (o.market_stale ? ' (stale)' : ''));
    console.log('   price-line main    : home ' + o.price_line_main.home + ' / away ' + o.price_line_main.away);
    console.log('   "Best price" shown : ' + o.best_price_shown + (o.best_price_is_main_market_number === false ? '   <- not the main market number' : ''));
    if (o.stale_reason_shown) console.log('   stale text         : ' + o.stale_reason_shown);
  });
}
module.exports = { run, extract };
