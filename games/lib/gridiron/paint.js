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
     A BROADCAST CAMERA, NOT A BLUEPRINT.

     It stands in the stand behind the offence, `back` yards behind whatever
     it is watching and `height` yards above the turf, tilted down at the
     field. A point on the ground `u` yards in front of it lands at

         sy = horizon + f · (height − z) / u
         sx = w/2 + squeeze · f · (x − focusX) / u

     which is an honest perspective divide, and it buys everything a diagram
     cannot have: the far sideline leans in towards the near one, the yard
     lines bunch as they run away, the numbers on the far thirty are smaller
     than the ones on the near thirty, and a safety forty yards downfield is
     half the size of the back carrying the ball at your feet.

     `squeeze` is the one lie. A field is fifty-three yards across and a
     phone is three hundred and ninety pixels; drawn honestly, either the
     players are specks or the sidelines are off screen. So the horizontal
     axis is squashed — an anamorphic lens — which keeps the men full size
     while the width still fits. Every real broadcast lens does a gentler
     version of the same thing.

     Two knobs, and the stage turns them per shot:
       wide   yards across the screen AT THE FOCUS (how tight the shot is)
       px     pixels per yard of standing man AT THE FOCUS (how big he is)  */
  function camera(o) {
    o = o || {};
    var c = {
      x: o.x == null ? FIELD.half : o.x,        /* the point it is watching */
      y: o.y == null ? 25 : o.y,
      /* A LONG LENS, NOT A FISHEYE. A broadcast camera is a long way off
         with a long focal length: the far men are smaller than the near ones,
         but only by about half, not by a factor of five. Standing it close to
         the play instead turns a football field into a bowling alley. */
      back: o.back == null ? 53 : o.back,       /* yards behind that point */
      height: o.height == null ? 68 : o.height, /* yards above the turf */
      px: o.px || 13,                           /* px per yard of man, at the focus */
      wide: o.wide || 36,                       /* yards across, at the focus */
      w: o.w || 390, h: o.h || 300,
      anchor: o.anchor == null ? 0.60 : o.anchor,
      near: 16                                  /* nothing may come closer */
    };
    /* focal length, in pixel·yards */
    c.f = function () { return c.px * c.back; };
    /* the anamorphic squash, kept inside honest bounds. Past about a third
       either way the field stops reading as a field, so the shot gives up a
       little of its intended width rather than distort. */
    c.squeeze = function () {
      var q = c.w / Math.max(1, c.wide * c.px);
      return q < 0.62 ? 0.62 : q > 1.06 ? 1.06 : q;
    };
    /* where the ground runs out. Above this line is sky. */
    c.horizon = function () { return c.h * c.anchor - c.px * c.height; };
    /* how far in front of the lens a given yard line is */
    c.u = function (y) { return Math.max(c.near, y - (c.y - c.back)); };
    /* pixels per yard of HEIGHT at that depth — how big a man there is */
    c.scale = function (y) { return c.f() / c.u(y); };
    c.sx = function (x, y) { return c.w / 2 + c.squeeze() * c.f() * (x - c.x) / c.u(y); };
    c.sy = function (y, z) { return c.horizon() + c.f() * (c.height - (z || 0)) / c.u(y); };
    /* the depth at which the ground meets the bottom of the frame */
    c.nearestY = function () {
      var d = c.h - c.horizon();
      return (d <= 0 ? c.near : Math.max(c.near, c.f() * c.height / d)) + (c.y - c.back);
    };
    /* `zoom` still means "the scale a body is measured in", for callers that
       size a tick mark or a font off the shot rather than off a yard line */
    Object.defineProperty(c, 'zoom', {
      get: function () { return c.px; }, set: function (v) { c.px = v; }
    });
    /* pixels per yard ACROSS at that depth, and per yard DEEP — a thing
       painted flat on the turf is stretched by the first and squashed by the
       second, which is what makes a number look painted rather than stuck on */
    c.lat = function (y) { return c.squeeze() * c.f() / c.u(y); };
    c.fore = function (y) { var u = c.u(y); return c.f() * c.height / (u * u); };
    c.wideYards = function () { return c.wide; };
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
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

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
    var sx = cam.sx(p.x, p.y), sy = cam.sy(p.y);
    if (sx < -90 || sx > cam.w + 90 || sy < -90 || sy > cam.h + 110) return;
    var b = build(p.pos), k = p.kit || uniform(null);
    /* HOW BIG HE IS IS HOW FAR AWAY HE IS. Nothing else. */
    var u = cam.scale(p.y) * (p.scale || 1);                /* pixels per yard here */
    if (u < 2.2) return;
    var H = BODY * b.h * u;                                  /* pixel height */
    var down = p.state === 'down';
    var run = p.state === 'run' || p.state === 'carry' || p.state === 'shed';
    var ph = p.phase || 0;
    var cyc = run ? Math.sin(ph * 13) : p.state === 'engaged' ? Math.sin(ph * 22) * 0.35 : 0;
    var lean = (p.lean || 0) + (run ? 0.10 : 0);
    var back = p.face === 'back';

    ctx.save();
    ctx.translate(sx, sy);

    /* how flat a circle drawn on the turf looks from here */
    var squash = Math.max(0.16, Math.min(0.70, cam.fore(p.y) / Math.max(0.001, cam.lat(p.y))));

    /* the shadow stays on the ground whatever the body does */
    ctx.save();
    ctx.scale(1, squash);
    ctx.beginPath();
    ctx.arc(0, 0, H * 0.26, 0, 6.2832);
    ctx.fillStyle = 'rgba(0,0,0,.30)';
    ctx.fill();
    ctx.restore();

    if (down) {
      /* on the ground: the whole body laid over, seen from above */
      ctx.rotate((p.fell || 1) * 1.35);
      ctx.scale(1, 0.55);
    } else {
      ctx.rotate(lean * 0.28);
    }

    var pw = H * 0.295 * b.w;         /* body half-width */
    var padW = H * 0.262 * b.pads;    /* shoulder half-width */
    var hipY = -H * 0.43;
    var shoY = -H * 0.79;
    var headY = -H * 1.00;

    /* ── LEGS ──────────────────────────────────────────────────────────── */
    var swing = cyc * H * 0.20;
    leg(ctx, -pw * 0.46, hipY, H, k, swing, u);
    leg(ctx, pw * 0.46, hipY, H, k, -swing, u);

    /* ── PANTS ─────────────────────────────────────────────────────────── */
    ctx.fillStyle = k.pants;
    roundRect(ctx, -pw * 0.86, hipY - H * 0.06, pw * 1.72, H * 0.25, H * 0.06);
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
    roundRect(ctx, -padW, shoY - H * 0.045, padW * 2, H * 0.155, H * 0.065);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.40)';
    ctx.lineWidth = Math.max(0.8, H * 0.018);
    ctx.stroke();
    ctx.fillStyle = rgba(k.trim === '#ffffff' ? '#ffffff' : k.trim, 0.85);
    roundRect(ctx, -padW, shoY - H * 0.045, padW * 2, H * 0.032, H * 0.018);
    ctx.fill();

    /* ── HELMET ────────────────────────────────────────────────────────── */
    var hr = H * 0.152;
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

    ctx.restore();

    /* ── THE RING AT HIS FEET ────────────────────────────────────────────
       Who you are steering, and who has the football. Drawn after the body
       and outside its lean so it stays flat on the grass, with his name
       under it — the one label a football game needs mid-play. */
    if (p.sel || p.carry) {
      ctx.save();
      ctx.translate(sx, sy);
      ctx.save();
      ctx.scale(1, squash);
      ctx.beginPath();
      ctx.arc(0, 0, H * 0.44, 0, 6.2832);
      ctx.strokeStyle = p.sel ? (p.selColor || 'rgba(84,240,158,.95)') : 'rgba(255,255,255,.92)';
      ctx.lineWidth = Math.max(2, H * 0.07);
      ctx.stroke();
      if (p.carry && p.sel) {
        ctx.beginPath();
        ctx.arc(0, 0, H * 0.60, 0, 6.2832);
        ctx.strokeStyle = 'rgba(245,190,50,.55)';
        ctx.lineWidth = Math.max(1, H * 0.035);
        ctx.stroke();
      }
      ctx.restore();
      if (p.label && H > 26) {
        var lf = Math.max(8, Math.round(H * 0.20));
        ctx.font = '700 ' + lf + 'px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        var lw = ctx.measureText(p.label).width + lf * 0.9;
        var ly = H * 0.44 * squash + lf * 0.85;
        ctx.fillStyle = 'rgba(8,12,17,.80)';
        roundRect(ctx, -lw / 2, ly - lf * 0.65, lw, lf * 1.3, lf * 0.5);
        ctx.fill();
        ctx.fillStyle = p.sel ? '#54f09e' : '#f5f7fa';
        ctx.fillText(p.label, 0, ly);
      }
      ctx.restore();
    }
  }

  /* ── A TARGET BADGE ──────────────────────────────────────────────────────
     The button you press to throw at a man, floating over the man himself
     rather than parked in a row at the bottom of the screen. That is the
     difference between reading the field and reading a menu.
     Returns where it landed, so the page can turn a tap into a throw. */
  function target(ctx, cam, p, letter, o) {
    o = o || {};
    var sx = cam.sx(p.x, p.y), sy = cam.sy(p.y);
    var u = cam.scale(p.y);
    var r = Math.max(13, Math.min(24, u * 0.72));
    sx = Math.max(r + 2, Math.min(cam.w - r - 2, sx));
    var cy = Math.max(r + 2, sy - BODY * u * 1.16 - r * 0.95);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(sx, cy + r * 0.86);
    ctx.lineTo(sx - r * 0.34, cy + r * 0.4);
    ctx.lineTo(sx + r * 0.34, cy + r * 0.4);
    ctx.closePath();
    ctx.fillStyle = o.hot ? 'rgba(84,240,158,.95)' : 'rgba(12,17,24,.88)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(sx, cy, r, 0, 6.2832);
    ctx.fillStyle = o.hot ? 'rgba(84,240,158,.95)' : 'rgba(12,17,24,.88)';
    ctx.fill();
    ctx.strokeStyle = o.hot ? '#eafff4' : 'rgba(255,255,255,.72)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = o.hot ? '#06231a' : '#ffffff';
    ctx.font = '800 ' + Math.round(r * 1.05) + 'px "Space Grotesk", Inter, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(letter), sx, cy + 0.5);
    if (o.name) {
      var nf = Math.max(8, Math.round(r * 0.50));
      ctx.font = '700 ' + nf + 'px Inter, system-ui, sans-serif';
      var nw = ctx.measureText(o.name).width + nf * 0.8;
      /* a receiver on the far numbers has his badge on him but his name
         pulled back inside the frame, because half a name is no name */
      var nx = Math.max(nw / 2 + 3, Math.min(cam.w - nw / 2 - 3, sx));
      ctx.fillStyle = 'rgba(8,12,17,.78)';
      roundRect(ctx, nx - nw / 2, cy - r - nf * 1.55, nw, nf * 1.25, nf * 0.5);
      ctx.fill();
      ctx.fillStyle = '#dfe6ef';
      ctx.fillText(o.name, nx, cy - r - nf * 0.92);
    }
    ctx.restore();
    return { x: sx, y: cy, r: r * 1.7 };
  }

  function leg(ctx, dx, hipY, H, k, swing, u) {
    ctx.save();
    ctx.translate(dx, hipY);
    ctx.rotate(swing * 0.06);
    ctx.fillStyle = k.pants;
    roundRect(ctx, -H * 0.060, 0, H * 0.12, H * 0.30, H * 0.05);
    ctx.fill();
    ctx.fillStyle = k.sock;
    roundRect(ctx, -H * 0.052, H * 0.28, H * 0.104, H * 0.13, H * 0.04);
    ctx.fill();
    ctx.fillStyle = '#14181f';
    roundRect(ctx, -H * 0.062, H * 0.39, H * 0.13, H * 0.055, H * 0.027);
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
    roundRect(ctx, -H * 0.046, 0, H * 0.092, H * 0.215, H * 0.04);
    ctx.fill();
    ctx.fillStyle = rgba(k.trim, 0.75);
    roundRect(ctx, -H * 0.046, H * 0.10, H * 0.092, H * 0.026, H * 0.013);
    ctx.fill();
    ctx.fillStyle = '#c8a487';
    roundRect(ctx, -H * 0.040, H * 0.195, H * 0.080, H * 0.15, H * 0.038);
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
    var sx = cam.sx(b.x, b.y), sy = cam.sy(b.y);
    var u = cam.scale(b.y);
    var z = sy - cam.sy(b.y, b.z || 0);
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

  /* ── LIGHT AND WEATHER ───────────────────────────────────────────────────
     One palette per time of day. Everything the stadium draws asks these for
     its colours, so switching to a night game changes the turf, the stands,
     the crowd and the sky in one move rather than in thirty. */
  var LIGHT = {
    day: {
      sky: ['#5f7d9c', '#8fa9bf'], haze: 'rgba(150,175,196,',
      turf: ['#1e5130', '#1a4629'], apron: '#2b3a46', wall: '#39485a',
      deck: ['#46566a', '#33404f'], upper: '#232e3c',
      crowd: 1.00, paint: 0.90, grade: null, lights: false
    },
    dusk: {
      sky: ['#2c3550', '#7a5a63'], haze: 'rgba(150,124,120,',
      turf: ['#1b4a2c', '#173f25'], apron: '#2a3038', wall: '#3a3a46',
      deck: ['#454150', '#2f2d3a'], upper: '#20202c',
      crowd: 0.82, paint: 0.82, grade: 'rgba(255,150,90,0.07)', lights: true
    },
    night: {
      sky: ['#05070d', '#0c1220'], haze: 'rgba(70,90,120,',
      turf: ['#1d5733', '#17482a'], apron: '#1b2129', wall: '#242c37',
      deck: ['#2a3240', '#1a2029'], upper: '#12171f',
      crowd: 0.60, paint: 1.00, grade: 'rgba(120,160,255,0.05)', lights: true
    }
  };
  var WEATHER = {
    clear: { grade: null, wind: 0.25, wet: 0 },
    cloudy: { grade: 'rgba(120,132,150,0.16)', wind: 0.45, wet: 0 },
    rain: { grade: 'rgba(90,110,140,0.24)', wind: 0.7, wet: 0.55 },
    wind: { grade: 'rgba(150,150,140,0.06)', wind: 1, wet: 0 }
  };
  function lightOf(k) { return LIGHT[k] || LIGHT.day; }
  function weatherOf(k) { return WEATHER[k] || WEATHER.clear; }

  /* ── THE STADIUM ─────────────────────────────────────────────────────────
     A football field in a black rectangle is a diagram of a football field.
     What makes it a place is everything AROUND it: the apron, the wall, the
     bowl rising away on both sides, eighty thousand people, the lights on
     their masts and the tunnel somebody ran out of.

     All of it is built in world yards with a height, and projected through
     the same camera as the players — so it converges with the field, it grows
     as you come toward it, and it never once disagrees with the perspective.
     A vertical pole at (x, y) is a vertical line on screen from sy(y,0) to
     sy(y,h): that one fact is the whole stadium. */
  var BOWL = {
    apron: 7.5,        /* yards of sideline between the paint and the wall */
    wall: 3.6,         /* how high the wall in front of the seats stands */
    deep: 30,          /* how far back the lower bowl reaches */
    high: 19,          /* and how high it climbs */
    endApron: 9,       /* the same behind each end zone */
    endDeep: 40
  };

  /* a quad given four [x, y, z] corners in world yards */
  function quad3(ctx, cam, a, b, c, d) {
    ctx.beginPath();
    ctx.moveTo(cam.sx(a[0], a[1]), cam.sy(a[1], a[2]));
    ctx.lineTo(cam.sx(b[0], b[1]), cam.sy(b[1], b[2]));
    ctx.lineTo(cam.sx(c[0], c[1]), cam.sy(c[1], c[2]));
    ctx.lineTo(cam.sx(d[0], d[1]), cam.sy(d[1], d[2]));
    ctx.closePath();
  }

  /* THE CROWD, seeded once and projected every frame. People are not animated
     individually — they are a fixed cloud of seats, and what changes is how
     many are on their feet and how hard they are moving. */
  var SEATS = null;
  function seats() {
    if (SEATS) return SEATS;
    var out = [], i, sd = 987654321;
    function r() { sd = (sd * 1103515245 + 12345) & 0x7fffffff; return sd / 0x7fffffff; }
    for (i = 0; i < 3200; i++) out.push([r(), r(), r(), r()]);
    SEATS = out;
    return out;
  }

  /* one bank of seats: `edge` gives the inner and outer rails in world space
     as functions of the position along the stand */
  function bank(ctx, cam, o) {
    var L = o.light, n = o.count || 260, i, s = seats();
    var g = ctx.createLinearGradient(0, o.top, 0, o.bottom);
    g.addColorStop(0, L.deck[1]);
    g.addColorStop(1, L.deck[0]);
    ctx.fillStyle = g;
    ctx.fill();                       /* the caller left the deck path ready */

    var excite = o.excite || 0, tick = o.tick || 0;
    for (i = 0; i < n; i++) {
      var d = s[(i + (o.offset || 0)) % s.length];
      /* PEOPLE SIT IN ROWS. Scattered uniformly they read as confetti; snapped
         to fourteen tiers with a little slop they read as a stand. */
      var rows = o.rows || 14;
      var u = (Math.floor(d[1] * rows) + 0.30 + d[2] * 0.40) / rows;
      var t = d[0] + (d[3] - 0.5) * 0.004;
      var pt = o.at(t, u);
      if (pt.y < o.yNear) continue;
      var sx = cam.sx(pt.x, pt.y), sy = cam.sy(pt.y, pt.z);
      if (sx < -8 || sx > cam.w + 8 || sy < -8 || sy > cam.h + 8) continue;
      /* a seat is about a third of a yard across; the floor keeps the far
         rows from disappearing into single sub-pixel specks that read as
         stars rather than as eighty thousand people */
      var sz = clamp(cam.scale(pt.y) * 0.20, 1.5, 5.0);
      /* the ones on their feet bounce; the rest are a texture */
      var up = d[2] < excite;
      var bob = up ? Math.sin(tick * 7 + d[3] * 40) * sz * 0.9 : 0;
      var lum = (0.42 + d[2] * 0.52) * L.crowd;
      ctx.fillStyle = d[3] < 0.30 && o.tint
        ? rgba(o.tint, (0.30 + d[2] * 0.45) * L.crowd)
        : 'rgba(' + Math.round(150 * lum + 40) + ',' + Math.round(155 * lum + 42)
          + ',' + Math.round(170 * lum + 48) + ',' + (0.55 + d[2] * 0.4) + ')';
      ctx.fillRect(sx - sz / 2, sy - sz - bob, sz * 0.86, sz * (up ? 1.45 : 1.1));
    }
  }

  /* ── THE BOWL ────────────────────────────────────────────────────────── */
  function stadium(ctx, cam, o) {
    var L = lightOf(o.light), W = cam.w, H = cam.h;
    var yNear = Math.max(-BOWL.endApron - BOWL.endDeep, cam.nearestY() - 2);
    var yFar = FIELD.length + FIELD.endzone + BOWL.endApron;
    var hw = FIELD.width, tick = o.tick || 0, excite = o.excite || 0;

    /* the sky, and the far bowl closing the picture */
    var sg = ctx.createLinearGradient(0, 0, 0, Math.max(30, cam.sy(yFar + BOWL.endDeep, BOWL.high)));
    sg.addColorStop(0, L.sky[0]);
    sg.addColorStop(1, L.sky[1]);
    ctx.fillStyle = sg;
    ctx.fillRect(0, 0, W, H);

    /* ── THE FAR END: apron, wall, bowl ──────────────────────────────── */
    var fy = yFar, fd = yFar + BOWL.endDeep;
    ctx.fillStyle = L.upper;
    quad3(ctx, cam, [-70, fd, BOWL.high + 9], [hw + 70, fd, BOWL.high + 9],
                    [hw + 70, fd, 0], [-70, fd, 0]);
    ctx.fill();
    quad3(ctx, cam, [-46, fy, BOWL.wall], [hw + 46, fy, BOWL.wall],
                    [hw + 62, fd, BOWL.high], [-62, fd, BOWL.high]);
    bank(ctx, cam, { light: L, tick: tick, excite: excite, count: 420, offset: 0,
      top: cam.sy(fd, BOWL.high), bottom: cam.sy(fy, BOWL.wall), yNear: yNear, tint: o.homeColor,
      at: function (t, u) {
        return { x: -46 + t * (hw + 92) + (t - 0.5) * u * 32,
                 y: fy + u * BOWL.endDeep,
                 z: BOWL.wall + u * (BOWL.high - BOWL.wall) };
      } });
    /* the wall in front of them, and the tunnel out of it */
    ctx.fillStyle = L.wall;
    quad3(ctx, cam, [-46, fy, BOWL.wall], [hw + 46, fy, BOWL.wall],
                    [hw + 46, fy, 0], [-46, fy, 0]);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    quad3(ctx, cam, [hw / 2 - 4, fy, BOWL.wall * 0.86], [hw / 2 + 4, fy, BOWL.wall * 0.86],
                    [hw / 2 + 4, fy, 0], [hw / 2 - 4, fy, 0]);
    ctx.fill();

    /* ── THE SIDES ───────────────────────────────────────────────────── */
    [-1, 1].forEach(function (side) {
      var edge = side < 0 ? -BOWL.apron : hw + BOWL.apron;
      var out = side < 0 ? -BOWL.apron - BOWL.deep : hw + BOWL.apron + BOWL.deep;
      /* seating deck */
      quad3(ctx, cam, [edge, yNear, BOWL.wall], [edge, yFar, BOWL.wall],
                      [out, yFar, BOWL.high], [out, yNear, BOWL.high]);
      bank(ctx, cam, { light: L, tick: tick, excite: excite, count: 900,
        offset: side < 0 ? 500 : 900,
        top: cam.sy(yFar, BOWL.high), bottom: cam.sy(yNear, BOWL.wall),
        yNear: yNear, tint: o.homeColor,
        at: function (t, u) {
          return { x: edge + u * (out - edge),
                   y: yNear + t * (yFar - yNear),
                   z: BOWL.wall + u * (BOWL.high - BOWL.wall) };
        } });
      /* the roofline: a bowl with no edge is a gradient, not a building */
      ctx.strokeStyle = rgba(L.upper, 0.95);
      ctx.lineWidth = Math.max(2, cam.lat(yFar) * 1.1);
      ctx.beginPath();
      ctx.moveTo(cam.sx(out, yNear), cam.sy(yNear, BOWL.high));
      ctx.lineTo(cam.sx(out, yFar), cam.sy(yFar, BOWL.high));
      ctx.stroke();
      /* the wall between the seats and the grass */
      ctx.fillStyle = L.wall;
      quad3(ctx, cam, [edge, yNear, BOWL.wall], [edge, yFar, BOWL.wall],
                      [edge, yFar, 0], [edge, yNear, 0]);
      ctx.fill();
      /* a thin rail catching the light along the top */
      ctx.strokeStyle = rgba(L.deck[0], 0.9);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(cam.sx(edge, yNear), cam.sy(yNear, BOWL.wall));
      ctx.lineTo(cam.sx(edge, yFar), cam.sy(yFar, BOWL.wall));
      ctx.stroke();
    });

    /* ── THE APRON: the painted surround the field sits in ───────────── */
    ctx.fillStyle = L.apron;
    quad3(ctx, cam, [-BOWL.apron, yNear, 0], [hw + BOWL.apron, yNear, 0],
                    [hw + BOWL.apron, yFar, 0], [-BOWL.apron, yFar, 0]);
    ctx.fill();

    /* ── THE NEAR END ────────────────────────────────────────────────
       From behind your own goal line you are standing IN the near stand, so
       there is none of it to see — but there is a wall, an apron and the
       front of the bowl curving away on both sides, and without them the
       bottom of the picture is a black bar. */
    var ny = -FIELD.endzone - BOWL.endApron;
    if (ny > yNear - 1) {
      ctx.fillStyle = L.wall;
      quad3(ctx, cam, [-46, ny, BOWL.wall], [hw + 46, ny, BOWL.wall],
                      [hw + 46, ny, 0], [-46, ny, 0]);
      ctx.fill();
      ctx.fillStyle = shade(L.wall, -0.35);
      quad3(ctx, cam, [-46, ny - 4, BOWL.wall + 6], [hw + 46, ny - 4, BOWL.wall + 6],
                      [hw + 46, ny, BOWL.wall], [-46, ny, BOWL.wall]);
      ctx.fill();
    }

    /* ── THE LIGHTS ──────────────────────────────────────────────────── */
    if (L.lights) {
      [-1, 1].forEach(function (side) {
        [18, 50, 82].forEach(function (y) {
          var x = side < 0 ? -BOWL.apron - BOWL.deep * 0.78 : hw + BOWL.apron + BOWL.deep * 0.78;
          var px = cam.sx(x, y), base = cam.sy(y, BOWL.high), top = cam.sy(y, BOWL.high + 15);
          if (top > cam.h || base < -40) return;
          var wdt = Math.max(1.2, cam.lat(y) * 0.35);
          ctx.fillStyle = '#161c25';
          ctx.fillRect(px - wdt / 2, top, wdt, base - top);
          var bw = Math.max(6, cam.lat(y) * 4.2), bh = Math.max(3, cam.lat(y) * 1.5);
          ctx.fillStyle = '#1d2530';
          roundRect(ctx, px - bw / 2, top - bh, bw, bh, bh * 0.25);
          ctx.fill();
          var lg = ctx.createRadialGradient(px, top - bh / 2, 1, px, top - bh / 2, bw * 1.5);
          lg.addColorStop(0, 'rgba(255,248,224,.55)');
          lg.addColorStop(1, 'rgba(255,248,224,0)');
          ctx.fillStyle = lg;
          ctx.fillRect(px - bw * 1.5, top - bh - bw * 0.6, bw * 3, bh + bw * 1.6);
        });
      });
    }
  }

  /* the picture sits inside the place: a little darkness at the corners so
     the eye goes to the grass and not to the edges */
  function vignette(ctx, cam) {
    var W = cam.w, H = cam.h;
    var g = ctx.createRadialGradient(W / 2, H * 0.46, Math.min(W, H) * 0.34,
                                     W / 2, H * 0.46, Math.max(W, H) * 0.82);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.42)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  /* ── GOAL POSTS ──────────────────────────────────────────────────────────
     A real one, on the back line of the end zone, in the perspective. Uprights
     eighteen and a half feet apart, crossbar ten feet up. */
  function goalposts(ctx, cam, y, color) {
    if (y < cam.nearestY() - 1) return;
    var cx = FIELD.half, halfW = 3.08, bar = 3.33, up = 12;
    var lw = Math.max(1.2, cam.lat(y) * 0.24);
    ctx.strokeStyle = color || '#f2c744';
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    /* the stem and the gooseneck */
    ctx.beginPath();
    ctx.moveTo(cam.sx(cx, y), cam.sy(y, 0));
    ctx.lineTo(cam.sx(cx, y), cam.sy(y, bar));
    ctx.stroke();
    /* the crossbar */
    ctx.beginPath();
    ctx.moveTo(cam.sx(cx - halfW, y), cam.sy(y, bar));
    ctx.lineTo(cam.sx(cx + halfW, y), cam.sy(y, bar));
    ctx.stroke();
    /* the uprights */
    [-halfW, halfW].forEach(function (dx) {
      ctx.beginPath();
      ctx.moveTo(cam.sx(cx + dx, y), cam.sy(y, bar));
      ctx.lineTo(cam.sx(cx + dx, y), cam.sy(y, up));
      ctx.stroke();
    });
    ctx.lineCap = 'butt';
  }

  /* ── THE SIDELINE ────────────────────────────────────────────────────────
     Benches, coaches, the men who are not in the game and the chain crew. No
     animation to speak of: they are there to frame the field, and a field
     with nobody standing beside it reads as a diagram. */
  function sidelines(ctx, cam, o) {
    var L = lightOf(o.light), hw = FIELD.width;
    var yNear = Math.max(0, cam.nearestY());
    var yFar = Math.min(100, FIELD.length);
    [-1, 1].forEach(function (side) {
      var kit = side < 0 ? o.homeColor : o.awayColor;
      var xBench = side < 0 ? -4.6 : hw + 4.6;
      var xStand = side < 0 ? -2.4 : hw + 2.4;
      /* the bench itself */
      var b0 = Math.max(yNear, 28), b1 = Math.min(yFar, 72);
      if (b1 > b0) {
        ctx.fillStyle = 'rgba(14,18,24,.85)';
        quad3(ctx, cam, [xBench - 1.1, b0, 0.9], [xBench + 1.1, b0, 0.9],
                        [xBench + 1.1, b1, 0.9], [xBench - 1.1, b1, 0.9]);
        ctx.fill();
      }
      /* the people */
      var i, seed = side < 0 ? 31 : 77;
      for (i = 0; i < 22; i++) {
        var y = 20 + ((i * 37 + seed) % 62);
        if (y < yNear + 1) continue;
        var jitter = ((i * 53 + seed) % 7) / 7;
        var x = xStand + (side < 0 ? -1 : 1) * jitter * 3.4;
        var sc = cam.scale(y);
        if (sc < 3) continue;
        var h = BODY * sc * 0.52;
        var px = cam.sx(x, y), py = cam.sy(y, 0);
        var coach = (i % 4) === 0;
        /* a shadow, a body, a head — three shapes and they read as people */
        ctx.fillStyle = 'rgba(0,0,0,.30)';
        ctx.beginPath();
        ctx.ellipse(px, py, h * 0.20, h * 0.07, 0, 0, 6.2832);
        ctx.fill();
        ctx.fillStyle = coach ? '#1c222b' : rgba(kit || '#3fb883', 0.55);
        roundRect(ctx, px - h * 0.21, py - h * 0.74, h * 0.42, h * 0.58, h * 0.12);
        ctx.fill();
        ctx.fillStyle = coach ? '#33404e' : shade(kit || '#3fb883', -0.35);
        ctx.beginPath();
        ctx.arc(px, py - h * 0.84, h * 0.155, 0, 6.2832);
        ctx.fill();
      }
    });
    /* the chain crew, opposite the benches, where the chains actually live */
    if (o.firstDown != null && o.firstDown > yNear && o.firstDown < 100) {
      var cy = o.firstDown, cs = cam.scale(cy);
      if (cs > 3) {
        var cxp = cam.sx(hw + 1.6, cy);
        ctx.strokeStyle = 'rgba(242,199,68,.9)';
        ctx.lineWidth = Math.max(1, cs * 0.09);
        ctx.beginPath();
        ctx.moveTo(cxp, cam.sy(cy, 0));
        ctx.lineTo(cxp, cam.sy(cy, 2.2));
        ctx.stroke();
      }
    }
  }

  /* ── ATMOSPHERE ──────────────────────────────────────────────────────────
     Distance is not only smaller, it is hazier. Drawn AFTER the players so a
     safety forty yards away sits back in the picture with the far stands
     instead of in front of them. */
  function atmosphere(ctx, cam, o) {
    var L = lightOf(o.light), W = cam.w, H = cam.h;
    var fade = cam.sy(cam.y + 4);
    if (fade < 2) return;
    var g = ctx.createLinearGradient(0, 0, 0, fade);
    g.addColorStop(0, L.haze + '0.38)');
    g.addColorStop(0.55, L.haze + '0.13)');
    g.addColorStop(1, L.haze + '0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, fade);
  }

  /* rain, wind and the colour of the afternoon, over the top of everything */
  var DROPS = null;
  function conditions(ctx, cam, o) {
    var L = lightOf(o.light), Wx = weatherOf(o.weather), W = cam.w, H = cam.h, i;
    if (Wx.wet > 0) {
      if (!DROPS) {
        DROPS = [];
        var sd = 24680;
        function r() { sd = (sd * 1103515245 + 12345) & 0x7fffffff; return sd / 0x7fffffff; }
        for (i = 0; i < 150; i++) DROPS.push([r(), r(), 0.4 + r() * 0.8]);
      }
      var t = (o.tick || 0);
      ctx.strokeStyle = 'rgba(198,216,236,.30)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (i = 0; i < DROPS.length; i++) {
        var d = DROPS[i];
        var y = ((d[1] + t * d[2] * 0.55) % 1) * H;
        var x = ((d[0] + t * 0.05 * Wx.wind) % 1) * W;
        ctx.moveTo(x, y);
        ctx.lineTo(x + 5 * Wx.wind, y + 13 * d[2]);
      }
      ctx.stroke();
    }
    if (Wx.grade) { ctx.fillStyle = Wx.grade; ctx.fillRect(0, 0, W, H); }
    if (L.grade) { ctx.fillStyle = L.grade; ctx.fillRect(0, 0, W, H); }
    vignette(ctx, cam);
  }

  /* ── THE FIELD ───────────────────────────────────────────────────────────
     Everything below the horizon: the turf and its mow stripes, both end
     zones in their clubs' colours, every marking a broadcast shows, and the
     midfield mark. All of it drawn on the ground plane, so all of it obeys
     the perspective — the far thirty is narrower and its number is smaller
     than the near thirty, which is the single cue that says "camera in a
     stadium" rather than "diagram on a desk". */
  function field(ctx, cam, o) {
    o = o || {};
    var W = cam.w, H = cam.h, hz = cam.horizon();
    var yFar = FIELD.length + FIELD.endzone + 4;
    var yNear = Math.max(-FIELD.endzone - 6, cam.nearestY() - 1);
    if (yNear >= yFar - 2) yNear = yFar - 2;

    /* a trapezoid of ground, in world yards */
    function ground(x0, x1, ya, yb) {
      ctx.beginPath();
      ctx.moveTo(cam.sx(x0, ya), cam.sy(ya));
      ctx.lineTo(cam.sx(x1, ya), cam.sy(ya));
      ctx.lineTo(cam.sx(x1, yb), cam.sy(yb));
      ctx.lineTo(cam.sx(x0, yb), cam.sy(yb));
      ctx.closePath();
    }
    /* a line painted on the ground: straight on screen, because perspective
       takes straight lines to straight lines */
    function paint(x0, y0, x1, y1, color, yards) {
      var a = Math.max(y0, yNear), b = Math.max(y1, yNear);
      if (a > yFar && b > yFar) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(0.9, yards * cam.lat((a + b) / 2));
      ctx.beginPath();
      ctx.moveTo(cam.sx(x0, a), cam.sy(a));
      ctx.lineTo(cam.sx(x1, b), cam.sy(b));
      ctx.stroke();
    }

    /* ── THE PLACE IT IS PLAYED IN ─────────────────────────────────────
       Sky, both bowls, the crowd, the wall, the apron and the lights, all
       projected through this same camera so the venue converges with the
       field instead of sitting behind a picture of one. */
    var L = lightOf(o.light);
    stadium(ctx, cam, o);

    /* ── TURF, with a mow stripe every five yards ──────────────────────── */
    var n;
    for (n = -FIELD.endzone - 5; n < FIELD.length + FIELD.endzone + 5; n += 5) {
      var a2 = Math.max(n, yNear), b2 = Math.min(n + 5, yFar);
      if (b2 <= a2) continue;
      ctx.fillStyle = ((n + 100) / 5) % 2 === 0 ? L.turf[0] : L.turf[1];
      ground(0, FIELD.width, a2, b2);
      ctx.fill();
    }

    /* ── END ZONES ─────────────────────────────────────────────────────── */
    endzone(ctx, cam, 100, 110, o.homeColor || '#123326', o.homeName || '', false, yNear, yFar);
    endzone(ctx, cam, -10, 0, o.awayColor || '#2a1a2f', o.awayName || '', true, yNear, yFar);

    /* ── THE MIDFIELD MARK ─────────────────────────────────────────────── */
    midfield(ctx, cam, yNear, o.homeColor || '#3fb883');

    /* ── YARD LINES ────────────────────────────────────────────────────── */
    for (n = 0; n <= 100; n += 5) {
      if (n < yNear - 1) continue;
      var major = n % 10 === 0;
      paint(0, n, FIELD.width, n, major ? 'rgba(255,255,255,.50)' : 'rgba(255,255,255,.26)',
        major ? 0.24 : 0.16);
    }
    /* goal lines, heavier */
    paint(0, 0, FIELD.width, 0, 'rgba(255,255,255,.92)', 0.34);
    paint(0, 100, FIELD.width, 100, 'rgba(255,255,255,.92)', 0.34);

    /* ── HASH MARKS ────────────────────────────────────────────────────── */
    /* thinned out when the shot is wide, because ninety-eight of them read as
       a ladder rather than as a field */
    var every = cam.px < 10 ? 5 : cam.px < 14 ? 2 : 1;
    for (n = 1; n < 100; n++) {
      if (n % 5 === 0 || n < yNear) continue;
      if (every > 1 && n % every !== 0) continue;
      var t = 0.42;
      paint(FIELD.half - 6.17 - t, n, FIELD.half - 6.17 + t, n, 'rgba(255,255,255,.34)', 0.15);
      paint(FIELD.half + 6.17 - t, n, FIELD.half + 6.17 + t, n, 'rgba(255,255,255,.34)', 0.15);
      paint(1.1, n, 1.1 + t * 2, n, 'rgba(255,255,255,.26)', 0.15);
      paint(FIELD.width - 1.1 - t * 2, n, FIELD.width - 1.1, n, 'rgba(255,255,255,.26)', 0.15);
    }

    /* ── SIDELINES ─────────────────────────────────────────────────────── */
    ctx.strokeStyle = 'rgba(255,255,255,.60)';
    [0, FIELD.width].forEach(function (sxw) {
      var a3 = Math.max(-FIELD.endzone, yNear), b3 = FIELD.length + FIELD.endzone;
      ctx.lineWidth = Math.max(1, 0.4 * cam.lat(a3));
      ctx.beginPath();
      ctx.moveTo(cam.sx(sxw, a3), cam.sy(a3));
      ctx.lineTo(cam.sx(sxw, b3), cam.sy(b3));
      ctx.stroke();
    });

    /* ── THE NUMBERS, painted flat on the turf ─────────────────────────── */
    for (n = 10; n <= 90; n += 10) {
      if (n < yNear + 1) continue;
      var lat = cam.lat(n), fore = cam.fore(n);
      if (lat < 2.2) continue;
      var label = String(n <= 50 ? n : 100 - n);
      ctx.fillStyle = 'rgba(255,255,255,.36)';
      [9, FIELD.width - 9].forEach(function (wx, i) {
        ctx.save();
        ctx.translate(cam.sx(wx, n), cam.sy(n));
        /* stretched across, squashed down the field: that is what paint on
           grass looks like from a camera in the stand */
        ctx.scale(1, Math.max(0.18, Math.min(1, fore / lat)));
        ctx.font = '800 ' + Math.max(7, Math.round(lat * 2.1)) + 'px "Space Grotesk", Inter, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(label, 0, 0);
        if (n !== 50) {
          var dir = n < 50 ? 1 : -1, ax = (i ? 1 : -1) * lat * 1.7;
          ctx.beginPath();
          ctx.moveTo(ax, dir * lat * 0.62);
          ctx.lineTo(ax + lat * 0.55, 0);
          ctx.lineTo(ax, -dir * lat * 0.62);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
      });
    }

    /* ── THE STICKS, at both ends ──────────────────────────────────────── */
    goalposts(ctx, cam, 100, '#f2c744');
    goalposts(ctx, cam, 0, '#f2c744');
    sidelines(ctx, cam, o);

    /* ── PYLONS, which stand up off the ground ─────────────────────────── */
    [0, FIELD.width].forEach(function (px2) {
      [-10, 0, 100, 110].forEach(function (py) {
        if (py < yNear) return;
        var x = cam.sx(px2, py), y0 = cam.sy(py), y1 = cam.sy(py, 0.5);
        var wdt = Math.max(1.6, cam.lat(py) * 0.13);
        ctx.fillStyle = '#f4a23a';
        ctx.fillRect(x - wdt / 2, y1, wdt, Math.max(1.5, y0 - y1));
      });
    });
  }

  /* the club's mark at the fifty — an original EdgeDesk lozenge on grass */
  function midfield(ctx, cam, yNear, color) {
    if (50 < yNear + 3) return;
    var lat = cam.lat(50), fore = cam.fore(50);
    if (lat < 2.6) return;
    ctx.save();
    ctx.translate(cam.sx(FIELD.half, 50), cam.sy(50));
    ctx.scale(1, Math.max(0.16, Math.min(1, fore / lat)));
    var r = lat * 5.4;
    ctx.globalAlpha = 0.20;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.5, lat * 0.45);
    ctx.beginPath();
    ctx.moveTo(0, -r); ctx.lineTo(r * 0.72, 0); ctx.lineTo(0, r); ctx.lineTo(-r * 0.72, 0);
    ctx.closePath(); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -r * 0.5); ctx.lineTo(r * 0.36, 0); ctx.lineTo(0, r * 0.5); ctx.lineTo(-r * 0.36, 0);
    ctx.closePath();
    ctx.fillStyle = color; ctx.fill();
    ctx.restore();
  }

  function endzone(ctx, cam, from, to, color, name, flip, yNear, yFar) {
    var a = Math.max(Math.min(from, to), yNear), b = Math.min(Math.max(from, to), yFar);
    if (b <= a) return;
    var g = ctx.createLinearGradient(0, cam.sy(b), 0, cam.sy(a));
    g.addColorStop(0, shade(color, -0.30));
    g.addColorStop(0.55, color);
    g.addColorStop(1, shade(color, -0.22));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(cam.sx(0, a), cam.sy(a));
    ctx.lineTo(cam.sx(FIELD.width, a), cam.sy(a));
    ctx.lineTo(cam.sx(FIELD.width, b), cam.sy(b));
    ctx.lineTo(cam.sx(0, b), cam.sy(b));
    ctx.closePath();
    ctx.fill();
    if (!name) return;
    var mid = (a + b) / 2, lat = cam.lat(mid), fore = cam.fore(mid);
    if (lat < 2) return;
    ctx.save();
    ctx.translate(cam.sx(FIELD.half, mid), cam.sy(mid));
    ctx.scale(1, Math.max(0.14, Math.min(1, fore / lat)));
    if (flip) ctx.rotate(Math.PI);
    var txt = String(name).toUpperCase();
    ctx.font = '800 ' + Math.max(7, Math.round(lat * 2.6)) + 'px "Space Grotesk", Inter, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    /* keep it inside the sidelines however long the club is called */
    var fits = ctx.measureText(txt).width, room = FIELD.width * 0.82 * lat;
    if (fits > room) ctx.scale(room / fits, 1);
    ctx.fillStyle = 'rgba(255,255,255,.34)';
    ctx.fillText(txt, 0, 0);
    ctx.restore();
  }

  /* ── MARKERS: the line of scrimmage and the chains ───────────────────────
     Painted on the grass like the broadcast does it, so they lie down in
     perspective with everything else instead of floating over the picture. */
  function markers(ctx, cam, los, firstDown) {
    function band(y, color) {
      if (y == null || y > 100.5 || y < cam.nearestY() - 1) return;
      var t = 0.22;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(cam.sx(-1.4, y - t), cam.sy(y - t));
      ctx.lineTo(cam.sx(FIELD.width + 1.4, y - t), cam.sy(y - t));
      ctx.lineTo(cam.sx(FIELD.width + 1.4, y + t), cam.sy(y + t));
      ctx.lineTo(cam.sx(-1.4, y + t), cam.sy(y + t));
      ctx.closePath();
      ctx.fill();
    }
    band(firstDown, 'rgba(245,190,50,.80)');
    band(los, 'rgba(74,142,255,.72)');
  }

  /* ── PLAY ART: routes, the run path and blitz arrows ──────────────────── */
  function art(ctx, cam, paths) {
    if (!paths || !paths.length) return;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    paths.forEach(function (p) {
      if (!p.pts || p.pts.length < 2) return;
      ctx.strokeStyle = p.color || 'rgba(255,255,255,.78)';
      /* play art is a coach's line drawn on the grass, not a road marking:
         it follows the perspective but stays a hairline */
      var lw = (p.width || 2.4) * cam.lat(p.pts[0][1]) / 13;
      ctx.lineWidth = lw < 1.4 ? 1.4 : lw > 4.2 ? 4.2 : lw;
      ctx.setLineDash(p.dash === false ? [] : [7, 5]);
      ctx.beginPath();
      p.pts.forEach(function (q, i) {
        var x = cam.sx(q[0], q[1]), y = cam.sy(q[1]);
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
      var last = p.pts[p.pts.length - 1], prev = p.pts[p.pts.length - 2];
      if (p.arrow !== false) arrowHead(ctx, cam, prev, last, p.color || 'rgba(255,255,255,.85)');
    });
  }
  function arrowHead(ctx, cam, a, b, color) {
    var x1 = cam.sx(a[0], a[1]), y1 = cam.sy(a[1]);
    var x2 = cam.sx(b[0], b[1]), y2 = cam.sy(b[1]);
    var ang = Math.atan2(y2 - y1, x2 - x1);
    var s = Math.max(4.5, Math.min(9, cam.lat(b[1]) * 0.55));
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
    player: player, target: target, ball: ball,
    stadium: stadium, goalposts: goalposts, sidelines: sidelines,
    atmosphere: atmosphere, conditions: conditions, LIGHT: LIGHT, WEATHER: WEATHER, field: field, markers: markers, art: art, roundRect: roundRect
  };
  root.EDGridironPaint = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
