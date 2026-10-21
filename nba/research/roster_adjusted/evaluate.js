#!/usr/bin/env node
'use strict';
/* ===========================================================================
   The NBA Roster-Adjusted Projection's validation report: the criteria
   registered in nba/research/roster_adjusted/registration.json, computed as
   registered, never re-chosen after a look.

     node nba/research/roster_adjusted/evaluate.js [--snapshots file.jsonl] [--now ISO]

   Snapshots come from public.nba_adjusted_projection_snapshots (EDGD_SB_URL +
   EDGD_SB_KEY, read-only; the table is public) or a JSONL export. The baseline
   is the ledger's last pregame row per game (nba/ledger/<season>.jsonl), the
   result the committed final (nba/data/games/<season>.csv).

   PAIRING (registered "unit"): a holdout regular-season game with a baseline
   ledger row before tip and an adjusted snapshot with status OK, computed
   before tip from an official report; each side's last pregame value.

   OUTPUT nba/research/roster_adjusted/report.json:
     DESCRIPTIVE   before the holdout ends, or below the minimum sample:
                   the numbers, and no pass/fail (nothing is decided early)
     FINAL         after the holdout, with the sample: every criterion's
                   value and verdict, passed = all of them. A criterion that
                   cannot be evaluated (no market captures for C3) is NOT met.
   It writes no registry row: a person reads the FINAL report, records the
   result in research_model_results, and promotes or does not.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('../../config');
const D = require('../../lib/data');
const K = require('../../injury/core');

const REG = JSON.parse(fs.readFileSync(path.join(__dirname, 'registration.json'), 'utf8'));
const OUT = path.join(__dirname, 'report.json');
function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; }
const r4 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 1e4) / 1e4);

/* a seeded generator, so the same data gives the same interval */
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
/** date-blocked bootstrap of a paired mean difference: resample whole dates (games on one night share news) */
function blockBootstrap(pairs, B, seed) {
  const byDate = new Map();
  for (const p of pairs) { if (!byDate.has(p.date)) byDate.set(p.date, []); byDate.get(p.date).push(p.d); }
  const blocks = [...byDate.values()], R = rng(seed || 20261021), means = [];
  if (!blocks.length) return null;
  for (let b = 0; b < (B || 2000); b++) {
    let s = 0, n = 0;
    for (let i = 0; i < blocks.length; i++) { const bl = blocks[Math.floor(R() * blocks.length)]; for (const d of bl) { s += d; n++; } }
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  const mean = pairs.reduce((a, p) => a + p.d, 0) / pairs.length;
  return { mean: r4(mean), lo95: r4(means[Math.floor(0.025 * means.length)]), hi95: r4(means[Math.ceil(0.975 * means.length) - 1]), dates: blocks.length, n: pairs.length };
}
const ll = (p, y) => { const q = Math.min(1 - 1e-6, Math.max(1e-6, p)); return -(y * Math.log(q) + (1 - y) * Math.log(1 - q)); };

/** pair the holdout's games (pure: tests call it) */
function pairUp(snaps, ledger, games, win) {
  const lastBefore = (rows, start, tKey) => rows.filter((r) => Date.parse(r[tKey]) < start).sort((a, b) => Date.parse(b[tKey]) - Date.parse(a[tKey]))[0] || null;
  const snapBy = new Map(), ledBy = new Map();
  for (const s of snaps) { if (!snapBy.has(String(s.game_id))) snapBy.set(String(s.game_id), []); snapBy.get(String(s.game_id)).push(s); }
  for (const l of ledger) { if (!ledBy.has(String(l.game_id))) ledBy.set(String(l.game_id), []); ledBy.get(String(l.game_id)).push(l); }
  const out = [], coverage = { holdout_games: 0, with_baseline: 0, adjusted_ok: 0, withheld: 0, fallback_only: 0, withheld_reasons: {} };
  for (const g of games) {
    const start = Date.parse(g.start_utc), date = K.nbaEtDate(start);
    if (g.type !== 'R' || g.status !== 'FINAL' || date < win[0] || date >= win[1]) continue;
    coverage.holdout_games++;
    const base = lastBefore(ledBy.get(String(g.game_id)) || [], start, 'recorded_at');
    if (!base) continue;
    coverage.with_baseline++;
    const all = (snapBy.get(String(g.game_id)) || []).filter((s) => Date.parse(s.computed_at) < start);
    const last = all.sort((a, b) => Date.parse(b.computed_at) - Date.parse(a.computed_at))[0] || null;
    if (!last) continue;
    if (last.status !== 'OK') { coverage.withheld++; for (const r of last.reasons || []) { const k = String(r).replace(/[A-Z]{2,4}(: | has)/, 'TEAM$1').slice(0, 80); coverage.withheld_reasons[k] = (coverage.withheld_reasons[k] || 0) + 1; } continue; }
    if (last.report_source !== 'nba_official') { coverage.fallback_only++; continue; }
    coverage.adjusted_ok++;
    const margin = g.hs - g.as, total = g.hs + g.as;
    out.push({ game_id: String(g.game_id), date, margin, total, home_won: margin > 0 ? 1 : 0,
      base: { m: base.exp_margin, t: base.exp_total, p: base.p_home }, adj: { m: last.adjusted.expected.margin, t: last.adjusted.expected.total, p: last.adjusted.p_home } });
  }
  return { pairs: out, coverage };
}
function evaluate(pairs, coverage, o) {
  const now = o.now, holdoutEnd = Date.parse(REG.machine.window_dates.holdout[1] + 'T12:00:00Z');
  const min = REG.machine.minimum_sample, n = pairs.length;
  const mae = (k, side) => pairs.reduce((a, p) => a + Math.abs(p[side][k] - (k === 'm' ? p.margin : p.total)), 0) / Math.max(1, n);
  const diff = (k) => blockBootstrap(pairs.map((p) => ({ date: p.date, d: Math.abs(p.adj[k] - (k === 'm' ? p.margin : p.total)) - Math.abs(p.base[k] - (k === 'm' ? p.margin : p.total)) })), 2000, 20261021);
  const llB = pairs.reduce((a, p) => a + ll(p.base.p, p.home_won), 0) / Math.max(1, n), llA = pairs.reduce((a, p) => a + ll(p.adj.p, p.home_won), 0) / Math.max(1, n);
  const dm = n ? diff('m') : null, dt = n ? diff('t') : null;
  const cov = coverage.with_baseline ? (coverage.adjusted_ok + coverage.fallback_only) / coverage.with_baseline : null;
  const crit = {
    C1_MARGIN_MAE: { baseline: r4(mae('m', 'base')), adjusted: r4(mae('m', 'adj')), paired_difference: dm, met: !!(dm && dm.mean < 0 && dm.hi95 < 0) },
    C2_TOTAL_MAE: { baseline: r4(mae('t', 'base')), adjusted: r4(mae('t', 'adj')), paired_difference: dt, met: !!(dt && dt.mean < 0 && dt.hi95 < 0) },
    C3_CLV: { evaluable: false, met: false, why: 'NOT EVALUABLE: EdgeDesk captures no NBA prices (repository variable NBA_PRICES off), so no detection-time market line or closing line exists for these games. Registered: a criterion that cannot be evaluated is not met.' },
    C4_CALIBRATION_GUARD: { baseline_log_loss: r4(llB), adjusted_log_loss: r4(llA), difference: r4(llA - llB), met: n > 0 && llA - llB <= 0.005 },
    C5_COVERAGE_GUARD: { share_published: r4(cov), met: cov != null && cov >= 0.8 }
  };
  const final = now >= holdoutEnd && n >= min;
  return {
    schema: 'edgedesk_nba_roster_adjusted_report_v1', model_key: REG.model_key, version: REG.version, generated_at: new Date(now).toISOString(),
    holdout: REG.machine.window_dates.holdout, minimum_sample: min, n_paired: n, coverage,
    state: final ? 'FINAL' : 'DESCRIPTIVE',
    state_reason: final ? 'the holdout has ended and the minimum sample is met' : (now < holdoutEnd ? 'the holdout runs until ' + REG.machine.window_dates.holdout[1] + ': nothing is decided before then' : 'below the registered minimum sample (' + n + ' of ' + min + ')'),
    criteria: crit, passed: final ? Object.values(crit).every((c) => c.met) : null,
    note: 'Computed exactly as registered (nba/research/roster_adjusted/registration.json). A DESCRIPTIVE report decides nothing; no criterion was re-chosen after looking.'
  };
}

async function snapshotsFrom() {
  const file = arg('snapshots', null);
  if (file) return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const url = process.env.EDGD_SB_URL, key = process.env.EDGD_SB_KEY || process.env.EDGD_SB_SERVICE;
  if (!url || !key) throw new Error('give --snapshots file.jsonl, or EDGD_SB_URL and EDGD_SB_KEY to read public.nba_adjusted_projection_snapshots');
  const out = [];
  for (let off = 0; ; off += 1000) {
    const q = url.replace(/\/$/, '') + '/rest/v1/nba_adjusted_projection_snapshots?select=game_id,game_start_utc,computed_at,status,reasons,report_source,adjusted,model_key,model_version'
      + '&model_key=eq.' + REG.model_key + '&model_version=eq.' + REG.version + '&order=id.asc&limit=1000&offset=' + off;
    const r = await fetch(q, { headers: { apikey: key, authorization: 'Bearer ' + key } });
    if (!r.ok) throw new Error('snapshots answered HTTP ' + r.status);
    const rows = await r.json(); out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}
async function run() {
  const now = arg('now', null) ? Date.parse(arg('now')) : Date.now();
  const season = C.currentSeason(Date.parse(REG.machine.window_dates.holdout[0] + 'T12:00:00Z'));
  const snaps = await snapshotsFrom();
  const ledFile = path.join(C.PATHS.ledger, season + '.jsonl');
  const ledger = fs.existsSync(ledFile) ? fs.readFileSync(ledFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const games = D.games([season]).map((g) => Object.assign({}, g, { start_utc: g.start_utc, type: g.type }));
  const { pairs, coverage } = pairUp(snaps, ledger, games, REG.machine.window_dates.holdout);
  const rep = evaluate(pairs, coverage, { now });
  fs.writeFileSync(OUT, JSON.stringify(rep, null, 1) + '\n');
  console.log('[roster-adjusted report] ' + rep.state + ': ' + rep.n_paired + ' paired games; ' + rep.state_reason + (rep.passed != null ? '; passed = ' + rep.passed : ''));
}
module.exports = { blockBootstrap, pairUp, evaluate };
if (require.main === module) run().catch((e) => { console.error('[roster-adjusted report] ' + (e && e.message || e)); process.exit(1); });
