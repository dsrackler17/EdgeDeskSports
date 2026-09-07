/* ===========================================================================
   GRIDIRON — the stage.

   Twenty-two football players on a field, and a camera. This file draws; it
   does not decide.

   ── WHO DOES WHAT ──────────────────────────────────────────────────────────
     paint.js   how a man, a field and a football look
     live.js    what happens between the snap and the whistle
     engine.js  what it all means: yards, stats, downs, the season
     THIS FILE  aligns the twenty-two, hands live.js the thumbs and the
                clock, follows the ball with the camera, and paints

   It used to own a DIRECTOR: the engine settled the snap up front and this
   file animated a sequence that arrived at the answer. That is gone. The
   engine is now asked before the snap for an ENVIRONMENT — how fast each man
   is, how long the protection holds, how much separation a route can win —
   and the play itself happens for real, frame by frame, in live.js. Nobody
   knows the yards until the whistle, including this file.

   Coach Mode still uses the deterministic resolver, untouched. See live.js.

   ── WHAT AN ACTOR KNOWS ────────────────────────────────────────────────────
   Where he is, where he is trying to be, how fast he can get there, what he
   is doing with his arms, and who he is engaged with. The alignment functions
   below are pure and exported, because the call sheet, the roster page and
   the tests all need to stand eleven men somewhere without a canvas.
   =========================================================================== */
