#!/usr/bin/env node
/* ===========================================================================
   EDORCH — the research plan for one question (lib/edgedesk_orchestrator.js).
   Pure: no network, no model. Checks the classification, the path (cheapest
   reliable), the datasets and freshness, the calculations, the external
   research decision (never runnable without a key, an operator switch, paid
   authorisation and budget), the estimates, and planned-vs-actual.
   Run: node tools/intelligence/orchestrator.test.js
   =========================================================================== */
'use strict';
const O = require('../../lib/edgedesk_orchestrator.js');
let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) { pass++; return; } fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 600) : '')); }
const stages = (p) => p.steps.map((s) => s.stage).join('>');
const ON = { claude_web_search: { configured: true, enabled: true, model: 'claude-opus-5-5' }, perplexity_search: { configured: true, enabled: true } };
const BUDGET = { per_request_usd: 0.25, remaining_today_usd: 10 };

/* entities */
const e1 = O.entities('Lions at Bills, who has the edge?', {});
ok('two NFL teams named → a MATCHUP on the NFL', e1.sport === 'americanfootball_nfl' && e1.teams.map((t) => t.code).sort().join() === 'BUF,DET' && e1.event.kind === 'MATCHUP', e1);
const e2 = O.entities('Rays vs Guardians tonight', {});
ok('two MLB clubs → MLB', e2.sport === 'baseball_mlb' && e2.teams.length === 2, e2.teams);
const e3 = O.entities('How are the Giants looking?', {});
ok('"Giants" names neither club on its own (NFL and MLB share it)', e3.teams.length === 0, e3.teams);
const e4 = O.entities('Is Josh Allen playing?', { known_players: [{ name: 'Josh Allen', team: 'BUF', position: 'QB' }] });
ok('a known player resolves, and names his club when the question names none', e4.players.length === 1 && e4.players[0].resolved && e4.teams[0] && e4.teams[0].code === 'BUF' && e4.event.kind === 'TEAM', e4);
const e5 = O.entities('Research this game', { game: { sport: 'americanfootball_nfl', game_id: 'nfl-fx-det-buf', label: 'Detroit Lions @ Buffalo Bills' } });
ok('the game open on screen is the event', e5.event.kind === 'GAME' && e5.event.game_id === 'nfl-fx-det-buf' && /on screen/.test(e5.event.source), e5.event);
const e6 = O.entities('Best NBA bet tonight', {});
ok('an unsupported sport is recognised as such', e6.unsupported_sports.indexOf('NBA') >= 0 && !e6.sport, e6);

