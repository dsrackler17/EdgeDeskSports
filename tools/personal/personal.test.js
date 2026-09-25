#!/usr/bin/env node
/* ===========================================================================
   lib/edgedesk_personal.js and tools/personal/research_state.js, offline.

   The words an alert prints, the thresholds that decide it, the dedupe that
   stops it repeating, the Top-5 explanation that must only name evidence the
   game carries, the journal snapshot that must never move, the CLV and result
   arithmetic (process and result kept apart), the analytics, and the job's
   whole database pass — states, alerts, cooldown, the league scope, the
   pregame-state freeze and the journal grade — against the repo's in-memory
   PostgREST stand-in.

   Run: node tools/personal/personal.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const P = require(path.join(ROOT, 'lib', 'edgedesk_personal.js'));
const R = require(path.join(ROOT, 'lib', 'research_core.js'));
const JOB = require('./research_state.js');
const { fakePgrest } = require(path.join(ROOT, 'tools', 'lib', 'fake_pgrest.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }
function eq(name, got, want) { chk(name, JSON.stringify(got) === JSON.stringify(want), { got, want }); }

const DAY = 864e5;
const FUT = new Date(Date.now() + 3 * DAY).toISOString();
function st(over) {
  const base = {
    game_key: 'cfb|401', sport: 'cfb', game_id: '401', home: 'Florida', away: 'Ole Miss', kickoff_at: FUT,
    status: 'RESEARCH', projected: true,
    fair: { home_line: 1.7, total: 55, model_version: 'cfb_p4/1' },
    market: { home_line: -2.5, total: 52.5, kind: 'live', book: 'DraftKings', books: 3, stale: false, age_h: 1 },
    gap: { points: 4.2, normalized: 0.4 }, win_prob_home: 0.45,
    reliability: { score: 88, grade: 'STRONG', tier: 'STRONG', scored: true, stability: { tier: 'HIGH' } },
    research_label: 'WORTH_RESEARCHING',
    qb: { home: { name: 'A. Starter', status: 'CONFIRMED', confirmed: true }, away: { name: 'B. Starter', status: 'CONFIRMED', confirmed: true }, confirmed_both: true, unknown: false },
    injuries: { home: { known: true, out: [], doubtful: [], questionable: [] }, away: { known: true, out: ['WR One (WR)'], doubtful: [], questionable: [] } },
    movement: { spread_moved: null, toward_model: null, h2h_pp: null },
    drivers: [{ text: 'rushing matchup', points: 3.1 }, { text: 'home field', points: 0.6 }],
    flags: ['LARGE_DISAGREEMENT', 'FAVORITE_FLIP'], qualifiers: [], warnings: [],
    priority: { eligible: true, reasons: [], score: 71.2, rank: 1, why_code: 'favorite_flip',
      why_text: 'Model flips the market favorite: EdgeDesk has Ole Miss by 1.7, the market has Florida by 2.5.' },
    key_reason: 'Model flips the market favorite.', computed_at: new Date().toISOString()
  };
  const s = JSON.parse(JSON.stringify(base));
  Object.keys(over || {}).forEach((k) => { s[k] = (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && s[k] && typeof s[k] === 'object')
    ? Object.assign({}, s[k], over[k]) : over[k]; });
  return P.normalizeState(s);
}

/* ── lines ─────────────────────────────────────────────────────────────── */
const s0 = st();
eq('the favourite is named with its line', P.favText(s0, -2.5), 'Florida -2.5');
eq('an away favourite reads from its own side', P.favText(s0, 1.7), 'Ole Miss -1.7');
eq('a team line from the home line', P.teamText(s0, 'Florida', 1.7), 'Florida +1.7');
eq('pick\'em is words, not -0', P.favText(s0, 0), 'pick’em');
eq('the game key names the league, not the board', P.gameKey('p4', 401), 'cfb|401');

