#!/usr/bin/env node
/* ===========================================================================
   supabase/saved_research.sql on a throwaway PostgreSQL (tools/personal/_pg.js).

   Proves: applies clean, twice and as one transaction; a reader saves,
   reads, renames, annotates, archives and deletes their OWN research; never
   another reader's (read, edit or delete); anon reaches nothing; what was
   saved (question, answer, payload, game, time) cannot be edited by anyone,
   the service role included; the size checks and the 500-item cap; the
   rollback cuts readers off and keeps every row; re-apply restores them.

   Run: node tools/intelligence/saved_research_sql.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const PG = require('../personal/_pg.js');
const ROOT = path.join(__dirname, '..', '..');
const SQL = path.join(ROOT, 'supabase', 'saved_research.sql');
const ROLLBACK = path.join(ROOT, 'supabase', 'saved_research_rollback.sql');
const T = PG.kit('saved research SQL');
const A = '00000000-0000-0000-0000-0000000000a1', B = '00000000-0000-0000-0000-0000000000b2';

const db = PG.start('savedr');
if (!db || db.skip) {
  const note = 'SKIP | ' + ((db && db.skip) || 'no postgres') + ' — the SQL layer did not run';
  if (process.env.INTEL_SQL_REQUIRED === '1') T.chk('Postgres required but ' + note, false);
  process.exit(T.done(note));
}
try {
  db.sql(`insert into auth.users (id, email) values ('${A}', 'a@x.test'), ('${B}', 'b@x.test');`);
  const r1 = db.applyFile(SQL);
  T.chk('applies to a clean database, every report row ok', !/CHECK THIS/.test(r1) && (r1.match(/\|ok/g) || []).length === 5, r1);
  T.chk('applies a second time', !/CHECK THIS/.test(db.applyFile(SQL)));
  T.chk('applies as one transaction', !/CHECK THIS/.test(db.applyFileAtomic(SQL)));

  const ins = (uid, title, extra) => db.as(uid, `insert into public.saved_research (kind, sport, game_id, title, question, answer, payload) values ('desk_answer', 'americanfootball_nfl', 'g1', '${title}', 'Is it worth it?', 'No: the price needs 52.4%.', '{"route":{"tier":"LITE"}}'::jsonb) returning id;`);
  const idA = ins(A, 'A first');
  const idB = ins(B, 'B first');
  T.chk('a reader saves research and it is theirs', /^[0-9a-f-]{36}$/.test(idA) && db.sql(`select user_id from public.saved_research where id='${idA}';`) === A, idA);
  T.chk('a reader reads only their own', db.as(A, 'select title from public.saved_research;') === 'A first');
  T.chk('a reader cannot save as someone else', !!db.mustFail(() => db.as(A, `insert into public.saved_research (user_id, kind, title) values ('${B}', 'note', 'forged');`)));
  db.as(A, `update public.saved_research set title='renamed', note='my note', archived=true where id='${idA}';`);
  T.chk('a reader renames, annotates and archives their own', db.sql(`select title||'|'||note||'|'||archived from public.saved_research where id='${idA}';`) === 'renamed|my note|true');
  db.as(A, `update public.saved_research set title='hijacked' where id='${idB}';`);
  T.chk('but never another reader\'s', db.sql(`select title from public.saved_research where id='${idB}';`) === 'B first');
  const ed = db.mustFail(() => db.as(A, `update public.saved_research set answer='Yes, bet it.' where id='${idA}';`));
  T.chk('what was saved cannot be edited by the reader (no column privilege)', !!ed, ed);
  const eds = db.mustFail(() => db.service(`update public.saved_research set answer='Yes, bet it.' where id='${idA}';`));
  T.chk('nor by the service role (the freeze trigger)', !!eds && /cannot be edited/.test(eds), eds);
  T.chk('nor its payload', !!db.mustFail(() => db.service(`update public.saved_research set payload='{}'::jsonb where id='${idA}';`)));
  db.as(A, `delete from public.saved_research where id='${idB}';`);
  T.chk('a reader cannot delete another reader\'s research', db.sql(`select count(*) from public.saved_research where id='${idB}';`) === '1');
  db.as(A, `delete from public.saved_research where id='${idA}';`);
  T.chk('a reader can delete their own', db.sql(`select count(*) from public.saved_research where id='${idA}';`) === '0');
  T.chk('anon reads nothing', !!db.mustFail(() => db.anon('select count(*) from public.saved_research;')));
  T.chk('anon saves nothing', !!db.mustFail(() => db.anon(`insert into public.saved_research (kind, title) values ('note', 'x');`)));
  T.chk('an empty title is refused', !!db.mustFail(() => db.as(A, `insert into public.saved_research (kind, title) values ('note', '');`)));
  T.chk('an unknown kind is refused', !!db.mustFail(() => db.as(A, `insert into public.saved_research (kind, title) values ('bet_slip', 'x');`)));
  T.chk('an answer over 20,000 characters is refused', !!db.mustFail(() => db.as(A, `insert into public.saved_research (kind, title, answer) values ('note', 'x', repeat('a', 20001));`)));
  T.chk('a payload over 200 KB is refused', !!db.mustFail(() => db.as(A, `insert into public.saved_research (kind, title, payload) values ('note', 'x', jsonb_build_object('a', repeat('a', 200001)));`)));
  db.sql(`insert into public.saved_research (user_id, kind, title) select '${B}', 'note', 'n' || g from generate_series(1, 499) g;`);
  const cap = db.mustFail(() => db.as(B, `insert into public.saved_research (kind, title) values ('note', 'the 501st');`));
  T.chk('the 501st item is refused with the reason', !!cap && /500 saved items is the limit/.test(cap), cap);
  T.chk('another reader is not affected by that cap', /^[0-9a-f-]{36}$/.test(ins(A, 'A again')));
  /* rollback */
  const before = db.sql('select count(*) from public.saved_research;');
  const rb = db.applyFile(ROLLBACK);
  T.chk('the rollback applies, its report ok', !/CHECK THIS/.test(rb), rb);
  T.chk('readers are cut off', !!db.mustFail(() => db.as(A, 'select count(*) from public.saved_research;')));
  T.chk('and every row is kept', db.sql('select count(*) from public.saved_research;') === before);
  T.chk('re-applying restores access to the same rows', !/CHECK THIS/.test(db.applyFile(SQL)) && db.as(A, 'select count(*) from public.saved_research;') === '1');
} catch (e) {
  T.chk('unexpected error: ' + String(e.message).slice(0, 400), false);
} finally {
  db.stop();
}
process.exit(T.done());
