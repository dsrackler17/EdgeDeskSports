#!/usr/bin/env node
/* ============================================================================
   MODEL HEALTH — the cached historical analytics behind the dashboard.

     node tools/validation/model_health.js            # print the summary
     node tools/validation/model_health.js --write    # football/validation/model_health.json
     node tools/validation/model_health.js --check    # fail if the committed file is stale

   A separate job, never run when a page renders: the page reads the JSON.
   Every source keeps its own evaluation mode, and no two modes are ever
   summed into one record:

     LIVE                football/cfb_terminal/decisions/<season>/evaluations.jsonl
                         (every decision class, first snapshot per class) and
                         snapshots.jsonl (decisions issued, graded or not)
     LIVE_RECONSTRUCTED  the CFB Lab's GIT_RECONSTRUCTED rows
     BACKTEST            the CFB Lab's REPLAY rows
     WALK_FORWARD        football/validation/pricing_{nfl,cfb}.json (held-out,
                         season by season; aggregates, reported as published)
     LIVE MODEL RECORD   record/football/summary.json (the published fair
                         line against the close; model-level, not decisions)

   Plus a DISTRIBUTION AUDIT — each league's learned margin distribution
   against what games closing at that number actually did — and every
   research alert the sources raise. Nothing here changes a threshold, a
   calibration or a model: alerts are for a person to review.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..', '..');
global.window = global.window || global;
require(path.join(ROOT, 'lib', 'research_core.js'));
const V = require(path.join(ROOT, 'lib', 'edgedesk_validation.js'));
const OUT = path.join(ROOT, 'football', 'validation', 'model_health.json');

function readJsonl(f) { if (!fs.existsSync(f)) return []; return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); }
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }
function seasonsIn(dir) { if (!fs.existsSync(dir)) return []; return fs.readdirSync(dir).filter((x) => /^\d{4}$/.test(x)).sort(); }
function r(x, k) { if (typeof x !== 'number' || !isFinite(x)) return null; const m = Math.pow(10, k == null ? 4 : k); return Math.round(x * m) / m; }
function ms(t) { const v = typeof t === 'number' ? t : Date.parse(t); return isFinite(v) ? v : null; }
const REL = (f) => path.relative(ROOT, f);

/* ------------------------------------------------------ the dashboard view
   The spec's sections, each read off the per-mode report with its n. */
function dashboard(rep) {
  const out = {};
  Object.keys(rep.modes).forEach((m) => {
    const M = rep.modes[m];
    const seg = (d) => (M.segments[d] ? M.segments[d].buckets.map((b) => ({ bucket: b.bucket, n: b.n, decided: b.decided, observed_cover: b.observed_cover, expected_cover: b.expected_cover,
      clv_mean: b.clv.mean, clv_n: b.clv.n, clv_beat_rate: b.clv.beat_rate, roi: b.roi, roi_n: b.roi_n, flat_roi_hypothetical: b.flat_roi_hypothetical, sample: b.sample.key, text: b.text })) : []);
    out[m] = {
      label: M.label,
      live_decisions: { n: M.all.n, settled: M.all.settled, sample: M.all.sample },
      clv: M.all.clv, clv_price_pp: M.all.clv_price_pp,
      calibration: { n: M.calibration.n, brier: M.calibration.brier, log_loss: M.calibration.log_loss, ece: M.calibration.ece, bins: M.calibration.bins, sample: M.calibration.sample },
      roi: { roi: M.all.roi, n: M.all.roi_n, units_risked: M.all.units_risked, units_won: M.all.units_won, flat_roi_hypothetical: M.all.flat_roi_hypothetical, flat_n: M.all.flat_n },
      cover_rate: { observed: M.all.observed_cover, interval: M.all.observed_cover_interval, n: M.all.decided },
      expected_vs_observed: { expected: M.all.expected_cover, observed: M.all.observed_cover, error_pp: M.all.calibration_error_pp, n: M.all.decided },
      by_decision: seg('decision'), by_unit: seg('unit_tier'), by_sport: seg('sport'), by_market: seg('market'), by_confidence: seg('confidence_band'),
      by_reliability: seg('reliability_band'), by_ev: seg('calibrated_ev_band'), by_edge: seg('price_edge_band'), by_gap: seg('gap_band'),
      by_calibration_source: seg('calibration_source'), by_model_version: seg('model_version'), by_market_quality: seg('market_quality'),
      expectations: { checks: M.expectations.checks, alerts: M.expectations.alerts }, leakage: { ok: M.leakage.ok, violations: M.leakage.violations.length }
    };
  });
  return out;
}