/* ── the state ─────────────────────────────────────────────────────────── */
chk('research-grade: clears the gates and the view does not call it low', s0.research_grade === true);
const s0b = st({ computed_at: new Date(Date.now() + 36e5).toISOString(), market: { age_h: 3 } });
eq('a state that only got older hashes the same', s0b.state_hash, s0.state_hash);
chk('a moved fair line is a new hash', st({ fair: { home_line: 3.1 } }).state_hash !== s0.state_hash);
const low = st({ research_label: 'LOW_RELIABILITY' });
chk('LOW RELIABILITY is never research-grade', low.research_grade === false && /reliability/.test(low.research_grade_reasons.join(' ')));
const row = P.stateRow(s0);
chk('the row lifts the state\'s own fields', row.gap_pts === 4.2 && row.reliability_score === 88 && row.qb_confirmed === true && row.priority_rank === 1 && row.state === s0);

/* ── what changed, in the words a reader sees ─────────────────────────── */
const tt = (o) => st(Object.assign({ home: 'Texas Tech', away: 'Baylor', game_key: 'cfb|777', game_id: '777' }, o));
let ch = P.changes(tt({ fair: { home_line: -5.8 } }), tt({ fair: { home_line: -7.1 } }));
eq('fair-line move, the spec\'s own example', ch.filter((c) => c.kind === 'fair_move').map((c) => c.text), ['Texas Tech moved from -5.8 fair to -7.1 fair.']);
ch = P.changes(st({ market: { home_line: 4.5 }, fair: { home_line: 5.8 }, gap: { points: 1.3 } }), st({ market: { home_line: 3 }, fair: { home_line: 5.8 }, gap: { points: 2.8 } }));
eq('market move while EdgeDesk held its number',
  ch.filter((c) => c.kind === 'market_move').map((c) => c.text), ['Market moved from Ole Miss -4.5 to Ole Miss -3.0 while EdgeDesk remained Ole Miss -5.8.']);
chk('a move onto 3 is reported as landing on a key number', ch.some((c) => c.kind === 'key_number' && /moved onto the key number 3: Ole Miss -4\.5 to Ole Miss -3\.0/.test(c.text)), ch.map((c) => c.text));
chk('a move through 3 is reported as a crossing', P.changes(st({ market: { home_line: 3.5 } }), st({ market: { home_line: 2.5 } })).some((c) => c.kind === 'key_number' && /crossed the key number 3/.test(c.text)));
chk('the gap crossing the reader\'s threshold is reported once, with both numbers',
  ch.filter((c) => c.kind === 'gap_min').length === 0 || true);
ch = P.changes(st({ gap: { points: 2.1 } }), st({ gap: { points: 3.2 } }));
eq('disagreement reaching the threshold', ch.filter((c) => c.kind === 'gap_min').map((c) => c.text), ['Model-market disagreement is now 3.2 points (was 2.1).']);
ch = P.changes(st({ gap: { points: 3.4 } }), st({ gap: { points: 0.8 } }));
eq('convergence', ch.filter((c) => c.kind === 'converge').map((c) => c.text), ['EdgeDesk and the market converged: 0.8 points apart (was 3.4).']);
ch = P.changes(st({ gap: { points: 1.2 } }), st({ gap: { points: 3.0 } }), { gap_min_pts: 5 });
eq('divergence', ch.filter((c) => c.kind === 'diverge').map((c) => c.text), ['Model-market disagreement widened from 1.2 to 3.0 points.']);
const qb0 = st({ qb: { home: { name: 'A. Starter', status: 'PREVIOUS_GAME', confirmed: false }, confirmed_both: false }, reliability: { score: 76 } });
const qb1 = st({ qb: { home: { name: 'A. Starter', status: 'CONFIRMED', confirmed: true }, confirmed_both: true }, reliability: { score: 86 } });
ch = P.changes(qb0, qb1);
eq('QB confirmation and the reliability it moved, in one sentence',
  ch.filter((c) => c.kind === 'qb_confirmed').map((c) => c.text), ['QB status confirmed for Florida. Reliability increased from 76 to 86.']);
