#!/usr/bin/env node
'use strict';
/* ===========================================================================
   The men's college basketball research engine, offline: synthetic data only,
   so it runs in seconds and needs neither the pack nor pyarrow.

   Proves: CSV nulls stay null; season, game-day and event handling; two
   20-minute halves and 5-minute overtimes; names normalise but never fuzzily
   merge; box-score fingerprints link only unique, repeated, unclaimed lines;
   the additive fitter recovers known ratings; a game never informs its own
   prediction or one tipped less than 4 h after it; games against unknown-
   membership opponents leave D1 ratings untouched; neutral sites are
   symmetric; calibration never reads the future; RAPM recovers planted
   player effects, and players who always share the floor are flagged as not
   separable; DNP and zero-minute rows never enter rates; transfers count for
   the new team; scenarios move minutes (200 in, 200 out), price only the
   change from the rating's own baseline, and respect caps; spread and total
   pushes; the market layer says UNAVAILABLE without quotes and PASS on every
   failed gate (stale, suspended, unsupported, unknown rules, unconfirmed
   availability, no market validation); the shot rules (score_value on
   misses); possession reconciliation; lineup pooling.

   Run: node basketball/ncaam_research/tests/research.test.js
   =========================================================================== */
const path = require('path');
const BASE = path.join(__dirname, '..');
const R = (p) => require(path.join(BASE, p));
let pass = 0; let fail = 0;
function ok(name, cond, detail) { if (cond) { pass++; return; } fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); }
const near = (a, b, e) => Math.abs(a - b) <= (e || 1e-9);

const C = R('config'); const T = R('lib/table'); const I = R('ingest'); const ID = R('identity'); const U = R('lib/util');
const { Additive } = R('lib/additive'); const TM = R('team_model'); const CAL = R('lib/calibration'); const PM = R('player_model');
const MN = R('minutes'); const LU = R('lineups'); const MK = R('market'); const AUD = R('audit');
const NR = require(path.join(BASE, '..', '..', 'lib', 'ncaam_research.js'));

/* 1. reading: null is unknown, never zero */
const cells = T.split('1,,"","a,b","x""y"');
ok('unquoted empty CSV field is null; quoted "" is empty string; quotes and commas survive', cells[0] === '1' && cells[1] === null && cells[2] === '' && cells[3] === 'a,b' && cells[4] === 'x"y', cells);

/* 2. seasons, dates, events, clocks */
ok('season label is the end year', C.SEASONS.includes(2026) && C.WINDOWS.holdout[0] === 2026);
ok('a late tip keeps its evening game day', I.gameDay(Date.parse('2026-01-11T03:30:00Z')) === '2026-01-10');
ok('ESPN minute-precision UTC dates parse', I.parseUtc('2026-04-07T00:50Z') === Date.parse('2026-04-07T00:50:00Z'));
ok('events: NCAA tournament, NIT, other postseason, conference tournament, multi-team event, regular',
  I.classifyEvent(3, 'TRNMNT', "NCAA Men's Basketball Championship - Final Four", 4) === 'ncaa_tournament' && I.classifyEvent(3, 'TRNMNT', 'NIT - Championship', 4) === 'nit' &&
  I.classifyEvent(3, 'TRNMNT', 'College Basketball Crown', 4) === 'other_postseason' && I.classifyEvent(2, 'TRNMNT', 'Big Ten Tournament - Final', 3) === 'conference_tournament' &&
  I.classifyEvent(2, 'TRNMNT', 'Players Era Festival', 11) === 'multi_team_event' && I.classifyEvent(2, 'STD', '', 1) === 'regular');
ok('men\'s rules: 2 x 20-minute halves, 5-minute overtimes', C.RULES.regulation_minutes === 40 && C.RULES.halves === 2 && C.RULES.overtime_minutes === 5);
ok('periods to overtimes and minutes (never NBA quarters)', I.overtimes('FINAL', 2) === 0 && I.overtimes('FINAL', 4) === 2 && I.gameMinutes(I.overtimes('FINAL', 3)) === 45 && I.gameMinutes(I.overtimes('FINAL', 5)) === 55 && I.overtimes('POSTPONED', 0) === null && I.gameMinutes(null) === null);

