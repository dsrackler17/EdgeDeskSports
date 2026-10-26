#!/usr/bin/env node
/* ===========================================================================
   NFL PRIOR WEIGHT, STARTER SYNC AND THE LARGE-GAP GATE (docs/nfl-prior-decay/README.md)

     1  prior weight by week: the served schedule is v1's, the card's data
        windows read it, and the experimental QB-anchored decay reproduces
        the schedule its preregistration fixed
     2  starter changes: the quarterback is a per-player input; the starter
        sync's fingerprints move when (and only when) an input that decides
        the starter moves; a played game's start is the passer the game log
        credits, not the schedule feed's stale pre-fill; the injury report is
        an Observed (T0) block with its source and times
     3  KC @ SEA, Oct 25 2026, replayed from committed files: the served card
        to the cent, then the snapshot, the graphic and the research page.
        The card shows each chip's 2025 / 2026 split, says "Large gap vs
        market" with the top chip, and shows no EDGE label, though the same
        quote would otherwise name one.
     4  the gate's rules: strictly more than 5 points, the largest gap of any
        market, the chip that pushes toward EdgeDesk's side, NFL only
     5  the research registration: preregistered before the backtest, holdout
        untouched, three variants counted, experimental, passed false

   Run: node tools/football/nfl_prior_decay.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
require(path.join(ROOT, 'football', 'params.js'));
const E = require(path.join(ROOT, 'football', 'engine.js'));
const V2 = require(path.join(ROOT, 'football', 'nfl_model.js'));
const PV = require(path.join(ROOT, 'football', 'nfl_params_v2.js'));
const D = require('./nfl_prior_diagnosis.js');
const GS = require(path.join(ROOT, 'lib', 'edgedesk_game_snapshot.js'));
const GG = require(path.join(ROOT, 'lib', 'edgedesk_game_graphic.js'));
const SYNC = require(path.join(ROOT, 'football', 'nfl', 'starter_sync.js'));
const INJ = require(path.join(ROOT, 'football', 'injuries', 'fetch_injuries.js'));
const SS = require('./nfl_starter_sync.js');
const M = require('./_module.js');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { ok = false; detail = { threw: String((e && e.stack) || e).slice(0, 400) }; } }
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}
const section = (t) => console.log('  · ' + t);
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

/* ======================================================================== */
section('1. prior weight by week');
{
  const cfg = V2.config(PV.cfg);
  chk('the served schedule is v1’s: EPA ratings 0.9^n, points 0.94^n, every week 0-17', [...Array(18).keys()].every((n) =>
    near(V2.priorWeight(cfg, 'pass_epa_db', n), n ? Math.pow(0.9, n) : 1, 1e-12) && near(V2.priorWeight(cfg, 'pts_for', n), n ? Math.pow(0.94, n) : 1, 1e-12)));
  chk('the served configuration leaves the experimental decay off: no qb_prior_gap term, pd.on false', cfg.pd && cfg.pd.on === false && V2.featureNames(cfg).spread.indexOf('qb_prior_gap') < 0
    && PV.spread.names.indexOf('qb_prior_gap') < 0);

  /* two clubs with n games observed on every rating: the card's windows read the same weights */
  const winAt = (n, starts) => {
    const st = V2.newState(cfg); V2.seasonBreak(st, 2026);
    ['AAA', 'BBB'].forEach((t) => { V2.team(st, t); V2.RATE_FEATS.forEach((f) => { st.team[t][f].n = n; }); st.games[t] = n; st.teamQb[t] = 0.02; });
    st.qb.QA = { v: 0.05, n: 60 + starts }; st.qb.QB = { v: 0.01, n: 40 + starts };
    st.qbSeason = { QA: starts, QB: starts }; st.teamQbSeason = { AAA: starts, BBB: starts };
    const game = { home: 'AAA', away: 'BBB', week: n + 1, home_qb_id: 'QA', away_qb_id: 'QB', home_rest: 7, away_rest: 7 };
    return V2.cardWindows(st, game, V2.predict(st, game, PV));
  };
  const w0 = winAt(0, 0), w6 = winAt(6, 6), w12 = winAt(12, 12);
  chk('Week 1: every team-rating row and the QB row are all 2025', w0.base_strength.prior_share === 1 && w0.passing.prior_share === 1 && w0.quarterback.prior_share === 1);
  chk('after 6 games the passing row is 0.9^6 = 53% 2025, and base strength sits between the EPA (53%) and points (69%) weights',
    near(w6.passing.prior_share, Math.pow(0.9, 6), 1e-9) && w6.base_strength.prior_share >= Math.pow(0.9, 6) - 1e-9 && w6.base_strength.prior_share <= Math.pow(0.94, 6) + 1e-9, w6);
  chk('the window moves toward this season week by week', w0.base_strength.prior_share > w6.base_strength.prior_share && w6.base_strength.prior_share > w12.base_strength.prior_share
    && w6.quarterback.prior_share > w12.quarterback.prior_share);
  chk('home field, context and rest / travel carry no season window', w6.home_field === null && w6.context === null && w6.rest_travel === null);
  chk('the label reads "2025: 53% / 2026: 47%"', GS.windowLabel(w6.passing) === '2025: 53% / 2026: 47%', GS.windowLabel(w6.passing));

  /* the experimental QB-anchored decay (cfg.pd), against its preregistered schedule */
  const PRE = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'research', 'nfl_v2', 'prior_decay', 'preregistration.json'), 'utf8'));
  const sched = PRE.studies[0].decay_schedule.rows;
  const pcfg = V2.config(Object.assign({}, PV.cfg, { pd: { on: true, k_db: 200 } }));
  const gapAt = (n, q0, cur) => {
    const st = V2.newState(pcfg); V2.seasonBreak(st, 2026);
    V2.team(st, 'AAA'); V2.RATE_FEATS.forEach((f) => { st.team.AAA[f].n = n; });
    st.teamQbStart.AAA = 0; st.qbStartVal.QA = q0; st.qbSeasonDev.QA = n ? { s: cur * 35 * n, db: 35 * n } : undefined;
    if (!n) delete st.qbSeasonDev.QA;
    return V2.qbPriorGap(st, 'AAA', 'QA');
  };
  chk('PD: with no dropbacks this season the starter’s value is his pre-season value (shrinkage toward the prior)', near(gapAt(0, 0.1, 0), 0.1, 1e-12));
  chk('PD: the weight left on pre-season QB information reproduces the preregistered schedule (k_db 200, 35 dropbacks a start)',
    sched.every((r) => near(gapAt(r.games_played, 1, 0), r.k200, 0.0006)), sched.map((r) => [r.games_played, r.k200, +gapAt(r.games_played, 1, 0).toFixed(4)]));
  chk('PD: the current-season EPA earns the rest of the weight as the sample grows', sched.every((r) => near(gapAt(r.games_played, 0, 1), Math.pow(0.9, r.games_played) * (35 * r.games_played) / (200 + 35 * r.games_played), 1e-9)));
  chk('PD: an unnamed starter adds nothing', V2.qbPriorGap(V2.newState(pcfg), 'AAA', null) === 0);
  chk('PD: the term only exists when the option is on', V2.featureNames(pcfg).spread.indexOf('qb_prior_gap') >= 0);
}

