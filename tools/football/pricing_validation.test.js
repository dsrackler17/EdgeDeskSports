#!/usr/bin/env node
/* ===========================================================================
   THE CLOSING-LINE ARCHIVE AND THE PRICING VALIDATION: the archive copies
   with the sign convention explicit; the validation grades a pick rule on
   held-out games, names a tier by the rules it prints, and never calls a
   break-even record a profit. Synthetic rows, labelled as such.

   Run: node tools/football/pricing_validation.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const A = require(path.join(ROOT, 'tools', 'football', 'build_lines_archive.js'));
const V = require(path.join(ROOT, 'tools', 'football', 'validate_pricing.js'));

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function done() { failures.forEach((f) => console.log('FAIL | ' + f.name + '  ' + String(JSON.stringify(f.detail)).slice(0, 300))); console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed'); process.exit(fail === 0 ? 0 : 1); }

/* ---- the archive ------------------------------------------------------- */
const HEAD = A.COLS.join(',');
const row = (o) => A.COLS.map((c) => (o[c] == null ? '' : o[c])).join(',');
const CSV = [HEAD,
  row({ game_id: '2025_01_DAL_PHI', season: 2025, game_type: 'REG', week: 1, gameday: '2025-09-04', gametime: '20:20', away_team: 'DAL', away_score: 20, home_team: 'PHI', home_score: 24, result: 4, total: 44, overtime: 0, away_rest: 7, home_rest: 7, away_moneyline: 330, home_moneyline: -425, spread_line: 8.5, away_spread_odds: -110, home_spread_odds: -110, total_line: 47.5, under_odds: -110, over_odds: -110, div_game: 1, roof: 'outdoors', surface: 'grass', temp: 75, wind: 11, away_qb_id: 'a', home_qb_id: 'h', stadium: 'Lincoln Financial Field' }),
  row({ game_id: '2025_01_KC_LAC', season: 2025, game_type: 'REG', week: 1, gameday: '2025-09-05', away_team: 'KC', home_team: 'LAC', away_score: 21, home_score: 27, result: 6, total: 48, spread_line: -3, total_line: 47.5, home_moneyline: 145, away_moneyline: -175, roof: 'dome' }),
  row({ game_id: '2026_10_X_Y', season: 2026, game_type: 'REG', week: 10, away_team: 'X', home_team: 'Y' }),
  row({ game_id: '2026_01_A_B', season: 2026, game_type: 'REG', week: 1, away_team: 'A', home_team: 'B', spread_line: 2.5, total_line: 41 }),
].join('\n');
const art = A.build(CSV, { now: '2026-09-16T00:00:00.000Z', retrieved_at: '2026-09-16T00:00:00.000Z' });
chk('a game without a close is not an archive row', art.counts.games === 3 && art.seasons[2026].games === 2 && art.seasons[2026].with_close === 1);
const phi = art.games.find((g) => g.id === '2025_01_DAL_PHI');
chk('the home line is the negative of spread_line: PHI favoured by 8.5 lays -8.5', phi.close.home_line === -8.5 && phi.margin === 4 && phi.home_score === 24, phi.close);
chk('a home underdog carries a positive home line', art.games.find((g) => g.id === '2025_01_KC_LAC').close.home_line === 3);
chk('the cover rule in the convention string reconciles with the row (4 + -8.5 < 0: PHI did not cover)', /margin \+ home_line > 0/.test(art.sign_convention) && phi.margin + phi.close.home_line < 0);
chk('context is copied, not derived', phi.ctx.roof === 'outdoors' && phi.ctx.temp === 75 && phi.ctx.wind === 11 && phi.ctx.divisional === true && phi.ctx.home_qb_id === 'h');
chk('an unplayed game with a close is kept with a null margin', art.games.find((g) => g.id === '2026_01_A_B').margin === null && art.counts.played === 2);
chk('the source names the feed and the retrieval time', /nflverse/.test(art.source.url) && art.source.retrieved_at === '2026-09-16T00:00:00.000Z');
chk('the archive says it prices nothing', /prices nothing/.test(art.note));

