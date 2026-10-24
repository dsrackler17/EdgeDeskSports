#!/usr/bin/env node
/* ============================================================================
   FBS-vs-FCS: a map from the engine's margin to the UNCAPPED final margin.
   The experiment pre-registered as H-014 (docs/market-intelligence/hypotheses.json,
   registered 2026-10-24T00:13:37Z, before this file read a single residual).

   WHY. The CFB engine learns every rating from margins clamped at +/-35
   (engine.js, hp.cap) and prices every FCS team from one floor (params.js
   fcs_rating -28). A rating difference therefore predicts a capped margin.
   FBS-vs-FCS finals often exceed 35, so the published margin runs short: on
   2026 live games the favourite was priced 7.8 points short of the close
   (H-003), and the FCS-bridge validation (football/validation/fcs_bridge_cfb.json)
   shows a -8.8 point bias against real finals that its capped metric (+0.16)
   cannot see.

   WHAT. Two candidates, fixed in the registration, each fitted only on
   earlier seasons' FBS-vs-FCS games, in FBS-team points:
     C1_shift   raw + d          d = mean(final - raw)
     C2_affine  a + b * raw      ordinary least squares
   Test seasons 2016-2025, expanding window from 2012. The raw margin is the
   shipped engine (v1.0.1) replayed cold and walk-forward
   (model_loop/adapters/cfb/baselines/cfb_p4_replay_predictions.csv.gz); the
   games, divisions, finals and closes come from docs/model-loop/cfb/predictions.csv.gz.

   ACCEPTANCE (H-014, all of):
     pooled out-of-sample MAE against real finals, candidate - raw: interval
       below -0.5 (cluster bootstrap, season-week clusters)
     every leave-one-season-out estimate below -0.5
     better than raw in a majority of the ten test seasons
     Brier of P(FBS wins) not worse with an interval above zero (each game's
       sigma implied by the engine's own margin and probability)
   Reported beside it: the repo bar (football/cfb_p4/v12_correction.js:
   pooled OOS MAE improves >= 0.05 pts and beats raw in a majority of years).

   OUTPUT. football/validation/fcs_uncapped_cfb.json (the evidence, H-014's
   judgement), football/cfb_p4/fcs_margin_map.js (GENERATED: the final map
   fitted on 2012-2025 with survived true/false and promoted FALSE — nothing
   reads it into a price; promotion is a person's decision), and
   docs/market-intelligence/FCS_UNCAPPED.md.

   CAVEAT, as registered: the engine's trained coefficients (the -28 floor
   among them) were fitted on 2001-2025, so the replay's raw margins are
   partly in-sample before 2026. The map is fitted strictly out of sample.

     node football/cfb_p4/research/fcs_uncapped.js [--write]
   ============================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..', '..', '..');
const L = require(path.join(ROOT, 'lib', 'edgedesk_validation_lab.js'));
const VERSION = 'cfb_fcs_uncapped_v1';
const GAMES = 'docs/model-loop/cfb/predictions.csv.gz';
const REPLAY = 'model_loop/adapters/cfb/baselines/cfb_p4_replay_predictions.csv.gz';
const FIRST = 2012, TEST_FROM = 2016, TEST_TO = 2025, LIVE = 2026, CAP = 35;
const HYP = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'market-intelligence', 'hypotheses.json'), 'utf8')).hypotheses.find((h) => h.id === 'H-014');

const isNum = (x) => typeof x === 'number' && isFinite(x);
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const r = (x, k) => L.round(x, k == null ? 3 : k);

function csv(rel) {
  const text = zlib.gunzipSync(fs.readFileSync(path.join(ROOT, rel))).toString('utf8');
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift();
  return rows.filter((x) => x.length === head.length).map((x) => Object.fromEntries(head.map((h, i) => [h, x[i]])));
}
const num = (v) => (v === '' || v == null ? null : (isFinite(Number(v)) ? Number(v) : null));

/* the inverse normal CDF (Acklam), for each game's implied sigma */
function qnorm(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - lo) return -qnorm(1 - p);
  const q = p - 0.5, t = q * q;
  return (((((a[0] * t + a[1]) * t + a[2]) * t + a[3]) * t + a[4]) * t + a[5]) * q / (((((b[0] * t + b[1]) * t + b[2]) * t + b[3]) * t + b[4]) * t + 1);
}

