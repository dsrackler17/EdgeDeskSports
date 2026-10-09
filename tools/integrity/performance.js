#!/usr/bin/env node
/* ============================================================================
   EdgeDesk — model performance monitoring (docs/system-integrity/RELIABILITY.md)

   Two kinds of evidence, never blended:

     LIVE-FORWARD  football/cfb_terminal/record.json — the number EdgeDesk
                   froze BEFORE kickoff, graded against the close and the
                   final. A row whose freeze time is not strictly before its
                   kickoff is excluded and counted (look-ahead guard).
     BACKTEST      football/validation/pricing_cfb.json — the shipped,
                   time-separated (walk-forward) validation, 2022–2025. Quoted
                   as published; never re-fitted here.

   It measures:
     - spread forecast error (MAE of the frozen fair line vs the final margin),
       beside the closing line's own error on the same games;
     - totals: reported as NOT MEASURED where the record freezes no total;
     - win-probability calibration (Brier score and buckets, Wilson 95% CI);
     - closing-line value where a trustworthy close exists (ESPN / Lab close);
     - every one of those by conference, by reliability band and by the size
       of the model-market discrepancy at the close.

   Every figure carries its n and a sample state. Nothing here claims an
   edge: ATS and CLV are printed with their intervals, and a theoretical EV is
   never a performance number.

   Usage:  node tools/integrity/performance.js            # write the JSON + Markdown
           node tools/integrity/performance.js --check    # print, write nothing
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const OUT_JSON = path.join(ROOT, 'football', 'validation', 'integrity_performance.json');
const OUT_MD = path.join(ROOT, 'docs', 'system-integrity', 'PERFORMANCE.md');

function readJson(p) { try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8')); } catch (e) { return null; } }
function num(x) { return typeof x === 'number' && isFinite(x) ? x : null; }
function r(x, d) { return num(x) == null ? null : Math.round(x * Math.pow(10, d == null ? 2 : d)) / Math.pow(10, d == null ? 2 : d); }
function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null; }
function wilson(k, n) {
  if (!n) return [null, null];
  const z = 1.96, p = k / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [r(100 * Math.max(0, c - h), 1), r(100 * Math.min(1, c + h), 1)];
}
function sampleState(n) { return n < 50 ? 'TOO EARLY (<50)' : (n < 200 ? 'EARLY SIGNAL (50–199)' : (n < 500 ? 'DEVELOPING (200–499)' : 'MEANINGFUL (500+)')); }

/* one block of graded rows → the measures */
function measure(rows) {
  const n = rows.length;
  const me = rows.map((x) => num(x.model_error)).filter((x) => x != null);
  const ce = rows.filter((x) => num(x.model_error) != null && num(x.close_error) != null);
  const ats = rows.filter((x) => x.ats === 'WON' || x.ats === 'LOST');
  const w = ats.filter((x) => x.ats === 'WON').length;
  const clv = rows.filter((x) => num(x.clv) != null && /espn|lab|close/i.test(String(x.close_source || '')));
  const wp = rows.filter((x) => num(x.win_prob) != null && (x.su_home_won === 0 || x.su_home_won === 1) && num(x.frozen_home_line) != null);
  /* win_prob is the favourite's; the favourite is the side the frozen line favours */
  const brier = wp.length ? mean(wp.map((x) => { const favHome = x.frozen_home_line < 0; const won = favHome ? x.su_home_won : 1 - x.su_home_won; return Math.pow(x.win_prob - won, 2); })) : null;
  return {
    n: n, sample: sampleState(n),
    spread: { n: me.length, model_mae: r(mean(me)), paired_n: ce.length, model_mae_paired: r(mean(ce.map((x) => x.model_error))), close_mae_paired: r(mean(ce.map((x) => x.close_error))),
      model_minus_close: ce.length ? r(mean(ce.map((x) => x.model_error)) - mean(ce.map((x) => x.close_error))) : null },
    ats: { n: ats.length, won: w, pct: ats.length ? r(100 * w / ats.length, 1) : null, ci95: wilson(w, ats.length), break_even_pct_at_minus110: 52.4 },
    clv: { n: clv.length, avg_points: clv.length ? r(mean(clv.map((x) => x.clv))) : null, positive_pct: clv.length ? r(100 * clv.filter((x) => x.clv > 0).length / clv.length, 1) : null,
      basis: 'points from the frozen number to a captured close (ESPN or the Model Lab); rows without a trustworthy close are excluded' },
    win_probability: { n: wp.length, brier: r(brier, 4), coin_flip_brier: 0.25 }
  };
}
function bandRel(x) { const v = num(x.reliability); return v == null ? 'unmeasured' : (v < 60 ? '<60 (limited)' : (v < 80 ? '60–79' : '80+')); }
function bandGap(x) { const g = num(x.frozen_home_line) != null && num(x.close_home_line) != null ? Math.abs(x.frozen_home_line - x.close_home_line) : null; return g == null ? 'no close' : (g < 2 ? '<2 pts' : (g < 7 ? '2–7 pts' : '7+ pts')); }
function by(rows, key) {
  const g = {};
  rows.forEach((x) => { const k = key(x); (g[k] = g[k] || []).push(x); });
  const out = {};
  Object.keys(g).sort().forEach((k) => { out[k] = measure(g[k]); });
  return out;
}