/* ------------------------------------------------ walk-forward, as published */
function walkForward(file, sport) {
  const J = readJson(path.join(ROOT, file));
  if (!J || !J.markets) return { sport, available: false, source: file };
  const out = { sport, source: file, mode: 'WALK_FORWARD', generated_at: J.generated_at || null, frame: J.frame || null, markets: {} };
  Object.keys(J.markets).forEach((k) => {
    const M = J.markets[k] || {};
    const cal = M.calibration || {};
    const bins = (b) => (b && b.buckets ? b.buckets.filter((x) => x.n > 0).map((x) => ({ bucket: x.bucket, n: x.n, expected: x.predicted, observed: x.observed,
      error_pp: typeof x.observed === 'number' && typeof x.predicted === 'number' ? r(100 * (x.observed - x.predicted), 2) : null, sample: V.sampleState(x.n).key })) : null);
    out.markets[k] = { tier: M.tier || null, tier_basis: M.tier_basis || null, n: M.n || null,
      pooled: M.pooled || null,
      blend_held_out: cal.blend_held_out ? { n: cal.blend_held_out.n, brier: cal.blend_held_out.brier, brier_base_rate: cal.blend_held_out.brier_base_rate, bins: bins(cal.blend_held_out) } : null,
      raw_model_held_out: cal.raw_model_held_out ? { n: cal.raw_model_held_out.n, brier: cal.raw_model_held_out.brier, brier_base_rate: cal.raw_model_held_out.brier_base_rate, bins: bins(cal.raw_model_held_out) } : null,
      sample: V.sampleState(M.n || 0) };
  });
  return out;
}
function walkForwardAlerts(W) {
  const a = [];
  Object.keys(W.markets || {}).forEach((k) => {
    const m = W.markets[k];
    ['blend_held_out', 'raw_model_held_out'].forEach((w) => {
      const x = m[w];
      if (x && typeof x.brier === 'number' && typeof x.brier_base_rate === 'number' && x.n >= 200 && x.brier >= x.brier_base_rate - 1e-9)
        a.push({ code: 'NO_SKILL_OVER_BASE_RATE', severity: 'RESEARCH_ALERT', source: W.source, text: 'WARNING: ' + W.sport + ' ' + k + ' ' + w.replace(/_/g, ' ') + ' Brier ' + x.brier + ' does not beat the base rate ' + x.brier_base_rate + ' (n=' + x.n + ', walk-forward).', note: 'This is a research alert, not an automatic change.' });
      (x && x.bins || []).forEach((b) => { if (b.n >= 200 && Math.abs(b.error_pp) >= 5) a.push({ code: 'WALK_FORWARD_CALIBRATION_MISS', severity: 'RESEARCH_ALERT', source: W.source, text: 'WARNING: ' + W.sport + ' ' + k + ' ' + w.replace(/_/g, ' ') + ' bucket ' + b.bucket + ' predicted ' + (100 * b.expected).toFixed(1) + '%, observed ' + (100 * b.observed).toFixed(1) + '% (n=' + b.n + ').', note: 'This is a research alert, not an automatic change.' }); });
    });
  });
  return a;
}

/* ---------------------------------------------------- the live model record */
function modelRecord() {
  const f = path.join(ROOT, 'record', 'football', 'summary.json'), J = readJson(f);
  if (!J || !J.sports) return { available: false, source: REL(f) };
  const out = { source: REL(f), mode: 'LIVE', level: 'model (the published fair line), not bettor decisions', generated_at: J.generated_at || null, sports: {} };
  Object.keys(J.sports).forEach((s) => {
    const S = J.sports[s] || {}, c = S.clv || {}, ats = (S.ats && S.ats.all) || {};
    const sp = c.spread_entry || {};
    out.sports[s] = { versions: S.versions || [], graded: S.counts ? S.counts.graded : null,
      ats: { n: ats.n || 0, w: ats.w || 0, l: ats.l || 0, p: ats.p || 0, pct: ats.pct != null ? ats.pct : null, sample: V.sampleState(ats.n || 0) },
      clv_spread_entry: { n: sp.n || 0, avg: sp.avg != null ? sp.avg : null, beat: sp.beat || 0, flat: sp.flat || 0, lost: sp.lost || 0, beat_pct: sp.beat_pct != null ? sp.beat_pct : null, sample: V.sampleState(sp.n || 0) },
      error: S.error || null, brier: S.brier || null };
  });
  return out;
}

