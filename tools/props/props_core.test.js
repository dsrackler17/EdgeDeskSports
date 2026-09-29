#!/usr/bin/env node
/* ===========================================================================
   PLAYER PROPS CORE (lib/edgedesk_props.js) — the rules every surface prices by.

     identity      durable ids minted once from the anchor provider id; book
                   names resolve through suffixes, initials, nicknames and
                   joined surnames; two players who could both be the name are
                   REFUSED, never guessed; an override wins
     odds          provider outcomes pair into two-sided quotes; American ↔
                   decimal ↔ probability through research_core (the one EV
                   engine); hold and no-vig per quote; the consensus is a line
                   books actually deal
     distribution  integer pmfs keep their mass exactly; the fair line is the
                   median, not the mean; pushes exist only on whole lines
     pricing       fair odds, break-even, edge and EV at an exact quote; the
                   zero-EV line; the haircut toward the no-vig market
     decisions     stale quotes never decide; an EXPERIMENTAL market never
                   stakes; availability / QB / anomaly → WATCH; one book →
                   LEAN; missing data has its own named state
     ladder        BEST PRICE / BEST EV / SAFER LINE / HIGHER UPSIDE, and the
                   highest probability is not automatically the highest EV
     sizing        quarter-Kelly through the caps, and the card's exposure caps
     correlation   a same-game pair is not the product of its marginals
     record        WIN / LOSS / PUSH / VOID, units, CLV, a frozen prediction's
                   id is a hash of its content and it refuses after kickoff
     stages        derived from gates, never assigned

   Run: node tools/props/props_core.test.js
   =========================================================================== */
'use strict';
const P = require('../../lib/edgedesk_props.js');
const RC = require('../../lib/research_core.js');

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; return; }
  fail++; console.log('FAIL | ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : ''));
}
const near = (a, b, e) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= (e == null ? 1e-9 : e);
function throws(f) { try { f(); return false; } catch (_) { return true; } }

/* a distribution from explicit outcome counts */
function distOf(counts) { const vals = []; Object.keys(counts).forEach((k) => { for (let i = 0; i < counts[k]; i++) vals.push(+k); }); return P.encodeDist(vals, { scale: 0, trim: 0 }); }
/* a right-skewed yardage-like distribution, deterministic */
function skewed(n, seed) {
  const rnd = P.rng(seed || 7), out = [];
  for (let i = 0; i < n; i++) { const u = Math.max(1e-9, rnd()); out.push(Math.round(-Math.log(u) * 38 + (rnd() < 0.08 ? 0 : 12))); }
  return out;
}

/* =========================================================== 1. IDENTITY */
{
  const a = P.mintPlayerId('NFL', 'gsis', '00-0039075');
  chk('a player id is edp_ + 12 hex', /^edp_[0-9a-f]{12}$/.test(a), a);
  chk('minted from the anchor id, so it is stable', a === P.mintPlayerId('nfl', 'GSIS', '00-0039075'));
  chk('a different anchor id is a different player', a !== P.mintPlayerId('NFL', 'gsis', '00-0039076'));
  chk('no anchor, no id (never minted from a name)', P.mintPlayerId('NFL', 'gsis', '') === null && P.mintPlayerId('NFL', null, 'x') === null);

  chk('normName strips suffixes and punctuation', P.normName('Odell Beckham Jr.') === P.normName('odell beckham') && P.normName('Marvin Harrison Jr') === P.normName('Marvin Harrison'), [P.normName('Odell Beckham Jr.')]);
  chk('normName folds accents and apostrophes', P.normName('Ja\'Marr Chase') === P.normName('JaMarr Chase'), P.normName('Ja\'Marr Chase'));

  const team = [
    { player_id: 'edp_000000000001', name: 'A.J. Brown', position: 'WR', team: 'PHI' },
    { player_id: 'edp_000000000002', name: 'DeVonta Smith', position: 'WR', team: 'PHI' },
    { player_id: 'edp_000000000003', name: 'Amon-Ra St. Brown', position: 'WR', team: 'DET' },
    { player_id: 'edp_000000000004', name: 'Kenneth Walker III', position: 'RB', team: 'SEA' },
    { player_id: 'edp_000000000005', name: 'Mike Williams', position: 'WR', team: 'X' },
    { player_id: 'edp_000000000006', name: 'Michael Williams', position: 'TE', team: 'X' },
    { player_id: 'edp_000000000007', name: 'Christopher Olave', aliases: ['Chris Olave'], position: 'WR', team: 'NO' },
    { player_id: 'edp_000000000008', name: 'Josh Allen', position: 'QB', team: 'BUF' },
    { player_id: 'edp_000000000009', name: 'Josh Allen', position: 'LB', team: 'JAX' }
  ];
  const res = (n, o) => P.resolvePlayer(n, team, o);
  chk('exact name (suffix-free)', res('Kenneth Walker').player_id === 'edp_000000000004' && res('Kenneth Walker').method === 'EXACT', res('Kenneth Walker'));
  chk('initials: "AJ Brown" is A.J. Brown', res('AJ Brown').player_id === 'edp_000000000001', res('AJ Brown'));
  chk('joined hyphenated surname: "Amon-Ra St Brown"', res('Amon-Ra St Brown').player_id === 'edp_000000000003' && res('Amonra St. Brown').player_id === 'edp_000000000003', res('Amonra St. Brown'));
  chk('a registered alias resolves', res('Chris Olave').player_id === 'edp_000000000007', res('Chris Olave'));
  const amb = res('Josh Allen');
  chk('two players who both fit the name are REFUSED, never guessed', amb.player_id === null && amb.ambiguous === true && /AMBIGUOUS/.test(amb.reason), amb);
  chk('the position disambiguates a duplicate name', res('Josh Allen', { position: 'QB' }).player_id === 'edp_000000000008');
  chk('a nickname variant that fits two players is refused', res('Mike Williams').player_id === 'edp_000000000005' || res('Mike Williams').ambiguous, res('Mike Williams'));
  chk('an unknown name is NO_MATCH, not a best guess', res('Nobody Here').player_id === null && res('Nobody Here').reason === 'NO_MATCH');
  chk('an empty name is refused', res('').reason === 'EMPTY_NAME');
  const ov = P.resolvePlayer('Josh Allen', team, { overrides: { 'NFL|buf|joshallen': 'edp_000000000008' }, league: 'NFL', team: 'BUF' });
  chk('an identity override wins over the name rules', ov.player_id === 'edp_000000000008' && ov.method === 'OVERRIDE', ov);
  chk('slugs are url-safe', P.slugify('Amon-Ra St. Brown') === 'amonra-st-brown' || /^[a-z0-9-]+$/.test(P.slugify('Amon-Ra St. Brown')), P.slugify('Amon-Ra St. Brown'));
}

