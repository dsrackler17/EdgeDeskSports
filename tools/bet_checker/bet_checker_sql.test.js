#!/usr/bin/env node
/* ===========================================================================
   supabase/bet_checker.sql, AGAINST A REAL POSTGRESQL, AS REAL READERS.

   Bet Checker grades the bets a reader already placed: against EdgeDesk's
   fair price at the moment the bet is logged, and against EdgeDesk's captured
   close. This proves, by acting as reader A, reader B reaching for A's rows,
   anon and the service role:

     1 it installs over bettor_decisions.sql's user_bets (twice), names what
       it needs, and its report says ok
     2 a reader sees and changes only their own bets, and can write none of
       the grading columns (a direct insert arrives ungraded)
     3 logging: green / yellow / red from ONE constant; no fair at that exact
       line, or a stale one, is ungraded with a reason; a started game, a
       sport Bet Checker does not grade, a bad shape are refused; a double
       submit is one bet
     4 the free allowance: ten grades a month, then the bet is saved ungraded
       with an upgrade prompt; deleting a bet gives no grade back; two
       simultaneous submits cannot both take the last grade; paid is unlimited
     5 after the close: CLV at the bet's own line (the house formula), no
       close where the market closed at another line, the result from settle
       or from the final score, the flag revealed only once the game starts —
       and a second run changes nothing
     6 the stats are paid-only, and right; free history is 30 days

   Run: node tools/bet_checker/bet_checker_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));

const T = PG.kit('bet checker SQL');
const chk = T.chk;
const lit = PG.lit;
const ROOT = PG.ROOT;
const FILE = path.join(ROOT, 'supabase', 'bet_checker.sql');
const MIRROR = path.join(ROOT, 'supabase', 'migrations', '20261028120000_bet_checker.sql');
const SQL = fs.readFileSync(FILE, 'utf8');

/* ── STATIC: the folder's conventions ──────────────────────────────────── */
chk('no psql meta-commands (it is pasted into the SQL editor)', !/^\\/m.test(SQL));
chk('it ends in a report', /CHECK THIS/.test(SQL) && /order by 1;\s*$/.test(SQL));
chk('nothing is dropped but triggers it re-creates', !/\bdrop\s+(table|column|view|function|index|policy\s+(?!if exists bet_checker))/i.test(SQL.replace(/--.*$/gm, '')));
chk('the migration mirror is byte-identical', fs.existsSync(MIRROR) && fs.readFileSync(MIRROR, 'utf8') === SQL);
chk('PostgREST is told to reload', /notify pgrst, 'reload schema'/.test(SQL));
chk('the grade thresholds are written once, in bet_checker_rules()',
  (SQL.replace(/--.*$/gm, '').match(/'green_min_edge_pct',\s*1\.5/g) || []).length === 1 &&
  (SQL.replace(/--.*$/gm, '').match(/'red_max_edge_pct',\s*-1\.5/g) || []).length === 1 &&
  !/>=\s*1\.5|<=\s*-1\.5/.test(SQL.replace(/--.*$/gm, '').replace(/public\.bet_checker_grade_of\([^)]*\)\s*=\s*'\w+'/g, '')));
chk('the CLV is the house formula (close/index.ts decideClose: entryDec * closeFair - 1)',
  /round\(\(v_dec \* v_fair - 1\) \* 100, 2\)/.test(SQL) &&
  /return \{ clv: entryDec \* closeFair - 1, reason: null \};/.test(fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'close', 'index.ts'), 'utf8')));

const db = PG.start('betchk');
/* BET_CHECKER_SQL_REQUIRED=1 (CI) makes a missing PostgreSQL a failure, never a pass */
if (db.skip) { if (process.env.BET_CHECKER_SQL_REQUIRED === '1') chk('environment: ' + db.skip, false); console.log('SKIPPED | ' + db.skip + ' — the LIVE layer did not run (not verified)'); process.exit(T.done()); }

const J = (q) => JSON.parse(db.sql('select coalesce(json_agg(t), \'[]\'::json) from (' + q + ') t;') || '[]');
const one = (q) => J(q)[0];
const V = (q) => db.sql(q);
const uid = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const A = uid(1), B = uid(2), P = uid(3), Q = uid(4), C = uid(5), Z = uid(6);
const H = 3600 * 1000;
const at = (ms) => "(now() + interval '" + Math.round(ms / 1000) + " seconds')";
const key = () => crypto.randomBytes(8).toString('hex');

/* the board: capture's signals, in the shape capture writes */
const SIG_COLS = 'sig_key text primary key, event_id text, sport_key text, sport_title text, commence_time timestamptz, home_team text, away_team text, ' +
  'market text, selection text, point numeric, sharp_fair numeric, last_seen_at timestamptz, point_is_modal boolean, is_player_prop boolean not null default false, ' +
  'flagged_at timestamptz, closed_at timestamptz, closing_sharp_fair numeric, clv_excluded_reason text, closing_source text, result text, ' +
  'closing_dec numeric, closing_at_observed timestamptz, clv numeric, beat_close boolean';
function sig(ev, sport, startMs, home, away, market, selection, point, fair, seenAgoMs, modal, extra) {
  const k = ev + '|' + market + '|' + selection + '|' + (point == null ? '' : String(point));
  const e = extra || {};
  V('insert into public.signals (sig_key, event_id, sport_key, commence_time, home_team, away_team, market, selection, point, sharp_fair, last_seen_at, point_is_modal, is_player_prop, flagged_at) values (' +
    [lit(k), lit(ev), lit(sport), at(startMs), lit(home), lit(away), lit(market), lit(selection), point == null ? 'null' : point,
     fair == null ? 'null' : fair, at(-(seenAgoMs || 10 * 60 * 1000)), modal ? 'true' : 'false', e.prop ? 'true' : 'false',
     e.flaggedAgoMs != null ? at(-e.flaggedAgoMs) : 'null'].join(', ') + ');');
  return k;
}
const logBet = (u, ev, market, side, line, odds, book, units, k) => JSON.parse(db.service('select public.bet_checker_log_bet(' +
  [lit(u), lit(ev), lit(market), lit(side), line == null ? 'null' : line, odds == null ? 'null' : odds, lit(book || 'DraftKings'),
   units == null ? 'null' : units, lit(k || key())].join(', ') + ');'));
