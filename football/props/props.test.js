#!/usr/bin/env node
/* ===========================================================================
   lib/player_props.js — the player-prop kernel.

   The arithmetic every surface shares (server, page, database view, AI desk):
   distributions, P(over/under/push) at any line from ONE distribution, EV and
   fair odds (parity with research_core and edgedesk_quote_ev), no-vig and the
   consensus, line shopping, movement, the alternate-line ladder, confidence,
   settlement and CLV — and the catalog pinned to football/props/config.

     node football/props/props.test.js
   =========================================================================== */
'use strict';
const assert = require('assert');
const EDP = require('../../lib/player_props.js');
const R = require('../../lib/research_core.js');
const QE = require('../../lib/edgedesk_quote_ev.js');
const MK = require('./config/markets.json');

let pass = 0, fail = 0;
function chk(label, fn) { try { fn(); pass++; } catch (e) { fail++; console.log('FAIL | ' + label + ' | ' + (e && e.message)); } }
const close = (a, b, tol, m) => assert.ok(Math.abs(a - b) <= (tol || 1e-9), (m || '') + ' ' + a + ' vs ' + b);

/* ---------------------------------------------------------- distributions */
chk('Poisson pmf sums to 1 and has mean mu', () => {
  const d = EDP.dist.poissonPmf(4.2); const s = d.v.reduce((a, b) => a + b, 0) + d.tail;
  close(s, 1, 1e-4); close(EDP.dist.moments(d).mean, 4.2, 0.01);
});
chk('negative binomial: mean mu, variance mu + mu^2/size', () => {
  const d = EDP.dist.negBinomPmf(5, 4); const m = EDP.dist.moments(d);
  close(m.mean, 5, 0.02); close(m.sd * m.sd, 5 + 25 / 4, 0.1);
});
chk('countFromMoments picks NB above, binomial below, Poisson at the mean', () => {
  const over = EDP.dist.countFromMoments(6, 12), under = EDP.dist.countFromMoments(30, 20), eq = EDP.dist.countFromMoments(3, 3);
  close(EDP.dist.moments(over).sd ** 2, 12, 0.3); assert.ok(EDP.dist.moments(under).sd ** 2 < 30 - 5); close(EDP.dist.moments(eq).sd ** 2, 3, 0.05);
});
chk('half-point lines split cleanly; over + under = 1', () => {
  const d = EDP.dist.negBinomPmf(4.6, 9);
  [2.5, 3.5, 4.5, 5.5, 7.5].forEach((L) => { const p = EDP.dist.probs(d, L); close(p.over + p.under, 1, 1e-9); assert.strictEqual(p.push, 0); });
});
chk('a whole-number line carries a push equal to P(Y = line)', () => {
  const d = EDP.dist.negBinomPmf(4.6, 9); const p = EDP.dist.probs(d, 5);
  close(p.push, d.v[5], 1e-9); close(p.over + p.under + p.push, 1, 1e-9);
});
chk('a continuous integer stat uses the continuity correction at whole lines', () => {
  const d = EDP.dist.compressCdf([0, 50, 100, 150], [0, 0.4, 0.8, 1], 10, true);
  const p = EDP.dist.probs(d, 70);
  close(p.push, EDP.dist.cdf(d, 70.5) - EDP.dist.cdf(d, 69.5), 1e-9);
});
chk('P(over) falls as the line rises (one distribution, every alternate)', () => {
  const t = { probs: [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99], bins: [{ mu_lo: 1, mu_hi: 200, mu_mid: 60, n: 1000, q: [0, 0.3, 0.6, 0.95, 1.35, 1.75, 2.6] }] };
  const d = EDP.dist.continuousFromRatio(74.2, t, 0, { integer: true });
  const lines = [49.5, 59.5, 64.5, 69.5, 74.5, 79.5, 89.5];
  const ov = lines.map((L) => EDP.dist.probs(d, L).over);
  for (let i = 1; i < ov.length; i++) assert.ok(ov[i] <= ov[i - 1] + 1e-12, 'non-monotone at ' + lines[i]);
  assert.ok(EDP.dist.valid(d));
});
chk('quantiles are monotone and the median sits near the 50% CDF', () => {
  const d = EDP.dist.negBinomPmf(22, 30); const s = EDP.dist.summary(d);
  assert.ok(s.p10 <= s.p25 && s.p25 <= s.median && s.median <= s.p75 && s.p75 <= s.p90);
  assert.ok(EDP.dist.cdf(d, s.median) >= 0.5);
});
chk('recalibration with the identity map changes nothing; a real map stays a distribution', () => {
  const d = EDP.dist.negBinomPmf(4, 8);
  const id = EDP.dist.recalibrate(d, { u: [0, 0.5, 1], g: [0, 0.5, 1] });
  d.v.forEach((v, i) => close(v, id.v[i], 1e-4));
  const bent = EDP.dist.recalibrate(d, { u: [0, 0.25, 0.5, 0.75, 1], g: [0, 0.2, 0.5, 0.8, 1] });
  assert.ok(EDP.dist.valid(bent));
});
chk('mean uncertainty widens the distribution without moving the mean', () => {
  const a = EDP.dist.countWithUncertainty(6, 9, 0), b = EDP.dist.countWithUncertainty(6, 9, 0.25);
  close(EDP.dist.moments(a).mean, EDP.dist.moments(b).mean, 0.05); assert.ok(EDP.dist.moments(b).sd > EDP.dist.moments(a).sd);
});

