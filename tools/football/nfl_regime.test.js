#!/usr/bin/env node
/* ===========================================================================
   THE NFL REGIME SIGNAL, THE STARTER THE MODEL PRICES, AND THE NEUTRAL SITE
   (second follow-up to the 2026-09-30 audit: item 4, and the orientation /
   home-field check of item 3).

     1  the regime fit's provenance: walk-forward, validation 2016-2023, the
        2024-2025 holdout scored once and never fitted, significance stated
        from the interval, promoted only when the holdout interval excludes
        zero — and today it does not, so the adjustment prices nothing
     2  the engine: a neutral site removes exactly the fitted home-field
        intercept and nothing else; the regime state never reaches a number;
        the starter and site notes are stated beside the number
     3  the board's helpers (app.html, the real module): the site, the regime
        text, the quality line
     4  the real slate builder on fixture feeds: a starter listed OUT is priced
        with the club's most recent other starter (PENDING until the game's own
        week is reported), DOUBTFUL too, QUESTIONABLE is not, nobody to name is
        STARTER_UNKNOWN; each side's regime signal; an international venue the
        feed marked Home is priced neutral and says so
     5  the committed slate and the neutral-site report

     node tools/football/nfl_regime.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const M = require('./_module.js');
const B = require('./build_nfl_slate.js');

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { detail = String(e && e.stack || e).slice(0, 400); ok = false; } }
  if (ok) { pass++; return; }
  fail++; failures.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : ''));
}
function section(t) { console.log('  · ' + t); }
const near = (a, b, tol) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= (tol == null ? 1e-9 : tol);
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const R = require(path.join(ROOT, 'football', 'nfl', 'regime_nfl.js'));
const REP = JSON.parse(read('football/research/report/nfl_regime.json'));
const PY = read('football/research/nfl_regime.py');
const NS = JSON.parse(read('football/research/report/nfl_neutral_site.json'));

/* ======================================================================== */
section('1. the regime fit');
{
  const shipped = Object.keys(REP.shipped_coefficients).filter((k) => k !== 'intercept');
  chk('the artifact carries the report\'s shipped fit, coefficient for coefficient',
    shipped.length === Object.keys(R.coefficients).length && shipped.every((k) => R.coefficients[k] === REP.shipped_coefficients[k]), R.coefficients);
  chk('the signals are the three the audit named: a new head coach, a new starting QB, the regular starter out',
    ['hc_new_early', 'hc_new_late', 'qb_new_early', 'qb_new_late', 'qb_out'].every((k) => typeof R.coefficients[k] === 'number') && R.early_weeks === 6);
  chk('validation 2016-2023; the 2024 and 2025 holdout scored once',
    REP.validation_seasons === '2016-2023' && REP.holdout_seasons.join(',') === '2024,2025' && REP.holdout_scored === true && !!REP.holdout);
  chk('no parameter was fitted on 2024-2025: each holdout season was predicted with the fit through 2023, which is the shipped fit',
    ['2024', '2025'].every((s) => JSON.stringify(REP.coefficients_by_season[s]) === JSON.stringify(REP.shipped_coefficients)), REP.coefficients_by_season['2024']);
  chk('walk-forward: the validation seasons were each predicted with a fit on the seasons before them (the coefficients move season to season)',
    JSON.stringify(REP.coefficients_by_season['2016']) !== JSON.stringify(REP.coefficients_by_season['2023']));
  const sig = (x) => x.significant === (x.regime_subset.delta_ci95[1] < 0);
  chk('significance is read off the 95% interval, validation and holdout alike', sig(REP.validation) && sig(REP.holdout) && sig(REP.holdout.by_season['2024']) && sig(REP.holdout.by_season['2025']));
  chk('promoted exactly when the holdout regime subset beats the model with an interval that excludes zero',
    R.promoted === REP.promoted && REP.promoted === REP.holdout.significant);
  chk('…and said plainly: the holdout interval includes zero, so the adjustment is NOT promoted and prices nothing',
    R.promoted === false && REP.holdout.regime_subset.delta_ci95[0] < 0 && REP.holdout.regime_subset.delta_ci95[1] > 0, REP.holdout.regime_subset);
  chk('the record the board shows is the report\'s own', JSON.stringify(R.record.holdout) === JSON.stringify(REP.holdout) && JSON.stringify(R.record.validation) === JSON.stringify(REP.validation));
  chk('the bootstrap is numpy\'s generator, not the short-period LCG that narrowed the earlier intervals', /np\.random\.default_rng/.test(PY) && !/1103515245/.test(PY));
  const fn = (name) => { const a = PY.indexOf('def ' + name + '('); const b = PY.indexOf('\ndef ', a + 1); return PY.slice(a, b < 0 ? undefined : b); };
  chk('the market is never an input: no line or price enters the signals or the design', !/spread_line|total_line|moneyline|odds/.test(fn('signals') + fn('design')));
  chk('the signals are known before kickoff: this season\'s regular starter is counted from the games BEFORE this one',
    /n_prev = sum\(starts\.values\(\)\)/.test(fn('signals')) && fn('signals').indexOf('starts[r.qb] = starts.get(r.qb, 0) + 1') > fn('signals').indexOf('qb_out = r.qb != regular'));
  chk('no NFL plausibility table is built here (the EV plausibility check ships once, for both sports)',
    !/plausibility_table|nfl_plausibility/.test(PY) && !fs.existsSync(path.join(ROOT, 'football', 'nfl', 'plausibility.js')));
}

