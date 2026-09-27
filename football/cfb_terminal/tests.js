#!/usr/bin/env node
/* ============================================================================
   The CFB research terminal's rules, pinned.

     node football/cfb_terminal/tests.js

   Part 1 builds research objects from SYNTHETIC bundles, so every rule is
   tested on a case built to break it. Part 2 builds the real slate from the
   committed production artifacts (build.js --check path) and holds the
   finished objects to the same rules. Part 3 checks the page and the
   boundaries around it (the LLM guard, analytics isolation, no live model).
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const T = require(path.join(ROOT, 'lib', 'cfb_terminal.js'));
const X = require(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_cfb_explain.js'));

let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) pass++; else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : '')); } }
function section(t) { console.log('\n' + t); }

/* ------------------------------------------------------------------ fixtures */
const NOW = Date.parse('2026-10-01T12:00:00Z');
const KICK = '2026-10-03T19:30:00Z';
/* a simple, exact distribution: normal around the fair margin, integer grid,
   so the tests can compute the answers independently */
function normalDist(mu, sd) {
  const cdf = (x) => 0.5 * (1 + erf((x - mu) / (sd * Math.SQRT2)));
  return { basis: 'test normal', quantiles: { p10: mu - 1.2816 * sd, p25: mu - 0.6745 * sd, p50: mu, p75: mu + 0.6745 * sd, p90: mu + 1.2816 * sd },
    cover: (line) => { const pu = Number.isInteger(line) ? cdf(line + 0.5) - cdf(line - 0.5) : 0; const win = 1 - cdf(Number.isInteger(line) ? line + 0.5 : line); return { win, push: pu, lose: 1 - win - pu }; } };
}
function erf(x) { const s = x < 0 ? -1 : 1; x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x);
  return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)); }
function q(book, homeLine, minsAgo, ph, pa) { return { book, source: 'test', home_line: homeLine, price_home: ph == null ? -110 : ph, price_away: pa == null ? -110 : pa, observed_at: new Date(NOW - minsAgo * 60000).toISOString() }; }
function bundle(over) {
  const b = {
    now: NOW,
    game: { game_id: 'G1', season: 2026, week: 5, kickoff: KICK, home: 'Home U', away: 'Away St', matchup_type: 'conference' },
    model: { model_version: 'edgedesk_cfb_p4_v1.0.0', label: 'V1', role: 'champion', home_margin: 7.5, fair_total: 55, home_points: 31.25, away_points: 23.75,
      home_win_prob: 0.69, sigma: 15, football_confidence: 80, prediction_ts: '2026-10-01T10:00:00Z', source: 'test' },
    dist: normalDist(7.5, 15),
    terms: [{ key: 'rating', points: 5.1 }, { key: 'hfa', points: 2.2 }, { key: 'matchup', points: 0.9 }, { key: 'travel', points: -0.7 }],
    expected_abs_error: 11.9,
    market: { quotes: [q('bookA', -4, 30), q('bookB', -4.5, 40), q('bookC', -4, 50)], open_home_line: -3 },
    decision: { status: 'NO_BET', reason_codes: ['NO_BET_BETTING_DISABLED'], reasons: ['betting is disabled'] },
    models: [{ key: 'v1', label: 'V1', home_margin: 7.5, independent: true }, { key: 'v21_ridge', label: 'ridge', home_margin: 7.1, independent: true }, { key: 'v21_gbm', label: 'gbm', home_margin: 7.9, independent: true }],
    stability: { dimensions: [{ key: 'rating_home', sigma: 1.2 }, { key: 'rating_away', sigma: 1.0 }, { key: 'hfa', sigma: 1.1 }], favorite_flip_rate: 0 },
    qb: { home: { player: 'QB H', status: 'CONFIRMED', confirmed: true }, away: { player: 'QB A', status: 'CONFIRMED', confirmed: true } },
    reliability: { score: 88, grade: 'STRONG' },
    key_mass: { 3: 0.0926, 7: 0.0851, 10: 0.0461, 14: 0.0461 },
    v2params: { qb: { change_delta_pts: -1.16, baseline_same_starter: 0.857, change_delta_ci: [-2, -0.2], n_changes_dev: 1567 }, qb_common: { status_start_prob: { out: 0, confirmed: 0.99 } },
      weather: { var_pts_per_wind_mph: 0.25, wind_threshold_mph: 15, points_applied: false }, injury: { var_pts_per_unit: 3, unit_caps: { OL: 0.6 }, team_cap: 1.5, points_applied: false } },
    trust: { model_updated_at: '2026-10-01T10:00:00Z', betting_enabled: false },
    games_played: { home: 4, away: 4, min: 4 }
  };
  return Object.assign(b, over || {});
}