/* ------------------------------------------------------- distribution audit
   Each league's learned margin distribution, conditioned at a number, against
   what games that CLOSED at that number actually did. A learned distribution
   whose centre drifts from reality biases every raw cover probability read
   off it. Measured, reported, never corrected here. */
function distributionAudit() {
  const out = { rule: 'For each closing number with 50+ games, the learned margin distribution’s mean at that number against the games’ actual mean margin. A gap of 1.5+ pts is a research alert.', leagues: {}, alerts: [] };
  try {
    if (!global.window.EDFootballParams) require(path.join(ROOT, 'football', 'params.js'));
    if (!global.window.EDCfbP4Params) require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
  } catch (e) { return Object.assign(out, { error: 'the football params did not load' }); }
  /* the distribution each league's DECISION path actually reads, and how */
  const TABLES = [
    ['NFL', () => global.window.EDFootballParams.nfl, 'football/params.js nfl.margin_pmf_by_spread', 'football/pricing/lines_nfl.json',
      'football/engine.js coverProbSpread reads this table BY ITS MEDIAN (audit 2026-09-30 #4): the distribution a decision prices from is centred on EdgeDesk’s fair margin, and the drift reaches only its shape (which keys are mixed), never its centre.', false],
    ['CFB', () => global.window.EDCfbP4Params.distributions, 'football/cfb_p4/params.js distributions.margin_pmf_by_spread', 'football/pricing/lines_cfb.json',
      'The CFB decision path re-centres this shape on EdgeDesk’s fair margin (EDQuoteEV.cfbConditionedCover), so the drift reaches its shape, not its centre (the integer shift leaves up to ±0.5 pt).', false]
  ];
  TABLES.forEach(([L, getP, table, file, effect, centreUsed]) => {
    const P = getP(), J = readJson(path.join(ROOT, file));
    if (!P || !P.margin_pmf_by_spread || !J) return;
    const act = {};
    (J.games || []).forEach((g) => { if (!g.close || typeof g.close.home_line !== 'number' || typeof g.margin !== 'number') return; const k = (Math.round(-g.close.home_line * 2) / 2).toFixed(1); (act[k] = act[k] || []).push(g.margin); });
    const rows = [];
    Object.keys(P.margin_pmf_by_spread).forEach((k) => {
      const pmf = P.margin_pmf_by_spread[k]; let m = 0, z = 0; Object.keys(pmf).forEach((x) => { m += Number(x) * pmf[x]; z += pmf[x]; });
      const a = act[(Number(k) === 0 ? 0 : Number(k)).toFixed(1)] || act[k] || [];
      if (a.length < 50 || !z) return;
      const am = a.reduce((s, v) => s + v, 0) / a.length;
      rows.push({ closing_expected_margin: Number(k), n: a.length, learned_mean: r(m / z, 2), actual_mean: r(am, 2), gap: r(m / z - am, 2) });
    });
    rows.sort((x, y) => x.closing_expected_margin - y.closing_expected_margin);
    const big = rows.filter((x) => Math.abs(x.gap) >= 1.5);
    const bw = P.pmf_spread_bw != null ? P.pmf_spread_bw : null;
    out.leagues[L] = { source: table + ' vs ' + file, kernel_bandwidth: bw, conditioning: P.pmf_conditioning || null, effect: effect, centre_used_by_decisions: centreUsed,
      rows, n_numbers: rows.length, n_off_centre: big.length, max_abs_gap: rows.length ? r(Math.max.apply(null, rows.map((x) => Math.abs(x.gap))), 2) : null };
    if (big.length) {
      const worst = big.slice().sort((x, y) => Math.abs(y.gap) - Math.abs(x.gap))[0];
      out.alerts.push({ code: 'DISTRIBUTION_CENTRE_DRIFT', severity: centreUsed ? 'RESEARCH_ALERT' : 'INFO', league: L,
        text: (centreUsed ? 'WARNING: ' : 'NOTE: ') + L + ' learned margin distribution is off-centre at ' + big.length + ' of ' + rows.length + ' closing numbers (worst: at ' + worst.closing_expected_margin + ' its mean is ' + worst.learned_mean + ' while ' + worst.n + ' games closing there averaged ' + worst.actual_mean + ')' + (bw != null ? ', consistent with kernel smoothing (bandwidth ' + bw + ')' : '') + '. ' + effect,
        note: 'This is a research alert, not an automatic change.' + (centreUsed ? ' Decisions on this raw distribution are already capped as MODEL-ESTIMATED (0.25U); the market-anchored blend is the decision probability where one is loaded.' : '') });
    }
  });
  return out;
}

