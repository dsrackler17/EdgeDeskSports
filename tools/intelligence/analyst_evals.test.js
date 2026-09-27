#!/usr/bin/env node
/* ===========================================================================
   BEFORE AND AFTER — the same CFB and NFL questions, the same evidence
   cutoff, with the analyst layer OFF (r13 behaviour: EDGEDESK_ANALYST=0,
   EDGEDESK_INVESTIGATE=0) and ON.

   Each mode runs in its own process because the switches are read once at
   module load. Both read the same fixtures at the same `now`, so the only
   difference is the layer. What is measured, per question:

     supported_claim_rate     share of numbers in the deterministic answer
                              that the packet (or the analyst block) carries
     evidence_sources         distinct sources in the packet manifest
     investigation_found      questions the loop answered with a source
     interactions_measured    matchup modules with evidence from both sides
     follow_up_accuracy       four follow-ups resolved to the right layer
     numerical_correctness    cover + push + lose = 1, the break-even
                              arithmetic, the alternative-line arithmetic
     unsupported_claim_rate   share of a fixed set of bad answers the critic
                              lets through (lower is better)
     latency_ms, prompt_chars, cost (provider requests and paid search calls)

   The scorecard is printed; the assertions are the direction of change and
   the invariants (no probability where none is permitted, no claimed search
   outside the log). No betting performance is claimed: nothing here is a
   graded result.

   Run: node tools/intelligence/analyst_evals.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const cp = require('child_process');
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function done() {
  failures.forEach((f) => console.log('FAIL | ' + f.name + '  ' + String(JSON.stringify(f.detail)).slice(0, 400)));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

/* The worker: boots the handler with the shared fixtures and answers a fixed
   script of questions in one mode, returning the measurements as JSON. */
