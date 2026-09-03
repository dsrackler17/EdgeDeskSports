#!/usr/bin/env node
/* ===========================================================================
   THE FIVE-SECOND TEST — tests for the public language layer.

   THE RULE UNDER TEST: a football fan who has never heard of de-vigging, a
   fair line, EV, CLV, a sharp book or closing-line value must be able to read
   any Simple / Publisher / share surface and answer six questions:

     1. What did EdgeDesk find?
     2. What is the call?
     3. Why did EdgeDesk make it?
     4. What price matters?
     5. What could make it wrong?
     6. Do I act, wait, or ignore it?

   And two things must NEVER happen:
     · an underdog price reading as a prediction that the underdog wins;
     · a number changing on its way from the engine to the page.

   Full Research is deliberately NOT under test here. It is allowed, and
   expected, to use precise terminology.

   Run: node tools/presentation/public_language.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const P = require(path.join(__dirname, '..', '..', 'supabase', 'functions', 'edgedesk_ai', '_presentation.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { ok = false; detail = { threw: String((e && e.message) || e) }; } }
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}
function done() {
  failures.forEach(function (f) { console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 500) : '')); });
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

const NOW = Date.parse('2026-09-03T22:00:00Z');

/* Words a sports fan cannot be expected to know and which nothing on a public
   surface defines. Wider than EDPRES.JARGON on purpose: the gate guards AI
   copy, this guards EVERY string EdgeDesk itself writes. */
const BANNED = /\b(de-?vig(?:ged|ging)?|devig|vigorish|no-?vig|\bvig\b|clv|closing[- ]line[- ]value|expected value|\bev\b|pinnacle|sharp(?:er)?[- ](?:market|book|books|fair|reference|money|side)|\bsharps?\b|soft(?:er)? books?|fair (?:line|value|price|odds|probability)|max[- ]playable|market residual|consensus dispersion|liquidity|\bshin\b|overround|calibrat(?:ion|ed)|break-?even|implied probability|\bhold\b percentage)\b/i;
/* Bare BET/LEAN/WAIT/PASS are EdgeDesk's own four words, always glossed. */
function jargonIn(text) { const m = String(text == null ? '' : text).match(BANNED); return m ? m[0] : null; }

/* --------------------------------------------------------------- fixtures */
function packet(over) {
  const base = {
    game: { matchup: 'Texas Tech @ Baylor', sport: 'CFB', sport_key: 'americanfootball_ncaaf', commence: '2026-09-05T23:30:00Z', away: 'Texas Tech', home: 'Baylor', event_id: 'ev1' },
    market: 'Spread', market_key: 'spreads', selection: 'Texas Tech -3.5', selection_raw: 'Texas Tech', point: -3.5,
    prices: { detect: -108, current: -110, fair: -121, max_playable: -118, book: 'DraftKings', trusted: true },
    edge: { detect: 0.034, current: 0.031, ev: 0.031, remaining: 0.91, floor: 0.005 },
    confirmation: { has_sharp: true, n_books: 6, corrob: 1, trusted: true },
    timing: { stale_min: 8 },
    price_sensitivity: { breakeven: -121, max_playable: -118, needs_price_for_ev: null },
    deterministic: {
      verdict: 'BET', display_verdict: 'BET', is_wait: false, wait_reason: null, confidence: 'HIGH', score: 82, band: 'Solid',
      why: 'Clears the bar with real liquidity: +3.1% at a US-regulated book, sharp-confirmed.',
      reasons_for: ['+3.1% estimated edge vs Pinnacle de-vig fair', 'Pinnacle (sharp reference) is quoting this side', 'best price is at a US-regulated book', '6 books behind the fair line'],
      reasons_against: ['no sharp (Pinnacle) confirmation on this exact side'],
      falsifiers: ['Price keeps moving against you: 91% of the detection edge is left, and past -118 the EV crosses the 0.5% floor.'],
    },
  };
  const out = JSON.parse(JSON.stringify(base));
  (over || []).forEach(function (o) { const [k, v] = o; const parts = k.split('.'); let t = out; for (let i = 0; i < parts.length - 1; i++) t = t[parts[i]]; t[parts[parts.length - 1]] = v; });
  return out;
}
function simple(over, ctx) { return P.simpleFromPacket(packet(over), Object.assign({ now: NOW, stale_limit_min: 90 }, ctx || {})); }

/* THE FLAGSHIP. The brief that started this: a +1400 underdog, a comparison
   price of about +1237, a price that is 90 minutes old, so WAIT. */
function fresno(over) {
  return P.simpleFromPacket(packet([
    ['game.matchup', 'Fresno State @ USC'], ['game.away', 'Fresno State'], ['game.home', 'USC'], ['game.event_id', 'fres1'],
    ['market', 'Moneyline'], ['market_key', 'h2h'], ['selection', 'Fresno State ML'], ['selection_raw', 'Fresno State'], ['point', null],
    ['prices.detect', 1400], ['prices.current', 1400], ['prices.fair', 1237], ['prices.max_playable', 1237],
    ['price_sensitivity.breakeven', 1237], ['price_sensitivity.max_playable', 1237],
    ['edge.detect', 0.127], ['edge.current', 0.127], ['edge.ev', 0.127], ['edge.remaining', 1],
    ['confirmation.n_books', 21], ['confirmation.corrob', 3],
    ['timing.stale_min', 90],
    ['deterministic.verdict', 'LEAN'], ['deterministic.display_verdict', 'WAIT'], ['deterministic.is_wait', true],
    ['deterministic.wait_reason', 'Qualified on the last number, but it was captured 90m ago. Unconfirmed until a fresh capture verifies the price is still live.'],
    ['deterministic.confidence', 'LOW'], ['deterministic.score', 61],
    ['deterministic.reasons_for', ['+12.7% estimated edge vs Pinnacle de-vig fair', 'Pinnacle (sharp reference) is quoting this side', 'best price is at a US-regulated book', '21 books behind the fair line']],
    ['deterministic.reasons_against', ['edge this large on a game line is often a stale/erroneous price — confirm before trusting', 'stale: last re-priced 90m ago']],
    ['deterministic.falsifiers', ['Price keeps moving against you: 100% of the detection edge is left, and past +1237 the EV crosses the 0.5% floor.']],
  ].concat(over || [])), { now: NOW, stale_limit_min: 90 });
}