/* 3. names and fingerprints: explicit evidence only */
ok('names normalise accents, punctuation and suffixes', ID.normName('Tarris Reed Jr.') === 'TARRIS REED' && ID.normName("D'Arrae Goodwin") === 'D ARRAE GOODWIN' && ID.normName('José  Núñez III') === 'JOSE NUNEZ');
ok('no fuzzy merge: a nickname is a different name', ID.normName('TJ Cope') !== ID.normName('Tavaj Cope'));
const line = (o) => Object.assign({ pts: 10, fgm: 4, fga: 9, tpm: 1, tpa: 3, ftm: 1, fta: 2, orb: 1, drb: 3, ast: 2, stl: 1, blk: 0, tov: 2, pf: 3 }, o);
ok('an all-zero line or a missing stat identifies nobody', ID.fingerprint(line({ pts: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0, orb: 0, drb: 0, ast: 0, stl: 0, blk: 0, tov: 0, pf: 0 })) === null && ID.fingerprint(line({ ast: null })) === null && ID.fingerprint(line()) !== null);
{
  const ncaa = []; const espn = [];
  const add = (game, team, pid, athlete, o, name) => { ncaa.push(Object.assign({ game_id: game, team, pid, name: name || 'P' + pid, mins: 20 }, line(o))); if (athlete != null) espn.push(Object.assign({ game_id: game, team, athlete, season: 2026, name: name || 'P' + pid, min: 20 }, line(o))); };
  add(1, 9, 100, 500, { pts: 11 }); add(2, 9, 100, 500, { pts: 13 });           // linked: two unique matching games
  add(1, 9, 101, 501, { pts: 7 }); add(1, 9, 102, 502, { pts: 7 });             // identical lines in one game: ambiguous, not evidence
  add(3, 9, 103, 503, { pts: 21 });                                              // one game only: quarantined
  add(4, 9, 104, 504, { pts: 5 }); add(5, 9, 105, 504, { pts: 6 }); add(6, 9, 104, 504, { pts: 9 }); add(7, 9, 105, 504, { pts: 8 }); // one athlete claimed by two ids
  const X = ID.playerCrosswalk(ncaa, espn);
  ok('fingerprint link needs repeated unique evidence', X.athleteOf.get(100) === 500);
  ok('identical lines in a game are not evidence', !X.athleteOf.has(101) && !X.athleteOf.has(102) && X.audit.ambiguous_lines === 2);
  ok('one fingerprint only is quarantined, not linked', !X.athleteOf.has(103) && X.quarantine.some((q) => q.ncaa_player_id === 103 && q.reason === 'ONE_FINGERPRINT_ONLY'));
  ok('an athlete claimed by two NCAA ids is quarantined for both', !X.athleteOf.has(104) && !X.athleteOf.has(105) && X.quarantine.filter((q) => q.reason === 'ATHLETE_CLAIMED_BY_SEVERAL_NCAA_IDS').length === 2);
}

/* 4. the additive fitter recovers planted ratings */
{
  const off = { 1: 6, 2: 0, 3: -6, 4: 2 }; const al = { 1: -4, 2: 3, 3: 5, 4: -2 }; const mu = 105; const eta = 1.5;
  const A = new Additive({ lambdaOff: 1e-3, lambdaAllow: 1e-3, kMu: 1e-6, kEta: 1e-6, sweeps: 400, center: true });
  for (let r = 0; r < 3; r++) for (const a of [1, 2, 3, 4]) for (const b of [1, 2, 3, 4]) if (a !== b) { const v = r === 1 ? 0 : 1; A.add(a, b, mu + off[a] + al[b] + eta * v, 70, v, r); A.add(b, a, mu + off[b] + al[a] - eta * v, 70, -v, r); }
  A.fit(10, null);
  ok('additive fitter recovers offense, defense, mean and home edge', [1, 2, 3, 4].every((t) => near(A.rating(t).off - A.rating(1).off, off[t] - off[1], 1e-3) && near(A.rating(t).allow - A.rating(1).allow, al[t] - al[1], 1e-3)) && near(A.eta, eta, 1e-3) && near(A.predict(1, 3, 0), mu + off[1] + al[3], 1e-2), { eta: A.eta });
}

