/* ===========================================================================
   GRIDIRON — the artist.

   Everything you can see, drawn procedurally onto a 2D canvas: the stadium,
   the turf, the markings, the ball, and TWENTY-TWO FOOTBALL PLAYERS with
   helmets, shoulder pads, jerseys, numbers, arms and legs that move.

   Why canvas and not SVG: the old renderer moved a few dozen DOM nodes per
   frame and, at the size a phone can show, a player could only ever be a
   circle with a number in it. A canvas redraws the whole scene every frame
   for the same cost, which buys legs that run, pads that collide, a camera
   that follows the ball, and a player you can tell apart from a token.

   Why procedural and not sprite sheets: a sprite sheet is a download, a
   licence and a pixel budget. These are a few dozen paths. They scale to any
   screen, take the team's own colours, and weigh nothing.

   NOTHING HERE DECIDES ANYTHING. Give it a position and a state and it draws
   what that looks like.

   ── COORDINATES ────────────────────────────────────────────────────────────
   The world is in YARDS. x runs across the field, 0 at the offence's left
   sideline to 53.33 at its right. y runs UP the field, 0 at the offence's own
   goal line to 100 at the one it is attacking (end zones reach to ±10).

   The camera projects that to the screen with a vertical squash, which is the
   whole 2.5D trick: the field lies away from you, the players stand up on it.
   =========================================================================== */
