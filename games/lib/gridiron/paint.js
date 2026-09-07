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
    /* A KIT IS THREE VALUES, NOT ONE COLOUR. Helmet, jersey and pants have to
       separate at twenty yards or the man reads as one silhouette with a
       number on it — which is exactly what a green helmet over a green jersey
       looked like: a lineman with no head. So the home side wears its colour
       on the shirt, a light trouser under it and a deep shell above it, and
       the away side inverts the whole thing. */
    if (away) {
      return { jersey: '#e9edf3', jerseyDark: '#c2c9d4', pants: '#dee3ea',
               helmet: p, helmetDark: shade(p, -0.42), trim: p, ink: '#1a2029',
               sleeve: shade(p, -0.06), sock: p, collar: shade(p, -0.20) };
    }
    return { jersey: p, jerseyDark: shade(p, -0.32), pants: shade(p, 0.70),
             helmet: shade(p, -0.40), helmetDark: shade(p, -0.66), trim: '#ffffff',
             ink: readable(p), sleeve: shade(p, -0.16), sock: shade(p, -0.30),
             collar: '#ffffff' };
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
     A lineman is not a corner, and the difference has to be visible at
     twenty yards. Five numbers per position rather than three: how tall he
     stands, how wide the pads are, how much torso is under them, how thick
     the limbs are, and how long the legs run. A receiver is the same height
     as a guard and looks nothing like him. */
  var BUILD = {
    QB: { h: 1.01, pads: 1.00, torso: 1.00, limb: 0.99, leg: 1.00 },
    RB: { h: 0.96, pads: 1.05, torso: 1.06, limb: 1.02, leg: 0.98 },
    FB: { h: 0.98, pads: 1.15, torso: 1.16, limb: 1.10, leg: 0.97 },
    WR: { h: 1.03, pads: 0.93, torso: 0.91, limb: 0.93, leg: 1.05 },
    TE: { h: 1.06, pads: 1.12, torso: 1.09, limb: 1.07, leg: 1.02 },
    OL: { h: 1.03, pads: 1.24, torso: 1.24, limb: 1.20, leg: 0.96 },
    DL: { h: 1.03, pads: 1.21, torso: 1.18, limb: 1.17, leg: 0.97 },
    LB: { h: 1.00, pads: 1.11, torso: 1.09, limb: 1.08, leg: 0.99 },
    CB: { h: 1.00, pads: 0.92, torso: 0.89, limb: 0.92, leg: 1.06 },
    S:  { h: 1.01, pads: 0.97, torso: 0.95, limb: 0.95, leg: 1.03 },
    K:  { h: 0.99, pads: 0.95, torso: 0.95, limb: 0.95, leg: 1.02 },
    P:  { h: 0.99, pads: 0.95, torso: 0.95, limb: 0.95, leg: 1.02 }
  };
  function build(pos) { return BUILD[pos] || BUILD.LB; }

  /* ── THE SKELETON ────────────────────────────────────────────────────────
     Where the joints are, as fractions of standing height, feet on the grass
     at zero and the crown of the helmet at one. These are a man's
     proportions, not a doll's: the helmet is a sixth of him and the shoulders
     are a quarter of him across. The first version of this renderer gave him
     a head three tenths of his height and shoulders wider than he was tall,
     which is exactly why it read as a placeholder however carefully the rest
     of it was shaded. */
  var SK = {
    foot: 0.000, ankle: 0.055, knee: 0.255, hip: 0.470,
    waist: 0.530, chest: 0.720, shoulder: 0.805, neck: 0.845,
    head: 0.905, crown: 1.000,
    padHalf: 0.146, chestHalf: 0.114, waistHalf: 0.092, hipHalf: 0.100,
    thighHalf: 0.053, calfHalf: 0.040, upperHalf: 0.037, foreHalf: 0.030,
    helmR: 0.096
  };

  /* the height of a man on the field, in yards, before his build */
  var BODY = 2.6;

  /* ── ONE FOOTBALL PLAYER ─────────────────────────────────────────────────
     p: { x, y, pos, kit, num, state, phase, face, lean, sel, down, vx, vy }
       state  stance | run | block | engaged | shed | tackle | down | catch
              | throw | carry | celebrate | idle
       phase  seconds, for the stride
       face   left | right | front | back
       vx,vy  yards a second, when the simulation is running him. The GAIT
              comes out of these rather than out of the state name, which is
              how a corner opening his hips and a corner sprinting can look
              like two different things while the engine calls both 'run'.  */
  function player(ctx, p, cam) {
    /* ox/oy are a PRESENTATION nudge in yards — engagement offsets so two men
       in a block do not stand on the same blade of grass. The simulation
       never sees them; it is still one coordinate per man. */
    var px = p.x + (p.ox || 0), py = p.y + (p.oy || 0);
    var sx = cam.sx(px, py), sy = cam.sy(py);
    if (sx < -90 || sx > cam.w + 90 || sy < -90 || sy > cam.h + 110) return;
    var b = build(p.pos), k = p.kit || uniform(null);
    /* HOW BIG HE IS IS HOW FAR AWAY HE IS. Nothing else. */
    var u = cam.scale(py) * (p.scale || 1);                /* pixels per yard here */
    if (u < 2.2) return;
    var H = BODY * b.h * u;                                  /* pixel height */
    var down = p.state === 'down';
    var st = p.state;
    var ph = p.phase || 0;
    var back = p.face === 'back';
    var side = p.face === 'left' ? -1 : p.face === 'right' ? 1 : 0;

    /* ── THE GAIT ──────────────────────────────────────────────────────
       How fast he is going decides how he is moving, and how he is going
       relative to the way he is looking decides what it is called. */
    var vx = p.vx || 0, vy = p.vy || 0;
    var spd = Math.sqrt(vx * vx + vy * vy);
    var sn = clamp(spd / 9, 0, 1.2);
    /* RUNNING THE OPPOSITE WAY TO THE WAY HE IS LOOKING. Take it off the
       facing rather than off the side of the ball he plays on: a corner
       dropping into a zone and a corner chasing a post are both 'run' to the
       simulation and have to look nothing alike. `back` means he is facing
       away from the camera, which is up the field. */
    var retreat = back ? vy < -1.2 : vy > 1.2;
    var lateral = Math.abs(vx) > Math.abs(vy) * 1.7 && sn > 0.18;
    var gait = st === 'block' || st === 'engaged' ? 'block'
             : st === 'tackle' ? 'tackle'
             : sn < 0.10 ? 'idle'
             : retreat ? 'backpedal'
             : lateral ? 'shuffle'
             : sn < 0.30 ? 'walk' : sn < 0.62 ? 'jog' : 'sprint';

    /* STRIDE RATE FOLLOWS SPEED. A man jogging and a man at a dead sprint
       cycling their legs at the same rate is the single clearest tell that
       nothing on the screen has any weight. */
    var rate = gait === 'backpedal' ? 8 + sn * 9
             : gait === 'shuffle' ? 7 + sn * 7
             : 5.0 + sn * 10.5;
    var cyc = gait === 'idle' ? 0
            : gait === 'block' ? Math.sin(ph * 21) * 0.30
            : Math.sin(ph * rate);
    /* how far the legs actually travel: a walk is not a sprint at half speed */
    var reach = gait === 'idle' ? 0.06
              : gait === 'backpedal' ? 0.34
              : gait === 'shuffle' ? 0.30
              : gait === 'walk' ? 0.42
              : gait === 'jog' ? 0.72 : 1.0;

    /* NOBODY STANDS UP STRAIGHT BEFORE A SNAP. A crouch is the knees folding,
       so the hip comes down and everything above it comes with it — and a
       lineman folds twice as far as a receiver and pitches over the ball. */
    var lineman = p.pos === 'OL' || p.pos === 'DL';
    var crouch = st === 'stance' ? (lineman ? 0.115 : 0.042) : 0;

    /* the body leans into what it is doing, and the lean is momentum */
    var lean = (p.lean || 0) * 0.55 + (st === 'stance' ? (lineman ? 0.30 : 0.10) : 0);
    if (gait === 'sprint') lean += 0.16;
    else if (gait === 'jog') lean += 0.09;
    else if (gait === 'backpedal') lean -= 0.10;
    if (st === 'block' || st === 'engaged') lean += 0.13;
    if (p.move === 'truck') lean += 0.20;

    ctx.save();
    ctx.translate(sx, sy);

    /* how flat a circle drawn on the turf looks from here */
    var squash = clamp(cam.fore(py) / Math.max(0.001, cam.lat(py)), 0.16, 0.70);

    /* the shadow stays on the ground whatever the body does */
    ctx.save();
    ctx.scale(1, squash);
    ctx.beginPath();
    ctx.arc(0, 0, H * 0.20, 0, 6.2832);
    ctx.fillStyle = 'rgba(0,0,0,.32)';
    ctx.fill();
    ctx.restore();

    /* THE MAN WITH THE FOOTBALL COMES OUT OF THE PILE. Six bodies inside two
       yards of each other and the one that matters is somewhere in the middle
       of them; a soft light behind him separates him without putting another
       badge on the screen. */
    if ((p.sel || p.carry) && !down) {
      var hal = ctx.createRadialGradient(0, -H * 0.52, H * 0.06, 0, -H * 0.52, H * 0.66);
      hal.addColorStop(0, p.sel ? 'rgba(84,240,158,.34)' : 'rgba(255,255,255,.26)');
      hal.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = hal;
      ctx.fillRect(-H * 0.7, -H * 1.2, H * 1.4, H * 1.4);
    }

    if (down) {
      /* ON THE GROUND, BUT NOT INSTANTLY. He was upright a tick ago; a body
         that snaps flat between two frames reads as a sprite being switched
         off. The fall eases over a third of a second, the legs go first and
         the shoulders follow, and he keeps sliding the way he was going. */
      var e = clamp((p.fallT == null ? 1 : p.fallT) / 0.34, 0, 1);
      e = e * e * (3 - 2 * e);
      ctx.translate(0, H * 0.10 * e);
      ctx.rotate((p.fell || 1) * 1.42 * e);
      ctx.scale(1 - 0.06 * e, 1 - 0.45 * e);
    } else {
      ctx.rotate(lean * 0.30);
      /* A CUT ROTATES THE BODY INTO IT. He does not slide sideways facing
         forwards; he plants and turns, and the shoulders go first. */
      if (p.move === 'juke' || p.move === 'spin') {
        ctx.rotate(clamp((p.cutDir || (vx > 0 ? 1 : -1)) * 0.24, -0.3, 0.3));
      }
    }

    /* ── THE JOINTS, in pixels, y negative upward ─────────────────────── */
    var legL = b.leg;
    var hipY = -H * SK.hip * legL;
    var kneeY = -H * SK.knee * legL;
    var shoY = -H * SK.shoulder;
    var chestY = -H * SK.chest;
    var waistY = -H * SK.waist;
    var headY = -H * SK.head;
    if (crouch) {
      var drop = H * crouch;
      /* the spine pitches as well as the knees folding, so the head does not
         come down as far as the hips do — otherwise it settles onto the pads
         and a crouched lineman looks decapitated */
      hipY += drop; waistY += drop; chestY += drop;
      shoY += drop * 0.86; headY += drop * 0.66;
      kneeY += drop * 0.30;
    }
    var padW = H * SK.padHalf * b.pads;
    var chW = H * SK.chestHalf * b.torso;
    var wsW = H * SK.waistHalf * b.torso;
    var hpW = H * SK.hipHalf * b.torso;
    var thW = H * SK.thighHalf * b.limb;
    var clW = H * SK.calfHalf * b.limb;
    var upW = H * SK.upperHalf * b.limb;
    var foW = H * SK.foreHalf * b.limb;
    var hr = H * SK.helmR;

    /* ── LEGS ──────────────────────────────────────────────────────────
       Two segments with a knee between them, so a stride bends instead of
       swinging like a pendulum from a hip. */
    var swing = cyc * reach;
    var lift = gait === 'sprint' ? 0.62 : gait === 'jog' ? 0.42 : 0.24;
    var stanceW = gait === 'shuffle' ? 1.7 : gait === 'block' ? 1.5 : 1;
    legPair(ctx, hipY, kneeY, hpW * stanceW, thW, clW, k, swing, lift, H, gait);

    /* ── PANTS over the hips ───────────────────────────────────────────── */
    ctx.fillStyle = k.pants;
    roundRect(ctx, -hpW * 1.06, hipY - H * 0.055, hpW * 2.12, H * 0.125, H * 0.045);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,.16)';
    roundRect(ctx, -hpW * 1.06, hipY + H * 0.03, hpW * 2.12, H * 0.04, H * 0.02);
    ctx.fill();

    /* ── THE FAR ARM, behind the body ──────────────────────────────────── */
    armOf(ctx, -1, padW, shoY, upW, foW, k, st, -cyc * reach, p, H, gait, true);

    /* ── TORSO ─────────────────────────────────────────────────────────
       Shoulders down through the lats to the waist, as a curve. A trapezoid
       is a sack; a man has a shape. */
    var g = ctx.createLinearGradient(-padW, shoY, padW * 0.55, hipY);
    g.addColorStop(0, shade(k.jersey, 0.12));
    g.addColorStop(0.55, k.jersey);
    g.addColorStop(1, k.jerseyDark);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-padW * 0.86, shoY);
    ctx.quadraticCurveTo(-chW * 1.12, chestY, -wsW, waistY);
    ctx.quadraticCurveTo(-wsW * 1.04, hipY - H * 0.02, -hpW * 0.94, hipY + H * 0.01);
    ctx.lineTo(hpW * 0.94, hipY + H * 0.01);
    ctx.quadraticCurveTo(wsW * 1.04, hipY - H * 0.02, wsW, waistY);
    ctx.quadraticCurveTo(chW * 1.12, chestY, padW * 0.86, shoY);
    ctx.closePath();
    ctx.fill();
    /* a seam of shade down the near side so the chest has a front and a side */
    if (H > 16) {
      ctx.fillStyle = 'rgba(0,0,0,.14)';
      ctx.beginPath();
      ctx.moveTo(padW * 0.30, shoY);
      ctx.quadraticCurveTo(chW * 0.70, chestY, wsW * 0.66, waistY);
      ctx.lineTo(hpW * 0.94, hipY + H * 0.01);
      ctx.quadraticCurveTo(wsW * 1.04, hipY - H * 0.02, wsW, waistY);
      ctx.quadraticCurveTo(chW * 1.12, chestY, padW * 0.86, shoY);
      ctx.closePath();
      ctx.fill();
    }

    /* the number, and it is on his back when he is running away from you */
    if (p.num != null && H > 26) {
      var txt = String(p.num);
      var fs = Math.min(H * 0.150, (chW * 1.8) / Math.max(1, txt.length) * 1.25);
      ctx.fillStyle = rgba(k.ink, 0.92);
      ctx.font = '800 ' + Math.round(fs) + 'px "Space Grotesk", "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.save();
      /* paint on cloth follows the chest round, so it narrows as he turns */
      ctx.scale(back ? 1 : side ? 0.62 : 0.92, 1);
      ctx.fillText(txt, 0, chestY * 0.36 + waistY * 0.64);
      ctx.restore();
    }

    /* ── SHOULDER PADS, a yoke over the top of the jersey ──────────────── */
    ctx.fillStyle = shade(k.jersey, 0.10);
    ctx.beginPath();
    ctx.moveTo(-padW, shoY + H * 0.026);
    ctx.quadraticCurveTo(-padW * 1.02, shoY - H * 0.052, -padW * 0.54, shoY - H * 0.060);
    ctx.quadraticCurveTo(0, shoY - H * 0.082, padW * 0.54, shoY - H * 0.060);
    ctx.quadraticCurveTo(padW * 1.02, shoY - H * 0.052, padW, shoY + H * 0.026);
    ctx.quadraticCurveTo(0, shoY + H * 0.060, -padW, shoY + H * 0.026);
    ctx.closePath();
    ctx.fill();
    if (H > 18) {
      ctx.strokeStyle = rgba(k.trim, 0.55);
      ctx.lineWidth = Math.max(0.7, H * 0.010);
      ctx.stroke();
      /* the collar: a band of the club's other colour right under the helmet,
         which is what actually separates a head from a set of shoulders */
      ctx.fillStyle = rgba(k.collar || k.trim, 0.85);
      roundRect(ctx, -padW * 0.34, shoY - H * 0.062, padW * 0.68, H * 0.030, H * 0.014);
      ctx.fill();
    }

    /* ── THE NEAR ARM, in front ────────────────────────────────────────── */
    armOf(ctx, 1, padW, shoY, upW, foW, k, st, cyc * reach, p, H, gait, false);

    /* a neck, so the helmet is attached to the man rather than resting on him */
    ctx.fillStyle = 'rgba(0,0,0,.30)';
    roundRect(ctx, -hr * 0.34, headY + hr * 0.55, hr * 0.68, shoY - headY - hr * 0.35, hr * 0.2);
    ctx.fill();

    /* ── HELMET ────────────────────────────────────────────────────────
       Taller than it is wide, with a jaw at the front and the facemask
       hung off it. A circle reads as a head; this reads as equipment. */
    ctx.save();
    ctx.translate(side * hr * 0.10, headY);
    var hg = ctx.createRadialGradient(-hr * 0.40, -hr * 0.45, hr * 0.10, 0, 0, hr * 1.25);
    hg.addColorStop(0, shade(k.helmet, 0.42));
    hg.addColorStop(0.62, k.helmet);
    hg.addColorStop(1, k.helmetDark);
    ctx.fillStyle = hg;
    ctx.beginPath();
    ctx.ellipse(0, 0, hr * 0.98, hr * 1.06, 0, 0, 6.2832);
    ctx.fill();
    /* the jaw, forward of the crown, which is what makes it a helmet */
    if (!back) {
      ctx.beginPath();
      ctx.ellipse(side * hr * 0.30, hr * 0.34, hr * 0.72, hr * 0.60, 0, 0, 6.2832);
      ctx.fill();
    }
    if (H > 15) {
      ctx.strokeStyle = 'rgba(0,0,0,.40)';
      ctx.lineWidth = Math.max(0.6, hr * 0.11);
      ctx.beginPath();
      ctx.ellipse(0, 0, hr * 0.98, hr * 1.06, 0, 0, 6.2832);
      ctx.stroke();
    }
    /* the stripe down the crown */
    ctx.fillStyle = rgba(k.trim, 0.9);
    roundRect(ctx, -hr * 0.14, -hr * 1.05, hr * 0.28, hr * (back ? 1.75 : 0.80), hr * 0.13);
    ctx.fill();
    if (!back) {
      /* THE FACEMASK IS A HOLE WITH BARS ACROSS IT. Drawn as bright strokes
         it read as a wide white smile on every man on the field; what the eye
         actually sees at twenty yards is the dark of the opening, with the
         cage catching a little light in front of it. */
      var fx = side * hr * 0.26;
      ctx.fillStyle = 'rgba(16,20,26,.62)';
      ctx.beginPath();
      ctx.ellipse(fx, hr * 0.56, hr * 0.40, hr * 0.26, 0, 0, 6.2832);
      ctx.fill();
      if (H > 24) {
        ctx.strokeStyle = 'rgba(198,208,220,.45)';
        ctx.lineWidth = Math.max(0.6, hr * 0.075);
        ctx.beginPath();
        ctx.moveTo(fx - hr * 0.36, hr * 0.52);
        ctx.lineTo(fx + hr * 0.36, hr * 0.52);
        ctx.stroke();
      }
    }
    ctx.restore();

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
      ctx.arc(0, 0, H * 0.34, 0, 6.2832);
      ctx.strokeStyle = p.sel ? (p.selColor || 'rgba(84,240,158,.95)') : 'rgba(255,255,255,.88)';
      ctx.lineWidth = Math.max(1.8, H * 0.052);
      ctx.stroke();
      if (p.carry && p.sel) {
        ctx.beginPath();
        ctx.arc(0, 0, H * 0.47, 0, 6.2832);
        ctx.strokeStyle = 'rgba(245,190,50,.50)';
        ctx.lineWidth = Math.max(1, H * 0.028);
        ctx.stroke();
      }
      ctx.restore();
      if (p.label && H > 26) {
        var lf = Math.max(8, Math.round(H * 0.19));
        ctx.font = '700 ' + lf + 'px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        var lw = ctx.measureText(p.label).width + lf * 0.9;
        var ly = H * 0.34 * squash + lf * 0.85;
        ctx.fillStyle = 'rgba(8,12,17,.80)';
        roundRect(ctx, -lw / 2, ly - lf * 0.65, lw, lf * 1.3, lf * 0.5);
        ctx.fill();
        ctx.fillStyle = p.sel ? '#54f09e' : '#f5f7fa';
        ctx.fillText(p.label, 0, ly);
      }
      ctx.restore();
    }
  }

  /* the range of tones on a football field, warm to deep */
  var SKIN = ['#c9a181', '#a87d5c', '#7d5637', '#5c3d27', '#8d6544', '#dcb894',
              '#6a4630', '#b8906c'];

  /* ── A PAIR OF LEGS ──────────────────────────────────────────────────────
     Thigh, knee, calf, boot. The far one first and darker, so there is a
     front and a back to him. */
  function legPair(ctx, hipY, kneeY, hipW, thW, clW, k, swing, lift, H, gait) {
    legOne(ctx, -hipW * 0.44, hipY, kneeY, thW, clW, k, -swing, lift, H, gait, true);
    legOne(ctx, hipW * 0.44, hipY, kneeY, thW, clW, k, swing, lift, H, gait, false);
  }
  function legOne(ctx, dx, hipY, kneeY, thW, clW, k, swing, lift, H, gait, far) {
    /* the knee is BELOW the hip, so this is positive and the thigh is drawn
       downward from it; drawn upward it put the legs inside the jersey and
       left the whole man hovering a stride above his own shadow */
    var thighL = kneeY - hipY;
    ctx.save();
    ctx.translate(dx, hipY);
    /* the thigh swings from the hip */
    var hipA = swing * 0.62;
    ctx.rotate(hipA);
    ctx.fillStyle = far ? shade(k.pants, -0.22) : k.pants;
    roundRect(ctx, -thW, 0, thW * 2, thighL, thW * 0.8);
    ctx.fill();
    /* and the shin folds behind it — a leg that never bends is a stilt */
    ctx.translate(0, thighL);
    var kneeA = gait === 'backpedal' ? -Math.abs(swing) * 0.9 - 0.18
              : -Math.max(0, -swing) * 1.15 - lift * 0.30;
    ctx.rotate(kneeA);
    var shinL = -kneeY * 0.86;
    ctx.fillStyle = far ? shade(k.pants, -0.30) : shade(k.pants, -0.06);
    roundRect(ctx, -clW * 0.92, 0, clW * 1.84, shinL * 0.42, clW * 0.7);
    ctx.fill();
    ctx.fillStyle = far ? shade(k.sock, -0.24) : k.sock;
    roundRect(ctx, -clW * 0.80, shinL * 0.50, clW * 1.6, shinL * 0.36, clW * 0.5);
    ctx.fill();
    /* the boot, and it points the way the shin does */
    ctx.fillStyle = far ? '#0d1015' : '#191f27';
    roundRect(ctx, -clW * 0.95, shinL * 0.85, clW * 2.3, shinL * 0.19, clW * 0.55);
    ctx.fill();
    ctx.restore();
  }

  /* ── AN ARM ──────────────────────────────────────────────────────────────
     Upper arm from the pad, forearm from the elbow, a hand on the end. What
     the arms are doing is most of what tells you what a man is doing. */
  function armOf(ctx, sd, padW, shoY, upW, foW, k, state, cyc, p, H, gait, far) {
    var upA, elA;
    /* ARMS THAT REACH FORWARD ARE FORESHORTENED. Swung out to the horizontal
       a blocker looked like a scarecrow; what he is actually doing is putting
       his hands into a man in front of him, which from a camera behind him is
       a short arm, not a wide one. */
    var squeeze = 1;
    if (state === 'block' || state === 'engaged') {
      upA = sd * -0.92; elA = sd * -0.30; squeeze = 0.70;
    } else if (state === 'shed') { upA = sd * -0.86; elA = sd * 0.50; squeeze = 0.78; }
    else if (state === 'tackle') { upA = sd * -0.98; elA = sd * -0.48; squeeze = 0.74; }
    else if (state === 'catch') {
      /* CHEST, HANDS, OVERHEAD, OR REACHING FOR IT. One pose for every
         completion made every completion look like the same completion. */
      var ck = p.catchKind || 'chest';
      if (ck === 'high') { upA = sd * -2.10; elA = sd * -0.16; squeeze = 1.02; }
      else if (ck === 'back') { upA = sd * -1.86; elA = sd * -0.10; squeeze = 0.94; }
      else if (ck === 'reachR') { upA = (sd > 0 ? -1.98 : -1.05) * sd; elA = sd * -0.20; }
      else if (ck === 'reachL') { upA = (sd < 0 ? -1.98 : -1.05) * sd; elA = sd * -0.20; }
      else { upA = sd * -1.28; elA = sd * -0.86; squeeze = 0.82; }
    }
    else if (state === 'celebrate') { upA = sd * -2.35; elA = sd * -0.20; }
    else if (state === 'throw') {
      /* COCK, THROW, FOLLOW THROUGH. Held in the cocked pose the whole time
         he was in it, the arm never actually threw anything — the ball simply
         appeared in the air beside a man doing a statue. It comes over now. */
      var tw = clamp((p.throwT == null ? 0.3 : p.throwT) / 0.34, 0, 1);
      var arc = tw < 0.34 ? -2.45 + tw * 0.9 : -2.15 + (tw - 0.34) * 3.1;
      if (sd === (p.hand || 1)) { upA = sd * arc; elA = sd * (-1.05 + tw * 1.35); }
      else { upA = sd * (-0.95 + tw * 0.5); elA = sd * -0.20; }
      squeeze = 0.88;
    } else if (p.carry) {
      /* the ball is tucked in one arm and the other one runs */
      if (sd === (p.hand || 1)) { upA = sd * -0.58; elA = sd * -1.25; }
      else { upA = sd * (0.20 + cyc * 0.85); elA = sd * -0.70 - Math.abs(cyc) * 0.35; }
    } else if (state === 'stance') {
      /* hands on the thighs, or down by the ball if he plays in the trenches */
      if (p.pos === 'OL' || p.pos === 'DL') { upA = sd * -0.22; elA = sd * 0.46; }
      else { upA = sd * 0.16; elA = sd * -0.62; }
    } else if (gait === 'backpedal') { upA = sd * (0.30 + cyc * 0.42); elA = sd * -1.05; }
    else if (gait === 'shuffle') { upA = sd * 0.42; elA = sd * -0.95; }
    else { upA = sd * (0.16 + cyc * 0.95); elA = sd * -0.62 - Math.abs(cyc) * 0.55; }

    ctx.save();
    ctx.translate(sd * padW * 0.72, shoY + H * 0.030);
    ctx.rotate(upA);
    var upL = H * 0.190 * squeeze;
    ctx.fillStyle = far ? shade(k.sleeve, -0.26) : k.sleeve;
    roundRect(ctx, -upW, 0, upW * 2, upL, upW * 0.85);
    ctx.fill();
    if (H > 20) {
      ctx.fillStyle = rgba(k.trim, far ? 0.45 : 0.72);
      roundRect(ctx, -upW, upL * 0.74, upW * 2, upL * 0.15, upW * 0.4);
      ctx.fill();
    }
    ctx.translate(0, upL);
    ctx.rotate(elA);
    var foL = H * 0.140 * squeeze;
    /* SKIN IS NOT ONE COLOUR. Twenty-two men in the same shade of tan is a
       tell nobody can name and everybody sees; the tone comes off his number
       so it is his, and it never changes between frames. */
    var sk = SKIN[(p.num == null ? 3 : (p.num * 7 + 3)) % SKIN.length];
    ctx.fillStyle = far ? shade(sk, -0.26) : sk;
    roundRect(ctx, -foW, 0, foW * 2, foL, foW * 0.9);
    ctx.fill();
    /* the hand */
    ctx.fillStyle = far ? shade(sk, -0.36) : shade(sk, -0.12);
    roundRect(ctx, -foW * 1.05, foL * 0.88, foW * 2.1, foL * 0.30, foW * 0.8);
    ctx.fill();
    ctx.restore();
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
      /* A CAPTION, NOT A CHIP. Three solid black pills over the field make the
         picture UI; the same three names set light over the grass, with just
         enough shadow to be read, leave the football first. */
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(6,10,14,.72)';
      ctx.lineWidth = nf * 0.42;
      ctx.strokeText(o.name, nx, cy - r - nf * 0.72);
      ctx.fillStyle = 'rgba(233,240,248,.88)';
      ctx.fillText(o.name, nx, cy - r - nf * 0.72);
    }
    ctx.restore();
    return { x: sx, y: cy, r: r * 1.7 };
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
      turf: ['#276139', '#194226'], apron: '#2b3a46', wall: '#39485a',
      deck: ['#46566a', '#33404f'], upper: '#232e3c',
      crowd: 1.00, paint: 0.90, grade: null, lights: false
    },
    dusk: {
      sky: ['#2c3550', '#7a5a63'], haze: 'rgba(150,124,120,',
      turf: ['#225a33', '#153a22'], apron: '#2a3038', wall: '#3a3a46',
      deck: ['#454150', '#2f2d3a'], upper: '#20202c',
      crowd: 0.82, paint: 0.82, grade: 'rgba(255,150,90,0.07)', lights: true
    },
    night: {
      sky: ['#05070d', '#0c1220'], haze: 'rgba(70,90,120,',
      turf: ['#256a3d', '#154226'], apron: '#1b2129', wall: '#242c37',
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
    /* HOW MANY PEOPLE DEPENDS ON HOW BIG THE STAND IS ON SCREEN. A fixed
       count fills a distant bowl and leaves a close one as a bare grey slab,
       which is what the far stand looked like from inside the red zone. */
    var L = o.light, i, s = seats();
    var area = Math.abs((o.bottom - o.top)) * cam.w;
    var n = clamp(Math.round(area / 21), 140, 1900);
    if (o.count) n = clamp(Math.round(n * (o.count / 600)), 120, 2200);
    var g = ctx.createLinearGradient(0, o.top, 0, o.bottom);
    g.addColorStop(0, L.deck[1]);
    g.addColorStop(0.55, L.deck[0]);
    g.addColorStop(1, shade(L.deck[0], -0.18));
    ctx.fillStyle = g;
    ctx.fill();                       /* the caller left the deck path ready */

    var excite = o.excite || 0, tick = o.tick || 0;
    /* MOST OF A STAND IS OFF THE EDGE OF THE PICTURE. Spreading a fixed budget
       of people evenly over the whole deck put nearly all of them outside the
       frame and left the visible sliver a bare grey slab — which is exactly
       what the far bowl looked like from the red zone. So keep drawing
       candidates until enough of them have actually landed on screen.

       And ONE FILL PER COLOUR, NOT PER PERSON: eighty thousand fillStyle
       changes are eighty thousand canvas state changes, and that — not the
       rectangles — is what made the establishing shot cost thirty-five
       milliseconds a frame. Each seat goes into the path of its colour
       bucket, and each bucket is filled once. */
    var BUCKETS = 14, bucket = [], bi;
    for (bi = 0; bi < BUCKETS; bi++) bucket.push(null);
    function bucketOf(k) {
      if (!bucket[k]) { bucket[k] = []; }
      return bucket[k];
    }

    var drawn = 0, tries = 0, cap = n * 7;
    for (i = 0; drawn < n && tries < cap; i++, tries++) {
      /* AND GIVE UP ON A STAND THAT IS NOT IN THE PICTURE. From the play lens
         the side bowls are entirely off the edge of the frame; without this
         the search for somewhere to put them costs forty thousand rejected
         candidates a frame, every frame, for nothing. */
      if (tries === 260 && drawn < 3) break;
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
      drawn++;
      /* a seat is about a third of a yard across; the floor keeps the far
         rows from disappearing into single sub-pixel specks that read as
         stars rather than as eighty thousand people */
      var sz = clamp(cam.scale(pt.y) * 0.20, 1.5, 5.0);
      /* the ones on their feet bounce; the rest are a texture */
      /* A STILL CROWD IS A PHOTOGRAPH OF A CROWD. The ones on their feet
         bounce; the rest are never quite motionless either. */
      var up = d[2] < excite;
      var bob = up ? Math.sin(tick * 7 + d[3] * 40) * sz * 0.9
                   : Math.sin(tick * 1.6 + d[3] * 24) * sz * 0.13;
      /* which shade of the crowd he is, and whether he is wearing a club */
      var band = d[2] < 0.34 ? 0 : d[2] < 0.67 ? 1 : 2;
      var key = d[3] < 0.20 ? 9 + band : d[3] < 0.32 ? 12 + (band > 1 ? 1 : band) : band * 3 + (up ? 1 : 0);
      bucketOf(key).push(sx - sz / 2, sy - sz - bob, sz * 0.86, sz * (up ? 1.45 : 1.1), d[2]);
    }
    /* A CROWD IS MOSTLY DARK. Eighty thousand coats read as one deep mass
       with faces and shirts catching the light out of it — paint them all
       bright and the stand turns into television static, which is what the
       first pass looked like. A third of them wear one club or the other. */
    for (bi = 0; bi < BUCKETS; bi++) {
      var list = bucket[bi];
      if (!list || !list.length) continue;
      var mid = list[4];                        /* the first seat sets the shade */
      var lum = (0.16 + mid * 0.62) * L.crowd;
      ctx.fillStyle = bi >= 12 ? rgba(o.tint2 || '#9aa6b8', (0.26 + mid * 0.44) * L.crowd)
        : bi >= 9 ? rgba(o.tint || '#9aa6b8', (0.26 + mid * 0.44) * L.crowd)
        : 'rgba(' + Math.round(158 * lum + 26) + ',' + Math.round(162 * lum + 29)
          + ',' + Math.round(178 * lum + 36) + ',' + (0.42 + mid * 0.46) + ')';
      ctx.beginPath();
      for (i = 0; i < list.length; i += 5) ctx.rect(list[i], list[i + 1], list[i + 2], list[i + 3]);
      ctx.fill();
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

    /* ── WHAT THE LIGHTS DO TO THE SKY ─────────────────────────────────
       A lit stadium at dusk does not sit under a clean gradient: it throws
       enough light back up that the air above the rim glows and the sky
       nearest the roofline is the brightest part of it. Drawn before any of
       the structure, so the bowl paints over whatever of it is not sky. */
    if (L.lights) {
      var rimY = cam.sy(yFar + BOWL.endDeep, BOWL.high + 9);
      if (rimY > 0 && rimY < H) {
        /* it hugs the rim: light thrown up off a bowl falls away fast, and a
           band half the picture tall stops being a glow and becomes fog */
        var top0 = Math.max(0, rimY - H * 0.30);
        var gl = ctx.createLinearGradient(0, top0, 0, rimY);
        gl.addColorStop(0, L.haze + '0)');
        gl.addColorStop(0.5, L.haze + '0.13)');
        gl.addColorStop(1, L.haze + '0.34)');
        ctx.fillStyle = gl;
        ctx.fillRect(0, top0, W, rimY - top0);
        /* and the masts bloom over the corners, where they stand */
        [0.12, 0.88].forEach(function (fx) {
          var r0 = W * 0.46;
          var bl = ctx.createRadialGradient(W * fx, rimY - H * 0.02, 2, W * fx, rimY - H * 0.02, r0);
          bl.addColorStop(0, 'rgba(255,247,220,.30)');
          bl.addColorStop(0.45, 'rgba(255,247,220,.09)');
          bl.addColorStop(1, 'rgba(255,247,220,0)');
          ctx.fillStyle = bl;
          ctx.fillRect(0, Math.max(0, rimY - r0), W, r0 + 4);
        });
      }
    }

    /* ── THE FAR STAND, WHEN THE LENS CANNOT REACH IT ────────────────────
       From the play camera the real bowl is off the top of the frame: the
       ground beyond the back line projects to negative screen y, and raising
       it only pushes it further up. Everything above the end line is sky, and
       a flat band of sky is exactly what "the field floats in empty space"
       looks like.

       So where the geometry cannot go, a backdrop does: a stand painted in
       screen space, anchored to the back line, sized to whatever room is
       left. It is a matte painting and it is honest about being one — the
       wide shot below draws the same stadium for real. */
    var line = cam.sy(FIELD.length + FIELD.endzone);
    /* ONLY WHERE THE REAL ONE CANNOT BE SEEN. From the wide shot the bowl IS
       in frame, and painting the matte over it laid a hard horizontal seam
       across the real stand. If the top of the far bowl projects inside the
       picture, the geometry has it covered and the backdrop stands down. */
    var bowlTop = cam.sy(yFar + BOWL.endDeep, BOWL.high);
    if (line > 6 && bowlTop < 0) {
      var top = Math.max(0, line - Math.min(H * 0.42, line));
      var band = line - top;
      var bg = ctx.createLinearGradient(0, top, 0, line);
      bg.addColorStop(0, L.upper);
      bg.addColorStop(0.35, L.deck[1]);
      bg.addColorStop(1, L.deck[0]);
      ctx.fillStyle = bg;
      ctx.fillRect(0, top, W, band);
      /* the roofline, and the vomitories punched through it */
      ctx.fillStyle = L.upper;
      ctx.fillRect(0, top, W, Math.max(2, band * 0.14));
      var sSeats = seats(), i2, drawn2 = 0;
      for (i2 = 0; i2 < 2600 && drawn2 < Math.round(W * band / 26); i2++) {
        var q = sSeats[i2 % sSeats.length];
        var rows = 16;
        var vv = (Math.floor(q[1] * rows) + 0.3 + q[2] * 0.4) / rows;
        var yy = top + band * (0.18 + vv * 0.78);
        var xx = q[0] * W;
        var szz = 1.6 + q[2] * 1.4;
        var upp = q[2] < excite;
        var bb = upp ? Math.sin(tick * 7 + q[3] * 40) * szz * 0.8 : 0;
        var lm = (0.42 + q[2] * 0.52) * L.crowd;
        ctx.fillStyle = q[3] < 0.28 && o.homeColor
          ? rgba(o.homeColor, (0.30 + q[2] * 0.45) * L.crowd)
          : 'rgba(' + Math.round(150 * lm + 40) + ',' + Math.round(155 * lm + 42)
            + ',' + Math.round(170 * lm + 48) + ',' + (0.5 + q[2] * 0.4) + ')';
        ctx.fillRect(xx, yy - bb, szz * 0.85, szz * (upp ? 1.4 : 1.1));
        drawn2++;
      }
      /* the wall the crowd sits behind */
      ctx.fillStyle = L.wall;
      ctx.fillRect(0, line - Math.max(3, band * 0.10), W, Math.max(3, band * 0.10));
    }

    /* ── THE FAR END: apron, wall, bowl ──────────────────────────────── */
    var fy = yFar, fd = yFar + BOWL.endDeep;
    ctx.fillStyle = L.upper;
    quad3(ctx, cam, [-70, fd, BOWL.high + 9], [hw + 70, fd, BOWL.high + 9],
                    [hw + 70, fd, 0], [-70, fd, 0]);
    ctx.fill();
    quad3(ctx, cam, [-46, fy, BOWL.wall], [hw + 46, fy, BOWL.wall],
                    [hw + 62, fd, BOWL.high], [-62, fd, BOWL.high]);
    bank(ctx, cam, { light: L, tick: tick, excite: excite, count: 420, offset: 0,
      top: cam.sy(fd, BOWL.high), bottom: cam.sy(fy, BOWL.wall), yNear: yNear, tint: o.homeTint || o.homeColor, tint2: o.awayTint || o.awayColor,
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
        yNear: yNear, tint: o.homeTint || o.homeColor, tint2: o.awayTint || o.awayColor,
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

    /* ── THE SCOREBOARD, up on the far deck ────────────────────────────
       Every stadium has one and it is the brightest thing in the building
       after the field. Only drawn where it can be seen — from the play lens
       it is a long way above the top of the picture. */
    var sbY = cam.sy(yFar + BOWL.endDeep * 0.55, BOWL.high + 6);
    var sbB = cam.sy(yFar + BOWL.endDeep * 0.55, BOWL.high + 1.2);
    if (sbY > -20 && sbY < H && sbB > sbY + 3) {
      var sbL = cam.sx(hw / 2 - 17, yFar + BOWL.endDeep * 0.55);
      var sbR = cam.sx(hw / 2 + 17, yFar + BOWL.endDeep * 0.55);
      ctx.fillStyle = '#0a0d12';
      roundRect(ctx, sbL, sbY, sbR - sbL, sbB - sbY, (sbB - sbY) * 0.12);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.6)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      /* the panel itself, glowing, with a band of the home club's colour */
      var pad2 = (sbB - sbY) * 0.16;
      var sg2 = ctx.createLinearGradient(0, sbY, 0, sbB);
      sg2.addColorStop(0, L.lights ? 'rgba(46,60,52,.95)' : 'rgba(30,38,34,.95)');
      sg2.addColorStop(1, L.lights ? 'rgba(22,32,28,.95)' : 'rgba(18,24,22,.95)');
      ctx.fillStyle = sg2;
      ctx.fillRect(sbL + pad2, sbY + pad2, (sbR - sbL) - pad2 * 2, (sbB - sbY) - pad2 * 2);
      if (o.homeTint) {
        ctx.fillStyle = rgba(o.homeTint, L.lights ? 0.55 : 0.30);
        ctx.fillRect(sbL + pad2, sbB - pad2 * 2.2, (sbR - sbL) - pad2 * 2, pad2 * 1.1);
      }
      if (L.lights) {
        var glw = ctx.createRadialGradient((sbL + sbR) / 2, (sbY + sbB) / 2, 2,
                                           (sbL + sbR) / 2, (sbY + sbB) / 2, (sbR - sbL) * 0.75);
        glw.addColorStop(0, 'rgba(150,220,190,.16)');
        glw.addColorStop(1, 'rgba(150,220,190,0)');
        ctx.fillStyle = glw;
        ctx.fillRect(sbL - (sbR - sbL) * 0.4, sbY - (sbB - sbY), (sbR - sbL) * 1.8, (sbB - sbY) * 3);
      }
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
  function goalposts(ctx, cam, y, color, o) {
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
    /* THE RIBBONS, which are the only thing on a football field that tells you
       what the wind is doing. Two of them, on the tops of the uprights,
       streaming the way it blows and fluttering at the rate it blows. */
    if (o && o.wind > 0.02) {
      var t2 = o.tick || 0;
      var flow = (o.windX >= 0 ? 1 : -1) * clamp(o.wind, 0, 1);
      ctx.strokeStyle = 'rgba(240,224,120,.85)';
      ctx.lineWidth = Math.max(0.9, cam.lat(y) * 0.10);
      [-halfW, halfW].forEach(function (dx, i) {
        var x0 = cam.sx(cx + dx, y), y0 = cam.sy(y, up);
        var L2 = Math.max(4, cam.lat(y) * 1.5);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.quadraticCurveTo(
          x0 + flow * L2 * 0.55,
          y0 + Math.sin(t2 * 5.5 + i * 2.1) * L2 * 0.22,
          x0 + flow * L2,
          y0 + Math.sin(t2 * 5.5 + i * 2.1 + 0.9) * L2 * 0.30);
        ctx.stroke();
      });
    }
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
        /* NOBODY ON A SIDELINE IS STANDING PERFECTLY STILL. A row of frozen
           figures beside a moving game is the thing that says "backdrop"; a
           quarter of an inch of sway, each man on his own phase, and the
           touchline is populated rather than printed. */
        var sway = Math.sin((o.tick || 0) * (1.1 + jitter * 0.9) + i * 1.7)
                 * h * (coach ? 0.020 : 0.034);
        var bob = Math.abs(Math.sin((o.tick || 0) * (0.9 + jitter * 0.7) + i * 2.3)) * h * 0.018;
        /* a shadow, a body, a head — three shapes and they read as people */
        ctx.fillStyle = 'rgba(0,0,0,.30)';
        ctx.beginPath();
        ctx.ellipse(px, py, h * 0.20, h * 0.07, 0, 0, 6.2832);
        ctx.fill();
        ctx.fillStyle = coach ? '#1c222b' : rgba(kit || '#3fb883', 0.55);
        roundRect(ctx, px + sway - h * 0.21, py - bob - h * 0.74, h * 0.42, h * 0.58 + bob, h * 0.12);
        ctx.fill();
        ctx.fillStyle = coach ? '#33404e' : shade(kit || '#3fb883', -0.35);
        ctx.beginPath();
        ctx.arc(px + sway * 1.35, py - bob - h * 0.84, h * 0.155, 0, 6.2832);
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
    /* HAZE IS DISTANCE, NOT HEIGHT ON THE SCREEN. Fading everything above the
       line of scrimmage washed the end zone thirty yards away into a pink rug
       — the club's paint disappeared under it. Only what is a long way past
       the shot gets any, and much less of it. */
    var fade = cam.sy(cam.y + 30);
    if (fade < 2) return;
    var g = ctx.createLinearGradient(0, 0, 0, fade);
    g.addColorStop(0, L.haze + '0.26)');
    g.addColorStop(0.55, L.haze + '0.08)');
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

    /* ── THE LIGHT ON IT ───────────────────────────────────────────────
       A field lit evenly from edge to edge is a texture; a field lit from a
       ring of masts is a place. The middle of the picture takes the light and
       the corners fall away from it, which is the single cheapest thing that
       makes flat green look like grass under a stadium. */
    var midY = (Math.max(yNear, 0) + Math.min(yFar, 100)) / 2;
    var cx = cam.sx(FIELD.half, midY), cy = cam.sy(midY);
    var rad = Math.max(W, H) * 0.86;
    var pool = ctx.createRadialGradient(cx, cy * 0.92, rad * 0.10, cx, cy * 0.92, rad);
    pool.addColorStop(0, 'rgba(255,251,232,.085)');
    pool.addColorStop(0.42, 'rgba(255,248,225,.025)');
    pool.addColorStop(0.78, 'rgba(0,0,0,.08)');
    pool.addColorStop(1, 'rgba(0,0,0,.22)');
    ctx.fillStyle = pool;
    ground(-14, FIELD.width + 14, yNear, yFar);
    ctx.fill();

    /* ── WEAR AND GRAIN ────────────────────────────────────────────────
       A field is not a colour swatch. It is played on down the middle and
       hardly at all near the sidelines, and by the fourth quarter the strip
       between the hashes is a shade browner than the rest of it. And no grass
       anywhere is one flat tone: a few hundred seeded specks give it a
       surface the eye reads as depth without ever being able to name why. */
    var wearA = Math.max(yNear, 8), wearB = Math.min(yFar, 92);
    if (wearB > wearA) {
      /* IT HAS TO FALL OFF AT BOTH ENDS AS WELL AS BOTH SIDES. Faded across
         and cut square top and bottom, the worn strip read as a rectangle
         somebody had painted on the grass. A pool centred on midfield fades
         everywhere at once. */
      var wcx = cam.sx(FIELD.half, 50), wcy = cam.sy(50);
      var wr = Math.max(cam.w, cam.h) * 0.62;
      var wg = ctx.createRadialGradient(wcx, wcy, wr * 0.05, wcx, wcy, wr);
      wg.addColorStop(0, 'rgba(104,84,52,.17)');
      wg.addColorStop(0.55, 'rgba(104,84,52,.09)');
      wg.addColorStop(1, 'rgba(104,84,52,0)');
      ctx.fillStyle = wg;
      ground(FIELD.half - 12, FIELD.half + 12, wearA, wearB);
      ctx.fill();
    }
    /* TWO FILLS, NOT FOUR HUNDRED. Every speck setting its own fillStyle is
       four hundred canvas state changes a frame — the same mistake that once
       cost the establishing shot thirty-five milliseconds. Light and dark go
       into one path each. */
    var gr = seats(), gi, gN = clamp(Math.round(W * H / 900), 90, 420);
    var grTop = cam.sy(Math.min(yFar, 100));
    var pass2;
    for (pass2 = 0; pass2 < 2; pass2++) {
      ctx.fillStyle = pass2 ? 'rgba(0,0,0,.030)' : 'rgba(255,255,255,.022)';
      ctx.beginPath();
      for (gi = 0; gi < gN; gi++) {
        var q3 = gr[(gi * 13 + 5) % gr.length];
        if ((q3[3] < 0.5 ? 0 : 1) !== pass2) continue;
        var gyy = q3[1] * H;
        if (gyy < grTop) continue;
        ctx.rect(q3[0] * W, gyy, 1.4 + q3[2] * 2.4, 1.0 + q3[2] * 1.2);
      }
      ctx.fill();
    }

    /* ── END ZONES ─────────────────────────────────────────────────────── */
    /* THE FAR END ZONE BELONGS TO THE MEN DEFENDING IT. You drive toward
       their paint, not your own — and from this lens that block of colour is
       the top third of every picture the game shows. */
    endzone(ctx, cam, 100, 110, o.awayColor || '#2a1a2f', o.awayName || '', false,
      yNear, yFar, o.awayInk);
    endzone(ctx, cam, -10, 0, o.homeColor || '#123326', o.homeName || '', true,
      yNear, yFar, o.homeInk);

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
    var Wx = weatherOf(o.weather);
    var wind = { tick: o.tick || 0, wind: Wx.wind, windX: 1 };
    goalposts(ctx, cam, 100, '#f2c744', wind);
    goalposts(ctx, cam, 0, '#f2c744', wind);
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

  /* ── AN END ZONE, PAINTED ────────────────────────────────────────────────
     Ten yards of the club's own colour with its name across it, the way a
     groundsman lays it down: a deep base, a mown chevron through it so it is
     not a flat slab of paint, a bright wordmark, and the heavy white border
     that closes the field. From the play camera this block fills the top
     third of the picture, so what it looks like IS what the game looks like.
     `ink` is the colour the name is painted in; it has to survive being seen
     from ninety yards away, so it is the loud one. */
  function endzone(ctx, cam, from, to, color, name, flip, yNear, yFar, ink) {
    var a = Math.max(Math.min(from, to), yNear), b = Math.min(Math.max(from, to), yFar);
    if (b <= a) return;
    function quad(x0, x1, ya, yb) {
      ctx.beginPath();
      ctx.moveTo(cam.sx(x0, ya), cam.sy(ya));
      ctx.lineTo(cam.sx(x1, ya), cam.sy(ya));
      ctx.lineTo(cam.sx(x1, yb), cam.sy(yb));
      ctx.lineTo(cam.sx(x0, yb), cam.sy(yb));
      ctx.closePath();
    }
    /* the base coat: lit from the near edge, falling away to the back line */
    /* Only ever DARKER, never nearer white: mixing paint toward white takes
       the colour out of it, and ten yards of desaturated club colour is a rug,
       not an end zone. */
    var g = ctx.createLinearGradient(0, cam.sy(b), 0, cam.sy(a));
    g.addColorStop(0, shade(color, -0.36));
    g.addColorStop(0.55, color);
    g.addColorStop(1, shade(color, -0.18));
    ctx.fillStyle = g;
    quad(0, FIELD.width, a, b);
    ctx.fill();

    /* THE MOW. Paint on grass is still grass: the roller leaves the same
       two-yard bands here it leaves on the field, and without them ten yards
       of one colour reads as a printed rectangle. */
    ctx.save();
    ctx.beginPath();
    quad(0, FIELD.width, a, b);
    ctx.clip();
    var lo = Math.min(from, to), s2;
    for (s2 = 0; s2 < 5; s2++) {
      var ya = lo + s2 * 2, yb = ya + 1;
      if (yb <= a || ya >= b) continue;
      ctx.fillStyle = 'rgba(255,255,255,.035)';
      quad(0, FIELD.width, Math.max(ya, a), Math.min(yb, b));
      ctx.fill();
    }
    ctx.restore();

    /* GRAIN. A perfectly even fill is printed; grass is not. A few hundred
       specks of light and dark, seeded so they never crawl between frames,
       are the difference between paint and a swatch. */
    var y0 = cam.sy(b), y1 = cam.sy(a);
    /* and only as much of it as there is end zone to see: from the far end of
       a wide shot this block is thirty pixels tall and three hundred specks
       of grain in it are three hundred draws nobody can make out */
    var grains = clamp(Math.round(Math.abs(y1 - y0) * 1.1), 0, 240);
    ctx.save();
    ctx.beginPath();
    quad(0, FIELD.width, a, b);
    ctx.clip();
    var sp = seats(), k2;
    for (k2 = 0; k2 < grains; k2++) {
      var q2 = sp[(k2 * 7 + 11) % sp.length];
      var gy = y0 + (y1 - y0) * q2[1];
      var gw = cam.w;
      ctx.fillStyle = q2[3] < 0.5 ? 'rgba(255,255,255,.030)' : 'rgba(0,0,0,.045)';
      ctx.fillRect(q2[0] * gw, gy, 1.6 + q2[2] * 2.6, 1.1 + q2[2] * 1.3);
    }
    ctx.restore();

    /* the white border the field is closed with: back line and both edges */
    var back = flip ? lo : lo + 10;
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.lineWidth = Math.max(1.2, 0.30 * cam.lat(back));
    if (back >= yNear && back <= yFar) {
      ctx.beginPath();
      ctx.moveTo(cam.sx(0, back), cam.sy(back));
      ctx.lineTo(cam.sx(FIELD.width, back), cam.sy(back));
      ctx.stroke();
    }

    if (!name) return;
    var mid = (a + b) / 2, lat = cam.lat(mid), fore = cam.fore(mid);
    if (lat < 1.6) return;
    ctx.save();
    ctx.translate(cam.sx(FIELD.half, mid), cam.sy(mid));
    ctx.scale(1, Math.max(0.14, Math.min(1, fore / lat)));
    if (flip) ctx.rotate(Math.PI);
    var txt = String(name).toUpperCase();
    ctx.font = '800 ' + Math.max(7, Math.round(lat * 3.0)) + 'px "Space Grotesk", Inter, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    /* keep it inside the sidelines however long the club is called */
    var fits = ctx.measureText(txt).width, room = FIELD.width * 0.80 * lat;
    if (fits > room) ctx.scale(room / fits, 1);
    /* letters this far away need an edge or they dissolve into the paint */
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(8,14,12,.45)';
    ctx.lineWidth = Math.max(1.2, lat * 0.30);
    ctx.strokeText(txt, 0, 0);
    ctx.fillStyle = rgba(ink || '#ffffff', 0.94);
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
      var first = p.pts[0], last = p.pts[p.pts.length - 1];
      var x0 = cam.sx(first[0], first[1]), y0 = cam.sy(first[1]);
      var x1 = cam.sx(last[0], last[1]), y1 = cam.sy(last[1]);
      /* A LINE THAT FADES IS A BROADCAST; A LINE THAT DOES NOT IS A DIAGRAM.
         Play art belongs to the man it comes out of, so it is brightest at his
         feet and gone by the end of the route — which is also honest, because
         where he ends up has not happened yet. */
      var col = p.color || '#ffffff';
      var grad;
      try {
        grad = ctx.createLinearGradient(x0, y0, x1, y1);
        grad.addColorStop(0, rgba(col, 0.62));
        grad.addColorStop(0.55, rgba(col, 0.34));
        grad.addColorStop(1, rgba(col, 0.10));
        ctx.strokeStyle = grad;
      } catch (_) { ctx.strokeStyle = rgba(col, 0.40); }
      /* play art is a coach's line drawn on the grass, not a road marking:
         it follows the perspective but stays a hairline */
      var lw = (p.width || 2.4) * cam.lat(first[1]) / 15;
      ctx.lineWidth = lw < 1.1 ? 1.1 : lw > 3.2 ? 3.2 : lw;
      ctx.setLineDash(p.dash === false ? [] : [5, 6]);
      ctx.beginPath();
      p.pts.forEach(function (q, i) {
        var x = cam.sx(q[0], q[1]), y = cam.sy(q[1]);
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
      if (p.arrow !== false) arrowHead(ctx, cam, p.pts[p.pts.length - 2], last, rgba(col, 0.30));
    });
  }
  function arrowHead(ctx, cam, a, b, color) {
    var x1 = cam.sx(a[0], a[1]), y1 = cam.sy(a[1]);
    var x2 = cam.sx(b[0], b[1]), y2 = cam.sy(b[1]);
    var ang = Math.atan2(y2 - y1, x2 - x1);
    var s = Math.max(3.2, Math.min(6.5, cam.lat(b[1]) * 0.40));
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - s * Math.cos(ang - 0.45), y2 - s * Math.sin(ang - 0.45));
    ctx.lineTo(x2 - s * Math.cos(ang + 0.45), y2 - s * Math.sin(ang + 0.45));
    ctx.closePath(); ctx.fill();
  }

  var API = {
    FIELD: FIELD, BODY: BODY, BUILD: BUILD, SKELETON: SK,
    camera: camera, uniform: uniform, shade: shade, readable: readable, rgba: rgba, hex: hex,
    player: player, target: target, ball: ball,
    stadium: stadium, goalposts: goalposts, sidelines: sidelines,
    atmosphere: atmosphere, conditions: conditions, LIGHT: LIGHT, WEATHER: WEATHER, field: field, markers: markers, art: art, roundRect: roundRect
  };
  root.EDGridironPaint = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