/* ======================================================================== */
const BT = M.boot({ probe: ['fbNflNeutral', 'fbNflSiteNote', 'fbNflGameReq', 'fbNflQbStarts', 'fbNflReconcileStarters', 'fbNflRegimeFor', 'fbNflRegimeText', 'fbNflOpenGames', 'fbQualityLine', 'fbPredict'] });
chk('the football module boots', !BT.error, BT.error && String(BT.error.message || BT.error));
M.loadNflEngine(BT.win, ROOT);
const W = BT.win, T = W.__FBTEST, E = W.EDFootball;
/* the page's own escaper lives in an earlier script block; load the real line */
(function () {
  const at = BT.app.indexOf('function _escHtml(');
  if (at < 0) { console.error('app.html no longer defines _escHtml'); process.exit(1); }
  require('vm').runInContext(BT.app.slice(at, BT.app.indexOf('\n', at)), W);
})();
const P = W.EDFootballParams.nfl;
const H = P.w_spread[P.w_spread.length - 1];

section('2. the engine');
{
  const st = E.nfl.newState();
  const game = { home: 'WAS', away: 'IND', week: 4, home_rest: 7, away_rest: 7, roof: 'outdoors', surface: 'grass', div_game: 0, home_qb_id: '00-0032268', away_qb_id: '00-0035710' };
  const a = E.nfl.predict(st, game), b = E.nfl.predict(st, Object.assign({}, game, { neutral: true }));
  chk('a neutral site removes exactly the fitted home-field intercept (w_spread\'s last weight) from the spread', near(a.koerner_spread - b.koerner_spread, H, 1e-12), [a.koerner_spread, b.koerner_spread, H]);
  chk('…and nothing else: the context adjustment and the total are unchanged', a.ctx_adj === b.ctx_adj && a.sharp_total === b.sharp_total);
  const base = (p) => p.terms.spread.find((t) => t.key === 'baseline');
  chk('the baseline term says what was applied: the intercept at home, 0 at a neutral site (its fitted weight still shown)',
    base(a).points === H && base(b).points === 0 && base(b).weight === H);
  const sum = (p) => p.terms.spread.reduce((s, t) => s + t.points, 0);
  chk('the terms still reconcile to the spread, home and neutral', near(sum(a), a.koerner_spread, 1e-9) && near(sum(b), b.koerner_spread, 1e-9));
  chk('a game not marked neutral keeps the home field (neutral must be exactly true)', E.nfl.predict(st, Object.assign({}, game, { neutral: 'yes' })).koerner_spread === a.koerner_spread);

  const req = (g) => ({ sport: 'nfl', state: st, season: 2026, game: g, market: {} });
  const regime = { home: { team: 'WAS', qb_out: true, active: true, adjustment_pts: -2.2 }, away: { team: 'IND', hc_new: true, active: true, adjustment_pts: -1.49 }, promoted: false };
  const p0 = E.predictGame(req(game)), p1 = E.predictGame(req(Object.assign({}, game, { regime })));
  chk('the regime state never reaches a number: the projection is identical with and without it',
    p0.status === 'PREDICTED' && p1.status === 'PREDICTED' && p0.model.fair_spread === p1.model.fair_spread && p0.model.fair_total === p1.model.fair_total && p0.model.home_win_prob === p1.model.home_win_prob);
  const note = 'WAS starter: Jayden Daniels is OUT (Elbow) on the week-3 injury report; priced with Marcus Mariota.';
  const site = 'SITE: priced as a neutral site.';
  const p2 = E.predictGame(req(Object.assign({}, game, { home_qb_note: note, site_note: site })));
  chk('the starter note and the site note are stated beside the number', p2.data_quality.warnings.indexOf(note) >= 0 && p2.data_quality.warnings.indexOf(site) >= 0);
  chk('…and are never a number', p2.model.fair_spread === p0.model.fair_spread);
  const p3 = E.predictGame(req(Object.assign({}, game, { home_qb_id: null })));
  chk('an unknown starter is priced at the club\'s carried quarterback level and says so (not withheld)', p3.status === 'PREDICTED' && p3.data_quality.warnings.indexOf('home QB starter unknown') >= 0);
}

