#!/usr/bin/env node
/* ===========================================================================
   The linemaker: lib/edgedesk_fairline.js, the calibration record, the fair
   line sheets, the append-only ledger and the grader.

   What it proves:
     1. ODDS. Fair American prices, break-even and expected return agree with
        lib/research_core.js (the one home of that arithmetic) and with hand
        computations; pushes are handled; certainties have no price.
     2. DISTRIBUTIONS. A discretised normal integrates to one and has the
        right mean; the convolution of two team PMFs gives the margin and total
        exactly (checked against brute force); tails sum to one; quantiles.
     3. THE SHEET. Spread, moneyline, total and team totals agree with each
        other and with the projection's sign convention (home ahead = home
        favoured = negative home line); ladders are monotone; a moneyline tie
        is the league's measured rate; ENGINE markets ship ladders, PMF
        markets ship distributions; EDFairLine.ladder rebuilds the same rows.
     4. THE PRICE CHECK. VALUE needs a calibrated market, an at-market band
        and a positive conservative edge; THIN and NO_VALUE say why; a team
        total (never tested at a market number) can never be VALUE; bad input
        is CANNOT_EVALUATE; a stale quote never ranks; the ranking may be empty.
     5. THE RECORD. The committed calibration records parse and pass --check;
        the selection rule and the status rules hold on the committed numbers;
        the incumbent margin; no market claims VALIDATED without an archive.
     6. THE LEDGER. Built into a temp dir with a pinned clock: append-only
        (old bytes are a prefix), idempotent, only before kickoff, a record
        edited after writing fails --check, a started game gets no record.
     7. THE GRADER. A synthetic result graded from the frozen probabilities,
        with sample states.

   Run: node tools/football/linemaker.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const FL = require(path.join(ROOT, 'lib', 'edgedesk_fairline.js'));
const RC = require(path.join(ROOT, 'lib', 'research_core.js'));
const CAL = require(path.join(__dirname, 'linemaker_calibrate.js'));
const BFL = require(path.join(__dirname, 'build_fair_lines.js'));
const GR = require(path.join(__dirname, 'linemaker_grade.js'));

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }
function near(a, b, tol) { return a != null && b != null && Math.abs(a - b) <= (tol == null ? 1e-9 : tol); }
function section(t) { console.log('— ' + t); }

/* ═══ 1. odds ═══════════════════════════════════════════════════════════ */
section('odds');
chk('fair price of 50% with no push is +100', FL.fairAmerican(0.5, 0) === 100, FL.fairAmerican(0.5, 0));
chk('fair price of 0.6 with no push is -150', FL.fairAmerican(0.6, 0) === -150, FL.fairAmerican(0.6, 0));
chk('fair price of 0.25 is +300', FL.fairAmerican(0.25, 0) === 300);
chk('a push is refunded: win 0.45, push 0.1 → decimal 2.0 → +100', FL.fairAmerican(0.45, 0.1) === 100, FL.fairAmerican(0.45, 0.1));
chk('a certainty has no price', FL.fairAmerican(1, 0) === null && FL.fairAmerican(0.9, 0.1) === null);
chk('an impossible probability has no price', FL.fairAmerican(0, 0) === null && FL.fairAmerican(-0.1, 0) === null && FL.fairAmerican(0.8, 0.3) === null);
chk('break-even at -110 is 52.38% (research_core)', near(RC.breakEven(-110), 110 / 210, 1e-12));
chk('expected return at -110 with 55% and no push is +5%', near(RC.expectedRoi(0.55, -110, 0), 0.55 * (100 / 110) - 0.45, 1e-12));
chk('expected return counts a push as no gain and no loss', near(RC.expectedRoi(0.5, 100, 0.1), 0.5 - 0.4, 1e-12));
const nv = FL.noVig(-110, -110);
chk('no-vig of -110/-110 is 50/50 with a 4.76% overround', near(nv.a, 0.5, 1e-4) && near(nv.overround, 0.0476, 1e-4), nv);
const nv2 = FL.noVig(-395, 310);
chk('no-vig of -395/+310 sums to one', near(nv2.a + nv2.b, 1, 1e-3) && nv2.a > 0.75, nv2);
chk('no-vig refuses an invalid price', FL.noVig(-110, 50) === null);

