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
      return { id: 'a' + p, jersey: '#e9edf3', jerseyDark: '#c2c9d4', pants: '#dee3ea',
               helmet: p, helmetDark: shade(p, -0.42), trim: p, ink: '#1a2029',
               sleeve: shade(p, -0.06), sock: p, collar: shade(p, -0.20) };
    }
    return { id: 'h' + p, jersey: p, jerseyDark: shade(p, -0.32), pants: shade(p, 0.70),
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
  /* two colours, t of the way from the first to the second */
  function mix(a, b, t) {
    var x = hex(a), y = hex(b), i, o = [];
    for (i = 0; i < 3; i++) o.push(Math.round(x[i] + (y[i] - x[i]) * t));
    return 'rgb(' + o[0] + ',' + o[1] + ',' + o[2] + ')';
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  /* ── CACHED PAINT ────────────────────────────────────────────────────────
     TWENTY-TWO MEN, SIX GRADIENTS EACH, SIXTY TIMES A SECOND is eight
     thousand gradient objects a second, and building them — not filling them
     — was two thirds of the cost of drawing a football team.

     Every one of them is drawn in the man's OWN coordinates (feet at the
     origin, head at minus H), so two men of the same build in the same kit at
     the same distance want the identical object. Key it on the kit and on the
     pixel height rounded to a yard of screen, and the whole front seven share
     three gradients between them. The cache is dropped whole when it gets
     big rather than evicted one at a time; it refills in a frame. */
  var GRAD = {}, GRADN = 0;
  function gradOf(ctx, key, make) {
    var g = GRAD[key];
    if (g) return g;
    if (GRADN > 700) { GRAD = {}; GRADN = 0; }
    g = make();
    GRAD[key] = g; GRADN++;
    return g;
  }
  /* THE SHADOW IS ONE SPRITE, NOT A GRADIENT PER MAN. A soft black blob is
     the same picture for everybody; it is built once at a fixed size and
     stamped at whatever scale a body needs. */
  var SHADOW = null;
  function shadowSprite() {
    if (SHADOW) return SHADOW;
    try {
      var c = (typeof document !== 'undefined' && document.createElement)
        ? document.createElement('canvas') : null;
      if (!c) return null;
      c.width = 64; c.height = 64;
      var g2 = c.getContext('2d');
      var rg = g2.createRadialGradient(32, 32, 3, 32, 32, 32);
      rg.addColorStop(0, 'rgba(0,0,0,.36)');
      rg.addColorStop(0.52, 'rgba(0,0,0,.20)');
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      g2.fillStyle = rg;
      g2.fillRect(0, 0, 64, 64);
      SHADOW = c;
    } catch (_) { SHADOW = null; }
    return SHADOW;
  }

  /* ── BUILD ───────────────────────────────────────────────────────────────
     A lineman is not a corner, and the difference has to be visible at twenty
     yards — in the SILHOUETTE, before any colour or number arrives. Six
     numbers per position: how tall he stands, how wide the pads flare, how
     much torso hangs under them, how thick the limbs are, how long the legs
     run, and how much of him is carried around the middle. A guard and a
     receiver are within two inches of each other in height and should never
     be mistaken for one another for a single frame. */
  var BUILD = {
    QB: { h: 1.01, pads: 1.00, torso: 0.98, limb: 0.97, leg: 1.03, gut: 0.00 },
    RB: { h: 0.95, pads: 1.07, torso: 1.05, limb: 1.06, leg: 0.97, gut: 0.02 },
    FB: { h: 0.97, pads: 1.20, torso: 1.17, limb: 1.16, leg: 0.94, gut: 0.12 },
    WR: { h: 1.05, pads: 0.90, torso: 0.86, limb: 0.88, leg: 1.09, gut: -0.05 },
    TE: { h: 1.08, pads: 1.13, torso: 1.09, limb: 1.09, leg: 1.02, gut: 0.03 },
    OL: { h: 1.06, pads: 1.34, torso: 1.32, limb: 1.28, leg: 0.92, gut: 0.24 },
    DL: { h: 1.06, pads: 1.29, torso: 1.24, limb: 1.25, leg: 0.94, gut: 0.16 },
    LB: { h: 1.00, pads: 1.13, torso: 1.09, limb: 1.10, leg: 0.99, gut: 0.04 },
    CB: { h: 0.99, pads: 0.88, torso: 0.84, limb: 0.87, leg: 1.10, gut: -0.06 },
    S:  { h: 1.01, pads: 0.95, torso: 0.92, limb: 0.92, leg: 1.05, gut: -0.03 },
    K:  { h: 0.99, pads: 0.92, torso: 0.90, limb: 0.91, leg: 1.05, gut: 0.00 },
    P:  { h: 0.99, pads: 0.92, torso: 0.90, limb: 0.91, leg: 1.05, gut: 0.00 }
  };
  function build(pos) { return BUILD[pos] || BUILD.LB; }

  /* ── THE SKELETON ────────────────────────────────────────────────────────
     Where the joints are, as fractions of standing height, feet on the grass
     at zero and the crown of the helmet at one.

     THE THREE THINGS THAT MAKE A SHAPE READ AS A FOOTBALL PLAYER, in order:
       1. SQUARE SHOULDERS, wider than anything else on him. Pads are a shell
          with a flat top and hard outer corners — not a pair of sloping
          deltoids. This is the whole silhouette; get it wrong and no amount
          of shading rescues the man.
       2. A HELMET THAT IS EQUIPMENT. Bigger than a head, deeper than it is
          tall, with a jaw that juts and a cage hung off the front of it.
       3. A GAP BETWEEN THE LEGS, with the pants cut off above the knee and a
          long sock under it. Two white pillars with no daylight between them
          is a chess piece.  */
  var SK = {
    foot: 0.000, ankle: 0.062, knee: 0.262, hip: 0.472,
    waist: 0.556, chest: 0.672, shoulder: 0.762, neck: 0.800,
    head: 0.918, crown: 1.000,
    padHalf: 0.192, chestHalf: 0.132, waistHalf: 0.104, hipHalf: 0.118,
    thighHalf: 0.068, calfHalf: 0.050, upperHalf: 0.046, foreHalf: 0.035,
    helmW: 0.104, helmH: 0.116
  };

  /* the height of a man on the field, in yards, before his build */
  var BODY = 2.6;

  /* the range of tones on a football field, warm to deep */
  var SKIN = ['#c9a181', '#a87d5c', '#7d5637', '#5c3d27', '#8d6544', '#dcb894',
              '#6a4630', '#b8906c'];
  function skinOf(p) {
    var n = p.num == null ? 7 : p.num;
    var s = (n * 37 + String(p.pos || 'LB').charCodeAt(0) * 11) % SKIN.length;
    return SKIN[s];
  }

  /* ── THE GAIT ────────────────────────────────────────────────────────────
     What he is doing, decided from how fast he is going and which way he is
     looking rather than from the state name — a corner opening his hips and a
     corner running a post are both 'run' to the simulation and have to look
     nothing alike. */
  function gaitOf(p, back) {
    var st = p.state, vx = p.vx || 0, vy = p.vy || 0;
    var spd = Math.sqrt(vx * vx + vy * vy), sn = clamp(spd / 9, 0, 1.25);
    if (st === 'block' || st === 'engaged') return { k: 'block', sn: sn };
    if (st === 'shed') return { k: 'shed', sn: sn };
    if (st === 'tackle') return { k: 'tackle', sn: sn };
    if (st === 'celebrate') return { k: 'celebrate', sn: sn };
    if (st === 'throw') return { k: 'throw', sn: sn };
    if (st === 'catch') return { k: 'catch', sn: sn };
    if (st === 'stance') return { k: 'stance', sn: 0 };
    if (sn < 0.09) return { k: 'idle', sn: sn };
    var retreat = back ? vy < -1.2 : vy > 1.2;
    if (retreat) return { k: 'backpedal', sn: sn };
    if (Math.abs(vx) > Math.abs(vy) * 1.7 && sn > 0.18) return { k: 'shuffle', sn: sn };
    return { k: sn < 0.30 ? 'walk' : sn < 0.62 ? 'jog' : 'sprint', sn: sn };
  }

  /* ── ONE FOOTBALL PLAYER ─────────────────────────────────────────────────
     p: { x, y, pos, kit, num, state, phase, face, lean, sel, carry, vx, vy,
          move, moveT, throwT, catchKind, fallT, fell, rep, engageX, engageY }

       state  stance | idle | run | block | engaged | shed | tackle | down
              | catch | throw | carry | celebrate
       phase  seconds, for the stride
       face   left | right | front | back

     Everything below is drawn back-to-front: far leg, far arm, torso, pads,
     near leg, near arm, helmet. Nothing here decides anything. */
  function player(ctx, p, cam) {
    /* ox/oy are a PRESENTATION nudge in yards — engagement offsets so two men
       in a block do not stand on the same blade of grass. The simulation
       never sees them; it is still one coordinate per man. */
    var wx = p.x + (p.ox || 0), wy = p.y + (p.oy || 0);
    var sx = cam.sx(wx, wy), sy = cam.sy(wy);
    if (sx < -110 || sx > cam.w + 110 || sy < -110 || sy > cam.h + 130) return;
    var b = build(p.pos), k = p.kit || uniform(null);
    var u = cam.scale(wy) * (p.scale || 1);                 /* pixels per yard here */
    if (u < 2.0) return;
    var H = BODY * b.h * u;                                 /* pixel height */
    var LOD = H;                                            /* how much detail is worth drawing */
    var back = p.face === 'back';
    var side = p.face === 'left' ? -1 : p.face === 'right' ? 1 : 0;
    var down = p.state === 'down';
    var g = gaitOf(p, back), gait = g.k, sn = g.sn;
    var ph = p.phase || 0;
    var skin = skinOf(p);

    /* STRIDE RATE FOLLOWS SPEED. A man jogging and a man at a dead sprint
       cycling their legs at the same rate is the single clearest tell that
       nothing on the screen has any weight. */
    var rate = gait === 'backpedal' ? 9 + sn * 9
             : gait === 'shuffle' ? 8 + sn * 7
             : 5.2 + sn * 10.0;
    var cyc = gait === 'idle' || gait === 'stance' ? 0
            : gait === 'block' || gait === 'shed' ? Math.sin(ph * 19) * 0.26
            : gait === 'tackle' ? 0.55
            : Math.sin(ph * rate);
    var reach = gait === 'idle' ? 0.05
              : gait === 'backpedal' ? 0.40
              : gait === 'shuffle' ? 0.34
              : gait === 'walk' ? 0.46
              : gait === 'jog' ? 0.76
              : gait === 'sprint' ? 1.06 : 0.20;

    /* ── THE STANCE ────────────────────────────────────────────────────
       NOBODY STANDS UP STRAIGHT BEFORE A SNAP, and a lineman does not stand
       at all — he has a hand in the grass. Three postures, and which one a
       man takes is his job: three-point in the trenches, a low two-point
       coil for a back or a linebacker, and a receiver up on his toes. */
    var lineman = p.pos === 'OL' || p.pos === 'DL';
    var threePt = gait === 'stance' && lineman;
    var coil = gait === 'stance' && (p.pos === 'LB' || p.pos === 'RB' || p.pos === 'FB'
      || p.pos === 'TE' || p.pos === 'S' || p.pos === 'CB');
    var crouch = threePt ? 0.150 : coil ? 0.072 : gait === 'stance' ? 0.030 : 0;
    if (gait === 'backpedal') crouch = 0.058;
    if (gait === 'block' || gait === 'engaged' || gait === 'shed') crouch = 0.085;
    if (gait === 'tackle') crouch = 0.100;
    if (gait === 'shuffle') crouch = 0.050;

    /* the body leans into what it is doing, and the lean is momentum */
    var lean = (p.lean || 0) * 0.52;
    if (threePt) lean += 0.42; else if (coil) lean += 0.16; else if (gait === 'stance') lean += 0.06;
    if (gait === 'sprint') lean += 0.19;
    else if (gait === 'jog') lean += 0.10;
    else if (gait === 'backpedal') lean -= 0.13;
    if (gait === 'block' || gait === 'shed') lean += 0.17;
    if (gait === 'tackle') lean += 0.30;
    if (p.move === 'truck') lean += 0.24;

    /* how flat a circle drawn on the turf looks from here */
    var squash = clamp(cam.fore(wy) / Math.max(0.001, cam.lat(wy)), 0.16, 0.70);

    /* ── THE SHADOW ────────────────────────────────────────────────────
       A hard black ellipse under a man is a base under a game piece. What a
       body on grass under stadium light actually casts is a soft pool,
       darkest right beneath him and gone by the width of his shoulders. */
    ctx.save();
    ctx.translate(sx, sy);
    ctx.save();
    ctx.scale(1, squash);
    var shR = H * (down ? 0.42 : 0.30);
    var shSprite = shadowSprite();
    if (shSprite) ctx.drawImage(shSprite, -shR, -shR, shR * 2, shR * 2);
    else {
      ctx.fillStyle = 'rgba(0,0,0,.24)';
      ctx.beginPath();
      ctx.arc(0, 0, shR * 0.7, 0, 6.2832);
      ctx.fill();
    }
    ctx.restore();

    /* THE MAN WITH THE FOOTBALL COMES OUT OF THE PILE. Six bodies inside two
       yards of each other and the one that matters is somewhere in the middle
       of them; a soft light behind him separates him without putting another
       badge on the screen. */
    if ((p.sel || p.carry) && !down) {
      var hal = ctx.createRadialGradient(0, -H * 0.52, H * 0.06, 0, -H * 0.52, H * 0.72);
      hal.addColorStop(0, p.sel ? 'rgba(84,240,158,.30)' : 'rgba(255,255,255,.22)');
      hal.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = hal;
      ctx.fillRect(-H * 0.78, -H * 1.26, H * 1.56, H * 1.5);
    }

    if (down) {
      /* ON THE GROUND, BUT NOT INSTANTLY. He was upright a tick ago; a body
         that snaps flat between two frames reads as a sprite being switched
         off. The fall eases over a third of a second, the legs go first and
         the shoulders follow, and he keeps sliding the way he was going. */
      var e = clamp((p.fallT == null ? 1 : p.fallT) / 0.34, 0, 1);
      e = e * e * (3 - 2 * e);
      ctx.translate(0, H * 0.11 * e);
      ctx.rotate((p.fell || 1) * 1.44 * e);
      ctx.scale(1 - 0.06 * e, 1 - 0.46 * e);
    } else {
      ctx.rotate(lean * 0.26);
      /* A CUT ROTATES THE BODY INTO IT. He does not slide sideways facing
         forwards; he plants and turns, and the shoulders go first. */
      if (p.move === 'juke' || p.move === 'spin') {
        ctx.rotate(clamp((p.cutDir || (p.vx > 0 ? 1 : -1)) * 0.26, -0.32, 0.32));
      }
    }

    /* ── THE JOINTS, in pixels, y negative upward ─────────────────────── */
    var legL = b.leg;
    var hipY = -H * SK.hip * legL;
    var kneeY = -H * SK.knee * legL;
    var ankY = -H * SK.ankle * legL;
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
      shoY += drop * 0.88; headY += drop * 0.70;
      kneeY += drop * 0.34;
    }
    var padW = H * SK.padHalf * b.pads;
    var chW = H * SK.chestHalf * b.torso;
    var wsW = H * SK.waistHalf * b.torso * (1 + b.gut * 0.55);
    var hpW = H * SK.hipHalf * b.torso;
    var thW = H * SK.thighHalf * b.limb;
    var clW = H * SK.calfHalf * b.limb;
    var upW = H * SK.upperHalf * b.limb;
    var foW = H * SK.foreHalf * b.limb;
    var hw = H * SK.helmW, hh = H * SK.helmH;

    /* ── LEGS ──────────────────────────────────────────────────────────── */
    var swing = cyc * reach;
    var lift = gait === 'sprint' ? 0.66 : gait === 'jog' ? 0.44 : gait === 'backpedal' ? 0.30 : 0.24;
    var stanceW = gait === 'shuffle' ? 1.75
                : gait === 'block' || gait === 'engaged' || gait === 'shed' ? 1.62
                : threePt ? 1.55 : coil ? 1.35 : gait === 'tackle' ? 1.30 : 1.08;
    /* A CUT IS A PLANT. The outside foot goes down hard and wide, the hips
       drop over it, and for a third of a second he is not running — he is
       changing direction. A body that slides sideways at the same stride is
       the clearest tell that nothing on the field has any weight. */
    if (p.move === 'juke' || p.move === 'spin') stanceW *= 1.55;
    if (p.move === 'truck') stanceW *= 1.18;
    var pose = { threePt: threePt, gait: gait, H: H, skin: skin, lod: LOD };

    legOne(ctx, -hpW * 0.50 * stanceW, hipY, kneeY, ankY, thW, clW, k, -swing, lift, pose, true);
    legOne(ctx, hpW * 0.50 * stanceW, hipY, kneeY, ankY, thW, clW, k, swing, lift, pose, false);

    /* ── PANTS over the hips ───────────────────────────────────────────── */
    ctx.fillStyle = k.pants;
    roundRect(ctx, -hpW * 1.08 * (stanceW * 0.35 + 0.66), hipY - H * 0.062,
      hpW * 2.16 * (stanceW * 0.35 + 0.66), H * 0.135, H * 0.048);
    ctx.fill();
    if (LOD > 28) {
      /* the belt: the one line that says the trousers are not the shirt */
      ctx.fillStyle = 'rgba(0,0,0,.26)';
      roundRect(ctx, -hpW * 1.02, hipY - H * 0.062, hpW * 2.04, H * 0.026, H * 0.012);
      ctx.fill();
    }

    /* ── THE FAR ARM, behind the body ──────────────────────────────────── */
    armOf(ctx, -1, padW, shoY, upW, foW, k, p, cyc * reach, H, gait, true, skin, LOD, side, back);

    /* ── TORSO ─────────────────────────────────────────────────────────
       Shoulders down through the lats to the waist. A football torso is a
       WEDGE — broad at the top, cut in at the ribs, and it does not narrow to
       a waspish waist because the pads and the jersey over them do not. */
    var HQ = Math.round(H), KID = (k.id || k.jersey) + '|' + HQ + '|' + Math.round(b.pads * 20);
    ctx.fillStyle = gradOf(ctx, 'torso' + KID, function () {
      var tg = ctx.createLinearGradient(-padW, shoY, padW * 0.62, hipY);
      tg.addColorStop(0, shade(k.jersey, 0.14));
      tg.addColorStop(0.52, k.jersey);
      tg.addColorStop(1, k.jerseyDark);
      return tg;
    });
    ctx.beginPath();
    ctx.moveTo(-padW * 0.90, shoY);
    ctx.quadraticCurveTo(-chW * 1.15, chestY, -wsW, waistY);
    ctx.quadraticCurveTo(-wsW * 1.06, hipY - H * 0.030, -hpW * 0.98, hipY + H * 0.010);
    ctx.lineTo(hpW * 0.98, hipY + H * 0.010);
    ctx.quadraticCurveTo(wsW * 1.06, hipY - H * 0.030, wsW, waistY);
    ctx.quadraticCurveTo(chW * 1.15, chestY, padW * 0.90, shoY);
    ctx.closePath();
    ctx.fill();
    /* a seam of shade down the near side so the chest has a front and a side */
    if (LOD > 30) {
      ctx.fillStyle = 'rgba(0,0,0,.13)';
      ctx.beginPath();
      ctx.moveTo(padW * 0.34, shoY);
      ctx.quadraticCurveTo(chW * 0.72, chestY, wsW * 0.68, waistY);
      ctx.lineTo(hpW * 0.98, hipY + H * 0.010);
      ctx.quadraticCurveTo(wsW * 1.06, hipY - H * 0.030, wsW, waistY);
      ctx.quadraticCurveTo(chW * 1.15, chestY, padW * 0.90, shoY);
      ctx.closePath();
      ctx.fill();
    }

    /* ── THE NUMBER ────────────────────────────────────────────────────
       On his back, because that is the side of him a camera behind the
       offence can see, and big — a broadcast number fills the shirt. */
    if (p.num != null && LOD > 25) {
      var txt = String(p.num);
      var fs = Math.min(H * 0.185, (chW * 2.05) / Math.max(1, txt.length) * 1.22);
      ctx.save();
      ctx.translate(0, chestY * 0.34 + waistY * 0.66);
      ctx.scale(back ? 1 : side ? 0.58 : 0.90, 1);
      ctx.font = '800 ' + Math.round(fs) + 'px "Space Grotesk", "JetBrains Mono", monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      if (LOD > 44) {
        ctx.lineWidth = Math.max(1, fs * 0.11);
        ctx.strokeStyle = rgba(k.numOutline || k.trim, 0.55);
        ctx.strokeText(txt, 0, 0);
      }
      ctx.fillStyle = rgba(k.ink, 0.94);
      ctx.fillText(txt, 0, 0);
      ctx.restore();
    }

    /* ── SHOULDER PADS ─────────────────────────────────────────────────
       THE ONE SHAPE THAT SAYS FOOTBALL. A hard shell over the top of the
       jersey: flat across, square at the outside, dropping into a cap over
       each arm. Drawn as a slope off the neck it reads as a man in a jumper,
       which is exactly what the last renderer looked like. */
    var padTop = shoY - H * 0.072, capY = shoY + H * 0.040;
    var pg = ctx.createLinearGradient(0, padTop, 0, capY + H * 0.02);
    pg.addColorStop(0, shade(k.jersey, 0.22));
    pg.addColorStop(0.62, shade(k.jersey, 0.04));
    pg.addColorStop(1, shade(k.jersey, -0.14));
    ctx.fillStyle = pg;
    ctx.beginPath();
    ctx.moveTo(-padW, capY);
    ctx.lineTo(-padW, padTop + H * 0.020);
    ctx.quadraticCurveTo(-padW, padTop, -padW * 0.80, padTop);
    ctx.lineTo(-padW * 0.30, padTop - H * 0.006);
    ctx.quadraticCurveTo(0, padTop - H * 0.020, padW * 0.30, padTop - H * 0.006);
    ctx.lineTo(padW * 0.80, padTop);
    ctx.quadraticCurveTo(padW, padTop, padW, padTop + H * 0.020);
    ctx.lineTo(padW, capY);
    ctx.quadraticCurveTo(padW * 0.55, capY + H * 0.024, 0, capY + H * 0.014);
    ctx.quadraticCurveTo(-padW * 0.55, capY + H * 0.024, -padW, capY);
    ctx.closePath();
    ctx.fill();
    if (LOD > 20) {
      /* a light along the top edge of the shell, and the seam where the arm
         cap is stitched on: two strokes, and the pads stop being a blob */
      ctx.strokeStyle = 'rgba(255,255,255,.20)';
      ctx.lineWidth = Math.max(0.6, H * 0.008);
      ctx.beginPath();
      ctx.moveTo(-padW * 0.78, padTop + H * 0.004);
      ctx.lineTo(padW * 0.78, padTop + H * 0.004);
      ctx.stroke();
      ctx.strokeStyle = rgba(k.trim, 0.42);
      ctx.lineWidth = Math.max(0.6, H * 0.010);
      ctx.beginPath();
      ctx.moveTo(-padW * 0.62, padTop + H * 0.012);
      ctx.lineTo(-padW * 0.62, capY);
      ctx.moveTo(padW * 0.62, padTop + H * 0.012);
      ctx.lineTo(padW * 0.62, capY);
      ctx.stroke();
    }

    /* ── THE NEAR ARM, in front ────────────────────────────────────────── */
    armOf(ctx, 1, padW, shoY, upW, foW, k, p, -cyc * reach, H, gait, false, skin, LOD, side, back);

    /* ── COLLAR AND NECK ───────────────────────────────────────────────
       A band of the club's other colour right under the helmet, which is
       what actually separates a head from a set of shoulders. */
    if (LOD > 16) {
      ctx.fillStyle = 'rgba(0,0,0,.34)';
      roundRect(ctx, -hw * 0.30, headY + hh * 0.42, hw * 0.60, padTop - headY - hh * 0.30, hw * 0.2);
      ctx.fill();
      ctx.fillStyle = rgba(k.collar || k.trim, 0.88);
      roundRect(ctx, -padW * 0.34, padTop - H * 0.004, padW * 0.68, H * 0.030, H * 0.014);
      ctx.fill();
    }

    /* ── HELMET ────────────────────────────────────────────────────────
       Equipment, not a head. A shell deeper than it is tall with a brow over
       the eyes, an ear hole, a stripe over the crown and a cage hung off the
       front of it. Turned away from you it is a smooth dome with a stripe;
       turned toward you the cage is the darkest thing on the man. */
    ctx.save();
    ctx.translate(side * hw * 0.16, headY);
    ctx.fillStyle = gradOf(ctx, 'helm' + KID, function () {
      var hg = ctx.createRadialGradient(-hw * 0.40, -hh * 0.48, hw * 0.10, 0, 0, hw * 1.5);
      hg.addColorStop(0, shade(k.helmet, 0.46));
      hg.addColorStop(0.58, k.helmet);
      hg.addColorStop(1, k.helmetDark);
      return hg;
    });
    ctx.beginPath();
    /* the shell: a dome that comes down over the ears and cuts back under
       the jaw, which is a helmet's profile and not a ball's */
    ctx.moveTo(-hw, hh * 0.10);
    ctx.quadraticCurveTo(-hw * 1.02, -hh * 0.72, 0, -hh * 0.94);
    ctx.quadraticCurveTo(hw * 1.02, -hh * 0.72, hw, hh * 0.10);
    ctx.quadraticCurveTo(hw * 0.96, hh * 0.72, hw * 0.40, hh * 0.86);
    ctx.quadraticCurveTo(0, hh * 0.98, -hw * 0.40, hh * 0.86);
    ctx.quadraticCurveTo(-hw * 0.96, hh * 0.72, -hw, hh * 0.10);
    ctx.closePath();
    ctx.fill();
    if (!back && LOD > 22) {
      /* the jaw, forward of the crown */
      ctx.fillStyle = shade(k.helmet, -0.10);
      ctx.beginPath();
      ctx.ellipse(side * hw * 0.26, hh * 0.40, hw * 0.78, hh * 0.52, 0, 0, 6.2832);
      ctx.fill();
    }
    /* the stripe over the crown */
    ctx.fillStyle = rgba(k.trim, 0.92);
    roundRect(ctx, -hw * 0.15, -hh * 0.96, hw * 0.30, hh * (back ? 1.72 : 0.88), hw * 0.14);
    ctx.fill();
    if (LOD > 30) {
      /* both ear holes in one path, and the rim light that gives the shell
         its curve — the two details that are only worth their cost close in */
      ctx.fillStyle = 'rgba(0,0,0,.34)';
      ctx.beginPath();
      ctx.ellipse(-hw * (back ? 0.62 : 0.70), hh * 0.18, hw * 0.15, hh * 0.17, 0, 0, 6.2832);
      ctx.moveTo(hw * (back ? 0.62 : 0.70) + hw * 0.15, hh * 0.18);
      ctx.ellipse(hw * (back ? 0.62 : 0.70), hh * 0.18, hw * 0.15, hh * 0.17, 0, 0, 6.2832);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.16)';
      ctx.lineWidth = Math.max(0.6, hw * 0.10);
      ctx.beginPath();
      ctx.arc(0, -hh * 0.10, hw * 0.80, Math.PI * 1.18, Math.PI * 1.82);
      ctx.stroke();
    }
    if (!back) {
      /* THE FACEMASK IS A HOLE WITH BARS ACROSS IT. Drawn as bright strokes
         it read as a wide white smile on every man on the field; what the eye
         actually sees at twenty yards is the dark of the opening with the
         cage catching a little light in front of it. */
      var fx = side * hw * 0.24;
      ctx.fillStyle = 'rgba(14,18,24,.72)';
      ctx.beginPath();
      ctx.ellipse(fx, hh * 0.44, hw * 0.50, hh * 0.32, 0, 0, 6.2832);
      ctx.fill();
      if (LOD > 30) {
        ctx.strokeStyle = 'rgba(206,216,228,.52)';
        ctx.lineWidth = Math.max(0.55, hw * 0.085);
        ctx.beginPath();
        ctx.moveTo(fx - hw * 0.46, hh * 0.34); ctx.lineTo(fx + hw * 0.46, hh * 0.34);
        ctx.moveTo(fx - hw * 0.42, hh * 0.58); ctx.lineTo(fx + hw * 0.42, hh * 0.58);
        ctx.moveTo(fx, hh * 0.24); ctx.lineTo(fx, hh * 0.68);
        ctx.stroke();
      }
    }
    ctx.restore();

    ctx.restore();

    /* ── THE RING AT HIS FEET ────────────────────────────────────────────
       Who you are steering, and who has the football. Drawn after the body
       and outside its lean so it stays flat on the grass. */
    if (p.sel || p.carry) {
      ctx.save();
      ctx.translate(sx, sy);
      ctx.save();
      ctx.scale(1, squash);
      ctx.beginPath();
      ctx.arc(0, 0, H * 0.33, 0, 6.2832);
      ctx.strokeStyle = p.sel ? (p.selColor || 'rgba(84,240,158,.95)') : 'rgba(255,255,255,.86)';
      ctx.lineWidth = Math.max(1.6, H * 0.046);
      ctx.stroke();
      if (p.carry && p.sel) {
        ctx.beginPath();
        ctx.arc(0, 0, H * 0.46, 0, 6.2832);
        ctx.strokeStyle = 'rgba(245,190,50,.48)';
        ctx.lineWidth = Math.max(1, H * 0.026);
        ctx.stroke();
      }
      ctx.restore();
      if (p.label && LOD > 24) {
        var lf = Math.max(8, Math.round(H * 0.175));
        ctx.font = '700 ' + lf + 'px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        var lw = ctx.measureText(p.label).width + lf * 0.86;
        var ly = H * 0.33 * squash + lf * 0.82;
        ctx.fillStyle = 'rgba(8,12,17,.78)';
        roundRect(ctx, -lw / 2, ly - lf * 0.62, lw, lf * 1.24, lf * 0.62);
        ctx.fill();
        ctx.fillStyle = p.sel ? '#54f09e' : '#f5f7fa';
        ctx.fillText(p.label, 0, ly);
      }
      ctx.restore();
    }
  }

  /* ── ONE LEG ─────────────────────────────────────────────────────────────
     Thigh from the hip, calf from the knee, a sock under the pants and a
     boot on the end of it. The far one is drawn first and darker, so there is
     a front and a back to him — and the pants stop above the knee, which is
     what puts daylight between two legs instead of one white pillar. */
  function legOne(ctx, dx, hipY, kneeY, ankY, thW, clW, k, swing, lift, pose, far) {
    var H = pose.H, gait = pose.gait;
    var thighL = kneeY - hipY;                  /* positive: the knee is below */
    var calfL = ankY - kneeY;
    ctx.save();
    ctx.translate(dx, hipY);
    /* THE THREE-POINT STANCE. The back foot is set behind the front one and
       the near leg is loaded; a lineman with his feet square is a man waiting
       for a bus. */
    var hipA = swing * 0.66;
    if (pose.threePt) hipA = far ? 0.30 : -0.16;
    else if (gait === 'tackle') hipA = far ? 0.46 : -0.34;
    ctx.rotate(hipA);
    /* thigh */
    ctx.fillStyle = far ? shade(k.pants, -0.20) : k.pants;
    roundRect(ctx, -thW, -thW * 0.30, thW * 2, thighL + thW * 0.5, thW * 0.72);
    ctx.fill();
    if (!far && H > 34) {
      ctx.fillStyle = 'rgba(0,0,0,.10)';
      roundRect(ctx, thW * 0.22, -thW * 0.30, thW * 0.78, thighL + thW * 0.4, thW * 0.5);
      ctx.fill();
    }
    /* the knee, then the calf swinging back from it */
    ctx.translate(0, thighL);
    var kneeA = -Math.abs(swing) * 0.86 - (pose.threePt ? 0.52 : 0)
      - (gait === 'block' || gait === 'engaged' || gait === 'shed' ? 0.16 : 0)
      - (gait === 'tackle' ? 0.30 : 0) - lift * Math.max(0, swing) * 0.6;
    ctx.rotate(kneeA);
    /* the sock: the club's colour from below the knee to the boot, which is
       the one flash of team colour anywhere below the waist */
    ctx.fillStyle = far ? shade(k.sock, -0.24) : k.sock;
    roundRect(ctx, -clW, -clW * 0.55, clW * 2, calfL + clW * 0.6, clW * 0.78);
    ctx.fill();
    if (H > 30) {
      /* the knee pad over the top of the sock */
      ctx.fillStyle = far ? shade(k.pants, -0.26) : shade(k.pants, -0.06);
      roundRect(ctx, -clW * 1.12, -clW * 0.75, clW * 2.24, clW * 1.05, clW * 0.42);
      ctx.fill();
    }
    /* the boot: wider than the ankle and set forward of it, so he stands on
       the grass rather than balancing on two points */
    ctx.translate(0, calfL);
    ctx.rotate(-kneeA * 0.55);
    ctx.fillStyle = far ? '#12181e' : '#1b232c';
    roundRect(ctx, -clW * 1.05, -clW * 0.30, clW * 2.35, clW * 1.35, clW * 0.50);
    ctx.fill();
    if (H > 38 && !far) {
      ctx.fillStyle = shade(k.sock, 0.16);
      roundRect(ctx, -clW * 0.95, -clW * 0.22, clW * 1.5, clW * 0.42, clW * 0.20);
      ctx.fill();
    }
    ctx.restore();
  }

  /* ── AN ARM ──────────────────────────────────────────────────────────────
     Upper arm out of the pad cap, forearm from the elbow, a glove on the end.
     What the arms are doing is most of what tells you what a man is doing —
     so every state gets a shoulder angle, an elbow angle and a foreshorten,
     and nothing ever hangs straight down at his sides except a man standing
     still.

     Angles are screen-plane radians about the shoulder; `sd` is +1 for the
     near arm and -1 for the far one, and a positive angle takes the hand
     AWAY from the body on that side. `fore` shortens the whole limb when he
     is reaching away from the camera, which is what stops a blocker looking
     like a scarecrow. */
  function armOf(ctx, sd, padW, shoY, upW, foW, k, p, cyc, H, gait, far, skin, LOD, side, back) {
    var st = p.state, a1, a2, fore = 1;
    var mv = p.move;
    var near = sd > 0;
    switch (gait) {
      case 'stance':
        if (p.pos === 'OL' || p.pos === 'DL') {
          /* THREE-POINT. The near hand is in the grass — the arm goes long and
             straight down out of a pitched-over torso — and the off arm rests
             cocked on the thigh. */
          a1 = near ? 0.08 : 0.18; a2 = near ? 0.04 : 0.66; fore = near ? 1.44 : 0.86;
        } else if (p.pos === 'QB') { a1 = 0.12; a2 = 0.96; fore = 0.62; }
        else { a1 = 0.02; a2 = 0.62; fore = 0.80; }
        break;
      case 'idle': a1 = -0.10 + Math.sin((p.phase || 0) * 1.5 + (near ? 0 : 1.7)) * 0.03; a2 = 0.14; break;
      case 'block': case 'shed': case 'engaged':
        /* HANDS INTO THE MAN IN FRONT OF HIM. Both arms come up and forward,
           which from a camera behind him is a SHORT arm with the glove up by
           the pad — not a wing held out sideways like a scarecrow. */
        a1 = -0.98 - (near ? 0.14 : 0) + cyc * 0.16; a2 = -0.62; fore = 0.34;
        break;
      case 'tackle':
        a1 = -0.86 + cyc * 0.10; a2 = -0.22; fore = 0.40;
        break;
      case 'throw': {
        /* THE THROW IS A SEQUENCE, NOT A POSE: the ball comes back over the
           shoulder, the off arm points the target out, and the arm comes
           through and follows across the body. */
        var t = clamp((p.throwT || 0) / 0.40, 0, 1.5);
        if (near) {
          a1 = t < 0.5 ? -2.30 - t * 0.30 : -2.45 + (t - 0.5) * 3.1;
          a2 = t < 0.5 ? 0.95 : 0.95 - (t - 0.5) * 1.5;
          fore = 0.92;
        } else { a1 = -1.10 + t * 0.75; a2 = -0.30; fore = 0.66; }
        break;
      }
      case 'catch': {
        var ck = p.catchKind || 'chest';
        if (ck === 'high') { a1 = -2.34; a2 = 0.18; fore = 0.86; }
        else if (ck === 'reachR') { a1 = near ? -2.05 : -0.55; a2 = 0.16; fore = 0.80; }
        else if (ck === 'reachL') { a1 = near ? -0.55 : -2.05; a2 = 0.16; fore = 0.80; }
        else if (ck === 'back') { a1 = -1.90; a2 = 0.70; fore = 0.62; }
        else { a1 = -0.62; a2 = 0.88; fore = 0.50; }
        break;
      }
      case 'celebrate': a1 = -2.52 - (near ? 0.16 : 0); a2 = 0.14; break;
      case 'backpedal': a1 = -0.38 + cyc * 0.26; a2 = 0.52 - cyc * 0.16; fore = 0.86; break;
      case 'shuffle': a1 = -0.46; a2 = 0.44; fore = 0.84; break;
      default: {
        /* RUNNING. Elbows out, forearms driving across the chest, out of
           phase with the legs. A sprinter's arm is a piston at ninety
           degrees, not a pendulum swinging off a shoulder. */
        var drive = gait === 'sprint' ? 1 : gait === 'jog' ? 0.74 : 0.44;
        a1 = -0.14 + cyc * 0.42 * drive;
        a2 = (gait === 'sprint' ? 1.15 : 0.94) - cyc * 0.38 * drive;
        fore = 0.88;
      }
    }
    /* the ball is carried, not swung: whichever arm has it locks to the ribs */
    var carryArm = p.carry && gait !== 'throw' && gait !== 'catch';
    if (carryArm && near) { a1 = 0.16; a2 = 1.34; fore = 0.60; }
    if (mv === 'truck' && near) { a1 = -0.94; a2 = -0.52; fore = 0.38; }
    if (mv === 'juke' && !near) { a1 = -0.92; a2 = 0.24; }
    /* THE COUNT. A hand off the ball and up, which is the one gesture that
       makes a still formation look like it is a beat away from moving. */
    if (mv === 'cadence' && near) { a1 = -1.72; a2 = -0.30; fore = 0.62; }

    var upL = H * 0.196 * fore, foL = H * 0.140 * fore;
    ctx.save();
    ctx.translate(sd * padW * 0.84, shoY + H * 0.034);
    ctx.rotate(sd * a1);
    /* upper arm: the jersey sleeve */
    ctx.fillStyle = far ? shade(k.sleeve, -0.22) : k.sleeve;
    roundRect(ctx, -upW, -upW * 0.5, upW * 2, upL + upW * 0.6, upW * 0.85);
    ctx.fill();
    if (LOD > 30 && !far) {
      /* the sleeve stripe: a club's colour on the arm, and the line that
         tells you where the jersey ends and the man begins */
      ctx.fillStyle = rgba(k.trim, far ? 0.34 : 0.55);
      roundRect(ctx, -upW * 0.98, upL * 0.60, upW * 1.96, upL * 0.20, upW * 0.3);
      ctx.fill();
    }
    ctx.translate(0, upL);
    ctx.rotate(sd * a2);
    /* forearm: skin, or a sleeve if he wears one */
    ctx.fillStyle = far ? shade(skin, -0.26) : skin;
    roundRect(ctx, -foW, -foW * 0.5, foW * 2, foL + foW * 0.5, foW * 0.86);
    ctx.fill();
    /* the glove */
    if (LOD > 18) {
      ctx.fillStyle = far ? shade(k.helmetDark, -0.16) : shade(k.helmetDark, 0.06);
      roundRect(ctx, -foW * 1.24, foL - foW * 0.34, foW * 2.48, foW * 1.62, foW * 0.66);
      ctx.fill();
    }
    ctx.restore();

    /* THE FOOTBALL, IN HIS HANDS. Tucked high and away from the defence when
       he is carrying it, held at the chest when he has just taken the snap. */
    if (carryArm && near && LOD > 20) {
      ctx.save();
      ctx.translate(sd * padW * 0.86, shoY + H * 0.150);
      ctx.rotate(0.42);
      ctx.fillStyle = '#7a4520';
      ctx.beginPath();
      ctx.ellipse(0, 0, H * 0.062, H * 0.038, 0, 0, 6.2832);
      ctx.fill();
      if (LOD > 34) {
        ctx.strokeStyle = 'rgba(245,245,240,.82)';
        ctx.lineWidth = Math.max(0.6, H * 0.008);
        ctx.beginPath();
        ctx.moveTo(-H * 0.020, -H * 0.010); ctx.lineTo(H * 0.020, -H * 0.010);
        ctx.stroke();
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
    /* A ROUNDED CORNER YOU CANNOT SEE IS FOUR ARCS YOU ARE PAYING FOR. A
       forearm is three pixels across at forty yards; rounding it costs four
       arcTo calls and changes nothing on the screen. Twenty-two men, twenty
       parts each, sixty times a second — this one branch is worth more than
       any other line in the renderer. */
    if (r < 1.1) { ctx.beginPath(); ctx.rect(x, y, w, h); return; }
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
    var air = (b.z || 0) > 0.35;
    /* its shadow stays on the ground and shrinks as it climbs — which, on a
       deep ball, is the only thing that tells you where it is going to land */
    ctx.save();
    ctx.translate(sx, sy);
    ctx.scale(1, 0.34);
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(1.6, u * 0.20 - (b.z || 0) * 0.22), 0, 6.2832);
    ctx.fillStyle = air ? 'rgba(0,0,0,.22)' : 'rgba(0,0,0,.32)';
    ctx.fill();
    ctx.restore();

    var cy = sy - u * 0.55 - z;
    /* A FOOTBALL IN THE AIR HAS TO BE FINDABLE. Against eighty thousand
       people and a stand, a brown ellipse four pixels across is invisible —
       so in flight it carries a trail behind it and a breath of light around
       it. On the ground it is just the football. */
    var r = Math.max(3.2, u * 0.24);
    if (air) {
      var gl = ctx.createRadialGradient(sx, cy, r * 0.3, sx, cy, r * 3.4);
      gl.addColorStop(0, 'rgba(255,242,214,.30)');
      gl.addColorStop(1, 'rgba(255,242,214,0)');
      ctx.fillStyle = gl;
      ctx.fillRect(sx - r * 3.4, cy - r * 3.4, r * 6.8, r * 6.8);
      if (b.px != null) {
        var tdx = sx - b.px, tdy = cy - b.py, i;
        for (i = 1; i <= 3; i++) {
          ctx.globalAlpha = 0.22 / i;
          ctx.beginPath();
          ctx.ellipse(sx - tdx * i * 2.2, cy - tdy * i * 2.2, r * (1 - i * 0.16), r * 0.60 * (1 - i * 0.16),
            b.spin || -0.5, 0, 6.2832);
          ctx.fillStyle = '#c9803c';
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
    }
    b.px = sx; b.py = cy;

    ctx.save();
    ctx.translate(sx, cy);
    ctx.rotate(b.spin || -0.5);
    var g = ctx.createLinearGradient(-r, -r, r, r);
    g.addColorStop(0, '#a9622c');
    g.addColorStop(0.48, '#d08a44');
    g.addColorStop(1, '#8a4c20');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(0, 0, r, r * 0.60, 0, 0, 6.2832);
    ctx.fill();
    /* the white bands at each end, and the laces */
    if (r > 4) {
      ctx.strokeStyle = 'rgba(255,248,238,.80)';
      ctx.lineWidth = Math.max(0.7, r * 0.10);
      ctx.beginPath();
      ctx.arc(-r * 0.58, 0, r * 0.30, -1.1, 1.1);
      ctx.moveTo(r * 0.58 + r * 0.30 * Math.cos(Math.PI - 1.1), r * 0.30 * Math.sin(Math.PI - 1.1));
      ctx.arc(r * 0.58, 0, r * 0.30, Math.PI - 1.1, Math.PI + 1.1);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,250,242,.95)';
    ctx.lineWidth = Math.max(0.8, r * 0.12);
    ctx.beginPath();
    ctx.moveTo(-r * 0.40, 0); ctx.lineTo(r * 0.40, 0);
    ctx.stroke();
    if (r > 6) {
      ctx.lineWidth = Math.max(0.6, r * 0.09);
      [-0.22, 0, 0.22].forEach(function (dx) {
        ctx.beginPath();
        ctx.moveTo(r * dx, -r * 0.15); ctx.lineTo(r * dx, r * 0.15);
        ctx.stroke();
      });
    }
    ctx.restore();
  }


  /* ── LIGHT AND WEATHER ───────────────────────────────────────────────────
     One palette per time of day. Everything the stadium draws asks these for
     its colours, so switching to a night game changes the turf, the stands,
     the crowd and the sky in one move rather than in thirty. */
  var LIGHT = {
    /* AFTERNOON. High, neutral, slightly cool light; a blue sky that gets
       paler toward the rim of the bowl; grass with the sun on it. */
    day: {
      sky: ['#5b83ad', '#9dbad2'], haze: 'rgba(158,186,208,',
      turf: ['#39834f', '#296237'], apron: '#3a4a58', wall: '#455567',
      deck: ['#4c5d72', '#374556'], upper: '#26313f',
      crowd: 1.00, paint: 0.92, grade: null, lights: false,
      pool: 0.16, edge: 0.10
    },
    /* LATE AFTERNOON. The one that costs nothing and sells everything: a warm
       low sun, a sky that goes from slate at the top to copper at the rim,
       long shadows and the floodlights just coming on. */
    dusk: {
      sky: ['#243052', '#c4795e'], haze: 'rgba(186,140,116,',
      turf: ['#2e7145', '#1d4b2d'], apron: '#3c4356', wall: '#4d4b62',
      deck: ['#4b4356', '#332f40'], upper: '#221f2c',
      crowd: 0.86, paint: 0.86, grade: 'rgba(255,158,92,0.085)', lights: true,
      pool: 0.62, edge: 0.34
    },
    /* NIGHT. A bright field under a black sky, the stands falling away into
       the dark, and the whole building lit from its own roofline. */
    night: {
      sky: ['#03050a', '#0b1220'], haze: 'rgba(72,96,128,',
      turf: ['#2f8a52', '#1b5232'], apron: '#28313d', wall: '#333d4c',
      deck: ['#2b3441', '#191f28'], upper: '#111620',
      crowd: 0.62, paint: 1.00, grade: 'rgba(126,166,255,0.045)', lights: true,
      pool: 0.88, edge: 0.42
    }
  };
  var WEATHER = {
    clear: { grade: null, wind: 0.25, wet: 0 },
    /* OVERCAST is a different LIGHT, not a grey film over a sunny one: the
       sky loses its blue, the shadows go, and everything cools by a few
       degrees. Held here as a colour cast because the palette above is what
       the bowl is built from — but a gentle one, and cool rather than muddy. */
    cloudy: { grade: 'rgba(126,146,170,0.13)', wind: 0.45, wet: 0, flat: 0.55 },
    rain: { grade: 'rgba(84,108,142,0.20)', wind: 0.7, wet: 0.55, flat: 0.75 },
    wind: { grade: 'rgba(160,158,140,0.05)', wind: 1, wet: 0, flat: 0.15 }
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
    endApron: 4.5,     /* the same behind each end zone */
    endDeep: 40,
    /* ── AND THE REST OF THE BUILDING ─────────────────────────────────
       A single ring of seats nineteen yards high leaves two thirds of the
       picture as empty sky, which is exactly what "the field floats in a
       dark rectangle" looks like from a low lens. A real venue keeps going:
       a facade of boxes over the lower rim, a second deck above that, a
       canopy over the back of it and a rig of lights hung off the front. */
    facade: 6,         /* height of the box level over the lower rim */
    upDeep: 26,        /* how far back the upper deck reaches */
    upHigh: 26,        /* and how far it climbs above the facade */
    roof: 5            /* the canopy over the back of it */
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
    for (i = 0; i < 7000; i++) out.push([r(), r(), r(), r()]);
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

    /* ── THE FAR STAND ──────────────────────────────────────────────────
       From the play lens the real bowl is off the top of the frame: the
       ground beyond the back line projects to negative screen y, and raising
       the geometry only pushes it further up. Everything above the end line
       would be sky, and a flat band of sky is exactly what "the field floats
       in a dark rectangle" looks like.

       So where the geometry cannot go, a BUILDING does: two tiers, a facade
       of boxes between them, a canopy, a rig of lights on its lip and a
       videoboard over the tunnel — painted in screen space, anchored to the
       back line, sized to whatever room is left above it. It is a backdrop
       and it is honest about being one; the establishing shot below draws the
       same stadium for real, in perspective, and the two agree. */
    /* THE BUILDING STANDS WHERE THE SURFACE RUNS OUT, not on the back line.
       Anchored to the paint it left the apron behind the end zone as a band
       of unlit concrete between the last row of the crowd and the grass —
       forty pixels of nothing in the middle of the picture. */
    var line = cam.sy(FIELD.length + FIELD.endzone + BOWL.endApron);
    var bowlTop = cam.sy(yFar + BOWL.endDeep, BOWL.high);
    /* WHOEVER DRAWS THE STAND, DRAWS ALL OF IT. From the play lens the real
       bowl projects hundreds of pixels above the frame: what lands in the
       picture is the thin bottom edge of it and a scatter of seats, and drawn
       ON TOP of the backdrop that scatter is all you see — a careful building
       covered over by its own confetti. So it is one or the other. */
    var matte = line > 5 && bowlTop < 2;
    if (matte) {
      /* THE BUILDING FILLS WHATEVER IS ABOVE THE BACK LINE, and it is
         PROPORTIONED to that, not to a fixed number of yards. Sized off a
         constant the roofline mostly fell off the top of the frame and the
         only tier left in the picture was eight pixels of it — which is why
         a red-zone shot came out as a slab of dark with a few specks on it.

         Anchored just above the frame instead: from your own thirty the whole
         venue is a thin strip on the horizon, and from the ten it is a wall
         of people, and both are the same drawing. */
      var top = -H * 0.04;
      var band = line - top;
      var mid1 = top + band * 0.44;          /* lower rim / facade top   */
      var mid0 = top + band * 0.30;          /* upper deck front rail    */
      var roofY = top + band * 0.10;

      /* the mass of the building, darkest at the back */
      var bg = ctx.createLinearGradient(0, top, 0, line);
      bg.addColorStop(0, shade(L.upper, -0.18));
      bg.addColorStop(0.30, L.deck[1]);
      bg.addColorStop(0.62, L.deck[0]);
      bg.addColorStop(1, shade(L.deck[0], -0.20));
      ctx.fillStyle = bg;
      ctx.fillRect(-2, top, W + 4, band + 2);

      /* A BOWL CURVES AWAY AT THE CORNERS. A flat-topped slab across the
         picture is a wall; two notches of sky at the edges and it is a
         stadium seen down its own axis. */
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(-2, line + 2);
      ctx.lineTo(-2, roofY + band * 0.30);
      ctx.quadraticCurveTo(W * 0.18, roofY - band * 0.04, W * 0.5, roofY - band * 0.06);
      ctx.quadraticCurveTo(W * 0.82, roofY - band * 0.04, W + 2, roofY + band * 0.30);
      ctx.lineTo(W + 2, line + 2);
      ctx.closePath();
      ctx.clip();
      ctx.fillStyle = bg;
      ctx.fillRect(-2, top, W + 4, band + 2);

      /* ── THE CROWD, in two decks with an aisle structure ───────────── */
      var sSeats = seats(), i2, q, decks = [
        { y0: roofY + band * 0.15, y1: mid0, rows: 14, n: Math.round(W * band / 6) },
        { y0: mid1, y1: line - band * 0.055, rows: 20, n: Math.round(W * band / 4) }
      ];
      decks.forEach(function (dk, di) {
        var h2 = dk.y1 - dk.y0;
        if (h2 < 4) return;
        var lists = [[], [], [], []];
        for (i2 = 0; i2 < dk.n * 3 && lists[0].length + lists[1].length + lists[2].length + lists[3].length < dk.n * 4; i2++) {
          q = sSeats[(i2 * 7 + di * 313) % sSeats.length];
          var vv = (Math.floor(q[1] * dk.rows) + 0.28 + q[2] * 0.44) / dk.rows;
          var xx = q[0] * W;
          /* the vomitories: a stand has gangways cut through it */
          var aisle = Math.abs(((q[0] * 7) % 1) - 0.5) < 0.045;
          if (aisle) continue;
          var yy = dk.y0 + h2 * vv;
          /* A PERSON IS ABOUT A FIFTIETH OF THE HEIGHT OF THE STAND HE IS IN,
             and never smaller than a pixel and a half — under that a crowd
             stops being people and becomes noise on the picture. */
          var szz = Math.max(1.5, band * 0.0105 + q[2] * band * 0.005);
          var upp = q[2] < excite;
          var bb = upp ? Math.sin(tick * 7 + q[3] * 40) * szz * 0.8 : 0;
          var kk = q[3] < 0.17 ? 2 : q[3] < 0.30 ? 3 : q[2] < 0.62 ? 0 : 1;
          lists[kk].push(xx, yy - bb, szz * 0.9, szz * (upp ? 1.5 : 1.15));
        }
        var cols = [
          'rgba(' + Math.round(120 * L.crowd + 44) + ',' + Math.round(126 * L.crowd + 50) + ',' + Math.round(146 * L.crowd + 62) + ',.95)',
          'rgba(' + Math.round(210 * L.crowd + 44) + ',' + Math.round(214 * L.crowd + 48) + ',' + Math.round(226 * L.crowd + 58) + ',.97)',
          rgba(o.homeTint || o.homeColor || '#9aa6b8', 0.70 * L.crowd + 0.20),
          rgba(o.awayTint || o.awayColor || '#7d8ba0', 0.60 * L.crowd + 0.18)
        ];
        lists.forEach(function (ls, ci) {
          if (!ls.length) return;
          ctx.fillStyle = cols[ci];
          ctx.beginPath();
          for (i2 = 0; i2 < ls.length; i2 += 4) ctx.rect(ls[i2], ls[i2 + 1], ls[i2 + 2], ls[i2 + 3]);
          ctx.fill();
        });
        /* a shadow under the deck above, so the two tiers are two things */
        if (di === 1) {
          var sh2 = ctx.createLinearGradient(0, dk.y0 - band * 0.02, 0, dk.y0 + band * 0.10);
          sh2.addColorStop(0, 'rgba(0,0,0,.55)');
          sh2.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = sh2;
          ctx.fillRect(0, dk.y0 - band * 0.02, W, band * 0.12);
        }
      });

      /* ── THE FACADE OF BOXES between the decks ───────────────────── */
      ctx.fillStyle = shade(L.upper, -0.06);
      ctx.fillRect(0, mid0, W, mid1 - mid0);
      var nb2 = Math.max(8, Math.round(W / 26)), bi3;
      for (bi3 = 0; bi3 < nb2; bi3++) {
        var bx = (bi3 + 0.16) * W / nb2, bw2 = W / nb2 * 0.68;
        ctx.fillStyle = L.lights ? 'rgba(255,232,176,.42)' : 'rgba(196,216,238,.22)';
        ctx.fillRect(bx, mid0 + (mid1 - mid0) * 0.22, bw2, (mid1 - mid0) * 0.54);
      }
      ctx.fillStyle = 'rgba(0,0,0,.30)';
      ctx.fillRect(0, mid1 - Math.max(1, band * 0.012), W, Math.max(1, band * 0.012));

      /* ── THE CANOPY AND THE LIGHT RIG ─────────────────────────────── */
      var cg2 = ctx.createLinearGradient(0, roofY - band * 0.10, 0, roofY + band * 0.16);
      cg2.addColorStop(0, shade(L.upper, -0.30));
      cg2.addColorStop(1, shade(L.upper, 0.06));
      ctx.fillStyle = cg2;
      ctx.beginPath();
      ctx.moveTo(-2, roofY + band * 0.32);
      ctx.quadraticCurveTo(W * 0.18, roofY - band * 0.02, W * 0.5, roofY - band * 0.04);
      ctx.quadraticCurveTo(W * 0.82, roofY - band * 0.02, W + 2, roofY + band * 0.32);
      ctx.lineTo(W + 2, roofY + band * 0.20);
      ctx.quadraticCurveTo(W * 0.82, roofY + band * 0.11, W * 0.5, roofY + band * 0.09);
      ctx.quadraticCurveTo(W * 0.18, roofY + band * 0.11, -2, roofY + band * 0.20);
      ctx.closePath();
      ctx.fill();
      var nl2 = Math.max(5, Math.round(W / 52)), li2;
      for (li2 = 0; li2 < nl2; li2++) {
        var lt = (li2 + 0.5) / nl2;
        var lxp = lt * W;
        var lyp = roofY + band * (0.20 + 0.12 * Math.pow(Math.abs(lt - 0.5) * 2, 2));
        var lw3 = Math.max(4, W / nl2 * 0.34), lh3 = Math.max(1.6, band * 0.020);
        ctx.fillStyle = L.lights ? 'rgba(255,251,232,.95)' : 'rgba(214,226,240,.55)';
        roundRect(ctx, lxp - lw3 / 2, lyp, lw3, lh3, lh3 * 0.4);
        ctx.fill();
        if (L.lights) {
          var lgr = ctx.createRadialGradient(lxp, lyp + lh3, 1, lxp, lyp + lh3, lw3 * 2.6);
          lgr.addColorStop(0, 'rgba(255,248,220,.30)');
          lgr.addColorStop(1, 'rgba(255,248,220,0)');
          ctx.fillStyle = lgr;
          ctx.fillRect(lxp - lw3 * 2.6, lyp - lw3, lw3 * 5.2, lw3 * 4);
        }
      }

      /* ── THE VIDEOBOARD, over the tunnel ─────────────────────────── */
      var vbw = Math.min(W * 0.38, band * 1.05), vbh = vbw * 0.31;
      var vbx = W / 2 - vbw / 2;
      var vby = clamp(mid0 - vbh * 0.62, top + band * 0.03, line - vbh - band * 0.16);
      if (vbh > 8) {
        ctx.fillStyle = shade(L.upper, -0.24);
        roundRect(ctx, vbx - vbh * 0.12, vby - vbh * 0.12, vbw + vbh * 0.24, vbh + vbh * 0.24, vbh * 0.10);
        ctx.fill();
        var vg = ctx.createLinearGradient(0, vby, 0, vby + vbh);
        vg.addColorStop(0, L.lights ? 'rgba(52,80,70,1)' : 'rgba(38,54,48,1)');
        vg.addColorStop(1, L.lights ? 'rgba(24,42,36,1)' : 'rgba(20,30,26,1)');
        ctx.fillStyle = vg;
        ctx.fillRect(vbx, vby, vbw, vbh);
        /* the two club marks and the score between them, at the size a screen
           a hundred and sixty yards away actually reads at */
        ctx.fillStyle = rgba(o.homeTint || o.homeColor || '#3fb883', L.lights ? 0.90 : 0.60);
        ctx.fillRect(vbx + vbw * 0.06, vby + vbh * 0.24, vbw * 0.16, vbh * 0.44);
        ctx.fillStyle = rgba(o.awayTint || o.awayColor || '#e2664b', L.lights ? 0.90 : 0.60);
        ctx.fillRect(vbx + vbw * 0.78, vby + vbh * 0.24, vbw * 0.16, vbh * 0.44);
        ctx.fillStyle = L.lights ? 'rgba(236,248,242,.60)' : 'rgba(216,230,224,.34)';
        ctx.fillRect(vbx + vbw * 0.28, vby + vbh * 0.28, vbw * 0.16, vbh * 0.36);
        ctx.fillRect(vbx + vbw * 0.56, vby + vbh * 0.28, vbw * 0.16, vbh * 0.36);
        ctx.fillStyle = rgba(o.homeTint || o.homeColor || '#3fb883', L.lights ? 0.55 : 0.32);
        ctx.fillRect(vbx, vby + vbh * 0.80, vbw, vbh * 0.12);
        if (L.lights) {
          var vgl = ctx.createRadialGradient(W / 2, vby + vbh / 2, 2, W / 2, vby + vbh / 2, vbw * 0.9);
          vgl.addColorStop(0, 'rgba(150,220,190,.14)');
          vgl.addColorStop(1, 'rgba(150,220,190,0)');
          ctx.fillStyle = vgl;
          ctx.fillRect(W / 2 - vbw, vby - vbh, vbw * 2, vbh * 3);
        }
      }
      /* THE FIRST TEN ROWS ARE LIT. Everything a floodlight reaches is
         brighter than everything it does not, and the gradient between them
         is what puts the stand INSIDE the building rather than behind it. */
      var litH = band * 0.32;
      var lg2 = ctx.createLinearGradient(0, line - litH, 0, line);
      lg2.addColorStop(0, 'rgba(255,244,214,0)');
      lg2.addColorStop(1, L.lights ? 'rgba(255,238,196,.15)' : 'rgba(255,250,232,.10)');
      ctx.fillStyle = lg2;
      ctx.fillRect(0, line - litH, W, litH);
      ctx.restore();

      /* the wall the crowd sits behind, and the tunnel out of it */
      var wallH = Math.max(2.5, band * 0.055);
      ctx.fillStyle = L.wall;
      ctx.fillRect(0, line - wallH, W, wallH);
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillRect(W / 2 - Math.max(6, W * 0.045), line - wallH * 0.86, Math.max(12, W * 0.09), wallH * 0.86);
      ctx.fillStyle = 'rgba(255,255,255,.10)';
      ctx.fillRect(0, line - wallH, W, Math.max(1, wallH * 0.10));
    }

    /* ── THE FAR END: apron, wall, bowl ──────────────────────────────── */
    var fy = yFar, fd = yFar + BOWL.endDeep;
    if (!matte) {
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
    }

    /* ── THE SIDES ───────────────────────────────────────────────────── */
    if (!matte) [-1, 1].forEach(function (side) {
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

    /* ── THE UPPER DECK ──────────────────────────────────────────────
       Facade, second tier, canopy and the light rig hung off it — the part
       of the building that fills the sky. Drawn after the lower bowl and
       before the field, in the same projection, so the whole venue is one
       object rather than a photograph behind a diagram. */
    function tier(x0, y0, x1, y1, seatAt, count, offset) {
      /* THE BOX LEVEL. A band of concrete over the lower rim with a ribbon of
         glass in it — and the band has to be a BAND, lighter than the sky
         behind it, or the lit windows read as a row of grey slabs floating
         in the dark, which is exactly what it looked like. */
      var zA = BOWL.high, zB = BOWL.high + BOWL.facade;
      ctx.fillStyle = shade(L.deck[1], 0.10);
      quad3(ctx, cam, [x0, y0, zB], [x1, y1, zB], [x1, y1, zA], [x0, y0, zA]);
      ctx.fill();
      /* the continuous glass ribbon, then the mullions across it */
      ctx.fillStyle = L.lights ? 'rgba(255,226,166,.30)' : 'rgba(186,206,230,.20)';
      quad3(ctx, cam, [x0, y0, zB - BOWL.facade * 0.26], [x1, y1, zB - BOWL.facade * 0.26],
                      [x1, y1, zA + BOWL.facade * 0.22], [x0, y0, zA + BOWL.facade * 0.22]);
      ctx.fill();
      var nb = 22, bi2;
      for (bi2 = 0; bi2 < nb; bi2++) {
        var u0 = (bi2 + 0.20) / nb, u1 = (bi2 + 0.80) / nb;
        var bx0 = x0 + (x1 - x0) * u0, by0 = y0 + (y1 - y0) * u0;
        var bx1 = x0 + (x1 - x0) * u1, by1 = y0 + (y1 - y0) * u1;
        ctx.fillStyle = L.lights ? 'rgba(255,232,178,.40)' : 'rgba(206,222,240,.24)';
        quad3(ctx, cam, [bx0, by0, zB - BOWL.facade * 0.32], [bx1, by1, zB - BOWL.facade * 0.32],
                        [bx1, by1, zA + BOWL.facade * 0.28], [bx0, by0, zA + BOWL.facade * 0.28]);
        ctx.fill();
      }
      /* a hard shadow line under the band, so the deck below it sits back */
      ctx.strokeStyle = 'rgba(0,0,0,.55)';
      ctx.lineWidth = Math.max(1.4, cam.lat((y0 + y1) / 2) * 0.5);
      ctx.beginPath();
      ctx.moveTo(cam.sx(x0, y0), cam.sy(y0, zA));
      ctx.lineTo(cam.sx(x1, y1), cam.sy(y1, zA));
      ctx.stroke();
      /* the second tier, raked back */
      var zC = zB + BOWL.upHigh;
      var dx = (x1 - x0), dy = (y1 - y0), m = Math.hypot(dx, dy) || 1;
      var nx = -dy / m * BOWL.upDeep, ny = dx / m * BOWL.upDeep;
      /* the normal has to point AWAY from the field */
      var mid = [(x0 + x1) / 2 + nx, (y0 + y1) / 2 + ny];
      var midIn = [(x0 + x1) / 2 - nx, (y0 + y1) / 2 - ny];
      var cxf = FIELD.half, cyf = 50;
      if (Math.hypot(mid[0] - cxf, mid[1] - cyf) < Math.hypot(midIn[0] - cxf, midIn[1] - cyf)) {
        nx = -nx; ny = -ny;
      }
      quad3(ctx, cam, [x0, y0, zB], [x1, y1, zB], [x1 + nx, y1 + ny, zC], [x0 + nx, y0 + ny, zC]);
      bank(ctx, cam, { light: L, tick: tick, excite: excite * 0.86, count: count, offset: offset,
        rows: 18, yNear: yNear, tint: o.homeTint || o.homeColor, tint2: o.awayTint || o.awayColor,
        top: Math.min(cam.sy(y0 + ny, zC), cam.sy(y1 + ny, zC)),
        bottom: Math.max(cam.sy(y0, zB), cam.sy(y1, zB)),
        at: function (t, u) {
          return { x: x0 + (x1 - x0) * t + nx * u, y: y0 + (y1 - y0) * t + ny * u,
                   z: zB + u * (zC - zB) };
        } });
      /* the canopy over the back of it, and the rig of lights on its lip */
      var zD = zC + BOWL.roof;
      ctx.fillStyle = shade(L.upper, -0.30);
      quad3(ctx, cam, [x0 + nx, y0 + ny, zC], [x1 + nx, y1 + ny, zC],
                      [x1 + nx * 0.86, y1 + ny * 0.86, zD], [x0 + nx * 0.86, y0 + ny * 0.86, zD]);
      ctx.fill();
      ctx.strokeStyle = rgba(shade(L.deck[0], 0.30), 0.95);
      ctx.lineWidth = Math.max(1.6, cam.lat((y0 + y1) / 2) * 0.8);
      ctx.beginPath();
      ctx.moveTo(cam.sx(x0 + nx * 0.86, y0 + ny * 0.86), cam.sy(y0 + ny * 0.86, zD));
      ctx.lineTo(cam.sx(x1 + nx * 0.86, y1 + ny * 0.86), cam.sy(y1 + ny * 0.86, zD));
      ctx.stroke();
      /* and the shadow it throws on the back rows */
      ctx.strokeStyle = 'rgba(0,0,0,.42)';
      ctx.lineWidth = Math.max(2, cam.lat((y0 + y1) / 2) * 1.6);
      ctx.beginPath();
      ctx.moveTo(cam.sx(x0 + nx * 0.94, y0 + ny * 0.94), cam.sy(y0 + ny * 0.94, zC - 0.6));
      ctx.lineTo(cam.sx(x1 + nx * 0.94, y1 + ny * 0.94), cam.sy(y1 + ny * 0.94, zC - 0.6));
      ctx.stroke();
      /* THE LIGHTS, hung in a continuous rig off the front of the canopy —
         which is how a modern bowl is lit and why the sky over one glows. */
      var nl = 9, li;
      for (li = 0; li < nl; li++) {
        var t2 = (li + 0.5) / nl;
        var lx = x0 + (x1 - x0) * t2 + nx * 0.90, ly = y0 + (y1 - y0) * t2 + ny * 0.90;
        var lpx = cam.sx(lx, ly), lpy = cam.sy(ly, zD - 0.6);
        if (lpx < -60 || lpx > W + 60 || lpy < -40 || lpy > H) continue;
        var lw2 = Math.max(3, cam.lat(ly) * 2.6), lh2 = Math.max(1.6, cam.lat(ly) * 0.8);
        ctx.fillStyle = L.lights ? 'rgba(255,250,226,.92)' : 'rgba(210,222,236,.55)';
        roundRect(ctx, lpx - lw2 / 2, lpy - lh2, lw2, lh2, lh2 * 0.3);
        ctx.fill();
        if (L.lights) {
          var lg2 = ctx.createRadialGradient(lpx, lpy, 1, lpx, lpy, lw2 * 2.4);
          lg2.addColorStop(0, 'rgba(255,248,220,.34)');
          lg2.addColorStop(1, 'rgba(255,248,220,0)');
          ctx.fillStyle = lg2;
          ctx.fillRect(lpx - lw2 * 2.4, lpy - lw2 * 2.4, lw2 * 4.8, lw2 * 4.8);
        }
      }
    }
    /* the far end, then each side */
    if (!matte) tier(-62, fd, hw + 62, fd, null, 620, 1400);
    if (!matte) [-1, 1].forEach(function (sd2) {
      var ox = sd2 < 0 ? -BOWL.apron - BOWL.deep : hw + BOWL.apron + BOWL.deep;
      tier(ox, yNear, ox, yFar, null, 1100, sd2 < 0 ? 300 : 2100);
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
    var L = lightOf(o.light), hw = FIELD.width, tick = o.tick || 0;
    var yNear = Math.max(-8, cam.nearestY());
    var yFar = Math.min(104, FIELD.length + 4);

    /* ONE MAN ON A TOUCHLINE, cheap enough to draw sixty of them: a shadow,
       a pair of shoulders, a helmet or a cap. Never the full renderer — these
       are the frame around the picture, not part of it. */
    function bystander(x, y, h, o2) {
      var px = cam.sx(x, y), py = cam.sy(y, 0);
      var sway = Math.sin(tick * o2.rate + o2.ph) * h * o2.sway;
      var bob = Math.abs(Math.sin(tick * o2.rate * 0.8 + o2.ph)) * h * 0.016;
      ctx.fillStyle = 'rgba(0,0,0,.34)';
      ctx.beginPath();
      ctx.ellipse(px, py, h * 0.19, h * 0.065, 0, 0, 6.2832);
      ctx.fill();
      /* legs */
      ctx.fillStyle = o2.legs;
      roundRect(ctx, px + sway - h * 0.15, py - h * 0.40, h * 0.30, h * 0.42, h * 0.07);
      ctx.fill();
      /* torso: a helmeted man has SQUARE shoulders even at this size — it is
         the only thing that tells a substitute from a photographer */
      ctx.fillStyle = o2.body;
      if (o2.pads) {
        roundRect(ctx, px + sway - h * 0.26, py - bob - h * 0.80, h * 0.52, h * 0.44, h * 0.07);
      } else {
        roundRect(ctx, px + sway - h * 0.19, py - bob - h * 0.78, h * 0.38, h * 0.44, h * 0.13);
      }
      ctx.fill();
      /* head or helmet */
      ctx.fillStyle = o2.head;
      ctx.beginPath();
      ctx.ellipse(px + sway * 1.3, py - bob - h * (o2.pads ? 0.90 : 0.86),
        h * (o2.pads ? 0.145 : 0.115), h * (o2.pads ? 0.155 : 0.125), 0, 0, 6.2832);
      ctx.fill();
    }

    [-1, 1].forEach(function (side) {
      var kit = (side < 0 ? o.homeTint : o.awayTint) || (side < 0 ? o.homeColor : o.awayColor) || '#3fb883';
      var out = side < 0 ? -1 : 1;
      var xEdge = side < 0 ? -0.4 : hw + 0.4;      /* the white border */
      var xLine = side < 0 ? -2.6 : hw + 2.6;      /* where the substitutes stand */
      var xBench = side < 0 ? -5.6 : hw + 5.6;

      /* ── THE APRON ──────────────────────────────────────────────────
         A darker strip of surface outside the paint, so the field has an
         edge instead of running into the wall. */
      ctx.fillStyle = L.apron || 'rgba(24,32,30,.82)';
      quad3(ctx, cam, [xEdge, yNear, 0], [xEdge + out * BOWL.apron, yNear, 0],
                      [xEdge + out * BOWL.apron, yFar, 0], [xEdge, yFar, 0]);
      ctx.fill();
      /* A TOUCHLINE ENDS IN A WALL, not in the dark. Even when the bowl above
         it is off the top of the frame, the wall closing the apron is what
         stops the edge of the picture reading as a ramp into nothing. */
      ctx.fillStyle = shade(L.wall, -0.30);
      quad3(ctx, cam, [xEdge + out * BOWL.apron, yNear, BOWL.wall],
                      [xEdge + out * BOWL.apron, yFar, BOWL.wall],
                      [xEdge + out * BOWL.apron, yFar, 0],
                      [xEdge + out * BOWL.apron, yNear, 0]);
      ctx.fill();
      ctx.strokeStyle = rgba(L.deck[0], 0.85);
      ctx.lineWidth = Math.max(1, cam.lat(Math.max(yNear, 0)) * 0.16);
      ctx.beginPath();
      ctx.moveTo(cam.sx(xEdge + out * BOWL.apron, Math.max(yNear, -9)),
                 cam.sy(Math.max(yNear, -9), BOWL.wall));
      ctx.lineTo(cam.sx(xEdge + out * BOWL.apron, yFar), cam.sy(yFar, BOWL.wall));
      ctx.stroke();

      /* ── THE BENCH ───────────────────────────────────────────────── */
      var b0 = Math.max(yNear, 26), b1 = Math.min(yFar, 74);
      if (b1 > b0) {
        ctx.fillStyle = 'rgba(10,14,19,.90)';
        quad3(ctx, cam, [xBench - 0.9, b0, 1.05], [xBench + 0.9, b0, 1.05],
                        [xBench + 0.9, b1, 1.05], [xBench - 0.9, b1, 1.05]);
        ctx.fill();
        ctx.fillStyle = 'rgba(28,36,46,.95)';
        quad3(ctx, cam, [xBench - 0.9, b0, 1.05], [xBench + 0.9, b0, 1.05],
                        [xBench + 0.9, b0, 0], [xBench - 0.9, b0, 0]);
        ctx.fill();
        /* the heated benches and the kit crates behind them */
        var c;
        for (c = 0; c < 5; c++) {
          var cy = b0 + (b1 - b0) * (c + 0.5) / 5;
          if (cam.scale(cy) < 3) continue;
          ctx.fillStyle = rgba(kit, 0.42);
          quad3(ctx, cam, [xBench + out * 1.5, cy - 1.1, 1.3], [xBench + out * 2.7, cy - 1.1, 1.3],
                          [xBench + out * 2.7, cy + 1.1, 1.3], [xBench + out * 1.5, cy + 1.1, 1.3]);
          ctx.fill();
          ctx.fillStyle = 'rgba(16,22,29,.9)';
          quad3(ctx, cam, [xBench + out * 1.5, cy - 1.1, 1.3], [xBench + out * 2.7, cy - 1.1, 1.3],
                          [xBench + out * 2.7, cy - 1.1, 0], [xBench + out * 1.5, cy - 1.1, 0]);
          ctx.fill();
        }
      }

      /* ── EVERYBODY WHO IS NOT IN THE GAME ─────────────────────────────
         Forty-odd of them per side, in three ragged ranks: the substitutes
         up on the white line in full kit watching the ball, the coaches
         behind them in club jackets, and the staff further back. This is the
         single cheapest thing that turns a field into a touchline. */
      var i, seed = side < 0 ? 31 : 77, N = 34;
      for (i = 0; i < N; i++) {
        var r1 = ((i * 37 + seed) % 100) / 100;
        var r2 = ((i * 61 + seed * 3) % 100) / 100;
        var r3 = ((i * 17 + seed * 7) % 100) / 100;
        var y = 8 + r1 * 84;
        if (y < yNear + 0.6 || y > yFar) continue;
        var rank = i % 3;
        var x = xLine + out * (rank * 1.35 + r2 * 1.1);
        var sc = cam.scale(y);
        if (sc < 2.4) continue;
        var h = BODY * sc * (0.90 + r3 * 0.08);
        var kind = rank === 0 ? (r3 < 0.86 ? 'player' : 'coach')
                 : rank === 1 ? (r3 < 0.44 ? 'coach' : 'player') : (r3 < 0.30 ? 'staff' : 'coach');
        if (kind === 'player') {
          bystander(x, y, h, { pads: true, body: rgba(kit, 0.92), head: shade(kit, -0.45),
            legs: 'rgba(214,222,232,.78)', rate: 1.0 + r2 * 0.9, ph: i * 1.7, sway: 0.026 });
        } else if (kind === 'coach') {
          bystander(x, y, h, { pads: false, body: '#1b212b', head: '#3a4756',
            legs: '#22303c', rate: 0.7 + r2 * 0.6, ph: i * 2.3, sway: 0.016 });
        } else {
          bystander(x, y, h, { pads: false, body: '#8e3b2c', head: '#3a4756',
            legs: '#2a3340', rate: 0.6 + r2 * 0.5, ph: i * 1.1, sway: 0.014 });
        }
      }
    });

    /* ── THE CHAIN CREW ──────────────────────────────────────────────────
       Two poles and a chain between them, standing on the far touchline where
       they really do — and the down box where the ball was spotted. */
    var cs, cx0, cy0, cy1;
    if (o.firstDown != null && o.firstDown > yNear && o.firstDown < 102) {
      cy0 = o.firstDown; cs = cam.scale(cy0);
      if (cs > 3) {
        cx0 = cam.sx(hw + 2.0, cy0);
        ctx.strokeStyle = 'rgba(244,206,74,.95)';
        ctx.lineWidth = Math.max(1.1, cs * 0.09);
        ctx.beginPath();
        ctx.moveTo(cx0, cam.sy(cy0, 0));
        ctx.lineTo(cx0, cam.sy(cy0, 2.3));
        ctx.stroke();
        ctx.fillStyle = 'rgba(244,206,74,.95)';
        ctx.beginPath();
        ctx.arc(cx0, cam.sy(cy0, 2.4), Math.max(1.4, cs * 0.13), 0, 6.2832);
        ctx.fill();
      }
    }
    if (o.los != null && o.los > yNear && o.los < 102) {
      cy1 = o.los; cs = cam.scale(cy1);
      if (cs > 3) {
        cx0 = cam.sx(hw + 2.0, cy1);
        ctx.strokeStyle = 'rgba(226,236,244,.85)';
        ctx.lineWidth = Math.max(1.1, cs * 0.08);
        ctx.beginPath();
        ctx.moveTo(cx0, cam.sy(cy1, 0));
        ctx.lineTo(cx0, cam.sy(cy1, 2.0));
        ctx.stroke();
        ctx.fillStyle = 'rgba(226,110,60,.92)';
        roundRect(ctx, cx0 - cs * 0.16, cam.sy(cy1, 2.5), cs * 0.32, cs * 0.30, cs * 0.05);
        ctx.fill();
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
    g.addColorStop(0, L.haze + '0.17)');
    g.addColorStop(0.55, L.haze + '0.05)');
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
    /* HOW HARD IT IS LIT, AND FROM WHERE. Under a sky the light is even and
       the corners barely fall away; under a ring of masts the middle of the
       field is the brightest thing in the building and everything outside the
       pool goes to black. One pair of numbers per time of day, and a night
       game stops looking like an afternoon one with a blue filter on it. */
    var pw = L.pool == null ? 0.5 : L.pool, pe = L.edge == null ? 0.2 : L.edge;
    var Wx0 = weatherOf(o.weather), flat = Wx0.flat || 0;
    pw *= (1 - flat * 0.62); pe *= (1 - flat * 0.55);
    var pool = ctx.createRadialGradient(cx, cy * 0.92, rad * 0.10, cx, cy * 0.92, rad);
    pool.addColorStop(0, 'rgba(255,251,232,' + (0.055 + pw * 0.085).toFixed(3) + ')');
    pool.addColorStop(0.42, 'rgba(255,248,225,' + (0.015 + pw * 0.030).toFixed(3) + ')');
    pool.addColorStop(0.78, 'rgba(0,0,0,' + (0.03 + pe * 0.13).toFixed(3) + ')');
    pool.addColorStop(1, 'rgba(0,0,0,' + (0.06 + pe * 0.40).toFixed(3) + ')');
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
    var gr = seats(), gi, gN = clamp(Math.round(W * H / 2600), 40, 170);
    var grTop = cam.sy(Math.min(yFar, 100));
    var pass2;
    for (pass2 = 0; pass2 < 2; pass2++) {
      ctx.fillStyle = pass2 ? 'rgba(0,0,0,.020)' : 'rgba(255,255,255,.014)';
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
      paint(0, n, FIELD.width, n, major ? 'rgba(255,255,255,.60)' : 'rgba(255,255,255,.34)',
        major ? 0.26 : 0.17);
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
      paint(FIELD.half - 6.17 - t, n, FIELD.half - 6.17 + t, n, 'rgba(255,255,255,.44)', 0.16);
      paint(FIELD.half + 6.17 - t, n, FIELD.half + 6.17 + t, n, 'rgba(255,255,255,.44)', 0.16);
      paint(1.1, n, 1.1 + t * 2, n, 'rgba(255,255,255,.32)', 0.16);
      paint(FIELD.width - 1.1 - t * 2, n, FIELD.width - 1.1, n, 'rgba(255,255,255,.32)', 0.16);
    }

    /* ── SIDELINES ─────────────────────────────────────────────────────
       PAINT, IN PERSPECTIVE. Drawn as one stroke of constant width it was a
       white wall down each edge of the picture — thick enough at the near end
       to hide the touchline and the men standing on it. A sideline is four
       inches of paint with a six-foot white border outside it, and both of
       them narrow as they run away from you like everything else does. */
    var a3 = Math.max(-FIELD.endzone, yNear), b3 = FIELD.length + FIELD.endzone;
    [0, FIELD.width].forEach(function (sxw) {
      var dirn = sxw === 0 ? -1 : 1;
      /* the six-foot border outside the line */
      ctx.fillStyle = 'rgba(236,242,248,.16)';
      ground(sxw, sxw + dirn * 2.0, a3, b3);
      ctx.fill();
      /* the line itself */
      ctx.fillStyle = 'rgba(255,255,255,.80)';
      ground(sxw - dirn * 0.10, sxw + dirn * 0.30, a3, b3);
      ctx.fill();
    });

    /* ── THE NUMBERS, painted flat on the turf ─────────────────────────── */
    for (n = 10; n <= 90; n += 10) {
      if (n < yNear + 1) continue;
      var lat = cam.lat(n), fore = cam.fore(n);
      if (lat < 2.2) continue;
      var label = String(n <= 50 ? n : 100 - n);
      ctx.fillStyle = 'rgba(255,255,255,.62)';
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
    /* THE STICKS BEHIND YOU ARE NOT IN THE SHOT. A camera set up behind the
       offence has its own goal post over its shoulder, not standing in the
       middle of the picture; drawn anyway it put two yellow poles straight
       through the formation. */
    goalposts(ctx, cam, 100, '#f2c744', wind);
    if (cam.y < 14) goalposts(ctx, cam, 0, '#f2c744', wind);
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
    /* A BROADCAST LINE IS PAINT, NOT A HIGHLIGHT. It runs sideline to
       sideline, it is about a yard wide, it has a hard edge, and it sits
       UNDER the players — which is the whole reason the effect works on
       television. A fat translucent band across the whole picture is a debug
       overlay with a colour picked for it. */
    function band(y, color, edge, t) {
      if (y == null || y > 100.6 || y < cam.nearestY() - 1) return;
      var x0 = -0.6, x1 = FIELD.width + 0.6;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(cam.sx(x0, y - t), cam.sy(y - t));
      ctx.lineTo(cam.sx(x1, y - t), cam.sy(y - t));
      ctx.lineTo(cam.sx(x1, y + t), cam.sy(y + t));
      ctx.lineTo(cam.sx(x0, y + t), cam.sy(y + t));
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = edge;
      ctx.lineWidth = Math.max(0.7, cam.fore(y) * 0.10);
      ctx.beginPath();
      ctx.moveTo(cam.sx(x0, y - t), cam.sy(y - t));
      ctx.lineTo(cam.sx(x1, y - t), cam.sy(y - t));
      ctx.moveTo(cam.sx(x0, y + t), cam.sy(y + t));
      ctx.lineTo(cam.sx(x1, y + t), cam.sy(y + t));
      ctx.stroke();
    }
    band(los, 'rgba(46,118,240,.62)', 'rgba(120,180,255,.42)', 0.16);
    band(firstDown, 'rgba(238,186,38,.86)', 'rgba(255,226,140,.55)', 0.20);
  }

  /* ── THE CREASE ───────────────────────────────────────────────────────────
     The hole, while the run is happening. Not the lane the play was drawn
     with — the gap the blocking has actually made, handed over by the live
     simulation frame by frame.

     It is drawn as grass rather than as a diagram: a soft wedge that opens
     out of the line of scrimmage, brightest where the hole is widest and gone
     three yards downfield. A player watching a run can otherwise only see a
     man vanish into a pile; this is the four-yards-instead-of-one, on the
     field, while it is still true. Quiet on purpose — it must never be the
     brightest thing on the screen, which is the football. */
  function crease(ctx, cam, c) {
    if (!c || !(c.w > 0)) return;
    var a = 0.05 + c.open * 0.16;
    var y0 = c.y - 0.4, y1 = c.y + 3.4;
    var half0 = c.w / 2, half1 = c.w / 2 * 0.62;
    var grad;
    var xa = cam.sx(c.x, y0), ya = cam.sy(y0), yb = cam.sy(y1);
    try {
      grad = ctx.createLinearGradient(xa, ya, xa, yb);
      grad.addColorStop(0, 'rgba(242,199,68,' + a.toFixed(3) + ')');
      grad.addColorStop(1, 'rgba(242,199,68,0)');
      ctx.fillStyle = grad;
    } catch (_) { ctx.fillStyle = 'rgba(242,199,68,' + (a * 0.6).toFixed(3) + ')'; }
    ctx.beginPath();
    ctx.moveTo(cam.sx(c.x - half0, y0), cam.sy(y0));
    ctx.lineTo(cam.sx(c.x + half0, y0), cam.sy(y0));
    ctx.lineTo(cam.sx(c.x + half1, y1), cam.sy(y1));
    ctx.lineTo(cam.sx(c.x - half1, y1), cam.sy(y1));
    ctx.closePath();
    ctx.fill();
    /* the two edges of it, so the hole has a shape rather than a glow */
    ctx.strokeStyle = 'rgba(242,199,68,' + (a * 1.5).toFixed(3) + ')';
    ctx.lineWidth = Math.max(1, 1.6 * cam.lat(y0) / 15);
    ctx.beginPath();
    ctx.moveTo(cam.sx(c.x - half0, y0), cam.sy(y0));
    ctx.lineTo(cam.sx(c.x - half1, y1), cam.sy(y1));
    ctx.moveTo(cam.sx(c.x + half0, y0), cam.sy(y0));
    ctx.lineTo(cam.sx(c.x + half1, y1), cam.sy(y1));
    ctx.stroke();
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
    camera: camera, uniform: uniform, shade: shade, readable: readable, rgba: rgba, hex: hex, mix: mix,
    player: player, target: target, ball: ball,
    stadium: stadium, goalposts: goalposts, sidelines: sidelines,
    atmosphere: atmosphere, conditions: conditions, LIGHT: LIGHT, WEATHER: WEATHER, field: field, markers: markers, art: art, crease: crease, roundRect: roundRect
  };
  root.EDGridironPaint = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
