/* ============================================================================
   CFB Model Lab — reports: everything the lab answers, from the ledger only.

   Writes (derived, recomputed every run; the ledger is the only record):
     football/cfb_lab/reports/<season>/lab.json        the Model Lab page's data
     football/cfb_lab/reports/<season>/season.json|md  season to date
     football/cfb_lab/reports/<season>/week_NN.json|md written ONCE when the week is
                                                        complete; never regenerated
     football/cfb_lab/reports/<season>/promotion.json  when the common set allows
     record/football/cfb_model_lab.json                the public, sanitised record
   Appends:
     governance/research_queue.jsonl  evidence-backed research items
     governance/audit_log.jsonl       (via governance.detectChanges in run.js)

   Definitions: docs/cfb-lab/METRICS.md. Nothing here changes a model: alerts,
   lessons and research items inform a person and wait for evidence.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./lab_core.js');
const G = require('./ledger.js');
const GOV = require('./governance.js');
const I = require('./integrity.js');

const U = L.util;
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const ORDER = { OPEN: 0, WEEKLY_FREEZE: 1, T72: 2, T48: 3, T24: 4, T12: 5, T6: 6, T2: 7, FINAL: 8, ADHOC: 9 };

/* ---------------------------------------------------------------- load */
function load(store) {
  const preds = store.predictions();
  const evalsAll = store.evaluations();
  const cur = new Map();
  evalsAll.slice().sort((a, b) => U.ms(a.evaluated_at) - U.ms(b.evaluated_at)).forEach((e) => cur.set(e.prediction_id, e));
  return { preds, evals: [...cur.values()], evalsAll, results: store.results(), lines: store.lines(), quotes: store.quotes(),
    quarantine: typeof store.quarantine === 'function' ? store.quarantine() : [],
    reviews: store.missReviews(), roles: store.gov('model_roles'), experiments: store.gov('experiments'),
    audit: store.gov('audit_log'), partitions: store.gov('partitions'), queue: store.gov('research_queue') };
}
const byKick = (a, b) => (U.ms(a.kickoff_ts) || 0) - (U.ms(b.kickoff_ts) || 0);
const isLive = (e) => e.origin === 'LIVE';
const official = (e) => e.origin === 'LIVE' && e.checkpoint_type === 'T24';
const settled = (e) => e.result_status === 'FINAL' && !e.void;
const withSide = (e) => !!e.side && e.ats_result && e.ats_result !== 'VOID';
const research = (e) => e.decision_class === 'BET' || e.decision_class === 'LEAN';
function groupBy(xs, f) { const m = new Map(); xs.forEach((x) => { const k = f(x); if (k === null || k === undefined) return; if (!m.has(k)) m.set(k, []); m.get(k).push(x); }); return m; }

/* ------------------------------------------------------- performance */
function perf(evs) {
  const s = evs.filter(settled);
  return { errors: L.errorSummary(s), win_calibration: L.winCalibration(s), cover_calibration: L.coverCalibration(s),
    intervals: L.intervalReport(s), market: L.marketComparison(s),
    research_positions: L.betting(s.filter(research), { hypothetical: true }),
    bets: L.betting(s.filter((e) => e.decision_class === 'BET')),
    every_snapshot_side: L.betting(s.filter(withSide), { hypothetical: true }) };
}
function rolling(evs) {
  const s = evs.filter(settled).sort(byKick);
  const one = (xs) => ({ errors: L.errorSummary(xs), intervals_80: L.intervalReport(xs).p80, brier: L.winCalibration(xs).brier });
  return { last_25: one(s.slice(-25)), last_50: one(s.slice(-50)), last_100: one(s.slice(-100)), season_to_date: one(s), all_live: one(s),
    note: 'Rolling windows detect drift; they are not grounds for conclusions (METRICS §16).' };
}

/* ------------------------------------------------------ bucket tables */
function bucketTable(evs, kind, field, opts) {
  opts = opts || {};
  const s = evs.filter(settled);
  const names = L.bucketNames(kind);
  const rows = names.map((b) => {
    const xs = s.filter((e) => L.bucketOf(kind, kind === 'gap' ? (U.isNum(e[field]) ? Math.abs(e[field]) : null) : e[field]) === b);
    const er = L.errorSummary(xs), bt = L.betting(xs.filter(withSide), { hypothetical: true });
    const mv = xs.map((e) => e.market_move_points).filter(U.isNum);
    return { bucket: b, n: xs.length, label: U.sampleLabel(xs.length), mae: er.mae, mae_se: er.mae_se, median_ae: er.median_ae,
      brier: er.brier, win_ece: L.winCalibration(xs).ece, coverage_80: er.coverage_80,
      decisions: bt.decisions, ats_pct: bt.ats_pct, wins: bt.wins, losses: bt.losses, pushes: bt.pushes, roi: bt.roi,
      clv_mean: bt.clv_mean, positive_clv_pct: bt.positive_clv_pct, market_move_mean: U.r(U.mean(mv), 3),
      reliability_mean: U.r(U.mean(xs.map((e) => e.football_confidence)), 1),
      cover_calibration_ece: L.coverCalibration(xs).ece };
  });
  const flags = [];
  const big = rows.filter((r) => r.n >= 30);
  if (kind === 'reliability') {
    for (let i = 0; i < big.length; i++) for (let j = i + 1; j < big.length; j++) {
      /* rows are ordered high -> low reliability */
      const hi = big[i], lo = big[j];
      if (U.isNum(hi.mae) && U.isNum(lo.mae) && hi.mae - lo.mae > Math.max(hi.mae_se || 0, lo.mae_se || 0)) flags.push({ flag: 'RECALIBRATE', detail: 'reliability ' + hi.bucket + ' has MAE ' + hi.mae + ' vs ' + lo.bucket + ' ' + lo.mae + ' (> 1 SE): higher reliability is not smaller error' });
    }
  }
  if (kind === 'edge_quality') {
    for (let i = 0; i < big.length; i++) for (let j = i + 1; j < big.length; j++) {
      const lo = big[i], hi = big[j];   // ordered low -> high edge quality
      const se = (a) => (U.isNum(a.ats_pct) && a.wins + a.losses ? Math.sqrt(a.ats_pct * (1 - a.ats_pct) / (a.wins + a.losses)) : null);
      if (U.isNum(hi.ats_pct) && U.isNum(lo.ats_pct) && lo.ats_pct - hi.ats_pct > Math.max(se(hi) || 0, se(lo) || 0)) flags.push({ flag: 'DOES_NOT_SORT', detail: 'edge quality ' + hi.bucket + ' ATS ' + hi.ats_pct + ' below ' + lo.bucket + ' ' + lo.ats_pct + ' (> 1 SE)' });
    }
  }
  if (kind === 'disagreement') {
    const vl = rows.find((r) => r.bucket === 'very low'), vh = rows.find((r) => r.bucket === 'very high');
    if (vl && vh && vl.n >= 30 && vh.n >= 30 && U.isNum(vl.mae) && U.isNum(vh.mae)) {
      const se = Math.sqrt((vl.mae_se || 0) ** 2 + (vh.mae_se || 0) ** 2);
      if (vh.mae - vl.mae > 2 * se) flags.push({ flag: 'DISAGREEMENT_PREDICTS_ERROR', detail: 'very-high disagreement MAE ' + vh.mae + ' vs very-low ' + vl.mae + ' (> 2 SE)' });
    }
  }
  return { kind, field, rows, flags };
}
function timing(evs) {
  const s = evs.filter((e) => isLive(e) && settled(e));
  const out = [];
  L.CHECKPOINT_ORDER.forEach((ct) => {
    const xs = s.filter((e) => e.checkpoint_type === ct);
    if (!xs.length) { out.push({ checkpoint: ct, n: 0 }); return; }
    const er = L.errorSummary(xs), bt = L.betting(xs.filter(withSide), { hypothetical: true });
    out.push({ checkpoint: ct, n: xs.length, label: U.sampleLabel(xs.length), mae: er.mae, brier: er.brier,
      market_disagreement: U.r(U.mean(xs.map((e) => U.isNum(e.model_market_gap) ? Math.abs(e.model_market_gap) : null)), 3),
      subsequent_move_toward_model: U.r(U.mean(xs.map((e) => e.move_since_snapshot)), 3),
      clv_potential: U.r(U.mean(xs.map((e) => e.clv_points)), 3), ats_if_actioned: bt.ats_pct, ats_n: bt.wins + bt.losses });
  });
  return out;
}
function decisionsTable(evs) {
  const s = evs.filter(settled);
  return ['BET', 'LEAN', 'RESEARCH', 'PASS'].map((c) => {
    const xs = s.filter((e) => e.decision_class === c);
    const bt = L.betting(xs.filter(withSide), { hypothetical: true });
    return Object.assign({ decision_class: c, snapshots: xs.length, mae: L.errorSummary(xs).mae }, bt);
  });
}
function processOutcome(evs) {
  const s = evs.filter((e) => settled(e) && e.side);
  const c = {}; s.forEach((e) => { c[e.outcome_quadrant] = (c[e.outcome_quadrant] || 0) + 1; });
  return { n: s.length, counts: c, note: 'GOOD_PROCESS_LOSS = a bad beat at a good number; POOR_PROCESS_WIN = a win at a number the market later beat (METRICS §11).' };
}

