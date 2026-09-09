/* ===========================================================================
   GRIDIRON — THE LIVE PLAY.

   PLAY MODE. Twenty-two men on a field, sixty times a second, and nobody
   knows how it ends — including this file.

   ── WHAT MAKES THIS DIFFERENT FROM THE RESOLVER ──────────────────────────
   games/lib/gridiron/engine.js can settle a snap in one call: it reads the
   ratings, the box, the coverage and the matchup and returns the yards. That
   is COACH MODE, it is still there, and it is untouched.

   This is the other half. The engine still owns everything it is good at —
   how fast a man is, how long the protection holds, how much separation a
   route can win, how hard a tackle is to break — and hands it over as an
   ENVIRONMENT (see G.prepare). What it must not decide, and here does not:

       the yards          the receiver        the run lane
       the tackle point   whether he throws   when he throws
       where he cuts

   Those come out of the loop below and the user's thumbs. A back who runs
   into his own guard loses two yards; the same back on the same call with the
   same ratings can bounce it outside and score. That is the whole point.

   ── NOTHING HERE DRAWS ────────────────────────────────────────────────────
   No canvas, no DOM, no rAF. It is a pure function of (actors, environment,
   seeded rand, and the sequence of inputs), which is why the same seed and
   the same thumbstick reproduce the same play in a test.
   =========================================================================== */
