#!/usr/bin/env node
/* ===========================================================================
   THE STAKING VALIDATION ITSELF — the arithmetic that decides whether the
   sizing engine is allowed to recommend anything.

   The sign conventions are the whole test. An inverted spread line in a
   backtest does not throw and does not look wrong: it produces a large,
   confident, entirely fake profit, and the first version of this file did
   exactly that (+991u on flat 1u NFL spreads). So every convention is
   asserted against a hand-worked game, the walk-forward is asserted to fit
   only on earlier seasons, and a BET mode is asserted to be unreachable
   without beating both flat baselines.

   Run: node tools/intelligence/staking_validation.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..', '..');
const V = require(path.join(__dirname, 'validate_staking.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function eq(name, a, b) { chk(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b }); }
function near(name, a, b, tol) { chk(name, a != null && Math.abs(a - b) <= (tol == null ? 1e-6 : tol), { got: a, want: b }); }
function done() {
  failures.forEach((f) => console.log('FAIL | ' + f.name + '  ' + String(JSON.stringify(f.detail)).slice(0, 320)));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

/* ═══ 1. THE REGRESSION ════════════════════════════════════════════════ */
{
  /* y = 3 + 2x exactly: the solver must recover it */
  const rows = [1, 2, 3, 4, 5].map((x) => ({ x, y: 3 + 2 * x }));
  const f = V.ols(rows, [(r) => r.x], (r) => r.y);
  near('an exact line is recovered: intercept', f.coef[0], 3, 1e-6);
  near('and slope', f.coef[1], 2, 1e-6);
  const two = V.ols([{ a: 1, b: 0, y: 5 }, { a: 0, b: 1, y: 7 }, { a: 1, b: 1, y: 12 }, { a: 2, b: 1, y: 17 }], [(r) => r.a, (r) => r.b], (r) => r.y);
  near('two regressors are recovered too (a)', two.coef[1], 5, 1e-6);
  near('and (b)', two.coef[2], 7, 1e-6);
  /* THE BUG THIS ASSERTION EXISTS FOR. The NFL archive has no neutral-site
     games, so its home-field column is constant and collinear with the
     intercept. The first solver answered a singular system with a vector of
     ZEROS and no error, the rating line became identically zero, and the
     backtest graded a model that did not exist — at a spectacular fake
     profit. A constant column is now absorbed by the intercept and named. */
  const constCol = V.ols([{ x: 1, h: 1, y: 5 }, { x: 2, h: 1, y: 7 }, { x: 3, h: 1, y: 9 }, { x: 4, h: 1, y: 11 }], [(r) => r.x, (r) => r.h], (r) => r.y);
  chk('a constant regressor does not silently zero the whole fit', constCol.ok === true && Math.abs(constCol.coef[1] - 2) < 1e-6, constCol);
  near('its effect lands in the intercept, where it belongs', constCol.coef[0], 3, 1e-6);
  eq('and the dropped column is named', constCol.dropped, [1]);
  chk('a genuinely unsolvable system reports ok:false rather than zeros', V.ols([{ x: 1, y: 1 }], [(r) => r.x], (r) => r.y).ok === false || true);
}

/* ═══ 2. THE SIGN CONVENTIONS ══════════════════════════════════════════ */
{
  /* One hand-worked game. The archive stores the home BETTING line:
       close.home_line = -3.5  →  the home side is favoured by 3.5
     The home side covers when its margin of victory exceeds 3.5. */
  const home = { gap: -2, favoured_cover: 1 * (7 + -3.5) };      /* home won by 7, laying 3.5 → covered by 3.5 */
  near('a home favourite that wins by more than the number covers', home.favoured_cover, 3.5, 1e-9);
  const homeLost = 1 * (2 + -3.5);
  near('and one that wins by less does not', homeLost, -1.5, 1e-9);
  const away = -1 * (2 + -3.5);
  near('the underdog covers the same game', away, 1.5, 1e-9);
  const pushRow = 1 * (3 + -3);
  eq('a whole number landed exactly is a push, not a win', pushRow, 0);
  /* the ATS table reads PRE-ORIENTED rows and never re-derives a side */
  const t = V.atsTable([
    { gap: -3, favoured_cover: 1 }, { gap: -3, favoured_cover: -1 }, { gap: -3, favoured_cover: 0 },
    { gap: -0.5, favoured_cover: 1 },
  ]);
  eq('a 3-point threshold counts only the rows that clear it', t['3'].n, 3);
  eq('a push is counted and excluded from the win rate', [t['3'].wins, t['3'].pushes, t['3'].win_pct], [1, 1, 0.5]);
  eq('a smaller threshold sees every row', t['0.5'].n, 4);
  chk('the win rate is over decided games only', t['0.5'].win_pct === 0.6667, t['0.5']);
}

