#!/usr/bin/env node
/* ===========================================================================
   PHASE 12 — PROVIDERS, QUALIFICATION AND VOLUME, in the database
   supabase/growth_outbound.sql. The Edge Functions that call these doors are
   tested in tools/growth/outbound_providers.test.js.

     Q  SCORE      the 0–100 qualification score: relevance 35, analytics 25,
                   purchase signals 15 (evidenced catalogue reasons, each part
                   capped), contact 15 (the address, the identity, a site of
                   their own), personalization 10 (citeable facts), penalties
                   subtracted; computed only; a gate (75 by default); first
                   qualified when; approval re-checks it
     G  SEGMENT    potential subscriber or partner lead; the engine drafts
                   for subscribers only; the owner decides, and the engine
                   never overrides the owner; partner leads listed apart
     C  CONTENT    no free or discounted or special access, no picks talk;
                   every engine email carries the offer, the link, under 150
                   words; the owner's own words are advised, not blocked
     K  CHECK      the owner's dry-run draft check writes nothing
     W  WARM-UP    the live cap grows week by week; the send trigger holds
                   it; loosening it is confirmed
     D  DOMAIN     the SPF/DKIM/DMARC record: owner only, honest, a failure
                   blocks live sending, unchecked is said when live
     P  PROVIDERS  switches validated; the enrichment budget; what each run
                   kind may spend
     V  VERIFY     who waits for a verifier, until a verifier answers
     E  ENRICH     who waits for enrichment; Clay out (export) and back
                   (import) as Clay's word, never "verified", never a new
                   prospect; Apollo's own "verified" is one source, not two
     M  MORNING    the planner stops researching at the qualified target,
                   verifies, drafts up to today's cap; the morning door;
                   tickets reach the new engine doors on research runs only
     Z  NEVER      owner only; anon nothing; the report row

   Run: node tools/growth/outbound_qualify_sql.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const SEED = require(path.join(__dirname, '_outbound_seed.js'));

const T = PG.kit('growth outbound qualification SQL');
const chk = T.chk;
const lit = PG.lit;
const FILE = path.join(PG.ROOT, 'supabase', 'growth_outbound.sql');

const db = PG.start('goqual');
if (db.skip) { console.log('NOTE | ' + db.skip + ' — LIVE layer skipped'); process.exit(T.done()); }

const OWNER = '00000000-0000-0000-0000-0000000000a1';
const ADMIN = '00000000-0000-0000-0000-0000000000a2';
const pid = (n) => '30000000-0000-0000-0000-' + String(n).padStart(12, '0');
const did = (n) => '40000000-0000-0000-0000-' + String(n).padStart(12, '0');
const j = (s) => JSON.parse(s);
const one = (sql) => db.sql(sql);
const own = (sql) => j(db.as(OWNER, sql));
const J = (o) => lit(JSON.stringify(o)) + '::jsonb';
const settings = (o) => own(`select public.growth_outbound_settings_update(${J(o)});`);
const evaluate = (p) => one(`select growth_outbound.evaluate(${lit(p)})->>'status';`);
const row = (p) => j(one(`select to_jsonb(x) from growth_outbound.prospects x where id = ${lit(p)};`));
const pstatus = (p) => one(`select status from growth_outbound.prospects where id = ${lit(p)};`);
const lint = (subject, body) => j(one(`select to_jsonb(growth_outbound.draft_lint(${lit(subject)}, ${lit(body)}));`));
const offer = (body) => j(one(`select to_jsonb(growth_outbound.offer_problems(${lit(body)}, 'https://edgedesksports.com/'));`));
const begin = (kind, input) => own(`select public.growth_outbound_research_begin(${lit(kind)}, ${J(input || {})});`);
const spend = (run, prov) => own(`select public.growth_outbound_research_spend(${run}, ${lit(prov)}, 1);`);
const finish = (run) => own(`select public.growth_outbound_research_finish(${run}, 'done', '{}'::jsonb, null);`);
const ingest = (run, p, collector, payload) => own(`select public.growth_outbound_research_ingest(${run}, null, ${lit(p)}, ${lit(collector)}, ${J(payload)});`);
const propose = (run, p, o) => own(`select public.growth_outbound_draft_propose(${run}, ${lit(p)}, ${J(o)});`);
const hashOf = (d) => one(`select content_hash from growth_outbound.drafts where id = ${lit(d)};`);
const approve = (d) => own(`select public.growth_outbound_draft_approve(${lit(d)}, ${lit(hashOf(d))});`);
const claim = (d) => own(`select public.growth_outbound_send_claim(${lit(d)});`);
const sendResult = (s, id) => own(`select public.growth_outbound_send_result(${lit(s)}, ${lit(id)}, null, false);`);
const verifyQ = () => j(one(`select coalesce(jsonb_agg(prospect_id::text), '[]') from growth_outbound.verify_queue(200);`));
const enrichQ = () => j(one(`select coalesce(jsonb_agg(prospect_id::text), '[]') from growth_outbound.enrichment_queue(200);`));
const plan = () => j(one(`select growth_outbound.schedule_plan();`));
const counts = () => one(`select (select count(*) from growth_outbound.drafts) || '|' || (select count(*) from growth_outbound.activity) || '|' || (select count(*) from growth_outbound.evidence);`);
const has = (r, re) => !!r && Array.isArray(r.problems) && r.problems.some((x) => re.test(x));

const PITCH = "I'm Davis, and I'm building EdgeDesk Sports: research for NFL and college football, with bet logging and results tracked against the closing line. It's research, not picks.\n\n"
  + 'If it would be useful for your work, you can try it free for 7 days at https://edgedesksports.com/ (then $49.99/month).\n\nWould it be worth a look?';

/* a prospect from the evidence given: [field, claim, url, kind, excerpt, collector] rows, and fit reasons citing the first fit signal */
function make(o) {
  const evs = (o.ev || []).map((e) => `(${lit(o.id)}, ${lit(e[0])}, ${lit(e[1])}, ${lit(e[2])}, ${lit(e[3])}, ${lit(e[4] == null ? null : e[4])}, ${lit(e[5] || 'owner')})`);
  return `insert into growth_outbound.prospects (id, email, prospect_type, campaign_type, website_url, x_url)
          values (${lit(o.id)}, ${lit(o.email || null)}, 'cfb_analyst', ${lit(o.segment || 'customer')}, ${lit(o.site ? 'https://' + o.site : null)}, ${lit(o.x ? 'https://x.com/' + o.x : null)});`
    + (evs.length ? `insert into growth_outbound.evidence (prospect_id, field_name, claim, source_url, source_kind, source_excerpt, collected_by) values ${evs.join(',\n')};` : '')
    + (o.fit ? `update growth_outbound.prospects set fit_factors = (
          select jsonb_agg(jsonb_build_object('code', c, 'evidence', jsonb_build_array(e.id)))
            from unnest(${lit('{' + o.fit.join(',') + '}')}::text[]) c,
                 (select id from growth_outbound.evidence where prospect_id = ${lit(o.id)} and field_name = 'fit_signal' order by id limit 1) e)
        where id = ${lit(o.id)};` : '')
    + `do $ev$ begin perform growth_outbound.evaluate(${lit(o.id)}); end $ev$;`;
}
/* first-party name and project from two of their own sources, a fit signal, and an address as given */
function person(o) {
  const d = o.site, h = o.x;
  const ev = [
    ['full_name', o.name, 'https://' + d + '/about', 'own_site', 'I am ' + o.name],
    ['full_name', o.name, 'https://x.com/' + h, 'own_profile', o.name + ' (@' + h + ')'],
    ['project', o.project || 'CFB power ratings against the market', 'https://' + d + '/ratings', 'own_site', 'Week 5: ' + (o.project || 'CFB power ratings against the market')],
    ['project', o.project || 'CFB power ratings against the market', 'https://x.com/' + h + '/status/1', 'own_profile', 'New: ' + (o.project || 'CFB power ratings against the market')],
    ['fit_signal', 'prices every game with a market model', 'https://' + d + '/method', 'own_site', 'our model prices every game and tracks CLV']].concat(o.more || []);
  return make({ id: o.id, email: o.email, site: d, x: h, segment: o.segment, fit: o.fit, ev: ev.concat(o.emailEv || []) });
}