/* ======================================================================== */
section('2. starter changes');
{
  const injuries = { schema: 'fixture', published: true, season: 2026, retrieved_at: '2026-10-25T11:36:24.722Z', teams: {
    SEA: { week: 7, game_type: 'REG', players: [{ gsis_id: '00-0035704', name: 'Drew Lock', position: 'QB', status: 'Questionable', practice: 'Limited Participation in Practice', injury: 'Shoulder' },
      { gsis_id: '00-0099999', name: 'A Receiver', position: 'WR', status: 'Out', practice: 'Did Not Participate In Practice', injury: 'Hamstring' }] },
    KC: { week: 7, game_type: 'REG', players: [{ gsis_id: '00-0033873', name: 'Patrick Mahomes', position: 'QB', status: null, practice: 'Full Participation in Practice', injury: 'Knee' }] } } };
  const starters = { teams: { sea: { player_id: '00-0034869', status: 'DEPTH_CHART', field_state: 'USABLE' }, kc: { player_id: '00-0033873', status: 'DEPTH_CHART', field_state: 'USABLE' } } };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const fp = (inj, st, feed) => SYNC.sideInputs('SEA', feed || '00-0034869', st || starters, inj || injuries).fingerprint;
  const base = fp();
  const i2 = clone(injuries); i2.teams.SEA.players[0].status = 'Out';
  const i3 = clone(injuries); i3.teams.SEA.players[1].status = 'Questionable';
  const i4 = clone(injuries); i4.teams.SEA.players.push({ gsis_id: '00-0034869', name: 'Sam Darnold', position: 'QB', status: 'Doubtful', practice: 'Did Not Participate In Practice', injury: 'Ribs' });
  const s2 = clone(starters); s2.teams.sea.player_id = '00-0035704';
  chk('fingerprint: a QB’s designation on the report moves it', fp(i2) !== base);
  chk('fingerprint: the starter himself added to the report (DOUBTFUL) moves it', fp(i4) !== base);
  chk('fingerprint: a new depth-chart QB1 moves it', fp(null, s2) !== base);
  chk('fingerprint: the schedule feed re-filling a different QB moves it', fp(null, null, '00-0035704') !== base);
  chk('fingerprint: a non-quarterback’s line does not', fp(i3) === base);

  const slate = { season: 2026, games: [{ game_id: 'G1', home_code: 'SEA', away_code: 'KC', kickoff: '2099-01-01T00:00:00Z',
    starter_inputs: { home: SYNC.sideInputs('SEA', '00-0034869', starters, injuries), away: SYNC.sideInputs('KC', '00-0033873', starters, injuries) } }] };
  const feed = [{ game_id: 'G1', home_qb_id: '00-0034869', away_qb_id: '00-0033873' }];
  chk('the sync: nothing moved, nothing to rebuild', SYNC.staleGames(slate, SS.currentInputs(slate, feed, starters, injuries, Date.parse('2026-10-25T12:00:00Z'))).length === 0);
  const moved = SYNC.staleGames(slate, SS.currentInputs(slate, feed, starters, i4, Date.parse('2026-10-25T12:00:00Z')));
  chk('the sync: Darnold DOUBTFUL on Friday’s report marks Seattle’s side, and only it, for a rebuild', moved.length === 1 && moved[0].side === 'home' && moved[0].reason === 'inputs changed', moved);
  const old = { season: 2026, games: [{ game_id: 'G1', home_code: 'SEA', away_code: 'KC', kickoff: '2099-01-01T00:00:00Z' }] };
  chk('the sync: a slate built before the stamps existed is rebuilt (not stamped)', SYNC.staleGames(old, SS.currentInputs(old, feed, starters, injuries, 0)).every((x) => x.reason === 'not stamped'));
  chk('the sync: a game that kicked off is frozen and never compared', Object.keys(SS.currentInputs({ games: [Object.assign({}, slate.games[0], { kickoff: '2020-01-01T00:00:00Z' })] }, feed, starters, injuries, Date.now())).length === 0);

  const prev = { games: [{ game_id: 'G1', week: 7, home_code: 'SEA', away_code: 'KC', model_home_margin: 4.38, model_home_win_prob: 0.6583,
    home_starter: { player_id: '00-0034869', player_name: 'Sam Darnold', status: 'SCHEDULE_FEED' }, away_starter: { player_id: '00-0033873', player_name: 'Patrick Mahomes', status: 'SCHEDULE_FEED' } }] };
  const next = clone(prev); next.games[0].home_starter = { player_id: '00-0035704', player_name: 'Drew Lock', status: 'INJURY_REPORT_REPLACEMENT' }; next.games[0].model_home_margin = 1.9;
  const ch = SYNC.starterChanges(prev, next);
  chk('a priced-starter change is logged with the number before and after', ch.length === 1 && ch[0].side === 'home' && ch[0].from.player_name === 'Sam Darnold' && ch[0].to.player_name === 'Drew Lock'
    && ch[0].home_margin.before === 4.38 && ch[0].home_margin.after === 1.9, ch);
  chk('…and no change is no row', SYNC.starterChanges(prev, clone(prev)).length === 0);
  const lr = SYNC.ledgerRows(ch, '2026-10-25T12:00:00Z', 'starter inputs changed: G1 home', 2026)[0];
  chk('the ledger row carries its schema, time and trigger', lr.schema === SYNC.SCHEMA_LOG && lr.at && /G1 home/.test(lr.trigger) && lr.season === 2026);
  const nx = clone(next); const nAnn = SYNC.annotate(nx, [lr]);
  chk('the card carries the update, as the NHL card\u2019s goalie update does: "Updated: SEA starter changed from Sam Darnold to Drew Lock" with both versions\u2019 numbers',
    nAnn === 1 && nx.games[0].starter_update.text === 'Updated: SEA starter changed from Sam Darnold to Drew Lock' && nx.games[0].starter_update.home_win_prob.before === 0.6583
    && nx.games[0].starter_update.home_margin.after === 1.9, nx.games[0].starter_update);
  chk('a row from another schema is not an update', SYNC.updateOf({ schema: 'other', game_id: 'G1' }) === null && SYNC.updateOf(null) === null);

  /* the Observed (T0) quarterback report */
  const qbLedger = [{ key: '2026|7|KC|00-0033873', designation: null, practice: 'Full Participation in Practice', observed_at: '2026-10-23T20:15:00Z' }];
  const rm = SYNC.qbReport('KC', '00-0033873', 'Patrick Mahomes', injuries, qbLedger), rd = SYNC.qbReport('SEA', '00-0034869', 'Sam Darnold', injuries, qbLedger);
  chk('QB report: Observed, T0, with its source, the report’s retrieval time and EdgeDesk’s first sight', rm.tier === 'T0' && rm.label === 'Observed' && /NFL official injury report/.test(rm.source)
    && rm.retrieved_at === injuries.retrieved_at && rm.first_seen === '2026-10-23T20:15:00Z' && /not the league|Neither is the league/.test(rm.time_note), rm);
  chk('QB report: designation and practice status as reported (Mahomes: no designation, Full, knee)', rm.listed === true && rm.designation === null && rm.practice_short === 'Full' && rm.injury === 'Knee'
    && rm.text === 'No game designation · practice: Full (Knee) · week-7 report', rm.text);
  chk('QB report: a starter not on the report says so (Darnold, week 7)', rd.listed === false && rd.first_seen === null && /^Not on the week-7 injury report/.test(rd.text), rd);
  const rl = SYNC.qbReport('SEA', '00-0035704', 'Drew Lock', injuries, qbLedger);
  chk('QB report: a designation reads in capitals with its practice line (Lock: QUESTIONABLE, Limited)', rl.designation === 'Questionable' && /^QUESTIONABLE · practice: Limited/.test(rl.text) && rl.first_seen === null, rl);
  chk('QB report: an unpublished season says the report is not on file', SYNC.qbReport('SEA', 'x', 'X', { published: false }, []).available === false);

  /* the quarterback-report ledger (fetch_injuries.js) */
  const ds = { published: true, season: 2026, source: 'fixture', teams: { SEA: { week: 7, game_type: 'REG', players: injuries.teams.SEA.players }, KC: { week: 7, game_type: 'REG', players: injuries.teams.KC.players } } };
  const a1 = INJ.qbObservations([], ds, '2026-10-22T00:00:00Z');
  chk('QB ledger: the first run is a baseline of every QB line, quarterbacks only, tier T0', a1.length === 2 && a1.every((r) => r.baseline && r.tier === 'T0' && r.schema === INJ.QB_OBS_SCHEMA) && !a1.some((r) => r.name === 'A Receiver'), a1);
  chk('QB ledger: nothing new, nothing appended', INJ.qbObservations(a1, ds, '2026-10-23T00:00:00Z').length === 0);
  const ds2 = clone(ds); ds2.teams.KC.players[0].practice = 'Limited Participation in Practice';
  const a2 = INJ.qbObservations(a1, ds2, '2026-10-23T00:00:00Z');
  chk('QB ledger: a practice-only change is a new row with the previous line (the designation ledger would miss it)', a2.length === 1 && !a2[0].baseline && a2[0].previous.practice === 'Full Participation in Practice'
    && INJ.observations([], ds2, 'x').every((r) => r.status !== null), a2);

  /* the board's start history: who took the snaps, not the feed's pre-fill */
  const BT = M.boot({ probe: ['fbNflQbStarts', 'fbNflRegimeFor'] });
  chk('the football module boots', !BT.error, BT.error && String(BT.error.message || BT.error));
  M.loadNflEngine(BT.win, ROOT);
  const T = BT.win.__FBTEST;
  const row = (id, wk, day, away, home, aQb, hQb) => ({ game_id: id, season: '2026', week: String(wk), gameday: day, away_team: away, home_team: home, away_score: '20', home_score: '17',
    away_qb_id: aQb[0], away_qb_name: aQb[1], home_qb_id: hQb[0], home_qb_name: hQb[1], away_coach: 'C', home_coach: 'Macdonald' });
  const LOCK = ['00-0035704', 'Drew Lock'], DARN = ['00-0034869', 'Sam Darnold'], OPP = ['00-0000001', 'Opp QB'];
  const rows = [row('W2', 2, '2026-09-20', 'SEA', 'ARI', LOCK, OPP), row('W3', 3, '2026-09-27', 'SEA', 'WAS', LOCK, OPP), row('W4', 4, '2026-10-04', 'LAC', 'SEA', OPP, LOCK),
    row('W5', 5, '2026-10-11', 'SF', 'SEA', OPP, LOCK), row('W6', 6, '2026-10-18', 'SEA', 'DEN', LOCK, OPP)];
  const qrow = (gid, team, q, db) => ({ game_id: gid, team, position: 'QB', player_id: q[0], player_display_name: q[1], attempts: String(db - 2), sacks_suffered: '2' });
  const log = { W2: [qrow('W2', 'SEA', LOCK, 27)], W3: [qrow('W3', 'SEA', DARN, 45)], W4: [qrow('W4', 'SEA', DARN, 25)], W5: [qrow('W5', 'SEA', DARN, 34)], W6: [qrow('W6', 'SEA', DARN, 56)] };
  const feedOnly = T.fbNflQbStarts(rows), withLog = T.fbNflQbStarts(rows, log);
  chk('the feed alone counts the stale pre-fill (Lock 5 starts, as the board did)', feedOnly.starts.SEA[2026][LOCK[0]].n === 5 && !feedOnly.starts.SEA[2026][DARN[0]]);
  chk('with the game log, a played game is the passer it credits (Darnold 4, Lock 1)', withLog.starts.SEA[2026][DARN[0]].n === 4 && withLog.starts.SEA[2026][LOCK[0]].n === 1, withLog.starts.SEA);
  const up = { home_team: 'SEA', away_team: 'KC', season: '2026', week: '7', home_qb_id: DARN[0], away_qb_id: '00-0033873', home_coach: 'Macdonald', away_coach: 'Reid' };
  const rgOld = T.fbNflRegimeFor({ qbHist: feedOnly, curSeason: 2026 }, up), rgNew = T.fbNflRegimeFor({ qbHist: withLog, curSeason: 2026 }, up);
  chk('the regime line no longer says "regular starter (Drew Lock) out" on KC @ SEA', rgOld.home.regular_starter === 'Drew Lock' && rgOld.home.qb_out === true
    && rgNew.home.regular_starter === 'Sam Darnold' && rgNew.home.qb_out === false, [rgOld.home, rgNew.home]);
  chk('the board re-reads the start history once the game log is in', /S\.qbHist=fbNflQbStarts\(rows,qbByGame\);/.test(fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8')));
}

/* ======================================================================== */
section('3. KC @ SEA, Oct 25 2026, replayed');
const FX = JSON.parse(fs.readFileSync(D.FIXTURE, 'utf8'));
const I = D.loadInputs(FX.games);
const R = D.replay(D.servedState, I).out[D.FOCUS];
const p = R.p;
const rows = Object.fromEntries(p.card.rows.map((r) => [r.key, r]));
{
  chk('the replay is the published card: SEA by 4.38, 65.83% (football/nfl/slate.json, 2026-10-25 21:53Z)', near(p.model.fair_spread, 4.375884, 0.01) && near(p.model.home_win_prob, 0.6583, 0.001), p.model);
  chk('base strength: +2.71 SEA, +3.73 carried from 2025 and −1.02 from 2026', near(rows.base_strength.points, 2.708, 0.02) && near(rows.base_strength.prior, 3.726, 0.02) && near(rows.base_strength.current, -1.018, 0.02), rows.base_strength);
  chk('base strength’s data window: 70% 2025 / 30% 2026', near(rows.base_strength.window.prior_share, 0.701, 0.005), rows.base_strength.window);
  chk('quarterback: KC +1.78, window 49% / 51%', near(rows.quarterback.points, -1.78, 0.02) && near(rows.quarterback.window.prior_share, 0.486, 0.005), rows.quarterback);
  chk('the QB row is per player: pricing Drew Lock instead of Darnold re-reads his own value (−1.78 → −0.22) and fires the regular-starter-out term', (() => {
    const st = D.servedState(); I.games.filter((g) => D.done(g) && g._kick < '2026-10-25T20:20').sort((a, b) => String(a.gameday).localeCompare(String(b.gameday)) || String(a.game_id).localeCompare(String(b.game_id))).forEach((g) => D.absorbInto(st, g, I));
    const lock = D.predict(st, Object.assign({}, R.req, { home_qb_id: '00-0035704' })), term = (pr, k) => pr.contributions.spread.find((t) => t.key === k).points;
    return term(p, 'qb_adj_diff') < -1.5 && term(lock, 'qb_adj_diff') > -0.5 && term(p, 'qb_out_diff') === 0
      && near(term(lock, 'qb_out_diff'), PV.spread.w[PV.spread.names.indexOf('qb_out_diff')], 1e-9) && lock.model.fair_spread !== p.model.fair_spread;
  })());
}
/* the slate row the builder writes (tools/football/build_nfl_slate.js), from this prediction */
const r6 = (v) => (Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : null), r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null), r4 = (v) => (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : null);
const q = p.outcome_range.q;
const slateRow = {
  game_id: D.FOCUS, season: 2026, week: 7, game_type: 'REG', kickoff: '2026-10-26T00:20:00.000Z', home_code: 'SEA', away_code: 'KC', home_team: 'Seattle Seahawks', away_team: 'Kansas City Chiefs',
  venue: 'Lumen Field', roof: 'outdoors', div_game: false, model_status: 'PREDICTED', model_home_margin: r2(p.model.fair_spread), model_home_margin_exact: r6(p.model.fair_spread),
  model_fair_total: r2(p.model.fair_total), model_home_win_prob: r4(p.model.home_win_prob), model_fair_home_ml: p.model.fair_home_ml, model_fair_away_ml: p.model.fair_away_ml,
  outcome_range: { p10: r2(q['0.1']), p50: r2(q['0.5']), p90: r2(q['0.9']), sigma: r2(p.outcome_range.sigma), basis: p.outcome_range.basis },
  contributions: { spread: p.contributions.spread.map((c) => ({ key: c.key, value: r4(c.value), points: r2(c.points) })), ctx: [], total: [] },
  card: { rows: p.card.rows.map((x) => ({ key: x.key, label: x.label, points: r6(x.points), prior: r6(x.prior), current: r6(x.current),
    window: x.window ? { prior_season: x.window.prior_season, season: x.window.season, prior_share: r4(x.window.prior_share), current_share: r4(x.window.current_share) } : null,
    terms: x.terms.map((t) => ({ term: t.term, points: r6(t.points), prior: r6(t.prior), current: r6(t.current) })) })), season_games: p.season_games },
  data_quality: p.data_quality, model_version: p.model_version,
  home_starter: { player_name: 'Sam Darnold', player_id: '00-0034869', source: 'nflverse games.csv', status: 'SCHEDULE_FEED' },
  away_starter: { player_name: 'Patrick Mahomes', player_id: '00-0033873', source: 'nflverse games.csv', status: 'SCHEDULE_FEED' },
  starter_check: { home: { status: 'AGREES', depth_chart: { published_at: '2026-10-25T12:30:46Z' } }, away: { status: 'AGREES', depth_chart: { published_at: '2026-10-25T12:30:46Z' } } },
  home_qb_report: { tier: 'T0', label: 'Observed', listed: false, available: true, report_week: 7, text: 'Not on the week-7 injury report: no game designation and no practice limitation listed.',
    source: 'NFL official injury report (nflverse injuries_2026.csv)', retrieved_at: '2026-10-25T11:36:24.722Z', first_seen: null },
  away_qb_report: { tier: 'T0', label: 'Observed', listed: true, available: true, report_week: 7, designation: null, practice: 'Full Participation in Practice', practice_short: 'Full', injury: 'Knee',
    text: 'No game designation · practice: Full (Knee) · week-7 report', source: 'NFL official injury report (nflverse injuries_2026.csv)', retrieved_at: '2026-10-25T11:36:24.722Z', first_seen: null },
  reference_market: { source: 'nflverse games.csv consensus (reference, not a price, no book, no capture time)', home_line: -3, home_margin: 3, total: 42.5, home_ml: -155, away_ml: 130 }
};
/* the overall-efficiency ranks the slate publishes, from the same state */
const st0 = D.servedState();
I.games.filter((g) => D.done(g) && g._kick < '2026-10-25T20:20').sort((a, b) => String(a.gameday).localeCompare(String(b.gameday)) || String(a.game_id).localeCompare(String(b.game_id))).forEach((g) => D.absorbInto(st0, g, I));
const net = Object.keys(st0.team).filter((t) => st0.games[t] > 0).map((t) => [t, V2.rating(st0, t, 'off_epa_play') - V2.rating(st0, t, 'def_epa_play')]).sort((a, b) => b[1] - a[1]);
const rankOf = (t) => ({ net_epa: { rank: net.findIndex((x) => x[0] === t) + 1, of: net.length } });
const snap = GS.fromNfl(slateRow, { teams: { SEA: { ranks: rankOf('SEA') }, KC: { ranks: rankOf('KC') } }, generated_at: '2026-10-25T21:53:59.162Z', source: 'football/nfl/slate.json' });
const ins = Object.fromEntries((snap.insights || []).map((i) => [i.id, i]));
{
  chk('the snapshot passes its own checks', snap.checks.ok, snap.checks.failed);
  chk('Team Strength chip: "Seahawks #2 vs #7", SEA +2.7 in the number', ins.strength && /#2 vs #7/.test(ins.strength.short) && ins.strength.effect && ins.strength.effect.label === 'SEA +2.7', ins.strength);
  chk('Team Strength chip shows its data window: 2025: 70% / 2026: 30%', ins.strength.effect.window_label === '2025: 70% / 2026: 30%', ins.strength.effect);
  chk('…and its season split, toward SEA: +3.7 carried from 2025, −1.0 from 2026, in its words too', ins.strength.effect.split_label === 'SEA +2.7: +3.7 carried from 2025, −1.0 from 2026'
    && ins.strength.text.indexOf(ins.strength.effect.split_label) > 0, [ins.strength.effect.split_label, ins.strength.text]);
  chk('Quarterback chip: KC +1.8 with its window, 2025: 49% / 2026: 51%', ins.term_quarterback && ins.term_quarterback.effect.label === 'KC +1.8' && ins.term_quarterback.effect.window_label === '2025: 49% / 2026: 51%', ins.term_quarterback && ins.term_quarterback.effect);
  chk('Known limitations: Team Strength leans on 2025; the quarterback chip (51% 2026) is not listed', (snap.limitations || []).length === 1 && /^Known limitation: Team Strength \(2025: 70% \/ 2026: 30%\) relies more on the carried 2025 prior than on 2026 games/.test(snap.limitations[0])
    && !/Quarterback/.test(snap.limitations[0]), snap.limitations);
  chk('the quarterbacks carry the injury report as Observed (T0)', snap.qb.away.report && snap.qb.away.report.tier === 'T0' && snap.qb.away.report.practice_short === 'Full' && snap.qb.home.report.listed === false);

  /* the gate against Kalshi (SEA 58.5%, KC 41.5%) */
  const ks = { state: 'OK', close: false, snapshot_at: '2026-10-25T21:54:59Z', home: { mid: 0.585 }, away: { mid: 0.415 } };
  const gK = GS.gapGate(snap, GS.gateMarkets({ kalshi: ks }));
  chk('KC @ SEA vs Kalshi: 65.8% against 58.5%, 7.3 points: gated', gK.gated && gK.gap_pp === 7.3 && gK.toward === 'home' && gK.market.kind === 'KALSHI', gK);
  chk('…the top contributing chip is Team Strength (base strength, SEA +2.7), with its 2025 / 2026 split and window', gK.chip && gK.chip.key === 'base_strength' && gK.chip.title === 'Team Strength'
    && gK.chip.split_label === 'SEA +2.7: +3.7 carried from 2025, −1.0 from 2026' && gK.chip.window_label === '2025: 70% / 2026: 30%', gK.chip);
  chk('…in one sentence a reader can act on', /^Large gap vs market: EdgeDesk has SEA at 65\.8%, the market 58\.5% \(Kalshi mid, both teams, no-vig\), 7\.3 points apart\. Top contributing chip: Team Strength, SEA \+2\.7: \+3\.7 carried from 2025, −1\.0 from 2026 \(data window 2025: 70% \/ 2026: 30%\)\. No edge is shown/.test(gK.text), gK.text);
  const gC = GS.gapGate(snap, GS.gateMarkets({ kalshi: ks, consensus: snap.consensus }));
  chk('with the consensus too (−155/+130, 58.3% no-vig) the largest gap decides: 7.5 points', gC.gated && gC.gap_pp === 7.5 && gC.market.kind === 'CONSENSUS', gC);

  /* the graphic, beside a live DraftKings quote that on its own would name an edge (SEA −2.5: 1.9 pts) */
  const t0 = Date.parse('2026-10-25T22:00:00Z');
  const live = GS.market({ home_line: -2.5, total: 42.5, ml_home: -148, ml_away: 124, book: 'draftkings', captured_at: '2026-10-25T21:50:00Z' }, { now: t0 });
  const spec = GS.graphicSpec(snap);
  const c = GG.content(spec, live, { now: t0, kalshi: Object.assign({}, ks, { home: Object.assign({ snapshot_at: '2026-10-25T21:54:59Z', spread: 0.02, ml: -141 }, ks.home), away: Object.assign({ snapshot_at: '2026-10-25T21:54:59Z', spread: 0.02, ml: 141 }, ks.away) }) }).content;
  const keep = GG.GATE_LEAGUES; GG.GATE_LEAGUES = {};
  const ungated = GG.content(spec, live, { now: t0 }).content; GG.GATE_LEAGUES = keep;
  chk('control: without the gate this quote names an edge, "EDGE: SEA −2.5"', ungated.edge && ungated.edge.headline === 'SEA −2.5', ungated.edge);
  chk('graphic: gated, so no EDGE label: the headline is withheld (and recorded as what it would have been)', c.gate && c.edge && c.edge.headline === null && c.edge.gated === 'SEA −2.5', [c.gate, c.edge]);
  const texts = (f) => GG.layout(c, f).ops.filter((o) => o.type === 'text').map((o) => o.text);
  chk('graphic: the table reads LARGE GAP VS MARKET and no EDGE: text is drawn, square or portrait', ['square', 'portrait'].every((f) => texts(f).indexOf('LARGE GAP VS MARKET') >= 0 && !texts(f).some((t) => /^EDGE: /.test(t))));
  /* the largest gap on this card is the DraftKings moneyline (−148/+124, 57.2% no-vig): 8.6 points */
  chk('graphic: the note beside the times names the largest gap and the chip, with its window', /^Large gap vs market \(8\.6 pts\) · top chip TEAM STRENGTH SEA \+2\.7 · 2025: 70% \/ 2026: 30%$/.test(c.compare.kalshi.note) && texts('square').indexOf(c.compare.kalshi.note) >= 0 && c.gate.market.kind === 'BOOK', c.compare.kalshi.note);
  chk('graphic: each chip on What to watch for shows its data window', c.insights.some((i) => /TEAM STRENGTH/.test(i.title) && / Data 2025: 70% \/ 2026: 30%\.$/.test(i.text)), c.insights.map((i) => i.text));
  chk('graphic: the alt text says "Large gap vs market", never "Edge:"', GG.altText(c).indexOf('Large gap vs market: EdgeDesk has SEA at 65.8%') >= 0 && !/Edge: /.test(GG.altText(c)));

  /* the research page, rendered in a stub DOM */
  const ctx = { console, Math, Date, JSON, Promise, setTimeout, clearTimeout, Intl, Number, String, Object, Array, isFinite, parseFloat, encodeURIComponent, decodeURIComponent };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
  ctx.document = { getElementById: () => null, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }), head: { appendChild() {} }, body: { appendChild() {} } };
  /* the same game after a logged starter change: the card says so, with both versions' win % */
  const snapU = GS.fromNfl(Object.assign({}, slateRow, { game_id: D.FOCUS + '_UPD', starter_update: SYNC.updateOf({ schema: SYNC.SCHEMA_LOG, at: '2026-10-25T20:15:00Z', game_id: D.FOCUS, side: 'home', team: 'SEA',
    trigger: 'starter inputs changed: 2026_07_KC_SEA home', from: { player_name: 'Sam Darnold', status: 'SCHEDULE_FEED' }, to: { player_name: 'Drew Lock', status: 'INJURY_REPORT_REPLACEMENT' },
    home_win_prob: { before: 0.6583, after: 0.6436 }, home_margin: { before: 4.38, after: 4.16 } }) }), { teams: { SEA: { ranks: rankOf('SEA') }, KC: { ranks: rankOf('KC') } }, generated_at: '2026-10-25T21:53:59.162Z' });
  chk('the snapshot carries the starter update only when the slate does', !snap.starter_update && snapU.starter_update && snapU.starter_update.text === 'Updated: SEA starter changed from Sam Darnold to Drew Lock');
  const DATA = { generated_at: '2026-10-25T23:08:09Z', games: [snap, snapU] };
  ctx.fetch = async () => ({ ok: true, json: async () => DATA });
  vm.createContext(ctx);
  ['lib/edgedesk_calc.js', 'lib/edgedesk_football_lines.js', 'lib/football_identity.js', 'lib/edgedesk_game_snapshot.js', 'lib/edgedesk_game_graphic.js', 'lib/edgedesk_game_view.js']
    .forEach((f) => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f }));
  const el = { innerHTML: '', addEventListener() {} };
  const krow = (yes, opp, mid) => ({ sport: 'nfl', game_id: D.FOCUS, event_ticker: 'KXNFLGAME-KCSEA', market_ticker: 'KXNFLGAME-KCSEA-' + yes.slice(0, 3), kalshi_yes_name: yes, yes_team: yes, opponent: opp,
    home_team: 'Seattle Seahawks', away_team: 'Kansas City Chiefs', pregame: true, state: 'OK', yes_mid: mid, spread: 0.02, volume: 900, snapshot_at: '2026-10-25T21:54:59Z', match_confidence: 'high' });
  ctx.EDGameView.mount(el, { dataUrl: '/x.json',
    market: () => ({ market: { home_line: -2.5, total: 42.5, ml_home: -148, ml_away: 124, book: 'draftkings', captured_at: new Date(Date.now() - 600000).toISOString() }, decision: { decision: 'LEAN', label: 'LEAN', reason: 'fixture' } }),
    kalshi: () => ({ state: 'ok', rows: [krow('Kansas City Chiefs', 'Seattle Seahawks', 0.415), krow('Seattle Seahawks', 'Kansas City Chiefs', 0.585)] }) });
  const wait = () => new Promise((r) => setTimeout(r, 30));
  const page = ctx.EDGameView.open('nfl', D.FOCUS).then(wait).then(() => el.innerHTML);
  module.exports.page = page.then((html) => ctx.EDGameView.open('nfl', D.FOCUS + '_UPD').then(wait).then(() => ({ html, upd: el.innerHTML })));
}