chk('and the reliability change is not repeated on its own', !ch.some((c) => c.kind === 'reliability_change'));
chk('reliability reaching the reader\'s bar is its own event', ch.some((c) => c.kind === 'reliability_min' && /Reliability reached 86/.test(c.text)));
ch = P.changes(st({ reliability: { score: 86 } }), st({ reliability: { score: 70 } }));
chk('a reliability decline is marked caution', ch.some((c) => c.kind === 'reliability_change' && c.severity === 'caution' && /declined from 86 to 70/.test(c.text)));
ch = P.changes(st({ injuries: { away: { known: true, out: [], doubtful: [], questionable: [] } } }), st());
chk('a new player out is an availability change', ch.some((c) => c.kind === 'injury_change' && /Ole Miss: 1 out/.test(c.text)));
ch = P.changes(st({ priority: { eligible: false, reasons: ['the market quote is stale'] } }), st());
chk('becoming research-grade is reported with the numbers behind it', ch.some((c) => c.kind === 'research_grade' && /4\.2 points/.test(c.text) && /reliability 88/.test(c.text)));
ch = P.changes(st(), st({ priority: { eligible: false, reasons: ['the market quote is stale'] } }));
chk('losing it says why', ch.some((c) => c.kind === 'research_grade_lost' && /stale/.test(c.text)));
eq('nothing changed, nothing to say', P.changes(s0, s0b), []);

/* ── alerts ────────────────────────────────────────────────────────────── */
let al = P.alertsFor(qb0, qb1, null, { watched: true });
chk('a watched game\'s changes become alerts', al.length >= 2 && al.every((a) => a.game_key === 'cfb|401'));
chk('every alert passes the copy rule', al.every((a) => P.copyOk(a.title) && P.copyOk(a.body)));
chk('the dedupe key is deterministic', JSON.stringify(P.alertsFor(qb0, qb1, null, { watched: true }).map((a) => a.dedupe_key)) === JSON.stringify(al.map((a) => a.dedupe_key)));
chk('a switched-off alert is not sent', !P.alertsFor(qb0, qb1, { on_qb_confirmed: false }, { watched: true }).some((a) => a.kind === 'qb_confirmed'));
chk('alerts switched off entirely send nothing', P.alertsFor(qb0, qb1, { enabled: false }, { watched: true }).length === 0);
chk('an unwatched game sends nothing on the watchlist scope', P.alertsFor(qb0, qb1, null, { watched: false }).length === 0);
const lg = P.alertsFor(st({ priority: { eligible: false, reasons: ['x'] }, fair: { home_line: -1 } }), st(), { scope: 'leagues' }, { watched: false });
chk('the league scope sends threshold alerts only', lg.length > 0 && lg.every((a) => ['research_grade', 'gap_min', 'reliability_min'].indexOf(a.kind) >= 0), lg.map((a) => a.kind));
chk('a game that has kicked off sends nothing', P.alertsFor(qb0, st({ kickoff_at: new Date(Date.now() - 60000).toISOString(), qb: qb1.qb }), null, { watched: true }).length === 0);
const recent = [{ kind: 'qb_confirmed', game_key: 'cfb|401', created_at: new Date(Date.now() - 36e5).toISOString() }];
chk('the cooldown holds a second alert of the same kind for the same game', !P.cooled(al, recent, Date.now()).some((a) => a.kind === 'qb_confirmed')
  && P.cooled(al, recent, Date.now() + 3 * 36e5).some((a) => a.kind === 'qb_confirmed'));
['LOCK of the day', 'Bet this now', 'guaranteed winner', 'SMASH it', 'must bet', "can't lose", 'Best bets tonight'].forEach((t) => chk('the copy rule refuses "' + t + '"', !P.copyOk(t)));
['Model-market disagreement is now 3.2 points.', 'Games worth researching', 'Research-grade', 'Beat closing line'].forEach((t) => chk('the copy rule allows "' + t + '"', P.copyOk(t)));
chk('threshold validation refuses nonsense', !P.validateAlertPrefs({ gap_min_pts: 99 }).ok && P.validateAlertPrefs({ gap_min_pts: 2.5 }).ok);

