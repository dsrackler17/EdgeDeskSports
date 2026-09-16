#!/usr/bin/env node
/* ===========================================================================
   THE PRICING KERNEL: the fair line is the validated blend, cover
   probabilities are arithmetic on it, bet-to lines meet the price's break-
   even, the status is governed by the tier, a RESEARCH market never emits
   PLAY, sizing exists only for VALIDATED, the slate ranks PLAY above PASS,
   and the critic fails a bet the block did not make.

   Run: node tools/intelligence/pricing.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const P = require(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_pricing.js'));
const NFL = 'americanfootball_nfl', CFB = 'americanfootball_ncaaf';

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function done() { failures.forEach((f) => console.log('FAIL | ' + f.name + '  ' + String(JSON.stringify(f.detail)).slice(0, 320))); console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed'); process.exit(fail === 0 ? 0 : 1); }

/* a LABELLED FIXTURE validation record: NFL spread LEAN at 1.5 with a blend; CFB RESEARCH with no blend */
const V_NFL = { schema: 'edgedesk_pricing_validation_v1', sport: NFL, generated_at: '2026-09-16T00:00:00Z', frame: { eval_window: '2016-2025' }, markets: {
  spread: { tier: 'LEAN', required_edge_points: 1.5, tier_basis: 'FIXTURE: cleared break-even, not a profit', blend: { latest_coef: { intercept: 0, close: 1, model_minus_close: 0.25 }, latest_sigma: 12.8, pooled_holdout: { blend_mae: 9.8, close_mae: 9.8 }, incremental_information: 'FIXTURE' } },
  total: { tier: 'RESEARCH', required_edge_points: null, tier_basis: 'FIXTURE: research', blend: { latest_coef: { intercept: 0, close: 1, model_minus_close: 0.1 }, latest_sigma: 13.2 } },
  moneyline: { tier: 'RESEARCH', required_edge_points: null, tier_basis: 'FIXTURE: research', holdouts: [{ season: 2025, coef: { market: 1, model_minus_market: 0.2 } }] } } };
const V_NFL_VALIDATED = JSON.parse(JSON.stringify(V_NFL)); V_NFL_VALIDATED.markets.spread.tier = 'VALIDATED'; V_NFL_VALIDATED.markets.spread.tier_basis = 'FIXTURE: validated';
const V_CFB = { schema: 'edgedesk_pricing_validation_v1', sport: CFB, markets: { spread: { tier: 'RESEARCH', required_edge_points: null, tier_basis: 'FIXTURE: no threshold cleared', blend: null }, total: { tier: 'RESEARCH', tier_basis: 'FIXTURE' }, moneyline: { tier: 'RESEARCH', tier_basis: 'FIXTURE' } } };
chk('a validation record loads per sport', P.loadValidation(NFL, V_NFL) && P.loadValidation(CFB, V_CFB) && P.validationFor(NFL, 'spread').tier === 'LEAN' && P.validationFor(CFB, 'spread').tier === 'RESEARCH');
chk('an unloaded sport is RESEARCH and says so', P.validationFor('basketball_nba', 'spread').tier === 'RESEARCH' && /no pricing validation is loaded/.test(P.validationFor('basketball_nba', 'spread').basis));