function fingerprint(f) { try { return crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex').slice(0, 12); } catch (_) { return null; } }
/* CURRENT: the committed report is exactly what this code builds from these
   inputs. CODE_CHANGED: same inputs, different report — someone changed the
   code without rebuilding (a failure). INPUTS_MOVED: the data moved on since
   the report was built; the hourly job rebuilds it (not a failure). */
function staleness(committed, fresh) {
  if (!committed) return 'MISSING';
  if (JSON.stringify(committed) === JSON.stringify(fresh)) return 'CURRENT';
  return committed.inputs_key && committed.inputs_key === fresh.inputs_key ? 'CODE_CHANGED' : 'INPUTS_MOVED';
}

/* ------------------------------------------------------------------ build */
function build() {
  const sources = [], alerts = [];
  /* LIVE decisions */
  const decDir = path.join(ROOT, 'football', 'cfb_terminal', 'decisions');
  let snaps = [], evals = [];
  seasonsIn(decDir).forEach((s) => {
    const sf = path.join(decDir, s, 'snapshots.jsonl'), ef = path.join(decDir, s, 'evaluations.jsonl');
    const S = readJsonl(sf), E = readJsonl(ef);
    snaps = snaps.concat(S); evals = evals.concat(E.map((e) => V.fromDecisionEvaluation(e, { season: Number(s) })));
    sources.push({ file: REL(sf), rows: S.length, mode: 'LIVE' }, { file: REL(ef), rows: E.length, mode: 'LIVE' });
  });
  const issued = {};
  snaps.forEach((x) => { const k = x.decision === 'WAIT' ? 'WATCH' : x.decision; issued[k] = (issued[k] || 0) + 1; });
  const liveRep = V.report(evals);
  /* the CFB Lab (model-level, two modes) */
  const labDir = path.join(ROOT, 'football', 'cfb_lab', 'ledger');
  let lab = [];
  seasonsIn(labDir).forEach((s) => { const f = path.join(labDir, s, 'evaluations.jsonl'); const L = readJsonl(f); lab = lab.concat(L.map(V.fromLabEvaluation)); sources.push({ file: REL(f), rows: L.length, mode: 'LIVE_RECONSTRUCTED / BACKTEST' }); });
  const labRep = V.report(lab);
  /* walk-forward and the live model record */
  const wf = { NFL: walkForward('football/validation/pricing_nfl.json', 'NFL'), CFB: walkForward('football/validation/pricing_cfb.json', 'CFB') };
  sources.push({ file: 'football/validation/pricing_nfl.json', mode: 'WALK_FORWARD' }, { file: 'football/validation/pricing_cfb.json', mode: 'WALK_FORWARD' });
  const rec = modelRecord();
  sources.push({ file: rec.source, mode: 'LIVE (model record)' });
  const dist = distributionAudit();
  sources.push({ file: 'football/params.js', mode: 'DISTRIBUTION (NFL margin shapes)' }, { file: 'football/cfb_p4/params.js', mode: 'DISTRIBUTION (CFB margin shapes)' });
  const keys = readJson(path.join(ROOT, 'football', 'validation', 'key_numbers.json'));
  sources.push({ file: 'football/validation/key_numbers.json', mode: 'DESCRIPTIVE (final margins)' });
  /* a fingerprint of every input, so a check can tell "the code changed and
     the report was not rebuilt" (a failure) from "the hourly jobs moved the
     data on since the last rebuild" (expected until the next run) */
  sources.forEach((x) => { x.sha1 = fingerprint(path.join(ROOT, x.file)); });
  const inputsKey = crypto.createHash('sha1').update(sources.map((x) => x.file + ':' + x.sha1).join('\n')).digest('hex').slice(0, 16);
  /* alerts, gathered */
  Object.keys(liveRep.modes).forEach((m) => liveRep.modes[m].expectations.alerts.forEach((a) => alerts.push(Object.assign({ source: 'decision ledger · ' + m }, a))));
  Object.keys(labRep.modes).forEach((m) => labRep.modes[m].expectations.alerts.forEach((a) => alerts.push(Object.assign({ source: 'CFB Lab · ' + m }, a))));
  Object.keys(wf).forEach((k) => walkForwardAlerts(wf[k]).forEach((a) => alerts.push(a)));
  dist.alerts.forEach((a) => alerts.push(Object.assign({ source: 'distribution audit' }, a)));
  /* the published model record, held to the same standard: a meaningful
     sample whose whole interval sits under the −110 break-even is said out loud */
  Object.keys(rec.sports || {}).forEach((s) => {
    const x = rec.sports[s], dec = x.ats.w + x.ats.l;
    if (dec < 200) return;
    const RC = require(path.join(ROOT, 'lib', 'research_core.js')), w = RC.wilson(x.ats.w, dec);
    if (w && w.hi < 110 / 210) alerts.push({ code: 'MODEL_RECORD_BELOW_BREAK_EVEN', severity: 'RESEARCH_ALERT', source: rec.source,
      text: 'WARNING: the ' + s.toUpperCase() + ' model record against the spread is ' + x.ats.w + '-' + x.ats.l + '-' + x.ats.p + ' (' + (100 * x.ats.w / dec).toFixed(1) + '%, 95% interval ' + (100 * w.lo).toFixed(1) + '–' + (100 * w.hi).toFixed(1) + '%, n=' + dec + '): the whole interval sits below the 52.4% break-even at −110.',
      note: 'This is a research alert, not an automatic change. It grades the published fair line, not bettor decisions.' });
  });
  Object.keys(liveRep.modes).forEach((m) => { if (!liveRep.modes[m].leakage.ok) alerts.push({ code: 'LEAKAGE', severity: 'INTEGRITY', source: 'decision ledger · ' + m, text: liveRep.modes[m].leakage.violations.length + ' row(s) fail the leakage audit.', note: 'Those rows are excluded from nothing automatically: a person must review them.' }); });
  /* maturity: which kinds of evidence exist, and how much — never a verdict */
  const liveAll = liveRep.modes.LIVE ? liveRep.modes.LIVE.all : null;
  const maturity = V.MATURITY.map((st) => {
    let n = 0, available = false, note = null;
    if (st.key === 'BACKTEST') { n = labRep.modes.BACKTEST ? labRep.modes.BACKTEST.all.decided : 0; available = n > 0; note = 'CFB Lab replays with a graded outcome (' + (labRep.modes.BACKTEST ? labRep.modes.BACKTEST.all.n : 0) + ' rows on file)'; }
    if (st.key === 'WALK_FORWARD') { n = (wf.NFL.markets && wf.NFL.markets.spread ? wf.NFL.markets.spread.n || 0 : 0) + (wf.CFB.markets && wf.CFB.markets.spread ? wf.CFB.markets.spread.n || 0 : 0); available = n > 0; note = 'held-out pricing validation (spread)'; }
    if (st.key === 'LIVE_DECISIONS') { n = liveAll ? liveAll.decided : 0; available = snaps.length > 0; note = snaps.length + ' decision snapshots issued before kickoff; ' + n + ' settled'; }
    if (st.key === 'LIVE_CLV') { n = liveAll ? liveAll.clv.n : 0; available = n > 0; note = 'graded decisions with a closing line'; }
    if (st.key === 'LIVE_PROFITABILITY') { n = liveAll ? liveAll.roi_n : 0; available = n > 0; note = 'settled BETs with units at risk — never proof on its own'; }
    return { key: st.key, label: st.label, available, n, sample: V.sampleState(n), note };
  });
  const times = [].concat(snaps.map((x) => ms(x.frozen_at || x.evaluated_at)), evals.map((x) => ms(x.evaluated_at)), lab.map((x) => ms(x.evaluated_at)), [ms(rec.generated_at)], [ms(wf.NFL.generated_at)], [ms(wf.CFB.generated_at)]).filter((x) => x != null);
  return {
    schema: 'edgedesk_model_health_v1', engine: V.VERSION, generated_by: 'tools/validation/model_health.js',
    as_of: times.length ? new Date(Math.max.apply(null, times)).toISOString() : null,
    rule: 'Cached historical analytics: rebuilt by this job, read by the page, never recomputed on render. Modes are reported separately and never blended. Every figure carries n and a sample state (n<50 descriptive only · 50–199 early signal · 200–499 developing evidence · 500+ meaningful sample). Nothing here changes a threshold, a calibration or a model.',
    inputs_key: inputsKey, sources, maturity,
    live_decisions: { issued_snapshots: snaps.length, issued_by_decision: issued, graded_rows: evals.length, unit_of_analysis: 'the first snapshot of each decision class per game', report: liveRep, dashboard: dashboard(liveRep) },
    cfb_lab: { level: 'model (fair line) and its research classes, CFB only', rows: lab.length, report: labRep, dashboard: dashboard(labRep) },
    walk_forward: wf, live_model_record: rec, distribution_audit: dist,
    key_numbers: keys ? { NFL: keys.leagues.NFL.key_numbers, CFB: keys.leagues.CFB.key_numbers, n: { NFL: keys.leagues.NFL.n_games, CFB: keys.leagues.CFB.n_games } } : null,
    alerts
  };
}
function summaryLines(H) {
  const lines = [];
  lines.push('MODEL HEALTH · as of ' + H.as_of);
  lines.push('  maturity: ' + H.maturity.map((m) => m.label + ' ' + (m.available ? 'n=' + m.n + ' (' + m.sample.label + ')' : '—')).join(' → '));
  lines.push('  live decisions: ' + H.live_decisions.issued_snapshots + ' snapshots issued ' + JSON.stringify(H.live_decisions.issued_by_decision) + ' · ' + H.live_decisions.graded_rows + ' graded');
  Object.keys(H.cfb_lab.report.modes).forEach((m) => { const A = H.cfb_lab.report.modes[m].all; lines.push('  CFB Lab ' + m + ': ' + A.text + ' · CLV n=' + A.clv.n + ' mean ' + A.clv.mean); });
  Object.keys(H.walk_forward).forEach((k) => { const s = H.walk_forward[k].markets && H.walk_forward[k].markets.spread; if (s) lines.push('  walk-forward ' + k + ' spread: tier ' + s.tier + ' · n=' + s.n + (s.blend_held_out ? ' · blend Brier ' + s.blend_held_out.brier + ' vs base ' + s.blend_held_out.brier_base_rate : '')); });
  Object.keys(H.live_model_record.sports || {}).forEach((s) => { const x = H.live_model_record.sports[s]; lines.push('  live model record ' + s + ': ATS ' + x.ats.w + '-' + x.ats.l + '-' + x.ats.p + ' (n=' + x.ats.n + ', ' + x.ats.sample.label + ') · CLV avg ' + x.clv_spread_entry.avg + ' (n=' + x.clv_spread_entry.n + ')'); });
  lines.push('  research alerts: ' + H.alerts.length);
  H.alerts.forEach((a) => lines.push('    · ' + a.text));
  return lines;
}
function stable(H) { const c = JSON.parse(JSON.stringify(H)); return JSON.stringify(c); }

if (require.main === module) {
  const H = build();
  const a = process.argv.slice(2);
  if (a.includes('--check')) {
    /* --check fails when the code changed without a rebuild; --strict also
       fails when only the inputs moved on */
    const cur = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null, st = staleness(cur, H);
    if (st === 'CURRENT') console.log('model_health.json is current');
    else if (st === 'INPUTS_MOVED' && !a.includes('--strict')) console.log('NOTE | model_health.json was built from older inputs (' + (cur.inputs_key || 'no key') + ' → ' + H.inputs_key + '); the hourly job rebuilds it. The code builds cleanly.');
    else { console.error('model_health.json is stale (' + st + '): run npm run validation:health:write'); process.exit(1); }
  } else {
    summaryLines(H).forEach((l) => console.log(l));
    if (a.includes('--write')) { fs.writeFileSync(OUT, JSON.stringify(H, null, 1) + '\n'); console.log('wrote ' + REL(OUT)); }
  }
}
module.exports = { build, staleness, fingerprint, dashboard, distributionAudit, walkForward, modelRecord, summaryLines, stable };
