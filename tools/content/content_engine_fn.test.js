#!/usr/bin/env node
/* ===========================================================================
   THE CONTENT ENGINE EDGE FUNCTION, tested as deployed
   (supabase/functions/content_engine/index.ts), against the REAL database:
   every door it calls runs in a throwaway PostgreSQL through the PostgREST
   stand-in the outbound suites use (tools/growth/_rpc_shim.js). Claude (the
   SDK, mapped to a stub by the same Node loader hook) is mocked, and so is
   every RSS feed.

     A  WHO        only an owner: no token / the anon key 401, an affiliate
                   admin 403, only POST; CORS for EdgeDesk only
     S  STATUS     whether Claude is configured — never the key
     D  DRAFT      the frozen research and the publisher profile go to Claude
                   (structured output, the fallback beta); what comes back is
                   validated by lib/content_engine.js and saved as a revision
     R  RETRY      an invented number is refused; Claude gets the objections
                   and one more try; refused twice, nothing is saved and the
                   draft stands; both refusals are logged
     B  BUDGET     no key or no budget: no call, a plain answer
     X  SECTION    a section rewrite changes that section only
     T  TRENDING   only the allowlisted feeds, each fetch counted; a dead feed
                   is reported, not fatal
     M  SEND       the owner's send: no key, no call; a test only to the
                   owner; a real send only to a contact, only once ready; the
                   database claims it first and Resend gets that idempotency
                   key, the edgedesksports.com sender, the edgedesk=content
                   tag, the note, the article and its three files; an
                   unanswered send retried with the SAME key; delivered →
                   `sent` with its delivery row; never a second send
     K  KEYS       no key or token in any answer; no service-role key; the
                   function names no door that approves, sends or publishes;
                   the copies of the owner check and the core are verbatim

   Run: node tools/content/content_engine_fn.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { register } = require('node:module');
const { pathToFileURL } = require('node:url');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const { rpcShim } = require(path.join(__dirname, '..', 'growth', '_rpc_shim.js'));
const INLINE = require(path.join(__dirname, 'inline.js'));
const CE = require(path.join(__dirname, '..', '..', 'lib', 'content_engine.js'));
const ART = require(path.join(__dirname, 'artifacts.js'));

let pass = 0, fail = 0;
const failures = [];
const chk = (n, c, d) => { if (c) pass++; else { fail++; failures.push(n + (d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 500) : '')); } };

const FN = INLINE.TARGET;
const SRC = fs.readFileSync(FN, 'utf8');
chk('K the function carries the owner check and the core byte for byte', !INLINE.drifted());
chk('K no service-role key in its source', !/SERVICE_ROLE|service_role/.test(SRC.replace(/\/\/ ── BEGIN CONTENT ENGINE CORE[\s\S]*?END CONTENT ENGINE CORE/, '')));
chk('K Claude through the official SDK, never a raw host', /^import Anthropic from 'npm:@anthropic-ai\/sdk';$/m.test(SRC) && !/api\.anthropic\.com/.test(SRC));
chk('K the function names no door that approves, reviews or publishes', !/content_engine_article_(approve|transition|review)/.test(SRC));
chk('K the function claims a send in the database before it calls Resend', SRC.indexOf("db(x, 'content_engine_send_claim'") > 0 && SRC.indexOf("db(x, 'content_engine_send_claim'") < SRC.indexOf('x.c.fetch(RESEND_URL'));

const db = PG.start('contentfn');
if (db.skip) { console.log((process.env.CONTENT_PG_REQUIRED ? 'FAIL | ' : 'NOTE | ') + db.skip + ' — skipped'); if (process.env.CONTENT_PG_REQUIRED) process.exit(1); process.exit(0); }
register(pathToFileURL(path.join(__dirname, '..', 'growth', '_stubs', 'hooks.mjs')));

const URL_ = 'https://proj.supabase.test';
const ANON = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.anon';
const OWNER_T = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.sig-owner';
const ADMIN_T = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.sig-admin';
const OWNER = '00000000-0000-0000-0000-0000000000d1', ADMIN = '00000000-0000-0000-0000-0000000000d2';
const KEY = 'sk-ant-content-secret-987';
const lit = PG.lit;
const one = (s) => db.sql(s);
const own = (s) => JSON.parse(db.as(OWNER, s));

let LOG = [];
const DOORS = new Set();
let CLAUDE_REQS = [], CLAUDE_OPTS = [];
const SHIM = rpcShim(db, { url: URL_, users: { [OWNER_T]: { id: OWNER, email: 'owner@edgedesk.test' }, [ADMIN_T]: { id: ADMIN, email: 'admin@edgedesk.test' } } });
const RSS = `<?xml version="1.0"?><rss><channel><title>NFL</title>
  <item><title><![CDATA[Cowboys' Dak Prescott limited in practice with ankle injury]]></title><link>https://www.espn.com/nfl/story/_/id/1/dak</link>
    <pubDate>Thu, 08 Oct 2026 15:00:00 GMT</pubDate><description>Prescott was limited Thursday.</description></item>
  <item><title>Not a link</title><link>javascript:alert(1)</link></item>
</channel></rss>`;
let RESEND = [], resendMode = 'ok';
const RESEND_IDS = new Map(); /* like Resend: one id per idempotency key */
globalThis.fetch = async (input, init) => {
  const url = String(input), u = new URL(url), h = Object.assign({}, (init && init.headers) || {});
  if (url === 'https://api.resend.com/emails') {
    RESEND.push({ headers: h, body: JSON.parse(init.body) });
    if (resendMode === 'down') throw new TypeError('network down');
    if (resendMode === 'reject') return new Response(JSON.stringify({ name: 'validation_error', message: 'bad' }), { status: 422 });
    const key = h['idempotency-key'];
    if (!RESEND_IDS.has(key)) RESEND_IDS.set(key, 're_' + (RESEND_IDS.size + 1));
    return new Response(JSON.stringify({ id: RESEND_IDS.get(key) }), { status: 200 });
  }
  LOG.push({ url, host: u.host, headers: h, body: init && init.body });
  if (/\/rest\/v1\/rpc\//.test(url)) DOORS.add(url.split('/rpc/')[1]);
  const viaDb = await SHIM(url, init);
  if (viaDb) return viaDb;
  if (url === 'https://www.espn.com/espn/rss/nfl/news') return new Response(RSS, { status: 200 });
  if (u.host === 'www.cbssports.com') return new Response('nope', { status: 503 });
  if (u.host === 'sports.yahoo.com') throw new TypeError('network down');
  return new Response('not found', { status: 404 });
};
globalThis.Deno = { env: { get: () => undefined } };

const cfgOf = (o) => Object.assign({ url: URL_, anonKey: ANON, anthropicKey: KEY, model: 'claude-opus-5-5', origins: ['https://edgedesksports.com'],
  fetch: (u, i) => globalThis.fetch(u, i), timeoutMs: 3000 }, o || {});
const post = (body, o) => new Request(URL_ + '/functions/v1/content_engine', { method: (o && o.method) || 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, o && o.token === null ? {} : { authorization: 'Bearer ' + ((o && o.token) || OWNER_T) }, o && o.origin ? { origin: o.origin } : {}),
  body: o && (o.method === 'GET' || o.method === 'OPTIONS') ? undefined : JSON.stringify(body) });

