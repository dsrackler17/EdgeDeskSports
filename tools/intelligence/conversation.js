#!/usr/bin/env node
/* ===========================================================================
   THE REAL CHAT PATH, DRIVEN AS A CONVERSATION.

   Not the deterministic answer renderer. This imports the DEPLOYED edge
   function and drives `handle()` through a six-question sequence exactly as
   app.html does it: the same POST body, the same `history` array grown turn by
   turn, the same board scope, the same fetch. Every layer the product runs is
   the real one —

     auth → intent classification → conversational state → staged retrieval
     (artifact, cfb.games, signals, cfb.lines, SP+, records, rosters,
     availability) → eligibility and priority → evidence packets → the
     deterministic decision pass → prompt assembly → the model call →
     copy validation → the presentation card → the ledger write

   — with exactly ONE substitution, named here because naming it is the point:

     THE MODEL'S OWN INFERENCE IS NOT EXERCISED. `fetch` to api.anthropic.com
     is answered by a stub. This environment has no Anthropic credential and
     no egress to the deployed function, so the text a real Claude would write
     cannot be produced here and is not claimed. What IS produced and checked
     is the exact prompt that reaches it, everything that built that prompt,
     and everything the response path does with what comes back.

   The database is fixtures for the same reason: there is no live Supabase in
   CI. The FBS slate and the availability artifact are the REAL committed files.

   Run: node tools/intelligence/conversation.js            (prints a transcript)
        node tools/intelligence/conversation.js --json     (machine readable)
   =========================================================================== */
'use strict';
const path = require('path');
const FX = require('./fixtures.js');

const ROOT = path.join(__dirname, '..', '..');

/** The six questions, in order, as a person would actually ask them. */
const SCRIPT = [
  { q: 'Any CFB matchups look good?', why: 'opens on the whole card' },
  { q: 'Analyze North Texas versus Texas State.', why: 'narrows to one game by name' },
  { q: 'Who have they played?', why: 'pure pronoun — carries no team name at all' },
  { q: 'Did opponent quality inflate their numbers?', why: 'still no name; needs the same matchup AND the ratings' },
  { q: 'What is the strongest argument against that lean?', why: 'refers to a conclusion from an earlier turn' },
  { q: 'What price makes it a pass?', why: 'time-sensitive: must re-read the price, not reuse it' },
];

const SCOPE = { sport: 'americanfootball_ncaaf', season: 2026, week: 3, label: 'week 3' };

