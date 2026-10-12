#!/usr/bin/env node
/* ===========================================================================
   THE QUANT DESK KERNEL (_quant.js, EDQUANT) — routing and the deterministic
   answers, without the host.

   Every assertion is about an answer a reader would be misled by: a
   cross-sport question answered from one sport, "best across all sports"
   printed over a partial scan, a candidate the decision layer withheld
   promoted to BUY, a contract price read as a spread, a carried state that
   smuggles in a number, or prose that adds certainty.

   Run: node tools/intelligence/quant.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const FN = path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai');
require(path.join(FN, '_intelligence.js'));
const F = require(path.join(ROOT, 'lib', 'edgedesk_fairodds.js'));
require(path.join(ROOT, 'lib', 'edgedesk_sport_adapters.js'));
const Q = require(path.join(FN, '_quant.js'));
const B = require(path.join(FN, '_board.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function eq(name, a, b) { chk(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b }); }
function done() {
  failures.forEach((f) => console.log('FAIL | ' + f.name + '  ' + String(JSON.stringify(f.detail)).slice(0, 500)));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}
const intent = (q, o) => Q.classify(q, o).intent;

/* ═══ 1. ROUTING — the brief's questions ════════════════════════════════ */
{
  const SCAN = ["What's the best bet tonight?", 'Find the biggest positive-EV opportunity across all sports.', "What's the best bet right now?", "What's the best moneyline underdog this weekend?",
    "What's the best bet available in the next 24 hours across all supported sports?", "What's the best available underdog?", 'Which games are most likely to go under?', "What's the best market line value today?", 'Best bets tonight.'];
  SCAN.forEach((q) => eq('SCAN: ' + q, intent(q), 'SCAN'));
  eq('"the best NFL bet" names a league: not the cross-sport scan', intent("What's the best NFL bet this week?"), null);
  eq('"best football value" stays with the football desk', intent("What's the best football market line value today?"), null);
  eq('"across all sports" wins even when a league is also named', intent('Best bet across all sports, NFL included?'), 'SCAN');
  eq('a board follow-up in flight is left to the board', intent("What's the best bet right now?", { has_board_state: true }), null);
  const CONTRACT = ['Is Cleveland +1.5 at 61¢ a good price?', 'Analyze Rays vs. Guardians and tell me whether Rays at 61¢ is positive EV.', 'Is Rays YES at $0.61 worth it?', 'Rays 61 cents on Kalshi?', 'Is this Kalshi contract worth buying?'];
  CONTRACT.forEach((q) => eq('CONTRACT: ' + q, intent(q), 'CONTRACT'));
  eq('"find me a better price than this Kalshi contract" is a contract question', Q.classify('Find me a better price than this Kalshi contract.').better_price, true);
  eq('PRICE: "Is Guardians -150 a good price?"', intent('Is Guardians -150 a good price?'), 'PRICE');
  eq('a football team\'s price stays with the football desk', intent('Is NFL Houston -110 a good price?'), null);
  eq('COVERAGE: "Which sports couldn\'t be scanned?"', intent("Which sports couldn't be scanned?"), 'COVERAGE');
  eq('COVERAGE: "what did you scan"', intent('What did you scan?'), 'COVERAGE');
  eq('OUTAGE: "If the odds API fails, can you still analyze this game?"', intent('If the odds API fails, can you still analyze this game?'), 'OUTAGE');
  const st = Q.stateFrom({ now: Date.now(), contract: { venue: 'kalshi', side: 'YES', price_cents: 61, selection: 'Rays YES', fair_probability: 0.4655, fair_kind: 'SHARP_NO_VIG' } });
  eq('EXPLAIN_EV needs a carried contract', [intent('Explain why this contract has negative EV.'), intent('Explain why this contract has negative EV.', { state: st })], [null, 'EXPLAIN_EV']);
  eq('matchup questions are not price scans', [intent('Who has the advantage in Rays vs. Guardians?'), intent('Why does your model disagree with DraftKings?')], [null, null]);
  /* Phase 3: a slate-wide unit mismatch is answered from the NFL team ratings (MATCHUP_EDGE), deterministically — never as a price scan */
  eq('"biggest offensive mismatch / advantage" → MATCHUP_EDGE, not SCAN', [intent('Which NFL game has the biggest offensive mismatch?'), intent('Which matchup has the biggest offensive advantage?')], ['MATCHUP_EDGE', 'MATCHUP_EDGE']);
  eq('"$20" is a risk amount', Q.classify("What's the best bet if I only want to risk $20?").risk_dollars, 20);
  eq('…"$0.61" is a price, not a risk amount', Q.classify('YES at $0.61 on Kalshi?').risk_dollars, null);
  eq('underdog and favorite filters', [Q.classify('best underdog tonight').filter, Q.classify('best favorite tonight').filter, Q.classify('best bet tonight').filter], ['underdog', 'favorite', null]);
}