/* --------------------------------------------------- common-set tables */
function finalsByGame(results) {
  const m = new Map();
  results.slice().sort((a, b) => U.ms(a.recorded_at) - U.ms(b.recorded_at)).forEach((r) => m.set(r.game_id, r));
  return m;
}
function modelComparison(D) {
  const off = D.evals.filter((e) => official(e) && settled(e));
  const byModel = groupBy(off, (e) => e.model_version);
  const models = [...byModel.keys()].sort();
  const games = new Map();
  off.forEach((e) => { if (!games.has(e.game_id)) games.set(e.game_id, {}); games.get(e.game_id)[e.model_version] = e; });
  const common = [...games.entries()].filter(([, v]) => models.every((m) => v[m])).map(([k]) => k);
  const rows = models.map((m) => {
    const xs = common.map((g) => games.get(g)[m]);
    return Object.assign({ name: m, label: xs[0] && xs[0].model_label }, pick(L.errorSummary(xs)));
  });
  const any = common.map((g) => games.get(g)[models[0]]);
  const openEv = any.filter((e) => U.isNum(e.open_abs_error)), closeEv = any.filter((e) => U.isNum(e.close_abs_error));
  rows.push(Object.assign({ name: 'opening market', label: 'opener' }, marketErr(openEv, 'open_home_line')));
  rows.push(Object.assign({ name: 'closing market', label: 'close' }, marketErr(closeEv, 'close_home_line')));
  return { n_common: common.length, label: U.sampleLabel(common.length), models, rows,
    note: 'Common set: LIVE settled games where every model has an OFFICIAL (T24) snapshot. Market rows use the subset of those games with that line.' };
}
function pick(s) { return { n: s.n, mae: s.mae, rmse: s.rmse, median_ae: s.median_ae, bias: s.bias, p90_ae: s.p90_ae, p95_ae: s.p95_ae, brier: s.brier, coverage_80: s.coverage_80 }; }
function marketErr(xs, lineField) {
  const err = xs.map((e) => e.final_margin - L.conv.bookToMargin(e[lineField]));
  const abs = err.map(Math.abs);
  return { n: xs.length, mae: U.r(U.mean(abs), 3), rmse: xs.length ? U.r(Math.sqrt(U.mean(err.map((x) => x * x))), 3) : null,
    median_ae: U.r(U.median(abs), 3), bias: U.r(U.mean(err), 3), p90_ae: U.r(U.quantile(abs, 0.9), 3), p95_ae: U.r(U.quantile(abs, 0.95), 3), brier: null, coverage_80: null };
}
function submodelScoreboard(D) {
  const off = D.evals.filter((e) => official(e) && settled(e));
  const byPred = new Map(D.preds.map((p) => [p.prediction_id, p]));
  const series = new Map();
  const add = (name, g, err) => { if (!series.has(name)) series.set(name, new Map()); series.get(name).set(g, err); };
  off.forEach((e) => {
    const p = byPred.get(e.prediction_id); if (!p) return;
    add('ensemble · ' + (p.model_label || p.model_version), e.game_id, e.margin_error);
    if (p.components) Object.keys(p.components).forEach((k) => { const v = U.num(p.components[k]); if (U.isNum(v)) add(k + ' · ' + (p.model_label || p.model_version), e.game_id, e.final_margin - v); });
  });
  const rows = [...series.entries()].map(([name, m]) => {
    const err = [...m.values()], abs = err.map(Math.abs);
    return { name, n: err.length, label: U.sampleLabel(err.length), mae: U.r(U.mean(abs), 3), rmse: err.length ? U.r(Math.sqrt(U.mean(err.map((x) => x * x))), 3) : null,
      bias: U.r(U.mean(err), 3), p90_ae: U.r(U.quantile(abs, 0.9), 3), p95_ae: U.r(U.quantile(abs, 0.95), 3) };
  }).sort((a, b) => (a.mae ?? 99) - (b.mae ?? 99));
  rows.forEach((r, i) => { r.rank_by_mae = i + 1; });
  return { rows, note: 'Research only: ensemble weights never change because a component won a week (METRICS §15, brief §15).' };
}
function promotion(D, roles) {
  const champ = GOV.champion(D.roles);
  const off = D.evals.filter((e) => official(e) && settled(e));
  const games = new Map();
  off.forEach((e) => { if (!games.has(e.game_id)) games.set(e.game_id, { week: e.week }); games.get(e.game_id)[e.model_version] = e; });
  const out = { champion: champ, evaluations: [] };
  Object.keys(roles).filter((m) => roles[m].role === 'challenger' || roles[m].role === 'candidate').forEach((m) => {
    if (typeof champ !== 'string') return;
    const pairs = [...games.values()].filter((g) => g[champ] && g[m]).map((g) => ({ week: g.week, champ: g[champ], chall: g[m] }));
    const ev = L.promotionEval(pairs);
    const stats = { champion_stats: ev.champion, challenger_stats: ev.challenger };
    delete ev.champion; delete ev.challenger;
    out.evaluations.push(Object.assign({ challenger: m, role: roles[m].role, champion: champ }, ev, stats));
  });
  return out;
}

