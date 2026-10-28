#!/usr/bin/env node
/* ===========================================================================
   lib/edgedesk_bet_checker_core.js — the page's arithmetic and words.

   The grade is the database's (supabase/bet_checker.sql); this module only
   says what it decided. Checked here: the odds arithmetic agrees with the
   SQL's (the same numbers bet_checker_sql.test.js asserts), every reason the
   database can give has a sentence, an ungraded bet never shows a number, a
   missing close is said out loud, and the form refuses what the server would.

   Run: node tools/bet_checker/core.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const C = require(path.join(ROOT, 'lib', 'edgedesk_bet_checker_core.js'));

let pass = 0, fail = 0;
function chk(name, ok, detail) { if (ok) pass++; else { fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 300) : '')); } }
const near = (a, b) => Math.abs(a - b) < 1e-9;

/* ── odds ──────────────────────────────────────────────────────────────── */
chk('+105 implies 48.78%', near(C.americanToProb(105), 100 / 205));
chk('-110 implies 52.38%', near(C.americanToProb(-110), 110 / 210));
chk('odds between -100 and +100 imply nothing', C.americanToProb(50) === null && C.americanToProb(-99) === null && C.americanToProb('x') === null);
chk('decimals: +105 -> 2.05, -150 -> 1.6667', near(C.americanToDecimal(105), 2.05) && near(C.americanToDecimal(-150), 1 + 100 / 150));
chk('a 52% fair is -108, a 55% close -122 (the SQL\'s bet_checker_prob_to_american)', C.probToAmerican(0.52) === -108 && C.probToAmerican(0.55) === -122);
chk('a 38% fair is +163', C.probToAmerican(0.38) === 163);
chk('a 55¢ prediction-market price is -122 American; 40¢ is +150', C.centsToAmerican(55) === -122 && C.centsToAmerican(40) === 150);
chk('a price of 0¢ or 100¢ is not a price', C.centsToAmerican(0) === null && C.centsToAmerican(100) === null);
chk('the edge the SQL computes for +105 vs 52% is 3.22 points', Math.round((0.52 - C.americanToProb(105)) * 10000) / 100 === 3.22);

/* ── words ─────────────────────────────────────────────────────────────── */
chk('odds print with their sign', C.fmtOdds(105) === '+105' && C.fmtOdds(-110) === '-110' && C.fmtOdds(null) === '—');
chk('a spread line prints its sign; a total does not', C.fmtLine('spread', -3.5) === '−3.5' && C.fmtLine('spread', 7) === '+7' && C.fmtLine('total', 47.5) === '47.5' && C.fmtLine('moneyline', 3) === '');
const bet = { market: 'spread', side: 'home', line: -3.5, odds: 105, team: 'Kansas City Chiefs', home_team: 'Kansas City Chiefs', away_team: 'Buffalo Bills' };
chk('the side as a reader names it', C.sideLabel(bet) === 'Kansas City Chiefs −3.5' && C.sideLabel({ market: 'total', side: 'under', line: 47.5 }) === 'Under 47.5' &&
  C.sideLabel({ market: 'moneyline', side: 'away', away_team: 'Buffalo Bills' }) === 'Buffalo Bills ML');
chk('the game', C.betTitle(bet) === 'Buffalo Bills at Kansas City Chiefs');

let g = C.gradeView(Object.assign({}, bet, { entry_grade: 'green', entry_edge_pct: 3.22, entry_fair_price: -108 }));
chk('a green grade: label, edge and fair', g.cls === 'green' && g.label === 'Beat fair' && g.edge === '+3.22 pts' && g.fair === '-108' && /\+105 vs EdgeDesk fair -108/.test(g.sentence), g);
chk('a red grade', C.gradeView({ entry_grade: 'red', entry_edge_pct: -4.52, entry_fair_price: -108, odds: -130 }).label === 'Below fair');
chk('a yellow grade', C.gradeView({ entry_grade: 'yellow', entry_edge_pct: -0.38 }).cls === 'yellow');
['no_fair_price_at_line', 'fair_price_stale', 'free_limit_reached', 'not_logged_through_bet_checker'].forEach((why) => {
  const v = C.gradeView({ entry_grade: 'ungraded', entry_grade_reason: why, entry_edge_pct: null, entry_fair_price: null });
  chk('ungraded (' + why + '): a sentence, and no number at all', v.cls === 'ungraded' && v.edge === null && v.fair === null && v.sentence === C.ENTRY_REASONS[why]);
});
chk('no fair at the line says it is never estimated', /never estimate/.test(C.ENTRY_REASONS.no_fair_price_at_line));
chk('the free limit says CLV still comes', /CLV still arrives/.test(C.ENTRY_REASONS.free_limit_reached));

