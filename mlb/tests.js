#!/usr/bin/env node
/* ===========================================================================
   THE BASEBALL RUN MODEL, CHECKED.

   WHAT THIS SUITE CAN AND CANNOT SAY. It cannot say the model is right,
   because being right about a baseball game means beating a closing line and
   EdgeDesk holds no baseball line archive to measure that against. Every
   assertion below is a SELF-CONSISTENCY check: that the arithmetic is the
   arithmetic the model card describes, that a probability is a probability,
   that league-average inputs return the league average, that the guard bounds
   fire, and that nothing silently becomes NaN.

   That distinction is the point. A suite that passed here and was reported as
   "validated" would be the exact failure this repository exists not to make.

   Run: node mlb/tests.js      (npm run mlb:model)
   =========================================================================== */
'use strict';

require('./params.js');
const E = require('./engine.js');
const P = global.EDBaseballParams;

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; return true; }
  fail++; failures.push({ name, detail }); return false;
}
function eq(name, got, want) { return chk(name, got === want, { got, want }); }
function near(name, got, want, tol) {
  const d = Math.abs(Number(got) - Number(want));
  return chk(name, Number.isFinite(d) && d <= (tol == null ? 1e-9 : tol), { got, want, tol });
}
function gt(name, got, want) { return chk(name, Number(got) > Number(want), { got, want }); }
function lt(name, got, want) { return chk(name, Number(got) < Number(want), { got, want }); }

/* every finite number in a payload — the NaN sweep below walks this */
function walkNumbers(o, path, out) {
  out = out || [];
  if (o === null || o === undefined) return out;
  if (typeof o === 'number') { out.push([path, o]); return out; }
  if (Array.isArray(o)) { o.forEach((v, i) => walkNumbers(v, path + '[' + i + ']', out)); return out; }
  if (typeof o === 'object') { Object.keys(o).forEach((k) => walkNumbers(o[k], path + '.' + k, out)); return out; }
  return out;
}

/* ---- fixtures -------------------------------------------------------- */
const LG = 4.45;
function avgClub(name) {
  return {
    name: name,
    offense: { runs_per_game: LG, games: 140 },
    defense: { runs_allowed_per_game: LG, games: 140 },
    /* an ERA that lands exactly on the league RA9 once the unearned-run
       conversion is applied, so an "average" club really is average */
    starter: { name: name + ' starter', era: LG / P.mlb.era_to_ra9, fip: LG / P.mlb.era_to_ra9,
      xera: LG / P.mlb.era_to_ra9, ip: 150 },
    bullpen: { taxed: [] }
  };
}
function baseReq(over) {
  return Object.assign({
    season: 2025,
    league: { runs_per_game: LG },
    home: avgClub('Home'),
    away: avgClub('Away'),
    park: { run_factor: 100, is_dome: false },
    weather: null,
    market: {}
  }, over || {});
}

console.log('— params and metadata —');
chk('params published', !!P && typeof P.model_version === 'string');
eq('model version', E.version(), P.model_version);
chk('meta reports no walk-forward record', E.meta().validation.walk_forward === false);
chk('meta reports no closing-line verdict', E.meta().validation.beats_closing_line === null);

console.log('— the run distribution —');
[1.8, 4.45, 7.2, 11.0].forEach((lam) => {
  const pmf = E.dist.runPmf(lam, P.mlb.run_dispersion, P.mlb.run_support_max);
  const s = pmf.reduce((a, b) => a + b, 0);
  near('pmf sums to one (λ=' + lam + ')', s, 1, 1e-12);
  near('pmf mean reproduces λ (λ=' + lam + ')', E.dist.mean(pmf), lam, lam > 9 ? 0.25 : 0.02);
  const vm = E.dist.variance(pmf) / E.dist.mean(pmf);
  near('pmf dispersion reproduces the constant (λ=' + lam + ')', vm, P.mlb.run_dispersion, lam > 9 ? 0.35 : 0.06);
  chk('no negative mass (λ=' + lam + ')', pmf.every((v) => v >= 0));
});
chk('a non-positive mean has no distribution', E.dist.runPmf(0, 2, 24) === null);