/* ---------------------------------------------------------------- data */
function load() {
  const rep = {};
  csv(REPLAY).forEach((x) => { if (x.status === 'PREDICTED') rep[x.game_id] = x; });
  const out = [], skipped = {};
  const skip = (why) => { skipped[why] = (skipped[why] || 0) + 1; };
  csv(GAMES).forEach((g) => {
    const divs = [g.home_div, g.away_div].sort().join('/');
    if (divs !== 'fbs/fcs') return;
    const season = Number(g.season);
    if (season < FIRST) return skip('before the replay (2012)');
    const p = rep[g.game_id];
    if (!p) return skip('no replay prediction');
    const res = num(g.result), raw = num(p.fair_spread), ph = num(p.home_win_prob);
    if (res == null) return skip('no final');
    if (raw == null) return skip('no replay margin');
    const s = g.home_div === 'fbs' ? 1 : -1;            /* FBS-team points */
    const close = num(g.close_margin);
    const pf = ph == null ? null : (s === 1 ? ph : 1 - ph);
    out.push({ game_id: g.game_id, season, week: Number(g.week), cluster: season + '-w' + g.week, neutral: g.neutral === '1',
      fbs: s === 1 ? g.home_name : g.away_name, fcs: s === 1 ? g.away_name : g.home_name,
      raw: s * raw, final: s * res, close: close == null ? null : s * close, p_raw: pf,
      sigma: pf != null && pf > 0.5 && pf < 0.99999 && s * raw > 1 ? (s * raw) / qnorm(pf) : null });
  });
  return { rows: out, skipped };
}

/* ------------------------------------------------------------- the maps */
function fit(train) {
  const xs = train.map((x) => x.raw), ys = train.map((x) => x.final), n = xs.length;
  const mx = mean(xs), my = mean(ys);
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
  const b = sxx > 0 ? sxy / sxx : 1;
  return { n, C1_shift: { a: my - mx, b: 1 }, C2_affine: { a: my - b * mx, b } };
}
const apply = (m, raw) => m.a + m.b * raw;
const CANDS = ['C1_shift', 'C2_affine'];
function brier(margin, sigma, won) { if (!isNum(margin) || !isNum(sigma)) return null; const p = L.normalCdf(margin / sigma); return (p - won) ** 2; }