/* ======================================================= 2. ODDS + PAIRING */
{
  chk('American → decimal (research_core)', near(RC.americanToDecimal(-110), 1 + 100 / 110) && near(RC.americanToDecimal(150), 2.5));
  chk('American → implied probability', near(RC.impliedProb(-110), 110 / 210) && near(RC.impliedProb(150), 0.4));
  chk('an invalid American price is refused, not coerced', RC.americanToDecimal(50) === null && RC.americanToDecimal('abc') === null);
  const q = P.quoteMath({ over: -110, under: -110 });
  chk('-110/-110 holds 4.76% and de-vigs to 50/50', near(q.hold, 2 * 110 / 210 - 1, 1e-9) && near(q.novig_over, 0.5) && near(q.novig_under, 0.5), q);
  const q2 = P.quoteMath({ over: -125, under: 105 });
  chk('no-vig probabilities sum to one', near(q2.novig_over + q2.novig_under, 1), q2);
  chk('a one-sided quote has no no-vig', P.quoteMath({ over: -120, under: null }).novig_over === null);

  const pairs = P.pairOutcomes([
    { name: 'Over', description: 'Puka Nacua', price: -110, point: 78.5 }, { name: 'Under', description: 'Puka Nacua', price: -110, point: 78.5 },
    { name: 'Over', description: 'Puka Nacua', price: 180, point: 99.5 },
    { name: 'Yes', description: 'Saquon Barkley', price: -150 }, { name: 'No', description: 'Saquon Barkley', price: 120 },
    { name: 'Over', description: '', price: -110, point: 10 }, { name: 'Draw', description: 'X', price: 100, point: 1 }
  ]);
  chk('Over/Under at one line pair into one two-sided quote', pairs[0].line === 78.5 && pairs[0].over === -110 && pairs[0].under === -110 && pairs[0].two_sided, pairs[0]);
  chk('an alternate with one side stays one-sided', pairs[1].line === 99.5 && pairs[1].over === 180 && pairs[1].under === null && !pairs[1].two_sided, pairs[1]);
  chk('Yes/No pairs as a binary quote at 0.5', pairs[2].binary && pairs[2].line === 0.5 && pairs[2].over === -150 && pairs[2].under === 120, pairs[2]);
  chk('outcomes with no player or an unknown side are dropped', pairs.length === 3, pairs.length);
  chk('provider market keys map to prop types (main and alternate)', P.propTypeOfMarketKey('player_reception_yds').prop_type === 'rec_yds' && P.propTypeOfMarketKey('player_reception_yds_alternate').alternate === true && P.propTypeOfMarketKey('nope') === null);
}

/* ================================================= 3. DISTRIBUTION MATH */
{
  const d = distOf({ 0: 10, 1: 30, 2: 30, 3: 20, 4: 10 });
  chk('the pmf keeps its mass exactly', P.validDist(d) && d.n === 100, d);
  const pa = P.probAt(d, 2);
  chk('a whole-number line has a push', near(pa.over, 0.30) && near(pa.under, 0.40) && near(pa.push, 0.30), pa);
  const ph = P.probAt(d, 1.5);
  chk('a half-point line has none', near(ph.over, 0.60) && near(ph.under, 0.40) && ph.push === 0, ph);
  const big = P.encodeDist(skewed(20000, 3));
  chk('encoded at scale 2000, mass exact', P.validDist(big) && big.n === 2000 && big.sims === 20000, { n: big.n, sims: big.sims });
  const sm = P.summarize(big);
  chk('a right-skewed yardage distribution: median (fair line) below the mean', sm.median < sm.mean, sm);
  chk('fair line = the median, where P(over) = P(under)', near(P.cdfContinuous(big, sm.fair_line), 0.5, 1e-3), P.cdfContinuous(big, sm.fair_line));
  chk('discrete percentiles are whole outcomes and ordered', [sm.p10, sm.p25, sm.p50, sm.p75, sm.p90].every(Number.isInteger) && sm.p10 <= sm.p25 && sm.p25 <= sm.p50 && sm.p50 <= sm.p75 && sm.p75 <= sm.p90, sm);
  chk('counts never report a negative percentile', P.summarize(distOf({ 0: 60, 1: 30, 2: 10 })).p10 === 0);
  chk('an invalid pmf is refused', !P.validDist({ lo: 0, n: 10, pmf: [5, 4] }) && P.probAt({ lo: 0, n: 10, pmf: [5, 4] }, 1) === null);
}