/* ======================================================================== */
section('3. the board\'s helpers');
{
  W.FB.nfl.intlVenues = { 'tottenham hotspur stadium': 1, 'wembley stadium': 1 };
  chk('location = Neutral is a neutral site', T.fbNflNeutral({ location: 'Neutral', stadium: 'Somewhere' }) === true);
  chk('an international venue the feed marked Home is a neutral site', T.fbNflNeutral({ location: 'Home', stadium: 'Tottenham Hotspur Stadium' }) === true);
  chk('a domestic Home game is not', T.fbNflNeutral({ location: 'Home', stadium: 'Northwest Stadium' }) === false);
  chk('the SITE note is written only when the board overrode the feed', /^SITE: .*Tottenham Hotspur Stadium is an international venue/.test(T.fbNflSiteNote({ location: 'Home', stadium: 'Tottenham Hotspur Stadium' }) || '')
    && T.fbNflSiteNote({ location: 'Neutral', stadium: 'Tottenham Hotspur Stadium' }) === null && T.fbNflSiteNote({ location: 'Home', stadium: 'Northwest Stadium' }) === null);
  W.FB.nfl.intlVenues = null;
  chk('without the venue table, only the feed\'s own designation counts (no guess)', T.fbNflNeutral({ location: 'Home', stadium: 'Tottenham Hotspur Stadium' }) === false);
  const g = { home_team: 'WAS', away_team: 'IND', week: '4', location: 'Neutral', home_qb_id: 'x', away_qb_id: 'y', home_qb_note: 'n', _regime: { promoted: false } };
  const rq = T.fbNflGameReq(g);
  chk('the game request carries the site, the notes and the regime state', rq.neutral === true && rq.site_note === null && rq.home_qb_note === 'n' && rq.away_qb_note === null && rq.regime === g._regime);

  const text = T.fbNflRegimeText({ home: { team: 'WAS', active: true, qb_out: true, qb_new: true, regular_starter: 'Jayden Daniels', adjustment_pts: -2.2 },
    away: { team: 'IND', active: false, hc_new: false, adjustment_pts: 0 }, promoted: false });
  chk('the regime text names the side, the reason and the fitted adjustment, and says it is not priced',
    /^REGIME \(not priced: the fitted adjustment did not clear the holdout\)/.test(text) && /WAS: regular starter \(Jayden Daniels\) out, new starting QB \(fitted -2\.2 pts\)/.test(text) && !/IND/.test(text), text);
  chk('no active side, no text', T.fbNflRegimeText({ home: { active: false }, away: { active: false }, promoted: false }) === null);
  chk('a tie for the most starts is stated as a tie, not as a "regular starter" who is out',
    /ATL: no settled starter this season \(the most starts are tied\)/.test(T.fbNflRegimeText({ home: { team: 'ATL', active: true, qb_out: true, regular_tied: true, regular_starter: 'Cooper Rush', adjustment_pts: -2.33 }, away: null, promoted: false }) || ''));
  const ql = T.fbQualityLine({ data_quality: { warnings: ['w1'] }, _regime: { home: { team: 'WAS', active: true, hc_new: true, adjustment_pts: -1.49 }, away: null, promoted: false } });
  chk('the card\'s quality line carries it', /w1 · REGIME/.test(ql) && /WAS: new head coach/.test(ql), ql);
}

