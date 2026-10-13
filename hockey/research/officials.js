#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NHL research — do the referees move the game? (2024-25)

     node hockey/research/officials.js            writes hockey/validation/nhl_officials_research.json
     node hockey/research/officials.js --check    the committed result is reproducible

   The NHL data pack lists each game's officials (ESPN). They are keyed to NHL
   game ids by hockey/crosscheck/espn.js (hockey/data/officials/2025.csv). This
   asks one question: is there a REPEATABLE referee effect on what a price
   would care about — minor penalties called, power-play time, regulation
   goals? Regular season only (playoff listings name three referees and do
   not say which two worked).

   Method, chosen before looking at any result:
     - per game, the outcome minus the season mean (both teams together);
     - each referee's games in date order, split alternately into two halves;
       the referee's mean residual in each half; the correlation of the two
       halves across referees (split-half reliability), Spearman-Brown
       corrected;
     - a permutation null: the referee pairs are shuffled across games 2,000
       times (seeded) and the same statistics recomputed; p = the share of
       shuffles at least as extreme;
     - the referee spread beyond chance: sqrt(max(0, var(referee means) −
       mean var under the null)).
   Teams are not adjusted for: assignments are close to random with respect
   to teams, so team habits add noise, not bias, to this screen.

   WHAT IT IS NOT. A screen on one season, not a model input. ESPN records no
   assignment time and my history has no officials before 2024-25, so nothing
   here enters a price; a referee term could be considered only with
   timestamped assignments and several seasons.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('../config');
const { readCsv } = require('../../engine/csv');
const TG = require('../ingest/team_games');

const SEASON = 2025;
const OFF = path.join(C.HOCKEY, 'data', 'officials', SEASON + '.csv');
const OUT = path.join(C.PATHS.validation, 'nhl_officials_research.json');
const PERMS = 2000;
const r4 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 10000) / 10000);

function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const variance = (a) => { const m = mean(a); return a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1); };
function pearson(a, b) { const ma = mean(a), mb = mean(b); let n = 0, da = 0, db = 0; for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return n / Math.sqrt(da * db); }

/** split-half reliability and spread for one outcome, given each game's referee pair */
function stats(games, refsOf, key) {
  const by = new Map();
  games.forEach((g, i) => { for (const r of refsOf[i]) { if (!by.has(r)) by.set(r, []); by.get(r).push(g[key]); } });
  const refs = [...by.keys()].filter((r) => by.get(r).length >= 20).sort();
  const h1 = [], h2 = [], all = [];
  for (const r of refs) { const v = by.get(r); h1.push(mean(v.filter((_, i) => i % 2 === 0))); h2.push(mean(v.filter((_, i) => i % 2 === 1))); all.push(mean(v)); }
  const rHalf = pearson(h1, h2);
  return { referees: refs.length, split_half_r: rHalf, spearman_brown: (2 * rHalf) / (1 + rHalf), var_means: variance(all) };
}

function run() {
  const off = readCsv(OFF).rows.filter((r) => r.referees && Number(r.referees_listed) === 2);
  const tg = TG.loadTeamGames([SEASON]).filter((r) => r.home && r.type === 'R');
  const byId = new Map(tg.map((r) => [String(r.game_id), r]));
  const opp = new Map(TG.loadTeamGames([SEASON]).filter((r) => !r.home).map((r) => [String(r.game_id), r]));
  const games = []; const refsOf = [];
  for (const o of off.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : Number(a.nhl_game_id) - Number(b.nhl_game_id)))) {
    const h = byId.get(String(o.nhl_game_id)), a = opp.get(String(o.nhl_game_id)); if (!h || !a) continue;
    games.push({ minors: h.pen_minors + a.pen_minors, pp_minutes: (h.toi_pp + a.toi_pp) / 60, regulation_goals: h.gf_reg + h.ga_reg });
    refsOf.push(o.referees.split('; '));
  }
  const out = { schema: 'edgedesk_nhl_officials_research_v1', season: SEASON, games: games.length, permutations: PERMS, seed: 20251013, outcomes: {} };
  for (const key of ['minors', 'pp_minutes', 'regulation_goals']) {
    const mu = mean(games.map((g) => g[key]));
    const obs = stats(games, refsOf, key);
    const rand = rng(20251013); const nullR = [], nullV = [];
    for (let p = 0; p < PERMS; p++) {
      const sh = refsOf.slice(); for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = sh[i]; sh[i] = sh[j]; sh[j] = t; }
      const s = stats(games, sh, key); nullR.push(s.split_half_r); nullV.push(s.var_means);
    }
    const pR = (nullR.filter((x) => x >= obs.split_half_r).length + 1) / (PERMS + 1);
    const excess = Math.sqrt(Math.max(0, obs.var_means - mean(nullV)));
    out.outcomes[key] = {
      season_mean_per_game: r4(mu), referees_with_20_games: obs.referees,
      split_half_r: r4(obs.split_half_r), spearman_brown: r4(obs.spearman_brown), permutation_p: r4(pR),
      null_split_half_r_mean: r4(mean(nullR)), referee_spread_beyond_chance_sd: r4(excess),
      reading: pR < 0.01 ? 'a repeatable referee effect: ±' + r4(excess) + ' per game (1 sd across referees) beyond chance' : 'no repeatable referee effect detected in one season',
    };
  }
  out.conclusion = 'Research only. Officials have no assignment timestamp in the pack and no history before 2024-25, so no referee term enters a price. ' +
    Object.entries(out.outcomes).map(([k, v]) => k + ': ' + v.reading).join('; ') + '.';
  return out;
}

if (require.main === module) {
  const r = run();
  if (process.argv.includes('--check')) {
    const c = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    if (JSON.stringify(c) !== JSON.stringify(r)) { console.error('[nhl officials --check] FAILED: the committed result differs from a fresh run'); process.exit(1); }
    console.log('[nhl officials --check] ok: ' + r.games + ' games'); process.exit(0);
  }
  fs.writeFileSync(OUT, JSON.stringify(r, null, 1) + '\n');
  for (const [k, v] of Object.entries(r.outcomes)) console.log('[nhl officials] ' + k + ': split-half r ' + v.split_half_r + ' (null ' + v.null_split_half_r_mean + '), p ' + v.permutation_p + ', spread beyond chance ' + v.referee_spread_beyond_chance_sd + ' / game (mean ' + v.season_mean_per_game + ')');
}
module.exports = { run };
