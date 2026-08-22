/* ============================================================================
   EdgeDesk Football Engine — test suite.

   Run under node:      node football/tests.js        (exit 0 = green)
   Run in the browser:  EDFootballTests.run()         (returns {passed,failed})

   Covers (spec section 36): odds conversion, no-vig, CLV, the rating
   recursions (rolling statistics + opponent adjustment) via PYTHON-GENERATED
   golden vectors at 1e-9, QB layer, key numbers / cover probabilities,
   probability sanity, model output ranges over every seeded team pairing,
   the data-quality gate, fingerprint stability, and the honesty contract of
   classifyEdge (nothing above RESEARCH_LEAN, never validated:true).
   ============================================================================ */
(function () {
  'use strict';
  var root = (typeof window !== 'undefined') ? window
    : (typeof globalThis !== 'undefined') ? globalThis : this;
  var isNode = (typeof module !== 'undefined' && module.exports && typeof require === 'function');

  function load() {
    var E = root.EDFootball, G = root.EDFootballGoldens;
    if (isNode) {
      if (!root.EDFootballParams) root.EDFootballParams = require('./params.js');
      if (!E) E = require('./engine.js');
      if (!G) { G = require('./research/goldens.json'); root.EDFootballGoldens = G; }
    }
    return { E: E, G: G, P: root.EDFootballParams };
  }

  function run(verbose) {
    var L = load(), E = L.E, G = L.G, P = L.P;
    var R = [], pass = 0, fail = 0;
    function chk(name, ok, detail) {
      ok = !!ok; R.push({ t: name, ok: ok, detail: ok ? undefined : detail });
      if (ok) pass++; else fail++;
    }
    function near(a, b, eps) { return isFinite(a) && isFinite(b) && Math.abs(a - b) <= (eps || 1e-9); }

    if (!E || !G || !P) {
      chk('engine+goldens+params loaded', false, { E: !!E, G: !!G, P: !!P });
      return finish();
    }

    /* ---- odds math ---- */
    chk('amToDec +150', near(E.odds.amToDec(150), 2.5));
    chk('amToDec -110', near(E.odds.amToDec(-110), 1 + 100 / 110, 1e-12));
    chk('decToAm 2.5', E.odds.decToAm(2.5) === 150);
    chk('decToAm 1.909', E.odds.decToAm(E.odds.amToDec(-110)) === -110);
    chk('implied 2.0', near(E.odds.implied(2.0), 0.5));
    var dv = E.odds.devigTwoWay(1.909090909, 1.909090909);
    chk('devig symmetric = 50/50', dv && near(dv[0], 0.5, 1e-9) && near(dv[1], 0.5, 1e-9));
    var dvp = E.odds.devigTwoWay(1.5, 2.8, 'power');
    chk('devig power sums to 1', dvp && near(dvp[0] + dvp[1], 1, 1e-6));
    var dvm = E.odds.devigTwoWay(1.5, 2.8);
    chk('devig mult sums to 1', dvm && near(dvm[0] + dvm[1], 1, 1e-12));
    chk('devig favors favorite', dvm[0] > 0.6);
    chk('devig rejects bad price', E.odds.devigTwoWay(0.9, 2.0) === null);
    chk('EV at price', near(E.odds.evPct(0.55, 2.0), 0.1, 1e-12));
    chk('CLV doctrine', near(E.odds.clv(2.0, 0.55), 0.1, 1e-12));
    chk('no-vig CLV', near(E.odds.noVigClv(0.5, 0.55), 0.1, 1e-12));

    /* ---- NFL recursion golden (rolling stats + opponent adjustment) ---- */
    var st = { hp: JSON.parse(JSON.stringify(P.nfl.hyperparams)),
      team: {}, lmean: JSON.parse(JSON.stringify(P.nfl.league_means)),
      teamQb: {}, qb: {}, ngames: {} };
    var i, s;
    for (i = 0; i < G.nfl_script.length; i++) {
      s = G.nfl_script[i];
      var qbs = [], t;
      for (t in s.qb_starts) if (s.qb_starts.hasOwnProperty(t)) {
        qbs.push([t, s.qb_starts[t][0], s.qb_starts[t][1]]);
      }
      E.nfl.absorbGame(st, [[s.home, s.home_raw], [s.away, s.away_raw]], qbs);
    }
    E.nfl.seasonBreak(st);
    var ok = true, team, f, bad = null;
    for (team in G.nfl_state.team) if (G.nfl_state.team.hasOwnProperty(team)) {
      for (f in G.nfl_state.team[team]) if (G.nfl_state.team[team].hasOwnProperty(f)) {
        if (!near(st.team[team][f], G.nfl_state.team[team][f])) { ok = false; bad = team + '.' + f + ' js=' + st.team[team][f] + ' py=' + G.nfl_state.team[team][f]; }
      }
    }
    chk('NFL rating recursion parity (1e-9)', ok, bad);
    ok = true; bad = null;
    for (f in G.nfl_state.lmean) if (G.nfl_state.lmean.hasOwnProperty(f)) {
      if (!near(st.lmean[f], G.nfl_state.lmean[f])) { ok = false; bad = 'lmean.' + f; }
    }
    chk('NFL league-mean parity', ok, bad);
    ok = true;
    for (var q in G.nfl_state.qb) if (G.nfl_state.qb.hasOwnProperty(q)) {
      if (!near(st.qb[q].v, G.nfl_state.qb[q].v) || st.qb[q].n !== G.nfl_state.qb[q].n) ok = false;
    }
    chk('NFL QB layer parity', ok);
    ok = true;
    for (team in G.nfl_state.team_qb) if (G.nfl_state.team_qb.hasOwnProperty(team)) {
      if (!near(st.teamQb[team], G.nfl_state.team_qb[team])) ok = false;
    }
    chk('NFL team-QB EWMA parity', ok);

    /* ---- NFL prediction golden ---- */
    var pg = G.nfl_pred_game;
    var game = { home: pg.home, away: pg.away, home_qb_id: pg.home_qb_id,
      away_qb_id: pg.away_qb_id, home_rest: pg.home_rest, away_rest: pg.away_rest,
      roof: pg.roof, temp: pg.temp, wind: pg.wind, div_game: pg.div_game,
      week: pg.week, surface: pg.surface };
    var pr = E.nfl.predict(st, game);
    chk('koerner spread parity', near(pr.koerner_spread, G.nfl_pred.koerner_spread, 1e-9),
      pr.koerner_spread + ' vs ' + G.nfl_pred.koerner_spread);
    chk('stuckey ctx parity', near(pr.ctx_adj, G.nfl_pred.ctx_adj, 1e-9));
    chk('model spread parity', near(pr.model_spread, G.nfl_pred.model_spread, 1e-9));
    chk('sharp total parity', near(pr.sharp_total, G.nfl_pred.sharp_total, 1e-9));
    ok = true;
    for (f in G.nfl_pred.spread_feats) if (G.nfl_pred.spread_feats.hasOwnProperty(f)) {
      if (!near(pr.features.spread[f], G.nfl_pred.spread_feats[f])) ok = false;
    }
    chk('spread feature parity', ok);

    /* ---- teamGameFromStw arithmetic ---- */
    var tgf = E.nfl.teamGameFromStw({ attempts: 30, carries: 25, sacks_suffered: 2,
      passing_epa: 5, rushing_epa: 2, passing_20: 6, rushing_10: 4 });
    chk('stw plays', tgf.plays === 57);
    chk('stw off_epa_play', near(tgf.off_epa_play, 7 / 57, 1e-12));
    chk('stw pass_epa_db', near(tgf.pass_epa_db, 5 / 32, 1e-12));
    chk('stw expl_pass', near(tgf.expl_pass, 6 / 30, 1e-12));
    chk('stw sack_rate', near(tgf.sack_rate_all, 2 / 32, 1e-12));

    /* ---- CFB recursion golden ---- */
    var cst = { hp: JSON.parse(JSON.stringify(P.cfb.hyperparams)),
      r: {}, n: {}, off: {}, lmeanPts: null };
    for (i = 0; i < G.cfb_script.length; i++) {
      s = G.cfb_script[i];
      var pm = E.cfb.predictMargin(cst, s[0], s[1], s[2], s[3], s[4]);
      chk('CFB pre-absorb prediction ' + i, near(pm, G.cfb_state.pre_absorb_predictions[i], 1e-9),
        pm + ' vs ' + G.cfb_state.pre_absorb_predictions[i]);
      E.cfb.absorb(cst, s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]);
    }
    E.cfb.seasonBreak(cst);
    ok = true; bad = null;
    for (team in G.cfb_state.r) if (G.cfb_state.r.hasOwnProperty(team)) {
      if (!near(cst.r[team], G.cfb_state.r[team])) { ok = false; bad = team; }
    }
    chk('CFB rating parity', ok, bad);
    chk('CFB lmean parity', near(cst.lmeanPts, G.cfb_state.lmean_pts, 1e-9));
    chk('CFB final margin parity',
      near(E.cfb.predictMargin(cst, 'Georgia', 'Clemson', true, true, true),
        G.cfb_state.final_pred_geo_clem_neutral, 1e-9));
    var ptot = E.cfb.predictTotal(cst, 'Georgia', 'Clemson');
    chk('CFB total parity', near(ptot, G.cfb_state.final_pred_total_geo_clem, 1e-9));

    /* ---- distributions / key numbers ---- */
    chk('winProb(0) = 50%', near(E.dist.winProb('nfl', 0), 0.5, 1e-6));
    chk('winProb monotonic', E.dist.winProb('nfl', 7) > E.dist.winProb('nfl', 3)
      && E.dist.winProb('nfl', 3) > E.dist.winProb('nfl', -3));
    chk('winProb in (0,1) at +-40', E.dist.winProb('nfl', 40) < 1 && E.dist.winProb('nfl', -40) > 0);
    var cp = E.dist.coverProbSpread('nfl', 3, -2.5);
    chk('coverProb parts sum to 1', cp && near(cp.win + cp.push + cp.lose, 1, 1e-9));
    chk('coverProb favors fair side', cp && cp.win > 0.5);
    chk('coverProb push on integer', (function () {
      var c = E.dist.coverProbSpread('nfl', 3, 3); return c && c.push > 0.01;
    })());
    var inv = E.dist.fairSpreadFromWinProb('nfl', E.dist.winProb('nfl', 6.5));
    chk('fairSpreadFromWinProb inverse', near(inv, 6.5, 1e-3), inv);
    var hpv = E.dist.halfPointValue('nfl', 3, 3, 2.5);
    chk('buying off 3 carries real key-number mass', hpv > 0.03, hpv);
    var hpv2 = E.dist.halfPointValue('nfl', 3, 8, 7.5);
    chk('key 3 worth more than off-key 8 at fair 3', hpv > hpv2, [hpv, hpv2]);
    chk('cover basis is spread-conditioned in range',
      E.dist.coverProbSpread('nfl', 3, -2.5).basis === 'margin_pmf_by_spread');
    chk('cover falls back out of range',
      E.dist.coverProbSpread('nfl', 22, 20).basis === 'pooled_residual');
    var km = E.dist.keyMass('nfl');
    chk('NFL key mass 3 > 7 > 10', km && km['3'] > km['7'] && km['7'] > km['10']);
    var kc = E.dist.keyMass('cfb');
    chk('CFB key numbers are its own (flatter 3)', kc && kc['3'] < km['3']);
    var ov = E.dist.coverProbTotal('nfl', 47, 44.5, 'over');
    var un = E.dist.coverProbTotal('nfl', 47, 44.5, 'under');
    chk('total over/under complement', ov && un && near(ov.win, un.lose, 1e-12));
    chk('fair total above line -> over favored', ov.win > 0.5);

    /* ---- market layer honesty ---- */
    var cons = E.market.consensusFair([[1.91, 1.91], [1.87, 1.95], [1.95, 1.87]]);
    chk('consensus symmetric-ish', cons && near(cons[0], 0.5, 0.02) && near(cons[0] + cons[1], 1, 1e-12));
    var gaps = [0, 0.5, 1, 2, 3, 5, 8, 14, 20], anyBad = false, cls;
    for (i = 0; i < gaps.length; i++) {
      cls = E.market.classifyEdge('nfl', 'spread', gaps[i]);
      if (cls.validated !== false) anyBad = true;
      if (cls.recommendation !== 'PASS' && cls.recommendation !== 'RESEARCH_LEAN') anyBad = true;
    }
    chk('classifyEdge never validates, never exceeds RESEARCH_LEAN', !anyBad);
    cls = E.market.classifyEdge('cfb', 'spread', 6);
    /* the v1 CFB layer still validates nothing, but the reason has been
       corrected: a public CFB line archive does exist and football/cfb_p4
       is trained against it. The assertion now pins the honest claim. */
    chk('CFB edge basis admits it validates nothing',
      /validates nothing/.test(cls.basis) && /cfb_p4/.test(cls.basis));
    chk('classifyEdge NO_MARKET without a line', E.market.classifyEdge('nfl', 'spread', null).recommendation === 'NO_MARKET');
    var bl = E.market.blendSpread(-3, -4.5);
    chk('blend spread near market (learned humility)', isFinite(bl) && Math.abs(bl - (-4.5)) < 1.5, bl);

    /* ---- data quality gate ---- */
    var dq = E.dataQuality('nfl', {});
    chk('gate blocks missing inputs', dq.status === 'INSUFFICIENT_DATA' && dq.missing.length >= 2);
    var nst = E.nfl.newState();
    dq = E.dataQuality('nfl', { state: nst, game: { home: 'KC', away: 'KC' } });
    chk('gate rejects same team twice', dq.missing.indexOf('distinct_teams') >= 0);
    dq = E.dataQuality('nfl', { state: nst, game: { home: 'KC', away: 'BUF' },
      season: P.nfl.trained_through_season + 5 });
    chk('gate blocks stale params', dq.status === 'BLOCKED');
    dq = E.dataQuality('nfl', { state: nst, game: { home: 'KC', away: 'BUF' } });
    chk('gate warns on unknown QB', dq.status === 'OK' && dq.warnings.length === 2);

    /* ---- predictGame contract ---- */
    var miss = E.predictGame({ sport: 'nfl' });
    chk('predictGame INSUFFICIENT_DATA', miss.status === 'INSUFFICIENT_DATA' && miss.missing.length > 0);
    var full = E.predictGame({ sport: 'nfl', state: nst,
      game: { home: 'KC', away: 'BUF', week: 10 },
      market: { spread_line: -2.5, total_line: 47.5 },
      timestamps: { odds: '2026-09-01T00:00:00Z' } });
    chk('predictGame PREDICTED', full.status === 'PREDICTED');
    chk('predictGame carries versions', full.model_version === P.model_version
      && full.feature_version === P.nfl.feature_version && !!full.prediction_timestamp);
    chk('predictGame flags unproven', full.unproven === true);
    chk('predictGame components present', isFinite(full.components.koerner_spread)
      && isFinite(full.components.sharp_total));
    chk('predictGame cover probs present', !!full.cover && !!full.over);
    var full2 = E.predictGame({ sport: 'nfl', state: nst,
      game: { home: 'KC', away: 'BUF', week: 10 },
      market: { spread_line: -3.5, total_line: 47.5 },
      timestamps: { odds: '2026-09-01T00:00:00Z' } });
    chk('fingerprint tracks inputs', full.fingerprint !== full2.fingerprint);

    /* ---- output-range sweep over every seeded pairing ---- */
    var teams = [], k2;
    for (k2 in P.nfl.seed_ratings) if (P.nfl.seed_ratings.hasOwnProperty(k2)) teams.push(k2);
    var worst = null, n = 0;
    for (i = 0; i < teams.length; i++) {
      for (var j2 = 0; j2 < teams.length; j2++) {
        if (i === j2) continue;
        var p2 = E.nfl.predict(nst, { home: teams[i], away: teams[j2], week: 9 });
        n++;
        if (!(Math.abs(p2.model_spread) < 30) || !(p2.sharp_total > 25 && p2.sharp_total < 70)) {
          worst = teams[i] + '/' + teams[j2] + ' s=' + p2.model_spread + ' t=' + p2.sharp_total;
        }
      }
    }
    chk('range sweep ' + n + ' pairings sane', worst === null, worst);
    var cteams = [];
    for (k2 in P.cfb.seed_ratings) if (P.cfb.seed_ratings.hasOwnProperty(k2)) cteams.push(k2);
    var cst2 = E.cfb.newState(), worst2 = null, n2 = 0;
    for (i = 0; i < Math.min(cteams.length, 60); i++) {
      for (var j3 = 0; j3 < Math.min(cteams.length, 60); j3++) {
        if (i === j3) continue;
        var m2 = E.cfb.predictMargin(cst2, cteams[i], cteams[j3], true, true, false);
        n2++;
        if (!(Math.abs(m2) < 75)) worst2 = cteams[i] + '/' + cteams[j3] + '=' + m2;
      }
    }
    chk('CFB range sweep ' + n2 + ' pairings sane', worst2 === null, worst2);

    /* ---- validation summary must stay honest ---- */
    var vs = P.validation_summary;
    chk('NFL summary admits it does not beat the close',
      vs && vs.nfl && vs.nfl.beats_closing_line === false);
    chk('CFB summary admits no market backtest',
      vs && vs.cfb && vs.cfb.market_backtest === null);

    return finish();

    function finish() {
      if (verbose !== false) {
        for (var r2 = 0; r2 < R.length; r2++) {
          if (!R[r2].ok) console.log('FAIL | ' + R[r2].t + ' | ' + JSON.stringify(R[r2].detail));
        }
        console.log((fail === 0 ? 'ALL GREEN ' : 'FAILURES ') + pass + ' passed, ' + fail + ' failed');
      }
      return { passed: pass, failed: fail, results: R };
    }
  }

  var API = { run: run };
  root.EDFootballTests = API;
  if (isNode) {
    module.exports = API;
    if (require.main === module) {
      var res = run(true);
      process.exit(res.failed === 0 ? 0 : 1);
    }
  }
})();