/* ---------------------------------------------------- pricing parity */
chk('fair odds from 57% is about -133 (the spec example)', () => {
  const d = EDP.dist.bernoulli(0.57); const e = EDP.evaluateQuote(d, { side: 'yes', american_price: -110, lineage: 'observed' }, {});
  assert.ok(Math.abs(e.fair_american - (-133)) <= 1, String(e.fair_american));
});
chk('EV equals research_core.expectedRoi and edgedesk_quote_ev.expectedValue', () => {
  const d = EDP.dist.negBinomPmf(5.1, 7);
  [[-110, 4.5], [+125, 5.5], [-150, 3.5], [+240, 6.5]].forEach(([am, L]) => {
    const e = EDP.evaluateQuote(d, { side: 'over', line: L, american_price: am, lineage: 'observed' }, {});
    const p = EDP.dist.probs(d, L);
    close(e.ev, R.expectedRoi(p.over, am, p.push), 1e-12, 'roi');
    close(e.ev, QE.expectedValue(p.over, p.push, p.under, R.americanToDecimal(am)), 1e-12, 'qe');
  });
});
chk('a PRICE makes the bet: the same line is +EV at -105 and -EV at -150', () => {
  const t = { probs: [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99], bins: [{ mu_lo: 1, mu_hi: 200, mu_mid: 60, n: 1000, q: [0, 0.35, 0.68, 1.0, 1.35, 1.7, 2.5] }] };
  const d = EDP.dist.continuousFromRatio(82, t, 0, { integer: true });
  const a = EDP.evaluateQuote(d, { side: 'over', line: 74.5, american_price: -105, lineage: 'observed' }, {});
  const b = EDP.evaluateQuote(d, { side: 'over', line: 74.5, american_price: -150, lineage: 'observed' }, {});
  close(a.model_prob, b.model_prob, 1e-12, 'same projection'); assert.ok(a.ev > 0 && b.ev < 0, a.ev + ' / ' + b.ev);
});
chk('edge = model probability − no-vig market probability; the price never moves the probability', () => {
  const d = EDP.dist.bernoulli(0.58);
  const nv = EDP.noVig(-110, -110);
  const e = EDP.evaluateQuote(d, { side: 'yes', american_price: -110, lineage: 'observed' }, { no_vig_prob: nv.p });
  close(nv.p, 0.5, 1e-12); close(e.edge_vs_market, 0.08, 1e-9); close(e.model_prob, 0.58, 1e-12);
});
chk('RECONSTRUCTED and missing lineage are refused, never priced', () => {
  const d = EDP.dist.negBinomPmf(5, 7);
  const r = EDP.evaluateQuote(d, { side: 'over', line: 4.5, american_price: -110, lineage: 'reconstructed' }, {});
  const m = EDP.evaluateQuote(d, { side: 'over', line: 4.5, american_price: -110 }, {});
  assert.ok(!r.ok && /reconstructed/.test(r.reason) && r.ev === null); assert.ok(!m.ok && m.ev === null);
});
chk('an invalid American price (+50) is refused', () => {
  const e = EDP.evaluateQuote(EDP.dist.poissonPmf(3), { side: 'over', line: 2.5, american_price: 50, lineage: 'observed' }, {});
  assert.ok(!e.ok);
});
chk('conservative probability sits between the market and the model', () => {
  const d = EDP.dist.bernoulli(0.62);
  const e = EDP.evaluateQuote(d, { side: 'yes', american_price: 100, lineage: 'observed' }, { no_vig_prob: 0.48, reliability: 0.5 });
  assert.ok(e.conservative_prob > 0.48 && e.conservative_prob < 0.62); assert.ok(e.conservative_ev < e.ev);
});

