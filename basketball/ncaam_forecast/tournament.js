'use strict';
/* ===========================================================================
   Tournament inputs for the simulator (simulator/src/sports/ncaam/).

   reconstructBracket(games, season)  the NCAA bracket of a PAST season,
       exactly as played, from the observed games: each game is a slot; a
       team's previous tournament game (which it won) feeds the slot. Rounds
       are structural (quality.js ncaaRounds). A team whose earlier game is
       absent from the source (2017: two First Four games missing; 2021: one
       no-contest walkover) enters as a leaf at the round it actually played —
       nothing is invented for the missing game.

   officialBracket(file, games, asOfMs)  a bracket file for the season in progress
       (written by a person from the official Selection Sunday release:
       config/brackets/<season>.json, schema edgedesk_ncaam_bracket_v1).
       Completed games are fixed from the observed results known at asOfMs: a
       slot whose two teams are determined and who met in a FINAL NCAA
       tournament game gets that winner. Whether a run on the file may be
       published is decided by the bracket fact in
       simulator/src/sports/ncaam/config.ts (VERIFIED, by whom, when), never
       by the file itself.
   exampleBracket(games, season) / --example <season>  a past field in this
       format, results removed: the template for the Selection Sunday file.

   simInputs(artifact, bracket, strength)  pair tables (calibrated regulation
       mean and sd for every ordered pair, neutral site) and the per-team
       persistent strength variance, in the simulator's snapshot format.
   =========================================================================== */
const fs = require('fs');
const D = require('./dist');
const MD = require('./model');

const ROUNDS = ['FF', 'R64', 'R32', 'S16', 'E8', 'F4', 'NC'];

function reconstructBracket(games, season, o) {
  o = o || {};
  const t = games.filter((g) => g.season === season && g.event === 'ncaa_tournament' && g.status === 'FINAL' && g.ncaa_round)
    .sort((a, b) => a.start_ms - b.start_ms || (a.game_id < b.game_id ? -1 : 1));
  if (!t.length) return null;
  const slotOf = new Map(); const slots = []; const entrants = {};
  const lastWin = new Map(); // team -> slot id of its latest win
  const regionOf = new Map();
  for (const g of t) {
    const id = g.ncaa_round + '-' + g.game_id;
    const input = (team) => (lastWin.has(team) ? { winnerOf: lastWin.get(team) } : { team });
    const region = g.ncaa_region || null;
    for (const [team, seed] of [[g.home_id, g.home_seed], [g.away_id, g.away_seed]]) {
      if (!lastWin.has(team) && !entrants[team]) entrants[team] = { region, seed: seed == null ? null : Number(seed) };
      if (region && !regionOf.has(team)) regionOf.set(team, region);
    }
    const winner = g.hs > g.as ? g.home_id : g.away_id;
    const slot = { id, round: g.ncaa_round, region: g.ncaa_round === 'F4' || g.ncaa_round === 'NC' ? null : region, a: input(g.home_id), b: input(g.away_id), start_utc: g.start_utc, game_id: g.game_id };
    if (o.withResults) { slot.winner = winner; slot.result_kind = 'played'; }
    slots.push(slot); slotOf.set(id, slot);
    lastWin.set(winner, id);
    const loser = winner === g.home_id ? g.away_id : g.home_id; lastWin.delete(loser);
  }
  for (const [team, e] of Object.entries(entrants)) if (!e.region && regionOf.has(team)) e.region = regionOf.get(team);
  const rounds = ROUNDS.filter((r) => slots.some((s) => s.round === r));
  const counts = {}; for (const r of rounds) counts[r] = slots.filter((s) => s.round === r).length;
  return { competition: 'NCAA Tournament', season: String(season), rounds, slots, entrants, source: 'reconstructed from the observed games (basketball/ncaam_forecast/data/games_' + season + '.csv.gz)', provenance: 'Observed',
    first_tip_ms: t[0].start_ms, slot_counts: counts, incomplete: counts.FF != null && counts.FF < 4 && season >= 2011 ? 'First Four games missing from the source: ' + (4 - counts.FF) : (counts.R64 < 32 ? 'first-round games missing (walkover/no contest): ' + (32 - counts.R64) : null) };
}

/** a person-written official bracket (schema edgedesk_ncaam_bracket_v1), results
    fixed from observed games KNOWN AT asOfMs (a game counts once its assumed
    availability, tip + 4 h, is at or before asOfMs: the rule training uses),
    so a replay as of an earlier moment never sees a later result */
