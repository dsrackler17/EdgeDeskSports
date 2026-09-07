/* ===========================================================================
   GRIDIRON — THE LINEUP.

   Your roster, standing on a football field in the positions they play,
   instead of listed in a table. Same artist, same camera, same uniforms as
   the game itself: the men you see here are the men who take the snap.

   It reads nothing and decides nothing. Hand it a team and it draws the
   eleven that would line up.
   =========================================================================== */
(function (root) {
  'use strict';

  var P = root.EDGridironPaint || (typeof require === 'function' ? require('./paint.js') : null);
  var ST = root.EDGridironStage || (typeof require === 'function' ? require('./stage.js') : null);
  var F = root.EDFootball || (typeof require === 'function' ? require('./football.js') : null);
  var G = root.EDGridiron || (typeof require === 'function' ? require('./engine.js') : null);

  /* which look each side of the ball is shown in */
  var SHOWS = {
    offense: { form: 'i_form', play: 'iso' },
    defense: { def: 'two_deep' }
  };

  /* the eleven, in world yards, with a name and an overall to put on them */
  function eleven(team, side, theme, away) {
    var t = G.makeTeam(team);
    var units = G.unitsOf(t, 0);
    var kit = P.uniform(theme || themeOf(t), !!away);
    var los = 30, bx = P.FIELD.half;
    if (side === 'defense') {
      var parts = F.defParts(SHOWS.defense.def);
      return { men: ST.alignDefense(parts, bx, los, 1, units, null, null, kit),
               los: los, kit: kit, parts: parts };
    }
    var playObj = F.play(SHOWS.offense.play) || F.play('iso');
    return { men: ST.alignOffense(playObj, SHOWS.offense.form, bx, los, units, kit), los: los, kit: kit };
  }

  /* BOTH TEAMS, ACROSS THE BALL FROM EACH OTHER. Your eleven in your kit,
     theirs in theirs, on the same line of scrimmage — which is the picture a
     game about to kick off should be showing. */
  function faceoff(home, away, homeTheme, awayTheme) {
    var o = eleven(home, 'offense', homeTheme, false);
    var d = eleven(away, 'defense', awayTheme, true);
    return { men: o.men.concat(d.men), los: o.los, parts: d.parts };
  }

  function themeOf(t) {
    /* the franchise hands us a theme object; the league hands us a key */
    if (t.theme && typeof t.theme === 'object') return t.theme;
    return { primary: t.primary || '#3fb883', secondary: '#123326', ink: '#06231a' };
  }

  /* what a slot is actually called on a depth chart. The stage names them
     DL0..DL3 because it only needs to tell them apart; a roster page has to
     use the words a coach would. */
  var LABEL = {
    DL0: 'LE', DL1: 'DT', DL2: 'DT', DL3: 'RE', DL4: 'RE',
    LB0: 'WLB', LB1: 'MLB', LB2: 'SLB', LB3: 'LB',
    CB0: 'CB', CB1: 'CB', CB2: 'NB', CB3: 'DB',
    S0: 'FS', S1: 'SS', S2: 'S',
    SL: 'SLOT', SL2: 'SLOT'
  };
  function labelFor(m, front) {
    var k = String(m.slot || m.pos || '');
    if (front === '34' && (k === 'DL1' || k === 'DL2')) return k === 'DL1' ? 'NT' : 'DE';
    return LABEL[k] || k;
  }

  /* ── DRAW ────────────────────────────────────────────────────────────────
     Give it a canvas and a team. It frames the shot around the eleven so all
     of them fit, draws the turf and the men, tags each with the job he does,
     and returns where each one landed so the page can make him tappable. */
  function draw(canvas, team, side, opts) {
    opts = opts || {};
    var w = canvas.clientWidth || 360, h = canvas.clientHeight || 240;
    if (!w || !h) return [];
    var dpr = Math.min(2.5, root.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var set = side === 'faceoff'
      ? faceoff(team, opts.away, opts.theme, opts.awayTheme)
      : eleven(team, side, opts.theme);
    var men = set.men;
    var loX = 1e9, hiX = -1e9, loY = 1e9, hiY = -1e9;
    men.forEach(function (m) {
      if (m.x < loX) loX = m.x; if (m.x > hiX) hiX = m.x;
      if (m.y < loY) loY = m.y; if (m.y > hiY) hiY = m.y;
    });

    /* FRAME THEM ALL. How wide the group is sets how big a man is drawn, and
       how deep it is sets how high the lens goes, so eleven men spread over
       four yards fill the picture just as eleven spread over twenty do.
       The lens focuses on the NEAREST row, because that is the widest one:
       perspective spreads what is close to you, so a corner standing on the
       near numbers is the man who falls off the edge of the picture. */
    var back = 53;
    var wide = Math.max(24, (hiX - loX) + 11);
    var px = clamp(w / (0.88 * wide), 6, 30);
    var depth = clamp(hiY - loY, 2.5, 40);
    var A = 0.64 * h * back * (back + depth) / depth;
    var cam = P.camera({
      w: w, h: h, x: (loX + hiX) / 2, y: loY,
      back: back, px: px, wide: wide,
      height: clamp(A / (px * back), 24, 190),
      anchor: 0.80
    });

    ctx.clearRect(0, 0, w, h);
    P.field(ctx, cam, { tick: 0, homeColor: opts.homeColor, awayColor: opts.awayColor,
      homeName: opts.homeName || '', awayName: '' });
    P.markers(ctx, cam, set.los, null);

    var front = set.parts && set.parts.front ? set.parts.front.key : null;
    var boxes = [];
    men.slice().sort(function (a, b) { return b.y - a.y; }).forEach(function (m) {
      m.state = 'stance';
      m.face = (side === 'defense' || m.side === 'def') ? 'front' : 'back';
      m.phase = 0;
      P.player(ctx, m, cam);
      boxes.push({ id: m.id, slot: m.slot, pos: m.pos, name: m.name, num: m.num,
        label: labelFor(m, front),
        x: cam.sx(m.x, m.y), y: cam.sy(m.y), r: Math.max(15, cam.scale(m.y) * 1.2) });
    });

    /* THE TAGS, AND NONE OF THEM ON TOP OF EACH OTHER. A guard and a centre
       stand a yard apart; their names do not fit in a yard. So each tag is
       placed under its man and then pushed down until it is clear of the
       ones already down — which is what a broadcast graphic does too. */
    if (opts.tags === false) return boxes;
    var fs = clamp(h * 0.034, 8, 13);
    ctx.font = '800 ' + Math.round(fs) + 'px "Space Grotesk", Inter, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    var placed = [];
    boxes.slice().sort(function (a, b) { return a.y - b.y; }).forEach(function (b) {
      if (!b.label) return;
      var tw = ctx.measureText(b.label).width + fs * 0.9, th = fs * 1.4;
      /* a man near the bottom of the frame wears his tag above him instead,
         because below him there is no frame left */
      var up = b.y > h - th * 3.2;
      var ty = b.y + (up ? -1 : 1) * fs * 1.3, guard = 0;
      while (guard++ < 40 && placed.some(function (q) {
        return Math.abs(q.x - b.x) < (q.w + tw) / 2 + 2 && Math.abs(q.y - ty) < th + 2;
      })) ty += (up ? -1 : 1) * th * 0.92;
      ty = clamp(ty, th * 0.6, h - th * 0.6);
      placed.push({ x: b.x, y: ty, w: tw });
      b.tagY = ty;
      /* a tag that had to be pushed clear gets a tick back to its man, so a
         guard's name is never mistaken for a tackle's */
      if (Math.abs(ty - b.y) > fs * 1.9) {
        ctx.strokeStyle = 'rgba(207,224,216,.30)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(b.x, b.y + (ty > b.y ? fs * 0.5 : -fs * 0.5));
        ctx.lineTo(b.x, ty + (ty > b.y ? -th / 2 : th / 2));
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(6,10,14,.86)';
      P.roundRect(ctx, b.x - tw / 2, ty - th / 2, tw, th, th / 2);
      ctx.fill();
      ctx.fillStyle = '#cfe0d8';
      ctx.fillText(b.label, b.x, ty);
    });
    return boxes;
  }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  var API = { draw: draw, eleven: eleven, faceoff: faceoff, SHOWS: SHOWS };
  root.EDGridironLineup = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