/* ═══ 2. distributions ══════════════════════════════════════════════════ */
section('distributions');
const N = FL.pmf.normal(24.3, 9.5, 0, 80);
chk('a discretised normal integrates to one', near(FL.pmf.mean({ lo: 0, p: N.p.map(() => 1) }) !== null ? N.p.reduce((s, x) => s + x, 0) : 0, 1, 1e-9));
chk('untruncated, it has the right mean', near(FL.pmf.mean(FL.pmf.normal(24.3, 9.5, -40, 90)), 24.3, 0.01), FL.pmf.mean(FL.pmf.normal(24.3, 9.5, -40, 90)));
chk('truncated at zero (points are never negative), its mean moves up, never down', FL.pmf.mean(N) > 24.3 && FL.pmf.mean(N) < 24.6, FL.pmf.mean(N));
const h = { lo: 10, p: [0.2, 0.5, 0.3] }, a = { lo: 7, p: [0.6, 0.4] };
const J = FL.pmf.convolve(h, a);
/* brute force */
const bm = {}, bt = {};
h.p.forEach((ph, i) => a.p.forEach((pa, j) => { const H = 10 + i, A = 7 + j; bm[H - A] = (bm[H - A] || 0) + ph * pa; bt[H + A] = (bt[H + A] || 0) + ph * pa; }));
chk('the convolved margin matches brute force at every value', Object.keys(bm).every((k) => near(FL.pmf.at(J.margin, +k), bm[k], 1e-12)), { J, bm });
chk('the convolved total matches brute force at every value', Object.keys(bt).every((k) => near(FL.pmf.at(J.total, +k), bt[k], 1e-12)));
const tl = FL.pmf.tail(J.margin, 3);
chk('a tail splits into over, push and under that sum to one', near(tl.over + tl.push + tl.under, 1, 1e-12) && near(tl.push, bm[3] || 0, 1e-12), tl);
chk('the median of a symmetric normal is its centre', near(FL.pmf.quantile(FL.pmf.normal(0, 13, -60, 60), 0.5), 0, 1e-6));
const mixd = FL.pmf.mix({ lo: 0, p: [1] }, { lo: 2, p: [1] }, 0.25);
chk('a mixture weights its parts', near(FL.pmf.at(mixd, 0), 0.75, 1e-12) && near(FL.pmf.at(mixd, 2), 0.25, 1e-12));
const cp = FL.pmf.compact({ lo: 0, p: [1e-9, 0.3, 0.7, 1e-9] });
chk('compact trims negligible tails and stays normalised', cp.lo === 1 && cp.p.length === 2 && near(cp.p[0] + cp.p[1], 1, 1e-9), cp);