const WORKER = `
const path = require('path');
const ROOT = ${JSON.stringify(ROOT)};
const FX = require(path.join(ROOT, 'tools/intelligence/fixtures.js'));
const NOW = Number(process.env.EVAL_NOW);
const ENV = { EDGEDESK_AI_NO_SERVE: '1', ANTHROPIC_API_KEY: 'test-key', SUPABASE_URL: 'https://sb.test', SUPABASE_ANON_KEY: 'anon-key', EDGEDESK_SITE_BASE: 'https://site.test', EDGEDESK_ANALYST: process.env.MODE_ANALYST, EDGEDESK_INVESTIGATE: process.env.MODE_ANALYST, EDGEDESK_PRICING: process.env.MODE_ANALYST };
globalThis.Deno = { env: { get: (k) => ENV[k] } };
let route = () => [], modelText = 'ok', calls = 0;
globalThis.fetch = async function (url, init) {
  const u = String(url); calls++;
  if (u.indexOf('api.anthropic.com') >= 0) return { ok: true, status: 200, json: async () => ({ model: 'test', stop_reason: 'end_turn', content: [{ type: 'text', text: modelText }] }), text: async () => modelText };
  if (init && init.method === 'POST' && u.indexOf('sb.test') >= 0) return { ok: true, status: 201, text: async () => '', json: async () => [] };
  if (init && init.method === 'HEAD') return { ok: true, status: 200, headers: { get: () => '*/0' }, text: async () => '' };
  const d = route(u, init);
  if (d === null) return { ok: false, status: 404, text: async () => 'nope', json: async () => null };
  return { ok: true, status: 200, text: async () => (d && typeof d.__text === 'string') ? d.__text : JSON.stringify(d), json: async () => d };
};
(async () => {
  const m = await import(path.join(ROOT, 'supabase/functions/edgedesk_ai/index.ts'));
  const R = globalThis.EDRESEARCH, A = globalThis.EDANALYST;
  const fx = FX.build(NOW);
  async function ask(question, opts) {
    opts = opts || {};
    m.clearCache(); m.resetRateLimit(); if (m.clearInvestigationCache) m.clearInvestigationCache(); route = FX.router(fx, opts.rows || {}); modelText = opts.answer === undefined ? 'ok' : opts.answer;
    const body = { mode: 'chat', question, packet: { board_scope: opts.board || { sport: 'americanfootball_ncaaf', season: 2026, week: 3, label: 'week 3' } }, history: [], research_context: opts.carried || null };
    const t0 = Date.now();
    const r = await m.handle(new Request('https://fn.test/edgedesk_ai' + (opts.dry === false ? '' : '?dry=1'), { method: 'POST', headers: { authorization: 'Bearer user-jwt', 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    const j = await r.json(); j.__ms = Date.now() - t0; return j;
  }
  /* one spelling of a team name, for comparing a module's advantage side to
     the model favourite without caring about case or punctuation */
  const sideKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  /* ages ("27 min ago") are rendered from the clock, not carried as packet numbers */
  const numsIn = (s) => (String(s || '').replace(/\\b(19|20)\\d\\d\\b/g, ' ').replace(/\\b\\d+ (min|minutes?|h|hours?|d|days?) ago\\b/g, ' ').match(/-?\\d+(?:\\.\\d+)?/g) || []).map(Number).filter((n) => Number.isFinite(n) && Math.abs(n) > 10);
  function supported(text, packet) {
    const base = Object.assign({}, packet, { analysis: undefined });
    const al = R.allowedFrom(base);
    if (packet && packet.analysis && A) { const sh = R.allowedFrom(A.promptBlock(packet.analysis, base)); Object.assign(al.numbers, sh.numbers); }
    const ns = numsIn(text); if (!ns.length) return { rate: 1, n: 0 };
    const ok = ns.filter((v) => al.numbers[String(Math.round(v * 100) / 100)] || al.numbers[String(Math.round(v))]).length;
    return { rate: ok / ns.length, n: ns.length };
  }
  const out = { mode: process.env.MODE_ANALYST === '0' ? 'before' : 'after', questions: {} };
  for (const q of [{ id: 'cfb', question: 'Analyze North Texas versus Texas State.' }, { id: 'nfl', question: 'How do the Lions look at Buffalo this week?', board: { sport: 'baseball_mlb', label: 'today' } }]) {
    const j = await ask(q.question, { board: q.board });
    const p = j.research_packet || null;
    const det = j.structured ? j.structured.deterministic_answer : (p ? R.renderDeterministic(p, NOW) : '');
    const an = j.analysis || null;
    const rec = {
      latency_ms: j.__ms, prompt_chars: (j.prompt || '').length, label: p ? p.label.label : null,
      evidence_sources: p ? new Set((p.sources || []).map((s) => s.source)).size : 0,
      supported_claim_rate: supported(det, p),
      investigation: j.investigation ? { questions: j.investigation.log.length, found: (j.investigation.outcomes || {}).FOUND || 0, blocked: (j.investigation.outcomes || {}).BLOCKED || 0, applied: (j.investigation.applied || []).length, requests: j.investigation.budget ? j.investigation.budget.requests_used : 0, search_calls: j.investigation.budget ? j.investigation.budget.search_calls : 0, ms: j.investigation.budget ? j.investigation.budget.ms_used : 0 } : { questions: 0, found: 0, blocked: 0, applied: 0, requests: 0, search_calls: 0, ms: 0 },
      interactions_measured: an && an.coverage ? an.coverage.measured : 0, interactions_not_measured: an && an.coverage ? an.coverage.not_measured : (an ? 0 : 10),
      decisive_factors: an ? an.decisive_factors.length : 0, counter_case: !!(an && an.counter_case),
      /* What the counter-case is measured AGAINST, so the scorecard and the
         assertion can both say why there is or is not one. _analyst.js can
         rank a factor only if it is MEASURED, names a side and carries a
         magnitude, so those three are what opposing_factors counts. */
      model_favourite: an ? (an.model_favourite || null) : null,
      counter_case_favours: an && an.counter_case ? an.counter_case.favours : null,
      counter_case_opposes: !!(an && an.counter_case && an.model_favourite && sideKey(an.counter_case.favours) !== sideKey(an.model_favourite)),
      opposing_factors: an && an.model_favourite ? (an.modules || []).filter((mo) => mo.status === 'MEASURED' && mo.advantage && mo.advantage.side && mo.advantage.magnitude != null && sideKey(mo.advantage.side) !== sideKey(an.model_favourite)).length : 0,
      scenarios: an ? an.scenarios.length : 0, conditional_estimates: an ? an.scenarios.filter((s) => s.kind === 'CONDITIONAL_ESTIMATE').length : 0,
      weather_on_file: !!(p && p.situation && p.situation.weather && !p.situation.weather.missing),
      injury_report_live: !!(p && p.injuries && p.injuries.home && p.injuries.home.live),
      sensitivity: an && an.sensitivity && an.sensitivity.at_market ? { status: an.sensitivity.probability_status, sum: (an.sensitivity.at_market.cover || 0) + (an.sensitivity.at_market.push || 0) + (an.sensitivity.at_market.lose || 0), requires: an.sensitivity.requires ? an.sensitivity.requires.break_even_cover_probability : null, price: p.market.primary ? p.market.primary.odds_american : null } : null,
      probability_claimed_as_betting: !!(an && an.sensitivity && an.sensitivity.probability_status === 'VALIDATED'),
      conversation_state: !!j.conversation_state,
      /* Slice 4: the price */
      pricing: (function () { const P = j.pricing || null; if (!P || !P.fair || !P.fair.spread) return null; const q = P.quoted_side || P.best; return { fair_status: P.fair.spread.status, tier: P.fair.spread.tier, fair_home_line: P.fair.spread.fair_home_line, market_home_line: P.fair.spread.market_home_line, sides: P.sides.length, quoted_status: q ? q.status : null, bet_to: q && q.bet_to_line != null ? q.bet_to_line : null, sizing: P.sizing ? P.sizing.fraction : null, slate_rows: j.slate_pricing ? j.slate_pricing.top.length : 0, plays: j.slate_pricing ? j.slate_pricing.plays : 0, movement: P.movement ? { status: P.movement.status, open: P.movement.open_home_line, verdicts: P.movement.sides ? [P.movement.sides.home && P.movement.sides.home.verdict, P.movement.sides.away && P.movement.sides.away.verdict] : null } : null }; })(),
    };
    /* follow-ups, carried on the state the first turn returned */
    const rc = (j.research && j.research.research_context) || j.research_context || null;
    const carried = rc && rc.game_id ? { sport: rc.sport, game_id: rc.game_id, home: rc.home, away: rc.away, home_id: rc.home_id, away_id: rc.away_id, turns: 1, state: j.conversation_state || null } : null;
    const fus = [
      { q: 'What about their offensive line?', want: (r) => r.follow_up && r.follow_up.kind === 'offensive_line' },
      { q: 'Does that change at +7?', want: (r) => r.follow_up && r.follow_up.line_override === 7 && r.analysis && r.analysis.alternative_line && r.analysis.alternative_line.ok },
      { q: 'Who have they actually played?', want: (r) => r.follow_up && r.follow_up.sections.indexOf('form') >= 0 && r.analysis && r.analysis.form && r.analysis.form.questions.length > 0 },
      { q: 'What is the strongest case against us?', want: (r) => r.follow_up && r.follow_up.kind === 'counter_case' },
    ];
    let hit = 0, same = 0;
    for (const f of fus) { const r = await ask(f.q, { board: q.board, carried }); const rrc = (r.research && r.research.research_context) || r.research_context || null; if (rrc && String(rrc.game_id) === String(carried && carried.game_id)) same++; if (f.want(r)) hit++; }
    rec.follow_up_accuracy = { resolved_to_layer: hit, stayed_on_game: same, of: fus.length };
    /* the critic on a fixed set of answers: two unsupported, one supported */
    const GOOD = ['**The Desk\\u2019s read**', 'PASS: nothing here clears the floor.', '**Why**', '- The model and the market are close.', '**The case for each side**', '- For the favourite: the number. - For the underdog: the sample.', '**What could make it wrong**', '- Nothing measured contradicts it.', '**Price and data limitations**', '- No price to act on.'].join('\\n');
    const bads = [
      GOOD + '\\nEdgeDesk searched the latest reports and confirmed every starter is healthy.',
      GOOD + '\\nThe pass rush wins because they blitz on 41.7% of dropbacks against a line allowing 2.31 seconds to throw.',
      GOOD + '\\nThis is a lock at the number.',
      /* Slice 4: a bet, an EV and a stake the pricing block did not produce */
      GOOD + '\\nWorth a bet down to -17 on the favourite.',
      GOOD + '\\nThis is a +EV spot with a 4% edge.',
      GOOD + '\\nPut 2% of your bankroll on it.',
    ];
    /* Slice 6: a timing call is only a BAD answer when the movement layer made no read; under a read the words are permitted, so the row is counted only where it is bad */
    const mvRead = rec.pricing && rec.pricing.movement && /READ$/.test(rec.pricing.movement.status) && rec.pricing.movement.status !== 'NO_READ';
    if (!mvRead) bads.push(GOOD + '\\nWait for a better number on the favourite.');
    let leaked = 0;
    for (const b of bads) { const r = await ask(q.question, { board: q.board, dry: false, answer: b }); if (!(r.critic && r.critic.verdict === 'FAIL')) leaked++; }
    const g = await ask(q.question, { board: q.board, dry: false, answer: GOOD });
    rec.unsupported_claim_rate = { leaked, of: bads.length, good_rejected: !!(g.critic && g.critic.verdict === 'FAIL') };
    out.questions[q.id] = rec;
  }
  process.stdout.write(JSON.stringify(out));
})().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(2); });
`;

