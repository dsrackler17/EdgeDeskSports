#!/usr/bin/env node
'use strict';
/* ===========================================================================
   The new brains (basketball, soccer, MLB), the shared protocol, the board's
   settlement and sensitivity rules, the registry's ladder — offline.

   Proves: the protocol's rules (one season can never validate; a challenger
   needs 0.001); the ingests drop what they say (preseason, exhibitions,
   unplayed) and keep a missing result missing; the pack fills only what the
   source lacks; each model behaves (a stronger home side is favoured, ratings
   never see their own game, Dixon-Coles quarter lines split, run
   distributions sum to 1); the board prices a quarter line exactly as two
   half stakes, returns the stake on a void, and marks a qualifier FRAGILE
   when a scenario, a worse tick or another reference breaks it; every
   committed record is leak-free, retrospective, never market-tested, and
   chose its model by the rule; the registry's ladder is computed for all 12
   sports and no value claim is on.

   Run: node tools/lab/lab.test.js
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const R = (p) => require(path.join(ROOT, p));
let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) { pass++; return; } fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); }
const near = (a, b, e) => Math.abs(a - b) <= (e || 1e-9);

/* 1. the protocol */
const P = R('engine/lab/protocol.js');
ok('Phi and CRPS are right', near(P.Phi(0), 0.5, 1e-6) && near(P.Phi(1.959964), 0.975, 1e-5) && near(P.crpsNormal(0, 1, 0), 2 * 0.3989423 - 1 / Math.sqrt(Math.PI), 1e-5));
const good = { n: 5000, calibration_in_the_large: 0.001, calibration_slope: 1.0 };
ok('one season can never validate, however good', P.binaryStatus(good, 1, true).status === 'PROVISIONAL' && P.binaryStatus(good, 2, true).status === 'OUTCOME_VALIDATED');
ok('n < 1000, a bad slope or no win over the baseline each fail', P.binaryStatus(Object.assign({}, good, { n: 999 }), 3, true).status === 'PROVISIONAL' && P.binaryStatus(Object.assign({}, good, { calibration_slope: 0.8 }), 3, true).status === 'PROVISIONAL' && P.binaryStatus(good, 3, false).status === 'PROVISIONAL');
ok('a distribution needs 80% coverage near 80%', P.distributionStatus({ n: 5000, coverage_80: 0.7, mean_bias: 0, mean_outcome: 200 }, 3, true).status === 'PROVISIONAL' && P.distributionStatus({ n: 5000, coverage_80: 0.80, mean_bias: 0.1, mean_outcome: 200 }, 3, true).status === 'OUTCOME_VALIDATED');
ok('a challenger must beat the incumbent by 0.001', P.choose({ a: 0.600, b: 0.5995 }, ['a', 'b']) === 'a' && P.choose({ a: 0.600, b: 0.5989 }, ['a', 'b']) === 'b');

