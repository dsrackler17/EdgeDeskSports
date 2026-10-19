#!/usr/bin/env node
/* ===========================================================================
   supabase/desk_articles.sql, APPLIED AND ATTACKED on a real PostgreSQL.

   The desk's one promise is a database rule: an auto-generated draft does not
   become a published article until the owner has written "My take", and the
   numbers it publishes can always be traced. This applies the shipped file
   unmodified over the real Supabase chain it reads (site_articles, billing,
   growth, funnel), twice, checks its own report, and then proves:

     1  only the service role can store a draft, and a re-sent identical draft
        adds no row
     2  drafts are append-only: no edit, no delete, no truncate, status only
        moves out of draft
     3  PUBLISH IS REFUSED WITHOUT A TAKE, and with a take that is too short,
        for the owner's button AND for a service-role UPDATE straight at the
        table; a draft that failed its own checks cannot publish either
     4  with a real take it publishes, the take is frozen onto the row, and
        anon can read exactly the published draft and nothing else
     5  a newer draft never replaces a published one by itself
     6  a reader who is not the owner can do none of it
     7  a FIRST publication of a game article through site_articles needs a
        take too; an article published before the rule is untouched
     8  the notification claim never announces a draft twice
     9  Article Performance credits a trial and a payment to the article a
        reader read first, and counts Discord and Reddit as their own channels

   The two drafts are REAL: generated in this process from this season's
   committed data by tools/desk/generators.js.

   Run: node tools/desk/desk_sql.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const SRC = require('./sources.js');
const G = require('./generators.js');
const GEN = require('./generate.js');
const T = PG.kit('desk articles SQL');
const chk = T.chk;

const db = PG.start('desk');
if (db.skip) { console.log('NOTE | ' + db.skip + ' — SQL layer skipped'); process.exit(T.done()); }

const U = {
  owner: '00000000-0000-0000-0000-0000000d0001',
  reader: '00000000-0000-0000-0000-0000000d0002',
  buyer: '00000000-0000-0000-0000-0000000d0003'
};
const J = (o) => '$dj$' + JSON.stringify(o) + '$dj$::jsonb';
const one = (s) => String(s).split('\n').filter(Boolean).pop();
const refused = (e, re) => !!e && (re || /permission denied|owner only|insufficient/i).test(e);
const TAKE_LONG = 'I keep coming back to the spread CLV more than the record. Four losses against the number is noise; the close moving my way is the part I can actually check. ' +
  'What bothers me is the totals, where the market moved against me more often than for me. I want another month before I trust my total number at all.';

try {
  ['site_articles.sql', 'billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql', 'funnel.sql']
    .forEach((f) => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f)));
  const file = path.join(PG.ROOT, 'supabase', 'desk_articles.sql');
  const rep1 = db.applyFileAtomic(file);
  const rep2 = db.applyFileAtomic(file);
  chk('the file applies over the real chain', true);
  chk('its own report reads ok on every row, twice', !/CHECK THIS/.test(rep1) && !/CHECK THIS/.test(rep2) && (rep2.match(/\|ok/g) || []).length === 9, rep2);

  db.sql(`insert into auth.users (id, email, created_at, email_confirmed_at) values
      ('${U.owner}', 'owner@example.com', now() - interval '400 days', now()),
      ('${U.reader}', 'reader@example.com', now() - interval '40 days', now()),
      ('${U.buyer}', 'buyer@example.com', now() - interval '3 days', now());
    insert into public.site_article_admins (user_id) values ('${U.owner}');
    insert into public.subscriptions (user_id, status, price_id, current_period_end) values ('${U.reader}', 'active', 'price_4999', now() + interval '20 days');`);

  /* ── real drafts, from this season's committed data ───────────────────── */
  const S = SRC.loader({});
  const now = '2026-10-19T16:00:00.000Z';
  const note = GEN.packageDraft(G.generate('research_notes', S, { study: 'EXP-001' }), S, now);
  const week = GEN.packageDraft(G.generate('weekly_clv', S, { sport: 'nfl', week: 5 }), S, now);
  chk('the generated drafts passed their own checks before they reach the database',
    note.data_snapshot.checks.verify.ok && week.data_snapshot.checks.voice.ok, note.data_snapshot.checks);

  /* ── 1. who may store a draft ─────────────────────────────────────────── */
  chk('anon cannot store a draft', refused(db.mustFail(() => db.anon(`select public.desk_draft_put(${J(note)});`))));
  chk('the owner cannot store a draft from a browser', refused(db.mustFail(() => db.as(U.owner, `select public.desk_draft_put(${J(note)});`))));
  const put1 = JSON.parse(one(db.service(`select public.desk_draft_put(${J(note)});`)));
  chk('the service role stores it', put1.stored === true && put1.status === 'awaiting_take', put1);
  const put2 = JSON.parse(one(db.service(`select public.desk_draft_put(${J(note)});`)));
  chk('an identical draft is reported unchanged and adds no row', put2.stored === false && put2.reason === 'unchanged' && put2.draft_id === put1.draft_id, put2);
  const putW = JSON.parse(one(db.service(`select public.desk_draft_put(${J(week)});`)));
  chk('a second article stores too', putW.stored === true, putW);
  chk('a draft whose slug is a game article is refused', /already belongs to a game article/.test(db.mustFail(() => {
    db.sql(`insert into public.site_articles (id, game_id, sport, slug, title, article, home_team, away_team, canonical_url, status)
            values ('nfl-x', 'x', 'NFL', 'taken-slug', 't', '{}'::jsonb, 'h', 'a', 'https://edgedesksports.com/articles/taken-slug/', 'draft');`);
    db.service(`select public.desk_draft_put(${J(Object.assign({}, note, { article_key: 'research_notes:x', slug: 'taken-slug', body_hash: 'zz' }))});`);
  }) || ''));

  /* ── 2. append-only ───────────────────────────────────────────────────── */
  chk('a draft cannot be edited, even by the service role', /append-only/.test(db.mustFail(() => db.service(`update public.article_drafts set title = 'rewritten' where id = ${put1.draft_id};`)) || ''));
  chk('a draft cannot be deleted', /append-only/.test(db.mustFail(() => db.service(`delete from public.article_drafts where id = ${put1.draft_id};`)) || ''));
  chk('the drafts table cannot be truncated', /append-only/.test(db.mustFail(() => db.sql(`truncate public.article_drafts cascade;`)) || ''));
  chk('the snapshot cannot be swapped for one with no numbers', /append-only/.test(db.mustFail(() => db.service(`update public.article_drafts set data_snapshot = '{"numbers":[],"sources":[]}' where id = ${put1.draft_id};`)) || ''));
  chk('anon cannot read drafts', refused(db.mustFail(() => db.anon(`select count(*) from public.article_drafts;`))));
  chk('a paying reader cannot read drafts', refused(db.mustFail(() => db.as(U.reader, `select count(*) from public.article_drafts;`))));
  chk('nothing is public before it is published', one(db.anon(`select count(*) from public.desk_published;`)) === '0');

  /* ── 3. the gate ──────────────────────────────────────────────────────── */
  const key = note.article_key;
  const noTake = db.mustFail(() => db.as(U.owner, `select public.desk_publish('${key}');`));
  chk('PUBLISH WITHOUT A TAKE IS REFUSED', /my_take_required/.test(noTake || ''), noTake);
  const short = JSON.parse(one(db.as(U.owner, `select public.article_take_save('${key}', 'desk', 'Short and sweet. Not enough.');`)));
  chk('a short take saves but is reported short', short.saved && short.ok === false && short.min === 240, short);
  chk('publish with a take under the minimum is refused', /my_take_required/.test(db.mustFail(() => db.as(U.owner, `select public.desk_publish('${key}');`)) || ''));
  chk('a service-role UPDATE straight at the table is refused too (the gate is a trigger)', /my_take_required/.test(db.mustFail(() =>
    db.service(`update public.desk_articles set status = 'published', published_draft_id = current_draft_id where article_key = '${key}';`)) || ''));
  chk('so is a hand UPDATE as the superuser', /my_take_required/.test(db.mustFail(() =>
    db.sql(`update public.desk_articles set status = 'published', published_draft_id = current_draft_id where article_key = '${key}';`)) || ''));
  chk('whitespace does not pad a take to the minimum', /my_take_required/.test(db.mustFail(() => {
    db.as(U.owner, `select public.article_take_save('${key}', 'desk', 'Too short.' || repeat(' ', 400));`);
    db.as(U.owner, `select public.desk_publish('${key}');`);
  }) || ''));
  /* a draft that failed its own checks */
  const bad = Object.assign({}, note, { article_key: 'research_notes:bad', slug: 'research-note-bad', body_hash: 'bad',
    data_snapshot: Object.assign({}, note.data_snapshot, { checks: { voice: { ok: true }, verify: { ok: false, problems: [{ key: 'x', why: 'source changed' }] } } }) });
  db.service(`select public.desk_draft_put(${J(bad)});`);
  db.as(U.owner, `select public.article_take_save('research_notes:bad', 'desk', $t$${TAKE_LONG}$t$);`);
  chk('a draft that failed its own source check cannot publish, take or not', /failed its own source or voice checks/.test(db.mustFail(() => db.as(U.owner, `select public.desk_publish('research_notes:bad');`)) || ''));

  /* ── 4. with a real take ──────────────────────────────────────────────── */
  const saved = JSON.parse(one(db.as(U.owner, `select public.article_take_save('${key}', 'desk', $t$${TAKE_LONG}$t$);`)));
  chk('a real take saves and the article becomes ready', saved.ok === true && one(db.sql(`select status from public.desk_articles where article_key = '${key}';`)) === 'ready', saved);
  const pub = JSON.parse(one(db.as(U.owner, `select public.desk_publish('${key}');`)));
  chk('the owner publishes', pub.published === true && pub.draft_id === put1.draft_id, pub);
  chk('the take is frozen onto the published row', one(db.sql(`select published_take = (select take from public.article_takes where article_id = '${key}') from public.desk_articles where article_key = '${key}';`)) === 't');
  chk('the published draft is marked published', one(db.sql(`select status from public.article_drafts where id = ${put1.draft_id};`)) === 'published');
  const pubRow = JSON.parse(one(db.anon(`select row_to_json(p) from public.desk_published p;`)));
  chk('anon reads the published article with its body, snapshot and take', pubRow.slug === note.slug && pubRow.my_take === TAKE_LONG
    && pubRow.generated_body === note.generated_body && pubRow.data_snapshot.numbers.length === note.data_snapshot.numbers.length, Object.keys(pubRow));
  chk('only that one: the other drafts stay invisible', one(db.anon(`select count(*) from public.desk_published;`)) === '1');
  chk('a published draft cannot go back to draft', /cannot become/.test(db.mustFail(() => db.service(`update public.article_drafts set status = 'draft' where id = ${put1.draft_id};`)) || ''));
  chk('every take revision is kept', Number(one(db.sql(`select count(*) from public.article_take_revisions where article_id = '${key}';`))) === 3);
  chk('take revisions are append-only', /append-only/.test(db.mustFail(() => db.sql(`delete from public.article_take_revisions;`)) || ''));

  /* ── 5. a newer draft waits ───────────────────────────────────────────── */
  const newer = Object.assign({}, note, { generated_body: note.generated_body + '\nA later run.\n', body_hash: 'newer-hash' });
  const putN = JSON.parse(one(db.service(`select public.desk_draft_put(${J(newer)});`)));
  chk('a newer draft is stored and the article stays published', putN.stored && putN.status === 'published', putN);
  chk('the public page still shows the published draft', JSON.parse(one(db.anon(`select row_to_json(p) from public.desk_published p;`))).draft_id === put1.draft_id);
  const q = JSON.parse(one(db.as(U.owner, `select public.desk_queue();`)));
  chk('the owner sees "newer data available" on it', q.articles.some(a => a.article_key === key && a.newer_draft === true) && q.counts.newer_drafts === 1, q.counts);

  /* ── 6. a reader is not the owner ─────────────────────────────────────── */
  chk('a reader cannot open the queue', refused(db.mustFail(() => db.as(U.reader, `select public.desk_queue();`))));
  chk('a reader cannot write a take', refused(db.mustFail(() => db.as(U.reader, `select public.article_take_save('${week.article_key}', 'desk', $t$${TAKE_LONG}$t$);`))));
  chk('a reader cannot publish', refused(db.mustFail(() => db.as(U.reader, `select public.desk_publish('${week.article_key}');`))));
  chk('a reader cannot read the performance view', refused(db.mustFail(() => db.as(U.reader, `select public.desk_article_performance(30, '[]');`))));
  chk('the badge says "not the owner" to a reader', JSON.parse(one(db.as(U.reader, `select public.desk_pending_count();`))).owner === false);
  const badge = JSON.parse(one(db.as(U.owner, `select public.desk_pending_count();`)));
  chk('and counts what waits on the owner', badge.owner === true && badge.awaiting_take === 1 && badge.newer_drafts === 1, badge);

  /* ── 7. game articles through site_articles ───────────────────────────── */
  const gameRow = (id, slug) => `insert into public.site_articles (id, game_id, sport, slug, title, article, home_team, away_team, canonical_url, status)
    values ('${id}', '${id}', 'NFL', '${slug}', 'Game', '{"x":1}'::jsonb, 'Home', 'Away', 'https://edgedesksports.com/articles/${slug}/', 'published');`;
  chk('a first publication of a game article without a take is refused', /my_take_required/.test(db.mustFail(() => db.as(U.owner, gameRow('nfl-g1', 'g-one'))) || ''));
  db.as(U.owner, `select public.article_take_save('nfl-g1', 'game', $t$${TAKE_LONG}$t$);`);
  db.as(U.owner, gameRow('nfl-g1', 'g-one'));
  chk('with a game take it publishes and the take rides in the record', one(db.sql(`select article ->> 'my_take' = $t$${TAKE_LONG}$t$ from public.site_articles where id = 'nfl-g1';`)) === 't');
  db.sql(`alter table public.site_articles disable trigger site_articles_take_gate_t;`);
  db.sql(gameRow('nfl-old', 'g-old'));
  db.sql(`alter table public.site_articles enable trigger site_articles_take_gate_t;`);
  db.as(U.owner, `update public.site_articles set title = 'Edited' where id = 'nfl-old';`);
  chk('an article published before the rule can still be edited', one(db.sql(`select title from public.site_articles where id = 'nfl-old';`)) === 'Edited');
  const taken = db.anon(`select article_id from public.article_takes_published(array['nfl-g1','nfl-old','nfl-nope']);`);
  chk('anon reads a game take only once its article is published', taken.trim() === 'nfl-g1', taken);

  /* ── 8. notifications ─────────────────────────────────────────────────── */
  chk('anon cannot claim notifications', refused(db.mustFail(() => db.anon(`select public.desk_notify_claim(10);`))));
  const c1 = JSON.parse(one(db.service(`select public.desk_notify_claim(10);`)));
  chk('the claim returns the current drafts', c1.enabled && c1.drafts.length >= 2, c1);
  const c2 = JSON.parse(one(db.service(`select public.desk_notify_claim(10);`)));
  chk('a second claim announces nothing twice', c2.drafts.length === 0, c2);
  db.service(`select public.desk_notify_done(array[${c1.drafts[0].id}]::bigint[], 'discord_dm', false, 'HTTP 500');`);
  const c3 = JSON.parse(one(db.service(`select public.desk_notify_claim(10);`)));
  chk('a failed send is released for another try', c3.drafts.length === 1 && c3.drafts[0].id === c1.drafts[0].id, c3);
  chk('the log refuses a webhook URL in an error', /no_secret/.test(db.mustFail(() =>
    db.service(`select public.desk_notify_done(array[1]::bigint[], 'discord', false, 'https://discord.com/api/webhooks/123/abc');`)) || ''));

  /* ── 9. Article Performance ───────────────────────────────────────────── */
  const anonId = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', anon2 = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2', anon3 = 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3';
  db.sql(`insert into public.user_events (anonymous_session_id, session_id, event_name, event_properties, created_at, page_path, referrer, utm_source, utm_medium, utm_campaign) values
    ('${anonId}', 'sess-0001', 'public_page_view', '{"entity":"article:${note.slug}","kind":"article"}', now() - interval '5 days', '/articles/${note.slug}/', null, 'reddit', 'community', 'desk_x'),
    ('${anon2}', 'sess-0002', 'public_page_view', '{"entity":"article:${note.slug}","kind":"article"}', now() - interval '4 days', '/articles/${note.slug}/', 'discord.com', null, null, null),
    ('${anon3}', 'sess-0003', 'public_page_view', '{"entity":"article:g-one","kind":"article"}', now() - interval '4 days', '/articles/g-one/', 'www.google.com', null, null, null);
    insert into public.user_event_links (anonymous_session_id, user_id) values ('${anonId}', '${U.buyer}');
    insert into public.stripe_events (id, type, created_at, user_id, payload) values
      ('evt_t1', 'customer.subscription.created', now() - interval '3 days', '${U.buyer}', '{"data":{"object":{"id":"sub_1","status":"trialing"}}}'),
      ('evt_p1', 'invoice.payment_succeeded', now() - interval '1 days', '${U.buyer}', '{"data":{"object":{"id":"in_1","amount_paid":4999}}}');`);
  const perf = JSON.parse(one(db.as(U.owner, `select public.desk_article_performance(30, ${J([{ slug: 'g-one', type: 'pregame', title: 'Game' }])});`)));
  const row = perf.articles.find(a => a.slug === note.slug);
  chk('Article Performance reads every source it needs', perf.measured.events && perf.measured.billing && perf.measured.acquisition, perf.measured);
  chk('a trial and a payment are credited to the article the buyer read first', row && row.trials_touched === 1 && row.paid_touched === 1, row);
  chk('it ranks by conversions, not views', perf.articles[0].slug === note.slug, perf.articles.map(a => a.slug));
  chk('Reddit and Discord are their own channels', row && row.channels.reddit === 1 && row.channels.discord === 1, row && row.channels);
  chk('an article from the page list with no conversions is still listed', perf.articles.some(a => a.slug === 'g-one' && a.views === 1 && a.channels.search === 1));
  chk('types are compared side by side', perf.by_type.some(t => t.type === 'research_notes' && t.paid_touched === 1));
  db.sql(`insert into public.user_events (user_id, session_id, event_name, event_properties, created_at, page_path) values
    ('${U.owner}', 'sess-0009', 'public_page_view', '{"entity":"article:${note.slug}","kind":"article"}', now() - interval '1 days', '/articles/${note.slug}/');`);
  const perf2 = JSON.parse(one(db.as(U.owner, `select public.desk_article_performance(30, '[]');`)));
  chk('the owner’s own reading is never counted', perf2.articles.find(a => a.slug === note.slug).views === 2);
} catch (e) {
  chk('unexpected error', false, String(e.sqlMessage || e.stack || e.message).slice(0, 2000));
} finally {
  db.stop();
}
process.exit(T.done());
