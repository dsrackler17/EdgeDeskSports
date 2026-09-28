/* ============================================================================
   EdgeDesk CFB — THE CHAMPION FREEZE and the version log.

   A model version string is not a version. edgedesk_cfb_p4_v1.0.0 has been
   carried by several different engines (the efficiency replay, the canonical
   rating wiring, the integrity gate all changed code under the same string),
   so "since the upgrade" cannot be keyed on the string. It is keyed on what
   actually runs:

     PRICING path    the files that can move a published fair spread
     RESEARCH path   the files that decide a research label (the gate, the canon)
     DECISION path   the files that decide BET / PASS

   champion.json    FROZEN once (--init). Names the champion, the release,
                    the effective instant and the three fingerprints. Never
                    rewritten: the build refuses to.
   versions.jsonl   APPEND-ONLY. The first row is the release. Whenever a
                    path's fingerprint differs from the latest row of its kind,
                    the build appends a PATCH row (auto-detected, with the
                    changed files) effective from that build. A LIVE prediction
                    is attributed to the version in force at its timestamp.
                    Historical predictions are never altered: a patch only
                    moves the boundary for rows written after it.

     node football/cfb_validation/freeze.js --init --effective-at 2026-09-28T00:00:00.000Z
     node football/cfb_validation/freeze.js --status
   ============================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const CHAMPION = path.join(__dirname, 'champion.json');
const VERSIONS = path.join(__dirname, 'versions.jsonl');
const PLAN = path.join(__dirname, 'next100_plan.json');

const PATHS = {
  PRICING: ['football/cfb_p4/engine.js', 'football/cfb_p4/params.js', 'football/fbs/build_coverage.js', 'football/fbs/fbs.js',
    'football/matchup/inputs.js', 'football/rankings/engine_efficiency.js'],
  RESEARCH: ['lib/cfb_disagreement.js', 'football/cfb_p4/disagreement_params.js', 'lib/edgedesk_canon.js', 'lib/cfb_terminal.js', 'lib/cfb_research_view.js'],
  DECISION: ['football/cfb_decision/decision.js', 'football/cfb_v2/artifacts/decision/cfb_decision_policy_v1/policy.json',
    'football/cfb_v2/artifacts/decision/cfb_decision_calibration_v1/calibration.json']
};

function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
/* line endings normalised, so a checkout on another OS fingerprints the same */
function fileHash(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return null;
  return sha(fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')).slice(0, 16);
}
function fingerprint(kind) {
  const files = {};
  PATHS[kind].forEach((f) => { files[f] = fileHash(f); });
  return { kind, sha: sha(JSON.stringify(files)).slice(0, 16), files };
}
function readJsonl(f) {
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}
function load() {
  const champion = fs.existsSync(CHAMPION) ? JSON.parse(fs.readFileSync(CHAMPION, 'utf8')) : null;
  return { champion, versions: readJsonl(VERSIONS), plan: fs.existsSync(PLAN) ? JSON.parse(fs.readFileSync(PLAN, 'utf8')) : null };
}
/* the latest version row of each kind, and the rows a build would append */
function drift(versions, now) {
  const out = [];
  ['PRICING', 'RESEARCH', 'DECISION'].forEach((kind) => {
    const rows = versions.filter((v) => v.kind === kind);
    const last = rows[rows.length - 1];
    const fp = fingerprint(kind);
    if (!last) return;
    if (last.fingerprint === fp.sha) return;
    const changed = Object.keys(fp.files).filter((f) => (last.files || {})[f] !== fp.files[f]);
    const n = rows.filter((v) => v.event === 'PATCH').length + 1;
    out.push({ event: 'PATCH', kind, version: last.base_version + '+' + kind.charAt(0).toLowerCase() + n, base_version: last.base_version,
      effective_at: now, fingerprint: fp.sha, files: fp.files, changed_files: changed,
      reason: 'the ' + kind.toLowerCase() + ' path changed (auto-detected by football/cfb_validation/build.js): ' + changed.join(', '),
      supersedes: last.version, historical_rows_altered: false });
  });
  return out;
}

function init(effectiveAt, now) {
  if (fs.existsSync(CHAMPION)) { console.error('champion.json already exists and is frozen; nothing written'); process.exit(1); }
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'cfb_production', 'manifest.json'), 'utf8'));
  const roles = readJsonl(path.join(ROOT, 'football', 'cfb_lab', 'governance', 'model_roles.jsonl'));
  const champRole = roles.filter((r) => r.role === 'champion').pop();
  const fps = { PRICING: fingerprint('PRICING'), RESEARCH: fingerprint('RESEARCH'), DECISION: fingerprint('DECISION') };
  const release = 'edgedesk_cfb_r1';
  const champion = {
    schema: 'edgedesk_cfb_champion_freeze_v1', release_id: release, label: 'EdgeDesk CFB production system R1',
    frozen_at: now, effective_at: effectiveAt,
    champion: { model_version: champRole.model_version, label: champRole.model_label, governance_event: champRole.event_id },
    challenger_shadow: roles.filter((r) => r.role === 'challenger').map((r) => r.model_version),
    decision_policy: (man.decision_policy && man.decision_policy.dir) || 'cfb_decision_policy_v1',
    decision_calibration: (man.decision_calibration && man.decision_calibration.version) || 'cfb_decision_calibration_v1',
    manifest_id: man.manifest_id || man.id || null,
    fingerprints: { PRICING: fps.PRICING.sha, RESEARCH: fps.RESEARCH.sha, DECISION: fps.DECISION.sha },
    paths: PATHS,
    epochs: {
      CURRENT: 'LIVE Model Lab snapshots of the champion taken at or after effective_at, attributed to R1 or a declared patch of it',
      PRE_FREEZE: 'LIVE snapshots taken before effective_at (the pricing path changed several times that day)',
      LEGACY: 'Model Lab GIT_RECONSTRUCTED and REPLAY rows, and the public record’s board numbers (record/football/cfb_<season>.json) — kept, never erased, never blended into CURRENT'
    },
    rules: [
      'This file is written once and never rewritten.',
      'A change to any file in a path appends a PATCH row to versions.jsonl, effective from the build that saw it. No historical prediction is altered.',
      'A model change reaches production only through RESEARCH → CHALLENGER → WALK-FORWARD → SHADOW → PROMOTION (football/cfb_lab/governance.js promote). A weekly loss is never a reason.'
    ]
  };
  fs.writeFileSync(CHAMPION, JSON.stringify(champion, null, 1) + '\n');
  const rows = ['PRICING', 'RESEARCH', 'DECISION'].map((kind) => ({ event: 'RELEASE', kind, version: release + (kind === 'PRICING' ? '' : '.' + kind.toLowerCase()),
    base_version: release + (kind === 'PRICING' ? '' : '.' + kind.toLowerCase()), effective_at: effectiveAt, fingerprint: fps[kind].sha, files: fps[kind].files,
    reason: 'the champion freeze', recorded_at: now }));
  fs.writeFileSync(VERSIONS, rows.map((x) => JSON.stringify(x)).join('\n') + '\n');
  return champion;
}