const row = (id) => one('select * from public.user_bets where id = ' + lit(id));
const grade = () => JSON.parse(db.service('select public.bet_checker_grade_pending(500);'));
/* the clock moves past kickoff (the test's only device: kickoff is write-once) */
const kickoffPassed = (ids, agoMs) => {
  const ago = "now() - interval '" + Math.round((agoMs || H) / 1000) + " seconds'";
  V('set session_replication_role = replica; update public.user_bets set kickoff = ' + ago + ' where id in (' + ids.map(lit).join(',') + ');' +
    ' update public.signals set commence_time = ' + ago + ' where event_id in (select event_id from public.user_bets where id in (' + ids.map(lit).join(',') + '));' +
    ' set session_replication_role = default;');
};

try {
  /* ===================================================================== */
  /* 1. IT INSTALLS, AND SAYS WHAT IT NEEDS                                */
  /* ===================================================================== */
  const noDep = db.mustFail(() => db.applyFileAtomic(FILE));
  chk('without user_bets it stops and names bettor_decisions.sql', /bettor_decisions\.sql/.test(noDep || ''), noDep && noDep.slice(0, 200));
  V('create table public.signals (sig_key text primary key, closing_sharp_fair numeric, closing_dec numeric, closing_at_observed timestamptz, result text, clv numeric, beat_close boolean);');
  for (const f of ['bankroll_and_stakes.sql', 'bettor_decisions.sql', 'billing.sql', 'stripe_webhook.sql', 'billing_hardening.sql']) {
    db.applyFileAtomic(path.join(ROOT, 'supabase', f));
  }
  const thinBoard = db.mustFail(() => db.applyFileAtomic(FILE));
  chk('a board without the columns it reads: it stops and names them', /no column\(s\).*event_id/.test(thinBoard || ''), thinBoard && thinBoard.slice(0, 300));
  V('drop table public.signals cascade; create table public.signals (' + SIG_COLS + ');');
  V('insert into auth.users (id, email) values ' + [A, B, P, Q, C, Z].map((u, i) => '(' + lit(u) + ", 'u" + i + "@x.co')").join(', ') + ';');
  /* a bet the decision card recorded before Bet Checker existed */
  db.as(A, "insert into public.user_bets (bet_key, sport, game_id, side, odds, units, line) values ('card-1', 'CFB', '401866434', 'away', -110, 1, 5);");

  let out = db.applyFileAtomic(FILE);
  const rep = out.split('\n').filter((l) => /^\d\d /.test(l));
  chk('it applies over bettor_decisions.sql: eleven report rows, every one ok', rep.length === 11 && rep.every((l) => /\|ok/.test(l)), out.slice(-1200));
  out = db.applyFileAtomic(FILE);
  chk('and applies a second time, identically', out.split('\n').filter((l) => /^\d\d .*\|ok/.test(l)).length === 11);
  chk('the decision card\'s bet is untouched and is not a Bet Checker bet',
    one("select event_id, entry_grade, close_status, edgedesk_flagged from public.user_bets where bet_key = 'card-1'").event_id === null &&
    one("select count(*)::int as n from public.bet_checker_bets").n === 0);
  chk('the owner is a validated foreign key to auth.users', one("select convalidated from pg_constraint where conname = 'user_bets_user_fk'").convalidated === true);
  chk('the flagged signal is a foreign key to the board (its sig_key is unique)', !!one("select 1 as x from pg_constraint where conname = 'user_bets_flagged_signal_fk'"));

  /* ── the board ─────────────────────────────────────────────────────── */
  const NFL = 'americanfootball_nfl', CFB = 'americanfootball_ncaaf';
  const E1 = 'ev_nfl_1', E2 = 'ev_cfb_1', E3 = 'ev_started', E4 = 'ev_mlb';
  const T1 = 48 * H;
  const K = {};
  K.h35 = sig(E1, NFL, T1, 'Kansas City Chiefs', 'Buffalo Bills', 'spreads', 'Kansas City Chiefs', -3.5, 0.52, null, true);
  K.a35 = sig(E1, NFL, T1, 'Kansas City Chiefs', 'Buffalo Bills', 'spreads', 'Buffalo Bills', 3.5, 0.48, null, true);
  K.h3 = sig(E1, NFL, T1, 'Kansas City Chiefs', 'Buffalo Bills', 'spreads', 'Kansas City Chiefs', -3, 0.555, null, false);
  K.h45 = sig(E1, NFL, T1, 'Kansas City Chiefs', 'Buffalo Bills', 'spreads', 'Kansas City Chiefs', -4.5, 0.47, 10 * H, false);
  K.o = sig(E1, NFL, T1, 'Kansas City Chiefs', 'Buffalo Bills', 'totals', 'Over', 47.5, 0.5, null, true);
  K.u = sig(E1, NFL, T1, 'Kansas City Chiefs', 'Buffalo Bills', 'totals', 'Under', 47.5, 0.5, null, true);
  K.mh = sig(E1, NFL, T1, 'Kansas City Chiefs', 'Buffalo Bills', 'h2h', 'Kansas City Chiefs', null, 0.62, null, true, { flaggedAgoMs: H });
  K.ma = sig(E1, NFL, T1, 'Kansas City Chiefs', 'Buffalo Bills', 'h2h', 'Buffalo Bills', null, 0.38, null, true);
  sig(E1, NFL, T1, 'Kansas City Chiefs', 'Buffalo Bills', 'player_pass_yds', 'Over', 250.5, 0.5, null, true, { prop: true });
  K.c = sig(E2, CFB, 30 * H, 'Ohio State Buckeyes', 'Michigan Wolverines', 'spreads', 'Ohio State Buckeyes', -7, 0.5, null, true);
  sig(E2, CFB, 30 * H, 'Ohio State Buckeyes', 'Michigan Wolverines', 'spreads', 'Michigan Wolverines', 7, 0.5, null, true);
  sig(E3, NFL, -H, 'Dallas Cowboys', 'New York Giants', 'spreads', 'Dallas Cowboys', -6.5, 0.5, null, true);
  sig(E4, 'baseball_mlb', 20 * H, 'New York Yankees', 'Boston Red Sox', 'h2h', 'New York Yankees', null, 0.55, null, true);

  /* ===================================================================== */
  /* 2. THE PICKERS: identity and lines, never a price                     */
  /* ===================================================================== */
  const games = JSON.parse(db.as(A, 'select json_agg(g) from public.bet_checker_games(null) g;'));
  chk('upcoming NFL and college football games, and nothing else', games && games.map((g) => g.event_id).sort().join(',') === [E1, E2].sort().join(','), games);
  chk('a started game and a sport Bet Checker does not grade are not offered', !games.some((g) => g.event_id === E3 || g.event_id === E4));
  chk('the sport filter works', JSON.parse(db.as(A, "select json_agg(g) from public.bet_checker_games('cfb') g;")).map((g) => g.event_id).join() === E2);
  chk('anon gets nothing', !!db.mustFail(() => db.anon('select * from public.bet_checker_games(null);')));
  const lines = JSON.parse(db.as(A, 'select json_agg(l) from public.bet_checker_lines(' + lit(E1) + ') l;'));
  chk('every game line, as the reader names it, and no player prop',
    lines.length === 8 && lines.every((l) => ['spread', 'total', 'moneyline'].indexOf(l.market_type) >= 0), lines);
  chk('a line no price leaves through', lines.every((l) => Object.keys(l).sort().join() === 'line,market_type,modal,priced,side,team'));
  chk('priced says EdgeDesk has a CURRENT fair at that line (the stale -4.5 does not)',
    lines.find((l) => l.side === 'home' && l.line === -4.5).priced === false && lines.find((l) => l.side === 'home' && l.line === -3.5).priced === true);
  chk('a started game has no lines to pick', JSON.parse(db.as(A, 'select coalesce(json_agg(l), \'[]\') from public.bet_checker_lines(' + lit(E3) + ') l;')).length === 0);

  /* ===================================================================== */
  /* 3. LOGGING A BET, AND ITS GRADE                                       */
  /* ===================================================================== */
  chk('a reader cannot call the logger directly (only log_user_bet, as the service role, may)',
    /bet_checker_log_bet|permission denied/.test(db.mustFail(() => db.as(A, 'select public.bet_checker_log_bet(' + lit(A) + ", 'x', 'spread', 'home', -3, -110, 'DraftKings', 1, 'abcdefgh1');")) || ''));

  let r = logBet(B, E1, 'spread', 'home', -3.5, 105);
  let b1 = r.bet;
  chk('+105 on -3.5 against a 52% fair: edge +3.22 points, GREEN', r.ok && b1.entry_grade === 'green' && Number(b1.entry_edge_pct) === 3.22, r);
  chk('the fair is stored as American odds and as the probability, with where it came from',
    b1.entry_fair_price === -108 && Number(b1.entry_fair_prob) === 0.52 && b1.entry_sig_key === K.h35 && !!b1.entry_fair_seen_at, b1);
  chk('the bet maps to the board event, with the board\'s kickoff and teams',
    b1.event_id === E1 && b1.sport === 'NFL' && b1.team === 'Kansas City Chiefs' && b1.home_team === 'Kansas City Chiefs' && b1.close_status === 'pending', b1);
  chk('stake defaults to one unit', Number(b1.units) === 1);
  r = logBet(B, E1, 'spread', 'home', -3.5, -110);
  chk('-110 on the same line: edge -0.38, YELLOW', r.bet.entry_grade === 'yellow' && Number(r.bet.entry_edge_pct) === -0.38, r.bet);
  r = logBet(B, E1, 'spread', 'home', -3.5, -130);
  chk('-130: edge -4.52, RED', r.bet.entry_grade === 'red' && Number(r.bet.entry_edge_pct) === -4.52, r.bet);
  chk('the boundaries: +1.5 is green, -1.5 is red, just inside is yellow',
    V("select public.bet_checker_grade_of(1.5) || public.bet_checker_grade_of(1.49) || public.bet_checker_grade_of(-1.49) || public.bet_checker_grade_of(-1.5);") === 'greenyellowyellowred');
  r = logBet(B, E1, 'total', 'over', 47.5, 100);
  chk('a total: over 47.5 at +100 against 50% — edge 0, yellow', r.bet.entry_grade === 'yellow' && Number(r.bet.entry_edge_pct) === 0 && r.bet.team === null, r.bet);
  r = logBet(B, E1, 'moneyline', 'away', 7, 170, 'Kalshi');
  chk('a moneyline: the line is dropped, +170 vs 38% is +0.96, yellow, at Kalshi', r.bet.line === null && r.bet.entry_grade === 'yellow' && r.bet.book === 'Kalshi', r.bet);

  r = logBet(B, E1, 'spread', 'home', -2.5, -110);
  chk('a line EdgeDesk never priced: saved, UNGRADED, with the reason — never interpolated from -3',
    r.ok && r.bet.entry_grade === 'ungraded' && r.bet.entry_grade_reason === 'no_fair_price_at_line' && r.bet.entry_fair_price === null && r.bet.entry_edge_pct === null, r.bet);
  r = logBet(B, E1, 'spread', 'home', -4.5, -110);
  chk('a fair ten hours old is not "current": ungraded, fair_price_stale', r.bet.entry_grade === 'ungraded' && r.bet.entry_grade_reason === 'fair_price_stale' && r.bet.entry_fair_price === null, r.bet);
  chk('ungraded bets used no free grade', JSON.parse(db.service('select public.bet_checker_usage(' + lit(B) + ');')).free_grades_used === 5);

  const n0 = one('select count(*)::int as n from public.user_bets').n;
  chk('a game that has started is refused, and nothing is written', logBet(B, E3, 'spread', 'home', -6.5, -110).reason === 'game_started' && one('select count(*)::int as n from public.user_bets').n === n0);
  chk('a sport Bet Checker does not grade is refused', logBet(B, E4, 'moneyline', 'home', null, -120).reason === 'not_graded_sport');
  chk('a game that is not on the board is refused', logBet(B, 'ev_nowhere', 'spread', 'home', -3, -110).reason === 'no_such_game');
  chk('over on a spread is refused', logBet(B, E1, 'spread', 'over', -3.5, -110).reason === 'bad_input');
  chk('a spread with no line is refused', logBet(B, E1, 'spread', 'home', null, -110).reason === 'bad_input');
  chk('odds of -50 are refused', logBet(B, E1, 'spread', 'home', -3.5, -50).reason === 'bad_input');
  chk('a book that is not Kalshi, DK Predictions, DraftKings or Other is refused', logBet(B, E1, 'spread', 'home', -3.5, -110, 'FanDuel').reason === 'bad_input');
  chk('DK Predictions is a book', logBet(B, E2, 'spread', 'away', 7, -105, 'dk predictions').bet.book === 'DK Predictions');
  chk('nothing was written by a refusal', one('select count(*)::int as n from public.user_bets').n === n0 + 1);
  const k1 = key();
  const first = logBet(B, E2, 'spread', 'home', -7, -110, 'Other', 2, k1);
  const again = logBet(B, E2, 'spread', 'home', -7, -110, 'Other', 2, k1);
  chk('a double submit is ONE bet, answered again', again.replay === true && again.bet.id === first.bet.id &&
    one('select count(*)::int as n from public.user_bets where bet_key = ' + lit('bc:' + k1)).n === 1);

  /* ===================================================================== */
  /* 4. THE FREE ALLOWANCE                                                 */
  /* ===================================================================== */
  const ids = [];
  for (let i = 0; i < 10; i++) ids.push(logBet(A, E1, 'spread', 'away', 3.5, -110).bet.id);
  let u = JSON.parse(db.as(A, 'select public.bet_checker_usage();'));
  chk('ten graded bets: 10 of 10 free grades used, none left', u.free_grades_used === 10 && u.free_remaining === 0 && u.paid === false, u);
  r = logBet(A, E1, 'spread', 'away', 3.5, -110);
  chk('the eleventh is SAVED, ungraded, with an upgrade prompt', r.ok && r.upgrade === true && r.bet.entry_grade === 'ungraded' &&
    r.bet.entry_grade_reason === 'free_limit_reached' && !!row(r.bet.id), r);
  chk('and EdgeDesk\'s fair was not looked up for it: nothing for a free account to read back',
    r.bet.entry_fair_price === null && r.bet.entry_fair_prob === null && r.bet.entry_edge_pct === null && r.bet.entry_sig_key === null);
  chk('its CLV will still come after the close (free accounts get CLV)', r.bet.close_status === 'pending');
  db.as(A, 'delete from public.user_bets where id = ' + lit(ids[0]) + ';');
  chk('deleting a graded bet gives no grade back', JSON.parse(db.as(A, 'select public.bet_checker_usage();')).free_grades_used === 10 &&
    logBet(A, E1, 'spread', 'away', 3.5, -110).bet.entry_grade_reason === 'free_limit_reached');

  /* the last free grade, wanted twice at once */
  for (let i = 0; i < 9; i++) logBet(C, E1, 'spread', 'away', 3.5, -110);
  const race = [0, 1].map(() => db.background("set role service_role; select public.bet_checker_log_bet(" + lit(C) + ", " + lit(E1) +
    ", 'spread', 'away', 3.5, -110, 'DraftKings', 1, " + lit(key()) + ") ->> 'upgrade';"));
  const outs = race.map((x) => x.wait(30000));
  chk('two submits racing for the tenth grade: exactly one gets it',
    outs.every((o) => o.code === 0) && JSON.parse(db.service('select public.bet_checker_usage(' + lit(C) + ');')).free_grades_used === 10 &&
    outs.map((o) => o.out.trim()).sort().join() === 'false,true', outs);

  /* paid: Bet Checker (red) and the terminal (blue) */
  db.service("select public.billing_learn_price_tier('price_red_t', 'prod_bc', 'red', 'bet_checker_monthly', true, 'test');");
  db.service("select public.billing_learn_price_tier('price_blue_t', 'prod_ed', 'blue', null, true, 'test');");
  V("insert into public.subscriptions (user_id, status, price_id, current_period_end) values (" + lit(P) + ", 'active', 'price_red_t', now() + interval '20 days'), (" +
    lit(Q) + ", 'active', 'price_blue_t', now() + interval '20 days');");
  for (let i = 0; i < 12; i++) logBet(P, E1, 'spread', 'home', -3.5, 105);
  u = JSON.parse(db.service('select public.bet_checker_usage(' + lit(P) + ');'));
  chk('Bet Checker (red): twelve bets, twelve grades, no allowance', u.paid === true && u.graded_this_month === 12 && u.free_remaining === null, u);
  chk('the terminal (blue) is paid Bet Checker too', JSON.parse(db.service('select public.bet_checker_usage(' + lit(Q) + ');')).paid === true);
  chk('a calendar month is New York\'s: 03:00 UTC on 1 November is still October',
    V("select public.bet_checker_month_start('2026-11-01 03:00:00+00');") === '2026-10-01' && V("select public.bet_checker_month_start('2026-11-01 05:00:00+00');") === '2026-11-01');
  chk('a reader may read only their own allowance', !!db.mustFail(() => db.as(A, 'select public.bet_checker_usage(' + lit(B) + ');')));

  /* ===================================================================== */
  /* 5. EVERY READER'S BETS ARE THEIR OWN, AND UNGRADED BY THEM            */
  /* ===================================================================== */
  const aRow = ids[1];
  chk('reader B sees none of A\'s bets, in the table or the view',
    db.as(B, 'select count(*) from public.user_bets where user_id = ' + lit(A) + ';') === '0' &&
    db.as(B, 'select count(*) from public.bet_checker_bets where user_id = ' + lit(A) + ';') === '0');
  chk('reader B\'s own list holds only B\'s bets', JSON.parse(db.as(B, 'select public.my_bet_checker_bets();')).bets.every((x) => x.user_id === B));
  chk('reader B cannot void A\'s bet (no row matches)', (db.as(B, "update public.user_bets set status = 'void' where id = " + lit(aRow) + ';'), row(aRow).status === 'open'));
  chk('reader B cannot delete A\'s bet', (db.as(B, 'delete from public.user_bets where id = ' + lit(aRow) + ';'), !!row(aRow)));
  chk('anon reads no bet: no privilege on the table or the view',
    /permission denied/.test(db.mustFail(() => db.anon('select count(*) from public.user_bets;')) || '') &&
    /permission denied/.test(db.mustFail(() => db.anon('select * from public.bet_checker_bets;')) || ''));
  chk('a reader cannot pose as the service role inside a definer function',
    !!db.mustFail(() => db.as(A, "select public.bet_checker_usage('" + B + "');")) && db.as(A, 'select public.bet_checker_trusted();') === 'f');
  chk('A cannot grade A\'s own bet: entry_grade is the service role\'s',
    /permission denied/.test(db.mustFail(() => db.as(A, "update public.user_bets set entry_grade = 'green' where id = " + lit(aRow) + ';')) || ''));
  chk('nor CLV, the close, the result or the flag',
    ['clv_pct = 5', "close_status = 'captured'", "result = 'win'", 'edgedesk_flagged = true', 'entry_fair_price = -200']
      .every((set) => /permission denied/.test(db.mustFail(() => db.as(A, 'update public.user_bets set ' + set + ' where id = ' + lit(aRow) + ';')) || '')));
  chk('A cannot change the bet itself after logging (write-once, bettor_decisions.sql)',
    !!db.mustFail(() => db.as(A, 'update public.user_bets set odds = 200 where id = ' + lit(aRow) + ';')));
  chk('A may void it (notes and status are the reader\'s)', (db.as(A, "update public.user_bets set status = 'void', notes = 'wrong slip' where id = " + lit(aRow) + ';'), row(aRow).status === 'void'));
  db.as(A, "update public.user_bets set status = 'open' where id = " + lit(aRow) + ';');
  db.as(A, `insert into public.user_bets (bet_key, sport, game_id, event_id, market_type, side, line, odds, units, book, entry_grade, entry_fair_price, entry_edge_pct, close_status, clv_pct, result, edgedesk_flagged)
            values ('direct-1', 'NFL', 'x', ${lit(E1)}, 'spread', 'home', -3.5, 300, 1, 'DraftKings', 'green', -900, 40, 'captured', 50, 'win', true);`);
  const d = one("select * from public.user_bets where bet_key = 'direct-1'");
  chk('a reader\'s direct insert arrives with NO grade, whatever it claimed', d.entry_grade === 'ungraded' && d.entry_grade_reason === 'not_logged_through_bet_checker' &&
    d.entry_fair_price === null && d.entry_edge_pct === null && d.close_status === 'pending' && d.clv_pct === null && d.result === null && d.edgedesk_flagged === false, d);
  chk('and with the board\'s kickoff and teams, not its own', d.home_team === 'Kansas City Chiefs' && d.kickoff !== null && d.game_id === 'x');
  chk('a direct insert on a started game is refused', !!db.mustFail(() => db.as(A, `insert into public.user_bets (bet_key, sport, game_id, event_id, side, odds, units) values ('direct-2', 'NFL', 'x', ${lit(E3)}, 'home', -110, 1);`)));
  chk('a direct insert naming no board event is refused', !!db.mustFail(() => db.as(A, `insert into public.user_bets (bet_key, sport, game_id, event_id, side, odds, units) values ('direct-3', 'NFL', 'x', 'ev_nowhere', 'home', -110, 1);`)));
  chk('a direct insert naming the wrong sport is refused', !!db.mustFail(() => db.as(A, `insert into public.user_bets (bet_key, sport, game_id, event_id, side, odds, units) values ('direct-4', 'CFB', 'x', ${lit(E1)}, 'home', -110, 1);`)));
  chk('a reader cannot write the free-grade ledger', !!db.mustFail(() => db.as(A, "insert into public.bet_checker_grades (user_id, month_start, paid, grade) values (" + lit(A) + ", current_date, true, 'green');")));
  db.as(A, "delete from public.user_bets where bet_key = 'direct-1';");

  /* ===================================================================== */
  /* 6. AFTER THE CLOSE                                                    */
  /* ===================================================================== */
  /* Z's bets, one per case, logged before kickoff */
  const zg = logBet(Z, E1, 'spread', 'home', -3.5, 105).bet.id;    // closes at its line: CLV
  const zalt = logBet(Z, E1, 'spread', 'home', -3, -110).bet.id;   // alt line the market closed off
  const znp = logBet(Z, E1, 'spread', 'home', -2.5, -110).bet.id;  // never priced
  const zo = logBet(Z, E1, 'total', 'over', 47.5, -105).bet.id;    // close excluded: no_entry_price (still a close)
  const zu = logBet(Z, E1, 'total', 'under', 47.5, -105).bet.id;   // closes, no reference: no close
  const zm = logBet(Z, E1, 'moneyline', 'home', null, -150).bet.id;// flagged before logging
  const zma = logBet(Z, E1, 'moneyline', 'away', null, 140).bet.id;
  const zc = logBet(Z, E2, 'spread', 'home', -7, -110).bet.id;     // CFB: never closes
  V('update public.signals set flagged_at = now() + interval \'1 minute\' where sig_key = ' + lit(K.ma) + ';');  // flagged AFTER the bet

  let g = grade();
  chk('before kickoff the grader leaves every bet alone', g.bets_seen === 0 && row(zm).flag_checked_at === null && row(zm).edgedesk_flagged === false, g);
  chk('and the flag is not readable before the game starts', row(zm).edgedesk_flagged === false && row(zm).flagged_signal_id === null);

  /* close runs */
  V(`update public.signals set closed_at = now(), closing_sharp_fair = 0.55, clv_excluded_reason = null, closing_source = 'live' where sig_key = ${lit(K.h35)};
     update public.signals set closed_at = now(), closing_sharp_fair = 0.45, clv_excluded_reason = null, closing_source = 'live' where sig_key = ${lit(K.a35)};
     update public.signals set closed_at = now(), closing_sharp_fair = null, clv_excluded_reason = 'line_pulled_no_close', closing_source = 'none' where sig_key in (${lit(K.h3)}, ${lit(K.h45)});
     update public.signals set closed_at = now(), closing_sharp_fair = 0.52, clv_excluded_reason = 'no_entry_price', closing_source = 'live' where sig_key = ${lit(K.o)};
     update public.signals set closed_at = now(), closing_sharp_fair = null, clv_excluded_reason = 'no_close_reference', closing_source = 'live' where sig_key = ${lit(K.u)};
     update public.signals set closed_at = now(), closing_sharp_fair = 0.64, clv_excluded_reason = null, closing_source = 'live' where sig_key = ${lit(K.mh)};
     update public.signals set closed_at = now(), closing_sharp_fair = 0.36, clv_excluded_reason = null, closing_source = 'live' where sig_key = ${lit(K.ma)};`);
  kickoffPassed([zg, zalt, znp, zo, zu, zm, zma, zc]);
  g = grade();
  let x = row(zg);
  chk('closed at the bet\'s own line: CAPTURED, CLV = 2.05 x 0.55 - 1 = +12.75%', x.close_status === 'captured' && Number(x.clv_pct) === 12.75 &&
    Number(x.close_line) === -3.5 && Number(x.close_fair_prob) === 0.55 && Number(x.close_odds) === -122, x);
  x = row(zalt);
  chk('the market closed at -3.5, the bet was -3: NO CLOSE AVAILABLE — not adjusted, not estimated',
    x.close_status === 'no_close_available' && x.close_reason === 'line_pulled_no_close' && x.clv_pct === null && x.close_odds === null, x);
  chk('and the card can say where it did close', Number(x.close_line) === -3.5);
  x = row(znp);
  chk('a line EdgeDesk never priced: no close available, said honestly', x.close_status === 'no_close_available' && x.close_reason === 'line_not_on_board_at_close' && x.clv_pct === null, x);
  x = row(zo);
  chk('close\'s no_entry_price is about the SIGNAL\'s entry, not the close: the reader still gets CLV', x.close_status === 'captured' && Number(x.clv_pct) === round2((1 + 100 / 105) * 0.52 - 1), x);
  x = row(zu);
  chk('a close with no reference: no close available, with close\'s own reason', x.close_status === 'no_close_available' && x.close_reason === 'no_close_reference' && x.clv_pct === null, x);
  chk('a game whose close has not run stays pending, for now', row(zc).close_status === 'pending');
  chk('the flag, once the game has started: flagged BEFORE the bet was logged', row(zm).edgedesk_flagged === true && row(zm).flagged_signal_id === K.mh && !!row(zm).flag_checked_at);
  chk('a signal flagged AFTER the bet was logged does not count', row(zma).edgedesk_flagged === false && !!row(zma).flag_checked_at);
  chk('no result before settlement', row(zg).result === null);

  /* settlement: settle's word on the same board row (signal_pnl.sql's reader of it) */
  const pnl = fs.readFileSync(path.join(ROOT, 'supabase', 'signal_pnl.sql'), 'utf8');
  const pnlFn = /create or replace function public\.pnl_result\(p text\)[\s\S]*?\$f\$;/.exec(pnl)[0];
  V(pnlFn);
  V(`update public.signals set result = 'won' where sig_key = ${lit(K.h35)}; update public.signals set result = 'won' where sig_key = ${lit(K.mh)};`);
  /* the Collective's football settlement, for the rest */
  const fg2 = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '20260928120000_football_grading_v2.sql'), 'utf8');
  V('create schema if not exists collective; ' + /create or replace function collective\.fg2_game_state[\s\S]*?\$fn\$;/.exec(fg2)[0] +
    ' create table collective.fg2_event_links (source text, source_event_id text, status text, canonical_game_id text, orientation text);' +
    ' create table collective.fg2_src_games (game_id text, status text, home_score numeric, away_score numeric);' +
    " insert into collective.fg2_event_links values ('edgedesk_capture', " + lit(E1) + ", 'linked', 'g_kc_buf', 'swapped');" +
    " insert into collective.fg2_src_games values ('g_kc_buf', 'final', 20, 27);");   // canonical home = BUF 20, away = KC 27 (swapped)
  g = grade();
  x = row(zg);
  chk('settle said "won" on that row: a WIN, from settle, paying 1.05 units', x.result === 'win' && x.result_source === 'settle' && Number(x.units_won) === 1.05 && !!x.graded_at, x);
  chk('settle said "won" on the moneyline row: a WIN at -150 pays 0.6667 units', row(zm).result === 'win' && Number(row(zm).units_won) === 0.6667 && row(zm).result_source === 'settle');
  x = row(zalt);
  chk('no settle word at -3: the FINAL SCORE grades it (KC 27-20, -3 covers), orientation turned', x.result === 'win' && x.result_source === 'final_score', x);
  chk('over 47.5 with 47 points: a loss', row(zo).result === 'loss');
  chk('under 47.5 with 47 points: a win', row(zu).result === 'win');
  chk('Buffalo on the moneyline: a loss', row(zma).result === 'loss');
  chk('a game with no final yet has no result', row(zc).result === null);

  /* a second run changes nothing */
  const snap = J('select * from public.user_bets where user_id = ' + lit(Z) + ' order by id');
  g = grade();
  const snap2 = J('select * from public.user_bets where user_id = ' + lit(Z) + ' order by id');
  const strip = (rows) => JSON.stringify(rows.map((q) => Object.assign({}, q, { close_checked_at: null, updated_at: null })));
  chk('a second run changes nothing it has already written (idempotent)', strip(snap) === strip(snap2), g);
  chk('the grader is the service role\'s', !!db.mustFail(() => db.as(Z, "select public.bet_checker_grade_pending(10, 'test');")));
  chk('every run is on record, and no reader can read the log', Number(V('select count(*) from public.bet_checker_grade_runs where ok;')) >= 4 &&
    !!db.mustFail(() => db.as(Z, 'select * from public.bet_checker_grade_runs;')));

  /* no close, a day after kickoff */
  kickoffPassed([zc], 25 * H);
  grade();
  chk('nothing closed a day after kickoff: no close available (no_close_captured)', row(zc).close_status === 'no_close_available' && row(zc).close_reason === 'no_close_captured');
  V("update collective.fg2_src_games set status = 'cancelled', home_score = null, away_score = null;");
  V("insert into collective.fg2_event_links values ('edgedesk_capture', " + lit(E2) + ", 'linked', 'g_osu', 'same'); insert into collective.fg2_src_games values ('g_osu', 'Canceled', null, null);");
  grade();
  chk('a cancelled game is void, 0 units', row(zc).result === 'void' && Number(row(zc).units_won) === 0);

  /* ===================================================================== */
  /* 7. WHAT THE READER SEES                                               */
  /* ===================================================================== */
  chk('the view speaks Bet Checker: market, stake_units, closing_price, closing_line, result pending',
    (() => { const v = JSON.parse(db.as(Z, 'select row_to_json(v) from public.bet_checker_bets v where id = ' + lit(zg) + ';'));
      return v.market === 'spread' && Number(v.stake_units) === 1 && v.closing_price === -122 && Number(v.closing_line) === -3.5 && v.result === 'win'; })());
  chk('a free reader\'s stats are locked, with no number in the answer', db.as(A, 'select public.my_bet_checker_stats()::text;') === '{"paid": false}');
  const st = JSON.parse(db.as(P, 'select public.my_bet_checker_stats();'));
  chk('a Bet Checker (red) reader gets the stats', st.paid === true && st.overall.bets === 12 && st.overall.graded === 12 && Number(st.overall.avg_entry_edge_pct) === 3.22, st.overall);
  chk('and the splits by market, sport and book', st.by_market.length === 1 && st.by_market[0].val === 'spread' && st.by_sport[0].val === 'NFL' && st.by_book[0].val === 'DraftKings');
  /* Z, made paid, to check the close numbers */
  V("insert into public.subscriptions (user_id, status, price_id, current_period_end) values (" + lit(Z) + ", 'trialing', 'price_blue_t', now() + interval '5 days');");
  const sz = JSON.parse(db.as(Z, 'select public.my_bet_checker_stats();')).overall;
  const caps = J('select clv_pct from public.user_bets where user_id = ' + lit(Z) + " and close_status = 'captured'").map((q) => Number(q.clv_pct));
  chk('CLV rate is the share of captured closes beaten, average CLV their mean',
    sz.clv_bets === caps.length && Number(sz.clv_rate_pct) === round1(100 * caps.filter((c) => c > 0).length / caps.length) &&
    Number(sz.avg_clv_pct) === Math.round(caps.reduce((a, c) => a + Math.round(c * 100), 0) / caps.length) / 100 && sz.no_close === 4 && caps.length === 4, [sz, caps]);
  chk('wins, losses and pushes come from the results (the void is none of them)', sz.wins === 5 && sz.losses === 2 && sz.pushes === 0, sz);

  /* history: free is 30 days */
  V("set session_replication_role = replica; update public.user_bets set placed_at = now() - interval '40 days' where id = " + lit(ids[2]) + "; set session_replication_role = default;");
  const ha = JSON.parse(db.as(A, 'select public.my_bet_checker_bets();'));
  chk('a free reader\'s list is the last 30 days, and says older bets exist', ha.paid === false && ha.history_days === 30 && ha.older_hidden === true &&
    !ha.bets.some((x) => x.id === ids[2]), ha.bets.length);
  chk('the usage line rides along ("X of 10 grades used this month")', ha.usage.free_grades_used === 10 && ha.usage.free_limit === 10);
  V("set session_replication_role = replica; update public.user_bets set placed_at = now() - interval '40 days' where user_id = " + lit(P) + " and id in (select id from public.user_bets where user_id = " + lit(P) + " limit 1); set session_replication_role = default;");
  const hp = JSON.parse(db.as(P, 'select public.my_bet_checker_bets();'));
  chk('a paid reader\'s list is the full history', hp.paid === true && hp.history_days === null && hp.bets.length === 12);

  /* ===================================================================== */
  /* 8. THE SCHEDULE: after the close, with the secret from Vault          */
  /* ===================================================================== */
  const CRON = path.join(ROOT, 'supabase', 'bet_checker_cron.sql');
  chk('the cron file never writes the service-role key into a job', !/service_role_key|Bearer\s/i.test(fs.readFileSync(CRON, 'utf8')));
  V(`create schema if not exists cron; create schema if not exists net;
    create table if not exists cron.job (jobid bigserial primary key, jobname text, schedule text, command text, active boolean default true);
    create or replace function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job (jobname, schedule, command) values (n, s, c) returning jobid $$;
    create or replace function cron.unschedule(j bigint) returns boolean language sql as $$ delete from cron.job where jobid = j returning true $$;
    create schema if not exists vault; create table if not exists vault.decrypted_secrets (name text, decrypted_secret text);
    create table if not exists net.calls (url text, body jsonb, headers jsonb);
    create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 5000) returns bigint language sql as $$ insert into net.calls values (url, body, headers); select 1::bigint $$;`);
  let cout = db.applyFile(CRON);
  chk('cron: scheduled every fifteen minutes; the report says what is missing (no close job here, no secret)',
    /1 grade_user_bets is scheduled every fifteen minutes\|ok/.test(cout) && /2 the close job it follows.*CHECK THIS/.test(cout) && /3 Vault.*CHECK THIS/.test(cout), cout);
  chk('cron: without the Vault secret nothing is sent, and the run log says so',
    JSON.parse(V('select public.bet_checker_grade_poke();')).queued === false && V('select count(*) from net.calls;') === '0' &&
    V("select count(*) from public.bet_checker_grade_runs where not ok and result ->> 'error' = 'no_cron_secret';") === '1');
  V("insert into vault.decrypted_secrets values ('bet_checker_cron_secret', 's3cret'); select cron.schedule('close_poke', '*/15 * * * *', $c$ select net.http_post(url := 'https://x.supabase.co/functions/v1/close') $c$);");
  cout = db.applyFile(CRON);
  chk('cron: applied again, one job, and the report names the close job it follows',
    V("select count(*) from cron.job where jobname = 'bet_checker_grade';") === '1' && !/CHECK THIS/.test(cout) && /close_poke \*\/15/.test(cout), cout);
  V('select public.bet_checker_grade_poke();');
  const call = one('select url, headers from net.calls');
  chk('cron: the poke calls grade_user_bets with x-cron-secret, and no JWT', /\/functions\/v1\/grade_user_bets$/.test(call.url) &&
    call.headers['x-cron-secret'] === 's3cret' && !call.headers.authorization, call);
  chk('cron: no reader can poke it', !!db.mustFail(() => db.as(A, 'select public.bet_checker_grade_poke();')));
} catch (e) {
  chk('the suite ran to the end', false, String(e && e.stack || e).slice(0, 1500));
} finally {
  db.stop();
}

