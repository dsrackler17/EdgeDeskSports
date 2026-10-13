#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk Quant Data Pack — independent verification in Node.

   Mirrors the pack's own scripts/verify_pack.py (which is never run in CI:
   the pack is data, not code I trust to execute) and adds the checks the
   import needs:

     1. every inventoried CSV: SHA-256, row and column counts, blank known_at
        (the pack does not reconstruct first publication, so a filled
        known_at would be a backdated claim);
     2. files kept outside git (NFL play-by-play, 38 MB) are verified when a
        copy exists in .cache/datapack, otherwise reported EXTERNAL; a file
        the upload did not contain is reported MISSING — never filled;
     3. the contract: unique tables and columns, JSON Schema correspondence,
        the SQLite DDL executes and creates every table, every
        EMPTY_TEMPLATE has no data rows;
     4. every NFL prior-5/10/20 feature recomputed from the team-game table,
        with target-game and same-day exclusion;
     5. NHL xG never invented, NHL event ids unique, tennis draws separated
        and matches unique;
     6. every source-manifest SHA-256 for files present;
     7. no CSV under data/ that the inventory does not list.

   Writes datapack/quant_v1/EDGEDESK_VERIFICATION.json. --check recomputes
   and fails when the result differs from the committed file (the time
   stamp aside) or when any check fails.

   Run: node tools/datapack/verify.js [--check]
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readCsv, scanCsv } = require('../../engine/csv');

const ROOT = path.join(__dirname, '..', '..');
const PACK = path.join(ROOT, 'datapack', 'quant_v1');
const EXTERNAL = path.join(ROOT, '.cache', 'datapack', 'quant_v1');
const OUT = path.join(PACK, 'EDGEDESK_VERIFICATION.json');
const IMPORT = JSON.parse(fs.readFileSync(path.join(PACK, 'IMPORT.json'), 'utf8'));

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const rel = (p) => path.relative(ROOT, p);

function locate(file) {
  const inRepo = path.join(PACK, file);
  if (fs.existsSync(inRepo)) return { where: 'IN_REPO', abs: inRepo };
  const ext = path.join(EXTERNAL, file);
  if (fs.existsSync(ext)) return { where: 'EXTERNAL_CACHE', abs: ext };
  return { where: null, abs: null };
}