/* ----------------------------------------------------- errors & misses */
function largestMisses(D, n) {
  const byPred = new Map(D.preds.map((p) => [p.prediction_id, p]));
  const rev = new Map(); D.reviews.slice().sort((a, b) => U.ms(a.created_at) - U.ms(b.created_at)).forEach((r) => rev.set(r.prediction_id, r));
  return D.evals.filter((e) => official(e) && settled(e)).sort((a, b) => b.abs_margin_error - a.abs_margin_error).slice(0, n || 15).map((e) => {
    const p = byPred.get(e.prediction_id) || {};
    const r = rev.get(e.prediction_id);
    return { game_id: e.game_id, week: e.week, kickoff: e.kickoff_ts, matchup: p.away_team + ' @ ' + p.home_team, model: e.model_label || e.model_version, model_version: e.model_version,
      predicted: p.pure_home_margin, actual: e.final_margin, abs_error: e.abs_margin_error, close_home_line: e.close_home_line,
      close_abs_error: e.close_abs_error, classification: r ? r.classification : null, rationale: r ? r.rationale : null };
  });
}
function segmentScan(D) {
  const byPred = new Map(D.preds.map((p) => [p.prediction_id, p]));
  const off = D.evals.filter((e) => official(e) && settled(e));
  const segs = {
    'P4 side of P4 vs non-P4': (e, p) => { const s = p.inputs_ref && p.inputs_ref.segment; if (!s) return null; const hp = s.home_fbs_group === 'p4', ap = s.away_fbs_group === 'p4'; if (hp === ap) return null; return hp ? 1 : -1; },
    'home underdog (home side)': (e, p) => (U.isNum(p.pure_home_margin) && p.pure_home_margin < 0 ? 1 : null),
    'projected favourite of 14+ (favourite side)': (e, p) => (U.isNum(p.pure_home_margin) && Math.abs(p.pure_home_margin) >= 14 ? Math.sign(p.pure_home_margin) : null),
    'QB uncertain at snapshot, home side (qb_certainty < 70)': (e, p) => (U.isNum(p.qb_certainty) && p.qb_certainty < 70 ? 1 : null),
    'early season (week <= 3), home side': (e, p) => (U.isNum(p.week) && p.week <= 3 ? 1 : null),
    'neutral site, home side': (e, p) => (p.neutral_site ? 1 : null),
    'data quality not GREEN, home side': (e, p) => (p.data_quality_status && p.data_quality_status !== 'GREEN' ? 1 : null),
  };
  const out = [];
  Object.keys(segs).forEach((name) => {
    const byModel = groupBy(off, (e) => e.model_version);
    byModel.forEach((xs, mv) => {
      const v = xs.map((e) => { const p = byPred.get(e.prediction_id); const o = p ? segs[name](e, p) : null; return o === null ? null : e.margin_error * o; }).filter(U.isNum);
      if (!v.length) return;
      const m = U.mean(v), se = v.length > 1 ? U.sd(v) / Math.sqrt(v.length) : null;
      out.push({ segment: name, model_version: mv, n: v.length, label: U.sampleLabel(v.length), mean_oriented_error: U.r(m, 3), se: U.r(se, 3), z: se ? U.r(m / se, 2) : null,
        reading: 'positive = the oriented side did better than predicted (the model under-rated it)' });
    });
  });
  return out;
}

/* ----------------------------------------------------- data quality */
function upcoming(D, now) {
  const t = U.ms(now);
  const latest = new Map();
  D.preds.filter((p) => isLive({ origin: p.origin }) && U.ms(p.kickoff_ts) > t).sort((a, b) => U.ms(a.prediction_ts) - U.ms(b.prediction_ts))
    .forEach((p) => latest.set(p.game_id + '|' + p.model_version, p));
  return [...latest.values()];
}
function dataQuality(D, now) {
  const up = upcoming(D, now);
  const counts = { GREEN: 0, YELLOW: 0, RED: 0 };
  const games = new Map();
  up.forEach((p) => { const g = games.get(p.game_id); if (!g || L.dqStatus([{ status: p.data_quality_status }, { status: g.status }]) === p.data_quality_status) games.set(p.game_id, { game_id: p.game_id, status: p.data_quality_status, issues: p.data_quality_issues, kickoff: p.kickoff_ts, matchup: p.away_team + ' @ ' + p.home_team }); });
  games.forEach((g) => { counts[g.status] = (counts[g.status] || 0) + 1; });
  const checks = {};
  [...games.values()].forEach((g) => (g.issues || []).forEach((c) => { checks[c.check] = checks[c.check] || { YELLOW: 0, RED: 0 }; checks[c.check][c.status]++; }));
  const lastQuote = D.quotes.reduce((m, q) => Math.max(m, U.ms(q.retrieved_at || q.observed_at) || 0), 0);
  return { games: games.size, counts, by_check: checks, not_green: [...games.values()].filter((g) => g.status !== 'GREEN').sort(byKickoff),
    feeds: { last_quote_at: lastQuote ? new Date(lastQuote).toISOString() : null, quotes_total: D.quotes.length,
      last_result_at: D.results.reduce((m, r) => (U.ms(r.recorded_at) > U.ms(m) ? r.recorded_at : m), null) } };
}
function byKickoff(a, b) { return U.ms(a.kickoff) - U.ms(b.kickoff); }

