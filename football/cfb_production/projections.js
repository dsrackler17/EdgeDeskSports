#!/usr/bin/env node
/* ============================================================================
   CFB production — the stored canonical projections
   (football/cfb_production/reports/projections.json; docs/cfb-production/CANONICAL.md §2).

   Built by the hourly Model Lab job, read by every page: the app's V2 panel,
   the debug view, the operations dashboard, the AI explanation. Nothing that
   reads this file computes a fair line, a probability, a reliability or a
   decision status: they are all here, produced once, by these rules.

   Per game (the next 10 days, every V2.1 row and every V1 board game):
     canonical          canonical.snapshot() of the V2.1 row at as_of: the
                        engine's numbers, input contract, numeric checks,
                        degraded modes, fallback level, public display policy
     v1                 the V1 board's stored number (the fallback level)
     resolved           the manifest's fallback order: 1 FULL, 2 DEGRADED,
                        3 FALLBACK_MODEL (V1), 4 UNAVAILABLE
     official_decision  THE decision: the governed policy cfb_decision_policy_v1
                        (football/cfb_decision/decision.js), read from the
                        decision engine's stored per-book decisions at as_of and
                        summarised by decideGame's own order; none -> NO_DECISION.
                        Its P(positive CLV) tier is shown as a closing-line
                        TENDENCY, never as edge or bet quality (audit F-23).
     research           the Model Lab's stage-8 engine.decide() status: a
                        RESEARCH field, labelled, never the official status
                        (audit F-22); the stage-8 "edge strength" rides along
                        only as a labelled research number
     trace              where each number came from (file hashes, ledger ids)

     node football/cfb_production/projections.js [--now ISO] [--season S] [--write] [--out PATH]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const CANON = require('./canonical.js');
const N = require('./numeric.js');

const REPO = path.resolve(__dirname, '..', '..');
const OUT = path.join(__dirname, 'reports', 'projections.json');
const SCHEMA = 'cfb_canonical_projections_v1';
const HORIZON_H = 24 * 10;
const OFFICIAL_POLICY = 'cfb_decision_policy_v1';
const OFFICIAL_ENGINE = 'cfb_decision_engine_v1';
/* decideGame's summary order (football/cfb_decision/decision.js): the game's
   status is its best book's, BET > RESEARCH > LEAN > PASS > NO_BET */
const ORDER = { BET: 5, RESEARCH: 4, LEAN: 3, PASS: 2, NO_BET: 1 };
const RESEARCH_BASIS = 'stage-8 engine.decide() rule of football/cfb_v2/engine.js: a RESEARCH status, not the governed decision policy (audit F-22)';
const TENDENCY_NOTE = 'P(the close moves toward this side) from the decision calibration: it ranks closing-line movement, not bet quality (close-implied EV <= 0 in every tier; audit F-23)';

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
function readJsonl(p) { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; } }
function sha(p) { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch (e) { return null; } }
function ms(t) { const v = Date.parse(t); return Number.isFinite(v) ? v : null; }
function listJsonl(d) { try { return fs.readdirSync(d).filter((f) => f.endsWith('.jsonl')).sort().flatMap((f) => readJsonl(path.join(d, f))); } catch (e) { return []; } }
function seasonFor(iso) { const d = new Date(iso); return d.getUTCMonth() <= 1 ? d.getUTCFullYear() - 1 : d.getUTCFullYear(); }

/* the governed decision of a game at as_of: the newest CHALLENGER (decision.js,
   policy v1) decision per book observed at or before as_of, summarised */
function officialDecision(rows, asOfMs) {
  const byBook = new Map();
  for (const d of rows) {
    if (d.engine_role !== 'CHALLENGER' || d.engine_version !== OFFICIAL_ENGINE || d.policy_version !== OFFICIAL_POLICY) continue;
    const t = ms(d.observed_at);
    if (t === null || t > asOfMs) continue;
    const prev = byBook.get(d.book);
    if (!prev || t > ms(prev.observed_at)) byBook.set(d.book, d);
  }
  const per = [...byBook.values()];
  if (!per.length) return { status: 'NO_DECISION', basis: OFFICIAL_POLICY, reason: 'no governed decision for this game yet: it needs a frozen V2.1 projection and a captured pregame quote' };
  const top = per.slice().sort((a, b) => (ORDER[b.status] - ORDER[a.status]) || ((b.empirical_ev == null ? -1 : b.empirical_ev) - (a.empirical_ev == null ? -1 : a.empirical_ev)))[0];
  const bc = top.payload && top.payload.bet_confidence;
  return {
    status: top.status, basis: OFFICIAL_POLICY + ' (' + OFFICIAL_ENGINE + ', SHADOW, betting disabled)', side: top.side || null,
    line_for_side: top.line_for_side, price: top.price, book: top.book, observed_at: top.observed_at, decision_id: top.decision_id,
    probability_edge: top.probability_edge, decision_cover_probability: top.decision_cover_probability, break_even_probability: top.break_even_probability,
    reason_codes: top.reason_codes, books: per.length,
    closing_line_tendency: bc || top.p_positive_clv != null ? { label: bc ? bc.label : null, p_positive_clv: bc ? bc.p_positive_clv : top.p_positive_clv, note: TENDENCY_NOTE } : null,
  };
}