function verify() {
  const checks = [];
  const check = (id, pass, detail) => { checks.push({ id, pass: !!pass, detail: detail == null ? null : detail }); return !!pass; };
  const inventory = JSON.parse(fs.readFileSync(path.join(PACK, 'DATA_INVENTORY.json'), 'utf8'));
  const excluded = new Map(IMPORT.excluded_from_git.map((e) => [e.file, e]));
  const datasets = [];
  const cache = {};

  /* 1-2. inventory */
  for (const i of inventory) {
    const loc = locate(i.file);
    const d = { file: i.file, expected_rows: i.rows, expected_sha256: i.sha256, known_at_status: i.known_at_status };
    if (!loc.abs) {
      const ex = excluded.get(i.file);
      d.state = ex && ex.reason_code === 'EMPTY_UPLOAD' ? 'MISSING' : 'EXTERNAL';
      d.note = ex ? ex.reason : 'not in the repository';
      datasets.push(d);
      continue;
    }
    d.location = loc.where;
    d.sha_ok = sha(loc.abs) === i.sha256;
    /* the wide NFL play-by-play is counted, not held */
    const wide = /play_by_play_/.test(i.file);
    const t = wide ? scanCsv(loc.abs, ['known_at']) : readCsv(loc.abs);
    const n = wide ? t.rows : t.rows.length;
    if (!wide) cache[i.file] = t.rows;
    d.rows = n; d.columns = t.header.length;
    d.counts_ok = n === i.rows && (n === 0 || t.header.length === i.columns) && !(wide && t.ragged);
    d.known_at_blank = t.header.indexOf('known_at') < 0 ? null : wide ? t.nonBlank.known_at === 0 : t.rows.every((r) => r.known_at === '');
    d.state = d.sha_ok && d.counts_ok && d.known_at_blank !== false ? 'VERIFIED' : 'FAILED';
    datasets.push(d);
  }
  const failed = datasets.filter((d) => d.state === 'FAILED');
  check('csv_counts_sha256', failed.length === 0, failed.map((d) => d.file));
  check('historical_known_at_blank', datasets.every((d) => d.known_at_blank !== false), datasets.filter((d) => d.known_at_blank === false).map((d) => d.file));
  const unaccounted = datasets.filter((d) => (d.state === 'EXTERNAL' || d.state === 'MISSING') && !excluded.has(d.file));
  check('every_absent_file_declared', unaccounted.length === 0, unaccounted.map((d) => d.file));

  /* 3. contract */
  const tables = JSON.parse(fs.readFileSync(path.join(PACK, 'schemas', 'table_catalog.json'), 'utf8'));
  const names = tables.map((t) => t.family + '/' + t.table);
  check('unique_contract_tables', new Set(names).size === names.length);
  const colDupes = []; const schemaMismatch = [];
  for (const t of tables) {
    const fields = t.columns.map((c) => c.field);
    if (new Set(fields).size !== fields.length) colDupes.push(t.family + '/' + t.table);
    const schema = JSON.parse(fs.readFileSync(path.join(PACK, 'schemas', t.family, t.table + '.schema.json'), 'utf8'));
    const props = Object.keys(schema.properties || {});
    if (props.length !== fields.length || props.some((p) => fields.indexOf(p) < 0)) schemaMismatch.push(t.family + '/' + t.table);
  }
  check('unique_contract_columns', colDupes.length === 0, colDupes);
  check('json_schema_correspondence', schemaMismatch.length === 0, schemaMismatch);
  let ddlTables = null;
  try {
    process.removeAllListeners('warning');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec(fs.readFileSync(path.join(PACK, 'schemas', 'create_research_contracts_sqlite.sql'), 'utf8'));
    ddlTables = db.prepare("select count(*) as n from sqlite_master where type='table'").get().n;
    db.close();
  } catch (e) { ddlTables = 'ERROR ' + e.message; }
  check('sqlite_ddl_executes', ddlTables === tables.length, { created: ddlTables, contract: tables.length });
  const templates = [];
  (function walk(dir) {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/_EMPTY_TEMPLATE\.csv$/.test(f)) templates.push(p);
    }
  })(path.join(PACK, 'schemas'));
  const filledTemplates = templates.filter((p) => readCsv(p).rows.length > 0).map(rel);
  check('templates_are_empty', filledTemplates.length === 0, { templates: templates.length, with_rows: filledTemplates });

  /* 4. NFL lag features */
  const stats = cache['data/nfl/team_game_advanced_2022_2024.csv'];
  const feats = cache['data/nfl/pregame_rolling_features_2022_2024.csv'];
  const lag = { recomputed: 0, errors: [] };
  if (stats && feats) {
    const byKey = new Map(stats.map((x) => [x.game_id + '|' + x.team_id, x]));
    const history = new Map();
    const SPEC = [['epa_sum', 'plays', 'off_epa_per_play'], ['successful_plays', 'plays', 'success_rate'], ['pass_epa_sum', 'dropbacks', 'pass_epa_per_dropback'],
      ['rush_epa_sum', 'designed_rushes', 'rush_epa_per_designed_rush'], ['def_epa_allowed_sum', 'def_plays', 'def_epa_allowed_per_play'],
      ['def_successes_allowed', 'def_plays', 'def_success_allowed_rate'], ['sacks', 'dropbacks', 'sack_rate'], ['cpoe_sum', 'cpoe_passes', 'cpoe']];
    const sorted = feats.slice().sort((a, b) => (a.team_id < b.team_id ? -1 : a.team_id > b.team_id ? 1 : a.game_date < b.game_date ? -1 : a.game_date > b.game_date ? 1 : a.game_id < b.game_id ? -1 : a.game_id > b.game_id ? 1 : 0));
    for (const row of sorted) {
      const prior = history.get(row.team_id) || [];
      for (const w of [5, 10, 20]) {
        const earlier = prior.slice(-w);
        if (!earlier.every((p) => p.game_date < row.game_date)) lag.errors.push('future or same-day game in ' + row.game_id + ' ' + row.team_id);
        for (const [n, dd, name] of SPEC) {
          let num = 0, den = 0;
          for (const x of earlier) { if (x[n] !== '') num += Number(x[n]); if (x[dd] !== '') den += Number(x[dd]); }
          const actual = row[name + '_prior_' + w];
          lag.recomputed++;
          if (den) { if (actual === '' || Math.abs(Number(actual) - num / den) >= 1e-9) lag.errors.push(name + '_prior_' + w + ' ' + row.game_id + ' ' + row.team_id); }
          else if (actual !== '') lag.errors.push('empty exposure produced ' + name + '_prior_' + w + ' ' + row.game_id);
        }
      }
      const self = byKey.get(row.game_id + '|' + row.team_id);
      if (!self) lag.errors.push('no team-game row for ' + row.game_id + ' ' + row.team_id);
      else { prior.push(self); history.set(row.team_id, prior); }
    }
  } else lag.errors.push('NFL team-game or feature table not verified');
  check('nfl_lag_features_recomputed', lag.errors.length === 0, { values: lag.recomputed, errors: lag.errors.slice(0, 10) });

  /* 5. NHL and tennis */
  const shots = cache['data/nhl/shot_attempts_sample.csv'] || [];
  check('nhl_xg_not_invented', shots.length > 0 && shots.every((x) => x.xg === ''), { attempts: shots.length });
  check('nhl_event_ids_unique', new Set(shots.map((x) => x.game_id + '|' + x.event_id)).size === shots.length);
  const goalies = cache['data/nhl/goalie_game_observed_sample.csv'] || [];
  check('nhl_goalie_xg_gsax_not_invented', goalies.length > 0 && goalies.every((x) => x.expected_goals_against === '' && x.gsax === ''), { rows: goalies.length });
  for (const [tour, slug] of [['atp', 'mens-singles'], ['wta', 'womens-singles']]) {
    const tr = cache['data/tennis_' + tour + '/matches_sample.csv'] || [];
    check('tennis_' + tour + '_singles_only', tr.length > 0 && tr.every((x) => x.draw_type === slug), { rows: tr.length });
    check('tennis_' + tour + '_matches_unique', new Set(tr.map((x) => x.match_id)).size === tr.length);
  }

  /* 6. source manifests */
  const manifestErrors = []; let manifestChecked = 0, manifestAbsent = 0;
  for (const m of ['download_manifest.json', 'supplement_download_manifest.json', 'ufc_download_manifest.json', 'unified_download_manifest.json']) {
    const j = JSON.parse(fs.readFileSync(path.join(PACK, 'sources', m), 'utf8'));
    for (const e of j.files) {
      if (!e.sha256 || !e.file) continue;
      const loc = locate(e.file);
      if (!loc.abs) { manifestAbsent++; continue; }
      manifestChecked++;
      if (sha(loc.abs) !== e.sha256) manifestErrors.push(e.file);
    }
  }
  check('source_manifest_sha256', manifestErrors.length === 0, { checked: manifestChecked, absent: manifestAbsent, mismatched: manifestErrors });

  /* 7. nothing unlisted */
  const listed = new Set(inventory.map((i) => i.file));
  const unlisted = [];
  (function walk(dir) {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isDirectory()) { if (f !== 'raw') walk(p); }
      else if (/\.csv(\.gz)?$/.test(f) && !listed.has(path.relative(PACK, p))) unlisted.push(path.relative(PACK, p));
    }
  })(path.join(PACK, 'data'));
  check('no_unlisted_tables', unlisted.length === 0, unlisted);

  const pass = checks.every((c) => c.pass);
  return {
    schema: 'edgedesk_datapack_verification_v1',
    pack: 'datapack/quant_v1',
    verified_at: new Date().toISOString(),
    status: pass ? 'PASSED' : 'FAILED',
    summary: {
      datasets: datasets.length,
      verified: datasets.filter((d) => d.state === 'VERIFIED').length,
      external: datasets.filter((d) => d.state === 'EXTERNAL').length,
      missing: datasets.filter((d) => d.state === 'MISSING').length,
      failed: failed.length,
      contract_tables: tables.length,
    },
    checks,
    datasets,
    limitations: [
      'Not a point-in-time certification: historical known_at is blank throughout, so every table is retrospective research data.',
      'Not a licensing certification: each source keeps its own terms (sources/source_registry.json).',
      'Not model validation: the pack ships no trained model and no bookmaker prices.',
    ],
  };
}

