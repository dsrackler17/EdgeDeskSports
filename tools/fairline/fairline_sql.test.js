#!/usr/bin/env node
/* ===========================================================================
   supabase/fairline.sql, AGAINST A REAL POSTGRESQL, AS REAL READERS.

   Fairline measures prices (The Board) and the reader's own bets (The Leaks)
   against EdgeDesk's de-vigged fair and its captured close. This proves, by
   acting as reader A, reader B reaching for A's rows, anon and the service
   role:

     1 it installs over its dependencies (twice), names any that are missing,
       and its report says ok
     2 a reader's bets are their own: the view, the doors and the per-account
       functions; anon reads nothing
     3 the paid gate: a free account gets the slice name of its biggest leak
       and no number, three Board rows and no filters; Bet Checker (red) and
       the terminal (blue) get everything; a lapsed plan is free
     4 one view of both sources: a bet in Bet Checker AND the Portfolio is one
       row (linked, same market key, same game), a different bet is never
       merged, twins pair one to one, the book's money and Bet Checker's close
     5 the slices: every dimension and bucket, units and dollars, ROI, CLV and
       the beat-close rate; the four labels; the minimum sample; P/L-only when
       no close was captured; the three biggest real leaks, none listed twice
     6 the buckets' boundaries, from the one constant
     7 The Board: one row per market and side at its main line, fair as a
       probability and as odds, the best price (book_quotes before signals),
       edge vs fair, quote age, stale rows greyed and sorted last, Kalshi only
       when its card says OK, DK Predictions inactive, filters

   Run: node tools/fairline/fairline_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));

const T = PG.kit('fairline SQL');
const chk = T.chk;
const lit = PG.lit;
const ROOT = PG.ROOT;
const SUPA = (f) => path.join(ROOT, 'supabase', f);
const FILE = SUPA('fairline.sql');
const MIRROR = SUPA(path.join('migrations', '20261028180000_fairline.sql'));
const SQL = fs.readFileSync(FILE, 'utf8');
const NOCOMMENT = SQL.replace(/--.*$/gm, '');

/* ── STATIC: the folder's conventions ──────────────────────────────────── */
chk('no psql meta-commands (it is pasted into the SQL editor)', !/^\\/m.test(SQL));
chk('it ends in a report', /CHECK THIS/.test(SQL) && /order by 1;\s*$/.test(SQL));
chk('nothing is dropped', !/\bdrop\s+(table|column|view|function|index|policy|trigger)/i.test(NOCOMMENT));
chk('the migration mirror is byte-identical', fs.existsSync(MIRROR) && fs.readFileSync(MIRROR, 'utf8') === SQL);
chk('PostgREST is told to reload', /notify pgrst, 'reload schema'/.test(SQL));
chk('the minimum sample is written once, in fairline_rules()', (NOCOMMENT.match(/'min_sample_bets',\s*15/g) || []).length === 1 &&
  !/(>=|<|>)\s*15\b/.test(NOCOMMENT));
chk('signals RLS is not touched: no policy, no grant on signals', !/(policy|grant|revoke)[^;]*on\s+public\.signals/i.test(NOCOMMENT) &&
  !/alter table public\.signals/i.test(NOCOMMENT));
chk('the CLV is the house formula (close/index.ts decideClose: entryDec * closeFair - 1)',
  /round\(\(ppc\.dec \* ppc\.s_fair - 1\) \* 100, 2\)/.test(SQL) &&
  /return \{ clv: entryDec \* closeFair - 1, reason: null \};/.test(fs.readFileSync(SUPA(path.join('functions', 'close', 'index.ts')), 'utf8')));
/* the Board's freshness limit IS capture's FRESHNESS_POLICY, in minutes */
(() => {
  const cap = fs.readFileSync(SUPA(path.join('functions', 'capture', 'index.ts')), 'utf8');
  const pol = /export const FRESHNESS_POLICY[^=]*=\s*\{([\s\S]*?)\n\};/.exec(cap);
  const buckets = /export const FRESHNESS_BUCKETS[^=]*=\s*\[([\s\S]*?)\n\];/.exec(cap);
  const want = {};
  if (pol) for (const m of pol[1].matchAll(/"([a-z*]+)\|\*":\s*\{([^}]*)\}/g)) {
    want[m[1]] = {}; for (const kv of m[2].matchAll(/(\w+):\s*(\d+)/g)) want[m[1]][kv[1]] = Number(kv[2]) / 60;
  }
  const have = {};
  const fm = /'freshness_min', jsonb_build_object\(([\s\S]*?)\$\$;/.exec(SQL);
  if (fm) for (const m of fm[1].matchAll(/'([a-z*]+)',\s*jsonb_build_object\(([^)]*)\)/g)) {
    have[m[1]] = {}; for (const kv of m[2].matchAll(/'(\w+)',\s*(\d+)/g)) have[m[1]][kv[1]] = Number(kv[2]);
  }
  chk('the Board\'s freshness limits are capture\'s FRESHNESS_POLICY in minutes, by sport group', !!pol && Object.keys(want).length === 3 &&
    JSON.stringify(Object.keys(want).sort().map((k) => [k, want[k]])) === JSON.stringify(Object.keys(have).sort().map((k) => [k, Object.fromEntries(Object.keys(want[k]).map((b) => [b, have[k] && have[k][b]]))])),
    { want, have });
  const capB = buckets ? [...buckets[1].matchAll(/name: "(\w+)", maxHoursToStart: ([\d.]+|Infinity)/g)].map((m) => [m[1], m[2] === 'Infinity' ? null : Number(m[2])]) : [];
  const flB = [...SQL.matchAll(/jsonb_build_object\('name', '(\w+)',\s*'to_hours', ([\d.]+|null)\)/g)].map((m) => [m[1], m[2] === 'null' ? null : Number(m[2])]);
  chk('…over capture\'s FRESHNESS_BUCKETS, hour for hour', capB.length === 6 && JSON.stringify(capB) === JSON.stringify(flB), { capB, flB });
})();

const db = PG.start('fairline');
/* FAIRLINE_SQL_REQUIRED=1 (CI) makes a missing PostgreSQL a failure, never a pass */
if (db.skip) { if (process.env.FAIRLINE_SQL_REQUIRED === '1') chk('environment: ' + db.skip, false); console.log('SKIPPED | ' + db.skip + ' — the LIVE layer did not run (not verified)'); process.exit(T.done()); }

