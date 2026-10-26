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
                 IN_USE_REJECTED    moves the line, held-out predictions are better without it
                 NEGLIGIBLE         moves the line by under 0.05 pts on average
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
    reliability: 'football/validation/reliability_calibration_cfb.json',
    loto: 'football/validation/loto_cfb.json'
  };
  /* the matchup pairings that carry each lane of a defence: a "pass" or "run"
     watch item is priced only if its own pairing moves the number */
  F.LANE_PAIRS = { pass: 'passing efficiency vs pass defence', run: 'run game vs run defence' };
  /* a lane whose pairing moves the live number by less than this on average is not priced */
  F.LANE_LIVE_MIN = 0.1;
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
    IN_USE_REJECTED: 'In the number, but held-out predictions are better without it',
    NEGLIGIBLE: 'In the number, but moves it by under 0.05 pts',
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
      AR = I.altitude_recheck || null, RC = I.regime_curve || null, RL = I.reliability || null, LT = I.loto || null;
    var X = {}, mk = V.market || {}, core = mk.core_only || {};
    /* the leave-one-term-out record (football/cfb_p4/research/loto.js), by term */
    var LO = {};
    ((LT && LT.terms) || []).forEach(function (t) { LO[t.key] = t; });
    var LW = LT ? LT.holdout[0] + '-' + LT.holdout[LT.holdout.length - 1] : null;
    function lotoTest(t) { return t ? (t.shadow ? 'added to' : 'left out of') + ' the shipped engine game by game on ' + LW + ' (' + t.holdout.n + ' games, no refit)' : null; }
    function lotoResult(t) {
      var m = t && t.holdout;
      if (!m) return null;
      if (m.inert || m.negligible) return 'moves the number by ' + f(m.mean_abs_term, 3) + ' pts on average';
      var better = (m.per_season || []).filter(function (x) { return x.mae_after < x.mae_before; }).length;
      return 'MAE ' + (num(m.delta) < 0 ? f(-m.delta, 3) + ' worse' : sgn(m.delta, 3) + ' better') + ' with it (' + ci(m.delta_ci95) + ', p = ' + f(m.paired_p, 2) + '; better in ' + better + ' of ' + (m.per_season || []).length + ' seasons); weight k ' + f(m.k) + ' (' + ci(m.k_ci95) + '): ' + t.weight.text;
    }
    function lotoStatus(t, fallback) {
      if (!t || !t.status) return fallback;
      return { VALIDATED: 'VALIDATED', CANDIDATE: 'IN_USE_NOT_SIGNIF', RESEARCH_ONLY: 'IN_USE_NOT_SIGNIF', REJECTED: 'IN_USE_REJECTED', NEGLIGIBLE: 'NEGLIGIBLE', INERT: 'NEGLIGIBLE' }[t.status] || fallback;
    }

    X.rating = { label: 'Team strength', in_number: true, status: 'CORE', points_text: 'the neutral-field rating gap',
      test: 'the whole engine replayed cold on ' + (mk.window || '2022-2025') + ', seasons no layer was tuned on',
      result: mk.n_games ? join(['spread MAE ' + f(mk.spread_mae_model, 3) + ' on ' + mk.n_games + ' games against the closing line’s ' + f(mk.spread_mae_market, 3),
        core.spread_mae_model != null ? 'rating and home field alone: ' + f(core.spread_mae_model, 3) : null,
        LO.rating ? 'left out on ' + LW + ': weight k ' + f(LO.rating.holdout.k) + ' (' + ci(LO.rating.holdout.k_ci95) + '): ' + LO.rating.weight.text : null]) : null,
      source: F.SOURCES.params + (LO.rating ? ', ' + F.SOURCES.loto : '') };

    var vn = V.venue || {};
    X.home_field = HF ? { label: 'Home field', in_number: true, status: HF.promoted ? 'VALIDATED' : 'IN_USE_UNTESTED', points: num(HF.hfa),
      points_text: HF.hfa + ' pts for every home team, the same at every stadium (0 at a neutral site)',
      test: 'walk-forward ' + HF.record.test_window + ', ' + HF.record.n + ' games, against the previous ' + HF.replaces.added_in_projection + '-pt constant',
      result: join(['spread MAE ' + sgn(HF.record.d_spread_mae, 3) + ' (' + ci(HF.record.d_spread_mae_ci) + '), better in ' + HF.record.seasons_better + ' seasons',
        vn.kept_per_venue_table === false ? 'a per-stadium table was tested and rejected: it tracked the home team’s own rating (corr ' + f(vn.artifact_corr_with_home_team_rating) + '), not the stadium' : null,
        LO.hfa ? 'left out on ' + LW + ': weight k ' + f(LO.hfa.holdout.k) + ' (' + ci(LO.hfa.holdout.k_ci95) + '), a check only, because the value was chosen on that window' : null]),
      source: F.SOURCES.home_field + (LO.hfa ? ', ' + F.SOURCES.loto : '') } : null;

    var mv = V.matchup || {}, pairs = ((P.matchup || {}).pairs || []).length, ML = LO.matchup;
    /* which pairings move the number: measured in the replay, and on the live slate */
    var LP = (LT && LT.pairs) || [], live = (LT && LT.live) || null, liveBy = {};
    ((live && live.by_pairing) || []).forEach(function (x) { liveBy[x.name] = x.mean_abs; });
    var active = LP.filter(function (p) { return !p.holdout.inert; }).sort(function (a, b) { return (b.holdout.mean_abs_term || 0) - (a.holdout.mean_abs_term || 0); }).map(function (p) { return p.name; });
    var inert = LP.filter(function (p) { return p.holdout.inert; }).map(function (p) { return p.name; });
    var unpricedLanes = Object.keys(F.LANE_PAIRS).filter(function (l) {
      var nm = F.LANE_PAIRS[l];
      return inert.indexOf(nm) >= 0 && (liveBy[nm] == null || liveBy[nm] < F.LANE_LIVE_MIN);
    });
    X.matchup = { label: 'Stylistic matchup', in_number: true, status: lotoStatus(ML, 'IN_USE_UNTESTED'), pairs: pairs || null,
      active_pairs: active, inert_pairs: inert, unpriced_lanes: unpricedLanes,
      live: live ? { games: live.games, mean_abs: live.mean_abs_matchup, current: live.mean_abs_current, last_season: live.mean_abs_last_season, seed_season: live.seed_season, reset: !!live.reset } : null,
      points_text: pairs + ' learned offence-vs-defence pairings netted into one term'
        + (LP.length ? '. ' + active.length + ' move it with this season’s data (' + active.slice(0, 2).join(', ') + ' carry most of it); '
          + inert.length + ' never do, because the season feed does not supply their inputs (' + inert.join(', ') + ')' : ''),
      test: (ML ? lotoTest(ML) + '; ' : '') + 'weights fitted on ' + F.MATCHUP_FIT_WINDOW + ' residuals (' + (mv.n || '—') + ' games, in-sample r² ' + f(mv.r2_on_residual, 3) + ')',
      result: ML ? lotoResult(ML) + (live ? (live.reset
          ? '. Live, the unfed inputs start the season at league average, as in the test (' + f(live.mean_abs_last_season) + ' pts of the term from last season’s values)'
          : '. Live, ' + f(live.mean_abs_last_season) + ' pts of the term on average come from last season’s values for the unfed inputs, which no test covers') : '')
        : 'no held-out test of its own: the historical replay carries no play-level efficiency, so the term is absent from every out-of-sample record',
      source: F.SOURCES.params + (ML ? ', ' + F.SOURCES.loto : '') };

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
    /* the engine measures the schedule term in its trained form and prices it
       only when params schedule.points_applied says so (engine.js
       schedulePoints); otherwise the record is a test of ADDING it */
    var SL = LO.schedule, schedOn = !!(P.schedule && P.schedule.points_applied === true);
    X.schedule = L.schedule ? { label: 'Rest and schedule', in_number: schedOn,
      status: schedOn ? lotoStatus(SL, held(L.schedule.r2_test)) : (SL && SL.shadow && SL.status === 'VALIDATED' ? 'VALIDATED' : (SL && SL.shadow && SL.status === 'REJECTED' ? 'REJECTED' : 'NOT_PRICED')),
      points: schedOn ? null : 0,
      points_text: schedOn ? 'short rest, byes, road stretches, look-aheads'
        : '0 pts: measured, not applied (short rest, byes, road stretches and look-aheads would move it ' + (SL && SL.holdout ? f(SL.holdout.mean_abs_term) : f(L.schedule.mean_abs_points)) + ' pts on average)',
      test: SL ? lotoTest(SL) + '; weights fitted on 2014-2019 residuals' : 'fitted on ' + L.schedule.n_tune + ' tune games, scored on 2022 on',
      result: join([SL ? lotoResult(SL) : null,
        SL && SL.fit_window && SL.fit_window.result && SL.fit_window.result.k != null ? 'even in the seasons it was fitted on the weight is k ' + f(SL.fit_window.result.k) + ' (' + ci(SL.fit_window.result.k_ci95) + ')' : null,
        !SL ? 'held-out r² ' + f(L.schedule.r2_test, 4) + ' (tune ' + f(L.schedule.r2_tune, 4) + '); average move ' + f(L.schedule.mean_abs_points) + ' pts' : null]),
      source: F.SOURCES.params + (SL ? ', ' + F.SOURCES.loto : '') } : null;
    /* the conference term taken apart (loto.js conferenceBreakdown): which
       kinds of pairing it earns its points in, read from each kind's k interval */
    var CL = LO.conference, CB = (LT && LT.conference) || null;
    var earns = [], silent = [];
    ((CB && CB.by_matchup) || []).forEach(function (b) {
      var m = b.result || {};
      if (!m.n || !m.k_ci95 || m.k_ci95[0] == null) return;
      if (m.k_ci95[0] > 0) earns.push(b.kind + ' (' + m.n + ' games: MAE ' + sgn(m.delta, 2) + ' better with it, k ' + f(m.k) + ', ' + ci(m.k_ci95) + ')');
      else silent.push(b.kind);
    });
    X.conference = L.conference ? { label: 'Conference strength', in_number: L.conference.shipped === true, status: lotoStatus(CL, held(L.conference.r2_test)), points_text: 'cross-conference games only, fading to 0 by six games played',
      by_matchup: CB ? (CB.by_matchup || []).map(function (b) { return { kind: b.kind, n: b.result.n || 0, k: b.result.k == null ? null : b.result.k, k_ci95: b.result.k_ci95 || null }; }) : null,
      test: CL ? lotoTest(CL) + (CL.fit_window ? '; fitted on ' + CL.fit_window.seasons.join('-') + ' cross-conference games' : '') : 'fitted on ' + L.conference.n_tune + ' tune games, scored on 2022 on',
      result: CL ? join([lotoResult(CL),
        earns.length ? 'it earns its points in ' + earns.join(', ') : null,
        silent.length ? 'in ' + silent.join(' and ') + ' games it carries no measurable information (the k interval includes 0)' : null]) : 'held-out r² ' + f(L.conference.r2_test, 3),
      source: F.SOURCES.params + (CL ? ', ' + F.SOURCES.loto : '') } : null;
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
      '**The leave-one-term-out record** behind the matchup, schedule, conference, home-field and team-strength rows is `docs/cfb-validation/LOTO.md` (`football/cfb_p4/research/loto.js`): each term removed from the shipped engine, game by game, on seasons it was not fitted on, judged by `football/validation/promote.js`, with its best-fit multiplier. Quarterback and injury terms have no historical inputs, so they are not in it.',
      ''
    ]).join('\n');
  };

  /* node only: read the generated files from the repository */
  F.load = function (rootDir) {
    var path = require('path'), fs = require('fs');
    function js(rel) { try { return require(path.join(rootDir, rel)); } catch (e) { return null; } }
    function json(rel) { try { return JSON.parse(fs.readFileSync(path.join(rootDir, rel), 'utf8')); } catch (e) { return null; } }
    return F.build({ params: js(F.SOURCES.params), home_field: js(F.SOURCES.home_field), altitude: js(F.SOURCES.altitude),
      altitude_recheck: json(F.SOURCES.altitude_recheck), regime_curve: js(F.SOURCES.regime_curve), reliability: json(F.SOURCES.reliability),
      loto: json(F.SOURCES.loto) });
  };

  return F;
});
