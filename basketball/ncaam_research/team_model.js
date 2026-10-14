'use strict';
/* ===========================================================================
   Team strength: opponent-adjusted efficiency and tempo, point in time.

   For every D1-v-D1 game the model sees two observations,

     100 * home points / possessions = mu + off[home] + allow[away] + eta
     100 * away points / possessions = mu + off[away] + allow[home] - eta

   (eta = 0 at a neutral site), weighted by possessions, and one tempo
   observation (possessions per 40 minutes, overtime removed) split between
   the two teams' offensive and defensive pace. Adjusted offense = mu + off,
   adjusted defense = mu + allow (points per 100 possessions against an
   average D1 opponent), net = off - allow. See lib/additive.js.

   Possessions: FGA - ORB + TOV + c * FTA per team, averaged over the two
   teams. c is fitted inside each fold on the publisher's parsed possession
   counts (the audit shows the generic 0.44 undercounts college free-throw
   trips; KenPom documents 0.475 for college).

   Season start: each team's prior is last season's final rating, regressed
   toward average by `carry`, and adjusted for roster continuity once the
   team's first game reveals who is playing: continuity = the share of last
   season's minutes played by players who have appeared for the team this
   season (ESPN athlete ids). Transfers in can add their old team's rating
   weighted by the share of that team's minutes they played (`transfer_beta`;
   0 unless the selection season says otherwise). New programs start at the
   bottom-quartile prior.

   Games against opponents of unknown division membership never enter the D1
   fit; they are a separate regime with one pooled opponent per season.

   Point in time: a finished game becomes an input at tip + 4 h (assumed; the
   pack has no first-publication times) and predictions are made 30 minutes
   before tip from what was available then.
   =========================================================================== */
const C = require('./config');
const U = require('./lib/util');
const { Additive } = require('./lib/additive');

const DAY = 864e5;
const NON_D1 = -1;

const DEFAULT_PARAMS = Object.freeze({
  lambda: 600, lambda_tempo: 4, kMu: 3000, kEta: 6000, sweeps: 6,
  half_life: null, carry: 0.7, carry_tempo: 0.7, continuity_slope: 0, continuity_ref: 0.45, transfer_beta: 0,
  blowout_margin: 30, blowout_weight: 1, scale: 'additive', new_program_quantile: 0.25,
  nond1_lambda: 400, poss_coef: null,
});

/* ---------------------------------------------------------------- possessions */
function possessionCoefficient(TG, seasons) {
  let sxy = 0; let sxx = 0; let n = 0;
  for (const r of TG.rows) {
    if (!seasons.includes(r.season) || !r.o || r.flags.length || !r.ncaa || r.ncaa.quarantined || r.ncaa.o_poss == null) continue;
    const base = r.fga - r.orb + r.tov; if (!Number.isFinite(base) || !Number.isFinite(r.fta)) continue;
    sxy += (r.ncaa.o_poss - base) * r.fta; sxx += r.fta * r.fta; n++;
  }
  return { c: sxy / sxx, n };
}
const teamPoss = (r, c) => r.fga - r.orb + r.tov + c * r.fta;

/* ---------------------------------------------------------------- game records */
function buildGames(G, TG, c) {
  const out = []; const lastStart = new Map();
  for (const g of G.games) {
    if (g.status !== 'FINAL') continue;
    const restH = lastStart.has(g.home) ? (g.start_ms - lastStart.get(g.home)) / DAY : null;
    const restA = lastStart.has(g.away) ? (g.start_ms - lastStart.get(g.away)) / DAY : null;
    lastStart.set(g.home, g.start_ms); lastStart.set(g.away, g.start_ms);
    const rs = TG.byGame.get(g.game_id);
    if (!rs || rs.length !== 2 || !rs[0].o || g.minutes == null) continue;
    const h = rs.find((r) => r.team === g.home); const a = rs.find((r) => r.team === g.away);
    if (!h || !a) continue;
    const ph = teamPoss(h, c); const pa = teamPoss(a, c);
    if (!(ph > 20) || !(pa > 20)) continue;
    const poss = (ph + pa) / 2;
    out.push({
      game_id: g.game_id, season: g.season, start_ms: g.start_ms, day: g.start_ms / DAY, home: g.home, away: g.away, neutral: g.neutral,
      regime: g.regime, home_d1: g.home_d1 === true, away_d1: g.away_d1 === true, event: g.event, conference_game: g.conference_game,
      minutes: g.minutes, n_ot: g.n_ot, poss, tempo: (poss * C.RULES.regulation_minutes) / g.minutes, hs: h.pts, as: a.pts,
      yH: (100 * h.pts) / poss, yA: (100 * a.pts) / poss, rest_h: restH, rest_a: restA, box: { h, a },
    });
  }
  return out;
}

