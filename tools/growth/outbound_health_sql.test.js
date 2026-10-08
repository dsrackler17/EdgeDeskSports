#!/usr/bin/env node
/* ===========================================================================
   PHASE 11 — THE SYSTEM CHECK (supabase/growth_outbound.sql:
   self_check, attention, growth_outbound_health, and the tick's sweep).

     R  REPORT      the file's report and the console's checks are one and the
                    same (self_check); the owner's door returns them, owner
                    only, and changes nothing
     B  BROKEN      a broken invariant (a table's deny policy gone) fails its
                    check, and the owner is told first
     A  ATTENTION   each operational problem appears when, and only when, it
                    is true: spam complaints, bounces, a silent webhook, sends
                    never confirmed, a stopped clock, three failed morning
                    steps, a matching error, approvals left unsent, sending
                    blocked, a raised cap — most serious first, each saying
                    what to do
     S  SWEEP       the tick marks a send never confirmed for 23 hours failed
                    (as the send door would on a retry), on the record as the
                    system's; a younger one is left for its retry

   Run: node tools/growth/outbound_health_sql.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const SEED = require(path.join(__dirname, '_outbound_seed.js'));

const T = PG.kit('growth outbound health SQL');
const chk = T.chk;
const lit = PG.lit;
const FILE = path.join(PG.ROOT, 'supabase', 'growth_outbound.sql');

const db = PG.start('gohealth');
if (db.skip) { console.log('NOTE | ' + db.skip + ' — LIVE layer skipped'); process.exit(T.done()); }

const OWNER = '00000000-0000-0000-0000-0000000000a1';
const ADMIN = '00000000-0000-0000-0000-0000000000a2';
const j = (s) => JSON.parse(s);
const one = (sql) => db.sql(sql);
const own = (sql) => j(db.as(OWNER, sql));
const J = (o) => lit(JSON.stringify(o)) + '::jsonb';
const pid = (n) => '10000000-0000-0000-0000-' + String(n).padStart(12, '0');
const did = (n) => '20000000-0000-0000-0000-' + String(n).padStart(12, '0');
const health = () => own(`select public.growth_outbound_health();`);
const codes = () => health().attention.map((a) => a.code);
const has = (c) => codes().includes(c);
/* the superuser, past the table triggers, to set the scene (a test's privilege, never a door's) */
const scene = (sql) => one(`set session_replication_role = replica;\n${sql}\nset session_replication_role = origin;`);
const settings = (o) => own(`select public.growth_outbound_settings_update(${J(o)});`);

