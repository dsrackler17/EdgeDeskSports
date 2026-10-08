#!/usr/bin/env node
/* ===========================================================================
   THE DAILY EMAIL'S FUNCTION, as deployed:
     supabase/functions/growth_outbound_digest/index.ts
   imported under Node's type stripping, against the REAL database (the
   PostgREST stand-in runs every door in a throwaway PostgreSQL, as anon) and
   a stand-in for Resend. Each ticket is one the real tick minted.

     S  SOURCE     reads the project URL, the anon key and the Resend key, and
                   nothing else; one door (the ticket door); Resend's address;
                   no service-role key; no CORS (a browser has no business)
     G  GATE       only a POST, never from a browser, with a well-formed
                   ticket — or nothing is asked of anyone
     H  HAPPY      the database writes the note, Resend gets exactly it (the
                   owner's address alone, EdgeDesk's sender, counts only,
                   tagged so the newsletter leaves it alone, one key per try),
                   the database records Resend's id; the ticket is then dead
     F  FAILURES   Resend down or the key refused: recorded, retryable; Resend
                   refusing the message: recorded, final; no answer at all: it
                   may have gone, so never again; no key set: nothing sent; a
                   note that is not one plain email to one address (however it
                   came): never sent; turned off: nothing sent; the database
                   unreachable or not installed: a 503
     L  LEAKS      no answer and no log line carries a key, a ticket or the
                   owner's address

   Run: node tools/growth/outbound_digest.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const SEED = require(path.join(__dirname, '_outbound_seed.js'));
const { rpcShim, jres } = require(path.join(__dirname, '_rpc_shim.js'));
const { middayZone } = require(path.join(__dirname, '_morning.js'));

let pass = 0, fail = 0;
const failures = [];
const chk = (n, c, d) => { if (c) pass++; else { fail++; failures.push(n + (d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 600) : '')); } };

const FN = path.join(__dirname, '..', '..', 'supabase', 'functions', 'growth_outbound_digest', 'index.ts');
const SRC = fs.readFileSync(FN, 'utf8');

/* ══ S. THE SOURCE ═════════════════════════════════════════════════════════ */
{
  const envs = [...new Set([...SRC.matchAll(/env\('([A-Z_]+)'\)/g)].map((m) => m[1]))].sort();
  chk('S reads the project URL, the anon key and the Resend key, and nothing else', JSON.stringify(envs) === '["RESEND_API_KEY","SUPABASE_ANON_KEY","SUPABASE_URL"]', envs);
  chk('S no service-role key anywhere', !/SERVICE_ROLE|service_role/.test(SRC));
  chk('S one door: the ticket door', JSON.stringify([...new Set(SRC.match(/\/rest\/v1\/rpc\/[a-z_]+/g) || [])]) === '["/rest/v1/rpc/growth_outbound_scheduled"]');
  chk('S … and through it only the daily email\'s two', JSON.stringify([...new Set([...SRC.matchAll(/door\(c, ticket, '([a-z_]+)'/g)].map((m) => m[1]))].sort()) === '["digest_compose","digest_result"]');
  chk('S the only other address is Resend\'s', JSON.stringify([...new Set(SRC.match(/https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/[a-z]*)?/g) || [])]) === '["https://api.resend.com/emails"]', SRC.match(/https:\/\/[^\s'"`)]+/g));
  chk('S no CORS: no page may read an answer', !/access-control/i.test(SRC));
  chk('S never sends to a prospect: it has no send door, no draft, no prospect', !/send_claim|send_result|drafts|prospect_id|draft_id/.test(SRC.replace(/\/\/[^\n]*/g, '')));
}

const db = PG.start('godigfn');
// the deploy workflow sets OUTBOUND_PG_REQUIRED: there, no database means no deploy
if (db.skip) { console.log((process.env.OUTBOUND_PG_REQUIRED ? 'FAIL | ' : 'NOTE | ') + db.skip + ' — skipped'); process.exit(process.env.OUTBOUND_PG_REQUIRED ? 1 : 0); }

const URL_ = 'https://proj.supabase.test';
const ANON = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.anon';
const RESEND_KEY = 're_digest_test_key_555';
const OWNER = '00000000-0000-0000-0000-0000000000a1';
const BASE = 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/';
const lit = PG.lit;
const one = (s) => db.sql(s);
const own = (s) => JSON.parse(db.as(OWNER, s));
const J = (o) => lit(JSON.stringify(o)) + '::jsonb';
const today = () => JSON.parse(one(`select to_jsonb(d) from growth_outbound.digests d order by id desc limit 1;`));
const reset = () => one(`set session_replication_role = replica; delete from growth_outbound.digests; set session_replication_role = origin; delete from net.calls;`);
function mint() {
  reset();
  const r = JSON.parse(one(`select growth_outbound.schedule_tick(${lit(BASE)}, now());`));
  if (!r.digest || r.digest.action !== 'started') throw new Error('no daily email started: ' + JSON.stringify(r));
  return JSON.parse(one(`select to_jsonb(c) from net.calls c order by id desc limit 1;`)).body.ticket;
}

/* ── the outside world ─────────────────────────────────────────────────── */
let LOG = [], MAIL = [], LOGGED = [], ANSWERS = [];
let RESEND = () => jres(200, { id: 'msg_digest_' + String(MAIL.length).padStart(4, '0') });
let TAMPER = null;   // rewrite what the database answered, as a hostile network might
let DOWN = false;    // the database unreachable
const SHIM = rpcShim(db, { url: URL_, users: {} });
const world = async (input, init) => {
  const url = String(input), h = Object.assign({}, (init && init.headers) || {});
  LOG.push({ url, headers: h, body: init && init.body });
  if (url.startsWith(URL_)) {
    if (DOWN) throw new TypeError('network');
    const res = await SHIM(url, init);
    if (TAMPER && /growth_outbound_scheduled$/.test(url) && JSON.parse(init.body).p_door === 'digest_compose') {
      const b = await res.json();
      return jres(res.status, TAMPER(b));
    }
    return res;
  }
  if (url === 'https://api.resend.com/emails') {
    MAIL.push({ key: h['idempotency-key'], authz: h.authorization, msg: JSON.parse(init.body) });
    return RESEND(init);
  }
  throw new Error('unexpected address ' + url);
};
const cfg = (o) => Object.assign({ url: URL_, anonKey: ANON, resendKey: RESEND_KEY, fetch: world, timeoutMs: 1500, log: (s) => LOGGED.push(s) }, o || {});
let M;
async function call(req, o) {
  const r = await M.handle(req, cfg(o));
  const raw = await r.text();
  let b = null; try { b = JSON.parse(raw); } catch (_) { b = raw; }
  ANSWERS.push(raw + JSON.stringify([...r.headers]));
  return { status: r.status, b, headers: r.headers };
}
const post = (body, headers) => new Request(BASE + 'growth_outbound_digest', { method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, headers || {}), body: typeof body === 'string' ? body : JSON.stringify(body) });

(async () => {
  const TICKETS = [];
  try {
    ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql', 'growth_outbound.sql']
      .forEach((f) => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f)));
    one(`insert into auth.users (id, email, email_confirmed_at) values ('${OWNER}', 'owner@edgedesk.test', now());
         insert into public.affiliate_admins (user_id) values ('${OWNER}');
         select growth_outbound.grant_owner('owner@edgedesk.test');
         create schema if not exists net;
         create table net.calls (id bigserial primary key, url text, body jsonb, headers jsonb, timeout_milliseconds int);
         create or replace function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
                                                  headers jsonb default '{}'::jsonb, timeout_milliseconds int default 5000)
         returns bigint language sql as $$ insert into net.calls (url, body, headers, timeout_milliseconds)
                                            values (url, body, headers, timeout_milliseconds) returning id $$;`);
    one(SEED.strong({ id: '00000000-0000-0000-0000-000000000101', name: 'Pat Analyst', email: 'pat@cfbnumbers.test', domain: 'cfbnumbers.test', handle: 'PatAnalyst', org: 'CFB Numbers' })
      + SEED.strong({ id: '00000000-0000-0000-0000-000000000102', name: 'Quinn Model', email: 'quinn@gridedge.test', domain: 'gridedge.test', handle: 'QuinnModel', org: 'Grid Edge' })
      + SEED.draft({ id: '00000000-0000-0000-0000-000000000201', prospect: '00000000-0000-0000-0000-000000000101', subject: 'Your CFB ratings', body: 'Hi Pat, a 7-day free trial, then $49.99/month.' })
      + SEED.draft({ id: '00000000-0000-0000-0000-000000000202', prospect: '00000000-0000-0000-0000-000000000102', subject: 'Your CFB ratings', body: 'Hi Quinn, a 7-day free trial, then $49.99/month.' }));
    // the daily email on; the morning window (in a zone where it is midday now) closed at 11:00
    own(`select public.growth_outbound_settings_update(${J({ digest_enabled: true, automation_timezone: middayZone(), automation_start_hour: 8, automation_hours: 3 })});`);
    globalThis.Deno = { env: { get: () => undefined } };
    M = await import(FN);

    /* ══ G. THE GATE ═══════════════════════════════════════════════════════ */
    LOG = [];
    let x = await call(new Request(BASE + 'growth_outbound_digest', { method: 'GET' }));
    chk('G only a POST', x.status === 405);
    x = await call(post({ action: 'scheduled', ticket: 'a'.repeat(64) }, { origin: 'https://edgedesksports.com' }));
    chk('G never from a browser, even EdgeDesk\'s own pages', x.status === 403 && x.b.reason === 'not_for_browsers');
    x = await call(post('not json'));
    chk('G a body that is not the scheduler\'s: refused', x.status === 400);
    x = await call(post({ action: 'send', ticket: 'a'.repeat(64) }));
    chk('G … or another action', x.status === 400);
    x = await call(post({ action: 'scheduled', ticket: 'A'.repeat(64) }));
    chk('G a ticket that is not one: refused', x.status === 401 && x.b.reason === 'invalid_ticket');
    chk('G … and nobody was asked anything', LOG.length === 0, LOG);
    x = await call(post({ action: 'scheduled', ticket: 'a'.repeat(64) }), { url: '' });
    chk('G not configured: 503', x.status === 503 && LOG.length === 0);
    x = await call(post({ action: 'scheduled', ticket: 'a'.repeat(64) }));
    chk('G a well-formed ticket the database never minted: refused by the database, nothing sent', x.status === 401 && x.b.reason === 'invalid_ticket' && MAIL.length === 0, x);

    /* ══ H. THE HAPPY PATH ═════════════════════════════════════════════════ */
    LOG = []; MAIL = [];
    let t = mint(); TICKETS.push(t);
    x = await call(post({ action: 'scheduled', ticket: t }));
    let d = today();
    chk('H sent and recorded', x.status === 200 && x.b.ok === true && x.b.sent === true && x.b.recorded === true
      && d.status === 'sent' && d.resend_message_id === 'msg_digest_0001', { x: x.b, d });
    const m = (MAIL[0] || {}).msg || {};
    chk('H Resend got one email, to the owner\'s own address alone, from EdgeDesk\'s sender', MAIL.length === 1
      && JSON.stringify(m.to) === '["owner@edgedesk.test"]' && m.from === 'EdgeDesk outbound <davis@edgedesksports.com>' && !m.cc && !m.bcc && !m.reply_to && !m.headers, m);
    chk('H the note the database wrote, word for word', m.subject === '2 outbound drafts are ready for your review'
      && m.text.startsWith('2 drafts are waiting for your review: 2 first emails, 0 follow-ups.') && /https:\/\/edgedesksports\.com\/admin\/growth\//.test(m.text), m);
    chk('H counts only: no name, address, organization or draft', !/Pat|Quinn|cfbnumbers|gridedge|CFB Numbers|Grid Edge|Your CFB ratings/.test(m.subject + m.text), m.text);
    chk('H tagged edgedesk=outbound, so the newsletter\'s webhook leaves its events alone', JSON.stringify(m.tags) === JSON.stringify([{ name: 'edgedesk', value: 'outbound' }, { name: 'kind', value: 'owner_digest' }]), m.tags);
    chk('H with the Resend key, and one idempotency key for this try', MAIL[0].authz === 'Bearer ' + RESEND_KEY && MAIL[0].key === 'edgedesk-outbound-digest-' + d.id + '-1', MAIL[0]);
    const dbCalls = LOG.filter((e) => e.url.startsWith(URL_));
    chk('H the database is reached as anon, through the ticket door only, twice (write it; what became of it)', dbCalls.length === 2
      && dbCalls.every((e) => e.url === URL_ + '/rest/v1/rpc/growth_outbound_scheduled' && e.headers.authorization === 'Bearer ' + ANON && e.headers.apikey === ANON)
      && JSON.stringify(dbCalls.map((e) => JSON.parse(e.body).p_door)) === '["digest_compose","digest_result"]', dbCalls);
    chk('H the Resend key never goes to the database, nor the ticket to Resend', dbCalls.every((e) => !JSON.stringify(e).includes(RESEND_KEY))
      && !JSON.stringify(MAIL).includes(t));
    MAIL = [];
    x = await call(post({ action: 'scheduled', ticket: t }));
    chk('H the same ticket again: dead, nothing sent', x.status === 401 && x.b.reason === 'invalid_ticket' && MAIL.length === 0, x);
    chk('H no send row: the daily email is not outreach', one(`select count(*) from growth_outbound.sends;`) === '0');

    /* ══ F. FAILURES ═══════════════════════════════════════════════════════ */
    const failCase = async (name, answer, expect) => {
      MAIL = [];
      RESEND = answer;
      const tk = mint(); TICKETS.push(tk);
      const y = await call(post({ action: 'scheduled', ticket: tk }));
      const dd = today();
      chk('F ' + name, y.status === 502 && dd.status === 'failed' && dd.retryable === expect.retry && expect.reason.test(dd.reason) && y.b.retry === expect.retry && MAIL.length === 1, { y: y.b, dd });
    };
    await failCase('Resend down (503): recorded, safe to try again', () => jres(503, { name: 'internal_server_error', message: 'try later' }), { retry: true, reason: /^Resend answered 503: try later$/ });
    await failCase('Resend rate-limiting (429): recorded, safe to try again', () => jres(429, { name: 'rate_limit_exceeded' }), { retry: true, reason: /^Resend answered 429/ });
    await failCase('the key refused (401): recorded, safe to try again once it is fixed', () => jres(401, { name: 'missing_api_key' }), { retry: true, reason: /refused the API key \(401\)/ });
    await failCase('Resend refusing the message (422): recorded, final', () => jres(422, { name: 'validation_error', message: 'bad from' }), { retry: false, reason: /^Resend answered 422: bad from$/ });
    await failCase('no answer at all: it may have gone, so never again', () => { throw new TypeError('network'); }, { retry: false, reason: /may have gone/ });
    await failCase('a 200 without an id: not taken as sent', () => jres(200, {}), { retry: true, reason: /^Resend answered 200/ });
    RESEND = () => jres(200, { id: 'msg_ok' });

    MAIL = [];
    let tk = mint(); TICKETS.push(tk);
    x = await call(post({ action: 'scheduled', ticket: tk }), { resendKey: '' });
    d = today();
    chk('F no Resend key: nothing sent, recorded, safe to try again', x.status === 503 && MAIL.length === 0 && d.status === 'failed' && d.retryable === true && /RESEND_API_KEY/.test(d.reason), { x: x.b, d });

    const tampered = [
      ['two recipients', (b) => Object.assign(b, { message: Object.assign(b.message, { to: 'owner@edgedesk.test, pat@cfbnumbers.test' }) })],
      ['another domain\'s sender', (b) => Object.assign(b, { message: Object.assign(b.message, { from: 'EdgeDesk <davis@evil.test>' }) })],
      ['an extra header', (b) => Object.assign(b, { message: Object.assign(b.message, { bcc: 'pat@cfbnumbers.test' }) })],
      ['a subject that spans lines', (b) => Object.assign(b, { message: Object.assign(b.message, { subject: 'Hi\r\nBcc: pat@cfbnumbers.test' }) })],
      ['not a daily email at all', (b) => Object.assign(b, { kind: 'outreach' })],
    ];
    for (const [name, fn] of tampered) {
      MAIL = []; TAMPER = fn;
      tk = mint(); TICKETS.push(tk);
      x = await call(post({ action: 'scheduled', ticket: tk }));
      d = today();
      chk('F a note with ' + name + ' is never sent, and recorded as such', x.status === 500 && x.b.reason === 'message_check_failed' && MAIL.length === 0
        && d.status === 'failed' && d.retryable === false && /^not sent: /.test(d.reason), { x: x.b, d });
    }
    TAMPER = null;

    MAIL = [];
    tk = mint(); TICKETS.push(tk);
    own(`select public.growth_outbound_settings_update('{"digest_enabled": false}'::jsonb);`);
    x = await call(post({ action: 'scheduled', ticket: tk }));
    chk('F turned off after the ticket went out: nothing sent', x.status === 200 && x.b.ok === false && x.b.reason === 'digest_off' && MAIL.length === 0 && today().status === 'failed', x.b);
    own(`select public.growth_outbound_settings_update('{"digest_enabled": true}'::jsonb);`);

    tk = mint(); TICKETS.push(tk);
    DOWN = true;
    x = await call(post({ action: 'scheduled', ticket: tk }));
    DOWN = false;
    chk('F the database unreachable: 503, nothing sent', x.status === 503 && MAIL.length === 0 && today().status === 'sending', x.b);
    one(`alter function public.growth_outbound_scheduled(text, text, jsonb) rename to growth_outbound_scheduled_away;`);
    x = await call(post({ action: 'scheduled', ticket: tk }));
    one(`alter function public.growth_outbound_scheduled_away(text, text, jsonb) rename to growth_outbound_scheduled;`);
    chk('F the door not installed: 503, nothing sent', x.status === 503 && x.b.reason === 'not_installed' && MAIL.length === 0, x.b);

    // the checker itself
    const ok = { from: 'EdgeDesk outbound <davis@edgedesksports.com>', to: 'owner@edgedesk.test', subject: '1 outbound draft is ready for your review', text: '1 draft is waiting.' };
    chk('F the message check: a plain one passes', M.checkDigest(ok) === null);
    chk('F … and refuses each way of being something else', [
      null, [], Object.assign({}, ok, { to: ['owner@edgedesk.test'] }), Object.assign({}, ok, { to: 'a@b.test,c@d.test' }), Object.assign({}, ok, { to: 'owner@edgedesk.test\nbcc: x@y.test' }),
      Object.assign({}, ok, { from: 'davis@edgedesksports.com' }), Object.assign({}, ok, { from: 'A, B <davis@edgedesksports.com>' }), Object.assign({}, ok, { from: 'X <x@edgedesksports.com.evil.test>' }),
      Object.assign({}, ok, { subject: '' }), Object.assign({}, ok, { subject: 'x'.repeat(151) }), Object.assign({}, ok, { text: '' }), Object.assign({}, ok, { text: 'x'.repeat(5001) }),
      Object.assign({}, ok, { headers: {} }), Object.assign({}, ok, { html: '<p>hi</p>' }),
    ].every((v) => M.checkDigest(v) !== null));

    /* ══ L. LEAKS ══════════════════════════════════════════════════════════ */
    const said = ANSWERS.join('\n') + '\n' + LOGGED.join('\n');
    chk('L no answer and no log line carries the Resend key, the anon key, a ticket or the owner\'s address',
      !said.includes(RESEND_KEY) && !said.includes(ANON) && TICKETS.every((tt) => !said.includes(tt)) && !/owner@edgedesk\.test/.test(said), said.slice(0, 400));
    chk('L log lines are fixed words, a status or a short reason', LOGGED.length > 5 && LOGGED.every((l) => /^growth_outbound_digest: [a-zA-Z_ ,()0-9./]+$/.test(l)), LOGGED);
    chk('L no answer has CORS headers', ANSWERS.every((a) => !/access-control/i.test(a)));
  } catch (e) {
    chk('the suite ran to the end', false, String(e && (e.stack || e.message) || e).slice(0, 900));
  } finally {
    db.stop();
  }
  failures.forEach((f) => console.log('FAIL | ' + f));
  console.log((fail === 0 ? 'PASS' : 'FAIL') + ' — outbound daily email function (function + database): ' + pass + '/' + (pass + fail) + ' checks');
  process.exit(fail === 0 ? 0 : 1);
})();
