#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NHL PROPS — player projections for the games on hockey/slate.json.

     node hockey/props/slate.js            write hockey/props/slate.json

   For each upcoming game: each club's PROJECTED lineup (the skaters who
   dressed in its most recent game — no lineup or injury feed is wired), its
   projected starting goalie (the game slate's projection), and for each
   player the distribution of his shots on goal, goals, assists, points (and
   saves for the goalie) from hockey/props/model.js with the live parameters
   of the walk-forward record (hockey/validation/nhl_props.json).

   RESEARCH ONLY. A prop is void if the player does not play, so every
   probability assumes he dresses (and the goalie starts). No NHL prop price
   is captured, so nothing here is compared with a market or called value.
   Each market carries its held-out validation status.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('../config');
const D = require('./data');
const M = require('./model');

const OUT = path.join(__dirname, 'slate.json');
const SCHEMA = 'edgedesk_nhl_props_slate_v1';
const r4 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 1e4) / 1e4);
const r2 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);
function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return d; } }

function build() {
  const slate = readJson(C.PATHS.slate, null); const rec = readJson(path.join(C.PATHS.validation, 'nhl_props.json'), null);
  if (!slate || !rec) throw new Error('needs hockey/slate.json and hockey/validation/nhl_props.json');
  const lp = rec.live_params || {}; const cal = lp.mean_recalibration || {}; const sizes = lp.sizes || {};
  const rS = sizes.sog ? (sizes.sog.r == null ? Infinity : sizes.sog.r) : 20, rSA = sizes.shots_against ? (sizes.shots_against.r == null ? Infinity : sizes.shots_against.r) : 30;
  const st = new M.PropState();
  const last = new Map(); const names = {}; const loaded = [];
  for (let s = C.CURRENT_SEASON - 3; s <= C.CURRENT_SEASON; s++) {
    const d = D.loadSeason(s); if (!d) continue; loaded.push(s); Object.assign(names, d.names || {});
    const byDate = new Map();
    const at = (date) => byDate.get(date) || (byDate.set(date, { sk: [], gk: [], teams: {} }), byDate.get(date));
    for (const r of d.skaters) at(r.date).sk.push(r);
    for (const r of d.goalies) at(r.date).gk.push(r);
    const dateOf = new Map(d.skaters.map((r) => [r.game_id, r.date]));
    for (const [id, t] of Object.entries(d.teams)) { const dt = dateOf.get(Number(id)); if (dt) at(dt).teams[id] = t; }
    for (const date of [...byDate.keys()].sort()) {
      const b = byDate.get(date); st.absorb(b.sk, b.gk, b.teams);
      const byTeam = {}; for (const r of b.sk) (byTeam[r.team] || (byTeam[r.team] = [])).push(r);
      for (const [t, rows] of Object.entries(byTeam)) last.set(t, { date, game_id: rows[0].game_id, skaters: rows.map((r) => ({ player: r.player, pos: r.pos, toi: r.toi })) });
    }
  }
  if (!loaded.length) throw new Error('no box-score cache (hockey/ingest/boxscores.js)');
  const statusOf = (k) => (rec.markets[k] ? rec.markets[k].status : 'NOT_SCORED');
  const games = [];
  for (const g of slate.games) {
    const side = (team, opp, starters) => {
      const lu = last.get(team);
      const skaters = (lu ? lu.skaters : []).map((x) => {
        const p0 = st.skater(x.player, x.pos, opp, team); if (!p0) return null;
        const pr = Object.assign({}, p0, { mu_sog: M.applyMeanCal(p0.mu_sog, cal.sog), mu_goals: M.applyMeanCal(p0.mu_goals, cal.g), mu_assists: M.applyMeanCal(p0.mu_assists, cal.a) });
        const mk = M.skaterMarkets(pr, rS);
        return { player_id: x.player, name: names[x.player] || null, pos: x.pos, toi_proj: r2(pr.toi_s / 60), sog: { mean: r2(mk.sog.mean), over_1_5: r4(mk.sog.over[1.5]), over_2_5: r4(mk.sog.over[2.5]), over_3_5: r4(mk.sog.over[3.5]) }, goal: r4(mk.goals.anytime), assist: r4(mk.assists.over[0.5]), point: r4(mk.points.over[0.5]), points_2plus: r4(mk.points.over[1.5]), goal_and_3plus_shots: r4(mk.joint.goal_and_3plus_shots) };
      }).filter(Boolean).sort((a, b) => b.toi_proj - a.toi_proj);
      const goalies = (starters || []).slice(0, 2).map((x) => {
        if (x.goalie == null) return null;
        const p0 = st.goalie(x.goalie, team, opp); const pr = Object.assign({}, p0, { mu_sa: M.applyMeanCal(p0.mu_sa, cal.sa) });
        const mk = M.goalieMarkets(pr, rSA);
        return { goalie_id: x.goalie, name: x.name || names[x.goalie] || null, p_start: x.p_start, confirmed: !!x.confirmed, shots_against_mean: r2(mk.shots_against.mean), save_pct: r4(mk.save_pct), saves_mean: r2(mk.saves.mean), saves_over: { 22.5: r4(mk.saves.over[22.5]), 25.5: r4(mk.saves.over[25.5]), 28.5: r4(mk.saves.over[28.5]), 31.5: r4(mk.saves.over[31.5]) } };
      }).filter(Boolean);
      return { team, projected_lineup_from: lu ? { date: lu.date, game_id: lu.game_id } : null, skaters, goalies };
    };
    games.push({ game_id: g.game_id, start_utc: g.start_utc, home: side(g.home, g.away, g.goalies && g.goalies.home), away: side(g.away, g.home, g.goalies && g.goalies.away) });
  }
  return {
    schema: SCHEMA, generated_at: new Date().toISOString(), slate_generated_at: slate.generated_at, seasons_replayed: loaded,
    markets: Object.fromEntries(Object.keys(rec.markets).map((k) => [k, { status: statusOf(k), market_status: rec.markets[k].market_status, confirmation_n: rec.markets[k].confirmation ? rec.markets[k].confirmation.n : null }])),
    value_claims: rec.value_claims,
    assumptions: ['Each player is assumed to dress (each goalie to start): a prop on a player who does not play is void.', 'The projected lineup is the club\'s most recent dressed lineup; no injury, scratch or line-rush feed is wired.', 'Goals are modelled as a thinning of shots on goal, so a player\'s shot, goal and point probabilities are mutually consistent.'],
    model: { file: 'hockey/props/model.js', record: 'hockey/validation/nhl_props.json', sizes: { sog: isFinite(rS) ? rS : 'Poisson', shots_against: isFinite(rSA) ? rSA : 'Poisson' }, mean_recalibration: cal },
    games,
  };
}

