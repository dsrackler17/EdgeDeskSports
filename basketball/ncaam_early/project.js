'use strict';
/* ===========================================================================
   NCAAM-EARLY — projections, point in time.

   For a target game, the ratings are rebuilt from ONLY the finals known before
   its projection time (tip - 30 min; a final is known 4 h after its tip, the
   repository's timing rule, config.AVAILABLE_AFTER_MS): no later result, box
   line or close can reach a projection. The league constants (mu, eta, tau)
   are last season's engine values, held fixed through the season.

     seasonGames(games, boxes)       this season's D-I v D-I finals in the
                                     model's form { home, away, neutral, yH, yA,
                                     poss, tempo, start_ms, known_ms }
     projectGames(targets, x, cfg)   one projection per target game; x carries
                                     priors (Map), finals, league, features (Map)
   =========================================================================== */
const M = require('./model');
const MK = require('./market');
const C = require('./config');

const PREDICT_BEFORE_MS = 30 * 60e3;

/* possessions of a game: the mean of both teams' estimates, per 40 minutes
   for the tempo (overtime would inflate a game's possession count) */
function seasonGames(games, boxes) {
  const box = new Map();
  for (const b of boxes || []) { if (!b.box_ok) continue; if (!box.has(b.game_id)) box.set(b.game_id, new Map()); box.get(b.game_id).set(b.team_id, b); }
  const out = [];
  for (const g of games) {
    if (g.status !== 'FINAL') continue;
    const bx = box.get(g.game_id); const h = bx && bx.get(g.home_team_id), a = bx && bx.get(g.away_team_id);
    if (!h || !a || h.possessions == null || a.possessions == null) continue;
    const poss = (h.possessions + a.possessions) / 2;
    if (!(poss > 0)) continue;
    const minutes = h.game_minutes && h.game_minutes >= 40 ? h.game_minutes : 40;
    out.push({ game_id: g.game_id, home: g.home_team_id, away: g.away_team_id, neutral: g.neutral === true, yH: (100 * g.home_points) / poss, yA: (100 * g.away_points) / poss,
      poss, tempo: (poss * 40) / minutes, start_ms: Date.parse(g.start_utc), known_ms: Date.parse(g.start_utc) + C.AVAILABLE_AFTER_MS });
  }
  return out.sort((x, y) => x.known_ms - y.known_ms);
}

/** x: { priors: Map(team -> preseasonPrior), finals: seasonGames(), league: { mu, eta, tau },
         features: Map(team -> feature row), quotes?: Map(game_id -> { spread, total, moneyline }) }
    each target: { game_id, home_team_id, away_team_id, neutral, start_utc } */
function projectGames(targets, x, cfg, o) {
  o = o || {};
  const out = []; const cache = new Map();
  for (const g of targets.slice().sort((a, b) => Date.parse(a.start_utc) - Date.parse(b.start_utc))) {
    const at = Date.parse(g.start_utc) - PREDICT_BEFORE_MS;
    const ph = x.priors.get(g.home_team_id), pa = x.priors.get(g.away_team_id);
    if (!ph || !pa) { out.push({ game_id: g.game_id, status: 'NOT_PROJECTED', reason: !ph && !pa ? 'neither team has a prior (not D-I or no features)' : (!ph ? 'home' : 'away') + ' team has no prior (not D-I or no features)' }); continue; }
    const known = x.finals.filter((f) => f.known_ms <= at);
    const key = known.length;
    if (!cache.has(key)) cache.set(key, M.fitSeason(x.priors, known, x.league, cfg));
    const R = cache.get(key);
    const h = R.get(g.home_team_id), a = R.get(g.away_team_id);
    const p = M.project(h, a, g.neutral === true, x.league, cfg);
    const fh = x.features && x.features.get(g.home_team_id), fa = x.features && x.features.get(g.away_team_id);
    const row = { game_id: g.game_id, status: 'PROJECTED', season: g.season, home_team_id: g.home_team_id, away_team_id: g.away_team_id, neutral: g.neutral === true, start_utc: g.start_utc,
      projected_for: new Date(at).toISOString(), inputs_known_through: known.length ? new Date(Math.max(...known.map((f) => f.known_ms))).toISOString() : null, finals_used: known.length,
      home_games: h.games, away_games: a.games, home_prior_weight: h.w_prior, away_prior_weight: a.w_prior,
      home_off: h.off, home_allow: h.allow, home_tempo: h.tempo, away_off: a.off, away_allow: a.allow, away_tempo: a.tempo,
      home_var: h.var_side, away_var: a.var_side,
      fair_spread_home: p.fair_spread_home, fair_total: p.fair_total, win_prob_home: p.win_prob_home, margin: p.margin, total: p.total, possessions: p.possessions,
      sd_margin: p.sd_margin, sd_total: p.sd_total, angles: MK.angleTags(fh, fa, ph, pa), continuity: fh && fa ? { home: fh.returning_minutes_share, away: fa.returning_minutes_share } : null,
      flags: [...new Set([].concat(p.flags, ph.flags, pa.flags))] };
    if (o.projection) row._projection = p;
    out.push(row);
  }
  return out;
}

/** the market comparison and Conviction for projected games (prices from
    EdgeDesk's own capture): each market's best side, its Edge and tier */
function compareAll(rows, x, now, cfg) {
  const vars = rows.filter((r) => r.status === 'PROJECTED').flatMap((r) => [r.home_var, r.away_var]);
  const cap = MK.varianceCap(vars);
  return rows.map((r) => {
    if (r.status !== 'PROJECTED' || !r._projection) return r;
    const q = (x.quotes && x.quotes.get(r.game_id)) || {};
    const markets = ['spread', 'total', 'moneyline'].map((m) => {
      const c = MK.compare(m, r._projection, q[m] || [], now, cfg);
      const best = c.sides.slice().sort((a, b) => b.edge - a.edge)[0] || null;
      const stale = c.flags.includes('STALE_PRICE') || c.flags.includes('NO_PRICE');
      return Object.assign(c, { best, conviction: MK.conviction(best ? best.edge : null, { var_home: r.home_var, var_away: r.away_var, cap, angles: r.angles, thin: c.thin, stale }, cfg) });
    });
    return Object.assign({}, r, { variance_cap: cap, markets });
  });
}

module.exports = { seasonGames, projectGames, compareAll, PREDICT_BEFORE_MS };
