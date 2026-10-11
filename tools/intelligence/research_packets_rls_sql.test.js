#!/usr/bin/env node
/* ===========================================================================
   research_packets: what ONE reader can see through the views.

   research_packets carries row level security (a reader sees their own
   packets). The two per-row views on top of it — research_packet_grades and
   research_packet_pricing — were created without security_invoker, and a
   view owned by postgres runs with its OWNER's rights: RLS on the table was
   never applied through them, so any signed-in reader could read every other
   reader's packets (question, selection, price, packet JSON) by selecting
   from the view instead of the table.

   This suite applies supabase/research_packets.sql to a throwaway
   PostgreSQL (tools/personal/_pg.js, the Supabase shim: auth.uid() reads the
   JWT claim, real anon / authenticated / service_role roles), records a
   packet for reader A and one for reader B, and proves:

     - through BOTH per-row views, A reads A's packet and never B's;
     - anon reads nothing;
     - the service role (the learning loop's grader) still reads every row;
     - the calibration view carries no reader id or packet id, and aggregates
       a reader's own packets (the service role aggregates every packet);
     - the standalone patch (research_packets_views_rls.sql) fixes a database
       that already holds the old views, re-applies cleanly, and its rollback
       restores the previous definition (documented: that reopens the read).

   Run: node tools/intelligence/research_packets_rls_sql.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const PG = require('../personal/_pg.js');

const ROOT = path.join(__dirname, '..', '..');
const SQL = path.join(ROOT, 'supabase', 'research_packets.sql');
const PATCH = path.join(ROOT, 'supabase', 'research_packets_views_rls.sql');
const ROLLBACK = path.join(ROOT, 'supabase', 'research_packets_views_rls_rollback.sql');
const T = PG.kit('research_packets views RLS');
const A = '00000000-0000-0000-0000-0000000000aa';
const B = '00000000-0000-0000-0000-0000000000bb';

const db = PG.start('rprls');
if (!db || db.skip) {
  const note = 'SKIP | ' + ((db && db.skip) || 'no postgres') + ' — the SQL layer did not run';
  if (process.env.INTEL_SQL_REQUIRED === '1') T.chk('Postgres required but ' + note, false);
  process.exit(T.done(note));
}

const KICK = '2026-09-20T19:00:00Z', BUILT = '2026-09-16T12:00:00Z';
function packetInsert(id, sig) {
  return `insert into public.research_packets (packet_id, packet_hash, built_at, sport, game_id, matchup, kickoff, model_version, market, selection, side, handicap, odds_decimal, book, fair_probability, sig_key, label, question, packet)
    values ('${id}','h-${id}','${BUILT}','americanfootball_ncaaf','g-${id}','A @ B','${KICK}','cfb_p4_fv1','spreads','Sel ${id}','home',-2.5,1.91,'Book','0.53','${sig}','PASS','private question of ${id}','{"pricing_summary":{"headline":"h ${id}","quoted":{"selection":"Sel ${id}","odds_american":-110}}}'::jsonb);`;
}
const count = (out) => out === '' ? 0 : out.split('\n').length;

try {
  /* the signals table the grades view joins to, in the shape close writes */
  db.sql('create table if not exists public.signals (sig_key text primary key, closing_sharp_fair numeric, closing_dec numeric, closing_at_observed timestamptz, result text, clv numeric, beat_close boolean);'
    + "\ninsert into public.signals values ('sig-a', 0.55, 1.9, '2026-09-20T18:55:00Z', 'win', 0.02, true), ('sig-b', 0.5, 1.95, '2026-09-20T18:55:00Z', 'loss', -0.01, false);");

  const r1 = db.applyFile(SQL);
  T.chk('research_packets.sql applies to a clean database, every report row ok', !/CHECK THIS/.test(r1), r1.slice(-400));
  T.chk('and applies a second time', !/CHECK THIS/.test(db.applyFile(SQL)));
  T.chk('and as one transaction', !/CHECK THIS/.test(db.applyFileAtomic(SQL)));

  db.as(A, packetInsert('pa', 'sig-a'));
  db.as(B, packetInsert('pb', 'sig-b'));
  T.chk('each reader recorded one packet', db.sql("select count(*) from public.research_packets") === '2');

  /* the table itself: already correct before this change */
  T.chk('the table: A reads only A', db.as(A, 'select packet_id from public.research_packets order by 1;') === 'pa');

  /* THE VIEWS — the defect this suite exists for */
  const gA = db.as(A, 'select packet_id from public.research_packet_grades order by 1;');
  T.chk('grades view: A reads A\'s packet', /\bpa\b/.test(gA), gA);
  T.chk('grades view: A never reads B\'s packet', !/\bpb\b/.test(gA), gA);
  const gB = db.as(B, 'select packet_id, grade_state from public.research_packet_grades order by 1;');
  T.chk('grades view: B reads only B, graded against its own signal', gB === 'pb|GRADED', gB);
  const pA = db.as(A, 'select packet_id, quoted_selection from public.research_packet_pricing order by 1;');
  T.chk('pricing view: A reads only A', pA === 'pa|Sel pa', pA);
  T.chk('pricing view: B\'s quoted selection is not readable by A', !/Sel pb/.test(pA), pA);

  /* anon */
  const an = db.mustFail(() => db.anon('select count(*) from public.research_packet_grades;'));
  const anOut = an ? null : db.anon('select count(*) from public.research_packet_grades;');
  T.chk('anon reads nothing through the grades view', !!an || anOut === '0', an || anOut);

  /* the grader */
  T.chk('service role (the learning loop) still reads every packet through grades', db.service('select count(*) from public.research_packet_grades;') === '2');
  T.chk('and through pricing', db.service('select count(*) from public.research_packet_pricing;') === '2');

  /* the calibration view: a model-level aggregate with no reader in it */
  const calCols = db.sql("select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema='public' and table_name='research_packet_calibration';");
  T.chk('calibration view carries no reader id and no packet id', !/user_id|packet_id|question|selection/.test(calCols), calCols);
  /* it aggregates the grades view, which now applies RLS, so a reader's
     calibration is computed over that reader's own packets; the service role
     (the grader) aggregates every packet */
  const calA = db.as(A, 'select packets from public.research_packet_calibration;');
  T.chk('calibration view: a reader aggregates only their own packets', calA === '1', calA);
  T.chk('calibration view: the service role aggregates every packet', db.service('select packets from public.research_packet_calibration;') === '2');

  /* the views are invoker-rights now */
  const opts = db.sql("select c.relname || '=' || coalesce(array_to_string(c.reloptions, ';'), '') from pg_class c where c.relname in ('research_packet_grades','research_packet_pricing') order by 1;");
  T.chk('both per-row views run with the caller\'s rights (security_invoker)', (opts.match(/security_invoker=true/g) || []).length === 2, opts);

  /* ---- the standalone patch, on a database that holds the OLD definition ---- */
  db.sql('alter view public.research_packet_grades reset (security_invoker); alter view public.research_packet_pricing reset (security_invoker);');
  const leak = db.as(A, 'select packet_id from public.research_packet_grades order by 1;');
  T.chk('reproduction: with the old definition A reads B\'s packet (the defect)', /\bpb\b/.test(leak), leak);
  const p1 = db.applyFile(PATCH);
  T.chk('the patch applies, every report row ok', !/CHECK THIS/.test(p1) && /ok/.test(p1), p1);
  T.chk('the patch applies a second time', !/CHECK THIS/.test(db.applyFile(PATCH)));
  T.chk('after the patch A no longer reads B', db.as(A, 'select packet_id from public.research_packet_grades order by 1;') === 'pa');
  T.chk('nor through pricing', db.as(A, 'select packet_id from public.research_packet_pricing order by 1;') === 'pa');
  T.chk('the patch keeps the service role reading everything', db.service('select count(*) from public.research_packet_pricing;') === '2');

  /* ---- the rollback restores the previous definition ---- */
  const rb = db.applyFile(ROLLBACK);
  T.chk('the rollback applies, its report ok', !/CHECK THIS/.test(rb), rb);
  T.chk('after the rollback the views are owner-rights again (the old behaviour)', db.as(A, 'select count(*) from public.research_packet_grades;') === '2');
  T.chk('and the patch re-applies cleanly after a rollback', !/CHECK THIS/.test(db.applyFile(PATCH)) && db.as(A, 'select count(*) from public.research_packet_grades;') === '1');

  /* the ledger's own rules are untouched */
  /* a reader has no UPDATE policy, so their update matches nothing; the
     service role bypasses RLS and meets the write-once trigger */
  db.as(A, "update public.research_packets set label='PASS' where packet_id='pa';");
  T.chk('a reader cannot change their packet (no row matches under RLS)', db.sql("select label from public.research_packets where packet_id='pa';") === 'PASS' && db.sql("select packet_hash from public.research_packets where packet_id='pa';") === 'h-pa');
  const up = db.mustFail(() => db.service("update public.research_packets set label='RESEARCH LEAD' where packet_id='pa';"));
  T.chk('the ledger stays write-once, even for the service role', !!up && /write-once/.test(up), up);
} catch (e) {
  T.chk('unexpected error: ' + String(e.message).slice(0, 300), false);
} finally {
  db.stop();
}
process.exit(T.done());