const J = (q) => JSON.parse(db.sql('select coalesce(json_agg(t), \'[]\'::json) from (' + q + ') t;') || '[]');
const V = (q) => db.sql(q);
const uid = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const A = uid(1), B = uid(2), P = uid(3), Q = uid(4), C = uid(5), D = uid(6), L = uid(7);
const H = 3600 * 1000, MIN = 60 * 1000;
const at = (ms) => "(now() + interval '" + Math.round(ms / 1000) + " seconds')";
const asJ = (u, q) => JSON.parse(db.as(u, q) || 'null');
const leaks = (u) => asJ(u, 'select public.fairline_leaks();');
const board = (u, s, m, b) => asJ(u, 'select public.fairline_board(' + [s, m, b].map((x) => (x == null ? 'null' : lit(x))).join(', ') + ');');
const myBets = (u) => JSON.parse(db.as(u, 'select coalesce(json_agg(b order by b.bet_ref), \'[]\') from public.fairline_bets b;') || '[]');
const slice = (lk, dim, val) => (lk.slices || []).find((s) => s.dim === dim && s.val === val);
const SIG_COLS = 'sig_key text primary key, event_id text, sport_key text, sport_title text, commence_time timestamptz, home_team text, away_team text, ' +
  'market text, selection text, point numeric, sharp_fair numeric, last_seen_at timestamptz, point_is_modal boolean, is_player_prop boolean not null default false, ' +
  'flagged_at timestamptz, closed_at timestamptz, closing_sharp_fair numeric, clv_excluded_reason text, closing_source text, result text, ' +
  'closing_dec numeric, closing_at_observed timestamptz, clv numeric, beat_close boolean, best_dec numeric, best_book text, best_quote_age_s integer, n_books integer';

/* the board, in the shape capture writes */
function sig(o) {
  const k = o.key || (o.ev + '|' + o.market + '|' + o.sel + '|' + (o.point == null ? '' : String(o.point)));
  V('insert into public.signals (sig_key, event_id, sport_key, sport_title, commence_time, home_team, away_team, market, selection, point, sharp_fair, last_seen_at, ' +
    'point_is_modal, best_dec, best_book, best_quote_age_s, closed_at, closing_sharp_fair, clv_excluded_reason, n_books) values (' +
    [lit(k), lit(o.ev), lit(o.sport || 'americanfootball_nfl'), lit(o.title || 'NFL'), at(o.startMs), lit(o.home || 'Kansas City Chiefs'), lit(o.away || 'Buffalo Bills'),
     lit(o.market), lit(o.sel), o.point == null ? 'null' : o.point, o.fair == null ? 'null' : o.fair, at(-(o.seenAgoMs == null ? 10 * MIN : o.seenAgoMs)),
     o.modal === false ? 'false' : 'true', o.best == null ? 'null' : o.best, lit(o.book || 'DraftKings'), o.ageS == null ? 60 : o.ageS,
     o.closedAgoMs != null ? at(-o.closedAgoMs) : 'null', o.closeFair == null ? 'null' : o.closeFair, lit(o.excl || null), 8].join(', ') + ');');
  return k;
}
/* a Bet Checker row, as the grader leaves it (written as the superuser, so the
   board-event checks that guard a reader's insert do not run) */
function ub(u, o) {
  const id = V("select gen_random_uuid();");
  V('set session_replication_role = replica; insert into public.user_bets (id, user_id, bet_key, source, sport, game_id, event_id, market_type, side, team, line, odds, book, units, ' +
    'placed_at, kickoff, home_team, away_team, result, units_won, close_status, clv_pct, status, stake_dollars, unit_value, created_at) values (' +
    [lit(id), lit(u), lit('bc:' + id), "'own'", lit(o.sport || 'NFL'), lit(o.ev || 'x'), lit(o.ev || 'x'), lit(o.market || 'spread'), lit(o.side || 'home'), lit(o.team || null),
     o.line == null ? 'null' : o.line, o.odds, lit(o.book || 'DraftKings'), o.units == null ? 1 : o.units,
     at(o.placedMs == null ? -50 * H : o.placedMs), at(o.kickMs == null ? -H : o.kickMs), lit(o.home || 'Kansas City Chiefs'), lit(o.away || 'Buffalo Bills'),
     lit(o.result || null), o.won == null ? 'null' : o.won, lit(o.close || 'pending'), o.clv == null ? 'null' : o.clv, lit(o.status || 'open'),
     o.stakeDollars == null ? 'null' : o.stakeDollars, o.unitValue == null ? 'null' : o.unitValue, 'now()'].join(', ') + '); set session_replication_role = default;');
  return id;
}
/* a Portfolio position, written by its owner (the Portfolio's own trigger derives the money) */
function pp(u, o) {
  const st = o.status || 'OPEN';
  return db.as(u, 'insert into public.portfolio_positions (platform, platform_label, platform_type, position_type, sport, league, event_name, event_start_at, market_name, ' +
    'selection, side, line, legs, odds_american, stake, status, settled_at, placed_at, source, market_sig_key, edge_source, edge_ref_type, edge_ref_id) values (' +
    [lit(o.platform || 'fanduel'), lit(o.label || 'FanDuel'), lit(o.ptype || 'SPORTSBOOK'), lit(o.type || 'MONEYLINE'), lit(o.sport || null), lit(o.league || null),
     lit(o.event || 'Buffalo Bills @ Kansas City Chiefs'), o.startMs == null ? 'null' : at(o.startMs), lit(o.marketName || 'Game line'), lit(o.sel || 'Kansas City Chiefs'),
     lit(o.side || null), o.line == null ? 'null' : o.line, o.legs ? lit(JSON.stringify(o.legs)) + '::jsonb' : 'null', o.odds, o.stake == null ? 50 : o.stake,
     lit(st), st === 'OPEN' ? 'null' : at(o.settledMs == null ? -MIN : o.settledMs), at(o.placedMs == null ? -50 * H : o.placedMs), "'MANUAL'",
     lit(o.sigKey || null), o.ref ? "'EDGEDESK'" : 'null', o.ref ? "'user_bet'" : 'null', lit(o.ref || null)].join(', ') + ') returning id;');
}
const subscribe = (u, price, status, days) => V('insert into public.subscriptions (user_id, status, price_id, current_period_end) values (' + lit(u) + ', ' + lit(status) +
  ', ' + lit(price) + ", now() + interval '" + days + " days') on conflict (user_id) do update set status = excluded.status, price_id = excluded.price_id, current_period_end = excluded.current_period_end;");
/* every number anywhere in a JSON value, by path */
function numbers(v, p, out) {
  out = out || []; p = p || '';
  if (typeof v === 'number') out.push(p);
  else if (Array.isArray(v)) v.forEach((x, i) => numbers(x, p + '[' + i + ']', out));
  else if (v && typeof v === 'object') Object.keys(v).forEach((k) => numbers(v[k], p + '.' + k, out));
  return out;
}

