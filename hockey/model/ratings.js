'use strict';
/* ===========================================================================
   EdgeDesk NHL — point-in-time team and goalie ratings.

   A single chronological pass over the team-game table. Before each game DATE
   every game on that date is given a feature snapshot built ONLY from games on
   earlier dates; then that date's games are absorbed. Nothing about a game, or
   about any later game, can reach its own snapshot (walkforward.js audits it).

   What is rated, each as a ratio to the league's running average:
     ev_off / ev_def    5v5 xG for / against per 60, score-and-venue adjusted,
                        opponent-adjusted (online: each observation divided by
                        the opponent's pre-game rating)
     g_off / g_def      all-situations goals for / against per game (a goals
                        rating, so the model can weigh finishing and luck)
     pp_off / pk_def    power-play xG for per 60 PP minutes / short-handed xG
                        against per 60 SH minutes
     pp_draw / pk_take  power-play and short-handed minutes per game
     goalie             goals saved above expected per unit of xG faced,
                        shrunk toward a replacement-level prior
   Weights decay with time (half-life in days), so the off-season pulls every
   team back toward the league through the prior, as a new roster should.

   Score and venue effects (Tulsky 2012; McCurdy's score-and-venue adjustment):
   a team that leads sits back and its share of 5v5 chances falls. Each score
   state's xG is reweighted by the league's overall-rate / state-rate ratio,
   estimated from seasons before the one being rated.

   The ratings are features; hockey/model/glm.js learns how much each matters.
   =========================================================================== */

const DEFAULTS = {
  half_life_days: 60,          /* team ratings */
  goalie_half_life_days: 400,  /* goalies: a much longer memory */
  prior_games: 8,              /* team prior weight, in games */
  goalie_prior_xg: 60,         /* goalie prior weight, in xG faced */
  goalie_prior_rate: -0.03,    /* replacement-level prior: 3% more goals than xG */
  starter_memory: 10,          /* games of starter history for the projection */
};

let PREDECESSOR = {};
try { const t = require('../data/teams.json').teams; for (const k of Object.keys(t)) if (t[k].predecessor) PREDECESSOR[k] = t[k].predecessor; } catch (_) { PREDECESSOR = { WPG: 'ATL', ARI: 'PHX', UTA: 'ARI' }; }

function decay(dtDays, hl) { return Math.pow(0.5, Math.max(0, dtDays) / hl); }
function dayNum(date) { return Math.floor(Date.parse(date + 'T12:00:00Z') / 864e5); }

class Acc {
  constructor() { this.s = {}; this.t = null; }
  age(day, hl) { if (this.t != null && day > this.t) { const f = decay(day - this.t, hl); for (const k in this.s) this.s[k] *= f; } this.t = day; }
  add(k, v, w) { this.s[k] = (this.s[k] || 0) + (w == null ? 1 : w) * v; }
  get(k) { return this.s[k] || 0; }
}

class RatingState {
  constructor(params, scoreWeights) {
    this.p = Object.assign({}, DEFAULTS, params || {});
    this.sw = scoreWeights || { lead: 1, tie: 1, trail: 1 };
    this.team = new Map();
    this.goalie = new Map();
    this.league = new Acc();
    this.lastGame = new Map();     /* team → { day, starter } */
    this.starts = new Map();       /* team → [goalie ids of recent starters, newest last] */
    this.b2bSecond = { n: 0, same: 0 }; /* how often yesterday's starter starts the second of a back-to-back */
  }
  T(team) {
    if (!this.team.has(team)) {
      /* a relocated or renamed franchise starts from its predecessor's ratings (the roster moved with it) */
      const pred = PREDECESSOR[team];
      const a = new Acc();
      if (pred && this.team.has(pred)) { const p = this.team.get(pred); a.s = Object.assign({}, p.s); a.t = p.t; }
      this.team.set(team, a);
      if (pred && this.starts.has(pred) && !this.starts.has(team)) this.starts.set(team, this.starts.get(pred).slice());
    }
    return this.team.get(team);
  }
  G(id) { if (!this.goalie.has(id)) this.goalie.set(id, new Acc()); return this.goalie.get(id); }

  leagueRates(day) {
    const L = this.league; L.age(day, this.p.half_life_days);
    const toi = L.get('toi_ev5') || 1;
    return {
      ev_xg60: L.get('toi_ev5') ? L.get('ev_xgf') / toi * 3600 : null,
      g_pg: L.get('games') ? L.get('gf') / L.get('games') : null,
      pp_xg60: L.get('toi_pp') ? L.get('pp_xgf') / L.get('toi_pp') * 3600 : null,
      pp_min_pg: L.get('games') ? L.get('toi_pp') / L.get('games') / 60 : null,
      gsax_rate: L.get('g_xga') ? (L.get('g_xga') - L.get('g_ga')) / L.get('g_xga') : 0,
      games: L.get('games'),
    };
  }

