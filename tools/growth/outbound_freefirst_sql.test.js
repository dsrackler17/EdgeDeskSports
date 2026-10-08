#!/usr/bin/env node
/* ===========================================================================
   PHASE 13 — FREE-FIRST DISCOVERY AND OPERATIONAL READINESS, in the database
   (supabase/growth_outbound.sql, section 13 and what it changed), on a real
   PostgreSQL with Supabase's default grants.

     U  UPGRADE    the previous file, then this one: the old default zone moves
                   to America/Chicago once, on the record; a zone the owner
                   chose is never touched; a fresh install starts in Chicago
     I  IMPORT     the owner's own lists become candidates with no provider:
                   addresses, pasted search results, company domains, CSV rows;
                   canonical, counted once, a known prospect's page a duplicate,
                   a suppressed domain never read; X/LinkedIn/search-engine
                   pages and junk refused in words; the owner's segment kept;
                   one run on the record; owner only
     D  DIRECTORIES  need the owner's word that reuse is permitted; due weekly;
                   the morning run plans a discovery step for them alone
     H  HEALTH     what a provider said: states, endpoints, quota, when it last
                   worked and failed; a ticket only for its own run; refusals
     C  CACHE      a provider's answer kept for a while, then gone; never for a
                   drafting run
     L  LEDGER     calls and Claude's tokens by day, priced from the model's
                   list price; free-tier calls never given a dollar figure
     B  BLOCKERS   live sending needs the opt-out endpoint CHECKED at its base
                   and the webhook PROVEN by a signed event since the secret was
                   set; a test send needs neither; the check's door
     T  TEST INBOX never a prospect's address, never a suppressed one
     P  PARTNERS   a partner lead is scored without the purchase part (scaled),
                   penalties in full; drafted for only while partner outreach
                   is on; never offered money or terms; linked to /partners/
     Q  QUALITY    urgency, pretended familiarity and flattery refused at
                   approval; the footer says it is a commercial email, 21+
     R  REVENUE    a traced account's paid invoices, each once, gross; written
                   by the matcher only; in the results
     A  ATTENTION  a provider that refused or ran dry; a morning run with
                   nothing to discover from
     O  OVERVIEW   health, spend, sources, rejections, directories; the
                   morning's found-today; the System check's row 38

   Run: node tools/growth/outbound_freefirst_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const SEED = require(path.join(__dirname, '_outbound_seed.js'));

const T = PG.kit('growth outbound free-first SQL');
const chk = T.chk;
const lit = PG.lit;
const FILE = path.join(PG.ROOT, 'supabase', 'growth_outbound.sql');

const db = PG.start('gofree');
if (db.skip) { console.log('NOTE | ' + db.skip + ' — LIVE layer skipped'); process.exit(T.done()); }

const OWNER = '00000000-0000-0000-0000-0000000000a1';
const ADMIN = '00000000-0000-0000-0000-0000000000a2';
const SUB = '00000000-0000-0000-0000-0000000000a3';
const pid = (n) => '60000000-0000-0000-0000-' + String(n).padStart(12, '0');
const did = (n) => '70000000-0000-0000-0000-' + String(n).padStart(12, '0');
const j = (s) => JSON.parse(s);
const one = (sql) => db.sql(sql);
const own = (sql) => j(db.as(OWNER, sql));
const J = (o) => lit(JSON.stringify(o)) + '::jsonb';
const settings = (o) => own(`select public.growth_outbound_settings_update(${J(o)});`);
const imp = (source, items) => own(`select public.growth_outbound_candidates_import(${lit(source)}, ${J(items)});`);
const cand = (url) => { const s = one(`select to_jsonb(c) from growth_outbound.candidates c where url = ${lit(url)};`); return s ? j(s) : null; };
const ncand = () => +one(`select count(*) from growth_outbound.candidates;`);
const begin = (kind, input) => own(`select public.growth_outbound_research_begin(${lit(kind)}, ${J(input || {})});`);
const finish = (run) => own(`select public.growth_outbound_research_finish(${run}, 'done', '{}'::jsonb, null);`);
const hrec = (run, p) => own(`select public.growth_outbound_provider_health_record(${run == null ? 'null' : run}, ${J(p)});`);
const health = () => j(one(`select growth_outbound.provider_health_json();`));
const ledger = (run, items) => own(`select public.growth_outbound_provider_record(${run == null ? 'null' : run}, ${J(items)});`);
const blockers = () => j(one(`select to_jsonb(growth_outbound.send_blockers_for(false));`));
const tblockers = () => j(one(`select to_jsonb(growth_outbound.send_blockers_for(true));`));
const lint = (subject, body) => j(one(`select to_jsonb(growth_outbound.draft_lint(${lit(subject)}, ${lit(body)}));`));
const partnerOffer = (body) => j(one(`select to_jsonb(growth_outbound.partner_offer_problems(${lit(body)}));`));
const row = (p) => j(one(`select to_jsonb(x) from growth_outbound.prospects x where id = ${lit(p)};`));
const hashOf = (d) => one(`select content_hash from growth_outbound.drafts where id = ${lit(d)};`);
const approve = (d) => own(`select public.growth_outbound_draft_approve(${lit(d)}, ${lit(hashOf(d))});`);
const claim = (d) => own(`select public.growth_outbound_send_claim(${lit(d)});`);
const sendResult = (s, id) => own(`select public.growth_outbound_send_result(${lit(s)}, ${lit(id)}, null, false);`);
const plan = () => j(one(`select growth_outbound.schedule_plan();`));
const due = () => j(one(`select coalesce(jsonb_agg(prospect_id::text), '[]') from growth_outbound.drafting_due();`));
const has = (r, re) => !!r && Array.isArray(r.problems) && r.problems.some((x) => re.test(x));

try {
  /* ══ U. UPGRADE ═══════════════════════════════════════════════════════ */
  // the file as it was before Phase 13, from git, then this one over it
  // (9bf153b: the last commit before Phase 13; a shallow checkout may not have it, and then the fresh install is tested instead)
  let prev = null;
  for (const ref of ['9bf153b', 'origin/main', 'main']) {
    try { prev = cp.execSync('git show ' + ref + ':supabase/growth_outbound.sql', { cwd: PG.ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch (_) { prev = null; }
    if (prev && !/13\. FREE-FIRST DISCOVERY/.test(prev)) break;
    prev = null;
  }
  if (prev && !/13\. FREE-FIRST DISCOVERY/.test(prev)) {
    const pf = path.join(os.tmpdir(), 'growth_outbound_prev_' + process.pid + '.sql');
    fs.writeFileSync(pf, prev);
    ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql']
      .forEach((f) => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f)));
    db.applyFileAtomic(pf);
    fs.rmSync(pf, { force: true });
    chk('U (setup) the previous file installs with its own default zone, America/New_York', one(`select automation_timezone from growth_outbound.settings;`) === 'America/New_York');
    const out = db.applyFileAtomic(FILE);
    chk('U this file applies over it, every report row ok', !/CHECK THIS/.test(out), out.split('\n').filter((l) => /CHECK THIS/.test(l)));
    chk('U the old default zone moves to the owner\'s, America/Chicago, once', one(`select automation_timezone from growth_outbound.settings;`) === 'America/Chicago');
    chk('U … on the record, as the system\'s', one(`select actor_kind || '|' || (detail->>'from') || '|' || (detail->>'to') from growth_outbound.activity where action = 'timezone_default_moved';`)
      === 'system|America/New_York|America/Chicago');
    one(`update growth_outbound.settings set automation_timezone = 'America/New_York' where id = 1;`);
    db.applyFileAtomic(FILE);
    chk('U … and only once: run again, a zone set since is left alone', one(`select automation_timezone from growth_outbound.settings;`) === 'America/New_York'
      && one(`select count(*) from growth_outbound.activity where action = 'timezone_default_moved';`) === '1');
    one(`update growth_outbound.settings set automation_timezone = 'America/Chicago' where id = 1;`);
  } else {
    ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql', 'growth_outbound.sql']
      .forEach((f) => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f)));
    chk('U (no earlier version in git to upgrade from: a fresh install starts in Chicago)', one(`select automation_timezone from growth_outbound.settings;`) === 'America/Chicago');
  }
  chk('U a fresh row would start in Chicago too (the column default)', one(`select column_default from information_schema.columns
      where table_schema = 'growth_outbound' and table_name = 'settings' and column_name = 'automation_timezone';`) === `'America/Chicago'::text`);
  one(`insert into auth.users (id, email, email_confirmed_at) values ('${OWNER}', 'owner@edgedesk.test', now()), ('${ADMIN}', 'admin@edgedesk.test', now()),
         ('${SUB}', 'sub@edgedesk.test', now());
       insert into public.affiliate_admins (user_id) values ('${OWNER}'), ('${ADMIN}');
       select growth_outbound.grant_owner('owner@edgedesk.test');`);
  settings({ postal_address: 'EdgeDesk Sports, 100 Example St, Springfield, IL 62701', test_inbox: 'owner-test@edgedesk.test' });

  /* ══ I. IMPORT ════════════════════════════════════════════════════════ */
  let r = imp('manual', ['https://www.CFBNumbers.test/?utm_source=x', 'cfbnumbers.test', '  leelab.test/about  ', { url: 'https://x.com/patanalyst' },
    { url: 'https://www.google.com/search?q=cfb+models' }, 'not a web address', { url: 'https://touts.test/', segment: 'pundit' },
    { url: 'https://rivers.substack.com/', note: 'a CFB  win-totals   newsletter', segment: 'media_partner', title: 'Rivers on CFB' }]);
  chk('I a pasted list: addresses become candidates, the same site twice is counted once', r.ok === true && r.new === 3 && r.recorded === 3, r);
  chk('I … canonical: tracking tags and www. dropped', !!cand('https://cfbnumbers.test') && !!cand('https://leelab.test/about'), j(one(`select jsonb_agg(url) from growth_outbound.candidates;`)));
  chk('I … X (and LinkedIn, Instagram…) refused in words: the engine may not read them', r.refused.some((x) => x.item === 4 && /may not read X, LinkedIn/.test(x.why)), r.refused);
  chk('I … a search engine\'s own page refused: paste the results instead', r.refused.some((x) => x.item === 5 && /search engine/.test(x.why)), r.refused);
  chk('I … junk refused, and an unknown segment refused, each by its line', r.refused.some((x) => x.item === 6 && /not a web address/.test(x.why))
    && r.refused.some((x) => x.item === 7 && /segment is/.test(x.why)) && r.refused.length === 4, r.refused);
  let c = cand('https://rivers.substack.com');
  chk('I … with the owner\'s segment, title and note kept (whitespace tidied), and where it came from', !!c && c.segment_hint === 'media_partner' && c.title === 'Rivers on CFB'
    && c.snippet === 'Your note: a CFB win-totals newsletter' && c.provider === 'manual' && c.query === 'your list: added by hand' && c.status === 'new', c);
  chk('I … one discover run on the record, done, with what it did', one(`select kind || '|' || status || '|' || (input->>'source') || '|' || (counts->>'new') || '|' || (counts->>'refused')
      from growth_outbound.research_runs where id = ${r.run_id};`) === 'discover|done|manual|3|4');
  r = imp('manual', ['https://cfbnumbers.test/?ref=newsletter', { url: 'https://rivers.substack.com', segment: 'affiliate' }]);
  chk('I the same list again: seen again, nothing new; the owner\'s latest word on who they are wins', r.ok === true && r.new === 0 && r.seen_again === 2
    && cand('https://rivers.substack.com').segment_hint === 'affiliate' && cand('https://cfbnumbers.test').times_seen === 2, r);
  r = imp('domains', ['Stone-Analytics.test', 'https://numbersguy.test/some/page', 'bad domain']);
  chk('I company domains: each is its site\'s home page', r.ok === true && r.new === 2 && !!cand('https://stone-analytics.test') && !!cand('https://numbersguy.test')
    && cand('https://numbersguy.test').provider === 'domain_list', r);
  r = imp('search_results', [{ url: 'https://modelsandmarkets.test/archive' }]);
  chk('I a pasted search result: recorded as one', r.ok === true && r.new === 1 && cand('https://modelsandmarkets.test/archive').provider === 'pasted_results', r);
  r = imp('csv', [{ website: 'https://csvperson.test', name: 'CSV Person', note: 'from my notes', segment: 'customer' }, { domain: 'csvorg.test' }]);
  chk('I CSV rows: website or domain, name and note', r.ok === true && r.new === 2 && cand('https://csvperson.test').title === 'CSV Person'
    && cand('https://csvperson.test').segment_hint === 'customer' && cand('https://csvperson.test').provider === 'csv_import', r);
  // a known prospect's own site, and a suppressed domain
  one(SEED.strong({ id: pid(1), name: 'Pat Analyst', org: 'CFB Numbers', email: 'pat@patnumbers.test', domain: 'patnumbers.test', handle: 'patanalyst' }));
  own(`select public.growth_outbound_suppress('blocked.test', 'manual', 'asked us to stop', 'domain');`);
  r = imp('manual', ['https://patnumbers.test/', 'https://blocked.test/team']);
  chk('I a known prospect\'s own site: a duplicate, linked to them; a suppressed domain: marked, never read', r.ok === true && r.duplicates === 1 && r.suppressed === 1
    && cand('https://patnumbers.test').prospect_id === pid(1) && cand('https://blocked.test/team').status === 'suppressed', r);
  r = imp('manual', ['not an address', 'https://linkedin.com/in/someone']);
  chk('I nothing importable: said, with the reasons, and no run', r.ok === false && r.reason === 'nothing_to_import' && r.refused.length === 2, r);
  chk('I an unknown source, an empty list, too long a list: refused', imp('scrape', ['https://a.test']).reason === 'invalid_source'
    && imp('manual', []).reason === 'invalid_items' && imp('manual', Array.from({ length: 501 }, (_, i) => 'https://s' + i + '.test')).reason === 'invalid_items');
  r = imp('manual', Array.from({ length: 120 }, (_, i) => 'https://bulk' + i + '.test'));
  chk('I a long list is recorded in pieces, all of it', r.ok === true && r.new === 120, r);
  for (const [who, run] of [['anon', (s) => db.anon(s)], ['a subscriber', (s) => db.as(SUB, s)], ['an affiliate admin who is not an owner', (s) => db.as(ADMIN, s)]]) {
    const e = db.mustFail(() => run(`select public.growth_outbound_candidates_import('manual', '["https://sneaky.test"]'::jsonb);`));
    chk('I ' + who + ' cannot import', !!e && /permission denied|outbound owner only/.test(e), e);
  }
  chk('I … and nothing sneaked in', !cand('https://sneaky.test'));

  /* ══ D. DIRECTORIES ═══════════════════════════════════════════════════ */
  r = settings({ discovery_config: { directories: [{ url: 'https://lists.test/best-cfb-newsletters' }] } });
  chk('D a directory without the owner\'s word that reuse is permitted: refused in words', r.ok === false && /needs permitted: true/.test(r.detail), r);
  r = settings({ discovery_config: { directories: [{ url: 'http://lists.test/x', permitted: true }] } });
  chk('D … an address that is not https: refused', r.ok === false && /https:\/\/ page address/.test(r.detail), r);
  r = settings({ discovery_config: { directories: [{ url: 'https://lists.test/x', permitted: true, segment: 'fans' }] } });
  chk('D … an unknown segment: refused', r.ok === false && /segment is customer/.test(r.detail), r);
  r = settings({ discovery_config: { providers: { podcastindex: true, apollo_org: false }, directories: [
    { url: 'https://lists.test/best-cfb-newsletters', permitted: true, segment: 'media_partner', note: 'a public list' }] } });
  chk('D a directory with its permission, and the new provider switches: saved', r.ok === true, r);
  chk('D due a read (never read yet)', j(one(`select growth_outbound.directories_due();`)).length === 1);
  settings({ automation_enabled: true, automation_timezone: 'UTC', automation_start_hour: new Date().getUTCHours(), automation_hours: 1 });
  let p = plan();
  chk('D the morning run plans a discovery step for the directories alone (no saved search, no search provider needed)', p.step && p.step.kind === 'discover', p);
  const DR = begin('discover', { saved: true }).run_id;
  own(`select public.growth_outbound_page_record(${DR}, ${J({ url: 'https://lists.test/best-cfb-newsletters', http_status: 200, content_type: 'text/html', title: 'Best', text: 'a list of CFB newsletters' })});`);
  finish(DR);
  chk('D read this week: no longer due', j(one(`select growth_outbound.directories_due();`)).length === 0);
  settings({ automation_enabled: false, automation_timezone: 'America/Chicago', automation_start_hour: 6, automation_hours: 4 });

  /* ══ H. PROVIDER HEALTH ═══════════════════════════════════════════════ */
  r = hrec(null, { provider: 'hunter', state: 'connected', detail: 'Hunter (Free): searches 3 of 25 used', quota: { searches: { used: 3, available: 25 } } });
  let h = health().hunter;
  chk('H the owner records what a provider said: state, detail, quota, when it worked', r.ok === true && h.state === 'connected' && h.quota.searches.available === 25
    && !!h.last_ok_at && !h.last_error_at && h.fresh === true, h);
  hrec(null, { provider: 'hunter', state: 'quota_exhausted', detail: 'the allowance is used up' });
  h = health().hunter;
  chk('H … a later word replaces it; the quota stays until a new one; the failure is dated', h.state === 'quota_exhausted' && h.quota.searches.available === 25 && !!h.last_error_at && !!h.last_ok_at, h);
  hrec(null, { provider: 'apollo', state: 'insufficient_plan', endpoint: 'mixed_people/api_search', detail: 'Apollo says this is not on the plan' });
  h = health().apollo;
  chk('H an endpoint off the plan is that endpoint\'s state; the key answered, so the key is connected', h.state === 'connected' && h.endpoints['mixed_people/api_search'] === 'insufficient_plan', h);
  hrec(null, { provider: 'apollo', state: 'connected', endpoint: 'mixed_people/organization_top_people' });
  hrec(null, { provider: 'apollo', state: 'unauthorized', endpoint: 'people/match' });
  h = health().apollo;
  chk('H … endpoints add up; a refused key is the key\'s state whatever endpoint said it', h.state === 'unauthorized' && Object.keys(h.endpoints).length === 3, h);
  hrec(null, { provider: 'brave', state: 'credential_missing', detail: 'optional and not needed' });
  chk('H a missing key is "credential missing", never connected', health().brave.state === 'credential_missing');
  for (const [bad, why] of [[{ provider: 'google', state: 'connected' }, 'invalid_provider'], [{ provider: 'hunter', state: 'great' }, 'invalid_state'],
    [{ provider: 'hunter', state: 'connected', endpoint: 'DROP TABLE' }, 'invalid_endpoint'], [{ provider: 'hunter', state: 'connected', key: 'x' }, 'unknown_field'],
    [{ provider: 'hunter', state: 'connected', quota: 'lots' }, 'invalid_quota']]) {
    chk('H refused: ' + JSON.stringify(bad), hrec(null, bad).reason === why, hrec(null, bad));
  }
  chk('H a finished run cannot record', hrec(DR, { provider: 'hunter', state: 'connected' }).reason === 'run_not_running');
  // a scheduled run's ticket: its own run, never another, never none
  const tk = require('crypto').randomBytes(32).toString('hex');
  const TR = +one(`insert into growth_outbound.research_runs (kind, started_by, input, ticket_sha256, ticket_expires_at)
     values ('discover', 'schedule', '{}', ${lit(require('crypto').createHash('sha256').update(tk).digest('hex'))}, now() + interval '10 minutes') returning id;`);
  one(`update growth_outbound.settings set automation_enabled = true where id = 1;`);
  const door = (name, args) => j(db.anon(`select public.growth_outbound_scheduled(${lit(tk)}, ${lit(name)}, ${J(args)});`));
  r = door('growth_outbound_provider_health_record', { p: { provider: 'podcastindex', state: 'connected', detail: 'answered a search' } });
  chk('H the morning run records a provider\'s answer for its own run', r.ok === true && health().podcastindex.state === 'connected', r);
  r = door('growth_outbound_provider_health_record', { p_run: TR + 99, p: { provider: 'podcastindex', state: 'unauthorized' } });
  chk('H … and for no other run', r.ok === false && r.reason === 'not_allowed', r);
  one(`update growth_outbound.settings set automation_enabled = false where id = 1;`);
  r = door('growth_outbound_provider_health_record', { p: { provider: 'podcastindex', state: 'unauthorized' } });
  chk('H … and not at all once automation is off', r.ok === false && r.reason === 'invalid_ticket' && health().podcastindex.state === 'connected', r);
  one(`update growth_outbound.research_runs set status = 'done', finished_at = now() where id = ${TR};`);

  /* ══ C. CACHE ═════════════════════════════════════════════════════════ */
  const CR = begin('research', { candidate_id: 1 }).run_id;
  r = own(`select public.growth_outbound_cache_put(${CR}, 'hunter_domain_search', 'CFBNumbers.test', '{"emails": []}'::jsonb, 336);`);
  chk('C a provider\'s answer is kept, under a tidy key', r.ok === true
    && own(`select public.growth_outbound_cache_get('hunter_domain_search', 'cfbnumbers.test');`).hit === true, r);
  chk('C … a different question is not answered from it', own(`select public.growth_outbound_cache_get('hunter_domain_search', 'leelab.test');`).hit === false
    && own(`select public.growth_outbound_cache_get('podcastindex_search', 'cfbnumbers.test');`).hit === false);
  one(`update growth_outbound.provider_cache set fetched_at = now() - interval '20 days', expires_at = now() - interval '1 second';`);
  chk('C … and once it expires it answers nothing', own(`select public.growth_outbound_cache_get('hunter_domain_search', 'cfbnumbers.test');`).hit === false);
  own(`select public.growth_outbound_cache_put(${CR}, 'podcastindex_search', 'nfl models', '{"feeds": []}'::jsonb, 24);`);
  chk('C … an expired answer is cleared when another is kept', one(`select string_agg(provider, ',') from growth_outbound.provider_cache;`) === 'podcastindex_search');
  chk('C refused: a time to keep outside 1 hour to 30 days, an unknown provider, no value', own(`select public.growth_outbound_cache_put(${CR}, 'podcastindex_search', 'x', '{}'::jsonb, 0);`).reason === 'invalid_ttl'
    && own(`select public.growth_outbound_cache_put(${CR}, 'pastebin', 'x', '{}'::jsonb, 1);`).reason === 'invalid'
    && own(`select public.growth_outbound_cache_put(${CR}, 'apollo_org', 'x', null, 1);`).reason === 'no_value');
  const DRR = begin('draft', {}).run_id;
  chk('C a drafting run keeps nothing', own(`select public.growth_outbound_cache_put(${DRR}, 'apollo_org', 'x.test', '{}'::jsonb, 1);`).reason === 'wrong_run_kind');
  finish(DRR);

  /* ══ L. LEDGER ════════════════════════════════════════════════════════ */
  r = ledger(CR, [{ provider: 'anthropic', operation: 'messages', model: 'claude-opus-5-5', input_tokens: 12000, output_tokens: 800 },
    { provider: 'hunter', operation: 'domain-search', calls: 1, units: 1 }, { provider: 'podcastindex', operation: 'search/byterm' }]);
  let sp = j(one(`select growth_outbound.spend_json();`));
  chk('L Claude\'s tokens priced at the model\'s list price ($4 in, $20 out per million for Opus 5.5)', r.ok === true && r.recorded === 3
    && Math.abs(sp.providers.anthropic.usd_today - (12000 * 4 + 800 * 20) / 1e6) < 1e-9 && sp.providers.anthropic.input_tokens_30d === 12000, sp.providers.anthropic);
  chk('L a free-tier provider\'s calls are counted in credits, with no dollar figure invented', sp.providers.hunter.calls_today === 1 && sp.providers.hunter.units_today === 1
    && sp.providers.hunter.usd_today === null && sp.providers.podcastindex.calls_today === 1, sp.providers);
  ledger(CR, [{ provider: 'anthropic', operation: 'messages', model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 100, cache_read_tokens: 10000 },
    { provider: 'anthropic', operation: 'messages', model: 'some-future-model', input_tokens: 5000, output_tokens: 5000 }]);
  sp = j(one(`select growth_outbound.spend_json();`));
  chk('L calls add up by day; cached input at the cache price; an unknown model\'s tokens counted, never priced', sp.providers.anthropic.calls_today === 3
    && Math.abs(sp.usd_today - ((12000 * 4 + 800 * 20) + (1000 * 4 + 100 * 20 + 10000 * 0.2)) / 1e6) < 1e-6
    && sp.providers.anthropic.input_tokens_30d === 12000 + 1000 + 10000 + 5000, sp);
  for (const [bad, why] of [[[{ provider: 'openai', operation: 'x' }], 'invalid'], [[{ provider: 'hunter', operation: 'x', calls: -1 }], 'invalid_value'],
    [[{ provider: 'hunter', operation: 'x', secret: 'k' }], 'unknown_field'], [Array.from({ length: 21 }, () => ({ provider: 'web', operation: 'x' })), 'invalid_items']]) {
    chk('L refused: ' + JSON.stringify(bad).slice(0, 80), ledger(CR, bad).reason === why, ledger(CR, bad));
  }
  finish(CR);

  /* ══ B. LIVE BLOCKERS ═════════════════════════════════════════════════ */
  chk('B (start) live sending also needs the opt-out base and the webhook secret', JSON.stringify(blockers()) === JSON.stringify(['unsubscribe_endpoint_missing', 'webhook_secret_missing']), blockers());
  settings({ unsubscribe_url_base: 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/' });
  chk('B a base that is set but never checked: blocked, in words', blockers().includes('unsubscribe_endpoint_unverified') && !blockers().includes('unsubscribe_endpoint_missing'), blockers());
  const ocr = (p) => own(`select public.growth_outbound_optout_check_record(${J(p)});`);
  r = ocr({ base: 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/', ok: false, redirect_ok: true, post_ok: false, post_status: 503, detail: 'the one-click POST answered 503' });
  chk('B a failed check is recorded, and still blocks', r.ok === true && r.optout_check.ok === false && r.live_send_blockers.includes('unsubscribe_endpoint_unverified'), r);
  chk('B the check cannot claim more than its parts', ocr({ base: 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/', ok: true, redirect_ok: true, post_ok: false }).detail === 'ok while a part failed');
  chk('B … nor be of an address that is not a functions address', ocr({ base: 'https://evil.test/functions/v1/', ok: true, redirect_ok: true, post_ok: true }).reason === 'invalid_base');
  r = ocr({ base: 'https://elsewhere.supabase.co/functions/v1/', ok: true, redirect_ok: true, post_ok: true, get_status: 303, post_status: 400 });
  chk('B a working endpoint at ANOTHER base proves nothing about this one, and does not move it', r.ok === true && r.unsubscribe_url_base === 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/'
    && blockers().includes('unsubscribe_endpoint_unverified'), r);
  r = ocr({ base: 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/', ok: true, redirect_ok: true, post_ok: true, get_status: 303, post_status: 400, detail: 'works' });
  chk('B checked at its base and working: that blocker is gone', r.ok === true && !blockers().includes('unsubscribe_endpoint_unverified'), blockers());
  chk('B … every check is on the record', +one(`select count(*) from growth_outbound.activity where action = 'optout_endpoint_checked';`) === 3);
  settings({ unsubscribe_url_base: 'https://other.supabase.co/functions/v1/' });
  chk('B changing the base needs a new check', blockers().includes('unsubscribe_endpoint_unverified'));
  settings({ unsubscribe_url_base: null });
  r = ocr({ base: 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/', ok: true, redirect_ok: true, post_ok: true, get_status: 303, post_status: 400 });
  chk('B with no base yet, a working check SETS it (the button configures the endpoint)', r.unsubscribe_url_base === 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/'
    && !blockers().includes('unsubscribe_endpoint_missing') && !blockers().includes('unsubscribe_endpoint_unverified'), r);
  for (const [who, run] of [['anon', (s) => db.anon(s)], ['a non-owner admin', (s) => db.as(ADMIN, s)]]) {
    chk('B ' + who + ' cannot record a check', !!db.mustFail(() => run(`select public.growth_outbound_optout_check_record('{"base": "https://a.supabase.co/functions/v1/", "ok": true, "redirect_ok": true, "post_ok": true}'::jsonb);`)));
  }
  chk('B the owner cannot set the check through the settings door', settings({ optout_check: { ok: true } }).reason === 'unknown_setting');
  one(`insert into growth_outbound.provider_events (event_id, event_type, outcome) values ('evt_before_secret', 'email.delivered', 'not_outbound');`);
  one(`select growth_outbound.set_webhook_secret('whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw');`);
  chk('B a webhook secret set but no signed event since: blocked (an event before the secret proves nothing)', JSON.stringify(blockers()) === JSON.stringify(['webhook_unproven']), blockers());
  chk('B … the console is told the webhook is not proven', own(`select public.growth_outbound_settings();`).webhook.proven === false);
  chk('B a TEST send needs neither the check nor the proof', JSON.stringify(tblockers()) === '[]', tblockers());
  one(`insert into growth_outbound.provider_events (event_id, event_type, outcome) values ('evt_after_secret', 'email.delivered', 'not_outbound');`);
  chk('B a signed event after the secret: proven, nothing blocks live sending', JSON.stringify(blockers()) === '[]' && own(`select public.growth_outbound_settings();`).webhook.proven === true, blockers());
  one(`select pg_sleep(0.01); select growth_outbound.set_webhook_secret('whsec_bmV3c2VjcmV0bmV3c2VjcmV0bmV3c2VjcmV0MTIz');`);
  chk('B a new secret needs a new proof', JSON.stringify(blockers()) === JSON.stringify(['webhook_unproven']), blockers());
  one(SEED.liveReady());

  /* ══ T. THE TEST INBOX ════════════════════════════════════════════════ */
  r = settings({ test_inbox: 'Pat@PatNumbers.test' });
  chk('T a prospect\'s address can never be the test inbox (every test send would reach them)', r.ok === false && /belongs to a prospect/.test(r.detail)
    && own(`select public.growth_outbound_settings();`).test_inbox === 'owner-test@edgedesk.test', r);
  own(`select public.growth_outbound_suppress('gone@edgedesk.test', 'manual', 'old inbox', 'address');`);
  chk('T … nor a suppressed address', /suppressed/.test(settings({ test_inbox: 'gone@edgedesk.test' }).detail));
  chk('T … the owner\'s own: fine', settings({ test_inbox: 'davis-tests@edgedesk.test' }).ok === true && settings({ test_inbox: 'owner-test@edgedesk.test' }).ok === true);

  /* ══ P. PARTNERS ══════════════════════════════════════════════════════ */
  // the same evidence twice: a potential subscriber, and a media partner
  const strongWith = (id, seg, extra) => SEED.strong({ id, name: 'Rae Rivers', org: 'Rivers Report', email: 'rae' + id.slice(-2) + '@rivers' + id.slice(-2) + '.test',
    domain: 'rivers' + id.slice(-2) + '.test', handle: 'raerivers' + id.slice(-2), fit: SEED.FIT_STRONG.concat(extra || []) })
    + `update growth_outbound.prospects set campaign_type = ${lit(seg)} where id = ${lit(id)}; do $e$ begin perform growth_outbound.evaluate(${lit(id)}); end $e$;`;
  one(strongWith(pid(2), 'customer'));
  one(strongWith(pid(3), 'media_partner'));
  const qc = row(pid(2)).qualification, qp = row(pid(3)).qualification;
  const parts = (q) => q.parts.relevance.points + q.parts.analytics.points + q.parts.contact.points + q.parts.personalization.points;
  chk('P a subscriber is scored on every part, purchase signals included', qc.basis === 'subscriber' && qc.score === Math.min(100, parts(qc) + qc.parts.purchase.points)
    && qc.parts.purchase.counted === true, qc);
  chk('P a partner lead is scored without the purchase part, the rest scaled to 100', qp.basis === 'partner' && qp.parts.purchase.counted === false
    && qp.score === Math.min(100, Math.round(parts(qp) * 100 / 85)), qp);
  one(`update growth_outbound.prospects set fit_factors = fit_factors || '[{"code": "large_media_outlet"}]'::jsonb where id = ${lit(pid(3))};
       do $e$ begin perform growth_outbound.evaluate(${lit(pid(3))}); end $e$;`);
  chk('P … and a reason against counts in full', row(pid(3)).qualification.score === Math.max(0, Math.min(100, Math.round(parts(qp) * 100 / 85) - 25)), row(pid(3)).qualification);
  one(`update growth_outbound.prospects set fit_factors = (select jsonb_agg(x) from jsonb_array_elements(fit_factors) x where x->>'code' <> 'large_media_outlet') where id = ${lit(pid(3))};
       do $e$ begin perform growth_outbound.evaluate(${lit(pid(3))}); end $e$;`);
  chk('P (setup) both clear every gate', row(pid(2)).status === 'qualified' && row(pid(3)).status === 'qualified', [row(pid(2)).status_reason, row(pid(3)).status_reason]);
  chk('P with partner outreach off (the default), only the subscriber is due a draft', due().includes(pid(2)) && !due().includes(pid(3)), due());
  r = settings({ partner_outreach_enabled: true });
  chk('P the owner turns partner outreach on (audited)', r.ok === true && !!r.changed.partner_outreach_enabled, r);
  chk('P … now the partner lead is due too', due().includes(pid(3)));
  chk('P a partner lead\'s email links to the partners page', one(`select growth_outbound.landing_for(${lit(pid(3))})->>'url';`) === 'https://edgedesksports.com/partners/');
  const proj = one(`select id from growth_outbound.evidence where prospect_id = ${lit(pid(3))} and field_name = 'project' order by id limit 1;`);
  const pdraft = (body) => j(one(`select growth_outbound.engine_draft_problems(${lit(pid(3))}, 1, 'EdgeDesk Sports research for your readers', ${lit(body)},
    ${J([{ text: 'CFB power ratings against the market', evidence_id: +proj }])});`));
  const NOTE = 'Hi Rae,\n\nI came across your work recently, in particular this: "CFB power ratings against the market".\n\n'
    + 'I\'m Davis, and I run EdgeDesk Sports: independent NFL and college football research. It\'s research, not picks.\n\n'
    + 'If it would be useful to your readers, the research is free to cite and link. More on how we work with newsletters and creators: https://edgedesksports.com/partners/\n\n'
    + 'Would you be open to a short conversation?';
  r = pdraft(NOTE);
  chk('P a partnership note without the price or the trial is accepted', JSON.stringify(r.problems) === '[]', r.problems);
  r = pdraft(NOTE.replace('the research is free to cite and link.', 'we pay a 30% commission per signup.'));
  chk('P … offering money or terms nobody approved is refused', has(r, /partnership: offers money or terms nobody has approved/), r.problems);
  r = pdraft(NOTE.replace('the research is free to cite and link.', 'we could sponsor an episode.'));
  chk('P … sponsorship too', has(r, /offers money or terms/), r.problems);
  r = pdraft(NOTE.replace(' https://edgedesksports.com/partners/', ' our site'));
  chk('P … and it must link to EdgeDesk', has(r, /partnership: include the link/), r.problems);
  chk('P the partner rules, alone', JSON.stringify(partnerOffer('A revenue share for every referral: https://edgedesksports.com/')).includes('offers money')
    && partnerOffer('Free to cite: https://edgedesksports.com/partners/').length === 0);
  settings({ partner_outreach_enabled: false });
  r = pdraft(NOTE);
  chk('P with partner outreach off the engine is refused for a partner lead, in words', has(r, /writes to partner leads only while partner outreach is on/), r.problems);

  /* ══ Q. QUALITY ═══════════════════════════════════════════════════════ */
  const clean = 'Research, not picks: try it free for 7 days, then $49.99/month. https://edgedesksports.com/';
  chk('Q a plain note passes', lint('Your CFB ratings', clean).length === 0);
  for (const [body, re] of [['Act now — this offer ends tonight. ' + clean, /urgency/], ['Only 3 spots left this week. ' + clean, /urgency/],
    ['As we discussed, here is the link. ' + clean, /familiarity/], ['Great chatting with you last week. ' + clean, /familiarity/],
    ['I am a huge fan of your work. ' + clean, /flatters/], ['Your model is incredible. ' + clean, /flatters/], ['The best analyst in the game. ' + clean, /flatters/]]) {
    chk('Q refused: ' + body.slice(0, 40), lint('Hello', body).some((x) => re.test(x)), lint('Hello', body));
  }
  const footer = one(`select growth_outbound.footer_text('https://x.supabase.co/functions/v1/growth_outbound_optout?t=abc');`);
  chk('Q every email says what it is: a commercial email from the business, for adults 21+, research not betting advice', /This is a commercial email from EdgeDesk Sports\. For adults 21\+; research, not betting advice\./.test(footer)
    && /100 Example St/.test(footer) && /opt out in one click: https:/.test(footer), footer);
  // the owner's own words are held to it too: refused when written
  const PROJ2 = +one(`select id from growth_outbound.evidence where prospect_id = ${lit(pid(2))} and field_name = 'project' order by id limit 1;`);
  r = own(`select public.growth_outbound_draft_create(${lit(pid(2))}, ${J({ sequence_number: 1, subject: 'Your CFB ratings',
    body_text: 'Hi Rae,\n\nI am a huge fan of your CFB power ratings against the market. ' + clean, claims: [{ text: 'your CFB power ratings against the market', evidence_id: PROJ2 }] })});`);
  chk('Q the owner writing a draft that flatters is refused at once, in words', r.ok === false && has(r, /flatters/), r);
  // … and a draft written before the rule existed cannot be approved
  const OD = did(1);
  one(`insert into growth_outbound.drafts (id, prospect_id, sequence_number, subject, body_text, claims)
       values (${lit(OD)}, ${lit(pid(2))}, 1, 'Your CFB ratings', ${lit('Hi Rae,\n\nAs we discussed, your CFB power ratings against the market are incredible. ' + clean)},
               ${J([{ text: 'your CFB power ratings against the market', evidence_id: PROJ2 }])});
       do $e$ begin perform growth_outbound.evaluate(${lit(pid(2))}); end $e$;`);
  r = approve(OD);
  chk('Q a draft that pretends to a conversation and flatters cannot be approved, and says why', r.ok === false && r.gates.some((g) => /flatters/.test(g))
    && r.gates.some((g) => /familiarity/.test(g)), r);

  /* ══ R. REVENUE ═══════════════════════════════════════════════════════ */
  own(`select public.growth_outbound_draft_reject(${lit(OD)}, 'flattery');`);
  r = own(`select public.growth_outbound_draft_create(${lit(pid(2))}, ${J({ sequence_number: 1, subject: 'Your CFB ratings',
    body_text: 'Hi Rae,\n\nI read your CFB power ratings against the market. ' + clean, claims: [{ text: 'your CFB power ratings against the market',
      evidence_id: +one(`select id from growth_outbound.evidence where prospect_id = ${lit(pid(2))} and field_name = 'project' order by id limit 1;`) }] })});`);
  const RD = r.draft_id;
  chk('R (setup) a clean draft is approved', approve(RD).ok === true);
  settings({ test_mode: false, confirm_live: true });
  r = claim(RD);
  chk('R (setup) live, with the endpoint checked and the webhook proven, it is claimed', r.ok === true && r.test === false, r);
  sendResult(r.send_id, 're_rev_000001');
  one(`update growth_outbound.sends set sent_at = now() - interval '3 days' where id = ${lit(r.send_id)};`);
  const RAE = row(pid(2)).email, UACC = '00000000-0000-0000-0000-0000000000b1';
  one(`insert into auth.users (id, email, email_confirmed_at, created_at) values ('${UACC}', ${lit(RAE)}, now(), now() - interval '2 days');
       insert into public.stripe_events (id, type, stripe_created, user_id, payload) values
         ('evt_r1', 'invoice.paid',              now() - interval '1 day',  '${UACC}', '{"data": {"object": {"id": "in_1", "amount_paid": 4999}}}'),
         ('evt_r2', 'invoice.payment_succeeded', now() - interval '1 day',  '${UACC}', '{"data": {"object": {"id": "in_1", "amount_paid": 4999}}}'),
         ('evt_r3', 'invoice.paid',              now() - interval '1 hour', '${UACC}', '{"data": {"object": {"id": "in_2", "amount_paid": 4999}}}'),
         ('evt_r4', 'invoice.paid',              now() - interval '1 hour', '${UACC}', '{"data": {"object": {"id": "in_3", "amount_paid": 0}}}');`);
  one(`select growth_outbound.sync_conversions();`);
  const rev = j(one(`select coalesce(jsonb_agg(to_jsonb(v)), '[]') from growth_outbound.revenue v;`));
  chk('R the account made with the address written to, after the email: its paid invoices, each once ($0 invoices are not revenue)', rev.length === 1
    && rev[0].prospect_id === pid(2) && +rev[0].paid_cents === 9998 && rev[0].invoices === 2, rev);
  chk('R … the record holds no account id or address, only a one-way key', !JSON.stringify(rev).includes(UACC) && !JSON.stringify(rev).includes(RAE) && /^[0-9a-f]{64}$/.test(rev[0].account_key));
  one(`insert into public.stripe_events (id, type, stripe_created, user_id, payload) values ('evt_r5', 'invoice.paid', now(), '${UACC}', '{"data": {"object": {"id": "in_4", "amount_paid": 4999}}}');`);
  one(`select growth_outbound.sync_conversions();`);
  chk('R … refreshed as new invoices arrive', one(`select paid_cents || '|' || invoices from growth_outbound.revenue;`) === '14997|3');
  const an = own(`select public.growth_outbound_analytics(30);`);
  chk('R the results show it: gross, with how it was traced', an.revenue && +an.revenue.paid_cents === 14997 && an.revenue.paying_accounts === 1
    && /refunds are not subtracted/.test(an.revenue.basis) && an.revenue.by_campaign.customer === 14997 && an.spend && an.spend.usd_30d > 0, an.revenue);
  let e = db.mustFail(() => one(`insert into growth_outbound.revenue (prospect_id, account_key, paid_cents) values (${lit(pid(2))}, '${'a'.repeat(64)}', 1);`));
  chk('R revenue is written by the matcher only — not even the SQL editor writes it', !!e && /only by the matcher/.test(e), e);
  e = db.mustFail(() => one(`delete from growth_outbound.revenue;`));
  chk('R … and never deleted', !!e, e);
  settings({ test_mode: true });

  /* ══ A. ATTENTION ═════════════════════════════════════════════════════ */
  hrec(null, { provider: 'hunter', state: 'quota_exhausted', detail: 'credits 25 of 25 used — resets 2026-11-01' });
  let att = j(one(`select growth_outbound.attention();`));
  chk('A a provider out of free credit needs you: said, with where to look', att.some((a) => a.code === 'provider_quota_exhausted' && /Hunter: the free credit is used up/.test(a.text) && a.severity === 2), att);
  settings({ automation_enabled: true, discovery_config: {} });
  one(`update growth_outbound.candidates set status = 'dismissed' where status = 'new';`);
  att = j(one(`select growth_outbound.attention();`));
  chk('A the morning run on with nothing to discover from: said, with the free ways to fix it', att.some((a) => a.code === 'no_discovery_source' && /Podcast Index/.test(a.text)), att);
  settings({ automation_enabled: false });

  /* ══ O. OVERVIEW ══════════════════════════════════════════════════════ */
  const ov = own(`select public.growth_outbound_research_overview();`);
  chk('O the research overview: provider health, spend, where candidates came from, who was turned away', !!ov.health.hunter && !!ov.spend.providers
    && ov.sources.manual.found >= 3 && ov.sources.domain_list.found === 2 && Array.isArray(ov.rejected) && ov.rejected.some((x) => x.status === 'dismissed'), Object.keys(ov));
  const mn = own(`select public.growth_outbound_morning();`);
  chk('O the morning: found today by source, candidates waiting, the opt-out check, partner outreach', mn.found_today.manual >= 3 && typeof mn.candidates_waiting === 'number'
    && mn.optout_check && mn.optout_check.ok === true && mn.partner_outreach === false && mn.discovery_sources.directories === 0, mn);
  const sc = j(one(`select jsonb_agg(to_jsonb(c) order by step) from growth_outbound.self_check() c;`));
  const r38 = sc.find((x) => x.step === 38);
  chk('O the System check\'s row 38 holds, saying each provider\'s state, the opt-out check and the webhook', !!r38 && /^ok — /.test(r38.outcome)
    && /hunter quota_exhausted/.test(r38.outcome) && /opt-out endpoint checked/.test(r38.outcome) && /webhook proven/.test(r38.outcome), r38);
  chk('O every check passes', sc.every((x) => /^ok/.test(x.outcome)), sc.filter((x) => !/^ok/.test(x.outcome)));
  const out = db.applyFileAtomic(FILE);
  chk('O the file runs again over all of it, every report row ok', !/CHECK THIS/.test(out));
} catch (e) {
  chk('the suite ran without an unexpected error', false, String(e && (e.sqlMessage || e.stack || e.message) || e).slice(0, 1500));
} finally {
  db.stop();
}
process.exit(T.done());
