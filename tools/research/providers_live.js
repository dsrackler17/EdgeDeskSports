#!/usr/bin/env node
/* ===========================================================================
   LIVE PROVIDER CHECK — the only script that calls a real research provider.
   It is NOT run in CI and has NOT been run from the build environment.

   It sends ONE real request per provider you name, through the same request
   builder and parser the edge function uses (lib/edgedesk_providers.js), and
   prints what came back: the response shape, the citations kept and refused,
   and the cost read from the response. Use it to:
     - confirm the Claude web search wiring with your own key before enabling
       claude_web_search;
     - confirm the Perplexity Search API schema before setting
       EDGEDESK_PERPLEXITY_SCHEMA_VERIFIED=1 (the edge function refuses to call
       Perplexity until that is set).

   It costs money (about $0.07–0.13 for one Claude web search on Opus 5.5,
   about $0.005–0.01 for one Perplexity request) and runs only when you say so:

     EDGEDESK_LIVE_PROVIDERS=1 ANTHROPIC_API_KEY=… node tools/research/providers_live.js claude
     EDGEDESK_LIVE_PROVIDERS=1 EDGEDESK_PERPLEXITY_API_KEY=… node tools/research/providers_live.js perplexity
     optional: --home "Buffalo Bills" --away "Detroit Lions" --sport NFL --model claude-sonnet-5-5

   Keys are read from the environment and sent only in request headers; this
   script never prints them.
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
require(path.join(ROOT, 'lib', 'edgedesk_evidence.js'));
const P = require(path.join(ROOT, 'lib', 'edgedesk_providers.js'));

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const which = args.filter((a) => a === 'claude' || a === 'perplexity');

if (process.env.EDGEDESK_LIVE_PROVIDERS !== '1') {
  console.log('SKIPPED: live provider calls cost money and run only with EDGEDESK_LIVE_PROVIDERS=1 (see the header of this file).');
  process.exit(0);
}
if (!which.length) { console.log('Name a provider: claude | perplexity'); process.exit(2); }
if (typeof fetch !== 'function') { console.log('This script needs Node 18+ (global fetch).'); process.exit(2); }

const event = { sport_label: opt('sport', 'NFL'), home: opt('home', 'Buffalo Bills'), away: opt('away', 'Detroit Lions'), kickoff: opt('kickoff', null), game_id: 'live-check' };
const now = Date.now();

async function claude() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { console.log('claude: ANTHROPIC_API_KEY is not set'); return false; }
  const model = opt('model', process.env.EDGEDESK_RESEARCH_MODEL || 'claude-opus-5-5');
  const req = P.claudeSearchRequest({ model, question: 'What is the latest injury and lineup news for this game?', event });
  console.log('claude: POST ' + req.url + ' model ' + model + ', ' + req.body.tools[0].allowed_domains.length + ' allowed domains, estimate $' + req.est_usd);
  const t0 = Date.now();
  let resp = await fetch(req.url, { method: 'POST', headers: Object.assign({}, req.headers, { 'x-api-key': key }), body: JSON.stringify(req.body) });
  let j = await resp.json().catch(() => null);
  if (!resp.ok) { console.log('claude: HTTP ' + resp.status + ' ' + JSON.stringify(j && j.error || j).slice(0, 300)); return false; }
  let parsed = P.parseClaudeSearch(j, { now, event, model, request: req });
  if (parsed.status === 'PAUSED') {
    console.log('claude: pause_turn — resuming once with the paused assistant turn');
    resp = await fetch(req.url, { method: 'POST', headers: Object.assign({}, req.headers, { 'x-api-key': key }), body: JSON.stringify(Object.assign({}, req.body, { messages: parsed.continuation.messages })) });
    j = await resp.json().catch(() => null);
    const first = parsed.cost.usd; parsed = P.parseClaudeSearch(j, { now, event, model, request: req }); parsed.cost.usd += first;
  }
  console.log('claude: ' + (Date.now() - t0) + ' ms, stop_reason ' + parsed.stop_reason + ', status ' + parsed.status + (parsed.errors.length ? ', errors ' + parsed.errors.join('; ') : ''));
  console.log('claude: block types ' + JSON.stringify([...new Set((j.content || []).map((b) => b.type))]));
  console.log('claude: citation report ' + JSON.stringify(P.citationReport(parsed)));
  console.log('claude: cost $' + parsed.cost.usd.toFixed(4) + ' (' + parsed.cost.basis + '); usage ' + JSON.stringify(j.usage));
  parsed.findings_raw.slice(0, 6).forEach((f, i) => console.log('  [' + (i + 1) + '] ' + f.url + ' (' + (f.published_at || 'undated') + ')\n      "' + f.text + '"'));
  parsed.refused.forEach((r) => console.log('  refused: ' + (r.url || '—') + ' — ' + r.why));
  return parsed.ok;
}
async function perplexity() {
  const key = process.env.EDGEDESK_PERPLEXITY_API_KEY;
  if (!key) { console.log('perplexity: EDGEDESK_PERPLEXITY_API_KEY is not set'); return false; }
  const req = P.perplexityRequest({ event });
  console.log('perplexity: POST ' + req.url + ' body ' + JSON.stringify(req.body) + ' (schema UNVERIFIED — this run checks it)');
  const resp = await fetch(req.url, { method: 'POST', headers: Object.assign({}, req.headers, { authorization: 'Bearer ' + key }), body: JSON.stringify(req.body) });
  const j = await resp.json().catch(() => null);
  if (!resp.ok) { console.log('perplexity: HTTP ' + resp.status + ' ' + JSON.stringify(j).slice(0, 400)); return false; }
  console.log('perplexity: top-level keys ' + JSON.stringify(Object.keys(j || {})));
  const first = j && Array.isArray(j.results) ? j.results[0] : null;
  console.log('perplexity: first result keys ' + JSON.stringify(first ? Object.keys(first) : null));
  const parsed = P.parsePerplexity(j, { now, event });
  const shapeOk = !!first && ['title', 'url', 'snippet'].every((k) => k in first);
  console.log('perplexity: schema check ' + (shapeOk ? 'PASS (results[].title/url/snippet present)' : 'FAIL — do NOT set EDGEDESK_PERPLEXITY_SCHEMA_VERIFIED') + '; parse status ' + parsed.status);
  console.log('perplexity: citation report ' + JSON.stringify(P.citationReport(parsed)));
  return shapeOk && parsed.ok;
}
(async () => {
  let okAll = true;
  for (const w of which) { try { okAll = (await (w === 'claude' ? claude() : perplexity())) && okAll; } catch (e) { console.log(w + ': ' + (e && e.message || e)); okAll = false; } }
  console.log(okAll ? 'LIVE CHECK PASSED for: ' + which.join(', ') : 'LIVE CHECK FAILED — see above');
  process.exit(okAll ? 0 : 1);
})();