/* ============================================================ 4. PRICING */
{
  const d = distOf({ 60: 20, 70: 20, 80: 20, 90: 20, 100: 20 });
  const ps = P.priceSide(d, 'over', 75.5, -110);
  chk('P(win) straight from the distribution', near(ps.model_win, 0.6) && ps.model_push === 0, ps);
  chk('break-even of -110', near(ps.break_even, 110 / 210), ps.break_even);
  chk('EV at the exact price = p × (dec − 1) − (1 − p)', near(ps.ev, 0.6 * (100 / 110) - 0.4, 1e-9), ps.ev);
  chk('edge = P(win) − break-even, in points', near(ps.edge_pp, 100 * (0.6 - 110 / 210), 1e-9), ps.edge_pp);
  chk('fair odds of 60% are -150', ps.fair_american === -150, ps.fair_american);
  chk('fair odds of 40% are +150', P.fairAmerican(0.4, 0) === 150);
  const pp = P.priceSide(d, 'over', 80, -110);
  chk('a whole line returns the push stake: cover = win / (win + loss)', near(pp.model_push, 0.2) && near(pp.model_cover, 0.4 / 0.8), pp);
  chk('an invalid price is refused, never priced', P.priceSide(d, 'over', 75.5, 20).reason === 'INVALID_PRICE');
  const be = P.breakEvenLine(P.encodeDist(skewed(20000, 5)), 'over', -110);
  const beP = P.priceSide(P.encodeDist(skewed(20000, 5)), 'over', Math.floor(be) + 0.5, -110);
  const beM = P.priceSide(P.encodeDist(skewed(20000, 5)), 'over', Math.floor(be) - 0.5, -110);
  chk('the zero-EV line: past it the Over loses money, before it the Over makes money', beP.ev <= 1e-9 && beM.ev > -0.02, { be, above: beP.ev, below: beM.ev });
  const hc = P.haircut(0.62, 0.50, 'EXPERIMENTAL', 60, null, 'NFL');
  chk('the haircut sits between the market and the model', hc.p > 0.5 && hc.p < 0.62 && hc.k > 0 && hc.k < 1, hc);
  const hcT = P.haircut(0.62, 0.50, 'PRODUCTION', 90, null, 'NFL');
  chk('a proven stage and higher reliability trust the model more', hcT.k > hc.k, [hc.k, hcT.k]);
  chk('CFB is haircut harder than the NFL at the same inputs', P.haircut(0.62, 0.5, 'TRACKING', 80, null, 'CFB').p <= P.haircut(0.62, 0.5, 'TRACKING', 80, null, 'NFL').p + 1e-12);
}

