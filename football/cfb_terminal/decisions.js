/* ============================================================================
   THE BETTOR DECISION STAGE of the research terminal build.
   docs/bettor-decision/DESIGN.md §10

   For every pregame game the build already priced (build.js quoteEvOf), this
   stage asks the one bettor-facing question — BET / WAIT / PASS / NO DECISION —
   through lib/edgedesk_decision.js, on the SAME model, quotes and evaluation
   the quote-level EV used. It then keeps the record honest:

     decisions/<season>/snapshots.jsonl   one frozen snapshot per change of a
                                          game's decision (append-only; a
                                          post-kickoff or out-of-order row is
                                          refused; nothing is ever rewritten)
     decisions/<season>/grades.jsonl      one grade per BET snapshot, written
                                          once after the Lab's consensus close
                                          and the final: CLV at the recorded
                                          number and units at the recorded price
     decisions.json                       the current decisions, their tracks
                                          (replayed from the snapshots), the
                                          card counts and exposure in units, the
                                          per-tier performance, the config and
                                          every validation label

   Only a normal build (no --out, no --check) appends to the ledger.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = __dirname;
const BD = require(path.join(ROOT, 'lib', 'edgedesk_decision.js'));
const BT = require(path.join(ROOT, 'lib', 'edgedesk_decision_track.js'));
const BI = require(path.join(ROOT, 'lib', 'edgedesk_decision_inputs.js'));
const BK = require(path.join(ROOT, 'lib', 'edgedesk_bankroll.js'));

function readJsonl(p) {
  const f = path.join(ROOT, p);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
}
function num(x) { return typeof x === 'number' && isFinite(x) ? x : null; }
function ms(t) { const x = typeof t === 'number' ? t : Date.parse(t); return isFinite(x) ? x : null; }
function iso(t) { const v = ms(t); return v == null ? null : new Date(v).toISOString(); }

function base(season) { return 'football/cfb_terminal/decisions/' + season; }
/* the ledger, and each game's track replayed from its own snapshots */
function load(season) {
  const snaps = readJsonl(base(season) + '/snapshots.jsonl'), grades = readJsonl(base(season) + '/grades.jsonl');
  const byGame = new Map();
  snaps.forEach((s) => { const k = String(s.game_id); if (!byGame.has(k)) byGame.set(k, []); byGame.get(k).push(s); });
  byGame.forEach((a) => a.sort((x, y) => ms(x.evaluated_at) - ms(y.evaluated_at)));
  return { season: season, snaps: snaps, grades: grades, byGame: byGame };
}
function trackOf(L, gid) {
  let t = null;
  ((L && L.byGame.get(String(gid))) || []).forEach((s) => { t = BT.track(t, s); });
  return t;
}

/* the governance the engine records on every decision */
function governanceOf(ctx) {
  const P = ctx.gov && ctx.gov.policy;
  return { policy_id: ctx.gov ? ctx.gov.policy_dir : null, policy_status: P ? (P.status || 'SHADOW') : 'MISSING', policy_bet_enabled: !!(P && P.bet_enabled),
    ev_policy: ctx.ev ? ctx.ev.policy_version : null, ev_policy_maturity: ctx.ev && ctx.ev.policy ? ctx.ev.policy.maturity || null : null,
    calibration: ctx.ev ? ctx.ev.calibration_version : null };
}

/* ONE GAME: facts from the research object, pricing from quote EV */
function decideGame(ctx, o, read, ev, quoteEv) {
  const gov = governanceOf(ctx);
  const facts = BI.factsFromTerminal(o, read, ev, gov);
  const L = ctx.decLedger;
  const prevSnaps = (L && L.byGame.get(String(o.game_id))) || [];
  const previous = prevSnaps.length ? prevSnaps[prevSnaps.length - 1] : null;
  const track = trackOf(L, o.game_id);
  let decision = null;
  if (quoteEv && quoteEv.model) {
    const input = BI.inputFromFacts(facts, { model: quoteEv.model, quotes: quoteEv.quotes, qev_ctx: quoteEv.qctx, evaluation: quoteEv.game },
      { now: ctx.now, previous: previous, track: track, sport: 'CFB' });
    decision = BD.decide(input);
  } else {
    /* no projection distribution: the engine still answers, from the facts alone */
    decision = BD.decide(BI.inputFromFacts(facts, { model: { available: false, reason: 'no projection distribution for this game' } }, { now: ctx.now, previous: previous, track: track, sport: 'CFB' }));
  }
  return { facts: facts, decision: decision, track: BT.track(track, decision) };
}