/* ---------------------------------------------------- market view */
function quote(book, side, line, am, snap, main) { return { game_id: 'g', player_id: 'p', market_key: 'receiving_yards', sportsbook: book, side, line, american_price: am, snapshot_at: snap || '2026-10-01T12:00:00Z', lineage: 'observed', is_main_line: main !== false }; }
const Q = [quote('dk', 'over', 69.5, -110), quote('dk', 'under', 69.5, -110), quote('fd', 'over', 69.5, -105), quote('fd', 'under', 69.5, -115),
  quote('mgm', 'over', 71.5, -110), quote('mgm', 'under', 71.5, -110), quote('dk', 'over', 79.5, 130, null, false), quote('dk', 'over', 59.5, -170, null, false),
  quote('dk', 'over', 69.5, -200, null, false).lineage = 'reconstructed' && quote('rc', 'over', 60.5, -110)];
Q[Q.length - 1].lineage = 'reconstructed';
chk('market view: consensus line, depth, best price at the consensus, best number anywhere', () => {
  const v = EDP.marketView(Q);
  assert.strictEqual(v.book_count, 3); assert.strictEqual(v.consensus_line, 69.5);
  assert.strictEqual(v.best_over_price.sportsbook, 'fd'); assert.strictEqual(v.best_over_price.american_price, -105);
  assert.strictEqual(v.best_under_line.line, 71.5); assert.strictEqual(v.line_dispersion, 2);
  assert.ok(!v.books.some((b) => b.sportsbook === 'rc'), 'a reconstructed quote never enters the market view');
});
chk('no-vig pairing uses the same book, snapshot and line only', () => {
  const pairs = EDP.pairQuotes(Q.filter((q) => q.lineage === 'observed'));
  const fd = pairs.find((x) => x.quote.sportsbook === 'fd' && x.quote.side === 'over');
  close(fd.no_vig_prob, R.noVigTwoWay(-105, -115).a, 1e-12);
  const alt = pairs.find((x) => x.quote.line === 79.5); assert.strictEqual(alt.no_vig_prob, null);
});
chk('movement: opener, current, close and minutes since a meaningful move', () => {
  const h = [quote('dk', 'over', 66.5, -110, '2026-10-01T10:00:00Z'), quote('dk', 'under', 66.5, -110, '2026-10-01T10:00:00Z'),
    quote('dk', 'over', 69.5, -110, '2026-10-02T10:00:00Z'), quote('dk', 'under', 69.5, -110, '2026-10-02T10:00:00Z')];
  const m = EDP.movement(h, { kickoff: '2026-10-03T17:00:00Z', now: Date.parse('2026-10-02T12:00:00Z') });
  assert.strictEqual(m.open.line, 66.5); assert.strictEqual(m.current.line, 69.5); assert.strictEqual(m.line_move, 3);
  assert.strictEqual(m.close, null, 'no close before kickoff'); assert.strictEqual(m.minutes_since_move, 120);
  const m2 = EDP.movement(h, { kickoff: '2026-10-03T17:00:00Z', now: Date.parse('2026-10-04T00:00:00Z') });
  assert.strictEqual(m2.close.line, 69.5);
});