/* ---- fair lines ---------------------------------------------------------- */
const F = P.fairSpread({ sport: NFL, model_home_line: -9, market_home_line: -4.5 });
chk('the fair line is the blend: 4.5 + 0.25 x (9 - 4.5) = 5.625 home margin', F.ok && F.status === 'BLENDED' && Math.abs(F.fair_home_line + 5.63) < 0.02 && F.gap_points === 4.5 && F.sigma === 12.8, F);
chk('with no market the fair line is the projection and says MODEL_ONLY', P.fairSpread({ sport: NFL, model_home_line: -9 }).status === 'MODEL_ONLY' && P.fairSpread({ sport: NFL, model_home_line: -9 }).fair_home_line === -9);
const FC = P.fairSpread({ sport: CFB, model_home_line: -20, market_home_line: -14 });
chk('with no validated blend the market is the fair price and the projection is a stated disagreement', FC.status === 'MARKET_ANCHORED' && FC.fair_home_line === -14 && /research disagreement of 6 points/.test(FC.basis), FC);
chk('with nothing on file the fair line refuses', P.fairSpread({ sport: NFL }).ok === false);
const FT = P.fairTotal({ sport: NFL, model_total: 50, market_total: 44 });
chk('the fair total blends the same way', FT.ok && Math.abs(FT.fair_total - 44.6) < 0.01 && FT.tier === 'RESEARCH');
const FM = P.fairMoneyline({ sport: NFL, model_home_win_prob: 0.7, market_home_ml: -150, market_away_ml: 130 });
chk('the fair moneyline de-vigs the two-way market and blends on the logit scale', FM.ok && FM.status === 'BLENDED' && FM.fair_home_win_prob > 0.58 && FM.fair_home_win_prob < 0.66 && FM.overround > 0, FM);

/* ---- probabilities and bet-to ------------------------------------------- */
const c = P.coverAt(-5.5, -5.5, 12.8);
chk('at the fair line a half-point number covers 50%', c.cover === 0.5 && c.push === 0);
const cw = P.coverAt(-5.5, -5, 12.8);
chk('a whole number carries a push mass and the cover is trimmed by half of it', cw.push > 0.02 && cw.push < 0.04 && Math.abs(cw.cover + cw.push / 2 - 0.5156) < 0.002, cw);
chk('break-even at -110 is 52.38%, refunded pushes lower it', P.breakEven(-110, 0) === 0.5238 && P.breakEven(-110, 0.03) < 0.5238 && P.breakEven(150, 0) === 0.4);
chk('the inverse normal is right at the quartiles', Math.abs(P.normInv(0.75) - 0.6745) < 0.001 && Math.abs(P.normInv(0.5238) - 0.0597) < 0.001);
const home = P.priceSpreadSide({ fair: F, side: 'home', selection: 'Home', odds_american: -110 });
chk('the home side at -4.5 vs a fair -5.63 covers more than break-even and is LEAN_PLAY under a LEAN tier', home.status === 'LEAN_PLAY' && home.cover_at_market > 0.53 && home.edge_pp > 0 && home.tier === 'LEAN', home);
chk('the bet-to line is where the fair cover meets break-even, rounded to the half point (fair -5.63 + 12.8 x 0.0597 = -4.87 -> -5)', home.bet_to_line === -5, home.bet_to_line);
chk('the price that makes -4.5 break-even is juicier than -110', home.price_at_market_line < -110, home.price_at_market_line);
const away = P.priceSpreadSide({ fair: F, side: 'away', selection: 'Away', odds_american: -110 });
chk('the other side is a PASS because the projection favours the home side', away.status === 'PASS' && /favours the other side/.test(away.why), away);
const small = P.priceSpreadSide({ fair: P.fairSpread({ sport: NFL, model_home_line: -5.2, market_home_line: -4.5 }), side: 'home', odds_american: -110 });
chk('a disagreement under the graded threshold is a PASS that names the threshold', small.status === 'PASS' && /below the 1.5-point threshold/.test(small.why), small.why);
const priced = P.priceSpreadSide({ fair: F, side: 'home', odds_american: -145 });
chk('a bad price turns a LEAN_PLAY into a PASS that names the bet-to line', priced.status === 'PASS' && /becomes a number at/.test(priced.why) && priced.break_even > 0.59, priced);
const cfbSide = P.priceSpreadSide({ fair: FC, side: 'home', odds_american: -110 });
chk('a RESEARCH market is CONDITIONAL whatever the arithmetic says', cfbSide.status === 'CONDITIONAL' && /not a recommendation/.test(cfbSide.why));
chk('a missing price is assumed at -110 and flagged', P.priceSpreadSide({ fair: F, side: 'home' }).odds_assumed === true && P.priceSpreadSide({ fair: F, side: 'home' }).odds_american === -110);
chk('no market line means NO_MARKET, with the fair line still stated', P.priceSpreadSide({ fair: P.fairSpread({ sport: NFL, model_home_line: -9 }), side: 'home' }).status === 'NO_MARKET');
const over = P.priceTotalSide({ fair: FT, side: 'over', odds_american: -110 });
chk('a total side prices the same way and is CONDITIONAL under RESEARCH', over.status === 'CONDITIONAL' && over.cover_at_market > 0.5 && over.bet_to_total != null, over);
const mlH = P.priceMoneylineSide({ fair: FM, side: 'home', selection: 'Home' });
chk('a moneyline side under RESEARCH is CONDITIONAL and never a bet-to', mlH.status === 'CONDITIONAL' && mlH.bet_to_line === undefined);

