#!/usr/bin/env node
/* ===========================================================================
   End-to-end tests for the edgedesk_ai edge function, run under Node.

   Node 22 strips TypeScript types natively, so the DEPLOYED file — not a
   copy — is imported with a Deno shim and a mocked fetch. Nothing here
   reaches a network. What is under test is the CONTRACT:

     - old callers ({mode, question, packet}) still get {answer, research}
     - the additive `presentation` object is built from the client's
       deterministic packet, never from the model
     - the model's copy block is split off the prose, validated, and merged
       ONLY where it passes; a LEAN stays LEAN however the model writes
     - a model failure still returns the deterministic card
     - ?dry=1 and ?probe=1 report the presentation layer without a model call

   Run: node tools/presentation/edgedesk_ai.test.js
   =========================================================================== */
'use strict';
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}
function done() {
  failures.forEach(function (f) { console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 500) : '')); });
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

/* ---- the Deno shim + mocked network, installed BEFORE the import ------- */
const ENV = {
  EDGEDESK_AI_NO_SERVE: '1', ANTHROPIC_API_KEY: 'test-key',
  SUPABASE_URL: 'https://sb.test', SUPABASE_ANON_KEY: 'anon-key',
};
globalThis.Deno = { env: { get: (k) => ENV[k] } };

const calls = [];
let anthropic = null;   // function(bodyJson) -> {status, json}
globalThis.fetch = async function (url, init) {
  const u = String(url);
  calls.push({ url: u, method: (init && init.method) || 'GET' });
  if (u.indexOf('api.anthropic.com') >= 0) {
    const body = JSON.parse(init.body);
    const r = anthropic ? anthropic(body) : { status: 500, json: { error: 'no mock' } };
    return { ok: r.status < 300, status: r.status, json: async () => r.json, text: async () => JSON.stringify(r.json) };
  }
  if (u.indexOf('sb.test') >= 0) {
    /* Every owned table answers empty: research runs, retrieves nothing, and
       the packet the client attached is the only deterministic source. */
    if (init && init.method === 'HEAD') return { ok: true, status: 200, headers: { get: () => '*/0' }, text: async () => '', json: async () => null };
    return { ok: true, status: 200, text: async () => '[]', json: async () => [] };
  }
  return { ok: false, status: 404, text: async () => 'nope', json: async () => null };
};

function packet(over) {
  const base = {
    game: { matchup: 'Baltimore Ravens @ Kansas City Chiefs', sport: 'NFL', sport_key: 'americanfootball_nfl', commence: '2026-09-11T00:15:00Z', away: 'Baltimore Ravens', home: 'Kansas City Chiefs', event_id: 'nfl-1' },
    market: 'Spread', market_key: 'spreads', selection: 'Kansas City Chiefs -3', selection_raw: 'Kansas City Chiefs', point: -3,
    prices: { detect: -105, current: -108, fair: -118, max_playable: -115, book: 'FanDuel', trusted: true },
    edge: { detect: 0.03, current: 0.024, ev: 0.024, remaining: 0.8, floor: 0.005 },
    confirmation: { has_sharp: true, n_books: 7, corrob: 1, trusted: true },
    timing: { stale_min: 12 },
    price_sensitivity: { breakeven: -118, max_playable: -115, needs_price_for_ev: null },
    deterministic: { verdict: 'LEAN', display_verdict: 'LEAN', is_wait: false, confidence: 'MEDIUM', score: 66, band: 'Marginal',
      why: 'Positive and qualifying, but with caveats worth weighing in the research.',
      reasons_for: ['+2.4% estimated edge vs Pinnacle de-vig fair', 'Pinnacle (sharp reference) is quoting this side', '7 books behind the fair line'],
      reasons_against: ['priced 12m ago — verify it is still live'],
      falsifiers: ['Price keeps moving against you: 80% of the detection edge is left, and past -115 the EV crosses the 0.5% floor.'] },
  };
  return Object.assign(base, over || {});
}

