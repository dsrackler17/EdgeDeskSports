/* FSIE tests: a deterministic synthetic panel (team states, lines, labels and
   script cells) for training and checking the volume model offline. Synthetic
   on purpose: it proves mechanics (reconciliation, coherence, determinism),
   never accuracy, which only the real walk-forward and holdout measure. */
'use strict';
const U = require('../core/util.js');
const VM = require('../core/volume_model.js');
const SCR = VM.SCRIPTS;
function metric(v, n) { return { v, raw: v, n: n || 100, prior: v }; }
function teamState(u, pace, pr) {
  const off = { plays_pg: metric(pace), drives_pg: metric(pace / 6), ppd: metric(6), spp_neutral: metric(27), spp_all: metric(29), pr_all: metric(pr), pr_neutral: metric(pr - 0.02),
    pr_early: metric(pr - 0.05), pr_passing_down: metric(0.8), points_pg: metric(22), sack_rate: metric(0.065), scramble_rate: metric(0.04), kneels_pg: metric(0.8), shotgun_rate: null, no_huddle_rate: null };
  SCR.forEach((s, i) => { off['pr_x_' + s] = metric(U.clamp(pr + (s === 'trailing' ? 0.12 : s === 'leading' ? -0.1 : s === 'two_minute' ? 0.2 : 0) + (u() - 0.5) * 0.02, 0.2, 0.9)); });
  const def = JSON.parse(JSON.stringify(off)); def.plays_pg = metric(pace + (u() - 0.5) * 4);
  return { off, def, adj: { off: { pr_neutral: 0, plays_pg: 0 }, def: { pr_neutral: 0, plays_pg: 0 } }, meta: { games_off: 5 } };
}
const LG = { plays_pg: 63, drives_pg: 10.5, ppd: 6, spp_neutral: 27, spp_all: 29, pr_all: 0.6, pr_neutral: 0.58, pr_early: 0.55, pr_passing_down: 0.8, points_pg: 22, sack_rate: 0.065, scramble_rate: 0.04,
  pr_x_competitive: 0.6, pr_x_leading: 0.5, pr_x_trailing: 0.72, pr_x_garbage: 0.6, pr_x_two_minute: 0.8 };
function panel(n, seed) {
  const u = U.rng(seed || 7); const Nm = U.normalSampler(u); const rows = [];
  for (let g = 0; g < n; g++) {
    const pa = 58 + u() * 10, pb = 58 + u() * 10, ra = 0.52 + u() * 0.14, rb = 0.52 + u() * 0.14;
    const A = teamState(u, pa, ra), B = teamState(u, pb, rb);
    const m = (u() - 0.5) * 20, tot = 38 + u() * 14;
    const margin = Math.round(m + 13 * Nm());
    [[A, B, m, 1, margin], [B, A, -m, -1, -margin]].forEach(([T1, T2, mm, home, mg], k) => {
      const plays = Math.round((k ? pb : pa) + 0.1 * mm + 6 * Nm()); const pr = U.clamp((k ? rb : ra) - 0.004 * (mg - mm) + 0.05 * Nm(), 0.25, 0.85);
      const db = Math.round(plays * pr), sacks = Math.round(db * 0.065), scr = Math.round((db - sacks) * 0.04);
      const lead = U.clamp(0.15 + 0.012 * mm, 0.02, 0.4), trail = U.clamp(0.15 - 0.012 * mm, 0.02, 0.4);
      const sc = {}; let left = plays; SCR.forEach((s, i) => { const x = i === SCR.length - 1 ? left : Math.round(plays * [0.75 - lead - trail, lead, trail, 0.03, 0.07][i]); sc[s] = { n: x, db: Math.round(x * pr), rush: x - Math.round(x * pr) }; left -= x; });
      rows.push({ sport: 'nfl', season: 2020, week: 1 + (g % 17), game_id: 'g' + g, team: k ? 'B' + g : 'A' + g, opp: k ? 'A' + g : 'B' + g, home, rest_diff: 0, m: mm, total: tot, m_source: 'line',
        T: T1, O: T2, league: LG, script: sc,
        labels: { plays, pass_att: db - sacks - scr, rush_att: plays - db + scr, sacks, dropbacks: db, scrambles: scr, drives: Math.max(6, Math.round(plays / 6 + Nm())), margin: mg, db_rate: db / plays } });
    });
  }
  return rows;
}
module.exports = { panel, teamState, LG };