function run() {
  const D = load();
  const rows = D.rows;
  const seasonOf = (x) => x.season;
  const fs_ = L.folds(rows, { group: seasonOf, time: (x) => Date.UTC(x.season, 6, 1), known_at: (x) => Date.UTC(x.season + 1, 1, 1), min_train_groups: TEST_FROM - FIRST });
  const sep = L.checkSeparation(fs_, { known_at: (x) => Date.UTC(x.season + 1, 1, 1) });
  const test = [], seasons = [];
  fs_.filter((f) => f.group >= TEST_FROM && f.group <= TEST_TO).forEach((f) => {
    const F = fit(f.train);
    const medSigma = L.round(require(path.join(ROOT, 'lib', 'research_core.js')).median(f.train.map((x) => x.sigma).filter(isNum)), 3);
    const t = f.test.map((x) => {
      const o = Object.assign({}, x, { fold: f.group, sigma_used: isNum(x.sigma) ? x.sigma : medSigma });
      CANDS.forEach((c) => { o[c] = apply(F[c], x.raw); });
      return o;
    });
    test.push.apply(test, t);
    const ae = (k) => mean(t.map((x) => Math.abs(x.final - x[k])));
    seasons.push({ season: f.group, n_train: f.train.length, n_test: t.length, fit: { C1_shift: { a: r(F.C1_shift.a) }, C2_affine: { a: r(F.C2_affine.a), b: r(F.C2_affine.b, 4) } },
      mae_raw: r(ae('raw')), mae_C1_shift: r(ae('C1_shift')), mae_C2_affine: r(ae('C2_affine')),
      bias_raw: r(mean(t.map((x) => x.final - x.raw))), bias_C1_shift: r(mean(t.map((x) => x.final - x.C1_shift))), bias_C2_affine: r(mean(t.map((x) => x.final - x.C2_affine))) });
  });

  /* pooled, per candidate */
  const pooled = {};
  CANDS.forEach((c) => {
    const d = L.pairedDifference(test, (x) => Math.abs(x.final - x[c]), (x) => Math.abs(x.final - x.raw), { cluster: 'cluster' });
    const loso = seasons.map((s) => mean(test.filter((x) => x.season !== s.season).map((x) => Math.abs(x.final - x[c]) - Math.abs(x.final - x.raw))));
    const better = seasons.filter((s) => s['mae_' + c] < s.mae_raw).length;
    const capped = L.pairedDifference(test, (x) => Math.abs(Math.max(-CAP, Math.min(CAP, x.final)) - x[c]), (x) => Math.abs(Math.max(-CAP, Math.min(CAP, x.final)) - x.raw), { cluster: 'cluster' });
    const withClose = test.filter((x) => isNum(x.close));
    const vsClose = L.pairedDifference(withClose, (x) => Math.abs(x.close - x[c]), (x) => Math.abs(x.close - x.raw), { cluster: 'cluster' });
    const won = (x) => (x.final > 0 ? 1 : 0);
    const br = L.pairedDifference(test.filter((x) => isNum(x.sigma_used)), (x) => brier(x[c], x.sigma_used, won(x)), (x) => brier(x.raw, x.sigma_used, won(x)), { cluster: 'cluster' });
    pooled[c] = {
      n: d.n, clusters: d.clusters, mae_raw: r(d.b_mean), mae_candidate: r(d.a_mean), mae_diff: L.rounded(d.diff, 3), verdict: d.verdict,
      leave_one_season_out: { min: r(Math.min.apply(null, loso)), max: r(Math.max.apply(null, loso)) },
      seasons_better: better, seasons: seasons.length,
      bias_raw: r(mean(test.map((x) => x.final - x.raw))), bias_candidate: r(mean(test.map((x) => x.final - x[c]))),
      capped_mae_diff: L.rounded(capped.diff, 3),
      vs_close: { n: vsClose.n, mean_abs_gap_raw: r(vsClose.b_mean), mean_abs_gap_candidate: r(vsClose.a_mean), diff: L.rounded(vsClose.diff, 3),
        close_mae: r(mean(withClose.map((x) => Math.abs(x.final - x.close)))), raw_mae: r(mean(withClose.map((x) => Math.abs(x.final - x.raw)))), candidate_mae: r(mean(withClose.map((x) => Math.abs(x.final - x[c])))) },
      brier: { n: br.n, raw: r(br.b_mean, 5), candidate: r(br.a_mean, 5), diff: L.rounded(br.diff, 5), worse: !!(br.diff.ci[0] != null && br.diff.ci[0] > 0) },
      repo_bar: { rule: 'pooled OOS MAE improves >= 0.05 pts AND beats raw in a majority of eval years (football/cfb_p4/v12_correction.js)',
        met: d.a_mean - d.b_mean <= -0.05 && better > seasons.length / 2 }
    };
  });
  const chosen = pooled.C1_shift.mae_candidate <= pooled.C2_affine.mae_candidate ? 'C1_shift' : 'C2_affine';
  const P = pooled[chosen];

  /* H-014, judged on its own registered rule */
  const head = { est: P.mae_diff.est, ci: P.mae_diff.ci, verdict: P.verdict, n: P.n, clusters: P.clusters, leave_one_out: { min: P.leave_one_season_out.min, max: P.leave_one_season_out.max } };
  const j = L.judge(HYP, head);
  const also = { majority_of_seasons: P.seasons_better > P.seasons / 2, brier_not_worse: !P.brier.worse };
  let status = j.status, why = j.why;
  if (status === 'ACCEPTED' && !(also.majority_of_seasons && also.brier_not_worse)) {
    status = 'REJECTED';
    why = 'the MAE rule is met but ' + [!also.majority_of_seasons ? 'not in a majority of seasons' : null, !also.brier_not_worse ? 'the Brier guard fails' : null].filter(Boolean).join(' and ');
  }

  /* the final map: every season 2012-2025 */
  const all = rows.filter((x) => x.season <= TEST_TO);
  const FF = fit(all);
  const finalMap = FF[chosen];

  /* 2026: the replay (aggregate already seen, H-003) and the live record */
  const live26 = rows.filter((x) => x.season === LIVE);
  const repl26 = L.pairedDifference(live26, (x) => Math.abs(x.final - apply(finalMap, x.raw)), (x) => Math.abs(x.final - x.raw), { cluster: 'cluster' });
  const rec = JSON.parse(fs.readFileSync(path.join(ROOT, 'record', 'football', 'cfb_' + LIVE + '.json'), 'utf8'));
  const liveRows = Object.values(rec.games).filter((g) => g.group === 'fbs_fcs' && g.pick && Number.isFinite(g.pick.home_line) && g.final && g.final.home_score != null)
    .map((g) => {
      const s = g.home_division === 'fbs' ? 1 : -1;
      return { cluster: 'w' + g.week, raw: s * -g.pick.home_line, final: s * (g.final.home_score - g.final.away_score), close: g.close && Number.isFinite(g.close.home_line) ? s * -g.close.home_line : null, model_version: g.pick.model_version };
    });
  const liveD = L.pairedDifference(liveRows, (x) => Math.abs(x.final - apply(finalMap, x.raw)), (x) => Math.abs(x.final - x.raw), { cluster: 'cluster' });
  const liveClose = liveRows.filter((x) => isNum(x.close));
  const liveGap = L.pairedDifference(liveClose, (x) => Math.abs(x.close - apply(finalMap, x.raw)), (x) => Math.abs(x.close - x.raw), { cluster: 'cluster' });

  /* the FCS bridge's own 2026 walk-forward, re-scored on REAL finals (its verdict scored capped ones) */
  const BR = path.join(ROOT, 'football', 'validation', 'fcs_bridge_cfb.json');
  let bridge = null;
  if (fs.existsSync(BR)) {
    const bj = JSON.parse(fs.readFileSync(BR, 'utf8'));
    const br = (bj.rows || []).filter((x) => isNum(x.bridge) && isNum(x.floor) && isNum(x.actual)).map((x) => Object.assign({}, x, { cluster: 'w' + x.week }));
    const capd = (v) => Math.max(-CAP, Math.min(CAP, v));
    const u = L.pairedDifference(br, (x) => Math.abs(x.actual - x.bridge), (x) => Math.abs(x.actual - x.floor), { cluster: 'cluster' });
    const c = L.pairedDifference(br, (x) => Math.abs(capd(x.actual) - x.bridge), (x) => Math.abs(capd(x.actual) - x.floor), { cluster: 'cluster' });
    bridge = { source: 'football/validation/fcs_bridge_cfb.json', season: bj.season, n: u.n, clusters: u.clusters, floor_mae: r(u.b_mean), bridge_mae: r(u.a_mean),
      uncapped_diff: L.rounded(u.diff, 3), uncapped_verdict: u.verdict, capped_diff: L.rounded(c.diff, 3), capped_verdict: c.verdict, file_verdict: bj.verdict || null };
  }

  return {
    schema: 'edgedesk_fcs_uncapped_validation_v1', version: VERSION, generated_from: [GAMES, REPLAY, 'record/football/cfb_' + LIVE + '.json'],
    hypothesis: 'H-014', registered_at: HYP.registered_at, lab: L.VERSION,
    data: { games: rows.length, by_season: Object.fromEntries([...new Set(rows.map((x) => x.season))].sort().map((s) => [s, rows.filter((x) => x.season === s).length])), skipped: D.skipped,
      sigma_implied: rows.filter((x) => isNum(x.sigma)).length },
    folds: { test_seasons: TEST_FROM + '-' + TEST_TO, expanding_from: FIRST, separated: sep.ok, problems: sep.problems.length },
    seasons, pooled, chosen,
    hypotheses: { 'H-014': { status, why, result: Object.assign({}, head, { candidate: chosen, also }) } },
    final_map: { kind: chosen, a: r(finalMap.a, 4), b: r(finalMap.b, 4), fitted_on: FIRST + '-' + TEST_TO, n: FF.n },
    check_2026: {
      note: 'The 2026 aggregate shortfall had been seen (H-003): these describe 2026 and confirm nothing. H-015 is the confirmatory test, on games after 2026-10-24T00:13:37Z.',
      replay: { n: repl26.n, mae_raw: r(repl26.b_mean), mae_mapped: r(repl26.a_mean), diff: L.rounded(repl26.diff, 3) },
      live_record: { n: liveD.n, mae_raw: r(liveD.b_mean), mae_mapped: r(liveD.a_mean), diff: L.rounded(liveD.diff, 3),
        vs_close: { n: liveGap.n, mean_abs_gap_raw: r(liveGap.b_mean), mean_abs_gap_mapped: r(liveGap.a_mean), diff: L.rounded(liveGap.diff, 3) } },
      bridge_rescored: bridge
    },
    status, why
  };
}