/* 2. basketball */
const BI = R('basketball/ingest.js'); const BC = R('basketball/config.js');
const row = (o) => Object.assign({ game_id: 1, date: '2025-01-10T00:30Z', season: 2025, season_type: 2, neutral_site: false, status_type_name: 'STATUS_FINAL', status_type_completed: true, status_period: 4, format_regulation_periods: 4, home_id: 1, home_display_name: 'A', away_id: 2, away_display_name: 'B', home_score: 100, away_score: 90, notes_headline: '' }, o);
const nb = BI.normalise([row({}), row({ game_id: 2, season_type: 1 }), row({ game_id: 3, notes_headline: 'NBA All-Star Game' }), row({ game_id: 4, status_type_name: 'STATUS_POSTPONED', status_type_completed: false }), row({ game_id: 5, home_score: null }), row({ game_id: 6, status_period: 5 }), row({ game_id: 7, status_type_name: 'STATUS_SCHEDULED', status_type_completed: false })], 2025, false);
ok('basketball: preseason, all-star, postponed and score-less games are dropped and counted', nb.games.length === 2 && nb.stats.preseason === 1 && nb.stats.exhibition === 1 && nb.stats.not_played === 2 && nb.stats.missing_score === 1, nb.stats);
ok('basketball: overtime from the period count; a late tip keeps its evening date; known_at blank, RETRO', nb.games.find((g) => g.game_id === '6').ot === 1 && nb.games[0].date === '2025-01-09' && nb.games.every((g) => g.known_at === '' && g.pit === 'RETRO'));
ok('basketball: a SCHEDULED row is kept only for the season in progress', BI.normalise([row({ status_type_name: 'STATUS_SCHEDULED', status_type_completed: false })], 2027, true).games.length === 1);
const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'basketball', 'data', 'ncaaw', 'manifest.json'), 'utf8'));
ok('basketball: the pack fills only what the source lacks (2024-25 women: 209 added, 3,384 already there)', man.seasons['2025'].pack.added === 209 && man.seasons['2025'].pack.already_in_source === 3384);
const BM = R('basketball/model.js');
const pr = new BM.PointsRatings({ half_life_days: 60, prior_games: 2, carry: 0.6 });
pr.startSeason(2025);
const gm = []; for (let d = 0; d < 20; d++) gm.push({ home_id: 'S', away_id: d % 2 ? 'W' : 'M', hs: 110, as: 95, neutral: 0 }, { home_id: d % 2 ? 'M' : 'W', away_id: 'S', hs: 98, as: 108, neutral: 0 });
for (let d = 0; d < 20; d++) pr.absorbDay(d, gm.slice(d * 2, d * 2 + 2));
ok('basketball: a team that beats everyone is favoured home and away', pr.expect('S', 'W', 0).margin > 5 && pr.expect('W', 'S', 0).margin < 0 && pr.expect('S', 'W', 1).margin < pr.expect('S', 'W', 0).margin);
const W = R('basketball/walkforward.js');
const syn = []; let t0 = Date.parse('2024-11-01T23:00:00Z');
for (let i = 0; i < 60; i++) { const s = new Date(t0 + i * 6 * 3600e3).toISOString().replace('.000Z', 'Z'); syn.push({ game_id: 'g' + i, season: 2025, type: 'R', date: new Date(Date.parse(s) - 10 * 3600e3).toISOString().slice(0, 10), start_utc: s, neutral: 0, home_id: 'T' + (i % 4), away_id: 'T' + ((i + 1) % 4), hs: 100 + (i % 7), as: 98, assumed_available_at: new Date(Date.parse(s) + 4 * 3600e3).toISOString() }); }
const ps = W.pass(syn, {}, {});
ok('basketball: the pass is causal — no input known at or after its prediction (games 6 h apart, results known 4 h after)', R('engine/validation.js').leakageAudit(ps.rows.map((r) => ({ id: r.id, predicted_at: r.predicted_at, event_start: r.start, inputs_known_at: r.inputs_known_at }))).violations === 0);
const BS = R('basketball/build_slate.js');
const ou = BS.overUnder(220.2, 18, 220);
ok('basketball: a whole-number line has a push; the three outcomes sum to 1', ou.push > 0.01 && near(ou.over + ou.push + ou.under, 1, 1e-9) && BS.overUnder(220.2, 18, 220.5).push === 0);

/* 3. soccer */
const SI = R('soccer/ingest.js');
ok('soccer: club names normalise across seasons, and different clubs stay apart', SI.clubKey('Arsenal FC') === SI.clubKey('Arsenal') && SI.clubKey('FC Internazionale Milano') === SI.clubKey('Inter') && SI.clubKey('Paris FC') !== SI.clubKey('Paris Saint-Germain') && SI.clubKey('Manchester City FC') !== SI.clubKey('Manchester United FC') && SI.clubKey('Sheffield United') !== SI.clubKey('Sheffield Wednesday'));
const sn = SI.normalise({ matches: [{ date: '2026-09-01', team1: 'A FC', team2: 'B FC', score: { ft: [2, 1], ht: [1, 0] } }, { date: '2026-09-02', team1: 'C', team2: 'D' }, { date: '2026-12-01', team1: 'E', team2: 'F', score: [] }] }, 'epl', 2027, '2026-10-13');
ok('soccer: a played match without a score is RESULT_MISSING (never guessed); a future one SCHEDULED', sn.rows.map((r) => r.status).join() === 'FINAL,RESULT_MISSING,SCHEDULED' && sn.rows[1].hg === '' && sn.rows[0].assumed_available_at === '2026-09-01T23:59:00Z');
const SM = R('soccer/model.js');
const dc = new SM.DixonColes({}); dc.lambdas = () => ({ lh: 1.5, la: 1.1 });
const mk = SM.markets(dc.score(null, null, -0.05));
ok('soccer: the score matrix sums to 1 and 1X2 sums to 1', near(mk.home + mk.draw + mk.away, 1, 1e-9) && near(Object.values(mk.diff).reduce((a, b) => a + b, 0), 1, 1e-9));
const mk0 = SM.markets(dc.score(null, null, 0));
ok('soccer: a negative rho adds draws (Dixon-Coles)', mk.draw > mk0.draw);
const ah = SM.asian({ '-1': 0.3, '0': 0.3, '1': 0.25, '2': 0.15 }, -0.25);
ok('soccer: -0.25 is two half stakes — a draw is a half loss', ah.split && near(ah.half_loss, 0.3) && near(ah.full_win, 0.4) && near(ah.full_loss, 0.3));
const Q = R('engine/quant.js');
ok('soccer: the quarter line\'s EV matches the pack\'s split-settlement formula', near(Q.expectedSplitProfit(1.95, ah.full_win, ah.half_win, ah.push, ah.half_loss, ah.full_loss), 0.4 * 0.95 - 0.15 - 0.3, 1e-9));

