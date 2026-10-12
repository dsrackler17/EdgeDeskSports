#!/usr/bin/env node
/* ===========================================================================
   THE RESEARCH BENCHMARK — every question in questions.js through the REAL
   handler (harness.js), scored on what the brief asks to measure:

     routing      the answer came from the path the question needs
     accuracy     every expectation the item states held
     citations    every link the subscriber sees was handed to the handler by
                  the fixture network (none invented); search evidence never
                  comes from a refused citation
     quantitative the engine's own verification (EDQVERIFY): calculation
                  records recomputed, every number in the answer traced
     unsupported  certainty words, numbers no calculation produced, an
                  actionable verdict where the evidence forbids one, a price
                  attributed to a book when no price was captured
     latency      wall time per question on this machine, against the fixture
                  network (NOT production latency: no real network, no model)
     cost         model and search calls; dollars estimated from the request the
                  handler actually built (input ≈ characters ÷ 4) at the
                  documented per-token price, output at its max_tokens ceiling

   RECORDED RESPONSES ONLY. A MODEL_DESK item is scored on its route and the
   evidence the model was handed — the reply is a fixed recorded string, so its
   quality is not measured here (that needs tools/research/providers_live.js
   with a key, run separately).

   Run: node --experimental-strip-types --no-warnings tools/research/benchmark/run.js
          [--discover]  print every item's observed outcome
          [--json PATH] write the full results
          [--md PATH]   write the markdown report section
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const HARNESS = require('./harness.js');
const { Q, CERTAINTY } = require('./questions.js');

/* USD per million tokens. claude-sonnet-5: the Claude models overview prices Sonnet 5.5 "at the same prices" as Sonnet 5 ($2 / $10). The others: lib/edgedesk_providers.js PRICES_PER_MTOK. */
const PRICES = Object.assign({ 'claude-sonnet-5': { input: 2, output: 10 } }, require(path.join(ROOT, 'lib', 'edgedesk_providers.js')).PRICES_PER_MTOK);
const BOOKS = /\((?:[+-]\d{3,4}), (?:FanDuel|DraftKings|BetMGM|Caesars|Pinnacle|BetRivers|ESPN BET)\)/;
const NO_PRICE_SCENARIOS = new Set(['no_odds', 'db_down']);
/* PROVENANCE LINKS: data that reached the handler through one of EdgeDesk's own builds, cited at the upstream location it
   came from (or where the reader can check it). Each pattern names the code that reads that location. Counted apart from
   the links the handler was served; anything matching neither is INVENTED. */
const PROVENANCE = [
  { rx: /^https:\/\/github\.com\/nflverse\/nflverse-data\/releases\/download\/depth_charts\/depth_charts_\d{4}\.csv$/, read_by: 'football/starters/build_starters.js (the starters build behind metrics.json "starter", source "nflverse depth charts")' },
  { rx: /^https:\/\/statsapi\.mlb\.com\/api\/v1\/schedule\?sportId=1&date=\d{4}-\d{2}-\d{2}&hydrate=probablePitcher$/, read_by: 'MLB\'s probable-pitcher listing for the card\'s date; the edge function\'s MLB fallback reads the same endpoint (supabase/functions/edgedesk_ai/_lib.ts). The card (mlb_game_cards) is filled outside this repository, so this is a link to check the claim, labelled "via EdgeDesk\'s MLB card"' }
];
const provenanceOf = (u) => PROVENANCE.find((p) => p.rx.test(u)) || null;