async function run(opts) {
  opts = opts || {};
  const ENV = {
    EDGEDESK_AI_NO_SERVE: '1', ANTHROPIC_API_KEY: 'stub-key-no-network',
    SUPABASE_URL: 'https://sb.test', SUPABASE_ANON_KEY: 'anon-key',
    EDGEDESK_SITE_BASE: 'https://site.test',
  };
  globalThis.Deno = { env: { get: (k) => ENV[k] } };

  const fx = FX.build();
  let route = FX.router(fx);
  const asked = [];           /* every URL the server actually requested */
  const prompts = [];         /* every prompt that actually reached the model */
  let ledgerPosts = 0;

  globalThis.fetch = async function (url, init) {
    const u = String(url);
    if (u.indexOf('api.anthropic.com') >= 0) {
      /* THE ONE STUB. The prompt is captured verbatim; the reply is a fixed
         string, because no real inference happens in this environment. */
      const body = JSON.parse(init.body);
      /* The research prompt rides in the LAST user message; `system` is the
         standing contract. Both are captured, because "what reached the model"
         is the whole point of this artifact. */
      const last = (body.messages || [])[body.messages.length - 1] || {};
      prompts.push({
        system: body.system || '',
        user: String(last.content || ''),
        turns_of_history: Math.max(0, (body.messages || []).length - 1),
      });
      return {
        ok: true, status: 200,
        json: async () => ({ model: 'stub (no inference in this environment)',
          content: [{ type: 'text', text: '[model text not generated here — see the prompt artifact]' }] }),
        text: async () => 'stub',
      };
    }
    if (init && init.method === 'POST' && u.indexOf('sb.test') >= 0) {
      if (u.indexOf('recommendation_ledger') >= 0) ledgerPosts++;
      return { ok: true, status: opts.ledgerStatus || 201, text: async () => '', json: async () => [] };
    }
    if (init && init.method === 'HEAD') return { ok: true, status: 200, headers: { get: () => '*/0' }, text: async () => '' };
    asked.push(u);
    const d = route(u, init);
    if (d === null) return { ok: false, status: 404, text: async () => 'nope', json: async () => null };
    return { ok: true, status: 200, text: async () => JSON.stringify(d), json: async () => d };
  };

  const m = await import(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', 'index.ts'));

  const history = [];
  const turns = [];
  for (let i = 0; i < SCRIPT.length; i++) {
    const step = SCRIPT[i];
    const before = asked.length;
    m.clearCache();                       /* a new turn is a new request */
    const body = { mode: 'chat', question: step.q, packet: { board_scope: SCOPE }, history: history.slice(-8) };
    const mk = (qs) => new Request('https://fn.test/edgedesk_ai' + qs, {
      method: 'POST', headers: { authorization: 'Bearer user-jwt', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    /* ?dry=1 first: the same retrieval, exposing what the model WOULD get. */
    const dry = await (await m.handle(mk('?dry=1'))).json();
    m.clearCache();
    /* then the live path, which calls the model and renders the response. */
    const live = await (await m.handle(mk(''))).json();

    history.push({ role: 'user', content: step.q });
    history.push({ role: 'assistant', content: live.answer || '' });

    const reads = asked.slice(before);
    turns.push({
      n: i + 1, question: step.q, why: step.why,
      intent: (dry.intent && dry.intent.intent) || null,
      mode: (dry.intent && dry.intent.mode) || null,
      depth: (dry.intent && dry.intent.depth) || null,
      steps: (dry.intent && dry.intent.steps) || [],
      sport: dry.sport,
      teams: (dry.entities && dry.entities.teams) || [],
      /* The compact copy in the data path, and the full classification (with
         the sentence the answer is required to use) from the top level. */
      slate_state: dry.data_path && dry.data_path.slate_index && dry.data_path.slate_index.slate_state,
      slate: dry.slate_state || null,
      slate_source: dry.slate_source || null,
      coverage: dry.coverage_metrics || null,
      market_states: dry.data_path && dry.data_path.slate_ranking && dry.data_path.slate_ranking.market_states,
      packets: (dry.evidence_packets || []).map((p) => p.packet_id),
      decisions: (dry.decisions || []).map((d) => ({ decision: d.decision, selection: d.selection, why: d.why })),
      unsupported: dry.data_path && dry.data_path.declared_unavailable,
      reads_this_turn: reads.length,
      refreshed_price: reads.some((u) => /signals\?/.test(u)),
      prompt_chars: ((prompts[prompts.length - 1] || {}).user || '').length,
      system_chars: ((prompts[prompts.length - 1] || {}).system || '').length,
      history_turns_sent: (prompts[prompts.length - 1] || {}).turns_of_history || 0,
      prompt: (prompts[prompts.length - 1] || {}).user || '',
      system: (prompts[prompts.length - 1] || {}).system || '',
      answer: live.answer,
      ledger: live.ledger,
      presentation_verdict: live.presentation && live.presentation.simple && live.presentation.simple.verdict,
    });
  }
  return { turns, prompts, ledgerPosts, asked, model_stubbed: true };
}

module.exports = { run, SCRIPT, SCOPE };

if (require.main === module) {
  run().then((r) => {
    if (process.argv.includes('--json')) { console.log(JSON.stringify(r, null, 1)); return; }
    console.log('THE SIX-QUESTION SEQUENCE THROUGH THE REAL SERVER PATH');
    console.log('(model inference stubbed — no Anthropic credential in this environment)\n');
    r.turns.forEach((t) => {
      console.log('─'.repeat(78));
      console.log(`${t.n}. "${t.question}"   ${t.why}`);
      console.log(`   intent=${t.intent} depth=${t.depth} sport=${t.sport}`);
      console.log(`   teams carried: ${JSON.stringify(t.teams)}`);
      console.log(`   slate: ${t.slate_state && t.slate_state.state} `
        + `(${t.slate_state && t.slate_state.scheduled} scheduled) markets: ${JSON.stringify(t.market_states)}`);
      console.log(`   packets: ${t.packets.join(', ') || '(none)'}`);
      console.log(`   decisions: ${t.decisions.length ? t.decisions.map((d) => d.decision + ' ' + d.selection).join(' | ') : '(none)'}`);
      console.log(`   reads this turn: ${t.reads_this_turn}, re-read the price feed: ${t.refreshed_price}`);
      console.log(`   prompt to the model: ${t.prompt_chars} chars of evidence + ${t.system_chars} of contract,`
        + ` carrying ${t.history_turns_sent} earlier turn(s)`);
      console.log(`   ledger: ${t.ledger && t.ledger.state}${t.ledger && t.ledger.notice ? ' — ' + t.ledger.notice : ''}`);
    });
    console.log('─'.repeat(78));
  }).catch((e) => { console.error('CRASH', (e && e.stack) || e); process.exit(1); });
}
