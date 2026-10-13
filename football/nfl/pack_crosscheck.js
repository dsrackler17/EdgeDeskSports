#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NFL — the NFL data pack against my NFL brain's own sources.

     node football/nfl/pack_crosscheck.js            writes the report and the player crosswalk
     node football/nfl/pack_crosscheck.js --check    the committed report still holds

   My NFL brain reads nflverse games.csv (scores, closing consensus lines, the
   listed starting QBs) and nflverse team-week stats (the live input,
   football/nfl/stats_team_week_2026.csv). The NFL data pack
   (datapack/nfl_v1, verified by tools/datapack/verify_nfl.js) carries the
   play-by-play those come from, its derived tables and the roster ids. This
   reconciles them:

     labels      every pack game 2022-2026 against games.csv: final score,
                 spread_line and total_line (archived consensus closes: research
                 labels, never a market test), season type
     starters    the pack's primary passer per team-game (most pass attempts)
                 against games.csv's listed starting QB, by GSIS id
     live input  the pack's 2026 play-by-play team totals against my committed
                 team-week table: games covered, dropbacks, EPA. The two
                 define plays differently (stated per field); agreement is
                 measured, not forced
     identity    a GSIS ↔ PFR ↔ ESPN player crosswalk from the pack's season and
                 weekly rosters, 2024-2026. An id with two partners (a source
                 conflict) is listed and left out, never guessed

   Reads the cached games.csv (.cache/lab_src, the lab fetch client's cache);
   without it the label and starter sections are kept from the committed
   report and say so.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv } = require('../../engine/csv');
const PQ = require('../../tools/datapack/parquet');

const ROOT = path.join(__dirname, '..', '..');
const PACK = path.join(ROOT, 'datapack', 'nfl_v1', 'data');
const GAMES = path.join(ROOT, '.cache', 'lab_src', 'nflverse_nfldata_master_data_games.csv');
const LIVE = path.join(__dirname, 'stats_team_week_2026.csv');
const OUT = path.join(ROOT, 'football', 'validation', 'nfl_pack_crosscheck.json');
const XWALK = path.join(__dirname, 'crosswalk', 'players_2024_2026.csv');

const r4 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 10000) / 10000);
const inc = (o, k, n) => { o[k] = (o[k] || 0) + (n == null ? 1 : n); return o; };
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
function pearson(a, b) { const ma = mean(a), mb = mean(b); let n = 0, da = 0, db = 0; for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return n / Math.sqrt(da * db); }

function labelsAndStarters(prev) {
  if (!fs.existsSync(GAMES)) return { labels: Object.assign({}, prev && prev.labels, { recomputed_at_run: false }), starters: Object.assign({}, prev && prev.starters, { recomputed_at_run: false }) };
  const g = new Map(readCsv(GAMES).rows.map((x) => [x.game_id, x]));
  const labels = readCsv(path.join(PACK, 'game_labels_2022_2026.csv')).rows;
  const L = { recomputed_at_run: true, pack_games: labels.length, matched: 0, final_agree: 0, spread_line_agree: 0, total_line_agree: 0, type_agree: 0, by_season: {}, disagreements: [] };
  for (const x of labels) {
    const m = g.get(x.game_id); if (!m) { if (L.disagreements.length < 10) L.disagreements.push({ id: x.game_id, reason: 'not in games.csv' }); continue; }
    L.matched++; inc(L.by_season, x.season);
    const fin = +x.home_score === +m.home_score && +x.away_score === +m.away_score; if (fin) L.final_agree++;
    if (+x.spread_line === +m.spread_line) L.spread_line_agree++;
    if (+x.total_line === +m.total_line) L.total_line_agree++;
    if ((x.season_type === 'REG') === (m.game_type === 'REG')) L.type_agree++;
    if (!fin && L.disagreements.length < 10) L.disagreements.push({ id: x.game_id, pack: x.home_score + '-' + x.away_score, games_csv: m.home_score + '-' + m.away_score });
  }
  L.reading = 'Both are nflverse. spread_line / total_line are archived consensus closing lines without a capture time: research labels, never a market test or a "pregame known" price.';
  /* the primary passer per team-game against the listed starter */
  const opp = readCsv(path.join(PACK, 'player_game_opportunities_2022_2026.csv')).rows.filter((r) => r.stat === 'pass_attempts');
  const best = new Map();
  for (const r of opp) { const k = r.game_id + '|' + r.team_id; const v = +r.value; const b = best.get(k); if (!b || v > b.v || (v === b.v && r.player_id < b.id)) best.set(k, { id: r.player_id, v }); }
  const S = { recomputed_at_run: true, team_games: 0, listed_starter_known: 0, primary_passer_is_listed_starter: 0, by_season: {}, disagreements: [] };
  for (const [k, b] of best) {
    const [gid, team] = k.split('|'); const m = g.get(gid); if (!m) continue;
    const listed = team === m.home_team ? m.home_qb_id : team === m.away_team ? m.away_qb_id : null;
    S.team_games++; if (!listed) continue; S.listed_starter_known++;
    const s = S.by_season[gid.slice(0, 4)] || (S.by_season[gid.slice(0, 4)] = { compared: 0, agree: 0 }); s.compared++;
    if (b.id === listed) { S.primary_passer_is_listed_starter++; s.agree++; }
    else if (S.disagreements.length < 12) S.disagreements.push({ game: gid, team, primary_passer: b.id + ' (' + b.v + ' att)', listed_starter: listed + ' ' + (team === m.home_team ? m.home_qb_name : m.away_qb_name) });
  }
  S.share = r4(S.primary_passer_is_listed_starter / (S.listed_starter_known || 1));
  S.reading = 'A disagreement is usually an injured or benched starter (the backup threw more) or a two-QB game: the listed starter is who started; the primary passer is who threw most. Neither carries a pregame announcement time.';
  return { labels: L, starters: S };
}