(function (root) {
  'use strict';

  var F = root.EDFootball || (typeof require === 'function' ? require('./football.js') : null);

  var FIELD = { width: 53.33, half: 26.665 };

  /* ── THE CONSTANTS OF CONTACT ────────────────────────────────────────────
     Yards. A blocker latches at ENGAGE, a tackler can reach at TACKLE, a
     receiver can catch at CATCH. Small numbers with large consequences. */
  var ENGAGE = 1.55;
  var TACKLE = 1.35;
  var CATCH = 1.55;

  var BLANK_ENV = {
    reaction: 0.3, pocket: 2.4, separation: 1, runFit: 0, deepCover: 0,
    at: {}, template: {},
    fallback: {
      off: { spd: 8.5, acc: 22, agi: 0.5, pwr: 0.5, hnd: 0.5, rte: 0.5, blk: 0.5,
             rbk: 0.5, arm: 0.5, accy: 0.5, iq: 0.5 },
      def: { spd: 8.5, acc: 22, agi: 0.5, tkl: 0.5, cov: 0.5, rsh: 0.5,
             shed: 0.5, bhk: 0.5, iq: 0.5 }
    }
  };

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function len(x, y) { return Math.hypot(x, y); }

  /* ── A LIVE PLAY ─────────────────────────────────────────────────────────
     o = { actors, playObj, parts, formKey, los, ballX, env, rand,
           userSide, userMode, events } */
  function Play(o) {
    var self = {};
    var actors = o.actors, play = o.playObj, parts = o.parts;
    /* A play with no environment can stand on the field but must never snap:
       the between-calls preview lines eleven men up and never says hut. It
       has to REFUSE, not merely be asked politely — a stale timer or a second
       thumb is exactly the thing that asks. */
    var preview = !o.env || !!o.preview;
    var env = o.env || BLANK_ENV;
    var rand = o.rand || Math.random;
    var los = o.los, ballX = o.ballX == null ? FIELD.half : o.ballX;
    var events = o.events || {};
    var userSide = o.userSide === 'def' ? 'def' : 'off';
    var manual = o.userMode !== 'coach';

    var byId = {};
    actors.forEach(function (a) { byId[a.id] = a; });

    var t = 0, phase = 'set', outcome = null;
    var runSide = 1;   /* which way a run concept goes: the art and the pull agree */
    var ball = { x: ballX, y: los, z: 0, spin: 0, holder: null, flight: null };
    var qb = byId['o_QB'] || null;
    var carrier = null, user = null;
    /* WHEN THE BALL IS IN HIS BELLY. A counter shows one way first and a
       draw waits for the rush to go past, so both mesh later than a dive. */
    var handoffAt = play.type !== 'run' ? 0 : play.key === 'counter' ? 0.80 : play.concept === 'draw' ? 0.85 : 0.62;
    var thrown = false, pressureSeen = false, handedOff = false;
    var notes = [];
    var threwAway = false;
    var bailAt = 0, bailKind = null, bailLane = null, thrownAt = null, poaX = null;
    /* ── WHOSE QUARTERBACK IS THIS ────────────────────────────────────────
       He belongs to the user only while the user is on offence with a thumb
       on the screen. Every other snap — Coach Mode, and every snap the other
       side has the ball — he is the simulation's, and he has to play like a
       quarterback rather than stand there.

       THE BUG THIS EXISTS TO KILL: `throwTo` used to be reachable from one
       place, the user's tap. So a defensive series was eleven CPU men running
       routes for a quarterback who never threw: he held it until the pocket
       fell in and the play was booked a sack. Every time. That is where
       0-for-0 passing came from, and the sack totals, and the hundred and
       forty negative yards — all one missing decision. */
    var autoQB = !manual || userSide === 'def';
    /* ── HOW SHARP THE DEFENCE IS ──────────────────────────────────────────
       The difficulty tier never touches a man's speed or strength; it
       touches his head. A rookie defence takes the worse angle, breaks on
       the ball a beat late and gives a route its cushion back; a legend
       defence reads it early. `env.sharp` is 1 at Pro, below it on Rookie,
       above it on Legend, and `dull` is what it costs the other way. */
    var sharp = clamp(env.sharp == null ? 1 : env.sharp, 0.7, 1.25);
    var dull = clamp(2 - sharp, 0.75, 1.3);

    /* ── THE MEN, AS NUMBERS ──────────────────────────────────────────────
       The engine rated every card it knows; anyone it does not know gets the
       unit average he came from, so a live play never divides by a blank. */
    actors.forEach(function (a) {
      var e = (a.player && env.at[a.player.uid || a.player.id]) || env.fallback[a.side];
      a.k = e;
      a.top = e.spd;
      a.accel = e.acc;
      a.vx = 0; a.vy = 0;
      a.state = 'stance';
      a.engaged = null; a.lock = null; a.rep = 0;
      a.stun = 0; a.moveCool = 0; a.moveT = 0; a.move = null;
      a.react = 0; a.carry = false; a.tryAt = 0; a.grace = 0;
    });

    /* ── ASSIGNMENTS ──────────────────────────────────────────────────────
       Who has whom, before anybody moves. Blockers take the nearest rusher,
       receivers run what the play says, the coverage plays what was called. */
    assign();
    function assign() {
      var rushers = actors.filter(function (a) {
        return a.side === 'def' && (a.pos === 'DL' || a.blitz);
      });
      var line = actors.filter(function (a) { return a.side === 'off' && a.pos === 'OL'; });
      var taken = {};
      line.forEach(function (b) {
        var best = null, bd = 1e9;
        rushers.forEach(function (d) {
          if (taken[d.id]) return;
          var dd = Math.abs(d.x - b.x) + Math.abs(d.y - b.y) * 0.3;
          if (dd < bd) { bd = dd; best = d; }
        });
        if (best) { taken[best.id] = 1; b.job = { kind: 'block', on: best.id }; }
        else b.job = { kind: 'block', on: null };
      });
      rushers.forEach(function (d) { d.job = { kind: 'rush', lane: d.x - ballX }; });

      /* ── THE RUN CONCEPTS ARE DIFFERENT BLOCKS ────────────────────────
         Every lineman used to take the nearest rusher and drive him,
         whatever was called, so inside zone, outside zone and power were
         one play with three names. They are not. Outside zone reaches for
         the play-side shoulder and runs the front sideways; power pulls the
         backside guard and leads through the hole; counter shows one way and
         pulls the other; a draw pass-sets for half a second and lets the
         rush run itself out of the lane. The thumb still picks the crease —
         the concept decides where the creases are. */
      if (play.type === 'run') {
        runSide = play.concept === 'gap' ? -1 : 1;
        var sortedOL = line.slice().sort(function (p, q) { return p.x - q.x; });
        line.forEach(function (b) {
          if (!b.job) return;
          b.job.reach = play.concept === 'outside' ? runSide * 0.75 : play.concept === 'inside' ? runSide * 0.30 : 0;
          if (play.concept === 'draw') b.job.setFirst = 0.55;
        });
        if (play.concept === 'gap' && sortedOL.length >= 5) {
          /* the backside guard pulls: play goes left, the right guard comes round */
          var puller = runSide < 0 ? sortedOL[3] : sortedOL[1];
          if (puller) {
            if (puller.job && puller.job.on) taken[puller.job.on] = 0;
            puller.job = { kind: 'pull', side: runSide, to: { x: ballX + runSide * 2.6, y: los - 0.9 } };
          }
        }
      }

      actors.forEach(function (a) {
        if (a.side !== 'off' || a.pos === 'OL' || a.slot === 'QB') return;
        var rk = play.assign && play.assign[a.slot];
        if (play.type === 'run') {
          a.job = { kind: a.slot === 'RB' ? 'back' : (a.pos === 'WR' ? 'stalk' : 'lead') };
          return;
        }
        if (!rk || rk === 'block') { a.job = { kind: 'protect' }; return; }
        a.job = { kind: 'route', route: rk, i: 1, pts: routeWorld(rk, a.hx, a.hy, ballX),
                  t: (F.ROUTES[rk] && F.ROUTES[rk].t) || 2.2 };
      });

      /* BLITZ PICKUP. Five linemen cannot block six rushers, which is the
         entire point of a blitz — but the back and the tight end are standing
         right there, and a protection that ignores them lets an A-gap blitz
         sack the quarterback on ninety-eight snaps in a hundred. Whoever was
         kept in takes the man nobody else has. */
      if (play.type === 'pass') {
        var free = rushers.filter(function (d) { return !taken[d.id]; });
        var helpers = actors.filter(function (a) {
          return a.side === 'off' && a.job && a.job.kind === 'protect';
        });
        free.forEach(function (d, i) {
          var h = helpers[i];
          if (!h) return;
          taken[d.id] = 1;
          h.job = { kind: 'block', on: d.id };
        });
      }
      if (qb) qb.job = { kind: play.type === 'run' ? 'hand' : 'drop' };

      /* the coverage. Man travels; zone sits on a landmark and reads. */
      var cov = parts.coverage;
      var isMan = cov.key === 'cover0' || cov.key === 'cover1' || cov.key === 'match';
      var routes = actors.filter(function (a) { return a.side === 'off' && a.job && a.job.kind === 'route'; })
        .sort(function (a, b) { return Math.abs(b.hx - ballX) - Math.abs(a.hx - ballX); });
      var covers = actors.filter(function (a) {
        return a.side === 'def' && !a.blitz && a.pos !== 'DL';
      });
      covers.forEach(function (d, i) {
        if (isMan && routes[i]) { d.job = { kind: 'man', on: routes[i].id }; return; }
        d.job = { kind: 'zone', x: d.x, y: d.y + zoneDepth(cov, d.pos), gap: d.x - ballX,
                  width: zoneWidth(cov, d.pos) };
      });
      /* ── RUN FITS ──────────────────────────────────────────────────────
         Against a run the box does not chase the football; it fills. Every
         front-seven defender owns a gap on the line of scrimmage and gets
         there first, and only once the ball has declared does he pursue.
         Without this a stacked box is worth nothing — the back simply runs
         between eleven men all converging on where he used to be, which is
         how an inside zone against nine in the box went for seventeen. */
      if (play.type === 'run') {
        /* THE GAPS ARE INSIDE THE TACKLE BOX. Spread them wider than that and
           the fit becomes a hole: the first version of this fanned seven men
           across seventeen yards and the back walked up the middle of it every
           time. The line fills at the ball, the linebackers fill behind them,
           and the secondary keeps its coverage and stays the last line. */
        var dl = actors.filter(function (a) { return a.side === 'def' && a.pos === 'DL'; })
          .sort(function (a, b) { return a.x - b.x; });
        var lb = actors.filter(function (a) { return a.side === 'def' && a.pos === 'LB'; })
          .sort(function (a, b) { return a.x - b.x; });
        fit(dl, 4.6, 1.1);
        fit(lb, 6.2, 3.4);
        /* a draw is a pass until it is not: the backers drop for a beat */
        if (play.concept === 'draw') lb.forEach(function (d) { if (d.job && d.job.kind === 'fill') d.job.dropFirst = 0.45; });

        /* ── THE SECOND LEVEL ────────────────────────────────────────────
           Five linemen against a four-man front leaves one free, and what he
           does with himself is the whole run game: he climbs to the backer
           filling the gap the ball is going to. Nobody was doing that. Every
           carry in this simulation met an unblocked linebacker at the line of
           scrimmage, which is why the live run game averaged two and a half
           yards a pop no matter who was blocking and no matter who was
           carrying it — the ratings had nothing to act on. */
        var claimedD = {};
        line.forEach(function (b) { if (b.job && b.job.on) claimedD[b.job.on] = 1; });
        var free = line.filter(function (b) { return !b.job || !b.job.on; });
        var backers = lb.filter(function (d) { return !claimedD[d.id] && !d.blitz; })
          .sort(function (a, b) { return Math.abs(a.x - ballX) - Math.abs(b.x - ballX); });
        free.forEach(function (b, i) {
          var m = backers[i];
          if (!m) return;
          claimedD[m.id] = 1;
          b.job = { kind: 'block', on: m.id, climb: true };
        });
      }
      function fit(list, half, depth) {
        list.forEach(function (d, i) {
          var slot = list.length > 1 ? (i / (list.length - 1) - 0.5) * 2 : 0;
          d.job = { kind: 'fill', x: clamp(ballX + slot * half, 1.5, FIELD.width - 1.5),
                    y: los + depth, home: d.x };
        });
      }
      actors.forEach(function (a) {
        if (a.side !== 'def' || !a.job) return;
        a.gap = a.x - ballX;
      });
    }

    /* HOW FAR HE BAILS, from where he lined up. A deep zone is deep: a safety
       whose landmark is four yards behind his alignment is not playing over
       the top of anything, and four verticals ran straight past him for
       twenty-seven yards a throw. A hard corner in cover two squats; a bail
       corner in three or four gets to the top of the numbers. */
    /* HOW WIDE HIS ZONE IS. A deep third is a third of the field; a deep
       half is half of it; quarters are quarters. It is the lateral distance
       he is responsible for, which is what says whether the man running past
       him is his problem. */
    function zoneWidth(cov, pos) {
      var k = cov.key;
      if (pos === 'CB') return k === 'cover2' || k === 'tampa2' ? 9 : k === 'cover4' || k === 'cover6' ? 11 : 13;
      if (pos === 'S') return k === 'cover2' || k === 'tampa2' ? 15 : k === 'cover4' || k === 'cover6' ? 12 : 17;
      return 8;
    }
    function zoneDepth(cov, pos) {
      var k = cov.key;
      if (pos === 'CB') return k === 'cover2' || k === 'tampa2' ? 4.5 : 13.0;
      if (pos === 'S') {
        if (k === 'cover4' || k === 'cover6') return 8.5;
        if (k === 'cover2' || k === 'tampa2') return 8.0;
        return 8.5;
      }
      /* the middle linebacker runs the pipe in tampa two */
      return k === 'tampa2' ? 11.0 : 5.5;
    }

    /* ── THE SNAP ─────────────────────────────────────────────────────────── */
    self.snap = function () {
      if (phase !== 'set' || preview) return false;
      phase = 'live'; t = 0;
      ball.holder = qb;
      if (qb) { qb.carry = play.type !== 'pass'; }
      carrier = qb;
      /* ── THE QUARTERBACK IS YOURS FROM THE SNAP ────────────────────────
         Before the throw he drops on his own, but a thumb on the stick
         moves him: a step up, a roll either way, a reset. The user's man
         used to be nobody until a handoff or a catch, so the stick did
         nothing for the first three seconds of every pass play — and the
         stick doing nothing is the worst thing a control can do. */
      refreshUser();
      actors.forEach(function (a) {
        a.state = a.side === 'off' && a.pos === 'OL' ? 'block' : 'run';
        /* a defence that did not read it is a beat late off the ball — and a
           rookie defence is later still, a legend one earlier: the tier is a
           head start, never a step of speed */
        a.react = a.side === 'def' ? env.reaction * (0.6 + rand() * 0.8) * dull : 0;
      });
      if (events.onSnap) events.onSnap();
      return true;
    };

    self.phase = function () { return phase; };
    self.time = function () { return t; };
    self.ball = ball;
    self.actors = actors;
    self.carrier = function () { return carrier; };
    self.user = function () { return user; };
    self.outcome = function () { return outcome; };
    self.setUser = function (a) {
      if (user) user.sel = false;
      user = a || null;
      if (user) user.sel = true;
    };

    /* who the user is steering right now */
    function refreshUser() {
      if (!manual) { self.setUser(null); return; }
      if (userSide === 'def') { if (!user) self.setUser(nearestDefTo(carrier || ball)); return; }
      if (play.type === 'run' && !handedOff) { self.setUser(null); return; }
      self.setUser(carrier && carrier.side === 'off' ? carrier : null);
    }
    refreshUser();

    /* ── ELIGIBLE TARGETS, for the badges over the receivers ─────────────── */
    /* IN THE ORDER THE PLAY READS THEM. The engine already knows which route
       this concept expects to win against this shell; the first badge is the
       primary, the last is the check-down. Throwing to the wrong one is then
       a decision the user made, not a shuffle he could not see. */
    var ORDER = (function () {
      var out = {}, i;
      var list = [];
      /* THE COVERAGE, NOT ITS NAME. F.reads indexes the coverage table by
         route band; handed the key as a string every separation came back
         zero, so the badges and the AI quarterback read the routes in the
         order they were typed rather than the order that beats the shell. */
      try { list = F.reads(play.key, parts.coverage) || []; } catch (_) { list = []; }
      for (i = 0; i < list.length; i++) out[list[i].slot] = i;
      return out;
    })();
    self.targets = function () {
      if (phase !== 'live' || play.type !== 'pass' || thrown) return [];
      return progression().map(function (a) {
        return { id: a.id, slot: a.slot, name: a.name, route: a.job.route, open: openness(a) };
      });
    };

    /* ── ONE FRAME ────────────────────────────────────────────────────────
       The order matters: read the thumbs, move the man they hold, let the
       eleven others decide, then let the world push back. */
    self.step = function (dt, input) {
      dt = clamp(dt || 0.016, 0.001, 0.05);
      input = input || {};
      if (phase === 'set') { if (input.snap) self.snap(); return; }
      /* after the whistle the bodies still settle, so the picture does not
         freeze mid-stride while the page books the play */
      if (phase === 'dead') { integrate(dt); return; }
      t += dt;

      /* THE HANDOFF. A run play is the quarterback's for about half a second
         and the back's for the rest of it; until the ball is in his belly
         there is nothing for a thumb to steer. */
      if (play.type === 'run' && !handedOff && t >= handoffAt) handoff();
      /* WHERE HE HIT THE LINE. The point of attack is not where he was
         tackled and it is not where the play was drawn — it is the spot he
         crossed the line of scrimmage, and it is the only place worth asking
         who won a block. */
      if (poaX == null && carrier && carrier.carry && carrier.y >= los) poaX = carrier.x;

      /* 1 — the thumbs */
      applyInput(input);
      /* 2..7 — everybody decides */
      actors.forEach(function (a) { think(a, dt); });
      /* 8 — the football */
      if (ball.flight) flyBall(dt);
      /* movement */
      integrate(dt);
      separate();
      /* 9 — contact */
      blocks(dt);
      contact(dt);
      /* 10 — is it over */
      checkEnd();
      /* the ball rides with whoever has it */
      if (ball.holder) {
        ball.x = ball.holder.x + (ball.holder.side === 'off' ? 0.35 : -0.35);
        ball.y = ball.holder.y + 0.25;
        ball.z = 0.9;
      }
    };

    /* ── INPUT ────────────────────────────────────────────────────────────── */
    function handoff() {
      var rb = byId['o_RB'] || byId['o_FB'] || byId['o_SL'];
      handedOff = true;
      if (!rb) return;
      rb.carry = true; rb.state = 'carry';
      if (qb) { qb.carry = false; qb.state = 'run'; qb.job = { kind: 'watch' }; }
      ball.holder = rb; carrier = rb;
      refreshUser();
      if (events.onHandoff) events.onHandoff(rb);
    }

    function applyInput(input) {
      if (!manual) return;
      if (input.throwTo != null && !thrown) throwTo(input.throwTo, input.throwKind || null);
      if (input.action) doAction(input.action);
      if (input.switchDef && userSide === 'def') switchUser();
      var a = user;
      if (!a || a.state === 'down') return;
      /* SPRINT IS A BUTTON YOU HOLD. It buys a step and costs wind: the
         gauge drains while it is held and refills while it is not, faster
         for a man with the stamina for it. */
      a.sprint = !!input.sprint && a.gas > 0.05;
      var mx = input.mx || 0, my = input.my || 0;
      var m = len(mx, my);
      if (m > 0.08) {
        /* THE STICK IS A DIRECTION, NOT A DESTINATION. He accelerates the way
           the thumb points and keeps his momentum when it lets go, which is
           what makes a cutback something you have to set up. */
        a.dx = mx / m; a.dy = my / m;
        a.drive = clamp(m, 0, 1);
      } else {
        a.drive = 0;
      }
      a.steered = true;
    }

    /* SWITCH CYCLES. It used to pick the nearest defender who was not the
       current one, which on a play with two men near the ball is a coin that
       lands on the same two faces for ever. Cycle through the men nearest the
       ball in order, so a third tap reaches a third man. */
    function switchUser() {
      var tgt = carrier || ball, list = [];
      actors.forEach(function (d) { if (d.side === 'def' && d.state !== 'down') list.push(d); });
      list.sort(function (p, q) { return dist(p, tgt) - dist(q, tgt); });
      if (!list.length) return;
      var i = user ? list.indexOf(user) : -1;
      var n = list[(i + 1) % list.length];
      if (n && n !== user) self.setUser(n);
    }

    /* ── THE MOVES ─────────────────────────────────────────────────────────
       Four things a ball carrier can do and three a defender can, none of
       them a teleport and all of them worth less the more they are spammed.
       `a.spam` climbs with every move and drains over three seconds; the
       tackle roll reads it, so a back who jukes every half second is a back
       who is about to get hit square. */
    function spent(a) {
      var pen = clamp(1 - (a.spam || 0) * 0.30, 0.25, 1);
      a.spam = Math.min(3, (a.spam || 0) + 1);
      return pen;
    }
    function doAction(kind) {
      var a = userSide === 'def' ? user : carrier;
      if (!a || a.state === 'down') return;
      if (kind !== 'scramble' && a.moveCool > 0) return;
      var pen, s;
      if (kind === 'juke') {
        /* a cut: lateral, quick, and it costs him a stride. Bounded so a
           99 agility man is very quick, not somewhere else. */
        pen = spent(a);
        a.moveCool = 0.62; a.move = 'juke'; a.moveT = 0.34; a.moveEdge = (0.13 + a.k.agi * 0.30) * pen;
        s = a.dx >= 0 ? 1 : -1;
        a.vx += s * 4.6 * (0.55 + a.k.agi * 0.7) * pen;
        a.vy *= 0.74;
        if (events.onMove) events.onMove('juke');
      } else if (kind === 'spin') {
        /* a spin keeps him going forward and turns his back to the tackler for
           a beat: harder to wrap, slower through it */
        pen = spent(a);
        a.moveCool = 0.90; a.move = 'spin'; a.moveT = 0.42; a.moveEdge = (0.16 + a.k.agi * 0.26) * pen;
        a.vx *= 0.55; a.vy *= 0.82;
        a.spinT = 0.42;
        if (events.onMove) events.onMove('spin');
      } else if (kind === 'stiff' || kind === 'truck') {
        /* a stiff arm is strength against a man you can reach; with nobody
           there it is a shoulder lowered into the next contact */
        pen = spent(a);
        var near = nearestDefTo(a, null, 2.6);
        a.moveCool = 0.80; a.moveT = 0.40;
        if (near && !near.lock) {
          a.move = 'stiff'; a.moveEdge = (0.12 + a.k.str * 0.32) * pen;
          var win = a.k.str * 0.9 + 0.25 - near.k.tkl * 0.6;
          if (rand() < clamp(0.35 + win, 0.10, 0.92)) {
            near.stun = (0.42 + a.k.str * 0.45) * pen; near.vx *= 0.25; near.vy *= 0.25;
            var px = near.x - a.x, py = near.y - a.y, pl = len(px, py) || 1;
            near.x += px / pl * 0.55; near.y += py / pl * 0.55;
            notes.push(shortName(a) + ' shoved ' + shortName(near) + ' off.');
          }
          a.vx *= 0.92; a.vy *= 0.92;
        } else {
          a.move = 'truck'; a.moveEdge = (0.09 + a.k.str * 0.26) * pen;
          a.vy += (a.side === 'off' ? 1 : -1) * 2.2 * (0.5 + a.k.str) * pen;
          a.vx *= 0.6;
        }
        a.state = 'block';
        if (events.onMove) events.onMove(a.move);
      } else if (kind === 'dive') {
        /* he leaves his feet: a longer reach, a lunge, and a beat on the
           ground if he misses */
        a.moveCool = 0.95;
        a.dive = 0.50; a.state = 'tackle';
        var tgt = carrier || qb;
        if (tgt) { var lx = tgt.x - a.x, ly = tgt.y - a.y, ll = len(lx, ly) || 1; a.vx += lx / ll * 3.6; a.vy += ly / ll * 3.6; }
        a.diveMiss = 0.70;
        if (events.onMove) events.onMove('dive');
      } else if (kind === 'tackle') {
        /* a form tackle: shorter reach, no penalty for missing */
        a.moveCool = 0.45;
        a.dive = 0.32; a.state = 'tackle';
      } else if (kind === 'scramble' && qb && !thrown && play.type === 'pass') {
        qb.job = { kind: 'scramble' };
        qb.carry = true; carrier = qb; ball.holder = qb;
        notes.push('He breaks the pocket.');
        refreshUser();
        if (events.onScramble) events.onScramble();
      }
    }

    /* ── WHAT EACH MAN IS TRYING TO DO ────────────────────────────────────── */
    function think(a, dt) {
      a.phase += dt * (a.state === 'run' || a.state === 'carry' ? 1 : 0.25);
      if (a.moveCool > 0) a.moveCool -= dt;
      if (a.moveT > 0) { a.moveT -= dt; if (a.moveT <= 0) { a.move = null; a.moveEdge = 0; } }
      if (a.spinT > 0) a.spinT -= dt;
      if (a.spam > 0) a.spam = Math.max(0, a.spam - dt / 3);
      if (a.stun > 0) a.stun -= dt;
      if (a.grace > 0) a.grace -= dt;
      if (a.dive > 0) { a.dive -= dt; if (a.dive <= 0 && a.diveMiss > 0) { a.stun = Math.max(a.stun, a.diveMiss); a.diveMiss = 0; } }
      /* the wind: sprinting drains it, everything else refills it */
      if (a.gas == null) a.gas = 1;
      if (a.sprint) a.gas = Math.max(0, a.gas - dt * (0.34 - a.k.sta * 0.16));
      else a.gas = Math.min(1, a.gas + dt * (0.10 + a.k.sta * 0.10));
      /* the ball has changed hands: everybody on offence becomes a tackler */
      if (carrier && carrier.side === 'def' && a.side === 'off' && a.state !== 'down') {
        if (a === user && a.steered && a.drive > 0.08) { /* the thumb is on him */ }
        else { pursue(a, carrier); a.state = a.dive > 0 ? 'tackle' : 'run'; return; }
      }
      if (a.react > 0) { a.react -= dt; if (a.side === 'def') { a.tx = a.x; a.ty = a.y; return; } }
      if (a.state === 'down' || a.state === 'celebrate') return;

      /* the man in your thumb goes where you point */
      if (a === user && a.steered && a.drive > 0.08) {
        /* a quarterback steered across the line with the ball is running
           it: the play becomes a scramble, and is booked as one */
        if (a === qb && !a.carry && !thrown && play.type === 'pass' && a.y > los + 0.3) doAction('scramble');
        var aim = a.carry ? lane(a) : null;
        if (aim) { a.tx = aim.x; a.ty = aim.y; }
        else { a.tx = a.x + a.dx * 8; a.ty = a.y + a.dy * 8; }
        a.state = a.carry ? 'carry' : 'run';
        return;
      }
      if (a === user && userSide === 'def' && !a.steered && !(carrier && carrier === a)) {
        var tg = carrier || qb;
        if (tg) { a.tx = tg.x; a.ty = tg.y; a.state = a.dive > 0 ? 'tackle' : 'run'; }
        return;
      }
      /* a defender with the ball and no thumb on him runs to daylight the
         other way */
      if (a.carry && a.side === 'def' && !(a === user && a.steered)) {
        var back = daylight(a);
        a.tx = back.x; a.ty = back.y; a.state = 'carry';
        return;
      }

      var j = a.job;
      if (!j) { a.tx = a.x; a.ty = a.y; return; }
      switch (j.kind) {
        case 'block': return blockThink(a, j);
        case 'rush': return rushThink(a, j);
        case 'route': return routeThink(a, j, dt);
        case 'protect':
          a.tx = qb ? qb.x + (a.hx > ballX ? 1.5 : -1.5) : a.x;
          a.ty = qb ? qb.y + 0.7 : a.y; a.state = 'block'; return;
        case 'stalk': {
          var n = nearestDefTo(a);
          if (n) { a.tx = n.x; a.ty = n.y - 0.6; a.state = dist(a, n) < 1.4 ? 'block' : 'run'; }
          return;
        }
        case 'lead': {
          /* the fullback leads through the hole ahead of the back */
          var b = byId['o_RB'];
          var aim = b ? b.x : ballX;
          a.tx = aim; a.ty = los + 1.6; a.state = 'block';
          var d2 = nearestDefTo(a);
          if (d2 && dist(a, d2) < 3) { a.tx = d2.x; a.ty = d2.y - 0.4; }
          return;
        }
        case 'pull': {
          /* round the corner behind the line, then through the hole: the
             first defender waiting there is his, and he leads the back */
          var arrived = Math.abs(a.x - j.to.x) < 1.2 && a.y > j.to.y - 0.6;
          if (!arrived && !a.lock) { a.tx = j.to.x; a.ty = j.to.y; a.state = 'run'; return; }
          var kick = null, kd = 4.2;
          actors.forEach(function (r) {
            if (r.side !== 'def' || r.lock || r.state === 'down') return;
            if ((r.x - a.x) * j.side < -1.5) return;      /* behind the pull */
            var g = dist(a, r);
            if (g < kd) { kd = g; kick = r; }
          });
          if (kick) { a.tx = kick.x; a.ty = kick.y - 0.3; a.job.on = kick.id; a.state = dist(a, kick) < 1.4 ? 'block' : 'run'; return; }
          a.tx = j.to.x + j.side * 1.2; a.ty = los + 2.2; a.state = 'block'; return;
        }
        case 'hand':
          a.tx = ballX - 1.4; a.ty = los - 2.4; a.state = 'run'; return;
        case 'back': return backThink(a, j);
        case 'drop': return dropThink(a, j);
        case 'scramble': {
          if (!a.steered) {
            var grass = daylight(a);
            a.tx = grass.x; a.ty = grass.y;
          }
          a.state = 'carry'; return;
        }
        case 'fill': return fillThink(a, j);
        case 'watch':
          a.tx = a.x + (a.x > ballX ? 1.2 : -1.2); a.ty = a.y - 1.2; a.state = 'run'; return;
        case 'man': return manThink(a, j);
        case 'zone': return zoneThink(a, j);
        default: a.tx = a.x; a.ty = a.y;
      }
    }

    /* THE BACK, when nobody is steering him: aim at the called lane, then run
       to daylight. The user replaces exactly this. */
    function backThink(a, j) {
      if (!a.carry) {
        var mesh = { x: ballX + (play.concept === 'gap' ? -1.1 : 0), y: los - 1.9 };
        /* a counter's first step is the wrong way, on purpose */
        if (play.key === 'counter' && t < 0.42) mesh = { x: ballX + 1.6, y: los - 2.6 };
        a.tx = mesh.x; a.ty = mesh.y; a.state = 'run';
        return;
      }
      /* the first beat after the mesh he runs the play as drawn — the edge,
         the hole behind the pull, the middle — then he runs to daylight */
      var aim;
      if (t < handoffAt + 0.45 && play.concept === 'outside') aim = { x: clamp(ballX + runSide * 7, 2, FIELD.width - 2), y: los + 1.5 };
      else if (t < handoffAt + 0.40 && play.concept === 'gap') aim = { x: ballX + runSide * 2.6, y: los + 1.2 };
      else aim = daylight(a);
      a.tx = aim.x; a.ty = aim.y;
      a.state = 'carry';
    }
    /* where the grass is: sample a fan of angles and take the one with the
       most room before the nearest defender. It is crude and it is enough to
       make an AI back look like he is reading blocks. */
    /* ── THE THUMB PICKS THE DIRECTION; THE MAN PICKS THE CREASE ──────────
       A ball carrier steered straight at his own centre's back used to run
       straight into it, because the stick was read as a heading and handed
       to the legs unedited. That is not what a stick means in a football
       game and it is not what a back does: you tell him where you want to
       go and he finds the seam nearest to it, because he can see the man in
       front of him and you, holding a phone, largely cannot.

       It cost the user the game. Steering the ball INTO the line was worth
       1.77 yards a carry against 2.04 for letting go of the stick entirely,
       and 2.90 against 4.02 on outside zone — the game punished you for
       playing it. A control that is worse than no control is not a control.

       So: a narrow cone around the thumb, his own blockers counted as the
       bodies they are, and a real cost for every degree away from where you
       pointed, so this bends him around a lineman and never overrules him.
       In open grass — nobody within reach — it does nothing at all and he
       goes exactly where you say. */
    var LANE_CONE = 0.145;                 /* ~8.3 degrees per step, 3 each way */
    function lane(a) {
      /* open field: no edit. The cone exists to get him through traffic. */
      var tight = false;
      for (var q = 0; q < actors.length; q++) {
        var o = actors[q];
        if (o === a || o.state === 'down') continue;
        if (Math.abs(o.x - a.x) > 4.5) continue;
        var ahead = (o.y - a.y) * (a.side === 'off' ? 1 : -1);
        if (ahead > -0.5 && ahead < 4.5) { tight = true; break; }
      }
      if (!tight) return { x: a.x + a.dx * 8, y: a.y + a.dy * 8 };

      var base = Math.atan2(a.dx, a.dy);
      var best = null, bs = -1e9, i;
      for (i = -3; i <= 3; i++) {
        var ang = base + i * LANE_CONE;
        var dx = Math.sin(ang), dy = Math.cos(ang);
        var px = clamp(a.x + dx * 6, 0.5, FIELD.width - 0.5), py = a.y + dy * 6;
        var room = 1e9;
        for (var w = 0; w < actors.length; w++) {
          var m = actors[w];
          if (m === a || m.state === 'down') continue;
          /* HIS OWN MEN ARE BODIES TOO. A hole is a hole whoever is standing
             in it, and running up the back of your own centre is the single
             most common way this game threw a carry away. A blocker is worth
             less than a tackler in the way — you can run off his hip — but he
             is not worth nothing. */
          var w8 = m.side === a.side ? 0.62 : 1;
          room = Math.min(room, Math.hypot(m.x - px, m.y - py) / w8);
        }
        /* THE SAME SIX YARDS THE AI BACK IS ALLOWED TO SEE. Searching a
           shorter, meaner cone than `daylight` meant the man under a thumb
           read the field worse than the man running himself, which is the
           bug this whole function exists to fix. Only the cone differs now:
           he looks where you are pointing, and he looks as well as he can. */
        /* and the end zone is still that way. Scoring room alone let the
           cone walk him sideways out of a crease he was already in, which
           is a lateral yard bought with a downfield one. */
        var fwd = (py - a.y) * (a.side === 'off' ? 1 : -1) / 6;
        var sc = Math.min(room, 6.0) + fwd * 1.9 - Math.abs(i) * 0.62;
        if (sc > bs) { bs = sc; best = { x: px, y: py }; }
      }
      return best || { x: a.x + a.dx * 8, y: a.y + a.dy * 8 };
    }

    function daylight(a) {
      var best = null, bs = -1e9, i;
      /* which way is forward: the offence attacks +y, a defender with the
         ball attacks -y */
      var dir = a.side === 'def' ? -1 : 1;
      for (i = -4; i <= 4; i++) {
        var ang = i * 0.19;
        var dx = Math.sin(ang), dy = Math.cos(ang) * dir;
        var px = clamp(a.x + dx * 6, 1, FIELD.width - 1), py = a.y + dy * 6;
        var room = 1e9;
        actors.forEach(function (d) {
          if (d.side !== 'def' || d.state === 'down') return;
          room = Math.min(room, Math.hypot(d.x - px, d.y - py));
        });
        /* SPACE IS ONLY WORTH SO MUCH. Scoring the whole distance to the
           nearest defender sent a ball carrier in the open field at the
           emptiest part of the stadium rather than at the end zone — and
           since the emptiest part is also the direction nobody has an angle
           from, one completion in four went the distance. Six yards of room
           is all a runner can use; past that he runs north like everybody
           else and the pursuit gets its angle back. Inside the box nothing
           changes, which is where this reading is doing its real work.

           VISION IS A RATING. A back who sees it takes the lane the search
           found; one who does not takes one next to it. */
        var s = Math.min(room, 6.0) + dy * 2.2 - Math.abs(i) * 0.10
              + (a.k.iq == null ? 0 : (1 - a.k.iq) * (rand() - 0.5) * 2.6);
        if (s > bs) { bs = s; best = { x: px, y: py }; }
      }
      return best || { x: a.x, y: a.y + 5 };
    }

    /* A BLOCKER STANDS IN THE WAY. He does not retreat to a line and hope the
       rusher runs into it — that was the first version of this and the two of
       them politely kept four yards apart all afternoon while the quarterback
       was buried. He puts himself ON the path between his man and the ball,
       close enough to get hands on him. */
    /* HIS GAP FIRST, THE FOOTBALL SECOND. He gets downhill to the line at
       his own landmark and holds it until the ball commits; then he is free
       to chase. A defence that skips this step is eleven men in a queue. */
    function fillThink(a, j) {
      var c = carrier;
      if (j.dropFirst && t < j.dropFirst) { a.tx = j.x; a.ty = j.y + 3.5; a.state = 'run'; return; }
      if (c && c.carry && c !== qb) {
        var declared = c.y > los + 1.0 || Math.abs(c.x - j.x) < 2.6 || t > 2.4;
        if (declared) { pursue(a, c); return; }
        /* he squeezes toward the ball without leaving his gap */
        a.tx = j.x * 0.55 + c.x * 0.45; a.ty = j.y;
        a.state = 'run';
        return;
      }
      a.tx = j.x; a.ty = j.y; a.state = 'run';
    }

    /* the one lineman who has climbed to the second level this snap */
    var climber = null;
    function blockThink(a, j) {
      var d = j.on && byId[j.on];
      if (!d || d.state === 'down') {
        /* a lineman with nobody to block looks for somebody who is loose,
           not merely for somebody who is near */
        a.state = 'block';
        var loose = null, ld = 5.0;
        actors.forEach(function (r) {
          if (r.side !== 'def' || r.lock || r.state === 'down') return;
          if (!r.job || (r.job.kind !== 'rush' && r.job.kind !== 'fill')) return;
          var g = dist(a, r);
          if (g < ld) { ld = g; loose = r; }
        });
        if (loose) { a.tx = loose.x; a.ty = loose.y - 0.3; a.job.on = loose.id; }
        else { a.tx = a.x; a.ty = play.type === 'pass' && qb ? qb.y + 1.6 : a.y + 0.8; }
        return;
      }
      /* ── SOMEBODY HAS TO BLOCK THE LINEBACKER ─────────────────────────
         Five linemen against four down men means one of them is standing
         over a pile with nothing to do while the man who actually makes the
         tackle waits four yards behind it. Nobody ever climbed: a lineman
         only went looking for work if his own man was on the floor, which
         never happens, so the second level was unblocked on every snap of
         the game. That is why a back who beat the line still had three
         linebackers waiting and 2,700 carries produced no run over ten
         yards. A man whose block is already being made by somebody else
         goes and finds the next one. */
      if (play.type === 'run' && !a.lock && d.lock && d.lock !== a.id
          && (!climber || climber === a.id)) {
        var up = null, ud = 8.0;
        actors.forEach(function (r) {
          if (r.side !== 'def' || r.lock || r.state === 'down') return;
          if (r.y < los - 0.5) return;                    /* behind the line is not the second level */
          var g = Math.hypot(r.x - a.x, r.y - a.y);
          if (g < ud) { ud = g; up = r; }
        });
        /* ONE OF THEM GOES, NOT ALL OF THEM. Five linemen against four down
           men leaves exactly one spare, and letting every blocker whose man
           was covered release to the second level put a hat on every
           linebacker in the building — worth nearly two yards a carry on its
           own, and it turned the middle of a defence into an empty room. */
        if (up) { climber = a.id; a.job.on = up.id; a.climb = up.id; d = up; }
      }
      var qx = qb ? qb.x : ballX, qy = qb ? qb.y : los - 4;
      if (play.type === 'run') {
        /* a draw sells the pass first: he sets, and the rush comes to him */
        if (j.setFirst && t < j.setFirst) {
          a.tx = a.hx; a.ty = a.hy - 0.7; a.state = 'block'; return;
        }
        /* drive him off the ball and off the runner's track — and on a zone
           play, get to his play-side shoulder so the front flows the way the
           back is going and the cutback opens behind it */
        a.tx = clamp(d.x + (j.reach || 0), a.hx - 2.6, a.hx + 2.6);
        a.ty = d.y + 0.35;
      } else {
        var ux = qx - d.x, uy = qy - d.y, u = len(ux, uy) || 1;
        a.tx = clamp(d.x + ux / u * 0.75, a.hx - 3.2, a.hx + 3.2);
        a.ty = clamp(d.y + uy / u * 0.75, qy + 0.4, los + 2.6);
      }
      a.state = a.lock === d.id ? 'engaged' : 'block';
    }

    function rushThink(a, j) {
      if (carrier && carrier.side === 'off' && carrier.carry && carrier !== qb) {
        pursue(a, carrier); return;
      }
      if (a.lock) {
        /* held up: he works, he does not teleport */
        a.state = 'engaged';
        a.tx = a.x + (qb ? (qb.x - a.x) * 0.12 : 0);
        a.ty = a.y - 0.06;
        return;
      }
      var tgt = carrier || qb;
      if (!tgt) { a.tx = a.x; a.ty = a.y; return; }
      pursue(a, tgt);
      a.state = 'run';
    }

    /* PURSUIT IS AN ANGLE, NOT A HOMING MISSILE. He runs at where the ball
       will be given how fast he can get there — which is why a fast back
       outruns it and a slow one does not. */
    function pursue(a, tgt) {
      var dx = tgt.x - a.x, dy = tgt.y - a.y;
      var gap = len(dx, dy);
      /* ── THE DEEPER HE IS, THE FURTHER AHEAD HE AIMS ──────────────────
         A yard and a fifth of lead is right for a linebacker filling a hole
         and hopeless for the last man in the picture: a safety fifteen yards
         off needs to run at a spot ten yards downfield of the back, not at
         the back. Capped where it was, he took a flat angle, got beaten
         across his own face, and every run that cleared the second level
         went to the house — the long runs in this game averaged fifty yards
         because nobody was ever in front of the ball again. */
      var lead = clamp(gap / Math.max(3, a.top), 0, 3.2) * (0.35 + a.k.iq * 0.75);
      /* ── HE TAKES THE ANGLE HE READS, NOT THE ONE THAT IS THERE ────────
         Every defender was solving the intercept exactly, every frame, for
         the whole snap. Eleven men who never take a false step are not a
         defence, they are a net, and no back gets outside a net. This is one
         wrong step, held long enough to matter and re-taken twice a second,
         and how wrong it is comes off his instincts. A great back beating a
         slow linebacker to the edge is this number. */
      if (a.missAt == null || t > a.missAt) {
        a.missAt = t + 0.45;
        a.miss = (rand() - 0.5) * 2 * (1 - a.k.iq * 0.72) * 0.85 * dull;
      }
      /* AND IT ONLY COSTS HIM UP CLOSE. A false step at the point of attack
         is the play; the same step with fifteen yards to work in is one he
         corrects on the run. Left flat, this turned every defence into
         scenery and outside zone averaged eighteen yards a carry. */
      var slip = (a.miss || 0) * clamp(4.0 / Math.max(2.4, gap), 0, 1);
      var px = tgt.x + tgt.vx * lead + slip, py = tgt.y + tgt.vy * lead;
      a.tx = clamp(px, -4, FIELD.width + 4); a.ty = py;
      /* HE LEAVES HIS FEET. A defender running alongside a ball carrier a
         yard and a half away for forty yards is not a defence — the tackle
         radius is 1.35 and nobody in pursuit was ever diving, so a receiver
         who broke contain was gone. A dive is worth another three quarters
         of a yard and costs him the play if he misses. */
      if (gap < 2.1 && a.dive <= 0 && (a.diveAt || 0) < t) {
        a.dive = 0.38; a.diveAt = t + 0.9;
      }
      a.state = a.dive > 0 ? 'tackle' : 'run';
    }

    function routeThink(a, j, dt) {
      var p = j.pts[Math.min(j.i, j.pts.length - 1)];
      a.tx = p[0]; a.ty = p[1];
      a.state = 'run';
      if (Math.hypot(a.x - p[0], a.y - p[1]) < 1.2 && j.i < j.pts.length - 1) j.i++;
      /* at the end of the stem he works back to the ball or keeps running */
      if (j.i >= j.pts.length - 1 && Math.hypot(a.x - p[0], a.y - p[1]) < 1.4) {
        var deep = (F.ROUTES[j.route] && F.ROUTES[j.route].band) === 'deep';
        if (deep) { a.ty = a.y + 6; a.tx = a.x + (a.x > ballX ? 0.4 : -0.4); }
        else if (qb && !thrown) { a.tx = a.x + (qb.x - a.x) * 0.20; a.ty = a.y - 0.4; }
      }
      if (ball.flight && ball.flight.to === a) { a.tx = ball.flight.tx; a.ty = ball.flight.ty; a.state = 'catch'; }
    }

    function dropThink(a, j) {
      var depth = play.concept === 'quick' ? 2.8 : play.concept === 'screen' ? 3.0 : 5.4;
      /* FROM THE GUN HE IS ALREADY BACK. Taking the drop as an absolute depth
         made a shotgun quarterback step FORWARD into the rush on every quick
         concept, which is how a mesh concept was being sacked at eleven
         hundred milliseconds. He never sets up shallower than he lined up. */
      var set = Math.min(a.hy, los - depth);
      var heat = pressureNear(a);
      /* he slides off the heat inside the pocket; he does not run from it */
      a.tx = clamp(a.x + heat.dx * 1.9, ballX - 7, ballX + 7);
      a.ty = clamp(set + heat.dy * 1.1, los - 9, set + 0.4);
      a.state = 'run';
      if (t > (play.hold || 2.4) * 0.55) a.state = 'throw';
      decide(a);
    }

    /* ── THE PROGRESSION ─────────────────────────────────────────────────
       The concept's own read order, resolved once: primary, second, and the
       man the play leaves free if neither is there. `self.targets` shows the
       user exactly this list, so the quarterback and the badges over the
       receivers are reading the same football. */
    var progCache = null, progDown = -1;
    function progression() {
      /* MOBILE. This is asked for on every tick of a hundred-and-twenty-hertz
         loop, and the answer only changes when somebody goes down — so it is
         built once and rebuilt when that count moves. Sorting five actors two
         hundred times a second is not free on a phone. */
      var down = 0, i;
      for (i = 0; i < actors.length; i++) {
        if (actors[i].side === 'off' && actors[i].state === 'down') down++;
      }
      if (progCache && down === progDown) return progCache;
      progDown = down;
      progCache = actors.filter(function (a) {
        return a.side === 'off' && a.job && a.job.kind === 'route' && a.state !== 'down';
      }).sort(function (a, b) {
        var ra = ORDER[a.slot] == null ? 90 : ORDER[a.slot];
        var rb = ORDER[b.slot] == null ? 90 : ORDER[b.slot];
        return ra - rb;
      });
      return progCache;
    }

    /* HOW CLOSE THE RUSH IS, in [0,1]. One is a free rusher with his hands on
       him; nought is a clean pocket. It is what turns a progression into a
       decision, and it is the only thing that should ever hurry a throw. */
    function heatOn(a) {
      var worst = 0;
      actors.forEach(function (d) {
        if (d.side !== 'def' || d.state === 'down' || d.lock) return;
        if (d.job && d.job.kind !== 'rush' && d.job.kind !== 'fill') return;
        var g = dist(a, d);
        if (g > 6) return;
        worst = Math.max(worst, clamp((6 - g) / 4.6, 0, 1));
      });
      return worst;
    }

    /* ── THE DECISION ─────────────────────────────────────────────────────
       Every tick the quarterback holds the ball, he asks one question: is
       anybody open enough YET? What "enough" means falls as the play ages
       and falls faster with a rusher in his face, which is the whole of
       quarterback play in one line — a clean pocket waits for the throw it
       wants, a dirty one takes the throw it can get.

         AWARENESS  how fast he gets through the progression, and how long
                    he will stand in it before he bails
         ACCURACY   nothing here; it is priced in the flight of the ball
         MOBILITY   whether bailing means running or throwing it away

       He is allowed three endings other than a throw: he runs, he throws it
       away, or he is caught. Only the third is a sack, which is why the sack
       is now an outcome of the football rather than the absence of one. */
    var nextLook = 0;
    function decide(a) {
      if (thrown || play.type !== 'pass' || !qb || qb.state === 'down') return;
      if (qb.job && qb.job.kind === 'scramble') return;
      /* HE LOOKS THIRTY TIMES A SECOND, not a hundred and twenty. A
         quarterback's eyes are not a physics step, and re-reading every
         receiver and every defender on every tick is the most expensive
         thing in this file on a phone. The pending bail-out still fires on
         its own clock. */
      if (t < nextLook && !bailKind) return;
      nextLook = t + 0.033;
      var hold = play.hold || 2.4;
      var iq = qb.k.iq, spd = qb.k.spd;
      var heat = heatOn(qb);
      var prog = progression();

      /* ── THE USER'S QUARTERBACK IS THE USER'S ─────────────────────────
         Every throw is the player's to make and he can hold it as long as he
         likes in a clean pocket. What he gets is the two things a real
         quarterback does when the pocket is not clean and he has not decided:
         he checks it down, and then he throws it away. Without them a player
         who has not yet learned to tap a receiver takes four sacks a half,
         which is not a lesson — it is a wall.

         Both are gated on somebody actually closing on him. Nothing here ever
         fires while he is protected, so a player waiting on a deep route
         never has the ball taken out of his hands. */
      if (!autoQB) {
        /* a clean pocket is his to stand in for as long as he likes */
        if (heat < 0.45 && t < 5.5) return;
        if (t > hold * 0.95 && heat > 0.45) {
          var dump = null, dv = -1, k;
          for (k = 0; k < prog.length; k++) {
            var m = prog[k];
            if (!m || m.state === 'down') continue;
            if (t < (m.job.t || 2.0) * 0.65) continue;
            var ov = openAhead(m, iq);
            if (ov > dv) { dv = ov; dump = m; }
          }
          if (dump && dv >= 0.22) { throwTo(dump.id); return; }
        }
        if ((heat > 0.60 && t > hold * 1.15) || t > 5.5) throwAway('nothing there');
        return;
      }

      /* HE HAS TO BE SET. Nobody throws from the second step of a five-step
         drop, and a quarterback who could was throwing before the rush had
         left the line — which is the whole reason the pass rush in this game
         was ornamental. */
      var setAt = play.concept === 'quick' || play.concept === 'screen'
        ? hold * 0.62 : hold * 0.80;
      if (t < setAt) return;

      /* ── HOW LONG HE HOLDS IT ─────────────────────────────────────────
         The single number that decides whether a pass rush exists. He was
         getting to the top of his drop at half the concept's hold time and
         firing at the first man with a yard on him — median time to throw
         one and eight tenths of a second, which no quarterback has ever
         managed and which meant the rush arrived, on time, at an empty
         pocket. He looks when the drop is finished and the route is there. */
      var scanFrom = hold * 0.86;
      var dwell = 0.52 - iq * 0.20;
      var seen = t < scanFrom ? 1
        : Math.min(prog.length, 1 + Math.floor((t - scanFrom) / dwell));

      /* what "open" has to mean right now. Roughly three yards on rhythm,
         less every tenth of a second after that, and much less with a man in
         his face — which is why a hurried throw is a worse throw rather than
         a rarer one. */
      var need = clamp(0.42 - Math.max(0, t - hold) * 0.34 - heat * 0.38, 0.03, 0.42);

      var best = null, bestV = -1, i, r, v;
      for (i = 0; i < seen; i++) {
        r = prog[i];
        if (!r || r.state === 'down') continue;
        /* a route that has not got there yet is not a throw, it is a guess */
        if (t < (r.job.t || 2.0) * 0.95) continue;
        /* WHERE HE WILL BE WHEN IT GETS THERE. Judging a window by where the
           receiver is standing right now is what a bad quarterback does; it
           is also what this file used to do, and it threw away every route
           that was about to come open. Anticipation is an awareness rating,
           so a limited passer sees less of the break than a good one. */
        v = openAhead(r, iq) + (i === 0 ? 0.05 : 0) - i * 0.02;
        /* THE DEEPER THE THROW, THE MORE ROOM HE NEEDS. Thirty-five yards in
           the air is a decision with a safety in it; a five-yard hitch is
           not. Without this the same window bought both, and one dropback in
           twelve was a bomb that scored. */
        v -= clamp((r.y - los - 12) * 0.011, 0, 0.18);
        if (v > bestV) { bestV = v; best = r; }
      }
      if (best && bestV >= need) { throwTo(best.id); return; }

      /* SOMEBODY HAS HIM. You cannot check it down and you cannot throw it
         away with a hand on your arm: from here the front has earned
         whatever happens, and what happens is a sack. */
      if (heat > 0.86) { bailKind = null; return; }

      /* A BAIL-OUT IS NOT INSTANT. Pulling it down, resetting the feet and
         putting it in the third row takes about a quarter of a second, and
         that quarter of a second is the whole race: without it a quarterback
         who could always see the rush coming was never once sacked, which is
         its own kind of broken. He commits, and then he has to survive long
         enough to finish. */
      if (bailKind) {
        if (t < bailAt) return;
        if (bailKind === 'run' && bailLane) {
          qb.job = { kind: 'scramble' };
          qb.carry = true; carrier = qb; ball.holder = qb;
          qb.dx = bailLane.dx; qb.dy = bailLane.dy;
          notes.push('Nothing open — he takes off.');
          refreshUser();
          if (events.onScramble) events.onScramble();
        } else {
          throwAway(bailKind === 'duress' ? 'under duress' : 'nobody open');
        }
        bailKind = null;
        return;
      }

      /* ── HE HAS TO DO SOMETHING ────────────────────────────────────────
         The pocket is going or gone. A mobile quarterback with grass in
         front of him takes it; anyone else looks for the checkdown and
         then for the sideline. */
      var desperate = heat > 0.78 || t > hold + 1.10 + iq * 0.60;
      if (!desperate) return;

      var react = 0.32 - iq * 0.14;

      /* RUN IT — and a quarterback who can run looks for this BEFORE he looks
         for the checkdown, because that is what makes him different from one
         who cannot. Mobility is the rating; the lane is the football. */
      var mobile = spd > 8.05;
      var lane = escapeLane();
      if (lane && (mobile || heat > 0.80) && t > hold * 0.72) {
        bailKind = 'run'; bailLane = lane; bailAt = t + react * 0.7;
        return;
      }

      /* the checkdown: the deepest man who is actually open, not the nearest */
      var check = null, cv = -1;
      for (i = 0; i < prog.length; i++) {
        r = prog[i];
        if (!r || r.state === 'down') continue;
        if (t < (r.job.t || 2.0) * 0.62) continue;
        v = openAhead(r, iq) + clamp(r.y - los, 0, 14) * 0.006;
        if (v > cv) { cv = v; check = r; }
      }
      if (check && cv >= clamp(0.26 - heat * 0.18, 0.06, 0.26)) { throwTo(check.id); return; }
      /* throw it away, which costs a down and nothing else */
      if (heat > 0.84 || t > hold + 2.1) {
        bailKind = heat > 0.84 ? 'duress' : 'nobody';
        bailAt = t + react;
      }
    }

    /* HOW OPEN HE WILL BE WHEN THE BALL ARRIVES. The receiver and the man on
       him are both walked forward by the time of flight; how much of that
       the quarterback actually sees is his awareness. */
    function openAhead(r, iq) {
      var d0 = dist(qb, r);
      var ahead = clamp(d0 / (17 + qb.k.arm * 12), 0.18, 1.4) * clamp(0.35 + iq * 0.9, 0.3, 1.15);
      var px = r.x + r.vx * ahead, py = r.y + r.vy * ahead;
      var near = 1e9;
      actors.forEach(function (d) {
        if (d.side !== 'def' || d.state === 'down') return;
        if (d.job && d.job.kind === 'rush') return;
        var dx = d.x + d.vx * ahead - px, dy = d.y + d.vy * ahead - py;
        var g = Math.hypot(dx, dy);
        if (g < near) near = g;
      });
      return clamp((near - 1.2) / 4.5, 0, 1);
    }

    /* WHERE HE COULD RUN, if anywhere: the widest gap in the front with room
       in front of it. Returns null when he is surrounded, which is the
       honest answer often enough to keep the sack real. */
    function escapeLane() {
      var best = null, bs = 2.3, i;
      for (i = -4; i <= 4; i++) {
        var ang = i * 0.35;
        var dx = Math.sin(ang), dy = Math.cos(ang);
        var px = clamp(qb.x + dx * 5, 1, FIELD.width - 1), py = qb.y + dy * 5;
        var room = 1e9;
        actors.forEach(function (d) {
          if (d.side !== 'def' || d.state === 'down') return;
          room = Math.min(room, Math.hypot(d.x - px, d.y - py));
        });
        var sc = room + dy * 1.1;
        if (sc > bs) { bs = sc; best = { dx: dx, dy: dy }; }
      }
      return best;
    }

    /* HE PUT IT IN THE THIRD ROW. An attempt, an incompletion, a down gone,
       and seven yards he did not lose — which is exactly the trade a real
       quarterback makes and the reason a sack should be rare. */
    function throwAway(why) {
      if (thrown || outcome) return;
      thrown = true; threwAway = true; thrownAt = t;
      qb.state = 'throw'; qb.carry = false;
      ball.holder = null; carrier = null;
      airYards = 0;
      notes.push('Threw it away — ' + why + '.');
      if (events.onThrow) events.onThrow(null);
      refreshUser();
      finish('incomplete', null, null);
    }

    /* ── THE SECONDARY DOES NOT TACKLE THE HANDOFF ────────────────────
       Every coverage defender used to break for the ball carrier on the
       frame the ball reached his belly, from wherever he stood — so a corner
       ten yards wide arrived at the line with the back and the first tackler
       on seven carries in ten was a cornerback, at two yards. That is not a
       defence, it is a net, and it is why the run game starved. A defender
       in coverage plays his man or his zone until the run DECLARES: the ball
       across the line, or a beat of reading it — a safety's beat is short, a
       corner's is long, and a sharper defence reads it sooner. */
    function runDeclared(a) {
      var c = carrier;
      if (!c || !c.carry || c === qb || c.side !== 'off') return false;
      /* a safety keys the back and sees the handoff; a corner is watching a
         receiver and sees it last */
      if (c.y > los + (a.pos === 'S' ? -0.5 : 0.5)) return true;
      var beat = a.pos === 'CB' ? 0.85 : a.pos === 'S' ? 0.30 : 0.45;
      return t > handoffAt + beat * dull;
    }
    function manThink(a, j) {
      var m = byId[j.on];
      if (!m) { a.tx = a.x; a.ty = a.y + 4; a.state = 'run'; return; }
      if (carrier && carrier.carry && (carrier.side === 'def' || runDeclared(a))) { pursue(a, carrier); return; }
      /* HOW TIGHT HE TRAILS IS HIS COVERAGE RATING against how well the man
         in front of him runs routes — which is exactly the number the engine
         already computed for this matchup. A good corner sits on the hip; a
         bad one gives the route its stem back.

         IT USED TO BE A HALF-YARD, WHICH IS NOT COVERAGE — it is a piggyback.
         Nothing downfield could be completed because the defender was always
         nearer the ball than the receiver, so a live passing game went 40 per
         cent for four yards a completion and every intermediate route was
         "broken up". Real man coverage concedes a couple of yards; taking
         them away is what a great corner is for. */
      /* AND THE MAN HE IS COVERING IS A MAN, not a unit average: a route
         technician buys himself another step of cushion, a straight-line
         runner does not. This is the one place a receiver's own route rating
         acts on the field. */
      var trail = 0.80 + env.separation * 0.72 - a.k.cov * 1.10 + ((m.k && m.k.rte) != null ? (m.k.rte - 0.5) * 0.9 : 0)
                + (dull - 1) * 0.6;
      var lead = (0.16 + a.k.cov * 0.20) * sharp;
      a.tx = m.x + m.vx * lead;
      a.ty = m.y + m.vy * lead + clamp(trail, 0.45, 3.4);
      a.state = 'run';
      if (ball.flight) breakOnBall(a);
    }

    function zoneThink(a, j) {
      if (carrier && carrier.carry && (carrier.side === 'def' || runDeclared(a))) { pursue(a, carrier); return; }
      if (ball.flight) { breakOnBall(a); return; }

      /* ── NOBODY GETS BEHIND HIM ────────────────────────────────────────
         The first rule of playing over the top, and this file did not have
         it. A deep defender sat on a landmark seventeen yards downfield and
         only "squeezed" a receiver who came within seven and a half yards of
         it, so any route that ran past that landmark was simply uncovered
         from there to the end zone — which is why a corner route out of a
         single-back set was caught with the nearest defender twelve yards
         away and walked in. He turns and carries the deepest man in his zone,
         every time, and the throw over the top becomes a throw he has to be
         beaten on rather than one nobody is defending. */
      var deep = j.y - los > 9;
      var width = deep ? (j.width || 13) : (j.width || 8);
      var deepest = null, dy = -1e9, near = null, nd = 1e9, i;
      actors.forEach(function (r) {
        if (r.side !== 'off' || !r.job || r.job.kind !== 'route' || r.state === 'down') return;
        var lat = Math.abs(r.x - j.x);
        var d = Math.hypot(r.x - j.x, r.y - j.y);
        if (d < nd) { nd = d; near = r; }
        if (lat <= width && r.y > dy) { dy = r.y; deepest = r; }
      });
      /* a rookie safety turns and runs a beat late; a legend one early */
      if (deep && deepest && deepest.y > j.y - 4.0 * (2 - dull)) {
        /* he opens his hips and runs, keeping his cushion */
        a.tx = deepest.x * 0.55 + j.x * 0.45;
        a.ty = Math.max(deepest.y + 1.5, j.y);
        a.state = 'run';
        return;
      }
      /* otherwise he sits on his landmark and squeezes whoever comes into it —
         AND HOW WELL IS HIS COVERAGE RATING. Zone used to read nothing from
         the card: a 42 corner and a 96 corner squeezed the same route the
         same way, and the only thing a great cover man changed was how he
         broke on a ball already thrown. A great zone corner sees the route a
         step sooner, matches it tighter, and gives up less of the cushion;
         a poor one is late to it and leaves the window open. */
      var cv = a.k.cov;
      if (near && nd < (deep ? 9.5 : 7.5) * sharp * (0.85 + cv * 0.30)) {
        a.tx = near.x * (0.45 + cv * 0.30) + j.x * (0.55 - cv * 0.30);
        a.ty = Math.max(j.y - 1.5, near.y + 0.35 + (1 - cv) * 1.1);
      } else { a.tx = j.x; a.ty = j.y; }
      a.state = 'run';
    }

    function breakOnBall(a) {
      var f = ball.flight;
      if (!f) return;
      /* HE HAS TO SEE IT FIRST, AND SEEING IT TAKES A BEAT. Breaking on the
         throw the frame it leaves the hand — from anywhere on the field —
         made every defender a free safety and every throw contested. The
         beat is his ball skills, and the distance he will even try from is
         his ball skills too. */
      if (f.t < (0.34 - a.k.bhk * 0.20) * (0.5 + 0.5 * dull)) return;
      var d = Math.hypot(a.x - f.tx, a.y - f.ty);
      /* the distance he will even try from: his ball skills, and a little of
         how well he was covering to begin with */
      if (d > 4.5 + a.k.bhk * 5 + a.k.cov * 2) return;
      /* and he only leaves his man for a ball he can actually get to */
      var canGet = (f.dur - f.t) * a.top + 1.2;
      if (d > canGet) return;
      a.tx = f.tx; a.ty = f.ty; a.state = 'run';
    }

    function pressureNear(a) {
      var dx = 0, dy = 0;
      actors.forEach(function (d) {
        if (d.side !== 'def' || d.lock || d.state === 'down') return;
        var g = dist(a, d);
        if (g > 5) return;
        var w = (5 - g) / 5;
        dx -= (d.x - a.x) / Math.max(0.4, g) * w;
        dy -= (d.y - a.y) / Math.max(0.4, g) * w;
      });
      return { dx: clamp(dx, -1, 1), dy: clamp(dy, -1, 1) };
    }

    /* ── MOVEMENT ─────────────────────────────────────────────────────────
       Accelerate toward the target, cap at top speed, bleed the rest. Nobody
       teleports and nobody turns on a dime; a heavy man carries his mistake
       another yard. */
    function integrate(dt) {
      actors.forEach(function (a) {
        if (a.state === 'down') { a.vx *= 0.80; a.vy *= 0.80; return; }
        var dx = a.tx - a.x, dy = a.ty - a.y, d = len(dx, dy);
        var slow = a.lock ? 0.20 : a.stun > 0 ? 0.30 : a.move === 'truck' ? 0.80 : 1;
        if (d > 0.02) {
          var ux = dx / d, uy = dy / d;
          var ax = ux * a.accel * slow, ay = uy * a.accel * slow;
          a.vx += ax * dt; a.vy += ay * dt;
        }
        /* ── IN YOUR HANDS HE PLANTS AND CUTS ─────────────────────────────
           Turning was momentum and nothing else: to go left while running
           right he had to accelerate through his own velocity, which at a
           back's numbers is most of a second. On a phone that is an age, and
           it is the whole of "it is almost impossible to control the guy" —
           you point, and three-quarters of a second later he begins to agree
           with you. A man changing direction plants a foot and throws the old
           direction away. It costs him speed, because that is what a cut
           costs, and it happens when you ask rather than eventually. */
        if (a === user && a.steered && a.drive > 0.08) {
          var usp = len(a.vx, a.vy);
          if (usp > 1.2) {
            var dot = (a.vx * a.dx + a.vy * a.dy) / usp;
            if (dot < 0.86) {
              var k = clamp((0.86 - dot) * (0.55 + a.k.agi * 0.75) * 4.4 * dt, 0, 0.55);
              a.vx -= a.vx * k; a.vy -= a.vy * k;
            }
          }
        }
        var sp = len(a.vx, a.vy), top = a.top * slow;
        /* ── AND HOW HARD YOU PUSH IS HOW HARD HE RUNS ────────────────────
           The stick's magnitude was measured, stored and then thrown away —
           every touch, however light, was a sprint. Easing off is how you
           set a cut up and how you pick a hole at a speed you can still
           change your mind at; the rim of the ring is the whole horse. */
        if (a === user && a.steered && a.drive > 0.08) top *= 0.64 + a.drive * 0.36;
        /* the sprint button: a step faster while there is wind for it */
        if (a.sprint && a.gas > 0.05) top *= 1.07 + a.k.sta * 0.04;
        /* a spin turns him: he keeps going, slower, and cannot cut through it */
        if (a.spinT > 0) top *= 0.80;
        if (sp > top && sp > 0) { a.vx = a.vx / sp * top; a.vy = a.vy / sp * top; }
        a.vx -= a.vx * 1.8 * dt; a.vy -= a.vy * 1.8 * dt;
        a.x = clamp(a.x + a.vx * dt, -3, FIELD.width + 3);
        a.y += a.vy * dt;
        /* WHICH WAY HE IS LOOKING is the way he is going, and it must not
           flicker: a receiver running a slight angle downfield is still
           running downfield, and a man whose shoulders flip side to side
           twice a second reads as a sprite, not as an athlete. */
        if (sp > 0.6) a.face = a.vx > 2.4 ? 'right' : a.vx < -2.4 ? 'left'
          : (a.vy > 0) === (a.side === 'off') ? 'back' : 'front';
        /* LEAN IS MOMENTUM, and momentum is the CHANGE in speed rather than
           the speed. A back planting his foot to cut leans into the cut
           hardest at the moment he is slowest through it, which is exactly
           what the difference between this tick and the last one measures.
           Nothing reads it but the artist. */
        var latA = (a.vx - (a.pvx == null ? a.vx : a.pvx)) / Math.max(dt, 0.001);
        a.pvx = a.vx;
        a.lean = clamp(a.lean * 0.80 + (clamp(latA * 0.014, -0.5, 0.5) + a.vx * 0.028) * 0.20,
          -0.45, 0.45);
      });
    }

    /* men are not points: they take up room */
    function separate() {
      var i, j, a, b, dx, dy, d, push;
      for (i = 0; i < actors.length; i++) {
        a = actors[i];
        if (a.state === 'down') continue;
        for (j = i + 1; j < actors.length; j++) {
          b = actors[j];
          if (b.state === 'down') continue;
          /* THE MAN WITH THE BALL IS NOT PUSHED OFF. Everybody else keeps his
             yard of room, but a tackler closing on the carrier must be allowed
             all the way in — this pass used to hold pursuit at 1.20 yards
             while the tackle radius was 1.15, so defenders jogged alongside
             ball carriers for eighty yards and never touched one. */
          if (carrier && (a === carrier || b === carrier) && a.side !== b.side) continue;
          dx = b.x - a.x; dy = b.y - a.y;
          d = len(dx, dy);
          /* ── HE RUNS OFF HIS OWN MAN'S HIP ────────────────────────────
             Everybody keeps a yard and a fifth of room, which is a wide
             berth for two men brushing past each other and an impossible
             one inside a run. The linemen line up a yard and a half apart,
             so an A gap held open at 1.20 from BOTH sides is narrower than
             the back trying to get through it — which is most of why the
             interior run game averaged a yard and three quarters and never
             once broke. Between a carrier and his own blockers it is a
             shoulder, not a corridor. */
          var room = (carrier && (a === carrier || b === carrier) && a.side === b.side) ? 0.88 : 1.20;
          if (d > room || d < 0.0001) continue;
          push = (room - d) / 2;
          dx /= d; dy /= d;
          var wa = a.lock ? 0.35 : 1, wb = b.lock ? 0.35 : 1;
          a.x -= dx * push * wa; a.y -= dy * push * wa;
          b.x += dx * push * wb; b.y += dy * push * wb;
        }
      }
    }

    /* ── BLOCKING ─────────────────────────────────────────────────────────
       A rep, not a wall. They latch, and every frame the blocker's hold is
       worn down by the rusher's hands. When it runs out he is free — and a
       free rusher is what actually creates pressure, not a dice roll. */
    function blocks(dt) {
      actors.forEach(function (b) {
        if (b.side !== 'off' || !b.job) return;
        var kind = b.job.kind;
        if (kind !== 'block' && kind !== 'lead' && kind !== 'stalk' && kind !== 'protect' && kind !== 'pull') return;
        var d = b.job.on && byId[b.job.on];
        /* ── THE MEN WHO WERE ONLY PRETENDING TO BLOCK ────────────────────
           A fullback leading through the hole, a receiver stalking a corner
           and a back kept in to protect all ran to the right place and then
           stood next to their man without ever touching him: only a job of
           kind `block` was ever considered here, so nobody they were sent
           to block was ever engaged, and `contact` — which spares an engaged
           defender — saw them all as free. That is most of why the live run
           game averaged two and a half yards a carry: the linebacker the
           fullback was sent to kick out made the tackle every single time. */
        if ((!d || d.state === 'down') && kind !== 'block') {
          var near = null, nd = ENGAGE + 0.45;
          actors.forEach(function (r) {
            if (r.side !== 'def' || r.lock || r.state === 'down') return;
            var g = dist(b, r);
            if (g < nd) { nd = g; near = r; }
          });
          if (near) { d = near; b.job.on = near.id; }
        }
        if (!d || d.state === 'down') { release(b); return; }
        if (!b.lock) {
          /* ── ONCE HE IS BEATEN, HE IS BEATEN ──────────────────────────
             A blocker whose rep ran out simply latched onto the same rusher
             again the next frame and got a brand new full-length rep for it,
             over and over, for the whole snap. That is why a pocket in this
             game never actually broke: a quarterback could stand in it for
             eight seconds and the pass rush was decorative. A lineman can
             recover once, badly, and after that the man is past him. */
          if ((d.beat || 0) >= 2) return;
          if (dist(b, d) <= ENGAGE && !d.lock) {
            b.lock = d.id; d.lock = b.id;
            /* HOW LONG THIS ONE MAN CAN HOLD THIS ONE MAN, in seconds.
               A run block is a displacement — a second and a half of movement
               and then the defender is off it, which is why a run play that
               does not hit the crease quickly is a run play that goes for two.
               Pass protection is a wall, and it holds until it does not.
               Five reps race, so each is scaled around the pocket rather than
               under it: otherwise the shortest of five draws decides every
               snap and the quarterback is on the floor half the time. */
            var edge = b.k.blk * 1.15 - d.k.shed * 0.60 - d.k.rsh * 0.45;
            var runEdge = b.k.rbk * 1.10 - d.k.shed * 0.60 - d.k.rsh * 0.35;
            /* FIVE REPS RACE AND THE SHORTEST ONE DECIDES THE SNAP, so each is
               drawn ABOVE the pocket, not around it: draw them around it and
               the minimum of five lands at about half, and the quarterback is
               on his back on a three-step drop. */
            /* A RUN BLOCK HAS TO OUTLAST THE HANDOFF. The ball is not in the
               back's belly until six-tenths of a second after the snap and he
               does not reach the crease for another half-second after that —
               so a block drawn at three-quarters of a second was already over
               when it mattered, and every carry met a shed lineman at the
               line. Hold the point for about two seconds and the crease is a
               real thing that blocking ratings open and widen. */
            b.rep = play.type === 'run'
              ? clamp((1.55 + rand() * 1.15) * (0.85 + runEdge * 1.2), 0.7, 3.6)
              : clamp(env.pocket * (0.86 + rand() * 0.70) * (0.85 + edge * 1.0), 0.45, 5.6);
            /* ── BUT BLOCKING A LINEBACKER IN SPACE IS NOT BLOCKING A
                  TACKLE ON THE BALL ────────────────────────────────────
               A lineman who climbs is giving up thirty pounds of leverage to
               a man with a running start and room to pick a side. He gets in
               the way and he buys the back a beat; he does not erase him. At
               a full-length rep the climb alone was worth nearly two yards a
               carry and the second level simply stopped existing. */
            if (b.climb === d.id) b.rep *= 0.44;
            if (d.beat) b.rep *= 0.32;
            d.rep = b.rep;
          }
          return;
        }
        b.rep -= dt;
        b.heldFor = (b.heldFor || 0) + dt;
        d.heldBy = b.id;
        d.engaged = b.id; b.engaged = d.id;
        /* ── THE BULL RUSH, AND WHICH WAY IT GOES ────────────────────────
           A defender who is winning the rep drives the man in front of him
           BACKWARDS — into the backfield, into the quarterback's lap. This
           moved the pair the other way: a winning rusher retreated downfield
           and the pocket got deeper the better the front was. It is why a
           defensive line seven yards from a shotgun quarterback stayed seven
           yards from him for the entire snap and a live game produced two
           sacks a hundred dropbacks. Positive `give` is the rusher winning,
           and the offence gives ground. */
        var give = clamp((d.k.rsh + d.k.shed) * 0.5
                         - (play.type === 'run' ? b.k.rbk : b.k.blk), -0.5, 0.6);
        b.y -= give * 1.5 * dt; d.y -= give * 1.5 * dt;
        if (b.rep <= 0) {
          var beatenBlocker = b;
          release(b);
          /* he beat the block, and he comes off it going somewhere */
          d.stun = 0.10;
          d.beat = (d.beat || 0) + 1;
          d.beatWho = beatenBlocker.id;
          if (qb && play.type === 'pass') {
            var ex = qb.x - d.x, ey = qb.y - d.y, el = len(ex, ey) || 1;
            d.vx += ex / el * 2.2; d.vy += ey / el * 2.2;
          }
          if (!pressureSeen && play.type === 'pass') { pressureSeen = true; notes.push('The pocket broke down.'); }
        }
      });
      function release(b) {
        var d = b.lock && byId[b.lock];
        if (d) { d.lock = null; d.engaged = null; }
        b.lock = null; b.engaged = null;
      }
    }

    /* ── CONTACT ──────────────────────────────────────────────────────────
       A tackle is a chance, taken once per man per approach, decided by the
       angle he arrives at, how fast, what he is worth, what the runner is
       worth, and what the user did about it half a second ago. */
    function contact(dt) {
      if (!carrier || phase !== 'live') return;
      if (carrier.side === 'def') { /* the ball has changed hands: offence chases */ }
      var c = carrier;
      if (c.grace > 0) return;
      actors.forEach(function (d) {
        if (d.side === c.side || d.state === 'down') return;
        /* ── A BLOCKED MAN IS NOT AN ABSENT MAN, BUT HE IS NEARLY ONE ─────
           An engaged defender could make no tackle at all, at any range, so
           getting a hand on a linebacker deleted him — which is why sending
           linemen to the second level was worth nearly two yards a carry. He
           can still get an arm out at a back running INTO him. Only into him:
           his reach is an arm and not a tackle, and it is mostly air. */
        var g = dist(d, c);
        var reach = d.lock ? 0 : TACKLE + (d.dive > 0 ? 0.75 : 0);
        if (g > reach) return;
        /* HE GETS ANOTHER GO. Bodies stay within a yard of each other for a
           long time in football; a man who misses once and then jogs alongside
           for the rest of the run is not a defence, he is scenery. */
        if (d.tryAt > t) return;
        d.tryAt = t + (d.lock ? 1.05 : 0.55);
        resolveTackle(d, c);
      });
    }

    function resolveTackle(d, c) {
      /* how square he is to the runner: a man arriving from the side has far
         less of him to hit than one who filled the hole in front */
      var vx = c.vx, vy = c.vy, sp = len(vx, vy);
      var ax = d.x - c.x, ay = d.y - c.y, ad = len(ax, ay) || 1;
      var square = sp > 0.5 ? clamp((vx * ax + vy * ay) / (sp * ad), -1, 1) : 0.6;
      var closing = len(d.vx - c.vx, d.vy - c.vy);

      /* ── A TACKLE IS AN ANGLE BEFORE IT IS A RATING ────────────────────
         A linebacker who filled the hole and met him square brings him down.
         The same man chasing from behind and reaching gets a hand on a jersey
         and a fistful of air, and a back at full speed running through a
         defender who is standing still runs through him.

         This used to be a flat 0.86 with the angle worth a tenth either way,
         which made every contact a tackle: 2,700 carries produced NOT ONE run
         of ten yards, at every aiming point on the field, whether a person was
         steering or not. A run game with no ceiling is not a run game, and
         there is nothing for a thumb to be good at.

         So the angle carries it. Square in the hole is still most of the way
         to certain; a chase from behind is a real chance he is gone. */
      /* either side can be the tackler now, so read whichever numbers the man
         has: an offensive player chasing a pick tackles off his strength */
      var dTkl = d.k.tkl != null ? d.k.tkl : (d.k.str == null ? 0.5 : d.k.str) * 0.7;
      var cPwr = c.k.pwr != null ? c.k.pwr : (c.k.str == null ? 0.5 : c.k.str);
      var p = 0.868 + square * 0.07
            + (dTkl - (cPwr * 0.50 + c.k.agi * 0.50)) * 0.42
            - clamp(sp - closing, -3, 3) * 0.030
            + (env.runFit || 0) * 0.3;
      if (d.dive > 0) p += 0.06;
      if (d.stun > 0) p -= 0.30;
      /* reaching past the man who is holding you */
      if (d.lock) p -= 0.66;
      /* THE USER'S MOVE. This is the whole reason the buttons exist. The edge
         is set when the move is made and already carries the spam penalty. */
      if (c.move && c.moveEdge) p -= c.moveEdge;
      /* a defender who left his feet and is still in the air reaches further
         but wraps worse; one on the ground from a miss is not tackling */
      if (d.stun > 0 && d.diveMiss === 0) p -= 0.10;
      /* gang tackling: the second man arrives to a runner already slowed */
      var help = 0;
      actors.forEach(function (o) {
        if (o === d || o.side !== d.side || o.state === 'down') return;
        if (dist(o, c) < 2.4) help++;
      });
      p += Math.min(0.10, help * 0.05);

      /* AND NOTHING IS A CERTAINTY. At 0.97 the first man to arrive ended the
         play on ninety-six carries in a hundred, which made the whole run
         game one coin flip at the line: lose it and you have two yards, win
         it and nobody was ever within fifteen yards of you again. */
      if (rand() < clamp(p, 0.06, 0.93)) {
        /* HOW HARD IT LANDED, for the lens and the thumb: closing speed and
           how square he was. Nothing that decides a yard reads it. */
        lastHit = { x: Math.round(c.x * 100) / 100, y: Math.round(c.y * 100) / 100,
                    force: clamp((closing / 16) * (0.35 + Math.max(0, square) * 0.65), 0, 1),
                    square: Math.round(square * 100) / 100, help: help, by: d.player || null };
        /* ── THE BALL CAN COME OUT ────────────────────────────────────────
           Once per tackle, and rarely: the weather, the hit, how many hands
           are on him and how well he holds it. The resolver's rate is about
           one carry in ninety; the live game lands there too. A fumble the
           offence falls on is a tackle with a story; one the defence falls
           on is theirs, where it lies. */
        var pFum = clamp(0.0105 + (env.fumble || 0) + help * 0.004 + (closing > 7 ? 0.004 : 0)
                         - (c.k.hnd - 0.5) * 0.010 + (c.move === 'stiff' ? 0.004 : 0), 0.001, 0.05);
        if (c.side === 'off' && rand() < pFum) {
          if (events.onFumble) events.onFumble(c, d);
          if (rand() < 0.48) {
            notes.push(shortName(d) + ' knocked it loose and the defence has it.');
            c.state = 'down'; c.fell = 1; d.state = 'tackle';
            var ffs = d; ffs.ff = (ffs.ff || 0) + 1;
            fumbledBy = c; fumbleForced = d;
            finish('fumble', c, d);
            return;
          }
          notes.push('The ball came out, and ' + shortName(c) + ' fell on it.');
          fumbleKept = true;
        }
        down(c, d);
        return;
      }
      /* broken. He is slowed, the defender is on the floor for a beat. */
      c.vx *= 0.72; c.vy *= 0.72;
      d.stun = 0.55 + rand() * 0.35;
      d.vx *= 0.2; d.vy *= 0.2;
      if (!c.broke) { c.broke = 0; }
      c.broke++;
      if (c.broke === 1) notes.push(shortName(c) + ' broke the first one.');
      if (events.onBreak) events.onBreak(c, d);
    }

    var fumbledBy = null, fumbleForced = null, fumbleKept = false, lastHit = null;
    function down(c, d) {
      c.state = 'down'; c.fell = rand() > 0.5 ? 1 : -1;
      if (d) d.state = 'tackle';
      /* a defender brought down with the ball ends the takeaway where he is */
      if (c.side === 'def') { finish(interceptor ? 'interception' : 'fumble', c, d); return; }
      finish(c === qb && !thrown && play.type === 'pass' && c.y < los ? 'sack' : 'tackle', c, d);
    }

    /* ── THE THROW ────────────────────────────────────────────────────────
       When and where is the user's. Whether it arrives is the football's. */
    /* ── THREE FOOTBALLS ─────────────────────────────────────────────────
       A tap is a throw. A tap HELD is a bullet: it leaves harder and lower,
       gets there sooner, and gives the man in coverage less of a look — and
       past twenty yards it is the harder ball to place, because a line
       drive has no arc to drop into a window. A touch pass is the other
       trade: slower, higher, a ball a receiver can run under and a defender
       can run to. No fourth kind: nobody should need a manual for a throw. */
    var THROWS = {
      normal: { speed: 1.00, arc: 1.00, short: 0,     deep: 0,     catchAdj: 0,     hang: 0 },
      bullet: { speed: 1.32, arc: 0.55, short: -0.22, deep: 0.45,  catchAdj: -0.05, hang: -0.08 },
      touch:  { speed: 0.78, arc: 1.50, short: 0.25,  deep: -0.30, catchAdj: 0.02,  hang: 0.06 }
    };
    var lastThrow = null;
    function throwTo(idx, kind) {
      if (thrown || play.type !== 'pass' || !qb || qb.state === 'down') return false;
      var list = self.targets();
      var tg = null;
      if (typeof idx === 'string') { tg = byId[idx]; }
      else { var e = list[idx | 0]; tg = e && byId[e.id]; }
      if (!tg) return false;
      var tk = THROWS[kind] || THROWS.normal;
      kind = THROWS[kind] ? kind : 'normal';

      thrown = true; thrownAt = t;
      qb.state = 'throw'; qb.hold = 0.3;
      qb.carry = false;
      ball.holder = null;
      carrier = null;

      /* where he leads him: far enough ahead that a well-thrown ball meets a
         running man, wrong by however much the throw was worth */
      var d0 = dist(qb, tg);
      var speed = (17 + qb.k.arm * 12) * tk.speed;
      var flight = clamp(d0 / speed, 0.22, 1.5);
      /* THROWING HIM OPEN. A quarterback does not aim at where a receiver is;
         he aims at where the route puts him when the ball gets there. How
         much of that he actually sees is what football calls anticipation and
         this file calls iq — a smart passer leads the break, a limited one
         throws at the man's back and watches him run out from under it. */
      var vel = { x: tg.x + tg.vx * flight, y: tg.y + tg.vy * flight };
      var route = predictRoute(tg, flight);
      var see = clamp(0.30 + qb.k.iq * 0.75, 0, 1);
      var lx = vel.x + (route.x - vel.x) * see;
      var ly = vel.y + (route.y - vel.y) * see;

      /* THROW QUALITY. Accuracy, how far, whether he was hit, whether he was
         moving, and how late in the route it left his hand. */
      var heat = pressureNear(qb);
      var hurried = len(heat.dx, heat.dy);
      var moving = len(qb.vx, qb.vy) / Math.max(1, qb.top);
      var early = tg.job && tg.job.t ? clamp((tg.job.t - t) / Math.max(0.6, tg.job.t), 0, 1) : 0;
      /* ── HIS FEET, AND WHICH WAY HE IS GOING ──────────────────────────
         A quarterback who has stopped and set his feet is the accurate
         version of himself. One rolling AWAY from the side he throws to is
         throwing across his body, and every coach on earth will tell you
         what that costs; rolling toward the throw costs nothing extra. */
      var throwSide = (lx - qb.x) > 0 ? 1 : (lx - qb.x) < 0 ? -1 : 0;
      var across = throwSide !== 0 && qb.vx * throwSide < -1.6 ? clamp((-qb.vx * throwSide - 1.6) / 4, 0, 1) : 0;
      var set = moving < 0.12 ? 1 : 0;
      var err = (1 - qb.k.accy) * 1.5
              + hurried * 1.05
              + moving * 0.9
              + across * 0.60
              - set * 0.12
              + clamp(d0 - 10, 0, 34) * 0.072
              + early * 1.6
              + (d0 > 20 ? tk.deep : tk.short)
              - (d0 > 18 ? (env.deepAcc || 0) : (env.shortAcc || 0)) * 4;
      err = clamp(err, 0.15, 5.5);
      var ang = rand() * Math.PI * 2, mag = err * (0.35 + rand() * 0.85);
      lx += Math.cos(ang) * mag; ly += Math.sin(ang) * mag;
      lx = clamp(lx, -2, FIELD.width + 2);

      ball.flight = {
        fx: ball.x, fy: ball.y, tx: lx, ty: ly, t: 0,
        dur: clamp(Math.hypot(lx - ball.x, ly - ball.y) / speed, 0.20, 1.6 / tk.speed),
        to: tg, airYards: Math.round(ly - los), err: err, early: early,
        kind: kind, arc: tk.arc, catchAdj: tk.catchAdj, hang: tk.hang
      };
      lastThrow = { kind: kind, err: Math.round(err * 1000) / 1000, dur: Math.round(ball.flight.dur * 1000) / 1000,
                    distance: Math.round(d0 * 10) / 10, across: Math.round(across * 100) / 100, set: !!set,
                    moving: Math.round(moving * 100) / 100, hurried: Math.round(hurried * 100) / 100 };
      if (hurried > 0.55) { pressureSeen = true; }
      if (events.onThrow) events.onThrow(tg, kind);
      refreshUser();
      return true;
    }
    self.throwTo = throwTo;
    self.thrown = function () { return thrown; };
    /* what the last throw was, for the result card and for the tests that
       hold the three footballs apart */
    self.lastThrow = function () { return lastThrow; };
    self.THROWS = THROWS;

    /* where his route has him in `ahead` seconds, walked along the waypoints */
    function predictRoute(a, ahead) {
      var j = a.job;
      if (!j || j.kind !== 'route' || !j.pts) return { x: a.x + a.vx * ahead, y: a.y + a.vy * ahead };
      var px = a.x, py = a.y, left = ahead * a.top * 0.94, i = j.i, guard = 0;
      while (left > 0 && i < j.pts.length && guard++ < 12) {
        var q = j.pts[i];
        var dx = q[0] - px, dy = q[1] - py, d = len(dx, dy);
        if (d < 0.001) { i++; continue; }
        if (d <= left) { px = q[0]; py = q[1]; left -= d; i++; }
        else { px += dx / d * left; py += dy / d * left; left = 0; }
      }
      if (left > 0 && j.pts.length >= 2) {
        var last = j.pts[j.pts.length - 1], prev = j.pts[j.pts.length - 2];
        var ex = last[0] - prev[0], ey = last[1] - prev[1], e = len(ex, ey) || 1;
        px += ex / e * left; py += ey / e * left;
      }
      return { x: px, y: py };
    }

    function flyBall(dt) {
      var f = ball.flight;
      f.t += dt;
      var u = clamp(f.t / f.dur, 0, 1);
      ball.x = f.fx + (f.tx - f.fx) * u;
      ball.y = f.fy + (f.ty - f.fy) * u;
      ball.z = 1.0 + Math.sin(u * Math.PI) * (1.1 + Math.hypot(f.tx - f.fx, f.ty - f.fy) * 0.11) * (f.arc || 1);
      ball.spin += dt * 26;
      if (u < 1) return;
      arrive(f);
    }

    /* THE CATCH POINT. Whoever is closest to where the ball actually came
       down gets the first chance at it — which is why a bad throw into
       coverage is a genuine risk and not a scripted interception. */
    function arrive(f) {
      ball.flight = null;
      var rec = f.to;
      var recD = dist({ x: f.tx, y: f.ty }, rec);
      var best = null, bd = 1e9;
      actors.forEach(function (d) {
        if (d.side !== 'def' || d.state === 'down') return;
        var g = Math.hypot(d.x - f.tx, d.y - f.ty);
        if (g < bd) { bd = g; best = d; }
      });

      /* the defender takes it if he is there and the receiver is not — and
         "there" means a clear half-yard inside him, not a photo finish */
      if (best && bd < CATCH && bd < recD - 0.55) {
        /* he still has to catch it, and defenders drop more than they keep */
        var pInt = clamp(0.10 + best.k.bhk * 0.24 + (f.err - 1.6) * 0.06
                         - rec.k.hnd * 0.06 + (f.hang || 0), 0.01, 0.42);
        if (rand() < pInt) {
          notes.push('Thrown where he had no business going.');
          intercepted(best, f);
          return;
        }
        incomplete(f, 'broken up by ' + shortName(best));
        return;
      }
      if (recD > CATCH) { incomplete(f, 'nobody there'); return; }

      var contested = best ? clamp(1 - bd / 2.6, 0, 1) : 0;
      var pCatch = clamp(0.71 + rec.k.hnd * 0.30 - (f.err - 0.5) * 0.11 - contested * 0.38
                         + (env.hands || 0) + (f.catchAdj || 0), 0.05, 0.985);
      if (rand() > pCatch) {
        if (best && bd < 1.5 && rand() < 0.03 + best.k.bhk * 0.11) { intercepted(best, f); return; }
        incomplete(f, contested > 0.5 ? 'contested' : 'off his hands');
        return;
      }
      /* CAUGHT. And now he is a runner, which is the whole point — so he
         stops running the route. He used to keep following the waypoints of
         a concept that was already over, which is why every completion in
         this game gained its air yards and half a yard more: the man with
         the ball was still trying to finish a dig. */
      rec.carry = true; rec.state = 'carry';
      rec.job = { kind: 'back' };
      /* HE HAS TO CATCH IT AND TURN. A man who takes the ball at full stride
         and keeps it is a man nobody catches: he was the fastest player on
         the field before the throw and the coverage is a yard and a half
         behind him. Planting to secure it is what gives the defender the
         yard back, and it is why yards after the catch are a few and not
         twenty. */
      rec.vx *= 0.32; rec.vy *= 0.32;
      /* CATCH AND TURN. A defender in coverage is already inside a yard when
         the ball arrives; without this beat every underneath completion is a
         one-yard gain, because the tackle lands on the same frame as the
         catch. It is the time it takes to secure it and get north. */
      rec.grace = 0.24;
      ball.holder = rec; carrier = rec;
      f.caught = true;
      caughtAt = ball.y;
      caughtBy = rec;
      airYards = f.airYards;
      refreshUser();
      if (events.onCatch) events.onCatch(rec);
    }
    var caughtAt = null, caughtBy = null, airYards = 0;

    function intercepted(d, f) {
      d.carry = true; d.state = 'carry';
      ball.holder = d; carrier = d;
      interceptor = d;
      airYards = f.airYards;
      notes.push(shortName(d) + ' picked it off.');
      /* HE BRINGS IT BACK. The pick used to end the play where it was caught;
         now the man with the ball runs, the offence chases, and the thumb on
         defence has a return to steer. A defender is a runner like any other
         from here: the tackle, the sideline and the far goal line end it. */
      d.vx *= 0.35; d.vy *= 0.35; d.grace = 0.30;
      d.job = { kind: 'return' }; d.retFrom = d.y;
      if (events.onIntercept) events.onIntercept(d);
      /* the thumb on defence goes straight to the man with the ball */
      if (manual && userSide === 'def') self.setUser(d);
      refreshUser();
    }
    var interceptor = null;

    function incomplete(f, why) {
      notes.push('Incomplete — ' + why + '.');
      airYards = f.airYards;
      finish('incomplete', null, null);
    }

    /* ── IS IT OVER ───────────────────────────────────────────────────────── */
    function checkEnd() {
      if (phase !== 'live') return;
      var c = carrier;
      if (c && c.carry) {
        /* a foot on the line is out: his middle need not cross it */
        if (c.x < 0.55 || c.x > FIELD.width - 0.55) {
          finish(c.side === 'def' ? (interceptor ? 'interception' : 'fumble') : 'outofbounds', c, null); return;
        }
        if (c.side === 'off' && c.y >= 100) { finish('touchdown', c, null); return; }
        if (c.side === 'def' && c.y <= 0) { finish('defensive_td', c, null); return; }
      }
      /* he held it too long and nobody is coming: the whistle is mercy */
      if (t > 12) {
        finish(carrier ? (carrier.side === 'def' ? (interceptor ? 'interception' : 'fumble') : 'tackle') : 'incomplete',
          carrier, null);
      }
    }

    /* ── THE OUTCOME ──────────────────────────────────────────────────────
       Where the ball actually stopped, in the shape the engine books. It is
       measured off the field, not chosen. */
    function finish(kind, c, tk) {
      if (outcome) return;
      phase = 'dead';
      var r = {};
      var k;
      for (k in env.template) if (Object.prototype.hasOwnProperty.call(env.template, k)) r[k] = env.template[k];

      var endY;
      if (kind === 'incomplete') {
        r.incomplete = true; r.completion = false; r.yards = 0;
        r.airYards = airYards;
        r.threwAway = threwAway;
      } else if (kind === 'interception' || (kind === 'fumble' && c && c.side === 'def') || kind === 'defensive_td') {
        /* a takeaway, wherever it ended: the spot is where the defender was
           brought down, went out, or crossed the goal line */
        r.turnover = interceptor ? 'interception' : 'fumble';
        r.completion = false; r.incomplete = false;
        r.yards = 0; r.airYards = airYards;
        r.interceptor = interceptor ? interceptor.player : (fumbleForced && fumbleForced.player);
        r.tackler = interceptor ? interceptor.player : (fumbleForced && fumbleForced.player);
        r.returnYards = c ? Math.max(0, Math.round((c.retFrom == null ? c.y : c.retFrom) - c.y)) : 0;
        r.defTouchdown = kind === 'defensive_td';
        if (fumbledBy) r.carrier = fumbledBy.player;
      } else if (kind === 'fumble') {
        /* the offence fumbled and the defence recovered on the spot. It is
           booked as the play it was — a run, a catch, a scramble or a sack —
           and then the ball is turned over where it lay, so the yards it
           gained still land in the column they belong to. */
        endY = c ? c.y : los;
        r.turnover = 'fumble';
        r.yards = Math.round(endY - los);
        r.tackler = tk && tk.player;
        r.interceptor = tk && tk.player;
        if (c === qb && !thrown && play.type === 'pass' && c.y < los) {
          r.sack = true; r.pressure = true; r.carrier = c && c.player;
        } else if (play.type === 'pass' && caughtBy && c === caughtBy) {
          r.completion = true; r.target = caughtBy.player;
          r.airYards = airYards; r.yac = Math.max(0, r.yards - airYards);
        } else {
          r.carrier = c && c.player;
          if (c === qb && play.type === 'pass') r.scramble = true;
        }
      } else if (kind === 'sack') {
        endY = c ? c.y : los;
        r.sack = true; r.pressure = true;
        r.yards = Math.round(endY - los);
        r.tackler = tk && tk.player;
        r.carrier = c && c.player;
      } else {
        endY = c ? c.y : los;
        r.yards = Math.round(endY - los);
        r.touchdown = kind === 'touchdown';
        r.outOfBounds = kind === 'outofbounds';
        r.tackler = tk && tk.player;
        if (play.type === 'pass' && caughtBy) {
          r.completion = true;
          r.target = caughtBy.player;
          r.airYards = airYards;
          r.yac = Math.max(0, r.yards - airYards);
        } else {
          r.carrier = c && c.player;
          if (c === qb && play.type === 'pass') r.scramble = true;
        }
      }
      blockCredit(r, c, tk);
      /* ── THE FOOTBALL REASON, IN FOUR WORDS ─────────────────────────────
         The whole point of simulating twenty-two men is that the answer has
         a cause; a result card that only says "3-yard rush" throws it away.
         One line, only when it is actually the story. */
      if (play.type === 'run' && kind !== 'sack') {
        var gained = Math.round((c ? c.y : los) - los);
        if (gained >= 4 && r.blockWon) notes.push(shortName(r.blockWon) + ' held the point.');
        else if (gained <= 1 && r.blockBeat) notes.push(shortName(r.blockBeat) + ' beat the block.');
        else if (gained <= 1 && r.blockFree) notes.push(shortName(r.blockFree) + ' came free — nobody blocked him.');
      } else if (kind === 'sack' && r.blockBeat) {
        notes.push(shortName(r.blockBeat) + ' beat '
          + (r.blockBeaten ? shortName(r.blockBeaten) : 'his man') + '.');
      }
      /* taken here, after the play has said everything it has to say */
      r.notes = notes.slice();
      if (pressureSeen) r.pressure = true;
      /* WHERE ON THE FIELD IT ACTUALLY ENDED. The engine only books the
         yards, but the spot is what the next snap is placed on and what a
         test needs to tell one run from another that gained the same two. */
      r.endX = c ? Math.round(c.x * 100) / 100 : ballX;
      r.endY = c ? Math.round(c.y * 100) / 100 : los;
      r.big = r.yards >= 16;
      r.hit = lastHit;
      r.throwKind = lastThrow ? lastThrow.kind : null;
      r.liveTime = Math.round(t * 100) / 100;
      r.throwAt = thrownAt == null ? null : Math.round(thrownAt * 100) / 100;
      r.broke = (c && c.broke) || 0;
      outcome = r;
      if (events.onEnd) events.onEnd(kind, r);
    }

    /* ── THE CREASE ───────────────────────────────────────────────────────
       Where the hole actually is, this frame. Not the lane the play was drawn
       with — the gap the blocking has made, between the two nearest men in
       the front who could still make the tackle, in front of whoever has the
       ball.

       It is the one thing a player watching a run cannot otherwise see. The
       engine knows exactly why a carry got four instead of one; without this
       the picture does not, and a run play is a man disappearing into a pile.
       Engaged defenders are not walls — a blocker with his hands on somebody
       is what makes the hole — so they are left out of it. */
    self.crease = function () {
      if (phase !== 'live' || play.type !== 'run') return null;
      if (!carrier || !carrier.carry) return null;
      var front = [], i;
      for (i = 0; i < actors.length; i++) {
        var d = actors[i];
        if (d.side !== 'def' || d.state === 'down') continue;
        if (d.lock) continue;                       /* somebody has him */
        if (d.pos !== 'DL' && d.pos !== 'LB') continue;
        if (d.y < carrier.y - 1.5) continue;        /* behind the ball */
        if (d.y > los + 9) continue;                /* not part of this */
        front.push(d.x);
      }
      if (front.length < 2) return null;
      front.sort(function (a, b) { return a - b; });
      /* THE GAP BETWEEN TWO MEN, not the edge of the box. Measuring from the
         sideline in gave a crease eight yards wide on almost every snap,
         which tells a player nothing — a hole is somewhere two defenders are
         not, and it is the one he can get to that matters. */
      var best = null;
      for (i = 0; i < front.length - 1; i++) {
        var a = front[i], b = front[i + 1], w = b - a;
        if (w < 2.2) continue;
        var mid = (a + b) / 2;
        var reach = Math.abs(mid - carrier.x);
        var sc = w - reach * 0.55;
        if (!best || sc > best.sc) best = { x: mid, w: w, reach: reach, sc: sc };
      }
      if (!best || best.reach > 9) return null;
      return { x: best.x, w: Math.min(best.w, 6.5), y: Math.max(los, carrier.y),
               open: clamp((best.w - 2.2) / 4.5, 0, 1) };
    };

    /* ── WHO WON THE BLOCK ────────────────────────────────────────────────
       At the whistle, the two men worth naming: the blocker who held the
       point the run went through, and the defender who beat his to make the
       play. Both come straight off the reps the simulation already ran. */
    function blockCredit(r, c, tk) {
      var poa = poaX == null ? (c ? c.x : ballX) : poaX, i, a;
      var held = null, heldScore = -1;
      for (i = 0; i < actors.length; i++) {
        a = actors[i];
        if (a.side !== 'off' || !a.job) continue;
        if (['block', 'lead', 'stalk', 'protect'].indexOf(a.job.kind) < 0) continue;
        if (!(a.heldFor > 0.55)) continue;
        /* THE MAN AT THE HOLE, not the man who held longest. A centre holds
           his man on every snap in football; naming him on every carry is a
           credit nobody learns anything from. */
        /* WHERE HE ENDED UP OR WHERE HE LINED UP, whichever is nearer the
           hole. A receiver who stalked a corner on a toss is at the point of
           attack even though he lined up on the numbers, and he is exactly
           the block that sprung it. */
        var away = Math.min(Math.abs(a.x - poa),
                            Math.abs((a.hx == null ? a.x : a.hx) - poa));
        if (away > 7) continue;
        var sc = Math.min(a.heldFor, 2.2) * 0.9 - away * 0.75;
        if (sc > heldScore) { heldScore = sc; held = a; }
      }
      if (held) r.blockWon = held.player || null;
      if (tk && tk.beat > 0) {
        r.blockBeat = tk.player || null;
        var by = tk.beatWho && byId[tk.beatWho];
        r.blockBeaten = (by && by.player) || null;
      } else if (tk && !tk.heldBy) {
        /* nobody ever got a hand on him, which is a different failure and
           the one a player can do something about next time */
        r.blockFree = tk.player || null;
      }
      return r;
    }

    /* ── SMALL HELPERS ────────────────────────────────────────────────────── */
    function nearestDefTo(a, not, within) {
      if (!a) return null;
      var best = null, bd = within || 1e9;
      actors.forEach(function (d) {
        if (d.side !== 'def' || d === not || d.state === 'down') return;
        var g = dist(a, d);
        if (g < bd) { bd = g; best = d; }
      });
      return best;
    }
    function openness(a) {
      var d = nearestDefTo(a);
      return d ? clamp((dist(a, d) - 1.2) / 4.5, 0, 1) : 1;
    }
    function shortName(a) {
      if (!a) return 'He';
      if (a.name) return a.name;
      /* a player card rather than an actor */
      if (a.last_name) return (a.first_name || ' ').charAt(0) + '. ' + a.last_name;
      return 'He';
    }

    return self;
  }

  /* a route in field coordinates, mirrored for the side he lines up on */
  function routeWorld(rk, hx, hy, centerX) {
    var r = F.ROUTES[rk];
    if (!r) return [[hx, hy]];
    var s = hx >= centerX ? 1 : -1, out = [[hx, hy]], i;
    for (i = 0; i < r.pts.length; i++) {
      out.push([clamp(hx + r.pts[i][1] * s, 0.6, FIELD.width - 0.6), hy + r.pts[i][0]]);
    }
    return out;
  }

  var API = { Play: Play, routeWorld: routeWorld, FIELD: FIELD,
              ENGAGE: ENGAGE, TACKLE: TACKLE, CATCH: CATCH };
  root.EDGridironLive = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