  /* the team's ratings as ratios to the league, shrunk toward 1 by the prior */
  teamRatings(team, day) {
    const a = this.T(team); a.age(day, this.p.half_life_days);
    const L = this.leagueRates(day);
    const k = this.p.prior_games;
    const toiPrior = k * 2700; /* ~45 min of 5v5 per game */
    const ratio = (num, den, priorRate, priorDen) => {
      if (priorRate == null || priorRate <= 0) return 1;
      return ((num + priorRate * priorDen) / (den + priorDen)) / priorRate;
    };
    const evr = L.ev_xg60 / 3600;
    return {
      ev_off: ratio(a.get('ev_xgf_adj'), a.get('toi_ev5'), evr, toiPrior),
      ev_def: ratio(a.get('ev_xga_adj'), a.get('toi_ev5'), evr, toiPrior),
      g_off: ratio(a.get('gf_adj'), a.get('games'), L.g_pg, k),
      g_def: ratio(a.get('ga_adj'), a.get('games'), L.g_pg, k),
      pp_off: ratio(a.get('pp_xgf'), a.get('toi_pp'), L.pp_xg60 / 3600, k * 300),
      pk_def: ratio(a.get('sh_xga'), a.get('toi_sh'), L.pp_xg60 / 3600, k * 300),
      pp_draw: ratio(a.get('toi_pp'), a.get('games'), L.pp_min_pg * 60, k),
      pk_take: ratio(a.get('toi_sh'), a.get('games'), L.pp_min_pg * 60, k),
      fin: ratio(a.get('gf_vs_tender'), a.get('xgf_vs_tender'), 1, 40),
      games_weight: a.get('games'),
    };
  }

  goalieRating(id, day) {
    if (id == null) return { rate: this.p.goalie_prior_rate, xg: 0, known: false };
    const g = this.G(id); g.age(day, this.p.goalie_half_life_days);
    const xg = g.get('xga'), ga = g.get('ga');
    const k = this.p.goalie_prior_xg;
    return { rate: ((xg - ga) + this.p.goalie_prior_rate * k) / (xg + k), xg, known: xg > 0 };
  }

  /* who starts tonight, before it is announced: recent share, with the back-to-back rule */
  projectStarters(team, day) {
    const recent = (this.starts.get(team) || []).slice(-this.p.starter_memory);
    if (!recent.length) return [];
    const w = {}; let tot = 0;
    recent.forEach((g, i) => { const wt = Math.pow(0.85, recent.length - 1 - i); w[g] = (w[g] || 0) + wt; tot += wt; });
    const last = this.lastGame.get(team);
    const b2b = last && day - last.day === 1;
    const sameRate = this.b2bSecond.n >= 30 ? this.b2bSecond.same / this.b2bSecond.n : 0.25;
    let out = Object.keys(w).map((g) => ({ goalie: Number(g), p: w[g] / tot }));
    if (b2b && last.starter != null) {
      /* yesterday's starter gets the league's same-goalie rate; the others share the rest by usage */
      const others = out.filter((o) => o.goalie !== last.starter);
      const otherTot = others.reduce((a, o) => a + o.p, 0);
      out = !others.length ? [{ goalie: last.starter, p: 1 }]
        : [{ goalie: last.starter, p: sameRate }].concat(others.map((o) => ({ goalie: o.goalie, p: (1 - sameRate) * o.p / otherTot })));
    }
    const s = out.reduce((a, o) => a + o.p, 0);
    return out.map((o) => ({ goalie: o.goalie, p: o.p / s })).sort((a, b) => b.p - a.p);
  }

  /** the pre-game snapshot for one team in one game (actual starter optional) */
  snapshot(team, opp, isHome, date, actualStarter) {
    const day = dayNum(date);
    const r = this.teamRatings(team, day), o = this.teamRatings(opp, day);
    const last = this.lastGame.get(team), lastO = this.lastGame.get(opp);
    const rest = last ? Math.min(5, day - last.day) : 5, restO = lastO ? Math.min(5, day - lastO.day) : 5;
    const projOpp = this.projectStarters(opp, day);
    const projOwn = this.projectStarters(team, day);
    const gProj = projOpp.reduce((a, x) => a + x.p * this.goalieRating(x.goalie, day).rate, 0) + (projOpp.length ? 0 : this.p.goalie_prior_rate);
    const oppStarter = actualStarter && actualStarter.opp != null ? actualStarter.opp : null;
    const gAct = oppStarter != null ? this.goalieRating(oppStarter, day) : null;
    const L = this.leagueRates(day);
    return {
      day, league_games: L.games, league_ev_xg60: L.ev_xg60, league_g_pg: L.g_pg,
      home: isHome ? 1 : 0, rest, rest_opp: restO, b2b: rest === 1 ? 1 : 0, b2b_opp: restO === 1 ? 1 : 0,
      ev_off: r.ev_off, ev_def_opp: o.ev_def, g_off: r.g_off, g_def_opp: o.g_def,
      pp_off: r.pp_off, pk_def_opp: o.pk_def, pp_draw: r.pp_draw, pk_take_opp: o.pk_take, fin: r.fin,
      opp_goalie_proj: gProj, opp_goalie_proj_top: projOpp[0] ? projOpp[0].goalie : null, opp_goalie_proj_p: projOpp[0] ? projOpp[0].p : null,
      opp_goalie_act: gAct ? gAct.rate : null, opp_goalie_act_known: gAct ? gAct.known : null,
      own_goalie_proj_top: projOwn[0] ? projOwn[0].goalie : null,
      weight: r.games_weight, weight_opp: o.games_weight,
    };
  }