/* ============================================= 5. MARKET: CONSENSUS, MOVE */
const NOW = Date.parse('2026-10-04T12:00:00Z');
const at = (min) => new Date(NOW - min * 60000).toISOString();
function quote(book, line, over, under, min, extra) { return Object.assign({ game_id: 'G', player_id: 'edp_000000000001', player_name: 'A.J. Brown', prop_type: 'rec_yds', book, line, over, under, captured_at: at(min), is_alternate: false }, extra || {}); }
{
  const qs = [quote('draftkings', 70.5, -110, -110, 5), quote('fanduel', 71.5, -115, -105, 6), quote('betmgm', 72.5, -110, -110, 7)];
  const c = P.consensus(qs, NOW);
  chk('three books, three lines: the consensus is a line a book deals (the middle)', c.consensus_line === 71.5 && c.books === 3, c);
  chk('the median line is reported beside it', c.median_line === 71.5);
  chk('best Over is the best price at the consensus line', c.best_over && c.best_over.book === 'fanduel', c.best_over);
  chk('best line for the Over is the lowest line at any price', c.best_line_over.line === 70.5 && c.best_line_under.line === 72.5, [c.best_line_over, c.best_line_under]);
  chk('the book list is carried for the board filter', JSON.stringify(c.book_list) === JSON.stringify(['betmgm', 'draftkings', 'fanduel']));
  const qsU = [quote('draftkings', 70.5, -110, -110, 5), quote('fanduel', 71.5, -110, -110, 5), quote('betmgm', 71.5, -110, -110, 5), quote('caesars', 72.5, -110, -110, 5)];
  chk('the majority line wins when there is one', P.consensus(qsU, NOW).consensus_line === 71.5);
  const even = [quote('draftkings', 70.5, -110, -110, 5), quote('fanduel', 71.5, -110, -110, 5)];
  chk('two books on two lines: the consensus is still a dealt line (never 71.0)', [70.5, 71.5].indexOf(P.consensus(even, NOW).consensus_line) >= 0, P.consensus(even, NOW).consensus_line);
  const alt = qs.concat([quote('draftkings', 90.5, 250, null, 5, { is_alternate: true })]);
  chk('alternates never move the consensus', P.consensus(alt, NOW).consensus_line === 71.5 && P.consensus(alt, NOW).books === 3);
  chk('a suspended quote is off the board', P.consensus([quote('draftkings', 70.5, -110, -110, 5, { status: 'suspended' })], NOW).books === 0);
  const mv = P.movement([{ at: at(300), line: 68.5, novig_over: 0.5 }, { at: at(120), line: 70.5, novig_over: 0.52 }, { at: at(10), line: 71.5, novig_over: 0.51 }], null, null);
  chk('movement: opening → current, in line points', mv.opening.line === 68.5 && mv.current.line === 71.5 && mv.line_move === 3 && mv.high === 71.5 && mv.low === 68.5, mv);
  chk('movement: the no-vig move in points', near(mv.novig_move_pp, 1, 1e-9), mv.novig_move_pp);
  chk('movement text says where the line went', /Moved up 3/.test(mv.text), mv.text);
  chk('freshness: 5 min FRESH, 60 AGING, 120 STALE', P.freshness(at(5), NOW).state === 'FRESH' && P.freshness(at(60), NOW).state === 'AGING' && P.freshness(at(120), NOW).state === 'STALE');
}

