'use strict';
/* ===========================================================================
   EdgeDesk NBA — the point-in-time pass: every state, one chronological sweep,
   one feature row per game.

   Protocol (identical for every candidate, written before any was scored):
     1. Games are predicted in start order, 30 minutes before the scheduled
        tip. The states hold only games whose result was available by then
        (assumed_available_at = start + 4 h); a finished game is absorbed once,
        when it becomes available. `inputs_known_at` on each row is the latest
        availability time of anything absorbed, and engine/validation
        leakageAudit rejects any row where it is not before `predicted_at`.
     2. A game's own result, box score, minutes and play-by-play never reach
        its own row. The one same-game input is WHO PLAYED, used only by the
        `confirmed` availability regime (the inactive list and starters are
        public ~30 min before tip); the `projected` regime does not use it.
     3. Everything in a row is a number derived from earlier games; targets are
        stored beside it under `y`.

   States: Elo, Glicko (A), opponent-adjusted efficiency / pace / four factors /
   shooting luck (B), the Kalman DLM (F), the player model (C). The ML (E),
   simulation (D) and ensemble (G) candidates are built on these rows by
   nba/model/walkforward.js.
   =========================================================================== */
const D = require('../lib/data');
const C = require('../config');
const { Elo, Glicko, Adjusted, Kalman } = require('./ratings');
const { PlayerModel } = require('./players');

const dayOf = (ms) => ms / 864e5;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const DEFAULTS = {
  elo: { k: 20, hfa: 100, revert: 0.75 },
  glicko: { c: 6, summer: 120, revert: 0.75, hfa: 100, scale: 1 },
  adj: { half_life_days: 45, prior_games: 6, carry: 0.6 },
  kalman: { q: 0.08, R: 14000, carry: 0.6, summer: 6 },
  players: { half_life_days: 365, lambda: 3000, prior_o: -0.5, prior_d: -0.5, refit_days: 7 },
  use_players: true,
};

/** league zone eFG by season (for the shooting-luck measure; the season BEFORE is used) */
function zoneRates(tg) {
  const by = new Map();
  for (const r of tg) {
    if (r.rim_a == null) continue;
    let z = by.get(r.season); if (!z) { z = { rim: [0, 0], paint: [0, 0], mid: [0, 0], c3: [0, 0], ab3: [0, 0] }; by.set(r.season, z); }
    for (const k of Object.keys(z)) { z[k][0] += r[k + '_m'] || 0; z[k][1] += r[k + '_a'] || 0; }
  }
  const out = new Map();
  for (const [s, z] of by) out.set(s, { rim: z.rim[0] / z.rim[1], paint: z.paint[0] / z.paint[1], mid: z.mid[0] / z.mid[1], c3: 1.5 * z.c3[0] / z.c3[1], ab3: 1.5 * z.ab3[0] / z.ab3[1] });
  return out;
}

