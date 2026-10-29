#!/usr/bin/env node
/* ============================================================================
   FSIE — insert-only copy of the committed artifacts into Supabase
   (supabase/football_situational.sql). Idempotent: every table has a unique
   key and the insert asks PostgREST to ignore duplicates, so a re-run adds
   only what is new and never overwrites (the write-once tables would refuse).

     node football/situational/sync_supabase.js [--season Y] [--dry-run]

   Credentials: SB_URL + SB_SERVICE_ROLE (the repository's secrets; EDGD_SB_URL
   / EDGD_SB_SERVICE also read). Without them the run prints NOT VERIFIED and
   exits 0 — nothing was synced, and it says so rather than claiming it was.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const U = require('./core/util.js');
const A = require('./adapter.js');

const DIR = __dirname;
const DATA = path.join(DIR, 'data');
const ROOT = path.join(DIR, '..', '..');

/* each table's natural key, sent as ?on_conflict= so PostgREST's ignore-duplicates
   becomes ON CONFLICT (key) DO NOTHING; without it PostgREST targets the primary key
   only, and fsie_team_games has none (its key is a UNIQUE constraint) */
const CONFLICT = {
  fsie_source_files: 'sport,source_name,sha256', fsie_team_games: 'sport,game_id,team_id,source_ref',
  fsie_quality_failures: 'sport,game_id,team_id,scope,check_name,source_ref', fsie_coverage: 'run_id,sport,team_id',
  fsie_tendencies: 'sport,season,team_id,side,as_of,features_version', fsie_team_projections: 'projection_id',
  fsie_player_projections: 'projection_id', fsie_prop_comparisons: 'comparison_id', fsie_clv_evaluations: 'clv_id',
  fsie_shadow_integrations: 'sport,game_id,target,model_version,as_of', fsie_pipeline_runs: 'run_id,sport,stage'
};