chk('a withdrawn line leaves the market: change-only prices + the poll listing', () => {
  /* dk moved 66.5 -> 69.5; fd never changed its 69.5 price, so its row is only stored at the first poll */
  const h = [quote('dk', 'over', 66.5, -110, '2026-10-01T10:00:00Z'), quote('dk', 'under', 66.5, -110, '2026-10-01T10:00:00Z'),
    quote('fd', 'over', 69.5, -105, '2026-10-01T10:00:00Z'), quote('fd', 'under', 69.5, -115, '2026-10-01T10:00:00Z'),
    quote('dk', 'over', 69.5, -110, '2026-10-02T10:00:00Z'), quote('dk', 'under', 69.5, -110, '2026-10-02T10:00:00Z')];
  const listings = [{ sportsbook: 'dk', snapshot_at: '2026-10-01T10:00:00Z', keys: ['over|66.5|0', 'under|66.5|0'] }, { sportsbook: 'fd', snapshot_at: '2026-10-01T10:00:00Z', keys: ['over|69.5|0', 'under|69.5|0'] },
    { sportsbook: 'dk', snapshot_at: '2026-10-02T10:00:00Z', keys: ['over|69.5|0', 'under|69.5|0'] }, { sportsbook: 'fd', snapshot_at: '2026-10-02T10:00:00Z', keys: ['over|69.5|0', 'under|69.5|0'] }];
  const v = EDP.marketView(h, { listings });
  assert.strictEqual(v.consensus_line, 69.5); assert.strictEqual(v.book_count, 2);
  assert.ok(!EDP.latestByBook(h, { listings }).some((q) => q.line === 66.5), 'the withdrawn 66.5 is gone');
  assert.ok(EDP.latestByBook(h, { listings }).some((q) => q.sportsbook === 'fd' && q.american_price === -105), 'the unchanged fd price is still current');
  const m = EDP.movement(h, { listings, kickoff: '2026-10-03T17:00:00Z', now: Date.parse('2026-10-02T12:00:00Z') });
  assert.strictEqual(m.open.line, 68); assert.strictEqual(m.current.line, 69.5);
});

/* ---------------------------------------------------- the alternate ladder */
chk('alternate ladder: one distribution, P and fair price per line, best VALUE is not the extreme edge', () => {
  const t = { probs: [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99], bins: [{ mu_lo: 1, mu_hi: 200, mu_mid: 60, n: 1000, q: [0, 0.3, 0.6, 0.95, 1.35, 1.75, 2.6] }] };
  const d = EDP.dist.continuousFromRatio(74.2, t, 0, { integer: true });
  const ladderQ = [[49.5, -190], [59.5, -145], [69.5, -110], [79.5, 120], [89.5, 165], [109.5, 450]].map(([L, am]) => ({ side: 'over', line: L, american_price: am, sportsbook: 'dk', lineage: 'observed', is_main_line: L === 69.5 }));
  const evals = ladderQ.map((q) => EDP.evaluateQuote(d, q, { reliability: 0.6, tail_z: (q.line - 70) / 25, consensus_prob: q.line === 69.5 ? 0.5 : null }));
  const L = EDP.ladder(evals, { side: 'over', main_line: 69.5 });
  assert.strictEqual(L.rows.length, 6);
  L.rows.forEach((r) => { assert.ok(r.model_prob > 0 && r.model_prob < 1); assert.ok(r.fair_american != null); });
  for (let i = 1; i < L.rows.length; i++) assert.ok(L.rows[i].model_prob <= L.rows[i - 1].model_prob + 1e-12);
  assert.ok(!L.flags.some((f) => f.code === 'PROB_NON_MONOTONE'));
  if (L.best_value && L.max_ev) assert.ok(L.best_value.kelly_growth >= 0);
  assert.ok(/log-growth/.test(L.rule));
});
chk('the ladder flags a model that disagrees with itself', () => {
  const a = { ok: true, side: 'over', line: 60.5, model_prob: 0.5, decimal: 1.9, ev: -0.05, conservative_ev: -0.05, kelly_growth: 0, sportsbook: 'a' };
  const b = { ok: true, side: 'over', line: 70.5, model_prob: 0.6, decimal: 1.9, ev: 0.14, conservative_ev: 0.05, kelly_growth: 0.001, sportsbook: 'b' };
  assert.ok(EDP.ladder([a, b], { side: 'over' }).flags.some((f) => f.code === 'PROB_NON_MONOTONE'));
});
chk('playable-to: the line where this price stops being +EV', () => {
  const d = EDP.dist.negBinomPmf(6.2, 12);
  const to = EDP.playableTo(d, 'over', -110, 4.5);
  assert.ok(to >= 4.5);
  const past = EDP.evaluateQuote(d, { side: 'over', line: to + 0.5, american_price: -110, lineage: 'observed' }, {});
  assert.ok(past.ev <= 0);
});