/* THE NEXT 100 LIVE GAMES — what will be monitored, and the baselines it will
   be compared with, frozen BEFORE the first game is graded. Nothing here is a
   target to tune toward: it is the pre-registration. */
function initPlan(champion, now) {
  if (fs.existsSync(PLAN)) { console.error('next100_plan.json already exists and is frozen; nothing written'); return null; }
  const V = require('./core.js');
  const REPORT = require('../cfb_lab/report.js');
  const G = require('../cfb_lab/ledger.js');
  const season = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'cfb_lab', 'config.json'), 'utf8')).season;
  const D = REPORT.load(new G.Store(season));
  const views = V.views(D, champion, [], {}, season);
  const leg = views.find((v) => v.id === 'LEGACY');
  const forensics = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'validation', 'disagreement', 'forensics_cfb.json'), 'utf8'));
  const gh = forensics.gate_backtest.holdout_football_only;
  const params = (() => { global.window = global.window || global; require(path.join(ROOT, 'football', 'cfb_p4', 'params.js')); return global.EDCfbP4Params; })();
  const ref = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'cfb_lab', 'config.json'), 'utf8')).reference[champion.champion.model_version] || {};
  const b = (value, source, n) => ({ value: value == null ? null : value, n: n == null ? null : n, source });
  const plan = {
    schema: 'edgedesk_cfb_next100_plan_v1', plan_id: 'next100_' + champion.release_id, frozen_at: now, release: champion.release_id,
    population: 'the first 100 settled LIVE OFFICIAL (T24) snapshots of ' + champion.champion.model_version + ' taken at or after ' + champion.effective_at,
    rule: 'Do not change the model to hit any number below. Do not retrofit: a bug fix is a declared patch (versions.jsonl) and no historical prediction is altered. At 100 settled games the current champion is compared with the legacy system on these same definitions.',
    metrics: [
      { id: 'margin_mae', label: 'margin MAE (pts)', better_if: 'lower', section: 'FOOTBALL MODEL' },
      { id: 'calibration_error', label: 'win-probability calibration error (ECE)', better_if: 'lower', section: 'FOOTBALL MODEL' },
      { id: 'interval_coverage_80', label: '80% interval coverage', better_if: 'closer to 0.80', section: 'FOOTBALL MODEL' },
      { id: 'market_moved_toward_pct', label: 'market moved toward EdgeDesk (% of moved lines)', better_if: 'higher', section: 'MARKET INTELLIGENCE' },
      { id: 'average_clv', label: 'average CLV (pts)', better_if: 'higher', section: 'MARKET INTELLIGENCE' },
      { id: 'false_major_rate', label: 'false-major-disagreement rate (% of VERIFIED that were false extremes)', better_if: 'lower', section: 'RESEARCH GATE' },
      { id: 'decision_selectivity', label: 'decision selectivity (% of games with a qualified wager)', better_if: 'reported, not optimised', section: 'BETTING DECISIONS' }
    ],
    baselines: {
      margin_mae: b(leg.football_model.mae, 'LEGACY view: the champion’s reconstructed 2026 numbers, last pre-kickoff per game (Model Lab GIT_RECONSTRUCTED)', leg.football_model.n),
      margin_mae_holdout: b(ref.mae, 'pre-registered holdout reference, 2024–2025 (football/cfb_lab/config.json)', 1604),
      margin_mae_backtest_2022_2025: b(params.validation_summary && params.validation_summary.market ? params.validation_summary.market.spread_mae_model : null, 'walk-forward 2022–2025, spread MAE of the published fair (EDCfbP4Params.validation_summary.market)', params.validation_summary && params.validation_summary.market ? params.validation_summary.market.n_games : null),
      calibration_error: b(leg.football_model.calibration_error, 'LEGACY view', leg.football_model.n),
      interval_coverage_80: b(leg.football_model.interval_coverage.p80, 'LEGACY view — the reconstructed rows published no intervals, so there is no legacy coverage baseline', leg.football_model.interval_coverage.n),
      market_moved_toward_pct: b(leg.market_intelligence.market_moved_toward_edgedesk_pct, 'LEGACY view (moved lines only)', leg.market_intelligence.n_open),
      average_clv: b(leg.market_intelligence.average_clv_points, 'LEGACY view', leg.market_intelligence.n_clv),
      false_major_rate: b(gh.verified.false_extreme_rate_pct, 'integrity gate replayed on the 2022–2025 holdout (forensics_cfb.json gate_backtest.holdout_football_only)', gh.verified.n),
      decision_selectivity: b(0, 'betting disabled by the frozen decision policy: no qualified wager exists in the legacy record', null)
    }
  };
  fs.writeFileSync(PLAN, JSON.stringify(plan, null, 1) + '\n');
  return plan;
}

module.exports = { PATHS, fingerprint, fileHash, load, drift, init, initPlan, CHAMPION, VERSIONS, PLAN, readJsonl };

if (require.main === module) {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  if (a.indexOf('--init') >= 0) {
    const eff = arg('--effective-at', null);
    if (!eff) { console.error('--effective-at is required'); process.exit(64); }
    const nowIso = arg('--now', new Date().toISOString());
    const ch = init(eff, nowIso);
    initPlan(ch, nowIso);
    console.log(JSON.stringify(ch, null, 1));
  } else {
    const S = load();
    console.log(JSON.stringify({ champion: S.champion ? { release: S.champion.release_id, effective_at: S.champion.effective_at, model: S.champion.champion.model_version } : null,
      versions: S.versions.map((v) => v.event + ' ' + v.kind + ' ' + v.version + ' @ ' + v.effective_at), pending_patches: drift(S.versions, new Date().toISOString()) }, null, 1));
  }
}
