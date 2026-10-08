#!/usr/bin/env node
/* ===========================================================================
   PHASE 11 — ONE PROSPECT'S WHOLE LIFE, through every part at once.

   All six outbound Edge Functions as deployed (research, draft, send,
   webhook, opt-out, the owner's daily email), the pg_cron tick, and the
   site's own acquisition doors (supabase/growth.sql), against ONE real
   database. Only the outside world is stood in for: Brave, the web,
   Hunter, Claude (the SDK), Resend, Stripe's ledger rows. Each phase was tested alone; this proves they compose.

     1  the morning run finds a candidate and researches it into a prospect,
        on single-use tickets, with no owner signed in
     2  the owner tops up the evidence; the morning run drafts; the owner
        reviews the message exactly as it will go out, and approves it
     3  test mode: Resend receives it for the owner's inbox only, its links
        carry ob_test; Resend's signed webhook marks it delivered
     4  live: the engine drafts again, the owner approves, Resend receives it
        for the prospect, with their campaign code, their opt-out link and the
        one-click headers; delivered, opened, clicked
     5  they visit from the link and make an account (the site's own doors),
        start a trial; the results show it, matched by the link; they are
        converted and no follow-up is ever drafted for them
     6  a second prospect's email bounces for good: suppressed, no follow-up
     7  a third presses the one-click opt-out: suppressed, no follow-up
     8  across all of it: Resend called once per approved message, never for
        a suppressed address, each with its own key; no key or token in any
        answer; approve and send happened only by the owner's hand
     9  the owner's daily email (2026-10): the morning run drafts for a newly
        qualified prospect; when it has nothing left to do, the tick hands a
        ticket to the digest function, and Resend gets one note — to the
        owner alone, counts only; no send, no prospect touched
    10  a reply, read from Resend (2026-10): the owner sends that draft; the
        person answers; Resend's signed email.received reaches the webhook
        function, and the database ends their sequence — as "They replied"

   Run: node tools/growth/outbound_lifecycle.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const crypto = require('crypto');
const { register } = require('node:module');
const { pathToFileURL } = require('node:url');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const SEED = require(path.join(__dirname, '_outbound_seed.js'));
const { rpcShim, jres } = require(path.join(__dirname, '_rpc_shim.js'));
const MORNING = require(path.join(__dirname, '_morning.js'));

let pass = 0, fail = 0;
const failures = [];
const chk = (n, c, d) => { if (c) pass++; else { fail++; failures.push(n + (d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 700) : '')); } };

const FNS = path.join(__dirname, '..', '..', 'supabase', 'functions');
const fn = (name) => path.join(FNS, name, 'index.ts');

const db = PG.start('golife');
if (db.skip) { console.log('NOTE | ' + db.skip + ' — skipped'); process.exit(0); }
register(pathToFileURL(path.join(__dirname, '_stubs', 'hooks.mjs')));

const URL_ = 'https://proj.supabase.test';
const ANON = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.anon';
const OWNER_T = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.sig-owner';
const OWNER = '00000000-0000-0000-0000-0000000000a1';
const KEYS = { brave: 'brave_lifecycle_key_111', hunter: 'hunter_lifecycle_key_222', anthropic: 'sk-ant-lifecycle-333', resend: 're_lifecycle_key_444' };
const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const lit = PG.lit;
const one = (s) => db.sql(s);
const own = (s) => JSON.parse(db.as(OWNER, s));
const J = (o) => lit(JSON.stringify(o)) + '::jsonb';
const pstatus = (p) => one(`select status from growth_outbound.prospects where id = ${lit(p)};`);

/* ── the outside world ─────────────────────────────────────────────────── */
let LOG = [];
const ANSWERS = [];   // every function's answer, scanned for secrets at the end
const MAIL = [];      // what Resend was handed
const SHIM = rpcShim(db, { url: URL_, users: { [OWNER_T]: { id: OWNER, email: 'owner@edgedesk.test' } } });
const HOME = `<!doctype html><html><head><title>CFB Numbers — Pat Analyst</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Person","name":"Pat Analyst","worksFor":{"@type":"Organization","name":"CFB Numbers"},"sameAs":["https://x.com/patanalyst"]}</script></head>
<body><a href="/about">About</a> <a href="/contact">Contact</a><h1>CFB Numbers</h1>
<p>Pat Analyst runs CFB Numbers, a college football ratings newsletter with 12,500 subscribers.</p>
<p>Our model prices every game against the closing line &amp; tracks CLV.</p>
<footer><a href="https://x.com/patanalyst" rel="me">Twitter</a> <a href="mailto:Pat@CFBNumbers.io">Email Pat</a></footer></body></html>`;
const WEB = {
  'https://cfbnumbers.io/': HOME,
  'https://cfbnumbers.io/about': '<html><head><title>About</title></head><body><p>I am Pat Analyst, founder of CFB Numbers. I publish CFB power ratings against the market every week.</p></body></html>',
  'https://cfbnumbers.io/contact': '<p>Write to Pat.</p>',
};
globalThis.fetch = async (input, init) => {
  const url = String(input), u = new URL(url), h = Object.assign({}, (init && init.headers) || {});
  LOG.push({ url, host: u.host, headers: h });
  const viaDb = await SHIM(url, init);
  if (viaDb) return viaDb;
  if (u.host === 'api.search.brave.com') return jres(200, { type: 'search', web: { results: [{ url: 'https://cfbnumbers.io/', title: 'CFB Numbers', description: 'CFB ratings by Pat' }] } });
  if (u.host === 'api.hunter.io') return u.pathname === '/v2/email-verifier' ? jres(200, { data: { status: 'valid', email: u.searchParams.get('email') } }) : jres(200, { data: { emails: [] } });
  if (url === 'https://api.resend.com/emails') {
    const m = JSON.parse(init.body);
    MAIL.push({ key: h['idempotency-key'], authz: h.authorization, msg: m });
    return jres(200, { id: 're_lc_' + String(MAIL.length).padStart(4, '0') });
  }
  // (Phase 13) the configured opt-out endpoint IS the deployed opt-out function
  if (u.host === 'iattxbkbufslbauoumga.supabase.co' && u.pathname === '/functions/v1/growth_outbound_optout') {
    return M.optout.handle(new Request(url, { method: (init && init.method) || 'GET', headers: h, body: init && init.body }), cfg.optout);
  }
  if (u.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /', { status: 200, headers: { 'content-type': 'text/plain' } });
  if (WEB[u.origin + u.pathname]) return new Response(WEB[u.origin + u.pathname], { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
};
globalThis.Deno = { env: { get: () => undefined } };

/* Claude: reads the pages (research) or writes the email (drafting), honestly */
const PAT_FACTS = [
  { field: 'full_name', claim: 'Pat Analyst', quote: 'I am Pat Analyst, founder of CFB Numbers', page: 1 },
  { field: 'organization', claim: 'CFB Numbers', quote: 'I am Pat Analyst, founder of CFB Numbers', page: 1 },
  { field: 'project', claim: 'CFB power ratings against the market', quote: 'I publish CFB power ratings against the market every week', page: 1 },
  { field: 'fit_signal', claim: 'prices games against the closing line', quote: 'Our model prices every game against the closing line & tracks CLV', page: 0 }];
const PITCH = "I'm Davis, and I'm building EdgeDesk Sports: research for NFL and college football, with bet logging and results tracked against the closing line. It's research, not picks.\n\n"
  + 'If it would be useful for your work, you can try it free for 7 days at https://edgedesksports.com/ (then $49.99/month).\n\nWould it be worth a look?';
const reply = (o) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(o) }] });
globalThis.__claude = (req) => {
  const props = req.output_config && req.output_config.format && req.output_config.format.schema && req.output_config.format.schema.properties;
  if (props && props.facts) {
    return reply({ relevant: true, reason: 'a CFB modeler', prospect_type: 'cfb_analyst', sports: ['CFB'], facts: PAT_FACTS,
      fit_factors: [{ code: 'publishes_models', facts: [2] }, { code: 'covers_cfb', facts: [2] }], own_profiles: ['https://x.com/patanalyst'] });
  }
  const u = String(req.messages[0].content);
  const greet = /Greeting \(the first line, exactly\): (.*)/.exec(u)[1];
  const f = /\[(\d+)\] project: "([^"]+)"/.exec(u);
  return reply({ subject: 'A research tool for your work', claims: [{ evidence_id: +f[1], text: f[2] }],
    body: greet + '\n\nI came across your ' + f[2] + ' and wanted to reach out.\n\n' + PITCH });
};