/* ------------------------------------------------------------ alerts */
function alerts(D, now, roles) {
  const out = [];
  const t = U.ms(now);
  const offByModel = groupBy(D.evals.filter((e) => official(e) && settled(e)).sort(byKick), (e) => e.model_version);
  offByModel.forEach((xs, mv) => {
    const ref = CFG.reference[mv] || {};
    const a = L.driftAlerts(xs, { reference: { mae: ref.mae, pred_var: U.isNum(ref.pred_sd) ? ref.pred_sd * ref.pred_sd : null } });
    a.forEach((x) => { x.model_version = mv; out.push(x); });
  });
  const champ = GOV.champion(D.roles);
  const predsBy = groupBy(D.preds.filter((p) => p.origin === 'LIVE'), (p) => p.game_id);
  predsBy.forEach((ps, gid) => {
    const k = U.ms(ps[0].kickoff_ts);
    if (k > t) return;
    if (typeof champ === 'string' && ps.some((p) => p.model_version === champ) && !ps.some((p) => p.model_version === champ && p.checkpoint_type === 'T24'))
      out.push(L.alert('checkpoint_missed', 'warn', 'game ' + gid + ' (' + ps[0].away_team + ' @ ' + ps[0].home_team + ') reached kickoff without the champion\'s OFFICIAL (T24) snapshot', { game_id: gid }));
  });
  const res = finalsByGame(D.results);
  const backlog = [...predsBy.entries()].filter(([gid, ps]) => U.ms(ps[0].kickoff_ts) + 24 * 3600000 < t && !res.has(gid));
  if (backlog.length) out.push(L.alert('results_backlog', 'warn', backlog.length + ' predicted game(s) are more than 24 h past kickoff with no settled result', { games: backlog.slice(0, 20).map(([g]) => g) }));
  const up = upcoming(D, now), soon = up.filter((p) => U.ms(p.kickoff_ts) - t <= 72 * 3600000);
  const share = (check) => soon.length ? soon.filter((p) => (p.data_quality_issues || []).some((c) => c.check === check)).length / soon.length : 0;
  [['qb_status_freshness', 'qb_source_stale'], ['pbp_freshness', 'pbp_source_stale'], ['odds_freshness', 'market_source_stale'], ['injury_freshness', 'injury_source_stale']]
    .forEach(([check, kind]) => { const s = share(check); if (s > 0.25) out.push(L.alert(kind, 'warn', Math.round(s * 100) + '% of snapshots within 72 h fail ' + check, { share: U.r(s, 3) })); });
  const lastRunRed = up.length ? up.filter((p) => p.data_quality_status === 'RED').length / up.length : 0;
  if (lastRunRed > 0.10) out.push(L.alert('missing_data', 'warn', Math.round(lastRunRed * 100) + '% of current snapshots are data-quality RED', null));
  /* BET-volume anomaly (docs/cfb-production/MARKET_INTEGRITY.md §9): each
     model's official BETs in its latest week against its earlier weeks. A
     flag asks a person to look; it never cancels a bet. */
  groupBy(D.preds.filter(official), (p) => p.model_version).forEach((ps, mv) => {
    const wk = new Map();
    ps.forEach((p) => { const k = (p.season || 0) * 100 + (p.week || 0); wk.set(k, (wk.get(k) || 0) + (p.decision_class === 'BET' ? 1 : 0)); });
    const keys = [...wk.keys()].sort((a, b) => a - b);
    if (!keys.length) return;
    const last = keys[keys.length - 1];
    const v = I.betVolume(wk.get(last), keys.slice(0, -1).map((k) => wk.get(k)));
    if (v.flag) out.push(L.alert('bet_volume_anomaly', 'warn', mv + ' week ' + (last % 100) + ': ' + v.message + ' — review the inputs; nothing is cancelled', { model_version: mv, week: last % 100, count: v.count, limit: v.limit }));
  });
  /* market integrity: quotes refused or quarantined in the last 72 h (one
     alert, with the reasons; the rows are in quarantine.jsonl) */
  const qz = (D.quarantine || []).filter((x) => U.ms(x.detected_at) > t - 72 * 3600000);
  if (qz.length) {
    const why = {}; qz.forEach((x) => (x.reasons || []).forEach((r) => { why[r] = (why[r] || 0) + 1; }));
    out.push(L.alert('market_quotes_quarantined', 'warn', qz.length + ' quote(s) refused or quarantined in the last 72 h (' + Object.keys(why).sort().map((k) => k + ' ' + why[k]).join(', ') + ')', { count: qz.length, reasons: why }));
  }
  return out;
}

/* ----------------------------------------------------- research queue */
function researchItems(D, tables, segments) {
  const rq = CFG.research_queue;
  const items = [];
  segments.forEach((s) => {
    if (s.n >= rq.min_n && U.isNum(s.z) && Math.abs(s.z) >= rq.z)
      items.push({ item_key: 'segment:' + s.segment + ':' + s.model_version, title: s.model_version + ': ' + s.segment + ' ' + (s.mean_oriented_error > 0 ? 'under-rated' : 'over-rated') + ' by ' + Math.abs(s.mean_oriented_error) + ' pts over ' + s.n + ' games',
        n: s.n, effect: s.mean_oriented_error, effect_se: s.se });
  });
  tables.forEach((t) => t.flags.forEach((f) => items.push({ item_key: 'flag:' + f.flag + ':' + t.model_version, title: t.model_version + ': ' + f.detail, n: t.rows.reduce((a, r) => a + r.n, 0), effect: null, effect_se: null })));
  return items;
}
function queueEvents(existing, items, now) {
  const last = new Map();
  existing.slice().sort((a, b) => U.ms(a.created_at) - U.ms(b.created_at)).forEach((e) => last.set(e.item_key, e));
  const out = [];
  items.forEach((it) => {
    const l = last.get(it.item_key);
    if (!l || l.event === 'CLOSED') out.push(GOV.withId('rq', Object.assign({ event: 'OPENED', evidence: { effect: it.effect, se: it.effect_se }, created_at: U.iso(now) }, it)));
    else if (it.n - (l.n || 0) >= CFG.research_queue.evidence_step_n) out.push(GOV.withId('rq', Object.assign({ event: 'EVIDENCE', evidence: { effect: it.effect, se: it.effect_se }, created_at: U.iso(now) }, it)));
  });
  return out;
}
function queueState(events) {
  const m = new Map();
  events.slice().sort((a, b) => U.ms(a.created_at) - U.ms(b.created_at)).forEach((e) => {
    const cur = m.get(e.item_key) || { item_key: e.item_key, opened_at: e.created_at, history: 0 };
    cur.title = e.title; cur.n = e.n; cur.effect = e.effect; cur.effect_se = e.effect_se; cur.status = e.event === 'CLOSED' ? 'CLOSED' : 'OPEN'; cur.updated_at = e.created_at; cur.history++;
    m.set(e.item_key, cur);
  });
  return [...m.values()];
}