/* ═══ 3. the sheet, on the committed calibration records ═══════════════ */
section('the sheet');
const CN = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'validation', 'linemaker_nfl.json'), 'utf8'));
const CC = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'validation', 'linemaker_cfb.json'), 'utf8'));
const hooksN = BFL.engineHooks('nfl'), hooksC = BFL.engineHooks('cfb');
const shN = FL.sheet({ sport: 'americanfootball_nfl', game_id: 't1', home: 'HOME', away: 'AWAY', kickoff: '2030-01-01T00:00:00Z', raw: { home_margin: 6.5, total: 45.5 } }, CN.live, hooksN);
chk('an NFL sheet builds', shN.ok, shN.error);
chk('a home side projected ahead is favoured (negative home line)', shN.markets.spread.fair_home_line < 0, shN.markets.spread);
chk('and is the moneyline favourite', shN.markets.moneyline.home_win > shN.markets.moneyline.away_win && shN.markets.moneyline.home_fair < 0 && shN.markets.moneyline.away_fair > 0, shN.markets.moneyline);
chk('the moneyline tie is the NFL\'s measured tie rate, not distribution mass', near(shN.markets.moneyline.tie, Math.round(CN.live.tie_rate * 1e4) / 1e4, 1e-4) && shN.markets.moneyline.tie < 0.01, shN.markets.moneyline.tie);
chk('moneyline probabilities sum to one', near(shN.markets.moneyline.home_win + shN.markets.moneyline.away_win + shN.markets.moneyline.tie, 1, 2e-4));
chk('the home team total exceeds the away team total when home is ahead', shN.markets.team_total.home_fair > shN.markets.team_total.away_fair, shN.markets.team_total);
chk('the two team totals add to roughly the game total (independent medians)', Math.abs(shN.markets.team_total.home_fair + shN.markets.team_total.away_fair - shN.markets.total.fair_total) < 2.5, [shN.markets.team_total, shN.markets.total.fair_total]);
const lsp = FL.ladder(shN, 'spread');
chk('the spread ladder: a home line is likelier to cover the more points it gets', lsp.every((r, i) => i === 0 || r.home >= lsp[i - 1].home - 1e-9) && lsp.length > 30, lsp.slice(0, 3));
chk('every rung sums to one and carries both fair prices', lsp.every((r) => near(r.home + r.push + r.away, 1, 2e-4) && (r.home_fair != null) && (r.away_fair != null)));
const lto = FL.ladder(shN, 'total');
chk('the total ladder: the over is less likely the higher the line', lto.every((r, i) => i === 0 || r.over <= lto[i - 1].over + 1e-9) && lto.length > 30);
chk('whole-number totals carry push probability, half points none', lto.filter((r) => r.line % 1 === 0).every((r) => r.push > 0) && lto.filter((r) => r.line % 1 !== 0).every((r) => r.push === 0));
const ltt = FL.ladder(shN, 'home_team_total');
chk('a team-total ladder exists and is monotone', ltt.length > 20 && ltt.every((r, i) => i === 0 || r.over <= ltt[i - 1].over + 1e-9));
chk('each market carries its method, its calibration status and its market tier', ['spread', 'moneyline', 'total', 'team_total'].every((k) => shN.markets[k].method && FL.STATUSES.includes(shN.markets[k].status) && shN.markets[k].tier));
chk('the team total never claims a market tier it was never tested for', shN.markets.team_total.tier === 'RESEARCH' && /no closing team-total line/.test(shN.markets.team_total.tier_basis || ''), shN.markets.team_total.tier_basis);
const flipped = FL.sheet({ sport: 'americanfootball_nfl', game_id: 't2', home: 'H', away: 'A', raw: { home_margin: -6.5, total: 45.5 } }, CN.live, hooksN);
chk('mirroring the projection mirrors the moneyline', near(flipped.markets.moneyline.home_win, shN.markets.moneyline.away_win, 0.03), [flipped.markets.moneyline.home_win, shN.markets.moneyline.away_win]);
const shC = FL.sheet({ sport: 'americanfootball_ncaaf', game_id: 'c1', home: 'H', away: 'A', raw: { home_margin: 10, total: 55, sigma: 15, sigma_base: hooksC.sigma_base } }, CC.live, hooksC);
chk('a CFB sheet builds with no tie on the moneyline', shC.ok && shC.markets.moneyline.tie === 0, shC.markets && shC.markets.moneyline);
/* THE CFB SPREAD IS ONE DISTRIBUTION PER GAME (build_fair_lines.js
   cfbSpreadCover). The engine's per-line call keyed its borrowed shape to the
   line it priced, so a ladder dipped as the line got better (Tulane −0.5
   38.9%, +0.5 38.7%; every FBS sheet; 3 points across the table's ±45 edge). */
