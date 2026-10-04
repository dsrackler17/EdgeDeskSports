#!/usr/bin/env node
/* ===========================================================================
   ASK THE DEPLOYMENT THE QUESTION THE CUSTOMER ASKED.

   The deployment doctor establishes WHAT is running. This establishes what it
   ANSWERS, which is a different question and the one a narration failure lives
   in: a build can be current, its kernel loaded and its decision layer on, and
   the reader still gets no usable reply because the prompt left the writing
   model no room to write.

   It sends ONE real request to the deployed function and reports the shape of
   what came back. NO SECRET IS PRINTED — the key is read from the environment
   and never echoed — and the answer text is summarised rather than dumped, so
   a run log does not become a copy of someone's research.

   SB_ANON is enough. SB_SERVICE_ROLE also works; the function decides what the
   caller may see, which is the point of asking it as a caller.

   Run: SB_ANON=... node tools/intelligence/probe_live.js
        SB_ANON=... node tools/intelligence/probe_live.js --question "..."
   =========================================================================== */
'use strict';

function env(...names) {
  for (const n of names) { const v = String(process.env[n] || '').trim(); if (v) return v; }
  return '';
}

const ARGS = process.argv.slice(2);
function arg(flag, dflt) {
  const i = ARGS.indexOf(flag);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : dflt;
}

/* The reported question, verbatim, and the board the reader had open. */
const QUESTION = arg('--question',
  'What do you think about North Texas vs Texas State this week? Anything worth betting?');

async function main() {
  const url = (env('SB_URL', 'EDGD_SB_URL', 'SUPABASE_URL')
    || 'https://iattxbkbufslbauoumga.supabase.co').replace(/\/+$/, '');
  const key = env('SB_ANON', 'SUPABASE_ANON_KEY', 'SB_SERVICE_ROLE', 'SUPABASE_SERVICE_ROLE_KEY');
  if (!key) {
    console.log('NO KEY — set SB_ANON or SB_SERVICE_ROLE. Nothing was sent.');
    process.exit(2);
  }
  const body = {
    mode: 'chat', question: QUESTION,
    packet: { board_scope: { sport: 'americanfootball_ncaaf' } },
    history: [],
  };

  const t0 = Date.now();
  let res, text = '';
  try {
    res = await fetch(`${url}/functions/v1/edgedesk_ai`, {
      method: 'POST',
      headers: { apikey: key, authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    });
    text = await res.text();
  } catch (e) {
    console.log('UNREACHABLE — ' + String((e && e.message) || e));
    process.exit(2);
  }
  const ms = Date.now() - t0;

  let j = null;
  try { j = JSON.parse(text); } catch (_) { /* reported below */ }

  console.log('EDGEDESK LIVE PROBE — what the deployment answers');
  console.log('');
  console.log(`  question   : ${QUESTION}`);
  console.log(`  http       : ${res.status} in ${ms}ms`);
  console.log(`  build      : ${(j && j.build) || 'unknown'}`);
  if (!j) { console.log('  body       : not JSON (' + text.length + ' bytes)'); process.exit(1); }

  /* ---- did it route to the right game? -------------------------------- */
  const rc = (j.research && j.research.research_context) || j.research_context || null;
  console.log('');
  console.log('  ROUTING');
  console.log(`    sport    : ${(j.research && j.research.sport) || rc && rc.sport || 'unknown'}`);
  console.log(`    game     : ${rc ? `${rc.game_id} — ${rc.away} @ ${rc.home}` : 'not resolved'}`);
  console.log(`    via      : ${rc ? rc.sport_source : '-'}`);

  /* ---- did the writing model answer? ---------------------------------- */
  const answer = typeof j.answer === 'string' ? j.answer : '';
  const narr = j.narration || null;
  console.log('');
  console.log('  NARRATION');
  console.log(`    answered : ${answer.trim().length > 0 ? 'yes' : 'NO'}`);
  console.log(`    chars    : ${answer.length}`);
  if (j.error) console.log(`    error    : ${j.error}`);
  if (j.why) console.log(`    why      : ${String(j.why).slice(0, 300)}`);
  if (narr) console.log(`    narration: ${JSON.stringify(narr).slice(0, 300)}`);

  /* THE SHAPE, not the content. Four headings are the contract; whether the
     answer carries them is the thing worth reporting in a log. */
  if (answer) {
    const want = ["The Desk's read", 'Why', 'What could make it wrong', 'Price and data limitations'];
    const have = want.filter((h) => new RegExp(h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(answer));
    console.log(`    sections : ${have.length}/4 present — ${have.join(' · ') || 'none'}`);
    /* Leakage the contract forbids. A hit here is a real finding. */
    const leaks = ['cfb_research_matchup', 'cfb_betting_candidate', 'RESEARCH_LEAN', 'data_path',
      'slate scope', 'validation registry', 'evidence id', 'recommendation_ledger', 'PGRST']
      .filter((w) => answer.toLowerCase().includes(w.toLowerCase()));
    console.log(`    leaks    : ${leaks.length ? leaks.join(', ') : 'none'}`);
    console.log(`    opening  : ${JSON.stringify(answer.slice(0, 220))}`);
  }

  /* ---- the deterministic read, and the cards the panel would draw ------ */
  const S = j.matchup_summary || null;
  console.log('');
  console.log('  THE DESK (deterministic)');
  console.log(`    summary  : ${S ? 'present' : 'absent'}`);
  if (S) {
    console.log(`    read     : ${JSON.stringify(String(S.read || '').slice(0, 240))}`);
    console.log(`    primary  : ${JSON.stringify(S.primary)}`);
    console.log(`    others   : ${S.other_markets} more market(s) behind the disclosure`);
    console.log(`    ev source: ${S.ev_provenance || '(no expected return quoted)'}`);
    console.log(`    blockers : ${(S.data_blockers || []).length}`);
  }
  const ds = (j.research && j.research.decisions) || [];
  console.log(`    cards    : ${ds.length}` + (ds.length ? ` — ${ds.filter((d) => d.primary).length} primary`
    + `, ${ds.filter((d) => !d.primary).length} secondary` : ''));
  const stale = ds.filter((d) => d && d.gates && d.gates.freshness && d.gates.freshness.status !== 'CURRENT');
  if (stale.length) console.log(`    stale    : ${stale.length}/${ds.length} quotes past their window`);

  /* ---- tracking, without the database's own words --------------------- */
  const L = j.ledger || null;
  if (L) console.log(`\n  TRACKING   : ${L.state}${L.notice ? ' — ' + String(L.notice).slice(0, 120) : ''}`);

  const ok = answer.trim().length > 0 || !!S;
  console.log('');
  console.log('  VERDICT: ' + (answer.trim().length > 0 ? 'THE DESK ANSWERED'
    : S ? 'NARRATION FAILED — deterministic read served instead' : 'NO ANSWER AND NO READ'));
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.log('PROBE THREW — ' + String((e && e.message) || e)); process.exit(2); });