function build() {
  const rec = readJson('football/cfb_terminal/record.json');
  const all = (rec && rec.rows) || [];
  const graded = all.filter((x) => x.ats === 'WON' || x.ats === 'LOST' || x.ats === 'PUSH');
  const ok = graded.filter((x) => Date.parse(x.frozen_at) < Date.parse(x.kickoff));
  const leaked = graded.length - ok.length;
  const live = {
    kind: 'LIVE-FORWARD', source: 'football/cfb_terminal/record.json', generated_at: rec ? rec.generated_at : null,
    rule: 'the last pregame number EdgeDesk froze before kickoff, graded against the close and the final; versions never merged',
    look_ahead_guard: { graded: graded.length, used: ok.length, excluded_frozen_at_or_after_kickoff: leaked },
    model_versions: Array.from(new Set(ok.map((x) => x.model_version))),
    overall: measure(ok),
    by_conference: by(ok, (x) => x.conference || 'unknown'),
    by_reliability: by(ok, bandRel),
    by_gap_at_close: by(ok, bandGap),
    by_week: by(ok, (x) => 'week ' + ('0' + x.week).slice(-2)),
    totals: { measured: false, reason: 'the live record freezes the spread only; no pregame total is frozen and graded yet, so total forecast error is not measured (an open item, not a zero)' }
  };
  const bt = readJson('football/validation/pricing_cfb.json');
  const sp = bt && bt.markets && bt.markets.spread;
  const backtest = sp ? {
    kind: 'BACKTEST', source: 'football/validation/pricing_cfb.json', generated_at: bt.generated_at || null, frame: bt.frame || null,
    rule: 'time-separated walk-forward validation as shipped; quoted, never re-fitted here',
    n: sp.n, pooled: sp.pooled, by_disagreement: sp.by_disagreement, tier: sp.tier, tier_basis: sp.tier_basis,
    reading: 'out of sample the raw model’s error is larger than the closing line’s, and it grows with the size of the model-market disagreement; no disagreement threshold cleared break-even against the close'
  } : { kind: 'BACKTEST', available: false };
  const cal = readJson('football/cfb_ev/artifacts/cfb_ev_calibration_v1/calibration.json');
  const k = cal && cal.calibrators && cal.calibrators['cfb|spread|close'];
  return {
    schema: 'edgedesk_integrity_performance_v1', generated_at: new Date().toISOString(),
    never: 'a theoretical EV is not performance; no figure here is evidence of a profitable edge unless its interval excludes break-even on a meaningful sample',
    live_forward: live, backtest: backtest,
    calibration_monitor: k ? { calibrator: 'cfb|spread|close', status: k.status, maturity: k.maturity, method: k.method, map: k.map, oof: k.oof, holdout: k.holdout,
      reading: (k.map && k.map.T >= 1000) ? 'degenerate: the temperature maps every cover probability to 50% — it learned that the raw cover probabilities carry no information out of sample' : null } : null
  };
}