(async function main() {
/* ======================================================================= */
section('1. the canonical fair line and the four separate fields');
{
  const o = T.build(bundle());
  ok('EDGEDESK FAIR is the champion’s own margin, unchanged', o.edgedesk.home_margin === 7.5 && o.edgedesk.model_version === 'edgedesk_cfb_p4_v1.0.0');
  ok('the object is deep-frozen (no layer can rewrite it)', Object.isFrozen(o) && Object.isFrozen(o.status) && Object.isFrozen(o.edgedesk));
  let threw = false; try { 'use strict'; o.status.key = 'BET'; } catch (e) { threw = true; }
  ok('writing the status throws', threw && o.status.key !== 'BET');
  ok('disagreement, price value, research interest and bet quality are four fields', ['football_disagreement', 'price_value', 'research_interest', 'bet_quality'].every((k) => k in o.fields));
  ok('the decomposition sums exactly to the fair margin', o.why.available && o.why.reconciles === true && Math.abs(o.why.final_margin - 7.5) < 1e-9, o.why);
  ok('win and cover probability are different numbers with different names', o.edgedesk.home_win_prob === 0.69 && o.price.current && o.price.current.cover !== 0.69);
  ok('projected score adds to the fair total', Math.abs(o.edgedesk.projected_score.home + o.edgedesk.projected_score.away - 55) < 0.11);
}

section('2. the market never enters the pure projection');
{
  const a = T.build(bundle());
  const b = T.build(bundle({ market: { quotes: [q('bookA', -12, 10), q('bookB', -13, 10), q('bookC', -12.5, 10)], open_home_line: -3 } }));
  ok('the EdgeDesk view is identical under a different market', JSON.stringify(a.edgedesk) === JSON.stringify(b.edgedesk));
  ok('so is the decomposition', JSON.stringify(a.why.rows) === JSON.stringify(b.why.rows));
  ok('so is the sensitivity', JSON.stringify(a.sensitivity.rows) === JSON.stringify(b.sensitivity.rows));
  ok('the timeline says the market never enters the model', /never enters/.test(a.timeline.model_note));
  const snaps = [{ at: '2026-09-28T12:00:00Z', home_margin: 8.0, terms: { rating: 5.6, hfa: 2.2, matchup: 0.9, travel: -0.7 }, model_version: 'v' },
                 { at: '2026-10-01T10:00:00Z', home_margin: 7.5, terms: { rating: 5.1, hfa: 2.2, matchup: 0.9, travel: -0.7 }, model_version: 'v' }];
  const c = T.build(bundle({ snapshots: snaps, checkpoints: snaps.map((s) => ({ at: s.at, home_margin: s.home_margin, model_version: 'v' })),
    market: { quotes: [q('bookA', -4, 3000), q('bookA', -6, 30)], open_home_line: -4 } }));
  ok('what changed attributes the model move exactly to the terms that moved', c.what_changed.attribution === 'exact' && c.what_changed.rows.length === 1 && c.what_changed.rows[0].key === 'rating' && Math.abs(c.what_changed.rows[0].delta + 0.5) < 1e-9, c.what_changed.rows);
  ok('and reports the market separately, never as an attribution row', c.what_changed.market && !c.what_changed.rows.some((r) => /market/i.test(r.key)));
}

section('3. point-in-time market and timelines');
{
  const future = q('bookZ', -20, -60);   /* observed an hour AFTER now */
  const o = T.build(bundle({ market: { quotes: [q('bookA', -4, 30), future], open_home_line: -3 } }));
  ok('a quote from after the build time is not in the market', !o.market.quotes.some((x) => x.book === 'bookZ') && o.market.consensus_home_line === -4);
  ok('nor on the timeline', o.timeline.market.every((p) => Date.parse(p.at) <= NOW));
  const past = bundle({ now: Date.parse('2026-10-05T00:00:00Z'), market: { quotes: [q('bookA', -4, 30), { book: 'bookA', home_line: -9, observed_at: '2026-10-03T21:00:00Z' }] },
    checkpoints: [{ at: '2026-10-01T10:00:00Z', home_margin: 7.5 }, { at: '2026-10-03T22:00:00Z', home_margin: 3 }] });
  const tl = T.timelines(past, { available: true }, T.config());
  ok('a settled game’s timeline stops at kickoff (model)', tl.model.every((p) => Date.parse(p.at) <= Date.parse(KICK)));
  ok('and (market)', tl.market.every((p) => Date.parse(p.at) <= Date.parse(KICK)));
}

section('4. price targets come from the distribution handed in');
{
  const b = bundle(); const o = T.build(b);
  const cur = o.price.current;
  const d = b.dist.cover(4);           /* home -4: covers if margin > 4 */
  const p = d.win / (d.win + d.lose);
  ok('cover probability at the current line is the distribution’s, pushes aside', Math.abs(cur.cover - p) < 1e-4, [cur.cover, p]);
  ok('push probability is the distribution’s at an integer line', Math.abs(cur.push - d.push) < 1e-4);
  ok('break-even at -110 is 52.38%', Math.abs(cur.break_even - 0.5238) < 1e-4);
  ok('EV = p_win x payout - p_loss', Math.abs(cur.ev - (d.win * (100 / 110) - d.lose)) < 1e-4);
  const lines = o.price.curve.map((r) => r.line), covers = o.price.curve.map((r) => r.cover);
  ok('the curve is ordered best number first', lines.every((l, i) => i === 0 || l < lines[i - 1]));
  ok('and cover probability never rises as the number worsens (monotone distribution)', covers.every((c, i) => i === 0 || c <= covers[i - 1] + 1e-9), covers);
  ok('bettable-to is the worst line still at +1 pp', o.price.bettable_to && o.price.curve.filter((r) => r.edge >= 0.01).every((r) => r.line >= o.price.bettable_to.line));
  ok('pass-beyond is the next half point beyond it', o.price.pass_beyond.line === o.price.bettable_to.line - 0.5);
  ok('the price floor at the current line keeps the edge at +1 pp', (() => { const f = o.price.price_floor_at_current_line; const be = T.odds.breakEven(f); return Math.abs((cur.cover - be) - 0.01) < 0.003; })());
  ok('the half-point value names the key number', o.key_numbers.half_point === null || /land exactly on/.test(o.key_numbers.half_point.text));
  const thru = T.build(bundle({ market: { quotes: [q('bookA', -3.5, 20)], open_home_line: -2.5 } }));
  ok('a move through 3 is flagged with its measured frequency', thru.key_numbers.warnings.some((w) => w.key === 3 && /9\.3%/.test(w.text)), thru.key_numbers.warnings);
}

section('5. the status: first rule that holds, fail closed');
{
  const S = (o) => o.status.key;
  ok('no quote: NO MARKET', S(T.build(bundle({ market: { quotes: [] } }))) === 'NO_MARKET');
  const stale = T.build(bundle({ market: { quotes: [q('bookA', -1, 400), q('bookB', -1, 500)] } }));
  ok('only stale quotes: NO MARKET, never actionable', S(stale) === 'NO_MARKET' && stale.market.stale);
  ok('and nothing is priced off a stale quote', !stale.price.available && /stale/.test(stale.price.reason));
  ok('aligned: PASS', S(T.build(bundle({ market: { quotes: [q('bookA', -7.5, 10)] } }))) === 'PASS');
  ok('a 7+ unverified gap: INVESTIGATE', S(T.build(bundle({ market: { quotes: [q('bookA', 2, 10)] } }))) === 'INVESTIGATE');
  ok('a 21+ unverified gap: DATA FAULT', S(T.build(bundle({ market: { quotes: [q('bookA', 16, 10)] } }))) === 'DATA_FAULT');
  const ver = T.build(bundle({ market: { quotes: [q('bookA', 2, 10)] }, integrity: { status: 'VERIFIED_MAJOR_DISAGREEMENT', verification: 'COMPLETE', checks: [] } }));
  ok('a verified 7+ gap is not INVESTIGATE, and carries the badge', S(ver) !== 'INVESTIGATE' && ver.status.verified_badge && ver.disagreement.verified);
  ok('verified is still not a bet', S(ver) !== 'BET');
  const mf = T.build(bundle({ market: { quotes: [q('bookA', 2, 10)] }, integrity: { status: 'MARKET_FAULT', checks: [{ group: 'MARKET', status: 'FAIL', detail: 'only 1 book captured (3 required)' }] } }));
  ok('a 7+ gap on a market too thin to verify is INVESTIGATE, and says why', S(mf) === 'INVESTIGATE' && /only 1 book/.test(mf.status.reason), mf.status.reason);
  ok('a research-sized gap at a live price: RESEARCH', S(T.build(bundle())) === 'RESEARCH');
  const qbw = bundle(); qbw.qb = { home: { player: 'A', status: 'COMPETITION', confirmed: false, contested: true }, away: qbw.qb.away };
  ok('a contested QB job on a research gap: WAIT', S(T.build(qbw)) === 'WAIT');
  const unpriced = T.build(bundle({ market: { quotes: [{ book: 'cfbd consensus', source: 'cfbd', home_line: -4, observed_at: new Date(NOW - 600000).toISOString() }] } }));
  ok('a research gap whose only fresh quote has no odds: WAIT for a priced quote', S(unpriced) === 'WAIT' && /no odds/.test(unpriced.status.reason), unpriced.status.reason);
  ok('low confidence: PASS', S(T.build(bundle({ model: Object.assign({}, bundle().model, { football_confidence: 20 }) }))) === 'PASS');
  ok('low reliability: PASS', S(T.build(bundle({ reliability: { score: 40 } }))) === 'PASS');
  ok('BET only when the decision engine says BET', S(T.build(bundle({ decision: { status: 'BET', reason_codes: ['BET_VALIDATED'], reasons: ['ok'] } }))) === 'BET'
    && S(T.build(bundle({ decision: { status: 'LEAN', reason_codes: [], reasons: [] } }))) !== 'BET');
  ok('a BET on a stale market is impossible', S(T.build(bundle({ decision: { status: 'BET', reason_codes: [], reasons: [] }, market: { quotes: [q('bookA', -1, 900)] } }))) === 'NO_MARKET');
  const r = T.build(bundle());
  ok('WHY NOT BET lists the engine’s reason first', r.status.why_not_bet[0] && /Decision engine/.test(r.status.why_not_bet[0].text));
  ok('and the margin for model error', r.status.why_not_bet.some((x) => x.code === 'MARGIN_FOR_ERROR'));
  ok('every status is one of seven words', T.STATUS_KEYS.length === 7 && T.STATUS_KEYS.indexOf(r.status.key) >= 0);
}

section('5b. is the market telling us something? judged by check group, not words');
{
  const b = bundle({ market: { quotes: [q('bookA', 2, 10)], open_home_line: -3 }, integrity: { status: 'INVESTIGATE', checks: [
    { group: 'MODEL', id: 'calibration', status: 'FAIL', detail: 'football-only calibration (slope 0.96, home field 2.6) puts the gap at 6.6' },
    { group: 'MARKET', id: 'book_count', status: 'FAIL', detail: '1 book behind the consensus' } ] } });
  const o = T.build(b);
  ok('a calibration failure that mentions home field is not a mapping explanation', !o.market_check.checks.some((c) => c.area === 'Mapping' && c.status === 'EXPLANATION'));
  const m = T.build(bundle({ market: { quotes: [q('bookA', 2, 10)] }, integrity: { status: 'DATA_FAULT', checks: [{ group: 'GAME', id: 'orientation', status: 'FAIL', detail: 'the line only agrees once negated' }] } }));
  ok('a GAME-group failure is', m.market_check.checks.some((c) => c.area === 'Mapping' && c.status === 'EXPLANATION'));
  const z = T.build(bundle({ terms: [{ key: 'rating', points: 5.3 }, { key: 'hfa', points: 2.2 }, { key: 'qb', points: 0 }] }));
  ok('a zero term is listed as not priced, never drawn as a reason', z.why.unpriced.length === 1 && !z.why.rows.some((r) => r.key === 'qb') && z.why.reconciles);
}

section('6. research interest is not edge size');
{
  const clean = T.build(bundle());
  const garbage = T.build(bundle({ market: { quotes: [q('bookA', 5, 10)] }, reliability: { score: 45 }, model: Object.assign({}, bundle().model, { football_confidence: 40 }) }));
  ok('a big gap on bad data ranks below a clean moderate gap', garbage.disagreement.points > clean.disagreement.points && garbage.fields.research_interest.score < clean.fields.research_interest.score,
    [garbage.fields.research_interest.score, clean.fields.research_interest.score]);
  const nm = T.build(bundle({ market: { quotes: [] } }));
  ok('NO MARKET is capped at 10', nm.fields.research_interest.score <= 10);
  const ver = T.build(bundle({ market: { quotes: [q('bookA', 2, 10)] }, integrity: { status: 'VERIFIED_MAJOR_DISAGREEMENT', checks: [] } }));
  ok('the queue puts a verified disagreement first', T.queue([clean, garbage, ver])[0] === ver);
}

section('7. model agreement from dispersion, not side counts');
{
  const tight = T.build(bundle({ models: [-5.2, -5.4, -5.7, -5.1].map((m, i) => ({ key: 'm' + i, label: 'm' + i, home_margin: -m, independent: true })) }));
  const wide = T.build(bundle({ models: [-2, -4, -7, -9].map((m, i) => ({ key: 'm' + i, label: 'm' + i, home_margin: -m, independent: true })) }));
  ok('a tight cluster is HIGH agreement', tight.consensus.agreement.tier === 'HIGH', tight.consensus.sd);
  ok('a spread is LOW agreement', wide.consensus.agreement.tier === 'LOW', wide.consensus.sd);
  ok('the score follows the SD', tight.consensus.agreement.score > wide.consensus.agreement.score);
}

section('8. what would have to be wrong, and sensitivity');
{
  const o = T.build(bundle());
  const sds = o.reconcile.rows.filter((r) => r.sds_needed != null).map((r) => r.sds_needed);
  ok('reconciliations are ranked by SDs needed (most plausible first)', sds.every((x, i) => i === 0 || x >= sds[i - 1]), sds);
  ok('ordinary model error is a separate baseline, not a competing row', o.reconcile.baseline && !o.reconcile.rows.some((r) => r.key === 'model_error'));
  ok('a priced term can be named as the thing that is not real', o.reconcile.rows.some((r) => r.key === 'term_matchup'));
  ok('the reconciliation says they are not equally likely', /not equally likely/.test(o.reconcile.note));
  const qbo = o.sensitivity.rows.find((r) => r.key === 'qb_out_home');
  ok('QB OUT moves the fair by the measured level effect', qbo && Math.abs(qbo.delta - (0.857 - 0) * -1.16) < 0.006, qbo);
  ok('wind moves no spread (it widens the range)', o.sensitivity.rows.filter((r) => /^wind_/.test(r.key)).every((r) => r.delta === 0 && r.kind === 'variance'));
}

section('9. edge decay');
{
  const b = bundle({ checkpoints: [{ at: '2026-09-28T10:00:00Z', home_margin: 7.5 }],
    market: { quotes: [q('bookA', -3, 60 * 70), q('bookA', -6.5, 30)], open_home_line: -3 } });
  const o = T.build(b);
  ok('initial 4.5 → current 1.0: most of the value is gone', o.edge_decay.verdict === 'MOST_GONE' && Math.abs(o.edge_decay.lost_to_market - 3.5) < 1e-6, o.edge_decay);
  ok('the timeline records the market moving toward EdgeDesk', o.timeline.events.some((e) => e.kind === 'MARKET_TOWARD'));
}

section('10. the research assistant: structured data only, UNKNOWN otherwise, status read-only');
{
  const o = T.build(bundle());
  const a = T.ask('Why are you 3 points off the market?', o);
  ok('it answers from the object', a.text.indexOf(o.edgedesk.fair_text) >= 0 && a.facts.length > 0);
  ok('every fact carries a source', a.facts.every((f) => f.source && f.confidence));
  ok('it returns the status it read, unchanged', a.status.key === o.status.key);
  ['Where is the sharp money?', 'What percent of bets are on Home U?'].forEach((qq) => ok('it will not invent betting splits: ' + qq, T.ask(qq, o).unknown === true && /UNKNOWN/.test(T.ask(qq, o).text)));
  ok('it will not invent scheme or motivation', T.ask('Is this a trap game?', o).unknown === true);
  const noInj = T.build(bundle({ qb: null, availability: null }));
  ok('it will not invent injuries', /UNKNOWN|does not infer/.test(T.ask('Is anyone injured?', noInj).text));
  const nums = (T.ask('Is this price still good?', o).text.match(/-?\d+(\.\d+)?/g) || []).map(Number);
  const blob = JSON.stringify(o);
  ok('every number in the price answer is in the research object', nums.every((n) => blob.indexOf(String(Math.abs(n))) >= 0 || blob.indexOf(Math.abs(n).toFixed(1)) >= 0 || n === 110 || n === 1 || n === 2), nums);
  ok('slate questions work without a game', /SD/.test(T.ask('Which games have the highest model agreement?', null, [o]).text));
}

section('11. the LLM boundary reads the canonical object');
{
  const o = T.build(bundle());
  const f = X.cfbFacts(T.explainSource(o));
  ok('the boundary’s status is the page’s status', f.decision.status === o.status.label);
  ok('its deterministic text passes its own audit', X.auditExplanation(X.render(f), f).ok, X.auditExplanation(X.render(f), f).issues);
  const lie = X.auditExplanation('This is a BET on Home U -4. EdgeDesk recommends it; the QB is confirmed and it is a lock.', f);
  ok('an LLM calling it a bet is refused', !lie.ok && lie.issues.some((i) => i.code === 'BET_CLAIM_NOT_OFFICIAL'));
  const inv = T.build(bundle({ market: { quotes: [q('bookA', 2, 10)] } }));
  const fi = X.cfbFacts(T.explainSource(inv));
  ok('an INVESTIGATE game stays INVESTIGATE at the boundary', fi.decision.status === 'INVESTIGATE');
  ok('and an LLM saying PASS instead is refused', !X.auditExplanation('EdgeDesk says PASS here; uncertainty is high.', fi).ok);
  const r = await X.explain(f, () => 'Great value: this is a BET, a lock.');
  ok('explain() replaces refused text with the deterministic one, same status', r.source === 'deterministic' && r.status === o.status.label);
}

section('12. watchlist, personal books, brief, record helpers');
{
  const o = T.build(bundle());
  const e = T.watchEntry(o, { now: NOW });
  ok('a watch entry stores a clean target price', e.side === 'home' && e.target_line != null && e.target_price === -110);
  const moved = T.build(bundle({ model: Object.assign({}, bundle().model, { home_margin: 9 }), dist: normalDist(9, 15), market: { quotes: [q('bookA', -2.5, 10)], open_home_line: -3 } }));
  const d = T.watchDiff(e, moved);
  ok('the watch diff names the fair move, the market move and the target', ['FAIR', 'MARKET'].every((k) => d.some((x) => x.kind === k)) && d.some((x) => /TARGET/.test(x.kind)), d);
  const mine = T.bestForBooks(o, ['bookB']);
  ok('personal books: the best price comes only from the reader’s books', mine.home && mine.home.book === 'bookB');
  const none = T.bestForBooks(o, ['nobook']);
  ok('and a book the reader has no quote at is not claimed', none.none_available && !none.home);
  const br = T.brief([o], { week: 5 });
  ok('the brief says so when nothing is certified', /No certified bets/.test(br.headline));
  ok('the brief never uses pick language', !/\b(lock|best bet|max play|hammer)\b/i.test(JSON.stringify(br)));
  const rec = { a: { week: 4, kickoff: '2026-09-20T00:00:00Z', home: 'H', away: 'A', model_version: 'v1', home_conference: 'C', away_conference: 'C', matchup_type: 'conference',
      first: { at: '2026-09-15T00:00:00Z', home_line: -3 }, pick: { at: '2026-09-19T00:00:00Z', home_line: -6, home_win_prob: 0.66, model_version: 'v1' },
      close: { home_line: -4 }, final: { home_score: 30, away_score: 20 },
      grade: { status: 'GRADED', spread: { side: 'home', result: 'win' }, clv_pick: { spread: { pts: -1 } }, error: { model_margin_err: 4, close_margin_err: 6 } } } };
  const rows = T.recordRows(rec);
  ok('the record grades the FROZEN pregame number, not a later one', rows[0].frozen_home_line === -6 && rows[0].first_home_line === -3);
  ok('process and outcome are graded apart (bad price, won)', rows[0].quadrant === 'BAD PRICE / WON');
  const sm = T.recordSummary(rows);
  ok('a record rate under 30 is flagged as too few', sm.sufficient === false && /30/.test(sm.note));
  ok('calibration withholds buckets under 30', T.calibration(rows).rows.every((x) => !x.shown));
  ok('postmortem: projection held when EdgeDesk beat the close', T.postmortem(rows[0]).class === 'PROJECTION_HELD');
}

/* ======================================================================= */
section('13. the real slate, from the committed production artifacts');
{
  const B = require('./build.js');
  /* The committed board/games are a CACHE: the hourly football build can
     refresh the slate between the terminal's build and this test, so the
     rules are held on a FRESH build from the current inputs (written to a
     temp dir, no history), and the cache is compared only with the slate it
     records it was built from. */
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-terminal-'));
  const fresh = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'build.js'), '--out', tmp], { encoding: 'utf8' });
  ok('a fresh build from the current inputs succeeds', fresh.status === 0, (fresh.stderr || fresh.stdout || '').slice(0, 300));
  const board = JSON.parse(fs.readFileSync(path.join(tmp, 'board.json'), 'utf8'));
  const games = JSON.parse(fs.readFileSync(path.join(tmp, 'games.json'), 'utf8')).games;
  const slate = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'fbs', 'slate.json'), 'utf8'));
  const gov = B.loadGovernance();
  const objs = Object.keys(games).map((k) => games[k]);
  ok('the artifacts carry the governance champion', board.champion.model_version === gov.champion);
  const bySlate = {}; slate.games.forEach((g) => { bySlate[String(g.game_id)] = g; });
  const mismatches = (list) => list.filter((o) => o.edgedesk.available && bySlate[o.game_id] && gov.champion === 'edgedesk_cfb_p4_v1.0.0'
    && Math.abs(o.edgedesk.home_margin - bySlate[o.game_id].model_home_margin) > 0.005).map((o) => o.game_id);
  ok('every research page’s fair line equals the champion slate’s', mismatches(objs).length === 0, mismatches(objs));
  const cacheBoard = JSON.parse(fs.readFileSync(path.join(__dirname, 'board.json'), 'utf8'));
  const builtFrom = ((cacheBoard.sources || []).filter((x) => x.id === 'slate')[0] || {}).updated_at || null;
  ok('the committed cache names the slate it was built from', !!builtFrom);
  if (builtFrom === slate.generated_at) {
    const cached = JSON.parse(fs.readFileSync(path.join(__dirname, 'games.json'), 'utf8')).games;
    const cm = mismatches(Object.keys(cached).map((k) => cached[k]));
    ok('and, built from this very slate, it carries the same fair lines', cm.length === 0, cm);
  }
  ok('no stale market carries an actionable status', objs.every((o) => !(o.market.stale && ['BET', 'RESEARCH', 'WAIT'].indexOf(o.status.key) >= 0)));
  ok('no BET while the policy has betting off', board.decision.bet_enabled || objs.every((o) => o.status.key !== 'BET'));
  ok('every timeline point is at or before the build and the kickoff', objs.every((o) => o.timeline.model.concat(o.timeline.market).every((p) => Date.parse(p.at) <= Date.parse(o.built_at) && Date.parse(p.at) <= Date.parse(o.kickoff))));
  ok('every shown historical rate has n >= 30', objs.every((o) => !o.historical.available || o.historical.sets.every((s) => !s.shown || s.n >= 30)));
  ok('the board has one row per research object', board.rows.length === objs.length);
  ok('board rows and research pages agree on status and fair line', board.rows.every((r) => games[r.game_id].status.key === r.status && games[r.game_id].edgedesk.fair_text === r.fair));
  ok('the default order is the research queue, not the gap', (() => { const gaps = board.rows.map((r) => r.gap || 0); return gaps.some((g, i) => i > 0 && g > gaps[i - 1]); })());
  /* the conditioned PMF reproduces the engine at the market number */
  global.window = global.window || global;
  const E1 = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));
  const P = window.EDCfbP4Params, base = (P.volatility && P.volatility.sigma_base) || P.distributions.sigma_margin;
  let checked = 0, bad = [];
  objs.filter((o) => o.edgedesk.available && o.disagreement.available).slice(0, 25).forEach((o) => {
    const d = B.v1Dist(o.edgedesk.home_margin, o.edgedesk.sigma, o.disagreement.market_margin);
    const mine = d.cover(o.disagreement.market_margin), eng = E1.dist.coverProbSpread(o.edgedesk.home_margin, o.disagreement.market_margin, o.edgedesk.sigma, base);
    checked++;
    if (!eng || Math.abs(mine.win - eng.win) > 1e-9 || Math.abs(mine.push - eng.push) > 1e-9) bad.push(o.game_id);
  });
  ok('the price curve’s distribution equals the engine’s coverProbSpread at the market number (' + checked + ' games)', checked > 0 && bad.length === 0, bad);
  ok('every price curve is monotone', objs.every((o) => !o.price.available || o.price.curve.every((r, i, a) => i === 0 || r.cover <= a[i - 1].cover + 1e-9)));
  ok('the build refuses to write when a rule breaks (check mode runs clean)', require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'build.js'), '--check'], { encoding: 'utf8' }).status === 0);
  const hist = path.join(__dirname, 'history', String(slate.season), 'snapshots.jsonl');
  if (fs.existsSync(hist)) {
    const rows = fs.readFileSync(hist, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const ids = new Set(rows.map((r) => r.snapshot_id));
    ok('the projection history is append-only rows with unique ids', ids.size === rows.length);
  }
}