/* ---------------------------------------------------------------- roster continuity (ESPN athlete ids) */
class Rosters {
  constructor(PG) {
    this.minutes = new Map(); // season -> team -> Map(athlete -> minutes)
    this.byGame = new Map();  // game -> [{team, athlete, min}]
    for (const r of PG.rows) {
      if (!(r.min > 0)) continue;
      if (!this.minutes.has(r.season)) this.minutes.set(r.season, new Map());
      const s = this.minutes.get(r.season); if (!s.has(r.team)) s.set(r.team, new Map());
      const t = s.get(r.team); t.set(r.athlete, (t.get(r.athlete) || 0) + r.min);
      if (!this.byGame.has(r.game_id)) this.byGame.set(r.game_id, []);
      this.byGame.get(r.game_id).push({ team: r.team, athlete: r.athlete, min: r.min });
    }
    this.lastTeam = new Map(); // season -> athlete -> {team, share}
    for (const [season, teams] of this.minutes) {
      const m = new Map();
      for (const [team, ath] of teams) {
        let tot = 0; for (const v of ath.values()) tot += v;
        for (const [a, v] of ath) { const share = (5 * v) / tot; const cur = m.get(a); if (!cur || share > cur.share) m.set(a, { team, share }); }
      }
      this.lastTeam.set(season, m);
    }
  }
  /** a tracker for one season: who has appeared, continuity and incoming-transfer value as of now */
  tracker(season, prevNet) {
    const last = this.minutes.get(season - 1) || new Map(); const prevOf = this.lastTeam.get(season - 1) || new Map();
    const seen = new Map(); const self = this;
    return {
      absorb(gameId) {
        for (const p of self.byGame.get(gameId) || []) { if (!seen.has(p.team)) seen.set(p.team, new Set()); seen.get(p.team).add(p.athlete); }
      },
      continuity(team) {
        const s = seen.get(team); const l = last.get(team); if (!s || !l) return null;
        let tot = 0; let ret = 0; for (const [a, v] of l) { tot += v; if (s.has(a)) ret += v; }
        return tot > 0 ? ret / tot : null;
      },
      incoming(team) {
        const s = seen.get(team); if (!s) return null; let v = 0; let n = 0;
        for (const a of s) { const p = prevOf.get(a); if (!p || p.team === team) continue; const net = prevNet ? prevNet.get(p.team) : null; if (net == null) continue; v += p.share * net; n++; }
        return { value: v, transfers: n };
      },
      seen(team) { return seen.get(team) ? seen.get(team).size : 0; },
    };
  }
}

/* ---------------------------------------------------------------- one season, walked forward */
function finalState(E, Tm, nond1) {
  const eff = new Map(); const tempo = new Map();
  for (const id of E.ids) eff.set(id, E.rating(id));
  for (const id of Tm.ids) tempo.set(id, Tm.rating(id));
  return { eff, tempo, mu: E.mu, eta: E.eta, tau: Tm.mu, nond1: Object.assign({}, nond1) };
}

function pooledNonD1(E, Tm, obs, prior, lambda, day, halfLife) {
  // weighted residual means against fixed D1 ratings, pulled toward the prior
  const lam = halfLife ? Math.LN2 / halfLife : 0;
  let so = 0; let sa = 0; let w = 0; let st = 0; let wt = 0;
  for (const g of obs) {
    const age = lam ? Math.exp(-lam * Math.max(0, day - g.day)) : 1;
    const d1 = g.home_d1 ? g.home : g.away; const vD1 = g.neutral ? 0 : (g.home_d1 ? 1 : -1);
    const yD1 = g.home_d1 ? g.yH : g.yA; const yX = g.home_d1 ? g.yA : g.yH;
    const r = E.rating(d1); if (!r) continue;
    const ww = g.poss * age;
    so += ww * (yX - E.mu - r.allow + E.eta * vD1); sa += ww * (yD1 - E.mu - r.off - E.eta * vD1); w += ww;
    const tr = Tm.rating(d1); if (tr) { st += age * (g.tempo - Tm.mu - tr.off * 0.5 - tr.allow * 0.5); wt += age; }
  }
  return {
    off: (so + lambda * prior.off) / (w + lambda), allow: (sa + lambda * prior.allow) / (w + lambda), pace: (st + 20 * prior.pace) / (wt + 20), games: obs.length,
  };
}