function md(o) {
  const L = [], lv = o.live_forward, ov = lv.overall;
  L.push('# Model performance monitoring (generated)', '');
  L.push('Generated ' + o.generated_at + ' by `node tools/integrity/performance.js`. **Live-forward and backtest evidence are reported separately and never blended.** ' + o.never + '.', '');
  L.push('## Live-forward (' + lv.source + ')', '');
  L.push('- Rule: ' + lv.rule + '.');
  L.push('- Look-ahead guard: ' + lv.look_ahead_guard.used + ' of ' + lv.look_ahead_guard.graded + ' graded games used; ' + lv.look_ahead_guard.excluded_frozen_at_or_after_kickoff + ' excluded (frozen at or after kickoff).');
  L.push('- Model versions: ' + lv.model_versions.join(', ') + '.', '');
  function row(name, m) { return '| ' + name + ' | ' + m.n + ' | ' + (m.spread.model_mae_paired == null ? '—' : m.spread.model_mae_paired) + ' | ' + (m.spread.close_mae_paired == null ? '—' : m.spread.close_mae_paired) + ' | ' + (m.ats.pct == null ? '—' : m.ats.pct + '% [' + m.ats.ci95.join('–') + ']') + ' | ' + (m.clv.avg_points == null ? '—' : m.clv.avg_points + ' (n ' + m.clv.n + ')') + ' | ' + (m.win_probability.brier == null ? '—' : m.win_probability.brier) + ' | ' + m.sample + ' |'; }
  const head = ['| Group | n | Model MAE | Close MAE | ATS [95% CI] | CLV pts | Win-prob Brier | Sample |', '|---|---|---|---|---|---|---|---|'];
  L.push('### Overall', ''); L.push.apply(L, head); L.push(row('all', ov), '');
  [['By reliability band', lv.by_reliability], ['By model-market gap at the close', lv.by_gap_at_close], ['By conference', lv.by_conference]].forEach(([t, g]) => {
    L.push('### ' + t, ''); L.push.apply(L, head); Object.keys(g).forEach((k) => L.push(row(k, g[k]))); L.push('');
  });
  L.push('- Totals: ' + lv.totals.reason + '.', '');
  const bt = o.backtest;
  L.push('## Backtest (' + (bt.source || 'unavailable') + ')', '');
  if (bt.n) {
    L.push('- ' + bt.rule + '. Frame: ' + JSON.stringify(bt.frame) + '.');
    L.push('- Pooled (n ' + bt.n + '): model MAE ' + bt.pooled.model_mae + ' vs close MAE ' + bt.pooled.close_mae + '.');
    L.push('', '| Disagreement | n | Raw MAE | Market MAE | ATS (raw, 1+ pt) |', '|---|---|---|---|---|');
    ['lt3', '3_7', '7_14', 'ge14'].forEach((k) => { const d = bt.by_disagreement[k]; if (d) L.push('| ' + k.replace('_', '–').replace('lt', '<').replace('ge', '≥') + ' | ' + d.n + ' | ' + d.mae_raw + ' | ' + d.mae_market + ' | ' + (d.ats_raw_1plus ? d.ats_raw_1plus.win_pct + '% (n ' + d.ats_raw_1plus.n + ')' : '—') + ' |'); });
    L.push('', '- Tier: **' + bt.tier + '**: ' + bt.tier_basis + '.', '- Reading: ' + bt.reading + '.', '');
  }
  const c = o.calibration_monitor;
  if (c) L.push('## Calibration monitor', '', '- `' + c.calibrator + '`: ' + c.status + ' / ' + c.maturity + ', ' + c.method + ' ' + JSON.stringify(c.map) + '.', '- Out of sample: ' + JSON.stringify(c.oof) + '.', '- Reading: ' + (c.reading || 'not degenerate') + '.', '');
  return L.join('\n') + '\n';
}

if (require.main === module) {
  const o = build();
  if (process.argv.indexOf('--check') >= 0) { console.log(JSON.stringify({ live: o.live_forward.overall, guard: o.live_forward.look_ahead_guard }, null, 1)); process.exit(0); }
  fs.writeFileSync(OUT_JSON, JSON.stringify(o, null, 1) + '\n');
  fs.writeFileSync(OUT_MD, md(o));
  console.log('wrote ' + path.relative(ROOT, OUT_JSON) + ' and ' + path.relative(ROOT, OUT_MD));
}
module.exports = { build, measure, md };