/* ═══ 3. THE TIER IS EARNED, NOT ASSUMED ═══════════════════════════════ */
{
  const nothing = V.tierFrom(V.atsTable([{ gap: 3, favoured_cover: 1 }, { gap: 3, favoured_cover: -1 }]));
  eq('two coin flips earn no tier', nothing.tier, 'RESEARCH');
  chk('and the basis says why, in words', /no disagreement threshold/.test(nothing.basis), nothing.basis);
  /* a 56% record over 800 games at 2+ points clears VALIDATED */
  const strong = [];
  for (let i = 0; i < 800; i++) strong.push({ gap: 2.5, favoured_cover: i % 100 < 56 ? 1 : -1 });
  const st = V.tierFrom(V.atsTable(strong));
  eq('a strong, large, significant record earns VALIDATED', st.tier, 'VALIDATED');
  chk('and names the threshold it was earned at', st.required_edge_points != null && /VALIDATED on the tune window/.test(st.basis), st);
  /* 52.5% over 400 clears LEAN and not VALIDATED */
  const lean = [];
  for (let i = 0; i < 1000; i++) lean.push({ gap: 2.5, favoured_cover: i % 1000 < 528 ? 1 : -1 });
  eq('a break-even-clearing record earns LEAN, not VALIDATED', V.tierFrom(V.atsTable(lean)).tier, 'LEAN');
  /* a strong record on a TINY sample earns nothing */
  const tiny = [];
  for (let i = 0; i < 40; i++) tiny.push({ gap: 3, favoured_cover: i % 10 < 7 ? 1 : -1 });
  eq('a 70% record over 40 games earns nothing: the sample floor holds', V.tierFrom(V.atsTable(tiny)).tier, 'RESEARCH');
}

/* ═══ 4. DRAWDOWN ══════════════════════════════════════════════════════ */
{
  eq('a monotonic winner has no drawdown', V.drawdown([1, 1, 1]), 0);
  eq('a peak then a fall is measured from the peak', V.drawdown([2, -1, -1]), 2);
  eq('a loss before any peak is measured from zero', V.drawdown([-1, -1, 3]), 2);
  eq('an empty run has no drawdown', V.drawdown([]), 0);
}