try {
  /* ===================================================================== */
  /* 1. IT INSTALLS, AND SAYS WHAT IT NEEDS                                */
  /* ===================================================================== */
  const noDep = db.mustFail(() => db.applyFileAtomic(FILE));
  chk('without user_bets it stops and names bettor_decisions.sql', /bettor_decisions\.sql/.test(noDep || ''), noDep && noDep.slice(0, 200));
  V('create table public.signals (' + SIG_COLS + ');');
  for (const f of ['bankroll_and_stakes.sql', 'bettor_decisions.sql', 'billing.sql', 'stripe_webhook.sql', 'billing_hardening.sql', 'bet_checker.sql']) db.applyFileAtomic(SUPA(f));
  const noPortfolio = db.mustFail(() => db.applyFileAtomic(FILE));
  chk('without the Portfolio it stops and names portfolio.sql', /portfolio\.sql/.test(noPortfolio || ''), noPortfolio && noPortfolio.slice(0, 200));
  db.applyFileAtomic(SUPA('portfolio.sql'));
  const noImport = db.mustFail(() => db.applyFileAtomic(FILE));
  chk('without the matched market it stops and names bet_import.sql', /bet_import\.sql/.test(noImport || ''), noImport && noImport.slice(0, 200));
  db.applyFileAtomic(SUPA('bet_import.sql'));
  V('alter table public.signals drop column best_quote_age_s;');
  const thin = db.mustFail(() => db.applyFileAtomic(FILE));
  chk('a board without a column it reads: it stops and names it', /no column\(s\) best_quote_age_s/.test(thin || ''), thin && thin.slice(0, 300));
  V('alter table public.signals add column best_quote_age_s integer;');

  let out = db.applyFileAtomic(FILE);
  const rep = out.split('\n').filter((l) => /^\d\d /.test(l));
  chk('it applies: nine report rows, every one ok', rep.length === 9 && rep.every((l) => /\|ok/.test(l)), out.slice(-1500));
  chk('the report names the gate it calls today: has_bet_checker_paid', /01 [^|]*\|ok \(fairline_paid -> has_bet_checker_paid\)/.test(out));
  out = db.applyFileAtomic(FILE);
  chk('and applies a second time, identically', out.split('\n').filter((l) => /^\d\d .*\|ok/.test(l)).length === 9);
  chk('no policy was added to signals', V("select count(*) from pg_policies where tablename = 'signals';") === '0');

  V('insert into auth.users (id, email) values ' + [A, B, P, Q, C, D, L].map((u, i) => '(' + lit(u) + ", 'u" + i + "@x.co')").join(', ') + ';');
  db.service("select public.billing_learn_price_tier('price_red_t', 'prod_bc', 'red', 'bet_checker_monthly', true, 'test');");
  db.service("select public.billing_learn_price_tier('price_blue_t', 'prod_ed', 'blue', null, true, 'test');");
  subscribe(P, 'price_red_t', 'active', 20);
  subscribe(Q, 'price_blue_t', 'trialing', 5);
  subscribe(C, 'price_red_t', 'canceled', -3);
  subscribe(D, 'price_red_t', 'active', 20);
  subscribe(L, 'price_blue_t', 'active', 20);

  /* ===================================================================== */
  /* 2. A READER'S BETS ARE THEIR OWN                                      */
  /* ===================================================================== */
  ub(P, { odds: -110, result: 'win', won: 0.9091, close: 'captured', clv: 1.2 });
  pp(P, { odds: 120, status: 'WON', sport: 'NBA', event: 'Lakers @ Celtics', sel: 'Celtics' });
  ub(Q, { odds: 150, result: 'loss', won: -1 });
  ub(A, { odds: -110, result: 'loss', won: -1, close: 'captured', clv: -2 });
  pp(B, { odds: -105, status: 'LOST' });
  const pBets = myBets(P), qBets = myBets(Q);
  chk('reader P sees their two bets, one from each source', pBets.length === 2 && pBets.map((b) => b.source).sort().join() === 'bet_checker,portfolio', pBets);
  chk('reader Q sees only Q\'s bet', qBets.length === 1 && qBets[0].source === 'bet_checker' && qBets[0].odds_american === 150, qBets);
  chk('P\'s leaks count P\'s bets only', leaks(P).counts.bets === 2 && leaks(Q).counts.bets === 1);
  chk('no reader may name another account: fairline_bets_for is not theirs to call',
    /permission denied/.test(db.mustFail(() => db.as(P, 'select * from public.fairline_bets_for(' + lit(Q) + ');')) || '') &&
    /permission denied/.test(db.mustFail(() => db.as(P, 'select public.fairline_slices_for(' + lit(Q) + ');')) || '') &&
    /permission denied/.test(db.mustFail(() => db.as(P, 'select public.fairline_paid(' + lit(Q) + ', now());')) || ''));
  chk('nor read it through the view or the door (they read the caller, and nothing else)',
    db.as(P, 'select count(*) from public.fairline_bets where bet_id in (select id from public.user_bets where user_id = ' + lit(Q) + ');') === '0');
  chk('anon reads no bet, no leak, no board',
    /permission denied/.test(db.mustFail(() => db.anon('select * from public.fairline_bets;')) || '') &&
    /permission denied/.test(db.mustFail(() => db.anon('select public.fairline_leaks();')) || '') &&
    /permission denied/.test(db.mustFail(() => db.anon('select public.fairline_board();')) || '') &&
    /permission denied/.test(db.mustFail(() => db.anon('select * from public.fairline_my_bets();')) || ''));
  chk('the service role reads one named account (The Tape will)', Number(db.service('select count(*) from public.fairline_bets_for(' + lit(P) + ');')) === 2);
  chk('a signed-out call to the door is refused, not answered empty', /sign in first/.test(db.mustFail(() => db.as('', 'select public.fairline_leaks();')) || ''));

  /* ===================================================================== */
  /* 3. THE PAID GATE                                                      */
  /* ===================================================================== */
  chk('a free reader\'s bets are not served (paid only), though they exist', myBets(A).length === 0 && myBets(B).length === 0 &&
    Number(db.service('select count(*) from public.fairline_bets_for(' + lit(A) + ');')) === 1);
  const fa = leaks(A);
  chk('a free reader\'s leaks: paid false, a teaser, and no number but the rule', fa.paid === false && !!fa.teaser &&
    JSON.stringify(numbers(fa)) === JSON.stringify(['.rules.min_sample_bets']) && !('slices' in fa) && !('overall' in fa), fa);
  chk('a lapsed Bet Checker plan is free', leaks(C).paid === false);
  chk('Bet Checker (red) is paid', leaks(P).paid === true);
  chk('the Research Terminal (blue, trialing) is paid', leaks(Q).paid === true);

  /* ===================================================================== */
  /* 4. ONE VIEW OF BOTH SOURCES, EACH BET ONCE                            */
  /* ===================================================================== */
  const E1 = 'ev_nfl_d', E2 = 'ev_cfb_d';
  const K1 = sig({ ev: E1, market: 'spreads', sel: 'Kansas City Chiefs', point: -3.5, fair: 0.52, startMs: -2 * H, closedAgoMs: 2 * H, closeFair: 0.55 });
  sig({ ev: E1, market: 'totals', sel: 'Over', point: 47.5, fair: 0.5, startMs: -2 * H });
  const K2 = sig({ ev: E2, sport: 'americanfootball_ncaaf', title: 'NCAAF', home: 'Ohio State Buckeyes', away: 'Michigan Wolverines', market: 'spreads', sel: 'Michigan Wolverines',
    point: 7, fair: 0.5, startMs: 20 * H });
  /* linked: the position names the Bet Checker row */
  const u1 = ub(D, { ev: E1, market: 'moneyline', side: 'away', team: 'Buffalo Bills', odds: 140, units: 2, result: 'loss', won: -2, close: 'captured', clv: 3.1, kickMs: -2 * H, placedMs: -30 * H });
  const p1 = pp(D, { ref: u1, odds: 140, stake: 100, status: 'LOST', sel: 'Buffalo Bills', startMs: -2 * H, placedMs: -30 * H + 5 * MIN, label: 'BetMGM', platform: 'betmgm' });
  /* same market key, same odds */
  const u2 = ub(D, { ev: E1, market: 'spread', side: 'home', team: 'Kansas City Chiefs', line: -3.5, odds: -110, result: 'win', won: 0.9091, close: 'captured', clv: 4.5, kickMs: -2 * H, placedMs: -26 * H });
  const p2 = pp(D, { type: 'SPREAD', line: -3.5, sel: 'Kansas City Chiefs -3.5', odds: -110, stake: 55, status: 'WON', sigKey: K1, startMs: -2 * H, placedMs: -25 * H });
  /* same game: start, market, line, odds and side, no key */
  const u3 = ub(D, { ev: E1, market: 'total', side: 'over', line: 47.5, odds: -105, result: 'push', won: 0, close: 'no_close_available', kickMs: -2 * H, placedMs: -10 * H });
  const p3 = pp(D, { type: 'TOTAL', line: 47.5, sel: 'Over 47.5', odds: -105, stake: 21, status: 'PUSH', startMs: -2 * H + 3 * MIN, placedMs: -9 * H });
  /* NOT the same bet: a different price */
  const u4 = ub(D, { ev: E1, market: 'moneyline', side: 'home', team: 'Kansas City Chiefs', odds: -150, result: 'win', won: 0.6667, close: 'captured', clv: 0.5, kickMs: -2 * H, placedMs: -8 * H });
  const p4 = pp(D, { type: 'MONEYLINE', sel: 'Kansas City Chiefs', odds: -145, stake: 30, status: 'WON', startMs: -2 * H, placedMs: -8 * H });
  /* twins: the same bet twice in each source */
  const tw = [0, 1].map((i) => ({
    u: ub(D, { ev: E2, sport: 'CFB', market: 'spread', side: 'away', team: 'Michigan Wolverines', line: 7, odds: -110, close: 'pending', kickMs: 20 * H, placedMs: -(5 - i) * H,
      home: 'Ohio State Buckeyes', away: 'Michigan Wolverines' }),
    p: pp(D, { type: 'SPREAD', line: 7, sel: 'Michigan Wolverines +7', odds: -110, stake: 44, sigKey: K2, startMs: 20 * H, placedMs: -(5 - i) * H + MIN,
      event: 'Michigan Wolverines @ Ohio State Buckeyes', league: 'NCAAF', sport: 'Football' })
  }));
  /* a parlay is its own bet, never merged */
  const p6 = pp(D, { type: 'PARLAY', sel: '3-leg parlay', odds: 600, stake: 10, status: 'LOST', legs: [{ s: 'a' }, { s: 'b' }, { s: 'c' }] });
  const dB = myBets(D);
  const byRef = (r) => dB.find((b) => b.bet_ref === r);
  chk('D\'s thirteen records are eight bets', dB.length === 8, dB.map((b) => b.bet_ref));
  const b1 = byRef('both:' + u1 + ':' + p1), b2 = byRef('both:' + u2 + ':' + p2), b3 = byRef('both:' + u3 + ':' + p3);
  chk('a position that names its Bet Checker row is ONE bet (linked)', !!b1 && b1.source === 'both' && b1.matched_by === 'linked');
  chk('…the same market key at the same odds is ONE bet (same_market)', !!b2 && b2.matched_by === 'same_market');
  chk('…the same start, market, line, odds and side is ONE bet (same_game)', !!b3 && b3.matched_by === 'same_game');
  chk('a different price is a different bet: both kept', !!byRef('ub:' + u4) && !!byRef('pp:' + p4));
  chk('twins pair one to one: two bets, never one and never four', tw.every((t) => !!byRef('both:' + t.u + ':' + t.p)) &&
    dB.filter((b) => b.bet_ref.indexOf(tw[0].u) >= 0 || b.bet_ref.indexOf(tw[1].u) >= 0).length === 2);
  const par = byRef('pp:' + p6);
  chk('a parlay stands alone, as a parlay', !!par && par.bet_type === 'parlay' && par.market === 'parlay' && par.odds_american === 600);
  chk('a merged bet keeps the book\'s money (dollars, the result) and Bet Checker\'s units',
    Number(b1.stake_dollars) === 100 && Number(b1.pl_dollars) === -100 && Number(b1.stake_units) === 2 && Number(b1.pl_units) === -2 && b1.result === 'loss' && b1.platform === 'BetMGM', b1);
  chk('…and Bet Checker\'s captured close', Number(b1.clv_pct) === 3.1 && b1.clv_status === 'captured');
  chk('the units of a merged win are the book\'s return on Bet Checker\'s stake (1u at 55 → +50 = +0.9091u)',
    Number(b2.pl_dollars) === 50 && Number(b2.pl_units) === 0.9091 && b2.result === 'win', b2);
  chk('a push is settled, zero', b3.settled === true && b3.result === 'push' && Number(b3.pl_dollars) === 0);
  chk('sports come out as one name: Football + NCAAF is CFB', byRef('both:' + tw[0].u + ':' + tw[0].p).sport === 'CFB');
  const lone = byRef('pp:' + p4);
  chk('a position with no matched market has no CLV (not applicable), never an estimate', lone.clv_status === 'not_applicable' && lone.clv_pct === null);
  chk('a twin whose game has not closed is pending', byRef('both:' + tw[0].u + ':' + tw[0].p).clv_status === 'pending' && byRef('both:' + tw[0].u + ':' + tw[0].p).settled === false);
  chk('a Bet Checker bet without a unit size has no dollars, and says so',
    byRef('ub:' + u4).stake_dollars === null && byRef('ub:' + u4).pl_dollars === null && byRef('ub:' + u4).dollars_basis === null);
  chk('a Portfolio bet without a unit size has no units', lone.stake_units === null && Number(lone.stake_dollars) === 30);

  /* ===================================================================== */
  /* 5. THE SLICES AND THEIR LABELS                                        */
  /* ===================================================================== */
  /* L: a $50 unit, and six groups of bets, one per sport, each built to read
     one way */
  V('insert into public.bankroll_settings (user_id, base_unit_amount, unit_mode) values (' + lit(L) + ", 50, 'fixed') on conflict (user_id) do update set base_unit_amount = 50, unit_mode = 'fixed';");
  const NBA = sig({ key: 'nba1|h2h|Boston Celtics|', ev: 'nba1', sport: 'basketball_nba', title: 'NBA', home: 'Boston Celtics', away: 'Los Angeles Lakers', market: 'h2h',
    sel: 'Boston Celtics', fair: 0.5, startMs: -H, closedAgoMs: H, closeFair: 0.45 });
  const NHL = sig({ key: 'nhl1|spreads|Boston Bruins|-1.5', ev: 'nhl1', sport: 'icehockey_nhl', title: 'NHL', home: 'Boston Bruins', away: 'Toronto Maple Leafs', market: 'spreads',
    sel: 'Boston Bruins', point: -1.5, fair: 0.5, startMs: -H, closedAgoMs: H, closeFair: 0.56 });
  for (let i = 0; i < 15; i++) {
    /* NFL, Bet Checker spreads at DraftKings, 50h out: 5-10, the close beat them (-2%): a REAL LEAK */
    ub(L, { sport: 'NFL', market: 'spread', side: 'home', team: 'Kansas City Chiefs', line: -3.5, odds: -110, book: 'DraftKings', result: i < 5 ? 'win' : 'loss',
      won: i < 5 ? 0.9091 : -1, close: 'captured', clv: -2, placedMs: -100 * H - i * MIN, kickMs: -50 * H });
    /* CFB, Bet Checker totals at Kalshi, 30h out: 5-10, but they beat the close (+3%): BAD LUCK */
    ub(L, { sport: 'CFB', market: 'total', side: 'over', line: 55.5, odds: -110, book: 'Kalshi', result: i < 5 ? 'win' : 'loss', won: i < 5 ? 0.9091 : -1,
      close: 'captured', clv: 3, placedMs: -80 * H - i * MIN, kickMs: -50 * H, home: 'Ohio State Buckeyes', away: 'Michigan Wolverines' });
    /* NBA, Portfolio moneylines at +100, 10h out: 12-3, and the close beat them (2.0 x 0.45 - 1 = -10%): RUNNING HOT */
    pp(L, { type: 'MONEYLINE', sport: 'NBA', event: 'Los Angeles Lakers @ Boston Celtics', sel: 'Boston Celtics', odds: 100, stake: 50, status: i < 12 ? 'WON' : 'LOST',
      sigKey: NBA, startMs: -H, placedMs: -11 * H - i * MIN, label: 'BetMGM', platform: 'betmgm' });
    /* NHL, Portfolio puck lines at -110, 2h out: 10-5, and they beat the close (1.9091 x 0.56 - 1 = +6.91%): A REAL EDGE */
    pp(L, { type: 'SPREAD', sport: 'NHL', event: 'Toronto Maple Leafs @ Boston Bruins', sel: 'Boston Bruins -1.5', line: -1.5, odds: -110, stake: 50, status: i < 10 ? 'WON' : 'LOST',
      sigKey: NHL, startMs: -H, placedMs: -3 * H - i * MIN, label: 'Caesars', platform: 'caesars' });
  }
  for (let i = 0; i < 16; i++) {
    /* MLB props at +150, $25, no start known, no close: 4-12, LOSING, on P/L alone */
    pp(L, { type: 'PLAYER_PROP', sport: 'MLB', event: 'Yankees @ Red Sox', sel: 'Judge over 1.5 total bases', odds: 150, stake: 25, status: i < 4 ? 'WON' : 'LOST',
      placedMs: -40 * H - i * MIN, label: 'FanDuel' });
  }
  for (let i = 0; i < 14; i++) {
    /* Soccer moneylines at +250, $200, placed after the start (live): 14 bets, a SMALL SAMPLE */
    pp(L, { type: 'MONEYLINE', sport: 'Soccer', event: 'Arsenal v Chelsea', sel: 'Chelsea', odds: 250, stake: 200, status: i < 2 ? 'WON' : 'LOST',
      startMs: -30 * H, placedMs: -29 * H - i * MIN, settledMs: -27 * H, label: 'FanDuel' });
  }
  ub(L, { sport: 'NFL', market: 'spread', side: 'home', team: 'Kansas City Chiefs', line: -3.5, odds: -110, book: 'DraftKings', close: 'pending', placedMs: -60 * H, kickMs: 10 * H });
  ub(L, { sport: 'NFL', market: 'spread', side: 'home', team: 'Kansas City Chiefs', line: -3.5, odds: -110, book: 'DraftKings', result: 'loss', won: -1, status: 'void', placedMs: -60 * H, kickMs: -50 * H });
  const lk = leaks(L);
  chk('(L\'s leaks came back paid)', lk && lk.paid === true, lk && Object.keys(lk));
  const nfl = slice(lk, 'sport', 'NFL'), cfb = slice(lk, 'sport', 'CFB'), nba = slice(lk, 'sport', 'NBA'), nhl = slice(lk, 'sport', 'NHL');
  const mlb = slice(lk, 'sport', 'MLB'), soc = slice(lk, 'sport', 'SOCCER');
  chk('NFL: 15 settled bets, 5-10, one pending (the open bet), the void left out', nfl && nfl.bets === 15 && nfl.wins === 5 && nfl.losses === 10 && nfl.pending === 1, nfl);
  chk('NFL: units 5 x 0.9091 - 10 = -5.45; dollars at the $50 unit 5 x 45.46 - 500 = -272.70; ROI -36.4%',
    Number(nfl.pl_units) === -5.45 && Number(nfl.pl_dollars) === -272.7 && nfl.roi_basis === 'dollars' && Number(nfl.roi_pct) === -36.4, nfl);
  chk('NFL: average CLV -2%, beat the close 0 of 15', Number(nfl.avg_clv_pct) === -2 && nfl.clv_bets === 15 && nfl.beat_close === 0 && Number(nfl.beat_close_pct) === 0);
  chk('NFL: losing AND not beating the close — a REAL LEAK, read from the close', nfl.label === 'real_leak' && nfl.label_basis === 'clv' && nfl.small_sample === false);
  chk('CFB: losing but beating the close (+3%, 15 of 15) — BAD LUCK', cfb && cfb.label === 'bad_luck' && Number(cfb.avg_clv_pct) === 3 && Number(cfb.beat_close_pct) === 100, cfb);
  chk('NBA: winning (+$450) but the close beat them (-10%) — RUNNING HOT', nba && nba.label === 'running_hot' && Number(nba.pl_dollars) === 450 && Number(nba.avg_clv_pct) === -10, nba);
  chk('NBA: the units are the dollars over the $50 unit (+9)', Number(nba.pl_units) === 9);
  chk('NHL: winning and beating the close (+6.91%) — A REAL EDGE', nhl && nhl.label === 'real_edge' && Number(nhl.avg_clv_pct) === 6.91, nhl);
  chk('MLB props: 16 bets, losing, no captured close — labelled on P/L ONLY, and marked so',
    mlb && mlb.bets === 16 && mlb.label === 'losing' && mlb.label_basis === 'pl_only' && mlb.clv_bets === 0 && mlb.avg_clv_pct === null, mlb);
  chk('Soccer: 14 bets — a SMALL SAMPLE, and no label at all', soc && soc.bets === 14 && soc.small_sample === true && soc.label === null && soc.label_basis === null, soc);
  chk('the market slices: spread 30, total 15, moneyline 29, props 16', [['spread', 30], ['total', 15], ['moneyline', 29], ['props', 16]]
    .every(([v, n]) => slice(lk, 'market', v) && slice(lk, 'market', v).bets === n), lk.slices.filter((s) => s.dim === 'market').map((s) => [s.val, s.bets]));
  chk('the odds ranges: -120 to +120 holds 60, +121 to +200 16, over +200 14', slice(lk, 'odds', 'm120_p120').bets === 60 &&
    slice(lk, 'odds', 'p121_p200').bets === 16 && slice(lk, 'odds', 'gt_p200').bets === 14);
  chk('the lead times: 48h+ 15, 24-48h 15, 6-24h 15, under 6h 15, live 14, unknown 16',
    [['48h_plus', 15], ['24_48h', 15], ['6_24h', 15], ['under_6h', 15], ['live', 14], ['unknown', 16]].every(([v, n]) => slice(lk, 'lead', v) && slice(lk, 'lead', v).bets === n),
    lk.slices.filter((s) => s.dim === 'lead').map((s) => [s.val, s.bets]));
  chk('…in their order, live and unknown last', lk.slices.filter((s) => s.dim === 'lead').map((s) => s.val).join() === '48h_plus,24_48h,6_24h,under_6h,live,unknown');
  chk('stake against the $50 median: typical 60, small ($25) 16, oversized ($200) 14',
    slice(lk, 'stake', 'typical').bets === 60 && slice(lk, 'stake', 'small').bets === 16 && slice(lk, 'stake', 'oversized').bets === 14);
  chk('the books: DraftKings, Kalshi, BetMGM, Caesars 15 each, FanDuel 30', [['DraftKings', 15], ['Kalshi', 15], ['BetMGM', 15], ['Caesars', 15], ['FanDuel', 30]]
    .every(([v, n]) => slice(lk, 'book', v) && slice(lk, 'book', v).bets === n));
  chk('bet type: 90 straight', slice(lk, 'bet_type', 'straight').bets === 90 && !slice(lk, 'bet_type', 'parlay'));
  chk('overall: 90 settled, 1 pending', lk.overall.bets === 90 && lk.overall.pending === 1 && lk.counts.bets === 91);
  const top = lk.top_leaks;
  const leakSlices = lk.slices.filter((s) => s.label === 'real_leak');
  chk('the top leaks are real leaks only, biggest loss first, at most three', top.length >= 1 && top.length <= 3 && top.every((s) => s.label === 'real_leak') &&
    top.every((s, i) => i === 0 || Number(top[i - 1].pl_basis_value) <= Number(s.pl_basis_value)), top.map((s) => [s.dim, s.val, s.pl_basis_value]));
  chk('NFL and DraftKings hold the same fifteen bets: the leak is listed ONCE',
    !!slice(lk, 'book', 'DraftKings') && slice(lk, 'book', 'DraftKings').label === 'real_leak' && leakSlices.some((s) => s.dim === 'sport' && s.val === 'NFL') &&
    top.filter((s) => (s.dim === 'sport' && s.val === 'NFL') || (s.dim === 'book' && s.val === 'DraftKings')).length === 1, top.map((s) => [s.dim, s.val]));
  chk('no "all" slice among the leaks, and no internal hash leaves', !top.some((s) => s.dim === 'all') && !JSON.stringify(lk).includes('set_hash'));

  /* the same reader, lapsed: the teaser names the biggest leak's slice and nothing else */
  subscribe(L, 'price_blue_t', 'canceled', -1);
  const tz = leaks(L);
  chk('lapsed: the teaser is the biggest leak\'s slice name — the same slice the paid page leads with',
    tz.paid === false && tz.teaser.state === 'leak' && tz.teaser.dim === top[0].dim && tz.teaser.val === top[0].val, [tz, top[0].dim, top[0].val]);
  chk('…and carries no count, money or CLV', JSON.stringify(numbers(tz)) === JSON.stringify(['.rules.min_sample_bets']) && Object.keys(tz.teaser).sort().join() === 'dim,state,val');
  subscribe(L, 'price_blue_t', 'active', 20);
  chk('a free reader with too few bets is told so', leaks(B).teaser.state === 'not_enough_bets');

  /* ===================================================================== */
  /* 6. THE BUCKETS, FROM THE ONE CONSTANT                                 */
  /* ===================================================================== */
  const ob = (o) => V('select public.fairline_odds_bucket(' + o + ');');
  chk('odds: -200 | -199 and -121 | -120, -100, +100, +120 | +121 and +200 | +201', ob(-200) === 'le_m200' && ob(-1000) === 'le_m200' && ob(-199) === 'm199_m121' &&
    ob(-121) === 'm199_m121' && ob(-120) === 'm120_p120' && ob(-100) === 'm120_p120' && ob(100) === 'm120_p120' && ob(120) === 'm120_p120' &&
    ob(121) === 'p121_p200' && ob(200) === 'p121_p200' && ob(201) === 'gt_p200' && ob(5000) === 'gt_p200');
  chk('odds that are not odds have no range', ob(50) === '' && ob('null') === '');
  const lb = (h) => V("select public.fairline_lead_bucket(now(), now() + interval '" + Math.round(h * 3600) + " seconds');");
  chk('lead: 48h is 48h+, just under is 24-48h; 24h is 24-48h; 6h is 6-24h; just under is under 6h', lb(48) === '48h_plus' && lb(47.99) === '24_48h' && lb(24) === '24_48h' &&
    lb(23.99) === '6_24h' && lb(6) === '6_24h' && lb(5.99) === 'under_6h' && lb(0.01) === 'under_6h');
  chk('lead: placed at or after the start is live; no start is unknown', lb(0) === 'live' && lb(-2) === 'live' && V('select public.fairline_lead_bucket(now(), null);') === 'unknown');
  const sb = (x) => V('select public.fairline_stake_bucket(' + x + ');');
  chk('stake: under 0.75x small; 0.75x up to 1.25x typical; to 2x large; 2x and up oversized', sb(0.74) === 'small' && sb(0.75) === 'typical' && sb(1.249) === 'typical' &&
    sb(1.25) === 'large' && sb(1.99) === 'large' && sb(2) === 'oversized' && sb('null') === 'unknown');
  const fl = (b, c, r, v) => V('select coalesce(public.fairline_label(' + [b, c, r, v].join(', ') + "), 'none');");
  chk('the label at the minimum: 14 bets none, 15 a label', fl(14, 15, -0.1, -1) === 'none' && fl(15, 15, -0.1, -1) === 'real_leak');
  chk('the label without enough closes: P/L only', fl(20, 14, -0.1, -1) === 'losing' && fl(20, 0, 0.2, 'null') === 'winning');
  chk('a CLV of exactly zero is not beating the close; a return of exactly zero is not losing', fl(20, 20, -0.1, 0) === 'real_leak' && fl(20, 20, 0, 1) === 'real_edge');

  /* the page's mirrors (lib/edgedesk_fairline_core.js) agree with these
     functions on a grid of cases, reading the rules the database returns */
  const CORE = require(path.join(ROOT, 'lib', 'edgedesk_fairline_core.js'));
  const RULES = JSON.parse(V('select public.fairline_rules();'));
  const grid = (xs, fn) => V('select string_agg(coalesce(' + fn + "(x)::text, '-'), ',' order by n) from unnest(array[" + xs.join(',') + ']::numeric[]) with ordinality t(x, n);');
  const odds = []; for (let a = -1200; a <= 1200; a += 3) odds.push(a);
  [-200, -199, -121, -120, -100, 100, 120, 121, 200, 201, -120.4, -120.6, 99, -99].forEach((a) => odds.push(a));
  chk('odds buckets: the page and the database agree on ' + odds.length + ' prices',
    grid(odds, 'public.fairline_odds_bucket') === odds.map((a) => CORE.oddsBucket(a, RULES) || '-').join(','));
  const hours = []; for (let h = -5; h <= 80; h += 0.25) hours.push(h);
  [47.999, 48, 23.999, 24, 5.999, 6, 0, 0.001].forEach((h) => hours.push(h));
  const T0 = '2026-11-01T18:00:00.000Z';
  const sqlLead = V("select string_agg(public.fairline_lead_bucket(timestamptz '" + T0 + "' - make_interval(secs => x * 3600), timestamptz '" + T0 + "'), ',' order by n) " +
    'from unnest(array[' + hours.join(',') + ']::numeric[]) with ordinality t(x, n);');
  chk('lead buckets: the page and the database agree on ' + hours.length + ' lead times',
    sqlLead === hours.map((h) => CORE.leadBucket(new Date(Date.parse(T0) - h * 3600000).toISOString(), T0, RULES)).join(','));
  const ratios = []; for (let x = 0; x <= 5; x += 0.05) ratios.push(Math.round(x * 100) / 100);
  [0.75, 1.25, 2, 0.7499, 1.2499, 1.9999].forEach((x) => ratios.push(x));
  chk('stake buckets: the page and the database agree on ' + ratios.length + ' ratios',
    grid(ratios, 'public.fairline_stake_bucket') === ratios.map((x) => CORE.stakeBucket(x, RULES)).join(','));
  const cases = [];
  for (const b of [0, 14, 15, 16, 40]) for (const c of [0, 14, 15, 40]) for (const r of [-0.2, -0.0001, 0, 0.0001, 0.3]) for (const v of [-2, 0, 0.0001, 2, null]) cases.push([b, c, r, v]);
  const sqlLab = V("select string_agg(coalesce(public.fairline_label(b, c, r, v), '-'), ',' order by n) from (values " +
    cases.map((x, i) => '(' + [i, x[0], x[1], x[2], x[3] == null ? 'null::numeric' : x[3]].join(', ') + ')').join(', ') + ') t(n, b, c, r, v);');
  chk('the labels: the page and the database agree on ' + cases.length + ' slices',
    sqlLab === cases.map((x) => CORE.classify(x[0], x[1], x[2], x[3], RULES) || '-').join(','));

  /* ===================================================================== */
  /* 7. THE BOARD                                                          */
  /* ===================================================================== */
  const G = 'ev_board_nfl', G2 = 'ev_board_nba';
  const bk = {};
  /* a game 48 hours out: the far rung, 120 minutes for the NFL */
  bk.hs = sig({ ev: G, market: 'spreads', sel: 'Kansas City Chiefs', point: -3.5, fair: 0.52, best: 2.0, book: 'FanDuel', startMs: 48 * H, ageS: 120 });
  bk.as = sig({ ev: G, market: 'spreads', sel: 'Buffalo Bills', point: 3.5, fair: 0.48, best: 2.02, book: 'DraftKings', startMs: 48 * H });
  bk.halt = sig({ ev: G, market: 'spreads', sel: 'Kansas City Chiefs', point: -3, fair: 0.555, best: 2.5, book: 'FanDuel', startMs: 48 * H, modal: false, seenAgoMs: 5 * MIN });
  bk.o = sig({ ev: G, market: 'totals', sel: 'Over', point: 47.5, fair: 0.5, best: 1.95, book: 'BetMGM', startMs: 48 * H });
  bk.u = sig({ ev: G, market: 'totals', sel: 'Under', point: 47.5, fair: 0.5, best: 1.93, book: 'BetMGM', startMs: 48 * H, seenAgoMs: 3 * H });   /* stale: 3h > 120 min */
  bk.mh = sig({ ev: G, market: 'h2h', sel: 'Kansas City Chiefs', fair: 0.62, best: 1.69, book: 'DraftKings', startMs: 48 * H });
  bk.ma = sig({ ev: G, market: 'h2h', sel: 'Buffalo Bills', fair: 0.38, best: 2.9, book: 'Caesars', startMs: 48 * H });
  sig({ ev: G, market: 'player_pass_yds', sel: 'Over', point: 250.5, fair: 0.5, best: 2.2, startMs: 48 * H });     /* a prop: not on The Board */
  sig({ ev: 'ev_started', market: 'h2h', sel: 'Dallas Cowboys', fair: 0.5, best: 2.4, startMs: -H });              /* started */
  sig({ ev: 'ev_far', market: 'h2h', sel: 'Dallas Cowboys', fair: 0.5, best: 2.4, startMs: 10 * 24 * H });          /* beyond the week */
  bk.nba = sig({ ev: G2, sport: 'basketball_nba', title: 'NBA', home: 'Boston Celtics', away: 'Los Angeles Lakers', market: 'h2h', sel: 'Boston Celtics',
    fair: 0.6, best: 1.8, book: 'FanDuel', startMs: 5 * H, ageS: 0, seenAgoMs: 20 * MIN });
  const bp = board(P);
  const rowOf = (bd, k) => (bd.rows || []).find((r) => r.sig_key === k);
  chk('(the paid board came back paid, from signals only: no book_quotes, no Kalshi here)', bp.paid === true && bp.coverage.book_quotes === false && bp.coverage.kalshi === false, bp.coverage);
  const mine = bp.rows.filter((r) => r.event_id === G || r.event_id === G2);
  chk('upcoming games only, game markets only, one row per market and side at the main line',
    mine.length === 7 && bp.rows.length === 8 && !bp.rows.some((r) => r.sig_key === bk.halt || /player_pass_yds/.test(r.sig_key) || /ev_started|ev_far/.test(r.event_id)), bp.rows.map((r) => r.sig_key));
  const hs = rowOf(bp, bk.hs);
  chk('the fair as a probability and as fair odds (52% = -108)', Number(hs.fair_prob) === 0.52 && hs.fair_american === -108, hs);
  chk('the best price capture saw, and where (+100 at FanDuel)', Number(hs.best_dec) === 2 && hs.best_american === 100 && hs.best_book === 'FanDuel' && hs.best_source === 'signals');
  chk('edge vs fair, in points: 52% - 50% = +2.00', Number(hs.edge_pts) === 2);
  chk('quote age: two minutes old at capture plus ten since = 12 minutes; the NFL limit 48h out is 120', Number(hs.quote_age_min) === 12 && hs.fresh_limit_min === 120 && hs.fresh === true, hs);
  const un = rowOf(bp, bk.u);
  chk('a price past its limit is STALE (3h > 120 min) and sorted after every fresh row', un.fresh === false &&
    bp.rows.findIndex((r) => !r.fresh) === bp.rows.length - 2 && bp.rows.slice(0, -2).every((r) => r.fresh === true), bp.rows.map((r) => [r.sig_key, r.fresh, r.edge_pts]));
  const np = rowOf(bp, K2);
  chk('a side with a fair and no captured price is shown, unpriced, never fresh, last', np && np.best_dec === null && np.edge_pts === null && np.fresh === false &&
    bp.rows[bp.rows.length - 1].sig_key === K2, np);
  const fresh = bp.rows.filter((r) => r.fresh);
  chk('fresh rows by edge, largest first', fresh.every((r, i) => i === 0 || Number(fresh[i - 1].edge_pts) >= Number(r.edge_pts)), fresh.map((r) => r.edge_pts));
  chk('the NBA game 5h out is on the "soon" rung for its group (40 min)', rowOf(bp, bk.nba).fresh_limit_min === 40 && rowOf(bp, bk.nba).fresh === true);
  chk('the moneyline row has no point', rowOf(bp, bk.mh).point === null && rowOf(bp, bk.mh).market === 'moneyline');
  chk('DK Predictions is an inactive column, Coming Soon, and no row carries a number for it',
    bp.inactive.length === 1 && bp.inactive[0].column === 'dk_predictions' && bp.inactive[0].state === 'coming_soon' && !bp.rows.some((r) => Object.keys(r).some((k) => /^dk/.test(k))));
  const KEYS = 'away_team,best_american,best_book,best_dec,best_source,commence_time,edge_pts,event_id,fair_american,fair_prob,fresh,fresh_limit_min,home_team,kalshi_ask,kalshi_at,kalshi_mid,kalshi_state,market,point,quote_age_min,selection,sig_key,sport,sport_key';
  chk('a row carries only the columns the page needs', bp.rows.every((r) => Object.keys(r).sort().join() === KEYS), Object.keys(hs).sort().join());
  chk('the paid board has its facets', bp.facets.sports.length === 3 && bp.facets.books.length >= 4 && bp.filters.locked === false);
  chk('filter by market: totals only', board(P, null, 'total').rows.every((r) => r.market === 'total') && board(P, null, 'total').rows.length === 2);
  chk('filter by sport: the NBA game only', board(P, 'basketball_nba').rows.length === 1 && board(P, 'basketball_nba').rows[0].sig_key === bk.nba);
  chk('filter by book: rows priced at DraftKings only', board(P, null, null, 'draftkings').rows.map((r) => r.sig_key).sort().join() === [bk.as, bk.mh].sort().join());

  const bf = board(A);
  chk('free: the top three FRESH rows, in the paid board\'s order', bf.paid === false && bf.rows.length === 3 &&
    bf.rows.map((r) => r.sig_key).join() === fresh.slice(0, 3).map((r) => r.sig_key).join(), [bf.rows.map((r) => r.sig_key), fresh.slice(0, 3).map((r) => r.sig_key)]);
  chk('free: how many more there are, and nothing about them', bf.hidden_rows === bp.rows.length - 3 && bf.facets === null && bf.filters.locked === true);
  chk('free: a filter is ignored (the teaser is the whole board\'s top three)', board(A, 'basketball_nba', 'total', 'FanDuel').rows.map((r) => r.sig_key).join() === bf.rows.map((r) => r.sig_key).join());
  chk('a stale row is never in the free teaser', !bf.rows.some((r) => r.sig_key === bk.u));

  /* per-book quotes, where capture wrote them */
  V(`create table public.book_quotes (sig_key text not null, book_key text not null, book_title text, dec numeric, opp_dec numeric, fair numeric,
       updated_at timestamptz not null default now(), quote_age_s integer, is_fresh boolean, is_reference boolean, is_best boolean, book_family text, book_tier text);
     insert into public.book_quotes (sig_key, book_key, book_title, dec, updated_at, quote_age_s, is_fresh) values
       (${lit(bk.hs)}, 'draftkings', 'DraftKings', 2.04, now() - interval '3 minutes', 30, true),
       (${lit(bk.hs)}, 'betrivers', 'BetRivers', 2.30, now() - interval '3 minutes', 4000, false),
       (${lit(bk.hs)}, 'betmgm', 'BetMGM', 1.98, now() - interval '3 minutes', 10, true);`);
  const bq = board(P);
  const hq = rowOf(bq, bk.hs);
  chk('with book_quotes: the best FRESH per-book quote wins (+104 at DraftKings), the one capture called stale does not',
    bq.coverage.book_quotes === true && hq.best_source === 'book_quotes' && Number(hq.best_dec) === 2.04 && hq.best_book === 'DraftKings' && hq.best_american === 104, hq);
  chk('…its age is its own (30 s + 3 min = 3.5 min), and its edge is from it (52% - 49.02% = +2.98)', Number(hq.quote_age_min) === 3.5 && Number(hq.edge_pts) === 2.98, hq);
  chk('a row with no per-book quotes still reads signals', rowOf(bq, bk.as).best_source === 'signals');
  chk('filter by book reads the book\'s own quote (BetMGM on KC -3.5: 1.98)', Number(rowOf(board(P, null, null, 'BetMGM'), bk.hs).best_dec) === 1.98);

  /* Kalshi, with the card's own display rule */
  V(`create table public.kalshi_card_current (odds_event_id text, yes_team text, state text, yes_mid numeric, yes_ask numeric, snapshot_at timestamptz);
     insert into public.kalshi_card_current values (${lit(G)}, 'Kansas City Chiefs', 'OK', 0.6, 0.61, now() - interval '4 minutes'),
                                                   (${lit(G)}, 'Buffalo Bills', 'STALE', 0.4, 0.42, now() - interval '50 minutes');`);
  const bk2 = board(P);
  chk('Kalshi where linked and OK: its mid and ask', bk2.coverage.kalshi === true && rowOf(bk2, bk.mh).kalshi_state === 'OK' &&
    Number(rowOf(bk2, bk.mh).kalshi_mid) === 0.6 && Number(rowOf(bk2, bk.mh).kalshi_ask) === 0.61, rowOf(bk2, bk.mh));
  chk('Kalshi not OK: its state, and no price', rowOf(bk2, bk.ma).kalshi_state === 'STALE' && rowOf(bk2, bk.ma).kalshi_mid === null && rowOf(bk2, bk.ma).kalshi_ask === null);
  chk('no Kalshi on a spread or total', rowOf(bk2, bk.hs).kalshi_state === null);
  chk('Kalshi never changes the best price or the edge', Number(rowOf(bk2, bk.mh).best_dec) === 1.69 && rowOf(bk2, bk.mh).best_book === 'DraftKings');
  V('drop table public.kalshi_card_current; create table public.kalshi_card_current (odds_event_id text);');
  chk('a Kalshi layer of a shape this file does not know: the board without it, never an error', board(P).coverage.kalshi === false && board(P).rows.length === 8);
  chk('the board is the signed-in reader\'s or the service role\'s', JSON.parse(db.service('select public.fairline_board();')).paid === true &&
    /sign in first/.test(db.mustFail(() => db.as('', 'select public.fairline_board();')) || ''));
} catch (e) {
  chk('the suite ran to the end', false, String(e && e.stack || e).slice(0, 2000));
} finally {
  db.stop();
}
process.exit(T.done());