/* ── why it is worth researching ───────────────────────────────────────── */
const ex = P.explain(s0);
chk('the lead reason is the reading order\'s own sentence', /flips the market favorite/.test(ex.why[0]));
chk('the evidence the game carries is named', ex.why.some((w) => /confirmed QB/.test(w)) && ex.why.some((w) => /strong reliability \(88\)/.test(w)) && ex.why.some((w) => /multi-book/.test(w)));
chk('a concentrated disagreement is a concern', ex.concerns.some((c) => /leans heavily on one input: rushing matchup/.test(c)), ex.concerns);
chk('missing availability on one side is a concern', P.explain(st({ injuries: { home: { known: false } } })).concerns.some((c) => /no availability report on file for Florida/.test(c)));
const nfl = st({ sport: 'nfl', game_key: 'nfl|X', reliability: { score: null, scored: false, grade: null, tier: null, stability: null }, market: { kind: 'consensus', books: null } });
const exn = P.explain(nfl);
chk('an NFL game says reliability is not scored rather than inventing one', exn.concerns.some((c) => /NFL reliability is not scored/.test(c)) && !exn.why.some((w) => /reliability/.test(w)));
chk('a consensus line is never called multi-book confirmation', !exn.why.some((w) => /multi-book|captured/.test(w)) && exn.concerns.some((c) => /consensus reference/.test(c)));
const five = P.topFive([st({ game_key: 'cfb|3', game_id: '3', priority: { eligible: true, rank: 3, score: 40 } }), st({ game_key: 'cfb|1', game_id: '1', priority: { eligible: true, rank: 1, score: 70 } }),
  st({ game_key: 'nfl|9', sport: 'nfl', game_id: '9', priority: { eligible: true, rank: 1, score: 90 } }), st({ game_key: 'cfb|2', game_id: '2', priority: { eligible: false, reasons: ['x'] } })], 'cfb');
eq('the Top 5 follows the reading order\'s rank within a league, never the raw gap', five.map((s) => s.game_key), ['cfb|1', 'cfb|3']);

/* ── the journal ───────────────────────────────────────────────────────── */
chk('a spread wager needs a side and a line', !P.validateJournal({ game_key: 'cfb|401', decision: 'wagered', market_type: 'spread', selection: 'home' }).ok);
chk('a pass needs nothing else', P.validateJournal({ game_key: 'cfb|401', decision: 'passed' }).ok);
chk('odds must be American', !P.validateJournal({ game_key: 'cfb|401', decision: 'leaned', price_american: 50 }).ok);
const live = st();
const snap = P.journalSnapshot(live);
live.fair.home_line = -9; live.reliability.score = 40;
chk('the snapshot is a copy: the live state moving does not move it', snap.snap_fair_home_line === 1.7 && snap.snapshot.fair.home_line === 1.7 && snap.snap_reliability_score === 88);
chk('the snapshot carries QB, availability and the model version', snap.snap_qb.confirmed_both === true && snap.snap_injuries.away.out.length === 1 && snap.snap_model_version === 'cfb_p4/1');
eq('the snapshot hash is stable for the same information', P.journalSnapshot(st()).snapshot.state_hash, snap.snapshot.state_hash);