function arg(k, d) { const i = process.argv.indexOf('--' + k); return i >= 0 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : d; }
function jsonl(f) { if (!fs.existsSync(f)) return []; return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
function id(o) { return U.sha256(o).slice(0, 32); }

function rows(season) {
  const out = { fsie_source_files: [], fsie_team_games: [], fsie_quality_failures: [], fsie_coverage: [], fsie_tendencies: [], fsie_team_projections: [], fsie_player_projections: [], fsie_prop_comparisons: [], fsie_clv_evaluations: [], fsie_shadow_integrations: [], fsie_pipeline_runs: [] };
  const cov = U.readJson(path.join(DATA, 'coverage.json'));
  const state = U.readJson(path.join(DATA, 'state.json'));
  const runId = state && state.last ? state.last.run_id : 'unknown';
  ['nfl', 'cfb'].forEach((sp) => {
    const sd = path.join(DATA, sp, String(season));
    const obs = U.readJson(path.join(sd, 'observations.json'));
    if (obs) {
      (obs.sources || []).forEach((s) => { if (s && s.sha256 && s.pulled_at) out.fsie_source_files.push({ sport: sp, season, source_name: s.name, url: s.url, sha256: s.sha256, bytes: s.bytes || null, last_modified: s.last_modified || null, pulled_at: s.pulled_at }); });
      const src = (obs.sources || []).find((s) => /play_by_play|espn_cfb_pbp/.test(s.name)) || {};
      obs.team_games.forEach((r) => {
        const g = obs.games[r.game_id] || {};
        out.fsie_team_games.push({ sport: sp, season, week: r.week, season_type: r.season_type, game_id: r.game_id, team_id: r.team, opponent_id: r.opp, is_home: r.is_home, kickoff_at: r.kickoff_at,
          source_name: src.name || 'play-by-play', source_ref: r.src, source_sha256: src.sha256 || null, pulled_at: src.pulled_at || null, available_at: src.last_modified ? new Date(src.last_modified).toISOString() : null,
          situations_version: obs.situations_version, quality_version: obs.quality_version, fingerprint: g.fingerprint || null,
          volume_ok: !!r.quality.volume_ok, situation_ok: !!r.quality.situation_ok, player_ok: !!r.quality.player_ok, quality_status: g.status || (r.quality.volume_ok ? 'accepted' : 'rejected'),
          rejection_reasons: (g.reasons || []).concat(r.quality.reasons || []), warnings: (g.warnings || []).concat(r.quality.warnings || []), counts: r.counts, market: r.market });
        (r.quality.reasons || []).forEach((reason) => out.fsie_quality_failures.push({ sport: sp, season, game_id: r.game_id, team_id: r.team, scope: 'team', check_name: reason.split(':')[0], detail: reason, source_ref: r.src, run_id: runId }));
      });
      Object.values(obs.games || {}).forEach((g) => (g.reasons || []).forEach((reason) => out.fsie_quality_failures.push({ sport: sp, season, game_id: g.game_id, team_id: '', scope: 'game', check_name: reason.split(':')[0], detail: reason, source_ref: obs.source_ref, run_id: runId })));
    }
    const c = cov && cov.sports && cov.sports[sp];
    if (c) c.teams.forEach((t) => out.fsie_coverage.push({ run_id: runId, sport: sp, season, team_id: t.team, team_name: t.name, conference: t.conference, division: t.division, tier: t.tier,
      games_expected: t.games_expected, games_available: t.games_available, games_accepted: t.games_accepted, games_rejected: t.games_rejected, formation_observed_share: t.formation_observed_share,
      last_game_at: t.last_game_at, missing_fields: t.missing_fields, built_at: c.built_at }));
    const ten = U.readJson(path.join(sd, 'tendencies.json'));
    if (ten) Object.keys(ten.teams).forEach((t) => ['offense', 'defense'].forEach((side) => out.fsie_tendencies.push({ sport: sp, season, team_id: t, side, as_of: ten.built_at, features_version: ten.features_version, situations_version: 'situations_v1',
      metrics: ten.teams[t][side], sample: ten.teams[t].meta })));
    jsonl(path.join(sd, 'projections.jsonl')).forEach((p) => out.fsie_team_projections.push({ projection_id: id([sp, p.game_id, p.team, p.model_version, p.as_of]), sport: sp, season: p.season, week: p.week, game_id: p.game_id, team_id: p.team, opponent_id: p.opp,
      model_key: p.model_key, model_version: p.model_version, as_of: p.as_of, kickoff_at: p.kickoff_at, point: p.point, p10: p.p10, p50: p.p50, p90: p.p90, script: p.script, inputs_sha256: p.inputs_sha256, data_quality: p.data_quality, missing_reasons: p.missing_reasons || [] }));
    jsonl(path.join(sd, 'player_projections.jsonl')).forEach((p) => Object.keys(p.markets || {}).forEach((m) => { const x = p.markets[m]; out.fsie_player_projections.push({ projection_id: id([sp, p.game_id, p.player_id, m, p.model_version, p.as_of]), sport: sp, game_id: p.game_id, team_id: p.team,
      player_id: p.player_id, player_name: p.player_name, role: p.role, market: m, model_version: p.model_version, as_of: p.as_of, kickoff_at: p.kickoff_at, mean: x.mean, p10: x.p10, p50: x.p50, p90: x.p90, availability: p.availability ? p.availability.status : null }); }));
    jsonl(path.join(sd, 'comparisons.jsonl')).forEach((c2) => out.fsie_prop_comparisons.push({ comparison_id: id([sp, c2.game_id, c2.player_id, c2.market, c2.model_version, c2.market_at, c2.market_line]), sport: sp, game_id: c2.game_id, event_id: c2.event_id, player_id: c2.player_id, player_name: c2.player_name,
      market: c2.market, model_version: c2.model_version, model_as_of: c2.model_as_of, model_median: c2.model_median, model_p10: c2.model_p10, model_p90: c2.model_p90, market_line: c2.market_line, market_over: c2.market_over, market_under: c2.market_under,
      market_books: c2.market_books, market_at: c2.market_at, difference: c2.difference, p_over: c2.p_over_research, label: c2.label, data_quality: c2.data_quality }));
    const st = U.readJson(path.join(DATA, 'market', sp + '_' + season + '_study.json'));
    if (st) st.rows.filter((r) => r.direction).forEach((r) => {
      const cid = id([sp, r.game_id, r.player_id, r.market, r.model_version, r.market_at, r.market_line]);
      out.fsie_prop_comparisons.push({ comparison_id: cid, sport: sp, game_id: r.game_id, event_id: r.event_id, player_id: r.player_id, player_name: r.player_name, market: r.market, model_version: r.model_version, model_as_of: r.model_as_of,
        model_median: r.model_median, model_p10: r.model_p10, model_p90: r.model_p90, market_line: r.market_line, market_over: r.market_over, market_under: r.market_under, market_books: r.market_books, market_at: r.market_at, difference: r.difference, p_over: r.p_over_research, label: r.label, data_quality: r.data_quality });
      const c3 = r.clv || {};
      out.fsie_clv_evaluations.push({ clv_id: id(['clv', cid, r.direction]), comparison_id: cid, sport: sp, game_id: r.game_id, player_id: r.player_id, market: r.market, direction: r.direction, entry_line: r.market_line, entry_price: r.direction === 'over' ? r.market_over : r.market_under,
        entry_at: r.entry_at, model_as_of: r.model_as_of, close_available: !!c3.available, close_line: c3.close_line == null ? null : c3.close_line, close_price: c3.close_price == null ? null : c3.close_price, close_at: c3.close_at || null,
        line_clv: c3.line_clv == null ? null : c3.line_clv, price_clv_cents: c3.price_clv_cents == null ? null : c3.price_clv_cents, prob_clv_pp: c3.prob_clv_pp == null ? null : c3.prob_clv_pp, beat_close: c3.beat_close == null ? null : c3.beat_close,
        exclusion_reason: c3.available ? null : (c3.exclusion || 'no close'), outcome_value: r.actual == null ? null : r.actual, outcome_result: r.outcome || null });
    });
    const sh = U.readJson(path.join(DATA, 'shadow', sp + '.json'));
    const slate = U.readJson(path.join(ROOT, 'football', sp === 'nfl' ? 'nfl' : 'fbs', 'slate.json'));
    const existing = {}, cand = {}; ((slate && slate.games) || []).forEach((g) => {
      existing[String(g.game_id)] = { fair_total: g.model_fair_total, home_margin: g.model_home_margin, model_version: g.model_version };
      /* the candidate the slate's own block published (what ACTIVE would change), once a build has appended it */
      const blk = g.situational || g.situational_shadow; if (blk && blk.candidate) cand[String(g.game_id)] = blk.candidate;
    });
    const target = sp === 'nfl' ? 'nfl_slate' : 'fbs_slate';
    if (sh) Object.keys(sh.games).forEach((gid) => { if (!existing[gid]) return; const g = sh.games[gid]; out.fsie_shadow_integrations.push({ sport: sp, game_id: gid, target, mode: A.mode(target), model_version: sh.model_version || 'unknown', as_of: g.as_of, existing: existing[gid], situational: g, candidate: cand[gid] || null, applied_points: 0 }); });
  });
  if (state && state.runs) state.runs.forEach((r) => Object.keys(r.stages || {}).forEach((sp) => { const s = r.stages[sp]; out.fsie_pipeline_runs.push({ run_id: r.run_id, sport: sp, stage: 'build', started_at: r.started_at, duration_ms: (s.ms || {}).total || null, status: r.status === 'ok' ? 'ok' : r.status, rows_out: s.projections || 0, errors: r.errors || [], freshness: null }); }));
  return out;
}

async function post(cfg, table, list) {
  let n = 0;
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    const r = await fetch(cfg.url.replace(/\/+$/, '') + '/rest/v1/' + table + '?on_conflict=' + CONFLICT[table], { method: 'POST', headers: { apikey: cfg.key, authorization: 'Bearer ' + cfg.key, 'content-type': 'application/json', prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(chunk) });
    if (!r.ok) throw new Error(table + ': HTTP ' + r.status + ' ' + (await r.text()).slice(0, 300));
    n += chunk.length;
  }
  return n;
}

async function main() {
  const season = +arg('season', new Date().getUTCMonth() <= 1 ? new Date().getUTCFullYear() - 1 : new Date().getUTCFullYear());
  const R = rows(season);
  const counts = {}; Object.keys(R).forEach((k) => { counts[k] = R[k].length; });
  const cfg = { url: process.env.SB_URL || process.env.EDGD_SB_URL || '', key: process.env.SB_SERVICE_ROLE || process.env.EDGD_SB_SERVICE || '' };
  if (arg('dry-run', false)) { console.log(JSON.stringify({ dry_run: true, season, rows: counts })); return 0; }
  if (!cfg.url || !cfg.key) { console.log('NOT VERIFIED: no Supabase credentials (SB_URL / SB_SERVICE_ROLE); nothing was synced. Rows that would be offered: ' + JSON.stringify(counts)); return 0; }
  const done = {};
  for (const t of Object.keys(R)) done[t] = await post(cfg, t, R[t]);
  console.log(JSON.stringify({ synced: done }));
  return 0;
}
if (require.main === module) main().then((c) => { process.exitCode = c; }, (e) => { console.error(String(e && e.stack || e)); process.exitCode = 1; });
module.exports = { rows, CONFLICT };