{
  const a = E.dist.runPmf(4.45, 2, 24);
  near('identical sides with an even tiebreak are a coin flip', E.dist.winProb(a, a, 0.5), 0.5, 1e-12);
  const t = E.dist.totalPmf(a, a);
  near('total pmf sums to one', t.reduce((x, y) => x + y, 0), 1, 1e-12);
  near('total mean is the sum of the means', E.dist.mean(t), 8.9, 0.05);
  const half = E.dist.totalProbs(t, 8.5);
  near('a half line cannot push', half.push, 0, 1e-15);
  near('over and under exhaust a half line', half.over + half.under, 1, 1e-12);
  const whole = E.dist.totalProbs(t, 9);
  gt('a whole line pushes', whole.push, 0.01);
  near('over, under and push exhaust a whole line', whole.over + whole.under + whole.push, 1, 1e-12);
  near('the fair over strips the push', whole.over_fair, whole.over / (whole.over + whole.under), 1e-12);
  const rl = E.dist.runLineProbs(a, a, -1.5);
  near('run line outcomes exhaust', rl.cover + rl.fail + rl.push, 1, 1e-12);
  near('a half run line cannot push', rl.push, 0, 1e-15);
  lt('an even matchup does not cover -1.5', rl.cover_fair, 0.5);
  const rlw = E.dist.runLineProbs(a, a, -1);
  gt('a whole run line pushes', rlw.push, 0.01);
}

console.log('— odds conversions —');
[-350, -180, -110, 105, 140, 260].forEach((am) => {
  eq('american round trips through decimal (' + am + ')', E.odds.decToAm(E.odds.amToDec(am)), am);
});
near('an even-money decimal is +100', E.odds.decToAm(2), 100, 0);
near('a 50% probability is +100', E.odds.probToAm(0.5), 100, 0);
{
  const d = E.odds.devigTwoWay(1.91, 1.91);
  near('a symmetric two-way de-vigs to even', d.a, 0.5, 1e-12);
  near('hold is reported, not hidden', d.hold, (1 / 1.91) * 2 - 1, 1e-12);
  const d2 = E.odds.devigTwoWay(1.5, 2.6);
  near('de-vigged probabilities sum to one', d2.a + d2.b, 1, 1e-12);
  chk('a missing side has no fair number', E.odds.devigTwoWay(1.9, null) === null);
}

console.log('— MLB: the league-average game —');
{
  const r = E.projectGame(baseReq());
  eq('an average game projects', r.status, 'PREDICTED');
  near('two average clubs total the league environment', r.model.fair_total, LG * 2, 0.08);
  near('the home club is the published home-field figure', r.model.home_win_prob, 0.532, 0.006);
  gt('the home club out-scores the away club', r.model.home_runs, r.model.away_runs);
  chk('the projection reports itself unproven', r.unproven === true);
  chk('no edge is claimed without a market', r.edge.total.recommendation === 'NO_MARKET');
  chk('the last-bat correction is disclosed separately',
    r.model.home_win_prob > r.model.home_win_prob_runs_only);
  const nums = walkNumbers(r.model, 'model').concat(walkNumbers(r.components, 'components'));
  chk('nothing in the payload is NaN or infinite',
    nums.every((x) => Number.isFinite(x[1])), nums.filter((x) => !Number.isFinite(x[1])));
}

console.log('— MLB: determinism —');
{
  const a = E.projectGame(baseReq()), b = E.projectGame(baseReq());
  eq('the same inputs give the same fingerprint', a.fingerprint, b.fingerprint);
  eq('the same inputs give the same total', a.model.fair_total, b.model.fair_total);
  eq('the same inputs give the same win probability', a.model.home_win_prob, b.model.home_win_prob);
  const c = E.projectGame(baseReq({ home: Object.assign(avgClub('Home'),
    { offense: { runs_per_game: 5.2, games: 140 } }) }));
  chk('a changed input changes the fingerprint', a.fingerprint !== c.fingerprint);
}

