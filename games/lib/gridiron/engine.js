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

  /* ── THE CLOCK ────────────────────────────────────────────────────────────
     A snap costs two things: the PLAY, which is however long the football
     took, and the DEAD BALL after it, which is only charged when the clock
     kept running between snaps. Splitting them is the whole reason an
     incompletion, a trip out of bounds and a timeout are worth anything —
     each of them removes the dead ball and leaves the play.

     `dead` is what the offence stands around for; tempo scales that and only
     that, because no huddle makes a team line up faster, not run faster. */
  var CLOCK = {
    /* the play */
    run: 7, pass_complete: 5, pass_incomplete: 7, sack: 8, scramble: 7,
    out_of_bounds: 8, spike: 3, kneel: 2,
    /* whistle to snap, with the clock running */
    dead: 29, kneel_dead: 39,
    /* whole events, which carry their own dead ball */
    kick: 12, change: 15, score: 20,
    /* tempo, applied to the dead ball */
    hurry: 0.5, normal: 1, grind: 1.24
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
      rush: +o.rush || 0,
      /* the other half of an adjustment: what it costs */
      shortRoutes: +o.shortRoutes || 0,
      insideRun: +o.insideRun || 0,
      fatigue: +o.fatigue || 0
    };
  }

  /* ── WEATHER ──────────────────────────────────────────────────────────────
     Modest on purpose. A wet ball is worth a couple of drops and the odd
     fumble; a gale is worth about ten yards of field goal range and the deep
     ball. Weather should change a decision, never decide a game — so every
     term below is small, and a clear sixty-degree day is exactly zero, which
     is what keeps a game with no weather in it identical to one before this
     existed.

       wind    field goal range and accuracy, and the throw over the top
       rain    hands, ball security, and what a cut is worth underfoot
       cold    a little off the hands and a little more off the legs  */
  function weatherOf(w) {
    w = w || {};
    var kind = w.kind || w.weather || 'clear';
    var wind = clamp(+w.wind || 0, 0, 45);
    var temp = w.temp == null ? 62 : +w.temp;
    var wet = kind === 'rain' ? 1 : kind === 'snow' ? 1.25 : 0;
    var cold = clamp((44 - temp) / 44, 0, 1);
    return {
      kind: kind, wind: wind, temp: temp, sky: w.sky || null,
      kickRange: -wind * 0.22 - cold * 2.6,
      kickAcc: -(wind / 100) * 1.05 - cold * 0.10,
      deepAcc: -(wind / 100) * 0.60 - wet * 0.07,
      shortAcc: -wet * 0.04 - cold * 0.02,
      hands: -wet * 0.055 - cold * 0.025,
      fumble: wet * 0.006,
      footing: -wet * 0.07,
      stamina: 1 + cold * 0.12 + wet * 0.05,
      /* the one line a broadcast would put on the screen */
      note: wind >= 15 ? 'Wind ' + Math.round(wind) + ' mph — it will move a kick.'
          : kind === 'rain' ? 'Wet ball. Expect it on the ground at some point.'
          : kind === 'snow' ? 'Snow. Nobody is throwing it over the top today.'
          : cold > 0.35 ? 'Cold. Hands and legs both go earlier.'
          : null
    };
  }
  var CLEAR = weatherOf(null);
  function wxOf(g) { return (g && g.weather) || CLEAR; }

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

  /* ── WHICH MAN IS THIS ────────────────────────────────────────────────────
     Both rosters are generated by the same function from the same shape, so
     both come back with players numbered g0 to g39 — the same forty ids,
     twice. Everything the engine keys on a player id therefore collided:
     the box score held twenty-two rows for eighty men and merged both
     quarterbacks into one line, and in Play Mode `prepare` handed a
     defensive back's speed and hands to the receiver he was covering,
     because the second man written under `g14` won.

     A player's key is his team and his id. Nothing else in the engine reads
     `.id` directly. */
  function pid(p) { return p ? (p.uid || p.id || null) : null; }
  function tagPlayers(team, side) {
    ((team && team.players) || []).forEach(function (p) {
      if (p && !p.uid) p.uid = side + ':' + p.id;
    });
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
      d = (DRAIN[p.position] || 2) * (weight == null ? 1 : weight) * s * (team.wxStamina || 1)
        * (1 + (team.mods.fatigue || 0));
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
  function newMemory() { return { recent: [], count: {}, groups: {}, total: 0, results: [] }; }
  /* ── WHAT ACTUALLY WORKED ────────────────────────────────────────────────
     A tendency chart says what a team likes; this says what it is getting.
     Both coaches read it: the defence to take away what is hurting it, the
     offence to keep doing what is working. It is the difference between an
     opponent who calls plays and one who is watching the same game you are. */
  function noteResult(mem, playObj, yards, sit) {
    if (!mem) return;
    var need = sit && sit.toGo ? sit.toGo : 10;
    var down = sit && sit.down ? sit.down : 1;
    var win = down >= 3 ? yards >= need
            : down === 2 ? yards >= need * 0.6
            : yards >= 4;
    mem.results.push({ type: playObj.type, group: playObj.group, yards: yards, win: !!win });
    if (mem.results.length > 20) mem.results.shift();
  }
  /* yards a play of this type has been getting, and how often it moved them */
  function form(mem, type) {
    if (!mem || !mem.results || !mem.results.length) return null;
    var n = 0, y = 0, w = 0, i;
    for (i = 0; i < mem.results.length; i++) {
      if (mem.results[i].type !== type) continue;
      n++; y += mem.results[i].yards; if (mem.results[i].win) w++;
    }
    return n >= 3 ? { n: n, ypp: y / n, winRate: w / n } : null;
  }
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
  function recognition(offTeam, defTeam, formKey, playObj, mem, rand, sit) {
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

    /* THE SITUATION IS A TENDENCY OF ITS OWN. Third and eight is a passing
       down for everybody in the stadium and third and one is not, and a
       defence that does not know that is not a defence — it is a coin. This
       is what makes an obvious down an obvious down, and it is why an offence
       that can run it on third and six is worth having. */
    var expect = 0.5;
    if (sit) {
      if (sit.down >= 3) expect = sit.toGo >= 7 ? 0.82 : sit.toGo <= 2 ? 0.30 : 0.60;
      else if (sit.down === 2) expect = sit.toGo >= 8 ? 0.62 : sit.toGo <= 3 ? 0.38 : 0.50;
      if (sit.toGoal != null && sit.toGoal <= 3) expect = 0.32;
    }
    var situational = runPlay ? (1 - expect) : expect;

    var base = 0.15 + tellSays * 0.15 + iq * 0.35
             + (predictable - 0.5) * 0.80
             + (situational - 0.5) * 0.80
             + tendency(mem, playObj.key, playObj.group) * 0.75
             + defTeam.mods.recognition * 0.5;
    var p = clamp(base, 0.02, 0.88);
    return { p: p, read: rand() < p, tell: form.tell, passShare: passShare,
             expected: Math.round(expect * 100) / 100 };
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

  /* ── THE ENVIRONMENT FOR A LIVE SNAP ─────────────────────────────────────
     PLAY MODE asks the engine what the field is like, not what happens on it.

     Everything here is a CAPACITY: how fast a man runs, how hard he is to
     block, how long the protection holds, how much separation a route can
     win, how hard a catch is, how likely a tackle sticks. The same ratings,
     the same fatigue, the same scheme and halftime and home-field mods, and
     the same recognition roll the deterministic resolver uses.

     What it deliberately does NOT decide: the yards, the receiver, the lane,
     the tackle point, whether or when the ball is thrown. Those come out of
     the simulation and the user's thumbs. That separation is the whole point
     of the mode — Coach Mode keeps `resolve`, Play Mode gets `prepare`. */
  function prepare(ctx) {
    var off = ctx.off, def = ctx.def, rand = ctx.rand;
    var playObj = F.play(ctx.playKey), formKey = ctx.formKey || playObj.forms[0];
    var parts = F.defParts(ctx.defCall || ctx.defKey);
    var ou = unitsOf(off, ctx.tick), du = unitsOf(def, ctx.tick);
    var sit = ctx.sit || {};
    var mem = ctx.mem || newMemory();
    var wx = ctx.weather || CLEAR;
    var rec = recognition(off, def, formKey, playObj, mem, rand, sit);
    var box = boxCount(parts, formKey);
    var edge = (off.mods.offense - def.mods.defense) * 0.01
             + off.mods.execution - def.mods.execution * 0.5
             + off.mods.home * 0.020;
    /* how likely the pocket breaks, expressed as WHEN rather than WHETHER:
       the same number the resolver reads as a probability becomes a clock. */
    var pRush = passRush(ou, du, parts, playObj, 0, off.mods, def.mods);
    var hold = playObj.hold || 2.4;

    var env = {
      version: ENGINE_VERSION,
      playKey: playObj.key, formKey: formKey, defKey: parts.key,
      parts: parts, box: Math.round(box * 10) / 10, edge: edge,
      read: rec.read, readP: Math.round(rec.p * 100) / 100,
      /* the defence's head start, in seconds: a front that read the play
         moves on the snap, one that did not is a beat late */
      reaction: clamp(0.42 - rec.p * 0.30, 0.06, 0.46),
      /* the protection, as a stopwatch. Not "was he sacked" — "how long" */
      /* HOW LONG THE PROTECTION HOLDS, in seconds — and it has to be a number
         a quarterback can actually run out of. At one and a half times the
         play's own hold time the pocket outlasted every read on every snap
         and a live game produced one sack a fortnight; a pocket is supposed
         to be a clock the offence is racing. */
      pocket: clamp(hold * (0.95 - pRush * 0.95) + (off.mods.protect || 0) * 0.45, 0.50, 3.6),
      rushPressure: pRush,
      /* how much a route can win by, in yards, against this shell */
      separation: clamp(0.9 + (ou.wr.rte - du.cb.cov) * 0.030 - parts.coverage.short * 2.2
                        + edge * 1.6, 0.15, 3.2),
      runFit: (def.mods.runFit || 0),
      deepCover: (def.mods.deepCover || 0),
      /* the day, as the live simulation reads it */
      weather: wx,
      hands: wx.hands, footing: wx.footing, deepAcc: wx.deepAcc, fumble: wx.fumble,
      /* the outcome header, so a live play narrates and books exactly like a
         resolved one. The simulation fills in the result fields. */
      template: {
        version: ENGINE_VERSION,
        play: playObj.key, playName: playObj.name, group: playObj.group, type: playObj.type,
        formation: formKey, def: parts.key, defName: parts.name,
        front: parts.front.key, coverage: parts.coverage.key,
        pressureCall: parts.pressure.key, fit: parts.fit.key,
        box: Math.round(box * 10) / 10, read: rec.read, readP: Math.round(rec.p * 100) / 100,
        yards: 0, touchdown: false, turnover: null, sack: false, pressure: false,
        completion: null, incomplete: false, scramble: false, outOfBounds: false,
        firstDown: false, airYards: 0, yac: 0, big: false, notes: [], tackler: null,
        live: true
      },
      at: {}
    };

    /* ── EVERY MAN, AS NUMBERS THE SIMULATION CAN MOVE ────────────────────
       Ratings are 30..99; these are yards per second, yards per second
       squared and 0..1 competences. Fatigue is already inside the unit
       averages, so a fourth-quarter line really is slower. */
    function offMan(pl, pos) {
      var r = (pl && pl.ratings) || {}, ov = (pl && pl.overall) || 62;
      var spd = r.spd == null ? ov : r.spd;
      return {
        pid: pid(pl), pos: pos, ovr: ov,
        spd: liveSpeed(pos, spd), acc: liveAccel(pos, r.elu == null ? ov : r.elu),
        agi: unit(r.elu == null ? (r.rte == null ? ov : r.rte) : r.elu),
        pwr: unit(r.pwr == null ? (r.str == null ? ov : r.str) : r.pwr),
        hnd: unit(r.hnd == null ? ov : r.hnd),
        rte: unit(r.rte == null ? ov : r.rte),
        blk: unit(r.pbk == null ? (r.blk == null ? ov : r.blk) : r.pbk),
        rbk: unit(r.rbk == null ? (r.blk == null ? ov : r.blk) : r.rbk),
        arm: unit(r.arm == null ? ov : r.arm),
        accy: unit(r.acc == null ? ov : r.acc),
        iq: unit(r.iq == null ? ov : r.iq)
      };
    }
    function defMan(pl, pos) {
      var r = (pl && pl.ratings) || {}, ov = (pl && pl.overall) || 62;
      var spd = r.spd == null ? ov : r.spd;
      return {
        pid: pid(pl), pos: pos, ovr: ov,
        spd: liveSpeed(pos, spd), acc: liveAccel(pos, spd),
        agi: unit(r.spd == null ? ov : r.spd),
        tkl: unit(r.tkl == null ? (r.str == null ? ov : r.str) : r.tkl),
        cov: unit(r.cov == null ? ov : r.cov),
        rsh: unit(r.prs == null ? ov : r.prs),
        shed: unit(r.rst == null ? (r.str == null ? ov : r.str) : r.rst),
        bhk: unit(r.bhk == null ? ov : r.bhk),
        iq: unit(r.iq == null ? ov : r.iq)
      };
    }
    function put(pl, pos, side) {
      var k = pid(pl);
      if (!k) return;
      env.at[k] = side === 'off' ? offMan(pl, pos) : defMan(pl, pos);
    }
    if (ou.qb.player) put(ou.qb.player, 'QB', 'off');
    ['rb', 'wr', 'te', 'ol'].forEach(function (k) {
      var pos = k.toUpperCase();
      ((ou[k] && ou[k].players) || []).forEach(function (pl) { put(pl, pos, 'off'); });
    });
    ['dl', 'lb', 'cb', 's'].forEach(function (k) {
      var pos = k === 's' ? 'S' : k.toUpperCase();
      ((du[k] && du[k].players) || []).forEach(function (pl) { put(pl, pos, 'def'); });
    });
    /* the fallback for a man with no card: the unit average he came from */
    env.fallback = {
      off: { spd: liveSpeed('WR', ou.wr.spd), acc: liveAccel('WR', 62), agi: unit(62), pwr: unit(62),
             hnd: unit(ou.wr.hnd), rte: unit(ou.wr.rte), blk: unit(ou.ol.pbk), rbk: unit(ou.ol.rbk),
             arm: unit(ou.qb.arm), accy: unit(ou.qb.acc), iq: unit(ou.qb.iq) },
      def: { spd: liveSpeed('LB', du.lb.spd), acc: liveAccel('LB', 62), agi: unit(62),
             tkl: unit(du.lb.tkl), cov: unit(du.cb.cov), rsh: unit(du.dl.prs),
             shed: unit(du.dl.rst), bhk: unit(du.s.bhk), iq: unit(du.lb.iq) }
    };
    return env;
  }
  /* a rating on the field: yards per second, and how fast he gets there */
  function liveSpeed(pos, rating) {
    /* A CORNER RUNS WITH A RECEIVER. Giving the secondary a tenth of a yard
       a second less than the men they cover meant the fastest offensive
       player on the field could not be caught by anybody once he was past
       them, and a live game gave up a seventy-yard touchdown on one throw in
       eight. Real cover men run; what separates them is the angle. */
    var base = { WR: 9.3, CB: 9.3, S: 9.1, RB: 9.0, LB: 8.4, TE: 8.1, QB: 7.7,
                 DL: 7.4, OL: 6.7, K: 7, P: 7 }[pos] || 8.2;
    return base * (0.86 + 0.28 * clamp(rating || 60, 0, 100) / 100);
  }
  function liveAccel(pos, rating) {
    var base = { WR: 26, CB: 26, S: 25, RB: 27, LB: 23, TE: 22, QB: 22,
                 DL: 21, OL: 16, K: 18, P: 18 }[pos] || 23;
    return base * (0.82 + 0.36 * clamp(rating || 60, 0, 100) / 100);
  }
  function unit(v) { return clamp(((v == null ? 62 : v) - 30) / 69, 0, 1); }

  /* ── ADOPTING A LIVE OUTCOME ─────────────────────────────────────────────
     The simulation decided what happened; the engine still owns the books.
     This checks the shape and hands it to exactly the same stats, rules,
     clock and drive code a resolved play goes through — which is why Play
     Mode and Coach Mode produce one set of statistics and one season. */
  function adopt(o, playObj, parts, formKey) {
    var r = o || {};
    r.version = ENGINE_VERSION;
    r.live = true;
    r.play = playObj.key; r.playName = playObj.name;
    r.group = playObj.group; r.type = playObj.type;
    r.formation = formKey;
    r.def = parts.key; r.defName = parts.name;
    r.front = parts.front.key; r.coverage = parts.coverage.key;
    r.pressureCall = parts.pressure.key; r.fit = parts.fit.key;
    r.yards = Math.round(clamp(+r.yards || 0, -99, 110));
    r.notes = r.notes || [];
    r.touchdown = !!r.touchdown;
    r.sack = !!r.sack;
    r.incomplete = !!r.incomplete;
    r.scramble = !!r.scramble;
    r.outOfBounds = !!r.outOfBounds;
    r.big = r.yards >= 16;
    if (r.turnover !== 'interception' && r.turnover !== 'fumble') r.turnover = null;
    return r;
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
    var wx = ctx.weather || CLEAR;
    var rec = recognition(off, def, formKey, playObj, mem, rand, sit);
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

    if (playObj.type === 'run') return resolveRun(out, ctx, ou, du, parts, playObj, formKey, box, rec, oScheme, edge, wx);
    return resolvePass(out, ctx, ou, du, parts, playObj, formKey, box, rec, oScheme, edge, wx);
  }

  /* ── RUN ────────────────────────────────────────────────────────────────── */
  function resolveRun(out, ctx, ou, du, parts, playObj, formKey, box, rec, oScheme, edge, wx) {
    var rand = ctx.rand, off = ctx.off, def = ctx.def, sit = ctx.sit || {};
    wx = wx || CLEAR;
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
                      + ((playObj.concept === 'inside' || playObj.concept === 'gap')
                          ? (off.mods.insideRun || 0) : 0)
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
    var pStuff = clamp(0.268 - adv * 0.026 + (box - 7) * 0.030 + parts.fit.run * 0.9
                       + (rec.read ? 0.075 : -0.02) - (oScheme.concepts && oScheme.concepts[playObj.concept] ? 0.02 : 0)
                       - laneEdge * 0.045 + def.mods.runFit,
                       0.05, 0.52);
    /* BREAKING ONE. Vision and legs against pursuit and tackling. */
    var breakEdge = ((ou.rb.elu + ou.rb.spd) / 2 - (du.lb.spd * 0.45 + du.s.tkl * 0.35 + du.cb.tkl * 0.20)) / 100;
    var pBig = clamp((playObj.boom + breakEdge * 0.30 + parts.fit.boom * 0.7
                     + (box <= 6 ? 0.03 : 0) - (rec.read ? 0.03 : 0)) * (1 + wx.footing), 0.005, 0.45);

    var yards;
    if (rand() < pStuff) {
      yards = Math.round(-2.6 + rand() * 5.2);
      out.notes.push(box >= 7.8 ? 'They had the numbers in the box.' : 'Met in the hole.');
    } else {
      yards = 1 + expo(rand, Math.max(1.3, mu * 0.765));
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
                     - (ou.rb.hnd - 60) / 4000 + (parts.fit.key === 'aggressive' ? 0.004 : 0)
                     + wx.fumble, 0.001, 0.06);
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
  function resolvePass(out, ctx, ou, du, parts, playObj, formKey, box, rec, oScheme, edge, wx) {
    var rand = ctx.rand, off = ctx.off, def = ctx.def, sit = ctx.sit || {}, mem = ctx.mem;
    wx = wx || CLEAR;
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
          + (band === 'deep' ? wx.deepAcc : wx.shortAcc) * 3.2
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
    if (rand() > clamp(0.90 + (hands - 62) / 260 - (pressured ? 0.02 : 0) + wx.hands, 0.68, 0.985)) {
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
    var pBig = clamp((playObj.boom * 0.55 + Math.max(0, speedEdge) * 0.05 + Math.max(0, sep) * 0.18
                     + parts.fit.boom * 0.5) * (1 - (off.mods.shortRoutes || 0) * 0.5), 0.005, 0.42);
    if (rand() < pBig) { yac += 6 + expo(rand, 12 + speedEdge * 5); out.big = true; }
    out.yac = Math.round(yac);
    out.yards = Math.round(depth + yac);
    out.tackler = tacklerFor(du, rand, out.yards);
    out.outOfBounds = (target && target.zone === 'out') ? rand() < 0.42 : rand() < 0.13;

    var pFum = clamp(0.0055 + (out.big ? 0.004 : 0) - (hands - 62) / 5000 + wx.fumble, 0.0008, 0.03);
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
  function fieldGoal(ou, du, ball, rand, clutch, wx) {
    wx = wx || CLEAR;
    var dist = (100 - ball) + 17;                    /* end zone plus the hold */
    var leg = ou.k.pwr, acc = ou.k.acc, clu = ou.k.clu;
    /* out of range is out of range: a 70-yarder is not a coin flip */
    var maxRange = 42 + leg * 0.36 + wx.kickRange;
    var z = 1.95 - (dist - 25) * 0.090 + (acc - 62) / 22 + (leg - 62) / 34
          + (clutch ? (clu - 62) / 40 : 0) + wx.kickAcc * (1 + (dist - 30) / 40);
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
    tagPlayers(home, 'h'); tagPlayers(away, 'a');
    var wx = weatherOf(opts.weather);
    home.wxStamina = wx.stamina; away.wxStamina = wx.stamina;
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
      over: false, ot: 0, otPossessions: 0,
      clockStopped: true, deadCharged: 0, halfBox: null, weather: wx
    };
    return g;
  }

  /* ── THE STAT MODEL, STATED ONCE ─────────────────────────────────────────
     NFL CONVENTION, and nothing here mixes it with any other.

       a sack is not a pass attempt      it is a team passing loss
       team passing yards are NET        receiving yards minus sack yardage
       a quarterback's passing yards     are GROSS, as a passer's always are
       a scramble is a rush              carries, rushing yards, the lot
       a kneel is a rush                 for whatever it loses

     Which gives the two identities the sanity checks assert on every game:

       team yards       = passYards + rushYards
       passYards        = passYardsGross - sackYards
       passYardsGross   = sum of every receiver's yards on that team
       rushYards        = sum of every carrier's yards on that team
       att              = comp + incompletions + ints          (sacks excluded)  */
  function newStats() {
    return { plays: 0, yards: 0, passYards: 0, passYardsGross: 0, rushYards: 0,
             att: 0, comp: 0, sacks: 0,
             sackYards: 0, carries: 0, ints: 0, fumblesLost: 0, firstDowns: 0,
             thirdAtt: 0, thirdConv: 0, fourthAtt: 0, fourthConv: 0,
             redzoneAtt: 0, redzoneTD: 0, explosive: 0, drives: 0, top: 0,
             punts: 0, puntYards: 0, fgAtt: 0, fgMade: 0, pressures: 0, tacklesForLoss: 0,
             passTD: 0, rushTD: 0, timeoutsUsed: 0 };
  }
  /* WHICH SIDE A MAN PLAYS FOR is part of his line. Without it the box score
     is a bag of names nobody can add up, and no test can ever say that the
     rushers' yards make the team's rushing total. */
  function pstat(g, player, side) {
    if (!player) return null;
    var k = pid(player);
    if (!k) return null;
    if (!g.players[k]) g.players[k] = { id: k, name: R.name(player), position: player.position,
      side: side || null, first: player.first_name || '', last: player.last_name || '',
      pa: 0, pc: 0, py: 0, ptd: 0, pint: 0, car: 0, ry: 0, rtd: 0, rec: 0, recy: 0, rectd: 0,
      tkl: 0, sack: 0, sackYards: 0, tfl: 0, int: 0, pd: 0, fg: 0, fga: 0, xp: 0, xpa: 0,
      long: 0, longRush: 0, longRec: 0, targets: 0, drops: 0 };
    if (side && !g.players[k].side) g.players[k].side = side;
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
        /* A DRIVE THAT THE CLOCK ENDS IS STILL A DRIVE. It used to be dropped
           on the floor here — counted in the team's drive total, missing from
           the drive list, its time of possession never credited — which is
           why the two never agreed at the whistle. */
        endDrive(g, 'clock', 0);
        /* AN OVERTIME PERIOD THAT RUNS OUT LEVEL BUYS ANOTHER ONE. Four is the
           limit: after that it is a tie, which is a real football result and
           a better one than a loop that never ends. */
        if (g.score.home === g.score.away && g.cfg.overtime && g.ot < 4) { startOT(g); return; }
        g.over = true; g.phase = 'final'; return;
      }
      if (g.quarter === 2) { g.clock = 0; endDrive(g, 'clock', 0); }
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
    g.clockStopped = true; g.deadCharged = 0;
    /* WHAT THE HALF ACTUALLY WAS, frozen the moment it ends. Every panel that
       claims to show halftime reads this rather than recomputing one from a
       box score that has since moved on. */
    g.halfBox = snapshot(g);
    g.log.push({ kind: 'halftime', score: { home: g.score.home, away: g.score.away } });
    rest(g.home, 45); rest(g.away, 45);
    g.timeouts = { home: 3, away: 3 };
  }
  function startOT(g) {
    endDrive(g, 'clock', 0);
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
                startQuarter: g.quarter, startAtClock: g.clock, outcome: null, seconds: 0,
                rz: false, index: g.drives.length + 1 };
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
  /* THE TRY IS UNTIMED, AND THE CLOCK WAITS FOR IT. Running the score clock
     here is how a touchdown that expired the quarter took its extra point
     with it: `runClock` flipped the phase to halftime or final and the try
     never happened, so a half ended 20–13 and came back 21–13 for no reason
     anyone watching could see. The seconds are charged in `patStep`, after
     the point is on the board. */
  function touchdown(g, side, res) {
    score(g, side, 6, 'touchdown');
    endDrive(g, 'td', 6);
    g.pendingScore = { side: side, quarter: g.quarter, clock: g.clock };
    g.phase = 'pat';
  }
  function afterKickoffSetup(g, kicking) {
    var k = kickoff(unitsOf(teamOf(g, kicking), g.tick), g.rand);
    var receiving = other(kicking);
    if (k.house) {
      score(g, receiving, 6, 'kick return');
      g.pendingScore = { side: receiving, quarter: g.quarter, clock: g.clock };
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
      gain: 'Sacks and pressures fall', cost: 'The shot plays go with them',
      apply: { protect: 1, shortRoutes: 0.5 } },
    { key: 'outside', side: 'off', name: 'Attack the edge',
      means: 'Get the ball outside the tackles and make them run to it.',
      gain: 'Outside runs and perimeter throws hit', cost: 'Inside runs get nothing',
      apply: { outsideRun: 1.5, insideRun: -0.30 } },
    { key: 'tempo', side: 'off', name: 'Push the tempo',
      means: 'No huddle. More possessions for both of you.',
      gain: 'More snaps, and they cannot substitute', cost: 'Tired legs and more mistakes',
      apply: { tempo: 0.86, fatigue: 0.22, execution: -0.012 } },
    { key: 'box', side: 'def', name: 'Load the box',
      means: 'Another body in the run fits. It costs you over the top.',
      gain: 'The run game stops', cost: 'One safety, and they know it',
      apply: { runFit: 0.055, deepCover: -0.035 } },
    { key: 'deep', side: 'def', name: 'Play deeper',
      means: 'Cap everything. They can have the underneath.',
      gain: 'Nothing over the top', cost: 'They will run it and dink you to death',
      apply: { deepCover: 0.06, runFit: -0.03 } },
    { key: 'pressure', side: 'def', name: 'Bring more pressure',
      means: 'Rush an extra man more often. It is a bet, and you know the price.',
      gain: 'Sacks, hurries, and throws off the back foot', cost: 'One-on-one, deep, all afternoon',
      apply: { rush: 0.085, deepCover: -0.035 } }
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
      /* tempo is a multiplier and replaces; everything else accumulates */
      if (k === 'tempo') t.mods.tempo = a.apply[k];
      else t.mods[k] = (t.mods[k] || 0) + a.apply[k];
    }
    g.adjust = g.adjust || {};
    g.adjust[side] = key;
    g.log.push({ kind: 'adjustment', side: side, key: key, name: a.name,
                 quarter: g.quarter });
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
      g.stats[s].timeoutsUsed++;
      /* THE SECONDS COME BACK. The last snap charged the dead ball on the
         assumption the clock kept running to the next one; calling time says
         it did not, so the game gets them back. A timeout with nothing left
         to save is still a timeout — it just does not buy anything. */
      var back = Math.min(g.deadCharged || 0, g.cfg.quarterSeconds - g.clock);
      if (back > 0) { g.clock += back; }
      g.deadCharged = 0; g.clockStopped = true;
      g.log.push({ kind: 'timeout', side: s, saved: Math.round(back),
                   quarter: g.quarter, clock: g.clock });
      return { ok: true, event: 'timeout', saved: Math.round(back), state: situation(g) };
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
        defCall: call.def || 'goal_line_d', weather: wxOf(g),
        sit: { down: 1, toGo: 3, ball: RULES.two_point_from }, mem: g.mem[side]
      });
      var good = r.yards >= 3 && !r.turnover;
      if (good) score(g, side, 2, 'two-point');
      res = { ok: true, event: 'two_point', good: good, play: r, state: null };
      g.log.push({ kind: 'pat', side: side, two: true, good: good });
    } else {
      var made = g.rand() < clamp(0.945 + (ou.k.acc - 62) / 700, 0.85, 0.995);
      if (made) score(g, side, 1, 'extra point');
      var ks = pstat(g, ou.k.player, side); if (ks) { ks.xpa++; if (made) ks.xp++; }
      res = { ok: true, event: 'pat', good: made, state: null };
      g.log.push({ kind: 'pat', side: side, two: false, good: made });
    }
    g.pendingScore = null;
    if (g.ot) {
      g.otPossessions++;
      if (otDone(g)) { g.over = true; g.phase = 'final'; res.state = situation(g); return res; }
      g.phase = 'kickoff'; g.pendingKick = side;
      res.state = situation(g);
      return res;
    }
    /* NOW the clock catches up with the touchdown. Whatever it runs into —
       the end of the half, the end of the game — the points are already on
       the board, which is the whole point of doing it in this order. */
    g.phase = 'play';
    runClock(g, CLOCK.score);
    g.clockStopped = true; g.deadCharged = 0;
    if (g.over || (g.clock <= 0 && g.quarter >= g.cfg.quarters)) {
      g.over = true; g.phase = 'final';
    } else if (g.phase !== 'halftime') {
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
    g.clockStopped = true; g.deadCharged = 0;
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
    var k = fieldGoal(ou, unitsOf(teamOf(g, other(side)), g.tick), g.ball, g.rand, clutch, wxOf(g));
    g.stats[side].fgAtt++;
    var ks = pstat(g, ou.k.player, side); if (ks) ks.fga++;
    if (k.good) {
      g.stats[side].fgMade++; if (ks) ks.fg++;
      score(g, side, 3, 'field goal');
      endDrive(g, 'fg', 3);
      runClock(g, CLOCK.score);
      g.clockStopped = true; g.deadCharged = 0;
      if (g.ot) {
        g.otPossessions++;
        if (otDone(g)) { g.over = true; g.phase = 'final'; return { ok: true, event: 'fieldgoal', fg: k, state: situation(g) }; }
      }
      if (!g.over && g.phase !== 'halftime') { g.phase = 'kickoff'; g.pendingKick = side; }
      return { ok: true, event: 'fieldgoal', fg: k, state: situation(g) };
    }
    endDrive(g, 'fg_miss', 0);
    runClock(g, CLOCK.kick);
    g.clockStopped = true; g.deadCharged = 0;
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

    /* PLAY MODE hands in what actually happened out there; COACH MODE asks
       the resolver. From here down the two are the same play: same stats,
       same rules, same clock, same drive, same season. */
    var r = call.outcome
      ? adopt(call.outcome, playObj, F.defParts(call.def || 'base_3'), formKey)
      : resolve({
          off: offT, def: defT, rand: g.rand, tick: g.tick,
          playKey: playKey, formKey: formKey, defCall: call.def || 'base_3',
          sit: sit, mem: g.mem[side], weather: wxOf(g),
          /* what the hands did: which read, which lane, how quickly */
          userRead: call.read == null ? null : call.read,
          userLane: call.lane == null ? null : call.lane,
          userTiming: call.timing == null ? null : call.timing,
          userScramble: !!call.scramble
        });
    noteCall(g.mem[side], playObj.key, playObj.group);
    noteCall(g.defMem[def], r.def, 'def');
    noteResult(g.mem[side], playObj, r.sack ? r.yards : (r.yards || 0), sit);

    var st = g.stats[side], dst = g.stats[def];
    st.plays++;
    if (g.drive) g.drive.plays++;
    /* the down and distance this snap was played on, kept on the result so a
       touchdown and a turnover carry it as plainly as a two-yard gain does */
    r.down = g.down; r.toGo = g.toGo;

    /* ── stats ─────────────────────────────────────────────────────────────
       See newStats() for the convention every line below keeps. */
    var ou = unitsOf(offT, g.tick);
    var qbs = pstat(g, ou.qb.player, side);
    if (r.sack) {
      /* NFL: the loss comes off the team's passing, never off the passer's,
         and it is not an attempt. Booking it in neither place is what made
         total yards disagree with rushing plus passing in most games. */
      st.sacks++; st.sackYards += -r.yards; st.passYards += r.yards; dst.pressures++;
      var sk = pstat(g, r.tackler, def); if (sk) { sk.sack++; sk.tkl++; sk.sackYards += -r.yards; }
      if (qbs) qbs.sackYards += -r.yards;
    } else if (playObj.type === 'pass' && !r.scramble && playObj.concept !== 'spike') {
      st.att++; if (qbs) qbs.pa++;
      var tgt = pstat(g, r.target, side);
      if (tgt) tgt.targets++;
      if (r.completion) {
        st.comp++;
        if (qbs) { qbs.pc++; qbs.py += r.yards; if (r.yards > qbs.long) qbs.long = r.yards; }
        if (tgt) { tgt.rec++; tgt.recy += r.yards; if (r.yards > tgt.longRec) tgt.longRec = r.yards; }
        st.passYards += r.yards; st.passYardsGross += r.yards;
      } else if (r.turnover === 'interception') {
        st.ints++; if (qbs) qbs.pint++;
        var itc = pstat(g, r.interceptor, def); if (itc) itc.int++;
      } else {
        if (r.drop && tgt) tgt.drops++;
        var pd = pstat(g, r.tackler, def); if (pd && !r.drop) pd.pd++;
      }
      if (r.pressure) dst.pressures++;
    } else if (playObj.type === 'run' || r.scramble) {
      st.carries++; st.rushYards += r.yards;
      var cs = pstat(g, r.carrier, side);
      if (cs) { cs.car++; cs.ry += r.yards; if (r.yards > cs.longRush) cs.longRush = r.yards; }
      if (r.yards < 0) { dst.tacklesForLoss++; var tfl = pstat(g, r.tackler, def); if (tfl) tfl.tfl++; }
    }
    var tk = pstat(g, r.tackler, def); if (tk && !r.sack) tk.tkl++;
    if (r.big) st.explosive++;
    st.yards += r.yards;
    if (g.drive) g.drive.yards += r.yards;
    if (g.down === 3) st.thirdAtt++;
    if (g.down === 4) st.fourthAtt++;
    /* A RED ZONE TRIP IS A DRIVE, NOT A DOWN. Counting one per first down
       inside the twenty gave teams two and three trips on the same drive and
       a conversion rate nobody could reconcile with the drive chart. */
    if (sit.redzone && g.drive && !g.drive.rz) { g.drive.rz = true; st.redzoneAtt++; }

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
      g.clockStopped = true; g.deadCharged = 0;
      if (!g.over && g.phase !== 'halftime') {
        startDrive(g, def, RULES.safety_punt_from + 15);
        g.log.push({ kind: 'change', how: 'safety', side: def, at: g.ball });
      }
      return finish(g, r, 'safety', startBall, side);
    }

    if (r.turnover) {
      var spot = r.turnover === 'interception'
        ? clamp(100 - (g.ball + r.airYards + Math.round(g.rand() * 8)), 1, 99)
        : clamp(100 - newBall, 1, 99);
      if (r.turnover === 'fumble') { st.fumblesLost++; }
      endDrive(g, r.turnover, 0);
      runClock(g, CLOCK.change);
      g.clockStopped = true; g.deadCharged = 0;
      if (!g.over && g.phase !== 'halftime') changePossession(g, spot, r.turnover);
      return finish(g, r, r.turnover, startBall, side);
    }

    if (newBall >= 100) {
      r.touchdown = true;
      r.yards = 100 - startBall;
      if (playObj.type === 'run' || r.scramble) {
        var c2 = pstat(g, r.carrier, side); if (c2) c2.rtd++; st.rushTD++;
      } else {
        var t2 = pstat(g, r.target, side); if (t2) t2.rectd++;
        if (qbs) qbs.ptd++; st.passTD++;
      }
      /* the trip is the drive's, so the touchdown that ends it is too */
      if (g.drive && g.drive.rz) st.redzoneTD++;
      /* THIRD DOWN CONVERTED IS THIRD DOWN CONVERTED. Scoring on it used to
         count as neither a conversion nor a failure, which is how a team went
         6/11 on third down having moved the chains eight times. */
      if (g.down === 3) st.thirdConv++;
      if (g.down === 4) st.fourthConv++;
      st.firstDowns++;
      r.firstDown = true;
      touchdown(g, side, r);
      return finish(g, r, 'touchdown', startBall, side);
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
        g.clockStopped = true; g.deadCharged = 0;
        if (!g.over && g.phase !== 'halftime') changePossession(g, clamp(100 - g.ball, 1, 99), 'downs');
        return finish(g, r, 'downs', startBall, side);
      }
    }

    /* ── THE CLOCK ──────────────────────────────────────────────────────────
       The play, plus the dead ball after it if the clock kept running. What
       stops it: an incompletion, a trip out of bounds late, a spike, and —
       college rule — moving the chains inside two minutes. */
    var tempo = (call.tempo === 'hurry' ? CLOCK.hurry : call.tempo === 'grind' ? CLOCK.grind : CLOCK.normal)
              * (offT.mods.tempo == null ? 1 : offT.mods.tempo);
    var live, dead;
    var lateOOB = r.outOfBounds && (sit.twoMinute || (g.quarter === g.cfg.quarters && g.clock <= 300));
    if (playObj.concept === 'spike') { live = CLOCK.spike; dead = 0; }
    else if (playObj.concept === 'kneel') { live = CLOCK.kneel; dead = CLOCK.kneel_dead; }
    else {
      live = r.sack ? CLOCK.sack
           : r.incomplete ? CLOCK.pass_incomplete
           : lateOOB ? CLOCK.out_of_bounds
           : (playObj.type === 'run' || r.scramble) ? CLOCK.run
           : CLOCK.pass_complete;
      var stops = r.incomplete || lateOOB
               || (r.firstDown && sit.twoMinute);
      dead = stops ? 0 : CLOCK.dead * tempo;
    }
    var secs = Math.round(live + dead);
    runClock(g, secs);
    /* WHAT A TIMEOUT IS ACTUALLY BUYING: the dead ball this snap just spent.
       Without this the button decremented a counter and nothing else, which
       is not a decision — it is a label. */
    g.deadCharged = Math.round(dead);
    g.clockStopped = dead === 0;
    r.seconds = secs;

    return finish(g, r, event, startBall, side);
  }

  function finish(g, r, event, startBall, side) {
    r.startBall = startBall;
    /* WHOSE PLAY IT WAS is the side that snapped it, not whoever has the ball
       by the time the books close. Reading `g.possession` here filed every
       interception, every fumble and every turnover on downs under the team
       that received it — which is how the play-by-play and the turning point
       both named the wrong club. */
    r.side = side || r.side || g.possession;
    r.commentary = narrate(g, r);
    g.plays.push({ q: g.quarter, clock: g.clock, side: r.side,
                   play: r.play, def: r.def, yards: r.yards, text: r.commentary,
                   down: r.down == null ? null : r.down, toGo: r.toGo == null ? null : r.toGo,
                   at: startBall, sack: !!r.sack, first: !!r.firstDown, big: !!r.big,
                   td: !!r.touchdown, to: r.turnover || null });
    return { ok: true, event: event, play: r, state: situation(g) };
  }

  /* ── COMMENTARY ─────────────────────────────────────────────────────────
     Short, and it teaches. Every line names a man and the football reason the
     play worked or did not: the coverage, the box, the leverage, the pressure,
     the route, the concept. It varies so a game does not read like a form
     letter, and it varies DETERMINISTICALLY — off the play's own numbers
     rather than off the game's random stream — so the same seed still gives
     the same game, word for word.

     Nothing here is longer than a broadcast caption. Live football does not
     have room for a paragraph. */
  function vary(key, list) {
    var h = 2166136261, i, str = String(key);
    for (i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return list[(h >>> 0) % list.length];
  }
  function spot(r) {
    var b = r.startBall == null ? 50 : r.startBall;
    return b >= 50 ? 'the ' + (100 - b) : 'his own ' + b;
  }
  function situationWord(r) {
    if (r.down == null) return '';
    var d = r.down === 1 ? '1st' : r.down === 2 ? '2nd' : r.down === 3 ? '3rd' : '4th';
    return d + ' and ' + (r.toGo == null ? 10 : r.toGo);
  }
  function routeWord(r) {
    var n = { hitch: 'hitch', slant: 'slant', bubble: 'bubble', flat: 'flat route', arrow: 'arrow',
      stick: 'stick', spot: 'spot route', shallow: 'shallow cross', quickout: 'out', check: 'check-down',
      screen: 'screen', dig: 'dig', curl: 'curl', out: 'out', cross: 'crosser', sail: 'sail',
      over: 'over route', whip: 'whip', go: 'go ball', seam: 'seam', post: 'post',
      corner: 'corner', deepcross: 'deep cross', wheel: 'wheel' };
    return r.route ? (n[r.route] || r.route) : null;
  }
  function narrate(g, r) {
    var F2 = F, cov = F2.COVERAGES[r.coverage], p = F2.play(r.play);
    var who = r.carrier ? R.shortName(r.carrier) : r.target ? R.shortName(r.target) : '';
    var tk = r.tackler ? R.shortName(r.tackler) : '';
    var key = (r.play || '') + (r.yards | 0) + (r.startBall | 0) + (r.down | 0) + (r.airYards | 0);
    var covName = cov ? cov.name : 'the coverage';

    if (r.play === 'kneel') return 'Takes a knee.';
    if (r.play === 'spike') return 'Spikes it. Clock stopped.';

    if (r.sack) {
      var pr = r.pressureCall && r.pressureCall !== 'none' ? F2.PRESSURES[r.pressureCall].name : null;
      return vary(key, [
        (tk || 'Pressure') + ' gets home. Sack for ' + r.yards + '.',
        (tk ? tk + ' beats his man' : 'The pocket caves') + '. Sack, loss of ' + Math.abs(r.yards) + '.',
        (pr ? pr + ' — ' : '') + (tk || 'They') + ' buries him for ' + r.yards + '.',
        'No time. ' + (tk ? tk + ' brings him down' : 'He is dragged down') + ' for ' + r.yards + '.'
      ]);
    }
    if (r.turnover === 'interception') {
      return vary(key, [
        'Intercepted' + (tk ? ' by ' + tk : '') + '. ' + covName + ' broke on it.',
        (tk || 'They') + ' jumps the ' + (routeWord(r) || 'route') + '. Picked off.',
        'Thrown into ' + covName + ' with nobody open — ' + (tk || 'they') + ' has it.',
        (tk || 'The defence') + ' reads his eyes the whole way. Interception.'
      ]);
    }
    if (r.turnover === 'fumble') {
      return vary(key, [
        who + ' fumbles — ' + (tk ? tk + ' recovers' : 'they recover') + '.',
        'The ball is out. ' + (tk ? tk + ' punched it free' : 'They fall on it') + '.',
        who + ' loses it after contact. Their football.'
      ]);
    }
    if (r.touchdown) {
      var from = Math.abs((r.startBall == null ? 80 : r.startBall) - 100);
      return vary(key, [
        who + ' scores from ' + from + '.',
        who + ' walks in. ' + (r.big ? 'Nobody laid a hand on him.' : p.name + ', ' + from + ' yards.'),
        'Touchdown ' + who + ' — ' + (r.completion ? (routeWord(r) || p.name) : p.name) + ' from ' + from + '.',
        (r.big ? 'Gone. ' : '') + who + ', ' + from + ' yards, touchdown.'
      ]);
    }
    if (r.threwAway) return vary(key, ['Nothing there. He throws it away.',
      'Under duress — he puts it in the third row.', 'Nobody open; he eats nothing and throws it out.']);
    if (r.scramble) {
      return vary(key, [
        'Nothing open — he takes off for ' + r.yards + '.',
        'He escapes the pocket, ' + r.yards + ' on the ground.',
        'Pulls it down and runs. ' + r.yards + '.'
      ]);
    }
    if (r.drop) return vary(key, ['Dropped by ' + who + '. It was there against ' + covName + '.',
      who + ' had it and let it go.', 'Right through his hands. ' + covName + ' gave him that one.']);
    if (r.incomplete) {
      var why = r.pressure ? 'He had somebody in his face.'
              : r.separation < 0 ? covName + ' had it covered.'
              : 'Off the mark.';
      return vary(key, [
        'Incomplete' + (who ? ' for ' + who : '') + '. ' + why,
        'Broken up' + (tk ? ' by ' + tk : '') + ' — ' + covName + '.',
        'Off target' + (who ? ' to ' + who : '') + '. ' + why
      ]);
    }
    if (p.type === 'run') {
      var lead = r.big ? who + ' breaks it for ' + r.yards
        : r.yards <= 0 ? (tk ? tk + ' stops ' + who : who + ' stopped') + ' for ' + r.yards
        : who + ' for ' + r.yards;
      var why2 = r.box >= 7.8 ? ' — they had ' + Math.round(r.box) + ' in the box'
        : r.box <= 6.2 ? ' — light box, and ' + p.name + ' took it'
        : r.read ? ' — they read it'
        : r.laneRight ? ' — away from the strength'
        : r.firstDown ? ' — moves the chains' : '';
      return vary(key, [
        lead + why2 + '.',
        who + ' ' + (r.yards >= 6 ? 'gets to the second level' : r.yards <= 1 ? 'is met in the hole' : 'falls forward')
          + ' for ' + r.yards + (why2 || '') + '.',
        p.name + ': ' + who + ' for ' + r.yards + (r.big ? '. He is into the secondary.' : '.')
      ]);
    }
    var gain = who + ' for ' + r.yards + (r.yac ? ' (' + r.yac + ' after the catch)' : '');
    var rw = routeWord(r);
    var reason = r.big ? ' — ' + covName + ' had nobody over the top'
      : r.separation > 0.15 ? ' — ' + (rw ? 'the ' + rw : p.name) + ' found the window in ' + covName
      : r.pressure ? ' — got it out just in time' : '';
    return vary(key, [
      gain + reason + '.',
      (rw ? who + ' on the ' + rw + ' for ' + r.yards : gain)
        + (r.firstDown ? '. First down.' : reason + '.'),
      gain + (r.pressure ? ' — with a man in his face.' : reason + '.')
    ]);
  }

  /* ── the box score ──────────────────────────────────────────────────────── */
  function boxScore(g) {
    function side(s) {
      var st = g.stats[s], op = g.stats[other(s)];
      return {
        score: g.score[s], plays: st.plays, yards: st.yards,
        passYards: st.passYards, passYardsGross: st.passYardsGross, rushYards: st.rushYards,
        att: st.att, comp: st.comp, ints: st.ints, carries: st.carries,
        /* ── WHICH SACKS ARE WHOSE ────────────────────────────────────────
           `stats[side].sacks` counts the sacks a side's OFFENCE took, which
           is the right place to book them and exactly the wrong thing to
           print under that side's name. Every panel showed a team its own
           sacks allowed under the heading "Sacks", and the recap read them
           back as "got home five times" when it had been sacked five times.
           A box score column called sacks is what the defence did. */
        sacks: op.sacks, sackYards: op.sackYards,
        sacksAllowed: st.sacks, sackYardsAllowed: st.sackYards,
        fumblesLost: st.fumblesLost, turnovers: st.ints + st.fumblesLost,
        firstDowns: st.firstDowns, timeoutsUsed: st.timeoutsUsed,
        third: st.thirdAtt ? st.thirdConv + '/' + st.thirdAtt : '0/0',
        thirdAtt: st.thirdAtt, thirdConv: st.thirdConv,
        thirdPct: st.thirdAtt ? Math.round(100 * st.thirdConv / st.thirdAtt) : 0,
        fourth: st.fourthAtt ? st.fourthConv + '/' + st.fourthAtt : '0/0',
        redzone: st.redzoneAtt ? st.redzoneTD + '/' + st.redzoneAtt : '0/0',
        redzoneAtt: st.redzoneAtt, redzoneTD: st.redzoneTD,
        explosive: st.explosive, top: st.top, drives: st.drives,
        punts: st.punts, fg: st.fgMade + '/' + st.fgAtt,
        ypp: st.plays ? Math.round(10 * st.yards / st.plays) / 10 : 0,
        ypc: st.carries ? Math.round(10 * st.rushYards / st.carries) / 10 : 0,
        ypa: st.att ? Math.round(10 * st.passYards / st.att) / 10 : 0,
        compPct: st.att ? Math.round(100 * st.comp / st.att) : 0,
        sackRate: (st.att + st.sacks) ? Math.round(1000 * st.sacks / (st.att + st.sacks)) / 10 : 0
      };
    }
    return { home: side('home'), away: side('away'), players: g.players,
             score: { home: g.score.home, away: g.score.away },
             quarter: g.quarter, clock: g.clock, over: !!g.over, ot: g.ot || 0,
             weather: g.weather || CLEAR,
             leaders: { home: leaders(g, 'home'), away: leaders(g, 'away') },
             drives: g.drives, plays: g.plays, log: g.log,
             scoring: scoringSummary(g),
             injuries: { home: g.home.injuries, away: g.away.injuries } };
  }

  /* ── A FROZEN COPY ────────────────────────────────────────────────────────
     What the game looked like at one moment, kept so that a panel claiming to
     show halftime shows halftime rather than a live box score that has moved
     on since. Nothing reads the live state to draw a past one. */
  function snapshot(g) {
    var b = boxScore(g);
    return JSON.parse(JSON.stringify({
      score: b.score, quarter: g.quarter, half: g.half,
      home: b.home, away: b.away, leaders: b.leaders,
      scoring: b.scoring, drives: b.drives
    }));
  }

  /* ── WHO IS DOING IT ──────────────────────────────────────────────────────
     The men a broadcast would put on the screen, per side, in the order it
     would put them there. Every one of them is a real line out of the same
     stats the box score prints — there is no second tally anywhere. */
  function playersOf(g, side) {
    var out = [], k;
    for (k in g.players) {
      if (!g.players.hasOwnProperty(k)) continue;
      if (g.players[k].side === side) out.push(g.players[k]);
    }
    return out;
  }
  function bestBy(list, score) {
    var best = null, bs = -1e9, i, v;
    for (i = 0; i < list.length; i++) {
      v = score(list[i]);
      if (v > bs) { bs = v; best = list[i]; }
    }
    return bs > 0 ? best : null;
  }
  function leaders(g, side) {
    var ps = playersOf(g, side);
    return {
      passer: bestBy(ps, function (p) { return p.pa ? p.py + p.ptd * 20 - p.pint * 15 + 1 : 0; }),
      rusher: bestBy(ps, function (p) { return p.car ? p.ry + p.rtd * 20 + 1 : 0; }),
      receiver: bestBy(ps, function (p) { return p.rec ? p.recy + p.rectd * 20 + 1 : 0; }),
      defender: bestBy(ps, function (p) { return p.sack * 9 + p.int * 12 + p.tfl * 4 + p.tkl * 1.1 + p.pd * 2; })
    };
  }

  /* the scoring summary, straight off the score log — one row per score */
  function scoringSummary(g) {
    var out = [];
    g.log.forEach(function (e) {
      if (e.kind !== 'score') return;
      out.push({ side: e.side, points: e.points, how: e.how, quarter: e.quarter,
                 clock: e.clock, home: e.score.home, away: e.score.away });
    });
    return out;
  }

  /* PLAYER OF THE GAME — the one line a result is remembered by. Pass a side
     to get that team's; pass nothing for the best man on the field. */
  function pogScore(p) {
    return p.py * 0.045 + p.ptd * 4 - p.pint * 3
         + p.ry * 0.11 + p.rtd * 6
         + p.recy * 0.11 + p.rectd * 6
         + p.tkl * 0.7 + p.sack * 4 + p.int * 7 + p.tfl * 1.5 + p.fg * 3;
  }
  function playerOfGame(g, side) {
    var list = side ? playersOf(g, side) : (function () {
      var a = [], k;
      for (k in g.players) if (g.players.hasOwnProperty(k)) a.push(g.players[k]);
      return a;
    })();
    var best = null, bestScore = -1, i, v;
    for (i = 0; i < list.length; i++) {
      v = pogScore(list[i]);
      if (v > bestScore) { bestScore = v; best = list[i]; }
    }
    return best;
  }
  /* the best man on each side of the ball, which is what a recap actually
     wants: one who moved it and one who stopped it */
  function topOffense(g, side) {
    return bestBy(playersOf(g, side), function (p) {
      return p.py * 0.045 + p.ptd * 4 - p.pint * 3 + p.ry * 0.11 + p.rtd * 6
           + p.recy * 0.11 + p.rectd * 6;
    });
  }
  function topDefense(g, side) {
    return bestBy(playersOf(g, side), function (p) {
      return p.sack * 6 + p.int * 9 + p.tfl * 3 + p.tkl * 0.9 + p.pd * 1.6;
    });
  }

  var API = {
    VERSION: ENGINE_VERSION, RULES: RULES, CLOCK: CLOCK,
    rng: rng, norm: norm, expo: expo, clamp: clamp, logistic: logistic,
    mods: mods, makeTeam: makeTeam, unitsOf: unitsOf,
    ADJUSTMENTS: ADJUSTMENTS, adjustment: adjustment, applyAdjustment: applyAdjustment,
    newMemory: newMemory, tendency: tendency, noteCall: noteCall,
    noteResult: noteResult, form: form,
    recognition: recognition, boxCount: boxCount, passRush: passRush,
    resolve: resolve, prepare: prepare, adopt: adopt, fieldGoal: fieldGoal, punt: punt, kickoff: kickoff,
    createGame: createGame, step: step, situation: situation, secondsLeft: secondsLeft,
    clockLabel: clockLabel, boxScore: boxScore, snapshot: snapshot,
    playerOfGame: playerOfGame, playersOf: playersOf, leaders: leaders,
    topOffense: topOffense, topDefense: topDefense, scoringSummary: scoringSummary,
    weatherOf: weatherOf,
    other: other, teamOf: teamOf, toGoal: toGoal, narrate: narrate, pid: pid,
    freshness: freshness, startDrive: startDrive
  };
  root.EDGridiron = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