/* ===================================================================== */
/* PRODUCTION'S BOARD, BEFORE CAPTURE V11: NO is_player_prop COLUMN       */
/* ===================================================================== */
/* Deploy Bet Checker (2026-10-28) stopped at the guard: production's signals had never had
   capture_v11_player_props.sql applied. Props live under player_* markets, which nothing here reads. */
const db10 = PG.start('betchk10');
try {
  db10.sql('create table public.signals (' + SIG_COLS.replace(' is_player_prop boolean not null default false,', '') + ');');
  for (const f of ['bankroll_and_stakes.sql', 'bettor_decisions.sql', 'billing.sql', 'stripe_webhook.sql', 'billing_hardening.sql']) {
    db10.applyFileAtomic(path.join(ROOT, 'supabase', f));
  }
  chk('production\'s board shape: signals has no is_player_prop', db10.sql("select count(*) from information_schema.columns where table_name = 'signals' and column_name = 'is_player_prop';") === '0');
  const out10 = db10.applyFileAtomic(FILE);
  const rep10 = out10.split('\n').filter((l) => /^\d\d /.test(l));
  chk('it applies on a board capture v11 never touched: eleven report rows, every one ok', rep10.length === 11 && rep10.every((l) => /\|ok/.test(l)), out10.slice(-800));
  db10.sql("insert into public.signals (sig_key, event_id, sport_key, commence_time, home_team, away_team, market, selection, point, sharp_fair, last_seen_at, point_is_modal) values " +
    "('ev10|spreads|Kansas City Chiefs|-3.5', 'ev10', 'americanfootball_nfl', now() + interval '2 days', 'Kansas City Chiefs', 'Buffalo Bills', 'spreads', 'Kansas City Chiefs', -3.5, 0.52, now(), true), " +
    "('ev10|player_pass_yds|Over|250.5', 'ev10', 'americanfootball_nfl', now() + interval '2 days', 'Kansas City Chiefs', 'Buffalo Bills', 'player_pass_yds', 'Over', 250.5, 0.5, now(), true);");
  const lines10 = JSON.parse(db10.service("select coalesce(json_agg(t), '[]'::json) from public.bet_checker_lines('ev10') t;") || '[]');
  chk('  ... and its pickers list the game line, never the prop', lines10.length === 1 && lines10[0].market_type === 'spread', lines10);
} catch (e) {
  chk('the pre-v11 board check ran to the end', false, String(e && e.stack || e).split('\n').filter((l) => /ERROR|Error:/.test(l)).slice(0, 4).join(' | '));
} finally {
  db10.stop();
}
function round2(v) { return Math.round(v * 10000) / 100; }
function round1(v) { return Math.round(v * 10) / 10; }
process.exit(T.done());