/* ========================================================= 6. DECISIONS */
const DIST = P.encodeDist(skewed(20000, 11));
const SUMM = P.summarize(DIST);
function proj(extra) {
  return Object.assign({ schema: 'edgedesk_prop_projection_v1', league: 'NFL', season: 2026, week: 5, game_id: 'G', kickoff: '2026-10-04T17:00:00Z', player_id: 'edp_000000000001', player_name: 'A.J. Brown', team: 'PHI', opponent: 'LA', position: 'WR',
    prop_type: 'rec_yds', status: 'PROJECTED', dist: DIST, summary: SUMM, model_version: 'NFL_PLAYER_PROPS_V1.0', projection_id: 'ppj_test', stage: 'TRACKING',
    reliability: { score: 82 }, availability: { status: 'ACTIVE', p_active: 1 } }, extra || {});
}
/* a line well below the fair line, so the Over carries a real edge */
const LOW = Math.floor(SUMM.median) - 12 + 0.5;
{
  const e0 = P.evaluate(proj(), [], { now: NOW });
  chk('no quote: NO DECISION · PROJECTION ONLY, never an invented price', e0.decision === 'NO_DECISION' && e0.reason_code === 'NO_MARKET' && e0.data_state === 'PROJECTION_ONLY', e0.reason_code);
  chk('and the model’s own fair line still stands', e0.fair && near(e0.fair.line, SUMM.fair_line, 0.01), e0.fair);

  const two = [quote('draftkings', LOW, -110, -110, 5), quote('fanduel', LOW, -112, -108, 6)];
  const e1 = P.evaluate(proj(), two, { now: NOW });
  chk('a real edge on a TRACKING market at two fresh books can be a BET', e1.decision === 'BET' && e1.side === 'over' && e1.units > 0, { d: e1.decision, code: e1.reason_code, caps: e1.caps, rec: e1.recommended });
  chk('a BET on a TRACKING market is capped at 0.25U (model-estimated source)', e1.units <= 0.25, e1.units);
  chk('decisions are made on the risk-adjusted probability, below the raw model', e1.recommended.decision_prob < e1.recommended.model_cover && e1.recommended.decision_ev < e1.recommended.ev, e1.recommended);

  const eStale = P.evaluate(proj(), [quote('draftkings', LOW, -110, -110, 200), quote('fanduel', LOW, -112, -108, 200)], { now: NOW });
  chk('stale quotes: NO DECISION, with the warning, and the EV still shown', eStale.decision === 'NO_DECISION' && eStale.reason_code === 'STALE_QUOTE' && eStale.flags.some((f) => f.code === 'STALE') && eStale.priced.some((x) => x.ev > 0), eStale.reason_code);
  const eUnk = P.evaluate(proj(), [Object.assign(quote('draftkings', LOW, -110, -110, 5), { captured_at: null })], { now: NOW });
  chk('a quote with no capture time: FRESHNESS UNKNOWN, never assumed fresh', eUnk.reason_code === 'FRESHNESS_UNKNOWN', eUnk.reason_code);

  const eExp = P.evaluate(proj({ stage: 'EXPERIMENTAL' }), two, { now: NOW });
  chk('an EXPERIMENTAL market informs but never stakes (LEAN at most)', eExp.decision === 'LEAN' && eExp.caps.indexOf('STAGE_EXPERIMENTAL') >= 0 && eExp.units === 0, { d: eExp.decision, caps: eExp.caps });
  const eQ = P.evaluate(proj({ availability: { status: 'QUESTIONABLE', p_active: 0.8 } }), two, { now: NOW });
  chk('a questionable player: WATCH · AVAILABILITY PENDING', eQ.decision === 'WATCH' && eQ.reason_code === 'AVAILABILITY_PENDING', eQ.reason_code);
  const eQB = P.evaluate(proj({ qb_unconfirmed: true }), two, { now: NOW });
  chk('an unconfirmed quarterback: WATCH · QB UNRESOLVED', eQB.decision === 'WATCH' && eQB.caps.indexOf('QB_UNRESOLVED') >= 0, eQB.caps);
  const eOne = P.evaluate(proj(), [quote('draftkings', LOW, -110, -110, 5)], { now: NOW });
  chk('one sportsbook: LEAN · THIN MARKET, never a BET', eOne.decision !== 'BET' && eOne.caps.indexOf('THIN_MARKET') >= 0, eOne.caps);
  const eLow = P.evaluate(proj({ reliability: { score: 45 } }), two, { now: NOW });
  chk('reliability below the floor caps at LEAN', eLow.decision !== 'BET' && eLow.caps.indexOf('LOW_RELIABILITY') >= 0, eLow.caps);
  const eOut = P.evaluate(proj({ availability: { status: 'OUT' } }), two, { now: NOW });
  chk('an OUT player: NO DECISION (the prop should void)', eOut.decision === 'NO_DECISION' && eOut.reason_code === 'PLAYER_OUT');
  const eGS = P.evaluate(proj(), two, { now: NOW, game_started: true });
  chk('after kickoff: NO DECISION · GAME STARTED', eGS.decision === 'NO_DECISION' && eGS.reason_code === 'GAME_STARTED');
  const eIns = P.evaluate(proj({ status: 'INSUFFICIENT_DATA', dist: null, summary: null, missing: ['NO_USAGE_HISTORY'] }), two, { now: NOW });
  chk('INSUFFICIENT DATA is its own state and names what is missing', eIns.decision === 'NO_DECISION' && eIns.data_state === 'INSUFFICIENT_DATA' && eIns.missing[0] === 'NO_USAGE_HISTORY', eIns.data_state);
  const eUnm = P.evaluate(proj({ status: 'UNMAPPED', dist: null }), two, { now: NOW });
  chk('an unmapped book name: NO DECISION · BAD MAPPING', eUnm.data_state === 'BAD_MAPPING' && eUnm.reason_code === 'PLAYER_UNMAPPED');
  const eMk = P.evaluate(proj({ prop_type: 'tackles_ast', status: 'UNMODELED', dist: null }), two, { now: NOW });
  chk('an unmodeled prop type: MARKET ONLY', eMk.data_state === 'MARKET_ONLY' && eMk.reason_code === 'NO_PROJECTION', eMk.reason_code);
  const wild = [quote('draftkings', LOW - 20, 150, -190, 5), quote('fanduel', LOW, -110, -110, 5)];
  const eAn = P.evaluate(proj(), wild, { now: NOW });
  const anRow = eAn.priced.find((x) => x.book === 'draftkings' && x.side === 'over');
  chk('an unconfirmed outlier price is a PRICE ANOMALY (WATCH), never a BET', anRow && anRow.caps.indexOf('PRICE_ANOMALY') >= 0 && anRow.cls !== 'BET', anRow && anRow.caps);
  const fair = [quote('draftkings', Math.round(SUMM.median) + 0.5, -110, -110, 5), quote('fanduel', Math.round(SUMM.median) + 0.5, -110, -110, 5)];
  const eAl = P.evaluate(proj(), fair, { now: NOW });
  chk('a market at the fair line at -110 both ways is a PASS', eAl.decision === 'PASS' && ['NO_MODEL_EDGE', 'MARKET_ALIGNED', 'JUICE_CONSUMES_EDGE', 'EDGE_TOO_SMALL'].indexOf(eAl.reason_code) >= 0, eAl.reason_code);
  chk('decision words are the house vocabulary only', [e0, e1, eStale, eExp, eQ, eAl].every((e) => ['BET', 'LEAN', 'WATCH', 'PASS', 'NO_DECISION'].indexOf(e.decision) >= 0));
  const words = JSON.stringify([e1.reason, eExp.reason, eQ.reason, eAl.reason, P.REASONS]).toLowerCase();
  chk('never "lock", "best bet" or "safe bet"', !/\block\b|best bet|safe bet|guarantee/.test(words));

  /* reliability is not the edge */
  const r1 = P.reliability({ data_completeness: 0.9, sample_n: 200, sample_needed: 60, role_cv: 0.2, player_status: 'ACTIVE', books: 5, dispersion_pp: 1, cv: 0.5, cv_norm: 0.5, league: 'NFL' });
  const r2 = P.reliability({ data_completeness: 0.9, sample_n: 200, sample_needed: 60, role_cv: 0.2, player_status: 'ACTIVE', books: 5, dispersion_pp: 1, cv: 0.5, cv_norm: 0.5, league: 'NFL', edge_pp: 12, ev: 0.3 });
  chk('reliability never reads the size of the edge', r1.score === r2.score, [r1.score, r2.score]);
  chk('unmeasured calibration caps reliability at 78', r1.score <= 78 && r1.unmeasured.indexOf('historical_calibration') >= 0, r1);
  const same = { data_completeness: 0.9, sample_n: 200, sample_needed: 60, role_cv: 0.2, books: 5, dispersion_pp: 1, calibration_score: 0.9 };
  chk('CFB reliability is scaled down at the same inputs', P.reliability(Object.assign({ league: 'CFB' }, same)).score < P.reliability(Object.assign({ league: 'NFL' }, same)).score,
    [P.reliability(Object.assign({ league: 'CFB' }, same)).score, P.reliability(Object.assign({ league: 'NFL' }, same)).score]);
  chk('a questionable status caps reliability at 55', P.reliability({ data_completeness: 1, sample_n: 400, sample_needed: 60, player_status: 'QUESTIONABLE', league: 'NFL' }).score <= 55);
}

