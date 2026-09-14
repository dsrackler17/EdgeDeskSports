#!/usr/bin/env node
/* ===========================================================================
   THE CONVERSATION, ASSERTED.

   tools/intelligence/conversation.js drives the DEPLOYED edge function through
   a six-question sequence exactly as app.html does — same body, same growing
   `history`, same board scope. This file states what that run must be true of.

   Every failure named here was observed in the run before it was fixed:
     - a follow-up returned the TOP-RANKED game instead of the one under
       discussion, which reads exactly like a correct answer
     - "Texas State" on a college board resolved to the TEXAS RANGERS
     - "what price makes it a pass?" arrived with no market read at all
     - five evidence packets were serialised into the prompt TWICE

   WHAT THIS DOES NOT TEST: the model's own words. There is no Anthropic
   credential and no egress to the deployed function in CI, so inference is
   stubbed at the HTTP boundary. Everything that builds the prompt, and
   everything the response path does afterwards, is the real code.

   Run: node tools/intelligence/conversation.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function eq(name, got, want) { chk(name, got === want, { got, want }); }
function done() {
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

(async function main() {
  const CONV = require('./conversation.js');
  const r = await CONV.run();
  const T = r.turns;

  eq('all six questions completed through the real handler', T.length, 6);
  chk('every turn resolved the sport from the board scope',
    T.every((t) => t.sport === 'americanfootball_ncaaf'), T.map((t) => t.sport));
  chk('every turn produced an answer through the response path',
    T.every((t) => typeof t.answer === 'string' && t.answer.length > 0));

  /* ---- 1. the opening question sees the whole card --------------------- */
  const t1 = T[0];
  eq('the opener is classified as a slate question', t1.depth, 'SLATE');
  eq('and indexes every scheduled game', t1.slate_state.scheduled, 7);
  chk('with the three market states kept apart',
    t1.market_states['LINE ONLY'] > 0 && t1.market_states['PRICED'] > 0 && t1.market_states['NO MARKET'] > 0,
    t1.market_states);
  chk('and researches several games in depth, not one', t1.packets.length > 1, t1.packets);

  /* ---- 2-6. THE MATCHUP SURVIVES EVERY FOLLOW-UP ----------------------- */
  const named = T[1];
  chk('naming a matchup focuses it', named.packets.indexOf('401858900:v1') >= 0, named.packets);
  for (let i = 2; i < 6; i++) {
    const t = T[i];
    chk(`turn ${t.n} keeps the matchup without it being named again ("${t.question}")`,
      t.packets.length === 1 && t.packets[0] === '401858900:v1', { packets: t.packets });
    chk(`turn ${t.n} carries the two teams forward explicitly`,
      t.teams.length === 2 && t.teams.indexOf('North Texas') >= 0 && t.teams.indexOf('Texas State') >= 0, t.teams);
  }

  /* A CROSS-SPORT ALIAS MUST NOT BECOME THE SUBJECT. "Texas State" reaches
     the Texas Rangers through an MLB alias, and it did for three turns. */
  chk('no baseball club is ever carried on a college football board',
    T.every((t) => (t.teams || []).every((x) => !/Rangers|Astros|Rockies|Angels/.test(x))),
    T.map((t) => t.teams));

  /* ---- the price question re-reads rather than reuses ------------------ */
  const price = T[5];
  eq('the price question is recognised as one', price.intent, 'price');
  chk('and still arrives with the slate, however shallow its depth',
    !!price.slate_state && price.slate_state.scheduled === 7, price.slate_state);
  chk('and with the matchup it is asking about', price.packets.length === 1, price.packets);
  chk('and it re-reads the market rather than reusing an earlier read',
    price.refreshed_price === true && price.reads_this_turn > 0,
    { reads: price.reads_this_turn, refreshed: price.refreshed_price });
  chk('every turn re-reads the price feed, because a quote is time-sensitive',
    T.every((t) => t.refreshed_price === true), T.map((t) => t.refreshed_price));

  /* ---- the prompt is not the same thing twice -------------------------- */
  {
    /* A packet BODY is identifiable by its sections object; a pointer is not.
       Before the fix each packet appeared as a body twice — once in
       RESEARCHED MATCHUPS and again as a raw evidence item — and five games
       came to 225,000 of a 262,000-character prompt. */
    const bodies = (t1.prompt.match(/"sections":\{/g) || []).length;
    const pointers = (t1.prompt.match(/is delivered there IN FULL/g) || []).length;
    const block = t1.prompt.slice(t1.prompt.indexOf('RESEARCHED MATCHUPS'));
    const inBlock = (block.match(/"sections":\{/g) || []).length;
    chk('every researched packet is delivered in full', bodies >= t1.packets.length, { bodies, packets: t1.packets.length });
    chk('and in full exactly once — no packet body is serialised twice',
      bodies === t1.packets.length, { bodies, packets: t1.packets.length });
    chk('the bodies all live in the packet block', inBlock === bodies, { inBlock, bodies });
    chk('and the evidence list carries one pointer per packet instead of a copy',
      pointers === t1.packets.length, { pointers, packets: t1.packets.length });
  }
  chk('the evidence list points at the packet block instead of repeating it',
    /delivered in full under RESEARCHED MATCHUPS|is delivered there IN FULL/.test(t1.prompt));
  /* A soft ceiling, not a target: this is the size at which a turn stopped
     being two copies of itself. It is asserted so a future change that
     reintroduces duplication is noticed rather than absorbed. */
  chk('a single-matchup turn does not send a whole-card payload',
    T[2].prompt_chars < t1.prompt_chars, { focused: T[2].prompt_chars, slate: t1.prompt_chars });
  chk('and no turn sends a quarter of a million characters of evidence',
    T.every((t) => t.prompt_chars < 200000), T.map((t) => t.prompt_chars));

  /* ---- the standing contract reaches the model every turn -------------- */
  chk('the honesty contract is sent with every turn',
    T.every((t) => t.system_chars > 1000), T.map((t) => t.system_chars));
  chk('and the earlier turns travel with it, so a pronoun has a referent',
    T[5].history_turns_sent >= 6, T.map((t) => t.history_turns_sent));

  /* ---- what the answer path did with it -------------------------------- */
  chk('the ledger write is reported on every turn',
    T.every((t) => t.ledger && typeof t.ledger.state === 'string'), T.map((t) => t.ledger && t.ledger.state));
  chk('and a successful write carries no false-alarm notice',
    T.every((t) => t.ledger.state !== 'RECORDED' || t.ledger.notice === null));

  /* A FAILING LEDGER MUST CHANGE THE ANSWER'S CLAIM, NOT THE ANSWER. */
  const broken = await CONV.run({ ledgerStatus: 500 });
  chk('a failed ledger write is surfaced on every turn that had a decision',
    broken.turns.every((t) => !t.decisions.length || t.ledger.state === 'NOT_RECORDED'),
    broken.turns.map((t) => t.ledger.state));
  chk('with a notice a reader will understand',
    broken.turns.some((t) => /TRACKING UNAVAILABLE/.test((t.ledger && t.ledger.notice) || '')));
  chk('and the answers still arrive', broken.turns.every((t) => typeof t.answer === 'string' && t.answer.length > 0));

  /* ---- the matchup reader itself, on the phrasings people use ---------- */
  const m = await import(path.join(__dirname, '..', '..', 'supabase', 'functions', 'edgedesk_ai', 'index.ts'));
  const cases = [
    ['Analyze North Texas versus Texas State.', ['North Texas', 'Texas State']],
    ['what about Miami at Wake Forest', ['Miami', 'Wake Forest']],
    ['Syracuse @ Pittsburgh', ['Syracuse', 'Pittsburgh']],
    ['Compare Texas A&M vs Ole Miss', ['Texas A&M', 'Ole Miss']],
  ];
  cases.forEach(([q, want]) => {
    const got = m.matchupFromText(q);
    chk('the matchup reader handles "' + q + '"', JSON.stringify(got) === JSON.stringify(want), { got, want });
  });
  chk('and reads nothing out of a question with no matchup in it',
    m.matchupFromText('Any CFB matchups look good?').length === 0, m.matchupFromText('Any CFB matchups look good?'));
  chk('and refuses a side matched against itself',
    m.matchupFromText('Miami versus Miami').length === 0);

  /* ---- the client renders what came back ------------------------------- */
  const APP = fs.readFileSync(path.join(__dirname, '..', '..', 'app.html'), 'utf8');
  chk('the app renders the decisions it is sent', /function decisionListHTML/.test(APP));
  chk('the app renders the research sections', /function researchSectionsHTML/.test(APP));
  chk('the app renders the resolved scope', /function scopeHTMLFor/.test(APP));
  chk('and the tracking notice rides with them', /\+ledgerNoticeHTML\(d\)\+/.test(APP));

  done();
})().catch((e) => { console.error('CRASH', (e && e.stack) || e); process.exit(1); });