function liveInput() {
  const tga = readCsv(path.join(PACK, 'team_game_advanced_2022_2026.csv')).rows.filter((r) => r.season === '2026');
  const live = readCsv(LIVE).rows.filter((r) => r.season_type === 'REG' || r.season_type === 'POST');
  const liveIdx = new Map(live.map((r) => [r.game_id + '|' + r.team, r]));
  const packIdx = new Map(tga.map((r) => [r.game_id + '|' + r.team_id, r]));
  const out = { pack_team_games: tga.length, live_team_games: live.length, in_both: 0, pack_only: [], live_only: [], dropbacks_exact: 0, pass_epa: { r: null, mean_abs_diff: null }, rush_epa: { r: null }, definitions: {} };
  const pe = [], le = [], pr = [], lr = []; let absd = 0;
  for (const [k, p] of packIdx) {
    const l = liveIdx.get(k); if (!l) { out.pack_only.push(k); continue; }
    out.in_both++;
    /* a dropback here = a pass attempt or a sack (scrambles are rushes in both) */
    if (+p.pass_attempts === +l.attempts + +l.sacks_suffered) out.dropbacks_exact++;
    pe.push(+p.pass_epa_sum); le.push(+l.passing_epa); pr.push(+p.rush_epa_sum); lr.push(+l.rushing_epa);
    absd += Math.abs(+p.pass_epa_sum - +l.passing_epa);
  }
  for (const k of liveIdx.keys()) if (!packIdx.has(k)) out.live_only.push(k);
  out.pass_epa = { r: r4(pearson(pe, le)), mean_abs_diff: r4(absd / (pe.length || 1)) };
  out.rush_epa = { r: r4(pearson(pr, lr)) };
  out.definitions = {
    dropbacks: 'pack: pass_attempt or sack on a scrimmage pass/run play with EPA, kneels and spikes out; live: attempts + sacks_suffered',
    pass_epa: 'pack: EPA of those dropbacks; live: nflverse passing_epa (the passer\'s EPA, which treats fumbles after the catch differently)',
    rush_epa: 'pack: designed rushes only (scrambles out); live: rushing_epa includes QB scrambles',
  };
  out.reading = out.pack_only.length ? 'my committed team-week table lacks ' + out.pack_only.length / 2 + ' game(s) the pack has (built before it finished): ' + [...new Set(out.pack_only.map((k) => k.split('|')[0]))].join(', ') : 'every 2026 team-game in the pack is in my live table';
  return out;
}

