/* ===========================================================================
   GRIDIRON — the football engine.

   TWO THINGS LIVE HERE and nothing else does:

     resolve()   one snap: a play call against a defensive call, decided from
                 ratings, leverage, fatigue, preparation and the situation.
     the machine  downs, the chains, the clock, possession, scoring, drives,
                 the box score — the rules of football.

   THE ONE RULE THIS FILE IS BUILT ON. Randomness creates VARIANCE, never the
   outcome. Every play computes an expectation from the two teams and the two
   calls, and the draw is a spread around it. A ninety-rated offence does not
   automatically win a snap, and a sixty-five-rated defence with the right
   call takes one away — but the talent is in every number, all the time.

   Deterministic. The same seed, the same calls and the same rosters give the
   same game, every time, which is what makes ten thousand simulated seasons
   a test rather than an anecdote.

   Nothing here draws anything, and nothing here knows about a franchise.
   =========================================================================== */
(function (root) {
  'use strict';

  var F = root.EDFootball || (typeof require === 'function' ? require('./football.js') : null);
  var R = root.EDRoster || (typeof require === 'function' ? require('./roster.js') : null);

  var ENGINE_VERSION = 'gridiron_v1';

  /* ── the rules ─────────────────────────────────────────────────────────── */
  var RULES = {
    quarters: 4,
    quarter_seconds: 900,        /* 15:00, the real thing; the clock is what compresses */
    kickoff_from: 35,
    touchback: 25,
    safety_punt_from: 20,
    fg_snap: 7,                  /* the ball is spotted seven yards behind the line */
    two_point_from: 97,          /* the three yard line, in own-goal-line coordinates */
    ot_seconds: 600,
    play_clock: 40
  };

  /* how many seconds one snap costs, before tempo */
  var CLOCK = {
    run: 36, pass_complete: 34, pass_incomplete: 7, sack: 37, scramble: 36,
    out_of_bounds: 8, kick: 12, change: 15, score: 20, spike: 3, kneel: 41,
    hurry: 0.34, normal: 1, grind: 1.22
  };

  /* ── seeded randomness ─────────────────────────────────────────────────── */
  function rng(seed) { return R.rng(seed); }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function logistic(x) { return 1 / (1 + Math.exp(-x)); }
  /* a normal draw, Box–Muller, from a uniform generator */
  function norm(rand) {
    var u = 1 - rand(), v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  /* the right-skewed tail football yardage actually has */
  function expo(rand, mean) { return -Math.log(1 - rand()) * mean; }
  function pick(rand, list) { return list[Math.min(list.length - 1, Math.floor(rand() * list.length))]; }

  /* ── PREPARATION AND SCOUTING, as modifiers ─────────────────────────────
     A week of work is worth a few percent, in the places the work was done.
     Nothing here is decorative: every field is read by resolve(). */
  function mods(o) {
    o = o || {};
    var p = clamp(+o.preparation || 0, 0, 100), sc = clamp(+o.scouting || 0, 0, 100);
    return {
      /* execution: fewer mistakes, better timing */
      execution: (p - 50) / 50 * 0.022,
      /* film study: you recognise their call before the snap more often */
      recognition: sc / 100 * 0.30,
      /* conditioning: how slowly the legs go */
      stamina: 1 - (clamp(+o.conditioning || 0, 0, 100) / 100) * 0.40,
      /* the coaching staff and the halftime adjustment, added by the caller */
      offense: +o.offense || 0,
      defense: +o.defense || 0,
      late: +o.late || 0,
      /* home field, in the same units the rest of the engine speaks */
      home: +o.home || 0,
      /* THE HALFTIME ADJUSTMENTS. Each one is a real term in a real
         calculation rather than a flat bonus — "protect the quarterback"
         is worth protection, and nothing else. */
      protect: +o.protect || 0,
      outsideRun: +o.outsideRun || 0,
      tempo: o.tempo == null ? 1 : +o.tempo,
      runFit: +o.runFit || 0,
      deepCover: +o.deepCover || 0,
      rush: +o.rush || 0
    };
  }

  /* ── A TEAM, as the engine holds one ────────────────────────────────────── */
  function makeTeam(t) {
    t = t || {};
    var players = t.players && t.players.length ? t.players
      : R.generate({ seed: t.seed || t.name || 'team', overall: t.overall || 72,
                     offense: t.offense, defense: t.defense });
    return {
      id: t.id || null,
      city: t.city || '', name: t.name || 'Team', abbr: t.abbr || (t.name || 'TM').slice(0, 3).toUpperCase(),
      theme: t.theme || 'forest', logo: t.logo || 'star',
      offense: t.offense || 'pro_style', defense: t.defense || 'four_three',
      players: players,
      fatigue: {}, injuries: [],
      mods: mods(t.mods),
      identity: t.identity || null,
      _units: null, _unitsAt: -1
    };
  }

  function unitsOf(team, at) {
    if (team._units && team._unitsAt === at) return team._units;
    team._units = R.units(team.players, team.fatigue);
    team._unitsAt = at;
    return team._units;
  }

  /* ── FATIGUE ────────────────────────────────────────────────────────────
     Snaps cost legs. Who pays depends on what was called, so a team that
     runs it forty times has a tired line and a tired back in the fourth
     quarter, and its backup matters. Conditioning slows the drain. */
  var DRAIN = { QB: 0.5, RB: 3.4, WR: 2.1, TE: 2.0, OL: 2.2, DL: 3.0, LB: 2.5, CB: 2.0, S: 1.7, K: 0, P: 0 };
  function tire(team, positions, weight) {
    var f = team.fatigue, s = team.mods.stamina, i, p, d;
    for (i = 0; i < team.players.length; i++) {
      p = team.players[i];
      if (!R.available(p)) continue;
      if (positions && positions.indexOf(p.position) < 0) continue;
      if ((p.depth || 1) > (R.STARTERS[p.position] || 1)) continue;   /* only who is on the field */
      d = (DRAIN[p.position] || 2) * (weight == null ? 1 : weight) * s;
      f[p.id] = clamp((f[p.id] == null ? 100 : f[p.id]) - d, 0, 100);
    }
    team._units = null;
  }
  function rest(team, amount, positions) {
    var f = team.fatigue, i, p;
    if (!positions) {
      for (var k in f) if (f.hasOwnProperty(k)) f[k] = clamp(f[k] + amount, 0, 100);
    } else {
      for (i = 0; i < team.players.length; i++) {
        p = team.players[i];
        if (positions.indexOf(p.position) < 0) continue;
        if (f[p.id] != null) f[p.id] = clamp(f[p.id] + amount, 0, 100);
      }
    }
    team._units = null;
  }
  var OFF_POS = ['QB', 'RB', 'WR', 'TE', 'OL'];
  var DEF_POS = ['DL', 'LB', 'CB', 'S'];
  function freshness(team, pos) {
    var i, p, n = 0, s = 0;
    for (i = 0; i < team.players.length; i++) {
      p = team.players[i];
      if (p.position !== pos || !R.available(p)) continue;
      if ((p.depth || 1) > (R.STARTERS[pos] || 1)) continue;
      s += team.fatigue[p.id] == null ? 100 : team.fatigue[p.id]; n++;
    }
    return n ? s / n : 100;
  }

  /* ── INJURIES ───────────────────────────────────────────────────────────
     Light, and never a punishment for playing well. Risk rises with fatigue,
     with contact, and falls with a player's own durability. */
  function maybeInjure(team, player, rand, contact) {
    if (!player) return null;
    var fr = team.fatigue[player.id] == null ? 100 : team.fatigue[player.id];
    var dur = player.durability == null ? 75 : player.durability;
    /* about one knock a game a side, and a couple of multi-week injuries a
       season — enough that depth is a decision, never enough to be the game */
    var p = 0.022 * (contact || 1) * (1 + (100 - fr) / 90) * (1.6 - dur / 125);
    if (rand() >= p) return null;
    var roll = rand();
    var weeks = roll < 0.62 ? 0 : roll < 0.9 ? 1 : roll < 0.98 ? 2 : 4;
    var out = roll < 0.62 ? Math.ceil(rand() * 3) : 99;   /* plays out, or the game */
    player.injury = { weeks: weeks, plays: out, kind: weeks === 0 ? 'shaken up' : weeks === 1 ? 'week to week' : 'multi-week' };
    player.health = weeks === 0 ? 60 : 0;
    team.injuries.push({ id: player.id, name: R.name(player), position: player.position,
                         kind: player.injury.kind, weeks: weeks });
    if (weeks > 0) { promote(team, player); }
    team._units = null;
    return player.injury;
  }
  /* the next man up actually moves up the chart */
  function promote(team, hurt) {
    var i, p;
    for (i = 0; i < team.players.length; i++) {
      p = team.players[i];
      if (p.position === hurt.position && p.id !== hurt.id && (p.depth || 99) > (hurt.depth || 1)) {
        p.depth = (p.depth || 99) - 1;
      }
    }
    hurt.depth = 99;
  }

  /* ── TENDENCIES ─────────────────────────────────────────────────────────
     Call the same thing over and over and they start sitting on it. This is
     the single most important teaching mechanic in the game: it is why a
     play sheet is a plan rather than a favourite button. */
  function noteCall(mem, key, group) {
    mem.recent.push({ key: key, group: group });
    if (mem.recent.length > 12) mem.recent.shift();
    mem.count[key] = (mem.count[key] || 0) + 1;
    mem.groups[group] = (mem.groups[group] || 0) + 1;
    mem.total++;
  }
  function newMemory() { return { recent: [], count: {}, groups: {}, total: 0 }; }
  /* how well they have seen this coming, in [0, 0.4] */
  function tendency(mem, playKey, group) {
    if (!mem.total) return 0;
    var recent = mem.recent, n = recent.length, same = 0, sameGroup = 0, i;
    for (i = 0; i < n; i++) {
      if (recent[i].key === playKey) same++;
      if (recent[i].group === group) sameGroup++;
    }
    return clamp(same / Math.max(4, n) * 0.55 + (sameGroup / Math.max(6, n)) * 0.18, 0, 0.4);
  }

  /* ── THE PRE-SNAP READ ──────────────────────────────────────────────────
     What the defence knows before the ball moves: the formation's own tell,
     how repetitive the offence has been, and how much film was watched. */
  function recognition(offTeam, defTeam, formKey, playObj, mem, rand) {
    var form = F.formation(formKey);
    var du = unitsOf(defTeam, -1);
    var iq = (du.lb.iq * 0.5 + du.s.iq * 0.5 - 60) / 100;      /* ±0.4 */
    var runPlay = playObj.type === 'run';
    /* the tell points the right way about as often as it says it does */
    var tellSays = form.tell * (runPlay ? -1 : 1);              /* +1 when the tell matches */

    /* RUN OR PASS IS THE ONLY GUESS THAT MATTERS, and a side that has done one
       of them eight times out of ten has already made it for them. This is the
       force that keeps a balanced offence worth having: without it the most
       efficient play type simply wins, which is not how football works and is
       not how any coach behaves. */
    var passShare = 0.5, i, rc = 0;
    if (mem && mem.recent && mem.recent.length >= 4) {
      for (i = 0; i < mem.recent.length; i++) if (F.play(mem.recent[i].key).type === 'pass') rc++;
      passShare = rc / mem.recent.length;
    }
    var predictable = runPlay ? (1 - passShare) : passShare;    /* 0 surprising, 1 obvious */

    var base = 0.15 + tellSays * 0.15 + iq * 0.35
             + (predictable - 0.5) * 0.80
             + tendency(mem, playObj.key, playObj.group) * 0.75
             + defTeam.mods.recognition * 0.5;
    var p = clamp(base, 0.02, 0.88);
    return { p: p, read: rand() < p, tell: form.tell, passShare: passShare };
  }

  /* ── THE TRENCHES ──────────────────────────────────────────────────────── */
  function passRush(ou, du, parts, playObj, extraBlockers, offMods, defMods) {
    var RUSH = 0.60 * du.dl.prs + 0.22 * du.dl.spd + 0.18 * du.lb.spd;
    var PROT = 0.76 * ou.ol.pbk + 0.12 * ou.ol.iq + 0.12 * ou.te.blk + (extraBlockers || 0) * 3.5
             + ((offMods && offMods.protect) || 0) * 4;
    var hold = playObj.hold || 2.4;
    /* A BLITZ IS A RACE AGAINST THE BALL. Six rushers are worth almost nothing
       against a slant and everything against a seven-step drop, so what the
       pressure buys is scaled by how long the quarterback has to hold it —
       which is why the answer to a zero blitz is to throw it quickly and why
       taking a shot into one is the worst call in football. */
    var rushValue = clamp(0.50 + (hold - 2.0) * 0.46, 0.30, 1.65);
    var p = 0.205 + (RUSH - PROT) * 0.0072 + parts.pressure.rush * rushValue + parts.coverage.rush
          + (hold - 2.4) * 0.100
          + ((defMods && defMods.rush) || 0);
    if (playObj.concept === 'screen') p = p * 0.18 - 0.02;      /* the rush is the point */
    if (playObj.concept === 'quick') p += parts.pressure.vsQuick;
    if (playObj.concept === 'pa') p += 0.03;                     /* the fake costs time */
    return clamp(p, 0.015, 0.82);
  }

  function boxCount(parts, formKey) {
    var form = F.formation(formKey);
    return parts.front.box + parts.coverage.box + parts.pressure.box
         + (form.boxPull * 2 - 1) + (parts.fit.key === 'aggressive' ? 0.5 : 0);
  }

  /* ── RESOLVE ONE SNAP ────────────────────────────────────────────────────
     ctx: { off, def, playKey, formKey, defKey|defCall, sit, rand, mem }
     Returns the result object the state machine and the renderer both read. */
  function resolve(ctx) {
    var off = ctx.off, def = ctx.def, rand = ctx.rand;
    var playObj = F.play(ctx.playKey), formKey = ctx.formKey || (playObj.forms[0]);
    var parts = F.defParts(ctx.defCall || ctx.defKey);
    var ou = unitsOf(off, ctx.tick), du = unitsOf(def, ctx.tick);
    var sit = ctx.sit || {};
    var mem = ctx.mem || newMemory();
    var rec = recognition(off, def, formKey, playObj, mem, rand);
    var oScheme = F.scheme(off.offense);
    var box = boxCount(parts, formKey);

    /* the coaching staff, the halftime adjustment and home field, in one place */
    var edge = (off.mods.offense - def.mods.defense) * 0.01
             + off.mods.execution - def.mods.execution * 0.5
             + off.mods.home * 0.020;

    var out = {
      version: ENGINE_VERSION,
      play: playObj.key, playName: playObj.name, group: playObj.group, type: playObj.type,
      formation: formKey, def: parts.key, defName: parts.name,
      front: parts.front.key, coverage: parts.coverage.key, pressureCall: parts.pressure.key, fit: parts.fit.key,
      box: Math.round(box * 10) / 10,
      read: rec.read, readP: Math.round(rec.p * 100) / 100,
      yards: 0, touchdown: false, turnover: null, sack: false, pressure: false,
      completion: null, incomplete: false, scramble: false, outOfBounds: false,
      firstDown: false, airYards: 0, yac: 0, big: false, notes: [], tackler: null
    };

    if (playObj.concept === 'kneel') {
      out.yards = -1; out.carrier = ou.qb.player; out.notes.push('Victory formation.');
      return out;
    }
    if (playObj.concept === 'spike') {
      out.incomplete = true; out.completion = false; out.notes.push('Spiked to stop the clock.');
      return out;
    }

    if (playObj.type === 'run') return resolveRun(out, ctx, ou, du, parts, playObj, formKey, box, rec, oScheme, edge);
    return resolvePass(out, ctx, ou, du, parts, playObj, formKey, box, rec, oScheme, edge);
  }

  /* ── RUN ────────────────────────────────────────────────────────────────── */
  function resolveRun(out, ctx, ou, du, parts, playObj, formKey, box, rec, oScheme, edge) {
    var rand = ctx.rand, off = ctx.off, def = ctx.def, sit = ctx.sit || {};
    /* WHERE THE DEFENCE IS HEAVY. Drawn once per snap from the game's own
       seed, shown in the pre-snap alignment, and worth about a yard either
       way: run away from the strength and you have found something the box
       count alone never told you. This is the run game's user input. */
    var strong = F.strongSide(parts.front.key + parts.coverage.key + parts.pressure.key + parts.fit.key, sit);
    out.strongSide = strong;
    var lane = ctx.userLane == null ? 0 : (ctx.userLane | 0);
    out.lane = lane;
    var laneEdge = lane === 0 ? 0 : (lane === -strong ? 0.95 : -0.75);
    out.laneRight = lane !== 0 && lane === -strong;
    var isQB = playObj.concept === 'option' || playObj.concept === 'sneak' || playObj.key === 'qb_read';
    var carrier = isQB && rand() < (playObj.concept === 'sneak' ? 1 : 0.45)
      ? ou.qb.player : (ou.rb.players[0] || ou.qb.player);
    out.carrier = carrier;

    var OF = 0.70 * ou.ol.rbk + 0.16 * ou.te.blk + 0.14 * ou.ol.str;
    var DF = 0.52 * du.dl.rst + 0.28 * du.lb.tkl + 0.20 * du.dl.str;
    var adv = (OF - DF) / 18;                                   /* about ±2.5 */
    var boxEffect = (7 - box) * 0.52;
    var fitEffect = F.runVsFit(playObj.concept, parts.fit.key);
    var outsideEffect = (playObj.concept === 'outside' ? (parts.fit.outside || 0) * 8 : 0)
                      + (playObj.concept === 'outside' ? off.mods.outsideRun : 0)
                      - def.mods.runFit * 6;
    /* A SCHEME IS WHAT YOU ARE GOOD AT. The run concepts a team is built
       around are worth more than a rounding error to it — a Power Run club
       pulling its guard is doing the thing it has practised all week with the
       linemen it recruited for it, and the yards have to show that or the
       identity is a label on a menu. */
    var schemeBonus = ((oScheme.concepts && oScheme.concepts[playObj.concept]) || 0) * 20
                    + ((oScheme.favors && oScheme.favors.run) || 0) * 14;
    var readPenalty = rec.read ? -1.15 : 0.28;
    /* SHORT YARDAGE IS WHAT HEAVY PERSONNEL IS FOR. Two backs and two tight
       ends are worth nothing at second and nine and worth a first down at
       third and one, which is the whole argument for owning them. */
    var heavy = (formKey === 'i_form' || formKey === 'goalline' || formKey === 'wildcat');
    var shortYardage = ((sit.toGo != null && sit.toGo <= 3) || (sit.toGoal != null && sit.toGoal <= 5));
    var heavyEdge = heavy && shortYardage ? 0.8 : heavy && !shortYardage ? -0.15 : 0;
    var covRun = -(parts.coverage.box || 0) * 0.35;

    var mu = playObj.base + adv + boxEffect + fitEffect + outsideEffect + schemeBonus
           + readPenalty + covRun + edge * 6 + laneEdge + heavyEdge;
    mu = clamp(mu, 1.0, 7.4);

    /* STUFFED. Getting a run stopped is mostly the front and the box, and it
       is the single biggest thing a defensive call can buy. */
    var pStuff = clamp(0.252 - adv * 0.026 + (box - 7) * 0.030 + parts.fit.run * 0.9
                       + (rec.read ? 0.075 : -0.02) - (oScheme.concepts && oScheme.concepts[playObj.concept] ? 0.02 : 0)
                       - laneEdge * 0.045 + def.mods.runFit,
                       0.05, 0.52);
    /* BREAKING ONE. Vision and legs against pursuit and tackling. */
    var breakEdge = ((ou.rb.elu + ou.rb.spd) / 2 - (du.lb.spd * 0.45 + du.s.tkl * 0.35 + du.cb.tkl * 0.20)) / 100;
    var pBig = clamp(playObj.boom + breakEdge * 0.30 + parts.fit.boom * 0.7
                     + (box <= 6 ? 0.03 : 0) - (rec.read ? 0.03 : 0), 0.005, 0.45);

    var yards;
    if (rand() < pStuff) {
      yards = Math.round(-2.6 + rand() * 5.2);
      out.notes.push(box >= 7.8 ? 'They had the numbers in the box.' : 'Met in the hole.');
    } else {
      yards = 1 + expo(rand, Math.max(1.4, mu * 0.84));
      if (rand() < pBig) { yards += 4 + expo(rand, 11 + breakEdge * 16); out.big = true; }
      yards = Math.round(yards);
    }
    if (playObj.concept === 'sneak') yards = clamp(yards, 0, 3);
    if (playObj.concept === 'kneel') yards = -1;

    out.yards = yards;
    out.tackler = tacklerFor(du, rand, yards);
    out.outOfBounds = playObj.concept === 'outside' && rand() < 0.30;

    /* the ball on the ground */
    var pFum = clamp(0.0085 + (playObj.risk || 0) * 0.012 + (out.big ? 0.004 : 0)
                     - (ou.rb.hnd - 60) / 4000 + (parts.fit.key === 'aggressive' ? 0.004 : 0), 0.001, 0.06);
    if (rand() < pFum) {
      out.turnover = 'fumble'; out.yards = Math.max(0, Math.round(yards * 0.7));
      out.notes.push('Ball is out.');
    }

    tire(off, ['OL', 'RB', 'TE', 'QB'], 1);
    tire(def, ['DL', 'LB', 'S'], 1);
    if (rand() < 0.5) maybeInjure(off, carrier, rand, 1 + (out.big ? 0.5 : 0));
    else maybeInjure(def, out.tackler, rand, 1);
    return out;
  }

  function tacklerFor(du, rand, yards) {
    var pool = yards <= 3 ? (du.dl.players.concat(du.lb.players))
             : yards <= 10 ? (du.lb.players.concat(du.s.players))
             : (du.s.players.concat(du.cb.players));
    if (!pool.length) pool = du.lb.players.concat(du.dl.players);
    return pool.length ? pick(rand, pool) : null;
  }

  /* ── PASS ───────────────────────────────────────────────────────────────── */
  function resolvePass(out, ctx, ou, du, parts, playObj, formKey, box, rec, oScheme, edge) {
    var rand = ctx.rand, off = ctx.off, def = ctx.def, sit = ctx.sit || {}, mem = ctx.mem;
    var qb = ou.qb, form = F.formation(formKey);
    var extraBlockers = (playObj.assign && playObj.assign.RB === 'block' ? 1 : 0)
                      + (playObj.assign && playObj.assign.TE === 'block' ? 0.7 : 0);
    var pPressure = passRush(ou, du, parts, playObj, extraBlockers, off.mods, def.mods);
    /* timing, in [0, 1]: 1 is the ball out on rhythm, 0 is holding it */
    var timing = ctx.userTiming == null ? null : clamp(+ctx.userTiming, 0, 1);
    if (timing != null) { pPressure += (0.5 - timing) * 0.10; out.timing = Math.round(timing * 100) / 100; }
    /* a quarterback who sees it coming gets rid of it */
    pPressure = clamp(pPressure - (qb.iq - 60) / 1400 - (rec.read ? -0.045 : 0.018), 0.01, 0.85);
    var pressured = rand() < pPressure;
    out.pressure = pressured;

    /* WHO IS OPEN. The progression, best read first, against this coverage. */
    var readsList = F.reads(playObj.key, parts.coverage);
    var target = null, readSep = 0;
    if (readsList.length) {
      /* WHO HE THROWS TO. Left alone, the quarterback finds the best read
         about as often as his football IQ says he should. Given one by the
         player, he throws THERE — which is the whole point of playing rather
         than coaching, and is why reading the coverage is a skill worth
         having. Taking too long to decide costs what taking too long costs. */
      var idx;
      if (ctx.userRead != null) {
        idx = Math.max(0, Math.min(readsList.length - 1, ctx.userRead | 0));
        out.userRead = idx;
      } else {
        idx = rand() < clamp(0.52 + (qb.iq - 60) / 160 + off.mods.execution, 0.25, 0.92) ? 0
            : Math.min(readsList.length - 1, 1 + Math.floor(rand() * 2));
      }
      target = readsList[idx]; readSep = target.sep;
    }
    var band = target ? target.band : 'short';
    var depth = target ? Math.max(-2, target.depth) : (playObj.depth || 5);

    var covUnit = band === 'deep' ? (du.s.cov * 0.45 + du.cb.cov * 0.45 + du.lb.cov * 0.10)
                : band === 'int' ? (du.cb.cov * 0.40 + du.lb.cov * 0.35 + du.s.cov * 0.25)
                : (du.lb.cov * 0.45 + du.cb.cov * 0.35 + du.s.cov * 0.20);
    var recUnit = target && target.slot === 'RB' ? (ou.rb.hnd * 0.6 + ou.rb.spd * 0.4)
                : target && (target.slot === 'TE') ? (ou.te.rte * 0.55 + ou.te.hnd * 0.45)
                : (ou.wr.rte * 0.55 + ou.wr.spd * 0.45);
    /* PLAY ACTION IS WORTH WHAT THE RUN GAME HAS EARNED. A team that has run
       it on two thirds of its snaps gets the linebackers to bite; a team that
       has thrown it every down does not, and its play-action fake is a
       two-tenths-of-a-second delay it paid for and got nothing back. This is
       the single mechanism that makes a Power Run identity a real one. */
    var runThreat = 0.45;
    if (mem && mem.recent && mem.recent.length >= 3) {
      var rc = 0, ri;
      for (ri = 0; ri < mem.recent.length; ri++) {
        if (F.play(mem.recent[ri].key).type === 'run') rc++;
      }
      runThreat = rc / mem.recent.length;
    }
    var paBonus = (playObj.concept === 'pa') ? (runThreat - 0.45) * 0.42 : 0;
    out.runThreat = Math.round(runThreat * 100) / 100;
    var sep = (recUnit - covUnit) / 125                       /* ±0.4 or so */
            + readSep
            + parts.pressure.cover
            + ((oScheme.favors && oScheme.favors[playObj.group]) || 0) * 0.75
            + ((oScheme.concepts && oScheme.concepts[playObj.concept]) || 0) * 0.8
            + (rec.read ? -0.15 : 0.035)
            + paBonus
            + edge;
    if (playObj.concept === 'screen') sep += 0.06 - parts.pressure.vsScreen;
    if (band === 'deep') sep -= def.mods.deepCover;
    out.separation = Math.round(sep * 100) / 100;

    /* SACK, or out of the pocket */
    /* HE TOOK OFF. The user pressed scramble, so the quarterback runs — but
       breaking a pocket that has already caved in is how one gets buried, so
       when he is pressured the rush still gets its say first. Same branch,
       same numbers; the only difference is that the decision was his. */
    var takeOff = !!ctx.userScramble;
    if ((pressured || takeOff) && playObj.concept !== 'screen'
        && (takeOff || playObj.concept !== 'quick')) {
      var pSack = pressured
        ? clamp(0.64 - (qb.spd - 60) / 340 - (qb.iq - 60) / 500
                + (playObj.hold - 2.4) * 0.10, 0.08, 0.72)
        : 0;
      if (rand() < pSack) {
        out.sack = true;
        out.yards = -Math.round(4 + expo(rand, 3.2));
        out.tackler = du.dl.players.length ? pick(rand, du.dl.players.concat(du.lb.players)) : null;
        out.notes.push('Pressure got home before the route developed.');
        if (rand() < 0.075) { out.turnover = 'fumble'; out.notes.push('Stripped from behind.'); }
        tire(off, ['OL', 'QB'], 1.1); tire(def, ['DL', 'LB'], 1.1);
        maybeInjure(off, qb.player, rand, 1.4);
        return out;
      }
      if (takeOff || rand() < clamp(0.14 + (qb.spd - 60) / 220, 0.03, 0.55)) {
        out.scramble = true;
        out.yards = Math.max(-2, Math.round(expo(rand, 3.4 + (qb.spd - 60) / 14)));
        out.carrier = qb.player;
        out.tackler = tacklerFor(du, rand, out.yards);
        out.outOfBounds = rand() < 0.45;
        out.notes.push('Nothing there — he takes off.');
        tire(off, ['OL', 'QB'], 1); tire(def, ['DL', 'LB'], 1);
        return out;
      }
    }

    /* THE THROW. Accuracy is depth-specific; pressure taxes all of it. */
    var acc = band === 'deep' ? (qb.arm * 0.55 + qb.acc * 0.45)
            : band === 'int' ? (qb.arm * 0.30 + qb.acc * 0.70)
            : qb.acc;
    var press = pressured ? 1 : 0;
    var z = 0.195
          + sep * 2.05
          + (acc - 62) / 15
          - (band === 'deep' ? 1.62 : band === 'int' ? 0.62 : 0)
          - press * (0.92 + (band === 'deep' ? 0.5 : 0))
          + (playObj.risk || 0) * -0.5
          + (timing == null ? 0 : (timing - 0.5) * 0.28)
          + off.mods.execution * 2;
    var pComp = clamp(logistic(z), 0.03, 0.965);

    /* THE INTERCEPTION. A bad decision into coverage, a hit as he throws, or
       a deep ball with nobody open. */
    var pInt = clamp(0.0112
      + (playObj.risk || 0) * 0.045
      + (band === 'deep' ? 0.017 : band === 'int' ? 0.006 : -0.004)
      + (pressured ? 0.017 : 0)
      + (sep < -0.05 ? 0.020 : 0)
      + (rec.read ? 0.008 : 0)
      + (parts.coverage.ballhawk || 0) * 0.9
      + (du.s.bhk + du.cb.bhk - 120) / 5200
      - (qb.iq - 60) / 2600
      - off.mods.execution * 0.1, 0.001, 0.16);

    var roll = rand();
    if (roll < pInt) {
      out.completion = false; out.turnover = 'interception';
      out.airYards = Math.round(depth);
      out.tackler = pick(rand, (du.cb.players.concat(du.s.players)).length
        ? du.cb.players.concat(du.s.players) : du.lb.players);
      out.interceptor = out.tackler;
      out.notes.push(sep < 0 ? 'Thrown into coverage.' : 'Jumped the route.');
      out.yards = 0;
      out.target = targetPlayer(ou, target, rand);
      tire(off, ['OL', 'WR', 'QB'], 1); tire(def, ['DL', 'CB', 'S'], 1);
      return out;
    }

    out.target = targetPlayer(ou, target, rand);
    out.targetSlot = target ? target.slot : null;
    out.route = target ? target.route : null;
    out.airYards = Math.round(depth);

    if (rand() >= pComp) {
      out.completion = false; out.incomplete = true; out.yards = 0;
      out.notes.push(pressured ? 'Off his back foot, and away.'
        : sep < 0 ? 'Covered — no window.' : 'Off the mark.');
      tire(off, ['OL', 'WR', 'QB'], 0.8); tire(def, ['DL', 'CB', 'S'], 0.8);
      return out;
    }

    /* CAUGHT. What happens next is separation, legs and tackling. */
    out.completion = true;
    var hands = target && target.slot === 'RB' ? ou.rb.hnd : target && target.slot === 'TE' ? ou.te.hnd : ou.wr.hnd;
    if (rand() > clamp(0.90 + (hands - 62) / 260 - (pressured ? 0.02 : 0), 0.68, 0.985)) {
      out.completion = false; out.incomplete = true; out.drop = true; out.yards = 0;
      out.notes.push('Dropped. It was there.');
      return out;
    }
    var speedEdge = ((target && target.slot === 'RB' ? ou.rb.spd : target && target.slot === 'TE' ? ou.te.spd : ou.wr.spd)
                     - (du.s.tkl * 0.4 + du.lb.spd * 0.3 + du.cb.tkl * 0.3)) / 38;
    /* THE BLITZ-BEATER. Send six and the ball comes out behind them: eleven
       defenders running at the quarterback are eleven defenders not covering
       grass. It is why the quick game and the screen are the answers to
       pressure, and it is worth more than the coverage it costs. */
    var blitzBeat = (playObj.concept === 'quick' || playObj.concept === 'screen')
      ? parts.pressure.rush * 26 : 0;
    var yacBase = Math.max(0, sep * 6.0 + speedEdge + blitzBeat
                             + (playObj.concept === 'screen' ? 4.8 : 0)
                             + (band === 'short' ? 1.7 : band === 'int' ? 1.9 : 1.2));
    var yac = Math.max(0, yacBase * (0.40 + rand() * 1.05));
    var pBig = clamp(playObj.boom * 0.55 + Math.max(0, speedEdge) * 0.05 + Math.max(0, sep) * 0.18
                     + parts.fit.boom * 0.5, 0.005, 0.42);
    if (rand() < pBig) { yac += 6 + expo(rand, 12 + speedEdge * 5); out.big = true; }
    out.yac = Math.round(yac);
    out.yards = Math.round(depth + yac);
    out.tackler = tacklerFor(du, rand, out.yards);
    out.outOfBounds = (target && target.zone === 'out') ? rand() < 0.42 : rand() < 0.13;

    var pFum = clamp(0.0055 + (out.big ? 0.004 : 0) - (hands - 62) / 5000, 0.0008, 0.03);
    if (rand() < pFum) { out.turnover = 'fumble'; out.notes.push('Punched out after the catch.'); }

    tire(off, ['OL', 'WR', 'QB', 'TE'], 1); tire(def, ['DL', 'CB', 'S', 'LB'], 1);
    if (rand() < 0.4) maybeInjure(off, out.target, rand, 1.1);
    return out;
  }

  function targetPlayer(ou, target, rand) {
    if (!target) return ou.wr.players[0] || null;
    if (target.slot === 'RB') return ou.rb.players[0] || null;
    if (target.slot === 'TE') return ou.te.players[0] || null;
    var i = target.slot === 'X' ? 0 : target.slot === 'Z' ? 1 : target.slot === 'SL' ? 2 : 3;
    return ou.wr.players[Math.min(i, Math.max(0, ou.wr.players.length - 1))] || null;
  }

  /* ── SPECIAL TEAMS ──────────────────────────────────────────────────────── */
  function fieldGoal(ou, du, ball, rand, clutch) {
    var dist = (100 - ball) + 17;                    /* end zone plus the hold */
    var leg = ou.k.pwr, acc = ou.k.acc, clu = ou.k.clu;
    /* out of range is out of range: a 70-yarder is not a coin flip */
    var maxRange = 42 + leg * 0.36;
    var z = 1.95 - (dist - 25) * 0.090 + (acc - 62) / 22 + (leg - 62) / 34
          + (clutch ? (clu - 62) / 40 : 0);
    var p = dist > maxRange ? clamp(logistic(z) * 0.25, 0.005, 0.30) : clamp(logistic(z), 0.02, 0.985);
    return { distance: Math.round(dist), good: rand() < p, p: Math.round(p * 100) / 100,
             range: Math.round(maxRange) };
  }
  function punt(ou, ball, rand) {
    var leg = ou.p.pwr, acc = ou.p.acc;
    var gross = 38 + (leg - 62) * 0.30 + norm(rand) * 5.5;
    gross = clamp(gross, 22, 68);
    var land = ball + gross;
    if (land >= 100) {                                /* into the end zone, or pinned */
      return { touchback: rand() < clamp(0.74 - (acc - 62) / 260, 0.55, 0.92),
               gross: Math.round(gross), at: Math.max(90, Math.min(97, Math.round(land - 4 - rand() * 5))) };
    }
    var ret = rand() < 0.35 ? Math.max(0, Math.round(expo(rand, 7))) : 0;
    return { touchback: false, gross: Math.round(gross), ret: ret, at: Math.round(land - ret) };
  }
  function kickoff(ou, rand) {
    var leg = ou.k.pwr;
    if (rand() < clamp(0.42 + (leg - 62) / 90, 0.12, 0.92)) return { touchback: true, at: RULES.touchback };
    var ret = 18 + expo(rand, 9);
    if (rand() < 0.012) return { touchback: false, at: 100, house: true };
    return { touchback: false, at: Math.round(clamp(RULES.kickoff_from - 35 + ret, 5, 60)) };
  }

  /* ── THE GAME ───────────────────────────────────────────────────────────── */
  function createGame(opts) {
    opts = opts || {};
    var seed = typeof opts.seed === 'number' ? opts.seed : R.hash(opts.seed || 'game');
    var home = makeTeam(opts.home), away = makeTeam(opts.away);
    home.mods.home = opts.neutral ? 0 : (opts.homeEdge == null ? 1.5 : opts.homeEdge);
    var cfg = {
      quarters: opts.quarters || RULES.quarters,
      quarterSeconds: opts.quarterSeconds || RULES.quarter_seconds,
      user: opts.user || 'home',                  /* which side the player coaches */
      difficulty: opts.difficulty || 'pro',
      overtime: opts.overtime !== false
    };
    var rand = rng(seed);
    /* TWO STREAMS, ON PURPOSE. `rand` resolves football and nothing else;
       `aiRand` is what the coaches think with. A saved game is replayed from
       its CALL LIST, so the AI's own draws never happen again — and if the two
       shared a stream, every replayed play would land somewhere different.
       Separating them is what makes "close the tab, come back to 3rd and 7"
       exact rather than approximate. */
    var aiRand = rng((seed ^ 0x9E3779B9) >>> 0);
    var receivesFirst = rand() < 0.5 ? 'away' : 'home';
    var g = {
      version: ENGINE_VERSION, seed: seed, cfg: cfg, rand: rand, aiRand: aiRand, tick: 0,
      home: home, away: away,
      score: { home: 0, away: 0 },
      quarter: 1, clock: cfg.quarterSeconds, half: 1,
      possession: receivesFirst, receivesFirst: receivesFirst,
      secondHalfKick: receivesFirst,
      ball: RULES.touchback, down: 1, toGo: 10,
      timeouts: { home: 3, away: 3 },
      phase: 'kickoff',
      pendingScore: null,
      drives: [], plays: [], log: [],
      mem: { home: newMemory(), away: newMemory() },
      defMem: { home: newMemory(), away: newMemory() },
      stats: { home: newStats(), away: newStats() },
      players: {},
      over: false, ot: 0, otPossessions: 0
    };
    return g;
  }

  function newStats() {
    return { plays: 0, yards: 0, passYards: 0, rushYards: 0, att: 0, comp: 0, sacks: 0,
             sackYards: 0, carries: 0, ints: 0, fumblesLost: 0, firstDowns: 0,
             thirdAtt: 0, thirdConv: 0, fourthAtt: 0, fourthConv: 0,
             redzoneAtt: 0, redzoneTD: 0, explosive: 0, drives: 0, top: 0,
             punts: 0, puntYards: 0, fgAtt: 0, fgMade: 0, pressures: 0, tacklesForLoss: 0 };
  }
  function pstat(g, player) {
    if (!player) return null;
    var k = player.id;
    if (!g.players[k]) g.players[k] = { id: k, name: R.name(player), position: player.position,
      pa: 0, pc: 0, py: 0, ptd: 0, pint: 0, car: 0, ry: 0, rtd: 0, rec: 0, recy: 0, rectd: 0,
      tkl: 0, sack: 0, tfl: 0, int: 0, pd: 0, fg: 0, fga: 0, xp: 0, xpa: 0 };
    return g.players[k];
  }

  function other(side) { return side === 'home' ? 'away' : 'home'; }
  function teamOf(g, side) { return side === 'home' ? g.home : g.away; }
  function toGoal(g) { return 100 - g.ball; }

  /* what the page needs to show, and the AI needs to think */
  function situation(g) {
    var off = g.possession, def = other(off);
    return {
      phase: g.phase, quarter: g.quarter, clock: g.clock, half: g.half,
      offense: off, defense: def,
      ball: g.ball, down: g.down, toGo: g.toGo, toGoal: toGoal(g),
      score: { off: g.score[off], def: g.score[def], home: g.score.home, away: g.score.away },
      diff: g.score[off] - g.score[def],
      timeouts: g.timeouts, over: g.over,
      secondsLeft: secondsLeft(g),
      redzone: toGoal(g) <= 20, goalToGo: g.toGo >= toGoal(g),
      twoMinute: g.quarter % 2 === 0 && g.clock <= 120
    };
  }
  function secondsLeft(g) {
    var qLeft = Math.max(0, g.cfg.quarters - g.quarter);
    return g.clock + qLeft * g.cfg.quarterSeconds;
  }
  function clockLabel(g) {
    var m = Math.floor(g.clock / 60), s = Math.floor(g.clock % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  /* ── clock and quarter ──────────────────────────────────────────────────── */
  function runClock(g, secs) {
    g.clock -= secs;
    while (g.clock <= 0) {
      var carry = -g.clock;
      if (g.quarter >= g.cfg.quarters) {
        g.clock = 0;
        /* AN OVERTIME PERIOD THAT RUNS OUT LEVEL BUYS ANOTHER ONE. Four is the
           limit: after that it is a tie, which is a real football result and
           a better one than a loop that never ends. */
        if (g.score.home === g.score.away && g.cfg.overtime && g.ot < 4) { startOT(g); return; }
        g.over = true; g.phase = 'final'; return;
      }
      g.quarter++;
      g.clock = g.cfg.quarterSeconds - Math.min(carry, g.cfg.quarterSeconds - 1);
      if (g.quarter === 3) {
        g.half = 2;
        halftime(g);
        return;
      }
      g.log.push({ kind: 'quarter', quarter: g.quarter });
    }
  }
  function halftime(g) {
    g.half = 2;
    g.phase = 'halftime';
    g.possession = other(g.secondHalfKick);
    g.log.push({ kind: 'halftime', score: { home: g.score.home, away: g.score.away } });
    rest(g.home, 45); rest(g.away, 45);
    g.timeouts = { home: 3, away: 3 };
  }
  function startOT(g) {
    g.ot++; g.otPossessions = 0;
    g.quarter = g.cfg.quarters + g.ot;
    g.clock = RULES.ot_seconds;
    g.phase = 'kickoff';
    g.possession = g.rand() < 0.5 ? 'home' : 'away';
    g.timeouts = { home: 2, away: 2 };
    g.log.push({ kind: 'overtime', n: g.ot });
  }

  /* ── drives ─────────────────────────────────────────────────────────────── */
  function startDrive(g, side, at) {
    g.possession = side; g.ball = at; g.down = 1;
    g.toGo = Math.min(10, toGoal(g));
    g.phase = 'play';
    g.drive = { side: side, start: at, plays: 0, yards: 0, startClock: secondsLeft(g),
                startQuarter: g.quarter, outcome: null, seconds: 0 };
    g.stats[side].drives++;
  }
  function endDrive(g, outcome, points) {
    if (!g.drive) return;
    g.drive.outcome = outcome;
    g.drive.points = points || 0;
    g.drive.seconds = Math.max(0, g.drive.startClock - secondsLeft(g));
    g.stats[g.drive.side].top += g.drive.seconds;
    /* WHAT A DRIVE IS WORTH TO THE MEN WHO WERE NOT ON THE FIELD FOR IT.
       A four-minute drive is four minutes your defence spent sitting down;
       a three-and-out in forty seconds sends them straight back out. It is
       the real cost of playing fast, and the real reward for grinding. */
    var rec = clamp(g.drive.seconds / 8, 5, 45);
    rest(teamOf(g, g.drive.side), rec, DEF_POS);
    rest(teamOf(g, other(g.drive.side)), rec, OFF_POS);
    g.drives.push(g.drive);
    g.drive = null;
  }

  /* ── scoring ────────────────────────────────────────────────────────────── */
  function score(g, side, points, how) {
    g.score[side] += points;
    g.log.push({ kind: 'score', side: side, points: points, how: how,
                 score: { home: g.score.home, away: g.score.away },
                 quarter: g.quarter, clock: g.clock });
  }
  function touchdown(g, side, res) {
    score(g, side, 6, 'touchdown');
    endDrive(g, 'td', 6);
    g.pendingScore = { side: side };
    g.phase = 'pat';
    runClock(g, CLOCK.score);
  }
  function afterKickoffSetup(g, kicking) {
    var k = kickoff(unitsOf(teamOf(g, kicking), g.tick), g.rand);
    var receiving = other(kicking);
    if (k.house) {
      score(g, receiving, 6, 'kick return');
      g.pendingScore = { side: receiving };
      g.phase = 'pat';
      g.log.push({ kind: 'play', text: 'Taken all the way on the return.' });
      return;
    }
    startDrive(g, receiving, k.touchback ? RULES.touchback : k.at);
    runClock(g, CLOCK.kick);
  }

  /* ── HALFTIME ADJUSTMENTS ────────────────────────────────────────────────
     Six, each one hooking a single real term. They are small on purpose: a
     halftime adjustment is worth a couple of points, not a different game. */
  var ADJUSTMENTS = [
    { key: 'protect', side: 'off', name: 'Protect the quarterback',
      means: 'Keep a back in and cut the route tree. Less pressure, shorter throws.',
      apply: { protect: 1 } },
    { key: 'outside', side: 'off', name: 'Attack the edge',
      means: 'Get the ball outside the tackles and make them run to it.',
      apply: { outsideRun: 0.9 } },
    { key: 'tempo', side: 'off', name: 'Push the tempo',
      means: 'No huddle. More possessions for both of you.',
      apply: { tempo: 0.86 } },
    { key: 'box', side: 'def', name: 'Load the box',
      means: 'Another body in the run fits. It costs you over the top.',
      apply: { runFit: 0.045, deepCover: -0.02 } },
    { key: 'deep', side: 'def', name: 'Play deeper',
      means: 'Cap everything. They can have the underneath.',
      apply: { deepCover: 0.055, runFit: -0.02 } },
    { key: 'pressure', side: 'def', name: 'Bring more pressure',
      means: 'Rush an extra man more often. It is a bet, and you know the price.',
      apply: { rush: 0.05, deepCover: -0.02 } }
  ];
  function adjustment(key) {
    var out = null;
    ADJUSTMENTS.forEach(function (a) { if (a.key === key) out = a; });
    return out;
  }
  function applyAdjustment(g, side, key) {
    var a = adjustment(key);
    if (!a) return null;
    var t = teamOf(g, side), k;
    for (k in a.apply) if (a.apply.hasOwnProperty(k)) {
      t.mods[k] = (k === 'tempo' ? 1 : 0) === 1 ? a.apply[k] : (t.mods[k] || 0) + a.apply[k];
    }
    if (a.apply.tempo != null) t.mods.tempo = a.apply.tempo;
    g.log.push({ kind: 'adjustment', side: side, key: key, name: a.name });
    return a;
  }

  /* ── the public step ────────────────────────────────────────────────────
     call: { type: 'play', play, formation, def } for a snap
           { type: 'punt' | 'fieldgoal' | 'kickoff' | 'pat' | 'two' |
             'timeout' | 'kneel' | 'spike' | 'halftime_done' }
     `def` is the defensive call for whichever side is defending. */
  function step(g, call) {
    if (g.over) return { ok: false, reason: 'final' };
    call = call || {};
    g.tick++;

    if (g.phase === 'halftime') {
      if (call.type !== 'halftime_done') return { ok: false, reason: 'halftime' };
      if (call.adjust) applyAdjustment(g, g.cfg.user, call.adjust);
      if (call.oppAdjust) applyAdjustment(g, other(g.cfg.user), call.oppAdjust);
      g.phase = 'kickoff';
      g.pendingKick = g.secondHalfKick;
      return kickoffStep(g, g.secondHalfKick);
    }
    if (g.phase === 'kickoff') {
      var kicking = g.pendingKick != null ? g.pendingKick
        : (g.drives.length === 0 ? other(g.receivesFirst) : other(g.possession));
      return kickoffStep(g, kicking);
    }
    if (g.phase === 'pat') return patStep(g, call);
    if (g.phase !== 'play') return { ok: false, reason: g.phase };

    if (call.type === 'timeout') {
      var s = call.side || g.possession;
      if (g.timeouts[s] <= 0) return { ok: false, reason: 'no timeouts' };
      g.timeouts[s]--;
      g.log.push({ kind: 'timeout', side: s });
      return { ok: true, event: 'timeout', state: situation(g) };
    }
    if (call.type === 'punt') return puntStep(g);
    if (call.type === 'fieldgoal') return fgStep(g);
    return playStep(g, call);
  }

  function kickoffStep(g, kicking) {
    g.pendingKick = null;
    afterKickoffSetup(g, kicking);
    return { ok: true, event: 'kickoff', state: situation(g) };
  }

  function patStep(g, call) {
    var side = g.pendingScore.side, def = other(side);
    var ou = unitsOf(teamOf(g, side), g.tick);
    var res;
    if (call.type === 'two') {
      var r = resolve({
        off: teamOf(g, side), def: teamOf(g, def), rand: g.rand, tick: g.tick,
        playKey: call.play || 'power', formKey: call.formation || 'goalline',
        defCall: call.def || 'goal_line_d',
        sit: { down: 1, toGo: 3, ball: RULES.two_point_from }, mem: g.mem[side]
      });
      var good = r.yards >= 3 && !r.turnover;
      if (good) score(g, side, 2, 'two-point');
      res = { ok: true, event: 'two_point', good: good, play: r, state: null };
      g.log.push({ kind: 'pat', side: side, two: true, good: good });
    } else {
      var made = g.rand() < clamp(0.945 + (ou.k.acc - 62) / 700, 0.85, 0.995);
      if (made) score(g, side, 1, 'extra point');
      var ks = pstat(g, ou.k.player); if (ks) { ks.xpa++; if (made) ks.xp++; }
      res = { ok: true, event: 'pat', good: made, state: null };
      g.log.push({ kind: 'pat', side: side, two: false, good: made });
    }
    g.pendingScore = null;
    if (g.ot) {
      g.otPossessions++;
      if (otDone(g)) { g.over = true; g.phase = 'final'; res.state = situation(g); return res; }
      g.phase = 'kickoff'; g.pendingKick = side;
    } else if (g.over || (g.clock <= 0 && g.quarter >= g.cfg.quarters)) {
      g.over = true; g.phase = 'final';
    } else {
      g.phase = 'kickoff'; g.pendingKick = side;
    }
    res.state = situation(g);
    return res;
  }

  function otDone(g) {
    /* both sides have had it and somebody is ahead */
    return g.otPossessions >= 2 && g.score.home !== g.score.away;
  }

  function changePossession(g, at, how) {
    var was = g.possession;
    if (g.ot) {
      g.otPossessions++;
      if (otDone(g)) { g.over = true; g.phase = 'final'; return; }
    }
    startDrive(g, other(was), clamp(at, 1, 99));
    g.log.push({ kind: 'change', how: how, side: g.possession, at: g.ball });
  }

  function puntStep(g) {
    var side = g.possession, t = teamOf(g, side);
    var p = punt(unitsOf(t, g.tick), g.ball, g.rand);
    g.stats[side].punts++; g.stats[side].puntYards += p.gross;
    endDrive(g, 'punt', 0);
    runClock(g, CLOCK.kick);
    if (g.over) return { ok: true, event: 'punt', punt: p, state: situation(g) };
    var at = p.touchback ? 100 - RULES.touchback : 100 - p.at;
    g.log.push({ kind: 'punt', side: side, gross: p.gross, touchback: !!p.touchback });
    if (g.phase === 'halftime') return { ok: true, event: 'punt', punt: p, state: situation(g) };
    changePossession(g, clamp(at, 1, 99), 'punt');
    return { ok: true, event: 'punt', punt: p, state: situation(g) };
  }

  function fgStep(g) {
    var side = g.possession, t = teamOf(g, side), ou = unitsOf(t, g.tick);
    var clutch = g.quarter >= g.cfg.quarters && Math.abs(g.score.home - g.score.away) <= 3;
    var k = fieldGoal(ou, unitsOf(teamOf(g, other(side)), g.tick), g.ball, g.rand, clutch);
    g.stats[side].fgAtt++;
    var ks = pstat(g, ou.k.player); if (ks) ks.fga++;
    if (k.good) {
      g.stats[side].fgMade++; if (ks) ks.fg++;
      score(g, side, 3, 'field goal');
      endDrive(g, 'fg', 3);
      runClock(g, CLOCK.score);
      if (g.ot) {
        g.otPossessions++;
        if (otDone(g)) { g.over = true; g.phase = 'final'; return { ok: true, event: 'fieldgoal', fg: k, state: situation(g) }; }
      }
      if (!g.over && g.phase !== 'halftime') { g.phase = 'kickoff'; g.pendingKick = side; }
      return { ok: true, event: 'fieldgoal', fg: k, state: situation(g) };
    }
    endDrive(g, 'fg_miss', 0);
    runClock(g, CLOCK.kick);
    if (g.over || g.phase === 'halftime') return { ok: true, event: 'fieldgoal', fg: k, state: situation(g) };
    changePossession(g, clamp(100 - Math.max(g.ball, 80), 1, 99), 'missed field goal');
    return { ok: true, event: 'fieldgoal', fg: k, state: situation(g) };
  }

  /* ── one snap, through the machine ──────────────────────────────────────── */
  function playStep(g, call) {
    var side = g.possession, def = other(side);
    var offT = teamOf(g, side), defT = teamOf(g, def);
    var playKey = call.play || 'inside_zone';
    var playObj = F.play(playKey);
    var formKey = call.formation || F.playForms(playKey, offT.offense)[0] || playObj.forms[0];
    var sit = situation(g);

    var r = resolve({
      off: offT, def: defT, rand: g.rand, tick: g.tick,
      playKey: playKey, formKey: formKey, defCall: call.def || 'base_3',
      sit: sit, mem: g.mem[side],
      /* what the hands did: which read, which lane, how quickly */
      userRead: call.read == null ? null : call.read,
      userLane: call.lane == null ? null : call.lane,
      userTiming: call.timing == null ? null : call.timing,
      userScramble: !!call.scramble
    });
    noteCall(g.mem[side], playObj.key, playObj.group);
    noteCall(g.defMem[def], r.def, 'def');

    var st = g.stats[side], dst = g.stats[def];
    st.plays++;
    if (g.drive) g.drive.plays++;

    /* ── stats ─────────────────────────────────────────────────────────── */
    var ou = unitsOf(offT, g.tick);
    var qbs = pstat(g, ou.qb.player);
    if (r.sack) {
      st.sacks++; st.sackYards += -r.yards; dst.pressures++;
      var sk = pstat(g, r.tackler); if (sk) { sk.sack++; sk.tkl++; }
    } else if (playObj.type === 'pass' && !r.scramble && playObj.concept !== 'spike') {
      st.att++; if (qbs) qbs.pa++;
      if (r.completion) {
        st.comp++;
        if (qbs) { qbs.pc++; qbs.py += r.yards; }
        var rc = pstat(g, r.target);
        if (rc) { rc.rec++; rc.recy += r.yards; }
        st.passYards += r.yards;
      } else if (r.turnover === 'interception') {
        st.ints++; if (qbs) { qbs.pa = qbs.pa; qbs.pint++; }
        var itc = pstat(g, r.interceptor); if (itc) itc.int++;
      }
      if (r.pressure) dst.pressures++;
    } else if (playObj.type === 'run' || r.scramble) {
      st.carries++; st.rushYards += r.yards;
      var cs = pstat(g, r.carrier);
      if (cs) { cs.car++; cs.ry += r.yards; }
      if (r.yards < 0) dst.tacklesForLoss++;
    }
    var tk = pstat(g, r.tackler); if (tk && !r.sack) tk.tkl++;
    if (r.big) st.explosive++;
    st.yards += r.yards;
    if (g.drive) g.drive.yards += r.yards;
    if (g.down === 3) st.thirdAtt++;
    if (g.down === 4) st.fourthAtt++;
    if (sit.redzone && g.down === 1) st.redzoneAtt++;

    /* ── the rules ─────────────────────────────────────────────────────── */
    var startBall = g.ball;
    var newBall = clamp(g.ball + r.yards, -10, 110);
    var event = 'play', points = 0;

    /* safety */
    if (newBall <= 0 && r.yards < 0) {
      score(g, def, 2, 'safety');
      endDrive(g, 'safety', -2);
      runClock(g, CLOCK.run);
      r.safety = true;
      if (!g.over && g.phase !== 'halftime') {
        startDrive(g, def, RULES.safety_punt_from + 15);
        g.log.push({ kind: 'change', how: 'safety', side: def, at: g.ball });
      }
      return finish(g, r, 'safety', startBall);
    }

    if (r.turnover) {
      var spot = r.turnover === 'interception'
        ? clamp(100 - (g.ball + r.airYards + Math.round(g.rand() * 8)), 1, 99)
        : clamp(100 - newBall, 1, 99);
      dst.plays = dst.plays;
      if (r.turnover === 'fumble') { st.fumblesLost++; }
      endDrive(g, r.turnover, 0);
      runClock(g, CLOCK.change);
      if (!g.over && g.phase !== 'halftime') changePossession(g, spot, r.turnover);
      return finish(g, r, r.turnover, startBall);
    }

    if (newBall >= 100) {
      r.touchdown = true;
      r.yards = 100 - startBall;
      if (playObj.type === 'run' || r.scramble) { var c2 = pstat(g, r.carrier); if (c2) c2.rtd++; }
      else { var t2 = pstat(g, r.target); if (t2) t2.rectd++; if (qbs) qbs.ptd++; }
      if (sit.redzone) st.redzoneTD++;
      st.firstDowns++;
      touchdown(g, side, r);
      return finish(g, r, 'touchdown', startBall);
    }

    g.ball = newBall;
    var gained = r.yards;
    if (gained >= g.toGo) {
      if (g.down === 3) st.thirdConv++;
      if (g.down === 4) st.fourthConv++;
      st.firstDowns++;
      r.firstDown = true;
      g.down = 1; g.toGo = Math.min(10, toGoal(g));
    } else {
      g.down++;
      g.toGo = g.toGo - gained;
      if (g.down > 4) {
        endDrive(g, 'downs', 0);
        runClock(g, CLOCK.change);
        if (!g.over && g.phase !== 'halftime') changePossession(g, clamp(100 - g.ball, 1, 99), 'downs');
        return finish(g, r, 'downs', startBall);
      }
    }

    /* the clock */
    var tempo = (call.tempo === 'hurry' ? CLOCK.hurry : call.tempo === 'grind' ? CLOCK.grind : CLOCK.normal)
              * (offT.mods.tempo == null ? 1 : offT.mods.tempo);
    var secs;
    if (playObj.concept === 'spike') secs = CLOCK.spike;
    else if (playObj.concept === 'kneel') secs = CLOCK.kneel;
    else if (r.sack) secs = CLOCK.sack * tempo;
    else if (r.incomplete) secs = CLOCK.pass_incomplete;
    else if (r.outOfBounds && (sit.twoMinute || g.quarter === g.cfg.quarters)) secs = CLOCK.out_of_bounds;
    else if (playObj.type === 'run' || r.scramble) secs = CLOCK.run * tempo;
    else secs = CLOCK.pass_complete * tempo;
    runClock(g, Math.round(secs));
    r.seconds = Math.round(secs);

    return finish(g, r, event, startBall);
  }

  function finish(g, r, event, startBall) {
    r.startBall = startBall;
    r.commentary = narrate(g, r);
    g.plays.push({ q: g.quarter, clock: g.clock, side: r.side || g.possession,
                   play: r.play, def: r.def, yards: r.yards, text: r.commentary,
                   td: !!r.touchdown, to: r.turnover || null });
    return { ok: true, event: event, play: r, state: situation(g) };
  }

  /* ── COMMENTARY ─────────────────────────────────────────────────────────
     It teaches. Every line names the football reason the play worked or did
     not: the coverage, the box, the leverage, the pressure. */
  function narrate(g, r) {
    var F2 = F, cov = F2.COVERAGES[r.coverage], p = F2.play(r.play);
    var who = r.carrier ? R.shortName(r.carrier) : r.target ? R.shortName(r.target) : '';
    var tk = r.tackler ? R.shortName(r.tackler) : '';
    if (r.play === 'kneel') return 'Takes a knee.';
    if (r.play === 'spike') return 'Spikes it. Clock stopped.';
    if (r.sack) return (tk ? tk + ' gets home. ' : 'Pressure gets home. ')
      + (r.pressureCall && r.pressureCall !== 'none' ? F2.PRESSURES[r.pressureCall].name + ' — ' : '')
      + 'Sack for ' + r.yards + '.';
    if (r.turnover === 'interception')
      return 'Intercepted' + (tk ? ' by ' + tk : '') + '. ' + (r.separation < 0
        ? 'Thrown into ' + cov.name + ' with nobody open.' : cov.name + ' broke on it.');
    if (r.turnover === 'fumble') return who + ' fumbles — ' + (tk ? tk + ' recovers.' : 'they recover.');
    if (r.touchdown) return who + ' scores. ' + (r.big ? 'Nobody laid a hand on him.' : p.name + ' from ' + Math.abs(r.startBall - 100) + ' out.');
    if (r.scramble) return 'Nothing open — he takes off for ' + r.yards + '.';
    if (r.drop) return 'Dropped by ' + who + '. It was there against ' + cov.name + '.';
    if (r.incomplete) return 'Incomplete' + (who ? ' for ' + who : '') + '. '
      + (r.pressure ? 'He had somebody in his face.' : cov.name + ' had it covered.');
    if (p.type === 'run') {
      var lead = r.big ? who + ' breaks it for ' + r.yards
        : r.yards <= 0 ? (tk ? tk + ' stops ' + who : who + ' stopped') + ' for ' + r.yards
        : who + ' for ' + r.yards;
      var why = r.box >= 7.8 ? ' — they had ' + Math.round(r.box) + ' in the box'
        : r.box <= 6.2 ? ' — light box, and ' + p.name + ' took it'
        : r.read ? ' — they read it' : '';
      return lead + why + '.';
    }
    var gain = who + ' for ' + r.yards + (r.yac ? ' (' + r.yac + ' after the catch)' : '');
    var reason = r.big ? ' — ' + cov.name + ' had nobody over the top'
      : r.separation > 0.15 ? ' — ' + p.name + ' found the hole in ' + cov.name
      : r.pressure ? ' — got it out just in time' : '';
    return gain + reason + '.';
  }

  /* ── the box score ──────────────────────────────────────────────────────── */
  function boxScore(g) {
    function side(s) {
      var st = g.stats[s];
      return {
        score: g.score[s], plays: st.plays, yards: st.yards,
        passYards: st.passYards, rushYards: st.rushYards,
        att: st.att, comp: st.comp, sacks: st.sacks, ints: st.ints,
        fumblesLost: st.fumblesLost, turnovers: st.ints + st.fumblesLost,
        firstDowns: st.firstDowns,
        third: st.thirdAtt ? st.thirdConv + '/' + st.thirdAtt : '0/0',
        thirdPct: st.thirdAtt ? Math.round(100 * st.thirdConv / st.thirdAtt) : 0,
        fourth: st.fourthAtt ? st.fourthConv + '/' + st.fourthAtt : '0/0',
        redzone: st.redzoneAtt ? st.redzoneTD + '/' + st.redzoneAtt : '0/0',
        explosive: st.explosive, top: st.top, drives: st.drives,
        punts: st.punts, fg: st.fgMade + '/' + st.fgAtt,
        ypp: st.plays ? Math.round(10 * st.yards / st.plays) / 10 : 0,
        ypc: st.carries ? Math.round(10 * st.rushYards / st.carries) / 10 : 0,
        ypa: st.att ? Math.round(10 * st.passYards / st.att) / 10 : 0
      };
    }
    return { home: side('home'), away: side('away'), players: g.players,
             score: { home: g.score.home, away: g.score.away },
             drives: g.drives, plays: g.plays, log: g.log,
             injuries: { home: g.home.injuries, away: g.away.injuries } };
  }

  /* PLAYER OF THE GAME — the one line a result is remembered by. */
  function playerOfGame(g, side) {
    var best = null, bestScore = -1, k, p, s;
    for (k in g.players) {
      if (!g.players.hasOwnProperty(k)) continue;
      p = g.players[k];
      s = p.py * 0.045 + p.ptd * 4 - p.pint * 3
        + p.ry * 0.11 + p.rtd * 6
        + p.recy * 0.11 + p.rectd * 6
        + p.tkl * 0.7 + p.sack * 4 + p.int * 7 + p.fg * 3;
      if (s > bestScore) { bestScore = s; best = p; }
    }
    return best;
  }

  var API = {
    VERSION: ENGINE_VERSION, RULES: RULES, CLOCK: CLOCK,
    rng: rng, norm: norm, expo: expo, clamp: clamp, logistic: logistic,
    mods: mods, makeTeam: makeTeam, unitsOf: unitsOf,
    ADJUSTMENTS: ADJUSTMENTS, adjustment: adjustment, applyAdjustment: applyAdjustment,
    newMemory: newMemory, tendency: tendency, noteCall: noteCall,
    recognition: recognition, boxCount: boxCount, passRush: passRush,
    resolve: resolve, fieldGoal: fieldGoal, punt: punt, kickoff: kickoff,
    createGame: createGame, step: step, situation: situation, secondsLeft: secondsLeft,
    clockLabel: clockLabel, boxScore: boxScore, playerOfGame: playerOfGame,
    other: other, teamOf: teamOf, toGoal: toGoal, narrate: narrate,
    freshness: freshness, startDrive: startDrive
  };
  root.EDGridiron = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