(function (root) {
  'use strict';

  var P = root.EDGridironPaint || (typeof require === 'function' ? require('./paint.js') : null);
  var LIVE = root.EDGridironLive || (typeof require === 'function' ? require('./live.js') : null);
  var F = root.EDFootball || (typeof require === 'function' ? require('./football.js') : null);
  var RO = root.EDRoster || (typeof require === 'function' ? require('./roster.js') : null);

  var FIELD = P.FIELD;
  var HALF = FIELD.half;

  /* ── how fast a man moves, in yards per second ─────────────────────────── */
  function speedOf(pos, rating) {
    var base = { WR: 9.2, CB: 9.1, S: 8.7, RB: 8.9, LB: 8.1, TE: 8.0, QB: 7.6,
                 DL: 7.3, OL: 6.6, K: 7, P: 7 }[pos] || 8;
    return base * (0.86 + 0.28 * Math.max(0, Math.min(100, rating || 60)) / 100);
  }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  /* ── AN ACTOR ────────────────────────────────────────────────────────────── */
  function Actor(o) {
    return {
      id: o.id, side: o.side, pos: o.pos, slot: o.slot, num: o.num, name: o.name || '',
      player: o.player || null,
      x: o.x, y: o.y, vx: 0, vy: 0,
      hx: o.x, hy: o.y,                 /* where he lined up */
      top: o.top || 8, accel: o.accel || 22,
      tx: o.x, ty: o.y,                 /* steering target */
      state: 'stance', phase: 0, face: o.side === 'def' ? 'front' : 'back', lean: 0,
      job: null, mark: null, engaged: null, sel: false, fell: 1,
      carry: false, kit: o.kit, hold: 0, arrive: 0.6
    };
  }

  /* ── ALIGNMENT ───────────────────────────────────────────────────────────
     Where the twenty-two stand before the ball moves. Pure functions of the
     play, the formation, the defensive call and the spot: the same eleven a
     test can count and the stage can walk onto the field. */
  function alignOffense(playObj, fk, bx, ly, units, kit) {
    var form = F.formation(fk), out = [], i;
    var olNames = ['LT', 'LG', 'C', 'RG', 'RT'], olY = [-4.6, -2.3, 0, 2.3, 4.6];
    var olPlayers = (units && units.ol && units.ol.players) || [];
    for (i = 0; i < 5; i++) {
      out.push(Actor({ id: 'o_' + olNames[i], side: 'off', pos: 'OL', slot: olNames[i],
        num: (olPlayers[i] && jersey(olPlayers[i], 70 + i)) || (70 + i),
        name: olPlayers[i] ? RO.shortName(olPlayers[i]) : '',
        player: olPlayers[i] || null,
        x: clamp(bx + olY[i], 1, FIELD.width - 1), y: ly - 1.1,
        top: speedOf('OL', olPlayers[i] ? olPlayers[i].overall : 60), accel: 16, kit: kit }));
    }
    Object.keys(form.spots).forEach(function (slot) {
      var s = form.spots[slot];
      var pos = slotPos(slot);
      var pl = unitPlayer(units, slot);
      out.push(Actor({ id: 'o_' + slot, side: 'off', pos: pos, slot: slot,
        num: pl ? jersey(pl, SLOT_NUM[slot] || 80) : (SLOT_NUM[slot] || 80),
        name: pl ? RO.shortName(pl) : '',
        player: pl || null,
        x: clamp(bx + s[1], 0.8, FIELD.width - 0.8), y: ly + s[0],
        top: speedOf(pos, pl ? pl.overall : 65), accel: pos === 'OL' ? 16 : 26, kit: kit }));
    });
    return out;
  }
  var SLOT_NUM = { QB: 7, RB: 21, FB: 44, TE: 85, TE2: 87, X: 11, Z: 3, SL: 18, SL2: 82 };
  function slotPos(k) {
    if (k === 'QB') return 'QB';
    if (k === 'RB' || k === 'FB') return 'RB';
    if (k === 'TE' || k === 'TE2') return 'TE';
    return 'WR';
  }
  function jersey(p, fallback) {
    if (!p) return fallback;
    var n = (RO.hash(p.id || p.last_name || '') % 89) + 1;
    var band = { QB: [1, 19], RB: [20, 49], WR: [10, 19], TE: [80, 89], OL: [50, 79],
                 DL: [90, 99], LB: [40, 59], CB: [20, 39], S: [20, 45], K: [1, 9], P: [1, 9] }[p.position];
    if (!band) return fallback;
    return band[0] + (n % (band[1] - band[0] + 1));
  }
  function unitPlayer(u, slot) {
    if (!u) return null;
    if (slot === 'QB') return u.qb && u.qb.player;
    if (slot === 'RB' || slot === 'FB') return (u.rb && u.rb.players && u.rb.players[slot === 'FB' ? 1 : 0]) || null;
    if (slot === 'TE' || slot === 'TE2') return (u.te && u.te.players && u.te.players[slot === 'TE2' ? 1 : 0]) || null;
    var i = slot === 'X' ? 0 : slot === 'Z' ? 1 : slot === 'SL' ? 2 : 3;
    return (u.wr && u.wr.players && u.wr.players[i]) || null;
  }

  /* THE DEFENCE, aligned to what it is actually about to play. */
  function alignDefense(parts, bx, ly, strong, units, playObj, formKey, kit) {
    var out = [], i;
    var front = parts.front, cov = parts.coverage, press = parts.pressure;
    var nDL = front.key === '34' ? 3 : front.key === 'goalline' ? 5 : 4;
    var nDB = front.dbs, nLB = 11 - nDL - nDB;
    var shade = strong * 1.1;
    var dl = (units && units.dl && units.dl.players) || [];
    var lb = (units && units.lb && units.lb.players) || [];
    var cb = (units && units.cb && units.cb.players) || [];
    var sf = (units && units.s && units.s.players) || [];

    var dlY = nDL === 3 ? [-3.2, 0, 3.2] : nDL === 5 ? [-5.2, -2.6, 0, 2.6, 5.2] : [-4.4, -1.5, 1.5, 4.4];
    for (i = 0; i < nDL; i++) {
      out.push(Actor({ id: 'd_DL' + i, side: 'def', pos: 'DL', slot: 'DL' + i,
        num: dl[i] ? jersey(dl[i], 90 + i) : 90 + i, name: dl[i] ? RO.shortName(dl[i]) : '',
        player: dl[i] || null,
        x: clamp(bx + dlY[i] + shade, 1, FIELD.width - 1), y: ly + 2.2,
        top: speedOf('DL', dl[i] ? dl[i].overall : 65), accel: 20, kit: kit }));
    }
    var lbY = nLB >= 4 ? [-6.5, -2.2, 2.2, 6.5] : nLB === 3 ? [-5.2, 0, 5.2] : nLB === 2 ? [-3.4, 3.4] : [0];
    var lbDepth = front.key === 'goalline' ? 2.2 : 4.4;
    for (i = 0; i < nLB; i++) {
      var blitzer = isBlitzer(press, i, nLB);
      out.push(Actor({ id: 'd_LB' + i, side: 'def', pos: 'LB', slot: 'LB' + i,
        num: lb[i] ? jersey(lb[i], 50 + i) : 50 + i, name: lb[i] ? RO.shortName(lb[i]) : '',
        player: lb[i] || null,
        x: clamp(bx + (lbY[i] || 0) * 0.9 + shade * 0.6, 1, FIELD.width - 1),
        y: ly + (blitzer ? lbDepth - 1.6 : lbDepth),
        top: speedOf('LB', lb[i] ? lb[i].overall : 65), accel: 24, kit: kit }));
      out[out.length - 1].blitz = blitzer;
    }
    /* corners take the widest receivers; safeties take the shell */
    var wide = wideReceivers(playObj, formKey, bx, ly);
    var nS = Math.max(1, Math.min(3, safeties(cov)));
    var nCB = Math.max(0, nDB - nS);
    for (i = 0; i < nCB; i++) {
      var w = wide[i];
      var pressCov = cov.key === 'cover0' || cov.key === 'cover1';
      out.push(Actor({ id: 'd_CB' + i, side: 'def', pos: 'CB', slot: 'CB' + i,
        num: cb[i] ? jersey(cb[i], 21 + i) : 21 + i, name: cb[i] ? RO.shortName(cb[i]) : '',
        player: cb[i] || null,
        x: w ? clamp(w.x + (w.x > bx ? 0.6 : -0.6), 0.8, FIELD.width - 0.8)
             : clamp(bx + (i % 2 ? 16 : -16), 1, FIELD.width - 1),
        y: ly + (pressCov ? 1.1 : cov.key === 'cover2' || cov.key === 'tampa2' ? 4.5 : 6.5),
        top: speedOf('CB', cb[i] ? cb[i].overall : 68), accel: 26, kit: kit }));
    }
    var sy, sxs;
    if (cov.key === 'cover0') { sy = 4.5; sxs = [-6, 6, 0]; }
    else if (cov.key === 'cover1') { sy = 13; sxs = [0, -8, 8]; }
    else if (cov.key === 'cover4' || cov.key === 'cover6') { sy = 11; sxs = [-9, 9, 0]; }
    else if (cov.key === 'cover2' || cov.key === 'tampa2') { sy = 13.5; sxs = [-11, 11, 0]; }
    else { sy = 12; sxs = [-1, 11, -11]; }
    for (i = 0; i < nS; i++) {
      out.push(Actor({ id: 'd_S' + i, side: 'def', pos: 'S', slot: 'S' + i,
        num: sf[i] ? jersey(sf[i], 31 + i) : 31 + i, name: sf[i] ? RO.shortName(sf[i]) : '',
        player: sf[i] || null,
        x: clamp(bx + (sxs[i] || 0), 1, FIELD.width - 1), y: ly + sy + (i ? 1.5 : 0),
        top: speedOf('S', sf[i] ? sf[i].overall : 68), accel: 25, kit: kit }));
    }
    /* eleven, always */
    while (out.length > 11) out.pop();
    while (out.length < 11) {
      out.push(Actor({ id: 'd_X' + out.length, side: 'def', pos: 'LB', slot: 'X',
        num: 55, x: bx, y: ly + 6, top: 8, accel: 22, kit: kit }));
    }
    return out;
  }
  function safeties(cov) {
    if (cov.key === 'cover0') return 1;
    if (cov.key === 'cover4' || cov.key === 'cover6' || cov.key === 'cover2' || cov.key === 'tampa2') return 2;
    return 1;
  }
  function isBlitzer(press, i, n) {
    if (press.key === 'none') return false;
    if (press.key === 'zero') return true;
    if (press.key === 'agap' || press.key === 'cross') return i === Math.floor(n / 2) || i === 0;
    if (press.key === 'edge') return i === 0;
    return i === n - 1;
  }
  function wideReceivers(playObj, fk, bx, ly) {
    var form = F.formation(fk), list = [];
    Object.keys(form.spots).forEach(function (slot) {
      if (slotPos(slot) !== 'WR' && slot !== 'TE') return;
      list.push({ slot: slot, x: bx + form.spots[slot][1], y: ly + form.spots[slot][0] });
    });
    list.sort(function (a, b) { return Math.abs(b.x - bx) - Math.abs(a.x - bx); });
    return list;
  }


  /* A ROUTE IN FIELD COORDINATES, mirrored for the side he lines up on. The
     stage runs it and the call sheet draws it, from the same one place. */
  function routeWorldPure(rk, hx, hy, centerX) {
    var r = F.ROUTES[rk];
    if (!r) return [[hx, hy]];
    var s = hx >= centerX ? 1 : -1, out = [[hx, hy]], i;
    for (i = 0; i < r.pts.length; i++) {
      out.push([clamp(hx + r.pts[i][1] * s, 0.6, FIELD.width - 0.6), hy + r.pts[i][0]]);
    }
    return out;
  }

  var ALIGN = { offense: alignOffense, defense: alignDefense };

  /* ── THE STAGE ───────────────────────────────────────────────────────────── */
  function Stage(canvas, opts) {
    opts = opts || {};
    var self = {};
    var ctx = canvas.getContext('2d', { alpha: false });
    var cam = P.camera({ w: 390, h: 300 });
    var dpr = 1;

    var actors = [], byId = {};
    var ball = { x: HALF, y: 25, z: 0, spin: 0, holder: null, flight: null };
    var los = 25, firstDown = 35, ballX = HALF;
    var phase = 'idle';               /* idle | set | live | dead */
    var t = 0, tick = 0, dead = 0;
    var play = null, defParts = null, formKey = null, offSide = 'off';
    var result = null, sim = null;
    var pendingAction = null, pendingThrow = null, pendingSwitch = false;
    var kits = { off: null, def: null };
    var names = { off: '', def: '' };
    /* the clubs' own colours, kept apart from the kits: an end zone is
       painted in the club's paint whether they are in white that week or not */
    var paints = { off: null, def: null };
    var artPaths = null, showArt = true;
    var userSide = 'off', userActor = null, userMode = 'play';
    var steer = { x: 0, y: 0, on: false };
    var speedScale = 1;
    /* HOW MANY OF THEM ARE ON THEIR FEET. It decays back to a murmur on its
       own; the page shoves it up when something happens worth standing for. */
    var excite = 0.10, exciteFloor = 0.10;
    /* THE PLAY SHOT CANNOT SEE THE STADIUM, and that is not a bug. A lens
       this long and this high looks down at the grass: the horizon sits seven
       hundred pixels above the frame and the near sideline is off both edges,
       so the bowl is genuinely behind the camera's shoulder. To show the
       venue you have to put the camera in it — low and wide — which is what
       a broadcast does between plays and never during one. */
    var shot = 'play';
    var raf = null, lastMs = 0, acc = 0;
    var events = opts.on || {};
    var flash = null;
    var shake = 0;
    /* A MAN IS ABOUT A TWELFTH OF THE PICTURE TALL, on every phone. That one
       number sets the whole scale of the shot; the lens geometry does the
       rest. */
    /* ── ONE KNOB: HOW WIDE THE SHOT IS ──────────────────────────────────
       Everything else follows from it, which is what a zoom lens does.

         px      how big a man is — set so the width asked for actually fits
                 the screen without the picture being squashed sideways
         height  how high the lens is — set so the SAME thirty-eight yards of
                 depth are in frame whatever the shot and whatever the phone

       Leaving the lens height fixed instead makes a short window (the drawer
       is up, or the phone is small) show the whole stadium receding to a
       point, which is exactly when a football game starts to look like a
       bowling alley. */
    function fitCamera() {
      cam.px = clamp(cam.w / (0.88 * Math.max(12, cam.wide)), 7, 30);
      /* the play shot holds thirty-eight yards of depth and looks down hard;
         the wide shot drops the lens until the horizon — and everything
         standing on it — comes into frame */
      cam.height = shot === 'wide'
        ? clamp(cam.h * (cam.anchor - 0.12) / cam.px, 18, 200)
        : clamp(1.807 * cam.h / cam.px, 26, 170);
    }
    /* seconds the loop is held open for a camera move that is not football */
    var glide = 0;
    var reduce = false;
    try { reduce = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) {}

    /* ── canvas sizing ─────────────────────────────────────────────────── */
    function resize() {
      var w = canvas.clientWidth || 390, h = canvas.clientHeight || 300;
      if (!w || !h) { if (root.requestAnimationFrame) root.requestAnimationFrame(resize); return; }
      dpr = Math.min(2.5, root.devicePixelRatio || 1);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      cam.w = w; cam.h = h;
      /* A MAN IS SIZED BY THE SCREEN, NOT BY THE YARD. On a tall window the
         camera comes in so the picture is filled by football rather than by
         empty turf; on a short one it backs off. Everything else — how far
         away the far men are, how hard the sidelines lean in — falls out of
         the perspective on its own. */
      cam.anchor = 0.62;
      fitCamera();
      /* re-frame at once: a resize with a stale camera shows the wrong shot
         until something moves, and between plays nothing does */
      camFollow(0, true);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    }
    self.resize = resize;

    /* ── SETUP ─────────────────────────────────────────────────────────── */
    self.teams = function (offTheme, defTheme, offName, defName, offAway) {
      kits.off = P.uniform(offTheme, !!offAway);
      kits.def = P.uniform(defTheme, !offAway);
      paints.off = offTheme || null; paints.def = defTheme || null;
      names.off = offName || ''; names.def = defName || '';
    };
    self.setArt = function (v) { showArt = !!v; };
    self.setSpeed = function (s) { speedScale = clamp(s || 1, 0.4, 4); };
    self.setUserSide = function (s) { userSide = s === 'def' ? 'def' : 'off'; };
    self.setMode = function (m) { userMode = m; };
    /* time of day and weather: one call changes the turf, the stands, the
       crowd, the sky and the grade together */
    /* 'play' is football-first. 'wide' is the establishing shot: pregame,
       kickoff, a touchdown, halftime and the final whistle. */
    /* Changing the shot has to move the picture NOW: between plays nothing is
       animating, so a lens change that waits for the next frame never arrives.
       `snap` false glides instead, and holds the loop open long enough for the
       move to finish — which is what a camera pulling out on a touchdown is. */
    self.setShot = function (k, snap) {
      var want = k === 'wide' ? 'wide' : 'play';
      if (want === shot) return;
      shot = want;
      if (snap === false) { glide = 1.7; start(); return; }
      camFollow(0, true);
      draw();
    };
    self.shot = function () { return shot; };
    self.setConditions = function (light, weather) {
      if (light) opts.light = light;
      if (weather) opts.weather = weather;
    };
    /* the crowd gets up. 0 is a murmur, 1 is a touchdown. */
    self.crowd = function (level, floor) {
      excite = clamp(Math.max(excite, level || 0), 0, 1);
      if (floor != null) exciteFloor = clamp(floor, 0, 1);
    };
    self.camera = cam;
    self.phase = function () { return phase; };
    self.userActor = function () { return userActor; };
    self.ballCarrier = function () { return ball.holder; };

    /* ── LINE UP ─────────────────────────────────────────────────────────
       The formation on the field, the front and the shell across from it. */
    self.lineUp = function (o) {
      play = F.play(o.play);
      formKey = o.formation;
      defParts = F.defParts(o.def);
      los = o.los; firstDown = o.firstDown;
      ballX = o.ballX == null ? HALF : o.ballX;
      result = null; sim = null; flash = null;
      pendingAction = null; pendingThrow = null; pendingSwitch = false;
      phase = 'set'; t = 0; dead = 0;
      actors = []; byId = {};

      var off = offenseSpots(play, formKey, ballX, los, o.offUnits);
      var def = defenseSpots(defParts, ballX, los, o.strong || 0, o.defUnits, play);
      off.forEach(function (a) { a.kit = kits.off; actors.push(a); byId[a.id] = a; });
      def.forEach(function (a) { a.kit = kits.def; actors.push(a); byId[a.id] = a; });

      /* THE LIVE PLAY. It takes the twenty-two and the environment the engine
         prepared, and from the snap on it owns them: assignments, movement,
         contact, the football and the result. */
      sim = LIVE.Play({
        actors: actors, playObj: play, parts: defParts, formKey: formKey,
        los: los, ballX: ballX, env: o.env, rand: o.rand || Math.random,
        userSide: userSide, userMode: userMode,
        events: {
          onSnap: null,
          onHandoff: events.onHandoff || null,
          onThrow: events.onThrow || null,
          onCatch: events.onCatch || null,
          onIntercept: events.onIntercept || null,
          onScramble: events.onScramble || null,
          onMove: events.onMove || null,
          onBreak: events.onBreak || null
        }
      });
      ball = sim.ball;
      ball.x = ballX; ball.y = los; ball.z = 0; ball.flight = null;

      artPaths = buildArt();
      userActor = sim.user();
      camFollow(0, true);
      draw();
      return { off: off, def: def };
    };

    function offenseSpots(playObj, fk, bx, ly, units) {
      return ALIGN.offense(playObj, fk, bx, ly, units, kits.off);
    }
    function defenseSpots(parts, bx, ly, strong, units, playObj) {
      return ALIGN.defense(parts, bx, ly, strong, units, playObj, formKey, kits.def);
    }
    /* WHO IS DOING WHAT now belongs to live.js: it assigns the jobs on the
       actors this file aligned, and the play art below reads them back. */
    function routeWorld(rk, hx, hy) { return routeWorldPure(rk, hx, hy, ballX); }

    /* ── PLAY ART ────────────────────────────────────────────────────────── */
    function buildArt() {
      var out = [];
      actors.forEach(function (a) {
        if (a.side !== 'off' || !a.job) return;
        if (a.job.kind === 'route') out.push({ pts: a.job.pts, color: 'rgba(255,255,255,.8)', width: 2.4 });
      });
      if (play.type === 'run') {
        var lane = play.concept === 'outside' ? 5.5 : play.concept === 'gap' ? 2.6 : 0.9;
        var side = (opts.lanePreview || 1);
        out.push({ pts: [[ballX, los - 4], [ballX + lane * side * 0.6, los - 0.5],
                         [ballX + lane * side, los + 3], [ballX + lane * side * 1.1, los + 6.5]],
                   color: 'rgba(242,199,68,.9)', width: 2.8 });
      }
      actors.forEach(function (a) {
        if (a.side === 'def' && a.blitz) {
          out.push({ pts: [[a.x, a.y], [ballX + (a.x - ballX) * 0.25, los - 2]],
                     color: 'rgba(226,102,75,.85)', width: 2.4 });
        }
      });
      return out;
    }

    self.switchDefender = function () { if (userSide === 'def') pendingSwitch = true; };

    /* ── INPUT ───────────────────────────────────────────────────────────
       Nothing here decides anything. A thumb is a direction and a tap is an
       intention; both are queued and handed to the simulation on the next
       tick, which is what keeps a play the same whether the phone drew sixty
       frames or thirty. */
    self.steer = function (x, y) {
      var m = Math.hypot(x, y);
      if (m > 1) { x /= m; y /= m; }
      steer.x = x; steer.y = y; steer.on = m > 0.12;
    };
    self.action = function (kind) {
      if (phase !== 'live' || !sim) return false;
      if (kind === 'scramble' && (play.type !== 'pass' || sim.thrown())) return false;
      pendingAction = kind;
      return true;
    };
    /* the tap that throws it: which receiver, and the moment is now */
    self.throwTo = function (idx) {
      if (phase !== 'live' || !sim || sim.thrown()) return null;
      pendingThrow = idx;
      targets = false; targetBoxes = [];
      return true;
    };
    self.snapNow = function () { if (phase === 'set') beginSnap(); };
    /* ── TARGETS ─────────────────────────────────────────────────────────
       The throw buttons live ON THE RECEIVERS, out on the grass, not in a
       row along the bottom of the screen. You look at the field, see who is
       open, and press him. That is the whole reason a badge beats a menu. */
    var targets = false, targetBoxes = [];
    var SLOT_LETTER = { X: 'X', Z: 'Z', SL: 'S', SL2: 'H', TE: 'T', RB: 'R', FB: 'F', WR: 'W' };
    /* THE BADGES ARE LIVE. They are rebuilt from the simulation every frame,
       so they ride the men down the field and go out one at a time as routes
       are covered — a snapshot taken at the snap would leave you throwing at
       where somebody used to be. */
    self.showTargets = function (on) { targets = !!on; };
    self.clearTargets = function () { targets = false; targetBoxes = []; };
    /* a tap in canvas coordinates: which receiver, if any */
    self.hitTarget = function (px, py) {
      var best = -1, bd = 1e9, i;
      for (i = 0; i < targetBoxes.length; i++) {
        var b = targetBoxes[i];
        var d = Math.hypot(px - b.x, py - b.y);
        if (d < b.r && d < bd) { bd = d; best = b.idx; }
      }
      return best;
    };

    /* the eligible men, in the order the play reads them — the simulation
       knows, because it is the one running the routes */
    self.receivers = function () {
      if (!sim) return [];
      return sim.targets();
    };

    /* ── THE SNAP, AND THE LIVE PLAY ─────────────────────────────────────
       Everything from here to the whistle belongs to games/lib/gridiron/
       live.js. This file owns the picture: it feeds the simulation the
       thumbs and the elapsed time, and draws whatever comes back. It does
       not know how a tackle is decided and it must not. */
    function beginSnap() {
      if (!sim) return;
      if (!sim.snap()) return;
      phase = 'live'; t = 0;
      shake = 0.12;
      if (events.onSnap) events.onSnap();
      start();
    }

    /* ── THE LOOP ────────────────────────────────────────────────────────── */
    function start() {
      if (raf) return;
      lastMs = 0; acc = 0;
      raf = root.requestAnimationFrame(frame);
    }
    function stop() { if (raf) { root.cancelAnimationFrame(raf); raf = null; } }
    self.stop = stop;
    self.start = start;

    function frame(ms) {
      raf = root.requestAnimationFrame(frame);
      if (!lastMs) lastMs = ms;
      var dt = Math.min(0.05, (ms - lastMs) / 1000) * speedScale;
      lastMs = ms;
      acc += dt;
      var steps = 0;
      /* A FIXED STEP. The simulation must not care how fast the phone is:
         a hundred and twenty ticks a second whatever the frame rate, so the
         same thumbs give the same play on any device. */
      while (acc > 1 / 120 && steps < 8) { update(1 / 120); acc -= 1 / 120; steps++; }
      draw();
      if (glide > 0) glide -= dt;
      if (phase === 'dead' && dead > 1.4 && glide <= 0) stop();
    }

    function update(dt) {
      t += dt; tick += dt;
      if (shake > 0) shake = Math.max(0, shake - dt * 1.6);
      if (sim) {
        sim.step(dt, {
          mx: steer.on ? steer.x : 0,
          my: steer.on ? steer.y : 0,
          action: pendingAction,
          throwTo: pendingThrow,
          switchDef: pendingSwitch
        });
        pendingAction = null; pendingThrow = null; pendingSwitch = false;
        userActor = sim.user();
        if (sim.outcome() && phase === 'live') {
          phase = 'dead'; dead = 0;
          result = sim.outcome();
          targets = false; targetBoxes = [];
          if (events.onEnd) events.onEnd(endKindOf(result), result);
        }
      }
      if (phase === 'dead') dead += dt;
      excite = Math.max(exciteFloor, excite - dt * 0.30);
      camFollow(dt);
    }

    function endKindOf(r) {
      if (!r) return 'tackle';
      if (r.touchdown) return 'touchdown';
      if (r.turnover) return r.turnover;
      if (r.sack) return 'sack';
      if (r.incomplete) return 'incomplete';
      if (r.outOfBounds) return 'outofbounds';
      return 'tackle';
    }

    /* ── CAMERA ──────────────────────────────────────────────────────────── */
    /* THE CAMERA. Before the snap it backs off far enough to show the whole
       formation, because reading the look is the decision you are about to
       make. After it, it closes in on the football and stays with it — which
       is what a broadcast does and why a broadcast is legible. */
    function camFollow(dt, snap) {
      var f = ball.holder || (ball.flight ? ball : byId['o_QB']);
      var tx = f ? f.x : ballX, ty = f ? f.y : los;
      var wantX, wantY, wide;
      var holding = phase === 'live' && ball.holder && ball.holder.slot === 'QB' && !ball.flight
        && play && play.type === 'pass';
      if (shot === 'wide') {
        /* THE WHOLE PLACE, BUT STILL POINTED AT THE FOOTBALL. A pull-out that
           always settles on midfield turns a touchdown into an aerial photo
           of a stadium with something small happening in it, so the lens
           follows the ball up the field as it goes. */
        wide = 70;
        wantX = FIELD.half;
        wantY = clamp((los || 50) * 0.34 + 34, 34, 68);
      } else if (phase === 'set') {
        /* back off far enough to show the whole formation: reading the look is
           the decision you are about to make */
        var lo = 1e9, hi = -1e9;
        actors.forEach(function (a) { if (a.x < lo) lo = a.x; if (a.x > hi) hi = a.x; });
        /* wide enough to read the look, tight enough that the men are men.
           Past the mid forties everybody is a speck and the shot stops being
           football. */
        /* TIGHTER INSIDE THE TWENTY. There is less field left to show and
           more at stake in it, so the lens comes in and the men get bigger —
           which is what a broadcast does in the red zone too. */
        wide = clamp(hi - lo + 7, 32, los > 80 ? 38 : 44);
        wantX = (lo + hi) / 2;
        wantY = los + 2;
      } else if (holding) {
        /* while he is holding it the routes are the story — but the story
           starts at the line, not five yards past it, and a shot wide enough
           to hold both sidelines makes everybody a speck */
        wide = 37;
        wantX = ballX;
        wantY = los + 2;
      } else {
        var breakaway = ball.holder && ball.holder.carry && Math.hypot(ball.holder.vx, ball.holder.vy) > 8.4;
        wide = breakaway ? 28 : los > 80 ? 31 : 35;
        wantX = tx;
        wantY = ty + (phase === 'dead' ? 0.5 : 2.5);
      }
      /* never show more sideline than there is field */
      var halfW = wide / 2;
      wantX = clamp(wantX, halfW - 4, FIELD.width - halfW + 4);
      var k = snap ? 1 : 1 - Math.pow(0.004, dt);
      var kz = snap ? 1 : 1 - Math.pow(0.05, dt);
      cam.x += (wantX - cam.x) * k;
      cam.y += (wantY - cam.y) * k;
      cam.wide += (wide - cam.wide) * kz;
      fitCamera();
    }

    /* ── DRAW ────────────────────────────────────────────────────────────── */
    /* END ZONE PAINT. The deep colour goes on the grass; the loud one goes
       on the letters. If a club's two colours are too close in brightness the
       name would vanish into its own paint, so it gets white instead. */
    function turfPaint(theme, fb) { return (theme && theme.secondary) || fb || '#123326'; }
    function lum(c) { var v = P.hex ? P.hex(c) : null; return v ? (v[0] * 299 + v[1] * 587 + v[2] * 114) / 1000 : 0; }
    function turfInk(theme) {
      if (!theme || !theme.primary || !theme.secondary) return '#ffffff';
      if (Math.abs(lum(theme.primary) - lum(theme.secondary)) < 78) return '#ffffff';
      /* paint on grass is seen from ninety yards; it is mixed lighter than the
         colour on the shirt so it still carries that far */
      return lum(theme.primary) < 120 ? P.shade(theme.primary, 0.34) : theme.primary;
    }

    function draw() {
      var w = cam.w, h = cam.h;
      ctx.save();
      if (shake > 0.001 && !reduce) {
        ctx.translate((Math.random() - 0.5) * shake * 9, (Math.random() - 0.5) * shake * 7);
      }
      ctx.fillStyle = '#0a0e13';
      ctx.fillRect(-20, -20, w + 40, h + 40);
      var scene = { tick: tick,
        homeColor: turfPaint(paints.off, opts.homeColor),
        awayColor: turfPaint(paints.def, opts.awayColor),
        homeInk: turfInk(paints.off), awayInk: turfInk(paints.def),
        homeTint: (paints.off && paints.off.primary) || null,
        awayTint: (paints.def && paints.def.primary) || null,
        homeName: names.off, awayName: names.def, firstDown: firstDown,
        light: opts.light || 'day', weather: opts.weather || 'clear', excite: excite };
      P.field(ctx, cam, scene);
      P.markers(ctx, cam, los, firstDown);
      if (phase === 'set' && showArt && artPaths) P.art(ctx, cam, artPaths);
      /* back to front, so the near men overlap the far ones — except whoever
         has the football, who is drawn last and is never buried in a pile */
      /* ONE NAME ON THE SCREEN AT A TIME: the man you are steering. Whoever
         has the football already wears a white ring, and two tags a yard
         apart just cover each other up. */
      actors.forEach(function (a) { a.label = (a.sel && userMode === 'play') ? a.name : null; });
      var sorted = actors.slice().sort(function (a, b) { return b.y - a.y; });
      /* back to front, so the near men overlap the far ones — except the two
         you must never lose in a pile: whoever has the football, and whoever
         you are steering. They are drawn last, on top of everybody. */
      var carrier = ball.holder && ball.holder.carry ? ball.holder : null;
      var mine = userActor && userActor !== carrier ? userActor : null;
      sorted.forEach(function (a) { if (a !== carrier && a !== mine) P.player(ctx, a, cam); });
      if (mine) P.player(ctx, mine, cam);
      if (carrier) P.player(ctx, carrier, cam);
      if (!ball.holder || ball.flight) P.ball(ctx, ball, cam);
      /* distance is hazier as well as smaller: drawn over the men so a deep
         safety sits back in the picture with the far stands */
      P.atmosphere(ctx, cam, scene);
      /* the throw buttons, over the men themselves */
      targetBoxes = [];
      if (targets && sim && phase === 'live' && !ball.flight && !sim.thrown()) {
        sim.targets().forEach(function (tg, i) {
          var a = byId[tg.id];
          if (!a || a.state === 'down') return;
          var box = P.target(ctx, cam, a, SLOT_LETTER[tg.slot] || String(i + 1),
            { name: tg.name, hot: tg.open > 0.55 });
          box.idx = i;
          targetBoxes.push(box);
        });
      }
      P.conditions(ctx, cam, scene);
      ctx.restore();
    }
    self.draw = draw;

    /* ── the pre-snap read the page shows over the field ───────────────── */
    self.look = function () {
      if (!defParts) return null;
      return { name: defParts.name, coverage: defParts.coverage.name,
               blitz: defParts.pressure.key !== 'none' };
    };

    resize();
    if (root.ResizeObserver) { try { new root.ResizeObserver(resize).observe(canvas); } catch (_) {} }
    if (root.addEventListener) root.addEventListener('resize', resize);
    return self;
  }

  var API = { Stage: Stage, speedOf: speedOf, Actor: Actor,
    alignOffense: alignOffense, alignDefense: alignDefense, routeWorld: routeWorldPure,
    slotPos: slotPos, jersey: jersey };
  root.EDGridironStage = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
