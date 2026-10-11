#!/usr/bin/env node
/* ===========================================================================
   supabase/ai_usage.sql on a throwaway PostgreSQL (tools/personal/_pg.js, the
   Supabase shim: auth.uid() from the JWT claim, real anon / authenticated /
   service_role).

   Proves: applies clean, twice and as one transaction; a claim is counted per
   reader and per day; a spent PRO allowance downgrades to LITE and is never
   refused for PRO alone; a spent LITE allowance refuses; twelve concurrent
   claims from one reader against a limit of five take exactly five (the
   advisory lock); a reader settles only their own claim and only once;
   nothing is deleted, the claim's columns cannot be rewritten; a reader sees
   only their own rows and cannot read or edit the policy; anon can do
   nothing; the switch-off answers UNMETERED; the operator's view is service
   only; the rollback removes the functions and keeps the ledger; re-apply.

   Run: node tools/intelligence/ai_usage_sql.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const PG = require('../personal/_pg.js');
const ROOT = path.join(__dirname, '..', '..');
const SQL = path.join(ROOT, 'supabase', 'ai_usage.sql');
const ROLLBACK = path.join(ROOT, 'supabase', 'ai_usage_rollback.sql');
const T = PG.kit('ai usage SQL');
const A = '00000000-0000-0000-0000-0000000000a1', B = '00000000-0000-0000-0000-0000000000b2', C = '00000000-0000-0000-0000-0000000000c3';

const db = PG.start('aiuse');
if (!db || db.skip) {
  const note = 'SKIP | ' + ((db && db.skip) || 'no postgres') + ' — the SQL layer did not run';
  if (process.env.INTEL_SQL_REQUIRED === '1') T.chk('Postgres required but ' + note, false);
  process.exit(T.done(note));
}
const claim = (uid, route) => JSON.parse(db.as(uid, `select public.ai_usage_claim('${route}', 42)::text;`));
try {
  const r1 = db.applyFile(SQL);
  T.chk('applies to a clean database, every report row ok', !/CHECK THIS/.test(r1) && (r1.match(/\|ok/g) || []).length === 7, r1);
  T.chk('applies a second time', !/CHECK THIS/.test(db.applyFile(SQL)));
  T.chk('applies as one transaction', !/CHECK THIS/.test(db.applyFileAtomic(SQL)));
  db.service('update public.ai_usage_policy set pro_daily_limit = 2, lite_daily_limit = 4 where id = 1;');

  const c1 = claim(A, 'LITE');
  T.chk('a LITE claim is counted', c1.ok === true && c1.route === 'LITE' && c1.status === 'CLAIMED' && c1.used === 1 && c1.limit === 4 && c1.event_id > 0, c1);
  const p1 = claim(A, 'PRO'), p2 = claim(A, 'PRO');
  T.chk('PRO claims count up to the limit', p1.ok && p1.route === 'PRO' && p1.used === 1 && p2.ok && p2.used === 2, [p1, p2]);
  const p3 = claim(A, 'PRO');
  T.chk('a spent PRO allowance DOWNGRADES to LITE, never refused for PRO alone', p3.ok === true && p3.route === 'LITE' && p3.status === 'DOWNGRADED' && /cached research/.test(p3.reason), p3);
  T.chk('a downgrade is recorded and counts against nothing', db.sql(`select count(*) from public.ai_usage_events where user_id='${A}' and route='PRO' and status='DOWNGRADED';`) === '1'
    && JSON.parse(db.as(A, 'select public.my_ai_usage()::text;')).lite_used === 1);
  claim(A, 'LITE'); claim(A, 'LITE');
  const l4 = claim(A, 'LITE');
  T.chk('the fourth LITE question is the limit', l4.ok === true && l4.used === 4, l4);
  const l5 = claim(A, 'LITE');
  T.chk('a spent LITE allowance is REFUSED with the reset time', l5.ok === false && l5.status === 'REFUSED' && /resets at 00:00 UTC/.test(l5.reason), l5);
  T.chk('a refusal is recorded', db.sql(`select count(*) from public.ai_usage_events where user_id='${A}' and status='REFUSED';`) === '1');
  const b1 = claim(B, 'PRO');
  T.chk('another reader has their own allowance', b1.ok === true && b1.route === 'PRO' && b1.used === 1, b1);
  db.sql(`insert into public.ai_usage_events (user_id, usage_day, route, status) values ('${B}', current_date - 1, 'PRO', 'CLAIMED'), ('${B}', current_date - 1, 'PRO', 'CLAIMED');`);
  T.chk('yesterday does not count against today', claim(B, 'PRO').used === 2);

  /* concurrency: twelve claims at once from one reader, limit five */
  db.service('update public.ai_usage_policy set lite_daily_limit = 5 where id = 1;');
  const jobs = [];
  for (let i = 0; i < 12; i++) jobs.push(db.background(`begin; do $c$ begin perform set_config('request.jwt.claim.sub', '${C}', true); end $c$; set local role authenticated; select public.ai_usage_claim('LITE', 1)::text; commit;`));
  const outs = jobs.map((j) => j.wait(30000));
  const granted = outs.filter((o) => /"ok": true/.test(o.out)).length;
  T.chk('twelve concurrent claims against a limit of five grant exactly five', granted === 5 && db.sql(`select count(*) from public.ai_usage_events where user_id='${C}' and status='CLAIMED';`) === '5', { granted, codes: outs.map((o) => o.code) });

  /* settlement */
  const s1 = JSON.parse(db.as(A, `select public.ai_usage_settle(${c1.event_id}, 'answered', 'claude-test', 1200, 300, 2100)::text;`));
  T.chk('a reader settles their own claim', s1.ok === true && db.sql(`select tokens_in||'/'||tokens_out||'/'||outcome from public.ai_usage_events where id=${c1.event_id};`) === '1200/300/answered', s1);
  const s2 = JSON.parse(db.as(A, `select public.ai_usage_settle(${c1.event_id}, 'error')::text;`));
  T.chk('and only once', s2.ok === false && db.sql(`select outcome from public.ai_usage_events where id=${c1.event_id};`) === 'answered', s2);
  const s3 = JSON.parse(db.as(B, `select public.ai_usage_settle(${p1.event_id}, 'answered')::text;`));
  T.chk('a reader cannot settle someone else\'s claim', s3.ok === false && db.sql(`select coalesce(outcome,'none') from public.ai_usage_events where id=${p1.event_id};`) === 'none', s3);
  T.chk('an outcome outside the list is refused', !!db.mustFail(() => db.as(A, `select public.ai_usage_settle(${p1.event_id}, 'free_money')::text;`)));

  /* the table is reachable only through the functions */
  T.chk('a reader sees only their own rows', db.as(B, 'select count(distinct user_id) from public.ai_usage_events;') === '1');
  T.chk('a reader cannot insert directly', !!db.mustFail(() => db.as(A, `insert into public.ai_usage_events (user_id, route, status) values ('${A}', 'PRO', 'CLAIMED');`)));
  const rw = db.mustFail(() => db.as(A, `update public.ai_usage_events set status = 'CLAIMED' where user_id = '${A}' and status = 'REFUSED';`));
  T.chk('a reader cannot rewrite a refusal into a claim (no UPDATE privilege at all)', !!rw && /permission denied/.test(rw) && db.sql(`select count(*) from public.ai_usage_events where user_id='${A}' and status='REFUSED';`) === '1', rw);
  T.chk('nothing is deleted, even by the service role', !!db.mustFail(() => db.service(`delete from public.ai_usage_events where user_id='${A}';`)));
  T.chk('a claim\'s route cannot be rewritten, even by the service role', !!db.mustFail(() => db.service(`update public.ai_usage_events set route='LITE' where id=${p1.event_id};`)));
  T.chk('a reader cannot read the policy', !!db.mustFail(() => db.as(A, 'select * from public.ai_usage_policy;')));
  T.chk('nor change it', !!db.mustFail(() => db.as(A, 'update public.ai_usage_policy set pro_daily_limit = 100000;')) || db.sql('select pro_daily_limit from public.ai_usage_policy;') === '2');
  const mine = JSON.parse(db.as(A, 'select public.my_ai_usage()::text;'));
  T.chk('my_ai_usage reports the reader\'s own day', mine.pro_used === 2 && mine.pro_limit === 2 && mine.lite_used === 4, mine);
  T.chk('anon cannot claim', !!db.mustFail(() => db.anon("select public.ai_usage_claim('LITE');")));
  T.chk('anon reads nothing', !!db.mustFail(() => db.anon('select count(*) from public.ai_usage_events;')) || db.anon('select count(*) from public.ai_usage_events;') === '0');
  T.chk('the operator view is service-role only', !!db.mustFail(() => db.as(A, 'select * from public.ai_usage_daily;')) && Number(db.service('select sum(questions) from public.ai_usage_daily;')) > 0);
  T.chk('a claim with no signed-in reader is refused', JSON.parse(db.sql("select public.ai_usage_claim('LITE')::text;")).ok === false);
  T.chk('an unknown route is refused', claim(B, 'GOLD').ok === false);

  /* the switch */
  db.service('update public.ai_usage_policy set enabled = false where id = 1;');
  const off = claim(A, 'PRO');
  T.chk('switched off, a claim is UNMETERED and allowed', off.ok === true && off.status === 'UNMETERED', off);
  db.service('update public.ai_usage_policy set enabled = true where id = 1;');

  /* rollback and re-apply */
  const before = db.sql('select count(*) from public.ai_usage_events;');
  const rb = db.applyFile(ROLLBACK);
  T.chk('the rollback applies, report ok', !/CHECK THIS/.test(rb), rb);
  T.chk('it removes the functions', !!db.mustFail(() => db.as(A, "select public.ai_usage_claim('LITE');")));
  T.chk('and keeps every ledger row', db.sql('select count(*) from public.ai_usage_events;') === before);
  T.chk('the file re-applies over the kept ledger', !/CHECK THIS/.test(db.applyFile(SQL)) && claim(B, 'LITE').ok === true);
} catch (e) {
  T.chk('unexpected error: ' + String(e.message).slice(0, 400), false);
} finally {
  db.stop();
}
process.exit(T.done());