function boxOf(j) { return j ? (j.scan || j.research_slate || j.game_research || null) : null; }
function routeOf(r) {
  const j = r.json || {};
  if (j.quant && j.quant.intent) return j.quant.intent;
  if (j.support_boundary) return 'UNSUPPORTED';
  /* EdgeDesk's deterministic desk (its answer may be rephrased by the model under the desk critic) and the other deterministic desks */
  if (j.desk || j.personnel || j.lines || j.props || j.opportunity) return 'DESK';
  /* everything else is the existing full pipeline: the research packet and the model desk */
  return 'MODEL_DESK';
}
function actionableOf(j, answer) {
  const b = boxOf(j);
  if (/BEST VERIFIED RESEARCH CANDIDATE/.test(answer)) return true;
  if (b && b.final_status === 'VERIFIED CANDIDATE') return true;
  if (b && Array.isArray(b.investigated) && b.investigated.some((x) => x && x.classification && x.classification.classification === 'VERIFIED_CANDIDATE')) return true;
  return false;
}
function urlsSeen(j, answer) {
  const out = new Set();
  (answer.match(/https?:\/\/[^\s)\]>"']+/g) || []).forEach((u) => out.add(u.replace(/[.,;:]+$/, '')));
  const walk = (o, d) => {
    if (!o || d > 12) return;
    if (Array.isArray(o)) { o.forEach((x) => walk(x, d + 1)); return; }
    if (typeof o === 'object') Object.keys(o).forEach((k) => { if (k === 'refused' || k === 'refused_citations') return; const v = o[k]; if (/^(url|source_url|href|link)$/.test(k) && typeof v === 'string' && /^https?:/.test(v)) out.add(v); else walk(v, d + 1); });
  };
  const b = boxOf(j);
  /* what the subscriber sees: the answer, the evidence ledgers and the sources lists of the research payload */
  if (b) walk(b, 0);
  if (j && j.sources) walk(j.sources, 0);
  return [...out];
}
function servedHas(served, u) {
  if (served.has(u)) return true;
  for (const s of served) { if (s.startsWith(u) || u.startsWith(s.replace(/[.,;:]+$/, ''))) return true; }
  return false;
}
function tokensOfBody(b) { const chars = JSON.stringify(b.system || '').length + JSON.stringify(b.messages || []).length + JSON.stringify(b.tools || []).length; return Math.ceil(chars / 4); }
function modelCost(bodies) {
  let usd = 0, inTok = 0, outCap = 0, unpriced = [];
  bodies.forEach((b) => {
    const t = tokensOfBody(b), p = PRICES[b.model];
    inTok += t; outCap += Number(b.max_tokens) || 0;
    if (!p) { unpriced.push(b.model); return; }
    usd += t * p.input / 1e6 + (Number(b.max_tokens) || 0) * p.output / 1e6;
  });
  return { usd: Math.round(usd * 1e6) / 1e6, input_tokens_est: inTok, output_tokens_cap: outCap, unpriced };
}
function pct(a, n) { return n ? Math.round(a / n * 1000) / 10 : null; }
function quantile(xs, q) { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))] * 10) / 10; }

