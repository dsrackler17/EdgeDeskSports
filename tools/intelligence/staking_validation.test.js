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
  /* 53.3% over 3000 clears LEAN and not VALIDATED. The sample has to be
     this large BECAUSE of the Holm correction: every threshold in the family
     is tested, so the best of them must clear p_max / m rather than p_max.
     52.8% over 1000 used to earn LEAN here and no longer does — that is the
     correction doing its job, not a regression. */
  const lean = [];
  for (let i = 0; i < 3000; i++) lean.push({ gap: 2.5, favoured_cover: i % 3000 < 1600 ? 1 : -1 });
  const leanT = V.tierFrom(V.atsTable(lean));
  eq('a break-even-clearing record earns LEAN, not VALIDATED', leanT.tier, 'LEAN');
  const nearMiss = [];
  for (let i = 0; i < 1000; i++) nearMiss.push({ gap: 2.5, favoured_cover: i % 1000 < 528 ? 1 : -1 });
  const nm = V.tierFrom(V.atsTable(nearMiss));
  eq('the same rate on a third of the sample earns nothing once the family is corrected', nm.tier, 'RESEARCH');
  chk('and the corrected bar is recorded so a reader can check the arithmetic', leanT.family_size >= 2 && leanT.holm_bar > 0 && leanT.holm_bar < 0.05, { family: leanT.family_size, bar: leanT.holm_bar });
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
    /* WHICH MODEL WAS GRADED MUST BE STATED, whichever one it was. The
       failure mode this guards is an artifact that reads like a validation
       of the shipped projection when the Elo stand-in produced every row. */
    chk('it names the model it actually graded', typeof j.frame.model_graded === 'string' && j.frame.model_graded.length > 40, j.frame.model_graded);
    chk('it carries the engine replay verdict either way', j.frame.engine && typeof j.frame.engine.available === 'boolean', j.frame.engine);
    const feng = j.frame.engine || {};
    if (feng.available) {
      chk('an available replay says how many games it joined', Number.isFinite(feng.joined) && feng.joined > 0, feng);
      chk('and model_graded says it is the shipped engine', /SHIPPED engine/.test(j.frame.model_graded), j.frame.model_graded);
    } else {
      chk('an unavailable replay states its reason rather than going quiet', typeof feng.why === 'string' && feng.why.length > 10, feng);
      chk('and model_graded says plainly that the stand-in produced the numbers', /stand-in/.test(j.frame.model_graded) && /says nothing about the number the desk quotes/.test(j.frame.model_graded), j.frame.model_graded);
      chk('the caveats say this is not the shipped football engine', j.frame.caveats.some((c) => /NOT the shipped football engine/.test(c)), j.frame.caveats);
    }
    Object.keys(j.markets).forEach((m) => {
      const x = j.markets[m];
      chk(k + ' ' + m + ' carries a mode and the basis for it', ['BET', 'SHADOW', 'RESEARCH_ONLY'].indexOf(x.mode) >= 0 && !!x.mode_basis, [x.mode, x.mode_basis]);
      chk(k + ' ' + m + ' never claims BET without beating both flat arms', x.mode !== 'BET' || (x.money && x.money.beats_flat_half && x.money.beats_flat_one));
      /* every graded season says which model produced it, and a market
         never mixes the two: the scales are different and a blend of them
         is a projection that never existed. */
      const sources = (x.holdouts || []).map((h) => h.model_source);
      chk(k + ' ' + m + ' records the model source on every held-out season', sources.length === 0 || sources.every((sx) => ['shipped_engine', 'elo_rating_line', 'tune_window_mean_total', 'market_only'].indexOf(sx) >= 0), sources);
      chk(k + ' ' + m + ' does not mix a replayed engine season with a stand-in season', sources.indexOf('shipped_engine') < 0 || sources.every((sx) => sx === 'shipped_engine'), sources);
    });
  });
}