/* ------------------------------------------------------------ weekly */
function weekComplete(D, week, now) {
  const ps = D.preds.filter((p) => p.origin === 'LIVE' && p.week === week);
  if (!ps.length) return false;
  const lastKick = Math.max(...ps.map((p) => U.ms(p.kickoff_ts)));
  if (U.ms(now) < lastKick + CFG.weekly_report.complete_after_last_kickoff_hours * 3600000) return false;
  const res = finalsByGame(D.results);
  const off = ps.filter((p) => p.checkpoint_type === 'T24');
  return off.every((p) => res.has(p.game_id)) || U.ms(now) > lastKick + 7 * 86400000;
}
function weeklyReport(D, week, now, champ) {
  const evs = D.evals.filter((e) => e.week === week);
  const off = evs.filter((e) => official(e) && settled(e));
  const preds = D.preds.filter((p) => p.origin === 'LIVE' && p.week === week);
  const offPreds = preds.filter((p) => p.checkpoint_type === 'T24');
  const models = [...new Set(off.map((e) => e.model_version))].sort();
  const perModel = {};
  models.forEach((m) => { perModel[m] = perf(off.filter((e) => e.model_version === m)); });
  const cOff = off.filter((e) => e.model_version === champ);
  const cp = perf(cOff);
  const decCounts = {}; offPreds.filter((p) => p.model_version === champ).forEach((p) => { decCounts[p.decision_class] = (decCounts[p.decision_class] || 0) + 1; });
  const byPred = new Map(D.preds.map((p) => [p.prediction_id, p]));
  const row = (e) => { const p = byPred.get(e.prediction_id) || {}; return { matchup: p.away_team + ' @ ' + p.home_team, model: e.model_label, predicted: p.pure_home_margin, actual: e.final_margin, abs_error: e.abs_margin_error, close_abs_error: e.close_abs_error, beat_close: e.edgedesk_beat_close }; };
  /* a win is a game the model called better than the closing line did
     (error_diff_vs_close = |model error| - |close error| < 0) */
  const wins = cOff.filter((e) => U.isNum(e.error_diff_vs_close) && e.error_diff_vs_close < 0).sort((a, b) => a.error_diff_vs_close - b.error_diff_vs_close).slice(0, 5).map(row);
  const misses = cOff.slice().sort((a, b) => b.abs_margin_error - a.abs_margin_error).slice(0, 5).map(row);
  const ref = CFG.reference[champ] || {};
  const lessons = segmentScan(Object.assign({}, D, { evals: off })).filter((s) => s.model_version === champ && s.n >= 10 && U.isNum(s.z) && Math.abs(s.z) >= 2)
    .map((s) => s.segment + ': ' + s.mean_oriented_error + ' pts (n=' + s.n + ', z=' + s.z + ') — one week; recorded, not acted on');
  const weekStart = Math.min(...preds.map((p) => U.ms(p.prediction_ts))), weekEnd = U.ms(now);
  const changes = D.audit.filter((a) => U.ms(a.created_at) >= weekStart && U.ms(a.created_at) <= weekEnd).map((a) => a.event_type + ' ' + a.subject + (a.reason ? ' — ' + a.reason : ''));
  const reviews = D.reviews.filter((r) => off.some((e) => e.prediction_id === r.prediction_id));
  const cls = {}; reviews.forEach((r) => { cls[r.classification] = (cls[r.classification] || 0) + 1; });
  const er = cp.errors;
  const worked = [], failed = [], random = [], investigate = [];
  if (U.isNum(er.mae) && U.isNum(ref.mae)) {
    const z = er.mae_se ? (er.mae - ref.mae) / er.mae_se : null;
    (er.mae <= ref.mae ? worked : failed).push('champion MAE ' + er.mae + ' vs holdout reference ' + ref.mae + ' (n=' + er.n + (U.isNum(z) ? ', z=' + U.r(z, 2) : '') + ')');
    if (U.isNum(z) && Math.abs(z) < 2) random.push('the MAE difference from the reference is within 2 SE: indistinguishable from noise at n=' + er.n);
  }
  const vc = cp.market.vs_close;
  if (U.isNum(vc.beat_share)) (vc.beat_share >= 0.5 ? worked : failed).push('closer than the closing line in ' + Math.round(vc.beat_share * 100) + '% of ' + vc.n + ' games (mean |model error| − |close error| ' + vc.mean_error_diff + ' pts)');
  const d = cp.market.discovery;
  if (U.isNum(d.moved_toward_share)) (d.moved_toward_share >= 0.5 ? worked : failed).push('the market moved toward the model in ' + Math.round(d.moved_toward_share * 100) + '% of ' + d.n + ' games (mean ' + d.mean_move_points + ' pts)');
  const iv = cp.intervals.p80;
  if (iv.verdict === 'within band') worked.push('80% intervals covered ' + iv.coverage + ' (n=' + iv.n + ')');
  else if (iv.verdict !== 'insufficient sample') failed.push('80% intervals ' + iv.verdict.toLowerCase() + ': ' + iv.coverage + ' (n=' + iv.n + ')');
  if (cls.HIGH_VARIANCE_OUTCOME) random.push(cls.HIGH_VARIANCE_OUTCOME + ' miss(es) with documented post-game luck factors');
  if (cls.MODEL_FAILURE) investigate.push(cls.MODEL_FAILURE + ' miss(es) classified MODEL_FAILURE (the close was 7+ pts closer)');
  if (cls.UNKNOWN) investigate.push(cls.UNKNOWN + ' miss(es) could not be explained from the available evidence');
  if (cls.DATA_FAILURE) investigate.push(cls.DATA_FAILURE + ' miss(es) traced to data quality');
  const rq = queueState(D.queue).filter((q) => q.status === 'OPEN');
  rq.forEach((q) => investigate.push('research queue: ' + q.title));
  const body = {
    kind: 'weekly', season: CFG.season, week, generated_at: U.iso(now), champion: champ,
    summary: { games_predicted: new Set(preds.map((p) => p.game_id)).size, snapshots: preds.length,
      official_predictions: offPreds.length, official_settled: off.length, champion_decisions: decCounts },
    model_performance: { champion: pickPerf(cp), by_model: Object.fromEntries(models.map((m) => [m, pickPerf(perModel[m])])) },
    market_performance: { vs_open: cp.market.vs_open, vs_close: cp.market.vs_close, discovery: cp.market.discovery,
      positive_clv_pct: cp.every_snapshot_side.positive_clv_pct, clv_mean: cp.every_snapshot_side.clv_mean },
    betting_performance: { research_positions: cp.research_positions, bets: cp.bets },
    submodel_performance: submodelScoreboard(Object.assign({}, D, { evals: off })).rows,
    biggest_wins: wins, biggest_misses: misses, miss_classifications: cls, model_lessons: lessons,
    postmortem: { what_worked: worked, what_failed: failed, what_changed: changes, what_may_be_random: random, what_deserves_investigation: investigate },
    policy: 'Nothing in this report changes a model. Weights, features, thresholds and calibration change only through a pre-registered experiment and a governed release (docs/cfb-lab/RUNBOOK.md).',
  };
  return body;
}
function pickPerf(p) {
  return { errors: p.errors, brier: p.win_calibration.brier, win_ece: p.win_calibration.ece, calibration: p.win_calibration.buckets,
    intervals: p.intervals, research_positions: { record: p.research_positions.wins + '-' + p.research_positions.losses + '-' + p.research_positions.pushes, ats_pct: p.research_positions.ats_pct, roi: p.research_positions.roi, clv_mean: p.research_positions.clv_mean, positive_clv_pct: p.research_positions.positive_clv_pct, max_drawdown: p.research_positions.max_drawdown } };
}