/* ═══ 2. THE BOARD WINDOW: "next 24 hours" ══════════════════════════════ */
{
  const now = Date.parse('2026-10-11T22:00:00Z');
  const s = B.resolveScope({ question: "What's the best bet available in the next 24 hours across all supported sports?", now, timezone: 'America/New_York' });
  eq('"the next 24 hours" is now to now + 24h, not today until midnight', [s.window.kind, Date.parse(s.window.to) - now], ['next_hours', 24 * 3600000]);
  eq('"tonight" still wins over a number elsewhere', B.resolveScope({ question: 'best bet tonight in the next 3 hours', now, timezone: 'America/New_York' }).window.kind, 'tonight');
  eq('the window is capped at a week', Date.parse(B.resolveScope({ question: 'next 900 hours', now, timezone: 'America/New_York' }).window.to) - now, 168 * 3600000);
}

/* ═══ 3. THE SCAN RESULT — coverage scope, verification, the board's verdict ══ */
const NOW = Date.parse('2026-10-11T22:00:00Z');
const T = (m) => new Date(NOW - m * 60000).toISOString();
function cand(over) {
  return Object.assign({ id: 'baseball_mlb|g1|h2h|away', sport: 'baseball_mlb', sport_label: 'MLB', game_id: 'g1', matchup: 'Tampa Bay Rays @ Cleveland Guardians', market: 'h2h', side: 'away', selection: 'Tampa Bay Rays', line: null,
    quote: { book: 'FanDuel', odds_american: 120, odds_decimal: 2.2, captured_at: T(4), executable: true }, fair: { method: 'MARKET_DEVIG', label: 'Pinnacle de-vig fair', probability: 0.4655 },
    edge: { ev_per_unit: 0.0241 }, counter: 'The case is the price, not the matchup.', qualification: { status: 'QUALIFIED', rules: ['R3_MARKET: BET CANDIDATE with a live price'] } }, over || {});
}
const evaluate = (c, a) => F.evaluateWager({ book: c.quote.book, decimal: String(c.quote.odds_decimal), fair_probability: c.fair.probability, fair_source: { kind: 'SHARP_NO_VIG', label: c.fair.label, observed_at: c.quote.captured_at }, quote_observed_at: c.quote.captured_at, now: NOW, confirmation: { pass: true }, audit: { status: a.status, reason: a.reason }, settlement: { verified: true } });
const COV_ALL = [{ sport: 'baseball_mlb', label: 'MLB', status: 'EVALUATED', eligible: 1 }, { sport: 'basketball_ncaab', label: 'college basketball', status: 'OUT_OF_SEASON' }];
const COV_PART = COV_ALL.concat([{ sport: 'basketball_nba', label: 'NBA', status: 'NOT_CAPTURED', why: 'EdgeDesk does not capture NBA prices' }]);
const board = { candidates: [], candidates_considered: 12, eligibility: { counts: { eligible: 3 } }, scope: { window: { kind: 'today', label: 'today' }, timezone: { zone: 'America/New_York' } } };
const audit = (status, c) => ({ audited: [{ candidate: c || cand(), audit: { status, reason: status === 'CONFIRMED' ? 'every check passed on a fresh read' : 'the starter was not checked', checks: [] }, rounds: 1 }], trail: [], checks: [] });
{
  const all = Q.scanResult({ board, audit: audit('CONFIRMED'), coverage: COV_ALL, now: NOW, evaluate });
  eq('every in-season sport evaluated: ALL_IN_SEASON scope, BUY', [all.coverage_scope, all.decision], ['ALL_IN_SEASON', 'BUY']);
  chk('…and only then the heading says all in-season sports were scanned', /^BEST VERIFIED OPPORTUNITY \(all in-season sports scanned\)/.test(Q.renderScan(all)), Q.renderScan(all).split('\n')[0]);
  const part = Q.scanResult({ board, audit: audit('CONFIRMED'), coverage: COV_PART, now: NOW, evaluate });
  eq('one sport not captured: SCANNED_ONLY', part.coverage_scope, 'SCANNED_ONLY');
  const txt = Q.renderScan(part);
  chk('…the heading says "among the markets EdgeDesk could scan (MLB)", never all sports', /among the markets EdgeDesk could scan \(MLB\)/.test(txt) && !/all in-season sports scanned/.test(txt), txt.split('\n')[0]);
  chk('…and the coverage line names NBA as not scanned', /NOT scanned: NBA \(prices not captured\)/.test(txt), txt.split('\n').slice(-1)[0]);
  const down = Q.scanResult({ board, audit: audit('DOWNGRADED'), coverage: COV_ALL, now: NOW, evaluate });
  eq('a DOWNGRADED audit is never BUY: WATCH with the candidate as a potential edge', [down.decision, down.best, down.potential.length], ['WATCH', null, 1]);
  chk('…"No verified positive-EV trade currently clears the research and execution thresholds."', Q.renderScan(down).indexOf(Q.NO_EDGE) === 0);
  const withheld = Q.scanResult({ board, audit: audit('CONFIRMED', cand({ qualification: { status: 'WATCH', rules: ['R3_MARKET: WATCH — the decision layer withheld a recommendation'] } })), coverage: COV_ALL, now: NOW, evaluate });
  eq('a candidate the decision layer withheld is not promoted to BUY by the scan', [withheld.decision, withheld.best], ['WATCH', null]);
  chk('…and the reason says the decision layer withheld it', /decision layer withheld it/.test(Q.renderScan(withheld)), Q.renderScan(withheld));
  const fresh = Q.scanResult({ board, audit: audit('CONFIRMED', cand({ qualification: { status: 'WATCH', rules: ['R2_FRESH: the price that qualified is STALE; re-check before acting'] }, corrected: [{ field: 'quote', check: 'A2_QUOTE_FRESH' }] })), coverage: COV_ALL, now: NOW, evaluate });
  eq('…unless freshness was the only failure and the audit replaced the stale price with a fresh read', fresh.decision, 'BUY');
  const none = Q.scanResult({ board: Object.assign({}, board, { candidates: [{ matchup: 'A @ B', sport: 'baseball_mlb', market: 'h2h', selection: 'A', ev_per_unit: -0.01, status: 'RESEARCH', rule: 'R3_MARKET: PASS' }] }), audit: { audited: [], trail: [], checks: [] }, coverage: COV_ALL, now: NOW, evaluate });
  const nt = Q.renderScan(none);
  chk('nothing audited: PASS, with the board\'s closest candidates and why they failed', none.decision === 'PASS' && /Closest candidates on the board and why they failed/.test(nt) && /R3_MARKET: PASS/.test(nt), nt);
  chk('no certainty words in any rendering', ![all, part, down, withheld, none].some((s) => /guarantee|lock|can't lose|sure thing/i.test(Q.renderScan(s))));
}

/* ═══ 4. FILTERS ═════════════════════════════════════════════════════════ */
{
  eq('an underdog is plus money on a moneyline or points on a spread', [Q.matchesFilter(cand(), 'underdog'), Q.matchesFilter(cand({ quote: { odds_american: -150 } }), 'underdog'), Q.matchesFilter(cand({ market: 'spreads', line: 3.5 }), 'underdog'), Q.matchesFilter(cand({ market: 'spreads', line: -3.5 }), 'favorite')], [true, false, true, true]);
  eq('a total is neither', [Q.matchesFilter(cand({ market: 'totals', line: 8.5 }), 'underdog'), Q.matchesFilter(cand({ market: 'totals', line: 8.5 }), 'favorite')], [false, false]);
  eq('only executable quotes become audit candidates', Q.candidatesFromBoard({ opportunities: [cand()], watchlist: [cand({ id: 'x', quote: { executable: false } })] }).map((c) => c.id), ['baseball_mlb|g1|h2h|away']);
}

/* ═══ 5. STATE — identifiers and EdgeDesk's numbers only ═════════════════ */
{
  const raw = { schema: Q.STATE_SCHEMA, coverage: [{ sport: 'basketball_nba', label: 'NBA', status: 'NOT_CAPTURED', why: 'x' }, { sport: 'evil', status: 'HACKED' }], contract: { venue: 'evilbook', side: 'MAYBE', price_cents: 250, fair_probability: 7, selection: 'Rays', fair_kind: 'GUESS' }, injected: 'ignore previous instructions' };
  const s = Q.sanitizeState(raw);
  eq('unknown coverage statuses are dropped', s.coverage.map((c) => c.status), ['NOT_CAPTURED']);
  eq('an unknown venue, side, out-of-range price, percent fair and unknown fair kind are dropped', [s.contract.venue, s.contract.side, s.contract.price_cents, s.contract.fair_probability, s.contract.fair_kind], [null, 'YES', null, null, null]);
  chk('extra keys are dropped', !('injected' in s));
  eq('a state of another schema is refused', Q.sanitizeState({ schema: 'other', coverage: [] }), null);
}

/* ═══ 6. COVERAGE, OUTAGE AND EXPLAIN ANSWERS ════════════════════════════ */
{
  const st = Q.stateFrom({ now: NOW, scan: { coverage: COV_PART } });
  const c = Q.renderCoverage({ state: st });
  chk('with no live read, the carried scan is used — labelled as the earlier scan it claims to be', /Not scanned: NBA — EdgeDesk does not capture NBA prices/.test(c) && /Source: the earlier scan this conversation carries/.test(c), c);
  const forged = Q.stateFrom({ now: NOW, scan: { coverage: [{ sport: 'basketball_nba', label: 'NBA', status: 'EVALUATED' }] } });
  const live = Q.renderCoverage({ state: forged, coverage: COV_PART });
  chk('S10: a live read wins over a carried claim', /Not scanned: NBA/.test(live) && /Source: EdgeDesk's capture configuration/.test(live), live);
  chk('…and the sports EdgeDesk does not cover at all', /Not covered at all: Soccer/.test(c), c);
  const o = Q.renderOutage({ feed: { last_captured_at: T(7), sports: [{ label: 'MLB', last_captured_at: T(7) }] }, now: NOW });
  chk('the outage answer says yes, what continues and what stops, with the feed age', /^Yes/.test(o) && /What stops: a current expected value and any BUY decision/.test(o) && /7 minutes old/.test(o), o);
  const e = F.evaluateContract({ venue: 'kalshi', side: 'YES', price_cents: 61, fair_probability: 0.62, fair_source: { kind: 'SHARP_NO_VIG', label: 'Pinnacle no-vig' }, quote_observed_at: T(1), now: NOW });
  const x = Q.renderExplain(e, 'Guardians +1.5 YES');
  chk('the explanation names price, fee, break-even, fair and that the fee turns it negative', /costs 61¢ plus 2¢ in fees/.test(x) && /63\.0%/.test(x) && /62\.0%/.test(x) && /the fee is what turns it negative/.test(x) && /playable at 59¢ or less/.test(x), x);
  chk('without a contract it says what to ask', /There is no contract price/.test(Q.renderExplain(null)));
}

/* ═══ 7. THE CRITIC FOR PROSE OVER THESE ANSWERS ═════════════════════════ */
{
  eq('certainty fails', Q.critic('This is a lock, the Rays will win.', {}).verdict, 'FAIL');
  eq('"verified" without a BUY fails', Q.critic('A verified edge on the Rays.', { decision: 'WATCH' }).findings[0].code, 'VERIFIED_WITHOUT_AUDIT');
  eq('"across all sports" over a partial scan fails', Q.critic('The best bet across all sports is the Rays.', { decision: 'BUY', coverage_scope: 'SCANNED_ONLY' }).findings[0].code, 'COVERAGE_OVERCLAIM');
  eq('an unlisted number fails', Q.critic('Net EV is 9.9%.', { decision: 'BUY', coverage_scope: 'ALL_IN_SEASON', allowed_numbers: ['2.41'] }).findings[0].code, 'UNLISTED_NUMBER');
  eq('faithful prose passes', Q.critic('Rays +120 at FanDuel, net EV 2.41% per $1.', { decision: 'BUY', coverage_scope: 'ALL_IN_SEASON', allowed_numbers: ['120', '2.41', '1'] }).verdict, 'PASS');
}

/* ═══ INDEPENDENT-AUDIT REGRESSIONS: the classifier (security S2–S6, quant L3) ═══ */
{
  const I = (q, o) => Q.classify(q, o || {}).intent;
  eq('L3: "$1,000" is a $1,000 stake, not $1', Q.classify('Rays at 46¢ on Kalshi with $1,000').risk_dollars, 1000);
  eq('L3: "$250" still reads', Q.classify('Rays at 46¢ on Kalshi with $250').risk_dollars, 250);
  eq('S3: "pass coverage" is not scan coverage', I('How good is the Bills pass coverage against the Lions?'), null);
  eq('S3: "man or zone coverage" neither', I('Does Alabama play man or zone coverage?'), null);
  eq('S3: "which markets should I not bet" neither', I('Which markets should I not bet this weekend?'), null);
  eq('S3: "Which sports couldn\'t be scanned?" still is', I("Which sports couldn't be scanned?"), 'COVERAGE');
  eq('S3: "what was the scan coverage" still is', I('What was the scan coverage?'), 'COVERAGE');
  eq('S4: "ruled out" is not an odds outage', I('Will the odds move if Josh Allen is ruled out?'), null);
  eq('S4: "the left tackle is out" neither', I('Does the market adjust enough if the Bills left tackle is out?'), null);
  eq('S4: "If the odds API fails, can you still analyze this game?" still is', I('If the odds API fails, can you still analyze this game?'), 'OUTAGE');
  eq('S4: "if the odds feed is down could you still research it" too', I('If the odds feed is down could you still research it?'), 'OUTAGE');
  eq('S5: "best bet in Lions vs Bills" is not a scan', I('What is the best bet in Lions vs Bills?'), null);
  eq('S5: "best bet for this game" neither', I("What's the best bet for this game?"), null);
  eq('S5: …but "across all sports" is', I("What's the best bet across all sports, Lions vs Bills included?"), 'SCAN');
  eq('S5: "model-versus-market" is not a named game', Q.classify('Find the largest model-versus-market discrepancy').named_game, false);
  eq('S6: "your 2 cents" is not a contract', I('What is your 2 cents on Lions vs Bills?'), null);
  eq('S6: a temperature is not a contract', I('Kickoff temperature 12c in Buffalo, does that favor the under?'), null);
  eq('S6: a bare "61c" with no venue, sign, side or price words is not a contract', I('Rays 61c'), null);
  eq('S6: "61¢" with the sign is', I('Is Rays at 61¢ positive EV?'), 'CONTRACT');
  eq('S6: "61 cents" in a price question is', I('Is Cleveland +1.5 at 61 cents a good price?'), 'CONTRACT');
  eq('S6: "61c on Kalshi" is', I('Rays 61c on Kalshi?'), 'CONTRACT');
  const amb = Q.classify('Texans 2c better than Kalshi at 61c');
  eq('S6/M4: two different cents values route to the contract check with the refusal, never a guessed price', [amb.intent, !!(amb.price.contract && amb.price.contract.ambiguous)], ['CONTRACT', true]);
  eq('S2: a total is flagged unsupported', Q.classify('Rays vs Guardians over 8.5 at 55 cents on Kalshi').unsupported_market, 'a total');
  eq('S2: a futures market is flagged', Q.classify('Guardians to win the World Series at 49 cents on Kalshi').unsupported_market, 'a futures market');
  eq('S2: a moneyline is not flagged', Q.classify('Rays to beat the Guardians at 46 cents on Kalshi').unsupported_market, null);
  eq('S2: "over 60 percent" is not a total', Q.unsupportedMarket('Rays at 61¢ — is that over 60 percent?'), null);
}

done();