console.log('— MLB: each input moves the number the way it should —');
{
  const base = E.projectGame(baseReq());
  const betterOff = E.projectGame(baseReq({ home: Object.assign(avgClub('Home'),
    { offense: { runs_per_game: 5.4, games: 140 } }) }));
  gt('a better offense scores more', betterOff.model.home_runs, base.model.home_runs);
  gt('a better offense wins more often', betterOff.model.home_win_prob, base.model.home_win_prob);

  const ace = avgClub('Home'); ace.starter = { name: 'Ace', era: 2.40, fip: 2.50, xera: 2.35, ip: 180 };
  const vsAce = E.projectGame(baseReq({ home: ace }));
  lt('an ace suppresses the opposing offense', vsAce.model.away_runs, base.model.away_runs);
  lt('an ace lowers the total', vsAce.model.fair_total, base.model.fair_total);
  gt('an ace raises his club’s win probability', vsAce.model.home_win_prob, base.model.home_win_prob);

  const taxed = avgClub('Home'); taxed.bullpen = { taxed: [{}, {}, {}, {}, {}, {}, {}, {}], closer_flag: true };
  const vsTaxed = E.projectGame(baseReq({ home: taxed }));
  gt('a taxed bullpen concedes more', vsTaxed.model.away_runs, base.model.away_runs);
  const capped = ((1 + P.mlb.bullpen_taxed_cap) * (1 + P.mlb.bullpen_closer_out_penalty));
  lt('the bullpen penalty is capped', vsTaxed.model.away_runs / base.model.away_runs, capped + 0.001);

  const hitters = E.projectGame(baseReq({ park: { run_factor: 112 } }));
  gt('a hitters’ park raises the total', hitters.model.fair_total, base.model.fair_total);
  near('a park factor reaches the total in full',
    hitters.model.fair_total / base.model.fair_total, 1.12, 0.004);
  const absurd = E.projectGame(baseReq({ park: { run_factor: 400 } }));
  near('an absurd park index is clamped, not believed',
    absurd.components.park_factor, P.mlb.park_factor_max, 1e-9);
}

console.log('— MLB: weather —');
{
  const still = E.projectGame(baseReq({ weather: { temp_f: 70, wind_mph: 0, wind_rel: 'out' } }));
  const out = E.projectGame(baseReq({ weather: { temp_f: 70, wind_mph: 14, wind_rel: 'out' } }));
  const inw = E.projectGame(baseReq({ weather: { temp_f: 70, wind_mph: 14, wind_rel: 'in' } }));
  near('a reference day is weather-neutral', still.components.weather_factor, 1, 1e-9);
  gt('wind out raises the total', out.model.fair_total, still.model.fair_total);
  lt('wind in lowers the total', inw.model.fair_total, still.model.fair_total);
  const dome = E.projectGame(baseReq({ park: { run_factor: 100, is_dome: true },
    weather: { temp_f: 95, wind_mph: 20, wind_rel: 'out' } }));
  near('a dome ignores the forecast', dome.components.weather_factor, 1, 1e-9);
  const cross = E.projectGame(baseReq({ weather: { temp_f: 70, wind_mph: 20, wind_rel: 'crosswind toward right field' } }));
  near('a crosswind is not a tailwind', cross.components.weather_factor, 1, 1e-9);
  const blind = E.projectGame(baseReq({ weather: { temp_f: 70, wind_mph: 20, wind_rel: null } }));
  near('an uncalibrated wind is withheld rather than guessed', blind.components.weather_factor, 1, 1e-9);
  chk('and the blindness is reported',
    blind.components.weather_blind.some((t) => /direction/.test(t)));
  const gale = E.projectGame(baseReq({ weather: { temp_f: 70, wind_mph: 60, wind_rel: 'out' } }));
  near('a bad sensor reading is clamped', gale.components.weather_factor,
    1 + P.mlb.weather.wind_clamp_pct, 1e-9);
  const retract = E.projectGame(baseReq({ park: { run_factor: 100, roof_type: 'Retractable' },
    weather: { temp_f: 70, wind_mph: 14, wind_rel: 'out' } }));
  lt('a retractable roof halves the weather effect',
    retract.components.weather_factor, out.components.weather_factor);
  gt('but does not erase it', retract.components.weather_factor, 1);
  eq('wind out reads a numeric relative angle too', Math.round(E.windOut({ wind_mph: 10, wind_rel: 0 })), 10);
  eq('and a straight-in angle', Math.round(E.windOut({ wind_mph: 10, wind_rel: 180 })), -10);
}