/* Claude, as the tests need it */
const reply = (o) => ({ stop_reason: 'end_turn', model: 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify(o) }] });
const currentOf = (req) => JSON.parse(/CURRENT DRAFT:\n([\s\S]*)$/.exec(String(req.messages[0].content))[1]);
const honest = (req) => { const c = currentOf(req); return reply(Object.assign({}, c, { title: c.title.replace('Predictions', 'Predictions and Projections') })); };
const inventor = (req) => { const c = currentOf(req); const s = c.sections.slice(); s[0] = Object.assign({}, s[0], { body: s[0].body + ' Alabama has won 77 percent of its home games since 1990.' }); return reply(Object.assign({}, c, { sections: s })); };
const sectionWriter = (key) => (req) => { const c = currentOf(req); return reply(Object.assign({}, c, { title: 'Ignored title change for the section test', sections: c.sections.map((s) => s.key === key ? Object.assign({}, s, { body: 'The short version: EdgeDesk’s model makes Alabama a 5.3-point favorite. None of it is a pick, and a projection is not a bet.' }) : Object.assign({}, s, { body: 'CHANGED ' + s.body })) })); };
const claude = (...answers) => { let i = 0; globalThis.__claude = (req, opts) => { CLAUDE_REQS.push(req); CLAUDE_OPTS.push(opts); const a = answers[Math.min(i++, answers.length - 1)]; return a(req); }; };

