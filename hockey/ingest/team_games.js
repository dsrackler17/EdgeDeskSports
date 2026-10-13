#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NHL — the committed team-game table (schema edgedesk_nhl_team_games_v2).

     node hockey/ingest/team_games.js --season 2011-2027

   Two rows per completed game, one per team, written to
     hockey/data/team_games/<season>/<YYYY-MM>.csv
   (partitioned by month so a daily in-season rebuild rewrites one small file).
   Every row is scored by the xG model fitted on seasons BEFORE its own
   (hockey/xg/models/xg_for_<season>.json); the row names the model.

   PROVENANCE AND TIME (the data pack's temporal rule). `known_at` is when the
   source first published the row's facts. Nobody recorded that for history,
   so it is BLANK — never backdated. `assumed_available_at` is the explicit
   assumption the walk-forward uses instead: the scheduled start plus four
   hours (no NHL regular-season game has run past that), or the end of the
   game's day when the start is unknown. `pit` = RETRO marks every row as
   retrospective research data: retrieved years later from a source that can
   revise, so the walk-forward record is a retrospective test, not a
   certified point-in-time one. A model may use a row only for a game whose
   prediction time is after `assumed_available_at` AND whose date is later —
   hockey/model/walkforward.js enforces both and engine/validation.leakageAudit
   re-checks every scored prediction. `src` is the short hash of the
   play-by-play file the row came from (its retrieval time is in the manifest).

   Against-columns are not stored: a team's xGA is its opponent's xGF in the
   same game (the reader joins on game_id).
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('../config');
const { readSeason } = require('./season');
const { applyXg } = require('./game');
const X = require('../xg/model');

const COLS = [
  'game_id', 'season', 'type', 'date', 'start_utc', 'known_at', 'assumed_available_at', 'pit', 'team', 'opp', 'home', 'decided',
  'gf', 'ga', 'gf_reg', 'ga_reg', 'win', 'so',
  'toi_ev5', 'toi_evo', 'toi_pp', 'toi_sh', 'toi_enf', 'toi_ena', 'toi_ev5_lead', 'toi_ev5_tie', 'toi_ev5_trail',
  'ev5_gf', 'ev5_ff', 'ev5_cf', 'ev5_xgf', 'evo_gf', 'evo_ff', 'evo_xgf', 'pp_gf', 'pp_ff', 'pp_xgf', 'sh_gf', 'sh_ff', 'sh_xgf',
  'enf_gf', 'enf_ff', 'ena_gf', 'ena_ff', 'ena_xgf',
  'ev5_xgf_lead', 'ev5_xgf_tie', 'ev5_xgf_trail', 'ev5_ff_lead', 'ev5_ff_tie', 'ev5_ff_trail',
  'pen_minors', 'pen_majors', 'pim',
  'g_start', 'g1_id', 'g1_fa', 'g1_ga', 'g1_xga', 'g2_id', 'g2_fa', 'g2_ga', 'g2_xga',
  'xg_model', 'src',
];

function r3(v) { return v == null ? '' : Math.round(v * 1000) / 1000; }
/** the explicit availability assumption — never written into known_at */
function assumedAvailableAt(g) {
  const t = Date.parse(g.start_utc);
  if (isFinite(t)) return new Date(t + 4 * 3600e3).toISOString();
  return g.date + 'T23:59:00Z'; /* no start time: end of the local day, and the date rule still applies */
}

function rowsFor(rec, srcHash) {
  const g = rec.game; const out = [];
  for (const side of ['home', 'away']) {
    const t = rec.teams[side]; const o = rec.teams[side === 'home' ? 'away' : 'home'];
    const gf = side === 'home' ? g.final_home : g.final_away, ga = side === 'home' ? g.final_away : g.final_home;
    const gl = Object.entries(t.goalies).sort((a, b) => (a[1].first_s - b[1].first_s) || (b[1].fa - a[1].fa));
    const start = side === 'home' ? g.starter_home : g.starter_away;
    /* the starter first, whoever they are */
    gl.sort((a, b) => (Number(a[0]) === start ? -1 : 0) - (Number(b[0]) === start ? -1 : 0));
    const G = (i, k) => (gl[i] ? (k === 'id' ? gl[i][0] : k === 'xga' ? r3(gl[i][1].xga) : gl[i][1][k]) : '');
    out.push({
      game_id: g.game_id, season: g.season, type: g.season_type, date: g.date, start_utc: g.start_utc || '', known_at: '', assumed_available_at: assumedAvailableAt(g), pit: 'RETRO',
      team: side === 'home' ? g.home : g.away, opp: side === 'home' ? g.away : g.home, home: side === 'home' ? 1 : 0, decided: g.decided,
      gf, ga, gf_reg: side === 'home' ? g.reg_home : g.reg_away, ga_reg: side === 'home' ? g.reg_away : g.reg_home,
      win: gf > ga ? 1 : 0, so: g.decided === 'SO' ? 1 : 0,
      toi_ev5: t.toi.ev5, toi_evo: t.toi.evo, toi_pp: t.toi.pp, toi_sh: t.toi.sh, toi_enf: t.toi.enf, toi_ena: t.toi.ena,
      toi_ev5_lead: t.toi_ev5_score.lead, toi_ev5_tie: t.toi_ev5_score.tie, toi_ev5_trail: t.toi_ev5_score.trail,
      ev5_gf: t.ev5.gf, ev5_ff: t.ev5.ff, ev5_cf: t.ev5.cf, ev5_xgf: r3(t.ev5.xgf), evo_gf: t.evo.gf, evo_ff: t.evo.ff, evo_xgf: r3(t.evo.xgf),
      pp_gf: t.pp.gf, pp_ff: t.pp.ff, pp_xgf: r3(t.pp.xgf), sh_gf: t.sh.gf, sh_ff: t.sh.ff, sh_xgf: r3(t.sh.xgf),
      enf_gf: t.enf.gf, enf_ff: t.enf.ff, ena_gf: t.ena.gf, ena_ff: t.ena.ff, ena_xgf: r3(t.ena.xgf),
      ev5_xgf_lead: r3(t.ev5_score.lead.xgf), ev5_xgf_tie: r3(t.ev5_score.tie.xgf), ev5_xgf_trail: r3(t.ev5_score.trail.xgf),
      ev5_ff_lead: t.ev5_score.lead.ff, ev5_ff_tie: t.ev5_score.tie.ff, ev5_ff_trail: t.ev5_score.trail.ff,
      pen_minors: t.pen_minors, pen_majors: t.pen_majors, pim: t.pim,
      g_start: start == null ? '' : start,
      g1_id: G(0, 'id'), g1_fa: G(0, 'fa'), g1_ga: G(0, 'ga'), g1_xga: G(0, 'xga'),
      g2_id: G(1, 'id'), g2_fa: G(1, 'fa'), g2_ga: G(1, 'ga'), g2_xga: G(1, 'xga'),
      xg_model: rec.xg_model || '', src: srcHash || '',
    });
    void o;
  }
  return out;
}

function toCsv(rows) {
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return COLS.join(',') + '\n' + rows.map((r) => COLS.map((c) => esc(r[c])).join(',')).join('\n') + '\n';
}

function loadXg(season) {
  const p = path.join(C.PATHS.xgModels, 'xg_for_' + season + '.json');
  if (!fs.existsSync(p)) return null;
  const m = JSON.parse(fs.readFileSync(p, 'utf8'));
  return X.predictor(m, m.id);
}

function buildSeason(season) {
  const mp = path.join(C.PATHS.cacheWork, 'games_' + season + '.manifest.json');
  if (!fs.existsSync(mp)) return { season, rows: 0, skipped: 'no ingested games for this season (run hockey/ingest/season.js first)', files: [] };
  const man = JSON.parse(fs.readFileSync(mp, 'utf8'));
  const src = (man.sources.pbp.sha256 || '').slice(0, 12);
  let xg = loadXg(season);
  /* a season with no model of its own (a new season before its first fit) uses the
     newest model whose training window ended before it */
  for (let s = season - 1; !xg && s >= C.FIRST_SEASON; s--) xg = loadXg(s);
  if (!xg) throw new Error('no xG model available for season ' + season + ' (run hockey/xg/train.js)');
  const byMonth = new Map(); let n = 0;
  for (const rec of readSeason(season)) {
    applyXg(rec, xg);
    for (const row of rowsFor(rec, src)) {
      const m = String(row.date).slice(0, 7);
      if (!byMonth.has(m)) byMonth.set(m, []);
      byMonth.get(m).push(row); n++;
    }
  }
  const dir = path.join(C.PATHS.teamGames, String(season));
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  for (const f of fs.readdirSync(dir)) if (/\.csv$/.test(f) && !byMonth.has(f.replace(/\.csv$/, ''))) fs.unlinkSync(path.join(dir, f));
  for (const [m, rows] of [...byMonth.entries()].sort()) {
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.game_id - b.game_id || b.home - a.home));
    const file = path.join(dir, m + '.csv');
    const text = toCsv(rows);
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (old !== text) fs.writeFileSync(file, text);
    written.push({ file: path.relative(C.ROOT, file), rows: rows.length, changed: old !== text });
  }
  return { season, rows: n, xg_model: xg.id, files: written, sources: man.sources, stats: man.stats };
}