/** rows: one per predicted game. `prev` is last season's finalState (or null). */
function runSeason(season, games, params, prev, rosters) {
  const P = Object.assign({}, DEFAULT_PARAMS, params);
  const E = new Additive({ lambdaOff: P.lambda, lambdaAllow: P.lambda, kMu: P.kMu, kEta: P.kEta, sweeps: P.sweeps });
  const Tm = new Additive({ lambdaOff: P.lambda_tempo, lambdaAllow: P.lambda_tempo, kMu: 50, etaFixed: true, eta0: 0, sweeps: P.sweeps });
  const log = P.scale === 'log';
  const tr = (y) => (log ? 100 * Math.log(y / 100) : y);
  const inv = (z) => (log ? 100 * Math.exp(z / 100) : z);
  const prevNet = prev ? new Map([...prev.eff].map(([id, r]) => [id, r.off - r.allow])) : null;
  const track = rosters ? rosters.tracker(season, prevNet) : null;
  // priors
  let newOff = 0; let newAllow = 0;
  if (prev) {
    const nets = [...prev.eff.values()].map((r) => r.off - r.allow).sort((a, b) => a - b);
    const q = U.quantile(nets, P.new_program_quantile);
    newOff = q / 2; newAllow = -q / 2;
    E.setMuPrior(prev.mu); E.setEtaPrior(prev.eta);
    Tm.setMuPrior(prev.tau);
  }
  const base = new Map();
  const priorFor = (id) => {
    if (base.has(id)) return base.get(id);
    let b;
    if (prev && prev.eff.has(id)) { const r = prev.eff.get(id); const t = prev.tempo.get(id) || { off: 0, allow: 0 }; b = { off: r.off, allow: r.allow, poff: t.off, pallow: t.allow, known: true }; }
    else b = { off: prev ? newOff : 0, allow: prev ? newAllow : 0, poff: 0, pallow: 0, known: false };
    base.set(id, b); return b;
  };
  const applyPrior = (id) => {
    const b = priorFor(id);
    if (!b.known) { E.setPrior(id, b.off, b.allow); Tm.setPrior(id, 0, 0); return; }
    let carry = P.carry;
    let inc = 0;
    if (track) {
      const c = track.continuity(id);
      if (c != null) carry = Math.min(1, Math.max(0, P.carry + P.continuity_slope * (c - P.continuity_ref)));
      if (P.transfer_beta) { const x = track.incoming(id); if (x) inc = P.transfer_beta * x.value; }
    }
    E.setPrior(id, carry * b.off + inc / 2, carry * b.allow - inc / 2);
    Tm.setPrior(id, P.carry_tempo * b.poff, P.carry_tempo * b.pallow);
  };
  const nd1Prior = prev && prev.nond1 ? { off: prev.nond1.off, allow: prev.nond1.allow, pace: prev.nond1.pace } : { off: -12, allow: 12, pace: 0 };
  let nond1 = Object.assign({}, nd1Prior, { games: 0 });
  const nd1Obs = [];

  const order = games.filter((g) => g.season === season).sort((a, b) => a.start_ms - b.start_ms || a.game_id - b.game_id);
  for (const g of order) { if (g.home_d1) applyPrior(g.home); if (g.away_d1) applyPrior(g.away); }
  const pending = []; let head = 0; const rows = []; let knownThrough = null;
  const flush = (beforeMs) => {
    let added = 0; let lastDay = null;
    while (head < pending.length && pending[head].start_ms + C.AVAILABLE_AFTER_MS < beforeMs) {
      const g = pending[head++]; lastDay = g.day;
      knownThrough = Math.max(knownThrough == null ? -Infinity : knownThrough, g.start_ms + C.AVAILABLE_AFTER_MS);
      const damp = Math.abs(g.hs - g.as) > P.blowout_margin ? P.blowout_weight : 1;
      if (g.regime === 'D1_D1') {
        const v = g.neutral ? 0 : 1;
        E.add(g.home, g.away, tr(g.yH), g.poss * damp, v, g.day); E.add(g.away, g.home, tr(g.yA), g.poss * damp, -v, g.day);
        Tm.add(g.home, g.away, g.tempo, 1, 0, g.day); Tm.add(g.away, g.home, g.tempo, 1, 0, g.day);
      } else if (g.regime === 'D1_OTHER') nd1Obs.push(g);
      if (track) { track.absorb(g.game_id); if (g.home_d1) applyPrior(g.home); if (g.away_d1) applyPrior(g.away); }
      added++;
    }
    if (added) {
      const now = Number.isFinite(beforeMs) ? beforeMs / DAY : lastDay + 1;
      E.fit(now, P.half_life); Tm.fit(now, P.half_life);
      nond1 = pooledNonD1(E, Tm, nd1Obs, nd1Prior, P.nond1_lambda, now, P.half_life);
    }
    return lastDay;
  };
  for (const g of order) {
    const predAt = g.start_ms - C.PREDICT_BEFORE_MS;
    if (P.stop_ms != null && predAt >= P.stop_ms) { flush(P.stop_ms); return { rows, state: finalState(E, Tm, nond1), E, Tm, nond1, params: P, track, as_of: P.stop_ms }; }
    flush(predAt);
    if (g.regime === 'OTHER_OTHER') { pending.push(g); continue; }
    const row = predictRow(g, E, Tm, nond1, P, inv, track); row.inputs_known_through = knownThrough; rows.push(row);
    pending.push(g);
  }
  flush(Infinity);
  return { rows, state: finalState(E, Tm, nond1), E, Tm, nond1, params: P, track };
}

