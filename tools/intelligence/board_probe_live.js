#!/usr/bin/env node
/* ===========================================================================
   ASK THE DEPLOYMENT FOR ITS BOARD — read-only, no model call.

   The unit suites and the evaluation harness drive the real handler against
   a fixture network. This sends ONE real ?dry=1 request to the deployed
   edgedesk_ai function with a card-wide question and prints what came back:
   which build answered, whether the board kernel is loaded, the sports the
   sweep read and their coverage states, how many games were eligible, how
   many candidates qualified, the watchlist, the records it would write, and
   the quote refresh state. It spends no model tokens and writes nothing
   (a dry run records nothing).

   NO SECRET IS PRINTED. The key is read from the environment and never
   echoed. Prices and matchups are printed because they are the point.

   Run: SB_ANON=... node tools/intelligence/board_probe_live.js
        SB_ANON=... node tools/intelligence/board_probe_live.js --question "What is the best NFL total?" --tz America/Chicago
   Exit 0 when the deployment answered with a board, 1 when it answered
   without one (an older build, or the board switched off), 2 when nothing
   could be sent.
   =========================================================================== */
'use strict';

function env(...names) { for (const n of names) { const v = String(process.env[n] || '').trim(); if (v) return v; } return ''; }
const ARGS = process.argv.slice(2);
function arg(flag, dflt) { const i = ARGS.indexOf(flag); return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : dflt; }
const QUESTION = arg('--question', 'What are the best bets today?');
const TZ = arg('--tz', (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { return 'America/New_York'; } })());

async function main() {
  const url = (env('SB_URL', 'SUPABASE_URL') || '').replace(/\/+$/, '');
  const key = env('SB_ANON', 'SUPABASE_ANON_KEY', 'SB_SERVICE_ROLE', 'SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    console.log('NO CREDENTIALS — set SB_URL and SB_ANON (or SB_SERVICE_ROLE). Nothing was sent.');
    console.log('This is the live check the fixture suites cannot replace; without a key it is SKIPPED, not passed.');
    process.exit(2);
  }
  const fn = url + '/functions/v1/edgedesk_ai';
  /* 1. which build is serving, no auth */
  let probe = null;
  try { probe = await (await fetch(fn + '?probe=1')).json(); } catch (e) { console.log('probe failed: ' + String(e && e.message).slice(0, 120)); }
  if (probe) {
    console.log('build         ' + probe.build);
    console.log('board kernel  ' + (probe.board ? 'loaded v' + probe.board.version + ' enabled=' + probe.board.enabled + ' default_tz=' + probe.board.default_timezone : 'ABSENT (this build predates Slice 7)'));
    if (probe.board) console.log('quote refresh ' + (probe.board.quote_refresh.enabled ? 'on' : 'off') + ' · secret ' + (probe.board.quote_refresh.secret_configured ? 'configured' : 'not configured') + ' · ' + probe.board.quote_refresh.note);
    if (probe.board && probe.board.last_write) console.log('last record   ' + JSON.stringify(probe.board.last_write));
  }
  /* 2. the dry run */
  const t0 = Date.now();
  let r, j;
  try {
    r = await fetch(fn + '?dry=1', { method: 'POST', headers: { authorization: 'Bearer ' + key, apikey: key, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'chat', question: QUESTION, packet: {}, history: [], timezone: TZ }) });
    j = await r.json();
  } catch (e) { console.log('request failed: ' + String(e && e.message).slice(0, 160)); process.exit(2); }
  console.log('status        ' + r.status + ' in ' + (Date.now() - t0) + ' ms');
  if (r.status !== 200) { console.log('body          ' + JSON.stringify(j).slice(0, 400)); process.exit(2); }
  console.log('intent        ' + (j.intent && j.intent.intent) + ' / ' + (j.intent && j.intent.depth) + ' · sport ' + j.sport);
  if (j.research_error) console.log('RESEARCH ERROR ' + j.research_error.slice(0, 300));
  const B = j.board;
  if (!B) { console.log('NO BOARD — the deployment answered the old way (single-signal focus). data_path.board: ' + JSON.stringify(j.data_path && j.data_path.board).slice(0, 300)); process.exit(1); }
  console.log('board         ' + B.id + ' built ' + B.built_at);
  console.log('scope         sports ' + B.scope.sports.join(', ') + ' (' + B.scope.sport_source + ') · window ' + B.scope.window.label + ' · zone ' + B.scope.timezone.zone + ' (' + B.scope.timezone.source + ')');
  console.log('coverage      ' + B.coverage.map((c) => c.label + '=' + c.status + (c.status === 'EVALUATED' ? '(' + c.eligible + '/' + c.scheduled + ')' : '') + (c.refresh ? ' refresh:' + c.refresh.state : '') + (c.errors && c.errors.length ? ' ! ' + c.errors[0].slice(0, 80) : '')).join(' · '));
  console.log('eligibility   ' + JSON.stringify(B.eligibility.counts));
  console.log('candidates    ' + B.candidates_considered + ' considered · ' + B.opportunities.length + ' qualified · ' + B.watchlist.length + ' watch · ' + B.data_checks.length + ' data checks');
  console.log('freshness     quotes ' + (B.freshness.quotes.newest ? B.freshness.quotes.oldest + ' .. ' + B.freshness.quotes.newest : 'none') + ' · research ' + (B.freshness.research.newest || 'none'));
  console.log('headline      ' + B.headline);
  B.opportunities.forEach((c, i) => console.log('  #' + (i + 1) + ' ' + c.selection + ' ' + (c.line == null ? '' : c.line) + ' — ' + c.matchup + ' (' + c.sport_label + ', ' + c.kickoff_local + ') · ' + (c.quote.executable ? c.quote.book + ' ' + c.quote.odds_american + ' captured ' + c.quote.captured_at + ' (' + c.quote.freshness + ')' : 'no executable price') + ' · ' + c.fair.method + ' · edge ' + (c.edge.probability_edge_pp != null ? c.edge.probability_edge_pp + 'pp' : c.edge.ev_per_unit) + ' · ' + c.qualification.rules[0]));
  B.watchlist.forEach((c) => console.log('  watch ' + c.selection + ' ' + (c.line == null ? '' : c.line) + ' — ' + c.matchup + ' · ' + c.qualification.rules[0]));
  (B.research_leads || []).forEach((c) => console.log('  lead  ' + c.selection + ' ' + c.line + ' — ' + c.matchup + ' · ' + c.tier + ' tier, research only'));
  console.log('records ready ' + (j.board_records || []).length + ' (a dry run writes none)');
  console.log('\nDETERMINISTIC ANSWER (what a reader gets if the writing model fails or is rejected):\n' + j.deterministic_board_answer);
  process.exit(0);
}
main().catch((e) => { console.log('failed: ' + String(e && e.message).slice(0, 200)); process.exit(2); });
