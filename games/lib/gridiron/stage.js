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
    /* SPLITS ARE FEET, NOT YARDS. Two and a bit yards between adjacent
       linemen put the tackles nine yards apart and strung the whole front
       across half the hashes; a real line is about six yards tackle to
       tackle, which is what makes the trenches look like trenches. */
    var olNames = ['LT', 'LG', 'C', 'RG', 'RT'], olY = [-3.0, -1.5, 0, 1.5, 3.0];
    var olPlayers = (units && units.ol && units.ol.players) || [];
    for (i = 0; i < 5; i++) {
      out.push(Actor({ id: 'o_' + olNames[i], side: 'off', pos: 'OL', slot: olNames[i],
        num: (olPlayers[i] && jersey(olPlayers[i], 70 + i)) || (70 + i),
        name: olPlayers[i] ? RO.shortName(olPlayers[i]) : '',
        player: olPlayers[i] || null,
        x: clamp(bx + olY[i], 1, FIELD.width - 1), y: ly - 0.9,
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
        /* a yard off the ball, not three: the neutral zone is the width of the
           football, and a front seven parked two yards upfield of it made the
           two lines look like they were playing different games */
        x: clamp(bx + dlY[i] + shade, 1, FIELD.width - 1), y: ly + 1.0,
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
    var cam = P.camera({ w: 390, h: 300, back: 74 });
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
    /* WHICH SHOT THE LENS IS IN. The play camera stands in the bowl, not
       above it: low enough that the far sideline, the benches and a band of
       people close the top of the picture, which is the difference between a
       football broadcast and a tactics board. */
    var shot = 'play';
    var raf = null, lastMs = 0, acc = 0;
    var events = opts.on || {};
    var flash = null;
    var shake = 0;
    /* ── WHAT CONTACT LEAVES BEHIND ──────────────────────────────────────
       Two men hit each other and nothing happens to the grass, and the whole
       thing reads as two sprites overlapping. A handful of turf, thrown at
       the point of contact and gone in half a second, is the cheapest weight
       a hit can be given. It is drawn on the ground plane in world yards, so
       it is part of the field rather than a sticker on the lens. */
    var puffs = [];
    function puff(x, y, power) {
      if (reduce || puffs.length > 40) return;
      var n = Math.min(7, 2 + Math.round(power * 5)), i;
      for (i = 0; i < n; i++) {
        var a = (i / n) * 6.2832 + t * 3.1;
        var sp = 0.7 + power * 2.0 * ((i % 3) + 1) / 3;
        puffs.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.55,
          z: 0.1 + power * 0.5, vz: 0.7 + power * 1.5, t: 0,
          life: 0.42 + power * 0.28, r: 0.16 + power * 0.16 });
      }
    }
    function stepPuffs(dt) {
      var i, p2;
      for (i = puffs.length - 1; i >= 0; i--) {
        p2 = puffs[i];
        p2.t += dt;
        if (p2.t > p2.life) { puffs.splice(i, 1); continue; }
        p2.x += p2.vx * dt; p2.y += p2.vy * dt;
        p2.z += p2.vz * dt; p2.vz -= 9.5 * dt;
        if (p2.z < 0) { p2.z = 0; p2.vz = 0; p2.vx *= 0.5; p2.vy *= 0.5; }
      }
    }
    function drawPuffs() {
      var i, p2, k2;
      for (i = 0; i < puffs.length; i++) {
        p2 = puffs[i];
        k2 = 1 - p2.t / p2.life;
        var sc = cam.scale(p2.y);
        if (sc < 3) continue;
        var px2 = cam.sx(p2.x, p2.y), py2 = cam.sy(p2.y, p2.z);
        ctx.globalAlpha = k2 * 0.45;
        ctx.fillStyle = '#b8a882';
        ctx.beginPath();
        ctx.ellipse(px2, py2, Math.max(0.8, p2.r * sc * (1.6 - k2)),
          Math.max(0.6, p2.r * sc * 0.7 * (1.6 - k2)), 0, 0, 6.2832);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    /* who was upright last tick, so a body hitting the ground is an event */
    var wasDown = {};
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
      /* ── THE HORIZON BELONGS IN THE PICTURE ──────────────────────────
         The old play lens stood seventy yards up and looked straight down,
         so the horizon sat six hundred pixels above the frame and the game
         was played on a green rectangle with nothing around it. A broadcast
         camera is forty or fifty feet up in the stand: the field runs away
         from you, the far sideline leans in, and a band of the bowl closes
         the top of the shot. That is a composition; the other is a diagram.

         Two numbers set it, both in pixels of the part of the screen you can
         actually see: where the football sits, and where the grass runs out.
         The lens height falls out of the difference. */
      var vis = Math.max(140, cam.h - coverBottom);
      if (shot === 'wide' || phase === 'kick') {
        /* THE ESTABLISHING SHOT PUTS THE LENS IN THE STAND. Low enough that
           the horizon, the bowl and the sky are all in the picture — which is
           the shot you cannot play a down on and the one that says where you
           are. */
        var hz = clamp(vis * 0.20, 24, 140);
        cam.height = clamp((cam.anchor * cam.h - hz) / cam.px, 5, 200);
        return;
      }
      /* ── THE PLAY LENS ────────────────────────────────────────────────
         Down the field from high behind the offence, tilted so the far goal
         line lands about a tenth of the way down the picture and the stand
         behind it closes the top of the frame. Higher than this and the game
         is a tactics board; lower and you are looking at eighty yards of
         empty grass with the men on it two pixels tall.

         One number: how much screen the ground between the football and the
         horizon is worth. Everything else — how big a man is, how hard the
         sidelines lean, how far the shot reaches — falls out of it. */
      /* HOW MUCH FIELD IS ABOVE THE FOOTBALL. Around 1.4 the far goal line
         and the stand behind it close the top of the picture from anywhere
         past your own thirty; around 1.9 the shot is tight on the runner and
         the far half of the field is out of it. Every shot names its own,
         and the lens dollies between them. */
      cam.height = clamp(kf * vis / cam.px, 18, 300);
    }
    /* seconds the loop is held open for a camera move that is not football */
    var kf = 1.45;
    var glide = 0;
    /* ── HOW MUCH OF THE PICTURE SOMETHING IS SITTING ON ─────────────────
       The call sheet covers the bottom half of the screen, and the camera
       went on framing the line of scrimmage at sixty per cent of the CANVAS
       — which is behind it. You were choosing a play against a strip of empty
       grass while the formation you were choosing against was under your
       thumb. Tell the stage what is covered and it frames the football into
       what is left. */
    var coverBottom = 0;
    /* WHERE THE FOOTBALL SITS IN THE PICTURE, and it is not the same for
       every shot. Before the snap it sits low, because the offence draws
       BETWEEN the camera and the line and needs room underneath. Once
       somebody is carrying it, it comes up: a runner belongs at three fifths
       of the frame with the field he is running into above him, not at three
       quarters with forty yards of empty grass over his head. */
    var anchorBias = 0.70;
    function applyAnchor() {
      var vis = Math.max(0.30, 1 - coverBottom / Math.max(1, cam.h));
      /* THE ESTABLISHING SHOT IS A COMPOSITION AND KEEPS ITS FRAMING. Pulling
         it up out from under the kickoff sheet the way the play shot is
         pulled up threw the whole building off the top of the picture. It
         gives up a little and no more. */
      if (shot === 'wide' || phase === 'kick') { cam.anchor = clamp(0.66 * vis + 0.18, 0.44, 0.66); return; }
      /* THE FOOTBALL SITS LOW IN WHAT YOU CAN SEE. Everything between it and
         the horizon is the part of the field the play happens in, so the
         lower it sits the more of that there is — and the offence draws
         BETWEEN the camera and the line, so it needs room underneath too. */
      cam.anchor = clamp(anchorBias * vis - 0.02, 0.28, 0.72);
    }
    self.setCover = function (px) {
      var v = Math.max(0, px || 0);
      if (Math.abs(v - coverBottom) < 2) return;
      coverBottom = v;
      applyAnchor();
      fitCamera();
      camFollow(0, true);
      draw();
    };
    var reduce = false;
    try { reduce = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) {}

    /* ── canvas sizing ─────────────────────────────────────────────────── */
    function resize() {
      var w = canvas.clientWidth || 390, h = canvas.clientHeight || 300;
      if (!w || !h) { if (root.requestAnimationFrame) root.requestAnimationFrame(resize); return; }
      /* TWO IS ENOUGH FOR A FOOTBALL FIELD. A phone reporting three device
         pixels per CSS pixel asks the canvas to fill two and a quarter times
         the area for a difference nobody can see on grass, and that area is
         the whole frame budget. Text is the only thing that wants three and
         there is none of it on the field. */
      dpr = Math.min(2, root.devicePixelRatio || 1);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      cam.w = w; cam.h = h;
      /* A MAN IS SIZED BY THE SCREEN, NOT BY THE YARD. On a tall window the
         camera comes in so the picture is filled by football rather than by
         empty turf; on a short one it backs off. Everything else — how far
         away the far men are, how hard the sidelines lean in — falls out of
         the perspective on its own. */
      applyAnchor();
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
      applyAnchor();
      fitCamera();
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
        los: los, ballX: ballX, env: o.env, preview: !!o.preview,
        rand: o.rand || Math.random,
        userSide: userSide, userMode: userMode,
        events: {
          onSnap: null,
          onHandoff: events.onHandoff || null,
          onThrow: events.onThrow || null,
          onCatch: events.onCatch || null,
          onIntercept: events.onIntercept || null,
          onScramble: events.onScramble || null,
          onMove: events.onMove || null,
          onBreak: function (a2, b2) {
            shake = Math.max(shake, 0.20);
            if (a2 && a2.x != null) puff(a2.x, a2.y, 1.0);
            if (events.onBreak) events.onBreak(a2, b2);
          }
        }
      });
      ball = sim.ball;
      ball.x = ballX; ball.y = los; ball.z = 0; ball.flight = null;

      artPaths = buildArt();
      userActor = sim.user();
      camFollow(0, true);
      /* AND THE LOOP RUNS WHILE THEY WAIT. The formation is not a photograph:
         backers creep, safeties rotate and the quarterback works the count
         until somebody presses snap. */
      start();
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
        /* ── AND IT POINTS WHERE THE PLAY ACTUALLY GOES ──────────────────
           This read `opts.lanePreview`, which is set nowhere in the game, so
           every run ever drawn pointed RIGHT — including a gap scheme, whose
           back aims a yard and a bit LEFT of the ball, because that is where
           live.js meshes him. A diagram that disagrees with the football is
           worse than no diagram: it is the game telling you to run at a
           lineman and then taking the yards off you for doing it. */
        var side = play.concept === 'gap' ? -1 : 1;
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

    /* ── THE KICKOFF ─────────────────────────────────────────────────────
       A SCENE, NOT A SIMULATION. The engine has already decided where this
       ball is coming back to; nothing below reads or changes that. What it
       does is show you the thing football shows you: two teams spread across
       the width of the field, a kicker taking his steps, the strike, the ball
       climbing, and the coverage going. It runs on a clock and hands back
       when it is done, and a tap anywhere ends it early.

       Three seconds. A broadcast does not give it more and neither do we. */
    var kickScene = null;
    self.kickoff = function (o) {
      o = o || {};
      var from = o.from == null ? 35 : o.from;
      var toY = o.to == null ? 8 : o.to;
      play = F.play('inside_zone'); defParts = F.defParts('base_3');
      formKey = 'single'; result = null; sim = null;
      los = from; firstDown = from; ballX = HALF;
      actors = []; byId = {}; phase = 'kick';
      var i, a, wide = FIELD.width;
      /* the kicking team, across the width and a couple of yards off the ball */
      for (i = 0; i < 10; i++) {
        var t2 = (i < 5 ? i : i + 1) / 10;
        a = Actor({ id: 'k_' + i, side: 'off', pos: i % 3 === 0 ? 'LB' : i % 3 === 1 ? 'S' : 'WR',
          slot: 'COV' + i, num: 20 + i * 3, x: 2.6 + t2 * (wide - 5.2), y: from - 1.2 });
        a.kit = kits.off; a.face = 'back'; a.state = 'stance';
        actors.push(a); byId[a.id] = a;
      }
      var kicker = Actor({ id: 'k_K', side: 'off', pos: 'K', slot: 'K', num: 4,
        x: HALF - 4.2, y: from - 8.4 });
      kicker.kit = kits.off; kicker.face = 'back'; kicker.state = 'idle';
      actors.push(kicker); byId[kicker.id] = kicker;
      /* the return team: a front wall, a middle and the man who will catch it */
      for (i = 0; i < 10; i++) {
        var row = i < 5 ? 0 : 1;
        var u = (i % 5 + 0.5) / 5;
        a = Actor({ id: 'r_' + i, side: 'def', pos: row ? 'LB' : 'WR', slot: 'RET' + i,
          num: 30 + i * 2, x: 4 + u * (wide - 8), y: from + (row ? 32 : 22) });
        a.kit = kits.def; a.face = 'front'; a.state = 'idle';
        actors.push(a); byId[a.id] = a;
      }
      var back = Actor({ id: 'r_R', side: 'def', pos: 'RB', slot: 'KR', num: 21,
        x: HALF, y: Math.max(from + 40, 100 - toY) });
      back.kit = kits.def; back.face = 'front'; back.state = 'idle'; back.sel = true;
      back.name = o.returner || '';
      actors.push(back); byId[back.id] = back;
      ball = { x: HALF, y: from, z: 0.1, spin: 0, holder: null, flight: null };
      kickScene = { t: 0, dur: o.dur || 3.4, kicker: kicker, back: back, from: from,
        struck: false, done: o.onDone || null, land: back.y };
      shot = 'wide'; applyAnchor(); fitCamera();
      camFollow(0, true);
      excite = Math.max(excite, 0.42); exciteFloor = 0.30;
      glide = kickScene.dur + 0.4;
      start();
      return kickScene;
    };
    self.skipKickoff = function () {
      if (!kickScene) return false;
      var d = kickScene.done; kickScene = null; phase = 'idle';
      if (d) d();
      return true;
    };
    function kickStep(dt) {
      var K = kickScene;
      K.t += dt;
      var T = K.t, kicker = K.kicker, i, a;
      /* THE APPROACH. Three steps, then the plant, then the strike. */
      if (T < 0.95) {
        var u = T / 0.95, e = u * u;
        kicker.x = HALF - 4.2 + 4.2 * e;
        kicker.y = K.from - 8.4 + 7.2 * e;
        kicker.vx = 4.2 * 2 * u / 0.95; kicker.vy = 7.2 * 2 * u / 0.95;
        kicker.state = 'run'; kicker.phase += dt;
      } else if (!K.struck) {
        K.struck = true;
        kicker.vx = 0; kicker.vy = 0; kicker.state = 'idle';
        shake = 0.22;
        ball.flight = { t: 0, dur: 2.05, x0: HALF, y0: K.from, tx: K.back.x, ty: K.land, peak: 13 };
        if (events.onKick) events.onKick();
        excite = 1;
      }
      /* the coverage goes on the strike; the wall turns and runs back */
      if (K.struck) {
        for (i = 0; i < actors.length; i++) {
          a = actors[i];
          if (a === kicker) continue;
          var spd = a.side === 'off' ? 7.6 : 5.4;
          var dir = a.side === 'off' ? 1 : 1;
          if (a === K.back) {
            var dx = (ball.x - a.x);
            a.x += clamp(dx, -1, 1) * dt * 3.2;
            a.vx = clamp(dx, -1, 1) * 3.2; a.vy = 0;
            a.state = ball.flight && ball.flight.t > ball.flight.dur * 0.72 ? 'catch' : 'idle';
            a.catchKind = 'high';
          } else {
            a.y += spd * dir * dt;
            a.vy = spd * dir; a.vx = 0;
            a.state = 'run';
          }
          a.phase += dt;
        }
      }
      /* the football, on an honest arc */
      var f = ball.flight;
      if (f) {
        f.t += dt;
        var q = clamp(f.t / f.dur, 0, 1);
        ball.x = f.x0 + (f.tx - f.x0) * q;
        ball.y = f.y0 + (f.ty - f.y0) * q;
        ball.z = Math.sin(Math.PI * q) * f.peak;
        ball.spin += dt * 16;
        if (q >= 1) { ball.flight = null; ball.z = 0; }
      }
      if (K.t >= K.dur) {
        var d = K.done; kickScene = null; phase = 'idle';
        if (d) d();
      }
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
    /* AND IT SAYS WHETHER IT ACTUALLY SNAPPED. A caller that locks its own
       controls on the way in has to know whether the ball moved, or a snap
       that could not happen leaves the game holding a lock nobody will ever
       release. */
    self.snapNow = function () { return phase === 'set' ? beginSnap() : false; };
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
      if (!sim) return false;
      var pi;
      for (pi = 0; pi < actors.length; pi++) {
        actors[pi].ox = 0; actors[pi].oy = 0;
        actors[pi].vx = 0; actors[pi].vy = 0;
        actors[pi].move = null;
      }
      if (!sim.snap()) return false;
      phase = 'live'; t = 0;
      /* THE SNAP HAS TO LAND. A kick in the lens and a handful of turf off
         the line, on the frame the ball moves. */
      shake = 0.19;
      puff(ballX, los, 0.34);
      if (events.onSnap) events.onSnap();
      start();
      return true;
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
      /* NOTHING RUNS OFF SCREEN. A game left in a background tab has no
         business burning a phone battery on a crowd nobody is looking at. */
      if (root.document && root.document.hidden) { stop(); return; }
      if (phase === 'dead' && dead > 1.4 && glide <= 0) stop();
      if (phase === 'idle') stop();
    }

    function update(dt) {
      t += dt; tick += dt;
      if (shake > 0) shake = Math.max(0, shake - dt * 1.6);
      if (phase === 'kick' && kickScene) { kickStep(dt); camFollow(dt); return; }
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
      /* ── HOW LONG HE HAS BEEN ON THE GROUND ─────────────────────────────
         The simulation flips a man to 'down' on one tick and that is correct;
         a body takes about a third of a second to actually get there. This is
         the clock the renderer eases the fall over, and nothing but the
         picture ever reads it. */
      if (actors) {
        for (var fi = 0; fi < actors.length; fi++) {
          var fa = actors[fi];
          if (fa.state === 'down') fa.fallT = (fa.fallT || 0) + dt;
          else fa.fallT = 0;
          /* the same clock for a throw, so the arm has time to come through */
          if (fa.state === 'throw') fa.throwT = (fa.throwT || 0) + dt;
          else fa.throwT = 0;
        }
      }
      /* ── HOW HE IS GOING TO HAVE TO CATCH IT ───────────────────────────
         Every completion played the same overhead reach because 'catch' was
         one state. Where the ball actually is when it gets there decides it:
         over his head, out to one side, or into his chest. */
      if (ball && ball.flight && ball.flight.to) {
        var rc = ball.flight.to;
        var bz = ball.z || 0, bdx = ball.x - rc.x, bdy = ball.y - rc.y;
        rc.catchKind = bz > 2.7 ? 'high'
          : Math.abs(bdx) > 1.25 ? (bdx > 0 ? 'reachR' : 'reachL')
          : bdy < -0.9 ? 'back' : 'chest';
      }

      /* ── SOMEBODY CELEBRATES ────────────────────────────────────────────
         A touchdown ends with the scorer standing exactly as he was running.
         Once the whistle has gone and the ball is in the end zone he puts his
         arms up, which costs nothing and is the difference between a play
         ending and a play being scored. */
      if (phase === 'dead' && result && result.touchdown && dead > 0.25) {
        var scorer = ball.holder || userActor;
        if (scorer && scorer.state !== 'down') scorer.state = 'celebrate';
      }
      /* A BODY HITTING THE GROUND THROWS TURF, and a man at a dead sprint
         kicks some up behind him. Both are pictures, and neither is read by
         anything that decides a yard. */
      if (actors) {
        for (var pi2 = 0; pi2 < actors.length; pi2++) {
          var pa2 = actors[pi2];
          var dn = pa2.state === 'down';
          if (dn && !wasDown[pa2.id]) puff(pa2.x, pa2.y, 0.9);
          wasDown[pa2.id] = dn;
          if (!dn && pa2.carry && Math.hypot(pa2.vx, pa2.vy) > 7.4
              && Math.random() < dt * 9) puff(pa2.x, pa2.y, 0.16);
        }
      }
      stepPuffs(dt);
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
      var wantX, wantY, wide, back, kfWant = 1.45, abWant = 0.70;
      var holding = phase === 'live' && ball.holder && ball.holder.slot === 'QB' && !ball.flight
        && play && play.type === 'pass';
      var redzone = los > 78;
      if (phase === 'kick') {
        var wide, back, kfWant;
        /* THE KICKOFF IS A WIDE SHOT THAT FOLLOWS THE BALL DOWN. It opens on
           the whole place, tightens as the ball comes off the foot and lands
           on the returner with the coverage arriving. */
        var kt = kickScene ? kickScene.t : 0;
        var q2 = clamp((kt - 0.9) / 2.0, 0, 1);
        wide = 62 - q2 * 22; back = 92 - q2 * 22; kfWant = 1.26 + q2 * 0.30;
        wantX = FIELD.half + (ball.x - FIELD.half) * q2;
        wantY = (kickScene ? kickScene.from : 35) + 6
          + (ball.y - (kickScene ? kickScene.from : 35) - 6) * q2 * 0.92;
        var hw2 = wide / 2;
        wantX = clamp(wantX, hw2 - 5, FIELD.width - hw2 + 5);
        var kk = snap ? 1 : 1 - Math.pow(0.04, dt);
        cam.x += (wantX - cam.x) * kk; cam.y += (wantY - cam.y) * kk;
        cam.wide += (wide - cam.wide) * kk; cam.back += (back - cam.back) * kk;
        kf += (kfWant - kf) * kk;
        fitCamera();
        return;
      }
      if (shot === 'wide') {
        /* THE WHOLE PLACE, BUT STILL POINTED AT THE FOOTBALL. A pull-out that
           always settles on midfield turns a touchdown into an aerial photo
           of a stadium with something small happening in it, so the lens
           follows the ball up the field as it goes. */
        wide = 74; back = 96; kfWant = 1.30; abWant = 0.70;
        wantX = FIELD.half;
        wantY = clamp((los || 50) * 0.34 + 30, 30, 66);
      } else if (phase === 'set') {
        /* BEFORE THE SNAP the shot is stable and readable: wide enough to
           hold both fronts and whichever receiver is furthest out, tight
           enough that the men are men. Inside the twenty it comes in — there
           is less field left and more at stake in it, which is what a
           broadcast does in the red zone too. */
        var lo = 1e9, hi = -1e9;
        actors.forEach(function (a) { if (a.x < lo) lo = a.x; if (a.x > hi) hi = a.x; });
        wide = clamp(hi - lo + 5, 27, redzone ? 32 : 36);
        back = 74; kfWant = redzone ? 1.62 : 1.42; abWant = 0.70;
        wantX = (lo + hi) / 2;
        wantY = los + 2.2;
      } else if (ball.flight) {
        /* ── THE BALL IS IN THE AIR ──────────────────────────────────────
           The story is no longer at the line, it is wherever the ball is
           coming down, and the throw has to be watchable while it travels.
           The lens eases out and slides up the field between the release and
           the catch, further and faster the deeper the throw is — and it
           stands further back for a deep ball, which flattens the picture so
           forty yards of route does not compress into an inch of screen. */
        var fl = ball.flight;
        var air = Math.max(0, fl.ty - los);
        var q = clamp(fl.t / Math.max(0.15, fl.dur), 0, 1);
        var ease = q * q * (3 - 2 * q);
        wide = clamp(31 + air * 0.28, 31, 44);
        back = clamp(70 + air * 1.5, 70, 128);
        kfWant = clamp(1.60 - air * 0.010, 1.34, 1.60);
        abWant = 0.66;
        wantX = ballX + (fl.tx - ballX) * ease * 0.82;
        wantY = los + 2 + (fl.ty - los - 2) * ease * 0.74;
      } else if (holding) {
        /* while he is holding it the routes are the story — but the story
           starts at the line, not five yards past it, and a shot wide enough
           to hold both sidelines makes everybody a speck */
        wide = 32; back = 78; kfWant = 1.52; abWant = 0.68;
        wantX = ballX * 0.35 + tx * 0.65;
        wantY = los + 2.6;
      } else {
        var breakaway = ball.holder && ball.holder.carry && Math.hypot(ball.holder.vx, ball.holder.vy) > 8.4;
        /* A RUNNER IS TRACKED AND THE LENS COMES IN ON HIM. In the red zone
           it comes in further; on a breakaway it comes in further still and
           drops, which is what makes a long run feel fast. */
        wide = breakaway ? 24 : redzone ? 26 : 29;
        back = breakaway ? 58 : 68;
        kfWant = breakaway ? 2.32 : redzone ? 2.02 : 2.10;
        abWant = phase === 'dead' ? 0.66 : 0.58;
        wantX = tx;
        /* A SCORE IS FOLLOWED IN. Cutting the moment he crosses the line
           leaves the whole celebration happening off the top of the picture,
           so the lens carries on into the end zone with him for a beat. */
        var scored = result && result.touchdown;
        /* THE RUNNER SITS HIGH IN THE FRAME AND THE FIELD HE IS RUNNING INTO
           SITS ABOVE HIM. The lens looks a few yards BEHIND him rather than
           in front, which is what puts him at three fifths of the picture
           with the play in front of him instead of at three quarters with
           forty yards of empty grass over his head. */
        wantY = ty + (phase === 'dead' ? (scored ? 3.2 : 0.5) : 0.6);
      }
      /* never show more sideline than there is field */
      var halfW = wide / 2;
      wantX = clamp(wantX, halfW - 5, FIELD.width - halfW + 5);
      /* EASING, NOT TRACKING. A lens that arrives exactly where it was told
         every frame is a spreadsheet cell following a number; a camera lags a
         little and catches up. Zoom and dolly lag further than pan, because a
         shot that changes width as fast as it changes aim is the thing that
         makes people put the phone down. */
      var k = snap ? 1 : 1 - Math.pow(0.010, dt);
      var kz = snap ? 1 : 1 - Math.pow(0.14, dt);
      /* THE DOLLY IS SLOWER THAN THE PAN AND FASTER THAN IT WAS. A shot
         that is still framed for the pre-snap look half a second after the
         snap is a shot that shows you forty yards of empty grass while the
         run happens at the bottom of it. */
      var kb = snap ? 1 : 1 - Math.pow(0.06, dt);
      cam.x += (wantX - cam.x) * k;
      cam.y += (wantY - cam.y) * k;
      cam.wide += (wide - cam.wide) * kz;
      cam.back += (back - cam.back) * kb;
      kf += (kfWant - kf) * kb;
      if (shot !== 'wide' && Math.abs(anchorBias - abWant) > 0.001) {
        anchorBias += (abWant - anchorBias) * kb;
        applyAnchor();
      }
      fitCamera();
    }

    /* ── THE TRENCHES, SO YOU CAN SEE THEM ───────────────────────────────
       A blocker and the man he is blocking converge on one coordinate and the
       two of them draw on top of each other: the line of scrimmage turns into
       a row of single bodies and you cannot tell who is winning. The
       simulation is right to put them there — that IS what a block is — so the
       fix belongs here, in the picture: hold the pair apart by a shoulder
       each, along the line between them, and let whoever is winning the rep
       stand the deeper of the two. Nothing below is read by the football. */
    /* ── BEFORE THE BALL MOVES ───────────────────────────────────────────
       A frozen formation is a diagram of a formation. Nothing here is
       football — the simulation does not run until the snap and never sees
       any of it — but a linebacker creeping, a safety rotating, a receiver
       resetting his feet and a quarterback working the count is the whole
       difference between a field with men on it and a field with markers on
       it. All of it goes on the PRESENTATION offsets, so every man takes the
       snap from exactly the spot the engine put him on. */
    function presnapLife() {
      var i, a, seed, w;
      for (i = 0; i < actors.length; i++) {
        a = actors[i];
        a.phase = t;
        seed = ((a.num || i) * 0.37 + i * 1.7);
        if (a.pos === 'OL' || a.pos === 'DL') {
          /* a hand in the grass does not wander; he breathes and that is all */
          a.oy += Math.sin(t * 1.3 + seed) * 0.030;
          a.vx = 0; a.vy = 0;
        } else if (a.pos === 'LB') {
          /* creeping to the line and dropping off it again */
          w = Math.sin(t * 0.66 + seed);
          a.oy += w * (a.side === 'def' ? -0.62 : 0.30);
          a.ox += Math.sin(t * 0.47 + seed * 1.6) * 0.34;
          a.vy = Math.cos(t * 0.66 + seed) * 0.66 * (a.side === 'def' ? -0.62 : 0.30) * 3;
          a.vx = 0;
        } else if (a.pos === 'S') {
          /* the shell rotating: the slowest and widest movement on the field */
          a.ox += Math.sin(t * 0.40 + seed) * 1.05;
          a.oy += Math.sin(t * 0.33 + seed * 2.1) * 0.45;
          a.vx = Math.cos(t * 0.40 + seed) * 0.40 * 1.05 * 4;
          a.vy = 0;
        } else if (a.pos === 'CB') {
          a.ox += Math.sin(t * 0.9 + seed) * 0.24;
          a.vx = Math.cos(t * 0.9 + seed) * 0.9 * 0.24 * 4;
          a.vy = 0;
        } else if (a.slot === 'QB') {
          /* THE COUNT. He rocks on the cadence, and every second beat he
             lifts a hand — which is the one gesture that makes a still
             formation look like it is about to move. */
          a.oy += Math.sin(t * 2.4 + seed) * 0.055;
          a.vx = 0; a.vy = 0;
          a.move = (Math.sin(t * 1.55) > 0.72) ? 'cadence' : null;
        } else {
          /* receivers and backs reset their feet */
          a.oy += Math.sin(t * 1.7 + seed) * 0.11;
          a.ox += Math.sin(t * 1.15 + seed * 1.3) * 0.09;
          a.vx = 0; a.vy = 0;
        }
      }
    }

    function engagementOffsets() {
      var i, a;
      for (i = 0; i < actors.length; i++) { actors[i].ox = 0; actors[i].oy = 0; }
      if (phase === 'set') presnapLife();
      for (i = 0; i < actors.length; i++) {
        a = actors[i];
        if (a.side !== 'off' || !a.lock) continue;
        var d = null, j;
        for (j = 0; j < actors.length; j++) if (actors[j].id === a.lock) { d = actors[j]; break; }
        if (!d) continue;
        var dx = d.x - a.x, dy = d.y - a.y, m = Math.hypot(dx, dy);
        if (m < 0.001) { dx = 0; dy = 1; m = 1; }
        dx /= m; dy /= m;
        /* how the rep is going: the blocker still has time on the clock and is
           driving, or he is out of it and being walked backwards */
        var win = clamp((a.rep || 0) / 1.6, 0, 1) - 0.5;
        /* A REP IS TWO MEN A YARD APART WITH THEIR HANDS ON EACH OTHER, not
           one body with two numbers on it. Hold them at arm's length along
           the line between them and stand whoever is winning the deeper of
           the two, so you can see who is driving whom. */
        var gap = 0.92 - m * 0.30;                    /* only ever pushes apart */
        if (gap < 0) gap = 0;
        a.ox = -dx * gap - dx * win * 0.34; a.oy = -dy * gap - dy * win * 0.34;
        d.ox = dx * gap - dx * win * 0.34; d.oy = dy * gap - dy * win * 0.34;
        /* and the arms go out toward the man, not down by his sides */
        a.engageX = dx; a.engageY = dy;
        d.engageX = -dx; d.engageY = -dy;
      }
      declutter();
    }

    /* ── NOBODY STANDS INSIDE ANYBODY ────────────────────────────────────
       Six men converging on a football is a pile, and a pile drawn honestly
       is one shape with six numbers somewhere inside it. The simulation is
       right to put them there — that IS what a tackle is — so the fix belongs
       in the picture: two relaxation passes that push overlapping bodies
       apart ACROSS the screen only, leaving every man on his own yard line so
       nothing about where the ball is has moved.

       Sideways, because from a camera behind the offence two men on the same
       yard line at different widths are two men, and two men at the same
       width on yard lines a foot apart are one. */
    var MIN_SEP = 1.05;
    function declutter() {
      var n = actors.length, pass, i, j, a, b, dx, dy, over, push;
      for (pass = 0; pass < 2; pass++) {
        for (i = 0; i < n; i++) {
          a = actors[i];
          if (a.state === 'down') continue;
          for (j = i + 1; j < n; j++) {
            b = actors[j];
            if (b.state === 'down') continue;
            dx = (b.x + b.ox) - (a.x + a.ox);
            dy = ((b.y + b.oy) - (a.y + a.oy)) * 1.9;   /* depth reads harder than width */
            over = MIN_SEP - Math.sqrt(dx * dx + dy * dy);
            if (over <= 0) continue;
            push = over * 0.36;
            if (Math.abs(dx) < 0.06) dx = (i % 2 ? 0.06 : -0.06);
            if (dx > 0) { a.ox -= push; b.ox += push; }
            else { a.ox += push; b.ox -= push; }
          }
        }
      }
    }

    /* ── DRAW ────────────────────────────────────────────────────────────── */
    /* END ZONE PAINT. The deep colour goes on the grass; the loud one goes
       on the letters. If a club's two colours are too close in brightness the
       name would vanish into its own paint, so it gets white instead. */
    /* ── THE PAINT IN AN END ZONE ────────────────────────────────────────
       A club's deep colour is what it paints ten yards of grass with — but a
       secondary that is nearly black gives you a hole at the end of the
       field rather than a club's end zone. Carry a quarter of the loud colour
       into it so the paint is recognisably theirs from ninety yards, and lift
       it off the floor so it reads as colour rather than as shadow. */
    function turfPaint(theme, fb) {
      var deep = (theme && theme.secondary) || fb || '#123326';
      var loud = theme && theme.primary;
      if (!loud || !P.mix) return deep;
      var m = P.mix(deep, loud, 0.30);
      return lum(m) < 34 ? P.shade(m, 0.24) : m;
    }
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
        homeName: names.off, awayName: names.def, firstDown: firstDown, los: los,
        light: opts.light || 'day', weather: opts.weather || 'clear', excite: excite };
      P.field(ctx, cam, scene);
      P.markers(ctx, cam, los, firstDown);
      if (phase === 'set' && showArt && artPaths) P.art(ctx, cam, artPaths);
      /* ── AND THE HOLE, ONCE THE BALL IS LIVE ────────────────────────────
         The pre-snap art shows the lane the play is drawn with; this shows
         the one the blocking made. Same switch as the art, so a player who
         has turned the diagrams off does not get it. */
      if (phase === 'live' && showArt && sim && sim.crease) {
        var cr = sim.crease();
        if (cr) P.crease(ctx, cam, cr);
      }
      drawPuffs();
      /* back to front, so the near men overlap the far ones — except whoever
         has the football, who is drawn last and is never buried in a pile */
      /* ONE NAME ON THE SCREEN AT A TIME: the man you are steering. Whoever
         has the football already wears a white ring, and two tags a yard
         apart just cover each other up. */
      actors.forEach(function (a) { a.label = (a.sel && userMode === 'play') ? a.name : null; });
      engagementOffsets();
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