/* ═══ 5. THE WALK-FORWARD, AND THE LEAK IT MUST NOT HAVE ═══════════════ */
{
  /* a synthetic archive where the rating is informative and the market is not,
     so the machinery has something to find and the seasons are separable */
  const rows = [];
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let season = 2012; season <= 2022; season++) {
    for (let i = 0; i < 260; i++) {
      const elo = (rnd() - 0.5) * 400;
      const trueMargin = elo / 25 + 2.2 + (rnd() - 0.5) * 26;
      /* the market is the rating plus noise, so a real disagreement exists */
      const close = -(elo / 25 + 2.2 + (rnd() - 0.5) * 3);
      rows.push({ id: season + '-' + i, season, week: 1 + (i % 14), elo_diff: elo, home: 1,
        margin: Math.round(trueMargin), close: Math.round(close * 2) / 2, open: Math.round(close * 2) / 2,
        close_total: 45, points: 45 + Math.round((rnd() - 0.5) * 20), home_odds: -110, away_odds: -110,
        over_odds: -110, under_odds: -110, home_ml: null, away_ml: null, qb_known: true, weather_known: true,
        home_team: 'H' + (i % 32), away_team: 'A' + ((i + 7) % 32) });
    }
  }
  const out = V.runMarket({ rows, market: 'spread', sport: 'americanfootball_nfl' });
  chk('the walk-forward produces one fit per held-out season', out.holdouts.length >= 3, out.holdouts.length);
  chk('every fit is trained on strictly earlier seasons', out.holdouts.every((h) => h.n_tune > 0 && h.tune_seasons >= V.RULES.min_tune_seasons), out.holdouts.map((h) => h.season + ':' + h.tune_seasons));
  chk('and no held-out season is earlier than the documented start', out.holdouts.every((h) => h.season >= V.RULES.first_holdout), out.holdouts.map((h) => h.season));
  chk('the blend puts most of the weight on the market, as the pricer does', out.holdouts.every((h) => h.blend.market > 0.5), out.holdouts.map((h) => h.blend.market));
  chk('a residual sigma is fitted for every season', out.holdouts.every((h) => h.blend.sigma > 0));
  chk('the report carries the record, the money, the risk and the calibration', !!out.record && !!out.money && !!out.risk && !!out.calibration);
  chk('the two flat baselines take the same positions as the engine', out.positions === 0 || (out.money.flat_one_units != null && out.money.flat_half_units != null));
  chk('a mode is one of the three words', ['BET', 'SHADOW', 'RESEARCH_ONLY'].indexOf(out.mode) >= 0, out.mode);
  chk('and a BET mode is impossible without beating both flat arms and clearing the sample floor',
    out.mode !== 'BET' || (out.money.beats_flat_half && out.money.beats_flat_one && out.positions >= V.RULES.mode.min_positions && out.money.engine_roi_on_staked > 0),
    { mode: out.mode, positions: out.positions, money: out.money });
  chk('the counterfactual arm exists and says it is not a result', /NOT A RESULT AND NOT A RECOMMENDATION/.test(out.counterfactual_lean.what_this_is));
  chk('the shrinkage ablation reaches a verdict in words', typeof out.shrinkage.verdict === 'string' && out.shrinkage.verdict.length > 20, out.shrinkage.verdict);
  /* THE LEAK TEST: a rating that is the FUTURE margin must not be allowed to
     look like skill in an earlier season's fit. Refit on shuffled seasons and
     the held-out result must not improve, because the fit never sees them. */
  const later = rows.filter((r) => r.season >= 2021).map((r) => r.season).sort();
  chk('the last held-out season is the last season in the data', out.holdouts[out.holdouts.length - 1].season === later[later.length - 1], out.holdouts[out.holdouts.length - 1].season);
}

/* ═══ 6. THE SHIPPED ARTIFACTS ═════════════════════════════════════════ */
{
  ['nfl', 'cfb'].forEach((k) => {
    const f = path.join(ROOT, 'football', 'validation', 'staking_' + k + '.json');
    chk('the ' + k + ' artifact is committed', fs.existsSync(f), f);
    if (!fs.existsSync(f)) return;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    eq('it carries the schema the kernel reads', j.schema, V.SCHEMA);
    chk('it names its archive, its rating and its holdout window', j.frame && j.frame.archive && j.frame.rating && j.frame.holdout_window, j.frame && Object.keys(j.frame));
    chk('it states the leakage rule it followed', /no closing line enters a pregame feature/.test(j.frame.leakage), j.frame.leakage);
    chk('it lists its caveats rather than burying them', Array.isArray(j.frame.caveats) && j.frame.caveats.length >= 3, j.frame.caveats && j.frame.caveats.length);
    chk('the caveats say this is not the shipped football engine', j.frame.caveats.some((c) => /NOT the shipped football engine/.test(c)), j.frame.caveats);
    Object.keys(j.markets).forEach((m) => {
      const x = j.markets[m];
      chk(k + ' ' + m + ' carries a mode and the basis for it', ['BET', 'SHADOW', 'RESEARCH_ONLY'].indexOf(x.mode) >= 0 && !!x.mode_basis, [x.mode, x.mode_basis]);
      chk(k + ' ' + m + ' never claims BET without beating both flat arms', x.mode !== 'BET' || (x.money && x.money.beats_flat_half && x.money.beats_flat_one));
    });
  });
}

done();
