'use strict';
/* ===========================================================================
   A constructed NBA team for the role-shift tests: every number is chosen so
   the expected split, shrinkage, regime and cross-check can be worked out by
   hand (tools/sharp_lag/role_shift.test.js does). No real data, no network.

   Club 10 (home, "Home Club") in game G1 against club 20. Thirty final games,
   g1..g30, one a day from 2026-03-01:
     A  '1'  Absent Star   plays g1-g10 and g21-g30; DNP (listed) g11-g15,
                           not in the box at all g16-g20 (he was on the team)
     T1 '2'  Absorber      24 min with A, 32 without; per game with / without:
                           PTS 12/18, REB 6/8, AST 2/4, FGA 10/14, FTA 2/3,
                           TOV 1/2, 3PA 5/8, 3PM 2/3
     T2 '3'  Steady        30 min and the same line either way
     T3 '4'  Small         20 min with, 22 without; FGA 8/11
     T4 '5'  Newcomer      club 99 in g1-g15 (not with this team), club 10
                           from g16: 20 min without A (g16-g20), 10 with
     T5 '7'  Two-way       only g11-g15 (never with A)
     B  '6'  Bench Out     a top-8 player who missed the last game
   Stints (g21-g30, both A and T1 played): A on 0-600 and 1200-2880, off
   600-1200; T1 on except 1200-1500. T1 shoots a 2 at t=100, a 3 at t=700 and
   assists a make at t=800.
   =========================================================================== */
const START = Date.parse('2026-03-01T00:00:00Z');
const STATS = ['pts', 'reb', 'ast', 'fg3m', 'stl', 'blk', 'tov', 'fga', 'fg3a'];
const Q = [-6, -4.5, -3, -2, -1, 0, 1, 2, 3, 4.5, 6];

/* a props model (nba/props/model.js fit's shape) whose numbers are readable: expected minutes = min_ew,
   each stat's expected count = its recent per-minute rate x minutes */