/* ======================================================================== */
section('4. the gate’s rules');
{
  const mk = (h, a) => ({ model: { available: true, win_prob: { home: h, away: 1 - h } }, home: { name: 'Home', abbr: 'HOM' }, away: { name: 'Away', abbr: 'AWY' },
    drivers: { rows: [{ key: 'home_field', label: 'Home field', signed: 2.5 }, { key: 'base_strength', label: 'Base team strength', signed: a, prior: a + 1, current: -1 }] } });
  const m50 = [{ kind: 'X', source: 'x', side: 'home', p: 0.50 }];
  chk('exactly 5.0 points is not gated', GS.gapGate(mk(0.55, 1), m50).gated === false);
  chk('5.1 points is', GS.gapGate(mk(0.551, 1), m50).gated === true);
  chk('the largest gap among the markets decides', GS.gapGate(mk(0.6, 1), [{ side: 'home', p: 0.57, source: 'a', kind: 'A' }, { side: 'home', p: 0.52, source: 'b', kind: 'B' }]).market.kind === 'B');
  chk('a one-team Kalshi quote on the away side is compared on that side', GS.gapGate(mk(0.6, 1), [{ side: 'away', p: 0.47, source: 'k', kind: 'KALSHI' }]).gap_pp === 7);
  chk('the chip is the row pushing hardest toward EdgeDesk’s side, home field only when no other row does', GS.gapGate(mk(0.6, 1), m50).chip.key === 'base_strength'
    && GS.gapGate(mk(0.6, -1), m50).chip.key === 'home_field' && GS.gapGate(mk(0.4, -1), m50).chip.key === 'base_strength');
  chk('no market, or no projection: no gate', GS.gapGate(mk(0.6, 1), []) === null && GS.gapGate({ model: { available: false } }, m50) === null);
  chk('the gate covers NFL cards only; college keeps its 7-point Kalshi note', GG.GATE_LEAGUES.nfl === 1 && !GG.GATE_LEAGUES.cfb && GG.LARGE_GAP_PP === 7 && GS.GAP_GATE_PP === 5);
}