function mapFile(rep) {
  const M = { version: VERSION, generated_at: new Date().toISOString(), generated_by: 'football/cfb_p4/research/fcs_uncapped.js', hypothesis: 'H-014', status: rep.status,
    survived: rep.status === 'ACCEPTED', promoted: false,
    applies_to: 'FBS-vs-FCS games only; margins in FBS-team points (the FBS side\'s margin), applied to the engine\'s published margin',
    map: rep.final_map, evidence: 'football/validation/fcs_uncapped_cfb.json',
    decision: rep.status === 'ACCEPTED'
      ? 'SURVIVED its pre-registered test (H-014). NOT PROMOTED: nothing reads this map into a price; promoting it is a person\'s decision, and H-015 tests it on live games from 2026-10-24.'
      : 'REJECTED by its pre-registered test (H-014): recorded, never applied.' };
  return 'if(typeof window===\'undefined\'){globalThis.window=globalThis;}\n'
    + '/* EdgeDesk CFB FBS-vs-FCS uncapped-margin map (shadow; never applied unless promoted). GENERATED FILE —\n'
    + '   produced by football/cfb_p4/research/fcs_uncapped.js; never edit by hand. */\n'
    + 'window.EDCfbP4FcsMarginMap = ' + JSON.stringify(M) + ';\n'
    + 'if(typeof module!==\'undefined\'&&module.exports){module.exports=window.EDCfbP4FcsMarginMap;}\n';
}

