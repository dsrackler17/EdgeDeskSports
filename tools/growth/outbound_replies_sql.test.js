#!/usr/bin/env node
/* ===========================================================================
   REPLIES (2026-10), in the database — supabase/growth_outbound.sql:
   Resend's signed email.received event, through the webhook door, matched to
   the person we wrote to. Real sends (claimed and recorded through the
   owner's doors), real signatures (Svix's scheme, as Resend signs).

     C  CLASSIFY   from the subject alone: a reply, an automatic answer, a
                   request to stop; a request to stop wins
     R  REPLY      matched by the sender's address alone (any case, any
                   display name) to the last email that went there: the
                   sequence ends as "They replied" does — status, unsent
                   follow-ups cancelled, counted in the results — once
     A  AUTO       an out-of-office changes nothing; the follow-up stays due
     O  OPT-OUT    "unsubscribe" in a reply suppresses the address, always
     T  TEST       an answer to a test email (from the test inbox) is noted
     U  UNMATCHED  from nobody we wrote to (or over 180 days ago): kept
                   masked, without a subject; nothing changes
     D  DETECTION  turned off: recorded and shown, nothing changes — except
                   a request to stop, which is still honoured
     S  SIGNED     unsigned, forged or unreadable: refused or noted, nothing
                   changes; the same email twice counts once
     V  VIEW       the owner's Replies list, the prospect's replies, the
                   daily email's line, the results, the System check; no
                   client role reads the record, and it is never rewritten

   Run: node tools/growth/outbound_replies_sql.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const crypto = require('crypto');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const SEED = require(path.join(__dirname, '_outbound_seed.js'));
const { middayZone } = require(path.join(__dirname, '_morning.js'));

const T = PG.kit('growth outbound replies SQL');
const chk = T.chk;
const lit = PG.lit;

const db = PG.start('goreplies');
if (db.skip) { console.log('NOTE | ' + db.skip + ' — LIVE layer skipped'); process.exit(T.done()); }

const OWNER = '00000000-0000-0000-0000-0000000000a1';
const ADMIN = '00000000-0000-0000-0000-0000000000a2';
const SUB = '00000000-0000-0000-0000-0000000000a3';
const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const j = (s) => JSON.parse(s);
const one = (sql) => db.sql(sql);
const own = (sql) => j(db.as(OWNER, sql));
const pid = (n) => '10000000-0000-0000-0000-' + String(n).padStart(12, '0');
const did = (n) => '20000000-0000-0000-0000-' + String(n).padStart(12, '0');
const fid = (n) => '30000000-0000-0000-0000-' + String(n).padStart(12, '0');
const hashOf = (d) => one(`select content_hash from growth_outbound.drafts where id = '${d}';`);
const approve = (d) => own(`select public.growth_outbound_draft_approve('${d}', ${lit(hashOf(d))});`);
const claim = (d) => own(`select public.growth_outbound_send_claim('${d}');`);
const result = (s, id) => own(`select public.growth_outbound_send_result('${s}', ${lit(id)}, null, false);`);
const settings = (o) => own(`select public.growth_outbound_settings_update(${lit(JSON.stringify(o))}::jsonb);`);
const pstatus = (p) => one(`select status from growth_outbound.prospects where id = '${p}';`);
const dstatus = (d) => one(`select status from growth_outbound.drafts where id = '${d}';`);
const count = (t, where) => +one(`select count(*) from growth_outbound.${t}${where ? ' where ' + where : ''};`);
const lastReply = () => j(one(`select to_jsonb(r) from growth_outbound.replies r order by id desc limit 1;`));
const classify = (subject) => one(`select growth_outbound.classify_reply(${lit(subject)});`);

const sign = (id, ts, body, secret = SECRET) => 'v1,' + crypto.createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(id + '.' + ts + '.' + body, 'utf8').digest('base64');
const now = () => String(Math.floor(Date.now() / 1000));
let evn = 0, rcv = 0;
const received = (from, subject, extra) => JSON.stringify({ type: 'email.received', created_at: new Date().toISOString(),
  data: Object.assign({ email_id: 'rcv_' + (++rcv), created_at: new Date().toISOString(), from, to: ['replies@edgedesksports.com'], cc: [], bcc: [],
    received_for: ['replies@edgedesksports.com'], message_id: '<m' + rcv + '@mail.test>', subject, attachments: [] }, extra || {}) });
const hook = (body, o = {}) => {
  const id = o.id !== undefined ? o.id : 'msg_rcv_' + (++evn);
  const ts = o.ts !== undefined ? o.ts : now();
  const sig = o.sig !== undefined ? o.sig : sign(id, ts, body, o.secret);
  return j(db.anon(`select public.growth_outbound_webhook(${lit(id)}, ${lit(ts)}, ${lit(sig)}, ${lit(body)});`));
};

const PEOPLE = [[1, 'Tess Test', 'tess@testsend.test'], [2, 'Pat Analyst', 'pat@cfbnumbers.test'], [3, 'Sam Spare', 'sam@propslab.test'],
  [4, 'Lee Live', 'lee@leelab.test'], [5, 'Ana Bell', 'ana@bellratings.test'], [6, 'Kai Moss', 'kai@mossmodels.test'], [7, 'Ola Reed', 'ola@reedreport.test']];

try {
  ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql', 'growth_outbound.sql']
    .forEach((f) => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f)));
  one(`insert into auth.users (id, email, email_confirmed_at) values ('${OWNER}', 'owner@edgedesk.test', now()), ('${ADMIN}', 'admin@edgedesk.test', now()),
         ('${SUB}', 'sub@edgedesk.test', now());
       insert into public.affiliate_admins (user_id) values ('${OWNER}'), ('${ADMIN}');
       select growth_outbound.grant_owner('owner@edgedesk.test');
       select growth_outbound.set_webhook_secret(${lit(SECRET)});`);
  one(PEOPLE.map(([n, name, email]) => SEED.strong({ id: pid(n), name, org: name.split(' ')[1] + ' Media', email, domain: email.split('@')[1], handle: name.replace(' ', '') })
    + SEED.draft({ id: did(n), prospect: pid(n), subject: 'Your work, ' + name.split(' ')[0], body: 'Hi ' + name.split(' ')[0] + ', a 7-day free trial, then $49.99/month.' })).join('\n'));
  PEOPLE.forEach(([n]) => approve(did(n)));
  settings({ postal_address: 'EdgeDesk Sports, 100 Example St, Springfield, IL 62701', test_inbox: 'owner-test@edgedesk.test',
    unsubscribe_url_base: 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/' });
  // Tess: a TEST send (to the owner's test inbox); everyone else: a live one
  let c = claim(did(1));
  result(c.send_id, 're_test_1');
  settings({ test_mode: false, confirm_live: true });
  for (const [n] of PEOPLE.slice(1)) { c = claim(did(n)); result(c.send_id, 're_live_' + n); }
  chk('(seed) one test send and six live ones, all sent', count('sends', 'sent_at is not null and is_test') === 1 && count('sends', 'sent_at is not null and not is_test') === 6
    && PEOPLE.slice(1).every(([n]) => pstatus(pid(n)) === 'contacted'), one(`select string_agg(status, ',') from growth_outbound.prospects;`));
  // follow-ups written and waiting for review, for Pat and Sam
  one(SEED.draft({ id: fid(2), prospect: pid(2), seq: 2, subject: 'Following up', body: 'Hi Pat, following up: a 7-day free trial, then $49.99/month.' })
    + SEED.draft({ id: fid(3), prospect: pid(3), seq: 2, subject: 'Following up', body: 'Hi Sam, following up: a 7-day free trial, then $49.99/month.' }));

  /* ══ C. CLASSIFY ════════════════════════════════════════════════════════ */
  const CASES = [
    ['Re: Your work, Pat', 'reply'], ['RE: your CFB model', 'reply'], [null, 'reply'], ['', 'reply'], ['Re: your stop-loss rules', 'reply'],
    ['Re: out of curiosity, how does it price props?', 'reply'], ['Re: officially interested', 'reply'],
    ['Automatic reply: Your work, Pat', 'auto_reply'], ['Auto-Reply: away', 'auto_reply'], ['Out of Office: back Monday', 'auto_reply'],
    ['OOO until the 14th', 'auto_reply'], ['Autoreply', 'auto_reply'], ['I am on vacation', 'auto_reply'], ['Abwesenheitsnotiz', 'auto_reply'],
    ['Réponse automatique : absent', 'auto_reply'], ['Away from the office', 'auto_reply'],
    ['Re: unsubscribe', 'opt_out'], ['UNSUBSCRIBE ME', 'opt_out'], ['Re: please remove me', 'opt_out'], ['opt out', 'opt_out'], ['Opt-out please', 'opt_out'],
    ['Re: stop emailing me', 'opt_out'], ['Do not contact me again', 'opt_out'], ['Automatic reply: unsubscribe', 'opt_out'],
  ];
  const wrong = CASES.filter(([sub, want]) => classify(sub) !== want).map(([sub, want]) => [sub, want, classify(sub)]);
  chk('C ' + CASES.length + ' subjects, each read as a reply, an automatic answer or a request to stop (a request to stop wins)', wrong.length === 0, wrong);

  /* ══ R. A REPLY ═════════════════════════════════════════════════════════ */
  const before = { events: count('provider_events'), activity: count('activity', `action = 'prospect_replied'`) };
  const PAT1 = received('Pat Analyst <PAT@CFBNumbers.test>', 'Re: Your work, Pat');
  let r = hook(PAT1);
  const PAT1_EVENT = 'msg_rcv_' + evn;
  let rep = lastReply();
  chk('R Pat replies (any case, with a display name): recognised as theirs, to their first email', r.ok === true && r.outcome === 'reply_reply' && r.applied === true
    && rep.kind === 'reply' && rep.prospect_id === pid(2) && rep.sequence_number === 1 && rep.subject === 'Re: Your work, Pat' && rep.applied === true, { r, rep });
  chk('R … their sequence ends: replied, the follow-up waiting for review cancelled', pstatus(pid(2)) === 'replied' && dstatus(fid(2)) === 'cancelled'
    && /^replied by email: Re: Your work, Pat$/.test(one(`select status_reason from growth_outbound.prospects where id = '${pid(2)}';`)));
  const act = j(one(`select to_jsonb(a) from growth_outbound.activity a where action = 'prospect_replied' and prospect_id = '${pid(2)}';`));
  chk('R … the same record "They replied" leaves, as the webhook\'s, saying it was detected', act.actor_kind === 'webhook' && act.detail.detected === true
    && act.detail.drafts_cancelled === 1 && count('activity', `action = 'prospect_replied'`) === before.activity + 1, act);
  chk('R … and Resend\'s event is on the record, against the send', count('provider_events') === before.events + 1
    && one(`select outcome || '|' || (send_id is not null) from growth_outbound.provider_events order by id desc limit 1;`) === 'reply_reply|true');
  chk('R the same event again (Resend retries): once', hook(PAT1, { id: PAT1_EVENT }).duplicate === true && count('replies') === 1);
  r = hook(PAT1);   // the same email, under a new event id
  chk('R … the same email under another event id: noted, counted once', r.outcome === 'reply_duplicate' && count('replies', `prospect_id = '${pid(2)}'`) === 1, r);
  r = hook(received('pat@cfbnumbers.test', 'Re: Re: Your work, Pat'));
  chk('R a second reply is recorded, and changes nothing more (no second "replied")', r.outcome === 'reply_reply' && r.applied === false
    && count('replies', `prospect_id = '${pid(2)}'`) === 2 && count('activity', `action = 'prospect_replied' and prospect_id = '${pid(2)}'`) === 1, r);
  chk('R the follow-up is no longer due for them', +one(`select count(*) from growth_outbound.drafting_due() x where x.prospect_id = '${pid(2)}';`) === 0);

  /* ══ A. AN AUTOMATIC ANSWER ═════════════════════════════════════════════ */
  r = hook(received('Sam Spare <sam@propslab.test>', 'Automatic reply: Your work, Sam'));
  chk('A an out-of-office: noted as automatic, nothing changes — still contacted, the follow-up still waiting', r.outcome === 'reply_auto_reply' && r.applied === false
    && pstatus(pid(3)) === 'contacted' && dstatus(fid(3)) === 'pending_review' && count('activity', `action = 'prospect_replied' and prospect_id = '${pid(3)}'`) === 0, r);

  /* ══ O. A REQUEST TO STOP ═══════════════════════════════════════════════ */
  r = hook(received('lee@leelab.test', 'Re: Your work, Lee - please unsubscribe me'));
  chk('O "unsubscribe" in a reply: the address suppressed, by the reply', r.outcome === 'reply_opt_out' && r.applied === true && pstatus(pid(4)) === 'suppressed'
    && one(`select kind || '|' || source from growth_outbound.suppressions where target = 'lee@leelab.test';`) === 'unsubscribe|reply', r);
  chk('O … and it counts as their reply, once', count('activity', `action = 'prospect_replied' and prospect_id = '${pid(4)}'`) === 1);
  chk('O nothing can go to them again: suppressed, and never due a follow-up', one(`select growth_outbound.is_suppressed('lee@leelab.test');`) === 't'
    && +one(`select count(*) from growth_outbound.drafting_due() x where x.prospect_id = '${pid(4)}';`) === 0);

  /* ══ T. A TEST ══════════════════════════════════════════════════════════ */
  r = hook(received('Owner Test <owner-test@edgedesk.test>', 'Re: Your work, Tess'));
  chk('T the owner answering their own test email: noted as a test, nothing changes (the dry run proves the setup)', r.outcome === 'reply_test' && r.applied === false
    && lastReply().kind === 'test' && pstatus(pid(1)) !== 'replied' && count('activity', `action = 'prospect_replied' and prospect_id = '${pid(1)}'`) === 0, r);

  /* ══ U. FROM NOBODY WE WROTE TO ═════════════════════════════════════════ */
  const fp = () => one(`select (select count(*) from growth_outbound.activity) || '|' || (select string_agg(status, ',' order by id) from growth_outbound.prospects)
    || '|' || (select count(*) from growth_outbound.suppressions);`);
  let f0 = fp();
  r = hook(received('Stranger <stranger@elsewhere.test>', 'Business proposal for you'));
  rep = lastReply();
  chk('U from nobody we wrote to: kept masked, with no subject, and nothing changes', r.outcome === 'reply_unmatched' && rep.kind === 'unmatched'
    && rep.from_masked === 's•••@elsewhere.test' && rep.subject === null && rep.prospect_id === null && fp() === f0, rep);
  r = hook(received('kai@mossmodels.test', 'Re: Your work, Kai — unsubscribe'), {});
  chk('(Kai asks to stop, for the detection-off case below)', r.outcome === 'reply_opt_out');
  one(`update growth_outbound.sends set sent_at = sent_at - interval '200 days' where intended_recipient = 'ola@reedreport.test';`);
  f0 = fp();
  r = hook(received('ola@reedreport.test', 'Re: Your work, Ola'));
  chk('U a reply to an email over 180 days old is not matched', r.outcome === 'reply_unmatched' && fp() === f0 && pstatus(pid(7)) === 'contacted', r);
  r = hook(received('ola@reedreport.test.evil', 'Re: Your work, Ola'));
  chk('U an address is matched whole, never by its start', r.outcome === 'reply_unmatched');
  r = hook(received('Boss <boss@cfbnumbers.test>', 'Re: Your work, Pat'));
  chk('U … nor by its domain: a colleague of Pat\'s writing is nobody we wrote to', r.outcome === 'reply_unmatched' && lastReply().prospect_id === null, r);

  /* ══ D. DETECTION OFF ═══════════════════════════════════════════════════ */
  r = settings({ reply_detection: false });
  chk('D reply detection is a setting, on by default', r.ok === true && r.changed.reply_detection && r.changed.reply_detection.from === true, r);
  const quiet = () => one(`select (select string_agg(status, ',' order by id) from growth_outbound.prospects) || '|' || (select count(*) from growth_outbound.suppressions)
    || '|' || (select string_agg(status, ',' order by id) from growth_outbound.drafts) || '|' || (select count(*) from growth_outbound.activity where action <> 'reply_received');`);
  f0 = quiet();
  r = hook(received('ana@bellratings.test', 'Re: Your work, Ana'));
  rep = lastReply();
  chk('D off: the reply is recorded and shown (in Replies and the activity log), and nothing changes', r.outcome === 'reply_reply' && r.applied === false
    && rep.detail.detection === 'off' && pstatus(pid(5)) === 'contacted' && quiet() === f0
    && one(`select action || '|' || (detail->>'applied') from growth_outbound.activity order by id desc limit 1;`) === 'reply_received|false', { r, rep });
  // a request to stop is honoured even then
  one(SEED.strong({ id: pid(8), name: 'Vic Vale', org: 'Vale Media', email: 'vic@valemedia.test', domain: 'valemedia.test', handle: 'VicVale' })
    + SEED.draft({ id: did(8), prospect: pid(8), subject: 'Your work, Vic', body: 'Hi Vic, a 7-day free trial, then $49.99/month.' }));
  approve(did(8)); c = claim(did(8)); result(c.send_id, 're_live_8');
  r = hook(received('vic@valemedia.test', 'Unsubscribe'));
  chk('D … but a request to stop is still honoured: they asked', r.outcome === 'reply_opt_out' && r.applied === true && pstatus(pid(8)) === 'suppressed', r);
  settings({ reply_detection: true });

  /* ══ S. SIGNED, OR NOTHING ══════════════════════════════════════════════ */
  f0 = fp();
  const n0 = count('replies');
  const forged = received('ana@bellratings.test', 'Re: Your work, Ana');
  r = hook(forged, { sig: 'v1,' + Buffer.from('forged').toString('base64') });
  chk('S an unsigned "reply" is refused before anything is read, and nothing changes', r.ok === false && r.verified === false && count('replies') === n0 && fp() === f0, r);
  r = hook(forged, { secret: 'whsec_' + Buffer.from('another secret entirely!').toString('base64') });
  chk('S … signed with another secret: the same', r.verified === false && count('replies') === n0);
  r = hook(received('not an address', 'Re: hi'));
  chk('S an unreadable sender: noted, nothing kept about it', r.ok === true && r.outcome === 'reply_unreadable' && count('replies') === n0, r);
  r = hook(JSON.stringify({ type: 'email.received', created_at: new Date().toISOString(), data: { from: 'ana@bellratings.test', subject: 'no id' } }));
  chk('S … or no email id', r.outcome === 'reply_unreadable' && count('replies') === n0, r);
  r = hook(received('Ana <ana@bellratings.test>', 'Re: hello\u0007\r\nBcc: someone@else.test ' + 'x'.repeat(500)));
  rep = lastReply();
  chk('S a subject is kept as one plain line, 200 characters at most', r.outcome === 'reply_reply' && rep.subject.length <= 200 && !/[\r\n\u0007]/.test(rep.subject)
    && rep.subject.startsWith('Re: hello Bcc: someone@else.test x'), rep.subject);
  chk('S a reply from Ana, now detection is back on, ends her sequence', pstatus(pid(5)) === 'replied');

  /* ══ V. WHAT THE OWNER SEES ═════════════════════════════════════════════ */
  const list = own(`select public.growth_outbound_replies(50);`);
  chk('V the Replies list: newest first, each with who it was, the step, what it was taken to be, and whether it changed anything', list.ok === true && list.detection === true
    && list.rows.length === count('replies') && list.rows[0].full_name === 'Ana Bell' && list.rows.some((x) => x.kind === 'unmatched' && x.full_name === null && x.from_masked)
    && list.counts_30d.reply >= 3 && list.counts_30d.auto_reply === 1 && list.counts_30d.opt_out === 3 && list.counts_30d.test === 1 && list.counts_30d.unmatched === 4, list.counts_30d);
  chk('V … the list never shows a stranger\'s full address', !JSON.stringify(list).includes('stranger@elsewhere.test'));
  chk('V only the owner sees it', /outbound owner only/.test(db.mustFail(() => db.as(ADMIN, `select public.growth_outbound_replies(50);`)) || '')
    && /permission denied/.test(db.mustFail(() => db.anon(`select public.growth_outbound_replies(50);`)) || ''));
  const pd = own(`select public.growth_outbound_prospect('${pid(2)}');`);
  chk('V a prospect\'s page lists their replies (subject and kind, never a body)', pd.replies.length === 2 && pd.replies.every((x) => x.kind === 'reply' && x.subject && !('text' in x)), pd.replies);
  const fin = own(`select public.growth_outbound_analytics(90);`);
  chk('V the results count detected replies and opt-outs like marked ones', fin.people.replied >= 4 && fin.people.opted_out >= 3, fin.people);
  const st = own(`select public.growth_outbound_settings();`);
  chk('V a received email counts as word from Resend for the webhook\'s health', !!st.webhook.last_event_at && st.webhook.events_24h >= 10, st.webhook);
  for (const [who, run] of [['anon', (q) => db.anon(q)], ['a subscriber', (q) => db.as(SUB, q)], ['the owner (doors only)', (q) => db.as(OWNER, q)], ['the service role', (q) => db.service(q)]]) {
    chk('V ' + who + ' cannot read the replies record directly', /permission denied/.test(db.mustFail(() => run(`select count(*) from growth_outbound.replies;`)) || ''));
  }
  chk('V the record is never rewritten or deleted', /append-only/.test(db.mustFail(() => one(`update growth_outbound.replies set kind = 'reply';`)) || '')
    && /append-only/.test(db.mustFail(() => one(`delete from growth_outbound.replies;`)) || ''));

  // the owner's daily email says how many replied in the last day (counts, never who)
  one(`create schema if not exists net;
       create table if not exists net.calls (id bigserial primary key, url text, body jsonb, headers jsonb, timeout_milliseconds int);
       create or replace function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
                                                headers jsonb default '{}'::jsonb, timeout_milliseconds int default 5000)
       returns bigint language sql as $$ insert into net.calls (url, body, headers, timeout_milliseconds) values (url, body, headers, timeout_milliseconds) returning id $$;`);
  settings({ digest_enabled: true, automation_timezone: middayZone(), automation_start_hour: 8, automation_hours: 3 });
  const tk = j(one(`select growth_outbound.schedule_tick('https://iattxbkbufslbauoumga.supabase.co/functions/v1/', now());`));
  const ticket = j(one(`select body from net.calls order by id desc limit 1;`)).ticket;
  const note = j(db.anon(`select public.growth_outbound_scheduled(${lit(ticket)}, 'digest_compose', '{}');`));
  const text = (note.message || {}).text || '';
  chk('V the daily email says how many people replied in the last day — never who', tk.digest && tk.digest.action === 'started'
    && /\n5 people replied in the last day \(Outbound, Replies\)\.\n/.test(text) && !/Pat|Lee|Ana|Vic|Kai|cfbnumbers/.test(text), text);

  const checks = j(one(`select jsonb_agg(to_jsonb(c) order by c.step) from growth_outbound.self_check() c;`));
  const row39 = checks.find((x) => x.step === 39) || {};
  chk('V the System check proves the rules and says what came in', row39.outcome === 'ok' && /detection on; \d+ replied, 1 automatic, 3 asked to stop, 4 from nobody we wrote to \(30 days\); last /.test(row39.item), row39);
  chk('V every System check row is ok; twenty-one tables, every one denied to clients', checks.every((x) => /^ok/.test(x.outcome))
    && one(`select count(*) from pg_tables where schemaname = 'growth_outbound';`) === '21'
    && one(`select count(*) from pg_policies where schemaname = 'growth_outbound' and tablename = 'replies' and policyname = 'deny_clients' and permissive = 'RESTRICTIVE';`) === '1',
    checks.filter((x) => !/^ok/.test(x.outcome)));
} catch (e) {
  chk('the suite ran to the end', false, String(e && (e.sqlMessage || e.message) || e).slice(0, 900));
} finally {
  db.stop();
}
process.exit(T.done());