/* ---- sizing -------------------------------------------------------------- */
chk('LEAN produces no sizing fraction and says why', P.sizing(home).fraction === null && /VALIDATED/.test(P.sizing(home).reason));
P.loadValidation(NFL, V_NFL_VALIDATED);
const FV = P.fairSpread({ sport: NFL, model_home_line: -9, market_home_line: -4.5 });
const homeV = P.priceSpreadSide({ fair: FV, side: 'home', odds_american: -110 });
chk('under VALIDATED the same side is a PLAY', homeV.status === 'PLAY' && homeV.tier === 'VALIDATED');
const sz = P.sizing(homeV);
chk('sizing is quarter Kelly capped at 2%', sz.fraction > 0 && sz.fraction <= 0.02 && /quarter Kelly/.test(sz.basis) && Math.abs(sz.fraction - Math.min(0.02, 0.25 * sz.full_kelly)) < 1e-4, sz);
P.loadValidation(NFL, V_NFL);

/* ---- the packet ---------------------------------------------------------- */
const packet = { game: { sport: NFL, home: 'Buffalo Bills', away: 'Detroit Lions' }, model: { home_line: { value: -9 }, fair_total: { value: 50 }, home_win_probability: { value: 0.7 } },
  market: { primary: { market: 'spreads', selection: 'Buffalo Bills', side: 'home', handicap: -4.5, odds_american: -110, odds_decimal: 1.91, book: 'DraftKings', captured_at: '2026-09-16T10:00:00Z' }, consensus: { spread_home: -4.5, total: 44, home_moneyline: -150, away_moneyline: 130 } },
  comparison: { orientation: { side: 'home', selection: 'Buffalo Bills', model_selection_line: -9, market_selection_line: -4.5 } } };
const PR = P.price({ packet, now: Date.parse('2026-09-16T11:00:00Z') });
chk('the packet is priced across six sides', PR && PR.sides.length === 6 && PR.fair.spread.status === 'BLENDED' && PR.quoted_side && PR.quoted_side.book === 'DraftKings');
chk('the best side is the quoted LEAN_PLAY and the headline says LEAN, not edge', PR.best.status === 'LEAN_PLAY' && /LEAN tier/.test(PR.headline) && /not an edge/.test(PR.headline), PR.headline);
chk('the headline states the fair line against the market', /Fair line Buffalo Bills -5\.6\d? against a market of -4\.5/.test(PR.headline), PR.headline);
chk('the sizing on the packet is null under LEAN', PR.sizing.fraction === null);
const blk = P.promptBlock(PR);
chk('the prompt block carries the headline, the fair spread, every side and the rules', /HEADLINE/.test(blk) && /FAIR SPREAD: Buffalo Bills -5\.6/.test(blk) && (blk.match(/: (LEAN_PLAY|PASS|CONDITIONAL|PROBABILITY|NO_MARKET)\./g) || []).length === 6 && /never say "bet"/.test(blk), blk.slice(0, 400));
const PRC = P.price({ packet: { game: { sport: CFB, home: 'North Texas', away: 'Texas State' }, model: { home_line: { value: -20 } }, market: { consensus: { spread_home: -14 } }, comparison: {} } });
chk('a CFB packet with only a consensus prices both spread sides as CONDITIONAL', PRC.sides.filter((s) => s.market === 'spread').every((s) => s.status === 'CONDITIONAL') && PRC.fair.spread.status === 'MARKET_ANCHORED');
chk('a packet with nothing to price returns a fair-line refusal, not a crash', P.price({ packet: { game: { sport: NFL, home: 'A', away: 'B' } } }).sides.length === 0);