function officialBracket(file, games, asOfMs) {
  const b = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (b.schema !== 'edgedesk_ncaam_bracket_v1') throw new Error(file + ': schema must be edgedesk_ncaam_bracket_v1');
  if (!Number.isFinite(asOfMs)) throw new Error('officialBracket: an as-of time is required (results after it must not be fixed)');
  const season = Number(b.season);
  const finals = games.filter((g) => g.season === season && g.event === 'ncaa_tournament' && g.status === 'FINAL' && Date.parse(g.assumed_available_at) <= asOfMs);
  const byPair = new Map(finals.map((g) => [[g.home_id, g.away_id].sort().join('|'), g]));
  const winners = new Map(); const ordered = b.slots.slice().sort((x, y) => b.rounds.indexOf(x.round) - b.rounds.indexOf(y.round));
  const who = (x) => (x.team != null ? x.team : winners.get(x.winnerOf));
  const fixed = [];
  for (const s of ordered) {
    const a = who(s.a), c = who(s.b);
    if (s.winner) { winners.set(s.id, s.winner); continue; }
    if (a == null || c == null) continue;
    const g = byPair.get([a, c].sort().join('|'));
    if (g && g.start_ms >= Date.parse(b.announced_at || '1970-01-01')) {
      s.winner = g.hs > g.as ? g.home_id : g.away_id; s.result_kind = 'played'; s.game_id = g.game_id; winners.set(s.id, s.winner); fixed.push(s.id);
    }
  }
  return Object.assign({ provenance: 'Observed', fixed_from_results: fixed }, b);
}

/** pair tables and strength variance, from a model artifact */
function simInputs(art, bracket, strength, o) {
  o = o || {};
  const cal = art.calibration.D1_D1;
  if (!cal) throw new Error('the artifact has no D1-v-D1 calibration');
  const ids = Object.keys(bracket.entrants).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const names = o.names || {};
  const n = ids.length; const mu = new Array(n * n).fill(0); const sd = new Array(n * n).fill(0);
  const missing = ids.filter((id) => !art.teams[id]);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (i === j) continue;
    const raw = MD.rawFromArtifact(art, { home_id: ids[i], away_id: ids[j], neutral: 1, home_d1: true, away_d1: true });
    const r = D.regulation(raw, cal);
    mu[i * n + j] = r.mu; sd[i * n + j] = r.sd;
  }
  const V = ids.map(() => strength.variance);
  return {
    schema: 'edgedesk_ncaam_sim_inputs_v1', season: Number(bracket.season), competition: bracket.competition, rules_version: 'NCAAM-BRACKET-SLOTS-v1',
    bracket: { competition: bracket.competition, season: String(bracket.season), rounds: bracket.rounds, slots: bracket.slots.map((s) => Object.assign({}, s)), entrants: bracket.entrants, source: bracket.source, provenance: bracket.provenance },
    teams: ids.map((id) => ({ id, name: names[id] ? names[id].name : id, region: bracket.entrants[id].region, seed: bracket.entrants[id].seed, rating_games: art.teams[id] ? art.teams[id].games : 0 })),
    pairs: { mu, sd },
    strength: { variance: V, method: strength.method, source: strength.source, ci95: strength.ci95 || null },
    calibration: { kappa: cal.kappa, ot: { sd: cal.ot.sd } },
    model: { model_id: art.model_id, version: art.version, artifact_sha256: art.artifact_sha256, as_of: art.as_of, config_sha256: art.config_sha256 },
    config: { drift: { mode: 'off' }, availability: { mode: 'off', reason: 'no owned player-availability feed or return distribution for college basketball' }, venue: 'neutral' },
    unrated_entrants: missing,
  };
}

/** a past season's bracket in the official file format (results removed): the
    template an operator fills from the official bracket on Selection Sunday */
function exampleBracket(games, season) {
  const r = reconstructBracket(games, season, { withResults: false });
  const firstTip = new Date(r.first_tip_ms);
  const announced = new Date(Date.UTC(firstTip.getUTCFullYear(), firstTip.getUTCMonth(), firstTip.getUTCDate() - 2, 23, 0, 0));
  return { schema: 'edgedesk_ncaam_bracket_v1', season: r.season, competition: r.competition, announced_at: announced.toISOString(),
    source: 'EXAMPLE ONLY: the ' + season + ' field reconstructed from observed games. A real file is typed from the official bracket and its source named here.',
    rounds: r.rounds, entrants: r.entrants, slots: r.slots.map((x) => ({ id: x.id, round: x.round, region: x.region, a: x.a, b: x.b })) };
}

module.exports = { ROUNDS, reconstructBracket, officialBracket, simInputs, exampleBracket };

if (require.main === module) {
  const a = process.argv; const i = a.indexOf('--example');
  if (i < 0) { console.error('usage: node basketball/ncaam_forecast/tournament.js --example <season 2011-2026> [--out file]'); process.exit(2); }
  const season = Number(a[i + 1]);
  const DS = require('./dataset');
  const doc = exampleBracket(DS.load([season]), season);
  const text = JSON.stringify(doc, null, 1) + '\n'; const o = a.indexOf('--out');
  if (o >= 0) { fs.writeFileSync(a[o + 1], text); console.error('wrote ' + a[o + 1] + ' (' + doc.slots.length + ' slots, ' + Object.keys(doc.entrants).length + ' entrants)'); } else process.stdout.write(text);
}
