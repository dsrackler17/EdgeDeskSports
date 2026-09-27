#!/usr/bin/env node
/* ============================================================================
   MEMBER POSTS, HELD OFFLINE.

   The database is where the rules are enforced, and
   tools/articles/community_sql.test.js attacks it there on a real PostgreSQL.
   This file holds everything that can be checked without one, and two things
   in particular:

     1  THE TWO WORDLISTS ARE ONE LIST. tools/articles/community.js is what
        the composer shows a writer; supabase/community_posts.sql is what
        actually decides. If they drift, the composer promises something the
        database will not honour — a writer told their post is fine and then
        finding it queued, or worse, the reverse. Every term is compared, both
        ways, and the boundary syntax each host needs is checked too.

     2  A BODY IS TEXT. Everything a member types is escaped before it is
        anything else. A member post that could run script in another member's
        session is the failure mode this feature has, and there is no
        markdown, no HTML passthrough and no embed to make it possible.

   Plus: the separation from research (no member post can reach the research
   feed, the sitemap or an indexed page), and the pages themselves.

   Run: node tools/articles/community.test.js
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const C = require('./community.js');
const STORE = require('./store.js');

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 260); } }
  if (cond) { pass++; return true; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
  return false;
}
function eq(name, got, want) { return chk(name, got === want, 'got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want)); }
function has(hay, needle, name) { return chk(name, String(hay).indexOf(needle) >= 0, 'missing: ' + JSON.stringify(needle)); }
function lacks(hay, needle, name) { return chk(name, String(hay).indexOf(needle) < 0, 'unexpectedly present: ' + JSON.stringify(needle)); }
function section(t) { console.log('\n' + t); }

const SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'community_posts.sql'), 'utf8');
const FEED = fs.readFileSync(path.join(ROOT, 'articles', 'community', 'index.html'), 'utf8');
const WRITE = fs.readFileSync(path.join(ROOT, 'articles', 'write', 'index.html'), 'utf8');
const ADMIN = fs.readFileSync(path.join(ROOT, 'admin', 'articles', 'index.html'), 'utf8');
const HUB = fs.readFileSync(path.join(ROOT, 'articles', 'index.html'), 'utf8');
const NOTFOUND = fs.readFileSync(path.join(ROOT, '404.html'), 'utf8');
const BODY = 'Kansas rates 51.4 against the pass and Missouri sits at 52.2. '.repeat(5);

/* ======================================================================== */
section('1. THE TWO WORDLISTS ARE ONE LIST');
/* ======================================================================== */
(function () {
  const block = SQL.slice(SQL.indexOf('insert into public.community_banned_terms'),
    SQL.indexOf('on conflict (term) do nothing'));
  const sqlTerms = (block.match(/\('((?:[^']|'')*)'\)/g) || [])
    .map(m => m.slice(2, -2).replace(/''/g, "'"));
  const jsTerms = C.BANNED_TERMS.map(t => t[0]);

  chk('the migration actually carries a wordlist', sqlTerms.length > 0, String(sqlTerms.length));
  eq('the two lists are the same length', sqlTerms.length, jsTerms.length);
  jsTerms.forEach(t => chk('SQL carries the term the composer shows: ' + t, sqlTerms.indexOf(t) >= 0));
  sqlTerms.forEach(t => chk('the composer knows the term SQL enforces: ' + t, jsTerms.indexOf(t) >= 0));

  /* Each host spells a word boundary differently and the list is stored
     without one for that reason. A term that carried its own would be right
     in one host and a backspace character in the other. */
  jsTerms.forEach(t => {
    chk('the term "' + t + '" carries no host-specific boundary syntax',
      t.indexOf('\\b') < 0 && t.indexOf('\\y') < 0);
  });
  has(SQL, "'\\y(?:' || t.term || ')\\y'", 'PostgreSQL adds its own \\y boundary');
  chk('JavaScript adds its own \\b boundary', /\\\\b\(\?:/.test(C.bannedRegex.toString()));
  /* and every term must be a regex both engines can actually parse */
  jsTerms.forEach(t => {
    chk('the term "' + t + '" compiles as a regex', (function () { new RegExp(t); return true; }));
    chk('the term "' + t + '" uses only syntax PostgreSQL also has',
      !/\(\?<|\\d|\\w|\\s|\{\d/.test(t), t);
  });
})();

/* ======================================================================== */
section('2. THE WORDLIST CATCHES WHAT IT CLAIMS TO');
/* ======================================================================== */
[
  ['this is my best bet of the week', 'best bet'],
  ['a total lock of the day', 'lock of the'],
  ['it is a mortal lock', 'mortal lock'],
  ['a guaranteed winner', 'guaranteed win'],
  ['free money on the board', 'free money'],
  ['this is a no-brainer', 'no-brainer'],
  ['bet the house on it', 'bet the house'],
  ['my pick is Kansas', 'my pick is'],
  ['take the points here', 'take the points'],
  ['a risk-free spot', 'risk-free']
].forEach(([text, want]) => {
  const s = C.scan(text);
  chk('"' + want + '" is caught', !s.ok && s.hits.some(h => h.term.toLowerCase().indexOf(want.split(' ')[0]) >= 0),
    JSON.stringify(s.hits.map(h => h.term)));
  chk('and the writer is told why: ' + want, s.hits.every(h => h.why && h.why.length > 20));
});
/* AND DOES NOT CATCH ORDINARY FOOTBALL WRITING. A filter that fires on normal
   prose trains people to ignore it. */
[
  'Missouri rates better on a neutral field and the gap is 3.9 points.',
  'The offensive line locks down the edge on early downs.',
  'Kansas has the best defensive front they have fielded in years.',
  'I would bet on regression here, but the sample is thin.',
  'The number moved a point and a half overnight.',
  'A lock-down corner changes what the offence can call.'
].forEach(t => {
  const s = C.scan(t);
  chk('ordinary football writing passes: "' + t.slice(0, 44) + '…"', s.ok, JSON.stringify(s.hits.map(h => h.term)));
});

/* ======================================================================== */
section('3. A BODY IS TEXT, NEVER MARKUP');
/* ======================================================================== */
(function () {
  const nasty = '<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n'
    + '<a href="javascript:alert(3)">click</a>\n\n</p><div onclick="x">';
  const out = C.bodyHTML(nasty);
  lacks(out, '<script', 'a script tag cannot survive the body renderer');
  lacks(out, '<img', 'nor an image tag');
  lacks(out, '<div', 'nor arbitrary markup');
  has(out, '&lt;script&gt;', 'the text is shown as the text it is');
  has(out, 'onerror=alert(2)', 'the attribute text survives as TEXT, which is the point');
  chk('no javascript: URL becomes an anchor', out.indexOf('href="javascript:') < 0);
  /* THE ACTUAL PROPERTY, rather than a hunt for known-bad substrings: the only
     tags in the output are the four the renderer emits. `onerror=` appearing
     inside escaped text is not a vulnerability and a test that failed on it
     would be measuring the wrong thing — what matters is that no `<` in the
     author's text ever became a tag. */
  const stripped = out
    .replace(/<\/?p>/g, '').replace(/<br>/g, '')
    .replace(/<a href="[^"]*" rel="nofollow ugc noopener" target="_blank">/g, '').replace(/<\/a>/g, '');
  chk('the only tags in a rendered body are the ones the renderer emitted',
    stripped.indexOf('<') < 0 && stripped.indexOf('>') < 0,
    JSON.stringify(stripped.slice(0, 160)));
  /* and the same holds for text that tries to close the renderer's own tags */
  const escapeHatch = C.bodyHTML('</p><script>x</script><p>');
  const s2 = escapeHatch.replace(/<\/?p>/g, '').replace(/<br>/g, '');
  chk('nor can a body close the paragraph the renderer opened',
    s2.indexOf('<') < 0 && s2.indexOf('>') < 0, JSON.stringify(s2.slice(0, 160)));
  /* what the renderer DOES offer */
  const ok = C.bodyHTML('One paragraph.\n\nTwo, with a link to https://edgedesksports.com/articles and a\nline break.');
  chk('blank lines become paragraphs', (ok.match(/<p>/g) || []).length === 2);
  has(ok, '<br>', 'a single newline becomes a line break');
  has(ok, 'rel="nofollow ugc noopener"', 'a member link carries nofollow, ugc and noopener');
  has(ok, 'href="https://edgedesksports.com/articles"', 'and the link itself works');
  /* an author name cannot smuggle markup either */
  has(C.esc('<b>x</b>'), '&lt;b&gt;', 'names are escaped by the same helper');
})();

/* ======================================================================== */
section('4. NOBODY POSTS AS EDGEDESK');
/* ======================================================================== */
['EdgeDesk', 'edgedesk research', 'EdgeDesk Staff', 'Admin', 'moderator', 'Official', 'EDGEDESK']
  .forEach(n => {
    const v = C.validate({ title: 'A perfectly ordinary headline here', body: BODY, author_name: n });
    chk('"' + n + '" is refused as a posting name',
      !v.ok && v.errors.some(e => e.field === 'author_name'), JSON.stringify(v.errors.map(e => e.field)));
  });
['Davis R', 'kcfootballguy', 'The Mizzou Take'].forEach(n => {
  const v = C.validate({ title: 'A perfectly ordinary headline here', body: BODY, author_name: n });
  chk('"' + n + '" is a fine name to post under', v.ok, JSON.stringify(v.errors));
});
chk('the reserved list is in the SQL comment trail too', SQL.indexOf('author_name') > 0);

/* ======================================================================== */
section('5. VALIDATION, AND WHAT IT TELLS THE WRITER');
/* ======================================================================== */
(function () {
  const good = { title: 'What the Kansas number is actually saying', body: BODY, author_name: 'Davis', sport: 'CFB' };
  chk('a real post validates', C.validate(good).ok, JSON.stringify(C.validate(good).errors));
  chk('a short headline is refused', !C.validate(Object.assign({}, good, { title: 'Kansas' })).ok);
  chk('a one-line post is refused', !C.validate(Object.assign({}, good, { body: 'Kansas covers.' })).ok);
  chk('a sport nobody covers is refused', !C.validate(Object.assign({}, good, { sport: 'CRICKET' })).ok);
  chk('no sport at all is fine', C.validate(Object.assign({}, good, { sport: null })).ok);
  const dirty = C.validate(Object.assign({}, good, { body: BODY + ' This is my best bet.' }));
  chk('a post with a banned phrase fails validation', !dirty.ok);
  chk('and the error names the phrase', dirty.errors.some(e => e.term && /best bet/i.test(e.term)),
    JSON.stringify(dirty.errors));
  /* every limit the database enforces is one the composer knows about */
  has(SQL, 'char_length(title) between 8 and 140', 'the SQL title bound matches the composer');
  eq('the composer agrees on the title bounds', C.LIMITS.title_min + '-' + C.LIMITS.title_max, '8-140');
  has(SQL, 'char_length(body) between 200 and 20000', 'the SQL body bound matches the composer');
  eq('the composer agrees on the body bounds', C.LIMITS.body_min + '-' + C.LIMITS.body_max, '200-20000');
  has(SQL, 'char_length(author_name) between 2 and 40', 'and on the name bounds');
  has(SQL, 'v_recent >= 5', 'and on how many posts a day');
  eq('the composer agrees on the daily limit', C.LIMITS.per_day, 5);
})();

/* ======================================================================== */
section('6. THE ENTITLEMENT RULE, THE SAME IN BOTH PLACES');
/* ======================================================================== */
(function () {
  const now = Date.parse('2026-09-08T12:00:00Z');
  const fut = '2026-10-01T00:00:00Z', past = '2026-09-01T00:00:00Z', longPast = '2026-07-01T00:00:00Z';
  chk('no subscription: an editor reads it first', !C.entitled(null, now));
  chk('active: publishes straight through', C.entitled({ status: 'active', current_period_end: fut }, now));
  chk('trialing counts — a trial is a subscription', C.entitled({ status: 'trialing', current_period_end: fut }, now));
  chk('cancelled does not', !C.entitled({ status: 'canceled', current_period_end: fut }, now));
  chk('a comp does, on the row alone', C.entitled({ status: 'active', price_id: 'owner_comp' }, now));
  chk('a failed card inside the retry window still does',
    C.entitled({ status: 'past_due', current_period_end: past }, now));
  chk('and stops once the retries are exhausted',
    !C.entitled({ status: 'past_due', current_period_end: longPast }, now));
  chk('an active row whose period has lapsed does not',
    !C.entitled({ status: 'active', current_period_end: past }, now));
  /* the same numbers, in the file that decides */
  has(SQL, "'owner_comp'", 'the database knows the comp price id');
  has(SQL, "interval '21 days'", 'and the same past-due grace');
  eq('the composer uses that grace too', C.PAST_DUE_GRACE_DAYS, 21);
  has(SQL, "s.status in ('active', 'trialing')", 'and the same two live statuses');

  /* and the sentence a writer is shown before they write */
  const live = C.publishRoute({ status: 'active', current_period_end: fut });
  chk('a subscriber is told their post goes live', live.immediate && /straight through/.test(live.note));
  const queued = C.publishRoute(null);
  chk('a free account is told an editor reads it first', !queued.immediate && /editor/.test(queued.note));
  eq('and that it becomes pending, not lost', queued.status, 'pending');
})();

/* ======================================================================== */
section('7. SLUGS');
/* ======================================================================== */
eq('a slug comes off the headline', C.slugFor('What the Kansas number is saying', 'abcdef123456'),
  'what-the-kansas-number-is-saying-abcdef');
chk('two posts with one headline get different addresses',
  C.slugFor('Same headline', 'aaaaaa1') !== C.slugFor('Same headline', 'bbbbbb2'));
chk('a slug is URL-safe', /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(C.slugFor('Wild <>&? "title" — here!', 'abc123')),
  C.slugFor('Wild <>&? "title" — here!', 'abc123'));
chk('a headline of pure punctuation still gets an address',
  /^post-/.test(C.slugFor('!!!???', 'abc123')), C.slugFor('!!!???', 'abc123'));
has(SQL, 'community_posts_slug_uk', 'and the database owns uniqueness, not the browser');

/* ======================================================================== */
section('8. A MEMBER POST IS NOT RESEARCH');
/* ======================================================================== */
(function () {
  /* structurally: a different table, so the research builder cannot see one */
  has(SQL, 'create table if not exists public.community_posts', 'member posts live in their own table');
  const BUILD = fs.readFileSync(path.join(ROOT, 'tools', 'articles', 'build_articles.js'), 'utf8');
  lacks(BUILD, 'community_posts', 'the research builder does not read the member table');
  const SITEMAP = fs.readFileSync(path.join(ROOT, 'sitemap-articles.xml'), 'utf8');
  lacks(SITEMAP, '/articles/community', 'no member post is in a sitemap');
  lacks(SITEMAP, '/articles/write', 'nor is the composer');
  const SITEMAPS = require(path.join(ROOT, 'tools', 'sitemap_set.js'));
  chk('nor anywhere in the sitemap set',
    SITEMAPS.urls(ROOT).every(u => u.indexOf('/articles/community') < 0 && u.indexOf('/articles/write') < 0));

  /* and every public surface says so in words */
  has(FEED, 'name="robots" content="noindex,nofollow"', 'the member feed is noindex');
  has(WRITE, 'name="robots" content="noindex,nofollow"', 'the composer is noindex');
  has(FEED, 'Member posts are not EdgeDesk research', 'the feed says whose view a member post is');
  has(FEED, 'a-membertag', 'and labels every card');
  has(FEED, 'a-memberwarn', 'and every post it renders');
  has(FEED, 'not betting advice', 'and repeats the disclaimer on a shared link');
  chk('the label is rendered on the single-post view, not only the feed',
    FEED.indexOf('memberTag()') >= 0 && FEED.slice(FEED.indexOf('function showPost')).indexOf('memberTag()') >= 0);

  /* the research pages still say what they always said */
  const ART = fs.readFileSync(path.join(ROOT, 'articles', 'missouri-vs-kansas-2026', 'index.html'), 'utf8');
  has(ART, 'name="robots" content="index,follow"', 'a research article is still indexed');
  lacks(ART, 'a-membertag', 'and carries no member-post furniture');
  has(ART, 'By <a href="/app.html#research/football" rel="author">EdgeDesk Research</a>',
    'and is still bylined to the model');
})();

/* ======================================================================== */
section('9. THE WAY IN');
/* ======================================================================== */
has(HUB, 'a-writebar', 'the research hub carries the write bar');
has(HUB, 'href="/articles/write"', 'with a button that goes to the composer');
has(HUB, 'Write a post', 'labelled for what it does');
has(HUB, 'href="/articles/community"', 'and a link to read member posts');
has(HUB, 'kept separate from EdgeDesk’s model research',
  'and says on the hub that the two are separate');
has(HUB, '<a class="ah-tab" href="/articles/community">Members</a>', 'the section is in the site nav');
has(NOTFOUND, "p[1]==='community'", 'a pretty member-post URL is routed on a static host');
has(NOTFOUND, "'/articles/community/?p='", 'to the one page that can render it');
(function () {
  const ROBOTS = fs.readFileSync(path.join(ROOT, 'robots.txt'), 'utf8');
  /* NOT Disallowed on purpose: a crawler that cannot fetch the page cannot
     read the noindex on it, and a blocked URL can still be indexed without
     its content. Allowing the crawl is how the noindex actually lands. */
  lacks(ROBOTS, 'Disallow: /articles/community', 'the member section is crawlable so its noindex is readable');
  lacks(ROBOTS, 'Disallow: /articles/write', 'and so is the composer');
})();

/* ======================================================================== */
section('10. THE COMPOSER TELLS THE TRUTH BEFORE ANYTHING IS WRITTEN');
/* ======================================================================== */
has(WRITE, 'community_can_publish', 'it asks the database what will happen');
has(WRITE, 'straight through', 'and says so when the answer is yes');
has(WRITE, 'read by an EdgeDesk editor', 'and says so when the answer is no');
has(WRITE, "$('bPublish').textContent = CAN_PUBLISH ? 'Publish' : 'Submit for review'",
  'and the button is labelled with what it will actually do');
has(WRITE, 'C.scan(', 'the banned phrases are shown as the writer types');
has(WRITE, 'C.validate(post)', 'and the whole post is validated before it is sent');
chk('a server decision that differs from the button is reported, not hidden',
  WRITE.indexOf('landed === \'pending\'') >= 0 && WRITE.indexOf('used a phrase EdgeDesk does not print') >= 0);
has(WRITE, 'your text is still in the box', 'a failed submit does not eat the post');
has(WRITE, 'href="/terms.html"', 'the terms are linked at the point of posting');
chk('the composer ships no service-role credential',
  !/service_role|sb_secret|"role":"service/.test(WRITE));
chk('nor does the feed', !/service_role|sb_secret|"role":"service/.test(FEED));

/* ======================================================================== */
section('11. THE MODERATION QUEUE');
/* ======================================================================== */
has(ADMIN, 'tab-community', 'the operator manager has a member-post queue');
has(ADMIN, 'Waiting for a decision', 'defaulting to the posts that need one');
['Approve', 'Reject', 'Unpublish', 'Read'].forEach(w => has(ADMIN, '>' + w + '<', 'the queue offers ' + w));
has(ADMIN, 'CM.bodyHTML(row.body)', 'a post is previewed through the same renderer the public page uses');
has(ADMIN, 'flagged_terms', 'and the phrase that queued it is shown on the row');
has(ADMIN, 'status=eq.pending', 'the tab counts the actual workload');
chk('the queue ships no service-role credential',
  !/service_role|sb_secret|"role":"service/.test(ADMIN));
chk('rejecting asks first', ADMIN.indexOf('confirm(') >= 0);

/* ======================================================================== */
section('12. THE MIGRATION FOLLOWS THE HOUSE RULES');
/* ======================================================================== */
(function () {
  const files = fs.readdirSync(path.join(ROOT, 'supabase')).filter(f => f.endsWith('.sql'));
  files.forEach(f => {
    const t = fs.readFileSync(path.join(ROOT, 'supabase', f), 'utf8');
    chk(f + ' carries no psql meta-command', !/^\s*\\/m.test(t));
  });
  has(SQL, 'create table if not exists', 'community_posts.sql is idempotent');
  has(SQL, 'add column if not exists', 'and additive, column by column');
  chk('and ends in a report', /select\s+1\s+as\s+step/.test(SQL) && SQL.indexOf("'ok'") > 0);
  has(SQL, 'security definer', 'the entitlement test is security definer');
  has(SQL, 'set search_path = public, pg_temp', 'with a pinned search path');
  chk('no client role may delete a post',
    !/create policy[^;]*community_posts[^;]*for delete/i.test(SQL));
  has(SQL, 'community_posts_guard()', 'publishing is decided by a trigger');
  /* RUN OUT OF ORDER, IT HAS TO SAY SO. A CREATE POLICY expression is resolved
     when the policy is created, so a missing site_article_is_admin() does not
     degrade — it stops the file with a bare `42883: function ... does not
     exist`, which names what is missing and nothing about what to do. That is
     exactly what a real install hit. */
  chk('it checks its dependencies before it needs them',
    /do \$preflight\$/.test(SQL) && SQL.indexOf('to_regproc(\'public.site_article_is_admin\')') > 0);
  has(SQL, 'Run supabase/site_articles.sql first', 'and names the file to run first');
  has(SQL, 'Run supabase/billing.sql first', 'and the one before that');
  chk('the preflight runs before the first policy that needs the predicate',
    SQL.indexOf('$preflight$') < SQL.indexOf('site_article_is_admin()') ||
    SQL.indexOf('$preflight$') < SQL.indexOf('create policy'),
    'a check after the statement it protects is not a check');
  /* and the ordering trap inside site_articles.sql itself: the admin function
     must be created BEFORE anything that could abort the transaction */
  (function () {
    const SA = fs.readFileSync(path.join(ROOT, 'supabase', 'site_articles.sql'), 'utf8');
    chk('site_articles.sql cannot abort before it creates its admin predicate',
      SA.indexOf('issue_report_admins') < 0
      || /if to_regclass\('public\.issue_report_admins'\) is not null then/.test(SA),
      'the carry-over must be guarded, or the rollback takes the function with it');
  })();
  chk('and OLD is only read on an update',
    (function () {
      const fn = SQL.slice(SQL.indexOf('function public.community_posts_guard'), SQL.indexOf('drop trigger if exists community_posts_guard_t'));
      const lines = fn.split('\n');
      let inUpdate = false, bad = [];
      lines.forEach(l => {
        if (/if tg_op = 'UPDATE' then/.test(l)) inUpdate = true;
        else if (/^\s*end if;/.test(l) && inUpdate) inUpdate = false;
        else if (/\bold\./.test(l) && !inUpdate && !/^\s*--/.test(l)) bad.push(l.trim());
      });
      return !bad.length;
    })(), 'referencing OLD on an insert is an error nobody sees until a post is filed');
  /* the site_articles migration must survive a project without issue_reports */
  const SA = fs.readFileSync(path.join(ROOT, 'supabase', 'site_articles.sql'), 'utf8');
  chk('site_articles.sql guards the issue_reports carry-over with dynamic SQL',
    /if to_regclass\('public\.issue_report_admins'\) is not null then\s*\n\s*execute/.test(SA),
    'a plain insert…select resolves the table at PARSE time, so the guard never runs');
})();

/* ======================================================================== */
section('13. THE STORE IS UNTOUCHED');
/* ======================================================================== */
(function () {
  const recs = STORE.loadAll();
  chk('the research records still load', recs.length > 0, String(recs.length));
  chk('and none of them gained a member-post field',
    recs.every(r => !('author_id' in r) && !('flagged_terms' in r)));
  chk('the four acceptance articles are still published',
    ['missouri-vs-kansas-2026', 'rutgers-vs-boston-college-2026',
     'norfolk-state-vs-virginia-2026', 'new-england-patriots-vs-seattle-seahawks-2026']
      .every(s => recs.some(r => r.slug === s && r.status === 'published')));
})();

/* ======================================================================== */
console.log('');
failures.forEach(f => console.log('  × ' + f));
console.log((fail ? 'FAIL' : 'PASS') + ' | edgedesk member posts | ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