/* 5. the team model: point in time, non-D1 regime, neutral symmetry */
function synthGames(extra) {
  const g = []; let id = 1; const t0 = Date.parse('2025-11-10T00:00:00Z'); const str = { 1: 10, 2: 4, 3: -2, 4: -8 };
  for (let d = 0; d < 30; d++) for (const [h, a] of [[1, 2], [3, 4], [1, 3], [2, 4], [1, 4], [2, 3]].slice(d % 2 ? 3 : 0, d % 2 ? 6 : 3)) {
    const poss = 70; const hp = 105 + str[h] - (str[a] / 2) + 2; const ap = 105 + str[a] - str[h] / 2 - 2;
    const s = t0 + d * 864e5 + (h * 7 + a) * 600e3;
    g.push({ game_id: id++, season: 2026, start_ms: s, day: s / 864e5, home: h, away: a, neutral: false, regime: 'D1_D1', home_d1: true, away_d1: true, event: 'regular', conference_game: true, minutes: 40, n_ot: 0, poss, tempo: poss, hs: Math.round(hp * poss / 100), as: Math.round(ap * poss / 100), yH: hp, yA: ap, rest_h: 2, rest_a: 2, box: {} });
  }
  return g.concat(extra || []);
}
{
  const games = synthGames(); const r1 = TM.runSeason(2026, games, { lambda: 150 }, null, null);
  ok('every prediction uses only games available 4 h after tip and before the prediction', r1.rows.every((r) => r.inputs_known_through == null || r.inputs_known_through < Date.parse(r.predicted_at)));
  const k = 40; const changed = games.map((g, i) => (i === k ? Object.assign({}, g, { hs: g.hs + 40, yH: g.yH + 57 }) : g));
  const r2 = TM.runSeason(2026, changed, { lambda: 150 }, null, null);
  const gid = games[k].game_id; const a = r1.rows.find((r) => r.game_id === gid); const b = r2.rows.find((r) => r.game_id === gid);
  ok('a game\'s own result never moves its own prediction', near(a.margin, b.margin, 1e-12) && near(a.total, b.total, 1e-12));
  const later = r1.rows.filter((r) => r.start_ms > games[k].start_ms + C.AVAILABLE_AFTER_MS + C.PREDICT_BEFORE_MS + 1);
  const later2 = r2.rows.filter((r) => r.start_ms > games[k].start_ms + C.AVAILABLE_AFTER_MS + C.PREDICT_BEFORE_MS + 1);
  ok('...but does move predictions made after it became available', later.some((r, i) => !near(r.margin, later2[i].margin, 1e-6)));
  // a game tipping 2 h after another is predicted without it
  const s0 = Date.parse('2026-01-01T18:00:00Z');
  const pair = [Object.assign({}, games[0], { game_id: 9001, start_ms: s0, day: s0 / 864e5, hs: 120, yH: 171 }), Object.assign({}, games[1], { game_id: 9002, start_ms: s0 + 2 * 3600e3, day: (s0 + 2 * 3600e3) / 864e5, home: games[0].home })];
  const r3 = TM.runSeason(2026, synthGames(pair), { lambda: 150 }, null, null);
  const r4 = TM.runSeason(2026, synthGames([pair[1]]), { lambda: 150 }, null, null);
  ok('a game that tipped 2 h earlier is not yet an input', near(r3.rows.find((r) => r.game_id === 9002).margin, r4.rows.find((r) => r.game_id === 9002).margin, 1e-12));
  // non-D1 regime
  const nd = { game_id: 9100, season: 2026, start_ms: Date.parse('2025-11-20T18:00:00Z'), day: Date.parse('2025-11-20T18:00:00Z') / 864e5, home: 1, away: 77, neutral: false, regime: 'D1_OTHER', home_d1: true, away_d1: false, event: 'regular', minutes: 40, poss: 70, tempo: 70, hs: 110, as: 40, yH: 157, yA: 57, box: {} };
  const withND = TM.runSeason(2026, synthGames([nd]), { lambda: 150 }, null, null); const without = TM.runSeason(2026, synthGames(), { lambda: 150 }, null, null);
  ok('games against unknown-membership opponents never enter the D1 fit', !withND.E.idx.has(77) && withND.E.obs.y.length === without.E.obs.y.length);
  ok('...so D1 ratings are unchanged (to solver tolerance)', [1, 2, 3, 4].every((t) => near(withND.E.rating(t).off, without.E.rating(t).off, 0.05) && near(withND.E.rating(t).allow, without.E.rating(t).allow, 0.05)), [1, 2, 3, 4].map((t) => withND.E.rating(t).off - without.E.rating(t).off));
  ok('...and fit their own pooled opponent', withND.nond1.games === 1 && withND.nond1.off < 0);
  // neutral symmetry
  const E = without.E; const v0a = E.predict(1, 4, 0) - E.predict(4, 1, 0); const v0b = E.predict(4, 1, 0) - E.predict(1, 4, 0);
  ok('a neutral site is symmetric; a home site adds the home edge', near(v0a, -v0b, 1e-12) && near(E.predict(1, 4, 1) - E.predict(1, 4, 0), E.eta, 1e-12));
}

/* 6. calibration never reads the future */
{
  const rows = []; const t0 = Date.parse('2025-11-01T00:00:00Z');
  for (let i = 0; i < 1200; i++) rows.push({ game_id: i, start_ms: t0 + i * 3 * 3600e3, margin: (i % 21) - 10, total: 140, var_param: 1, y: { margin: 2 * ((i % 21) - 10), total: 140 + (i % 7), hw: (i % 21) - 10 > 0 ? 1 : 0 } });
  const fitted = CAL.fit(rows); ok('calibration recovers a slope', near(fitted.margin.b, 2, 1e-9));
  const a = CAL.causal(rows.map((r) => Object.assign({}, r)));
  const futureShock = rows.map((r, i) => Object.assign({}, r, i > 1000 ? { y: { margin: 500, total: 999, hw: 1 } } : {}));
  const b = CAL.causal(futureShock);
  const idx = 900; ok('a row\'s calibration ignores later outcomes', a[idx].cal && near(a[idx].cal.margin_mu, b[idx].cal.margin_mu, 1e-12));
  ok('rows before enough history get no calibrated forecast', a[0].cal === null);
}

