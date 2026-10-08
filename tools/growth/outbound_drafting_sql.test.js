#!/usr/bin/env node
/* ===========================================================================
   PHASE 8 — THE DRAFTING ENGINE, in the database
   supabase/growth_outbound.sql; the Edge Function that calls these doors is
   tools/growth/outbound_draft.test.js.

     R  RUNS       an engine draft belongs to a running drafting run; a
                   drafting run spends on writing only, and the research
                   doors refuse it
     D  DUE        a first email for a qualified prospect; a follow-up only
                   to a contacted prospect, after the step before it went
                   out, once its delay has passed, while it is turned on; a
                   test prospect a first email only
     X  CONTEXT    what the engine may write from: the established first
                   name or none, the citeable facts sure enough by
                   themselves, what was already sent, the owner's lessons
     W  WORDS      every claim is this person's current, citeable, confident
                   evidence, in its own words, said in the email; at least one
     N  NAMES      "Hi <first name>," only for the established first name,
                   letter for letter; "Hi there," otherwise
     S  SPECIFICS  no name, figure or capitalised detail from nowhere; a
                   sentence about them carries a claim
     L  LINT       the content rules hold for the engine too
     I  INSERT     in it goes, pending review, unedited, the engine's, with
                   its run; one per step
     A  APPROVAL   the owner approves; the greeting is checked again against
                   the name as it stands; an owner edit is the owner's words
     F  FOLLOW-UP  proposed and sent only on the cadence
     O  OVERVIEW   who is due, how each writer's drafts fare, the lessons
     Z  NEVER      owner only; anon nothing; the report

   Run: node tools/growth/outbound_drafting_sql.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const SEED = require(path.join(__dirname, '_outbound_seed.js'));

const T = PG.kit('growth outbound drafting SQL');
const chk = T.chk;
const lit = PG.lit;
const FILE = path.join(PG.ROOT, 'supabase', 'growth_outbound.sql');

const db = PG.start('godraft');
if (db.skip) { console.log('NOTE | ' + db.skip + ' — LIVE layer skipped'); process.exit(T.done()); }

const OWNER = '00000000-0000-0000-0000-0000000000a1';
const ADMIN = '00000000-0000-0000-0000-0000000000a2';
const SUB = '00000000-0000-0000-0000-0000000000a3';
const pid = (n) => '10000000-0000-0000-0000-' + String(n).padStart(12, '0');
const did = (n) => '20000000-0000-0000-0000-' + String(n).padStart(12, '0');
const j = (s) => JSON.parse(s);
const one = (sql) => db.sql(sql);
const own = (sql) => j(db.as(OWNER, sql));
const J = (o) => lit(JSON.stringify(o)) + '::jsonb';
const begin = (kind) => own(`select public.growth_outbound_research_begin(${lit(kind)}, '{}'::jsonb);`);
const spend = (run, prov) => own(`select public.growth_outbound_research_spend(${run}, ${lit(prov)}, 1);`);
const finish = (run) => own(`select public.growth_outbound_research_finish(${run}, 'done', '{}'::jsonb, null);`);
const propose = (run, p, o) => own(`select public.growth_outbound_draft_propose(${run}, ${lit(p)}, ${J(o)});`);
const context = (p, seq) => own(`select public.growth_outbound_draft_context(${lit(p)}, ${seq == null ? 1 : seq});`);
const overview = () => own(`select public.growth_outbound_drafting_overview();`);
const settings = (o) => own(`select public.growth_outbound_settings_update(${J(o)});`);
const due = () => j(one(`select coalesce(jsonb_agg(prospect_id::text || '#' || sequence_number), '[]') from growth_outbound.drafting_due();`));
const ev = (p, field) => +one(`select id from growth_outbound.evidence where prospect_id = ${lit(p)} and field_name = ${lit(field)}
                                  and superseded_at is null order by id limit 1;`);
const ndrafts = (p) => +one(`select count(*) from growth_outbound.drafts where prospect_id = ${lit(p)};`);
const pstatus = (p) => one(`select status from growth_outbound.prospects where id = ${lit(p)};`);
const hashOf = (d) => one(`select content_hash from growth_outbound.drafts where id = ${lit(d)};`);
const approve = (d) => own(`select public.growth_outbound_draft_approve(${lit(d)}, ${lit(hashOf(d))});`);
const claim = (d) => own(`select public.growth_outbound_send_claim(${lit(d)});`);
const result = (s, id) => own(`select public.growth_outbound_send_result(${lit(s)}, ${lit(id)}, null, false);`);
const has = (r, re) => !!r && Array.isArray(r.problems) && r.problems.some((x) => re.test(x));

const PITCH = "I'm Davis, and I'm building EdgeDesk Sports: research for NFL and college football, with bet logging and results tracked against the closing line. It's research, not picks.\n\n"
  + 'If it would be useful for your work, you can try it free for 7 days at https://edgedesksports.com/ (then $49.99/month).\n\nWould it be worth a look?';
const body = (greet, about) => greet + '\n\n' + about + '\n\n' + PITCH;
const PAT_LINE = 'I came across your CFB power ratings against the market and wanted to reach out.';

try {
  ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql', 'growth_outbound.sql']
    .forEach((f) => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f)));
  one(`insert into auth.users (id, email, email_confirmed_at) values ('${OWNER}', 'owner@edgedesk.test', now()), ('${ADMIN}', 'admin@edgedesk.test', now()),
         ('${SUB}', 'sub@edgedesk.test', now());
       insert into public.affiliate_admins (user_id) values ('${OWNER}'), ('${ADMIN}');
       select growth_outbound.grant_owner('owner@edgedesk.test');`);
  settings({ postal_address: 'EdgeDesk Sports, 100 Example St, Springfield, IL 62701', test_inbox: 'owner-test@edgedesk.test',
    unsubscribe_url_base: 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/' });
  one(`select growth_outbound.set_webhook_secret('whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw');`);
  settings({ test_mode: false, confirm_live: true });

  const P1 = pid(1), P2 = pid(2), P3 = pid(3), P4 = pid(4), P6 = pid(6), P7 = pid(7);
  one(SEED.strong({ id: P1, name: 'Pat Analyst', org: 'CFB Numbers', email: 'pat@cfbnumbers.test', domain: 'cfbnumbers.test', handle: 'patanalyst' })
    + SEED.strong({ id: P2, name: 'Kim', org: 'Ratings Lab', email: 'kim@ratingslab.test', domain: 'ratingslab.test', handle: 'kimratings' })
    + SEED.weak({ id: P3, name: 'Lo Confidence', email: 'lo@maybe.test' })
    + SEED.strong({ id: P4, name: 'Ola Reed', org: 'Reed Report', email: 'ola@reedreport.test', domain: 'reedreport.test', handle: 'olareed' })
    + SEED.strong({ id: P6, name: 'Tess Test', org: 'Test Desk', email: 'owner-test@edgedesk.test', domain: 'testdesk.test', handle: 'tesstest', test: true })
    + SEED.strong({ id: P7, name: 'Vic Stone', org: 'Stone Lines', email: 'vic@stonelines.test', domain: 'stonelines.test', handle: 'vicstone' }));
  // Pat also has: a podcast only a publication mentions (0.55: below the gate), and a topic said on two of their own pages
  one(`insert into growth_outbound.evidence (prospect_id, field_name, claim, source_url, source_kind, source_excerpt, collected_by) values
         (${lit(P1)}, 'podcast', 'The Totals Hour', 'https://podnews.test/totals-hour', 'publication', 'Pat Analyst hosts The Totals Hour', 'owner'),
         (${lit(P1)}, 'topic', 'closing line value', 'https://cfbnumbers.test/clv', 'own_site', 'why closing line value matters', 'owner'),
         (${lit(P1)}, 'topic', 'closing line value', 'https://x.com/patanalyst/status/9', 'own_profile', 'closing line value, again', 'owner');
       do $e$ begin perform growth_outbound.evaluate(${lit(P1)}); end $e$;`);
  const PROJ1 = ev(P1, 'project'), ORG1 = ev(P1, 'organization'), EMAIL1 = ev(P1, 'email'), FIT1 = ev(P1, 'fit_signal'), NAME1 = ev(P1, 'full_name');
  const POD1 = ev(P1, 'podcast'), TOPIC1 = ev(P1, 'topic'), PROJ2 = ev(P2, 'project'), PROJ4 = ev(P4, 'project'), PROJ6 = ev(P6, 'project');
  chk('(seed) Pat, Kim and Ola are qualified; Lo is not; Tess is a test prospect', [P1, P2, P4].every((p) => pstatus(p) === 'qualified')
    && pstatus(P3) === 'needs_research' && pstatus(P6) === 'qualified');
  chk('(seed) Pat\'s first name is established; Kim\'s is not (one name is no first name)',
    one(`select coalesce(first_name, '-') from growth_outbound.prospects where id = ${lit(P1)};`) === 'Pat'
    && one(`select coalesce(first_name, '-') from growth_outbound.prospects where id = ${lit(P2)};`) === '-');
  const GOOD = (o) => Object.assign({ sequence_number: 1, subject: 'A research tool for your work', body_text: body('Hi Pat,', PAT_LINE),
    claims: [{ text: 'CFB power ratings against the market', evidence_id: PROJ1 }], generator: 'engine:claude:p1' }, o || {});

  /* ══ R. RUNS ══════════════════════════════════════════════════════════ */
  let r = begin('draft');
  chk('R a drafting run begins', r.ok === true && r.run_id > 0, r);
  const DR = r.run_id;
  chk('R a drafting run spends on writing', spend(DR, 'llm').ok === true);
  for (const prov of ['search', 'fetch', 'email_finder', 'email_verifier']) {
    r = spend(DR, prov);
    chk('R … and on nothing else: ' + prov, r.ok === false && r.reason === 'wrong_run_kind', r);
  }
  r = own(`select public.growth_outbound_page_record(${DR}, ${J({ url: 'https://cfbnumbers.test/', http_status: 200, text: 'Pat' })});`);
  chk('R a drafting run reads no pages', r.ok === false && r.reason === 'wrong_run_kind', r);
  r = own(`select public.growth_outbound_candidates_record(${DR}, ${J([{ url: 'https://x.test/', provider: 'brave' }])});`);
  chk('R … records no candidates', r.ok === false && r.reason === 'wrong_run_kind', r);
  r = own(`select public.growth_outbound_research_ingest(${DR}, null, ${lit(P1)}, 'research_engine', '{}'::jsonb);`);
  chk('R … and records no evidence', r.ok === false && r.reason === 'wrong_run_kind', r);
  const RR = begin('research').run_id;
  r = propose(RR, P1, GOOD());
  chk('R a research run proposes no draft', r.ok === false && r.reason === 'wrong_run_kind' && ndrafts(P1) === 0, r);
  finish(RR);
  const DONE = begin('draft').run_id;
  finish(DONE);
  chk('R a finished drafting run proposes nothing', propose(DONE, P1, GOOD()).reason === 'run_not_running');
  chk('R … nor a run that does not exist', propose(987654, P1, GOOD()).reason === 'run_not_running');

  /* ══ D. DUE ═══════════════════════════════════════════════════════════ */
  let list = due();
  chk('D due now: a first email for each qualified real prospect', list.includes(P1 + '#1') && list.includes(P2 + '#1') && list.includes(P4 + '#1')
    && list.includes(P7 + '#1'), list);
  chk('D … not the prospect who does not qualify, not a test prospect, and no follow-up yet', !list.some((x) => x.startsWith(P3) || x.startsWith(P6))
    && !list.some((x) => !x.endsWith('#1')), list);
  r = context(P3);
  chk('D a prospect below the gates is not due, and the reason is the gates', r.ok === true && r.due === false && /^not qualified \(needs_research: /.test(r.problem), r);
  r = context(P1, 2);
  chk('D a follow-up goes only to a prospect who was contacted', r.due === false && /contacted and has not answered \(this one is qualified\)/.test(r.problem), r);
  chk('D a test prospect: a first email only', context(P6, 1).due === true && context(P6, 2).problem === 'a test prospect gets a first email only');
  chk('D the steps are 1 to 3', context(P1, 4).problem === 'the steps are 1, 2 and 3' && context(P1, 0).due === false);
  chk('D an unknown prospect', context('10000000-0000-0000-0000-00000000ffff').reason === 'not_found');
  r = propose(DR, P3, Object.assign(GOOD(), { claims: [{ text: 'a sports show', evidence_id: ev(P3, 'project') }] }));
  chk('D a draft for a prospect not due is refused before anything else, and nothing is written', r.ok === false && r.reason === 'not_due'
    && /^not qualified/.test(r.detail) && ndrafts(P3) === 0, r);

  /* ══ X. CONTEXT ═══════════════════════════════════════════════════════ */
  r = context(P1);
  chk('X the context: due, the established first name, who signs', r.ok && r.due === true && r.problem === null && r.first_name === 'Pat'
    && r.sender.name === 'Davis' && r.sender.cta_url === 'https://edgedesksports.com/' && r.min_research_confidence === 0.85, r);
  const fids = r.facts.map((f) => f.evidence_id);
  chk('X the facts it may cite: what they run and make, each sure enough by itself', fids.includes(PROJ1) && fids.includes(ORG1) && fids.includes(TOPIC1)
    && r.facts.every((f) => f.confidence >= 0.85 && ['organization', 'job_title', 'project', 'article', 'podcast', 'newsletter', 'model', 'topic', 'sports_focus'].includes(f.field)), r.facts);
  chk('X … never their address, their name, a fit signal, or a fact only a publication states', ![EMAIL1, NAME1, FIT1, POD1].some((x) => fids.includes(x)), fids);
  chk('X … one line per claim, however many sources say it', new Set(r.facts.map((f) => f.field + '|' + f.claim)).size === r.facts.length, r.facts);
  chk('X … each with its words, its quote and where it was said', r.facts.every((f) => f.claim && 'quote' in f && /^https:\/\//.test(f.source_url) && f.source_kind), r.facts[0]);
  chk('X nothing sent yet, no lessons yet', Array.isArray(r.previous) && r.previous.length === 0 && Array.isArray(r.lessons) && r.lessons.length === 0, r);
  chk('X no first name for Kim: the engine is told none', context(P2).first_name === null);

  /* ══ W. WORDS: every claim ════════════════════════════════════════════ */
  const n0 = ndrafts(P1);
  const refusedOnly = (o, re, why, exact) => {
    const x = propose(DR, P1, GOOD(o));
    chk('W ' + why, x.ok === false && x.reason === 'refused' && has(x, re) && (!exact || x.problems.length === 1) && ndrafts(P1) === n0, x);
    return x;
  };
  refusedOnly({ claims: [{ text: 'CFB power ratings against the market', evidence_id: PROJ2 }] }, /cites evidence \d+, which is not current evidence about this person/,
    'a claim citing someone else\'s evidence is refused, and nothing is written');
  refusedOnly({ body_text: body('Hi Pat,', 'I saw pat@cfbnumbers.test on your site.'), claims: [{ text: 'pat@cfbnumbers.test', evidence_id: EMAIL1 }] },
    /cites their email, which an email does not cite/, 'an email never cites their address');
  refusedOnly({ body_text: body('Hi Pat,', 'I hear your work prices every game with a market model.'), claims: [{ text: 'prices every game with a market model', evidence_id: FIT1 }] },
    /cites their fit signal, which an email does not cite/, '… nor a fit signal (the research engine\'s own reading)', true);
  refusedOnly({ claims: [{ text: 'CFB power ratings against the market', evidence_id: PROJ1 }, { text: 'Pat Analyst', evidence_id: NAME1 }] },
    /cites their full name/, '… nor their name');
  refusedOnly({ body_text: body('Hi Pat,', 'I came across your podcast, The Totals Hour.'), claims: [{ text: 'The Totals Hour', evidence_id: POD1 }] },
    /"The Totals Hour" rests on evidence only 0\.55 sure \(the research gate is 0\.85\)/, 'a fact only one publication states is not sure enough by itself', true);
  refusedOnly({ body_text: body('Hi Pat,', 'I came across your CFB power ratings that beat the market.'), claims: [{ text: 'CFB power ratings that beat the market', evidence_id: PROJ1 }] },
    /is not in the words of evidence/, 'a claim in words the evidence does not use ("beat" for "against") is refused', true);
  let x = refusedOnly({ body_text: body('Hi Pat,', 'I came across your CFB ratings.') }, /is cited, but the email does not say it in those words/,
    'a claim the email does not say, in those words, is refused');
  chk('W … and the sentence that says something else about them cites nothing', has(x, /without a cited claim: "I came across your CFB ratings\."/), x.problems);
  refusedOnly({ claims: [] }, /says at least one thing about them, cited/, 'a real prospect\'s email makes at least one cited claim', false);
  const sup = own(`select public.growth_outbound_evidence_supersede(${TOPIC1}, 'a later page says otherwise');`);
  refusedOnly({ body_text: body('Hi Pat,', 'I read your take on closing line value.'), claims: [{ text: 'closing line value', evidence_id: TOPIC1 }] },
    /which is not current evidence about this person/, 'superseded evidence is not cited');
  chk('W (setup) the supersede was the owner\'s', sup.ok === true, sup);
  for (const [o, why, re] of [
    [{ claims: [{ text: 'CFB power ratings against the market' }] }, 'a claim without its evidence', 'invalid_claims'],
    [{ claims: [{ text: 'CFB power ratings against the market', evidence_id: String(PROJ1) }] }, 'an evidence id that is not a number', 'invalid_claims'],
    [{ claims: [{ text: 'CF', evidence_id: PROJ1 }] }, 'a claim of two letters', 'invalid_claims'],
    [{ claims: Array(6).fill({ text: 'CFB power ratings against the market', evidence_id: PROJ1 }) }, 'six claims', 'invalid_claims'],
    [{ claims: 'CFB' }, 'claims that are not a list', 'invalid_claims'],
    [{ greeting_name: 'Pat' }, 'a greeting name (the database reads it from the greeting)', 'unknown_field'],
    [{ status: 'approved' }, 'a status', 'unknown_field'],
    [{ generator: 'owner' }, 'a writer that is not the engine', 'invalid_generator'],
    [{ generator: 'engine:Claude:p1' }, 'a malformed writer', 'invalid_generator'],
    [{ sequence_number: '1' }, 'a step as text', 'invalid_sequence'],
    [{ sequence_number: 4 }, 'step 4', 'invalid_sequence'],
    [{ subject: 7 }, 'a subject that is not text', 'invalid_content']]) {
    r = propose(DR, P1, GOOD(o));
    chk('W refused: ' + why, r.ok === false && r.reason === re && ndrafts(P1) === n0, r);
  }
  r = propose(DR, P1, GOOD({ subject: 'Hi' }));
  chk('W a subject of 3 to 80 characters', has(r, /the subject is 3 to 80 characters/), r);
  r = propose(DR, P1, GOOD({ body_text: 'Hi Pat,\nAt CFB Numbers? Try it.', claims: [{ text: 'CFB Numbers', evidence_id: ORG1 }] }));
  chk('W a body of 40 characters at least', has(r, /the body is 40 to 1,500 characters/) && ndrafts(P1) === n0, r);

  /* ══ N. NAMES ═════════════════════════════════════════════════════════ */
  r = propose(DR, P1, GOOD({ body_text: body('Hi Patrick,', PAT_LINE) }));
  chk('N a name that is not the established first name is refused', has(r, /the greeting names "Patrick", but their established first name is "Pat"/) && ndrafts(P1) === n0, r.problems);
  r = propose(DR, P1, GOOD({ body_text: body('Hi pat,', PAT_LINE) }));
  chk('N … letter for letter', has(r, /names "pat", but their established first name is "Pat"/), r.problems);
  r = propose(DR, P1, GOOD({ body_text: 'Pat, ' + body('', PAT_LINE).trim() }));
  chk('N an email that does not open with a greeting line is refused', has(r, /opens with "Hi there," or "Hi <their first name>," on a line of its own/), r.problems);
  r = propose(DR, P1, GOOD({ body_text: body('Hi Pat, ' + PAT_LINE, '') }));
  chk('N … the greeting is a line of its own', has(r, /on a line of its own/), r.problems);
  const KIM = (greet) => ({ sequence_number: 1, subject: 'A research tool for your work', generator: 'engine:claude:p1',
    body_text: body(greet, 'I came across your CFB power ratings against the market and wanted to reach out.'),
    claims: [{ text: 'CFB power ratings against the market', evidence_id: PROJ2 }] });
  r = propose(DR, P2, KIM('Hi Kim,'));
  chk('N with no established first name, a name is a guess: refused', has(r, /names "Kim", but no first name is established for this person: it is "Hi there,"/)
    && ndrafts(P2) === 0, r.problems);
  r = propose(DR, P2, KIM('Hi there,'));
  chk('N … "Hi there," is the greeting', r.ok === true && pstatus(P2) === 'ready_for_review', r);
  const DK = r.draft_id;
  chk('N … stored without a greeting name', one(`select coalesce(greeting_name, '-') from growth_outbound.drafts where id = ${lit(DK)};`) === '-');

  /* ══ S. SPECIFICS ═════════════════════════════════════════════════════ */
  r = propose(DR, P1, GOOD({ body_text: body('Hi Pat,', PAT_LINE + ' Your 2024 Heisman model was great.') }));
  chk('S a figure and a name from nowhere are refused, each named', has(r, /^"2024" comes from no cited claim$/) && has(r, /^"Heisman" comes from no cited claim$/), r.problems);
  chk('S … and the sentence about them that cites nothing', has(r, /without a cited claim: "Your 2024 Heisman model was great\."/), r.problems);
  r = propose(DR, P1, GOOD({ body_text: body('Hi Pat,', PAT_LINE + ' I also enjoyed your newsletter.') }));
  chk('S "your newsletter", uncited, is a statement about them: refused', has(r, /without a cited claim: "I also enjoyed your newsletter\."/) && r.problems.length === 1, r.problems);
  r = propose(DR, P1, GOOD({ body_text: body('Hi Pat,', PAT_LINE + ' I loved the episode with Bill Simmons.') }));
  chk('S somebody else\'s name, uncited, is refused', has(r, /"Bill" comes from no cited claim/) && has(r, /"Simmons" comes from no cited claim/), r.problems);
  r = propose(DR, P1, GOOD({ body_text: body('Hi Pat,', PAT_LINE + ' EdgeDesk also covers the NBA.') }));
  chk('S … and so is a product claim with a capitalised detail EdgeDesk\'s own words do not have', has(r, /"NBA" comes from no cited claim/), r.problems);
  r = propose(DR, P1, GOOD({ body_text: body('Hi Pat,', PAT_LINE + '\n\nNBA fans love it. DraftKings users too.') }));
  chk('S … at the start of a sentence too: an all-capitals word, a brand', has(r, /^"NBA" comes from no cited claim$/) && has(r, /^"DraftKings" comes from no cited claim$/), r.problems);
  r = propose(DR, P1, GOOD({ subject: 'About your CFB power ratings' }));
  chk('S the subject is read too ("your CFB power ratings" without the whole claim)', has(r, /without a cited claim: "About your CFB power ratings"/), r.problems);

  /* ══ L. LINT ══════════════════════════════════════════════════════════ */
  r = propose(DR, P1, GOOD({ body_text: body('Hi Pat,', PAT_LINE).replace('Would it be worth a look?', 'Guaranteed profits for $19 with a 14-day free trial: https://evil.test/x') }));
  chk('L the content rules hold for the engine: winnings, price, trial, links', has(r, /content: promises winnings/) && has(r, /content: the price is \$49\.99\/month/)
    && has(r, /content: the free trial is 7 days/) && has(r, /content: links go to edgedesksports\.com only/) && ndrafts(P1) === n0, r.problems);

  /* ══ I. INSERT ════════════════════════════════════════════════════════ */
  r = propose(DR, P1, GOOD({ body_text: body('Hi Pat,', PAT_LINE).replace(/\n/g, '\r\n') + '   ' }));
  chk('I a draft that gets everything right goes into the queue; the prospect is ready for review', r.ok === true && !!r.draft_id && r.status === 'ready_for_review', r);
  const D1 = r.draft_id;
  const row = j(one(`select to_jsonb(d) from growth_outbound.drafts d where id = ${lit(D1)};`));
  chk('I … pending review, unedited, the engine\'s, with its run', row.status === 'pending_review' && row.edited_by_owner === false
    && row.generator_version === 'engine:claude:p1' && row.run_id === DR && row.greeting_name === 'Pat' && !row.approved_at, row);
  chk('I … the words as proposed, line endings made plain', row.body_text === body('Hi Pat,', PAT_LINE) && row.subject === 'A research tool for your work'
    && row.content_hash === r.content_hash, row.body_text);
  chk('I … with its claims', JSON.stringify(row.claims) === JSON.stringify([{ text: 'CFB power ratings against the market', evidence_id: PROJ1 }]), row.claims);
  chk('I … on the record, with its writer and run', one(`select detail->>'generator' || '|' || (detail->>'run') || '|' || (detail->>'claims')
      from growth_outbound.activity where action = 'draft_proposed' and entity_id = ${lit(D1)};`) === 'engine:claude:p1|' + DR + '|1');
  chk('I … research confidence is now its cited claim\'s', +one(`select research_confidence from growth_outbound.prospects where id = ${lit(P1)};`) === 0.91);
  r = propose(DR, P1, GOOD());
  chk('I one draft per step: a second is not due', r.ok === false && r.reason === 'not_due' && r.detail === 'a draft for this step is already waiting', r);
  const q = own(`select public.growth_outbound_review_queue('pending_review', 50);`);
  const card = q.rows.find((c) => c.draft.id === D1);
  chk('I the review card says who wrote it, and that the greeting is right', !!card && card.draft.generator_version === 'engine:claude:p1'
    && card.draft.edited_by_owner === false && card.greeting_problem === null && card.claims_missing.length === 0 && card.lint.length === 0, card && card.greeting_problem);
  r = propose(DR, P6, { sequence_number: 1, subject: 'A research tool for your work', body_text: body('Hi Tess,', 'A note to try the whole path.'), claims: [], generator: 'engine:template:p1' });
  chk('I a test prospect\'s draft may cite nothing (it only ever goes to your own inbox)', r.ok === true
    && one(`select is_test || '|' || generator_version from growth_outbound.drafts where id = ${lit(r.draft_id)};`) === 'true|engine:template:p1', r);
  const D6 = r.draft_id;

  /* ══ A. APPROVAL ══════════════════════════════════════════════════════ */
  r = approve(D1);
  chk('A the owner approves the engine\'s draft (the engine has no door that approves)', r.ok === true, r);
  own(`select public.growth_outbound_draft_unapprove(${lit(D1)}, 'checking the name');`);
  // the evidence changes: the name on both their pages is now "Patricia Analyst"
  for (const id of j(one(`select jsonb_agg(id) from growth_outbound.evidence where prospect_id = ${lit(P1)} and field_name = 'full_name' and superseded_at is null;`))) {
    own(`select public.growth_outbound_evidence_supersede(${id}, 'renamed');`);
  }
  one(`insert into growth_outbound.evidence (prospect_id, field_name, claim, source_url, source_kind, source_excerpt, collected_by) values
         (${lit(P1)}, 'full_name', 'Patricia Analyst', 'https://cfbnumbers.test/about', 'own_site', 'I am Patricia Analyst', 'owner'),
         (${lit(P1)}, 'full_name', 'Patricia Analyst', 'https://x.com/patanalyst', 'own_profile', 'Patricia Analyst (@patanalyst)', 'owner');
       do $e$ begin perform growth_outbound.evaluate(${lit(P1)}); end $e$;`);
  chk('A (setup) the first name is now Patricia; the prospect still clears every gate', one(`select first_name || '|' || status from growth_outbound.prospects where id = ${lit(P1)};`) === 'Patricia|ready_for_review');
  r = approve(D1);
  chk('A the engine\'s "Hi Pat," no longer matches the name as it stands: not approved', r.ok === false && r.reason === 'below_gate'
    && r.gates.some((g) => /^greeting: the greeting names "Pat", but their established first name is "Patricia"$/.test(g)), r);
  chk('A … and the review card says so', own(`select public.growth_outbound_review_queue('pending_review', 50);`).rows.find((c) => c.draft.id === D1).greeting_problem
    === 'the greeting names "Pat", but their established first name is "Patricia"');
  r = own(`select public.growth_outbound_draft_edit(${lit(D1)}, 'A research tool for your work', ${lit(body('Hi Patricia,', PAT_LINE))}, ${lit(hashOf(D1))});`);
  chk('A the owner fixes it: an edit is the owner\'s words', r.ok === true && one(`select edited_by_owner::text from growth_outbound.drafts where id = ${lit(D1)};`) === 'true', r);
  chk('A … and it is approved', approve(D1).ok === true);
  r = own(`select public.growth_outbound_draft_edit(${lit(DK)}, 'A research tool for your work', ${lit(body('Hi Kim,', 'I came across your CFB power ratings against the market and wanted to reach out.'))}, ${lit(hashOf(DK))});`);
  chk('A the owner may name someone the evidence does not name (their call, their words)', r.ok === true && approve(DK).ok === true, r);

  /* ══ F. FOLLOW-UPS ════════════════════════════════════════════════════ */
  one(SEED.draft({ id: did(14), prospect: P4, subject: 'An earlier try', body: 'Hi Ola,' }));
  own(`select public.growth_outbound_draft_reject(${lit(did(14))}, 'not my style');`);
  one(SEED.draft({ id: did(4), prospect: P4, subject: 'Your ratings', body: 'Hi Ola,' }));
  approve(did(4));
  r = claim(did(4));
  const S4 = r.send_id;
  chk('F (setup) Ola\'s first email goes out, live', r.ok === true && r.test === false && result(S4, 'msg_live_004').state === 'sent' && pstatus(P4) === 'contacted', r);
  r = context(P4, 2);
  chk('F follow-up 1 is not due before its delay', r.due === false && /^not due until \d{4}-\d\d-\d\d \d\d:\d\d UTC$/.test(r.problem) && !due().includes(P4 + '#2'), r);
  const FU = (o) => Object.assign({ sequence_number: 2, subject: 'Following up: EdgeDesk Sports', generator: 'engine:claude:p1',
    body_text: 'Hi Ola,\n\nFollowing up on my note about your CFB power ratings against the market.\n\n'
      + 'EdgeDesk Sports keeps NFL and college football research, bet logging and closing-line tracking in one place. The 7-day free trial is at https://edgedesksports.com/ if you want to look (then $49.99/month).\n\n'
      + 'If it\'s not for you, just reply "stop" and I won\'t write again.',
    claims: [{ text: 'CFB power ratings against the market', evidence_id: PROJ4 }] }, o || {});
  r = propose(DR, P4, FU());
  chk('F … and not proposed before it', r.ok === false && r.reason === 'not_due' && /^not due until/.test(r.detail), r);
  one(`update growth_outbound.sends set sent_at = now() - interval '5 days 1 minute' where id = ${lit(S4)};`);
  list = due();
  chk('F once the delay has passed it is due, ahead of first emails', list[0] === P4 + '#2' && list.includes(P7 + '#1'), list);
  r = context(P4, 2);
  chk('F … and the engine sees what was SENT (not the draft you rejected)', r.due === true && r.previous.length === 1 && r.previous[0].sequence_number === 1
    && r.previous[0].subject === 'Your ratings' && !!r.previous[0].sent_at, r.previous);
  settings({ followup_enabled: false });
  chk('F not while follow-ups are turned off', context(P4, 2).problem === 'follow-ups are turned off in the settings' && !due().includes(P4 + '#2'));
  settings({ followup_enabled: true });
  r = propose(DR, P4, FU());
  chk('F the engine\'s follow-up goes in; the prospect stays contacted', r.ok === true && pstatus(P4) === 'contacted', r);
  const F4 = r.draft_id;
  chk('F … approved and sent as step 2', approve(F4).ok === true && claim(F4).ok === true);
  const S42 = one(`select id from growth_outbound.sends where draft_id = ${lit(F4)};`);
  chk('F the final follow-up is off unless turned on', context(P4, 3).problem === 'the final follow-up is turned off in the settings');
  settings({ final_followup_enabled: true });
  chk('F … then it waits for follow-up 1 to go out', context(P4, 3).problem === 'step 2 has not gone out (or it bounced)');
  result(S42, 'msg_live_042');
  chk('F … and for its own delay', /^not due until/.test(context(P4, 3).problem));
  one(`update growth_outbound.sends set sent_at = now() - interval '10 days 1 minute' where id = ${lit(S42)};`);
  chk('F … then it is due', context(P4, 3).due === true && due().includes(P4 + '#3'));
  // a first email that went out and then FAILED (Resend's failed event) never counts as sent
  const P8 = pid(8);
  one(SEED.strong({ id: P8, name: 'Wes Bloom', org: 'Bloom Totals', email: 'wes@bloomtotals.test', domain: 'bloomtotals.test', handle: 'wesbloom' })
    + SEED.draft({ id: did(8), prospect: P8, subject: 'Your ratings', body: 'Hi Wes,' }));
  approve(did(8));
  const S8 = claim(did(8)).send_id;
  result(S8, 'msg_live_008');
  one(`update growth_outbound.sends set delivery_status = 'failed', failed_at = now(), sent_at = now() - interval '6 days' where id = ${lit(S8)};`);
  chk('F a first email that failed after it went out: follow-up 1 is not due', pstatus(P8) === 'contacted' && context(P8, 2).problem === 'step 1 has not gone out (or it bounced)');
  one(`insert into growth_outbound.drafts (id, prospect_id, sequence_number, subject, body_text, claims)
       select ${lit(did(18))}, ${lit(P8)}, 2, 'Following up', 'Hi Wes, following up on your CFB power ratings against the market.',
              jsonb_build_array(jsonb_build_object('text', 'your CFB power ratings against the market', 'evidence_id', ${ev(P8, 'project')}));`);
  chk('F (setup) a follow-up written anyway is approved by the owner', approve(did(18)).ok === true);
  r = claim(did(18));
  chk('F … and the send trigger still refuses it: step 1 never stayed out', r.ok === false && /step 2 goes out only after step 1 did/.test(r.detail), r);
  own(`select public.growth_outbound_prospect_replied(${lit(P4)}, 'interested', false);`);
  chk('F a reply ends the sequence: nothing more is due', context(P4, 3).problem === 'this prospect is replied' && !due().some((x) => x.startsWith(P4)));

  /* ══ O. OVERVIEW AND LESSONS ═════════════════════════════════════════ */
  const DR2 = begin('draft').run_id;
  const P5 = pid(5);
  one(SEED.strong({ id: P5, name: 'Uma Vale', org: 'Vale Models', email: 'uma@valemodels.test', domain: 'valemodels.test', handle: 'umavale' }));
  r = propose(DR2, P5, { sequence_number: 1, subject: 'A research tool for your work', generator: 'engine:claude:p1',
    body_text: body('Hi Uma,', 'I came across your CFB power ratings against the market and wanted to reach out.'),
    claims: [{ text: 'CFB power ratings against the market', evidence_id: ev(P5, 'project') }] });
  chk('O (setup) a draft for Uma', r.ok === true, r);
  own(`select public.growth_outbound_draft_reject(${lit(r.draft_id)}, 'too long; say what EdgeDesk does in one line');`);
  chk('O a step whose draft the owner just rejected leaves the due list (the engine does not argue)', !due().includes(P5 + '#1'));
  chk('O … but the owner can still ask for one', context(P5).due === true);
  // giving up: on the record, out of the due list for a week, back when new evidence arrives
  chk('O (setup) Vic is due a first email', due().includes(P7 + '#1'));
  const RR2 = begin('research').run_id;
  for (const [run, pp, seq, why] of [[RR2, P7, 1, 'wrong_run_kind'], [DONE, P7, 1, 'run_not_running'], [DR2, P7, 0, 'invalid_sequence'],
    [DR2, '10000000-0000-0000-0000-00000000ffff', 1, 'not_found']]) {
    r = own(`select public.growth_outbound_draft_gave_up(${run}, ${lit(pp)}, ${seq}, '[]'::jsonb);`);
    chk('O giving up is refused: ' + why, r.ok === false && r.reason === why, r);
  }
  r = own(`select public.growth_outbound_draft_gave_up(${DR2}, ${lit(P7)}, 1, ${J(['content: promises winnings, a lock or a guarantee', 'x'.repeat(400)])});`);
  chk('O the engine gives up on a step: on the record, with its reasons (each cut to 300 characters)', r.ok === true
    && one(`select (detail->>'sequence') || '|' || (detail->>'run') || '|' || jsonb_array_length(detail->'reasons') || '|' || length(detail->'reasons'->>1)
      from growth_outbound.activity where action = 'draft_gave_up' and prospect_id = ${lit(P7)};`) === '1|' + DR2 + '|2|300', r);
  finish(RR2);
  chk('O … the due list leaves that step alone', !due().includes(P7 + '#1'));
  chk('O … the owner can still ask for it', context(P7).due === true);
  one(`insert into growth_outbound.evidence (prospect_id, field_name, claim, source_url, source_kind, source_excerpt, collected_by)
       values (${lit(P7)}, 'topic', 'win totals', 'https://stonelines.test/totals', 'own_site', 'our win totals', 'owner');`);
  chk('O … and new evidence brings it back', due().includes(P7 + '#1'));
  r = context(P1);
  chk('O the owner\'s reasons for rejecting ENGINE drafts reach the engine as lessons (not the reasons for rejecting your own)',
    JSON.stringify(r.lessons) === JSON.stringify(['too long; say what EdgeDesk does in one line']), r.lessons);
  const ov = overview();
  chk('O the overview: today\'s writing budget, the cadence', ov.llm_budget.cap === 30 && ov.llm_budget.used === 1 && ov.cadence.final_followup_enabled === true
    && ov.cadence.followup_delay_days === 5, ov);
  chk('O … who is due, by name', ov.due_counts.first === ov.due.filter((d) => d.sequence_number === 1).length && Array.isArray(ov.due)
    && ov.due.every((d) => d.prospect_id && d.full_name), ov.due);
  chk('O … how each writer\'s drafts fare', ov.stats.engine.drafts === 4 && ov.stats.engine.approved_after_edit === 2 && ov.stats.engine.rejected === 1
    && ov.stats.engine.sent === 1 && ov.stats.engine.approved_as_written === 1 && ov.stats.engine.replied === 1 && ov.stats.owner.sent === 2 && !ov.stats.template, ov.stats);
  chk('O … the drafting runs, and only those', ov.runs.length === 3 && ov.runs.every((x) => x.kind === 'draft' && !('requested_by' in x)), ov.runs.map((x) => x.kind));
  chk('O … and the lessons', ov.lessons.length === 1);

  /* ══ Z. NEVER ═════════════════════════════════════════════════════════ */
  for (const sql of [`select public.growth_outbound_draft_context(${lit(P1)}, 1);`, `select public.growth_outbound_draft_propose(${DR}, ${lit(P1)}, ${J(GOOD())});`,
    `select public.growth_outbound_drafting_overview();`, `select public.growth_outbound_draft_gave_up(${DR}, ${lit(P1)}, 1, '[]'::jsonb);`]) {
    let e = db.mustFail(() => db.as(ADMIN, sql));
    chk('Z an affiliate admin who is not an owner is refused: ' + sql.slice(14, 50), !!e && /outbound owner only/.test(e), e);
    e = db.mustFail(() => db.as(SUB, sql));
    chk('Z … a subscriber too', !!e && /outbound owner only/.test(e), e);
    e = db.mustFail(() => db.anon(sql));
    chk('Z … and anon cannot even call it', !!e && /permission denied/.test(e), e);
  }
  for (const f of ['step_due_problem(uuid,integer)', 'uncited_details(text,text)', 'greeting_problem(text,text)', 'drafting_due()']) {
    const e = db.mustFail(() => db.as(OWNER, `select growth_outbound.${f.replace(/\(.*/, '')}(${f.includes('uuid') ? `'${P1}', 1` : f.includes('text,text') ? "'a', 'b'" : ''});`));
    chk('Z the helpers are not doors, not even for the owner: ' + f, !!e && /permission denied/.test(e), e);
  }
  chk('Z every engine draft went in pending review, none approved by the engine', one(`select count(*) from growth_outbound.activity
      where action = 'draft_approved' and actor_user_id is distinct from '${OWNER}';`) === '0');
  chk('Z (and the test draft is still waiting for you)', one(`select status from growth_outbound.drafts where id = ${lit(D6)};`) === 'pending_review');
  finish(DR); finish(DR2);

  const rep = db.applyFileAtomic(FILE);
  chk('the file re-runs over all of this, every report row ok', !/CHECK THIS/.test(rep), rep.split('\n').filter((l) => /CHECK THIS/.test(l)));
  chk('… and reports what is due and how the engine\'s drafts fare', /^30\|drafting engine: .*\|ok$/m.test(rep)
    && /^31\|drafting: \d+ first emails and \d+ follow-ups due; engine drafts in 90 days: 4 written, 1 approved as written, 2 after an edit, 1 rejected\|ok$/m.test(rep),
    rep.split('\n').filter((l) => /^3[01]\|/.test(l)));
} catch (err) {
  chk('the suite ran without an unexpected error', false, String(err.sqlMessage || err.message).slice(0, 1500));
} finally {
  db.stop();
}
process.exit(T.done());