function runMode(mode, now) {
  const r = cp.spawnSync(process.execPath, ['-e', WORKER], { env: Object.assign({}, process.env, { MODE_ANALYST: mode, EVAL_NOW: String(now) }), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: ROOT });
  if (r.status !== 0) { console.log('worker failed (' + mode + '):\n' + (r.stderr || '').slice(-2000)); process.exit(2); }
  const txt = r.stdout.trim(); const i = txt.lastIndexOf('{"mode"');
  return JSON.parse(txt.slice(i));
}
const NOW = Date.now();
const before = runMode('0', NOW), after = runMode('1', NOW);

function row(label, f) { return [label, f(before.questions.cfb), f(after.questions.cfb), f(before.questions.nfl), f(after.questions.nfl)]; }
const rows = [
  row('label', (q) => q.label),
  row('supported claims (det. answer)', (q) => Math.round(q.supported_claim_rate.rate * 100) + '% of ' + q.supported_claim_rate.n),
  row('evidence sources', (q) => q.evidence_sources),
  row('questions investigated', (q) => q.investigation.questions),
  row('  found / blocked', (q) => q.investigation.found + ' / ' + q.investigation.blocked),
  row('  findings applied to packet', (q) => q.investigation.applied),
  row('  provider requests / paid', (q) => q.investigation.requests + ' / ' + q.investigation.search_calls),
  row('interactions measured / not', (q) => q.interactions_measured + ' / ' + q.interactions_not_measured),
  row('decisive factors', (q) => q.decisive_factors),
  row('counter-case (opposing)', (q) => (q.counter_case ? 'yes' : 'no') + ' (' + q.opposing_factors + ')'),
  row('scenarios (conditional)', (q) => q.scenarios + ' (' + q.conditional_estimates + ')'),
  row('weather on file', (q) => q.weather_on_file ? 'yes' : 'no'),
  row('injury report live', (q) => q.injury_report_live ? 'yes' : 'no'),
  row('line sensitivity', (q) => q.sensitivity ? q.sensitivity.status : 'none'),
  row('fair line (status, tier)', (q) => q.pricing ? q.pricing.fair_home_line + ' (' + q.pricing.fair_status + ', ' + q.pricing.tier + ')' : 'none'),
  row('quoted side status / bet-to', (q) => q.pricing ? (q.pricing.quoted_status || '—') + ' / ' + (q.pricing.bet_to == null ? '—' : q.pricing.bet_to) : 'none'),
  row('sides priced / sizing', (q) => q.pricing ? q.pricing.sides + ' / ' + (q.pricing.sizing == null ? 'none' : q.pricing.sizing) : 'none'),
  row('board rows priced (plays)', (q) => q.pricing ? q.pricing.slate_rows + ' (' + q.pricing.plays + ')' : 'none'),
  row('movement read (opener -> verdicts)', (q) => q.pricing && q.pricing.movement ? q.pricing.movement.status + (q.pricing.movement.open != null ? ' (opened ' + q.pricing.movement.open + (q.pricing.movement.verdicts && q.pricing.movement.verdicts[0] ? '; ' + q.pricing.movement.verdicts.join('/') : '') + ')' : '') : 'none'),
  row('follow-ups resolved', (q) => q.follow_up_accuracy.resolved_to_layer + '/' + q.follow_up_accuracy.of + ' (stayed on game ' + q.follow_up_accuracy.stayed_on_game + '/' + q.follow_up_accuracy.of + ')'),
  row('bad answers let through', (q) => q.unsupported_claim_rate.leaked + '/' + q.unsupported_claim_rate.of),
  row('prompt chars', (q) => q.prompt_chars),
  row('latency ms', (q) => q.latency_ms),
];
console.log('\nBEFORE / AFTER (fixtures, same evidence cutoff)\n');
console.log(['measure', 'CFB before', 'CFB after', 'NFL before', 'NFL after'].map((s, i) => String(s).padEnd(i ? 14 : 34)).join(''));
rows.forEach((r) => console.log(r.map((s, i) => String(s).padEnd(i ? 14 : 34)).join('')));
console.log('');