(function (root) {
  'use strict';

  var FIELD = { width: 53.33, half: 26.665, length: 100, endzone: 10, hash: 20 };

  /* ── THE CAMERA ──────────────────────────────────────────────────────────
     A window on the field: where it is looking, how close, and how hard the
     ground is tilted away. `squash` under one is what makes the turf recede.  */
  /* TWO ZOOMS, NOT ONE. A football field is fifty-three yards wide and a
     phone is three hundred and ninety pixels across: drawn to scale, everybody
     is a speck. So the width and the depth are scaled INDEPENDENTLY — which is
     what a camera behind the end zone does to a real field, and why a
     broadcast shot is legible where an overhead one is not.

       zoomX   pixels per yard ACROSS — set by how much width has to be in shot
       zoomY   pixels per yard DEEP   — set by how much field, and how big a man

     Players are drawn at zoomY, so their size follows the depth of the shot.  */
  function camera(o) {
    o = o || {};
    var c = {
      x: o.x == null ? FIELD.half : o.x,
      y: o.y == null ? 25 : o.y,
      zoomX: o.zoomX || 8,
      zoomY: o.zoomY || 12,
      w: o.w || 390, h: o.h || 300,
      /* the line of scrimmage sits below the middle, so there is field ahead */
      anchor: o.anchor == null ? 0.60 : o.anchor
    };
    /* `zoom` is the depth scale: what a body is measured in */
    Object.defineProperty(c, 'zoom', {
      get: function () { return c.zoomY; },
      set: function (v) { c.zoomY = v; }
    });
    c.sx = function (x) { return c.w / 2 + (x - c.x) * c.zoomX; };
    c.sy = function (y) { return c.h * c.anchor - (y - c.y) * c.zoomY; };
    /* nearer the bottom of the screen is nearer the camera */
    c.depth = function (sy) { return 0.86 + 0.22 * Math.max(0, Math.min(1, sy / c.h)); };
    /* how many yards are in shot, each way */
    c.wideYards = function () { return c.w / c.zoomX; };
    c.deepYards = function () { return c.h / c.zoomY; };
    return c;
  }

  /* ── UNIFORMS ────────────────────────────────────────────────────────────
     A team's kit from its franchise theme. Never two teams in the same
     colours: the away side darkens and desaturates until it cannot be
     mistaken for the home one. */
  function uniform(theme, away) {
    var t = theme || {};
    var p = t.primary || '#3fb883', s = t.secondary || '#123326', ink = t.ink || '#06231a';
    if (away) {
      return { jersey: '#e8ecf2', jerseyDark: '#c6ccd6', pants: '#dfe4ec',
               helmet: p, helmetDark: shade(p, -0.35), trim: p, ink: '#1a2029',
               sleeve: p, sock: p };
    }
    return { jersey: p, jerseyDark: shade(p, -0.30), pants: shade(p, -0.55),
             helmet: shade(p, -0.12), helmetDark: shade(p, -0.45), trim: '#ffffff',
             ink: readable(p), sleeve: shade(p, -0.42), sock: '#ffffff' };
  }
  /* a colour, whatever form it arrives in — shade() returns rgb() strings and
     they get shaded again, so this has to read its own output */
  function hex(c) {
    c = String(c == null ? '#000' : c).trim();
    var m = c.match(/^rgba?\(([^)]+)\)$/i);
    if (m) {
      var p2 = m[1].split(',');
      return [parseInt(p2[0], 10) || 0, parseInt(p2[1], 10) || 0, parseInt(p2[2], 10) || 0];
    }
    c = c.replace('#', '');
    if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
    if (!/^[0-9a-f]{6}$/i.test(c)) return [63, 184, 131];
    return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
  }
  function shade(c, amt) {
    var v = hex(c), i;
    for (i = 0; i < 3; i++) v[i] = Math.round(Math.max(0, Math.min(255, v[i] + amt * (amt < 0 ? v[i] : 255 - v[i]))));
    return 'rgb(' + v[0] + ',' + v[1] + ',' + v[2] + ')';
  }
  function readable(c) {
    var v = hex(c);
    return (v[0] * 299 + v[1] * 587 + v[2] * 114) / 1000 > 150 ? '#101418' : '#ffffff';
  }
  function rgba(c, a) { var v = hex(c); return 'rgba(' + v[0] + ',' + v[1] + ',' + v[2] + ',' + a + ')'; }

  /* ── BUILD ───────────────────────────────────────────────────────────────
     A lineman is not a corner. Position decides how wide the pads are, how
     thick the body is and how tall the whole man stands. */
  var BUILD = {
    QB: { w: 1.00, h: 1.00, pads: 1.00 },
    RB: { w: 1.02, h: 0.96, pads: 1.02 },
    FB: { w: 1.10, h: 0.98, pads: 1.10 },
    WR: { w: 0.88, h: 1.02, pads: 0.90 },
    TE: { w: 1.08, h: 1.04, pads: 1.10 },
    OL: { w: 1.06, h: 1.02, pads: 1.12 },
    DL: { w: 1.08, h: 1.02, pads: 1.14 },
    LB: { w: 1.10, h: 1.00, pads: 1.12 },
    CB: { w: 0.86, h: 0.99, pads: 0.88 },
    S:  { w: 0.92, h: 1.00, pads: 0.94 },
    K:  { w: 0.95, h: 0.98, pads: 0.95 },
    P:  { w: 0.95, h: 0.98, pads: 0.95 }
  };
  function build(pos) { return BUILD[pos] || BUILD.LB; }

  /* the height of a man on the field, in yards, before his build */
  var BODY = 2.6;

  /* ── ONE FOOTBALL PLAYER ─────────────────────────────────────────────────
     p: { x, y, pos, kit, num, state, phase, face, lean, sel, down }
       state  stance | run | block | engaged | shed | tackle | down | catch
              | throw | carry | celebrate | idle
       phase  seconds of animation, for the running cycle
       face   -1 .. 1 lateral facing, and `back` when running away from camera */
  function player(ctx, p, cam) {
    var sx = cam.sx(p.x), sy = cam.sy(p.y);
    if (sx < -60 || sx > cam.w + 60 || sy < -70 || sy > cam.h + 70) return;
    var b = build(p.pos), k = p.kit || uniform(null);
    var u = cam.zoom * cam.depth(sy) * (p.scale || 1);      /* pixels per yard here */
    var H = BODY * b.h * u;                                  /* pixel height */
    var down = p.state === 'down';
    var run = p.state === 'run' || p.state === 'carry' || p.state === 'shed';
    var ph = p.phase || 0;
    var cyc = run ? Math.sin(ph * 13) : p.state === 'engaged' ? Math.sin(ph * 22) * 0.35 : 0;
    var lean = (p.lean || 0) + (run ? 0.10 : 0);
    var back = p.face === 'back';

    ctx.save();
    ctx.translate(sx, sy);

    /* the shadow stays on the ground whatever the body does */
    ctx.save();
    ctx.scale(1, 0.36);
    ctx.beginPath();
    ctx.arc(0, 0, H * 0.30, 0, 6.2832);
    ctx.fillStyle = 'rgba(0,0,0,.34)';
    ctx.fill();
    ctx.restore();

    if (down) {
      /* on the ground: the whole body laid over, seen from above */
      ctx.rotate((p.fell || 1) * 1.35);
      ctx.scale(1, 0.55);
    } else {
      ctx.rotate(lean * 0.28);
    }

    var pw = H * 0.40 * b.w;          /* body half-width */
    var padW = H * 0.345 * b.pads;    /* shoulder half-width */
    var hipY = -H * 0.44;
    var shoY = -H * 0.80;
    var headY = -H * 1.00;

    /* ── LEGS ──────────────────────────────────────────────────────────── */
    var swing = cyc * H * 0.20;
    leg(ctx, -pw * 0.42, hipY, H, k, swing, u);
    leg(ctx, pw * 0.42, hipY, H, k, -swing, u);

    /* ── PANTS ─────────────────────────────────────────────────────────── */
    ctx.fillStyle = k.pants;
    roundRect(ctx, -pw * 0.74, hipY - H * 0.06, pw * 1.48, H * 0.26, H * 0.07);
    ctx.fill();

    /* ── TORSO / JERSEY ────────────────────────────────────────────────── */
    var g = ctx.createLinearGradient(0, shoY, 0, hipY);
    g.addColorStop(0, k.jersey);
    g.addColorStop(1, k.jerseyDark);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-padW * 0.92, shoY + H * 0.04);
    ctx.lineTo(padW * 0.92, shoY + H * 0.04);
    ctx.lineTo(pw * 0.80, hipY);
    ctx.lineTo(-pw * 0.80, hipY);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.38)';
    ctx.lineWidth = Math.max(0.8, H * 0.016);
    ctx.stroke();

    /* the number, on the back if he is running away from you */
    if (p.num != null && H > 24) {
      var txt = String(p.num);
      var fs = Math.min(H * 0.235, (padW * 1.55) / Math.max(1, txt.length) * 1.35);
      ctx.fillStyle = k.ink;
      ctx.font = '700 ' + Math.round(fs) + 'px "JetBrains Mono", ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(txt, 0, shoY + H * 0.26);
    }

    /* ── ARMS ──────────────────────────────────────────────────────────── */
    var armState = p.state;
    arm(ctx, -1, padW, shoY, H, k, armState, cyc, p);
    arm(ctx, 1, padW, shoY, H, k, armState, -cyc, p);

    /* ── SHOULDER PADS ─────────────────────────────────────────────────── */
    ctx.fillStyle = k.jersey;
    roundRect(ctx, -padW, shoY - H * 0.05, padW * 2, H * 0.17, H * 0.075);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.40)';
    ctx.lineWidth = Math.max(0.8, H * 0.018);
    ctx.stroke();
    ctx.fillStyle = rgba(k.trim === '#ffffff' ? '#ffffff' : k.trim, 0.85);
    roundRect(ctx, -padW, shoY - H * 0.05, padW * 2, H * 0.035, H * 0.02);
    ctx.fill();

    /* ── HELMET ────────────────────────────────────────────────────────── */
    var hr = H * 0.185;
    var hg = ctx.createRadialGradient(-hr * 0.35, headY - hr * 0.35, hr * 0.15, 0, headY, hr * 1.15);
    hg.addColorStop(0, shade(k.helmet, 0.35));
    hg.addColorStop(1, k.helmetDark);
    ctx.fillStyle = hg;
    ctx.beginPath();
    ctx.arc(0, headY, hr, 0, 6.2832);
    ctx.fill();
    /* a rim, so the helmet reads as a helmet and not as a head */
    ctx.strokeStyle = 'rgba(0,0,0,.42)';
    ctx.lineWidth = Math.max(0.8, hr * 0.13);
    ctx.beginPath(); ctx.arc(0, headY, hr, 0, 6.2832); ctx.stroke();
    /* the stripe down the crown */
    ctx.fillStyle = rgba(k.trim, 0.92);
    roundRect(ctx, -hr * 0.17, headY - hr, hr * 0.34, hr * (back ? 1.55 : 0.85), hr * 0.16);
    ctx.fill();
    if (!back) {
      /* the facemask, pointing the way he is looking */
      var fx = (p.face === 'left' ? -1 : p.face === 'right' ? 1 : 0);
      ctx.strokeStyle = 'rgba(232,238,246,.95)';
      ctx.lineWidth = Math.max(1.1, hr * 0.16);
      ctx.beginPath();
      ctx.arc(fx * hr * 0.30, headY + hr * 0.26, hr * 0.66, 0.12, Math.PI - 0.12);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-hr * 0.55 + fx * hr * 0.30, headY + hr * 0.34);
      ctx.lineTo(hr * 0.55 + fx * hr * 0.30, headY + hr * 0.34);
      ctx.stroke();
    }

    /* the ring at his feet: who you are steering, and who has the football */
    if (p.sel || p.carry) {
      ctx.save();
      ctx.scale(1, 0.36);
      ctx.beginPath();
      ctx.arc(0, 0, H * 0.40, 0, 6.2832);
      ctx.strokeStyle = p.carry ? 'rgba(255,255,255,.95)' : (p.selColor || '#f2c744');
      ctx.lineWidth = Math.max(2, H * 0.065);
      ctx.stroke();
      if (p.carry) {
        ctx.beginPath();
        ctx.arc(0, 0, H * 0.40, 0, 6.2832);
        ctx.strokeStyle = 'rgba(242,199,68,.75)';
        ctx.lineWidth = Math.max(1, H * 0.03);
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.restore();
  }

  function leg(ctx, dx, hipY, H, k, swing, u) {
    ctx.save();
    ctx.translate(dx, hipY);
    ctx.rotate(swing * 0.06);
    ctx.fillStyle = k.pants;
    roundRect(ctx, -H * 0.075, 0, H * 0.15, H * 0.30, H * 0.06);
    ctx.fill();
    ctx.fillStyle = k.sock;
    roundRect(ctx, -H * 0.065, H * 0.28, H * 0.13, H * 0.13, H * 0.05);
    ctx.fill();
    ctx.fillStyle = '#14181f';
    roundRect(ctx, -H * 0.075, H * 0.39, H * 0.16, H * 0.06, H * 0.03);
    ctx.fill();
    ctx.restore();
  }

  function arm(ctx, side, padW, shoY, H, k, state, cyc, p) {
    ctx.save();
    ctx.translate(side * padW * 0.86, shoY + H * 0.05);
    var rot;
    if (state === 'block' || state === 'engaged') rot = side * -1.15;
    else if (state === 'tackle') rot = side * -0.95;
    else if (state === 'catch') rot = side * -1.55;
    else if (state === 'celebrate') rot = side * -2.05;
    else if (state === 'throw') rot = side === (p.hand || 1) ? -2.2 * side : side * -0.5;
    else rot = side * (0.18 + cyc * 0.55);
    ctx.rotate(rot);
    ctx.fillStyle = k.sleeve;
    roundRect(ctx, -H * 0.058, 0, H * 0.116, H * 0.22, H * 0.05);
    ctx.fill();
    ctx.fillStyle = rgba(k.trim, 0.75);
    roundRect(ctx, -H * 0.058, H * 0.10, H * 0.116, H * 0.028, H * 0.014);
    ctx.fill();
    ctx.fillStyle = '#c8a487';
    roundRect(ctx, -H * 0.05, H * 0.20, H * 0.10, H * 0.16, H * 0.045);
    ctx.fill();
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ── THE BALL ────────────────────────────────────────────────────────── */
  function ball(ctx, b, cam) {
    var sx = cam.sx(b.x), sy = cam.sy(b.y);
    var u = cam.zoom * cam.depth(sy);
    var z = (b.z || 0) * u * 0.9;
    /* its shadow stays on the ground and shrinks as it climbs */
    ctx.save();
    ctx.translate(sx, sy);
    ctx.scale(1, 0.34);
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(1.5, u * 0.18 - z * 0.02), 0, 6.2832);
    ctx.fillStyle = 'rgba(0,0,0,.3)';
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.translate(sx, sy - u * 0.55 - z);
    ctx.rotate(b.spin || -0.5);
    var r = u * 0.19;
    var g = ctx.createLinearGradient(-r, -r, r, r);
    g.addColorStop(0, '#a9622c');
    g.addColorStop(0.5, '#c9803c');
    g.addColorStop(1, '#8d4f22');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(0, 0, r, r * 0.62, 0, 0, 6.2832);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,248,238,.9)';
    ctx.lineWidth = Math.max(0.8, r * 0.13);
    ctx.beginPath();
    ctx.moveTo(-r * 0.42, 0); ctx.lineTo(r * 0.42, 0);
    ctx.stroke();
    ctx.restore();
  }

  /* ── THE FIELD ───────────────────────────────────────────────────────────
     Turf, mow stripes, every marking a broadcast shows, both end zones in the
     teams' own colours, and a stand of crowd behind the far one. */
  function field(ctx, cam, o) {
    o = o || {};
    var W = cam.w, H = cam.h;
    var left = cam.sx(0), right = cam.sx(FIELD.width);

    /* the sky and the stands, behind everything */
    var topY = cam.sy(FIELD.length + FIELD.endzone);
    if (topY > -40) {
      var sg = ctx.createLinearGradient(0, Math.max(0, topY - H * 0.5), 0, topY);
      sg.addColorStop(0, '#0a0e14');
      sg.addColorStop(1, '#161d27');
      ctx.fillStyle = sg;
      ctx.fillRect(0, 0, W, Math.max(0, topY));
      crowd(ctx, 0, Math.max(0, topY - H * 0.30), W, Math.min(H * 0.30, topY), o.tick || 0);
    }

    /* the turf, with mow stripes every five yards */
    var y0 = cam.sy(FIELD.length + FIELD.endzone), y1 = cam.sy(-FIELD.endzone);
    ctx.fillStyle = '#0d2417';
    ctx.fillRect(0, Math.max(0, y0), W, Math.min(H, y1) - Math.max(0, y0));
    var n;
    for (n = -10; n < 110; n += 5) {
      var a = cam.sy(n + 5), b2 = cam.sy(n);
      if (b2 < -20 || a > H + 20) continue;
      ctx.fillStyle = ((n + 10) / 5) % 2 === 0 ? '#15361f' : '#123019';
      ctx.fillRect(Math.max(-40, left), a, Math.min(W + 80, right - left), b2 - a);
    }

    /* the end zones, in the two teams' colours */
    endzone(ctx, cam, 100, 110, o.homeColor || '#123326', o.homeName || '', false);
    endzone(ctx, cam, -10, 0, o.awayColor || '#2a1a2f', o.awayName || '', true);

    /* yard lines */
    ctx.lineCap = 'butt';
    for (n = 0; n <= 100; n += 5) {
      var sy = cam.sy(n);
      if (sy < -10 || sy > H + 10) continue;
      var major = n % 10 === 0;
      ctx.strokeStyle = major ? 'rgba(255,255,255,.52)' : 'rgba(255,255,255,.26)';
      ctx.lineWidth = major ? 2.2 : 1.5;
      ctx.beginPath(); ctx.moveTo(left, sy); ctx.lineTo(right, sy); ctx.stroke();
    }
    /* goal lines and the back lines */
    [0, 100].forEach(function (g2) {
      var sy = cam.sy(g2);
      if (sy < -10 || sy > H + 10) return;
      ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.lineWidth = 3.4;
      ctx.beginPath(); ctx.moveTo(left, sy); ctx.lineTo(right, sy); ctx.stroke();
    });
    /* sidelines */
    ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(left, cam.sy(110)); ctx.lineTo(left, cam.sy(-10));
    ctx.moveTo(right, cam.sy(110)); ctx.lineTo(right, cam.sy(-10)); ctx.stroke();

    /* hash marks, every yard — thinned out when the camera is a long way off,
       because a hundred of them is a ladder rather than a field */
    ctx.strokeStyle = 'rgba(255,255,255,.30)'; ctx.lineWidth = 1.5;
    var every = cam.zoom < 11 ? 5 : cam.zoom < 15 ? 2 : 1;
    for (n = 1; n < 100; n++) {
      if (n % 5 === 0) continue;
      if (every > 1 && n % every !== 0) continue;
      var hy = cam.sy(n);
      if (hy < -6 || hy > H + 6) continue;
      var tick = cam.zoom * 0.55;
      [FIELD.half - 6.17, FIELD.half + 6.17].forEach(function (hx) {
        var x = cam.sx(hx);
        ctx.beginPath(); ctx.moveTo(x - tick, hy); ctx.lineTo(x + tick, hy); ctx.stroke();
      });
      [cam.sx(1.5), cam.sx(FIELD.width - 1.5)].forEach(function (x) {
        ctx.beginPath(); ctx.moveTo(x - tick, hy); ctx.lineTo(x + tick, hy); ctx.stroke();
      });
    }

    /* the numbers, upright, both sides, with the little direction arrow */
    ctx.font = '800 ' + Math.round(cam.zoom * 1.9) + 'px "Space Grotesk", Inter, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (n = 10; n <= 90; n += 10) {
      var ny = cam.sy(n);
      if (ny < -20 || ny > H + 20) continue;
      var label = n <= 50 ? n : 100 - n;
      ctx.fillStyle = 'rgba(255,255,255,.34)';
      [cam.sx(8), cam.sx(FIELD.width - 8)].forEach(function (x, i) {
        ctx.save();
        ctx.translate(x, ny);
        ctx.scale(1, 0.86);
        ctx.fillText(String(label), 0, 0);
        if (n !== 50) {
          ctx.beginPath();
          var dir = n < 50 ? 1 : -1, ax = (i ? 1 : -1) * cam.zoom * 1.5;
          ctx.moveTo(ax, dir * cam.zoom * 0.55);
          ctx.lineTo(ax + cam.zoom * 0.5, 0);
          ctx.lineTo(ax, -dir * cam.zoom * 0.55);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
      });
    }
  }

  function endzone(ctx, cam, from, to, color, name, flip) {
    var a = cam.sy(to), b = cam.sy(from), H = cam.h;
    if (b < -30 || a > H + 30) return;
    var left = cam.sx(0), right = cam.sx(FIELD.width);
    var g = ctx.createLinearGradient(0, a, 0, b);
    g.addColorStop(0, shade(color, -0.25));
    g.addColorStop(0.5, color);
    g.addColorStop(1, shade(color, -0.25));
    ctx.fillStyle = g;
    ctx.fillRect(left, Math.min(a, b), right - left, Math.abs(b - a));
    if (name) {
      ctx.save();
      ctx.translate((left + right) / 2, (a + b) / 2);
      if (flip) ctx.rotate(Math.PI);
      ctx.scale(1, 0.62);
      ctx.font = '800 ' + Math.round(cam.zoom * 2.5) + 'px "Space Grotesk", Inter, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(255,255,255,.30)';
      ctx.fillText(String(name).toUpperCase(), 0, 0);
      ctx.restore();
    }
    /* pylons */
    [0, FIELD.width].forEach(function (px) {
      [from, to].forEach(function (py) {
        var x = cam.sx(px), y = cam.sy(py);
        ctx.fillStyle = '#f4a23a';
        ctx.fillRect(x - 1.6, y - cam.zoom * 0.5, 3.2, cam.zoom * 0.5);
      });
    });
  }

  /* a band of crowd: cheap, static, and enough to say "stadium" */
  var CROWD = null;
  function crowd(ctx, x, y, w, h, tick) {
    if (h <= 2) return;
    if (!CROWD || CROWD.w !== Math.round(w) || CROWD.h !== Math.round(h)) {
      CROWD = { w: Math.round(w), h: Math.round(h), dots: [] };
      var seed = 12345, i;
      function r() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
      for (i = 0; i < 520; i++) {
        CROWD.dots.push([r(), r(), r()]);
      }
    }
    var g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, '#0e131a');
    g.addColorStop(1, '#1c242f');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    var i2;
    for (i2 = 0; i2 < CROWD.dots.length; i2++) {
      var d = CROWD.dots[i2];
      var cy = y + h * (0.12 + d[1] * 0.84);
      var sway = Math.sin(tick * 0.9 + d[0] * 30) * 0.7;
      ctx.fillStyle = 'rgba(' + Math.round(120 + d[2] * 110) + ',' + Math.round(125 + d[2] * 100)
        + ',' + Math.round(140 + d[2] * 90) + ',' + (0.16 + d[2] * 0.26) + ')';
      ctx.fillRect(x + w * d[0] + sway, cy, 2.1, 2.6);
    }
    ctx.fillStyle = 'rgba(0,0,0,.45)';
    ctx.fillRect(x, y + h - 4, w, 4);
  }

  /* ── MARKERS: the line of scrimmage and the chains ─────────────────────── */
  function markers(ctx, cam, los, firstDown) {
    var left = cam.sx(-1.2), right = cam.sx(FIELD.width + 1.2);
    function line(y, color, wdt) {
      var sy = cam.sy(y);
      if (sy < -8 || sy > cam.h + 8) return;
      ctx.strokeStyle = color; ctx.lineWidth = wdt;
      ctx.beginPath(); ctx.moveTo(left, sy); ctx.lineTo(right, sy); ctx.stroke();
    }
    if (firstDown != null && firstDown <= 100) line(firstDown, 'rgba(242,199,68,.92)', 3.2);
    line(los, 'rgba(92,157,255,.92)', 3.2);
  }

  /* ── PLAY ART: routes, the run path and blitz arrows ──────────────────── */
  function art(ctx, cam, paths) {
    if (!paths || !paths.length) return;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    paths.forEach(function (p) {
      if (!p.pts || p.pts.length < 2) return;
      ctx.strokeStyle = p.color || 'rgba(255,255,255,.78)';
      ctx.lineWidth = p.width || 2.4;
      ctx.setLineDash(p.dash === false ? [] : [7, 5]);
      ctx.beginPath();
      p.pts.forEach(function (q, i) {
        var x = cam.sx(q[0]), y = cam.sy(q[1]);
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
      var last = p.pts[p.pts.length - 1], prev = p.pts[p.pts.length - 2];
      if (p.arrow !== false) arrowHead(ctx, cam, prev, last, p.color || 'rgba(255,255,255,.85)');
    });
  }
  function arrowHead(ctx, cam, a, b, color) {
    var x1 = cam.sx(a[0]), y1 = cam.sy(a[1]), x2 = cam.sx(b[0]), y2 = cam.sy(b[1]);
    var ang = Math.atan2(y2 - y1, x2 - x1), s = 7;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - s * Math.cos(ang - 0.45), y2 - s * Math.sin(ang - 0.45));
    ctx.lineTo(x2 - s * Math.cos(ang + 0.45), y2 - s * Math.sin(ang + 0.45));
    ctx.closePath(); ctx.fill();
  }

  var API = {
    FIELD: FIELD, BODY: BODY, BUILD: BUILD,
    camera: camera, uniform: uniform, shade: shade, readable: readable, rgba: rgba,
    player: player, ball: ball, field: field, markers: markers, art: art, roundRect: roundRect
  };
  root.EDGridironPaint = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