/* the compact row the board carries (the full object lives in decisions.json) */
function compact(d, t) {
  if (!d) return null;
  return { decision: d.decision, label: d.decision_label, reason_code: d.action_reason_code, reason: d.action_reason_text,
    side: d.side, side_key: d.side_key, line: d.selected_line, odds: d.selected_odds, book: d.selected_book, units: d.recommended_units, strength: d.strength,
    playable: d.playable ? d.playable.short : null, max_playable_line: d.max_playable_line, max_acceptable_odds: d.max_acceptable_odds,
    calibrated_ev_pct: d.calibrated_ev_pct, raw_ev_pct: d.raw_ev_pct, reliability: d.reliability_score, market_quality: d.market_quality,
    reference: d.reference_quote ? d.reference_quote.label : null, waiting_on: (d.waiting_on || []).map((w) => w.text), evaluated_at: d.evaluated_at,
    changed_at: t ? t.last_changed : null, previous: t ? t.previous_decision : null, decision_id: d.decision_id };
}

/* snapshots on change, grades once, tracks replayed */
function material(a, b) {
  if (!a || !b) return true;
  return a.decision !== b.decision || a.action_reason_code !== b.action_reason_code || a.side_key !== b.side_key || a.selected_line !== b.selected_line
    || a.selected_odds !== b.selected_odds || a.selected_book !== b.selected_book || a.recommended_units !== b.recommended_units;
}
function ledger(season, results, ctx, now) {
  const L = ctx.decLedger || load(season);
  let all = L.snaps.slice();
  const newSnaps = [];
  results.forEach((x) => {
    const d = x.decision; if (!d || !d.game_id) return;
    const prev = (L.byGame.get(String(d.game_id)) || []).slice(-1)[0] || null;
    if (!material(prev, d)) return;
    const s = BT.snapshot(d, { now: now, qb_state: x.facts ? x.facts.qb : null, availability_state: x.facts ? x.facts.availability : null,
      integrity_gates: x.facts && x.facts.integrity ? x.facts.integrity.gates : null,
      distribution: x.facts && x.facts.projection ? { p10: x.facts.projection.p10, p50: x.facts.projection.p50, p90: x.facts.projection.p90, fair_home_margin: x.facts.projection.fair_home_margin } : null });
    const next = BT.appendSnapshot(all, s);
    if (next.length > all.length) { newSnaps.push(s); all = next; }
  });
  /* grade once: the Lab's consensus close and a FINAL result (build.js evLedger's sources) */
  const gradedIds = new Set(L.grades.map((g) => g.snapshot_id));
  const res = {}, closes = {};
  readJsonl('football/cfb_lab/ledger/' + season + '/results.jsonl').forEach((r) => { res[String(r.game_id)] = r; });
  if (ctx.ledger && ctx.ledger.lines) ctx.ledger.lines.forEach((ls, gid) => { const c = ls.filter((l) => l.kind === 'CLOSE' && l.book === 'CONSENSUS' && l.market_type === 'spread' && num(l.home_line) != null).pop(); if (c) closes[String(gid)] = c; });
  const newGrades = [];
  all.forEach((s) => {
    if (s.decision !== 'BET' || !s.bet_price || gradedIds.has(s.snapshot_id)) return;
    const r = res[String(s.game_id)], c = closes[String(s.game_id)];
    if (!r || r.status !== 'FINAL' || num(r.final_margin) == null || !c) return;
    const side = s.bet_price.side, closeSide = side === 'home' ? c.home_line : -c.home_line;
    const g = BT.grade({ side: side, line: s.bet_price.line, odds: s.bet_price.odds, units: s.recommended_units }, { line: closeSide }, { home_margin: r.final_margin });
    newGrades.push({ schema: 'edgedesk_bettor_decision_grade_v1', snapshot_id: s.snapshot_id, game_id: s.game_id, side: side, line: s.bet_price.line, odds: s.bet_price.odds,
      units: s.recommended_units, strength: s.strength, calibrated_cover: s.calibrated_cover_probability, close_line: closeSide, clv_points: g.clv_points, result: g.result, units_won: g.units_won,
      model_version: s.model_version, calibration_version: s.calibration_version, config_version: s.config_version, sport: s.sport, market_type: s.market_type, graded_at: iso(now) });
    gradedIds.add(s.snapshot_id);
  });
  const grades = L.grades.concat(newGrades);
  return { new_snaps: newSnaps, new_grades: newGrades, all: all, grades: grades,
    performance: BT.performance(grades.map((g) => ({ units: g.units, odds: g.odds, result: g.result, clv_points: g.clv_points, calibrated_cover: g.calibrated_cover,
      model_version: g.model_version, sport: g.sport, market_type: g.market_type, strength: g.strength }))),
    paths: { snapshots: base(season) + '/snapshots.jsonl', grades: base(season) + '/grades.jsonl' } };
}