/* 7. metrics */
ok('CRPS of a normal forecast', near(U.crpsNormal(0, 1, 0), 2 * 0.3989422804 - 1 / Math.sqrt(Math.PI), 1e-6) && U.crpsNormal(0, 1, 3) > U.crpsNormal(0, 1, 1));
ok('normal CDF and inverse agree', near(U.Phi(U.PhiInv(0.9)), 0.9, 1e-6));

/* 8. RAPM recovers planted player effects; inseparable pairs are flagged */
function synthPossessions(n, effects, seed, together) {
  const rand = U.rng(seed); const P = { n, game: new Float64Array(n), off_home: new Int8Array(n), home: new Float64Array(n), away: new Float64Array(n), pts: new Int8Array(n), garbage: new Int8Array(n), ids: new Float64Array(n * 10), flags: new Uint8Array(n), period: new Int8Array(n).fill(1), num: new Int32Array(n), contest: new Array(n).fill('c'), transition: new Int8Array(n) };
  const teamA = [1, 2, 3, 4, 5, 6, 7, 8]; const teamB = [11, 12, 13, 14, 15, 16, 17, 18];
  const pick = (team) => { const s = team.slice(); for (let i = s.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [s[i], s[j]] = [s[j], s[i]]; } let five = s.slice(0, 5); if (together) { const has1 = five.includes(1); five = five.filter((x) => x !== 1 && x !== 2); if (has1 || five.length < 4) five = [1, 2].concat(five).slice(0, 5); else five = five.concat(s.filter((x) => !five.includes(x) && x !== 1 && x !== 2)).slice(0, 5); } return five; };
  for (let i = 0; i < n; i++) {
    const homeOff = i % 2 === 0; P.game[i] = 1 + Math.floor(i / 140); P.home[i] = 100; P.away[i] = 200; P.off_home[i] = homeOff ? 1 : 0;
    const h = pick(teamA); const a = pick(teamB); for (let k = 0; k < 5; k++) { P.ids[i * 10 + k] = h[k]; P.ids[i * 10 + 5 + k] = a[k]; }
    const off = homeOff ? h : a; const def = homeOff ? a : h;
    let p = 1.05 + off.reduce((s, x) => s + (effects[x] || 0), 0) / 100 - def.reduce((s, x) => s + (effects['d' + x] || 0), 0) / 100;
    p = Math.max(0.2, Math.min(2.5, p));
    let pts = 0; const u = rand(); if (u < p / 2.2) pts = 2; if (u < p / 6) pts = 3; P.pts[i] = pts;
  }
  return P;
}
{
  const eff = { 1: 8, 11: -6, d3: 6 };
  const P = synthPossessions(120000, eff, 3, false);
  const games = new Map(); for (let g = 1; g <= 1000; g++) games.set(g, { neutral: true });
  const B = PM.buildUnits(P, () => true, games); const f = PM.fitRidge(B, 300, null); const N = B.players.length;
  const O = (id) => f.x[B.index.get(id)]; const D = (id) => f.x[N + B.index.get(id)];
  ok('RAPM ranks the planted offensive star first and the planted bad offense last', [...B.players].sort((a, b) => O(b) - O(a))[0] === 1 && [...B.players].sort((a, b) => O(a) - O(b))[0] === 11, { o1: O(1), o11: O(11) });
  ok('RAPM finds the planted defender', [...B.players].sort((a, b) => D(b) - D(a))[0] === 3, { d3: D(3) });
  const prior = new Float64Array(2 * N); prior[B.index.get(5)] = 20;
  const fp = PM.fitRidge(B, 1e7, prior);
  ok('a huge penalty returns the prior', near(fp.x[B.index.get(5)], 20, 0.05) && near(fp.x[B.index.get(6)], 0, 0.05));
  const P2 = synthPossessions(40000, {}, 5, true); const B2 = PM.buildUnits(P2, () => true, games); const f2 = PM.fitRidge(B2, 300, null);
  const teams = PM.playerTeams(B2); const post = PM.teamBlocks(B2, f2, (pid) => teams[B2.index.get(pid)]);
  const corr12 = PM.netCorrelation(post, B2.index.get(1), B2.index.get(2), f2.s2); const corr34 = PM.netCorrelation(post, B2.index.get(3), B2.index.get(4), f2.s2);
  ok('two players who always share the floor have strongly negative posterior correlation; ordinary teammates do not', corr12 < -0.5 && corr34 > corr12, { corr12, corr34 });
}