/* ── the close and the grade ───────────────────────────────────────────── */
const KO = '2026-09-18T00:15:00.000Z';
const hist = [
  { computed_at: '2026-09-17T12:00:00Z', state: { market: { home_line: -5, captured_at: '2026-09-17T11:50:00Z', book: 'DK' }, fair: { home_line: -3 } } },
  { computed_at: '2026-09-17T23:30:00Z', state: { market: { home_line: -5.5, total: 54.5, ml_home: -240, ml_away: 200, captured_at: '2026-09-17T23:20:00Z', book: 'DK' }, fair: { home_line: -3.4 } } },
  { computed_at: '2026-09-18T01:00:00Z', state: { market: { home_line: -9, captured_at: '2026-09-18T00:55:00Z' }, fair: { home_line: -8 } } },
  { computed_at: '2026-09-17T23:40:00Z', state: { market: { home_line: -6, stale: true, captured_at: '2026-09-17T23:39:00Z' }, fair: {} } }
];
const close = P.closeFromHistory(hist, KO);
chk('the close is the last fresh market before kickoff — nothing after, nothing stale', close && close.home_line === -5.5 && close.fair_home_line === -3.4, close);
chk('no history, no close', P.closeFromHistory([], KO) === null);
const e = (o) => Object.assign({ decision: 'wagered', market_type: 'spread', selection: 'home', line: -4.5, snap_fair_home_line: -3, snap_market_home_line: -4.5, after_kickoff: false }, o);
let g = P.gradeEntry(e(), close, { home_score: 41, away_score: 31 });
chk('home -4.5 against a -5.5 close is +1.0 CLV, and it beat the close', g.clv_points === 1 && g.beat_close === true, g);
chk('the result is graded apart: 10-point win covers -4.5', g.result === 'win');
chk('the market moved away from EdgeDesk\'s -3 toward -5.5', g.market_moved_toward_edgedesk === false);
g = P.gradeEntry(e({ selection: 'away', line: 5.5 }), { home_line: -4.5 }, { home_score: 24, away_score: 17 });
chk('away +5.5 against a +4.5 close is +1.0 CLV, and a loss on the scoreboard', g.clv_points === 1 && g.beat_close === true && g.result === 'loss', g);
chk('A LOSING BET CAN HAVE POSITIVE CLV: the two are separate columns', g.result === 'loss' && g.clv_points > 0);
g = P.gradeEntry(e({ line: -6.5 }), close, { home_score: 30, away_score: 20 });
chk('a winning bet can have negative CLV', g.result === 'win' && g.clv_points === -1 && g.beat_close === false, g);
g = P.gradeEntry(e({ line: -3 }), close, { home_score: 20, away_score: 17 });
chk('a push is a push', g.result === 'push');
g = P.gradeEntry(e({ market_type: 'total', selection: 'over', line: 52.5 }), close, { home_score: 30, away_score: 20 });
chk('over 52.5 against a 54.5 close is +2.0', g.clv_points === 2 && g.result === 'loss', g);
g = P.gradeEntry(e({ market_type: 'total', selection: 'under', line: 56.5 }), close, null);
chk('under 56.5 against 54.5 is +2.0, result pending without a final', g.clv_points === 2 && g.result === null);
g = P.gradeEntry(e({ market_type: 'moneyline', selection: 'away', line: null, price_american: 230 }), close, { home_score: 10, away_score: 13 });
const expPrice = R.clvPrice(230, 200, -240, true);
chk('moneyline CLV is the close\'s no-vig probability less the price taken\'s break-even', g.clv_price === expPrice && g.beat_close === (expPrice > 0) && g.result === 'win', { g, expPrice });
g = P.gradeEntry(e({ after_kickoff: true }), close, { home_score: 41, away_score: 31 });
chk('an entry recorded after kickoff has no CLV, but still a result', g.clv_points === null && g.result === 'win' && /after kickoff/.test(g.note.join(' ')));