const E4 = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js')), P4 = global.window.EDCfbP4Params;
function cfbLadderFaults(cover, raw, lo, hi) {
  let dips = 0, gaps = 0, miss = 0, prev = null;
  for (let L = lo; L <= hi + 1e-9; L += 0.5) {
    const t = cover(raw, -L); if (!t) { miss++; prev = null; continue; }
    if (prev) {
      if (t.over + t.push < prev.over + prev.push - 1e-12 || t.over < prev.over - 1e-12) dips++;
      if (Number.isInteger(L) && Math.abs(t.over - prev.over) > 1e-12) gaps++; /* integer margins: P(m > n) = P(m > n − 0.5) */
    }
    prev = t;
  }
  return { dips, gaps, miss };
}
const cfbIn = BFL.inputsFor('cfb', JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'fbs', 'slate.json'), 'utf8')), 0).rows;
const cfbF = cfbIn.map((r) => cfbLadderFaults(hooksC.cover, r.input.raw, -70, 70));
chk('CFB ladders: on every committed FBS projection a home line never covers less often as it gets more points (−70 to +70, unrounded)', cfbIn.length > 20 && cfbF.every((f) => f.dips === 0 && f.miss === 0), cfbF.filter((f) => f.dips || f.miss).length + ' of ' + cfbIn.length);
chk('CFB ladders: integer margins — an integer home line wins exactly as often as the half point below it', cfbF.every((f) => f.gaps === 0), cfbF.filter((f) => f.gaps).length);
const sweep = []; for (let m = -60; m <= 60; m += 2.5) [10, 15, 22].forEach((s) => sweep.push(cfbLadderFaults(hooksC.cover, { home_margin: m + 0.13, sigma: s, sigma_base: hooksC.sigma_base }, -75, 75)));
chk('CFB ladders: monotone for fair margins −60 to +60 at σ 10, 15 and 22, across the table\'s ±45 edge', sweep.every((f) => f.dips === 0 && f.gaps === 0 && f.miss === 0), sweep.filter((f) => f.dips || f.gaps || f.miss).length);
chk('CFB has no ties: home −0.5 and +0.5 win equally often on every committed projection', cfbIn.every((r) => hooksC.cover(r.input.raw, 0.5).over === hooksC.cover(r.input.raw, -0.5).over));
const atFair = cfbIn.filter((r) => Math.abs(r.input.raw.home_margin) <= 45);
chk('at EdgeDesk\'s fair margin the one curve equals the engine\'s own per-line answer to the bit', atFair.length > 20 && atFair.every((r) => { const x = r.input.raw, a = hooksC.cover(x, x.home_margin), e = E4.dist.coverProbSpread(x.home_margin, x.home_margin, x.sigma || hooksC.sigma_base, hooksC.sigma_base); return a.over === e.win && a.push === e.push && a.under === e.lose; }));
const cfbSheets = cfbIn.map((r) => FL.sheet(r.input, CC.live, hooksC));
chk('CFB sheets as published (4 dp): every spread rung covers at least as often as the one below it', cfbSheets.every((s) => s.ok && s.ladders.spread.length > 30 && s.ladders.spread.every((r, i, a) => i === 0 || r.home + r.push >= a[i - 1].home + a[i - 1].push - 1.01e-4)));
const tableless = Object.assign({}, P4, { distributions: Object.assign({}, P4.distributions, { margin_pmf_by_spread: null, pmf_spread_range: null }) });
const pooled = BFL.cfbSpreadCover(tableless, E4, hooksC.sigma_base), ou4 = (c) => (c ? { over: c.win, push: c.push, under: c.lose } : null);
let pooledF = null, pooledB = null;
global.window.EDCfbP4Params = tableless; /* the engine reads the global params */
try { pooledF = cfbLadderFaults((x, t) => ou4(pooled(x, t)), { home_margin: 7.3, sigma: 15 }, -40, 40); pooledB = (pooled({ home_margin: 7.3 }, -3) || {}).basis; } finally { global.window.EDCfbP4Params = P4; }
chk('a params file with no table falls back to the pooled residual, itself one distribution', pooledF && pooledF.dips === 0 && pooledF.miss === 0 && pooledB === 'pooled_residual', { pooledF, pooledB });
chk('a table that cannot place the game refuses rather than read a different row per line', BFL.cfbSpreadCover(P4, E4, hooksC.sigma_base)({ home_margin: null }, 3) === null);
chk('the calibration replay grades the function the sheets ship', /cfbSpreadCover\(P, E, sigmaBase\)/.test(fs.readFileSync(path.join(__dirname, 'linemaker_calibrate.js'), 'utf8')) && !/coverProbSpread\(raw\.home_margin/.test(fs.readFileSync(path.join(__dirname, 'linemaker_calibrate.js'), 'utf8')));
const noHooks = FL.sheet({ sport: 'americanfootball_nfl', game_id: 't3', raw: { home_margin: 3, total: 44 } }, CN.live, null);
const engineMarkets = Object.keys(CN.live.markets).filter((k) => CN.live.markets[k].method === 'ENGINE');
chk('without an engine an ENGINE market is omitted and the sheet says why', engineMarkets.every((k) => !noHooks.markets[k] || k === 'moneyline') && (engineMarkets.length === 0 || noHooks.notes.length > 0), { engineMarkets, notes: noHooks.notes });
chk('a sheet with no projection is refused, not guessed', FL.sheet({ game_id: 'x', raw: { home_margin: null, total: 40 } }, CN.live).ok === false);
chk('a sheet with no calibration record is refused', FL.sheet({ game_id: 'x', raw: { home_margin: 3, total: 40 } }, null).ok === false);

/* ═══ 4. the price check ════════════════════════════════════════════════ */
section('the price check');
const MN = { bands: CN.live.bands, bands_at_market: CN.live.bands_at_market, band_min_n: CN.live.band_min_n };
const pcGood = FL.priceCheck(shN, { market: 'spread', side: 'home', line: shN.markets.spread.fair_home_line_half + 6, american: -110 }, MN);
chk('six points better than fair at -110 has a positive expected return', pcGood.expected_roi > 0, pcGood);
chk('but at market numbers the model\'s probabilities had little resolution, so it is THIN, not VALUE', pcGood.verdict === 'THIN' && /market posted/.test(pcGood.why.join(' ')), pcGood.why);
const pcHuge = FL.priceCheck(shN, { market: 'spread', side: 'home', line: shN.markets.spread.fair_home_line_half + 6, american: 250 }, MN);
chk('a real mispricing (+250 on a side EdgeDesk makes a favourite) is VALUE', pcHuge.verdict === 'VALUE', pcHuge);
chk('VALUE still says the market tier is not a betting record', /not a betting record/.test(pcHuge.why.join(' ')));
const pcNo = FL.priceCheck(shN, { market: 'spread', side: 'away', line: -shN.markets.spread.fair_home_line_half - 6, american: -110 }, MN);
chk('the other side of that number is NO_VALUE with the numbers in the reason', pcNo.verdict === 'NO_VALUE' && /needs/.test(pcNo.why[0]), pcNo);
const pcTT = FL.priceCheck(shN, { market: 'team_total', team: 'home', side: 'over', line: 5.5, american: 300 }, MN);
chk('a team total is never VALUE: never tested at a market number', pcTT.verdict !== 'VALUE' && pcTT.expected_roi > 0, pcTT);
chk('a price check never says BET or PLAY', !/\b(BET|PLAY)\b/.test(JSON.stringify([pcGood, pcHuge, pcNo, pcTT])));
chk('a bad price is CANNOT_EVALUATE', FL.priceCheck(shN, { market: 'spread', side: 'home', line: -3, american: 50 }, MN).verdict === 'CANNOT_EVALUATE');
chk('a quarter-point line is CANNOT_EVALUATE', FL.priceCheck(shN, { market: 'spread', side: 'home', line: -3.25, american: -110 }, MN).verdict === 'CANNOT_EVALUATE');
chk('an unknown market is CANNOT_EVALUATE', FL.priceCheck(shN, { market: 'corners', side: 'over', line: 9.5, american: -110 }, MN).verdict === 'CANNOT_EVALUATE');
chk('a negative total is CANNOT_EVALUATE', FL.priceCheck(shN, { market: 'total', side: 'over', line: -3, american: -110 }, MN).verdict === 'CANNOT_EVALUATE');
const pcMl = FL.priceCheck(shN, { market: 'moneyline', side: 'home', american: -10000 }, MN);
chk('a moneyline price far beyond the fair price is NO_VALUE', pcMl.verdict === 'NO_VALUE', pcMl);
const pcPush = FL.priceCheck(shN, { market: 'total', side: 'over', line: 45, american: -110 }, MN);
chk('a whole-number total reports its push probability and prices it', pcPush.probs && pcPush.probs.push > 0 && near(pcPush.cover_prob, pcPush.probs.win / (1 - pcPush.probs.push), 1e-3), pcPush.probs);
const now = Date.parse('2030-01-01T00:00:00Z');
const rk = FL.rankQuotes({ t1: shN }, [
  { game_id: 't1', market: 'spread', side: 'home', line: shN.markets.spread.fair_home_line_half + 6, american: 250, book: 'fresh', observed_at: new Date(now - 5 * 60000).toISOString() },
  { game_id: 't1', market: 'spread', side: 'home', line: shN.markets.spread.fair_home_line_half + 6, american: 260, book: 'stale', observed_at: new Date(now - 300 * 60000).toISOString() },
  { game_id: 't1', market: 'spread', side: 'away', line: 3, american: -110, book: 'no' },
  { game_id: 'missing', market: 'spread', side: 'home', line: 3, american: -110 }
], { americanfootball_nfl: MN }, { now, maxAgeMin: 90 });
chk('the ranking keeps only VALUE and drops the stale quote', rk.qualified === 1 && rk.ranked[0].book === 'fresh', rk.ranked.map((r) => r.book));
chk('a stale quote is reported with its age, never ranked', rk.evaluated.find((r) => r.book === 'stale').stale === true);
chk('a quote for a game with no sheet cannot be evaluated', rk.evaluated.find((r) => r.game_id === 'missing').verdict === 'CANNOT_EVALUATE');
const empty = FL.rankQuotes({ t1: shN }, [{ game_id: 't1', market: 'spread', side: 'away', line: 3, american: -110 }], { americanfootball_nfl: MN });
chk('nothing qualifying is a normal answer: an empty ranking', empty.qualified === 0 && empty.ranked.length === 0);

/* ═══ 5. the committed calibration records ═════════════════════════════ */
section('the calibration records');
['nfl', 'cfb'].forEach((lg) => {
  const C = lg === 'nfl' ? CN : CC;
  chk(lg + ': --check passes', CAL.check(lg).length === 0, CAL.check(lg));
  ['spread', 'moneyline', 'total', 'team_total'].forEach((mk) => {
    const m = C.markets[mk];
    const sel = {}; m.candidates.forEach((c) => { sel[c.method] = c.selection.log_loss; });
    const best = Object.keys(sel).reduce((b, k) => (b == null || sel[k] < sel[b] ? k : b), null);
    const okRule = m.chosen === best || (m.chosen === 'ENGINE' && sel.ENGINE - sel[best] < CAL.INCUMBENT_MARGIN);
    chk(lg + ' ' + mk + ': the chosen method follows the pre-declared rule', okRule, { chosen: m.chosen, sel });
    const dg = m.diagnostics.confirmation;
    const st = CAL.statusOf(dg).status;
    chk(lg + ' ' + mk + ': the status follows the status rules', st === m.status, { st, status: m.status });
    chk(lg + ' ' + mk + ': confirmation and live windows are reported, never used to choose', m.candidates.every((c) => c.confirmation && c.live) && /never used to choose/.test(C.rules.note));
  });
  chk(lg + ': the caveat about in-sample engine weights is printed', /in-sample/.test(C.frame.caveat));
  chk(lg + ': the replay is week by week and never reads the market for a projection', /a week at a time/.test(C.frame.replay) && /never enters a projection/.test(C.frame.replay));
  chk(lg + ': spread and total carry an at-market band', !!(C.live.bands_at_market && C.live.bands_at_market.spread && C.live.bands_at_market.total));
  chk(lg + ': team totals carry no at-market band (no archive to build one)', !(C.live.bands_at_market && C.live.bands_at_market.team_total));
  chk(lg + ': every held-out band row has a Wilson interval around its observed rate', C.live.bands.spread.filter((b) => b.n).every((b) => b.wilson_lo <= b.observed + 1e-9 && b.wilson_hi >= b.observed - 1e-9));
});
const dgTest = CAL.diagnostics([[0.7, 1], [0.7, 1], [0.7, 0], [0.3, 0], [0.3, 0], [0.3, 1]], [[0.5, 1], [0.5, 1], [0.5, 0], [0.5, 0], [0.5, 0], [0.5, 1]]);
chk('diagnostics: the calibration-in-the-large of a perfectly calibrated set is zero', near(dgTest.citl, 0, 1e-9), dgTest);
chk('diagnostics: a calibrated set has positive skill over a coin flip', dgTest.skill > 0, dgTest);
chk('status: a small sample is never CALIBRATED', CAL.statusOf(Object.assign({}, dgTest, { n: 10 })).status === 'PROVISIONAL');

/* ═══ 6. the ledger ═════════════════════════════════════════════════════ */
section('the ledger');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flines-'));
const KICK = '2030-01-05T18:00:00.000Z';
const slates = {
  nfl: { season: 2029, generated_at: '2030-01-01T00:00:00Z', games: [
    { game_id: 'N1', season: 2029, week: 18, kickoff: KICK, home_team: 'Home FC', away_team: 'Away FC', model_status: 'PREDICTED', model_home_margin: 3.2, model_fair_total: 44.1, model_home_win_prob: 0.6, reference_market: { source: 'test consensus (reference, not a price)', home_line: -3, total: 44.5, home_ml: -150, away_ml: 130 }, model_version: 'v-test' },
    { game_id: 'N2', season: 2029, week: 18, kickoff: '2030-01-01T00:30:00.000Z', home_team: 'Early', away_team: 'Bird', model_status: 'PREDICTED', model_home_margin: 1, model_fair_total: 40, model_home_win_prob: 0.53 },
    { game_id: 'N3', season: 2029, week: 18, kickoff: KICK, home_team: 'No', away_team: 'Model', model_status: 'INSUFFICIENT_DATA' }
  ] },
  cfb: { season: 2029, generated_at: '2030-01-01T00:00:00Z', games: [] }
};
const r1 = BFL.build({ now: '2030-01-01T01:00:00Z', out: tmp, slates });
chk('a game in the future gets a sheet', r1.out.games.some((g) => g.game_id === 'N1'));
chk('a game that has started gets no sheet', !r1.out.games.some((g) => g.game_id === 'N2'));
chk('a game with no projection is refused with the reason', r1.out.refused.some((x) => x.game_id === 'N3' && /no projection/.test(x.reason)));
const g1 = r1.out.games.find((g) => g.game_id === 'N1');
chk('the reference line is shown, labelled as no price, with no EV', g1.reference_versus && g1.reference_versus.is_price === false && !/expected/.test(JSON.stringify(g1.reference_versus)), g1.reference_versus);
chk('the reference gap is the fair line minus the reference line', near(g1.reference_versus.spread.gap_points, Math.round((g1.markets.spread.fair_home_line - (-3)) * 10) / 10, 1e-9), g1.reference_versus.spread);
chk('the reference moneyline carries its no-vig split', g1.reference_versus.moneyline && near(g1.reference_versus.moneyline.no_vig.a + g1.reference_versus.moneyline.no_vig.b, 1, 1e-3));
const lf = path.join(tmp, 'ledger', '2029', 'sheets.jsonl');
const t1 = fs.readFileSync(lf, 'utf8');
chk('the ledger received one record', t1.trim().split('\n').length === 1);
BFL.build({ now: '2030-01-01T02:00:00Z', out: tmp, slates });
chk('an unchanged sheet is not recorded twice', fs.readFileSync(lf, 'utf8') === t1);
const moved = JSON.parse(JSON.stringify(slates)); moved.nfl.games[0].model_home_margin = 6.4;
BFL.build({ now: '2030-01-01T03:00:00Z', out: tmp, slates: moved });
const t2 = fs.readFileSync(lf, 'utf8');
chk('a moved sheet appends a record and leaves the old bytes as they were', t2.length > t1.length && t2.slice(0, t1.length) === t1 && t2.trim().split('\n').length === 2);
const wobble = JSON.parse(JSON.stringify(moved)); wobble.nfl.games[0].model_home_margin = 6.43;
BFL.build({ now: '2030-01-01T04:00:00Z', out: tmp, slates: wobble });
chk('a wobble inside the same half point is not a new record', fs.readFileSync(lf, 'utf8') === t2);
BFL.build({ now: '2030-01-05T18:30:00Z', out: tmp, slates: Object.assign({}, slates, { nfl: Object.assign({}, slates.nfl, { games: [Object.assign({}, slates.nfl.games[0], { model_home_margin: -9 })] }) }) });
chk('after kickoff nothing is recorded, whatever the projection says', fs.readFileSync(lf, 'utf8') === t2);
const outFile = path.join(tmp, 'fair_lines.json');
fs.writeFileSync(outFile, JSON.stringify(r1.out));
chk('the built directory passes --check', BFL.check(tmp).length === 0, BFL.check(tmp));
const tampered = t2.replace(/"fair_home_line":-?[0-9.]+/, '"fair_home_line":-99');
fs.writeFileSync(lf, tampered);
chk('a record edited after it was written fails --check', BFL.check(tmp).some((e) => /does not match its id/.test(e)), BFL.check(tmp));
fs.writeFileSync(lf, t2 + 'not json\n');
let threw = null; try { BFL.build({ now: '2030-01-01T05:00:00Z', out: tmp, slates: moved }); } catch (e) { threw = e.message; }
chk('the build refuses a ledger it cannot read back, and never repairs it', threw && /append-only/.test(threw), threw);
fs.writeFileSync(lf, t2);
chk('the committed artifact passes --check', BFL.check().length === 0, BFL.check());

/* ═══ 7. the grader ═════════════════════════════════════════════════════ */
section('the grader');
const rec = JSON.parse(t2.trim().split('\n')[1]);
const fairLine = rec.spread.fair_home_line;
const closeLine = Object.keys(rec.at_lines.spread).map(Number).find((l) => Math.abs(l - Math.round(fairLine)) < 0.6 && l % 1 !== 0);
const gr = GR.grade({ dir: tmp, nflOutcomes: { N1: { home: 27, away: 17, close_home_line: closeLine, close_total: 44.5 } }, cfbOutcomes: () => ({}) });
chk('one game graded from its LAST pregame record', gr.counts.graded === 1 && gr.counts.games === 1, gr.counts);
const allG = gr.groups.all;
const pHome = rec.moneyline.home_win + 0.5 * rec.moneyline.tie;
chk('the moneyline Brier is the frozen probability against the result', near(allG.moneyline.brier, Math.round((pHome - 1) ** 2 * 1e4) / 1e4, 1e-4), [allG.moneyline, pHome]);
const tr = rec.at_lines.spread[String(closeLine)];
chk('the spread is graded at the closing number from the frozen triple', allG.spread_at_close.n === 1 && near(allG.spread_at_close.brier, Math.round(((tr[0] / (tr[0] + tr[2])) - (10 + closeLine > 0 ? 1 : 0)) ** 2 * 1e4) / 1e4, 1e-4), [allG.spread_at_close, tr, closeLine]);
chk('the margin error is |actual - fair|', near(allG.margin_error.mae, Math.round(Math.abs(10 - (-fairLine)) * 1000) / 1000, 1e-3), allG.margin_error);
chk('movement reads the reference at the FIRST record against the close', allG.movement_spread.n === 1, allG.movement_spread);
chk('every figure carries n and a sample state', allG.moneyline.sample_state === 'too early' && GR.sampleState(500) === 'meaningful' && GR.sampleState(50) === 'early signal');
chk('the grader computes no profit, ROI or record', !/roi|profit|units/i.test(JSON.stringify(gr.groups)));
const grEmpty = GR.grade({ dir: tmp, nflOutcomes: {}, cfbOutcomes: () => ({}) });
chk('a game without a result waits, it is not graded as anything', grEmpty.counts.graded === 0 && grEmpty.counts.awaiting_result === 1);
fs.rmSync(tmp, { recursive: true, force: true });

failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 500) : '')));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'linemaker — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
