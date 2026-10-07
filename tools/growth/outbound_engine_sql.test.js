#!/usr/bin/env node
/* ===========================================================================
   PHASE 7 — THE RESEARCH ENGINE'S RECORD, in the database
   supabase/growth_outbound.sql; the Edge Function that calls these doors is
   tools/growth/outbound_research.test.js.

     B  BUDGET     every provider call is counted against today's cap, set by
                   the owner up to a ceiling in the file; past it, refused
     R  RUNS       one row per run; at most three at once; a run that never
                   finished is marked so; finished is final
     P  PAGES      stored as read (canonical URL, hash computed here), never
                   rewritten
     C  CANDIDATES rediscovery is counted, not duplicated; a known prospect is
                   a duplicate; a domain that asked to stop is suppressed
     Q  QUOTES     an engine fact cites a stored page; the quote is on that
                   page (whole words); the claim is in the quote — an address,
                   an audience figure, a name; only a fit signal may paraphrase;
                   the engine never writes owner-verified or provider evidence
     O  OWN        whether a page is the prospect's own site or profile is
                   decided here: never a publisher's site, never a site
                   somebody else has, never what the engine says
     I  IDENTITY   a candidate becomes a prospect, or adds to the one it
                   already is; a URL or an address naming somebody else is left
                   out and said so; a suppressed address is refused; a
                   verifier's "invalid" makes the address unusable
     G  GATES      research by the engine alone clears the gates only with
                   enough independent sources; one publication does not
     N  NEVER      the engine's doors approve, draft and send nothing; owner
                   only; anon nothing

   Run: node tools/growth/outbound_engine_sql.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const crypto = require('crypto');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const SEED = require(path.join(__dirname, '_outbound_seed.js'));

const T = PG.kit('growth outbound engine SQL');
const chk = T.chk;
const lit = PG.lit;
const FILE = path.join(PG.ROOT, 'supabase', 'growth_outbound.sql');

const db = PG.start('goengine');
if (db.skip) { console.log('NOTE | ' + db.skip + ' — LIVE layer skipped'); process.exit(T.done()); }

const OWNER = '00000000-0000-0000-0000-0000000000a1';
const ADMIN = '00000000-0000-0000-0000-0000000000a2';
const SUB = '00000000-0000-0000-0000-0000000000a3';
const j = (s) => JSON.parse(s);
const one = (sql) => db.sql(sql);
const own = (sql) => j(db.as(OWNER, sql));
const J = (o) => lit(JSON.stringify(o)) + '::jsonb';
const begin = (kind, input) => own(`select public.growth_outbound_research_begin(${lit(kind)}, ${J(input || {})});`);
const spend = (run, prov, n) => own(`select public.growth_outbound_research_spend(${run}, ${lit(prov)}, ${n == null ? 1 : n});`);
const finish = (run, st, counts, err) => own(`select public.growth_outbound_research_finish(${run}, ${lit(st)}, ${J(counts || {})}, ${lit(err || null)});`);
const page = (run, url, text, o) => own(`select public.growth_outbound_page_record(${run}, ${J(Object.assign({ url, http_status: 200, content_type: 'text/html', title: 'T', text }, o || {}))});`);
const cands = (run, items) => own(`select public.growth_outbound_candidates_record(${run}, ${J(items)});`);
const ingest = (run, cand, pid, coll, p) => own(`select public.growth_outbound_research_ingest(${run}, ${cand == null ? 'null' : cand}, ${pid ? lit(pid) : 'null'}, ${lit(coll)}, ${J(p)});`);
const settings = (o) => own(`select public.growth_outbound_settings_update(${J(o)});`);
const prospect = (id) => j(one(`select to_jsonb(p) from growth_outbound.prospects p where id = ${lit(id)};`));
const evRows = (pid) => j(one(`select coalesce(jsonb_agg(to_jsonb(e) order by e.id), '[]') from growth_outbound.evidence e where prospect_id = ${lit(pid)};`));
const cand = (id) => j(one(`select to_jsonb(c) from growth_outbound.candidates c where id = ${id};`));
const count = (t, where) => +one(`select count(*) from growth_outbound.${t}${where ? ' where ' + where : ''};`);

/* the pages the tests read: a personal site, its about page, an X profile, a publication */
const PAT_HOME = 'Pat Analyst · CFB Numbers\nPat Analyst runs CFB Numbers, a college football ratings newsletter with 12,500 subscribers.\n'
  + 'Our model prices every game against the closing line.\n\nLinks:\nmailto:pat@cfbnumbers.test Email Pat\nhttps://x.com/patanalyst Twitter';