/* 9. minutes, rates, transfers */
{
  const book = new MN.MinutesBook(3);
  book.observe(9, [{ athlete: 1, min: 30, pts: 15, orb: 1, drb: 4, ast: 2, starter: true, pf: 2 }, { athlete: 2, min: 0, dnp: true }]);
  book.observe(9, [{ athlete: 1, dnp: true, min: null }, { athlete: 2, min: 10, pts: 2, starter: false, pf: 1 }]);
  book.observe(9, [{ athlete: 1, min: 34, pts: 20, orb: 0, drb: 6, ast: 1, starter: true, pf: 5 }, { athlete: 2, min: 0, dnp: false }]);
  const s1 = book.summary(9, 1); const s2 = book.summary(9, 2);
  ok('DNP and zero-minute rows are not games played', s1.games === 2 && s2.games === 1);
  ok('appearance rate counts team games since the first appearance', near(s1.appearance_rate, 2 / 3) && near(s2.appearance_rate, 1 / 2));
  ok('baseline minutes include absences (what the team rating contains)', near(s1.baseline_minutes, 64 / 3) && near(s1.season_mpg, 32));
  ok('per-40 rates come from minutes played only, never divide by zero', near(s1.per40.pts, 40 * 35 / 64) && Number.isFinite(s2.per40.reb));
  ok('a foul-out is counted', s1.foul_outs === 1);
  ok('a player with no minutes falls back to his prior rate', MN.shrunkRate(null, { min: 400, per40: { pts: 12 } }, null, 'pts', 50, 100) === 12);
  const PG = { rows: [
    { season: 2025, team: 7, athlete: 1, min: 30, game_id: 1 }, { season: 2025, team: 7, athlete: 2, min: 10, game_id: 1 }, { season: 2025, team: 8, athlete: 3, min: 35, game_id: 2 }, { season: 2025, team: 8, athlete: 4, min: 5, game_id: 2 },
    { season: 2026, team: 7, athlete: 1, min: 28, game_id: 3 }, { season: 2026, team: 7, athlete: 3, min: 30, game_id: 3 } ] };
  const R_ = new TM.Rosters(PG); const tr = R_.tracker(2026, new Map([[7, 5], [8, 12]])); tr.absorb(3);
  ok('continuity = share of last season\'s minutes returning (player 1: 30 of 40)', near(tr.continuity(7), 0.75));
  ok('a transfer counts as incoming for his new team, valued by his old team and his share there', tr.incoming(7).transfers === 1 && near(tr.incoming(7).value, (5 * 35 / 40) * 12) && tr.incoming(8) === null);
}

/* 10. scenarios: minutes move, value is priced once */
{
  const rot = [
    { id: 'a', name: 'A', pos: 'G', baseline: 34, expected: 34, cap: 38, starter: true, o: 5, d: 1, sd_o: 2, sd_d: 2 },
    { id: 'b', name: 'B', pos: 'G', baseline: 30, expected: 30, cap: 36, starter: true, o: 1, d: 0, sd_o: 2, sd_d: 2 },
    { id: 'c', name: 'C', pos: 'F', baseline: 30, expected: 30, cap: 36, starter: true, o: 0, d: 2, sd_o: 2, sd_d: 2 },
    { id: 'd', name: 'D', pos: 'F', baseline: 28, expected: 28, cap: 34, starter: true, o: 0, d: 0, sd_o: 2, sd_d: 2 },
    { id: 'e', name: 'E', pos: 'C', baseline: 26, expected: 26, cap: 32, starter: true, o: -1, d: 3, sd_o: 2, sd_d: 2 },
    { id: 'f', name: 'F', pos: 'G', baseline: 20, expected: 20, cap: 30, starter: false, o: -2, d: 0, sd_o: 2, sd_d: 2 },
    { id: 'g', name: 'G', pos: 'F', baseline: 18, expected: 18, cap: 28, starter: false, o: -1, d: -1, sd_o: 2, sd_d: 2 },
    { id: 'h', name: 'H', pos: 'C', baseline: 14, expected: 14, cap: 24, starter: false, o: -3, d: 1, sd_o: 2, sd_d: 2 },
  ];
  const drift = rot.map((p, i) => Object.assign({}, p, { baseline: p.baseline + (i === 0 ? -6 : i === 5 ? 6 : 0) })); // a starter who missed games, a sub who grew into the role
  const nd = NR.scenario(drift, {});
  ok('with no change the scenario is zero against the usual rotation, and the rotation drift is reported separately', near(nd.delta_vs_usual.net, 0, 1e-9) && !near(nd.full_strength_vs_rating.net, 0, 1e-3) && near(nd.delta.net, nd.full_strength_vs_rating.net, 1e-9));
  const none = NR.scenario(rot, {});
  ok('no change: minutes sum to 200 and the delta is zero (no double counting)', near(none.minutes.players.reduce((s, p) => s + p.minutes, 0), 200, 1e-6) && near(none.delta.net, 0, 1e-9));
  const out = NR.scenario(rot, { out: ['a'] }); const m = (sc, id) => sc.minutes.players.find((p) => p.id === id).minutes;
  ok('a player who is out plays 0 and the 200 minutes are kept', m(out, 'a') === 0 && near(out.minutes.players.reduce((s, p) => s + p.minutes, 0), 200, 1e-6));
  ok('losing the best player costs net rating', out.delta.net < 0 && out.delta.sd_net > 0);
  ok('his minutes go to guards first', (m(out, 'f') - 20) / 20 > (m(out, 'g') - 18) / 18 && m(out, 'b') > 30);
  ok('nobody exceeds his cap', out.minutes.players.every((p) => p.minutes <= Math.min(40, (rot.find((r) => r.id === p.id) || {}).cap || 40) + 1e-6));
  const capped = NR.scenario(rot, { cap: { a: 22 } }); ok('foul trouble caps minutes and costs less than an absence', near(m(capped, 'a'), 22, 1e-9) && capped.delta.net < 0 && capped.delta.net > out.delta.net);
  const bench = NR.scenario(rot, { bench_share: 0.2 }); ok('shifting starter minutes to the bench keeps 200 and moves value', near(bench.minutes.players.reduce((s, p) => s + p.minutes, 0), 200, 1e-6) && bench.delta.net < 0);
  const add = NR.scenario(rot, { add: [{ id: 'z', name: 'Transfer', pos: 'G', expected: 24, cap: 32, o: 4, d: 1, sd_o: 3, sd_d: 3 }] }); ok('an added transfer takes minutes from others and is priced by his impact', m(add, 'z') > 0 && add.delta.net > 0 && near(add.minutes.players.reduce((s, p) => s + p.minutes, 0), 200, 1e-6));
  const sum = (sc) => sc.minutes.players.reduce((s, p) => s + p.minutes, 0);
  const best = NR.scenario(rot, { closing: ['a', 'b', 'c', 'd', 'e'] }); const small = NR.scenario(rot, { closing: ['a', 'b', 'f', 'g', 'h'] });
  ok('the five who close gain minutes, nobody passes his cap, the team keeps 200', ['a', 'b', 'c', 'd', 'e'].every((id) => m(best, id) > m(none, id)) && ['f', 'g', 'h'].every((id) => m(best, id) < m(none, id)) && best.minutes.players.every((p) => p.minutes <= rot.find((r) => r.id === p.id).cap + 1e-6) && near(sum(best), 200, 1e-6));
  ok('closing with the best five helps; closing with weaker bench players hurts', best.delta_vs_usual.net > 0 && small.delta_vs_usual.net < 0 && near(sum(small), 200, 1e-6));
  const closeOut = NR.scenario(rot, { out: ['a'], closing: ['a', 'b', 'c', 'd', 'e'] }); ok('a closer who is out still plays 0', m(closeOut, 'a') === 0 && near(sum(closeOut), 200, 1e-6));
}