/* ---------------------------------------------------- confidence, decision */
chk('edge, confidence and data quality are separate numbers; unknowns cost', () => {
  const full = EDP.confidence({ sample_size: 0.9, model_calibration: 0.8, role_certainty: 0.9, injury_certainty: 1, qb_certainty: 1, model_agreement: 0.9, market_depth: 1, book_dispersion: 0.9, source_quality: 1 });
  const holes = EDP.confidence({ sample_size: 0.9, model_calibration: 0.8 });
  assert.ok(full.score > holes.score); assert.ok(holes.unknown.length >= 5);
  const hurt = EDP.confidence({ sample_size: 1, model_calibration: 1, role_certainty: 1, injury_certainty: 0.2, qb_certainty: 1, model_agreement: 1, market_depth: 1, book_dispersion: 1, source_quality: 1 });
  assert.ok(hurt.score <= 50, 'an uncertain injury caps confidence: ' + hurt.score);
});
chk('a 10% edge with a guessed role is not a BET; nothing is BET until the market tier is VALIDATED', () => {
  const ev = { ok: true, ev: 0.12, conservative_ev: 0.05 };
  const low = EDP.decide(ev, { score: 35 }, { score: 0.8 }, 'VALIDATED');
  const high = EDP.decide(ev, { score: 75 }, { score: 0.85 }, 'RESEARCH');
  const ok = EDP.decide(ev, { score: 75 }, { score: 0.85 }, 'VALIDATED');
  assert.strictEqual(low.decision, 'WATCH'); assert.strictEqual(high.decision, 'LEAN'); assert.ok(/capped at LEAN/.test(high.reasons[0])); assert.strictEqual(ok.decision, 'BET');
});
chk('edge buckets are the spec buckets', () => {
  assert.deepStrictEqual([0.01, 0.03, 0.05, 0.07, 0.09, 0.15].map(EDP.edgeBucket), ['0-2%', '2-4%', '4-6%', '6-8%', '8-10%', '10%+']);
});

/* ---------------------------------------------------- settlement */
chk('settle: over/under/push/void and units on the frozen price', () => {
  assert.strictEqual(EDP.settle('over', 69.5, 88), 'WIN'); assert.strictEqual(EDP.settle('over', 69.5, 12), 'LOSS');
  assert.strictEqual(EDP.settle('under', 5, 5), 'PUSH'); assert.strictEqual(EDP.settle('yes', null, 1), 'WIN');
  assert.strictEqual(EDP.settle('over', 69.5, 88, { void_reason: 'did not play' }), 'VOID');
  close(EDP.unitsFor('WIN', -110, 1), 100 / 110, 1e-4); assert.strictEqual(EDP.unitsFor('LOSS', -110, 1), -1); assert.strictEqual(EDP.unitsFor('PUSH', -110, 1), 0);
});
chk('CLV: price CLV at the same line, line CLV signed so + = better number', () => {
  const c = EDP.clv({ side: 'over', line: 69.5, american: -110 }, { line: 72.5, side_price: -110, other_price: -110 });
  assert.strictEqual(c.line, 3); assert.strictEqual(c.price, null);
  const c2 = EDP.clv({ side: 'over', line: 69.5, american: -105 }, { line: 69.5, side_price: -130, other_price: 110 });
  close(c2.price, R.clvPrice(-105, -130, 110, true), 1e-12); assert.ok(c2.price > 0);
});