function check() {
  const s = readJson(OUT, null); const fails = [];
  if (!s || s.schema !== SCHEMA) fails.push('schema');
  else {
    if (!s.value_claims || s.value_claims.state !== 'DISABLED') fails.push('prop value claims must stay disabled');
    for (const g of s.games) for (const side of ['home', 'away']) for (const p of g[side].skaters) {
      if (!(p.sog.over_1_5 >= p.sog.over_2_5 && p.sog.over_2_5 >= p.sog.over_3_5)) fails.push(p.player_id + ' shot lines not monotone');
      if (!(p.point >= p.goal - 1e-9 && p.point >= p.assist - 1e-9)) fails.push(p.player_id + ' a point is less likely than a goal or an assist');
      if (!(p.goal_and_3plus_shots <= p.goal + 1e-9)) fails.push(p.player_id + ' joint above its marginal');
    }
  }
  if (fails.length) { console.error('[nhl props slate --check] FAILED: ' + fails.slice(0, 8).join('; ')); process.exit(1); }
  console.log('[nhl props slate --check] ok: ' + s.games.length + ' games');
}

if (require.main === module) {
  if (process.argv.includes('--check')) check();
  else { const s = build(); fs.writeFileSync(OUT, JSON.stringify(s) + '\n'); console.log('[nhl props slate] ' + s.games.length + ' games; ' + s.games.reduce((a, g) => a + g.home.skaters.length + g.away.skaters.length, 0) + ' skaters projected; seasons ' + s.seasons_replayed.join(',')); }
}
module.exports = { build, SCHEMA };