function score(item, r) {
  const j = r.json || {}, answer = String(j.answer || j.error || ''), route = routeOf(r), checks = [];
  const chk = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: ok ? undefined : detail });
  chk('route ' + item.route, route === item.route, route);
  chk('answered', item.degraded ? !r.err && (r.status >= 500 || answer.length > 0) : r.status === 200 && !r.err && answer.length > 0, { status: r.status, err: r.err });
  (item.has || []).forEach((re) => chk('has ' + re, re.test(answer), answer.slice(0, 300)));
  (item.not || []).forEach((re) => chk('not ' + re, !re.test(answer.replace(item.q, '')), (answer.match(re) || [])[0]));
  const actionable = actionableOf(j, answer);
  if (item.actionable !== undefined) chk('actionable ' + item.actionable, actionable === item.actionable, actionable);
  const qv = j.quant_verification || null;
  if (item.verified) chk('verified ' + item.verified, qv && qv.verdict === item.verified, qv && qv.verdict);
  const modelText = r.model_bodies.map((b) => JSON.stringify(b.system || '') + JSON.stringify(b.messages || [])).join('\n');
  (item.grounded || []).forEach((re) => chk('model given ' + re, route !== 'MODEL_DESK' || re.test(modelText), 'not in the model request'));
  if (item.model_calls !== undefined) chk('model calls ' + item.model_calls, r.model_calls === item.model_calls, r.model_calls);
  if (item.search_calls !== undefined) chk('search calls ' + item.search_calls, r.search_calls === item.search_calls, r.search_calls);
  if (item.search === 'ok') chk('search ran and its evidence reached the ledger', r.search_calls >= 1 && JSON.stringify(boxOf(j) || {}).indexOf('"provider":"claude_web_search"') >= 0, r.search_calls);
  if (item.search === 'fail') chk('search failed and the answer still stands on the internal research', r.search_calls >= 1 && answer.length > 0 && route === item.route, r.search_calls);
  chk('no odds request', r.odds_calls === 0, r.odds_calls);

  /* citations: every link seen was handed to the handler; search evidence never from a refused citation */
  const urls = urlsSeen(j, answer);
  const provenance = urls.filter((u) => !servedHas(r.served, u) && provenanceOf(u));
  const invented = urls.filter((u) => !servedHas(r.served, u) && !provenanceOf(u));
  const refused = (() => { const b = boxOf(j); const rows = b ? [b.best, ...(b.investigated || []), ...(b.verified_rest || [])].filter(Boolean) : []; const bad = new Set(); rows.forEach((x) => ((x.search && x.search.refused) || []).forEach((f) => f && f.url && bad.add(f.url))); return urls.filter((u) => bad.has(u)); })();
  chk('no invented link', invented.length === 0, invented.slice(0, 3));
  chk('no refused citation used', refused.length === 0, refused);

  /* unsupported claims */
  const certainty = CERTAINTY.test(answer.replace(item.q, ''));
  const unsupportedNumbers = qv && qv.numbers && Array.isArray(qv.numbers.unsupported) ? qv.numbers.unsupported.length : 0;
  const inventedPrice = NO_PRICE_SCENARIOS.has(item.scenario || 'base') && BOOKS.test(answer);
  chk('no certainty word', !certainty, (answer.match(CERTAINTY) || [])[0]);
  chk('no number without a calculation', unsupportedNumbers === 0, qv && qv.numbers && qv.numbers.unsupported);
  chk('no invented price', !inventedPrice, (answer.match(BOOKS) || [])[0]);
  if (item.degraded) chk('says the model is unavailable', !/RECORDED REPLY/.test(answer) && (r.status >= 500 || /unavailable|could not|try again|did not respond|failed/i.test(answer)), answer.slice(0, 200));

  const cost = modelCost(r.model_bodies);
  const box = boxOf(j);
  const searchUsd = box && box.research_summary && box.research_summary.search ? Number(box.research_summary.search.cost_usd) || 0 : 0;
  return {
    id: item.id, cat: item.cat, q: item.q, scenario: item.scenario || 'base', expected_route: item.route, route, ok: checks.every((c) => c.ok), known_gap: item.known_gap || null,
    route_ok: route === item.route, checks, failed: checks.filter((c) => !c.ok),
    actionable, quant: qv ? { verdict: qv.verdict, ledgers: qv.ledgers, computed: qv.computed, checked: qv.checked, agreed: qv.agreed, mismatches: (qv.mismatches || []).length, numbers: qv.numbers ? { verdict: qv.numbers.verdict, checked: qv.numbers.checked, supported: qv.numbers.supported, unsupported: unsupportedNumbers } : null } : null,
    urls: urls.length, provenance_urls: provenance, invented_urls: invented, refused_urls: refused, certainty, unsupported_numbers: unsupportedNumbers, invented_price: inventedPrice,
    ms: Math.round(r.ms * 10) / 10, model_calls: r.model_calls, search_calls: r.search_calls, model_cost: cost, search_cost_usd: searchUsd,
    plan_path: j.research_plan ? j.research_plan.path : null, stream_events: r.events.length, status: r.status,
    answer_head: answer.split('\n').slice(0, 2).join(' / ').slice(0, 220)
  };
}

