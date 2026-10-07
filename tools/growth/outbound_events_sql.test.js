#!/usr/bin/env node
/* ===========================================================================
   PHASE 6 — WHAT COMES BACK: provider events, opt-outs, replies
   supabase/growth_outbound.sql; the Edge Functions that relay to these doors
   are tools/growth/outbound_events.test.js.

     H  HMAC       the signature check is HMAC-SHA256 to the letter (RFC 4231
                   vectors, and agreement with Node's crypto on edge sizes)
     K  SECRET     set from the SQL editor only — never through the API, never
                   echoed; malformed secrets refused
     V  VERIFY     Svix's scheme: a good signature, any of several (rotation);
                   a wrong one, a stale or future timestamp, a tampered body,
                   missing headers — refused before anything is read or kept
     D  DEDUPE     the same event delivered twice is applied once
     E  EVENTS     delivered / delayed / opened / clicked / failed; a hard
                   bounce, a complaint and Resend's own suppression suppress
                   the address (never for a test send); a soft bounce does
                   not; nothing moves a send backwards; an email this engine
                   did not send leaves no trace
     O  OPT-OUT    a send's 64-hex token only; the link's page changes nothing
                   and shows a masked address; the button suppresses; twice
                   is once; a test send's link changes nothing
     R  REPLIED    the owner marks a reply: follow-ups stop; "asked to stop"
                   suppresses
     L  LIVE       no live send without the webhook secret
     P  PUBLIC     exactly two doors anon may call, and nothing else; signed-in
                   callers cannot call those two; the events list is the
                   owner's; provider events are append-only

   Run: node tools/growth/outbound_events_sql.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const crypto = require('crypto');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const SEED = require(path.join(__dirname, '_outbound_seed.js'));

const T = PG.kit('growth outbound events SQL');
const chk = T.chk;
const lit = PG.lit;
const FILE = path.join(PG.ROOT, 'supabase', 'growth_outbound.sql');

const db = PG.start('goevents');
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
const hashOf = (d) => one(`select content_hash from growth_outbound.drafts where id = '${d}';`);
const approve = (d) => own(`select public.growth_outbound_draft_approve('${d}', ${lit(hashOf(d))});`);
const claim = (d) => own(`select public.growth_outbound_send_claim('${d}');`);
const result = (s, id) => own(`select public.growth_outbound_send_result('${s}', ${lit(id)}, null, false);`);
const settings = (o) => own(`select public.growth_outbound_settings_update(${lit(JSON.stringify(o))}::jsonb);`);
const sendRow = (id) => j(one(`select to_jsonb(x) from growth_outbound.sends x where id = '${id}';`));
const pstatus = (p) => one(`select status from growth_outbound.prospects where id = '${p}';`);
const dstatus = (d) => one(`select status from growth_outbound.drafts where id = '${d}';`);
const count = (t, where) => +one(`select count(*) from growth_outbound.${t}${where ? ' where ' + where : ''};`);
const footprint = () => one(`select (select count(*) from growth_outbound.provider_events) || '|' || (select count(*) from growth_outbound.suppressions)
  || '|' || (select count(*) from growth_outbound.activity) || '|' || (select string_agg(delivery_status || coalesce(opened_at::text, '') || coalesce(clicked_at::text, ''), ',' order by id) from growth_outbound.sends)
  || '|' || (select string_agg(status, ',' order by id) from growth_outbound.prospects);`);

/* Svix's scheme, as Resend signs: base64(HMAC-SHA256(secret bytes, "<id>.<ts>.<body>")), under "v1," */
const sign = (id, ts, body, secret = SECRET) => 'v1,' + crypto.createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(id + '.' + ts + '.' + body, 'utf8').digest('base64');
const now = () => String(Math.floor(Date.now() / 1000));
let evn = 0;
const event = (type, data) => JSON.stringify({ type, created_at: new Date().toISOString(), data });
/* the webhook door, as anon (what the Edge Function's call amounts to) */
const hook = (body, o = {}) => {
  const id = o.id !== undefined ? o.id : 'msg_evt_' + (++evn);
  const ts = o.ts !== undefined ? o.ts : now();
  const sig = o.sig !== undefined ? o.sig : sign(id, ts, body, o.secret);
  return j(db.anon(`select public.growth_outbound_webhook(${lit(id)}, ${lit(ts)}, ${lit(sig)}, ${lit(body)});`));
};
const optout = (tok, confirm) => j(db.anon(`select public.growth_outbound_optout(${lit(tok)}, ${confirm ? 'true' : 'false'});`));

