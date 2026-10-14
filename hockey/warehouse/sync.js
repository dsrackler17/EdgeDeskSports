#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NHL — sync the committed NHL artifacts into the Supabase
   warehouse (schema `nhl`, supabase/nhl_warehouse.sql).

     NHL_WAREHOUSE=on node hockey/warehouse/sync.js [--seasons 2026-2027] [--dry-run]

   OFF BY DEFAULT. Without NHL_WAREHOUSE=on, or without service credentials
   (EDGD_SB_URL / EDGD_SB_SERVICE, tools/lib/pgrest.js), it writes nothing and
   says so. The schema must be applied and exposed first (see the SQL file).

   INCREMENTAL AND IDEMPOTENT. Each dataset is split into parts (a season, a
   file); a part is written only when the sha256 of its rows differs from
   nhl.sync_state. Writes are upserts on each table's key, in batches. The
   pregame predictions are INSERT-or-ignore (the table is append-only; a
   trigger refuses updates), so re-running never rewrites history.

   WHAT GOES IN (and from where — the files, not recomputation):
     sources          hockey/sources/registry.json
     games, team_games, game_periods   hockey/data/team_games, hockey/data/game_periods
     goalie_games, skater_games, players   .cache/nhl_work/box_<season>.json.gz (+ ixG)
     predictions      hockey/ledger/<season>.jsonl
     quotes           hockey/market/quotes.json (only when LIVE or CACHED)
     validation_runs  hockey/validation/*.json (a summary of each)
     reconciliation   hockey/validation/nhl_crosscheck_box.json
     model_versions   hockey/model/params/live.json, lab_live.json
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('../config');

const SCHEMA = 'nhl';
const sha = (x) => crypto.createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');
function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return d; } }
function seasonsArg(spec) {
  return String(spec || (C.CURRENT_SEASON - 1) + '-' + C.CURRENT_SEASON).replace(/^all$/, C.FIRST_SEASON + '-' + C.CURRENT_SEASON).split(',').flatMap((s) => { const m = /^(\d{4})-(\d{4})$/.exec(s); if (m) { const a = []; for (let y = +m[1]; y <= +m[2]; y++) a.push(y); return a; } return [+s]; });
}

/* ---------- dataset builders: each returns [{ part, rows, onConflict, ignoreDuplicates }] ---------- */
function sourcesParts() {
  const r = readJson(path.join(C.HOCKEY, 'sources', 'registry.json'), null); if (!r) return [];
  return [{ part: 'all', onConflict: 'source_id', rows: r.providers.map((p) => ({ source_id: p.id, name: p.name, url: p.url, status: p.status, authorised_for: p.authorised_for || [], terms: p.terms || {}, cost: p.cost || null, last_sync: p.last_sync || null, contribution: p.contribution || null, detail: { datasets: p.datasets || [], coverage: p.coverage || null, access: p.access || null, methodology: p.methodology || null, data_permission: p.data_permission || null }, updated_at: r.generated_at })) }];
}
function gameParts(seasons) {
  const TG = require('../ingest/team_games'); const PR = require('../ingest/periods');
  const out = { games: [], team_games: [], game_periods: [] };
  for (const s of seasons) {
    const rows = TG.loadTeamGames([s]); if (!rows.length) continue;
    const homes = rows.filter((r) => r.home === 1);
    out.games.push({ part: String(s), onConflict: 'game_id', rows: homes.map((r) => ({ game_id: r.game_id, season: r.season, game_type: r.type, game_date: r.date, start_utc: r.start_utc || null, home: r.team, away: r.opp, final_home: r.gf, final_away: r.ga, reg_home: r.gf_reg, reg_away: r.ga_reg, decided: r.decided, known_at: null, assumed_available_at: r.assumed_available_at || null, pit: r.pit || 'RETRO', source: 'sportsdataverse_nhl', src_hash: r.src || null })) });
    out.team_games.push({ part: String(s), onConflict: 'game_id,team', rows: rows.map((r) => ({ game_id: r.game_id, team: r.team, opp: r.opp, home: r.home === 1, gf: r.gf, ga: r.ga, gf_reg: r.gf_reg, ga_reg: r.ga_reg, toi_ev5: r.toi_ev5, toi_pp: r.toi_pp, toi_sh: r.toi_sh, ev5_xgf: r.ev5_xgf, ev5_ff: r.ev5_ff, ev5_cf: r.ev5_cf, pp_xgf: r.pp_xgf, sh_xgf: r.sh_xgf, pim: r.pim, g_start: r.g_start == null ? null : r.g_start, xg_model: r.xg_model || null })) });
    const per = PR.loadPeriods([s]);
    if (per.size) out.game_periods.push({ part: String(s), onConflict: 'game_id', rows: [...per.values()].map((p) => ({ game_id: p.game_id, h1: p.h1, a1: p.a1, h2: p.h2, a2: p.a2, h3: p.h3, a3: p.a3, hot: p.hot, aot: p.aot, h_en: p.h_en, a_en: p.a_en, h_late: p.h_late, a_late: p.a_late, check_note: p.check })) });
  }
  return out;
}
function boxParts(seasons) {
  const out = { goalie_games: [], skater_games: [], players: [] };
  let D = null; try { D = require('../props/data'); } catch (_) { return out; }
  const names = {};
  for (const s of seasons) {
    const d = D.loadSeason(s); if (!d) continue;
    Object.assign(names, d.names || {});
    out.goalie_games.push({ part: String(s), onConflict: 'game_id,goalie_id', rows: d.goalies.map((g) => ({ game_id: g.game_id, goalie_id: g.goalie, team: g.team, starter: !!g.starter, toi_s: g.toi, shots_against: g.sa, saves: g.sv, goals_against: g.ga, source: 'boxscore' })) });
    out.skater_games.push({ part: String(s), onConflict: 'game_id,player_id', rows: d.skaters.map((k) => ({ game_id: k.game_id, player_id: k.player, team: k.team, pos: k.pos, toi_s: k.toi, goals: k.g, assists: k.a, shots_on_goal: k.sog, pp_goals: k.ppg, ixg: k.ixg == null ? null : Math.round(k.ixg * 10000) / 10000, source: 'boxscore+pbp' })) });
  }
  if (Object.keys(names).length) out.players.push({ part: 'names:' + seasons.join(','), onConflict: 'player_id', rows: Object.entries(names).map(([id, n]) => ({ player_id: Number(id), name: n })) });
  return out;
}
function predictionParts(seasons) {
  const out = [];
  for (const s of seasons) {
    const f = path.join(C.PATHS.ledger, s + '.jsonl'); if (!fs.existsSync(f)) continue;
    const rows = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.id && Date.parse(r.recorded_at) < Date.parse(r.start_utc))
      .map((r) => ({ id: r.id, game_id: r.game_id, model_id: r.model, recorded_at: r.recorded_at, start_utc: r.start_utc, home: r.home, away: r.away, p_home: r.p_home, reg: r.reg || null, pl_home_minus_1_5: r.pl_home_minus_1_5, exp_total: r.exp_total, over_5_5: r.over_5_5, over_6_5: r.over_6_5, goalie_certainty: r.goalie_certainty || null, market: r.market || null }));
    out.push({ part: String(s), onConflict: 'id', ignoreDuplicates: true, rows });
  }
  return out;
}
function quoteParts() {
  const q = readJson(path.join(C.PATHS.market, 'quotes.json'), null);
  if (!q || !(q.status === 'LIVE' || q.status === 'CACHED')) return [];
  const rows = [];
  for (const e of q.events || []) for (const b of e.books || []) {
    const at = b.last_update || q.generated_at;
    const push = (market, side, line, american) => { if (american == null) return; const k = [e.game_id, b.book, market, side, line, american, at].join('|'); rows.push({ quote_id: sha(k).slice(0, 24), game_id: e.game_id, book: b.book, market, side, line, american: Math.round(american), captured_at: at, source: 'odds_gateway', settles: q.settlement || null }); };
    if (b.h2h) { push('h2h', 'home', null, b.h2h.home); push('h2h', 'away', null, b.h2h.away); }
    for (const sp of b.spreads || []) { push('spreads', 'home', sp.home_line, sp.home); push('spreads', 'away', -sp.home_line, sp.away); }
    for (const t of b.totals || []) { push('totals', 'over', t.line, t.over); push('totals', 'under', t.line, t.under); }
  }
  return [{ part: 'quotes:' + q.generated_at, onConflict: 'quote_id', ignoreDuplicates: true, rows }];
}
function validationParts() {
  const dir = C.PATHS.validation; const rows = [];
  for (const f of fs.readdirSync(dir).filter((x) => /\.json$/.test(x)).sort()) {
    const j = readJson(path.join(dir, f), null); if (!j) continue;
    const summary = {};
    if (j.markets) summary.markets = Object.fromEntries(Object.entries(j.markets).map(([k, m]) => [k, { status: m.status || null, market_status: m.market_status || null, n: m.n || null }]));
    if (j.promotion) summary.promotion = { decision: j.promotion.decision, model: j.promotion.model };
    if (j.overall) summary.overall = j.overall;
    if (j.drift) summary.drift = { status: j.drift.status, z: j.drift.z };
    if (j.leakage) summary.leakage = { checked: j.leakage.checked, violations: j.leakage.violations };
    rows.push({ file: 'hockey/validation/' + f, schema_name: j.schema || null, generated_at: j.generated_at || null, summary });
  }
  return [{ part: 'all', onConflict: 'file', rows }];
}
function reconciliationParts() {
  const b = readJson(path.join(C.PATHS.validation, 'nhl_crosscheck_box.json'), null); if (!b) return [];
  const rows = [];
  for (const [s, v] of Object.entries(b.by_season || {})) for (const lvl of ['team', 'goalie', 'skater']) for (const [k, t] of Object.entries(v[lvl] || {})) rows.push({ season: Number(s), quantity: lvl + '.' + k, rows: t.rows, agree: t.agree, rate: t.rate, status: null });
  return [{ part: 'all', onConflict: 'season,quantity', rows }];
}
function modelParts() {
  const live = readJson(path.join(C.HOCKEY, 'model', 'params', 'live.json'), null), lab = readJson(path.join(C.HOCKEY, 'model', 'params', 'lab_live.json'), null);
  const wf = readJson(path.join(C.PATHS.validation, 'nhl_walkforward.json'), null);
  const rows = [];
  if (live) rows.push({ model_id: 'edgedesk_nhl_v1:' + live.model + '@' + live.for_season, kind: 'production', train_seasons: (live.glm_train_seasons || []).join('-'), params_sha256: sha(live), record: wf && wf.markets ? { moneyline: wf.markets.moneyline && wf.markets.moneyline.status, confirmation_log_loss: wf.windows.confirmation.by_candidate[live.model].moneyline.log_loss } : {} });
  if (lab) rows.push({ model_id: 'edgedesk_nhl_lab@' + lab.for_season, kind: 'research challengers', train_seasons: (lab.train_seasons || []).join('-'), params_sha256: sha(lab), record: { decision: lab.decision || null } });
  return rows.length ? [{ part: 'all', onConflict: 'model_id', rows }] : [];
}