/* 11. the matchup and the exact markets */
const league = { mu: 105, eta: 1.6, tau: 68, cal: { margin: { a: 0, b: 1 }, total: { a: 0, b: 1 }, var_margin: { s0: 120, k: 1 }, var_total: { s0: 250, k: 1 }, rho: 0.05 } };
const strong = { off: 8, allow: -6, pace_off: 1, pace_allow: 0, var_off: 2, var_allow: 2 }; const weak = { off: -3, allow: 4, pace_off: -1, pace_allow: 0, var_off: 2, var_allow: 2 };
{
  const p1 = NR.project(strong, weak, league, { neutral: true }); const p2 = NR.project(weak, strong, league, { neutral: true });
  ok('neutral matchup is symmetric', near(p1.margin.mean, -p2.margin.mean, 1e-9) && near(p1.win_home, p2.win_away, 1e-9) && near(p1.total.mean, p2.total.mean, 1e-9));
  const ph = NR.project(strong, weak, league, {}); ok('home court helps the home side', ph.margin.mean > p1.margin.mean && ph.win_home > p1.win_home);
  ok('points add up to the total and differ by the margin', near(p1.points_home + p1.points_away, p1.total.mean, 1e-9) && near(p1.points_home - p1.points_away, p1.margin.mean, 1e-9));
  const sc = NR.project(strong, weak, league, { neutral: true, delta_home: { off: -2, def: -1, sd_net: 1 } }); ok('a scenario moves the projection and widens it', sc.margin.mean < p1.margin.mean && sc.margin.sd > p1.margin.sd);
  const pm = NR.marginPmf(p1, -80, 80); ok('regulation ties go to overtime: no mass on 0, total 1', pm[0] === 0 && near(Object.values(pm).reduce((s, v) => s + v, 0), 1, 1e-6));
  const sp = NR.outcomeProbs(p1, 'spread', 'home', -7); const sph = NR.outcomeProbs(p1, 'spread', 'home', -7.5);
  ok('an integer spread can push; a half-point spread cannot; win+push+lose = 1', sp.push > 0 && sph.push === 0 && near(sp.win + sp.push + sp.lose, 1, 1e-6) && near(sph.win + sph.lose, 1, 1e-6));
  const away = NR.outcomeProbs(p1, 'spread', 'away', 7); ok('home -7 and away +7 share the push and swap win/lose', near(away.push, sp.push, 1e-9) && near(away.win, sp.lose, 1e-9));
  const to = NR.outcomeProbs(p1, 'total', 'over', 140); const tu = NR.outcomeProbs(p1, 'total', 'under', 140); ok('an integer total can push; over/under complement', to.push > 0 && near(to.win, tu.lose, 1e-9) && near(to.win + to.push + to.lose, 1, 1e-6));
}

