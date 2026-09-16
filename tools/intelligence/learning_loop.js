#!/usr/bin/env node
/* ============================================================================
   THE LEARNING LOOP — nightly, unattended, and unable to promote anything.

   1. Reads the desk's quoted prices: the research_packet_pricing view from
      Supabase when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set (names
      only; never written here), or a JSON export passed as --rows.
   2. Joins each packet to the closing-line archives by game id (NFL: the
      archive and the opener ledger; CFB: the archive), so every quoted line
      has its close, its result and, where captured, its opener.
   3. Runs the closing-line-value scorecard (tools/intelligence/clv.js) and
      the postmortem (tools/intelligence/postmortem.js) over the graded rows,
      and reads the pricing, movement and feature validations for drift.
   4. Writes football/validation/scorecard.json: counts, CLV by tier and
      status, open-to-close movement toward the fair line, postmortem
      classes and candidates, tiers by model version, and the status of every
      input, so the desk and a reviewer see the same record.

   Nothing here changes a tier, a coefficient or a prompt. A candidate stays
   a hypothesis with the held-out evaluation it must pass named beside it.

   Usage
     node tools/intelligence/learning_loop.js                 # Supabase (env) or nothing
     node tools/intelligence/learning_loop.js --rows rows.json
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const CLV = require(path.join(__dirname, 'clv.js'));
const PM = require(path.join(__dirname, 'postmortem.js'));
const OUT = path.join(ROOT, 'football', 'validation', 'scorecard.json');

function readJson(rel) { try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); } catch (_) { return null; } }
function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function r3(v) { return v == null ? null : Math.round(v * 1000) / 1000; }

/** Fetch the pricing view through PostgREST with the service role. Returns {rows, status}. */
async function fetchRows(env, fetchImpl) {
  const url = env.SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { rows: [], status: 'NO_DATABASE_ACCESS', detail: 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not set; pass --rows <file> for an export' };
  try {
    const r = await (fetchImpl || fetch)(url.replace(/\/$/, '') + '/rest/v1/research_packet_pricing?select=*&order=built_at.desc&limit=5000', { headers: { apikey: key, authorization: 'Bearer ' + key, accept: 'application/json' } });
    if (!r.ok) return { rows: [], status: 'DATABASE_ERROR', detail: 'HTTP ' + r.status };
    const rows = await r.json(); return { rows: Array.isArray(rows) ? rows : [], status: 'OK', detail: null };
  } catch (e) { return { rows: [], status: 'DATABASE_ERROR', detail: String(e && e.message || e) }; }
}

/** Closes by game id from both archives. */
function closes(archives) {
  const byId = {};
  (archives.nfl && archives.nfl.games || []).forEach((g) => { byId[g.id] = { sport: 'americanfootball_nfl', home_line: g.close.home_line, margin: g.margin, total: g.close.total, open_home_line: g.open ? g.open.home_line : null, open_seen_at: g.open ? g.open.seen_at : null }; });
  (archives.cfb && archives.cfb.games || []).forEach((g) => { byId[g.id] = { sport: 'americanfootball_ncaaf', home_line: g.close.home_line, margin: g.margin, total: g.close.total, open_home_line: g.open ? g.open.home_line : null, open_seen_at: null }; });
  return byId;
}

/** The whole loop over rows and archives. Pure given its inputs. */
function build(rows, archives, validations, opts) {
  opts = opts || {};
  const byId = closes(archives);
  const arch = { byId, error: null, games: Object.keys(byId).length };
  const clv = CLV.report(rows, { archive: arch, closes: byId });
  /* postmortem rows: outcome and final margin from the archive, the quoted line as the handicap */
  const pmRows = rows.map((r) => { const c = byId[String(r.game_id)]; const g = clv.graded.find((x) => x.packet_id === r.packet_id) || {}; return { packet_id: r.packet_id, sport: r.sport, game_id: r.game_id, side: r.quoted_side, selection: r.quoted_selection, label: r.label, outcome: g.result === 'WIN' ? 'WIN' : g.result === 'LOSS' ? 'LOSS' : g.result === 'PUSH' ? 'PUSH' : '', model_home_line: num(r.model_home_line), closing_home_line: c ? c.home_line : null, final_home_margin: c ? c.margin : null, quoted_line: num(r.quoted_line), packet: { game: { home: null, away: null }, confidence: { data: { missing: [] } }, analysis_summary: null } }; });
  const pm = PM.report(pmRows);
  const byVersion = {};
  rows.forEach((r) => { const k = r.model_version || 'unknown'; const e = (byVersion[k] = byVersion[k] || { packets: 0, tiers: {}, statuses: {} }); e.packets++; if (r.pricing_tier) e.tiers[r.pricing_tier] = (e.tiers[r.pricing_tier] || 0) + 1; if (r.quoted_status) e.statuses[r.quoted_status] = (e.statuses[r.quoted_status] || 0) + 1; });
  const v = validations || {};
  const tierOf = (j, m) => (j && j.markets && j.markets[m] ? j.markets[m].tier : null);
  return {
    schema: 'edgedesk_scorecard_v1', generated_at: opts.now || new Date().toISOString(),
    inputs: { rows: rows.length, rows_status: opts.rows_status || 'OK', rows_detail: opts.rows_detail || null, nfl_archive: archives.nfl ? { games: archives.nfl.counts.games, with_opener: archives.nfl.counts.with_opener || 0 } : null, cfb_archive: archives.cfb ? { games: archives.cfb.counts.games, with_open: archives.cfb.counts.with_open } : null },
    clv: { groups: clv.groups, sample_floor: clv.sample_floor, note: clv.note },
    postmortem: { counts: pm.counts, by_class: pm.groups.by_class, candidates: pm.candidates, note: pm.note },
    tiers: { pricing: { nfl: { spread: tierOf(v.pricing_nfl, 'spread'), total: tierOf(v.pricing_nfl, 'total'), moneyline: tierOf(v.pricing_nfl, 'moneyline'), generated_at: v.pricing_nfl ? v.pricing_nfl.generated_at : null }, cfb: { spread: tierOf(v.pricing_cfb, 'spread'), total: tierOf(v.pricing_cfb, 'total'), moneyline: tierOf(v.pricing_cfb, 'moneyline'), generated_at: v.pricing_cfb ? v.pricing_cfb.generated_at : null } },
      movement: { nfl: v.movement_nfl && v.movement_nfl.result ? { tier: v.movement_nfl.result.tier, basis: v.movement_nfl.result.tier_basis } : null, cfb: v.movement_cfb && v.movement_cfb.result ? { tier: v.movement_cfb.result.tier, required_gap_points: v.movement_cfb.result.required_gap_points, basis: v.movement_cfb.result.tier_basis } : null },
      features: v.features_nfl && v.features_nfl.arms ? { validated: [].concat(Object.values(v.features_nfl.arms.spread || {}), Object.values(v.features_nfl.arms.total || {})).filter((a) => a.status === 'VALIDATED').length, candidates: [].concat(Object.values(v.features_nfl.arms.spread || {}), Object.values(v.features_nfl.arms.total || {})).filter((a) => a.status === 'CANDIDATE').map((a) => a.label) } : null },
    by_model_version: byVersion,
    note: 'Produced unattended. Nothing here promotes a tier, a coefficient or a prompt; a candidate is a hypothesis with the held-out evaluation it must pass named beside it. A closing-line-value record is evidence about the pricing process; a win-loss record at these sizes is variance; neither is a claim of profit.',
  };
}

async function main() {
  const args = process.argv.slice(2);
  let rows = [], status = 'OK', detail = null;
  const rowsFile = args.includes('--rows') ? args[args.indexOf('--rows') + 1] : null;
  if (rowsFile) { const j = JSON.parse(fs.readFileSync(rowsFile, 'utf8')); rows = Array.isArray(j) ? j : j.rows || []; status = 'FILE'; detail = rowsFile; }
  else { const f = await fetchRows(process.env); rows = f.rows; status = f.status; detail = f.detail; }
  const archives = { nfl: readJson('football/pricing/lines_nfl.json'), cfb: readJson('football/pricing/lines_cfb.json') };
  const validations = { pricing_nfl: readJson('football/validation/pricing_nfl.json'), pricing_cfb: readJson('football/validation/pricing_cfb.json'), movement_nfl: readJson('football/validation/movement_nfl.json'), movement_cfb: readJson('football/validation/movement_cfb.json'), features_nfl: readJson('football/validation/feature-status-nfl.json') };
  const card = build(rows, archives, validations, { rows_status: status, rows_detail: detail });
  fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(card, null, 1));
  console.log(`scorecard: ${card.inputs.rows} packets (${status}${detail ? ': ' + detail : ''}); CLV all: ${JSON.stringify(card.clv.groups.all || null)}; postmortem ${JSON.stringify(card.postmortem.by_class)}; tiers ${JSON.stringify(card.tiers.pricing)} movement ${JSON.stringify(card.tiers.movement)}`);
  console.log('wrote ' + path.relative(ROOT, OUT));
}
module.exports = { build, closes, fetchRows, OUT };
if (require.main === module) main().catch((e) => { console.error(e.stack || e); process.exit(2); });