/* paths: the cheapest reliable one */
const p1 = O.plan('What is the Bills spread this week?', {});
ok('a stored value → DATABASE, LOOKUP, $0, no paid step', p1.path === 'DATABASE' && p1.classification.complexity === 'LOOKUP' && p1.classification.route === 'LOOKUP' && p1.estimate.usd === 0 && !p1.steps.some((s) => s.est_usd > 0), p1);
ok('…reads the market and converts the price', p1.datasets.some((d) => d.key === 'market') && p1.calculations.some((c) => c.key === 'implied_probability'), [p1.datasets, p1.calculations]);
const p2 = O.plan("What's the best researched opportunity tonight?", { route: 'SCAN' });
ok('the best-bet scan → ENGINE_RESEARCH investigation, $0 external, steps in the order the work happens', p2.path === 'ENGINE_RESEARCH' && p2.classification.complexity === 'INVESTIGATION' && stages(p2) === 'FIND_EVENTS>RETRIEVE_STATS>VERIFY_INJURIES>COMPARE_PRICES>CALCULATE>AUDIT>CHALLENGE>EXPLAIN' && p2.estimate.usd === 0, [p2.path, stages(p2)]);
ok('…lists the calculations it will run (fair, EV, max price, discrepancy, freshness, sensitivity)', ['devig', 'fair_odds', 'expected_value', 'max_price', 'spread_discrepancy', 'market_freshness', 'sensitivity'].every((k) => p2.calculations.some((c) => c.key === k)), p2.calculations.map((c) => c.key));
ok('…and the datasets with how fresh each must be', p2.datasets.every((d) => d.label && d.source && d.freshness) && p2.datasets.some((d) => d.key === 'market' && /60 min/.test(d.freshness) && /never a price/.test(d.freshness)), p2.datasets);
const p3 = O.plan('Research this game', { route: 'GAME_RESEARCH', game: { sport: 'americanfootball_nfl', game_id: 'g1' } });
ok('one game\'s research → investigation including weather and ratings', p3.classification.complexity === 'INVESTIGATION' && ['weather', 'team_ratings', 'injuries'].every((k) => p3.datasets.some((d) => d.key === k)), p3.datasets.map((d) => d.key));
ok('a deterministic question never plans the model desk', ['SCAN', 'GAME_RESEARCH', 'READINESS', 'MATCHUP_EDGE', 'VENUE_COMPARE', 'CONTRACT', 'BETS'].every((r) => O.plan('q', { route: r }).path !== 'MODEL_DESK'));
const p4 = O.plan('Which matchup has the biggest offensive advantage?', { route: 'MATCHUP_EDGE' });
ok('a mismatch → ENGINE, one read of the ratings', p4.path === 'ENGINE' && stages(p4) === 'RETRIEVE_STATS>EXPLAIN', stages(p4));
const p5 = O.plan('Why did I lose money on my bets?', { route: 'BETS' });
ok('betting history → your rows only, two steps', stages(p5) === 'READ_HISTORY>ANALYZE_HISTORY>EXPLAIN' && p5.datasets.some((d) => d.key === 'your_bets' && /your rows only/.test(d.source)), [stages(p5), p5.datasets]);
const p6 = O.plan('How accurate is the NFL model?', {});
ok('model accuracy → graded predictions and Brier / log loss / CLV, not an opinion', p6.classification.route === 'CALIBRATION' && p6.calculations.some((c) => c.key === 'calibration') && stages(p6) === 'RETRIEVE_STATS>CALCULATE>EXPLAIN', [p6.classification.route, stages(p6)]);
const p7 = O.plan('Tell me a joke about kickers', {});
ok('conversation the routes do not cover → the existing desk (under the allowance), flagged with its estimate', p7.path === 'MODEL_DESK' && p7.estimate.usd > 0, p7);

/* unsupported */
const u1 = O.plan('Best NBA bet tonight?', {});
ok('an unsupported sport → UNSUPPORTED, $0, says why', u1.path === 'UNSUPPORTED' && u1.estimate.usd === 0 && /NBA is not covered/.test(u1.why.join(' ')), u1.why);
const u2 = O.plan('Who will win the Super Bowl?', {});
ok('a future result → UNSUPPORTED, never a guarantee', u2.path === 'UNSUPPORTED' && /never a guarantee/.test(u2.why.join(' ')), u2.why);
ok('an empty question plans nothing', O.plan('', {}).path === 'UNSUPPORTED');