async function run(params, o) {
  o = o || {};
  const P = { elo: Object.assign({}, DEFAULTS.elo, params && params.elo), glicko: Object.assign({}, DEFAULTS.glicko, params && params.glicko),
    adj: Object.assign({}, DEFAULTS.adj, params && params.adj), kalman: Object.assign({}, DEFAULTS.kalman, params && params.kalman),
    players: Object.assign({}, DEFAULTS.players, params && params.players), use_players: params && params.use_players === false ? false : DEFAULTS.use_players };
  const cur = C.currentSeason(o.now);
  const lastSeason = o.upTo || cur;
  const seasons = D.seasonList(C.FIRST_SEASON, lastSeason);
  const games = D.games(seasons).filter((g) => g.status === 'FINAL' || (o.includeScheduled && g.status === 'SCHEDULED'));
  const tgAll = D.teamGames(seasons);
  const tg = new Map(); for (const r of tgAll) tg.set(r.game_id + '|' + r.team_id, r);
  const zones = zoneRates(tgAll);

  const elo = new Elo(P.elo), gl = new Glicko(P.glicko), kal = new Kalman(P.kalman);
  const A = {
    eff: new Adjusted('eff', 'offdef', P.adj), pace: new Adjusted('pace', 'sum', P.adj), efg: new Adjusted('efg', 'offdef', P.adj),
    tov: new Adjusted('tov', 'offdef', P.adj), orb: new Adjusted('orb', 'offdef', P.adj), ftr: new Adjusted('ftr', 'offdef', P.adj),
    tpar: new Adjusted('tpar', 'offdef', P.adj), luck: new Adjusted('luck', 'offdef', P.adj),
  };
  const pm = P.use_players ? new PlayerModel(P.players) : null;
  /* o.only: a subset of states for a tuning run ('elo', 'glicko', 'kalman', 'adj', 'players') */
  const want = (k) => !o.only || o.only.includes(k);
  const pgBySeason = new Map(), stBySeason = new Map();
  const loadSeasonWork = (s) => {
    if (!P.use_players || pgBySeason.has(s)) return;
    const pg = new Map(); for (const r of D.playerGames(s)) { if (!pg.has(r.g)) pg.set(r.g, []); pg.get(r.g).push(r); }
    pgBySeason.set(s, pg);
    const st = D.stints(s); const sm = new Map(); if (st) for (const g of st.games) sm.set(g.g, g.s);
    stBySeason.set(s, sm);
    for (const old of [...pgBySeason.keys()]) if (old < s - 1) { pgBySeason.delete(old); stBySeason.delete(old); }
  };
  const lastTeam = new Map();     /* team → { ms, season } of its last game (for "first game of season") */
  const prevSeasonTeam = new Map(); /* pid → team in the previous season (continuity) */
  const thisSeasonTeam = new Map();

  const rows = [];
  let pending = []; let head = 0; let maxKnown = null; let season = null;

  function absorb(batch) {
    if (!batch.length) return;
    const day = dayOf(Math.max(...batch.map((g) => g.avail_ms)));
    for (const g of batch) {
      const gd = dayOf(g.start_ms);
      elo.absorb(g); gl.absorb(g, gd);
      const th = tg.get(g.game_id + '|' + g.home_id), ta = tg.get(g.game_id + '|' + g.away_id);
      const hsign = g.neutral ? 0 : 1;
      if (th && ta && th.poss > 0 && th.fga != null && (want('kalman') || want('adj'))) {
        const poss = th.poss, mins = th.min || 48;
        if (want('kalman')) {
          kal.advance(gd);
          kal.update(g.home_id, g.away_id, hsign, 100 * g.hs / poss, poss);
          kal.update(g.away_id, g.home_id, -hsign, 100 * g.as / poss, poss);
        }
        const z = zones.get(g.season - 1) || zones.get(g.season);
        const side = (t, op, home) => ({
          eff: { t: t.team_id, o: op.team_id, y: 100 * t.pts / poss, home },
          efg: { t: t.team_id, o: op.team_id, y: (t.fgm + 0.5 * t.fg3m) / Math.max(1, t.fga), home },
          tov: { t: t.team_id, o: op.team_id, y: t.tov / poss, home },
          orb: { t: t.team_id, o: op.team_id, y: t.oreb / Math.max(1, t.oreb + op.dreb), home },
          ftr: { t: t.team_id, o: op.team_id, y: t.ftm / Math.max(1, t.fga), home },
          tpar: { t: t.team_id, o: op.team_id, y: t.fg3a / Math.max(1, t.fga), home },
          luck: z && t.rim_a != null && t.fga > 0 ? { t: t.team_id, o: op.team_id, y: (t.fgm + 0.5 * t.fg3m) / t.fga - (z.rim * t.rim_a + z.paint * t.paint_a + z.mid * t.mid_a + z.c3 * t.c3_a + z.ab3 * t.ab3_a) / Math.max(1, t.rim_a + t.paint_a + t.mid_a + t.c3_a + t.ab3_a), home } : null,
        });
        const sh = side(th, ta, hsign), sa = side(ta, th, -hsign);
        const keys = want('adj') ? ['eff', 'efg', 'tov', 'orb', 'ftr', 'tpar', 'luck'] : [];
        for (const k of keys) A[k].add(day, [sh[k], sa[k]].filter(Boolean));
        A.pace.add(day, [{ t: g.home_id, o: g.away_id, y: poss * 48 / mins }]);
      }
      if (pm) {
        loadSeasonWork(g.season);
        const st = stBySeason.get(g.season).get(g.game_id); if (st) pm.addStints(gd, g.season, st, g.neutral);
        const pr = pgBySeason.get(g.season).get(g.game_id); if (pr) { pm.addPlayerGames(gd, pr); for (const r of pr) if (r.pl) thisSeasonTeam.set(r.p + '|' + r.tm, 1); }
      }
      lastTeam.set(g.home_id, { ms: g.start_ms, season: g.season }); lastTeam.set(g.away_id, { ms: g.start_ms, season: g.season });
      if (maxKnown == null || g.avail_ms > maxKnown) maxKnown = g.avail_ms;
    }
    if (want('adj')) { for (const a of Object.values(A)) a.refit(day); } else if (want('kalman')) A.pace.refit(day);
    if (pm) pm.maybeRefit(day);
  }
  function flush(beforeMs) {
    const batch = [];
    while (head < pending.length && (beforeMs == null || pending[head].avail_ms < beforeMs)) batch.push(pending[head++]);
    /* absorb in day-sized batches so decayed refits see each day's games together */
    let i = 0;
    while (i < batch.length) {
      const d0 = Math.floor(dayOf(batch[i].avail_ms - 10 * 3600e3)); const b = [];
      while (i < batch.length && Math.floor(dayOf(batch[i].avail_ms - 10 * 3600e3)) === d0) b.push(batch[i++]);
      absorb(b);
    }
    if (head > 5000) { pending = pending.slice(head); head = 0; }
  }

  const tStart = Date.now();
  for (const g of games) {
    const predAt = g.start_ms - 30 * 60e3;
    if (season !== g.season) {
      flush(null);
      if (season != null) { prevSeasonTeam.clear(); for (const k of thisSeasonTeam.keys()) prevSeasonTeam.set(k, 1); thisSeasonTeam.clear(); }
      season = g.season;
      elo.startSeason(season); gl.startSeason(season); kal.startSeason(season); for (const a of Object.values(A)) a.startSeason(season);
      if (pm) { pm.startSeason(season); loadSeasonWork(season); }
      if (o.log) console.error('[nba pass] season ' + season + ' (' + ((Date.now() - tStart) / 1000).toFixed(0) + ' s)');
    }
    flush(predAt);
    const day = dayOf(predAt);
    const h = g.home_id, a = g.away_id, hs = g.neutral ? 0 : 1;
    kal.advance(day);
    const th = tg.get(g.game_id + '|' + h) || {}, ta = tg.get(g.game_id + '|' + a) || {};
    /* B: efficiency and pace */
    const pace = A.pace.expect(h, a, 0);
    const ppH = A.eff.expect(h, a, hs), ppA = A.eff.expect(a, h, -hs);
    const effM = pace * (ppH - ppA) / 100, effT = pace * (ppH + ppA) / 100;
    /* F: Kalman */
    const kg = kal.expectGap(h, a, g.neutral);
    const kalM = pace * kg.gap / 100, kalT = pace * kg.sum / 100, kalSd = pace * Math.sqrt(Math.max(0, kg.var_gap)) / 100;
    /* C: players */
    let plr = null;
    if (pm) {
      const pr = (pgBySeason.get(g.season) || new Map()).get(g.game_id) || [];
      const conf = { [h]: pr.filter((r) => r.tm === h && r.pl).map((r) => r.p), [a]: pr.filter((r) => r.tm === a && r.pl).map((r) => r.p) };
      const firstOfSeason = (t) => { const L = lastTeam.get(t); return !L || L.season !== g.season; };
      /* projected: the team's previous game — for its first game of a season that is
         last season's closing game (no roster feed is licensed; this is what is
         knowable without one). It never reads this game's box. */
      const proj = {}; const projStale = {};
      for (const t of [h, a]) { const lg = pm.lastGamePlayers(t); proj[t] = lg && lg.length >= 5 ? lg : []; projStale[t] = firstOfSeason(t) ? 1 : 0; }
      const full = { [h]: pm.regulars(h), [a]: pm.regulars(a) };
      const S = (set) => pm.strength(set || []);
      const sc = { h: S(conf[h]), a: S(conf[a]) }, sp = { h: S(proj[h]), a: S(proj[a]) };
      const fullS = { h: S(full[h]), a: S(full[a]) };
      /* confirmed adjustment: tonight against the team's recent full strength; a
         team's first game has no in-season reference, so its adjustment is 0 */
      const sfC = { h: firstOfSeason(h) ? sc.h : fullS.h, a: firstOfSeason(a) ? sc.a : fullS.a };
      const he = pm.homeEdge() * hs;
      const cont = (t, s) => { let m = 0; for (const x of s.minutes) if (prevSeasonTeam.has(x.pid + '|' + t)) m += x.min; return m / 240; };
      plr = {
        m_conf: pace * (2 * he + sc.h.net - sc.a.net) / 100, m_proj: pace * (2 * he + sp.h.net - sp.a.net) / 100,
        adj_conf: pace * ((sc.h.net - sfC.h.net) - (sc.a.net - sfC.a.net)) / 100, adj_proj: pace * ((sp.h.net - fullS.h.net) - (sp.a.net - fullS.a.net)) / 100,
        off_h: sc.h.off, def_h: sc.h.def, off_a: sc.a.off, def_a: sc.a.def,
        cont_h: cont(h, sc.h), cont_a: cont(a, sc.a), proj_stale: projStale[h] + projStale[a],
        unknown_min_h: sc.h.minutes.filter((x) => !x.known).reduce((s, x) => s + x.min, 0), unknown_min_a: sc.a.minutes.filter((x) => !x.known).reduce((s, x) => s + x.min, 0),
      };
    }
    const n0 = (v) => (v == null || !isFinite(v) ? 0 : v);
    const f = {
      elo_p: elo.prob(h, a, g.neutral), elo_diff: elo.diff(h, a, g.neutral),
      gl_p: gl.prob(h, a, g.neutral, day), gl_unc: gl.uncertainty(h, a, day),
      pace, pp_h: ppH, pp_a: ppA, eff_m: effM, eff_t: effT,
      kal_m: kalM, kal_t: kalT, kal_sd: kalSd, kal_sum_sd: pace * Math.sqrt(Math.max(0, kg.var_sum)) / 100,
      efg_h: A.efg.expect(h, a, hs), efg_a: A.efg.expect(a, h, -hs), tov_h: A.tov.expect(h, a, hs), tov_a: A.tov.expect(a, h, -hs),
      orb_h: A.orb.expect(h, a, hs), orb_a: A.orb.expect(a, h, -hs), ftr_h: A.ftr.expect(h, a, hs), ftr_a: A.ftr.expect(a, h, -hs),
      tpar_h: A.tpar.expect(h, a, hs), tpar_a: A.tpar.expect(a, h, -hs),
      luck_oh: n0(A.luck.T(h).a), luck_dh: n0(A.luck.T(h).b), luck_oa: n0(A.luck.T(a).a), luck_da: n0(A.luck.T(a).b),
      rest_h: th.rest_days == null ? 3 : clamp(th.rest_days, 0, 4), rest_a: ta.rest_days == null ? 3 : clamp(ta.rest_days, 0, 4),
      b2b_h: th.b2b || 0, b2b_a: ta.b2b || 0, g7_h: n0(th.games_7d), g7_a: n0(ta.games_7d),
      trav_h: Math.log1p(n0(th.travel_km)), trav_a: Math.log1p(n0(ta.travel_km)), tz_h: Math.abs(n0(th.tz_shift)), tz_a: Math.abs(n0(ta.tz_shift)),
      alt_vis: g.neutral ? 0 : (n0(th.alt) >= 1000 ? 1 : 0), road_a: n0(ta.road_streak), homestand_h: n0(th.home_streak),
      neutral: g.neutral || 0, playoff: g.type === 'R' ? 0 : 1, gp_h: A.eff.games(h), gp_a: A.eff.games(a),
    };
    if (plr) Object.assign(f, { plr_m_conf: plr.m_conf, plr_m_proj: plr.m_proj, adj_conf: plr.adj_conf, adj_proj: plr.adj_proj, cont_h: plr.cont_h, cont_a: plr.cont_a,
      plr_off_h: plr.off_h, plr_def_h: plr.def_h, plr_off_a: plr.off_a, plr_def_a: plr.def_a, proj_stale: plr.proj_stale, unk_min: plr.unknown_min_h + plr.unknown_min_a });
    const fin = g.status === 'FINAL';
    const row = { id: g.game_id, season: g.season, type: g.type, date: g.date, start: g.start_ms, neutral: g.neutral || 0, home: h, away: a,
      predicted_at: predAt, inputs_known_at: maxKnown, f,
      y: fin ? { hw: g.hs > g.as ? 1 : 0, margin: g.hs - g.as, total: g.hs + g.as, ot: g.ot || 0,
        reg_margin: g.reg_h == null ? null : g.reg_h - g.reg_a, reg_total: g.reg_h == null ? null : g.reg_h + g.reg_a,
        h1_margin: g.h_q1 == null ? null : g.h_q1 + g.h_q2 - g.a_q1 - g.a_q2, h1_total: g.h_q1 == null ? null : g.h_q1 + g.h_q2 + g.a_q1 + g.a_q2,
        q1_margin: g.h_q1 == null ? null : g.h_q1 - g.a_q1, q1_total: g.h_q1 == null ? null : g.h_q1 + g.a_q1, hs: g.hs, as: g.as } : null,
      ref_line_home: g.ref_line_home };
    rows.push(row);
    if (fin) pending.push(g);
  }
  flush(null);
  return { rows, states: { elo, gl, kal, A, pm, zones }, params: P, seconds: (Date.now() - tStart) / 1000 };
}

module.exports = { run, DEFAULTS, zoneRates };