/* ---- the slate ---------------------------------------------------------- */
const slate = P.rankSlate({ sport: NFL, games: [
  { game_id: '1', home: 'A', away: 'B', model_home_line: -9, market_home_line: -4.5, completeness: 0.9 },
  { game_id: '2', home: 'C', away: 'D', model_home_line: -3, market_home_line: -3, completeness: 1 },
  { game_id: '3', home: 'E', away: 'F', model_home_line: -1, market_home_line: 6, completeness: 0.6 },
  { game_id: '4', home: 'G', away: 'H', model_home_line: null, market_home_line: null } ] });
chk('the slate ranks LEAN_PLAY rows first, then PASS, then a game with no number last', slate.rows[0].status === 'LEAN_PLAY' && slate.rows[slate.rows.length - 1].status === 'NO_NUMBER' && slate.plays === 2, slate.rows.map((r) => [r.game_id, r.side, r.status, r.rank_score]));
chk('among plays the larger edge times completeness ranks first', slate.rows[0].game_id === '3' && slate.rows[1].game_id === '1', slate.rows.slice(0, 2));
chk('the slate note says break-even history, not an edge, under LEAN', /not an edge/.test(slate.note));
chk('a RESEARCH slate ranks nothing as a play', P.rankSlate({ sport: CFB, games: [{ game_id: 'x', home: 'A', away: 'B', model_home_line: -20, market_home_line: -10 }] }).plays === 0);

/* ---- the critic ------------------------------------------------------------ */
const noPlay = P.price({ packet: { game: { sport: CFB, home: 'North Texas', away: 'Texas State' }, model: { home_line: { value: -20 } }, market: { consensus: { spread_home: -14 } }, comparison: {} } });
chk('a bet recommended where no side is a play fails the critic', P.criticExtras({ answer: 'North Texas -14 is worth a bet down to -17.', pricing: noPlay }).some((i) => i.code === 'BET_TO_UNSUPPORTED' && i.severity === 'FAIL'));
chk('an EV claim fails the critic', P.criticExtras({ answer: 'This is a +EV spot with 4% edge.', pricing: PR }).some((i) => i.code === 'EV_CLAIM'));
chk('a bankroll fraction with no sizing fails the critic', P.criticExtras({ answer: 'Put 2% of your bankroll on it.', pricing: PR }).some((i) => i.code === 'SIZING_UNSUPPORTED'));
chk('calling a LEAN an edge without saying LEAN is a warning', P.criticExtras({ answer: 'Buffalo -4.5 is a value bet.', pricing: PR }).some((i) => i.code === 'LEAN_STATED_AS_EDGE'));
chk('an answer that quotes the block cleanly passes', P.criticExtras({ answer: 'Fair line Buffalo -5.6; at -4.5 the LEAN record says this is the right side of the number, to -5. Not an edge.', pricing: PR }).length === 0);