/* Every market shape and every verdict, as one table. Each entry is a whole
   public surface: the card, the brief, the CMS paste and the plain text. */
const CASES = [
  { name: 'moneyline favourite', s: simple([['market', 'Moneyline'], ['market_key', 'h2h'], ['selection', 'Baylor ML'], ['selection_raw', 'Baylor'], ['point', null], ['prices.current', -250], ['prices.detect', -250], ['prices.fair', -300], ['prices.max_playable', -290], ['price_sensitivity.max_playable', -290]]) },
  { name: 'small moneyline underdog', s: simple([['market', 'Moneyline'], ['market_key', 'h2h'], ['selection', 'Texas Tech ML'], ['selection_raw', 'Texas Tech'], ['point', null], ['prices.current', 145], ['prices.detect', 145], ['prices.fair', 130], ['prices.max_playable', 132], ['price_sensitivity.max_playable', 132]]) },
  { name: 'extreme moneyline underdog', s: fresno() },
  { name: 'negative spread', s: simple() },
  { name: 'positive spread', s: simple([['selection', 'Baylor +3.5'], ['selection_raw', 'Baylor'], ['point', 3.5]]) },
  { name: 'whole-number spread', s: simple([['selection', 'Baylor +3'], ['selection_raw', 'Baylor'], ['point', 3]]) },
  { name: 'over', s: simple([['market', 'Total'], ['market_key', 'totals'], ['selection', 'Over 47.5'], ['selection_raw', 'Over'], ['point', 47.5]]) },
  { name: 'under', s: simple([['market', 'Total'], ['market_key', 'totals'], ['selection', 'Under 47.5'], ['selection_raw', 'Under'], ['point', 47.5]]) },
  { name: 'LEAN', s: simple([['deterministic.verdict', 'LEAN'], ['deterministic.display_verdict', 'LEAN']]) },
  { name: 'PASS past the limit', s: simple([['deterministic.verdict', 'PASS'], ['deterministic.display_verdict', 'PASS'], ['edge.current', 0.002], ['prices.current', -125], ['price_sensitivity.needs_price_for_ev', -118], ['deterministic.why', 'The edge existed at detection (-108) but the current price has moved to -125, pulling EV below the 0.5% floor.'], ['deterministic.reasons_for', []]]) },
  { name: 'stale price', s: simple([['timing.stale_min', 140]]) },
  { name: 'no fair comparison', s: simple([['prices.fair', null], ['prices.max_playable', null], ['price_sensitivity.max_playable', null], ['price_sensitivity.breakeven', null], ['edge.current', null], ['deterministic.verdict', 'PASS'], ['deterministic.display_verdict', 'WAIT'], ['deterministic.is_wait', true], ['deterministic.wait_reason', 'No fair price is on file yet, so there is nothing to judge this number against.'], ['deterministic.reasons_for', []]]) },
  { name: 'no market confirmation', s: simple([['confirmation.has_sharp', false], ['deterministic.reasons_for', ['+3.1% estimated edge vs Pinnacle de-vig fair', 'best price is at a US-regulated book']], ['deterministic.reasons_against', ['no sharp (Pinnacle) confirmation on this exact side']]]) },
  { name: 'one-book thin market', s: simple([['confirmation.n_books', 1], ['confirmation.has_sharp', false], ['deterministic.reasons_for', []], ['deterministic.reasons_against', ['only 1 book quoting the fair line']]]) },
  { name: 'offshore-only price', s: simple([['prices.book', 'BetOnline'], ['prices.trusted', false], ['confirmation.trusted', false], ['deterministic.reasons_for', ['+3.1% estimated edge vs Pinnacle de-vig fair']], ['deterministic.reasons_against', ['best price is offshore — structurally less trustworthy']]]) },
  { name: 'no price on file', s: simple([['prices.current', null]]) },
  { name: 'missing data gap', s: simple([], { gaps: ['injury_report'] }) },
  { name: 'lineup uncertainty', s: simple([['game.sport_key', 'baseball_mlb'], ['deterministic.reasons_against', ['MLB caveat: lineups are probable, not confirmed; bullpen shows flagged arms only']], ['deterministic.falsifiers', ['A late scratch or lineup change moves the number — lineups here are probable, not confirmed.']]]) },
  { name: 'extreme edge warning', s: simple([['edge.current', 0.19], ['deterministic.reasons_against', ['edge this large on a game line is often a stale/erroneous price — confirm before trusting']]]) },
  { name: 'DATA CHECK FAILED', s: simple([], { integrity: { verdict: 'FAIL', summary: 'FAIL: identity_chain', failed: [{ name: 'identity_chain', status: 'FAIL', detail: 'two starters are attached to a team that is not playing in this game.' }] } }) },
];

/* Every reader-facing string one case produces, on every public surface. */
function publicStrings(s) {
  const out = [];
  const pl = s.plain || {};
  out.push(pl.verdict_subtitle, pl.answer, pl.bet, pl.ticket, pl.push_note, pl.payout, pl.guard,
    pl.why_heading, pl.risk_heading, pl.risk, pl.change_heading, pl.change, pl.kills, pl.market_check, pl.price_age);
  (pl.why || []).forEach(function (w) { out.push(w); });
  if (pl.found) { out.push(pl.found.sentence); (pl.found.rows || []).forEach(function (r) { out.push(r.k, r.v, r.note); }); }
  if (pl.price_limit) out.push(pl.price_limit.label, pl.price_limit.value, pl.price_limit.sentence, pl.price_limit.hint);
  const snap = P.snapshot({ cards: [s], report_type: 'GAME', preset: 'GAME', now: NOW });
  const b = snap.public.cards[0] && snap.public.cards[0].brief;
  if (b) {
    out.push(b.lede, b.biggest_risk, b.change_call, b.market_read);
    (b.why || []).forEach(function (w) { out.push(w); });
    if (b.plain) { out.push(b.plain.status_line, b.plain.answer, b.plain.guard, b.plain.kills); (b.plain.why || []).forEach(function (w) { out.push(w); }); }
  }
  out.push(P.briefText(snap));
  out.push(P.briefCmsHTML(snap).replace(/<[^>]+>/g, ' '));
  out.push(P.cardHTML(s).replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' '));
  ['good_to', 'verdict', 'price', 'comparison', 'benchmark', 'book_count', 'freshness', 'book', 'not_a_prediction'].forEach(function (k) { out.push(P.explain(k, s)); });
  return out.filter(function (x) { return typeof x === 'string' && x; });
}

