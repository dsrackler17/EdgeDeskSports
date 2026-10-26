#!/usr/bin/env node
/* ===========================================================================
   lib/edgedesk_sharp_lag.js — the Sharp-lag research core, without a network.
     devig     Shin, identical to capture's devig() (imported from the deployed
               function under Node's type stripping), underround -> proportional
     quotes    a gateway body (decimal or American, /odds or one event) -> rows
     rules     every number is public.sharp_lag_rule()'s
     triggers  Kalshi moves of 3c+, starter status changes, goalie changes
     fee       the highest plausible Kalshi fee until a verified schedule is on
               file; then the verified one, and the flag says which
     flags     the 2.5 pp rule after fees, same side and point only, past
               prices never flagged, an open episode never flagged twice,
               snapshot resolution recorded
     grades    the close (<= 90 min before the start, else no close), CLV, hit,
               lag to converge (censored at the start)
     record    the game-clustered bootstrap, the BOTH-conditions validation,
               the splits, the no-close rate
     display   the 90-minute past-price rule, Experimental on every surface,
               the progress line, research language only
   Run: node tools/sharp_lag/core.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..', '..');
const L = require(path.join(ROOT, 'lib', 'edgedesk_sharp_lag.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }
const near = (a, b, e) => a != null && b != null && Math.abs(a - b) <= (e == null ? 1e-9 : e);

const NOW = '2026-11-02T18:00:00Z', T = Date.parse(NOW);
const at = (min) => new Date(T + min * 60000).toISOString();
const KICK = at(240);
const EV = { event_id: 'ev1', sport_key: 'americanfootball_nfl', home_team: 'Philadelphia Eagles', away_team: 'Dallas Cowboys', commence_time: KICK };
const row = (book, market, side, dec, point, participant) => ({ event_id: 'ev1', book, market, side, point: point == null ? null : point, participant: participant || null, price_dec: dec });
const pinRows = (h, a) => [row('pinnacle', 'h2h', 'Philadelphia Eagles', h), row('pinnacle', 'h2h', 'Dallas Cowboys', a),
  row('pinnacle', 'spreads', 'Philadelphia Eagles', 1.95, -3.5), row('pinnacle', 'spreads', 'Dallas Cowboys', 1.95, 3.5),
  row('pinnacle', 'totals', 'Over', 1.91, 47.5), row('pinnacle', 'totals', 'Under', 1.99, 47.5)];
const PIN = (min, h, a, extra) => Object.assign({ observed_at: at(min), request_id: 100 + Math.abs(min), category: 'featured', resolution_s: 3600, rows: pinRows(h || 1.6, a || 2.5) }, extra || {});

(async () => {
  /* ── devig ──────────────────────────────────────────────────────────── */
  let cap = null;
  try { cap = await import(path.join(ROOT, 'supabase', 'functions', 'capture', 'index.ts')); } catch (e) { cap = null; }
  const pairs = [[1.6, 2.5], [1.91, 1.91], [1.25, 4.4], [3.1, 1.42], [1.05, 13.0]];
  chk('devig: Shin here is capture\'s devig() to 1e-12 on every pair (one Pinnacle fair across the stack)', cap && pairs.every((p) => {
    const a = L.devigShin(p).probs, b = cap.devig(p, 'shin'); return near(a[0], b[0], 1e-12) && near(a[1], b[1], 1e-12);
  }), cap ? null : 'capture/index.ts could not be imported');
  const d = L.devigShin([1.6, 2.5]);
  chk('devig: a normal pair is Shin, sums to 1, and keeps the favourite above its multiplicative share', d.method === 'shin' && near(d.probs[0] + d.probs[1], 1, 1e-12) && d.probs[0] > (1 / 1.6) / (1 / 1.6 + 1 / 2.5));
  const u = L.devigShin([2.1, 2.1]);
  chk('devig: an underround pair is normalised proportionally and SAYS so', u.method === 'multiplicative' && near(u.probs[0], 0.5));

  /* ── fee ────────────────────────────────────────────────────────────── */
  const f0 = L.kalshiFee(0.5);
  chk('fee: no verified schedule -> the highest plausible fee (0.07, one contract, rounded up to the cent), marked unverified', f0.per_contract === 0.02 && f0.unverified === true && f0.basis === 'highest_plausible');
  chk('fee: it is symmetric in price and 1 - price, and 1c at the extremes', L.kalshiFee(0.3).per_contract === L.kalshiFee(0.7).per_contract && L.kalshiFee(0.03).per_contract === 0.01);
  const fv = L.kalshiFee(0.5, { taker_coefficient: 0.07, verified_at: '2026-11-01T00:00:00Z', verified_by: 'operator', source_url: 'x' });
  chk('fee: a verified schedule is used and named (0.07 x 100 x 0.25 = 1.75 -> 1.75c a contract)', fv.per_contract === 0.0175 && fv.unverified === false && fv.basis === 'verified');
  chk('fee: an unverified row (no verified_at) is not trusted', L.kalshiFee(0.5, { taker_coefficient: 0.01 }).unverified === true);
  chk('fee: the unverified fee is never below the verified one at the same coefficient', [0.1, 0.25, 0.5, 0.62, 0.9].every((p) => L.kalshiFee(p).per_contract >= L.kalshiFee(p, { taker_coefficient: 0.07, verified_at: 'x' }).per_contract));
  chk('kalshi cost: one-sided or wider than 6c has no cost', L.kalshiCost({ yes_bid: 0, yes_ask: 0.5 }) === null && L.kalshiCost({ yes_bid: 0.4, yes_ask: 0.47 }) === null);
  chk('kalshi cost: ask plus fee', L.kalshiCost({ yes_bid: 0.55, yes_ask: 0.57 }).cost === 0.59);

  /* ── quotes ─────────────────────────────────────────────────────────── */
  const body = [{ id: 'ev1', sport_key: 'americanfootball_nfl', commence_time: KICK, home_team: EV.home_team, away_team: EV.away_team, bookmakers: [
    { key: 'pinnacle', last_update: at(-5), markets: [{ key: 'h2h', outcomes: [{ name: EV.home_team, price: 1.6 }, { name: EV.away_team, price: 2.5 }] }] },
    { key: 'fanduel', markets: [{ key: 'h2h', outcomes: [{ name: EV.home_team, price: 1.62 }, { name: EV.away_team, price: 2.4 }] }] },
    { key: 'draftkings', markets: [{ key: 'spreads', outcomes: [{ name: EV.home_team, price: 1.91, point: -3.5 }, { name: EV.away_team, price: 1.91, point: 3.5 }] }] }] }];
  const q = L.quotesFromOdds(body, { books: ['pinnacle', 'draftkings'], markets: ['h2h', 'spreads', 'totals'] });
  chk('quotes: only the named books (Pinnacle and DraftKings), each outcome a row', q.length === 4 && q.every((r) => r.book !== 'fanduel'), q.map((r) => r.book + r.market));
  const qa = L.quotesFromOdds({ id: 'e2', bookmakers: [{ key: 'pinnacle', markets: [{ key: 'h2h', outcomes: [{ name: 'A', price: -150 }, { name: 'B', price: 130 }] }] }] }, { books: ['pinnacle'], format: 'american' });
  chk('quotes: one event (/events/{id}/odds) in American is converted to decimal', qa.length === 2 && near(qa[0].price_dec, 1.6667, 1e-4) && qa[1].price_dec === 2.3);
  const qp = L.quotesFromOdds({ id: 'e3', bookmakers: [{ key: 'draftkings', markets: [{ key: 'player_rebounds', outcomes: [{ name: 'Over', description: 'Miles Bridges', price: 1.87, point: 6.5 }, { name: 'Under', description: 'Miles Bridges', price: 1.95, point: 6.5 }, { name: 'Over', description: 'Someone Else', price: 1.9, point: 3.5 }] }] }] },
    { books: ['draftkings'], participants: (n) => n === 'Miles Bridges' });
  chk('quotes: a player market keeps the player, and only the players asked for', qp.length === 2 && qp.every((r) => r.participant === 'Miles Bridges'));

  /* ── flags ──────────────────────────────────────────────────────────── */
  const F = L.fairs(pinRows(1.6, 2.5));
  chk('fairs: h2h, the spread pair (-3.5 / +3.5) and the total pair each devig together', Object.keys(F).length === 6 && near(F['h2h|Philadelphia Eagles||'].fair + F['h2h|Dallas Cowboys||'].fair, 1, 1e-4));
  const fairHome = F['h2h|Philadelphia Eagles||'].fair;
  const dkAt = (min, rows) => ({ observed_at: at(min), request_id: 200, resolution_s: 3600, rows });
  const evalDK = (dec, o) => L.evaluate(Object.assign({ now: NOW, event: EV, pinnacle: PIN(-10), draftkings: dkAt(-10, [row('draftkings', 'h2h', 'Philadelphia Eagles', dec), row('draftkings', 'h2h', 'Dallas Cowboys', 2.2)]) }, o || {}));
  const decAtGap = (gp) => 1 / (fairHome - gp / 100);
  let r = evalDK(decAtGap(2.6));
  chk('flags: DraftKings 2.6 pp below the Pinnacle fair (vig included) is flagged', r.flags.length === 1 && r.flags[0].target_venue === 'draftkings' && r.flags[0].gap_pp >= 2.5, r);
  const fl = r.flags[0];
  chk('flags: the row carries the trigger, both prices, the gap, the times and the seconds since Pinnacle', fl.trigger_type === 'scheduled' && fl.pinnacle_price_dec === 1.6 && fl.pinnacle_opp_dec === 2.5
    && fl.reference_kind === 'pinnacle_shin' && fl.devig_method === 'shin' && fl.seconds_since_reference === 600 && fl.target_observed_at === at(-10) && fl.reference_observed_at === at(-10), fl);
  chk('flags: the snapshot resolution is recorded (the coarser of the two sources)', fl.snapshot_resolution_s === 3600 && fl.reference_resolution_s === 3600 && fl.target_resolution_s === 3600);
  chk('flags: 2.4 pp is not flagged', evalDK(decAtGap(2.4)).flags.length === 0);
  chk('flags: a Pinnacle observation 91 minutes old flags nothing (a past price)', L.evaluate({ now: NOW, event: EV, pinnacle: PIN(-91), draftkings: dkAt(-5, [row('draftkings', 'h2h', 'Philadelphia Eagles', 2.0)]) }).skipped.reference_past_price === 1);
  chk('flags: a DraftKings price 91 minutes old flags nothing', L.evaluate({ now: NOW, event: EV, pinnacle: PIN(-5), draftkings: dkAt(-91, [row('draftkings', 'h2h', 'Philadelphia Eagles', 2.0)]) }).flags.length === 0);
  chk('flags: nothing once the game has started', L.evaluate({ now: NOW, event: Object.assign({}, EV, { commence_time: at(-1) }), pinnacle: PIN(-5), draftkings: dkAt(-5, [row('draftkings', 'h2h', 'Philadelphia Eagles', 2.0)]) }).flags.length === 0);
  r = L.evaluate({ now: NOW, event: EV, pinnacle: PIN(-5), draftkings: dkAt(-5, [row('draftkings', 'spreads', 'Philadelphia Eagles', 2.2, -3.0), row('draftkings', 'spreads', 'Dallas Cowboys', 1.7, 3.0)]) });
  chk('flags: a spread at another point is never compared (same point only)', r.flags.length === 0 && r.skipped.no_reference_for_side === 2, r.skipped);
  r = L.evaluate({ now: NOW, event: EV, pinnacle: PIN(-5), draftkings: dkAt(-5, [row('draftkings', 'totals', 'Under', 2.3, 47.5)]) });
  chk('flags: the same total point is compared', r.flags.length === 1 && r.flags[0].market === 'totals' && r.flags[0].point === 47.5);
  r = evalDK(decAtGap(3), { open: () => true });
  chk('flags: an open episode on the same side is not flagged again', r.flags.length === 0 && r.skipped.episode_open === 1);
  const kal = (bid, ask, min) => [{ ticker: 'KXNFLGAME-26NOV02DALPHI-PHI', yes_team: 'Philadelphia Eagles', snapshot: { id: 9, captured_at: at(min == null ? -3 : min), yes_bid: bid, yes_ask: ask }, resolution_s: 300 }];
  const askAt = (gp) => Math.floor((fairHome - gp / 100 - 0.02) * 100) / 100;
  r = L.evaluate({ now: NOW, event: EV, pinnacle: PIN(-5), kalshi: kal(askAt(3) - 0.01, askAt(3)) });
  chk('flags: Kalshi YES ask + the highest plausible fee, 2.5 pp+ under the fair -> flagged, fee_unverified', r.flags.length === 1 && r.flags[0].target_venue === 'kalshi' && r.flags[0].fee_unverified === true
    && r.flags[0].fee_basis === 'highest_plausible' && r.flags[0].fee_per_contract === 0.02 && r.flags[0].target_ref === 'KXNFLGAME-26NOV02DALPHI-PHI', r);
  chk('flags: Kalshi resolution is the 5-minute snapshot, so the flag\'s resolution is the coarser Pinnacle hour', r.flags[0].target_resolution_s === 300 && r.flags[0].snapshot_resolution_s === 3600);
  const verified = { taker_coefficient: 0.07, verified_at: '2026-11-01T00:00:00Z', verified_by: 'op' };
  const rv = L.evaluate({ now: NOW, event: EV, pinnacle: PIN(-5), kalshi: kal(askAt(3) - 0.01, askAt(3)), fee: verified });
  chk('flags: with a verified schedule the same price is flagged without the unverified mark', rv.flags.length === 1 && rv.flags[0].fee_unverified === false && rv.flags[0].fee_basis === 'verified');
  chk('flags: a Kalshi quote 16 minutes old is not used', L.evaluate({ now: NOW, event: EV, pinnacle: PIN(-5), kalshi: kal(0.3, 0.31, -16) }).flags.length === 0);
  chk('flags: a wide Kalshi quote is not used', L.evaluate({ now: NOW, event: EV, pinnacle: PIN(-5), kalshi: kal(0.3, 0.37) }).skipped.kalshi_not_two_sided_or_wide === 1);
  r = L.evaluate({ now: NOW, event: EV, pinnacle: PIN(-5, null, null, { category: 'sharp_check' }), kalshi: kal(askAt(4) - 0.01, askAt(4)), trigger: { type: 'nba_injury', id: 77 } });
  chk('flags: the trigger behind a triggered check is carried', r.flags[0].trigger_type === 'nba_injury' && r.flags[0].trigger_id === 77 && r.flags[0].reference_category === 'sharp_check');
  chk('flags: episode keys differ by venue and side, and by the observation that opened them', r.flags[0].episode_key !== evalDK(decAtGap(3)).flags[0].episode_key && /#kalshi#h2h\|Philadelphia Eagles/.test(r.flags[0].episode_key));

  /* ── convergence and grades ─────────────────────────────────────────── */
  const flag = Object.assign({}, evalDK(decAtGap(3)).flags[0], { flag_id: 1 });
  const dkObs = (min, dec) => ({ observed_at: at(min), rows: [row('draftkings', 'h2h', 'Philadelphia Eagles', dec)] });
  const refs = [PIN(-10), PIN(60), PIN(200)];
  let cv = L.convergence(flag, { reference: refs, target: [dkObs(50, decAtGap(2)), dkObs(110, decAtGap(0.8))], until: KICK });
  chk('converge: the first DraftKings price within 1.0 pp of the current Pinnacle fair ends the lag', cv.converged && cv.converged_at === at(110) && cv.lag_s === 110 * 60, cv);
  cv = L.convergence(flag, { reference: refs, target: [dkObs(50, decAtGap(2)), dkObs(250, decAtGap(0))], until: KICK });
  chk('converge: a price after the start does not count (censored at the start)', !cv.converged);
  let g = L.grade(flag, { reference: refs, target: [dkObs(110, decAtGap(0.8)), dkObs(230, 1.7)] });
  const fair200 = L.fairs(PIN(200).rows)['h2h|Philadelphia Eagles||'].fair;
  chk('grade: the close is the last Pinnacle observation before the start (40 min before)', g.close_status === 'graded' && g.closing_reference_at === at(200) && g.close_lead_min === 40, g);
  chk('grade: CLV = closing Pinnacle fair - the flag\'s all-in cost, in pp; a hit when positive', near(g.clv_pp, Math.round((fair200 - flag.target_cost_prob) * 10000) / 100, 0.011) && g.hit === (g.clv_pp > 0), g);
  chk('grade: the target\'s closing price is attached', g.closing_target_price === 1.7 && g.closing_target_at === at(230));
  chk('grade: the lag and its resolution are carried', g.converged && g.lag_to_converge_s === 6600 && g.lag_resolution_s === 3600 && g.lag_censored === false);
  g = L.grade(flag, { reference: [PIN(-10), PIN(140)], target: [] });
  chk('grade: a last Pinnacle observation 100 minutes before the start is NO CLOSE, with the reason, and no CLV', g.close_status === 'no_close' && g.clv_pp === null && g.hit === null && /100 minutes before the start/.test(g.no_close_reason), g);
  const kflag = Object.assign({}, r.flags[0], { flag_id: 2 });
  g = L.grade(kflag, { reference: refs, target: [{ id: 10, captured_at: at(200), yes_bid: 0.6, yes_ask: 0.62 }, { id: 11, captured_at: at(239), yes_bid: 0.6, yes_ask: 0.61 }] });
  chk('grade: a Kalshi flag closes on the last two-sided snapshot before the start, on the flag\'s own fee basis', g.closing_target_price === 0.61 && g.closing_target_cost === 0.63 && g.closing_target_at === at(239), g);

  /* ── triggers ───────────────────────────────────────────────────────── */
  const snaps = [{ id: 1, ticker: 'K', captured_at: at(-15), yes_bid: 0.5, yes_ask: 0.52 }, { id: 2, ticker: 'K', captured_at: at(-10), yes_bid: 0.53, yes_ask: 0.55 },
    { id: 3, ticker: 'K', captured_at: at(-5), yes_bid: 0.53, yes_ask: 0.6 }, { id: 4, ticker: 'K', captured_at: at(-4), yes_bid: 0.49, yes_ask: 0.51 }, { id: 5, ticker: 'K', captured_at: at(20), yes_bid: 0.2, yes_ask: 0.22 }];
  const mv = L.kalshiMoves(snaps);
  chk('triggers: a 3c mid move between consecutive two-sided snapshots is a move; a wide quote and a 24-minute gap are not', mv.length === 1 && mv[0].from_snapshot_id === 1 && mv[0].to_snapshot_id === 2 && near(mv[0].move, 0.03, 1e-9), mv);
  const ch = L.statusChanges({ a: 'QUESTIONABLE', b: 'OUT' }, { a: 'OUT', c: 'DOUBTFUL' }, [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }, { id: 'd', name: 'D' }]);
  chk('triggers: a starter\'s status change, listed -> off the report and on, each count; an unchanged one does not', ch.length === 3 && ch.find((x) => x.player_id === 'b').to === 'NOT_LISTED' && ch.find((x) => x.player_id === 'c').from === 'NOT_LISTED', ch);
  const gc = L.goalieChanges([{ id: 1, game_id: 'g', team: 'TOR', side: 'home', goalie_id: '8', goalie_name: 'A', status: 'projected', fetched_at: at(-60) },
    { id: 2, game_id: 'g', team: 'TOR', side: 'home', goalie_id: '8', goalie_name: 'A', status: 'confirmed', fetched_at: at(-30) },
    { id: 3, game_id: 'g', team: 'TOR', side: 'home', goalie_id: '9', goalie_name: 'B', status: 'confirmed', fetched_at: at(-10) }]);
  chk('triggers: a goalie\'s status change and a change of goalie are each a change', gc.length === 2 && gc[1].to.goalie === 'B', gc);
  chk('triggers: the top 5 of a reference rotation by minutes are the starters', L.topByMinutes([{ id: 1, minutes: 10 }, { id: 2, minutes: 30 }, { id: 3, minutes: 20 }], 2).map((p) => p.id).join() === '2,3');
  const ix = L.nameIndex({ 12: ['LA Clippers', 'Los Angeles Clippers'], 13: ['Los Angeles Lakers'] });
  const m1 = L.matchEvent({ home: '12', away: '13', start: at(0) }, [{ id: 'x', home_team: 'Los Angeles Clippers', away_team: 'Los Angeles Lakers', commence_time: at(30) }, { id: 'y', home_team: 'Los Angeles Lakers', away_team: 'Los Angeles Clippers', commence_time: at(30) }], ix);
  chk('identity: a provider event matches on both clubs (aliases included) and a start within 6 h', m1 && m1.id === 'x');
  chk('identity: two candidates are no match, never a guess', L.matchEvent({ home: '12', away: '13', start: at(0) }, [{ id: 'x', home_team: 'LA Clippers', away_team: 'Los Angeles Lakers', commence_time: at(30) }, { id: 'z', home_team: 'Los Angeles Clippers', away_team: 'Los Angeles Lakers', commence_time: at(60) }], ix) === null);

  /* ── record ─────────────────────────────────────────────────────────── */
  const rows = [];
  for (let gi = 0; gi < 60; gi++) for (let k = 0; k < (gi % 3) + 1; k++) rows.push({ model_key: 'SHARP-LAG', event_id: 'g' + gi, sport_key: gi % 2 ? 'basketball_nba' : 'americanfootball_nfl', market: k ? 'spreads' : 'h2h',
    trigger_type: gi % 4 ? 'scheduled' : 'kalshi_move', target_venue: 'draftkings', close_status: 'graded', clv_pp: (gi % 5) - 1.5, converged: gi % 2 === 0, lag_to_converge_s: gi % 2 ? null : 1800, snapshot_resolution_s: 3600 });
  rows.push({ model_key: 'SHARP-LAG', event_id: 'nc', sport_key: 'icehockey_nhl', market: 'h2h', trigger_type: 'nhl_goalie', close_status: 'no_close', clv_pp: null, converged: false });
  rows.push({ model_key: 'SHARP-LAG', event_id: 'pend', sport_key: 'icehockey_nhl', market: 'h2h', trigger_type: 'nhl_goalie', close_status: null });
  const b1 = L.clusterBootstrap(rows.filter((x) => x.close_status === 'graded').map((x) => ({ cluster: x.event_id, value: x.clv_pp })));
  const b2 = L.clusterBootstrap(rows.filter((x) => x.close_status === 'graded').map((x) => ({ cluster: x.event_id, value: x.clv_pp })));
  chk('bootstrap: seeded, so the published interval is reproducible', JSON.stringify(b1) === JSON.stringify(b2) && b1.lo < b1.mean && b1.mean < b1.hi && b1.clusters === 60);
  const flat = L.clusterBootstrap(rows.filter((x) => x.close_status === 'graded').map((x, i) => ({ cluster: 'f' + i, value: x.clv_pp })));
  const corr = [];
  for (let gi = 0; gi < 40; gi++) { const v = (gi % 2 ? 1 : -1) * 3; for (let k = 0; k < 5; k++) corr.push({ cluster: 'c' + gi, value: v + k * 0.01 }); }
  const cl = L.clusterBootstrap(corr), nc = L.clusterBootstrap(corr.map((x, i) => ({ cluster: 'n' + i, value: x.value })));
  chk('bootstrap: correlated flags in one game widen the interval against treating each flag as independent', (cl.hi - cl.lo) > (nc.hi - nc.lo) * 1.5, [cl, nc]);
  chk('bootstrap: the flat interval is a fallback the record never uses', flat.clusters > b1.clusters);
  const v199 = L.validation(Array.from({ length: 199 }, (_, i) => ({ close_status: 'graded', clv_pp: 2, event_id: 'e' + i })));
  const v200 = L.validation(Array.from({ length: 200 }, (_, i) => ({ close_status: 'graded', clv_pp: 2 + (i % 3) * 0.1, event_id: 'e' + i })));
  const v200neg = L.validation(Array.from({ length: 200 }, (_, i) => ({ close_status: 'graded', clv_pp: ((i >> 3) % 2 ? 6.5 : -5.5), event_id: 'e' + (i >> 3) })));
  chk('validation: 199 graded flags with a positive bound are NOT eligible', v199.eligible === false && v199.progress === '199 of 200 graded flags');
  chk('validation: 200 graded flags with the lower bound above zero are eligible; the status stays EXPERIMENTAL (a person promotes)', v200.eligible === true && v200.status === 'EXPERIMENTAL');
  chk('validation: 200 graded flags with a positive mean but a lower bound under zero are NOT eligible', v200neg.ci.mean > 0 && v200neg.ci.lo < 0 && v200neg.eligible === false, v200neg.ci);
  const rec = L.record(rows, { model_key: 'SHARP-LAG' });
  chk('record: every flag counts; no-close and pending are counted, not dropped', rec.overall.flags === rows.length && rec.overall.no_close === 1 && rec.overall.pending === 1 && rec.overall.graded === rows.length - 2);
  chk('record: the no-close rate is of the closed flags', near(rec.overall.no_close_rate, 1 / (rows.length - 1), 1e-4));
  chk('record: split by sport, market and trigger', rec.by_sport.length === 3 && rec.by_market.length === 2 && rec.by_trigger.map((x) => x.key).join() === 'kalshi_move,nhl_goalie,scheduled');
  chk('record: lag to converge averages converged flags only, with the never-converged counted and the resolution beside it', rec.overall.avg_lag_s === 1800 && rec.overall.censored > 0 && rec.overall.median_resolution_s === 3600);

  /* ── display ────────────────────────────────────────────────────────── */
  chk('display: 90 minutes is current, 91 is a past price (lib/edgedesk_games.js market_limit_min)', !L.isPast(at(-90), T) && L.isPast(at(-91), T) && /^past price/.test(L.priceAge(at(-91), T)));
  const gameHtml = L.gameSection({ now: T, flags: [flag, kflag].map((x) => Object.assign({}, x, { close_status: null })), validation: rec.validation, access: 'subscriber' });
  chk('display: the game section is tagged Experimental and shows target, fair, gap, trigger and each price\'s age', /Sharp lag · Experimental/.test(gameHtml) && /Pinnacle fair/.test(gameHtml) && /pp/.test(gameHtml)
    && /Scheduled check/.test(gameHtml) && /seen 10 min ago/.test(gameHtml) && /fee unverified/.test(gameHtml));
  chk('display: the registered threshold and the progress are on the section', /of 200 graded flags/.test(gameHtml) && /95% lower bound on mean CLV above zero, both/.test(gameHtml));
  const oldHtml = L.gameSection({ now: T + 3 * 3600e3, flags: [flag], validation: rec.validation, access: 'subscriber' });
  chk('display: three hours on, the same prices read as past prices, never current', /past price, 3 h ago/.test(oldHtml) && !/seen 3 h ago/.test(oldHtml));
  chk('display: a non-subscriber before the start gets no live detail, only the note and the progress', !/<table/.test(L.gameSection({ now: T, flags: [flag], validation: rec.validation, access: 'public', started: false })));
  chk('display: the snapshot resolution is stated with the lag', /measured only to the snapshot cadence: 60 min/.test(gameHtml));
  const feedHtml = L.feed({ now: T, flags: [flag, kflag], validation: [rec.validation] });
  chk('display: every feed item is tagged Experimental with its time', (feedHtml.match(/<li>/g) || []).length === 2 && (feedHtml.match(/sl-badge exp/g) || []).length >= 3 && /<time datetime=/.test(feedHtml));
  const recHtml = L.recordSection({ title: 'Sharp lag (Experimental)', record: rec });
  chk('display: the record shows count, CLV, hit rate, lag and the no-close data-quality line', /No close/.test(recHtml) && /Avg CLV/.test(recHtml) && /Hit rate/.test(recHtml) && /Avg lag to converge/.test(recHtml) && /had no usable close/.test(recHtml));
  const all = gameHtml + oldHtml + feedHtml + recHtml + L.EXPERIMENTAL_NOTE + L.FEE_NOTE;
  chk('display: research language only (no bet / pick / play / lock / wager / take / hammer / sharp action)', !/\b(bet|bets|betting|pick|picks|play this|lock|wager|take the|hammer|best bet|sharp action|units?)\b/i.test(all.replace(/not advice and not a recommendation/, '')),
    (all.match(/\b(bet|bets|betting|pick|picks|play this|lock|wager|take the|hammer|best bet|sharp action|units?)\b/ig) || []).slice(0, 5));
  chk('display: HTML is escaped', !/<script/.test(L.gameSection({ now: T, flags: [Object.assign({}, flag, { side: '<script>x</script>' })], access: 'subscriber' })));

  /* ── the rules are the database's ───────────────────────────────────── */
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'sharp_lag.sql'), 'utf8');
  const sqlRule = (k) => { const m = new RegExp("when '" + k + "'\\s+then ([0-9.]+)").exec(sql); return m ? Number(m[1]) : null; };
  const keys = ['gap_pp', 'role_shift_gap_pp', 'converge_pp', 'reference_max_age_min', 'book_target_max_age_min', 'kalshi_max_age_min', 'kalshi_max_spread', 'kalshi_move', 'kalshi_pair_max_min', 'close_max_lead_min', 'check_window_hours', 'validation_min_graded', 'ci_level', 'past_price_min'];
  chk('rules: every number in RULES is public.sharp_lag_rule()\'s (supabase/sharp_lag.sql)', keys.every((k) => sqlRule(k) === L.RULES[k]), keys.filter((k) => sqlRule(k) !== L.RULES[k]));
  chk('rules: the past-price limit is the existing display rule', /market_limit_min: 90/.test(fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_games.js'), 'utf8')) && L.RULES.past_price_min === 90);

  console.log((fail ? 'FAILED' : 'ALL GREEN') + ' sharp lag core: ' + pass + ' passed, ' + fail + ' failed');
  for (const f of failures) console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 700) : ''));
  process.exit(fail ? 1 : 0);
})();
