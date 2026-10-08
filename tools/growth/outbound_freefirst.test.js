#!/usr/bin/env node
/* ===========================================================================
   PHASE 13 — FREE-FIRST DISCOVERY AND READINESS, through the deployed
   functions and the REAL SQL: supabase/functions/growth_outbound_research,
   growth_outbound_send, growth_outbound_draft and growth_outbound_optout
   against supabase/growth_outbound.sql behind a PostgREST stand-in. Podcast
   Index, Hunter, Apollo, Brave, Claude, Resend, DNS and the web are mocked;
   nothing leaves this process, and no email goes anywhere.

     S  HEALTH     every provider asked its free question; "connected" only
                   from an answer; a missing key, a refused key, a plan without
                   the endpoint, a spent allowance each said; recorded
     D  DISCOVER   with NO Brave key: Podcast Index finds shows and their own
                   sites (signed headers; dead, silent, foreign and
                   platform-only shows left out); the morning run with no
                   source is done, not failed; with directories alone it reads
     X  DIRECTORY  only with the owner's word; robots.txt obeyed; links to
                   independent sites and profiles kept, the rest left out; the
                   owner's segment carried; the page stored
     A  APOLLO     people search off the plan is "not on the plan", never a bad
                   key, and the other sources still run; the organization
                   lookup: off until on, an organization's own site, Apollo's
                   names a note, a second ask answered from memory
     H  HUNTER     the allowance read first (free); nothing asked once it is
                   spent or the key refused; a domain's answer remembered; a
                   refusal, a rate limit or "still checking" is NEVER recorded
                   as a verdict, so the address is asked again another day
     P  PREFILTER  a page that is not football analysis is set aside with no
                   Claude call
     G  SEGMENT    the owner's word on who someone is beats the model's
     L  LEDGER     Claude's tokens priced; provider calls counted
     O  OPT-OUT    the send function checks the endpoint end to end (GET
                   redirects, a one-click POST reaches the database), records
                   it, and sets the base; not deployed, or JWT-guarded, said
     R  RESEND     the key's health (a sending-only key is a real key); a
                   domain Resend has not verified fails the domain check
     W  PARTNERS   a partner lead gets the partnership prompt; money offered is
                   refused by the database; the partnership template is
                   accepted; off, nothing is written to them
     E  END TO END your own list → research → qualified → verified address →
                   draft → approval → test send → signed event: the webhook is
                   proven, the opt-out endpoint checked, nothing blocks going
                   live; Resend called once, only to your inbox
     K  KEYS       no key in any answer; each key only to its own provider

   Run: node tools/growth/outbound_freefirst.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const crypto = require('crypto');
const { register } = require('node:module');
const { pathToFileURL } = require('node:url');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const SEED = require(path.join(__dirname, '_outbound_seed.js'));
const MORNING = require(path.join(__dirname, '_morning.js'));
const { rpcShim, jres } = require(path.join(__dirname, '_rpc_shim.js'));

let pass = 0, fail = 0;
const failures = [];
const chk = (n, c, d) => { if (c) pass++; else { fail++; failures.push(n + (d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 600) : '')); } };

const FN = (n) => path.join(__dirname, '..', '..', 'supabase', 'functions', 'growth_outbound_' + n, 'index.ts');
const db = PG.start('gofrfn');
if (db.skip) { console.log((process.env.OUTBOUND_PG_REQUIRED ? 'FAIL | ' : 'NOTE | ') + db.skip + ' — skipped'); process.exit(process.env.OUTBOUND_PG_REQUIRED ? 1 : 0); }
register(pathToFileURL(path.join(__dirname, '_stubs', 'hooks.mjs')));

// a project whose own functions address is a real Supabase shape, so the
// opt-out check may derive its base from it
const URL_ = 'https://zzproj.supabase.co';
const OPTOUT_URL = URL_ + '/functions/v1/growth_outbound_optout';
const ANON = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.anon';
const OWNER_T = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.sig-owner';
const OWNER = '00000000-0000-0000-0000-0000000000a1';
const KEYS = { brave: 'brave_secret_key_123', hunter: 'hunter_secret_key_456', anthropic: 'sk-ant-secret-789', apollo: 'apollo_secret_key_abc',
  piKey: 'PIKEYSECRET0001', piSecret: 'pisecret^value$0002', resend: 're_Secret12_abcdefghijklmnop' };
const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const lit = PG.lit;
const one = (s) => db.sql(s);
const own = (s) => JSON.parse(db.as(OWNER, s));
const J = (o) => lit(JSON.stringify(o)) + '::jsonb';
const settings = (o) => own(`select public.growth_outbound_settings_update(${J(o)});`);
const pid = (n) => '80000000-0000-0000-0000-' + String(n).padStart(12, '0');

/* ── the world ─────────────────────────────────────────────────────────── */
let LOG = [], ALL = [], WEB = {}, ROBOTS = {}, MAIL = [];
let PI, HUNTER_ACC, HUNTER_DS, HUNTER_V, APOLLO_HEALTH, APOLLO_SEARCH, APOLLO_ENRICH, APOLLO_TOP, BRAVE, RESEND_DOMAINS, DOH = {};
let OPTOUT_MODE = 'deployed', CLAUDE_REQS = [];
const M = {};
const SHIM = rpcShim(db, { url: URL_, users: { [OWNER_T]: { id: OWNER, email: 'owner@edgedesk.test' } }, override: () => null });
globalThis.fetch = async (input, init) => {
  const url = String(input), u = new URL(url), h = Object.assign({}, (init && init.headers) || {});
  LOG.push({ url, host: u.host, path: u.pathname, headers: h, method: (init && init.method) || 'GET', body: init && init.body });
  ALL.push({ host: u.host, text: url + ' ' + JSON.stringify(h) + ' ' + String((init && init.body) || '') });
  if (u.origin === URL_ && u.pathname === '/functions/v1/growth_outbound_optout') {
    if (OPTOUT_MODE === 'missing') return new Response('{"code":"NOT_FOUND","message":"Requested function was not found"}', { status: 404, headers: { 'content-type': 'application/json' } });
    if (OPTOUT_MODE === 'jwt') return jres(401, { code: 401, message: 'Missing authorization header' });
    return M.optout.handle(new Request(url, { method: (init && init.method) || 'GET', headers: h, body: init && init.body }), CFG.optout);
  }
  const viaDb = await SHIM(url, init);
  if (viaDb) return viaDb;
  if (u.host === 'api.podcastindex.org') return typeof PI === 'function' ? PI(u, h) : jres(500, {});
  if (u.host === 'api.hunter.io') {
    if (u.pathname === '/v2/account') return typeof HUNTER_ACC === 'function' ? HUNTER_ACC(u) : jres(404, {});
    if (u.pathname === '/v2/domain-search') return typeof HUNTER_DS === 'function' ? HUNTER_DS(u) : jres(404, {});
    if (u.pathname === '/v2/email-verifier') return typeof HUNTER_V === 'function' ? HUNTER_V(u) : jres(404, {});
  }
  if (u.host === 'api.apollo.io') {
    if (u.pathname === '/v1/auth/health') return typeof APOLLO_HEALTH === 'function' ? APOLLO_HEALTH(h) : jres(500, {});
    if (u.pathname === '/api/v1/mixed_people/api_search') return typeof APOLLO_SEARCH === 'function' ? APOLLO_SEARCH(JSON.parse(init.body)) : jres(500, {});
    if (u.pathname === '/api/v1/organizations/enrich') return typeof APOLLO_ENRICH === 'function' ? APOLLO_ENRICH(u) : jres(500, {});
    if (u.pathname === '/api/v1/mixed_people/organization_top_people') return typeof APOLLO_TOP === 'function' ? APOLLO_TOP(u) : jres(500, {});
    return jres(500, {});
  }
  if (u.host === 'api.search.brave.com') return typeof BRAVE === 'function' ? BRAVE(u) : jres(500, {});
  if (u.host === 'api.resend.com' && u.pathname === '/domains') return typeof RESEND_DOMAINS === 'function' ? RESEND_DOMAINS(h) : jres(500, {});
  if (u.host === 'api.resend.com' && u.pathname === '/emails') {
    MAIL.push({ key: h['idempotency-key'], msg: JSON.parse(init.body) });
    return jres(200, { id: 're_ff_' + String(MAIL.length).padStart(4, '0') });
  }
  if (u.host === 'cloudflare-dns.com' || u.host === 'dns.google') {
    const ans = DOH[u.searchParams.get('name') + '|' + u.searchParams.get('type')];
    return jres(200, ans || { Status: 3 });
  }
  if (u.pathname === '/robots.txt') {
    const r = ROBOTS[u.origin] || { status: 404, body: '' };
    return new Response(r.body, { status: r.status, headers: { 'content-type': 'text/plain' } });
  }
  const pg = WEB[u.origin + u.pathname];
  if (!pg) return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
  return new Response(pg, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
};
globalThis.Deno = { env: { get: () => undefined } };

const base = { url: URL_, anonKey: ANON, origins: ['https://edgedesksports.com'], fetch: (u, i) => globalThis.fetch(u, i), timeoutMs: 3000 };
const CFG = {
  research: Object.assign({}, base, { braveKey: '', hunterKey: KEYS.hunter, anthropicKey: KEYS.anthropic, apolloKey: KEYS.apollo, model: 'claude-opus-5-5',
    podcastIndexKey: KEYS.piKey, podcastIndexSecret: KEYS.piSecret, clayWebhookUrl: '', clayToken: '', fetchTimeoutMs: 3000,
    resolveDns: async (h, t) => (t === 'A' ? ['93.184.216.34'] : []) }),
  send: Object.assign({}, base, { resendKey: KEYS.resend }),
  draft: Object.assign({}, base, { anthropicKey: KEYS.anthropic, model: 'claude-opus-5-5' }),
  webhook: Object.assign({}, base, { log: () => {} }),
  optout: Object.assign({}, base, { page: 'https://edgedesksports.com/email/stop/', log: () => {} }),
};
const NOKEYS = Object.assign({}, CFG.research, { braveKey: '', hunterKey: '', anthropicKey: '', apolloKey: '', podcastIndexKey: '', podcastIndexSecret: '' });
const req = (fn, body, token) => new Request(URL_ + '/functions/v1/growth_outbound_' + fn, { method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, token === null ? {} : { authorization: 'Bearer ' + (token || OWNER_T) }), body: JSON.stringify(body) });
const ANSWERS = [];
async function call(fn, body, cfg, token) {
  LOG = [];
  const r = await M[fn].handle(req(fn, body, token), cfg || CFG[fn]);
  const raw = await r.text();
  ANSWERS.push(raw);
  let b = null; try { b = JSON.parse(raw); } catch (_) { b = raw; }
  return { status: r.status, b, raw };
}
const calls = (host, p) => LOG.filter((e) => e.host === host && (!p || e.path === p));
const health = () => JSON.parse(one(`select growth_outbound.provider_health_json();`));
const cand = (url) => { const s = one(`select to_jsonb(c) from growth_outbound.candidates c where url = ${lit(url)};`); return s ? JSON.parse(s) : null; };
const resetRuns = () => one(`update growth_outbound.research_runs set status = 'done', finished_at = now() where status = 'running';`);
const reply = (o, usage) => ({ stop_reason: 'end_turn', model: 'claude-opus-5-5', usage: usage || { input_tokens: 10000, output_tokens: 500 },
  content: [{ type: 'text', text: JSON.stringify(o) }] });
