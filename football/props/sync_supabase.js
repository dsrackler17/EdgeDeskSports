#!/usr/bin/env node
/* ===========================================================================
   PLAYER PROPS → SUPABASE (optional mirror; the repository is the record).
   docs/player-props/SCHEMA.md

     SB_URL=… SB_SERVICE_ROLE=… node football/props/sync_supabase.js [--league nfl|cfb]

   Mirrors what the build and the record committed into the tables of
   supabase/player_props.sql: the registry and its crosswalk, the published
   projections and their distributions, the frozen predictions, the grades
   and the closing lines. Every insert is on-conflict-do-nothing: the tables
   are append-only and a row already there is never changed. Without the two
   secrets it says so and exits 0 — the site reads the committed JSON either way.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const P = require('../../lib/edgedesk_props.js');

const ROOT = path.join(__dirname, '..', '..');
function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; }
function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return d; } }

async function post(url, key, table, rows, conflict, merge) {
  if (!rows.length) return { table, rows: 0 };
  const h = { apikey: key, authorization: 'Bearer ' + key, 'content-type': 'application/json', prefer: (merge ? 'resolution=merge-duplicates' : 'resolution=ignore-duplicates') + ',return=minimal' };
  let sent = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const r = await fetch(url + '/rest/v1/' + table + (conflict ? '?on_conflict=' + conflict : ''), { method: 'POST', headers: h, body: JSON.stringify(rows.slice(i, i + 500)) });
    if (!r.ok) return { table, rows: sent, error: 'HTTP ' + r.status + ' ' + (await r.text()).slice(0, 300) };
    sent += Math.min(500, rows.length - i);
  }
  return { table, rows: sent };
}

async function run(league) {
  const url = process.env.SB_URL || process.env.SUPABASE_URL, key = process.env.SB_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { skipped: 'no SB_URL / SB_SERVICE_ROLE: nothing mirrored (the committed JSON is the record)' };
  const L = league.toLowerCase(), dir = path.join(__dirname, L);
  const reg = readJson(path.join(dir, 'players.json'), null);
  const board = readJson(path.join(dir, 'board.json'), null);
  const out = [];
  if (reg) {
    const rows = Object.values(reg.players).map((p) => ({ player_id: p.id, league: reg.league, anchor_system: reg.anchor, anchor_id: p.ids[reg.anchor], full_name: p.name || p.ids[reg.anchor], slug: p.slug, position: p.position, current_team: p.team, status: p.status || null,
      headshot_url: p.headshot || null, linked_player: p.links ? (p.links.nfl || p.links.cfb || null) : null, first_seen: p.first_seen ? String(p.first_seen).slice(0, 10) : null, last_seen: p.last_seen ? String(p.last_seen).slice(0, 10) : null }));
    out.push(await post(url, key, 'player_registry', rows, 'player_id', true));
    const idm = [];
    Object.values(reg.players).forEach((p) => {
      Object.keys(p.ids || {}).forEach((s) => { if (p.ids[s]) idm.push({ player_id: p.id, system: reg.league.toLowerCase() + ':' + s, external_id: String(p.ids[s]), kind: 'provider_id' }); });
      (p.aliases && p.aliases.books || []).forEach((a) => idm.push({ player_id: p.id, system: 'book:' + (a.book || 'any'), external_id: a.norm, kind: 'book_name', book: a.book || null }));
      (p.aliases && p.aliases.former || []).forEach((a) => idm.push({ player_id: p.id, system: 'former_name', external_id: P.normName(a), kind: 'former_name' }));
    });
    out.push(await post(url, key, 'player_identity_map', idm, 'system,external_id,kind', false));
  }
  if (board) {
    const projs = [], dists = [];
    board.games.forEach((g) => {
      const gf = readJson(path.join(dir, 'games', g.game_id + '.json'), null);
      if (!gf) return;
      const stageOf = (r) => P.stageFor(board.stages, r.prop_type, r.position);
      P.projectionsOf(gf).forEach((r) => {
        const s = r.summary || {};
        projs.push({ projection_id: r.projection_id, league: board.league, model_version: r.model_version, game_id: r.game_id, kickoff: r.kickoff, player_id: r.player_id, prop_type: r.prop_type, as_of: r.as_of, inputs_hash: r.inputs_hash,
          status: r.status, mean: s.mean, median: s.median, sd: s.sd, p10: s.p10, p25: s.p25, p75: s.p75, p90: s.p90, fair_line: s.fair_line, stage: stageOf(r), opportunity: r.opportunity || null, drivers: r.drivers || null, risks: r.risks || null });
        if (r.dist) dists.push({ projection_id: r.projection_id, lo: r.dist.lo, n: r.dist.n, pmf: r.dist.pmf, sims: r.dist.sims || r.sims_used || null });
      });
    });
    out.push(await post(url, key, 'player_prop_projections', projs, 'projection_id', false));
    out.push(await post(url, key, 'player_prop_distributions', dists, 'projection_id', false));
  }
  const season = board ? board.season : new Date().getUTCFullYear();
  const led = path.join(__dirname, 'ledger', L, String(season), 'predictions.jsonl');
  if (fs.existsSync(led)) {
    const preds = fs.readFileSync(led, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const cols = ['prediction_id', 'kind', 'league', 'season', 'week', 'game_id', 'kickoff', 'player_id', 'player_name', 'team', 'opponent', 'position', 'prop_type', 'side', 'line', 'american', 'book', 'is_alternate', 'quote_captured_at',
      'model_prob', 'model_cover', 'market_prob', 'fair_american', 'fair_line', 'projection_mean', 'projection_median', 'edge_pp', 'ev', 'decision_prob', 'decision_ev', 'decision', 'reason_code', 'units', 'reliability', 'confidence_tier', 'stage', 'model_version', 'projection_id', 'frozen_at'];
    out.push(await post(url, key, 'player_prop_decisions', preds.map((p) => { const o = {}; cols.forEach((c) => { o[c] = p[c] === undefined ? null : p[c]; }); return o; }), 'prediction_id', false));
  }
  const rec = readJson(path.join(ROOT, 'record', 'props', L + '_' + season + '.json'), null);
  if (rec && rec.predictions) {
    const grades = rec.predictions.filter((x) => x.status === 'GRADED' && x.result).map((x) => ({ prediction_id: x.prediction_id, result: x.result, void_reason: x.void_reason || null, actual: x.actual, profit_units: x.profit_units, flat_profit: x.flat_profit,
      close_line: x.close ? x.close.line : null, close_over: x.close ? x.close.over : null, close_under: x.close ? x.close.under : null, clv_price: x.clv_price, clv_line: x.clv_line, graded_at: rec.generated_at, kickoff: x.kickoff }));
    out.push(await post(url, key, 'player_prop_grades', grades, 'prediction_id', false));
  }
  return { league, results: out };
}
if (require.main === module) run(arg('league', 'nfl')).then((r) => { console.log(JSON.stringify(r, null, 1)); process.exit(r.results && r.results.some((x) => x.error) ? 1 : 0); }).catch((e) => { console.error(e && e.stack || e); process.exit(1); });
module.exports = { run };
