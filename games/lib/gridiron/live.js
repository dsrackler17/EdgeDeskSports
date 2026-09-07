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
       the between-calls preview lines eleven men up and never says hut. */
    var env = o.env || BLANK_ENV;
    var rand = o.rand || Math.random;
    var los = o.los, ballX = o.ballX == null ? FIELD.half : o.ballX;
    var events = o.events || {};
    var userSide = o.userSide === 'def' ? 'def' : 'off';
    var manual = o.userMode !== 'coach';

    var byId = {};
    actors.forEach(function (a) { byId[a.id] = a; });

    var t = 0, phase = 'set', outcome = null;
    var ball = { x: ballX, y: los, z: 0, spin: 0, holder: null, flight: null };
    var qb = byId['o_QB'] || null;
    var carrier = null, user = null;
    var handoffAt = play.type === 'run' ? 0.62 : 0;
    var thrown = false, pressureSeen = false, handedOff = false;
    var notes = [];
    var threwAway = false;
    var bailAt = 0, bailKind = null, bailLane = null, thrownAt = null;
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

    /* ── THE MEN, AS NUMBERS ──────────────────────────────────────────────
       The engine rated every card it knows; anyone it does not know gets the
       unit average he came from, so a live play never divides by a blank. */
    actors.forEach(function (a) {
      var e = (a.player && env.at[a.player.id]) || env.fallback[a.side];
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
      if (phase !== 'set') return false;
      phase = 'live'; t = 0;
      ball.holder = qb;
      if (qb) { qb.carry = play.type !== 'pass'; }
      carrier = qb;
      actors.forEach(function (a) {
        a.state = a.side === 'off' && a.pos === 'OL' ? 'block' : 'run';
        /* a defence that did not read it is a beat late off the ball */
        a.react = a.side === 'def' ? env.reaction * (0.6 + rand() * 0.8) : 0;
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
      try { list = F.reads(play.key, parts.coverage.key) || []; } catch (_) { list = []; }
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
      if (input.throwTo != null && !thrown) throwTo(input.throwTo);
      if (input.action) doAction(input.action);
      if (input.switchDef && userSide === 'def') {
        var n = nearestDefTo(carrier || ball, user);
        if (n) self.setUser(n);
      }
      var a = user;
      if (!a || a.state === 'down') return;
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

    function doAction(kind) {
      var a = userSide === 'def' ? user : carrier;
      if (!a || a.state === 'down' || a.moveCool > 0) return;
      if (kind === 'juke' || kind === 'spin') {
        a.moveCool = 0.62; a.move = kind; a.moveT = 0.34;
        /* a cut is lateral and costs him a stride */
        var s = a.dx >= 0 ? 1 : -1;
        a.vx += s * 5.4 * (0.6 + a.k.agi * 0.8);
        a.vy *= 0.72;
        if (events.onMove) events.onMove(kind);
      } else if (kind === 'truck') {
        a.moveCool = 0.70; a.move = 'truck'; a.moveT = 0.38;
        a.vy += (a.side === 'off' ? 1 : -1) * 2.6 * (0.5 + a.k.pwr);
        a.vx *= 0.6;
        a.state = 'block';
        if (events.onMove) events.onMove('truck');
      } else if (kind === 'dive' || kind === 'tackle') {
        a.dive = 0.40; a.state = 'tackle';
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
      if (a.moveT > 0) { a.moveT -= dt; if (a.moveT <= 0) a.move = null; }
      if (a.stun > 0) a.stun -= dt;
      if (a.grace > 0) a.grace -= dt;
      if (a.dive > 0) a.dive -= dt;
      if (a.react > 0) { a.react -= dt; if (a.side === 'def') { a.tx = a.x; a.ty = a.y; return; } }
      if (a.state === 'down' || a.state === 'celebrate') return;

      /* the man in your thumb goes where you point, full stop */
      if (a === user && a.steered && a.drive > 0.08) {
        a.tx = a.x + a.dx * 8; a.ty = a.y + a.dy * 8;
        a.state = a.carry ? 'carry' : 'run';
        return;
      }
      if (a === user && userSide === 'def' && !a.steered) {
        var tg = carrier || qb;
        if (tg) { a.tx = tg.x; a.ty = tg.y; a.state = a.dive > 0 ? 'tackle' : 'run'; }
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
        a.tx = mesh.x; a.ty = mesh.y; a.state = 'run';
        return;
      }
      var aim = daylight(a);
      a.tx = aim.x; a.ty = aim.y;
      a.state = 'carry';
    }
    /* where the grass is: sample a fan of angles and take the one with the
       most room before the nearest defender. It is crude and it is enough to
       make an AI back look like he is reading blocks. */
    function daylight(a) {
      var best = null, bs = -1e9, i;
      for (i = -4; i <= 4; i++) {
        var ang = i * 0.19;
        var dx = Math.sin(ang), dy = Math.cos(ang);
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
      var qx = qb ? qb.x : ballX, qy = qb ? qb.y : los - 4;
      if (play.type === 'run') {
        /* drive him off the ball and off the runner's track */
        a.tx = clamp(d.x, a.hx - 2.6, a.hx + 2.6);
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
      var lead = clamp(gap / Math.max(3, a.top), 0, 1.2) * (0.35 + a.k.iq * 0.75);
      var px = tgt.x + tgt.vx * lead, py = tgt.y + tgt.vy * lead;
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
    function progression() {
      return actors.filter(function (a) {
        return a.side === 'off' && a.job && a.job.kind === 'route' && a.state !== 'down';
      }).sort(function (a, b) {
        var ra = ORDER[a.slot] == null ? 90 : ORDER[a.slot];
        var rb = ORDER[b.slot] == null ? 90 : ORDER[b.slot];
        return ra - rb;
      });
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
    function decide(a) {
      if (thrown || play.type !== 'pass' || !qb || qb.state === 'down') return;
      if (qb.job && qb.job.kind === 'scramble') return;
      var hold = play.hold || 2.4;
      var iq = qb.k.iq, spd = qb.k.spd;
      var heat = heatOn(qb);
      var prog = progression();

      /* THE USER'S QUARTERBACK IS THE USER'S. All he gets is the bail-out a
         real one has: when he has been back far too long and somebody is on
         him, he throws it away rather than eat a twelve-yard sack for a snap
         nobody was ever going to make. Late enough that a player who is
         actually playing never meets it. */
      if (!autoQB) {
        if (t > Math.max(3.6, hold + 2.1) && heat > 0.72) throwAway('nothing there');
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

    function manThink(a, j) {
      var m = byId[j.on];
      if (!m) { a.tx = a.x; a.ty = a.y + 4; a.state = 'run'; return; }
      if (carrier && carrier.carry) { pursue(a, carrier); return; }
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
      var trail = 0.80 + env.separation * 0.72 - a.k.cov * 1.10;
      var lead = 0.16 + a.k.cov * 0.20;
      a.tx = m.x + m.vx * lead;
      a.ty = m.y + m.vy * lead + clamp(trail, 0.45, 3.4);
      a.state = 'run';
      if (ball.flight) breakOnBall(a);
    }

    function zoneThink(a, j) {
      if (carrier && carrier.carry) { pursue(a, carrier); return; }
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
      if (deep && deepest && deepest.y > j.y - 4.0) {
        /* he opens his hips and runs, keeping his cushion */
        a.tx = deepest.x * 0.55 + j.x * 0.45;
        a.ty = Math.max(deepest.y + 1.5, j.y);
        a.state = 'run';
        return;
      }
      /* otherwise he sits on his landmark and squeezes whoever comes into it */
      if (near && nd < (deep ? 9.5 : 7.5)) {
        a.tx = near.x * 0.55 + j.x * 0.45;
        a.ty = Math.max(j.y - 1.5, near.y + 0.9);
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
      if (f.t < 0.34 - a.k.bhk * 0.20) return;
      var d = Math.hypot(a.x - f.tx, a.y - f.ty);
      if (d > 5.5 + a.k.bhk * 6) return;
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
        var sp = len(a.vx, a.vy), top = a.top * slow;
        if (sp > top && sp > 0) { a.vx = a.vx / sp * top; a.vy = a.vy / sp * top; }
        a.vx -= a.vx * 1.8 * dt; a.vy -= a.vy * 1.8 * dt;
        a.x = clamp(a.x + a.vx * dt, -3, FIELD.width + 3);
        a.y += a.vy * dt;
        if (sp > 0.6) a.face = a.vx > 0.8 ? 'right' : a.vx < -0.8 ? 'left'
          : (a.vy > 0) === (a.side === 'off') ? 'back' : 'front';
        a.lean = clamp(a.vx * 0.05, -0.4, 0.4);
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
          if (d > 1.20 || d < 0.0001) continue;
          push = (1.20 - d) / 2;
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
        if (kind !== 'block' && kind !== 'lead' && kind !== 'stalk' && kind !== 'protect') return;
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
            if (d.beat) b.rep *= 0.32;
            d.rep = b.rep;
          }
          return;
        }
        b.rep -= dt;
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
          release(b);
          /* he beat the block, and he comes off it going somewhere */
          d.stun = 0.10;
          d.beat = (d.beat || 0) + 1;
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
        if (d.side === c.side || d.state === 'down' || d.lock) return;
        var g = dist(d, c);
        if (g > TACKLE + (d.dive > 0 ? 0.75 : 0)) return;
        /* HE GETS ANOTHER GO. Bodies stay within a yard of each other for a
           long time in football; a man who misses once and then jogs alongside
           for the rest of the run is not a defence, he is scenery. */
        if (d.tryAt > t) return;
        d.tryAt = t + 0.55;
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

      /* MOST TACKLES STICK. A broken tackle is an event, not a coin flip:
         start high, and let the runner, the angle and the user's thumb take
         chunks out of it. */
      var p = 0.86
            + (d.k.tkl - (c.k.pwr * 0.50 + c.k.agi * 0.50)) * 0.42
            + square * 0.10
            - clamp(sp - closing, -3, 3) * 0.025
            + (env.runFit || 0) * 0.3;
      if (d.dive > 0) p += 0.06;
      if (d.stun > 0) p -= 0.30;
      /* THE USER'S MOVE. This is the whole reason the buttons exist. */
      if (c.move === 'juke' || c.move === 'spin') p -= 0.13 + c.k.agi * 0.30;
      if (c.move === 'truck') p -= 0.09 + c.k.pwr * 0.26;
      /* gang tackling: the second man arrives to a runner already slowed */
      var help = 0;
      actors.forEach(function (o) {
        if (o === d || o.side !== d.side || o.state === 'down') return;
        if (dist(o, c) < 2.4) help++;
      });
      p += Math.min(0.10, help * 0.05);

      if (rand() < clamp(p, 0.04, 0.97)) {
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

    function down(c, d) {
      c.state = 'down'; c.fell = rand() > 0.5 ? 1 : -1;
      if (d) d.state = 'tackle';
      finish(c === qb && !thrown && play.type === 'pass' && c.y < los ? 'sack' : 'tackle', c, d);
    }

    /* ── THE THROW ────────────────────────────────────────────────────────
       When and where is the user's. Whether it arrives is the football's. */
    function throwTo(idx) {
      if (thrown || play.type !== 'pass' || !qb || qb.state === 'down') return false;
      var list = self.targets();
      var tg = null;
      if (typeof idx === 'string') { tg = byId[idx]; }
      else { var e = list[idx | 0]; tg = e && byId[e.id]; }
      if (!tg) return false;

      thrown = true; thrownAt = t;
      qb.state = 'throw'; qb.hold = 0.3;
      qb.carry = false;
      ball.holder = null;
      carrier = null;

      /* where he leads him: far enough ahead that a well-thrown ball meets a
         running man, wrong by however much the throw was worth */
      var d0 = dist(qb, tg);
      var speed = 17 + qb.k.arm * 12;
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
      var err = (1 - qb.k.accy) * 1.5
              + hurried * 1.05
              + moving * 0.9
              - (env.deepAcc || 0) * -1 * 0 /* weather is applied below, by band */
              + clamp(d0 - 10, 0, 34) * 0.072
              + early * 1.6
              - (d0 > 18 ? (env.deepAcc || 0) : (env.shortAcc || 0)) * 4;
      err = clamp(err, 0.15, 5.5);
      var ang = rand() * Math.PI * 2, mag = err * (0.35 + rand() * 0.85);
      lx += Math.cos(ang) * mag; ly += Math.sin(ang) * mag;
      lx = clamp(lx, -2, FIELD.width + 2);

      ball.flight = {
        fx: ball.x, fy: ball.y, tx: lx, ty: ly, t: 0,
        dur: clamp(Math.hypot(lx - ball.x, ly - ball.y) / speed, 0.20, 1.6),
        to: tg, airYards: Math.round(ly - los), err: err, early: early
      };
      if (hurried > 0.55) { pressureSeen = true; }
      if (events.onThrow) events.onThrow(tg);
      refreshUser();
      return true;
    }
    self.throwTo = throwTo;
    self.thrown = function () { return thrown; };

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
      ball.z = 1.0 + Math.sin(u * Math.PI) * (1.1 + Math.hypot(f.tx - f.fx, f.ty - f.fy) * 0.11);
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
                         - rec.k.hnd * 0.06, 0.01, 0.42);
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
                         + (env.hands || 0), 0.05, 0.985);
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
      if (events.onIntercept) events.onIntercept(d);
      /* the play is dead where he caught it: no returns in this milestone */
      finish('interception', d, null);
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
        if (c.x < 0.55 || c.x > FIELD.width - 0.55) { finish('outofbounds', c, null); return; }
        if (c.side === 'off' && c.y >= 100) { finish('touchdown', c, null); return; }
        if (c.side === 'def' && c.y <= 0) { finish('defensive_td', c, null); return; }
      }
      /* he held it too long and nobody is coming: the whistle is mercy */
      if (t > 12) { finish(carrier ? 'tackle' : 'incomplete', carrier, null); }
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
      r.notes = notes.slice();

      var endY;
      if (kind === 'incomplete') {
        r.incomplete = true; r.completion = false; r.yards = 0;
        r.airYards = airYards;
        r.threwAway = threwAway;
      } else if (kind === 'interception') {
        r.turnover = 'interception'; r.completion = false; r.incomplete = false;
        r.yards = 0; r.airYards = airYards;
        r.interceptor = interceptor && interceptor.player;
        r.tackler = interceptor && interceptor.player;
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
      if (pressureSeen) r.pressure = true;
      /* WHERE ON THE FIELD IT ACTUALLY ENDED. The engine only books the
         yards, but the spot is what the next snap is placed on and what a
         test needs to tell one run from another that gained the same two. */
      r.endX = c ? Math.round(c.x * 100) / 100 : ballX;
      r.endY = c ? Math.round(c.y * 100) / 100 : los;
      r.big = r.yards >= 16;
      r.liveTime = Math.round(t * 100) / 100;
      r.throwAt = thrownAt == null ? null : Math.round(thrownAt * 100) / 100;
      r.broke = (c && c.broke) || 0;
      outcome = r;
      if (events.onEnd) events.onEnd(kind, r);
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
    function shortName(a) { return (a && a.name) || 'He'; }

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
