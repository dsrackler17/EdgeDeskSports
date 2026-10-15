#!/usr/bin/env node
/* ===========================================================================
   THE MULTI-SPORT RESEARCH DESK — unit and contract tests.

   EDPROJ (lib/edgedesk_projections.js), EDMKT (lib/edgedesk_market_compare.js)
   and EDMULTI (lib/edgedesk_multisport.js) against the committed 2026-10-15
   fixture (tools/intelligence/fixtures/quant_oct15_2026.json — the artifacts as
   committed at 13:00Z) and the committed artifacts in the working tree.

   A quote this suite constructs is a TEST INPUT to the comparison logic
   (labelled as such); no assertion here stands in for a production result.

   Run: node tools/intelligence/multisport.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..', '..');
globalThis.EDFAIR = require(path.join(ROOT, 'lib', 'edgedesk_fairodds.js'));
const P = require(path.join(ROOT, 'lib', 'edgedesk_projections.js'));
const M = require(path.join(ROOT, 'lib', 'edgedesk_market_compare.js'));
const X = require(path.join(ROOT, 'lib', 'edgedesk_multisport.js'));
const AG = require(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_agents.js'));
const NFLB = require(path.join(ROOT, 'tools', 'football', 'build_nfl_slate.js'));
const BP = require(path.join(ROOT, 'engine', 'build_projections.js'));
const FX = require(path.join(__dirname, 'fixtures', 'quant_oct15_2026.json'));

let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) { pass++; return; } fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 700) : '')); }
const near = (a, b, e) => a != null && b != null && Math.abs(a - b) <= (e || 1e-6);
const clone = (o) => JSON.parse(JSON.stringify(o));
const NOW = Date.parse(FX.replay_at); /* 2026-10-15T13:00Z, 8:00 AM CDT */
const TZ = 'America/Chicago';
const A = () => clone(FX.artifacts);
const prep0 = X.prepare({ artifacts: A(), question: "What's the best researched opportunity tonight?", now: NOW, timezone: TZ });
const pj = (pred) => prep0.snapshot.projections.find(pred);
const VGK = pj((p) => p.sport === 'nhl' && p.home.abbr === 'VGK');
const SEA = pj((p) => p.event_id === '2026_06_SEA_DEN');
/* a TEST INPUT: one sportsbook quote for one projection's market */
function quote(p, o) {
  o = o || {};
  return Object.assign({ kind: 'LIVE_SPORTSBOOK_QUOTE', book: 'fanduel', captured_at: new Date(NOW - 2 * 60000).toISOString(), source: 'TEST INPUT',
    event: { sport: p.sport, home: p.home.name, away: p.away.name, start_utc: p.start_utc } }, o, { market: Object.assign({ kind: 'moneyline', side: 'home', line: null }, o.market || {}) });
}

/* ═══ 1. MULTI-SPORT EVENT DISCOVERY ═══════════════════════════════════════ */
{
  const d = prep0.discovery.by_sport;
  ok('DISCOVERY: NHL 11, NFL 1, CFB 3, NBA 2, soccer 18, MLB 2 events in the Chicago day', d.nhl.discovered === 11 && d.nfl.discovered === 1 && d.cfb.discovered === 3 && d.nba.discovered === 2 && d.soccer.discovered === 18 && d.mlb.discovered === 2, Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.discovered])));
  ok('DISCOVERY: the schedule, not the prices, decides what exists (every event comes from the scoreboard snapshot or an engine slate)', prep0.discovery.events.every((e) => /today\/slate\.json|slate\.json/.test(e.schedule_source)));
  ok('DISCOVERY: a game that has started is excluded and says why', (() => { const p = X.prepare({ artifacts: A(), question: 'tonight', now: Date.parse('2026-10-15T23:30:00Z'), timezone: TZ }); return p.discovery.by_sport.nhl.discovered < 11; })());
  ok('DISCOVERY: 15 projections in the window, none read from a price', prep0.snapshot.count === 15 && prep0.snapshot.projections.every((p) => P.isIndependent(p)));
}

/* ═══ 2. CORRECT SPORT-MODEL ROUTING ═══════════════════════════════════════ */
{
  const art = (s) => prep0.snapshot.projections.filter((p) => p.sport === s).map((p) => p.model.artifact);
  ok('ROUTING: NHL from hockey/slate.json (edgedesk_nhl_v1), NFL from football/nfl/slate.json, CFB from football/fbs/slate.json', art('nhl').every((a) => a === 'hockey/slate.json') && art('nfl').every((a) => a === 'football/nfl/slate.json') && art('cfb').every((a) => a === 'football/fbs/slate.json') && VGK.model.id === 'edgedesk_nhl_v1:xg_core');
  /* a WNBA game in the lab slate is read by the lab adapter, never by the NBA engine (TEST INPUT: one lab game) */
  const a2 = A();
  a2['basketball/slate.json'].leagues.wnba.games = [{ event_key: 'WNBA|1', game_id: 'w1', start_utc: '2026-10-15T23:00:00Z', date: '2026-10-15', neutral: false, home: 'Las Vegas Aces', away: 'Seattle Storm', home_id: 'lva', away_id: 'sea',
    prices: { moneyline: { home: 0.62, away: 0.38, fair_home: -163, fair_away: 163, status: 'PROVISIONAL' }, spread: { projected_margin: 3.1, fair_home_line: -3, lines: { '-3': { home_cover: 0.52, push: 0.03, away_cover: 0.45 } }, status: 'OUTCOME_VALIDATED' }, total: { projected: 162, fair_line: 162, lines: { '162': { over: 0.48, push: 0.03, under: 0.49 } }, status: 'OUTCOME_VALIDATED' } },
    inputs: { back_to_back: { home: false, away: false }, games_this_season: { home: 40, away: 40 } }, data_quality: { early_season: false }, invalidators: [] }];
  const b2 = P.buildAll(a2, { now: NOW });
  const w = b2.projections.find((p) => p.sport === 'wnba');
  ok('ROUTING: a WNBA game goes to the lab basketball adapter and the WNBA validation row', w && w.model.artifact === 'basketball/slate.json' && /edgedesk_bb_points_v1/.test(w.model.id) && w.validation.markets.moneyline.state === 'EXPERIMENTAL', w && [w.model, w.validation.markets.moneyline.state]);
  ok('ROUTING: soccer was removed from the platform (2026-10-15): every soccer event on the schedule is MODEL UNAVAILABLE with that reason, and no soccer projection is built', prep0.discovery.events.filter((e) => e.sport === 'soccer' && !e.excluded).length > 0 && prep0.discovery.events.filter((e) => e.sport === 'soccer' && !e.excluded).every((e) => e.research.outcome === 'MODEL_UNAVAILABLE' && /removed from the platform/.test(e.research.reasons[0])) && !prep0.snapshot.projections.some((p) => p.sport === 'soccer'));
  ok('ROUTING: an NBA preseason game is MODEL UNAVAILABLE, named as preseason, never priced by the regular-season engine', prep0.discovery.events.filter((e) => e.sport === 'nba').every((e) => e.research.outcome === 'MODEL_UNAVAILABLE' && /preseason/.test(e.research.reasons[0])));
  ok('ROUTING: MLB, UFC, college baseball, tennis and golf have no adapter and say why', ['mlb', 'mma', 'college_baseball', 'tennis', 'golf'].every((s) => !P.SPORTS[s].adapter && P.SPORTS[s].unsupported.length));
}