function identity() {
  const rows = [];
  for (const y of [2024, 2025, 2026]) for (const k of ['roster_', 'roster_weekly_']) for (const r of PQ.rows(path.join(PACK, k + y + '.parquet'), ['season', 'team', 'gsis_id', 'pfr_id', 'espn_id', 'full_name', 'position'])) rows.push(r);
  const by = new Map(); const pfr = new Map(), espn = new Map();
  const add = (m, a, b) => { if (!a || !b) return; if (!m.has(a)) m.set(a, new Set()); m.get(a).add(b); };
  for (const r of rows) {
    if (!r.gsis_id) continue;
    const o = by.get(r.gsis_id) || { gsis_id: r.gsis_id, pfr: new Set(), espn: new Set(), name: r.full_name, position: r.position, seasons: new Set(), teams: new Set() };
    if (r.pfr_id) o.pfr.add(r.pfr_id); if (r.espn_id) o.espn.add(r.espn_id); o.seasons.add(r.season); o.teams.add(r.team);
    by.set(r.gsis_id, o); add(pfr, r.pfr_id, r.gsis_id); add(espn, r.espn_id, r.gsis_id);
  }
  const conflicts = [];
  const out = [...by.values()].sort((a, b) => (a.gsis_id < b.gsis_id ? -1 : 1)).map((o) => {
    let p = o.pfr.size === 1 ? [...o.pfr][0] : '', e = o.espn.size === 1 ? [...o.espn][0] : '';
    const notes = [];
    if (o.pfr.size > 1) { notes.push('pfr ids ' + [...o.pfr].sort().join('/')); conflicts.push({ gsis_id: o.gsis_id, name: o.name, kind: 'one GSIS id, several PFR ids', ids: [...o.pfr].sort() }); }
    if (o.espn.size > 1) { notes.push('espn ids ' + [...o.espn].sort().join('/')); conflicts.push({ gsis_id: o.gsis_id, name: o.name, kind: 'one GSIS id, several ESPN ids', ids: [...o.espn].sort() }); }
    if (p && pfr.get(p).size > 1) { notes.push('pfr id ' + p + ' shared'); p = ''; }
    if (e && espn.get(e).size > 1) { notes.push('espn id ' + e + ' shared by ' + [...espn.get(e)].sort().join('/')); conflicts.push({ gsis_id: o.gsis_id, name: o.name, kind: 'ESPN id shared with another GSIS id', ids: [e] }); e = ''; }
    return { gsis_id: o.gsis_id, pfr_id: p, espn_id: e, full_name: o.name, position: o.position, seasons: [...o.seasons].sort().join(' '), teams: [...o.teams].sort().join(' '), status: notes.length ? 'CONFLICT: ' + notes.join('; ') : 'OK' };
  });
  return { rows: out, summary: { players: out.length, with_pfr: out.filter((r) => r.pfr_id).length, with_espn: out.filter((r) => r.espn_id).length, conflicts: out.filter((r) => r.status !== 'OK').length, conflict_examples: conflicts.slice(0, 12), file: path.relative(ROOT, XWALK), rule: 'ids from the pack\'s season and weekly rosters; a conflicting id is blank in the crosswalk and named in status' } };
}

function write() {
  let prev = null; try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (_) {}
  const ls = labelsAndStarters(prev); const id = identity();
  const report = { schema: 'edgedesk_nfl_pack_crosscheck_v1', pack: 'datapack/nfl_v1', labels: ls.labels, starters: ls.starters, live_input_2026: liveInput(), identity: id.summary,
    reading: ['Labels and starters are nflverse against nflverse: agreement proves the joins, not independence.', 'The live-input check is the pack\'s play-by-play against my committed team-week table, field by field, with the definitions stated.', 'This is a consistency check of retrospective data, not a point-in-time certification.'] };
  fs.mkdirSync(path.dirname(XWALK), { recursive: true });
  fs.writeFileSync(XWALK, toCsv(['gsis_id', 'pfr_id', 'espn_id', 'full_name', 'position', 'seasons', 'teams', 'status'], id.rows));
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1) + '\n');
  const L = report.labels, S = report.starters, V = report.live_input_2026;
  console.log('[nfl pack crosscheck] labels ' + L.matched + '/' + L.pack_games + ' matched; finals ' + L.final_agree + ', spread ' + L.spread_line_agree + ', total ' + L.total_line_agree + ' agree');
  console.log('  starters: primary passer = listed starter ' + S.primary_passer_is_listed_starter + '/' + S.listed_starter_known + ' (' + S.share + ')');
  console.log('  live 2026: ' + V.in_both + ' team-games in both (pack ' + V.pack_team_games + ', live ' + V.live_team_games + '); dropbacks exact ' + V.dropbacks_exact + '; pass EPA r ' + V.pass_epa.r + ', rush EPA r ' + V.rush_epa.r + ' — ' + V.reading);
  console.log('  identity: ' + report.identity.players + ' players, ' + report.identity.with_pfr + ' with PFR, ' + report.identity.with_espn + ' with ESPN, ' + report.identity.conflicts + ' conflicts left out');
}

function check() {
  const r = JSON.parse(fs.readFileSync(OUT, 'utf8')); const fails = [];
  if (r.labels.matched !== r.labels.pack_games || r.labels.final_agree !== r.labels.matched) fails.push('a pack game is missing from games.csv or a final disagrees');
  if (!(r.starters.share >= 0.9)) fails.push('primary passer and listed starter agree in under 90%');
  if (!(r.live_input_2026.pass_epa.r >= 0.95)) fails.push('pack and live pass EPA no longer track each other');
  if (!fs.existsSync(XWALK)) fails.push('no crosswalk');
  if (fails.length) { console.error('[nfl pack crosscheck --check] FAILED: ' + fails.join('; ')); process.exit(1); }
  console.log('[nfl pack crosscheck --check] ok: ' + r.labels.matched + ' games, every final agrees; starters ' + r.starters.share + '; live pass EPA r ' + r.live_input_2026.pass_epa.r);
}

module.exports = { liveInput, identity };
if (require.main === module) { if (process.argv.includes('--check')) check(); else write(); }