const PAT_ABOUT = 'About\nI am Pat Analyst, founder of CFB Numbers. I publish CFB power ratings against the market every week.\nContact: pat@cfbnumbers.test';
const PAT_X = 'Pat Analyst (@patanalyst) · X\nFounder, CFB Numbers. CFB power ratings against the market.';
const ESPN = 'The best college football models of 2026\nBy Staff\nPat Analyst of CFB Numbers has built one of the sharpest models in the country.';

try {
  ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql', 'growth_outbound.sql']
    .forEach((f) => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f)));
  one(`insert into auth.users (id, email, email_confirmed_at) values ('${OWNER}', 'owner@edgedesk.test', now()), ('${ADMIN}', 'admin@edgedesk.test', now()),
         ('${SUB}', 'sub@edgedesk.test', now());
       insert into public.affiliate_admins (user_id) values ('${OWNER}'), ('${ADMIN}');
       select growth_outbound.grant_owner('owner@edgedesk.test');`);

  /* ══ R. RUNS ══════════════════════════════════════════════════════════ */
  let r = begin('nonsense');
  chk('R an unknown kind of run is refused', r.ok === false && r.reason === 'invalid_kind', r);
  r = begin('discover', { query: 'cfb models' });
  chk('R a run begins: running, with today\'s budget and the saved searches', r.ok === true && r.run_id > 0 && r.budget.search.cap === 20
    && Array.isArray(r.queries) && r.shared_sites.includes('espn.com'), r);
  const RUN1 = r.run_id;
  const RUN2 = begin('research').run_id, RUN3 = begin('research').run_id;
  r = begin('research');
  chk('R at most three runs at once', r.ok === false && r.reason === 'too_many_running', r);
  one(`update growth_outbound.research_runs set started_at = now() - interval '31 minutes' where id = ${RUN3};`);
  r = begin('research');
  chk('R a run nobody finished in 30 minutes is marked failed, which frees a place', r.ok === true
    && one(`select status || '|' || error from growth_outbound.research_runs where id = ${RUN3};`) === 'failed|never finished (the function stopped)', r);
  const RUN4 = r.run_id;
  r = finish(RUN2, 'done', { pages: 0 });
  chk('R a run finishes, once', r.ok === true && r.run.status === 'done' && !!r.run.finished_at && finish(RUN2, 'done').reason === 'run_not_running', r);
  chk('R … and it is on the record', one(`select count(*) from growth_outbound.activity where action = 'research_research_done' and entity_id = '${RUN2}';`) === '1');
  r = finish(RUN4, 'nope');
  chk('R a run ends done or failed, nothing else', r.ok === false && r.reason === 'invalid_status', r);
  finish(RUN4, 'done');
  let e = db.mustFail(() => one(`delete from growth_outbound.research_runs where id = ${RUN2};`));
  chk('R runs are never deleted', !!e && /never deleted/.test(e), e);

  /* ══ B. BUDGET ════════════════════════════════════════════════════════ */
  r = spend(RUN1, 'search', 5);
  chk('B a provider call is counted against today\'s cap', r.ok === true && r.used === 5 && r.left === 15 && r.cap === 20, r);
  r = spend(RUN1, 'search', 16);
  chk('B past the cap: refused, and nothing is counted', r.ok === false && r.reason === 'budget_exhausted' && r.cap === 20 && r.used === 5, r);
  r = spend(RUN1, 'search', 15);
  chk('B … up to the cap exactly is fine', r.ok === true && r.left === 0, r);
  r = spend(RUN1, 'search', 1);
  chk('B … and then nothing more today', r.ok === false && r.reason === 'budget_exhausted', r);
  chk('B the run records what it spent', j(one(`select counts->'spent' from growth_outbound.research_runs where id = ${RUN1};`)).search === 20);
  r = settings({ discovery_config: { budget: { search: 25 } } });
  chk('B the owner raises a daily figure', r.ok === true, r);
  chk('B … and the room appears at once', spend(RUN1, 'search', 5).ok === true && spend(RUN1, 'search', 1).ok === false);
  r = settings({ discovery_config: { budget: { llm: 5000 } } });
  chk('B a figure past the ceiling in the file is refused, in words', r.ok === false && r.reason === 'invalid_value' && /llm may be at most 400 a day/.test(r.detail), r);
  for (const [bad, why] of [[{ budget: { magic: 1 } }, /unknown provider/], [{ budget: { llm: -1 } }, /whole number/], [{ queries: 'cfb' }, /list/],
    [{ queries: ['x'] }, /3 to 200/], [{ queries: ['a\nb c d'] }, /one line/], [{ shared_sites: ['https://espn.com'] }, /bare domain/], [{ surprise: true }, /unknown discovery setting/]]) {
    r = settings({ discovery_config: bad });
    chk('B a malformed discovery setting is refused: ' + JSON.stringify(bad).slice(0, 40), r.ok === false && why.test(r.detail || ''), r);
  }
  e = db.mustFail(() => one(`update growth_outbound.settings set discovery_config = '{"budget": {"fetch": 99999}}' where id = 1;`));
  chk('B … even written directly (a check on the table)', !!e && /outbound_settings_discovery/.test(e), e);
  for (const [prov, n, why] of [['coffee', 1, 'invalid_provider'], ['llm', 0, 'invalid_count'], ['llm', 51, 'invalid_count']]) {
    r = spend(RUN1, prov, n);
    chk('B refused: ' + prov + ' × ' + n, r.ok === false && r.reason === why, r);
  }
  chk('B a finished run spends nothing', spend(RUN2, 'llm', 1).reason === 'run_not_running');
  finish(RUN1, 'done');
  settings({ discovery_config: { queries: ['college football betting model newsletter', 'cfb power ratings substack'], budget: { search: 25, llm: 40 } } });
  const ov = own(`select public.growth_outbound_research_overview();`);
  chk('B the overview: the budget, the saved searches, the runs', ov.budget.llm.cap === 40 && ov.budget.search.used === 25 && ov.queries.length === 2
    && ov.runs.length >= 4 && ov.runs.every((x) => !('requested_by' in x)), ov.budget);

  /* ══ P. PAGES ═════════════════════════════════════════════════════════ */
  const RR = begin('research').run_id;
  r = page(RR, 'HTTPS://WWW.CFBNumbers.test/?utm_source=x', PAT_HOME);
  chk('P a page is stored as read, under its canonical address', r.ok === true && r.url === 'https://cfbnumbers.test' && r.site_key === 'cfbnumbers.test'
    && r.sha256 === crypto.createHash('sha256').update(PAT_HOME, 'utf8').digest('hex') && r.chars === PAT_HOME.length, r);
  const PG_HOME = r.page_id;
  const PG_ABOUT = page(RR, 'https://cfbnumbers.test/about', PAT_ABOUT).page_id;
  const PG_X = page(RR, 'https://x.com/PatAnalyst', PAT_X).page_id;
  const PG_ESPN = page(RR, 'https://www.espn.com/college-football/story/_/id/1/best-models', ESPN).page_id;
  for (const [label, p, why] of [['text over 200,000 characters', { url: 'https://a.test', http_status: 200, text: 'x'.repeat(200001) }, 'too_large'],
    ['no text', { url: 'https://a.test', http_status: 200, text: '   ' }, 'invalid'], ['not a web address', { url: 'javascript:alert(1)', http_status: 200, text: 'x' }, 'invalid'],
    ['an unknown field', { url: 'https://a.test', http_status: 200, text: 'x', sha256: 'f'.repeat(64) }, 'unknown_field'],
    ['a status that is not HTTP', { url: 'https://a.test', http_status: 99, text: 'x' }, 'invalid']]) {
    r = own(`select public.growth_outbound_page_record(${RR}, ${J(p)});`);
    chk('P refused: ' + label, r.ok === false && r.reason === why, r);
  }
  chk('P a finished run records no pages', page(RUN2, 'https://a.test', 'x').reason === 'run_not_running');
  e = db.mustFail(() => one(`update growth_outbound.pages set text = 'Pat Analyst is the greatest' where id = ${PG_ABOUT};`));
  chk('P a stored page is never rewritten — not even by the superuser', !!e && /append-only/.test(e), e);
  e = db.mustFail(() => one(`delete from growth_outbound.pages where id = ${PG_ABOUT};`));
  chk('P … nor deleted', !!e && /append-only/.test(e), e);

  /* ══ C. CANDIDATES ════════════════════════════════════════════════════ */
  one(SEED.strong({ id: '10000000-0000-0000-0000-000000000077', name: 'Kim Known', org: 'Known Media', email: 'kim@known.test', domain: 'known.test', handle: 'kimknown' }));
  one(`insert into growth_outbound.suppressions (scope, target, kind, reason, source) values ('domain', 'nope.test', 'unsubscribe', 'asked', 'owner');`);
  const RD = begin('discover').run_id;
  r = cands(RD, [
    { url: 'https://cfbnumbers.test/?utm_campaign=z', title: 'CFB Numbers', snippet: 'Ratings', query: 'cfb models', provider: 'brave' },
    { url: 'https://x.com/kimknown', title: 'Kim', provider: 'brave' },
    { url: 'https://known.test/blog/1', title: 'Known blog', provider: 'brave' },
    { url: 'https://nope.test/page', title: 'Nope', provider: 'brave' },
    { url: 'https://www.espn.com/college-football/story/_/id/1/best-models', title: 'Best models', provider: 'brave' },
    { url: 'mailto:x@y.test', provider: 'brave' }, { url: 'https://ok.test', provider: 'Brave Search' }, 'not an object']);
  chk('C discovery records what it found: new, already a prospect, asked to stop, not a web address', r.ok === true && r.new === 2 && r.duplicates === 2
    && r.suppressed === 1 && r.invalid === 3, r);
  const C_PAT = +one(`select id from growth_outbound.candidates where url = 'https://cfbnumbers.test';`);
  const C_KIM = +one(`select id from growth_outbound.candidates where url = 'https://x.com/kimknown';`);
  const C_ESPN = +one(`select id from growth_outbound.candidates where url like 'https://espn.com/%';`);
  const C_NOPE = +one(`select id from growth_outbound.candidates where url = 'https://nope.test/page';`);
  chk('C a profile a prospect already holds is a duplicate, linked to them', cand(C_KIM).status === 'duplicate' && cand(C_KIM).prospect_id === '10000000-0000-0000-0000-000000000077');
  chk('C … so is a page on their own website', one(`select status from growth_outbound.candidates where url = 'https://known.test/blog/1';`) === 'duplicate');
  chk('C a page on a domain that asked to stop is suppressed', cand(C_NOPE).status === 'suppressed');
  r = cands(RD, [{ url: 'https://www.cfbnumbers.test/?fbclid=1', provider: 'brave' }]);
  chk('C found again (another tracking tag, www.) it is counted, not added twice', r.seen_again === 1 && r.new === 0 && cand(C_PAT).times_seen === 2
    && count('candidates', `site_key = 'cfbnumbers.test'`) === 1, r);
  r = cands(RD, Array.from({ length: 51 }, (_, i) => ({ url: 'https://s' + i + '.test', provider: 'brave' })));
  chk('C at most 50 results at a time', r.ok === false && r.reason === 'invalid_items', r);
  let list = own(`select public.growth_outbound_candidates('new', 50);`);
  chk('C the queue lists the new candidates', list.length === 2 && list.some((c) => c.id === C_PAT), list.map((c) => c.url));
  r = own(`select public.growth_outbound_candidate_set(${C_ESPN}, 'dismissed', 'a listicle');`);
  chk('C the owner dismisses one, with a reason', r.ok === true && cand(C_ESPN).status === 'dismissed' && cand(C_ESPN).status_reason === 'a listicle', r);
  r = own(`select public.growth_outbound_candidate_set(${C_ESPN}, 'new', null);`);
  chk('C … and puts it back', r.ok === true && cand(C_ESPN).status === 'new', r);
  r = own(`select public.growth_outbound_candidate_set(${C_NOPE}, 'new', null);`);
  chk('C a suppressed candidate stays suppressed', r.ok === false && r.reason === 'suppressed' && cand(C_NOPE).status === 'suppressed', r);
  r = own(`select public.growth_outbound_candidate_set(${C_PAT}, 'researched', null);`);
  chk('C "researched" is set by research, never by hand', r.ok === false && r.reason === 'invalid_status', r);
  e = db.mustFail(() => one(`delete from growth_outbound.candidates where id = ${C_ESPN};`));
  chk('C candidates are never deleted', !!e && /never deleted/.test(e), e);

  /* ══ Q. QUOTES ════════════════════════════════════════════════════════ */
  const ev = (field, claim, url, pageId, excerpt, kind) => ({ field_name: field, claim, source_url: url, page_id: pageId, source_excerpt: excerpt, source_kind: kind || 'publication' });
  const PAT = (evidence, extra) => Object.assign({ email: 'pat@cfbnumbers.test', urls: ['https://cfbnumbers.test', 'https://x.com/patanalyst'], discovered_via: 'search: cfb models', evidence }, extra || {});
  const bad = [
    ['a quote that is not on the page', ev('full_name', 'Pat Analyst', 'https://cfbnumbers.test/about', PG_ABOUT, 'I am Pat Analyst, the greatest handicapper alive'), /engine_quote_not_on_page/],
    ['a claim that is not in its quote', ev('organization', 'CFB Numbers LLC', 'https://cfbnumbers.test/about', PG_ABOUT, 'founder of CFB Numbers'), /engine_claim_not_in_quote/],
    ['part of a word in the claim (Analys is not Analyst)', ev('full_name', 'Pat Analys', 'https://cfbnumbers.test', PG_HOME, 'Pat Analyst runs CFB Numbers'), /engine_claim_not_in_quote/],
    ['a quote that cuts a word (Analys)', ev('full_name', 'Pat', 'https://cfbnumbers.test', PG_HOME, 'Pat Analys'), /engine_quote_not_on_page/],
    ['an address not in its quote', ev('email', 'pat@cfbnumbers.test', 'https://cfbnumbers.test/about', PG_ABOUT, 'I am Pat Analyst, founder of CFB Numbers'), /engine_claim_not_in_quote/],
    ['an audience figure not in its quote', ev('audience_size', '125000', 'https://cfbnumbers.test', PG_HOME, 'a college football ratings newsletter with 12,500 subscribers'), /engine_claim_not_in_quote/],
    ['no page cited', Object.assign(ev('full_name', 'Pat Analyst', 'https://cfbnumbers.test/about', null, 'I am Pat Analyst'), { page_id: undefined }), /cites the stored page/],
    ['a page that is not the source', ev('full_name', 'Pat Analyst', 'https://cfbnumbers.test/about', PG_HOME, 'Pat Analyst runs CFB Numbers'), /engine_source_mismatch/],
    ['a page that does not exist', ev('full_name', 'Pat Analyst', 'https://cfbnumbers.test/about', 999999, 'I am Pat Analyst'), /not stored/],
    ['owner-verified, from the engine', ev('full_name', 'Pat Analyst', 'https://cfbnumbers.test/about', PG_ABOUT, 'I am Pat Analyst', 'owner_verified'), /never a owner_verified source|only the owner records/],
    ['a guessed address, from the engine', ev('email', 'pat@cfbnumbers.test', 'https://cfbnumbers.test/about', PG_ABOUT, 'Contact: pat@cfbnumbers.test', 'pattern_guess'), /never a pattern_guess source/]];
  for (const [label, item, why] of bad) {
    const before = count('prospects') + '|' + count('evidence');
    r = ingest(RR, null, null, 'research_engine', PAT([ev('full_name', 'Pat Analyst', 'https://cfbnumbers.test/about', PG_ABOUT, 'I am Pat Analyst'), item]));
    chk('Q refused, and nothing written (all or nothing): ' + label, r.ok === false && why.test(r.detail || '') && count('prospects') + '|' + count('evidence') === before, r.detail || r);
  }
  r = own(`select public.growth_outbound_evidence_add('10000000-0000-0000-0000-000000000077', ${J({ evidence: [ev('topic', 'Known Media', 'https://cfbnumbers.test', PG_HOME, 'CFB Numbers')] })});`);
  chk('Q the owner\'s own evidence cannot cite a stored page (that is the engine\'s)', r.ok === false && /only the research engine cites a stored page/.test(r.detail), r);
  for (const [coll, why] of [['owner', 'invalid_collector'], ['provider:Bad Name', 'invalid_collector'], [null, 'invalid_collector']]) {
    r = ingest(RR, null, null, coll, PAT([]));
    chk('Q the research door records as the engine or a named provider only: ' + coll, r.ok === false && r.reason === why, r);
  }
  r = ingest(RR, null, null, 'research_engine', Object.assign(PAT([]), { collected_by: 'owner' }));
  chk('Q … and the collector is the door\'s to set, not the payload\'s', r.ok === false && r.reason === 'unknown_field', r);

  /* the real thing: Pat, from the candidate, every fact a quote */
  const PAT_EVIDENCE = [
    ev('full_name', 'Pat Analyst', 'https://cfbnumbers.test/about', PG_ABOUT, 'I am Pat Analyst, founder of CFB Numbers'),
    ev('organization', 'CFB Numbers', 'https://cfbnumbers.test/about', PG_ABOUT, 'I am Pat Analyst, founder of CFB Numbers'),
    ev('project', 'CFB power ratings against the market', 'https://cfbnumbers.test/about', PG_ABOUT, 'I publish CFB power ratings against the market every week'),
    ev('email', 'pat@cfbnumbers.test', 'https://cfbnumbers.test/about', PG_ABOUT, 'Contact: pat@cfbnumbers.test'),
    ev('audience_size', '12500', 'https://cfbnumbers.test', PG_HOME, 'a college football ratings newsletter with 12,500 subscribers'),
    ev('fit_signal', 'prices every game with a market model', 'https://cfbnumbers.test', PG_HOME, 'Our model prices every game against the closing line'),
    ev('full_name', 'Pat Analyst', 'https://x.com/PatAnalyst', PG_X, 'Pat Analyst (@patanalyst)', 'own_site'),
    ev('organization', 'CFB Numbers', 'https://x.com/PatAnalyst', PG_X, 'Founder, CFB Numbers'),
    ev('project', 'CFB power ratings against the market', 'https://x.com/PatAnalyst', PG_X, 'CFB power ratings against the market'),
    ev('full_name', 'Pat Analyst', 'https://espn.com/college-football/story/_/id/1/best-models', PG_ESPN, 'Pat Analyst of CFB Numbers has built one of the sharpest models', 'own_site')];
  r = ingest(RR, C_PAT, null, 'research_engine', PAT(PAT_EVIDENCE, {
    fit_factors: ['quant_analysis', 'publishes_models', 'odds_markets_probability', 'ev_fair_pricing', 'covers_cfb', 'runs_newsletter_or_channel', 'discusses_clv']
      .map((code) => ({ code, evidence_index: [5] })) }));
  chk('Q every fact a quote on its page: a prospect is made', r.ok === true && r.created === true && r.evidence_ids.length === 10, r);
  const P_PAT = r.prospect_id;
  chk('I … and the candidate is researched, linked to them', cand(C_PAT).status === 'researched' && cand(C_PAT).prospect_id === P_PAT && cand(C_PAT).last_run_id === RR);
  const rows = evRows(P_PAT);
  const kindOf = (url, field) => rows.filter((x) => x.source_url === url && x.field_name === field).map((x) => x.source_kind + '|' + x.confidence + '|' + x.collected_by).join();

  /* ══ O. OWN ═══════════════════════════════════════════════════════════ */
  chk('O their website\'s pages are their OWN SITE — the database recognised it (the engine said "publication")',
    kindOf('https://cfbnumbers.test/about', 'full_name') === 'own_site|0.7|research_engine', kindOf('https://cfbnumbers.test/about', 'full_name'));
  chk('O … and an address on their own site weighs as one', kindOf('https://cfbnumbers.test/about', 'email') === 'own_site|0.9|research_engine');
  chk('O their X profile is their OWN PROFILE (the engine said "own_site"; the database decides)', kindOf('https://x.com/PatAnalyst', 'full_name') === 'own_profile|0.7|research_engine');
  chk('O a publisher\'s page is a publication, whatever the engine called it', kindOf('https://espn.com/college-football/story/_/id/1/best-models', 'full_name') === 'publication|0.55|research_engine');
  chk('O every engine fact keeps the page it came from', rows.every((x) => x.page_id > 0));
  let p = prospect(P_PAT);
  chk('G the engine\'s own sources clear identity, research and fit — the address still needs verifying (a page is not a mailbox)',
    p.status === 'needs_research' && JSON.stringify(p.assessment.gates) === JSON.stringify(['email unverified']) && p.full_name === 'Pat Analyst'
    && +p.identity_confidence >= 0.9 && +p.email_confidence >= 0.9 && p.fit_score >= 80, [p.status, p.assessment.gates, p.identity_confidence, p.email_confidence, p.fit_score]);
  r = ingest(RR, null, P_PAT, 'provider:hunter_verifier', { evidence: [{ field_name: 'email', claim: 'pat@cfbnumbers.test',
    source_url: 'https://cfbnumbers.test/about', source_kind: 'provider_verified' }], email_verdicts: [{ email: 'pat@cfbnumbers.test', status: 'valid' }] });
  p = prospect(P_PAT);
  chk('G a verifier\'s "valid" verifies it, and with that research by the engine clears every gate (qualified: ready for a draft)', r.ok === true
    && r.emails_marked_invalid === 0 && p.status === 'qualified' && p.email_status === 'verified' && p.assessment.gates.length === 0, [r.status, p.status, p.assessment.gates]);
  chk('G it was discovered by search, and says so', p.discovered_via === 'search: cfb models');

  /* a publisher is nobody's own site, even when the engine gives it as their website */
  const RO = begin('research').run_id;
  const PG_ESPN2 = page(RO, 'https://espn.com/staff/lee-writer', 'Lee Writer covers college football for ESPN.\nLinks:\nhttps://x.com/leewriter').page_id;
  r = ingest(RO, null, null, 'research_engine', { urls: ['https://espn.com/staff/lee-writer', 'https://x.com/leewriter'],
    evidence: [ev('full_name', 'Lee Writer', 'https://espn.com/staff/lee-writer', PG_ESPN2, 'Lee Writer covers college football for ESPN', 'own_site')] });
  chk('O a publisher\'s site given as someone\'s website is still a publication', r.ok === true
    && evRows(r.prospect_id)[0].source_kind === 'publication', r.ok ? evRows(r.prospect_id)[0].source_kind : r);
  /* a site somebody else already has is not "own" */
  one(SEED.strong({ id: '10000000-0000-0000-0000-000000000088', name: 'Ann First', org: 'Shared Co', email: 'ann@sharedco.test', domain: 'sharedco.test', handle: 'annfirst' }));
  const PG_SH = page(RO, 'https://sharedco.test/team/bo', 'Bo Second is the lead analyst at Shared Co.').page_id;
  r = ingest(RO, null, null, 'research_engine', { email: 'bo@other.test', urls: ['https://sharedco.test/team/bo'],
    evidence: [ev('full_name', 'Bo Second', 'https://sharedco.test/team/bo', PG_SH, 'Bo Second is the lead analyst at Shared Co', 'own_site')] });
  chk('O a site another prospect already has is nobody\'s own site', r.ok === true && evRows(r.prospect_id)[0].source_kind === 'publication', r);
  /* interview and directory are kept as said */
  const PG_POD = page(RO, 'https://pod.test/ep/9', 'Episode 9: Pat Analyst on CFB power ratings against the market').page_id;
  r = ingest(RO, null, P_PAT, 'research_engine', { evidence: [ev('project', 'CFB power ratings against the market', 'https://pod.test/ep/9', PG_POD, 'Pat Analyst on CFB power ratings against the market', 'interview')] });
  chk('O an interview stays an interview', r.ok === true && evRows(P_PAT).slice(-1)[0].source_kind === 'interview', r);

  /* ══ I. IDENTITY ══════════════════════════════════════════════════════ */
  let r2;
  const before = count('prospects');
  const PG_KIM = page(RO, 'https://x.com/kimknown', 'Kim Known (@kimknown). Writes about CFB win totals.').page_id;
  r = ingest(RO, C_KIM, null, 'research_engine', { urls: ['https://x.com/kimknown', 'https://x.com/patanalyst'],
    evidence: [ev('topic', 'CFB win totals', 'https://x.com/kimknown', PG_KIM, 'Writes about CFB win totals')] });
  r2 = ingest(RO, null, P_PAT, 'research_engine', { evidence: [ev('topic', 'CFB win totals', 'https://x.com/kimknown', PG_KIM, 'Writes about CFB win totals', 'own_profile')] });
  chk('O a profile somebody else holds (Kim\'s), cited about Pat, is a publication — never Pat\'s own profile', r2.ok === true
    && evRows(P_PAT).slice(-1)[0].source_kind === 'publication', r2);
  chk('I a candidate that is a known prospect adds to their row — no second person', r.ok === true && r.created === false
    && r.prospect_id === '10000000-0000-0000-0000-000000000077' && count('prospects') === before, r);
  chk('I a URL naming somebody else (Pat\'s profile) is left out, and said so — never merged', JSON.stringify(r.dropped) === JSON.stringify(['https://x.com/patanalyst'])
    && one(`select count(*) from growth_outbound.identifiers where value = 'x:patanalyst';`) === '1'
    && one(`select prospect_id from growth_outbound.identifiers where value = 'x:patanalyst';`) === P_PAT, r.dropped);
  r = ingest(RO, null, '10000000-0000-0000-0000-000000000077', 'research_engine', { email: 'pat@cfbnumbers.test', evidence: [] });
  chk('I … and so is an address that is somebody else\'s', r.ok === true && r.dropped.includes('pat@cfbnumbers.test')
    && prospect('10000000-0000-0000-0000-000000000077').email === 'kim@known.test', r);
  const C_ART = cands(RD, [{ url: 'https://actionnetwork.com/ncaaf/some-article', provider: 'brave' }]).candidate_ids[0];
  const PG_ART = page(RO, 'https://actionnetwork.com/ncaaf/some-article', 'By Sam Nobody. Our picks for week 6.').page_id;
  r = ingest(RO, C_ART, null, 'research_engine', { evidence: [ev('full_name', 'Sam Nobody', 'https://actionnetwork.com/ncaaf/some-article', PG_ART, 'By Sam Nobody')] });
  chk('I an article with no way to recognise its author again makes no prospect; the candidate says why', r.ok === false && r.reason === 'no_identifier'
    && cand(C_ART).status === 'failed' && /no_identifier/.test(cand(C_ART).status_reason), [r, cand(C_ART)]);
  one(`insert into growth_outbound.suppressions (scope, target, kind, reason, source) values ('address', 'gone@away.test', 'unsubscribe', 'asked', 'owner');`);
  const C_GONE = cands(RD, [{ url: 'https://away.test', provider: 'brave' }]).candidate_ids[0];
  const PG_GONE = page(RO, 'https://away.test', 'Contact: gone@away.test').page_id;
  r = ingest(RO, C_GONE, null, 'research_engine', { email: 'gone@away.test', urls: ['https://away.test'],
    evidence: [ev('email', 'gone@away.test', 'https://away.test', PG_GONE, 'Contact: gone@away.test')] });
  chk('I an address that asked to stop: refused, and the candidate is suppressed', r.ok === false && r.reason === 'suppressed' && cand(C_GONE).status === 'suppressed', r);

  /* a provider's find and a verifier's word */
  r = ingest(RO, null, P_PAT, 'provider:hunter', { evidence: [{ field_name: 'email', claim: 'pat@cfbnumbers.test', source_url: 'https://cfbnumbers.test/about', source_kind: 'provider_found' }] });
  chk('I a provider records what it found, under its own name', r.ok === true && evRows(P_PAT).slice(-1)[0].collected_by === 'provider:hunter'
    && evRows(P_PAT).slice(-1)[0].source_kind === 'provider_found', r);
  r = ingest(RO, null, P_PAT, 'provider:hunter', { evidence: [{ field_name: 'full_name', claim: 'Pat Analyst', source_url: 'https://hunter.io', source_kind: 'provider_found' }] });
  chk('I … but a provider vouches for an address only, never a name', r.ok === false && /can only support an email address/.test(r.detail), r);
  r = ingest(RO, null, P_PAT, 'provider:hunter_verifier', { email_verdicts: [{ email: 'Pat@CFBNumbers.test', status: 'invalid' }], evidence: [] });
  chk('I a verifier calling the address invalid makes it unusable: the email gate fails', r.ok === true && r.emails_marked_invalid === 1
    && prospect(P_PAT).email_invalid_at !== null && prospect(P_PAT).status === 'needs_research' && prospect(P_PAT).email_status === 'invalid',
    [r, prospect(P_PAT).status, prospect(P_PAT).email_status]);

  /* ══ G. GATES ═════════════════════════════════════════════════════════ */
  const PG_ONE = page(RO, 'https://somesite.test/post', 'Jo Single writes CFB win totals at Single Media. Email jo@single.test').page_id;
  r = ingest(RO, null, null, 'research_engine', { email: 'jo@single.test', urls: ['https://somesite.test/post'],
    evidence: [ev('full_name', 'Jo Single', 'https://somesite.test/post', PG_ONE, 'Jo Single writes CFB win totals'),
               ev('email', 'jo@single.test', 'https://somesite.test/post', PG_ONE, 'Email jo@single.test'),
               ev('project', 'CFB win totals', 'https://somesite.test/post', PG_ONE, 'Jo Single writes CFB win totals')] });
  const single = prospect(r.prospect_id);
  chk('G one source, however many facts it gives, does not clear the gates', r.ok === true && single.status === 'needs_research' && +single.identity_confidence < 0.9,
    [single.status, single.identity_confidence]);

  /* ══ N. NEVER ═════════════════════════════════════════════════════════ */
  chk('N research approved, drafted and sent nothing', count('drafts') === 0 && count('sends') === 0);
  const DOORS = [`select public.growth_outbound_research_overview();`, `select public.growth_outbound_research_begin('research', '{}');`,
    `select public.growth_outbound_research_spend(${RO}, 'llm', 1);`, `select public.growth_outbound_page_record(${RO}, '{}');`,
    `select public.growth_outbound_candidates_record(${RO}, '[]');`, `select public.growth_outbound_candidates('new', 5);`,
    `select public.growth_outbound_candidate_set(${C_ESPN}, 'dismissed', null);`,
    `select public.growth_outbound_research_ingest(${RO}, null, null, 'research_engine', '{}');`, `select public.growth_outbound_research_finish(${RO}, 'done', '{}', null);`];
  for (const sql of DOORS) {
    for (const [who, run] of [['an affiliate admin', (s) => db.as(ADMIN, s)], ['a subscriber', (s) => db.as(SUB, s)]]) {
      e = db.mustFail(() => run(sql));
      chk('N ' + who + ' is refused: ' + sql.slice(14, 52), !!e && /outbound owner only/.test(e), e);
    }
    e = db.mustFail(() => db.anon(sql));
    chk('N anon cannot even call: ' + sql.slice(14, 52), !!e && /permission denied/.test(e), e);
  }
  for (const t of ['research_runs', 'pages', 'candidates', 'provider_usage']) {
    e = db.mustFail(() => db.as(OWNER, `select count(*) from growth_outbound.${t};`));
    chk('N no client reads ' + t + ' directly — the owner neither', !!e && /permission denied/.test(e), e);
  }
  r = finish(RO, 'failed', { pages: 7 }, 'the test ended it');
  chk('N a failed run says why', r.ok === true && r.run.status === 'failed' && r.run.error === 'the test ended it' && r.run.counts.pages === 7, r);

  const rep = db.applyFileAtomic(FILE);
  chk('the file re-runs over all of this, every report row ok', !/CHECK THIS/.test(rep), rep.split('\n').filter((l) => /CHECK THIS/.test(l)));
  chk('… and reports the budget and the candidates', /^28\|research budget today: .*search 25\/25/m.test(rep) && /^29\|candidates: /m.test(rep),
    rep.split('\n').filter((l) => /^2[7-9]\|/.test(l)));
} catch (err) {
  chk('the suite ran without an unexpected error', false, String(err.sqlMessage || err.message).slice(0, 1500));
} finally {
  db.stop();
}
process.exit(T.done());