/* 4. MLB */
const MI = R('mlb/history/ingest.js');
const line = '"20230330","0","Thu","MIL","NL",1,"CHN","NL",1,0,4,51,"D","","","","CHI11",36054,141,"000000000","00400000x",' + Array(56).fill('0').join(',') + ',"kulpr901","Ron Kulpa","blasc901","Cory Blaser","torrc901","Carlos Torres","viscj901","Jansen Visconti","","(none)","","(none)","counc001","Craig Counsell","rossd001","David Ross","strom001","Marcus Stroman","burnc002","Corbin Burnes","","(none)","swand001","Dansby Swanson","burnc002","Corbin Burnes","strom001","Marcus Stroman"';
const gl = MI.parseGameLog(line + '\n', 2023);
ok('mlb: a Retrosheet game log line maps to home, scores, park and both starters', gl.rows.length === 1 && gl.rows[0].home === 'CHN' && gl.rows[0].away === 'MIL' && gl.rows[0].hs === 4 && gl.rows[0].as === 0 && gl.rows[0].park === 'CHI11' && gl.rows[0].sp_home === 'strom001' && gl.rows[0].sp_away === 'burnc002', gl.rows[0]);
const p24 = MI.fromPack2024();
ok('mlb: 2024 from the pack is the regular season only, with no starters invented', p24.stats.kept >= 2400 && p24.rows.every((r) => r.sp_home === '' && r.sp_away === '') && p24.stats.not_regular > 0);
const MM = R('mlb/history/model.js');
const nbp = MM.nbPmf(4.5, 6, 60);
ok('mlb: the negative binomial sums to 1 with the right mean', near(nbp.reduce((a, b) => a + b, 0), 1, 1e-6) && near(nbp.reduce((a, p, k) => a + p * k, 0), 4.5, 1e-3));
const gg = MM.game(5, 4, 8, 0.52);
ok('mlb: the stronger side is favoured and the run line is below the moneyline', gg.p_home > 0.5 && gg.home_rl < gg.p_home);

/* 5. the board */
const XB = R('lib/edgedesk_xboard.js');
const now = Date.parse('2026-10-13T12:00:00Z');
const reg = { sports: [{ id: 'x', label: 'X', readiness: { markets: { moneyline: { state: 'MARKET_VALIDATED', value_claims: true, reason: 'ok' }, 'lg.spread': { state: 'MARKET_VALIDATED', value_claims: true, reason: 'ok' } } } }] };
const cand = (o) => Object.assign({ sport_id: 'x', sport_label: 'X', event_key: 'E' + Math.random(), event: { start_utc: '2026-10-14T00:00:00Z', label: 'A @ B' }, market: { kind: 'moneyline', side: 'A' }, quote: { book: 'b', american: 110, captured_at: '2026-10-13T11:50:00Z' }, model: { p_win: 0.56, method: 'MODEL', sd: 0.005 }, market_ref: { p_novig: 0.5, method: 'sharp' }, data: { state: 'FRESH', lineup_certainty: 'CONFIRMED' } }, o);
const split = { type: 'split', full_win: 0.4, half_win: 0, push: 0, half_loss: 0.3, full_loss: 0.3 };
const sb = XB.evaluate({ candidates: [cand({ market: { kind: 'asian_handicap', registry_key: 'lg.spread', side: 'A', line: -0.25 }, model: { settlement: split, method: 'MODEL', sd: 0.005 }, market_ref: null, quote: { book: 'b', american: -105, captured_at: '2026-10-13T11:50:00Z' } })], registry: reg, now });
const sc = sb.candidates[0];
ok('board: a quarter line is priced as its exact half-stake equivalent (raw EV = the pack formula)', near(sc.ev_raw, Q.expectedSplitProfit(XB.amToDec(-105), 0.4, 0, 0, 0.3, 0.3), 1e-4) && sc.settlement && sc.settlement.split, { ev: sc.ev_raw, settlement: sc.settlement });
ok('board: the value gate reads the league-keyed registry market', sc.gates.some((g) => g.gate === 'VALUE' && g.ok));
const vb = XB.evaluate({ candidates: [cand({ model: { p_win: 0.5, p_void: 0.1, method: 'MODEL', sd: 0.005 } })], registry: reg, now }).candidates[0];
ok('board: a void returns the stake (EV = p_win·(d-1) - p_loss over the non-void share)', near(vb.ev_raw, 0.45 * 1.1 - 0.45, 1e-4), vb.ev_raw);
const at102 = { book: 'b', american: 102, captured_at: '2026-10-13T11:50:00Z' };
const fr = XB.evaluate({ candidates: [cand({ quote: at102, model: { p_win: 0.56, method: 'MODEL', sd: 0.004, scenarios: [{ label: 'backup goalie', p_win: 0.47 }] } })], registry: reg, now }).candidates[0];
ok('board: a qualifier that a worse scenario breaks is FRAGILE, not qualified', fr.status === 'FRAGILE' && fr.gates.some((g) => g.gate === 'SENSITIVITY' && !g.ok), { status: fr.status, s: fr.sensitivity });
const rb = XB.evaluate({ candidates: [cand({ quote: at102, model: { p_win: 0.56, method: 'MODEL', sd: 0.004, scenarios: [{ label: 'alt', p_win: 0.55 }] } })], registry: reg, now }).candidates[0];
ok('board: a robust qualifier survives every check and says so', rb.status === 'QUALIFIED' && rb.sensitivity.every((x) => x.survives) && rb.sensitivity.length >= 2, rb.sensitivity);
ok('board: one tick worse crosses the even line correctly', XB.worseTick(102) === -103 && XB.worseTick(-110) === -115 && XB.worseTick(150) === 145);