function fmt(b, k) { if (!b || b.est == null) return '—'; return b.est.toFixed(k == null ? 2 : k) + (b.ci && b.ci[0] != null ? ' [' + b.ci[0].toFixed(k == null ? 2 : k) + ', ' + b.ci[1].toFixed(k == null ? 2 : k) + ']' : ''); }
function doc(rep) {
  const o = [], p = (s) => o.push(s);
  p('# FBS vs FCS: an uncapped-margin map for the CFB engine (H-014)');
  p('');
  p('Generated by `node football/cfb_p4/research/fcs_uncapped.js --write`; do not edit by hand. Evidence: [`football/validation/fcs_uncapped_cfb.json`](../../football/validation/fcs_uncapped_cfb.json). Registered as H-014 in [`hypotheses.json`](hypotheses.json) at ' + rep.registered_at + ', before any 2012–2025 residual was read.');
  p('');
  p('**Result: ' + rep.status + '.** ' + rep.why + '. Chosen candidate (lower pooled out-of-sample MAE): `' + rep.chosen + '`. The map is written to `football/cfb_p4/fcs_margin_map.js` with `promoted: false`: nothing reads it into a price.');
  p('');
  p('**Data.** ' + rep.data.games + ' FBS-vs-FCS games, ' + Object.keys(rep.data.by_season)[0] + '–' + Object.keys(rep.data.by_season).slice(-1)[0] + ', the shipped engine (v1.0.1) replayed cold and walk-forward, against real finals. Margins in FBS-team points. Folds: test seasons ' + rep.folds.test_seasons + ', each fitted on every earlier season from ' + rep.folds.expanding_from + ' (separation check: ' + (rep.folds.separated ? 'passed' : 'FAILED') + '). Intervals: 95% cluster bootstrap over season-weeks. Caveat (as registered): the engine\'s coefficients, the −28 floor among them, were fitted on 2001–2025, so raw margins before 2026 are partly in-sample; the map is fitted strictly out of sample.');
  p('');
  p('## Pooled, test seasons ' + rep.folds.test_seasons);
  p('');
  p('| | C1 shift | C2 affine |');
  p('|---|---|---|');
  const A = rep.pooled.C1_shift, B = rep.pooled.C2_affine;
  p('| games / clusters | ' + A.n + ' / ' + A.clusters + ' | ' + B.n + ' / ' + B.clusters + ' |');
  p('| MAE: raw → candidate | ' + A.mae_raw + ' → ' + A.mae_candidate + ' | ' + B.mae_raw + ' → ' + B.mae_candidate + ' |');
  p('| MAE difference (candidate − raw) | ' + fmt(A.mae_diff) + ' | ' + fmt(B.mae_diff) + ' |');
  p('| leave one season out | ' + A.leave_one_season_out.min + ' to ' + A.leave_one_season_out.max + ' | ' + B.leave_one_season_out.min + ' to ' + B.leave_one_season_out.max + ' |');
  p('| seasons better than raw | ' + A.seasons_better + ' of ' + A.seasons + ' | ' + B.seasons_better + ' of ' + B.seasons + ' |');
  p('| mean bias (final − model): raw → candidate | ' + A.bias_raw + ' → ' + A.bias_candidate + ' | ' + B.bias_raw + ' → ' + B.bias_candidate + ' |');
  p('| MAE against finals capped at ±35 (the engine\'s own objective) | ' + fmt(A.capped_mae_diff) + ' | ' + fmt(B.capped_mae_diff) + ' |');
  p('| mean \\|model − close\\|: raw → candidate (n ' + A.vs_close.n + ') | ' + A.vs_close.mean_abs_gap_raw + ' → ' + A.vs_close.mean_abs_gap_candidate + ' | ' + B.vs_close.mean_abs_gap_raw + ' → ' + B.vs_close.mean_abs_gap_candidate + ' |');
  p('| MAE on games with a close: close / raw / candidate | ' + A.vs_close.close_mae + ' / ' + A.vs_close.raw_mae + ' / ' + A.vs_close.candidate_mae + ' | ' + B.vs_close.close_mae + ' / ' + B.vs_close.raw_mae + ' / ' + B.vs_close.candidate_mae + ' |');
  p('| Brier, P(FBS wins): raw → candidate (guard) | ' + A.brier.raw + ' → ' + A.brier.candidate + ' ' + fmt(A.brier.diff, 5) + ' | ' + B.brier.raw + ' → ' + B.brier.candidate + ' ' + fmt(B.brier.diff, 5) + ' |');
  p('| repo bar (≥ 0.05 pts and a majority of years) | ' + (A.repo_bar.met ? 'met' : 'not met') + ' | ' + (B.repo_bar.met ? 'met' : 'not met') + ' |');
  p('');
  p('## By season');
  p('');
  p('| season | train | test | raw MAE | C1 MAE | C2 MAE | raw bias | C1 fit d | C2 fit a, b |');
  p('|---|---|---|---|---|---|---|---|---|');
  rep.seasons.forEach((s) => p('| ' + s.season + ' | ' + s.n_train + ' | ' + s.n_test + ' | ' + s.mae_raw + ' | ' + s.mae_C1_shift + ' | ' + s.mae_C2_affine + ' | ' + s.bias_raw + ' | ' + s.fit.C1_shift.a + ' | ' + s.fit.C2_affine.a + ', ' + s.fit.C2_affine.b + ' |'));
  p('');
  p('## The final map, and 2026 (descriptive)');
  p('');
  p('Final map (`' + rep.final_map.kind + '`, fitted on ' + rep.final_map.fitted_on + ', n ' + rep.final_map.n + '): FBS margin = ' + rep.final_map.a + ' + ' + rep.final_map.b + ' × engine margin.');
  p('');
  const C = rep.check_2026;
  p(C.note);
  p('');
  p('- 2026 replay: n ' + C.replay.n + ', MAE ' + C.replay.mae_raw + ' → ' + C.replay.mae_mapped + ', difference ' + fmt(C.replay.diff) + '.');
  if (C.bridge_rescored) {
    const B2 = C.bridge_rescored;
    p('- The FCS bridge (per-team FCS ratings, ' + B2.source + '), re-scored on **real** finals: n ' + B2.n + ' in ' + B2.clusters + ' weeks, MAE ' + B2.floor_mae + ' (floor) → ' + B2.bridge_mae + ' (bridge), difference ' + fmt(B2.uncapped_diff) + ' (' + B2.uncapped_verdict + '); on capped finals, the metric its own verdict used, ' + fmt(B2.capped_diff) + '. Per-team ordering, not a level, is what a map cannot supply.');
  }
  p('- 2026 live record (the published pick): n ' + C.live_record.n + ', MAE ' + C.live_record.mae_raw + ' → ' + C.live_record.mae_mapped + ', difference ' + fmt(C.live_record.diff) + '; mean |model − close| ' + C.live_record.vs_close.mean_abs_gap_raw + ' → ' + C.live_record.vs_close.mean_abs_gap_mapped + ' (n ' + C.live_record.vs_close.n + ').');
  p('');
  return o.join('\n');
}