/* every reason bet_checker.sql writes has its sentence */
const SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'bet_checker.sql'), 'utf8');
const entryReasons = [...SQL.matchAll(/v_reason := '([a-z_]+)'/g)].map((m) => m[1]).concat(['not_logged_through_bet_checker']);
chk('every entry reason the SQL can write has a sentence', entryReasons.length >= 3 && entryReasons.every((r) => C.ENTRY_REASONS[r]), entryReasons.filter((r) => !C.ENTRY_REASONS[r]));
const closeReasons = [...SQL.matchAll(/close_reason = '([a-z_]+)'/g)].map((m) => m[1]);
const closeTs = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'close', 'index.ts'), 'utf8');
const closeOwn = [...closeTs.matchAll(/reason: "([a-z_]+)"/g)].map((m) => m[1]).filter((r) => r !== 'no_entry_price');
chk('every close reason (Bet Checker\'s and close/index.ts\'s own) has a sentence', closeReasons.concat(closeOwn).every((r) => C.CLOSE_REASONS[r]),
  closeReasons.concat(closeOwn).filter((r) => !C.CLOSE_REASONS[r]));

let cl = C.closeView(Object.assign({}, bet, { close_status: 'captured', clv_pct: 12.75, closing_price: -122 }));
chk('a captured close: CLV, the no-vig closing price, at the bet\'s own line', cl.cls === 'beat' && cl.label === 'CLV +12.75%' && /Closed -122 \(no-vig\) at your line −3\.5/.test(cl.sentence), cl);
chk('a negative CLV is said so', C.closeView({ close_status: 'captured', clv_pct: -13.6, market: 'moneyline' }).cls === 'lost');
cl = C.closeView(Object.assign({}, bet, { line: -3, close_status: 'no_close_available', close_reason: 'line_pulled_no_close', closing_line: -3.5 }));
chk('NO CLOSE AVAILABLE is shown, with why and where the market did close', cl.label === 'No close available' && /different line/.test(cl.sentence) && /closed at −3\.5/.test(cl.sentence), cl);
chk('pending says when', C.closeView({ close_status: 'pending' }).label === 'CLV after the close');

chk('results', C.resultView({ result: 'win', units_won: 1.05 }).label === 'Won' && C.resultView({ result: 'pending' }).label === 'Pending' && C.resultView({}).label === 'Pending');
chk('"X of 10 grades used this month"', C.usageLine({ paid: false, free_grades_used: 3, free_limit: 10 }) === '3 of 10 grades used this month' &&
  C.usageLine({ paid: false, free_grades_used: 10, free_limit: 10 }) === '10 of 10 grades used this month' && C.usageLine({ paid: true }) === 'Unlimited grades');
const L = C.legend({ green_min_edge_pct: 1.5, red_max_edge_pct: -1.5 });
chk('the legend is built from the database\'s rules, not written here', L && /1\.5 points/.test(L.green) && /1\.5 points or more worse/.test(L.red) && C.legend(null) === null);
const CORE = fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_bet_checker_core.js'), 'utf8');
chk('the thresholds are not a constant in the page (bet_checker_rules() is the one constant)', !/1\.5/.test(CORE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));

/* ── the form ──────────────────────────────────────────────────────────── */
const ok = C.check({ event_id: 'ev1', market: 'spread', side: 'home', line: '-3.5', odds: '105', book: 'DraftKings', stake_units: '' });
chk('a whole bet passes, stake defaulting to one unit', ok.ok && ok.bet.line === -3.5 && ok.bet.odds === 105 && ok.bet.stake_units === 1, ok);
chk('a moneyline drops its line', C.check({ event_id: 'e', market: 'moneyline', side: 'away', line: '3', odds: '150', book: 'Kalshi' }).bet.line === null);
[[{ event_id: '' }, 'game'], [{ market: 'teaser' }, 'market'], [{ side: 'over' }, 'side'], [{ line: '' }, 'line'], [{ odds: '-50' }, 'odds'],
 [{ odds: '-110.5' }, 'odds'], [{ book: 'FanDuel' }, 'book'], [{ stake_units: '0' }, 'stake'], [{ stake_units: '101' }, 'stake']].forEach(([bad, f]) => {
  const r = C.check(Object.assign({ event_id: 'ev1', market: 'spread', side: 'home', line: '-3.5', odds: '-110', book: 'DraftKings', stake_units: '1' }, bad));
  chk('the form refuses a bad ' + f, !r.ok && r.field === f && r.message.length > 5, r);
});
chk('the books are the four the database accepts', JSON.stringify(C.BOOKS.slice().sort()) === JSON.stringify(['DK Predictions', 'DraftKings', 'Kalshi', 'Other']) &&
  /'Kalshi', 'DK Predictions', 'DraftKings', 'Other'/.test(SQL));
const k1 = C.newClientKey(), k2 = C.newClientKey();
chk('a client key is what log_user_bet accepts, and new each time', /^[A-Za-z0-9_-]{8,64}$/.test(k1) && k1 !== k2);
chk('a stats row prints its numbers', JSON.stringify(C.statRow({ val: 'spread', bets: 4, graded: 3, clv_rate_pct: 75, avg_entry_edge_pct: -0.02, avg_clv_pct: 1.84, clv_bets: 4 })) ===
  JSON.stringify({ label: 'spread', bets: 4, graded: 3, clv_rate: '75%', avg_edge: '−0.02 pts', avg_clv: '+1.84%', clv_bets: 4 }));

console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'bet checker core — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