/* ====================================================== 7. ALTERNATES */
{
  const qs = [quote('draftkings', LOW, -110, -110, 5), quote('fanduel', LOW, -115, -105, 5),
    quote('draftkings', LOW - 10, -250, null, 5, { is_alternate: true }), quote('draftkings', LOW + 15, 120, null, 5, { is_alternate: true }), quote('draftkings', LOW + 30, 280, null, 5, { is_alternate: true })];
  const e = P.evaluate(proj(), qs, { now: NOW });
  const L = e.ladder;
  const tag = (t) => L.rows.find((x) => x.tags.indexOf(t) >= 0);
  chk('the ladder prices every book, side and line', L.rows.length >= 7, L.rows.length);
  chk('BEST PRICE is a main line', tag('best_price') && !tag('best_price').is_alternate, tag('best_price'));
  chk('BEST EV is the largest EV among clean quotes', tag('best_ev') && L.rows.filter((x) => !x.tail).every((x) => x.ev <= tag('best_ev').ev + 1e-9), tag('best_ev'));
  const safer = tag('safer_line'), up = tag('higher_upside');
  const anomaly = L.rows.find((x) => (x.caps || []).indexOf('PRICE_ANOMALY') >= 0);
  chk('an unconfirmed outlier alternate is flagged, and never a highlight', anomaly && !anomaly.tags.length, anomaly);
  chk('SAFER LINE has the highest probability among clean +EV rungs', safer && L.rows.filter((x) => x.ev > 0 && x.american >= -300 && x.american <= 300 && (x.caps || []).indexOf('PRICE_ANOMALY') < 0).every((x) => x.model_cover <= safer.model_cover + 1e-9), safer);
  chk('HIGHER UPSIDE is a longer price than the safer line', up && RC.americanToDecimal(up.american) > RC.americanToDecimal(safer.american), [up, safer]);
  const hiP = L.rows.slice().sort((a, b) => b.model_cover - a.model_cover)[0], hiEv = L.rows.slice().sort((a, b) => b.ev - a.ev)[0];
  chk('the highest-probability quote is not automatically the highest-EV quote', hiP.id !== hiEv.id, [hiP.label, hiEv.label]);
  const cq = P.compareQuotes(proj(), { side: 'over', line: LOW - 10, american: -250 }, { side: 'over', line: LOW + 15, american: 120 });
  chk('compareQuotes prices both on the same distribution', cq.higher_probability === 'a' && cq.a.cover > cq.b.cover, cq);
}

/* ============================================================== 8. SIZING */
{
  const row = { decision_prob: 0.58, american: -110, caps: [] };
  const s = P.size(row, proj({ stage: 'PRODUCTION', reliability: { score: 85 } }));
  chk('quarter-Kelly: full Kelly of 58% at -110 is 11.8%', near(s.kelly_full, (0.58 * (100 / 110) - 0.42) / (100 / 110), 1e-4), s);
  chk('units land on the grid and never exceed 1U', [0, 0.25, 0.5, 0.75, 1].indexOf(s.units) >= 0 && s.units <= 1, s.units);
  chk('a model-estimated source is capped at 0.25U', P.size(row, proj({ stage: 'TRACKING', reliability: { score: 85 } })).units <= 0.25);
  chk('a negative Kelly sizes to zero', P.size({ decision_prob: 0.45, american: -110, caps: [] }, proj()).units === 0);
  const cards = [{ id: 'a', game_id: 'G', team: 'PHI', player_id: 'p1', units: 0.5, corr_group: 'G|PHI|pass' }, { id: 'b', game_id: 'G', team: 'PHI', player_id: 'p1', units: 0.5, corr_group: 'G|PHI|pass' },
    { id: 'c', game_id: 'G', team: 'PHI', player_id: 'p2', units: 0.5, corr_group: 'G|PHI|pass' }, { id: 'd', game_id: 'G', team: 'LA', player_id: 'p3', units: 1, corr_group: 'G|LA|pass' }];
  const ex = P.applyExposure(cards);
  chk('the per-player cap (0.5U) stops a second prop on the same player', ex[1].units === 0 && ex[1].exposure_caps.indexOf('EXPOSURE') >= 0, ex[1]);
  chk('the correlated-group cap (0.75U) trims a same-side teammate', ex[2].units === 0.25, ex[2]);
  chk('the per-game cap (1.25U) holds across the card', ex.reduce((t, c) => t + c.units, 0) <= 1.25 + 1e-9, ex.map((c) => c.units));
}