console.log('— MLB: the market comparison and its guard bounds —');
{
  const r = E.projectGame(baseReq({ market: { total_line: 8.5, home_ml_dec: 1.87, away_ml_dec: 2.02 } }));
  near('the total gap is model minus market', r.market.total_gap, r.model.fair_total - 8.5, 0.011);
  chk('a consensus fair number is de-vigged', r.market.consensus_fair_home > 0 && r.market.consensus_fair_home < 1);
  gt('the hold is reported', r.market.consensus_hold, 0);
  const tiny = E.projectGame(baseReq({ market: { total_line: 8.9 } }));
  eq('a small disagreement is a pass', tiny.edge.total.recommendation, 'PASS');
  const lean = E.projectGame(baseReq({ market: { total_line: 7.5 } }));
  eq('a real disagreement is a research lean', lean.edge.total.recommendation, 'RESEARCH_LEAN');
  chk('and it says it is not an edge', /not an edge/i.test(lean.edge.total.note));
  const fault = E.projectGame(baseReq({ market: { total_line: 3.5 } }));
  eq('past the guard bound is a data fault', fault.edge.total.recommendation, 'DATA_FAULT');
  chk('and it says to inspect the inputs, not price it', /do not\s+price it/i.test(fault.edge.total.note));
  const mlFault = E.projectGame(baseReq({ market: { home_ml_dec: 6.0, away_ml_dec: 1.15 } }));
  eq('a moneyline past the guard bound is a data fault too',
    mlFault.edge.moneyline.recommendation, 'DATA_FAULT');
  chk('no market means no claim', E.projectGame(baseReq()).edge.moneyline.recommendation === 'NO_MARKET');
  const capFair = E.projectGame(baseReq({ market: { home_fair_prob: 0.44, home_fair_source: 'sharp fair' } }));
  near('a capture\u2019s own fair number is used as given', capFair.market.consensus_fair_home, 0.44, 1e-12);
  eq('and it is attributed', capFair.market.consensus_fair_source, 'sharp fair');
  near('the win-probability gap is measured against it',
    capFair.market.win_prob_gap_pts, (capFair.model.home_win_prob - 0.44) * 100, 0.011);
  const oneSide = E.projectGame(baseReq({ market: { home_ml_dec: 1.8 } }));
  chk('one decimal with no counterpart is never turned into a fair number',
    oneSide.market.consensus_fair_home === null);
  chk('and no moneyline claim is made from it', oneSide.edge.moneyline.recommendation === 'NO_MARKET');
  chk('every classification carries the unproven flag', lean.edge.total.unproven === true);
}

console.log('— MLB: missing inputs are reported, never filled in —');
{
  const noSp = baseReq(); delete noSp.home.starter;
  const r = E.projectGame(noSp);
  eq('a game with no probable starter still projects', r.status, 'PREDICTED');
  chk('and says the starter is unknown',
    r.data_quality.warnings.some((w) => /starter unknown/i.test(w)));
  chk('and says why that matters',
    r.data_quality.warnings.some((w) => /largest single input/i.test(w)));
  near('the relief rate carries the whole game', r.components.home_starter_share, 0, 1e-12);

  const noRate = baseReq(); noRate.away.offense = {};
  const r2 = E.projectGame(noRate);
  chk('a club with no run rate is named',
    r2.data_quality.warnings.some((w) => /no season run rate for the away club/i.test(w)));
  chk('and the substitution is disclosed in the contribution',
    r2.contributions.away.some((t) => t.k === 'offense' && /standing in/.test(t.t || '')));

  const noName = baseReq(); noName.home = { offense: {}, defense: {} };
  eq('a game without both clubs is refused', E.projectGame(noName).status, 'INSUFFICIENT_DATA');

  const future = baseReq({ season: P.calibrated_through_season + 5 });
  eq('a season beyond the calibrated window is blocked', E.projectGame(future).status, 'BLOCKED');
  chk('and the reason names recalibration', /recalibrate/i.test(E.projectGame(future).reason));

  const broken = baseReq({ league: { runs_per_game: 4.45 },
    home: Object.assign(avgClub('Home'), { offense: { runs_per_game: 400, games: 9000 } }) });
  eq('an impossible input is blocked rather than published', E.projectGame(broken).status, 'BLOCKED');
}