function build(opts) {
  opts = opts || {};
  const asOf = N.requireAsOf({ as_of_ts: opts.now });
  const asOfMs = ms(asOf);
  const season = opts.season || seasonFor(asOf);
  const rd = (p) => (opts.files && opts.files[p]) || readJson(path.join(REPO, p));
  const cur = rd('football/cfb_v2/current.json') || { rows: [] };
  const slate = rd('football/fbs/slate.json') || { games: [] };
  const manifest = rd('football/cfb_production/manifest.json') || {};
  const labDir = path.join(REPO, 'football', 'cfb_lab', 'ledger', String(season));
  const preds = opts.predictions || listJsonl(path.join(labDir, 'predictions'));
  const decisions = opts.decisions || readJsonl(path.join(REPO, 'football', 'cfb_decision', String(season), 'decisions.jsonl'));
  const E = CANON.loadEngine();
  const mv = E.params.model_version;
  /* the newest LIVE lab snapshot of each game per model, taken at or before as_of */
  const lab = new Map();
  for (const p of preds) {
    if (p.origin !== 'LIVE' || ms(p.prediction_ts) > asOfMs) continue;
    const k = p.game_id + '|' + p.model_version;
    const c = lab.get(k);
    if (!c || ms(p.prediction_ts) > ms(c.prediction_ts)) lab.set(k, p);
  }
  const decByGame = new Map();
  for (const d of decisions) { const k = String(d.game_id); if (!decByGame.has(k)) decByGame.set(k, []); decByGame.get(k).push(d); }
  /* V1: the board's own stored number (the fallback level), through the same
     reading the public record and the Model Lab use */
  let v1 = new Map();
  try {
    const M = require(path.join(REPO, 'football', 'cfb_lab', 'models.js'));
    const a = M.v1Adapter({ slate });
    v1 = new Map([...a.projections.entries()].map(([k, p]) => [k, { status: 'PREDICTED', model_version: p.model_version, margin: p.pure.margin,
      home_win_prob: p.pure.p_home, fair_total: p.pure.total, source: p.source, slate_generated_at: slate.generated_at, kickoff: p.game.kickoff,
      home: p.game.home, away: p.game.away, week: p.game.week, season: p.game.season }]));
  } catch (e) { v1 = new Map(); }
  const rows = new Map((cur.rows || []).map((r) => [String(r.game_id), r]));
  const ids = new Set([...rows.keys()]);
  v1.forEach((p, k) => { if (!ids.has(k)) ids.add(k); });
  const games = [];
  for (const gid of [...ids].sort()) {
    const row = rows.get(gid) || null;
    const v = v1.get(gid) || null;
    const kick = N.utc((row && row.kickoff) || (v && v.kickoff));
    const h = kick ? (ms(kick) - asOfMs) / 3600000 : null;
    if (h === null || h <= 0 || h > HORIZON_H) continue;
    const L2 = lab.get(gid + '|' + mv) || null;
    const ir = (L2 && L2.inputs_ref) || {};
    const ctx = { market_integrity: ir.market_integrity ? { status: ir.market_integrity.status, actionable_status: ir.market_integrity.actionable_status } : null,
      qb_certainty: L2 ? L2.qb_certainty : null, injury_certainty: L2 ? L2.injury_certainty : null, pbp_completeness: L2 ? L2.pbp_completeness : null };
    const snap = row ? CANON.snapshot(row, { as_of_ts: asOf, engine: E.engine, params: E.params, params_sha256: E.params_sha256, context: ctx,
      row_model_version: cur.model_version, source: 'football/cfb_v2/current.json' }) : null;
    const resolved = CANON.resolve(snap, v);
    const off = officialDecision(decByGame.get(gid) || [], asOfMs);
    games.push({
      game_id: gid, season: (row && row.season) || (v && v.season), week: (row && row.week) || (v && v.week), kickoff: kick,
      home: (row && row.home) || (v && v.home), away: (row && row.away) || (v && v.away), neutral_site: !!(row && row.neutral_site),
      hours_to_kickoff: Math.round(h * 100) / 100,
      canonical: snap,
      v1: v,
      resolved,
      official_decision: resolved.level === 4 ? { status: 'UNAVAILABLE', basis: OFFICIAL_POLICY, reason: resolved.reason } : off,
      research: L2 ? { status: L2.decision_class, engine_status: L2.status, basis: L2.decision_source && /^engine:/.test(L2.decision_source) ? RESEARCH_BASIS : 'the Model Lab\'s ' + (L2.decision_source || 'rule') + ' (research, not the governed policy)',
        stage8_ev_strength: L2.edge_quality, stage8_ev_strength_note: 'engine.decide() betting_edge_strength = uncalibrated EV / 10%: does not sort outcomes (Model Lab DOES_NOT_SORT; audit F-22); never shown as edge or quality',
        prediction_id: L2.prediction_id, checkpoint_type: L2.checkpoint_type, prediction_ts: L2.prediction_ts, row_hash: L2.row_hash,
        canonical_modes: ir.canonical ? ir.canonical.degraded_modes : null } : null,
      display: snap ? snap.display : (resolved.level === 3 ? { label: CANON.PUBLIC_LABEL.FALLBACK_MODEL, notes: [CANON.PUBLIC_LABEL.FALLBACK_MODEL], show_numbers: true, show_confidence_score: false } : { label: 'Prediction unavailable', show_numbers: false, show_confidence_score: false, notes: [] }),
      trace: { current_generated_at: cur.generated_at || null, row_state: row ? row.state || null : null, row_prediction_ts: row ? row.prediction_ts : null,
        lab_prediction_id: L2 ? L2.prediction_id : null, lab_row_hash: L2 ? L2.row_hash : null, official_decision_id: off.decision_id || null },
    });
  }
  const counts = { games: games.length, by_level: {}, by_mode: {}, official: {}, research: {} };
  games.forEach((g) => {
    counts.by_level[g.resolved.level == null ? 'NOT_PRICED' : g.resolved.level] = (counts.by_level[g.resolved.level == null ? 'NOT_PRICED' : g.resolved.level] || 0) + 1;
    ((g.canonical && g.canonical.degraded && g.canonical.degraded.modes) || []).forEach((m) => { counts.by_mode[m] = (counts.by_mode[m] || 0) + 1; });
    counts.official[g.official_decision.status] = (counts.official[g.official_decision.status] || 0) + 1;
    if (g.research) counts.research[g.research.status] = (counts.research[g.research.status] || 0) + 1;
  });
  return {
    schema: SCHEMA, generated_at: asOf, as_of_ts: asOf, season, model_version: mv, champion: manifest.champion_model_version || null,
    champion_selection: manifest.champion_selection || null, manifest_id: manifest.manifest_id || null,
    contract_version: CANON.loadContract().version, numeric_rules: N.VERSION, official_policy: OFFICIAL_POLICY,
    fallback_hierarchy: manifest.fallback_hierarchy || null,
    rules: {
      canonical: 'every number below was produced once by football/cfb_production/canonical.js; readers display it and compute nothing',
      official_decision: 'the governed policy ' + OFFICIAL_POLICY + ' only; betting is disabled, so no status here is a wager',
      research: RESEARCH_BASIS,
      closing_line_tendency: TENDENCY_NOTE,
      display: 'a degraded projection shows its mode in words and never its confidence score (brief §48)',
    },
    sources: { current_json: { generated_at: cur.generated_at || null, sha256: opts.files ? null : sha(path.join(REPO, 'football', 'cfb_v2', 'current.json')), rows: (cur.rows || []).length },
      slate_json: { generated_at: slate.generated_at || null, sha256: opts.files ? null : sha(path.join(REPO, 'football', 'fbs', 'slate.json')) },
      lab_predictions: preds.length, decision_rows: decisions.length },
    counts,
    games,
  };
}

module.exports = { build, officialDecision, OUT, SCHEMA, ORDER, RESEARCH_BASIS, TENDENCY_NOTE };

if (require.main === module) {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const now = arg('--now', null) || new Date().toISOString();         /* the CLI is the one place the clock is read; it is recorded as as_of_ts */
  const r = build({ now, season: arg('--season', null) ? Number(arg('--season')) : null });
  if (a.includes('--write')) {
    const out = arg('--out', OUT);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(r, null, 1) + '\n');
  }
  console.log(JSON.stringify({ as_of_ts: r.as_of_ts, counts: r.counts }));
}
