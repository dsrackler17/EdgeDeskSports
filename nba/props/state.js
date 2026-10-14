'use strict';
/* ===========================================================================
   EdgeDesk NBA props — the point-in-time player pass: one row per player per
   game he played, its features built only from games before it.

   A prop settles only if the player plays, so rows are the games a player
   appeared in; who appears is exactly the `confirmed` availability regime
   (the inactive list and starters are public ~30 minutes before tip). The
   projected regime's features use only the team's previous game.

   STATE per player (updated when a game becomes available, start + 4 h):
     ewm      exponentially weighted per-game means (half-life 10 games) of
              minutes, the seven counted stats, FGA, FTA, fouls and starts
     season   season-to-date totals (minutes and stats)
     long     long-run per-minute rates (half-life 60 games)
   STATE per team: what each opponent allows per 48 minutes of each stat
   (half-life 15 games), the team's usage (FGA + 0.44·FTA + TOV) by player,
   and the league's per-48 rates (running).

   FEATURES (per stat k): three per-minute rates shrunk toward the league
   position rate with a 150-minute prior (Bayesian shrinkage: few minutes →
   close to the position average), the opponent's allowed factor, the game's
   pace factor and expected margin (from the game pass: blowout risk), the
   share of the team's usual usage that is missing tonight (teammates absent
   → more shots for the rest), home, back-to-back, rest, season games.
   =========================================================================== */
const D = require('../lib/data');

const STATS = ['pts', 'reb', 'ast', 'fg3m', 'stl', 'blk', 'tov'];
const RAW = { pts: (r) => r.pts, reb: (r) => r.or + r.dr, ast: (r) => r.ast, fg3m: (r) => r.f3m, stl: (r) => r.stl, blk: (r) => r.blk, tov: (r) => r.tov };
const POSG = (pos) => { const p = String(pos || '').toUpperCase(); if (/C/.test(p)) return 'C'; if (/F/.test(p)) return 'F'; return 'G'; };

function newPlayer(pos) {
  const z = () => Object.fromEntries(STATS.map((k) => [k, 0]));
  return { pos: POSG(pos), ew: { w: 0, min: 0, st: 0, fga: 0, fta: 0, pf: 0, s: z() }, lg: { min: 0, s: z() }, season: null, ss: { g: 0, min: 0, s: z() }, last_ms: null, games: 0, team: null };
}

/**
 * run({ gameRows: Map(game_id → pass row), seasons, log })
 * → rows [{ g, p, tm, opp, season, date, start, track features…, y: {min, pts, …} }]
 */