/* ======================================================================= */
section('14. the page and its boundaries');
{
  const js = fs.readFileSync(path.join(ROOT, 'research', 'cfb', 'terminal.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'research', 'cfb', 'index.html'), 'utf8');
  ok('the page runs no model (no engine loaded, no projectGame)', !/projectGame|cfb_p4\/engine|cfb_v2\/engine|EDCfbP4\b/.test(js + html));
  ok('the page reads the cached research objects', /football\/cfb_terminal\//.test(js));
  ok('the page computes no status of its own', !/status\s*=\s*['"](BET|RESEARCH|WAIT|PASS)/.test(js));
  const src = [js, html, fs.readFileSync(path.join(ROOT, 'lib', 'cfb_terminal.js'), 'utf8')].join('\n');
  ok('no gamification in the terminal (🔥, LOCK, MAX PLAY, 10/10)', !/🔥|\bLOCK\b|MAX PLAY|10\/10/.test(src));
  /* engagement never reaches a model */
  const offenders = [];
  (function walk(d) {
    fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!/node_modules|\.git|\.cache/.test(p)) walk(p); return; }
      if (!/\.(js|py|ts)$/.test(e.name)) return;
      const rel = path.relative(ROOT, p);
      if (rel === 'research/cfb/terminal.js' || rel === 'football/cfb_terminal/analytics_sql.test.js' || rel === 'football/cfb_terminal/tests.js') return;
      if (/cfb_terminal_events|cfb_terminal_track/.test(fs.readFileSync(p, 'utf8'))) offenders.push(rel);
    });
  })(path.join(ROOT, 'football'));
  ['lib', 'tools'].forEach((d) => { /* scanned below with the same rule */ });
  ok('no football/ build reads the analytics table', offenders.length === 0, offenders);
  const libs = ['lib', 'tools'].map((d) => path.join(ROOT, d));
  const off2 = [];
  libs.forEach(function walk(d) {
    fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) return walk(p);
      if (/\.(js|py)$/.test(e.name) && /cfb_terminal_events|cfb_terminal_track/.test(fs.readFileSync(p, 'utf8'))) off2.push(path.relative(ROOT, p));
    });
  });
  ok('nor any lib/ or tools/ code', off2.length === 0, off2);
  const app = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
  ok('the terminal card links every CFB game to its research page', /function fbTermLink\(gid\)/.test(app) && /fbTermLink\(g\.game_id\)/.test(app));
  ok('the explanation guard knows the seven canonical words', T.STATUS_KEYS.every((k) => X.render && fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_cfb_explain.js'), 'utf8').indexOf("'" + T.STATUS[k].label + "'") >= 0));
}

console.log('\n' + (fail ? 'FAIL' : 'ALL GREEN') + ' ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