/* ========================================================= 9. CORRELATION */
{
  const indep = P.jointProb(0.6, 0.5, 0);
  chk('rho = 0: the joint is the product', near(indep, 0.3, 1e-3), indep);
  const pos = P.jointProb(0.6, 0.5, 0.6);
  chk('positively correlated props hit together more often than the product', pos > 0.3 + 0.03 && pos <= 0.5, pos);
  const neg = P.jointProb(0.6, 0.5, -0.5);
  chk('negatively correlated props less often', neg < 0.3 - 0.03, neg);
  chk('a stored correlation is found in either order', P.correlationOf([{ a: 'x', b: 'y', rho: 0.4 }], 'y', 'x') === 0.4);
}

/* =================================================== 10. GRADE, CLV, FREEZE */
{
  const pred = { prediction_id: 'ppd_x', side: 'over', line: 71.5, american: -110, units: 0.5 };
  chk('WIN above the line', P.grade(pred, { final: true, played: true, actual: 90 }).result === 'WIN');
  chk('LOSS below it', P.grade(pred, { final: true, played: true, actual: 40 }).result === 'LOSS');
  const push = P.grade(Object.assign({}, pred, { line: 71 }), { final: true, played: true, actual: 71 });
  chk('PUSH on a whole line returns the stake (0 units)', push.result === 'PUSH' && push.profit_units === 0, push);
  const dnp = P.grade(pred, { final: true, played: false });
  chk('VOID when the player did not play', dnp.result === 'VOID' && dnp.void_reason === 'DID_NOT_PLAY' && dnp.profit_units === null, dnp);
  chk('VOID when the game was not played', P.grade(pred, { game_status: 'postponed' }).void_reason === 'GAME_NOT_PLAYED');
  chk('not final yet: no result', P.grade(pred, { final: false }).result === null);
  const w = P.grade(pred, { final: true, played: true, actual: 90 });
  chk('units at the price taken: 0.5U × (100/110)', near(w.profit_units, 0.5 * 100 / 110, 1e-4) && near(w.flat_profit, 100 / 110, 1e-4), w);
  chk('Yes/No props grade on one or more', P.gradeSide('yes', 0.5, 1) === 'WIN' && P.gradeSide('yes', 0.5, 0) === 'LOSS' && P.gradeSide('no', 0.5, 0) === 'WIN');
  const c1 = P.clv(pred, { line: 71.5, over: -130, under: 110 });
  chk('price CLV: -110 taken, closing no-vig Over > 52.4% → positive', c1.price > 0 && c1.basis, c1);
  chk('line CLV in points: an Over taken at 71.5 that closes 74.5 gained 3', P.clv(pred, { line: 74.5, over: -110, under: -110 }).line === 3);
  chk('no price CLV across different lines (never mixed)', P.clv(pred, { line: 74.5, over: -110, under: -110 }).price === null);

  const e1 = P.evaluate(proj(), [quote('draftkings', LOW, -110, -110, 5), quote('fanduel', LOW, -112, -108, 6)], { now: NOW });
  const f = P.freeze(proj(), e1, NOW);
  chk('a frozen prediction carries the price, book, probability, fair odds, EV, decision and model version', f && f.american != null && f.book && f.model_cover != null && f.fair_american != null && f.ev != null && f.decision && f.model_version === 'NFL_PLAYER_PROPS_V1.0' && f.projection_id === 'ppj_test', f);
  chk('its id is a hash of its content', /^ppd_[0-9a-f]{16}$/.test(f.prediction_id) && P.freeze(proj(), e1, NOW).prediction_id === f.prediction_id);
  chk('and it is immutable', Object.isFrozen(f) && throws(() => { 'use strict'; f.american = 200; }));
  chk('a different price is a different prediction', P.freeze(proj(), Object.assign({}, e1, { recommended: Object.assign({}, e1.recommended, { american: -105 }) }), NOW).prediction_id !== f.prediction_id);
  chk('freeze refuses at or after kickoff', P.freeze(proj(), e1, Date.parse('2026-10-04T17:00:00Z')) === null);
  chk('a model version is frozen into the record (V1.0 stays V1.0)', P.freeze(proj({ model_version: 'NFL_PLAYER_PROPS_V1.1' }), e1, NOW).model_version === 'NFL_PLAYER_PROPS_V1.1' && f.model_version === 'NFL_PLAYER_PROPS_V1.0');

  const rows = [];
  for (let i = 0; i < 60; i++) rows.push({ result: i % 5 === 0 ? 'PUSH' : (i % 2 ? 'WIN' : 'LOSS'), model_cover: 0.55, market_prob: 0.52, units: 0.25, profit_units: i % 5 === 0 ? 0 : (i % 2 ? 0.227 : -0.25), flat_profit: i % 5 === 0 ? 0 : (i % 2 ? 0.909 : -1), clv_price: 0.01, ev: 0.03, edge_pp: 3, game_id: 'g' + (i % 12) });
  rows.push({ result: 'VOID' });
  const sc = P.scorecard(rows);
  chk('scorecard: settled, decided, pushes and voids counted apart', sc.settled === 60 && sc.pushes === 12 && sc.decided === 48 && sc.voids === 1, sc);
  chk('scorecard: Brier, market Brier, CLV and the sample state', sc.brier != null && sc.market_brier != null && sc.clv_mean === 0.01 && sc.sample_state === 'TOO EARLY', sc);
  chk('edge buckets span 0-2 / 2-4 / 4-7 / 7+', P.edgeBuckets(rows).length === 4 && P.edgeBuckets(rows)[1].n === 60);
}

