/*__EDART_COMMUNITY_START__*/
/* ============================================================================
   MEMBER POSTS — the rules, in one file, for the browser and the database.

   WHAT THIS IS NOT. A community post is not EdgeDesk research. The research
   articles under /articles/ are generated from the model and are engineered so
   that nothing on them can read as a pick. A member post is a person's own
   writing, and no amount of code can make it EdgeDesk's view of a game. So the
   product does not pretend otherwise: member posts live in their own section,
   carry their own label on every surface, and are never mixed into the
   research feed or any sitemap.

   WHAT THIS FILE DOES DO
     - one deterministic slug rule
     - one list of phrases a post may not carry, and one place it lives
     - one safe renderer: a body is TEXT, escaped, never markup
     - one validator, run in the composer for a useful error message and again
       in the database where it actually counts

   THE WORD LIST IS A GUARDRAIL, NOT A FILTER. Somebody who wants to post a
   pick can write around any list of phrases, and this one is not claimed to
   stop them. What actually holds the line is structural: an unentitled account
   cannot publish at all without an operator reading the post first, every
   post carries its author, and anything published can be removed. The list
   catches the careless case and tells the writer, in the composer, why the
   sentence does not belong on EdgeDesk.

   MIRRORED IN SQL. supabase/community_posts.sql enforces the same list in a
   trigger, because a browser is not a place where a rule can be enforced.
   tools/articles/community.test.js fails if the two lists drift.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDART = root.EDART || {};
  root.EDART.community = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SITE = 'https://edgedesksports.com';
  var STATUSES = ['draft', 'pending', 'published', 'rejected', 'removed'];

  var LIMITS = {
    title_min: 8, title_max: 140,
    body_min: 200, body_max: 20000,
    name_min: 2, name_max: 40,
    per_day: 5                       /* published posts per author per 24h */
  };

  /* ------------------------------------------------------------ the list */
  /* Plain alternatives, no word-boundary syntax: JavaScript spells a boundary
     `\b` and PostgreSQL spells it `\y` (in PostgreSQL `\b` is a backspace),
     so each host wraps this list in its own boundary rather than carrying two
     copies of it. Each entry is [pattern, what to tell the writer]. */
  var BANNED_TERMS = [
    ['best bets?', 'EdgeDesk does not publish best bets. Say what the numbers show and let the reader price it.'],
    ['lock of the', 'Nothing is a lock. If the model had that much confidence it would say so as a probability.'],
    ['mortal lock', 'Nothing is a lock. If the model were that sure it would publish the probability and let you see how sure.'],
    ['guaranteed win(?:ner|s)?', 'No outcome is guaranteed, and saying so is the one claim this site will not carry.'],
    ['free money', 'There is no free money in a priced market.'],
    ['sure thing', 'Nothing on a football field is a sure thing.'],
    ['cannot lose', 'A bet that cannot lose does not exist.'],
    ['can.?t lose', 'A bet that cannot lose does not exist.'],
    ['no.?brainer', 'If it were obvious the price would already reflect it.'],
    ['easy money', 'There is no easy money in a priced market.'],
    ['100% winner', 'No selection wins every time.'],
    ['bet the house', 'EdgeDesk does not tell anyone how much to stake, ever.'],
    ['max bet', 'EdgeDesk does not tell anyone how much to stake, ever.'],
    ['mortgage', 'EdgeDesk does not tell anyone how much to stake, ever.'],
    ['hammer(?:ing)? (?:this|the|it)', 'Write what you saw in the numbers, not how hard to bet it.'],
    ['smash (?:play|spot|this)', 'Write what you saw in the numbers, not how hard to bet it.'],
    ['(?:my|our|the) pick is', 'A pick is not what this section is for. Show the reasoning and let the reader decide.'],
    ['take the points', 'That is a recommendation. Describe the matchup instead.'],
    ['play of the (?:day|week|year)', 'That is a recommendation. Describe the matchup instead.'],
    ['guaranteed profit', 'Nothing here is a guarantee of profit.'],
    ['risk.?free', 'No wager is risk free, and describing one that way is a regulated claim.']
  ];
  /* A name nobody may post under: it would put a member's words behind
     EdgeDesk's own byline, which is the one thing the label cannot survive. */
  var RESERVED_NAMES = ['edgedesk', 'edge desk', 'admin', 'administrator', 'moderator',
    'official', 'staff', 'support', 'edgedesk research', 'system'];

  function bannedRegex() {
    return new RegExp('\\b(?:' + BANNED_TERMS.map(function (t) { return t[0]; }).join('|') + ')\\b', 'i');
  }
  /* Every phrase the text carries, with the reason for each. Returned rather
     than thrown so the composer can show them all at once instead of making
     somebody fix one sentence per attempt. */
  function scan(text) {
    var s = String(text == null ? '' : text);
    var hits = [];
    BANNED_TERMS.forEach(function (t) {
      var re = new RegExp('\\b(?:' + t[0] + ')\\b', 'i');
      var m = re.exec(s);
      if (m) hits.push({ term: m[0], why: t[1] });
    });
    return { ok: !hits.length, hits: hits };
  }

  /* ---------------------------------------------------------------- slugs */
  function slugify(s) {
    s = String(s == null ? '' : s);
    try { s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (_) {}
    return s.toLowerCase().replace(/&/g, ' and ').replace(/['’ʻ.]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70).replace(/-+$/, '');
  }
  /* title + a short suffix off the post's own id. A member post is noindex, so
     the suffix costs nothing in search, and it makes a slug collision — two
     people writing "Kansas is overrated" — impossible without a round trip. */
  function slugFor(title, id) {
    var base = slugify(title) || 'post';
    var tail = String(id || '').replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase();
    return tail ? base + '-' + tail : base;
  }

  /* ------------------------------------------------------------- the body */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  /* A BODY IS TEXT. It is escaped first and nothing in it is ever treated as
     markup — no HTML, no markdown, no embeds. Blank lines become paragraphs
     and bare http(s) links become anchors carrying rel="nofollow ugc noopener",
     which is the whole of the formatting on offer. Anything richer is a way
     for one member to run script in another member's session. */
  function bodyHTML(text) {
    var safe = esc(String(text == null ? '' : text).replace(/\r\n?/g, '\n'));
    var linked = safe.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]}'"])/g, function (u) {
      return '<a href="' + u + '" rel="nofollow ugc noopener" target="_blank">' + u + '</a>';
    });
    return linked.split(/\n{2,}/).map(function (p) {
      return '<p>' + p.replace(/\n/g, '<br>') + '</p>';
    }).join('');
  }
  function excerptOf(text, n) {
    var s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    n = n || 220;
    return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s;
  }
  function words(text) {
    var s = String(text == null ? '' : text).trim();
    return s ? s.split(/\s+/).length : 0;
  }
  function readingMinutes(text) { return Math.max(1, Math.round(words(text) / 220)); }

  /* ---------------------------------------------------------- validation */
  /* Run in the composer so a writer gets every problem at once, and again in
     the database, where it is the one that counts. */
  function validate(post) {
    var errs = [];
    var title = String(post && post.title || '').trim();
    var body = String(post && post.body || '').trim();
    var name = String(post && post.author_name || '').trim();

    if (title.length < LIMITS.title_min) errs.push({ field: 'title', why: 'A headline needs at least ' + LIMITS.title_min + ' characters.' });
    if (title.length > LIMITS.title_max) errs.push({ field: 'title', why: 'A headline is at most ' + LIMITS.title_max + ' characters.' });
    if (body.length < LIMITS.body_min) errs.push({ field: 'body', why: 'A post needs at least ' + LIMITS.body_min + ' characters — this section is for reasoning, not one-liners.' });
    if (body.length > LIMITS.body_max) errs.push({ field: 'body', why: 'A post is at most ' + LIMITS.body_max + ' characters.' });
    if (name.length < LIMITS.name_min) errs.push({ field: 'author_name', why: 'Choose a name to post under.' });
    if (name.length > LIMITS.name_max) errs.push({ field: 'author_name', why: 'A posting name is at most ' + LIMITS.name_max + ' characters.' });

    var lower = name.toLowerCase();
    if (RESERVED_NAMES.some(function (r) { return lower === r || lower.indexOf(r) >= 0; })) {
      errs.push({ field: 'author_name', why: 'That name would read as EdgeDesk itself. Pick one that is yours.' });
    }
    if (post && post.sport && ['CFB', 'NFL'].indexOf(String(post.sport).toUpperCase()) < 0) {
      errs.push({ field: 'sport', why: 'Pick College Football, NFL, or leave it unset.' });
    }
    var s = scan(title + '\n' + body);
    s.hits.forEach(function (h) {
      errs.push({ field: 'body', term: h.term, why: '“' + h.term + '” — ' + h.why });
    });
    return { ok: !errs.length, errors: errs };
  }

  /* Who may publish WITHOUT an operator reading it first. Mirrors pgEntitled()
     in app.html, and the database enforces the same rule in a trigger: this
     copy exists so the composer can tell somebody what will happen to their
     post before they spend twenty minutes writing it, not so the browser can
     decide. */
  var COMP_PRICE_IDS = ['owner_comp'];
  var PAST_DUE_GRACE_DAYS = 21;
  function entitled(sub, now) {
    if (!sub) return false;
    now = now == null ? Date.now() : new Date(now).getTime();
    if (sub.status === 'active' && COMP_PRICE_IDS.indexOf(String(sub.price_id || '')) >= 0) return true;
    if (sub.status === 'active' || sub.status === 'trialing') {
      if (sub.current_period_end) {
        var t = new Date(sub.current_period_end).getTime();
        if (isFinite(t) && t < now) return false;
      }
      return true;
    }
    if (sub.status === 'past_due') {
      if (!sub.current_period_end) return true;
      var p = new Date(sub.current_period_end).getTime();
      if (!isFinite(p)) return true;
      return (now - p) < PAST_DUE_GRACE_DAYS * 864e5;
    }
    return false;
  }
  /* What happens when this account presses Publish, in one sentence, before
     they write anything. */
  function publishRoute(sub) {
    return entitled(sub, null)
      ? { status: 'published', immediate: true,
          note: 'Your subscription publishes straight through — this goes live the moment you press Publish.' }
      : { status: 'pending', immediate: false,
          note: 'Free accounts are read by an EdgeDesk editor before a post goes public. You will keep the draft and it appears once it is approved.' };
  }

  function postURL(slug) { return SITE + '/articles/community/' + slug; }

  return {
    SITE: SITE, STATUSES: STATUSES, LIMITS: LIMITS,
    BANNED_TERMS: BANNED_TERMS, RESERVED_NAMES: RESERVED_NAMES, bannedRegex: bannedRegex,
    COMP_PRICE_IDS: COMP_PRICE_IDS, PAST_DUE_GRACE_DAYS: PAST_DUE_GRACE_DAYS,
    scan: scan, slugify: slugify, slugFor: slugFor, esc: esc, bodyHTML: bodyHTML,
    excerptOf: excerptOf, words: words, readingMinutes: readingMinutes,
    validate: validate, entitled: entitled, publishRoute: publishRoute, postURL: postURL
  };
});
/*__EDART_COMMUNITY_END__*/