const cfg = {
  research: { url: URL_, anonKey: ANON, braveKey: KEYS.brave, hunterKey: KEYS.hunter, anthropicKey: KEYS.anthropic, model: 'claude-opus-5-5',
    origins: ['https://edgedesksports.com'], fetch: (u, i) => globalThis.fetch(u, i), timeoutMs: 3000, fetchTimeoutMs: 3000,
    resolveDns: async (host, type) => (type === 'A' ? ['93.184.216.34'] : []) },
  draft: { url: URL_, anonKey: ANON, anthropicKey: KEYS.anthropic, model: 'claude-opus-5-5', origins: ['https://edgedesksports.com'],
    fetch: (u, i) => globalThis.fetch(u, i), timeoutMs: 3000 },
  send: { url: URL_, anonKey: ANON, resendKey: KEYS.resend, origins: ['https://edgedesksports.com'], fetch: (u, i) => globalThis.fetch(u, i), timeoutMs: 3000 },
  webhook: { url: URL_, anonKey: ANON, fetch: (u, i) => globalThis.fetch(u, i), log: () => {} },
  optout: { url: URL_, anonKey: ANON, page: 'https://edgedesksports.com/email/stop/', fetch: (u, i) => globalThis.fetch(u, i), log: () => {} },
  digest: { url: URL_, anonKey: ANON, resendKey: KEYS.resend, fetch: (u, i) => globalThis.fetch(u, i), timeoutMs: 3000, log: () => {} },
};
const M = {};
async function call(name, req) {
  const r = await M[name].handle(req, cfg[name]);
  const raw = await r.text();
  let b = null; try { b = JSON.parse(raw); } catch (_) { b = raw; }
  ANSWERS.push(raw + JSON.stringify([...r.headers]));
  return { status: r.status, b, headers: r.headers };
}
const post = (name, body, token) => new Request(URL_ + '/functions/v1/growth_outbound_' + name, { method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json', origin: 'https://edgedesksports.com' }, token ? { authorization: 'Bearer ' + token } : {}), body: JSON.stringify(body) });
/* one morning-run step: the real tick, then the function it posted to, on its ticket, with nobody signed in */
async function morning(expectKind) {
  const m = MORNING.tick(db);
  if (!m.ticket) return { m, x: null };
  const name = m.fn.replace('growth_outbound_', '');
  const x = await call(name, post(name, { action: 'scheduled', ticket: m.ticket }, null));
  if (expectKind && m.r.kind !== expectKind) failures.push('expected a ' + expectKind + ' step, got ' + JSON.stringify(m.r));
  return { m, x };
}
/* Resend's signed webhook, as Svix delivers it */
let evn = 0;
function hook(type, emailId, data) {
  const id = 'msg_lc_' + (++evn), ts = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ type, created_at: new Date().toISOString(), data: Object.assign({ email_id: emailId }, data || {}) });
  const sig = 'v1,' + crypto.createHmac('sha256', Buffer.from(SECRET.slice(6), 'base64')).update(id + '.' + ts + '.' + body, 'utf8').digest('base64');
  return call('webhook', new Request(URL_ + '/functions/v1/growth_outbound_webhook', { method: 'POST',
    headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': sig }, body }));
}
const approve = (d) => own(`select public.growth_outbound_draft_approve(${lit(d)}, ${lit(one(`select content_hash from growth_outbound.drafts where id = ${lit(d)};`))});`);
const pendingDraft = (p) => one(`select coalesce((select id::text from growth_outbound.drafts where prospect_id = ${lit(p)} and status = 'pending_review' order by generated_at desc limit 1), '');`);
const resetRuns = () => one(`update growth_outbound.research_runs set status = 'done', finished_at = now() where status = 'running';`);

(async () => {
  try {
    ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql', 'growth_outbound.sql']
      .forEach((f) => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f)));
    one(`insert into auth.users (id, email, email_confirmed_at, created_at) values ('${OWNER}', 'owner@edgedesk.test', now(), now() - interval '1 year');
         insert into public.affiliate_admins (user_id) values ('${OWNER}');
         select growth_outbound.grant_owner('owner@edgedesk.test');
         select growth_outbound.set_webhook_secret(${lit(SECRET)});`);
    own(`select public.growth_outbound_settings_update(${J({ postal_address: 'EdgeDesk Sports, 100 Example St, Springfield, IL 62701', test_inbox: 'owner-test@edgedesk.test',
      unsubscribe_url_base: 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/', daily_prospect_target: 2,
      discovery_config: { queries: ['cfb power ratings newsletter'] } })});`);
    MORNING.install(db);
    for (const k of ['research', 'draft', 'send', 'webhook', 'optout', 'digest']) M[k] = await import(fn('growth_outbound_' + k));

    /* ══ 1. FOUND AND RESEARCHED, WITH NOBODY SIGNED IN ══════════════════ */
    let s = await morning('discover');
    chk('1 the morning run searches: one new candidate, on a ticket, with no owner token', s.x && s.x.status === 200 && s.x.b.ok === true && s.x.b.new === 1, s.x && s.x.b);
    s = await morning('research');
    chk('1 … then researches it into a prospect, every fact quoted from a stored page', s.x && s.x.b.ok === true && s.x.b.outcome === 'created', s.x && s.x.b);
    const PAT = s.x.b.prospect_id;
    chk('1 … its address found on their own page and verified', one(`select email || '|' || email_status from growth_outbound.prospects where id = ${lit(PAT)};`) === 'pat@cfbnumbers.io|verified');
    chk('1 … and nothing drafted, approved or sent by it', +one(`select count(*) from growth_outbound.drafts;`) === 0 && MAIL.length === 0);

    /* ══ 2. THE OWNER CONFIRMS; THE ENGINE DRAFTS; THE OWNER APPROVES ════ */
    const fitEv = +one(`select id from growth_outbound.evidence where prospect_id = ${lit(PAT)} and field_name = 'fit_signal' and superseded_at is null order by id limit 1;`);
    let r = own(`select public.growth_outbound_evidence_add(${lit(PAT)}, ${J({ evidence: [
      { field_name: 'full_name', claim: 'Pat Analyst', source_url: 'https://x.com/patanalyst', source_kind: 'own_profile', source_excerpt: 'Pat Analyst (@patanalyst)' },
      { field_name: 'organization', claim: 'CFB Numbers', source_url: 'https://x.com/patanalyst', source_kind: 'own_profile', source_excerpt: 'founder, CFB Numbers' },
      { field_name: 'project', claim: 'CFB power ratings against the market', source_url: 'https://x.com/patanalyst/status/1', source_kind: 'own_profile',
        source_excerpt: 'New: CFB power ratings against the market' }],
      fit_factors: SEED.FIT_STRONG.map((code) => ({ code, evidence: [fitEv] })) })});`);
    chk('2 the owner confirms them from their own profile: they clear every gate', r.ok === true && pstatus(PAT) === 'qualified', [r, pstatus(PAT)]);
    resetRuns();
    s = await morning('draft');
    chk('2 the morning run drafts for them, as Claude, citing their own words', s.x && s.x.b.ok === true && s.x.b.drafted === 1, s.x && s.x.b);
    let D = pendingDraft(PAT);
    let card = own(`select public.growth_outbound_review_queue('pending_review', 50);`).rows.find((c) => c.draft.id === D);
    chk('2 the owner reviews the message exactly as it will go: test mode, to their own inbox, the link tagged ob_test', !!card && card.preview.test === true
      && card.preview.to === 'owner-test@edgedesk.test' && card.preview.text.includes('utm_campaign=ob_test') && card.claims.length === 1 && card.claims[0].evidence.current, card && card.preview);
    chk('2 nothing reaches Resend before the owner approves and presses send', MAIL.length === 0);
    r = approve(D);
    chk('2 the owner approves it', r.ok === true, r);

    /* ══ 3. A TEST SEND ═══════════════════════════════════════════════════ */
    let x = await call('send', post('send', { draft_ids: [D] }, OWNER_T));
    chk('3 the owner sends it: Resend receives one email, for the owner\'s inbox only', x.status === 200 && x.b.ok === true && MAIL.length === 1
      && JSON.stringify(MAIL[0].msg.to) === JSON.stringify(['owner-test@edgedesk.test']), [x.b, MAIL.map((m) => m.msg.to)]);
    chk('3 … from Davis, with its own key, its links carrying ob_test, and the one-click headers', MAIL[0].msg.from === 'Davis <davis@edgedesksports.com>'
      && MAIL[0].key === 'edgedesk-outbound-' + D && MAIL[0].msg.text.includes('https://edgedesksports.com/?utm_source=outbound&utm_medium=email&utm_campaign=ob_test')
      && !MAIL[0].msg.text.includes(one(`select attribution_token from growth_outbound.prospects where id = ${lit(PAT)};`))
      && /growth_outbound_optout\?t=[0-9a-f]{64}/.test(MAIL[0].msg.text) && /One-Click/.test(JSON.stringify(MAIL[0].msg.headers)), MAIL[0]);
    x = await hook('email.delivered', 're_lc_0001');
    chk('3 Resend\'s signed webhook says delivered: recorded', x.status === 200 && one(`select delivery_status from growth_outbound.sends where resend_message_id = 're_lc_0001';`) === 'delivered', x.b);
    chk('3 a test send does not make them contacted', pstatus(PAT) !== 'contacted');
    // (Phase 13) going live needs the webhook PROVEN (the delivered event above
    // did it) and the opt-out endpoint CHECKED at its base, end to end
    let st = own(`select public.growth_outbound_settings();`);
    chk('3 the signed event proved the webhook; the opt-out endpoint is still unchecked, so live sending is blocked', st.webhook.proven === true
      && JSON.stringify(st.live_send_blockers) === JSON.stringify(['unsubscribe_endpoint_unverified']), st.live_send_blockers);
    x = await call('send', post('send', { action: 'optout_check' }, OWNER_T));
    st = own(`select public.growth_outbound_settings();`);
    chk('3 the owner checks the opt-out endpoint: a GET redirects to the stop page, a one-click POST reaches the database; recorded, nothing blocks',
      x.status === 200 && x.b.ok === true && x.b.check.ok === true && x.b.check.redirect_ok === true && x.b.check.post_ok === true
      && st.live_send_blockers.length === 0 && one(`select count(*) from growth_outbound.suppressions;`) === '0', [x.b, st.live_send_blockers]);

    /* ══ 4. LIVE ══════════════════════════════════════════════════════════ */
    r = own(`select public.growth_outbound_settings_update('{"test_mode": false, "confirm_live": true}'::jsonb);`);
    chk('4 the owner goes live (it had to be confirmed)', r.ok === true, r);
    resetRuns();
    s = await morning('draft');
    D = pendingDraft(PAT);
    chk('4 the morning run drafts their first email again, for real this time', s.x && s.x.b.drafted === 1 && !!D, s.x && s.x.b);
    card = own(`select public.growth_outbound_review_queue('pending_review', 50);`).rows.find((c) => c.draft.id === D);
    const PAT_CODE = 'ob_' + one(`select attribution_token from growth_outbound.prospects where id = ${lit(PAT)};`);
    chk('4 the card now says LIVE, to them, with their own campaign code', card.preview.test === false && card.preview.to === 'pat@cfbnumbers.io'
      && card.preview.text.includes('utm_campaign=' + PAT_CODE), card.preview);
    approve(D);
    x = await call('send', post('send', { draft_ids: [D] }, OWNER_T));
    const live = MAIL[1];
    chk('4 sent live: Resend receives it for them, with their code, their opt-out link and the one-click headers', x.b.ok === true && MAIL.length === 2
      && JSON.stringify(live.msg.to) === JSON.stringify(['pat@cfbnumbers.io']) && live.msg.text.includes('utm_campaign=' + PAT_CODE)
      && live.msg.headers['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click' && /^<https:\/\/iattxbkbufslbauoumga\.supabase\.co\/functions\/v1\/growth_outbound_optout\?t=[0-9a-f]{64}>/.test(live.msg.headers['List-Unsubscribe']),
      [x.b, live && live.msg.headers]);
    chk('4 … and now they are contacted', pstatus(PAT) === 'contacted');
    const ctx2 = own(`select public.growth_outbound_draft_context(${lit(PAT)}, 2);`);
    chk('4 a follow-up would be written knowing what reached THEM: the live email, not the dry run to the owner\'s inbox',
      Array.isArray(ctx2.previous) && ctx2.previous.length === 1 && ctx2.previous[0].sequence_number === 1, ctx2.previous);
    for (const t of ['email.delivered', 'email.opened', 'email.clicked']) await hook(t, 're_lc_0002');
    chk('4 delivered, opened and clicked, as Resend reported', one(`select delivery_status || '|' || (opened_at is not null) || '|' || (clicked_at is not null) from growth_outbound.sends where resend_message_id = 're_lc_0002';`) === 'delivered|true|true');

    /* ══ 5. THEY COME, SIGN UP, START A TRIAL ═════════════════════════════ */
    const VISITOR = 'v' + crypto.randomBytes(12).toString('hex');
    const touch = { utm_source: 'outbound', utm_medium: 'email', utm_campaign: PAT_CODE, landing: '/' };
    r = JSON.parse(db.anon(`select public.acq_track_visit(${lit(VISITOR)}, ${J(touch)});`));
    chk('5 they land on the site from the link: the site records the visit, with the campaign (its own public door)', r.ok === true
      && one(`select first_utm_campaign from public.acquisition_visitors where visitor_hash = md5('edgedesk-acq:' || ${lit(VISITOR)});`) === PAT_CODE, r);
    const PAT_USER = '30000000-0000-0000-0000-000000000001';
    one(`insert into auth.users (id, email, email_confirmed_at, created_at) values (${lit(PAT_USER)}, 'pat.personal@mail.test', now(), now());`);
    r = JSON.parse(db.as(PAT_USER, `select public.acq_claim(${lit(VISITOR)}, ${J(Object.assign({ seen_at: new Date().toISOString() }, touch))}, null);`));
    chk('5 they make an account with ANOTHER address; the site claims the touch that brought them', r.ok === true
      && one(`select first_utm_campaign from public.user_acquisition where user_id = ${lit(PAT_USER)};`) === PAT_CODE, r);
    // Stripe keeps whole seconds: the trial is stamped at the start of the very second the email went out, a fraction "before" it.
    // The email is moved EARLIER (into the second before, 0.7 s in), never later: every visit and account after it stays after it.
    one(`update growth_outbound.sends set sent_at = date_trunc('second', sent_at) - interval '1 second' + interval '0.7 second' where resend_message_id = 're_lc_0002';`);
    const TRIAL_AT = +one(`select extract(epoch from date_trunc('second', sent_at))::bigint from growth_outbound.sends where resend_message_id = 're_lc_0002';`);
    one(`insert into public.stripe_events (id, type, stripe_created, customer_id, subscription_id, user_id, payload)
         values ('evt_lc_1', 'customer.subscription.created', now(), 'cus_lc', 'sub_lc', ${lit(PAT_USER)},
                 ${J({ id: 'evt_lc_1', type: 'customer.subscription.created', data: { object: { id: 'sub_lc', customer: 'cus_lc', status: 'trialing', trial_start: TRIAL_AT } } })});`);
    const res = own(`select public.growth_outbound_analytics(90);`);
    chk('5 the results: written to, visited, an account by the link, a trial', res.people.contacted === 1 && res.people.visited === 1 && res.people.signed_up === 1
      && res.people.trial === 1 && res.latest.some((l) => l.prospect_id === PAT && l.stage === 'signed_up' && l.matched_by === 'link'), res.people);
    chk('5 … and they are converted', pstatus(PAT) === 'converted');
    chk('5 the trial Stripe stamped in whole seconds counts, dated no earlier than the account it belongs to',
      one(`select (c.occurred_at >= u.created_at)::text from growth_outbound.conversions c, auth.users u where c.prospect_id = ${lit(PAT)} and c.stage = 'trial' and u.id = ${lit(PAT_USER)};`) === 'true');

    /* ══ 6 & 7. A BOUNCE, AN OPT-OUT ══════════════════════════════════════ */
    const KIM = '10000000-0000-0000-0000-000000000002', LEE = '10000000-0000-0000-0000-000000000003';
    one(SEED.strong({ id: KIM, name: 'Kim Ratings', org: 'Ratings Lab', email: 'kim@ratingslab.test', domain: 'ratingslab.test', handle: 'kimratings' })
      + SEED.strong({ id: LEE, name: 'Lee Lines', org: 'Lee Lab', email: 'lee@leelab.test', domain: 'leelab.test', handle: 'leelines' }));
    resetRuns();
    s = await morning('draft');
    chk('6 the morning run drafts for the next two due (and not for the one who signed up)', s.x && s.x.b.drafted === 2 && !pendingDraft(PAT), s.x && s.x.b);
    const DK = pendingDraft(KIM), DL = pendingDraft(LEE);
    approve(DK); approve(DL);
    x = await call('send', post('send', { draft_ids: [DK, DL] }, OWNER_T));
    chk('6 both sent, in one press, each its own email', x.b.ok === true && MAIL.length === 4 && MAIL[2].key !== MAIL[3].key, x.b);
    const kimMail = MAIL.find((m) => m.msg.to[0] === 'kim@ratingslab.test'), leeMail = MAIL.find((m) => m.msg.to[0] === 'lee@leelab.test');
    const kimId = one(`select resend_message_id from growth_outbound.sends where prospect_id = ${lit(KIM)};`);
    x = await hook('email.bounced', kimId, { bounce: { type: 'Permanent', subType: 'General' } });
    chk('6 Kim\'s email bounces for good: the address is suppressed', x.status === 200 && pstatus(KIM) === 'suppressed'
      && +one(`select count(*) from growth_outbound.suppressions where target = 'kim@ratingslab.test' and kind = 'bounce';`) === 1, x.b);
    const leeTok = /growth_outbound_optout\?t=([0-9a-f]{64})/.exec(leeMail.msg.text)[1];
    x = await call('optout', new Request('https://iattxbkbufslbauoumga.supabase.co/functions/v1/growth_outbound_optout?t=' + leeTok, { method: 'GET' }));
    chk('7 Lee opens the opt-out link: nothing changes on a look; the page asks first', x.status === 303 && pstatus(LEE) === 'contacted');
    x = await call('optout', new Request('https://iattxbkbufslbauoumga.supabase.co/functions/v1/growth_outbound_optout?t=' + leeTok, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' }));
    chk('7 … then their mail client\'s one-click opt-out: done, and the address suppressed', x.status === 200 && /^Done\./.test(x.b) && pstatus(LEE) === 'suppressed', x.b);

    /* the days pass: nobody is followed up — one signed up, one bounced, one opted out */
    one(`update growth_outbound.sends set sent_at = sent_at - interval '6 days' where not is_test;`);
    resetRuns();
    one(`update growth_outbound.scheduler set last_tick_at = null where id = 1;`);
    s = await morning();
    chk('6-7 six days on, the morning run finds no follow-up to write', !s.x || (s.m.r.kind !== 'draft') || s.x.b.drafted === 0, s.m && s.m.r);
    chk('6-7 … and nothing is due for any of them', +one(`select count(*) from growth_outbound.drafting_due();`) === 0);

    /* ══ 8. ACROSS ALL OF IT ═════════════════════════════════════════════ */
    const fin = own(`select public.growth_outbound_analytics(90);`);
    chk('8 the results add up: three written to, one bounce, one opt-out, one account, one trial', fin.people.contacted === 3 && fin.people.bounced === 1
      && fin.people.opted_out === 1 && fin.people.signed_up === 1 && fin.people.trial === 1 && fin.sends.sent === 3, fin.people);
    chk('8 Resend was called once per approved message — four, each with its own key, with the Resend key only', MAIL.length === 4
      && new Set(MAIL.map((m) => m.key)).size === 4 && MAIL.every((m) => m.authz === 'Bearer ' + KEYS.resend)
      && LOG.filter((e) => e.headers.authorization === 'Bearer ' + KEYS.resend).every((e) => e.url === 'https://api.resend.com/emails'));
    chk('8 no email to an address after it was suppressed', !MAIL.slice(4).length);
    const leaked = ANSWERS.filter((a) => Object.values(KEYS).some((k) => a.includes(k)) || a.includes(SECRET) || a.includes(OWNER_T));
    chk('8 no answer from any function carried a key, the signing secret or a token', leaked.length === 0, leaked.slice(0, 2));
    const approvals = JSON.parse(one(`select coalesce(jsonb_agg(distinct actor_kind), '[]') from growth_outbound.activity where action in ('draft_approved', 'send_claimed');`));
    chk('8 every approval and every send was the owner\'s own act', JSON.stringify(approvals) === JSON.stringify(['owner']), approvals);
    const sched = JSON.parse(one(`select coalesce(jsonb_agg(distinct action), '[]') from growth_outbound.activity where actor_kind = 'system';`));
    chk('8 what the system did on its own: found, researched, drafted, matched — never approved or sent',
      !sched.some((a) => /approv|send_claimed|^sent$/.test(a)) && sched.includes('prospect_converted'), sched);
    /* ══ 9. THE OWNER'S DAILY EMAIL ══════════════════════════════════════ */
    r = own(`select public.growth_outbound_settings_update('{"digest_enabled": true}'::jsonb);`);
    chk('9 the owner turns the daily email on: it goes to their own address', r.ok === true && r.settings.digest_to === 'owner@edgedesk.test', r.settings && r.settings.digest_to);
    const KAI = '00000000-0000-0000-0000-00000000c0a1';
    one(SEED.strong({ id: KAI, name: 'Kai Lines', email: 'kai@linelab.test', domain: 'linelab.test', handle: 'KaiLines', org: 'Line Lab' }));
    resetRuns();
    const sendsBefore = one(`select count(*) from growth_outbound.sends;`), mailBefore = MAIL.length;
    s = await morning('draft');
    chk('9 the morning run drafts for a newly qualified prospect', s.x && s.x.b.ok === true && s.x.b.drafted >= 1 && !!pendingDraft(KAI), s.x && s.x.b);
    chk('9 … and no email goes anywhere while it works', MAIL.length === mailBefore);
    const t9 = JSON.parse(one(`select growth_outbound.schedule_tick(${lit(MORNING.BASE)}, now());`));
    const c9 = JSON.parse(one(`select to_jsonb(c) from net.calls c order by id desc limit 1;`));
    chk('9 with nothing left to do, the tick hands the daily email a ticket', t9.action === 'idle' && t9.digest && t9.digest.action === 'started'
      && c9.url === MORNING.BASE.replace(/\/$/, '') + '/growth_outbound_digest', { t9, url: c9.url });
    x = await call('digest', new Request(c9.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c9.body) }));
    const waiting = +one(`select count(*) from growth_outbound.drafts where status = 'pending_review' and not is_test;`);
    const note = (MAIL[mailBefore] || {}).msg || {};
    chk('9 the digest function sends one note, recorded as sent', x.status === 200 && x.b.sent === true && MAIL.length === mailBefore + 1
      && one(`select status from growth_outbound.digests order by id desc limit 1;`) === 'sent', x.b);
    chk('9 … to the owner alone, from EdgeDesk, saying how many wait', JSON.stringify(note.to) === '["owner@edgedesk.test"]'
      && note.from === 'EdgeDesk outbound <davis@edgedesksports.com>' && waiting >= 1
      && note.subject === waiting + (waiting === 1 ? ' outbound draft is' : ' outbound drafts are') + ' ready for your review', note);
    chk('9 … counts only: nobody\'s name, address or words', !/Kai|Pat|Lee|linelab|cfbnumbers|A research tool for your work/.test(note.subject + note.text), note.text);
    chk('9 … and nothing else moved: no send, the draft still waits for the owner', one(`select count(*) from growth_outbound.sends;`) === sendsBefore
      && one(`select status from growth_outbound.drafts where id = ${lit(pendingDraft(KAI))};`) === 'pending_review');
    const leaked9 = ANSWERS.filter((a) => Object.values(KEYS).some((k) => a.includes(k)) || a.includes(c9.body.ticket) || a.includes('owner@edgedesk.test'));
    chk('9 no answer carried a key, the ticket or the owner\'s address', leaked9.length === 0, leaked9.slice(0, 2));
    /* ══ 10. A REPLY, READ FROM RESEND ══════════════════════════════════ */
    const DKAI = pendingDraft(KAI);
    chk('10 the owner approves Kai\'s draft', approve(DKAI).ok === true);
    x = await call('send', post('send', { draft_ids: [DKAI] }, OWNER_T));
    chk('10 … and sends it: to Kai', x.status === 200 && x.b.sent === 1 && pstatus(KAI) === 'contacted' && JSON.stringify(MAIL[MAIL.length - 1].msg.to) === '["kai@linelab.test"]', x.b);
    x = await hook('email.received', 'rcv_lc_kai', { from: 'Kai Lines <Kai@LineLab.test>', to: ['replies@edgedesksports.com'], cc: [], bcc: [],
      received_for: ['replies@edgedesksports.com'], message_id: '<r1@linelab.test>', subject: 'Re: A research tool for your work', attachments: [] });
    chk('10 Kai answers; Resend\'s signed event reaches the webhook function, which relays it untouched', x.status === 200);
    chk('10 … and the database ends Kai\'s sequence, as "They replied" does', pstatus(KAI) === 'replied'
      && one(`select kind || '|' || applied from growth_outbound.replies where prospect_id = ${lit(KAI)};`) === 'reply|true'
      && one(`select actor_kind from growth_outbound.activity where action = 'prospect_replied' and prospect_id = ${lit(KAI)};`) === 'webhook'
      && +one(`select count(*) from growth_outbound.drafting_due() x where x.prospect_id = ${lit(KAI)};`) === 0);
    const rl = own(`select public.growth_outbound_replies(10);`);
    chk('10 the owner sees it in Replies: who, which email, what it was', rl.rows[0].full_name === 'Kai Lines' && rl.rows[0].kind === 'reply' && rl.rows[0].sequence_number === 1, rl.rows[0]);
    const out = db.applyFileAtomic(path.join(PG.ROOT, 'supabase', 'growth_outbound.sql'));
    chk('8 the file runs again over all of this, every report row ok', !/CHECK THIS/.test(out), out.split('\n').filter((l) => /CHECK THIS/.test(l)));
  } catch (e) {
    chk('the lifecycle ran to the end', false, String(e && e.stack || e).slice(0, 2500));
  } finally {
    db.stop();
  }
  failures.forEach((f) => console.log('FAIL | ' + f));
  console.log((fail === 0 && failures.length === 0 ? 'PASS' : 'FAIL') + ' — outbound lifecycle (six functions, one database): ' + pass + '/' + (pass + fail) + ' checks');
  process.exit(fail === 0 && failures.length === 0 ? 0 : 1);
})();
