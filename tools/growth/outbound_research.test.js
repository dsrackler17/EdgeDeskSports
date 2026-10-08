#!/usr/bin/env node
/* ===========================================================================
   THE RESEARCH ENGINE, tested as deployed
   (supabase/functions/growth_outbound_research/index.ts), against the REAL
   database: every door the function calls runs in a throwaway PostgreSQL
   through a small PostgREST stand-in, so each quote the function keeps is
   checked by the actual SQL. Brave, Hunter, Claude (the SDK, mapped to a stub
   by a Node loader hook) and the web pages it reads are mocked.

     A  WHO       only the owner: no token 401, a non-owner 403, only POST;
                  CORS for EdgeDesk only
     S  STATUS    which providers are configured — never a key
     D  DISCOVER  Brave with its key header; results become candidates (not
                  prospects); the saved searches; no searches; no key; Brave
                  refusing; the budget
     R  RESEARCH  one candidate read (home, about; robots.txt once), Claude's
                  facts CHECKED: a made-up quote, a claim outside its quote, a
                  wrong page, a profile not on the page — dropped, never fixed;
                  the rest recorded and accepted by the database; the address
                  from their own page; the verifier's word; not a fit; Claude
                  declining; no Claude at all (structured data only); Hunter
                  finding an address for the named person only; research
                  again for a known prospect; a database refusal retried
                  without the refused item
     F  FETCH     robots.txt obeyed (and an unreachable one keeps it out);
                  https only; no IP literals, private resolutions, odd ports
                  or reserved names; redirects re-checked; size and type caps;
                  the bot names itself
     K  KEYS      each key goes only to its own provider; nothing returned
                  contains one; the database is called as the owner

   Run: node tools/growth/outbound_research.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { register } = require('node:module');
const { pathToFileURL } = require('node:url');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const INLINE = require(path.join(__dirname, 'inline_outbound_auth.js'));
const { rpcShim, jres } = require(path.join(__dirname, '_rpc_shim.js'));
const MORNING = require(path.join(__dirname, '_morning.js'));
const crypto = require('crypto');

let pass = 0, fail = 0;
const failures = [];
const chk = (n, c, d) => { if (c) pass++; else { fail++; failures.push(n + (d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 400) : '')); } };

const FN = path.join(__dirname, '..', '..', 'supabase', 'functions', 'growth_outbound_research', 'index.ts');
const SRC = fs.readFileSync(FN, 'utf8');
chk('A the function carries tools/growth/outbound_auth.js byte for byte', INLINE.drifted().length === 0);
chk('K … and no service-role key anywhere in its source', !/SERVICE_ROLE|service_role/.test(SRC));
chk('K Claude is called through the official SDK', /^import Anthropic from 'npm:@anthropic-ai\/sdk';$/m.test(SRC) && !/api\.anthropic\.com/.test(SRC));

const db = PG.start('goresfn');
// the deploy workflow sets OUTBOUND_PG_REQUIRED: there, no database means no deploy
if (db.skip) { console.log((process.env.OUTBOUND_PG_REQUIRED ? 'FAIL | ' : 'NOTE | ') + db.skip + ' — skipped'); process.exit(process.env.OUTBOUND_PG_REQUIRED ? 1 : 0); }
register(pathToFileURL(path.join(__dirname, '_stubs', 'hooks.mjs')));

const URL_ = 'https://proj.supabase.test';
const ANON = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.anon';
const OWNER_T = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.sig-owner';
const ADMIN_T = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.sig-admin';
const OWNER = '00000000-0000-0000-0000-0000000000a1', ADMIN = '00000000-0000-0000-0000-0000000000a2';
const KEYS = { brave: 'brave_secret_key_123', hunter: 'hunter_secret_key_456', anthropic: 'sk-ant-secret-789' };
const lit = PG.lit;
const one = (s) => db.sql(s);

/* ── the world the function talks to ───────────────────────────────────── */
let LOG = [];       // every request: {url, host, headers}
let WEB = {};       // 'https://host/path' -> {status, type, body, headers}
let ROBOTS = {};    // origin -> {status, body}
let BRAVE, HUNTER_DS, HUNTER_V, CLAUDE_REQS = [], RPC_OVERRIDE = null;
const SHIM = rpcShim(db, { url: URL_, users: { [OWNER_T]: { id: OWNER, email: 'owner@edgedesk.test' }, [ADMIN_T]: { id: ADMIN, email: 'admin@edgedesk.test' } },
  override: () => RPC_OVERRIDE });
globalThis.fetch = async (input, init) => {
  const url = String(input), u = new URL(url), h = Object.assign({}, (init && init.headers) || {});
  LOG.push({ url, host: u.host, headers: h, method: (init && init.method) || 'GET', redirect: init && init.redirect });
  const viaDb = await SHIM(url, init);
  if (viaDb) return viaDb;
  if (u.host === 'api.search.brave.com') return typeof BRAVE === 'function' ? BRAVE(u, h) : jres(500, {});
  if (u.host === 'api.hunter.io') {
    if (u.pathname === '/v2/domain-search') return typeof HUNTER_DS === 'function' ? HUNTER_DS(u) : jres(404, {});
    if (u.pathname === '/v2/email-verifier') return typeof HUNTER_V === 'function' ? HUNTER_V(u) : jres(404, {});
  }
  if (u.pathname === '/robots.txt') {
    const r = ROBOTS[u.origin] || { status: 404, body: '' };
    if (r.throw) throw new TypeError('network');
    return new Response(r.body, { status: r.status, headers: { 'content-type': 'text/plain' } });
  }
  const pg = WEB[u.origin + u.pathname];
  if (!pg) return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
  return new Response(pg.body, { status: pg.status || 200, headers: Object.assign({ 'content-type': pg.type || 'text/html; charset=utf-8' }, pg.headers || {}) });
};
globalThis.Deno = { env: { get: () => undefined } };   /* no serve: the server stays uninstalled */

