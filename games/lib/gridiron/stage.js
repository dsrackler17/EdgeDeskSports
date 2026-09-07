/* ===========================================================================
   GRIDIRON — the stage.

   Twenty-two football players on a field, moving. This is the layer that was
   missing: the engine says what happened, and this says what it LOOKED like,
   at sixty frames a second, with a camera that follows the ball and a pair of
   thumbs that can steer.

   ── THE CONTRACT WITH THE ENGINE ────────────────────────────────────────────
   The engine remains the source of truth. It is asked ONCE per snap, at the
   moment the player's hands have said everything they are going to say:

     RUN   at the handoff, with the lane the joystick was pushing
     PASS  at the tap, with the receiver chosen and how long it took

   It returns yards, a tackler, a touchdown, a turnover. The stage then plays
   a sequence that ARRIVES THERE. The runner is genuinely under your control
   while it happens — the director only makes sure the pursuit meets him where
   the football says it should.

   That is the standard arcade-football bargain and it is the honest one: the
   simulation decides, your hands decide how it feels, and neither lies about
   the other.

   ── WHAT AN ACTOR KNOWS ────────────────────────────────────────────────────
   Where he is, where he is trying to be, how fast he can get there, what he
   is doing with his arms, and who he is engaged with. Steering is seek-and-
   arrive with separation, which is enough for football and cheap enough for a
   phone.
   =========================================================================== */
