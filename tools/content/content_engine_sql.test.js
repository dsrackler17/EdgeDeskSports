#!/usr/bin/env node
/* ===========================================================================
   THE CONTENT ENGINE'S DATABASE (supabase/content_engine.sql), against a real
   PostgreSQL — the doors, the owner gate and every invariant the triggers hold.

     F  FILE      no psql meta-commands; idempotent (applied twice); the
                  report reads ok on every row
     W  WHO       anon reaches no door; an affiliate admin who is not an
                  outbound owner reaches none; the service role reaches only
                  the job doors and can never approve, send or publish
     O  OPPS      discovery is idempotent on the key; a dismissed opportunity
                  stays dismissed; a source without a URL or a time is refused
     A  ARTICLES  one live article per research × publisher × format × angle;
                  the campaign code is a utm_campaign growth.sql keeps intact;
                  the job may only rewrite its own untouched drafts
     S  STATES    draft → in_review only with checks passed; approval only by
                  an owner, for the exact content hash, with the five-point
                  review complete and clean language; an edit after approval
                  goes back to review; ready → sent only with a delivery
                  record; sent content is frozen; published needs its URL;
                  a sent article stays archived; no row is ever deleted
     L  LOGS      revisions, deliveries, performance, events and benchmarks
                  are append-only, truncate included
     B  BUDGET    calls counted before they are made, refused over the cap
     J  JOBS      one run per job and period; a forced re-run supersedes
     P  PERF      first-party counts joined on the campaign code, owners
                  excluded, no identity returned; Search Console evidence is
                  EdgeDesk's own exposure
     E  EMAIL     Send to publisher: only an owner; only the approved hash;
                  a real send only once ready and only to a contact on the
                  publisher's profile, a test only to the owner's own address;
                  claimed before the provider is called, an unanswered claim
                  answered with the same key, one real send per person; the
                  result records a delivery and `sent`; a send is a record;
                  an install from before Send widens the delivery methods

   Run: node tools/content/content_engine_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));

const T = PG.kit('content engine SQL');
const chk = T.chk;
const FILE = path.join(PG.ROOT, 'supabase', 'content_engine.sql');
const SQL = fs.readFileSync(FILE, 'utf8');

chk('F no psql meta-commands', !/^\s*\\/m.test(SQL));
chk('F ends in a report', /select check_name, case when passed then 'ok' else 'CHECK THIS' end/.test(SQL));
chk('F the seed carries no contact, terms or view figures', !/\b351\b|\b4[5-8] views\b|@stadiumrant|steven/i.test(SQL));

const db = PG.start('contentsql');
if (db.skip) { console.log((process.env.CONTENT_PG_REQUIRED ? 'FAIL | ' : 'NOTE | ') + db.skip + ' — skipped'); if (process.env.CONTENT_PG_REQUIRED) process.exit(1); process.exit(T.done()); }

const lit = PG.lit;
const OWNER = '00000000-0000-0000-0000-0000000000c1';
const ADMIN = '00000000-0000-0000-0000-0000000000c2';
const USER = '00000000-0000-0000-0000-0000000000c3';
const READER = '00000000-0000-0000-0000-0000000000c4';
const J = (s) => (s === '' ? null : JSON.parse(s));
const own = (s) => J(db.as(OWNER, s));
const svc = (s) => J(db.service(s));
const one = (s) => db.sql(s);
const fails = (fn) => db.mustFail(fn);

const RESEARCH = { as_of: '2026-10-08T17:07:39Z', league: 'cfb', games: [{ home: 'Alabama', away: 'Georgia' }] };
const SOURCES = [{ kind: 'edgedesk_research', url: 'https://edgedesksports.com/football/cfb_terminal/games.json', as_of: '2026-10-08T17:07:39Z' }];
const opp = (key, extra) => Object.assign({ key, league: 'cfb', season: 2026, week: 6, kind: 'weekly_preview', title: 'College Football Week 6 Predictions',
  angle: 'broad', summary: 's', teams: ['Alabama', 'Georgia'], research: RESEARCH, research_hash: 'h1', sources: SOURCES,
  scores: { total: 82 }, priority: 82, formats: ['cfb_weekly_preview'], expires_at: '2099-01-01T00:00:00Z' }, extra || {});
const SECTIONS = [{ key: 'intro', heading: null, body: 'EdgeDesk’s model makes Alabama a 5.3-point favorite.' },
  { key: 'how_to_read', heading: 'How to read these numbers', body: 'A projection is not a bet.' }];
const content = (extra) => Object.assign({ title: 'College Football Week 6 Predictions: Biggest Games', slug: 'college-football-week-6-predictions',
  meta_description: 'EdgeDesk’s Week 6 projections.', standfirst: 'Research, not picks.', primary_keyword: 'college football week 6 predictions',
  secondary_keywords: ['cfb week 6'], sections: SECTIONS, word_count: 20, generator: 'template:content_engine_v1',
  checks: { ok: true, failed: [], warned: [] } }, extra || {});
const REVIEW = { source_verification: true, data_freshness: true, model_accuracy: true, seo_review: true, compliance: true, notes: 'ok' };
const hashOf = (id) => one(`select content_hash from content_engine.articles where id = ${lit(id)};`);
/* an editorial gate report (lib/content_engine.js gate) for the current version */
const GATE = (verdict, findings) => ({ schema: 'edgedesk_editorial_gate_v1', verdict, items: [{ key: 'claims', label: 'Unsupported factual claims', status: verdict,
  findings: findings || (verdict === 'PASS' ? [] : [{ status: verdict, reason: 'test finding' }]) }] });
const gateAs = (id, verdict, report, who) => J(db.as(who || OWNER, `select public.content_engine_article_gate(${lit(id)}, ${lit(hashOf(id))}, ${lit(JSON.stringify(report || GATE(verdict || 'PASS')))}::jsonb);`));
const statusOf = (id) => one(`select status from content_engine.articles where id = ${lit(id)};`);