(async () => {
  try {
    ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql', 'growth_outbound.sql', 'content_engine.sql']
      .forEach((f) => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f)));
    one(`insert into auth.users (id, email, email_confirmed_at) values ('${OWNER}', 'owner@edgedesk.test', now()), ('${ADMIN}', 'admin@edgedesk.test', now());
         insert into public.affiliate_admins (user_id) values ('${OWNER}'), ('${ADMIN}');
         select growth_outbound.grant_owner('owner@edgedesk.test');`);

    /* a real opportunity, from the committed research */
    const art = ART.load();
    const NOW = Date.parse('2026-10-08T17:30:00Z');
    const snap = CE.research.fromArtifacts(art, { now: NOW });
    const pubRow = own('select public.content_engine_publishers();').find((p) => p.slug === 'stadium-rant');
    const opps = CE.discover(snap, { now: NOW, publisher: pubRow });
    const o = opps.find((x) => x.kind === 'weekly_preview' && x.league === 'cfb');
    const up = own(`select public.content_engine_opportunity_upsert(${lit(JSON.stringify(Object.assign({}, o, { research_hash: CE.util.hash(JSON.stringify(o.research)) })))}::jsonb, null);`);
    const a0 = CE.draft(o, { publisher: pubRow, format: 'cfb_weekly_preview', now: NOW });
    const v0 = CE.validate(a0, o, { publisher: pubRow, now: NOW });
    chk('D the deterministic draft passes its own gate', v0.ok, v0.failed);
    const cr = own(`select public.content_engine_article_create(${lit(up.id)}, ${lit(pubRow.id)}, 'cfb_weekly_preview', 'full_slate', ${lit(JSON.stringify(Object.assign({}, a0, { checks: v0 })))}::jsonb, null);`);
    const AID = cr.id;
    const M = await import(pathToFileURL(FN).href);
    const run = async (body, cfg, opt) => { LOG = []; CLAUDE_REQS = []; CLAUDE_OPTS = [];
      const r = await M.handle(post(body, opt), cfg === undefined ? cfgOf() : cfg); let b = null; try { b = await r.json(); } catch (_) { b = null; } return { r, b, raw: JSON.stringify(b) }; };
    const rowOf = () => JSON.parse(one(`select to_jsonb(a) from content_engine.articles a where id = ${lit(AID)};`));

    /* ── A who ─────────────────────────────────────────────────────── */
    chk('A no token: 401', (await run({ action: 'status' }, undefined, { token: null })).r.status === 401);
    chk('A the anon key: 401', (await run({ action: 'status' }, undefined, { token: ANON })).r.status === 401);
    chk('A an affiliate admin: 403', (await run({ action: 'status' }, undefined, { token: ADMIN_T })).r.status === 403);
    chk('A GET: 405', (await run(null, undefined, { method: 'GET' })).r.status === 405);
    const pre = await run(null, undefined, { method: 'OPTIONS', origin: 'https://edgedesksports.com' });
    chk('A CORS for EdgeDesk', pre.r.status === 204 && pre.r.headers.get('access-control-allow-origin') === 'https://edgedesksports.com');
    const evil = await run({ action: 'status' }, undefined, { origin: 'https://evil.example' });
    chk('A … not for anyone else', !evil.r.headers.get('access-control-allow-origin'));

    /* ── S status ───────────────────────────────────────────────────── */
    const st = await run({ action: 'status' });
    chk('S status: configured, the model, the budget', st.b.ok && st.b.ai_configured === true && st.b.model === 'claude-opus-5-5' && st.b.budget.llm.cap === 20);
    chk('K … and never the key', st.raw.indexOf(KEY) < 0);
    chk('S without a key it says so', (await run({ action: 'status' }, cfgOf({ anthropicKey: '' }))).b.ai_configured === false);

    /* ── D draft ────────────────────────────────────────────────────── */
    claude(honest);
    const d1 = await run({ action: 'draft', article_id: AID });
    chk('D an honest rewrite is validated and saved as a revision', d1.b.ok && d1.b.revision === 2 && /^claude:/.test(d1.b.generator), d1.b);
    const row1 = rowOf();
    chk('D the saved title is the rewrite', /Predictions and Projections/.test(row1.title) && row1.checks_ok === true);
    const req1 = CLAUDE_REQS[0] || {};
    chk('D Claude gets the research packet and the current draft', /RESEARCH PACKET/.test(req1.messages && req1.messages[0].content) && /Alabama/.test(req1.messages[0].content));
    chk('D … the publisher profile', /PUBLISHER: Stadium Rant/.test(req1.messages[0].content));
    chk('D … structured output, effort set, the fallback beta', req1.output_config && req1.output_config.format && req1.output_config.format.type === 'json_schema'
      && req1.output_config.effort && (req1.betas || []).indexOf('server-side-fallback-2026-07-01') >= 0 && req1.fallbacks === 'default' && req1.model === 'claude-opus-5-5');
    chk('D … but not the league-wide team list', !/team_names/.test(req1.messages[0].content.split('CURRENT DRAFT')[0]) || !/"team_names":\[/.test(req1.messages[0].content));
    chk('K the key goes to the SDK only', CLAUDE_OPTS[0] && CLAUDE_OPTS[0].apiKey === KEY && LOG.every((e) => JSON.stringify(e.headers).indexOf(KEY) < 0 && String(e.body || '').indexOf(KEY) < 0));
    chk('K the database is called as the owner', LOG.filter((e) => /\/rest\/v1\/rpc\//.test(e.url)).every((e) => e.headers.authorization === 'Bearer ' + OWNER_T));

    /* ── R retry ────────────────────────────────────────────────────── */
    claude(inventor, honest);
    const d2 = await run({ action: 'draft', article_id: AID });
    chk('R an invented number is refused, the second try saved', d2.b.ok && CLAUDE_REQS.length === 2 && d2.b.revision === 3, d2.b);
    chk('R … and the second request carries the objections', /REJECTED FOR/.test(CLAUDE_REQS[1].messages[0].content) && /77/.test(CLAUDE_REQS[1].messages[0].content));
    const before = rowOf();
    claude(inventor);
    const d3 = await run({ action: 'draft', article_id: AID });
    const after = rowOf();
    chk('R refused twice: nothing saved, the draft stands', d3.b.ok === false && d3.b.reason === 'validation_failed' && after.content_hash === before.content_hash && after.revision === before.revision);
    chk('R … the reasons are returned', (d3.b.objections || []).some((x) => /number/i.test(x)));
    chk('R … and logged', +one(`select count(*) from content_engine.events where kind = 'ai_discarded' and article_id = ${lit(AID)};`) >= 3);

    /* ── X one section ──────────────────────────────────────────────── */
    claude(sectionWriter('conclusion'));
    const d4 = await run({ action: 'draft', article_id: AID, section: 'conclusion' });
    const row4 = rowOf();
    const bodies = (r) => Object.fromEntries(r.sections.map((s) => [s.key, s.body]));
    chk('X only the asked-for section changes', d4.b.ok && row4.title === after.title
      && Object.keys(bodies(row4)).every((k) => k === 'conclusion' ? bodies(row4)[k] !== bodies(after)[k] : bodies(row4)[k] === bodies(after)[k]), d4.b);
    chk('X an unknown section is refused', (await run({ action: 'draft', article_id: AID, section: 'nonsense' })).b.reason === 'bad_section');
    chk('X a malformed id is refused', (await run({ action: 'draft', article_id: 'x' })).r.status === 400);

    /* ── B budget ───────────────────────────────────────────────────── */
    const nokey = await run({ action: 'draft', article_id: AID }, cfgOf({ anthropicKey: '' }));
    chk('B no key: no call, a plain answer', nokey.b.reason === 'ai_not_configured' && CLAUDE_REQS.length === 0);
    own(`select public.content_engine_settings_save('{"llm_calls_per_day": 0}'::jsonb);`);
    claude(honest);
    const nobudget = await run({ action: 'draft', article_id: AID });
    chk('B no budget: no call, a plain answer', nobudget.b.reason === 'budget_exhausted' && CLAUDE_REQS.length === 0);
    own(`select public.content_engine_settings_save('{"llm_calls_per_day": 20}'::jsonb);`);

    /* an approved article is not rewritten */
    own(`select public.content_engine_article_submit(${lit(AID)});`);
    own(`select public.content_engine_article_review(${lit(AID)}, '{"source_verification":true,"data_freshness":true,"model_accuracy":true,"seo_review":true,"compliance":true}'::jsonb);`);
    const ap = own(`select public.content_engine_article_approve(${lit(AID)}, ${lit(rowOf().content_hash)});`);
    claude(honest);
    const locked = await run({ action: 'draft', article_id: AID });
    chk('D an approved article is not rewritten by the engine', ap.ok && locked.b.reason === 'not_editable' && CLAUDE_REQS.length === 0, ap);

    /* ── M the owner's send ─────────────────────────────────────────── */
    const RKEY = 're_live_secret_key_0001';
    const cfgM = (o) => cfgOf(Object.assign({ resendKey: RKEY }, o || {}));
    const pubId = own('select public.content_engine_publishers();').find((p) => p.slug === 'stadium-rant').id;
    own(`select public.content_engine_publisher_save(${lit(JSON.stringify({ id: pubId, contacts: [{ name: 'Sam Editor', role: 'editor', email: 'sam@publisher.example' }] }))}::jsonb);`);
    RESEND = [];
    const nk = await run({ action: 'send', article_id: AID, recipient: 'owner@edgedesk.test', test: true }, cfgM({ resendKey: '' }));
    chk('M no Resend key: no call, a plain answer', nk.b.reason === 'email_not_configured' && RESEND.length === 0);
    const tn = await run({ action: 'send', article_id: AID, recipient: 'sam@publisher.example', test: true }, cfgM());
    chk('M a test goes only to the owner’s own address', tn.b.reason === 'test_goes_to_you' && RESEND.length === 0);
    const t1 = await run({ action: 'send', article_id: AID, recipient: 'owner@edgedesk.test', subject: 'TEST: Week 6', note: 'Hi Sam,\n\nHere it is.', test: true }, cfgM());
    const e1 = RESEND[0] || { headers: {}, body: {} };
    chk('M a test to the owner is sent', t1.b.ok && t1.b.test === true && RESEND.length === 1 && e1.body.to[0] === 'owner@edgedesk.test', t1.b);
    chk('M … with the database’s key, the edgedesksports.com sender and the content tag', /^edgedesk-content-[0-9a-f]{32}$/.test(e1.headers['idempotency-key'])
      && e1.body.from === 'Davis <davis@edgedesksports.com>' && e1.body.tags.some((t) => t.name === 'edgedesk' && t.value === 'content'));
    const att = (e1.body.attachments || []).map((a) => ({ n: a.filename, t: Buffer.from(a.content, 'base64').toString('utf8') }));
    chk('M … the note, the article (HTML and text) and three files', /Here it is\./.test(e1.body.html) && /<h2>How to read these numbers<\/h2>/.test(e1.body.html) && /How to read these numbers/.test(e1.body.text)
      && att.length === 3 && /\.md$/.test(att[0].n) && /^---\ntitle:/.test(att[0].t) && /1-800-GAMBLER/.test(att[0].t) && /<!doctype html>/.test(att[1].t) && /Primary keyword:/.test(att[2].t));
    chk('M … the tagged EdgeDesk link travels in the email', /utm_campaign=ce_stadiumrant_/.test(e1.body.html));
    chk('M … a markup note stays text', (await (async () => { RESEND = []; await run({ action: 'send', article_id: AID, recipient: 'owner@edgedesk.test', note: '<script>x</script>', test: true }, cfgM()); return !/<script>/.test(RESEND[0].body.html); })()));
    chk('M … each test is on record as sent', one(`select count(*) from content_engine.sends where is_test and status = 'sent' and provider_id is not null;`) === '2');
    resendMode = 'reject'; RESEND = [];
    const rj = await run({ action: 'send', article_id: AID, recipient: 'owner@edgedesk.test', test: true }, cfgM());
    chk('M refused by Resend: said plainly, recorded as failed', rj.b.reason === 'provider_rejected' && RESEND.length === 1
      && one(`select count(*) from content_engine.sends where status = 'failed' and error like 'refused by Resend (422)%';`) === '1', rj.b);
    resendMode = 'ok';
    chk('M a test changes nothing about the article', one(`select status from content_engine.articles where id = ${lit(AID)};`) === 'approved');
    RESEND = [];
    const nr = await run({ action: 'send', article_id: AID, recipient: 'sam@publisher.example' }, cfgM());
    chk('M a real send waits until it is marked ready', nr.b.reason === 'not_ready' && RESEND.length === 0);
    own(`select public.content_engine_article_transition(${lit(AID)}, 'ready_to_send', '{}'::jsonb);`);
    const nc = await run({ action: 'send', article_id: AID, recipient: 'stranger@else.example' }, cfgM());
    chk('M only to a contact on the publisher’s profile', nc.b.reason === 'not_a_contact' && RESEND.length === 0);
    chk('M one address, well formed', (await run({ action: 'send', article_id: AID, recipient: 'a@b.example, c@d.example' }, cfgM())).r.status === 400);
    resendMode = 'down';
    const s1 = await run({ action: 'send', article_id: AID, recipient: 'sam@publisher.example', note: 'Hi Sam' }, cfgM());
    const k1 = RESEND[0] && RESEND[0].headers['idempotency-key'];
    chk('M no answer from Resend: said plainly, the claim kept', s1.b.reason === 'outcome_unknown' && one(`select status from content_engine.sends where recipient = 'sam@publisher.example';`) === 'claimed');
    resendMode = 'ok'; RESEND = [];
    const s2 = await run({ action: 'send', article_id: AID, recipient: 'sam@publisher.example', note: 'Edited since' }, cfgM());
    chk('M pressed again: the SAME key, so it cannot arrive twice', s2.b.ok && RESEND.length === 1 && RESEND[0].headers['idempotency-key'] === k1, s2.b);
    chk('M … and the same message as first claimed, not the edited note (and it says so)', /Hi Sam/.test(RESEND[0].body.html) && !/Edited since/.test(RESEND[0].body.html) && s2.b.retried === true);
    chk('M delivered: `sent`, with an email delivery row', s2.b.status === 'sent' && one(`select status from content_engine.articles where id = ${lit(AID)};`) === 'sent'
      && one(`select method from content_engine.deliveries where article_id = ${lit(AID)};`) === 'email', { b: s2.b, a: one(`select status from content_engine.articles where id = ${lit(AID)};`), d: one(`select string_agg(method, ',') from content_engine.deliveries where article_id = ${lit(AID)};`) });
    RESEND = [];
    const s3 = await run({ action: 'send', article_id: AID, recipient: 'sam@publisher.example' }, cfgM());
    chk('M never a second send', s3.b.ok === false && RESEND.length === 0, { b: s3.b, n: RESEND.length });
    chk('K the Resend key goes in its Authorization header only', [e1].every((e) => e.headers.authorization === 'Bearer ' + RKEY) && JSON.stringify([t1.b, s1.b, s2.b, s3.b]).indexOf(RKEY) < 0);

    /* ── T trending ─────────────────────────────────────────────────── */
    const tr = await run({ action: 'trending', leagues: ['nfl'] });
    chk('T the allowlisted NFL feeds, parsed: headline, https link, time, source', tr.b.ok && tr.b.items.length === 1
      && tr.b.items[0].publisher === 'ESPN' && tr.b.items[0].url === 'https://www.espn.com/nfl/story/_/id/1/dak' && tr.b.items[0].published_at === '2026-10-08T15:00:00.000Z', tr.b);
    chk('T a dead feed is reported, not fatal', tr.b.problems.length === 2);
    chk('T only feed hosts and the database were contacted', LOG.every((e) => ['proj.supabase.test', 'www.espn.com', 'www.cbssports.com', 'sports.yahoo.com'].indexOf(e.host) >= 0));
    chk('T every fetch was counted', one(`select calls from content_engine.usage where provider = 'fetch';`) === '3');
    chk('T a feed fetch identifies EdgeDesk', LOG.filter((e) => e.host === 'www.espn.com').every((e) => /EdgeDeskContentEngine/.test(e.headers['user-agent'])));
    const matched = CE.news.match(tr.b.items, snap);
    chk('T the page can match the headline to this week’s slate', matched.length === 1 && matched[0].teams.indexOf('Dallas Cowboys') >= 0 && matched[0].kind === 'injury');

    chk('K across the suite the function called only these doors', [...DOORS].every((d) => /^content_engine_(article|article_save|send_claim|send_result|spend|log|overview|is_owner)$/.test(d) || d === 'growth_outbound_is_owner'), [...DOORS]);
  } catch (e) {
    chk('the suite reached its end — ' + String(e && e.stack || e).slice(0, 600), false);
  } finally {
    db.stop();
    failures.forEach((f) => console.log('  × ' + f));
    console.log((fail ? 'FAIL' : 'PASS') + ' | content engine edge function | ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
  }
})();