if (require.main === module) {
  const rep = run();
  if (process.argv.includes('--write')) {
    fs.writeFileSync(path.join(ROOT, 'football', 'validation', 'fcs_uncapped_cfb.json'), JSON.stringify(rep, null, 1) + '\n');
    fs.writeFileSync(path.join(ROOT, 'football', 'cfb_p4', 'fcs_margin_map.js'), mapFile(rep));
    fs.writeFileSync(path.join(ROOT, 'docs', 'market-intelligence', 'FCS_UNCAPPED.md'), doc(rep) + '\n');
    console.log('wrote football/validation/fcs_uncapped_cfb.json, football/cfb_p4/fcs_margin_map.js, docs/market-intelligence/FCS_UNCAPPED.md');
  }
  console.log('H-014 ' + rep.status + ' — ' + rep.why);
  CANDS.forEach((c) => { const x = rep.pooled[c]; console.log(c.padEnd(10) + ' n ' + x.n + ' MAE ' + x.mae_raw + ' -> ' + x.mae_candidate + ' diff ' + fmt(x.mae_diff) + ' LOSO ' + x.leave_one_season_out.min + '..' + x.leave_one_season_out.max + ' better ' + x.seasons_better + '/' + x.seasons + ' brier ' + fmt(x.brier.diff, 5) + ' repo bar ' + x.repo_bar.met); });
  console.log('final map ' + JSON.stringify(rep.final_map) + ' | 2026 live ' + JSON.stringify(rep.check_2026.live_record.diff) + ' n ' + rep.check_2026.live_record.n);
}
module.exports = { run, load, fit, qnorm };