console.log('— MLB: the league baseline is sourced, not assumed —');
{
  const live = E.projectGame(baseReq({ league: { runs_per_game: 4.9 } }));
  chk('a live baseline says it is live', /club rates on file/.test(live.components.league_source));
  const fb = baseReq(); delete fb.league;
  const r = E.projectGame(fb);
  chk('a fallback baseline says it is a fallback', /fallback/.test(r.components.league_source));
  near('and it is the published constant', r.components.league_runs_per_game, P.mlb.league_runs_per_game, 1e-9);
}

console.log('— college: conference strength from the folded table —');
{
  /* Two conferences, four clubs each. Inside a conference every run scored is
     a run allowed, so the aggregate differential can only have come from the
     non-conference games. Conference A wins its non-conference play by 40
     runs over 40 such games; conference B loses the same. */
  function club(conf, g, confG, rf, ra) {
    return { conference_name: conf, games: g, conf_wins: confG / 2, conf_losses: confG / 2,
      runs_for: rf, runs_against: ra };
  }
  const rows = [
    club('A', 50, 40, 330, 320), club('A', 50, 40, 340, 320),
    club('A', 50, 40, 320, 315), club('A', 50, 40, 325, 320),
    club('B', 50, 40, 300, 320), club('B', 50, 40, 310, 320),
    club('B', 50, 40, 305, 315), club('B', 50, 40, 300, 320)
  ];
  const cs = E.conferenceStrength(rows);
  eq('every club is counted', cs.A.clubs, 4);
  eq('non-conference games are counted, not total games', cs.A.nonconference_games, 40);
  near('conference A nets its differential per non-conference game',
    cs.A.runs_per_nonconf_game, (330 + 340 + 320 + 325 - 320 - 320 - 315 - 320) / 40, 1e-12);
  gt('the stronger conference measures stronger', cs.A.runs_per_nonconf_game, cs.B.runs_per_nonconf_game);
  lt('the weaker conference measures negative', cs.B.runs_per_nonconf_game, 0);
  chk('a sufficient sample is marked sufficient', cs.A.sufficient === true);
  const thin = E.conferenceStrength([club('C', 20, 18, 100, 90)]);
  chk('a thin sample is marked insufficient', thin.C.sufficient === false);
}