function summarize(rows) {
  const n = rows.length, cats = {};
  rows.forEach((r) => { const c = cats[r.cat] = cats[r.cat] || { n: 0, ok: 0, route_ok: 0 }; c.n++; if (r.ok) c.ok++; if (r.route_ok) c.route_ok++; });
  const withQ = rows.filter((r) => r.quant), ms = rows.map((r) => r.ms), byRoute = {};
  rows.forEach((r) => { const b = byRoute[r.route] = byRoute[r.route] || { n: 0, ms: [], model_calls: 0, model_usd: 0, search_calls: 0, search_usd: 0 }; b.n++; b.ms.push(r.ms); b.model_calls += r.model_calls; b.model_usd += r.model_cost.usd; b.search_calls += r.search_calls; b.search_usd += r.search_cost_usd; });
  Object.values(byRoute).forEach((b) => { b.p50_ms = quantile(b.ms, 0.5); b.p95_ms = quantile(b.ms, 0.95); delete b.ms; b.model_usd = Math.round(b.model_usd * 1e4) / 1e4; b.search_usd = Math.round(b.search_usd * 1e4) / 1e4; });
  const urls = rows.reduce((a, r) => a + r.urls, 0), invented = rows.reduce((a, r) => a + r.invented_urls.length, 0), prov = rows.reduce((a, r) => a + r.provenance_urls.length, 0);
  return {
    questions: n, categories: Object.keys(cats).length, by_category: cats,
    routing_accuracy_pct: pct(rows.filter((r) => r.route_ok).length, n),
    expectation_accuracy_pct: pct(rows.filter((r) => r.ok).length, n),
    citations: { links_seen: urls, served: urls - invented - prov, provenance: prov, provenance_patterns: PROVENANCE.map((p) => ({ pattern: String(p.rx), read_by: p.read_by })), invented: invented, refused_used: rows.reduce((a, r) => a + r.refused_urls.length, 0), validity_pct: urls ? pct(urls - invented, urls) : null },
    quantitative: { answers_with_verification: withQ.length, verified: withQ.filter((r) => r.quant.verdict === 'VERIFIED').length, calc_records_checked: withQ.reduce((a, r) => a + (r.quant.checked || 0), 0), calc_mismatches: withQ.reduce((a, r) => a + (r.quant.mismatches || 0), 0), numbers_checked: withQ.reduce((a, r) => a + ((r.quant.numbers && r.quant.numbers.checked) || 0), 0), numbers_unsupported: withQ.reduce((a, r) => a + ((r.quant.numbers && r.quant.numbers.unsupported) || 0), 0), numbers_pass: withQ.filter((r) => r.quant.numbers && r.quant.numbers.verdict === 'PASS').length },
    unsupported_claims: { certainty_words: rows.filter((r) => r.certainty).length, numbers_without_calculation: rows.reduce((a, r) => a + r.unsupported_numbers, 0), invented_prices: rows.filter((r) => r.invented_price).length, actionable_against_expectation: rows.filter((r) => r.failed.some((c) => /^actionable/.test(c.name))).length },
    latency_ms: { p50: quantile(ms, 0.5), p95: quantile(ms, 0.95), max: quantile(ms, 1), note: 'this machine, fixture network, recorded model replies — not production latency' },
    cost: { model_calls: rows.reduce((a, r) => a + r.model_calls, 0), model_questions: rows.filter((r) => r.model_calls > 0).length, model_usd_est: Math.round(rows.reduce((a, r) => a + r.model_cost.usd, 0) * 1e4) / 1e4, search_calls: rows.reduce((a, r) => a + r.search_calls, 0), search_usd: Math.round(rows.reduce((a, r) => a + r.search_cost_usd, 0) * 1e4) / 1e4, unpriced_models: [...new Set(rows.flatMap((r) => r.model_cost.unpriced))] },
    by_route: byRoute,
    failures: rows.filter((r) => !r.ok).map((r) => ({ id: r.id, q: r.q, scenario: r.scenario, route: r.route, expected: r.expected_route, known_gap: r.known_gap, failed: r.failed.map((c) => c.name + (c.detail !== undefined ? ' → ' + JSON.stringify(c.detail).slice(0, 160) : '')) })),
    /* a known gap still counts against accuracy above; it is listed so a new failure is never mistaken for an old one */
    known_gaps: rows.filter((r) => r.known_gap).map((r) => ({ id: r.id, gap: r.known_gap, reproduced: !r.ok })),
    unexpected_failures: rows.filter((r) => !r.ok && !r.known_gap).map((r) => r.id)
  };
}

