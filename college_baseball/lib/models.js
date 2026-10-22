'use strict';
/* ===========================================================================
   EdgeDesk college baseball — the competing team-level models, one interface.

   Candidates are declared here in order of complexity BEFORE scoring; the
   first is the incumbent (research/PROTOCOL.md §3):

     home_rate     constant home win rate                       (baseline 1)
     pythag        season-to-date Pythagenpat, log5              (baseline 2)
     elo           results-only Elo                              (baseline 3)
     bt            Bradley-Terry on results, carried priors
     massey        ridge least squares on run margin (Massey)
     poisson_flat  opponent-adjusted runs, teams pooled to 0      (Model 1)
     hier          opponent-adjusted runs, team ⊂ conference ⊂ division,
                   parks, connectivity-aware uncertainty          (Model 3)

   A run model turns its two expected run totals into a win probability with
   the fitted run distribution (lib/distribution.js), integrating over its own
   rating uncertainty, and mixing nine- and seven-inning lengths for a
   doubleheader game with the measured share.
   =========================================================================== */
const B = require('./baselines');
const TQ = require('./team_quality');
const D = require('./distribution');
const W = require('./warehouse');

const CANDIDATES = ['home_rate', 'pythag', 'elo', 'bt', 'massey', 'poisson_flat', 'hier'];
const BASELINES = ['home_rate', 'pythag', 'elo'];
const RUN_MODELS = ['poisson_flat', 'hier'];

/* o.until: the last season a model may read (the learning loop never loads the holdout) */
function meta(o) {
  o = o || {};
  const by = new Map();
  for (const t of W.teamSeasons()) by.set(t.season + ':' + t.team_id, t);
  let cont = null;   /* roster continuity (lib/continuity.js), read only when a model asks for it */
  let sp = null;     /* projected starters (lib/starters.js), the same */
  return {
    continuity: (s, id) => { if (!cont) cont = require('./continuity').load(); return cont.centred(s, id); },
    starter: (g) => { if (!sp) sp = require('./starters').load({ until: o.until }); return sp.of(g); },
    platoon: (g) => { if (!sp) sp = require('./starters').load({ until: o.until }); return sp.platoon(g); },
    conf: (s, id) => { const t = by.get(s + ':' + id); return t ? t.conference || null : null; },
    div: (s, id) => { const t = by.get(s + ':' + id); return t ? t.division : null; },
    name: (s, id) => { const t = by.get(s + ':' + id); return t ? t.name : null; },
  };
}

class RunModel {
  constructor(name, cfg, ctx) {
    this.name = name; this.cfg = cfg; this.ctx = ctx;
    this.tq = new TQ.TeamQuality(Object.assign({}, cfg.tq, { hier: name === 'hier' ? (cfg.tq.hier !== false) : false, parks: name === 'hier' ? (cfg.tq.parks !== false) : false }), ctx.meta);
    this.spec = cfg.dist || ctx.dist || { family: 'nb', r: 4 };
  }
  startSeason(s) { this.tq.startSeason(s); }
  pHome(lh, la) { if (!this.table) this.table = D.pHomeTable(this.spec, this.ctx.constants); return this.table(lh, la); }
  predict(g) {
    const r = this.tq.predict(g);
    const sd = r.sd_delta * (this.cfg.uncertainty_scale == null ? 1 : this.cfg.uncertainty_scale);
    let p = TQ.integrate(r.lh, r.la, sd, (a, b) => this.pHome(a, b));
    let p7 = 0;
    if (g.dh && this.ctx.p7) {
      p7 = this.ctx.p7(g);
      if (p7 > 0) { const f = this.ctx.constants.seven_inning_factor; const q7 = TQ.integrate(r.lh * f, r.la * f, sd, (a, b) => this.pHome(a, b)); p = (1 - p7) * p + p7 * q7; }
    }
    return { p, lh: r.lh, la: r.la, sd: r.sd_delta, sd_home: r.sd_home, sd_away: r.sd_away, park: r.park, net_home: r.net_home, net_away: r.net_away, p7, info_home: r.info_home, info_away: r.info_away };
  }
  addGames(gs) { this.tq.addGames(gs); }
  fit(day) { this.tq.fit(day); }
}

function make(name, cfg, ctx) {
  cfg = cfg || {};
  switch (name) {
    case 'home_rate': return new B.HomeRate(cfg);
    case 'pythag': return new B.Pythag(cfg, ctx.meta);
    case 'elo': return new B.Elo(cfg, ctx.meta);
    case 'bt': return new B.Ridge('bt', cfg, ctx.meta);
    case 'massey': return new B.Ridge('massey', cfg, ctx.meta);
    case 'poisson_flat': case 'hier': return new RunModel(name, Object.assign({ tq: {} }, cfg), ctx);
    default: throw new Error('unknown model ' + name);
  }
}

/**
 * Run one model through the seasons, chronologically, date by date.
 * games: usable games sorted by date. Returns Map game_id -> prediction.
 * opts.score(g): whether to keep the prediction; opts.until: last season to run.
 */
function runModel(name, cfg, games, ctx, opts) {
  opts = opts || {};
  const m = make(name, cfg, ctx);
  const out = new Map();
  let season = null; let i = 0;
  while (i < games.length) {
    const date = games[i].date; let j = i; while (j < games.length && games[j].date === date) j++;
    const day = games.slice(i, j);
    const s = day[0].season;
    if (opts.until && s > opts.until) break;
    if (s !== season) { m.startSeason(s); season = s; }
    for (const g of day) if (!opts.score || opts.score(g)) out.set(g.game_id, m.predict(g));
    m.addGames(day);
    m.fit(Date.parse(date + 'T00:00:00Z') / 864e5 + 1);
    i = j;
  }
  return { preds: out, model: m };
}

module.exports = { CANDIDATES, BASELINES, RUN_MODELS, meta, make, runModel, RunModel };
