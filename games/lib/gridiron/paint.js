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

    /* ── THE SURROUND, and the stand beyond the far end line ───────────
       With a lens this long the horizon is a long way off the top of the
       frame, so most of the time the picture is all football — which is what
       the reference looks like. The stand only comes into shot when you are
       close enough to score for the back of the end zone to be visible. */
    ctx.fillStyle = '#0b1119';
    ctx.fillRect(0, 0, W, H);
    var backLine = cam.sy(yFar);
    if (backLine > 2) {
      var sg = ctx.createLinearGradient(0, 0, 0, backLine);
      sg.addColorStop(0, '#05080c');
      sg.addColorStop(1, '#19222d');
      ctx.fillStyle = sg;
      ctx.fillRect(0, 0, W, backLine + 1);
      crowd(ctx, 0, Math.max(0, backLine - H * 0.30), W, Math.min(H * 0.30, backLine), o.tick || 0);
    }
    ctx.fillStyle = '#101a24';
    ground(-9, FIELD.width + 9, yNear, yFar);
    ctx.fill();

    /* ── TURF, with a mow stripe every five yards ──────────────────────── */
    var n;
    for (n = -FIELD.endzone - 5; n < FIELD.length + FIELD.endzone + 5; n += 5) {
      var a2 = Math.max(n, yNear), b2 = Math.min(n + 5, yFar);
      if (b2 <= a2) continue;
      ctx.fillStyle = ((n + 100) / 5) % 2 === 0 ? '#16381f' : '#123018';
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
    player: player, target: target, ball: ball, field: field, markers: markers, art: art, roundRect: roundRect
  };
  root.EDGridironPaint = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
