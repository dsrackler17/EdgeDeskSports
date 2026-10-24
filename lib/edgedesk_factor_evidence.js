/* ===========================================================================
   EdgeDesk FACTOR EVIDENCE — for every factor a college research page or
   graphic names, whether it is in EdgeDesk's number, how much it can move
   it, and what the out-of-sample record behind that decision says.
   Node: require('./edgedesk_factor_evidence.js'). docs/game-research/FACTORS.md

   WHY. A watch item that says "Houston climbs 4,600 ft" invites the reader
   to add points the model never added, or to add them twice. Each factor
   here carries three answers the reader needs before trusting it:
     in_number   does it move EdgeDesk's line at all
     status      VALIDATED          passed a held-out test of its own
                 CORE               the model's base; tested as the whole model
                 IN_USE_UNTESTED    moves the line, no held-out test of its own
                 HELD_OUT_SIGNAL    moves the line, explains some error on held-out
                                    seasons (r² on residuals), no engine-level ablation
                 IN_USE_NOT_SIGNIF  moves the line, held-out gain not significant
                 REJECTED           tested on unseen games, made them worse: 0 pts
                 NOT_PRICED         shown for context, no term exists
                 NOT_VALIDATED      a score that has not been held to results
     record      the test, its window and its numbers, from the generated file

   PURE. build(inputs) reads only the objects it is handed (the generated
   files below), so the same files always give the same registry, and a
   number here can never drift from the record it quotes. load(root) is the
   node-only convenience that reads them from the repository.
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EDFactorEvidence = factory();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var F = { VERSION: 'edgedesk_factor_evidence/1', SCHEMA: 'edgedesk_factor_evidence_v1' };

  F.SOURCES = {
    params: 'football/cfb_p4/params.js',
    home_field: 'football/cfb_p4/home_field.js',
    altitude: 'football/altitude/params.js',
    altitude_recheck: 'football/validation/altitude_cfb_recheck.json',
    regime_curve: 'football/cfb_p4/regime_curve.js',
    reliability: 'football/validation/reliability_calibration_cfb.json'
  };
  /* the matchup weights' fit window: football/cfb_p4/research/train_p4.py
     B_TUNE_LO, B_TUNE_HI (fit_matchup is called on that window only; params.js
     records the fit's n and r2 but not the window) */
  F.MATCHUP_FIT_WINDOW = '2014-2019';

  F.STATUS_TEXT = {
    VALIDATED: 'Validated on unseen games',
    CORE: 'The model’s base, tested as a whole',
    IN_USE_UNTESTED: 'In the number, not yet tested on unseen games by itself',
    HELD_OUT_SIGNAL: 'In the number; explains some error on unseen seasons',
    IN_USE_NOT_SIGNIF: 'In the number, held-out gain not significant',
    REJECTED: 'Tested on unseen games and rejected: adds 0',
    NOT_PRICED: 'Shown for context; no term in the number',
    NOT_VALIDATED: 'Not yet validated against results'
  };

  function num(x) { var n = Number(x); return x != null && x !== '' && isFinite(n) ? n : null; }
  function f(x, d) { x = num(x); return x == null ? '—' : x.toFixed(d == null ? 2 : d); }
  function sgn(x, d) { x = num(x); return x == null ? '—' : (x > 0 ? '+' : (x < 0 ? '−' : '')) + Math.abs(x).toFixed(d == null ? 2 : d); }
  function ci(a) { return a && a.length === 2 ? '95% CI ' + sgn(a[0]) + ' to ' + sgn(a[1]) : null; }
  function join(xs) { return xs.filter(Boolean).join('; '); }

  F.build = function (I) {
    I = I || {};
    var P = I.params || {}, V = P.validation_summary || {}, HF = I.home_field || null, AP = I.altitude || null,
      AR = I.altitude_recheck || null, RC = I.regime_curve || null, RL = I.reliability || null;
    var X = {}, mk = V.market || {}, core = mk.core_only || {};

    X.rating = { label: 'Team strength', in_number: true, status: 'CORE', points_text: 'the neutral-field rating gap',
      test: 'the whole engine replayed cold on ' + (mk.window || '2022-2025') + ', seasons no layer was tuned on',
      result: mk.n_games ? join(['spread MAE ' + f(mk.spread_mae_model, 3) + ' on ' + mk.n_games + ' games against the closing line’s ' + f(mk.spread_mae_market, 3),
        core.spread_mae_model != null ? 'rating and home field alone: ' + f(core.spread_mae_model, 3) : null]) : null,
      source: F.SOURCES.params };

    var vn = V.venue || {};
    X.home_field = HF ? { label: 'Home field', in_number: true, status: HF.promoted ? 'VALIDATED' : 'IN_USE_UNTESTED', points: num(HF.hfa),
      points_text: HF.hfa + ' pts for every home team, the same at every stadium (0 at a neutral site)',
      test: 'walk-forward ' + HF.record.test_window + ', ' + HF.record.n + ' games, against the previous ' + HF.replaces.added_in_projection + '-pt constant',
      result: join(['spread MAE ' + sgn(HF.record.d_spread_mae, 3) + ' (' + ci(HF.record.d_spread_mae_ci) + '), better in ' + HF.record.seasons_better + ' seasons',
        vn.kept_per_venue_table === false ? 'a per-stadium table was tested and rejected: it tracked the home team’s own rating (corr ' + f(vn.artifact_corr_with_home_team_rating) + '), not the stadium' : null]),
      source: F.SOURCES.home_field } : null;

    var mv = V.matchup || {}, pairs = ((P.matchup || {}).pairs || []).length;
    X.matchup = { label: 'Stylistic matchup', in_number: true, status: 'IN_USE_UNTESTED', pairs: pairs || null,
      points_text: pairs + ' offence-vs-defence pairings on both sides of the ball (run, pass, trenches, explosives, early downs, red zone, field position), netted into one term',
      test: 'weights fitted on ' + F.MATCHUP_FIT_WINDOW + ' residuals (' + (mv.n || '—') + ' games, in-sample r² ' + f(mv.r2_on_residual, 3) + ')',
      result: 'no held-out test of its own: the historical replay carries no play-level efficiency, so the term is absent from every out-of-sample record',
      source: F.SOURCES.params };

    var av = AP && AP.validation || {}, ar = AR || null;
    X.altitude = AP ? { label: 'Altitude', in_number: AP.points_applied === true && AP.status === 'VALIDATED', status: AP.points_applied === true && AP.status === 'VALIDATED' ? 'VALIDATED' : 'REJECTED',
      points: AP.points_applied === true ? null : 0,
      points_text: '0 pts: research only (shadow estimate ' + sgn(AP.shadow_candidate && AP.shadow_candidate.coefficients && AP.shadow_candidate.coefficients.high_gain) + ' pts, not in the number)',
      test: 'walk-forward 2014-2021, confirmed on 2022-2025; ' + (av.gates || []).length + ' declared gates',
      result: join([av.confirm_affected ? 'held-out MAE ' + f(av.confirm_affected.mae_before, 3) + ' → ' + f(av.confirm_affected.mae_after, 3) + ' on the ' + av.confirm_affected.n + ' games it touched (p = ' + f(av.confirm_affected.p) + ')' : null,
        'failed ' + (av.gates || []).filter(function (g) { return !g.pass; }).length + ' of ' + (av.gates || []).length + ' gates']),
      recheck: ar ? { run_at: ar.run_at, home_field_pts: ar.baseline.after.home_field_pts, verdict: ar.verdict.after,
        effect: ar.confirm_affected.after.effect, p: ar.confirm_affected.after.p,
        permutation_p: ar.permutation_p.after,
        mountain_residual: (ar.residuals.filter(function (r) { return r.group === 'gain >= 3,000 ft'; })[0] || {}).after || null,
        all_residual: (ar.residuals.filter(function (r) { return r.group === 'all non-neutral'; })[0] || {}).after || null,
        text: 'Re-run ' + String(ar.run_at).slice(0, 10) + ' against the ' + ar.baseline.after.home_field_pts + '-pt home field: still ' + ar.verdict.after
          + ' (held-out change ' + sgn(ar.confirm_affected.after.effect, 3) + ' MAE, p = ' + f(ar.confirm_affected.after.p) + '; placebo p = ' + f(ar.permutation_p.after) + ')'
          + (function () {
            var m = (ar.residuals.filter(function (r) { return r.group === 'gain >= 3,000 ft'; })[0] || {}).after;
            return m ? '. Replayed on that home field, hosts of a 3,000+ ft climb beat EdgeDesk’s number by ' + sgn(m.v1_residual) + ' pts across 2006-2025 (' + ci(m.ci95) + ', ' + m.n + ' games): watched, not priced' : '';
          })() } : null,
      source: F.SOURCES.altitude + (ar ? ', ' + F.SOURCES.altitude_recheck : '') } : null;

    var tv = V.travel || {};
    X.travel = { label: 'Travel', in_number: tv.points_applied === true, status: tv.points_applied === true ? 'IN_USE_UNTESTED' : 'REJECTED', points: tv.points_applied === true ? null : 0,
      points_text: tv.points_applied === true ? 'miles and time zones' : '0 pts: measured, not applied',
      test: 'walk-forward residual regression on ' + (tv.n || '—') + ' tune-window road games, scored on 2022-2025',
      result: tv.holdout_mae_delta_2022_2025 != null ? 'held-out MAE ' + sgn(tv.holdout_mae_delta_2022_2025, 3) + ' (worse) and the time-zone slope reversed sign after the tune window' : null,
      source: F.SOURCES.params };

    var rv = V.rivalry || {};
    X.rivalry = { label: 'Rivalry', in_number: false, status: 'REJECTED', points: 0, points_text: '0 pts to the mean; widens the outcome range only',
      test: rv.pairs ? rv.pairs + ' rivalry pairs, persistence 2014-2025' : null, result: rv.mean_points_verdict ? String(rv.mean_points_verdict).replace(/^REJECTED\.\s*/, '').replace(/\s*Rivalry ships[\s\S]*$/, '') : null,
      source: F.SOURCES.params };

    var rr = RC && RC.record || null;
    X.regime = rr ? { label: 'Regime change', in_number: true, status: rr.significant ? 'VALIDATED' : 'IN_USE_NOT_SIGNIF',
      points_text: 'changes how much a programme’s long-run rating counts after a coaching change; at most games it gives the standard weight',
      test: 'walk-forward ' + rr.walk_forward_window + ', ' + rr.games + ' coaching-change games',
      result: 'spread MAE ' + sgn(rr.delta, 3) + ' (' + ci(rr.delta_ci95) + '), better in ' + rr.improved_seasons + ' of ' + rr.seasons + ' seasons',
      source: F.SOURCES.regime_curve } : null;

    var L = V.layers || {};
    function held(r2) { return num(r2) != null && num(r2) > 0 ? 'HELD_OUT_SIGNAL' : 'IN_USE_UNTESTED'; }
    X.schedule = L.schedule ? { label: 'Rest and schedule', in_number: true, status: held(L.schedule.r2_test), points_text: 'short rest, byes, road stretches, look-aheads',
      test: 'fitted on ' + L.schedule.n_tune + ' tune games, scored on 2022 on', result: 'held-out r² ' + f(L.schedule.r2_test, 4) + ' (tune ' + f(L.schedule.r2_tune, 4) + '); average move ' + f(L.schedule.mean_abs_points) + ' pts',
      source: F.SOURCES.params } : null;
    X.conference = L.conference ? { label: 'Conference strength', in_number: L.conference.shipped === true, status: held(L.conference.r2_test), points_text: 'cross-conference games only, fading to 0 by six games played',
      test: 'fitted on ' + L.conference.n_tune + ' tune games, scored on 2022 on', result: 'held-out r² ' + f(L.conference.r2_test, 3), source: F.SOURCES.params } : null;
    X.qb = L.qb ? { label: 'Quarterback', in_number: true, status: held(L.qb.r2_test), points_text: f(L.qb.points_per_epa_db, 1) + ' pts per point of EPA per dropback, when a measured starter is on file',
      test: 'fitted on ' + L.qb.n_tune + ' tune games, scored on 2022 on', result: 'held-out r² ' + f(L.qb.r2_test, 4), source: F.SOURCES.params } : null;

    X.weather = { label: 'Weather', in_number: false, status: 'NOT_PRICED', points: 0,
      points_text: '0 pts: no historical weather series exists, so no coefficient was earned', test: null, result: null, source: F.SOURCES.params };
    X.officials = { label: 'Officiating', in_number: false, status: 'NOT_PRICED', points: 0, points_text: '0 pts: shown for context', test: null, result: null, source: 'lib/edgedesk_game_context.js' };

    var pl = RL && RL.pooled || null;
    X.reliability = pl ? { label: 'Data quality (reliability)', in_number: false, status: pl.validated ? 'VALIDATED' : 'NOT_VALIDATED',
      points_text: 'moves no number: a hand-weighted 0-100 check of the inputs’ completeness, freshness, agreement and stability',
      test: 'graded games by score band (' + String(RL.generated_at).slice(0, 10) + ')',
      result: pl.n + ' graded games; ' + (pl.buckets || []).filter(function (b) { return b.n; }).map(function (b) { return b.bucket + ': ' + b.n; }).join(', ')
        + ((pl.buckets || []).filter(function (b) { return b.bucket === '90-100'; }).map(function (b) { return b.n ? '' : '; no graded game has scored 90 or more'; })[0] || '')
        + '; ' + String(pl.verdict || '').replace(/^NOT VALIDATED:\s*/, ''),
      source: F.SOURCES.reliability } : null;

    var out = {};
    Object.keys(X).forEach(function (k) { if (X[k]) { out[k] = X[k]; out[k].status_text = F.STATUS_TEXT[X[k].status]; } });
    return { schema: F.SCHEMA, version: F.VERSION, league: 'cfb', model_version: (HF && HF.model_version) || P.model_version || null, factors: out };
  };

  /* the reader's table: one row per factor, generated, never typed */
  F.markdown = function (reg) {
    var rows = Object.keys(reg.factors).map(function (k) {
      var x = reg.factors[k];
      return '| ' + x.label + ' | ' + (x.in_number ? 'yes' : '**no**') + ' | ' + x.status_text + ' | ' + (x.points_text || '') + ' | ' + (x.test || '—') + ' | ' + (x.result || '—') + (x.recheck ? '. ' + x.recheck.text : '') + ' | `' + x.source + '` |';
    });
    return [
      '# What each factor does to EdgeDesk’s college number',
      '',
      'Generated by `tools/football/factor_evidence.js` from the files named in the last column (' + reg.model_version + '). Do not edit by hand: rerun the tool. If this page and those files disagree, the files win.',
      '',
      'Every “What to watch for” item on a college research graphic carries a chip with one of three answers: the points the factor adds to EdgeDesk’s line (`UTAH +2.8`), `0 PTS` (measured, but the number does not use it), or `CONTEXT` (a ranking with no separate term). This table is the evidence behind each answer.',
      '',
      '| factor | in the number | status | how much | test | result | source |',
      '|---|---|---|---|---|---|---|'
    ].concat(rows).concat([
      '',
      '**Not yet shown here, and the next piece of work:** a leave-one-term-out test of every term that moves the number, on seasons none of them was fitted on, with each term’s best-fit multiplier and its interval (is the weight right, not just the sign). The stylistic matchup term is the first candidate: it moves every college line and has no held-out record of its own.',
      ''
    ]).join('\n');
  };

  /* node only: read the generated files from the repository */
  F.load = function (rootDir) {
    var path = require('path'), fs = require('fs');
    function js(rel) { try { return require(path.join(rootDir, rel)); } catch (e) { return null; } }
    function json(rel) { try { return JSON.parse(fs.readFileSync(path.join(rootDir, rel), 'utf8')); } catch (e) { return null; } }
    return F.build({ params: js(F.SOURCES.params), home_field: js(F.SOURCES.home_field), altitude: js(F.SOURCES.altitude),
      altitude_recheck: json(F.SOURCES.altitude_recheck), regime_curve: js(F.SOURCES.regime_curve), reliability: json(F.SOURCES.reliability) });
  };

  return F;
});
