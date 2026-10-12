#!/usr/bin/env node
/* ===========================================================================
   THE RESEARCH SYSTEM'S KERNELS: the evidence graph (EDGRAPH), the model
   disagreement engine (EDDISAGREE), the research budget (EDBUDGET) and the
   five agent roles (EDAGENTS).

   Every assertion is about an answer that must not reach a reader: a
   citation that does not support its sentence, a number nobody computed, a
   speculative report treated as confirmed, a probability written by prose,
   an edge that is really a stale quote, a gap assumed to be EdgeDesk's
   advantage, research bought twice, an agent that agrees because another did.

   Run: node tools/intelligence/research_agents.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const FN = path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai');
require(path.join(FN, '_intelligence.js'));
const F = require(path.join(ROOT, 'lib', 'edgedesk_fairodds.js'));
const G = require(path.join(ROOT, 'lib', 'edgedesk_evidence_graph.js'));
const DIS = require(path.join(ROOT, 'lib', 'edgedesk_disagreement.js'));
const B = require(path.join(ROOT, 'lib', 'edgedesk_research_budget.js'));
require(path.join(ROOT, 'lib', 'edgedesk_sport_adapters.js'));
const AU = require(path.join(FN, '_audit.js'));
const A = require(path.join(FN, '_agents.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function eq(name, a, b) { chk(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b }); }
function near(name, a, b, tol) { chk(name, a != null && Math.abs(Number(a) - Number(b)) <= (tol == null ? 1e-9 : tol), { got: a, want: b }); }
async function done() {
  failures.forEach((f) => console.log('FAIL | ' + f.name + '  ' + String(JSON.stringify(f.detail)).slice(0, 700)));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}
const NOW = Date.parse('2026-10-11T22:00:00Z');
const T = (min) => new Date(NOW - min * 60000).toISOString();
const EV = { id: 'nfl-det-buf', sport: 'americanfootball_nfl', home: 'Buffalo Bills', away: 'Detroit Lions', kickoff: '2026-10-12T17:00:00Z' };
const NFLV = 'https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_2026.csv';

(async function main() {
  /* ═══ 1. THE EVIDENCE GRAPH ════════════════════════════════════════════ */
  {
    const g = G.create({ event: EV });
    eq('a source with no URL is refused', g.addSource({ title: 'a rumour', retrieved_at: T(5) }), null);
    eq('a source with no retrieval time is refused', g.addSource({ url: 'https://espn.com/x' }), null);
    eq('an EdgeDesk-written conclusion is not evidence', g.addSource({ url: 'https://edgedesk.test/answer', retrieved_at: T(1), kind: 'EDGEDESK_AI' }), null);
    eq('…and each refusal is recorded with its reason', g.refused.map((r) => r.why), ['no source URL', 'no retrieval time', 'an EdgeDesk-written conclusion is not evidence']);
    eq('a claim with no source is refused', g.addClaim({ topic: 'availability', text: 'Allen out' }), null);
    const s1 = g.addSource({ url: NFLV, title: 'nflverse injuries', retrieved_at: T(10), published_at: T(60), reliability: 'OFFICIAL' });
    const s2 = g.addSource({ url: 'https://www.espn.com/nfl/story/1', title: 'ESPN', retrieved_at: T(10), published_at: T(30), reliability: 'CREDIBLE_JOURNALISM' });
    const s3 = g.addSource({ url: 'https://espn.com/nfl/story/2', title: 'ESPN again', retrieved_at: T(10), published_at: T(20), reliability: 'CREDIBLE_JOURNALISM' });
    const s4 = g.addSource({ url: 'https://randomblog.example/post', title: 'blog', retrieved_at: T(10), published_at: T(15), reliability: 'SPECULATION' });
    const c1 = g.addClaim({ topic: 'availability', text: 'Jared Goff questionable (ankle)', team: 'Detroit Lions', player: 'Jared Goff', status: 'QUESTIONABLE', source_id: s1 });
    const c2 = g.addClaim({ topic: 'availability', text: 'Jared Goff questionable, limited in practice', team: 'Detroit Lions', player: 'Jared Goff', status: 'QUESTIONABLE', source_id: s2 });
    const c3 = g.addClaim({ topic: 'availability', text: 'Goff questionable per ESPN', team: 'Detroit Lions', player: 'Jared Goff', status: 'QUESTIONABLE', source_id: s3 });
    const c4 = g.addClaim({ topic: 'availability', text: 'Jared Goff is reportedly out', team: 'Detroit Lions', player: 'Jared Goff', status: 'OUT', source_id: s4 });
    eq('independent publishers corroborate', g.corroborate(c1, c2), true);
    eq('two copies from one publisher (espn.com and www.espn.com) do not', g.corroborate(c2, c3), false);
    g.contradict(c1, c4, 'questionable vs out');
    eq('a contradiction is found from either side', [g.contradicting(c1).map((x) => x.id), g.contradicting(c4).map((x) => x.id)], [[c4], [c1]]);
    chk('a claim from a speculative source is speculative', g.node(c4).speculative === true);
    eq('missing: a required topic with no claim', g.missing([{ topic: 'availability', team: 'Detroit Lions' }, { topic: 'availability', team: 'Buffalo Bills' }, { topic: 'weather' }]).map((m) => m.topic + ':' + (m.team || '')), ['availability:Buffalo Bills', 'weather:']);
    const old = g.addClaim({ topic: 'availability', text: 'Bills: nobody listed', team: 'Buffalo Bills', source_id: s1, as_of: T(600) });
    eq('stale: a 600-minute-old availability claim is past the 360-minute limit', g.stale(NOW).map((x) => x.claim), [old]);
    const inp = g.addModelInput({ key: 'starter_away', label: 'Detroit starter (as priced)', value: 'Jared Goff' });
    g.affects(c4, inp, { in_model: false, changed: false, note: 'the model prices Goff' });
    eq('a finding the model does not carry is reported', g.notInModel().map((x) => x.claim.id), [c4]);
    const pj = g.addProjection({ model_version: 'nfl_v3', tier: 'LEAN', fair_line: -4.5, fair_probability: 0.561 });
    const mk = g.addMarket({ book: 'FanDuel', american: -105, decimal: 1.9524, line: -2.5, captured_at: T(4) }, pj);
    g.addAudit({ status: 'CONFIRMED', checks: [{ id: 'A1', result: 'PASS' }] }, [pj, mk]);
    const allowed = g.allowedNumbers();
    chk('the projection and market numbers are allowed', allowed['4.5'] && allowed['56.1'] && allowed['105'] && allowed['2.5']);
    const ok = G.trace('Detroit Lions: Jared Goff is questionable [1]. EdgeDesk makes Buffalo -4.5 against -2.5 at -105.', g);
    chk('a faithful answer traces', ok.ok, ok);
    const badNum = G.trace('EdgeDesk makes Buffalo -6.5 here.', g);
    eq('a number nobody computed is caught', badNum.untraced_numbers, ['-6.5']);
    const badUrl = G.trace('See https://made.up/source for more.', g);
    eq('a link that is not a source is caught', badUrl.unknown_urls, ['https://made.up/source']);
    chk('certainty words are caught', G.trace('This is a lock.', g).certainty === 'lock');
    const cites = G.verifyCitations('Buffalo Bills are healthy [2]. Jared Goff is questionable [2]. The weather is fine [9].', g);
    eq('a citation must support its sentence; an out-of-range citation is caught', cites.citations.map((c) => c.ok), [false, true, false]);
    const j = g.toJSON();
    chk('the graph serialises with counts per node type', j.counts.SOURCE === 4 && j.counts.CLAIM === 5 && j.counts.PROJECTION === 1 && j.counts.AUDIT === 1, j.counts);
  }

  /* ═══ 2. THE DISAGREEMENT ENGINE ═══════════════════════════════════════ */
  {
    const base = { model: { available: true, tier: 'VALIDATED', line: -4.5, starters: { home: 'Josh Allen', away: 'Jared Goff' } }, market: { line: -2.5, open_line: -2.5 }, claims: [{ topic: 'availability', player: 'X', status: 'QUESTIONABLE' }, { topic: 'starter', player: 'Josh Allen', status: 'STARTING' }], weather: { hazard: false, text: 'clear' }, quality: {}, audit: { status: 'CONFIRMED' } };
    const clean = DIS.diagnose(base);
    eq('validated model, data clean, availability and lineups checked, nothing else: a POSSIBLE mispricing (not proof)', [clean.verdict, clean.is_edge_evidence, clean.causes.find((c) => c.cause === 'POTENTIAL_MISPRICING').assessment], ['POTENTIAL_MISPRICING', true, 'POSSIBLE']);
    const stale = DIS.diagnose(Object.assign({}, base, { market: { line: -2.5, stale: true } }));
    eq('a stale quote: DATA_FAULT first', [stale.verdict, stale.primary], ['DATA_FAULT', 'DATA_QUALITY']);
    const ext = DIS.diagnose(Object.assign({}, base, { market: { line: 4.0 } }));
    eq('an 8.5-point gap is EXTREME and treated as a suspected data fault', [ext.size, ext.verdict], ['EXTREME', 'DATA_FAULT']);
    const inj = DIS.diagnose(Object.assign({}, base, { gaps: [{ kind: 'ABSENCE_NOT_IN_MODEL', detail: 'Jared Goff is out; the model does not remove him' }] }));
    eq('a key absence the model does not carry explains the gap: EXPLAINED, not edge evidence', [inj.verdict, inj.primary, inj.is_edge_evidence], ['EXPLAINED', 'INJURY_INFORMATION', false]);
    const lin = DIS.diagnose(Object.assign({}, base, { gaps: [{ kind: 'STARTER_MISMATCH', detail: 'priced Allen, listed Trubisky' }] }));
    eq('a starter mismatch: LINEUP_ASSUMPTIONS', lin.primary, 'LINEUP_ASSUMPTIONS');
    const res = DIS.diagnose(Object.assign({}, base, { model: Object.assign({}, base.model, { tier: 'RESEARCH', line: -6.5 }) }));
    eq('an unvalidated model with a large gap: methodology LIKELY, mispricing RULED_OUT', [res.verdict, res.causes.find((c) => c.cause === 'STATISTICAL_METHODOLOGY').assessment, res.causes.find((c) => c.cause === 'POTENTIAL_MISPRICING').assessment], ['EXPLAINED', 'LIKELY', 'RULED_OUT']);
    const mv = DIS.diagnose(Object.assign({}, base, { market: { line: -2.5, open_line: -3.5 } }));
    eq('the market moved a point away from the model since the open: it may know something', mv.causes.find((c) => c.cause === 'MARKET_MOVEMENT').assessment, 'LIKELY');
    const toward = DIS.diagnose(Object.assign({}, base, { market: { line: -2.5, open_line: -1.5 } }));
    eq('…moving toward the model is only POSSIBLE', toward.causes.find((c) => c.cause === 'MARKET_MOVEMENT').assessment, 'POSSIBLE');
    const unc = DIS.diagnose(Object.assign({}, base, { model: Object.assign({}, base.model, { line_uncertainty_points: 2.5 }) }));
    eq('a 2-point gap inside a ±2.5-point model uncertainty: MODEL_UNCERTAINTY LIKELY', [unc.causes.find((c) => c.cause === 'MODEL_UNCERTAINTY').assessment, unc.verdict], ['LIKELY', 'EXPLAINED']);
    const blind = DIS.diagnose(Object.assign({}, base, { claims: [], model: Object.assign({}, base.model, { starters: null }) }));
    eq('nothing checked: INVESTIGATE, never assumed to be EdgeDesk\'s edge', [blind.verdict, blind.is_edge_evidence], ['INVESTIGATE', false]);
    const none = DIS.diagnose({ model: { available: false }, market: { probability: 0.5 } });
    eq('no model: no disagreement to call a mispricing', none.causes.find((c) => c.cause === 'POTENTIAL_MISPRICING').assessment, 'NOT_ASSESSED');
    const wx = DIS.diagnose(Object.assign({}, base, { market_type: 'totals', weather: { hazard: true, text: 'wind 25 mph' } }));
    eq('a weather hazard on a total: VENUE_WEATHER LIKELY', wx.causes.find((c) => c.cause === 'VENUE_WEATHER').assessment, 'LIKELY');
  }

  /* ═══ 3. THE RESEARCH BUDGET ═══════════════════════════════════════════ */
  {
    eq('a coverage question is a fast screen (L1)', B.selectLevel({ intent: 'COVERAGE', data_available: true }).level, 'L1');
    eq('a best-bet scan with candidates is L3', B.selectLevel({ intent: 'SCAN', candidates: 4, data_available: true }).level, 'L3');
    eq('…with nothing on the board it stays L1', B.selectLevel({ intent: 'SCAN', candidates: 0, data_available: true }).level, 'L1');
    eq('"research every NFL game … adversarial audit" is L3', B.selectLevel({ question: 'Research every NFL game and tell me which survive an adversarial audit', data_available: true, candidates: 2 }).level, 'L3');
    const l3 = B.selectLevel({ intent: 'SCAN', candidates: 3, data_available: true, paid_authorized: false });
    eq('L3 without paid authorisation spends no paid calls', [l3.budget.paid_calls, /not authorised/.test(l3.why.join(' '))], [0, true]);
    let t = NOW;
    const L = B.ledger({ now: () => t, paid_authorized: false });
    let n = 0;
    const r1 = await L.call({ provider: 'nflverse_injuries', key: 'BUF', topic: 'availability' }, () => { n++; return { rows: 3 }; });
    const r2 = await L.call({ provider: 'nflverse_injuries', key: 'BUF', topic: 'availability' }, () => { n++; return { rows: 3 }; });
    eq('the same request twice: one fetch, the second from cache', [n, r1.cached, r2.cached], [1, false, true]);
    t += 61 * 60000;
    await L.call({ provider: 'nflverse_injuries', key: 'BUF', topic: 'availability' }, () => { n++; return { rows: 4 }; });
    eq('after the availability TTL (60 min) it is refreshed', n, 2);
    let m = 0;
    const slow = () => new Promise((res) => setTimeout(() => { m++; res('x'); }, 20));
    const [j1, j2] = await Promise.all([L.call({ provider: 'open_meteo', key: 'buf' }, slow), L.call({ provider: 'open_meteo', key: 'buf' }, slow)]);
    eq('two identical requests in flight: one call, the second joins', [m, j2.joined], [1, true]);
    const paid = await L.call({ provider: 'brave_search', key: 'q' }, () => 'never');
    eq('a paid provider is refused without authorisation', [paid.ok, /not authorised/.test(paid.why)], [false, true]);
    const P = B.ledger({ now: () => t, paid_authorized: true, providers: { tiny: { label: 'tiny', cost_usd: 0.01, paid: true, daily: 2, monthly: 100, per_user_daily: 1 } } });
    await P.call({ provider: 'tiny', key: 'a', user: 'u1' }, () => 1);
    const u = await P.call({ provider: 'tiny', key: 'b', user: 'u1' }, () => 1);
    eq('the per-user daily allowance is enforced', /your daily research allowance/.test(u.why), true);
    await P.call({ provider: 'tiny', key: 'c', user: 'u2' }, () => 1);
    const d = await P.call({ provider: 'tiny', key: 'd', user: 'u3' }, () => 1);
    eq('the provider daily quota is enforced', /daily quota/.test(d.why), true);
    eq('the cost estimate is the sum of paid calls', P.report().cost_estimate_usd, 0.02);
    const Br = B.ledger({ now: () => t });
    await Br.call({ provider: 'open_meteo', key: 'k', topic: 'weather' }, () => 'cached-value');
    t += 200 * 60000;
    for (let i = 0; i < 3; i++) await Br.call({ provider: 'open_meteo', key: 'k' + i }, () => { throw new Error('HTTP 503'); });
    chk('three consecutive failures open the circuit breaker', Br.breaker('open_meteo').open_until > t, Br.breaker('open_meteo'));
    const fb = await Br.call({ provider: 'open_meteo', key: 'k', topic: 'weather' }, () => 'should not run');
    eq('with the breaker open the last cached value is served, labelled stale', [fb.ok, fb.stale, fb.value, /circuit breaker/.test(fb.why)], [true, true, 'cached-value', true]);
    const To = B.ledger({ now: () => Date.now() });
    const to = await To.call({ provider: 'open_meteo', key: 'slow', timeout_ms: 30 }, () => new Promise((res) => setTimeout(() => res(1), 200)));
    eq('a slow provider times out and does not block the answer', [to.ok, /timed out/.test(to.why)], [false, true]);
    const Bu = B.ledger({ now: () => t });
    const budget = { level: 'L2', requests: 1, paid_calls: 0, ms: 0 };
    await Bu.call({ provider: 'open_meteo', key: 'one', budget }, () => 1);
    const over = await Bu.call({ provider: 'open_meteo', key: 'two', budget }, () => 1);
    eq('the level\'s request budget is enforced', /request budget/.test(over.why), true);
  }

  /* ═══ 4. THE RESEARCHER ════════════════════════════════════════════════ */
  {
    eq('an official domain is OFFICIAL', A.sourceClass({ url: 'https://www.nfl.com/injuries/' }), 'OFFICIAL');
    eq('the nflverse feed is statistical data', A.sourceClass({ url: NFLV }), 'STATISTICAL_DATA');
    eq('ESPN is credible journalism', A.sourceClass({ url: 'https://www.espn.com/nfl/story' }), 'CREDIBLE_JOURNALISM');
    eq('an unknown blog is UNKNOWN', A.sourceClass({ url: 'https://someblog.example/a' }), 'UNKNOWN');
    eq('"is expected to start" is SPECULATION even from ESPN', A.claimClass('CREDIBLE_JOURNALISM', 'Mitchell Trubisky is expected to start Sunday'), 'SPECULATION');
    eq('"my pick" is OPINION', A.claimClass('UNKNOWN', 'My pick: Bills win big'), 'OPINION');
    const spec = A.normalize({ url: 'https://www.espn.com/a', retrieved_at: T(5), published_at: T(30), team: 'Buffalo Bills', player: 'Josh Allen', topic: 'availability', text: 'Josh Allen reportedly could miss Sunday' });
    eq('a speculative report is never verified', [spec.reliability, spec.speculative, spec.verified], ['SPECULATION', true, false]);
    eq('a finding with no URL is refused', A.normalize({ retrieved_at: T(5), text: 'Allen out' }).why, 'no source URL');
    eq('…with no retrieval time, refused', A.normalize({ url: 'https://espn.com', text: 'Allen out' }).why, 'no retrieval time');
    const off = A.normalize({ url: NFLV, kind: 'OFFICIAL_REPORT', retrieved_at: T(5), published_at: T(120), team: 'Buffalo Bills', player: 'Josh Allen', role: 'QB', key: true, topic: 'availability', status: 'Out', text: 'Josh Allen (QB) Out — ankle' });
    eq('an official report is verified, with its status read', [off.reliability, off.verified, off.status], ['OFFICIAL', true, 'OUT']);
    chk('every finding carries URL, published, retrieved, event, player, claim, class', off.source_url && off.published_at && off.retrieved_at && off.player && off.claim && off.reliability, off);
    const j1 = A.normalize({ url: 'https://www.espn.com/b', retrieved_at: T(5), published_at: T(60), team: 'Buffalo Bills', player: 'Josh Allen', topic: 'availability', text: 'Josh Allen is active and will play' });
    const conf = A.conflicts([off, j1]);
    eq('official OUT vs journalism "will play": resolved by source tier, to OUT', [conf.length, conf[0].resolved, conf[0].resolution.status], [1, true, 'OUT']);
    const j2 = A.normalize({ url: 'https://theathletic.com/c', retrieved_at: T(5), published_at: T(58), team: 'Buffalo Bills', player: 'Josh Allen', topic: 'availability', text: 'Josh Allen is out' });
    const j3 = A.normalize({ url: 'https://www.cbssports.com/d', retrieved_at: T(5), published_at: T(55), team: 'Buffalo Bills', player: 'Josh Allen', topic: 'availability', text: 'Josh Allen will play' });
    const conf2 = A.conflicts([j2, j3]);
    eq('two credible outlets disagreeing at the same time: UNRESOLVED', [conf2.length, conf2[0].unresolved], [1, true]);
    const k1 = A.normalize({ url: 'https://www.espn.com/e', retrieved_at: T(5), team: 'Detroit Lions', player: 'Amon-Ra St. Brown', topic: 'availability', text: 'Amon-Ra St. Brown is out' });
    const k2 = A.normalize({ url: 'https://apnews.com/f', retrieved_at: T(5), team: 'Detroit Lions', player: 'Amon-Ra St. Brown', topic: 'availability', text: 'Amon-Ra St. Brown is out' });
    A.corroborate([k1, k2]);
    eq('two independent outlets reporting the same status corroborate (verified)', [k1.verified, k2.verified], [true, true]);
    const gaps = A.modelGaps([off, A.normalize({ url: 'https://www.nfl.com/g', retrieved_at: T(5), team: 'Detroit Lions', player: 'Hendon Hooker', topic: 'starter', text: 'Hendon Hooker will start for Detroit' })], { home: 'Buffalo Bills', away: 'Detroit Lions', starters: { home: 'Josh Allen', away: 'Jared Goff' } }, ['QB']);
    eq('the model\'s gaps: the starter it priced is out; another starter is named', gaps.map((x) => x.kind).sort(), ['ABSENCE_NOT_IN_MODEL', 'STARTER_MISMATCH']);
    const noGap = A.modelGaps([spec], { home: 'Buffalo Bills', away: 'Detroit Lions', starters: { home: 'Josh Allen' } }, ['QB']);
    eq('a speculative report creates no model gap', noGap.length, 0);
    const R = A.research({ event: EV, raw: [{ url: NFLV, kind: 'OFFICIAL_REPORT', retrieved_at: T(5), published_at: T(120), team: 'Buffalo Bills', player: 'Josh Allen', role: 'QB', key: true, topic: 'availability', status: 'Out', text: 'Josh Allen (QB) Out' }, { url: 'https://x.example', text: 'no retrieval' }], model: { starters: { home: 'Josh Allen', away: 'Jared Goff' } }, required: [{ topic: 'availability', team: 'Detroit Lions' }], now: NOW });
    eq('research(): findings, refusals, gaps, missing topics and a graph', [R.findings.length, R.refused.length, R.gaps.length, R.missing.length, !!R.graph], [1, 1, 1, 1, true]);
    eq('…the graph marks the finding as not in the model', R.graph.notInModel().length, 1);
  }

  /* ═══ 5. THE ODDSMAKER ═════════════════════════════════════════════════ */
  const NFLM = { available: true, tier: 'LEAN', probability: 0.56, model_version: 'nfl_v3', as_of: T(60), label: 'EdgeDesk NFL spread model' };
  const MK = { decimal: 1.95, book: 'FanDuel', captured_at: T(4), sharp_fair: 0.532, kickoff: EV.kickoff };
  {
    const r78 = A.price({ market_type: 'spreads', model: NFLM, market: MK, adjustments: [{ rule: 'NARRATIVE', probability: 0.78, finding_id: 'f1' }], now: NOW, ttl_min: 90 });
    eq('prose cannot assign 78%: the adjustment is refused and the probability is the model\'s', [r78.adjustments_refused.length, /cannot be supplied/.test(r78.adjustments_refused[0].why), r78.fair_probability], [1, true, 0.56]);
    const unreg = A.checkAdjustment({ rule: 'HOT_STREAK', finding_id: 'f', scenario_delta_points: 3, sd_points: 13 });
    chk('an unregistered rule is refused', /unregistered/.test(unreg), unreg);
    chk('a rule with no model delta is refused (the model was not re-run)', /no model scenario delta/.test(A.checkAdjustment({ rule: 'QB_OUT', finding_id: 'f', sd_points: 13 })));
    chk('a delta given as text is refused', /must be the model/.test(A.checkAdjustment({ rule: 'QB_OUT', finding_id: 'f', scenario_delta_points: '-7', sd_points: 13 })) || /no model scenario delta/.test(A.checkAdjustment({ rule: 'QB_OUT', finding_id: 'f', scenario_delta_points: '-7', sd_points: 13 })) === false);
    const adj = A.price({ market_type: 'spreads', model: NFLM, market: MK, adjustments: [{ rule: 'QB_OUT', finding_id: 'f1', scenario_delta_points: -6.5, sd_points: 13.5 }], now: NOW, ttl_min: 90 });
    const want = A.phi(A.phiInv(0.56) - 6.5 / 13.5);
    near('QB_OUT moves the probability through the model\'s own error distribution', adj.fair_probability, want, 1e-6);
    eq('…and the adjustment is traceable: rule, finding, delta, from, to', [adj.adjustments[0].rule, adj.adjustments[0].finding_id, adj.adjustments[0].delta_points, adj.adjustments[0].from], ['QB_OUT', 'f1', -6.5, 0.56]);
    chk('…the EV is EDFAIR\'s, at the adjusted probability', adj.evaluation.ok && Math.abs(Number(adj.evaluation.fair_probability) - want) < 1e-6, adj.evaluation.fair_probability);
    const mkt = A.price({ market_type: 'h2h', model: { available: false }, market: MK, now: NOW, ttl_min: 90 });
    eq('no independent model: independent fair unavailable, the fair is the sharp market\'s', [mkt.independent_fair_probability, mkt.fair_kind, mkt.fair_probability], [null, 'SHARP_NO_VIG', 0.532]);
    const research = A.price({ market_type: 'spreads', model: Object.assign({}, NFLM, { tier: 'RESEARCH' }), market: MK, now: NOW, ttl_min: 90 });
    eq('a RESEARCH-tier model may not price: the market fair is used and the reason is given', [research.fair_kind, /may order research/.test(research.insufficient)], ['SHARP_NO_VIG', true]);
    const mktAdj = A.price({ market_type: 'h2h', model: { available: false }, market: MK, adjustments: [{ rule: 'QB_OUT', finding_id: 'f', scenario_delta_points: -6, sd_points: 13 }], now: NOW });
    chk('a model scenario cannot adjust the market\'s fair', /market's, not a model's/.test(mktAdj.adjustments_refused[0].why), mktAdj.adjustments_refused);
    const contract = A.price({ market_type: 'h2h', model: { available: false }, market: Object.assign({}, MK, { sharp_fair: 0.4655 }), venue: 'kalshi', contract: { price_cents: 46, side: 'YES' }, now: NOW });
    eq('contract: positive gross EV (+0.55¢) but negative after the 2¢ Kalshi fee', [contract.evaluation.gross_expected_value, contract.evaluation.net_expected_value, contract.evaluation.decision], ['0.0055', '-0.0145', 'PASS']);
    const s = A.sensitivity(adj);
    chk('sensitivity: EV at nearby fairs, the cushion to break-even and a robust flag', s.available && s.rows.length === 6 && s.cushion_pp != null, s);
    const s0 = s.rows.find((r) => r.shift_pp === 0);
    near('…the unshifted row equals the evaluation (numbers agree across agents)', s0.net_ev_per_dollar, Number(adj.evaluation.net_ev_per_dollar), 1e-6);
    const alt = A.price({ market_type: 'spreads', model: { available: false }, market: { american: -250, book: 'DraftKings', captured_at: T(3), sharp_fair: 0.68 }, now: NOW, ttl_min: 90 });
    eq('a heavily juiced alternate spread (-250 against a 68% fair) has no value: PASS', [alt.evaluation.decision, Number(alt.evaluation.net_ev_per_dollar) < 0], ['PASS', true]);
  }

  /* ═══ 6. STRATEGIST, AUDITOR, CHAIN ════════════════════════════════════ */
  {
    const auditOk = { status: 'CONFIRMED', reason: 'every check passed', checks: [{ id: 'A7_CONFIRMATION', result: 'PASS', detail: '3 of 4 books clear the floor' }, { id: 'A15_SANITY', result: 'PASS' }, { id: 'A8_AVAILABILITY', result: 'PASS' }] };
    const qSharp = A.price({ market_type: 'spreads', model: { available: false }, market: { decimal: 1.95, book: 'FanDuel', captured_at: T(4), sharp_fair: 0.55, kickoff: EV.kickoff }, audit: auditOk, confirmation: { pass: true }, now: NOW, ttl_min: 90 });
    const sens = A.sensitivity(qSharp);
    const st = A.strategist({ candidate: { quote: { captured_at: T(4) } }, quant: qSharp, research: { findings: [] }, disagreement: null, audit: auditOk, sensitivity: sens });
    eq('a sharp-referenced, book-confirmed price with a cushion: every professional check passes', [st.verdict, st.checks.map((c) => c.id + ':' + c.result).join(' ')], ['SUPPORTED', 'ARTIFACT:PASS PRICED_IN:PASS CALIBRATED:PASS AFTER_FEES:PASS EDGE_VS_UNCERTAINTY:PASS BLIND:PASS INDEPENDENT_SIGNAL:PASS']);
    const cl = A.classify({ audit: auditOk, quant: qSharp, strategist: st, research: { findings: [{ topic: 'availability' }], unresolved: [], gaps: [] }, sensitivity: sens });
    eq('…and the auditor calls it a VERIFIED CANDIDATE', [cl.classification, cl.final_status], ['VERIFIED_CANDIDATE', 'VERIFIED CANDIDATE']);
    const insane = Object.assign({}, auditOk, { checks: auditOk.checks.concat([{ id: 'A15_SANITY', result: 'FAIL', detail: 'EV 25% is past the 20% sanity ceiling' }]) });
    eq('a sanity failure: the strategist rejects it as an artifact', A.strategist({ quant: qSharp, audit: insane, sensitivity: sens, research: {} }).verdict, 'REJECTED');
    const lean = A.price({ market_type: 'spreads', model: { available: true, tier: 'LEAN', probability: 0.58, model_version: 'v', as_of: T(60) }, market: { decimal: 1.95, book: 'FanDuel', captured_at: T(4), sharp_fair: 0.53 }, audit: auditOk, confirmation: { pass: true }, now: NOW, ttl_min: 90 });
    const stLean = A.strategist({ quant: lean, audit: auditOk, sensitivity: A.sensitivity(lean), research: {} });
    eq('a LEAN-tier model: CALIBRATED warns (experimental), so the most it can be is a WATCHLIST', [stLean.verdict, stLean.checks.find((c) => c.id === 'CALIBRATED').result, A.classify({ audit: auditOk, quant: lean, strategist: stLean, research: { findings: [{ topic: 'availability' }] }, sensitivity: A.sensitivity(lean) }).classification], ['CAUTION', 'WARN', 'WATCHLIST']);
    const fees = A.price({ market_type: 'h2h', model: { available: false }, market: { decimal: 2.2, captured_at: T(4), sharp_fair: 0.4655 }, venue: 'kalshi', contract: { price_cents: 46, side: 'YES' }, audit: auditOk, now: NOW });
    eq('positive gross, negative net after fees: the strategist rejects it (AFTER_FEES)', [A.strategist({ quant: fees, audit: auditOk, sensitivity: A.sensitivity(fees), research: {} }).checks.find((c) => c.id === 'AFTER_FEES').result], ['FAIL']);
    /* the auditor overrules a researcher who favours the candidate */
    const favour = { findings: [{ topic: 'availability', reliability: 'CREDIBLE_JOURNALISM', claim: 'Lions star WR out, Bills look strong' }], unresolved: [], gaps: [] };
    const rej = A.classify({ audit: { status: 'REJECTED', reason: 'the price moved from 1.95 to 1.80 (decimal) at FanDuel', checks: [] }, quant: qSharp, strategist: st, research: favour, sensitivity: sens });
    eq('the audit can reject a candidate the researcher favoured', rej.classification, 'REJECTED');
    const conflicted = A.classify({ audit: auditOk, quant: qSharp, strategist: st, research: { findings: [{ topic: 'availability' }], unresolved: [{ detail: 'Josh Allen: OUT per ESPN vs ACTIVE per CBS' }], gaps: [] }, sensitivity: sens });
    eq('sources disagreeing about a player\'s availability: RESEARCH REQUIRED', conflicted.classification, 'RESEARCH_REQUIRED');
    const stale = A.price({ market_type: 'spreads', model: { available: false }, market: { decimal: 1.95, captured_at: T(400), sharp_fair: 0.55 }, now: NOW, ttl_min: 90 });
    eq('stale odds provider data: UNVERIFIED', A.classify({ audit: auditOk, quant: stale, strategist: A.strategist({ quant: stale, audit: auditOk, research: {} }), research: {}, sensitivity: A.sensitivity(stale) }).classification, 'UNVERIFIED');
    /* the full chain, with a quantifiable finding that reruns it */
    const raw = [{ url: NFLV, kind: 'OFFICIAL_REPORT', retrieved_at: T(5), published_at: T(30), team: 'Detroit Lions', player: 'Jared Goff', role: 'QB', key: true, topic: 'availability', status: 'Out', text: 'Jared Goff (QB) Out — ankle' }];
    const inv = A.investigate({ candidate: { market: 'spreads', quote: { captured_at: T(60) } }, event: EV, raw, model: { available: true, tier: 'VALIDATED', probability: 0.52, model_version: 'v', as_of: T(120), inputs: { starters: { home: 'Josh Allen', away: 'Jared Goff' } } }, market: { decimal: 1.95, book: 'FanDuel', captured_at: T(4), sharp_fair: 0.5, kickoff: EV.kickoff }, audit: auditOk, confirmation: { pass: true }, scenario_deltas: { away_qb_out: 6.0 }, sd_points: 13.5, now: NOW, ttl_min: 90 });
    eq('the chain reruns on a quantifiable finding: RESEARCH → PRICE → AUDIT → RECALCULATE → PRICE → AUDIT', inv.trail.map((t) => t.step), ['RESEARCH', 'PRICE', 'AUDIT', 'RECALCULATE', 'PRICE', 'AUDIT']);
    chk('…the second price carries the adjustment (the away QB out helps the home side)', inv.quant.adjustments.length === 1 && inv.quant.fair_probability > 0.52, inv.quant.adjustments);
    eq('…bounded: two rounds', inv.rounds, 2);
    const noDelta = A.investigate({ candidate: { market: 'spreads', quote: { captured_at: T(60) } }, event: EV, raw, model: { available: true, tier: 'VALIDATED', probability: 0.52, model_version: 'v', as_of: T(120), inputs: { starters: { home: 'Josh Allen', away: 'Jared Goff' } } }, market: { decimal: 1.95, book: 'FanDuel', captured_at: T(4), sharp_fair: 0.5 }, audit: auditOk, confirmation: { pass: true }, now: NOW, ttl_min: 90 });
    eq('the same finding with no model scenario to quantify it: RESEARCH REQUIRED, not a guessed number', [noDelta.classification.classification, noDelta.rounds], ['RESEARCH_REQUIRED', 1]);
    const cp = inv.confidence;
    chk('confidence is four separate measures with no combined percentage', cp.outcome_probability && cp.research_confidence && cp.model_reliability && cp.execution_confidence && !('confidence_pct' in cp), Object.keys(cp));
    /* the communicator */
    inv.candidate = { matchup: 'Detroit Lions @ Buffalo Bills', sport_label: 'NFL', market_label: 'Buffalo Bills -2.5', book: 'FanDuel' };
    inv.event = EV;
    const text = A.renderCandidate(inv);
    chk('the answer carries every field of the brief', ['Event:', 'Sport:', 'Market:', 'Venue:', 'Verified market price:', 'Independent fair probability:', 'Break-even probability:', 'Estimated net EV:', 'Maximum acceptable price:', 'Model reliability:', 'Research freshness:', 'Why the model disagrees with the market:', 'Primary matchup advantage:', 'Strongest counterargument:', 'What would invalidate the opportunity:', 'Final status:'].every((k) => text.indexOf(k) >= 0), text);
    const evLine = /Estimated net EV: ([^\n]+)/.exec(text)[1];
    const faithful = 'Buffalo is the side. ' + text.split('\n').filter((l) => /Estimated net EV|Verified market price|Maximum acceptable price|Break-even probability|Independent fair probability|Final status/.test(l)).join(' ');
    eq('faithful prose passes the critic', A.critic(faithful, text, inv.research.graph).verdict, 'PASS');
    const altered = faithful.replace(evLine.match(/[+-]?\d+(?:\.\d+)?/)[0], '9.99');
    chk('prose that changes the EV fails the critic', A.critic(altered, text, inv.research.graph).findings.some((f) => f.code === 'DROPPED_OR_CHANGED' || f.code === 'UNLISTED_NUMBER'), A.critic(altered, text, inv.research.graph));
    chk('prose that adds a number fails', A.critic(faithful + ' They win 78% of the time.', text, inv.research.graph).findings.some((f) => f.code === 'UNLISTED_NUMBER'));
    chk('prose that calls it a lock fails', A.critic(faithful + ' A lock.', text, inv.research.graph).findings.some((f) => f.code === 'CERTAINTY'));
    const st0 = /Final status: (VERIFIED CANDIDATE|WATCHLIST|PASS)/.exec(faithful)[1];
    const swapped = faithful.replace('Final status: ' + st0, 'Final status: ' + (st0 === 'VERIFIED CANDIDATE' ? 'PASS' : 'VERIFIED CANDIDATE'));
    chk('prose that changes the status fails', A.critic(swapped, text, inv.research.graph).findings.some((f) => f.code === 'STATUS_CHANGED'), A.critic(swapped, text, inv.research.graph));
    chk('prose that invents a link fails', A.critic(faithful + ' https://made.up/x', text, inv.research.graph).findings.some((f) => f.code === 'UNKNOWN_LINK'));
    const src = A.renderSources(inv.research.graph);
    chk('the sources list every finding with URL, class, published and retrieved times', /\[1\] .*https:\/\/github\.com\/nflverse.*official.*published .*retrieved/.test(src), src);
  }
  /* ═══ the rules tightened while wiring the host ═══════════════════════ */
  {
    /* an official report vs a credible one 28 h NEWER: nothing settles it */
    const fs = [
      A.normalize({ url: NFLV, kind: 'OFFICIAL_REPORT', retrieved_at: T(1800), published_at: T(1800), team: 'Buffalo Bills', player: 'Josh Allen', topic: 'availability', status: 'Out', text: 'Josh Allen Out' }),
      A.normalize({ url: 'https://www.espn.com/nfl/story/x', retrieved_at: T(100), published_at: T(120), team: 'Buffalo Bills', player: 'Josh Allen', topic: 'availability', status: 'ACTIVE', text: 'Josh Allen will play Sunday' }),
    ];
    const c = A.conflicts(fs)[0];
    chk('a credible report ≥ 6 h newer than the official one leaves the conflict UNRESOLVED', c && c.unresolved && /hours newer/.test(c.why_unresolved), c);
    const fs2 = [
      A.normalize({ url: NFLV, kind: 'OFFICIAL_REPORT', retrieved_at: T(60), published_at: T(60), team: 'Buffalo Bills', player: 'Josh Allen', topic: 'availability', status: 'Out', text: 'Josh Allen Out' }),
      A.normalize({ url: 'https://www.espn.com/nfl/story/x', retrieved_at: T(100), published_at: T(120), team: 'Buffalo Bills', player: 'Josh Allen', topic: 'availability', status: 'ACTIVE', text: 'Josh Allen will play Sunday' }),
    ];
    const c2 = A.conflicts(fs2)[0];
    chk('…but an official report that is the newer one settles it by source tier', c2 && c2.resolved && /source tier/.test(c2.resolution.by) && c2.resolution.status === 'OUT', c2);
    /* the board's fair policy: a model that is not the board's price is a cross-check, never swapped in */
    const q = A.price({ market_type: 'spreads', model: { available: true, prices: false, tier: 'LEAN', probability: 0.52 }, market: { decimal: 1.95, book: 'FanDuel', captured_at: T(4), sharp_fair: 0.532 }, now: NOW, ttl_min: 90 });
    chk('prices:false keeps the sharp fair as the price and the model as a cross-check', q.fair_kind === 'SHARP_NO_VIG' && Math.abs(q.fair_probability - 0.532) < 1e-9 && q.model_view && q.model_view.probability === 0.52 && q.model_view.used_to_price === false && q.independent_fair_probability === null, q);
    /* conservative: a validated model price is never the more generous of the two fairs */
    const qc = A.price({ market_type: 'spreads', model: { available: true, tier: 'VALIDATED', probability: 0.56 }, market: { decimal: 1.95, book: 'FanDuel', captured_at: T(4), sharp_fair: 0.532 }, now: NOW, ttl_min: 90, conservative: true });
    chk('conservative: the sharp fair gives the lower EV, so the price is judged on it and the model becomes the cross-check', qc.fair_kind === 'SHARP_NO_VIG' && /lower EV/.test(qc.priced_on) && qc.model_view && qc.model_view.probability === 0.56, [qc.fair_kind, qc.priced_on, qc.model_view]);
    const qm = A.price({ market_type: 'spreads', model: { available: true, tier: 'VALIDATED', probability: 0.52 }, market: { decimal: 1.95, book: 'FanDuel', captured_at: T(4), sharp_fair: 0.532 }, now: NOW, ttl_min: 90, conservative: true });
    chk('…and when the model is the lower one it stays the price', qm.fair_kind === 'MODEL' && qm.independent_fair_probability === 0.52, [qm.fair_kind, qm.priced_on]);
    const qu = A.price({ market_type: 'h2h', model: { available: false, unavailable_why: 'the MLB model runs in the browser only and is not available to the desk' }, market: { decimal: 2.2, book: 'FanDuel', captured_at: T(4), sharp_fair: 0.4655 }, now: NOW, ttl_min: 90 });
    chk('no model: the adapter\'s own reason is carried, and no probability is invented', qu.independent_fair_probability === null && qu.model_view === null && /browser only/.test(qu.insufficient), qu.insufficient);
    /* disagreement: no model, and a reference line */
    eq('no independent model: NO_MODEL, never an edge', [DIS.diagnose({ model: { available: false }, market: { probability: 0.46 } }).verdict, DIS.diagnose({ model: { available: false } }).is_edge_evidence], ['NO_MODEL', false]);
    const ref = DIS.diagnose({ model: { available: true, tier: 'LEAN', line: -5 }, market: { line: -3, executable: false }, claims: [{ topic: 'availability', status: 'ACTIVE' }], quality: { checked: true } });
    chk('a reference line (no book, no odds) rules mispricing out', ref.causes.find((c) => c.cause === 'POTENTIAL_MISPRICING').assessment === 'RULED_OUT' && ref.verdict !== 'POTENTIAL_MISPRICING', ref.causes.find((c) => c.cause === 'POTENTIAL_MISPRICING'));
    /* the strategist: verified news after the quote */
    const raw = [{ url: 'https://www.mlb.com/news/x', kind: 'OFFICIAL', retrieved_at: T(20), published_at: T(30), team: 'Tampa Bay Rays', player: 'Taj Bradley', role: 'SP', key: true, topic: 'starter', status: 'STARTING', text: 'Taj Bradley will start' }];
    const inv = A.investigate({ candidate: { market: 'h2h', quote: { captured_at: T(60) } }, event: { id: 'g', sport: 'baseball_mlb', home: 'Cleveland Guardians', away: 'Tampa Bay Rays', kickoff: '2026-10-17T23:05:00Z' }, raw,
      model: { available: false, inputs: { starters: { home: 'Tanner Bibee', away: 'Shane Baz' } } }, market: { decimal: 2.2, book: 'FanDuel', captured_at: T(60), sharp_fair: 0.4655 }, audit: { status: 'CONFIRMED', reason: 'fixture', checks: [] }, now: NOW, ttl_min: 90 });
    chk('a verified starter change published after the quote: the strategist says the price may not reflect it', inv.strategist.checks.some((c) => c.id === 'PRICED_IN' && c.result === 'WARN' && /after the quote/.test(c.detail)), inv.strategist.checks.find((c) => c.id === 'PRICED_IN'));
    chk('…and the starter mismatch holds the candidate for research', inv.classification.classification === 'RESEARCH_REQUIRED' && /Shane Baz/.test(inv.classification.reasons[0]) && /Taj Bradley/.test(inv.classification.reasons[0]), inv.classification);
    /* the communicator may not report news */
    const det = 'Market: Buffalo Bills -2.5\nEstimated net EV: 3.74% per $1\nFinal status: VERIFIED CANDIDATE';
    chk('a person the result never named fails the critic', A.critic(det + '\nJames Cook is the key.', det, null).findings.some((f) => f.code === 'UNKNOWN_NAME'));
    chk('a status claim the result never made fails the critic', A.critic(det + '\nHe was ruled out.', det, null).findings.some((f) => f.code === 'NEW_STATUS_CLAIM'));
    eq('the deterministic text passes its own critic', A.critic(det, det, null).verdict, 'PASS');
    /* the ledger: a turn's cost, and a bounded log */
    let clock = NOW;
    const L = B.ledger({ now: () => clock, paid_authorized: true, configured: { brave_search: true } });
    await L.call({ provider: 'brave_search', key: 'a', topic: 'news' }, async () => 1);
    L.newTurn();
    await L.call({ provider: 'brave_search', key: 'b', topic: 'news' }, async () => 2);
    chk('report({turn:true}) counts only this turn\'s calls; the ledger keeps the total', L.report({ turn: true }).by_provider.brave_search.calls === 1 && L.report().by_provider.brave_search.calls === 2 && L.report({ turn: true }).scope === 'turn', [L.report({ turn: true }).by_provider, L.report().by_provider]);
    const L2 = B.ledger({ now: () => clock });
    for (let i = 0; i < 1200; i++) await L2.call({ provider: 'open_meteo', key: 'k' + i, topic: 'weather' }, async () => i);
    chk('the usage log is bounded in a long-lived instance', L2.report().log.length <= 60 && L2.report().by_provider.open_meteo.calls <= 1000, L2.report().by_provider.open_meteo);
  }
  /* ═══ what a stale price may be called (seen on production, 12 Oct 2026) ═══
     A 55-hour-old quote was printed as "Verified market price" with a green +1.66% EV beside it; research freshness
     said "newest 0 min ago" from a re-read time on a day-old report; a total was signed (+54.5) and said to "cover". */
  {
    require(path.join(ROOT, 'lib', 'edgedesk_intel_ui.js'));
    const UI = globalThis.EDINTELUI;
    const staleQ = A.price({ market_type: 'totals', model: { available: false }, market: { decimal: 1.98, book: 'DraftKings', captured_at: T(3333), sharp_fair: 0.513 }, now: NOW, ttl_min: 45 });
    const freshQ = A.price({ market_type: 'totals', model: { available: false }, market: { decimal: 1.98, book: 'DraftKings', captured_at: T(4), sharp_fair: 0.513 }, now: NOW, ttl_min: 45 });
    chk('fixture: the stale quote is STALE and still evaluated, the fresh one is current', staleQ.evaluation.ok && staleQ.evaluation.data_freshness.quote.status === 'STALE' && staleQ.evaluation.net_ev_per_dollar != null && freshQ.evaluation.data_freshness.quote.status !== 'STALE', [staleQ.evaluation.data_freshness, freshQ.evaluation.data_freshness]);
    const findings = [
      { id: 'f_00000001', claim: 'Ed Oliver (DE) Out', topic: 'availability', reliability: 'OFFICIAL', verified: true, published_at: T(1958), retrieved_at: T(0), source_url: NFLV },
      { id: 'f_00000002', claim: 'Quentin Lake (S) Questionable', topic: 'availability', reliability: 'OFFICIAL', verified: true, published_at: null, retrieved_at: T(0), source_url: NFLV }
    ];
    const asRow = (q) => ({ quant: q, candidate: { matchup: 'Buffalo Bills @ Los Angeles Rams', sport_label: 'NFL', market_label: 'Under 54.5', book: 'DraftKings' }, event: { sport: 'americanfootball_nfl' },
      classification: { final_status: 'PASS', label: 'UNVERIFIED', reasons: ['The quote is stale.'] }, confidence: { model_reliability: { label: 'market-derived reference' } }, research: { findings } });
    const tStale = A.renderCandidate(asRow(staleQ)), tFresh = A.renderCandidate(asRow(freshQ));
    chk('STALE: the text does not call a stale quote a verified price', /Verified market price: none current — last captured [+-]\d+/.test(tStale) && !/Verified market price: [+-]\d/.test(tStale), /Verified market price: [^\n]+/.exec(tStale)[0]);
    chk('STALE: …its EV is said to be on the stale capture, not a current edge', /Estimated net EV: -?\d+\.\d+% per \$1 on the stale capture — unavailable as a current edge/.test(tStale), /Estimated net EV: [^\n]+/.exec(tStale)[0]);
    chk('FRESH: a current quote keeps the plain wording', /Verified market price: [+-]\d+ \(implies/.test(tFresh) && !/stale capture/.test(tFresh), [/Verified market price: [^\n]+/.exec(tFresh)[0], /Estimated net EV: [^\n]+/.exec(tFresh)[0]]);
    chk('STALE: the critic still holds the price and the EV to the text', A.critic('PASS. ' + tStale.split('\n').filter((l) => /Estimated net EV|Verified market price|Maximum acceptable price|Break-even probability|Independent fair probability|Final status/.test(l)).join(' '), tStale, null).findings.every((f) => f.code !== 'DROPPED_OR_CHANGED'));
    chk('freshness is the newest PUBLICATION time, and an undated finding is said to be undated', new RegExp('Research freshness: 2 findings, newest published ' + T(1958).slice(0, 16).replace('T', ' ') + ' UTC; 1 with no publication time').test(tStale), /Research freshness: [^\n]+/.exec(tStale)[0]);
    /* the card the subscriber sees */
    const cardRow = (q) => ({ candidate: { selection: 'Under', market: 'totals', line: 54.5, matchup: 'Buffalo Bills @ Los Angeles Rams', sport: 'americanfootball_nfl', game_id: 'g1', quote: { book: 'DraftKings' } },
      evaluation: q.evaluation, research: { findings, fair_probability: 0.513, fair_kind: 'SHARP_NO_VIG', model_view: { probability: 0.469, tier: 'RESEARCH' } }, classification: { classification: 'UNVERIFIED', final_status: 'PASS', reasons: ['The quote is stale.'] }, audit: {} });
    const kvOf = (html) => { const o = {}; html.replace(/<dt>([^<]+)<\/dt><dd>([\s\S]*?)<\/dd><\/div>/g, (m, k, v) => { if (!(k in o)) o[k] = v.replace(/<[^>]+>/g, '').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim(); }); return o; };
    const cS = UI.candidateCardHTML(cardRow(staleQ), []), kS = kvOf(cS), kF = kvOf(UI.candidateCardHTML(cardRow(freshQ), []));
    chk('CARD STALE: the price field says none is current and gives the capture\'s age and limit', /^none current — last captured [+-]\d+ at DraftKings, 3333 min old against a \d+ min limit/.test(kS['Verified market price'] || ''), kS['Verified market price']);
    chk('CARD STALE: the EV is unavailable, not a green number', /^unavailable — no current price/.test(kS['Estimated net EV'] || '') && !/ia-pos/.test(cS.split('Estimated net EV')[1].split('</dd>')[0]), kS['Estimated net EV']);
    chk('CARD STALE: the calculations section says its figures are not current', /Computed on the last captured price, which is stale/.test(cS));
    chk('CARD FRESH: a current price and its EV read as before', /^[+-]\d+ at DraftKings/.test(kF['Verified market price'] || '') && /^-?\d+\.\d+% per \$1/.test(kF['Estimated net EV'] || ''), [kF['Verified market price'], kF['Estimated net EV']]);
    chk('CARD: freshness is by publication time, not the re-read', /^2 findings, newest published (\d+ h|\d+ days) ago; 1 with no publication time$/.test(kS['Research freshness'] || '') && !/0 min ago/.test(kS['Research freshness'] || ''), kS['Research freshness']);
    chk('CARD: a total\'s projection names its side, not "covers"', /^under 46\.9%/.test(kS['Model projection'] || ''), kS['Model projection']);
    /* the disagreement line on a total carries no sign; a spread keeps its sign */
    const dT = DIS.diagnose({ market_type: 'totals', model: { available: true, tier: 'RESEARCH', line: 54.5, line_kind: 'BLEND' }, market: { line: 54.5, stale: true } });
    const dS = DIS.diagnose({ market_type: 'spreads', model: { available: true, tier: 'RESEARCH', line: -3.5, line_kind: 'BLEND' }, market: { line: -2.5, stale: true } });
    chk('a total\'s pricing line is printed without a sign', /pricing line \(54\.5, .*the market \(54\.5\)/.test(dT.explanation) && !/\+54\.5/.test(dT.explanation), dT.explanation);
    chk('…a spread keeps its sign', /pricing line \(-3\.5, .*the market \(-2\.5\)/.test(dS.explanation), dS.explanation);
    const Q = require(path.join(FN, '_quant.js'));
    const mlT = Q.matchupLine({ market: 'totals', selection: 'Under', model_case: { cover_at_market: 0.469, break_even: 0.508, tier: 'RESEARCH' } });
    const mlS = Q.matchupLine({ market: 'spreads', selection: 'Buffalo Bills', model_case: { cover_at_market: 0.56, break_even: 0.524, tier: 'LEAN' } });
    chk('the matchup line on a total names the side and says whose break-even it is', /46\.9% for the under against 50\.8% needed at the price its pricing check used/.test(mlT) && !/cover/.test(mlT), mlT);
    chk('…a spread still covers', /56\.0% to cover against 52\.4% needed/.test(mlS), mlS);
  }
  await done();
})().catch((e) => { console.error(e); process.exit(1); });