/* ------------------------------------------------------------ public */
function publicRecord(D, now) {
  const champSet = D.evals.filter((e) => official(e) && settled(e) && e.model_role === 'champion').sort(byKick);
  const byPred = new Map(D.preds.map((p) => [p.prediction_id, p]));
  const er = L.errorSummary(champSet), wc = L.winCalibration(champSet), rp = L.betting(champSet.filter(research), { hypothetical: true });
  const officialAll = D.preds.filter((p) => p.origin === 'LIVE' && p.checkpoint_type === 'T24' && p.model_role === 'champion');
  return {
    schema: 'edgedesk_cfb_model_lab_public_v1', generated_at: U.iso(now), season: CFG.season, lab_started_at: CFG.lab_started_at,
    rules: {
      official_prediction: 'the champion model\'s T24 snapshot: the first taken when kickoff is 12 to 24 hours away (docs/cfb-lab/METRICS.md §3)',
      closing_line: 'median of books\' last pregame quotes in the 180 minutes before kickoff (§4)',
      ats: 'wins / (wins + losses) at the snapshot\'s own number; pushes shown, not in the denominator (§11)',
      clv: 'points the close moved toward the side, (L_snapshot - L_close) x side (§9)',
      nothing_removed: 'every graded official prediction is listed below, losses included',
    },
    models: [...new Set(champSet.map((e) => e.model_version))],
    counts: { official_predictions: officialAll.length, graded: champSet.length, label: U.sampleLabel(champSet.length) },
    accuracy: { spread_mae: er.mae, rmse: er.rmse, bias: er.bias, win_brier: wc.brier, coverage_80: er.coverage_80, n: er.n },
    research_positions: { n: rp.wins + rp.losses + rp.pushes, label: U.sampleLabel(rp.wins + rp.losses + rp.pushes), record: rp.wins + '-' + rp.losses + '-' + rp.pushes, ats_pct: rp.ats_pct,
      clv_mean: rp.clv_mean, positive_clv_pct: rp.positive_clv_pct, note: 'LEAN/BET research positions graded at the snapshot number. BET is disabled; no stake is claimed.' },
    /* a position is a LEAN or BET with a side; a PASS or RESEARCH row is graded
       for accuracy only, so its ATS result and CLV are null, never a "win" */
    games: champSet.map((e) => { const p = byPred.get(e.prediction_id) || {};
      const pos = research(e);
      return { game_id: e.game_id, week: e.week, kickoff: e.kickoff_ts, home_team: p.home_team, away_team: p.away_team,
        matchup: p.away_team + ' @ ' + p.home_team, model_version: e.model_version,
        official_line: p.fair_spread_display, home_win_probability: p.home_win_probability,
        final: e.final_away_points + '-' + e.final_home_points, abs_error: e.abs_margin_error,
        decision: e.decision_class, is_position: pos, side: pos ? e.side : null, line: pos ? e.graded_line : null,
        result: pos ? e.ats_result : null, clv: pos ? e.clv_points : null }; }),
  };
}

/* ------------------------------------------------------------ markdown */
function mdWeekly(w) {
  const f = (x, k) => (U.isNum(x) ? x.toFixed(k == null ? 2 : k) : '—');
  const pc = (x) => (U.isNum(x) ? (100 * x).toFixed(1) + '%' : '—');
  const c = w.model_performance.champion;
  const lines = [
    '# CFB Model Lab — week ' + w.week + ', ' + w.season, '',
    'Generated ' + w.generated_at + ' from the immutable ledger. Champion: `' + w.champion + '`. Definitions: docs/cfb-lab/METRICS.md.', '',
    '## Week summary', '',
    '| games predicted | snapshots | official predictions | official settled | champion decisions |', '|---|---|---|---|---|',
    '| ' + w.summary.games_predicted + ' | ' + w.summary.snapshots + ' | ' + w.summary.official_predictions + ' | ' + w.summary.official_settled + ' | ' + (Object.entries(w.summary.champion_decisions).map(([k, v]) => k + ' ' + v).join(', ') || '—') + ' |', '',
    '## Model performance (official snapshots)', '',
    '| model | n | MAE | RMSE | bias | Brier | win ECE | 50/80/95% coverage |', '|---|---|---|---|---|---|---|---|',
  ];
  Object.entries(w.model_performance.by_model).forEach(([m, p]) => lines.push('| ' + m + ' | ' + p.errors.n + ' | ' + f(p.errors.mae) + ' | ' + f(p.errors.rmse) + ' | ' + f(p.errors.bias) + ' | ' + f(p.brier, 4) + ' | ' + f(p.win_ece, 4) + ' | ' + [p.intervals.p50.coverage, p.intervals.p80.coverage, p.intervals.p95.coverage].map((x) => f(x, 2)).join(' / ') + ' |'));
  const m = w.market_performance;
  lines.push('', '## Market performance (champion)', '',
    '- EdgeDesk vs opener: mean (|EdgeDesk error| − |opener error|) ' + f(m.vs_open.mean_error_diff) + ' pts (negative = EdgeDesk closer to the result; n=' + m.vs_open.n + '); EdgeDesk closer in ' + pc(m.vs_open.beat_share) + ' of games.',
    '- EdgeDesk vs close: mean (|EdgeDesk error| − |close error|) ' + f(m.vs_close.mean_error_diff) + ' pts (negative = EdgeDesk closer; n=' + m.vs_close.n + '); EdgeDesk closer in ' + pc(m.vs_close.beat_share) + ' of games.',
    '- Market moved toward EdgeDesk: ' + pc(m.discovery.moved_toward_share) + ' of ' + m.discovery.n + ' games, mean ' + f(m.discovery.mean_move_points) + ' pts.',
    '- Positive CLV: ' + pc(m.positive_clv_pct) + ', mean CLV ' + f(m.clv_mean) + ' pts.', '',
    '## Betting performance (research positions, graded at the snapshot number)', '',
    '- Record ' + c.research_positions.record + ', ATS ' + pc(c.research_positions.ats_pct) + ', ROI ' + pc(c.research_positions.roi) + ' (one unit each, hypothetical), mean CLV ' + f(c.research_positions.clv_mean) + ', max drawdown ' + f(c.research_positions.max_drawdown) + ' u.',
    '- BET decisions: ' + w.betting_performance.bets.decisions + ' (BET is disabled).', '',
    '## Submodel performance', '', '| component | n | MAE | bias |', '|---|---|---|---|');
  w.submodel_performance.forEach((r) => lines.push('| ' + r.name + ' | ' + r.n + ' | ' + f(r.mae) + ' | ' + f(r.bias) + ' |'));
  lines.push('', '## Biggest wins (games the model called better than the closing line)', '');
  if (!w.biggest_wins.length) lines.push('- None this week.');
  w.biggest_wins.forEach((r) => lines.push('- ' + r.matchup + ': predicted ' + f(r.predicted, 1) + ', actual ' + r.actual + ' (error ' + f(r.abs_error, 1) + ' vs close ' + f(r.close_abs_error, 1) + ')'));
  lines.push('', '## Biggest misses', '');
  w.biggest_misses.forEach((r) => lines.push('- ' + r.matchup + ': predicted ' + f(r.predicted, 1) + ', actual ' + r.actual + ' (error ' + f(r.abs_error, 1) + ', close ' + f(r.close_abs_error, 1) + ')'));
  lines.push('', '## Model lessons (one week — recorded, not acted on)', '', ...(w.model_lessons.length ? w.model_lessons.map((x) => '- ' + x) : ['- No segment departed from the prediction by 2 SE with n >= 10.']));
  const pm = w.postmortem;
  [['What worked', pm.what_worked], ['What failed', pm.what_failed], ['What changed', pm.what_changed], ['What may be random', pm.what_may_be_random], ['What deserves investigation', pm.what_deserves_investigation]]
    .forEach(([h, xs]) => lines.push('', '### ' + h, '', ...(xs.length ? xs.map((x) => '- ' + x) : ['- Nothing recorded.'])));
  lines.push('', '> ' + w.policy, '');
  return lines.join('\n');
}
function mdSeason(s) {
  const f = (x, k) => (U.isNum(x) ? x.toFixed(k == null ? 2 : k) : '—');
  const pc = (x) => (U.isNum(x) ? (100 * x).toFixed(1) + '%' : '—');
  const out = ['# CFB Model Lab — ' + s.season + ' season to date', '', 'Generated ' + s.generated_at + ' from the immutable ledger (LIVE origin only). Definitions: docs/cfb-lab/METRICS.md.', '',
    '## Comparison on the common official set (n = ' + s.comparison.n_common + (s.comparison.label ? ', ' + s.comparison.label : '') + ')', '',
    '| model | n | MAE | RMSE | bias | P95 | Brier | 80% cov. |', '|---|---|---|---|---|---|---|---|'];
  s.comparison.rows.forEach((r) => out.push('| ' + (r.label || r.name) + ' | ' + r.n + ' | ' + f(r.mae) + ' | ' + f(r.rmse) + ' | ' + f(r.bias) + ' | ' + f(r.p95_ae) + ' | ' + f(r.brier, 4) + ' | ' + f(r.coverage_80) + ' |'));
  out.push('', '## Each model on its own official snapshots', '', '| model | games | MAE | RMSE | Brier | win ECE | 80% cov. | research record | ATS | CLV mean | +CLV |', '|---|---|---|---|---|---|---|---|---|---|---|');
  Object.entries(s.models).forEach(([m, p]) => out.push('| ' + m + ' | ' + p.errors.n + ' | ' + f(p.errors.mae) + ' | ' + f(p.errors.rmse) + ' | ' + f(p.brier, 4) + ' | ' + f(p.win_ece, 4) + ' | ' + f(p.intervals.p80.coverage) + ' | ' + p.research_positions.record + ' | ' + pc(p.research_positions.ats_pct) + ' | ' + f(p.research_positions.clv_mean) + ' | ' + pc(p.research_positions.positive_clv_pct) + ' |'));
  out.push('', '## Promotion evaluations', '');
  (s.promotion.evaluations || []).forEach((e) => out.push('- ' + e.challenger + ' vs champion ' + s.promotion.champion + ': **' + e.decision + '** (n=' + e.n + ' of ' + e.min_n + ' needed; MAE difference ' + f(e.mae_diff, 3) + ' [' + e.mae_diff_ci.map((x) => f(x, 3)).join(', ') + '])'));
  out.push('', '## Alerts', '', ...(s.alerts.length ? s.alerts.map((a) => '- **' + a.kind + '** ' + (a.model_version ? '(' + a.model_version + ') ' : '') + a.message) : ['- None.']), '');
  return out.join('\n');
}

