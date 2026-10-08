#!/usr/bin/env node
/* ===========================================================================
   PHASE 9 — THE MORNING RUN, in the database
   supabase/growth_outbound.sql (schedule_plan, schedule_tick, the ticket door)
   and supabase/growth_outbound_cron.sql (the clock). pg_net and pg_cron are
   stood in for: http_post records what it was asked to send.

     T  TICK       nothing while automation is off or outside the window (in
                   the owner's time zone); says why in the scheduler's record
     D  DISCOVER   the first step of a morning: a run with a single-use
                   ticket, posted to the research function; only the ticket's
                   hash is kept, and the ticket appears nowhere else
     K  TICKET     the third public door: without a live ticket, refused and
                   nothing read; with one, only the doors its run's kind
                   needs, only for its run — never approve, edit, send,
                   suppress, settings or begin; dead once the run finishes,
                   expires, or automation is turned off; a forged setting is
                   worthless; a signed-in non-owner holding a ticket is still
                   refused
     R  RESEARCH   then the next new candidate, up to the daily target
     G  DRAFT      then drafts for whoever is due, up to the daily send cap;
                   a draft run that wrote nothing waits half an hour
     F  FAILURES   a run left running is failed after 30 minutes; three
                   failures in a row stop the day; 60 runs a day at most
     B  BLOCKED    no pg_net, or not a Supabase functions address: nothing
                   started, and said
     O  OVERVIEW   the owner sees the plan, the clock and the runs (never a
                   ticket hash); nobody else
     S  SETTINGS   the time zone, the start hour and the hours are checked
     C  CLOCK      the cron file schedules one tick every five minutes, with
                   no key, and replaces itself when run again

   Run: node tools/growth/outbound_schedule_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const SEED = require(path.join(__dirname, '_outbound_seed.js'));

const T = PG.kit('growth outbound schedule SQL');
const chk = T.chk;
const lit = PG.lit;
const FILE = path.join(PG.ROOT, 'supabase', 'growth_outbound.sql');
const CRON = path.join(PG.ROOT, 'supabase', 'growth_outbound_cron.sql');

const db = PG.start('goschedule');
if (db.skip) { console.log('NOTE | ' + db.skip + ' — LIVE layer skipped'); process.exit(T.done()); }

const OWNER = '00000000-0000-0000-0000-0000000000a1';
const ADMIN = '00000000-0000-0000-0000-0000000000a2';
const SUB = '00000000-0000-0000-0000-0000000000a3';
const BASE = 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/';
const j = (s) => JSON.parse(s);
const one = (sql) => db.sql(sql);
const own = (sql) => j(db.as(OWNER, sql));
const J = (o) => lit(JSON.stringify(o)) + '::jsonb';
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const settings = (o) => own(`select public.growth_outbound_settings_update(${J(o)});`);
// a morning hour in Chicago (the default zone since Phase 13): 2026-10-08 06:30 CDT = 11:30 UTC
const MORNING = `'2026-10-08 11:30:00+00'::timestamptz`;
const EVENING = `'2026-10-08 23:30:00+00'::timestamptz`;
// a fixed zone where the real clock reads 12:xx, so a run started now is "this morning" there
const UTC_H = new Date().getUTCHours(), K = UTC_H <= 12 ? 12 - UTC_H : 36 - UTC_H > 14 ? 12 - UTC_H : 36 - UTC_H;
const ZONE = K === 0 ? 'Etc/GMT' : K > 0 ? 'Etc/GMT-' + K : 'Etc/GMT+' + (-K);
const tick = (at, base) => j(one(`select growth_outbound.schedule_tick(${lit(base === undefined ? BASE : base)}, ${at || 'now()'});`));
const plan = (at) => j(one(`select growth_outbound.schedule_plan(${at || 'now()'});`));
const door = (ticket, name, args) => j(db.anon(`select public.growth_outbound_scheduled(${lit(ticket)}, ${lit(name)}, ${J(args || {})});`));
const calls = () => j(one(`select coalesce(jsonb_agg(to_jsonb(c) order by c.id), '[]') from net.calls c;`));
const lastCall = () => calls().slice(-1)[0];
const run = (id) => j(one(`select to_jsonb(r) from growth_outbound.research_runs r where id = ${id};`));
const sched = () => j(one(`select to_jsonb(s) from growth_outbound.scheduler s where id = 1;`));
const activityCount = () => +one(`select count(*) from growth_outbound.activity;`);
const finish = (ticket, st, counts) => door(ticket, 'growth_outbound_research_finish', { p_status: st || 'done', p_counts: counts || {} });

try {
  ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql', 'growth_outbound.sql']
    .forEach((f) => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f)));
  one(`insert into auth.users (id, email, email_confirmed_at) values ('${OWNER}', 'owner@edgedesk.test', now()), ('${ADMIN}', 'admin@edgedesk.test', now()),
         ('${SUB}', 'sub@edgedesk.test', now());
       insert into public.affiliate_admins (user_id) values ('${OWNER}'), ('${ADMIN}');
       select growth_outbound.grant_owner('owner@edgedesk.test');`);
  // pg_net, stood in for: every request it is asked to send is recorded
  one(`create schema if not exists net;
       create table net.calls (id bigserial primary key, url text, body jsonb, headers jsonb, timeout_milliseconds int);
       create or replace function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
                                                headers jsonb default '{}'::jsonb, timeout_milliseconds int default 5000)
       returns bigint language sql as $$ insert into net.calls (url, body, headers, timeout_milliseconds)
                                          values (url, body, headers, timeout_milliseconds) returning id $$;`);

  /* ══ T. THE TICK ══════════════════════════════════════════════════════ */
  let r = tick(MORNING);
  chk('T automation off (the default): the tick does nothing, and says why', r.action === 'idle' && r.reason === 'automation is off'
    && calls().length === 0 && one(`select count(*) from growth_outbound.research_runs;`) === '0', r);
  let sc = sched();
  chk('T … in the scheduler\'s record', sc.last_action === 'idle' && sc.last_reason === 'automation is off' && !!sc.last_tick_at && sc.ticks === 1, sc);
  settings({ automation_enabled: true, discovery_config: { queries: ['cfb power ratings newsletter'] } });
  r = tick(EVENING);
  chk('T outside the morning window (6:30 pm in Chicago, the owner\'s default zone): nothing', r.action === 'idle' && /^outside the morning window \(6:00, 4 hours, America\/Chicago\)$/.test(r.reason) && calls().length === 0, r);
  let p = plan(MORNING);
  chk('T the plan, in the owner\'s time zone: 06:30 in Chicago is inside the window', p.in_window === true && p.local_time === '2026-10-08 06:30'
    && p.timezone === 'America/Chicago' && p.step.kind === 'discover' && p.today.searched === false, p);
  // "today" is the owner's day: a search at 21:00 Chicago time the evening before (03:00 UTC, the same UTC day) was yesterday's
  one(`insert into growth_outbound.research_runs (kind, started_by, input, ticket_sha256, ticket_expires_at, status, finished_at, started_at)
       values ('discover', 'schedule', '{}', ${lit(sha('yesterday'))}, '2020-01-15 03:10+00', 'done', '2020-01-15 03:05+00', '2020-01-15 03:00+00');`);
  p = plan(`'2020-01-15 13:30:00+00'::timestamptz`);
  chk('T a day is the owner\'s day, in their zone: last evening\'s search does not count for this morning', p.in_window === true && p.step && p.step.kind === 'discover'
    && p.today.day === '2020-01-15' && p.today.searched === false, p);
  settings({ automation_timezone: 'Europe/London', automation_start_hour: 12, automation_hours: 2 });
  chk('T another zone, another window: 12:30 in London (11:30 UTC) is inside 12:00–14:00', plan(MORNING).in_window === true && plan(`'2026-10-08 13:30:00+00'::timestamptz`).in_window === false);
  settings({ automation_start_hour: 23, automation_hours: 3 });
  chk('T a window may cross midnight (23:00 for 3 hours)', plan(`'2026-10-08 00:30:00+00'::timestamptz`).in_window === true
    && plan(`'2026-10-08 21:30:00+00'::timestamptz`).in_window === false);
  // from here on the clock is the real one: a zone where it is midday now, a window around it
  settings({ automation_timezone: ZONE, automation_start_hour: 11, automation_hours: 3 });

  /* ══ D. DISCOVER ══════════════════════════════════════════════════════ */
  r = tick();
  chk('D in the window, the morning starts with the saved searches', r.action === 'started' && r.kind === 'discover' && r.run_id > 0, r);
  const R1 = r.run_id;
  let c = lastCall();
  const TK1 = c && c.body && c.body.ticket;
  chk('D … posted once to the research function, with a ticket and nothing else', calls().length === 1 && c.url === BASE + 'growth_outbound_research'
    && JSON.stringify(Object.keys(c.body).sort()) === '["action","ticket"]' && c.body.action === 'scheduled' && /^[0-9a-f]{64}$/.test(TK1)
    && c.headers['content-type'] === 'application/json' && !('authorization' in c.headers) && c.timeout_milliseconds === 150000, c);
  let rr = run(R1);
  chk('D the run: the scheduler\'s, running, its input marked scheduled, only the ticket\'s HASH kept, alive 15 minutes', rr.started_by === 'schedule'
    && rr.status === 'running' && rr.kind === 'discover' && rr.input.scheduled === true && rr.input.saved === true && rr.ticket_sha256 === sha(TK1)
    && rr.requested_by === null && Math.abs(new Date(rr.ticket_expires_at) - new Date(rr.started_at) - 15 * 60000) < 5000, rr);
  chk('D the ticket itself is nowhere in the database (the run, the record, the activity, the settings)', ['research_runs', 'scheduler', 'activity', 'settings']
    .every((t) => one(`select count(*) from growth_outbound.${t} x where to_jsonb(x)::text like ${lit('%' + TK1 + '%')};`) === '0'));
  chk('D … and it is on the record that the scheduler started it', one(`select actor_kind || '|' || coalesce(actor_user_id::text, '-') || '|' || (detail->>'kind')
      from growth_outbound.activity where action = 'schedule_started' and entity_id = '${R1}';`) === 'system|-|discover');
  sc = sched();
  chk('D … and the scheduler says so', sc.last_action === 'started' && sc.last_run_id === R1 && sc.last_reason === 'discover (run ' + R1 + ')', sc);
  r = tick();
  chk('D the next tick waits while a scheduled run is still going', r.action === 'idle' && r.reason === 'a scheduled run is still going' && calls().length === 1, r);

  /* ══ K. THE TICKET DOOR ═══════════════════════════════════════════════ */
  let before = activityCount();
  for (const [t, why] of [[crypto.randomBytes(32).toString('hex'), 'a ticket nobody issued'], ['not a ticket', 'a malformed one'], [null, 'none'],
    [TK1.toUpperCase(), 'the right one in capitals'], [TK1.slice(0, 63), 'one character short']]) {
    r = door(t, 'plan', {});
    chk('K refused: ' + why + ', and nothing else said', JSON.stringify(r) === JSON.stringify({ ok: false, reason: 'invalid_ticket' }), r);
  }
  chk('K … and nothing was written', activityCount() === before);
  r = door(TK1, 'plan', {});
  chk('K the ticket\'s plan: its run, its kind, its input', r.ok === true && r.run_id === R1 && r.kind === 'discover' && r.input.saved === true, r);
  for (const name of ['growth_outbound_draft_approve', 'growth_outbound_drafts_approve_batch', 'growth_outbound_send_claim', 'growth_outbound_send_result',
    'growth_outbound_draft_edit', 'growth_outbound_draft_reject', 'growth_outbound_settings_update', 'growth_outbound_suppress', 'growth_outbound_research_begin',
    'growth_outbound_prospect_set_status', 'growth_outbound_draft_propose', 'growth_outbound_research_ingest', 'growth_outbound_candidates_import',
    'growth_outbound_optout_check_record', 'growth_outbound_overview', 'nonsense']) {
    r = door(TK1, name, {});
    chk('K a discover ticket opens nothing else: ' + name, r.ok === false && r.reason === 'not_allowed', r);
  }
  // (Phase 13) a discover run may store the directory pages it reads, keep a
  // provider's answer for a while, and record what its providers said and cost
  for (const name of ['growth_outbound_page_record', 'growth_outbound_cache_get', 'growth_outbound_cache_put',
    'growth_outbound_provider_health_record', 'growth_outbound_provider_record']) {
    r = door(TK1, name, {});
    chk('K … a discover ticket may reach ' + name + ' (and it still checks its input)', !(r && r.reason === 'not_allowed'), r);
  }
  r = door(TK1, 'growth_outbound_research_spend', { p_run: R1 + 1000, p_provider: 'search' });
  chk('K a ticket acts for its own run only', r.ok === false && r.reason === 'not_allowed' && /its own run only/.test(r.detail), r);
  r = door(TK1, 'growth_outbound_research_spend', { p_provider: 'search', p_n: 1 });
  chk('K … and spends against today\'s budget like any run', r.ok === true && r.used === 1 && r.cap === 20, r);
  r = door(TK1, 'growth_outbound_candidates_record', { p_items: [{ url: 'https://cfbnumbers.test/', title: 'CFB Numbers', snippet: 'ratings', query: 'cfb', provider: 'brave' },
    { url: 'https://leelab.test/', title: 'Lee Lab', snippet: 'models', query: 'cfb', provider: 'brave' }] });
  chk('K a discover ticket records what discovery found', r.ok === true && r.new === 2, r);
  chk('K what the engine does on a ticket is on the record as the system\'s, not anybody\'s',
    one(`select count(*) from growth_outbound.activity where actor_user_id is not null and at > now() - interval '1 minute' and actor_kind = 'owner' and action like 'research_%';`) === '0');
  // a forged setting, and a ticket in the wrong hands
  let e = db.mustFail(() => db.as(SUB, `begin; select set_config('growth_outbound.ticket', ${lit(crypto.randomBytes(32).toString('hex'))}, true);
      select public.growth_outbound_research_spend(${R1}, 'search', 1); commit;`));
  chk('K a forged ticket setting opens nothing', !!e && /outbound owner only/.test(e), e);
  e = db.mustFail(() => db.as(SUB, `begin; select set_config('growth_outbound.ticket', ${lit(TK1)}, true);
      select public.growth_outbound_research_spend(${R1}, 'search', 1); commit;`));
  chk('K even the REAL ticket, set by a signed-in non-owner, opens nothing (a ticket works only through its own door)', !!e && /outbound owner only/.test(e), e);
  e = db.mustFail(() => db.anon(`begin; select set_config('growth_outbound.ticket', ${lit(TK1)}, true);
      select public.growth_outbound_research_spend(${R1}, 'search', 1); commit;`));
  chk('K … and anon cannot reach an engine door directly at all', !!e && /permission denied/.test(e), e);
  e = db.mustFail(() => one(`begin; select set_config('growth_outbound.ticket', ${lit(crypto.randomBytes(32).toString('hex'))}, true);
      select growth_outbound.require_engine(); commit;`));
  chk('K (the check alone) the engine check refuses a forged ticket setting even where no account is signed in', !!e && /outbound owner only/.test(e), e);
  chk('K (the check alone) … and lets the live ticket through', one(`begin; select set_config('growth_outbound.ticket', ${lit(TK1)}, true);
      select coalesce(growth_outbound.require_engine()::text, 'ticket'); commit;`).split('\n').includes('ticket'));
  for (const uid of [SUB, ADMIN, OWNER]) {
    e = db.mustFail(() => db.as(uid, `select public.growth_outbound_scheduled(${lit(TK1)}, 'plan', '{}'::jsonb);`));
    chk('K a signed-in caller cannot use the ticket door (anon only): ' + uid.slice(-2), !!e && /permission denied/.test(e), e);
  }
  r = finish(TK1, 'done', { queries: 1, new: 2 });
  chk('K the run finishes through its ticket', r.ok === true && r.run.status === 'done' && !('ticket_sha256' in r.run), r);
  chk('K … and then the ticket is dead', door(TK1, 'plan', {}).reason === 'invalid_ticket');

  /* ══ R. RESEARCH ══════════════════════════════════════════════════════ */
  settings({ daily_prospect_target: 2 });
  r = tick();
  chk('R searched today; new candidates waiting: the next step researches the next one', r.action === 'started' && r.kind === 'research', r);
  const R2 = r.run_id, TK2 = lastCall().body.ticket;
  chk('R … posted to the research function, a new ticket', lastCall().url === BASE + 'growth_outbound_research' && TK2 !== TK1 && run(R2).input.next === true);
  r = door(TK2, 'growth_outbound_candidates', { p_status: 'new', p_limit: 10 });
  chk('R a research ticket reads the candidate queue', Array.isArray(r) && r.length === 2 && r.some((x) => x.url === 'https://cfbnumbers.test'), r);
  const CID = r.find((x) => x.url === 'https://cfbnumbers.test').id;
  r = door(TK2, 'growth_outbound_page_record', { p: { url: 'https://cfbnumbers.test/', http_status: 200, content_type: 'text/html', title: 'CFB Numbers',
    text: 'Pat Analyst runs CFB Numbers, a college football ratings newsletter.' } });
  chk('R … stores the pages it reads, for its run', r.ok === true && r.page_id > 0 && one(`select run_id from growth_outbound.pages where id = ${r.page_id};`) === String(R2), r);
  r = door(TK2, 'growth_outbound_fit_catalog', {});
  chk('R … reads the fit catalogue', Array.isArray(r) && r.length >= 21);
  r = door(TK2, 'growth_outbound_research_ingest', { p_candidate: CID, p_collector: 'research_engine', p: { urls: 'not a list' } });
  chk('R … reaches the ingest door (and its own checks)', r.ok === false && r.reason === 'invalid_urls', r);
  r = door(TK2, 'growth_outbound_candidate_set', { p_id: CID, p_status: 'not_a_fit', p_reason: 'a tout' });
  chk('R … marks a candidate', r.ok === true, r);
  r = door(TK2, 'growth_outbound_research_spend', { p_provider: 'llm', p_n: 1 });
  chk('R … spends on reading', r.ok === true, r);
  for (const name of ['growth_outbound_candidates_record', 'growth_outbound_draft_context', 'growth_outbound_draft_propose', 'growth_outbound_draft_approve']) {
    chk('R a research ticket opens nothing else: ' + name, door(TK2, name, {}).reason === 'not_allowed');
  }
  finish(TK2, 'done', { pages: 1 });
  r = tick();
  const R3 = r.run_id, TK3 = lastCall().body.ticket;
  chk('R … the next new candidate', r.kind === 'research', r);
  finish(TK3, 'done', {});
  r = tick();
  chk('R the daily target reached (2): no more research today', r.action === 'idle' && r.reason === 'nothing left to do this morning'
    && plan().today.researched === 2, r);

  /* ══ G. DRAFT ═════════════════════════════════════════════════════════ */
  const P1 = '10000000-0000-0000-0000-000000000001', P2 = '10000000-0000-0000-0000-000000000002';
  one(SEED.strong({ id: P1, name: 'Pat Analyst', org: 'CFB Numbers', email: 'pat@cfbnumbers.test', domain: 'cfbnumbers.test', handle: 'patanalyst' })
    + SEED.strong({ id: P2, name: 'Kai Moss', org: 'Moss Models', email: 'kai@mossmodels.test', domain: 'mossmodels.test', handle: 'kaimoss' }));
  settings({ max_sends_per_day: 1 });
  r = tick();
  chk('G two prospects due: the morning drafts, a few at a time, never more than the daily send cap (1)', r.action === 'started' && r.kind === 'draft'
    && run(r.run_id).input.next === 1 && lastCall().url === BASE + 'growth_outbound_draft', [r, run(r.run_id).input]);
  const R4 = r.run_id, TK4 = lastCall().body.ticket;
  r = door(TK4, 'growth_outbound_drafting_overview', {});
  chk('G a draft ticket reads who is due', r.due_counts.first === 2, r.due_counts);
  r = door(TK4, 'growth_outbound_draft_context', { p_prospect: P1, p_sequence: 1 });
  chk('G … the context to write from', r.ok === true && r.due === true && r.first_name === 'Pat', r);
  const PROJ = +one(`select id from growth_outbound.evidence where prospect_id = '${P1}' and field_name = 'project' order by id limit 1;`);
  r = door(TK4, 'growth_outbound_research_spend', { p_provider: 'search', p_n: 1 });
  chk('G … spends on writing only', r.ok === false && r.reason === 'wrong_run_kind', r);
  r = door(TK4, 'growth_outbound_draft_propose', { p_prospect: P1, p: { sequence_number: 1, subject: 'A research tool for your work', generator: 'engine:claude:p1',
    body_text: 'Hi Pat,\n\nI came across your CFB power ratings against the market and wanted to reach out.\n\nIf it would be useful for your work, you can try EdgeDesk Sports free for 7 days at https://edgedesksports.com/ (then $49.99/month).\n\nWould it be worth a look?',
    claims: [{ text: 'CFB power ratings against the market', evidence_id: PROJ }] } });
  chk('G … proposes a draft, which waits for the owner, marked with its run', r.ok === true
    && one(`select status || '|' || run_id || '|' || edited_by_owner from growth_outbound.drafts where id = '${r.draft_id}';`) === 'pending_review|' + R4 + '|false', r);
  const D1 = r.draft_id;
  r = door(TK4, 'growth_outbound_draft_approve', { p_draft_id: D1, p_content_hash: one(`select content_hash from growth_outbound.drafts where id = '${D1}';`) });
  chk('G … and cannot approve it', r.ok === false && r.reason === 'not_allowed', r);
  r = door(TK4, 'growth_outbound_draft_gave_up', { p_prospect: P2, p_sequence: 1, p_reasons: ['nothing to cite'] });
  chk('G … records giving up, as the system', r.ok === true && one(`select actor_kind from growth_outbound.activity where action = 'draft_gave_up';`) === 'system', r);
  finish(TK4, 'done', { drafted: 1 });
  chk('G the draft is still waiting for the owner: nothing the schedule did approved or sent anything',
    one(`select status from growth_outbound.drafts where id = '${D1}';`) === 'pending_review' && one(`select count(*) from growth_outbound.sends;`) === '0');
  r = own(`select public.growth_outbound_evidence_add('${P2}', ${J({ evidence: [{ field_name: 'topic', claim: 'win totals', source_url: 'https://mossmodels.test/totals', source_kind: 'own_site', source_excerpt: 'our win totals' }] })});`);
  chk('G (setup) new evidence brings Kai back: one is due again', r.ok === true && plan().today.due === 1, r);
  r = tick();
  chk('G the daily send cap reached in drafts (1): no more drafting today, though one is due', r.action === 'idle' && r.reason === 'nothing left to do this morning'
    && plan().today.drafted === 1, r);
  chk('G (setup) raising the cap back takes the owner\'s confirmation', settings({ max_sends_per_day: 20, confirm_cap_increase: true }).ok === true);
  r = tick();
  chk('G with room again, the next one due', r.kind === 'draft', r);
  const TK5 = lastCall().body.ticket;
  finish(TK5, 'done', { drafted: 0 });
  r = tick();
  chk('G a draft run that wrote nothing: the next one waits half an hour', r.action === 'idle' && r.reason === 'nothing left to do this morning', r);
  one(`update growth_outbound.research_runs set started_at = now() - interval '31 minutes' where id = (select max(id) from growth_outbound.research_runs);`);
  chk('G … then tries again', tick().kind === 'draft');
  finish(lastCall().body.ticket, 'done', { drafted: 0 });

  /* ══ K (continued): a ticket dies with automation, and with time ══════ */
  one(`update growth_outbound.research_runs set started_at = now() - interval '31 minutes' where id = (select max(id) from growth_outbound.research_runs);`);
  r = tick();
  const TK6 = lastCall().body.ticket;
  chk('K (setup) another run', r.action === 'started' && door(TK6, 'plan', {}).ok === true, r);
  settings({ automation_enabled: false });
  chk('K turning automation off ends every live ticket at once', door(TK6, 'plan', {}).reason === 'invalid_ticket');
  settings({ automation_enabled: true });
  one(`update growth_outbound.research_runs set ticket_expires_at = now() - interval '1 second' where id = ${r.run_id};`);
  chk('K an expired ticket opens nothing', door(TK6, 'plan', {}).reason === 'invalid_ticket');

  /* ══ F. FAILURES ══════════════════════════════════════════════════════ */
  const stale = (id) => one(`update growth_outbound.research_runs set started_at = now() - interval '31 minutes' where id = ${id};`);
  stale(r.run_id);
  const t1 = tick();
  chk('F a scheduled run that never finished is marked failed after 30 minutes', run(r.run_id).status === 'failed' && run(r.run_id).error === 'never finished (the function stopped)');
  chk('F … one failure is not a reason to stop', t1.action === 'started', t1);
  stale(t1.run_id);
  const t2 = tick();
  chk('F … nor two', t2.action === 'started' && run(t1.run_id).status === 'failed', t2);
  stale(t2.run_id);
  r = tick();
  chk('F three scheduled runs failed in a row: nothing more today, and said', r.action === 'idle' && /^the last three scheduled runs failed/.test(r.reason), r);
  one(`update growth_outbound.research_runs set started_at = started_at - interval '1 day' where started_by = 'schedule';`);
  chk('F the next morning is a new day', tick().action === 'started');
  one(`update growth_outbound.research_runs set status = 'done', finished_at = now() where status = 'running';
       insert into growth_outbound.research_runs (kind, started_by, input, ticket_sha256, ticket_expires_at, status, finished_at, started_at)
       select 'research', 'schedule', '{}'::jsonb, md5(g::text) || md5((g + 1000)::text), now(), 'done', now(), now() from generate_series(1, 60) g;`);
  r = tick();
  chk('F at most 60 scheduled runs a day', r.action === 'idle' && r.reason === 'the day\'s limit of 60 scheduled runs is reached', r);
  one(`update growth_outbound.research_runs set started_at = started_at - interval '2 days' where started_by = 'schedule';`);

  /* ══ B. BLOCKED ═══════════════════════════════════════════════════════ */
  const runsBefore = one(`select count(*) from growth_outbound.research_runs;`);
  r = tick(undefined, 'https://evil.test/functions/v1/');
  chk('B not a Supabase functions address: nothing started, and said', r.action === 'blocked' && /not a Supabase project/.test(r.reason)
    && one(`select count(*) from growth_outbound.research_runs;`) === runsBefore && sched().last_action === 'blocked', r);
  one(`alter function net.http_post(text, jsonb, jsonb, jsonb, int) rename to http_post_off;`);
  r = tick();
  chk('B no pg_net: nothing started, and said', r.action === 'blocked' && /pg_net is not installed/.test(r.reason) && one(`select count(*) from growth_outbound.research_runs;`) === runsBefore, r);
  one(`alter function net.http_post_off(text, jsonb, jsonb, jsonb, int) rename to http_post;`);
  e = db.mustFail(() => db.as(OWNER, `select growth_outbound.schedule_tick(${lit(BASE)}, now());`));
  chk('B the tick is the database\'s own: no client, the owner included, can call it', !!e && /permission denied/.test(e), e);
  e = db.mustFail(() => one(`begin; set local request.jwt.claims = '{"sub":"${OWNER}","role":"authenticated"}'; select growth_outbound.schedule_tick(${lit(BASE)}, now()); commit;`));
  chk('B … and it refuses anything that arrived through the API', !!e && /inside the database \(pg_cron\) only/.test(e), e);

  /* ══ O. OVERVIEW ══════════════════════════════════════════════════════ */
  r = own(`select public.growth_outbound_automation_overview();`);
  chk('O the owner sees the morning run: on, the window, the plan, the clock, pg_net', r.enabled === true && r.timezone === ZONE && r.start_hour === 11
    && r.hours === 3 && !!r.plan && r.scheduler.ticking === true && r.scheduler.ticks > 10 && r.pg_net === true && r.cron_job === null, r.scheduler);
  chk('O … and the scheduled runs, never a ticket\'s hash or expiry', r.runs.length === 15 && r.runs.every((x) => x.started_by === 'schedule'
    && !('ticket_sha256' in x) && !('ticket_expires_at' in x) && !('requested_by' in x)));
  chk('O the research overview never shows a ticket hash either', own(`select public.growth_outbound_research_overview();`).runs.every((x) => !('ticket_sha256' in x)));
  for (const uid of [ADMIN, SUB]) {
    e = db.mustFail(() => db.as(uid, `select public.growth_outbound_automation_overview();`));
    chk('O nobody else: ' + uid.slice(-2), !!e && /outbound owner only/.test(e), e);
  }
  e = db.mustFail(() => db.anon(`select public.growth_outbound_automation_overview();`));
  chk('O … anon cannot even call it', !!e && /permission denied/.test(e), e);

  /* ══ S. SETTINGS ══════════════════════════════════════════════════════ */
  for (const [o, why] of [[{ automation_timezone: 'Mars/Base' }, 'a time zone that does not exist'], [{ automation_timezone: "UTC'; drop table x; --" }, 'a time zone that is not one'],
    [{ automation_start_hour: 24 }, 'hour 24'], [{ automation_hours: 0 }, 'no hours'], [{ automation_hours: 13 }, '13 hours']]) {
    r = settings(o);
    chk('S refused: ' + why, r.ok === false && r.reason === 'invalid_value', r);
  }
  r = settings({ automation_timezone: 'UTC', automation_start_hour: 11 });
  chk('S a real zone and hour are kept, and the change is on the record', r.ok === true && r.settings.automation_timezone === 'UTC' && r.settings.automation_start_hour === 11
    && !!r.changed.automation_timezone, r.changed);
  e = db.mustFail(() => one(`update growth_outbound.settings set automation_timezone = 'Nowhere/Land' where id = 1;`));
  chk('S … even written directly (a check on the table)', !!e && /outbound_settings_automation/.test(e), e);
  e = db.mustFail(() => one(`insert into growth_outbound.research_runs (kind, started_by, input) values ('research', 'schedule', '{}');`));
  chk('S a scheduled run without a ticket hash cannot exist', !!e && /research_runs_ticket_ck/.test(e), e);
  e = db.mustFail(() => one(`insert into growth_outbound.research_runs (kind, started_by, input, ticket_sha256, ticket_expires_at) values ('research', 'owner', '{}', ${lit(sha('x'))}, now());`));
  chk('S … nor an owner\'s run with one', !!e && /research_runs_ticket_ck/.test(e), e);

  /* ══ C. THE CLOCK ═════════════════════════════════════════════════════ */
  one(`create schema if not exists cron;
       create table if not exists cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text, active boolean default true);
       create or replace function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
         insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
         on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid $$;
       create or replace function cron.unschedule(job_name text) returns boolean language sql as $$
         delete from cron.job where jobname = job_name returning true $$;`);
  const cronSql = fs.readFileSync(CRON, 'utf8');
  chk('C the clock file asks for pg_cron and pg_net, and checks the engine is installed first', /create extension if not exists pg_cron;/.test(cronSql)
    && /create extension if not exists pg_net;/.test(cronSql) && /schedule_tick\(text,timestamp with time zone\)/.test(cronSql));
  const tmp = path.join(require('os').tmpdir(), 'growth_outbound_cron_test_' + process.pid + '.sql');
  fs.writeFileSync(tmp, cronSql.replace(/create extension if not exists pg_(cron|net);/g, ''));
  let rep = db.applyFileAtomic(tmp);
  rep = db.applyFileAtomic(tmp);
  fs.unlinkSync(tmp);
  chk('C run twice: one job, every five minutes, calling the tick with this project\'s functions address', one(`select count(*) || '|' || max(schedule) || '|' || max(command) from cron.job;`)
    === `1|*/5 * * * *|select growth_outbound.schedule_tick('https://iattxbkbufslbauoumga.supabase.co/functions/v1/');`);
  chk('C … and its report says ok', !/CHECK THIS/.test(rep) && (rep.match(/\|ok$/gm) || []).length === 4, rep);
  chk('O the overview now sees the job', own(`select public.growth_outbound_automation_overview();`).cron_job === true);
  chk('C the job\'s command, run as pg_cron runs it, ticks', (() => { const cmd = one(`select command from cron.job;`); one(cmd); return sched().ticks > 0; })());

  const rp = db.applyFileAtomic(FILE);
  chk('the outbound file re-runs over all of this, every report row ok', !/CHECK THIS/.test(rp), rp.split('\n').filter((l) => /CHECK THIS/.test(l)));
  chk('… and reports the morning run and its last tick', /^32\|the morning run .*\|ok$/m.test(rp) && /^33\|morning run: ON, 11:00 for 3 h, UTC; last tick \d{4}-\d\d-\d\d \d\d:\d\d UTC/m.test(rp),
    rp.split('\n').filter((l) => /^3[23]\|/.test(l)));
} catch (err) {
  chk('the suite ran without an unexpected error', false, String(err.sqlMessage || err.message).slice(0, 1500));
} finally {
  db.stop();
}
process.exit(T.done());