/* ---- the validation's arithmetic ---------------------------------------- */
const fit = V.ols([{ x: 1, y: 3 }, { x: 2, y: 5 }, { x: 3, y: 7 }, { x: 4, y: 9.2 }], [(r) => r.x], (r) => r.y);
chk('least squares recovers a line', Math.abs(fit.coef[1] - 2.06) < 0.05 && Math.abs(fit.coef[0] - 0.9) < 0.15, fit.coef);
/* synthetic graded rows: model favours home by gap; home covers 60% when gap >= 2, 50% otherwise */
const rows = []; let k = 0;
for (let s = 2016; s <= 2025; s++) for (let i = 0; i < 300; i++) { k++; const gap = (i % 3 === 0) ? 3 : 1; const covers = gap === 3 ? (i % 5 !== 0) : (i % 2 === 0); rows.push({ season: s, close: 0, model: gap, margin: covers ? 7 : -7 }); }
const t = V.atsTable(rows, (r) => r.close, (r) => r.model - r.close, (r) => r.margin - r.close);
chk('the pick rule grades wins by threshold', t['3'].n === 1000 && t['3'].win_pct === 0.8 && t['1'].n === 3000 && Math.abs(t['1'].win_pct - 0.6) < 0.01, t['3']);
chk('pushes are excluded, not counted as losses', V.atsTable([{ season: 2020, close: 0, model: 2, margin: 0 }], (r) => r.close, (r) => r.model, (r) => r.margin)['1'].pushes === 1);
const [tier, edge] = V.requiredEdge(t, t);
chk('a record a point above break-even with p < 0.01 in most seasons is VALIDATED at the smallest such threshold', tier === 'VALIDATED' && edge === 0.5, [tier, edge]);
const leanRows = rows.map((r, i) => Object.assign({}, r, { margin: (i % 100) < 53 ? 7 : -7 }));
const lt = V.atsTable(leanRows, (r) => r.close, (r) => r.model - r.close, (r) => r.margin - r.close);
const [lTier, lEdge] = V.requiredEdge(lt, lt);
chk('a 53% record is LEAN, never VALIDATED', lTier === 'LEAN' && lEdge === 0.5, [lTier, lEdge, lt['0.5']]);
const coin = rows.map((r, i) => Object.assign({}, r, { margin: i % 2 ? 7 : -7 }));
chk('a coin flip earns no tier', V.requiredEdge(V.atsTable(coin, (r) => r.close, (r) => r.model - r.close, (r) => r.margin - r.close))[0] === null);
chk('a record that fails on the later sub-window is refused', V.requiredEdge(t, V.atsTable(coin, (r) => r.close, (r) => r.model - r.close, (r) => r.margin - r.close))[0] === null);
const cal = V.calibration([[0.55, 1], [0.55, 0], [0.55, 1], [0.45, 0], [0.45, 0], [0.5, 1]]);
chk('calibration buckets state predicted vs observed', cal.buckets.some((b) => b.bucket === '0.52-0.6' && b.n === 3 && Math.abs(b.observed - 0.667) < 0.01) && cal.brier > 0.2 && cal.brier < 0.26, cal);
chk('the rules print the multiple-comparison allowance', /seven thresholds/.test(V.RULES.multiple_comparisons) && V.RULES.validated.p_max === 0.01);

/* ---- the feature intake ---------------------------------------------------- */
const ctxRows = []; let seed = 7;
const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
for (let s = 2016; s <= 2025; s++) for (let i = 0; i < 260; i++) { const dome = i % 4 === 0; const close = Math.round((rnd() - 0.5) * 20); const noise = (rnd() + rnd() + rnd() - 1.5) * 14; ctxRows.push({ season: s, close, model: close + (rnd() - 0.5) * 4, margin: close + noise + (dome ? 3 : 0), ctx: { dome, temp: dome ? null : 30 + rnd() * 50, wind: rnd() * 20, rest_diff: 0, divisional: i % 2 === 0, grass: true, qb_known: true } }); }
const arms = V.featureArms(ctxRows, 'spread');
chk('every candidate arm carries a status, the held-out seasons and its reasons', Object.keys(arms).length === 6 && Object.values(arms).every((a) => /VALIDATED|CANDIDATE|REJECTED/.test(a.status) && a.holdout_seasons.length >= 5 && Array.isArray(a.reasons)), Object.keys(arms));
chk('a planted three-point dome effect is VALIDATED with a positive coefficient near three', arms.dome.status === 'VALIDATED' && arms.dome.latest_coef > 2 && arms.dome.latest_coef < 4 && arms.dome.pooled_improvement_mae > 0.02 && arms.dome.paired_p < 0.05, arms.dome);
chk('an absent effect is REJECTED with its reasons named', arms.rest_diff.status === 'REJECTED' && arms.rest_diff.reasons.length >= 1, arms.rest_diff);
const pt = V.pairedT([1, 2, 3, 4, 5].concat(new Array(40).fill(3)), [1, 2, 3, 4, 5].concat(new Array(40).fill(3)));
chk('a paired test on identical errors is not significant', pt.p == null || pt.p > 0.5, pt);
const fsArt = V.featureStatus({ rows: ctxRows });
chk('the feature status file says a validated arm is a reviewed change, never applied here', /never an edit made here/.test(fsArt.note) && fsArt.arms.spread && fsArt.arms.total);
const onDisk = path.join(ROOT, 'football', 'validation', 'feature-status-nfl.json');
if (fs.existsSync(onDisk)) { const f = JSON.parse(fs.readFileSync(onDisk, 'utf8')); chk('the committed NFL feature status carries the rules and every arm\'s reasons', f.rules.min_holdout_seasons === 2 && Object.values(f.arms.spread).every((a) => a.reasons.length > 0 || a.status === 'VALIDATED')); }

/* ---- the artifacts on disk --------------------------------------------- */
for (const sport of ['nfl', 'cfb']) {
  const p = path.join(ROOT, 'football', 'validation', 'pricing_' + sport + '.json');
  if (!fs.existsSync(p)) { chk('pricing_' + sport + '.json is on disk', false); continue; }
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  chk(sport + ': every market carries a tier and a basis', ['spread', 'total', 'moneyline'].every((m) => j.markets[m] && /VALIDATED|LEAN|PROBABILITY|RESEARCH/.test(j.markets[m].tier) && j.markets[m].tier_basis), Object.keys(j.markets));
  chk(sport + ': a LEAN or RESEARCH tier never says profit', ['spread', 'total', 'moneyline'].every((m) => j.markets[m].tier === 'VALIDATED' || !/profit(?!\b, and it is not yet)/.test(j.markets[m].tier_basis.replace('not yet a profit', ''))));
  chk(sport + ': the frame names its window and source', j.frame && (j.frame.eval_window || j.frame.source));
}
const nfl = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'validation', 'pricing_nfl.json'), 'utf8'));
chk('the NFL spread tier is stated with the model and the close MAE side by side', nfl.markets.spread.pooled.model_mae > nfl.markets.spread.pooled.close_mae && nfl.markets.spread.blend.holdouts.length >= 5);
chk('the NFL frame discards the shipped seeds', /seeds discarded/.test(nfl.frame.replay));
done();
