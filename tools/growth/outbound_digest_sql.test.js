#!/usr/bin/env node
/* ===========================================================================
   THE DAILY EMAIL (2026-10), in the database — supabase/growth_outbound.sql
   section 13: "N drafts are waiting for your review", to the OWNER only.
   pg_net is stood in for: http_post records what it was asked to send.

     S  SETTINGS   off by default; an owner turns it on and it goes to THAT
                   account's own confirmed address — there is no address to
                   type; an unconfirmed account cannot; a non-owner cannot
     P  PLAN       once a morning: when the morning run has nothing left to
                   do, or its window has closed (in the owner's time zone);
                   never while it works or pauses; never after the evening;
                   skipped when nothing waits; test drafts never count
     T  TICK       the decision is the tick's, when the morning run is idle:
                   a single-use ticket (only its hash kept) posted to the
                   digest function; once a day; a blocked address or an
                   error in it never stops the tick; a busy morning run comes
                   first
     K  TICKET     the daily email's ticket opens two doors (write it; say what
                   became of it) and no others — no run door, no send, no
                   draft; a run's ticket cannot open them; dead once answered
     C  CONTENT    to the owner's own address from EdgeDesk's domain; counts
                   only — no name, address, organization, site or draft; the
                   attention items in fixed words; written once per ticket
     R  RETRIES    tried again only when it surely did not go, 20 minutes
                   apart, three tries at most; a ticket that never came back
                   is failed (retried only if never written); the System check
                   says when it could not be sent
     N  NEVER      no send row, no draft, no prospect touched; the daily cap
                   and the results untouched; the record is the owner's alone
                   (no client role reads it) and never deleted; the door is
                   to a prospect's address, a turned-off email, a revoked
                   owner: refused
     O  OVERVIEW   the morning-run panel and the System check show it, never
                   a ticket hash

   Run: node tools/growth/outbound_digest_sql.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const crypto = require('crypto');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const SEED = require(path.join(__dirname, '_outbound_seed.js'));
const { middayZone } = require(path.join(__dirname, '_morning.js'));

const T = PG.kit('growth outbound daily email SQL');
const chk = T.chk;
const lit = PG.lit;
const FILE = path.join(PG.ROOT, 'supabase', 'growth_outbound.sql');
const SRC = require('fs').readFileSync(FILE, 'utf8');

/* ══ the source, before any database ══════════════════════════════════════ */
{
  const fnBody = (name) => { const a = SRC.indexOf('create or replace function growth_outbound.' + name + '('); return a < 0 ? '' : SRC.slice(a, SRC.indexOf('\nend $$;', a)); };
  chk('the daily email\'s door opens with its own ticket check, and refuses without one',
    /\nbegin\n\s*v_id := growth_outbound\.digest_for_ticket\(p_ticket\);\n\s*if v_id is null then return jsonb_build_object\('ok', false, 'reason', 'invalid_ticket'\); end if;/.test(fnBody('digest_door')));
  chk('… and is reached only through the ticket door, when a ticket is not a run\'s',
    /v_run := growth_outbound\.ticket_run\(p_ticket\);\n\s*if v_run is null then return growth_outbound\.digest_door\(p_ticket, p_door, p_args\); end if;/.test(SRC)
    && (SRC.match(/return growth_outbound\.digest_door\(/g) || []).length === 1 && (SRC.match(/\bdigest_door\(p_ticket, p_door, p_args\)/g) || []).length === 1);
  const parts = ['digest_plan', 'digest_for_ticket', 'digest_door', 'digest_end', 'digest_sweep', 'digest_tick', 'digest_compose', 'digest_result'].map(fnBody);
  chk('no part of the daily email writes a send, a draft, a prospect or a suppression, or reaches a door that does',
    parts.every((b) => b.length > 100) && !parts.some((b) => /(insert into|update|delete from)\s+growth_outbound\.(sends|drafts|prospects|suppressions|evidence)\b|send_claim|send_result|approve_one|draft_approve|growth_outbound\.apply_suppression|growth_outbound\.suppress/.test(b)));
  chk('the address is the database\'s: the compose door reads digest_recipient(), and no request field names one',
    /v_to := growth_outbound\.digest_recipient\(\);/.test(fnBody('digest_compose')) && !/p_to|->>'to'/.test(fnBody('digest_door') + fnBody('digest_compose')));
}

const db = PG.start('godigest');
if (db.skip) { console.log('NOTE | ' + db.skip + ' — LIVE layer skipped'); process.exit(T.done()); }

const OWNER = '00000000-0000-0000-0000-0000000000a1';
const OWNER2 = '00000000-0000-0000-0000-0000000000a4';
const OWNER3 = '00000000-0000-0000-0000-0000000000a5';
const ADMIN = '00000000-0000-0000-0000-0000000000a2';
const SUB = '00000000-0000-0000-0000-0000000000a3';
const BASE = 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/';
const j = (s) => JSON.parse(s);
const one = (sql) => db.sql(sql);
const own = (sql, who) => j(db.as(who || OWNER, sql));
const J = (o) => lit(JSON.stringify(o)) + '::jsonb';
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const settings = (o, who) => own(`select public.growth_outbound_settings_update(${J(o)});`, who);
const S = (who) => own(`select public.growth_outbound_settings();`, who);
const tick = (at, base) => j(one(`select growth_outbound.schedule_tick(${lit(base === undefined ? BASE : base)}, ${at || 'now()'});`));
const dplan = (at) => j(one(`select growth_outbound.digest_plan(${at || 'now()'});`));
const door = (ticket, name, args) => j(db.anon(`select public.growth_outbound_scheduled(${lit(ticket)}, ${lit(name)}, ${J(args || {})});`));
const calls = () => j(one(`select coalesce(jsonb_agg(to_jsonb(c) order by c.id), '[]') from net.calls c;`));
const digests = () => j(one(`select coalesce(jsonb_agg(to_jsonb(d) order by d.id), '[]') from growth_outbound.digests d;`));
const today = () => digests().slice(-1)[0];
const reset = () => one(`set session_replication_role = replica; delete from growth_outbound.digests; set session_replication_role = origin; delete from net.calls;`);
const ticketOf = (c) => c.body.ticket;
const lastTicket = () => ticketOf(calls().slice(-1)[0]);
const backdate = (mins) => one(`update growth_outbound.digests set updated_at = now() - interval '${mins} minutes';`);
const attention = () => own(`select public.growth_outbound_health();`).attention.map((a) => a.code);
const sendsCount = () => +one(`select count(*) from growth_outbound.sends;`);
const draftStates = () => one(`select string_agg(id::text || ':' || status, ',' order by id) from growth_outbound.drafts;`);

// fixed moments in New York (the default zone; the window opens at 6 for 4 hours)
const AT = (utc) => `'${utc}'::timestamptz`;
const NY_0730 = AT('2026-10-08 11:30:00+00');
const NY_1100 = AT('2026-10-08 15:00:00+00');
const NY_2159 = AT('2026-10-09 01:59:00+00');
const NY_2200 = AT('2026-10-09 02:00:00+00');
const NY_0500_NEXT = AT('2026-10-09 09:00:00+00');

const P = (n) => '00000000-0000-0000-0000-0000000001' + String(n).padStart(2, '0');
const D = (n) => '00000000-0000-0000-0000-0000000002' + String(n).padStart(2, '0');
const PROS = [
  { id: P(1), name: 'Pat Analyst', email: 'pat@cfbnumbers.test', domain: 'cfbnumbers.test', handle: 'PatAnalyst', org: 'CFB Numbers' },
  { id: P(2), name: 'Quinn Model', email: 'quinn@gridedge.test', domain: 'gridedge.test', handle: 'QuinnModel', org: 'Grid Edge' },
  { id: P(3), name: 'Rory Ratings', email: 'rory@sharpcfb.test', domain: 'sharpcfb.test', handle: 'RoryRatings', org: 'Sharp CFB' },
  { id: P(4), name: 'Sam Spreads', email: 'sam@linelab.test', domain: 'linelab.test', handle: 'SamSpreads', org: 'Line Lab' },
];
const TEST_P = { id: P(9), name: 'Tess Tester', email: 'tess@fixture.test', domain: 'fixture.test', handle: 'TessTester', org: 'Fixture Co', test: true };

try {
  ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql', 'growth_outbound.sql']
    .forEach((f) => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f)));
  one(`insert into auth.users (id, email, email_confirmed_at) values ('${OWNER}', 'Owner@EdgeDesk.test', now()), ('${OWNER2}', 'owner2@edgedesk.test', now()),
         ('${OWNER3}', 'owner3@edgedesk.test', now()), ('${ADMIN}', 'admin@edgedesk.test', now()), ('${SUB}', 'sub@edgedesk.test', now());
       insert into public.affiliate_admins (user_id) values ('${OWNER}'), ('${OWNER2}'), ('${OWNER3}'), ('${ADMIN}');
       select growth_outbound.grant_owner('owner@edgedesk.test');
       select growth_outbound.grant_owner('owner2@edgedesk.test');
       select growth_outbound.grant_owner('owner3@edgedesk.test');`);
  one(`create schema if not exists net;
       create table net.calls (id bigserial primary key, url text, body jsonb, headers jsonb, timeout_milliseconds int);
       create or replace function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
                                                headers jsonb default '{}'::jsonb, timeout_milliseconds int default 5000)
       returns bigint language sql as $$ insert into net.calls (url, body, headers, timeout_milliseconds)
                                          values (url, body, headers, timeout_milliseconds) returning id $$;`);
  PROS.concat([TEST_P]).forEach((p) => one(SEED.strong(p)));

  /* ══ S. SETTINGS ════════════════════════════════════════════════════════ */
  let s = S();
  chk('S off by default, with nobody to send to; the owner\'s id is never shown, only the address',
    s.digest_enabled === false && s.digest_to === null && !('digest_owner' in s), s);
  let r = settings({ digest_to: 'someone@else.test' });
  chk('S an address cannot be typed in (there is no such setting)', r.ok === false && r.reason === 'unknown_setting', r);
  r = settings({ digest_owner: ADMIN });
  chk('S … nor whom it goes to', r.ok === false && r.reason === 'unknown_setting', r);
  r = settings({ digest_enabled: true });
  chk('S an owner turns it on: it goes to their own account\'s address (normalized)', r.ok === true && r.settings.digest_enabled === true
    && r.settings.digest_to === 'owner@edgedesk.test' && one(`select digest_owner from growth_outbound.settings;`) === OWNER, r);
  chk('S … and the change is on the record, with whom it now goes to', r.changed.digest_enabled && r.changed.digest_owner && r.changed.digest_owner.to === OWNER
    && one(`select count(*) from growth_outbound.activity where action = 'settings_changed' and detail ? 'digest_owner';`) === '1', r.changed);
  chk('S an affiliate admin who is not an outbound owner cannot touch it', /outbound owner only/.test(db.mustFail(() => db.as(ADMIN, `select public.growth_outbound_settings_update('{"digest_enabled": false}'::jsonb);`)) || ''));
  chk('S … nor can anybody signed out', /permission denied/.test(db.mustFail(() => db.anon(`select public.growth_outbound_settings_update('{"digest_enabled": false}'::jsonb);`)) || ''));
  one(`update auth.users set email_confirmed_at = null where id = '${OWNER2}';`);
  r = settings({ digest_enabled: true }, OWNER2);
  chk('S an owner whose address is not confirmed cannot turn it on to themselves', r.ok === false && r.reason === 'invalid_value'
    && /not confirmed/.test(r.detail) && one(`select digest_owner from growth_outbound.settings;`) === OWNER, r);
  one(`update auth.users set email_confirmed_at = now() where id = '${OWNER2}';`);
  r = settings({ digest_enabled: true }, OWNER2);
  chk('S another owner turning it on takes it to their own address', r.ok === true && r.settings.digest_to === 'owner2@edgedesk.test', r);
  r = settings({ digest_enabled: false });
  chk('S turned off: nobody is set to receive it', r.ok === true && r.settings.digest_to === null && one(`select coalesce(digest_owner::text, 'none') from growth_outbound.settings;`) === 'none', r);
  settings({ digest_enabled: true });

  /* ══ P. THE PLAN ════════════════════════════════════════════════════════ */
  let p = dplan(NY_0730);
  chk('P inside the window with the morning run off, and nothing waiting for review: skip (said once)', p.action === 'skip' && p.waiting === 0
    && p.day === '2026-10-08' && p.in_window === true && /nothing waits for review/.test(p.reason), p);
  one(SEED.draft({ id: D(1), prospect: P(1), subject: 'Your CFB ratings', body: 'Hi Pat, a 7-day free trial, then $49.99/month.' })
    + SEED.draft({ id: D(2), prospect: P(2), subject: 'Your CFB ratings', body: 'Hi Quinn, a 7-day free trial, then $49.99/month.' })
    + SEED.draft({ id: D(3), prospect: P(3), seq: 2, subject: 'Following up', body: 'Hi Rory, following up.' })
    + SEED.draft({ id: D(9), prospect: TEST_P.id, test: true, subject: 'Test', body: 'Hi Tess.' }));
  p = dplan(NY_0730);
  chk('P with drafts waiting: send — and a test draft never counts', p.action === 'send' && p.waiting === 3, p);
  settings({ automation_enabled: true, discovery_config: { queries: ['cfb power ratings newsletter'] } });
  p = dplan(NY_0730);
  chk('P while the morning run has a step to take: wait', p.action === 'wait' && p.reason === 'the morning run is still working', p);
  one(`insert into growth_outbound.research_runs (kind, started_by, input, ticket_sha256, ticket_expires_at, started_at)
       values ('discover', 'schedule', '{}', ${lit(sha('busy'))}, '2026-10-08 11:40+00', '2026-10-08 11:25+00');`);
  p = dplan(NY_0730);
  chk('P while a scheduled run is still going: wait', p.action === 'wait' && p.reason === 'the morning run is still working', p);
  one(`update growth_outbound.research_runs set status = 'done', finished_at = '2026-10-08 11:28+00' where ticket_sha256 = ${lit(sha('busy'))};`);
  p = dplan(NY_1100);
  chk('P the window has closed (11:00 in New York): send', p.action === 'send' && p.in_window === false && p.day === '2026-10-08', p);
  chk('P … until 22:00 that evening (the window\'s end plus 12 hours)', dplan(NY_2159).action === 'send' && dplan(NY_2200).action === 'wait'
    && /too late/.test(dplan(NY_2200).reason) && dplan(NY_2200).day === '2026-10-08', dplan(NY_2200));
  p = dplan(NY_0500_NEXT);
  chk('P before the next window opens it is still yesterday\'s morning, and too late for it', p.day === '2026-10-08' && p.action === 'wait' && /too late/.test(p.reason), p);
  settings({ automation_start_hour: 23, automation_hours: 3 });
  p = dplan(AT('2026-10-09 05:30:00+00'));
  chk('P a window that crosses midnight belongs to the day it opened', p.day === '2026-10-08' && p.in_window === true, p);
  settings({ automation_start_hour: 6, automation_hours: 4 });
  // pausing: a draft run that wrote nothing half an hour ago, and someone still due
  one(SEED.strong({ id: P(5), name: 'Val Value', email: 'val@valuecfb.test', domain: 'valuecfb.test', handle: 'ValValue', org: 'Value CFB' }));
  settings({ discovery_config: { queries: [] } });
  one(`insert into growth_outbound.research_runs (kind, started_by, input, ticket_sha256, ticket_expires_at, started_at, status, finished_at, counts)
       values ('discover', 'schedule', '{}', ${lit(sha('searched'))}, '2026-10-08 10:40+00', '2026-10-08 10:25+00', 'done', '2026-10-08 10:26+00', '{}'),
              ('draft', 'schedule', '{}', ${lit(sha('drew blank'))}, '2026-10-08 11:35+00', '2026-10-08 11:20+00', 'done', '2026-10-08 11:22+00', '{"drafted": 0}');`);
  const sp = j(one(`select growth_outbound.schedule_plan(${NY_0730});`));
  p = dplan(NY_0730);
  chk('P while the morning run only pauses before drafting again (someone is still due): wait',
    sp.step === null && sp.reason === 'nothing left to do this morning' && sp.today.due > 0
    && p.action === 'wait' && p.reason === 'the morning run is pausing before it tries again', { sp, p });
  settings({ automation_enabled: false });
  settings({ digest_enabled: false });
  chk('P turned off: nothing, whatever waits', dplan(NY_1100).action === 'wait' && dplan(NY_1100).reason === 'the daily email is off');
  settings({ digest_enabled: true });

  /* ══ T. THE TICK (the real clock: a zone where it is midday, a window that closed at 11) ═══ */
  const ZONE = middayZone();
  settings({ automation_timezone: ZONE, automation_start_hour: 8, automation_hours: 3 });
  const LOCAL_DAY = one(`select (now() at time zone ${lit(ZONE)})::date;`);
  const before = { sends: sendsCount(), drafts: draftStates(), prospects: one(`select md5(string_agg(to_jsonb(p)::text, '' order by id)) from growth_outbound.prospects p;`),
    cap: one(`select growth_outbound.live_send_cap()::text;`), conversions: one(`select count(*) from growth_outbound.conversions;`) };
  r = tick(null, 'https://evil.example.com/functions/v1/');
  chk('T not a Supabase functions address: nothing started, and said', r.action === 'idle' && r.digest && r.digest.action === 'blocked'
    && digests().length === 0 && calls().length === 0, r);
  r = tick();
  const T1 = lastTicket();
  let d = today();
  chk('T the morning run idle, its window closed, drafts waiting: today\'s email starts', r.action === 'idle' && r.digest.action === 'started'
    && r.digest.day === LOCAL_DAY && r.digest.waiting === 3 && d.status === 'sending' && d.attempts === 1 && d.recipient_owner === OWNER, { r, d });
  const c = calls().slice(-1)[0];
  chk('T posted through pg_net to the digest function, with the ticket alone', calls().length === 1
    && c.url === 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/growth_outbound_digest'
    && JSON.stringify(Object.keys(c.body).sort()) === '["action","ticket"]' && c.body.action === 'scheduled' && /^[0-9a-f]{64}$/.test(T1)
    && JSON.stringify(c.headers) === '{"content-type":"application/json"}', c);
  chk('T only the ticket\'s hash is kept, and the ticket appears nowhere in the database',
    d.ticket_sha256 === sha(T1) && one(`select count(*) from growth_outbound.activity a where a::text like ${lit('%' + T1 + '%')};`) === '0'
    && one(`select count(*) from growth_outbound.digests d where d::text like ${lit('%' + T1 + '%')};`) === '0'
    && one(`select count(*) from growth_outbound.scheduler x where x::text like ${lit('%' + T1 + '%')};`) === '0');
  r = tick();
  chk('T the next tick: nothing more (one email a morning)', !r.digest && calls().length === 1 && digests().length === 1
    && dplan().reason === 'this morning\'s email is on its way', { r, plan: dplan() });

  /* ══ K. THE TICKET ══════════════════════════════════════════════════════ */
  for (const name of ['plan', 'growth_outbound_research_finish', 'growth_outbound_draft_propose', 'growth_outbound_drafting_overview',
                      'growth_outbound_send_claim', 'growth_outbound_draft_approve', 'growth_outbound_settings_update', 'growth_outbound_suppress', '']) {
    r = door(T1, name, { p_run: 1 });
    chk('K the daily email\'s ticket cannot open ' + (name || '(no door)'), r.ok === false && r.reason === 'not_allowed', r);
  }
  chk('K nor with arguments that are not an object', door(T1, 'digest_compose', [1]).reason === 'not_allowed');
  chk('K a made-up ticket, or none, opens nothing', door('0'.repeat(64), 'digest_compose').reason === 'invalid_ticket'
    && door('not a ticket', 'digest_compose').reason === 'invalid_ticket' && door(null, 'digest_compose').reason === 'invalid_ticket');
  // a live scheduled run's ticket (automation on) cannot reach the daily email's doors
  one(`update growth_outbound.settings set automation_enabled = true;`);
  one(`insert into growth_outbound.research_runs (kind, started_by, input, ticket_sha256, ticket_expires_at)
       values ('draft', 'schedule', '{}', ${lit(sha('a'.repeat(64)))}, now() + interval '10 minutes');`);
  r = door('a'.repeat(64), 'digest_compose');
  chk('K a morning-run ticket cannot open the daily email\'s doors', r.ok === false && r.reason === 'not_allowed', r);
  chk('K (that ticket is live: it opens its own run\'s plan)', door('a'.repeat(64), 'plan').ok === true);
  one(`update growth_outbound.research_runs set status = 'done', finished_at = now() where ticket_sha256 = ${lit(sha('a'.repeat(64)))};
       update growth_outbound.settings set automation_enabled = false;`);
  chk('K a signed-in account cannot even try the ticket door (anon only)', /permission denied/.test(db.mustFail(() => db.as(OWNER, `select public.growth_outbound_scheduled(${lit(T1)}, 'digest_compose', '{}');`)) || ''));
  chk('K no client role reaches the daily email\'s parts', ['digest_door(text,text,jsonb)', 'digest_compose(bigint)', 'digest_tick(text,timestamptz)', 'digest_plan(timestamptz)']
    .every((f) => ['anon', 'authenticated', 'service_role'].every((role) => one(`select has_function_privilege('${role}', 'growth_outbound.${f}', 'execute');`) === 'f')));
  r = door(T1, 'digest_result', { p_message_id: 'msg_early' });
  chk('K nothing is recorded as sent before it is written', r.ok === false && r.reason === 'not_composed' && today().status === 'sending', r);

  /* ══ C. THE CONTENT ═════════════════════════════════════════════════════ */
  r = door(T1, 'digest_compose');
  const m = r.message || {};
  chk('C written for the owner\'s own address, from EdgeDesk\'s domain', r.ok === true && r.kind === 'owner_digest' && m.to === 'owner@edgedesk.test'
    && m.from === 'EdgeDesk outbound <davis@edgedesksports.com>' && JSON.stringify(Object.keys(m).sort()) === '["from","subject","text","to"]', r);
  chk('C the counts: how many wait, first emails and follow-ups', m.subject === '3 outbound drafts are ready for your review'
    && m.text.startsWith('3 drafts are waiting for your review: 2 first emails, 1 follow-up.'), m);
  chk('C test mode is said; the link is the console', /Test mode is on: an approved email goes only to your test inbox\./.test(m.text)
    && /Review them: https:\/\/edgedesksports\.com\/admin\/growth\//.test(m.text) && /Nothing goes to a prospect until you approve it and press Send\./.test(m.text), m.text);
  const leaks = PROS.concat([TEST_P]).flatMap((x) => [x.name, x.name.split(' ')[0], x.email, x.org, x.domain, x.handle])
    .concat(['Your CFB ratings', 'Following up', 'cfbnumbers', 'ratings against', P(1), D(1)]).filter((w) => (m.subject + '\n' + m.text).includes(w));
  chk('C nothing about anyone: no name, address, organization, site, handle, subject or id', leaks.length === 0, leaks);
  chk('C one key per try, never reused', r.idempotency_key === 'edgedesk-outbound-digest-' + d.id + '-1', r.idempotency_key);
  chk('C written once per ticket', door(T1, 'digest_compose').reason === 'already_composed' && !!today().composed_at);
  r = door(T1, 'digest_result', { p_message_id: 're id; drop' });
  chk('C a message id that is not one is refused, and nothing is marked sent', r.reason === 'invalid_message_id' && today().status === 'sending', r);
  r = door(T1, 'digest_result', { p_message_id: 'msg_digest_0001' });
  d = today();
  chk('C Resend\'s id: sent', r.ok === true && r.status === 'sent' && d.status === 'sent' && d.resend_message_id === 'msg_digest_0001' && !!d.sent_at, { r, d });
  const act = j(one(`select to_jsonb(a) from growth_outbound.activity a where action = 'digest_sent';`));
  chk('C on the record as the system\'s, with counts and no address', act.actor_kind === 'system' && act.prospect_id === null && act.detail.waiting === 3
    && !JSON.stringify(act).includes('edgedesk.test'), act);
  chk('C the ticket is dead once answered', door(T1, 'digest_compose').reason === 'invalid_ticket' && door(T1, 'digest_result', { p_message_id: 'msg_again' }).reason === 'invalid_ticket');
  chk('C … the ticket itself, not only the doors behind it', one(`select coalesce(growth_outbound.digest_for_ticket(${lit(T1)})::text, 'none');`) === 'none');
  r = tick();
  chk('C the next tick: nothing (it went out this morning)', !r.digest && calls().length === 1 && dplan().reason === 'this morning\'s email went out', r);

  /* ══ R. RETRIES AND FAILURES ════════════════════════════════════════════ */
  reset();
  tick();
  one(`update growth_outbound.digests set ticket_expires_at = now() - interval '1 minute';`);
  r = door(lastTicket(), 'digest_compose');
  chk('R a ticket past its 15 minutes opens nothing, even before the sweep marks it failed', r.ok === false && r.reason === 'invalid_ticket'
    && today().status === 'sending' && !today().composed_at, { r, d: today() });
  reset();
  tick();
  const R1 = lastTicket();
  door(R1, 'digest_compose');
  r = door(R1, 'digest_result', { p_error: 'Resend answered 503', p_retryable: true });
  chk('R a failure that surely did not send is marked retryable', r.ok === true && r.status === 'failed' && today().retryable === true && today().reason === 'Resend answered 503', today());
  r = tick();
  chk('R … not tried again at once', !r.digest && calls().length === 1 && /tried again shortly/.test(dplan().reason), dplan());
  backdate(21);
  r = tick();
  const R2 = lastTicket();
  chk('R twenty minutes later: a second try, with a new ticket; the first stays dead', r.digest && r.digest.action === 'started' && R2 !== R1
    && today().attempts === 2 && today().ticket_sha256 === sha(R2) && door(R1, 'digest_compose').reason === 'invalid_ticket', r);
  chk('R … and its own key', door(R2, 'digest_compose').idempotency_key === 'edgedesk-outbound-digest-' + today().id + '-2');
  door(R2, 'digest_result', { p_error: 'Resend answered 500', p_retryable: true });
  backdate(21);
  tick();
  const R3 = lastTicket();
  door(R3, 'digest_compose');
  door(R3, 'digest_result', { p_error: 'Resend answered 502', p_retryable: true });
  backdate(21);
  r = tick();
  chk('R three tries at most', !r.digest && calls().length === 3 && today().attempts === 3 && /could not be sent: Resend answered 502/.test(dplan().reason), { r, n: calls().length, plan: dplan() });
  chk('R the System check says so', attention().includes('digest_failed'));
  reset();
  tick();
  const N1 = lastTicket();
  door(N1, 'digest_compose');
  door(N1, 'digest_result', { p_error: 'Resend did not answer: it may have gone, so it is not sent again', p_retryable: false });
  backdate(60);
  r = tick();
  chk('R a failure that may have sent is never tried again', !r.digest && calls().length === 1 && today().retryable === false && attention().includes('digest_failed'), today());
  chk('R … and the plan says so, rather than offering to send', dplan().action === 'wait' && /could not be sent: Resend did not answer/.test(dplan().reason), dplan());
  r = door(N1, 'digest_result', { p_error: 'again' });
  chk('R the answer comes once', r.reason === 'invalid_ticket' && today().reason === 'Resend did not answer: it may have gone, so it is not sent again');
  reset();
  tick();
  door(lastTicket(), 'digest_compose');
  door(lastTicket(), 'digest_result', { p_error: 'line one\n\u0007line two\r\n' + 'x'.repeat(400), p_retryable: false });
  chk('R a reason is one plain line, 300 characters at most', /^line one line two x+$/.test(today().reason) && today().reason.length <= 300, today().reason);
  reset();
  tick();
  one(`update growth_outbound.digests set ticket_expires_at = now() - interval '16 minutes';`);
  r = tick();
  d = today();
  chk('R a ticket that never came back, never written: failed, and safe to try again', d.status === 'failed' && d.retryable === true
    && /never answered/.test(d.reason) && one(`select count(*) from growth_outbound.activity where action = 'digest_failed';`) >= '1', d);
  backdate(21);
  r = tick();
  chk('R … so it is tried again', r.digest && r.digest.action === 'started' && today().attempts === 2, r);
  door(lastTicket(), 'digest_compose');
  one(`update growth_outbound.digests set ticket_expires_at = now() - interval '16 minutes';`);
  tick();
  d = today();
  chk('R a ticket written and never answered may have gone: failed, never tried again', d.status === 'failed' && d.retryable === false && /may have gone out/.test(d.reason), d);
  backdate(60);
  chk('R … whatever the time', !tick().digest && calls().length === 2);

  /* ══ N. NEVER ═══════════════════════════════════════════════════════════ */
  reset();
  tick();
  settings({ digest_enabled: false });
  r = door(lastTicket(), 'digest_compose');
  chk('N turned off after the ticket went out: not written, and not tried again', r.ok === false && r.reason === 'digest_off' && today().status === 'failed' && today().retryable === false, r);
  settings({ digest_enabled: true });
  one(`update auth.users set email_confirmed_at = null where id = '${OWNER}';`);
  chk('N an owner whose address is no longer confirmed receives nothing', /nobody to send it to/.test(dplan().reason) && S().digest_to === null
    && !tick().digest && calls().length === 1, dplan());
  one(`update auth.users set email_confirmed_at = now() where id = '${OWNER}';`);
  settings({ digest_enabled: true }, OWNER2);
  reset();
  tick();
  chk('N it goes to whoever turned it on last', today().recipient_owner === OWNER2);
  one(`delete from growth_outbound.owners where user_id = '${OWNER2}';`);
  chk('N an owner who loses outbound stops receiving it at once', one(`select coalesce(digest_owner::text, 'none') from growth_outbound.settings;`) === 'none'
    && S().digest_to === null);
  r = door(lastTicket(), 'digest_compose');
  chk('N … even with a ticket already out', r.ok === false && r.reason === 'no_recipient' && today().status === 'failed', r);
  chk('N the System check says it has nobody to go to', attention().includes('digest_no_recipient') && /nobody to send it to/.test(dplan().reason), attention());
  // an owner whose address is also a prospect's (they are written to by the engine): refused, not guessed about
  one(SEED.weak({ id: P(7), name: 'Owner Three', email: 'owner3@edgedesk.test' }));
  settings({ digest_enabled: true }, OWNER3);
  reset();
  tick();
  r = door(lastTicket(), 'digest_compose');
  chk('N never to an address that is also a prospect\'s', r.ok === false && r.reason === 'recipient_is_a_prospect' && today().status === 'failed' && !r.message, r);
  settings({ digest_enabled: true });
  reset();
  chk('N through all of it: no send, no draft changed, no prospect touched, the cap and the results as they were',
    sendsCount() === before.sends && draftStates() === before.drafts
    && one(`select growth_outbound.live_send_cap()::text;`) === before.cap && one(`select count(*) from growth_outbound.conversions;`) === before.conversions
    && one(`select count(*) from growth_outbound.activity where action like 'digest%' and prospect_id is not null;`) === '0');
  for (const [who, run] of [['anon', (q) => db.anon(q)], ['a subscriber', (q) => db.as(SUB, q)], ['the owner (doors only)', (q) => db.as(OWNER, q)], ['the service role', (q) => db.service(q)]]) {
    chk('N ' + who + ' cannot read the daily email\'s record directly', /permission denied/.test(db.mustFail(() => run(`select count(*) from growth_outbound.digests;`)) || ''));
  }
  tick();
  chk('N the record is never deleted', /never deleted/.test(db.mustFail(() => one(`delete from growth_outbound.digests;`)) || ''));
  // a fault in the daily email never stops the tick
  const keep = one(`select pg_get_functiondef('growth_outbound.digest_tick(text,timestamptz)'::regprocedure);`);
  one(`create or replace function growth_outbound.digest_tick(p_base text, p_now timestamptz default now()) returns jsonb language plpgsql as $$ begin raise exception 'boom'; end $$;`);
  r = tick();
  chk('N an error in the daily email is reported and the tick goes on', r.action === 'idle' && r.digest && r.digest.action === 'error' && r.digest.reason === 'boom'
    && j(one(`select to_jsonb(s) from growth_outbound.scheduler s;`)).last_action === 'idle', r);
  one(keep + ';');
  // the morning run comes first
  reset();
  settings({ automation_enabled: true, automation_start_hour: 11, automation_hours: 3, discovery_config: { queries: ['cfb model newsletter'] } });
  // (the searches the plan tests recorded were "today"; move them to an earlier day)
  one(`update growth_outbound.research_runs set status = 'done', finished_at = now() - interval '2 days' + interval '1 minute', started_at = now() - interval '2 days'
        where started_by = 'schedule';`);
  r = tick();
  chk('N while the morning run has a step to take, the step goes first and no email', r.action === 'started' && r.kind === 'discover' && digests().length === 0
    && calls().every((x) => /growth_outbound_research$/.test(x.url)), r);
  one(`update growth_outbound.research_runs set status = 'done', finished_at = now() where status = 'running';`);
  settings({ automation_enabled: false, automation_start_hour: 8, automation_hours: 3 });

  /* ══ C2. WHAT ELSE THE NOTE SAYS ════════════════════════════════════════ */
  reset();
  // two of the waiting drafts written by this morning's run; one approved and not sent; live mode; settings incomplete
  one(`insert into growth_outbound.research_runs (kind, started_by, input, ticket_sha256, ticket_expires_at, status, finished_at, counts)
       values ('draft', 'schedule', '{}', ${lit(sha('wrote two'))}, now(), 'done', now(), '{"drafted": 2}');
       update growth_outbound.drafts set run_id = (select id from growth_outbound.research_runs where ticket_sha256 = ${lit(sha('wrote two'))})
        where id in (${lit(D(1))}, ${lit(D(3))});`);
  one(SEED.draft({ id: D(4), prospect: P(4), subject: 'Your CFB ratings', body: 'Hi Sam, a 7-day free trial, then $49.99/month.' }));
  const hash4 = one(`select content_hash from growth_outbound.drafts where id = ${lit(D(4))};`);
  r = own(`select public.growth_outbound_draft_approve(${lit(D(4))}, ${lit(hash4)});`);
  chk('C2 (setup: one draft approved by the owner)', r.ok === true, r);
  r = settings({ test_mode: false, confirm_live: true });
  chk('C2 (setup: live mode)', r.ok === true, r);
  tick();
  r = door(lastTicket(), 'digest_compose');
  const t2 = (r.message || {}).text || '';
  const dayName = one(`select to_char(${lit(LOCAL_DAY)}::date, 'FMDay, FMMonth FMDD');`);
  chk('C2 how many the morning run wrote, and on which morning', t2.includes('The morning run wrote 2 of them on ' + dayName + '.'), t2);
  chk('C2 approved and not yet sent', t2.includes('1 approved draft has not been sent yet.'), t2);
  chk('C2 live: what may still go out today, under the warm-up cap', t2.includes('Live emails you may still send today: 10 of 10.') && !/Test mode/.test(t2), t2);
  chk('C2 what needs attention, in fixed words', t2.includes('Needs your attention (Outbound, System check):') && t2.includes('- Sending is blocked until the settings are complete.')
    && t2.includes('- The sending domain has not been checked in 30 days.'), t2);
  door(lastTicket(), 'digest_result', { p_message_id: 'msg_digest_0002' });
  settings({ test_mode: true });

  /* ══ SKIP ═══════════════════════════════════════════════════════════════ */
  reset();
  tick();
  for (const id of [D(1), D(2), D(3)]) own(`select public.growth_outbound_draft_reject(${lit(id)}, 'not now');`);
  r = door(lastTicket(), 'digest_compose');
  chk('N nothing waiting by the time it is written: skipped, nothing sent', r.ok === false && r.reason === 'nothing_waiting' && today().status === 'skipped' && !r.message, r);
  reset();
  r = tick();
  chk('N nothing waiting at all: the morning is skipped, on the record, without a ticket', r.digest && r.digest.action === 'skipped' && today().status === 'skipped'
    && today().ticket_sha256 === null && calls().length === 0, r);
  one(SEED.draft({ id: D(5), prospect: P(5), subject: 'Your CFB ratings', body: 'Hi Val, a 7-day free trial, then $49.99/month.' }));
  r = tick();
  chk('N … and decided once: a draft arriving later that day does not bring an email', !r.digest && calls().length === 0 && digests().length === 1, r);

  /* ══ O. THE OVERVIEW AND THE SYSTEM CHECK ═══════════════════════════════ */
  const ov = own(`select public.growth_outbound_automation_overview();`);
  chk('O the morning-run panel shows the daily email: on, to whom, what next, the last mornings',
    ov.digest && ov.digest.enabled === true && ov.digest.to === 'owner@edgedesk.test' && ov.digest.plan && ov.digest.plan.day === LOCAL_DAY
    && Array.isArray(ov.digest.recent) && ov.digest.recent.length === 1 && ov.digest.recent[0].status === 'skipped', ov.digest);
  chk('O … never a ticket hash or an account id', !/ticket_sha256|ticket_expires_at|recipient_owner/.test(JSON.stringify(ov.digest)));
  chk('O only the owner sees it', /outbound owner only/.test(db.mustFail(() => db.as(ADMIN, `select public.growth_outbound_automation_overview();`)) || ''));
  const checks = j(one(`select jsonb_agg(to_jsonb(c) order by c.step) from growth_outbound.self_check() c;`));
  const row38 = checks.find((x) => x.step === 38) || {};
  chk('O the System check proves the daily email\'s rules, and says where it goes', row38.outcome === 'ok'
    && /on, to owner@edgedesk\.test; last \d{4}-\d\d-\d\d skipped/.test(row38.item), row38);
  chk('O every System check row is ok', checks.every((x) => /^ok/.test(x.outcome)), checks.filter((x) => !/^ok/.test(x.outcome)));
  chk('O twenty tables, every one denied to clients', one(`select count(*) from pg_tables where schemaname = 'growth_outbound';`) === '20'
    && one(`select count(*) from pg_policies where schemaname = 'growth_outbound' and tablename = 'digests' and policyname = 'deny_clients' and permissive = 'RESTRICTIVE';`) === '1');
} catch (e) {
  chk('the suite ran to the end', false, String(e && (e.sqlMessage || e.message) || e).slice(0, 900));
} finally {
  db.stop();
}
process.exit(T.done());