function sidePred(E, Tm, nond1, id, d1, oppId, oppD1, v) {
  // efficiency (on the fitted scale) of `id` on offense against `oppId`
  if (d1 && oppD1) return E.predict(id, oppId, v);
  if (d1) { const r = E.rating(id); return E.mu + (r ? r.off : 0) + nond1.allow + E.eta * v; }
  const r = E.rating(oppId); return E.mu + nond1.off + (r ? r.allow : 0) + E.eta * v;
}

function predictRow(g, E, Tm, nond1, P, inv, track) {
  const v = g.neutral ? 0 : 1;
  const zh = sidePred(E, Tm, nond1, g.home, g.home_d1, g.away, g.away_d1, v);
  const za = sidePred(E, Tm, nond1, g.away, g.away_d1, g.home, g.home_d1, -v);
  const pace = (id, d1) => { if (!d1) return { off: nond1.pace, allow: nond1.pace }; const r = Tm.rating(id); return r || { off: 0, allow: 0 }; };
  const th = pace(g.home, g.home_d1); const ta = pace(g.away, g.away_d1);
  const tempo = (Tm.mu == null ? 68 : Tm.mu) + 0.5 * (th.off + ta.allow + ta.off + th.allow);
  const ph = inv(zh); const pa = inv(za);
  const poss = tempo;
  const vh = E.variance(g.home); const va = E.variance(g.away);
  const varParam = (poss / 100) * (poss / 100) * ((g.home_d1 ? vh.off + vh.allow : 0) + (g.away_d1 ? va.off + va.allow : 0));
  return {
    game_id: g.game_id, season: g.season, start_ms: g.start_ms, day: g.day, home: g.home, away: g.away, neutral: g.neutral, regime: g.regime, event: g.event,
    conference_game: g.conference_game, rest_h: g.rest_h, rest_a: g.rest_a,
    tempo, ppp_h: ph, ppp_a: pa, pts_h: (poss * ph) / 100, pts_a: (poss * pa) / 100, margin: (poss * (ph - pa)) / 100, total: (poss * (ph + pa)) / 100,
    var_param: varParam, n_h: vh.n_off, n_a: va.n_off,
    cont_h: track ? track.continuity(g.home) : null, cont_a: track ? track.continuity(g.away) : null,
    y: { margin: g.hs - g.as, total: g.hs + g.as, hw: g.hs > g.as ? 1 : 0, tempo: g.tempo, ppp_h: g.yH, ppp_a: g.yA, n_ot: g.n_ot },
    predicted_at: new Date(g.start_ms - C.PREDICT_BEFORE_MS).toISOString(),
  };
}

/** all seasons in order; returns rows and each season's final state */
function walk(games, params, rosters, seasons) {
  const out = { rows: [], states: {} }; let prev = null;
  for (const s of seasons || C.SEASONS) {
    const r = runSeason(s, games, params, prev, rosters);
    out.rows.push(...r.rows); out.states[s] = r; prev = r.state;
  }
  return out;
}

module.exports = { DEFAULT_PARAMS, possessionCoefficient, teamPoss, buildGames, Rosters, runSeason, walk, predictRow, NON_D1 };