/* ======================================================================== */
section('4. the real slate builder on fixture feeds');
const HEAD = 'game_id,season,game_type,week,gameday,weekday,gametime,away_team,away_score,home_team,home_score,location,result,total,overtime,old_game_id,gsis,nfl_detail_id,pfr,pff,espn,ftn,away_rest,home_rest,away_moneyline,home_moneyline,spread_line,away_spread_odds,home_spread_odds,total_line,under_odds,over_odds,div_game,roof,surface,temp,wind,away_qb_id,home_qb_id,away_qb_name,home_qb_name,away_coach,home_coach,referee,stadium_id,stadium';
const DAN = ['00-0039910', 'Jayden Daniels'], MAR = ['00-0032268', 'Marcus Mariota'], JON = ['00-0035710', 'Daniel Jones'];
const DAK = ['00-0033077', 'Dak Prescott'], HUR = ['00-0036389', 'Jalen Hurts'], TEN1 = ['00-0099001', 'Tennessee Starter'], LAW = ['00-0038122', 'Trevor Lawrence'];
function row(id, season, week, day, away, aScore, home, hScore, loc, aQb, hQb, aCoach, hCoach, stadium) {
  return [id, season, 'REG', week, day, 'Sunday', '13:00', away, aScore, home, hScore, loc, '', '', '', '', '', '', '', '', '', '', 7, 7, '', '', '', '', '', '', '', '', 0, 'outdoors', 'grass', '', '',
    aQb[0], hQb[0], aQb[1], hQb[1], aCoach, hCoach, '', '', stadium].join(',');
}
const QUINN = 'Dan Quinn', STEICHEN = 'Shane Steichen', NEWIND = 'New Colts Coach', MOORE = 'Moore', SCHOTT = 'Schottenheimer', SIRI = 'Sirianni', CALLA = 'Callahan', COEN = 'Coen';
const GAMES = [HEAD,
  /* 2025: Daniels 3 Washington starts, Mariota 1; Jones is the Colts' starter under Steichen */
  row('2025_01_NYG_WAS', 2025, 1, '2025-09-07', 'NYG', 6, 'WAS', 21, 'Home', ['00-0000001', 'Giants QB'], DAN, 'Daboll', QUINN, 'Northwest Stadium'),
  row('2025_02_WAS_GB', 2025, 2, '2025-09-14', 'WAS', 18, 'GB', 27, 'Home', DAN, ['00-0000002', 'Packers QB'], QUINN, 'LaFleur', 'Lambeau Field'),
  row('2025_03_LV_WAS', 2025, 3, '2025-09-21', 'LV', 24, 'WAS', 41, 'Home', ['00-0000003', 'Raiders QB'], MAR, 'Carroll', QUINN, 'Northwest Stadium'),
  row('2025_04_WAS_ATL', 2025, 4, '2025-09-28', 'WAS', 27, 'ATL', 34, 'Home', DAN, ['00-0000004', 'Falcons QB'], QUINN, 'Morris', 'Mercedes-Benz Stadium'),
  row('2025_01_MIA_IND', 2025, 1, '2025-09-07', 'MIA', 8, 'IND', 33, 'Home', ['00-0000005', 'Dolphins QB'], JON, 'McDaniel', STEICHEN, 'Lucas Oil Stadium'),
  row('2025_02_DEN_IND', 2025, 2, '2025-09-14', 'DEN', 28, 'IND', 29, 'Home', ['00-0000006', 'Broncos QB'], JON, 'Payton', STEICHEN, 'Lucas Oil Stadium'),
  row('2025_03_IND_TEN', 2025, 3, '2025-09-21', 'IND', 41, 'TEN', 20, 'Home', JON, TEN1, STEICHEN, CALLA, 'Nissan Stadium'),
  row('2025_04_DAL_PHI', 2025, 4, '2025-09-28', 'DAL', 20, 'PHI', 24, 'Home', DAK, HUR, SCHOTT, SIRI, 'Lincoln Financial Field'),
  row('2025_05_PHI_JAX', 2025, 5, '2025-10-05', 'PHI', 21, 'JAX', 20, 'Home', HUR, LAW, SIRI, COEN, 'EverBank Stadium'),
  /* 2026: the feed names Daniels for week 3 as well, as the real feed did (he was OUT) */
  row('2026_01_WAS_PHI', 2026, 1, '2026-09-13', 'WAS', 22, 'PHI', 24, 'Home', DAN, HUR, QUINN, SIRI, 'Lincoln Financial Field'),
  row('2026_02_WAS_DAL', 2026, 2, '2026-09-20', 'WAS', 20, 'DAL', 37, 'Home', DAN, DAK, QUINN, SCHOTT, 'AT&T Stadium'),
  row('2026_03_SEA_WAS', 2026, 3, '2026-09-27', 'SEA', 31, 'WAS', 33, 'Home', ['00-0035704', 'Drew Lock'], DAN, 'Macdonald', QUINN, 'Northwest Stadium'),
  row('2026_01_HOU_IND', 2026, 1, '2026-09-13', 'HOU', 10, 'IND', 20, 'Home', ['00-0000007', 'Texans QB'], JON, 'Ryans', NEWIND, 'Lucas Oil Stadium'),
  row('2026_02_IND_TEN', 2026, 2, '2026-09-20', 'IND', 17, 'TEN', 13, 'Home', JON, TEN1, NEWIND, MOORE, 'Nissan Stadium'),
  row('2026_03_IND_CLE', 2026, 3, '2026-09-27', 'IND', 24, 'CLE', 21, 'Home', JON, ['00-0000008', 'Browns QB'], NEWIND, 'Stefanski', 'Huntington Bank Field'),
  /* upcoming */
  row('2026_04_IND_WAS', 2026, 4, '2026-10-04', 'IND', '', 'WAS', '', 'Neutral', JON, DAN, NEWIND, QUINN, 'Tottenham Hotspur Stadium'),
  row('2026_04_DAL_TEN', 2026, 4, '2026-10-04', 'DAL', '', 'TEN', '', 'Home', DAK, TEN1, SCHOTT, MOORE, 'Nissan Stadium'),
  row('2026_05_PHI_JAX', 2026, 5, '2026-10-11', 'PHI', '', 'JAX', '', 'Home', HUR, LAW, SIRI, COEN, 'Tottenham Hotspur Stadium'),
  row('2026_05_NYG_WAS', 2026, 5, '2026-10-11', 'NYG', '', 'WAS', '', 'Home', ['00-0000001', 'Giants QB'], DAN, 'Harbaugh', QUINN, 'Northwest Stadium'),
].join('\n');
const INJ = JSON.stringify({ schema: 'fixture', season: 2026, latest_week: 4, teams: {
  WAS: { week: 3, game_type: 'REG', players: [{ gsis_id: DAN[0], name: DAN[1], position: 'QB', status: 'Out', injury: 'Elbow' }] },
  DAL: { week: 4, game_type: 'REG', players: [{ gsis_id: DAK[0], name: DAK[1], position: 'QB', status: 'Questionable', injury: 'Ankle' }] },
  TEN: { week: 4, game_type: 'REG', players: [{ gsis_id: TEN1[0], name: TEN1[1], position: 'QB', status: 'Doubtful', injury: 'Knee' }] },
  PHI: { week: 4, game_type: 'REG', players: [] } } });