/* ======================================================================== */
section('5. the research registration');
{
  const DIR = path.join(ROOT, 'football', 'research', 'nfl_v2', 'prior_decay');
  const PRE = JSON.parse(fs.readFileSync(path.join(DIR, 'preregistration.json'), 'utf8')), RES = JSON.parse(fs.readFileSync(path.join(DIR, 'results.json'), 'utf8'));
  const S = PRE.studies[0];
  chk('preregistration: the content hash covers the study as registered', crypto.createHash('sha256').update(JSON.stringify(PRE.studies)).digest('hex') === PRE.content_sha256);
  chk('preregistration: the schedule, the promotion criteria and the variants were fixed before the run', S.decay_schedule.rows.length >= 10 && S.promotion_criteria.stage_a_validation.length === 5
    && S.variants.length === S.variants_planned && PRE.registered_at < RES.generated_at, [PRE.registered_at, RES.generated_at]);
  chk('the run is the registered one: same hash, every planned variant, counted in the forking-paths disclosure', RES.preregistration.content_sha256 === PRE.content_sha256 && RES.variants_tried === S.variants_planned
    && S.forking_paths.comparisons_made === RES.variants_tried);
  chk('the holdout is untouched: no 2025 game predicted, every logged row says so', RES.holdout_looked === false && fs.readFileSync(path.join(ROOT, 'football', 'research', 'nfl_v2', 'results', 'variants.jsonl'), 'utf8')
    .split('\n').filter((l) => /"family":"prior_decay"/.test(l)).every((l) => JSON.parse(l).holdout_looked === false));
  chk('experimental, passed false, and the verdict follows the registered rule', RES.verdict.status === 'EXPERIMENTAL' && RES.verdict.passed === false
    && RES.verdict.finalist === Object.values(RES.verdict.checks).every((x) => x === true));
  chk('compared with v1 on CLV and Brier', Number.isFinite(RES.incumbent.valid.brier) && RES.incumbent.clv && RES.incumbent.clv.n > 400 && RES.variants.every((v) => Number.isFinite(v.valid.brier) && v.clv && v.clv.n > 400));
  const G = require('./build_nfl_prior_decay_sql.js'), SQL = fs.readFileSync(G.OUT, 'utf8');
  chk('the registry SQL is current with the documents', SQL === G.build());
  chk('…registers EXPERIMENTAL and never validated, and its result row says passed false', /pg_temp\.edr_label\(v, c, array\['experimental'\]\)/.test(SQL) && !/'validated'/.test(SQL)
    && /"passed":false/.test(SQL) && /"verdict":"(REJECTED|FINALIST)"/.test(SQL));
  chk('…never updates or deletes a registry row', !/\b(update|delete from|truncate)\b[^;]*research_model/i.test(SQL));
  const { findPgBin, startCluster } = require(path.join(ROOT, 'tools', 'collective', 'pg_harness.js'));
  const BIN = findPgBin();
  if (!BIN) console.log('NOTE | no postgres binary: the registry was not applied');
  else {
    const pg = startCluster(BIN, 'pdtest');
    if (!pg.ok) console.log('NOTE | could not start postgres: ' + pg.why);
    else {
      const run = (db, sql) => { const f = path.join(os.tmpdir(), 'pd_' + process.pid + '_' + Math.random().toString(36).slice(2) + '.sql'); fs.writeFileSync(f, sql); const s = pg.stage(f); fs.unlinkSync(f); return pg.psql('-d ' + db + ' -X -A -t -v ON_ERROR_STOP=1 -f ' + s); };
      pg.psql('-d postgres -q -c "create database pd_a"');
      run('pd_a', `create type public.evidence_provenance as enum ('T0', 'T1', 'T2', 'T3');
        create type public.model_status as enum ('experimental', 'validating', 'validated', 'retired');
        create table public.research_models (id uuid primary key default gen_random_uuid(), model_key text unique not null, name text not null, sport text, provenance public.evidence_provenance not null, objective text, created_at timestamptz not null default now());
        create table public.research_model_versions (id bigserial primary key, model_id uuid not null references public.research_models (id), version text not null, status public.model_status not null default 'experimental',
          training_window daterange, validation_window daterange, holdout_window daterange, objective text, min_sample integer, success_metric text, forking_paths jsonb, promotion_criteria jsonb, spec jsonb, created_at timestamptz not null default now());
        create table public.research_model_results (id bigserial primary key, version_id bigint references public.research_model_versions (id), passed boolean, metrics jsonb, computed_at timestamptz not null default now());
        create view public.research_model_current as select m.model_key, v.version, v.status, r.passed from public.research_models m join public.research_model_versions v on v.model_id = m.id left join public.research_model_results r on r.version_id = v.id;`);
      const a1 = run('pd_a', SQL), a2 = run('pd_a', SQL);
      const got = run('pd_a', "select v.version || '|' || v.status || '|' || coalesce(r.passed::text, 'null') || '|' || (v.forking_paths ->> 'comparisons_made') || '|' || (select count(*) from public.research_model_results) from public.research_models m join public.research_model_versions v on v.model_id = m.id left join public.research_model_results r on r.version_id = v.id;");
      chk('PostgreSQL: one experimental version, one result row passed false, three comparisons; applying it again writes nothing', a1.status === 0 && a2.status === 0 && got.out.trim() === S.machine.version + '|experimental|false|3|1', [a1.out.slice(-300), got.out]);
      if (pg.stop) pg.stop();
    }
  }
}

