#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk — missingness by sport, source and season (the data pack's
   quality rule: "retain missing values and exposure counts").

     node engine/lab/missingness.js            writes engine/missingness.json

   Reads only committed tables and reports, per season, the rows and the
   share of each key field that is missing, with the reason where it is
   structural. Nothing here fills a gap: it says where the gaps are, so a
   reader can see what a model could and could not have used.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const { readCsv } = require('../csv');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'engine', 'missingness.json');
const r4 = (v) => Math.round(v * 10000) / 10000;

function scan(dir, fields, filter) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((x) => /^\d{4}\.csv$/.test(x)).sort()) {
    const rows = readCsv(path.join(dir, f)).rows.filter(filter || (() => true));
    const miss = {};
    for (const k of fields) miss[k] = rows.length ? r4(rows.filter((r) => r[k] === '' || r[k] == null).length / rows.length) : null;
    out[f.slice(0, 4)] = { rows: rows.length, missing: miss };
  }
  return out;
}
function hockey() {
  const dir = path.join(ROOT, 'hockey', 'data', 'team_games'); const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const s of fs.readdirSync(dir).filter((x) => /^\d{4}$/.test(x)).sort()) {
    let rows = [];
    for (const f of fs.readdirSync(path.join(dir, s)).filter((x) => /\.csv$/.test(x))) rows = rows.concat(readCsv(path.join(dir, s, f)).rows);
    const m = (k) => r4(rows.filter((r) => r[k] === '').length / (rows.length || 1));
    out[s] = { rows: rows.length, missing: { known_at: m('known_at'), start_utc: m('start_utc'), g_start: m('g_start'), ev5_xgf: m('ev5_xgf'), g1_xga: m('g1_xga') } };
  }
  return out;
}

function main() {
  const report = {
    schema: 'edgedesk_missingness_v1', generated_at: new Date().toISOString(),
    rule: 'a blank is missing, never zero; known_at is blank on every historical row by design (first publication was not recorded)',
    sports: {
      nhl: { table: 'hockey/data/team_games', by_season: hockey(), structural: { known_at: 'never recorded for history (RETRO rows)', 'lineups (warmup)': 'not available before the game: only the box score afterwards', 'confirmed goalie': 'no feed; historical starter known after the game' }, contracts: 'hockey/validation/nhl_contracts.json (per-field missingness of the canonical tables)' },
      nba: { table: 'basketball/data/nba', by_season: scan(path.join(ROOT, 'basketball', 'data', 'nba'), ['start_utc', 'ot', 'known_at'], (r) => r.status === 'FINAL'), structural: { ot: 'blank for rows added from the data pack (its games table has no period count)', availability: 'no injury or lineup feed' } },
      wnba: { table: 'basketball/data/wnba', by_season: scan(path.join(ROOT, 'basketball', 'data', 'wnba'), ['start_utc', 'ot', 'known_at'], (r) => r.status === 'FINAL'), structural: { availability: 'no injury or lineup feed' } },
      ncaam: { table: 'basketball/data/ncaam', by_season: scan(path.join(ROOT, 'basketball', 'data', 'ncaam'), ['start_utc', 'ot', 'known_at'], (r) => r.status === 'FINAL'), structural: { availability: 'no injury or lineup feed' } },
      ncaaw: { table: 'basketball/data/ncaaw', by_season: scan(path.join(ROOT, 'basketball', 'data', 'ncaaw'), ['start_utc', 'ot', 'src', 'known_at'], (r) => r.status === 'FINAL'), structural: { coverage: '2024-25: the source lacked 209 games; added from the data pack (src = P)', availability: 'no injury or lineup feed' } },
      soccer: Object.fromEntries(['epl', 'bundesliga', 'laliga', 'seriea', 'ligue1'].map((lg) => {
        const dir = path.join(ROOT, 'soccer', 'data', lg); const bs = {};
        if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).filter((x) => /^\d{4}\.csv$/.test(x)).sort()) {
          const rows = readCsv(path.join(dir, f)).rows; const played = rows.filter((r) => r.status !== 'SCHEDULED');
          bs[f.slice(0, 4)] = { rows: rows.length, result_missing: played.filter((r) => r.status === 'RESULT_MISSING').length, missing: { time_local: r4(rows.filter((r) => !r.time_local).length / (rows.length || 1)), ht_score: r4(played.filter((r) => r.status === 'FINAL' && r.ht_hg === '').length / (played.length || 1)) } };
        }
        return [lg, { table: 'soccer/data/' + lg, by_season: bs, structural: { result_missing: 'the source has not published these results (2019-20 Ligue 1: the season was abandoned)', time_zone: 'kick-off times are local with no zone', xg: 'no xG source', lineups: 'no lineup feed' } }];
      })),
      mlb: { table: 'mlb/history/data', by_season: scan(path.join(ROOT, 'mlb', 'history', 'data'), ['sp_home', 'sp_away', 'park', 'outs', 'dn']), structural: { '2024 starters, park, outs': 'Retrosheet 2024 not reachable; the data pack\'s StatsAPI table has no starters', bullpen: 'no bullpen usage archive', lineups: 'no lineup archive' } },
      nfl: { table: 'datapack/nfl_v1/data/team_game_advanced_2022_2026.csv', by_season: (() => { const f = path.join(ROOT, 'datapack', 'nfl_v1', 'data', 'team_game_advanced_2022_2026.csv'); const out = {}; if (!fs.existsSync(f)) return out; const rows = readCsv(f).rows; for (const y of [...new Set(rows.map((r) => r.season))].sort()) { const s = rows.filter((r) => r.season === y); out[y] = { rows: s.length, missing: { cpoe_sum: r4(s.filter((r) => r.cpoe_passes === '0' || r.cpoe_passes === '').length / s.length), def_plays: r4(s.filter((r) => r.def_plays === '').length / s.length), known_at: r4(s.filter((r) => r.known_at === '').length / s.length) } }; } return out; })(),
        structural: { known_at: 'never recorded for history; EPA and CPOE are model outputs that can be refit', injuries: 'weekly status rows with no publication time: they cannot be placed before a kickoff', depth_charts: 'provider snapshots (2025+) or weekly rows (2024), not announcements', routes_participation: 'not in any source here: targets and snaps cannot stand in for routes', current_season: '2026 is partial in the pack (through week 5)', identity: '7 roster id conflicts (two pairs of players sharing an ESPN id; players with two PFR or two ESPN ids): left out of the crosswalk, never guessed' } },
      ufc: { table: 'datapack/quant_v1/data/ufc/bouts_2024.csv', structural: { round_statistics: 'UFCStats refused automated access; not bypassed', multi_year: 'one year only' } },
    },
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1) + '\n');
  const m = report.sports.mlb.by_season; console.log('[missingness] mlb 2024 sp_home missing ' + (m['2024'] ? m['2024'].missing.sp_home : '—') + '; soccer epl 2026 results missing ' + (report.sports.soccer.epl.by_season['2026'] || {}).result_missing + '; written ' + path.relative(ROOT, OUT));
}

if (require.main === module) main();
module.exports = { scan };
