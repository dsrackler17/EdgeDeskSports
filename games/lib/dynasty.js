/* ===========================================================================
   EdgeDesk Dynasty — the progression rules.

   THIS FILE AWARDS NOTHING. It is a set of pure functions that READ the
   anonymous envelope games/lib/store.js keeps and derive from it:

       XP            a sum over the ledger of real things the player did
       level         a published curve over XP
       title         Rookie Analyst -> Scout -> Coordinator -> Director -> GM
       stage         what the War Room looks like at this level
       missions      five real football tasks per football week
       achievements  earned from the record, never granted

   Because everything is DERIVED from the record rather than accumulated in a
   counter, there is nothing to farm: a Price It counts once per matchup, a
   research open once per game, a daily drill once per day, a group once ever.
   Reload the page a thousand times and the ledger is the same ledger.

   Every rule here is published in games/README.md and versioned. If a number
   ever changes, DYNASTY_VERSION changes with it, and the README says what the
   old rule was — a player's history is never quietly rewritten.

   WHAT XP IS NOT. It is not a betting skill rating, and it never becomes an
   input to any price. Higher levels change what the War Room looks like and
   what the profile can show; they never make EdgeDesk's number better or a
   score easier. A subscriber earns exactly the same XP as anyone else.
   =========================================================================== */
