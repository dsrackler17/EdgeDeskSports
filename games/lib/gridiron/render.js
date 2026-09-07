/* ===========================================================================
   GRIDIRON — the field you watch.

   An SVG football field, twenty-two players on it, and a choreographer that
   turns one result object from the engine into two and a half seconds of
   football. NOTHING HERE DECIDES ANYTHING: the yards are already known before
   the first frame draws. What this file decides is what it LOOKED like.

   Why SVG and not canvas or WebGL: a phone renders a few dozen vector nodes
   with transforms at sixty frames a second without breaking a sweat, it stays
   crisp on every pixel ratio, it costs no image bytes, and every player is a
   real DOM node a screen reader can name.

   The camera follows the ball down a vertical field, because a phone is tall
   and a football field is not. Offence always attacks UP the screen — the
   possession arrow and the team colours say who that is.

   Coordinates. Choreography is in YARDS, offence-relative:
       fx   downfield from the line of scrimmage
       fy   lateral from the centre of the field, positive to the offence's
            right as it faces the end zone it is attacking
   The renderer maps those to SVG units at TEN UNITS PER YARD, and mirrors
   nothing: the offence is always going up.
   =========================================================================== */
(function (root) {
  'use strict';

  var F = root.EDFootball || (typeof require === 'function' ? require('./football.js') : null);

  var U = 10;                       /* svg units per yard */
  var W = 533;                      /* field width in units (53.3 yards) */
  var HALF = W / 2;
  var MARGIN = 16;                  /* a little sideline either side, in units */
  var VIEW = 34;                    /* the default depth window, in yards */
  var LOS_AT = 0.64;                /* the line of scrimmage sits this far down */

  /* players are drawn bigger than scale, the way every sports game draws them:
     a real 0.6-yard shoulder width is four pixels on a phone */
  var PR = 15.5;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ── ALIGNMENT ───────────────────────────────────────────────────────────
     Where the twenty-two stand before the snap. Offence from the formation,
     defence from the front, the coverage and the pressure — so a Cover 4
     look actually shows two safeties deep and a Zero blitz shows nobody. */
  function alignOffense(playObj, formKey) {
    var form = F.formation(formKey), out = [], k, s, n = 1;
    /* the five up front, 2.4-yard splits either side of the centre */
    var olY = [-4.8, -2.4, 0, 2.4, 4.8], names = ['LT', 'LG', 'C', 'RG', 'RT'], i;
    for (i = 0; i < 5; i++) {
      out.push({ slot: names[i], pos: 'OL', fx: 0.4, fy: olY[i], num: 70 + i, line: true });
    }
    for (k in form.spots) {
      if (!form.spots.hasOwnProperty(k)) continue;
      s = form.spots[k];
      out.push({ slot: k, pos: slotPos(k), fx: s[0], fy: s[1],
                 num: slotNum(k), route: playObj.assign ? playObj.assign[k] : null });
    }
    return out;
  }
  function slotPos(k) {
    if (k === 'QB') return 'QB';
    if (k === 'RB' || k === 'FB') return 'RB';
    if (k === 'TE' || k === 'TE2') return 'TE';
    return 'WR';
  }
  var SLOT_NUM = { QB: 7, RB: 21, FB: 44, TE: 85, TE2: 87, X: 11, Z: 3, SL: 18, SL2: 82 };
  function slotNum(k) { return SLOT_NUM[k] || 80; }

  function alignDefense(parts, offense, strong) {
    var out = [], i;
    /* the front shades toward its strength, which is the whole tell */
    var shade = (strong || 0) * 2.4;
    var front = parts.front, cov = parts.coverage, press = parts.pressure;
    var nDL = front.key === '34' ? 3 : front.key === 'goalline' ? 5 : 4;
    var nDB = front.dbs;
    var nLB = 11 - nDL - nDB;
    /* the line */
    var dlY = nDL === 3 ? [-5, 0, 5] : nDL === 5 ? [-8, -4, 0, 4, 8] : [-6.5, -2.2, 2.2, 6.5];
    for (i = 0; i < nDL; i++) out.push({ slot: 'DL' + i, pos: 'DL', fx: 1.2, fy: dlY[i] + shade, num: 90 + i, line: true });
    /* backers: depth depends on the front and whether they are coming */
    var lbY = nLB >= 4 ? [-10, -3.5, 3.5, 10] : nLB === 3 ? [-8, 0, 8] : nLB === 2 ? [-5, 5] : [0];
    var lbDepth = front.key === 'goalline' ? 2.5 : 4.6;
    for (i = 0; i < nLB; i++) {
      out.push({ slot: 'LB' + i, pos: 'LB', fx: lbDepth + (i % 2 ? 0.4 : 0), fy: (lbY[i] || 0) + shade * 0.8,
                 num: 50 + i, blitz: blitzer(press, i, nLB) });
    }
    /* corners and safeties, placed by what the coverage is */
    var press2 = cov.key === 'cover0' || cov.key === 'cover1';
    var cbDepth = press2 ? 1.2 : cov.key === 'cover2' || cov.key === 'tampa2' ? 5 : 7.5;
    var nCB = Math.min(nDB - safetyCount(cov), Math.max(2, nDB - 2));
    var nS = nDB - nCB;
    var cbY = [-21, 21, -13, 13];
    for (i = 0; i < nCB; i++) out.push({ slot: 'CB' + i, pos: 'CB', fx: cbDepth, fy: cbY[i] || 0, num: 20 + i });
    var sY, sDepth;
    if (cov.key === 'cover0') { sDepth = 4; sY = [-9, 9, 0]; }
    else if (cov.key === 'cover1') { sDepth = 13; sY = [0, -8, 8]; }
    else if (cov.key === 'cover4' || cov.key === 'cover6') { sDepth = 11; sY = [-11, 11, 0]; }
    else if (cov.key === 'cover2' || cov.key === 'tampa2') { sDepth = 13; sY = [-13, 13, 0]; }
    else { sDepth = 12; sY = [-2, 12, -12]; }
    for (i = 0; i < nS; i++) out.push({ slot: 'S' + i, pos: 'S', fx: sDepth + (i ? 1 : 0), fy: sY[i] || 0, num: 30 + i });
    return out;
  }
  function safetyCount(cov) {
    if (cov.key === 'cover0') return 1;
    if (cov.key === 'cover4' || cov.key === 'cover6' || cov.key === 'cover2' || cov.key === 'tampa2') return 2;
    return 1;
  }
  function blitzer(press, i, n) {
    if (press.key === 'none') return false;
    if (press.key === 'zero') return true;
    if (press.key === 'agap' || press.key === 'cross') return i === Math.floor(n / 2) || i === 0;
    if (press.key === 'edge') return i === 0;
    return i === n - 1;
  }

  /* ── ROUTE PATHS ─────────────────────────────────────────────────────────
     A route's waypoints, in field coordinates, from where the man is lined
     up. Mirrored for a receiver on the left so a slant always breaks in. */
  function routePath(routeKey, from) {
    var r = F.ROUTES[routeKey];
    if (!r) return [{ fx: from.fx, fy: from.fy }];
    var s = from.fy >= 0 ? 1 : -1, out = [{ fx: from.fx, fy: from.fy }], i, p;
    for (i = 0; i < r.pts.length; i++) {
      p = r.pts[i];
      out.push({ fx: from.fx + p[0], fy: from.fy + p[1] * s });
    }
    return out;
  }

  /* ── CHOREOGRAPHY ────────────────────────────────────────────────────────
     One result becomes a timeline. Every actor gets a track of keyframes in
     seconds; the renderer interpolates between them. */
  function choreograph(res, opts) {
    opts = opts || {};
    var playObj = F.play(res.play), parts = F.defParts({
      key: res.def, front: res.front, coverage: res.coverage, pressure: res.pressureCall, fit: res.fit
    });
    var off = alignOffense(playObj, res.formation);
    var def = alignDefense(parts, playObj, res.strongSide || 0);
    var isRun = playObj.type === 'run' || res.scramble;
    var yards = res.yards || 0;
    var actors = [], ball = [], events = [];
    var snapT = 0.28;
    var endT;

    /* where the ball carrier finishes */
    var endFx = yards, endFy = 0;

    /* ── the offensive line: fire out on a run, set on a pass ───────────── */
    off.forEach(function (o) {
      if (o.pos !== 'OL') return;
      var push = isRun ? 1.6 : -0.8;
      actors.push({ id: 'o_' + o.slot, side: 'off', pos: 'OL', num: o.num, slot: o.slot,
        track: [{ t: 0, fx: o.fx, fy: o.fy }, { t: snapT, fx: o.fx, fy: o.fy },
                { t: snapT + 0.8, fx: o.fx + push, fy: o.fy + (isRun ? (o.fy > 0 ? 0.7 : -0.7) : 0) },
                { t: snapT + 2.2, fx: o.fx + push * 1.3, fy: o.fy + (isRun ? (o.fy > 0 ? 1.1 : -1.1) : 0) }] });
    });

    /* ── the defensive line and blitzers: at the quarterback ────────────── */
    var rushTo = isRun ? { fx: 1.5, fy: 0 } : { fx: -6, fy: 0 };
    def.forEach(function (d) {
      var rushing = d.pos === 'DL' || d.blitz;
      var t = [{ t: 0, fx: d.fx, fy: d.fy }, { t: snapT, fx: d.fx, fy: d.fy }];
      if (rushing) {
        var meet = res.sack ? 0.85 : res.pressure ? 1.05 : 1.5;
        t.push({ t: snapT + meet * 0.55, fx: (d.fx + rushTo.fx) / 2, fy: d.fy * 0.75 });
        t.push({ t: snapT + meet, fx: rushTo.fx + (res.sack || res.pressure ? 0 : 1.6),
                 fy: d.fy * (res.sack || res.pressure ? 0.25 : 0.55) });
      } else if (isRun) {
        t.push({ t: snapT + 0.7, fx: d.fx - 1.5, fy: d.fy * 0.6 });
        t.push({ t: snapT + 1.5, fx: Math.max(0.5, endFx * 0.7), fy: endFy * 0.6 });
      } else {
        /* drop into the zone this coverage asks for */
        var drop = d.pos === 'LB' ? 6 : d.pos === 'CB' ? (parts.coverage.key === 'cover0' || parts.coverage.key === 'cover1' ? 9 : 11) : 4;
        t.push({ t: snapT + 1.0, fx: d.fx + drop * 0.5, fy: d.fy * 1.05 });
        t.push({ t: snapT + 2.0, fx: d.fx + drop, fy: d.fy * 1.1 });
      }
      actors.push({ id: 'd_' + d.slot, side: 'def', pos: d.pos, num: d.num, slot: d.slot,
                    blitz: !!d.blitz, track: t });
    });

    /* ── the skill players ──────────────────────────────────────────────── */
    var qb = null, carrier = null, targetActor = null;
    off.forEach(function (o) {
      if (o.pos === 'OL') return;
      var a = { id: 'o_' + o.slot, side: 'off', pos: o.pos, num: o.num, slot: o.slot,
                route: o.route, track: [{ t: 0, fx: o.fx, fy: o.fy }, { t: snapT, fx: o.fx, fy: o.fy }] };
      if (o.slot === 'QB') qb = a;
      actors.push(a);
    });

    if (isRun) {
      /* the back takes it and goes; everybody else blocks or clears out */
      var carrySlot = res.carrier && res.carrier.position === 'QB' ? 'QB' : 'RB';
      var runner = actors.filter(function (a) { return a.slot === carrySlot; })[0]
                || actors.filter(function (a) { return a.slot === 'RB'; })[0] || qb;
      var lane = playObj.concept === 'outside' ? 7 : playObj.concept === 'gap' ? 3 : 1.2;
      var side = res.lane ? res.lane : (res.strongSide ? -res.strongSide : 1);
      endFy = clampY(lane * side * (yards > 4 ? 1 : 0.5));
      if (qb && runner !== qb) {
        qb.track.push({ t: snapT + 0.5, fx: -3, fy: 0 }, { t: snapT + 2.4, fx: -3.5, fy: -1.5 });
      }
      if (runner) {
        var hit = snapT + 0.55;
        runner.track.push({ t: hit, fx: -1.5, fy: side * 1.2 });
        runner.track.push({ t: hit + 0.45, fx: 0.5, fy: side * lane * 0.6 });
        /* a ninety-yard run is three seconds of running, not nine: the
           carrier simply covers more ground per second on a long one */
        var runFor = Math.max(0.35, Math.min(2.6, Math.abs(yards) / 15));
        runner.track.push({ t: hit + 0.45 + runFor, fx: endFx, fy: endFy });
        runner.carrier = true;
        carrier = runner;
        endT = hit + 0.55 + runFor;
      } else { endT = snapT + 1.6; }
      /* receivers stalk-block */
      actors.forEach(function (a) {
        if (a.side !== 'off' || a.pos === 'OL' || a === carrier || a === qb) return;
        a.track.push({ t: snapT + 1.2, fx: a.track[0].fx + 4, fy: a.track[0].fy - (a.track[0].fy > 0 ? 1.5 : -1.5) });
      });
      ball = [{ t: 0, fx: 0, fy: 0, hidden: true }];
      events.push({ t: snapT, type: 'snap' });
      events.push({ t: endT, type: res.touchdown ? 'touchdown' : res.turnover ? 'turnover' : 'tackle' });
    } else {
      /* the drop, the routes, the throw, the catch */
      var hold = playObj.hold || 2.4;
      var dropDepth = playObj.concept === 'quick' ? 3.5 : playObj.concept === 'screen' ? 4.5 : 6.5;
      if (qb) {
        qb.track.push({ t: snapT + 0.55, fx: -dropDepth * 0.8, fy: 0 });
        qb.track.push({ t: snapT + hold * 0.75, fx: -dropDepth, fy: res.pressure ? 1.8 : 0.3 });
      }
      /* every route runs, whether or not the ball goes there */
      actors.forEach(function (a) {
        if (a.side !== 'off' || a.pos === 'OL' || a.slot === 'QB') return;
        var rk = a.route;
        if (!rk || rk === 'block') {
          a.track.push({ t: snapT + 1.2, fx: a.track[0].fx - 1.2, fy: a.track[0].fy * 0.9 });
          return;
        }
        var path = routePath(rk, { fx: a.track[0].fx, fy: a.track[0].fy });
        var rt = F.ROUTES[rk], dur = Math.max(1.0, (rt && rt.t) || 2);
        var i;
        for (i = 1; i < path.length; i++) {
          a.track.push({ t: snapT + dur * (i / (path.length - 1)), fx: path[i].fx, fy: clampY(path[i].fy) });
        }
        a.routePath = path;
      });

      var throwT = snapT + hold;
      if (res.sack) {
        endT = snapT + 0.95;
        if (qb) qb.track.push({ t: endT, fx: -dropDepth - Math.abs(yards) * 0.3, fy: 1.4 });
        carrier = qb;
        ball = [{ t: 0, fx: 0, fy: 0, hidden: true }];
        events.push({ t: snapT, type: 'snap' }, { t: endT, type: 'sack' });
      } else if (res.scramble) {
        endT = snapT + hold + 0.9;
        if (qb) {
          qb.track.push({ t: throwT, fx: -dropDepth + 1, fy: 6 });
          qb.track.push({ t: endT, fx: yards, fy: clampY(9) });
          qb.carrier = true;
        }
        carrier = qb;
        ball = [{ t: 0, fx: 0, fy: 0, hidden: true }];
        events.push({ t: snapT, type: 'snap' }, { t: endT, type: 'tackle' });
      } else {
        /* who the ball goes to */
        var slot = res.targetSlot || (playObj.assign ? Object.keys(playObj.assign)[0] : 'X');
        targetActor = actors.filter(function (a) { return a.slot === slot; })[0]
                   || actors.filter(function (a) { return a.side === 'off' && a.route && a.route !== 'block'; })[0];
        var catchAt = targetActor ? trackAt(targetActor.track, throwT + 0.45)
                                  : { fx: res.airYards || 5, fy: 0 };
        var qbAt = qb ? trackAt(qb.track, throwT) : { fx: -dropDepth, fy: 0 };
        var flight = Math.max(0.28, Math.min(1.15, dist(qbAt, catchAt) / 26));
        ball = [
          { t: 0, fx: 0, fy: 0, attached: 'o_QB' },
          { t: throwT, fx: qbAt.fx, fy: qbAt.fy },
          { t: throwT + flight, fx: catchAt.fx, fy: catchAt.fy, arc: true }
        ];
        events.push({ t: snapT, type: 'snap' }, { t: throwT, type: 'throw' });
        if (res.turnover === 'interception') {
          endT = throwT + flight + 0.7;
          events.push({ t: throwT + flight, type: 'interception' });
          /* the nearest defender takes it the other way */
          var pick = nearestDef(actors, catchAt);
          if (pick) {
            trunc(pick.track, throwT + flight);
            pick.track.push({ t: throwT + flight, fx: catchAt.fx, fy: catchAt.fy });
            pick.track.push({ t: endT, fx: catchAt.fx - 7, fy: clampY(catchAt.fy + 7) });
            pick.carrier = true; pick.turnover = true;
          }
        } else if (res.completion) {
          var runAfter = Math.max(0.3, Math.min(2.2, (res.yac || 0) / 14));
          endT = throwT + flight + runAfter + 0.2;
          if (targetActor) {
            trunc(targetActor.track, throwT + flight);
            targetActor.track.push({ t: throwT + flight, fx: catchAt.fx, fy: catchAt.fy });
            targetActor.track.push({ t: endT, fx: endFx, fy: clampY(catchAt.fy * 0.6) });
            targetActor.carrier = true;
            carrier = targetActor;
          }
          events.push({ t: throwT + flight, type: 'catch' },
                      { t: endT, type: res.touchdown ? 'touchdown' : res.turnover ? 'turnover' : 'tackle' });
        } else {
          endT = throwT + flight + 0.35;
          events.push({ t: throwT + flight, type: res.drop ? 'drop' : 'incomplete' });
        }
        /* the coverage closes on the ball */
        actors.forEach(function (a) {
          if (a.side !== 'def' || a.blitz || a.pos === 'DL') return;
          var last = a.track[a.track.length - 1];
          if (dist(last, catchAt) > 22) return;
          trunc(a.track, throwT + flight + 0.12);
          a.track.push({ t: throwT + flight + 0.12, fx: (last.fx + catchAt.fx) / 2, fy: (last.fy + catchAt.fy) / 2 });
          a.track.push({ t: endT, fx: endFx - 0.8, fy: clampY(catchAt.fy * 0.6 + 0.8) });
        });
      }
    }

    /* the pursuit converges wherever it ended, and every track is checked
       for monotonic time — a frame is interpolated between keyframes, so one
       out of order is a player who jitters */
    actors.forEach(function (a) {
      var i;
      for (i = 1; i < a.track.length; i++) {
        if (a.track[i].t < a.track[i - 1].t) a.track[i].t = a.track[i - 1].t + 0.02;
      }
      var last = a.track[a.track.length - 1];
      if (last.t < endT) a.track.push({ t: endT, fx: last.fx, fy: last.fy });
      else endT = Math.max(endT, last.t);
    });

    /* NO PLAY TAKES LONGER THAN THIS. A trick play out of a deep drop with
       forty yards after the catch adds up to eight seconds of watching, which
       is a different game. Compressing the whole timeline keeps the football
       intact and the pacing honest. */
    var total = endT + 0.45, MAXD = 6.4;
    if (total > MAXD) {
      var k = MAXD / total;
      actors.forEach(function (a) { a.track.forEach(function (f) { f.t *= k; }); });
      ball.forEach(function (b) { b.t *= k; });
      events.forEach(function (e) { e.t *= k; });
      endT *= k; total = MAXD;
    }

    return { actors: actors, ball: ball, events: events,
             duration: total, snapT: snapT, endFx: endFx, endFy: endFy,
             offense: off, defense: def, play: playObj, parts: parts, result: res };
  }

  function clampY(y) { return Math.max(-25, Math.min(25, y)); }
  /* A ROUTE THAT IS STILL RUNNING WHEN THE BALL ARRIVES gets cut off there.
     Dropping the later keyframes rather than shifting them is the difference
     between a receiver who catches it where he is and one whose feet run
     backwards through time. */
  function trunc(track, t) {
    while (track.length > 1 && track[track.length - 1].t >= t) track.pop();
  }
  function dist(a, b) { return Math.sqrt(Math.pow(a.fx - b.fx, 2) + Math.pow(a.fy - b.fy, 2)); }
  function nearestDef(actors, at) {
    var best = null, bd = 1e9;
    actors.forEach(function (a) {
      if (a.side !== 'def') return;
      var d = dist(trackAt(a.track, 99), at);
      if (d < bd) { bd = d; best = a; }
    });
    return best;
  }
  /* linear interpolation along a track */
  function trackAt(track, t) {
    var i;
    if (t <= track[0].t) return { fx: track[0].fx, fy: track[0].fy };
    for (i = 1; i < track.length; i++) {
      if (t <= track[i].t) {
        var a = track[i - 1], b = track[i];
        var u = (b.t - a.t) < 1e-6 ? 1 : (t - a.t) / (b.t - a.t);
        u = u * u * (3 - 2 * u);                      /* ease, so nobody teleports */
        return { fx: a.fx + (b.fx - a.fx) * u, fy: a.fy + (b.fy - a.fy) * u };
      }
    }
    var l = track[track.length - 1];
    return { fx: l.fx, fy: l.fy };
  }

  /* ── THE FIELD ───────────────────────────────────────────────────────────
     Drawn once into a <g> that the camera translates, so panning is one
     transform rather than a redraw. `los` is the absolute yard line of the
     line of scrimmage, 0..100 from the offence's own goal line. */
  function fieldSvg(o) {
    o = o || {};
    var parts = [], y, n, i;
    /* the end zones plus a margin of turf behind each one, so a touchdown
       does not pan the camera into a black void behind the back line */
    var TOP = -22, BOT = 122;
    function Y(yard) { return (110 - yard) * U; } /* absolute yard → svg y */
    parts.push('<rect x="' + (-60) + '" y="' + Y(BOT) + '" width="' + (W + 120) + '" height="'
      + (BOT - TOP) * U + '" fill="#0c1d14"/>');
    parts.push('<rect x="0" y="' + Y(BOT) + '" width="' + W + '" height="' + (BOT - TOP) * U + '" fill="url(#turf)"/>');
    /* the back lines, so the end zone reads as a box rather than an edge */
    parts.push('<line x1="0" y1="' + Y(110) + '" x2="' + W + '" y2="' + Y(110)
      + '" stroke="rgba(255,255,255,.55)" stroke-width="3"/>');
    parts.push('<line x1="0" y1="' + Y(-10) + '" x2="' + W + '" y2="' + Y(-10)
      + '" stroke="rgba(255,255,255,.55)" stroke-width="3"/>');
    /* the sidelines, so the edge of the field reads as an edge */
    parts.push('<line x1="0" y1="' + Y(BOT) + '" x2="0" y2="' + Y(TOP) + '" stroke="rgba(255,255,255,.35)" stroke-width="3"/>');
    parts.push('<line x1="' + W + '" y1="' + Y(BOT) + '" x2="' + W + '" y2="' + Y(TOP) + '" stroke="rgba(255,255,255,.35)" stroke-width="3"/>');
    /* end zones */
    parts.push('<rect x="0" y="' + Y(110) + '" width="' + W + '" height="' + 10 * U + '" fill="var(--ez-away)" opacity=".85"/>');
    parts.push('<rect x="0" y="' + Y(10) + '" width="' + W + '" height="' + 10 * U + '" fill="var(--ez-home)" opacity=".85"/>');
    /* five-yard lines */
    for (n = 0; n <= 100; n += 5) {
      var major = n % 10 === 0;
      parts.push('<line x1="0" y1="' + Y(n) + '" x2="' + W + '" y2="' + Y(n) + '" stroke="rgba(255,255,255,'
        + (major ? '.42' : '.20') + ')" stroke-width="' + (major ? 2.4 : 1.6) + '"/>');
    }
    /* goal lines */
    parts.push('<line x1="0" y1="' + Y(0) + '" x2="' + W + '" y2="' + Y(0) + '" stroke="#fff" stroke-width="4"/>');
    parts.push('<line x1="0" y1="' + Y(100) + '" x2="' + W + '" y2="' + Y(100) + '" stroke="#fff" stroke-width="4"/>');
    /* numbers, both sidelines, upright on a vertical field */
    for (n = 10; n <= 90; n += 10) {
      var label = n <= 50 ? n : 100 - n;
      parts.push('<text class="fnum" x="' + (9 * U) + '" y="' + (Y(n) + 12) + '">' + label + '</text>');
      parts.push('<text class="fnum" x="' + (W - 9 * U) + '" y="' + (Y(n) + 12) + '">' + label + '</text>');
    }
    /* hash marks */
    for (n = 1; n < 100; n++) {
      if (n % 5 === 0) continue;
      [HALF - F.FIELD.hash * U, HALF + F.FIELD.hash * U].forEach(function (x) {
        parts.push('<line x1="' + (x - 5) + '" y1="' + Y(n) + '" x2="' + (x + 5) + '" y2="' + Y(n)
          + '" stroke="rgba(255,255,255,.28)" stroke-width="1.4"/>');
      });
    }
    return parts.join('');
  }

  /* ── THE RENDERER ────────────────────────────────────────────────────────
     Owns one <svg>, the camera, the pre-snap art and the animation loop. */
  function Renderer(host, opts) {
    opts = opts || {};
    var self = {};
    var svg, cam, playersG, artG, ballEl, fxG;
    var camYard = 25, dir = 1;                    /* dir: +1 offence attacks up */
    var raf = null, playing = null;
    var speed = opts.speed || 1;
    var showArt = opts.art !== false;
    var reduce = false;
    try { reduce = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) {}

    host.innerHTML =
      '<svg class="gr-svg" viewBox="' + (-MARGIN) + ' 0 ' + (W + MARGIN * 2) + ' ' + (VIEW * U) + '" '
      + 'preserveAspectRatio="xMidYMid slice" '
      + 'role="img" aria-label="Football field">'
      + '<defs>'
      + '<linearGradient id="turf" x1="0" y1="0" x2="0" y2="1">'
      + '<stop offset="0" stop-color="#153a26"/><stop offset=".5" stop-color="#12321f"/>'
      + '<stop offset="1" stop-color="#153a26"/></linearGradient>'
      + '<filter id="grsh" x="-40%" y="-40%" width="180%" height="180%">'
      + '<feDropShadow dx="0" dy="2.5" stdDeviation="2" flood-color="#000" flood-opacity=".55"/></filter>'
      + '</defs>'
      + '<g class="gr-cam">'
      + '<g class="gr-field">' + fieldSvg() + '</g>'
      + '<g class="gr-players"></g>'
      + '<g class="gr-art"></g>'
      + '<g class="gr-fx"></g>'
      + '</g></svg>';
    svg = host.querySelector('.gr-svg');
    cam = host.querySelector('.gr-cam');
    playersG = host.querySelector('.gr-players');
    artG = host.querySelector('.gr-art');
    fxG = host.querySelector('.gr-fx');

    /* absolute yard → svg y, and the offence's direction of travel */
    function absY(yard) { return (110 - yard) * U; }

    /* THE VIEWBOX IS THE DEVICE. A phone in portrait, a phone rotated, a
       tablet and a desktop all have different aspect ratios, and a fixed
       viewBox either crops the receivers off the sidelines or letterboxes the
       turf. So the box is computed from the element: full width always, and
       however many yards of depth that leaves. Recomputed on resize, because
       an address bar collapsing counts as a resize. */
    var viewH = VIEW * U;
    function resize() {
      var w = host.clientWidth, h = host.clientHeight;
      /* MEASURED BEFORE IT HAS A SIZE is the one way this goes wrong: the
         element is laid out a frame after the game screen is revealed, and a
         zero width silently becomes a seventy-yard camera. Wait for a real
         measurement rather than guessing at one. */
      if (!w || !h) { if (root.requestAnimationFrame) root.requestAnimationFrame(resize); return; }
      var boxW = W + MARGIN * 2;
      /* the depth window is whatever the shape of the element leaves, held
         between twenty-eight and fifty-six yards so the players are never
         specks and the routes are never off the top */
      viewH = Math.max(280, Math.min(560, Math.round(boxW * h / w)));
      svg.setAttribute('viewBox', (-MARGIN) + ' 0 ' + boxW + ' ' + viewH);
      camTo(camYard, false);
    }
    self.resize = resize;
    self.view = function () { return viewH / U; };

    function camTo(los, animate) {
      camYard = los;
      var target = absY(los) - viewH * LOS_AT;
      cam.style.transition = animate === false ? 'none' : 'transform .45s cubic-bezier(.4,0,.2,1)';
      cam.setAttribute('transform', 'translate(0,' + (-target) + ')');
    }
    /* field coords (offence-relative) → absolute svg */
    function fx2y(los, fx) { return absY(los + fx * dir); }
    function fy2x(fy) { return HALF + fy * U * dir; }

    self.setDirection = function (d) { dir = d >= 0 ? 1 : -1; };
    self.setSpeed = function (s) { speed = s; };
    self.setArt = function (v) { showArt = !!v; };
    self.camera = camTo;

    /* ── the markers: line of scrimmage and the chains ─────────────────── */
    var markG = null;
    self.markers = function (los, firstDown) {
      if (!markG) { markG = mk('g'); cam.insertBefore(markG, artG); }
      markG.innerHTML =
        '<line x1="0" y1="' + absY(los) + '" x2="' + W + '" y2="' + absY(los)
        + '" stroke="#5c9dff" stroke-width="3.2" opacity=".95"/>'
        + (firstDown != null && firstDown <= 100
          ? '<line x1="0" y1="' + absY(firstDown) + '" x2="' + W + '" y2="' + absY(firstDown)
            + '" stroke="#f2c744" stroke-width="3.2" opacity=".95"/>' : '');
    };

    /* ── PRE-SNAP: the twenty-two, and the play art over them ───────────── */
    self.preSnap = function (playKey, formKey, defCall, los, firstDown, teams, sit) {
      var playObj = F.play(playKey), parts = F.defParts(defCall);
      var strong = F.strongSide(parts.front.key + parts.coverage.key + parts.pressure.key + parts.fit.key,
                                sit || { ball: los, down: 1, toGo: 10 });
      var off = alignOffense(playObj, formKey), def = alignDefense(parts, playObj, strong);
      camTo(los);
      self.markers(los, firstDown);
      playersG.innerHTML = '';
      off.forEach(function (o) { playersG.appendChild(chip(o, 'off', los, teams)); });
      def.forEach(function (d) { playersG.appendChild(chip(d, 'def', los, teams)); });
      artG.innerHTML = showArt ? artFor(playObj, off, def, parts, los) : '';
      fxG.innerHTML = '';
      return { off: off, def: def, parts: parts, strong: strong };
    };

    function chip(p, side, los, teams) {
      var g = mk('g');
      g.setAttribute('class', 'gr-p gr-' + side + (p.blitz ? ' gr-blitz' : '') + (p.carrier ? ' gr-ball' : ''));
      g.setAttribute('transform', 'translate(' + fy2x(p.fy) + ',' + fx2y(los, p.fx) + ')');
      g.setAttribute('data-id', p.id || (side + '_' + p.slot));
      g.innerHTML = '<circle r="' + PR + '" class="gr-body" filter="url(#grsh)"/>'
        + '<circle r="' + (PR - 5) + '" class="gr-helm"/>'
        + '<text class="gr-num" y="4">' + esc(p.num == null ? '' : p.num) + '</text>';
      return g;
    }
    function mk(t) { return root.document.createElementNS('http://www.w3.org/2000/svg', t); }

    /* ── PLAY ART ────────────────────────────────────────────────────────
       Routes, the run path, blitz arrows and the coverage shells — the same
       diagram a coach draws, over the same players who are about to run it. */
    var artLane = 1;
    self.setLane = function (l) { artLane = l || 1; };
    function artFor(playObj, off, def, parts, los) {
      var out = [], i;
      if (playObj.type === 'pass') {
        off.forEach(function (o) {
          if (!o.route || o.route === 'block' || o.pos === 'OL') return;
          var path = routePath(o.route, o);
          var d = path.map(function (p, i2) {
            return (i2 ? 'L' : 'M') + fy2x(p.fy) + ',' + fx2y(los, p.fx);
          }).join(' ');
          out.push('<path class="gr-route" d="' + d + '"/>');
          var last = path[path.length - 1];
          out.push('<circle class="gr-route-end" cx="' + fy2x(last.fy) + '" cy="' + fx2y(los, last.fx) + '" r="4"/>');
        });
      } else {
        var laneW = playObj.concept === 'outside' ? 8 : playObj.concept === 'gap' ? 3.5 : 1;
        var lane = laneW * (artLane || 1);
        out.push('<path class="gr-run" d="M' + fy2x(0) + ',' + fx2y(los, -5)
          + ' Q' + fy2x(lane * 0.6) + ',' + fx2y(los, -1) + ' ' + fy2x(lane) + ',' + fx2y(los, 4)
          + ' L' + fy2x(lane * 1.1) + ',' + fx2y(los, 8) + '"/>');
      }
      /* blitzers get an arrow at the ball */
      def.forEach(function (d) {
        if (!d.blitz) return;
        out.push('<path class="gr-blitz-arrow" d="M' + fy2x(d.fy) + ',' + fx2y(los, d.fx)
          + ' L' + fy2x(d.fy * 0.3) + ',' + fx2y(los, -3) + '"/>');
      });
      /* the coverage shell: where the deep help actually is */
      var cov = parts.coverage;
      var deep = cov.key === 'cover0' ? 0 : cov.key === 'cover1' || cov.key === 'cover3' ? (cov.key === 'cover3' ? 3 : 1)
               : cov.key === 'cover4' || cov.key === 'cover6' ? 4 : 2;
      if (deep > 0) {
        var wdt = W / deep;
        for (i = 0; i < deep; i++) {
          out.push('<rect class="gr-zone" x="' + (i * wdt + 4) + '" y="' + fx2y(los, 30)
            + '" width="' + (wdt - 8) + '" height="' + (18 * U) + '" rx="8"/>');
        }
      }
      return out.join('');
    }

    /* ── THE ANIMATION ───────────────────────────────────────────────────── */
    self.animate = function (res, los, firstDown, teams, done) {
      var plan = choreograph(res);
      camTo(los);
      self.markers(los, firstDown);
      playersG.innerHTML = '';
      artG.innerHTML = '';
      fxG.innerHTML = '';
      var nodes = {};
      plan.actors.forEach(function (a) {
        var el = chip({ fx: a.track[0].fx, fy: a.track[0].fy, num: a.num, blitz: a.blitz, id: a.id },
                      a.side, los, teams);
        playersG.appendChild(el);
        nodes[a.id] = el;
      });
      ballEl = mk('g');
      ballEl.setAttribute('class', 'gr-ballobj');
      ballEl.innerHTML = '<ellipse rx="5.5" ry="3.6" class="gr-ballsh"/>';
      fxG.appendChild(ballEl);

      var dur = plan.duration / Math.max(0.25, speed);
      if (reduce) dur = Math.min(dur, 0.6);
      var t0 = null, fired = {};
      cancel();
      function frame(ts) {
        if (t0 == null) t0 = ts;
        var el = (ts - t0) / 1000, t = el * Math.max(0.25, speed);
        if (reduce) t = plan.duration * Math.min(1, el / 0.6);
        var i;
        for (i = 0; i < plan.actors.length; i++) {
          var a = plan.actors[i], p = trackAt(a.track, t), n = nodes[a.id];
          if (n) n.setAttribute('transform', 'translate(' + fy2x(p.fy) + ',' + fx2y(los, p.fx) + ')');
          if (a.carrier && n && !n.classList.contains('gr-ball')) n.classList.add('gr-ball');
        }
        /* the ball */
        var b = ballAt(plan, t, nodes, los);
        if (b) {
          ballEl.setAttribute('transform', 'translate(' + fy2x(b.fy) + ',' + fx2y(los, b.fx) + ')');
          ballEl.style.opacity = b.hidden ? 0 : 1;
        }
        /* camera follows the ball downfield once it is moving */
        var lead = trackAt(carrierTrack(plan), t);
        if (lead) camTo(clamp01(los + lead.fx * 0.75), false);
        /* events */
        for (i = 0; i < plan.events.length; i++) {
          var ev = plan.events[i];
          if (t >= ev.t && !fired[i]) { fired[i] = 1; if (opts.onEvent) opts.onEvent(ev.type, res); }
        }
        if (t < plan.duration) raf = root.requestAnimationFrame(frame);
        else { raf = null; if (done) done(plan); }
      }
      raf = root.requestAnimationFrame(frame);
      playing = plan;
      return plan;
    };
    function clamp01(v) { return Math.max(-5, Math.min(105, v)); }
    function carrierTrack(plan) {
      var c = plan.actors.filter(function (a) { return a.carrier; })[0];
      return c ? c.track : [{ t: 0, fx: 0, fy: 0 }];
    }
    function ballAt(plan, t, nodes, los) {
      var b = plan.ball, i;
      if (!b || !b.length) return null;
      if (b.length === 1 && b[0].hidden) {
        var c = carrierTrack(plan);
        return trackAt(c, t);
      }
      if (t < b[1].t) {
        var q = trackAt(plan.actors.filter(function (a) { return a.slot === 'QB'; })[0].track, t);
        return q;
      }
      for (i = 2; i < b.length; i++) {
        if (t <= b[i].t) {
          var a0 = b[i - 1], b1 = b[i];
          var u = (t - a0.t) / Math.max(0.001, b1.t - a0.t);
          return { fx: a0.fx + (b1.fx - a0.fx) * u, fy: a0.fy + (b1.fy - a0.fy) * u };
        }
      }
      var c2 = carrierTrack(plan);
      return trackAt(c2, t);
    }
    function cancel() { if (raf) { root.cancelAnimationFrame(raf); raf = null; } }
    self.skip = function () {
      cancel();
      if (playing && opts.onEvent) {
        playing.events.forEach(function (e) { opts.onEvent(e.type, playing.result); });
      }
      return playing;
    };
    self.stop = cancel;
    resize();
    if (root.ResizeObserver) {
      try { new root.ResizeObserver(function () { resize(); }).observe(host); } catch (_) {}
    }
    if (root.addEventListener) {
      root.addEventListener('resize', resize);
      root.addEventListener('orientationchange', function () { root.setTimeout(resize, 250); });
    }
    self.flash = function (kind, text) {
      var d = root.document.createElement('div');
      d.className = 'gr-flash gr-flash-' + kind;
      d.textContent = text;
      host.appendChild(d);
      root.setTimeout(function () { d.classList.add('out'); }, 900);
      root.setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 1500);
    };
    return self;
  }

  var API = { U: U, W: W, VIEW: VIEW, MARGIN: MARGIN, PR: PR,
    alignOffense: alignOffense, alignDefense: alignDefense, routePath: routePath,
    choreograph: choreograph, trackAt: trackAt, fieldSvg: fieldSvg, Renderer: Renderer };
  root.EDGridironRender = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