console.log('— college: the projection —');
{
  function cClub(n, rpg, rapg, g, cs) {
    return { name: n, runs_per_game: rpg, runs_allowed_per_game: rapg, games: g, conference_strength: cs || null };
  }
  const CL = { runs_per_game: 6.6 };
  const evenHome = E.projectCollegeGame({ league: CL, home: cClub('H', 6.6, 6.6, 45), away: cClub('A', 6.6, 6.6, 45) });
  eq('a college game projects', evenHome.status, 'PREDICTED');
  near('two average clubs total the college environment', evenHome.model.fair_total, 13.2, 0.2);
  near('the home club carries the college home edge', evenHome.model.home_win_prob, 0.58, 0.01);
  const neutral = E.projectCollegeGame({ league: CL, neutral_site: true,
    home: cClub('H', 6.6, 6.6, 45), away: cClub('A', 6.6, 6.6, 45) });
  near('a neutral site is a coin flip between equals', neutral.model.home_win_prob, 0.5, 1e-9);
  near('and neither club carries a home multiplier', neutral.model.home_runs, neutral.model.away_runs, 1e-9);

  const better = E.projectCollegeGame({ league: CL, home: cClub('H', 8.4, 4.9, 45), away: cClub('A', 5.2, 7.8, 45) });
  gt('the better club is favoured', better.model.home_win_prob, evenHome.model.home_win_prob);
  gt('and out-scores the other side', better.model.home_runs, better.model.away_runs);

  const thin = E.projectCollegeGame({ league: CL, home: cClub('H', 12.0, 2.0, 4), away: cClub('A', 6.6, 6.6, 45) });
  lt('four games are regressed hard toward the league', thin.model.home_runs, better.model.home_runs);
  chk('and the thin sample is named',
    thin.data_quality.warnings.some((w) => /has played 4 games/.test(w)));

  const strongConf = { name: 'A', runs_per_nonconf_game: 1.6, nonconference_games: 60, sufficient: true };
  const withConf = E.projectCollegeGame({ league: CL,
    home: cClub('H', 6.6, 6.6, 45, strongConf), away: cClub('A', 6.6, 6.6, 45) });
  gt('a strong conference lifts its club', withConf.model.home_win_prob, evenHome.model.home_win_prob);
  chk('and the adjustment is written out', /non-conference game/.test(withConf.components.home_conference_note));
  const insufficient = { name: 'A', runs_per_nonconf_game: 4.0, nonconference_games: 3, sufficient: false };
  const noAdj = E.projectCollegeGame({ league: CL,
    home: cClub('H', 6.6, 6.6, 45, insufficient), away: cClub('A', 6.6, 6.6, 45) });
  near('a conference with no sample earns no adjustment',
    noAdj.model.home_win_prob, evenHome.model.home_win_prob, 1e-12);
  chk('and that refusal is stated',
    noAdj.data_quality.warnings.some((w) => /too few non-conference games/.test(w)));
  const wild = E.projectCollegeGame({ league: CL,
    home: cClub('H', 6.6, 6.6, 45, { runs_per_nonconf_game: 99, nonconference_games: 60, sufficient: true }),
    away: cClub('A', 6.6, 6.6, 45) });
  const clamped = E.projectCollegeGame({ league: CL,
    home: cClub('H', 6.6, 6.6, 45, { runs_per_nonconf_game: P.cbb.conference_adjust_clamp_runs, nonconference_games: 60, sufficient: true }),
    away: cClub('A', 6.6, 6.6, 45) });
  near('an implausible conference figure is clamped', wild.model.home_runs, clamped.model.home_runs, 1e-9);

  chk('every college projection names the missing starter',
    evenHome.data_quality.warnings.some((w) => /No probable starting pitcher exists/.test(w)));
  chk('the college projection reports itself unproven', evenHome.unproven === true);
  eq('a college game without both clubs is refused',
    E.projectCollegeGame({ league: CL, home: {}, away: {} }).status, 'INSUFFICIENT_DATA');
}

console.log('— the guard against a silent NaN, everywhere —');
{
  const cases = [
    baseReq(),
    baseReq({ weather: { temp_f: null, wind_mph: null, wind_rel: null, precip_prob: 90 } }),
    baseReq({ park: {} }),
    baseReq({ market: { total_line: 8.5, home_ml_dec: 1.8, away_ml_dec: 2.1, run_line: -1.5 } })
  ];
  cases.forEach((c, i) => {
    const r = E.projectGame(c);
    const nums = walkNumbers(r.model, 'model')
      .concat(walkNumbers(r.components, 'components'))
      .concat(walkNumbers(r.market, 'market'));
    chk('case ' + i + ': every number is finite',
      nums.every((x) => Number.isFinite(x[1])), nums.filter((x) => !Number.isFinite(x[1])).slice(0, 4));
    chk('case ' + i + ': probabilities are probabilities',
      r.model.home_win_prob > 0 && r.model.home_win_prob < 1);
  });
}

failures.forEach((f) => console.log('FAIL | ' + f.name
  + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
if (fail === 0) console.log('PASS | baseball run model | ' + pass + ' self-consistency assertions. '
  + 'NOT a validation: this model has no graded closing-line record.');
process.exit(fail === 0 ? 0 : 1);