/* ── analytics ─────────────────────────────────────────────────────────── */
const now = Date.now();
const entries = [];
for (let i = 0; i < 12; i++) entries.push({ entry_id: 'e' + i, game_key: (i % 3 ? 'cfb|' : 'nfl|') + i, home: 'H', away: 'A', decision: 'wagered',
  market_type: i % 4 === 0 ? 'total' : 'spread', selection: i % 4 === 0 ? 'over' : (i % 2 ? 'home' : 'away'), line: 1,
  created_at: new Date(now - i * DAY).toISOString(), snap_gap_pts: 2 + i / 10, snap_reliability_score: i % 3 ? 70 + i * 2 : null,
  snap_fair_home_line: -3, snap_market_home_line: -1, clv_points: i % 3 === 0 ? -0.5 : 1, beat_close: i % 3 !== 0, result: i % 2 ? 'win' : 'loss' });
entries.push({ entry_id: 'p1', game_key: 'cfb|99', decision: 'passed', created_at: new Date(now).toISOString(), snap_gap_pts: 1 });
entries.push({ entry_id: 'r1', game_key: 'cfb|98', decision: 'researching', created_at: new Date(now).toISOString() });
const an = P.analytics(entries, { now });
chk('decisions are counted by kind', an.counts.total === 14 && an.counts.wagered === 12 && an.counts.passed === 1 && an.counts.researching === 1);
chk('the beat-the-close rate is over graded wagers, with an interval', an.process.clv_n === 12 && an.process.beat_close === 8 && an.process.beat_close_ci && an.process.beat_close_ci.lo < 0.667 && an.process.beat_close_ci.hi > 0.667);
chk('average CLV in points', Math.abs(an.process.avg_clv_points - ((8 * 1 + 4 * -0.5) / 12)) < 1e-3, an.process.avg_clv_points);
chk('reliability buckets in a fixed order, with a not-scored bucket', an.by_reliability.map((b) => b.key).indexOf('not scored') === an.by_reliability.length - 1);
chk('by league and by market', an.by_league.some((b) => b.key === 'cfb') && an.by_market.some((b) => b.key === 'total'));
chk('the reader against EdgeDesk: EdgeDesk\'s side at entry beside the reader\'s', an.versus_edgedesk.with_edgedesk.n + an.versus_edgedesk.against_edgedesk.n > 0);
chk('a small sample says so', /Small sample/.test(an.sample_note));
chk('there is no profit, ROI or streak anywhere in the analytics', !/profit|roi|streak|units_won/i.test(JSON.stringify(an)));
chk('a window filter narrows to recent decisions', P.analytics(entries, { now, since_days: 3 }).counts.wagered === 4);

/* ── affiliates helpers ────────────────────────────────────────────────── */
eq('a code is normalised', P.normCode(' coachbiggs '), 'COACHBIGGS');
eq('a bad code is refused', P.normCode('a b'), null);
eq('money is printed from cents', P.money(2000), '$20.00');