/* ---- movement ---------------------------------------------------------------- */
const MV_CFB = { schema: 'edgedesk_movement_validation_v1', sport: CFB, generated_at: '2026-09-16T00:00:00Z', result: { tier: 'LEAN', required_gap_points: 2, tier_basis: 'FIXTURE: toward the rating 53% at 2+ points, a tendency', toward_rating_by_gap: { '2': { n: 4369, toward_rate: 0.53, p_one_sided: 0 } }, open_vs_close_by_gap: { '2': { n: 4369, cover_at_open: 0.509, cover_at_close: 0.497, points_gained_by_betting_early: 0.26 } }, latest: { move_per_gap_point: 0.057 }, regression: { pooled_mae_pred: 1.64, pooled_mae_no_move: 1.6 } } };
const MV_VAL = JSON.parse(JSON.stringify(MV_CFB)); MV_VAL.result.tier = 'VALIDATED'; MV_VAL.result.regression = { pooled_mae_pred: 1.4, pooled_mae_no_move: 1.6 };
chk('with no movement validation loaded the read is NO_READ and says so', P.movement({ sport: NFL, open_home_line: -3, fair_home_line: -7 }).status === 'NO_READ' && /no movement validation/.test(P.movement({ sport: NFL, open_home_line: -3, fair_home_line: -7 }).why));
chk('without an opener there is no read', P.movement({ sport: CFB, fair_home_line: -7 }).status === 'NO_OPENER');
P.loadMovement(CFB, MV_CFB);
const mv = P.movement({ sport: CFB, open_home_line: -3.5, market_home_line: -4, fair_home_line: -8 });
chk('under a LEAN movement tier a fair line 4.5 past the opener is a LEAN_READ: home BET NOW, away WAIT', mv.status === 'LEAN_READ' && mv.gap_at_open === -4.5 && mv.sides.home.verdict === 'BET_NOW' && mv.sides.away.verdict === 'WAIT' && /tendency, not a record/.test(mv.why), mv);
chk('the size of the move is not quoted when the regression did not beat the no-move baseline', mv.expected_close === null && /not predictable beyond the direction/.test(mv.why));
chk('a gap below the graded threshold is NO_READ naming the threshold', P.movement({ sport: CFB, open_home_line: -3.5, fair_home_line: -4.5 }).status === 'NO_READ' && /below the 2-point threshold/.test(P.movement({ sport: CFB, open_home_line: -3.5, fair_home_line: -4.5 }).why));
chk('a number that already moved past the fair line reads MOVED_PAST', P.movement({ sport: CFB, open_home_line: -3.5, market_home_line: -9, fair_home_line: -8 }).status === 'MOVED_PAST');
chk('the away side is favoured when the fair line likes the dog more than the opener did', P.movement({ sport: CFB, open_home_line: -7, fair_home_line: -3 }).sides.away.verdict === 'BET_NOW');
P.loadMovement(CFB, MV_VAL);
const mvV = P.movement({ sport: CFB, open_home_line: -3.5, fair_home_line: -8 });
chk('under VALIDATED the read is READ and the expected close is quoted when the regression beat the baseline (-3.5 + 0.057 x -4.5)', mvV.status === 'READ' && Math.abs(mvV.expected_close + 3.76) < 0.02, mvV);
P.loadMovement(CFB, MV_CFB);
const PRm = P.price({ packet: { game: { sport: CFB, home: 'North Texas', away: 'Texas State' }, model: { home_line: { value: -20 } }, market: { consensus: { spread_home: -14 } }, comparison: {} }, open_home_line: -10 });
chk('the packet carries the movement read against the fair line (market-anchored -14 vs an opener of -10)', PRm.movement && PRm.movement.status === 'LEAN_READ' && PRm.movement.gap_at_open === -4 && PRm.movement.sides.home.verdict === 'BET_NOW', PRm.movement);
chk('the prompt block carries the movement line and the timing rule', /MOVEMENT: LEAN_READ \[tier LEAN\]\. Opened -10, now -14, fair -14/.test(P.promptBlock(PRm)) && /Say "bet now" or "wait" only when MOVEMENT/.test(P.promptBlock(PRm)));
chk('a timing call with no movement read fails the critic', P.criticExtras({ answer: 'Bet it now before the number moves.', pricing: PR }).some((i) => i.code === 'TIMING_UNSUPPORTED'));
chk('a timing call with a LEAN_READ passes the timing check', !P.criticExtras({ answer: 'North Texas: bet it now before the number moves; a tendency, not a record.', pricing: PRm }).some((i) => i.code === 'TIMING_UNSUPPORTED'));

/* ---- tools ------------------------------------------------------------------ */
const Rk = require(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_research.js'));
chk('the tools register with the research kernel', P.registerTools() === true && Rk.TOOLS.get_price_ranges && Rk.TOOLS.get_ranked_slate);
const tr = Rk.TOOLS.get_price_ranges.run({ market: 'spread' }, { packet: { pricing: PR } });
chk('get_price_ranges returns the spread sides and the headline', tr.ok && tr.sides.length === 2 && tr.headline === PR.headline);
chk('get_ranked_slate refuses without a slate on the turn', Rk.TOOLS.get_ranked_slate.run({}, {}).ok === false);
done();