function run(o) {
  const seasons = o.seasons; const ctx = o.gameRows || new Map();
  const games = D.games(seasons).filter((g) => g.status === 'FINAL');
  const players = D.playersMap();
  const P = new Map(); const Tm = new Map(); const league = { w: 0, s48: Object.fromEntries(STATS.map((k) => [k, 0])) };
  const posRate = { G: {}, F: {}, C: {} }; for (const g of Object.keys(posRate)) for (const k of STATS) posRate[g][k] = { m: 0, x: 0 };
  const lastTeamGame = new Map(); /* team → [pids who played] */
  const usual = new Map();        /* team → Map(pid → ewm usage per game) */
  const out = [];
  let pgBy = new Map(), curSeason = null;
  const pending = []; let head = 0;
  const AEW = Math.pow(0.5, 1 / 10), ALG = Math.pow(0.5, 1 / 60), AOPP = Math.pow(0.5, 1 / 15);

  function team(t) { let x = Tm.get(t); if (!x) { x = { w: 0, allow: Object.fromEntries(STATS.map((k) => [k, 0])), mins: 0 }; Tm.set(t, x); } return x; }
  function absorb(g) {
    const rows = pgBy.get(g.game_id) || [];
    const tot = {}; const usage = {};
    for (const r of rows) {
      if (!r.pl) continue;
      let p = P.get(r.p); if (!p) { p = newPlayer((players[r.p] || {}).pos); P.set(r.p, p); }
      if (p.season !== g.season) { p.season = g.season; p.ss = { g: 0, min: 0, s: Object.fromEntries(STATS.map((k) => [k, 0])) }; }
      p.ew.w = p.ew.w * AEW + 1; p.ew.min = p.ew.min * AEW + r.min; p.ew.st = p.ew.st * AEW + (r.st ? 1 : 0);
      p.ew.fga = p.ew.fga * AEW + r.fga; p.ew.fta = p.ew.fta * AEW + r.fta; p.ew.pf = p.ew.pf * AEW + r.pf;
      p.lg.min = p.lg.min * ALG + r.min; p.ss.g++; p.ss.min += r.min; p.games++; p.last_ms = g.start_ms; p.team = r.tm;
      for (const k of STATS) { const v = RAW[k](r); p.ew.s[k] = p.ew.s[k] * AEW + v; p.lg.s[k] = p.lg.s[k] * ALG + v; p.ss.s[k] += v; posRate[p.pos][k].m += r.min; posRate[p.pos][k].x += v; }
      (tot[r.tm] = tot[r.tm] || Object.fromEntries(STATS.map((k) => [k, 0])));
      for (const k of STATS) tot[r.tm][k] += RAW[k](r);
      (usage[r.tm] = usage[r.tm] || []).push([r.p, r.fga + 0.44 * r.fta + r.tov]);
    }
    const mins = 48 + 5 * (g.ot || 0);
    for (const [tm, opp] of [[g.home_id, g.away_id], [g.away_id, g.home_id]]) {
      const T = team(tm); const t = tot[opp]; if (!t) continue;
      T.w = T.w * AOPP + 1; for (const k of STATS) T.allow[k] = T.allow[k] * AOPP + t[k] * 48 / mins;
      league.w += 1; for (const k of STATS) league.s48[k] += t[k] * 48 / mins;
    }
    for (const [tm, list] of Object.entries(usage)) {
      lastTeamGame.set(tm, list.map((x) => x[0]));
      const u = usual.get(tm) || new Map(); for (const [pid, v] of u) u.set(pid, v * AEW);
      for (const [pid, v] of list) u.set(pid, (u.get(pid) || 0) + v * (1 - AEW));
      usual.set(tm, u);
    }
  }
  function rate(p, k, which) {
    const prior = posRate[p.pos][k]; const pr = prior.m > 0 ? prior.x / prior.m : 0; const M0 = 150;
    if (which === 'ew') return (p.ew.s[k] + pr * M0) / (p.ew.min + M0);
    if (which === 'ss') return (p.ss.s[k] + pr * M0) / (p.ss.min + M0);
    return (p.lg.s[k] + pr * M0) / (p.lg.min + M0);
  }

  for (const g of games) {
    if (curSeason !== g.season) {
      while (head < pending.length) absorb(pending[head++]);
      curSeason = g.season;
      pgBy = new Map(); for (const r of D.playerGames(g.season)) { if (!pgBy.has(r.g)) pgBy.set(r.g, []); pgBy.get(r.g).push(r); }
      if (o.log) console.error('[nba props pass] season ' + g.season);
    }
    const predAt = g.start_ms - 30 * 60e3;
    while (head < pending.length && pending[head].avail_ms < predAt) absorb(pending[head++]);
    const rows = pgBy.get(g.game_id) || [];
    const c = ctx.get(g.game_id); const f = c ? c.f : null;
    const lg48 = league.w > 0 ? Object.fromEntries(STATS.map((k) => [k, league.s48[k] / league.w])) : null;
    for (const side of ['h', 'a']) {
      const tm = side === 'h' ? g.home_id : g.away_id, opp = side === 'h' ? g.away_id : g.home_id;
      const played = rows.filter((r) => r.tm === tm && r.pl);
      const playedSet = new Set(played.map((r) => r.p));
      const lastSet = new Set(lastTeamGame.get(tm) || []);
      const U = usual.get(tm) || new Map(); let uTot = 0; for (const v of U.values()) uTot += v;
      let missConf = 0, missProj = 0; for (const [pid, v] of U) { if (v < 0.5) continue; if (!playedSet.has(pid)) missConf += v; if (!lastSet.has(pid)) missProj += v; }
      const OT = Tm.get(opp);
      for (const r of played) {
        const p = P.get(r.p); if (!p || p.games < 3) continue;
        const ew = (k) => rate(p, k, 'ew'), ss = (k) => rate(p, k, 'ss'), lgr = (k) => rate(p, k, 'lg');
        const minEw = p.ew.min / Math.max(1e-9, p.ew.w);
        const feat = {
          min_ew: minEw, min_ss: p.ss.g ? p.ss.min / p.ss.g : minEw, start_rate: p.ew.st / Math.max(1e-9, p.ew.w), starter: r.st ? 1 : 0,
          g_ss: p.ss.g, rest: p.last_ms ? Math.min(5, (g.start_ms - p.last_ms) / 864e5) : 5, pf_rate: p.ew.pf / Math.max(1, p.ew.min),
          usage_share: uTot > 0 ? (U.get(r.p) || 0) / uTot : 0, miss_conf: uTot > 0 ? missConf / uTot : 0, miss_proj: uTot > 0 ? missProj / uTot : 0,
          in_last: lastSet.has(r.p) ? 1 : 0, home: side === 'h' && !g.neutral ? 1 : 0,
          pace: f ? f.pace : null, margin: f ? (side === 'h' ? f.kal_m : -f.kal_m) : null, total: f ? f.kal_t : null,
          b2b: f ? (side === 'h' ? f.b2b_h : f.b2b_a) : 0, pos: p.pos,
        };
        for (const k of STATS) {
          feat['r_ew_' + k] = ew(k); feat['r_ss_' + k] = ss(k); feat['r_lg_' + k] = lgr(k);
          feat['opp_' + k] = OT && OT.w > 3 && lg48 && lg48[k] > 0 ? (OT.allow[k] / OT.w) / lg48[k] : 1;
          feat['avg10_' + k] = p.ew.s[k] / Math.max(1e-9, p.ew.w); feat['avgss_' + k] = p.ss.g ? p.ss.s[k] / p.ss.g : null;
        }
        const y = { min: r.min }; for (const k of STATS) y[k] = RAW[k](r);
        out.push({ g: g.game_id, p: r.p, tm, opp, season: g.season, date: g.date, start: g.start_ms, predicted_at: predAt, f: feat, y });
      }
    }
    pending.push(g);
  }
  /* UPCOMING games (the props slate): the projected players are the team's
     previous-game rotation; nothing of the game itself is known. */
  const upcoming = [];
  if (o.upcoming && o.upcoming.length) {
    while (head < pending.length) absorb(pending[head++]);
    const lg48 = league.w > 0 ? Object.fromEntries(STATS.map((k) => [k, league.s48[k] / league.w])) : null;
    for (const u of o.upcoming) {
      for (const side of ['h', 'a']) {
        const tm = side === 'h' ? u.home : u.away, opp = side === 'h' ? u.away : u.home;
        const lastSet = new Set(lastTeamGame.get(tm) || []);
        const U = usual.get(tm) || new Map(); let uTot = 0; for (const v of U.values()) uTot += v;
        let missProj = 0; for (const [pid, v] of U) { if (v >= 0.5 && !lastSet.has(pid)) missProj += v; }
        const OT = Tm.get(opp); const f0 = u.f || {};
        for (const pid of lastSet) {
          const p = P.get(pid); if (!p || p.games < 3) continue;
          const minEw = p.ew.min / Math.max(1e-9, p.ew.w);
          const feat = { min_ew: minEw, min_ss: p.ss.g ? p.ss.min / p.ss.g : minEw, start_rate: p.ew.st / Math.max(1e-9, p.ew.w), starter: null,
            g_ss: p.season === u.season ? p.ss.g : 0, rest: p.last_ms ? Math.min(5, (u.start - p.last_ms) / 864e5) : 5, pf_rate: p.ew.pf / Math.max(1, p.ew.min),
            usage_share: uTot > 0 ? (U.get(pid) || 0) / uTot : 0, miss_conf: uTot > 0 ? missProj / uTot : 0, miss_proj: uTot > 0 ? missProj / uTot : 0, in_last: 1,
            home: side === 'h' && !u.neutral ? 1 : 0, pace: f0.pace == null ? null : f0.pace, margin: f0.kal_m == null ? null : (side === 'h' ? f0.kal_m : -f0.kal_m), total: f0.kal_t, b2b: side === 'h' ? f0.b2b_h || 0 : f0.b2b_a || 0, pos: p.pos };
          for (const k of STATS) { feat['r_ew_' + k] = rate(p, k, 'ew'); feat['r_ss_' + k] = rate(p, k, 'ss'); feat['r_lg_' + k] = rate(p, k, 'lg'); feat['opp_' + k] = OT && OT.w > 3 && lg48 && lg48[k] > 0 ? (OT.allow[k] / OT.w) / lg48[k] : 1; feat['avg10_' + k] = p.ew.s[k] / Math.max(1e-9, p.ew.w); feat['avgss_' + k] = p.ss.g ? p.ss.s[k] / p.ss.g : null; }
          upcoming.push({ g: u.game_id, p: pid, tm, opp, season: u.season, start: u.start, f: feat });
        }
      }
    }
  }
  if (o.upcoming) return { rows: out, upcoming };
  return out;
}

module.exports = { run, STATS, RAW };
