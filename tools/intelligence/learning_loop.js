#!/usr/bin/env node
/* ============================================================================
   THE LEARNING LOOP — nightly, unattended, and unable to promote anything.

   1. Reads the desk's quoted prices: the research_packet_pricing view from
      Supabase when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set (names
      only; never written here), or a JSON export passed as --rows.
   2. Joins each packet to the closing-line archives by game id (NFL: the
      archive and the opener ledger; CFB: the archive), so every quoted line
      has its close, its result and, where captured, its opener.
   3. Reads the sizing engine's own trail: the stake_recommendation_grades
      view, which carries every position EdgeDesk sized beside the profit a
      flat 0.5u and a flat 1u would have returned on the same selections at
      the same prices. A sizing engine that does not beat flat staking on its
      own card has added nothing, so that comparison is published rather than
      left for someone to run by hand.
   4. Runs the closing-line-value scorecard (tools/intelligence/clv.js) and
      the postmortem (tools/intelligence/postmortem.js) over the graded rows,
      and reads the pricing, movement and feature validations for drift.
   5. Writes football/validation/scorecard.json: counts, CLV by tier and
      status, open-to-close movement toward the fair line, postmortem
      classes and candidates, the staking scorecard and its pass ledger,
      tiers by model version, and the status of every input, so the desk and
      a reviewer see the same record.

   Nothing here changes a tier, a coefficient or a prompt. A candidate stays
   a hypothesis with the held-out evaluation it must pass named beside it.

   Usage
     node tools/intelligence/learning_loop.js                 # Supabase (env) or nothing
     node tools/intelligence/learning_loop.js --rows rows.json
     node tools/intelligence/learning_loop.js --rows rows.json --stakes stakes.json
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const CLV = require(path.join(__dirname, 'clv.js'));
const PM = require(path.join(__dirname, 'postmortem.js'));
const SG = require(path.join(__dirname, 'stake_grades.js'));
const { writeIfChanged } = require(path.join(ROOT, 'tools', 'football', 'write_if_changed.js'));
const OUT = path.join(ROOT, 'football', 'validation', 'scorecard.json');

function readJson(rel) { try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); } catch (_) { return null; } }
function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function r3(v) { return v == null ? null : Math.round(v * 1000) / 1000; }

/** Fetch one view through PostgREST with the service role. Returns {rows, status}. */
async function fetchView(env, view, order, fetchImpl, flag) {
  const url = env.SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { rows: [], status: 'NO_DATABASE_ACCESS', detail: 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not set; pass ' + flag + ' <file> for an export' };
  try {
    const r = await (fetchImpl || fetch)(url.replace(/\/$/, '') + '/rest/v1/' + view + '?select=*&order=' + order + '.desc&limit=5000', { headers: { apikey: key, authorization: 'Bearer ' + key, accept: 'application/json' } });
    /* A view that has not been migrated yet is a MISSING INPUT, not a failure
       of the loop: the rest of the scorecard is still worth writing, and the
       status says plainly which piece is absent. */
    if (r.status === 404) return { rows: [], status: 'VIEW_NOT_FOUND', detail: view + ' does not exist on this database; run supabase/bankroll_and_stakes.sql' };
    if (!r.ok) return { rows: [], status: 'DATABASE_ERROR', detail: 'HTTP ' + r.status + ' on ' + view };
    const rows = await r.json(); return { rows: Array.isArray(rows) ? rows : [], status: 'OK', detail: null };
  } catch (e) { return { rows: [], status: 'DATABASE_ERROR', detail: String(e && e.message || e) }; }
}

async function fetchRows(env, fetchImpl) { return fetchView(env, 'research_packet_pricing', 'built_at', fetchImpl, '--rows'); }
async function fetchStakes(env, fetchImpl) { return fetchView(env, 'stake_recommendation_grades', 'built_at', fetchImpl, '--stakes'); }

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
  const stakes = SG.report(opts.stake_rows || [], { now: opts.now, status: opts.stake_status || 'OK', detail: opts.stake_detail || null });
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
    inputs: { rows: rows.length, rows_status: opts.rows_status || 'OK', rows_detail: opts.rows_detail || null, stake_rows: stakes.rows, stake_rows_status: opts.stake_status || 'OK', stake_rows_detail: opts.stake_detail || null, nfl_archive: archives.nfl ? { games: archives.nfl.counts.games, with_opener: archives.nfl.counts.with_opener || 0 } : null, cfb_archive: archives.cfb ? { games: archives.cfb.counts.games, with_open: archives.cfb.counts.with_open } : null },
    clv: { groups: clv.groups, sample_floor: clv.sample_floor, note: clv.note },
    staking: stakes,
    postmortem: { counts: pm.counts, by_class: pm.groups.by_class, candidates: pm.candidates, note: pm.note },
    tiers: { pricing: { nfl: { spread: tierOf(v.pricing_nfl, 'spread'), total: tierOf(v.pricing_nfl, 'total'), moneyline: tierOf(v.pricing_nfl, 'moneyline'), generated_at: v.pricing_nfl ? v.pricing_nfl.generated_at : null }, cfb: { spread: tierOf(v.pricing_cfb, 'spread'), total: tierOf(v.pricing_cfb, 'total'), moneyline: tierOf(v.pricing_cfb, 'moneyline'), generated_at: v.pricing_cfb ? v.pricing_cfb.generated_at : null } },
      movement: { nfl: v.movement_nfl && v.movement_nfl.result ? { tier: v.movement_nfl.result.tier, basis: v.movement_nfl.result.tier_basis } : null, cfb: v.movement_cfb && v.movement_cfb.result ? { tier: v.movement_cfb.result.tier, required_gap_points: v.movement_cfb.result.required_gap_points, basis: v.movement_cfb.result.tier_basis } : null },
      /* the markets the staking kernel refuses to size, and what would open
         them: an empty `open` list is the expected state and a result */
      extra_markets: v.markets_extra
        ? { open: (v.markets_extra.markets || []).map((m) => m.sport + '|' + m.market + ' ' + m.tier), refused: (v.markets_extra.refused || []).map((r) => ({ market: r.sport + '|' + r.market, why: r.why })), generated_at: v.markets_extra.generated_at }
        : null,
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
  let stakeRows = [], stakeStatus = 'OK', stakeDetail = null;
  const stakesFile = args.includes('--stakes') ? args[args.indexOf('--stakes') + 1] : null;
  if (stakesFile) { const j = JSON.parse(fs.readFileSync(stakesFile, 'utf8')); stakeRows = Array.isArray(j) ? j : j.rows || []; stakeStatus = 'FILE'; stakeDetail = stakesFile; }
  else { const f = await fetchStakes(process.env); stakeRows = f.rows; stakeStatus = f.status; stakeDetail = f.detail; }
  const archives = { nfl: readJson('football/pricing/lines_nfl.json'), cfb: readJson('football/pricing/lines_cfb.json') };
  const validations = { pricing_nfl: readJson('football/validation/pricing_nfl.json'), pricing_cfb: readJson('football/validation/pricing_cfb.json'), movement_nfl: readJson('football/validation/movement_nfl.json'), movement_cfb: readJson('football/validation/movement_cfb.json'), features_nfl: readJson('football/validation/feature-status-nfl.json'), markets_extra: readJson('football/validation/markets_extra.json') };
  const card = build(rows, archives, validations, { rows_status: status, rows_detail: detail, stake_rows: stakeRows, stake_status: stakeStatus, stake_detail: stakeDetail });
  const w = writeIfChanged(OUT, card, { pretty: true });
  console.log(`scorecard: ${card.inputs.rows} packets (${status}${detail ? ': ' + detail : ''}); CLV all: ${JSON.stringify(card.clv.groups.all || null)}; postmortem ${JSON.stringify(card.postmortem.by_class)}; tiers ${JSON.stringify(card.tiers.pricing)} movement ${JSON.stringify(card.tiers.movement)}`);
  const sk = card.staking.groups.all;
  console.log(`staking: ${card.staking.sized} sized (${stakeStatus}${stakeDetail ? ': ' + stakeDetail : ''}); ${sk ? sk.reading : 'nothing sized yet, so there is nothing to grade'}`);
  const gates = Object.keys(card.staking.passes).sort((a, b) => card.staking.passes[b].passes - card.staking.passes[a].passes).slice(0, 4);
  if (gates.length) console.log('  passes by gate: ' + gates.map((g) => g + ' ' + card.staking.passes[g].passes).join(', '));
  console.log(w + ' ' + path.relative(ROOT, OUT));
}
module.exports = { build, closes, fetchRows, fetchStakes, fetchView, OUT };
if (require.main === module) main().catch((e) => { console.error(e.stack || e); process.exit(2); });