try {
  ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql', 'growth_outbound.sql']
    .forEach((f) => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f)));
  one(`insert into auth.users (id, email, email_confirmed_at) values ('${OWNER}', 'owner@edgedesk.test', now()), ('${ADMIN}', 'admin@edgedesk.test', now());
       insert into public.affiliate_admins (user_id) values ('${OWNER}'), ('${ADMIN}');
       select growth_outbound.grant_owner('owner@edgedesk.test');`);

  /* ══ R. ONE REPORT ════════════════════════════════════════════════════ */
  const report = db.applyFileAtomic(FILE).split('\n').filter((l) => /^\d+\|/.test(l));
  let h = health();
  chk('R the owner\'s door returns exactly the file\'s report: the same checks, in the same words', h.ok === true && h.total === report.length
    && h.checks.every((c, i) => report[i] === c.step + '|' + c.item + '|' + c.outcome), [h.total, report.length]);
  chk('R … and they all pass', h.passing === h.total && h.checks.every((c) => c.ok), h.checks.filter((c) => !c.ok));
  chk('R … including the hardening row (36): batches, ticks and discovery runs queue; the System check exists', h.checks.some((c) => c.step === 36 && c.ok));
  for (const [who, run] of [['anon', (s) => db.anon(s)], ['an affiliate admin', (s) => db.as(ADMIN, s)], ['the service role', (s) => db.service(s)]]) {
    const e = db.mustFail(() => run(`select public.growth_outbound_health();`));
    chk('R ' + who + ' cannot run the system check', !!e && /permission denied|outbound owner only/.test(e), e);
  }
  const act = one(`select count(*) from growth_outbound.activity;`);
  health(); health();
  chk('R running it changes nothing', one(`select count(*) from growth_outbound.activity;`) === act);
  chk('R a fresh install needs attention only for what really blocks it: sending is blocked (no postal address yet)',
    JSON.stringify(codes()) === JSON.stringify(['blocked']), codes());

  /* ══ B. A BROKEN INVARIANT ════════════════════════════════════════════ */
  one(`drop policy deny_clients on growth_outbound.conversions;`);
  h = health();
  chk('B a table without its deny policy fails its check', h.checks.some((c) => c.step === 4 && !c.ok) && h.passing === h.total - 1, h.checks.filter((c) => !c.ok));
  chk('B … and the owner is told first, naming it, and what to do', h.attention[0].code === 'check_failed' && h.attention[0].severity === 1
    && /row level security/.test(h.attention[0].text) && /run supabase\/growth_outbound\.sql again/i.test(h.attention[0].text), h.attention[0]);
  db.applyFileAtomic(FILE);
  chk('B running the file again restores it', !has('check_failed'));

  /* ══ A. WHAT NEEDS ATTENTION ══════════════════════════════════════════ */
  settings({ postal_address: 'EdgeDesk Sports, 100 Example St, Springfield, IL 62701', test_inbox: 'owner-test@edgedesk.test',
    unsubscribe_url_base: 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/' });
  one(`select growth_outbound.set_webhook_secret('whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw');`);
  chk('A configured: nothing needs attention', JSON.stringify(codes()) === '[]', codes());
  settings({ test_mode: false, confirm_live: true });
  ['Ana Bell', 'Bo Dunn', 'Cy Park'].forEach((nm, i) => {
    const [f, l] = nm.split(' '), dom = (f + l).toLowerCase() + '.test';
    one(SEED.strong({ id: pid(i + 1), name: nm, org: l + ' Media', email: f.toLowerCase() + '@' + dom, domain: dom, handle: (f + l).toLowerCase() })
      + SEED.draft({ id: did(i + 1), prospect: pid(i + 1), subject: 'Your work, ' + f, body: 'Hi ' + f + ',' }));
    own(`select public.growth_outbound_draft_approve(${lit(did(i + 1))}, ${lit(one(`select content_hash from growth_outbound.drafts where id = ${lit(did(i + 1))};`))});`);
  });
  chk('A drafts approved just now are not "waiting"', !has('approved_waiting'), codes());
  // sent live two days ago, and Resend never said a word
  const c1 = own(`select public.growth_outbound_send_claim(${lit(did(1))});`);
  own(`select public.growth_outbound_send_result(${lit(c1.send_id)}, 're_health_000001', null, false);`);
  one(`update growth_outbound.sends set sent_at = now() - interval '30 hours' where id = ${lit(c1.send_id)};`);
  chk('A a live email out for over a day with no event from Resend: the webhook is said to be silent', has('webhook_silent'), codes());
  one(`insert into growth_outbound.provider_events (event_id, event_type, message_id, send_id, outcome) values ('evt_h1', 'email.delivered', 're_health_000001', ${lit(c1.send_id)}, 'delivered');`);
  chk('A … an event arrives: no longer', !has('webhook_silent'));
  // a send handed over and never confirmed
  const c2 = own(`select public.growth_outbound_send_claim(${lit(did(2))});`);
  chk('A a claim just made is not a problem yet', !has('stale_claims'));
  scene(`update growth_outbound.sends set claimed_at = now() - interval '2 hours' where id = ${lit(c2.send_id)};`);
  chk('A … over an hour without an answer: said, with what to press', has('stale_claims') && /Try again/.test(health().attention.find((a) => a.code === 'stale_claims').text));
  // the morning run on, the clock never ticked
  settings({ automation_enabled: true });
  chk('A automation on but the clock never ticked: said, with the file to run', has('clock_stopped')
    && /growth_outbound_cron\.sql/.test(health().attention.find((a) => a.code === 'clock_stopped').text));
  one(`update growth_outbound.scheduler set last_tick_at = now() where id = 1;`);
  chk('A … a tick: no longer', !has('clock_stopped'));
  // three failed morning steps in a row
  scene(`insert into growth_outbound.research_runs (kind, started_by, input, ticket_sha256, ticket_expires_at, status, finished_at, error)
         select 'research', 'schedule', '{}', md5(g::text) || md5(g::text), now(), 'failed', now(), 'robots.txt disallows it' from generate_series(1, 3) g;`);
  chk('A three failed morning steps in a row: said, with why', has('runs_failing') && /robots\.txt disallows it/.test(health().attention.find((a) => a.code === 'runs_failing').text));
  // a matching error
  one(`update growth_outbound.scheduler set conversions_error = 'the Stripe ledger is unreachable' where id = 1;`);
  chk('A results that could not be matched: said', has('results_error'));
  one(`update growth_outbound.scheduler set conversions_error = null where id = 1;`);
  // an approval left unsent
  scene(`update growth_outbound.drafts set approved_at = now() - interval '4 days' where id = ${lit(did(3))};`);
  chk('A an approved draft unsent for over three days: said', has('approved_waiting'));
  // a raised cap
  settings({ max_sends_per_day: 40, confirm_cap_increase: true });
  chk('A a raised daily cap is noted', has('cap_raised') && /40 \(the default is 20\)/.test(health().attention.find((a) => a.code === 'cap_raised').text));
  // bounces and complaints, over the last 30 days of live email
  // thirty more live emails this month, each its own person and draft: two bounced, one marked as spam
  scene(`create temp table hp as select g, gen_random_uuid() as p, gen_random_uuid() as d from generate_series(1, 30) g;
         insert into growth_outbound.prospects (id, email, status) select p, 'x' || g || '@h.test', 'contacted' from hp;
         insert into growth_outbound.drafts (id, prospect_id, sequence_number, subject, body_text, status, approved_at, approved_by, approved_hash, approved_recipient)
           select d, p, 1, 's', 'b', 'sent', now(), ${lit(OWNER)}, 'h', 'x' || g || '@h.test' from hp;
         insert into growth_outbound.sends (prospect_id, draft_id, sequence_number, is_test, idempotency_key, sender, intended_recipient, recipient, subject,
           content_hash, claimed_by, sent_at, delivery_status, bounced_at, complained_at)
         select p, d, 1, false, 'k' || g, 'Davis', 'x' || g || '@h.test', 'x' || g || '@h.test', 's', 'h', ${lit(OWNER)}, now(),
                case when g <= 2 then 'bounced' when g = 3 then 'complained' else 'delivered' end,
                case when g <= 2 then now() end, case when g = 3 then now() end
           from hp;`);
  h = health();
  const order = h.attention.map((a) => a.code);
  chk('A 2 bounces in 32 live emails (6%): said, with the threshold', order.includes('bounces') && /Above 4%/.test(h.attention.find((a) => a.code === 'bounces').text), order);
  chk('A a spam complaint above 1 in 1,000: said', order.includes('complaints'));
  chk('A most serious first: complaints and bounces before stale sends, before approvals waiting, before the cap', order.indexOf('complaints') < order.indexOf('stale_claims')
    && order.indexOf('bounces') < order.indexOf('stale_claims') && order.indexOf('stale_claims') < order.indexOf('approved_waiting')
    && order.indexOf('approved_waiting') < order.indexOf('cap_raised') && h.attention.every((a, i, all) => i === 0 || all[i - 1].severity <= a.severity), order);

  /* ══ S. THE SWEEP ═════════════════════════════════════════════════════ */
  scene(`update growth_outbound.sends set claimed_at = now() - interval '24 hours' where id = ${lit(c2.send_id)};`);
  settings({ automation_enabled: false });
  const t = j(one(`select growth_outbound.schedule_tick('https://iattxbkbufslbauoumga.supabase.co/functions/v1/');`));
  chk('S the tick marks a send never confirmed for 23 hours failed — never retried, so never sent twice', t.action === 'idle'
    && one(`select delivery_status || '|' || (failed_at is not null) || '|' || failure_reason from growth_outbound.sends where id = ${lit(c2.send_id)};`)
       === 'failed|true|the first attempt\'s outcome is unknown and too old to retry safely: never sent twice', t);
  chk('S … on the record, as the system\'s', one(`select actor_kind || '|' || (detail->>'by') from growth_outbound.activity where action = 'send_abandoned' and entity_id = ${lit(c2.send_id)};`) === 'system|the scheduler');
  chk('S … and the stale-send warning is gone', !has('stale_claims'));
  const c3 = own(`select public.growth_outbound_send_claim(${lit(did(3))});`);
  scene(`update growth_outbound.sends set claimed_at = now() - interval '2 hours' where id = ${lit(c3.send_id)};`);
  one(`select growth_outbound.schedule_tick('https://iattxbkbufslbauoumga.supabase.co/functions/v1/');`);
  chk('S a younger unconfirmed send is left alone, for its retry', one(`select delivery_status from growth_outbound.sends where id = ${lit(c3.send_id)};`) === 'claimed');

  const out = db.applyFileAtomic(FILE);
  chk('the file runs again over all of this, its report from the same function', /^36\|hardening/m.test(out) && !/CHECK THIS/.test(out.split('\n').filter((l) => !/^35\|/.test(l)).join('\n')),
    out.split('\n').filter((l) => /CHECK THIS/.test(l)));
} catch (err) {
  chk('suite ran to the end', false, String(err && err.stack || err).slice(0, 3000));
} finally {
  db.stop();
}
process.exit(T.done());
