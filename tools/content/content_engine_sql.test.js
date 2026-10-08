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
const statusOf = (id) => one(`select status from content_engine.articles where id = ${lit(id)};`);

try {
  ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql', 'funnel.sql', 'growth_outbound.sql', 'growth_engine.sql']
    .forEach((f) => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f)));
  const rep1 = db.applyFileAtomic(FILE);
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
  const ap3 = own(`select public.content_engine_article_approve(${lit(c3.id)}, ${lit(hashOf(c3.id))});`);
  chk('S tout language blocks approval even with the checks passed', ap3.ok === false && ap3.reason === 'language' && /guarantee/.test(JSON.stringify(ap3.terms)));
  chk('S approve again, at the current hash', own(`select public.content_engine_article_approve(${lit(c1.id)}, ${lit(hashOf(c1.id))});`).ok);
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
} catch (e) {
  chk('the suite reached its end — ' + String(e.message).slice(0, 600), false);
} finally {
  db.stop();
}
process.exit(T.done());