const DNS = { 'rebind.example.com': ['169.254.169.254'], 'v6local.example.com': ['::1'] };
const cfgOf = (o) => Object.assign({ url: URL_, anonKey: ANON, braveKey: KEYS.brave, hunterKey: KEYS.hunter, anthropicKey: KEYS.anthropic,
  model: 'claude-opus-5-5', origins: ['https://edgedesksports.com'], fetch: (u, i) => globalThis.fetch(u, i), timeoutMs: 3000, fetchTimeoutMs: 3000,
  resolveDns: async (host, type) => (DNS[host] || (type === 'A' ? ['93.184.216.34'] : [])).filter((ip) => (type === 'A') === !ip.includes(':')) }, o || {});
const post = (body, o) => new Request(URL_ + '/functions/v1/growth_outbound_research', { method: (o && o.method) || 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, o && o.token === null ? {} : { authorization: 'Bearer ' + ((o && o.token) || OWNER_T) }, o && o.origin ? { origin: o.origin } : {}),
  body: o && (o.method === 'GET' || o.method === 'OPTIONS') ? undefined : JSON.stringify(body) });

/* ── a sports analyst's corner of the web ──────────────────────────────── */
const HOME = `<!doctype html><html><head><title>CFB Numbers — Pat Analyst</title>
<meta name="description" content="College football power ratings against the market">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Person","name":"Pat Analyst","jobTitle":"Founder","worksFor":{"@type":"Organization","name":"CFB Numbers"},"sameAs":["https://x.com/patanalyst"]}</script>
<style>.x{color:red}</style><script>window.tracker=1</script></head>
<body><header><a href="/about">About</a> <a href="/contact">Contact</a></header>
<h1>CFB Numbers</h1><p>Pat Analyst runs CFB Numbers, a college football ratings newsletter with 12,500 subscribers.</p>
<p>Our model prices every game against the closing line &amp; tracks CLV.</p>
<script>var secretTracker = 2;</script><style>.y{content:'hiddenStyle'}</style>
<!-- Pat is the GOAT -->
<footer><a href="https://x.com/patanalyst" rel="me">Twitter</a> <a href="https://x.com/share?u=1">Share</a>
<a href="mailto:Pat@CFBNumbers.io">Email Pat</a> <a href="mailto:noreply@cfbnumbers.io">x</a></footer></body></html>`;
const ABOUT = `<html><head><title>About — CFB Numbers</title></head><body><main><h2>About</h2>
<p>I am Pat Analyst, founder of CFB Numbers. I publish CFB power ratings against the market every week.</p></main></body></html>`;
const NOEMAIL = `<html><head><title>Lee Lab</title></head><body><p>Lee Live builds NFL win total models at Lee Lab.</p><a href="/about">About</a>
<a href="mailto:privacy@leelab.net">Privacy requests</a></body></html>`;
const SITES = () => ({
  'https://cfbnumbers.io/': { body: HOME }, 'https://cfbnumbers.io/about': { body: ABOUT }, 'https://cfbnumbers.io/contact': { body: '<p>Write to Pat.</p>' },
  'https://leelab.net/': { body: NOEMAIL }, 'https://leelab.net/about': { body: '<p>About Lee Live. Lee Live runs Lee Lab.</p>' },
  'https://touts.org/': { body: '<p>GUARANTEED LOCKS! Buy our VIP picks now. 100% winners.</p>' },
});
const CLAUDE_OK = (facts, extra) => (req) => { CLAUDE_REQS.push(req); return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(Object.assign({
  relevant: true, reason: 'a CFB modeler', prospect_type: 'cfb_analyst', sports: ['CFB'], facts, fit_factors: [], own_profiles: [] }, extra || {})) }] }; };
const BRAVE_OK = (results) => (u) => jres(200, { type: 'search', web: { results } });
const fnCalls = (re) => LOG.filter((e) => e.host === 'proj.supabase.test' && re.test(e.url));
const webCalls = (host) => LOG.filter((e) => e.host === host);