try {
  ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql', 'growth_outbound.sql']
    .forEach((f) => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f)));
  one(`insert into auth.users (id, email, email_confirmed_at) values ('${OWNER}', 'owner@edgedesk.test', now()), ('${ADMIN}', 'admin@edgedesk.test', now()),
         ('${SUB}', 'sub@edgedesk.test', now());
       insert into public.affiliate_admins (user_id) values ('${OWNER}'), ('${ADMIN}');
       select growth_outbound.grant_owner('owner@edgedesk.test');`);
  const people = [[1, 'Pat Analyst', 'pat@cfbnumbers.test', 'cfbnumbers.test', 'patanalyst'], [2, 'Sam Spare', 'sam@propslab.test', 'propslab.test', 'samspare'],
    [3, 'Lee Live', 'lee@leelab.test', 'leelab.test', 'leelab'], [4, 'Ana Bell', 'ana@bellratings.test', 'bellratings.test', 'anabell'],
    [5, 'Kai Moss', 'kai@mossmodels.test', 'mossmodels.test', 'kaimoss'], [6, 'Ola Reed', 'ola@reedreport.test', 'reedreport.test', 'olareed'],
    [7, 'Tess Test', 'tess@testsend.test', 'testsend.test', 'tesstest'], [8, 'Uma Ward', 'uma@wardnumbers.test', 'wardnumbers.test', 'umaward']];
  one(people.map(([n, name, email, domain, handle]) => SEED.strong({ id: pid(n), name, org: name.split(' ')[1] + ' Media', email, domain, handle })
    + SEED.draft({ id: did(n), prospect: pid(n), subject: 'Your work, ' + name.split(' ')[0], body: 'Hi ' + name.split(' ')[0] + ',' })).join('\n'));
  people.forEach(([n]) => approve(did(n)));
  chk('(seed) eight real prospects with approved drafts', count('drafts', `status = 'approved'`) === 8);
  settings({ postal_address: 'EdgeDesk Sports, 100 Example St, Springfield, IL 62701', test_inbox: 'owner-test@edgedesk.test',
    unsubscribe_url_base: 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/' });

  /* ══ H. HMAC ══════════════════════════════════════════════════════════ */
  const hmacSql = (kHex, mHex) => one(`select encode(growth_outbound.hmac_sha256(decode('${kHex}', 'hex'), decode('${mHex}', 'hex')), 'hex');`);
  const hx = (s) => Buffer.from(s, 'utf8').toString('hex');
  const RFC4231 = [
    ['0b'.repeat(20), hx('Hi There'), 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'],
    [hx('Jefe'), hx('what do ya want for nothing?'), '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'],
    ['aa'.repeat(20), 'dd'.repeat(50), '773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe'],
    ['0102030405060708090a0b0c0d0e0f10111213141516171819', 'cd'.repeat(50), '82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b'],
    ['aa'.repeat(131), hx('Test Using Larger Than Block-Size Key - Hash Key First'), '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54'],
    ['aa'.repeat(131), hx('This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm.'),
      '9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2'],
  ];
  RFC4231.forEach(([k, m, want], i) => chk('H RFC 4231 test case ' + [1, 2, 3, 4, 6, 7][i], hmacSql(k, m) === want, hmacSql(k, m)));
  const sizes = [[0, 0], [1, 1], [63, 10], [64, 64], [65, 200], [128, 0], [32, 1000]];
  const agree = sizes.filter(([kl, ml]) => {
    const k = crypto.randomBytes(kl), m = crypto.randomBytes(ml);
    return hmacSql(k.toString('hex'), m.toString('hex')) === crypto.createHmac('sha256', k).update(m).digest('hex');
  });
  chk('H agrees with Node\'s crypto at every edge: empty key, 63/64/65-byte keys, empty and long messages', agree.length === sizes.length, sizes.length - agree.length);

  /* ══ K. THE SECRET ════════════════════════════════════════════════════ */
  let st = own(`select public.growth_outbound_settings();`);
  chk('K a fresh install says the webhook secret is not set, and live sending is blocked on it', st.webhook && st.webhook.secret_set === false
    && st.live_send_blockers.includes('webhook_secret_missing') && !st.test_send_blockers.includes('webhook_secret_missing'), st.webhook);
  let r = hook(event('email.delivered', { email_id: 'whatever' }));
  chk('V with no secret configured, every delivery is refused, and nothing is kept', r.ok === false && r.verified === false && r.reason === 'no_secret_configured'
    && count('provider_events') === 0, r);
  let e;
  for (const [who, run] of [['anon', (s) => db.anon(s)], ['a subscriber', (s) => db.as(SUB, s)], ['the owner', (s) => db.as(OWNER, s)], ['the service role', (s) => db.service(s)]]) {
    e = db.mustFail(() => run(`select growth_outbound.set_webhook_secret('${SECRET}');`));
    chk('K ' + who + ' cannot set the secret through the API', !!e && /permission denied/.test(e), e);
    e = db.mustFail(() => run(`select value from growth_outbound.secrets;`));
    chk('K … nor read it', !!e && /permission denied/.test(e), e);
  }
  /* even a security-definer function added later by mistake: the API's own markers on the session refuse it */
  e = db.mustFail(() => one(`begin; set local request.jwt.claims = '{"sub":"${OWNER}","role":"authenticated"}'; select growth_outbound.set_webhook_secret('${SECRET}'); commit;`));
  chk('K a call carrying an API request\'s claims is refused, whatever the role', !!e && /SQL editor only/.test(e), e);
  e = db.mustFail(() => one(`begin; set local request.jwt.claims = '{"role":"anon"}'; insert into growth_outbound.secrets (name, value) values ('resend_webhook', '${SECRET}'); commit;`));
  chk('K … and so is a direct write of the table from inside such a call', !!e && /SQL editor only/.test(e), e);
  /* each layer alone: the function refuses even with the table's trigger switched off */
  e = db.mustFail(() => one(`begin; alter table growth_outbound.secrets disable trigger secrets_guard_t;
      set local request.jwt.claims = '{"sub":"${OWNER}","role":"authenticated"}'; select growth_outbound.set_webhook_secret('${SECRET}'); commit;`));
  chk('K (layer alone) set_webhook_secret itself refuses an API call, without the table trigger', !!e && /SQL editor only/.test(e)
    && one(`select tgenabled from pg_trigger where tgname = 'secrets_guard_t';`) === 'O', e);
  for (const [bad, why] of [['', /not a Resend webhook signing secret/], ['an-api-key-not-a-signing-secret-0123', /not a Resend webhook signing secret/],
    ['<whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw>', /remove the < >/], ['whsec_short', /not a Resend webhook signing secret/],
    ['whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaS', /not valid base64/]]) {
    e = db.mustFail(() => one(`select growth_outbound.set_webhook_secret(${lit(bad)});`));
    chk('K a malformed secret is refused: ' + (bad || '(empty)').slice(0, 24), !!e && why.test(e), e);
  }
  chk('K … and nothing was stored', count('secrets') === 0);
  e = db.mustFail(() => one(`insert into growth_outbound.secrets (name, value) values ('resend_api_key', 're_x');`));
  chk('K the secrets table holds the webhook secret and nothing else', !!e && /secrets_name_ck/.test(e), e);
  const set = one(`select growth_outbound.set_webhook_secret('  ${SECRET}  ');`);
  chk('K the SQL editor sets it (trimmed), and the answer does not echo it', /^ok/.test(set) && !set.includes('MfKQ') && one(`select value from growth_outbound.secrets;`) === SECRET, set);
  st = own(`select public.growth_outbound_settings();`);
  chk('K the console sees only that it is set — never the value', st.webhook.secret_set === true && !JSON.stringify(st).includes('MfKQ')
    && !st.live_send_blockers.includes('webhook_secret_missing'), st.webhook);

  /* the sends the events are about: live for 1–6 and 8, a test send for 7 */
  r = claim(did(7));
  chk('(setup) a TEST send to the owner\'s inbox', r.ok === true && r.test === true, r);
  const S7 = r.send_id;
  result(S7, 'msg_test_007');
  settings({ test_mode: false, confirm_live: true });
  const S = {};
  for (const n of [1, 2, 3, 4, 5, 6, 8]) {
    r = claim(did(n));
    if (!r.ok) throw new Error('setup claim ' + n + ': ' + JSON.stringify(r));
    S[n] = r.send_id;
    result(S[n], 'msg_live_00' + n);
  }
  chk('(setup) seven live sends, every prospect contacted', [1, 2, 3, 4, 5, 6, 8].every((n) => pstatus(pid(n)) === 'contacted' && sendRow(S[n]).delivery_status === 'sent'));
  /* a follow-up waiting for Ana, Kai and Uma — a suppression must cancel it */
  const follow = (n, name) => {
    const proj = one(`select id from growth_outbound.evidence where prospect_id = '${pid(n)}' and field_name = 'project' and superseded_at is null order by id limit 1;`);
    const x = own(`select public.growth_outbound_draft_create('${pid(n)}', ${lit(JSON.stringify({ sequence_number: 2, subject: 'Following up', body_text: 'Hi ' + name + ', following up on your CFB power ratings against the market.',
      claims: [{ text: 'your CFB power ratings against the market', evidence_id: +proj }] }))}::jsonb);`);
    return x.draft_id;
  };
  const F4 = follow(4, 'Ana'), F5 = follow(5, 'Kai'), F8 = follow(8, 'Uma'), F6 = follow(6, 'Ola');
  chk('(setup) follow-up drafts waiting', [F4, F5, F8, F6].every((d) => d && dstatus(d) === 'pending_review'));

  /* ══ V. VERIFY ════════════════════════════════════════════════════════ */
  const body1 = event('email.delivered', { email_id: 'msg_live_001', to: ['pat@cfbnumbers.test'] });
  let before = footprint();
  const ts = now();
  r = hook(body1, { id: 'msg_v1', ts, sig: sign('msg_v1', ts, body1, 'whsec_' + Buffer.from('another secret entirely!').toString('base64')) });
  chk('V a signature made with another secret is refused, and nothing is read or kept', r.ok === false && r.verified === false && r.reason === 'signature_mismatch' && footprint() === before, r);
  r = hook(body1.replace('msg_live_001', 'msg_live_002'), { id: 'msg_v2', ts, sig: sign('msg_v2', ts, body1) });
  chk('V a body changed after signing is refused', r.reason === 'signature_mismatch' && footprint() === before, r);
  r = hook(body1, { id: 'msg_v3b', ts, sig: sign('msg_v3', ts, body1) });
  chk('V a signature lifted from another delivery (another id) is refused', r.reason === 'signature_mismatch' && footprint() === before, r);
  const old = String(+now() - 302);
  r = hook(body1, { id: 'msg_v4', ts: old, sig: sign('msg_v4', old, body1) });
  chk('V a correctly signed delivery more than five minutes old (a replay) is refused', r.reason === 'timestamp_outside_tolerance' && footprint() === before, r);
  const fut = String(+now() + 302);
  r = hook(body1, { id: 'msg_v5', ts: fut, sig: sign('msg_v5', fut, body1) });
  chk('V … and one from more than five minutes in the future', r.reason === 'timestamp_outside_tolerance' && footprint() === before, r);
  for (const [o, why] of [[{ id: '' }, 'missing_signature_headers'], [{ sig: '' }, 'missing_signature_headers'], [{ ts: 'yesterday' }, 'unreadable_timestamp'],
    [{ ts: '1e9' }, 'unreadable_timestamp'], [{ sig: 'v1,' }, 'signature_mismatch'], [{ sig: sign('msg_v6', ts, body1).replace('v1,', 'v2,'), id: 'msg_v6', ts }, 'signature_mismatch']]) {
    r = hook(body1, o);
    chk('V refused: ' + JSON.stringify(o).slice(0, 40), r.ok === false && r.verified === false && r.reason === why && footprint() === before, r);
  }
  r = hook(body1, { id: 'msg_v7', ts, sig: 'v1,bm90IHRoZSBzaWduYXR1cmU= ' + sign('msg_v7', ts, body1) });
  chk('V any one of several signatures will do (Svix sends one per active secret while rotating)', r.ok === true && r.outcome === 'delivered', r);
  chk('V … and the send is delivered', sendRow(S[1]).delivery_status === 'delivered' && !!sendRow(S[1]).delivered_at);

  /* ══ D. DEDUPE ════════════════════════════════════════════════════════ */
  before = footprint();
  r = hook(body1, { id: 'msg_v7' });
  chk('D the same event delivered again (a provider retry) is acknowledged, not applied twice', r.ok === true && r.duplicate === true && footprint() === before, r);

  /* ══ E. EVENTS ════════════════════════════════════════════════════════ */
  before = footprint();
  r = hook(event('email.delivered', { email_id: 'msg_newsletter_123', to: ['reader@somewhere.test'], subject: 'This week' }), { id: 'msg_nl_1' });
  chk('E an event about an email this engine did not send (the newsletter) is acknowledged', r.ok === true && r.outcome === 'not_outbound', r);
  chk('E … and nothing about it is kept: no address, no message id, no subject — only that an id was seen', one(`select coalesce(message_id, '') || '|' || coalesce(send_id::text, '') || '|' || detail::text || '|' || event_type
      from growth_outbound.provider_events where event_id = 'msg_nl_1';`) === '||{}|email.delivered' && count('activity') === +before.split('|')[2]);
  r = hook(event('email.sent', { email_id: 'msg_live_002' }));
  chk('E email.sent is noted as accepted; the send is already "sent"', r.outcome === 'accepted' && sendRow(S[2]).delivery_status === 'sent', r);
  r = hook(event('email.delivered', { email_id: 'msg_live_002' }));
  chk('E delivered', r.outcome === 'delivered' && sendRow(S[2]).delivery_status === 'delivered', r);
  r = hook(event('email.delivery_delayed', { email_id: 'msg_live_002' }));
  chk('E a "delayed" that arrives after "delivered" never moves the send back', r.outcome === 'delayed' && sendRow(S[2]).delivery_status === 'delivered', r);
  r = hook(event('email.opened', { email_id: 'msg_live_002' }));
  const op1 = sendRow(S[2]).opened_at;
  chk('E opened: the first time is noted', r.outcome === 'opened' && !!op1, r);
  one(`select pg_sleep(0.05);`);
  hook(event('email.opened', { email_id: 'msg_live_002' }));
  chk('E … and only the first', sendRow(S[2]).opened_at === op1);
  r = hook(event('email.clicked', { email_id: 'msg_live_002', click: { link: 'https://edgedesksports.com/' } }));
  chk('E clicked: noted', r.outcome === 'clicked' && !!sendRow(S[2]).clicked_at, r);
  chk('E opens and clicks are not suppression events: Sam is still contacted', pstatus(pid(2)) === 'contacted' && count('suppressions') === 0);

  r = hook(event('email.delivery_delayed', { email_id: 'msg_live_003' }));
  chk('E a delay before delivery shows as delayed', r.outcome === 'delayed' && sendRow(S[3]).delivery_status === 'delayed', r);
  r = hook(event('email.bounced', { email_id: 'msg_live_003', bounce: { type: 'Transient', subType: 'MailboxFull', message: 'mailbox full' } }));
  chk('E a SOFT bounce (a full mailbox) is noted on the send…', r.outcome === 'soft_bounce' && sendRow(S[3]).delivery_status === 'delayed' && /soft bounce: MailboxFull/.test(sendRow(S[3]).last_error), r);
  chk('E … and suppresses nothing: a full mailbox is not a dead address', count('suppressions') === 0 && pstatus(pid(3)) === 'contacted');
  r = hook(event('email.delivered', { email_id: 'msg_live_003' }));
  chk('E … and the later delivery still lands', sendRow(S[3]).delivery_status === 'delivered', r);

  r = hook(event('email.bounced', { email_id: 'msg_live_004', bounce: { type: 'Permanent', subType: 'General', message: '550 no such user' } }));
  const s4 = sendRow(S[4]);
  chk('E a HARD bounce: the send is bounced, with the reason', r.outcome === 'bounced_suppressed' && s4.delivery_status === 'bounced' && !!s4.bounced_at
    && s4.failure_reason === 'hard bounce: General', s4);
  chk('E … the address is suppressed for good, by the webhook', one(`select kind || '|' || source || '|' || scope || '|' || target || '|' || coalesce(created_by::text, 'none')
      from growth_outbound.suppressions where target = 'ana@bellratings.test';`) === 'bounce|webhook|address|ana@bellratings.test|none');
  chk('E … the prospect is suppressed and the address marked invalid', pstatus(pid(4)) === 'suppressed'
    && one(`select email_invalid_at is not null from growth_outbound.prospects where id = '${pid(4)}';`) === 't');
  chk('E … and the follow-up waiting for them is cancelled', dstatus(F4) === 'cancelled');
  chk('E … and it is on the record, as the webhook', one(`select actor_kind || '|' || coalesce(actor_user_id::text, 'none') from growth_outbound.activity
      where action = 'provider_bounced_suppressed' and entity_id = '${S[4]}';`) === 'webhook|none');
  r = hook(event('email.delivered', { email_id: 'msg_live_004' }));
  chk('E a "delivered" arriving after the bounce never un-bounces it', sendRow(S[4]).delivery_status === 'bounced', r);
  before = footprint();
  r = hook(event('email.bounced', { email_id: 'msg_live_004', bounce: { type: 'Permanent' } }));
  chk('E a second bounce for the same send (another event id) adds no second suppression', count('suppressions', `target = 'ana@bellratings.test'`) === 1, r);
  r = hook(event('email.bounced', { email_id: 'msg_live_008', bounce: { type: 'Undetermined' } }));
  chk('E a bounce of unknown kind is treated as hard (fail closed: stop sending)', r.outcome === 'bounced_suppressed' && pstatus(pid(8)) === 'suppressed' && dstatus(F8) === 'cancelled', r);

  r = hook(event('email.complained', { email_id: 'msg_live_005' }));
  chk('E a spam complaint: the send is complained, the address suppressed, the follow-up cancelled', r.outcome === 'complained_suppressed'
    && sendRow(S[5]).delivery_status === 'complained' && !!sendRow(S[5]).complained_at && pstatus(pid(5)) === 'suppressed' && dstatus(F5) === 'cancelled'
    && one(`select kind || '|' || source from growth_outbound.suppressions where target = 'kai@mossmodels.test';`) === 'complaint|webhook', r);

  r = hook(event('email.bounced', { email_id: 'msg_test_007', bounce: { type: 'Permanent' } }));
  chk('E a TEST send that bounces is recorded on the send…', r.outcome === 'bounced_test' && sendRow(S7).delivery_status === 'bounced', r);
  chk('E … and suppresses nothing (it went to the owner\'s own inbox, not the prospect)', count('suppressions', `target in ('tess@testsend.test', 'owner-test@edgedesk.test')`) === 0
    && pstatus(pid(7)) !== 'suppressed' && one(`select email_invalid_at is null from growth_outbound.prospects where id = '${pid(7)}';`) === 't');
  r = hook(event('email.complained', { email_id: 'msg_test_007' }));
  chk('E … nor does a complaint about a test send', r.outcome === 'complained_test' && count('suppressions', `target in ('tess@testsend.test', 'owner-test@edgedesk.test')`) === 0, r);

  r = hook(event('email.failed', { email_id: 'msg_live_006', failed: { reason: 'something' } }));
  chk('E failed at the provider: recorded', r.outcome === 'failed' && sendRow(S[6]).delivery_status === 'failed' && !!sendRow(S[6]).failed_at, r);
  one(SEED.strong({ id: pid(11), name: 'Rae Listed', org: 'Listed Media', email: 'rae@listed.test', domain: 'listed.test', handle: 'raelisted' })
    + SEED.draft({ id: did(11), prospect: pid(11), subject: 'Your work, Rae', body: 'Hi Rae,' }));
  approve(did(11));
  r = claim(did(11));
  const S11 = r.send_id;
  result(S11, 'msg_live_011');
  r = hook(event('email.suppressed', { email_id: 'msg_live_011', suppressed: { type: 'OnAccountSuppressionList', message: 'on the account suppression list' } }));
  chk('E Resend refused to send (the address is on ITS suppression list): the send failed, with why', r.outcome === 'provider_suppressed' && sendRow(S11).delivery_status === 'failed'
    && /suppression list \(OnAccountSuppressionList\)/.test(sendRow(S11).failure_reason), [r, sendRow(S11).failure_reason]);
  chk('E … and the address is suppressed here too (fail closed: never tried again)', pstatus(pid(11)) === 'suppressed'
    && one(`select kind || '|' || source from growth_outbound.suppressions where target = 'rae@listed.test';`) === 'bounce|webhook');
  r = hook(event('email.suppressed', { email_id: 'msg_test_007', suppressed: { type: 'OnAccountSuppressionList' } }));
  chk('E … but never for a test send', r.outcome === 'suppressed_test' && count('suppressions', `target in ('tess@testsend.test', 'owner-test@edgedesk.test')`) === 0, r);
  r = hook(event('contact.created', { email_id: 'msg_live_006' }));
  chk('E an event type this engine does not use is kept as ignored and changes nothing', r.outcome === 'ignored' && sendRow(S[6]).delivery_status === 'failed', r);

  before = footprint();
  for (const [body, why] of [['not json', 'unparseable'], ['[1,2]', 'unparseable'], ['"text"', 'unparseable'], ['{"type":"x","data":"\\u0000"}', 'unparseable']]) {
    r = hook(body);
    chk('E a signed body that is not a JSON object is refused and nothing kept: ' + body.slice(0, 20), r.ok === false && r.verified === true && r.reason === why && footprint() === before, r);
  }
  const big = JSON.stringify({ type: 'email.delivered', data: { email_id: 'msg_live_001', pad: 'x'.repeat(262200) } });
  r = hook(big);
  chk('E a signed body over 256 KB is refused and nothing kept', r.ok === false && r.reason === 'too_large' && footprint() === before, r);
  r = hook(event('email.delivered', { email_id: 'msg_live_001', to: ['pat@cfbnumbers.test'], subject: 'Ünïcödé — “quotes” 🏈' }));
  chk('E a body with any UTF-8 verifies byte for byte', r.ok === true, r);

  /* ══ O. OPT-OUT ═══════════════════════════════════════════════════════ */
  const tok = (s) => one(`select optout_token from growth_outbound.sends where id = '${s}';`);
  before = footprint();
  for (const bad of ['', 'abc', tok(S[6]).toUpperCase(), tok(S[6]) + '0', tok(S[6]).slice(1), "' or 1=1 --", 'f'.repeat(64)]) {
    r = optout(bad, true);
    chk('O refused, and nothing changes: ' + JSON.stringify(bad.slice(0, 16)), r.ok === false && r.reason === 'invalid' && Object.keys(r).length === 2 && footprint() === before, r);
  }
  r = optout(tok(S[6]), false);
  chk('O the link\'s page changes nothing and shows only a masked address', r.ok === true && r.done === false && r.already === false && r.masked === 'o•••@reedreport.test'
    && footprint() === before, r);
  chk('O … and says nothing else about the person or the database', Object.keys(r).sort().join() === 'already,done,masked,ok' && !JSON.stringify(r).includes('Ola'), r);
  r = optout(tok(S[6]), true);
  chk('O the button stops all email to the address', r.ok === true && r.done === true && r.already === false && r.masked === 'o•••@reedreport.test', r);
  chk('O … recorded as an unsubscribe from the link; the prospect suppressed; the follow-up cancelled', one(`select kind || '|' || source || '|' || coalesce(created_by::text, 'none')
      from growth_outbound.suppressions where target = 'ola@reedreport.test';`) === 'unsubscribe|unsubscribe_link|none' && pstatus(pid(6)) === 'suppressed' && dstatus(F6) === 'cancelled');
  chk('O … and on the record, by the system', one(`select actor_kind from growth_outbound.activity where action = 'opted_out' and entity_id = '${S[6]}';`) === 'system');
  before = footprint();
  r = optout(tok(S[6]), true);
  chk('O twice is once: already done, nothing new written', r.ok === true && r.already === true && r.done === true && footprint() === before, r);
  r = optout(tok(S[6]), false);
  chk('O … and the page says so', r.already === true && r.done === true, r);
  r = optout(tok(S[4]), true);
  chk('O a link for an address already suppressed another way (the bounce) says done, writes nothing', r.ok === true && r.already === true
    && count('suppressions', `target = 'ana@bellratings.test'`) === 1, r);
  before = footprint();
  r = optout(tok(S7), true);
  chk('O a TEST send\'s link changes nothing, even confirmed', r.ok === true && r.test === true && r.done === false && r.masked === 'o•••@edgedesk.test' && footprint() === before, r);

  /* ══ R. REPLIED ═══════════════════════════════════════════════════════ */
  const replied = (who, p, note, stop) => j(db.as(who, `select public.growth_outbound_prospect_replied('${p}', ${lit(note)}, ${stop ? 'true' : 'false'});`));
  for (const who of [ADMIN, SUB]) {
    e = db.mustFail(() => replied(who, pid(1), null, false));
    chk('R only an owner marks a reply (' + (who === ADMIN ? 'an affiliate admin' : 'a subscriber') + ' is refused)', !!e && /outbound owner only|permission denied/.test(e), e);
  }
  one(SEED.strong({ id: pid(9), name: 'Never Sent', org: 'Unsent Media', email: 'never@unsent.test', domain: 'unsent.test', handle: 'neversent' }));
  r = replied(OWNER, pid(9), null, false);
  chk('R a prospect never emailed cannot be marked replied', r.ok === false && r.reason === 'not_contacted', r);
  r = replied(OWNER, '10000000-0000-0000-0000-00000000ffff', null, false);
  chk('R an unknown prospect: not found', r.ok === false && r.reason === 'not_found', r);
  const F1 = follow(1, 'Pat');
  r = replied(OWNER, pid(1), 'Interested — asked for a demo', false);
  chk('R a reply: replied, the waiting follow-up cancelled, the address NOT suppressed', r.ok === true && r.status === 'replied' && r.drafts_cancelled === 1 && r.suppressed === false
    && pstatus(pid(1)) === 'replied' && dstatus(F1) === 'cancelled' && count('suppressions', `target = 'pat@cfbnumbers.test'`) === 0, r);
  chk('R … on the record', one(`select count(*) from growth_outbound.activity where action = 'prospect_replied' and prospect_id = '${pid(1)}';`) === '1');
  const F1b = follow(1, 'Pat');
  approve(F1b);
  r = claim(F1b);
  chk('R a follow-up written after the reply is never sent', r.ok === false && count('sends', `draft_id = '${F1b}'`) === 0, r);
  r = replied(OWNER, pid(3), 'Please take me off your list', true);
  chk('R "they asked to stop": replied, and the address suppressed for good', r.ok === true && r.suppressed === true
    && one(`select kind || '|' || source || '|' || created_by from growth_outbound.suppressions where target = 'lee@leelab.test';`) === 'replied|reply|' + OWNER, r);
  chk('R … which makes the prospect suppressed', pstatus(pid(3)) === 'suppressed');
  r = replied(OWNER, pid(1), null, true);
  chk('R a prospect already marked replied can still be marked "asked to stop"', r.ok === true && r.suppressed === true && count('suppressions', `target = 'pat@cfbnumbers.test'`) === 1, r);

  /* ══ L. LIVE NEEDS THE SECRET ═════════════════════════════════════════ */
  one(`delete from growth_outbound.secrets;`);
  st = own(`select public.growth_outbound_settings();`);
  chk('L with the secret removed (SQL editor), live sending is blocked again', st.webhook.secret_set === false && st.send_blockers.includes('webhook_secret_missing'), st.send_blockers);
  one(SEED.strong({ id: pid(10), name: 'Ivy Late', org: 'Late Media', email: 'ivy@late.test', domain: 'late.test', handle: 'ivylate' })
    + SEED.draft({ id: did(10), prospect: pid(10), subject: 'Your work, Ivy', body: 'Hi Ivy,' }));
  approve(did(10));
  r = claim(did(10));
  chk('L … and a claim is refused, nothing written', r.ok === false && /webhook_secret_missing/.test(r.detail) && count('sends', `draft_id = '${did(10)}'`) === 0, r);
  r = hook(event('email.delivered', { email_id: 'msg_live_002' }));
  chk('L … and every delivery is refused again', r.ok === false && r.reason === 'no_secret_configured', r);
  one(`select growth_outbound.set_webhook_secret('${SECRET}');`);

  /* ══ P. THE PUBLIC SURFACE ════════════════════════════════════════════ */
  const anonDoors = one(`select string_agg(p.proname, ',' order by p.proname) from pg_proc p where p.pronamespace = 'public'::regnamespace
      and p.proname like 'growth\\_outbound\\_%' and has_function_privilege('anon', p.oid, 'execute');`);
  chk('P anon may call exactly two outbound doors', anonDoors === 'growth_outbound_optout,growth_outbound_webhook', anonDoors);
  const authPublic = one(`select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('growth_outbound_optout', 'growth_outbound_webhook')
      and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute'));`);
  chk('P … and no signed-in caller (nor the service role) may call those two', authPublic === '0');
  const anyAnon = one(`select count(*) from pg_proc p where p.pronamespace = 'growth_outbound'::regnamespace and has_function_privilege('anon', p.oid, 'execute');`);
  chk('P no internal function is callable by anon (no schema usage)', one(`select has_schema_privilege('anon', 'growth_outbound', 'usage');`) === 'f', anyAnon);
  const evs = own(`select public.growth_outbound_provider_events(100);`);
  chk('P the owner reads what Resend reported, with whose send it was', evs.length > 10 && evs.some((x) => x.outcome === 'bounced_suppressed' && x.recipient === 'ana@bellratings.test')
    && evs.every((x) => x.outcome !== 'not_outbound'), evs.length);
  for (const who of [ADMIN, SUB]) {
    e = db.mustFail(() => db.as(who, `select public.growth_outbound_provider_events(10);`));
    chk('P a non-owner cannot read them', !!e && /outbound owner only/.test(e), e);
  }
  e = db.mustFail(() => db.anon(`select public.growth_outbound_provider_events(10);`));
  chk('P nor can anon', !!e && /permission denied/.test(e), e);
  e = db.mustFail(() => one(`update growth_outbound.provider_events set outcome = 'x';`));
  chk('P provider events are append-only, even for the superuser (update)', !!e && /append-only/.test(e), e);
  e = db.mustFail(() => one(`delete from growth_outbound.provider_events;`));
  chk('P … (delete)', !!e && /append-only/.test(e), e);

  const rep = db.applyFileAtomic(FILE);
  chk('the file re-runs over all of this, every report row ok', !/CHECK THIS/.test(rep), rep.split('\n').filter((l) => /CHECK THIS/.test(l)));
  chk('… the report says the secret is set and the public doors are two', /^24\|Resend webhook signing secret: set/m.test(rep) && /^23\|two public doors and only two/m.test(rep),
    rep.split('\n').filter((l) => /^2[3-6]\|/.test(l)));
  chk('… and counts the provider events', /^26\|provider events: \d+ in 24 hours/m.test(rep), rep.split('\n').filter((l) => /^26\|/.test(l)));
} catch (err) {
  chk('the suite ran without an unexpected error', false, String(err.sqlMessage || err.message).slice(0, 1500));
} finally {
  db.stop();
}
process.exit(T.done());