/* ---- 1 · NO PUBLIC SURFACE CARRIES A WORD THAT IS NEVER DEFINED --------- */
CASES.forEach(function (c) {
  const bad = [];
  publicStrings(c.s).forEach(function (t) { const j = jargonIn(t); if (j) bad.push({ term: j, in: t.slice(0, 160) }); });
  chk('no undefined jargon on any public surface: ' + c.name, bad.length === 0, bad.slice(0, 4));
});

/* ---- 2 · THE SIX QUESTIONS, ANSWERED, ON EVERY CARD -------------------- */
CASES.forEach(function (c) {
  const pl = c.s.plain || {};
  chk('the call is stated in one word: ' + c.name, !!pl.verdict_label && /^(BET|LEAN|WAIT|PASS|DATA CHECK FAILED|NO CALL)$/.test(pl.verdict_label), pl.verdict_label);
  chk('the call is glossed in a sentence: ' + c.name, !!pl.verdict_subtitle && pl.verdict_subtitle.length > 15, pl.verdict_subtitle);
  chk('the reader is told what to do next: ' + c.name, !!pl.answer && pl.answer.length > 12, pl.answer);
  chk('the bet is named in football words: ' + c.name, !!pl.bet && !/\bML$/.test(pl.bet), pl.bet);
  chk('the exact sportsbook ticket is still shown: ' + c.name, !!pl.ticket, pl.ticket);
  chk('the price that matters is named: ' + c.name, !!(pl.price_limit && pl.price_limit.value && pl.price_limit.sentence), pl.price_limit);
  chk('what could break it is stated: ' + c.name, !!pl.risk && pl.risk.length > 12, pl.risk);
  chk('what would change it is stated: ' + c.name, !!pl.change && pl.change.length > 12, pl.change);
});

/* ---- 3 · VALUE IS NEVER A PREDICTION ----------------------------------- */
{
  const f = fresno();
  chk('an extreme underdog card carries the guard', !!f.plain.guard && f.plain.guard_kind === 'HEAVY_UNDERDOG', f.plain.guard_kind);
  chk('the guard says underdog, and says EdgeDesk is not predicting an upset',
    /underdog/i.test(f.plain.guard) && /not predicting an upset/i.test(f.plain.guard) && /PRICE/.test(f.plain.guard), f.plain.guard);
  chk('the guard never claims the underdog is likely to win', !/likely to win|will win|expect(s|ed)? to win|good chance/i.test(f.plain.guard), f.plain.guard);
  chk('nothing anywhere on the card predicts the result',
    !publicStrings(f).some(function (t) { return /(Fresno State (will|should) (win|beat)|likely to (win|beat)|expect(s|ed) an upset)/i.test(t); }));

  const mid = simple([['market', 'Moneyline'], ['market_key', 'h2h'], ['selection_raw', 'Texas Tech'], ['point', null], ['prices.current', 260], ['prices.fair', 240], ['prices.max_playable', 245], ['price_sensitivity.max_playable', 245]]);
  chk('a +260 moneyline still gets the guard', !!mid.plain.guard && mid.plain.guard_kind === 'UNDERDOG', mid.plain.guard_kind);
  const shortDog = simple([['market', 'Moneyline'], ['market_key', 'h2h'], ['selection_raw', 'Texas Tech'], ['point', null], ['prices.current', 145], ['prices.fair', 130], ['prices.max_playable', 132], ['price_sensitivity.max_playable', 132]]);
  chk('a +145 moneyline does not need the guard and does not get one', shortDog.plain.guard === null, shortDog.plain.guard);
  const fav = simple([['market', 'Moneyline'], ['market_key', 'h2h'], ['selection_raw', 'Baylor'], ['point', null], ['prices.current', -250], ['prices.fair', -300], ['prices.max_playable', -290], ['price_sensitivity.max_playable', -290]]);
  chk('a heavy favourite is framed as a cost, not a winner', fav.plain.guard_kind === 'FAVOURITE' && /risk \$250 to win \$100/.test(fav.plain.guard) && /not predicting the winner/i.test(fav.plain.guard), fav.plain.guard);
  const longSpread = simple([['prices.current', 480], ['prices.fair', 430], ['prices.max_playable', 440], ['price_sensitivity.max_playable', 440]]);
  chk('a long price on a spread is framed as a long shot, not an upset call', longSpread.plain.guard_kind === 'LONG_PRICE' && !/underdog/i.test(longSpread.plain.guard), longSpread.plain.guard);
}

/* ---- 4 · THE PRICE COMPARISON IS DIRECTIONALLY CORRECT ON BOTH SIGNS ---- */
{
  const dog = fresno().plain.found;
  chk('plus money that pays more than the comparison reads as paying more', dog.direction === 'better' && /paying more than EdgeDesk expected/.test(dog.sentence), dog.sentence);
  chk('the two prices are shown as two rows, not as a percentage', dog.rows.length === 3 && dog.rows[0].v === '+1400' && dog.rows[1].v === 'about +1237', dog.rows);
  chk('the percentage survives as supporting detail, not as the explanation', dog.detail === 'Measured difference: 12.7%.', dog.detail);

  const fav = simple([['prices.current', -110], ['prices.fair', -121]]).plain.found;
  chk('minus money cheaper than the comparison reads as charging less', fav.direction === 'better' && /charging less than EdgeDesk expected/.test(fav.sentence), fav.sentence);
  const worse = simple([['prices.current', -135], ['prices.fair', -121]]).plain.found;
  chk('minus money dearer than the comparison reads as charging more', worse.direction === 'worse' && /charging more than EdgeDesk expected/.test(worse.sentence), worse.sentence);
  const dogWorse = simple([['market_key', 'h2h'], ['selection_raw', 'Texas Tech'], ['point', null], ['prices.current', 120], ['prices.fair', 140]]).plain.found;
  chk('plus money paying less than the comparison reads as paying less', dogWorse.direction === 'worse' && /paying less than EdgeDesk expected/.test(dogWorse.sentence), dogWorse.sentence);
  const same = simple([['prices.current', -121], ['prices.fair', -121]]).plain.found;
  chk('a matching price says so rather than inventing a difference', same.direction === 'same' && /matches what EdgeDesk expected/.test(same.sentence), same.sentence);
  const none = simple([['prices.fair', null], ['price_sensitivity.breakeven', null]]).plain.found;
  chk('no comparison price is said plainly, never guessed', none.have === false && /no comparison price on file/i.test(none.sentence), none.sentence);
}