  /** absorb one completed game: rows = its two team-game rows */
  absorb(rows) {
    const [a, b] = rows; const day = dayNum(a.date);
    const pre = {};
    for (const x of rows) pre[x.team] = this.teamRatings(x.team, day);
    const L = this.league; L.age(day, this.p.half_life_days);
    const sw = this.sw;
    for (const x of rows) {
      const opp = x === a ? b : a;
      const t = this.T(x.team); t.age(day, this.p.half_life_days);
      const po = pre[opp.team];
      const xgfAdj = (x.ev5_xgf_lead || 0) * sw.lead + (x.ev5_xgf_tie || 0) * sw.tie + (x.ev5_xgf_trail || 0) * sw.trail;
      const xgaAdj = (opp.ev5_xgf_lead || 0) * sw.lead + (opp.ev5_xgf_tie || 0) * sw.tie + (opp.ev5_xgf_trail || 0) * sw.trail;
      t.add('ev_xgf_adj', xgfAdj / Math.max(0.5, po.ev_def));
      t.add('ev_xga_adj', xgaAdj / Math.max(0.5, po.ev_off));
      t.add('toi_ev5', x.toi_ev5 || 0);
      t.add('gf_adj', x.gf / Math.max(0.5, po.g_def)); t.add('ga_adj', x.ga / Math.max(0.5, po.g_off)); t.add('games', 1);
      t.add('pp_xgf', x.pp_xgf || 0); t.add('toi_pp', x.toi_pp || 0);
      t.add('sh_xga', opp.pp_xgf || 0); t.add('toi_sh', x.toi_sh || 0);
      const xgVsTender = (x.ev5_xgf || 0) + (x.evo_xgf || 0) + (x.pp_xgf || 0) + (x.sh_xgf || 0);
      const gVsTender = (x.ev5_gf || 0) + (x.evo_gf || 0) + (x.pp_gf || 0) + (x.sh_gf || 0);
      t.add('gf_vs_tender', gVsTender); t.add('xgf_vs_tender', xgVsTender);
      L.add('ev_xgf', xgfAdj); L.add('toi_ev5', x.toi_ev5 || 0); L.add('gf', x.gf); L.add('games', 1);
      L.add('pp_xgf', x.pp_xgf || 0); L.add('toi_pp', x.toi_pp || 0);
      /* this team's goalies, on the shots they faced */
      for (const k of ['g1', 'g2']) {
        const id = x[k + '_id'];
        if (id == null || id === '') continue;
        const g = this.G(id); g.age(day, this.p.goalie_half_life_days);
        g.add('xga', x[k + '_xga'] || 0); g.add('ga', x[k + '_ga'] || 0); g.add('fa', x[k + '_fa'] || 0);
        L.add('g_xga', x[k + '_xga'] || 0); L.add('g_ga', x[k + '_ga'] || 0);
      }
      /* starter history and the back-to-back rule */
      const last = this.lastGame.get(x.team);
      if (last && day - last.day === 1 && last.starter != null && x.g_start != null) { this.b2bSecond.n++; if (x.g_start === last.starter) this.b2bSecond.same++; }
      const st = this.starts.get(x.team) || []; if (x.g_start != null) { st.push(x.g_start); if (st.length > 30) st.shift(); } this.starts.set(x.team, st);
      this.lastGame.set(x.team, { day, starter: x.g_start });
    }
  }
}

/* score-state weights from earlier seasons: overall 5v5 xG rate / the rate in each state */
function scoreWeights(rows) {
  const s = { lead: [0, 0], tie: [0, 0], trail: [0, 0] };
  for (const x of rows) {
    s.lead[0] += x.ev5_xgf_lead || 0; s.lead[1] += x.toi_ev5_lead || 0;
    s.tie[0] += x.ev5_xgf_tie || 0; s.tie[1] += x.toi_ev5_tie || 0;
    s.trail[0] += x.ev5_xgf_trail || 0; s.trail[1] += x.toi_ev5_trail || 0;
  }
  const all = (s.lead[0] + s.tie[0] + s.trail[0]) / Math.max(1, s.lead[1] + s.tie[1] + s.trail[1]);
  const w = (k) => (s[k][1] > 0 && s[k][0] > 0 ? all / (s[k][0] / s[k][1]) : 1);
  return { lead: +w('lead').toFixed(4), tie: +w('tie').toFixed(4), trail: +w('trail').toFixed(4) };
}

module.exports = { RatingState, scoreWeights, DEFAULTS, dayNum };
