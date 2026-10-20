#!/usr/bin/env node
/* ===========================================================================
   THE KC @ SEA AUDIT REPLAY (audit_report.md §3) — reproducible.

   Rebuilds the NFL rating state the way the live board did at commit 72af3904
   (2025 seeds -> one season break -> every completed 2026 game in gameday,
   game_id order, offence-only team rows, no quarterback starts) and predicts
   2026_07_KC_SEA with the slate's inputs. Then re-runs it with one thing
   changed at a time:

     live             the pre-fix live path (defence never updated)
     prior_only       no 2026 game absorbed: the 2025 prior alone
     no_prior         every team seed and the QB layer zeroed, then 2026
     parity           defence filled from the opponent's offence row, exactly
                      as football/research/build_features.py does in training
     parity_no_prior  both of the above: what the 2026 evidence alone says

   Prints every spread and context term of each run. Reads games.csv from the
   NFL feed cache (tools/football/fetch_nfl_feeds.js) and the committed
   football/nfl/stats_team_week_2026.csv. Writes nothing.

   Run: node tools/football/audit_kc_sea.js [--json]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
require(path.join(ROOT, 'football', 'params.js'));
const E = require(path.join(ROOT, 'football', 'engine.js'));
const FEEDS = require('./fetch_nfl_feeds.js');

const GAMES_URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const SEASON = 2026;
const GAME_ID = '2026_07_KC_SEA';
const DEF_OF = { off_epa_play: 'def_epa_play', pass_epa_db: 'def_pass_epa_db', rush_epa_att: 'def_rush_epa_att',
  expl_pass: 'def_expl_pass', expl_rush: 'def_expl_rush', sack_rate_all: 'sack_rate_made' };

function parseCsv(t) {
  const lines = t.split(/\r?\n/).filter(Boolean);
  const h = lines[0].split(',');
  return lines.slice(1).map((l) => { const c = l.split(','); const o = {}; h.forEach((k, i) => { o[k] = c[i] === '' || c[i] === 'NA' ? null : c[i]; }); return o; });
}
const num = (x) => (x == null || x === '' ? null : (Number.isFinite(+x) ? +x : null));

async function gamesCsv() {
  const p = FEEDS.key(GAMES_URL);
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  const r = await fetch(GAMES_URL, { redirect: 'follow' });
  if (!r.ok) throw new Error('games.csv HTTP ' + r.status);
  const t = await r.text();
  fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t);
  return t;
}

function build(games, byGame, opts) {
  const st = E.nfl.newState();
  for (let y = st.seededThrough; y < SEASON; y++) E.nfl.seasonBreak(st);
  if (opts.noPrior) {
    for (const t in st.team) for (const f of E.nfl.RATE_FEATS) st.team[t][f] = 0;
    for (const t in st.teamQb) st.teamQb[t] = 0;
    st.qb = {};
  }
  if (opts.priorOnly) return st;
  const done = games.filter((r) => num(r.season) === SEASON && r.home_score != null && r.away_score != null)
    .sort((a, b) => String(a.gameday).localeCompare(String(b.gameday)) || String(a.game_id).localeCompare(String(b.game_id)));
  for (const g of done) {
    const pair = byGame[g.game_id];
    if (!pair || pair.length !== 2) continue;
    const hRow = pair.find((x) => x.team === g.home_team), aRow = pair.find((x) => x.team === g.away_team);
    if (!hRow || !aRow) continue;
    const hr = E.nfl.teamGameFromStw(hRow), ar = E.nfl.teamGameFromStw(aRow);
    if (opts.parity) { const h0 = Object.assign({}, hr), a0 = Object.assign({}, ar); for (const k in DEF_OF) { hr[DEF_OF[k]] = a0[k]; ar[DEF_OF[k]] = h0[k]; } }
    hr.pts_for = num(g.home_score); hr.pts_against = num(g.away_score);
    ar.pts_for = num(g.away_score); ar.pts_against = num(g.home_score);
    E.nfl.absorbGame(st, [[g.home_team, hr], [g.away_team, ar]], []);
  }
  return st;
}

async function main() {
  const games = parseCsv(await gamesCsv());
  const byGame = {};
  parseCsv(fs.readFileSync(path.join(ROOT, 'football', 'nfl', 'stats_team_week_2026.csv'), 'utf8'))
    .forEach((x) => { (byGame[x.game_id] = byGame[x.game_id] || []).push(x); });
  const g = games.find((r) => r.game_id === GAME_ID);
  if (!g) throw new Error(GAME_ID + ' not in games.csv');
  const game = { home: 'SEA', away: 'KC', week: 7, home_rest: num(g.home_rest), away_rest: num(g.away_rest), roof: g.roof, surface: g.surface,
    div_game: num(g.div_game), temp: num(g.temp), wind: num(g.wind), neutral: false,
    home_qb_id: '00-0034869' /* Darnold: the slate's reconciled starter */, away_qb_id: '00-0033873' /* Mahomes */ };
  const runs = { live: {}, prior_only: { priorOnly: true }, no_prior: { noPrior: true }, parity: { parity: true }, parity_no_prior: { parity: true, noPrior: true } };
  const out = {};
  for (const name of Object.keys(runs)) {
    const st = build(games, byGame, runs[name]);
    const p = E.predictGame({ sport: 'nfl', state: st, season: SEASON, game, market: { spread_line: num(g.spread_line), total_line: num(g.total_line) } });
    const pick = (t) => Object.fromEntries(['off_epa_play', 'pass_epa_db', 'rush_epa_att', 'def_epa_play', 'def_pass_epa_db', 'def_rush_epa_att', 'pts_for', 'pts_against'].map((f) => [f, +st.team[t][f].toFixed(4)]));
    out[name] = { fair_margin: +p.model.fair_spread.toFixed(3), strength: +p.components.koerner_spread.toFixed(3), context: +p.components.stuckey_ctx_adj.toFixed(3),
      spread_terms: p.contributions.spread.map((c) => ({ key: c.key, value: c.value, points: +c.points.toFixed(3) })),
      ctx_terms: p.contributions.ctx.filter((c) => c.points !== 0).map((c) => ({ key: c.key, value: c.value, points: +c.points.toFixed(3) })),
      range: p.outcome_range && p.outcome_range.q, SEA: pick('SEA'), KC: pick('KC') };
  }
  if (process.argv.includes('--json')) { console.log(JSON.stringify(out, null, 1)); return; }
  for (const [name, r] of Object.entries(out)) {
    console.log(`\n== ${name}: SEA by ${r.fair_margin} (strength ${r.strength} + context ${r.context}) · range ${JSON.stringify(r.range)}`);
    r.spread_terms.forEach((t) => console.log(`   ${t.key.padEnd(12)} ${String(t.value == null ? '' : (+t.value).toFixed(4)).padStart(9)}  ${t.points >= 0 ? '+' : ''}${t.points.toFixed(3)}`));
    r.ctx_terms.forEach((t) => console.log(`   ctx:${t.key.padEnd(8)} ${String(t.value == null ? '' : (+t.value).toFixed(4)).padStart(9)}  ${t.points >= 0 ? '+' : ''}${t.points.toFixed(3)}`));
  }
}
main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
