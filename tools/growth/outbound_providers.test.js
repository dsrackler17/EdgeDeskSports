#!/usr/bin/env node
/* ===========================================================================
   PHASE 12 — THE PROVIDERS, through the deployed functions and the REAL SQL
   supabase/functions/growth_outbound_research/index.ts (search, email lookup,
   verification, enrichment) and supabase/functions/growth_outbound_send/
   index.ts (the sending domain's check), against supabase/growth_outbound.sql
   behind a PostgREST stand-in. Brave, Hunter, Apollo, Clay, Claude,
   DNS-over-HTTPS, Resend and the web are mocked; nothing leaves this process.

     S  STATUS    each provider: its key set, its switch; Apollo and Clay off
                  until switched on; never a key in an answer
     D  DISCOVER  every search provider that is on; Apollo's people search
                  gives their organization's own site, never a platform;
                  every provider switched off: refused, said
     F  FIND      Hunter, then Apollo, until one has the address; Apollo only
                  when it marks the address verified, for the same person,
                  never a placeholder; its "verified" is one source; no paid
                  lookup for a partner lead; the segment Claude reads
     V  VERIFY    the waiting addresses put to the verifier, each verdict on
                  the record; the morning run's verify step on a ticket
     E  ENRICH    the enrichment queue posted to Clay's webhook, one row per
                  POST, its token to Clay only, the budget counted, each
                  prospect once in 14 days; a non-Clay address refused
     N  DOMAIN    SPF, DKIM and DMARC read over DNS-over-HTTPS and recorded;
                  a missing record blocks live sending; DNS that did not
                  answer decides nothing; Resend's own word when the key may
                  read it; nothing is sent
     K  KEYS      each key only to its own provider; none in any answer

   Run: node tools/growth/outbound_providers.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { register } = require('node:module');
const { pathToFileURL } = require('node:url');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const { rpcShim, jres } = require(path.join(__dirname, '_rpc_shim.js'));

let pass = 0, fail = 0;
const failures = [];
const chk = (n, c, d) => { if (c) pass++; else { fail++; failures.push(n + (d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 500) : '')); } };

const RFN = path.join(__dirname, '..', '..', 'supabase', 'functions', 'growth_outbound_research', 'index.ts');
const SFN = path.join(__dirname, '..', '..', 'supabase', 'functions', 'growth_outbound_send', 'index.ts');
const db = PG.start('goprov');
if (db.skip) { console.log((process.env.OUTBOUND_PG_REQUIRED ? 'FAIL | ' : 'NOTE | ') + db.skip + ' — skipped'); process.exit(process.env.OUTBOUND_PG_REQUIRED ? 1 : 0); }
register(pathToFileURL(path.join(__dirname, '_stubs', 'hooks.mjs')));

const URL_ = 'https://proj.supabase.test';
const ANON = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.anon';
const OWNER_T = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.sig-owner';
const OWNER = '00000000-0000-0000-0000-0000000000a1';
const KEYS = { brave: 'brave_secret_key_123', hunter: 'hunter_secret_key_456', anthropic: 'sk-ant-secret-789', apollo: 'apollo_secret_key_abc',
  clayToken: 'clay_secret_token_def', resend: 're_Secret12_abcdefghijklmnop' };
const CLAY_URL = 'https://api.clay.com/v3/sources/webhook/pull-in-data-from-a-webhook-0000';
const lit = PG.lit;
const one = (s) => db.sql(s);
const pid = (n) => '50000000-0000-0000-0000-' + String(n).padStart(12, '0');

/* ── the world ─────────────────────────────────────────────────────────── */
let LOG = [], ALL = [];
let WEB = {}, BRAVE, APOLLO_SEARCH, APOLLO_MATCH, HUNTER_DS, HUNTER_V, CLAY, DOH = {}, RESEND_DOMAINS, CLAUDE_REQS = [];
const SHIM = rpcShim(db, { url: URL_, users: { [OWNER_T]: { id: OWNER, email: 'owner@edgedesk.test' } }, override: () => null });
globalThis.fetch = async (input, init) => {
  const url = String(input), u = new URL(url), h = Object.assign({}, (init && init.headers) || {});
  LOG.push({ url, host: u.host, headers: h, method: (init && init.method) || 'GET', body: init && init.body });
  ALL.push({ host: u.host, text: url + ' ' + JSON.stringify(h) + ' ' + String((init && init.body) || '') });
  const viaDb = await SHIM(url, init);
  if (viaDb) return viaDb;
  if (u.host === 'api.search.brave.com') return typeof BRAVE === 'function' ? BRAVE(u) : jres(500, {});
  if (u.host === 'api.apollo.io' && u.pathname === '/api/v1/mixed_people/api_search') return typeof APOLLO_SEARCH === 'function' ? APOLLO_SEARCH(JSON.parse(init.body)) : jres(500, {});
  if (u.host === 'api.apollo.io' && u.pathname === '/api/v1/people/match') return typeof APOLLO_MATCH === 'function' ? APOLLO_MATCH(JSON.parse(init.body)) : jres(500, {});
  if (u.host === 'api.hunter.io' && u.pathname === '/v2/domain-search') return typeof HUNTER_DS === 'function' ? HUNTER_DS(u) : jres(404, {});
  if (u.host === 'api.hunter.io' && u.pathname === '/v2/email-verifier') return typeof HUNTER_V === 'function' ? HUNTER_V(u) : jres(404, {});
  if (u.host === 'api.clay.com') return typeof CLAY === 'function' ? CLAY(h, JSON.parse(init.body)) : jres(500, {});
  if (u.host === 'cloudflare-dns.com' || u.host === 'dns.google') {
    const key = u.searchParams.get('name') + '|' + u.searchParams.get('type');
    const ans = typeof DOH === 'function' ? DOH(key, u.host) : DOH[key];
    if (ans === 'down') return jres(503, {});
    return jres(200, ans || { Status: 3 });
  }
  if (u.host === 'api.resend.com' && u.pathname === '/domains') return typeof RESEND_DOMAINS === 'function' ? RESEND_DOMAINS(h) : jres(500, {});
  if (u.host === 'api.resend.com') return jres(500, { message: 'no email may be sent in this test' });
  if (u.pathname === '/robots.txt') return new Response('', { status: 404 });
  const pg = WEB[u.origin + u.pathname];
  if (!pg) return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
  return new Response(pg, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
};
globalThis.Deno = { env: { get: () => undefined } };

const rcfg = (o) => Object.assign({ url: URL_, anonKey: ANON, braveKey: KEYS.brave, hunterKey: KEYS.hunter, anthropicKey: KEYS.anthropic, apolloKey: KEYS.apollo,
  clayWebhookUrl: CLAY_URL, clayToken: KEYS.clayToken, model: 'claude-opus-5-5', origins: ['https://edgedesksports.com'], fetch: (u, i) => globalThis.fetch(u, i),
  timeoutMs: 3000, fetchTimeoutMs: 3000, resolveDns: async (h, t) => (t === 'A' ? ['93.184.216.34'] : []) }, o || {});
const scfg = (o) => Object.assign({ url: URL_, anonKey: ANON, resendKey: KEYS.resend, origins: ['https://edgedesksports.com'], fetch: (u, i) => globalThis.fetch(u, i), timeoutMs: 3000 }, o || {});
const req = (fn, body, token) => new Request(URL_ + '/functions/v1/' + fn, { method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, token === null ? {} : { authorization: 'Bearer ' + (token || OWNER_T) }), body: JSON.stringify(body) });
const calls = (host, path) => LOG.filter((e) => e.host === host && (!path || new URL(e.url).pathname === path));
const settings = (o) => JSON.parse(db.as(OWNER, `select public.growth_outbound_settings_update(${lit(JSON.stringify(o))}::jsonb);`));
const CLAUDE = (out) => (r) => { CLAUDE_REQS.push(r); return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(Object.assign({ relevant: true, reason: 'a modeler',
  prospect_type: 'cfb_analyst', segment: 'subscriber', sports: ['CFB'], facts: [], fit_factors: [], own_profiles: [] }, out)) }] }; };