/* ═══ 3. EVENTS WITH NO PRICES / 12. QUOTA EXHAUSTION ══════════════════════ */
{
  const r = X.complete(prep0, { quotes: [], now: NOW + 1000 });
  ok('NO PRICES: research still ranks every sport with a model (NHL first)', r.research_ranking.ranked.length >= 13 && r.sections.best_research.sport === 'nhl');
  ok('NO PRICES: every market reads NO CURRENT ODDS, never a hypothetical price', r.comparison.rows.every((x) => x.outcome === 'NO_CURRENT_ODDS' && !x.quote && !x.math), r.comparison.counts);
  const off = X.complete(prep0, { quotes: M.quotesFromScoreboard(FX.artifacts['today/slate.json'], (e) => P.SCHEDULE_CODE[e.sport]), odds_disabled: true, now: NOW + 1000 });
  ok('QUOTA / ODDS OFF: with prices handed in but the odds integrations disabled, none is read', off.odds.disabled && off.comparison.quotes_in === 0 && off.comparison.rows.every((x) => x.outcome === 'NO_CURRENT_ODDS'));
  ok('QUOTA / ODDS OFF: the research is identical to the odds-on run (the same frozen snapshot)', off.order.snapshot_hash === r.order.snapshot_hash && off.sections.best_research.projection_id === r.sections.best_research.projection_id);
}

/* ═══ 4. PRICES WITH NO INDEPENDENT MODEL ══════════════════════════════════ */
{
  const qs = M.quotesFromScoreboard(FX.artifacts['today/slate.json'], (e) => P.SCHEDULE_CODE[e.sport]);
  const mlbQuotes = qs.filter((q) => q.event.sport === 'mlb');
  const r = X.complete(prep0, { quotes: qs, now: NOW + 1000 });
  ok('PRICES, NO MODEL: MLB has scoreboard prices on file', mlbQuotes.length > 0, mlbQuotes.length);
  ok('PRICES, NO MODEL: …and no MLB market is compared, no EV is computed, no number is invented', !r.comparison.rows.some((x) => x.sport === 'mlb'));
  ok('PRICES, NO MODEL: the coverage says MLB has prices but no projection', r.coverage.find((c) => c.sport === 'mlb').blockers.some((b) => /no per-game MLB projection/.test(b)));
}

/* ═══ 5. STALE SPORTSBOOK QUOTES ═══════════════════════════════════════════ */
{
  const qs = M.quotesFromScoreboard(FX.artifacts['today/slate.json'], (e) => P.SCHEDULE_CODE[e.sport]);
  ok('STALE: a scoreboard line is a CAPTURED quote, never LIVE', qs.every((q) => q.kind === 'CAPTURED_SPORTSBOOK_QUOTE'));
  const r = X.complete(prep0, { quotes: qs, now: NOW + 1000 });
  ok('STALE: captured at 11:20Z and compared at 13:00Z — STALE PRICE, never a current recommendation', r.comparison.counts.STALE_PRICE > 0 && !r.comparison.rows.some((x) => x.quote && x.quote.age_min > 60 && x.outcome !== 'STALE_PRICE'), r.comparison.counts);
  const lv = M.normalizeQuote({ kind: 'LIVE_SPORTSBOOK_QUOTE', american: -110, captured_at: new Date(NOW - 30 * 60000).toISOString() }, NOW);
  ok('STALE: a "live" read 30 minutes old is downgraded to a captured quote', lv.kind === 'CAPTURED_SPORTSBOOK_QUOTE');
  const untimed = M.compareMarket(VGK, { kind: 'moneyline', side: 'home', line: null }, [M.normalizeQuote(quote(VGK, { american: -150, captured_at: null }), NOW)], { now: NOW });
  ok('STALE: an untimed quote is never current', untimed.outcome === 'STALE_PRICE' && /no capture time/.test(untimed.reasons[0]), untimed.reasons);
  const late = M.compareMarket(VGK, { kind: 'moneyline', side: 'home', line: null }, [M.normalizeQuote(quote(VGK, { american: -150, captured_at: new Date(Date.parse(VGK.start_utc) - 60000).toISOString() }), Date.parse(VGK.start_utc))], { now: Date.parse(VGK.start_utc) });
  ok('STALE: at the start (inside the kickoff guard) a fresh-looking quote is not actionable', late.outcome === 'STALE_PRICE' && /started|guard/.test(late.reasons[0]), late.reasons);
}