function stable(r) { const c = JSON.parse(JSON.stringify(r)); delete c.verified_at; return JSON.stringify(c); }

if (require.main === module) {
  const r = verify();
  const checkMode = process.argv.indexOf('--check') >= 0;
  for (const c of r.checks) console.log((c.pass ? 'ok   ' : 'FAIL ') + c.id + (c.pass ? '' : '  ' + JSON.stringify(c.detail).slice(0, 300)));
  console.log(r.status + ' — ' + JSON.stringify(r.summary));
  if (checkMode) {
    let committed = null;
    try { committed = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (_) {}
    /* a copy of the external files may or may not be present: compare what both runs saw */
    const norm = (x) => { const c = JSON.parse(stable(x)); c.datasets.forEach((d) => { if (d.location === 'EXTERNAL_CACHE' || d.state === 'EXTERNAL') { d.state = 'EXTERNAL'; ['location', 'sha_ok', 'rows', 'columns', 'counts_ok', 'known_at_blank', 'note'].forEach((k) => delete d[k]); } }); c.summary = null; c.checks.forEach((k) => { if (k.id === 'source_manifest_sha256') k.detail = null; }); return JSON.stringify(c); };
    if (!committed || norm(committed) !== norm(r)) { console.log('FAIL the committed EDGEDESK_VERIFICATION.json differs from a fresh run'); process.exit(1); }
    process.exit(r.status === 'PASSED' ? 0 : 1);
  }
  fs.writeFileSync(OUT, JSON.stringify(r, null, 2) + '\n');
  console.log('wrote ' + rel(OUT));
  process.exit(r.status === 'PASSED' ? 0 : 1);
}
module.exports = { verify };