function counts(ds) {
  const c = { BET: 0, WAIT: 0, PASS: 0, NO_DECISION: 0 }, reasons = {};
  ds.forEach((d) => { c[d.decision] = (c[d.decision] || 0) + 1; reasons[d.action_reason_code] = (reasons[d.action_reason_code] || 0) + 1; });
  return { decisions: c, reasons: reasons, total: ds.length };
}
function artifact(meta, results, DL) {
  const ds = results.map((x) => x.decision).filter(Boolean);
  const cfg = BD.config();
  return Object.assign({ schema: 'edgedesk_bettor_decisions_v1' }, meta, {
    engine: BD.VERSION, config_version: cfg.version, validation_state: cfg.validation_state,
    rule: 'One bettor-facing decision per game from lib/edgedesk_decision.js, on the same model, quotes and evaluation as the quote-level EV. Research status is never a decision; a BET needs every gate, a fresh two-sided quote and a calibrated EV above the action floor.',
    validation: { rules: cfg.validation_state, sizing: (cfg.sizing.validated_tiers || []).length ? 'TIERS_VALIDATED:' + cfg.sizing.validated_tiers.join(',') : BD.UNVALIDATED,
      max_active_units: cfg.sizing.max_active_units_unvalidated, shadow: ['1.00U tier (no live validation)', 'every threshold (conservative defaults)'],
      note: 'The thresholds and stake tiers are conservative, configurable defaults, not empirically validated yet; the per-tier record below is how they will be.' },
    config: cfg, counts: counts(ds), exposure: BK.exposure(ds, {}),
    decisions: ds, tracks: results.reduce((o, x) => { if (x.track && x.decision) o[x.decision.game_id] = x.track; return o; }, {}),
    performance: DL ? DL.performance : null, ledger: DL ? DL.paths : null, n_snapshots: DL ? DL.all.length : null, n_grades: DL ? DL.grades.length : null
  });
}
/* build refusals: a BET the engine itself should never have produced */
function problems(results) {
  const out = [], cfg = BD.config();
  results.forEach((x) => {
    const d = x.decision; if (!d) return;
    if (d.decision === 'BET') {
      if (!d.bet_price || d.selected_line == null || d.selected_odds == null) out.push(d.game_id + ': a BET without an exact quote');
      if (!d.playable) out.push(d.game_id + ': a BET without a playable boundary');
      if (!(d.calibrated_ev_pct >= 100 * cfg.action.min_calibrated_ev - 1e-6)) out.push(d.game_id + ': a BET below the calibrated action floor');
      if (['DATA_FAULT', 'INVESTIGATE', 'MARKET_FAULT'].indexOf(d.research_status) >= 0) out.push(d.game_id + ': a BET on research status ' + d.research_status);
      if (d.recommended_units > cfg.sizing.max_active_units_unvalidated + 1e-9 && !(cfg.sizing.validated_tiers || []).length) out.push(d.game_id + ': a BET above the unvalidated unit cap');
      if (d.bet_price && d.bet_price.tail === 'NOT_VALIDATED') out.push(d.game_id + ': a BET on an unvalidated alternate tail');
    }
    if (d.decision !== 'BET' && d.recommended_units > 0) out.push(d.game_id + ': units on a non-BET decision');
  });
  return out;
}
function writeLedger(season, DL) {
  const b = path.join(ROOT, base(season));
  if (DL.new_snaps.length || DL.new_grades.length) fs.mkdirSync(b, { recursive: true });
  if (DL.new_snaps.length) fs.appendFileSync(path.join(b, 'snapshots.jsonl'), DL.new_snaps.map((x) => JSON.stringify(x)).join('\n') + '\n');
  if (DL.new_grades.length) fs.appendFileSync(path.join(b, 'grades.jsonl'), DL.new_grades.map((x) => JSON.stringify(x)).join('\n') + '\n');
}

module.exports = { load: load, trackOf: trackOf, governanceOf: governanceOf, decideGame: decideGame, compact: compact, ledger: ledger, artifact: artifact, problems: problems, writeLedger: writeLedger, counts: counts, OUT: OUT };