function req(body, qs, method) {
  return new Request('https://fn.test/edgedesk_ai' + (qs || ''), {
    method: method || 'POST',
    headers: { authorization: 'Bearer user-jwt', 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
}

(async function main() {
  const m = await import(path.join(__dirname, '..', '..', 'supabase', 'functions', 'edgedesk_ai', 'index.ts'));
  chk('handle is exported', typeof m.handle === 'function');
  chk('presentation library is loaded inside the function', !!globalThis.EDPRES && globalThis.EDPRES.VERSION === 1);

  /* ---- probe: no auth, no network, reports the presentation layer ------ */
  {
    const r = await m.handle(req(null, '?probe=1', 'GET'));
    const j = await r.json();
    chk('probe answers with the build', r.status === 200 && /r5-presentation/.test(j.build), j.build);
    chk('probe reports presentation modes', j.presentation && j.presentation.library_loaded === true && j.presentation.modes.length === 4);
    chk('probe made no network calls', calls.length === 0, calls.length);
  }

  /* ---- old contract, model answers WITH a copy block --------------------- */
  {
    calls.length = 0;
    let seen = null;
    anthropic = function (body) {
      seen = body;
      return { status: 200, json: { model: 'claude-test', content: [{ type: 'text', text:
        'LEAN: Kansas City Chiefs -3 at -108. Good to -115.\n\n- The sharper market is quoting the same side.\n\n```edgedesk_copy\n'
        + JSON.stringify({ headline: 'BET: Kansas City Chiefs -3 at -108.', why: [{ text: 'Seven sportsbooks are quoting this game, so the number is not resting on one book.', evidence_ids: ['e1'] }, { text: 'This is a lock.' }, { text: 'The sharper market agrees with the fair line here.' }], watch: 'The price is 12 minutes old, so check it is still live.', change_trigger: 'A move past -115 ends the edge.', market_read: 'Seven books stand behind the fair line.' })
        + '\n```' }] } };
    };
    const r = await m.handle(req({ mode: 'why', question: 'Why does EdgeDesk like this?', packet: packet(), history: [] }));
    const j = await r.json();
    chk('old caller still gets answer + research', r.status === 200 && typeof j.answer === 'string' && j.research && j.research.intent, { status: r.status, keys: Object.keys(j) });
    chk('the copy block never reaches the prose answer', j.answer.indexOf('edgedesk_copy') < 0 && /LEAN: Kansas City Chiefs -3 at -108/.test(j.answer), j.answer);
    chk('presentation is additive and present', j.presentation && j.presentation.version === 1 && j.presentation.simple, Object.keys(j));
    chk('verdict comes from the packet, not the model: LEAN stays LEAN', j.presentation.simple.verdict === 'LEAN' && /^LEAN:/.test(j.presentation.simple.headline), j.presentation.simple.headline);
    chk('model headline claiming BET was rejected', j.presentation.copy_rejections.some(function (x) { return /headline/.test(x); }), j.presentation.copy_rejections);
    chk('hype bullet rejected, honest bullet kept', j.presentation.simple.why.some(function (w) { return w.source === 'ai'; }) && !j.presentation.simple.why.some(function (w) { return /lock/i.test(w.text); }), j.presentation.simple.why);
    chk('a bullet carrying undefined jargon is rejected the same way hype is', j.presentation.copy_rejections.some(function (x) { return /jargon/.test(x); }) && !j.presentation.simple.why.some(function (w) { return /sharper market|fair line/i.test(w.text); }), j.presentation.copy_rejections);
    chk('jargon in market_read leaves the deterministic plain sentence standing', j.presentation.simple.market_read.source === 'deterministic' && !/fair line/i.test(j.presentation.simple.market_read.text), j.presentation.simple.market_read);
    chk('nothing the reader sees on the card carries undefined jargon', ![j.presentation.simple.plain.answer, j.presentation.simple.plain.found && j.presentation.simple.plain.found.sentence, j.presentation.simple.market_read.text].concat(j.presentation.simple.plain.why).filter(Boolean).some(function (t) { return require('path') && /\b(de-?vig|pinnacle|fair line|closing line value|\bclv\b)\b/i.test(t); }), j.presentation.simple.plain);
    chk('validated AI watch merged', j.presentation.simple.watch.source === 'ai' && /12 minutes old/.test(j.presentation.simple.watch.text));
    chk('good to is the owned max-playable', j.presentation.simple.playable_to.limit_odds === '-115');
    chk('default mode for an old caller is DEEP (unchanged prompt shape)', j.presentation.mode === 'DEEP' && /PRESENTATION MODE: DEEP/.test(seen.system));
    chk('DEEP still welcomes precise terminology — Full Research is not dumbed down', /Precise terminology is welcome here/.test(seen.system));
    chk('the copy contract tells the model which words the gate rejects', /NO BETTING JARGON/.test(seen.messages[seen.messages.length - 1].content) && /max playable/.test(seen.messages[seen.messages.length - 1].content));
    chk('system prompt keeps the honesty contract', /HARD RULES/.test(seen.system) && /VERDICT DISCIPLINE/.test(seen.system));
    chk('user content carries DECISION CARD FACTS + the copy contract', /DECISION CARD FACTS/.test(seen.messages[seen.messages.length - 1].content) && /edgedesk_copy/.test(seen.messages[seen.messages.length - 1].content));
    chk('exactly one model call', calls.filter(function (c) { return /anthropic/.test(c.url); }).length === 1);
    chk('publisher copy is built from the same card, in football words', j.presentation.publisher && /EdgeDesk leans toward Kansas City Chiefs to win by more than 3 points at -108/.test(j.presentation.publisher.lede), j.presentation.publisher && j.presentation.publisher.lede);
  }

  /* ---- SIMPLE mode: short budget, simple prompt ------------------------- */
  {
    calls.length = 0;
    let seen = null;
    anthropic = function (body) { seen = body; return { status: 200, json: { model: 'claude-test', content: [{ type: 'text', text: 'LEAN: Kansas City Chiefs -3 at -108.' }] } }; };
    const r = await m.handle(req({ mode: 'why', question: 'Why?', packet: packet(), presentation_mode: 'simple' }));
    const j = await r.json();
    chk('SIMPLE mode selects the compression prompt', /PRESENTATION MODE: SIMPLE/.test(seen.system) && seen.max_tokens <= 1200, seen.max_tokens);
    chk('no copy block -> deterministic copy stands, card intact', j.presentation.copy_source === 'deterministic' && j.presentation.simple.why.length === 3 && j.presentation.simple.verdict === 'LEAN');
  }

  /* ---- PUBLISHER mode ----------------------------------------------------- */
  {
    let seen = null;
    anthropic = function (body) { seen = body; return { status: 200, json: { model: 'claude-test', content: [{ type: 'text', text: 'EdgeDesk leans toward the Chiefs.' }] } }; };
    const r = await m.handle(req({ mode: 'publisher', question: '', packet: packet(), presentation_mode: 'PUBLISHER', preset: 'TNF' }));
    const j = await r.json();
    chk('PUBLISHER mode selects the article prompt', /PRESENTATION MODE: PUBLISHER/.test(seen.system) && /Never use: lock/.test(seen.system));
    chk('publisher preset resolves the kicker', j.presentation.publisher.preset === 'TNF' && j.presentation.publisher.kicker === 'Thursday Night Football');
  }

  /* ---- model failure: the deterministic card survives -------------------- */
  {
    anthropic = function () { return { status: 500, json: { error: 'overloaded' } }; };
    const r = await m.handle(req({ mode: 'why', question: 'Why?', packet: packet() }));
    const j = await r.json();
    chk('model outage is a 502 (client falls back) that still carries the card', r.status === 502 && j.presentation && j.presentation.simple.verdict === 'LEAN', { status: r.status });
  }
  {
    anthropic = function () { return { status: 200, json: { model: 'claude-test', content: [], stop_reason: 'max_tokens', usage: { input_tokens: 1, output_tokens: 0 } } }; };
    const r = await m.handle(req({ mode: 'why', question: 'Why?', packet: packet() }));
    const j = await r.json();
    chk('empty completion -> 200 with research and the deterministic card', r.status === 200 && j.error === 'empty completion' && j.presentation && j.presentation.simple.verdict === 'LEAN' && j.presentation.copy_source === 'deterministic', { status: r.status, err: j.error });
  }

  /* ---- integrity FAIL from the server suppresses the card ---------------- */
  {
    /* Force a FAIL through the market coherence check: a signal row whose
       fair value is not a probability. The slate read returns it; the audit
       runs over it; the card is built AFTER the audit. */
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async function (url, init) {
      const u = String(url);
      if (u.indexOf('sb.test') >= 0 && /rest\/v1\/signals\?select=event_id/.test(u) && !(init && init.method === 'HEAD')) {
        const row = { event_id: 'nfl-1', sport_key: 'americanfootball_nfl', market: 'spreads', selection: 'Kansas City Chiefs', point: -3, best_dec: 1.93, first_best_dec: 1.95, best_book: 'FanDuel', sharp_fair: 1.4, consensus_fair: 0.55, edge: 0.024, first_edge: 0.03, n_books: 7, has_sharp: true, pin_dec: 1.87, pin_opp_dec: 1.95, home_team: 'Kansas City Chiefs', away_team: 'Baltimore Ravens', commence_time: new Date(Date.now() + 3600000).toISOString(), last_seen_at: new Date().toISOString() };
        return { ok: true, status: 200, text: async () => JSON.stringify([row]), json: async () => [row] };
      }
      return oldFetch(url, init);
    };
    anthropic = function () { return { status: 200, json: { model: 'claude-test', content: [{ type: 'text', text: 'BET: Chiefs.\n```edgedesk_copy\n{"headline":"BET: Kansas City Chiefs -3 at -108."}\n```' }] } }; };
    const r = await m.handle(req({ mode: 'why', question: 'Why does EdgeDesk like the Chiefs?', packet: packet({ deterministic: Object.assign(packet().deterministic, { verdict: 'BET', display_verdict: 'BET' }) }) }));
    const j = await r.json();
    chk('server-side integrity FAIL reaches the card', j.research && j.research.integrity && j.research.integrity.verdict === 'FAIL', j.research && j.research.integrity);
    chk('a FAIL suppresses the BET, whatever the model wrote', j.presentation && j.presentation.simple.suppressed === true && j.presentation.simple.display_verdict !== 'BET' && /^DATA CHECK FAILED/.test(j.presentation.simple.headline), j.presentation && j.presentation.simple.headline);
    globalThis.fetch = oldFetch;
  }

  /* ---- dry run: everything except the model ----------------------------- */
  {
    calls.length = 0;
    const r = await m.handle(req({ mode: 'why', question: 'Why?', packet: packet(), presentation_mode: 'STANDARD' }, '?dry=1'));
    const j = await r.json();
    chk('dry run returns the deterministic presentation without a model call', j.dry === true && j.presentation && j.presentation.simple.verdict === 'LEAN' && !calls.some(function (c) { return /anthropic/.test(c.url); }));
    chk('dry run prompt carries the mode', j.request.presentation_mode === 'STANDARD' && /DECISION CARD FACTS/.test(j.prompt));
  }

  /* ---- no packet, no board: no card, and nothing invented --------------- */
  {
    anthropic = function () { return { status: 200, json: { model: 'claude-test', content: [{ type: 'text', text: 'Nothing on the board tonight.' }] } }; };
    const r = await m.handle(req({ mode: 'chat', question: 'what should I bet tonight?' }));
    const j = await r.json();
    chk('board question with no deterministic source yields no card rather than a manufactured one', r.status === 200 && j.presentation === null && typeof j.answer === 'string');
  }

  /* ---- board row source ------------------------------------------------- */
  {
    const row = { rank: 1, event_id: 'nfl-1', game: 'Baltimore Ravens @ Kansas City Chiefs', sport: 'NFL', starts: '2026-09-11T00:15:00Z', market: 'Spread', market_key: 'spreads', selection: 'Kansas City Chiefs -3', selection_raw: 'Kansas City Chiefs', point: -3,
      price: { current: -108, detection: -105, fair: -118, fair_src: 'Pinnacle de-vig fair', max_playable: -115, breakeven: -118, book: 'FanDuel' },
      edge: { current: 0.024, detection: 0.03, ev: 0.024, remaining: 0.8, floor: 0.005 },
      confirmation: { has_sharp: true, n_books: 7, corrob: 1, trusted_book: true }, freshness: { stale_min: 12 },
      deterministic: { verdict: 'PASS', display_verdict: 'WAIT', is_wait: true, wait_reason: 'No fair price is on file yet, so there is nothing to judge this number against. This is "cannot evaluate", not a rejected signal.', confidence: 'LOW', why: 'No fair price available to judge this number against.', reasons_for: [], reasons_against: [], falsifiers: [] } };
    const p = m.presentationSource({ packet: { board_mode: true, board: { rows: [row] } } }, { focus: { event_id: 'nfl-1' } });
    chk('a scored board row is a valid deterministic source', p && p.kind === 'board' && p.packet.deterministic.display_verdict === 'WAIT');
    const s = globalThis.EDPRES.simpleFromPacket(p.packet, {});
    chk('board-sourced card keeps the WAIT overlay verdict', s.verdict === 'WAIT' && /^WAIT:/.test(s.headline));
  }

  done();
})().catch(function (e) { console.log('CRASH ' + (e && e.stack || e)); process.exit(1); });