async function run(o) {
  o = o || {};
  /* Two module instances share one process here, and the inlined kernels look some peers up on globalThis at call time,
     so a second instance would rewire the first. Every base item runs first; the search-enabled instance is created
     only after them. (In production one isolate holds one module.) */
  const items = (o.only ? Q.filter(o.only) : Q);
  const order = items.filter((x) => x.env !== 'search').concat(items.filter((x) => x.env === 'search'));
  const SFX = require(path.join(ROOT, 'tools', 'research', 'fixtures', 'claude_web_search_det_buf.json')).response;
  const base = await HARNESS.init({ tag: 'bench-base' });
  let search = null;
  const byId = {};
  for (const item of order) {
    if (item.env === 'search' && !search) search = await HARNESS.init({ tag: 'bench-search', env: { EDGEDESK_SEARCH_PROVIDERS: 'claude_web_search', EDGEDESK_RESEARCH_PAID_OK: '1' } });
    const H = item.env === 'search' ? search : base;
    const searchReply = item.search === 'ok' ? SFX : item.search === 'fail' ? { __status: 529 } : null;
    const r = await H.ask(item.q, { scenario: item.scenario, body: item.body, searchReply });
    byId[item.id] = score(item, r);
  }
  const rows = items.map((x) => byId[x.id]);
  if (o.discover) rows.forEach((s) => {
    console.log((s.ok ? 'ok  ' : 'FAIL') + ' ' + s.id + ' [' + s.scenario + '] ' + s.q);
    console.log('     route ' + s.route + (s.route_ok ? '' : ' (want ' + s.expected_route + ')') + ' | plan ' + s.plan_path + ' | model ' + s.model_calls + ' search ' + s.search_calls + ' | ' + Math.round(s.ms) + ' ms | actionable ' + s.actionable + (s.quant ? ' | qv ' + s.quant.verdict + '/' + (s.quant.numbers && s.quant.numbers.verdict) : ''));
    console.log('     ' + s.answer_head);
    s.failed.forEach((c) => console.log('     ✗ ' + c.name + (c.detail !== undefined ? '  ' + JSON.stringify(c.detail).slice(0, 240) : '')));
  });
  return { generated_with: 'tools/research/benchmark/run.js', clock: new Date(HARNESS.NOW).toISOString(), recorded_responses: true, summary: summarize(rows), rows };
}

