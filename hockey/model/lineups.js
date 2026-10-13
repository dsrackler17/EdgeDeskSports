'use strict';
/* ===========================================================================
   EdgeDesk NHL — lineup availability, point in time.

   The ratings (ratings.js) describe a team as it has played, which is with
   its usual lineup. What they miss is a regular who is out tonight, or back.
   This state measures exactly that, and nothing else:

     player value   a skater's recent time on ice per game (any team), shrunk
                    toward a depth-player prior. Coaches give ice time to the
                    players they trust, so TOI is the most stable, fully
                    observed proxy for a skater's importance (it needs no xG
                    or on-ice model, and the box score records it for every
                    game since 2010-11).
     lineup value   the sum over the dressed skaters.
     typical        the mean lineup value of the team's last `window` games,
                    each re-valued with today's player estimates (so a
                    player's changing role is not mistaken for an absence).
     delta          ln(lineup value / typical): below 0 when regulars are
                    missing, above 0 when they return.

   Two deltas per game, both point in time:
     proj   the team's previous game's lineup (known before warmups)
     conf   the lineup that dressed (known at warmups, ≈ 30 min before puck
            drop — the walk-forward's prediction time; the confirmed-goalie
            assumption, applied to skaters)

   A team with no history yet has delta 0 and `known` false. Nothing about a
   game reaches its own snapshot: absorb() runs after the day's snapshots.
   =========================================================================== */

const DEFAULTS = {
  memory_games: 20,        /* a player's TOI history kept, in his own games */
  prior_toi_s: 600,        /* depth-player prior: 10 minutes */
  prior_games: 3,          /* prior weight, in games */
  window: 10,              /* the team's typical lineup: its last 10 games */
};

class LineupState {
  constructor(params, predecessor) {
    this.p = Object.assign({}, DEFAULTS, params || {});
    this.player = new Map(); /* id -> [toi_s, ...] most recent last */
    this.team = new Map();   /* abbr -> [[ids], ...] most recent last */
    this.pred = predecessor || {};
  }
  /* a relocated franchise keeps its roster: its first game inherits the predecessor's history */
  hist(team) {
    let h = this.team.get(team);
    if (!h && this.pred[team] && this.team.has(this.pred[team])) { h = this.team.get(this.pred[team]).slice(); this.team.set(team, h); }
    return h;
  }

  value(id) {
    const h = this.player.get(id);
    const n = h ? h.length : 0; let s = 0;
    if (h) for (const t of h) s += t;
    return (s + this.p.prior_toi_s * this.p.prior_games) / (n + this.p.prior_games);
  }
  lineupValue(ids) { let v = 0; for (const id of ids) v += this.value(id); return v; }

  /** dressed: [player ids] or null when not known */
  snapshot(team, dressed) {
    const hist = this.hist(team);
    if (!hist || hist.length < 3) return { known: false, proj: 0, conf: 0, typical: null, games: hist ? hist.length : 0 };
    let typical = 0; for (const ids of hist) typical += this.lineupValue(ids); typical /= hist.length;
    const proj = Math.log(this.lineupValue(hist[hist.length - 1]) / typical);
    const conf = dressed && dressed.length >= 12 ? Math.log(this.lineupValue(dressed) / typical) : null;
    return { known: true, proj, conf, typical, games: hist.length };
  }

  /** regulars of the typical lineup absent from the given (or the previous) lineup, with how long they have been out.
      A long absence may be an injury or a player no longer on the roster: no roster or injury feed says which. */
  missingRegulars(team, dressed, minToiS) {
    const hist = this.hist(team);
    if (!hist || !hist.length) return [];
    const now = new Set(dressed || hist[hist.length - 1]);
    const seen = new Map();
    for (const ids of hist) for (const id of ids) seen.set(id, (seen.get(id) || 0) + 1);
    const streak = (id) => { let n = 0; for (let i = hist.length - 1; i >= 0 && hist[i].indexOf(id) < 0; i--) n++; return n; };
    return [...seen.entries()].filter(([id, n]) => !now.has(id) && n >= Math.ceil(hist.length / 2) && this.value(id) >= (minToiS || 900))
      .map(([id, n]) => ({ player_id: id, toi_per_game_s: Math.round(this.value(id)), dressed_in_window: n + '/' + hist.length, absent_last_games: dressed ? streak(id) + 1 : streak(id) }))
      .sort((a, b) => b.toi_per_game_s - a.toi_per_game_s);
  }

  /** absorb one team-game: skaters = [[id, toi_s, pos], ...] */
  absorb(team, skaters) {
    const ids = [];
    for (const [id, toi] of skaters) {
      ids.push(id);
      if (toi == null) continue; /* an unknown TOI is not a zero */
      let h = this.player.get(id);
      if (!h) this.player.set(id, (h = []));
      h.push(toi);
      if (h.length > this.p.memory_games) h.shift();
    }
    let t = this.hist(team);
    if (!t) this.team.set(team, (t = []));
    t.push(ids);
    if (t.length > this.p.window) t.shift();
  }
}

module.exports = { LineupState, DEFAULTS };