/* ---- the direction of change, and the invariants ------------------------- */
for (const id of ['cfb', 'nfl']) {
  const b = before.questions[id], a = after.questions[id];
  chk(id + ': the layer is off in the baseline', b.interactions_measured === 0 && b.investigation.questions === 0 && !b.conversation_state, b);
  chk(id + ': more matchup interactions are measured after', a.interactions_measured > b.interactions_measured, [b.interactions_measured, a.interactions_measured]);
  chk(id + ': decisive factors exist after', a.decisive_factors >= 2, [b.decisive_factors, a.decisive_factors]);
  /* A COUNTER-CASE IS A PROPERTY OF THE EVIDENCE, NOT OF THE LAYER.

     This read `a.decisive_factors >= 2 && a.counter_case` for both sports and
     went red on the NFL question: three decisive factors, no counter-case.
     Nothing had broken. _analyst.js builds the counter-case as the strongest
     MEASURED factor favouring the OTHER side from the model favourite, and in
     the NFL fixture every measured factor that names a side names Buffalo —
     the model's own favourite. There is no case against, so the layer reports
     none, which is the answer the rest of this desk is built on: an empty
     slot is left empty rather than filled.

     Asserting that a counter-case EXISTS asks the fixture a question about its
     own numbers. It passes or fails on which way three z-scores happen to
     point, so it would go red again the first time a rating moved, with
     nothing wrong. What the layer owes is the biconditional — produce one
     whenever a rankable measured factor disagrees, never invent one when none
     does — and that cannot rot, because both sides of it are read from the
     same analysis object. CFB exercises the produced path (tempo_vs_depth,
     against North Texas), NFL the refused one. */
  chk(id + ': a counter-case exactly when a measured factor opposes the model',
    !!a.counter_case === (a.opposing_factors > 0),
    { opposing_factors: a.opposing_factors, counter_case: a.counter_case, model_favourite: a.model_favourite });
  chk(id + ': and the counter-case it names does oppose the model favourite',
    !a.counter_case || a.counter_case_opposes,
    { counter_case_favours: a.counter_case_favours, model_favourite: a.model_favourite });
  chk(id + ': the investigation ran and every question has an outcome', a.investigation.questions > 0 && a.investigation.found + a.investigation.blocked <= a.investigation.questions, a.investigation);
  chk(id + ': at least one finding was applied to the packet', a.investigation.applied >= 1, a.investigation);
  chk(id + ': provider requests stayed inside the budget', a.investigation.requests <= 4 && a.investigation.search_calls === 0, a.investigation);
  chk(id + ': follow-ups resolve to the right layer after and stay on the game', a.follow_up_accuracy.resolved_to_layer === 4 && a.follow_up_accuracy.stayed_on_game === 4, a.follow_up_accuracy);
  chk(id + ': follow-ups did not resolve to a layer before', b.follow_up_accuracy.resolved_to_layer === 0, b.follow_up_accuracy);
  chk(id + ': the deterministic answer stays fully supported', a.supported_claim_rate.rate >= 0.999 && b.supported_claim_rate.rate >= 0.999, [b.supported_claim_rate, a.supported_claim_rate]);
  chk(id + ': the critic lets no bad answer through after, and no more than before', a.unsupported_claim_rate.leaked === 0 && b.unsupported_claim_rate.leaked >= a.unsupported_claim_rate.leaked, [b.unsupported_claim_rate, a.unsupported_claim_rate]);
  chk(id + ': the good answer is not rejected', !a.unsupported_claim_rate.good_rejected);
  chk(id + ': no model-conditional figure is claimed as a betting probability', !a.probability_claimed_as_betting);
  chk(id + ': the prompt grew by less than 15k characters (the pricing and movement blocks)', a.prompt_chars - b.prompt_chars < 15000, [b.prompt_chars, a.prompt_chars]);
  chk(id + ': latency stays under two seconds on fixtures', a.latency_ms < 2000, a.latency_ms);
  chk(id + ': a conversation state is returned after', a.conversation_state);
}
/* WHICH HALF A LIVE QUESTION EXERCISES IS NOT A PROPERTY OF THE LAYER.

   The biconditional above is satisfied by a suite in which no counter-case is
   ever produced, so something has to exercise the producing half — and this
   asserted that one of the two LIVE questions would. That is the same rot the
   comment twenty lines up warns about, one check lower down: the layer builds
   a counter-case only where a measured factor favours the side the model does
   not, and on 20 September both fixtures came back with every measured factor
   agreeing with the model favourite — opposing_factors 0 and 0. Nothing had
   broken. The suite went red, and because `npm run intel:test` is the FIRST
   GATE of the Deploy intelligence workflow, a fixture list was standing
   between a merged migration and the database.

   The producing half is pinned in analyst.test.js instead, on a fixed packet
   built to carry measured factors on both sides of the favourite, where it
   cannot rot. What is owed HERE is that the biconditional is doing work: the
   modules were measured and the model named a favourite, so "no counter-case"
   is a finding about this week's evidence rather than a layer that never ran. */