/* ---------------------------------------------------- catalog parity */
chk('the kernel catalog and config/markets.json name the same 27 markets', () => {
  const a = Object.keys(EDP.MARKETS).sort(), b = MK.markets.map((m) => m.market_key).sort();
  assert.deepStrictEqual(a, b); assert.strictEqual(a.length, 27);
  MK.markets.forEach((m) => assert.strictEqual(EDP.MARKETS[m.market_key].family, m.family, m.market_key));
});
chk('provider labels normalise at ingestion: player_pass_yds → pass_yards, _alternate is the same market', () => {
  const map = new Map(MK.provider_map.map((x) => [x.provider_market_key, x]));
  assert.strictEqual(map.get('player_pass_yds').market_key, 'pass_yards');
  assert.strictEqual(map.get('player_reception_yds_alternate').market_key, 'receiving_yards'); assert.ok(map.get('player_reception_yds_alternate').is_alternate);
});
chk('the explanation names only what is present', () => {
  const x = EDP.explain({ market_key: 'receiving_yards', model: { mean: 74.2, median: 72, p10: 30, p90: 118 }, market: null, focus: {}, drivers: [], confidence: { components: [], unknown: ['market_depth'] } });
  assert.ok(/No observed sportsbook line/.test(x.market[0])); assert.ok(x.risks.some((r) => /Market depth is unknown/.test(r))); assert.strictEqual(x.tagline, 'Research, not picks.');
});

/* ---------------------------------------------------------- the wire format
   The page and the AI desk re-derive every price from the published card and
   market file with reprice(): the round trip must reproduce the scorer. */
