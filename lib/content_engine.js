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

  var VERSION = 'content_engine_v2';
  var SITE = 'https://edgedesksports.com';

  /* The football evidence module (lib/football_evidence.js). Node requires it;
     the admin page loads it before this file; the Edge Function inlines it
     before this core. Looked up on use, so load order never matters — and if
     it is missing, validate() FAILS the article rather than skipping the gate. */
  var FE_CACHE = null;
  function fe() {
    if (FE_CACHE) return FE_CACHE;
    var g = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : {});
    if (g.EDFootballEvidence) return (FE_CACHE = g.EDFootballEvidence);
    try { if (typeof require === 'function') FE_CACHE = require('./football_evidence.js'); } catch (e) { FE_CACHE = null; }
    return FE_CACHE;
  }

  /* ------------------------------------------------------------ vocabulary */
  var STATUSES = ['draft', 'in_review', 'approved', 'ready_to_send', 'sent', 'published', 'archived'];
  /* The same matrix the database enforces (supabase/content_engine.sql). */
  var TRANSITIONS = {
    draft: ['in_review', 'archived'],
    in_review: ['draft', 'approved', 'archived'],
    approved: ['ready_to_send', 'in_review', 'draft', 'archived'],
    ready_to_send: ['sent', 'approved', 'in_review', 'archived'],
    sent: ['published', 'archived'],
    published: ['archived'],
    archived: ['draft']
  };
  var STATUS_LABELS = {
    draft: 'Draft', in_review: 'In review', approved: 'Approved', ready_to_send: 'Ready to send',
    sent: 'Sent', published: 'Published', archived: 'Archived'
  };

  var KINDS = {
    weekly_preview: 'Weekly preview',
    upset_watch: 'Upset watch',
    conference_race: 'Conference race',
    market_discrepancy: 'Market discrepancy',
    injury_impact: 'Injury implications',
    trending_story: 'Trending story',
    matchup_analysis: 'Matchup analysis',
    matchup_preview: 'Matchup deep dive',
    postgame_review: 'Postgame model review'
  };

  /* Each format names the sections a draft must carry, in order. `required`
     sections must be present for the structure check to pass. */
  var FORMATS = {
    cfb_weekly_preview: {
      label: 'Weekly CFB preview', league: 'cfb',
      sections: ['intro', 'why_it_matters', 'how_to_read', 'games', 'disagreements', 'upsets', 'conference', 'limits', 'conclusion'],
      required: ['intro', 'why_it_matters', 'how_to_read', 'games', 'limits', 'conclusion'],
      words: [900, 2000]
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
      label: 'Market discrepancy analysis', league: null,
      sections: ['intro', 'the_gap', 'why_they_differ', 'how_to_read', 'market_case', 'limits', 'conclusion'],
      required: ['intro', 'the_gap', 'why_they_differ', 'how_to_read', 'market_case', 'conclusion'],
      words: [500, 1200]
    },
    /* the journalist-first single-game piece (football/evidence packets) */
    matchup_analysis: {
      label: 'Matchup analysis (for a publisher)', league: null,
      sections: ['intro', 'thesis', 'evidence', 'counterargument', 'game_script', 'conclusion'],
      required: ['intro', 'thesis', 'evidence', 'counterargument', 'game_script', 'conclusion'],
      headings: { conclusion: 'What to watch, and what we still don’t know' },
      words: [800, 1600]
    },
    edgedesk_analysis: {
      label: 'Matchup analysis (EdgeDesk first-party)', league: null, first_party: true,
      sections: ['intro', 'thesis', 'evidence', 'counterargument', 'game_script', 'model_detail', 'conclusion'],
      required: ['intro', 'thesis', 'evidence', 'counterargument', 'game_script', 'model_detail', 'conclusion'],
      headings: { thesis: 'Where EdgeDesk differs, and why', evidence: 'The evidence, unit by unit', counterargument: 'The case against EdgeDesk’s number', conclusion: 'What to watch' },
      words: [900, 2400]
    },
    matchup_deep_dive: {
      label: 'Matchup deep dive', league: null,
      sections: ['intro', 'the_projection', 'how_to_read', 'what_drives_it', 'matchup', 'personnel', 'market', 'conditions', 'limits', 'conclusion'],
      required: ['intro', 'the_projection', 'how_to_read', 'limits', 'conclusion'],
      words: [450, 1500]
    },
    conference_race: {
      label: 'Conference race', league: 'cfb',
      sections: ['intro', 'why_it_matters', 'how_to_read', 'race_games', 'contenders', 'implications', 'limits', 'conclusion'],
      required: ['intro', 'how_to_read', 'race_games', 'implications', 'limits', 'conclusion'],
      words: [600, 1500]
    },
    model_vs_market: {
      label: 'Model vs. market report', league: null,
      sections: ['intro', 'how_to_read', 'the_gaps', 'pattern', 'limits', 'conclusion'],
      required: ['intro', 'how_to_read', 'the_gaps', 'limits', 'conclusion'],
      words: [600, 1600]
    },
    postgame_review: {
      label: 'Postgame model review', league: null,
      sections: ['intro', 'how_to_read', 'scoreboard', 'closest', 'misses', 'season', 'limits', 'conclusion'],
      required: ['intro', 'how_to_read', 'scoreboard', 'misses', 'conclusion'],
      words: [500, 1500]
    },
    /* EdgeDesk's own articles (edgedesksports.com), never sent to a publisher */
    fp_weekend_review: {
      label: 'Weekend Model Review (EdgeDesk)', league: null, first_party: true,
      sections: ['intro', 'how_to_read', 'scoreboard', 'closest', 'misses', 'season', 'limits', 'conclusion'],
      required: ['intro', 'how_to_read', 'scoreboard', 'misses', 'conclusion'],
      words: [500, 1600]
    },
    fp_storylines: {
      label: 'Weekend Storylines (EdgeDesk)', league: null, first_party: true,
      sections: ['intro', 'how_to_read', 'story_1', 'story_2', 'story_3', 'story_4', 'story_5', 'limits', 'conclusion'],
      required: ['intro', 'how_to_read', 'story_1', 'story_2', 'story_3', 'limits', 'conclusion'],
      words: [500, 1500]
    },
    fp_research_preview: {
      label: 'Weekend Research Preview (EdgeDesk)', league: null, first_party: true,
      sections: ['intro', 'how_to_read', 'num_1', 'num_2', 'num_3', 'num_4', 'num_5', 'watch', 'limits', 'conclusion'],
      required: ['intro', 'how_to_read', 'num_1', 'num_2', 'num_3', 'num_4', 'limits', 'conclusion'],
      words: [500, 1500]
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
    disagreements: 'Where EdgeDesk and the market disagree',
    injuries: 'Injury report: what to watch',
    limits: 'What the numbers can’t see',
    conclusion: 'The bottom line',
    reported: 'What was reported',
    research: 'What EdgeDesk’s research shows',
    unknowns: 'What we don’t know yet',
    the_gap: 'The gap',
    why_they_differ: 'Why the numbers differ',
    market_case: 'The case for the market',
    thesis: 'What EdgeDesk sees differently',
    evidence: 'The football evidence',
    counterargument: 'What could make EdgeDesk wrong',
    game_script: 'What has to happen on the field',
    model_detail: 'Inside EdgeDesk’s number',
    the_projection: 'EdgeDesk’s projection',
    what_drives_it: 'What builds the number',
    matchup: 'Where the matchup tilts',
    personnel: 'Quarterbacks and availability',
    market: 'EdgeDesk vs. the market',
    conditions: 'Conditions',
    race_games: 'The games that shape the race',
    contenders: 'Where the other contenders stand',
    implications: 'What it means for the race',
    the_gaps: 'The biggest gaps',
    pattern: 'What the gaps have in common',
    scoreboard: 'How the numbers did',
    closest: 'Where the model was closest',
    misses: 'The biggest misses',
    season: 'The season so far',
    watch: 'What could move these numbers'
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
  var STRINGIFIED_NOTHING = /(^|[\s>(/])(null|undefined|NaN)([\s<).,;:/%]|$)/;

  /* ---------------------------------------------------------------- utils */
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  /* one decimal the way EdgeDesk's own displays print it (toFixed), so a
     5.35 reads 5.3 here exactly as it does on the terminal */
  function r1(x) { return +(+x).toFixed(1); }
  function oneDp(x) { return Math.abs(+(+x).toFixed(1)).toFixed(1); }
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
    forecasts: 'football/venues/forecasts.json',
    market: 'articles/data/market/{season}-week-{ww}.json',
    /* the football model's own record: each pregame number, graded on the final and against the close */
    record: 'record/football/{league}_{season}.json',
    evidence: 'football/evidence/packets.json'
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
    var g = marketHomeLine - modelHomeLine; /* >0: model likes home more than the market */
    var pts = r1(Math.abs(g));
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
      d.win = favT + ' ' + pct(favP);
      d.dog_win = (favT === home ? away : home) + ' ' + pct(1 - favP);
    }
    if (proj && isNum(proj.home) && isNum(proj.away)) {
      var hi = proj.home >= proj.away;
      d.score = (hi ? home + ' ' + oneDp(proj.home) + ', ' + away + ' ' + oneDp(proj.away) : away + ' ' + oneDp(proj.away) + ', ' + home + ' ' + oneDp(proj.home));
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

  /* ======================================================================
     EDITORIAL RELIABILITY — numbers that reconcile, quarterbacks as the data
     states them, discrepancies explained from the model's own inputs, and
     the forecast at kickoff. Nothing here invents a figure: when the
     research disagrees with itself the packet says so and the gate blocks.
     ====================================================================== */
  /* a displayed figure may differ from the model's raw figure by rounding only */
  var NUM_TOL = 0.15;
  /* a model–market gap worth explaining; when it needs review; when it blocks */
  var DISCREPANCY = { significant: 3, review_unexplained: 3, block_gap: 7, block_unexplained: 5 };
  /* a quarterback question is written into a game only when the model's own
     starter-change scenario moves the number this much, or flips the favorite */
  var QB_MATERIAL_POINTS = 1.0;
  var WEATHER = { wind_mph: 20, gust_mph: 35, precip_in: 0.25, cold_f: 25, heat_f: 95, stale_hours: 12,
    storm_codes: [95, 96, 99], snow_codes: [71, 73, 75, 77, 85, 86], heavy_rain_codes: [65, 67, 82] };

  function r2(x) { return +(+x).toFixed(2); }
  /* The projected score, margin and total as ONE set of displayed figures:
     margin and total in tenths, the scores derived from them, so the scores'
     difference IS the displayed margin and their sum IS the displayed total.
     Each stays within NUM_TOL of the model's raw figure. If the raw figures
     disagree with each other, nothing is repaired: ok is false. */
  function reconcileScore(homeRaw, awayRaw, homeMargin, totalRaw) {
    var out = { ok: false, problems: [] };
    if (!isNum(homeMargin)) { out.problems.push('no projected margin'); return out; }
    if (!isNum(totalRaw) && isNum(homeRaw) && isNum(awayRaw)) totalRaw = homeRaw + awayRaw;
    if (!isNum(totalRaw)) { out.problems.push('no projected total'); return out; }
    if (isNum(homeRaw) && isNum(awayRaw)) {
      /* the source's own scores are rounded to tenths: two roundings may differ by 0.1 */
      if (Math.abs((homeRaw - awayRaw) - homeMargin) > 0.1 + 1e-6) out.problems.push('the projected scores differ by ' + r2(homeRaw - awayRaw) + ' but the projected margin is ' + r2(homeMargin));
      if (Math.abs((homeRaw + awayRaw) - totalRaw) > 0.2) out.problems.push('the projected scores add to ' + r2(homeRaw + awayRaw) + ' but the projected total is ' + r2(totalRaw));
    } else { homeRaw = (totalRaw + homeMargin) / 2; awayRaw = (totalRaw - homeMargin) / 2; }
    var Mi = Math.round(homeMargin * 10), Ti = Math.round(totalRaw * 10);
    if (Math.abs(Ti + Mi) % 2 === 1) Ti += (totalRaw * 10 > Ti ? 1 : -1);
    var home = (Ti + Mi) / 20, away = (Ti - Mi) / 20;
    out.home = r1(home); out.away = r1(away); out.total = Ti / 10; out.margin = Mi / 10;
    out.raw = { home: r2(homeRaw), away: r2(awayRaw), margin: r2(homeMargin), total: r2(totalRaw) };
    if (Math.abs(home - homeRaw) > NUM_TOL || Math.abs(away - awayRaw) > NUM_TOL || Math.abs(out.total - totalRaw) > NUM_TOL)
      out.problems.push('the displayed figures drift more than rounding from the model’s');
    if (home < 0 || away < 0) out.problems.push('a negative projected score');
    out.ok = out.problems.length === 0;
    return out;
  }
  /* a probability that is a probability, pointing the same way as the margin */
  function probabilityProblems(homeMargin, homeWinProb) {
    var out = [];
    if (!isNum(homeWinProb)) return out;
    if (homeWinProb < 0 || homeWinProb > 1) out.push('win probability ' + homeWinProb + ' is outside 0–1');
    if (isNum(homeMargin) && Math.abs(homeMargin) >= 1 && (homeMargin > 0) !== (homeWinProb > 0.5))
      out.push('the projected margin favors ' + (homeMargin > 0 ? 'the home team' : 'the away team') + ' but the win probability favors the other side');
    return out;
  }

  /* Quarterbacks, as the starter layer states them (football/starters):
     CONFIRMED     an official announcement
     ESTABLISHED   started the last game (or leads the depth chart), uncontested,
                   no availability report: NOT news, never written as doubt
     COMPETITION   the play data does not settle on one player (sourced)
     AVAILABILITY  a sourced availability note (questionable, doubtful, out)
     UNKNOWN       nothing reliable: no claim either way
     A contest whose sources disagree on a name is still COMPETITION (player
     null). `material` is the only door into the copy. */
  function qbState(q, side, g, homeMargin) {
    if (!q || (!q.player && !(q.contested || String(q.status || '').toUpperCase() === 'COMPETITION'))) return { player: null, status: 'UNKNOWN', material: false, confirmed: false, contested: false };
    var raw = String(q.status || '').toUpperCase();
    var st = raw === 'ANNOUNCED' || q.confirmed ? 'CONFIRMED' : (q.contested || raw === 'COMPETITION') ? 'COMPETITION' : (!raw || raw === 'UNKNOWN') ? 'UNKNOWN' : 'ESTABLISHED';
    var risk = ((g && g.risks && g.risks.items) || []).filter(function (r) { return r && r.key === 'qb_' + side; })[0];
    var availM = risk && /\b(OUT|DOUBTFUL|QUESTIONABLE|GAME[ _-]TIME[ _-]DECISION|ruled out|doubtful|questionable|game-time decision|suspended)\b/.exec(String(risk.text || ''));
    if (availM && st !== 'COMPETITION') st = 'AVAILABILITY';
    var sens = ((g && g.sensitivity && g.sensitivity.rows) || []).filter(function (r) { return r && r.key === 'qb_out_' + side; })[0];
    var effect = sens && isNum(sens.delta) ? Math.abs(sens.delta) : null;
    var flips = !!(sens && isNum(sens.home_margin) && isNum(homeMargin) && Math.abs(homeMargin) >= 0.05 && Math.abs(sens.home_margin) >= 0.05 && (sens.home_margin > 0) !== (homeMargin > 0));
    var concern = st === 'COMPETITION' || st === 'AVAILABILITY';
    return {
      player: q.player, status: st, source_status: raw || null, label: q.label || null, source: q.source || null, as_of: q.as_of || null,
      availability: availM ? String(risk.text) : null, availability_source: availM ? risk.source || null : null,
      effect_points: effect == null ? null : r1(effect), flips_favorite: flips,
      /* a sourced availability report is news on its own; a usage split is
         material only when the model's starter-change scenario says it matters */
      material: st === 'AVAILABILITY' || (st === 'COMPETITION' && (effect == null || effect >= QB_MATERIAL_POINTS || flips)),
      confirmed: st === 'CONFIRMED', contested: st === 'COMPETITION'
    };
  }
  /* "unresolved: A 57% of recent dropbacks and B 38% of recent dropbacks — sources disagree." */
  function competitionFact(q) {
    var m = /:\s*(.+?)\s*(?:—|$)/.exec(String(q.label || ''));
    var core = m ? m[1].replace(/\.$/, '') : null;
    return core && /\d+%/.test(core) ? core.replace(/ of recent dropbacks and /, ' and ').replace(/ of recent dropbacks$/, ' of recent dropbacks') : null;
  }

  function cleanLabel(l) { return String(l || '').replace(/\s*\(.*\)\s*/g, '').toLowerCase(); }
  /* The model–market gap, explained from the model's own decomposition
     (why.rows sum exactly to EdgeDesk's margin), the term the market
     disagrees with (why.market_implied), how the closing market has
     historically discounted each piece (disagreement_explainer) and the
     terminal's own checks (regime changes, rating divergence, roster
     conflicts, model disagreement, verification). What the inputs cannot
     explain is SAID to be unexplained and sent to review. */
  function discrepancyOf(g, p) {
    if (!p.gap || !isNum(p.gap.points) || p.gap.points < DISCREPANCY.significant || !p.model.available) return null;
    var d = g.disagreement || {}, ex = g.disagreement_explainer || {}, why = g.why || {}, e = g.edgedesk || {};
    var basis = isNum(ex.gap_points) && Math.abs(ex.gap_points) > 0 ? Math.abs(ex.gap_points) : null;
    var unexplShare = basis != null && isNum(ex.unexplained_points) ? Math.min(1, Math.abs(ex.unexplained_points) / basis) : null;
    var explPct = unexplShare == null ? null : Math.max(0, Math.min(100, Math.round((isNum(ex.share_explained) ? ex.share_explained : 1 - unexplShare) * 100)));
    var unexplPct = unexplShare == null ? null : Math.round(unexplShare * 100);
    var unexplPts = unexplShare == null ? p.gap.points : r1(p.gap.points * unexplShare);
    var terms = (why.rows || []).filter(function (r) { return r && r.available !== false && isNum(r.points) && Math.abs(r.points) >= 0.5; })
      .map(function (r) { return { key: r.key, label: cleanLabel(r.label), points: r1(Math.abs(r.points)), team: r.favors }; })
      .sort(function (a, b) { return b.points - a.points; });
    var mi = why.market_implied && isNum(why.market_implied.market_implied) && isNum(why.market_implied.edgedesk)
      ? { term: why.market_implied.term, edgedesk: r1(Math.abs(why.market_implied.edgedesk)), edgedesk_team: why.market_implied.edgedesk < 0 ? p.away : p.home,
          implied: r1(Math.abs(why.market_implied.market_implied)), implied_team: why.market_implied.market_implied < 0 ? p.away : p.home } : null;
    var parts = (ex.parts || []).filter(function (x) { return x && x.significant && isNum(x.explained_points) && Math.abs(x.explained_points) >= 0.5; })
      .map(function (x) { return { key: x.key, label: String(x.label || '').replace(/\s*\(.*\)\s*/g, ''), points: r1(Math.abs(x.explained_points)) }; });
    var facts = [], evidence = [];
    var injury = (why.rows || []).filter(function (r) { return r && r.key === 'injury' && isNum(r.points) && Math.abs(r.points) >= 1; })[0];
    if (injury) facts.push({ key: 'availability', text: 'EdgeDesk’s number includes ' + oneDp(Math.abs(injury.points)) + ' points toward ' + injury.favors + ' for reported player availability.' });
    ['home', 'away'].forEach(function (s) {
      var rg = e.regime && e.regime[s];
      if (rg && rg.regime_change && rg.applied && isNum(rg.weight) && isNum(rg.standard_weight)) {
        facts.push({ key: 'regime_' + s, text: (s === 'home' ? p.home : p.away) + ' is flagged as a regime change (' + String(rg.reason || 'roster and staff turnover').replace(/;\s*/g, ', ') + '), so its rating weights the long-run record ' + Math.round(rg.weight * 100) + '% instead of the usual ' + Math.round(rg.standard_weight * 100) + '%.' });
      }
      var q = p.qb && p.qb[s];
      if (q && q.status === 'COMPETITION') { var cf = competitionFact(q); evidence.push((s === 'home' ? p.home : p.away) + ' quarterback: ' + (cf || 'unresolved in the play data') + ' (' + (q.source || 'starter layer') + ')'); }
    });
    /* the terminal's note, first sentence only: its generic caveat is said once per section */
    if (g.rating_divergence && g.rating_divergence.flag) facts.push({ key: 'rating_divergence', text: String(g.rating_divergence.text || 'EdgeDesk’s current rating and its pricing state disagree about this matchup.').split(/(?<=\.)\s+(?=[A-Z])/)[0] });
    var unresolved = (g.contradiction && g.contradiction.unresolved) || [];
    unresolved.filter(function (u) { return /^Roster:/i.test(u); }).forEach(function (u) { evidence.push(u.replace(/^Roster:\s*/i, 'Roster data: ')); });
    ((g.risks && g.risks.items) || []).filter(function (r) { return r && /own models disagree/i.test(r.text || ''); }).forEach(function (r) { evidence.push(r.text); });
    if (g.data_quality && isNum(g.data_quality.reliability) && g.data_quality.reliability < 60) evidence.push('Data reliability ' + g.data_quality.reliability + '/100' + (g.data_quality.main_deduction ? ': ' + g.data_quality.main_deduction : ''));
    if (p.market.status !== 'current') evidence.push('The comparison uses a ' + (p.market.status === 'stale' ? 'historical line captured ' + p.market.captured_text : 'reference line with no capture time') + ', not a current price.');
    var review = unexplPts >= DISCREPANCY.review_unexplained ? (p.gap.points >= DISCREPANCY.block_gap && unexplPts >= DISCREPANCY.block_unexplained ? 'BLOCK' : 'REVIEW') : 'NONE';
    return {
      points: p.gap.points, toward: p.gap.toward, terms: terms.slice(0, 4), market_implied: mi, parts: parts,
      explained_pct: explPct, unexplained_pct: unexplPct, unexplained_points: unexplPts,
      status: unexplPts >= DISCREPANCY.review_unexplained ? 'UNEXPLAINED' : 'EXPLAINED', review: review,
      facts: facts, evidence: evidence, verification: d.verification || null,
      investigation: g.contradiction && g.contradiction.status || null,
      explainer_version: ex.version || null, explainer_caveat: ex.caveat || null
    };
  }

  /* the committed forecast at kickoff (football/venues/forecasts.json, open-meteo) */
  function weatherOf(fc, now) {
    if (!fc) return { state: 'NOT_CHECKED', hazards: [], reason: 'no forecast on file for this game' };
    if (fc.dome) return { state: 'INDOOR', hazards: [], source: fc.source || null, as_of: fc.as_of || null };
    var t = ts(fc.as_of), age = t == null ? null : (now - t) / 3600000;
    var hz = [], hours = (fc.hours || []).slice(0, 4);
    if (!hours.length) hours = [fc];
    function maxOf(k) { var m = null; hours.forEach(function (h) { if (isNum(h[k]) && (m == null || h[k] > m)) m = h[k]; }); return m; }
    var wind = maxOf('wind_mph'), gust = maxOf('gust_mph'), precip = maxOf('precip_in');
    var codes = hours.map(function (h) { return h.code; }).filter(isNum);
    if (isNum(wind) && wind >= WEATHER.wind_mph) hz.push('sustained wind near ' + Math.round(wind) + ' mph');
    if (isNum(gust) && gust >= WEATHER.gust_mph) hz.push('gusts near ' + Math.round(gust) + ' mph');
    if (isNum(precip) && precip >= WEATHER.precip_in) hz.push('heavy precipitation (' + precip + ' in. in an hour)');
    if (codes.some(function (c) { return WEATHER.storm_codes.indexOf(c) >= 0; })) hz.push('thunderstorms (lightning delays possible)');
    if (codes.some(function (c) { return WEATHER.snow_codes.indexOf(c) >= 0; })) hz.push('snow');
    if (isNum(fc.temp_f) && fc.temp_f <= WEATHER.cold_f) hz.push(Math.round(fc.temp_f) + '°F at kickoff');
    if (isNum(fc.temp_f) && fc.temp_f >= WEATHER.heat_f) hz.push(Math.round(fc.temp_f) + '°F at kickoff');
    return {
      state: age == null || age > WEATHER.stale_hours ? 'STALE' : hz.length ? 'HAZARD' : 'OK', hazards: hz,
      text: fc.text || null, temp_f: isNum(fc.temp_f) ? Math.round(fc.temp_f) : null, wind_mph: isNum(wind) ? Math.round(wind) : null,
      gust_mph: isNum(gust) ? Math.round(gust) : null, source: fc.source || 'open-meteo forecast', as_of: fc.as_of || null,
      age_hours: age == null ? null : r1(age)
    };
  }
  /* "EdgeDesk’s typical miss on a game like this is 11.7 pts" — or σ·√(2/π) */
  function typicalMissOf(g, e) {
    var r = ((g.risks && g.risks.items) || []).filter(function (x) { return x && x.key === 'model_uncertainty'; })[0];
    var m = r && /typical miss[^0-9]*(\d+(?:\.\d+)?)/i.exec(r.text || '');
    if (m) return r1(parseFloat(m[1]));
    return isNum(e.sigma) ? r1(e.sigma * Math.sqrt(2 / Math.PI)) : null;
  }

  function cfbPacket(g, rk, now, links, forecasts) {
    var e = g.edgedesk || {}, m = g.market || {}, gm = g.game || {};
    var home = gm.home, away = gm.away;
    var kick = ts(g.kickoff);
    var model = { available: !!(e.available && isNum(e.fair_home_line)) };
    if (model.available) {
      var f = favOf(home, away, r1(e.fair_home_line));
      model.version = e.model_version || null;
      model.as_of = e.prediction_ts || null;
      model.home_line = r1(e.fair_home_line);
      model.favorite = f.favorite; model.underdog = f.underdog; model.margin = f.margin;
      model.home_win_prob = isNum(e.home_win_prob) ? Math.round(e.home_win_prob * 1000) / 1000 : null;
      model.fav_win_pct = isNum(e.home_win_prob) ? Math.round((f.favorite === away ? 1 - e.home_win_prob : e.home_win_prob) * 100) : null;
      model.dog_win_pct = model.fav_win_pct == null ? null : 100 - model.fav_win_pct;
      /* one consistent set of displayed figures (reconcileScore): the scores'
         difference IS the displayed margin, their sum IS the displayed total */
      var homeMargin = -model.home_line;
      var rec = reconcileScore(e.projected_score && e.projected_score.home, e.projected_score && e.projected_score.away, homeMargin, e.fair_total);
      var probBad = probabilityProblems(isNum(e.home_margin) ? e.home_margin : homeMargin, e.home_win_prob);
      model.numbers = { ok: rec.ok && !probBad.length, problems: rec.problems.concat(probBad), raw: rec.raw || null };
      model.fair_total = rec.total != null ? rec.total : (isNum(e.fair_total) ? r1(e.fair_total) : null);
      model.projected = rec.home != null ? { home: rec.home, away: rec.away } : null;
      var fc = e.football_confidence;
      model.confidence = fc && isNum(fc.score) ? { score: Math.round(fc.score), label: fc.label || fc.tier || null } : null;
      /* what that score IS (football/fbs confidence ledger: information_confidence):
         how completely EdgeDesk knows this game's inputs — not who wins */
      model.data_quality = fc && isNum(fc.score) ? { score: Math.round(fc.score), band: fc.score >= 70 ? 'high' : fc.score >= 45 ? 'medium' : 'low',
        measures: 'how completely EdgeDesk knows this game’s inputs (ratings, quarterbacks, availability, venue), weighted by importance — not a probability that either team wins' } : null;
      model.typical_miss = typicalMissOf(g, e);
      model.snapshot = (model.version || '?') + '@' + (model.as_of || '?');
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
    var hm = isNum(e.home_margin) ? e.home_margin : (model.available ? -model.home_line : null);
    var qb = { home: qbState(g.qb && g.qb.home, 'home', g, hm), away: qbState(g.qb && g.qb.away, 'away', g, hm) };
    if (!qb.home.player && !qb.home.contested) qb.home = null;
    if (!qb.away.player && !qb.away.contested) qb.away = null;
    var flags = [];
    if (market.status === 'none') flags.push('NO_MARKET');
    if (market.status === 'stale') flags.push('STALE_MARKET');
    if ((qb.home && qb.home.status === 'COMPETITION') || (qb.away && qb.away.status === 'COMPETITION')) flags.push('QB_CONTESTED');
    if ((qb.home && qb.home.status === 'AVAILABILITY') || (qb.away && qb.away.status === 'AVAILABILITY')) flags.push('QB_AVAILABILITY');
    if ((qb.home && qb.home.material) || (qb.away && qb.away.material)) flags.push('QB_MATERIAL');
    if (model.available && model.numbers && !model.numbers.ok) flags.push('NUMBERS_CONFLICT');
    if (model.confidence && model.confidence.score < MIN_CONFIDENCE) flags.push('LOW_CONFIDENCE');
    if (!model.available) flags.push('NO_PROJECTION');
    var verification = g.disagreement && g.disagreement.verification ? g.disagreement.verification : null;
    if (verification === 'FAILED') flags.push('VERIFICATION_FAILED');
    if (kick != null && kick <= now) flags.push('KICKED_OFF');
    var gap = market.status !== 'none' && model.available ? gapOf(home, away, model.home_line, market.home_line) : null;
    var mfav = market.status !== 'none' ? favOf(home, away, market.home_line) : null;
    var p = {
      league: 'cfb', game_id: String(g.game_id), season: g.season, week: g.week,
      kickoff: g.kickoff, kickoff_text: kick == null ? null : whenText(kick),
      home: home, away: away, venue: gm.venue || null, neutral_site: !!gm.neutral_site,
      home_conference: gm.home_conference || null, away_conference: gm.away_conference || null,
      conference_game: gm.matchup_type === 'conference', fcs: !!gm.fcs,
      home_rank: rH ? rH.rank : null, away_rank: rA ? rA.rank : null,
      home_rank_from: rH ? rH.rank_from : null, away_rank_from: rA ? rA.rank_from : null,
      model: model, market: market, gap: gap,
      favorite_flip: !!(mfav && mfav.favorite && model.favorite && mfav.favorite !== model.favorite),
      drivers: drivers, matchup: matchup, qb: qb,
      /* quarterback notes reach the copy only through qbState (`material`) */
      risks: ((g.risks && g.risks.items) || []).filter(function (r) { return r && !/^qb_/.test(r.key || ''); }).map(function (r) { return r.text; }).filter(Boolean).slice(0, 3),
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
    p.discrepancy = discrepancyOf(g, p);
    if (p.discrepancy && p.discrepancy.review !== 'NONE') flags.push('DISCREPANCY_' + p.discrepancy.review);
    p.weather = weatherOf(forecasts && forecasts[String(g.game_id)], now);
    if (p.weather.state === 'HAZARD') flags.push('WEATHER_HAZARD');
    p.schedule = { kickoff: g.kickoff || null, venue: gm.venue || null, neutral_site: !!gm.neutral_site, home: home, away: away };
    return p;
  }

  function nflRecord(results) {
    var w = 0, l = 0, t = 0;
    (results || []).forEach(function (r) { if (r.result === 'W') w++; else if (r.result === 'L') l++; else if (r.result === 'T') t++; });
    return (w + l + t) ? w + '-' + l + (t ? '-' + t : '') : null;
  }

  function nflPacket(g, slate, inj, quotes, now, links) {
    var home = g.home_team, away = g.away_team, kick = ts(g.kickoff);
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
    if (kick != null && kick <= now) flags.push('KICKED_OFF');
    var gap = market.status !== 'none' && model.available ? gapOf(home, away, model.home_line, market.home_line) : null;
    var mfav = market.status !== 'none' ? favOf(home, away, market.home_line) : null;
    var p = {
      league: 'nfl', game_id: g.game_id, season: g.season, week: g.week,
      kickoff: g.kickoff, kickoff_text: kick == null ? null : whenText(kick),
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
      var games = all.filter(function (g) { return g.week === week; })
        .map(function (g) { return cfbPacket(g, rk, now, links, art.forecasts && art.forecasts.by_game); })
        .sort(function (a, b) { return (ts(a.kickoff) || 0) - (ts(b.kickoff) || 0); });
      attachEvidence(games, art.evidence && art.evidence.cfb);
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
      var ngames = ns.games.filter(function (g) { return g.week === nweek; })
        .map(function (g) { return nflPacket(g, ns, art.nflInjuries, quotes, now, links); })
        .sort(function (a, b) { return (ts(a.kickoff) || 0) - (ts(b.kickoff) || 0); });
      attachEvidence(ngames, art.evidence && art.evidence.nfl);
      var nflNamesAll = {};
      ns.games.forEach(function (g) { nflNamesAll[g.home_team] = 1; nflNamesAll[g.away_team] = 1; });
      snap.nfl = {
        season: ns.season || null, week: nweek, generated_at: ns.generated_at || null,
        team_names: Object.keys(nflNamesAll).filter(Boolean).sort(),
        injuries_as_of: art.nflInjuries && art.nflInjuries.retrieved_at || null,
        games_total: ngames.length,
        fresh_markets: ngames.filter(function (p) { return p.market.status === 'current'; }).length,
        games: ngames
      };
      snap.sources.push({ id: 'nfl_slate', path: ARTIFACTS.nfl_slate, as_of: ns.generated_at || null, what: 'NFL projections and reference lines' });
      if (art.nflInjuries) snap.sources.push({ id: 'nfl_injuries', path: ARTIFACTS.nfl_injuries, as_of: art.nflInjuries.retrieved_at || null, what: 'Official NFL injury report (nflverse)' });
    }
    if (art.evidence) snap.sources.push({ id: 'evidence', path: ARTIFACTS.evidence, as_of: art.evidence.built_at || null, what: 'Football evidence packets: verified stats, availability, results and the model-versus-market explanation' });

    /* ── RESULTS: the model's graded record (postgame reviews) ── */
    snap.results = {};
    ['cfb', 'nfl'].forEach(function (lg) {
      var rec = art.records && art.records[lg];
      if (!rec || !rec.games) return;
      var R = resultsOf(rec, lg, now, art.published);
      if (!R) return;
      snap.results[lg] = R;
      snap.sources.push({ id: 'record_' + lg, path: ARTIFACTS.record.replace('{league}', lg).replace('{season}', rec.season), as_of: rec.updated_at || null,
        what: (lg === 'cfb' ? 'College football' : 'NFL') + ' model record: pregame numbers graded on the final and against the closing line' });
    });
    return snap;
  }

  /* One graded game, as a review prints it. The model's number is the last
     one published before kickoff (the record's "pick"); nothing is re-derived. */
  function resultPacket(g, league, post) {
    var pk = g.pick || {}, gr = g.grade || {}, fin = g.final || {}, e = gr.error || {};
    var hl = isNum(pk.home_line) ? pk.home_line : g.home_line, wp = isNum(pk.home_win_prob) ? pk.home_win_prob : g.home_win_prob;
    var f = favOf(g.home, g.away, r1(hl)) || { favorite: null, underdog: null, margin: 0 };
    var diff = fin.home_score - fin.away_score;
    var winner = diff > 0 ? g.home : diff < 0 ? g.away : null, loser = diff > 0 ? g.away : diff < 0 ? g.home : null;
    var cl = g.close && isNum(g.close.home_line) ? favOf(g.home, g.away, g.close.home_line) : null;
    return {
      league: league, game_id: String(g.game_id), week: g.week, kickoff: g.kickoff, kickoff_text: g.kickoff ? whenText(ts(g.kickoff)) : null, home: g.home, away: g.away,
      final: { home: fin.home_score, away: fin.away_score, winner: winner, loser: loser, margin: Math.abs(diff),
        score: Math.max(fin.home_score, fin.away_score) + '-' + Math.min(fin.home_score, fin.away_score), source: fin.source || null },
      pre: { home_line: r1(hl), favorite: f.favorite, underdog: f.underdog, margin: f.margin,
        fav_win_pct: isNum(wp) && f.favorite ? Math.round((f.favorite === g.home ? wp : 1 - wp) * 100) : null, total: isNum(pk.total) ? r1(pk.total) : isNum(g.total) ? r1(g.total) : null },
      close: cl ? { home_line: g.close.home_line, favorite: cl.favorite, margin: cl.margin, total: isNum(g.close.total) ? g.close.total : null, book: g.close.book || null } : null,
      grade: { su: gr.su && gr.su.result || null, spread: gr.spread && gr.spread.result || null, total: gr.total && gr.total.result || null,
        model_err: isNum(e.model_margin_err) ? r1(e.model_margin_err) : null, close_err: isNum(e.close_margin_err) ? r1(e.close_margin_err) : null },
      postgame_url: post && post[String(g.game_id)] || null
    };
  }
  function tally(list) {
    var t = { games: list.length, su_w: 0, su_l: 0, ats_w: 0, ats_l: 0, ats_p: 0, ou_w: 0, ou_l: 0, ou_p: 0, compared: 0, closer: 0, model_err_sum: 0, close_err_sum: 0 };
    list.forEach(function (x) {
      var gr = x.grade;
      if (gr.su === 'win') t.su_w++; else if (gr.su === 'loss') t.su_l++;
      if (gr.spread === 'win') t.ats_w++; else if (gr.spread === 'loss') t.ats_l++; else if (gr.spread === 'push') t.ats_p++;
      if (gr.total === 'win') t.ou_w++; else if (gr.total === 'loss') t.ou_l++; else if (gr.total === 'push') t.ou_p++;
      if (isNum(gr.model_err) && isNum(gr.close_err)) { t.compared++; t.model_err_sum += gr.model_err; t.close_err_sum += gr.close_err; if (gr.model_err < gr.close_err) t.closer++; }
    });
    t.su_games = t.su_w + t.su_l;
    t.su_pct = t.su_games ? Math.round(100 * t.su_w / t.su_games) : null;
    t.model_err_avg = t.compared ? r1(t.model_err_sum / t.compared) : null;
    t.close_err_avg = t.compared ? r1(t.close_err_sum / t.compared) : null;
    delete t.model_err_sum; delete t.close_err_sum;
    return t;
  }
  /* the most recent finished week: every graded game kicked off before now,
     the last one within six days */
  function resultsOf(rec, league, now, published) {
    var post = {};
    var pub = published && (published.articles || published);
    if (Array.isArray(pub)) pub.forEach(function (a) { if (a && a.type === 'postgame' && a.game_id && a.url) post[String(a.game_id)] = a.url; });
    var all = (Array.isArray(rec.games) ? rec.games : Object.keys(rec.games).map(function (k) { return rec.games[k]; }))
      .filter(function (g) { return g && g.grade && g.grade.status === 'GRADED' && g.final && isNum(g.final.home_score) && ts(g.kickoff) != null && ts(g.kickoff) < now; });
    if (!all.length) return null;
    var weeks = uniq(all.map(function (g) { return g.week; })).filter(isNum).sort(function (a, b) { return b - a; });
    var pick = null;
    for (var i = 0; i < weeks.length && !pick; i++) {
      var wk = all.filter(function (g) { return g.week === weeks[i]; });
      var last = Math.max.apply(null, wk.map(function (g) { return ts(g.kickoff); }));
      if (now - last <= 6 * 86400000 && wk.length >= (league === 'nfl' ? 4 : 6)) pick = { week: weeks[i], games: wk, last: last };
      if (now - last > 6 * 86400000) break;
    }
    var season = tally(all.map(function (g) { return resultPacket(g, league, post); }));
    if (!pick) return { season_year: rec.season, week: null, results: [], week_record: null, season_record: season, as_of: rec.updated_at || null };
    var results = pick.games.map(function (g) { return resultPacket(g, league, post); }).sort(function (a, b) { return (ts(a.kickoff) || 0) - (ts(b.kickoff) || 0); });
    return { season_year: rec.season, week: pick.week, last_kickoff: iso(pick.last), results: results, week_record: tally(results), season_record: season, as_of: rec.updated_at || null };
  }

  /* one evidence packet per game (football/evidence/packets.json), and the
     underdog's best measured case for the upset lines */
  function attachEvidence(games, set) {
    var packets = (set && set.packets) || {};
    games.forEach(function (p) {
      var ev = packets[String(p.game_id)] || null;
      /* a packet built from older research than this page shows is refused,
         never mixed in: the gate then fails closed for the game */
      var off = function (a, b) { return isNum(a) !== isNum(b) || (isNum(a) && Math.abs(a - b) > 0.05); };
      if (ev && ((ev.model && off(ev.model.home_line, p.model && p.model.available ? p.model.home_line : null)) || (ev.market && ev.market.status !== 'none' && p.market && p.market.status !== 'none' && off(ev.market.home_line, p.market.home_line)))) {
        p.evidence_stale = 'the evidence packet was built from different numbers than this research (model or line changed since); rebuild with node tools/content/evidence.js build';
        ev = null;
      }
      p.evidence = ev;
      if (!ev || !p.model.available || !p.model.underdog) return;
      var dog = p.model.underdog;
      var best = (ev.claims || []).filter(function (c) { return c.football && c.measured && c.leans === dog && c.strength && c.topic !== 'results'; })
        .sort(function (a, b) { return ({ large: 3, moderate: 2, small: 1 }[b.strength] || 0) - ({ large: 3, moderate: 2, small: 1 }[a.strength] || 0); })[0];
      if (best) p.underdog_case = best.short || best.text;
    });
  }
  /* research copies: the full packet for a one-game piece, a trimmed one for
     a slate, none where a game is only listed */
  function withEv(list, mode) {
    var F = fe();
    return (list || []).map(function (p) {
      var c = Object.assign({}, p);
      if (mode === 'none') delete c.evidence;
      else if (mode === 'trim' && c.evidence && F) c.evidence = F.trim(c.evidence);
      return c;
    });
  }

  /* the week whose games are still to come: the earliest week with a game
     kicking off after now */
  function chooseWeek(games, now) {
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
    var est = { weekly_preview: 'high', upset_watch: 'medium', conference_race: 'medium', market_discrepancy: 'low', injury_impact: 'medium', trending_story: 'medium', matchup_preview: 'medium', postgame_review: 'medium', matchup_analysis: 'medium' }[kind] || 'medium';
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
    /* EdgeDesk's own pages (first-party formats such as edgedesk_analysis) are
       not publisher articles: the queue offers only what a publisher receives */
    if (o.kind === 'market_discrepancy') return (R.games || []).length === 1 ? ['market_discrepancy', 'matchup_analysis', 'publisher_custom'] : ['model_vs_market', 'publisher_custom'];
    if (o.kind === 'matchup_analysis') return ['matchup_analysis'];
    if (o.kind === 'matchup_preview') return ['matchup_deep_dive', 'publisher_custom'];
    if (o.kind === 'conference_race') return ['conference_race', 'publisher_custom'];
    if (o.kind === 'postgame_review') return ['postgame_review', 'publisher_custom'];
    return [o.league + '_weekly_preview', 'publisher_custom'];
  }
  /* the formats a topic can be written in: what the queue offers, plus
     EdgeDesk's own single-game page (a library format, never queued for a publisher) */
  function formatAllowed(o, format) {
    return formatsFor(o).indexOf(format) >= 0 || (format === 'edgedesk_analysis' && (o.research.games || []).length === 1 && !!o.research.games[0].evidence);
  }
  function baseFormatOf(o, format) {
    var f = formatsFor(o);
    if (!formatAllowed(o, format)) format = f[0];
    return format === 'publisher_custom' ? f[0] : format;
  }
  /* formats about ONE game: the gate holds them to the single-game standard */
  var SINGLE_GAME = { matchup_analysis: true, edgedesk_analysis: true, market_discrepancy: true, trending_story: true, matchup_deep_dive: true };
  function isFirstParty(format) { return !!(FORMATS[format] && FORMATS[format].first_party);
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

    /* 0 · postgame model reviews: the last finished week, graded */
    Object.keys(snap.results || {}).forEach(function (league) {
      var R = snap.results[league];
      if (!R || !R.results.length) return;
      var Lname = league === 'cfb' ? 'College Football' : 'NFL';
      var kw = (league === 'cfb' ? 'college football week ' : 'nfl week ') + R.week + ' recap';
      var d = demandFor(kw, 'postgame_review', opts.gsc);
      var next = snap[league] && snap[league].games && snap[league].games.length ? Math.min.apply(null, snap[league].games.map(function (p) { return ts(p.kickoff) || Infinity; })) : Infinity;
      out.push(mkOpp({
        league: league, season: R.season_year, week: R.week, kind: 'postgame_review',
        title: Lname + ' Week ' + R.week + ' Recap: How EdgeDesk’s Model Did',
        angle: 'The week’s results against EdgeDesk’s pregame numbers and the closing line: what held up, what missed, and what one week can’t tell you.',
        summary: R.week_record.games + ' graded games; right winner in ' + R.week_record.su_w + ' of ' + R.week_record.su_games + '.',
        teams: uniq([].concat.apply([], R.results.map(function (x) { return [x.home, x.away]; }))),
        research: { league: league, season: R.season_year, week: R.week, as_of: R.as_of, kind: 'postgame_review', context: { league: league, season: R.season_year, week: R.week },
          games: [], upsets: [], races: [], results: R.results, week_record: R.week_record, season_record: R.season_record, limitations: [] },
        sources: snap.sources.filter(function (s) { return s.id === 'record_' + league; }).map(function (s) { return { kind: 'edgedesk_research', label: s.what, path: s.path, url: SITE + '/' + s.path, as_of: s.as_of }; }),
        demand: d,
        formats: ['postgame_review', 'publisher_custom'],
        scores: {
          search_relevance: { score: d.measured ? 75 : 60, basis: d.measured ? 'measured Search Console exposure' : 'estimate: “week N recap” queries recur every week' },
          timeliness: { score: clamp(100 - Math.round((now - ts(R.last_kickoff)) / 3600000), 20, 100), basis: 'last graded game ' + whenText(ts(R.last_kickoff)) },
          audience_interest: { score: 60, basis: 'accountability: how the published numbers did' },
          research_availability: { score: R.week_record.compared ? 95 : 70, basis: R.week_record.games + ' graded games' + (R.week_record.compared ? ', ' + R.week_record.compared + ' with a closing line' : '') },
          editorial_relevance: { score: 90, basis: 'grading its own numbers in public is the EdgeDesk distinction' },
          publisher_fit: publisherFit(pub, league, 'postgame_review', 'broad'),
          research_confidence: { score: 90, basis: 'final scores and closing lines from the graded record' }
        },
        expires_at: iso(isFinite(next) ? next : ts(R.last_kickoff) + 6 * 86400000)
      }));
    });

    ['cfb', 'nfl'].forEach(function (league) {
      var L = snap[league]; if (!L || !L.games || !L.games.length) return;
      var upcoming = L.games.filter(function (p) { return p.flags.indexOf('KICKED_OFF') < 0 && p.model.available; });
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

      /* 1 · weekly preview */
      var feature = ranked.slice(0, 6).map(function (x) { return x.p; });
      var kw = (league === 'cfb' ? 'college football week ' : 'nfl week ') + L.week + ' predictions';
      var demand = demandFor(kw, 'weekly_preview', opts.gsc);
      var researchAvail = Math.round(100 * upcoming.length / Math.max(1, L.games_total));
      out.push(mkOpp({
        league: league, season: L.season, week: L.week, kind: 'weekly_preview',
        title: Lname + ' Week ' + L.week + ' Predictions',
        angle: 'A broad preview of the week’s biggest games: EdgeDesk’s projections, the closest calls and the realistic upsets, explained for fans.',
        summary: feature.length + ' featured games from ' + upcoming.length + ' projected; headliner ' + feature[0].away + ' at ' + feature[0].home + '.',
        teams: uniq([].concat.apply([], feature.map(function (p) { return [p.home, p.away]; }))),
        research: { league: league, season: L.season, week: L.week, as_of: L.generated_at, kind: 'weekly_preview', context: contextOf(snap, league), games: withEv(feature, 'trim'), upsets: withEv(upsetsOf(league, upcoming).slice(0, 3), 'none'), races: withEv(league === 'cfb' ? conferenceRaces(snap).slice(0, 3) : [], 'none'), limitations: limitations },
        sources: sourcesOf(snap, league),
        demand: demand,
        formats: [league + '_weekly_preview', 'publisher_custom'],
        scores: {
          search_relevance: { score: demand.measured ? 95 : 85, basis: demand.measured ? 'measured Search Console exposure for the query' : 'estimate: “week N predictions” is a recurring high-intent query pattern' },
          timeliness: timelinessScore(firstKick, now),
          audience_interest: { score: clamp(50 + ranked.slice(0, 6).reduce(function (a, x) { return a + Math.max(0, x.interest); }, 0) / 12, 0, 100) | 0, basis: 'featured games include ' + sentenceList(uniq([].concat.apply([], ranked.slice(0, 6).map(function (x) { return x.why; }))).slice(0, 4)) },
          research_availability: { score: researchAvail, basis: upcoming.length + ' of ' + L.games_total + ' games have a current EdgeDesk projection' },
          editorial_relevance: { score: 90, basis: 'projections for every featured game, explained as research rather than picks' },
          publisher_fit: publisherFit(pub, league, 'weekly_preview', 'broad'),
          research_confidence: { score: confidenceScore(conf, L, league), basis: confidenceBasis(conf, L, league) }
        },
        expires_at: iso(lastKick)
      }));

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
          research: { league: league, season: L.season, week: L.week, as_of: L.generated_at, kind: 'upset_watch', context: contextOf(snap, league), games: withEv(ups.slice(0, 4), 'trim'), upsets: withEv(ups.slice(0, 4), 'none'), races: [], limitations: limitations },
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
          /* the rest of the conference's top three, wherever they play this week */
          var tops = (L.rankings.conference_top[cname] || []).slice(0, 3);
          var others = tops.filter(function (t) { return !gs.some(function (p) { return p.home === t || p.away === t; }); })
            .map(function (t) { return upcoming.filter(function (p) { return p.home === t || p.away === t; })[0]; }).filter(Boolean);
          var kw3 = cname.toLowerCase() + ' championship race';
          var d3 = demandFor(kw3, 'conference_race', opts.gsc);
          var k0 = ts(gs[0].kickoff);
          out.push(mkOpp({
            league: league, season: L.season, week: L.week, kind: 'conference_race', slug_part: slugify(cname),
            title: cname + ' Championship Race: What Week ' + L.week + ' Could Decide',
            angle: 'Games between the conference’s highest-rated teams in EdgeDesk’s ratings, and what the projections say about the title race.',
            summary: gs.map(function (p) { return p.away + ' at ' + p.home; }).join('; '),
            teams: uniq([].concat.apply([], gs.map(function (p) { return [p.home, p.away]; }))),
            research: { league: league, season: L.season, week: L.week, as_of: L.generated_at, kind: 'conference_race', conference: cname, conference_top: L.rankings.conference_top[cname] || [], context: contextOf(snap, league), games: withEv(gs.concat(uniq(others)), 'trim'), upsets: [], races: withEv(gs, 'trim'), limitations: limitations },
            sources: sourcesOf(snap, league), demand: d3,
            formats: ['conference_race', 'publisher_custom'],
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

      /* 4a · matchup deep dives: the week's two headline games, one at a time */
      ranked.slice(0, 2).forEach(function (x) {
        var p = x.p;
        var kw6 = kwOf(p.away + ' vs ' + p.home) + ' prediction';
        var d6 = demandFor(kw6, 'matchup_preview', opts.gsc);
        out.push(mkOpp({
          league: league, season: L.season, week: L.week, kind: 'matchup_preview', slug_part: String(p.game_id),
          title: p.away + ' vs. ' + p.home + ' Prediction: EdgeDesk’s Full Matchup Breakdown',
          angle: 'One headline game, every input EdgeDesk has: the projection, what builds it, the unit matchup, the market and the conditions.',
          summary: 'EdgeDesk: ' + p.display.fair + ' (' + p.display.win + ')' + (x.why.length ? '; ' + x.why.slice(0, 2).join(', ') : '') + '.',
          teams: [p.home, p.away],
          research: { league: league, season: L.season, week: L.week, as_of: L.generated_at, kind: 'matchup_preview', context: contextOf(snap, league), games: [p], upsets: [], races: [], limitations: limitations },
          sources: sourcesOf(snap, league), demand: d6,
          formats: ['matchup_deep_dive', 'publisher_custom'],
          scores: {
            search_relevance: { score: d6.measured ? 75 : 55, basis: d6.measured ? 'measured Search Console exposure' : 'estimate: “team vs team prediction” queries for a headline game' },
            timeliness: timelinessScore(ts(p.kickoff), now),
            audience_interest: { score: clamp(40 + Math.max(0, x.interest) / 2, 0, 100) | 0, basis: x.why.length ? x.why.slice(0, 3).join(', ') : 'one of the week’s featured games' },
            research_availability: { score: (p.drivers || []).length || (p.injuries && (p.injuries.home || p.injuries.away)) ? 85 : 60, basis: (p.drivers || []).length ? 'projection, drivers, unit matchup and conditions' : 'projection and injury report; no driver breakdown for this league' },
            editorial_relevance: { score: 80, basis: 'a full research view of one game, explained for fans' },
            publisher_fit: publisherFit(pub, league, 'matchup_preview', 'narrow'),
            research_confidence: { score: confidenceScore(avgConfidence([p]), L, league), basis: confidenceBasis(avgConfidence([p]), L, league) }
          },
          expires_at: iso(ts(p.kickoff))
        }));
      });

      /* 4 · market discrepancies: model vs market where a price exists */
      var gaps = upcoming.filter(function (p) { return p.gap && p.gap.points >= RESEARCH_GAP && p.market.status !== 'none'; })
        .sort(function (a, b) { var fa = a.market.status === 'current' ? 1 : 0, fb = b.market.status === 'current' ? 1 : 0; return fb - fa || b.gap.points - a.gap.points; });
      var explainable = gaps.filter(function (p) { return p.discrepancy; });
      if (league === 'nfl' ? gaps.length >= 3 : explainable.length >= 3) {
        var kw4 = (league === 'nfl' ? 'nfl week ' : 'college football week ') + L.week + ' spread predictions';
        var d4 = demandFor(kw4, 'market_discrepancy', opts.gsc);
        var anyCurrent = gaps.some(function (p) { return p.market.status === 'current'; });
        out.push(mkOpp({
          league: league, season: L.season, week: L.week, kind: 'market_discrepancy', slug_part: 'slate',
          title: Lname + ' Week ' + L.week + ': Matchups Where the Numbers Tell a Different Story',
          angle: 'Where EdgeDesk’s projection and the betting line disagree by two points or more — and why a disagreement is a research question, not a bet.',
          summary: gaps.length + ' games with a gap of 2+ points; largest ' + gaps[0].away + ' at ' + gaps[0].home + ' (' + gaps[0].gap.text + ').',
          teams: uniq([].concat.apply([], gaps.slice(0, 5).map(function (p) { return [p.home, p.away]; }))),
          research: { league: league, season: L.season, week: L.week, as_of: L.generated_at, kind: 'market_discrepancy', context: contextOf(snap, league), games: withEv(gaps.slice(0, 5), 'trim'), upsets: [], races: [], limitations: limitations },
          sources: sourcesOf(snap, league), demand: d4,
          formats: ['model_vs_market', 'publisher_custom'],
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
        var verified = p.verification !== 'FAILED';
        var kw5 = kwOf(p.away + ' vs ' + p.home) + ' prediction';
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

      /* 4b · matchup analysis: one game, researched in full — the week's
         headliners and every game where EdgeDesk and the line are far apart.
         A stale line does not disqualify it (the piece says how old the line
         is); a missing evidence packet does. */
      var bigGap = league === 'cfb' ? 7 : 4;
      var maGames = ranked.slice(0, 2).map(function (x) { return x.p; });
      upcoming.filter(function (p) { return p.gap && p.gap.points >= bigGap && p.market.status !== 'none'; })
        .sort(function (a, b) { return b.gap.points - a.gap.points; }).slice(0, 3)
        .forEach(function (p) { if (maGames.indexOf(p) < 0) maGames.push(p); });
      maGames.filter(function (p) { return p.evidence && p.evidence.explanation; }).forEach(function (p) {
        var X = p.evidence.explanation;
        var big = p.gap && p.gap.points >= bigGap;
        var kw8 = slugify(p.away + ' vs ' + p.home).replace(/-/g, ' ') + ' prediction';
        var d8 = demandFor(kw8, 'matchup_analysis', opts.gsc);
        var cov = (p.evidence.coverage || []).filter(function (c) { return c.status !== 'MISSING'; }).length;
        out.push(mkOpp({
          league: league, season: L.season, week: L.week, kind: 'matchup_analysis', slug_part: String(p.game_id),
          title: p.away + ' vs. ' + p.home + (X.headline_question ? ': ' + X.headline_question : ' Preview'),
          angle: big && X.status === 'UNEXPLAINED'
            ? 'A full football read of a game where EdgeDesk and the line are ' + oneDp(p.gap.points) + ' points apart — the evidence on both sides, and an honest account of why EdgeDesk cannot yet explain the gap.'
            : 'A full football read of one of the week’s biggest games: the quarterbacks, the matchups and what has to happen on the field.',
          summary: 'Model ' + p.display.fair + (p.display.market ? ' vs. ' + p.display.market : '') + ' — ' + String(X.status || '').replace(/_/g, ' ').toLowerCase() + (X.input_suspect ? ', inputs suspect' : ''),
          teams: [p.home, p.away],
          research: { league: league, season: L.season, week: L.week, as_of: L.generated_at, kind: 'matchup_analysis', context: contextOf(snap, league), games: withEv([p], 'full'), upsets: [], races: [], limitations: limitations },
          sources: sourcesOf(snap, league), demand: d8,
          formats: ['matchup_analysis'],
          scores: {
            search_relevance: { score: d8.measured ? 80 : 55, basis: d8.measured ? 'measured Search Console exposure' : 'estimate: “team vs team prediction” queries spike in game week' },
            timeliness: timelinessScore(ts(p.kickoff), now),
            audience_interest: { score: clamp(40 + Math.max(0, (league === 'cfb' ? interestCfb(p) : interestNfl(p)).score) / 2 + (big ? 10 : 0), 0, 100) | 0, basis: (big ? 'a ' + oneDp(p.gap.points) + '-point model-versus-line gap; ' : '') + 'a featured game' },
            research_availability: { score: clamp(Math.round(100 * cov / Math.max(1, (p.evidence.coverage || []).length)), 0, 100), basis: cov + ' of ' + (p.evidence.coverage || []).length + ' research items available in the evidence packet' },
            editorial_relevance: { score: 90, basis: 'football evidence on both sides, with the model explained in football terms' },
            publisher_fit: publisherFit(pub, league, 'matchup_analysis', 'narrow'),
            research_confidence: { score: X.input_suspect ? 40 : (X.status === 'UNEXPLAINED' ? 50 : 70), basis: 'explanation status ' + X.status + (X.input_suspect ? '; EdgeDesk’s inputs are suspect' : '') }
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
          research: { league: league, season: L.season, week: L.week, as_of: L.generated_at, kind: 'trending_story', news: [n], context: contextOf(snap, league), games: withEv(games.slice(0, 1), 'trim'), upsets: [], races: [], limitations: limitations },
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
  /* a search phrase as people type it: "texas a&m vs missouri", not "texas a and m vs missouri" */
  function kwOf(t) { return String(t || '').toLowerCase().replace(/\./g, '').replace(/[^a-z0-9&'’\s-]+/g, ' ').replace(/\s+/g, ' ').trim(); }
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
        b.secondary_keywords = [l + ' week ' + w + ' preview', l + ' week ' + w + ' upsets', (o.league === 'cfb' ? 'cfb' : 'nfl') + ' week ' + w + ' projections', head ? kwOf(head) + ' prediction' : null, l + ' week ' + w + ' games to watch'].filter(Boolean);
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
      case 'postgame_review':
        b.primary_keyword = l + ' week ' + w + ' recap';
        b.secondary_keywords = [l + ' week ' + w + ' results', l + ' week ' + w + ' model review', l + ' week ' + w + ' predictions results'];
        b.headline = pgHeadline(o) || o.title;
        b.alternatives = [L + ' Week ' + w + ' Recap: Where the Numbers Held Up and Where They Missed', L + ' Week ' + w + ' Model Review: The Results Against EdgeDesk’s Numbers'];
        b.structure = ['Intro: the week in one line', 'How to read a model review', 'How the numbers did (winners, closer than the close, the misses)', 'Where the model was closest', 'The biggest misses', 'The season so far', 'What a review can’t show', 'Bottom line'];
        break;
      case 'matchup_preview':
        b.primary_keyword = head ? kwOf(head) + ' prediction' : l + ' prediction';
        b.secondary_keywords = head ? [kwOf(head) + ' preview', kwOf(head) + ' projection', l + ' week ' + w + ' predictions'] : [];
        b.headline = head ? [head + ' Prediction: EdgeDesk’s Full Matchup Breakdown', head + ' Prediction: Full Matchup Breakdown', head + ' Prediction and Preview', head + ' Prediction']
          .filter(function (h, i, all) { return h.length <= 70 || i === all.length - 1; })[0] : o.title;
        b.alternatives = head ? [head + ' Preview: What EdgeDesk’s Model Expects', head + ': The Numbers Behind the Week ' + w + ' Headliner'] : [];
        b.structure = ['Intro', 'The projection, with its typical miss', 'How to read it (not a pick)', 'What builds the number', 'The unit matchup', 'Quarterbacks and availability', 'EdgeDesk vs. the market', 'Conditions', 'What the numbers can’t see', 'Bottom line'];
        break;
      case 'market_discrepancy':
        var slate = (R.games || []).length > 1;
        b.primary_keyword = slate ? l + ' week ' + w + ' spread predictions' : (head ? kwOf(head) + ' prediction' : l + ' prediction');
        b.headline = slate ? L + ' Week ' + w + ' Spread Predictions: Model vs. Market' : (head ? head + ' Prediction: Model vs. Line' : o.title);
        b.secondary_keywords = slate ? [l + ' week ' + w + ' model predictions', l + ' week ' + w + ' spreads', l + ' week ' + w + ' predictions'] : [head ? kwOf(head) + ' odds' : null, head ? kwOf(head) + ' spread' : null].filter(Boolean);
        b.intent = 'informational (comparison)';
        b.alternatives = [slate ? L + ' Week ' + w + ' Predictions: ' + cap(numWord(Math.min(5, (R.games || []).length))) + ' Games Where the Numbers Tell a Different Story' : (head + ': Why the Model and the Line Disagree'), 'Why EdgeDesk and the Sportsbooks See ' + (slate ? 'Week ' + w : head || 'This Game') + ' Differently'];
        b.structure = ['Intro', 'The gap, with capture times', 'Why the numbers differ (drivers)', 'How to read a disagreement (not a bet)', 'The case for the market', 'Bottom line'];
        break;
      case 'matchup_analysis':
        var X0 = g0 && g0.evidence && g0.evidence.explanation || {};
        b.primary_keyword = head ? slugify(head).replace(/-/g, ' ') + ' prediction' : l + ' prediction';
        b.secondary_keywords = head ? [slugify(head).replace(/-/g, ' ') + ' preview', slugify(head).replace(/-/g, ' ') + ' odds', g0.away.toLowerCase() + ' ' + g0.home.toLowerCase() + ' key matchups'] : [];
        b.headline = head ? head + (X0.headline_question ? ': ' + X0.headline_question : ' Prediction and Preview') : o.title;
        b.alternatives = head ? [head + ' Prediction: ' + (X0.status === 'UNEXPLAINED' ? 'Why EdgeDesk’s Number Is So Far From the Line' : 'The Matchups That Decide It'), head + ': The Football Case for Each Side'] : [];
        b.intent = 'informational (analysis)';
        b.structure = ['Opening: why the matchup matters', 'What EdgeDesk sees differently', 'The football evidence (quarterbacks, units, personnel, history)', 'What could make EdgeDesk wrong', 'What has to happen on the field', 'What to watch and what remains uncertain'];
        break;
      case 'injury_impact':
        b.primary_keyword = String((R.focus && R.focus.player) || '').toLowerCase() + ' injury';
        b.headline = (R.focus && R.focus.player) + ' Injury: What It Means for the ' + (R.focus && R.focus.team);
        b.secondary_keywords = [String((R.focus && R.focus.player) || '').toLowerCase() + ' injury update', String((R.focus && R.focus.team) || '').toLowerCase() + ' quarterback', head ? kwOf(head) + ' prediction' : null].filter(Boolean);
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
    else if (o.kind === 'matchup_analysis') m = (g0 ? g0.away + ' vs. ' + g0.home + ': ' : '') + 'the quarterbacks, the matchups and the evidence on both sides of EdgeDesk’s projection. Research, not picks.';
    else m = 'The latest ' + (o.teams && o.teams[0] || '') + ' news, read against EdgeDesk’s numbers for the next game. Research, not picks.';
    return m.length > 160 ? m.slice(0, 157).replace(/\s+\S*$/, '') + '…' : m;
  }

  /* ======================================================================
     DRAFT — deterministic prose, from the packet only
     ====================================================================== */
  function para() { return Array.prototype.slice.call(arguments).filter(Boolean).join(' '); }

  function fanLine(p, idx) {
    /* "EdgeDesk’s model makes Alabama a 5.3-point favorite (64% to win)" — the
       same facts in a few forms, so six games do not read like six rows */
    var m = p.model;
    if (!m.available) return null;
    if (!m.favorite) return 'EdgeDesk’s model sees ' + p.away + ' at ' + p.home + ' as a pick’em.';
    var win = isNum(m.fav_win_pct) ? m.fav_win_pct + '%' : null;
    if (m.margin < 1) return 'EdgeDesk’s model sees a near coin flip: ' + m.favorite + ' by ' + oneDp(m.margin) + (win ? ', with a ' + win + ' chance to win' : '') + '.';
    var forms = [
      'EdgeDesk’s model makes ' + m.favorite + ' ' + aOrAn(oneDp(m.margin)) + ' ' + oneDp(m.margin) + '-point favorite' + (win ? ', with a ' + win + ' chance to win' : '') + '.',
      'EdgeDesk has ' + m.favorite + ' by ' + oneDp(m.margin) + (win ? ', a ' + win + ' chance to win' : '') + '.',
      m.favorite + ' is EdgeDesk’s ' + oneDp(m.margin) + '-point favorite' + (win ? ' (' + win + ' to win)' : '') + '.'
    ];
    return forms[(idx || 0) % forms.length];
  }
  function scoreLine(p, idx) {
    if (!p.display.score) return null;
    var t = p.display.total;
    return [
      'Projected score: ' + p.display.score + (t ? ' (a projected total of ' + t + ' points).' : '.'),
      'The model’s projected score is ' + p.display.score + (t ? ', a total of ' + t + ' points.' : '.'),
      'That works out to ' + p.display.score + (t ? ' (' + t + ' total points).' : '.')
    ][(idx || 0) % 3];
  }
  function driverLine(p, idx) {
    var d = p.drivers || [];
    if (!d.length || !p.model.favorite) return null;
    var parts = d.slice(0, 2).map(function (x) {
      var lab = String(x.label).replace(/\s*\(.*\)\s*/g, '').toLowerCase();
      return lab + ' (' + oneDp(x.points) + ' points toward ' + x.team + ')';
    });
    var lead = ['The biggest pieces of the projection: ', 'Most of that number comes from ', 'What drives it: '][(idx || 0) % 3];
    return lead + sentenceList(parts) + '.';
  }
  function matchupLine(p, idx) {
    var mu = p.matchup || [];
    if (!mu.length) return null;
    var x = mu[0], unit = String(x.label).toLowerCase();
    var forms = [
      'Matchup to watch: EdgeDesk’s unit data gives ' + x.favors + ' ' + aWord(x.magnitude) + ' ' + x.magnitude + ' edge in the ' + unit + '.',
      'The unit matchup that stands out is the ' + unit + ', where EdgeDesk’s data gives ' + x.favors + ' ' + aWord(x.magnitude) + ' ' + x.magnitude + ' edge.',
      'On the field, ' + x.favors + ' has ' + aWord(x.magnitude) + ' ' + x.magnitude + ' edge in the ' + unit + ' by EdgeDesk’s unit data.'
    ];
    return forms[(idx || 0) % forms.length];
  }
  function aWord(w) { return /^[aeiou]/i.test(String(w)) ? 'an' : 'a'; }
  function marketLine(p, idx) {
    var m = p.market;
    if (!m || m.status === 'none' || !p.display.market) return null;
    var gapTxt = p.gap && p.gap.points >= 0.1
      ? [' That is ' + oneDp(p.gap.points) + ' points away from EdgeDesk’s number, toward ' + p.gap.toward + '.',
         ' EdgeDesk leans ' + oneDp(p.gap.points) + ' points further toward ' + p.gap.toward + '.',
         ' The gap: ' + oneDp(p.gap.points) + ' points, with EdgeDesk closer to ' + p.gap.toward + '.'][(idx || 0) % 3]
      : ' EdgeDesk’s number is essentially the same.';
    if (m.status === 'current') return 'The betting line: ' + p.display.market + '.' + gapTxt + ' A gap is a question for research, not a reason to bet.';
    if (m.status === 'stale') return 'Historical line: ' + p.display.market + '.' + gapTxt;
    return 'For reference, the ' + p.display.market + ' had ' + (favOf(p.home, p.away, m.home_line).favorite || 'neither team') + ' favored. It is a reference, not a sportsbook price.' + gapTxt;
  }
  /* Only a MATERIAL quarterback question reaches the copy (qbState): an
     established starter without an announcement is not news, and no
     announcement is never written as doubt. */
  function qbLine(p) {
    if (p.league !== 'cfb') return null;
    var out = [];
    ['away', 'home'].forEach(function (s) {
      var q = p.qb && p.qb[s]; if (!q || !q.material) return;
      var team = s === 'home' ? p.home : p.away;
      var move = isNum(q.effect_points) && q.player ? ' EdgeDesk’s model moves ' + oneDp(q.effect_points) + ' points if ' + q.player + ' doesn’t start' + (q.flips_favorite ? ', enough to flip the favorite' : '') + '.' : '';
      if (q.status === 'AVAILABILITY') out.push(String(q.availability).replace(/\.?$/, '.') + (q.availability_source ? ' (Source: ' + q.availability_source + '.)' : '') + move);
      else if (q.status === 'COMPETITION') { var f = competitionFact(q); out.push(team + '’s quarterback job is unresolved in the play-by-play data' + (f ? ': ' + f : '') + '.' + move); }
    });
    return out.length ? 'Quarterback: ' + out.join(' ') : null;
  }
  /* qbOnly: the article has its own injury-report section, so a game's
     capsule names only a listed starting quarterback */
  function injuryLine(p, qbOnly) {
    var out = [];
    ['away', 'home'].forEach(function (s) {
      var i = p.injuries && p.injuries[s]; if (!i) return;
      var team = s === 'home' ? p.home : p.away;
      var q = (i.qbs || []).filter(function (x) { return x.starter; })[0];
      if (q) out.push(team + ' ' + verb(p.league, 'lists', 'list') + ' starting quarterback ' + q.name + ' as ' + String(q.status).toLowerCase() + (q.injury ? ' (' + String(q.injury).toLowerCase() + ')' : '') + ' on the official injury report.');
      else if (i.out_count && !qbOnly) out.push(team + ' ' + verb(p.league, 'lists', 'list') + ' ' + numWord(i.out_count) + ' player' + (i.out_count === 1 ? '' : 's') + ' as out.');
    });
    return out.length ? 'Injury report: ' + out.join(' ') : null;
  }
  /* the football confidence score measures EVIDENCE QUALITY (the confidence
     ledger's information_confidence), so it is printed as data quality and
     explained once in "How to read these numbers" */
  function confLine(p) {
    var d = p.model && p.model.data_quality;
    if (!d || !isNum(d.score)) return null;
    return 'Data quality: ' + d.score + '/100' + (d.band === 'low' ? ' — low, so several of this game’s inputs are missing or unresolved' : '') + '.';
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
    if (p.evidence && p.evidence.explanation) return capsuleEv(p, opts);
    var lines = [fanLine(p, opts.idx), scoreLine(p, opts.idx), driverLine(p, opts.idx), opts.short ? null : matchupLine(p, opts.idx), marketLine(p, opts.idx), p.league === 'cfb' ? qbLine(p) : injuryLine(p, opts.injurySection), confLine(p)];
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

  function howToRead(o, opts) {
    opts = opts || {};
    var gs = (o.research.games || []).filter(function (p) { return p.model.available; });
    var misses = gs.map(function (p) { return p.model.typical_miss; }).filter(isNum).map(Math.round);
    var lo = misses.length ? Math.min.apply(null, misses) : null, hi = misses.length ? Math.max.apply(null, misses) : null;
    var dq = !opts.noDataQuality && gs.some(function (p) { return p.model.data_quality && isNum(p.model.data_quality.score); });
    return para('A projection is the margin and win chance EdgeDesk’s model expects, built from team ratings, home field and matchup data.',
      'A projection is not a bet. A team can be the likelier winner and still be a poor wager if the betting line already expects more than the model does, which is why this article doesn’t make picks.',
      lo != null ? 'Projections miss: EdgeDesk’s typical miss on games like these is about ' + (lo === hi ? lo : lo + ' to ' + hi) + ' points, which is why a win chance matters more than the margin alone.' : null,
      dq ? 'Each game also shows a data-quality score out of 100. It measures how completely EdgeDesk knows that game’s inputs (ratings, quarterbacks, availability, venue), not how likely either team is to win: a near coin flip can have excellent data.' : null,
      'When we compare the model with a sportsbook line, we say where the line came from and when it was captured.',
      o.research && (o.research.games || []).some(function (p) { return p.evidence; }) ? 'Each game below is argued with measured football — quarterback play, how each offense matches up with the other defense, availability — not just the projection.' : null,
      o.league === 'cfb' ? 'Rankings shown with team names (such as No. 6) are EdgeDesk’s own power ratings, not the AP poll.' : null);
  }

  function upsetsSection(o, gamesShown) {
    var ups = (o.research.upsets || []).filter(function (p) { return o.kind === 'upset_watch' || gamesShown.indexOf(p.game_id) < 0 || true; });
    if (!ups.length) return null;
    var caught = uniq(ups.slice(0, 3).filter(function (p) { return p.favorite_flip && p.market.status === 'stale' && p.market.captured_text; }).map(function (p) { return p.market.captured_text; }));
    var lines = ups.slice(0, 3).map(function (p, i) {
      var favRank = p.model.favorite === p.home ? p.home_rank : p.away_rank;
      var rankTxt = p.league === 'cfb' && isNum(favRank) && favRank <= 25 ? ' (No. ' + favRank + ' in EdgeDesk’s ratings)' : '';
      var s = '- **' + p.model.underdog + '** over ' + p.model.favorite + rankTxt + ': the model gives ' + p.model.underdog + ' a ' + p.model.dog_win_pct + '% chance.' + (p.underdog_case ? ' Its best measured case: ' + sent(p.underdog_case) : '');
      var which = p.market.status === 'current' ? 'current betting line' : p.market.status === 'stale' ? 'historical line' : 'reference line';
      if (p.favorite_flip && p.market.status !== 'none') s += [' The ' + which + ' has the favorite the other way around.', ' The ' + which + ' favored ' + p.model.underdog + ' instead.', ' The ' + which + ' made ' + p.model.underdog + ' the favorite.'][i % 3];
      return s;
    });
    return para('An underdog the model gives a 30 percent chance or better still loses more often than it wins, but over a full slate a few of them come through.') + '\n\n' + lines.join('\n') + '\n\n'
      + (caught.length ? 'The historical lines here were captured ' + sentenceList(caught) + '; lines move, so they are context, not current prices. ' : '')
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
    var lines = gs.slice(0, 5).map(function (p, i) {
      return '- **' + p.away + ' at ' + p.home + ':** ' + [
        'EdgeDesk has ' + p.display.fair + '; the line was ' + p.display.market + '. Gap: ' + p.gap.text + '.',
        'the line was ' + p.display.market + ', while EdgeDesk has ' + p.display.fair + ' — a gap of ' + p.gap.text + '.',
        'a gap of ' + p.gap.text + ': EdgeDesk has ' + p.display.fair + ' against a line of ' + p.display.market + '.'][i % 3];
    });
    return intro + '\n\n' + lines.join('\n') + '\n\n' + 'A gap means the model and the market weigh something differently. Sometimes the model has spotted something; often the market knows something the model can’t see, like an injury that hasn’t been reported yet.';
  }

  /* the games whose model–market gap is big enough to explain (≤ 3, largest first) */
  function disagreementGames(o, shown, max) {
    var rank = { BLOCK: 0, REVIEW: 1, NONE: 2 };
    return (shown || o.research.games || []).filter(function (p) { return p.discrepancy; })
      .sort(function (a, b) { return (rank[a.discrepancy.review] - rank[b.discrepancy.review]) || (b.discrepancy.points - a.discrepancy.points); }).slice(0, max || 3);
  }
  /* One gap, explained from EdgeDesk's own inputs — never a story invented to
     fit the number. What the inputs cannot explain is said to be unexplained. */
  function discrepancyText(p, idx, opts) {
    idx = idx || 0;
    var d = p.discrepancy;
    if (!d) return null;
    var football = !(opts && opts.football === false) ? gapFootball(p, idx, opts) : null;
    var mk = p.market.status === 'current' ? 'the current line is ' : p.market.status === 'stale' ? 'the historical line had ' : 'the reference line had ';
    var ln = p.market.status === 'current' ? 'current line' : p.market.status === 'stale' ? 'historical line' : 'reference line';
    var head = '**' + p.away + (p.neutral_site ? ' vs. ' : ' at ') + p.home + '.** ';
    var out = [head + [
      'EdgeDesk has ' + p.display.fair + '; ' + mk + p.display.market + ', ' + aOrAn(oneDp(d.points)) + ' ' + oneDp(d.points) + '-point gap toward ' + d.toward + '.',
      cap(mk) + p.display.market + ', against EdgeDesk’s ' + p.display.fair + '. The two are ' + oneDp(d.points) + ' points apart, with EdgeDesk closer to ' + d.toward + '.',
      'EdgeDesk’s ' + p.display.fair + ' sits ' + oneDp(d.points) + ' points from the ' + ln + ' (' + p.display.market + '), toward ' + d.toward + '.'][idx % 3]];
    var tail = football ? ' ' + football : '';
    if (d.terms.length) out.push('EdgeDesk’s number is built from ' + sentenceList(d.terms.map(function (t) { return t.label + ' (' + t.team + ' +' + oneDp(t.points) + ')'; })) + '.');
    var mi = d.market_implied;
    if (mi && mi.term === 'rating') {
      out.push(idx % 2 === 0
        ? 'Holding everything else at EdgeDesk’s values, the market’s consensus implies ' + mi.implied_team + ' is ' + oneDp(mi.implied) + ' points better on a neutral field, where EdgeDesk has ' + mi.edgedesk_team + ' ' + oneDp(mi.edgedesk) + ' points better: the disagreement is about how strong the two teams are.'
        : 'The disagreement sits in team strength: on a neutral field EdgeDesk has ' + mi.edgedesk_team + ' ' + oneDp(mi.edgedesk) + ' points better, while the market’s consensus implies ' + mi.implied_team + ' ' + oneDp(mi.implied) + ' points better, everything else held at EdgeDesk’s values.');
    }
    d.facts.forEach(function (f) { out.push(f.text); });
    if (d.unexplained_pct == null) out.push('EdgeDesk has no breakdown of this gap, so it can’t say what explains it.');
    else if (d.status === 'EXPLAINED') out.push('How the closing market has historically weighed parts of EdgeDesk’s number accounts for most of a gap like this (' + d.explained_pct + '%)' + (d.parts.length ? ', chiefly ' + sentenceList(d.parts.slice(0, 2).map(function (x) { return x.label; })) : '') + '.');
    else out.push('How the closing market has historically weighed parts of EdgeDesk’s number accounts for about ' + d.explained_pct + '% of a gap like this' + (d.parts.length ? ' (' + sentenceList(d.parts.slice(0, 2).map(function (x) { return x.label; })) + ')' : '') + '; the other ' + d.unexplained_pct + '% is not explained by anything EdgeDesk measures.');
    return out.join(' ') + tail;
  }
  function discrepancySection(o, shown, max, opts) {
    var gs = disagreementGames(o, shown, max);
    if (!gs.length) return null;
    var open = gs.some(function (p) { return p.discrepancy.review !== 'NONE'; });
    var div = gs.some(function (p) { return p.discrepancy.facts.some(function (f) { return f.key === 'rating_divergence'; }); });
    return 'EdgeDesk compares its numbers with the betting market to find questions worth asking, not bets. These are the largest gaps among the games above, with what EdgeDesk’s own inputs can and can’t explain.'
      + (open ? ' Where most of a gap is unexplained, treat it as a question to investigate, not an edge: it can mean the market knows something the model doesn’t.' : '')
      + (div ? ' Where EdgeDesk flags a large divergence between a team’s current rating and its pricing state, those games have historically carried larger model error: a research flag, not a price adjustment.' : '')
      + '\n\n' + gs.map(function (p, i) { return discrepancyText(p, i, opts); }).join('\n\n');
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
    gs.filter(function (p) { return p.weather && p.weather.state === 'HAZARD'; }).slice(0, 2).forEach(function (p) {
      bullets.push('**Weather:** the forecast for ' + p.away + ' at ' + p.home + ' calls for ' + sentenceList(p.weather.hazards) + ' around kickoff (' + (p.weather.source || 'open-meteo forecast') + (p.weather.as_of ? ', as of ' + whenText(ts(p.weather.as_of)) : '') + '). EdgeDesk’s projected margin does not move for weather.');
    });
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

  /* market discrepancy, one game: the gap, then the football on both sides */
  function mdSections(o) {
    var p = o.research.games[0];
    if (p.evidence && p.evidence.explanation) return mdSectionsEv(o, p);
    var s = {};
    s.intro = para(p.away + (p.neutral_site ? ' vs. ' : ' at ') + p.home + ' is one of the games where EdgeDesk’s number and the betting line disagree the most this week.', 'EdgeDesk has no football evidence packet for it, so this piece cannot explain the gap.');
    s.the_gap = para(fanLine(p), marketLine(p));
    s.why_they_differ = 'EdgeDesk does not have the football evidence to explain this gap.';
    s.how_to_read = howToRead(o);
    s.market_case = 'Without football evidence, the market’s number deserves the benefit of the doubt.';
    s.conclusion = 'A gap without football evidence is not publishable analysis; it is not a bet either.';
    return s;
  }
  function mdSectionsEv(o, p) {
    var X = p.evidence.explanation || {}, S = sidesOf(p), C = evClaims(p), used = {}, s = {};
    var F = fe();
    var q = X.critical_matchup && X.critical_matchup.question_text;
    s.intro = para(p.away + (p.neutral_site ? ' vs. ' : ' at ') + p.home + (p.kickoff_text ? ' (' + p.kickoff_text + ')' : '') + ' is one of the games where EdgeDesk’s number and the betting line disagree the most this week.',
      q ? 'The football question underneath it: ' + q : null);
    s.the_gap = para(X.thesis, disclosure(p));
    var pro = pickClaims(S.pro, 3, used);
    var qb = [];
    ['away', 'home'].forEach(function (side) {
      var Q = qbOf(p, side);
      var out = Q.status.filter(function (c) { return c.verification === 'OFFICIAL_REPORT' && c.status === 'OUT'; }).map(function (c) { return c.subject; });
      Q.season.filter(function (c) { return out.indexOf(c.subject) < 0; }).slice(0, 1).forEach(function (c) { used[c.id] = 1; qb.push(sent(c.text)); });
      Q.status.filter(function (c) { return c.verification === 'OFFICIAL_REPORT' && c.status !== 'NOT_LISTED'; }).forEach(function (c) { used[c.id] = 1; qb.push(sent(c.text)); });
      Q.conflict.forEach(function (c) { used[c.id] = 1; qb.push(sent(c.text)); });
    });
    s.why_they_differ = [pro.length ? 'The football that points toward ' + S.forTeam + ': ' + pro.map(function (c) { return sent(stripWhen(c.text)); }).join(' ') : null,
      qb.length ? '**The quarterbacks.** ' + qb.join(' ') : null].filter(Boolean).join('\n\n');
    s.how_to_read = howToRead(o);
    var con = pickClaims(S.con, 3, used);
    var inj = (F ? F.writer.materialInjuries(p.evidence) : []).filter(function (c) { return !used[c.id]; });
    s.market_case = [con.length ? 'The case for ' + S.against + ': ' + con.map(function (c) { return sent(stripWhen(c.text)); }).join(' ') : null,
      inj.length ? 'Availability: ' + inj.map(function (c) { used[c.id] = 1; return /^fact:/.test(c.key) ? linkReported(p, c) : sent(c.text); }).join(' ') : null].filter(Boolean).join('\n\n');
    s.limits = limitsSection(o);
    s.conclusion = para(X.critical_matchup && X.critical_matchup.watch ? 'Watch ' + X.critical_matchup.watch + '.' : null,
      X.status === 'UNEXPLAINED' ? 'Until EdgeDesk can explain the gap, it is an open question, not a bet.' : 'That is a research question worth following through the week, not a bet.');
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
      var foot = '';
      if (p.evidence && p.evidence.explanation) {
        var tm = news ? news.teams[0] : focus.team, sd = p.home === tm ? 'home' : 'away';
        var Qs = qbOf(p, sd), Sx = sidesOf(p);
        var fc = pickClaims([].concat(Qs.season.slice(0, 1), pairsFor(p, tm, 1), Sx.con.slice(0, 1)), 3, {});
        if (fc.length) foot = '\n\n' + 'The football behind it: ' + fc.map(function (c) { return sent(stripWhen(c.text)); }).join(' ');
        var dsc = disclosure(p);
        if (dsc) foot += ' ' + dsc;
      }
      s.research = '**Next game: ' + gameHeading(p) + '**\n\n' + para(fanLine(p), scoreLine(p), driverLine(p), scTxt, marketLine(p), p.league === 'cfb' ? qbLine(p) : injuryLine(p), confLine(p),
        'A projection is not a bet: it is EdgeDesk’s estimate of what is likely, not a judgment about any price.') + foot;
    }
    s.unknowns = para('What we don’t know: final game-day status, how a replacement would actually play, and whether the betting market has already moved.',
      'EdgeDesk’s numbers update as the official report and captured prices do.');
    s.conclusion = para('The report is the news; the projection is EdgeDesk’s estimate of what it might mean. Neither is a pick.');
    return s;
  }


  /* ======================================================================
     EVIDENCE WRITER — football first, every sentence from the packet.
     A capsule or an analysis says what EdgeDesk projects, then argues each
     side with measured football, then says what EdgeDesk cannot explain.
     ====================================================================== */
  var STRENGTH_W = { large: 3, moderate: 2, small: 1 };
  function evClaims(p) { return (p && p.evidence && p.evidence.claims) || []; }
  function evById(p) { var m = {}; evClaims(p).forEach(function (c) { m[c.id] = c; }); return m; }
  function shortOf(c) { return c.short || c.text; }
  function sent(t) { t = String(t || '').trim(); return /[.!?”]$/.test(t) ? t : t + '.'; }
  function linkReported(p, c) {
    /* outside reporting carries its outlet, linked */
    var F = fe(), so = F && F.sourceOf ? F.sourceOf(p.evidence, c) : null;
    var t = sent(c.text);
    if (so && so.publisher && so.url && (c.verification === 'REPORTED' || c.verification === 'VERIFIED_REPORT')) {
      var i = t.lastIndexOf(so.publisher);
      if (i >= 0) t = t.slice(0, i) + '[' + so.publisher + '](' + so.url + ')' + t.slice(i + so.publisher.length);
    }
    return t;
  }
  function claimRank(c) { return (STRENGTH_W[c.strength] || 0) * (c.measured ? 1 : 0.6) * (c.caveat && /small sample/.test(c.caveat) ? 0.5 : 1) + (c.topic === 'matchup' ? 0.1 : 0); }
  function sortStrength(a, b) { return claimRank(b) - claimRank(a); }
  /* which side each list of claims argues for */
  function sidesOf(p) {
    var X = (p.evidence && p.evidence.explanation) || {}, by = evById(p);
    var mf = p.market && p.market.status !== 'none' ? favOf(p.home, p.away, p.market.home_line) : null;
    if (X.gap && X.gap.toward && X.gap.points >= RESEARCH_GAP) {
      var T = X.gap.toward, O = X.gap.other, flip = p.favorite_flip;
      var proLabel = flip ? 'Why ' + T + ' can win' : (p.model.favorite === T ? 'Why ' + T + ' could win by more than the line says' : 'Why it could be closer than the line says');
      var conLabel = flip ? 'Why ' + O + ' can win' : (p.model.favorite === T ? 'Why it could be closer' : 'Why ' + O + ' could win comfortably');
      return { forTeam: T, against: O, pro: (X.supporting || []).map(function (id) { return by[id]; }).filter(Boolean).sort(sortStrength), con: (X.contradicting || []).map(function (id) { return by[id]; }).filter(function (c) { return c && c.football; }).sort(sortStrength), proLabel: proLabel, conLabel: conLabel, gap: true };
    }
    var fav = p.model.favorite || p.home, dog = fav === p.home ? p.away : p.home;
    var foot = evClaims(p).filter(function (c) { return c.football && c.leans && c.strength; });
    return { forTeam: fav, against: dog, pro: foot.filter(function (c) { return c.leans === fav; }).sort(sortStrength), con: foot.filter(function (c) { return c.leans === dog; }).sort(sortStrength),
      proLabel: p.model.favorite ? 'Why ' + fav + ' is favored' : 'The case for ' + fav, conLabel: 'Why ' + dog + ' has a chance', gap: false, market_favorite: mf && mf.favorite };
  }
  /* n claims, never two citing the same numbers, never one already used */
  function pickClaims(list, n, used) {
    used = used || {};
    var out = [];
    (list || []).forEach(function (c) {
      if (out.length >= n || !c) return;
      var k = (c.cite && c.cite.nums || []).join('|');
      if (used[c.id] || (k && used['n:' + k])) return;
      used[c.id] = 1; if (k) used['n:' + k] = 1; out.push(c);
    });
    return out;
  }
  function qbOf(p, side) {
    var team = p[side], C = evClaims(p);
    var qbNames = C.filter(function (c) { return c.team === team && /^(qb_season|team_passing):/.test(c.key) && c.subject; }).map(function (c) { return c.subject; });
    return {
      season: C.filter(function (c) { return c.team === team && /^(qb_season|team_passing):/.test(c.key); }),
      trend: C.filter(function (c) { return c.team === team && /^(qb_trend|team_passing_trend):/.test(c.key) && c.strength; }),
      last: C.filter(function (c) { return c.team === team && /^qb_last:/.test(c.key); }),
      status: C.filter(function (c) { return c.team === team && (c.topic === 'qb_status' || /^report_absent:/.test(c.key) || (c.topic === 'injury' && c.values && c.values.position === 'QB')); }),
      conflict: C.filter(function (c) { return c.team === team && c.verification === 'CONFLICTING' && c.topic === 'input'; }),
      facts: C.filter(function (c) { return c.team === team && /^fact:/.test(c.key) && (c.topic === 'injury' || c.topic === 'qb') && (!c.subject || qbNames.indexOf(c.subject) >= 0 || /quarterback/i.test(c.text)); })
    };
  }
  /* the matchups when one team has the ball: clear edges first, then the
     even ones (an even matchup is information too) */
  var PAIR_ORDER = ['pass', 'rush', 'protection', 'early_downs', 'third_down', 'explosive_pass', 'explosive_rush', 'run_blocking', 'turnovers', 'efficiency', 'red_zone'];
  function pairsFor(p, offenseTeam, n, skip) {
    var by = evById(p);
    var all = ((p.evidence && p.evidence.pairs) || []).filter(function (pr) { return pr.offense === offenseTeam && pr.sample >= 40 && !(skip && skip[pr.claim]) && by[pr.claim]; });
    var edges = all.filter(function (pr) { return pr.favors; }).sort(function (a, b) { return Math.abs(b.edge) - Math.abs(a.edge); });
    var even = all.filter(function (pr) { return !pr.favors; }).sort(function (a, b) { return PAIR_ORDER.indexOf(a.key) - PAIR_ORDER.indexOf(b.key); });
    return edges.concat(even).slice(0, n).map(function (pr) { return by[pr.claim]; });
  }
  function stripWhen(t) { return cap(String(t).replace(/^When .+? ha(?:s|ve) the ball(?: \(([^)]+)\))?: /, function (_, l) { return l ? cap(l) + ': ' : ''; })); }
  function plainFlags(p) {
    var X = (p.evidence && p.evidence.explanation) || {}, C = evClaims(p), out = [];
    (X.input_flags || []).forEach(function (f) {
      if (f.key === 'QB_INPUT_CONFLICT') { var c = C.filter(function (y) { return y.topic === 'input' && y.verification === 'CONFLICTING'; })[0]; if (c) out.push('the model’s quarterback input may be out of date (' + c.short + ')'); }
      else if (f.key === 'QB_ABSENCE_APPLIED') out.push('the model subtracts a full quarterback absence that no official report confirms');
      else if (f.key === 'QB_REPLACEMENT_GENERIC') out.push('the model prices the quarterback absence generically, not the replacement’s own play');
      else if (f.key === 'DATA_FAULT') out.push('EdgeDesk’s own game page already flags the gap as a likely data problem');
      else if (f.key === 'CROSS_MODEL_OUTLIER' && f.severity === 'high') out.push('EdgeDesk’s other models disagree sharply with its published number');
    });
    return uniq(out);
  }
  var PART_PLAIN = { home_field: 'EdgeDesk’s league-wide home-field value', prior: 'how much weight EdgeDesk still gives last season', turnover: 'how EdgeDesk carries last season onto a turned-over roster',
    qb_change: 'a quarterback change', rating: 'the size of EdgeDesk’s rating gap', conference: 'conference strength' };
  /* the same idea in different words for different games: a slate of
     capsules must not repeat one sentence (the gate fails boilerplate) */
  function variant(p, n) { var h = 0, k = String(p.game_id); for (var i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0; return h % n; }
  function disclosure(p, opts) {
    var X = (p.evidence && p.evidence.explanation) || {};
    if (!X.gap || X.gap.points < RESEARCH_GAP) return null;
    var g = oneDp(X.gap.points), flags = plainFlags(p);
    var v = opts && isNum(opts.index) ? opts.index % 5 : variant(p, 5), v3 = v % 3;
    if (X.status === 'UNEXPLAINED' || X.input_suspect) {
      var e = X.mechanical ? oneDp(X.mechanical.explained_points) : null;
      var exp = e == null ? ['EdgeDesk cannot account for most of the ' + g + ' points', 'Most of the ' + g + ' points have no explanation EdgeDesk can point to', 'EdgeDesk has no measured explanation for most of the ' + g + ' points',
            'Nothing EdgeDesk measures accounts for most of this ' + g + '-point gap', 'The bulk of the ' + g + ' points is unexplained by anything in EdgeDesk’s data'][v]
        : [ 'EdgeDesk’s own breakdown accounts for about ' + e + ' of the ' + g + ' points; the rest is unexplained',
            'Only about ' + e + ' of the ' + g + ' points can be traced to identifiable pieces of EdgeDesk’s number; the remainder is unexplained',
            'EdgeDesk can account for roughly ' + e + ' of the ' + g + ' points and cannot explain the rest',
            'About ' + e + ' of the ' + g + ' points trace to known pieces of the model; EdgeDesk cannot explain the other part',
            'EdgeDesk’s breakdown explains roughly ' + e + ' of these ' + g + ' points and leaves the rest unexplained' ][v];
      var warn = flags.length ? (flags.length === 1 ? ' One warning sign points at EdgeDesk’s inputs rather than the football: ' : ' ' + cap(numWord(flags.length)) + ' warning signs point at EdgeDesk’s inputs rather than the football: ') + flags.join('; ') + '.' : '';
      var end = [' Until that changes, the gap is an open question, not an edge.', ' Treat it as an open question, not an edge.', ' That makes it a research question, not an edge.', ' It is not an edge until EdgeDesk can say why.', ' Read the gap as a question for research, not an edge.'][v];
      return exp + '.' + warn + end;
    }
    if (X.status === 'PARTIALLY_EXPLAINED') {
      return ['Part of the ' + g + '-point gap has football support and part does not', 'The football supports some of the ' + g + '-point gap, not all of it', 'Only part of the ' + g + '-point gap is backed by the football'][v3]
        + (X.mechanical ? '; EdgeDesk’s breakdown accounts for about ' + oneDp(X.mechanical.explained_points) + ' of the ' + g + ' points' : '') + ['. It is a research question, not a bet.', '. Read it as research, not a bet.', ' — something to investigate, not to bet.'][v3];
    }
    if (X.status === 'EXPLAINED') {
      var part = X.mechanical && X.mechanical.parts && X.mechanical.parts.slice().sort(function (a, b) { return Math.abs(b.points) - Math.abs(a.points); })[0];
      var hfa = evClaims(p).filter(function (c) { return c.key === 'hfa'; })[0];
      var what = part && part.key === 'home_field' && hfa ? 'EdgeDesk’s league-wide home-field value (' + oneDp(hfa.values.points) + ' points), which the closing market has historically priced at about ' + Math.round((hfa.values.market_priced_share || 0) * 100) + '%'
        : (part ? (PART_PLAIN[part.key] || part.label) + ', which the closing market has historically priced differently' : 'identifiable pieces of EdgeDesk’s number');
      return ['Most of the ' + g + '-point gap traces to ' + what + '. That explains the difference; it does not make either number a bet.',
        'The ' + g + '-point difference comes mostly from ' + what + '. An explained gap is still not a bet.',
        'Nearly all of the ' + g + '-point gap is ' + what + ' — an explanation, not a betting signal.'][v3];
    }
    return null;
  }
  /* a model–market gap, argued with the game's football in a few sentences:
     the case each way, both quarterbacks, and what EdgeDesk cannot explain */
  function gapFootball(p, idx, opts) {
    if (!p.evidence || !p.evidence.explanation) return null;
    var S = sidesOf(p), used = {};
    var pro = pickClaims(S.pro, 1, used), con = pickClaims(S.con, 1, used);
    var qbs = [];
    ['away', 'home'].forEach(function (side) { var s0 = qbOf(p, side).season[0]; if (s0) qbs.push(shortOf(s0)); });
    var lc = function (t) { return String(t).charAt(0).toLowerCase() + String(t).slice(1); };
    var keepCase = function (c) { return /^[A-Z][a-z]+ [A-Z]|^[A-Z]{2,}/.test(shortOf(c)) || (c.team && shortOf(c).indexOf(c.team) === 0); };
    return para(
      pro.length ? 'The football for ' + S.forTeam + ': ' + sent(keepCase(pro[0]) ? shortOf(pro[0]) : lc(shortOf(pro[0]))) : null,
      con.length ? 'Against it: ' + sent(keepCase(con[0]) ? shortOf(con[0]) : lc(shortOf(con[0]))) : null,
      qbs.length && !(opts && opts.qb === false) ? 'At quarterback: ' + qbs.join('; ') + '.' : null,
      disclosure(p, { index: isNum(idx) ? idx : 0 })) || null;
  }

  /* a weekly-preview capsule */
  function capsuleEv(p, opts) {
    opts = opts || {};
    var X = p.evidence.explanation || {}, S = sidesOf(p), used = {};
    var lines = [];
    var q = X.critical_matchup && X.critical_matchup.question_text;
    if (q) lines.push('**The question:** ' + q);
    /* the projection as every capsule prints it: reconciled score, the line with
       its age, data quality (never "confidence") */
    var ix = isNum(opts.idx) ? opts.idx : (isNum(opts.index) ? opts.index : 0);
    lines.push('**EdgeDesk’s view:** ' + para(fanLine(p, ix), scoreLine(p, ix), marketLine(p, ix), confLine(p)));
    var per = opts.tight ? 1 : 2;
    var pro = pickClaims(S.pro, per, used), con = pickClaims(S.con, per, used);
    if (pro.length) lines.push('**' + S.proLabel + ':** ' + pro.map(function (c) { return sent(cap(shortOf(c))); }).join(' '));
    if (con.length) lines.push('**' + S.conLabel + ':** ' + con.map(function (c) { return sent(cap(shortOf(c))); }).join(' '));
    var qb = [];
    ['away', 'home'].forEach(function (side) {
      var Q = qbOf(p, side);
      var out = Q.status.filter(function (c) { return c.verification === 'OFFICIAL_REPORT' && c.status === 'OUT'; }).map(function (c) { return c.subject; });
      var s0 = Q.season.filter(function (c) { return out.indexOf(c.subject) < 0; })[0];
      if (s0) qb.push(sent(cap(shortOf(s0))));
      if (Q.conflict[0]) qb.push(sent(cap(Q.conflict[0].short)));
      else Q.status.filter(function (c) { return c.verification === 'OFFICIAL_REPORT' && c.status !== 'NOT_LISTED'; }).slice(0, 1).forEach(function (st) { qb.push(sent(cap(shortOf(st)))); });
      if (!Q.conflict[0] && !Q.status.some(function (c) { return c.verification === 'OFFICIAL_REPORT' && c.status !== 'NOT_LISTED'; })) {
        var cont = Q.status.filter(function (c) { return c.values && c.values.contested; })[0];
        if (cont) qb.push(sent(cap(shortOf(cont))));
      }
    });
    if (qb.length) lines.push('**Quarterbacks:** ' + qb.join(' '));
    var inj = (fe() ? fe().writer.materialInjuries(p.evidence) : []).filter(function (c) { return c.topic === 'injury' && !(c.values && c.values.position === 'QB') && c.verification === 'OFFICIAL_REPORT' && (!opts.tight || c.status === 'DOUBTFUL' || /^report_out:/.test(c.key)); }).slice(0, opts.tight ? 1 : 2);
    if (inj.length) lines.push('**Availability:** ' + inj.map(function (c) { return sent(cap(shortOf(c))); }).join(' '));
    var d = disclosure(p, { index: opts.index });
    if (d) lines.push('**' + (X.status === 'EXPLAINED' ? 'Why the numbers differ' : 'What EdgeDesk can’t explain') + ':** ' + d);
    if (X.critical_matchup && X.critical_matchup.watch) lines.push('**Watch:** ' + cap(X.critical_matchup.watch) + '.');
    var linkTxt = p.link && opts.links !== false ? 'Full research: [' + p.away + ' vs. ' + p.home + ' on EdgeDesk](' + p.link + ')' : null;
    return '### ' + gameHeading(p) + '\n\n' + lines.join('\n\n') + (linkTxt ? '\n\n' + linkTxt : '');
  }

  /* the single-game analysis: publisher (prose) or first-party (structured) */
  function analysisSections(o, firstParty) {
    var p = o.research.games[0], ev = p.evidence, X = ev.explanation || {}, S = sidesOf(p);
    var C = evClaims(p), used = {}, s = {};
    var F = fe();
    function one(key) { return C.filter(function (c) { return c.key === key; })[0] || null; }
    function lastResult(side) { var r = C.filter(function (c) { return /^result:/.test(c.key) && c.side === side && !/^fact:/.test(c.key); }); return r[r.length - 1] || null; }
    var conf = C.filter(function (c) { return c.topic === 'conference'; })[0];
    var recA = one('record:away'), recH = one('record:home');
    /* reserve the strongest evidence for the sections that argue it */
    var reservePro = pickClaims(S.pro, 3, {}), reserveCon = pickClaims(S.con.filter(function (c) { return c.football; }), 4, {});
    var reserved = {}; reservePro.concat(reserveCon).forEach(function (c) { reserved[c.id] = 1; });

    /* 1 · the opening: why the matchup matters */
    var nflT = p.league === 'nfl';
    var open1 = para((nflT ? 'The ' : '') + p.away + (p.neutral_site ? ' and ' + (nflT ? 'the ' : '') + p.home + ' meet at a neutral site' : (nflT ? ' visit the ' : ' visits ') + p.home) + (p.kickoff_text ? ' on ' + p.kickoff_text : '') + (conf ? ' in ' + conf.values.conference + ' play' : '') + '.',
      recA && sent(recA.text), recH && sent(recH.text), conf && sent(conf.text));
    var la = lastResult('away'), lh = lastResult('home');
    var restC = one('rest');
    var open2 = para(la && sent(la.text), lh && sent(lh.text), restC && sent(restC.text));
    var q = X.critical_matchup && X.critical_matchup.question_text;
    if (firstParty) {
      /* EdgeDesk's own page: a fact sheet first, not the publisher's prose */
      var glance = [
        '- **Kickoff:** ' + (p.kickoff_text || 'time to be announced') + (p.neutral_site ? ', at a neutral site' : ', at ' + p.home) + (conf ? ' (' + conf.values.conference + ')' : '') + '.',
        (recA || recH) ? '- **Records:** ' + [recA, recH].filter(Boolean).map(shortOf).join('; ') + (conf ? '; ' + shortOf(conf) : '') + '.' : null,
        (la || lh) ? '- **Last time out:** ' + [la && p.away + ' ' + shortOf(la), lh && p.home + ' ' + shortOf(lh)].filter(Boolean).join('; ') + '.' : null,
        restC ? '- **Rest:** ' + sent(shortOf(restC)) : null,
        q ? '- **The deciding matchup:** ' + q : null
      ].filter(Boolean);
      s.intro = 'This is EdgeDesk’s own research page for the game: the model’s number, the football for and against it, and what EdgeDesk cannot yet verify.\n\n' + glance.join('\n');
    } else {
      var open3 = para(q ? q + ' That collision sits at the center of this game, and it is the place to start for anyone trying to understand ' + (X.gap && X.gap.points >= RESEARCH_GAP ? 'why EdgeDesk’s model and the betting market see it so differently.' : 'how it will be decided.') : null);
      s.intro = [open1, open2, open3].filter(Boolean).join('\n\n');
    }
    if (restC) used[restC.id] = 1; [la, lh, recA, recH, conf].forEach(function (c) { if (c) used[c.id] = 1; });

    /* 2 · the thesis: what EdgeDesk sees, in model terms and football terms */
    var mk = one('market'); if (mk) used[mk.id] = 1;
    var th = firstParty ? [[
      ev.model && ev.model.text ? '- **EdgeDesk’s model:** ' + ev.model.text + '.' : null,
      mk ? '- **' + (p.market.status === 'current' ? 'Current line' : (p.market.status === 'stale' ? 'Last captured line' : 'Reference line')) + ':** ' + sent(String(mk.text).replace(/^.*? had /, '')) : null,
      X.gap && X.gap.points >= 0.1 ? '- **The difference:** ' + oneDp(X.gap.points) + ' points, toward ' + X.gap.toward + '.' : null,
      X.status ? '- **Research status:** ' + String(X.status).replace(/_/g, ' ').toLowerCase() + (X.input_suspect ? ', with EdgeDesk’s own inputs under suspicion' : '') + '.' : null
    ].filter(Boolean).join('\n')] : [X.thesis];
    /* the first-party page words its disclosure differently from the publisher piece */
    var d = disclosure(p, firstParty ? { index: variant(p, 5) + 2 } : null);
    if (d) th.push((!firstParty && (X.status === 'UNEXPLAINED' || X.input_suspect) ? 'Here is the uncomfortable part. ' : '') + d);
    if (reservePro.length && X.gap && X.gap.points >= RESEARCH_GAP) {
      th.push('The football that does point toward ' + S.forTeam + ':' + '\n\n' + reservePro.map(function (c) { used[c.id] = 1; return '- ' + sent(cap(firstParty ? shortOf(c) : stripWhen(c.text))); }).join('\n'));
    }
    th.push(firstParty ? 'The model’s inputs are itemised under “Inside EdgeDesk’s number” below. A projection is EdgeDesk’s estimate of the game, not a bet.'
      : 'A projection is not a bet. ' + (X.status === 'UNEXPLAINED' ? 'This one comes with a gap EdgeDesk cannot yet explain, which is a reason for more research, not for a wager.' : 'It is EdgeDesk’s estimate of the game, and the evidence below is how to judge it.'));
    s.thesis = th.filter(Boolean).join('\n\n');

    /* 3 · the evidence: quarterbacks, both offenses, personnel, form, history, conditions */
    var E = [];
    var qbBlock = [];
    ['away', 'home'].forEach(function (side) {
      var Q = qbOf(p, side), bits = [];
      Q.season.slice(0, 2).forEach(function (c) { used[c.id] = 1; bits.push(firstParty ? shortOf(c) : c.text); });
      Q.trend.slice(0, 1).forEach(function (c) { used[c.id] = 1; bits.push(c.text); });
      Q.last.slice(0, 1).forEach(function (c) { if (!used[c.id]) { used[c.id] = 1; bits.push(c.text); } });
      Q.status.forEach(function (c) {
        if (used[c.id]) return;
        used[c.id] = 1;
        if (Q.conflict.length && (c.topic === 'qb_status' || /^report_absent:/.test(c.key))) return;   /* the conflict line says it */
        bits.push(c.text);
      });
      Q.facts.forEach(function (c) { if (!used[c.id]) { used[c.id] = 1; bits.push(linkReported(p, c)); } });
      Q.conflict.forEach(function (c) { if (!used[c.id]) { used[c.id] = 1; bits.push(c.text); } });
      if (bits.length) qbBlock.push(firstParty ? bits.map(function (b) { return '- ' + sent(cap(b)); }).join('\n') : bits.map(sent).join(' '));
    });
    if (qbBlock.length) E.push('**The quarterbacks.** ' + (firstParty ? '\n\n' : '') + qbBlock.join(firstParty ? '\n' : '\n\n'));
    ['away', 'home'].forEach(function (side) {
      var team = p[side];
      var prs = pairsFor(p, team, 3, reserved);
      if (!prs.length) return;
      prs.forEach(function (c) { used[c.id] = 1; });
      E.push('**When ' + team + (p.league === 'nfl' ? ' have' : ' has') + ' the ball.** ' + (firstParty ? '\n\n' + prs.map(function (c) { return '- ' + sent(cap(shortOf(c))); }).join('\n') : prs.map(function (c) { return sent(stripWhen(c.text)); }).join(' ')));
    });
    var pos = C.filter(function (c) { return c.topic === 'position' && c.strength && !reserved[c.id] && !used[c.id]; }).sort(sortStrength).slice(0, 3);
    var injs = (F ? F.writer.materialInjuries(ev) : []).filter(function (c) { return !used[c.id] && c.topic === 'injury'; });
    var pers = C.filter(function (c) { return c.topic === 'personnel' && !used[c.id]; });
    var persBits = pos.concat(injs, pers);
    if (persBits.length) {
      persBits.forEach(function (c) { used[c.id] = 1; });
      E.push('**Personnel.** ' + (firstParty ? '\n\n' + persBits.map(function (c) { return '- ' + sent(cap(c.verification === 'REPORTED' ? linkReported(p, c) : shortOf(c))); }).join('\n') : persBits.map(function (c) { return /^fact:/.test(c.key) ? linkReported(p, c) : sent(c.text); }).join(' ')));
    }
    var form = C.filter(function (c) { return (c.topic === 'schedule' || (c.topic === 'results' && /^fact:/.test(c.key)) || c.topic === 'preseason') && !used[c.id] && !reserved[c.id]; });
    if (form.length) {
      form.forEach(function (c) { used[c.id] = 1; });
      E.push('**Form and schedule.** ' + (firstParty ? '\n\n' + form.map(function (c) { return '- ' + (/^fact:/.test(c.key) ? linkReported(p, c) : sent(cap(shortOf(c)))); }).join('\n')
        : form.map(function (c) { return /^fact:/.test(c.key) ? linkReported(p, c) : sent(c.text); }).join(' ')));
    }
    var hist = one('h2h');
    if (hist) { used[hist.id] = 1; E.push('**History.** ' + sent(firstParty ? cap(shortOf(hist)) + ' (earlier meetings were played by different rosters)' : hist.text)); }
    var cond = [one('weather'), one('hfa'), one('neutral'), one('division')].filter(function (c) { return c && !used[c.id]; });
    var CONDL = { weather: 'Forecast', hfa: 'Home field', neutral: 'Site', division: 'Division' };
    if (cond.length) { cond.forEach(function (c) { used[c.id] = 1; }); E.push('**Conditions.** ' + (firstParty ? '\n\n' + cond.map(function (c) { return '- **' + (CONDL[c.key] || 'Note') + ':** ' + sent(shortOf(c)); }).join('\n') : cond.map(function (c) { return sent(c.text); }).join(' '))); }
    s.evidence = E.join('\n\n');

    /* 4 · the counterargument: what could make EdgeDesk wrong */
    var K = [];
    var conTxt = reserveCon.map(function (c) { used[c.id] = 1; return firstParty ? '- ' + sent(cap(shortOf(c))) : sent(stripWhen(c.text)); });
    if (conTxt.length) K.push(firstParty ? 'Where the measured football cuts toward ' + S.against + ':\n\n' + conTxt.join('\n')
      : (X.gap && X.gap.points >= RESEARCH_GAP ? 'The case for ' + S.against + ', and against EdgeDesk’s number, starts with the matchups.' : 'The case for ' + S.against + ' is real.') + ' ' + conTxt.join(' '));
    /* the first-party page lists EdgeDesk's own diagnostics once, inside the number */
    var doubts = firstParty ? [] : ['track_record', 'other_models', 'explainer', 'classification'].map(one).filter(function (c) { return c && !used[c.id] && (X.contradicting || []).concat(c.key === 'classification' ? [c.id] : []).indexOf(c.id) >= 0; });
    if (doubts.length) { doubts.forEach(function (c) { used[c.id] = 1; }); K.push('EdgeDesk’s own record argues for caution, too. ' + doubts.map(function (c) { return sent(c.text); }).join(' ')); }
    var hfaUsed = C.some(function (c) { return c.key === 'hfa' && used[c.id]; });
    var printed = String([s.intro, s.thesis, s.evidence].join(' ') + ' ' + K.join(' '));
    var flags = (X.input_flags || []).filter(function (f) { return (/DATA_CONFLICT|HFA_CONSTANT/.test(f.key) || (firstParty && f.severity !== 'info')) && !(f.key === 'HFA_CONSTANT' && hfaUsed) && !(firstParty && f.key === 'QB_INPUT_CONFLICT') && !(firstParty && f.key === 'DATA_FAULT' && one('classification')) && printed.indexOf(f.text) < 0; });
    if (flags.length) K.push((firstParty ? 'Input audit:\n\n' + flags.map(function (f) { return '- **' + f.key.replace(/_/g, ' ').toLowerCase() + ':** ' + sent(f.text); }).join('\n')
      : flags.map(function (f) { return f.key === 'DATA_CONFLICT' ? 'EdgeDesk’s own sources also disagree on the sack numbers for ' + sentenceList(uniq(C.filter(function (c) { return c.topic === 'data'; }).map(function (c) { return c.team; }))) + '; the figures above use the corroborated counts.' : sent(f.text); }).join(' ')));
    s.counterargument = K.join('\n\n') || 'The evidence against EdgeDesk’s number is thin in the data on file; the uncertainty below is the case against it.';

    /* 5 · the game script each number needs */
    var GS = X.game_script || {};
    var gsTxt = [];
    var mtext0 = ev.market && ev.market.text;
    if (firstParty && GS.units) {
      /* a scorecard: the conditions, without repeating the figures above */
      if (GS.units.model.length) gsTxt.push('**If EdgeDesk’s number (' + (p.display.fair || (ev.model && ev.model.text) || '') + ') is right,** expect to see:\n\n' + GS.units.model.map(function (t) { return '- ' + sent(cap(t)); }).join('\n'));
      if (GS.units.market.length) gsTxt.push('**If the ' + (p.market.status === 'current' ? 'current' : 'last captured') + ' line' + (mtext0 ? ' (' + mtext0 + ')' : '') + ' is right,** expect to see:\n\n' + GS.units.market.map(function (t) { return '- ' + sent(cap(t)); }).join('\n'));
      gsTxt.push('These are conditions, not forecasts; the figures behind each are in the evidence above.');
    }
    if (!(firstParty && GS.units) && (GS.model_case || []).length) gsTxt.push('For EdgeDesk’s number (' + (p.display.fair || '') + ') to look right:\n\n' + GS.model_case.map(function (t) { return '- ' + t; }).join('\n'));
    var mtext = ev.market && ev.market.text;
    if (!(firstParty && GS.units) && (GS.market_case || []).length) gsTxt.push('For the ' + (p.market.status === 'current' ? 'current' : 'last captured') + ' line' + (mtext ? ', ' + mtext + ',' : '') + ' to look right:\n\n' + GS.market_case.map(function (t) { return '- ' + t; }).join('\n'));
    if (!(firstParty && GS.units)) gsTxt.push('Neither list is a prediction. Each is what one number needs from the game.');
    s.game_script = gsTxt.join('\n\n');

    /* 6 · first-party only: inside the number */
    if (firstParty) {
      var terms = C.filter(function (c) { return /^term:/.test(c.key) || c.key === 'hfa' || c.key === 'projection'; });
      var mech = ['explainer', 'other_models', 'track_record', 'classification'].map(one).filter(Boolean);
      var covA = (ev.coverage || []).filter(function (c) { return c.status !== 'MISSING'; }).map(function (c) { return c.label.toLowerCase(); });
      var covM = (ev.coverage || []).filter(function (c) { return c.status === 'MISSING'; }).map(function (c) { return '- ' + cap(c.label.toLowerCase()) + (c.why ? ': ' + c.why : '') + '.'; });
      /* the assessment, less what the page has already said */
      var shown0 = String([s.intro, s.thesis, s.evidence, s.counterargument, s.game_script].join('\n'));
      var assess = X.assessment && F ? F.sentences(String(X.assessment).replace(/^[A-Z_ ]+\.\s*/, '')).filter(function (x) { return shown0.indexOf(x) < 0; }).join(' ') : '';
      s.model_detail = [
        'How EdgeDesk’s number is built for this game:\n\n' + terms.map(function (c) { return '- ' + sent(c.text); }).join('\n'),
        mech.length ? 'What EdgeDesk’s own diagnostics say:\n\n' + mech.map(function (c) { return '- ' + sent(c.text); }).join('\n') : null,
        'Research status: **' + String(X.status || '').replace(/_/g, ' ') + '**' + (X.input_suspect ? ' (inputs suspect)' : '') + '. ' + (assess ? sent(assess) : ''),
        covM.length ? 'Not in EdgeDesk’s verified data for this game:\n\n' + covM.join('\n') : 'Every research item EdgeDesk looks for is on file for this game.',
        p.link ? 'The full game research, with every input and its timestamp: [' + p.away + ' vs. ' + p.home + ' on EdgeDesk](' + p.link + '). How the model works: [EdgeDesk methodology](' + SITE + '/methodology/).' : 'How the model works: [EdgeDesk methodology](' + SITE + '/methodology/).'
      ].filter(Boolean).join('\n\n');
    }

    /* 7 · what to watch, and what we still don't know */
    var W = [];
    if (X.critical_matchup && X.critical_matchup.watch) W.push(cap(X.critical_matchup.watch) + '.');
    ['away', 'home'].forEach(function (side) { var Q = qbOf(p, side); var st = Q.conflict[0] || Q.status.filter(function (c) { return c.values && c.values.contested; })[0]; if (st) W.push('Who starts at quarterback for ' + p[side] + '.'); });
    (F ? F.writer.materialInjuries(ev) : []).filter(function (c) { return c.topic === 'injury' && c.subject && !(c.values && c.values.position === 'QB') && /QUESTIONABLE|DOUBTFUL/.test(c.status || ''); }).slice(0, 2)
      .forEach(function (c) { W.push(c.subject + ', listed ' + String(c.status).toLowerCase() + ': whether he plays, and how much.'); });
    var wx = one('weather'); if (wx && wx.material) W.push('The weather: ' + shortOf(wx) + ' in the forecast.');
    var said = String([s.intro, s.thesis, s.evidence, s.counterargument, s.game_script].join(' ')).replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'), watched = W.join(' ');
    /* the open questions, without repeating what the article or the watch list
       already said; what EdgeDesk does not have on file is always listed */
    var U0 = (X.uncertainty || []).filter(function (t) {
      if (/sources disagree|availability report lists/.test(t) || said.indexOf(t.split(', according to ')[0]) >= 0) return false;
      if (/^Weather:/.test(t) && /The weather:/.test(watched)) return false;
      if (/quarterback job is unsettled/.test(t) && /Who starts at quarterback/.test(watched)) return false;
      return true;
    });
    var must = U0.filter(function (t) { return /^Not in EdgeDesk’s verified data/.test(t); });
    var U = must.concat(U0.filter(function (t) { return must.indexOf(t) < 0; }).slice(0, 5 - must.length));
    if (firstParty) {
      /* the missing data is itemised inside the number; the watch list is terse */
      var seenW = {};
      var injW = (F ? F.writer.materialInjuries(ev) : []).filter(function (c) { if (!(c.topic === 'injury' && c.subject && !(c.values && c.values.position === 'QB') && /QUESTIONABLE|DOUBTFUL/.test(c.status || '')) || seenW[c.subject]) return false; seenW[c.subject] = 1; return true; }).slice(0, 3);
      var W2 = [];
      if (X.critical_matchup && X.critical_matchup.watch) W2.push(cap(X.critical_matchup.watch) + '.');
      ['away', 'home'].forEach(function (side) { var Q = qbOf(p, side); if (Q.conflict[0] || Q.status.some(function (c) { return c.values && c.values.contested; })) W2.push((F ? F.writer.poss(p[side]) : p[side] + '’s') + ' starting quarterback.'); });
      if (injW.length) W2.push(sentenceList(injW.map(function (c) { return c.subject + ' (' + String(c.status).toLowerCase() + ')'; })) + ': who plays, and how much.');
      if (wx && wx.material) W2.push('The kickoff weather.');
      var U2 = U.filter(function (t) { return !/^Not in EdgeDesk’s verified data/.test(t); });
      s.conclusion = (W2.length ? 'Before kickoff, watch:\n\n' + W2.map(function (t) { return '- ' + t; }).join('\n') + '\n\n' : '')
        + (U2.length ? 'Still open:\n\n' + U2.map(function (t) { return '- ' + t; }).join('\n') + '\n\n' : '')
        + (X.status === 'UNEXPLAINED' || X.input_suspect ? 'Until those are settled, EdgeDesk’s number is a research question, not a bet.' : 'EdgeDesk’s number is an estimate of the game, not a pick.');
      return s;
    }
    s.conclusion = (W.length ? 'What to watch:\n\n' + uniq(W).map(function (t) { return '- ' + t; }).join('\n') + '\n\n' : '')
      + (U.length ? 'What EdgeDesk still doesn’t know:\n\n' + U.map(function (t) { return '- ' + t; }).join('\n') + '\n\n' : '')
      + (X.status === 'UNEXPLAINED' ? 'EdgeDesk’s number stays an open question until those answers arrive. None of this is a pick.' : 'None of this is a pick: it is the football that will decide the game, and the uncertainty around it.');
    return s;
  }

  /* ── POSTGAME MODEL REVIEW: the week graded, the misses named, nothing re-scored ── */
  function nick(team, league) { return league === 'nfl' ? String(team).split(' ').slice(-1)[0] : team; }
  function pgHeadline(o) {
    var R = o.research, W = R.week_record, L = o.league === 'cfb' ? 'College Football' : 'NFL';
    if (!W || !W.games) return null;
    var head = L + ' Week ' + o.week + ' Recap: ';
    var miss = (R.results || []).slice().sort(function (a, b) { return (b.grade.model_err || 0) - (a.grade.model_err || 0); })[0];
    var opts = [];
    if (W.compared >= 4 && W.closer / W.compared >= 0.6) opts.push(head + 'EdgeDesk Beat the Closing Line’s Miss in ' + W.closer + ' of ' + W.compared);
    if (W.su_games >= 4 && W.su_w / W.su_games >= 0.7) opts.push(head + 'EdgeDesk Had the Winner in ' + W.su_w + ' of ' + W.su_games + ' Games');
    if (miss && miss.final.winner && miss.final.margin >= 17) opts.push(head + nick(miss.final.winner, o.league) + '’ ' + miss.final.score + ' Win Leads the Week’s Misses');
    opts.push(head + 'Where EdgeDesk’s Numbers Held Up and Where They Missed');
    return opts.filter(function (h, i) { return h.length <= 75 || i === opts.length - 1; })[0];
  }
  function resultLine(x, idx) {
    var p = x.pre, f = x.final, g = x.grade;
    var pre = p.favorite ? 'EdgeDesk had ' + p.favorite + ' by ' + oneDp(p.margin) + (isNum(p.fav_win_pct) ? ' (' + p.fav_win_pct + '% to win)' : '') : 'EdgeDesk saw a pick’em';
    var res = f.winner ? f.winner + ' won ' + f.score : 'it ended in a tie';
    var errTxt = isNum(g.model_err) ? 'a ' + oneDp(g.model_err) + '-point miss on the margin' : null;
    var cl = x.close ? (x.close.favorite ? x.close.favorite + ' -' + String(r1(x.close.margin)) : 'pick’em') : null;
    var close = x.close && isNum(g.close_err) ? ['The closing line (' + cl + ') missed by ' + oneDp(g.close_err) + '.',
      'The market closed at ' + cl + ', ' + oneDp(g.close_err) + ' points from the final margin.',
      'For comparison, the closing line of ' + cl + ' was off by ' + oneDp(g.close_err) + '.'][(idx || 0) % 3] : null;
    var forms = [pre + '; ' + res + (errTxt ? ', ' + errTxt : '') + '.', res + ' after ' + pre.replace(/^EdgeDesk had/, 'EdgeDesk projected').replace(/^EdgeDesk saw/, 'EdgeDesk projected') + (errTxt ? ': ' + errTxt : '') + '.'];
    return para(forms[(idx || 0) % 2], close);
  }
  function pgSections(o) {
    var R = o.research, W = R.week_record, S = R.season_record, s = {};
    var L = o.league === 'cfb' ? 'college football' : 'NFL';
    var res = R.results || [];
    if (!res.length) return s;
    s.intro = para('This recap grades every number EdgeDesk published before kickoff in ' + L + ' Week ' + o.week + ': ' + numWord(W.games) + ' games, scored on the final and against the closing line.',
      'EdgeDesk’s model had the right winner in ' + W.su_w + ' of ' + W.su_games + (W.compared ? ', and its projected margin finished closer to the final than the closing line’s in ' + W.closer + ' of ' + W.compared : '') + '.',
      'Here is where the numbers held up, where they missed, and what one week can and can’t tell you.');
    s.how_to_read = para('Each game is graded the same way: EdgeDesk’s last pregame number against the final score, and next to it the closing line, the market’s last word before kickoff.',
      'A single game can miss by two touchdowns even when the projection was sound, so one week is a small sample; the season record below is the better guide.',
      'This is a record of a model, not betting advice and not a betting result.');
    var bul = ['- **Right winner:** ' + W.su_w + ' of ' + W.su_games + '.'];
    if (W.compared) bul.push('- **Closer to the final than the closing line:** ' + W.closer + ' of ' + W.compared + ' games with a closing line on record.',
      '- **Average miss on the margin:** EdgeDesk ' + oneDp(W.model_err_avg) + ' points; the closing line ' + oneDp(W.close_err_avg) + '.');
    if (W.ats_w + W.ats_l + W.ats_p) bul.push('- **Against the closing spread:** ' + W.ats_w + '-' + W.ats_l + (W.ats_p ? '-' + W.ats_p : '') + ' for the side EdgeDesk’s number leaned to. That grades the number against the market; it is not a betting record.');
    s.scoreboard = bul.join('\n');
    var closest = res.filter(function (x) { return isNum(x.grade.model_err); }).sort(function (a, b) { return a.grade.model_err - b.grade.model_err; }).slice(0, 3);
    if (closest.length) s.closest = closest.map(function (x, i) { return '**' + x.away + ' at ' + x.home + '.** ' + resultLine(x, i) + (x.postgame_url ? ' [Read the postgame analysis](' + x.postgame_url + ').' : ''); }).join('\n\n');
    var ids = closest.map(function (x) { return x.game_id; });
    var misses = res.filter(function (x) { return isNum(x.grade.model_err) && ids.indexOf(x.game_id) < 0; }).sort(function (a, b) { return b.grade.model_err - a.grade.model_err; }).slice(0, 3);
    var bothN = misses.filter(function (x) { return isNum(x.grade.close_err) && x.grade.close_err >= x.grade.model_err - 3; }).length;
    s.misses = misses.length ? (bothN ? (bothN === misses.length ? 'In each of these, the closing line missed by about as much as EdgeDesk did, so the market’s number was no closer.' : 'In ' + numWord(bothN) + ' of these, the closing line missed by about as much as EdgeDesk did.') + '\n\n' : '')
      + misses.map(function (x, i) { return '**' + x.away + ' at ' + x.home + '.** ' + resultLine(x, i + 1) + (x.postgame_url ? ' [Read the postgame analysis](' + x.postgame_url + ').' : ''); }).join('\n\n')
      : 'No game missed by enough to single out.';
    if (S && S.games) s.season = para('Across the ' + R.season + ' season so far, EdgeDesk’s model has had the right winner in ' + S.su_w + ' of ' + S.su_games + ' graded ' + L + ' games (' + S.su_pct + '%).',
      S.compared ? 'Its average miss on the margin is ' + oneDp(S.model_err_avg) + ' points, against ' + oneDp(S.close_err_avg) + ' for the closing line, across ' + S.compared + ' games with both on record.' : null,
      (S.ats_w + S.ats_l) ? 'Against the closing spread, the side its number leaned to is ' + S.ats_w + '-' + S.ats_l + (S.ats_p ? '-' + S.ats_p : '') + '.' : null);
    s.limits = '- **Small samples:** one week of ' + numWord(W.games) + ' games says little about a model on its own; read it next to the season record.\n'
      + '- **Final scores are noisy:** late scores, turnovers and garbage time move a margin without saying much about how the game was played.\n'
      + '- **Closing lines:** a game without a closing line on record is graded on the final only.\n'
      + '- **Uncertainty:** even a 70% favorite loses about three times in ten. Projections describe likelihoods, not outcomes.';
    var top = misses[0];
    s.conclusion = para('The short version: ' + W.su_w + ' of ' + W.su_games + ' winners' + (W.compared ? ', and closer than the closing line in ' + W.closer + ' of ' + W.compared : '') + (top ? '; the biggest miss was ' + top.away + ' at ' + top.home : '') + '.',
      'EdgeDesk publishes these numbers before kickoff and grades every one of them afterward, misses included. None of it is a pick.');
    return s;
  }

  /* ── MATCHUP DEEP DIVE: one game, every input EdgeDesk has, nothing more ── */
  function rankedName(p, side) { return rankTag(p, side) + (side === 'home' ? p.home : p.away); }
  /* the deep dive's football, from the game's evidence packet: each offense
     against the other defense, both quarterbacks, the availability report */
  function ddEvidence(p) {
    if (!p.evidence || !p.evidence.claims) return {};
    var F = fe(), used = {}, out = {};
    var units = [];
    ['away', 'home'].forEach(function (side) { pairsFor(p, p[side], 2, {}).forEach(function (c) { used[c.id] = 1; units.push('- ' + sent(cap(shortOf(c)))); }); });
    if (units.length) out.matchup = 'What the measured football says when each team has the ball:\n\n' + units.join('\n');
    var bits = [];
    ['away', 'home'].forEach(function (side) {
      var Q = qbOf(p, side);
      Q.season.slice(0, 2).forEach(function (c) { bits.push(sent(c.text)); });
      Q.trend.slice(0, 1).forEach(function (c) { bits.push(sent(c.text)); });
      Q.conflict.slice(0, 1).forEach(function (c) { bits.push(sent(c.text)); });
      Q.facts.forEach(function (c) { bits.push(linkReported(p, c)); });
    });
    (F ? F.writer.materialInjuries(p.evidence) : []).filter(function (c) { return c.topic === 'injury'; }).forEach(function (c) { bits.push(/^fact:/.test(c.key) ? linkReported(p, c) : sent(c.text)); });
    if (bits.length) out.personnel = uniq(bits).join(' ');
    return out;
  }
  function ddSections(o) {
    var p = o.research.games[0], m = p.model, s = {};
    var sep = p.neutral_site ? ' vs. ' : ' at ';
    var both = p.league === 'cfb' && isNum(p.home_rank) && isNum(p.away_rank) && p.home_rank <= 25 && p.away_rank <= 25;
    s.intro = para(rankedName(p, 'away') + sep + rankedName(p, 'home') + (p.kickoff_text ? ' kicks off ' + p.kickoff_text + (p.venue ? ' at ' + p.venue : '') : '') + '.',
      both ? 'Both teams are in the top 25 of EdgeDesk’s power ratings' + (p.conference_game && p.home_conference ? ', and the result counts in the ' + p.home_conference + ' standings.' : '.') : (p.conference_game && p.home_conference ? 'The result counts in the ' + p.home_conference + ' standings.' : null),
      fanLine(p, 1),
      'This is EdgeDesk’s full prediction for the game: what the projection says, what builds it, where the matchup tilts, how it compares with the betting market, and what the number can’t see.');
    var rng = /80% range ([^)]+)\)/.exec((p.risks || []).filter(function (r) { return /80% range/.test(r); })[0] || '');
    var tm = m.typical_miss;
    s.the_projection = para(
      m.favorite ? 'EdgeDesk’s model makes ' + m.favorite + ' ' + aOrAn(oneDp(m.margin)) + ' ' + oneDp(m.margin) + '-point favorite.' : 'EdgeDesk’s model sees a pick’em.',
      scoreLine(p, 1),
      isNum(m.fav_win_pct) ? 'Win chances: ' + m.favorite + ' ' + m.fav_win_pct + '%, ' + m.underdog + ' ' + m.dog_win_pct + '%.' : null,
      isNum(tm) ? 'EdgeDesk’s typical miss on a game like this is about ' + Math.round(tm) + ' points' + (rng ? ', and its 80% range runs from ' + rng[1] : '') + '. '
        + (m.margin < tm ? 'A ' + oneDp(m.margin) + '-point margin sits well inside that error, which is why the win chance is the number to watch.' : 'Even a clear projection carries that much error.') : null);
    s.how_to_read = howToRead(o);
    var d = p.drivers || [];
    if (d.length && m.favorite) {
      var signed = d.reduce(function (a, x) { return a + (x.team === m.favorite ? 1 : -1) * x.points; }, 0);
      s.what_drives_it = 'EdgeDesk’s number is a sum of parts, and each part points at one team:\n\n'
        + d.map(function (x) { return '- **' + String(x.label).replace(/\s*\(.*\)\s*/g, '') + ':** ' + oneDp(x.points) + ' points toward ' + x.team + '.'; }).join('\n')
        + (Math.abs(signed - m.margin) > 0.2 ? '\n\nThese are the largest parts; smaller adjustments make up the rest of the ' + oneDp(m.margin) + '-point margin.' : '');
    }
    var mu = p.matchup || [];
    var style = d.filter(function (x) { return /stylistic/i.test(x.label); })[0];
    if (mu.length) {
      s.matchup = 'EdgeDesk’s unit data compares each side’s strengths with the other’s weaknesses:\n\n'
        + mu.map(function (x) { return '- **' + x.label + ':** ' + aWord(x.magnitude) + ' ' + x.magnitude + ' edge for ' + x.favors + '.'; }).join('\n')
        + (style ? '\n\nTaken together, the stylistic matchup moves the projection ' + oneDp(style.points) + ' points toward ' + style.team + '.' : '');
    }
    var pers = [];
    if (p.league === 'cfb') {
      var ql = qbLine(p);
      if (ql) pers.push(ql.replace(/^Quarterback: /, ''));
      ['away', 'home'].forEach(function (side) {
        var q = p.qb && p.qb[side], team = side === 'home' ? p.home : p.away;
        if (!q || q.material || !q.player) return;
        if (q.status === 'CONFIRMED') pers.push(q.player + ' is ' + team + '’s announced starter.');
        else if (q.status === 'ESTABLISHED') pers.push(q.player + ' started ' + team + '’s last game.');
      });
    } else {
      var il = injuryLine(p);
      if (il) pers.push(il.replace(/^Injury report: /, 'From the official injury report: '));
    }
    var avail = p.discrepancy && p.discrepancy.facts.filter(function (f) { return f.key === 'availability'; })[0];
    if (avail) pers.push(avail.text);
    /* the model's own re-run with one input changed: a scenario, not a report */
    ['away', 'home'].forEach(function (side) {
      var sc = p.scenarios && p.scenarios[side + '_qb_out'];
      if (!sc || !isNum(sc.home_line)) return;
      var team = side === 'home' ? p.home : p.away, f2 = favOf(p.home, p.away, sc.home_line);
      /* never "Team by N": that form is the main projection's, and the checks read it as such */
      pers.push('If ' + team + '’s listed starter did not play, the model’s re-run moves the projected margin to ' + (f2.favorite ? oneDp(f2.margin) + ' points in ' + f2.favorite + '’s favor' : 'a pick’em') + (isNum(sc.home_win_prob) ? ', with ' + p.home + ' winning ' + pct(sc.home_win_prob) + ' of the time' : '') + '.');
    });
    if (p.scenarios && (p.scenarios.home_qb_out || p.scenarios.away_qb_out)) pers.push('Each re-run changes one input and gives the replacement the club’s carried quarterback level; it describes the model, not a report that anyone is out.');
    var EV = ddEvidence(p);
    if (EV.personnel) pers.push(EV.personnel);
    if (pers.length) s.personnel = para.apply(null, pers);
    if (EV.matchup) s.matchup = (s.matchup ? s.matchup + '\n\n' : '') + EV.matchup;
    if (p.market && p.market.status !== 'none' && p.display.market) {
      s.market = p.discrepancy ? discrepancyText(p, 0, { qb: false }) : para(marketLine(p, 0), p.evidence ? gapFootball(p, 0, { qb: false }) : null);
      if (p.market.status === 'stale') s.market += '\n\nThat line is historical: it was captured more than three hours before this research was read, and lines move.';
      s.market += ' A gap between a model and a market is a question for research, not a reason to bet.';
    }
    var w = p.weather;
    if (w && w.state === 'INDOOR') s.conditions = 'The game is played indoors, so weather is not a factor.';
    else if (w && (w.state === 'OK' || w.state === 'HAZARD')) {
      var bits = [w.text ? String(w.text).toLowerCase() : null, isNum(w.temp_f) ? w.temp_f + '°F' : null, isNum(w.wind_mph) ? 'wind ' + w.wind_mph + ' mph' : null, isNum(w.gust_mph) ? 'gusts to ' + w.gust_mph + ' mph' : null].filter(Boolean);
      s.conditions = para('The kickoff forecast (' + (w.source || 'open-meteo forecast') + (w.as_of ? ', as of ' + whenText(ts(w.as_of)) : '') + '): ' + bits.join(', ') + '.',
        w.state === 'HAZARD' ? 'That is enough to matter: ' + sentenceList(w.hazards) + '. EdgeDesk’s projected margin does not move for weather.' : 'Nothing in it is extreme, and EdgeDesk’s projection does not adjust for weather either way.');
    }
    s.limits = limitsSection(o);
    s.conclusion = para(m.favorite ? 'The short version: EdgeDesk makes ' + m.favorite + ' the likelier winner, and ' + m.underdog + '’s ' + m.dog_win_pct + '% is ' + (m.dog_win_pct >= 25 ? 'a real chance, not a long shot.' : 'a long shot, but not nothing.') : 'The short version: EdgeDesk sees a coin flip.',
      'None of it is a pick: whether either side is worth backing depends on a price this article doesn’t assess.')
      + (p.link ? '\n\nFull research: [' + p.away + ' vs. ' + p.home + ' on EdgeDesk](' + p.link + ')' : '');
    return s;
  }

  /* ── CONFERENCE RACE: the games between the top three, and where the rest stand ── */
  function crSections(o) {
    var R = o.research, races = R.races || [], top = (R.conference_top || []).slice(0, 3), s = {};
    var ids = races.map(function (p) { return p.game_id; });
    var others = (R.games || []).filter(function (p) { return ids.indexOf(p.game_id) < 0; });
    var title = function (p) { return p.away + (p.neutral_site ? ' vs. ' : ' at ') + p.home; };
    s.intro = para('The ' + R.conference + ' championship race runs through ' + sentenceList(races.map(title)) + ' this week.',
      top.length >= 3 ? 'In EdgeDesk’s ratings, ' + sentenceList(top) + ' are the conference’s three highest-rated teams' + (races.length ? ', and ' + (races.length === 1 ? 'two of them meet' : 'they meet each other') + ' this weekend.' : '.') : null,
      'Here is what the projections say about the games that shape the title race, and where the other contenders stand.');
    s.why_it_matters = whyItMatters(o);
    s.how_to_read = howToRead(o);
    s.race_games = races.map(function (p, i) { return capsule(p, { idx: i, links: true, explained: [] }); }).join('\n\n');
    if (others.length) {
      s.contenders = 'The rest of the top three play this week too:\n\n' + others.map(function (p, i) {
        var team = top.filter(function (t) { return t === p.home || t === p.away; })[0] || p.home;
        return '- **' + team + '** (' + title(p) + (p.kickoff_text ? ', ' + p.kickoff_text : '') + '): ' + fanLine(p, i + 1);
      }).join('\n');
    }
    s.implications = races.map(function (p) {
      var m = p.model;
      return para('**' + title(p) + ':** whoever wins gets a result against another of the ' + R.conference + '’s three highest-rated teams in EdgeDesk’s ratings.',
        m.favorite && isNum(m.dog_win_pct) ? 'EdgeDesk gives ' + m.favorite + ' ' + m.fav_win_pct + '% and ' + m.underdog + ' ' + m.dog_win_pct + '%, which makes it ' + (m.dog_win_pct >= 40 ? 'close to a coin flip' : m.dog_win_pct >= 30 ? 'a competitive game' : 'a clear lean') + ' by EdgeDesk’s numbers.' : null);
    }).join('\n\n') + '\n\nEdgeDesk doesn’t carry a conference standings feed or the tiebreaker rules, so this reads the race through ratings and projections, not the standings table.';
    s.limits = limitsSection(o);
    s.conclusion = conclusionSection(o);
    return s;
  }

  /* ── MODEL VS. MARKET: every gap explained from EdgeDesk's inputs, or said to be unexplained ── */
  function mvmSections(o) {
    var R = o.research, gs = (R.games || []).filter(function (p) { return p.gap && p.market.status !== 'none'; }), s = {};
    if (!gs.length) return s;
    var L = o.league === 'cfb' ? 'college football' : 'NFL';
    var g0 = gs.slice().sort(function (a, b) { return b.gap.points - a.gap.points; })[0];
    s.intro = para('In ' + numWord(gs.length) + ' ' + L + ' games this week, EdgeDesk’s projection and the betting line (the spread) are two points or more apart: these are EdgeDesk’s spread predictions set against the market.',
      'The largest gap is ' + g0.away + ' at ' + g0.home + ': EdgeDesk has ' + g0.display.fair + ', and the line was ' + g0.display.market + '.',
      'A disagreement is not a bet. It is a question about what the model sees that the market doesn’t, or the other way around, and this report says how much of each gap EdgeDesk’s own inputs can explain.');
    s.how_to_read = howToRead(o);
    var explained = gs.filter(function (p) { return p.discrepancy; });
    var small = gs.filter(function (p) { return !p.discrepancy; });
    s.the_gaps = (explained.length ? discrepancySection(o, gs, 5) : '')
      + (small.length ? (explained.length ? '\n\n' : '') + 'Smaller gaps, under three points:\n\n' + small.slice(0, 5).map(function (p, i) {
        var fb = gapFootball(p, i + 1);
        return '- **' + p.away + ' at ' + p.home + ':** ' + ['EdgeDesk has ' + p.display.fair + '; the line was ' + p.display.market + '.', 'the line was ' + p.display.market + ', against EdgeDesk’s ' + p.display.fair + '.'][i % 2] + (fb ? ' ' + fb : '');
      }).join('\n') : '');
    var n = gs.length;
    var home = gs.filter(function (p) { return p.gap.toward === p.home; }).length;
    var dog = gs.filter(function (p) { var mf = favOf(p.home, p.away, p.market.home_line).favorite; return mf && p.gap.toward !== mf; }).length;
    var open = explained.filter(function (p) { return p.discrepancy.review !== 'NONE'; }).length;
    var stale = gs.filter(function (p) { return p.market.status === 'stale'; }).length, ref = gs.filter(function (p) { return p.market.status === 'reference'; }).length;
    s.pattern = para('EdgeDesk leans toward the home team in ' + numWord(home) + ' of these ' + numWord(n) + ' gaps, and toward the market’s underdog in ' + numWord(dog) + '.',
      explained.length ? open === 0 ? 'EdgeDesk’s inputs account for most of every large gap.' : cap(numWord(open)) + ' of the ' + numWord(explained.length) + ' gaps of three points or more ' + (open === 1 ? 'is' : 'are') + ' mostly unexplained by anything EdgeDesk measures, and those are the ones to treat as questions rather than findings.' : null,
      stale ? cap(numWord(stale)) + ' of the comparisons use historical lines' + (ref ? ' and ' + numWord(ref) + ' use reference lines' : '') + ', so some gaps may have closed since the line was captured.' : ref ? cap(numWord(ref)) + ' of the comparisons use reference lines with no sportsbook or capture time.' : null,
      'When most gaps lean the same way, the useful question is whether one shared input, such as home field, explains them; the breakdowns above say how much each input does.');
    s.limits = limitsSection(o);
    s.conclusion = para('The takeaway: ' + numWord(n) + ' gaps, ' + (open ? numWord(open) + ' of them mostly unexplained' : 'each with an explanation in EdgeDesk’s own inputs') + '.',
      'These are research questions to follow through the week, not bets. If the quarterback news or the lines change, the answers change with them.');
    return s;
  }

  function sectionsFor(o, format, ctx) {
    var s = {};
    if ((format === 'matchup_analysis' || format === 'edgedesk_analysis') && o.research.games && o.research.games.length === 1 && o.research.games[0].evidence) return analysisSections(o, format === 'edgedesk_analysis');
    if (format === 'postgame_review') return pgSections(o);
    if (format === 'matchup_deep_dive') return ddSections(o);
    if (format === 'conference_race') return crSections(o);
    if (format === 'model_vs_market') return mvmSections(o);
    if (format === 'market_discrepancy' && o.research.games && o.research.games.length === 1 && o.research.games[0].gap) return mdSections(o);
    if (format === 'trending_story') return storySections(o);
    var gs = o.research.games || [];
    var angle = ctx.angle || 'full_slate';
    var shown = gs;
    if (angle === 'upsets_first' && o.research.upsets && o.research.upsets.length) {
      var ids = o.research.upsets.map(function (p) { return p.game_id; });
      shown = o.research.upsets.concat(gs.filter(function (p) { return ids.indexOf(p.game_id) < 0; })).slice(0, gs.length);
    }
    var maxGames = ctx.maxGames || 6;
    shown = shown.slice(0, maxGames);
    s.intro = ctxIntro(o);
    s.why_it_matters = whyItMatters(o);
    s.how_to_read = howToRead(o);
    var maxDisc = ctx.maxDiscrepancies || 3;
    var explained = disagreementGames(o, shown, maxDisc).map(function (p) { return p.game_id; });
    var staleN = shown.filter(function (p) { return p.market.status === 'stale'; }).length;
    var gamesIntro = staleN ? 'The sportsbook lines quoted below are historical: each was captured more than three hours before this research was read, so they are context with a capture time, not current prices.' : null;
    s.games = (gamesIntro ? gamesIntro + '\n\n' : '') + shown.map(function (p, i) { return capsule(p, { links: ctx.links, idx: i, index: i, tight: ctx.tight, explained: explained, injurySection: o.league === 'nfl' }); }).join('\n\n');
    s.upsets = o.kind === 'upset_watch' ? null : upsetsSection(o, shown.map(function (p) { return p.game_id; }));
    s.conference = o.league === 'cfb' ? conferenceSection(o) : null;
    s.disagreements = explained.length ? discrepancySection(o, shown, maxDisc, { football: false }) : (o.league === 'nfl' || format === 'market_discrepancy' ? disagreementsSection(o) : null);
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
    if (!formatAllowed(o, format)) format = formatsFor(o)[0];
    var publisher = ctx.publisher || null;
    var ed = (publisher && publisher.editorial) || {};
    var links = ed.links_allowed !== false;
    var baseFormat = baseFormatOf(o, format);
    var maxGames = ed.max_games || (ed.length && ed.length.max && ed.length.max < 1200 ? 4 : 6);
    var maxDiscrepancies = ed.length && ed.length.max && ed.length.max <= 1500 ? 2 : 3;
    var raw = sectionsFor(o, baseFormat, { angle: ctx.angle, maxGames: maxGames, links: links, maxDiscrepancies: maxDiscrepancies, tight: !!(ed.length && ed.length.max && ed.length.max <= 1500) });
    var preview = /_weekly_preview$/.test(baseFormat);
    var order = format === 'publisher_custom' && preview ? sectionOrder(format, publisher) : sectionOrder(baseFormat, publisher);
    var sections = [];
    order.forEach(function (k) {
      var body = raw[k];
      if (!body) return;
      var FF = FORMATS[format] || FORMATS[baseFormat] || {};
      sections.push({ key: k, heading: (FF.headings && FF.headings[k]) || SECTION_HEADINGS[k] || null, body: body });
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
    if (o.kind === 'matchup_analysis') {
      var p0 = (o.research.games || [])[0], X1 = p0 && p0.evidence && p0.evidence.explanation || {};
      return p0 ? (X1.headline_question ? X1.headline_question.replace(/’/g, '’') + ' ' : '') + 'The football behind EdgeDesk’s ' + p0.away + '–' + p0.home + ' projection, the evidence against it, and what has to happen on the field.' : 'The football behind EdgeDesk’s projection.';
    }
    if (o.kind === 'postgame_review') return 'Every number EdgeDesk published before kickoff, graded on the final score and against the closing line. Nothing is re-scored after the fact.';
    if (o.kind === 'matchup_preview') { var g = (o.research.games || [])[0]; return 'Everything EdgeDesk’s model knows about ' + (g ? g.away + ' vs. ' + g.home : 'this game') + ': the projection, what builds it, and what it can’t see. Research, not picks.'; }
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
    text = String(text).replace(/(\d),(?=\d{3}\b)/g, '$1');   /* 1,222 is one number */
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
    /* an evidence packet's numbers are NOT a general pool: each is valid only in
       a sentence that cites its claim (validate step 3). Its names are. */
    research.games = (research.games || []).map(function (p) {
      var c = Object.assign({}, p);
      /* the explanation (gap, explained share, audit, script) is EdgeDesk's own
         deterministic reading of this game: its figures are research */
      var X = p.evidence && p.evidence.explanation;
      if (X) c.explanation_figures = [X.gap ? X.gap.points : null, X.mechanical ? X.mechanical.explained_points : null, X.mechanical ? X.mechanical.unexplained_points : null].filter(isNum);
      delete c.evidence;
      return c;
    });
    (o.research.games || []).forEach(function (p) {
      evClaims(p).forEach(function (c) { [c.text, c.short].forEach(function (t) { if (t && t.length < 600) (t.match(NAME_RE) || []).forEach(function (n) { names[n] = 1; }); }); });
    });
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
    [25, 30, 49, 50, 70, 100, 180, 2024, 2025, 2026, 2027].forEach(function (v) { addNum(nums, v); });
    (o.research.games || []).concat(o.research.upsets || [], o.research.races || []).forEach(function (p) {
      teams[p.home] = 1; teams[p.away] = 1;
      [p.home_conference, p.away_conference, p.venue, p.market && p.market.book, p.market && bookName(p.market.book)].forEach(function (x) { if (x) names[x] = 1; });
      ['home', 'away'].forEach(function (s) { var q = p.qb && p.qb[s]; if (q && q.player) names[q.player] = 1;
        var inj = p.injuries && p.injuries[s]; (inj && inj.qbs || []).forEach(function (x) { names[x.name] = 1; }); });
    });
    (o.research.results || []).forEach(function (x) { teams[x.home] = 1; teams[x.away] = 1; });
    ((o.research.context && o.research.context.top10) || []).forEach(function (t) { teams[t.team] = 1; });
    (o.research.conference_top || []).forEach(function (t) { teams[t] = 1; });
    (o.research.news || []).forEach(function (n) { (n.teams || []).forEach(function (t) { teams[t] = 1; }); numbersIn(n.title + ' ' + (n.summary || '')).forEach(function (x) { addNum(nums, x); }); });
    (o.sources || []).forEach(function (s) { srcs.push(s); });
    return { numbers: nums, teams: teams, names: names, sources: srcs };
  }

  /* the season's teams for the article's league; both leagues for an EdgeDesk weekend article */
  function knownTeams(o, lists) {
    lists = lists || {};
    if (o.league === 'multi') return (lists.cfb || []).concat(lists.nfl || []);
    return lists[o.league] && lists[o.league].length ? lists[o.league] : ((o.research.context && o.research.context.team_names) || []);
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

    /* 3 numbers: every figure must be in the research, or in a football claim
       that the same sentence cites */
    var FEm = fe(), packets = (o.research.games || []).map(function (p) { return p.evidence; }).filter(Boolean);
    var unsupported = [];
    sentencesOf(text).forEach(function (orig) {
      var miss = numbersIn(stripForNumbers(orig)).filter(function (n) { return !ev.numbers[String(+n.toFixed(2))]; });
      if (!miss.length) return;
      var claimNums = {};
      if (FEm) packets.forEach(function (pk) { FEm.citedClaims(pk, orig).forEach(function (c) { numbersIn(c.text + ' ' + (c.short || '')).forEach(function (m) { addNum(claimNums, m); }); }); });
      /* …or in EdgeDesk's own explanation of this game, when the sentence uses that explanation's words */
      var sh = shingles(orig);
      packets.forEach(function (pk) {
        explanationFragments(pk).forEach(function (fr) {
          var fs = shingles(fr), share = false;
          for (var k in fs) { if (sh[k]) { share = true; break; } }
          if (share) numbersIn(fr).forEach(function (m) { addNum(claimNums, m); });
        });
      });
      miss.forEach(function (n) { if (!claimNums[String(+n.toFixed(2))]) unsupported.push(n); });
    });
    unsupported = uniq(unsupported);
    add('numbers_in_evidence', unsupported.length ? 'fail' : 'pass', 'Every number comes from EdgeDesk research or a cited source',
      unsupported.length ? 'not in the evidence: ' + unsupported.slice(0, 10).join(', ') : null);

    /* 4 teams: no team the research does not cover */
    var lists = opts.teamLists || {};
    var known = knownTeams(o, lists);
    if (known.length) {
      /* a person's name is masked before teams are matched (Isaiah Marshall is
         not Marshall) — but never a name that is itself a team */
      var people = Object.keys(ev.names).filter(function (n) { return known.indexOf(n) < 0 && !known.some(function (t) { return n.indexOf(t) === 0 && n.length === t.length; }); });
      var evText = (o.research.games || []).map(function (p) { return evClaims(p).map(function (c) { return c.text; }).join(' '); }).join(' ');
      var extra = teamsMentioned(text, known, people).filter(function (t) { return !ev.teams[t] && evText.indexOf(t) < 0; });
      add('teams_in_evidence', extra.length ? 'fail' : 'pass', 'Every team named is in the research', extra.length ? 'not in this article’s research: ' + extra.join(', ') : null);
    }
    /* people: capitalised two-word names that are not teams or evidence */
    var people = [], pm, PRE = /\b([A-Z][a-z]+(?:[-'’][A-Z][a-z]+)? [A-Z][a-z]+(?:[-'’][A-Z][a-z]+)?)\b/g;
    var allowWords = /^(EdgeDesk|Research|The|Projected|Model|Full|Bottom|Week|What|Why|How|Upset|Injury|Matchup|Sportsbook|Search|Gamble|Nothing|College|National|Football|League|Pass|Run|Team|Home|Stylistic|Official|Not|Prices|Quarterbacks|Uncertainty|Injuries|For|From|Each|These|None|This|That|It|If|When|Here|Every|Most|Some|Sat|Sun|Mon|Tue|Wed|Thu|Fri|Oct|Sept|Nov|Dec|Jan|Aug|Whether|Who|Can|Against|Before|Since|Over|In|At|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Only|Nearly|Part|Treat|Until)\b/;
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

    /* 14 every displayed figure reconciles (scores ↔ margin ↔ total ↔ win chance) */
    var np = numberProblems(text, o);
    add('numbers_reconcile', np.length ? 'fail' : 'pass', 'Projected scores, margins, totals and win chances reconcile', np.length ? np.slice(0, 6).join(' · ') : null);
    /* 15 a data-quality score is never sold as confidence in an outcome */
    /* a sentence saying a model publishes NO confidence score is a fact, not a claim */
    var cm = CONFIDENCE_MISUSE.exec(String(text).replace(CONFIDENCE_DENIED, ''));
    add('no_confidence_misuse', cm ? 'fail' : 'pass', 'Data quality is not described as confidence in a result', cm ? '“' + cm[0] + '”' : null);
    /* 15b a postgame review's scores and pregame numbers are the record's */
    if ((o.research.results || []).length) {
      var rr = resultProblems(body, o);
      add('results_reconcile', rr.length ? 'fail' : 'pass', 'Final scores and pregame numbers match the graded record', rr.length ? rr.slice(0, 6).join(' · ') : null);
    }
    /* 16 quarterback doubt only where the starter data shows it */
    var qbBad = qbClaimProblems(body, o);
    add('qb_claims_supported', qbBad.length ? 'fail' : 'pass', 'Quarterback uncertainty only where the starter data supports it', qbBad.length ? qbBad.slice(0, 4).join(' · ') : null);
    /* 17 injury, availability and suspension claims are backed by data on file */
    var injBad = injuryClaimProblems(body, o, ev);
    add('injury_claims_supported', injBad.length ? 'fail' : 'pass', 'Injury and availability claims are backed by a report on file', injBad.length ? injBad.slice(0, 4).join(' · ') : null);
    /* 18 breaking news (postponements, venue or kickoff changes, benchings) only with a source */
    var newsBad = newsClaimProblems(body, o);
    add('news_claims_supported', newsBad.length ? 'fail' : 'pass', 'Breaking-news claims carry a cited source', newsBad.length ? newsBad.slice(0, 4).join(' · ') : null);

    /* 19 the football evidence gate (lib/football_evidence.js): fluent prose,
       SEO and a high quality score are not enough — every featured game needs
       measured football, the evidence against EdgeDesk, correct availability,
       no unsupported causal story and no edge language */
    var F = fe(), gate = null;
    if (!F) add('evidence_gate', 'fail', 'Football evidence gate available', 'lib/football_evidence.js is not loaded, so the article cannot be checked against football evidence');
    else {
      gate = F.gate(a, o.research, { publisher: !isFirstParty(format), sources: o.sources, single: SINGLE_GAME[base] === true || SINGLE_GAME[format] === true });
      gate.checks.forEach(function (c) { checks.push(c); });
      /* outside reporting an article cites names its outlet */
      var unattributed = [];
      (gate.evidence_record || []).forEach(function (r) {
        if ((r.verification === 'REPORTED' || r.verification === 'VERIFIED_REPORT') && r.source && r.source.publisher && body.indexOf(r.source.publisher) < 0) unattributed.push(r.source.publisher);
      });
      add('reported_attributed', unattributed.length ? 'fail' : 'pass', 'Outside reporting is attributed to its outlet', unattributed.length ? 'name ' + uniq(unattributed).join(', ') : null);
    }

    var fails = checks.filter(function (c) { return c.status === 'fail'; });
    var warns = checks.filter(function (c) { return c.status === 'warn'; });
    return {
      ok: fails.length === 0, checks: checks, failed: uniq(fails.map(function (c) { return c.id; })), warned: uniq(warns.map(function (c) { return c.id; })),
      /* READY only with nothing failed and nothing awaiting an editor's confirmation */
      readiness: fails.length ? 'BLOCKED' : (gate && gate.readiness === 'HOLD_FOR_REVIEW' ? 'HOLD_FOR_REVIEW' : 'READY'),
      holds: gate ? gate.holds : [], evidence_record: gate ? gate.evidence_record : [],
      checked_at: iso(now), version: VERSION
    };
  }

  function explanationFragments(pk) {
    var X = (pk && pk.explanation) || {};
    return [X.thesis, X.assessment, X.critical_matchup && X.critical_matchup.text].concat((X.input_flags || []).map(function (f) { return f.text; }),
      (X.game_script && X.game_script.model_case) || [], (X.game_script && X.game_script.market_case) || [], X.uncertainty || []).filter(Boolean);
  }
  /* ---------------------------------------------------- claim checks */
  var CONFIDENCE_MISUSE = /\b(?:model|edgedesk(?:’s|'s)?) confidence\b|\b(?:high|strong|low|medium|moderate) confidence\b|\bconfidence (?:rating|score|level|grade)\b|\bconfident (?:that|in)\b/i;
  var CONFIDENCE_DENIED = /\b(?:publishes|has|carries|gives|offers) no confidence (?:rating|score|level|grade)\b/gi;
  /* a standing statement of what a projection does not price, naming no team */
  var MODEL_SCOPE = /\b(?:does not|doesn[’']t|do not|cannot) (?:directly )?(?:price|include|account for|model)\b/i;
  var QB_WORD = /\b(?:quarterbacks?|QBs?|starting job|starter)\b/i;
  var QB_DOUBT = /\b(?:not (?:been |yet )?confirmed|hasn[’']t been confirmed|has not been confirmed|isn[’']t confirmed|unconfirmed|hasn’t been announced|has not been announced|hasn't been announced|no starter has been announced|uncertain|unsettled|unresolved|up in the air|questionable|doubtful|ruled out|won’t play|will not play|won't play|injur\w*|benched|battle|split)\b/i;
  var INJ_WORD = /\b(?:injur(?:y|ed|ies)|ruled out|out for the (?:game|season|week)|questionable|doubtful|sidelined|day-to-day|week-to-week|torn|sprain\w*|concussion|suspend(?:ed|sion)|inactive)\b/i;
  var NEWS_WORD = /\b(?:postponed|canceled|cancelled|relocated|weather delay|delayed by|kickoff (?:was |has been )?(?:moved|changed)|named the starter|will start|has been benched|was benched|fired|resigned)\b/i;
  function gamesOf(o) { return (o.research.games || []).concat(o.research.upsets || [], o.research.races || []); }
  function teamsIn(sentence, o) {
    var out = [];
    gamesOf(o).forEach(function (p) { [['home', p.home], ['away', p.away]].forEach(function (t) { if (t[1] && sentence.indexOf(t[1]) >= 0) out.push({ p: p, side: t[0], team: t[1] }); }); });
    return out;
  }
  /* a sentence that names a report on file, by publisher or URL, is attributed to it */
  function citesReport(s, o) {
    return (o.sources || []).some(function (x) { return x.kind === 'external_report' && ((x.publisher && s.indexOf(x.publisher) >= 0) || (x.url && s.indexOf(x.url) >= 0)); });
  }
  /* a sentence stating an availability claim from a game's football evidence
     packet (an official report, attributed outside reporting, or the model's
     own starter conflicting with the report) is backed by that report */
  var REPORT_BACKED = { OFFICIAL_REPORT: 1, REPORTED: 1, VERIFIED_REPORT: 1 };
  function evidenceBacked(s, o) {
    var F = fe();
    if (!F) return false;
    return gamesOf(o).some(function (p) {
      return p.evidence && F.citedClaims(p.evidence, s).some(function (c) { return REPORT_BACKED[c.verification] || (c.verification === 'CONFLICTING' && c.topic === 'input'); });
    });
  }
  function qbClaimProblems(body, o) {
    var out = [];
    sentencesOf(body).forEach(function (s) {
      if (!QB_WORD.test(s) || !QB_DOUBT.test(s)) return;
      if (evidenceBacked(s, o)) return;
      var t = teamsIn(s, o);
      if (!t.length && MODEL_SCOPE.test(s)) return;
      if (citesReport(s, o)) return;
      var ok = t.some(function (x) { var q = x.p.qb && x.p.qb[x.side]; var inj = x.p.injuries && x.p.injuries[x.side];
        return (q && (q.status === 'COMPETITION' || q.status === 'AVAILABILITY')) || (inj && (inj.qbs || []).some(function (z) { return z.starter && z.status && z.status !== 'Active'; })); });
      if (!ok) out.push('“' + s.slice(0, 120) + '” — the starter data shows no competition or availability report' + (t.length ? ' for ' + uniq(t.map(function (x) { return x.team; })).join(', ') : ''));
    });
    return out;
  }
  function resultProblems(text, o) {
    var out = [], paras = String(text).split(/\n{2,}/);
    (o.research.results || []).forEach(function (x) {
      paras.forEach(function (pa) {
        if (pa.indexOf(x.home) < 0 || pa.indexOf(x.away) < 0) return;
        var sm, re = /\b(\d{1,3})-(\d{1,3})\b/g;
        while ((sm = re.exec(pa))) {
          var hi = Math.max(+sm[1], +sm[2]), lo = Math.min(+sm[1], +sm[2]);
          if (hi + '-' + lo !== x.final.score) out.push(x.away + ' at ' + x.home + ': ' + sm[0] + ' is not the final (' + x.final.score + ')');
        }
        if (x.final.winner) { var wm = new RegExp(escRe(x.final.loser) + ' won\\b').exec(pa); if (wm) out.push(x.away + ' at ' + x.home + ': ' + x.final.loser + ' is said to have won'); }
        /* the result card's form: "Final: A 55, B 19" */
        var cm, cre = /Final: (.+?) (\d{1,3}), (.+?) (\d{1,3})\b/g;
        while ((cm = cre.exec(pa))) {
          var sc = {}; sc[cm[1].trim()] = +cm[2]; sc[cm[3].trim()] = +cm[4];
          if (sc[x.home] !== x.final.home || sc[x.away] !== x.final.away) out.push(x.away + ' at ' + x.home + ': “' + cm[0] + '” is not the final (' + x.away + ' ' + x.final.away + ', ' + x.home + ' ' + x.final.home + ')');
        }
        if (x.pre.favorite) {
          var fre = new RegExp('EdgeDesk (?:had|projected|before kickoff:) ' + escRe(x.pre.favorite) + ' by (\\d+(?:\\.\\d+)?)', 'g'), fm;
          while ((fm = fre.exec(pa))) if (Math.abs(+fm[1] - x.pre.margin) > 0.05) out.push(x.away + ' at ' + x.home + ': EdgeDesk’s pregame margin was ' + oneDp(x.pre.margin) + ', not ' + fm[1]);
        }
      });
    });
    return uniq(out);
  }
  function injuryClaimProblems(body, o, ev) {
    var out = [], PRE = /\b([A-Z][a-z]+(?:[-'’][A-Z][a-z]+)? [A-Z][a-z]+(?:[-'’][A-Z][a-z]+)?)\b/g;
    var teamNames = Object.keys(ev.teams);
    sentencesOf(body).forEach(function (s) {
      if (!INJ_WORD.test(s)) return;
      if (evidenceBacked(s, o)) return;
      /* our own standing explanations name no team and no person */
      var t = teamsIn(s, o), m, people = [];
      PRE.lastIndex = 0;
      while ((m = PRE.exec(s))) { var nm = m[1]; if (teamNames.some(function (x) { return x.indexOf(nm) >= 0 || nm.indexOf(x) >= 0; })) continue; if (/^(EdgeDesk|Injury Report|Official|The|This|That|Not|Each|Every)\b/.test(nm)) continue; people.push(nm); }
      var unknown = people.filter(function (n) { return !ev.names[n] && !Object.keys(ev.names).some(function (x) { return x.indexOf(n) >= 0; }); });
      if (unknown.length) { out.push('“' + s.slice(0, 120) + '” — ' + unknown.join(', ') + ' not in any report on file'); return; }
      if (!t.length) return;
      var backed = t.some(function (x) {
        var inj = x.p.injuries && x.p.injuries[x.side], q = x.p.qb && x.p.qb[x.side];
        return (inj && (inj.out_count || inj.doubtful_count || (inj.qbs || []).length)) || (q && q.status === 'AVAILABILITY')
          || (x.p.drivers || []).some(function (d) { return /availability/i.test(d.label); }) || (x.p.discrepancy && x.p.discrepancy.facts.some(function (f) { return f.key === 'availability'; }));
      });
      if (!backed) out.push('“' + s.slice(0, 120) + '” — no injury or availability report on file for ' + uniq(t.map(function (x) { return x.team; })).join(', '));
    });
    return out;
  }
  function newsClaimProblems(body, o) {
    var out = [], ext = (o.sources || []).filter(function (x) { return x.kind === 'external_report'; });
    sentencesOf(body).forEach(function (s) {
      if (!NEWS_WORD.test(s)) return;
      var cited = ext.some(function (x) { return s.indexOf(x.publisher) >= 0 || s.indexOf(x.url) >= 0; }) || /\bAccording to\b/.test(s) && ext.length;
      if (!cited) out.push('“' + s.slice(0, 120) + '” — no cited report says this');
    });
    return out;
  }
  /* the figures the copy prints for each game, against the model's (and each other) */
  function escRe(x) { return String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function numberProblems(text, o) {
    var out = [], paras = String(text).split(/\n{2,}/);
    (o.research.games || []).forEach(function (p) {
      if (!p.model || !p.model.available) return;
      if (p.model.numbers && !p.model.numbers.ok) out.push(p.away + ' at ' + p.home + ': EdgeDesk’s own figures disagree (' + p.model.numbers.problems.join('; ') + ')');
      var want = -p.model.home_line;
      paras.forEach(function (pa) {
        if (pa.indexOf(p.home) < 0 || pa.indexOf(p.away) < 0) return;
        var sm = new RegExp('(?:Projected score: |projected score is |works out to )(.+?) (\\d+(?:\\.\\d+)?), (.+?) (\\d+(?:\\.\\d+)?)(?: \\(a projected total of (\\d+(?:\\.\\d+)?) points\\)|, a total of (\\d+(?:\\.\\d+)?) points| \\((\\d+(?:\\.\\d+)?) total points\\))?').exec(pa);
        if (sm) {
          var hv = sm[1] === p.home ? +sm[2] : sm[3] === p.home ? +sm[4] : null, av = sm[1] === p.away ? +sm[2] : sm[3] === p.away ? +sm[4] : null;
          var tvs = sm[5] != null ? sm[5] : sm[6] != null ? sm[6] : sm[7];
          var tv = tvs != null ? +tvs : null;
          if (hv == null || av == null) out.push(p.away + ' at ' + p.home + ': the projected score does not name both teams');
          else {
            if (Math.abs((hv - av) - want) > 0.05) out.push(p.away + ' at ' + p.home + ': the projected scores differ by ' + r1(Math.abs(hv - av)) + ' but the projected margin is ' + oneDp(want));
            if (tv != null && Math.abs((hv + av) - tv) > 0.05) out.push(p.away + ' at ' + p.home + ': the projected scores add to ' + r1(hv + av) + ' but the stated total is ' + tv);
            if (p.model.projected && (Math.abs(hv - p.model.projected.home) > NUM_TOL || Math.abs(av - p.model.projected.away) > NUM_TOL)) out.push(p.away + ' at ' + p.home + ': the projected score is not EdgeDesk’s (' + p.display.score + ')');
            if (tv != null && isNum(p.model.fair_total) && Math.abs(tv - p.model.fair_total) > NUM_TOL) out.push(p.away + ' at ' + p.home + ': the stated total ' + tv + ' is not EdgeDesk’s ' + p.model.fair_total);
          }
        }
        if (p.model.favorite) {
          /* a margin, never the start of a percentage ("Ole Miss a 50% chance") */
          var fre = new RegExp(escRe(p.model.favorite) + ' (?:by |a |an |is EdgeDesk’s |is EdgeDesk\'s )(\\d+(?:\\.\\d+)?)(?![\\d.]*%)(?:-point favorite)?', 'g'), fm;
          while ((fm = fre.exec(pa))) { if (Math.abs(+fm[1] - p.model.margin) > 0.05) out.push(p.away + ' at ' + p.home + ': ' + p.model.favorite + ' is described as ' + fm[1] + ' but EdgeDesk has ' + oneDp(p.model.margin)); }
          var dog = p.model.underdog;
          [[p.model.favorite, p.model.fav_win_pct], [dog, p.model.dog_win_pct]].forEach(function (x) {
            if (!x[0] || !isNum(x[1])) return;
            /* within one line: a heading above a paragraph is not the same sentence */
            var pre = new RegExp(escRe(x[0]) + '[^.;:\\n]{0,60}?(?:a |\\()(\\d+)% (?:chance|to win)', 'g'), pm;
            while ((pm = pre.exec(pa))) { if (+pm[1] !== x[1]) out.push(p.away + ' at ' + p.home + ': ' + x[0] + ' is given ' + pm[1] + '% but EdgeDesk has ' + x[1] + '%'); }
          });
        }
      });
    });
    return uniq(out);
  }

  /* ======================================================================
     THE EDITORIAL GATE — fourteen checks an article must clear before it can
     be marked Ready to Send (the database refuses a BLOCKED verdict,
     supabase/content_engine.sql). Each finding says what is wrong, the
     evidence (or the missing evidence), the fix, and the sections to fix.
     `kind` keeps apart what is checked deterministically against EdgeDesk's
     data, what rests on a source (a report, a forecast, the current slate),
     and what needs the owner's judgment. A confidence score proves nothing
     here and is never used as proof.
     ====================================================================== */
  var GATE_CHECKS = [
    { key: 'schedule', label: 'Schedule and matchup validity', kind: 'source' },
    { key: 'teams', label: 'Team, conference and ranking accuracy', kind: 'deterministic' },
    { key: 'projections', label: 'Projection consistency', kind: 'deterministic' },
    { key: 'snapshot', label: 'Model snapshot consistency', kind: 'deterministic' },
    { key: 'market', label: 'Market freshness and attribution', kind: 'deterministic' },
    { key: 'availability', label: 'Injury and availability claims', kind: 'source' },
    { key: 'claims', label: 'Unsupported factual claims', kind: 'deterministic' },
    { key: 'repetition', label: 'Duplicate or repetitive writing', kind: 'deterministic' },
    { key: 'headline', label: 'Headline accuracy', kind: 'deterministic' },
    { key: 'seo', label: 'SEO metadata completeness', kind: 'deterministic' },
    { key: 'publisher', label: 'Publisher-specific formatting', kind: 'deterministic' },
    { key: 'referral', label: 'Referral link integrity', kind: 'deterministic' },
    { key: 'responsible', label: 'Responsible gambling disclosures', kind: 'deterministic' },
    { key: 'reliability', label: 'Overall factual reliability', kind: 'judgment' }
  ];
  var GATE_RANK = { PASS: 0, WARNING: 1, BLOCKED: 2 };
  var SCHEDULE_MOVE_MIN = 15;     /* a kickoff that moved this many minutes is a different kickoff */
  var SNAPSHOT_BLOCK_PTS = 1.0;   /* the model moved this far since the draft: the copy is out of date */
  var SNAPSHOT_WARN_PTS = 0.3;

  /* which section of the article carries this text */
  function sectionWith(a, needle) {
    var hit = (a.sections || []).filter(function (x) { return needle && String(x.body).indexOf(needle) >= 0; })[0];
    return hit ? hit.key : null;
  }
  function featuredGames(a, o) {
    var t = textOf(a);
    return (o.research.games || []).filter(function (p) { return p.home && p.away && t.indexOf(p.home) >= 0 && t.indexOf(p.away) >= 0; });
  }

  /* a: the article; o: its opportunity (the research frozen when it was drafted)
     ctx: { now, publisher, campaign, landing, current: { game_id: packet } (the
     research re-read NOW), acks: { key: {note, at} }, news: [matched items],
     teamLists, siblings } */
  function gate(a, o, ctx) {
    ctx = ctx || {};
    var now = isNum(ctx.now) ? ctx.now : Date.now();
    var acks = ctx.acks || {};
    var items = {};
    GATE_CHECKS.forEach(function (c) { items[c.key] = { key: c.key, label: c.label, kind: c.kind, status: 'PASS', findings: [] }; });
    function find(key, status, reason, evidence, fix, sections, ackKey) {
      var f = { status: status, reason: reason, evidence: (evidence || []).filter(Boolean), fix: fix || null, sections: uniq((sections || []).filter(Boolean)) };
      if (ackKey) {
        f.ack_key = ackKey;
        var ak = acks[ackKey];
        if (ak && status === 'BLOCKED') { f.status = 'WARNING'; f.acknowledged = { note: ak.note || null, at: ak.at || null }; f.reason = 'Reviewed by the owner: ' + reason; }
      }
      items[key].findings.push(f);
      if (GATE_RANK[f.status] > GATE_RANK[items[key].status]) items[key].status = f.status;
    }
    var v = validate(a, o, { now: now, publisher: ctx.publisher, siblings: ctx.siblings, teamLists: ctx.teamLists });
    var vc = {}; v.checks.forEach(function (c) { vc[c.id] = c; });
    function failed(id) { return vc[id] && vc[id].status === 'fail'; }
    function warned(id) { return vc[id] && vc[id].status === 'warn'; }
    var text = textOf(a), body = (a.sections || []).map(function (x) { return x.body; }).join('\n\n');
    var feat = featuredGames(a, o);
    var cur = ctx.current || null;
    var ed = (ctx.publisher && ctx.publisher.editorial) || {};

    /* 1 schedule */
    feat.forEach(function (p) {
      var g = p.away + ' at ' + p.home;
      var k = ts(p.kickoff);
      if (k != null && k <= now) find('schedule', 'BLOCKED', g + ' has already kicked off.', ['kickoff ' + (p.kickoff_text || p.kickoff)], 'Remove the game or regenerate the games section from this week’s slate.', ['games', 'intro', 'conclusion']);
      if (!cur) return;
      var c = cur[p.game_id];
      if (!c) { find('schedule', 'BLOCKED', g + ' is no longer on the current slate: it may have been rescheduled, postponed or canceled.', ['game ' + p.game_id + ' missing from the research read ' + whenText(now)], 'Confirm the game’s status, then remove it or regenerate the games section.', ['games', 'intro', 'conclusion']); return; }
      var ck = ts(c.kickoff);
      if (k != null && ck != null && Math.abs(ck - k) >= SCHEDULE_MOVE_MIN * 60000) find('schedule', 'BLOCKED', g + ': the kickoff moved from ' + p.kickoff_text + ' to ' + c.kickoff_text + '.', ['research now says ' + c.kickoff], 'Regenerate the games section so the time is right.', ['games', 'intro']);
      if (c.home !== p.home || c.away !== p.away) find('schedule', 'BLOCKED', g + ': home and away no longer match the current slate (' + c.away + ' at ' + c.home + ').', [], 'Regenerate the article from the current slate.', ['games', 'intro']);
      if ((c.venue || null) !== (p.venue || null) || !!c.neutral_site !== !!p.neutral_site) find('schedule', 'BLOCKED', g + ': the venue changed (' + (p.venue || 'unknown') + ' → ' + (c.venue || 'unknown') + (c.neutral_site !== p.neutral_site ? ', neutral site ' + (c.neutral_site ? 'yes' : 'no') : '') + ').', [], 'Confirm the venue, then regenerate the games section.', ['games']);
    });
    if (!cur && feat.length) find('schedule', 'WARNING', 'The schedule was not re-checked against the current research.', [], 'Re-run the check with the current research loaded.', []);
    /* a two-league article has a week per league */
    var weekFor = function (p) { return o.research.weeks && o.research.weeks[p.league] != null ? o.research.weeks[p.league] : o.week; };
    if (feat.some(function (p) { return p.week !== weekFor(p); })) find('schedule', 'BLOCKED', 'A featured game is from a different week than the article.', feat.filter(function (p) { return p.week !== weekFor(p); }).map(function (p) { return p.away + ' at ' + p.home + ' (week ' + p.week + ')'; }), 'Remove it.', ['games']);

    /* 2 teams, conferences, rankings */
    if (failed('teams_in_evidence')) find('teams', 'BLOCKED', 'A team is named that this article’s research does not cover.', [vc.teams_in_evidence.detail], 'Remove the team or regenerate the section.', [sectionWith(a, (vc.teams_in_evidence.detail || '').replace(/^.*: /, '').split(',')[0])]);
    var cre = /\*\*([^*]+?):\*\* (.+?) and (.+?) are both among the conference/g, cm;
    while ((cm = cre.exec(body))) {
      var conf = cm[1], t1 = cm[2], t2 = cm[3];
      var pk = gamesOf(o).filter(function (p) { return (p.home === t1 || p.away === t1) && (p.home === t2 || p.away === t2); })[0];
      if (!pk) { find('teams', 'BLOCKED', 'The conference section pairs ' + t1 + ' and ' + t2 + ', which are not a game in the research.', [], 'Regenerate the conference section.', ['conference']); continue; }
      var cs = [pk.home_conference, pk.away_conference];
      if (cs.some(function (x) { return x !== conf; })) find('teams', 'BLOCKED', t1 + ' and ' + t2 + ' are described as ' + conf + ' but the research lists ' + uniq(cs).join(' / ') + '.', [], 'Regenerate the conference section.', ['conference']);
    }
    var rre = /No\. (\d+) ([A-Z][A-Za-z.&'’ ]+?)(?= at | vs\.| over |\)|,| —|:)/g, rm2;
    while ((rm2 = rre.exec(body))) {
      var rk = +rm2[1], tn = rm2[2].trim();
      var hit = gamesOf(o).filter(function (p) { return p.home === tn || p.away === tn; })[0];
      if (!hit) continue;
      var have = hit.home === tn ? hit.home_rank : hit.away_rank;
      if (have !== rk) find('teams', 'BLOCKED', tn + ' is ranked No. ' + rk + ' in the copy but No. ' + (have == null ? 'unranked' : have) + ' in EdgeDesk’s ratings.', [], 'Regenerate the games section.', [sectionWith(a, 'No. ' + rk + ' ' + tn)]);
    }
    if (/\bNo\. \d+ /.test(body) && o.league === 'cfb' && !/EdgeDesk’s own power ratings|EdgeDesk's own power ratings/.test(body)) find('teams', 'WARNING', 'Rankings are shown without saying they are EdgeDesk’s own ratings, not the AP poll.', [], 'Keep the ranking note in “How to read these numbers”.', ['how_to_read']);

    /* 3 projections */
    var dataConflicts = feat.filter(function (p) { return p.model && p.model.numbers && !p.model.numbers.ok; });
    dataConflicts.forEach(function (p) { find('projections', 'BLOCKED', p.away + ' at ' + p.home + ': EdgeDesk’s own figures disagree, so no consistent number can be printed.', p.model.numbers.problems, 'Leave the game out until the research is rebuilt; never type a replacement number.', []); });
    (a.sections || []).forEach(function (x) {
      var probs = numberProblems(x.body, { research: { games: (o.research.games || []).filter(function (p) { return dataConflicts.indexOf(p) < 0; }) } });
      if (probs.length) find('projections', 'BLOCKED', 'Displayed figures do not reconcile in “' + (x.heading || x.key) + '”.', probs, 'Regenerate the section with the reconciled figures; never type a replacement number by hand.', [x.key]);
    });

    /* 4 snapshot */
    /* one model version per league (the college and NFL models are different models) */
    ['cfb', 'nfl'].forEach(function (lg) {
      var snaps = uniq(feat.filter(function (p) { return (p.league || o.league) === lg; }).map(function (p) { return p.model && p.model.version; }).filter(Boolean));
      if (snaps.length > 1) find('snapshot', 'BLOCKED', 'The featured games come from different model versions.', snaps, 'Regenerate the article from one research read.', ['games']);
    });
    if (cur) feat.forEach(function (p) {
      var c = cur[p.game_id];
      if (!c || !c.model || !c.model.available || !p.model.available) return;
      var g = p.away + ' at ' + p.home;
      if (c.model.version && p.model.version && c.model.version !== p.model.version) { find('snapshot', 'BLOCKED', g + ': the model version changed (' + p.model.version + ' → ' + c.model.version + ').', [], 'Regenerate the games section.', ['games', 'disagreements', 'conclusion']); return; }
      var moved = Math.abs((c.model.home_line || 0) - (p.model.home_line || 0));
      var flip = (c.model.favorite || null) !== (p.model.favorite || null);
      if (flip || moved >= SNAPSHOT_BLOCK_PTS) find('snapshot', 'BLOCKED', g + ': EdgeDesk’s number moved since the draft (' + p.display.fair + ' → ' + c.display.fair + ').', ['research as of ' + (c.model.as_of || '?')], 'Regenerate the sections that quote this game.', ['games', 'disagreements', 'upsets', 'conclusion', 'intro']);
      else if (moved >= SNAPSHOT_WARN_PTS || Math.abs((c.model.fav_win_pct || 0) - (p.model.fav_win_pct || 0)) >= 3) find('snapshot', 'WARNING', g + ': EdgeDesk’s number moved a little since the draft (' + p.display.fair + ' → ' + c.display.fair + ').', [], 'Regenerate the games section if you want the latest figures.', ['games']);
    });
    if (warned('research_fresh')) find('snapshot', 'WARNING', 'The research behind this draft is old.', [vc.research_fresh.detail], 'Refresh the opportunity and regenerate.', []);

    /* 5 market */
    if (failed('stale_prices_labelled')) find('market', 'BLOCKED', 'A historical or reference line is presented without its age.', [vc.stale_prices_labelled.detail], 'Label it historical with its capture time.', ['games', 'disagreements']);
    feat.forEach(function (p) {
      if (!p.market || p.market.status === 'none') return;
      var g = p.away + ' at ' + p.home;
      if (p.display.market && text.indexOf(p.display.market) < 0 && text.indexOf(String(p.display.market).split(' (')[0]) >= 0) find('market', 'WARNING', g + ': the line is quoted without its source and capture time.', [p.display.market], 'Quote the line with its source and capture time.', ['games']);
      var c = cur && cur[p.game_id];
      if (c && c.market && c.market.status === 'current' && p.market.status !== 'current') find('market', 'WARNING', g + ': a current line is now available (' + c.display.market + '); the copy quotes a historical one.', [], 'Regenerate the games section to use the current line.', ['games', 'disagreements']);
    });

    /* 6 availability */
    if (failed('qb_claims_supported')) find('availability', 'BLOCKED', 'Quarterback uncertainty is claimed without support in the starter data.', String(vc.qb_claims_supported.detail || '').split(' · '), 'Remove the claim: a starter without an announcement is not news.', ['games', 'limits'].filter(function (k) { var sec = (a.sections || []).filter(function (x) { return x.key === k; })[0]; return sec && QB_DOUBT.test(sec.body) && QB_WORD.test(sec.body); }));
    if (failed('injury_claims_supported')) find('availability', 'BLOCKED', 'An injury or availability claim has no report on file.', String(vc.injury_claims_supported.detail || '').split(' · '), 'Remove the claim or cite the report it comes from.', ['games', 'limits']);
    feat.forEach(function (p) {
      ['home', 'away'].forEach(function (sd) {
        var q = p.qb && p.qb[sd];
        if (q && q.status === 'AVAILABILITY' && body.indexOf(q.player) < 0) find('availability', 'WARNING', (sd === 'home' ? p.home : p.away) + ': a quarterback availability report is not mentioned.', [q.availability, q.availability_source], 'Mention it in the game’s paragraph (regenerate the games section).', ['games']);
      });
    });
    var injAsOf = o.league === 'nfl' && o.research.context && ts(o.research.context.injuries_as_of);
    if (injAsOf && (now - injAsOf) > 24 * 3600000) find('availability', 'WARNING', 'The NFL injury report on file is more than a day old.', ['read ' + whenText(injAsOf)], 'Re-read the injury report before sending.', []);

    /* 7 claims */
    [['numbers_in_evidence', 'A number is not in EdgeDesk’s research or a cited source.'], ['no_recommendation', 'Pick, guarantee or staking language.'],
     ['reporting_attributed', 'External reporting is not attributed and linked.'], ['unsourced_reporting', 'Reporting is cited with no source on file.'],
     ['no_stringified_nothing', '“null”, “undefined” or “NaN” in the copy.'], ['projection_not_value', 'The article never says a projection is not a bet.'],
     ['news_claims_supported', 'A breaking-news claim has no cited source.'], ['no_confidence_misuse', 'A data-quality score is described as confidence in a result.'],
     ['structure', 'A required section is missing.'], ['empty_sections', 'A section is empty.'], ['headline', 'The headline is missing or too short.'],
     ['results_reconcile', 'A final score or pregame number does not match the graded record.']
    ].forEach(function (x) { if (failed(x[0])) find('claims', 'BLOCKED', x[1], [vc[x[0]].detail], 'Fix the copy, or regenerate the section.', [sectionWith(a, String(vc[x[0]].detail || '').replace(/^not in the evidence: |^“|”.*$/g, '').split(',')[0].trim())]); });
    if (warned('names_in_evidence')) find('claims', 'WARNING', 'A person is named who is not in the research.', [vc.names_in_evidence.detail], 'Check the name against a source, or remove it.', []);
    if (warned('no_filler')) find('claims', 'WARNING', 'Generic filler phrasing.', [vc.no_filler.detail], 'Rewrite the phrase.', []);

    /* 8 repetition */
    var seen = {}, tmpl = {};
    var gameTeams = uniq([].concat.apply([], (o.research.games || []).map(function (p) { return [p.home, p.away]; }))).sort(function (x, y) { return y.length - x.length; });
    sentencesOf(body).forEach(function (sx) {
      var k = sx.trim(); if (wordCount(k) < 6) return;
      seen[k] = (seen[k] || 0) + 1;
      var t = k; gameTeams.forEach(function (n) { t = t.split(n).join('T'); });
      t = t.replace(/\d+(?:\.\d+)?/g, '#').replace(/\([^)]*\)/g, '()');
      tmpl[t] = (tmpl[t] || 0) + 1;
    });
    Object.keys(seen).forEach(function (k) { if (seen[k] >= 2) find('repetition', seen[k] >= 3 ? 'BLOCKED' : 'WARNING', 'The same sentence appears ' + seen[k] + ' times.', ['“' + k.slice(0, 140) + '”'], 'Say it once, or regenerate the section.', [sectionWith(a, k)]); });
    Object.keys(tmpl).forEach(function (k) { if (tmpl[k] >= 5) find('repetition', 'WARNING', 'The same sentence pattern repeats ' + tmpl[k] + ' times.', ['“' + k.slice(0, 140) + '”'], 'Vary or cut the repeated pattern.', []); });
    if (failed('not_duplicate')) find('repetition', 'BLOCKED', 'Too close to another article from the same research.', [vc.not_duplicate.detail], 'Choose another angle or archive one of them.', []);
    else if (warned('not_duplicate')) find('repetition', 'WARNING', 'Overlaps another article from the same research.', [vc.not_duplicate.detail], 'Make the angles more distinct.', []);

    /* 9 headline */
    var title = String(a.title || '');
    var wk = /\bWeek (\d+)\b/i.exec(title);
    if (wk && +wk[1] !== o.week) find('headline', 'BLOCKED', 'The headline says Week ' + wk[1] + ' but the research is Week ' + o.week + '.', [title], 'Fix the week in the headline.', []);
    if (o.league === 'cfb' && /\bNFL\b/.test(title) || o.league === 'nfl' && /college football|\bCFB\b/i.test(title)) find('headline', 'BLOCKED', 'The headline names the wrong league.', [title], 'Fix the headline.', []);
    var lists = ctx.teamLists || {};
    var known = knownTeams(o, lists);
    var tTeams = teamsMentioned(title, known, []).filter(function (t) { return !feat.some(function (p) { return p.home === t || p.away === t; }) && !(o.teams || []).some(function (x) { return x === t; }); });
    if (tTeams.length) find('headline', 'BLOCKED', 'The headline names a team the article doesn’t cover: ' + tTeams.join(', ') + '.', [title], 'Fix the headline.', []);
    var ev = evidenceOf(o);
    var tNums = numbersIn(stripForNumbers(title)).filter(function (n) { return !ev.numbers[String(+n.toFixed(2))]; });
    if (tNums.length) find('headline', 'BLOCKED', 'The headline carries a number that is not in the research: ' + tNums.join(', ') + '.', [title], 'Fix the headline.', []);
    if (title.length > 75) find('headline', 'WARNING', 'The headline is ' + title.length + ' characters; search results cut off near 60–70.', [title], 'Shorten it.', []);

    /* 10 SEO */
    if (warned('seo_meta')) find('seo', 'WARNING', 'The meta description is outside 90–160 characters.', [vc.seo_meta.detail], 'Rewrite the meta description.', []);
    if (warned('seo_slug')) find('seo', 'WARNING', 'The URL slug is not clean.', [vc.seo_slug.detail], 'Use lowercase words and hyphens.', []);
    if (warned('seo_keyword')) find('seo', 'WARNING', 'The primary keyword is missing from the headline or the opening.', [vc.seo_keyword.detail], 'Work the keyword into the headline and first paragraph.', ['intro']);
    if (!a.primary_keyword) find('seo', 'WARNING', 'No primary keyword.', [], 'Set one in the SEO brief.', []);
    if (!(a.secondary_keywords || []).length) find('seo', 'WARNING', 'No secondary keywords.', [], 'Add two or three from the SEO brief.', []);

    /* 11 publisher */
    if (warned('length')) find('publisher', 'WARNING', 'Length is outside the publisher’s range.', [vc.length.detail], 'Trim or extend the article.', []);
    if (ctx.publisher && (ctx.publisher.status === 'paused' || ctx.publisher.status === 'ended')) find('publisher', 'WARNING', 'This publisher is ' + ctx.publisher.status + '.', [], 'Reactivate the publisher or choose another.', []);
    if (ed.max_games && feat.length > ed.max_games) find('publisher', 'WARNING', 'The article features ' + feat.length + ' games; the publisher asks for at most ' + ed.max_games + '.', [], 'Trim the games section.', ['games']);

    /* 12 referral link, 13 responsible gambling — on the EXPORT, as the publisher receives it */
    var expCtx = { publisher: ctx.publisher, campaign: ctx.campaign, opportunity: o, landing: ctx.landing };
    var exp = toMarkdown(a, expCtx);
    var edLinks = (exp.match(/\]\((https?:\/\/(?:www\.)?edgedesksports\.com[^)\s]*)\)/g) || []).map(function (x) { return x.slice(2, -1); });
    var pubUtm = utmFor(ctx.publisher, a, ctx.campaign);
    /* EdgeDesk's own page: its links are internal, and an internal link must
       carry NO utm tags (they would overwrite the reader's real source) */
    var firstParty = !!(FORMATS[a.base_format || ''] || {}).first_party;
    if (firstParty) {
      edLinks = ((a.sections || []).map(function (x) { return x.body; }).join('\n').match(/\]\((https?:\/\/(?:www\.)?edgedesksports\.com[^)\s]*)\)/g) || []).map(function (x) { return x.slice(2, -1); });
      edLinks.filter(function (u) { return /[?&]utm_/.test(u); }).forEach(function (u) { find('referral', 'BLOCKED', 'An internal EdgeDesk link carries campaign tags.', [u], 'Remove the utm_ parameters from internal links.', [sectionWith(a, u.split('?')[0])]); });
      edLinks.filter(function (u) { return !/^https:/.test(u); }).forEach(function (u) { find('referral', 'BLOCKED', 'An EdgeDesk link is not https.', [u], 'Use the https link.', []); });
    } else if (ed.links_allowed !== false) {
      if (!edLinks.length) find('referral', 'BLOCKED', 'The export carries no EdgeDesk link, so referrals cannot be measured.', [], 'Restore the attribution line.', []);
      if (!ctx.campaign) find('referral', 'BLOCKED', 'The article has no campaign code.', [], 'The campaign code is assigned when the article is created; recreate it.', []);
    }
    if (!firstParty) edLinks.forEach(function (u) {
      var q; try { q = new URL(u).searchParams; } catch (e) { q = null; }
      if (!q || q.get('utm_campaign') !== String(ctx.campaign || '').toLowerCase() || q.get('utm_medium') !== 'publisher' || q.get('utm_source') !== pubUtm.source.toLowerCase().replace(/[^a-z0-9_.-]/g, ''))
        find('referral', 'BLOCKED', 'An EdgeDesk link is not tagged for this article and publisher.', [u], 'Regenerate the export (links are tagged automatically).', [sectionWith(a, u.split('?')[0])]);
      if (!/^https:/.test(u)) find('referral', 'BLOCKED', 'An EdgeDesk link is not https.', [u], 'Use the https link.', []);
    });
    if (ed.links_allowed === false && edLinks.length) find('referral', 'BLOCKED', 'The publisher allows no link back, but the export carries one.', edLinks.slice(0, 2), 'Remove the link from the body.', []);
    if (exp.indexOf(DISCLAIMER) < 0) find('responsible', 'BLOCKED', 'The responsible-gambling disclaimer is missing from the export.', [], 'Restore the disclaimer.', []);
    if (!/21\+/.test(exp) || !/1-800-GAMBLER/.test(exp)) find('responsible', 'BLOCKED', 'The 21+ notice or the 1-800-GAMBLER helpline is missing.', [], 'Restore the disclaimer.', []);
    if (failed('no_recommendation')) find('responsible', 'BLOCKED', 'Pick, lock or staking language.', [vc.no_recommendation.detail], 'Remove it.', []);

    /* 14 overall reliability: the owner's judgment, with the evidence */
    feat.forEach(function (p) {
      var g = p.away + ' at ' + p.home;
      var d = p.discrepancy;
      if (d && d.review !== 'NONE') {
        var evd = ['gap ' + oneDp(d.points) + ' pts toward ' + d.toward, d.unexplained_pct != null ? d.unexplained_pct + '% unexplained by EdgeDesk’s inputs' : 'no breakdown on file']
          .concat(d.facts.map(function (f) { return f.text; }), d.evidence, d.verification ? ['verification: ' + d.verification] : [], d.investigation ? ['terminal status: ' + d.investigation] : []);
        find('reliability', d.review === 'BLOCK' ? 'BLOCKED' : 'WARNING', g + ': ' + aOrAn(oneDp(d.points)) + ' ' + oneDp(d.points) + '-point gap with the market that EdgeDesk’s inputs mostly can’t explain.', evd,
          'Check the game for unreported injuries, quarterback news or data problems; then acknowledge the review (with a note) or remove the game.', [], 'discrepancy:' + p.game_id);
      }
      if (p.verification === 'FAILED') find('reliability', 'BLOCKED', g + ': EdgeDesk’s own verification of this gap failed.', [], 'Remove the game or wait for the research to be verified.', ['games', 'disagreements']);
      if (p.model.data_quality && p.model.data_quality.band === 'low') find('reliability', 'WARNING', g + ': low data quality (' + p.model.data_quality.score + '/100).', [p.model.data_quality.measures], 'Say so in the copy, or feature another game.', ['games']);
      var w = (cur && cur[p.game_id] && cur[p.game_id].weather) || p.weather;
      if (w && w.state === 'HAZARD') find('reliability', 'WARNING', g + ': the kickoff forecast shows ' + sentenceList(w.hazards) + '.', [(w.source || 'forecast') + (w.as_of ? ', as of ' + whenText(ts(w.as_of)) : '')], 'Check the latest forecast and any delay announcements before sending.', ['limits'], 'weather:' + p.game_id);
      else if (w && (w.state === 'NOT_CHECKED' || w.state === 'STALE')) find('reliability', 'WARNING', g + ': the weather could not be verified (' + (w.state === 'STALE' ? 'forecast older than ' + WEATHER.stale_hours + ' hours' : w.reason || 'no forecast on file') + ').', [], 'Check the forecast yourself before sending.', []);
    });
    var teams = uniq([].concat.apply([], feat.map(function (p) { return [p.home, p.away]; })));
    (ctx.news || []).forEach(function (n) {
      var t = ts(n.published_at);
      if (t != null && now - t > 72 * 3600000) return;
      if (!/injury|qb_change|suspension/.test(n.kind || '')) return;
      if (!(n.teams || []).some(function (x) { return teams.indexOf(x) >= 0; })) return;
      if ((o.sources || []).some(function (x) { return x.url === n.url; })) return;
      find('reliability', 'WARNING', 'Unverified report about ' + (n.teams || []).filter(function (x) { return teams.indexOf(x) >= 0; }).join(', ') + ': “' + String(n.title).slice(0, 120) + '”.', [(n.publisher || 'feed') + ' — ' + n.url], 'Read the report and confirm it doesn’t change the article before sending.', ['games'], 'news:' + hash(n.url));
    });

    /* the football evidence gate (lib/football_evidence.js), run inside
       validate(): a failed evidence check blocks; a hold (unconfirmed outside
       reporting, suspect inputs) is a warning the owner clears in review */
    var gameSection = function (id) {
      var p = (o.research.games || []).filter(function (g) { return String(g.game_id) === String(id); })[0];
      return p ? sectionWith(a, p.away) : null;
    };
    v.checks.filter(function (c) { return c.status === 'fail' && (c.gate === 'evidence' || c.id === 'reported_attributed' || c.id === 'evidence_gate'); }).forEach(function (c) {
      find('claims', 'BLOCKED', c.label + '.', [c.detail], 'Regenerate the section from the game’s football evidence packet, or remove the unsupported sentence.', c.game ? [gameSection(c.game)] : []);
    });
    (v.holds || []).forEach(function (h) {
      find('reliability', 'WARNING', 'Held for review: ' + h + '.', [], 'Confirm it against the primary source (node tools/content/add_fact.js --verify) or check EdgeDesk’s inputs before sending.', []);
    });

    var list = GATE_CHECKS.map(function (c) { return items[c.key]; });
    var verdict = list.reduce(function (m, it) { return GATE_RANK[it.status] > GATE_RANK[m] ? it.status : m; }, 'PASS');
    var counts = { PASS: 0, WARNING: 0, BLOCKED: 0 };
    list.forEach(function (it) { counts[it.status]++; });
    return {
      schema: 'edgedesk_editorial_gate_v1', version: VERSION, verdict: verdict, counts: counts, items: list,
      checked_at: iso(now), research_as_of: o.research && o.research.as_of || null, rechecked_current: !!cur,
      acks_applied: Object.keys(acks).length, validation: { ok: v.ok, failed: v.failed, warned: v.warned }
    };
  }
  /* the section keys the gate wants regenerated (BLOCKED first, then WARNING) */
  function sectionsToFix(report, includeWarnings) {
    var keys = {};
    (report.items || []).forEach(function (it) { it.findings.forEach(function (f) {
      if (f.acknowledged) return;
      if (f.status === 'BLOCKED' || (includeWarnings && f.status === 'WARNING')) (f.sections || []).forEach(function (k) { if (k) keys[k] = 1; });
    }); });
    return Object.keys(keys);
  }
  /* Regenerate ONLY the sections the gate flags, deterministically, from the
     opportunity rebuilt on the CURRENT research (`fresh`); every other section
     is kept byte for byte. A regenerated games section brings its "How to
     read" explanation with it. No AI, no cost. */
  function repair(a, fresh, ctx) {
    ctx = ctx || {};
    var want = {};
    (ctx.sections || []).forEach(function (k) { want[k] = 1; });
    if (want.games) want.how_to_read = 1;
    var d = draft(fresh, { publisher: ctx.publisher, format: a.format, angle: a.angle, title: a.title, now: ctx.now });
    var byKey = {}; d.sections.forEach(function (x) { byKey[x.key] = x; });
    var changed = [], removed = [];
    var out = [];
    (a.sections || []).forEach(function (x) {
      if (!want[x.key]) { out.push(x); return; }
      if (byKey[x.key]) { out.push(byKey[x.key]); if (byKey[x.key].body !== x.body) changed.push(x.key); }
      else { removed.push(x.key); }
    });
    /* sections the fresh draft needs that the old one lacked, in the format's order */
    var order = d.sections.map(function (x) { return x.key; });
    d.sections.forEach(function (x) {
      if (!want[x.key] && x.key !== 'disagreements') return;
      if (out.some(function (y) { return y.key === x.key; })) return;
      var at = out.length;
      for (var i = order.indexOf(x.key) + 1; i < order.length; i++) { var j = out.map(function (y) { return y.key; }).indexOf(order[i]); if (j >= 0) { at = j; break; } }
      out.splice(at, 0, x); changed.push(x.key);
    });
    var b = Object.assign({}, a, { sections: out, research_as_of: fresh.research && fresh.research.as_of || a.research_as_of, research_hash: researchHash(fresh),
      generator: String(a.generator || 'template').replace(/\+repair$/, '') + '+repair' });
    b.word_count = wordCount(b.standfirst + ' ' + out.map(function (x) { return x.body; }).join(' '));
    return { article: b, changed: uniq(changed), removed: removed };
  }

  /* ======================================================================
     FIRST-PARTY PUBLISHING — EdgeDesk's own articles on edgedesksports.com.

     At most three a week, in Central Time: Monday the Weekend Model Review
     (the weekend's results against the pregame numbers), Wednesday the
     upcoming weekend's biggest storylines, Friday the weekend in five
     numbers. Each builder returns { ok:false, reason } rather than a thin
     article when the research does not support one: fewer articles, never a
     filler one.

     Twelve gates decide whether an article may publish without a person
     (fpGates). Anything short of all twelve is HELD FOR REVIEW. The
     headlines lead with a storyline, and every storyline is a fact in the
     research (a ranking, a projection, a result), never a story invented to
     explain a number.
     ====================================================================== */
  var FP_TZ = 'America/Chicago';
  var FP_SLOTS = { 1: 'weekend_review', 3: 'storylines', 5: 'research_preview' };
  var FP_KINDS = {
    weekend_review: { label: 'Weekend Model Review', format: 'fp_weekend_review', day: 'Monday', category: 'weekend-model-review' },
    storylines: { label: 'Weekend Storylines', format: 'fp_storylines', day: 'Wednesday', category: 'weekend-storylines' },
    research_preview: { label: 'Weekend Research Preview', format: 'fp_research_preview', day: 'Friday', category: 'weekend-research-preview' }
  };
  var FP_DEFAULTS = { publish_hour_ct: 7, window_hours: 10, max_per_week: 3, research_max_age_hours: 36, kickoff_lead_minutes: 60,
    publisher_similarity_max: 0.35, site_similarity_max: 0.5 };
  var FP_CTA = { text: 'Explore the full matchup research on EdgeDesk.', href: SITE + '/today/' };
  var WD3 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function ctParts(t) {
    var o = {};
    new Intl.DateTimeFormat('en-US', { timeZone: FP_TZ, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(new Date(t)).forEach(function (x) { o[x.type] = x.value; });
    return { y: +o.year, m: +o.month, d: +o.day, wd: WD3.indexOf(o.weekday), h: (+o.hour) % 24, mi: +o.minute };
  }
  function ctDate(t) { var p = ctParts(t); return p.y + '-' + (p.m < 10 ? '0' : '') + p.m + '-' + (p.d < 10 ? '0' : '') + p.d; }
  /* the instant a Central Time wall clock reads h:00 on y-m-d (CST or CDT) */
  function ctInstant(y, m, d, h) {
    for (var off = 5; off <= 6; off++) { var t = Date.UTC(y, m - 1, d, h + off); var p = ctParts(t); if (p.h === h && p.d === d) return t; }
    return Date.UTC(y, m - 1, d, h + 6);
  }
  /* the Monday that starts the Central Time week a date falls in */
  function ctWeekOf(t) { var p = ctParts(t); var back = (p.wd + 6) % 7; return ctDate(ctInstant(p.y, p.m, p.d, 12) - back * 86400000); }
  function fpSlot(now, settings) {
    settings = Object.assign({}, FP_DEFAULTS, settings || {});
    var p = ctParts(now), kind = FP_SLOTS[p.wd];
    if (!kind) return null;
    var at = ctInstant(p.y, p.m, p.d, settings.publish_hour_ct);
    return { kind: kind, label: FP_KINDS[kind].label, date: ctDate(now), week: ctWeekOf(now), publish_at: iso(at), window_end: iso(at + settings.window_hours * 3600000),
      id: 'feature-' + ctDate(now) + '-' + kind.replace(/_/g, '-') };
  }
  var MON3 = ['Jan.', 'Feb.', 'March', 'April', 'May', 'June', 'July', 'Aug.', 'Sept.', 'Oct.', 'Nov.', 'Dec.'];
  function ctDayText(t) { var p = ctParts(t); return MON3[p.m - 1] + ' ' + p.d; }
  /* "Fri., Oct. 9, 7 a.m. CT": the publishing schedule is Central Time */
  function ctWhen(t) {
    var p = ctParts(t), h = p.h % 12 || 12;
    return ['Sun.', 'Mon.', 'Tue.', 'Wed.', 'Thu.', 'Fri.', 'Sat.'][p.wd] + ', ' + MON3[p.m - 1] + ' ' + p.d + ', ' + h + (p.mi ? ':' + (p.mi < 10 ? '0' : '') + p.mi : '') + ' ' + (p.h < 12 ? 'a.m.' : 'p.m.') + ' CT';
  }

  function upcomingOf(L, now, lead) { return (L && L.games || []).filter(function (p) { var k = ts(p.kickoff); return p.model.available && p.flags.indexOf('KICKED_OFF') < 0 && k != null && k > now + (lead || 0); }); }
  /* a game whose number the market disputes by more than EdgeDesk's inputs
     explain is not featured in an unattended article: it waits for a person */
  function undisputed(p) { return !p.discrepancy || p.discrepancy.review === 'NONE'; }
  function disputedNote(n) {
    return n ? '- **Left out for review:** ' + numWord(n) + ' upcoming game' + (n === 1 ? '' : 's') + ' where EdgeDesk’s number and the market disagree by more than EdgeDesk’s inputs explain ' + (n === 1 ? 'is' : 'are') + ' not featured here until a person has reviewed the gap.' : null;
  }
  function fpOpp(kind, research, snap, extra) {
    var leagues = research.leagues_used || [];
    var sources = [];
    leagues.forEach(function (lg) { sourcesOf(snap, lg).forEach(function (x) { sources.push(x); }); });
    (snap.sources || []).filter(function (x) { return /^record_/.test(x.id) && leagues.indexOf(x.id.slice(7)) >= 0; })
      .forEach(function (x) { sources.push({ kind: 'edgedesk_research', label: x.what, path: x.path, url: SITE + '/' + x.path, as_of: x.as_of }); });
    return Object.assign({ league: 'multi', fp_kind: kind, kind: 'fp_' + kind, season: research.season, week: research.week, research: research, sources: sources, formats: [FP_KINDS[kind].format] }, extra || {});
  }

  /* ── Monday: the weekend's results against the pregame numbers ── */
  function fpReview(snap, now) {
    var leagues = ['cfb', 'nfl'].filter(function (lg) { var R = snap.results && snap.results[lg]; return R && R.results.length && now - ts(R.last_kickoff) <= 4 * 86400000; });
    if (!leagues.length) return { ok: false, reason: 'no graded games from this weekend in the model record yet' };
    var res = [], L = {}, asOf = null;
    leagues.forEach(function (lg) {
      var R = snap.results[lg];
      L[lg] = { week: R.week, week_record: R.week_record, season_record: R.season_record };
      R.results.forEach(function (x) { res.push(x); });
      if (R.as_of && (!asOf || ts(R.as_of) > ts(asOf))) asOf = R.as_of;
    });
    if (res.length < 6) return { ok: false, reason: 'only ' + res.length + ' graded games this weekend: too few for a review' };
    var season = (snap.results[leagues[0]] || {}).season_year;
    var research = { kind: 'fp_weekend_review', league: 'multi', leagues_used: leagues, season: season, week: L.cfb ? L.cfb.week : L.nfl.week, as_of: asOf,
      weeks: { cfb: L.cfb && L.cfb.week, nfl: L.nfl && L.nfl.week },
      leagues: L, results: res, games: [], upsets: [], races: [], context: {}, limitations: [] };
    return { ok: true, o: fpOpp('weekend_review', research, snap) };
  }
  function lgName(lg, cap0) { return lg === 'nfl' ? 'NFL' : (cap0 ? 'College football' : 'college football'); }
  function fpReviewHeadline(o) {
    var R = o.research, head = 'Weekend Model Review: ', opts = [];
    var lgs = R.leagues_used.slice().sort(function (a, b) { return R.leagues[b].week_record.games - R.leagues[a].week_record.games; });
    lgs.forEach(function (lg) {
      var W = R.leagues[lg].week_record, nm = lg === 'nfl' ? 'NFL' : 'College';
      if (W.compared >= 4 && W.closer / W.compared >= 0.6) opts.push(head + 'EdgeDesk Beat the Close in ' + W.closer + ' of ' + W.compared + ' ' + nm + ' Games');
      if (W.su_games >= 4 && W.su_w / W.su_games >= 0.7) opts.push(head + 'EdgeDesk’s Favorite Won ' + W.su_w + ' of ' + W.su_games + ' ' + nm + ' Games');
    });
    var miss = R.results.slice().sort(function (a, b) { return (b.grade.model_err || 0) - (a.grade.model_err || 0); })[0];
    if (miss && miss.final.winner && miss.final.margin >= 17) opts.push(head + nick(miss.final.winner, miss.league) + '’ ' + miss.final.score + ' Win Tops the Misses');
    opts.push(head + 'What Held Up and What Missed');
    return opts.filter(function (h, i) { return h.length <= 70 || i === opts.length - 1; })[0];
  }
  function pgBullets(W) {
    var b = ['- **Right winner:** ' + W.su_w + ' of ' + W.su_games + '.'];
    if (W.compared) b.push('- **Closer to the final than the closing line:** ' + W.closer + ' of ' + W.compared + '.', '- **Average miss on the margin:** EdgeDesk ' + oneDp(W.model_err_avg) + ' points, the closing line ' + oneDp(W.close_err_avg) + '.');
    if (W.ats_w + W.ats_l + W.ats_p) b.push('- **Against the closing spread:** ' + W.ats_w + '-' + W.ats_l + (W.ats_p ? '-' + W.ats_p : '') + ' for the side EdgeDesk’s number leaned to (a grade of the number, not a betting record).');
    return b.join('\n');
  }
  /* EdgeDesk's own result card: the same facts as the publisher recap, in a
     different shape, so the two are never near-copies of each other */
  function fpCard(x, lgs) {
    var p = x.pre, f = x.final, g = x.grade;
    var fin = f.winner ? (x.home === f.winner ? x.home + ' ' + f.home + ', ' + x.away + ' ' + f.away : x.away + ' ' + f.away + ', ' + x.home + ' ' + f.home) : x.away + ' ' + f.away + ', ' + x.home + ' ' + f.home;
    var lines = ['- Final: ' + fin + (lgs.length > 1 ? ' (' + (x.league === 'nfl' ? 'NFL' : 'college football') + ')' : ''),
      '- EdgeDesk before kickoff: ' + (p.favorite ? p.favorite + ' by ' + oneDp(p.margin) + (isNum(p.fav_win_pct) ? ', ' + p.fav_win_pct + '% to win' : '') : 'a pick’em'),
      isNum(g.model_err) ? '- Off by: ' + oneDp(g.model_err) + ' points' + (isNum(g.close_err) ? ' (closing line' + (x.close ? ' ' + (x.close.favorite ? x.close.favorite + ' -' + String(r1(x.close.margin)) : 'pick’em') : '') + ': off by ' + oneDp(g.close_err) + ')' : '') : null];
    return '**' + x.away + ' at ' + x.home + '**\n\n' + lines.filter(Boolean).join('\n') + (x.postgame_url ? '\n\n[EdgeDesk’s postgame analysis](' + x.postgame_url + ')' : '');
  }
  function fpReviewSections(o) {
    var R = o.research, s = {}, lgs = R.leagues_used, res = R.results;
    var desc = lgs.map(function (lg) { return lgName(lg) + ' Week ' + R.leagues[lg].week; });
    var total = lgs.reduce(function (a, lg) { return a + R.leagues[lg].week_record.games; }, 0);
    s.intro = para('EdgeDesk publishes its numbers before kickoff and grades every one of them afterward. This weekend model review covers ' + sentenceList(desc) + ': ' + numWord(total) + ' graded games.',
      lgs.map(function (lg, i) { var W = R.leagues[lg].week_record; return (i ? 'In the ' : 'In ') + (lg === 'nfl' ? 'NFL' : 'college football') + ', the model had the right winner in ' + W.su_w + ' of ' + W.su_games + '.'; }).join(' '),
      'Here are the calls that held up, the misses, and what one weekend can and can’t say about a model.');
    s.how_to_read = para('Each game is graded the same way: EdgeDesk’s last pregame number against the final score, next to the closing line, the market’s last word before kickoff.',
      'A single game can miss by two touchdowns even when the projection was sound, so one weekend is a small sample; the season record below is the better guide.',
      'This is a record of a model, not betting advice and not a betting result.');
    s.scoreboard = lgs.map(function (lg) {
      var W = R.leagues[lg].week_record;
      return para('**' + lgName(lg, true) + ', Week ' + R.leagues[lg].week + '.** Of ' + numWord(W.games) + ' graded games, EdgeDesk’s pregame favorite won ' + W.su_w + '.',
        W.compared ? 'Measured by how far each projected margin landed from the final, EdgeDesk averaged ' + oneDp(W.model_err_avg) + ' points and the closing line ' + oneDp(W.close_err_avg) + ', with EdgeDesk the nearer of the two in ' + W.closer + ' games.' : null,
        (W.ats_w + W.ats_l) ? 'Scored against the closing spread, the side its number leaned to went ' + W.ats_w + '-' + W.ats_l + (W.ats_p ? '-' + W.ats_p : '') + ', a grade of the number rather than a betting record.' : null);
    }).join('\n\n');
    var closest = res.filter(function (x) { return isNum(x.grade.model_err); }).sort(function (a, b) { return a.grade.model_err - b.grade.model_err; }).slice(0, 3);
    var ids = closest.map(function (x) { return x.game_id; });
    var misses = res.filter(function (x) { return isNum(x.grade.model_err) && ids.indexOf(x.game_id) < 0; }).sort(function (a, b) { return b.grade.model_err - a.grade.model_err; }).slice(0, 3);
    var tag = function (x) { return lgs.length > 1 ? ' (' + (x.league === 'nfl' ? 'NFL' : 'college football') + ')' : ''; };
    var withLink = function (x) { return x.postgame_url ? ' [Read the postgame analysis](' + x.postgame_url + ').' : ''; };
    s.closest = closest.map(function (x) { return fpCard(x, lgs); }).join('\n\n');
    var bothN = misses.filter(function (x) { return isNum(x.grade.close_err) && x.grade.close_err >= x.grade.model_err - 3; }).length;
    s.misses = misses.length ? (bothN ? (bothN === misses.length ? 'In each of these, the closing line missed by about as much as EdgeDesk did, so the market’s number was no closer.' : 'In ' + numWord(bothN) + ' of these, the closing line missed by about as much as EdgeDesk did.') + '\n\n' : '')
      + misses.map(function (x) { return fpCard(x, lgs); }).join('\n\n') : 'No game missed by enough to single out.';
    void tag; void withLink;
    s.season = lgs.map(function (lg) {
      var S = R.leagues[lg].season_record; if (!S || !S.games) return null;
      return para('**' + lgName(lg, true) + ':** across the season so far, the right winner in ' + S.su_w + ' of ' + S.su_games + ' graded games (' + S.su_pct + '%)'
        + (S.compared ? '; an average miss on the margin of ' + oneDp(S.model_err_avg) + ' points against ' + oneDp(S.close_err_avg) + ' for the closing line.' : '.'));
    }).filter(Boolean).join('\n\n');
    s.limits = '- **Small samples:** one weekend says little about a model on its own; read it next to the season record.\n'
      + '- **Final scores are noisy:** late scores, turnovers and garbage time move a margin without saying much about how the game was played.\n'
      + '- **Still to be graded:** a game is reviewed only once its final and its grade are on record, so a late game can be missing here.\n'
      + '- **Uncertainty:** even a 70% favorite loses about three times in ten. Projections describe likelihoods, not outcomes.';
    var top = misses[0];
    s.conclusion = para('The short version: ' + lgs.map(function (lg) { var W = R.leagues[lg].week_record; return W.su_w + ' of ' + W.su_games + ' winners in ' + (lg === 'nfl' ? 'the NFL' : 'college football'); }).join(' and ')
      + (top ? '; the biggest miss was ' + top.away + ' at ' + top.home : '') + '.',
      'Every number here was published before kickoff and graded after it, misses included. None of it is a pick.');
    return s;
  }

  /* ── Wednesday: the upcoming weekend's biggest storylines ── */
  function fpStorylines(snap, now, opts) {
    opts = opts || {};
    var lead = (opts.kickoff_lead_minutes != null ? opts.kickoff_lead_minutes : FP_DEFAULTS.kickoff_lead_minutes) * 60000;
    var all0 = { cfb: upcomingOf(snap.cfb, now, lead), nfl: upcomingOf(snap.nfl, now, lead) };
    var up = { cfb: all0.cfb.filter(undisputed), nfl: all0.nfl.filter(undisputed) };
    var disputed = all0.cfb.length + all0.nfl.length - up.cfb.length - up.nfl.length;
    var cands = [];
    var add = function (kind, p, extra) { if (p) cands.push(Object.assign({ kind: kind, p: p }, extra || {})); };
    var rc = rankGames('cfb', up.cfb), rn = rankGames('nfl', up.nfl);
    if (rc[0]) add('headliner', rc[0].p, { why: rc[0].why });
    if (rn[0]) add('headliner', rn[0].p, { why: rn[0].why });
    var ids0 = up.cfb.map(function (p) { return p.game_id; });
    var race = conferenceRaces(snap).filter(function (p) { return ids0.indexOf(p.game_id) >= 0; })[0];
    if (race) add('race', race);
    var uc = upsetsOf('cfb', up.cfb)[0], un = upsetsOf('nfl', up.nfl)[0];
    if (uc) add('upset', uc);
    var gap = up.cfb.concat(up.nfl).filter(function (p) { return p.discrepancy; }).sort(function (a, b) { return b.discrepancy.points - a.discrepancy.points; })[0];
    if (gap) add('gap', gap);
    var wx = up.cfb.filter(function (p) { return p.weather && p.weather.state === 'HAZARD'; })[0];
    if (wx) add('weather', wx);
    var qb = up.cfb.filter(function (p) { return p.qb && ((p.qb.home && p.qb.home.material) || (p.qb.away && p.qb.away.material)); })[0];
    if (qb) add('qb', qb);
    if (un) add('upset', un);
    var seen = {}, picks = [];
    cands.forEach(function (c) { if (picks.length < 5 && !seen[c.p.game_id]) { seen[c.p.game_id] = 1; picks.push(c); } });
    if (picks.length < 3) return { ok: false, reason: 'only ' + picks.length + ' storyline(s) with research behind them: not enough for the Wednesday piece' };
    var lgs = uniq(picks.map(function (c) { return c.p.league; }));
    var L = snap.cfb || snap.nfl;
    var research = { kind: 'fp_storylines', league: 'multi', leagues_used: lgs, season: L.season, week: snap.cfb ? snap.cfb.week : snap.nfl.week, weeks: { cfb: snap.cfb && snap.cfb.week, nfl: snap.nfl && snap.nfl.week },
      as_of: [snap.cfb && snap.cfb.generated_at, snap.nfl && snap.nfl.generated_at].filter(Boolean).sort().pop() || null,
      stories: picks.map(function (c) { return { kind: c.kind, game_id: c.p.game_id, league: c.p.league, why: c.why || [] }; }),
      games: picks.map(function (c) { return c.p; }), upsets: [], races: race ? [race] : [], context: snap.cfb ? contextOf(snap, 'cfb') : {}, limitations: [],
      conference_top: race ? (snap.cfb.rankings.conference_top[race.home_conference] || []) : [], disputed: disputed };
    return { ok: true, o: fpOpp('storylines', research, snap) };
  }
  function storyOf(o, st, p, i) {
    var sep = p.neutral_site ? ' vs. ' : ' at ', g = rankedName(p, 'away') + sep + rankedName(p, 'home');
    var lnk = p.link ? '\n\nFull research: [' + p.away + ' vs. ' + p.home + ' on EdgeDesk](' + p.link + ')' : '';
    var lg = p.league === 'nfl' ? 'NFL' : 'college football';
    if (st.kind === 'headliner') {
      var both = p.league === 'cfb' && isNum(p.home_rank) && isNum(p.away_rank) && p.home_rank <= 25 && p.away_rank <= 25;
      return { heading: 'The ' + lg + ' headliner: ' + p.away + sep + p.home,
        body: para(g + (p.kickoff_text ? ' (' + p.kickoff_text + ')' : '') + ' is the ' + lg + ' game EdgeDesk’s research ranks highest this week' + (both ? ': two top-25 teams in EdgeDesk’s power ratings' + (p.conference_game ? ', in a game that counts in the ' + p.home_conference + ' standings' : '') : '') + '.',
          fanLine(p, i), driverLine(p, i), marketLine(p, i)) + lnk };
    }
    if (st.kind === 'race') {
      return { heading: 'The ' + p.home_conference + ' race: ' + p.away + sep + p.home,
        body: para('Both teams are among the ' + p.home_conference + '’s three highest-rated teams in EdgeDesk’s ratings, so the result carries straight into the title race.', fanLine(p, i), matchupLine(p, i), 'EdgeDesk doesn’t carry a standings feed, so this reads the race through ratings, not the table.') + lnk };
    }
    if (st.kind === 'upset') {
      return { heading: 'Upset watch: ' + p.model.underdog + ' against ' + p.model.favorite,
        body: para('EdgeDesk gives ' + p.model.underdog + ' a ' + p.model.dog_win_pct + '% chance against ' + p.model.favorite + (p.kickoff_text ? ' (' + p.kickoff_text + ')' : '') + '.',
          'That is a real chance, not a prediction: the favorite still wins this game more often than not.', driverLine(p, i)) + lnk };
    }
    if (st.kind === 'gap') {
      return { heading: 'Model vs. market: ' + p.away + sep + p.home, body: discrepancyText(p, i) + ' A gap between a model and a market is a research question, not a reason to bet.' + lnk };
    }
    if (st.kind === 'weather') {
      var w = p.weather;
      return { heading: 'Weather watch: ' + p.away + sep + p.home,
        body: para('The kickoff forecast (' + (w.source || 'open-meteo forecast') + (w.as_of ? ', as of ' + whenText(ts(w.as_of)) : '') + ') calls for ' + sentenceList(w.hazards) + '.', fanLine(p, i), 'EdgeDesk’s projected margin does not move for weather, so this is one to check again before kickoff.') + lnk };
    }
    if (st.kind === 'qb') {
      return { heading: 'Quarterback watch: ' + p.away + sep + p.home, body: para((qbLine(p) || '').replace(/^Quarterback: /, ''), fanLine(p, i)) + lnk };
    }
    return null;
  }
  function fpStorylinesSections(o) {
    var R = o.research, s = {};
    var stories = R.stories.map(function (st, i) { var p = R.games.filter(function (g) { return g.game_id === st.game_id; })[0]; return p ? storyOf(o, st, p, i) : null; }).filter(Boolean);
    var h0 = R.games[0];
    s.intro = para('Here are the week ' + R.week + ' storylines EdgeDesk’s research says are worth following, from ' + h0.away + (h0.neutral_site ? ' vs. ' : ' at ') + h0.home + ' to the games where the numbers are closer than the billing.',
      'Each one is built on a number EdgeDesk publishes, a ranking, a projection or a forecast, and each links to the full matchup research.');
    s.how_to_read = howToRead(o, { noDataQuality: true });
    stories.forEach(function (x, i) { s['story_' + (i + 1)] = x; });
    s.limits = [limitsSection(o), disputedNote(R.disputed)].filter(Boolean).join('\n');
    s.conclusion = para('Projections move as news and prices arrive during the week, and EdgeDesk updates its numbers as they do. The Friday research preview will have the latest.',
      'None of this is a pick. It is a guide to where the weekend’s real uncertainty sits.');
    return s;
  }

  /* ── Friday: the weekend in five numbers ── */
  function fpPreview(snap, now, opts) {
    opts = opts || {};
    var lead = (opts.kickoff_lead_minutes != null ? opts.kickoff_lead_minutes : FP_DEFAULTS.kickoff_lead_minutes) * 60000;
    var ac = upcomingOf(snap.cfb, now, lead), an = upcomingOf(snap.nfl, now, lead);
    var fc = rankGames('cfb', ac.filter(undisputed)).slice(0, 10).map(function (x) { return x.p; });
    var fn = rankGames('nfl', an.filter(undisputed)).slice(0, 6).map(function (x) { return x.p; });
    var disputed = ac.length + an.length - ac.filter(undisputed).length - an.filter(undisputed).length;
    var nums = [], used = {};
    var take = function (key, p, extra) { if (p && !used[p.game_id + key]) { used[p.game_id + key] = 1; nums.push(Object.assign({ key: key, game_id: p.game_id, league: p.league }, extra || {})); } };
    var withFav = fc.filter(function (p) { return p.model.favorite && isNum(p.model.fav_win_pct); });
    var closest = withFav.slice().sort(function (a, b) { return a.model.margin - b.model.margin; })[0];
    take('closest', closest);
    var biggest = withFav.concat(fn.filter(function (p) { return p.model.favorite && isNum(p.model.fav_win_pct); })).sort(function (a, b) { return b.model.fav_win_pct - a.model.fav_win_pct; })[0];
    if (biggest && (!closest || biggest.game_id !== closest.game_id)) take('favorite', biggest);
    var dog = upsetsOf('cfb', fc).concat(upsetsOf('nfl', fn)).sort(function (a, b) { return b.model.dog_win_pct - a.model.dog_win_pct; })[0];
    take('underdog', dog);
    var miss = fc.filter(function (p) { return isNum(p.model.typical_miss); })[0];
    if (miss) take('miss', miss);
    var gap = fc.concat(fn).filter(function (p) { return p.discrepancy; }).sort(function (a, b) { return b.discrepancy.points - a.discrepancy.points; })[0];
    if (gap) take('gap', gap);
    var nflTop = fn.filter(function (p) { return p.model.favorite; })[0];
    if (nums.length < 5 && nflTop) take('nfl', nflTop);
    nums = nums.slice(0, 5);
    if (nums.length < 4) return { ok: false, reason: 'only ' + nums.length + ' numbers with research behind them: not enough for the Friday preview' };
    var games = uniq(nums.map(function (n) { return n.game_id; })).map(function (id) { return fc.concat(fn).filter(function (p) { return p.game_id === id; })[0]; });
    var L = snap.cfb || snap.nfl;
    var research = { kind: 'fp_research_preview', league: 'multi', leagues_used: uniq(games.map(function (p) { return p.league; })), season: L.season, week: snap.cfb ? snap.cfb.week : snap.nfl.week,
      weeks: { cfb: snap.cfb && snap.cfb.week, nfl: snap.nfl && snap.nfl.week }, disputed: disputed,
      as_of: [snap.cfb && snap.cfb.generated_at, snap.nfl && snap.nfl.generated_at].filter(Boolean).sort().pop() || null,
      numbers: nums, games: games, watch: fc.concat(fn).filter(function (p) { return (p.weather && p.weather.state === 'HAZARD') || (p.qb && ((p.qb.home && p.qb.home.material) || (p.qb.away && p.qb.away.material))); }).slice(0, 3).map(function (p) { return p.game_id; }),
      upsets: [], races: [], context: snap.cfb ? contextOf(snap, 'cfb') : {}, limitations: [] };
    research.games = uniq(games.concat(fc.concat(fn).filter(function (p) { return research.watch.indexOf(p.game_id) >= 0; })));
    return { ok: true, o: fpOpp('research_preview', research, snap) };
  }
  function fpPreviewSections(o) {
    var R = o.research, s = {};
    var G = function (id) { return R.games.filter(function (p) { return p.game_id === id; })[0]; };
    var sep = function (p) { return p.neutral_site ? ' vs. ' : ' at '; };
    s.intro = para('Five numbers frame the week ' + R.week + ' projections from EdgeDesk: the closest call, the biggest favorite, the best underdog chance and the size of a normal miss, each from the research EdgeDesk publishes for every game.',
      'Each number comes with the game it belongs to and what it does and doesn’t mean.');
    s.how_to_read = howToRead(o, { noDataQuality: true });
    R.numbers.forEach(function (n, i) {
      var p = G(n.game_id), m = p.model, g = p.away + sep(p) + p.home, k = 'num_' + (i + 1);
      if (n.key === 'closest') s[k] = { heading: oneDp(m.margin) + ' points: the closest call', body: para('**' + oneDp(m.margin) + ' points** is EdgeDesk’s projected margin for ' + g + (p.kickoff_text ? ' (' + p.kickoff_text + ')' : '') + ', the closest call among the college games EdgeDesk features this week.', 'EdgeDesk gives ' + m.favorite + ' a ' + m.fav_win_pct + '% chance to win, close enough that one bounce decides it.', matchupLine(p, i)) };
      if (n.key === 'favorite') s[k] = { heading: m.fav_win_pct + '%: the biggest favorite', body: para('**' + m.fav_win_pct + '%** is the chance EdgeDesk gives ' + m.favorite + ' against ' + m.underdog + ', the biggest favorite among the games EdgeDesk features this week.', 'It still leaves ' + m.underdog + ' winning ' + m.dog_win_pct + '% of the time: a heavy favorite is not a certainty.', driverLine(p, i)) };
      if (n.key === 'underdog') s[k] = { heading: m.dog_win_pct + '%: the best underdog chance', body: para('**' + m.dog_win_pct + '%** is the best chance EdgeDesk gives an underdog in a headline game: ' + m.underdog + ' against ' + m.favorite + (p.kickoff_text ? ' (' + p.kickoff_text + ')' : '') + '.', 'That is a real chance, not a prediction: the favorite still wins more often than not.', driverLine(p, i + 1)) };
      if (n.key === 'miss') s[k] = { heading: 'About ' + Math.round(m.typical_miss) + ' points: a normal miss', body: para('**About ' + Math.round(m.typical_miss) + ' points** is EdgeDesk’s typical miss on a game like ' + g + '.', 'Projected margins are estimates with a wide band around them, which is why a win chance says more than a margin, and why a projection is not a bet.') };
      if (n.key === 'gap') s[k] = { heading: oneDp(p.discrepancy.points) + ' points: the biggest explained gap with the market', body: discrepancyText(p, i) + ' A gap between a model and a market is a research question, not a reason to bet.' };
      if (n.key === 'nfl') s[k] = { heading: oneDp(m.margin) + ' points: the NFL headliner', body: para('**' + oneDp(m.margin) + ' points** is EdgeDesk’s margin for ' + m.favorite + ' in ' + g + (p.kickoff_text ? ' (' + p.kickoff_text + ')' : '') + ', the NFL game EdgeDesk’s research ranks highest this week.', 'EdgeDesk gives ' + m.favorite + ' a ' + m.fav_win_pct + '% chance to win.') };
      if (p.link) s[k].body += '\n\nFull research: [' + p.away + ' vs. ' + p.home + ' on EdgeDesk](' + p.link + ')';
    });
    var W = (R.watch || []).map(G).filter(Boolean);
    if (W.length) s.watch = W.map(function (p) {
      var bits = [];
      if (p.weather && p.weather.state === 'HAZARD') bits.push('the forecast calls for ' + sentenceList(p.weather.hazards));
      var q = qbLine(p); if (q) bits.push(q.replace(/^Quarterback: /, '').replace(/\.$/, ''));
      return '- **' + p.away + sep(p) + p.home + ':** ' + bits.join('; ') + '.';
    }).join('\n');
    s.limits = [limitsSection(o), disputedNote(R.disputed)].filter(Boolean).join('\n');
    s.conclusion = para('Five numbers, five games, and none of them a pick. EdgeDesk updates every projection as news and prices arrive, and Monday’s weekend model review will grade them.');
    return s;
  }

  var FP_BUILD = { weekend_review: fpReview, storylines: fpStorylines, research_preview: fpPreview };
  var FP_SECTIONS = { weekend_review: fpReviewSections, storylines: fpStorylinesSections, research_preview: fpPreviewSections };
  function fpSeo(o, now) {
    var R = o.research, w = R.week;
    if (o.fp_kind === 'weekend_review') {
      var t = fpReviewHeadline(o);
      return { title: t, keyword: 'weekend model review', slug: 'weekend-model-review-' + slugify(ctDayText(now)) + '-' + R.season,
        meta: 'EdgeDesk’s weekend model review: every pregame number graded on the final and against the closing line, the closest calls and the biggest misses.' };
    }
    if (o.fp_kind === 'storylines') {
      var h = R.games[0], hg = h.away + (h.neutral_site ? ' vs. ' : ' at ') + h.home, n = R.stories.length;
      var cands = [hg + ' and ' + cap(numWord(n - 1)) + ' More Storylines for Week ' + w, 'Week ' + w + ' Storylines: ' + hg + ' and More', 'Week ' + w + ' Storylines EdgeDesk Is Watching'];
      return { title: cands.filter(function (x, i) { return x.length <= 70 || i === cands.length - 1; })[0], keyword: 'week ' + w + ' storylines', slug: 'week-' + w + '-storylines-' + R.season,
        meta: 'The week ' + w + ' storylines EdgeDesk’s research says are worth following: the headliners, the upset chances and the numbers behind them. Research, not picks.' };
    }
    return { title: 'The Weekend in ' + cap(numWord(R.numbers.length)) + ' Numbers: Week ' + w + ' Projections From EdgeDesk', keyword: 'week ' + w + ' projections', slug: 'week-' + w + '-projections-in-' + numWord(R.numbers.length) + '-numbers-' + R.season,
      meta: 'Week ' + w + ' projections from EdgeDesk in ' + numWord(R.numbers.length) + ' numbers: the closest call, the biggest favorite, the best underdog chance and a normal miss.' };
  }
  /* the article for a slot, or why there is none */
  function fpBuild(kind, snap, opts) {
    opts = opts || {};
    var now = isNum(opts.now) ? opts.now : Date.now();
    if (!FP_BUILD[kind]) return { ok: false, reason: 'unknown slot ' + kind };
    var b = FP_BUILD[kind](snap, now, opts);
    if (!b.ok) return b;
    var o = b.o, raw = FP_SECTIONS[kind](o), F = FORMATS[FP_KINDS[kind].format];
    var sections = [];
    F.sections.forEach(function (k) {
      var x = raw[k]; if (!x) return;
      if (typeof x === 'string') sections.push({ key: k, heading: SECTION_HEADINGS[k] || null, body: x });
      else sections.push({ key: k, heading: x.heading || null, body: x.body });
    });
    var seo = fpSeo(o, now);
    o.seo = { primary_keyword: seo.keyword, secondary_keywords: [], headline: seo.title, meta_description: seo.meta, slug: seo.slug };
    var a = { format: FP_KINDS[kind].format, base_format: FP_KINDS[kind].format, angle: kind, title: seo.title, slug: seo.slug,
      meta_description: seo.meta, primary_keyword: seo.keyword, secondary_keywords: [], standfirst: fpStandfirst(o), sections: sections,
      generator: 'template:' + VERSION + ':fp', generated_at: iso(now), research_as_of: o.research.as_of || null, research_hash: researchHash(o) };
    a.word_count = wordCount(a.standfirst + ' ' + sections.map(function (x) { return x.body; }).join(' '));
    return { ok: true, o: o, article: a };
  }
  function fpStandfirst(o) {
    if (o.fp_kind === 'weekend_review') return 'Every number EdgeDesk published before kickoff, graded on the final and against the closing line: what held up, what missed, and what one weekend can’t say.';
    if (o.fp_kind === 'storylines') return 'The week ' + o.research.week + ' games EdgeDesk’s research says are worth following, and the numbers behind each one. Research, not picks.';
    return 'The closest call, the biggest favorite, the best underdog chance and the size of a normal miss: the weekend in numbers, each one explained.';
  }

  /* THE TWELVE GATES. ctx: { now, slot, settings, current, teamLists,
     publishedThisWeek: [{id, kind}], site: [{id, slug, title, text}] (every
     published EdgeDesk page's text), taken: {slug: id}, publisherTexts:
     [{label, text}] (the week's publisher drafts), ai: {used, ledgered} }.
     All twelve must pass for an article to publish without a person. */
  function fpGates(a, o, ctx) {
    ctx = ctx || {};
    var now = isNum(ctx.now) ? ctx.now : Date.now();
    var S = Object.assign({}, FP_DEFAULTS, ctx.settings || {});
    var g = [];
    function add(key, label, ok, detail) { g.push({ key: key, label: label, ok: !!ok, detail: detail || null }); }
    var v = validate(a, o, { now: now, teamLists: ctx.teamLists, siblings: [] });
    var vc = {}; v.checks.forEach(function (c) { vc[c.id] = c; });
    var ce = gate(a, o, { now: now, current: ctx.current, teamLists: ctx.teamLists, landing: FP_CTA.href, campaign: null });
    var slot = ctx.slot;
    /* 1 the slot */
    add('slot', 'Today’s Central Time slot is this article’s', slot && slot.kind === o.fp_kind && now <= ts(slot.window_end),
      slot ? slot.label + ' · publishes ' + ctWhen(ts(slot.publish_at)) + ' · window closes ' + ctWhen(ts(slot.window_end)) : 'no slot today');
    /* 2 the cadence */
    var wk = (ctx.publishedThisWeek || []).filter(function (x) { return !slot || x.id !== slot.id; });
    var dupSlot = (ctx.publishedThisWeek || []).some(function (x) { return slot && x.id === slot.id; });
    add('cadence', 'At most ' + S.max_per_week + ' a week, one per slot', !dupSlot && wk.length < S.max_per_week, (dupSlot ? 'this slot is already published; ' : '') + wk.length + ' published this week');
    /* 3 freshness */
    var age = o.research.as_of ? (now - ts(o.research.as_of)) / 3600000 : null;
    add('freshness', 'The research is fresh', age != null && age <= S.research_max_age_hours, age == null ? 'no research time on file' : 'research read ' + Math.round(age) + ' hours ago (limit ' + S.research_max_age_hours + ')');
    /* 4 the schedule */
    var started = (o.research.games || []).filter(function (p) { var k = ts(p.kickoff); return k != null && k <= now + S.kickoff_lead_minutes * 60000; });
    var unfinished = (o.research.results || []).filter(function (x) { return !x.final || !isNum(x.final.home); });
    add('schedule', o.fp_kind === 'weekend_review' ? 'Every game reviewed is final and graded' : 'No featured game has started (or starts within the hour)', !started.length && !unfinished.length,
      started.length ? started.map(function (p) { return p.away + ' at ' + p.home; }).join(', ') : unfinished.length ? unfinished.length + ' unfinished' : null);
    /* 5 the editorial gate: nothing blocked, nothing that needs a person's judgment */
    var judge = [];
    ce.items.forEach(function (it) { it.findings.forEach(function (f) {
      if (f.status === 'BLOCKED' || (f.status === 'WARNING' && /^discrepancy:/.test(f.ack_key || '') && !f.acknowledged)) judge.push(it.label + ': ' + f.reason);
    }); });
    add('editorial_gate', 'The fourteen-check editorial gate: nothing blocked, no unexplained market gap', !judge.length, judge.length ? judge.slice(0, 4).join(' · ') : 'verdict ' + ce.verdict
      + (ce.counts && ce.counts.WARNING ? ' (' + ce.counts.WARNING + ' warning(s), none needing a person)' : ''));
    /* 6 the hard checks */
    add('hard_checks', 'Every hard validation check passes', v.ok, v.ok ? null : v.failed.join(', '));
    /* 7 the numbers */
    var numIds = ['numbers_in_evidence', 'numbers_reconcile', 'results_reconcile'];
    var numBad = numIds.filter(function (k) { return vc[k] && vc[k].status === 'fail'; });
    add('numbers', 'Every number traces to the research and reconciles', !numBad.length, numBad.length ? numBad.map(function (k) { return vc[k].detail; }).join(' · ') : null);
    /* 8 responsible gambling */
    var resp = ['no_recommendation', 'projection_not_value', 'no_confidence_misuse'].filter(function (k) { return vc[k] && vc[k].status === 'fail'; });
    add('responsible', 'No pick or staking language; a projection is explained as not a bet; the 21+ disclaimer is on the page', !resp.length, resp.length ? resp.join(', ') : null);
    /* 9 duplicates on EdgeDesk */
    var owner = (ctx.taken || {})[a.slug];
    var simSite = (ctx.site || []).filter(function (x) { return !slot || x.id !== slot.id; }).map(function (x) { return { id: x.id, title: x.title, sim: similarity(textOf(a), x.text) }; }).sort(function (x, y) { return y.sim - x.sim; })[0];
    add('duplicate_site', 'A URL of its own, and not a near-copy of anything EdgeDesk has published', (!owner || (slot && owner === slot.id)) && (!simSite || simSite.sim < S.site_similarity_max),
      (owner && (!slot || owner !== slot.id) ? '/articles/' + a.slug + '/ is taken by ' + owner + '; ' : '') + (simSite ? 'closest: ' + Math.round(simSite.sim * 100) + '% overlap with “' + simSite.title + '”' : 'nothing published to compare'));
    /* 10 duplicates with a publisher's article (a distinct angle, never a copy) */
    var simPub = (ctx.publisherTexts || []).map(function (x) { return { label: x.label, sim: similarity(textOf(a), x.text) }; }).sort(function (x, y) { return y.sim - x.sim; })[0];
    add('duplicate_publisher', 'A distinct angle from every publisher article of the same week', !simPub || simPub.sim < S.publisher_similarity_max,
      simPub ? 'closest: ' + Math.round(simPub.sim * 100) + '% overlap with ' + simPub.label + ' (limit ' + Math.round(S.publisher_similarity_max * 100) + '%)' : 'no publisher article this week');
    /* 11 SEO */
    var seoBad = [];
    if (!a.title || a.title.length < 20 || a.title.length > 75) seoBad.push('headline ' + (a.title || '').length + ' characters');
    if (!a.meta_description || a.meta_description.length < 90 || a.meta_description.length > 160) seoBad.push('meta description ' + (a.meta_description || '').length + ' characters');
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(a.slug || '')) seoBad.push('slug');
    if (vc.seo_keyword && vc.seo_keyword.status !== 'pass') seoBad.push('keyword: ' + vc.seo_keyword.detail);
    add('seo', 'Headline, description, URL and keyword are complete', !seoBad.length, seoBad.join('; ') || null);
    /* 12 cost */
    var ai = ctx.ai || null;
    add('cost', 'Any AI used went through the shared budget ledger', !ai || !ai.used || !!ai.ledgered, ai && ai.used ? (ai.ledgered ? 'AI version kept, ledger call ' + (ai.call || '') : 'AI used without the ledger') : 'no AI used (EdgeDesk’s own writer)');
    return { ok: g.every(function (x) { return x.ok; }), gates: g, failed: g.filter(function (x) { return !x.ok; }).map(function (x) { return x.key; }), ce_gate: ce, validation: v };
  }
  /* the store record (tools/editorial/feature_model.js renders it) */
  function fpRecord(a, o, ctx) {
    ctx = ctx || {};
    var now = isNum(ctx.now) ? ctx.now : Date.now(), slot = ctx.slot || {};
    var body = a.sections.map(function (x) { return x.body; }).join('\n\n');
    return {
      id: slot.id, article_type: 'feature', feature_kind: o.fp_kind, category: FP_KINDS[o.fp_kind].label, category_slug: FP_KINDS[o.fp_kind].category,
      slot_date: slot.date || ctDate(now), season: o.research.season, week: o.research.week, leagues: o.research.leagues_used,
      sport: 'FEATURE', sport_label: 'EdgeDesk features', sport_slug: 'features',
      slug: a.slug, aliases: [], title: a.title, seo_title: a.title + ' | EdgeDesk', seo_description: a.meta_description, canonical_url: SITE + '/articles/' + a.slug + '/',
      primary_keyword: a.primary_keyword, standfirst: a.standfirst, excerpt: a.standfirst, sections: a.sections, word_count: a.word_count, author: 'EdgeDesk Research',
      research_as_of: a.research_as_of, research_hash: a.research_hash, content_hash: hash(a.title + '\n' + a.standfirst + '\n' + body), generator: a.generator,
      game_ids: (o.research.games || []).map(function (p) { return p.game_id; }).concat((o.research.results || []).map(function (x) { return x.game_id; })),
      research_links: uniq((o.research.games || []).map(function (p) { return p.link; }).filter(Boolean)),
      sources: (o.sources || []).map(function (x) { return { label: x.label, url: x.url, as_of: x.as_of }; }),
      disclaimer: DISCLAIMER, cta: FP_CTA,
      syndication: { canonical: 'self', note: 'Original EdgeDesk article. No other site is named canonical, and EdgeDesk claims no other site’s URL.' },
      status: ctx.status || 'draft', generated_at: iso(now), published_at: ctx.status === 'published' ? iso(now) : null, updated_at: iso(now)
    };
  }

  /* ======================================================================
     THE WEEKLY SUMMARY — what earned publication, traffic, sign-ups and
     money; which checks keep failing; which AI work was wasted; and what to
     change. Built from content_engine_weekly_data (counts only). Nothing is
     concluded from too little data: a comparison needs SAMPLE.articles
     articles a side and SAMPLE.visits visits, or it is reported as too early.
     ====================================================================== */
  var SAMPLE = { articles: 3, visits: 50, signups: 10, ai_calls: 4 };
  function weeklyReview(data, opts) {
    opts = opts || {};
    var now = isNum(opts.now) ? opts.now : Date.now();
    var arts = (data && data.articles) || [], ai = (data && data.ai) || {}, gf = (data && data.gate_failures) || {};
    var fin = function (x) { return x && x.funnel || {}; };
    var sum = function (list, k) { return list.reduce(function (a, x) { var v = fin(x)[k]; return a + (isNum(v) ? v : 0); }, 0); };
    var measured = arts.some(function (x) { return isNum(fin(x).visits); });
    var sent = arts.filter(function (x) { return x.sent_at; }), pub = arts.filter(function (x) { return x.published_at; });
    var out = { days: data && data.days, counts: { articles: arts.length, sent: sent.length, published: pub.length }, worked: [], failed: [], gate: [], ai: null, recommendations: [], too_early: [] };
    var firstGate = arts.filter(function (x) { return x.first_gate; });
    var passed = firstGate.filter(function (x) { return x.first_gate !== 'BLOCKED'; });
    out.counts.first_pass = firstGate.length ? passed.length + ' of ' + firstGate.length : null;

    /* what earned publication, and what it brought */
    pub.forEach(function (x) {
      var f = fin(x);
      out.worked.push({ title: x.title, format: x.format, publisher: x.publisher || 'EdgeDesk', visits: isNum(f.visits) ? f.visits : null, signups: isNum(f.signups) ? f.signups : null, paid: isNum(f.paid) ? f.paid : null });
    });
    /* sent and not published within two weeks: a follow-up, not a verdict */
    sent.filter(function (x) { return !x.published_at && now - ts(x.sent_at) > 14 * 86400000; }).forEach(function (x) {
      out.failed.push({ title: x.title, why: 'sent ' + Math.round((now - ts(x.sent_at)) / 86400000) + ' days ago and not published', fix: 'Ask ' + (x.publisher || 'the publisher') + ' whether it will run; archive it if not.' });
    });
    /* recurring gate failures on first drafts */
    var blockedOn = {};
    firstGate.forEach(function (x) { (x.first_gate_blocked || []).forEach(function (k) { blockedOn[k] = (blockedOn[k] || 0) + 1; }); });
    Object.keys(gf).forEach(function (k) { if (!blockedOn[k]) blockedOn[k] = gf[k]; });
    Object.keys(blockedOn).sort(function (a, b) { return blockedOn[b] - blockedOn[a]; }).forEach(function (k) {
      var lab = (GATE_CHECKS.filter(function (c) { return c.key === k; })[0] || {}).label || k;
      out.gate.push({ key: k, label: lab, count: blockedOn[k] });
    });
    /* AI: what was spent, what was kept */
    if (ai && isNum(ai.calls)) {
      out.ai = { calls: ai.calls, accepted: ai.accepted || 0, discarded: ai.discarded || 0, failed: ai.failed || 0, cache_hits: ai.cache_hits || 0, est_usd: ai.est_usd || 0, wasted_usd: ai.wasted_usd || 0 };
    }

    /* recommendations, each with its evidence */
    var rec = function (text, evidence) { out.recommendations.push({ text: text, evidence: evidence }); };
    if (!arts.length) rec('Nothing was written in this window. Run discovery and draft the top opportunity.', 'no articles in ' + (data && data.days) + ' days');
    if (firstGate.length && firstGate.length < SAMPLE.articles) out.too_early.push('First-pass rate: ' + firstGate.length + ' first draft(s) is too few to judge against the 90% target');
    else if (firstGate.length && passed.length / firstGate.length < 0.9) {
      var top = out.gate[0];
      rec('First drafts pass the gate ' + Math.round(100 * passed.length / firstGate.length) + '% of the time, under the 90% target' + (top ? '; the most common block is “' + top.label + '” (' + top.count + ')' : '') + '.',
        top && top.key === 'reliability' ? 'reliability blocks are unexplained market gaps: they need your review, not a rewrite' : 'fix the writer or the research for that check before adding volume');
    }
    if (out.ai && out.ai.calls >= SAMPLE.ai_calls && out.ai.accepted / out.ai.calls < 0.5)
      rec('Most AI rewrites were discarded (' + out.ai.accepted + ' kept of ' + out.ai.calls + ', $' + (+out.ai.wasted_usd).toFixed(2) + ' estimated on discarded or failed calls). Prefer section rewrites, or the deterministic draft alone.', 'AI ledger, last ' + (data && data.days) + ' days');
    else if (out.ai && out.ai.calls > 0 && out.ai.calls < SAMPLE.ai_calls) out.too_early.push('AI acceptance: ' + out.ai.calls + ' call(s) is too few to judge');
    if (sent.length && !pub.length) rec('Nothing sent in this window has been published yet. Confirm the publisher’s schedule before sending more.', sent.length + ' sent, 0 published');
    /* format comparison: only with enough articles AND enough traffic on both sides */
    var byFormat = {};
    pub.forEach(function (x) { (byFormat[x.format] = byFormat[x.format] || []).push(x); });
    var fmts = Object.keys(byFormat);
    if (!measured) out.too_early.push('Traffic: no first-party visit data for these articles yet (or the measurement is not installed)');
    else if (fmts.length >= 2) {
      var ready = fmts.filter(function (k) { return byFormat[k].length >= SAMPLE.articles && sum(byFormat[k], 'visits') >= SAMPLE.visits; });
      if (ready.length >= 2) {
        var rate = function (k) { return sum(byFormat[k], 'visits') / byFormat[k].length; };
        ready.sort(function (a, b) { return rate(b) - rate(a); });
        rec('“' + ((FORMATS[ready[0]] || {}).label || ready[0]) + '” articles bring the most visits per published article (' + Math.round(rate(ready[0])) + ' against ' + Math.round(rate(ready[ready.length - 1])) + ' for “' + ((FORMATS[ready[ready.length - 1]] || {}).label || ready[ready.length - 1]) + '”). Lean toward it.',
          ready.map(function (k) { return k + ': ' + byFormat[k].length + ' articles, ' + sum(byFormat[k], 'visits') + ' visits'; }).join('; '));
      } else out.too_early.push('Format comparison: needs ' + SAMPLE.articles + '+ published articles and ' + SAMPLE.visits + '+ visits in each format');
    }
    var v = sum(pub, 'visits'), su = sum(pub, 'signups');
    if (measured && v >= SAMPLE.visits && su / v < 0.02) rec('Visits are arriving but few sign up (' + su + ' of ' + v + '). Test the landing page the tagged links point to.', 'first-party, published articles in the window');
    else if (measured && v > 0 && v < SAMPLE.visits) out.too_early.push('Conversion: ' + v + ' visits is under the ' + SAMPLE.visits + ' needed to judge sign-up rate');
    return out;
  }
  function weeklyReviewText(r) {
    var L = ['EdgeDesk content engine — the last ' + r.days + ' days', '',
      'Articles: ' + r.counts.articles + ' written, ' + r.counts.sent + ' sent, ' + r.counts.published + ' published' + (r.counts.first_pass ? '; first drafts through the gate: ' + r.counts.first_pass : '') + '.'];
    if (r.worked.length) { L.push('', 'Published:'); r.worked.forEach(function (w) { L.push('- ' + w.title + ' (' + w.publisher + '): ' + (w.visits == null ? 'traffic not measured' : w.visits + ' visits, ' + (w.signups || 0) + ' sign-up' + (w.signups === 1 ? '' : 's') + ', ' + (w.paid || 0) + ' paid')); }); }
    if (r.failed.length) { L.push('', 'Needs follow-up:'); r.failed.forEach(function (f) { L.push('- ' + f.title + ': ' + f.why + '. ' + f.fix); }); }
    if (r.gate.length) { L.push('', 'Most common gate blocks:'); r.gate.slice(0, 5).forEach(function (g) { L.push('- ' + g.label + ': ' + g.count); }); }
    if (r.ai) L.push('', 'AI: ' + r.ai.calls + ' calls, ' + r.ai.accepted + ' kept, ' + r.ai.discarded + ' discarded, ' + r.ai.failed + ' failed, ' + r.ai.cache_hits + ' from cache; $' + (+r.ai.est_usd).toFixed(2) + ' estimated ($' + (+r.ai.wasted_usd).toFixed(2) + ' on discarded or failed calls).');
    if (r.recommendations.length) { L.push('', 'What to change:'); r.recommendations.forEach(function (x) { L.push('- ' + x.text + (x.evidence ? ' [' + x.evidence + ']' : '')); }); }
    if (r.too_early.length) { L.push('', 'Too early to say:'); r.too_early.forEach(function (x) { L.push('- ' + x); }); }
    return L.join('\n');
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
     AI — the drafting request and the reply. The CALL belongs to the host.
     ====================================================================== */
  /* a section rewrite returns ONE section, not the whole article (output tokens are the cost) */
  var AI_SECTION_SCHEMA = {
    type: 'object', additionalProperties: false, required: ['key', 'heading', 'body'],
    properties: { key: { type: 'string' }, heading: { type: 'string' }, body: { type: 'string' } }
  };
  var AI_MAX_TOKENS = { draft: 16000, section: 6000 };
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
    '7. Explain jargon in plain words. No generic filler ("delve into", "game-changer", "at the end of the day", "must-watch", "buckle up"), and never the same sentence twice.',
    '8. Projected scores, margins, totals and win chances: copy each game\'s display strings exactly. The two projected scores must differ by exactly the stated margin and add to exactly the stated total.',
    '9. A game\'s data_quality score measures how completely EdgeDesk knows its inputs. Call it "data quality", never "confidence", and never use it as a measure of who will win.',
    '10. Quarterbacks: write about a quarterback situation ONLY when that side\'s qb.material is true, using its label and source. A starter without an announcement is not news: never write that a quarterback is unconfirmed, uncertain or unsettled otherwise.',
    '11. Model–market gaps: explain them ONLY with the game\'s discrepancy fields (terms, market_implied, facts, explained_pct, unexplained_pct). Say plainly what is unexplained. Never invent a reason for a gap.',
    '12. Injuries, suspensions, postponements, venue or kickoff changes: only what the packet states, attributed to its source.',
    'FOOTBALL EVIDENCE — each game carries a "football" packet: claims (each with its source and verification), the explanation of EdgeDesk versus the line, and the game script. A projection is not evidence of its own explanation.',
    '13. Argue every featured game with football: cite at least two of its claims (five in a one-game article), including quarterback play for both teams, using the claim\'s own numbers in the same sentence as what they measure.',
    '14. Include the evidence AGAINST EdgeDesk\'s view (the "contradicting" claims) wherever the article mentions the line or the gap.',
    '15. If a game\'s status is UNEXPLAINED or input_suspect is true, say plainly that EdgeDesk cannot explain the gap and that it is not an edge. Never write a football reason for a gap the explanation does not give; never present a football stat as the model\'s reason (the model\'s reasons are its terms).',
    '16. State availability exactly as the claims do (probable is not confirmed; questionable is not out). Name the outlet of any claim whose verification is REPORTED, with its link. Put the year on anything historical.',
    '17. Never write "edge", "value", "mispriced", "sharp" or "the market is wrong" about a line. Use only the sources in the packet; do not add links.',
    'Formatting: section bodies are Markdown — paragraphs, "### " game headings inside the games section (keep each heading exactly as in the CURRENT DRAFT), "- " bullets, **bold**, [text](https://...) links. Do not write the disclaimer or the attribution footer; EdgeDesk adds both.'
  ].join('\n');

  function compactPacket(o) {
    /* what the writer may use: the research minus internal identifiers */
    return {
      league: o.league, season: o.season, week: o.week, kind: o.kind, as_of: o.research.as_of,
      context: Object.assign({}, o.research.context, { team_names: undefined }), conference: o.research.conference || null, conference_top: o.research.conference_top || null,
      focus: o.research.focus || null, news: o.research.news || [],
      games: (o.research.games || []).map(function (p, i, all) { return stripGame(p, all.length === 1); }), upsets: (o.research.upsets || []).map(function (p) { return stripGame(p, false); }), races: (o.research.races || []).map(function (p) { return stripGame(p, false); }),
      limitations: o.research.limitations || []
    };
  }
  function stripGame(p, single) {
    var c = Object.assign({}, p);
    delete c.flags; delete c.game_id;
    var F = fe();
    if (c.evidence && F) c.football = F.forWriter(single ? c.evidence : F.trim(c.evidence, { per: 4, pairs: 4 }));
    delete c.evidence;
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
      ? 'Rewrite ONLY the section with key "' + ctx.section + '". Return just that section as {key, heading, body}; every other section stays as it is in the CURRENT DRAFT.'
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
      max_tokens: ctx.section ? AI_MAX_TOKENS.section : AI_MAX_TOKENS.draft,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: ctx.section ? AI_SECTION_SCHEMA : AI_SCHEMA } },
      operation: ctx.section ? 'section' : 'draft', section: ctx.section || null
    };
  }
  /* the ledger's key for a request: the same model, prompt and draft is the same request */
  function requestKey(req, model) {
    return JSON.stringify({ model: model, system: req.system, messages: req.messages, max_tokens: req.max_tokens, output_config: req.output_config });
  }
  /* a conservative input-token estimate for the reservation (≈3 characters a token) */
  function inputEstimate(req) {
    var n = String(req.system || '').length + (req.messages || []).reduce(function (m, x) { return m + String(x.content || '').length; }, 0);
    return Math.ceil(n / 3) + 200;
  }
  /* Before any AI call: problems the AI cannot fix (the research is stale, a
     featured game kicked off, EdgeDesk's own figures disagree). Fixing these
     is a research refresh, not a rewrite — and costs nothing. */
  function aiPrecheck(a, o, now) {
    now = isNum(now) ? now : Date.now();
    var out = [];
    var asOf = ts(o.research && o.research.as_of);
    if (asOf != null && now - asOf > 36 * 3600000) out.push('the research is ' + Math.round((now - asOf) / 3600000) + ' hours old: refresh the opportunity first');
    var feat = featuredGames(a, o);
    feat.forEach(function (p) {
      var k = ts(p.kickoff);
      if (k != null && k <= now) out.push(p.away + ' at ' + p.home + ' has kicked off');
      if (p.model && p.model.numbers && !p.model.numbers.ok) out.push(p.away + ' at ' + p.home + ': EdgeDesk’s own figures disagree');
    });
    return out;
  }

  /* message: the Messages API reply. → { ok, article?, reason } */
  function parseReply(message, base) {
    if (!message) return { ok: false, reason: 'no_reply' };
    if (message.stop_reason === 'refusal') return { ok: false, reason: 'refusal' };
    if (message.stop_reason === 'max_tokens') return { ok: false, reason: 'max_tokens' };
    var text = (message.content || []).filter(function (b) { return b && b.type === 'text'; }).map(function (b) { return b.text; }).join('');
    var j;
    try { j = JSON.parse(text); } catch (e) { return { ok: false, reason: 'invalid_json' }; }
    /* a section rewrite: one section, merged into the current draft */
    if (j && typeof j.body === 'string' && typeof j.key === 'string' && !j.sections) {
      if (!base || !(base.sections || []).some(function (x) { return x.key === j.key; })) return { ok: false, reason: 'bad_section' };
      var merged = Object.assign({}, base, { sections: base.sections.map(function (x) { return x.key === j.key ? { key: x.key, heading: j.heading || x.heading, body: j.body.trim() } : x; }) });
      merged.word_count = wordCount(merged.standfirst + ' ' + merged.sections.map(function (x) { return x.body; }).join(' '));
      return { ok: true, article: merged, section: j.key };
    }
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
  /* At most two model calls per draft (each counted against the budget
     before it is made); a retry rewrites only the sections that failed. */
  var AI_MAX_ATTEMPTS = 2;
  /* which sections a failed report points at: the one section holding every
     failing game's capsule; null when any failure is article-wide */
  function affectedSections(report, article, o) {
    var fails = (report.checks || []).filter(function (c) { return c.status === 'fail'; });
    if (!fails.length) return [];
    var keys = [];
    for (var i = 0; i < fails.length; i++) {
      var f = fails[i];
      if (!f.game) return null;
      var p = ((o && o.research && o.research.games) || []).filter(function (g) { return String(g.game_id) === String(f.game); })[0];
      var hit = (article.sections || []).filter(function (s) { return p ? s.body.indexOf('### ') >= 0 && s.body.indexOf(p.away) >= 0 && s.body.indexOf(p.home) >= 0 : false; })[0];
      if (!hit) return null;
      if (keys.indexOf(hit.key) < 0) keys.push(hit.key);
    }
    return keys;
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
    news: { parseFeed: parseFeed, match: matchNews, classify: classifyNews },
    discover: discover, seoBrief: seoBrief, outline: outline, draft: draft,
    evidence: evidenceOf, validate: validate, similarity: similarity, teamsMentioned: teamsMentioned,
    campaignCode: campaignCode, tagLink: tagLink, attribution: attributionFor,
    toMarkdown: toMarkdown, toHtml: toHtml, mdToHtml: mdToHtml, seoSheet: seoSheet, toDocx: toDocx, DOCX_TYPE: DOCX_TYPE,
    weeklyReview: weeklyReview, weeklyReviewText: weeklyReviewText, SAMPLE: SAMPLE,
    firstParty: { KINDS: FP_KINDS, SLOTS: FP_SLOTS, DEFAULTS: FP_DEFAULTS, CTA: FP_CTA, TZ: FP_TZ, slot: fpSlot, build: fpBuild, gates: fpGates, record: fpRecord,
      ctDate: ctDate, ctWeekOf: ctWeekOf, ctParts: ctParts, ctInstant: ctInstant },
    gate: gate, repair: repair, sectionsToFix: sectionsToFix, GATE_CHECKS: GATE_CHECKS, DISCREPANCY: DISCREPANCY, WEATHER: WEATHER, NUM_TOL: NUM_TOL,
    reconcileScore: reconcileScore, qbState: qbState,
    ai: { requestKey: requestKey, inputEstimate: inputEstimate, precheck: aiPrecheck, MAX_TOKENS: AI_MAX_TOKENS, SECTION_SCHEMA: AI_SECTION_SCHEMA, SCHEMA: AI_SCHEMA, SYSTEM: AI_SYSTEM, buildRequest: buildRequest, parseReply: parseReply, objections: objections, MAX_ATTEMPTS: AI_MAX_ATTEMPTS, affectedSections: affectedSections },
    evidenceModule: function () { return fe(); }, SINGLE_GAME: SINGLE_GAME,
    util: { slugify: slugify, wordCount: wordCount, hash: hash, whenText: whenText, esc: esc, canTransition: function (from, to) { return (TRANSITIONS[from] || []).indexOf(to) >= 0; } }
  };
});
