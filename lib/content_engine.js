/* ===========================================================================
   EdgeDesk — the Sports Media Content Engine's core (EDContentEngine).

   One file, three hosts, no dependencies:
     · the owner's Content Engine page (admin/content/) loads it in a browser;
     · the weekly job (tools/content/run.js) requires it in Node;
     · the content_engine Edge Function carries a VERBATIM copy
       (tools/content/inline.js; a test fails on drift).

   WHAT IT DOES
     research   reads artifacts EdgeDesk already publishes (the CFB terminal,
                the rankings, the NFL slate, the NFL injury report, the
                captured market snapshots) into one normalised packet per game.
                It computes nothing a model did not already compute: it
                SELECTS, ROUNDS and LABELS, and it states how old each number
                is. A stale price is labelled stale; a reference line with no
                book and no capture time is labelled a reference; a missing
                confidence stays missing, with the reason.
     discover   turns a research snapshot (plus optional, attributed news
                headlines and EdgeDesk's own Search Console queries) into
                scored article opportunities. Every score carries its basis;
                search demand is an ESTIMATE unless measured evidence exists,
                and says so.
     seo        a brief per opportunity: keywords, intent, headlines, meta
                description, slug, structure, links, demand evidence.
     draft      a deterministic draft in one of five formats, written only
                from the packet. It is the floor the AI pass must beat, and
                what ships when no model is configured.
     validate   the quality gate: every number and team must be in the
                evidence; no pick, lock or guarantee language; projections
                never presented as betting value; stale prices never
                presented as current; external reporting attributed;
                disclaimer and attribution present; SEO and length checks;
                near-duplicate detection against sibling articles.
     export     Markdown and HTML, with a UTM-tagged EdgeDesk link.
     news       parses public RSS headlines (title, link, time — never an
                article body) and matches them to teams on this week's slate.
     ai         builds the drafting request (structured JSON output) and
                parses the reply. The CALL is the host's: the Edge Function
                uses the SDK, the Node job raw HTTP. Whatever comes back is
                validated by the same gate and discarded if it fails.

   THE RULE IT SERVES: research, not picks. A team projected to win is not a
   bet; nothing here turns a projection into a recommendation.
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDContentEngine = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var VERSION = 'content_engine_v1';
  var SITE = 'https://edgedesksports.com';

  /* THE INTEGRITY LAYER (docs/system-integrity): the one calculation layer,
     kickoff truth, availability classes and the integrity engine. The page
     loads them with <script> tags, Node requires them, and the Edge Function
     carries verbatim copies (tools/content/inline.js). Without them every
     number is unchecked, so validation FAILS CLOSED (check integrity_engine). */
  function dep(name, file) {
    var G = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : {});
    if (G && G[name]) return G[name];
    if (typeof require === 'function') { try { return require('./' + file); } catch (e) { /* not in this host */ } }
    return null;
  }
  var CALC = dep('EDCalc', 'edgedesk_calc.js'), SCHED = dep('EDSchedule', 'edgedesk_schedule.js'),
    AVAIL = dep('EDAvailability', 'edgedesk_availability.js'), INTEG = dep('EDIntegrity', 'edgedesk_integrity.js');
  var INTEGRITY_OK = !!(CALC && SCHED && AVAIL && INTEG);

  /* ------------------------------------------------------------ vocabulary */
  var STATUSES = ['draft', 'in_review', 'approved', 'ready_to_send', 'sent', 'published', 'rejected', 'archived'];
  /* The same matrix the database enforces (supabase/content_engine.sql).
     REJECTED: the owner turned the draft down in review; it can be reworked
     (back to draft) or archived, never approved as it stands. */
  var TRANSITIONS = {
    draft: ['in_review', 'archived'],
    in_review: ['draft', 'approved', 'rejected', 'archived'],
    rejected: ['draft', 'archived'],
    approved: ['ready_to_send', 'in_review', 'draft', 'archived'],
    ready_to_send: ['sent', 'approved', 'in_review', 'archived'],
    sent: ['published', 'archived'],
    published: ['archived'],
    archived: ['draft']
  };
  var STATUS_LABELS = {
    draft: 'Draft', in_review: 'In review', approved: 'Approved', ready_to_send: 'Ready to send',
    sent: 'Sent', published: 'Published', rejected: 'Rejected', archived: 'Archived'
  };

  var KINDS = {
    weekly_preview: 'Weekly preview',
    upset_watch: 'Upset watch',
    conference_race: 'Conference race',
    market_discrepancy: 'Market discrepancy',
    injury_impact: 'Injury implications',
    trending_story: 'Trending story',
    weekend_storylines: 'Biggest weekend storylines',
    game_deep_dive: 'Individual game deep dive',
    model_performance: 'Weekly model performance review'
  };

  /* Each format names the sections a draft must carry, in order. `required`
     sections must be present for the structure check to pass. */
  var FORMATS = {
    cfb_weekly_preview: {
      label: 'Weekly CFB preview', league: 'cfb',
      sections: ['intro', 'why_it_matters', 'how_to_read', 'games', 'upsets', 'conference', 'limits', 'conclusion'],
      required: ['intro', 'why_it_matters', 'how_to_read', 'games', 'limits', 'conclusion'],
      words: [900, 1800]
    },
    nfl_weekly_preview: {
      label: 'Weekly NFL preview', league: 'nfl',
      sections: ['intro', 'why_it_matters', 'how_to_read', 'games', 'upsets', 'disagreements', 'injuries', 'limits', 'conclusion'],
      required: ['intro', 'why_it_matters', 'how_to_read', 'games', 'limits', 'conclusion'],
      words: [900, 1800]
    },
    trending_story: {
      label: 'Trending sports story', league: null,
      sections: ['intro', 'reported', 'why_it_matters', 'research', 'unknowns', 'conclusion'],
      required: ['intro', 'reported', 'research', 'unknowns', 'conclusion'],
      words: [450, 1000]
    },
    market_discrepancy: {
      label: 'Model vs. Market', league: null,
      sections: ['intro', 'the_gap', 'why_they_differ', 'how_to_read', 'market_case', 'limits', 'conclusion'],
      required: ['intro', 'the_gap', 'why_they_differ', 'how_to_read', 'market_case', 'conclusion'],
      words: [500, 1200]
    },
    /* docs/system-integrity/TEMPLATES.md: one central story each, verified
       numbers only, uncertainty stated, EdgeDesk credited, methodology kept short */
    weekend_storylines: {
      label: 'Biggest Weekend Storylines', league: null,
      sections: ['intro', 'storylines', 'how_to_read', 'limits', 'conclusion'],
      required: ['intro', 'storylines', 'how_to_read', 'limits', 'conclusion'],
      words: [600, 1400]
    },
    game_deep_dive: {
      label: 'Individual Game Deep Dive', league: null,
      sections: ['intro', 'the_matchup', 'numbers', 'why_they_differ', 'what_could_change', 'how_to_read', 'limits', 'conclusion'],
      required: ['intro', 'the_matchup', 'numbers', 'how_to_read', 'limits', 'conclusion'],
      words: [500, 1200]
    },
    conference_race: {
      label: 'Conference Race Analysis', league: 'cfb',
      sections: ['intro', 'race', 'games', 'how_to_read', 'limits', 'conclusion'],
      required: ['intro', 'race', 'games', 'how_to_read', 'conclusion'],
      words: [450, 1200]
    },
    upset_watch: {
      label: 'Upset Watch', league: null,
      sections: ['intro', 'upsets', 'how_to_read', 'limits', 'conclusion'],
      required: ['intro', 'upsets', 'how_to_read', 'conclusion'],
      words: [450, 1100]
    },
    model_performance_review: {
      label: 'Weekly Model Performance Review', league: null,
      sections: ['intro', 'record', 'where_it_missed', 'calibration', 'how_to_read', 'conclusion'],
      required: ['intro', 'record', 'how_to_read', 'conclusion'],
      words: [350, 1000]
    },
    publisher_custom: {
      label: 'Publisher-specific article', league: null,
      sections: null, /* from the publisher's profile, else the league preview */
      required: ['intro', 'how_to_read', 'conclusion'],
      words: null
    }
  };

  var SECTION_HEADINGS = {
    intro: null,
    why_it_matters: 'Why this week matters',
    how_to_read: 'How to read these numbers',
    games: 'The games that matter most',
    upsets: 'Upset watch',
    conference: 'What it means for the conference races',
    disagreements: 'Where the numbers tell a different story',
    injuries: 'Injury report: what to watch',
    limits: 'What the numbers can’t see',
    conclusion: 'The bottom line',
    reported: 'What was reported',
    research: 'What EdgeDesk’s research shows',
    unknowns: 'What we don’t know yet',
    the_gap: 'The gap',
    why_they_differ: 'Why the numbers differ',
    market_case: 'The case for the market',
    storylines: 'The storylines',
    the_matchup: 'The matchup',
    numbers: 'What EdgeDesk’s numbers say',
    what_could_change: 'What could change it',
    race: 'The state of the race',
    record: 'How the numbers did',
    where_it_missed: 'Where it missed',
    calibration: 'Were the probabilities honest?'
  };

  var DISCLAIMER = 'EdgeDesk publishes research, not betting advice. Nothing in this article is a pick, a wager or a recommendation. 21+. Gamble responsibly — 1-800-GAMBLER.';

  /* Opportunity score: seven parts, each 0–100 with a stated basis. */
  var SCORE_WEIGHTS = {
    search_relevance: 0.18, timeliness: 0.14, audience_interest: 0.16, research_availability: 0.16,
    editorial_relevance: 0.10, publisher_fit: 0.14, research_confidence: 0.12
  };
  var SCORE_LABELS = {
    search_relevance: 'Search relevance', timeliness: 'Timeliness', audience_interest: 'Audience interest',
    research_availability: 'Research availability', editorial_relevance: 'Editorial relevance',
    publisher_fit: 'Publisher fit', research_confidence: 'Research confidence'
  };

  /* Thresholds shared with the rest of EdgeDesk (lib/edgedesk_canon.js,
     the CFB decision policy): a quote older than 180 minutes is not a price. */
  var STALE_MINUTES = 180;
  var MIN_CONFIDENCE = 35;
  var RESEARCH_GAP = 2;
  var POWER4 = ['SEC', 'Big Ten', 'Big 12', 'ACC'];

  /* ------------------------------------------------------ banned language */
  /* Copied from tools/articles/article_model.js FORBIDDEN and
     tools/articles/community.js BANNED_TERMS (tools/content/content.test.js
     fails if either list grows a phrase this one lacks), plus the engine's
     own additions for prediction copy. */
  var BANNED = [
    ['best bets?', 'EdgeDesk does not publish best bets.'],
    ['lock of the', 'Nothing is a lock.'],
    ['locks? of', 'Nothing is a lock.'],
    ['mortal lock', 'Nothing is a lock.'],
    ['guaranteed win(?:ner|s)?', 'No outcome is guaranteed.'],
    ['guaranteed', 'No outcome is guaranteed.'],
    ['guarantee', 'No outcome is guaranteed.'],
    ['free money', 'There is no free money in a priced market.'],
    ['sure thing', 'Nothing on a football field is a sure thing.'],
    ['cannot lose', 'A bet that cannot lose does not exist.'],
    ['can.?t[- ]lose', 'A bet that cannot lose does not exist.'],
    ['can.?t[- ]miss', 'Nothing is certain.'],
    ['no.?brainer', 'If it were obvious the price would already reflect it.'],
    ['easy money', 'There is no easy money in a priced market.'],
    ['100% winner', 'No selection wins every time.'],
    ['bet the house', 'EdgeDesk does not tell anyone how much to stake.'],
    ['bet the', 'That is a recommendation.'],
    ['max bet', 'EdgeDesk does not tell anyone how much to stake.'],
    ['mortgage', 'EdgeDesk does not tell anyone how much to stake.'],
    ['hammer(?:ing)? (?:this|the|it)', 'Write what the numbers show, not how hard to bet it.'],
    ['smash (?:play|spot|this)', 'Write what the numbers show, not how hard to bet it.'],
    ['(?:my|our|the) pick is', 'A pick is not what this article is for.'],
    ['our picks?', 'A pick is not what this article is for.'],
    ['take the points', 'That is a recommendation.'],
    ['take the (?:over|under)', 'That is a recommendation.'],
    ['play of the (?:day|week|year)', 'That is a recommendation.'],
    ['guaranteed profit', 'Nothing here is a guarantee of profit.'],
    ['risk.?free', 'No wager is risk free.'],
    ['best value', 'Value depends on the price at the moment of a bet; the article does not rank bets.'],
    ['value play', 'That is a recommendation.'],
    ['worth a bet', 'That is a recommendation.'],
    ['(?:you|fans|readers) should (?:bet|back|take|wager)', 'That is a recommendation.'],
    ['bet on (?:the )?[A-Z][a-z]+', 'That is a recommendation.'],
    ['slam dunk', 'Nothing is certain.'],
    ['will (?:win|cover|beat|lose)', 'A projection is a probability, not a certainty: write "is projected to".'],
    ['certain to', 'A projection is a probability, not a certainty.'],
    ['no doubt', 'A projection is a probability, not a certainty.']
  ];
  var BANNED_RE = BANNED.map(function (b) { return { re: new RegExp('\\b' + b[0] + '\\b', b[0].indexOf('[A-Z]') >= 0 ? '' : 'i'), why: b[1], term: b[0] }; });

  /* tools/editorial/quality.js AI_TELLS, verbatim in intent. */
  var AI_TELLS = [
    /\bdelve[sd]? into\b/i, /\bin the (?:ever-?(?:changing|evolving)|fast-?paced) (?:world|landscape|realm)\b/i,
    /\bit(?:'|’)s important to note\b/i, /\bit is important to note\b/i, /\bgame[- ]chang(?:er|ing)\b/i,
    /\bonly time will tell\b/i, /\bwhether you(?:'|’)?re a (?:seasoned|casual|novice)\b/i,
    /\bthis thrilling (?:matchup|contest|clash)\b/i, /\bwhen (?:it|all) comes down to it\b/i,
    /\bat the end of the day\b/i, /\bin conclusion\b/i, /\bneedless to say\b/i, /\bthe perfect storm\b/i,
    /\bleave(?:s|) no stone unturned\b/i, /\ba testament to\b/i,
    /\bnavigat(?:e|ing) the (?:complexities|challenges|landscape)\b/i, /\bmust[- ]watch\b/i,
    /\bbuckle up\b/i, /\ball eyes will be on\b/i, /\bwithout a doubt\b/i
  ];
  var STRINGIFIED_NOTHING = /(^|[\s>(])(null|undefined|NaN)([\s<).,;:]|$)/;

  /* ---------------------------------------------------------------- utils */
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  /* one decimal the way EdgeDesk's own displays print it (toFixed), so a
     5.35 reads 5.3 here exactly as it does on the terminal */
  /* canonical rounding (lib/edgedesk_calc.js, half away from zero) so every
     number an article prints matches the terminal and the board digit for digit */
  function r1(x) { return CALC ? CALC.round(+x, 1) : +(+x).toFixed(1); }
  function oneDp(x) { return Math.abs(r1(x)).toFixed(1); }
  function aOrAn(numText) { return /^(8|11|18|8\d)(\.|$)/.test(String(numText)) ? 'an' : 'a'; }
  /* a betting line as books print it: 3, 6.5, 1.5 */
  function lineNum(x) { var a = Math.abs(r1(x)); return a % 1 === 0 ? String(a) : a.toFixed(1); }
  function pct(p) { return Math.round(p * 100) + '%'; }
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function uniq(a) { var s = {}, out = []; (a || []).forEach(function (x) { var k = typeof x === 'string' ? x : JSON.stringify(x); if (!s[k]) { s[k] = 1; out.push(x); } }); return out; }
  function ts(x) { var t = x ? Date.parse(x) : NaN; return isFinite(t) ? t : null; }
  function iso(t) { return new Date(t).toISOString(); }
  function minutesBetween(a, b) { return Math.round((b - a) / 60000); }
  function slugify(s) {
    return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[’']/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-').slice(0, 80).replace(/-+$/, '');
  }
  function words(s) { return String(s || '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').split(/\s+/).filter(function (w) { return /[A-Za-z0-9]/.test(w); }); }
  function wordCount(s) { return words(s).length; }
  function sentenceList(arr, conj) {
    arr = (arr || []).filter(Boolean); conj = ' ' + (conj || 'and') + ' ';
    if (arr.length <= 1) return arr.join('');
    if (arr.length === 2) return arr[0] + conj + arr[1];
    return arr.slice(0, -1).join(', ') + conj + arr[arr.length - 1];
  }
  var NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  function numWord(n) { return n >= 0 && n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n); }
  function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
  /* "Alabama is" but "the Dallas Cowboys are" */
  function verb(league, singular, plural) { return league === 'nfl' ? plural : singular; }
  /* djb2 → base36; used for deterministic keys and hashes, not security */
  function hash(s) {
    s = String(s); var h1 = 5381, h2 = 52711;
    for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); h1 = (h1 * 33) ^ c; h2 = (h2 * 33) ^ c; }
    return ((h1 >>> 0).toString(36) + (h2 >>> 0).toString(36));
  }

  /* Dates, the way an American sports desk prints them: Sat., Oct. 10,
     7:30 p.m. ET. Intl exists in every host this file runs in. */
  var MONTHS_AP = { Jan: 'Jan.', Feb: 'Feb.', Mar: 'March', Apr: 'April', May: 'May', Jun: 'June', Jul: 'July', Aug: 'Aug.', Sep: 'Sept.', Oct: 'Oct.', Nov: 'Nov.', Dec: 'Dec.' };
  var DAYS_AP = { Sun: 'Sun.', Mon: 'Mon.', Tue: 'Tue.', Wed: 'Wed.', Thu: 'Thu.', Fri: 'Fri.', Sat: 'Sat.' };
  function etParts(t) {
    var parts = {};
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
        .formatToParts(new Date(t)).forEach(function (p) { parts[p.type] = p.value; });
    } catch (e) {
      var d = new Date(t - 4 * 3600000); /* EDT fallback */
      var wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
      var mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
      var h = d.getUTCHours(), m = d.getUTCMinutes();
      parts = { weekday: wd, month: mo, day: String(d.getUTCDate()), hour: String(h % 12 || 12), minute: (m < 10 ? '0' : '') + m, dayPeriod: h < 12 ? 'AM' : 'PM' };
    }
    return parts;
  }
  function dayText(t) { var p = etParts(t); return (DAYS_AP[p.weekday] || p.weekday) + ', ' + (MONTHS_AP[p.month] || p.month) + ' ' + p.day; }
  function timeText(t) {
    var p = etParts(t);
    var ap = String(p.dayPeriod || '').toUpperCase() === 'AM' ? 'a.m.' : 'p.m.';
    return (p.minute === '00' ? p.hour : p.hour + ':' + p.minute) + ' ' + ap + ' ET';
  }
  function whenText(t) { return t == null ? null : dayText(t) + ', ' + timeText(t); }
  /* a kickoff as an article prints it (lib/edgedesk_schedule.js): a time the
     schedule marks TBA — or a midnight-Eastern placeholder with no flag — is
     "Sat., Oct. 17, time TBA", never "12 a.m. ET" */
  function kickoffTruth(g) {
    var raw = { kickoff: g.kickoff, kickoff_state: g.kickoff_state || null };
    if (g.kickoff_tbd != null) raw.start_time_tbd = g.kickoff_tbd;
    else if (g.start_time_tbd != null) raw.start_time_tbd = g.start_time_tbd;
    var k = SCHED ? SCHED.kickoffOf(raw) : { state: 'CONFIRMED', verified: true, ms: ts(g.kickoff), game_date: null, basis: 'no schedule module loaded' };
    var text = null;
    if (k.ms != null) {
      if (k.verified) text = whenText(k.ms);
      else if (k.game_date) { var d = k.game_date.split('-').map(Number); text = dayText(Date.UTC(d[0], d[1] - 1, d[2], 16)) + ', time TBA'; }
      else text = 'time TBA';
    }
    return { state: k.state, verified: k.verified, basis: k.basis, game_date: k.game_date, text: text };
  }

  /* ======================================================================
     RESEARCH — committed artifacts → one packet per game
     ====================================================================== */

  /* The files the engine reads, by role. Paths are repository paths and,
     because the site is served from the repository, also site paths. */
  var ARTIFACTS = {
    cfb_games: 'football/cfb_terminal/games.json',
    cfb_brief: 'football/cfb_terminal/brief.json',
    rankings: 'football/rankings/current.json',
    nfl_slate: 'football/nfl/slate.json',
    nfl_injuries: 'football/injuries/nfl_2026.json',
    published: 'articles/data/published.json',
    market: 'articles/data/market/{season}-week-{ww}.json',
    /* the live-forward model record, graded (tools/integrity/performance.js) */
    performance: 'football/validation/integrity_performance.json'
  };

  function rankingsIndex(rk) {
    var out = { as_of: null, week: null, teams: {}, by_name: {}, conference_top: {} };
    if (!rk || !rk.teams) return out;
    out.as_of = rk.data_as_of || rk.generated_at || null;
    out.week = rk.week || null;
    Object.keys(rk.teams).forEach(function (k) {
      var t = rk.teams[k]; if (!t || !t.team) return;
      var mv = t.movement && t.movement.rank;
      var row = {
        key: k, team: t.team, conference: t.conference || null, rank: isNum(t.rank) ? t.rank : null,
        rating: isNum(t.etsr) ? r1(t.etsr) : null,
        rank_from: mv && isNum(mv.from) ? mv.from : null, rank_to: mv && isNum(mv.to) ? mv.to : null
      };
      out.teams[k] = row; out.by_name[t.team] = row;
    });
    /* each conference's top three by EdgeDesk rating */
    var conf = {};
    Object.keys(out.teams).forEach(function (k) { var t = out.teams[k]; if (t.conference && t.rank) (conf[t.conference] = conf[t.conference] || []).push(t); });
    Object.keys(conf).forEach(function (c) {
      conf[c].sort(function (a, b) { return a.rank - b.rank; });
      out.conference_top[c] = conf[c].slice(0, 3).map(function (t) { return t.team; });
    });
    return out;
  }

  function marketState(capturedAtMs, now, staleMinutes) {
    if (capturedAtMs == null) return { status: 'reference', age_minutes: null };
    var age = minutesBetween(capturedAtMs, now);
    return { status: age <= (staleMinutes || STALE_MINUTES) ? 'current' : 'stale', age_minutes: age };
  }

  /* model-vs-market gap from the home side (negative home_line = home favoured) */
  function gapOf(home, away, modelHomeLine, marketHomeLine) {
    if (!isNum(modelHomeLine) || !isNum(marketHomeLine)) return null;
    var g = (Math.round(r1(marketHomeLine) * 10) - Math.round(r1(modelHomeLine) * 10)) / 10; /* >0: model likes home more than the market */
    var pts = Math.abs(g);
    if (pts < 0.1) return { points: 0, toward: null, text: 'no gap' };
    var toward = g > 0 ? home : away;
    return { points: pts, toward: toward, text: oneDp(pts) + ' points toward ' + toward };
  }

  function favOf(home, away, homeLine) {
    if (!isNum(homeLine)) return null;
    if (Math.abs(homeLine) < 0.05) return { favorite: null, underdog: null, margin: 0 };
    return homeLine < 0 ? { favorite: home, underdog: away, margin: r1(-homeLine) } : { favorite: away, underdog: home, margin: r1(homeLine) };
  }

  function modelDisplay(home, away, homeLine, homeWinProb, proj) {
    var f = favOf(home, away, homeLine);
    var d = {};
    if (f && f.favorite) d.fair = f.favorite + ' by ' + oneDp(f.margin);
    else if (f) d.fair = 'a pick’em';
    if (isNum(homeWinProb)) {
      var favP = f && f.favorite === away ? 1 - homeWinProb : homeWinProb;
      var favT = f && f.favorite ? f.favorite : home;
      /* the two chances always add to 100: the underdog's is 100 minus the
         favourite's PRINTED figure (rounding each side alone printed 51% / 50%) */
      var favPct = CALC ? CALC.round(100 * favP, 0) : Math.round(100 * favP);
      d.win = favT + ' ' + favPct + '%';
      d.dog_win = (favT === home ? away : home) + ' ' + (100 - favPct) + '%';
    }
    if (proj && isNum(proj.home) && isNum(proj.away)) {
      /* the scores come from EDCalc.projectedScores: they add to the total and
         differ by the margin exactly, at one decimal or, when both cannot be
         exact at one, two */
      var dp = proj.decimals === 2 ? 2 : 1, fx = function (v) { return (+v).toFixed(dp); };
      var hi = homeLine == null ? proj.home >= proj.away : homeLine <= 0;
      d.score = (hi ? home + ' ' + fx(proj.home) + ', ' + away + ' ' + fx(proj.away) : away + ' ' + fx(proj.away) + ', ' + home + ' ' + fx(proj.home));
    }
    return d;
  }

  var BOOKS = { draftkings: 'DraftKings', fanduel: 'FanDuel', betmgm: 'BetMGM', caesars: 'Caesars', 'cfbd consensus': 'CollegeFootballData consensus',
    espnbet: 'ESPN BET', bovada: 'Bovada', pinnacle: 'Pinnacle', betrivers: 'BetRivers', fanatics: 'Fanatics', 'hard rock bet': 'Hard Rock Bet' };
  function bookName(b) { if (!b) return null; var k = String(b).toLowerCase(); return BOOKS[k] || b; }
  function marketDisplay(m) {
    if (!m || m.status === 'none' || !isNum(m.home_line)) return null;
    var f = favOf(m.home, m.away, m.home_line);
    var line = f && f.favorite ? f.favorite + ' -' + lineNum(f.margin) : 'pick’em';
    var where = m.status === 'reference'
      ? 'consensus line from public schedule data, no sportsbook or capture time'
      : (m.book ? bookName(m.book) + ', ' : '') + 'captured ' + m.captured_text;
    return line + ' (' + where + ')';
  }

  function cfbPacket(g, rk, now, links) {
    var e = g.edgedesk || {}, m = g.market || {}, gm = g.game || {};
    var home = gm.home, away = gm.away;
    var kick = ts(g.kickoff), kt = kickoffTruth(g);
    var model = { available: !!(e.available && isNum(e.fair_home_line)) };
    if (model.available) {
      var f = favOf(home, away, r1(e.fair_home_line));
      model.version = e.model_version || null;
      model.as_of = e.prediction_ts || null;
      model.home_line = r1(e.fair_home_line);
      model.favorite = f.favorite; model.underdog = f.underdog; model.margin = f.margin;
      model.home_win_prob = isNum(e.home_win_prob) ? Math.round(e.home_win_prob * 1000) / 1000 : null;
      model.fav_win_pct = isNum(e.home_win_prob) ? (CALC ? CALC.round : function (x) { return Math.round(x); })((f.favorite === away ? 1 - e.home_win_prob : e.home_win_prob) * 100, 0) : null;
      model.dog_win_pct = model.fav_win_pct == null ? null : 100 - model.fav_win_pct;
      model.fair_total = isNum(e.fair_total) ? r1(e.fair_total) : null;
      /* scores derived from the margin and total the article prints (EDCalc) */
      var psc = CALC && isNum(e.fair_total) ? CALC.projectedScores({ home: home, away: away, home_margin: -model.home_line, total: r1(e.fair_total) }) : null;
      model.projected = psc && psc.available ? { home: psc.home, away: psc.away, decimals: psc.decimals }
        : (e.projected_score && isNum(e.projected_score.home) ? { home: r1(e.projected_score.home), away: r1(e.projected_score.away) } : null);
      var fc = e.football_confidence;
      model.confidence = fc && isNum(fc.score) ? { score: Math.round(fc.score), label: fc.label || fc.tier || null } : null;
      model.reliability = g.data_quality && isNum(g.data_quality.reliability) ? Math.round(g.data_quality.reliability) : null;
    }
    /* the market: the freshest quote on file, judged against NOW, not the build */
    var best = null;
    (m.quotes || []).forEach(function (q) {
      var t = ts(q.observed_at); if (t == null || !isNum(q.home_line)) return;
      if (!best || t > best.t) best = { t: t, q: q };
    });
    var market = { status: 'none', home: home, away: away };
    if (best) {
      var st = marketState(best.t, now);
      market = {
        status: st.status, home: home, away: away, home_line: r1(best.q.home_line), book: best.q.book || null,
        captured_at: iso(best.t), captured_text: whenText(best.t), age_minutes: st.age_minutes,
        source_label: best.q.source || null
      };
    }
    var rH = rk.by_name[home] || null, rA = rk.by_name[away] || null;
    var drivers = ((g.why && g.why.rows) || []).filter(function (w) { return w && w.available !== false && isNum(w.points) && Math.abs(w.points) >= 0.5; })
      .sort(function (a, b) { return Math.abs(b.points) - Math.abs(a.points); }).slice(0, 3)
      .map(function (w) { return { label: w.label, team: w.favors, points: r1(Math.abs(w.points)) }; });
    var matchup = (((g.matchup && g.matchup.cards) || []).filter(function (c) { return c && c.favors && (c.magnitude === 'large' || c.magnitude === 'moderate'); })
      .slice(0, 2).map(function (c) { return { label: c.label, favors: c.favors, magnitude: c.magnitude }; }));
    function qbOf(q) {
      if (!q || !q.player) return null;
      return { player: q.player, confirmed: !!q.confirmed, contested: !!q.contested, label: q.label || null, status: q.status || null, source: q.source || null, as_of: q.as_of || null };
    }
    var qb = { home: qbOf(g.qb && g.qb.home), away: qbOf(g.qb && g.qb.away) };
    /* AVAILABILITY TRUTH (lib/edgedesk_availability.js): an unannounced starter
       who started last time is an EXPECTED STARTER, not an uncertainty; a
       dropback split is a measured fact, not a reported competition */
    var availability = AVAIL ? { home: AVAIL.classify(AVAIL.fromTerminal(home, g.qb && g.qb.home), { kickoff: g.kickoff, now: now }),
      away: AVAIL.classify(AVAIL.fromTerminal(away, g.qb && g.qb.away), { kickoff: g.kickoff, now: now }) } : null;
    var flags = [];
    if (market.status === 'none') flags.push('NO_MARKET');
    if (market.status === 'stale') flags.push('STALE_MARKET');
    if (availability && ((availability.home && availability.home.may_assert_uncertainty) || (availability.away && availability.away.may_assert_uncertainty))) flags.push('QB_UNCERTAIN');
    if (availability && ((availability.home && availability.home.measured_note) || (availability.away && availability.away.measured_note))) flags.push('QB_USAGE_SPLIT');
    if (!kt.verified) flags.push('KICKOFF_TBA');
    if (model.confidence && model.confidence.score < MIN_CONFIDENCE) flags.push('LOW_CONFIDENCE');
    if (!model.available) flags.push('NO_PROJECTION');
    /* AUDIT 2026-10-08 (docs/system-integrity/AUDIT.md §7): this read
       verification === 'FAILED', a value the terminal never writes (it writes
       VERIFIED, UNVERIFIED, NOT_RUN, DATA_FAULT, MARKET_FAULT, NOT_REQUIRED), so
       every unverified 7+ gap was treated as verified. A gap is VERIFIED only
       when the integrity gate said so; anything else at 7+ is not. */
    var verification = g.disagreement && g.disagreement.verification ? g.disagreement.verification : null;
    var verified = verification === 'VERIFIED';
    if (verification && verification !== 'VERIFIED' && verification !== 'NOT_REQUIRED') flags.push('VERIFICATION_FAILED');
    if (kick != null && kt.verified && kick <= now) flags.push('KICKED_OFF');
    var gap = market.status !== 'none' && model.available ? gapOf(home, away, model.home_line, market.home_line) : null;
    var mfav = market.status !== 'none' ? favOf(home, away, market.home_line) : null;
    var p = {
      league: 'cfb', game_id: String(g.game_id), season: g.season, week: g.week,
      kickoff: g.kickoff, kickoff_text: kt.text, kickoff_state: kt.state, kickoff_verified: kt.verified, kickoff_basis: kt.basis,
      kickoff_tbd: g.kickoff_tbd == null ? null : g.kickoff_tbd, week_scope: g.week_scope || null, verified: verified,
      availability: availability, regime_flags: (g.research_status && g.research_status.flags) || [],
      home: home, away: away, venue: gm.venue || null, neutral_site: !!gm.neutral_site,
      home_conference: gm.home_conference || null, away_conference: gm.away_conference || null,
      conference_game: gm.matchup_type === 'conference', fcs: !!gm.fcs,
      home_rank: rH ? rH.rank : null, away_rank: rA ? rA.rank : null,
      home_rank_from: rH ? rH.rank_from : null, away_rank_from: rA ? rA.rank_from : null,
      model: model, market: market, gap: gap,
      favorite_flip: !!(mfav && mfav.favorite && model.favorite && mfav.favorite !== model.favorite),
      drivers: drivers, matchup: matchup, qb: qb,
      risks: ((g.risks && g.risks.items) || []).map(function (r) { return r.text; }).filter(Boolean).slice(0, 3),
      unpriced: ((g.why && g.why.unpriced) || []).slice(0, 4),
      research_status: g.research_status ? { key: g.research_status.key, label: g.research_status.label } : null,
      decision: g.decision_status ? { key: g.decision_status.key, label: g.decision_status.label, reason: g.decision_status.reason || null } : null,
      price_note: g.summary && g.summary.price ? g.summary.price : null,
      verification: verification,
      flags: flags,
      link: links && links[String(g.game_id)] || null
    };
    p.display = modelDisplay(home, away, model.home_line, model.home_win_prob, model.projected);
    p.display.kickoff = p.kickoff_text;
    p.display.market = marketDisplay(market);
    p.display.gap = gap ? gap.text : null;
    if (model.fair_total != null) p.display.total = oneDp(model.fair_total);
    return p;
  }

  function nflRecord(results) {
    var w = 0, l = 0, t = 0;
    (results || []).forEach(function (r) { if (r.result === 'W') w++; else if (r.result === 'L') l++; else if (r.result === 'T') t++; });
    return (w + l + t) ? w + '-' + l + (t ? '-' + t : '') : null;
  }

  function nflPacket(g, slate, inj, quotes, now, links) {
    var home = g.home_team, away = g.away_team, kick = ts(g.kickoff), kt = kickoffTruth(g);
    var model = { available: g.model_status === 'PREDICTED' && isNum(g.model_home_line) };
    if (model.available) {
      var f = favOf(home, away, r1(g.model_home_line));
      model.version = g.model_version || null;
      model.as_of = slate.generated_at || null;
      model.home_line = r1(g.model_home_line);
      model.favorite = f.favorite; model.underdog = f.underdog; model.margin = f.margin;
      model.home_win_prob = isNum(g.model_home_win_prob) ? Math.round(g.model_home_win_prob * 1000) / 1000 : null;
      model.fav_win_pct = isNum(g.model_home_win_prob) ? Math.round((f.favorite === away ? 1 - g.model_home_win_prob : g.model_home_win_prob) * 100) : null;
      model.dog_win_pct = model.fav_win_pct == null ? null : 100 - model.fav_win_pct;
      model.fair_total = isNum(g.model_fair_total) ? r1(g.model_fair_total) : null;
      model.projected = null;
      /* the NFL model publishes no confidence score, by design */
      model.confidence = null;
      model.confidence_note = 'The NFL model publishes no confidence score; its record is graded against the closing line instead.';
      model.data_quality = g.data_quality && g.data_quality.status || null;
    }
    /* market: a captured sportsbook quote if one is on file, else the
       reference consensus (no book, no capture time) */
    var q = quotes && quotes[g.game_id];
    var market = { status: 'none', home: home, away: away };
    if (q && q.spread && isNum(q.spread.point)) {
      var t = ts(q.captured_at || q.spread.captured_at);
      var st = marketState(t, now);
      market = {
        status: st.status, home: home, away: away,
        home_line: r1(q.spread.side === 'home' ? q.spread.point : -q.spread.point),
        book: q.spread.book || null, captured_at: t == null ? null : iso(t), captured_text: t == null ? null : whenText(t),
        age_minutes: st.age_minutes, source_label: 'EdgeDesk odds capture'
      };
    } else if (g.reference_market && isNum(g.reference_market.home_line)) {
      market = {
        status: 'reference', home: home, away: away, home_line: r1(g.reference_market.home_line), book: null,
        captured_at: null, captured_text: null, age_minutes: null,
        source_label: 'nflverse schedule consensus (reference, not a price)', read_at: slate.generated_at || null
      };
    }
    var tH = slate.teams && slate.teams[g.home_code], tA = slate.teams && slate.teams[g.away_code];
    function injuriesOf(code, starterName) {
      var t = inj && inj.teams && inj.teams[code];
      if (!t || t.week !== g.week) return null;
      var players = (t.players || []);
      var out = players.filter(function (p) { return p.status === 'Out'; });
      var doubtful = players.filter(function (p) { return p.status === 'Doubtful'; });
      var qbs = players.filter(function (p) { return p.position === 'QB' && p.status; })
        .map(function (p) { return { name: p.name, status: p.status, injury: p.injury || null, starter: !!starterName && p.name === starterName }; });
      return { out_count: out.length, doubtful_count: doubtful.length, qbs: qbs, retrieved_at: inj.retrieved_at || null };
    }
    var hs = g.home_starter && g.home_starter.player_name, as = g.away_starter && g.away_starter.player_name;
    function scen(k) {
      var s = g.scenarios && g.scenarios[k];
      if (!s || !isNum(s.home_line)) return null;
      return { home_line: r1(s.home_line), home_win_prob: isNum(s.home_win_prob) ? Math.round(s.home_win_prob * 1000) / 1000 : null };
    }
    var flags = [];
    if (market.status === 'none') flags.push('NO_MARKET');
    if (market.status === 'stale') flags.push('STALE_MARKET');
    if (market.status === 'reference') flags.push('REFERENCE_LINE_ONLY');
    if (!model.available) flags.push('NO_PROJECTION');
    if (kick != null && kt.verified && kick <= now) flags.push('KICKED_OFF');
    if (!kt.verified) flags.push('KICKOFF_TBA');
    var gap = market.status !== 'none' && model.available ? gapOf(home, away, model.home_line, market.home_line) : null;
    var mfav = market.status !== 'none' ? favOf(home, away, market.home_line) : null;
    /* the NFL's availability is the official injury report: a listed starter on
       it is QUESTIONABLE / RULED OUT with the report as the source; a listed
       starter not on it is an EXPECTED STARTER (lib/edgedesk_availability.js) */
    function nflAvail(team, starter, injBlock) {
      if (!AVAIL) return null;
      var row = injBlock && (injBlock.qbs || []).filter(function (x) { return x.starter; })[0];
      if (row) return AVAIL.classify(AVAIL.fromInjuryReport(team, { name: row.name, status: row.status, injury: row.injury, report_date: injBlock.retrieved_at }, 'the official NFL injury report'), { kickoff: g.kickoff, now: now });
      return starter ? AVAIL.classify({ team: team, player: starter, previous_start: true, source: 'the schedule feed’s listed starter' }, { kickoff: g.kickoff, now: now }) : AVAIL.classify({ team: team }, {});
    }
    var p = {
      league: 'nfl', game_id: g.game_id, season: g.season, week: g.week,
      kickoff: g.kickoff, kickoff_text: kt.text, kickoff_state: kt.state, kickoff_verified: kt.verified, kickoff_basis: kt.basis,
      home: home, away: away, home_code: g.home_code, away_code: g.away_code, venue: g.venue || null,
      divisional: !!g.div_game, home_rest: isNum(g.home_rest) ? g.home_rest : null, away_rest: isNum(g.away_rest) ? g.away_rest : null,
      home_record: tH ? nflRecord(tH.results) : null, away_record: tA ? nflRecord(tA.results) : null,
      model: model, market: market, gap: gap,
      favorite_flip: !!(mfav && mfav.favorite && model.favorite && mfav.favorite !== model.favorite),
      qb: { home: hs ? { player: hs, confirmed: false, label: hs + ' is the listed starter in the schedule feed.' } : null,
            away: as ? { player: as, confirmed: false, label: as + ' is the listed starter in the schedule feed.' } : null },
      injuries: { home: injuriesOf(g.home_code, hs), away: injuriesOf(g.away_code, as) },
      scenarios: { home_qb_out: scen('home_qb_out'), away_qb_out: scen('away_qb_out') },
      flags: flags,
      link: links && links[String(g.game_id)] || null
    };
    p.availability = { home: nflAvail(home, hs, p.injuries.home), away: nflAvail(away, as, p.injuries.away) };
    if ((p.availability.home && p.availability.home.may_assert_uncertainty) || (p.availability.away && p.availability.away.may_assert_uncertainty)) p.flags.push('QB_UNCERTAIN');
    p.display = modelDisplay(home, away, model.home_line, model.home_win_prob, null);
    p.display.kickoff = p.kickoff_text;
    p.display.market = marketDisplay(market);
    p.display.gap = gap ? gap.text : null;
    if (model.fair_total != null) p.display.total = oneDp(model.fair_total);
    return p;
  }

  /* art: { cfbGames, cfbBrief, rankings, nflSlate, nflInjuries, marketSnapshots: [..], published }
     opts: { now (ms), cfbWeek, nflWeek } */
  function fromArtifacts(art, opts) {
    opts = opts || {};
    art = art || {};
    var now = isNum(opts.now) ? opts.now : Date.now();
    var links = {};
    var pub = art.published && (art.published.articles || art.published);
    if (Array.isArray(pub)) pub.forEach(function (a) { if (a && a.type !== 'postgame' && a.game_id && a.url) links[String(a.game_id)] = a.url; });
    var rk = rankingsIndex(art.rankings);
    var snap = { schema: 'edgedesk_content_research_v1', version: VERSION, built_at: iso(now), sources: [], cfb: null, nfl: null };

    /* ── CFB ── */
    var cg = art.cfbGames;
    if (cg && cg.games) {
      var all = Object.keys(cg.games).map(function (k) { return cg.games[k]; });
      var week = isNum(opts.cfbWeek) ? opts.cfbWeek : (art.cfbBrief && isNum(art.cfbBrief.week) ? art.cfbBrief.week : chooseWeek(all, now));
      var tw = targetWeekOf(cg.season || (all[0] && all[0].season), week);
      var games = all.filter(function (g) { return g.week === week; })
        .map(function (g) { return attachIntegrity(cfbPacket(g, rk, now, links), 'CFB', now, tw); })
        .sort(function (a, b) { return (ts(a.kickoff) || 0) - (ts(b.kickoff) || 0); });
      var fresh = games.filter(function (p) { return p.market.status === 'current'; }).length;
      var brief = art.cfbBrief || {};
      var cfbNames = {};
      Object.keys(rk.by_name).forEach(function (n) { cfbNames[n] = 1; });
      all.forEach(function (g) { if (g.game) { cfbNames[g.game.home] = 1; cfbNames[g.game.away] = 1; } });
      snap.cfb = {
        season: cg.season || null, week: week, generated_at: cg.generated_at || null,
        team_names: Object.keys(cfbNames).filter(Boolean).sort(),
        betting_enabled: !!(cg.decision && cg.decision.bet_enabled),
        operations_status: cg.operations && cg.operations.status || null,
        certified_bets: brief.counts && isNum(brief.counts.BET) ? brief.counts.BET : null,
        games_total: games.length, fresh_markets: fresh,
        /* games this week's content may not use, each with the rule that withholds it */
        withheld: games.filter(function (p) { return !p.publishable; }).map(function (p) { return { game_id: p.game_id, matchup: p.away + ' at ' + p.home, blocking: p.integrity && p.integrity.public ? p.integrity.public.blocking : [] }; }),
        typical_games_played: medianGamesPlayed(all.filter(function (g) { return g.week === week; })),
        rankings: { as_of: rk.as_of, week: rk.week, top: topTeams(rk, 25), conference_top: rk.conference_top },
        games: games
      };
      snap.sources.push({ id: 'cfb_terminal', path: ARTIFACTS.cfb_games, as_of: cg.generated_at || null, what: 'CFB projections, captured quotes, research and decision status' });
      if (art.rankings) snap.sources.push({ id: 'rankings', path: ARTIFACTS.rankings, as_of: rk.as_of, what: 'EdgeDesk team ratings and ranks' });
    }

    /* ── NFL ── */
    var ns = art.nflSlate;
    if (ns && Array.isArray(ns.games)) {
      var nweek = isNum(opts.nflWeek) ? opts.nflWeek : chooseWeek(ns.games, now);
      var quotes = {};
      (art.marketSnapshots || []).forEach(function (s) {
        (s && s.quotes || []).forEach(function (q) { if (q && q.sport === 'NFL' && q.game_id) quotes[q.game_id] = q; });
      });
      var ntw = targetWeekOf(ns.season, nweek);
      var ngames = ns.games.filter(function (g) { return g.week === nweek; })
        .map(function (g) { return attachIntegrity(nflPacket(g, ns, art.nflInjuries, quotes, now, links), 'NFL', now, ntw); })
        .sort(function (a, b) { return (ts(a.kickoff) || 0) - (ts(b.kickoff) || 0); });
      var nflNamesAll = {};
      ns.games.forEach(function (g) { nflNamesAll[g.home_team] = 1; nflNamesAll[g.away_team] = 1; });
      snap.nfl = {
        season: ns.season || null, week: nweek, generated_at: ns.generated_at || null,
        team_names: Object.keys(nflNamesAll).filter(Boolean).sort(),
        injuries_as_of: art.nflInjuries && art.nflInjuries.retrieved_at || null,
        games_total: ngames.length,
        fresh_markets: ngames.filter(function (p) { return p.market.status === 'current'; }).length,
        withheld: ngames.filter(function (p) { return !p.publishable; }).map(function (p) { return { game_id: p.game_id, matchup: p.away + ' at ' + p.home, blocking: p.integrity && p.integrity.public ? p.integrity.public.blocking : [] }; }),
        games: ngames
      };
      snap.sources.push({ id: 'nfl_slate', path: ARTIFACTS.nfl_slate, as_of: ns.generated_at || null, what: 'NFL projections and reference lines' });
      if (art.nflInjuries) snap.sources.push({ id: 'nfl_injuries', path: ARTIFACTS.nfl_injuries, as_of: art.nflInjuries.retrieved_at || null, what: 'Official NFL injury report (nflverse)' });
    }
    /* the live-forward record (never a backtest) for the performance review */
    var PF = art.performance && art.performance.live_forward;
    if (PF && PF.overall) snap.performance = { kind: PF.kind, source: PF.source, generated_at: art.performance.generated_at || null,
      overall: PF.overall, by_gap: PF.by_gap_at_close || null, by_reliability: PF.by_reliability || null, look_ahead_guard: PF.look_ahead_guard || null };
    return snap;
  }

  /* THE RESEARCH RECORD a packet is written from (lib/edgedesk_integrity.js):
     the exact numbers the article prints — the fair line, the named book quote
     and its capture time, the gap between them — so the integrity engine checks
     what a reader will see, not a different snapshot */
  function packetRecord(p, sport) {
    if (!INTEG) return null;
    var m = p.model || {}, k = p.market || {};
    return INTEG.record({
      game: { game_id: p.game_id, sport: sport, season: p.season, week: p.week, home: p.home, away: p.away,
        home_conference: p.home_conference || null, away_conference: p.away_conference || null,
        neutral_site: p.neutral_site, venue: p.venue || null, kickoff: p.kickoff, kickoff_state: p.kickoff_state || null,
        start_time_tbd: p.kickoff_tbd == null ? undefined : p.kickoff_tbd },
      model: { available: !!m.available, version: m.version || null, snapshot_id: m.version && m.as_of ? m.version + '@' + m.as_of : null, projected_at: m.as_of || null,
        home_margin: m.available ? -m.home_line : null, total: m.fair_total, home_win_prob: m.home_win_prob,
        away_win_prob: isNum(m.home_win_prob) ? 1 - m.home_win_prob : null,
        projected_score: m.projected ? { home: m.projected.home, away: m.projected.away } : null,
        confidence: m.confidence ? m.confidence.score : null, reliability: isNum(m.reliability) ? m.reliability : null,
        /* the NFL model publishes no reliability score: say so, never assume one */
        reliability_published: sport !== 'NFL' || isNum(m.reliability) },
      market: { available: k.status && k.status !== 'none', snapshot_id: k.captured_at ? (k.book || 'line') + '@' + k.captured_at : (k.status === 'reference' ? 'reference@' + (k.read_at || p.week) : null),
        captured_at: k.captured_at || null, market_type: 'spread', is_main_line: true, home_margin: isNum(k.home_line) ? -k.home_line : null,
        book: k.book || null, source: k.source_label || null, method: k.status === 'reference' ? 'REFERENCE' : null,
        stale: k.status !== 'current', reference: k.status === 'reference' },
      research: p.research_status ? { key: p.research_status.key, label: p.research_status.label, flags: p.regime_flags || [] } : null,
      decision: p.decision || null,
      displayed: { gap: p.gap ? p.gap.points : null, market_claim: k.status === 'current' ? 'current' : null },
      provenance: []
    });
  }
  function summarize(ev) {
    return { status: ev.status, ok: ev.ok,
      blocking: ev.blocking.map(function (c) { return { rule_id: c.rule_id, explanation: c.explanation }; }),
      warnings: ev.warnings.map(function (c) { return c.rule_id; }) };
  }
  function attachIntegrity(p, sport, now, target) {
    var rec = packetRecord(p, sport);
    if (!rec) { p.integrity = { status: 'BLOCKED', ok: false, missing: true, blocking: [{ rule_id: 'INTEGRITY.ENGINE', explanation: 'the integrity engine did not load' }] }; p.publishable = false; return p; }
    var ctx = { now: now, target_week: target };
    var pub = INTEG.evaluate(rec, 'PUBLIC_BRIEF', ctx), ai = INTEG.evaluate(rec, 'AI_CONTEXT', ctx);
    p.record_id = rec.record_id;
    p.integrity = { version: INTEG.VERSION, record_id: rec.record_id, public: summarize(pub), ai: summarize(ai) };
    p.publishable = pub.ok;
    return p;
  }
  function targetWeekOf(season, week, seasonType) {
    if (!SCHED || !isNum(week)) return null;
    var g = { season: season, week: week, season_type: seasonType || null };
    return { key: SCHED.weekKey(g), season: season, week: week };
  }

  /* the week whose games are still to come: the schedule's own week, the
     earliest one that still has an unstarted game inside its own schedule
     cluster (lib/edgedesk_schedule.js currentWeek), so one rescheduled game
     cannot pin the article to an old week */
  function chooseWeek(games, now) {
    if (SCHED) {
      var cw = SCHED.currentWeek((games || []).map(function (g) { return { season: g.season || 0, week: g.week, season_type: g.season_type || null,
        kickoff: g.kickoff, kickoff_state: g.kickoff_state || null, start_time_tbd: g.kickoff_tbd == null ? undefined : g.kickoff_tbd }; }), now);
      if (cw) return cw.week;
    }
    var best = null;
    games.forEach(function (g) {
      var t = ts(g.kickoff); if (t == null || t <= now || !isNum(g.week)) return;
      if (best == null || g.week < best) best = g.week;
    });
    return best;
  }
  function medianGamesPlayed(games) {
    var v = games.map(function (g) { return g.games_played && isNum(g.games_played.min) ? g.games_played.min : null; })
      .filter(isNum).sort(function (a, b) { return a - b; });
    return v.length ? v[Math.floor(v.length / 2)] : null;
  }
  function topTeams(rk, n) {
    return Object.keys(rk.teams).map(function (k) { return rk.teams[k]; })
      .filter(function (t) { return isNum(t.rank) && t.rank <= n; })
      .sort(function (a, b) { return a.rank - b.rank; })
      .map(function (t) { return { team: t.team, rank: t.rank, rating: t.rating, conference: t.conference, rank_from: t.rank_from }; });
  }

  /* ======================================================================
     NEWS — public RSS headlines, attributed, never article bodies
     ====================================================================== */
  /* Feeds the publishers offer for exactly this use. Only the headline, the
     link, the time and the feed's own short description are kept. Nothing is
     fetched beyond the feed URL itself. */
  var FEEDS = [
    { id: 'espn_nfl', league: 'nfl', publisher: 'ESPN', url: 'https://www.espn.com/espn/rss/nfl/news' },
    { id: 'espn_cfb', league: 'cfb', publisher: 'ESPN', url: 'https://www.espn.com/espn/rss/ncf/news' },
    { id: 'cbs_nfl', league: 'nfl', publisher: 'CBS Sports', url: 'https://www.cbssports.com/rss/headlines/nfl/' },
    { id: 'cbs_cfb', league: 'cfb', publisher: 'CBS Sports', url: 'https://www.cbssports.com/rss/headlines/college-football/' },
    { id: 'yahoo_nfl', league: 'nfl', publisher: 'Yahoo Sports', url: 'https://sports.yahoo.com/nfl/rss/' },
    { id: 'yahoo_cfb', league: 'cfb', publisher: 'Yahoo Sports', url: 'https://sports.yahoo.com/college-football/rss/' }
  ];

  function decodeEntities(s) {
    return String(s || '')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/<[^>]+>/g, ' ')   /* markup that arrived entity-encoded is still markup */
      .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(+n); })
      .replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCharCode(parseInt(n, 16)); })
      .replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&#39;/g, '\'').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ').trim();
  }
  function tag(block, name) {
    var m = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i').exec(block);
    return m ? m[1] : null;
  }
  function parseFeed(xml, feed, retrievedAt) {
    var items = [];
    var re = /<item[\s>][\s\S]*?<\/item>/gi, m;
    while ((m = re.exec(String(xml || ''))) && items.length < 60) {
      var b = m[0];
      var title = decodeEntities(tag(b, 'title'));
      var link = decodeEntities(tag(b, 'link') || tag(b, 'guid'));
      var pub = ts(decodeEntities(tag(b, 'pubDate') || tag(b, 'dc:date') || ''));
      if (!title || !/^https:\/\//.test(link)) continue;
      items.push({
        title: title.slice(0, 240), url: link.slice(0, 500),
        published_at: pub == null ? null : iso(pub),
        summary: decodeEntities(tag(b, 'description') || '').slice(0, 400) || null,
        publisher: feed && feed.publisher || null, feed: feed && feed.id || null, league: feed && feed.league || null,
        retrieved_at: retrievedAt || null
      });
    }
    return items;
  }

  /* [keyword, headline words] per kind of news */
  var NEWS_WORDS = { injury: ['injury', 'Injury Update'], qb_change: ['quarterback', 'Quarterback News'], trade: ['trade', 'Trade News'],
    coaching: ['coach', 'Coaching News'], ranking: ['ranking', 'Rankings News'], suspension: ['suspension', 'Suspension News'], general: ['news', 'News'] };
  var NEWS_KINDS = [
    ['injury', /\b(injur(?:y|ed|ies)|out for|ruled out|torn|acl|sprain|concussion|questionable|doubtful|ir\b|injured reserve|surgery)\b/i],
    ['qb_change', /\b(quarterback|qb|starter|starting|benched|bench)\b/i],
    ['trade', /\b(trade[sd]?|trading|acquir(?:e|es|ed)|deal for)\b/i],
    ['coaching', /\b(fire[sd]|hire[sd]?|coach(?:ing)? (?:search|change)|interim|coordinator|resign)/i],
    ['ranking', /\b(poll|rankings?|top 25|ap top|cfp|playoff)\b/i],
    ['suspension', /\b(suspend(?:ed|s)?|suspension|arrest(?:ed)?)\b/i]
  ];
  function classifyNews(title) {
    for (var i = 0; i < NEWS_KINDS.length; i++) if (NEWS_KINDS[i][1].test(title)) return NEWS_KINDS[i][0];
    return 'general';
  }

  /* NFL nicknames → full names, built from the slate itself */
  function nflNames(snap) {
    var out = {};
    ((snap.nfl && snap.nfl.games) || []).forEach(function (g) {
      [g.home, g.away].forEach(function (full) {
        out[full] = full;
        var nick = full.split(' ').slice(-1)[0];
        if (nick && nick.length > 3) out[nick] = full;
      });
    });
    return out;
  }
  /* Match each headline to the teams it names on this week's slate. A
     headline naming no slate team is dropped: the engine writes about what
     its research covers. */
  function matchNews(items, snap) {
    var nfl = nflNames(snap);
    var cfbTeams = {};
    ((snap.cfb && snap.cfb.games) || []).forEach(function (g) { cfbTeams[g.home] = 1; cfbTeams[g.away] = 1; });
    var out = [];
    (items || []).forEach(function (it) {
      var text = it.title + ' ' + (it.summary || '');
      var names = it.league === 'nfl' ? Object.keys(nfl) : Object.keys(cfbTeams);
      names.sort(function (a, b) { return b.length - a.length; });
      var found = [], rest = text;
      names.forEach(function (n) {
        var re = new RegExp('(^|[^A-Za-z])' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z])');
        if (re.test(rest)) { found.push(it.league === 'nfl' ? nfl[n] : n); rest = rest.replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), ' '); }
      });
      found = uniq(found);
      if (!found.length) return;
      out.push(Object.assign({}, it, { teams: found, kind: classifyNews(it.title) }));
    });
    return out;
  }

  /* ======================================================================
     DISCOVER — opportunities, scored, each part with its basis
     ====================================================================== */
  function hoursUntil(t, now) { return t == null ? null : (t - now) / 3600000; }
  function timelinessScore(firstKick, now) {
    var h = hoursUntil(firstKick, now);
    if (h == null) return { score: 0, basis: 'no kickoff time on file' };
    if (h <= 0) return { score: 5, basis: 'the first game has already kicked off' };
    var s = h < 6 ? 55 : h <= 120 ? 100 - Math.max(0, h - 48) / 2 : clamp(100 - (h - 120) / 2, 20, 70);
    return { score: Math.round(clamp(s, 0, 100)), basis: 'first relevant kickoff in ' + Math.round(h) + ' hours (best 6–48 h before)' };
  }
  function interestCfb(p) {
    var s = 0, why = [];
    var top = function (r) { return isNum(r) && r <= 25; };
    if (top(p.home_rank) && top(p.away_rank)) { s += 45; why.push('two top-25 teams'); }
    else if (top(p.home_rank) || top(p.away_rank)) { s += 22; why.push('a top-25 team'); }
    if ((isNum(p.home_rank) && p.home_rank <= 10) || (isNum(p.away_rank) && p.away_rank <= 10)) { s += 10; why.push('a top-10 team'); }
    if (p.model.available && isNum(p.model.fav_win_pct)) {
      var close = 1 - Math.abs(p.model.fav_win_pct - 50) / 50;
      s += 25 * close; if (close > 0.6) why.push('a close projection');
    }
    if (p.conference_game && POWER4.indexOf(p.home_conference) >= 0) { s += 8; why.push('a power-conference game'); }
    if (p.favorite_flip) { s += 6; why.push('model and market disagree on the favorite'); }
    if (p.fcs) s -= 25;
    if (p.flags.indexOf('LOW_CONFIDENCE') >= 0 || !p.model.available) s -= 40;
    if (p.flags.indexOf('KICKED_OFF') >= 0) s -= 100;
    return { score: Math.round(s), why: why };
  }
  function interestNfl(p) {
    var s = 0, why = [];
    var t = ts(p.kickoff), et = t == null ? null : etParts(t);
    var prime = et && (et.weekday === 'Thu' || et.weekday === 'Mon' || (String(et.dayPeriod).toUpperCase() === 'PM' && +et.hour >= 8 && +et.hour < 12));
    if (prime) { s += 20; why.push('a prime-time game'); }
    if (p.model.available && isNum(p.model.fav_win_pct)) { var close = 1 - Math.abs(p.model.fav_win_pct - 50) / 50; s += 25 * close; if (close > 0.6) why.push('a close projection'); }
    var winning = function (rec) { if (!rec) return false; var a = rec.split('-'); return +a[0] > +a[1]; };
    if (winning(p.home_record) && winning(p.away_record)) { s += 15; why.push('two winning teams'); }
    else if (winning(p.home_record) || winning(p.away_record)) s += 7;
    if (p.divisional) { s += 8; why.push('a division game'); }
    if (p.gap && p.gap.points >= RESEARCH_GAP) { s += 6; why.push('model and line differ'); }
    if (!p.model.available) s -= 40;
    if (p.flags.indexOf('KICKED_OFF') >= 0) s -= 100;
    return { score: Math.round(s), why: why };
  }

  function rankGames(league, games) {
    var f = league === 'cfb' ? interestCfb : interestNfl;
    return games.map(function (p) { var i = f(p); return { p: p, interest: i.score, why: i.why }; })
      .filter(function (x) { return x.interest > -50; })
      .sort(function (a, b) { return b.interest - a.interest; });
  }

  function upsetsOf(league, games) {
    return games.filter(function (p) {
      if (!p.model.available || p.flags.indexOf('KICKED_OFF') >= 0 || !isNum(p.model.dog_win_pct)) return false;
      var flip = p.favorite_flip && p.market && p.market.status !== 'none';
      if (p.model.dog_win_pct < 30 || p.model.dog_win_pct >= 50) return false;
      if (p.model.dog_win_pct > 46 && !flip) return false;   /* a coin flip is not an upset */
      if (league === 'cfb') {
        var favRank = p.model.favorite === p.home ? p.home_rank : p.away_rank;
        return (isNum(favRank) && favRank <= 25) || flip;
      }
      /* NFL: the favorite must be a real favorite (3+ points) */
      return p.model.margin >= 3 || flip;
    }).sort(function (a, b) { return b.model.dog_win_pct - a.model.dog_win_pct; });
  }

  function conferenceRaces(snap) {
    var c = snap.cfb; if (!c) return [];
    var out = [];
    c.games.forEach(function (p) {
      if (!p.conference_game || !p.home_conference || p.flags.indexOf('KICKED_OFF') >= 0 || !p.model.available) return;
      var top = c.rankings.conference_top[p.home_conference] || [];
      if (top.indexOf(p.home) >= 0 && top.indexOf(p.away) >= 0) out.push(p);
    });
    return out;
  }

  function avgConfidence(games) {
    var v = games.map(function (p) { return p.model.confidence ? p.model.confidence.score : null; }).filter(isNum);
    return v.length ? Math.round(v.reduce(function (a, b) { return a + b; }, 0) / v.length) : null;
  }

  /* publisher fit: does the profile want this sport, this category, this breadth? */
  function publisherFit(publisher, league, kind, breadth) {
    if (!publisher) return { score: 60, basis: 'no publisher selected: neutral fit' };
    var ed = publisher.editorial || {};
    var s = 40, why = [];
    var sports = (ed.preferred_sports || []).map(function (x) { return String(x).toLowerCase(); });
    if (!sports.length || sports.indexOf(league) >= 0) { s += 25; why.push(league.toUpperCase() + ' is a preferred sport'); }
    else why.push(league.toUpperCase() + ' is not in the preferred sports');
    var cats = ed.categories || [];
    if (!cats.length || cats.indexOf(kind) >= 0) { s += 20; why.push(KINDS[kind] + ' is a wanted category'); }
    if (ed.prefer_broad && breadth === 'broad') { s += 15; why.push('broad, searchable topic (preferred over single matchups)'); }
    if (ed.prefer_broad && breadth === 'narrow') { s -= 15; why.push('a single-matchup topic, which this publisher has found draws less interest'); }
    return { score: clamp(Math.round(s), 0, 100), basis: why.join('; ') };
  }

  /* search demand: measured only if Search Console rows match; else an estimate */
  function demandFor(keyword, kind, gsc) {
    var rows = (gsc && gsc[keyword]) || null;
    if (rows && isNum(rows.impressions) && rows.impressions > 0) {
      return {
        basis: 'search_console', measured: true,
        note: 'EdgeDesk’s own Search Console: ' + rows.impressions + ' impressions and ' + (rows.clicks || 0) + ' clicks over ' + (rows.days || 28)
          + ' days for queries containing “' + keyword + '”. This is EdgeDesk’s own search exposure, not total search volume.',
        evidence: rows
      };
    }
    var est = { weekly_preview: 'high', upset_watch: 'medium', conference_race: 'medium', market_discrepancy: 'low', injury_impact: 'medium', trending_story: 'medium' }[kind] || 'medium';
    return {
      basis: 'estimate', measured: false, level: est,
      note: 'ESTIMATE, not measured search volume: “' + keyword + '” follows a query pattern that recurs every week of the season. '
        + 'No keyword-volume data source is connected; connect Search Console data to replace this with EdgeDesk’s own measured impressions.'
    };
  }

  function score(parts) {
    var total = 0;
    Object.keys(SCORE_WEIGHTS).forEach(function (k) { total += SCORE_WEIGHTS[k] * ((parts[k] && parts[k].score) || 0); });
    return Math.round(total);
  }

  /* the formats an opportunity can honestly fill: a weekly slate is not a
     news story, and one game is not a slate */
  function formatsFor(o) {
    var R = o.research || {};
    if (o.kind === 'trending_story' || o.kind === 'injury_impact') return ['trending_story', 'publisher_custom'];
    if (o.kind === 'market_discrepancy' && (R.games || []).length === 1) return ['market_discrepancy', 'game_deep_dive', 'publisher_custom'];
    if (o.kind === 'game_deep_dive') return ['game_deep_dive', 'publisher_custom'];
    if (o.kind === 'model_performance') return ['model_performance_review'];
    if (o.kind === 'weekend_storylines') return ['weekend_storylines', 'publisher_custom'];
    if (o.kind === 'upset_watch') return [o.league + '_weekly_preview', 'upset_watch', 'publisher_custom'];
    if (o.kind === 'conference_race') return ['cfb_weekly_preview', 'conference_race', 'publisher_custom'];
    return [o.league + '_weekly_preview', 'weekend_storylines', 'publisher_custom'];
  }
  function baseFormatOf(o, format) {
    var f = formatsFor(o);
    if (f.indexOf(format) < 0) format = f[0];
    return format === 'publisher_custom' ? f[0] : format;
  }

  function mkOpp(o) {
    o.formats = formatsFor(o);
    o.key = [o.league, o.season, 'w' + o.week, o.kind, o.slug_part || ''].join(':').replace(/:$/, '');
    o.priority = score(o.scores);
    o.scores.total = o.priority;
    delete o.slug_part;
    return o;
  }

  /* opts: { now, publisher, news: [items from matchNews], gsc: {keyword: {impressions, clicks, days}} } */
  function discover(snap, opts) {
    opts = opts || {};
    var now = isNum(opts.now) ? opts.now : Date.now();
    var pub = opts.publisher || null;
    var out = [];

    ['cfb', 'nfl'].forEach(function (league) {
      var L = snap[league]; if (!L || !L.games || !L.games.length) return;
      /* only games the integrity engine clears for publication (PUBLIC_BRIEF):
         a TBA kickoff, a look-ahead week, a clock fault or a faulted market
         keeps a game out of every article; L.withheld says why */
      var upcoming = L.games.filter(function (p) { return p.flags.indexOf('KICKED_OFF') < 0 && p.model.available && p.publishable !== false; });
      if (!upcoming.length) return;
      var ranked = rankGames(league, upcoming);
      var firstKick = Math.min.apply(null, upcoming.map(function (p) { return ts(p.kickoff) || Infinity; }));
      var lastKick = Math.max.apply(null, upcoming.map(function (p) { return ts(p.kickoff) || 0; }));
      var Lname = league === 'cfb' ? 'College Football' : 'NFL';
      var conf = avgConfidence(upcoming);
      var limitations = [];
      if (L.fresh_markets === 0) limitations.push('No game has a sportsbook price from the last three hours; market comparisons use older captured lines, labelled with their capture time.');
      else if (L.fresh_markets < upcoming.length / 2) limitations.push('Only ' + L.fresh_markets + ' of ' + L.games_total + ' games this week had a sportsbook price from the last three hours when this research was read.');
      if (league === 'cfb' && L.betting_enabled === false) limitations.push('EdgeDesk’s college decision engine is not certifying bets this week; nothing here is a betting card.');
      if (league === 'nfl') limitations.push('The NFL model publishes no confidence score; its lines are compared with captured or reference lines, each labelled.');

      /* 1 · weekly preview: one central storyline and its supporting games
         (storyScore), never the six biggest numbers */
      var SL = storyline(upcoming, league);
      var feature = SL ? [SL.central].concat(SL.supporting) : ranked.slice(0, 5).map(function (x) { return x.p; });
      var slc = SL ? { type: SL.type, central_id: SL.central.game_id, supporting_ids: SL.supporting.map(function (p) { return p.game_id; }), why: SL.why, ranked: SL.ranked.slice(0, 12),
        basis: storyScore(SL.central).basis } : null;
      var kw = (league === 'cfb' ? 'college football week ' : 'nfl week ') + L.week + ' predictions';
      var demand = demandFor(kw, 'weekly_preview', opts.gsc);
      var researchAvail = Math.round(100 * upcoming.length / Math.max(1, L.games_total));
      out.push(mkOpp({
        league: league, season: L.season, week: L.week, kind: 'weekly_preview',
        title: Lname + ' Week ' + L.week + ' Predictions',
        angle: 'A broad preview of the week’s biggest games: EdgeDesk’s projections, the closest calls and the realistic upsets, explained for fans.',
        summary: feature.length + ' featured games from ' + upcoming.length + ' projected; headliner ' + feature[0].away + ' at ' + feature[0].home + '.',
        teams: uniq([].concat.apply([], feature.map(function (p) { return [p.home, p.away]; }))),
        research: { league: league, season: L.season, week: L.week, as_of: L.generated_at, kind: 'weekly_preview', context: contextOf(snap, league), games: feature, storyline: slc, upsets: upsetsOf(league, upcoming).slice(0, 3), races: league === 'cfb' ? conferenceRaces(snap).slice(0, 3) : [], limitations: limitations },
        sources: sourcesOf(snap, league),
        demand: demand,
        formats: [league + '_weekly_preview', 'publisher_custom'],
        scores: {
          search_relevance: { score: demand.measured ? 95 : 85, basis: demand.measured ? 'measured Search Console exposure for the query' : 'estimate: “week N predictions” is a recurring high-intent query pattern' },
          timeliness: timelinessScore(firstKick, now),
          audience_interest: { score: clamp(50 + feature.reduce(function (a, p) { return a + storyScore(p).editorial_interest; }, 0) / 10, 0, 100) | 0, basis: 'featured games include ' + sentenceList(uniq([].concat.apply([], feature.map(function (p) { return storyScore(p).why; }))).slice(0, 4)) },
          research_availability: { score: researchAvail, basis: upcoming.length + ' of ' + L.games_total + ' games have a current EdgeDesk projection' },
          editorial_relevance: { score: 90, basis: 'projections for every featured game, explained as research rather than picks' },
          publisher_fit: publisherFit(pub, league, 'weekly_preview', 'broad'),
          research_confidence: { score: confidenceScore(conf, L, league), basis: confidenceBasis(conf, L, league) }
        },
        expires_at: iso(lastKick)
      }));

      /* 1b · biggest weekend storylines, and a deep dive on the central game */
      if (SL && SL.supporting.length >= 2) {
        var kwS = (league === 'cfb' ? 'college football week ' : 'nfl week ') + L.week + ' storylines';
        var dS = demandFor(kwS, 'weekly_preview', opts.gsc);
        out.push(mkOpp({
          league: league, season: L.season, week: L.week, kind: 'weekend_storylines',
          title: 'The Biggest ' + Lname + ' Storylines of Week ' + L.week,
          angle: 'The week’s few stories that matter most, chosen for their stakes and how firmly the numbers stand behind them — not for the biggest gap.',
          summary: 'Lead: ' + SL.central.away + ' at ' + SL.central.home + ' (' + SL.type.replace(/_/g, ' ') + '); ' + SL.supporting.length + ' supporting games.',
          teams: uniq([].concat.apply([], feature.map(function (p) { return [p.home, p.away]; }))),
          research: { league: league, season: L.season, week: L.week, as_of: L.generated_at, kind: 'weekend_storylines', context: contextOf(snap, league), games: feature, storyline: slc, upsets: [], races: [], limitations: limitations },
          sources: sourcesOf(snap, league), demand: dS,
          scores: {
            search_relevance: { score: dS.measured ? 85 : 70, basis: dS.measured ? 'measured Search Console exposure' : 'estimate: weekly “storylines” queries recur all season' },
            timeliness: timelinessScore(firstKick, now),
            audience_interest: { score: clamp(SL.central_score.editorial_interest + 10, 0, 100), basis: 'the lead game: ' + (sentenceList(SL.why) || 'the week’s top story score') },
            research_availability: { score: researchAvail, basis: upcoming.length + ' of ' + L.games_total + ' games cleared for publication' },
            editorial_relevance: { score: 92, basis: 'one central story with supporting games, not a list of summaries' },
            publisher_fit: publisherFit(pub, league, 'weekly_preview', 'broad'),
            research_confidence: { score: SL.central_score.research_reliability, basis: 'the lead game’s research reliability' }
          },
          expires_at: iso(lastKick)
        }));
      }
      if (SL && SL.central_score.editorial_interest >= 45 && SL.central_score.research_reliability >= 60) {
        var c0 = SL.central, kwD = slugify(c0.away + ' vs ' + c0.home).replace(/-/g, ' ') + ' prediction';
        var dD = demandFor(kwD, 'market_discrepancy', opts.gsc);
        out.push(mkOpp({
          league: league, season: L.season, week: L.week, kind: 'game_deep_dive', slug_part: String(c0.game_id),
          title: c0.away + ' vs. ' + c0.home + ' Prediction: Inside the Numbers',
          angle: 'The week’s central game, taken apart: what the model expects, what it is built on and what would change it.',
          summary: (c0.display.fair || 'Projection on file') + '; ' + (sentenceList(SL.why) || 'the week’s top story score') + '.',
          teams: [c0.home, c0.away],
          research: { league: league, season: L.season, week: L.week, as_of: L.generated_at, kind: 'game_deep_dive', context: contextOf(snap, league), games: [c0], upsets: [], races: [], limitations: limitations },
          sources: sourcesOf(snap, league), demand: dD,
          scores: {
            search_relevance: { score: dD.measured ? 80 : 55, basis: dD.measured ? 'measured Search Console exposure' : 'estimate: a marquee single-game query' },
            timeliness: timelinessScore(ts(c0.kickoff), now),
            audience_interest: { score: clamp(SL.central_score.editorial_interest + 15, 0, 100), basis: sentenceList(SL.why) || 'the week’s central game' },
            research_availability: { score: 90, basis: 'a full research packet for the game' },
            editorial_relevance: { score: 85, basis: 'explains the projection rather than summarising it' },
            publisher_fit: publisherFit(pub, league, 'weekly_preview', 'narrow'),
            research_confidence: { score: SL.central_score.research_reliability, basis: 'the game’s research reliability' }
          },
          expires_at: iso(ts(c0.kickoff))
        }));
      }

      /* 2 · upset watch */
      var ups = upsetsOf(league, upcoming);
      if (ups.length >= 2) {
        var kw2 = (league === 'cfb' ? 'college football week ' : 'nfl week ') + L.week + ' upset picks';
        kw2 = kw2.replace(' picks', ' predictions');
        var d2 = demandFor(kw2, 'upset_watch', opts.gsc);
        out.push(mkOpp({
          league: league, season: L.season, week: L.week, kind: 'upset_watch',
          title: Lname + ' Week ' + L.week + ' Upset Watch',
          angle: 'The underdogs EdgeDesk’s model gives a real chance — and why a likely loser is still not a bet.',
          summary: ups.length + ' underdogs with a 30%-plus projected chance; best: ' + ups[0].model.underdog + ' (' + ups[0].model.dog_win_pct + '%).',
          teams: uniq([].concat.apply([], ups.slice(0, 4).map(function (p) { return [p.home, p.away]; }))),
          research: { league: league, season: L.season, week: L.week, as_of: L.generated_at, kind: 'upset_watch', context: contextOf(snap, league), games: ups.slice(0, 4), upsets: ups.slice(0, 4), races: [], limitations: limitations },
          sources: sourcesOf(snap, league), demand: d2,
          formats: [league + '_weekly_preview', 'publisher_custom'],
          scores: {
            search_relevance: { score: d2.measured ? 85 : 72, basis: d2.measured ? 'measured Search Console exposure' : 'estimate: weekly “upsets” queries recur all season' },
            timeliness: timelinessScore(firstKick, now),
            audience_interest: { score: clamp(55 + Math.min(ups.length, 5) * 6, 0, 100), basis: ups.length + ' credible underdogs' + (league === 'cfb' ? ' against ranked favorites' : '') },
            research_availability: { score: 90, basis: 'every underdog has a model win probability' },
            editorial_relevance: { score: 85, basis: 'separates “could win” from “worth a bet”, which is the EdgeDesk distinction' },
            publisher_fit: publisherFit(pub, league, 'upset_watch', 'broad'),
            research_confidence: { score: confidenceScore(avgConfidence(ups), L, league), basis: confidenceBasis(avgConfidence(ups), L, league) }
          },
          expires_at: iso(lastKick)
        }));
      }

      /* 3 · conference races (CFB) */
      if (league === 'cfb') {
        var races = conferenceRaces(snap);
        var byConf = {};
        races.forEach(function (p) { (byConf[p.home_conference] = byConf[p.home_conference] || []).push(p); });
        Object.keys(byConf).forEach(function (cname) {
          var gs = byConf[cname];
          var kw3 = cname.toLowerCase() + ' championship race';
          var d3 = demandFor(kw3, 'conference_race', opts.gsc);
          var k0 = ts(gs[0].kickoff);
          out.push(mkOpp({
            league: league, season: L.season, week: L.week, kind: 'conference_race', slug_part: slugify(cname),
            title: cname + ' Championship Race: What Week ' + L.week + ' Could Decide',
            angle: 'Games between the conference’s highest-rated teams in EdgeDesk’s ratings, and what the projections say about the title race.',
            summary: gs.map(function (p) { return p.away + ' at ' + p.home; }).join('; '),
            teams: uniq([].concat.apply([], gs.map(function (p) { return [p.home, p.away]; }))),
            research: { league: league, season: L.season, week: L.week, as_of: L.generated_at, kind: 'conference_race', conference: cname, conference_top: L.rankings.conference_top[cname] || [], context: contextOf(snap, league), games: gs, upsets: [], races: gs, limitations: limitations },
            sources: sourcesOf(snap, league), demand: d3,
            formats: ['cfb_weekly_preview', 'publisher_custom'],
            scores: {
              search_relevance: { score: d3.measured ? 80 : 62, basis: d3.measured ? 'measured Search Console exposure' : 'estimate: conference-race queries peak in October and November' },
              timeliness: timelinessScore(k0, now),
              audience_interest: { score: clamp(50 + gs.length * 15, 0, 100), basis: gs.length + ' game(s) between top-three teams in the ' + cname },
              research_availability: { score: 85, basis: 'projections and EdgeDesk ratings for each team; no conference standings feed is connected' },
              editorial_relevance: { score: 75, basis: 'implications rather than predictions alone' },
              publisher_fit: publisherFit(pub, league, 'conference_race', 'broad'),
              research_confidence: { score: confidenceScore(avgConfidence(gs), L, league), basis: confidenceBasis(avgConfidence(gs), L, league) }
            },
            expires_at: iso(Math.max.apply(null, gs.map(function (p) { return ts(p.kickoff) || 0; })))
          }));
        });
      }

      /* 4 · market discrepancies: model vs market where a price exists */
      /* AUDIT 2026-10-08 §5 and docs/system-integrity/PERFORMANCE.md: the largest
         gaps are where the model has been least accurate (7+ pts at the close:
         MAE 15.4 vs the close's 10.4 live, 14.7 vs 12.4 in the backtest). A gap
         earns a public story only when research cleared it (WORTH RESEARCHING or
         VERIFIED MAJOR); an unverified 7+ gap is investigated internally
         (investigations()), never promoted. Ranked by the story score, not size. */
      var cleared = function (p) { var k = p.research_status && p.research_status.key; return league !== 'cfb' || k === 'WORTH_RESEARCHING' || k === 'VERIFIED_MAJOR'; };
      var gaps = upcoming.filter(function (p) { return p.gap && p.gap.points >= RESEARCH_GAP && p.market.status !== 'none' && cleared(p); })
        .sort(function (a, b) { var fa = a.market.status === 'current' ? 1 : 0, fb = b.market.status === 'current' ? 1 : 0; return fb - fa || storyScore(b).story - storyScore(a).story || b.gap.points - a.gap.points; });
      if (league === 'nfl' && gaps.length >= 3) {
        var kw4 = 'nfl week ' + L.week + ' predictions vs spread';
        var d4 = demandFor(kw4, 'market_discrepancy', opts.gsc);
        var anyCurrent = gaps.some(function (p) { return p.market.status === 'current'; });
        out.push(mkOpp({
          league: league, season: L.season, week: L.week, kind: 'market_discrepancy', slug_part: 'slate',
          title: 'NFL Week ' + L.week + ': Matchups Where the Numbers Tell a Different Story',
          angle: 'Where EdgeDesk’s projection and the betting line disagree by two points or more — and why a disagreement is a research question, not a bet.',
          summary: gaps.length + ' games with a gap of 2+ points; largest ' + gaps[0].away + ' at ' + gaps[0].home + ' (' + gaps[0].gap.text + ').',
          teams: uniq([].concat.apply([], gaps.slice(0, 5).map(function (p) { return [p.home, p.away]; }))),
          research: { league: league, season: L.season, week: L.week, as_of: L.generated_at, kind: 'market_discrepancy', context: contextOf(snap, league), games: gaps.slice(0, 5), upsets: [], races: [], limitations: limitations },
          sources: sourcesOf(snap, league), demand: d4,
          formats: ['nfl_weekly_preview', 'market_discrepancy', 'publisher_custom'],
          scores: {
            search_relevance: { score: d4.measured ? 80 : 70, basis: d4.measured ? 'measured Search Console exposure' : 'estimate: weekly spread-prediction queries recur all season' },
            timeliness: timelinessScore(firstKick, now),
            audience_interest: { score: clamp(50 + gaps.length * 6, 0, 100), basis: gaps.length + ' games where the numbers differ' },
            research_availability: { score: anyCurrent ? 85 : 55, basis: anyCurrent ? 'at least one current captured price' : 'only stale or reference lines: every comparison is labelled with its age' },
            editorial_relevance: { score: 85, basis: 'EdgeDesk’s independent number against the consensus is the brand’s core research' },
            publisher_fit: publisherFit(pub, league, 'market_discrepancy', 'broad'),
            research_confidence: { score: anyCurrent ? 60 : 40, basis: anyCurrent ? 'current prices on part of the slate' : 'no current price: the gaps describe a line that may have moved' }
          },
          expires_at: iso(lastKick)
        }));
      }
      gaps.filter(function (p) { return league === 'cfb' && p.market.status === 'current'; }).slice(0, 3).forEach(function (p) {
        var verified = p.verified === true;
        var kw5 = slugify(p.away + ' vs ' + p.home).replace(/-/g, ' ') + ' prediction';
        var d5 = demandFor(kw5, 'market_discrepancy', opts.gsc);
        out.push(mkOpp({
          league: league, season: L.season, week: L.week, kind: 'market_discrepancy', slug_part: String(p.game_id),
          title: p.away + ' vs. ' + p.home + ' Prediction: Model vs. Line',
          angle: verified ? 'An accessible explanation of a model-versus-market gap with a current price.'
            : 'A large gap EdgeDesk’s own integrity checks do not yet trust — and why missing information is the likelier explanation.',
          summary: 'Model ' + p.display.fair + ' vs. market ' + (p.display.market || '?') + ' — ' + p.gap.text + '.',
          teams: [p.home, p.away],
          research: { league: league, season: L.season, week: L.week, as_of: L.generated_at, kind: 'market_discrepancy', context: contextOf(snap, league), games: [p], upsets: [], races: [], limitations: limitations },
          sources: sourcesOf(snap, league), demand: d5,
          formats: ['market_discrepancy', 'publisher_custom'],
          scores: {
            search_relevance: { score: d5.measured ? 70 : 35, basis: d5.measured ? 'measured Search Console exposure' : 'estimate: a single-matchup query, narrower than a weekly preview' },
            timeliness: timelinessScore(ts(p.kickoff), now),
            audience_interest: { score: clamp(30 + Math.max(0, interestCfb(p).score) / 2, 0, 100) | 0, basis: 'single game' + (interestCfb(p).why.length ? ': ' + interestCfb(p).why.join(', ') : '') },
            research_availability: { score: 90, basis: 'current captured price and full research packet' },
            editorial_relevance: { score: verified ? 85 : 70, basis: verified ? 'a verified disagreement' : 'a disagreement that failed verification: honest, but explain it as unresolved' },
            publisher_fit: publisherFit(pub, league, 'market_discrepancy', 'narrow'),
            research_confidence: { score: verified ? 70 : 35, basis: verified ? 'gap passed the integrity checks' : 'gap failed EdgeDesk’s verification check' }
          },
          expires_at: iso(ts(p.kickoff))
        }));
      });

      /* 5 · injury implications (NFL): a listed starting QB on the report */
      if (league === 'nfl') {
        upcoming.forEach(function (p) {
          ['home', 'away'].forEach(function (side) {
            var inj = p.injuries && p.injuries[side];
            var q = inj && inj.qbs && inj.qbs.filter(function (x) { return x.starter && x.status !== 'Active'; })[0];
            var sc = p.scenarios && p.scenarios[side + '_qb_out'];
            if (!q || !sc) return;
            var team = side === 'home' ? p.home : p.away;
            var kw6 = (q.name + ' injury').toLowerCase();
            var d6 = demandFor(kw6, 'injury_impact', opts.gsc);
            out.push(mkOpp({
              league: league, season: L.season, week: L.week, kind: 'injury_impact', slug_part: slugify(q.name),
              title: q.name + ' Injury: What It Means for the ' + team,
              angle: 'What the official injury report says, and how EdgeDesk’s projection changes if the starter does not play.',
              summary: q.name + ' (' + q.status + (q.injury ? ', ' + q.injury : '') + ') — model scenario available.',
              teams: [p.home, p.away],
              research: { league: league, season: L.season, week: L.week, as_of: L.generated_at, kind: 'injury_impact', focus: { side: side, team: team, player: q.name, status: q.status, injury: q.injury }, context: contextOf(snap, league), games: [p], upsets: [], races: [], limitations: limitations },
              sources: sourcesOf(snap, league), demand: d6,
              formats: ['trending_story', 'publisher_custom'],
              scores: {
                search_relevance: { score: d6.measured ? 85 : 75, basis: d6.measured ? 'measured Search Console exposure' : 'estimate: starting-quarterback injury queries spike in game week' },
                timeliness: timelinessScore(ts(p.kickoff), now),
                audience_interest: { score: 80, basis: 'a starting quarterback on the official injury report' },
                research_availability: { score: 90, basis: 'official injury report plus the model’s quarterback-out scenario' },
                editorial_relevance: { score: 85, basis: 'quantifies an injury’s effect instead of guessing' },
                publisher_fit: publisherFit(pub, league, 'injury_impact', 'broad'),
                research_confidence: { score: 65, basis: 'scenario re-runs the engine with one input changed; the replacement’s level is the club’s carried level' }
              },
              expires_at: iso(ts(p.kickoff))
            }));
          });
        });
      }

      /* 6 · trending stories: attributed headlines matched to this slate */
      (opts.news || []).filter(function (n) { return n.league === league; }).forEach(function (n) {
        var games = upcoming.filter(function (p) { return n.teams.indexOf(p.home) >= 0 || n.teams.indexOf(p.away) >= 0; });
        if (!games.length) return;
        var pubT = ts(n.published_at), ageH = pubT == null ? null : (now - pubT) / 3600000;
        if (ageH != null && ageH > 72) return;
        var team = n.teams[0];
        var kw7 = (team + ' ' + (n.kind === 'general' ? 'news' : n.kind.replace('_', ' '))).toLowerCase();
        var d7 = demandFor(kw7, 'trending_story', opts.gsc);
        out.push(mkOpp({
          league: league, season: L.season, week: L.week, kind: 'trending_story', slug_part: hash(n.url).slice(0, 10),
          title: team + ' ' + (NEWS_WORDS[n.kind] || NEWS_WORDS.general)[1] + ': What It Means for Week ' + L.week,
          angle: 'Attributed reporting (' + n.publisher + ') read against EdgeDesk’s numbers for ' + team + '’s next game.',
          summary: n.publisher + ': “' + n.title + '”',
          teams: uniq([].concat.apply([], games.map(function (p) { return [p.home, p.away]; }))),
          research: { league: league, season: L.season, week: L.week, as_of: L.generated_at, kind: 'trending_story', news: [n], context: contextOf(snap, league), games: games.slice(0, 2), upsets: [], races: [], limitations: limitations },
          sources: [{ kind: 'external_report', publisher: n.publisher, title: n.title, url: n.url, published_at: n.published_at, retrieved_at: n.retrieved_at }].concat(sourcesOf(snap, league)),
          demand: d7,
          formats: ['trending_story', 'publisher_custom'],
          scores: {
            search_relevance: { score: d7.measured ? 85 : 60, basis: d7.measured ? 'measured Search Console exposure' : 'estimate: a named team in a current headline' },
            timeliness: ageH == null ? { score: 40, basis: 'the feed gave no publication time' } : { score: Math.round(clamp(100 - ageH * 2, 10, 100)), basis: 'reported ' + Math.round(ageH) + ' hours ago' },
            audience_interest: { score: n.kind === 'general' ? 55 : 75, basis: n.kind === 'general' ? 'a general headline' : 'a ' + n.kind.replace('_', ' ') + ' story' },
            research_availability: { score: 75, basis: 'EdgeDesk has a projection for ' + team + '’s next game; the reported facts themselves are the outlet’s' },
            editorial_relevance: { score: 70, basis: 'reporting is attributed; EdgeDesk adds its numbers, clearly separated' },
            publisher_fit: publisherFit(pub, league, 'trending_story', 'broad'),
            research_confidence: { score: 55, basis: 'only the headline is verified (by its source); details beyond it are not used' }
          },
          expires_at: iso(Math.min(ts(games[0].kickoff) || Infinity, (pubT || now) + 72 * 3600000))
        }));
      });
    });

    /* 7 · the weekly model performance review: the live-forward record only,
       and only once the sample is past "too early" */
    var PF = snap.performance;
    if (PF && PF.overall && PF.overall.n >= 50 && snap.cfb) {
      var Lc = snap.cfb, kwP = 'college football model accuracy week ' + Lc.week;
      var dP = demandFor(kwP, 'market_discrepancy', opts.gsc);
      out.push(mkOpp({
        league: 'cfb', season: Lc.season, week: Lc.week, kind: 'model_performance',
        title: 'How EdgeDesk’s College Football Model Has Done Through Week ' + Lc.week,
        angle: 'The published numbers graded against what happened: wins, misses and the sample size, never a profit claim.',
        summary: PF.overall.n + ' graded games; ATS ' + (PF.overall.ats.pct == null ? '—' : PF.overall.ats.pct + '%') + ' against the close.',
        teams: [],
        research: { league: 'cfb', season: Lc.season, week: Lc.week, as_of: PF.generated_at, kind: 'model_performance', context: contextOf(snap, 'cfb'), games: [], upsets: [], races: [], performance: PF, limitations: [] },
        sources: [{ kind: 'edgedesk_record', path: 'football/validation/integrity_performance.json', url: SITE + '/record.html', as_of: PF.generated_at || iso(now) }],
        demand: dP,
        scores: {
          search_relevance: { score: dP.measured ? 70 : 40, basis: dP.measured ? 'measured Search Console exposure' : 'estimate: a niche accountability query' },
          timeliness: { score: 70, basis: 'weekly, after the week’s games are graded' },
          audience_interest: { score: 45, basis: 'accountability content builds trust more than traffic' },
          research_availability: { score: 95, basis: PF.overall.n + ' graded live-forward games' },
          editorial_relevance: { score: 90, basis: 'reports misses as plainly as wins' },
          publisher_fit: publisherFit(pub, 'cfb', 'market_discrepancy', 'broad'),
          research_confidence: { score: PF.overall.n >= 200 ? 75 : 55, basis: PF.overall.sample }
        },
        expires_at: iso(now + 7 * 86400000)
      }));
    }

    out.forEach(function (o) { o.seo = seoBrief(o, pub); o.discovered_at = iso(now); });
    out.sort(function (a, b) { return b.priority - a.priority; });
    return out;
  }

  function confidenceScore(avg, L, league) {
    var s = league === 'nfl' ? 55 : (isNum(avg) ? avg : 50);
    if (L.fresh_markets === 0) s -= 10;
    if (league === 'cfb' && L.operations_status === 'CRITICAL') s -= 5;
    return clamp(Math.round(s), 0, 100);
  }
  function confidenceBasis(avg, L, league) {
    var b = [];
    if (league === 'nfl') b.push('the NFL model publishes no confidence score; data-quality status is used');
    else if (isNum(avg)) b.push('average model confidence ' + avg + '/100');
    if (L.fresh_markets === 0) b.push('no current prices');
    if (league === 'cfb' && L.operations_status === 'CRITICAL') b.push('CFB operations status CRITICAL');
    return b.join('; ');
  }
  function contextOf(snap, league) {
    var L = snap[league];
    if (league === 'cfb') {
      return {
        league: 'cfb', season: L.season, week: L.week, games_total: L.games_total, fresh_markets: L.fresh_markets,
        betting_enabled: L.betting_enabled, certified_bets: L.certified_bets, operations_status: L.operations_status,
        typical_games_played: L.typical_games_played, rankings_as_of: L.rankings.as_of,
        top10: L.rankings.top.slice(0, 10), generated_at: L.generated_at, team_names: L.team_names
      };
    }
    return { league: 'nfl', season: L.season, week: L.week, games_total: L.games_total, fresh_markets: L.fresh_markets, injuries_as_of: L.injuries_as_of, generated_at: L.generated_at, team_names: L.team_names };
  }
  function sourcesOf(snap, league) {
    return snap.sources.filter(function (s) { return league === 'cfb' ? (s.id === 'cfb_terminal' || s.id === 'rankings') : (s.id === 'nfl_slate' || s.id === 'nfl_injuries'); })
      .map(function (s) { return { kind: 'edgedesk_research', label: s.what, path: s.path, url: SITE + '/' + s.path, as_of: s.as_of }; });
  }

  /* ======================================================================
     SEO — the brief
     ====================================================================== */
  function seoBrief(o, publisher) {
    var L = o.league === 'cfb' ? 'College Football' : 'NFL';
    var l = o.league === 'cfb' ? 'college football' : 'nfl';
    var w = o.week;
    var R = o.research || {};
    var g0 = (R.games || [])[0];
    var head = g0 ? g0.away + ' vs. ' + g0.home : null;
    var b = { primary_keyword: null, secondary_keywords: [], intent: 'informational', headline: o.title, alternatives: [], structure: [] };
    switch (o.kind) {
      case 'weekly_preview':
        b.primary_keyword = l + ' week ' + w + ' predictions';
        b.secondary_keywords = [l + ' week ' + w + ' preview', l + ' week ' + w + ' upsets', (o.league === 'cfb' ? 'cfb' : 'nfl') + ' week ' + w + ' projections', head ? slugify(head).replace(/-/g, ' ') + ' prediction' : null, l + ' week ' + w + ' games to watch'].filter(Boolean);
        b.headline = L + ' Week ' + w + ' Predictions: ' + ((R.upsets || []).length ? 'Biggest Games and Potential Upsets' : 'The Games That Matter Most');
        b.alternatives = [
          L + ' Week ' + w + ' Predictions: ' + (o.league === 'nfl' ? 'Five Matchups Where the Numbers Tell a Different Story' : 'What EdgeDesk’s Model Expects'),
          L + ' Week ' + w + ' Preview: ' + (head ? head + ' Headlines a Big Weekend' : 'The Games That Matter Most'),
          'Week ' + w + ' ' + L + ' Projections: Favorites, Close Calls and Upset Alerts'
        ];
        b.structure = ['Intro: the headline game and why this week matters', 'How to read projections (not picks)', 'Game-by-game capsules (H3 per game)', 'Upset watch', o.league === 'cfb' ? 'Conference-race implications' : 'Where the numbers differ from the line', 'What the numbers can’t see', 'Bottom line'];
        break;
      case 'upset_watch':
        b.primary_keyword = l + ' week ' + w + ' upsets';
        b.secondary_keywords = [l + ' week ' + w + ' upset predictions', l + ' week ' + w + ' underdogs', l + ' week ' + w + ' predictions'];
        b.headline = L + ' Week ' + w + ' Upset Watch: The Underdogs With a Real Chance';
        b.alternatives = ['Week ' + w + ' ' + L + ' Upsets: Where the Model Sees an Opening', L + ' Week ' + w + ': Underdogs EdgeDesk’s Model Won’t Count Out'];
        b.structure = ['Intro', 'How to read win chances', 'Each underdog (H3)', 'Why a likely loser is not a bet', 'Bottom line'];
        break;
      case 'conference_race':
        b.primary_keyword = String(R.conference || '').toLowerCase() + ' championship race';
        b.secondary_keywords = [String(R.conference || '').toLowerCase() + ' title race', String(R.conference || '').toLowerCase() + ' week ' + w + ' predictions', String(R.conference || '').toLowerCase() + ' power rankings'];
        b.headline = o.title;
        b.alternatives = [R.conference + ' Title Race: The Week ' + w + ' Games That Matter Most', 'What Week ' + w + ' Means for the ' + R.conference + ' Race'];
        b.structure = ['Intro', 'Who leads EdgeDesk’s ratings in the conference', 'The key games (H3)', 'What the numbers can’t see', 'Bottom line'];
        break;
      case 'market_discrepancy':
        b.primary_keyword = o.league === 'nfl' ? 'nfl week ' + w + ' predictions vs spread' : (head ? slugify(head).replace(/-/g, ' ') + ' prediction' : l + ' prediction');
        b.headline = o.league === 'nfl' ? 'NFL Week ' + w + ' Predictions vs. the Spread: Where the Numbers Disagree' : (head ? head + ' Prediction: Model vs. Line' : o.title);
        b.secondary_keywords = o.league === 'nfl' ? ['nfl week ' + w + ' model predictions', 'nfl week ' + w + ' spreads', 'nfl week ' + w + ' predictions'] : [head ? slugify(head).replace(/-/g, ' ') + ' odds' : null, head ? slugify(head).replace(/-/g, ' ') + ' spread' : null].filter(Boolean);
        b.intent = 'informational (comparison)';
        b.alternatives = [o.league === 'nfl' ? 'NFL Week ' + w + ' Predictions: ' + cap(numWord(Math.min(5, (R.games || []).length))) + ' Games Where the Numbers Tell a Different Story' : (head + ': Why the Model and the Line Disagree'), 'Why EdgeDesk and the Sportsbooks See ' + (head || 'This Game') + ' Differently'];
        b.structure = ['Intro', 'The gap, with capture times', 'Why the numbers differ (drivers)', 'How to read a disagreement (not a bet)', 'The case for the market', 'Bottom line'];
        break;
      case 'injury_impact':
        b.primary_keyword = String((R.focus && R.focus.player) || '').toLowerCase() + ' injury';
        b.headline = (R.focus && R.focus.player) + ' Injury: What It Means for the ' + (R.focus && R.focus.team);
        b.secondary_keywords = [String((R.focus && R.focus.player) || '').toLowerCase() + ' injury update', String((R.focus && R.focus.team) || '').toLowerCase() + ' quarterback', head ? slugify(head).replace(/-/g, ' ') + ' prediction' : null].filter(Boolean);
        b.intent = 'informational (news)';
        b.alternatives = [R.focus && (R.focus.team + ' Without ' + R.focus.player + '? What EdgeDesk’s Model Says'), head && (head + ': How the Injury Report Moves the Projection')].filter(Boolean);
        b.structure = ['Intro', 'What the injury report says (attributed)', 'What the model says with and without the starter', 'What we don’t know yet', 'Bottom line'];
        break;
      default:
        var nw = (R.news || [])[0];
        var nk = nw ? NEWS_WORDS[nw.kind] || NEWS_WORDS.general : NEWS_WORDS.general;
        var nteam = nw ? nw.teams[0] : (o.teams && o.teams[0]) || '';
        b.primary_keyword = (nteam + ' ' + nk[0]).toLowerCase();
        b.headline = nteam + ' ' + nk[1] + ': What It Means for Week ' + w;
        b.secondary_keywords = (o.teams || []).slice(0, 3).map(function (t) { return String(t).toLowerCase() + ' prediction'; });
        b.intent = 'informational (news)';
        b.alternatives = [];
        b.structure = ['Intro', 'What was reported (attributed, linked)', 'Why it matters', 'What EdgeDesk’s research shows', 'What we don’t know yet', 'Bottom line'];
    }
    b.slug = slugify(b.headline);
    b.meta_description = metaFor(o, b);
    b.teams = o.teams || [];
    b.players = uniq([].concat.apply([], (R.games || []).map(function (p) { return [p.qb && p.qb.home && p.qb.home.player, p.qb && p.qb.away && p.qb.away.player]; })).filter(Boolean)).slice(0, 8);
    b.audience = 'General sports fans following ' + (o.league === 'cfb' ? 'college football' : 'the NFL') + ', not only bettors';
    b.angle = o.angle;
    b.internal_links = uniq((R.games || []).map(function (p) { return p.link; }).filter(Boolean)).slice(0, 6)
      .map(function (u) { return { url: u, anchor: 'EdgeDesk’s full research on this game' }; })
      .concat([{ url: SITE + '/today/', anchor: 'EdgeDesk’s free Today’s Games page' }, { url: SITE + '/methodology/', anchor: 'how EdgeDesk’s models work' }]);
    b.external_links = (o.sources || []).filter(function (s) { return s.kind === 'external_report'; }).map(function (s) { return { url: s.url, anchor: s.publisher + ': ' + s.title }; });
    b.demand = o.demand || null;
    if (publisher && publisher.editorial && publisher.editorial.seo_requirements) b.publisher_requirements = publisher.editorial.seo_requirements;
    return b;
  }
  function metaFor(o, b) {
    var R = o.research || {}, g0 = (R.games || [])[0];
    var m;
    if (o.kind === 'weekly_preview') m = 'EdgeDesk’s Week ' + o.week + ' ' + (o.league === 'cfb' ? 'college football' : 'NFL') + ' predictions' + (g0 ? ', from ' + g0.away + ' vs. ' + g0.home : '') + ' to the upsets worth watching. Research, not picks.';
    else if (o.kind === 'upset_watch') m = 'Which Week ' + o.week + ' underdogs have a real chance? EdgeDesk’s model names them, with win chances and the risks. Research, not picks.';
    else if (o.kind === 'conference_race') m = 'The ' + R.conference + ' games that shape the title race in Week ' + o.week + ', with EdgeDesk’s projections and ratings. Research, not picks.';
    else if (o.kind === 'market_discrepancy') m = 'Why EdgeDesk’s projection differs from the betting line' + (g0 && R.games.length === 1 ? ' for ' + g0.away + ' vs. ' + g0.home : ' this week') + ', and what could explain it. Research, not picks.';
    else if (o.kind === 'injury_impact') m = 'What the injury report says about ' + (R.focus && R.focus.player) + ', and how EdgeDesk’s projection changes if he can’t play. Research, not picks.';
    else m = 'The latest ' + (o.teams && o.teams[0] || '') + ' news, read against EdgeDesk’s numbers for the next game. Research, not picks.';
    return m.length > 160 ? m.slice(0, 157).replace(/\s+\S*$/, '') + '…' : m;
  }

  /* ======================================================================
     DRAFT — deterministic prose, from the packet only
     ====================================================================== */
  function para() { return Array.prototype.slice.call(arguments).filter(Boolean).join(' '); }

  function fanLine(p) {
    /* "EdgeDesk’s model makes Alabama a 5.3-point favorite (64% to win)" */
    var m = p.model;
    if (!m.available) return null;
    if (!m.favorite) return 'EdgeDesk’s model sees ' + p.away + ' at ' + p.home + ' as a pick’em.';
    if (m.margin < 1) return 'EdgeDesk’s model sees a near coin flip: ' + m.favorite + ' by ' + oneDp(m.margin) + (isNum(m.fav_win_pct) ? ', with a ' + m.fav_win_pct + '% chance to win' : '') + '.';
    return 'EdgeDesk’s model makes ' + m.favorite + ' ' + aOrAn(oneDp(m.margin)) + ' ' + oneDp(m.margin) + '-point favorite' + (isNum(m.fav_win_pct) ? ', with a ' + m.fav_win_pct + '% chance to win' : '') + '.';
  }
  function scoreLine(p) {
    if (!p.display.score) return null;
    return 'Projected score: ' + p.display.score + (p.display.total ? ' (a projected total of ' + p.display.total + ' points).' : '.');
  }
  function driverLine(p) {
    var d = p.drivers || [];
    if (!d.length || !p.model.favorite) return null;
    var parts = d.slice(0, 2).map(function (x) {
      var lab = String(x.label).replace(/\s*\(.*\)\s*/g, '').toLowerCase();
      return lab + ' (' + oneDp(x.points) + ' points toward ' + x.team + ')';
    });
    return 'The biggest pieces of the projection: ' + sentenceList(parts) + '.';
  }
  function matchupLine(p) {
    var mu = p.matchup || [];
    if (!mu.length) return null;
    var x = mu[0];
    return 'Matchup to watch: EdgeDesk’s unit data gives ' + x.favors + ' a ' + x.magnitude + ' edge in the ' + String(x.label).toLowerCase() + '.';
  }
  function marketLine(p) {
    var m = p.market;
    if (!m || m.status === 'none' || !p.display.market) return null;
    var gapTxt = p.gap && p.gap.points >= 0.1 ? ' That is ' + oneDp(p.gap.points) + ' points away from EdgeDesk’s number, toward ' + p.gap.toward + '.' : ' EdgeDesk’s number is essentially the same.';
    if (m.status === 'current') return 'The betting line: ' + p.display.market + '.' + gapTxt + ' A gap is a question for research, not a reason to bet.';
    if (m.status === 'stale') return 'The last sportsbook line EdgeDesk captured: ' + p.display.market + '. That line is older than EdgeDesk’s three-hour freshness rule, so treat it as context, not a current price.' + gapTxt;
    return 'For reference, the ' + p.display.market + ' had ' + (favOf(p.home, p.away, m.home_line).favorite || 'neither team') + ' favored. It is a reference, not a sportsbook price.' + gapTxt;
  }
  /* QUARTERBACKS (docs/system-integrity/AUDIT.md §6). The Week 6 article said,
     game after game, that neither starter was confirmed — because no college
     team announces a starter before kickoff and the writer read that silence
     as uncertainty. Now: an EXPECTED STARTER gets no sentence at all; a
     dropback split is printed as the measured fact it is; uncertainty is
     written only from a sourced report (lib/edgedesk_availability.js), with
     the source and its date. */
  function qbLine(p) {
    if (p.league !== 'cfb' || !AVAIL) return null;
    var out = [];
    ['away', 'home'].forEach(function (s) {
      var c = p.availability && p.availability[s]; if (!c) return;
      if ((c.may_assert_uncertainty && c.verification === 'SOURCED') || c.measured_note) { var t = AVAIL.sentence(c); if (t) out.push(t); }
    });
    return out.length ? 'Quarterback watch: ' + out.join(' ') : null;
  }
  function injuryLine(p) {
    var out = [];
    ['away', 'home'].forEach(function (s) {
      var i = p.injuries && p.injuries[s]; if (!i) return;
      var team = s === 'home' ? p.home : p.away;
      var q = (i.qbs || []).filter(function (x) { return x.starter; })[0];
      if (q) out.push(team + ' ' + verb(p.league, 'lists', 'list') + ' starting quarterback ' + q.name + ' as ' + String(q.status).toLowerCase() + (q.injury ? ' (' + String(q.injury).toLowerCase() + ')' : '') + ' on the official injury report.');
      else if (i.out_count) out.push(team + ' ' + verb(p.league, 'lists', 'list') + ' ' + numWord(i.out_count) + ' player' + (i.out_count === 1 ? '' : 's') + ' as out.');
    });
    return out.length ? 'Injury report: ' + out.join(' ') : null;
  }
  function confLine(p) {
    var m = p.model;
    if (m.confidence) return 'Model confidence: ' + (m.confidence.label || '') + ' (' + m.confidence.score + ' out of 100).';
    return null;
  }
  function rankTag(p, side) {
    var r = side === 'home' ? p.home_rank : p.away_rank;
    return p.league === 'cfb' && isNum(r) && r <= 25 ? 'No. ' + r + ' ' : '';
  }
  function recTag(p, side) {
    var r = side === 'home' ? p.home_record : p.away_record;
    return p.league === 'nfl' && r ? ' (' + r + ')' : '';
  }
  function gameHeading(p) {
    var sep = p.neutral_site ? ' vs. ' : ' at ';
    return rankTag(p, 'away') + p.away + recTag(p, 'away') + sep + rankTag(p, 'home') + p.home + recTag(p, 'home') + (p.kickoff_text ? ' — ' + p.kickoff_text : '');
  }
  function capsule(p, opts) {
    opts = opts || {};
    var lines = [fanLine(p), scoreLine(p), driverLine(p), opts.short ? null : matchupLine(p), marketLine(p), p.league === 'cfb' ? qbLine(p) : injuryLine(p), confLine(p)];
    var linkTxt = p.link && opts.links !== false ? 'Full research: [' + p.away + ' vs. ' + p.home + ' on EdgeDesk](' + p.link + ')' : null;
    return '### ' + gameHeading(p) + '\n\n' + lines.filter(Boolean).join(' ') + (linkTxt ? '\n\n' + linkTxt : '');
  }

  function ctxIntro(o) {
    var R = o.research, c = R.context || {}, g = R.games || [];
    var g0 = g[0];
    var L = o.league === 'cfb' ? 'college football' : 'NFL';
    if (!g0) return null;
    if (o.kind === 'upset_watch') {
      return para('Every week of the ' + L + ' season brings at least one result nobody saw coming. EdgeDesk’s model can’t say which one, but it can say where an upset is realistic.',
        'For Week ' + o.week + ', the model gives ' + sentenceList(g.slice(0, 3).map(function (p) { return p.model.underdog + ' a ' + p.model.dog_win_pct + '% chance'; })) + '.',
        'Here is why each one has a path, and what would have to go right.');
    }
    if (o.kind === 'market_discrepancy' && g.length > 1) {
      return para('EdgeDesk’s ' + (o.league === 'nfl' ? 'NFL' : 'college football') + ' Week ' + o.week + ' predictions differ from the betting line by two points or more in ' + numWord(g.length) + ' of the games below.',
        'The biggest gap: ' + g0.away + ' at ' + g0.home + ', where EdgeDesk has ' + g0.display.fair + ' and the line was ' + (g0.display.market || 'not available') + '.',
        'A disagreement is not a bet. It is a question about what the model sees that the market does not, or the other way around, and the answers are below.');
    }
    if (o.kind === 'conference_race') {
      return para('The ' + R.conference + ' championship race runs through ' + sentenceList(g.map(function (p) { return p.away + ' at ' + p.home; })) + ' this week.',
        'In EdgeDesk’s ratings, ' + sentenceList((R.conference_top || []).slice(0, 3)) + ' are the conference’s three highest-rated teams, so the result' + (g.length > 1 ? 's' : '') + ' will carry extra weight for the rest of the season.');
    }
    var headline = g0.away + (g0.neutral_site ? ' vs. ' : ' at ') + g0.home;
    var n = c.games_total;
    return para('Week ' + o.week + ' of the ' + L + ' season puts ' + (isNum(n) ? n + ' games' : 'a full slate') + ' on EdgeDesk’s board, and a handful of them will shape the season’s storylines.',
      'The headliner is ' + headline + (g0.kickoff_text ? ' (' + g0.kickoff_text + ')' : '') + ', where ' + (fanLine(g0) || 'EdgeDesk has a projection').replace(/^EdgeDesk’s model makes/, 'EdgeDesk’s model makes').replace(/\.$/, '') + '.',
      'Below are EdgeDesk’s Week ' + o.week + ' predictions for the games that matter most, what the numbers expect in each, and where the underdog has a realistic chance.');
  }

  function whyItMatters(o) {
    var c = o.research.context || {};
    if (o.league === 'cfb') {
      return para(isNum(c.typical_games_played) ? 'Most teams have now played ' + numWord(c.typical_games_played) + ' games, so EdgeDesk’s ratings lean on what teams have actually done this season rather than on preseason expectations.' : 'Ratings now lean on what teams have actually done this season rather than on preseason expectations.',
        'That makes this the point of the season where the numbers start to separate contenders from teams that had a soft early schedule.',
        c.top10 && c.top10.length >= 3 ? 'EdgeDesk’s current top three: ' + sentenceList(c.top10.slice(0, 3).map(function (t) { return t.team; })) + '.' : null);
    }
    return para('A month into the NFL season, records are starting to mean something and early-season surprises are being tested.',
      'EdgeDesk’s NFL projections are built from each team’s efficiency this season, quarterback play, rest and home field, and they are compared with the betting line only when EdgeDesk knows when that line was captured.');
  }

  function howToRead(o) {
    return para('A projection is the margin and win chance EdgeDesk’s model expects, built from team ratings, home field and matchup data.',
      'A projection is not a bet. A team can be the likelier winner and still be a poor wager if the betting line already expects more than the model does, which is why this article doesn’t make picks.',
      'When we compare the model with a sportsbook line, we say where the line came from and when it was captured.',
      o.league === 'cfb' ? 'Rankings shown with team names (such as No. 6) are EdgeDesk’s own power ratings, not the AP poll.' : null);
  }

  function upsetsSection(o, gamesShown) {
    var ups = (o.research.upsets || []).filter(function (p) { return o.kind === 'upset_watch' || gamesShown.indexOf(p.game_id) < 0 || true; });
    if (!ups.length) return null;
    var lines = ups.slice(0, 3).map(function (p) {
      var favRank = p.model.favorite === p.home ? p.home_rank : p.away_rank;
      var rankTxt = p.league === 'cfb' && isNum(favRank) && favRank <= 25 ? ' (No. ' + favRank + ' in EdgeDesk’s ratings)' : '';
      var s = '- **' + p.model.underdog + '** over ' + p.model.favorite + rankTxt + ': the model gives ' + p.model.underdog + ' a ' + p.model.dog_win_pct + '% chance.';
      if (p.favorite_flip && p.market.status !== 'none') s += ' The ' + (p.market.status === 'current' ? 'current betting line' : 'last captured line') + ' has the favorite the other way around.';
      return s;
    });
    return para('An underdog the model gives a 30 percent chance or better still loses more often than it wins, but over a full slate a few of them come through.') + '\n\n' + lines.join('\n') + '\n\n'
      + 'None of these is a prediction that the underdog wins, and none is a bet: whether an underdog is worth backing depends entirely on the price, which this article doesn’t assess.';
  }

  function conferenceSection(o) {
    var races = o.research.races || [];
    if (!races.length) return null;
    var c = o.research.context || {};
    return races.map(function (p) {
      var top = (o.research.conference_top && o.research.conference_top.length ? o.research.conference_top : null);
      return para('**' + p.home_conference + ':** ' + p.away + ' and ' + p.home + ' are both among the conference’s three highest-rated teams in EdgeDesk’s ratings, so this game carries extra weight for the title race.',
        fanLine(p));
    }).join('\n\n') + '\n\n' + 'EdgeDesk doesn’t carry a conference standings feed, so this reads the race through ratings and projections, not tiebreakers.';
  }

  function disagreementsSection(o) {
    var gs = (o.research.games || []).filter(function (p) { return p.gap && p.gap.points >= RESEARCH_GAP && p.market.status !== 'none'; });
    if (!gs.length) return null;
    var any = gs[0];
    var intro = any.market.status === 'reference'
      ? 'These comparisons use the consensus line from public schedule data, which has no sportsbook and no capture time: treat each gap as a research note.'
      : any.market.status === 'stale' ? 'These comparisons use the last lines EdgeDesk captured, each older than its three-hour freshness rule: lines move, so treat each gap as a research note.'
      : 'These comparisons use lines EdgeDesk captured within the last three hours.';
    var lines = gs.slice(0, 5).map(function (p) {
      return '- **' + p.away + ' at ' + p.home + ':** EdgeDesk has ' + p.display.fair + '; the line was ' + p.display.market + '. Gap: ' + p.gap.text + '.';
    });
    return intro + '\n\n' + lines.join('\n') + '\n\n' + 'A gap means the model and the market weigh something differently. Sometimes the model has spotted something; often the market knows something the model can’t see, like an injury that hasn’t been reported yet.';
  }

  function injuriesSection(o) {
    var lines = [];
    (o.research.games || []).forEach(function (p) { var l = injuryLine(p); if (l) lines.push('- **' + p.away + ' at ' + p.home + ':** ' + l.replace(/^Injury report: /, '')); });
    if (!lines.length) return null;
    var asOf = o.research.context && o.research.context.injuries_as_of;
    return 'From the official NFL injury report' + (asOf ? ' (as read ' + whenText(ts(asOf)) + ')' : '') + ':\n\n' + lines.join('\n');
  }

  function limitsSection(o) {
    var R = o.research, gs = R.games || [];
    var bullets = [];
    var qbN = gs.filter(function (p) { return p.flags.indexOf('QB_UNCERTAIN') >= 0; }).length;
    if (o.league === 'cfb' && qbN) bullets.push('**Quarterbacks:** in ' + numWord(qbN) + ' of the games above, a reported quarterback situation (named in that game’s section, with its source) could move the number.');
    else if (o.league === 'cfb') bullets.push('**Quarterbacks:** college teams seldom name a starter before kickoff, so EdgeDesk reads each starter from recent play. A late change would move a projection more than almost anything else.');
    /* only what is unpriced in EVERY featured game: a factor priced in one
       game must not be called unpriced in general */
    var unp = gs.length ? (gs[0].unpriced || []).filter(function (u) { return gs.every(function (p) { return (p.unpriced || []).indexOf(u) >= 0; }); }) : [];
    var UNPRICED = { 'Quarterback / personnel': 'quarterback and personnel changes', 'Reported availability': 'reported injuries', 'Rivalry situational effect': 'rivalry effects' };
    if (unp.length) bullets.push('**Not in the main number:** EdgeDesk’s college projection does not directly price ' + sentenceList(unp.map(function (u) { return UNPRICED[u] || u.toLowerCase(); }), 'or') + '.');
    if ((R.limitations || []).length) bullets.push('**Prices and bets:** ' + R.limitations.join(' '));
    if (o.league === 'nfl') bullets.push('**Injuries:** the official report is a snapshot; game-day inactives can change the picture.');
    bullets.push('**Uncertainty:** even a 70% favorite loses about three times in ten. Projections describe likelihoods, not outcomes.');
    return uniq(bullets).map(function (b) { return '- ' + b; }).join('\n');
  }

  function conclusionSection(o) {
    var gs = (o.research.games || []).filter(function (p) { return p.model.available && p.model.favorite; });
    if (!gs.length) return 'Projections move during the week as quarterback news and prices arrive. EdgeDesk updates its numbers as they do.';
    var fav = gs.slice().sort(function (a, b) { return (b.model.fav_win_pct || 0) - (a.model.fav_win_pct || 0); })[0];
    var close = gs.slice().sort(function (a, b) { return Math.abs((a.model.fav_win_pct || 50) - 50) - Math.abs((b.model.fav_win_pct || 50) - 50); })[0];
    var ups = (o.research.upsets || [])[0];
    var bits = [];
    var be = verb(o.league, ' is ', ' are ');
    if (o.kind !== 'upset_watch') bits.push(fav.model.favorite + be + 'the most comfortable favorite among these games (' + fav.model.fav_win_pct + '%)');
    if (close && close !== fav) bits.push(close.away + ' at ' + close.home + ' is the closest call');
    if (ups) bits.push(ups.model.underdog + be + 'the underdog with the best chance (' + ups.model.dog_win_pct + '%)');
    return para('The short version: ' + sentenceList(bits) + '.',
      'Projections move during the week as quarterback news and prices arrive, and EdgeDesk updates its numbers as they do.',
      'None of it is a pick. It’s a way to watch the weekend knowing where the real uncertainty is.');
  }

  /* market discrepancy, one game */
  function mdSections(o) {
    var p = o.research.games[0];
    var s = {};
    var verified = p.verified === true;
    s.intro = para(p.away + (p.neutral_site ? ' vs. ' : ' at ') + p.home + (p.kickoff_text ? ' (' + p.kickoff_text + ')' : '') + ' is one of the games where EdgeDesk’s number and the betting line disagree the most this week.',
      'EdgeDesk’s model has ' + p.display.fair + '; ' + (p.market.status === 'current' ? 'the betting line is ' : 'the last line EdgeDesk captured was ') + p.display.market + '.',
      verified ? 'Here is where the gap comes from, and what would have to be true for the market to be right.' : 'EdgeDesk’s own checks haven’t verified this gap yet, and at this size missing information is a more likely explanation than a market mistake. Here is what we know and what we don’t.');
    s.the_gap = para('The difference is ' + oneDp(p.gap.points) + ' points, toward ' + p.gap.toward + '.',
      p.market.status === 'current' ? 'The line was captured ' + (p.market.captured_text || '') + ', inside EdgeDesk’s three-hour freshness window.' : 'That line is older than EdgeDesk’s three-hour freshness rule, so the market may have moved since.',
      fanLine(p), scoreLine(p));
    s.why_they_differ = para(driverLine(p) || 'EdgeDesk’s projection is built from team ratings, home field and matchup data.',
      matchupLine(p),
      'When the model and the market disagree, the disagreement usually sits in one of those inputs: either EdgeDesk rates a team differently, or the market is pricing something the model can’t see.');
    s.how_to_read = howToRead(o);
    var risks = (p.risks || []).slice(0, 2);
    s.market_case = para('There are good reasons the market could be right.',
      qbLine(p) ? qbLine(p).replace(/^What could change it: /, '') : null,
      risks.length ? 'EdgeDesk’s research also flags: ' + risks.join(' ') : null,
      p.price_note ? 'EdgeDesk’s pricing note: ' + p.price_note : null,
      verified ? null : 'The gap failed EdgeDesk’s verification check, which is exactly the case where the market usually knows something the model doesn’t.');
    s.limits = limitsSection(o);
    s.conclusion = para('The takeaway: EdgeDesk and the market see ' + p.away + '–' + p.home + ' differently by ' + oneDp(p.gap.points) + ' points.',
      'That is a research question worth following through the week, not a bet. If the quarterback news or the line changes, the answer changes with it.');
    return s;
  }

  /* trending story / injury implications, one team in the news */
  function storySections(o) {
    var R = o.research, p = (R.games || [])[0], s = {};
    var news = (R.news || [])[0], focus = R.focus;
    if (news) {
      s.intro = para(news.publisher + ' reported' + (news.published_at ? ' on ' + dayText(ts(news.published_at)) : '') + ': “' + news.title + '.”',
        'Here is what that report says, what it could mean for ' + (news.teams[0]) + '’s next game, and what EdgeDesk’s numbers show — kept separate, so you can tell reporting from model inference.');
      s.reported = para('According to ' + news.publisher + ' ([' + news.title + '](' + news.url + ')): ' + (news.summary ? '“' + news.summary.replace(/\s+$/, '') + '”' : 'the headline above is all the feed provides; EdgeDesk has not independently confirmed further details.'),
        'EdgeDesk has not independently verified the report.');
    } else if (focus) {
      var inj = p.injuries && p.injuries[focus.side];
      s.intro = para(focus.team + ' ' + verb(p.league, 'lists', 'list') + ' ' + focus.player + ' as ' + String(focus.status).toLowerCase() + (focus.injury ? ' with a ' + String(focus.injury).toLowerCase() + ' injury' : '') + ' on the official NFL injury report.',
        'Here is what that could mean for ' + p.away + ' at ' + p.home + (p.kickoff_text ? ' (' + p.kickoff_text + ')' : '') + ', using EdgeDesk’s model.');
      s.reported = para('The official NFL injury report' + (inj && inj.retrieved_at ? ', as read ' + whenText(ts(inj.retrieved_at)) : '') + ', lists ' + focus.player + ' as ' + String(focus.status).toLowerCase() + '.',
        'A status can change before kickoff; the report is the league’s, not EdgeDesk’s.');
    }
    var WHY = { injury: 'Availability moves a projection more than almost any other single piece of news, and the closer to kickoff, the less time the market has to settle on it.',
      qb_change: 'A quarterback change moves a projection more than almost any other single piece of news.',
      trade: 'A roster move changes who is on the field, and a projection built on last week’s roster can lag behind it.',
      coaching: 'A coaching change can change how a team plays faster than its results can show it.',
      ranking: 'Rankings shape the playoff conversation, but a ranking is an opinion about the past; a projection is an estimate of the next game.',
      suspension: 'A suspension changes who is available, which a projection only sees once it is confirmed.',
      general: 'News moves the conversation. The question for a fan is whether it moves the numbers, and by how much.' };
    s.why_it_matters = news ? WHY[news.kind] || WHY.general : WHY.injury;
    if (p) {
      var side = news ? (p.home === news.teams[0] ? 'home' : 'away') : focus.side;
      var team = side === 'home' ? p.home : p.away;
      var rk = side === 'home' ? p.home_rank : p.away_rank, rec = side === 'home' ? p.home_record : p.away_record;
      var ctxBits = [];
      if (p.league === 'cfb' && isNum(rk)) ctxBits.push(team + ' is No. ' + rk + ' in EdgeDesk’s power ratings');
      if (p.league === 'nfl' && rec) ctxBits.push(team + ' is ' + rec + ' this season');
      if (ctxBits.length) s.why_it_matters += ' For context, ' + ctxBits.join(' and ') + '.';
    }
    if (p) {
      var sc = focus && p.scenarios && p.scenarios[focus.side + '_qb_out'];
      var scTxt = null;
      if (sc) {
        var f2 = favOf(p.home, p.away, sc.home_line);
        scTxt = 'If ' + focus.team + '’s listed starter does not play, the model’s projection becomes ' + (f2.favorite ? f2.favorite + ' by ' + oneDp(f2.margin) : 'a pick’em') + (isNum(sc.home_win_prob) ? ', with ' + p.home + ' at ' + pct(sc.home_win_prob) + ' to win' : '') + '. That re-run changes one input and gives the replacement the club’s carried quarterback level.';
      }
      s.research = '**Next game: ' + gameHeading(p) + '**\n\n' + para(fanLine(p), scoreLine(p), driverLine(p), scTxt, marketLine(p), p.league === 'cfb' ? qbLine(p) : injuryLine(p), confLine(p),
        'A projection is not a bet: it is EdgeDesk’s estimate of what is likely, not a judgment about any price.');
    }
    s.unknowns = para('What we don’t know: final game-day status, how a replacement would actually play, and whether the betting market has already moved.',
      'EdgeDesk’s numbers update as the official report and captured prices do.');
    s.conclusion = para('The report is the news; the projection is EdgeDesk’s estimate of what it might mean. Neither is a pick.');
    return s;
  }

  /* ======================================================================
     STORY RANKING (docs/system-integrity/TEMPLATES.md §1)
     Four separate questions, never folded into one another:
       editorial_interest     would a fan want to read about this game?
       statistical_surprise   is there a RESEARCH-CLEARED surprise in it?
       research_reliability   can EdgeDesk stand behind its numbers here?
       betting_actionable     did the decision engine approve a price? —
                              reported, never part of a story's score: an
                              article is research, not a betting card.
     A big gap earns surprise only when research cleared it (WORTH
     RESEARCHING or VERIFIED MAJOR), and surprise is weighted by
     reliability, so a large discrepancy on weak data never leads a story:
     it goes to investigations() instead.
     ====================================================================== */
  function storyScore(p) {
    var ei = 0, why = [];
    var top = function (r) { return isNum(r) && r <= 25; };
    if (p.league === 'cfb') {
      if (top(p.home_rank) && top(p.away_rank)) { ei += 45; why.push('two top-25 teams'); }
      else if (top(p.home_rank) || top(p.away_rank)) { ei += 22; why.push('a top-25 team'); }
      if ((isNum(p.home_rank) && p.home_rank <= 10) || (isNum(p.away_rank) && p.away_rank <= 10)) { ei += 10; why.push('a top-10 team'); }
      if (p.conference_game && POWER4.indexOf(p.home_conference) >= 0) { ei += 10; why.push('a power-conference game'); }
      if (p.fcs) ei -= 30;
    } else {
      if (p.divisional) { ei += 12; why.push('a division game'); }
      var win = function (rec) { if (!rec) return false; var a = rec.split('-'); return +a[0] > +a[1]; };
      if (win(p.home_record) && win(p.away_record)) { ei += 25; why.push('two winning teams'); }
      else if (win(p.home_record) || win(p.away_record)) ei += 10;
    }
    if (p.model.available && isNum(p.model.fav_win_pct)) { var close = 1 - Math.abs(p.model.fav_win_pct - 50) / 50; ei += 30 * close; if (close > 0.6) why.push('a close projection'); }
    var rk = p.research_status && p.research_status.key, gap = p.gap && p.market && p.market.status === 'current' ? p.gap.points : null;
    var ss = 0, sw = [];
    if (rk === 'VERIFIED_MAJOR') { ss = 85; sw.push('a verified major disagreement with the market'); }
    else if (rk === 'WORTH_RESEARCHING' && isNum(gap)) { ss = clamp(30 + 8 * (gap - 2), 30, 70); sw.push('a ' + oneDp(gap) + '-point research-grade disagreement with a current price'); }
    if (p.favorite_flip && (rk === 'WORTH_RESEARCHING' || rk === 'VERIFIED_MAJOR')) { ss += 10; sw.push('the model and the market name different favorites'); }
    if (p.model.available && isNum(p.model.dog_win_pct) && p.model.dog_win_pct >= 30 && p.model.dog_win_pct <= 46) { ss += 20 * (p.model.dog_win_pct - 30) / 16; sw.push('a ' + p.model.dog_win_pct + '% underdog'); }
    /* an unmeasured reliability or confidence counts as 40 — never as good —
       and the score says it was unmeasured (no league is assumed reliable) */
    var relM = isNum(p.model.reliability), confM = p.model.confidence && isNum(p.model.confidence.score);
    var rel = relM ? p.model.reliability : 40;
    var conf = confM ? p.model.confidence.score : 40;
    var rr = 0.6 * rel + 0.4 * conf;
    if (p.flags.indexOf('QB_UNCERTAIN') >= 0) rr -= 10;
    if (p.flags.indexOf('LOW_CONFIDENCE') >= 0) rr -= 25;
    rr = clamp(Math.round(rr), 0, 100);
    var ba = p.decision && p.decision.key === 'BET' ? 100 : 0;
    var e = clamp(Math.round(ei), 0, 100), sur = clamp(Math.round(ss), 0, 100);
    var story = Math.round(0.55 * e + 0.25 * sur * rr / 100 + 0.20 * rr);
    if (p.publishable === false) story = 0;
    return { story: story, editorial_interest: e, statistical_surprise: sur, research_reliability: rr, reliability_measured: relM, confidence_measured: confM, betting_actionable: ba,
      why: why.concat(sw), basis: 'story = 0.55 × editorial interest + 0.25 × research-cleared surprise × reliability + 0.20 × reliability; betting actionability is reported, never scored' };
  }
  function storyline(games, league) {
    var ranked = games.map(function (p) { return { p: p, s: storyScore(p) }; }).filter(function (x) { return x.s.story > 0; })
      .sort(function (a, b) { return b.s.story - a.s.story || ((ts(a.p.kickoff) || 0) - (ts(b.p.kickoff) || 0)); });
    if (!ranked.length) return null;
    var c = ranked[0], type = 'marquee';
    if (c.s.statistical_surprise >= 60 && c.s.research_reliability >= 70) type = 'model_vs_market';
    else if (c.p.model.dog_win_pct >= 38 && c.s.editorial_interest >= 40) type = 'upset';
    else if (c.p.conference_game && league === 'cfb' && c.s.editorial_interest >= 50) type = 'conference';
    /* supporting games: the next by story score, no team twice */
    var seen = {}; seen[c.p.home] = 1; seen[c.p.away] = 1;
    var support = [];
    ranked.slice(1).forEach(function (x) { if (support.length >= 4 || seen[x.p.home] || seen[x.p.away]) return; seen[x.p.home] = 1; seen[x.p.away] = 1; support.push(x.p); });
    return { type: type, central: c.p, central_score: c.s, supporting: support,
      why: c.s.why.slice(0, 3), ranked: ranked.map(function (x) { return { game_id: x.p.game_id, story: x.s.story, editorial_interest: x.s.editorial_interest,
        statistical_surprise: x.s.statistical_surprise, research_reliability: x.s.research_reliability, betting_actionable: x.s.betting_actionable }; }) };
  }
  /* the internal list: big gaps that did NOT clear research — investigated by
     a person, never promoted (docs/system-integrity/PERFORMANCE.md) */
  function investigations(snap) {
    var out = [];
    ['cfb', 'nfl'].forEach(function (lg) {
      var L = snap && snap[lg]; if (!L) return;
      L.games.forEach(function (p) {
        var k = p.research_status && p.research_status.key;
        var big = p.gap && p.gap.points >= 7;
        if ((big && k !== 'VERIFIED_MAJOR') || k === 'INVESTIGATE' || k === 'MARKET_FAULT' || k === 'DATA_FAULT' || p.publishable === false)
          out.push({ league: lg, game_id: p.game_id, matchup: p.away + ' at ' + p.home, research_status: k || null,
            gap: p.gap ? p.gap.points : null, reason: k === 'INVESTIGATE' ? 'a large gap the integrity gate has not cleared'
              : (k === 'MARKET_FAULT' || k === 'DATA_FAULT' ? 'faulted data' : (p.publishable === false ? 'withheld from publication by the integrity engine' : 'a 7+ point gap without verification')),
            blocking: p.integrity && p.integrity.public ? p.integrity.public.blocking : [], publishable: false });
      });
    });
    return out;
  }

  /* ---------------------------------------------------- the new templates */
  function storylinesSections(o) {
    var R = o.research, L0 = R.storyline || {}, s = {};
    var byId = {}; (R.games || []).forEach(function (p) { byId[p.game_id] = p; });
    var L = { central: byId[L0.central_id] || (R.games || [])[0] || null, supporting: (L0.supporting_ids || []).map(function (id) { return byId[id]; }).filter(Boolean) };
    var items = [];
    if (L.central) items.push(L.central);
    (L.supporting || []).forEach(function (p) { if (items.length < 5 && items.indexOf(p) < 0) items.push(p); });
    var lg = o.league === 'cfb' ? 'college football' : 'NFL';
    s.intro = para('Every ' + lg + ' weekend has a few stories that will still be talked about on Monday. These are Week ' + o.week + '’s, chosen for how much they matter to the season and how firmly EdgeDesk’s numbers stand behind them, not for how big a number looks.',
      L.central ? 'The lead: ' + L.central.away + (L.central.neutral_site ? ' vs. ' : ' at ') + L.central.home + (L.central.kickoff_text ? ' (' + L.central.kickoff_text + ')' : '') + '.' : null);
    s.storylines = items.map(function (p, i) {
      var why = storyScore(p).why;
      return '### ' + (i + 1) + '. ' + gameHeading(p) + '\n\n' + para(why.length ? 'Why it matters: ' + sentenceList(why.slice(0, 3)) + '.' : null,
        fanLine(p), scoreLine(p), i === 0 ? driverLine(p) : null, i === 0 ? matchupLine(p) : null, marketLine(p), qbLine(p));
    }).join('\n\n');
    s.how_to_read = howToRead(o);
    s.limits = limitsSection(o);
    s.conclusion = para('Each of these will look different by kickoff as news and prices arrive. EdgeDesk updates its numbers as they do; none of this is a pick.');
    return s;
  }
  function deepDiveSections(o) {
    var p = (o.research.games || [])[0], s = {};
    if (!p) return s;
    s.intro = para(gameHeading(p).replace(/ — /, ', ') + ' is the game this piece takes apart: what EdgeDesk’s model expects, what the numbers are built on, and what would change them.');
    s.the_matchup = para(p.away + ' ' + (p.neutral_site ? 'and' : 'travels to') + ' ' + p.home + (p.venue ? ' (' + p.venue + ')' : '') + '.',
      p.league === 'cfb' && (isNum(p.home_rank) || isNum(p.away_rank)) ? 'In EdgeDesk’s power ratings, ' + [isNum(p.away_rank) ? p.away + ' is No. ' + p.away_rank : null, isNum(p.home_rank) ? p.home + ' is No. ' + p.home_rank : null].filter(Boolean).join(' and ') + '.' : null,
      matchupLine(p));
    s.numbers = para(fanLine(p), scoreLine(p), confLine(p), marketLine(p));
    s.why_they_differ = para(driverLine(p) || 'EdgeDesk’s projection is built from team ratings, home field and matchup data.');
    var risks = (p.risks || []).slice(0, 2);
    s.what_could_change = para(qbLine(p), p.league === 'nfl' ? injuryLine(p) : null, risks.length ? 'EdgeDesk’s research also flags: ' + risks.join(' ') : null) || 'No reported development is on file that would move this number.';
    s.how_to_read = howToRead(o);
    s.limits = limitsSection(o);
    s.conclusion = para('The takeaway: ' + (p.display.fair ? 'EdgeDesk has ' + p.display.fair + '. ' : '') + 'That is an estimate with real uncertainty, not a pick, and it moves if the news or the line does.');
    return s;
  }
  function raceSections(o) {
    var R = o.research, s = {};
    s.intro = para('The ' + R.conference + ' race runs through ' + sentenceList((R.games || []).map(function (p) { return p.away + ' at ' + p.home; })) + ' this week.');
    s.race = para((R.conference_top || []).length ? 'In EdgeDesk’s ratings, ' + sentenceList(R.conference_top.slice(0, 3)) + ' are the conference’s three highest-rated teams.' : null,
      'EdgeDesk doesn’t carry a conference standings feed, so this reads the race through ratings and projections, not tiebreakers.');
    s.games = (R.games || []).map(function (p) { return capsule(p, { short: true }); }).join('\n\n');
    s.how_to_read = howToRead(o);
    s.limits = limitsSection(o);
    s.conclusion = para('These games shape the race more than any other in the conference this week. Projections are estimates, not picks.');
    return s;
  }
  function upsetOnlySections(o) {
    var s = {};
    s.intro = ctxIntro(o);
    s.upsets = upsetsSection(o, []);
    s.how_to_read = howToRead(o);
    s.limits = limitsSection(o);
    s.conclusion = conclusionSection(o);
    return s;
  }
  function performanceSections(o) {
    var P = o.research.performance || {}, ov = P.overall || {}, s = {};
    var ats = ov.ats || {}, sp = ov.spread || {}, clv = ov.clv || {};
    s.intro = para('Every week EdgeDesk grades the numbers it published before kickoff against what happened. This is that report for the ' + (o.league === 'cfb' ? 'college' : 'NFL') + ' model through Week ' + o.week + ': the wins and the misses, with the sample size beside every figure.');
    s.record = para(isNum(ov.n) ? 'Graded games: ' + ov.n + ' (' + String(ov.sample || '').toLowerCase() + ').' : null,
      isNum(sp.model_mae_paired) ? 'EdgeDesk’s average miss on the final margin was ' + oneDp(sp.model_mae_paired) + ' points, against ' + oneDp(sp.close_mae_paired) + ' for the closing line on the same games.' : null,
      isNum(ats.pct) ? 'Against the closing number, EdgeDesk’s side covered ' + oneDp(ats.pct) + '% of the time (95% interval ' + ats.ci95.join('–') + '%); about 52.4% is needed to break even at standard prices.' : null,
      isNum(clv.avg_points) ? 'Closing-line value averaged ' + oneDp(Math.abs(clv.avg_points)) + ' points ' + (clv.avg_points >= 0 ? 'in EdgeDesk’s favor' : 'against EdgeDesk') + ' over ' + clv.n + ' games with a captured close.' : null);
    var g7 = P.by_gap && P.by_gap['7+ pts'];
    s.where_it_missed = g7 && g7.spread && isNum(g7.spread.model_mae_paired) ? para('The biggest disagreements with the market were the weakest: in games where EdgeDesk was 7 or more points from the close, its average miss was ' + oneDp(g7.spread.model_mae_paired) + ' points, against ' + oneDp(g7.spread.close_mae_paired) + ' for the close.', 'That is why EdgeDesk treats a big gap as a question to investigate, not as a strong opinion.') : null;
    s.calibration = ov.win_probability && isNum(ov.win_probability.brier) ? para('Win probabilities scored a Brier score of ' + ov.win_probability.brier.toFixed(3) + ' (0.25 is what a coin flip scores; lower is better).') : null;
    s.how_to_read = para('A season’s results are a small sample. A record inside its interval is consistent with no edge at all, and EdgeDesk does not claim one on this evidence. A projection is not a bet.');
    s.conclusion = para('The numbers above are the record as published, never re-graded with hindsight. EdgeDesk will keep reporting them every week.');
    return s;
  }

  function sectionsFor(o, format, ctx) {
    var s = {};
    if (format === 'market_discrepancy' && o.research.games && o.research.games.length === 1 && o.research.games[0].gap) return mdSections(o);
    if (format === 'trending_story') return storySections(o);
    if (format === 'weekend_storylines') return storylinesSections(o);
    if (format === 'game_deep_dive') return deepDiveSections(o);
    if (format === 'conference_race' && o.research.conference) return raceSections(o);
    if (format === 'upset_watch') return upsetOnlySections(o);
    if (format === 'model_performance_review') return performanceSections(o);
    var gs = o.research.games || [];
    var angle = ctx.angle || 'full_slate';
    var shown = gs;
    if (angle === 'upsets_first' && o.research.upsets && o.research.upsets.length) {
      var ids = o.research.upsets.map(function (p) { return p.game_id; });
      shown = o.research.upsets.concat(gs.filter(function (p) { return ids.indexOf(p.game_id) < 0; })).slice(0, gs.length);
    }
    var maxGames = Math.min(ctx.maxGames || 5, 5);
    shown = shown.slice(0, maxGames);
    s.intro = ctxIntro(o);
    s.why_it_matters = whyItMatters(o);
    s.how_to_read = howToRead(o);
    /* ONE CENTRAL STORY (docs/system-integrity/TEMPLATES.md): the lead game in
       full, the supporting games short, so the piece reads as a story with
       context rather than a list of equal summaries */
    s.games = shown.map(function (p, i) { return capsule(p, { links: ctx.links, short: i > 0 }); }).join('\n\n');
    s.upsets = o.kind === 'upset_watch' ? null : upsetsSection(o, shown.map(function (p) { return p.game_id; }));
    s.conference = o.league === 'cfb' ? conferenceSection(o) : null;
    s.disagreements = o.league === 'nfl' || format === 'market_discrepancy' ? disagreementsSection(o) : null;
    s.injuries = o.league === 'nfl' ? injuriesSection(o) : null;
    s.limits = limitsSection(o);
    s.conclusion = conclusionSection(o);
    if (o.kind === 'upset_watch') {
      s.upsets = 'Whether an underdog is worth backing depends entirely on the price, which this article doesn’t assess. These are the games where the model says the favorite is more vulnerable than its billing.';
    }
    return s;
  }

  function sectionOrder(format, publisher) {
    var F = FORMATS[format] || FORMATS.cfb_weekly_preview;
    if (F.sections) return F.sections;
    var custom = publisher && publisher.editorial && publisher.editorial.sections;
    return Array.isArray(custom) && custom.length ? custom : FORMATS.cfb_weekly_preview.sections;
  }

  /* The article. ctx: { publisher, format, angle, campaign, now, links } */
  function draft(o, ctx) {
    ctx = ctx || {};
    var format = ctx.format || formatsFor(o)[0];
    if (formatsFor(o).indexOf(format) < 0) format = formatsFor(o)[0];
    var publisher = ctx.publisher || null;
    var ed = (publisher && publisher.editorial) || {};
    var links = ed.links_allowed !== false;
    var baseFormat = baseFormatOf(o, format);
    var maxGames = ed.max_games || (ed.length && ed.length.max && ed.length.max < 1200 ? 4 : 6);
    var raw = sectionsFor(o, baseFormat, { angle: ctx.angle, maxGames: maxGames, links: links });
    var preview = /_weekly_preview$/.test(baseFormat);
    var order = format === 'publisher_custom' && preview ? sectionOrder(format, publisher) : sectionOrder(baseFormat, publisher);
    var sections = [];
    order.forEach(function (k) {
      var body = raw[k];
      if (!body) return;
      sections.push({ key: k, heading: SECTION_HEADINGS[k] || null, body: body });
    });
    var seo = o.seo || seoBrief(o, publisher);
    var title = ctx.title || seo.headline || o.title;
    var a = {
      format: format, base_format: baseFormat, angle: ctx.angle || 'full_slate', title: title, slug: slugify(title), meta_description: seo.meta_description,
      primary_keyword: seo.primary_keyword, secondary_keywords: seo.secondary_keywords,
      standfirst: standfirstFor(o), sections: sections, generator: 'template:' + VERSION, generated_at: iso(isNum(ctx.now) ? ctx.now : Date.now()),
      research_as_of: o.research && o.research.as_of || null, research_hash: researchHash(o)
    };
    a.word_count = wordCount(a.standfirst + ' ' + sections.map(function (s) { return s.body; }).join(' '));
    return a;
  }
  function standfirstFor(o) {
    if (o.kind === 'weekly_preview') return 'EdgeDesk’s model projects the biggest games of Week ' + o.week + ', from the clear favorites to the upsets worth watching. Research, not picks.';
    if (o.kind === 'upset_watch') return 'The Week ' + o.week + ' underdogs EdgeDesk’s model gives a real chance, and why a possible upset is not the same thing as a bet.';
    if (o.kind === 'conference_race') return 'What EdgeDesk’s ratings and projections say about the ' + o.research.conference + ' race this week.';
    if (o.kind === 'market_discrepancy') return 'Where EdgeDesk’s projection and the betting line disagree, and what could explain the gap.';
    return 'The news, and what EdgeDesk’s numbers say about it, kept separate.';
  }
  function researchHash(o) { return hash(JSON.stringify(o && o.research || {})); }

  /* the outline: the brief plus the section plan, before any prose */
  function outline(o, ctx) {
    var a = draft(o, ctx);
    return {
      title: a.title, slug: a.slug, meta_description: a.meta_description, primary_keyword: a.primary_keyword,
      secondary_keywords: a.secondary_keywords, standfirst: a.standfirst,
      sections: a.sections.map(function (s) {
        var first = String(s.body).split(/\n\n/)[0];
        return { key: s.key, heading: s.heading, plan: first.length > 220 ? first.slice(0, 217).replace(/\s+\S*$/, '') + '…' : first };
      }),
      structure: (o.seo || {}).structure || []
    };
  }

  /* ======================================================================
     EVIDENCE + VALIDATE
     ====================================================================== */
  var NUM_RE = /(?:^|[^A-Za-z0-9.])(\d+(?:\.\d+)?)/g;
  function numbersIn(text) {
    var out = [], m;
    NUM_RE.lastIndex = 0;
    while ((m = NUM_RE.exec(text))) out.push(parseFloat(m[1]));
    return out;
  }
  function addNum(set, x) {
    if (!isNum(x)) return;
    var a = Math.abs(x);
    [a, r1(a), Math.round(a), Math.round(a * 100), r1(a * 100), Math.floor(a), Math.ceil(a)].forEach(function (v) { set[String(+v.toFixed(2))] = 1; });
  }
  function walk(x, fn, depth) {
    if (depth > 8 || x == null) return;
    if (Array.isArray(x)) { x.forEach(function (v) { walk(v, fn, depth + 1); }); return; }
    if (typeof x === 'object') { Object.keys(x).forEach(function (k) { walk(x[k], fn, depth + 1); }); return; }
    fn(x);
  }
  /* everything an article about this opportunity may say: numbers (with the
     rounding a writer would use), teams, people, sources */
  function evidenceOf(o) {
    var nums = {}, teams = {}, names = {}, srcs = [];
    var NAME_RE = /\b[A-Z][a-z]+(?:[-'’][A-Z][a-z]+)? [A-Z][a-z]+(?:[-'’][A-Z][a-z]+)?\b/g;
    /* the league-wide team list is for catching teams, never evidence of them */
    var research = Object.assign({}, o.research, { context: Object.assign({}, o.research.context, { team_names: undefined }) });
    walk(research, function (v) {
      if (typeof v === 'number') addNum(nums, v);
      else if (typeof v === 'string') {
        numbersIn(v).forEach(function (n) { addNum(nums, n); });
        /* a person the research itself names (a risk note, a quarterback battle) may be named */
        (v.length < 600 ? v.match(NAME_RE) || [] : []).forEach(function (n) { names[n] = 1; });
      }
    }, 0);
    /* derived numbers the writer prints: complements and the week */
    walk(research, function (v) { if (typeof v === 'number' && v > 0 && v < 1) addNum(nums, 1 - v); }, 0);
    [o.week, o.season].forEach(function (v) { addNum(nums, v); });
    for (var i = 0; i <= 12; i++) addNum(nums, i);
    [25, 30, 49, 50, 70, 95, 100, 180, 2024, 2025, 2026, 2027].forEach(function (v) { addNum(nums, v); });
    (o.research.games || []).concat(o.research.upsets || [], o.research.races || []).forEach(function (p) {
      teams[p.home] = 1; teams[p.away] = 1;
      [p.home_conference, p.away_conference, p.venue, p.market && p.market.book, p.market && bookName(p.market.book)].forEach(function (x) { if (x) names[x] = 1; });
      ['home', 'away'].forEach(function (s) { var q = p.qb && p.qb[s]; if (q && q.player) names[q.player] = 1;
        var inj = p.injuries && p.injuries[s]; (inj && inj.qbs || []).forEach(function (x) { names[x.name] = 1; }); });
    });
    ((o.research.context && o.research.context.top10) || []).forEach(function (t) { teams[t.team] = 1; });
    (o.research.conference_top || []).forEach(function (t) { teams[t] = 1; });
    (o.research.news || []).forEach(function (n) { (n.teams || []).forEach(function (t) { teams[t] = 1; }); numbersIn(n.title + ' ' + (n.summary || '')).forEach(function (x) { addNum(nums, x); }); });
    (o.sources || []).forEach(function (s) { srcs.push(s); });
    return { numbers: nums, teams: teams, names: names, sources: srcs };
  }

  function textOf(a) {
    return [a.title, a.standfirst, a.meta_description].concat((a.sections || []).map(function (s) { return (s.heading || '') + '\n' + s.body; })).join('\n\n');
  }
  function stripForNumbers(t) {
    return String(t)
      .replace(/\]\((https?:\/\/[^)\s]+)\)/g, ']')            /* link targets */
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/1-800-GAMBLER/gi, ' ').replace(/\b21\+/g, ' ')
      .replace(/\b(?:19|20)\d{2}\b/g, ' ');                    /* years */
  }
  function sentencesOf(t) { return String(t).replace(/\n+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z“"*(\-])/); }
  /* sentences that never run across a block: a heading, a list item or a
     paragraph ends a sentence even without a full stop, so a capsule's last
     line is never read together with the next game's heading. A paragraph
     wrapped over several lines stays one block. */
  function blockSentencesOf(t) {
    return [].concat.apply([], String(t)
      .replace(/\n(?=[ \t]*(?:#|[-*•][ \t]|\d+\.[ \t]|>|\|))/g, '\n\n')
      .replace(/(^|\n)([ \t]*#[^\n]*)\n/g, '$1$2\n\n')
      .split(/\n[ \t]*\n/)
      .map(function (b) { return sentencesOf(b.trim()); }))
      .filter(function (x) { return x && x.trim(); });
  }
  /* the same, plus each heading read with the sentence under it, so
     "### Florida at Texas" over "Kickoff 2:30 p.m." is still one claim */
  function headedSentencesOf(t) {
    var out = blockSentencesOf(t), lines = blockSentencesOf(String(t).replace(/(^|\n)([ \t]*#[^\n]*)\n/g, '$1$2\n\n'));
    lines.forEach(function (x, i) { if (/^\s*#/.test(x) && lines[i + 1]) out.push(x + ' ' + lines[i + 1]); });
    return out;
  }

  /* team names every league knows, so a team the evidence never mentions is
     caught. lists: { cfb: [names], nfl: [names] } supplied by the host (the
     admin page and the job pass the season's full lists). */
  function teamsMentioned(text, list, people) {
    var found = [], rest = ' ' + text + ' ';
    (people || []).forEach(function (n) { if (n) rest = rest.split(n).join(' '); });
    (list || []).slice().sort(function (a, b) { return b.length - a.length; }).forEach(function (n) {
      var re = new RegExp('(^|[^A-Za-z&])' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z])', 'g');
      if (re.test(rest)) { found.push(n); rest = rest.replace(re, '$1 '); }
    });
    return found;
  }

  /* opts: { publisher, now, siblings: [{id, title, text}], teamLists: {cfb:[], nfl:[]}, generator } */
  function validate(a, o, opts) {
    opts = opts || {};
    var now = isNum(opts.now) ? opts.now : Date.now();
    var checks = [];
    function add(id, status, label, detail) { checks.push({ id: id, status: status, label: label, detail: detail || null }); }
    var text = textOf(a);
    var body = (a.sections || []).map(function (s) { return s.body; }).join('\n\n');
    var ev = evidenceOf(o);
    var format = a.format || 'cfb_weekly_preview';
    var base = a.base_format || baseFormatOf(o, format);
    var F = FORMATS[base] || {};
    var ed = (opts.publisher && opts.publisher.editorial) || {};

    /* 1 structure */
    var keys = (a.sections || []).map(function (s) { return s.key; });
    var need = (F.required || []).filter(function (k) { return format !== 'publisher_custom' || /_weekly_preview$/.test(base) ? true : true; });
    if (format === 'publisher_custom' && /_weekly_preview$/.test(base)) need = FORMATS.publisher_custom.required;
    var missing = need.filter(function (k) { return keys.indexOf(k) < 0; });
    add('structure', missing.length ? 'fail' : 'pass', 'Required sections present', missing.length ? 'missing: ' + missing.join(', ') : null);
    var empty = (a.sections || []).filter(function (s) { return !s.body || wordCount(s.body) < 8; }).map(function (s) { return s.key; });
    if (empty.length) add('empty_sections', 'fail', 'No empty sections', empty.join(', '));
    if (!a.title || a.title.length < 20) add('headline', 'fail', 'Headline present', 'too short');
    else add('headline', a.title.length > 75 ? 'warn' : 'pass', 'Headline length', a.title.length + ' characters' + (a.title.length > 75 ? ' (search results cut off near 60–70)' : ''));

    /* 2 language */
    var banned = [];
    BANNED_RE.forEach(function (b) { var m = b.re.exec(text); if (m) banned.push('“' + m[0] + '” — ' + b.why); });
    add('no_recommendation', banned.length ? 'fail' : 'pass', 'No pick, lock, guarantee or staking language', banned.length ? banned.slice(0, 5).join(' · ') : null);
    var tells = AI_TELLS.filter(function (re) { return re.test(text); }).map(function (re) { var m = re.exec(text); return m && m[0]; });
    add('no_filler', tells.length ? 'warn' : 'pass', 'No generic AI filler', tells.length ? tells.join(', ') : null);
    add('no_stringified_nothing', STRINGIFIED_NOTHING.test(text) ? 'fail' : 'pass', 'No “null”, “undefined” or “NaN” in the copy');

    /* 3 numbers: every figure must be in the evidence */
    var unsupported = uniq(numbersIn(stripForNumbers(text)).filter(function (n) { return !ev.numbers[String(+n.toFixed(2))]; }));
    add('numbers_in_evidence', unsupported.length ? 'fail' : 'pass', 'Every number comes from EdgeDesk research or a cited source',
      unsupported.length ? 'not in the evidence: ' + unsupported.slice(0, 10).join(', ') : null);

    /* 4 teams: no team the research does not cover */
    var lists = opts.teamLists || {};
    var known = (lists[o.league] && lists[o.league].length ? lists[o.league] : ((o.research.context && o.research.context.team_names) || []));
    if (known.length) {
      /* a person's name is masked before teams are matched (Isaiah Marshall is
         not Marshall) — but never a name that is itself a team */
      var people = Object.keys(ev.names).filter(function (n) { return known.indexOf(n) < 0 && !known.some(function (t) { return n.indexOf(t) === 0 && n.length === t.length; }); });
      var extra = teamsMentioned(text, known, people).filter(function (t) { return !ev.teams[t]; });
      add('teams_in_evidence', extra.length ? 'fail' : 'pass', 'Every team named is in the research', extra.length ? 'not in this article’s research: ' + extra.join(', ') : null);
    }
    /* people: capitalised two-word names that are not teams or evidence */
    var people = [], pm, PRE = /\b([A-Z][a-z]+(?:[-'’][A-Z][a-z]+)? [A-Z][a-z]+(?:[-'’][A-Z][a-z]+)?)\b/g;
    var allowWords = /^(EdgeDesk|Research|The|Projected|Model|Full|Bottom|Week|What|Why|How|Upset|Injury|Matchup|Sportsbook|Search|Gamble|Nothing|College|National|Football|League|Pass|Run|Team|Home|Stylistic|Official|Not|Prices|Quarterbacks|Uncertainty|Injuries|For|From|Each|These|None|This|That|It|If|When|Here|Every|Most|Some|Sat|Sun|Mon|Tue|Wed|Thu|Fri|Oct|Sept|Nov|Dec|Jan|Aug)\b/;
    var teamWords = Object.keys(ev.teams).join(' ');
    while ((pm = PRE.exec(body))) {
      var nm = pm[1];
      if (ev.names[nm] || allowWords.test(nm) || teamWords.indexOf(nm) >= 0 || Object.keys(ev.names).some(function (x) { return x.indexOf(nm) >= 0; })) continue;
      if (known.some(function (t) { return t.indexOf(nm) >= 0 || nm.indexOf(t) >= 0; })) continue;
      people.push(nm);
    }
    people = uniq(people);
    add('names_in_evidence', people.length ? 'warn' : 'pass', 'People named appear in the research', people.length ? 'check: ' + people.slice(0, 8).join(', ') : null);

    /* 5 projection is not betting value */
    var hasExplainer = /not a bet|isn’t a bet|is not a bet|not the same thing as a bet|not betting advice/i.test(body);
    add('projection_not_value', hasExplainer ? 'pass' : 'fail', 'Explains that a projection is not a bet', hasExplainer ? null : 'add the “how to read” explanation');

    /* 6 stale prices never presented as current */
    var staleBad = [];
    (o.research.games || []).forEach(function (p) {
      if (!p.market || p.market.status === 'current' || p.market.status === 'none' || !isNum(p.market.home_line)) return;
      var mf = favOf(p.home, p.away, p.market.home_line);
      var needle = mf && mf.favorite ? mf.favorite + ' -' + lineNum(mf.margin) : null;
      if (!needle) return;
      sentencesOf(body).forEach(function (s) {
        if (s.indexOf(needle) >= 0 && !/captured|as of|reference|stale|older|last line|last sportsbook|no capture|freshness|was\b/i.test(s)) staleBad.push(needle);
      });
      if (/\b(?:current|live) (?:line|price|odds)\b/i.test(body) && p.market.status !== 'current' && body.indexOf(needle) >= 0) {
        sentencesOf(body).forEach(function (s) { if (s.indexOf(needle) >= 0 && /\b(?:current|live) (?:line|price|odds)\b/i.test(s)) staleBad.push(needle + ' called current'); });
      }
    });
    add('stale_prices_labelled', staleBad.length ? 'fail' : 'pass', 'Old or reference prices are labelled with their age', staleBad.length ? uniq(staleBad).join(', ') : null);

    /* 7 games already started */
    var started = (o.research.games || []).filter(function (p) { var t = ts(p.kickoff); return t != null && t <= now; });
    add('games_not_started', started.length ? 'warn' : 'pass', 'Featured games have not kicked off', started.length ? started.map(function (p) { return p.away + ' at ' + p.home; }).join(', ') + ' — refresh or remove' : null);

    /* 8 research freshness at validation time */
    var asOf = ts(o.research.as_of);
    var ageH = asOf == null ? null : (now - asOf) / 3600000;
    add('research_fresh', ageH == null ? 'warn' : ageH > 36 ? 'warn' : 'pass', 'Research is recent', ageH == null ? 'research has no timestamp' : 'research is ' + Math.round(ageH) + ' hours old' + (ageH > 36 ? ' — refresh the opportunity before sending' : ''));

    /* 9 external reporting attributed */
    var ext = (o.sources || []).filter(function (s) { return s.kind === 'external_report'; });
    if (ext.length) {
      var unattributed = ext.filter(function (s) { return body.indexOf(s.publisher) < 0 || body.indexOf(s.url) < 0; });
      add('reporting_attributed', unattributed.length ? 'fail' : 'pass', 'External reporting is attributed and linked', unattributed.length ? unattributed.map(function (s) { return s.publisher; }).join(', ') : null);
    }
    if (/\b(?:reportedly|sources say|according to reports)\b/i.test(body) && !ext.length) add('unsourced_reporting', 'fail', 'No unsourced reporting', 'the article cites reporting with no source on file');

    /* 10 disclaimer + attribution are added at export; check the publisher permits a link */
    add('disclaimer', 'pass', 'Disclaimer (21+, 1-800-GAMBLER) is added to every export', DISCLAIMER);

    /* 11 length */
    var wc = a.word_count || wordCount(body);
    /* a publisher's length target is for its weekly previews; a news story
       or a one-game analysis keeps its own format's range */
    var range = (/_weekly_preview$/.test(base) && ed.length && ed.length.min && ed.length.max) ? [ed.length.min, ed.length.max] : (F.words || [500, 2000]);
    add('length', wc < range[0] * 0.8 || wc > range[1] * 1.25 ? 'warn' : 'pass', 'Length fits the target', wc + ' words (target ' + range[0] + '–' + range[1] + ')');

    /* 12 SEO */
    var kw = String(a.primary_keyword || '').toLowerCase();
    if (kw) {
      var stem = function (t) { return t.replace(/(?:es|s)$/, ''); };
      var kwTokens = kw.split(/\s+/).filter(function (t) { return t.length > 2; }).map(stem);
      var inTitle = kwTokens.every(function (t) { return a.title.toLowerCase().indexOf(t) >= 0; });
      var first = words(body).slice(0, 150).join(' ').toLowerCase();
      var inIntro = kwTokens.filter(function (t) { return first.indexOf(t) >= 0; }).length >= Math.ceil(kwTokens.length * 0.75);
      add('seo_keyword', inTitle && inIntro ? 'pass' : 'warn', 'Primary keyword in the headline and opening', (inTitle ? '' : 'not in headline; ') + (inIntro ? '' : 'not in the first 150 words'));
    }
    var md = String(a.meta_description || '');
    add('seo_meta', md.length >= 90 && md.length <= 160 ? 'pass' : 'warn', 'Meta description 90–160 characters', md.length + ' characters');
    add('seo_slug', /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(a.slug || '') && (a.slug || '').length <= 80 ? 'pass' : 'warn', 'URL slug is clean', a.slug || null);
    var stuffing = kw ? (text.toLowerCase().split(kw).length - 1) : 0;
    if (stuffing > 4) add('seo_stuffing', 'warn', 'No keyword stuffing', 'primary keyword appears ' + stuffing + ' times');

    /* 13 near-duplicates among articles from the same research */
    var dup = (opts.siblings || []).map(function (sb) { return { id: sb.id, title: sb.title, sim: similarity(body, sb.text) }; })
      .sort(function (x, y) { return y.sim - x.sim; })[0];
    if (dup) add('not_duplicate', dup.sim >= 0.7 ? 'fail' : dup.sim >= 0.45 ? 'warn' : 'pass', 'Original against sibling articles', 'closest: ' + Math.round(dup.sim * 100) + '% overlap with “' + dup.title + '”');

    /* ── EDITORIAL INTEGRITY (docs/system-integrity/RULES.md §EDIT) ──────────
       Deterministic rules over the article and the packets it was written
       from. Any failure here sets integrity_status BLOCKED, which the
       database refuses at approval, ready-to-send and Send. */
    var IG = [];
    function ig(id, rule, status, label, detail) { add(id, status, label, detail); IG.push({ rule_id: rule, status: status, explanation: detail || label }); }
    var gamesAll = (o.research.games || []).concat(o.research.upsets || [], o.research.races || []);
    var byGid = {}; gamesAll.forEach(function (p) { if (p && p.game_id != null) byGid[p.game_id] = p; });
    var featured = Object.keys(byGid).map(function (k) { return byGid[k]; });
    ig('integrity_engine', 'EDIT.ENGINE', INTEGRITY_OK ? 'pass' : 'fail', 'The integrity engine ran', INTEGRITY_OK ? null : 'lib/edgedesk_calc.js, edgedesk_schedule.js, edgedesk_availability.js or edgedesk_integrity.js did not load: nothing can be verified');
    var unpub = featured.filter(function (p) { return p.publishable === false; });
    ig('games_publishable', 'EDIT.GAMES_VALID', unpub.length ? 'fail' : 'pass', 'Every featured game is cleared for publication',
      unpub.length ? unpub.map(function (p) { return p.away + ' at ' + p.home + ' (' + ((p.integrity && p.integrity.public && p.integrity.public.blocking) || []).map(function (b) { return b.rule_id; }).join(', ') + ')'; }).join('; ') : null);
    /* numbers tied to the game they are written about */
    var gameTeams = {};
    featured.forEach(function (p) { [p.home, p.away].forEach(function (t) { if (t) (gameTeams[t] = gameTeams[t] || []).push(p.game_id); }); });
    var teamNames = Object.keys(gameTeams);
    var gameNums = {};
    function numsOfGame(p) {
      if (gameNums[p.game_id]) return gameNums[p.game_id];
      var set = {};
      walk(p, function (v) { if (typeof v === 'number') addNum(set, v); else if (typeof v === 'string') numbersIn(v).forEach(function (n) { addNum(set, n); }); }, 0);
      walk(p, function (v) { if (typeof v === 'number' && v > 0 && v < 1) addNum(set, 1 - v); }, 0);
      gameNums[p.game_id] = set; return set;
    }
    var GENERIC = {}; [o.week, o.season].forEach(function (v) { addNum(GENERIC, v); });
    for (var gi = 0; gi <= 12; gi++) addNum(GENERIC, gi);
    [25, 30, 49, 50, 70, 95, 100, 180].forEach(function (v) { addNum(GENERIC, v); });
    var misplaced = [];
    blockSentencesOf(stripForNumbers(body)).forEach(function (sent) {
      var ts0 = teamsMentioned(sent, teamNames, []);
      if (!ts0.length) return;
      var ids = uniq([].concat.apply([], ts0.map(function (t) { return gameTeams[t] || []; })));
      numbersIn(sent).forEach(function (n) {
        var key = String(+n.toFixed(2));
        if (GENERIC[key]) return;
        if (ids.some(function (id) { return numsOfGame(byGid[id])[key]; })) return;
        misplaced.push(n + ' (in a sentence about ' + ts0.join(' and ') + ')');
      });
    });
    ig('numbers_per_game', 'EDIT.NUMBERS', misplaced.length ? 'fail' : 'pass', 'Every number belongs to the game it is written about',
      misplaced.length ? 'not in that game’s research: ' + uniq(misplaced).slice(0, 6).join('; ') : null);
    /* quarterback and availability claims need a sourced report */
    if (AVAIL) {
      var byTeam = {};
      featured.forEach(function (p) { ['home', 'away'].forEach(function (s) {
        var c = p.availability && p.availability[s], team = s === 'home' ? p.home : p.away;
        if (!c) return; (byTeam[team] = byTeam[team] || []).push(c); if (c.player) (byTeam[c.player] = byTeam[c.player] || []).push(c);
      }); });
      var qbIssues = AVAIL.guardProse(body, byTeam);
      ig('qb_claims_sourced', 'EDIT.QB_UNCERTAINTY', qbIssues.length ? 'fail' : 'pass', 'Quarterback and injury uncertainty only from a sourced report',
        qbIssues.length ? qbIssues.slice(0, 3).map(function (q) { return q.reason + ': “' + q.sentence.slice(0, 120) + '”'; }).join(' · ') : null);
    }
    /* conference claims match the teams in the sentence */
    var CONFS = ['SEC', 'Big Ten', 'Big 12', 'ACC', 'Pac-12', 'American', 'Mountain West', 'MAC', 'Sun Belt', 'Conference USA', 'AFC', 'NFC'];
    var confBad = [];
    if (o.league === 'cfb') blockSentencesOf(body).forEach(function (sent) {
      var ts1 = teamsMentioned(sent, teamNames, []);
      if (!ts1.length) return;
      CONFS.forEach(function (c) {
        if (!new RegExp('(^|[^A-Za-z-])' + c.replace(/[-]/g, '\\-') + '(?![A-Za-z])').test(sent)) return;
        var confsOf = [];
        ts1.forEach(function (t) { (gameTeams[t] || []).forEach(function (id) { var p = byGid[id]; confsOf.push(t === p.home ? p.home_conference : p.away_conference); }); });
        if (confsOf.indexOf(c) < 0 && !/conference(?:’s|'s)? (?:three )?highest|power-conference|non-conference/i.test(sent)) confBad.push(c + ' with ' + ts1.join(', '));
      });
    });
    ig('conference_claims', 'EDIT.CONFERENCE', confBad.length ? 'fail' : 'pass', 'Conference claims match the teams', confBad.length ? 'no team in the sentence plays in: ' + uniq(confBad).slice(0, 4).join('; ') : null);
    /* a TBA kickoff is never printed as a clock time */
    var tbaBad = [];
    featured.filter(function (p) { return p.kickoff_verified === false; }).forEach(function (p) {
      headedSentencesOf(text).forEach(function (sent) {
        if (sent.indexOf(p.home) >= 0 && sent.indexOf(p.away) >= 0 && /\b\d{1,2}(?::\d{2})? ?(?:a\.m\.|p\.m\.|am|pm)/i.test(sent)) tbaBad.push(p.away + ' at ' + p.home);
      });
    });
    ig('kickoff_claims', 'EDIT.KICKOFF', tbaBad.length ? 'fail' : 'pass', 'An unannounced kickoff is never given a time', tbaBad.length ? uniq(tbaBad).join(', ') + ': the schedule has not set a time' : null);
    /* no spread that contradicts the snapshot */
    var lineBad = [];
    featured.forEach(function (p) {
      var ok = {};
      function allow(team, line) { if (team && isNum(line)) (ok[team] = ok[team] || {})[r1(line).toFixed(1)] = 1; }
      if (p.model && p.model.available && p.model.favorite) { allow(p.model.favorite, -p.model.margin); allow(p.model.underdog, p.model.margin); }
      if (p.market && isNum(p.market.home_line)) { allow(p.home, p.market.home_line); allow(p.away, -p.market.home_line); }
      [p.home, p.away].forEach(function (team) {
        var re = new RegExp('(^|[^A-Za-z])' + team.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' ([+\\-−])(\\d+(?:\\.\\d)?)(?![\\d.])', 'g'), m;
        while ((m = re.exec(body))) {
          var v = (m[2] === '+' ? 1 : -1) * parseFloat(m[3]);
          if (!(ok[team] && ok[team][r1(v).toFixed(1)])) lineBad.push(team + ' ' + m[2] + m[3]);
        }
        var re2 = new RegExp('(^|[^A-Za-z])' + team.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' by (\\d+(?:\\.\\d)?)\\b', 'g'), m2;
        while ((m2 = re2.exec(body))) {
          var v2 = parseFloat(m2[2]);
          var mm = p.model && p.model.favorite === team ? r1(p.model.margin) : null;
          var km = p.market && isNum(p.market.home_line) ? (team === p.home ? -r1(p.market.home_line) : r1(p.market.home_line)) : null;
          if (v2 !== mm && v2 !== km) lineBad.push(team + ' by ' + m2[2]);
        }
      });
    });
    ig('spread_claims', 'EDIT.CONTRADICTION', lineBad.length ? 'fail' : 'pass', 'Every spread printed matches the research snapshot', lineBad.length ? 'not EdgeDesk’s number or the quoted line: ' + uniq(lineBad).slice(0, 6).join(', ') : null);
    /* the research the draft was written on is still the research on file */
    if (opts.current_research_hash) {
      var stale = a.research_hash && a.research_hash !== opts.current_research_hash;
      ig('snapshot_current', 'EDIT.SNAPSHOT', stale ? 'fail' : 'pass', 'Written on the current research snapshot', stale ? 'the research changed after this draft was written: refresh it' : null);
    }
    var igFail = IG.filter(function (x) { return x.status === 'fail'; });
    var igWarn = checks.filter(function (c) { return c.status === 'warn'; }).length > 0 || featured.some(function (p) { return p.integrity && p.integrity.public && p.integrity.public.status === 'WARNING'; });
    var integrity = { version: INTEG ? INTEG.VERSION : null, status: igFail.length ? 'BLOCKED' : (igWarn ? 'WARNING' : 'PASS'),
      blocking: igFail.map(function (x) { return { rule_id: x.rule_id, explanation: x.explanation }; }),
      games: featured.map(function (p) { return { game_id: p.game_id, record_id: p.record_id || null, status: p.integrity && p.integrity.public ? p.integrity.public.status : 'UNKNOWN' }; }) };

    var fails = checks.filter(function (c) { return c.status === 'fail'; });
    var warns = checks.filter(function (c) { return c.status === 'warn'; });
    return {
      ok: fails.length === 0, checks: checks, failed: fails.map(function (c) { return c.id; }), warned: warns.map(function (c) { return c.id; }),
      /* the verdict the database enforces (supabase/content_engine.sql integrity_ok) */
      integrity_status: integrity.status, integrity: integrity,
      checked_at: iso(now), version: VERSION
    };
  }

  /* 5-word shingle Jaccard similarity */
  function shingles(t) {
    var w = words(String(t || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')), out = {};
    for (var i = 0; i + 5 <= w.length; i++) out[w.slice(i, i + 5).join(' ')] = 1;
    return out;
  }
  function similarity(a, b) {
    var A = shingles(a), B = shingles(b), inter = 0, na = 0, nb = 0;
    Object.keys(A).forEach(function (k) { na++; if (B[k]) inter++; });
    nb = Object.keys(B).length;
    var union = na + nb - inter;
    return union ? inter / union : 0;
  }

  /* ======================================================================
     ATTRIBUTION + EXPORT
     ====================================================================== */
  /* utm_campaign as growth.sql keeps it: lowercase [a-z0-9_.-], ≤ 64 */
  function campaignCode(publisherSlug, articleId) {
    var p = String(publisherSlug || 'direct').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'direct';
    var a = String(articleId || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || hash(String(Date.now())).slice(0, 8);
    return ('ce_' + p + '_' + a).slice(0, 64);
  }
  function tagLink(url, utm) {
    utm = utm || {};
    var u;
    try { u = new URL(url); } catch (e) { return url; }
    if (!/(^|\.)edgedesksports\.com$/.test(u.hostname)) return url; /* only EdgeDesk links are tagged */
    if (utm.source) u.searchParams.set('utm_source', String(utm.source).toLowerCase().replace(/[^a-z0-9_.-]/g, ''));
    if (utm.medium) u.searchParams.set('utm_medium', String(utm.medium).toLowerCase().replace(/[^a-z0-9_.-]/g, ''));
    if (utm.campaign) u.searchParams.set('utm_campaign', String(utm.campaign).toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 64));
    if (utm.content) u.searchParams.set('utm_content', String(utm.content).toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 64));
    return u.toString();
  }
  function utmFor(publisher, a, campaign) {
    return { source: (publisher && (publisher.utm_source || publisher.slug)) || 'direct', medium: 'publisher', campaign: campaign, content: a.format };
  }
  /* rewrite every EdgeDesk link in a body with the article's UTM tags */
  function tagBody(md, utm) {
    return String(md).replace(/\]\((https:\/\/(?:www\.)?edgedesksports\.com[^)\s]*)\)/g, function (_, u) { return '](' + tagLink(u, utm) + ')'; });
  }

  function attributionFor(a, o, ctx) {
    ctx = ctx || {};
    var pub = ctx.publisher, ed = (pub && pub.editorial) || {};
    var asOf = o && o.research && ts(o.research.as_of);
    var league = o && o.league === 'nfl' ? 'NFL' : 'college football';
    var line = 'Research by EdgeDesk Sports, an independent sports research platform. Projections are from EdgeDesk’s ' + league + ' model' + (asOf ? ' as of ' + whenText(asOf) : '') + '.';
    if (ed.links_allowed === false) return line + (ed.attribution ? ' ' + ed.attribution : '');
    var landing = ctx.landing || SITE + '/today/';
    return line + ' See every game’s numbers at [EdgeDesk](' + tagLink(landing, utmFor(pub, a, ctx.campaign)) + ').' + (ed.attribution ? ' ' + ed.attribution : '');
  }

  /* ctx: { publisher, campaign, frontMatter: bool, opportunity } */
  function toMarkdown(a, ctx) {
    ctx = ctx || {};
    var utm = utmFor(ctx.publisher, a, ctx.campaign);
    var out = [];
    if (ctx.frontMatter) {
      out.push('---');
      out.push('title: ' + JSON.stringify(a.title));
      out.push('slug: ' + JSON.stringify(a.slug));
      out.push('meta_description: ' + JSON.stringify(a.meta_description || ''));
      out.push('primary_keyword: ' + JSON.stringify(a.primary_keyword || ''));
      out.push('secondary_keywords: ' + JSON.stringify(a.secondary_keywords || []));
      if (ctx.snapshot) {
        out.push('edgedesk_revision: ' + JSON.stringify(ctx.snapshot.revision));
        out.push('edgedesk_content_hash: ' + JSON.stringify(ctx.snapshot.content_hash || ''));
        out.push('edgedesk_research_hash: ' + JSON.stringify(ctx.snapshot.research_hash || ''));
        out.push('edgedesk_research_as_of: ' + JSON.stringify(ctx.snapshot.research_as_of || ''));
        out.push('edgedesk_approved: ' + JSON.stringify(!!(ctx.snapshot.approved_hash && ctx.snapshot.approved_hash === ctx.snapshot.content_hash)));
      }
      out.push('---', '');
    }
    out.push('# ' + a.title, '');
    if (a.standfirst) out.push('*' + a.standfirst + '*', '');
    (a.sections || []).forEach(function (s) {
      if (s.heading) out.push('## ' + s.heading, '');
      out.push(tagBody(s.body, utm), '');
    });
    out.push('---', '');
    out.push(tagBody(attributionFor(a, ctx.opportunity, ctx), utm), '');
    out.push('*' + DISCLAIMER + '*', '');
    return out.join('\n');
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]; }); }
  /* the small Markdown subset the writer uses: paragraphs, ### headings,
     "- " bullets, **bold**, *italic*, [text](https://…). Everything else is
     text, escaped. */
  function inline(s) {
    var t = esc(s);
    t = t.replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, function (_, txt, url) { return '<a href="' + url.replace(/&amp;/g, '&').replace(/"/g, '%22').replace(/&/g, '&amp;') + '" rel="noopener">' + txt + '</a>'; });
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    return t;
  }
  function mdToHtml(md) {
    var blocks = String(md || '').split(/\n{2,}/), out = [];
    blocks.forEach(function (b) {
      b = b.replace(/^\n+|\n+$/g, '');
      if (!b) return;
      if (/^### /.test(b)) { out.push('<h3>' + inline(b.slice(4)) + '</h3>'); return; }
      if (/^## /.test(b)) { out.push('<h2>' + inline(b.slice(3)) + '</h2>'); return; }
      if (/^# /.test(b)) { out.push('<h1>' + inline(b.slice(2)) + '</h1>'); return; }
      if (/^---$/.test(b)) { out.push('<hr>'); return; }
      var lines = b.split('\n');
      if (lines.every(function (l) { return /^- /.test(l); })) { out.push('<ul>' + lines.map(function (l) { return '<li>' + inline(l.slice(2)) + '</li>'; }).join('') + '</ul>'); return; }
      out.push('<p>' + lines.map(inline).join('<br>') + '</p>');
    });
    return out.join('\n');
  }
  /* ctx as toMarkdown, plus standalone: a complete document for preview */
  function toHtml(a, ctx) {
    ctx = ctx || {};
    var md = toMarkdown(a, Object.assign({}, ctx, { frontMatter: false }));
    var body = mdToHtml(md);
    if (!ctx.standalone) return body;
    return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
      + '<meta name="robots" content="noindex,nofollow"><title>' + esc(a.title) + '</title>'
      + '<meta name="description" content="' + esc(a.meta_description || '') + '">'
      + (ctx.snapshot ? '<meta name="edgedesk-snapshot" content="' + esc(snapshotLine(ctx.snapshot)) + '">' : '')
      + '<style>body{font:17px/1.6 Georgia,serif;max-width:720px;margin:32px auto;padding:0 16px;color:#1d1d1f;background:#fff}h1{font:700 30px/1.2 system-ui,sans-serif}h2{font:700 21px/1.3 system-ui,sans-serif;margin-top:32px}h3{font:600 17px/1.35 system-ui,sans-serif;margin-top:22px}a{color:#0b6e63}hr{border:0;border-top:1px solid #ddd;margin:28px 0}em{color:#555}</style>'
      + '</head><body>\n' + body + '\n</body></html>\n';
  }
  /* the SEO sheet that travels with an export */
  function seoSheet(a, o) {
    var s = (o && o.seo) || {};
    return [
      'Headline: ' + a.title,
      'Alternatives: ' + (s.alternatives || []).join(' | '),
      'Slug: ' + a.slug,
      'Meta description: ' + (a.meta_description || ''),
      'Primary keyword: ' + (a.primary_keyword || ''),
      'Secondary keywords: ' + (a.secondary_keywords || []).join(', '),
      'Search intent: ' + (s.intent || ''),
      'Demand: ' + ((s.demand && s.demand.note) || 'estimate'),
      'Internal links: ' + (s.internal_links || []).map(function (l) { return l.url; }).join(' '),
      'External links: ' + ((s.external_links || []).map(function (l) { return l.url; }).join(' ') || 'none')
    ].join('\n');
  }

  /* ======================================================================
     WORD (.docx) — the copy an editor touches up. Built here, with no
     dependency: the same Markdown the other exports use, as WordprocessingML
     (headings as Word headings, so Google Docs keeps them too; bullets, bold,
     italic, live links), zipped with stored entries. The tagged EdgeDesk link,
     the research credit and the disclaimer are in it, and a last page "For
     the editor" (not for publication) carries the SEO sheet and asks that
     those three stay. Returns a Uint8Array.
     ====================================================================== */
  var CRC_TABLE = null;
  function crc32(bytes) {
    if (!CRC_TABLE) {
      CRC_TABLE = [];
      for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c >>> 0; }
    }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function utf8(s) { return new TextEncoder().encode(String(s)); }
  /* files: [{ name, data: string }] → a ZIP (stored, no compression) */
  function zipStore(files) {
    var parts = [], central = [], offset = 0;
    var DOS_TIME = 0, DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; /* fixed: the same article gives the same bytes */
    files.forEach(function (f) {
      var name = utf8(f.name), data = utf8(f.data), crc = crc32(data);
      var h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0, true); h.setUint16(8, 0, true);
      h.setUint16(10, DOS_TIME, true); h.setUint16(12, DOS_DATE, true); h.setUint32(14, crc, true);
      h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      parts.push(new Uint8Array(h.buffer), name, data);
      var c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0, true); c.setUint16(10, 0, true);
      c.setUint16(12, DOS_TIME, true); c.setUint16(14, DOS_DATE, true); c.setUint32(16, crc, true);
      c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true);
      c.setUint32(42, offset, true);
      central.push(new Uint8Array(c.buffer), name);
      offset += 30 + name.length + data.length;
    });
    var cdSize = central.reduce(function (n, b) { return n + b.length; }, 0);
    var e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
    var all = parts.concat(central, [new Uint8Array(e.buffer)]);
    var out = new Uint8Array(all.reduce(function (n, b) { return n + b.length; }, 0)), at = 0;
    all.forEach(function (b) { out.set(b, at); at += b.length; });
    return out;
  }
  /* text safe inside XML: escaped, and without the control characters XML forbids */
  function xesc(s) {
    return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
      .replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }
  /* the writer's inline subset → runs: { t, b, i, link } */
  function docxRuns(s) {
    var out = [], re = /\[([^\]]+)\]\((https:\/\/[^)\s]+)\)|\*\*([^*]+)\*\*|(^|[\s(])\*([^*\s][^*]*)\*/g, last = 0, m;
    while ((m = re.exec(s))) {
      var lead = m[4] || '';
      var start = m.index + lead.length;
      if (start > last) out.push({ t: s.slice(last, start) });
      if (m[1] != null) out.push({ t: m[1], link: m[2] });
      else if (m[3] != null) out.push({ t: m[3], b: true });
      else out.push({ t: m[5], i: true });
      last = re.lastIndex;
    }
    if (last < s.length) out.push({ t: s.slice(last) });
    return out;
  }
  function toDocx(a, ctx) {
    ctx = ctx || {};
    var md = toMarkdown(a, Object.assign({}, ctx, { frontMatter: false }));
    var links = [];
    function run(r, extra) {
      var pr = (r.b ? '<w:b/>' : '') + (r.i ? '<w:i/>' : '') + (extra || '');
      return '<w:r>' + (pr ? '<w:rPr>' + pr + '</w:rPr>' : '') + '<w:t xml:space="preserve">' + xesc(r.t) + '</w:t></w:r>';
    }
    function runs(text, allItalic) {
      return docxRuns(text).map(function (r) {
        if (allItalic) r.i = true;
        if (!r.link) return run(r);
        links.push(r.link);
        return '<w:hyperlink r:id="rIdL' + links.length + '" w:history="1">' + run(r, '<w:rStyle w:val="Hyperlink"/>') + '</w:hyperlink>';
      }).join('');
    }
    function para(style, inner, extraPr) {
      var pr = (style ? '<w:pStyle w:val="' + style + '"/>' : '') + (extraPr || '');
      return '<w:p>' + (pr ? '<w:pPr>' + pr + '</w:pPr>' : '') + inner + '</w:p>';
    }
    var body = [];
    String(md).split(/\n{2,}/).forEach(function (b) {
      b = b.replace(/^\n+|\n+$/g, '');
      if (!b) return;
      if (/^# /.test(b)) { body.push(para('Title', runs(b.slice(2)))); return; }
      if (/^## /.test(b)) { body.push(para('Heading2', runs(b.slice(3)))); return; }
      if (/^### /.test(b)) { body.push(para('Heading3', runs(b.slice(4)))); return; }
      if (/^---$/.test(b)) { body.push(para(null, '', '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="CCCCCC"/></w:pBdr>')); return; }
      var lines = b.split('\n');
      if (lines.every(function (l) { return /^- /.test(l); })) {
        lines.forEach(function (l) { body.push(para('ListParagraph', runs(l.slice(2)), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>')); });
        return;
      }
      /* a whole paragraph in *…* (the standfirst, the disclaimer) is italic */
      var whole = /^\*([^*][\s\S]*[^*])\*$/.exec(b);
      if (whole && lines.length === 1) { body.push(para(null, runs(whole[1], true))); return; }
      body.push(para(null, lines.map(function (l) { return runs(l); }).join('<w:r><w:br/></w:r>')));
    });
    if (ctx.editorNotes !== false) {
      body.push(para('Heading1', runs('For the editor (not for publication)'), '<w:pageBreakBefore/>'));
      body.push(para(null, runs('Edit freely for your style. Please keep three things: the EdgeDesk link (it is tagged so we can count the readers you send us), the research credit, and the 21+ responsible-gambling line. If you change a projection, a number or a team’s chances, please check it with us first: those come straight from EdgeDesk’s model.')));
      if (ctx.snapshot) body.push(para(null, run({ t: snapshotLine(ctx.snapshot) })));
      seoSheet(a, ctx.opportunity).split('\n').forEach(function (l) {
        var k = l.indexOf(': ');
        body.push(para(null, k > 0 ? run({ t: l.slice(0, k + 1), b: true }) + run({ t: ' ' + l.slice(k + 2) }) : runs(l)));
      });
    }
    var W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    var R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    var XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    var doc = XML + '<w:document ' + W + ' xmlns:r="' + R + '"><w:body>' + body.join('')
      + '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>';
    function style(id, name, type, rpr, ppr, extra) {
      return '<w:style w:type="' + type + '" w:styleId="' + id + '"><w:name w:val="' + name + '"/>' + (extra || '') + (ppr ? '<w:pPr>' + ppr + '</w:pPr>' : '') + (rpr ? '<w:rPr>' + rpr + '</w:rPr>' : '') + '</w:style>';
    }
    var head = function (lvl, sz) { return ['<w:keepNext/><w:spacing w:before="' + (lvl === 0 ? 360 : 280) + '" w:after="120"/><w:outlineLvl w:val="' + lvl + '"/>', '<w:b/><w:sz w:val="' + sz + '"/>']; };
    var h1 = head(0, 32), h2 = head(1, 28), h3 = head(2, 24);
    var styles = XML + '<w:styles ' + W + '>'
      + '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>'
      + '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
      + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
      + style('Title', 'Title', 'paragraph', '<w:b/><w:sz w:val="44"/>', '<w:spacing w:after="200"/>', '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>')
      + style('Heading1', 'heading 1', 'paragraph', h1[1], h1[0], '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>')
      + style('Heading2', 'heading 2', 'paragraph', h2[1], h2[0], '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>')
      + style('Heading3', 'heading 3', 'paragraph', h3[1], h3[0], '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>')
      + style('ListParagraph', 'List Paragraph', 'paragraph', null, '<w:spacing w:after="80"/><w:ind w:left="720"/>', '<w:basedOn w:val="Normal"/><w:qFormat/>')
      + style('Hyperlink', 'Hyperlink', 'character', '<w:color w:val="0B6E63"/><w:u w:val="single"/>', null, '<w:uiPriority w:val="99"/><w:unhideWhenUsed/>')
      + '</w:styles>';
    var numbering = XML + '<w:numbering ' + W + '><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/>'
      + '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>'
      + '</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>';
    var REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
    var docRels = XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rIdS" Type="' + REL + 'styles" Target="styles.xml"/>'
      + '<Relationship Id="rIdN" Type="' + REL + 'numbering" Target="numbering.xml"/>'
      + links.map(function (u, i) { return '<Relationship Id="rIdL' + (i + 1) + '" Type="' + REL + 'hyperlink" Target="' + xesc(u) + '" TargetMode="External"/>'; }).join('')
      + '</Relationships>';
    var CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.';
    var types = XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/word/document.xml" ContentType="' + CT + 'document.main+xml"/>'
      + '<Override PartName="/word/styles.xml" ContentType="' + CT + 'styles+xml"/>'
      + '<Override PartName="/word/numbering.xml" ContentType="' + CT + 'numbering+xml"/>'
      + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>';
    var rels = XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="' + REL + 'officeDocument" Target="word/document.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>';
    var core = XML + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">'
      + '<dc:title>' + xesc(a.title) + '</dc:title><dc:description>' + xesc(a.meta_description || '') + '</dc:description><dc:creator>EdgeDesk Sports</dc:creator></cp:coreProperties>';
    return zipStore([
      { name: '[Content_Types].xml', data: types },
      { name: '_rels/.rels', data: rels },
      { name: 'docProps/core.xml', data: core },
      { name: 'word/document.xml', data: doc },
      { name: 'word/_rels/document.xml.rels', data: docRels },
      { name: 'word/styles.xml', data: styles },
      { name: 'word/numbering.xml', data: numbering }
    ]);
  }
  var DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  /* ======================================================================
     THE APPROVED SNAPSHOT IN EVERY EXPORT (docs/system-integrity/RULES.md,
     EXPORT.*). Every file carries the snapshot it was made from — revision,
     content and research fingerprints, the research time, the approval — and
     every file is READ BACK before it leaves: the numbers in the Markdown
     text, the HTML's text and the Word file's runs must be the approved
     article's numbers, in the same order. A renderer that drops, rounds or
     reorders a number is caught here, not by a publisher's reader.
     ====================================================================== */
  function snapshotOf(row) {
    row = row || {};
    return { revision: row.revision != null ? row.revision : null, status: row.status || null,
      content_hash: row.content_hash || null, approved_hash: row.approved_hash || null, approved_at: row.approved_at || null,
      research_hash: row.research_hash || null, approved_research_hash: row.approved_research_hash || null,
      research_as_of: row.research_as_of || null, numbers: null };
  }
  function shortHash(h) { return h ? String(h).slice(0, 12) : 'none'; }
  function snapshotLine(snap) {
    if (!snap) return null;
    var asOf = ts(snap.research_as_of), at = ts(snap.approved_at);
    return 'EdgeDesk snapshot: revision ' + (snap.revision != null ? snap.revision : '?') + ' · content ' + shortHash(snap.content_hash)
      + ' · research ' + shortHash(snap.research_hash) + (asOf ? ' · research as of ' + new Date(asOf).toISOString() : '')
      + ' · ' + (snap.approved_hash && snap.approved_hash === snap.content_hash ? 'approved' + (at ? ' ' + new Date(at).toISOString() : '') : 'NOT APPROVED')
      + (snap.numbers ? ' · numbers ' + snap.numbers : '');
  }
  /* the article's own text, independent of every renderer: what the
     approved snapshot says, in reading order */
  function canonicalText(a, ctx) {
    var parts = [a.title, a.standfirst];
    (a.sections || []).forEach(function (s) { parts.push(s.heading || '', s.body); });
    parts.push(attributionFor(a, ctx && ctx.opportunity, ctx || {}), DISCLAIMER);
    return parts.filter(function (x) { return x; }).join('\n\n');
  }
  function plainOfMarkdown(md) {
    return String(md).replace(/\]\((?:https?:\/\/[^)\s]+)\)/g, ']').replace(/https?:\/\/\S+/g, ' ');
  }
  function plainOfHtml(html) {
    return String(html).replace(/<[^>]*>/g, ' ')
      .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(+n); })
      .replace(/&(amp|lt|gt|quot|nbsp);/g, function (_, e) { return { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ' }[e]; });
  }
  /* the Word file's text, up to the editor's page: zipStore writes entries
     uncompressed, so document.xml is readable as it is */
  function plainOfDocx(bytes) {
    var s = new TextDecoder().decode(bytes);
    var i = s.indexOf('<w:document'), j = s.indexOf('</w:document>', i);
    if (i < 0 || j < 0) return null;
    var doc = s.slice(i, j), stop = doc.indexOf('For the editor (not for publication)');
    if (stop >= 0) doc = doc.slice(0, doc.lastIndexOf('<w:p>', stop) >= 0 ? doc.lastIndexOf('<w:p>', stop) : stop);
    return doc.split('</w:p>').map(function (p) {
      var out = [], re = /<w:t[^>]*>([^<]*)<\/w:t>/g, m;
      while ((m = re.exec(p))) out.push(m[1]);
      return out.join('').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    }).join('\n');
  }
  function numberSeq(text) { return numbersIn(stripForNumbers(text)).map(function (n) { return String(+n.toFixed(4)); }); }
  function numbersFingerprint(a, ctx) { return hash(numberSeq(plainOfMarkdown(canonicalText(a, ctx))).join(',')).slice(0, 12); }
  function firstDiff(x, y) {
    for (var i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) return { at: i, approved: x[i] == null ? null : x[i], exported: y[i] == null ? null : y[i] };
    return null;
  }
  /* exportCheck(a, row, ctx, opts) → { ok, snapshot, formats: { md, html, docx }, problems }
     a    the article being exported (built from the row)
     row  the stored article (status, hashes, revision)
     opts.require_approved  (default true) the export must be of the approved content */
  function exportCheck(a, row, ctx, opts) {
    ctx = ctx || {}; opts = opts || {};
    var snap = snapshotOf(row), problems = [];
    snap.numbers = numbersFingerprint(a, ctx);
    var requireApproved = opts.require_approved !== false;
    if (requireApproved && !(snap.approved_hash && snap.approved_hash === snap.content_hash))
      problems.push({ id: 'EXPORT.APPROVED', detail: 'this is not the approved content: approve the current revision first' });
    if (requireApproved && snap.approved_research_hash && snap.research_hash && snap.approved_research_hash !== snap.research_hash)
      problems.push({ id: 'EXPORT.RESEARCH', detail: 'the research changed after approval' });
    var want = numberSeq(plainOfMarkdown(canonicalText(a, ctx)));
    var c = Object.assign({}, ctx, { snapshot: null });
    var got = {
      md: numberSeq(plainOfMarkdown(toMarkdown(a, Object.assign({}, c, { frontMatter: false })))),
      html: numberSeq(plainOfHtml(toHtml(a, c))),
      docx: (function () { var t = plainOfDocx(toDocx(a, Object.assign({}, c, { editorNotes: false }))); return t == null ? null : numberSeq(t); })()
    };
    var formats = {};
    Object.keys(got).forEach(function (k) {
      var seq = got[k], d = seq ? firstDiff(want, seq) : { at: 0, approved: want[0] || null, exported: null };
      formats[k] = { ok: !d, numbers: seq ? seq.length : 0, first_difference: d };
      if (d) problems.push({ id: 'EXPORT.NUMBERS', format: k, detail: k + ' export differs from the approved numbers at #' + (d.at + 1) + ': approved ' + d.approved + ', exported ' + d.exported });
    });
    var mdFull = toMarkdown(a, c);
    if (mdFull.indexOf(DISCLAIMER) < 0) problems.push({ id: 'EXPORT.DISCLOSURE', detail: 'the disclaimer is missing from the export' });
    var ed = (ctx.publisher && ctx.publisher.editorial) || {};
    var camp = (row && row.campaign_code) || ctx.campaign;
    if (ed.links_allowed !== false && (!camp || mdFull.indexOf('utm_campaign=' + camp) < 0))
      problems.push({ id: 'EXPORT.REFERRAL', detail: 'no EdgeDesk link carries this article’s campaign code' });
    return { ok: problems.length === 0, snapshot: snap, snapshot_line: snapshotLine(snap), expected_numbers: want.length, formats: formats, problems: problems };
  }

  /* compareCopy(text, a, ctx) — an edited or published copy against the
     approved numbers: which ones changed. Read-only; for the owner's check
     of what a publisher ran. */
  function compareCopy(text, a, ctx) {
    var want = numberSeq(plainOfMarkdown(canonicalText(a, ctx)));
    var got = numberSeq(/<[a-z][\s\S]*>/i.test(text) ? plainOfHtml(text) : plainOfMarkdown(text));
    var bag = {}; want.forEach(function (n) { bag[n] = (bag[n] || 0) + 1; });
    var extra = []; got.forEach(function (n) { if (bag[n]) bag[n]--; else extra.push(n); });
    var dropped = []; Object.keys(bag).forEach(function (n) { for (var i = 0; i < bag[n]; i++) dropped.push(n); });
    return { same: !extra.length && !dropped.length, not_in_approved: extra, missing_from_copy: dropped };
  }

  /* readiness(row, opts) — the checklist before "Ready to send". Each item
     names what it checks, and the database enforces the starred ones again
     (supabase/content_engine.sql: articles_guard, the transition door).
     opts: { opportunity (with research_hash), publisher, ctx (export ctx) } */
  function readiness(row, opts) {
    opts = opts || {}; row = row || {};
    var ch = row.checks || {}, list = ch.checks || [], items = [];
    function st(ids) {
      var got = list.filter(function (c) { return ids.indexOf(c.id) >= 0; });
      if (!got.length) return { status: 'unknown', detail: 'not checked: run the checks again' };
      var bad = got.filter(function (c) { return c.status === 'fail'; });
      return bad.length ? { status: 'fail', detail: bad.map(function (c) { return c.label + (c.detail ? ': ' + c.detail : ''); }).join(' · ') } : { status: 'pass', detail: null };
    }
    function item(id, label, r, db) { items.push({ id: id, label: label, status: r.status, detail: r.detail || null, enforced_by_database: !!db }); }
    var approved = !!(row.approved_hash && row.approved_hash === row.content_hash && row.approved_by);
    item('owner_approval', 'Approved by the owner, exactly this revision', { status: approved ? 'pass' : 'fail', detail: approved ? null : 'approve the current revision' }, true);
    var ist = ch.integrity_status;
    item('integrity', 'Integrity engine: no blocked game or claim', { status: ist === 'PASS' || ist === 'WARNING' ? 'pass' : (ist ? 'fail' : 'unknown'),
      detail: ist === 'BLOCKED' ? ((ch.integrity && ch.integrity.blocking) || []).map(function (b) { return b.rule_id; }).join(', ') : (ist ? null : 'no integrity verdict on file: run the checks again') }, true);
    var o = opts.opportunity;
    var resOk = o && o.research_hash ? (row.research_hash === o.research_hash && (!row.approved_research_hash || row.approved_research_hash === o.research_hash)) : null;
    item('research_unchanged', 'The research has not changed since approval', { status: resOk === null ? 'unknown' : (resOk ? 'pass' : 'fail'), detail: resOk === false ? 'the research changed: refresh, check and approve again' : null }, true);
    item('matchups', 'Every matchup is a real, verified, unstarted game', st(['teams_in_evidence', 'games_publishable', 'games_not_started', 'kickoff_claims']));
    item('numbers', 'Every number is from the research, on the right game', st(['numbers_in_evidence', 'numbers_per_game', 'spread_claims']));
    item('claims', 'Outside claims attributed; injury and quarterback claims sourced', st(['reporting_attributed', 'unsourced_reporting', 'qb_claims_sourced', 'conference_claims', 'names_in_evidence']));
    item('sources_timestamps', 'Research time stated; old prices labelled old', (function () {
      var r = st(['research_fresh', 'stale_prices_labelled']);
      if (!row.research_as_of) return { status: 'fail', detail: 'no research time on file' };
      return r;
    })());
    item('language', 'No pick, lock or value language', st(['no_recommendation', 'projection_not_value']));
    item('seo', 'Headline, slug, meta description and keyword', st(['headline', 'seo_meta', 'seo_slug', 'seo_keyword']));
    var x = row.title ? exportCheck({ format: row.format, title: row.title, slug: row.slug, meta_description: row.meta_description, standfirst: row.standfirst,
      primary_keyword: row.primary_keyword, secondary_keywords: row.secondary_keywords, sections: row.sections }, row, opts.ctx || {}) : null;
    var ref = x && x.problems.filter(function (p) { return p.id === 'EXPORT.REFERRAL'; });
    item('referral', 'The EdgeDesk link carries this article’s campaign code', !row.campaign_code ? { status: 'fail', detail: 'no campaign code' } : (ref && ref.length ? { status: 'fail', detail: ref[0].detail } : { status: x ? 'pass' : 'unknown', detail: null }));
    var dis = x && x.problems.filter(function (p) { return p.id === 'EXPORT.DISCLOSURE'; });
    var disc = st(['disclaimer']);
    item('disclosures', 'Disclaimer, 21+ line and research credit', dis && dis.length ? { status: 'fail', detail: dis[0].detail } : disc);
    var num = x && x.problems.filter(function (p) { return p.id === 'EXPORT.NUMBERS'; });
    item('exports_reconcile', 'Markdown, HTML and Word carry the approved numbers', !x ? { status: 'unknown', detail: null } : (num.length ? { status: 'fail', detail: num.map(function (p) { return p.detail; }).join(' · ') } : { status: 'pass', detail: null }));
    var failed = items.filter(function (i) { return i.status !== 'pass'; });
    return { ok: failed.length === 0, items: items, blocking: failed.map(function (i) { return i.id; }), snapshot_line: x ? x.snapshot_line : null };
  }

  /* ======================================================================
     COST — what a Claude call can cost and did cost (docs/system-integrity/
     COST.md). One implementation for both hosts that make calls (the Edge
     Function, the weekly job): each call is RESERVED in the database before
     it is made at the UPPER BOUND estimate() returns
     (content_engine_ai_reserve takes one month lock, so concurrent calls
     cannot pass the $10 cap together) and SETTLED after it at measured()
     (content_engine_ai_settle). Prices are list prices, USD per million
     tokens (Anthropic first-party API, 2026-10); cacheWrite is the 5-minute
     write (1.25× input). A model missing from the table is priced at
     CEILING, so a new or renamed model is never counted as cheaper than it
     is.
     ====================================================================== */
  var PRICES = {
    'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5 },
    'claude-opus-5': { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    'claude-opus-4-8': { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    'claude-haiku-5-5': { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }
  };
  var PRICE_CEILING = { in: 10, out: 50, cacheRead: 1, cacheWrite: 12.5 };
  /* the models the server-side fallback ('default') can hand a declined request to */
  var FALLBACK_MODELS = ['claude-opus-5', 'claude-opus-4-8'];
  function priceOf(model) { return PRICES[String(model || '')] || PRICE_CEILING; }
  /* the most a request can cost: input at one token per three characters
     (prose runs nearer four, so this over-counts), output at the full
     max_tokens (thinking included), and — because a policy decline can be
     billed and then re-run on a fallback model — the same again at the
     dearest fallback's price. Capped at the $5 a single reservation may hold. */
  function costEstimate(req, model) {
    var inTok = Math.ceil(JSON.stringify({ system: req.system, messages: req.messages }).length / 3) + 500;
    var outTok = +req.max_tokens || 16000;
    var p = priceOf(model);
    var f = FALLBACK_MODELS.map(priceOf).reduce(function (a, b) { return a.out >= b.out ? a : b; });
    var usd = (inTok * p.in + outTok * p.out) / 1e6 + (inTok * f.in + outTok * f.out) / 1e6;
    return Math.min(5, Math.ceil(usd * 1e6) / 1e6);
  }
  /* the measured cost of a reply, from the token counts the API reports.
     usage.iterations (present when a fallback ran) is the per-attempt record:
     a plain attempt is priced at the requested model, the fallback attempt at
     the model that served it. No usage at all → null: settled at the estimate. */
  function costMeasured(message, model) {
    var u = message && message.usage;
    if (!u) return null;
    var its = Array.isArray(u.iterations) && u.iterations.length ? u.iterations : [u];
    var t = { usd: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, basis: its === u.iterations ? 'iterations' : 'usage' };
    its.forEach(function (it) {
      var p = it && it.type === 'fallback_message' ? (PRICES[String(message.model || '')] || PRICE_CEILING) : priceOf(model);
      var i = +it.input_tokens || 0, o = +it.output_tokens || 0, cr = +it.cache_read_input_tokens || 0, cw = +it.cache_creation_input_tokens || 0;
      t.input_tokens += i; t.output_tokens += o; t.cache_read_tokens += cr; t.cache_write_tokens += cw;
      t.usd += (i * p.in + o * p.out + cr * p.cacheRead + cw * p.cacheWrite) / 1e6;
    });
    t.usd = Math.round(t.usd * 1e6) / 1e6;
    return t;
  }
  /* the request's fingerprint (SHA-256, hex): the same model, article
     version, section and prompt make the same key, so a request already made
     and paid for is refused as a duplicate instead of being paid for twice.
     scope: { article, content_hash, section } or { opportunity, research_hash, format } */
  function costRequestKey(model, scope, req) {
    var body = canonicalJson({ model: model, scope: scope || {}, system: req.system, messages: req.messages, output_config: req.output_config, max_tokens: req.max_tokens });
    var C = typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle;
    if (!C) return Promise.reject(new Error('no WebCrypto in this host'));
    return C.digest('SHA-256', new TextEncoder().encode(body)).then(function (d) {
      return Array.prototype.map.call(new Uint8Array(d), function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('');
    });
  }
  function canonicalJson(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
    return '{' + Object.keys(v).sort().filter(function (k) { return v[k] !== undefined; }).map(function (k) { return JSON.stringify(k) + ':' + canonicalJson(v[k]); }).join(',') + '}';
  }
  /* what the owner is told when the budget door refuses a call */
  var COST_REFUSALS = {
    duplicate: 'Claude already rewrote exactly this draft from exactly this research, and that version failed the checks; edit the draft or refresh the research before asking again (nothing was spent)',
    in_flight: 'a rewrite of this article is already running',
    retry_limit: 'this request failed too many times; nothing more is spent on it',
    monthly_budget_exhausted: 'the content engine’s monthly AI budget is used up; the deterministic draft stands',
    job_budget_exhausted: 'this run’s AI budget is used up; the deterministic draft stands'
  };

  /* ======================================================================
     AI — the drafting request and the reply. The CALL belongs to the host.
     ====================================================================== */
  var AI_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['title', 'meta_description', 'standfirst', 'sections'],
    properties: {
      title: { type: 'string' },
      meta_description: { type: 'string' },
      standfirst: { type: 'string' },
      sections: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false, required: ['key', 'heading', 'body'],
          properties: { key: { type: 'string' }, heading: { type: 'string' }, body: { type: 'string' } }
        }
      }
    }
  };
  var AI_SYSTEM = [
    'You are a sports editor writing for EdgeDesk Sports, an independent sports research platform whose motto is "research, not picks".',
    'You write clear, engaging, accurate journalism for ordinary sports fans, not quantitative analysts.',
    'HARD RULES — a draft that breaks one is discarded automatically:',
    '1. Every number you write must appear in the RESEARCH PACKET (the display strings are pre-formatted; reuse them). Never estimate, round differently, or add a statistic, record, ranking, injury detail or price that is not in the packet.',
    '2. Name only teams and people that appear in the packet.',
    '3. No picks, locks, guarantees, "best bets", staking advice, or certainty ("will win"). Write "is projected to", "the model gives X a 64% chance".',
    '4. A projection is not a bet: say so plainly in the "how_to_read" section, and never imply a team is worth betting because it is projected to win.',
    '5. A market line whose status is "stale" or "reference" must be described with its source and capture time (or "reference, no capture time"), never as the current price.',
    '6. External reporting must be attributed to its outlet with a Markdown link to the URL in the packet, and kept separate from EdgeDesk\'s model inference. Do not add details beyond what the packet quotes.',
    '7. Explain jargon in plain words. No generic filler ("delve into", "game-changer", "at the end of the day", "must-watch", "buckle up").',
    'Formatting: section bodies are Markdown — paragraphs, "### " game headings inside the games section, "- " bullets, **bold**, [text](https://...) links. Do not write the disclaimer or the attribution footer; EdgeDesk adds both.'
  ].join('\n');

  function compactPacket(o) {
    /* what the writer may use: the research minus internal identifiers */
    return {
      league: o.league, season: o.season, week: o.week, kind: o.kind, as_of: o.research.as_of,
      context: Object.assign({}, o.research.context, { team_names: undefined }), conference: o.research.conference || null, conference_top: o.research.conference_top || null,
      focus: o.research.focus || null, news: o.research.news || [],
      games: (o.research.games || []).map(stripGame), upsets: (o.research.upsets || []).map(stripGame), races: (o.research.races || []).map(stripGame),
      limitations: o.research.limitations || []
    };
  }
  function stripGame(p) {
    var c = Object.assign({}, p);
    delete c.flags; delete c.game_id;
    return c;
  }

  /* ctx: { publisher, format, section (key, optional), current (article), objections: [..] } */
  function buildRequest(o, ctx) {
    ctx = ctx || {};
    var format = ctx.format || (o.formats && o.formats[0]);
    var base = ctx.current || draft(o, { publisher: ctx.publisher, format: format, angle: ctx.angle });
    var ed = (ctx.publisher && ctx.publisher.editorial) || {};
    var pubTxt = ctx.publisher ? [
      'PUBLISHER: ' + ctx.publisher.name,
      ed.tone ? 'Tone: ' + ed.tone : null,
      ed.length ? 'Length: ' + ed.length.min + '–' + ed.length.max + ' words' : null,
      ed.audience ? 'Audience: ' + ed.audience : null,
      ed.notes ? 'Editorial notes: ' + ed.notes : null,
      ed.seo_requirements ? 'SEO requirements: ' + ed.seo_requirements : null
    ].filter(Boolean).join('\n') : 'PUBLISHER: none (EdgeDesk house style)';
    var task = ctx.section
      ? 'Rewrite ONLY the section with key "' + ctx.section + '". Return the full article object with every other section copied unchanged from the CURRENT DRAFT.'
      : 'Write the full article. Keep the section keys and order of the CURRENT DRAFT (you may improve every heading and every word). The deterministic CURRENT DRAFT is accurate but plain: make it read like good sports journalism without adding facts.';
    var user = [
      task,
      'FORMAT: ' + format + ' — ' + ((FORMATS[format] || {}).label || ''),
      'SEO: primary keyword "' + (o.seo && o.seo.primary_keyword) + '"; use it naturally in the headline and first paragraph, never stuffed. Meta description 120–155 characters.',
      pubTxt,
      ctx.objections && ctx.objections.length ? 'YOUR PREVIOUS DRAFT WAS REJECTED FOR: ' + ctx.objections.join(' | ') + '. Fix exactly these.' : null,
      'RESEARCH PACKET (the only facts you may use):\n' + JSON.stringify(compactPacket(o)),
      'CURRENT DRAFT:\n' + JSON.stringify({ title: base.title, meta_description: base.meta_description, standfirst: base.standfirst, sections: base.sections })
    ].filter(Boolean).join('\n\n');
    return {
      system: AI_SYSTEM,
      messages: [{ role: 'user', content: user }],
      max_tokens: 16000,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: AI_SCHEMA } }
    };
  }

  /* message: the Messages API reply. → { ok, article?, reason } */
  function parseReply(message, base) {
    if (!message) return { ok: false, reason: 'no_reply' };
    if (message.stop_reason === 'refusal') return { ok: false, reason: 'refusal' };
    if (message.stop_reason === 'max_tokens') return { ok: false, reason: 'max_tokens' };
    var text = (message.content || []).filter(function (b) { return b && b.type === 'text'; }).map(function (b) { return b.text; }).join('');
    var j;
    try { j = JSON.parse(text); } catch (e) { return { ok: false, reason: 'invalid_json' }; }
    if (!j || typeof j.title !== 'string' || !Array.isArray(j.sections) || !j.sections.length) return { ok: false, reason: 'bad_shape' };
    var keys = (base && base.sections || []).map(function (s) { return s.key; });
    var secs = j.sections.filter(function (s) { return s && typeof s.key === 'string' && typeof s.body === 'string'; })
      .map(function (s) { return { key: s.key, heading: s.heading || SECTION_HEADINGS[s.key] || null, body: s.body.trim() }; });
    if (keys.length) secs = keys.map(function (k) { return secs.filter(function (s) { return s.key === k; })[0] || (base.sections.filter(function (s) { return s.key === k; })[0]); });
    var a = Object.assign({}, base, {
      title: j.title.trim(), meta_description: String(j.meta_description || '').trim(), standfirst: String(j.standfirst || '').trim(),
      sections: secs, slug: slugify(j.title)
    });
    a.word_count = wordCount(a.standfirst + ' ' + secs.map(function (s) { return s.body; }).join(' '));
    return { ok: true, article: a };
  }
  /* the objections a failed validation sends back for one more try */
  function objections(report) {
    return (report.checks || []).filter(function (c) { return c.status === 'fail'; }).map(function (c) { return c.label + (c.detail ? ': ' + c.detail : ''); });
  }

  /* ======================================================================
     PUBLISHER — the Stadium Rant template (editorial only; contacts and
     benchmarks live in the owner-only database, never in this public file)
     ====================================================================== */
  var PUBLISHER_TEMPLATES = {
    'stadium-rant': {
      slug: 'stadium-rant', name: 'Stadium Rant', website: 'https://www.stadiumrant.com', utm_source: 'stadiumrant',
      editorial: {
        preferred_sports: ['cfb', 'nfl'],
        categories: ['weekly_preview', 'upset_watch', 'conference_race', 'injury_impact', 'trending_story', 'market_discrepancy'],
        prefer_broad: true,
        tone: 'Accessible, energetic sports-fan voice; explain every number in plain words; no betting jargon without a one-line explanation.',
        audience: 'General college football and NFL fans, beyond experienced bettors',
        length: { min: 900, max: 1500 },
        max_games: 6,
        sections: ['intro', 'why_it_matters', 'how_to_read', 'games', 'upsets', 'conference', 'disagreements', 'limits', 'conclusion'],
        seo_requirements: 'Broad, searchable headline built on a recognisable query ("Week N predictions", team names); primary keyword in the headline and first paragraph; meta description under 160 characters.',
        attribution: null,
        links_allowed: true,
        cadence: 'Weekly: CFB preview by Thursday, NFL preview by Friday',
        notes: 'Prefer weekly previews and major storylines over isolated low-interest matchups. Integrate predictions naturally; keep EdgeDesk’s analysis meaningful, not promotional.'
      }
    }
  };

  return {
    VERSION: VERSION, SITE: SITE, STATUSES: STATUSES, STATUS_LABELS: STATUS_LABELS, TRANSITIONS: TRANSITIONS,
    KINDS: KINDS, FORMATS: FORMATS, SECTION_HEADINGS: SECTION_HEADINGS, DISCLAIMER: DISCLAIMER,
    SCORE_WEIGHTS: SCORE_WEIGHTS, SCORE_LABELS: SCORE_LABELS, STALE_MINUTES: STALE_MINUTES, BANNED: BANNED, AI_TELLS: AI_TELLS,
    ARTIFACTS: ARTIFACTS, FEEDS: FEEDS, PUBLISHER_TEMPLATES: PUBLISHER_TEMPLATES,
    research: { fromArtifacts: fromArtifacts, chooseWeek: chooseWeek },
    story: { score: storyScore, storyline: storyline }, investigations: investigations,
    integrity: { ok: INTEGRITY_OK, packetRecord: packetRecord, attach: attachIntegrity },
    news: { parseFeed: parseFeed, match: matchNews, classify: classifyNews },
    discover: discover, seoBrief: seoBrief, outline: outline, draft: draft,
    evidence: evidenceOf, validate: validate, similarity: similarity, teamsMentioned: teamsMentioned,
    campaignCode: campaignCode, tagLink: tagLink, attribution: attributionFor,
    toMarkdown: toMarkdown, toHtml: toHtml, mdToHtml: mdToHtml, seoSheet: seoSheet, toDocx: toDocx, DOCX_TYPE: DOCX_TYPE,
    exportCheck: exportCheck, snapshotOf: snapshotOf, snapshotLine: snapshotLine, compareCopy: compareCopy, readiness: readiness, numbersFingerprint: numbersFingerprint,
    ai: { SCHEMA: AI_SCHEMA, SYSTEM: AI_SYSTEM, buildRequest: buildRequest, parseReply: parseReply, objections: objections },
    cost: { PRICES: PRICES, CEILING: PRICE_CEILING, FALLBACK_MODELS: FALLBACK_MODELS, priceOf: priceOf, estimate: costEstimate, measured: costMeasured, requestKey: costRequestKey, REFUSALS: COST_REFUSALS },
    util: { slugify: slugify, wordCount: wordCount, hash: hash, whenText: whenText, esc: esc, canTransition: function (from, to) { return (TRANSITIONS[from] || []).indexOf(to) >= 0; } }
  };
});