/* ═══ 6. MISSING LINEUPS / 13. POSITIVE EV / 14. NO-VIG / 15. MAX PRICE ═════ */
{
  const q = M.normalizeQuote(quote(VGK, { american: -150, other_side_american: 130 }), NOW);
  const r = M.compareMarket(VGK, { kind: 'moneyline', side: 'home', line: null }, [q], { now: NOW, n_compared: 1 });
  const p = VGK.outcome.p_home, dec = 1 + 100 / 150;
  ok('EV: the point-estimate EV is p·(D−1) − (1−p) exactly, from EDFAIR', r.math && r.math.exact_arithmetic && near(r.math.ev_per_dollar, p * (dec - 1) - (1 - p), 1e-6), r.math);
  ok('EV: break-even is 1/D', near(r.math.break_even_probability, 1 / dec, 1e-6));
  const nv = EDFAIR.noVig([{ american: -150 }, { american: 130 }]);
  const ref = (r.market_reference || []).find((x) => x.kind === 'SHARP_MARKET_REFERENCE');
  ok('NO-VIG: the two sides de-vigged equal EDFAIR.noVig (multiplicative)', ref && near(ref.probability, Number(nv.probabilities[0]), 1e-4), [ref, nv.probabilities]);
  ok('NO-VIG: the market reference is labelled market-derived and never sits in the model slot', /market-derived/.test(ref.label) && r.model.source === 'INDEPENDENT_MODEL_PROJECTION' && r.model.p_win === p);
  ok('LINEUPS: the goalies are unconfirmed, so a price that clears the bar is a CONDITIONAL EDGE, not verified', r.outcome === 'CONDITIONAL_EDGE' && r.gates.some((g) => g.gate === 'LINEUP_CONFIRMED' && !g.ok) && /lineup confirmed/i.test(r.reasons.join(' ')), [r.outcome, r.reasons]);
  ok('LINEUPS: …and the other open gates are named: no closing-market validation, a single book, no audit', ['MODEL_MARKET_VALIDATED', 'BOOKS_CONFIRM', 'ADVERSARIAL_AUDIT'].every((g) => r.gates.some((x) => x.gate === g && !x.ok)), r.gates);
  /* the maximum acceptable price clears the EDGE BAR (the bar the classifier uses) on the conservative probability; one tick worse does not */
  const mx = r.math.max_acceptable_american, pc = r.math.conservative_probability;
  const evAt = (am) => { const d = am > 0 ? 1 + am / 100 : 1 + 100 / -am; return pc * (d - 1) - (1 - pc); };
  ok('MAX PRICE: EV at the maximum acceptable price clears the 2% edge bar on the conservative probability', mx != null && evAt(mx) >= 0.02 - 1e-9, [mx, evAt(mx)]);
  ok('MAX PRICE: one tick worse does not', evAt(mx - 1) < 0.02 + 1e-9 || mx - 1 === -100, [mx - 1, evAt(mx - 1)]);
  const atMax = M.compareMarket(VGK, { kind: 'moneyline', side: 'home', line: null }, [M.normalizeQuote(quote(VGK, { american: mx }), NOW)], { now: NOW, n_compared: 1 });
  const pastMax = M.compareMarket(VGK, { kind: 'moneyline', side: 'home', line: null }, [M.normalizeQuote(quote(VGK, { american: mx - 1 }), NOW)], { now: NOW, n_compared: 1 });
  ok('MAX PRICE: a quote AT the stated maximum is classified CONDITIONAL EDGE, one tick worse MARKET WATCH (one bar, not two)', atMax.outcome === 'CONDITIONAL_EDGE' && pastMax.outcome === 'MARKET_WATCH', [atMax.outcome, pastMax.outcome, mx]);
  const worse = M.compareMarket(VGK, { kind: 'moneyline', side: 'home', line: null }, [M.normalizeQuote(quote(VGK, { american: -230 }), NOW)], { now: NOW, n_compared: 1 });
  ok('EV: a price worse than the fair is NO VERIFIED EDGE', worse.outcome === 'NO_VERIFIED_EDGE' && worse.math.ev_per_dollar < 0, [worse.outcome, worse.math && worse.math.ev_per_dollar]);
  const thin = M.compareMarket(VGK, { kind: 'moneyline', side: 'home', line: null }, [M.normalizeQuote(quote(VGK, { american: -190 }), NOW)], { now: NOW, n_compared: 40 });
  ok('EV: positive at the point estimate but not after uncertainty is MARKET WATCH, with the price that would clear', thin.outcome === 'MARKET_WATCH' && thin.math.ev_per_dollar > 0 && thin.math.conservative_ev_per_dollar < 0.02 && /clears at/.test(thin.reasons[0]), [thin.outcome, thin.math, thin.reasons]);
  const huge = M.compareMarket(VGK, { kind: 'moneyline', side: 'home', line: null }, [M.normalizeQuote(quote(VGK, { american: 200 }), NOW)], { now: NOW });
  ok('EV: an EV past the sanity ceiling is a DATA CHECK, never an edge', huge.outcome === 'MARKET_WATCH' && /DATA CHECK/.test(huge.reasons[0]), huge.reasons);
  const line = M.compareMarket(VGK, { kind: 'spread', side: 'home', line: -2.75 }, [M.normalizeQuote(quote(VGK, { american: 250, market: { kind: 'spread', side: 'home', line: -2.75 } }), NOW)], { now: NOW });
  const alt = M.compareMarket(VGK, { kind: 'spread', side: 'home', line: -3.5 }, [M.normalizeQuote(quote(VGK, { american: 600, market: { kind: 'spread', side: 'home', line: -3.5 } }), NOW)], { now: NOW });
  const unscored = M.compareMarket(VGK, { kind: 'spread', side: 'home', line: -1 }, [M.normalizeQuote(quote(VGK, { american: 110, market: { kind: 'spread', side: 'home', line: -1 } }), NOW)], { now: NOW });
  ok('EV: a line the engine marks NOT_SCORED is research only', unscored.outcome === 'INSUFFICIENT_MODEL_RELIABILITY', [unscored.outcome, unscored.reasons]);
  ok('EV: an alternate puck line the engine itself calls PROVISIONAL is research only, never priced on the main line\'s validation', alt.outcome === 'INSUFFICIENT_MODEL_RELIABILITY' && /provisional|experimental/i.test(alt.reasons[0]), [alt.outcome, alt.reasons]);
  const main = M.compareMarket(VGK, { kind: 'spread', side: 'home', line: -1.5 }, [M.normalizeQuote(quote(VGK, { american: 150, market: { kind: 'spread', side: 'home', line: -1.5 } }), NOW)], { now: NOW, n_compared: 1 });
  ok('EV: the main puck line (outcome-validated) is compared', main.outcome !== 'INSUFFICIENT_MODEL_RELIABILITY' && main.math, [main.outcome, main.reasons]);
  ok('EV: a line the model\'s distribution does not publish is not priced (no number is manufactured)', line.outcome === 'INSUFFICIENT_MODEL_RELIABILITY' && /does not cover/.test(line.reasons[0]), line.reasons);
  const tot = M.compareMarket(VGK, { kind: 'total', side: 'over', line: 6.5 }, [M.normalizeQuote(quote(VGK, { american: 110, market: { kind: 'total', side: 'over', line: 6.5 } }), NOW)], { now: NOW });
  ok('EV: an NHL total (PROVISIONAL, calibration slope 0.78) is research only — no EV is quoted', tot.outcome === 'INSUFFICIENT_MODEL_RELIABILITY' && /experimental|provisional|research only/i.test(tot.reasons[0]), tot.reasons);
}

