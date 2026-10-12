#!/usr/bin/env node
/* ===========================================================================
   LEG ROWS THROUGH THE REAL IMPORT PIPELINE, AND EDBETS OVER RLS-READ ROWS.

   A Juice-Reel-style export (one row per parlay leg, the ticket repeated) is
   staged with the leg-row adapter (lib/edgedesk_portfolio_import.js),
   classified and committed by supabase/portfolio.sql's own functions on a
   throwaway PostgreSQL, AS THE READER, and then read back the way the page
   reads it (tools/portfolio/_pgrest.js, the page's own column list):

     - one position per TICKET: a 3-leg parlay is one row with 3 legs in its
       legs jsonb and its stake once; nothing is changed in the SQL;
     - the rows the browser flagged wait for the reader (a row with no ticket
       id, a placed-after-settled time, a ticket whose rows disagree);
     - EDBETS over the stored rows gives the CSV path's figures to the cent —
       the same analytics, server-side data, under row level security;
     - another reader's EDBETS sees nothing; importing the file again adds
       nothing, so no ticket is ever counted twice.

   Run: node tools/portfolio/bet_history_sql.test.js
   (PORTFOLIO_SQL_REQUIRED=1 makes a missing PostgreSQL a failure.)
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const REST = require('./_pgrest.js');
global.window = global;
const E = require(path.join(PG.ROOT, 'lib', 'edgedesk_portfolio.js'));
const I = require(path.join(PG.ROOT, 'lib', 'edgedesk_portfolio_import.js'));
const B = require(path.join(PG.ROOT, 'lib', 'edgedesk_bet_history.js'));
const U = require(path.join(PG.ROOT, 'lib', 'edgedesk_portfolio_ui.js'));

const T = PG.kit('bet history SQL');
const chk = T.chk;
const eq = (name, got, want) => chk(name, JSON.stringify(got) === JSON.stringify(want), { got, want });
const L = PG.lit;
const NOW = Date.parse('2026-10-12T12:00:00Z');
const CSV = fs.readFileSync(path.join(__dirname, 'fixtures', 'juice_reel_style.csv'), 'utf8');
const pick = (g) => g && { n: g.n, risked: g.risked, pnl: g.pnl, roi: g.roi };

const db = PG.start('bethist');
if (db.skip) {
  if (process.env.PORTFOLIO_SQL_REQUIRED === '1') chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — LIVE layer skipped');
  process.exit(T.done());
}
const A = '00000000-0000-0000-0000-0000000000a7';
const Bu = '00000000-0000-0000-0000-0000000000b7';
const one = (s) => s.split('\n')[0];
const json = (s) => JSON.parse(String(s || '').split('\n')[0] || 'null');
try {
  ['portfolio.sql', 'portfolio_journal.sql', 'portfolio_connect.sql', 'portfolio_decision.sql'].forEach((f) => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f)));
  db.sql(`insert into auth.users (id, email) values (${L(A)}, 'a@example.com'), (${L(Bu)}, 'b@example.com');`);
  const rest = REST.make(db, { tokens: { ta: A, tb: Bu } });
  const read = (token) => {
    const out = rest.handle('GET', 'portfolio_positions', 'select=' + U.POSITION_SELECT + '&order=placed_at.asc,id.asc', null, '', token);
    if (out.status !== 200) throw new Error('read failed ' + JSON.stringify(out.body));
    return out.body;
  };

  /* stage the file exactly as the page does */
  const st = I.stage(CSV, { timezone: 'UTC', now: NOW });
  eq('the browser reads the file as leg rows: 22 rows, 14 tickets', [st.adapter, st.tickets.rowsRead, st.rows.length], ['leg_rows_sportsbook_v1', 22, 14]);
  function stageImport(staged) {
    const imp = one(db.as(A, `insert into public.portfolio_imports (platform_type, importer, file_name, timezone, column_map)
      values ('SPORTSBOOK', ${L(staged.adapter)}, 'juice_reel_style.csv', 'UTC', ${L(JSON.stringify(staged.map))}::jsonb) returning id;`));
    const values = staged.rows.map((r) => `(${L(imp)}, ${r.row_number}, ${L(JSON.stringify(r.raw))}::jsonb, ${L(JSON.stringify(r.normalized))}::jsonb, ${L(JSON.stringify(r.issues))}::jsonb)`);
    db.as(A, `insert into public.portfolio_import_rows (import_id, row_number, raw, normalized, issues) values ${values.join(',\n')};`);
    return imp;
  }
  function commit(imp) {
    let r, n = 0;
    do { r = json(db.as(A, `select public.portfolio_import_commit(${L(imp)});`)); } while (r && r.status !== 'COMMITTED' && ++n < 20);
    return r;
  }
  const imp = stageImport(st);
  let c = json(db.as(A, `select public.portfolio_import_classify(${L(imp)});`));
  eq('the server classifies one row per ticket: 14 found, 11 new, 3 to review, none duplicate or invalid', [c.total, c.new, c.review, c.duplicate, c.invalid], [14, 11, 3, 0, 0]);
  const review = json(db.as(A, `select json_agg(row_number order by row_number) from public.portfolio_import_rows where import_id = ${L(imp)} and classification = 'NEEDS_REVIEW';`));
  eq('…the review rows are the no-id single (row 14), the ticket whose rows disagree (15) and the placed-after-settled one (17)', review, [14, 15, 17]);
  /* the reader ticks the two it trusts; the disagreeing ticket stays out */
  db.as(A, `update public.portfolio_import_rows set decision = 'IMPORT' where import_id = ${L(imp)} and row_number in (14, 17);`);
  c = commit(imp);
  eq('commit: 13 tickets imported, the disagreeing one skipped, none failed', [c.status, c.imported, c.skipped, c.failed], ['COMMITTED', 13, 1, 0]);
  eq('one position per ticket', db.sql(`select count(*) from public.portfolio_positions where user_id = ${L(A)};`), '13');
  const p1 = json(db.as(A, `select json_build_object('type', position_type, 'legs', jsonb_array_length(legs), 'stake', stake::text, 'pl', trim_scale(profit_loss)::text, 'market', market_name)
                             from public.portfolio_positions where external_position_id = 'T1001';`));
  eq('the 3-leg parlay is ONE stored position with 3 legs and its $50 stake once, −$50 P&L', p1, { type: 'PARLAY', legs: 3, stake: '50', pl: '-50', market: 'Parlay (3 legs)' });
  const p2 = json(db.as(A, `select json_build_object('type', position_type, 'dec', trim_scale(odds_decimal)::text, 'pl', trim_scale(profit_loss)::text, 'leg', legs->1->>'selection')
                             from public.portfolio_positions where external_position_id = 'T1002';`));
  eq('the SGP priced by its legs is stored at 4.772728 and the trigger derives +$75.45', p2, { type: 'SAME_GAME_PARLAY', dec: '4.772728', pl: '75.45', leg: 'A.J. Brown Anytime TD' });
  eq('the single exported twice is stored once', db.sql(`select count(*) from public.portfolio_positions where user_id = ${L(A)} and external_position_id = 'T1003';`), '1');

  /* EDBETS over what row level security hands the page */
  const rowsA = read('ta');
  eq('the page\'s own read returns the 13 positions, the 4 parlays with their legs', [rowsA.length, rowsA.filter((p) => Array.isArray(p.legs)).length], [13, 4]);
  const csvA = B.analyze(B.fromCSV(CSV, { timezone: 'UTC', now: NOW }), { tz: 'UTC' });
  const dbA = B.analyze(B.fromPositions(rowsA, { now: NOW }), { tz: 'UTC' });
  eq('stored rows: 13 tickets, 19 legs, 9 singles, 4 parlays', [dbA.counts.tickets, dbA.counts.legs, dbA.counts.singles, dbA.counts.parlays], [13, 19, 9, 4]);
  eq('EDBETS over the stored rows = EDBETS over the CSV, to the cent: risked $605.00, P&L −$183.55, ROI −0.303388',
    [dbA.totals.n, dbA.totals.risked, dbA.totals.pnl, dbA.totals.roi, dbA.totals.openExposure], [csvA.totals.n, '605.00', '-183.55', '-0.303388', '60.00']);
  eq('…singles and parlays', [pick(dbA.singles), pick(dbA.parlays)], [pick(csvA.singles), pick(csvA.parlays)]);
  eq('…every breakdown', [dbA.bySport.map(pick), dbA.byMarketType.map(pick), dbA.byOddsRange.map(pick), dbA.byStakeSize.map(pick)],
    [csvA.bySport.map(pick), csvA.byMarketType.map(pick), csvA.byOddsRange.map(pick), csvA.byStakeSize.map(pick)]);
  eq('…the days and the alt-line effect', [dbA.days.list, dbA.days.worst, pick(dbA.altLines.combined), dbA.altLines.shareOfLosses], [csvA.days.list, csvA.days.worst, pick(csvA.altLines.combined), csvA.altLines.shareOfLosses]);
  chk('…and the stored rows answer the question in the same words (bar what only the file knew)', (() => {
    const t = B.answer(dbA).text;
    return /You lost \$183\.55 on 11 tickets/.test(t) && /Parlays were more profitable per dollar risked/.test(t) && /Worst day: 2026-09-20/.test(t) && /not verifiable/.test(t) && B.checkLanguage(t).ok;
  })());

  /* isolation and idempotence */
  const rowsB = read('tb');
  eq('reader B\'s EDBETS sees none of reader A\'s tickets', [rowsB.length, B.analyze(B.fromPositions(rowsB)).counts.tickets], [0, 0]);
  const imp2 = stageImport(I.stage(CSV, { timezone: 'UTC', now: NOW }));
  c = json(db.as(A, `select public.portfolio_import_classify(${L(imp2)});`));
  eq('importing the same file again: every imported ticket is a duplicate, nothing new', [c.new, c.duplicate, c.review], [0, 13, 1]);
  c = commit(imp2);
  eq('…so nothing is imported twice', [c.imported, db.sql(`select count(*) from public.portfolio_positions where user_id = ${L(A)};`)], [0, '13']);
  eq('…and the figures do not move', B.analyze(B.fromPositions(read('ta')), { tz: 'UTC' }).totals.pnl, '-183.55');
} catch (e) {
  chk('the suite ran without an exception', false, String(e && (e.sqlMessage || e.message)).slice(0, 600));
} finally {
  db.stop();
}
process.exit(T.done());