const site = (name, org, d) => `<html><head><title>${org}</title></head><body><h1>${org}</h1><p>I am ${name}, and I run ${org}, a college football ratings newsletter.</p></body></html>`;
const facts = (name, org) => [{ field: 'full_name', claim: name, quote: 'I am ' + name, page: 0 }, { field: 'newsletter', claim: org, quote: 'I run ' + org, page: 0 }];

(async () => {
  try {
    ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql', 'growth_outbound.sql']
      .forEach((f) => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f)));
    one(`insert into auth.users (id, email, email_confirmed_at) values ('${OWNER}', 'owner@edgedesk.test', now());
         insert into public.affiliate_admins (user_id) values ('${OWNER}');
         select growth_outbound.grant_owner('owner@edgedesk.test');`);
    settings({ postal_address: 'EdgeDesk Sports, 100 Example St, Springfield, IL 62701', test_inbox: 'owner-test@edgedesk.test' });
    const R = await import(RFN), SND = await import(SFN);
    const run = async (body, cfg, token) => { LOG = []; const r = await R.handle(req('growth_outbound_research', body, token), cfg || rcfg()); let b = null; try { b = await r.json(); } catch (_) { b = null; } return { r, b, raw: JSON.stringify(b) }; };
    const srun = async (body, cfg, token) => { LOG = []; const r = await SND.handle(req('growth_outbound_send', body, token), cfg || scfg()); let b = null; try { b = await r.json(); } catch (_) { b = null; } return { r, b, raw: JSON.stringify(b) }; };

    /* ══ S. STATUS ═══════════════════════════════════════════════════════ */
    let x = await run({ action: 'status' });
    let det = x.b && x.b.providers && x.b.providers.detail;
    chk('S each provider: its key set, and on or off — Brave and Hunter on by default, Apollo and Clay off until switched on', x.r.status === 200 && det
      && det.brave.on && det.hunter.on && det.apollo.configured && !det.apollo.on && !det.apollo_search.on && det.clay.configured && !det.clay.on, det);
    chk('S … never a key in the answer', !Object.values(KEYS).some((k) => x.raw.includes(k)) && !x.raw.includes(CLAY_URL));
    x = await run({ action: 'status' }, rcfg({ clayWebhookUrl: 'https://evil.example.com/hook' }));
    chk('S a Clay address that is not on clay.com is not set up', x.b.providers.detail.clay.configured === false);
    settings({ discovery_config: { providers: { apollo: true, apollo_search: true, clay: true } } });
    x = await run({ action: 'status' });
    det = x.b.providers.detail;
    chk('S switched on, they are on', det.apollo.on && det.apollo_search.on && det.clay.on && x.b.providers.enrichment === true, det);

    /* ══ D. DISCOVER ═════════════════════════════════════════════════════ */
    BRAVE = () => jres(200, { web: { results: [{ url: 'https://braveonly.io/', title: 'Brave Only', description: 'cfb ratings' }] } });
    APOLLO_SEARCH = (b) => jres(200, { people: [
      { name: 'Ana Model', title: 'Founder', organization: { name: 'Ana Ratings', website_url: 'http://anaratings.io' } },
      { name: 'Big Co Person', title: 'Analyst', organization: { name: 'Big', website_url: 'https://www.linkedin.com/company/big' } },
      { name: 'No Site', title: 'Analyst', organization: { name: 'Nowhere' } }] });
    x = await run({ action: 'discover', query: 'college football model newsletter' });
    const apolloCall = calls('api.apollo.io', '/api/v1/mixed_people/api_search')[0];
    chk('D both search providers that are on are asked', x.b.ok === true && calls('api.search.brave.com').length === 1 && !!apolloCall && x.b.queries === 2, x.b);
    chk('D … Apollo is asked with its key in x-api-key, for the query', !!apolloCall && apolloCall.headers['x-api-key'] === KEYS.apollo
      && JSON.parse(apolloCall.body).q_keywords === 'college football model newsletter');
    const cands = JSON.parse(one(`select jsonb_agg(jsonb_build_object('url', url, 'provider', provider, 'snippet', snippet) order by url) from growth_outbound.candidates;`));
    chk('D Apollo gives their organization\'s own site (https), named in the snippet; never a platform page or nothing', cands.some((c) => c.url === 'https://anaratings.io' && c.provider === 'apollo'
      && /Apollo: Ana Model, Founder, Ana Ratings/.test(c.snippet)) && !cands.some((c) => /linkedin/.test(c.url)) && cands.length === 2, cands);
    chk('D … the per-search report names Apollo\'s row', (x.b.per_query || []).some((p) => p.provider === 'apollo' && p.results === 1) && (x.b.per_query || []).some((p) => !p.provider && p.results === 1), x.b.per_query);
    settings({ discovery_config: { providers: { brave: false, apollo_search: false, apollo: true, clay: true } } });
    x = await run({ action: 'discover', query: 'college football model newsletter' });
    chk('D every search provider switched off: refused, said, and the run failed in words', x.r.status === 503 && x.b.reason === 'search_not_configured'
      && /switched off/.test(x.b.detail) && calls('api.search.brave.com').length === 0 && calls('api.apollo.io').length === 0
      && one(`select error from growth_outbound.research_runs where kind = 'discover' order by id desc limit 1;`) === 'every search provider is switched off', x.b);
    settings({ discovery_config: { providers: { apollo: true, apollo_search: true, clay: true } } });
    APOLLO_SEARCH = () => jres(401, {});
    x = await run({ action: 'discover', query: 'nfl model newsletter' });
    chk('D Apollo refusing its key does not stop Brave', x.b.ok === true && (x.b.per_query || []).some((p) => p.provider === 'apollo' && /refused the key/.test(p.error)), x.b);

    /* ══ F. FIND ═════════════════════════════════════════════════════════ */
    // a site with no published address: Hunter has nothing, Apollo has a verified one
    WEB['https://anaratings.io/'] = site('Ana Model', 'Ana Ratings');
    const cand = +one(`select id from growth_outbound.candidates where url = 'https://anaratings.io';`);
    globalThis.__claude = CLAUDE({ facts: facts('Ana Model', 'Ana Ratings') });
    HUNTER_DS = () => jres(200, { data: { emails: [] } });
    APOLLO_MATCH = (b) => jres(200, { person: { first_name: 'Ana', last_name: 'Model', email: 'ana@anaratings.io', email_status: 'verified', linkedin_url: 'http://www.linkedin.com/in/anamodel' } });
    HUNTER_V = () => jres(200, { data: { status: 'valid' } });
    x = await run({ action: 'research', candidate_id: cand });
    const match = calls('api.apollo.io', '/api/v1/people/match')[0];
    chk('F Hunter first (nothing), then Apollo: asked for this person at their domain, with its key, no personal addresses or phones', x.b.ok === true
      && calls('api.hunter.io', '/v2/domain-search').length === 1 && !!match && match.headers['x-api-key'] === KEYS.apollo
      && JSON.stringify(JSON.parse(match.body)) === JSON.stringify({ first_name: 'Ana', last_name: 'Model', reveal_personal_emails: false, reveal_phone_number: false, domain: 'anaratings.io' }), match && match.body);
    const pAna = x.b.prospect_id;
    chk('F Apollo\'s verified address is recorded as Apollo\'s find and Apollo\'s check — one source, collected by provider:apollo', one(`select string_agg(source_kind || ':' || collected_by, ',' order by source_kind)
      from growth_outbound.evidence where prospect_id = ${lit(pAna)} and field_name = 'email' and collected_by = 'provider:apollo';`) === 'provider_found:provider:apollo,provider_verified:provider:apollo');
    chk('F … then Hunter\'s verifier is asked as well, and its "valid" is the second, independent source', x.b.email && x.b.email.address === 'ana@anaratings.io'
      && x.b.email.verdict === 'valid' && /Apollo/.test(x.b.email.from) && calls('api.hunter.io', '/v2/email-verifier').length === 1
      && Number(one(`select email_confidence from growth_outbound.prospects where id = ${lit(pAna)};`)) > 0.9, x.b.email);
    // Apollo only when it says verified, for the same person, never a placeholder
    const tryApollo = async (n, person, label) => {
      WEB['https://p' + n + '.io/'] = site('Bo Test' + n, 'Bo Ratings ' + n);
      one(`insert into growth_outbound.candidates (url, site_key, provider, status) values ('https://p${n}.io', 'p${n}.io', 'brave', 'new');`);
      const c = +one(`select id from growth_outbound.candidates where url = 'https://p${n}.io';`);
      globalThis.__claude = CLAUDE({ facts: facts('Bo Test' + n, 'Bo Ratings ' + n) });
      APOLLO_MATCH = () => jres(200, { person: Object.assign({ first_name: 'Bo', last_name: 'Test' + n }, person) });
      const y = await run({ action: 'research', candidate_id: c });
      chk('F Apollo ' + label + ': nothing recorded, said', y.b.ok === true && !y.b.email && (y.b.notes || []).some((t) => /Apollo/.test(t))
        && +one(`select count(*) from growth_outbound.evidence where prospect_id = ${lit(y.b.prospect_id)} and field_name = 'email';`) === 0, y.b);
    };
    await tryApollo(1, { email: 'bo@p1.io', email_status: 'unverified' }, 'with an unverified address');
    await tryApollo(2, { email: 'bo@p2.io', email_status: 'extrapolated' }, 'with a guessed (extrapolated) address');
    await tryApollo(3, { email: 'email_not_unlocked@domain.com', email_status: 'verified' }, 'with a locked placeholder');
    await tryApollo(4, { first_name: 'Someone', last_name: 'Else', email: 'else@p4.io', email_status: 'verified' }, 'matching somebody else');
    await tryApollo(5, { email: 'info@p5.io', email_status: 'verified' }, 'with a role address');
    // a partner lead: no paid lookup
    WEB['https://bigpod.io/'] = site('Cy Pod', 'Big Pod Network');
    one(`insert into growth_outbound.candidates (url, site_key, provider, status) values ('https://bigpod.io', 'bigpod.io', 'brave', 'new');`);
    globalThis.__claude = CLAUDE({ facts: facts('Cy Pod', 'Big Pod Network'), segment: 'media_partner' });
    APOLLO_MATCH = () => jres(200, { person: { first_name: 'Cy', last_name: 'Pod', email: 'cy@bigpod.io', email_status: 'verified' } });
    x = await run({ action: 'research', candidate_id: +one(`select id from growth_outbound.candidates where url = 'https://bigpod.io';`) });
    chk('F Claude reads a media partner: the new prospect is a media partner lead', x.b.ok === true && one(`select campaign_type from growth_outbound.prospects where id = ${lit(x.b.prospect_id)};`) === 'media_partner');
    chk('F … and no lookup budget is spent on a partner (no Hunter, no Apollo)', calls('api.hunter.io').length === 0 && calls('api.apollo.io').length === 0);
    chk('F Claude is told about segments and the new reasons against', /segment: who they would be to EdgeDesk/.test(CLAUDE_REQS[CLAUDE_REQS.length - 1].system)
      && /sportsbook_or_operator/.test(CLAUDE_REQS[CLAUDE_REQS.length - 1].system)
      && CLAUDE_REQS[CLAUDE_REQS.length - 1].output_config.format.schema.required.includes('segment'));
    // Apollo switched off: never asked
    settings({ discovery_config: { providers: { apollo: false, clay: true } } });
    WEB['https://p9.io/'] = site('Dee Off', 'Off Ratings');
    one(`insert into growth_outbound.candidates (url, site_key, provider, status) values ('https://p9.io', 'p9.io', 'brave', 'new');`);
    globalThis.__claude = CLAUDE({ facts: facts('Dee Off', 'Off Ratings') });
    x = await run({ action: 'research', candidate_id: +one(`select id from growth_outbound.candidates where url = 'https://p9.io';`) });
    chk('F Apollo switched off: never asked, Hunter still is', x.b.ok === true && calls('api.apollo.io').length === 0 && calls('api.hunter.io', '/v2/domain-search').length === 1);

    /* ══ V. VERIFY ═══════════════════════════════════════════════════════ */
    // an address found by Clay (imported), waiting for the verifier
    const pV = pid(1);
    one(`insert into growth_outbound.prospects (id, email, prospect_type, website_url) values (${lit(pV)}, 'eve@everatings.io', 'cfb_analyst', 'https://everatings.io');
         insert into growth_outbound.evidence (prospect_id, field_name, claim, source_url, source_kind, source_excerpt, collected_by) values
           (${lit(pV)}, 'full_name', 'Eve Rate', 'https://everatings.io/about', 'own_site', 'I am Eve Rate', 'owner'),
           (${lit(pV)}, 'email', 'eve@everatings.io', 'https://clay.com', 'provider_found', null, 'provider:clay');
         select growth_outbound.evaluate(${lit(pV)});`);
    HUNTER_V = (u) => jres(200, { data: { status: u.searchParams.get('email') === 'eve@everatings.io' ? 'valid' : 'accept_all' } });
    x = await run({ action: 'verify', limit: 5 });
    chk('V the waiting address is put to Hunter\'s verifier, with its key', x.b.ok === true && x.b.asked >= 1 && x.b.results.some((r) => r.prospect_id === pV && r.verdict === 'valid')
      && calls('api.hunter.io', '/v2/email-verifier').every((c) => new URL(c.url).searchParams.get('api_key') === KEYS.hunter), x.b);
    chk('V … "valid" is recorded as the verifier\'s, and the address is verified', one(`select email_status from growth_outbound.prospects where id = ${lit(pV)};`) === 'verified'
      && +one(`select count(*) from growth_outbound.evidence where prospect_id = ${lit(pV)} and source_kind = 'provider_verified' and collected_by = 'provider:hunter_verifier';`) === 1);
    chk('V … every verdict is on the record, so nobody is asked about twice', +one(`select count(*) from growth_outbound.activity where action = 'email_verdict' and prospect_id = ${lit(pV)};`) === 1
      && (await run({ action: 'verify', limit: 5 })).b.asked === 0);
    x = await run({ action: 'verify', limit: 99 });
    chk('V a limit is 1 to 25', x.r.status === 400);
    x = await run({ action: 'verify' }, rcfg({ hunterKey: '' }));
    chk('V no verifier set up: said, nothing asked', x.r.status === 503 && x.b.reason === 'verifier_not_configured' && calls('api.hunter.io').length === 0);
    // the morning run's verify step, on a ticket
    const pV2 = pid(2);
    one(`insert into growth_outbound.prospects (id, email, prospect_type) values (${lit(pV2)}, 'fay@fayratings.io', 'cfb_analyst');
         insert into growth_outbound.evidence (prospect_id, field_name, claim, source_url, source_kind, source_excerpt, collected_by) values
           (${lit(pV2)}, 'email', 'fay@fayratings.io', 'https://fayratings.io/contact', 'own_site', 'Email fay@fayratings.io', 'owner');
         select growth_outbound.evaluate(${lit(pV2)});`);
    const t = crypto.randomBytes(32).toString('hex');
    const runId = +one(`insert into growth_outbound.research_runs (kind, started_by, input, ticket_sha256, ticket_expires_at)
      values ('research', 'schedule', '{"verify": 5, "scheduled": true}'::jsonb, ${lit(crypto.createHash('sha256').update(t).digest('hex'))}, now() + interval '10 minutes') returning id;`);
    one(`update growth_outbound.settings set automation_enabled = true where id = 1;`);
    x = await run({ action: 'scheduled', ticket: t }, undefined, null);
    chk('V the morning run\'s verify step: no owner token, every call through the ticket door, the address verified', x.b.ok === true && x.b.asked === 1
      && LOG.filter((e) => e.host === 'proj.supabase.test' && /\/rpc\//.test(e.url)).every((e) => /rpc\/growth_outbound_scheduled$/.test(e.url))
      && one(`select status || '|' || (counts->>'asked') from growth_outbound.research_runs where id = ${runId};`) === 'done|1', x.b);
    chk('V … an "accept all" verdict verifies nothing: the address stays unverified, the verdict on the record', one(`select email_status from growth_outbound.prospects where id = ${lit(pV2)};`) === 'unverified'
      && +one(`select count(*) from growth_outbound.evidence where prospect_id = ${lit(pV2)} and source_kind = 'provider_verified';`) === 0
      && one(`select detail->>'status' from growth_outbound.activity where action = 'email_verdict' and prospect_id = ${lit(pV2)};`) === 'accept_all');
    one(`update growth_outbound.settings set automation_enabled = false where id = 1;`);

    /* ══ E. ENRICH ═══════════════════════════════════════════════════════ */
    // a strong subscriber with no address: only the address is missing
    const pE = pid(3);
    const SEED = require(path.join(__dirname, '_outbound_seed.js'));
    one(SEED.strong({ id: pE, name: 'Gil Need', org: 'Need Ratings', email: 'placeholder@needratings.io', domain: 'needratings.io', handle: 'gilneed' }));
    one(`update growth_outbound.evidence set superseded_at = now(), superseded_reason = 'not theirs' where prospect_id = ${lit(pE)} and field_name = 'email';
         select growth_outbound.evaluate(${lit(pE)});`);
    one(`update growth_outbound.prospects set email = null where id = ${lit(pE)};`);
    one(`select growth_outbound.evaluate(${lit(pE)});`);
    settings({ discovery_config: { providers: { clay: true }, budget: { enrichment: 1 } } });
    let posted = [];
    CLAY = (h, body) => { posted.push({ h, body }); return jres(200, { ok: true }); };
    x = await run({ action: 'enrich', limit: 10 });
    const row = posted[0] && posted[0].body;
    chk('E the waiting subscriber is posted to Clay\'s webhook: one row, who and where, with our reference', x.b.ok === true && x.b.pushed === 1 && posted.length === 1
      && row.edgedesk_ref === pE && row.full_name === 'Gil Need' && row.domain === 'needratings.io' && row.source === 'edgedesk' && !('email' in row) && !('qualification_score' in row), x.b);
    chk('E … with the table\'s token in x-clay-webhook-auth, to the Clay address only', posted[0].h['x-clay-webhook-auth'] === KEYS.clayToken
      && LOG.filter((e) => e.host === 'api.clay.com').every((e) => e.url === CLAY_URL));
    chk('E … counted against the enrichment budget, and marked: not again for 14 days', one(`select calls from growth_outbound.provider_usage where provider = 'enrichment';`) === '1'
      && +one(`select count(*) from growth_outbound.activity where action = 'enrichment_pushed' and prospect_id = ${lit(pE)};`) === 1
      && (await run({ action: 'enrich' })).b.pushed === 0);
    x = await run({ action: 'enrich' }, rcfg({ clayWebhookUrl: 'https://attacker.example/hook' }));
    chk('E a webhook address that is not Clay\'s: not set up, nothing posted', x.r.status === 503 && x.b.reason === 'enrichment_not_configured' && calls('attacker.example').length === 0);
    settings({ discovery_config: { providers: { clay: false } } });
    x = await run({ action: 'enrich' });
    chk('E Clay switched off: refused in words, nothing posted', x.r.status === 503 && /switched off/.test(x.b.detail) && calls('api.clay.com').length === 0);

    /* ══ N. THE SENDING DOMAIN ═══════════════════════════════════════════ */
    const TXT = (data) => ({ Status: 0, Answer: [].concat(data).map((d) => ({ type: 16, data: '"' + d + '"' })) });
    const GOOD = {
      'send.edgedesksports.com|TXT': TXT('v=spf1 include:amazonses.com ~all'), 'send.edgedesksports.com|MX': { Status: 0, Answer: [{ type: 15, data: '10 feedback-smtp.us-east-1.amazonses.com.' }] },
      'edgedesksports.com|TXT': TXT('v=spf1 include:_spf.google.com ~all'), 'resend._domainkey.edgedesksports.com|TXT': TXT('p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC7'),
      '_dmarc.edgedesksports.com|TXT': TXT('v=DMARC1; p=none; rua=mailto:dmarc@edgedesksports.com') };
    DOH = GOOD;
    RESEND_DOMAINS = (h) => jres(200, { data: [{ name: 'edgedesksports.com', status: 'verified' }] });
    let s = await srun({ action: 'domain_check' });
    chk('N SPF (Resend\'s return path), DKIM (Resend\'s key) and DMARC are read and found; Resend says verified; recorded', s.r.status === 200 && s.b.ok === true
      && s.b.check.ok === true && s.b.check.spf.ok && s.b.check.dkim.ok && s.b.check.dmarc.ok && s.b.check.dmarc.policy === 'none' && s.b.check.provider.ok === true
      && one(`select domain_auth->>'ok' from growth_outbound.settings where id = 1;`) === 'true', s.b);
    chk('N … p=none is fine to start, and said so', /monitoring only/.test(s.b.check.dmarc.detail));
    chk('N … nothing was sent: no email to Resend, only its domain list', calls('api.resend.com').every((c) => new URL(c.url).pathname === '/domains' && c.method === 'GET')
      && calls('api.resend.com', '/domains')[0].headers.authorization === 'Bearer ' + KEYS.resend && !s.raw.includes(KEYS.resend));
    DOH = Object.assign({}, GOOD, { 'resend._domainkey.edgedesksports.com|TXT': { Status: 3 } });
    s = await srun({ action: 'domain_check' });
    chk('N no DKIM key in DNS: a failure, recorded, and live sending is blocked', s.b.ok === true && s.b.check.ok === false && s.b.check.dkim.ok === false
      && (s.b.live_send_blockers || []).includes('domain_auth_failed'), s.b);
    DOH = (key, host) => (host === 'cloudflare-dns.com' ? 'down' : GOOD[key]);
    s = await srun({ action: 'domain_check' });
    chk('N one resolver down: the other answers', s.b.check && s.b.check.ok === true && !(s.b.live_send_blockers || []).includes('domain_auth_failed'), s.b);
    DOH = () => 'down';
    s = await srun({ action: 'domain_check' });
    chk('N DNS that does not answer decides nothing: "could not tell", no blocker', s.b.check && s.b.check.ok === null && s.b.check.spf.ok === null
      && !(s.b.live_send_blockers || []).includes('domain_auth_failed'), s.b);
    DOH = GOOD;
    RESEND_DOMAINS = () => jres(401, {});
    s = await srun({ action: 'domain_check' });
    chk('N a sending-only Resend key: said, and DNS still decides', s.b.check.ok === true && s.b.check.provider.ok === null && /can send but not read domains/.test(s.b.check.provider.detail));
    s = await srun({ action: 'domain_check' }, undefined, null);
    chk('N owner only: no token, nothing looked up', s.r.status === 401 && calls('cloudflare-dns.com').length === 0);

    /* ══ K. KEYS ═════════════════════════════════════════════════════════ */
    const only = (key, hosts) => { const seen = ALL.filter((e) => e.text.includes(key)); return seen.length > 0 && seen.every((e) => hosts.includes(e.host)); };
    chk('K across every request in this suite, each key went only to its own provider', only(KEYS.apollo, ['api.apollo.io']) && only(KEYS.clayToken, ['api.clay.com'])
      && only(KEYS.hunter, ['api.hunter.io']) && only(KEYS.brave, ['api.search.brave.com']) && only(KEYS.resend, ['api.resend.com'])
      && !ALL.some((e) => e.host === 'api.resend.com' && /\/emails/.test(e.text)));
  } catch (err) {
    chk('the suite ran without an unexpected error', false, String(err && (err.stack || err.message) || err).slice(0, 1500));
  } finally {
    db.stop();
  }
  failures.forEach((f) => console.log('FAIL | ' + f));
  console.log((fail === 0 ? 'PASS' : 'FAIL') + ' — outbound providers (functions + database): ' + pass + '/' + (pass + fail) + ' checks');
  process.exit(fail === 0 ? 0 : 1);
})();