/* ------------------------------------------------------------------ run */
function build(store, now) {
  const D = load(store);
  const roles = GOV.currentRoles(D.roles);
  const champ = GOV.champion(D.roles);
  const live = D.evals.filter(isLive);
  const offLive = live.filter(official);
  /* every model with a role (retired ones only if they have rows), so a model
     that has not snapshotted yet is shown with n = 0 rather than left out */
  const models = [...new Set(D.preds.map((p) => p.model_version).concat(Object.keys(roles).filter((m) => roles[m].role !== 'retired')))].sort();
  const perModel = {};
  models.forEach((m) => {
    const off = offLive.filter((e) => e.model_version === m);
    const all = live.filter((e) => e.model_version === m);
    perModel[m] = {
      label: (D.preds.find((p) => p.model_version === m) || {}).model_label || (roles[m] && roles[m].label) || m, role: roles[m] ? roles[m].role : null,
      official: perf(off), rolling: rolling(off), timing: timing(all), decisions: decisionsTable(off),
      near_miss: L.betting(off.filter((e) => settled(e) && e.near_miss && withSide(e)), { hypothetical: true }),
      process_outcome: processOutcome(off),
      buckets: ['gap', 'reliability', 'edge_quality', 'disagreement'].map((k) => Object.assign(bucketTable(off, k, { gap: 'model_market_gap', reliability: 'football_confidence', edge_quality: 'edge_quality', disagreement: 'ensemble_disagreement' }[k]), { model_version: m })),
      snapshots: D.preds.filter((p) => p.model_version === m && p.origin === 'LIVE').length,
      latest_snapshot_at: D.preds.filter((p) => p.model_version === m && p.origin === 'LIVE').reduce((a, p) => (U.ms(p.prediction_ts) > U.ms(a) ? p.prediction_ts : a), null),
    };
  });
  const segments = segmentScan(D);
  const allTables = models.flatMap((m) => perModel[m].buckets);
  const recon = D.evals.filter((e) => e.origin !== 'LIVE');
  const reconByModel = {};
  [...new Set(recon.map((e) => e.model_version))].forEach((m) => {
    const xs = recon.filter((e) => e.model_version === m && settled(e));
    const lastPer = new Map(); xs.sort((a, b) => ORDER[a.checkpoint_type] - ORDER[b.checkpoint_type]).forEach((e) => lastPer.set(e.game_id, e));
    const last = [...lastPer.values()];
    reconByModel[m] = { origin: [...new Set(xs.map((e) => e.origin))], note: 'the last pre-kickoff number of each game', errors: L.errorSummary(last), win_calibration: L.winCalibration(last), intervals: L.intervalReport(last), market: L.marketComparison(last) };
  });
  const up = upcoming(D, now);
  const t = U.ms(now);
  const thisWeek = new Map();
  up.filter((p) => U.ms(p.kickoff_ts) - t <= 8 * 86400000).forEach((p) => {
    if (!thisWeek.has(p.game_id)) thisWeek.set(p.game_id, { game_id: p.game_id, week: p.week, kickoff: p.kickoff_ts, home: p.home_team, away: p.away_team, market: null, models: {} });
    const g = thisWeek.get(p.game_id);
    g.models[p.model_version] = { label: p.model_label, checkpoint: p.checkpoint_type, origin: p.origin, official: (p.official_families || []).includes('OFFICIAL'),
      prediction_ts: p.prediction_ts, margin: p.pure_home_margin, fair: p.fair_spread_display,
      p_home: p.home_win_probability, sigma: p.prediction_sigma, conf: p.football_confidence, dq: p.data_quality_status, decision: p.decision_class, status: p.status, side: p.side, gap: p.model_market_gap, line: p.recommended_line };
    if (!g.market || U.ms(p.market_as_of) > U.ms(g.market.as_of)) g.market = { current: p.current_spread, open: p.opening_spread, books: p.sportsbook_count, as_of: p.market_as_of, sources: p.market_sources, stale: p.market_stale };
  });
  const alertList = alerts(D, now, roles);
  const promo = promotion(D, roles);
  const lab = {
    schema: 'edgedesk_cfb_model_lab_v1', generated_at: U.iso(now), season: CFG.season, rules: L.RULES, definitions: 'docs/cfb-lab/METRICS.md',
    health: { champion: champ, roles, models: models.map((m) => ({ model_version: m, label: perModel[m].label, role: perModel[m].role, snapshots: perModel[m].snapshots,
      latest_snapshot_at: perModel[m].latest_snapshot_at, upcoming_games: up.filter((p) => p.model_version === m).length,
      avg_confidence_upcoming: U.r(U.mean(up.filter((p) => p.model_version === m).map((p) => p.football_confidence)), 1) })),
      data_quality: dataQuality(D, now), alerts: alertList,
      ledger: { predictions: D.preds.length, live_predictions: D.preds.filter((p) => p.origin === 'LIVE').length, quotes: D.quotes.length, lines: D.lines.length, results: D.results.length, evaluations: D.evalsAll.length, miss_reviews: D.reviews.length } },
    this_week: [...thisWeek.values()].sort(byKickoff),
    performance: Object.fromEntries(models.map((m) => [m, { label: perModel[m].label, role: perModel[m].role, official: perModel[m].official, rolling: perModel[m].rolling }])),
    comparison: { common: modelComparison(D), submodels: submodelScoreboard(D), promotion: promo },
    error_analysis: { largest_misses: largestMisses(D, 20), segments, miss_reviews: countBy(D.reviews, 'classification') },
    edge_analysis: Object.fromEntries(models.map((m) => [m, { buckets: perModel[m].buckets, timing: perModel[m].timing, decisions: perModel[m].decisions, near_miss: perModel[m].near_miss, process_outcome: perModel[m].process_outcome }])),
    market_discovery: Object.fromEntries(models.map((m) => [m, perModel[m].official.market])),
    governance: { experiments: Object.values(GOV.experiments(D.experiments)).map((x) => ({ id: x.experiment_id, name: x.experiment_name, baseline: x.baseline_model, challenger: x.challenger_model, scope: x.scope, status: x.status, hypothesis: x.hypothesis, change: x.change, window: x.evaluation_window })),
      audit_tail: D.audit.slice(-25).reverse(), partitions: D.partitions, research_queue: queueState(D.queue) },
    reconstructed: { note: 'GIT_RECONSTRUCTED (V1 numbers recovered from the board\'s git history) and REPLAY (V2 run over past weeks) rows. Evidence of method, never part of the live record or of any promotion decision.', by_model: reconByModel },
  };
  return { D, lab, allTables, segments, champ, perModel, models, alerts: alertList, promo };
}
function countBy(xs, k) { const o = {}; xs.forEach((x) => { o[x[k]] = (o[x[k]] || 0) + 1; }); return o; }