/* ---- 5 · SPREADS AND TOTALS ARE EXPLAINED AS FOOTBALL, NOT AS A LINE ---- */
{
  chk('a favourite spread says how much they have to win by', P.betLine({ market_key: 'spreads', selection_raw: 'Pittsburgh', point: -4.5, sport_key: 'americanfootball_nfl' }) === 'Pittsburgh to win by 5 points or more');
  chk('a whole-number favourite spread says "more than"', P.betLine({ market_key: 'spreads', selection_raw: 'Pittsburgh', point: -4, sport_key: 'americanfootball_nfl' }) === 'Pittsburgh to win by more than 4 points');
  chk('a whole-number spread warns that it can land exactly', P.pushNote({ market_key: 'spreads', point: -4, sport_key: 'americanfootball_nfl' }) === 'If the game is decided by exactly 4 points, the bet is refunded.');
  chk('a half-point spread has no push to warn about', P.pushNote({ market_key: 'spreads', point: -4.5, sport_key: 'americanfootball_nfl' }) === null);
  chk('an underdog spread says lose by how much, or win', P.betLine({ market_key: 'spreads', selection_raw: 'Cleveland', point: 4.5, sport_key: 'americanfootball_nfl' }) === 'Cleveland to lose by 4 points or fewer, or win outright');
  chk('a pick-em is a straight win', P.betLine({ market_key: 'spreads', selection_raw: 'Cleveland', point: 0 }) === 'Cleveland to win outright' && /ends level/.test(P.pushNote({ market_key: 'spreads', point: 0 })));
  chk('an Over is combined points, said as points', P.betLine({ market_key: 'totals', selection_raw: 'Over', point: 47.5, sport_key: 'americanfootball_nfl' }) === 'More than 47.5 total points, both teams combined');
  chk('an Under is the other side of the same sentence', P.betLine({ market_key: 'totals', selection_raw: 'Under', point: 47.5, sport_key: 'americanfootball_nfl' }) === 'Fewer than 47.5 total points, both teams combined');
  chk('baseball scores runs, hockey scores goals', P.betLine({ market_key: 'totals', selection_raw: 'Over', point: 8.5, sport_key: 'baseball_mlb' }) === 'More than 8.5 total runs, both teams combined'
    && P.betLine({ market_key: 'totals', selection_raw: 'Under', point: 5.5, sport_key: 'icehockey_nhl' }) === 'Fewer than 5.5 total goals, both teams combined');
  chk('a moneyline names the opponent when the game is known', P.betLine({ market_key: 'h2h', selection_raw: 'Fresno State', home: 'USC', away: 'Fresno State' }) === 'Fresno State to beat USC');
  chk('a moneyline with no opponent on file just says "to win"', P.betLine({ market_key: 'h2h', selection_raw: 'Fresno State' }) === 'Fresno State to win');
  chk('EdgeDesk never proposes a spread or total of its own',
    !CASES.some(function (c) { return publicStrings(c.s).some(function (t) { return /EdgeDesk('s)? (comparison |market )?(line|spread|total) (should|is|would) be/i.test(t); }); }));
}

{
  /* A lede is a sentence, so a description embedded in one is lowercase and a
     team name is not. */
  const over = simple([['market', 'Total'], ['market_key', 'totals'], ['selection', 'Over 47.5'], ['selection_raw', 'Over'], ['point', 47.5]]);
  const pub = P.publisher(over, {});
  chk('a total reads as a sentence in the lede', /favors more than 47\.5 total points, both teams combined at -110/.test(pub.lede), pub.lede);
  chk('a team keeps its capital in the lede', /favors Texas Tech to win by 4 points or more/.test(P.publisher(simple(), {}).lede), P.publisher(simple(), {}).lede);
  chk('the headline of the pick keeps the bet capitalised', over.plain.bet === 'More than 47.5 total points, both teams combined', over.plain.bet);
}

/* ---- 6 · THE PRICE LIMIT READS AS A LIMIT ------------------------------ */
{
  const bet = simple();
  chk('a live call shows the limit as a price, with a direction', bet.plain.price_limit.label === 'Price limit'
    && bet.plain.price_limit.value === '-118 or better' && /cheaper price/.test(bet.plain.price_limit.hint), bet.plain.price_limit);
  chk('the limit sentence says what happens past it', /the value is gone/.test(bet.plain.price_limit.sentence), bet.plain.price_limit.sentence);
  chk('“Good to” never reaches a public surface', !publicStrings(bet).some(function (t) { return /Good to/.test(t); }));
  chk('the engine field is untouched underneath', bet.playable_to.label === 'Good to -118' && bet.playable_to.limit_odds === '-118', bet.playable_to);
  const dogLimit = fresno().plain.price_limit;
  chk('a plus-money limit explains "better" as a bigger payout', /bigger payout/.test(dogLimit.hint) && dogLimit.value === '+1237 or better', dogLimit);
  const passNeeds = simple([['deterministic.verdict', 'PASS'], ['deterministic.display_verdict', 'PASS'], ['edge.current', 0.002], ['prices.current', -125], ['price_sensitivity.needs_price_for_ev', -118], ['deterministic.reasons_for', []]]);
  chk('a PASS names the price it would take', passNeeds.plain.price_limit.label === 'Price needed' && passNeeds.plain.price_limit.value === '-118 or better', passNeeds.plain.price_limit);
  const noLimit = simple([['prices.fair', null], ['prices.max_playable', null], ['price_sensitivity.max_playable', null], ['price_sensitivity.breakeven', null]]);
  chk('no comparison price means no invented limit', noLimit.plain.price_limit.value === 'Not set' && noLimit.plain.price_limit.limit_odds === null, noLimit.plain.price_limit);
}

/* ---- 7 · THE MARKET CHECK SAYS ONLY WHAT THE FIELD MEANS ---------------- */
{
  const both = P.marketCheckPlain({ has_sharp: true, n_books: 21 });
  chk('a benchmark quote is described as a live comparison, not as agreement',
    /posting a price on this exact bet/.test(both.lines[0]) && !/agree/i.test(both.lines[0]), both.lines[0]);
  chk('the book count is described as breadth of comparison, not as endorsement',
    /21 sportsbooks were quoting this game/.test(both.lines[1]) && !/agree|behind/i.test(both.lines[1]), both.lines[1]);
  const nosharp = P.marketCheckPlain({ has_sharp: false, n_books: 3 });
  chk('a missing benchmark quote is stated as a weaker check', /not posting a price on this exact bet/.test(nosharp.lines[0]) && /weaker check/.test(nosharp.lines[0]), nosharp.lines[0]);
  chk('a thin market says thin', /thin market/.test(nosharp.lines[1]), nosharp.lines[1]);
  chk('one book says there is nothing to compare against', /nothing to compare it against/.test(P.marketCheckPlain({ n_books: 1 }).text));
  chk('an offshore best price is explained, not labelled', /harder to reach and less protected/.test(P.marketCheckPlain({ book: 'BetOnline', trusted: false }).text));
  chk('no market data is said, not implied', P.marketCheckPlain({}).text === 'EdgeDesk has no market read on file for this bet.');
}

/* ---- 8 · THE NUMBERS SURVIVE THE TRANSLATION UNCHANGED ------------------ */
CASES.forEach(function (c) {
  const s = c.s, e = s.engine || {};
  const pk = c.name === 'extreme moneyline underdog' ? null : null;
  chk('the engine numbers are carried, never recomputed: ' + c.name, (function () {
    if (e.current_am == null) return s.odds === null;
    if (s.odds !== P.fmtAmerican(e.current_am)) return false;
    if (e.max_playable_am != null && s.playable_to.limit_odds !== P.fmtAmerican(e.max_playable_am) && s.playable_to.kind !== 'NEEDS') return false;
    if (s.plain.found.have && s.plain.found.rows[1].v !== 'about ' + P.fmtAmerican(e.fair_am)) return false;
    return true;
  })(), { odds: s.odds, engine: e, rows: s.plain.found.rows });
});
{
  const f = fresno();
  chk('the flagship keeps every engine number verbatim',
    f.engine.current_am === 1400 && f.engine.fair_am === 1237 && f.engine.max_playable_am === 1237 && f.engine.edge === 0.127, f.engine);
  chk('the flagship verdict is still the engine’s', f.verdict === 'WAIT' && f.engine_verdict === 'LEAN' && f.display_verdict === 'WAIT');
  chk('the flagship is still marked stale', f.freshness.status === 'STALE' && f.flags.some(function (x) { return x.kind === 'STALE_PRICE'; }));
  chk('the flagship says the price is old in the reason, not in a footnote', /90 minutes ago/.test(f.plain.risk), f.plain.risk);
  chk('the flagship says exactly what would make it a bet', /fresh check at the sportsbook showing \+1237 or better/.test(f.plain.change), f.plain.change);
  chk('the flagship says exactly what would kill it', /worse than \+1237/.test(f.plain.kills), f.plain.kills);
  /* One idea, one heading. A BET's change trigger IS its kill condition, so it
     must never be printed twice under two different headings. */
  const betOne = simple();
  chk('a BET has one ending, not two', betOne.plain.kills === null && betOne.plain.change_heading === 'What would end it', { k: betOne.plain.kills, h: betOne.plain.change_heading });
  chk('only WAIT carries both halves', f.plain.change_heading === 'What would turn this into a bet' && !!f.plain.kills);
  chk('a brief never prints the same heading twice', (function () {
    const snap = P.snapshot({ cards: [betOne], report_type: 'GAME', preset: 'GAME', now: NOW });
    const heads = (P.briefHTML(snap).match(/<div class="edb-h[^"]*">([^<]+)<\/div>/g) || []).map(function (h) { return h.replace(/<[^>]+>/g, ''); });
    return heads.length === new Set(heads).size;
  })());
  /* A PASS whose only reason IS the risk must not print the same sentence
     under two headings either. */
  chk('a PASS never says the same sentence twice', (function () {
    const pass = simple([['deterministic.verdict', 'PASS'], ['deterministic.display_verdict', 'PASS'], ['edge.current', 0.002],
      ['prices.current', -125], ['price_sensitivity.needs_price_for_ev', -118], ['deterministic.reasons_for', []],
      ['deterministic.why', 'The edge existed at detection (-108) but the current price has moved to -125, pulling EV below the 0.5% floor.']]);
    const txt = P.briefHTML(P.snapshot({ cards: [pass], report_type: 'GAME', preset: 'GAME', now: NOW })).replace(/<[^>]+>/g, ' ');
    return (txt.match(/there is no longer enough in it/g) || []).length === 1;
  })());
  chk('a PASS subtitle and answer do not collide', (function () {
    const pass = simple([['deterministic.verdict', 'PASS'], ['deterministic.display_verdict', 'PASS'], ['edge.current', 0.002],
      ['prices.current', -125], ['price_sensitivity.needs_price_for_ev', -118], ['deterministic.reasons_for', []]]);
    return pass.plain.verdict_subtitle === 'Not worth it at this price.' && !/Not at this price/.test(pass.plain.answer)
      && /would take -118 or better/.test(pass.plain.answer);
  })());
  chk('no export repeats the lede as the pick line', (function () {
    const snap = P.snapshot({ cards: [f], report_type: 'GAME', preset: 'GAME', now: NOW });
    const txt = P.briefText(snap), cms = P.briefCmsHTML(snap).replace(/<[^>]+>/g, ' ');
    const phrase = 'It needs a fresh check before EdgeDesk trusts it';
    return (txt.split(phrase).length - 1) === 1 && (cms.split(phrase).length - 1) === 1;
  })());
  chk('a slate pick, which has no lede, keeps its own answer line', (function () {
    const sl = P.snapshot({ cards: [f], report_type: 'SLATE', preset: 'CFB', max: 3, now: NOW });
    return /It needs a fresh check before EdgeDesk trusts it/.test(P.briefText(sl));
  })());
  chk('the price comparison is stated once, not once per section', (function () {
    const html = P.briefHTML(P.snapshot({ cards: [f], report_type: 'GAME', preset: 'GAME', now: NOW })).replace(/<[^>]+>/g, ' ');
    return (html.match(/comparison price for the same bet is about/g) || []).length === 1;
  })());
  chk('the flagship leads with the bet in football words', f.plain.bet === 'Fresno State to beat USC' && f.plain.ticket === 'Moneyline · Fresno State');
  chk('the flagship shows the payout in dollars', f.plain.payout === 'A $100 bet returns $1,400 in profit if it wins.', f.plain.payout);
}

/* ---- 9 · A FAILED DATA CHECK EXPLAINS ITSELF --------------------------- */
{
  const failed = simple([], { integrity: { verdict: 'FAIL', summary: 'FAIL: identity_chain', failed: [{ name: 'identity_chain', status: 'FAIL', detail: 'two starters are attached to a team that is not playing in this game.' }] } });
  chk('a failed check reads as EdgeDesk refusing to answer', failed.plain.verdict_label === 'DATA CHECK FAILED'
    && /does not trust its own data/.test(failed.plain.verdict_subtitle), failed.plain.verdict_subtitle);
  chk('a failed check never reads as a bad bet', !/bad bet|avoid|do not bet/i.test(failed.plain.answer) && /until a problem with its own data is fixed/.test(failed.plain.answer), failed.plain.answer);
  chk('a failed check still shows no recommendation', failed.suppressed === true && failed.verdict !== 'BET');
}

/* ---- 10 · A NO-BET SLATE READS AS AN ANSWER ---------------------------- */
{
  const p1 = simple([['game.event_id', 'g1'], ['deterministic.verdict', 'PASS'], ['deterministic.display_verdict', 'PASS'], ['deterministic.score', 30]]);
  const snap = P.snapshot({ cards: [p1], report_type: 'SLATE', preset: 'CFB', max: 3, now: NOW });
  const txt = P.briefText(snap);
  chk('a no-bet slate says it looked and found nothing worth betting', /did not find a price worth betting/.test(txt) && /a real answer, not a gap/.test(txt), txt.slice(0, 400));
  chk('a no-bet slate carries no undefined jargon', jargonIn(txt) === null, jargonIn(txt));
}

/* ---- 11 · THE BRIEF IS ORDERED FOR A READER, NOT FOR AN ANALYST -------- */
{
  const f = fresno();
  const snap = P.snapshot({ cards: [f], report_type: 'GAME', preset: 'GAME', now: NOW });
  const html = P.briefHTML(snap);
  const i = function (t) { return html.indexOf(t); };
  chk('the brief leads with the call, then one plain sentence',
    i('edb-verdict') >= 0 && i('edb-sub') > i('edb-verdict') && i('edb-sub') < i('edb-cmp'), { v: i('edb-verdict'), s: i('edb-sub'), c: i('edb-cmp') });
  chk('the ticket and the price limit sit between the call and the reasons',
    i('edb-ticket') > i('edb-sub') && i('edb-goodto') > i('edb-ticket') && i('edb-goodto') < i('edb-cmp'), { t: i('edb-ticket'), g: i('edb-goodto'), c: i('edb-cmp') });
  chk('the two prices come before any analysis', i('edb-cmp') > 0 && i('edb-cmp') < i(f.plain.risk_heading) && i('edb-cmp') < i('edb-why'), { c: i('edb-cmp'), r: i(f.plain.risk_heading) });
  chk('the underdog guard sits above the reasons', i('Read this first') > 0 && i('Read this first') < i('edb-why'));
  chk('the brief ends with a glossary the reader can open, not a wall of terms',
    /class="edb-howto"/.test(html) && /How to read this brief/.test(html) && i('edb-howto') > i('edb-why'));
  chk('the glossary defines the four words that carry the page',
    /Market benchmark|Benchmark sportsbook/.test(html) && /EdgeDesk comparison/.test(html) && /Price limit/.test(html) && /The call/.test(html));
  chk('the brief says out loud that it is not a prediction', /does not predict who wins/.test(html));
  chk('the brief carries the responsible-gambling line', /1-800-GAMBLER/.test(html));
  chk('the whole brief carries no undefined jargon', jargonIn(html.replace(/<[^>]+>/g, ' ')) === null, jargonIn(html.replace(/<[^>]+>/g, ' ')));
}

/* ---- 12 · A BRIEF PUBLISHED BEFORE THIS LAYER STILL RENDERS ------------ */
{
  const legacy = {
    report_type: 'GAME', preset: 'GAME', title: 'EdgeDesk Game Brief', version_no: 1, generated_at: '2026-08-01T12:00:00Z',
    public: { cards: [{ rank: 1, brief: {
      call: { verdict: 'BET', selection: 'Texas Tech -3.5', odds: '-110', book: 'DraftKings', text: 'BET — Texas Tech -3.5 (-110)' },
      good_to: { label: 'Good to -118', text: 'EdgeDesk still likes this at -118.', limit_odds: '-118' },
      lede: 'EdgeDesk’s current research favors Texas Tech -3.5 at -110.',
      why: ['The price is 3.1% better than the sharper market’s fair line.'],
      biggest_risk: 'The price could move.', change_call: 'A worse price would change the call.', market_read: '',
      availability: null, data_check: { status: 'Current', text: 'Prices are current.' }, powered_by: 'Powered by EdgeDesk Sports'
    } }], watch: [], slate: null, data_status: { status: 'Current', prices: [] } }
  };
  const html = P.briefHTML(legacy);
  chk('an old snapshot with no plain block still renders', /Texas Tech -3\.5/.test(html) && /Good to -118/.test(html) && /BET/.test(html));
  chk('an old snapshot does not crash the plain-text export', /THE EDGEDESK CALL/.test(P.briefText(legacy)));
  chk('an old snapshot does not crash the CMS export', /^<h1>/.test(P.briefCmsHTML(legacy)));
}

/* ---- 13 · THE AI GATE REJECTS JARGON THE SAME WAY IT REJECTS HYPE ------ */
{
  const s = simple();
  chk('the jargon regex covers the terms a fan cannot know',
    ['de-vig', 'de-vigged', 'CLV', 'closing line value', 'expected value', 'Pinnacle', 'sharper market', 'sharp book', 'fair line', 'max playable', 'liquidity']
      .every(function (w) { return P.JARGON.test('a ' + w + ' b'); }));
  chk('a jargon headline is rejected and the plain one stands',
    (function () { const r = P.applyAiCopy(s, { headline: 'BET: Texas Tech -3.5 at -110. Beats the sharper market.' }); return !/sharper market/.test(r.simple.headline) && r.rejected.some(function (x) { return /jargon/.test(x); }); })());
  chk('a jargon why-bullet is rejected and backfilled deterministically',
    (function () { const r = P.applyAiCopy(s, { why: [{ text: 'The de-vigged fair line is -121 here.' }] }); return r.simple.why.every(function (w) { return w.source === 'deterministic'; }); })());
  chk('plain AI copy is still accepted',
    (function () { const r = P.applyAiCopy(s, { watch: 'A late quarterback change would weaken the case.' }); return r.accepted && r.simple.watch.source === 'ai'; })());
  chk('accepted AI copy reaches the plain block too',
    (function () { const r = P.applyAiCopy(s, { change_trigger: 'A move past -118 ends it.' }); return r.simple.plain.change === 'A move past -118 ends it.'; })());
  chk('AI can never move a number: the comparison rows stay the engine’s',
    (function () { const r = P.applyAiCopy(s, { why: [{ text: 'The price is 40% better than expected.' }] }); return r.simple.plain.found.rows[1].v === 'about -121'; })());
}

/* ---- 14 · READABILITY: SHORT SENTENCES, NO WALL OF CAPS ---------------- */
CASES.forEach(function (c) {
  const pl = c.s.plain || {};
  const first = [pl.verdict_subtitle, pl.answer].filter(Boolean);
  chk('the first two lines are short enough to read at a glance: ' + c.name,
    first.every(function (t) { return t.length <= 110; }), first);
  /* Measured on the authored sentences, not on stripped markup: joining two
     headings with a space is not a run-on sentence. */
  const authored = [pl.answer, pl.verdict_subtitle, pl.risk, pl.change, pl.kills, pl.guard, pl.market_check, pl.payout, pl.push_note]
    .concat(pl.why || []).concat(pl.found ? [pl.found.sentence, pl.found.detail] : []).concat(pl.price_limit ? [pl.price_limit.sentence, pl.price_limit.hint] : [])
    .filter(Boolean).join(' ').split(/(?<=[.!?])\s+/);
  const long = authored.filter(function (t) { return t.split(/\s+/).length > 42; });
  chk('no sentence runs past 42 words: ' + c.name, long.length === 0, long.slice(0, 2));
  chk('nothing the reader must read is set in ALL CAPS: ' + c.name,
    ![pl.answer, pl.verdict_subtitle, pl.risk, pl.change, pl.guard].filter(Boolean).some(function (t) {
      return (t.match(/\b[A-Z]{4,}\b/g) || []).filter(function (w) { return w !== 'PRICE' && w !== 'EdgeDesk'; }).length > 0;
    }), [pl.answer, pl.guard]);
});

{
  /* Four links all reading "What does this mean?" tell the reader nothing about
     which word they answer. */
  const html = P.cardHTML(fresno());
  const summaries = (html.match(/<summary>([^<]+)<\/summary>/g) || []).map(function (x) { return x.replace(/<[^>]+>/g, ''); });
  chk('every explainer names the word it explains', summaries.length >= 3 && summaries.every(function (t) { return t !== 'What does this mean?'; }), summaries);
  chk('the explainers are all distinct', summaries.length === new Set(summaries).size, summaries);
  chk('an underdog card offers the "is this a prediction?" explainer', summaries.indexOf('Is this a prediction?') >= 0, summaries);
  chk('a card with no long price does not offer it', (P.cardHTML(simple()).match(/Is this a prediction\?/g) || []).length === 0);
  chk('every explainer answer is itself jargon-free', Object.keys(P.WHAT_LABEL).every(function (k) {
    const t = P.explain(k, fresno()); return !t || jargonIn(t) === null;
  }), Object.keys(P.WHAT_LABEL).filter(function (k) { const t = P.explain(k, fresno()); return t && jargonIn(t); }));
}

/* ---- 15 · CONCEPTS ARE DEFINED ONCE, AND EVERY ONE HAS A GUARD --------- */
{
  const keys = Object.keys(P.CONCEPTS);
  chk('the concept registry covers the load-bearing ideas',
    ['edgedesk_comparison', 'benchmark_book', 'price_limit', 'book_count', 'beat_the_close', 'verdict', 'data_check', 'price_age'].every(function (k) { return keys.indexOf(k) >= 0; }), keys);
  chk('every concept has an internal name, a short label and a simple sentence',
    keys.every(function (k) { const c = P.CONCEPTS[k]; return c.internal_name && c.short && c.simple && c.simple.length > 30; }));
  chk('every concept carries a misconception guard',
    keys.every(function (k) { return !!P.CONCEPTS[k].guard; }), keys.filter(function (k) { return !P.CONCEPTS[k].guard; }));
  chk('no concept explanation is itself jargon',
    keys.every(function (k) { const c = P.CONCEPTS[k]; return !jargonIn([c.short, c.simple, c.detail, c.guard, c.example].filter(Boolean).join(' ')); }),
    keys.filter(function (k) { const c = P.CONCEPTS[k]; return jargonIn([c.short, c.simple, c.detail, c.guard, c.example].filter(Boolean).join(' ')); }));
}

/* ---- 16 · FULL RESEARCH IS UNTOUCHED ----------------------------------- */
{
  const s = simple();
  chk('the engine block still carries the precise fields', s.engine && s.engine.reasons_for.length === 4
    && /Pinnacle/.test(s.engine.reasons_for.join(' ')) && s.engine.floor === 0.005 && s.engine.ev === 0.031, s.engine.reasons_for);
  chk('the precise engine verdict, score and band still travel', s.engine.confidence === 'HIGH' && s.engine.score === 82 && s.engine.band === 'Solid');
  chk('the deterministic why-string is preserved verbatim for Full Research', /sharp-confirmed/.test(s.engine.why), s.engine.why);
  chk('the old term dictionary is still available to Full Research surfaces', P.translate('sharp reference') === 'sharper market');
  chk('translateText still works for advanced copy', /sharper market/.test(P.translateText('Pinnacle is quoting this side')));
}

/* ---- 17 · AN ENGINE REASON NOBODY MAPPED STILL LANDS IN PLAIN ENGLISH -- */
{
  /* The engine will grow new reason strings. When one arrives with no semantic
     builder behind it, the fallback must still be readable — otherwise the
     five-second view silently regresses the day the engine ships a feature. */
  const unmapped = [
    'a brand new signal: sharp fair beats the consensus fair by a wide margin',
    'max playable breached and CLV already negative',
    'Pinnacle de-vig fair moved against the position',
    'evidence integrity warning on the liquidity check',
  ];
  unmapped.forEach(function (r, i) {
    const out = P.plainReason(r);
    chk('an unmapped engine reason falls back to plain English [' + i + ']', !!out && jargonIn(out) === null, { in: r, out: out });
  });
  chk('a mapped engine reason still beats the fallback',
    /uses as its benchmark is posting a price on this exact bet/.test(P.publicReason('Pinnacle (sharp reference) is quoting this side', {})));
  chk('an unrecognised reason still reaches the card rather than vanishing',
    (function () { const s = simple([['deterministic.reasons_for', ['a brand new reason about the sharp fair']]]); return s.why.length === 1 && jargonIn(s.why[0].text) === null; })());
  chk('the bettor-level dictionary is still there underneath for Full Research',
    P.translate('sharp reference') === 'sharper market' && /sharper market/.test(P.translateText('Pinnacle is quoting this side')));
  chk('the public dictionary takes it one step further',
    /benchmark sportsbook/.test(P.publicText('Pinnacle is quoting this side')));
}

{
  /* The compact strip is four lines of screen. It cannot afford to say the
     same sentence twice. */
  const strip = P.cardHTML(fresno(), { compact: true });
  const answer = fresno().plain.answer;
  chk('the compact strip says the answer once', (strip.split(P.esc(answer)).length - 1) === 1, strip.slice(0, 400));
  chk('the full card still carries the gloss and the answer together', (function () {
    const full = P.cardHTML(fresno());
    return full.indexOf(P.esc(fresno().plain.verdict_subtitle) + ' ' + P.esc(answer)) > 0;
  })());
  chk('the compact strip still carries the underdog guard, shortened', /dcard-guardchip/.test(strip) && /heavy underdog/.test(strip));
}

/* ---- 18 · THE COPY QA CHECKLIST, AS CODE ------------------------------- */
{
  /* The same checklist a human would run, so a regression is visible rather
     than silent. It must pass on every shape — and it must actually fail when
     the copy is bad, or it is worth nothing. */
  CASES.forEach(function (c) {
    const r = P.copyQA(c.s);
    chk('copy QA passes: ' + c.name, r.pass, r.failures && r.failures.map(function (f) { return { id: f.id, detail: f.detail }; }));
  });
  const batch = P.copyQABatch(CASES.map(function (c) { return c.s; }));
  chk('the batch report counts every card', batch.n === CASES.length && batch.passing === CASES.length, batch.rows.filter(function (r) { return !r.pass; }));

  /* Negative controls: each check has to be able to fire. */
  function broken(mut) { const s = JSON.parse(JSON.stringify(simple())); mut(s.plain); return P.copyQA(s); }
  chk('QA catches jargon that slipped through', broken(function (p) { p.risk = 'The de-vigged fair line moved against it.'; }).failed.indexOf('no_undefined_jargon') >= 0);
  chk('QA catches a call with no gloss', broken(function (p) { p.verdict_subtitle = null; }).failed.indexOf('call_is_glossed') >= 0);
  chk('QA catches a missing next action', broken(function (p) { p.answer = null; }).failed.indexOf('next_action_is_clear') >= 0);
  chk('QA catches a bet left as shorthand', broken(function (p) { p.bet = 'Chiefs ML'; }).failed.indexOf('bet_in_plain_words') >= 0);
  chk('QA catches a missing price limit', broken(function (p) { p.price_limit = null; }).failed.indexOf('price_that_matters_named') >= 0);
  chk('QA catches a missing "what would change it"', broken(function (p) { p.change = null; }).failed.indexOf('what_would_change_it') >= 0);
  chk('QA catches copy that predicts a result', broken(function (p) { p.why = ['Texas Tech will win this comfortably.']; }).failed.indexOf('value_is_not_a_prediction') >= 0);
  chk('QA catches a long price with the guard stripped off', (function () {
    const f = JSON.parse(JSON.stringify(fresno()));
    f.plain.guard = null;
    return P.copyQA(f).failed.indexOf('long_price_carries_the_guard') >= 0;
  })());
  chk('QA does not demand a guard where none is warranted', P.copyQA(simple()).checks.filter(function (c) { return c.id === 'long_price_carries_the_guard'; })[0].ok);
  chk('every check explains itself, so a failure is actionable',
    P.copyQA(simple()).checks.every(function (c) { return c.id && c.why && c.why.length > 20; }));
}

done();
