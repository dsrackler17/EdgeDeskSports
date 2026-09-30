#!/usr/bin/env node
/* ============================================================================
   THE CLOSING-LINE-VALUE REPORT (audit 2026-09-30 follow-up #5):
   tools/football/clv_report.js -> football/validation/clv_report.json.
     1  the sign conventions (home margins; the side is EdgeDesk's vs the opener)
     2  the summary's arithmetic and its "too small to read" floor
     3  the artifact: the engine's held-out window is the headline, the tune
        season is never pooled into it, nothing is fitted, the market is no input
     4  the audit's own cuts: 2+ / 3+ / 5+ to the opener, split by the v1 regime
        flag and by the regime curve's fitted research minimum (nothing chosen
        here), and said to be unavailable where a sample carries no flags

     node tools/football/clv_report.test.js
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const CR = require(path.join(__dirname, 'clv_report.js'));

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { detail = String(e && e.stack || e).slice(0, 400); ok = false; } }
  if (ok) { pass++; return; }
  fail++; failures.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : ''));
}
function section(t) { console.log('  · ' + t); }
const near = (a, b, tol) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= (tol == null ? 1e-9 : tol);

section('1. the sign conventions');
{
  const up = CR.clvOf('CFB', { fair: 10, open: 6, close: 7.5 });
  chk('EdgeDesk above the opener on the home margin leans HOME, and a close that rises is +CLV', up.side === 'home' && near(up.pts, 1.5) && up.prob > 0, up);
  const away = CR.clvOf('CFB', { fair: -3, open: 2, close: 3 });
  chk('EdgeDesk below the opener leans AWAY, and a close that rises is −CLV (the market went the other way)', away.side === 'away' && near(away.pts, -1) && away.prob < 0, away);
  chk('under half a point from the opener there is no side, so no CLV', CR.clvOf('CFB', { fair: 6.3, open: 6, close: 9 }) === null);
  chk('a missing opener or close is no CLV, never zero', CR.clvOf('CFB', { fair: 6, open: null, close: 7 }) === null && CR.clvOf('CFB', { fair: 6, open: 3, close: null }) === null);
  const nfl = CR.clvOf('NFL', { fair: 7, open: 3, close: 3.5 });
  chk('the NFL prices the opener on its own margin distribution (a +0.5 move through no key number is a small, positive price value)', nfl.side === 'home' && nfl.prob > 0 && nfl.prob < 0.05, nfl);
  chk('no move, no price value', near(CR.clvOf('CFB', { fair: 9, open: 3, close: 3 }).prob, 0, 1e-12));
}

section('2. the summary');
{
  const list = [{ pts: 1, prob: 0.02 }, { pts: -0.5, prob: -0.01 }, { pts: 0, prob: 0 }, { pts: 2, prob: 0.03 }];
  const s = CR.summarize(list);
  chk('moved = games whose close differs from the opener; toward = those that moved to EdgeDesk', s.games === 4 && s.moved === 3 && s.moved_toward === 2 && near(s.toward_rate, 0.6667, 1e-4));
  chk('mean CLV is over every game with a side (no-moves count as zero)', near(s.mean_clv_pts, 0.625, 1e-3));
  chk('under the floor it says "too small to read", whatever the rate', s.readable === false && /too small to read/.test(s.reading));
  chk('the two-sided binomial p is symmetric and 1 at an even split', CR.binomTwoSided(50, 100) === 1 && near(CR.binomTwoSided(60, 100), CR.binomTwoSided(40, 100), 1e-12) && CR.binomTwoSided(60, 100) < 0.06);
}

section('3. the artifact');
{
  const A = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'validation', 'clv_report.json'), 'utf8'));
  chk('nothing is fitted and the market is never an input', /nothing/.test(A.fitted) && A.market_is_an_input === false);
  chk('the headline is the engine\'s held-out window (2022-2025; hyperparameters tuned 2018-2021)', A.rules.headline_seasons.join('-') === '2022-2025' && A.rules.tune_seasons.join('-') === '2018-2021'
    && Object.keys(A.samples.cfb_replay_2022_2025.by_season).every((s) => +s >= 2022 && +s <= 2025));
  chk('2021 (the tune window) is reported on its own and never pooled into the headline', Object.keys(A.samples.cfb_replay_2021.by_season).join() === '2021' && /IN-SAMPLE/.test(A.samples.cfb_replay_2021.what));
  chk('the NFL sample is EdgeDesk\'s own 2026 opener ledger (no historical archive exists) and is marked unreadable below the floor',
    /opener ledger/.test(A.samples.nfl_2026.what) && (A.samples.nfl_2026.all.moved >= A.rules.min_moved_to_read || A.samples.nfl_2026.all.readable === false));
  chk('every sample reports all four gap buckets', Object.values(A.samples).every((s) => Object.keys(s.by_bucket).length === A.rules.buckets.length));
  chk('the headline reading follows its own numbers', (() => { const x = A.samples.cfb_replay_2022_2025.all;
    return x.readable && (x.p_two_sided < 0.05 ? /TOWARD|AWAY/.test(x.reading) : /coin flip/.test(x.reading)); })());
}

section('4. the audit\'s cuts');
{
  const g = (gap, pts, rh, ra, gh, ga) => ({ g: { regime: { home: rh, away: ra }, games_played: { home: gh, away: ga } }, c: { gap, pts, prob: 0 } });
  const N = CR.RULES.min_games_for_research;
  const scored = [g(2.5, 1, true, false, 2, 7), g(3.5, -1, false, false, 8, 9), g(6, 2, false, null, N, N), g(8, 1, false, false, N - 1, 10), g(1, 1, false, false, 9, 9)];
  const T = CR.thresholdCuts(scored);
  chk('the thresholds are cumulative: 2+ holds 3+ holds 5+', T['2+'].all.games === 4 && T['3+'].all.games === 3 && T['5+'].all.games === 2);
  chk('regime-flagged = either side fires; not flagged = both measured and neither fires; the rest is counted as unknown',
    T['2+'].regime.games === 1 && T['2+'].not_regime.games === 2 && T['2+'].regime_unknown_games === 1);
  chk('games played splits at the regime curve\'s fitted minimum (the smaller side\'s count)', T['2+']['before_' + N + '_games'].games === 2 && T['2+']['from_' + N + '_games'].games === 2);
  chk('rows with no flags are not split, and say so', /not available/.test(CR.thresholdCuts([{ g: {}, c: { gap: 3, pts: 1, prob: 0 } }])['2+'].split));

  const RCV = require(path.join(ROOT, 'football', 'cfb_p4', 'regime_curve.js'));
  const A = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'validation', 'clv_report.json'), 'utf8'));
  chk('the artifact\'s cuts are the audit\'s (2, 3, 5) and the minimum is the curve\'s own, not chosen here',
    A.rules.thresholds.join(',') === '2,3,5' && A.rules.min_games_for_research === RCV.min_games_for_research);
  ['cfb_replay_2022_2025', 'cfb_replay_2021'].forEach((k) => {
    const T2 = A.samples[k].by_threshold;
    chk(k + ': every threshold is split by regime and by games played, and the parts add up', ['2+', '3+', '5+'].every((t) => {
      const o = T2[t]; if (!o || !o.regime) return false;
      return o.regime.games + o.not_regime.games + o.regime_unknown_games === o.all.games
        && o['before_' + A.rules.min_games_for_research + '_games'].games + o['from_' + A.rules.min_games_for_research + '_games'].games === o.all.games;
    }) && T2['2+'].all.games >= T2['3+'].all.games && T2['3+'].all.games >= T2['5+'].all.games);
  });
  chk('the 2026 samples carry no flags and say the split is unavailable', ['cfb_2026', 'nfl_2026'].every((k) => ['2+', '3+', '5+'].every((t) => /not available/.test(A.samples[k].by_threshold[t].split || ''))));
  chk('a toward-rate over 60% on a readable cut would need a leakage review first: none is readable over 60%',
    Object.values(A.samples).every((smp) => Object.values(smp.by_threshold).every((o) => Object.keys(o).every((kk) => { const x = o[kk]; return !(x && x.readable && x.toward_rate > 0.6); }))));
}

console.log((fail ? 'FAILED ' : 'ALL GREEN ') + 'CLV report — ' + pass + ' passed, ' + fail + ' failed');
if (fail) { failures.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
