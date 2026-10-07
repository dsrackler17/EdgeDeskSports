#!/usr/bin/env node
/* ===========================================================================
   PHASE 5 — THE SEND PATH IN THE DATABASE (claim, compose, record)
   supabase/growth_outbound.sql; the Edge Function is
   tools/growth/outbound_send.test.js.

     B  BLOCKERS   a TEST send (only ever to the owner's own inbox) needs the
                   postal address and the test inbox; a LIVE send also needs
                   the opt-out endpoint
     C  CLAIM      written BEFORE the provider is called; one key per draft;
                   the message exactly as it must go out (the approved words,
                   the footer, the personal opt-out link, RFC 8058 headers);
                   the draft becomes 'sent'; a refused claim writes nothing
     R  RETRY      claiming again returns the SAME key; an outcome unknown
                   after 23 hours is abandoned (failed), never retried
     S  RESULT     a message id → sent (a real step-1 prospect → contacted);
                   permanent → failed, never re-sent; transient → still
                   claimed; ids validated and never replaced
     G  GATES      the approval must still be earned when sending; the cap;
                   a suppression; a follow-up only to a contacted prospect
     I  RECORD     the opt-out token and what was sent can never change; the
                   list of sends; the owner only

   Run: node tools/growth/outbound_send_sql.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const SEED = require(path.join(__dirname, '_outbound_seed.js'));

const T = PG.kit('growth outbound send SQL');
const chk = T.chk;
const lit = PG.lit;
const FILE = path.join(PG.ROOT, 'supabase', 'growth_outbound.sql');

const db = PG.start('gosend');
if (db.skip) { console.log('NOTE | ' + db.skip + ' — LIVE layer skipped'); process.exit(T.done()); }

const OWNER = '00000000-0000-0000-0000-0000000000a1';
const ADMIN = '00000000-0000-0000-0000-0000000000a2';
const j = (s) => JSON.parse(s);
const one = (sql) => db.sql(sql);
const own = (sql) => j(db.as(OWNER, sql));
const pid = (n) => '10000000-0000-0000-0000-' + String(n).padStart(12, '0');
const did = (n) => '20000000-0000-0000-0000-' + String(n).padStart(12, '0');
const hashOf = (d) => one(`select content_hash from growth_outbound.drafts where id = '${d}';`);
const approve = (d) => own(`select public.growth_outbound_draft_approve('${d}', ${lit(hashOf(d))});`);
const claim = (d) => own(`select public.growth_outbound_send_claim('${d}');`);
const result = (s, id, err, perm) => own(`select public.growth_outbound_send_result('${s}', ${lit(id)}, ${lit(err)}, ${perm ? 'true' : 'false'});`);
const settings = (o) => own(`select public.growth_outbound_settings_update(${lit(JSON.stringify(o))}::jsonb);`);
const dstatus = (d) => one(`select status from growth_outbound.drafts where id = '${d}';`);
const pstatus = (p) => one(`select status from growth_outbound.prospects where id = '${p}';`);
const nsends = (where) => +one(`select count(*) from growth_outbound.sends${where ? ' where ' + where : ''};`);

try {
  ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql', 'growth_outbound.sql']
    .forEach((f) => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f)));
  one(`insert into auth.users (id, email, email_confirmed_at) values ('${OWNER}', 'owner@edgedesk.test', now()), ('${ADMIN}', 'admin@edgedesk.test', now());
       insert into public.affiliate_admins (user_id) values ('${OWNER}'), ('${ADMIN}');
       select growth_outbound.grant_owner('owner@edgedesk.test');`);
  const people = [[1, 'Pat Analyst', 'pat@cfbnumbers.test', 'cfbnumbers.test', 'patanalyst'], [2, 'Sam Spare', 'sam@propslab.test', 'propslab.test', 'samspare'],
    [3, 'Lee Live', 'lee@leelab.test', 'leelab.test', 'leelab'], [4, 'Ana Bell', 'ana@bellratings.test', 'bellratings.test', 'anabell'],
    [5, 'Kai Moss', 'kai@mossmodels.test', 'mossmodels.test', 'kaimoss'], [6, 'Ola Reed', 'ola@reedreport.test', 'reedreport.test', 'olareed']];
  one(people.map(([n, name, email, domain, handle]) => SEED.strong({ id: pid(n), name, org: name.split(' ')[1] + ' Media', email, domain, handle })
    + SEED.draft({ id: did(n), prospect: pid(n), subject: 'Your work, ' + name.split(' ')[0], body: 'Hi ' + name.split(' ')[0] + ',' })).join('\n'));
  [1, 2, 3, 4, 5, 6].forEach((n) => approve(did(n)));
  chk('(seed) six real prospects with approved drafts', one(`select count(*) from growth_outbound.drafts where status = 'approved';`) === '6');

  /* ══ B. BLOCKERS ══════════════════════════════════════════════════════ */
  let st = j(db.as(OWNER, `select public.growth_outbound_settings();`));
  chk('B a fresh install says what blocks a test send and what blocks a live one', JSON.stringify(st.test_send_blockers) === JSON.stringify(['postal_address_missing', 'test_inbox_missing'])
    && JSON.stringify(st.live_send_blockers) === JSON.stringify(['postal_address_missing', 'unsubscribe_endpoint_missing']), st);
  let r = claim(did(1));
  chk('B nothing is claimed while a test send is blocked, and nothing is written', r.ok === false && r.reason === 'refused'
    && /sending is blocked: postal_address_missing, test_inbox_missing/.test(r.detail) && nsends() === 0 && dstatus(did(1)) === 'approved', r);
  r = settings({ postal_address: 'EdgeDesk Sports, 100 Example St, Springfield, IL 62701', test_inbox: 'Owner-Test@EdgeDesk.test' });
  chk('B with the postal address and the test inbox, test sends are clear — live ones still need the opt-out endpoint', r.ok
    && r.settings.send_blockers.length === 0 && JSON.stringify(r.settings.live_send_blockers) === JSON.stringify(['unsubscribe_endpoint_missing']), r.settings);

  /* ══ C. CLAIM ═════════════════════════════════════════════════════════ */
  r = claim(did(1));
  const S1 = r.send_id;
  chk('C an approved draft is claimed in test mode', r.ok === true && r.test === true && r.idempotency_key === 'edgedesk-outbound-' + did(1), r);
  chk('C … to the owner\'s test inbox, from Davis', r.message.to === 'owner-test@edgedesk.test' && r.message.from === 'Davis <davis@edgedesksports.com>'
    && r.message.reply_to === 'davis@edgedesksports.com' && r.message.subject === 'Your work, Pat', r.message);
  chk('C … the approved words, then the footer with the postal address', r.message.text.indexOf(one(`select body_text from growth_outbound.drafts where id = '${did(1)}';`)) === 0
    && /\n--\nDavis, EdgeDesk Sports\n/.test(r.message.text) && /100 Example St, Springfield, IL 62701/.test(r.message.text), r.message.text);
  chk('C … a test send before the opt-out endpoint exists says so, and offers reply-to-stop only', /test send: your personal opt-out link appears here/.test(r.message.text)
    && r.message.headers['List-Unsubscribe'] === '<mailto:davis@edgedesksports.com?subject=stop>' && !r.message.headers['List-Unsubscribe-Post'], r.message.headers);
  chk('C the send row is written before anything is sent: claimed, test, with its own opt-out token', one(`select delivery_status || '|' || is_test || '|' || recipient || '|' || intended_recipient
      || '|' || (optout_token ~ '^[0-9a-f]{64}$') || '|' || attempts from growth_outbound.sends where id = '${S1}';`) === 'claimed|true|owner-test@edgedesk.test|pat@cfbnumbers.test|true|1');
  chk('C … and the draft is sent: it can no longer be edited, rejected or approved again', dstatus(did(1)) === 'sent'
    && own(`select public.growth_outbound_draft_edit('${did(1)}', 'x', 'y', ${lit(hashOf(did(1)))});`).ok === false
    && own(`select public.growth_outbound_draft_reject('${did(1)}', 'x');`).ok === false);
  chk('C a draft that is not approved is not claimed', claim('20000000-0000-0000-0000-00000000ffff').reason === 'not_found');

  /* ══ R. RETRY ═════════════════════════════════════════════════════════ */
  r = claim(did(1));
  chk('R claiming again before an answer returns the SAME key (Resend\'s idempotency makes the retry harmless)', r.ok === true && r.retry === true
    && r.send_id === S1 && r.idempotency_key === 'edgedesk-outbound-' + did(1) && nsends() === 1, r);
  chk('R … counted as a second attempt', one(`select attempts from growth_outbound.sends where id = '${S1}';`) === '2');
  r = result(S1, null, 'Resend answered 503', false);
  chk('R a transient failure leaves it claimed, noted', r.ok && r.state === 'claimed' && one(`select delivery_status || '|' || last_error from growth_outbound.sends where id = '${S1}';`) === 'claimed|Resend answered 503');

  /* ══ S. RESULT ════════════════════════════════════════════════════════ */
  r = result(S1, 'msg_abc123', null, false);
  chk('S a message id makes it sent', r.ok && r.state === 'sent' && one(`select delivery_status || '|' || (sent_at is not null) || '|' || resend_message_id || '|' || coalesce(last_error, '-')
      from growth_outbound.sends where id = '${S1}';`) === 'sent|true|msg_abc123|-');
  chk('S a TEST send does not mark the real prospect contacted', pstatus(pid(1)) === 'ready_for_review');
  r = claim(did(1));
  chk('S claiming a sent draft again never sends it again', r.ok === true && r.already === true && r.state === 'sent' && !r.message && !r.idempotency_key, r);
  chk('S the same id again is harmless', result(S1, 'msg_abc123', null, false).already === true);
  chk('S a different id is refused (the record is never replaced)', result(S1, 'msg_other99', null, false).reason === 'different_message_id');
  chk('S a malformed id is refused', result(S1, 'bad id; drop table', null, false).reason === 'invalid_message_id');
  chk('S a failure after the fact is refused', result(S1, null, 'late', true).reason === 'already_sent');

  r = claim(did(2));
  const S2 = r.send_id;
  r = result(S2, null, 'refused by Resend (422): Invalid `to` field', true);
  chk('S a permanent refusal marks it failed, with the reason', r.ok && r.state === 'failed' && one(`select delivery_status || '|' || failure_reason from growth_outbound.sends where id = '${S2}';`)
    === 'failed|refused by Resend (422): Invalid `to` field');
  r = claim(did(2));
  chk('S … and a failed send is never retried by claiming again', r.already === true && r.state === 'failed' && !r.idempotency_key);

  /* stale: the outcome of a claim unknown for more than 23 hours */
  r = claim(did(3));
  const S3 = r.send_id;
  one(`alter table growth_outbound.sends disable trigger sends_guard_t;
       update growth_outbound.sends set claimed_at = now() - interval '24 hours' where id = '${S3}';
       alter table growth_outbound.sends enable trigger sends_guard_t;`);
  r = claim(did(3));
  chk('R an unanswered claim older than 23 hours is abandoned, not retried: never sent twice', r.ok === false && r.reason === 'stale_claim'
    && one(`select delivery_status from growth_outbound.sends where id = '${S3}';`) === 'failed', r);
  chk('R … and stays abandoned', claim(did(3)).already === true);

  /* ══ G. GATES AT SEND TIME ════════════════════════════════════════════ */
  one(`insert into growth_outbound.evidence (prospect_id, field_name, claim, source_url, source_kind, source_excerpt, collected_by)
       values ('${pid(4)}', 'full_name', 'Anna Belle', 'https://people-directory.test/ab', 'directory', 'Anna Belle', 'research_engine');`);
  r = claim(did(4));
  chk('G an approval the prospect no longer earns is not sent (re-evaluated at send time) and goes back to review', r.ok === false
    && r.reason === 'approval_withdrawn' && dstatus(did(4)) === 'pending_review' && nsends(`draft_id = '${did(4)}'`) === 0, r);
  own(`select public.growth_outbound_suppress('kai@mossmodels.test', 'unsubscribe', 'asked', 'address');`);
  r = claim(did(5));
  chk('G a suppressed prospect\'s approved draft was cancelled, so there is nothing to send', r.ok === false && r.reason === 'not_approved' && r.status === 'cancelled', r);

  /* ══ LIVE ═════════════════════════════════════════════════════════════ */
  settings({ test_mode: false, confirm_live: true });
  r = claim(did(6));
  chk('B live, nothing goes out until the opt-out endpoint is configured — and nothing is written', r.ok === false
    && /sending is blocked: unsubscribe_endpoint_missing/.test(r.detail) && nsends(`draft_id = '${did(6)}'`) === 0 && dstatus(did(6)) === 'approved', r);
  settings({ unsubscribe_url_base: 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/' });
  r = claim(did(6));
  const S6 = r.send_id;
  const tok = one(`select optout_token from growth_outbound.sends where id = '${S6}';`);
  chk('C live, the message goes to the approved recipient', r.ok === true && r.test === false && r.message.to === 'ola@reedreport.test', r);
  chk('C … with this send\'s own opt-out link in the footer', r.message.text.indexOf('https://iattxbkbufslbauoumga.supabase.co/functions/v1/growth_outbound_optout?t=' + tok) > 0);
  chk('C … and the RFC 8058 one-click headers', r.message.headers['List-Unsubscribe'] === '<https://iattxbkbufslbauoumga.supabase.co/functions/v1/growth_outbound_optout?t=' + tok + '>, <mailto:davis@edgedesksports.com?subject=stop>'
    && r.message.headers['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click', r.message.headers);
  r = result(S6, 'msg_live_001', null, false);
  chk('S a real step-1 send marks the prospect contacted', r.ok && pstatus(pid(6)) === 'contacted');
  chk('S … and contacted stays, whatever is re-evaluated', JSON.parse(db.as(OWNER, `select public.growth_outbound_prospect_evaluate('${pid(6)}');`)).status === 'contacted');

  /* a follow-up goes only to a contacted prospect */
  const proj6 = one(`select id from growth_outbound.evidence where prospect_id = '${pid(6)}' and field_name = 'project' and superseded_at is null order by id limit 1;`);
  r = own(`select public.growth_outbound_draft_create('${pid(6)}', ${lit(JSON.stringify({ sequence_number: 2, subject: 'Following up', body_text: 'Hi Ola, following up on your CFB power ratings against the market.',
    claims: [{ text: 'your CFB power ratings against the market', evidence_id: +proj6 }] }))}::jsonb);`);
  const F6 = r.draft_id;
  r = approve(F6);
  chk('G (setup) a follow-up draft for the contacted prospect is approved', r.ok === true, r);
  r = claim(F6);
  chk('G … and sent as step 2, with its own key', r.ok === true && r.idempotency_key === 'edgedesk-outbound-' + F6, r);

  /* the cap */
  settings({ max_sends_per_day: 2 });
  one(SEED.strong({ id: pid(7), name: 'Cap Test', org: 'Cap Media', email: 'cap@captest.test', domain: 'captest.test', handle: 'captest' })
    + SEED.draft({ id: did(7), prospect: pid(7), subject: 'Cap', body: 'Hi Cap,' }));
  approve(did(7));
  r = claim(did(7));
  chk('G the daily cap holds at the claim: refused, nothing written, the draft still approved', r.ok === false && /daily send cap \(2\)/.test(r.detail)
    && nsends(`draft_id = '${did(7)}'`) === 0 && dstatus(did(7)) === 'approved', r);

  /* ══ I. THE RECORD ════════════════════════════════════════════════════ */
  let e = db.mustFail(() => one(`update growth_outbound.sends set optout_token = 'x' where id = '${S6}';`));
  chk('I a send\'s opt-out token never changes, even for the superuser', !!e && /only its delivery state/.test(e), e);
  e = db.mustFail(() => one(`update growth_outbound.sends set recipient = 'someone@else.test' where id = '${S6}';`));
  chk('I … nor where it went', !!e && /only its delivery state/.test(e), e);
  e = db.mustFail(() => one(`insert into growth_outbound.sends (prospect_id, draft_id, sequence_number, idempotency_key, sender, intended_recipient, recipient, subject, content_hash, claimed_by)
      values ('${pid(7)}', '${did(7)}', 1, 'k', 'x', 'cap@captest.test', 'cap@captest.test', 'Cap', ${lit(hashOf(did(7)))}, '${OWNER}');`));
  chk('I no send row is written except through the claim door', !!e && /claim door/.test(e), e);
  const list = own(`select public.growth_outbound_sends(50);`);
  chk('I the owner reads every send: who, where, how it went', list.length === 5 && list.some((x) => x.id === S6 && x.full_name === 'Ola Reed' && x.delivery_status === 'sent' && x.recipient === 'ola@reedreport.test')
    && list.some((x) => x.id === S2 && x.delivery_status === 'failed' && /422/.test(x.failure_reason)), list.map((x) => x.delivery_status));
  for (const sql of [`select public.growth_outbound_send_claim('${did(7)}');`, `select public.growth_outbound_send_result('${S6}', 'msg_x12345', null, false);`, `select public.growth_outbound_sends(10);`]) {
    e = db.mustFail(() => db.as(ADMIN, sql));
    chk('I an affiliate admin who is not an owner is refused: ' + sql.slice(14, 48), !!e && /outbound owner only/.test(e), e);
  }
  const acts = new Set(own(`select public.growth_outbound_activity(500, null);`).map((a) => a.action));
  chk('I every step is on the record', ['send_claimed', 'send_retried', 'sent', 'send_failed', 'send_attempt_failed', 'send_abandoned'].every((a) => acts.has(a)), [...acts]);

  const rep = db.applyFileAtomic(FILE);
  chk('the file re-runs over all of this, every report row ok', !/CHECK THIS/.test(rep), rep.split('\n').filter((l) => /CHECK THIS/.test(l)));
  chk('… and reports the sends', /sends: 2 live, 3 test; 0 claimed over an hour ago without an answer/.test(rep), rep.split('\n').filter((l) => /^22\|/.test(l)));
} catch (err) {
  chk('the suite ran without an unexpected error', false, String(err.sqlMessage || err.message).slice(0, 1500));
} finally {
  db.stop();
}
process.exit(T.done());