/* ============================================================ 11. STAGES */
{
  const good = { walk_forward: true, folds: 30, n: 2000, leakage_violations: 0, crps: 10, crps_baseline: 11, pit_max_dev: 0.03, coverage80: 0.80, synthetic_slope: 1.0 };
  chk('no evidence: EXPERIMENTAL', P.stageOf({}, 1).stage === 'EXPERIMENTAL');
  chk('every backtest gate passed: TRACKING', P.stageOf({ backtest: good }, 1).stage === 'TRACKING');
  chk('one leakage violation keeps it EXPERIMENTAL', P.stageOf({ backtest: Object.assign({}, good, { leakage_violations: 1 }) }, 1).stage === 'EXPERIMENTAL');
  chk('a slope outside [0.7, 1.3] keeps it EXPERIMENTAL', P.stageOf({ backtest: Object.assign({}, good, { synthetic_slope: 0.5 }) }, 1).stage === 'EXPERIMENTAL');
  chk('too small a backtest keeps it EXPERIMENTAL', P.stageOf({ backtest: Object.assign({}, good, { n: 200 }) }, 1).stage === 'EXPERIMENTAL');
  chk('a tier-3 market stays EXPERIMENTAL whatever its backtest', P.stageOf({ backtest: good }, 3).stage === 'EXPERIMENTAL');
  const live = { n: 250, slope: 1.02, brier: 0.24, market_brier: 0.242, clv_mean: 0.004, edge_monotone: true };
  chk('RESEARCH GRADE needs 200 settled, slope, Brier vs market, CLV ≥ 0 and monotone buckets', P.stageOf({ backtest: good, live }, 1).stage === 'RESEARCH_GRADE' && P.stageOf({ backtest: good, live: Object.assign({}, live, { clv_mean: -0.01 }) }, 1).stage === 'TRACKING');
  chk('PRODUCTION needs 500 settled, a CLV interval above zero and held-out calibration', P.stageOf({ backtest: good, live: Object.assign({}, live, { n: 600, clv_ci: [0.001, 0.01], calibration_holdout_ok: true }) }, 1).stage === 'PRODUCTION'
    && P.stageOf({ backtest: good, live: Object.assign({}, live, { n: 600, clv_ci: [-0.001, 0.01], calibration_holdout_ok: true }) }, 1).stage === 'RESEARCH_GRADE');
  chk('the stage table: tier-3 props are EXPERIMENTAL on every board', P.stageFor({ longest_rec: { stage: 'TRACKING' } }, 'longest_rec', 'WR') === 'EXPERIMENTAL');
}

/* ===================================================== 12. ONE ENTRY POINT */
{
  const quotes = [quote('draftkings', LOW, -110, -110, 5), quote('fanduel', LOW, -112, -108, 6)];
  const p0 = proj({ stage: undefined, reliability: undefined, reliability_inputs: { data_completeness: 0.95, sample_n: 300, sample_needed: 60, role_cv: 0.2, player_status: 'ACTIVE', league: 'NFL', cv: 0.6 } });
  const stages = { rec_yds: { stage: 'TRACKING' } };
  const a = P.prepare(p0, quotes, { now: NOW, stages, cv_norm: { rec_yds: 0.6 } });
  const b = P.prepare(p0, quotes, { now: NOW, stages, cv_norm: { rec_yds: 0.6 } });
  chk('prepare() is deterministic: the board, the drawer and the desk get one answer', JSON.stringify(a.evaluation) === JSON.stringify(b.evaluation));
  chk('prepare() reads the stage from the board’s stage table', a.projection.stage === 'TRACKING');
  chk('prepare() scores reliability with the market’s depth', a.projection.reliability && a.projection.reliability.score > 0 && a.evaluation.reliability.score === a.projection.reliability.score, a.projection.reliability);
  chk('prepare() explains WHY and RISKS', Array.isArray(a.evaluation.why) && Array.isArray(a.evaluation.risks));
  chk('prepare() closes decisions at kickoff by itself', P.prepare(p0, quotes, { now: Date.parse('2026-10-04T17:01:00Z'), stages }).evaluation.reason_code === 'GAME_STARTED');
  const file = P.compactGame({ league: 'NFL', game_id: 'G' }, [a.projection]);
  chk('compactGame / hydrate round-trip a projection', JSON.stringify(P.hydrate(file, file.projections[0]).dist) === JSON.stringify(a.projection.dist) && P.hydrate(file, file.projections[0]).player_name === 'A.J. Brown');
}

console.log((fail ? 'FAIL' : 'PASS') + ' | player props core | ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