/* 12. the market layer: optional, separate, and allowed to say PASS */
{
  const p = NR.project(strong, weak, league, { neutral: true }); const now = Date.parse('2026-11-10T20:00:00Z');
  const none = NR.compareMarket(p, [], { now, unavailable_reason: 'no source' });
  ok('no quotes: market comparison unavailable, with its reason', none.status === 'UNAVAILABLE' && none.message === 'market comparison unavailable' && none.reason === 'no source');
  ok('missing odds never stop the research: the projection stands on its own', Number.isFinite(p.win_home) && Number.isFinite(p.fair_spread_home) && Number.isFinite(p.fair_total));
  const fresh = new Date(now - 60e3).toISOString(); const stale = new Date(now - 3 * 3600e3).toISOString();
  const q = (o) => Object.assign({ book: 'bk', market: 'spread', side: 'home', line: -2.5, decimal: 1.91, observed_at: fresh, status: 'open', rules: { overtime_included: true } }, o);
  const gates = (o, opts) => NR.compareMarket(p, [q(o)], Object.assign({ now }, opts || {})).rows[0].gates.join(' | ');
  ok('a stale price is PASS', /STALE_PRICE/.test(gates({ observed_at: stale })));
  ok('a suspended market is PASS', /MARKET_SUSPENDED/.test(gates({ status: 'suspended' })));
  ok('an expired quote is PASS', /QUOTE_EXPIRED/.test(gates({ expires_at: new Date(now - 1000).toISOString() })));
  ok('a player prop is unsupported by a game model', /UNSUPPORTED_MARKET/.test(gates({ market: 'player_points' })));
  ok('unknown overtime rules are PASS', /SETTLEMENT_RULES_UNKNOWN/.test(gates({ rules: {} })));
  ok('without confirmed availability or market validation, everything is PASS', /AVAILABILITY_UNCONFIRMED/.test(gates({})) && /NOT_MARKET_VALIDATED/.test(gates({})) && NR.compareMarket(p, [q({})], { now }).decision === 'PASS');
  const allOk = { availability_confirmed: true, market_validated: true };
  const fair = NR.compareMarket(p, [q({ line: p.fair_spread_home, decimal: 1.91 })], Object.assign({ now }, allOk)).rows[0];
  ok('a fair line at a normal price fails the return bar', fair.decision === 'PASS' && fair.gates.some((g) => /BELOW_BAR/.test(g)));
  const rich = NR.compareMarket(p, [q({ line: 6.5, decimal: 2.2 })], Object.assign({ now }, allOk)).rows[0];
  ok('the eligible path exists when every gate holds', rich.decision === 'ELIGIBLE' && rich.expected_return_per_unit > 0.02);
  const push = NR.compareMarket(p, [q({ line: -7, decimal: 1.91 })], Object.assign({ now }, allOk)).rows[0];
  ok('expected return treats a push as stake returned', near(push.expected_return_per_unit, push.model.win * 0.91 - push.model.lose, 1e-3));
  const ref = NR.compareMarket(p, [q({ side: 'home', line: -3.5, decimal: 1.91 }), q({ side: 'away', line: 3.5, decimal: 1.91 })], { now }).no_vig_reference[0];
  ok('two-way prices are de-vigged for reference', near(ref.no_vig_1 + ref.no_vig_2, 1, 1e-3) && ref.overround > 0);
  const n = MK.normalise([
    { record_id: 'r1', revision: 1, event_id: '401', bookmaker_id: 'bk', market_type: 'spread', selection: 'home', line: '-3.5', odds_decimal: '1.90', captured_at: fresh, overtime_included: 'true' },
    { record_id: 'r1', revision: 2, event_id: '401', bookmaker_id: 'bk', market_type: 'spread', selection: 'home', line: '-4.5', odds_decimal: '1.95', captured_at: fresh, overtime_included: 'true' },
    { record_id: 'r2', revision: 1, event_id: '401', bookmaker_id: 'bk', market_type: 'spread', selection: 'away', line: '4.5', captured_at: fresh },
    { record_id: 'r3', revision: 1, event_id: '401', bookmaker_id: 'bk', market_type: 'total', period: 'first_half', selection: 'over', line: '70.5', odds_decimal: '1.9', captured_at: fresh },
    { record_id: 'r4', revision: 1, event_id: '401', bookmaker_id: 'bk', market_type: 'moneyline', selection: 'home', odds_american: '-150', captured_at: fresh, suspended: 'true' },
  ]);
  ok('quote adapter: latest revision kept, no price refused, halves unsupported, suspension carried', n.quotes.length === 2 && n.quotes.find((x) => x.record_id === 'r1').line === -4.5 && n.refused.NO_PRICE === 1 && n.unsupported.length === 1 && n.quotes.find((x) => x.record_id === 'r4').status === 'suspended');
  ok('American odds convert', near(NR.toDecimal({ american: -150 }), 1 + 100 / 150, 1e-9) && near(NR.toDecimal({ american: 120 }), 2.2, 1e-9));
}