(async () => {
  try {
    ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql', 'growth_outbound.sql']
      .forEach((f) => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f)));
    one(`insert into auth.users (id, email, email_confirmed_at) values ('${OWNER}', 'owner@edgedesk.test', now()), ('${ADMIN}', 'admin@edgedesk.test', now());
         insert into public.affiliate_admins (user_id) values ('${OWNER}'), ('${ADMIN}');
         select growth_outbound.grant_owner('owner@edgedesk.test');`);
    const M = await import(FN);
    const run = async (body, cfg, o) => { LOG = []; const r = await M.handle(post(body, o), cfg === undefined ? cfgOf() : cfg); let b = null; try { b = await r.json(); } catch (_) { b = null; } return { r, b, raw: JSON.stringify(b) }; };

    /* ══ A. WHO ═════════════════════════════════════════════════════════ */
    let x = await run({ action: 'status' }, undefined, { token: null });
    chk('A no token → 401, nothing else asked', x.r.status === 401 && fnCalls(/rpc\/growth_outbound_research/).length === 0);
    x = await run({ action: 'status' }, undefined, { token: ADMIN_T });
    chk('A an affiliate admin who is not an owner → 403', x.r.status === 403 && x.b.reason === 'not_an_owner', x.b);
    x = await run(null, undefined, { method: 'GET' });
    chk('A only POST', x.r.status === 405);
    x = await run(null, undefined, { method: 'OPTIONS', origin: 'https://edgedesksports.com', token: null });
    chk('A the preflight answers EdgeDesk only', x.r.status === 204 && x.r.headers.get('access-control-allow-origin') === 'https://edgedesksports.com');
    x = await run({ action: 'dance' });
    chk('A an unknown action → 400', x.r.status === 400 && x.b.reason === 'bad_request');

    /* ══ S. STATUS ══════════════════════════════════════════════════════ */
    x = await run({ action: 'status' });
    chk('S status: which providers are configured, and the database overview', x.r.status === 200 && x.b.providers.search === true && x.b.providers.email === true
      && x.b.providers.llm === true && x.b.providers.model === 'claude-opus-5-5' && x.b.overview.budget.search.cap === 20, x.b);
    chk('K … and never a key', !Object.values(KEYS).some((k) => x.raw.includes(k)));
    x = await run({ action: 'status' }, cfgOf({ braveKey: '', hunterKey: '', anthropicKey: '' }));
    chk('S unset keys are said to be unset', x.b.providers.search === false && x.b.providers.email === false && x.b.providers.llm === false);

    /* ══ D. DISCOVER ════════════════════════════════════════════════════ */
    x = await run({ action: 'discover', query: 'cfb models' }, cfgOf({ braveKey: '' }));
    chk('D no Brave key: said, and no run begun', x.r.status === 503 && x.b.reason === 'search_not_configured' && fnCalls(/research_begin/).length === 0);
    BRAVE = BRAVE_OK([{ url: 'https://cfbnumbers.io/?utm_source=brave', title: '<strong>CFB</strong> Numbers', description: 'Ratings by <strong>Pat</strong>' },
      { url: 'https://leelab.net/', title: 'Lee Lab', description: 'NFL win totals' }, { url: 'https://touts.org/', title: 'Locks', description: 'VIP' },
      { url: 'javascript:alert(1)', title: 'x' }]);
    x = await run({ action: 'discover', query: 'college football betting models' });
    const bq = webCalls('api.search.brave.com')[0];
    chk('D Brave is asked with its key in its header and the query', !!bq && bq.headers['x-subscription-token'] === KEYS.brave && /q=college%20football%20betting%20models/.test(bq.url), bq);
    chk('D what it finds becomes CANDIDATES — nobody becomes a prospect by being found', x.b.ok === true && x.b.new === 3 && x.b.invalid === 1
      && one(`select count(*) from growth_outbound.candidates;`) === '3' && one(`select count(*) from growth_outbound.prospects;`) === '0', x.b);
    chk('D … with the search that found them, and the markup stripped from titles', one(`select title || '|' || query from growth_outbound.candidates where url = 'https://cfbnumbers.io';`)
      === 'CFB Numbers|college football betting models');
    chk('D the run is recorded, done, with what it spent', one(`select status || '|' || (counts->'spent'->>'search') || '|' || (counts->>'new') from growth_outbound.research_runs where id = ${x.b.run_id};`) === 'done|1|3');
    x = await run({ action: 'discover' });
    chk('D with no search given and none saved: said, and the run marked failed', x.r.status === 400 && x.b.reason === 'no_queries'
      && one(`select status from growth_outbound.research_runs order by id desc limit 1;`) === 'failed', x.b);
    one(`update growth_outbound.settings set discovery_config = '{"queries": ["cfb power ratings substack", "nfl totals model newsletter"]}' where id = 1;`);
    x = await run({ action: 'discover' });
    chk('D with none given, the saved searches are run, each counted', x.b.ok === true && x.b.queries === 2 && webCalls('api.search.brave.com').length === 2
      && x.b.seen_again >= 3, x.b);
    BRAVE = () => jres(401, { error: 'bad key' });
    x = await run({ action: 'discover', query: 'cfb models' });
    chk('D Brave refusing the key: the run fails and says so', x.b.ok === false && x.b.reason === 'search_failed' && /refused the key/.test(x.b.per_query[0].error), x.b);
    one(`update growth_outbound.settings set discovery_config = '{"budget": {"search": 0}}' where id = 1;`);
    BRAVE = BRAVE_OK([]);
    x = await run({ action: 'discover', query: 'cfb models' });
    chk('D with the search budget spent, Brave is not called at all', webCalls('api.search.brave.com').length === 0 && x.b.notes.some((n) => /search budget reached/.test(n)), x.b);
    one(`update growth_outbound.settings set discovery_config = '{}' where id = 1;`);

    /* ══ R. RESEARCH ════════════════════════════════════════════════════ */
    WEB = SITES();
    ROBOTS = { 'https://cfbnumbers.io': { status: 200, body: 'User-agent: *\nDisallow: /private\n\nUser-agent: GPTBot\nDisallow: /' } };
    const CID_PAT = +one(`select id from growth_outbound.candidates where url = 'https://cfbnumbers.io';`);
    const PAT_FACTS = [
      { field: 'full_name', claim: 'Pat Analyst', quote: 'I am Pat Analyst, founder of CFB Numbers', page: 1 },
      { field: 'organization', claim: 'CFB Numbers', quote: 'I am Pat Analyst, founder of CFB Numbers', page: 1 },
      { field: 'project', claim: 'CFB power ratings against the market', quote: 'I publish CFB power ratings against the market every week', page: 1 },
      { field: 'audience_size', claim: '12,500', quote: 'a college football ratings newsletter with 12,500 subscribers', page: 0 },
      { field: 'fit_signal', claim: 'prices games against the closing line', quote: 'Our model prices every game against the closing line & tracks CLV', page: 0 },
      // what must be dropped:
      { field: 'job_title', claim: 'Head of Data Science', quote: 'Pat Analyst is Head of Data Science at ESPN', page: 0 },   // made up
      { field: 'organization', claim: 'CFB Numbers LLC', quote: 'founder of CFB Numbers', page: 1 },                         // claim outside the quote
      { field: 'project', claim: 'CFB power ratings', quote: 'I publish CFB power ratings against the market', page: 7 },   // no such page
      { field: 'full_name', claim: 'Pat', quote: 'Pat Analys', page: 1 }];                                                 // cuts a word
    __claude_reset();
    globalThis.__claude = CLAUDE_OK(PAT_FACTS, { fit_factors: [{ code: 'publishes_models', facts: [4] }, { code: 'covers_cfb', facts: [2] }, { code: 'quant_analysis', facts: [5] }],
      own_profiles: ['https://x.com/patanalyst', 'https://x.com/someoneelse'] });
    HUNTER_V = (u) => jres(200, { data: { status: 'valid', email: u.searchParams.get('email') } });
    x = await run({ action: 'research', candidate_id: CID_PAT });
    chk('R a candidate is researched into a prospect', x.b.ok === true && x.b.outcome === 'created' && !!x.b.prospect_id, x.b);
    const PID = x.b.prospect_id;
    const evs = JSON.parse(one(`select coalesce(jsonb_agg(jsonb_build_object('f', field_name, 'c', claim, 'k', source_kind, 'by', collected_by, 'pg', page_id) order by id), '[]') from growth_outbound.evidence where prospect_id = '${PID}';`));
    chk('R every made-up or unsupported fact was dropped, and said why', x.b.dropped.length === 4
      && ['quote not on the page', 'claim not in the quote'].every((w) => x.b.dropped.some((d) => d.why === w)), x.b.dropped);
    chk('R … none of them reached the database', !evs.some((e) => /Head of Data|LLC/.test(e.c)) && !evs.some((e) => e.f === 'job_title' && e.c !== 'Founder'), evs);
    chk('R what was checked is recorded, each fact citing its stored page', evs.filter((e) => e.by === 'research_engine').every((e) => e.pg > 0)
      && ['full_name', 'organization', 'project', 'audience_size', 'fit_signal', 'email'].every((f) => evs.some((e) => e.f === f)), evs.map((e) => e.f));
    chk('R the database judged their site their OWN (the function never says so)', evs.filter((e) => e.by === 'research_engine').every((e) => e.k === 'own_site'), evs.map((e) => e.k));
    chk('R the structured data agreed with the pages (one name, from both)', evs.filter((e) => e.f === 'full_name').length === 2);
    chk('R the address on their own page was used — not noreply@, lower-cased', evs.some((e) => e.f === 'email' && e.c === 'pat@cfbnumbers.io' && e.by === 'research_engine')
      && x.b.email.address === 'pat@cfbnumbers.io' && !evs.some((e) => /noreply/.test(e.c)), x.b.email);
    chk('R … then verified, as the verifier, recorded as its own source', x.b.email.verdict === 'valid' && evs.some((e) => e.f === 'email' && e.k === 'provider_verified' && e.by === 'provider:hunter_verifier'));
    chk('R their own profile (rel=me, and on the page) is theirs; one not on the page is not',
      one(`select string_agg(value, ',' order by value) from growth_outbound.identifiers where prospect_id = '${PID}' and kind = 'handle';`) === 'x:patanalyst');
    chk('R a fit reason stands only on a kept fact (the one citing a dropped fact went)', one(`select string_agg(x->>'code', ',' order by x->>'code') from growth_outbound.prospects p, jsonb_array_elements(p.fit_factors) x where p.id = '${PID}';`)
      === 'covers_cfb,publishes_models');
    chk('R the candidate is researched, linked to them', one(`select status || '|' || prospect_id from growth_outbound.candidates where id = ${CID_PAT};`) === 'researched|' + PID);
    chk('R pages read: home, then about and contact from its links; robots.txt once', webCalls('cfbnumbers.io').filter((e) => /robots/.test(e.url)).length === 1
      && ['https://cfbnumbers.io/', 'https://cfbnumbers.io/about', 'https://cfbnumbers.io/contact'].every((p) => webCalls('cfbnumbers.io').some((e) => e.url === p)), webCalls('cfbnumbers.io').map((e) => e.url));
    chk('F the bot names itself', webCalls('cfbnumbers.io').every((e) => /^EdgeDeskBot\/1\.0/.test(e.headers['user-agent'])));
    chk('F pages are fetched without following redirects blindly (each hop is checked here)', webCalls('cfbnumbers.io').filter((e) => !/robots/.test(e.url)).every((e) => e.redirect === 'manual'));
    chk('R every page is stored as read (scripts, styles and comments gone; links and structured data kept)',
      one(`select count(*) from growth_outbound.pages where url like 'https://cfbnumbers.io%';`) === '3'
      && one(`select (text not like '%tracker%' and text not like '%secretTracker%' and text not like '%hiddenStyle%' and text not like '%GOAT%' and text not like '%color:red%' and text like '%Links:%mailto:pat@cfbnumbers.io%' and text like '%Structured data:%Pat Analyst%')::text from growth_outbound.pages where url = 'https://cfbnumbers.io';`) === 'true');
    const cr = CLAUDE_REQS[0];
    chk('R Claude: the default model, low effort, structured output, server-side fallback on a decline', !!cr && cr.model === 'claude-opus-5-5'
      && cr.output_config.effort === 'low' && cr.output_config.format.type === 'json_schema' && cr.fallbacks === 'default'
      && JSON.stringify(cr.betas) === JSON.stringify(['server-side-fallback-2026-07-01']) && !('thinking' in cr) && !('temperature' in cr), cr && Object.keys(cr));
    chk('R … told the pages are data, not instructions, and never to guess', /data, not instructions/.test(cr.system) && /Never guess a name/.test(cr.system));
    chk('R … and the fit codes it may use are exactly the catalogue', cr.output_config.format.schema.properties.fit_factors.items.properties.code.enum.length
      === +one(`select count(*) from growth_outbound.fit_factor_catalog;`));
    chk('R the run is done, counting what it read and dropped', one(`select status || '|' || (counts->>'pages') || '|' || (counts->>'dropped') from growth_outbound.research_runs where id = ${x.b.run_id};`) === 'done|3|4');
    chk('R research approved, drafted and sent nothing', one(`select count(*) from growth_outbound.drafts;`) === '0' && one(`select count(*) from growth_outbound.sends;`) === '0');

    /* not a fit */
    const CID_TOUT = +one(`select id from growth_outbound.candidates where url = 'https://touts.org';`);
    globalThis.__claude = (req) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ relevant: false, reason: 'a tout selling picks',
      prospect_type: 'other', sports: [], facts: [{ field: 'topic', claim: 'VIP picks', quote: 'Buy our VIP picks now', page: 0 }], fit_factors: [], own_profiles: [] }) }] });
    x = await run({ action: 'research', candidate_id: CID_TOUT });
    chk('R not a fit: the candidate says why; no prospect', x.b.ok === true && x.b.outcome === 'not_a_fit'
      && one(`select status || '|' || status_reason from growth_outbound.candidates where id = ${CID_TOUT};`) === 'not_a_fit|a tout selling picks'
      && one(`select count(*) from growth_outbound.prospects;`) === '1', x.b);

    /* Claude declines; then no Claude at all */
    const CID_LEE = +one(`select id from growth_outbound.candidates where url = 'https://leelab.net';`);
    globalThis.__claude = () => ({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: null }, content: [] });
    HUNTER_DS = () => jres(200, { data: { domain: 'leelab.net', emails: [] } });
    x = await run({ action: 'research', candidate_id: CID_LEE });
    chk('R Claude declining: nothing it said is used, and nothing else on the pages could be quoted — the candidate says so', x.b.ok === false
      && x.b.reason === 'nothing_verifiable' && x.b.llm === 'Claude declined' && /nothing on the pages could be quoted/.test(one(`select status_reason from growth_outbound.candidates where id = ${CID_LEE};`)), x.b);
    db.as(OWNER, `select public.growth_outbound_candidate_set(${CID_LEE}, 'new', null);`);
    WEB['https://leelab.net/'] = { body: NOEMAIL.replace('</body>', '<script type="application/ld+json">{"@type":"Person","name":"Lee Live","jobTitle":"Modeler"}</script></body>') };
    CLAUDE_REQS = [];
    x = await run({ action: 'research', candidate_id: CID_LEE }, cfgOf({ anthropicKey: '' }));
    chk('R with no Claude key, only the structured data and published facts are read — and Claude is never called', x.b.ok === true && CLAUDE_REQS.length === 0
      && x.b.llm === 'ANTHROPIC_API_KEY is not set', x.b);
    const LEE = x.b.prospect_id;
    chk('R … the structured data, quoted from the stored page', one(`select string_agg(field_name || '=' || claim, ',' order by field_name) from growth_outbound.evidence where prospect_id = '${LEE}';`)
      === 'full_name=Lee Live,job_title=Modeler');

    /* Hunter: an address only for the named person */
    HUNTER_DS = (u) => jres(200, { data: { domain: u.searchParams.get('domain'), emails: [
      { value: 'info@leelab.net', first_name: null, last_name: null, sources: [] },
      { value: 'sam@leelab.net', first_name: 'Sam', last_name: 'Other', sources: [{ uri: 'https://leelab.net/team' }] },
      { value: 'lee@leelab.net', first_name: 'Lee', last_name: 'Live', confidence: 94, sources: [{ uri: 'https://leelab.net/about', extracted_on: '2026-09-01' }] }] } });
    HUNTER_V = () => jres(200, { data: { status: 'accept_all' } });
    x = await run({ action: 'research', prospect_id: LEE }, cfgOf({ anthropicKey: '' }));
    const hd = webCalls('api.hunter.io').find((e) => /domain-search/.test(e.url));
    chk('R research again for a known prospect adds to them — no new prospect', x.b.ok === true && x.b.outcome === 'added' && x.b.prospect_id === LEE
      && one(`select count(*) from growth_outbound.prospects;`) === '2', x.b);
    chk('R Hunter is asked about their domain, with the key', !!hd && new URL(hd.url).searchParams.get('domain') === 'leelab.net' && new URL(hd.url).searchParams.get('api_key') === KEYS.hunter);
    chk('R … and only the named person\'s address is taken (not info@, not a colleague), as the provider\'s find with its source page',
      one(`select string_agg(claim || '|' || source_kind || '|' || collected_by || '|' || source_url, ',') from growth_outbound.evidence where prospect_id = '${LEE}' and field_name = 'email';`)
      === 'lee@leelab.net|provider_found|provider:hunter|https://leelab.net/about', x.b.email);
    chk('R a verifier\'s "accept all" verifies nothing: a provider\'s find alone stays risky', x.b.email.verdict === 'accept_all'
      && one(`select email_status from growth_outbound.prospects where id = '${LEE}';`) === 'risky');

    /* the database refusing one item: retried without it */
    WEB = SITES();
    const CID_X = +JSON.parse(db.as(OWNER, `select public.growth_outbound_research_begin('discover', '{}');`)).run_id;
    db.as(OWNER, `select public.growth_outbound_candidates_record(${CID_X}, '[{"url": "https://cfbnumbers.io/contact", "provider": "brave"}]');`);
    const CID_C = +one(`select id from growth_outbound.candidates where url = 'https://cfbnumbers.io/contact';`);
    globalThis.__claude = CLAUDE_OK([{ field: 'topic', claim: 'Pat', quote: 'Write to Pat', page: 0 }, { field: 'topic', claim: 'Write', quote: 'Write to Pat', page: 0 }]);
    let refusedOnce = false;
    RPC_OVERRIDE = (fn) => {
      if (fn === 'growth_outbound_research_ingest' && !refusedOnce) { refusedOnce = true; return jres(200, { ok: false, reason: 'invalid', at: 'evidence 1', detail: 'engine_quote_not_on_page' }); }
      return null;
    };
    x = await run({ action: 'research', candidate_id: CID_C });
    RPC_OVERRIDE = null;
    chk('R an item the database refuses is dropped and the rest recorded (the refusal said which)', x.b.ok === true && fnCalls(/research_ingest/).length >= 2
      && x.b.dropped.some((d) => /the database refused it/.test(d.why)), x.b);

    /* ══ F. FETCH ═══════════════════════════════════════════════════════ */
    const ctxFor = async () => {
      one(`update growth_outbound.research_runs set status = 'done', finished_at = now() where status = 'running';`);
      const b = JSON.parse(db.as(OWNER, `select public.growth_outbound_research_begin('research', '{}');`));
      return { c: cfgOf(), authz: 'Bearer ' + OWNER_T, run: b.run_id, spent: {}, notes: [], started: Date.now(), robots: new Map(), shared: new Set() };
    };
    let cx = await ctxFor();
    for (const [url, why] of [['http://cfbnumbers.io/', /not https/], ['https://127.0.0.1/', /host not allowed/], ['https://[::1]/', /host not allowed/],
      ['https://cfbnumbers.io:8443/', /unusual port/], ['https://user:pw@cfbnumbers.io/', /credentials/], ['https://localhost/', /host not allowed/],
      ['https://printer.local/', /host not allowed/], ['https://db.internal/', /host not allowed/], ['https://rebind.example.com/', /private address/],
      ['https://v6local.example.com/', /private address/], ['https://abc.supabase.co/', /host not allowed/], ['ftp://cfbnumbers.io/', /not https/]]) {
      LOG = [];
      const f = await M.fetchPage(cx, url);
      chk('F refused before any request: ' + url, f.ok === false && why.test(f.why) && LOG.filter((e) => e.host !== 'proj.supabase.test').length === 0, f);
    }
    WEB = { 'https://hop.io/': { status: 301, body: '', headers: { location: 'http://hop.io/insecure' } },
            'https://hop2.io/': { status: 302, body: '', headers: { location: 'https://169.254.169.254/latest/meta-data' } },
            'https://big.io/': { body: 'x'.repeat(1_600_000) }, 'https://img.io/': { body: 'PNG', type: 'image/png' },
            'https://ok.io/': { status: 301, body: '', headers: { location: '/home' } }, 'https://ok.io/home': { body: '<p>Home</p>' } };
    for (const [url, why] of [['https://hop.io/', /not https/], ['https://hop2.io/', /host not allowed/], ['https://big.io/', /larger than 1.5 MB/], ['https://img.io/', /not a web page \(image\/png\)/]]) {
      const f = await M.fetchPage(cx, url);
      chk('F refused: ' + url + ' (' + why + ')', f.ok === false && why.test(f.why), f);
    }
    let f = await M.fetchPage(cx, 'https://ok.io/');
    chk('F a redirect is followed only after the new address is checked again', f.ok === true && f.url === 'https://ok.io/home');
    ROBOTS = { 'https://shy.io': { status: 200, body: 'User-agent: EdgeDeskBot\nDisallow: /\n\nUser-agent: *\nAllow: /' },
               'https://down.io': { status: 503, body: '' }, 'https://gone.io': { status: 404, body: '' }, 'https://open.io': { status: 200, body: 'User-agent: *\nDisallow: /private\nAllow: /private/ok' } };
    WEB = { 'https://shy.io/': { body: '<p>x</p>' }, 'https://down.io/': { body: '<p>x</p>' }, 'https://gone.io/': { body: '<p>x</p>' },
            'https://open.io/private/ok': { body: '<p>x</p>' }, 'https://open.io/private/no': { body: '<p>x</p>' } };
    cx = await ctxFor();
    f = await M.fetchPage(cx, 'https://shy.io/');
    chk('F robots.txt naming this bot is obeyed (even when * is allowed)', f.ok === false && /robots\.txt disallows/.test(f.why), f);
    f = await M.fetchPage(cx, 'https://down.io/');
    chk('F an unreachable robots.txt keeps the engine out (RFC 9309)', f.ok === false && /robots\.txt unavailable/.test(f.why), f);
    chk('F no robots.txt: allowed', (await M.fetchPage(cx, 'https://gone.io/')).ok === true);
    chk('F the longest rule wins; Allow on a tie', (await M.fetchPage(cx, 'https://open.io/private/ok')).ok === true && (await M.fetchPage(cx, 'https://open.io/private/no')).ok === false);
    chk('F robots.txt is read once per site', LOG.filter((e) => e.url === 'https://open.io/robots.txt').length <= 1);
    chk('F robots rules: unit cases', M.robotsAllows('User-agent: *\nDisallow: /', '/x') === false && M.robotsAllows('', '/x') === true
      && M.robotsAllows('User-agent: other\nDisallow: /', '/x') === true && M.robotsAllows('User-agent: *\nDisallow: /*.pdf$', '/a.pdf') === false
      && M.robotsAllows('User-agent: *\nDisallow: /*.pdf$', '/a.pdf.html') === true);
    one(`update growth_outbound.settings set discovery_config = '{"budget": {"fetch": 0}}' where id = 1;`);
    cx = await ctxFor();
    LOG = [];
    f = await M.fetchPage(cx, 'https://gone.io/');
    chk('F with the fetch budget spent, nothing is fetched', f.ok === false && LOG.filter((e) => e.host === 'gone.io').length === 0, f);
    one(`update growth_outbound.settings set discovery_config = '{"budget": {"fetch": 1}}' where id = 1;`);
    one(`delete from growth_outbound.provider_usage where provider = 'fetch';`);
    cx = await ctxFor();
    LOG = [];
    f = await M.fetchPage(cx, 'https://gone.io/');
    chk('F every page read is counted: with room for robots.txt only, the page itself is not fetched', f.ok === false && /fetch budget reached/.test(f.why)
      && LOG.filter((e) => e.host === 'gone.io' && !/robots/.test(e.url)).length === 0, f);
    one(`update growth_outbound.settings set discovery_config = '{}' where id = 1;`);

    /* the pure pieces */
    chk('F private and reserved addresses', ['10.0.0.1', '172.16.5.4', '192.168.1.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']
      .every(M.isPrivateIp) && !['93.184.216.34', '8.8.8.8', '2606:4700::1111'].some(M.isPrivateIp));
    chk('R the quote rules match the database\'s', M.quoteIn('runs CFB numbers', 'Pat  runs CFB Numbers, since 2019.') && !M.quoteIn('Pat Analys', 'Pat Analyst')
      && M.verifyFact({ field: 'email', claim: 'pat@x.io', quote: 'mail pat@x.io now' }, 'mail pat@x.io now') === null
      && M.verifyFact({ field: 'organization', claim: 'x.io', quote: 'x.io' }, 'x.io') === 'a domain is not an organization'
      && M.verifyFact({ field: 'full_name', claim: 'pat@x.io', quote: 'pat@x.io' }, 'pat@x.io') === 'not a name');
    const pg = M.htmlToPage('<p>A &amp; B &#8212; C&nbsp;D</p><a href="mailto:%E0%A4%A">bad</a><a href="/x">X</a>', 'https://s.io/a');
    chk('F entities decoded; a malformed mailto ignored; links made absolute', /A & B — C D/.test(pg.visible) && pg.links.length === 1 && pg.links[0].href === 'https://s.io/x', pg.links);
    const longLine = 'x'.repeat(10) + ' ' + '{"@type":"Person","name":"Lee Live","jobTitle":"Modeler"}'.repeat(10);
    const win = M.excerptAround(longLine, 'Lee Live');
    chk('R a quote window from a long line is cut where words end, so it is still a quote', win.length < 400 && win.includes('Lee Live') && M.quoteIn(win, longLine), win);

    /* ══ M. THE MORNING RUN (Phase 9): a ticket, no owner ═════════════ */
    MORNING.install(db);
    one(`update growth_outbound.research_runs set status = 'done', finished_at = now() where status = 'running';
         update growth_outbound.settings set discovery_config = '{"queries": ["cfb ratings room"]}', daily_prospect_target = 1 where id = 1;`);
    BRAVE = BRAVE_OK([{ url: 'https://ratingsroom.net/', title: 'Ratings Room', description: 'CFB ratings' }]);
    let m = MORNING.tick(db);
    chk('M the morning starts with the saved searches, posted to this function with a ticket', m.r.kind === 'discover' && m.fn === 'growth_outbound_research'
      && /^[0-9a-f]{64}$/.test(m.ticket), m.r);
    x = await run({ action: 'scheduled', ticket: m.ticket }, undefined, { token: null });
    chk('M the function runs it with NO owner token: the saved search, its candidate recorded', x.r.status === 200 && x.b.ok === true && x.b.queries === 1 && x.b.new === 1, x.b);
    chk('M … nobody was asked who the caller is: the ticket is the credential, checked by the database', fnCalls(/auth\/v1\/user/).length === 0);
    chk('M … every database call went through the ticket door, as anon', fnCalls(/rest\/v1\/rpc/).length >= 3
      && fnCalls(/rest\/v1\/rpc/).every((e) => /rpc\/growth_outbound_scheduled$/.test(e.url) && e.headers.authorization === 'Bearer ' + ANON && e.headers.apikey === ANON));
    chk('M … the run is done, and it is the scheduler\'s', one(`select status || '|' || started_by from growth_outbound.research_runs where id = ${m.r.run_id};`) === 'done|schedule');
    x = await run({ action: 'scheduled', ticket: m.ticket }, undefined, { token: null });
    chk('M the same ticket again: refused (its run is over)', x.r.status === 401 && x.b.reason === 'invalid_ticket', x.b);
    WEB['https://ratingsroom.net/'] = { body: '<html><head><title>Ratings Room</title></head><body><p>Sam Room sells betting picks.</p></body></html>' };
    globalThis.__claude = () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ relevant: false, reason: 'sells picks',
      prospect_type: 'other', sports: [], facts: [], fit_factors: [], own_profiles: [] }) }] });
    m = MORNING.tick(db);
    chk('M next, the next new candidate', m.r.kind === 'research' && m.fn === 'growth_outbound_research', m.r);
    x = await run({ action: 'scheduled', ticket: m.ticket }, undefined, { token: null });
    chk('M … read on the ticket: the page stored for that run, the candidate marked', x.b.ok === true && x.b.outcome === 'not_a_fit'
      && one(`select count(*) from growth_outbound.pages where run_id = ${m.r.run_id};`) !== '0'
      && one(`select status from growth_outbound.candidates where url = 'https://ratingsroom.net';`) === 'not_a_fit', x.b);
    m = MORNING.tick(db);
    chk('M … and the day\'s research target (1) is met: no more research today', m.r.kind !== 'research', m.r);
    one(`update growth_outbound.research_runs set status = 'done', finished_at = now() where status = 'running';`);
    const T9 = crypto.randomBytes(32).toString('hex');
    one(`insert into growth_outbound.research_runs (kind, started_by, input, ticket_sha256, ticket_expires_at)
         values ('draft', 'schedule', '{"next": 1}', ${lit(crypto.createHash('sha256').update(T9).digest('hex'))}, now() + interval '10 minutes');`);
    x = await run({ action: 'scheduled', ticket: T9 }, undefined, { token: null });
    chk('M a drafting run sent to the research function: refused, and the run marked failed', x.r.status === 400 && x.b.reason === 'wrong_function'
      && one(`select status || '|' || error from growth_outbound.research_runs where id = ${x.b.run_id};`) === 'failed|a draft run was sent to the research function', x.b);
    x = await run({ action: 'scheduled', ticket: 'f'.repeat(64) }, undefined, { token: null });
    chk('M a ticket nobody issued: 401', x.r.status === 401 && x.b.reason === 'invalid_ticket' && fnCalls(/rpc\//).length === 1, x.b);
    x = await run({ action: 'scheduled', ticket: 'nope' }, undefined, { token: null });
    chk('M … and a malformed one never reaches the database', x.r.status === 401 && fnCalls(/rpc\//).length === 0);
    const T10 = crypto.randomBytes(32).toString('hex');
    one(`insert into growth_outbound.research_runs (kind, started_by, input, ticket_sha256, ticket_expires_at)
         values ('research', 'schedule', '{"next": true}', ${lit(crypto.createHash('sha256').update(T10).digest('hex'))}, now() + interval '10 minutes');
         update growth_outbound.settings set automation_enabled = false where id = 1;`);
    x = await run({ action: 'scheduled', ticket: T10 }, undefined, { token: null });
    chk('M automation turned off: a live ticket stops working at once', x.r.status === 401 && x.b.reason === 'invalid_ticket', x.b);
    one(`update growth_outbound.research_runs set status = 'done', finished_at = now() where status = 'running';
         update growth_outbound.settings set automation_enabled = true where id = 1;`);
    const mint = (kind, input) => { const t = crypto.randomBytes(32).toString('hex');
      return { t, id: +one(`insert into growth_outbound.research_runs (kind, started_by, input, ticket_sha256, ticket_expires_at)
        values (${lit(kind)}, 'schedule', ${lit(JSON.stringify(input))}::jsonb, ${lit(crypto.createHash('sha256').update(t).digest('hex'))}, now() + interval '10 minutes') returning id;`) }; };
    let tk = mint('research', { next: true });
    x = await run({ action: 'scheduled', ticket: tk.t }, undefined, { token: null });
    chk('M no new candidate left: said, and the run is done (nothing to read is not a failure)', x.b.reason === 'queue_empty'
      && one(`select status || '|' || (counts->>'outcome') from growth_outbound.research_runs where id = ${tk.id};`) === 'done|queue_empty', x.b);
    tk = mint('discover', { saved: true });
    x = await run({ action: 'scheduled', ticket: tk.t }, cfgOf({ braveKey: '' }), { token: null });
    chk('M no search key: the morning\'s search fails, said, and the run is marked so', x.r.status === 503 && x.b.reason === 'search_not_configured'
      && one(`select status || '|' || error from growth_outbound.research_runs where id = ${tk.id};`) === 'failed|search is not set up (BRAVE_SEARCH_API_KEY)', x.b);
    tk = mint('research', { next: true });
    x = await run({ action: 'scheduled', ticket: tk.t }, undefined, { token: OWNER_T });
    chk('M a token sent along changes nothing: the ticket is the only credential, used as anon', x.b.reason === 'queue_empty'
      && fnCalls(/rest\/v1\/rpc/).every((e) => e.headers.authorization === 'Bearer ' + ANON) && fnCalls(/auth\/v1\/user/).length === 0, x.b);
    one(`update growth_outbound.settings set discovery_config = '{}', automation_enabled = false where id = 1;`);

    /* ══ K. KEYS ════════════════════════════════════════════════════════ */
    LOG = [];
    WEB = SITES();
    globalThis.__claude = CLAUDE_OK(PAT_FACTS);
    const r1 = await M.handle(post({ action: 'research', prospect_id: PID }), cfgOf());
    const out = await r1.text();
    chk('K the engine\'s answer carries no key and no token', !Object.values(KEYS).some((k) => out.includes(k)) && !out.includes(OWNER_T));
    chk('K the Brave key goes only to Brave, the Hunter key only to Hunter', LOG.every((e) => (JSON.stringify(e.headers).includes(KEYS.brave) ? e.host === 'api.search.brave.com' : true)
      && (e.url.includes(KEYS.hunter) ? e.host === 'api.hunter.io' : true)));
    chk('K every database call: the anon apikey and the OWNER\'s own token', LOG.filter((e) => e.host === 'proj.supabase.test' && /rest\/v1\/rpc/.test(e.url))
      .every((e) => e.headers.apikey === ANON && e.headers.authorization === 'Bearer ' + OWNER_T));
    chk('K a web page never sees a key or a token', LOG.filter((e) => !/supabase\.test|brave\.com|hunter\.io/.test(e.host))
      .every((e) => !JSON.stringify(e.headers).match(/Bearer|sk-ant|brave_secret|hunter_secret/)));

    const rep = db.applyFileAtomic(path.join(PG.ROOT, 'supabase', 'growth_outbound.sql'));
    chk('the SQL re-runs over all of this, every report row ok', !/CHECK THIS/.test(rep), rep.split('\n').filter((l) => /CHECK THIS/.test(l)));
  } catch (e) {
    chk('the suite ran without an unexpected error', false, String(e && (e.stack || e.sqlMessage || e.message) || e).slice(0, 1500));
  } finally {
    db.stop();
  }
  for (const m of failures) console.log('FAIL | ' + m);
  console.log((fail ? 'FAIL' : 'PASS') + ' — outbound research engine (function + database): ' + pass + '/' + (pass + fail) + ' checks');
  process.exit(fail ? 1 : 0);
})();
function __claude_reset() { CLAUDE_REQS = []; }