module.exports.page.then((pages) => {
  const html = pages.html;
  section('3b. the research page');
  chk('page: after a logged starter change it says so, with both versions\u2019 win %', pages.upd.indexOf('<b>Updated: SEA starter changed from Sam Darnold to Drew Lock</b> · SEA win 65.8% → 64.4%') > 0 && html.indexOf('Updated: SEA starter changed') < 0);
  chk('page: the "Large gap vs market" panel, with the top chip, its season split and window', /<b>Large gap vs market<\/b>/.test(html) && html.indexOf('Top contributing chip: Team Strength') > 0
    && html.indexOf('SEA +2.7: +3.7 carried from 2025, −1.0 from 2026') > 0 && html.indexOf('data window 2025: 70% / 2026: 30%') > 0);
  chk('page: each chip shows its data window', html.indexOf('<span class="gv-win"') > 0 && html.indexOf('Data window: 2025: 70% / 2026: 30%') > 0 && html.indexOf('Data window: 2025: 49% / 2026: 51%') > 0);
  chk('page: the Known limitations line', html.indexOf('<b>Known limitations.</b> Known limitation: Team Strength (2025: 70% / 2026: 30%)') > 0);
  chk('page: the decision layer’s LEAN is withheld and the status says so; no EDGE label anywhere', html.indexOf('The decision layer’s label is withheld') > 0 && html.indexOf('withheld · large gap vs market') > 0
    && !/<b>LEAN<\/b>/.test(html) && !/EDGE: /.test(html));
  chk('page: the quarterbacks with the injury report as Observed · T0, source and retrieval time', html.indexOf('Observed · T0') > 0 && html.indexOf('NFL official injury report (nflverse injuries_2026.csv)') > 0 && /retrieved /.test(html));
}).catch((e) => chk('the research page renders', false, String(e && e.stack || e))).then(() => {
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 700) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'NFL prior weight, starter sync and large-gap gate — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
});