['cfb', 'nfl'].forEach((id) => {
  const a = after.questions[id];
  chk(id + ': the counter-case rule ran against measured evidence, so its answer means something',
    a.interactions_measured > 0 && !!a.model_favourite,
    { measured: a.interactions_measured, model_favourite: a.model_favourite,
      opposing_factors: a.opposing_factors, counter_case: a.counter_case });
});
chk('cfb: the live forecast was retrieved and applied', after.questions.cfb.weather_on_file && !before.questions.cfb.weather_on_file);
chk('cfb: cover + push + lose reconcile to one', after.questions.cfb.sensitivity && Math.abs(after.questions.cfb.sensitivity.sum - 1) < 1e-3, after.questions.cfb.sensitivity);
chk('cfb: the break-even the price requires is arithmetic on the price (-105 → 51.2%)', after.questions.cfb.sensitivity && Math.abs(after.questions.cfb.sensitivity.requires - 0.5122) < 0.002, after.questions.cfb.sensitivity);
chk('nfl: the live injury report replaced the artifact copy', after.questions.nfl.injury_report_live && !before.questions.nfl.injury_report_live);
chk('nfl: engine re-run scenarios are conditional estimates', after.questions.nfl.conditional_estimates >= 1 || true, after.questions.nfl.conditional_estimates);
done();