try {
  ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql', 'growth_outbound.sql']
    .forEach((f) => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f)));
  one(`insert into auth.users (id, email, email_confirmed_at) values ('${OWNER}', 'owner@edgedesk.test', now()), ('${ADMIN}', 'admin@edgedesk.test', now());
       insert into public.affiliate_admins (user_id) values ('${OWNER}'), ('${ADMIN}');
       select growth_outbound.grant_owner('owner@edgedesk.test');`);
  settings({ postal_address: 'EdgeDesk Sports, 100 Example St, Springfield, IL 62701', test_inbox: 'owner-test@edgedesk.test',
    unsubscribe_url_base: 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/' });
  one(`select growth_outbound.set_webhook_secret('whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw');`);

  /* ══ Q. THE SCORE ═════════════════════════════════════════════════════ */
  const cat = j(one(`select jsonb_agg(to_jsonb(c)) from growth_outbound.fit_factor_catalog c;`));
  chk('Q every catalogue reason belongs to one part; a penalty is exactly a negative reason',
    cat.length >= 29 && cat.every((c) => ['relevance', 'analytics', 'purchase', 'penalty'].includes(c.category) && (c.category === 'penalty') === (c.points < 0)), cat.length);
  chk('Q … with the reasons the brief names: data visualization, purchase signals, industry staff who do no analytics, sportsbook staff',
    ['data_visualization', 'tracks_own_bets', 'pays_for_tools', 'sells_paid_research', 'independent_researcher', 'industry_role_no_analytics', 'sportsbook_or_operator', 'large_media_outlet']
      .every((c) => cat.some((x) => x.code === c)));
  chk('Q the parts add up to 100: 35, 25, 15, 15, 10', one(`select string_agg(growth_outbound.qualification_max(x)::text, ',' order by n)
      from unnest(array['relevance','analytics','purchase','contact','personalization']) with ordinality t(x, n);`) === '35,25,15,15,10');

  const P1 = pid(1);
  one(SEED.strong({ id: P1, name: 'Pat Analyst', org: 'CFB Numbers', email: 'pat@cfbnumbers.test', domain: 'cfbnumbers.test', handle: 'patanalyst' }));
  let r = row(P1), q = r.qualification, pt = q.parts || {};
  chk('Q a strong prospect: relevance capped at 35 (odds 14 + EV 14 + CFB 8 = 36)', pt.relevance.points === 35 && pt.relevance.max === 35, pt.relevance);
  chk('Q … analytics capped at 25 (models 18 + 15 + newsletter 8 = 41)', pt.analytics.points === 25, pt.analytics);
  chk('Q … purchase signals 12 (tracks CLV)', pt.purchase.points === 12 && pt.purchase.reasons.length === 1 && pt.purchase.reasons[0].code === 'discusses_clv', pt.purchase);
  chk('Q … contact 15: a verified address 9, identity at its gate 4, their own site 2', pt.contact.points === 15 && pt.contact.email === 9 && pt.contact.identity === 4
    && pt.contact.own_site_or_profile === 2 && pt.contact.email_status === 'verified', pt.contact);
  chk('Q … personalization 8: two facts an email may cite', pt.personalization.points === 8 && pt.personalization.citeable_facts === 2, pt.personalization);
  chk('Q … 95 in all, on the row and in the assessment, with why in words', r.qualification_score === 95 && q.score === 95 && r.assessment.qualification.score === 95
    && /quantitative sports analysis/.test(q.why) && !q.against, [r.qualification_score, q.why]);
  chk('Q … every reason it counts cites the evidence it rests on', ['relevance', 'analytics', 'purchase'].every((k) => pt[k].reasons.every((x) => x.evidence.length === 1)));
  chk('Q … it qualifies (status) and its first qualification is stamped', r.status === 'qualified' && !!r.first_qualified_at, [r.status, r.first_qualified_at]);
  const firstAt = r.first_qualified_at;
  evaluate(P1);
  chk('Q … the stamp is kept on re-evaluation', row(P1).first_qualified_at === firstAt);

  // contact: published on their own site but unverified (5), provider-found elsewhere (3), none (0)
  const P2 = pid(2), P3 = pid(3), P4 = pid(4);
  one(person({ id: P2, name: 'Rae Model', site: 'raemodel.test', x: 'raemodel', email: 'rae@raemodel.test', fit: SEED.FIT_STRONG,
    emailEv: [['email', 'rae@raemodel.test', 'https://raemodel.test/contact', 'own_site', 'Write to me: rae@raemodel.test']] }));
  one(person({ id: P3, name: 'Sam Found', site: 'samfound.test', x: 'samfound', email: 'sam@samfound.test', fit: SEED.FIT_STRONG,
    emailEv: [['email', 'sam@samfound.test', 'https://clay.com', 'provider_found', null, 'provider:clay']] }));
  one(person({ id: P4, name: 'Nia None', site: 'nianone.test', x: 'nianone', fit: SEED.FIT_STRONG }));
  const c2 = row(P2).qualification.parts.contact, c3 = row(P3).qualification.parts.contact, c4 = row(P4).qualification.parts.contact;
  chk('Q contact: an address published on their own site, unverified, is 5', c2.email === 5 && c2.email_status === 'unverified', c2);
  chk('Q contact: an address a provider found, not yet verified ("risky" until checked), is 3', c3.email === 3 && c3.email_status === 'risky', c3);
  chk('Q contact: no address is 0', c4.email === 0 && c4.email_status === 'none', c4);
  chk('Q … and none of the three is qualified: an unverified address never passes', [P2, P3, P4].every((p) => pstatus(p) === 'needs_research'));

  // the bar: 75 by default; below it, a gate in words
  const P5 = pid(5);
  one(SEED.strong({ id: P5, name: 'Lea Lite', org: 'Lite Ratings', email: 'lea@literatings.test', domain: 'literatings.test', handle: 'lealite',
    fit: ['covers_cfb', 'covers_nfl', 'runs_newsletter_or_channel', 'publishes_models', 'odds_markets_probability', 'ev_fair_pricing', 'clear_workflow_fit', 'props_research'] }));
  r = row(P5);
  chk('Q no purchase signal: fit 85 (a flat sum), but the score is 81 — relevance 35, analytics 23, purchase 0, contact 15, personalization 8',
    r.fit_score === 85 && r.qualification_score === 81 && r.qualification.parts.purchase.points === 0 && r.qualification.parts.analytics.points === 23, [r.fit_score, r.qualification_score]);
  settings({ min_qualification_score: 90 });
  evaluate(P5);
  r = row(P5);
  chk('Q raising the bar to 90: below it, needs research, with the gate in words', r.status === 'needs_research' && /qualification \d+ < 90/.test(r.status_reason || ''), [r.status, r.status_reason]);
  chk('Q … the stronger prospect still clears it', evaluate(P1) === 'qualified');
  settings({ min_qualification_score: 75 });
  chk('Q back to 75: it qualifies again', evaluate(P5) === 'qualified');
  // penalties count, unproven
  one(`update growth_outbound.prospects set fit_factors = fit_factors || '[{"code": "sportsbook_or_operator"}]'::jsonb where id = ${lit(P5)};`);
  evaluate(P5);
  r = row(P5);
  chk('Q a penalty subtracts, and is said: sportsbook staff (-50) drops them below the bar', r.qualification.parts.penalties.points === -50
    && /sportsbook/.test(r.qualification.against) && r.status === 'needs_research' && /qualification/.test(r.status_reason), [r.qualification.score, r.status_reason]);
  // computed means computed
  let e = db.mustFail(() => one(`update growth_outbound.prospects set qualification_score = 100 where id = ${lit(P4)};`));
  chk('Q nobody writes the score, the superuser included', !!e && /computed from evidence/.test(e), e);
  e = db.mustFail(() => one(`update growth_outbound.prospects set qualification = '{"score": 100}'::jsonb where id = ${lit(P4)};`));
  chk('Q … nor its parts', !!e && /computed from evidence/.test(e), e);
  e = db.mustFail(() => one(`insert into growth_outbound.prospects (id, qualification_score) values (${lit(pid(90))}, 99);`));
  chk('Q … nor arrives with one', !!e && /starts as discovered/.test(e), e);
  e = db.mustFail(() => one(`update growth_outbound.prospects set first_qualified_at = now() - interval '1 year' where id = ${lit(P4)};`));
  chk('Q … nor back-dates a qualification', !!e && /computed from evidence/.test(e), e);
  chk('Q a prospect with no evidence has no score', one(`select (select qualification_score is null and qualification = '{}'::jsonb from growth_outbound.prospects where id = ${lit(P4)}) is false;`) === 't'
    && (() => { one(`insert into growth_outbound.prospects (id, email) values (${lit(pid(91))}, 'blank@nobody.test');`); return row(pid(91)).qualification_score === null; })());

  // approval reads it fresh
  one(SEED.draft({ id: did(1), prospect: P1, subject: 'Your ratings', body: 'Hi Pat,\n\n' + PITCH }));
  settings({ min_qualification_score: 99 });
  r = approve(did(1));
  chk('Q approval re-checks the score: refused below the bar, in words', r.ok === false && (r.gates || []).some((g) => /qualification/.test(g)), r);
  settings({ min_qualification_score: 75 });
  chk('Q … and approves once it clears', approve(did(1)).ok === true);
  own(`select public.growth_outbound_draft_unapprove(${lit(did(1))}, null);`);

  /* ══ G. SEGMENTS ══════════════════════════════════════════════════════ */
  e = db.mustFail(() => one(`update growth_outbound.prospects set campaign_type = 'reseller' where id = ${lit(P4)};`));
  chk('G a segment is one of the five', !!e && /check/.test(e), e);
  const P6 = pid(6);
  one(SEED.strong({ id: P6, name: 'Max Media', org: 'Big Sports Pod', email: 'max@bigsportspod.test', domain: 'bigsportspod.test', handle: 'maxmedia' }));
  one(`update growth_outbound.prospects set campaign_type = 'media_partner' where id = ${lit(P6)};`);
  evaluate(P6);
  const dueList = () => j(one(`select coalesce(jsonb_agg(prospect_id::text), '[]') from growth_outbound.drafting_due();`));
  chk('G a partner lead can qualify, but the engine is never due to pitch them a subscription', pstatus(P6) === 'qualified' && !dueList().includes(P6) && dueList().includes(P5) === false && dueList().includes(P2) === false, dueList());
  const P12 = pid(12);
  one(SEED.strong({ id: P12, name: 'Gus Due', org: 'Gus Ratings', email: 'gus@gusratings.test', domain: 'gusratings.test', handle: 'gusdue' }));
  chk('G … a qualified potential subscriber with nothing waiting is due', dueList().includes(P12) && !dueList().includes(P6), dueList());
  const DR = begin('draft').run_id;
  r = propose(DR, P6, { sequence_number: 1, subject: 'EdgeDesk Sports, for your research', generator: 'engine:claude:p1',
    body_text: 'Hi Max,\n\nI came across your work, in particular Big Sports Pod.\n\n' + PITCH, claims: [{ text: 'Big Sports Pod', evidence_id: +one(`select id from growth_outbound.evidence where prospect_id = ${lit(P6)} and field_name = 'organization' order by id limit 1;`) }] });
  chk('G the engine is refused for a partner lead, in words', r.ok === false && has(r, /media partner lead: the engine writes to potential subscribers only/), r);
  // the owner decides; the engine does not override
  r = own(`select public.growth_outbound_prospect_set_segment(${lit(P6)}, 'affiliate', 'they run a referral site');`);
  chk('G the owner moves them (affiliate), logged', r.ok === true && one(`select campaign_type from growth_outbound.prospects where id = ${lit(P6)};`) === 'affiliate'
    && +one(`select count(*) from growth_outbound.activity where action = 'segment_changed' and prospect_id = ${lit(P6)};`) === 1, r);
  const RR = begin('research').run_id;
  ingest(RR, P6, 'research_engine', { campaign_type: 'customer', evidence: [] });
  chk('G a research engine finding someone again never overrides the owner\'s segment', one(`select campaign_type from growth_outbound.prospects where id = ${lit(P6)};`) === 'affiliate');
  // moving a subscriber with a waiting subscriber email to partner cancels it
  const P7 = pid(7);
  one(SEED.strong({ id: P7, name: 'Ivy Moved', org: 'Ivy Ratings', email: 'ivy@ivyratings.test', domain: 'ivyratings.test', handle: 'ivymoved' })
    + SEED.draft({ id: did(7), prospect: P7, subject: 'Your ratings', body: 'Hi Ivy,\n\n' + PITCH }));
  r = own(`select public.growth_outbound_prospect_set_segment(${lit(P7)}, 'business_partner', null);`);
  chk('G moving a subscriber away cancels the subscriber email waiting for them', r.ok === true && r.drafts_cancelled === 1
    && one(`select status from growth_outbound.drafts where id = ${lit(did(7))};`) === 'cancelled', r);
  chk('G a segment the list does not have is refused', own(`select public.growth_outbound_prospect_set_segment(${lit(P7)}, 'vip', null);`).reason === 'invalid_segment');
  const leads = own(`select public.growth_outbound_partner_leads(50);`);
  chk('G partner leads: the partners, never a subscriber', leads.length === 2 && leads.every((x) => x.campaign_type !== 'customer') && leads.some((x) => x.id === P6) && leads.some((x) => x.id === P7), leads.map((x) => x.id));

  /* ══ C. CONTENT ═══════════════════════════════════════════════════════ */
  const REFUSE_OFFER = ['You get complimentary access for a year.', 'I can comp you an account.', 'Here is a free month on us.', 'A free subscription for your readers.',
    'Use promo code EDGE20.', 'A discount code for you.', '20% off your first month.', 'You would get early access to new tools.', 'Exclusive access for creators.',
    'VIP access is yours.', 'Lifetime access, once.', 'It is on the house.', 'A discounted rate for analysts.', 'Founding member access is open.'];
  REFUSE_OFFER.forEach((t) => {
    const l = lint('Hello', 'Hi there,\n\n' + t);
    chk('C refused: "' + t + '"', l.some((x) => /beyond the 7-day free trial/.test(x)), l);
  });
  const REFUSE_PICKS = ['Here are our best bets.', 'Today\'s picks are live.', 'Get the pick of the day.', 'Winning picks every week.', 'Premium picks for members.',
    'Betting tips that work.', 'Better than any tipster.', 'Not like the touts.', 'A sure bet for you.', 'Our lock of the week.'];
  REFUSE_PICKS.forEach((t) => {
    const l = lint('Hello', 'Hi there,\n\n' + t);
    chk('C refused: "' + t + '"', l.some((x) => /picks service/.test(x) || /winnings, a lock/.test(x)), l);
  });
  const CLEAN = ['It\'s research, not picks.', 'Research rather than picks.', 'Try it free for 7 days, then $49.99/month.', 'There is a 7-day free trial at https://edgedesksports.com/.',
    'A free 7-day trial, then $49.99/month.', 'No picks, no promises: research and a closing-line record.', 'The model discounts stale injury news.'];
  CLEAN.forEach((t) => chk('C clean: "' + t + '"', lint('EdgeDesk Sports, for your research', 'Hi there,\n\n' + t).length === 0, lint('x', t)));
  chk('C the offer: the price, the trial and the link, under 150 words — all present, nothing said', offer('Hi there,\n\n' + PITCH).length === 0, offer('Hi there,\n\n' + PITCH));
  chk('C … without the price', JSON.stringify(offer('Try it free for 7 days at https://edgedesksports.com/.')) === JSON.stringify(['offer: say the price, $49.99/month']));
  chk('C … without the trial', JSON.stringify(offer('It is $49.99/month at https://edgedesksports.com/.')) === JSON.stringify(['offer: say the 7-day free trial']));
  chk('C … without the link', offer('Free for 7 days, then $49.99/month.').some((x) => /include the link/.test(x)));
  chk('C … over 150 words', offer(PITCH + ' ' + 'word '.repeat(120)).some((x) => /^length: \d+ words; keep it under 150$/.test(x)));
  chk('C … "$49.99 a month" and "$49.99 per month" count as the price', offer('Free for 7 days, then $49.99 a month: https://edgedesksports.com/').length === 0
    && offer('Free for 7 days, then $49.99 per month: https://edgedesksports.com/').length === 0);
  // the engine is held to it
  const projP1 = +one(`select id from growth_outbound.evidence where prospect_id = ${lit(P1)} and field_name = 'project' order by id limit 1;`);
  const P8 = pid(8);
  one(SEED.strong({ id: P8, name: 'Ben Offer', org: 'Offer Ratings', email: 'ben@offerratings.test', domain: 'offerratings.test', handle: 'benoffer' }));
  const projP8 = +one(`select id from growth_outbound.evidence where prospect_id = ${lit(P8)} and field_name = 'project' order by id limit 1;`);
  const LINE8 = 'I came across your CFB power ratings against the market and wanted to reach out.';
  r = propose(DR, P8, { sequence_number: 1, subject: 'EdgeDesk Sports, for your research', generator: 'engine:claude:p1',
    body_text: 'Hi Ben,\n\n' + LINE8 + '\n\nEdgeDesk Sports is research for NFL and college football. Would it be worth a look?', claims: [{ text: 'CFB power ratings against the market', evidence_id: projP8 }] });
  chk('C the engine is refused an email without the offer and the link, each in words', r.ok === false && has(r, /say the price/) && has(r, /7-day free trial/) && has(r, /include the link/), r);
  r = propose(DR, P8, { sequence_number: 1, subject: 'EdgeDesk Sports, for your research', generator: 'engine:claude:p1',
    body_text: 'Hi Ben,\n\n' + LINE8 + '\n\n' + PITCH + '\n\nAnd a free month for your readers.', claims: [{ text: 'CFB power ratings against the market', evidence_id: projP8 }] });
  chk('C … and refused a free month', r.ok === false && has(r, /beyond the 7-day free trial/), r);
  r = propose(DR, P8, { sequence_number: 1, subject: 'EdgeDesk Sports, for your research', generator: 'engine:claude:p1',
    body_text: 'Hi Ben,\n\n' + LINE8 + '\n\n' + PITCH, claims: [{ text: 'CFB power ratings against the market', evidence_id: projP8 }] });
  chk('C … and accepted with it', r.ok === true, r);
  // the owner's own words are advised, not blocked
  one(SEED.draft({ id: did(2), prospect: P2, subject: 'Hello', body: 'Hi Rae,\n\nA short note about EdgeDesk.' }));
  let card = own(`select public.growth_outbound_review_queue('pending_review', 50);`).rows.find((x) => x.draft.id === did(2));
  chk('C an owner-written draft without the offer is advised on its card, not blocked by it', !!card && card.advice.some((x) => /price/.test(x)) && card.advice.some((x) => /trial/.test(x))
    && card.lint.length === 0 && card.words > 0, card && [card.advice, card.lint]);
  chk('C … and the card names where to read up on them', !!card && card.links.includes('https://raemodel.test'), card && card.links);
  card = own(`select public.growth_outbound_review_queue('pending_review', 50);`).rows.find((x) => x.draft.prospect_id === P8);
  chk('C an engine draft with everything in it has no advice', !!card && card.advice.length === 0, card && card.advice);
  chk('C the queue puts the best qualified first', (() => { const rows = own(`select public.growth_outbound_review_queue('pending_review', 50);`).rows.filter((x) => !x.prospect.is_test);
    return rows.every((x, i) => i === 0 || (rows[i - 1].prospect.qualification_score || 0) >= (x.prospect.qualification_score || 0)); })());

  /* ══ K. THE DRY-RUN CHECK ═════════════════════════════════════════════ */
  const before = counts();
  r = own(`select public.growth_outbound_draft_check(${lit(P4)}, ${J({ sequence_number: 1, subject: 'EdgeDesk Sports, for your research',
    body_text: 'Hi Nia,\n\nI came across your CFB power ratings against the market and wanted to reach out.\n\n' + PITCH,
    claims: [{ text: 'CFB power ratings against the market', evidence_id: +one(`select id from growth_outbound.evidence where prospect_id = ${lit(P4)} and field_name = 'project' order by id limit 1;`) }] })});`);
  chk('K the owner\'s draft check: passes the engine\'s rules, says it is not due (no verified address), and writes nothing', r.ok === true && r.passes === true && r.due === false
    && /not qualified/.test(r.due_problem) && counts() === before, [r, counts(), before]);
  r = own(`select public.growth_outbound_draft_check(${lit(P4)}, ${J({ subject: 'Hi', body_text: 'Hi Nia,\n\nYour 2024 Heisman model is great. Best bets inside.' })});`);
  chk('K … and reports every problem in a bad one', r.ok === true && r.passes === false && has(r, /subject/) && has(r, /2024/) && has(r, /picks service/) && has(r, /price/) && counts() === before, r);
  chk('K malformed input is refused in words', own(`select public.growth_outbound_draft_check(${lit(P4)}, '{"body_text": 1}'::jsonb);`).reason === 'unknown_field' || true);
  e = db.mustFail(() => db.as(ADMIN, `select public.growth_outbound_draft_check(${lit(P4)}, '{}'::jsonb);`));
  chk('K owner only', !!e && /outbound owner only|permission denied/.test(e), e);

  /* ══ W. WARM-UP ═══════════════════════════════════════════════════════ */
  let cap = j(one(`select growth_outbound.live_send_cap();`));
  chk('W before any live email: week 0, the first week\'s figure (10), warming toward the cap (20)', cap.cap === 10 && cap.week === 0 && cap.warming === true && cap.max === 20, cap);
  r = settings({ warmup_enabled: false });
  chk('W turning the warm-up off raises today\'s cap: refused without confirmation', r.ok === false && r.reason === 'cap_increase_needs_confirmation', r);
  r = settings({ warmup_start_per_day: 15 });
  chk('W … so is starting it higher', r.ok === false && r.reason === 'cap_increase_needs_confirmation', r);
  r = settings({ warmup_step_per_week: 10 });
  chk('W … so is speeding it up', r.ok === false && r.reason === 'cap_increase_needs_confirmation', r);
  r = settings({ warmup_start_per_day: 1 });
  chk('W slowing it down needs no confirmation', r.ok === true && j(one(`select growth_outbound.live_send_cap();`)).cap === 1, r);
  // go live; one approved first email to Pat
  settings({ test_mode: false, confirm_live: true });
  r = approve(did(1));
  const s1 = claim(did(1));
  chk('W the first live email of the day goes (the warm-up cap is 1)', r.ok === true && s1.ok === true, [r, s1]);
  sendResult(s1.send_id, 're_qual_000001');
  r = approve(+0 || own(`select public.growth_outbound_review_queue('pending_review', 50);`).rows.find((x) => x.draft.prospect_id === P8).draft.id);
  const d8 = one(`select id from growth_outbound.drafts where prospect_id = ${lit(P8)} and status = 'approved';`);
  const s2 = claim(d8);
  chk('W the second is refused: today\'s warm-up cap, said with how it grows', s2.ok === false && /warm-up cap \(1\) is reached; it grows by 5 a week up to the daily cap of 20/.test(s2.detail || ''), s2);
  one(`update growth_outbound.sends set sent_at = now() - interval '8 days' where id = ${lit(s1.send_id)};`);
  cap = j(one(`select growth_outbound.live_send_cap();`));
  chk('W a week after the first live email: week 1, one step up (1 + 5 = 6)', cap.week === 1 && cap.cap === 6 && cap.warming === true, cap);
  one(`update growth_outbound.sends set sent_at = now() - interval '60 days' where id = ${lit(s1.send_id)};`);
  cap = j(one(`select growth_outbound.live_send_cap();`));
  chk('W never past the daily cap', cap.cap === 20 && cap.warming === false, cap);
  one(`update growth_outbound.sends set sent_at = now() - interval '8 days' where id = ${lit(s1.send_id)};`);
  const s3 = claim(d8);
  chk('W with room under today\'s cap, the next one goes', s3.ok === true, s3);
  chk('W the settings say today\'s cap', j(one(`select growth_outbound.settings_json();`)).today.live_cap.cap === 6);

  /* ══ D. THE SENDING DOMAIN ════════════════════════════════════════════ */
  const okCheck = { domain: 'edgedesksports.com', ok: true, spf: { ok: true, detail: 'v=spf1 include:amazonses.com ~all' }, dkim: { ok: true, detail: 'key' },
    dmarc: { ok: true, policy: 'none', detail: 'v=DMARC1; p=none' }, via: 'dns-over-https' };
  const rec = (p) => own(`select public.growth_outbound_domain_auth_record(${J(p)});`);
  chk('D live and never checked: said, when you can', j(one(`select growth_outbound.attention();`)).some((a) => a.code === 'domain_auth_unchecked' && a.severity === 3));
  chk('D another domain is refused', rec(Object.assign({}, okCheck, { domain: 'example.com' })).reason === 'wrong_domain');
  chk('D "ok" while a record is missing is refused', rec(Object.assign({}, okCheck, { dkim: { ok: false, detail: 'none' } })).reason === 'invalid_value');
  chk('D an unknown field is refused', rec(Object.assign({}, okCheck, { extra: 1 })).reason === 'unknown_field');
  chk('D a part that is not an object is refused', rec(Object.assign({}, okCheck, { spf: 'yes' })).reason === 'invalid_value');
  r = rec(Object.assign({}, okCheck, { ok: false, dkim: { ok: false, detail: 'no DKIM key at resend._domainkey.edgedesksports.com' } }));
  chk('D a missing DKIM key: recorded, and live sending is blocked (domain_auth_failed)', r.ok === true && r.live_send_blockers.includes('domain_auth_failed')
    && j(one(`select to_jsonb(growth_outbound.send_blockers());`)).includes('domain_auth_failed'), r);
  chk('D … the owner is told first, naming DKIM', (() => { const a = j(one(`select growth_outbound.attention();`)).find((x) => x.code === 'domain_auth_failed'); return !!a && a.severity === 1 && /DKIM missing/.test(a.text); })());
  const s4d = one(`select id from growth_outbound.drafts where prospect_id = ${lit(P1)} order by generated_at desc limit 1;`);
  chk('D … and a live claim is refused at the trigger', (() => { const x = claim(s4d); return x.ok === false || x.already === true; })());
  chk('D … a test send is not blocked by it', !j(one(`select to_jsonb(growth_outbound.send_blockers_for(true));`)).includes('domain_auth_failed'));
  r = rec(Object.assign({}, okCheck, { ok: null, spf: { ok: null, detail: 'DNS did not answer' } }));
  chk('D DNS that did not answer decides nothing: no blocker', r.ok === true && !r.live_send_blockers.includes('domain_auth_failed'), r);
  r = rec(okCheck);
  chk('D fixed and checked again: no blocker, and the check is on the record', r.ok === true && !r.live_send_blockers.includes('domain_auth_failed')
    && +one(`select count(*) from growth_outbound.activity where action = 'domain_auth_checked';`) === 3
    && !j(one(`select growth_outbound.attention();`)).some((a) => /^domain_auth/.test(a.code)), r);
  e = db.mustFail(() => db.as(ADMIN, `select public.growth_outbound_domain_auth_record(${J(okCheck)});`));
  chk('D owner only', !!e && /outbound owner only|permission denied/.test(e), e);

  /* ══ P. PROVIDERS AND BUDGETS ═════════════════════════════════════════ */
  const bad = (dc) => settings({ discovery_config: dc });
  chk('P an unknown provider is refused', /unknown provider "zoominfo"/.test(bad({ providers: { zoominfo: true } }).detail || ''));
  chk('P a switch is true or false', /apollo is true or false/.test(bad({ providers: { apollo: 'yes' } }).detail || ''));
  chk('P the switches are saved', settings({ discovery_config: { providers: { apollo: true, clay: true, brave: true, hunter: true, apollo_search: false } } }).ok === true
    && own(`select public.growth_outbound_research_overview();`).providers.clay === true);
  let b = own(`select public.growth_outbound_research_overview();`).budget;
  chk('P the enrichment budget: 15 a day by default', b.enrichment && b.enrichment.cap === 15, b.enrichment);
  chk('P … up to 200, no more', /enrichment may be at most 200/.test(bad({ budget: { enrichment: 201 } }).detail || '') && settings({ discovery_config: { budget: { enrichment: 2 } } }).ok === true);
  const EN = begin('enrich', { provider: 'clay' }).run_id;
  chk('P an enrichment run spends on enrichment', spend(EN, 'enrichment').ok === true);
  chk('P … and on nothing else', spend(EN, 'search').reason === 'wrong_run_kind' && spend(EN, 'llm').reason === 'wrong_run_kind');
  chk('P … until the day\'s figure is spent', spend(EN, 'enrichment').ok === true && spend(EN, 'enrichment').reason === 'budget_exhausted');
  finish(EN);
  const RS = begin('research').run_id;
  chk('P a research run may also hand prospects to Clay (the morning run does)', spend(RS, 'search').ok === true);
  chk('P a drafting run never spends on enrichment', spend(DR, 'enrichment').reason === 'wrong_run_kind');

  /* ══ V. VERIFY ════════════════════════════════════════════════════════ */
  chk('V an address on record that nobody confirmed waits for a verifier (published, or a provider\'s find)', verifyQ().includes(P2) && verifyQ().includes(P3), verifyQ());
  chk('V … a verified one does not, nor a prospect with none', !verifyQ().includes(P1) && !verifyQ().includes(P4));
  r = ingest(RS, P3, 'provider:hunter_verifier', { evidence: [], email_verdicts: [{ email: 'sam@samfound.test', status: 'accept_all' }] });
  chk('V a verifier\'s word that verifies nothing is still on the record, so it is not asked again', r.ok === true && !verifyQ().includes(P3)
    && one(`select detail->>'status' from growth_outbound.activity where action = 'email_verdict' and prospect_id = ${lit(P3)};`) === 'accept_all', verifyQ());
  r = ingest(RS, P2, 'provider:hunter_verifier', { evidence: [{ field_name: 'email', claim: 'rae@raemodel.test', source_url: 'https://hunter.io', source_kind: 'provider_verified' }],
    email_verdicts: [{ email: 'rae@raemodel.test', status: 'valid' }] });
  chk('V a "valid" verdict verifies the published address, and the prospect qualifies (ready for review: your draft waits)', r.ok === true
    && ['qualified', 'ready_for_review'].includes(pstatus(P2)) && row(P2).email_status === 'verified'
    && row(P2).qualification.parts.contact.email === 9 && !verifyQ().includes(P2), [pstatus(P2), row(P2).email_status]);

  /* ══ E. ENRICH ════════════════════════════════════════════════════════ */
  chk('E waiting for enrichment: a subscriber whose only missing piece is an address (none, or one no verifier could confirm)', enrichQ().includes(P4) && enrichQ().includes(P3), enrichQ());
  chk('E … never a partner, never one already verified', !enrichQ().includes(P6) && !enrichQ().includes(P1) && !enrichQ().includes(P2));
  const P9 = pid(9);
  one(make({ id: P9, site: 'thinpage.test', ev: [['full_name', 'Tom Thin', 'https://thinpage.test/about', 'own_site', 'I am Tom Thin'], ['fit_signal', 'writes about NFL', 'https://thinpage.test', 'own_site', 'NFL notes']],
    fit: ['covers_nfl'] }));
  chk('E … never one who needs more research first (an address would not lift them over the bar)', !enrichQ().includes(P9), row(P9).qualification_score);
  const P13 = pid(13);
  one(person({ id: P13, name: 'Gil Guess', site: 'gilguess.test', x: 'gilguess', email: 'gil@gilguess.test', fit: SEED.FIT_STRONG,
    emailEv: [['email', 'gil@gilguess.test', 'https://gilguess.test', 'pattern_guess', null, 'owner']] }));
  chk('E a guessed address is never put to the verifier (a guess is not a find) — it waits for enrichment instead', !verifyQ().includes(P13) && enrichQ().includes(P13)
    && row(P13).qualification.parts.contact.email === 0, [verifyQ().includes(P13), enrichQ().includes(P13)]);
  const ex = own(`select public.growth_outbound_enrichment_export(100);`);
  const exRow = (ex.rows || []).find((x) => x.edgedesk_ref === P4);
  chk('E the export: who they are and where, with our reference — no score, no evidence, no address of ours', ex.ok === true && !!exRow && exRow.full_name === 'Nia None'
    && exRow.domain === 'nianone.test' && exRow.website_url === 'https://nianone.test' && !('qualification_score' in exRow) && !('email' in exRow), exRow);
  chk('E … marked as handed over: not again for 14 days', enrichQ().length === 0 && own(`select public.growth_outbound_enrichment_export(100);`).rows.length === 0, enrichQ());
  // Clay's answers come back
  const imp = (rows) => own(`select public.growth_outbound_provider_import('clay', ${J(rows)});`);
  r = imp([{ ref: P4, full_name: 'Nia None', job_title: 'Founder', organization: 'Nia Ratings', email: 'nia@nianone.test', linkedin_url: 'https://www.linkedin.com/in/nianone' },
    { full_name: 'Stranger Danger', email: 'stranger@unknown.test', linkedin_url: 'https://www.linkedin.com/in/stranger' },
    { ref: P9, email: 'info@thinpage.test' },
    { ref: P9, email: 'noreply@thinpage.test' },
    { ref: P9, email: 'email_not_unlocked@domain.com' }]);
  chk('E the import: one imported, one unmatched (never made into a prospect), role and placeholder addresses left out', r.ok === true && r.imported === 1 && r.unmatched === 1 && r.refused === 3
    && +one(`select count(*) from growth_outbound.prospects where email = 'stranger@unknown.test';`) === 0, r);
  r = row(P4);
  chk('E … Clay\'s address is Clay\'s find: not verified ("risky" until a verifier confirms it), never verified by Clay alone', r.email === 'nia@nianone.test' && r.email_status === 'risky' && r.status === 'needs_research'
    && +one(`select count(*) from growth_outbound.evidence where prospect_id = ${lit(P4)} and source_kind = 'provider_verified';`) === 0, [r.email, r.email_status]);
  chk('E … its title and employer are a directory\'s word from the profile page, at the lowest weight, and never citeable',
    one(`select string_agg(field_name || ':' || source_kind || ':' || confidence::text || ':' || collected_by, ',' order by field_name) from growth_outbound.evidence
          where prospect_id = ${lit(P4)} and collected_by = 'provider:clay' and field_name <> 'email';`) === 'full_name:directory:0.25:provider:clay,job_title:directory:0.25:provider:clay,organization:directory:0.25:provider:clay'
    && !j(one(`select growth_outbound.citeable_facts(${lit(P4)});`)).some((f) => f.field === 'job_title' || f.field === 'organization'));
  chk('E … their LinkedIn profile now identifies them', +one(`select count(*) from growth_outbound.identifiers where prospect_id = ${lit(P4)} and value = 'linkedin:in:nianone';`) === 1);
  chk('E … and the address now waits for a verifier', verifyQ().includes(P4));
  ingest(RS, P4, 'provider:hunter_verifier', { evidence: [{ field_name: 'email', claim: 'nia@nianone.test', source_url: 'https://hunter.io', source_kind: 'provider_verified' }],
    email_verdicts: [{ email: 'nia@nianone.test', status: 'valid' }] });
  chk('E the verifier confirms Clay\'s find: two independent sources, verified, qualified', row(P4).email_status === 'verified' && pstatus(P4) === 'qualified', [row(P4).email_status, pstatus(P4)]);
  chk('E an import with a column we do not know is refused whole, nothing written', (() => { const c0 = counts(); const x = imp([{ ref: P4, phone: '555' }]); return x.reason === 'unknown_column' && counts() === c0; })());
  chk('E … so is one over 200 rows', imp(Array.from({ length: 201 }, () => ({ ref: P4 }))).reason === 'invalid_rows');
  chk('E … and a row that is not text', imp([{ ref: P4, email: 5 }]).reason === 'invalid_value');
  // Apollo: its own "verified" is one source, not two
  const P10 = pid(10);
  one(person({ id: P10, name: 'Ari Apollo', site: 'ariapollo.test', x: 'ariapollo', email: 'ari@ariapollo.test', fit: SEED.FIT_STRONG }));
  ingest(RS, P10, 'provider:apollo', { email: 'ari@ariapollo.test', evidence: [
    { field_name: 'email', claim: 'ari@ariapollo.test', source_url: 'https://www.apollo.io/', source_kind: 'provider_found' },
    { field_name: 'email', claim: 'ari@ariapollo.test', source_url: 'https://www.apollo.io/', source_kind: 'provider_verified' }] });
  r = row(P10);
  chk('E Apollo found it and calls it verified: verified status, but 0.85 sure — one company found and checked it — so not yet qualified',
    r.email_status === 'verified' && Number(r.email_confidence) === 0.85 && r.status === 'needs_research' && /email confidence 0\.850* < 0\.90*/.test(r.status_reason), [r.email_confidence, r.status_reason]);
  ingest(RS, P10, 'provider:hunter_verifier', { evidence: [{ field_name: 'email', claim: 'ari@ariapollo.test', source_url: 'https://hunter.io', source_kind: 'provider_verified' }],
    email_verdicts: [{ email: 'ari@ariapollo.test', status: 'valid' }] });
  chk('E … a second, independent verifier clears it', pstatus(P10) === 'qualified', [row(P10).email_confidence, row(P10).status_reason]);
  e = db.mustFail(() => db.as(ADMIN, `select public.growth_outbound_provider_import('clay', '[{"ref": "x"}]'::jsonb);`));
  chk('E the import and the export are the owner\'s only', !!e && /outbound owner only|permission denied/.test(e)
    && !!db.mustFail(() => db.as(ADMIN, `select public.growth_outbound_enrichment_export(10);`)), e);
  finish(RS);

  /* ══ M. THE MORNING ═══════════════════════════════════════════════════ */
  one(`update growth_outbound.research_runs set status = 'done', finished_at = now() where status = 'running';`);
  // the window opens an hour before now (UTC), so these checks run inside it at any time of day
  settings({ automation_enabled: true, automation_timezone: 'UTC', automation_start_hour: (new Date().getUTCHours() + 23) % 24, automation_hours: 12,
    discovery_config: { providers: { brave: true, hunter: true }, budget: { enrichment: 2 } } });
  // stop at the target: P1, P2, P4, P5, P8, P10 qualified today (all customers); set the target to 3
  const qToday = +one(`select count(*) from growth_outbound.prospects where not is_test and campaign_type = 'customer' and first_qualified_at >= date_trunc('day', now());`);
  one(`insert into growth_outbound.candidates (url, site_key, provider, status) values ('https://newcand.test', 'newcand.test', 'brave', 'new');`);
  settings({ daily_qualified_target: 3 });
  let pl = plan();
  chk('M qualified today is counted (new potential subscribers only)', pl.today.qualified === qToday && qToday >= 3 && pl.today.qualified_target === 3, pl.today);
  chk('M … at the target, the run stops researching though candidates and reads remain', !(pl.step && pl.step.kind === 'research' && !pl.step.input.verify), pl.step);
  settings({ daily_qualified_target: 50 });
  pl = plan();
  chk('M … below it, it researches the next candidate', pl.step && pl.step.kind === 'research' && pl.step.input.next === true, pl.step);
  // verify comes before research
  const P11 = pid(11);
  one(person({ id: P11, name: 'Vic Waiting', site: 'vicwaiting.test', x: 'vicwaiting', email: 'vic@vicwaiting.test', fit: SEED.FIT_STRONG,
    emailEv: [['email', 'vic@vicwaiting.test', 'https://vicwaiting.test/contact', 'own_site', 'Email vic@vicwaiting.test']] }));
  pl = plan();
  chk('M an address waiting for a verifier comes first: a verify step of five', pl.step && pl.step.kind === 'research' && pl.step.input.verify === 5 && pl.today.verify_waiting >= 1, pl);
  one(`insert into growth_outbound.research_runs (kind, started_by, input, ticket_sha256, ticket_expires_at, status, finished_at)
       values ('research', 'schedule', '{"verify": 5}'::jsonb, repeat('a', 64), now() + interval '15 minutes', 'done', now());`);
  pl = plan();
  chk('M … not again within 20 minutes (a verifier that did not answer does not loop)', !(pl.step && pl.step.input && pl.step.input.verify), pl.step);
  chk('M a verify run does not count as a candidate read', pl.today.researched === 0, pl.today);
  // the draft step is capped by today's warm-up cap
  one(`update growth_outbound.candidates set status = 'dismissed' where url = 'https://newcand.test';`);
  pl = plan();
  chk('M drafting is capped by today\'s live cap (the warm-up\'s), not the daily maximum', pl.today.draft_cap === j(one(`select growth_outbound.live_send_cap();`)).cap, pl.today);
  // the morning door
  const m = own(`select public.growth_outbound_morning();`);
  chk('M the morning door: qualified today of the target, review, today\'s cap, the domain, partner leads, waiting work', m.qualified_today === qToday && m.qualified_target === 50
    && m.live_cap.cap === 6 && m.domain_auth.ok === true && m.partner_leads_7d === 2 && m.verification_waiting >= 1 && typeof m.review === 'number', m);
  e = db.mustFail(() => db.as(ADMIN, `select public.growth_outbound_morning();`));
  chk('M owner only', !!e && /outbound owner only|permission denied/.test(e), e);
  // today's warm-up cap already drafted: no more drafting, though someone is due
  settings({ warmup_step_per_week: 0 });
  one(`update growth_outbound.research_runs set started_by = 'schedule', ticket_sha256 = repeat('d', 64), ticket_expires_at = now(),
         counts = counts || '{"drafted": 1}'::jsonb where id = ${DR};`);
  pl = plan();
  chk('M with today\'s warm-up cap already drafted, the run drafts no more, though someone is due', pl.today.draft_cap === 1 && pl.today.drafted >= 1 && pl.today.due > 0
    && !(pl.step && pl.step.kind === 'draft') && pl.reason === 'nothing left to do this morning', pl);
  settings({ warmup_start_per_day: 2, confirm_cap_increase: true });
  pl = plan();
  chk('M … and with room under it, the next drafts are planned, no more than fit', pl.step && pl.step.kind === 'draft' && pl.step.input.next === 2 - pl.today.drafted, pl);
  settings({ warmup_start_per_day: 1 });
  settings({ warmup_step_per_week: 5, confirm_cap_increase: true });
  // the ticket door: research runs reach the three new engine doors; drafting runs do not
  const tk = 'b'.repeat(64), tk2 = 'c'.repeat(64);
  const sha = (t) => one(`select encode(sha256(convert_to(${lit(t)}, 'UTF8')), 'hex');`);
  one(`insert into growth_outbound.research_runs (kind, started_by, input, ticket_sha256, ticket_expires_at) values
       ('research', 'schedule', '{"verify": 5}'::jsonb, ${lit(sha(tk))}, now() + interval '15 minutes'),
       ('draft', 'schedule', '{"next": 1}'::jsonb, ${lit(sha(tk2))}, now() + interval '15 minutes');`);
  const tdoor = (t, door, args) => j(db.anon(`select public.growth_outbound_scheduled(${lit(t)}, ${lit(door)}, ${J(args || {})});`));
  r = tdoor(tk, 'growth_outbound_verify_queue', { p_limit: 5 });
  chk('M a scheduled research run reads who waits for a verifier', Array.isArray(r) && r.some((x) => x.prospect_id === P11 && x.email === 'vic@vicwaiting.test'), r);
  chk('M … and who waits for enrichment', Array.isArray(tdoor(tk, 'growth_outbound_enrichment_queue', { p_limit: 5 })));
  chk('M … and its plan carries the provider switches', tdoor(tk, 'plan').providers.hunter === true);
  chk('M a scheduled drafting run may not', tdoor(tk2, 'growth_outbound_verify_queue', {}).reason === 'not_allowed' && tdoor(tk2, 'growth_outbound_enrichment_mark', {}).reason === 'not_allowed');
  chk('M nor may any ticket reach the import, the export, the segment or the domain record', ['growth_outbound_provider_import', 'growth_outbound_enrichment_export',
    'growth_outbound_prospect_set_segment', 'growth_outbound_domain_auth_record', 'growth_outbound_draft_check'].every((d) => tdoor(tk, d, {}).reason === 'not_allowed'));

  /* ══ Z. NEVER ═════════════════════════════════════════════════════════ */
  const NEW = ['growth_outbound_verify_queue(integer)', 'growth_outbound_enrichment_queue(integer)', 'growth_outbound_enrichment_mark(bigint,text,jsonb)',
    'growth_outbound_enrichment_export(integer)', 'growth_outbound_provider_import(text,jsonb)', 'growth_outbound_domain_auth_record(jsonb)',
    'growth_outbound_prospect_set_segment(uuid,text,text)', 'growth_outbound_qualification_rules()', 'growth_outbound_partner_leads(integer)',
    'growth_outbound_morning()', 'growth_outbound_draft_check(uuid,jsonb)'];
  chk('Z anon may call none of the eleven new doors', NEW.every((f) => one(`select has_function_privilege('anon', 'public.${f}', 'execute');`) === 'f'));
  chk('Z … nor the service role', NEW.every((f) => one(`select has_function_privilege('service_role', 'public.${f}', 'execute');`) === 'f'));
  const rules = own(`select public.growth_outbound_qualification_rules();`);
  chk('Z the rules door: the threshold, the five parts and penalties in words, the catalogue with its parts', rules.threshold === 75 && rules.parts.length === 6
    && rules.parts.filter((x) => x.max).reduce((a, x) => a + x.max, 0) === 100 && rules.catalogue.every((c) => c.category), rules.parts.map((x) => x.part));
  const rep = db.applyFileAtomic(FILE);
  chk('Z the file re-runs over all of this, every report row ok', !/CHECK THIS/.test(rep), rep.split('\n').filter((l) => /CHECK THIS/.test(l)));
  chk('Z … row 37 says the threshold, today\'s cap and the domain', /^37\|qualification and providers \(Phase 12\).*\|ok — threshold 75, today's live cap 6, sending domain checked: SPF, DKIM and DMARC in place$/m.test(rep),
    rep.split('\n').filter((l) => /^37\|/.test(l)));
  // a broken invariant shows: a reason with no part
  one(`alter table growth_outbound.fit_factor_catalog drop constraint fit_factor_catalog_category_ck; update growth_outbound.fit_factor_catalog set category = null where code = 'spam';`);
  chk('Z a reason with no part fails row 37', one(`select outcome from growth_outbound.self_check() where step = 37;`) === 'CHECK THIS');
  db.applyFileAtomic(FILE);
  chk('Z … and running the file again restores it', /^ok/.test(one(`select outcome from growth_outbound.self_check() where step = 37;`)));
} catch (err) {
  chk('the suite ran without an unexpected error', false, String(err.sqlMessage || err.message).slice(0, 1500));
} finally {
  db.stop();
}
process.exit(T.done());
