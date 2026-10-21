#!/usr/bin/env node
/* Cold replay of the SHIPPED NFL engine (football/engine.js + football/params.js)
   as the live board (app.html fbLoadNfl) runs it, but from a cold state at 2006.

   usage: node replay_shipped.js <data_dir/nfl> <out.csv> [--deffix] [--raw-codes] [--no-neutral]

     --deffix     mirror each side's offensive fields into the opponent's def_* fields
                  before absorbing (as build_features.py does in training)
     --raw-codes  do NOT map games.csv historical codes (STL/SD/OAK) to the
                  stats_team_week franchise codes (LA/LAC/LV): reproduces
                  tools/football/validate_pricing.js, which then finds no team-week
                  rows for those clubs' games and never absorbs them
     --no-neutral do not pass neutral=true for location==='Neutral' (validate_pricing.js
                  passes no neutral flag)
*/
'use strict';
const fs = require('fs');
const path = require('path');
const REPO = '/home/user/EdgeDeskSports';
global.EDFootballParams = require(path.join(REPO, 'football', 'params.js'));
const E = require(path.join(REPO, 'football', 'engine.js'));

const DATA = process.argv[2];
const OUT = process.argv[3];
const DEFFIX = process.argv.includes('--deffix');
const RAW = process.argv.includes('--raw-codes');
const NO_NEUTRAL = process.argv.includes('--no-neutral');
const FIRST = 2006;

/* app.html fbCsv / fbNum, verbatim logic */
function fbCsv(text) {
  var rows = [], row = [], cur = '', q = false, i, c;
  for (i = 0; i < text.length; i++) {
    c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); cur = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = []; }
    else if (c !== '\r') cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  if (!rows.length) return [];
  var hd = rows[0], out = [], j, r, o, k2;
  for (j = 1; j < rows.length; j++) {
    r = rows[j]; o = {};
    for (k2 = 0; k2 < hd.length; k2++) o[hd[k2]] = (r[k2] === '' || r[k2] === 'NA') ? null : r[k2];
    out.push(o);
  }
  return out;
}
function fbNum(x) { if (x == null || x === '') return null; var v = +x; return isFinite(v) ? v : null; }

/* stats_team_week uses the current franchise code for every season; games.csv
   uses the code of the day. Same map as build_features.py FRANCHISE. */
const FRANCHISE = { STL: 'LA', SD: 'LAC', OAK: 'LV' };
const fr = (t) => (RAW ? t : (FRANCHISE[t] || t));

/* app.html fbNflGameReq, with neutral = location==='Neutral' only */
function gameReq(g) {
  return { home: fr(g.home_team), away: fr(g.away_team), week: fbNum(g.week),
    home_rest: fbNum(g.home_rest), away_rest: fbNum(g.away_rest), roof: g.roof, surface: g.surface,
    div_game: fbNum(g.div_game), temp: fbNum(g.temp), wind: fbNum(g.wind),
    home_qb_id: g.home_qb_id || null, away_qb_id: g.away_qb_id || null,
    neutral: NO_NEUTRAL ? false : String(g.location || '') === 'Neutral' };
}

const games = fbCsv(fs.readFileSync(path.join(DATA, 'games.csv'), 'utf8'))
  .filter((g) => { const s = fbNum(g.season); return s >= FIRST && g.home_score != null && g.away_score != null; });
const lastSeason = Math.max.apply(null, games.map((g) => fbNum(g.season)));
const byGame = {};
for (let s = FIRST; s <= lastSeason; s++) {
  const p = path.join(DATA, 'stw_' + s + '.csv');
  if (!fs.existsSync(p)) { console.error('missing ' + p); process.exit(3); }
  fbCsv(fs.readFileSync(p, 'utf8')).forEach((x) => { (byGame[x.game_id] = byGame[x.game_id] || []).push(x); });
}

/* COLD state: shipped seeds discarded (they contain the seasons replayed); league means and hyperparams kept */
const st = E.nfl.newState();
st.team = {}; st.ngames = {}; st.teamQb = {}; st.qb = {}; st.seededThrough = FIRST - 1;

games.sort((a, b) => String(a.gameday).localeCompare(String(b.gameday)) || String(a.game_id).localeCompare(String(b.game_id)));

const MIRROR = { off_epa_play: 'def_epa_play', pass_epa_db: 'def_pass_epa_db', rush_epa_att: 'def_rush_epa_att',
  expl_pass: 'def_expl_pass', expl_rush: 'def_expl_rush', sack_rate_all: 'sack_rate_made' };

const out = [];
let season = null, absorbed = 0, noRows = 0;
games.forEach((g) => {
  const s = fbNum(g.season);
  if (season != null && s !== season) E.nfl.seasonBreak(st);
  season = s;
  const req = gameReq(g);
  const known = Math.min(st.ngames[req.home] || 0, st.ngames[req.away] || 0);
  const pr = E.nfl.predict(st, req);          /* same numbers predictGame publishes as fair_spread / fair_total */
  const pg = E.predictGame({ sport: 'nfl', state: st, season: s, game: req, market: {} });
  const m = pr.model_spread;
  out.push({ game_id: g.game_id, season: s, week: fbNum(g.week), game_type: g.game_type,
    margin: m, win_prob: E.dist.winProb('nfl', m), total: pr.sharp_total, koerner: pr.koerner_spread, ctx: pr.ctx_adj,
    known: known, status: pg.status,
    pg_match: pg.status === 'PREDICTED' ? (Math.abs(pg.model.fair_spread - m) < 1e-12 && Math.abs(pg.model.fair_total - pr.sharp_total) < 1e-12) : null });
  /* absorb, exactly as fbLoadNfl */
  const pair = byGame[g.game_id];
  if (!pair || pair.length !== 2) { noRows++; return; }
  let hRow = null, aRow = null;
  pair.forEach((x) => { if (x.team === req.home) hRow = x; if (x.team === req.away) aRow = x; });
  if (!hRow || !aRow) { noRows++; return; }
  const hr = E.nfl.teamGameFromStw(hRow), ar = E.nfl.teamGameFromStw(aRow);
  hr.pts_for = fbNum(g.home_score); hr.pts_against = fbNum(g.away_score);
  ar.pts_for = fbNum(g.away_score); ar.pts_against = fbNum(g.home_score);
  if (DEFFIX) {
    Object.keys(MIRROR).forEach((f) => { hr[MIRROR[f]] = ar[f]; ar[MIRROR[f]] = hr[f]; });
  }
  E.nfl.absorbGame(st, [[req.home, hr], [req.away, ar]], []);
  absorbed++;
});

const cols = ['game_id', 'season', 'week', 'game_type', 'margin', 'win_prob', 'total', 'koerner', 'ctx', 'known', 'status', 'pg_match'];
const csv = [cols.join(',')].concat(out.map((r) => cols.map((c) => (r[c] == null || (typeof r[c] === 'number' && !isFinite(r[c])) ? '' : r[c])).join(','))).join('\n') + '\n';
fs.writeFileSync(OUT, csv);
console.error(JSON.stringify({ out: OUT, deffix: DEFFIX, raw_codes: RAW, no_neutral: NO_NEUTRAL, games: out.length, absorbed, no_team_week_rows: noRows,
  seasons: FIRST + '-' + lastSeason, blocked: out.filter((r) => r.status !== 'PREDICTED').length,
  predictGame_mismatch: out.filter((r) => r.pg_match === false).length }));