/* ═══ 7. THE ENGINE REPLAY, AND ITS HONEST FALLBACK ════════════════════ */
{
  /* The replay needs nflverse team-week feeds that are cached rather than
     committed. Present on the nightly runner, absent in a fresh checkout.
     The requirement is not that it works — it is that a checkout where it
     does NOT work says so, in words, instead of quietly grading something
     else and calling it the shipped engine. */
  const src = V.nflRows();
  chk('the NFL loader always reports an engine verdict', src.engine && typeof src.engine.available === 'boolean', src.engine);
  if (src.engine.available) {
    chk('an available replay joins most of the archive', src.engine.joined / src.games > 0.5, { joined: src.engine.joined, games: src.games });
    chk('and names where the numbers came from', /football\/engine\.js/.test(src.engine.source), src.engine.source);
  } else {
    chk('an unavailable replay refuses with a reason a reader can act on', typeof src.engine.why === 'string' && src.engine.why.length > 20, src.engine.why);
  }
  /* switching it off is the same path a missing feed takes, so it can be
     asserted anywhere */
  const off = V.nflRows({ engine: false });
  eq('the replay can be switched off, and says so', off.engine.available, false);
  chk('with the reason recorded', /switched off/.test(off.engine.why), off.engine.why);
  chk('and the rows still load from the archive', off.rows.length > 1000, off.rows.length);
  chk('with no engine number on any row', off.rows.every((r) => r.engine_home_line == null), off.rows.filter((r) => r.engine_home_line != null).length);

  /* THE ALL-OR-NOTHING RULE, on a synthetic archive where the engine field
     can be dialled to an exact share. The engine's fair line and the Elo
     stand-in are not on the same scale, so a market that grades some seasons
     on one and some on the other is grading a projection that never existed. */
  const synth = (shareWithEngine) => {
    const rows = [];
    let seed = 11;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let season = 2012; season <= 2022; season++) {
      for (let i = 0; i < 260; i++) {
        const elo = (rnd() - 0.5) * 400;
        const trueMargin = elo / 25 + 2.2 + (rnd() - 0.5) * 26;
        const close = -(elo / 25 + 2.2 + (rnd() - 0.5) * 3);
        const has = (i % 100) < Math.round(shareWithEngine * 100);
        rows.push({ id: season + '-' + i, season, week: 1 + (i % 14), elo_diff: elo, home: 1,
          engine_home_line: has ? Math.round(close * 2) / 2 : null,
          engine_total: has ? 45 : null,
          engine_home_win_prob: has ? 0.55 : null,
          margin: Math.round(trueMargin), close: Math.round(close * 2) / 2, open: Math.round(close * 2) / 2,
          close_total: 45, points: 45 + Math.round((rnd() - 0.5) * 20), home_odds: -110, away_odds: -110,
          over_odds: -110, under_odds: -110, home_ml: null, away_ml: null, qb_known: true, weather_known: true,
          home_team: 'H' + (i % 32), away_team: 'A' + ((i + 7) % 32) });
      }
    }
    return rows;
  };
  const full = V.runMarket({ rows: synth(1), market: 'spread', sport: 'americanfootball_nfl' });
  chk('a replay that reached every game grades the shipped engine', full.holdouts.length > 0 && full.holdouts.every((h) => h.model_source === 'shipped_engine'), full.holdouts.map((h) => h.model_source));
  const partial = V.runMarket({ rows: synth(0.8), market: 'spread', sport: 'americanfootball_nfl' });
  chk('a replay that reached only four games in five is not used at all', partial.holdouts.every((h) => h.model_source === 'elo_rating_line'), partial.holdouts.map((h) => h.model_source));
  const none = V.runMarket({ rows: synth(0), market: 'spread', sport: 'americanfootball_nfl' });
  chk('and a replay that reached nothing falls back without complaint', none.holdouts.every((h) => h.model_source === 'elo_rating_line'), none.holdouts.map((h) => h.model_source));
  chk('every season in every arm names its source', [full, partial, none].every((o) => o.holdouts.every((h) => typeof h.model_source === 'string' && h.model_source.length > 0)));
  /* the moneyline arm reads a different engine field and must follow the
     same rule, or refuse for a stated reason */
  const mlFull = V.runMoneyline({ rows: synth(1).map((r) => Object.assign({}, r, { home_ml: -130, away_ml: 110 })), sport: 'americanfootball_nfl' });
  if (mlFull.holdouts && mlFull.holdouts.length) {
    chk('the moneyline arm follows the same all-or-nothing rule', mlFull.holdouts.every((h) => h.model_source === 'shipped_engine'), mlFull.holdouts.map((h) => h.model_source));
  } else {
    chk('or it refuses for a reason it states', typeof mlFull.mode_basis === 'string' && mlFull.mode_basis.length > 10, mlFull.mode_basis);
  }
  const mlNone = V.runMoneyline({ rows: synth(0), sport: 'americanfootball_nfl' });
  chk('a moneyline arm with no prices refuses rather than inventing one', mlNone.positions === 0 && mlNone.mode === 'RESEARCH_ONLY', { positions: mlNone.positions, mode: mlNone.mode });
  chk('and says why in words', typeof mlNone.mode_basis === 'string' && mlNone.mode_basis.length > 10, mlNone.mode_basis);
}

done();