(function (root) {
  'use strict';

  var P = root.EDGridironPaint || (typeof require === 'function' ? require('./paint.js') : null);
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
        x: clamp(bx + dlY[i] + shade, 1, FIELD.width - 1), y: ly + 2.2,
        top: speedOf('DL', dl[i] ? dl[i].overall : 65), accel: 20, kit: kit }));
    }
    var lbY = nLB >= 4 ? [-6.5, -2.2, 2.2, 6.5] : nLB === 3 ? [-5.2, 0, 5.2] : nLB === 2 ? [-3.4, 3.4] : [0];
    var lbDepth = front.key === 'goalline' ? 2.2 : 4.4;
    for (i = 0; i < nLB; i++) {
      var blitzer = isBlitzer(press, i, nLB);
      out.push(Actor({ id: 'd_LB' + i, side: 'def', pos: 'LB', slot: 'LB' + i,
        num: lb[i] ? jersey(lb[i], 50 + i) : 50 + i, name: lb[i] ? RO.shortName(lb[i]) : '',
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
    var result = null, director = null;
    var kits = { off: null, def: null };
    var names = { off: '', def: '' };
    var artPaths = null, showArt = true;
    var userSide = 'off', userActor = null, userMode = 'play';
    var steer = { x: 0, y: 0, on: false };
    var speedScale = 1;
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
      cam.height = clamp(1.807 * cam.h / cam.px, 26, 170);
    }
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
      names.off = offName || ''; names.def = defName || '';
    };
    self.setArt = function (v) { showArt = !!v; };
    self.setSpeed = function (s) { speedScale = clamp(s || 1, 0.4, 4); };
    self.setUserSide = function (s) { userSide = s === 'def' ? 'def' : 'off'; };
    self.setMode = function (m) { userMode = m; };
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
      result = null; director = null; flash = null;
      phase = 'set'; t = 0; dead = 0;
      actors = []; byId = {};

      var off = offenseSpots(play, formKey, ballX, los, o.offUnits);
      var def = defenseSpots(defParts, ballX, los, o.strong || 0, o.defUnits, play);
      off.forEach(function (a) { a.kit = kits.off; actors.push(a); byId[a.id] = a; });
      def.forEach(function (a) { a.kit = kits.def; actors.push(a); byId[a.id] = a; });

      ball.x = ballX; ball.y = los; ball.z = 0; ball.flight = null;
      ball.holder = byId['o_C'] || null;

      assignJobs();
      artPaths = buildArt();
      pickUserActor();
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
    /* ── WHO IS DOING WHAT ───────────────────────────────────────────────── */
    function assignJobs() {
      var qb = byId['o_QB'], i;
      var dls = actors.filter(function (a) { return a.side === 'def' && (a.pos === 'DL' || a.blitz); });
      var ols = actors.filter(function (a) { return a.side === 'off' && a.pos === 'OL'; });
      /* the line takes the nearest rusher each */
      var taken = {};
      ols.forEach(function (o) {
        var best = null, bd = 1e9;
        dls.forEach(function (d) {
          if (taken[d.id]) return;
          var dd = Math.abs(d.x - o.x);
          if (dd < bd) { bd = dd; best = d; }
        });
        if (best) { taken[best.id] = 1; o.job = { kind: 'block', on: best.id }; best.job = { kind: 'rush' }; }
        else o.job = { kind: 'block', on: null };
      });
      dls.forEach(function (d) { if (!d.job) d.job = { kind: 'rush' }; });

      /* the skill players run what the play says */
      actors.forEach(function (a) {
        if (a.side !== 'off' || a.pos === 'OL' || a.slot === 'QB') return;
        var rk = play.assign && play.assign[a.slot];
        if (play.type === 'run') { a.job = { kind: a.slot === 'RB' ? 'carry' : 'stalk' }; return; }
        if (!rk || rk === 'block') { a.job = { kind: 'protect' }; return; }
        a.job = { kind: 'route', route: rk, pts: routeWorld(rk, a.hx, a.hy) };
      });
      if (qb) qb.job = { kind: play.type === 'run' ? 'hand' : 'drop' };

      /* the coverage */
      var cov = defParts.coverage;
      var man = cov.key === 'cover0' || cov.key === 'cover1';
      var receivers = actors.filter(function (a) {
        return a.side === 'off' && a.job && a.job.kind === 'route';
      }).sort(function (a, b) { return Math.abs(b.hx - ballX) - Math.abs(a.hx - ballX); });
      var covers = actors.filter(function (a) {
        return a.side === 'def' && !a.blitz && a.pos !== 'DL';
      });
      covers.forEach(function (d, i2) {
        if (man && receivers[i2]) { d.job = { kind: 'man', on: receivers[i2].id }; return; }
        d.job = { kind: 'zone', x: d.x + (d.pos === 'CB' ? 0 : 0), y: d.y + zoneDepth(cov, d.pos) };
      });
      for (i = 0; i < covers.length; i++) if (!covers[i].job) covers[i].job = { kind: 'zone', x: covers[i].x, y: covers[i].y + 6 };
    }
    function zoneDepth(cov, pos) {
      if (pos === 'CB') return cov.key === 'cover2' || cov.key === 'tampa2' ? 5 : 9;
      if (pos === 'S') return cov.key === 'cover4' || cov.key === 'cover6' ? 5 : 3;
      return 5.5;
    }

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

    /* ── THE USER'S MAN ──────────────────────────────────────────────────── */
    function pickUserActor() {
      actors.forEach(function (a) { a.sel = false; });
      userActor = null;
      if (userMode !== 'play') return;
      if (userSide === 'def') {
        var best = null, bd = 1e9;
        actors.forEach(function (a) {
          if (a.side !== 'def') return;
          var d = Math.abs(a.y - los) + Math.abs(a.x - ballX) * 0.4;
          if (a.pos === 'LB' && !a.blitz) d -= 3;
          if (d < bd) { bd = d; best = a; }
        });
        userActor = best;
      } else {
        userActor = byId['o_QB'];
      }
      if (userActor) userActor.sel = true;
    }
    self.switchDefender = function () {
      if (userSide !== 'def') return;
      var target = ball.holder || byId['o_QB'];
      if (!target) return;
      var best = null, bd = 1e9;
      actors.forEach(function (a) {
        if (a.side !== 'def' || a === userActor) return;
        var d = dist(a, target);
        if (d < bd) { bd = d; best = a; }
      });
      if (best) { if (userActor) userActor.sel = false; userActor = best; userActor.sel = true; }
    };

    /* ── INPUT ───────────────────────────────────────────────────────────── */
    self.steer = function (x, y) {
      var m = Math.hypot(x, y);
      if (m > 1) { x /= m; y /= m; }
      steer.x = x; steer.y = y; steer.on = m > 0.12;
    };
    self.action = function (kind) {
      if (phase !== 'live') return false;
      var a = userSide === 'def' ? userActor : ball.holder;
      if (!a) return false;
      if (kind === 'juke' || kind === 'spin' || kind === 'truck') {
        if (a.moveCool > 0) return false;
        a.moveCool = 0.55; a.move = kind; a.moveT = 0.35;
        if (kind === 'truck') a.state = 'block';
        if (events.onMove) events.onMove(kind);
        return true;
      }
      /* break the pocket: the throw badges go away and he is a runner */
      /* break the pocket. Like every other decision on this play it is put
         to the engine, which may still let the rush get there first. */
      if (kind === 'scramble') {
        if (!director || director.kind !== 'pass' || director.decided) return false;
        targets = null; targetBoxes = [];
        director.decide(null, true);
        return true;
      }
      if (kind === 'dive' || kind === 'tackle') {
        a.dive = 0.42; a.state = 'tackle';
        return true;
      }
      return false;
    };
    /* the tap that throws it: the page hands back which read and how long */
    self.throwTo = function (idx) {
      targets = null; targetBoxes = [];
      if (phase !== 'live' || !director || director.kind !== 'pass' || director.thrown) return null;
      return director.decide(idx);
    };
    self.snapNow = function () { if (phase === 'set') beginSnap(); };
    /* ── TARGETS ─────────────────────────────────────────────────────────
       The throw buttons live ON THE RECEIVERS, out on the grass, not in a
       row along the bottom of the screen. You look at the field, see who is
       open, and press him. That is the whole reason a badge beats a menu. */
    var targets = null, targetBoxes = [];
    var SLOT_LETTER = { X: 'X', Z: 'Z', SL: 'S', SL2: 'H', TE: 'T', RB: 'R', FB: 'F', WR: 'W' };
    self.showTargets = function (list) {
      targets = (list && list.length) ? list.map(function (r, i) {
        return { id: r.id, letter: SLOT_LETTER[r.slot] || String(i + 1), name: r.name || '', idx: i };
      }) : null;
    };
    self.clearTargets = function () { targets = null; targetBoxes = []; };
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

    self.receivers = function () {
      return actors.filter(function (a) { return a.side === 'off' && a.job && a.job.kind === 'route'; })
        .map(function (a) { return { id: a.id, slot: a.slot, num: a.num, name: a.name, route: a.job.route }; });
    };

    /* ── THE SNAP ────────────────────────────────────────────────────────── */
    function beginSnap() {
      phase = 'live'; t = 0;
      var qb = byId['o_QB'];
      ball.holder = qb;
      actors.forEach(function (a) {
        a.state = a.side === 'off' && a.pos === 'OL' ? 'block' : 'run';
        a.moveCool = 0;
      });
      director = play.type === 'run' ? runDirector() : passDirector();
      if (events.onSnap) events.onSnap();
      shake = 0.12;
      start();
    }

    /* ── DIRECTORS ───────────────────────────────────────────────────────
       Each owns one kind of play: when the engine is asked, what the actors
       are told afterwards, and how the play ends. */
    function runDirector() {
      var d = { kind: 'run', handed: false, resolved: false, endY: null, tackler: null, done: false };
      d.step = function (dt) {
        var qb = byId['o_QB'], rb = byId['o_RB'] || byId['o_FB'];
        if (!d.handed && t > 0.42 && rb) {
          /* the lane the joystick was pushing when the ball changed hands */
          var lane = steer.on ? (steer.x > 0.35 ? 1 : steer.x < -0.35 ? -1 : 0) : null;
          if (userMode !== 'play' || userSide === 'def') lane = null;
          d.res = opts.resolve ? opts.resolve({ lane: lane, timing: null, read: null }) : null;
          result = d.res;
          d.handed = true; d.resolved = true;
          ball.holder = rb; rb.carry = true;
          if (rb) rb.state = 'carry';
          if (qb) { qb.job = { kind: 'watch' }; qb.state = 'run'; }
          d.endY = clamp(los + (result ? result.yards : 3), -8, 100);
          d.tackler = chooseTackler(result);
          if (events.onHandoff) events.onHandoff(rb, result);
        }
        if (d.handed) chase(d, dt);
      };
      return d;
    }

    function passDirector() {
      var d = { kind: 'pass', thrown: false, decided: false, done: false, t0: 0 };
      d.decide = function (idx, takeOff) {
        if (d.decided) return null;
        var held = t - 0.25;
        var timing = clamp(1 - (held - (play.hold || 2.4) * 0.55) / 2.0, 0, 1);
        d.res = opts.resolve
          ? opts.resolve({ read: idx, timing: timing, lane: null, scramble: !!takeOff })
          : null;
        result = d.res; d.decided = true;
        throwIt();
        return result;
      };
      d.step = function (dt) {
        var qb = byId['o_QB'];
        /* nobody threw it: he holds, then the engine decides for him */
        if (!d.decided && t > (play.hold || 2.4) + 1.5) d.decide(null);
        if (d.thrown && ball.flight) flyBall(dt);
        if (d.caught) chase(d, dt);
        if (d.sacked && !d.done) endPlay('sack');
      };
      function throwIt() {
        var qb = byId['o_QB'];
        if (!result) { endPlay('incomplete'); return; }
        if (result.sack) {
          d.sacked = true;
          var r = nearestRusher(qb);
          if (r) { r.state = 'tackle'; r.tx = qb.x; r.ty = qb.y; }
          if (qb) { qb.state = 'down'; qb.fell = (Math.random() > 0.5 ? 1 : -1); }
          d.endY = clamp(los + result.yards, -8, 100);
          setTimeout(function () { if (!d.done) endPlay('sack'); }, 520);
          return;
        }
        if (result.scramble) {
          d.caught = true; ball.holder = qb; qb.carry = true; qb.state = 'carry';
          qb.job = { kind: 'scramble' };
          d.endY = clamp(los + result.yards, -8, 100);
          d.tackler = chooseTackler(result);
          if (events.onScramble) events.onScramble();
          return;
        }
        var target = receiverFor(result);
        d.target = target;
        var interceptor = result.turnover === 'interception' ? nearestDefTo(target) : null;
        var to = interceptor || target;
        if (!to) { endPlay('incomplete'); return; }
        /* where the ball meets him: a little ahead of where he is now */
        var lead = leadPoint(to, result);
        ball.holder = null;
        ball.flight = { fx: ball.x, fy: ball.y, tx: lead.x, ty: lead.y, t: 0,
          dur: clamp(Math.hypot(lead.x - ball.x, lead.y - ball.y) / 21, 0.30, 1.1),
          to: to };
        d.thrown = true;
        if (qb) { qb.state = 'throw'; qb.hold = 0.28; }
        if (events.onThrow) events.onThrow(result, to);
      }
      function flyBall(dt) {
        var f = ball.flight;
        f.t += dt;
        var u = clamp(f.t / f.dur, 0, 1);
        ball.x = f.fx + (f.tx - f.fx) * u;
        ball.y = f.fy + (f.ty - f.fy) * u;
        ball.z = Math.sin(u * Math.PI) * (1.2 + Math.hypot(f.tx - f.fx, f.ty - f.fy) * 0.12);
        ball.spin += dt * 24;
        f.to.state = 'catch';
        f.to.tx = f.tx; f.to.ty = f.ty;
        if (u >= 1) {
          ball.flight = null; ball.z = 0;
          if (result.turnover === 'interception') {
            ball.holder = f.to; f.to.carry = true; f.to.state = 'carry';
            d.caught = true; d.pick = true;
            d.endY = clamp(f.ty - 6 - Math.random() * 6, 1, 99);
            d.tackler = nearestOffTo(f.to);
            if (events.onIntercept) events.onIntercept(f.to);
            return;
          }
          if (result.completion) {
            ball.holder = f.to; f.to.carry = true; f.to.state = 'carry';
            d.caught = true;
            d.endY = clamp(los + result.yards, -8, 100);
            d.tackler = chooseTackler(result);
            if (events.onCatch) events.onCatch(f.to, result);
            return;
          }
          f.to.state = 'run';
          if (events.onIncomplete) events.onIncomplete(result);
          endPlay(result.drop ? 'drop' : 'incomplete');
        }
      }
      return d;
    }

    /* THE PURSUIT. The carrier runs where he likes; the tackler is timed so
       the two meet where the football says they should. */
    function chase(d, dt) {
      var c = ball.holder;
      if (!c || d.done) return;
      var goingUp = !d.pick;
      var target = d.endY;
      var reached = goingUp ? c.y >= target - 0.35 : c.y <= target + 0.35;
      if (result && result.touchdown && c.y >= 99.4) { score(); return; }
      if (d.pick && c.y <= 0.6) { score(); return; }
      /* keep him honest: a little forward drift so a joystick held sideways
         still ends where the play ended */
      d.run = (d.run || 0) + dt;
      if (d.tackler) {
        var tk = d.tackler;
        var gap = dist(tk, c);
        var need = Math.abs(target - c.y);
        /* close at a rate that arrives with him */
        var urgency = need < 0.01 ? 3 : clamp(gap / Math.max(0.35, need) * 0.55, 0.55, 2.4);
        tk.tx = c.x + c.vx * 0.18; tk.ty = c.y + c.vy * 0.18;
        tk.top = tk.baseTop || (tk.baseTop = tk.top);
        tk.boost = urgency;
        if (gap < 1.15 || reached) {
          tk.state = 'tackle';
          tackle(c, tk);
          return;
        }
      } else if (reached) {
        tackle(c, null);
        return;
      }
      if (d.run > 6.5) tackle(c, d.tackler);
    }

    function chooseTackler(res) {
      if (!res) return null;
      var want = res.tackler;
      var found = null;
      if (want) {
        actors.forEach(function (a) {
          if (a.side !== 'def') return;
          if (a.name && want && RO.shortName(want) === a.name) found = a;
        });
      }
      if (found) return found;
      var pool = actors.filter(function (a) { return a.side === 'def'; });
      var c = ball.holder;
      pool.sort(function (a, b) { return dist(a, c) - dist(b, c); });
      return pool[Math.min(pool.length - 1, 1)] || pool[0];
    }
    function nearestRusher(qb) {
      var best = null, bd = 1e9;
      actors.forEach(function (a) {
        if (a.side !== 'def' || (a.pos !== 'DL' && !a.blitz)) return;
        var d = dist(a, qb); if (d < bd) { bd = d; best = a; }
      });
      return best;
    }
    function nearestDefTo(a) {
      var best = null, bd = 1e9;
      actors.forEach(function (d) {
        if (d.side !== 'def') return;
        var dd = dist(d, a); if (dd < bd) { bd = dd; best = d; }
      });
      return best;
    }
    function nearestOffTo(a) {
      var best = null, bd = 1e9;
      actors.forEach(function (o) {
        if (o.side !== 'off' || o.pos === 'OL') return;
        var dd = dist(o, a); if (dd < bd) { bd = dd; best = o; }
      });
      return best;
    }
    function receiverFor(res) {
      var slot = res.targetSlot;
      if (slot && byId['o_' + slot]) return byId['o_' + slot];
      var rs = actors.filter(function (a) { return a.side === 'off' && a.job && a.job.kind === 'route'; });
      return rs[0] || byId['o_RB'] || byId['o_QB'];
    }
    function leadPoint(a, res) {
      var depth = clamp(los + (res.airYards || 4), -6, 100);
      var dy = depth - a.y;
      return { x: clamp(a.x + a.vx * 0.25, 0.8, FIELD.width - 0.8),
               y: clamp(a.y + clamp(dy, -3, 14), -6, 100) };
    }

    function tackle(c, tk) {
      if (!director || director.done) return;
      c.state = 'down'; c.fell = tk && tk.x > c.x ? -1 : 1;
      c.vx = c.vy = 0; c.carry = false;
      if (tk) { tk.state = 'tackle'; tk.tx = c.x; tk.ty = c.y; }
      ball.holder = c;
      shake = 0.22;
      endPlay(result && result.turnover ? 'turnover' : 'tackle');
    }
    function score() {
      if (!director || director.done) return;
      var c = ball.holder;
      if (c) { c.state = 'celebrate'; c.vx = c.vy = 0; }
      shake = 0.3;
      endPlay('touchdown');
    }
    function endPlay(kind) {
      targets = null; targetBoxes = [];
      if (director) director.done = true;
      phase = 'dead'; dead = 0;
      if (events.onEnd) events.onEnd(kind, result);
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
      while (acc > 1 / 120 && steps < 8) { update(1 / 120); acc -= 1 / 120; steps++; }
      draw();
      if (phase === 'dead' && dead > 1.4) stop();
    }

    function update(dt) {
      t += dt; tick += dt;
      if (phase === 'dead') dead += dt;
      if (shake > 0) shake = Math.max(0, shake - dt * 1.6);
      if (director && phase === 'live') director.step(dt);
      actors.forEach(function (a) { think(a, dt); });
      actors.forEach(function (a) { move(a, dt); });
      separate();
      if (ball.holder && !ball.flight) {
        ball.x = ball.holder.x + (ball.holder.side === 'off' ? 0.35 : -0.35);
        ball.y = ball.holder.y + 0.2;
        ball.z = 0.35;
      }
      camFollow(dt);
    }

    /* what one actor wants to do this frame */
    function think(a, dt) {
      a.phase += dt * (a.state === 'run' || a.state === 'carry' ? 1 : 0.25);
      if (a.moveCool > 0) a.moveCool -= dt;
      if (a.moveT > 0) { a.moveT -= dt; if (a.moveT <= 0) a.move = null; }
      if (a.dive > 0) a.dive -= dt;
      if (a.hold > 0) { a.hold -= dt; if (a.hold <= 0 && a.state === 'throw') a.state = 'run'; }
      if (a.state === 'down' || a.state === 'celebrate') { a.vx *= 0.8; a.vy *= 0.8; return; }
      if (phase === 'set') { a.state = 'stance'; a.tx = a.x; a.ty = a.y; return; }

      /* the user's man goes where the thumb says */
      if (userMode === 'play' && a === userActor && steer.on && phase === 'live'
          && (userSide === 'def' || a.carry || a.job && a.job.kind === 'scramble')) {
        a.tx = a.x + steer.x * 6; a.ty = a.y + steer.y * 6;
        a.state = a.carry ? 'carry' : 'run';
        return;
      }
      if (userMode === 'play' && userSide === 'def' && a === userActor && phase === 'live') {
        var tg = ball.holder || byId['o_QB'];
        if (tg) { a.tx = tg.x; a.ty = tg.y; a.state = a.dive > 0 ? 'tackle' : 'run'; }
        return;
      }

      var j = a.job;
      if (!j) { a.tx = a.x; a.ty = a.y; return; }
      var qb = byId['o_QB'];
      switch (j.kind) {
        case 'block': {
          var d = j.on && byId[j.on];
          /* PASS PROTECTION IS A POCKET, NOT A CHARGE. On a run they drive
             forward off the ball; on a pass they set back and wall him off,
             which is the difference between a line and a diagonal scrum. */
          var pocket = play.type === 'pass' && qb ? qb.y + 1.9 : null;
          if (!d) {
            a.tx = a.x; a.ty = pocket == null ? a.y + 0.6 : pocket;
            a.state = 'block'; break;
          }
          var g = dist(a, d);
          if (g < 1.35) {
            a.state = 'engaged'; d.engaged = a.id; a.engaged = d.id;
            /* he keeps his own gap: five men converging on one point is a
               tower, not a line */
            a.tx = clamp(d.x, a.hx - 1.8, a.hx + 1.8);
            a.ty = pocket == null ? d.y - 0.5 : Math.min(d.y - 0.4, pocket);
            /* the loser of the rep gets walked backwards */
            var push = (result && result.pressure && !result.sack) ? -0.5 : 0.25;
            a.ty += push * 0.1;
          } else {
            a.state = 'block'; a.engaged = null;
            a.tx = clamp(a.hx * 0.45 + d.x * 0.55, a.hx - 2.2, a.hx + 2.2);
            a.ty = pocket == null ? d.y - 0.6 : Math.min(d.y - 0.5, pocket);
          }
          break;
        }
        case 'rush': {
          var blocked = a.engaged && byId[a.engaged];
          var free = !blocked || (result && result.sack && t > 0.55) || (result && !result.pressure && t > 2.6);
          if (ball.holder && ball.holder.side === 'off' && ball.holder.carry) {
            a.tx = ball.holder.x; a.ty = ball.holder.y; a.state = 'run';
          } else if (qb) {
            a.tx = qb.x; a.ty = qb.y - 0.4;
            a.state = blocked && !free ? 'engaged' : 'run';
            if (blocked && !free) { a.tx = a.x; a.ty = a.y - 0.05; }
          }
          break;
        }
        case 'route': {
          followPath(a, j, dt);
          break;
        }
        case 'stalk': {
          var near = nearestDefTo(a);
          if (near) { a.tx = near.x; a.ty = near.y - 0.5; a.state = dist(a, near) < 1.3 ? 'block' : 'run'; }
          break;
        }
        case 'protect': {
          a.tx = qb ? qb.x + (a.hx > ballX ? 1.4 : -1.4) : a.x; a.ty = qb ? qb.y + 0.6 : a.y;
          a.state = 'block';
          break;
        }
        case 'hand': {
          a.tx = ballX - 1.2; a.ty = los - 2.6; a.state = 'run';
          break;
        }
        case 'drop': {
          var depth = play.concept === 'quick' ? 2.6 : play.concept === 'screen' ? 3.2 : 5.2;
          a.tx = ballX + (result && result.pressure ? 1.6 : 0.2);
          a.ty = los - depth;
          a.state = t > 0.9 && result && result.pressure ? 'run' : 'run';
          break;
        }
        case 'carry': {
          if (!a.carry) { a.tx = ballX - 1.5; a.ty = los - 1.2; a.state = 'run'; break; }
          /* AI carrier: aim for the resolved end point, drifting to the lane */
          var lane = result && result.lane ? result.lane : 0;
          a.tx = clamp(a.x + lane * 2 + (a.vx * 0.2), 2, FIELD.width - 2);
          a.ty = director && director.endY != null ? director.endY + 2 : a.y + 4;
          a.state = 'carry';
          break;
        }
        case 'scramble': {
          a.tx = a.x + (a.hx > ballX ? 3 : -3);
          a.ty = director && director.endY != null ? director.endY + 1 : a.y + 3;
          a.state = 'carry';
          break;
        }
        case 'man': {
          var m = byId[j.on];
          if (m) { a.tx = m.x + (m.x > ballX ? 0.7 : -0.7); a.ty = m.y + 1.1; a.state = 'run'; }
          if (ball.holder && ball.holder.carry) { a.tx = ball.holder.x; a.ty = ball.holder.y; }
          break;
        }
        case 'zone': {
          if (ball.holder && ball.holder.carry) { a.tx = ball.holder.x; a.ty = ball.holder.y; a.state = 'run'; }
          else if (ball.flight) { a.tx = ball.flight.tx; a.ty = ball.flight.ty; a.state = 'run'; }
          else { a.tx = j.x; a.ty = j.y; a.state = 'run'; }
          break;
        }
        case 'watch': {
          a.tx = a.x; a.ty = a.y; a.state = 'run';
          break;
        }
        default: a.tx = a.x; a.ty = a.y;
      }
      /* everybody chases the football once it is loose in somebody's hands */
      if (a.side === 'def' && ball.holder && ball.holder.carry && a.job && a.job.kind !== 'rush') {
        a.tx = ball.holder.x; a.ty = ball.holder.y; a.state = 'run';
      }
      if (a.side === 'off' && ball.holder && ball.holder.side === 'def' && a.pos !== 'OL') {
        a.tx = ball.holder.x; a.ty = ball.holder.y; a.state = 'run';
      }
    }

    function followPath(a, j, dt) {
      j.i = j.i || 1;
      var p = j.pts[Math.min(j.i, j.pts.length - 1)];
      a.tx = p[0]; a.ty = p[1];
      a.state = 'run';
      if (Math.hypot(a.x - p[0], a.y - p[1]) < 1.1 && j.i < j.pts.length - 1) j.i++;
      /* once the ball is in the air to him, break for it */
      if (ball.flight && ball.flight.to === a) { a.tx = ball.flight.tx; a.ty = ball.flight.ty; }
    }

    function move(a, dt) {
      var dx = a.tx - a.x, dy = a.ty - a.y;
      var d = Math.hypot(dx, dy);
      var top = a.top * (a.boost || 1) * (a.move === 'truck' ? 0.85 : a.move === 'juke' ? 1.05 : 1);
      if (a.state === 'engaged' || a.state === 'block') top *= 0.45;
      if (a.state === 'down' || a.state === 'celebrate') top = 0;
      if (a.dive > 0) top *= 1.5;
      if (d > 0.05) {
        var ax = (dx / d) * a.accel, ay = (dy / d) * a.accel;
        a.vx += ax * dt; a.vy += ay * dt;
      } else { a.vx *= 0.82; a.vy *= 0.82; }
      /* a juke is a hard lateral step */
      if (a.move === 'juke' && a.moveT > 0.2) a.vx += (a.jukeDir || (a.jukeDir = steer.x >= 0 ? 1 : -1)) * 26 * dt;
      if (a.move === 'spin' && a.moveT > 0.15) { a.vx += Math.cos(a.moveT * 18) * 14 * dt; }
      var sp = Math.hypot(a.vx, a.vy);
      if (sp > top) { a.vx = a.vx / sp * top; a.vy = a.vy / sp * top; }
      a.x = clamp(a.x + a.vx * dt, 0.4, FIELD.width - 0.4);
      a.y = clamp(a.y + a.vy * dt, -9.5, 109.5);
      /* which way he is looking */
      if (sp > 0.6) {
        if (Math.abs(a.vx) > Math.abs(a.vy) * 1.2) a.face = a.vx > 0 ? 'right' : 'left';
        else a.face = a.vy > 0 ? 'back' : 'front';
      } else if (phase === 'set') {
        a.face = a.side === 'off' ? 'back' : 'front';
      }
      a.lean = clamp(a.vy * 0.02, -0.15, 0.15);
      a.boost = 1;
    }

    /* nobody stands inside anybody else */
    function separate() {
      var i, j2, a, b, dx, dy, d, push;
      for (i = 0; i < actors.length; i++) {
        a = actors[i];
        if (a.state === 'down') continue;
        for (j2 = i + 1; j2 < actors.length; j2++) {
          b = actors[j2];
          if (b.state === 'down') continue;
          dx = b.x - a.x; dy = b.y - a.y;
          d = Math.hypot(dx, dy);
          var min = 1.18;
          if (d > 0.0001 && d < min) {
            push = (min - d) / 2;
            dx /= d; dy /= d;
            var wa = a.pos === 'OL' || a.pos === 'DL' ? 0.35 : 1;
            var wb = b.pos === 'OL' || b.pos === 'DL' ? 0.35 : 1;
            a.x -= dx * push * wa; a.y -= dy * push * wa;
            b.x += dx * push * wb; b.y += dy * push * wb;
          }
        }
      }
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
      if (phase === 'set') {
        /* back off far enough to show the whole formation: reading the look is
           the decision you are about to make */
        var lo = 1e9, hi = -1e9;
        actors.forEach(function (a) { if (a.x < lo) lo = a.x; if (a.x > hi) hi = a.x; });
        /* wide enough to read the look, tight enough that the men are men.
           Past the mid forties everybody is a speck and the shot stops being
           football. */
        wide = clamp(hi - lo + 7, 32, 44);
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
        wide = breakaway ? 28 : 35;
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
    function draw() {
      var w = cam.w, h = cam.h;
      ctx.save();
      if (shake > 0.001 && !reduce) {
        ctx.translate((Math.random() - 0.5) * shake * 9, (Math.random() - 0.5) * shake * 7);
      }
      ctx.fillStyle = '#0a0e13';
      ctx.fillRect(-20, -20, w + 40, h + 40);
      P.field(ctx, cam, { tick: tick, homeColor: opts.homeColor, awayColor: opts.awayColor,
        homeName: names.off, awayName: names.def });
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
      /* the throw buttons, over the men themselves */
      targetBoxes = [];
      if (targets && phase === 'live' && !ball.flight) {
        targets.forEach(function (tg) {
          var a = byId[tg.id];
          if (!a || a.state === 'down') return;
          var box = P.target(ctx, cam, a, tg.letter, { name: tg.name, hot: !!tg.hot });
          box.idx = tg.idx;
          targetBoxes.push(box);
        });
      }
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