/* external research: needed vs runnable */
const n0 = O.plan('Any news on Josh Allen\'s shoulder since this morning?', { known_players: [{ name: 'Josh Allen', team: 'BUF' }] });
ok('news → the NEWS route: resolve, read the injury report, search, cross-check, answer', n0.classification.route === 'NEWS' && stages(n0) === 'FIND_EVENTS>RETRIEVE_STATS>SEARCH>VERIFY_INJURIES>EXPLAIN', stages(n0));
const sx0 = n0.steps.find((s) => s.stage === 'SEARCH');
ok('…with no key, the search step is in the plan as UNAVAILABLE with the reason, and nothing is spent', n0.external.needed && !n0.external.runnable && sx0.status === 'unavailable' && /no API key configured/.test(sx0.why) && n0.estimate.usd === 0 && n0.path === 'ENGINE_RESEARCH', [n0.external, sx0]);
const n1 = O.plan('Any news on Josh Allen\'s shoulder since this morning?', { providers: { perplexity_search: { configured: true, enabled: false } }, paid_ok: true, budget: BUDGET });
ok('a key but the operator has not enabled it → unavailable, named', !n1.external.runnable && /not enabled by the operator/.test(n1.external.why), n1.external);
const n2 = O.plan('Any news on Josh Allen\'s shoulder since this morning?', { providers: ON, paid_ok: false, budget: BUDGET });
ok('enabled but paid research not authorised → unavailable, named', !n2.external.runnable && /EDGEDESK_RESEARCH_PAID_OK/.test(n2.external.why), n2.external);
const n3 = O.plan('Any news on Josh Allen\'s shoulder since this morning?', { providers: ON, paid_ok: true, budget: BUDGET });
ok('all conditions met, a lookup → the cheap adapter (Perplexity), ENGINE_SEARCH, $0.01 estimated', n3.external.runnable && n3.external.provider === 'perplexity_search' && n3.path === 'ENGINE_SEARCH' && Math.abs(n3.estimate.usd - 0.01) < 1e-9, n3.external);
const n4 = O.plan('Investigate the coaching change in Dallas', { providers: ON, paid_ok: true, budget: BUDGET });
ok('an investigation or off-dataset topic → the deep adapter (Claude web search) at its model\'s estimate', n4.external.runnable && n4.external.provider === 'claude_web_search' && Math.abs(n4.external.est_usd - 0.084) < 1e-9, n4.external);
const n5 = O.plan('Investigate the coaching change in Dallas', { providers: ON, paid_ok: true, budget: { per_request_usd: 0.05, remaining_today_usd: 10 } });
ok('the deep adapter over the per-request budget falls back to the cheap one', n5.external.runnable && n5.external.provider === 'perplexity_search', n5.external);
const n6 = O.plan('Any news on the Bills injuries today?', { providers: ON, paid_ok: true, budget: { per_request_usd: 0.25, remaining_today_usd: 0.001 } });
ok('today\'s budget spent → unavailable, said so', !n6.external.runnable && /budget is spent/.test(n6.external.why), n6.external);
const n7 = O.plan('Investigate the coaching change in Dallas', { providers: { claude_web_search: { configured: true, enabled: true, model: 'claude-sonnet-5-5' } }, paid_ok: true, budget: BUDGET });
ok('the estimate follows the configured model (Sonnet 5.5 cheaper than Opus 5.5)', n7.external.provider === 'claude_web_search' && Math.abs(n7.external.est_usd - 0.057) < 1e-9, n7.external);
ok('a dataset question never plans a search, even with every provider on', ['SCAN', 'GAME_RESEARCH', 'READINESS', 'MATCHUP_EDGE'].every((r) => !O.plan('What is the best bet this weekend?', { route: r, providers: ON, paid_ok: true, budget: BUDGET }).steps.some((s) => s.stage === 'SEARCH')));

/* estimates */
ok('the estimate sums only runnable steps and is labelled an estimate', n3.estimate.ms === n3.steps.filter((s) => s.status === 'planned').reduce((a, s) => a + s.est_ms, 0) && /estimates/.test(n3.estimate.basis), n3.estimate);
ok('every step has an id, a stage, a label and a status', [p1, p2, n0, n3, p6].every((p) => p.steps.every((s) => /^s\d+$/.test(s.id) && s.stage && s.label && ['planned', 'unavailable'].includes(s.status))));

/* planned vs actual */
const rec = O.reconcile(p2, [{ type: 'progress', stage: 'FIND_EVENTS', status: 'done', detail: '8 games' }, { type: 'progress', stage: 'COMPARE_PRICES', status: 'skipped', detail: 'nothing priced' }]);
ok('reconcile: each planned step gets what actually happened, or "not_run"', rec.find((r) => r.stage === 'FIND_EVENTS').actual === 'done' && rec.find((r) => r.stage === 'COMPARE_PRICES').actual === 'skipped' && rec.find((r) => r.stage === 'AUDIT').actual === 'not_run', rec);
const rec2 = O.reconcile(n0, []);
ok('reconcile: an unavailable step stays unavailable with its reason', rec2.find((r) => r.stage === 'SEARCH').actual === 'unavailable' && /no API key/.test(rec2.find((r) => r.stage === 'SEARCH').detail), rec2);

console.log((fail ? 'FAILED ' : 'ALL GREEN ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