const READ = (o) => reply(Object.assign({ relevant: true, reason: 'a football modeler', prospect_type: 'cfb_analyst', segment: 'subscriber', sports: ['CFB'],
  facts: [], fit_factors: [], own_profiles: [] }, o));
const footballSite = (name, org) => `<html><head><title>${org}</title></head><body><h1>${org}</h1><p>I am ${name}, and I run ${org}, a college football model and ratings newsletter.</p>
  <p>Our model prices every game against the closing line.</p></body></html>`;
const mint = (kind, input) => { const t = crypto.randomBytes(32).toString('hex');
  return { t, id: +one(`insert into growth_outbound.research_runs (kind, started_by, input, ticket_sha256, ticket_expires_at)
    values (${lit(kind)}, 'schedule', ${J(input)}, ${lit(crypto.createHash('sha256').update(t).digest('hex'))}, now() + interval '10 minutes') returning id;`) }; };

(async () => {
  try {
    ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql', 'growth_outbound.sql']
      .forEach((f) => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f)));
    one(`insert into auth.users (id, email, email_confirmed_at, created_at) values ('${OWNER}', 'owner@edgedesk.test', now(), now() - interval '1 year');
         insert into public.affiliate_admins (user_id) values ('${OWNER}');
         select growth_outbound.grant_owner('owner@edgedesk.test');`);
    settings({ postal_address: 'EdgeDesk Sports, 100 Example St, Springfield, IL 62701', test_inbox: 'owner-test@edgedesk.test' });
    for (const k of ['research', 'send', 'draft', 'webhook', 'optout']) M[k] = await import(FN(k));

    /* ══ S. HEALTH ════════════════════════════════════════════════════════ */
    let x = await call('research', { action: 'health' }, NOKEYS);
    let hh = x.b && x.b.health;
    chk('S no keys at all: every provider said to have no credential, with what to do, and nobody is called', x.status === 200
      && ['anthropic', 'hunter', 'apollo', 'podcastindex', 'brave', 'clay'].every((k) => hh[k] && hh[k].state === 'credential_missing')
      && /api\.podcastindex\.org\/signup/.test(hh.podcastindex.detail) && /optional and not needed/.test(hh.brave.detail)
      && LOG.every((e) => e.host === new URL(URL_).host), hh);
    chk('S … recorded as said', health().podcastindex.state === 'credential_missing' && health().anthropic.state === 'credential_missing');
    HUNTER_ACC = () => jres(200, { data: { plan_name: 'Free', reset_date: '2026-11-01', requests: { searches: { used: 3, available: 25 }, verifications: { used: 10, available: 50 } } } });
    APOLLO_HEALTH = (h) => jres(200, { healthy: true, is_logged_in: h['x-api-key'] === KEYS.apollo });
    PI = (u) => jres(200, { status: 'true', feeds: [], count: 0, query: u.searchParams.get('q') });
    globalThis.__claude_models = (id) => ({ id, type: 'model' });
    const t0 = Math.floor(Date.now() / 1000);
    x = await call('research', { action: 'health' }, Object.assign({}, CFG.research, { braveKey: KEYS.brave }));
    hh = x.b.health;
    chk('S every key that is set is asked its free question: each answered, so each is connected', hh.anthropic.state === 'connected' && hh.hunter.state === 'connected'
      && hh.apollo.state === 'connected' && hh.podcastindex.state === 'connected', hh);
    chk('S … Hunter\'s plan, what is used and when it resets, kept', /Hunter \(Free\): searches 3 of 25 used, verifications 10 of 50 used — resets 2026-11-01/.test(hh.hunter.detail)
      && health().hunter.quota.searches.available === 25, hh.hunter);
    chk('S … a key that is set but has no free question (Brave) is "not checked yet", never connected', hh.brave.state === 'not_checked' && health().brave.state === 'not_checked', hh.brave);
    const pic = calls('api.podcastindex.org')[0];
    const date = pic && pic.headers['x-auth-date'];
    chk('S … Podcast Index is asked with its signed headers: key, date, sha1(key + secret + date), and who is asking', !!pic && pic.headers['x-auth-key'] === KEYS.piKey
      && Math.abs(+date - t0) <= 5 && pic.headers.authorization === crypto.createHash('sha1').update(KEYS.piKey + KEYS.piSecret + date).digest('hex')
      && /^EdgeDeskBot\/1\.0/.test(pic.headers['user-agent']) && !pic.url.includes(KEYS.piSecret), pic && pic.headers);
    chk('S … what the checks cost is on the ledger: calls, no credit', one(`select string_agg(provider || ':' || calls || ':' || units, ',' order by provider) from growth_outbound.provider_ledger;`)
      === 'anthropic:1:0,apollo:1:0,hunter:1:0,podcastindex:1:0');
    HUNTER_ACC = () => jres(200, { data: { plan_name: 'Free', reset_date: '2026-11-01', credits: { used: 50, available: 50 } } });
    APOLLO_HEALTH = () => jres(401, { error: 'Invalid access credentials.' });
    PI = () => jres(401, { status: 'false', description: 'Authorization header doesn\'t match' });
    globalThis.__claude_models = () => { throw Object.assign(new Error('invalid x-api-key'), { status: 401 }); };
    x = await call('research', { action: 'health' });
    hh = x.b.health;
    chk('S refusals said for what they are: a key refused (Claude, Apollo, Podcast Index), a free allowance used up (Hunter)', hh.anthropic.state === 'unauthorized'
      && hh.apollo.state === 'unauthorized' && hh.podcastindex.state === 'unauthorized' && hh.hunter.state === 'quota_exhausted', hh);
    HUNTER_ACC = () => jres(200, { data: { plan_name: 'Free', reset_date: '2026-11-01', requests: { credits: { used: 12, available: 50 } } } });
    const ha = await M.research.hunterAccount(CFG.research);
    chk('S … a plan that reports one pool of credits (under requests) is read as that pool', ha.verdict === 'ok' && !!ha.quota.credits
      && ha.quota.credits.used === 12 && ha.quota.credits.available === 50 && M.research.remaining(ha.quota.credits) === 38, ha);
    globalThis.__claude_models = () => { throw Object.assign(new Error('model not found'), { status: 404 }); };
    x = await call('research', { action: 'health' });
    chk('S a model the key may not use is "not on the plan", named', x.b.health.anthropic.state === 'insufficient_plan' && /claude-opus-5-5 is not available to this key/.test(x.b.health.anthropic.detail), x.b.health.anthropic);
    globalThis.__claude_models = undefined;
    APOLLO_HEALTH = (h) => jres(200, { healthy: true, is_logged_in: true });
    x = await call('research', { action: 'health' }, NOKEYS, 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.nobody');
    chk('S only the owner may ask', x.status === 401, x.b);

    /* ══ D. DISCOVER WITHOUT BRAVE ════════════════════════════════════════ */
    const now = Math.floor(Date.now() / 1000);
    const feed = (o) => Object.assign({ id: 1, title: 'CFB Numbers Podcast', link: 'https://cfbnumberspod.io/', author: 'Pat Analyst', ownerName: 'Pat', language: 'en-us',
      dead: 0, episodeCount: 120, newestItemPubdate: now - 3 * 86400, categories: { 1: 'Sports', 2: 'Football' }, description: 'College football numbers, weekly.' }, o);
    PI = (u) => jres(200, { status: 'true', count: 7, feeds: [feed({}), feed({ id: 2, title: 'Gone Pod', link: 'https://gonepod.io/', dead: 1 }),
      feed({ id: 3, title: 'Old Pod', link: 'https://oldpod.io/', newestItemPubdate: now - 800 * 86400 }),
      feed({ id: 4, title: 'Anchor Pod', link: 'https://anchor.fm/somepod' }), feed({ id: 5, title: 'Futbol', link: 'https://futbolpod.io/', language: 'es' }),
      feed({ id: 6, title: 'CFB Film Room', link: 'http://cfbfilmroom.substack.com' }), feed({ id: 7 })] });
    BRAVE = () => { throw new Error('Brave must not be called'); };
    x = await call('research', { action: 'discover', query: 'college football analytics podcast' });
    chk('D no Brave key: Podcast Index answers the search', x.status === 200 && x.b.ok === true && x.b.new === 2 && calls('api.search.brave.com').length === 0, x.b);
    chk('D … each show\'s own site (http made https) or its newsletter profile; dead, year-silent, foreign and platform-only shows left out', !!cand('https://cfbnumberspod.io')
      && !!cand('https://cfbfilmroom.substack.com') && !cand('https://gonepod.io') && !cand('https://oldpod.io') && !cand('https://futbolpod.io')
      && !one(`select 1 from growth_outbound.candidates where url like '%anchor.fm%';`), JSON.parse(one(`select jsonb_agg(url) from growth_outbound.candidates;`)));
    const pc = cand('https://cfbnumberspod.io');
    chk('D … attributed: the snippet says Podcast Index, who makes it, how many episodes, the newest', pc.provider === 'podcastindex'
      && /^Podcast Index: "CFB Numbers Podcast" · by Pat Analyst · 120 episodes · newest \d{4}-\d{2}-\d{2} · Sports, Football/.test(pc.snippet), pc.snippet);
    chk('D … the per-search report says why some were left out', (x.b.per_query || []).some((p) => p.provider === 'podcastindex' && p.results === 2 && /left out/.test(p.note || '')), x.b.per_query);
    chk('D … and Podcast Index is now known to work (it answered)', health().podcastindex.state === 'connected', health().podcastindex);
    PI = () => jres(401, { status: 'false' });
    x = await call('research', { action: 'discover', query: 'nfl model podcast' });
    chk('D Podcast Index refusing its key: said, recorded, the run failed in words (it was the only source)', x.b.ok === false && x.b.reason === 'search_failed'
      && /refused the key/.test(x.b.per_query[0].error) && health().podcastindex.state === 'unauthorized', x.b);
    x = await call('research', { action: 'discover', query: 'nfl model podcast' }, NOKEYS);
    chk('D a typed search with no search provider at all: said, naming the free one, and no run', x.status === 503 && x.b.reason === 'search_not_configured' && /PODCASTINDEX_API_KEY/.test(x.b.detail), x.b);
    // the morning run with no source at all
    one(`update growth_outbound.settings set automation_enabled = true where id = 1;`);
    let tk = mint('discover', { saved: true });
    x = await call('research', { action: 'scheduled', ticket: tk.t }, NOKEYS, null);
    chk('D the morning run with no source at all: done (not a failed step), saying what to set up', x.status === 200 && x.b.reason === 'search_not_configured'
      && one(`select status || '|' || (counts->>'outcome') from growth_outbound.research_runs where id = ${tk.id};`) === 'done|no_source_configured', x.b);

    /* ══ X. DIRECTORIES ═══════════════════════════════════════════════════ */
    const LIST = `<html><head><title>The best CFB analytics newsletters</title></head><body><h1>Our list</h1><ul>
      <li><a href="/about">About this list</a></li><li><a href="https://lists.io/other">More lists</a></li>
      <li><a href="https://indieratings.io/posts/week-5?utm_source=list">Indie Ratings</a></li>
      <li><a href="https://cfbmath.substack.com/p/some-post">CFB Math</a></li>
      <li><a href="https://www.youtube.com/@cfbfilm/videos">CFB Film on YouTube</a></li>
      <li><a href="https://x.com/someanalyst">An analyst on X</a></li><li><a href="https://sportsbook.draftkings.com/promo">Bet now</a></li>
      <li><a href="https://www.espn.com/college-football/">ESPN</a></li><li><a href="https://numbersblog.io/"><img src="i.png"></a></li>
      <li><a href="https://www.google.com/search?q=cfb">search</a></li><li><a href="mailto:hi@lists.io">Write to us</a></li>
      <li><a href="https://indieratings.io/">Indie Ratings again</a></li></ul></body></html>`;
    WEB['https://lists.io/best-cfb-newsletters'] = LIST;
    x = await call('research', { action: 'expand', url: 'https://lists.io/best-cfb-newsletters' });
    chk('X without the owner\'s word that reuse is permitted: refused, nothing read', x.status === 400 && x.b.reason === 'permission_unconfirmed' && calls('lists.io').length === 0, x.b);
    ROBOTS['https://lists.io'] = { status: 200, body: 'User-agent: *\nDisallow: /best' };
    x = await call('research', { action: 'expand', url: 'https://lists.io/best-cfb-newsletters', permitted: true });
    chk('X robots.txt says no: the page is not read, and nothing is added', x.b.ok === false && /robots\.txt disallows it/.test(x.b.per_query[0].error)
      && !cand('https://indieratings.io'), x.b);
    ROBOTS['https://lists.io'] = { status: 200, body: 'User-agent: *\nAllow: /' };
    x = await call('research', { action: 'expand', url: 'https://lists.io/best-cfb-newsletters', permitted: true, segment: 'media_partner' });
    const dirUrls = JSON.parse(one(`select coalesce(jsonb_agg(url order by url), '[]') from growth_outbound.candidates where provider = 'directory';`));
    chk('X its links to independent sites and newsletter or channel profiles become candidates, each once', x.b.ok === true && x.b.new === 3
      && JSON.stringify(dirUrls) === JSON.stringify(['https://cfbmath.substack.com', 'https://indieratings.io', 'https://youtube.com/@cfbfilm']), [x.b, dirUrls]);
    chk('X … the same site, X, a sportsbook, a big publisher, a search engine, an image-only link and an address are left out', dirUrls.length === 3);
    const dc = cand('https://indieratings.io');
    chk('X … with the owner\'s segment and where it was listed', dc.segment_hint === 'media_partner' && /Listed on lists\.io as "Indie Ratings"/.test(dc.snippet)
      && dc.query === 'directory: lists.io', dc);
    chk('X … the page is stored as read (so it is not due again this week)', one(`select count(*) from growth_outbound.pages where url = 'https://lists.io/best-cfb-newsletters';`) === '1');
    // the morning run reads a due directory with no search provider at all
    WEB['https://moreinfo.io/roster'] = `<html><body><p>Our shows:</p><a href="https://roster1.io/">Roster One</a> <a href="https://roster2.io/x">Roster Two</a></body></html>`;
    settings({ discovery_config: { directories: [{ url: 'https://moreinfo.io/roster', permitted: true, segment: 'media_partner' }] } });
    resetRuns();
    tk = mint('discover', { saved: true });
    x = await call('research', { action: 'scheduled', ticket: tk.t }, NOKEYS, null);
    chk('X the morning run reads a directory due a read, with no search provider at all', x.status === 200 && x.b.ok === true && x.b.directories === 1 && x.b.new === 2
      && cand('https://roster2.io').segment_hint === 'media_partner', x.b);

    /* ══ A. APOLLO ════════════════════════════════════════════════════════ */
    settings({ discovery_config: { providers: { apollo_search: true } } });
    PI = (u) => jres(200, { status: 'true', feeds: [feed({ id: 9, title: 'NFL Edges Pod', link: 'https://nfledgespod.io/' })] });
    APOLLO_SEARCH = () => jres(403, { error: 'api/v1/mixed_people/api_search is not accessible with this api_key on a free plan. Please upgrade your plan.', error_code: 'API_INACCESSIBLE' });
    resetRuns();
    x = await call('research', { action: 'discover', query: 'nfl modeling' });
    chk('A Apollo\'s people search off the free plan: "not on this plan", and Podcast Index still runs', x.b.ok === true && !!cand('https://nfledgespod.io')
      && (x.b.per_query || []).some((p) => p.provider === 'apollo' && /not on this plan/.test(p.error)), x.b);
    hh = health().apollo;
    chk('A … recorded against that endpoint; the key itself is not called bad', hh.endpoints['mixed_people/api_search'] === 'insufficient_plan' && hh.state === 'connected', hh);
    x = await call('research', { action: 'apollo_org', domains: ['indieanalytics.io'] });
    chk('A the organization lookup is off until switched on: said, nothing asked', x.status === 503 && x.b.reason === 'apollo_org_not_configured' && calls('api.apollo.io').length === 0, x.b);
    settings({ discovery_config: { providers: { apollo_org: true } } });
    APOLLO_ENRICH = (u) => jres(200, { organization: { id: 'org_' + u.searchParams.get('domain'), name: 'Indie Analytics', website_url: 'http://www.indieanalytics.io' } });
    APOLLO_TOP = (u) => jres(200, { people: [{ name: 'Jo Ray', title: 'Founder' }, { first_name: 'Sam', last_name: 'Lee', title: 'Head of Data' }] });
    x = await call('research', { action: 'apollo_org', domains: ['https://IndieAnalytics.io/about', 'not a domain'], segment: 'business_partner' });
    const oc = cand('https://indieanalytics.io');
    chk('A on: the organization\'s own site is the candidate; Apollo\'s top people a note, never something an email may say', x.b.ok === true && x.b.new === 1 && !!oc
      && oc.provider === 'apollo_org' && /Jo Ray — Founder; Sam Lee — Head of Data/.test(oc.snippet) && /never something an email may say/.test(oc.snippet)
      && oc.segment_hint === 'business_partner', [x.b, oc]);
    chk('A … Apollo asked for the organization, then its top people, by its id, with the key in its header', calls('api.apollo.io', '/api/v1/organizations/enrich').length === 1
      && new URL(calls('api.apollo.io', '/api/v1/mixed_people/organization_top_people')[0].url).searchParams.get('organization_id') === 'org_indieanalytics.io'
      && calls('api.apollo.io').every((c) => c.headers['x-api-key'] === KEYS.apollo && !c.url.includes(KEYS.apollo)));
    x = await call('research', { action: 'apollo_org', domains: ['indieanalytics.io'] });
    chk('A … asked again within 30 days: answered from memory, Apollo not called', calls('api.apollo.io').length === 0 && x.b.per_domain[0].found === true, x.b);
    APOLLO_TOP = () => jres(403, { error: 'mixed_people/organization_top_people is not accessible with this api_key on a free plan' });
    x = await call('research', { action: 'apollo_org', domains: ['secondorg.io'] });
    chk('A top people off the plan: the organization is still a candidate, and the endpoint is recorded as not on the plan', x.b.ok === true && !!cand('https://indieanalytics.io')
      && health().apollo.endpoints['mixed_people/organization_top_people'] === 'insufficient_plan', x.b);
    APOLLO_ENRICH = () => jres(422, { error: 'organizations/enrich is not accessible with this api_key on a free plan' });
    x = await call('research', { action: 'apollo_org', domains: ['thirdorg.io', 'fourthorg.io'] });
    chk('A the organization lookup itself off the plan: said, recorded, and the other domains are not asked', x.b.ok === false
      && calls('api.apollo.io', '/api/v1/organizations/enrich').length === 1 && health().apollo.endpoints['organizations/enrich'] === 'insufficient_plan', x.b);
    settings({ discovery_config: {} });

    /* ══ P. PREFILTER ═════════════════════════════════════════════════════ */
    let claudeCalls = 0;
    globalThis.__claude = (r) => { claudeCalls++; CLAUDE_REQS.push(r); return READ({}); };
    db.as(OWNER, `select public.growth_outbound_candidates_import('manual', '["https://cookies.io/", "https://gamedayfans.io/"]'::jsonb);`);
    WEB['https://cookies.io/'] = '<html><head><title>Cookies</title></head><body><p>I bake chocolate chip cookies every weekend.</p></body></html>';
    WEB['https://gamedayfans.io/'] = '<html><head><title>Gameday</title></head><body><p>We love college football tailgates and the band.</p></body></html>';
    resetRuns();
    x = await call('research', { action: 'research', candidate_id: +cand('https://cookies.io').id });
    chk('P a page that is not about football: not a fit, said, and no Claude call spent on it', x.b.ok === true && x.b.outcome === 'not_a_fit' && x.b.prefiltered === true
      && claudeCalls === 0 && !(x.b.spent && x.b.spent.llm) && /not about football|is about football/.test(cand('https://cookies.io').status_reason || ''), x.b);
    x = await call('research', { action: 'research', candidate_id: +cand('https://gamedayfans.io').id });
    chk('P football with no numbers, models, odds or betting: not a fit either, no Claude call', x.b.outcome === 'not_a_fit' && /never about numbers/.test(x.b.reason) && claudeCalls === 0, x.b);

    /* ══ G. SEGMENT, L. LEDGER, H. HUNTER ═════════════════════════════════ */
    WEB['https://riverspod.io/'] = footballSite('Rae Rivers', 'Rivers Report');
    db.as(OWNER, `select public.growth_outbound_candidates_import('manual', '[{"url": "https://riverspod.io/", "segment": "media_partner"}]'::jsonb);`);
    globalThis.__claude = (r) => { claudeCalls++; return READ({ segment: 'subscriber', facts: [{ field: 'full_name', claim: 'Rae Rivers', quote: 'I am Rae Rivers', page: 0 },
      { field: 'newsletter', claim: 'Rivers Report', quote: 'I run Rivers Report', page: 0 }] }); };
    HUNTER_ACC = () => jres(200, { data: { plan_name: 'Free', reset_date: '2026-11-01', requests: { searches: { used: 3, available: 25 }, verifications: { used: 10, available: 50 } } } });
    HUNTER_DS = (u) => jres(200, { data: { domain: u.searchParams.get('domain'), emails: [] } });
    resetRuns();
    one(`delete from growth_outbound.provider_ledger;`);
    x = await call('research', { action: 'research', candidate_id: +cand('https://riverspod.io').id });
    const RAE = x.b.prospect_id;
    chk('G the owner said "media partner" when importing them; Claude said subscriber; the owner\'s word stands', x.b.ok === true
      && one(`select campaign_type from growth_outbound.prospects where id = ${lit(RAE)};`) === 'media_partner', x.b);
    chk('G … and, partner outreach off, no address lookup is spent on a partner lead', calls('api.hunter.io').length === 0, LOG.filter((e) => e.host === 'api.hunter.io').map((e) => e.path));
    const led = JSON.parse(one(`select jsonb_object_agg(provider || '/' || operation, jsonb_build_object('calls', calls, 'units', units, 'in', input_tokens, 'out', output_tokens, 'usd', cost_usd)) from growth_outbound.provider_ledger;`));
    chk('L Claude\'s read is on the ledger with its tokens, priced ($0.05 for 10,000 in and 500 out at Opus 5.5)', led['anthropic/messages'] && led['anthropic/messages'].in === 10000
      && Math.abs(Number(led['anthropic/messages'].usd) - 0.05) < 1e-9, led);
    // Hunter, for a potential subscriber at their own domain
    settings({ partner_outreach_enabled: false });
    WEB['https://lenmodels.io/'] = footballSite('Len Ortiz', 'Len Models');
    db.as(OWNER, `select public.growth_outbound_candidates_import('manual', '["https://lenmodels.io/"]'::jsonb);`);
    globalThis.__claude = () => READ({ facts: [{ field: 'full_name', claim: 'Len Ortiz', quote: 'I am Len Ortiz', page: 0 }, { field: 'newsletter', claim: 'Len Models', quote: 'I run Len Models', page: 0 }] });
    resetRuns();
    x = await call('research', { action: 'research', candidate_id: +cand('https://lenmodels.io').id });
    const LEN = x.b.prospect_id;
    chk('H Hunter\'s allowance is read first (free), then its domain search, for this person at their own domain', calls('api.hunter.io', '/v2/account').length === 1
      && calls('api.hunter.io', '/v2/domain-search').length === 1 && new URL(calls('api.hunter.io', '/v2/domain-search')[0].url).searchParams.get('domain') === 'lenmodels.io', LOG.map((e) => e.path));
    resetRuns();
    x = await call('research', { action: 'research', prospect_id: LEN });
    chk('H researched again: the domain\'s answer is remembered, Hunter is not paid twice', x.b.ok === true && calls('api.hunter.io', '/v2/domain-search').length === 0
      && !(x.b.spent && x.b.spent.email_finder), [x.b.spent, LOG.filter((e) => e.host === 'api.hunter.io').map((e) => e.path)]);
    HUNTER_ACC = () => jres(200, { data: { plan_name: 'Free', reset_date: '2026-11-01', requests: { searches: { used: 25, available: 25 }, verifications: { used: 50, available: 50 } } } });
    WEB['https://moemodels.io/'] = footballSite('Moe Park', 'Moe Models');
    db.as(OWNER, `select public.growth_outbound_candidates_import('manual', '["https://moemodels.io/"]'::jsonb);`);
    globalThis.__claude = () => READ({ facts: [{ field: 'full_name', claim: 'Moe Park', quote: 'I am Moe Park', page: 0 }, { field: 'newsletter', claim: 'Moe Models', quote: 'I run Moe Models', page: 0 }] });
    resetRuns();
    x = await call('research', { action: 'research', candidate_id: +cand('https://moemodels.io').id });
    chk('H the allowance used up: nothing is asked of Hunter but its account, said, and recorded', calls('api.hunter.io', '/v2/domain-search').length === 0
      && calls('api.hunter.io', '/v2/account').length === 1 && x.b.notes.some((n) => /Hunter's searches are used up for this period \(resets 2026-11-01\)/.test(n))
      && health().hunter.state === 'quota_exhausted', [x.b.notes, LOG.map((e) => e.path)]);
    HUNTER_ACC = () => jres(401, { errors: [{ id: 'authentication_failed', details: 'No user found for the API key supplied' }] });
    globalThis.__claude = () => READ({ facts: [{ field: 'full_name', claim: 'Len Ortiz', quote: 'I am Len Ortiz', page: 0 }, { field: 'newsletter', claim: 'Len Models', quote: 'I run Len Models', page: 0 }] });
    one(`delete from growth_outbound.provider_cache;`);
    resetRuns();
    x = await call('research', { action: 'research', prospect_id: LEN });
    chk('H the key refused: Hunter asked nothing more, said, recorded as unauthorized', calls('api.hunter.io', '/v2/domain-search').length === 0
      && health().hunter.state === 'unauthorized' && x.b.notes.some((n) => /Hunter refused the key/.test(n)), [x.b, LOG.filter((e) => e.host === 'api.hunter.io').map((e) => e.path)]);
    // the verifier: only a real verdict is ever recorded
    one(`insert into growth_outbound.prospects (id, email, prospect_type, website_url, x_url) values (${lit(pid(1))}, 'ava@avamodels.io', 'cfb_analyst', 'https://avamodels.io', 'https://x.com/avamodels');
         insert into growth_outbound.evidence (prospect_id, field_name, claim, source_url, source_kind, source_excerpt, collected_by) values
           (${lit(pid(1))}, 'full_name', 'Ava Stone', 'https://avamodels.io/about', 'own_site', 'I am Ava Stone', 'owner'),
           (${lit(pid(1))}, 'full_name', 'Ava Stone', 'https://x.com/avamodels', 'own_profile', 'Ava Stone (@avamodels)', 'owner'),
           (${lit(pid(1))}, 'email', 'ava@avamodels.io', 'https://avamodels.io/contact', 'own_site', 'Write to ava@avamodels.io', 'owner');
         do $e$ begin perform growth_outbound.evaluate(${lit(pid(1))}); end $e$;`);
    const inQueue = () => JSON.parse(one(`select coalesce(jsonb_agg(prospect_id::text), '[]') from growth_outbound.verify_queue(50);`)).includes(pid(1));
    chk('H (setup) a published, unconfirmed address waits for the verifier', inQueue());
    HUNTER_ACC = () => jres(200, { data: { plan_name: 'Free', requests: { searches: { used: 0, available: 25 }, verifications: { used: 0, available: 50 } } } });
    HUNTER_V = () => jres(429, { errors: [{ id: 'too_many_requests', details: 'You have reached your usage limit' }] });
    resetRuns();
    x = await call('research', { action: 'verify', limit: 5 });
    chk('H the verifier out of allowance (429): NOT a verdict — nothing recorded about the address, still waiting, said', x.b.ok === true && x.b.asked === 0 && x.b.unanswered === 1
      && one(`select count(*) from growth_outbound.activity where action = 'email_verdict';`) === '0' && inQueue() && health().hunter.state === 'quota_exhausted', x.b);
    HUNTER_V = () => jres(202, { data: { status: 'pending' } });
    resetRuns();
    x = await call('research', { action: 'verify', limit: 5 });
    chk('H "still checking" (202): no verdict, asked again another day', x.b.unanswered === 1 && inQueue() && x.b.notes.some((n) => /still checking a•••@avamodels\.io/.test(n)), x.b);
    HUNTER_V = (u) => jres(200, { data: { status: 'valid', email: u.searchParams.get('email') } });
    resetRuns();
    x = await call('research', { action: 'verify', limit: 5 });
    chk('H a real verdict: recorded, and the address verified', x.b.asked === 1 && x.b.valid === 1 && !inQueue()
      && one(`select email_status from growth_outbound.prospects where id = ${lit(pid(1))};`) === 'verified', x.b);

    /* ══ O. THE OPT-OUT ENDPOINT, CHECKED ════════════════════════════════ */
    const lb = () => own(`select public.growth_outbound_settings();`).live_send_blockers;
    const suppBefore = one(`select count(*) from growth_outbound.suppressions;`);
    OPTOUT_MODE = 'missing';
    x = await call('send', { action: 'optout_check' });
    chk('O not deployed: the check fails in words, is recorded, and no base is set', x.status === 200 && x.b.ok === true && x.b.check.ok === false
      && /not deployed/.test(x.b.check.detail) && x.b.unsubscribe_url_base === null && lb().includes('unsubscribe_endpoint_missing'), x.b);
    OPTOUT_MODE = 'jwt';
    x = await call('send', { action: 'optout_check' });
    chk('O deployed with JWT verification on (nobody opting out has a token): said, with the flag to deploy it with', x.b.check.ok === false && /--no-verify-jwt/.test(x.b.check.detail), x.b.check);
    OPTOUT_MODE = 'deployed';
    x = await call('send', { action: 'optout_check' });
    chk('O deployed: the link redirects to the stop page and a one-click POST reaches the database — the base is set from this project, and nothing blocks on it',
      x.b.check.ok === true && x.b.check.get_status === 303 && x.b.check.post_status === 400 && x.b.unsubscribe_url_base === URL_ + '/functions/v1/'
      && !lb().includes('unsubscribe_endpoint_missing') && !lb().includes('unsubscribe_endpoint_unverified'), [x.b, lb()]);
    chk('O … and the check changed nothing: no address suppressed, no send touched', one(`select count(*) from growth_outbound.suppressions;`) === suppBefore);

    /* ══ R. RESEND ════════════════════════════════════════════════════════ */
    RESEND_DOMAINS = (h) => (h.authorization === 'Bearer ' + KEYS.resend ? jres(401, { name: 'restricted_api_key', message: 'This API key is restricted to only send emails' }) : jres(401, {}));
    x = await call('send', { action: 'health' });
    chk('R a sending-only Resend key is a real key: connected, and said to be sending-only', x.b.health.resend.state === 'connected' && /sending-only/.test(x.b.health.resend.detail)
      && health().resend.state === 'connected', x.b);
    RESEND_DOMAINS = () => jres(401, { name: 'validation_error', message: 'API key is invalid' });
    x = await call('send', { action: 'health' });
    chk('R a wrong key: unauthorized', x.b.health.resend.state === 'unauthorized' && health().resend.state === 'unauthorized', x.b);
    x = await call('send', { action: 'health' }, Object.assign({}, CFG.send, { resendKey: '' }));
    chk('R no key: credential missing', x.b.health.resend.state === 'credential_missing');
    DOH = { 'send.edgedesksports.com|TXT': { Status: 0, Answer: [{ type: 16, data: '"v=spf1 include:amazonses.com ~all"' }] },
      'send.edgedesksports.com|MX': { Status: 0, Answer: [{ type: 15, data: '10 feedback-smtp.us-east-1.amazonses.com' }] },
      'resend._domainkey.edgedesksports.com|TXT': { Status: 0, Answer: [{ type: 16, data: '"p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC1234567890abcdef"' }] },
      '_dmarc.edgedesksports.com|TXT': { Status: 0, Answer: [{ type: 16, data: '"v=DMARC1; p=none;"' }] } };
    RESEND_DOMAINS = () => jres(200, { data: [{ name: 'edgedesksports.com', status: 'not_started' }] });
    x = await call('send', { action: 'domain_check' });
    chk('R DNS in place but Resend has not verified the domain: the check fails, and live sending is blocked', x.b.check && x.b.check.ok === false && x.b.check.provider.ok === false
      && lb().includes('domain_auth_failed'), x.b);
    RESEND_DOMAINS = () => jres(200, { data: [{ name: 'edgedesksports.com', status: 'verified' }] });
    x = await call('send', { action: 'domain_check' });
    chk('R … verified by Resend too: the check passes', x.b.check.ok === true && !lb().includes('domain_auth_failed'), x.b.check);

    /* ══ W. PARTNERS ══════════════════════════════════════════════════════ */
    one(SEED.strong({ id: pid(2), name: 'Max Media', org: 'Big Sports Pod', email: 'max@bigsportspod.io', domain: 'bigsportspod.io', handle: 'maxmedia' })
      + `update growth_outbound.prospects set campaign_type = 'media_partner' where id = ${lit(pid(2))}; do $e$ begin perform growth_outbound.evaluate(${lit(pid(2))}); end $e$;`);
    chk('W (setup) a qualified media partner', one(`select status from growth_outbound.prospects where id = ${lit(pid(2))};`) === 'qualified');
    resetRuns();
    x = await call('draft', { action: 'draft', prospect_id: pid(2) });
    chk('W partner outreach off: nothing is written to a partner lead', x.b.ok === false && /partner/.test(JSON.stringify(x.b)) && one(`select count(*) from growth_outbound.drafts where prospect_id = ${lit(pid(2))};`) === '0', x.b);
    settings({ partner_outreach_enabled: true });
    const sysSeen = [];
    globalThis.__claude = (r) => {
      sysSeen.push(r.system);
      const u = String(r.messages[0].content), f = /\[(\d+)\] project: "([^"]+)"/.exec(u);
      return reply({ subject: 'A partnership idea', claims: [{ evidence_id: +f[1], text: f[2] }],
        body: 'Hi Max,\n\nI came across your ' + f[2] + '.\n\nWe pay a 30% commission on every signup you send. Details: https://edgedesksports.com/partners/\n\nInterested?' });
    };
    resetRuns();
    x = await call('draft', { action: 'draft', prospect_id: pid(2) });
    const pd = JSON.parse(one(`select to_jsonb(d) from growth_outbound.drafts d where prospect_id = ${lit(pid(2))} order by generated_at desc limit 1;`) || 'null');
    chk('W on: Claude is given the PARTNERSHIP letter\'s rules (what the partners page offers, never money)', sysSeen.length >= 1 && sysSeen.every((s2) => /research partnership/.test(s2) && /Never mention or hint at money/.test(s2))
      && !sysSeen.some((s2) => /\$49\.99/.test(s2)), sysSeen.map((s2) => s2.slice(0, 120)));
    chk('W … Claude offering a commission is refused by the database, twice; the partnership template is accepted instead', x.b.ok === true && x.b.writer === 'template'
      && !!pd && pd.generator_version === 'engine:template:pp1' && pd.campaign_type === 'media_partner', [x.b, pd && pd.generator_version]);
    chk('W … it links the partners page, offers no money and pitches no subscription', !!pd && /https:\/\/edgedesksports\.com\/partners\//.test(pd.body_text)
      && !/\$|commission|sponsor|49\.99|free trial/i.test(pd.body_text) && /free to cite and link/.test(pd.body_text), pd && pd.body_text);
    settings({ partner_outreach_enabled: false });

    /* ══ E. END TO END: your own list → … → a proven webhook ══════════════ */
    one(`update growth_outbound.settings set automation_enabled = false where id = 1;`);
    WEB['https://e2eanalyst.io/'] = `<html><head><title>E2E Numbers — Kim Lee</title></head><body><h1>E2E Numbers</h1>
      <p>I am Kim Lee, founder of E2E Numbers, a college football ratings newsletter.</p><p>I publish CFB power ratings against the market every week.</p>
      <p>Our model prices every game against the closing line and tracks CLV.</p><p>Write to kim@e2eanalyst.io</p>
      <a href="https://x.com/kimlee" rel="me">Kim on X</a></body></html>`;
    const IMP = own(`select public.growth_outbound_candidates_import('manual', '[{"url": "https://e2eanalyst.io/", "segment": "customer", "note": "found in my own search"}]'::jsonb);`);
    chk('E 1 your own list: one new candidate, no provider involved', IMP.ok === true && IMP.new === 1, IMP);
    globalThis.__claude = () => READ({ facts: [
      { field: 'full_name', claim: 'Kim Lee', quote: 'I am Kim Lee, founder of E2E Numbers', page: 0 },
      { field: 'organization', claim: 'E2E Numbers', quote: 'I am Kim Lee, founder of E2E Numbers', page: 0 },
      { field: 'project', claim: 'CFB power ratings against the market', quote: 'I publish CFB power ratings against the market every week', page: 0 },
      { field: 'fit_signal', claim: 'prices games against the closing line', quote: 'Our model prices every game against the closing line and tracks CLV', page: 0 }],
      fit_factors: [{ code: 'publishes_models', facts: [3] }, { code: 'covers_cfb', facts: [2] }], own_profiles: ['https://x.com/kimlee'] });
    HUNTER_ACC = () => jres(200, { data: { plan_name: 'Free', requests: { searches: { used: 0, available: 25 }, verifications: { used: 0, available: 50 } } } });
    HUNTER_V = (u) => jres(200, { data: { status: 'valid', email: u.searchParams.get('email') } });
    resetRuns();
    x = await call('research', { action: 'research', candidate_id: +cand('https://e2eanalyst.io').id });
    const KIM = x.b.prospect_id;
    chk('E 2 research: facts quoted from their own page, their published address verified by Hunter', x.b.ok === true && x.b.outcome === 'created'
      && one(`select email || '|' || email_status from growth_outbound.prospects where id = ${lit(KIM)};`) === 'kim@e2eanalyst.io|verified', x.b);
    const fitEv = +one(`select id from growth_outbound.evidence where prospect_id = ${lit(KIM)} and field_name = 'fit_signal' and superseded_at is null order by id limit 1;`);
    let r = own(`select public.growth_outbound_evidence_add(${lit(KIM)}, ${J({ evidence: [
      { field_name: 'full_name', claim: 'Kim Lee', source_url: 'https://x.com/kimlee', source_kind: 'own_profile', source_excerpt: 'Kim Lee (@kimlee)' },
      { field_name: 'organization', claim: 'E2E Numbers', source_url: 'https://x.com/kimlee', source_kind: 'own_profile', source_excerpt: 'founder, E2E Numbers' },
      { field_name: 'project', claim: 'CFB power ratings against the market', source_url: 'https://x.com/kimlee/status/1', source_kind: 'own_profile',
        source_excerpt: 'New: CFB power ratings against the market' }],
      fit_factors: SEED.FIT_STRONG.map((code) => ({ code, evidence: [fitEv] })) })});`);
    chk('E 3 the owner confirms them from their own profile: every gate clears (qualification ≥ 75, identity, research, email)', r.ok === true
      && one(`select status from growth_outbound.prospects where id = ${lit(KIM)};`) === 'qualified'
      && +one(`select qualification_score from growth_outbound.prospects where id = ${lit(KIM)};`) >= 75, r);
    globalThis.__claude = (rq) => {
      const u = String(rq.messages[0].content), greet = /Greeting \(the first line, exactly\): (.*)/.exec(u)[1], f = /\[(\d+)\] project: "([^"]+)"/.exec(u);
      return reply({ subject: 'A research tool for your work', claims: [{ evidence_id: +f[1], text: f[2] }], body: greet + '\n\nI read your ' + f[2] + '.\n\n'
        + "I'm Davis, and I'm building EdgeDesk Sports: research for NFL and college football, with results tracked against the closing line. It's research, not picks.\n\n"
        + 'If it would be useful for your work, you can try it free for 7 days at https://edgedesksports.com/ (then $49.99/month).\n\nWould it be worth a look?' });
    };
    resetRuns();
    x = await call('draft', { action: 'draft', prospect_id: KIM });
    const KD = one(`select id from growth_outbound.drafts where prospect_id = ${lit(KIM)} and status = 'pending_review' order by generated_at desc limit 1;`);
    chk('E 4 the engine drafts, as Claude, and it waits for review (nothing approved, nothing sent)', x.b.ok === true && x.b.writer === 'claude' && !!KD && MAIL.length === 0, x.b);
    r = own(`select public.growth_outbound_draft_approve(${lit(KD)}, ${lit(one(`select content_hash from growth_outbound.drafts where id = ${lit(KD)};`))});`);
    chk('E 5 the owner approves it (approving sends nothing)', r.ok === true && MAIL.length === 0, r);
    one(`select growth_outbound.set_webhook_secret(${lit(SECRET)});`);
    chk('E 6 before the test send: the webhook is not proven yet, so going live would be blocked', lb().includes('webhook_unproven'), lb());
    x = await call('send', { draft_ids: [KD] });
    chk('E 7 the test send: Resend gets one email, for the owner\'s test inbox only', x.b.ok === true && x.b.sent === 1 && MAIL.length === 1
      && JSON.stringify(MAIL[0].msg.to) === JSON.stringify(['owner-test@edgedesk.test']), [x.b, MAIL.map((m) => m.msg.to)]);
    chk('E … with the commercial-email line, the postal address and a working one-click opt-out to this project\'s endpoint', /This is a commercial email from EdgeDesk Sports/.test(MAIL[0].msg.text)
      && /100 Example St/.test(MAIL[0].msg.text) && MAIL[0].msg.text.includes(URL_ + '/functions/v1/growth_outbound_optout?t=') && /One-Click/.test(JSON.stringify(MAIL[0].msg.headers)), MAIL[0].msg.text);
    const id = 'msg_ff_1', ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ type: 'email.delivered', created_at: new Date().toISOString(), data: { email_id: 're_ff_0001' } });
    const sig = 'v1,' + crypto.createHmac('sha256', Buffer.from(SECRET.slice(6), 'base64')).update(id + '.' + ts + '.' + body, 'utf8').digest('base64');
    LOG = [];
    const wr = await M.webhook.handle(new Request(URL_ + '/functions/v1/growth_outbound_webhook', { method: 'POST',
      headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': sig }, body }), CFG.webhook);
    chk('E 8 Resend\'s signed event arrives: delivered, recorded', wr.status === 200 && one(`select delivery_status from growth_outbound.sends where resend_message_id = 're_ff_0001';`) === 'delivered');
    chk('E 9 the webhook is proven, the opt-out endpoint was checked, the domain checked: NOTHING blocks going live', JSON.stringify(lb()) === '[]'
      && own(`select public.growth_outbound_settings();`).webhook.proven === true, lb());
    chk('E 10 a test send leaves the prospect qualified, their real first email still due', one(`select status from growth_outbound.prospects where id = ${lit(KIM)};`) !== 'contacted');
    chk('E 11 across all of it Resend was called once, and only for the owner\'s inbox', MAIL.length === 1);

    /* ══ K. KEYS ══════════════════════════════════════════════════════════ */
    const secrets = [KEYS.hunter, KEYS.anthropic, KEYS.apollo, KEYS.piKey, KEYS.piSecret, KEYS.resend, KEYS.brave, SECRET];
    chk('K no key, secret or ticket in any answer the functions gave', !ANSWERS.some((a) => secrets.some((k) => a.includes(k))));
    const only = (k, hosts) => ALL.filter((e) => e.text.includes(k)).every((e) => hosts.includes(e.host));
    chk('K each key went only to its own provider (Podcast Index\'s secret never left this process)', only(KEYS.hunter, ['api.hunter.io']) && only(KEYS.apollo, ['api.apollo.io'])
      && only(KEYS.piKey, ['api.podcastindex.org']) && ALL.every((e) => !e.text.includes(KEYS.piSecret)) && only(KEYS.resend, ['api.resend.com']) && ALL.every((e) => !e.text.includes(KEYS.brave)));
    chk('K no database row holds a provider key', !secrets.slice(0, 7).some((k) => one(`select count(*) from (select to_jsonb(h)::text t from growth_outbound.provider_health h union all
       select to_jsonb(l)::text from growth_outbound.provider_ledger l union all select to_jsonb(c)::text from growth_outbound.provider_cache c union all
       select to_jsonb(r)::text from growth_outbound.research_runs r) x where t like ${lit('%' + k + '%')};`) !== '0'));
  } catch (e) {
    chk('the suite ran without an unexpected error', false, String(e && (e.sqlMessage || e.stack || e.message) || e).slice(0, 1500));
  } finally {
    db.stop();
    for (const f of failures) console.log('FAIL | ' + f);
    console.log((fail ? 'FAIL' : 'PASS') + ' — outbound free-first (functions + database): ' + pass + '/' + (pass + fail) + ' checks');
    process.exit(fail ? 1 : 0);
  }
})();