/** the plan: dataset → parts, in foreign-key order */
function plan(seasons) {
  const g = gameParts(seasons); const bx = boxParts(seasons);
  return [
    ['sources', sourcesParts()], ['games', g.games], ['team_games', g.team_games], ['game_periods', g.game_periods],
    ['goalie_games', bx.goalie_games], ['skater_games', bx.skater_games], ['players', bx.players],
    ['predictions', predictionParts(seasons)], ['quotes', quoteParts()],
    ['validation_runs', validationParts()], ['reconciliation', reconciliationParts()], ['model_versions', modelParts()],
  ];
}

async function run(o) {
  o = o || {}; const env = o.env || process.env;
  if (String(env.NHL_WAREHOUSE || '').toLowerCase() !== 'on') return { status: 'SKIPPED', reason: 'NHL_WAREHOUSE is not "on": nothing is written (apply supabase/nhl_warehouse.sql, expose the nhl schema, then set it)' };
  const P = require('../../tools/lib/pgrest');
  const cfg = P.config(env);
  if (!cfg && !o.db) return { status: 'SKIPPED', reason: 'no service credentials (EDGD_SB_URL / EDGD_SB_SERVICE)' };
  const db = o.db || P.client(cfg, o.fetchImpl);
  const seasons = seasonsArg(o.seasons);
  const runId = 'nhl-sync-' + new Date().toISOString();
  const report = { status: 'ok', run_id: runId, seasons, datasets: {} };
  if (!o.dryRun) await db.upsert(SCHEMA, 'sync_runs', [{ run_id: runId, started_at: new Date().toISOString(), status: 'running', datasets: {}, detail: { seasons } }], 'run_id', { returning: false });
  let state = new Map();
  try { for (const r of await db.selectAll(SCHEMA, 'sync_state', 'select=dataset,part,sha256')) state.set(r.dataset + '|' + r.part, r.sha256); } catch (e) { report.status = 'failed'; report.error = 'sync_state unreadable: ' + String(e.message || e).slice(0, 200); return report; }
  for (const [ds, parts] of plan(seasons)) {
    const d = report.datasets[ds] = { parts: parts.length, written: 0, skipped: 0, rows: 0, errors: [] };
    for (const p of parts) {
      const h = sha(p.rows);
      if (state.get(ds + '|' + p.part) === h) { d.skipped++; continue; }
      if (o.dryRun) { d.written++; d.rows += p.rows.length; continue; }
      try {
        await db.upsert(SCHEMA, ds, p.rows, p.onConflict, { returning: false, ignoreDuplicates: !!p.ignoreDuplicates, chunk: 500 });
        await db.upsert(SCHEMA, 'sync_state', [{ dataset: ds, part: p.part, sha256: h, rows: p.rows.length, synced_at: new Date().toISOString() }], 'dataset,part', { returning: false });
        d.written++; d.rows += p.rows.length;
      } catch (e) { d.errors.push(p.part + ': ' + String(e.message || e).slice(0, 200)); report.status = 'partial'; }
    }
  }
  if (!o.dryRun) await db.upsert(SCHEMA, 'sync_runs', [{ run_id: runId, started_at: report.run_id.replace('nhl-sync-', ''), finished_at: new Date().toISOString(), status: report.status, datasets: report.datasets, detail: { seasons } }], 'run_id', { returning: false });
  return report;
}

module.exports = { run, plan, seasonsArg, sha };

if (require.main === module) {
  const a = (n) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : null; };
  run({ seasons: a('seasons'), dryRun: process.argv.includes('--dry-run') }).then((r) => {
    console.log('[nhl warehouse] ' + r.status + (r.reason ? ': ' + r.reason : '') + (r.datasets ? ' — ' + Object.entries(r.datasets).map(([k, v]) => k + ' ' + v.written + '/' + v.parts + ' (' + v.rows + ' rows)' + (v.errors.length ? ' ERR ' + v.errors.length : '')).join(', ') : ''));
    if (r.status === 'failed') process.exit(1);
  }).catch((e) => { console.error(e && e.stack || e); process.exit(1); });
}