/* ---- the reader every model uses ---- */
function parseCsv(text) {
  const lines = text.split('\n').filter(Boolean); const head = lines[0].split(',');
  const numeric = new Set(COLS.filter((c) => !['date', 'start_utc', 'known_at', 'assumed_available_at', 'pit', 'team', 'opp', 'type', 'decided', 'xg_model', 'src'].includes(c)));
  return lines.slice(1).map((l) => {
    const f = l.split(','); const o = {};
    for (let i = 0; i < head.length; i++) { const v = f[i]; o[head[i]] = numeric.has(head[i]) ? (v === '' || v == null ? null : Number(v)) : v; }
    return o;
  });
}
function loadTeamGames(seasons) {
  const out = [];
  for (const s of seasons) {
    const dir = path.join(C.PATHS.teamGames, String(s));
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => /\.csv$/.test(x)).sort()) out.push(...parseCsv(fs.readFileSync(path.join(dir, f), 'utf8')));
  }
  return out;
}

function updateManifest(results) {
  let man = {}; try { man = JSON.parse(fs.readFileSync(C.PATHS.manifest, 'utf8')); } catch (_) {}
  man.schema = C.SCHEMA.team_games; man.columns = COLS; man.seasons = man.seasons || {};
  man.temporal = {
    known_at: 'blank: the source\'s first publication time was not recorded for history (never backdated)',
    assumed_available_at: 'scheduled start + 4 h (end of the game\'s day when the start is unknown); an explicit modelling assumption',
    pit: 'RETRO on every row: retrieved after the fact from a source that can revise; retrospective research data, not point-in-time certified',
  };
  for (const r of results) man.seasons[r.season] = { rows: r.rows, games: r.rows / 2, xg_model: r.xg_model, sources: r.sources, ingest: r.stats, files: r.files.map((f) => f.file) };
  man.license = C.LICENSE.sportsdataverse;
  man.updated_at = new Date().toISOString();
  fs.writeFileSync(C.PATHS.manifest, JSON.stringify(man, null, 1) + '\n');
  /* goalie names: the newest season's spelling wins */
  let names = {}; try { names = JSON.parse(fs.readFileSync(C.PATHS.goalies, 'utf8')); } catch (_) {}
  const seasons = Object.keys(man.seasons).map(Number).sort((a, b) => a - b);
  for (const s of seasons) { try { Object.assign(names, JSON.parse(fs.readFileSync(path.join(C.PATHS.cacheWork, 'goalie_names_' + s + '.json'), 'utf8'))); } catch (_) {} }
  const sorted = {}; for (const k of Object.keys(names).sort()) sorted[k] = names[k];
  fs.writeFileSync(C.PATHS.goalies, JSON.stringify(sorted, null, 0) + '\n');
}

module.exports = { COLS, rowsFor, buildSeason, loadTeamGames, parseCsv, updateManifest, assumedAvailableAt };

if (require.main === module) {
  const i = process.argv.indexOf('--season');
  const spec = i >= 0 ? process.argv[i + 1] : String(C.CURRENT_SEASON);
  const seasons = spec.replace(/^current$/, String(C.CURRENT_SEASON)).replace(/^all$/, C.FIRST_SEASON + '-' + C.CURRENT_SEASON).split(',').flatMap((s) => { const m = /^(\d{4})-(\d{4})$/.exec(s); if (m) { const a = []; for (let y = +m[1]; y <= +m[2]; y++) a.push(y); return a; } return [+s]; });
  const results = [];
  for (const s of seasons) { const r = buildSeason(s); if (r.skipped) { console.log('[team_games] ' + s + ': ' + r.skipped); continue; } results.push(r); console.log('[team_games] ' + s + ': ' + r.rows + ' rows, xG ' + r.xg_model + ', ' + r.files.filter((f) => f.changed).length + '/' + r.files.length + ' files changed'); }
  updateManifest(results);
}