(function wire() {
  const NOW = Date.parse('2026-10-01T15:00:00Z'), NOW_ISO = new Date(NOW).toISOString();
  const table = { probs: [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99], bins: [{ mu_lo: 1, mu_hi: 200, mu_mid: 60, n: 1000, q: [0, 0.35, 0.68, 1.0, 1.32, 1.66, 2.4] }] };
  const G = { game_id: '2026_05_KC_BUF', kickoff_utc: '2026-10-04T17:00:00.000Z', home: 'BUF', away: 'KC', home_name: 'Buffalo Bills', away_name: 'Kansas City Chiefs' };
  function base(pid, name, market, dist) {
    const sm = EDP.dist.summary(dist);
    return { id: G.game_id + '|' + pid + '|' + market, league: 'NFL', game_id: G.game_id, kickoff_utc: G.kickoff_utc, matchup: 'Kansas City Chiefs @ Buffalo Bills', team: 'KC', opponent: 'BUF', is_home: false,
      player_id: pid, player: name, position: 'TE', headshot: null, market_key: market, market_label: EDP.marketLabel(market), family: dist.t,
      model: { prediction_id: 'pp_' + market, model_version: 'nfl_te_' + market + '_v1.2025', feature_version: 'pf1', training_cutoff: '2026-02-09T23:30:00.000Z', scored_at: NOW_ISO,
        mean: sm.mean, median: sm.median, p10: sm.p10, p25: sm.p25, p75: sm.p75, p90: sm.p90, sd: sm.sd, uncertainty: 1, ref_line: null, over_prob: null, under_prob: null, fair_over: null, fair_under: null,
        outcome_tier: 'OUTCOME_VALIDATED', market_tier: 'RESEARCH', recalibrated: true, dist },
      market: null, movement: null, focus: null, ladders: null, n_quotes: 0,
      confidence: EDP.confidence({ sample_size: 0.8, model_calibration: 0.7, role_certainty: 0.8, injury_certainty: 0.85, qb_certainty: 1, model_agreement: 0.9, source_quality: 1, notes: { injury_certainty: 'listed Questionable' } }),
      data_quality: null, decision: null, playable_to: null, context: { form: { receiving_yards: { l3: 70, l5: 68, l8: 66, season: 71, weighted: 69 } } },
      drivers: [{ feature: 'target_share_l5', label: 'target share (last 5)', value: 0.241, effect: 0.0591, pct: 6.1 }].map((d) => Object.assign(d, { text: EDP.wire.driverText(d) })),
      imputed: ['cfb_seasons'], as_of: NOW_ISO, source_max_timestamp: '2026-09-29T04:00:00.000Z',
      _dq_inputs: { feature_completeness: 0.93, identity_confidence: 1, source_quality: 1, availability_freshness: 0.9 }, _invalidators: ['The player is listed Questionable: a limited snap count would cut the projection.'] };
  }
  const ydDist = EDP.wire.roundDist(EDP.dist.continuousFromRatio(74, table, 0, { integer: true }));
  const tdDist = EDP.wire.roundDist(EDP.dist.bernoulli(0.41));
  const t0 = new Date(NOW - 5 * 3600e3).toISOString(), t1 = new Date(NOW - 25 * 60e3).toISOString();
  const q = (pid, market, book, side, line, am, at, extra) => Object.assign({ game_id: G.game_id, player_id: pid, market_key: market, sportsbook: book, side, line, american_price: am, snapshot_at: at, is_main_line: true, lineage: 'observed' }, extra || {});
  const yq = [
    q('espn:2', 'receiving_yards', 'draftkings', 'over', 68.5, -110, t0), q('espn:2', 'receiving_yards', 'draftkings', 'under', 68.5, -110, t0),
    q('espn:2', 'receiving_yards', 'draftkings', 'over', 69.5, -112, t1), q('espn:2', 'receiving_yards', 'draftkings', 'under', 69.5, -108, t1),
    q('espn:2', 'receiving_yards', 'fanduel', 'over', 69.5, -114, t1), q('espn:2', 'receiving_yards', 'fanduel', 'under', 69.5, -106, t1),
    q('espn:2', 'receiving_yards', 'fanduel', 'over', 59.5, -190, t1, { is_main_line: false, is_alt_line: true }), q('espn:2', 'receiving_yards', 'fanduel', 'over', 79.5, +165, t1, { is_main_line: false, is_alt_line: true }),
    q('espn:2', 'receiving_yards', 'fanduel', 'over', 89.5, +260, t0, { is_main_line: false, is_alt_line: true }),
    q('espn:2', 'receiving_yards', 'betmgm', 'over', 70.5, -105, t1), q('espn:2', 'receiving_yards', 'betmgm', 'under', 70.5, -115, t1)
  ];
  /* FanDuel's latest poll no longer lists the 89.5 alternate: it must drop out */
  const listings = [{ sportsbook: 'draftkings', snapshot_at: t1, keys: ['over|69.5|0', 'under|69.5|0'] },
    { sportsbook: 'fanduel', snapshot_at: t1, keys: ['over|69.5|0', 'under|69.5|0', 'over|59.5|1', 'over|79.5|1'] },
    { sportsbook: 'betmgm', snapshot_at: t1, keys: ['over|70.5|0', 'under|70.5|0'] }];
  const tq = [q('espn:2', 'anytime_td', 'draftkings', 'yes', null, +135, t1), q('espn:2', 'anytime_td', 'draftkings', 'no', null, -165, t1)];
  const server = [EDP.reprice(base('espn:2', 'Travis Kelce', 'receiving_yards', ydDist), yq, { now: NOW, listings }), EDP.reprice(base('espn:2', 'Travis Kelce', 'anytime_td', tdDist), tq, { now: NOW })];
  const card = JSON.parse(JSON.stringify(EDP.wire.packCard(server, G, { league: 'NFL', generated_at: NOW_ISO })));
  const market = JSON.parse(JSON.stringify(EDP.wire.packMarket(server, { league: 'NFL', game_id: G.game_id, as_of: NOW_ISO })));
  const client = EDP.wire.expandCard(card, market);
  const strip = (p) => { const o = {}; Object.keys(p).forEach((k) => { if (k[0] !== '_') o[k] = p[k]; }); return JSON.parse(JSON.stringify(o)); };
  chk('wire: card + market file reproduce the scorer\'s props exactly (prices, ladders, EV, decision, why)', () => {
    assert.strictEqual(client.length, 2);
    client.forEach((c, i) => assert.deepStrictEqual(strip(c), strip(server[i])));
  });
  chk('wire: a line the book withdrew is not in the published quotes, the ladder or the market', () => {
    const lad = server[0].ladders.over.rows.map((r) => r.line);
    assert.ok(lad.indexOf(89.5) < 0 && lad.indexOf(79.5) >= 0 && lad.indexOf(59.5) >= 0, lad.join(','));
    const pub = market.props['espn:2|receiving_yards'].q.map((a) => a[2]);
    assert.ok(pub.indexOf(89.5) < 0 && pub.indexOf(68.5) < 0, pub.join(','));
  });
  chk('wire: movement is carried from the full history (the opener is not in the current set)', () => {
    assert.ok(server[0].movement && server[0].movement.available, JSON.stringify(server[0].movement));
    assert.deepStrictEqual(client[0].movement, server[0].movement);
  });
  chk('wire: the published market file is observed quotes only, with capture times', () => {
    assert.strictEqual(market.lineage, 'observed'); assert.strictEqual(market.schema, 'edgedesk_props_market_v1');
    client[0]._current_quotes.forEach((x) => { assert.strictEqual(x.lineage, 'observed'); assert.ok(Date.parse(x.snapshot_at) > 0); });
  });
  chk('wire: the card alone is the model half — no price, market or edge is invented', () => {
    const solo = EDP.wire.expandCard(card, null);
    solo.forEach((c) => { assert.strictEqual(c.market, null); assert.strictEqual(c.focus, null); assert.strictEqual(c.ladders, null); assert.strictEqual(c.decision.decision, 'PASS'); });
    assert.strictEqual(solo[0].model.ref_line, Math.floor(solo[0].model.median) + 0.5);
    assert.deepStrictEqual(solo[0].model.dist, server[0].model.dist);
  });
  chk('wire: player-level fields are stored once and restored per market', () => {
    assert.strictEqual(Object.keys(card.players).length, 1);
    assert.ok(!('inv' in card.props[0]) && !('src' in card.props[0]));
    assert.deepStrictEqual(client[1]._invalidators, server[1]._invalidators);
    assert.strictEqual(client[1].source_max_timestamp, server[1].source_max_timestamp);
  });
  chk('wire: the packed board unpacks to the table rows', () => {
    const b = EDP.wire.packBoard({ schema: 'edgedesk_props_board_v1', league: 'NFL', generated_at: NOW_ISO, as_of: NOW_ISO,
      games: [{ game_id: G.game_id, kickoff: G.kickoff_utc, home: 'Buffalo Bills', away: 'Kansas City Chiefs', home_id: 'BUF', away_id: 'KC' }] }, server);
    const e = EDP.wire.expandBoard(JSON.parse(JSON.stringify(b)));
    assert.strictEqual(e.rows.length, 2); assert.ok(Array.isArray(b.rows[0]));
    const r0 = e.rows[0];
    assert.strictEqual(r0.id, server[0].id); assert.strictEqual(r0.team, 'KC'); assert.strictEqual(r0.opp, 'BUF'); assert.strictEqual(r0.home, false);
    assert.strictEqual(r0.matchup, 'Kansas City Chiefs @ Buffalo Bills'); assert.strictEqual(r0.model_version, server[0].model.model_version);
    assert.strictEqual(r0.focus.cev, server[0].focus.conservative_ev); assert.strictEqual(r0.mkt.books, server[0].market.book_count);
    assert.strictEqual(r0.conf, server[0].confidence.score); assert.strictEqual(r0.conf_grade, server[0].confidence.grade); assert.strictEqual(r0.decision, server[0].decision.decision);
    assert.strictEqual(e.rows[1].market, 'anytime_td'); assert.strictEqual(e.rows[1].over, server[1].model.over_prob);
  });
  chk('wire: the published precision is what everyone prices with (rounding is idempotent)', () => {
    assert.deepStrictEqual(EDP.wire.roundDist(ydDist), ydDist);
    const pm = EDP.wire.roundDist(EDP.dist.poissonPmf(3.3)); assert.ok(pm.v[pm.v.length - 1] > 0); assert.ok(Math.abs(pm.v.reduce((a, b) => a + b, 0) + pm.tail - 1) < 1e-4);
  });
})();

console.log((fail ? 'FAILED' : 'ALL GREEN') + ' props kernel — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