/* 13. data rules: shots, possession reconciliation, the lineup table's flags */
{
  const S = { n: 4, cols: { game_id: [1, 1, 1, 1], team_id: [5, 5, 5, 5], period_number: [1, 1, 2, 2], athlete_id_1: [9, 9, 9, NaN], athlete_id_2: [NaN, NaN, NaN, NaN], type_text: ['JumpShot', 'JumpShot', 'MadeFreeThrow', 'LayUpShot'], scoring_play: Int8Array.from([0, 1, 0, 1]), score_value: [3, 3, 1, 2], coordinate_x: [0, 0, 0, 0], coordinate_y: [0, 0, 0, 0] } };
  const TG = { rows: [{ season: 2026, game_id: 1, team: 5, fgm: 2, ftm: 0, tpa: 2 }] }; const PG = { rows: [] };
  const sc = AUD.shotChecks(S, TG, PG);
  ok('a missed shot with positive score_value is a miss, never points', sc.counts.missed_with_positive_score_value === 2 && sc.counts.made === 2 && sc.team_box_agreement.fgm_equal === 1);
  ok('"MadeFreeThrow" on a non-scoring play is a missed free throw', sc.counts.free_throw_type_on_miss === 1);
  const P = { n: 4, game: [7, 7, 7, 7], home: [1, 1, 1, 1], away: [2, 2, 2, 2], off_home: [1, 0, 1, 0], pts: [2, 3, 2, 0], flags: [0, 0, 0, 0], garbage: [0, 0, 0, 0] };
  const tgb = { byGame: new Map([[7, [{ team: 1, pts: 2 }, { team: 2, pts: 5 }]]]) };
  const q = AUD.possessionGameQuality(P, tgb).byGame.get(7);
  ok('possession points that credit a basket to the wrong team are flagged, not trusted', q.status === 'WITHIN_3' && q.delta_home === 2 && q.delta_away === -2);
  const LT = { n: 2, cols: { player_count_error: [null, null], player_1: ['a', 'a'], player_2: ['b', 'b'], player_3: ['c', 'c'], player_4: ['d', 'd'], player_5: ['e', 'a'], duration_mins: Float64Array.from([3, 0]), team_year: Float64Array.from([2025, 2025]) } };
  const lc = AUD.lineupTableChecks(LT);
  ok('a null QA flag is counted as null (unknown), not as a pass', lc.player_count_error_null === 2 && !('passed' in lc));
  ok('lineup rows without five distinct names and zero durations are counted', lc.rows_without_five_distinct_names === 1 && lc.zero_or_negative_duration === 1);
  ok('team_year (calendar label) is reported separately from the end-year season', lc.team_year_values[2025] === 2 && /end year/.test(lc.note));
}

/* 14. lineups: small samples pool toward their players */
{
  const rows = [{ team: 1, players: [1], off_poss: 1000, def_poss: 1000, adj_net: 20, player_sum: 10 }, { team: 1, players: [2], off_poss: 10, def_poss: 10, adj_net: 40, player_sum: 10 }, { team: 1, players: [3], off_poss: 500, def_poss: 500, adj_net: 0, player_sum: 8 }, { team: 1, players: [4], off_poss: 800, def_poss: 800, adj_net: 30, player_sum: 12 }];
  const info = LU.pool(rows, 13500, 40);
  ok('with real between-lineup variation, a 20-possession lineup barely moves off its player sum and a 2000-possession one moves most of the way', info.tau2 > 0 && rows[1].shrink < 0.1 && rows[0].shrink > 0.5 && Math.abs(rows[1].pooled - 10) < Math.abs(rows[0].pooled - 10), rows.map((r) => r.shrink));
  const flat = [{ team: 1, players: [1], off_poss: 100, def_poss: 100, adj_net: 10.1, player_sum: 10 }, { team: 1, players: [2], off_poss: 100, def_poss: 100, adj_net: 9.9, player_sum: 10 }];
  const i2 = LU.pool(flat, 13000, 5); ok('without detectable lineup variation, lineups sit on their players\' sum', i2.tau2 === 0 && flat.every((r) => r.pooled === r.player_sum));
}

console.log(fail ? `${fail} FAILED, ${pass} passed` : `ALL GREEN (${pass} checks)`);
process.exit(fail ? 1 : 0);