function md(res) {
  const s = res.summary, L = [];
  const cat = Object.keys(s.by_category).map((k) => `| ${k.replace(/_/g, ' ')} | ${s.by_category[k].n} | ${s.by_category[k].route_ok} | ${s.by_category[k].ok} |`).join('\n');
  L.push(`**${s.questions} questions in ${s.categories} categories**, through the real handler with recorded responses (clock ${res.clock}).\n`);
  L.push('| Measure | Result |\n|---|---|');
  L.push(`| Routing accuracy | ${s.routing_accuracy_pct}% |`);
  L.push(`| Expectation accuracy (every check on the item held) | ${s.expectation_accuracy_pct}% |`);
  L.push(`| Citation validity (links the subscriber sees that the handler was actually given) | ${s.citations.validity_pct == null ? '—' : s.citations.validity_pct + '%'} of ${s.citations.links_seen} (${s.citations.served} served to the handler, ${s.citations.provenance} provenance links to the upstream source of an EdgeDesk build); ${s.citations.invented} invented, ${s.citations.refused_used} refused citations used |`);
  L.push(`| Quantitative correctness | ${s.quantitative.verified} of ${s.quantitative.answers_with_verification} engine answers VERIFIED; ${s.quantitative.calc_records_checked} calculation records recomputed, ${s.quantitative.calc_mismatches} mismatches; ${s.quantitative.numbers_checked} numbers in answers traced, ${s.quantitative.numbers_unsupported} unsupported |`);
  L.push(`| Unsupported claims | ${s.unsupported_claims.certainty_words} certainty words; ${s.unsupported_claims.numbers_without_calculation} numbers without a calculation; ${s.unsupported_claims.invented_prices} invented prices; ${s.unsupported_claims.actionable_against_expectation} actionable verdicts the evidence forbids |`);
  L.push(`| Latency (local, fixture network) | p50 ${s.latency_ms.p50} ms · p95 ${s.latency_ms.p95} ms · max ${s.latency_ms.max} ms |`);
  L.push(`| Cost | ${s.cost.model_calls} model calls on ${s.cost.model_questions} questions ≈ $${s.cost.model_usd_est.toFixed(4)} (estimated from the requests built); ${s.cost.search_calls} search calls, $${s.cost.search_usd.toFixed(4)} |`);
  L.push('\n| Category | Questions | Routed correctly | Every check held |\n|---|---|---|---|');
  L.push(cat);
  L.push('\n| Route | Questions | p50 ms | p95 ms | Model calls | Model $ (est.) | Search calls | Search $ |\n|---|---|---|---|---|---|---|---|');
  Object.keys(s.by_route).sort().forEach((k) => { const b = s.by_route[k]; L.push(`| ${k} | ${b.n} | ${b.p50_ms} | ${b.p95_ms} | ${b.model_calls} | ${b.model_usd.toFixed(4)} | ${b.search_calls} | ${b.search_usd.toFixed(4)} |`); });
  if (s.failures.length) {
    L.push('\n**Items that did not meet every expectation:**\n');
    s.failures.forEach((f) => L.push(`- \`${f.id}\` [${f.scenario}] "${f.q}" — ${f.known_gap ? 'KNOWN GAP: ' + f.known_gap + '. ' : ''}${f.failed.join('; ')}`));
  }
  return L.join('\n');
}

module.exports = { run, score, summarize, md, routeOf };
if (require.main === module) {
  const argv = process.argv.slice(2);
  const at = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const only = at('--only');
  run({ discover: argv.includes('--discover'), only: only ? (x) => new RegExp(only).test(x.id) : null }).then((res) => {
    /* the committed results: the summary and one line per item (its checks only when one failed) */
    if (at('--json')) fs.writeFileSync(at('--json'), JSON.stringify(Object.assign({}, res, { rows: res.rows.map((r) => { const o = Object.assign({}, r); delete o.checks; return o; }) }), (k, v) => v instanceof Set ? undefined : v, 1) + '\n');
    if (at('--md')) fs.writeFileSync(at('--md'), md(res) + '\n');
    const sm = res.summary;
    console.log(JSON.stringify({ questions: sm.questions, routing_accuracy_pct: sm.routing_accuracy_pct, expectation_accuracy_pct: sm.expectation_accuracy_pct, citations: { links_seen: sm.citations.links_seen, served: sm.citations.served, provenance: sm.citations.provenance, invented: sm.citations.invented, refused_used: sm.citations.refused_used },
      quantitative: sm.quantitative, unsupported_claims: sm.unsupported_claims, latency_ms: sm.latency_ms, cost: sm.cost, known_gaps: sm.known_gaps, unexpected_failures: sm.unexpected_failures }, null, 2));
    process.exit(0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