function model() {
  const m = [0, 1]; while (m.length < 13) m.push(0);
  const b = [0, 1]; while (b.length < 12) b.push(0);
  return { track: 'P', minutes: { beta: m, sd_bands: [0, 12, 20, 28, 34, 99], sd: [5, 5, 5, 5, 5], q: [Q, Q, Q, Q, Q] },
    stats: Object.fromEntries(STATS.map((k) => [k, { beta: b.slice(), var_a: k === 'pts' ? 2.2 : 1, var_b: 0.05, size: 20 }])),
    corr: Object.fromEntries(STATS.map((a) => [a, Object.fromEntries(STATS.map((c) => [c, a === c ? 1 : 0.1]))])), n: 1000 };
}
const games = Array.from({ length: 30 }, (_, i) => ({ game_id: 'g' + (i + 1), start_ms: START + i * 864e5, home_id: '10', away_id: '20' }));
function row(g, p, tm, o) {
  return Object.assign({ g, p, tm, pl: true, min: 0, st: false, pts: 0, or: 0, dr: 0, ast: 0, f3m: 0, f3a: 0, fga: 0, fta: 0, tov: 0, stl: 0, blk: 0, pf: 0 }, o);
}
function rows() {
  const out = [];
  for (let i = 1; i <= 30; i++) {
    const g = 'g' + i, withA = i <= 10 || i >= 21;
    if (withA) out.push(row(g, '1', '10', { min: 34, pts: 25, dr: 7, ast: 6, fga: 20, fta: 6, tov: 3, f3a: 6, f3m: 2 }));
    else if (i <= 15) out.push(row(g, '1', '10', { pl: false, rc: 'INJURY' }));
    out.push(withA ? row(g, '2', '10', { min: 24, pts: 12, dr: 6, ast: 2, fga: 10, fta: 2, tov: 1, f3a: 5, f3m: 2 })
      : row(g, '2', '10', { min: 32, pts: 18, dr: 8, ast: 4, fga: 14, fta: 3, tov: 2, f3a: 8, f3m: 3 }));
    out.push(row(g, '3', '10', { min: 30, pts: 14, dr: 5, ast: 3, fga: 11, fta: 3, tov: 2, f3a: 4, f3m: 1 }));
    out.push(withA ? row(g, '4', '10', { min: 20, pts: 8, dr: 3, ast: 1, fga: 8, fta: 1, tov: 1, f3a: 2, f3m: 1 })
      : row(g, '4', '10', { min: 22, pts: 10, dr: 3, ast: 1, fga: 11, fta: 1, tov: 1, f3a: 2, f3m: 1 }));
    if (i <= 15) out.push(row(g, '5', '99', { min: 30, pts: 15, dr: 4, ast: 2, fga: 12, fta: 2, tov: 1, f3a: 3, f3m: 1 }));
    else out.push(withA ? row(g, '5', '10', { min: 10, pts: 4, dr: 2, ast: 1, fga: 4, fta: 0, tov: 0, f3a: 1, f3m: 0 })
      : row(g, '5', '10', { min: 20, pts: 9, dr: 4, ast: 2, fga: 8, fta: 1, tov: 1, f3a: 2, f3m: 1 }));
    if (i >= 11 && i <= 15) out.push(row(g, '7', '10', { min: 12, pts: 4, dr: 2, ast: 1, fga: 4, fta: 0, tov: 0, f3a: 1, f3m: 0 }));
    out.push(row(g, '6', '10', i === 30 ? { pl: false, rc: 'COACH' } : { min: 20, pts: 7, dr: 3, ast: 2, fga: 6, fta: 1, tov: 1, f3a: 2, f3m: 1 }));
  }
  return out;
}
/* the home five: A and T1 on or off, the rest from the steady players */
function five(aOn, tOn) { return ['3', '4', '5', aOn ? '1' : '6', tOn ? '2' : '9'].sort().join(' '); }
function stints() {
  const g = [];
  for (let i = 21; i <= 30; i++) {
    g.push({ g: 'g' + i, s: [[0, 600, five(true, true), 'a b c d e', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
      [600, 1200, five(false, true), 'a b c d e', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
      [1200, 1500, five(true, false), 'a b c d e', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
      [1500, 2880, five(true, true), 'a b c d e', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]] });
  }
  return { schema: 'edgedesk_nba_stints_v1', season: 2026, games: g };
}
function shots() {
  const r = [];
  for (let i = 21; i <= 30; i++) {
    r.push(['g' + i, 1, 100, '10', '2', 1, 2, null, null]);
    r.push(['g' + i, 1, 700, '10', '2', 0, 3, null, null]);
    r.push(['g' + i, 1, 800, '10', '3', 1, 2, '2', null]);
  }
  return { schema: 'edgedesk_nba_shots_v1', season: 2026, rows: r };
}
const NAMES = { 1: 'Absent Star', 2: 'Absorber', 3: 'Steady', 4: 'Small', 5: 'Newcomer', 6: 'Bench Out', 7: 'Two-way' };
const players = Object.fromEntries(Object.entries(NAMES).map(([id, name]) => [id, { name }]));
/* what nba/props/state.js run().upcoming gives for G1: the per-minute rates are the with-A rates */
function feat(minEw, rates, inLast) {
  const f = { min_ew: minEw, min_ss: minEw, start_rate: 1, starter: null, g_ss: 30, rest: 2, pf_rate: 0.05, usage_share: 0.2, miss_conf: 0, miss_proj: 0, in_last: inLast,
    home: 1, pace: 99, margin: 2, total: 225, b2b: 0, pos: 'G' };
  for (const k of STATS) { f['r_ew_' + k] = rates[k] || 0.01; f['r_ss_' + k] = rates[k] || 0.01; f['r_lg_' + k] = rates[k] || 0.01; f['opp_' + k] = 1; }
  return f;
}
const per = (min, o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v / min]));
function upcoming() {
  const u = (p, f) => ({ g: 'G1', p, tm: '10', opp: '20', season: 2027, start: Date.parse('2026-11-02T00:00:00Z'), f });
  return [
    u('1', feat(34, per(34, { pts: 25, reb: 7, ast: 6, fga: 20, fg3a: 6, fg3m: 2, tov: 3, stl: 1, blk: 0.5 }), 1)),
    u('2', feat(24, per(24, { pts: 12, reb: 6, ast: 2, fga: 10, fg3a: 5, fg3m: 2, tov: 1, stl: 1, blk: 0.3 }), 1)),
    u('3', feat(30, per(30, { pts: 14, reb: 5, ast: 3, fga: 11, fg3a: 4, fg3m: 1, tov: 2, stl: 1, blk: 0.3 }), 1)),
    u('4', feat(20, per(20, { pts: 8, reb: 3, ast: 1, fga: 8, fg3a: 2, fg3m: 1, tov: 1, stl: 0.5, blk: 0.2 }), 1)),
    u('5', feat(10, per(10, { pts: 4, reb: 2, ast: 1, fga: 4, fg3a: 1, fg3m: 0.3, tov: 0.3, stl: 0.3, blk: 0.1 }), 1)),
    u('7', feat(12, per(12, { pts: 4, reb: 2, ast: 1, fga: 4, fg3a: 1, fg3m: 0.3, tov: 0.3, stl: 0.3, blk: 0.1 }), 0)),
    u('6', feat(20, per(20, { pts: 7, reb: 3, ast: 2, fga: 6, fg3a: 2, fg3m: 1, tov: 1, stl: 0.5, blk: 0.2 }), 0)),
  ];
}
function inputs() {
  return { schema: 'edgedesk_nba_roster_inputs_v1', generated_at: '2026-11-01T18:00:00Z', season: 2027,
    games: [{ game_id: 'G1', start_utc: '2026-11-02T00:00:00Z', home: { id: '10', abbr: 'HOM', name: 'Home Club' }, away: { id: '20', abbr: 'AWY', name: 'Away Club' },
      reference: { home: [{ id: '1', name: 'Absent Star', minutes: 34 }, { id: '3', name: 'Steady', minutes: 30 }, { id: '2', name: 'Absorber', minutes: 24 },
        { id: '4', name: 'Small', minutes: 20 }, { id: '6', name: 'Bench Out', minutes: 20 }, { id: '7', name: 'Two-way', minutes: 12 }, { id: '5', name: 'Newcomer', minutes: 10 }], away: [] } }] };
}
/* nba/role_shift.json as nba/props/role_shift.js builds it from all of the above */
function file(o) {
  const RS = require('../../../nba/props/role_shift.js');
  return RS.build(Object.assign({ model: model(), upcoming: upcoming(), inputs: inputs(), players, season: 2027, rows: rows(), games, stints: [stints()], shots: [shots()],
    props_generated_at: '2026-11-01T18:05:00Z', now: '2026-11-01T18:06:00Z' }, o || {}));
}
module.exports = { START, STATS, Q, model, games, rows, stints, shots, players, upcoming, inputs, file, feat };