const VENUES = read('football/venues/nfl_stadiums.json');
const NOW = Date.parse('2026-10-01T12:00:00Z');
function fixtures(inj) {
  return async (u) => (/games\.csv/.test(u) ? GAMES : /injuries\/nfl_2026\.json/.test(u) ? inj : /venues\/nfl_stadiums\.json/.test(u) ? VENUES : '');
}
/* offline: the fixture build must never write the committed forecast store (football/venues/forecasts.json) */
const buildOpts = (inj) => ({ now: NOW, lookahead: 12, offline: true, fetchText: fixtures(inj), coachingSeed: { schema: 'fixture-empty-seed', teams: {} },
  coachingValidation: { schema: 'fixture', status: 'CANDIDATE', affects_projection: false, tuned_cap: 1, selected_cap: 0, selected_reliability_k: 4, verdict: {}, reason: 'fixture' } });

(async () => {
  const art = await B.build(buildOpts(INJ));
  const G = (id) => art.games.find((x) => x.game_id === id);
  const iw = G('2026_04_IND_WAS'), dt = G('2026_04_DAL_TEN'), pj = G('2026_05_PHI_JAX'), nw = G('2026_05_NYG_WAS');
  chk('the four upcoming fixture games are on the slate and priced', [iw, dt, pj, nw].every((g) => g && g.model_status === 'PREDICTED'), art.games.map((g) => [g.game_id, g.model_status, g.model_reason]));

  const hs = iw && iw.home_starter;
  chk('Washington: Daniels, OUT on the week-3 report, is not priced; the club\'s most recent other starter is (Mariota, last season)',
    hs && hs.player_name === 'Marcus Mariota' && hs.player_id === MAR[0] && hs.scheduled.player_name === 'Jayden Daniels' && hs.scheduled.status === 'Out' && hs.basis === '1 start in 2025', hs);
  chk('…PENDING, because the week-4 report is not filed yet (the week-3 report is the latest)', hs && hs.status === 'INJURY_REPORT_REPLACEMENT_PENDING' && hs.scheduled.report_week === 3);
  const w = (g) => (g && g.data_quality && g.data_quality.warnings) || [];
  chk('the substitution is stated beside the number', w(iw).some((x) => /^WAS starter: Jayden Daniels is OUT \(Elbow\) on the week-3 injury report and the week-4 report is not filed yet \(pending\); priced with Marcus Mariota \(1 start in 2025\)/.test(x)), w(iw));
  chk('a later Washington game the feed pre-filled with Daniels is reconciled the same way (every unplayed game, not only the board\'s window)',
    nw && nw.home_starter && nw.home_starter.player_name === 'Marcus Mariota' && nw.home_starter.status === 'INJURY_REPORT_REPLACEMENT_PENDING');
  chk('QUESTIONABLE is not a substitution: Dallas keeps the feed\'s starter', dt && dt.away_starter && dt.away_starter.status === 'SCHEDULE_FEED' && dt.away_starter.player_name === 'Dak Prescott');
  chk('DOUBTFUL is, and with no other starter on record it is STARTER_UNKNOWN: priced at the carried level, said so',
    dt && dt.home_starter && dt.home_starter.status === 'STARTER_UNKNOWN' && dt.home_starter.player_id === null && dt.qb_known && dt.qb_known.home === false
      && w(dt).indexOf('home QB starter unknown') >= 0 && w(dt).some((x) => /no named starter/.test(x)), dt && [dt.home_starter, w(dt)]);
  chk('the count of substitutions is a note on the slate', art.notes.some((n) => /^3 upcoming NFL starters were listed OUT or DOUBTFUL/.test(n)), art.notes);

  const rg = iw && iw.regime;
  chk('each game carries both sides\' regime state and the artifact version', rg && rg.home && rg.away && rg.version === R.version && rg.promoted === false);
  chk('Washington: the regular starter out and a new starting QB (Mariota is not last season\'s primary starter), same head coach',
    rg && rg.home.qb_out === true && rg.home.qb_new === true && rg.home.hc_new === false && rg.home.active === true && rg.home.regular_starter === 'Jayden Daniels' && rg.home.last_season_starter === 'Jayden Daniels', rg && rg.home);
  chk('…its adjustment is the fitted coefficients for week 4 (early), rounded', rg && rg.home.adjustment_pts === Math.round((R.coefficients.qb_new_early + R.coefficients.qb_out) * 100) / 100, rg && rg.home.adjustment_pts);
  chk('…with a clear regular starter (Daniels, 3 feed starts): not a tie', rg && rg.home.regular_tied === false);
  chk('Indianapolis: a new head coach, the same quarterback', rg && rg.away.hc_new === true && rg.away.qb_new === false && rg.away.qb_out === false && rg.away.active === true
    && rg.away.adjustment_pts === Math.round(R.coefficients.hc_new_early * 100) / 100, rg && rg.away);
  chk('the regime is shown and not priced: the number is the engine\'s without it', iw && iw.contributions && !iw.contributions.spread.some((c) => /regime/.test(c.key)));

  const baseline = (g) => (g && g.contributions && g.contributions.spread.find((c) => c.key === 'baseline') || {}).points;
  chk('a location = Neutral game (Colts @ Commanders, Tottenham) has no home field', baseline(iw) === 0 && !w(iw).some((x) => /^SITE:/.test(x)));
  chk('an international venue the feed marked Home (Eagles @ Jaguars, Tottenham) is priced neutral and says why', baseline(pj) === 0 && w(pj).some((x) => /^SITE: the schedule feed marks this game Home, but Tottenham Hotspur Stadium is an international venue/.test(x)), w(pj));
  chk('a domestic home game keeps the fitted home field', baseline(nw) === Math.round(H * 100) / 100, baseline(nw));

  /* the injury report unreadable: nothing substituted, and the slate says so */
  const art2 = await B.build(buildOpts(''));
  const iw2 = art2.games.find((x) => x.game_id === '2026_04_IND_WAS');
  chk('without the injury report every starter is the feed\'s, and the slate says a starter listed OUT is not caught',
    iw2 && iw2.home_starter && iw2.home_starter.status === 'SCHEDULE_FEED' && iw2.home_starter.player_name === 'Jayden Daniels'
      && art2.notes.some((n) => /injury report could not be read/.test(n)));

  /* ====================================================================== */
  section('5. the committed slate and the neutral-site report');
  const SL = JSON.parse(read('football/nfl/slate.json'));
  const pred = (SL.games || []).filter((g) => g.model_status === 'PREDICTED');
  const STATUSES = ['SCHEDULE_FEED', 'INJURY_REPORT_REPLACEMENT', 'INJURY_REPORT_REPLACEMENT_PENDING', 'STARTER_UNKNOWN'];
  chk('every predicted game in the committed slate carries its regime state and the status of each priced starter (' + pred.length + ' games)',
    pred.length > 0 && pred.every((g) => g.regime && g.regime.version === R.version && g.regime.promoted === false
      && ['home_starter', 'away_starter'].every((s) => g[s] === null || STATUSES.indexOf(g[s].status) >= 0)), pred.filter((g) => !g.regime).map((g) => g.game_id));
  const was = pred.find((g) => g.game_id === '2026_04_IND_WAS');
  chk('Colts @ Commanders (if on the slate): Daniels is not the priced starter, and no home field at Tottenham',
    !was || (was.home_starter && was.home_starter.player_name !== 'Jayden Daniels' && /^INJURY_REPORT_REPLACEMENT/.test(was.home_starter.status)
      && (was.contributions.spread.find((c) => c.key === 'baseline') || {}).points === 0), was && [was.home_starter, was.contributions && was.contributions.spread[0]]);
  const phj = pred.find((g) => g.game_id === '2026_05_PHI_JAX');
  chk('Eagles @ Jaguars (if on the slate): neutral, with the SITE note', !phj || ((phj.contributions.spread.find((c) => c.key === 'baseline') || {}).points === 0
    && (phj.data_quality.warnings || []).some((x) => /^SITE:/.test(x))));
  const BS = read('tools/football/build_nfl_slate.js');
  chk('the builder publishes the starter it priced and the regime state through the same functions the board uses',
    /home_starter: starterOf\(g, 'home'\)/.test(BS) && /away_starter: starterOf\(g, 'away'\)/.test(BS) && /regime: g\._regime \|\| null/.test(BS));

  chk('the neutral-site report: the feed\'s own Neutral games, walk-forward predictions, the intercept it removes is the shipped one',
    NS.data.sites === 'nflverse games.csv location = Neutral' && NS.data.games >= 60 && near(NS.intercept_removed_pts, Math.round(H * 1000) / 1000, 1e-9), NS.data);
  chk('…the nominal home side finished under the number there (a misapplied home field)', NS.mean_residual_at_neutral_sites < 0 && NS.mean_residual_ci95[1] < 0, NS.mean_residual_ci95);
  chk('…and the MAE gain is NOT significant, said plainly', NS.mae.significant === false && NS.mae.delta_ci95[0] < 0 && NS.mae.delta_ci95[1] > 0 && /^NOT significant/.test(NS.decision), NS.mae);
  const ENG = read('football/engine.js');
  const cited = /the MAE moved (-?\d+\.\d+), 95% CI \[(-?\d+\.\d+), \+?(-?\d+\.\d+)\]/.exec(ENG);
  chk('the engine\'s comment cites the report\'s own numbers', cited && near(+cited[1], Math.round(NS.mae.delta * 100) / 100, 1e-9)
    && near(+cited[2], Math.round(NS.mae.delta_ci95[0] * 100) / 100, 1e-9) && near(+cited[3], Math.round(NS.mae.delta_ci95[1] * 100) / 100, 1e-9), cited && cited.slice(1));
  const NSJ = read('football/research/nfl_neutral_site.js');
  chk('the report\'s bootstrap is the full-period generator', /Math\.imul\(s, 1664525\) \+ 1013904223\) >>> 0/.test(NSJ) && !/1103515245/.test(NSJ));

  console.log((fail ? 'FAILED ' : 'ALL GREEN ') + 'NFL regime, starter and site — ' + pass + ' passed, ' + fail + ' failed');
  if (fail) { failures.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
})().catch((e) => { console.log('FAILED ' + (e && e.stack || e)); process.exit(1); });