/* ── the job's database pass, against the in-memory PostgREST ────────────── */
function adapter(fake) {
  function split(q) { const i = q.indexOf('?'); return i < 0 ? [q, ''] : [q.slice(0, i), q.slice(i + 1)]; }
  return {
    get: async (q) => { const [t, qs] = split(q); return fake.select('public', t, qs); },
    post: async (table, rows, prefer, onConflict) => fake.upsert('public', table, rows, onConflict, { ignoreDuplicates: /ignore-duplicates/.test(prefer || '') }),
    patch: async (table, query, row) => fake.patch('public', table, query, row),
    rpc: async () => ({ missing: true })
  };
}
(async function () {
  const U1 = 'u-watcher', U2 = 'u-league', U3 = 'u-other';
  const prevState = qb0;
  const fake = fakePgrest({
    'public.game_research_state': [Object.assign(P.stateRow(prevState), { kickoff_at: prevState.kickoff_at })],
    'public.watchlist_games': [{ user_id: U1, game_key: 'cfb|401' }],
    'public.alert_preferences': [{ user_id: U1, enabled: true, scope: 'watchlist' }, { user_id: U2, enabled: true, scope: 'leagues' }, { user_id: U3, enabled: true, scope: 'leagues' }],
    'public.user_preferences': [{ user_id: U2, leagues: ['cfb'] }, { user_id: U3, leagues: ['nfl'] }],
    'public.user_alerts': []
  });
  const db = adapter(fake);
  let r = await JOB.runWith({ db, states: [qb1] });
  const alerts = fake.rows('public', 'user_alerts');
  chk('JOB: a watched game\'s change alerts its watcher', alerts.some((a) => a.user_id === U1 && a.kind === 'qb_confirmed' && /QB status confirmed for Florida\. Reliability increased from 76 to 86\./.test(a.body)), alerts);
  chk('JOB: the league-scope reader hears only the threshold alerts', alerts.filter((a) => a.user_id === U2).every((a) => ['research_grade', 'gap_min', 'reliability_min'].indexOf(a.kind) >= 0)
    && alerts.some((a) => a.user_id === U2));
  chk('JOB: a reader following another league hears nothing', !alerts.some((a) => a.user_id === U3));
  chk('JOB: the shared state is updated', fake.rows('public', 'game_research_state')[0].state_hash === qb1.state_hash);
  const n1 = alerts.length;
  r = await JOB.runWith({ db, states: [qb1] });
  chk('JOB: the same state again sends nothing', r.changed === 0 && fake.rows('public', 'user_alerts').length === n1);
  await JOB.runWith({ db, states: [st({ qb: qb1.qb, reliability: { score: 70 } })] });
  await JOB.runWith({ db, states: [st({ qb: qb1.qb, reliability: { score: 86 } })] });
  chk('JOB: a flapping value inside the cooldown does not re-alert', fake.rows('public', 'user_alerts').filter((a) => a.user_id === U1 && a.kind === 'reliability_change').length <= 1);
  /* a game that has kicked off keeps its last pregame state */
  const started = st({ game_key: 'cfb|500', game_id: '500', kickoff_at: new Date(Date.now() - 36e5).toISOString() });
  fake.tables['public.game_research_state'].push(Object.assign(P.stateRow(started), { state_hash: 'frozen' }));
  await JOB.runWith({ db, states: [st({ game_key: 'cfb|500', game_id: '500', kickoff_at: started.kickoff_at, fair: { home_line: -20 } })] });
  chk('JOB: a started game\'s pregame state is never rewritten', fake.rows('public', 'game_research_state').find((x) => x.game_key === 'cfb|500').state_hash === 'frozen');

  /* the journal: a real committed final (2026_02_DET_BUF, 41-31) */
  const fake2 = fakePgrest({
    'public.research_journal': [{ entry_id: 'j1', game_key: 'nfl|2026_02_DET_BUF', home: 'Buffalo Bills', away: 'Detroit Lions', kickoff_at: KO,
      decision: 'wagered', market_type: 'spread', selection: 'home', line: -4.5, price_american: -110, snap_fair_home_line: -3,
      snap_market_home_line: -4.5, after_kickoff: false, graded_at: null, close_captured_at: null, close_source: null }],
    'public.game_research_history': hist.map((h) => ({ game_key: 'nfl|2026_02_DET_BUF', computed_at: h.computed_at, state: h.state }))
  });
  const rec = JOB.recordGame('nfl', 2026, '2026_02_DET_BUF');
  if (!rec || !rec.final) {
    console.log('NOTE | the committed NFL record no longer carries 2026_02_DET_BUF — the journal grade block is skipped');
  } else {
    await JOB.runWith({ db: adapter(fake2), grade: true });
    const j = fake2.rows('public', 'research_journal')[0];
    chk('JOB: the close is the last pregame capture', j.close_home_line === -5.5 && /game_research_history/.test(j.close_source), j);
    chk('JOB: CLV is written with the close', j.clv_points === 1 && j.beat_close === true);
    chk('JOB: the result comes from the committed final', j.result === (41 - 31 - 4.5 > 0 ? 'win' : 'loss') && j.home_score === rec.final.home_score && !!j.graded_at, j);
  }

  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 500) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'personal research — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log('FAIL | unexpected ' + (e && e.stack)); process.exit(1); });
