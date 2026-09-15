/*__EDED_FEATURED_START__*/
/* ============================================================================
   THE FEATURED-GAME SELECTION ENGINE — which games earn editorial coverage.

   EdgeDesk prices every game on the board. It should not WRITE about every
   game on the board: a hundred and ninety articles a week is a content farm,
   and a content farm is the thing this product exists not to be. So this file
   answers one question — is this game worth a permanent research trail? — and
   answers it from data the repository actually holds.

   WHAT IT SCORES WITH, AND WHERE EACH INPUT COMES FROM

     schedule (VERIFIED)      kickoff day and time, postseason / championship
                              stage, neutral site, conference or division game.
                              nflverse `game_type`, cfbfastR `season_type` and
                              `notes`. These are facts on a public feed.
     slate (CALCULATED)       whether the game stands alone in its window —
                              computed from the rest of the slate, not asserted.
     edgedesk_model           each team's own EdgeDesk rank, and the size of the
                              gap between EdgeDesk's number and the market's.
     operator_curated         the rivalry list, and a manual FEATURE / UNFEATURE.

   WHAT IT DOES NOT SCORE WITH, and will not pretend to:
     · the broadcast network. No feed in this repository carries one, so no
       article says "on NBC". The KICKOFF WINDOW is a different thing — a
       Sunday 20:20 ET kickoff is a national window whoever is showing it —
       and that is derived from the timestamp, which is a fact.
     · a national poll. EdgeDesk's own rank is published as EdgeDesk's own
       rank, never as "the #4 team in the country".
     · public betting percentages, ticket counts or handle. Not held.

   EXTENSIBLE BY DESIGN. A sport is a row in SPORT_RULES: its windows, its
   stage detector, its weights. Adding basketball means adding a row, not
   editing the scorer.

   Loads in Node and in a browser, from ONE file, so the operator's console and
   the pipeline rank games identically.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDED = root.EDED || {};
  root.EDED.featured = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SCHEMA = 'edgedesk_featured_game_v1';

  /* Provenance tiers. Every component of a score says which one it came from,
     and the operator console shows it, because "this game scored 74" is not a
     reason and "74, of which 30 is a Monday-night kickoff on the schedule
     feed" is. */
  var TIER = {
    VERIFIED: 'VERIFIED_FACT',
    MODEL: 'EDGEDESK_MODEL',
    CALCULATED: 'CALCULATED_METRIC',
    CURATED: 'OPERATOR_CURATED'
  };

  function num(v) { if (v == null || v === '') return null; var n = +v; return isFinite(n) ? n : null; }
  function txt(v) { if (v == null) return null; var s = String(v).replace(/\s+/g, ' ').trim(); return s || null; }
  function clamp(n, lo, hi) { return n < lo ? lo : n > hi ? hi : n; }

  /* The same team-key rule the rest of the repository uses (settle_finals.js
     teamKey, engine normKey): fold accents rather than strip them, so
     "San José State" and "San Jose State" are one team. */
  function teamKey(s) {
    if (s == null) return '';
    var t = String(s).trim().toLowerCase();
    try { t = t.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (_) {}
    return t.replace(/[^a-z0-9]+/g, '');
  }

  /* ---------------------------------------------------------- the window */
  /* US Eastern time, without a timezone database: football schedules are
     published in ET and every kickoff this repository reads is an absolute
     instant, so the only thing needed is the ET offset on that instant.
     Intl gives it exactly, and falls back to a fixed -4/-5 by month if the
     runtime has no zone data at all — which is a stated approximation rather
     than a silent one, and only ever moves a kickoff by an hour. */
  function easternParts(ms) {
    var d = new Date(ms);
    try {
      var fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', weekday: 'short', hour: 'numeric',
        minute: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit'
      });
      var parts = {};
      fmt.formatToParts(d).forEach(function (p) { parts[p.type] = p.value; });
      var hour = +parts.hour;
      if (hour === 24) hour = 0;                       /* some ICU builds emit 24 */
      return { weekday: parts.weekday, hour: hour, minute: +parts.minute,
        date: parts.year + '-' + parts.month + '-' + parts.day, exact: true };
    } catch (_) {
      var m = d.getUTCMonth();
      var off = (m >= 2 && m <= 10) ? 4 : 5;           /* stated approximation */
      var e = new Date(ms - off * 3600000);
      var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      return { weekday: DAYS[e.getUTCDay()], hour: e.getUTCHours(), minute: e.getUTCMinutes(),
        date: e.toISOString().slice(0, 10), exact: false };
    }
  }

  /* A "national window" is a kickoff slot, not a broadcaster. Thursday,
     Sunday and Monday nights in the NFL are the league's own standalone
     windows and have been for decades; Friday and Saturday night in college
     is the equivalent. Each returns a LABEL, and the label is what an article
     is allowed to say. */
  function nflWindow(p) {
    var late = p.hour >= 19 || (p.hour === 18 && p.minute >= 30);
    if (p.weekday === 'Thu' && late) return { key: 'thursday_night', label: 'Thursday night', national: true };
    if (p.weekday === 'Sun' && (p.hour >= 19 || (p.hour === 18 && p.minute >= 45))) return { key: 'sunday_night', label: 'Sunday night', national: true };
    if (p.weekday === 'Mon' && late) return { key: 'monday_night', label: 'Monday night', national: true };
    if (p.weekday === 'Sat' && late) return { key: 'saturday_night', label: 'Saturday night', national: true };
    if (p.weekday === 'Fri' && late) return { key: 'friday_night', label: 'Friday night', national: true };
    if (p.weekday === 'Sun' && p.hour >= 15) return { key: 'sunday_late', label: 'Sunday late afternoon', national: false };
    if (p.weekday === 'Sun') return { key: 'sunday_early', label: 'Sunday afternoon', national: false };
    if (p.weekday === 'Thu' || p.weekday === 'Fri' || p.weekday === 'Sat' || p.weekday === 'Mon' || p.weekday === 'Tue' || p.weekday === 'Wed') {
      return { key: 'weekday', label: p.weekday + ' afternoon', national: false };
    }
    return { key: 'other', label: null, national: false };
  }
  function cfbWindow(p) {
    var late = p.hour >= 19 || (p.hour === 18 && p.minute >= 30);
    if (p.weekday === 'Sat' && late) return { key: 'saturday_night', label: 'Saturday night', national: true };
    if (p.weekday === 'Fri' && late) return { key: 'friday_night', label: 'Friday night', national: true };
    if (p.weekday === 'Thu' && late) return { key: 'thursday_night', label: 'Thursday night', national: true };
    if (p.weekday === 'Sat' && p.hour >= 15) return { key: 'saturday_afternoon', label: 'Saturday afternoon', national: false };
    if (p.weekday === 'Sat') return { key: 'saturday_early', label: 'Saturday morning', national: false };
    if (p.weekday === 'Mon' || p.weekday === 'Tue' || p.weekday === 'Wed') {
      /* a weeknight college game in December or January is a bowl */
      return { key: 'weeknight', label: p.weekday + ' night', national: late };
    }
    return { key: 'other', label: null, national: false };
  }

  /* --------------------------------------------------------------- stage */
  /* The part of the season the game belongs to, off the feed's OWN field.
     nflverse `game_type` is authoritative. cfbfastR `season_type` plus the
     `notes` column (which carries "SEC Championship", "CFP Semifinal",
     "Cotton Bowl") is the college equivalent. Nothing is inferred from a
     week number, because Week 0, a Tuesday game in November and a playoff
     round are all week numbers too. */
  var NFL_STAGE = {
    SB: { key: 'super_bowl', label: 'Super Bowl', points: 40, playoff: true, championship: true },
    CON: { key: 'conference_championship', label: 'Conference championship', points: 34, playoff: true, championship: true },
    DIV: { key: 'divisional', label: 'Divisional round', points: 30, playoff: true, championship: false },
    WC: { key: 'wild_card', label: 'Wild card round', points: 28, playoff: true, championship: false },
    REG: { key: 'regular', label: null, points: 0, playoff: false, championship: false },
    PRE: { key: 'preseason', label: 'Preseason', points: -40, playoff: false, championship: false }
  };
  function nflStage(entry) {
    return NFL_STAGE[String(entry.game_type || 'REG').toUpperCase()] || NFL_STAGE.REG;
  }
  function cfbStage(entry) {
    var notes = String(entry.notes || '');
    var post = /post/i.test(String(entry.season_type || ''));
    if (/national\s+championship/i.test(notes)) return { key: 'national_championship', label: 'National Championship', points: 40, playoff: true, championship: true };
    if (/(cfp|college football playoff)/i.test(notes)) return { key: 'playoff', label: 'College Football Playoff', points: 34, playoff: true, championship: false };
    if (/championship/i.test(notes)) return { key: 'conference_championship', label: 'Conference championship', points: 30, playoff: false, championship: true };
    if (/\bbowl\b/i.test(notes)) return { key: 'bowl', label: 'Bowl game', points: 14, playoff: false, championship: false };
    if (post) return { key: 'postseason', label: 'Postseason', points: 16, playoff: false, championship: false };
    return { key: 'regular', label: null, points: 0, playoff: false, championship: false };
  }

  /* ---------------------------------------------------------- sport rules */
  /* ADD A SPORT BY ADDING A ROW. Nothing below this object knows the name of
     a league. `rank_pool` is how many teams the sport's own EdgeDesk rating
     ranks, so "top 25 of 136" and "top 8 of 32" are the same idea. */
  var SPORT_RULES = {
    NFL: {
      label: 'NFL',
      windowFor: nflWindow,
      stageFor: nflStage,
      rank_pool: 32,
      /* the NFL model's overall team-strength row in the compare payload */
      overall_cat: 'net_epa',
      /* a professional league has no unranked tier: "elite" is the top quarter */
      rank_elite: 8, rank_good: 16,
      standalone_minutes: 150,
      /* an intra-division game is a standings game, every year, both leagues */
      familiarity_key: 'division_game',
      familiarity_label: 'Division game',
      familiarity_points: 6,
      /* below this a game is simply not worth a permanent research trail */
      threshold: 45
    },
    CFB: {
      label: 'College Football',
      windowFor: cfbWindow,
      stageFor: cfbStage,
      rank_pool: 136,
      overall_cat: 'overall',
      rank_elite: 10, rank_good: 25,
      standalone_minutes: 90,
      familiarity_key: 'conference_game',
      familiarity_label: 'Conference game',
      familiarity_points: 5,
      threshold: 45
    }
  };
  function rulesFor(sport) { return SPORT_RULES[String(sport || '').toUpperCase()] || null; }

  /* ------------------------------------------------------ the components */
  function comp(key, label, points, tier, detail) {
    return { key: key, label: label, points: Math.round(points * 10) / 10, tier: tier, detail: detail || null };
  }

  /* Rank of each team, from EdgeDesk's OWN ratings. Two doors, because the
     two sports publish a rank in two different places: the CFB rankings
     artifact carries `teams.<key>.rank`, and the NFL model publishes its rank
     inside the research payload's compare block. Both are EdgeDesk's, and the
     article says so; neither is a poll. */
  function ranksFor(entry, ctx) {
    var R = rulesFor(entry.sport);
    /* THE POOL IS WHATEVER THE RANKING ACTUALLY RANKED. `rank_pool: 136` was a
       constant, and the rankings build ranks only the teams its confidence gate
       clears — 68 of 138 in the current artifact — so the card said "#15 of
       136" about a rank that was #15 of 68. The constant stays as a last
       resort and the artifact's own count wins. */
    var out = { home: null, away: null, pool: R ? R.rank_pool : null, pool_source: 'sport rule constant', source: null };
    if (ctx && ctx.rank_pool != null) { out.pool = num(ctx.rank_pool); out.pool_source = 'the rankings artifact\u2019s own ranked count'; }
    var research = ctx && ctx.research && ctx.research[entry.sport + ':' + entry.game_id];
    if (research && research.compare && research.compare.groups) {
      var row = null;
      research.compare.groups.forEach(function (g) {
        (g.rows || []).forEach(function (r) { if (!row && r && r.cat === (R && R.overall_cat)) row = r; });
      });
      if (row) {
        out.away = num(row.a && row.a.rank_n);
        out.home = num(row.h && row.h.rank_n);
        if (out.home != null || out.away != null) out.source = 'edgedesk research payload';
      }
    }
    if ((out.home == null || out.away == null) && ctx && ctx.ranks) {
      var h = ctx.ranks[teamKey(entry.home)], a = ctx.ranks[teamKey(entry.away)];
      if (out.home == null && h != null) out.home = num(h);
      if (out.away == null && a != null) out.away = num(a);
      if (out.source == null && (out.home != null || out.away != null)) out.source = 'edgedesk rankings build';
    }
    return out;
  }

  /* How far EdgeDesk's own number sits from the market's, in points. Read off
     the research payload's market block, which is where the module itself put
     it; nothing here re-derives it from a price. */
  function disagreementFor(entry, ctx) {
    var research = ctx && ctx.research && ctx.research[entry.sport + ':' + entry.game_id];
    var m = research && research.market;
    var card = ctx && ctx.cards && ctx.cards[entry.sport + ':' + entry.game_id];
    if (!m || !m.available) return { points: null, text: null, available: false,
      stale: null, coverage: card ? num(card.input_coverage) : null };
    var d = num(String(m.difference || '').replace(/[^0-9.]/g, ''));
    return { points: d, text: txt(m.difference), available: d != null,
      model: txt(m.model), market: txt(m.market), book: txt(m.book),
      classification: txt(m.classification),
      /* THE EVIDENCE AROUND THE GAP, which is what decides whether it is worth
         a research trail. A stale price and a half-empty input contract make a
         large number a reason to doubt the model, not a reason to look. */
      /* THREE STATES, NOT TWO. `m.stale === true` collapsed "we know it is
         fresh" and "we do not know" into the same `false`, which then read as
         evidence that the price was current. Unknown stays null. */
      stale: m.stale === true ? true : (m.stale === false ? false : null),
      capture_age: txt(m.capture_age),
      coverage: card ? num(card.input_coverage) : null,
      starters_resolved: card
        ? !!(card.home_starter && card.home_starter.player_id && card.away_starter && card.away_starter.player_id)
        : null };
  }

  /* Does this game stand alone in its window? Computed from the slate, so it
     is a measurement of the schedule rather than a claim about television. */
  function standaloneFor(entry, slate, minutes) {
    if (!slate || !slate.length) return { standalone: false, neighbours: null };
    var t = num(entry.kickoff_ms) != null ? num(entry.kickoff_ms) : Date.parse(entry.kickoff);
    if (!isFinite(t)) return { standalone: false, neighbours: null };
    var span = (minutes || 120) * 60000;
    var n = 0;
    slate.forEach(function (g) {
      if (!g || g.sport !== entry.sport) return;
      if (String(g.game_id) === String(entry.game_id)) return;
      var gt = num(g.kickoff_ms) != null ? num(g.kickoff_ms) : Date.parse(g.kickoff);
      if (isFinite(gt) && Math.abs(gt - t) <= span) n++;
    });
    return { standalone: n === 0, neighbours: n };
  }

  /* The rivalry list is OPERATOR-CURATED and labelled as such everywhere it
     appears. It is not a model output and not a feed: it is a short list of
     fixtures that have their own name, maintained by hand, and an article
     that leans on it says "a long-standing rivalry" rather than inventing a
     history it cannot source. */
  function rivalryFor(entry, rivalries) {
    if (!rivalries || !rivalries.length) return null;
    var h = teamKey(entry.home), a = teamKey(entry.away);
    for (var i = 0; i < rivalries.length; i++) {
      var r = rivalries[i];
      if (!r) continue;
      var ka = teamKey(r.a || r[0]), kb = teamKey(r.b || r[1]);
      if ((ka === h && kb === a) || (ka === a && kb === h)) {
        return { label: txt(r.label || r[2]) || 'a long-standing rivalry',
          sport: txt(r.sport) || entry.sport, source: 'operator-curated rivalry list' };
      }
    }
    return null;
  }

  /* ------------------------------------------------------------ the score */
  /* editorial_priority, 0-100, itemised. The weights are deliberately blunt
     and deliberately visible: an operator who disagrees with the ranking
     should be able to read WHY in one screen and change one number. */
  /* THE KICKOFF, IN EASTERN, FROM THE MOST AUTHORITATIVE THING AVAILABLE.

     nflverse publishes the Eastern weekday and wall clock as their own
     columns, and they are exact. The board's own `kickoff_ms` is a parse of
     "gameday T gametime" with no timezone, so on a UTC runner a 20:15 Eastern
     kickoff becomes 20:15 UTC and Monday Night Football reads as a Monday
     afternoon game — which is how the first run of this scorer classified
     every NFL prime-time window wrongly. cfbfastR's `start_date` carries a
     real zone, so there the timestamp is the authority.

     So: the feed's own Eastern columns first, the timestamp second, and the
     row says which was used. */
  function easternFor(entry) {
    var wd = txt(entry.weekday), gt = txt(entry.gametime_et);
    if (wd && gt && /^\d{1,2}:\d{2}$/.test(gt)) {
      var hm = gt.split(':');
      return { weekday: wd.slice(0, 3), hour: +hm[0], minute: +hm[1],
        date: txt(entry.gameday), exact: true, source: 'the schedule feed’s own Eastern columns' };
    }
    var t = num(entry.kickoff_ms) != null ? num(entry.kickoff_ms) : Date.parse(entry.kickoff);
    var p = easternParts(isFinite(t) ? t : Date.now());
    p.source = 'converted from the kickoff timestamp';
    return p;
  }

  function priorityFor(entry, ctx) {
    ctx = ctx || {};
    var R = rulesFor(entry.sport);
    if (!R) {
      return { score: 0, components: [], flags: {},
        unsupported: 'no editorial rules are defined for sport ' + entry.sport };
    }
    var parts = easternFor(entry);
    var win = R.windowFor(parts);
    var stage = R.stageFor(entry);
    var ranks = ranksFor(entry, ctx);
    var dis = disagreementFor(entry, ctx);
    var alone = standaloneFor(entry, ctx.slate, R.standalone_minutes);
    var riv = rivalryFor(entry, ctx.rivalries);

    var components = [];

    /* 1 — the window. A standalone national kickoff is the single strongest
           signal that a game matters to more than two fanbases. */
    if (win.national) {
      components.push(comp('national_window', win.label + ' kickoff', 22, TIER.VERIFIED,
        'kickoff ' + String(parts.hour).padStart(2, '0') + ':' + String(parts.minute).padStart(2, '0')
        + ' ET on ' + parts.weekday + ' — ' + (parts.source || 'derived')));
    } else if (win.label) {
      components.push(comp('window', win.label + ' kickoff', 0, TIER.VERIFIED, null));
    }
    /* 2 — standing alone in the window */
    if (alone.standalone && win.national) {
      components.push(comp('standalone', 'The only game in its window', 12, TIER.CALCULATED,
        'no other ' + entry.sport + ' game on the slate kicks off within ' + R.standalone_minutes + ' minutes'));
    } else if (alone.neighbours != null && alone.neighbours <= 2 && win.national) {
      components.push(comp('near_standalone', 'One of ' + (alone.neighbours + 1) + ' games in its window', 5, TIER.CALCULATED, null));
    }
    /* 3 — the stage */
    if (stage.points) {
      components.push(comp('stage', stage.label || stage.key, stage.points, TIER.VERIFIED,
        entry.sport === 'NFL' ? 'nflverse game_type ' + entry.game_type
          : 'cfbfastR season_type/notes: ' + (txt(entry.notes) || txt(entry.season_type) || 'postseason')));
    }
    /* 4 — how good both teams are, by EdgeDesk's own rating */
    if (ranks.home != null && ranks.away != null) {
      var best = Math.min(ranks.home, ranks.away), worst = Math.max(ranks.home, ranks.away);
      var pts = 0, label = null;
      if (worst <= R.rank_elite) { pts = 30; label = 'Both teams inside EdgeDesk’s top ' + R.rank_elite; }
      else if (worst <= R.rank_good) { pts = 22; label = 'Both teams inside EdgeDesk’s top ' + R.rank_good; }
      else if (best <= R.rank_elite) { pts = 12; label = 'One team inside EdgeDesk’s top ' + R.rank_elite; }
      else if (best <= R.rank_good) { pts = 6; label = 'One team inside EdgeDesk’s top ' + R.rank_good; }
      if (pts) {
        components.push(comp('ranking_weight', label, pts, TIER.MODEL,
          'EdgeDesk rank — ' + entry.away + ' #' + ranks.away + ', ' + entry.home + ' #' + ranks.home
          + ' of ' + (ranks.pool != null ? ranks.pool : R.rank_pool)
          + ' (' + (ranks.pool_source || 'sport rule constant') + '). EdgeDesk’s own rating, not a poll.'));
      }
    } else {
      components.push(comp('ranking_weight', 'Team ranks not available for both sides', 0, TIER.MODEL,
        'no editorial credit is given for a rank EdgeDesk could not read'));
    }
    /* 5 — rivalry */
    if (riv) {
      components.push(comp('rivalry', 'Rivalry: ' + riv.label, 16, TIER.CURATED, riv.source));
    }
    /* 6 — conference / division */
    if (entry[R.familiarity_key]) {
      components.push(comp('familiarity', R.familiarity_label, R.familiarity_points, TIER.VERIFIED, null));
    }
    /* 7 — where EdgeDesk and the market disagree. THE ONE COMPONENT THAT IS
           ABOUT THE RESEARCH rather than about the occasion, and the reason a
           quiet Week 3 game can still earn a trail. */
    if (dis.available && dis.points != null) {
      /* THE RULE THIS COMPONENT USED TO BREAK.

         It was `clamp(points * 3.2, 0, 24)`: the size of the gap, and nothing
         else, was the single largest thing in the whole score. A twelve-point
         disagreement earned a permanent research trail whether the price was
         two days old, whether the model had half its inputs, and whether there
         was any football reason to think the market was wrong — and "the gap
         is enormous" reads to a reader as "the opportunity is enormous", which
         is the one inference this platform must never invite.

         So the gap no longer earns anything on its own. It earns attention in
         PROPORTION TO THE EVIDENCE AROUND IT: a current price, an input
         contract that is actually filled, and two resolved quarterbacks. With
         none of those the component is worth nothing however big the number
         is, and a gap past the band the model has never been right by out of
         sample is capped hard and labelled as a fault to investigate. */
      var evidence = 0, notes = [];
      if (dis.stale === false) { evidence += 0.4; notes.push('the price is current'); }
      else if (dis.stale === true) notes.push('the price is stale, so the gap may be against a number that no longer exists');
      if (dis.coverage != null && dis.coverage >= 0.6) { evidence += 0.35; notes.push('the input contract is ' + Math.round(dis.coverage * 100) + '% filled'); }
      else if (dis.coverage != null) notes.push('the input contract is only ' + Math.round(dis.coverage * 100) + '% filled, so part of the gap is absence of information');
      if (dis.starters_resolved === true) { evidence += 0.25; notes.push('both starting quarterbacks are resolved'); }
      else if (dis.starters_resolved === false) notes.push('at least one starting quarterback is unresolved');
      /* NOTHING KNOWN EITHER WAY. The gap is not credited for being large; it
         is discounted to a floor so a disagreement on a board that publishes
         no input contract can still be noticed without becoming the dominant
         term in the score. */
      if (dis.coverage == null && dis.stale == null) { evidence = 0.3; notes.push('no input-contract or freshness evidence reached this scorer, so the gap is held to a floor rather than credited'); }

      var sized = clamp(dis.points * 3.2, 0, 24);
      var dpts = Math.round(sized * evidence * 10) / 10;
      var fault = dis.points >= 12;
      if (fault) { dpts = Math.min(dpts, 8); notes.push('a gap this large is outside anything this model has been right by out of sample and is treated as a fault to investigate, not an opportunity to rank'); }
      components.push(comp('model_disagreement',
        'EdgeDesk differs from the market by ' + dis.text, dpts, TIER.MODEL,
        (dis.model || '') + ' against ' + (dis.market || '') + (dis.book ? ' at ' + dis.book : '')
        + (dis.classification ? ' — ' + dis.classification : '')
        + ' · the gap earns ' + dpts + ' of a possible ' + Math.round(sized * 10) / 10
        + ' because ' + (notes.length ? notes.join('; ') : 'nothing supports investigating it')
        + '. A gap alone orders no research and implies no expected value.'));
    } else {
      components.push(comp('model_disagreement', 'No captured market number to disagree with', 0, TIER.MODEL,
        'the game is scored on its occasion alone'));
    }
    /* 8 — neutral site, which in football almost always means an event */
    if (entry.neutral_site && stage.key === 'regular') {
      components.push(comp('neutral_site', 'Neutral-site game', 6, TIER.VERIFIED, null));
    }

    var raw = components.reduce(function (s, c) { return s + c.points; }, 0);
    var score = clamp(Math.round(raw * 10) / 10, 0, 100);

    return {
      score: score,
      components: components,
      window: win,
      window_label: win.label,
      national_window: !!win.national,
      standalone: !!alone.standalone,
      stage: stage,
      ranks: ranks,
      rivalry: riv,
      disagreement: dis,
      kickoff_et: parts,
      flags: {
        playoff: !!stage.playoff,
        championship: !!stage.championship,
        rivalry: !!riv,
        national_window: !!win.national,
        ranked_matchup: ranks.home != null && ranks.away != null
          && Math.max(ranks.home, ranks.away) <= R.rank_good
      }
    };
  }

  /* ------------------------------------------------------------- the row */
  /* One persistent row per game. `auto_selected` is what the scorer decided;
     `manual_override` is what an operator decided; `status` is the result of
     the two, and the operator always wins. Nothing else in the system reads
     the score directly — it reads `status`. */
  /* THE NAMES A HEADLINE IS MADE OF. The NFL board keys its slate on team
     CODES — "BUF at HOU" — and the display names live in the research payload
     the terminal builds. article_model.gameMetaFrom() already reads them from
     there for exactly this reason, and so does this. With no payload the code
     is kept and said to be a code, rather than guessed at from a table
     maintained here. */
  function namesFor(entry, ctx) {
    var r = ctx && ctx.research && ctx.research[entry.sport + ':' + entry.game_id];
    var g = (r && r.game) || {};
    return { home: txt(g.home) || txt(entry.home), away: txt(g.away) || txt(entry.away),
      from_payload: !!(g.home && g.away) };
  }

  function rowFor(entry, ctx, opts) {
    opts = opts || {};
    var R = rulesFor(entry.sport);
    var names = namesFor(entry, ctx);
    var p = priorityFor(Object.assign({}, entry, { home: names.home, away: names.away }), ctx);
    var threshold = num(opts.threshold) != null ? num(opts.threshold)
      : (R ? R.threshold : 45);
    var auto = p.score >= threshold;
    var now = opts.now ? new Date(opts.now).toISOString() : new Date().toISOString();
    return {
      schema: SCHEMA,
      key: entry.sport + ':' + entry.game_id,
      game_id: String(entry.game_id),
      sport: String(entry.sport).toUpperCase(),
      season: num(entry.season),
      week: num(entry.week),
      away_team: names.away,
      home_team: names.home,
      /* the board's own keys, kept because the settlement record and the
         provider joins are written in them */
      away_code: txt(entry.away), home_code: txt(entry.home),
      names_from_payload: names.from_payload,
      game_time: txt(entry.kickoff),
      kickoff_et: p.kickoff_et ? (p.kickoff_et.weekday + ' ' + String(p.kickoff_et.hour).padStart(2, '0')
        + ':' + String(p.kickoff_et.minute).padStart(2, '0') + ' ET') : null,
      kickoff_et_source: p.kickoff_et && p.kickoff_et.source,
      espn_id: txt(entry.espn_id),
      nflverse_spread_line: num(entry.nflverse_spread_line),
      nflverse_total_line: num(entry.nflverse_total_line),
      venue: txt(entry.venue),
      neutral_site: !!entry.neutral_site,
      /* NO BROADCASTER IS EVER STORED. No feed here carries one, and a null
         that a later reader could mistake for "unknown but knowable" is worse
         than a field that says why it is empty. */
      network: null,
      network_note: 'EdgeDesk holds no broadcast-rights feed. The kickoff window below is derived from the schedule timestamp and is not a claim about which network is showing the game.',
      national_window: !!p.national_window,
      window_key: p.window && p.window.key,
      window_label: p.window_label,
      standalone_window: !!p.standalone,
      stage: p.stage && p.stage.key,
      stage_label: p.stage && p.stage.label,
      playoff_flag: !!(p.flags && p.flags.playoff),
      championship_flag: !!(p.flags && p.flags.championship),
      rivalry_flag: !!(p.flags && p.flags.rivalry),
      rivalry_label: p.rivalry && p.rivalry.label,
      ranking_weight: (p.ranks && p.ranks.home != null && p.ranks.away != null)
        ? Math.max(p.ranks.home, p.ranks.away) : null,
      home_rank: p.ranks && p.ranks.home,
      away_rank: p.ranks && p.ranks.away,
      rank_pool: p.ranks && p.ranks.pool,
      rank_pool_source: p.ranks && p.ranks.pool_source,
      model_disagreement: p.disagreement && p.disagreement.points,
      model_disagreement_text: p.disagreement && p.disagreement.text,
      editorial_priority: p.score,
      priority_components: p.components,
      priority_threshold: threshold,
      auto_selected: auto,
      manual_override: null,          /* 'feature' | 'unfeature' | null */
      pregame_enabled: true,
      postgame_enabled: true,
      status: auto ? 'featured' : 'considered',
      scored_at: now,
      created_at: now,
      updated_at: now
    };
  }

  /* An operator's decision, applied to a freshly scored row. The override and
     the two enable switches SURVIVE a rescore — that is the whole point of a
     persistent table — so this is the only function that may move them. */
  function applyOverride(row, prior) {
    if (!prior) return row;
    var next = Object.assign({}, row);
    next.created_at = prior.created_at || row.created_at;
    next.manual_override = prior.manual_override || null;
    if (prior.pregame_enabled === false) next.pregame_enabled = false;
    if (prior.postgame_enabled === false) next.postgame_enabled = false;
    if (prior.operator_note) next.operator_note = prior.operator_note;
    if (prior.overridden_at) next.overridden_at = prior.overridden_at;
    if (prior.overridden_by) next.overridden_by = prior.overridden_by;
    next.status = statusFor(next);
    /* a row whose score and decision are unchanged keeps its updated_at, so a
       rescore that found nothing new is not a commit claiming it did */
    if (prior.editorial_priority === next.editorial_priority
      && prior.status === next.status
      && JSON.stringify(prior.priority_components || null) === JSON.stringify(next.priority_components || null)) {
      next.updated_at = prior.updated_at || next.updated_at;
    }
    return next;
  }
  function statusFor(row) {
    if (row.manual_override === 'unfeature') return 'excluded';
    if (row.manual_override === 'feature') return 'featured';
    return row.auto_selected ? 'featured' : 'considered';
  }
  function isFeatured(row) { return !!row && statusFor(row) === 'featured'; }

  /* -------------------------------------------------- the editorial decision */
  /* A FLOOR AND A WEEKLY CAP, not a threshold alone.

     A threshold on its own is the wrong instrument, and running it proved it:
     set high enough that a quiet Tuesday produces nothing, it also produces
     nothing on a Saturday with four ranked matchups on it, because scores
     move with the slate. Set low enough to catch the Saturday, it writes
     forty articles in December.

     A real desk does not work that way. It says: this week we run four NFL
     features and six college ones, and they are the best four and six. So the
     floor removes the games that are not worth a permanent trail at all, and
     the cap takes the top N per sport per week from what is left. Both are
     settings; neither is in the code path.

     An operator FEATURE is not subject to either. */
  function applyEditorialSelection(rows, opts) {
    opts = opts || {};
    var caps = opts.caps || {};
    var floors = opts.thresholds || {};
    var bucket = Object.create(null);
    rows.forEach(function (r) {
      var k = r.sport + ':' + (r.season || '?') + ':' + (r.week == null ? '?' : r.week);
      (bucket[k] = bucket[k] || []).push(r);
    });
    Object.keys(bucket).forEach(function (k) {
      var group = bucket[k].slice().sort(function (a, b) { return b.editorial_priority - a.editorial_priority; });
      var sport = group[0].sport;
      var floor = floors[sport] != null ? floors[sport] : 35;
      var cap = caps[sport] != null ? caps[sport] : 5;
      var taken = 0;
      group.forEach(function (r) {
        var overFloor = r.editorial_priority >= floor;
        /* a playoff or championship game is never crowded out by a cap: it is
           the reason the cap exists to be spent on something */
        var mandatory = !!(r.playoff_flag || r.championship_flag);
        r.priority_floor = floor;
        r.weekly_cap = cap;
        if (!overFloor) {
          r.auto_selected = false;
          r.selection_note = 'below the editorial floor of ' + floor + ' for ' + sport;
        } else if (mandatory || taken < cap) {
          r.auto_selected = true;
          taken += mandatory ? 0 : 1;
          r.selection_note = mandatory
            ? 'a postseason game is covered whatever the weekly cap'
            : 'inside the top ' + cap + ' for ' + sport + ' in this week';
        } else {
          r.auto_selected = false;
          r.selection_note = 'over the floor but outside the top ' + cap + ' for ' + sport
            + ' in this week — an operator can still FEATURE it';
        }
        r.status = statusFor(r);
      });
    });
    return rows;
  }

  /* Score a whole slate, merge with what is already stored, apply the
     editorial selection, and hand back EVERY row — featured or not — because
     the operator console needs the near misses to judge the dials. */
  function scoreSlate(slate, ctx, opts) {
    opts = opts || {};
    var prior = Object.create(null);
    (opts.prior || []).forEach(function (r) { if (r && r.key) prior[r.key] = r; });
    var full = { slate: slate, ranks: (ctx && ctx.ranks) || null,
      rivalries: (ctx && ctx.rivalries) || null, research: (ctx && ctx.research) || null };
    var rows = slate.map(function (entry) {
      if (!rulesFor(entry.sport)) return null;
      var row = rowFor(entry, full, { now: opts.now, threshold: opts.thresholds && opts.thresholds[entry.sport] });
      return applyOverride(row, prior[row.key]);
    }).filter(Boolean);
    applyEditorialSelection(rows, { caps: opts.caps, thresholds: opts.thresholds });
    /* the override is re-applied AFTER selection, because an operator's
       decision outranks a cap as well as a floor */
    rows.forEach(function (r) { r.status = statusFor(r); });
    return rows.sort(function (a, b) {
      if (b.editorial_priority !== a.editorial_priority) return b.editorial_priority - a.editorial_priority;
      return String(a.game_time).localeCompare(String(b.game_time));
    });
  }

  return {
    SCHEMA: SCHEMA, TIER: TIER, SPORT_RULES: SPORT_RULES, NFL_STAGE: NFL_STAGE,
    teamKey: teamKey, easternParts: easternParts,
    nflWindow: nflWindow, cfbWindow: cfbWindow, nflStage: nflStage, cfbStage: cfbStage,
    easternFor: easternFor, namesFor: namesFor,
    rulesFor: rulesFor, ranksFor: ranksFor, disagreementFor: disagreementFor,
    standaloneFor: standaloneFor, rivalryFor: rivalryFor,
    priorityFor: priorityFor, rowFor: rowFor, applyOverride: applyOverride,
    statusFor: statusFor, isFeatured: isFeatured, scoreSlate: scoreSlate,
    applyEditorialSelection: applyEditorialSelection
  };
});
/*__EDED_FEATURED_END__*/