function run(opts) {
  opts = opts || {};
  const now = U.iso(opts.now || new Date());
  const season = opts.season || CFG.season;
  const store = new G.Store(season, opts.storeOpts);
  const outDir = opts.outDir || path.join(G.LAB, 'reports', String(season));
  fs.mkdirSync(outDir, { recursive: true });
  let B = build(store, now);
  /* research queue: append evidence-backed items, then rebuild the view */
  const items = researchItems(B.D, B.allTables, B.segments);
  const qev = queueEvents(B.D.queue, items, now);
  if (qev.length) { store.append('research_queue', qev, 'event_id'); B = build(store, now); }
  const write = (name, obj) => fs.writeFileSync(path.join(outDir, name), typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1) + '\n');
  const seasonRep = { kind: 'season', season, generated_at: now, comparison: B.lab.comparison.common, promotion: B.promo, alerts: B.alerts,
    models: Object.fromEntries(B.models.map((m) => [m, pickPerf(B.perModel[m].official)])) };
  write('season.json', seasonRep); write('season.md', mdSeason(seasonRep));
  const weeks = [...new Set(B.D.preds.filter((p) => p.origin === 'LIVE').map((p) => p.week))].sort((a, b) => a - b);
  const weeklyWritten = [];
  weeks.forEach((w) => {
    const f = path.join(outDir, 'week_' + G.pad(w) + '.json');
    if (fs.existsSync(f) || !weekComplete(B.D, w, now) || typeof B.champ !== 'string') return;
    const rep = weeklyReport(B.D, w, now, B.champ);
    write('week_' + G.pad(w) + '.json', rep); write('week_' + G.pad(w) + '.md', mdWeekly(rep)); weeklyWritten.push(w);
  });
  const pe = (B.promo.evaluations || []).filter((e) => e.ready);
  if (pe.length) write('promotion.json', { generated_at: now, rule: L.RULES.promotion, champion: B.promo.champion, evaluations: pe });
  /* the index of what has been written, and the pre-registered references the
     drift alerts compare against */
  B.lab.files = { weekly: fs.readdirSync(outDir).filter((f) => /^week_\d+\.(json|md)$/.test(f)).sort(),
    promotion: fs.existsSync(path.join(outDir, 'promotion.json')) ? 'promotion.json' : null, season: ['season.json', 'season.md'], last_run: 'last_run.json' };
  B.lab.reference = CFG.reference;
  write('lab.json', B.lab);
  const pub = publicRecord(B.D, now);
  const pubPath = opts.publicPath || path.join(G.REPO, CFG.public_record.path);
  fs.mkdirSync(path.dirname(pubPath), { recursive: true });
  fs.writeFileSync(pubPath, JSON.stringify(pub, null, 1) + '\n');
  return { now, weekly_written: weeklyWritten, research_events: qev.length, alerts: B.alerts.length, public_graded: pub.counts.graded };
}

module.exports = { load, perf, rolling, bucketTable, timing, decisionsTable, modelComparison, submodelScoreboard, promotion, largestMisses, segmentScan,
  dataQuality, alerts, researchItems, queueEvents, queueState, weekComplete, weeklyReport, publicRecord, mdWeekly, mdSeason, build, run };

if (require.main === module) {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  console.log(JSON.stringify(run({ now: arg('--now', null), season: arg('--season', null) ? Number(arg('--season')) : null })));
}