/* 6. committed records */
const recs = [['basketball/validation/nba_walkforward.json', ['points', 'points_rest']], ['basketball/validation/wnba_walkforward.json', ['points', 'points_rest']], ['basketball/validation/ncaam_walkforward.json', ['points', 'points_rest']], ['basketball/validation/ncaaw_walkforward.json', ['points', 'points_rest']],
  ['soccer/validation/epl_walkforward.json', ['poisson', 'dixon_coles', 'poisson_cal', 'dixon_coles_cal']], ['soccer/validation/bundesliga_walkforward.json', ['poisson', 'dixon_coles', 'poisson_cal', 'dixon_coles_cal']], ['soccer/validation/laliga_walkforward.json', ['poisson', 'dixon_coles', 'poisson_cal', 'dixon_coles_cal']], ['soccer/validation/seriea_walkforward.json', ['poisson', 'dixon_coles', 'poisson_cal', 'dixon_coles_cal']], ['soccer/validation/ligue1_walkforward.json', ['poisson', 'dixon_coles', 'poisson_cal', 'dixon_coles_cal']],
  ['mlb/history/validation/mlb_walkforward.json', ['team', 'team_park', 'team_park_sp']]];
for (const [f, order] of recs) {
  let r = null; try { r = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')); } catch (_) {}
  if (!r) { ok(f + ' exists', false); continue; }
  ok(f + ': leak-free, retrospective, never market-tested', r.leakage.violations === 0 && r.leakage.checked > 1000 && r.data.temporal.point_in_time === 'RETROSPECTIVE' && Object.values(r.markets).every((m) => m.market_status === 'NOT_TESTED'));
  ok(f + ': the chosen model is the selection rule\'s', r.selection.chosen === P.choose(r.selection.ll, order), r.selection);
  ok(f + ': a validated market had >= 1000 games over >= 2 confirmation seasons', Object.values(r.markets).every((m) => m.status !== 'OUTCOME_VALIDATED' || (m.n >= 1000 && r.windows.confirmation.seasons >= 2)));
}
const ufc = JSON.parse(fs.readFileSync(path.join(ROOT, 'engine', 'lab', 'ufc_elo.json'), 'utf8'));
ok('ufc: one year is measured as INSUFFICIENT, never a model', ufc.markets.moneyline.status === 'INSUFFICIENT' && ufc.data.scored < 1000);

/* 7. the registry */
const reg2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'engine', 'registry.json'), 'utf8'));
ok('registry: all 12 sports carry the computed ladder', reg2.sports.length === 12 && reg2.sports.every((s) => s.readiness.ladder && ['data_loaded', 'model_trained', 'validation_passed', 'market_tested'].every((k) => typeof s.readiness.ladder[k].done === 'boolean')));
ok('registry: no value claim is on anywhere (nothing beat a close)', reg2.value_claims_enabled.length === 0 && reg2.sports.every((s) => !s.readiness.value_claims_any));
ok('registry: a validated headline names the markets it covers', reg2.sports.filter((s) => s.readiness.state === 'OUTCOME_VALIDATED').every((s) => s.readiness.scope.length > 0 && s.readiness.label.indexOf(s.readiness.scope[0]) > 0));
ok('registry: a sport without a model is never validated (UFC, college baseball)', ['mma', 'college_baseball'].every((id) => reg2.sports.find((s) => s.id === id).readiness.state === 'RESEARCH_ONLY'));
const board = JSON.parse(fs.readFileSync(path.join(ROOT, 'engine', 'board.json'), 'utf8'));
ok('board: PASS with no fresh price, and every soccer row is held on stale data or research', board.verdict === 'PASS' && board.candidates.filter((c) => c.sport_id === 'soccer').every((c) => c.status === 'RESEARCH'));

console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'lab — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