/* ═══ 7. CONFLICTING STARTERS / 8. INJURIES ══════════════════════════════ */
{
  ok('STARTERS: SEA @ DEN is invalidated: the projection assumed Drew Lock, the depth chart lists Sam Darnold', SEA.integrity.invalidated && /Drew Lock/.test(SEA.integrity.conflicts[0].detail) && /Sam Darnold/.test(SEA.integrity.conflicts[0].detail) && SEA.integrity.conflicts[0].corroborated_by_last_game === true);
  ok('STARTERS: both sources keep their provenance and time, and neither is called official', SEA.integrity.conflicts[0].assumed.source === 'nflverse games.csv' && SEA.integrity.conflicts[0].current.published_at === '2026-10-14T12:51:31Z' && SEA.integrity.conflicts[0].assumed.authority === 'THIRD_PARTY' && SEA.integrity.conflicts[0].current.authority === 'THIRD_PARTY');
  const r = M.compareMarket(SEA, { kind: 'moneyline', side: 'home', line: null }, [M.normalizeQuote(quote(SEA, { american: -110 }), NOW)], { now: NOW });
  ok('STARTERS: even a fresh price is refused on the invalidated projection', r.outcome === 'INSUFFICIENT_MODEL_RELIABILITY' && /invalidated/.test(r.reasons[0]), r.reasons);
  const rr = X.complete(prep0, { quotes: [], now: NOW + 1000 });
  ok('STARTERS: the invalidated projection is held back from the research ranking, named in the answer', !rr.research_ranking.ranked.some((x) => x.projection_id === SEA.projection_id) && rr.sections.held_back.some((x) => x.projection_id === SEA.projection_id) && /Held back — NFL Seattle Seahawks @ Denver Broncos: projection invalidated/.test(rr.answer));
  const st = { teams: { sea: FX.artifacts['football/starters/nfl_2026.json'].teams.sea } };
  const g = { home_team: 'DEN', away_team: 'SEA', week: 6, away_qb_name: 'Drew Lock', away_qb_id: '00-0035704' };
  ok('STARTERS (builder): corroborated depth chart → RECONCILED, the engine re-runs on Darnold', NFLB.reconcileQb(g, 'away', st).status === 'RECONCILED' && NFLB.reconcileQb(g, 'away', st).depth_chart.id === '00-0034869');
  ok('STARTERS (builder): the same names → AGREES', NFLB.reconcileQb(Object.assign({}, g, { away_qb_id: '00-0034869', away_qb_name: 'Sam Darnold' }), 'away', st).status === 'AGREES');
  const unc = clone(st); unc.teams.sea.history = unc.teams.sea.history.map((h) => Object.assign({}, h, { starter: Object.assign({}, h.starter, { player_id: '00-0035704', player_name: 'D.Lock' }) }));
  ok('STARTERS (builder): uncorroborated → CONFLICT, priced on the feed and flagged, never resolved silently', NFLB.reconcileQb(g, 'away', unc).status === 'CONFLICT' && /unresolved/.test(NFLB.reconcileQb(g, 'away', unc).why));
  ok('STARTERS (builder): no feed starter → NO_FEED_STARTER (the documented carried-level behaviour)', NFLB.reconcileQb(Object.assign({}, g, { away_qb_id: null, away_qb_name: null }), 'away', st).status === 'NO_FEED_STARTER');
  ok('STARTERS (builder): an injury-report substitution is left alone', NFLB.reconcileQb(Object.assign({}, g, { away_qb_reconciled: { replacement_id: 'x' } }), 'away', st).status === 'INJURY_REPORT');
  /* injuries: the engine's own re-run with the quarterback out, and the NBA engine's sits scenarios */
  const rs = X.researchFor(SEA);
  ok('INJURIES: what could make it wrong carries the engine\'s own quarterback-out re-run', rs.could_be_wrong.some((w) => /quarterback replaced by the club's carried level: home line moves/.test(w)), rs.could_be_wrong);
  const nb = P.buildAll(A(), { now: NOW }).projections.find((p) => p.sport === 'nba');
  ok('INJURIES: an NBA projection carries its sits scenarios as probability deltas, and no injury report is claimed', nb && nb.sensitivity.length > 0 && nb.sensitivity.every((s) => typeof s.delta_p_home === 'number') && /no injury report/.test(nb.availability.injuries), nb && nb.sensitivity);
  ok('INJURIES: an NBA projection with no confirmed lineup is RESEARCH CONDITIONAL', nb && nb.research.outcome === 'RESEARCH_CONDITIONAL' && /availability/.test(nb.research.reasons.join(' ')), nb && nb.research);
}

/* ═══ 9. MODEL BUILD EXPIRATION / 11. PROVIDER OUTAGES / 10. NO-EVENT DAYS ═══ */
{
  const late = Date.parse(FX.artifacts['hockey/slate.json'].generated_at) + 9 * 3600000;
  const b = P.buildAll(A(), { now: late });
  const h = b.projections.find((p) => p.sport === 'nhl');
  ok('EXPIRED: an NHL build 9 h old (limit 8 h) is DATA INSUFFICIENT', h.freshness.state === 'EXPIRED' && h.research.outcome === 'DATA_INSUFFICIENT' && /expired/.test(h.research.reasons[0]), h.research);
  ok('EXPIRED: …and may not price', !P.pricingEligibility(h, 'moneyline').ok && /expired/i.test(P.pricingEligibility(h, 'moneyline').why));
  ok('REMOVED: no adapter reads soccer/slate.json, even where an old artifact still carries it', P.artifactsNeeded().indexOf('soccer/slate.json') < 0 && !P.buildAll(A(), { now: NOW }).projections.some((p) => p.sport === 'soccer'));
  const a2 = A(); a2['hockey/slate.json'] = null;
  const p2 = X.prepare({ artifacts: a2, artifact_errors: { 'hockey/slate.json': 'HTTP 503 from https://site.test/hockey/slate.json' }, question: 'tonight', now: NOW, timezone: TZ });
  const r2 = X.complete(p2, { quotes: [], now: NOW + 1000 });
  const nhl = r2.coverage.find((c) => c.sport === 'nhl');
  ok('OUTAGE: the NHL artifact down is a named blocker, its 11 events MODEL UNAVAILABLE, never an empty slate', nhl.events_discovered === 11 && nhl.events_researched === 0 && nhl.blockers.some((b) => /hockey\/slate\.json/.test(b)), nhl);
  ok('OUTAGE: the other sports are still researched', r2.coverage.find((c) => c.sport === 'cfb').events_researched === 3 && r2.sections.best_research);
  ok('OUTAGE: the failed source is listed as NOT READ', /hockey\/slate\.json — NOT READ \(HTTP 503/.test(r2.answer));
  const july = X.prepare({ artifacts: A(), question: 'today', now: Date.parse('2026-07-15T15:00:00Z'), timezone: TZ });
  const rj = X.complete(july, { quotes: [], now: Date.parse('2026-07-15T15:00:01Z') });
  ok('NO EVENTS: a day with nothing scheduled answers plainly, with no candidate invented', july.snapshot.count === 0 && !rj.sections.best_research && /No projection could be ranked/.test(rj.answer) && /^BEST VERIFIED OPPORTUNITY\nNone\./.test(rj.answer));
}

/* ═══ 16. RANKING CONSISTENCY ═══════════════════════════════════════════════ */
{
  const r1 = X.rankResearch(clone(prep0.research)), r2 = X.rankResearch(clone(prep0.research).reverse());
  ok('RANKING: deterministic — the same order whatever order the projections arrive in', JSON.stringify(r1.ranked.map((x) => x.projection_id)) === JSON.stringify(r2.ranked.map((x) => x.projection_id)));
  ok('RANKING: every tier-1 projection (validated primary market) ranks above every tier-2 one', r1.ranked.every((x, i) => i === 0 || x.tier >= r1.ranked[i - 1].tier));
  ok('RANKING: within a tier, by the conservative probability', r1.ranked.every((x, i) => i === 0 || x.tier !== r1.ranked[i - 1].tier || x.modeled.conservative_probability <= r1.ranked[i - 1].modeled.conservative_probability));
  ok('RANKING: the selection bar rises with the number of projections ranked', M.selectionZ(2) < M.selectionZ(20) && M.selectionZ(20) < M.selectionZ(200));
  ok('RANKING: the college game at 91.7% does not outrank validated NHL games: its moneyline is EXPERIMENTAL (tier 2)', (() => { const c = r1.ranked.find((x) => x.sport === 'cfb' && x.modeled.probability > 0.9); return c && c.tier === 2 && r1.ranked.filter((x) => x.tier === 1).every((x) => x.rank < c.rank); })());
  ok('RANKING: probability, uncertainty and validation are separate fields; there is no confidence score', r1.ranked.every((x) => x.modeled.probability != null && x.modeled.sigma && x.model_confidence.validation_state && !('confidence' in x) && !('score' in x)));
  ok('RANKING: the rules are published with the result', X.RANKING_RULES.research.length >= 4 && X.RANKING_RULES.execution.length >= 3);
}

/* ═══ 17. AUDIT RESULT SEMANTICS ════════════════════════════════════════════ */
{
  const s = AG.auditSemantics;
  const run = (a, ev, cls, r) => s(a, ev, cls, r || {});
  const okEv = { ok: true, classification: 'POTENTIAL_EDGE' };
  ok('AUDIT: completed and confirmed, verified candidate → COMPLETED / VERIFIED / ELIGIBLE', JSON.stringify(run({ status: 'CONFIRMED' }, okEv, 'VERIFIED_CANDIDATE')) === JSON.stringify({ audit_execution: 'COMPLETED', evidence_verification: 'VERIFIED', execution_eligibility: 'ELIGIBLE', note: null }));
  const u = run({ status: 'CONFIRMED' }, { ok: false, classification: 'UNVERIFIED_DATA' }, 'UNVERIFIED');
  ok('AUDIT: an audit can COMPLETE and conclude NOT VERIFIED — and that is never eligible (the "Unverified … PASS" fix)', u.audit_execution === 'COMPLETED' && u.evidence_verification === 'NOT_VERIFIED' && u.execution_eligibility === 'NOT_ELIGIBLE' && /ran to completion/.test(u.note), u);
  ok('AUDIT: no audit run → NOT RUN, and missing verification is NOT VERIFIED (never VERIFIED)', run({}, okEv, 'WATCHLIST').audit_execution === 'NOT_RUN' && run({}, okEv, 'WATCHLIST').evidence_verification === 'NOT_VERIFIED');
  ok('AUDIT: a rejected audit → REJECTED evidence, not eligible', run({ status: 'REJECTED' }, okEv, 'REJECTED').evidence_verification === 'REJECTED' && run({ status: 'REJECTED' }, okEv, 'REJECTED').execution_eligibility === 'NOT_ELIGIBLE');
  ok('AUDIT: unresolved conflicts → NOT VERIFIED even when the auditor confirmed the price', run({ status: 'CONFIRMED' }, okEv, 'RESEARCH_REQUIRED', { unresolved: [{ detail: 'x' }] }).evidence_verification === 'NOT_VERIFIED');
  const lines = AG.statusLines({ classification: 'UNVERIFIED', label: 'UNVERIFIED', final_status: 'PASS', audit_execution: 'COMPLETED', evidence_verification: 'NOT_VERIFIED', execution_eligibility: 'NOT_ELIGIBLE' }, { status: 'DOWNGRADED', rounds: 2 });
  ok('AUDIT: three separate lines, and none pairs UNVERIFIED with PASS', lines.length === 3 && /^Audit execution: COMPLETED/.test(lines[0]) && /^Evidence verification: NOT VERIFIED/.test(lines[1]) && /^Trade execution eligibility: NOT ELIGIBLE — decision: PASS/.test(lines[2]) && !lines.some((l) => /UNVERIFIED.*PASS|PASS.*UNVERIFIED/.test(l)), lines);
}

/* ═══ 18. TIME ZONES ════════════════════════════════════════════════════════ */
{
  const w = X.windowFor('tonight', NOW, TZ);
  ok('TZ: "tonight" in Chicago at 8 AM CDT runs to midnight CDT (05:00Z)', w.from === new Date(NOW).toISOString() && w.to === '2026-10-16T05:00:00.000Z', w);
  ok('TZ: the 9 PM CDT Vegas game (02:00Z on the 16th) is inside Chicago\'s tonight', prep0.discovery.events.some((e) => e.sport === 'nhl' && e.start_utc === '2026-10-16T02:00:00.000Z' && e.projection_id));
  const wNY = X.windowFor('tonight', NOW, 'America/New_York');
  ok('TZ: the same instant in New York ends an hour earlier (04:00Z)', wNY.to === '2026-10-16T04:00:00.000Z', wNY);
  const wBad = X.windowFor('tonight', NOW, 'Not/AZone');
  ok('TZ: an invalid zone falls back to New York and says so', wBad.timezone === 'America/New_York' && /no usable time zone/.test(wBad.basis));
  const dst = X.windowFor('today', Date.parse('2026-11-01T12:00:00Z'), TZ);
  ok('TZ: across the DST change (1 Nov 2026) local midnight is 06:00Z, not 05:00Z', dst.to === '2026-11-02T06:00:00.000Z', dst);
  ok('TZ: a Premier League 15:00 kick-off in October is 14:00Z (BST)', P.zonedToUtc('2026-10-17', '15:00', 'Europe/London') === '2026-10-17T14:00:00.000Z');
  ok('TZ: …and 15:00Z after the clocks go back (25 Oct)', P.zonedToUtc('2026-10-31', '15:00', 'Europe/London') === '2026-10-31T15:00:00.000Z');
  ok('TZ: a Bundesliga 20:30 kick-off is 18:30Z (CEST)', P.zonedToUtc('2026-10-16', '20:30', 'Europe/Berlin') === '2026-10-16T18:30:00.000Z');
  const tm = X.windowFor('tomorrow', NOW, TZ);
  ok('TZ: "tomorrow" is the next Chicago calendar day', tm.from === '2026-10-16T05:00:00.000Z' && tm.to === '2026-10-17T05:00:00.000Z', tm);
}

/* ═══ CONTAMINATION: THE MARKET FIELDS NEVER REACH A PROJECTION ════════════ */
{
  const base = P.buildAll(A(), { now: NOW }).projections.map((p) => p.projection_id + ':' + P.hashOf(p)).join('|');
  const scrub = A(), noise = A();
  Object.keys(P.MARKET_FIELDS).forEach((file) => {
    const mf = P.MARKET_FIELDS[file];
    [scrub, noise].forEach((a, k) => {
      const art = a[file]; if (!art) return;
      mf.top.forEach((f) => { if (k === 0) delete art[f]; else art[f] = { injected: 'a sportsbook line that must never reach a projection', american: -9999 }; });
      (art.games || []).forEach((g) => mf.game.forEach((f) => { if (k === 0) delete g[f]; else g[f] = { status: 'PRICED', quotes: [{ book: 'pinnacle', american: 999 }], fair_line: 77 }; }));
    });
  });
  const s1 = P.buildAll(scrub, { now: NOW }).projections.map((p) => p.projection_id + ':' + P.hashOf(p)).join('|');
  const s2 = P.buildAll(noise, { now: NOW }).projections.map((p) => p.projection_id + ':' + P.hashOf(p)).join('|');
  ok('CONTAMINATION: removing every market block from every artifact leaves every projection hash identical', s1 === base);
  ok('CONTAMINATION: replacing them with absurd prices leaves every projection hash identical', s2 === base);
  ok('CONTAMINATION: the NFL pricing rows (a model–consensus blend) are never read as the fair line', P.buildAll(A(), { now: NOW }).projections.filter((p) => p.sport === 'nfl').every((p) => p.fair.spread.home_line === FX.artifacts['football/nfl/slate.json'].games.find((g) => g.game_id === p.event_id).model_home_line));
  const tainted = clone(prep0.snapshot.projections[0]); tainted.model.market_inputs = ['consensus spread'];
  ok('CONTAMINATION: a projection that names a market input is not independent and may not price', !P.isIndependent(tainted) && !P.pricingEligibility(tainted, 'moneyline').ok);
  ok('CONTAMINATION: the scheduled projection build refuses to read a price file', (() => { try { BP.makeReader(ROOT).read('hockey/market/quotes.json'); return false; } catch (e) { return /refused/.test(e.message); } })());
}

/* ═══ FREEZE: NOTHING AFTER THE MARKET CAN MOVE A PROJECTION ═══════════════ */
{
  const snap = prep0.snapshot;
  ok('FREEZE: every projection is hashed (SHA-256) and the snapshot hash verifies', P.verifySnapshot(snap).ok && snap.projections.every((p) => /^[0-9a-f]{64}$/.test(p.projection_hash)));
  let threw = false; try { 'use strict'; snap.projections[0].outcome.p_home = 0.99; } catch (_) { threw = true; }
  ok('FREEZE: a frozen projection cannot be written to', threw || snap.projections[0].outcome.p_home !== 0.99);
  const r = M.compareSnapshot(snap, M.quotesFromScoreboard(FX.artifacts['today/slate.json'], (e) => P.SCHEDULE_CODE[e.sport]), { now: NOW + 1000 });
  ok('FREEZE: the snapshot hash is the same after the comparison', r.snapshot_unchanged === true && r.snapshot_hash === snap.snapshot_hash);
  const unfrozen = clone(VGK); unfrozen.frozen_at = null;
  ok('FREEZE: a projection that was never frozen cannot be compared with a price', M.compareMarket(unfrozen, { kind: 'moneyline', side: 'home', line: null }, [M.normalizeQuote(quote(VGK, { american: -150 }), NOW)], { now: NOW }).outcome === 'INSUFFICIENT_MODEL_RELIABILITY');
  const early = M.compareMarket(VGK, { kind: 'moneyline', side: 'home', line: null }, [M.normalizeQuote(quote(VGK, { american: -150 }), NOW)], { now: Date.parse(VGK.frozen_at) - 60000 });
  ok('FREEZE: a comparison stamped before the freeze is refused', early.outcome === 'INSUFFICIENT_MODEL_RELIABILITY' && /not frozen before/.test(early.reasons[0]));
  const stable = P.buildAll(A(), { now: NOW + 2 * 3600000 }).projections.find((p) => p.projection_id === VGK.projection_id);
  ok('FREEZE: the same model output two hours later keeps its hash (the ledger does not refill)', stable && P.hashOf(stable) === VGK.projection_hash);
}

/* ═══ IDENTITY ═══════════════════════════════════════════════════════════════ */
{
  const sw = M.normalizeQuote(quote(VGK, { american: -150, event: { sport: 'nhl', home: VGK.away.name, away: VGK.home.name, start_utc: VGK.start_utc } }), NOW);
  const r = M.compareMarket(VGK, { kind: 'moneyline', side: 'home', line: null }, [sw], { now: NOW });
  ok('IDENTITY: a quote with home and away swapped is not matched, and says so', r.outcome === 'NO_CURRENT_ODDS' && /swapped/.test(r.reasons[0]), r.reasons);
  const off = M.verifyIdentity(VGK, M.normalizeQuote(quote(VGK, { event: { sport: 'nhl', home: VGK.home.name, away: VGK.away.name, start_utc: new Date(Date.parse(VGK.start_utc) + 26 * 3600000).toISOString() } }), NOW));
  ok('IDENTITY: the same teams a day later are a different event', !off.verified && /start times differ/.test(off.why[0]));
  ok('IDENTITY: "Vegas Golden Knights" and "VGK" name the same club; "Vegas" alone does not match Calgary', M.sameTeam(VGK.home, 'Vegas Golden Knights') && M.sameTeam(VGK.home, 'VGK') && !M.sameTeam(VGK.away, 'Vegas Golden Knights'));
}

/* ═══ VERIFIED: ONLY WHEN EVERY GATE PASSES ════════════════════════════════ */
{
  /* TEST INPUT: a projection whose moneyline beat the close and whose goalies are confirmed, frozen before any price */
  const p0 = clone(VGK); delete p0.projection_hash; p0.frozen_at = null;
  p0.validation.markets.moneyline = Object.assign({}, p0.validation.markets.moneyline, { state: 'MARKET_VALIDATED', value_claims: true });
  p0.availability.certainty = 'CONFIRMED'; p0.uncertainty.lineup_sd = 0;
  const snap = P.freeze([p0], NOW);
  const p = snap.projections[0];
  const q2 = [M.normalizeQuote(quote(p, { american: -140, book: 'fanduel' }), NOW), M.normalizeQuote(quote(p, { american: -145, book: 'draftkings' }), NOW)];
  const audit = { audit_execution: 'COMPLETED', evidence_verification: 'VERIFIED', execution_eligibility: 'ELIGIBLE' };
  const v = M.compareMarket(p, { kind: 'moneyline', side: 'home', line: null }, q2, { now: NOW + 1000, n_compared: 1, audit });
  ok('VERIFIED: a validated model, confirmed lineup, two live books and a completed, verified audit → VERIFIED POSITIVE EV', v.outcome === 'VERIFIED_POSITIVE_EV' && v.actionable === true && v.gates.every((g) => g.ok), [v.outcome, v.gates]);
  const noAudit = M.compareMarket(p, { kind: 'moneyline', side: 'home', line: null }, q2, { now: NOW + 1000, n_compared: 1 });
  ok('VERIFIED: the same without the audit is a CONDITIONAL EDGE', noAudit.outcome === 'CONDITIONAL_EDGE' && noAudit.gates.some((g) => g.gate === 'ADVERSARIAL_AUDIT' && !g.ok));
  const notVerified = M.compareMarket(p, { kind: 'moneyline', side: 'home', line: null }, q2, { now: NOW + 1000, n_compared: 1, audit: { audit_execution: 'COMPLETED', evidence_verification: 'NOT_VERIFIED' } });
  ok('VERIFIED: an audit that completed but did not verify the evidence is not enough', notVerified.outcome === 'CONDITIONAL_EDGE');
  const captured = M.compareMarket(p, { kind: 'moneyline', side: 'home', line: null }, q2.map((q) => Object.assign({}, q, { kind: 'CAPTURED_SPORTSBOOK_QUOTE' })), { now: NOW + 1000, n_compared: 1, audit });
  ok('VERIFIED: a previously captured quote is never verified, however fresh', captured.outcome === 'CONDITIONAL_EDGE' && captured.gates.some((g) => g.gate === 'LIVE_QUOTE' && !g.ok));
  const one = M.compareMarket(p, { kind: 'moneyline', side: 'home', line: null }, q2.slice(0, 1), { now: NOW + 1000, n_compared: 1, audit });
  ok('VERIFIED: one book alone is not confirmation', one.outcome === 'CONDITIONAL_EDGE' && one.gates.some((g) => g.gate === 'BOOKS_CONFIRM' && !g.ok));
  const ref = M.compareMarket(p, { kind: 'moneyline', side: 'home', line: null }, [M.normalizeQuote(quote(p, { kind: 'CONSENSUS_REFERENCE', american: -140 }), NOW)], { now: NOW + 1000, audit });
  ok('VERIFIED: a consensus reference line is never a price', ref.outcome === 'NO_CURRENT_ODDS' && /reference/.test(ref.reasons[0]), ref.reasons);
}

/* ═══ THE ANSWER ════════════════════════════════════════════════════════════ */
{
  const r = X.complete(prep0, { quotes: M.quotesFromScoreboard(FX.artifacts['today/slate.json'], (e) => P.SCHEDULE_CODE[e.sport]), now: NOW + 1000, quote_sources: ['TEST: the fixture scoreboard snapshot'] });
  ok('ANSWER: every section in order', ['BEST VERIFIED OPPORTUNITY', 'BEST RESEARCHED MATCHUP', 'STRONGEST CONDITIONAL MARKET WATCH', 'OTHER TOP CANDIDATES', 'WHAT COULD CHANGE THE ANSWER', 'COVERAGE REPORT', 'RESEARCH SOURCES'].every((h, i, a) => r.answer.indexOf(h) >= 0 && (i === 0 || r.answer.indexOf(h) > r.answer.indexOf(a[i - 1]))));
  ok('ANSWER: the best researched matchup is said to be research, never a verified bet', /A matchup with no current odds is research, never a verified bet/.test(r.answer));
  ok('ANSWER: a price to watch is a threshold from the frozen projection, never shown as a live price', /Price to watch: .* or better \(the worst moneyline price at which the conservative probability/.test(r.answer));
  ok('ANSWER: the coverage report lists every sport with events, models, markets, prices and blockers', r.coverage.length === Object.keys(P.SPORTS).length && /- NHL: 11 discovered, 11 researched, model executed \(edgedesk_nhl_v1:xg_core\)/.test(r.answer));
  ok('ANSWER: sources carry their build times, and the order is proved', /hockey\/slate\.json — built 2026-10-15T12:05:48/.test(r.answer) && /projections unchanged by the comparison: yes/.test(r.answer));
  ok('ANSWER: no certainty words', !/\b(guarantee[sd]?|can'?t (lose|miss)|sure thing|free money|mortal lock|lock of the|will (win|cover|cash))\b/i.test(r.answer));
}

/* ═══ REVIEW REGRESSIONS (each a defect found in review, reproduced, then fixed) ═══ */
{
  const NOWC = NOW + 1000;
  /* 1. a second question on unchanged projections is its own freeze, with its own stored id */
  const pA = X.prepare({ artifacts: A(), question: 'tonight', now: NOW, timezone: TZ }), pB = X.prepare({ artifacts: A(), question: 'tonight', now: NOW + 20 * 60000, timezone: TZ });
  ok('SNAPSHOT ID: the same projections frozen 20 minutes apart keep their hash but get two ids (no silent dedupe onto the first freeze time)', pA.snapshot.snapshot_hash === pB.snapshot.snapshot_hash && /^pjs_[0-9a-f]{32}$/.test(pA.snapshot.snapshot_id) && pA.snapshot.snapshot_id !== pB.snapshot.snapshot_id, [pA.snapshot.snapshot_id, pB.snapshot.snapshot_id]);
  /* 2. a DATA CHECK (EV past the sanity ceiling) is listed, never ranked as the strongest market watch */
  const dc = X.complete(prep0, { quotes: [quote(VGK, { american: 400, market: { side: 'away' } }), quote(VGK, { american: -150 })], now: NOWC });
  const dRow = dc.comparison.rows.find((r) => r.projection_id === VGK.projection_id && r.market.side === 'away');
  ok('DATA CHECK: the +400 row is flagged, out of the execution ranking, and never the strongest market watch', dRow && dRow.data_check === true && !dc.execution_ranking.ranked.includes(dRow) && dc.execution_ranking.data_checks.includes(dRow) && dc.sections.market_watch !== dRow && /Data checks \(not ranked/.test(dc.answer), [dRow && dRow.outcome, dc.sections.market_watch && dc.sections.market_watch.selection]);
  /* 3. the price to watch is on the classifier's own bar: a fresh quote AT it is CONDITIONAL EDGE or better */
  const r0 = X.complete(prep0, { quotes: [], now: NOWC });
  const best = r0.sections.best_research, need = r0.price_needed.find((n) => n.projection_id === best.projection_id);
  const bp = prep0.snapshot.projections.find((p) => p.projection_id === best.projection_id);
  const r1 = need && need.needs != null ? X.complete(prep0, { quotes: [quote(bp, { american: need.needs, market: { side: best.modeled.side } })], now: NOWC }) : null;
  const row1 = r1 && r1.comparison.rows.find((r) => r.projection_id === best.projection_id && r.market.side === best.modeled.side && r.quote);
  ok('PRICE TO WATCH: a fresh quote at the stated price clears the same bar (CONDITIONAL EDGE or better, not MARKET WATCH)', row1 && (row1.outcome === 'CONDITIONAL_EDGE' || row1.outcome === 'VERIFIED_POSITIVE_EV'), [need, row1 && row1.outcome, row1 && row1.reasons]);
  /* 4. a postponed game is excluded with its projection: never brought back as scheduled by the engine-only pass */
  const ev0 = prep0.discovery.events.find((e) => e.sport === 'nhl' && e.schedule_id && e.projection_id);
  const Ap = A(); (Ap['today/slate.json'].events || []).concat(Ap['today/slate.json'].upcoming || []).filter((e) => e.id === ev0.schedule_id).forEach((e) => { e.status = 'POSTPONED'; });
  const pp = X.prepare({ artifacts: Ap, question: 'tonight', now: NOW, timezone: TZ });
  ok('POSTPONED: the game is listed once, excluded, and its projection is neither frozen nor ranked', pp.discovery.events.filter((e) => e.schedule_id === ev0.schedule_id || e.projection_id === ev0.projection_id).length === 1 && pp.discovery.events.find((e) => e.schedule_id === ev0.schedule_id).excluded && !pp.snapshot.projections.some((p) => p.projection_id === ev0.projection_id), pp.discovery.events.filter((e) => e.projection_id === ev0.projection_id));
  /* 6. a team spelled differently by the scoreboard (a renamed franchise) still joins its projection: same kick-off, one team named, one candidate */
  const T0 = (n) => ({ name: n });
  const pU = { projection_id: 'pU', sport: 'nhl', event_id: '900', home: T0('Utah Mammoth'), away: T0('St. Louis Blues'), start_utc: '2026-10-16T02:00:00Z' };
  const pO = { projection_id: 'pO', sport: 'nhl', event_id: '901', home: T0('Colorado Avalanche'), away: T0('Dallas Stars'), start_utc: '2026-10-16T02:00:00Z' };
  ok('JOIN: "Utah Hockey Club" v St. Louis Blues on the scoreboard joins the engine\'s Utah Mammoth projection (kick-off within 15 min, one team named, the only candidate)', X.joinOf({ home: T0('Utah Hockey Club'), away: T0('St. Louis Blues'), start_utc: '2026-10-16T02:05:00Z' }, [pU, pO], null) === pU);
  ok('JOIN: …but not when the one-team match is ambiguous or the start is 2 hours apart', X.joinOf({ home: T0('Utah Hockey Club'), away: T0('St. Louis Blues'), start_utc: '2026-10-16T04:00:00Z' }, [pU, pO], null) === null);
  /* a market with a draw (three-way) is never de-vigged as a two-way pair */
  const sbq = M.quotesFromScoreboard({ events: [{ id: 'sb1', sport: 'x', home: { name: 'A' }, away: { name: 'B' }, start_utc: '2026-10-16T18:30:00Z' }], markets: { sb1: { book: 'DraftKings', captured_at: new Date(NOW - 60000).toISOString(), moneyline: { home: -120, away: 300, draw: 280 } } } }, () => 'x');
  ok('THREE-WAY: a scoreboard market with a draw becomes three three-way quotes, each against the other two (never a two-way moneyline)', sbq.length === 3 && sbq.every((q) => q.market.kind === 'three_way' && q.other_sides_american && q.other_sides_american.length === 2) && sbq.some((q) => q.market.side === 'draw'), sbq.map((q) => q.market));
  /* 7. team names: a school is not its State / Tech / A&M / directional namesake; short names and LA still match */
  const T = (n) => ({ name: n });
  ok('SAME TEAM: Texas ≠ Texas A&M, Michigan ≠ Central Michigan, Iowa ≠ Iowa State, Miami ≠ Miami (OH), Florida ≠ Florida Atlantic', !M.sameTeam(T('Texas'), 'Texas A&M Aggies') && !M.sameTeam(T('Michigan'), 'Central Michigan') && !M.sameTeam(T('Iowa'), 'Iowa State Cyclones') && !M.sameTeam(T('Miami'), 'Miami (OH)') && !M.sameTeam(T('Florida'), 'Florida Atlantic Owls'));
  ok('SAME TEAM: …while Texas = Texas Longhorns, UAB = UAB Blazers, LA Clippers = Los Angeles Clippers, Vegas Golden Knights = Vegas', M.sameTeam(T('Texas'), 'Texas Longhorns') && M.sameTeam(T('UAB'), 'UAB Blazers') && M.sameTeam(T('LA Clippers'), 'Los Angeles Clippers') && M.sameTeam(T('Vegas Golden Knights'), 'Vegas'));
  const pI = { projection_id: 'p111', sport: 'cfb', event_id: '111', home: T('Kansas'), away: T('Iowa'), start_utc: '2026-10-17T19:00:00Z' };
  const pS = { projection_id: 'p222', sport: 'cfb', event_id: '222', home: T('Kansas State'), away: T('Iowa State'), start_utc: '2026-10-17T19:00:00Z' };
  ok('JOIN: an exact id link wins over a name match (Iowa State @ Kansas State with provider id 222 joins 222, not Iowa @ Kansas)', X.joinOf({ provider_id: '222', home: T('Kansas State'), away: T('Iowa State'), start_utc: '2026-10-17T19:00:00Z' }, [pI, pS], null) === pS);
  /* 8. a missing published figure drops a line, never the desk */
  const holes = [Object.assign(clone(VGK), { matchup: { factors: [], metrics: { home: { ev_xg_for_vs_league: 1.1 }, away: { ev_xg_for_vs_league: 0.9 } } } })];
  const nbaP = P.buildAll(A(), { now: NOW }).projections.find((p) => p.sport === 'nba'); if (nbaP) holes.push(Object.assign(clone(nbaP), { matchup: { factors: [], metrics: { home_offence_vs_away_defence: 115, away_offence_vs_home_defence: 112, pace: null } } }));
  let threw = null; try { holes.forEach((h) => X.researchFor(h)); } catch (e) { threw = String(e.message || e); }
  ok('NULL FIELDS: NHL xG against and NBA pace missing → research still written', threw === null && holes.length >= 2, threw);
  /* 10. two feeds reading the same book are one book */
  const twoFeeds = M.compareMarket(VGK, { kind: 'moneyline', side: 'home', line: null }, [M.normalizeQuote(quote(VGK, { american: -150, book: 'DraftKings', source: 'signals' }), NOWC), M.normalizeQuote(quote(VGK, { american: -150, book: 'draftkings', source: 'scoreboard' }), NOWC)], { now: NOWC, n_compared: 1 });
  ok('BOOKS: DraftKings from capture and from the scoreboard counts once (BOOKS_CONFIRM open, one book listed)', twoFeeds.books.length === 1 && twoFeeds.gates.some((g) => g.gate === 'BOOKS_CONFIRM' && !g.ok && /^1 book/.test(g.why)), [twoFeeds.books, twoFeeds.gates.find((g) => g.gate === 'BOOKS_CONFIRM')]);
  /* 11. a replay date: a past day is never an inverted window; the day is read from the date, not a noon-UTC anchor */
  const past = X.windowFor('', NOW, TZ, { date: '2026-10-14' });
  ok('WINDOW: a day already over is the whole day (from < to), flagged past, and nothing in it is frozen', Date.parse(past.from) < Date.parse(past.to) && past.past === true && X.prepare({ artifacts: A(), question: '', now: NOW, timezone: TZ, date: '2026-10-14' }).snapshot.count === 0, past);
  const akl = X.windowFor('', NOW, 'Pacific/Auckland', { date: '2026-10-16' });
  ok('WINDOW: Pacific/Auckland 2026-10-16 ends at local midnight 2026-10-16T11:00Z (not a day late)', akl.to === '2026-10-16T11:00:00.000Z', akl);
  /* 13. a spread or total quote without a line is never priced as pick'em */
  const nl = M.compareSnapshot(prep0.snapshot, [quote(SEA, { american: -110, market: { kind: 'spread', side: 'away', line: null } })], { now: NOWC });
  ok('NO LINE: a spread quote with no line is dropped (no row at line null, no probability at a null line)', !nl.rows.some((r) => r.market.kind === 'spread') && P.probabilityAt(SEA, 'spread', 'away', null) === null && M.quotesFromScoreboard({ events: [{ id: 'x', sport: 'nfl', home: { name: 'a' }, away: { name: 'b' }, start_utc: SEA.start_utc }], markets: { x: { captured_at: new Date(NOW).toISOString(), spread: { home: { price: -110 }, away: { price: -110 } } } } }, () => 'nfl').length === 0, nl.rows.filter((r) => r.market.kind === 'spread'));
  /* 14. the NHL engine's own per-line validation survives the merge */
  const hk = FX.artifacts['hockey/slate.json'].games.find((g) => String(g.game_id) === String(VGK.event_id));
  const tagged = ((hk && hk.markets && hk.markets.total) || []).filter((x) => x.validation && VGK.distribution.total_lines.some((y) => y.line === x.line));
  ok('NHL LINES: every total line the engine tags (PROVISIONAL) carries that tag in the projection, also lines first read from prices', tagged.length > 0 && tagged.every((x) => VGK.distribution.total_lines.find((y) => y.line === x.line).validation === x.validation), tagged.map((x) => [x.line, x.validation]));
  /* 15. no constant is shown as a fair line */
  ok('FAIR LINES: the NHL spread publishes no fair LINE (the engine prices the fixed ±1.5 puck line)', VGK.fair.spread.home_line === null && VGK.fair.spread.priced_line.home_line === -1.5 && !/EdgeDesk fair lines: home -1\.5/.test(r0.answer));
}

/* ═══ THE REGISTRY ══════════════════════════════════════════════════════════ */
{
  const cm = P.capabilityMatrix(P.buildAll(A(), { now: NOW }), { now: NOW });
  const need = ['sport', 'league', 'discovery', 'providers', 'stats', 'independent_projection', 'availability', 'simulation', 'validation', 'model_id', 'model_built_at', 'data_freshness_requirement_hours', 'supported_markets', 'research_readiness', 'unsupported'];
  ok('REGISTRY: every sport row carries every capability field', cm.every((r) => need.every((k) => k in r)), cm.find((r) => !need.every((k) => k in r)));
  ok('REGISTRY: NHL and NBA are OPERATIONAL with their real engines; MLB and UFC MODEL_UNAVAILABLE with reasons', cm.find((r) => r.sport === 'nhl').research_readiness === 'OPERATIONAL' && cm.find((r) => r.sport === 'nba').model_id === 'edgedesk_nba_v1:G_stack_P' && cm.find((r) => r.sport === 'mlb').research_readiness === 'MODEL_UNAVAILABLE' && cm.find((r) => r.sport === 'mma').unsupported.length);
  ok('REGISTRY: only a league\'s own feed is OFFICIAL; nflverse is THIRD_PARTY, its injury mirror THIRD_PARTY_MIRROR', P.authorityOf('NHL API (api-web.nhle.com)') === 'OFFICIAL' && P.authorityOf('nflverse depth charts') === 'THIRD_PARTY' && P.authorityOf('nflverse injury report') === 'THIRD_PARTY_MIRROR' && P.authorityOf('a blog') === 'UNVERIFIED_SOURCE');
  const committed = JSON.parse(fs.readFileSync(path.join(ROOT, 'engine', 'projections.json'), 'utf8'));
  ok('REGISTRY: the committed engine/projections.json is independent-only and verifies', committed.schema === BP.SCHEMA && committed.projections.every((p) => P.isIndependent(p)) && committed.inputs.every((i) => !/quote|market|signal/i.test(i.path)), committed.inputs);
}

console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