try {
  ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql', 'funnel.sql', 'growth_outbound.sql', 'growth_engine.sql']
    .forEach((f) => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f)));
  /* an install from before Send to publisher: no 'email' delivery method */
  const OLD = SQL.replace(/^  method        text not null check \(method in \('manual_email', 'email', /m, "  method        text not null check (method in ('manual_email', ")
    .replace(/-- an install from before Send: widen[\s\S]*?end \$c\$;\n/, '');
  chk('F (setup) the pre-Send variant differs', OLD !== SQL);
  db.applyText(OLD);
  const methodDef = () => one(`select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'content_engine.deliveries'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%manual_email%';`);
  chk('F the pre-Send install has no email delivery method', !/'email'/.test(methodDef()));
  const rep1 = db.applyFileAtomic(FILE);
  chk('F … re-applying the file widens it in place', /'email'/.test(methodDef()));
  const rep2 = db.applyFileAtomic(FILE);
  const bad = (r) => r.split('\n').filter((l) => l && !/\|ok\|/.test(l));
  chk('F the report reads ok on every row', bad(rep1).length === 0 && rep1.split('\n').length >= 9, bad(rep1));
  chk('F applied twice: still ok, nothing duplicated', bad(rep2).length === 0 && one(`select count(*) from content_engine.publishers;`) === '1');

  one(`insert into auth.users (id, email, email_confirmed_at) values
         (${lit(OWNER)}, 'owner@edgedesk.test', now()), (${lit(ADMIN)}, 'admin@edgedesk.test', now()),
         (${lit(USER)}, 'user@edgedesk.test', now()), (${lit(READER)}, 'reader@edgedesk.test', now());
       insert into public.affiliate_admins (user_id) values (${lit(OWNER)}), (${lit(ADMIN)});
       select growth_outbound.grant_owner('owner@edgedesk.test');`);

  /* ── W who ─────────────────────────────────────────────────────────── */
  chk('W anon cannot even ask', !!fails(() => db.anon('select public.content_engine_is_owner();')));
  chk('W the owner is an owner', db.as(OWNER, 'select public.content_engine_is_owner();') === 't');
  chk('W an affiliate admin is not', db.as(ADMIN, 'select public.content_engine_is_owner();') === 'f');
  chk('W … and is refused at the overview', /owner only/.test(fails(() => db.as(ADMIN, 'select public.content_engine_overview();')) || ''));
  chk('W a subscriber is refused at the publishers door', /owner only/.test(fails(() => db.as(USER, 'select public.content_engine_publishers();')) || ''));
  chk('W the service role cannot read publishers (contacts)', !!fails(() => db.service('select public.content_engine_publishers();')));
  chk('W … but may read editorial profiles for the job', (svc('select public.content_engine_job_publishers();') || []).some((p) => p.slug === 'stadium-rant' && !('contacts' in p)));
  chk('W the service role cannot approve', /permission denied/.test(fails(() => db.service(`select public.content_engine_article_approve(gen_random_uuid(), 'x');`)) || ''));
  chk('W the service role cannot move an article to sent or published', /permission denied/.test(fails(() => db.service(`select public.content_engine_article_transition(gen_random_uuid(), 'sent', '{}'::jsonb);`)) || ''));
  chk('W no client role can touch the tables', !!fails(() => db.as(OWNER, 'select count(*) from content_engine.articles;'))
    && !!fails(() => db.service('select count(*) from content_engine.articles;')));
  const ov = own('select public.content_engine_overview();');
  chk('W the owner sees the overview', ov && ov.settings && ov.settings.default_publisher === 'stadium-rant' && ov.budget.llm.cap === 20);

  /* ── publishers & benchmarks ──────────────────────────────────────── */
  const pubs = own('select public.content_engine_publishers();');
  const SR = pubs.find((p) => p.slug === 'stadium-rant');
  chk('the Stadium Rant profile is seeded with editorial preferences only', SR && SR.editorial.prefer_broad === true && SR.contacts.length === 0 && SR.benchmarks.length === 0);
  const saved = own(`select public.content_engine_publisher_save(${lit(JSON.stringify({ id: SR.id, contacts: [{ name: 'Editor', role: 'editor', email: 'editor@example.test' }], partnership: { terms: 'editorial attribution' } }))}::jsonb);`);
  chk('the owner adds contacts and terms', saved.ok && own('select public.content_engine_publishers();').find((p) => p.slug === 'stadium-rant').contacts.length === 1);
  const b1 = own(`select public.content_engine_benchmark_add(${lit(JSON.stringify({ publisher_id: SR.id, metric: 'avg_article_views', label: 'Average views, recent articles', value: 100, sample_size: 5, source: 'user_reported' }))}::jsonb);`);
  const b2 = own(`select public.content_engine_benchmark_add(${lit(JSON.stringify({ publisher_id: SR.id, metric: 'edgedesk_article_views', label: 'Earlier EdgeDesk matchup articles', value_low: 10, value_high: 20, source: 'user_reported' }))}::jsonb);`);
  chk('benchmarks: a value or a range, labelled user-reported', b1.ok && b2.ok);
  const b3 = own(`select public.content_engine_benchmark_add(${lit(JSON.stringify({ publisher_id: SR.id, metric: 'avg_article_views', label: 'no value' }))}::jsonb);`);
  chk('a benchmark without a value is refused', b3.ok === false);
  const p2 = own(`select public.content_engine_publisher_save(${lit(JSON.stringify({ slug: 'second-site', name: 'Second Site', website: 'https://second.example' }))}::jsonb);`);
  chk('a second publisher can be added (multi-publisher)', p2.ok);
  chk('a publisher cannot be deleted', !!fails(() => one(`delete from content_engine.publishers where slug = 'second-site';`)));

  /* ── O opportunities ──────────────────────────────────────────────── */
  const u1 = svc(`select public.content_engine_opportunity_upsert(${lit(JSON.stringify(opp('cfb:2026:w6:weekly_preview')))}::jsonb, null);`);
  chk('O the weekly job records an opportunity', u1.ok && u1.created === true);
  const u2 = own(`select public.content_engine_opportunity_upsert(${lit(JSON.stringify(opp('cfb:2026:w6:weekly_preview', { priority: 85, research_hash: 'h2' })))}::jsonb, null);`);
  chk('O found again: the same row, refreshed, research change flagged', u2.ok && u2.id === u1.id && u2.created === false && u2.research_changed === true);
  chk('O … one row, not two', one(`select count(*) from content_engine.opportunities;`) === '1' && one(`select priority from content_engine.opportunities;`) === '85');
  const noUrl = svc(`select public.content_engine_opportunity_upsert(${lit(JSON.stringify(opp('cfb:2026:w6:upset_watch', { sources: [{ kind: 'external_report', publisher: 'X', title: 'y' }] })))}::jsonb, null);`);
  chk('O a source without a URL and a time is refused', noUrl.ok === false);
  const dis = svc(`select public.content_engine_opportunity_upsert(${lit(JSON.stringify(opp('cfb:2026:w6:conference_race:sec', { kind: 'conference_race' })))}::jsonb, null);`);
  own(`select public.content_engine_opportunity_set_status(${lit(dis.id)}, 'dismissed', 'not for us');`);
  const dis2 = svc(`select public.content_engine_opportunity_upsert(${lit(JSON.stringify(opp('cfb:2026:w6:conference_race:sec', { kind: 'conference_race' })))}::jsonb, null);`);
  chk('O a dismissed opportunity stays dismissed when found again', dis2.status === 'dismissed');
  chk('O … and gets no article', own(`select public.content_engine_article_create(${lit(dis.id)}, ${lit(SR.id)}, 'cfb_weekly_preview', 'full_slate', ${lit(JSON.stringify(content()))}::jsonb, null);`).reason === 'dismissed');
  chk('O the job cannot dismiss', !!fails(() => db.service(`select public.content_engine_opportunity_set_status(${lit(u1.id)}, 'dismissed', 'x');`)));
  chk('O an opportunity cannot be deleted', !!fails(() => one(`delete from content_engine.opportunities;`)));
  const targets = svc(`select public.content_engine_job_targets(${lit(SR.id)}, 5);`);
  chk('O job targets: open, above the floor, not yet drafted', targets.length === 1 && targets[0].id === u1.id);

  /* ── A articles ───────────────────────────────────────────────────── */
  const c1 = svc(`select public.content_engine_article_create(${lit(u1.id)}, ${lit(SR.id)}, 'cfb_weekly_preview', 'full_slate', ${lit(JSON.stringify(content()))}::jsonb, null);`);
  chk('A the job drafts an article', c1.ok && c1.existing === false && statusOf(c1.id) === 'draft');
  chk('A its campaign code is ce_<publisher>_<id>, safe for utm_campaign', /^ce_stadiumrant_[0-9a-f]{12}$/.test(c1.campaign_code));
  const c2 = own(`select public.content_engine_article_create(${lit(u1.id)}, ${lit(SR.id)}, 'cfb_weekly_preview', 'full_slate', ${lit(JSON.stringify(content()))}::jsonb, null);`);
  chk('A asked again: the same article back, not a copy', c2.ok && c2.existing === true && c2.id === c1.id);
  const c3 = own(`select public.content_engine_article_create(${lit(u1.id)}, ${lit(SR.id)}, 'cfb_weekly_preview', 'upsets_first', ${lit(JSON.stringify(content({ title: 'Week 6 College Football Upsets: The Underdogs to Watch' })))}::jsonb, null);`);
  chk('A a different angle on the same research is its own article', c3.ok && c3.existing === false && c3.id !== c1.id);
  chk('A the opportunity is now assigned', one(`select status from content_engine.opportunities where id = ${lit(u1.id)};`) === 'assigned');
  chk('A revision 1 is recorded', one(`select count(*) from content_engine.revisions where article_id = ${lit(c1.id)};`) === '1');
  const js1 = svc(`select public.content_engine_article_save(${lit(c1.id)}, ${lit(JSON.stringify({ generator: 'claude:claude-opus-5-5', sections: SECTIONS.concat([{ key: 'conclusion', heading: 'The bottom line', body: 'None of it is a pick.' }]), checks: { ok: true } }))}::jsonb, 'ai pass', null);`);
  chk('A the job may rewrite its own untouched draft', js1.ok && js1.revision === 2);
  const stale = own(`select public.content_engine_article_save(${lit(c1.id)}, ${lit(JSON.stringify({ title: 'College Football Week 6 Predictions: Edited by the owner' }))}::jsonb, 'owner edit', 'not-the-hash');`);
  chk('A a save over a version the caller never saw is refused', stale.ok === false && stale.reason === 'changed_since_loaded');
  const os1 = own(`select public.content_engine_article_save(${lit(c1.id)}, ${lit(JSON.stringify({ title: 'College Football Week 6 Predictions: Edited by the owner' }))}::jsonb, 'owner edit', ${lit(hashOf(c1.id))});`);
  chk('A the owner edits', os1.ok && os1.revision === 3);
  const js2 = svc(`select public.content_engine_article_save(${lit(c1.id)}, ${lit(JSON.stringify({ title: 'College Football Week 6 Predictions: the job again' }))}::jsonb, 'job', null);`);
  chk('A … after which the job may not overwrite it', js2.ok === false && js2.reason === 'owner_owned');

  /* ── S states ─────────────────────────────────────────────────────── */
  own(`select public.content_engine_article_save(${lit(c1.id)}, ${lit(JSON.stringify({ checks: { ok: false, failed: ['numbers_in_evidence'] } }))}::jsonb, 'checks', null);`);
  const sub0 = own(`select public.content_engine_article_submit(${lit(c1.id)});`);
  chk('S failed checks cannot go to review', sub0.ok === false && sub0.reason === 'checks_failed');
  own(`select public.content_engine_article_save(${lit(c1.id)}, ${lit(JSON.stringify({ checks: { ok: true, failed: [] } }))}::jsonb, 'checks', null);`);
  chk('S checks passed: to review', own(`select public.content_engine_article_submit(${lit(c1.id)});`).ok && statusOf(c1.id) === 'in_review');
  chk('S a direct status write cannot approve (no door)', !!fails(() => one(`update content_engine.articles set status = 'approved', approved_by = ${lit(OWNER)}, approved_hash = content_hash where id = ${lit(c1.id)};`)));
  chk('S a direct write cannot skip ahead to sent', !!fails(() => one(`update content_engine.articles set status = 'sent' where id = ${lit(c1.id)};`)));
  const ap0 = own(`select public.content_engine_article_approve(${lit(c1.id)}, ${lit(hashOf(c1.id))});`);
  chk('S approval needs the five-point review', ap0.ok === false && ap0.reason === 'review_incomplete');
  own(`select public.content_engine_article_review(${lit(c1.id)}, ${lit(JSON.stringify(Object.assign({}, REVIEW, { compliance: false })))}::jsonb);`);
  chk('S … all five points', own(`select public.content_engine_article_approve(${lit(c1.id)}, ${lit(hashOf(c1.id))});`).reason === 'review_incomplete');
  chk('S the admin cannot review', !!fails(() => db.as(ADMIN, `select public.content_engine_article_review(${lit(c1.id)}, ${lit(JSON.stringify(REVIEW))}::jsonb);`)));
  own(`select public.content_engine_article_review(${lit(c1.id)}, ${lit(JSON.stringify(REVIEW))}::jsonb);`);
  chk('S approval is for the exact content: a stale hash is refused', own(`select public.content_engine_article_approve(${lit(c1.id)}, 'deadbeef');`).reason === 'changed_since_loaded');
  /* ── G the editorial gate ─────────────────────────────────────────── */
  chk('G approval needs a gate report for this version', own(`select public.content_engine_article_approve(${lit(c1.id)}, ${lit(hashOf(c1.id))});`).reason === 'gate_not_run');
  chk('G a report whose verdict is not its worst finding is refused', gateAs(c1.id, null, Object.assign(GATE('BLOCKED'), { verdict: 'PASS' })).reason === 'verdict_mismatch');
  chk('G a report for another version is refused', J(db.as(OWNER, `select public.content_engine_article_gate(${lit(c1.id)}, 'deadbeef', ${lit(JSON.stringify(GATE('PASS')))}::jsonb);`)).reason === 'changed_since_loaded');
  chk('G a report claiming an acknowledgement the owner never made is refused',
    gateAs(c1.id, null, GATE('WARNING', [{ status: 'WARNING', reason: 'Reviewed by the owner: gap', ack_key: 'discrepancy:401', acknowledged: { note: 'x' } }])).reason === 'unknown_acknowledgement');
  const gb = gateAs(c1.id, 'BLOCKED');
  chk('G a BLOCKED report is stored, with the first verdict kept', gb.ok && gb.verdict === 'BLOCKED'
    && one(`select gate_verdict || '|' || first_gate_verdict || '|' || array_to_string(first_gate_blocked, ',') from content_engine.articles where id = ${lit(c1.id)};`) === 'BLOCKED|BLOCKED|claims');
  chk('G a BLOCKED version cannot be approved', own(`select public.content_engine_article_approve(${lit(c1.id)}, ${lit(hashOf(c1.id))});`).reason === 'gate_blocked');
  chk('G the admin cannot acknowledge a review finding', /owner only/.test(fails(() => db.as(ADMIN, `select public.content_engine_article_ack(${lit(c1.id)}, 'discrepancy:401', 'checked');`)) || ''));
  chk('G an acknowledgement needs a note', own(`select public.content_engine_article_ack(${lit(c1.id)}, 'discrepancy:401', 'x');`).reason === 'note_required');
  chk('G … and a known kind of finding', own(`select public.content_engine_article_ack(${lit(c1.id)}, 'anything:1', 'checked it');`).reason === 'bad_key');
  const ak = own(`select public.content_engine_article_ack(${lit(c1.id)}, 'discrepancy:401', 'checked injuries and QB news');`);
  chk('G the owner acknowledges, with a note; the gate must run again', ak.ok && one(`select (acks -> 'discrepancy:401' ->> 'note') || '|' || (gate_at is null)::text from content_engine.articles where id = ${lit(c1.id)};`) === 'checked injuries and QB news|true');
  chk('G … after which a report may carry that acknowledgement', gateAs(c1.id, null, GATE('WARNING', [{ status: 'WARNING', reason: 'Reviewed by the owner: gap', ack_key: 'discrepancy:401', acknowledged: { note: 'checked' } }])).ok);
  own(`select public.content_engine_article_ack(${lit(c1.id)}, 'discrepancy:401', null);`);
  chk('G withdrawing a review leaves the gate unrun: the old WARNING cannot approve (a NULL time is never fresh)', own(`select public.content_engine_article_approve(${lit(c1.id)}, ${lit(hashOf(c1.id))});`).reason === 'gate_stale'
    && one(`select gate_verdict || '|' || (gate_at is null)::text from content_engine.articles where id = ${lit(c1.id)};`) === 'WARNING|true');
  chk('G … and the table itself refuses it, even posing as the approve door', /run the editorial gate/.test(fails(() => one(`begin; select set_config('request.jwt.claim.sub', ${lit(OWNER)}, true), set_config('content_engine.door', 'approve', true);
       update content_engine.articles set status = 'approved', approved_by = ${lit(OWNER)}, approved_at = now(), approved_hash = content_hash where id = ${lit(c1.id)}; commit;`)) || ''));
  chk('G the weekly job may store a report (service role), the admin may not', J(db.service(`select public.content_engine_article_gate(${lit(c1.id)}, ${lit(hashOf(c1.id))}, ${lit(JSON.stringify(GATE('PASS')))}::jsonb);`)).ok
    && /owner only/.test(fails(() => gateAs(c1.id, 'PASS', null, ADMIN)) || ''));
  chk('G the first verdict is never rewritten', one(`select first_gate_verdict from content_engine.articles where id = ${lit(c1.id)};`) === 'BLOCKED');
  chk('G every run is in the activity log', +one(`select count(*) from content_engine.events where kind = 'gate_run' and article_id = ${lit(c1.id)};`) >= 3);
  const ap1 = own(`select public.content_engine_article_approve(${lit(c1.id)}, ${lit(hashOf(c1.id))});`);
  chk('S the owner approves', ap1.ok && statusOf(c1.id) === 'approved'
    && one(`select approved_by::text || '|' || (approved_hash = content_hash)::text from content_engine.articles where id = ${lit(c1.id)};`) === OWNER + '|true');
  chk('S approval cannot be rewritten to someone else', !!fails(() => one(`update content_engine.articles set approved_by = ${lit(ADMIN)} where id = ${lit(c1.id)};`)));
  const e1 = own(`select public.content_engine_article_save(${lit(c1.id)}, ${lit(JSON.stringify({ standfirst: 'Changed after approval.' }))}::jsonb, 'late edit', null);`);
  chk('S an edit after approval goes back to review, approval cleared', e1.ok && e1.status === 'in_review'
    && one(`select coalesce(approved_by::text, 'none') from content_engine.articles where id = ${lit(c1.id)};`) === 'none');
  const reviewStale = own(`select public.content_engine_article_approve(${lit(c1.id)}, ${lit(hashOf(c1.id))});`);
  chk('S the review was for the old version: review again', reviewStale.reason === 'review_is_for_an_older_version');
  own(`select public.content_engine_article_review(${lit(c1.id)}, ${lit(JSON.stringify(REVIEW))}::jsonb);`);
  /* language: the database's own floor */
  const badSecs = SECTIONS.concat([{ key: 'conclusion', heading: 'x', body: 'Alabama is a guaranteed winner.' }]);
  own(`select public.content_engine_article_save(${lit(c3.id)}, ${lit(JSON.stringify({ sections: badSecs, checks: { ok: true } }))}::jsonb, 'bad words', null);`);
  own(`select public.content_engine_article_submit(${lit(c3.id)});`);
  own(`select public.content_engine_article_review(${lit(c3.id)}, ${lit(JSON.stringify(REVIEW))}::jsonb);`);
  gateAs(c3.id, 'PASS');   /* even a passing report: the database's own language floor still refuses */
  const ap3 = own(`select public.content_engine_article_approve(${lit(c3.id)}, ${lit(hashOf(c3.id))});`);
  chk('S tout language blocks approval even with the checks passed', ap3.ok === false && ap3.reason === 'language' && /guarantee/.test(JSON.stringify(ap3.terms)));
  chk('G an edit makes the old report stale: approval asks for a new one', own(`select public.content_engine_article_approve(${lit(c1.id)}, ${lit(hashOf(c1.id))});`).reason === 'gate_not_run');
  gateAs(c1.id, 'PASS');
  chk('S approve again, at the current hash', own(`select public.content_engine_article_approve(${lit(c1.id)}, ${lit(hashOf(c1.id))});`).ok);
  /* the gate is the database's rule: the table's own trigger refuses a BLOCKED or stale report whatever the door */
  gateAs(c1.id, 'BLOCKED');
  chk('G Ready to Send refuses a BLOCKED report (door)', own(`select public.content_engine_article_transition(${lit(c1.id)}, 'ready_to_send', '{}'::jsonb);`).reason === 'gate_blocked');
  chk('G … and the trigger refuses it on any path', /editorial gate blocked/.test(fails(() => one(`update content_engine.articles set status = 'ready_to_send' where id = ${lit(c1.id)};`)) || ''));
  gateAs(c1.id, 'PASS');
  one(`update content_engine.articles set gate_at = now() - interval '25 hours' where id = ${lit(c1.id)};`);
  chk('G a report older than a day is stale', own(`select public.content_engine_article_transition(${lit(c1.id)}, 'ready_to_send', '{}'::jsonb);`).reason === 'gate_stale');
  gateAs(c1.id, 'WARNING');
  chk('S approved → ready to send', own(`select public.content_engine_article_transition(${lit(c1.id)}, 'ready_to_send', '{}'::jsonb);`).ok && statusOf(c1.id) === 'ready_to_send');
  chk('S approved cannot jump to published', own(`select public.content_engine_article_transition(${lit(c3.id)}, 'published', '{"url":"https://x.example/a"}'::jsonb);`).ok === false);
  const sent0 = own(`select public.content_engine_article_transition(${lit(c1.id)}, 'sent', '{}'::jsonb);`);
  chk('S sent needs the delivery method', sent0.ok === false && sent0.reason === 'method_required');
  const sent1 = own(`select public.content_engine_article_transition(${lit(c1.id)}, 'sent', '{"method":"manual_email","note":"sent by the owner"}'::jsonb);`);
  chk('S the owner records the send: status, time and a delivery row at the sent hash', sent1.ok && statusOf(c1.id) === 'sent'
    && one(`select count(*) from content_engine.deliveries d join content_engine.articles a on a.id = d.article_id where a.id = ${lit(c1.id)} and d.content_hash = a.content_hash and a.sent_at is not null;`) === '1');
  chk('S sent content is frozen', own(`select public.content_engine_article_save(${lit(c1.id)}, '{"title":"College Football Week 6: after sending"}'::jsonb, 'x', null);`).reason === 'frozen'
    && !!fails(() => one(`update content_engine.articles set title = 'College Football Week 6: sneaky edit' where id = ${lit(c1.id)};`)));
  chk('S published needs an https URL', own(`select public.content_engine_article_transition(${lit(c1.id)}, 'published', '{"url":"ftp://x"}'::jsonb);`).reason === 'url_required');
  chk('S published, with its URL', own(`select public.content_engine_article_transition(${lit(c1.id)}, 'published', '{"url":"https://www.stadiumrant.com/week-6"}'::jsonb);`).ok && statusOf(c1.id) === 'published');
  chk('S archived', own(`select public.content_engine_article_transition(${lit(c1.id)}, 'archived', '{}'::jsonb);`).ok && statusOf(c1.id) === 'archived');
  chk('S a sent article stays archived', own(`select public.content_engine_article_transition(${lit(c1.id)}, 'draft', '{}'::jsonb);`).ok === false);
  chk('S articles are never deleted', !!fails(() => one(`delete from content_engine.articles where id = ${lit(c3.id)};`)));
  chk('S a new article cannot be inserted already approved', !!fails(() => one(`insert into content_engine.articles (opportunity_id, format, title, slug, sections, generator, research_hash, campaign_code, created_by, status)
      values (${lit(u1.id)}, 'cfb_weekly_preview', 'College Football Week 6 Predictions', 'x', '[{"key":"intro","body":"x"}]', 'template', 'h', 'ce_x_y', 'owner', 'approved');`)));

  /* ── E email: Send to publisher ──────────────────────────────────── */
  const ue = svc(`select public.content_engine_opportunity_upsert(${lit(JSON.stringify(opp('cfb:2026:w6:upset_watch', { kind: 'upset_watch', title: 'College Football Week 6 Upset Watch' })))}::jsonb, null);`);
  const em = own(`select public.content_engine_article_create(${lit(ue.id)}, ${lit(SR.id)}, 'cfb_weekly_preview', 'full_slate', ${lit(JSON.stringify(content({ title: 'College Football Week 6 Upset Watch: Underdogs With a Real Chance' })))}::jsonb, null);`);
  const EM = em.id;
  own(`select public.content_engine_article_submit(${lit(EM)});`);
  own(`select public.content_engine_article_review(${lit(EM)}, ${lit(JSON.stringify(REVIEW))}::jsonb);`);
  gateAs(EM, 'PASS');
  chk('E (setup) approved', own(`select public.content_engine_article_approve(${lit(EM)}, ${lit(hashOf(EM))});`).ok);
  const claim = (who, to, test, hash) => J(db[who === 'svc' ? 'service' : 'as'](...(who === 'svc' ? [] : [who]),
    `select public.content_engine_send_claim(${lit(EM)}, ${lit(to)}, null, ${lit(hash === undefined ? hashOf(EM) : hash)}, ${test ? 'true' : 'false'});`));
  const claimAs = (uid, to, test, hash) => J(db.as(uid, `select public.content_engine_send_claim(${lit(EM)}, ${lit(to)}, null, ${lit(hash === undefined ? hashOf(EM) : hash)}, ${test ? 'true' : 'false'});`));
  chk('E the service role cannot send', /permission denied/.test(fails(() => db.service(`select public.content_engine_send_claim(${lit(EM)}, 'editor@example.test', null, ${lit(hashOf(EM))}, false);`)) || ''));
  chk('E an affiliate admin cannot send', /owner only/.test(fails(() => claimAs(ADMIN, 'editor@example.test', false)) || ''));
  chk('E a real send waits for “ready to send”', claimAs(OWNER, 'editor@example.test', false).reason === 'not_ready');
  chk('E a test before that goes only to the owner’s own address', claimAs(OWNER, 'editor@example.test', true).reason === 'test_goes_to_you');
  const t1 = claimAs(OWNER, 'owner@edgedesk.test', true);
  chk('E a test to the owner is claimed, from the edgedesksports.com sender', t1.ok && t1.test === true && /^[^<]+ <[a-z0-9._%+-]+@edgedesksports\.com>$/.test(t1.message.from) && t1.message.to === 'owner@edgedesk.test');
  chk('E … and its success changes no status', own(`select public.content_engine_send_result(${t1.send_id}, 'resend-test-1', null);`).state === 'sent' && statusOf(EM) === 'approved'
    && one(`select count(*) from content_engine.deliveries where article_id = ${lit(EM)};`) === '0');
  own(`select public.content_engine_article_transition(${lit(EM)}, 'ready_to_send', '{}'::jsonb);`);
  chk('E only the approved hash on screen', claimAs(OWNER, 'editor@example.test', false, 'deadbeef').reason === 'changed_since_loaded');
  chk('E only a contact on the publisher’s profile', claimAs(OWNER, 'someone@else.test', false).reason === 'not_a_contact');
  const r1 = J(db.as(OWNER, `select public.content_engine_send_claim(${lit(EM)}, 'Editor@Example.test', null, ${lit(hashOf(EM))}, false, 'Hi Ed, here it is.');`));
  chk('E a contact (any case) is claimed, with a key, before anything is sent', r1.ok && r1.idempotency_key && /^edgedesk-content-[0-9a-f]{32}$/.test(r1.idempotency_key)
    && r1.message.to === 'editor@example.test' && r1.recipient_name === 'Editor' && one(`select status from content_engine.sends where id = ${r1.send_id};`) === 'claimed');
  const r2 = J(db.as(OWNER, `select public.content_engine_send_claim(${lit(EM)}, 'editor@example.test', 'Another subject', ${lit(hashOf(EM))}, false, 'An edited note');`));
  chk('E pressed again before an answer: the same send and the same key', r2.ok && r2.retry && r2.send_id === r1.send_id && r2.idempotency_key === r1.idempotency_key);
  chk('E … and the same message, whatever was typed since (Resend refuses a key reused with another body)', r1.message.note === 'Hi Ed, here it is.' && r2.message.note === 'Hi Ed, here it is.' && r2.message.subject === r1.message.subject);
  chk('E the job never learns a recipient', !/editor@example/.test(db.service(`select public.content_engine_article(${lit(EM)});`)));
  chk('E a send is a record: no field but its outcome changes', !!fails(() => one(`update content_engine.sends set subject = 'other' where id = ${r1.send_id};`))
    && !!fails(() => one(`delete from content_engine.sends where id = ${r1.send_id};`)) && !!fails(() => one(`truncate content_engine.sends;`)));
  const res = own(`select public.content_engine_send_result(${r1.send_id}, 're_abc123', null);`);
  chk('E delivered: `sent`, with an email delivery row at the sent hash', res.ok && res.state === 'sent' && statusOf(EM) === 'sent'
    && one(`select method || '|' || (content_hash = (select content_hash from content_engine.articles where id = ${lit(EM)}))::text from content_engine.deliveries where article_id = ${lit(EM)};`) === 'email|true');
  chk('E a finished send does not change', !!fails(() => one(`update content_engine.sends set status = 'failed' where id = ${r1.send_id};`)));
  chk('E the result is recorded once', own(`select public.content_engine_send_result(${r1.send_id}, 're_other', null);`).already === true);
  chk('E sent content cannot be sent again (it is no longer ready)', claimAs(OWNER, 'editor@example.test', false).reason === 'not_ready');
  /* a failure, then a second try */
  const ue2 = svc(`select public.content_engine_opportunity_upsert(${lit(JSON.stringify(opp('nfl:2026:w5:weekly_preview', { league: 'nfl', week: 5, title: 'NFL Week 5 Predictions' })))}::jsonb, null);`);
  const em2 = own(`select public.content_engine_article_create(${lit(ue2.id)}, ${lit(SR.id)}, 'nfl_weekly_preview', 'full_slate', ${lit(JSON.stringify(content({ title: 'NFL Week 5 Predictions: Biggest Games and Potential Upsets' })))}::jsonb, null);`).id;
  own(`select public.content_engine_article_submit(${lit(em2)});`);
  own(`select public.content_engine_article_review(${lit(em2)}, ${lit(JSON.stringify(REVIEW))}::jsonb);`);
  gateAs(em2, 'PASS');
  own(`select public.content_engine_article_approve(${lit(em2)}, ${lit(hashOf(em2))});`);
  own(`select public.content_engine_article_transition(${lit(em2)}, 'ready_to_send', '{}'::jsonb);`);
  const f1 = J(db.as(OWNER, `select public.content_engine_send_claim(${lit(em2)}, 'editor@example.test', 'NFL Week 5', ${lit(hashOf(em2))}, false);`));
  own(`select public.content_engine_send_result(${f1.send_id}, null, 'refused by Resend (422): invalid');`);
  chk('E a refused send is recorded failed; the article stays ready', one(`select status from content_engine.sends where id = ${f1.send_id};`) === 'failed' && statusOf(em2) === 'ready_to_send'
    && one(`select count(*) from content_engine.events where kind = 'send_failed';`) === '1');
  const f2 = J(db.as(OWNER, `select public.content_engine_send_claim(${lit(em2)}, 'editor@example.test', 'NFL Week 5', ${lit(hashOf(em2))}, false);`));
  chk('E … and can be tried again, with a new key', f2.ok && f2.send_id !== f1.send_id && f2.idempotency_key !== f1.idempotency_key);
  chk('E a subject that spans lines is refused', J(db.as(OWNER, `select public.content_engine_send_claim(${lit(em2)}, 'editor@example.test', E'two\\nlines', ${lit(hashOf(em2))}, false);`)).reason !== undefined);
  chk('E the sender: the outbound engine’s until one is set', own('select public.content_engine_overview();').sender.from === 'Davis <davis@edgedesksports.com>');
  chk('E a sender outside edgedesksports.com is refused', own(`select public.content_engine_sender_save('{"sender_email": "me@gmail.com"}'::jsonb);`).ok === false);
  const ss = own(`select public.content_engine_sender_save('{"sender_name": "Davis Rackler", "sender_email": "davis@edgedesksports.com", "reply_to_email": "dsrackler@example.com"}'::jsonb);`);
  chk('E the owner sets the sender and the reply-to', ss.ok && ss.sender.from === 'Davis Rackler <davis@edgedesksports.com>' && ss.sender.reply_to === 'dsrackler@example.com');

  /* ── L logs ───────────────────────────────────────────────────────── */
  ['revisions', 'deliveries', 'events', 'benchmarks'].forEach((t) => {
    chk('L ' + t + ' cannot be updated', !!fails(() => one(`update content_engine.${t} set id = id;`)));
    chk('L ' + t + ' cannot be deleted', !!fails(() => one(`delete from content_engine.${t};`)));
    chk('L ' + t + ' cannot be truncated', !!fails(() => one(`truncate content_engine.${t};`)));
  });
  chk('L every state change is in the activity log', +one(`select count(*) from content_engine.events where article_id = ${lit(c1.id)};`) >= 8);

  /* ── B budget ─────────────────────────────────────────────────────── */
  own(`select public.content_engine_settings_save('{"llm_calls_per_day": 2}'::jsonb);`);
  const s1 = svc(`select public.content_engine_spend('llm', 1);`), s2 = own(`select public.content_engine_spend('llm', 1);`), s3 = svc(`select public.content_engine_spend('llm', 1);`);
  chk('B calls are counted and refused over the cap', s1.ok && s2.ok && s3.ok === false && s3.reason === 'budget_exhausted');
  chk('B the cap is checked by the database', own(`select public.content_engine_settings_save('{"llm_calls_per_day": 5000}'::jsonb);`).ok === false);
  chk('B a reader cannot spend', !!fails(() => db.as(USER, `select public.content_engine_spend('llm', 1);`)));

  /* ── J jobs ───────────────────────────────────────────────────────── */
  const j1 = svc(`select public.content_engine_job_begin('weekly', '2026-cfb-w6', false);`);
  chk('J a run starts', j1.ok && j1.run_id > 0);
  chk('J the same period cannot run twice at once', svc(`select public.content_engine_job_begin('weekly', '2026-cfb-w6', false);`).reason === 'already_running');
  chk('J it finishes', svc(`select public.content_engine_job_finish(${j1.run_id}, 'done', '{"drafted":1}'::jsonb, null);`).ok);
  chk('J … and the same period is not run again', svc(`select public.content_engine_job_begin('weekly', '2026-cfb-w6', false);`).reason === 'already_done');
  const j3 = svc(`select public.content_engine_job_begin('weekly', '2026-cfb-w6', true);`);
  chk('J a forced re-run supersedes the old one', j3.ok && one(`select count(*) from content_engine.runs where status = 'superseded';`) === '1');
  svc(`select public.content_engine_job_finish(${j3.run_id}, 'failed', '{}'::jsonb, 'boom');`);
  chk('J a failed run is logged', one(`select count(*) from content_engine.events where kind = 'job_failed';`) === '1');
  own(`select public.content_engine_settings_save('{"schedule_enabled": false}'::jsonb);`);
  chk('J the owner can switch the schedule off', svc(`select public.content_engine_job_begin('weekly', '2026-nfl-w5', false);`).reason === 'schedule_disabled');
  chk('J log kinds are allowlisted', svc(`select public.content_engine_log('drop_tables', '{}'::jsonb, null, null, null);`).reason === 'bad_kind'
    && svc(`select public.content_engine_log('generation_failed', '{"why":"x"}'::jsonb, null, null, null);`).ok);

  /* ── P performance ────────────────────────────────────────────────── */
  const code = c1.campaign_code;
  one(`insert into public.acquisition_visitors (visitor_hash, first_source, first_utm_source, first_utm_campaign, first_seen_at, last_source, last_utm_campaign, last_seen_at, user_id) values
         ('v1', 'other', 'stadiumrant', ${lit(code)}, now(), 'other', ${lit(code)}, now(), null),
         ('v2', 'other', 'stadiumrant', ${lit(code)}, now(), 'direct', null, now(), ${lit(READER)}),
         ('v3', 'other', 'stadiumrant', ${lit(code)}, now(), 'direct', null, now(), ${lit(OWNER)}),
         ('v4', 'search', null, 'something_else', now(), 'search', null, now(), null);
       insert into public.user_acquisition (user_id, visitor_hash, signup_at, first_source, first_utm_campaign, last_source)
       values (${lit(READER)}, 'v2', now(), 'other', ${lit(code)}, 'other'), (${lit(OWNER)}, 'v3', now(), 'other', ${lit(code)}, 'other');
       insert into public.stripe_events (id, type, stripe_created, user_id, payload) values
         ('evt_t1', 'customer.subscription.created', now(), ${lit(READER)}, '{"data":{"object":{"id":"sub_1","status":"trialing","trial_start":1790000000}}}');`);
  own(`select public.content_engine_performance_add(${lit(JSON.stringify({ article_id: c1.id, metric: 'page_views', value: 120, source: 'publisher_reported', note: 'from the editor' }))}::jsonb);`);
  const perf = own('select public.content_engine_performance();');
  const row = perf.articles.find((a) => a.id === c1.id);
  chk('P first-party visits by campaign code, the owner excluded', row && row.first_party.visits === 2, row && row.first_party);
  chk('P signups and trials by campaign code, the owner excluded', row && row.first_party.signups === 1 && row.first_party.trials === 1 && row.first_party.paid === 0, row && row.first_party);
  chk('P publisher-reported figures kept apart, as entered', row && row.publisher_reported.page_views && row.publisher_reported.page_views.value === 120 && row.publisher_reported.page_views.source === 'publisher_reported');
  chk('P benchmarks travel with the report, labelled', perf.benchmarks.length === 2 && perf.benchmarks.every((b) => b.source === 'user_reported'));
  chk('P no identity leaves the database', !/visitor_hash|"v1"|@edgedesk\.test|user_id/.test(JSON.stringify(row.first_party)));
  chk('P what is measured is stated', perf.measured.visits === true && perf.measured.trials_paid === true);
  one(`insert into public.search_console_queries (day, query, clicks, impressions) values (current_date - 2, 'college football week 6 predictions', 3, 140), (current_date - 40, 'college football week 6 predictions', 9, 900);`);
  const ev = svc(`select public.content_engine_search_evidence('["college football week 6 predictions", "nfl week 5 predictions"]'::jsonb);`);
  chk('P Search Console evidence: the last 28 days only, per term', ev._installed === true && ev['college football week 6 predictions'].impressions === 140 && ev['nfl week 5 predictions'].impressions === 0);
  const full = own(`select public.content_engine_article(${lit(c3.id)});`);
  chk('P an article comes with its research, profile and siblings for the duplicate check', full && full.opportunity && full.opportunity.research && full.publisher_profile.slug === 'stadium-rant'
    && full.siblings.length === 0 /* c1 is archived */ && full.revisions.length >= 2);
  { /* ── AB the AI budget ─────────────────────────────────────────────── */
  const H = (x) => require('crypto').createHash('sha256').update('edgedesk-req:' + x).digest('hex');
  const resQ = (hash, o) => `select public.content_engine_ai_reserve(${lit((o && o.op) || 'draft')}, null, ${lit((o && o.model) || 'claude-opus-5-5')}, ${lit(hash)}, ${(o && o.max) || 16000}, ${o && o.input != null ? o.input : 12000}, ${(o && o.attempt) || 1});`;
  const resOwn = (hash, o) => own(resQ(hash, o));
  const resSvc = (hash, o) => svc(resQ(hash, o));
  const settle = (id, usage, outcome, result, who) => J(db[who === 'svc' ? 'service' : 'as'](...(who === 'svc' ? [] : [OWNER]),
    `select public.content_engine_ai_settle(${id}, ${usage == null ? 'null' : lit(JSON.stringify(usage)) + '::jsonb'}, ${lit(outcome)}, ${result == null ? 'null' : lit(JSON.stringify(result)) + '::jsonb'}, null);`));
  own(`select public.content_engine_settings_save('{"llm_calls_per_day": 200}'::jsonb);`);
  chk('AB the owner sets a monthly AI budget', own(`select public.content_engine_ai_budget_save('{"ai_monthly_budget_usd": 1}'::jsonb);`).ok);
  chk('AB anon cannot reserve AI spend', /permission denied/.test(fails(() => db.anon(resQ(H('anon')))) || ''));
  chk('AB the admin cannot reserve AI spend', /owner only/.test(fails(() => db.as(ADMIN, resQ(H('admin')))) || ''));
  const usedBefore = +one(`select coalesce((select calls from content_engine.usage where day = (now() at time zone 'utc')::date and provider = 'llm'), 0);`);
  const r1 = resOwn(H(1));
  chk('AB a reservation holds the worst case: 12,000 input + 16,000 output tokens at $4/$20 per million = $0.368', r1.ok && r1.cached === false && Math.abs(r1.reserved_usd - 0.368) < 1e-9, r1);
  const r2 = resSvc(H(2));
  chk('AB the weekly job reserves too (service role)', r2.ok && Math.abs(r2.committed_usd - 0.736) < 1e-9, r2);
  const r3 = resOwn(H(3));
  chk('AB past the monthly cap: refused before any call, and logged', r3.ok === false && r3.reason === 'budget_exhausted' && Math.abs(r3.committed_usd - 0.736) < 1e-9
    && +one(`select count(*) from content_engine.events where kind = 'ai_budget_blocked';`) >= 1, r3);
  chk('AB each real reservation counts against today’s call cap', +one(`select calls from content_engine.usage where day = (now() at time zone 'utc')::date and provider = 'llm';`) === usedBefore + 2);
  const s1 = settle(r1.call_id, { input_tokens: 10000, output_tokens: 3000, model: 'claude-opus-5-5' }, 'accepted', { title: 'cached version', sections: [] });
  chk('AB settled from the API’s own token counts: 10,000 in + 3,000 out = $0.10 (estimated)', s1.ok && Math.abs(s1.est_usd - 0.1) < 1e-9 && s1.usage_known === true, s1);
  chk('AB a call is settled once', settle(r1.call_id, { input_tokens: 1, output_tokens: 1 }, 'accepted').already === true);
  chk('AB the ledger keeps its outcome: no rewrite, no delete, no truncate', !!fails(() => one(`update content_engine.ai_calls set est_usd = 0 where id = ${r1.call_id};`))
    && !!fails(() => one(`delete from content_engine.ai_calls where id = ${r1.call_id};`)) && !!fails(() => one(`truncate content_engine.ai_calls;`)));
  const r3b = resOwn(H(3));
  chk('AB with the estimate in place of the reservation there is room again', r3b.ok && Math.abs(r3b.committed_usd - (0.1 + 0.368 + 0.368)) < 1e-9, r3b);
  const usedMid = +one(`select calls from content_engine.usage where day = (now() at time zone 'utc')::date and provider = 'llm';`);
  const c1x = resOwn(H(1));
  chk('AB the identical request again: served from the ledger, no call, no cost, no cap used', c1x.ok && c1x.cached === true && c1x.outcome === 'accepted' && c1x.result.title === 'cached version'
    && +one(`select calls from content_engine.usage where day = (now() at time zone 'utc')::date and provider = 'llm';`) === usedMid
    && one(`select status || '|' || est_usd::text from content_engine.ai_calls where id = ${c1x.call_id};`) === 'cache_hit|0.000000', c1x);
  settle(r2.call_id, { input_tokens: 9000, output_tokens: 2000 }, 'discarded', { title: 'a version that failed the checks' }, 'svc');
  const c2x = resSvc(H(2));
  chk('AB a request that already failed the checks is not paid for twice', c2x.ok && c2x.cached === true && c2x.outcome === 'discarded');
  own(`select public.content_engine_ai_budget_save('{"ai_monthly_budget_usd": 5}'::jsonb);`);
  const r4 = resOwn(H(4), { max: 1000, input: 1000 });
  const s4 = settle(r4.call_id, { iterations: [{ model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 1000 }, { model: 'claude-opus-5', input_tokens: 1000, output_tokens: 1000 }] }, 'accepted', null);
  chk('AB a refusal fallback is priced at each model’s own rate ($0.024 + $0.030)', Math.abs(s4.est_usd - 0.054) < 1e-9, s4);
  const r5 = resOwn(H(5), { model: 'claude-unlisted-9', max: 1000, input: 0 });
  chk('AB an unlisted model is priced at the most expensive listed rate', r5.ok && Math.abs(r5.reserved_usd - 0.05) < 1e-9, r5);
  chk('AB a timeout keeps the reservation as the estimate (it may have been billed)', Math.abs(settle(r5.call_id, null, 'unknown').est_usd - 0.05) < 1e-9);
  const r6 = resOwn(H(6), { max: 1000, input: 1000 });
  chk('AB an API error with no usage costs nothing', settle(r6.call_id, null, 'error').est_usd === 0);
  const bud = own('select public.content_engine_ai_budget();');
  chk('AB the month in one place: estimated dollars, tokens, calls, cache hits, by model', bud.calls >= 5 && bud.cache_hits === 2 && bud.input_tokens === 21000 && bud.by_model['claude-opus-5-5'] && /not your invoice/.test(bud.basis), bud);
  chk('AB 50/75/90% alerts are logged as the month crosses them', one(`select string_agg(distinct detail ->> 'level', ',' order by detail ->> 'level') from content_engine.events where kind = 'ai_budget_alert';`).indexOf('50') >= 0);
  /* the race: eight simultaneous requests, room for exactly two */
  const committed = +own('select public.content_engine_ai_budget();').committed_usd;
  own(`select public.content_engine_ai_budget_save(${lit(JSON.stringify({ ai_monthly_budget_usd: Math.round((committed + 0.8) * 100) / 100 }))}::jsonb);`);
  const room = +own('select public.content_engine_ai_budget();').budget_usd - committed;
  const expectOk = Math.floor(room / 0.368 + 1e-9);
  const claimTxt = `do $claim$ begin perform set_config('request.jwt.claim.sub', ${lit(OWNER)}, true); end $claim$;\n`;
  const racers = [];
  for (let i = 0; i < 8; i++) racers.push(db.background('begin;\n' + claimTxt + 'set local role authenticated;\n' + resQ(H('race' + i)) + '\nselect pg_sleep(0.4);\ncommit;\n'));
  const results = racers.map((r) => r.wait(30000));
  const oks = results.filter((r) => /"ok": true/.test(r.out)).length, refused = results.filter((r) => /budget_exhausted/.test(r.out)).length;
  chk('AB eight concurrent requests cannot pass the monthly cap together (room for ' + expectOk + ')', expectOk === 2 && oks === expectOk && refused === 8 - expectOk
    && +one(`select count(*) from content_engine.ai_calls where status = 'reserved' and request_hash in (${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => lit(H('race' + i))).join(',')});`) === expectOk,
    { oks, refused, expectOk, outs: results.map((r) => r.out.slice(0, 80)) });
  own(`select public.content_engine_settings_save('{"llm_calls_per_day": 0}'::jsonb);`);
  own(`select public.content_engine_ai_budget_save('{"ai_monthly_budget_usd": 500}'::jsonb);`);
  chk('AB the daily call cap still applies under a generous budget', /call cap/.test(resOwn(H('cap')).detail || ''));
  own(`select public.content_engine_settings_save('{"llm_calls_per_day": 20}'::jsonb);`);
  own(`select public.content_engine_ai_budget_save('{"ai_monthly_budget_usd": 10}'::jsonb);`);
  chk('AB the overview shows the month’s AI spend', typeof own('select public.content_engine_overview();').ai.committed_usd === 'number');

  /* ── M measurement: funnel, revenue, costs, targets ────────────────── */
  const base = own('select public.content_engine_scorecard(30);');
  const code1 = one(`select campaign_code from content_engine.articles where id = ${lit(c1.id)};`);
  const codeE = one(`select campaign_code from content_engine.articles where id = ${lit(EM)};`);
  const U = (n) => '00000000-0000-0000-0000-0000000001' + String(n).padStart(2, '0');
  const users = [[1, true], [2, false], [3, true], [4, true], [6, true], [7, true]];
  one(`insert into auth.users (id, email, email_confirmed_at, created_at) values ${users.map(([n, c]) => `(${lit(U(n))}, 'reader${n}@example.test', ${c ? 'now()' : 'null'}, now() - interval '3 days')`).join(', ')};`);
  const acq = (n, first, last, lastMed, lastDays, firstDays) => `(${lit(U(n))}, now() - interval '3 days', ${first ? "'referral'" : "'direct'"}, ${lit(first)}, ${first ? "'publisher'" : 'null'}, now() - interval '${firstDays || 4} days', 'referral', ${lit(last)}, ${lit(lastMed)}, now() - interval '${lastDays || 4} days')`;
  one(`insert into public.user_acquisition (user_id, signup_at, first_source, first_utm_campaign, first_utm_medium, first_seen_at, last_source, last_utm_campaign, last_utm_medium, last_seen_at) values
    ${[acq(1, code1, code1, 'publisher'), acq(2, code1, code1, 'publisher'), acq(3, codeE, 'fall_promo', 'cpc'), acq(4, code1, code1, 'publisher', 40, 40),
       acq(6, code1, code1, 'publisher'), acq(7, codeE, codeE, 'publisher')].join(',\n')},
    (${lit(OWNER)}, now() - interval '3 days', 'referral', ${lit(code1)}, 'publisher', now() - interval '4 days', 'referral', ${lit(code1)}, 'publisher', now() - interval '4 days')
    on conflict (user_id) do nothing;`);
  one(`insert into public.acquisition_visitors (visitor_hash, first_source, first_utm_campaign, first_seen_at, last_source, last_utm_campaign, last_utm_medium, last_seen_at)
       values ('cv1', 'referral', ${lit(code1)}, now() - interval '5 days', 'referral', ${lit(code1)}, 'publisher', now() - interval '5 days'),
              ('cv2', 'referral', ${lit(code1)}, now() - interval '2 days', 'referral', ${lit(code1)}, 'publisher', now() - interval '2 days'),
              ('cv3', 'referral', ${lit(codeE)}, now() - interval '1 days', 'referral', ${lit(codeE)}, 'publisher', now() - interval '1 days'),
              ('cv4', 'other', 'fall_promo', now() - interval '1 days', 'other', 'fall_promo', 'cpc', now() - interval '1 days');`);
  /* Stripe, as the verified webhook stores it: a trial, invoices (one delivered twice), a cancellation, a refund */
  const ev = (id, type, uid, sub, cust, obj, days) => `(${lit(id)}, ${lit(type)}, now() - interval '${days} days', ${lit(cust)}, ${lit(sub)}, ${lit(uid)}, ${lit(JSON.stringify({ data: { object: obj } }))}::jsonb)`;
  one(`insert into public.subscriptions (user_id, status, price_id, stripe_customer_id, stripe_subscription_id) values
         (${lit(U(6))}, 'active', 'price_full', 'cus_6', 'sub_6'), (${lit(U(7))}, 'canceled', 'price_full', 'cus_7', 'sub_7')
       on conflict (user_id) do update set status = excluded.status, stripe_customer_id = excluded.stripe_customer_id, stripe_subscription_id = excluded.stripe_subscription_id;`);
  one(`insert into public.stripe_events (id, type, stripe_created, customer_id, subscription_id, user_id, payload) values
    ${[ev('evt_t6', 'customer.subscription.created', U(6), 'sub_6', 'cus_6', { id: 'sub_6', status: 'trialing', trial_start: Math.floor(Date.now() / 1000) - 3 * 86400 }, 3),
       ev('evt_i6a', 'invoice.paid', U(6), 'sub_6', 'cus_6', { id: 'in_6a', amount_paid: 4999, subscription: 'sub_6' }, 2),
       ev('evt_i6a_again', 'invoice.payment_succeeded', U(6), 'sub_6', 'cus_6', { id: 'in_6a', amount_paid: 4999, subscription: 'sub_6' }, 2),
       ev('evt_i6b', 'invoice.paid', U(6), 'sub_6', 'cus_6', { id: 'in_6b', amount_paid: 4999, subscription: 'sub_6' }, 1),
       ev('evt_i7', 'invoice.paid', U(7), 'sub_7', 'cus_7', { id: 'in_7', amount_paid: 4999, subscription: 'sub_7' }, 2),
       ev('evt_r7', 'charge.refunded', U(7), 'sub_7', 'cus_7', { id: 'ch_7', amount_refunded: 4999, customer: 'cus_7' }, 1)].join(',\n')};`);
  chk('M costs: the owner enters billed amounts; a correction is a negative row; nothing is edited', own(`select public.content_engine_cost_add('{"category":"ai_billed","amount_usd":3.50,"basis":"billed","note":"Anthropic invoice"}'::jsonb);`).ok
    && own(`select public.content_engine_cost_add('{"category":"magic","amount_usd":1}'::jsonb);`).reason === 'invalid'
    && !!fails(() => one(`update content_engine.costs set amount_usd = 0;`)) && !!fails(() => one(`delete from content_engine.costs;`)));
  chk('M the scorecard is the owner’s: not the admin, not the job', /owner only/.test(fails(() => db.as(ADMIN, 'select public.content_engine_scorecard(30);')) || '')
    && /permission denied/.test(fails(() => db.service('select public.content_engine_scorecard(30);')) || ''));
  const sc = own('select public.content_engine_scorecard(30);');
  chk('M visits: content campaigns only (3 of 4 visitors)', sc.distribution.referral_visits - base.distribution.referral_visits === 3, [base.distribution, sc.distribution]);
  chk('M registrations: direct and confirmed only — not the unconfirmed one, not outside the window, not the owner', sc.distribution.registrations - base.distribution.registrations === 3, [base.distribution, sc.distribution]);
  chk('M assisted shown apart, never added to direct', sc.distribution.registrations_assisted - base.distribution.registrations_assisted === 2 && sc.revenue.paid_assisted === base.revenue.paid_assisted, [base.distribution, sc.distribution]);
  chk('M trials and paid from Stripe’s events', sc.distribution.trials - base.distribution.trials === 1 && sc.revenue.paid - base.revenue.paid === 2, { b: base.revenue, d: sc.distribution, r: sc.revenue });
  const independent = +one(`select coalesce(sum(cents), 0) from (select distinct on (payload -> 'data' -> 'object' ->> 'id') (payload -> 'data' -> 'object' ->> 'amount_paid')::bigint cents
      from public.stripe_events where type in ('invoice.paid', 'invoice.payment_succeeded') and user_id in (${lit(U(6))}, ${lit(U(7))}) order by payload -> 'data' -> 'object' ->> 'id') x;`);
  chk('M collected revenue reconciles with Stripe’s invoices, a duplicate delivery counted once ($149.97)', Math.round((sc.revenue.collected_usd - base.revenue.collected_usd) * 100) === independent && independent === 14997, { sc: sc.revenue, base: base.revenue, independent });
  chk('M refunds come off: net $99.98', Math.round((sc.revenue.refunded_usd - base.revenue.refunded_usd) * 100) === 4999 && Math.round((sc.revenue.net_collected_usd - base.revenue.net_collected_usd) * 100) === 9998, [base.revenue, sc.revenue]);
  chk('M new MRR counts active subscriptions only ($49.99)', Math.round((sc.revenue.new_mrr_usd - base.revenue.new_mrr_usd) * 100) === 4999, [base.revenue, sc.revenue]);
  chk('M retained and churned are told apart', sc.revenue.retention.retained - base.revenue.retention.retained === 1 && sc.revenue.retention.churned - base.revenue.retention.churned === 1, [base.revenue.retention, sc.revenue.retention]);
  chk('M costs: billed AI replaces the estimate; CAC = cost / paid customers', sc.costs.total_usd === 3.5 && sc.costs.cac_usd === Math.round(3.5 / sc.revenue.paid * 100) / 100 && /billed/.test(sc.costs.basis), sc.costs);
  chk('M first-three-month revenue to cost', sc.costs.revenue_to_cost === Math.round(sc.revenue.first_three_months_usd / 3.5 * 100) / 100 && sc.revenue.first_three_months_usd - base.revenue.first_three_months_usd === 149.97, [sc.costs, sc.revenue]);
  const tgt = {}; sc.targets.forEach((t) => { tgt[t.key] = t; });
  chk('M every target carries actual, needed-now and a status; nothing unmeasured is filled in', sc.targets.length === 13 && sc.targets.every((t) => ['met', 'on_track', 'behind', 'not_measured'].indexOf(t.status) >= 0)
    && tgt.paid_per_month.target === 3 && tgt.new_mrr_usd_per_month.target === 149.97 && tgt.cac_max_usd.status === 'met', sc.targets);
  chk('M the bottleneck names the first stage below the targets', ['production', 'acceptance', 'traffic', 'signup', 'paid', 'cost', 'insufficient_data', 'none'].indexOf(sc.bottleneck.stage) >= 0 && sc.bottleneck.label, sc.bottleneck);
  chk('M no identity in the scorecard', !/reader\d@example|00000000-0000-0000-0000-00000000010/.test(JSON.stringify(sc)));
  const wd = own('select public.content_engine_weekly_data(28);');
  chk('M the weekly data: articles with their funnel, gate failures, AI waste', Array.isArray(wd.articles) && wd.articles.length >= 2 && wd.gate_failures.claims >= 1 && wd.ai.calls >= 5 && wd.ai.cache_hits === 2, { ai: wd.ai, gf: wd.gate_failures });
  }

} catch (e) {
  chk('the suite reached its end — ' + String(e.message).slice(0, 600), false);
} finally {
  db.stop();
}
process.exit(T.done());