(function (root) {
  'use strict';

  var DYNASTY_VERSION = 'dynasty_v1';
  var W = root.EDGamesWeek || (typeof require === 'function' ? require('./week.js') : null);

  /* ── the XP table ──────────────────────────────────────────────────────── */
  var XP = {
    price_it: 50,        /* one completed Price It, once per matchup */
    pick5_card: 75,      /* one submitted Pick 5 card, once per week */
    pick5_correct: 10,   /* each correct side, as the games settle */
    drill_daily: 40,     /* the day's Two-Minute Drill, once per day */
    h2h_locked: 40,      /* a Head-to-Head where both players locked, per challenge */
    h2h_win: 20,         /* a settled Head-to-Head win, per challenge */
    research_open: 15,   /* the research for a matchup opened — per unique game,
                            at most RESEARCH_CAP_PER_WEEK games per football week */
    group_create: 100,   /* the first group ever created */
    group_join: 50,      /* the first group ever joined */
    week_return: 25,     /* coming back for a football week after playing an earlier one */
    mission_set: 150     /* all five weekly missions in one week */
  };
  var RESEARCH_CAP_PER_WEEK = 10;

  /* ── the level curve ─────────────────────────────────────────────────────
     XP needed to REACH level L, cumulative:

         xpForLevel(L) = 25 × (L − 1) × (L + 2)

     which is the same as saying each level costs 50 more XP than the last:
     100 to reach level 2, then 150, then 200, then 250 …

         L 2      100        L 10    2,700        L 20   10,450
         L 5      700        L 15    5,950        L 30   23,200

     Capped at MAX_LEVEL. XP keeps counting past it; the level does not. */
  var MAX_LEVEL = 30;
  function xpForLevel(L) {
    L = Math.max(1, Math.min(MAX_LEVEL, L | 0));
    return 25 * (L - 1) * (L + 2);
  }
  function levelFor(xp) {
    xp = Math.max(0, +xp || 0);
    var L = 1;
    while (L < MAX_LEVEL && xp >= xpForLevel(L + 1)) L++;
    return L;
  }

  /* ── titles and stages ───────────────────────────────────────────────────
     A title is what the player is called; a stage is what the War Room looks
     like. Every level that changes the room (5, 10, 15, 20) changes the name
     too, so that moment reads as one event; the level-25 title is a name
     only — the room is already the whole wall. */
  var TITLES = [
    { level: 1,  title: 'Rookie Analyst' },
    { level: 5,  title: 'Scout' },
    { level: 10, title: 'Coordinator' },
    { level: 15, title: 'Director' },
    { level: 20, title: 'General Manager' },
    { level: 25, title: 'President of Football Operations' }
  ];
  var STAGES = [
    { level: 1,  key: 'garage',   name: 'The Garage',
      blurb: 'One desk, one monitor, a whiteboard and a season to prove something.' },
    { level: 5,  key: 'film',     name: 'The Film Room',
      blurb: 'A second screen, a projector and a wall of matchups you have actually studied.' },
    { level: 10, key: 'lab',      name: 'The Analytics Lab',
      blurb: 'Three monitors, a ratings board and the market ticker running all week.' },
    { level: 15, key: 'ops',      name: 'Football Operations',
      blurb: 'A full room: film, roster, market and research stations under one roof.' },
    { level: 20, key: 'command',  name: 'Market Command',
      blurb: 'The wall of screens. Every game, every number, every disagreement, live.' }
  ];
  function tierFor(list, level) {
    var cur = list[0], i;
    for (i = 0; i < list.length; i++) if (level >= list[i].level) cur = list[i];
    return cur;
  }
  function titleFor(level) { return tierFor(TITLES, level).title; }
  function stageFor(level) { return tierFor(STAGES, level); }
  function nextStage(level) {
    var i; for (i = 0; i < STAGES.length; i++) if (STAGES[i].level > level) return STAGES[i];
    return null;
  }

  /* ── reading the envelope ────────────────────────────────────────────────
     Small tolerant accessors: an envelope from before a key existed reads as
     empty rather than throwing. */
  function arr(v) { return Array.isArray(v) ? v : []; }
  function obj(v) { return v && typeof v === 'object' ? v : {}; }
  function vals(o) { o = obj(o); var out = [], k; for (k in o) if (o.hasOwnProperty(k)) out.push(o[k]); return out; }
  function byAt(a, b) { return String(a.at || '').localeCompare(String(b.at || '')); }
  function eventsOf(s, kind) {
    return vals(obj(s.events)).filter(function (e) { return e && e.kind === kind; }).sort(byAt);
  }
  function uniqueResults(s) {
    var seen = {}, out = [];
    arr(obj(s.price_it).results).forEach(function (r) {
      if (!r || r.game_id == null) return;
      var k = String(r.game_id);
      if (seen[k]) return;
      seen[k] = true; out.push(r);
    });
    return out;
  }
  function cards(s) { return vals(obj(s.pick5).cards).filter(function (c) { return c && c.submitted_at; }); }
  function dailyDrills(s) { return vals(obj(obj(s.drill).daily)).sort(byAt); }
  function allDrills(s) { return dailyDrills(s).concat(arr(obj(s.drill).history)); }
  function opens(s) { return vals(obj(obj(s.research).opens)).sort(byAt); }
  function weekHasPlay(w) {
    return ((w.price_it | 0) + (w.pick5_cards | 0) + (w.drill | 0)) > 0;
  }

  /* ── the XP ledger ───────────────────────────────────────────────────────
     Every XP entry names the real record it came from. The total is the sum;
     the entries are what a profile, a dispute or a future server import can
     read back. Order is by time, so "what did I earn this week" is a filter. */
  function ledger(s) {
    s = s || {};
    var L = [], perWeek = {}, i, w;

    uniqueResults(s).forEach(function (r) {
      L.push({ kind: 'price_it', key: String(r.game_id), xp: XP.price_it, at: r.at || null, week: r.week || null,
        label: 'Priced ' + (r.away_team || '?') + ' vs ' + (r.home_team || '?') });
    });
    cards(s).forEach(function (c) {
      L.push({ kind: 'pick5_card', key: String(c.week), xp: XP.pick5_card, at: c.submitted_at, week: c.week,
        label: 'Pick 5 card, week of ' + c.week });
      arr(c.selections).forEach(function (sel) {
        if (sel && sel.result === 'win')
          L.push({ kind: 'pick5_correct', key: c.week + ':' + sel.game_id, xp: XP.pick5_correct,
            at: c.submitted_at, week: c.week, label: 'Correct side: ' + (sel.pick === 'home' ? sel.home_team : sel.away_team) });
      });
    });
    dailyDrills(s).forEach(function (d) {
      L.push({ kind: 'drill_daily', key: String(d.day), xp: XP.drill_daily, at: d.at, week: d.week,
        label: 'Two-Minute Drill, ' + d.day });
    });
    eventsOf(s, 'h2h_locked').forEach(function (e) {
      L.push({ kind: 'h2h_locked', key: e.key, xp: XP.h2h_locked, at: e.at, week: e.week,
        label: 'Head-to-Head locked' + (e.meta && e.meta.opponent ? ' vs ' + e.meta.opponent : '') });
    });
    eventsOf(s, 'h2h_win').forEach(function (e) {
      L.push({ kind: 'h2h_win', key: e.key, xp: XP.h2h_win, at: e.at, week: e.week,
        label: 'Head-to-Head win' + (e.meta && e.meta.opponent ? ' vs ' + e.meta.opponent : '') });
    });
    /* research: unique per game, and capped per football week so a research
       tab is worth reading, not clicking */
    opens(s).forEach(function (o) {
      var wk = o.week || 'none';
      perWeek[wk] = (perWeek[wk] | 0) + 1;
      if (perWeek[wk] > RESEARCH_CAP_PER_WEEK) return;
      L.push({ kind: 'research_open', key: String(o.game_id), xp: XP.research_open, at: o.at, week: o.week,
        label: 'Reviewed ' + (o.away_team || '?') + ' vs ' + (o.home_team || '?') });
    });
    var gc = eventsOf(s, 'group_create'), gj = eventsOf(s, 'group_join');
    if (gc.length) L.push({ kind: 'group_create', key: gc[0].key, xp: XP.group_create, at: gc[0].at, week: gc[0].week,
      label: 'Founded a group' });
    if (gj.length) L.push({ kind: 'group_join', key: gj[0].key, xp: XP.group_join, at: gj[0].at, week: gj[0].week,
      label: 'Joined a group' });
    /* a return for a NEW football week, after real play in an earlier one */
    var weeks = obj(s.weeks), visits = obj(obj(s.visits).weeks), keys = Object.keys(visits).sort();
    for (i = 0; i < keys.length; i++) {
      w = keys[i];
      var earlier = false, k;
      for (k in weeks) if (weeks.hasOwnProperty(k) && k < w && weekHasPlay(obj(weeks[k]))) earlier = true;
      if (earlier) L.push({ kind: 'week_return', key: w, xp: XP.week_return, at: visits[w].first_at || null, week: w,
        label: 'Back for the week of ' + w });
    }
    /* a completed mission set */
    Object.keys(weeks).concat(keys).filter(function (v, idx, self) { return self.indexOf(v) === idx; })
      .sort().forEach(function (wk) {
        var m = missionSet(s, wk);
        if (m.complete) L.push({ kind: 'mission_set', key: wk, xp: XP.mission_set, at: m.completed_at, week: wk,
          label: 'Every mission, week of ' + wk });
      });

    L.sort(byAt);
    return L;
  }

  function totalXp(s) {
    return ledger(s).reduce(function (t, e) { return t + e.xp; }, 0);
  }

  /* ── weekly missions ─────────────────────────────────────────────────────
     Five, per football week, each one a real thing to do with real games. No
     mission asks for anything a player cannot do for free, and none of them
     expire on a clock shorter than the football week they belong to. */
  var MISSIONS = [
    { id: 'price_3',   label: 'Price 3 games',            target: 3, href: '/games/price-it/',
      how: 'Lock a price on three matchups this week.' },
    { id: 'pick5',     label: 'Complete Pick 5',          target: 1, href: '/games/pick-5/',
      how: 'Submit this week’s five-game card.' },
    { id: 'drill',     label: 'Run a Two-Minute Drill',   target: 1, href: '/games/two-minute-drill/',
      how: 'Finish the day’s drill once this week.' },
    { id: 'research',  label: 'Review one matchup',       target: 1, href: '/games/price-it/',
      how: 'Open the EdgeDesk research for any game.' },
    { id: 'challenge', label: 'Challenge a friend',       target: 1, href: '/games/h2h/',
      how: 'Create or answer a Head-to-Head this week.' }
  ];

  function missions(s, weekKey) {
    s = s || {};
    var wk = weekKey || (W ? W.weekKey() : null);
    var counts = {
      price_3: uniqueResults(s).filter(function (r) { return r.week === wk; }).length,
      pick5: cards(s).filter(function (c) { return c.week === wk; }).length,
      drill: dailyDrills(s).filter(function (d) { return d.week === wk; }).length,
      research: opens(s).filter(function (o) { return o.week === wk; }).length,
      challenge: eventsOf(s, 'h2h_create').concat(eventsOf(s, 'h2h_submit'))
        .filter(function (e) { return e.week === wk; }).length
    };
    var ats = {
      price_3: uniqueResults(s).filter(function (r) { return r.week === wk; }).map(function (r) { return r.at; }),
      pick5: cards(s).filter(function (c) { return c.week === wk; }).map(function (c) { return c.submitted_at; }),
      drill: dailyDrills(s).filter(function (d) { return d.week === wk; }).map(function (d) { return d.at; }),
      research: opens(s).filter(function (o) { return o.week === wk; }).map(function (o) { return o.at; }),
      challenge: eventsOf(s, 'h2h_create').concat(eventsOf(s, 'h2h_submit'))
        .filter(function (e) { return e.week === wk; }).map(function (e) { return e.at; })
    };
    return MISSIONS.map(function (m) {
      var n = Math.min(m.target, counts[m.id] | 0);
      var done = n >= m.target;
      var when = done ? ats[m.id].slice().sort()[m.target - 1] || null : null;
      return { id: m.id, label: m.label, how: m.how, href: m.href, target: m.target,
        progress: n, done: done, completed_at: when };
    });
  }

  function missionSet(s, weekKey) {
    var ms = missions(s, weekKey);
    var done = ms.filter(function (m) { return m.done; });
    var last = null;
    done.forEach(function (m) { if (m.completed_at && (!last || m.completed_at > last)) last = m.completed_at; });
    return { week: weekKey || (W ? W.weekKey() : null), done: done.length, total: ms.length,
      complete: done.length === ms.length, completed_at: last, missions: ms };
  }

  /* ── achievements ────────────────────────────────────────────────────────
     Each one is a predicate over the record with the record's own timestamp.
     Nothing here can be granted; it can only be true. The descriptions are
     descriptive rather than congratulatory — "Contrarian" says you priced a
     game seven points from the market, not that you were right to. */
  var ACHIEVEMENTS = [
    { id: 'first_price',   name: 'First Price',     desc: 'Complete your first Price It.' },
    { id: 'ten_prices',    name: 'Ten Prices',      desc: 'Price ten matchups.' },
    { id: 'fifty_prices',  name: 'Fifty Prices',    desc: 'Price fifty matchups.' },
    { id: 'on_the_number', name: 'On the Number',   desc: 'Price a game within half a point of the benchmark.' },
    { id: 'contrarian',    name: 'Contrarian',      desc: 'Price a game 7+ points from the market. Descriptive, not a verdict.' },
    { id: 'first_card',    name: 'First Card',      desc: 'Submit a Pick 5 card.' },
    { id: 'perfect_five',  name: 'Perfect Five',    desc: 'Go 5–0 on a Pick 5 card.' },
    { id: 'researcher',    name: 'Researcher',      desc: 'Open the research for 10 different games.' },
    { id: 'film_study',    name: 'Film Study',      desc: 'Open the research for 50 different games.' },
    { id: 'seven_days',    name: 'Seven Days',      desc: 'Play seven days in a row.' },
    { id: 'full_week',     name: 'Full Week',       desc: 'Complete every weekly mission in one football week.' },
    { id: 'sharp_drill',   name: 'Sharp Drill',     desc: 'Get eight of ten in a Two-Minute Drill.' },
    { id: 'no_huddle',     name: 'No Huddle',       desc: 'Get ten of ten in a Two-Minute Drill.' },
    { id: 'first_h2h',     name: 'Head-to-Head',    desc: 'Lock a Head-to-Head with a friend.' },
    { id: 'rivalry',       name: 'Rivalry',         desc: 'Lock ten Head-to-Heads against the same player.' },
    { id: 'founder',       name: 'Founder',         desc: 'Create a group.' }
  ];

  function achievements(s) {
    s = s || {};
    var R = uniqueResults(s), C = cards(s), O = opens(s), D = allDrills(s);
    var locked = eventsOf(s, 'h2h_locked'), gc = eventsOf(s, 'group_create');
    function nth(list, n, at) { return list.length >= n ? { earned: true, at: at(list[n - 1]) } : { earned: false, progress: list.length, target: n }; }
    function first(list, pred, at) {
      var i; for (i = 0; i < list.length; i++) if (pred(list[i])) return { earned: true, at: at(list[i]) };
      return { earned: false };
    }
    var rAt = function (r) { return r.at || null; };
    var byOpp = {}, rival = null;
    locked.forEach(function (e) {
      var o = e.meta && e.meta.opponent; if (!o) return;
      byOpp[o] = (byOpp[o] || []).concat([e]);
      if (byOpp[o].length >= 10 && !rival) rival = byOpp[o][9];
    });
    var bestOpp = 0, k; for (k in byOpp) if (byOpp[k].length > bestOpp) bestOpp = byOpp[k].length;
    var weeksAll = Object.keys(obj(s.weeks)).concat(Object.keys(obj(obj(s.visits).weeks)))
      .filter(function (v, i, self) { return self.indexOf(v) === i; }).sort();
    var fullWeek = { earned: false };
    weeksAll.forEach(function (wk) { var m = missionSet(s, wk); if (m.complete && !fullWeek.earned) fullWeek = { earned: true, at: m.completed_at }; });
    var streakBest = obj(s.streak).best | 0;

    var status = {
      first_price:   nth(R, 1, rAt),
      ten_prices:    nth(R, 10, rAt),
      fifty_prices:  nth(R, 50, rAt),
      on_the_number: first(R, function (r) { return typeof r.distance === 'number' && r.distance <= 0.5; }, rAt),
      contrarian:    first(R, function (r) { return typeof r.distance_to_market === 'number' && r.distance_to_market >= 7; }, rAt),
      first_card:    nth(C, 1, function (c) { return c.submitted_at; }),
      perfect_five:  first(C, function (c) { return (c.correct | 0) === 5 && (c.decided | 0) === 5 && arr(c.selections).length === 5; },
                       function (c) { return c.submitted_at; }),
      researcher:    nth(O, 10, rAt),
      film_study:    nth(O, 50, rAt),
      seven_days:    streakBest >= 7 ? { earned: true, at: obj(s.streak).last_day || null } : { earned: false, progress: streakBest, target: 7 },
      full_week:     fullWeek,
      sharp_drill:   first(D, function (d) { return (d.rounds | 0) >= 10 && (d.correct | 0) >= 8; }, rAt),
      no_huddle:     first(D, function (d) { return (d.rounds | 0) >= 10 && (d.correct | 0) >= 10; }, rAt),
      first_h2h:     nth(locked, 1, rAt),
      rivalry:       rival ? { earned: true, at: rival.at } : { earned: false, progress: bestOpp, target: 10 },
      founder:       nth(gc, 1, rAt)
    };
    return ACHIEVEMENTS.map(function (a) {
      var st = status[a.id] || { earned: false };
      return { id: a.id, name: a.name, desc: a.desc, earned: !!st.earned, at: st.at || null,
        progress: st.progress == null ? null : st.progress, target: st.target == null ? null : st.target };
    });
  }

  /* ── the summary a page renders ─────────────────────────────────────────── */
  function summary(s, nowMs) {
    s = s || {};
    var xp = totalXp(s), level = levelFor(xp);
    var cur = xpForLevel(level), nxt = level < MAX_LEVEL ? xpForLevel(level + 1) : null;
    var ach = achievements(s), wk = W ? W.weekKey(nowMs) : null;
    var ms = missionSet(s, wk);
    return {
      version: DYNASTY_VERSION,
      xp: xp, level: level, max_level: MAX_LEVEL,
      title: titleFor(level), stage: stageFor(level), next_stage: nextStage(level),
      next: nxt == null ? null : { level: level + 1, at: nxt, into: xp - cur, span: nxt - cur,
        remaining: nxt - xp, pct: Math.max(0, Math.min(100, Math.round(100 * (xp - cur) / (nxt - cur)))) },
      achievements: ach,
      earned: ach.filter(function (a) { return a.earned; }).map(function (a) { return a.id; }),
      missions: ms,
      /* completed games of any kind — the count progressive disclosure keys on */
      games: uniqueResults(s).length + cards(s).length + dailyDrills(s).length,
      created: uniqueResults(s).length + cards(s).length + dailyDrills(s).length > 0
    };
  }

  /* ── what changed since the player last looked ───────────────────────────
     `seen` is the compact marker the store keeps; `now` is a fresh summary.
     The result is what to celebrate — and only what is genuinely new. */
  /* PROGRESSIVE DISCLOSURE. The first completed game is celebrated as a
     result ("nice — your first result"), not as a product: nobody who has
     played once needs a War Room explained to them. The War Room is
     announced on the SECOND game, which is also the moment the account ask
     becomes fair (store.engaged). After that, everything is incremental. */
  var CREATE_AT = 2;
  function diff(seen, now) {
    var baseline = !seen;
    seen = seen || { xp: 0, level: 0, earned: [], missions_done: 0, missions_week: null, created: false, games: 0 };
    var newAch = (now.earned || []).filter(function (id) { return (seen.earned || []).indexOf(id) < 0; });
    var sameWeek = seen.missions_week === now.missions.week;
    var doneBefore = sameWeek ? (seen.missions_done | 0) : 0;
    var gamesBefore = seen.games | 0, gamesNow = now.games | 0;
    return {
      /* no marker yet: this is the first time the layer has looked at an
         envelope. A player with history gets ONE moment (their War Room,
         built from their record) and no chip storm for things that happened
         weeks ago. */
      baseline: baseline,
      xp_gained: Math.max(0, now.xp - (seen.xp | 0)),
      first_result: gamesBefore < 1 && gamesNow >= 1 && gamesNow < CREATE_AT,
      created: gamesBefore < CREATE_AT && gamesNow >= CREATE_AT,
      leveled_up: (seen.level | 0) > 0 && now.level > seen.level,
      from_level: seen.level | 0, to_level: now.level,
      stage_changed: (seen.level | 0) > 0 && stageFor(now.level).key !== stageFor(seen.level | 0).key,
      new_achievements: now.achievements.filter(function (a) { return newAch.indexOf(a.id) >= 0; }),
      missions_newly_done: Math.max(0, now.missions.done - doneBefore),
      set_completed: now.missions.complete && !(sameWeek && seen.missions_complete)
    };
  }

  /* the compact marker to store after the player has been shown a summary */
  function marker(now) {
    return { v: DYNASTY_VERSION, xp: now.xp, level: now.level, earned: now.earned.slice(),
      missions_week: now.missions.week, missions_done: now.missions.done,
      missions_complete: now.missions.complete, created: !!now.created, games: now.games | 0 };
  }

  var API = {
    DYNASTY_VERSION: DYNASTY_VERSION, XP: XP, RESEARCH_CAP_PER_WEEK: RESEARCH_CAP_PER_WEEK, CREATE_AT: CREATE_AT,
    MAX_LEVEL: MAX_LEVEL, TITLES: TITLES, STAGES: STAGES, MISSIONS: MISSIONS, ACHIEVEMENTS: ACHIEVEMENTS,
    xpForLevel: xpForLevel, levelFor: levelFor, titleFor: titleFor, stageFor: stageFor, nextStage: nextStage,
    ledger: ledger, totalXp: totalXp, missions: missions, missionSet: missionSet,
    achievements: achievements, summary: summary, diff: diff, marker: marker
  };
  root.EDGamesDynasty = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
