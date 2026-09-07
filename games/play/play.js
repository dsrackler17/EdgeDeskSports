/* ===========================================================================
   GAME DAY — the page you play on.

   The view layer and nothing more. Every football decision belongs to
   games/lib/gridiron/*: this file asks the session for a game, paints the
   scoreboard, hands the STAGE a snap to play out, and turns thumbs into calls.
   If a number appears on this page, something under lib/ computed it.

   THE LOOP, once a game is under way:

     open the drawer  →  pick a play  →  they line up  →  SNAP
                                                           │
        run:   joystick, juke, truck  ────────────────┐    │
        pass:  the routes develop, tap a receiver  ───┤    │
        defence: joystick, switch, tackle  ───────────┘    │
                                                           ▼
                             the play happens on the field, and the
                             whistle brings the next down
   =========================================================================== */
(function () {
  'use strict';

  var F = window.EDFootball, G = window.EDGridiron, AI = window.EDGridironAI,
      Auto = window.EDGridironAuto, ST = window.EDGridironStage, PT = window.EDGridironPaint,
      S = window.EDGridironSession, RO = window.EDRoster, GM = window.EDGames, FR = window.EDFranchise;

  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function ordinal(n) {
    var t = n % 100, o = n % 10;
    return n + (t >= 11 && t <= 13 ? 'th' : o === 1 ? 'st' : o === 2 ? 'nd' : o === 3 ? 'rd' : 'th');
  }

  var gd = $('gd'), pre = $('pre'), preCard = $('preCard'), sb = $('sb'), ovHost = $('ovHost'),
      fieldWrap = $('fieldWrap'), canvas = $('fld'), pad = $('pad'), drawer = $('drawer'),
      sayEl = $('say'), readEl = $('read');

  var set = S.settings();
  var game = null, stage = null, me = 'home', teams = { me: null, opp: null };
  var busy = false, pendingCall = null, ballX = PT.FIELD.half, lastResult = null;
  var tipsSeen = {};
  try { tipsSeen = JSON.parse(localStorage.getItem('ed_gridiron_tips') || '{}'); } catch (_) {}

  /* ── SOUND ───────────────────────────────────────────────────────────────
     Every noise this game makes is SYNTHESISED HERE, from oscillators and
     shaped noise, at the moment it is needed. Nothing is downloaded, nothing
     is licensed and nothing is sampled from anywhere: a football hitting a
     pair of hands is a filtered noise burst with a fast envelope, and a
     stadium is two seconds of low-passed noise on a loop with its level moved
     around. That is the whole kit.

     It never starts on its own — a browser would refuse anyway — and the
     switch in the corner of the field turns all of it off. */
  var actx = null;
  function ac() {
    if (!actx) {
      try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { return null; }
    }
    if (actx.state === 'suspended') { try { actx.resume(); } catch (_) {} }
    return actx;
  }
  /* one tone: a shape, a pitch that can slide, and an envelope */
  function tone(o) {
    if (!set.sound) return;
    var c = ac(); if (!c) return;
    try {
      var t0 = c.currentTime + (o.at || 0);
      var osc = c.createOscillator(), g = c.createGain();
      osc.type = o.type || 'sine';
      osc.frequency.setValueAtTime(o.f, t0);
      if (o.f2) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.f2), t0 + o.d);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.g == null ? 0.05 : o.g), t0 + (o.a || 0.008));
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.d);
      var node = g;
      if (o.lp) {
        var f = c.createBiquadFilter();
        f.type = 'lowpass'; f.frequency.value = o.lp;
        g.connect(f); node = f;
      }
      osc.connect(g); node.connect(c.destination);
      osc.start(t0); osc.stop(t0 + o.d + 0.02);
    } catch (_) {}
  }
  /* one burst of shaped noise: contact, leather, a whistle's breath */
  var NOISEBUF = null;
  function noiseBuffer(c) {
    if (NOISEBUF) return NOISEBUF;
    var len = Math.floor(c.sampleRate * 1.0);
    var b = c.createBuffer(1, len, c.sampleRate), d = b.getChannelData(0);
    /* THE PAGE OWNS NO DICE. Even noise comes off a seeded stream, so nothing
       here can ever be mistaken for the game deciding something. */
    var sd = 20260907, i;
    for (i = 0; i < len; i++) { sd = (sd * 1103515245 + 12345) & 0x7fffffff; d[i] = sd / 0x7fffffff * 2 - 1; }
    NOISEBUF = b;
    return b;
  }
  function burst(o) {
    if (!set.sound) return;
    var c = ac(); if (!c) return;
    try {
      var t0 = c.currentTime + (o.at || 0);
      var src = c.createBufferSource();
      src.buffer = noiseBuffer(c);
      src.playbackRate.value = o.rate || 1;
      var f = c.createBiquadFilter();
      f.type = o.filter || 'bandpass';
      f.frequency.setValueAtTime(o.f, t0);
      if (o.f2) f.frequency.exponentialRampToValueAtTime(Math.max(60, o.f2), t0 + o.d);
      f.Q.value = o.q == null ? 1.1 : o.q;
      var g = c.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.g == null ? 0.06 : o.g), t0 + (o.a || 0.005));
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.d);
      src.connect(f); f.connect(g); g.connect(c.destination);
      src.start(t0); src.stop(t0 + o.d + 0.02);
    } catch (_) {}
  }
  var SOUND = {
    tap: function () { tone({ f: 620, f2: 520, d: 0.045, type: 'triangle', g: 0.028 }); },
    /* THE SNAP: leather in two hands and eleven men moving at once. A click
       and a thump, forty milliseconds apart, which is what a snap sounds
       like from twenty rows up. */
    snap: function () {
      burst({ f: 2600, f2: 900, d: 0.055, g: 0.05, q: 0.8 });
      tone({ f: 120, f2: 62, d: 0.13, type: 'sine', g: 0.075 });
    },
    /* CONTACT: pads. Low, short, and with a crack of noise on the front. */
    hit: function (hard) {
      var v = hard ? 1.5 : 1;
      burst({ f: 1500, f2: 320, d: 0.09 * v, g: 0.055 * v, q: 0.6 });
      tone({ f: 92, f2: 46, d: 0.17 * v, type: 'sine', g: 0.085 * v, lp: 400 });
    },
    /* THE BALL INTO A PAIR OF HANDS */
    catch_: function () { burst({ f: 3200, f2: 1400, d: 0.06, g: 0.042, q: 0.7 }); },
    /* A FOOT THROUGH A FOOTBALL */
    kick: function () {
      burst({ f: 900, f2: 240, d: 0.07, g: 0.075, q: 0.5 });
      tone({ f: 150, f2: 58, d: 0.20, type: 'sine', g: 0.10, lp: 500 });
    },
    /* A WHISTLE: two hard blasts with the breath in them */
    whistle: function () {
      [0, 0.13].forEach(function (at) {
        tone({ f: 2350, d: 0.11, type: 'sine', g: 0.030, at: at });
        tone({ f: 3120, d: 0.11, type: 'sine', g: 0.020, at: at });
        burst({ f: 3000, d: 0.10, g: 0.014, q: 6, at: at });
      });
    },
    /* THE MOVING CHAINS: a rising pair, bright and short */
    first: function () {
      tone({ f: 660, d: 0.10, type: 'triangle', g: 0.045 });
      tone({ f: 990, d: 0.16, type: 'triangle', g: 0.045, at: 0.085 });
      swell(0.5, 0.9);
    },
    /* SIX POINTS: a fanfare on top of a stadium standing up */
    td: function () {
      [523, 659, 784, 1047, 1319].forEach(function (f, i) {
        tone({ f: f, d: 0.28, type: 'triangle', g: 0.050, at: i * 0.085 });
        tone({ f: f / 2, d: 0.30, type: 'sine', g: 0.030, at: i * 0.085 });
      });
      swell(1, 2.4);
    },
    /* A TURNOVER: the sound of eighty thousand people sitting down */
    bad: function () {
      tone({ f: 300, f2: 96, d: 0.42, type: 'sawtooth', g: 0.055, lp: 900 });
      tone({ f: 148, f2: 60, d: 0.5, type: 'sine', g: 0.045, at: 0.09 });
      swell(0.85, 1.6);
    },
    crowd: function () { swell(0.7, 1.8); },
    /* THE ROOM TONE. Eighty thousand people are a band of noise, not a note:
       a loop of shaped noise through a bandpass, whose level is the same
       number the crowd in the stands is drawn at. */
    ambience: function (level) {
      if (!set.sound) { bedStop(); return; }
      bedStart();
      if (!bed) return;
      try {
        var v = Math.max(0, Math.min(1, level || 0));
        bed.gain.gain.setTargetAtTime(0.006 + v * 0.052, actx.currentTime, 0.45);
        bed.filter.frequency.setTargetAtTime(380 + v * 560, actx.currentTime, 0.6);
      } catch (_) {}
    },
    quiet: function () { bedStop(); }
  };
  /* THE ROAR. A crowd does not step up a level, it surges and comes back
     down; this rides the bed up and lets it fall over a couple of seconds. */
  function swell(peak, secs) {
    if (!set.sound) return;
    bedStart();
    if (!bed || !actx) return;
    try {
      var t0 = actx.currentTime;
      bed.gain.gain.cancelScheduledValues(t0);
      bed.gain.gain.setValueAtTime(Math.max(0.001, bed.gain.gain.value), t0);
      bed.gain.gain.linearRampToValueAtTime(0.014 + peak * 0.085, t0 + 0.22);
      bed.gain.gain.setTargetAtTime(0.010 + peak * 0.020, t0 + 0.22, (secs || 1.5) * 0.4);
      bed.filter.frequency.setTargetAtTime(420 + peak * 900, t0, 0.2);
    } catch (_) {}
  }
  /* the crowd bed: built once, on the first gesture that is allowed to make
     sound, and left running with its level moved rather than restarted */
  var bed = null;
  function bedStart() {
    if (bed) return;
    var c = ac(); if (!c) return;
    try {
      var len = Math.floor(c.sampleRate * 2.0);
      var buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
      var last = 0, i, sd = 20260907;
      function nz() { sd = (sd * 1103515245 + 12345) & 0x7fffffff; return sd / 0x7fffffff * 2 - 1; }
      for (i = 0; i < len; i++) {
        /* a one-pole low pass on white noise: closer to the weight of a crowd
           than white noise, which is rain */
        last = last * 0.86 + nz() * 0.14;
        d[i] = last * 3.2;
      }
      var src = c.createBufferSource();
      src.buffer = buf; src.loop = true;
      var flt = c.createBiquadFilter();
      flt.type = 'bandpass'; flt.frequency.value = 420; flt.Q.value = 0.7;
      var g = c.createGain();
      g.gain.value = 0.008;
      src.connect(flt); flt.connect(g); g.connect(c.destination);
      src.start();
      bed = { src: src, filter: flt, gain: g };
    } catch (_) { bed = null; }
  }
  function bedStop() {
    if (!bed || !actx) { bed = null; return; }
    try { bed.gain.gain.setTargetAtTime(0.0001, actx.currentTime, 0.3); bed.src.stop(actx.currentTime + 1.2); } catch (_) {}
    bed = null;
  }
  /* ── HAPTICS ─────────────────────────────────────────────────────────────
     Three weights and nothing else: a tap, a hit, a score. Feature-detected,
     never relied on, and off with the switch. */
  function buzz(kind) {
    if (!set.haptics || !navigator.vibrate) return;
    try {
      navigator.vibrate(kind === 'strong' ? [26, 40, 22, 40, 60]
        : kind === 'medium' ? [18] : [8]);
    } catch (_) {}
  }

  /* ── COLOURS ──────────────────────────────────────────────────────────── */
  function themeOf(key) {
    var t = null;
    (FR && FR.THEMES ? FR.THEMES : []).forEach(function (x) { if (x.key === key) t = x; });
    return t || { primary: '#3fb883', secondary: '#123326', ink: '#06231a' };
  }
  /* THE PAINT ON TEN YARDS OF GRASS. A club's deep colour, carrying enough of
     its loud one that the end zone is recognisably theirs from ninety yards
     rather than a dark hole at the end of the field. Same rule the live stage
     uses, so the poster and the game agree. */
  function ezPaint(theme, fb) {
    var deep = (theme && theme.secondary) || fb || '#123326';
    var PP = window.EDGridironPaint;
    if (!theme || !theme.primary || !PP || !PP.mix) return deep;
    var m = PP.mix(deep, theme.primary, 0.30);
    var v = PP.hex(m);
    return (v[0] * 299 + v[1] * 587 + v[2] * 114) / 1000 < 34 ? PP.shade(m, 0.24) : m;
  }
  /* the colour a club paints its name in on its own end zone: the loud one,
     unless it is too close to the paint under it to be read from ninety
     yards, in which case white */
  function ezInk(t) {
    if (!t || !t.primary || !t.secondary) return '#ffffff';
    var P2 = window.EDGridironPaint;
    if (!P2 || !P2.hex) return '#ffffff';
    function lum(c) { var v = P2.hex(c); return (v[0] * 299 + v[1] * 587 + v[2] * 114) / 1000; }
    if (Math.abs(lum(t.primary) - lum(t.secondary)) < 78) return '#ffffff';
    return lum(t.primary) < 120 ? P2.shade(t.primary, 0.34) : t.primary;
  }
  function kitFor(side) {
    var mine = themeOf(teams.me.theme), theirs = themeOf(teams.opp.theme);
    if (mine.primary === theirs.primary) theirs = { primary: '#c9d3e0', secondary: '#2a3140', ink: '#12161d' };
    return side === 'me' ? mine : theirs;
  }

  /* ── SCOREBOARD ───────────────────────────────────────────────────────── */
  function paintScore() {
    var sit = G.situation(game), h = game.home, a = game.away, poss = sit.offense;
    function tos(side) {
      var n = game.timeouts[side], s = '', i;
      for (i = 0; i < 3; i++) s += '<i class="' + (i < n ? 'on' : '') + '"></i>';
      return '<span class="sb-to" aria-label="' + n + ' timeouts">' + s + '</span>';
    }
    var q = game.quarter > game.cfg.quarters ? 'OT' + (game.ot > 1 ? game.ot : '') : 'Q' + game.quarter;
    var yard = sit.ball > 50 ? 'OPP ' + (100 - sit.ball) : sit.ball === 50 ? 'MIDFIELD' : 'OWN ' + sit.ball;
    var dd = sit.phase === 'play'
      ? '<b>' + ordinal(sit.down) + ' &amp; ' + (sit.goalToGo ? 'Goal' : sit.toGo) + '</b><span>at ' + yard + '</span>'
      : sit.phase === 'kickoff' ? '<b>Kickoff</b>'
      : sit.phase === 'pat' ? '<b>After the touchdown</b>'
      : sit.phase === 'halftime' ? '<b>Halftime</b>' : '<b>Final</b>';
    /* A SCOREBOARD WITHOUT COLOUR IS A TABLE. Each side wears its own rule so
       you know whose number you are reading before you have read it. */
    function bar(side) {
      return '<span class="sb-bar" style="background:'
        + esc(kitFor(side === me ? 'me' : 'opp').primary || '#3fb883') + '"></span>';
    }
    /* the number that just changed is the one worth looking at */
    var pop = { home: '', away: '' };
    if (lastShown.home != null && game.score.home !== lastShown.home) pop.home = ' hit';
    if (lastShown.away != null && game.score.away !== lastShown.away) pop.away = ' hit';
    lastShown.home = game.score.home; lastShown.away = game.score.away;
    sb.innerHTML =
      '<div class="sb-row">'
      + '<div class="sb-team">' + bar('home') + (poss === 'home' ? '<span class="sb-poss"></span>' : '')
        + '<span class="sb-ab">' + esc(h.abbr) + '</span><span class="sb-pts mono' + pop.home + '">'
        + game.score.home + '</span></div>'
      + '<div class="sb-mid"><div class="sb-clock">' + G.clockLabel(game) + '</div><div class="sb-q">' + q + '</div></div>'
      + '<div class="sb-team right">' + bar('away') + (poss === 'away' ? '<span class="sb-poss left"></span>' : '')
        + '<span class="sb-ab">' + esc(a.abbr) + '</span><span class="sb-pts mono' + pop.away + '">'
        + game.score.away + '</span></div>'
      + '</div><div class="sb-dd">' + tos('home') + dd + tos('away') + '</div>';
  }
  /* what the scoreboard last showed, so a change can be seen happening */
  var lastShown = { home: null, away: null };
  function say(text, big) {
    sayEl.className = 'gd-say' + (big ? ' big' : '');
    sayEl.innerHTML = esc(text || '');
  }

  /* ── PLAY DIAGRAMS for the call sheet ─────────────────────────────────── */
  /* THE PLAY, AS A COACH WOULD SKETCH IT. Small, but big enough to tell a
     four-vertical from a screen without reading the name. */
  /* ── THE PLAY, AS A COACH WOULD SKETCH IT ────────────────────────────────
     Small, but big enough to tell a four-vertical from a screen without
     reading the name — which means it has to show the SHAPE of the concept:
     where the line is, who is on it, and where the football is going. Routes
     are coloured by how deep they run, so the depth of a concept is legible
     before any of the words are. */
  var DEPTH_INK = { short: '#7fe3c0', int: '#4fc9ff', deep: '#f2c744' };
  function diagram(playKey, formKey) {
    var play = F.play(playKey), form = F.formation(formKey), W = 92, H = 60;
    var cx = W / 2, ly = H * 0.66;
    var kx = 1.62, ky = 1.42;
    var out = '<svg class="pdiag" viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true">';
    /* the far hash, so there is a field under it rather than a void */
    out += '<line x1="2" y1="' + (ly - 13).toFixed(1) + '" x2="' + (W - 2) + '" y2="'
      + (ly - 13).toFixed(1) + '" stroke="rgba(255,255,255,.07)" stroke-width="1"/>';
    /* the line of scrimmage */
    out += '<line x1="2" y1="' + ly.toFixed(1) + '" x2="' + (W - 2) + '" y2="' + ly.toFixed(1)
      + '" stroke="rgba(255,255,255,.40)" stroke-width="1.3"/>';
    /* the five up front, as one block of men rather than five loose dots */
    [-4.4, -2.2, 0, 2.2, 4.4].forEach(function (dx) {
      out += '<rect x="' + (cx + dx * kx - 1.6).toFixed(1) + '" y="' + (ly - 4.4).toFixed(1)
        + '" width="3.2" height="3.4" rx="1.1" fill="rgba(233,237,244,.62)"/>';
    });

    var spots = form.spots, slot, paths = '', dots = '';
    for (slot in spots) {
      if (!spots.hasOwnProperty(slot)) continue;
      var s = spots[slot];
      var x = Math.max(3.5, Math.min(W - 3.5, cx + s[1] * kx * 0.56));
      var y = Math.min(H - 3.5, ly - s[0] * ky);
      var rk = play.assign && play.assign[slot];
      if (play.type === 'pass' && rk && rk !== 'block' && F.ROUTES[rk]) {
        var r = F.ROUTES[rk], mir = s[1] >= 0 ? 1 : -1;
        var d = 'M' + x.toFixed(1) + ',' + y.toFixed(1), lx = x, lyy = y;
        r.pts.forEach(function (pt) {
          lx = Math.max(2, Math.min(W - 2, x + pt[1] * mir * kx * 0.56));
          lyy = Math.max(2, y - pt[0] * ky * 0.70);
          d += 'L' + lx.toFixed(1) + ',' + lyy.toFixed(1);
        });
        var ink = DEPTH_INK[r.band] || DEPTH_INK.int;
        paths += '<path d="' + d + '" fill="none" stroke="' + ink + '" stroke-width="1.6" '
          + 'stroke-linecap="round" stroke-linejoin="round" opacity=".92"/>'
          /* a pip where the route ends: the eye finds the break instantly */
          + '<circle cx="' + lx.toFixed(1) + '" cy="' + lyy.toFixed(1) + '" r="1.5" fill="' + ink + '"/>';
      }
      dots += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="2.2" fill="#e9edf4"/>';
    }
    out += paths + dots;

    if (play.type === 'run') {
      /* THE TRACK THE FOOTBALL TAKES, AND EVERY RUN TAKES A DIFFERENT ONE.
         Three gap schemes drawn as the same yellow arrow are three cards you
         cannot tell apart, which is the whole job of the picture. */
      var lane = play.concept === 'outside' ? 9.5 : play.concept === 'gap' ? 4.6 : 1.4;
      var mis = playKey === 'counter' || playKey === 'draw' ? -3.4 : 0;
      var d2 = 'M' + cx + ',' + (ly + 9);
      if (mis) {
        /* the false step: he shows one way before he goes the other */
        d2 += 'Q' + (cx + mis).toFixed(1) + ',' + (ly + 6.5) + ' ' + (cx + mis * 0.55).toFixed(1)
            + ',' + (ly + 4);
      }
      d2 += 'Q' + (cx + lane * 0.55).toFixed(1) + ',' + (ly + 1) + ' '
          + (cx + lane).toFixed(1) + ',' + (ly - 9);
      out += '<path d="' + d2 + '" fill="none" stroke="#f2c744" stroke-width="2.1" '
        + 'stroke-linecap="round" stroke-linejoin="round"/>'
        + '<path d="M' + (cx + lane - 2.3).toFixed(1) + ',' + (ly - 7) + 'L' + (cx + lane).toFixed(1)
        + ',' + (ly - 11).toFixed(1) + 'L' + (cx + lane + 2.3).toFixed(1) + ',' + (ly - 7) + 'Z" fill="#f2c744"/>';
      /* a gap scheme pulls somebody: show him going the other way across it */
      if (play.concept === 'gap') {
        out += '<path d="M' + (cx - lane * 0.55 - 3.4).toFixed(1) + ',' + (ly - 2).toFixed(1)
          + ' Q' + (cx).toFixed(1) + ',' + (ly + 2.4).toFixed(1) + ' '
          + (cx + lane * 0.8).toFixed(1) + ',' + (ly - 3.2).toFixed(1)
          + '" fill="none" stroke="rgba(233,237,244,.55)" stroke-width="1.3" '
          + 'stroke-linecap="round" stroke-dasharray="2.4 2"/>';
      }
    }
    return out + '</svg>';
  }
  function defDiagram(defKey) {
    var parts = F.defParts(defKey), W = 88, H = 58, cx = W / 2, ly = H * 0.80;
    var out = '<svg class="pdiag" viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true">'
      + '<line x1="3" y1="' + ly.toFixed(1) + '" x2="' + (W - 3) + '" y2="' + ly.toFixed(1)
      + '" stroke="rgba(255,255,255,.34)" stroke-width="1.2"/>';
    var d = ST.alignDefense(parts, PT.FIELD.half, 0, 0, null, F.play('slant'), 'gun', null);
    d.forEach(function (a) {
      var x = Math.max(3, Math.min(W - 3, cx + (a.x - PT.FIELD.half) * 0.78));
      var y = Math.max(3, ly - a.y * 2.6);
      if (a.blitz) out += '<path d="M' + x.toFixed(1) + ',' + y.toFixed(1) + 'L' + cx + ',' + (ly + 3)
        + '" stroke="#e2664b" stroke-width="1.3" fill="none"/>';
      out += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="2.2" fill="'
        + (a.blitz ? '#e2664b' : a.pos === 'DL' ? '#e9edf4' : '#5c9dff') + '"/>';
    });
    return out + '</svg>';
  }

  /* ── THE DRAWER ───────────────────────────────────────────────────────── */
  var offTab = 'suggested', defTab = 'suggested';
  var tempo = 'normal';
  var OFF_TABS = [['suggested', 'Suggested'], ['run', 'Run'], ['pass', 'Pass'], ['pa', 'Play Action'], ['special', 'Special']];
  var DEF_TABS = [['suggested', 'Suggested'], ['man', 'Man'], ['zone', 'Zone'], ['blitz', 'Blitz'], ['run', 'Run D']];

  function drawerOpen(html) {
    drawer.innerHTML = html;
    drawer.classList.add('open');
    coverField();
  }
  function drawerClose() { drawer.classList.remove('open'); coverField(); }
  /* THE FOOTBALL GOES WHERE YOU CAN SEE IT. However much of the screen the
     call sheet is taking, the camera frames the line of scrimmage into what
     is left rather than behind it. Measured after the sheet has laid out. */
  function coverField() {
    if (!stage || !stage.setCover) return;
    var run = function () {
      var open = drawer.classList.contains('open');
      var fr = fieldWrap.getBoundingClientRect();
      /* MEASURED OFF THE LAYOUT, NOT OFF THE TRANSFORM. The sheet slides up
         over a quarter of a second; asked where it was on the next frame it
         truthfully answered "still off the bottom of the screen", so the
         camera never moved. offsetHeight is where it is going to be. */
      var h = window.innerHeight || fr.bottom;
      var over = open ? Math.max(0, fr.bottom - (h - drawer.offsetHeight)) : 0;
      stage.setCover(Math.min(over, fr.height * 0.54));
    };
    if (window.requestAnimationFrame) window.requestAnimationFrame(run); else run();
  }

  function offensePlays(tab, sit) {
    var book = F.playbook(teams.me.offense), all = [];
    book.forEach(function (g2) { g2.plays.forEach(function (p) { all.push(p); }); });
    if (tab === 'run') return all.filter(function (p) { return p.type === 'run' && p.group !== 'special'; });
    if (tab === 'pass') return all.filter(function (p) { return p.group === 'quick' || p.group === 'inter' || p.group === 'deep' || p.group === 'screen'; });
    if (tab === 'pa') return all.filter(function (p) { return p.group === 'pa' || p.group === 'trick'; });
    if (tab === 'special') return all.filter(function (p) { return p.group === 'special'; });
    var scheme = F.scheme(teams.me.offense), lean = AI.passLean(sit, scheme, game.mem[me]);
    return all.filter(function (p) { return p.group !== 'special'; })
      .map(function (p) { return { p: p, s: AI.scorePlay(p, sit, scheme, lean, { blitz: 0, deep: 0, stack: 0 }, AI.tier('pro'), game.mem[me]) }; })
      .sort(function (a, b) { return b.s - a.s; })
      .slice(0, 6).map(function (x) { return x.p; });
  }
  function defenseCalls(tab, sit) {
    var lean = AI.passLean(sit, F.scheme(teams.opp.offense), game.mem[G.other(me)]);
    var all = F.DEF_CALLS;
    if (tab === 'man') return all.filter(function (d) { var c = F.defParts(d).coverage.key; return c === 'cover0' || c === 'cover1'; });
    if (tab === 'zone') return all.filter(function (d) { var c = F.defParts(d).coverage.key; return c !== 'cover0' && c !== 'cover1' && F.defParts(d).pressure.key === 'none'; });
    if (tab === 'blitz') return all.filter(function (d) { return F.defParts(d).pressure.key !== 'none'; });
    if (tab === 'run') return all.filter(function (d) { var p = F.defParts(d); return p.front.box >= 7 || p.fit.key === 'pinch' || p.fit.key === 'aggressive'; });
    return all.map(function (d) { return { d: d, s: AI.scoreDefense(d, sit, lean) }; })
      .sort(function (a, b) { return b.s - a.s; }).slice(0, 6).map(function (x) { return x.d; });
  }

  function showOffenseDrawer() {
    var sit = G.situation(game);
    var list = offensePlays(offTab, sit);
    var scout = S.scoutRead(game, G.other(me));
    var head = '<div class="dr-grip"></div><div class="dr-head">'
      + '<span class="dr-title">' + ordinal(sit.down) + ' &amp; ' + (sit.goalToGo ? 'Goal' : sit.toGo)
      + '<b>' + (sit.ball > 50 ? 'Opp ' + (100 - sit.ball) : 'Own ' + sit.ball) + '</b></span>'
      + (scout.blitzShare != null ? '<span class="dr-tell">They blitz ' + Math.round(scout.blitzShare * 100)
          + '% · ' + scout.confidence + '</span>' : '')
      + '<button class="dr-x" id="drTO" type="button">Timeout</button></div>'
      + '<div class="dr-tabs">' + OFF_TABS.map(function (t) {
          return '<button data-tab="' + t[0] + '" aria-selected="' + (offTab === t[0]) + '">' + t[1] + '</button>';
        }).join('') + '</div>';
    var body = '<div class="dr-list">' + list.map(function (p, i) {
      var forms = F.playForms(p.key, teams.me.offense);
      var fk = forms[0] || p.forms[0];
      /* THE CALL THE COACH WOULD MAKE, MARKED. Three suggestions in a list of
         identical cards is three suggestions nobody reads; the first one on
         the suggested tab wears the accent and says why it is there. */
      var top = offTab === 'suggested' && i === 0;
      return '<button class="dr-play' + (top ? ' dr-top' : '') + '" type="button" data-play="'
        + esc(p.key) + '" data-form="' + esc(fk) + '">'
        + diagram(p.key, fk)
        + '<span class="dr-txt">'
        + (top ? '<u>Top call · ' + esc(ordinal(sit.down)) + ' &amp; '
            + (sit.goalToGo ? 'goal' : sit.toGo) + '</u>' : '')
        + '<b>' + esc(p.name) + '</b>'
        + '<i>' + esc(F.formation(fk).name) + ' · ' + esc(p.group === 'pa' ? 'Play action' : p.group) + '</i>'
        + '<em>' + esc(p.means) + '</em></span></button>';
    }).join('') + '</div>';
    var extra = (sit.down === 4 ? fourthRow(sit) : '') + tempoRow(sit);
    drawerOpen(head + body + extra + tipFor('call'));
    wireDrawer('off');
  }
  function showDefenseDrawer() {
    var sit = G.situation(game);
    var list = defenseCalls(defTab, sit);
    var scout = S.scoutRead(game, sit.offense);
    var head = '<div class="dr-grip"></div><div class="dr-head">'
      + '<span class="dr-title">Their ' + ordinal(sit.down) + ' &amp; ' + (sit.goalToGo ? 'Goal' : sit.toGo)
      + '<b>' + esc(F.scheme(teams.opp.offense).name) + '</b></span>'
      + (scout.runShare != null ? '<span class="dr-tell">They run ' + Math.round(scout.runShare * 100)
          + '% · ' + scout.confidence + '</span>' : '')
      + '<button class="dr-x" id="drTO" type="button">Timeout</button></div>'
      + '<div class="dr-tabs">' + DEF_TABS.map(function (t) {
          return '<button data-dtab="' + t[0] + '" aria-selected="' + (defTab === t[0]) + '">' + t[1] + '</button>';
        }).join('') + '</div>';
    var body = '<div class="dr-list">' + list.map(function (d) {
      var parts = F.defParts(d);
      return '<button class="dr-play" type="button" data-def="' + esc(d.key) + '">'
        + defDiagram(d.key)
        + '<span class="dr-txt"><b>' + esc(d.name) + '</b>'
        + '<i>' + esc(parts.front.name) + ' · ' + esc(parts.coverage.name)
        + (parts.pressure.key !== 'none' ? ' · ' + esc(parts.pressure.name) : '') + '</i>'
        + '<em>' + esc(d.means) + '</em></span></button>';
    }).join('') + '</div>';
    drawerOpen(head + body + tipFor('defense'));
    wireDrawer('def');
  }
  /* ── THE CLOCK, AS A DECISION ────────────────────────────────────────────
     Three buttons and no submenu. Huddling normally, going without one, or
     letting it bleed to the play clock — each one changes the dead ball
     between snaps, which is the only thing about a football clock a coach
     controls. It is offered where it matters and marked when it matters. */
  var TEMPOS = [['hurry', 'No huddle', 'More snaps, less clock'],
                ['normal', 'Normal', 'Huddle up'],
                ['grind', 'Chew clock', 'Bleed the play clock']];
  function tempoRow(sit) {
    var urge = sit.quarter >= 4 && sit.clock <= 360
      ? (sit.diff < 0 ? 'hurry' : sit.diff > 0 ? 'grind' : null) : null;
    return '<div class="dr-tempo">' + TEMPOS.map(function (t) {
      return '<button type="button" data-tempo="' + t[0] + '"'
        + ' aria-selected="' + (tempo === t[0]) + '"'
        + (urge === t[0] ? ' class="urge"' : '') + '>'
        + '<b>' + esc(t[1]) + '</b><i>' + esc(t[2]) + '</i></button>';
    }).join('') + '</div>';
  }

  function fourthRow(sit) {
    var ou = G.unitsOf(G.teamOf(game, sit.offense), game.tick);
    var k = G.fieldGoal(ou, null, sit.ball, function () { return 0.5; }, false);
    var inRange = k.distance <= k.range + 4;
    return '<div class="dr-row">'
      + '<button class="btn" id="drPunt" type="button">Punt</button>'
      + '<button class="btn" id="drFG" type="button"' + (inRange ? '' : ' disabled') + '>'
      + 'Field goal · ' + k.distance + '</button></div>';
  }
  function wireDrawer(side) {
    Array.prototype.forEach.call(drawer.querySelectorAll('[data-tab]'), function (b) {
      b.onclick = function () { offTab = b.getAttribute('data-tab'); SOUND.tap(); showOffenseDrawer(); };
    });
    Array.prototype.forEach.call(drawer.querySelectorAll('[data-dtab]'), function (b) {
      b.onclick = function () { defTab = b.getAttribute('data-dtab'); SOUND.tap(); showDefenseDrawer(); };
    });
    Array.prototype.forEach.call(drawer.querySelectorAll('[data-play]'), function (b) {
      b.onclick = function () { choosePlay(b.getAttribute('data-play'), b.getAttribute('data-form')); };
    });
    Array.prototype.forEach.call(drawer.querySelectorAll('[data-def]'), function (b) {
      b.onclick = function () { chooseDefense(b.getAttribute('data-def')); };
    });
    Array.prototype.forEach.call(drawer.querySelectorAll('[data-tempo]'), function (b) {
      b.onclick = function () {
        tempo = b.getAttribute('data-tempo'); SOUND.tap();
        if (side === 'off') showOffenseDrawer();
      };
    });
    if ($('drTO')) $('drTO').onclick = function () {
      if (game.timeouts[me] <= 0) { say('No timeouts left.'); return; }
      var r = S.step(game, { type: 'timeout', side: me });
      SOUND.whistle(); paintScore();
      /* WHAT IT BOUGHT, IN SECONDS. A timeout that says nothing back is a
         button; one that says it saved twenty-nine seconds is a decision. */
      say('Timeout, ' + teams.me.abbr + '.' + (r && r.saved ? ' ' + r.saved + ' seconds back.' : ''));
    };
    if ($('drPunt')) $('drPunt').onclick = function () { special({ type: 'punt' }); };
    if ($('drFG')) $('drFG').onclick = function () { special({ type: 'fieldgoal' }); };
  }

  /* ── TIPS ─────────────────────────────────────────────────────────────── */
  var TIPS = {
    call: 'Pick a play. <b>Suggested</b> fits this down and distance — the tabs are your whole book.',
    snap: 'Look at the front before you snap it. A shaded box is a hint about where the run is going.',
    read: 'Tap the receiver you think is open. The longer you hold it, the more the rush matters.',
    run: 'Steer with your left thumb. <b>Juke</b> and <b>Truck</b> are on the right.',
    defense: 'Guess run or pass, then pick the call that punishes it. After the snap you control a defender.'
  };
  function tipFor(k) {
    if (tipsSeen[k] || !TIPS[k]) return '';
    return '<div class="tip" data-tip="' + k + '"><button type="button" aria-label="Dismiss">×</button>' + TIPS[k] + '</div>';
  }
  function seenTip(k) {
    tipsSeen[k] = 1;
    try { localStorage.setItem('ed_gridiron_tips', JSON.stringify(tipsSeen)); } catch (_) {}
  }
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t && t.parentNode && t.parentNode.hasAttribute && t.parentNode.hasAttribute('data-tip')) {
      seenTip(t.parentNode.getAttribute('data-tip'));
      t.parentNode.remove();
    }
  });

  /* ── THE CONTROL PAD ──────────────────────────────────────────────────── */
  function padClear() { pad.innerHTML = ''; pad.classList.remove('on'); }
  function padSnap(label) {
    pad.classList.add('on');
    pad.innerHTML = '<button class="pd-snap" id="pdSnap" type="button">' + esc(label || 'Snap') + '</button>'
      + '<button class="pd-flip" id="pdFlip" type="button" aria-label="Change the call">Change</button>';
    $('pdSnap').onclick = doSnap;
    $('pdFlip').onclick = function () { SOUND.tap(); nextCall(); };
  }
  /* ── THE CONTROLS ────────────────────────────────────────────────────────
     A stick on the left, one big round button on the right and a smaller one
     above it. Two thumbs, no reading. Everything else that could be a button
     — who to throw to — lives out on the field, on the man himself. */
  function sticks(primary, secondary) {
    pad.classList.add('on');
    pad.innerHTML =
      '<div class="pd-stick" id="pdStick"><div class="pd-ring"></div><div class="pd-knob" id="pdKnob"></div></div>'
      + '<div class="pd-acts">'
      + (secondary ? '<button class="pd-act pd-act-b" data-act="' + secondary[0] + '" type="button">'
          + esc(secondary[1]) + '</button>' : '')
      + '<button class="pd-act pd-act-a" data-act="' + primary[0] + '" type="button">'
      + esc(primary[1]) + '</button>'
      + '</div>';
    wireStick(); wireActs();
  }
  function padRun() { sticks(['truck', 'Truck'], ['juke', 'Juke']); }
  function padDefense() { sticks(['dive', 'Tackle'], ['switch', 'Switch']); }
  /* Dropping back you can still run: the stick and the scramble button stay
     live while the throw badges sit over the receivers. */
  function padPass() { sticks(['scramble', 'Scramble'], null); }
  /* whether the ball is in a hand this user is steering */
  function userHasBall() {
    var sit = game ? G.situation(game) : null;
    return !!sit && sit.offense === me;
  }

  /* a tap on the field is a throw, if it lands on a badge */
  function wireFieldTaps() {
    /* A TAP IS ONE TAP. A touch screen fires touchstart and then a synthetic
       mousedown for the same finger, and both were throwing the ball: the
       simulation ignores the second one, but the sound and the buzz fired
       twice and it read as a stutter. */
    var lastTap = 0;
    function at(e) {
      var now = Date.now();
      if (now - lastTap < 400) return;
      var t = e.changedTouches ? e.changedTouches[0] : e;
      var b = canvas.getBoundingClientRect();
      var i = stage.hitTarget(t.clientX - b.left, t.clientY - b.top);
      if (i >= 0) {
        lastTap = now;
        SOUND.tap(); buzz('light');
        stage.throwTo(i);
        padRun();
        if (e.cancelable) e.preventDefault();
      }
    }
    canvas.addEventListener('touchstart', at, { passive: false });
    canvas.addEventListener('mousedown', at);
  }

  function slotName(s) {
    return { X: 'X wide', Z: 'Z wide', SL: 'Slot', SL2: 'Slot', TE: 'Tight end', RB: 'Back', FB: 'Back' }[s] || s;
  }
  function routeName(r) {
    return { hitch: 'Hitch', slant: 'Slant', bubble: 'Bubble', flat: 'Flat', arrow: 'Arrow', stick: 'Stick',
      spot: 'Spot', shallow: 'Shallow', quickout: 'Out', check: 'Check-down', screen: 'Screen', dig: 'Dig',
      curl: 'Curl', out: 'Out', cross: 'Cross', sail: 'Sail', over: 'Over', whip: 'Whip', go: 'Go',
      seam: 'Seam', post: 'Post', corner: 'Corner', deepcross: 'Deep cross', wheel: 'Wheel' }[r] || r;
  }

  /* ── THE STICK ───────────────────────────────────────────────────────────
     THE WINDOW LISTENERS ARE BOUND ONCE, FOR THE LIFE OF THE PAGE. They used
     to be added inside `wireStick`, which the pad calls on every snap — so by
     the fourth quarter a single thumb drag was running sixty identical move
     handlers, every one of them measuring the same drag and steering the same
     man. That is the definition of a control that gets less responsive the
     longer you play, and on a phone it is felt. The pad is rebuilt every
     snap; the listeners look up whatever knob is on the screen now. */
  var stickState = { id: null, cx: 0, cy: 0, r: 44 };
  function stickMove(e) {
    if (stickState.id == null) return;
    var t = e.changedTouches ? stickTouch(e.changedTouches) : e;
    if (!t) return;
    var knob = $('pdKnob');
    var dx = t.clientX - stickState.cx, dy = t.clientY - stickState.cy;
    var m = Math.hypot(dx, dy), r = stickState.r;
    var nx = dx / r, ny = dy / r;
    if (m > r) { nx = dx / m; ny = dy / m; }
    if (knob) knob.style.transform = 'translate(' + (nx * r * 0.55) + 'px,' + (ny * r * 0.55) + 'px)';
    /* screen down is field backwards */
    if (stage) stage.steer(nx, -ny);
    if (e.cancelable) e.preventDefault();
  }
  function stickUp() {
    if (stickState.id == null) return;
    stickState.id = null;
    var knob = $('pdKnob');
    if (knob) knob.style.transform = '';
    if (stage) stage.steer(0, 0);
  }
  function stickTouch(list) {
    var i;
    for (i = 0; i < list.length; i++) if (list[i].identifier === stickState.id) return list[i];
    return null;
  }
  window.addEventListener('touchmove', stickMove, { passive: false });
  window.addEventListener('touchend', stickUp);
  window.addEventListener('touchcancel', stickUp);
  window.addEventListener('mousemove', stickMove);
  window.addEventListener('mouseup', stickUp);

  function wireStick() {
    var el = $('pdStick');
    if (!el) return;
    function down(e) {
      var t = e.changedTouches ? e.changedTouches[0] : e;
      var b = el.getBoundingClientRect();
      stickState.id = e.changedTouches ? t.identifier : 'mouse';
      stickState.cx = b.left + b.width / 2; stickState.cy = b.top + b.height / 2;
      stickState.r = b.width / 2;
      stickMove(e);
      if (e.cancelable) e.preventDefault();
    }
    el.addEventListener('touchstart', down, { passive: false });
    el.addEventListener('mousedown', down);
  }
  function wireActs() {
    Array.prototype.forEach.call(pad.querySelectorAll('[data-act]'), function (b) {
      b.onclick = function () {
        var a = b.getAttribute('data-act');
        if (a === 'switch') { stage.switchDefender(); SOUND.tap(); buzz('light'); return; }
        if (a === 'scramble') { if (stage.action('scramble')) { SOUND.tap(); buzz('light'); padRun(); } return; }
        if (stage.action(a)) { SOUND.hit(); buzz('medium'); }
      };
    });
  }

  /* ── CHOOSING ─────────────────────────────────────────────────────────── */
  function choosePlay(key, formKey) {
    if (busy) return;
    SOUND.tap(); buzz('light');
    drawerClose();
    var sit = G.situation(game);
    var defKey = S.aiDefense(game);
    var ps = S.preSnap(game, key, formKey, defKey);
    pendingCall = { type: 'play', play: key, formation: formKey, def: defKey, tempo: tempo };
    lineUp(key, formKey, defKey, ps, sit);
    padSnap('Snap');
    seenTip('call');
    if (set.mode === 'coach') setTimeout(doSnap, 700);
  }
  function chooseDefense(defKey) {
    if (busy) return;
    SOUND.tap(); buzz('light');
    drawerClose();
    var sit = G.situation(game);
    var call = S.aiOffense(game, defKey);
    call.def = defKey;
    var ps = S.preSnap(game, call.play, call.formation, defKey);
    pendingCall = call;
    lineUp(call.play, call.formation, defKey, ps, sit);
    padSnap('Snap');
    seenTip('defense');
    if (set.mode === 'coach') setTimeout(doSnap, 700);
  }
  function lineUp(playKey, formKey, defKey, ps, sit) {
    var offT = G.teamOf(game, sit.offense), defT = G.teamOf(game, sit.defense);
    stage.setUserSide(sit.offense === me ? 'off' : 'def');
    stage.setMode(set.mode);
    stage.teams(kitFor(sit.offense === me ? 'me' : 'opp'), kitFor(sit.offense === me ? 'opp' : 'me'),
      (sit.offense === me ? teams.me : teams.opp).name, (sit.offense === me ? teams.opp : teams.me).name,
      sit.offense !== me);
    stage.setArt(set.art);
    stage.setSpeed(S.SPEEDS[set.speed] === 99 ? 3.2 : (S.SPEEDS[set.speed] || 1.4) * 0.72);
    /* WHAT THE ENGINE KNOWS, HANDED OVER BEFORE THE SNAP. Ratings, fatigue,
       scheme, halftime adjustments, how long the protection holds, how much
       separation the routes can win — capacities, not outcomes. What happens
       is then decided out on the grass. */
    var env = G.prepare({
      off: offT, def: defT, rand: game.aiRand || game.rand, tick: game.tick,
      playKey: playKey, formKey: formKey, defCall: defKey,
      sit: sit, mem: game.mem[sit.offense], weather: game.weather
    });
    stage.lineUp({
      play: playKey, formation: formKey, def: defKey,
      los: sit.ball, firstDown: Math.min(100, sit.ball + sit.toGo), ballX: ballX,
      strong: ps ? ps.strong : 0, env: env, rand: game.rand,
      offUnits: G.unitsOf(offT, game.tick), defUnits: G.unitsOf(defT, game.tick)
    });
    var look = stage.look();
    readEl.hidden = false;
    /* the rule down its left is the colour of the men who are in it */
    readEl.style.setProperty('--acc', kitFor(sit.offense === me ? 'opp' : 'me').primary || '#3fb883');
    readEl.innerHTML = '<b>' + esc(look.name) + '</b>' + esc(Math.round(ps.box) + ' in the box · ' + look.coverage
      + (look.blitz ? ' · pressure' : ''));
    say('');
  }
  function doSnap() {
    if (busy || stage.phase() !== 'set') return;
    busy = true;
    readEl.hidden = true;
    SOUND.snap(); buzz('light');
    /* the place leans in on the snap and settles again on the whistle */
    crowdUp(0.30, 0.20);
    seenTip('snap');
    var sit = G.situation(game);
    var mine = sit.offense === me;
    padClear();
    stage.snapNow();
    if (set.mode === 'coach' || !mine) {
      if (!mine && set.mode === 'play') padDefense();
      return;
    }
    /* On a pass the badges go up over the receivers and the stick stays live
       so he can climb the pocket or take off. On a run there is nothing to
       steer until the ball is in the back's belly — `onHandoff` does that. */
    if (F.play(pendingCall.play).type === 'pass') {
      padPass();
      stage.showTargets(true);
      rushBar();
      seenTip('read');
    }
  }

  /* the clock on the pocket: not a deadline, a warning */
  function rushBar() {
    var old = pad.querySelector('.pd-clock');
    if (old) old.parentNode.removeChild(old);
    var bar = document.createElement('div');
    bar.className = 'pd-clock';
    bar.innerHTML = '<span id="pdBar"></span>';
    pad.appendChild(bar);
    var t0 = Date.now(), el = $('pdBar');
    var hold = (F.play(pendingCall.play).hold || 2.4) * 1000;
    (function tick() {
      if (!el || !el.parentNode) return;
      var u = Math.min(1, (Date.now() - t0) / hold);
      el.style.width = (100 - u * 100) + '%';
      el.style.background = u > 0.75 ? '#e2664b' : u > 0.45 ? '#d9a441' : '#3fb883';
      if (u < 1) requestAnimationFrame(tick);
    })();
  }

  function special(call) {
    if (busy) return;
    busy = true; drawerClose(); padClear();
    var r = S.step(game, call);
    var sit = G.situation(game);
    if (r.event === 'punt') { SOUND.whistle(); say('Punt — ' + r.punt.gross + ' yards' + (r.punt.touchback ? ', touchback.' : '.')); }
    else if (r.event === 'fieldgoal') {
      /* three points is a scoring moment and gets the same graphic a
         touchdown does, with the distance as the line worth reading */
      var kicking = sit.offense === me ? 'opp' : 'me';   /* possession has flipped */
      if (r.fg.good) {
        SOUND.td(); buzz('strong'); crowdUp(0.8, 0.34);
        banner({ kind: 'good', eyebrow: 'Field goal', head: 'It is good',
          sub: r.fg.distance + ' yards · ' + game.score.home + ' — ' + game.score.away,
          color: kitFor(kicking).primary, hold: 1400 });
      } else {
        SOUND.bad(); buzz('medium'); crowdUp(0.6, 0.24);
        banner({ kind: 'bad', eyebrow: 'Field goal', head: 'No good',
          sub: r.fg.distance + ' yards', hold: 1300 });
      }
    } else if (r.event === 'kickoff') say('Kickoff.');
    paintScore();
    setTimeout(function () { busy = false; nextCall(); }, 850);
  }

  /* ── THE STAGE'S CALLBACKS ────────────────────────────────────────────── */
  /* ── THE WHISTLE ─────────────────────────────────────────────────────────
     The simulation says what happened; the session books it. Same stats,
     same clock, same drive, same season as a play the resolver settled. */
  function commit(outcome) {
    var call = pendingCall || {};
    call.outcome = outcome;
    var r = S.step(game, call);
    lastResult = r && r.play ? r.play : null;
    return lastResult;
  }
  /* COACH MODE IS UNCHANGED. No outcome goes in, so the engine settles the
     snap with the same deterministic resolver it always has; the play you
     watched was the picture, and the resolver is the record. */
  function commitCoach() {
    var call = pendingCall || {};
    if (call.outcome) delete call.outcome;
    var r = S.step(game, call);
    lastResult = r && r.play ? r.play : null;
    return lastResult;
  }

  function onEnd(kind, res) {
    /* the simulation settled it; the engine books it, and only now do down,
       distance, clock and the season move */
    var p = (set.mode === 'play' && res && res.live) ? commit(res) : commitCoach();
    if (p) {
      var myColor = kitFor('me').primary || '#3fb883';
      var theirColor = kitFor('opp').primary || '#e2664b';
      if (p.touchdown) {
        /* WHO SCORED IS NOT WHO HAS THE BALL NOW. Possession has already
           flipped by the time the whistle books it, so ask the engine which
           side the pending score belongs to rather than guessing from the
           situation. */
        var scorer = game.pendingScore ? game.pendingScore.side : me;
        var mineTd = scorer === me;
        SOUND.td(); buzz('strong'); crowdUp(1, 0.62);
        /* the camera pulls out onto the place, the way it does when a stadium
           has just stood up */
        setTimeout(function () { shotWide(true, true); }, 420);
        scoreMoment({
          club: (mineTd ? teams.me : teams.opp),
          color: mineTd ? myColor : theirColor,
          who: p.carrier ? FRname(p.carrier) : p.target ? FRname(p.target)
            : p.interceptor ? FRname(p.interceptor) : '',
          how: p.tdLine || tdLineOf(p),
          mine: mineTd
        });
      } else if (p.turnover) {
        SOUND.bad(); buzz('strong'); crowdUp(0.9, 0.3);
        banner({ kind: 'bad', head: p.turnover === 'fumble' ? 'Fumble' : 'Intercepted',
          sub: p.interceptor ? FRname(p.interceptor) : '', hold: 1500 });
      } else if (p.sack) {
        SOUND.bad(); buzz('medium'); crowdUp(0.75, 0.24);
        banner({ kind: 'bad', head: 'Sack', sub: p.tackler ? FRname(p.tackler) : '', hold: 1150 });
      } else if (p.firstDown) {
        SOUND.first(); buzz('medium'); crowdUp(0.55, 0.22);
        banner({ kind: 'first', head: 'First down', color: myColor, hold: 950 });
      } else {
        SOUND.hit(!!p.big); buzz(p.big ? 'medium' : 'light');
        if (p.big) crowdUp(0.7, 0.22);
      }
      setTimeout(function () { SOUND.whistle(); }, 230);
      if (!p.touchdown) resultCard(p);
      milestone(p);
      ballX = drift(ballX);
    }
    padClear();
    paintScore();
    var wait = set.speed === 'instant' ? 260
      : (p && p.touchdown) ? 2200 : (p && p.turnover) ? 1500 : 900;
    setTimeout(function () { busy = false; nextCall(); }, wait);
  }
  /* THE BALL IS SPOTTED BETWEEN THE HASHES, and it wanders like a real one.
     Drawn from the game's own coaching stream rather than a loose die, so the
     page still decides nothing the engine has not already seen. */
  function drift(x) {
    var h = PT.FIELD.half, hash = 6.17;
    var r = game && game.aiRand ? game.aiRand() : 0.5;
    var t = x + (r - 0.5) * 8;
    return Math.max(h - hash, Math.min(h + hash, t));
  }
  /* ── BROADCAST GRAPHICS ──────────────────────────────────────────────────
     One banner, one shape, one set of rules. A coloured rule in the club's
     own colour, a headline, and — where there is one worth reading — the
     football reason underneath. It arrives, it holds, it goes. */
  function banner(o) {
    var d = document.createElement('div');
    d.className = 'bnr' + (o.kind ? ' bnr-' + o.kind : '');
    if (o.color) d.style.setProperty('--bc', o.color);
    d.innerHTML = (o.eyebrow ? '<i>' + esc(o.eyebrow) + '</i>' : '')
      + '<b>' + esc(o.head) + '</b>'
      + (o.sub ? '<span>' + esc(o.sub) + '</span>' : '');
    fieldWrap.appendChild(d);
    var hold = o.hold || 1150;
    setTimeout(function () { d.classList.add('out'); }, hold);
    setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, hold + 620);
    return d;
  }

  /* ── A TOUCHDOWN ─────────────────────────────────────────────────────────
     Six points is the thing the whole game is for, and a small tag in the
     corner of the screen is not what it feels like. The picture goes to the
     club's colour, the word lands, the man who scored it is named and the
     score changes under it — and then it is gone and you are lining up for
     the try. Under two seconds. A celebration you cannot skip is a cutscene.

     Everything here is presentation: the engine booked the six points before
     any of it was drawn. */
  function tdLineOf(p) {
    if (!p) return '';
    var y = p.yards == null ? null : p.yards;
    if (p.turnover === 'interception') return 'Pick six';
    if (p.completion) return (y != null ? y + '-yard ' : '') + 'catch';
    if (y != null) return y + '-yard run';
    return '';
  }
  function scoreMoment(o) {
    var d = document.createElement('div');
    d.className = 'td-hit' + (o.mine ? '' : ' them');
    d.style.setProperty('--tc', o.color || '#4ede9f');
    d.innerHTML =
      '<div class="td-wash"></div>'
      + '<div class="td-body">'
      + '<div class="td-word">TOUCHDOWN</div>'
      + '<div class="td-club">' + esc((o.club && (o.club.name || o.club.city)) || '') + '</div>'
      + (o.who ? '<div class="td-who">' + esc(o.who) + (o.how ? ' <i>' + esc(o.how) + '</i>' : '') + '</div>' : '')
      + '<div class="td-score"><span>' + esc(teams.me.abbr || '') + ' ' + game.score[me] + '</span>'
      + '<b>&middot;</b><span>' + esc(teams.opp.abbr || '') + ' ' + game.score[G.other(me)] + '</span></div>'
      + '</div>';
    fieldWrap.appendChild(d);
    setTimeout(function () { d.classList.add('out'); }, 1750);
    setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 2400);
  }

  /* ── THE MAN WHO IS DECIDING IT ──────────────────────────────────────────
     One line, once, when somebody crosses the number a broadcast would put on
     the screen. Not a popup and not a feed — the same say() strip the rest of
     the game talks through, and each man says his piece at most once, so a
     hundred-yard back is a moment rather than a ticker.

     This is the whole of "make the player remember a name": he has already
     seen it on the result card of every carry, and now the game tells him
     what it adds up to, while it is still happening. */
  var milestoned = {};
  var MARKS = [
    ['ry', 100, function (p) { return p.name + ' is over a hundred on the ground.'; }],
    ['recy', 100, function (p) { return p.name + ' has a hundred yards receiving.'; }],
    ['py', 300, function (p) { return p.name + ' is over three hundred through the air.'; }],
    ['sack', 2, function (p) { return p.name + ' has ' + p.sack + ' sacks. He is wrecking this.'; }],
    ['int', 2, function (p) { return p.name + ' has picked off two.'; }],
    ['tkl', 10, function (p) { return p.name + ' is everywhere — ' + p.tkl + ' tackles.'; }]
  ];
  function milestone(p) {
    if (!game) return;
    var who = p.carrier || p.target || p.tackler || p.interceptor;
    var line = null;
    [who, p.tackler, p.interceptor].forEach(function (man) {
      if (line || !man) return;
      var st = game.players[man.uid || man.id];
      if (!st) return;
      MARKS.forEach(function (m) {
        if (line) return;
        var key = st.id + ':' + m[0];
        if (milestoned[key] || (st[m[0]] || 0) < m[1]) return;
        milestoned[key] = 1;
        line = (st.side === me ? '' : (teams.opp.abbr || 'They') + ' — ') + m[2](st);
      });
    });
    /* two touchdowns from one man is the other line worth saying */
    if (!line && who) {
      var w = game.players[who.uid || who.id];
      var tds = w ? (w.rtd + w.rectd) : 0;
      if (w && tds >= 2 && !milestoned[w.id + ':td' + tds]) {
        milestoned[w.id + ':td' + tds] = 1;
        line = (w.side === me ? '' : (teams.opp.abbr || 'They') + ' — ') + w.name + ' has ' + tds + ' touchdowns.';
      }
    }
    if (line) say(line);
  }

  /* THE RESULT, in the shape a broadcast uses: who, what, and why. */
  function resultCard(p) {
    if (!p) return;
    var who = p.carrier ? FRname(p.carrier) : p.target ? FRname(p.target)
            : p.interceptor ? FRname(p.interceptor) : '';
    var line;
    if (p.sack) line = 'Sacked for ' + p.yards;
    else if (p.turnover === 'interception') line = 'Intercepted';
    else if (p.turnover === 'fumble') line = 'Fumble';
    else if (p.incomplete) line = 'Incomplete';
    else if (p.completion) line = p.yards + '-yard catch';
    else line = p.yards + '-yard rush';
    /* ── THE REASON, AND THE MOST SPECIFIC ONE AVAILABLE ──────────────────
       "They had eight in the box" is true of the whole defence; "Wexler held
       the point" is true of the block the run went behind, and it is the one
       a player can do something with next time. Play Mode knows it because
       twenty-two men actually blocked each other, so when it is there it
       wins. */
    var why = '';
    var block = null;
    (p.notes || []).forEach(function (n) {
      if (/held the point|beat the block|came free|beat /.test(n)) block = n;
    });
    if (block) why = block;
    else {
      var c = String(p.commentary || '');
      var cut = c.indexOf(' — ');
      if (cut > 0) why = c.slice(cut + 3);
      else if (p.notes && p.notes.length) why = p.notes[p.notes.length - 1];
    }
    var d = document.createElement('div');
    d.className = 'res' + (p.big ? ' res-big' : '');
    d.innerHTML = (who ? '<b>' + esc(who) + '</b>' : '')
      + '<span>' + esc(line) + '</span>'
      + (why ? '<i>' + esc(why.replace(/^[a-z]/, function (m) { return m.toUpperCase(); })) + '</i>' : '')
      + (p.big ? '<em>Explosive play</em>' : '');
    fieldWrap.appendChild(d);
    setTimeout(function () { d.classList.add('out'); }, 1700);
    setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 2300);
  }

  /* THE CROWD, SEEN AND HEARD, FROM ONE NUMBER. Anything that lifts the
     stands lifts the noise with them; nothing sets one without the other. */
  function crowdUp(level, floor) {
    if (stage) stage.crowd(level, floor);
    SOUND.ambience(Math.max(level || 0, floor == null ? 0.18 : floor));
  }

  /* THE ESTABLISHING SHOT. One switch: the lens drops out of the sky and
     back until the horizon — and eighty thousand people standing on it — come
     into frame. Used where a broadcast would use it and nowhere else: the
     kickoff, a touchdown, the half, the final whistle. */
  function shotWide(on, glide) {
    if (!stage || !stage.setShot) return;
    stage.setShot(on ? 'wide' : 'play', glide ? false : true);
    if (on) crowdUp(0.5, 0.34); else crowdUp(0, 0.12);
  }

  /* ── THE KICKOFF SEQUENCE ────────────────────────────────────────────────
     What happens between pressing the button and the first snap of a drive.
     A broadcast does not cut from a menu to a static field: it holds on the
     building, puts the two clubs on the screen, comes down onto the grass,
     and only then kicks the football.

     Under six seconds, and one tap anywhere ends it. Nothing in here decides
     a yard — the engine settles the kickoff the moment the scene finishes,
     exactly as it did when the button did it directly. */
  var kickSkip = null;
  function runKickoff(sit, done) {
    if (!stage || !stage.kickoff) { done(); return; }
    busy = true;
    var recv = sit.offense === me ? teams.me : teams.opp;
    var kick = sit.offense === me ? teams.opp : teams.me;
    var recvKit = kitFor(sit.offense === me ? 'me' : 'opp');
    var kickKit = kitFor(sit.offense === me ? 'opp' : 'me');
    var c = cond();
    /* the kicking team is the offence on the field for this scene */
    stage.teams(themeOf(kick.theme), themeOf(recv.theme),
      kick.name || '', recv.name || '', sit.offense === me);
    var card = document.createElement('div');
    card.className = 'kick-in';
    card.innerHTML =
      '<div class="ki-top">' + esc(c.venue) + ' &middot; ' + esc(c.kick) + ' &middot; '
        + esc(c.sky) + ' ' + esc(c.temp) + '&deg;</div>'
      + '<div class="ki-grid">'
      + '<div class="ki-side"><span class="ki-badge" style="--tc:' + esc(kickKit.primary || '#3fb883') + '">'
        + esc((kick.abbr || '').slice(0, 3)) + '</span>'
        + '<b>' + esc(kick.name || '') + '</b><i>Kicking off</i></div>'
      + '<div class="ki-v">AT</div>'
      + '<div class="ki-side"><span class="ki-badge" style="--tc:' + esc(recvKit.primary || '#3fb883') + '">'
        + esc((recv.abbr || '').slice(0, 3)) + '</span>'
        + '<b>' + esc(recv.name || '') + '</b><i>Receiving</i></div>'
      + '</div>'
      + '<div class="ki-skip">Tap to skip</div>';
    fieldWrap.appendChild(card);
    crowdUp(0.55, 0.34);
    var over = false, timers = [];
    function clearAll() { timers.forEach(clearTimeout); timers = []; }
    function finish() {
      if (over) return;
      over = true; kickSkip = null; clearAll();
      if (card.parentNode) card.parentNode.removeChild(card);
      if (stage.skipKickoff) stage.skipKickoff();
      shotWide(false);
      busy = false;
      done();
    }
    kickSkip = finish;
    /* 1 · the building, and the two clubs on it */
    timers.push(setTimeout(function () {
      if (over) return;
      card.classList.add('out');
      /* 2 · down onto the grass, and the teams take the field */
      say('The kick is coming.');
      crowdUp(0.75, 0.40);
      stage.kickoff({ from: 35, to: 8, returner: featuredName(recv),
        dur: 3.2, onDone: function () { if (!over) { say(''); finish(); } } });
      SOUND.crowd();
    }, 1500));
    timers.push(setTimeout(function () { if (!over) { SOUND.snap(); buzz('medium'); } }, 2450));
    timers.push(setTimeout(finish, 6200));
  }
  function featuredName(team) {
    var f = featured(team);
    return f ? FRname(f) : '';
  }

  /* ── WHOSE CALL IS IT ─────────────────────────────────────────────────── */
  /* THE QUARTERS ARE A THING THAT HAPPENS. The clock rolling over from 0:00
     in one quarter to 5:00 in the next with nothing said is the single most
     "this is a prototype" beat in a football game. */
  var shownQuarter = 1;
  function quarterBreak(sit) {
    if (!sit || sit.quarter === shownQuarter) return;
    var was = shownQuarter;
    shownQuarter = sit.quarter;
    if (sit.phase === 'halftime' || was < 1) return;
    var name = was === 1 ? 'End of the first quarter'
      : was === 2 ? 'End of the first half'
      : was === 3 ? 'End of the third quarter'
      : was >= 4 ? 'End of regulation' : '';
    if (!name) return;
    SOUND.whistle();
    banner({ kind: 'good', eyebrow: 'Q' + was, head: name,
      sub: teams.me.abbr + ' ' + game.score[me] + '  \u00b7  ' + teams.opp.abbr + ' ' + game.score[G.other(me)],
      color: kitFor('me').primary, hold: 1400 });
  }
  function nextCall() {
    if (game.over) { finalScreen(); return; }
    var sit = G.situation(game);
    paintScore();
    quarterBreak(sit);
    if (sit.phase === 'halftime') { halftimeScreen(); return; }
    if (sit.phase === 'kickoff') {
      padClear(); drawer.classList.remove('open');
      /* THE SHOT BEFORE THE FOOTBALL. A broadcast does not open on a patch of
         grass: it opens on the building, full, lit, waiting. */
      readEl.hidden = true;
      shotWide(true);
      var recv = sit.offense === me ? teams.me : teams.opp;
      var kicking = sit.offense === me ? teams.opp : teams.me;
      drawerOpen('<div class="dr-grip"></div>'
        + '<div class="dr-head"><span class="dr-title">Kickoff'
        + '<b>' + esc(kicking.abbr || '') + ' kicks &middot; ' + esc(recv.abbr || '') + ' receive</b></span></div>'
        + '<div class="dr-row one">'
        + '<button class="btn btn-go" id="drKick" type="button">Kick off</button></div>');
      $('drKick').onclick = function () {
        drawerClose();
        runKickoff(sit, function () { special({ type: 'kickoff' }); });
      };
      return;
    }
    if (sit.phase === 'pat') {
      /* the engine clears the pending score the moment the try is taken, and
         a redraw can land on the far side of that; treat a missing one as
         theirs and offer the button that just moves the game on */
      var mine = !!game.pendingScore && game.pendingScore.side === me;
      shotWide(false);
      drawerOpen('<div class="dr-grip"></div>'
        + '<div class="dr-head"><span class="dr-title">' + (mine ? 'Your touchdown' : 'Their touchdown') + '</span></div>'
        + (mine ? '<div class="dr-row"><button class="btn btn-go" id="drXP" type="button">Extra point</button>'
            + '<button class="btn" id="drTwo" type="button">Go for two</button></div>'
          : '<div class="dr-row one"><button class="btn btn-go" id="drXP" type="button">Continue</button></div>'));
      $('drXP').onclick = function () {
        drawerClose();
        special(mine ? { type: 'pat' } : patForThem());
      };
      if ($('drTwo')) $('drTwo').onclick = function () {
        drawerClose();
        special({ type: 'two', play: 'power', formation: 'goalline', def: S.aiDefense(game) });
      };
      return;
    }
    if (sit.phase !== 'play') return;
    shotWide(false);
    if (sit.offense === me) showOffenseDrawer(); else showDefenseDrawer();
    /* keep somebody on the field between calls */
    var guess = offensePlays('suggested', sit)[0] || F.play('inside_zone');
    var gf = F.playForms(guess.key, sit.offense === me ? teams.me.offense : teams.opp.offense)[0] || guess.forms[0];
    stage.setArt(false);
    stage.setUserSide(sit.offense === me ? 'off' : 'def');
    stage.teams(kitFor(sit.offense === me ? 'me' : 'opp'), kitFor(sit.offense === me ? 'opp' : 'me'),
      (sit.offense === me ? teams.me : teams.opp).name, (sit.offense === me ? teams.opp : teams.me).name,
      sit.offense !== me);
    stage.lineUp({ play: guess.key, formation: gf, def: 'base_3', los: sit.ball,
      firstDown: Math.min(100, sit.ball + sit.toGo), ballX: ballX, strong: 0,
      env: G.prepare({ off: G.teamOf(game, sit.offense), def: G.teamOf(game, sit.defense),
        rand: game.aiRand || game.rand, tick: game.tick, playKey: guess.key, formKey: gf,
        defCall: 'base_3', sit: sit, mem: game.mem[sit.offense], weather: game.weather }),
      rand: game.rand,
      offUnits: G.unitsOf(G.teamOf(game, sit.offense), game.tick),
      defUnits: G.unitsOf(G.teamOf(game, sit.defense), game.tick) });
    readEl.hidden = true;
  }
  function patForThem() {
    if (!game.pendingScore) return { type: 'pat' };
    var d = game.score[game.pendingScore.side] - game.score[G.other(game.pendingScore.side)];
    var late = game.quarter >= game.cfg.quarters;
    return (late && (d === -2 || d === -5 || d === 1 || d === -10))
      ? { type: 'two', play: 'power', formation: 'goalline', def: 'goal_line_d' } : { type: 'pat' };
  }

  /* ── THE PANELS ──────────────────────────────────────────────────────────
     Halftime and the final whistle are the two moments a broadcast stops
     showing football and shows a graphic instead — so they get the graphic a
     broadcast would use, not a form: the two clubs across the top under their
     own colours, and the numbers as bars you can read at arm's length rather
     than as a column of digits you have to compare by eye. */
  function scoreHead(label) {
    var them = G.other(me);
    function side(t, sc, key, right) {
      var col = kitFor(key === me ? 'me' : 'opp').primary || '#3fb883';
      var win = sc > game.score[key === me ? them : me];
      return '<div class="ph-side' + (right ? ' right' : '') + '">'
        + '<span class="ph-bar" style="background:' + esc(col) + '"></span>'
        + '<span class="ph-t"><b>' + esc(t.abbr || '') + '</b><i>' + esc(t.name || '') + '</i></span>'
        + '<span class="ph-p' + (win ? ' win' : '') + '">' + sc + '</span></div>';
    }
    return '<div class="ph">' + side(teams.me, game.score[me], me, false)
      + '<span class="ph-mid">' + esc(label) + '</span>'
      + side(teams.opp, game.score[them], them, true) + '</div>';
  }
  /* one line of the comparison: a label, both numbers, and a rule split
     between them in the two clubs' colours */
  function compare(rows) {
    var mc = kitFor('me').primary || '#3fb883', tc = kitFor('opp').primary || '#e2664b';
    return '<div class="cmp">' + rows.map(function (r) {
      /* a team can finish a half with negative yards — six sacks will do it —
         and a bar cannot be a negative length, so the split is taken on what
         each side actually gained */
      var a = Math.max(0, Number(r[1]) || 0), b = Math.max(0, Number(r[2]) || 0), tot = a + b;
      var pct = tot > 0 ? Math.round(a / tot * 100) : 50;
      pct = pct < 0 ? 0 : pct > 100 ? 100 : pct;
      /* nothing to nothing is not a lead for either of them: half a green bar
         and half a red one would say it was */
      var rule = tot === 0
        ? '<span class="cb tie"></span>'
        : '<span class="cb"><i style="width:' + pct + '%;background:' + esc(mc) + '"></i>'
          + '<i style="width:' + (100 - pct) + '%;background:' + esc(tc) + '"></i></span>';
      return '<div class="cmp-r"><span class="cl">' + esc(r[3] == null ? r[1] : r[3]) + '</span>'
        + '<span class="ck">' + esc(r[0]) + '</span>'
        + '<span class="cr">' + esc(r[4] == null ? r[2] : r[4]) + '</span>'
        + rule + '</div>';
    }).join('') + '</div>';
  }

  /* ── HALFTIME ─────────────────────────────────────────────────────────── */
  function halftimeScreen() {
    shotWide(true);
    var box = G.boxScore(game), mine = box[me], theirs = box[G.other(me)];
    var rows = [['Total yards', mine.yards, theirs.yards], ['Yards per play', mine.ypp, theirs.ypp],
      ['Rushing', mine.rushYards + ' (' + mine.ypc + ')', theirs.rushYards + ' (' + theirs.ypc + ')'],
      ['Passing', mine.comp + '/' + mine.att + ' · ' + mine.passYards, theirs.comp + '/' + theirs.att + ' · ' + theirs.passYards],
      ['Third down', mine.third, theirs.third], ['Explosive plays', mine.explosive, theirs.explosive],
      ['Sacks', mine.sacks, theirs.sacks], ['Turnovers', mine.turnovers, theirs.turnovers]];
    overlay('<div class="eyebrow">Halftime</div>' + scoreHead('HT')
      + compare([['Total yards', mine.yards, theirs.yards],
        ['Rushing', mine.rushYards, theirs.rushYards,
          mine.rushYards + ' (' + mine.ypc + ')', theirs.rushYards + ' (' + theirs.ypc + ')'],
        ['Passing', mine.passYards, theirs.passYards,
          mine.comp + '/' + mine.att + ' · ' + mine.passYards,
          theirs.comp + '/' + theirs.att + ' · ' + theirs.passYards],
        ['Explosive plays', mine.explosive, theirs.explosive],
        ['Sacks', mine.sacks, theirs.sacks],
        ['Turnovers', mine.turnovers, theirs.turnovers]])
      + '<div class="cmp-note">Yards per play ' + esc(mine.ypp) + ' — ' + esc(theirs.ypp)
      + ' · Third down ' + esc(mine.third) + ' — ' + esc(theirs.third) + '</div>'
      + takeaway()
      + leaderStrip(box)
      + '<h3>One adjustment</h3>'
      + '<div class="adjs">' + G.ADJUSTMENTS.map(function (a) {
          return '<button class="adj" type="button" data-adj="' + esc(a.key) + '">'
            + '<span class="ct">' + (a.side === 'off' ? 'Offence' : 'Defence') + '</span>'
            + '<b>' + esc(a.name) + '</b><em>' + esc(a.means) + '</em>'
            /* THE TRADE, ON THE BUTTON. An adjustment with only an upside on
               it is not a decision — it is a free upgrade, and the player
               learns nothing from taking one. */
            + '<span class="adj-t"><i class="up">' + esc(a.gain || '') + '</i>'
            + '<i class="dn">' + esc(a.cost || '') + '</i></span>'
            + '</button>';
        }).join('') + '</div>');
    Array.prototype.forEach.call(ovHost.querySelectorAll('[data-adj]'), function (b) {
      b.onclick = function () {
        var key = b.getAttribute('data-adj');
        closeOverlay();
        S.step(game, { type: 'halftime_done', adjust: key,
          oppAdjust: G.ADJUSTMENTS[(game.aiRand() * G.ADJUSTMENTS.length) | 0].key });
        say('Second half. ' + G.adjustment(key).name + '.');
        nextCall();
      };
    });
  }

  /* ONE THING THAT IS DECIDING IT. A wall of numbers tells you what has
     happened; a broadcast tells you the one that matters, and at half time
     that is the sentence you actually act on. Taken from the same reasons the
     postgame panel prints, worst-first if you are behind and best-first if
     you are not. */
  function takeaway() {
    var them = G.other(me), box = G.boxScore(game);
    var ahead = game.score[me] > game.score[them];
    var all = S.why(box, me);
    if (!all.length) return '';
    /* the one that runs against the way it is going: what is keeping you in
       it when you are behind, what could still cost you when you are not */
    var pick = all.filter(function (r) { return r.good !== ahead; })[0] || all[0];
    var head = pick.good
      ? (ahead ? 'What is working' : 'What is keeping you in it')
      : (ahead ? 'What could still cost you' : 'The problem');
    return '<div class="tkw"><span>' + esc(head) + '</span>' + esc(pick.text) + '</div>';
  }

  /* ── THE MEN, NAMED ───────────────────────────────────────────────────────
     A box score is a wall of numbers about nobody. Four lines — who is
     throwing it, who is carrying it, who is catching it and who is wrecking
     it, on both sides — is how a viewer starts remembering a fictional
     quarterback's name. Every figure comes off the same player stats the
     engine books, so nothing here is a second tally. */
  function pLine(p) {
    if (!p) return null;
    if (p.pa) return p.pc + '/' + p.pa + ', ' + p.py + ' yds'
      + (p.ptd ? ', ' + p.ptd + ' TD' : '') + (p.pint ? ', ' + p.pint + ' INT' : '');
    if (p.car && p.car >= p.rec) return p.car + ' car, ' + p.ry + ' yds' + (p.rtd ? ', ' + p.rtd + ' TD' : '');
    if (p.rec) return p.rec + ' rec, ' + p.recy + ' yds' + (p.rectd ? ', ' + p.rectd + ' TD' : '');
    var d = [];
    if (p.tkl) d.push(p.tkl + ' tkl');
    if (p.sack) d.push(p.sack + ' sack' + (p.sack === 1 ? '' : 's'));
    if (p.tfl) d.push(p.tfl + ' TFL');
    if (p.int) d.push(p.int + ' INT');
    if (p.pd) d.push(p.pd + ' PD');
    return d.join(', ') || null;
  }
  function leaderStrip(box) {
    var them = G.other(me);
    var mine = box.leaders[me] || {}, theirs = box.leaders[them] || {};
    var rows = [['Passing', mine.passer, theirs.passer], ['Rushing', mine.rusher, theirs.rusher],
                ['Receiving', mine.receiver, theirs.receiver], ['Defence', mine.defender, theirs.defender]];
    var out = rows.map(function (r) {
      var a = pLine(r[1]), b = pLine(r[2]);
      if (!a && !b) return '';
      return '<div class="ldr-r"><span class="lk">' + esc(r[0]) + '</span>'
        + '<span class="la">' + (r[1] ? '<b>' + esc(r[1].position + ' ' + r[1].name) + '</b><i>'
            + esc(a || '') + '</i>' : '<i>—</i>') + '</span>'
        + '<span class="lb">' + (r[2] ? '<b>' + esc(r[2].position + ' ' + r[2].name) + '</b><i>'
            + esc(b || '') + '</i>' : '<i>—</i>') + '</span></div>';
    }).join('');
    if (!out) return '';
    return '<h3>Who is doing it</h3><div class="ldr">'
      + '<div class="ldr-h"><span class="lk"></span><span class="la">' + esc(teams.me.abbr)
      + '</span><span class="lb">' + esc(teams.opp.abbr) + '</span></div>' + out + '</div>';
  }

  /* ── THE RECAP ────────────────────────────────────────────────────────── */
  function finalScreen() {
    S.clearSave();
    /* the last thing the game shows is the place it was played in */
    shotWide(true);
    crowdUp(0.55, 0.45);
    /* the loop is about to stop, so re-frame once by hand or the last frame
       on the screen is the one from the play that ended the game */
    if (stage) { stage.stop(); if (stage.resize) stage.resize(); }
    var box = G.boxScore(game), them = G.other(me), mine = box[me], theirs = box[them];
    var won = game.score[me] > game.score[them];
    var tp = S.turningPoint(game), potg = G.playerOfGame(game);
    var topOff = G.topOffense(game, me), topDef = G.topDefense(game, me);
    /* filed once, on this device, and never twice for the same game */
    var rec = S.fileResult(game, me);
    var matchup = S.keyMatchup(game, me), coaching = S.coachingImpact(game, me);
    /* THE LIST HAS TO AGREE WITH ITS OWN HEADING. Five bullets under "Why you
       won" that are all things that nearly lost it reads as a bug, so the
       ones that explain the result and the ones that ran against it are shown
       under separate heads. */
    var allWhy = S.why(box, me), level = game.score[me] === game.score[them];
    var forIt = allWhy.filter(function (r) { return r.good === won && !level; }).slice(0, 4);
    var againstIt = allWhy.filter(function (r) { return forIt.indexOf(r) < 0; }).slice(0, 4);
    var rows = [['First downs', mine.firstDowns, theirs.firstDowns], ['Total yards', mine.yards, theirs.yards],
      ['Rushing', mine.rushYards + ' (' + mine.ypc + ')', theirs.rushYards + ' (' + theirs.ypc + ')'],
      ['Passing', mine.comp + '/' + mine.att + ' · ' + mine.passYards, theirs.comp + '/' + theirs.att + ' · ' + theirs.passYards],
      ['Sacks', mine.sacks + ' (' + mine.sacksAllowed + ' allowed)',
       theirs.sacks + ' (' + theirs.sacksAllowed + ' allowed)'],
      ['Third down', mine.third, theirs.third],
      ['Fourth down', mine.fourth, theirs.fourth], ['Red zone', mine.redzone, theirs.redzone],
      ['Explosive plays', mine.explosive, theirs.explosive], ['Turnovers', mine.turnovers, theirs.turnovers],
      ['Field goals', mine.fg, theirs.fg], ['Possession', mins(mine.top), mins(theirs.top)]];
    function list(head, items, good) {
      if (!items.length) return '';
      return '<h3>' + esc(head) + '</h3><ul class="why' + (good ? '' : ' bad') + '">'
        + items.map(function (r) { return '<li>' + esc(r.text) + '</li>'; }).join('') + '</ul>';
    }
    var injuries = (game[me === 'home' ? 'home' : 'away'].injuries || []).filter(function (i) { return i.weeks > 0; });
    /* ── THE RESULT, BEFORE THE NUMBERS ──────────────────────────────────
       A win should feel like one for a second before it turns into a table.
       A loss gets the same shape and none of the noise: same graphic, muted
       colour, no celebration — a result you can read and close. */
    var recLine = rec && rec.games
      ? rec.w + '\u2013' + rec.l + (rec.t ? '\u2013' + rec.t : '')
      : '';
    var hero = '<div class="fin-hero' + (won ? ' win' : level ? ' level' : ' loss') + '"'
      + ' style="--tc:' + esc(kitFor('me').primary || '#3fb883') + '">'
      + (won ? '<span class="fin-glow"></span>' : '')
      + '<div class="fin-tag">Final' + (game.ot ? ' \u00b7 OT' : '') + '</div>'
      + '<div class="fin-word">' + (won ? 'WIN' : level ? 'TIE' : 'LOSS') + '</div>'
      + '<div class="fin-line">' + esc(title(teams.me)) + ' ' + game.score[me]
      + ' \u00b7 ' + esc(title(teams.opp)) + ' ' + game.score[them] + '</div>'
      + (recLine ? '<div class="fin-rec">Record <b>' + esc(recLine) + '</b>'
          + (game.ot ? ' \u00b7 after overtime' : '') + '</div>' : '')
      + '</div>';
    if (won) { SOUND.td(); buzz('strong'); crowdUp(1, 0.5); }
    overlay(hero + scoreHead(game.ot ? 'OT' : 'FT')
      + compare([['Total yards', mine.yards, theirs.yards],
        ['Rushing', mine.rushYards, theirs.rushYards,
          mine.rushYards + ' (' + mine.ypc + ')', theirs.rushYards + ' (' + theirs.ypc + ')'],
        ['Passing', mine.passYards, theirs.passYards,
          mine.comp + '/' + mine.att + ' · ' + mine.passYards,
          theirs.comp + '/' + theirs.att + ' · ' + theirs.passYards],
        ['First downs', mine.firstDowns, theirs.firstDowns],
        ['Explosive plays', mine.explosive, theirs.explosive],
        ['Turnovers', mine.turnovers, theirs.turnovers]])
      + list(won ? 'Why you won' : level ? 'How it finished level' : 'Why you lost', forIt, true)
      + list(level ? 'The other side of it' : won ? 'What nearly cost you' : 'What kept you in it',
          againstIt, false)
      + (tp ? '<h3>Turning point</h3><div class="muted">Q' + tp.q + ' — ' + esc(tp.text) + '</div>' : '')
      + (potg ? '<h3>Player of the game</h3><div class="potg"><div><div class="pn">'
          + esc(potg.position + ' ' + potg.name)
          + '<span class="pt">' + esc(potg.side === me ? teams.me.abbr : teams.opp.abbr) + '</span></div>'
          + '<div class="pl">' + esc(statLine(potg)) + '</div></div></div>' : '')
      /* THE TWO MEN WHO PLAYED THIS GAME FOR YOU, one on each side of the
         ball. A single player of the game is often the opponent's; these two
         are always yours, which is what makes a roster start to have names
         in it. */
      + ((topOff || topDef) ? '<h3>Your game</h3><div class="mine2">'
          + (topOff ? '<div><span>Offence</span><b>' + esc(topOff.position + ' ' + topOff.name)
              + '</b><i>' + esc(pLine(topOff) || '') + '</i></div>' : '')
          + (topDef ? '<div><span>Defence</span><b>' + esc(topDef.position + ' ' + topDef.name)
              + '</b><i>' + esc(pLine(topDef) || '') + '</i></div>' : '')
          + '</div>' : '')
      + (matchup ? '<h3>Key matchup</h3><div class="muted">' + esc(matchup) + '</div>' : '')
      + (coaching ? '<h3>Coaching impact</h3><div class="muted">' + esc(coaching) + '</div>' : '')
      + leaderStrip(box)
      + '<h3>Box score</h3><table class="box"><thead><tr><th>&nbsp;</th><th>' + esc(teams.me.abbr) + '</th><th>'
      + esc(teams.opp.abbr) + '</th></tr></thead><tbody>' + rows.map(function (r) {
        return '<tr><th>' + esc(r[0]) + '</th><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td></tr>';
      }).join('') + '</tbody></table>'
      + (game.weather && game.weather.note
          ? '<h3>Conditions</h3><div class="muted">' + esc(game.weather.note) + '</div>' : '')
      + (rec && rec.games ? '<h3>Your record</h3><div class="muted">' + esc(S.recordLine(rec))
          + '</div>' : '')
      + (injuries.length ? '<h3>Injuries</h3><div class="muted">' + injuries.map(function (i) {
          return esc(i.position + ' ' + i.name + ' — ' + i.kind); }).join('<br>') + '</div>' : '')
      + '<h3>Drives</h3><div class="drv">' + game.drives.map(function (d) {
          var who = d.side === me ? teams.me.abbr : teams.opp.abbr;
          var cls = d.outcome === 'td' || d.outcome === 'fg' ? 'sc'
            : (d.outcome === 'interception' || d.outcome === 'fumble') ? 'to' : '';
          return '<div class="' + cls + '">' + esc(who) + ' · ' + d.plays + ' plays, ' + d.yards + ' yards · '
            + esc(driveWord(d.outcome)) + '</div>';
        }).join('') + '</div>'
      + '<div class="btn-row"><button class="btn btn-go" id="btnAgain" type="button">Play again</button>'
      + '<a class="btn btn-ghost" href="/games/gameday/">Back to Game Day</a></div>', true);
    $('btnAgain').onclick = function () { closeOverlay(); newGame(); };
    if (GM && GM.track) GM.track('gridiron_game_finished', { won: won, score_for: game.score[me],
      score_against: game.score[them], difficulty: set.difficulty, mode: set.mode, plays: game.plays.length });
  }
  function driveWord(o) {
    return { td: 'touchdown', fg: 'field goal', fg_miss: 'missed field goal', punt: 'punt',
      interception: 'interception', fumble: 'fumble', downs: 'turned it over on downs', safety: 'safety' }[o] || o;
  }
  function mins(s) { var m = Math.floor(s / 60); return m + ':' + (s % 60 < 10 ? '0' : '') + Math.round(s % 60); }
  function statLine(p) {
    var out = [];
    if (p.pa) out.push(p.pc + '/' + p.pa + ', ' + p.py + ' yds, ' + p.ptd + ' TD' + (p.pint ? ', ' + p.pint + ' INT' : ''));
    if (p.car) out.push(p.car + ' car, ' + p.ry + ' yds' + (p.rtd ? ', ' + p.rtd + ' TD' : ''));
    if (p.rec) out.push(p.rec + ' rec, ' + p.recy + ' yds' + (p.rectd ? ', ' + p.rectd + ' TD' : ''));
    if (p.tkl) out.push(p.tkl + ' tackles' + (p.sack ? ', ' + p.sack + ' sack' : '') + (p.int ? ', ' + p.int + ' INT' : ''));
    if (p.fg) out.push(p.fg + '/' + p.fga + ' FG');
    return out.join(' · ');
  }
  function title(t) { return ((t.city || '') + ' ' + (t.name || '')).trim(); }

  /* ── OVERLAYS ─────────────────────────────────────────────────────────── */
  function overlay(html, noClose) {
    ovHost.innerHTML = '<div class="ov" id="ov"><div class="ov-in" role="dialog" aria-modal="true">' + html + '</div></div>';
    if (!noClose) $('ov').onclick = function (e) { if (e.target.id === 'ov') closeOverlay(); };
  }
  function closeOverlay() { ovHost.innerHTML = ''; }

  function settingsOverlay() {
    function seg(name, opts, val) {
      return '<div class="seg">' + opts.map(function (o) {
        return '<button type="button" data-set="' + name + '" data-val="' + o[0] + '" aria-pressed="'
          + (String(val) === String(o[0])) + '">' + esc(o[1]) + '</button>';
      }).join('') + '</div>';
    }
    function row(label, sub, control) {
      return '<div class="setrow"><span class="sl"><b>' + esc(label) + '</b><span>' + esc(sub) + '</span></span>' + control + '</div>';
    }
    overlay('<div class="eyebrow">Settings</div><h2>How you want to play</h2>'
      + row('Control', 'Play puts the game in your hands; Coach calls it and lets the players execute',
          seg('mode', [['play', 'Play'], ['coach', 'Coach']], set.mode))
      + row('Game speed', 'How fast the play runs', seg('speed', [['normal', 'Normal'], ['fast', 'Fast'], ['instant', 'Instant']], set.speed))
      + row('Difficulty', 'What the opposing coach sees, not what his players are worth',
          seg('difficulty', AI.TIER_ORDER.map(function (k) { return [k, AI.TIERS[k].name]; }), set.difficulty))
      + row('Quarter length', 'The clock is real; this is how much of it there is',
          seg('length', [['standard', '15:00'], ['quick', '8:00'], ['blitz', '5:00']], set.length))
      + row('Play art', 'Routes, run paths and blitz arrows before the snap', seg('art', [[true, 'On'], [false, 'Off']], set.art))
      + row('Sound', 'Short cues, no music', seg('sound', [[true, 'On'], [false, 'Off']], set.sound))
      + row('Haptics', 'Where the device supports it', seg('haptics', [[true, 'On'], [false, 'Off']], set.haptics))
      + '<div class="muted" style="padding-top:12px">Quarter length applies to the next game you start.</div>'
      + '<div class="btn-row"><button class="btn btn-go" id="btnDone" type="button">Done</button></div>');
    Array.prototype.forEach.call(ovHost.querySelectorAll('[data-set]'), function (b) {
      b.onclick = function () {
        var k = b.getAttribute('data-set'), v = b.getAttribute('data-val');
        set[k] = v === 'true' ? true : v === 'false' ? false : v;
        S.saveSettings(set);
        if (stage) { stage.setArt(set.art); stage.setMode(set.mode); }
        syncTools(); settingsOverlay();
      };
    });
    $('btnDone').onclick = closeOverlay;
  }
  function syncTools() {
    $('btnArt').setAttribute('aria-pressed', String(!!set.art));
    $('btnSound').setAttribute('aria-pressed', String(!!set.sound));
  }

  /* ── PREGAME ──────────────────────────────────────────────────────────── */
  /* ── CONDITIONS ──────────────────────────────────────────────────────────
     A venue, a sky and a temperature, drawn once from the fixture so the same
     game always kicks off in the same weather — and so the field, the crowd
     and the lights all agree about what day it is. */
  function conditions() {
    var key = (teams.me.abbr || '') + (teams.opp.abbr || '') + (teams.week || 1) + (teams.season || 1);
    var h = 2166136261, i;
    for (i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
    var r = function (n) { h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h >>> 0) % n); };
    var lights = ['day', 'day', 'dusk', 'night'];
    var skies = [['clear', 'Clear'], ['clear', 'Clear'], ['cloudy', 'Overcast'],
                 ['wind', 'Windy'], ['rain', 'Rain']];
    var sky = skies[r(skies.length)];
    var light = lights[r(lights.length)];
    return {
      light: light, weather: sky[0], sky: sky[1],
      temp: 52 + r(34),
      wind: 4 + r(14),
      kick: light === 'night' ? '7:05 PM' : light === 'dusk' ? '4:25 PM' : '1:00 PM',
      venue: (teams.home !== false ? (teams.me.name || 'Home') : (teams.opp.name || 'Away')) + ' Stadium'
    };
  }
  var COND = null;
  function cond() { if (!COND) COND = conditions(); return COND; }

  /* a player's name, short enough for a card */
  function FRname(p) {
    if (!p) return '';
    return (p.first_name ? p.first_name.charAt(0) + '. ' : '') + (p.last_name || '');
  }

  /* the man worth naming on each side, and why */
  function featured(team) {
    var t = G.makeTeam({ name: team.name, city: team.city, seed: team.seed || ((team.city || '') + (team.name || '')),
      overall: team.overall || 72, offense: team.offense, defense: team.defense, players: team.players || null });
    var best = null;
    (t.players || []).forEach(function (p) {
      if (['QB', 'RB', 'WR', 'TE'].indexOf(p.position) < 0) return;
      if (!best || p.overall > best.overall) best = p;
    });
    return best;
  }

  /* ── A CLUB'S MARK ───────────────────────────────────────────────────────
     Nine original geometric devices, one per club, drawn as a watermark
     inside the badge behind the abbreviation. Not a logo in the trademark
     sense and not anybody else's — a gear, a horn, a wave, a peak: the shapes
     a small town in this league would put on a helmet. */
  var CLUB_MARKS = {
    gear:   'M12 3l2.1 1.6 2.6-.5.9 2.5 2.3 1.3-1 2.4 1 2.4-2.3 1.3-.9 2.5-2.6-.5L12 21l-2.1-1.6-2.6.5-.9-2.5L4.1 16l1-2.4-1-2.4 2.3-1.3.9-2.5 2.6.5zM12 9a3 3 0 100 6 3 3 0 000-6z',
    bull:   'M3 7c2.6 0 4 1.6 4.6 3.4C8.9 9.4 10.3 9 12 9s3.1.4 4.4 1.4C17 8.6 18.4 7 21 7c0 5-2.6 7.4-5.2 7.4-.9 0-1.7-.2-2.3-.6l-.7 4.6h-1.6l-.7-4.6c-.6.4-1.4.6-2.3.6C5.6 14.4 3 12 3 7z',
    spear:  'M12 2l3.4 6.2-2.1.6 1.9 3.4-1.7.5L12 22l-1.5-9.3-1.7-.5 1.9-3.4-2.1-.6z',
    wing:   'M2 9c5 0 8.6 1.4 11 4.2C15.4 10.4 19 9 22 9c-1.2 4-4.4 6.6-10 8-5.6-1.4-8.8-4-10-8zM6 5c3.4.4 5.8 1.7 7.3 3.8C11 7.2 8.6 6 6 5.7z',
    anchor: 'M11 3h2v3h2.4v2H13v9.3c2.4-.5 4-2.2 4.4-4.7l-1.7.4L18.9 9 22 13.3l-1.9-.4c-.6 4.2-3.9 6.9-8.1 7.1-4.2-.2-7.5-2.9-8.1-7.1L2 13.3 5.1 9l2.2 4-1.7-.4c.4 2.5 2 4.2 4.4 4.7V8H7.6V6H11z',
    horn:   'M4 18c0-7 4.4-12 11-12 3 0 5 1 5 1s-2.6.6-4.4 2.4C13.4 11.6 13 15 13 18z M6.5 18a2.5 2.5 0 105 0 2.5 2.5 0 00-5 0z',
    wave:   'M2 9c2.6-2.4 5.2-2.4 7.8 0s5.6 2.4 8.2 0l4-3.6v3.4l-4 3.6c-2.6 2.4-5.6 2.4-8.2 0S4.6 10 2 12.4zm0 6c2.6-2.4 5.2-2.4 7.8 0s5.6 2.4 8.2 0l4-3.6V15l-4 3.6c-2.6 2.4-5.6 2.4-8.2 0S4.6 16 2 18.4z',
    shield: 'M12 2l8 3v7.2c0 4.6-3.2 8-8 9.8-4.8-1.8-8-5.2-8-9.8V5zm0 3.4L7 7.2v5c0 3.1 2 5.5 5 6.9 3-1.4 5-3.8 5-6.9v-5z',
    peak:   'M2 20L9 6l3.4 6.6L14.6 9 22 20zm7-9.4L5.8 17h6.4z'
  };
  function clubMark(key) {
    var d = CLUB_MARKS[key] || CLUB_MARKS.shield;
    return '<svg class="mu-mark" viewBox="0 0 24 24" aria-hidden="true">'
      + '<path d="' + d + '"/></svg>';
  }

  function pregame(resumable) {
    pre.hidden = false; gd.hidden = true;
    var opp = teams.opp, mine = teams.me, oppTeam = null;
    S.TEAMS.forEach(function (t) { if (t.abbr === opp.abbr) oppTeam = t; });
    var c = cond();
    var myStar = featured(mine), theirStar = featured(opp);
    var myK = kitFor('me'), theirK = kitFor('opp');

    function side(t, kit, star, home) {
      return '<div class="mu-side">'
        + '<div class="mu-badge" style="--tc:' + esc(kit.primary || '#3fb883') + '">'
        + clubMark(t.logo) + '<span>' + esc((t.abbr || '???').slice(0, 3)) + '</span></div>'
        + '<div class="mu-name">' + esc(t.city || '') + '</div>'
        + '<div class="mu-club">' + esc(t.name || '') + '</div>'
        + '<div class="mu-ovr">' + esc(t.overall || 72) + ' <span>OVR</span></div>'
        + '<div class="mu-id">' + esc(F.scheme(t.offense).name) + '</div>'
        + '<div class="mu-id dim">' + esc(defName(t.defense)) + '</div>'
        + (star ? '<div class="mu-star"><b>' + esc(star.position) + ' ' + esc(FRname(star)) + '</b>'
            + '<i>' + esc(star.overall) + ' OVR</i></div>' : '')
        + '<div class="mu-ha">' + (home ? 'HOME' : 'AWAY') + '</div></div>';
    }
    var home = teams.home !== false;
    preCard.innerHTML =
      '<div class="mu-top"><span class="mu-eyebrow">Game Day</span>'
      + '<span class="mu-week">Week ' + esc(teams.week || 1) + '</span></div>'
      + '<div class="mu-venue">' + esc(c.venue) + '</div>'
      + '<div class="mu-grid">'
      + side(mine, myK, myStar, home)
      + '<div class="mu-v"><span>VS</span></div>'
      + side(opp, theirK, theirStar, !home)
      + '</div>'
      + '<div class="mu-strip">'
      + '<div><i>Kickoff</i><b>' + esc(c.kick) + '</b></div>'
      + '<div><i>Sky</i><b>' + esc(c.sky) + '</b></div>'
      + '<div><i>Temp</i><b>' + esc(c.temp) + '&deg;F</b></div>'
      + '<div><i>Wind</i><b>' + esc(c.wind) + ' mph</b></div>'
      + '</div>'
      + '<div class="mu-key"><span class="mu-kl">Key matchup</span>'
      + '<b>' + esc(F.scheme(mine.offense).name) + '</b> against <b>' + esc(defName(opp.defense)) + '</b></div>'
      + (oppTeam ? '<p class="mu-scout">' + esc(oppTeam.blurb) + '</p>'
          + '<div class="mu-tags"><span>Rated ' + oppTeam.overall + '</span>'
          + '<span>Tendencies: low confidence</span></div>' : '')
      + '<div class="btn-row">'
      + (resumable ? '<button class="btn btn-go" id="btnResume" type="button">Resume &mdash; '
          + esc(resumable.show.home + ' ' + resumable.show.score.home + ', ' + resumable.show.away + ' '
            + resumable.show.score.away + ' · Q' + resumable.show.quarter) + '</button>' : '')
      + '<button class="btn ' + (resumable ? '' : 'btn-go') + ' btn-big" id="btnStart" type="button">'
      + (resumable ? 'Start a new game' : 'Kick off') + '</button>'
      + '<button class="btn btn-ghost" id="btnSet2" type="button">Settings</button>'
      + '<a class="btn btn-ghost" href="/games/gameday/">Back to Game Day</a></div>';
    paintPreField();
    if ($('btnResume')) $('btnResume').onclick = function () { resumeGame(resumable); };
    $('btnStart').onclick = function () { S.clearSave(); newGame(); };
    $('btnSet2').onclick = settingsOverlay;
  }
  /* the two teams, lined up behind the card. Same artist, same camera and
     the same men who will take the first snap — it is not a picture of a
     football game, it is the football game, standing still. */
  function paintPreField() {
    var LU = window.EDGridironLineup, cv = $('preField');
    if (!LU || !cv || !teams.me) return;
    function go() {
      try {
        var c2 = cond();
        LU.draw(cv, teams.me, 'faceoff', {
          shot: 'stadium', at: 22,
          away: teams.opp,
          theme: themeOf(teams.me.theme),
          awayTheme: themeOf(teams.opp ? teams.opp.theme : null),
          homeColor: ezPaint(themeOf(teams.me.theme), '#123326'),
          awayColor: ezPaint(themeOf(teams.opp ? teams.opp.theme : null), '#2a1a2f'),
          homeTint: themeOf(teams.me.theme).primary,
          awayTint: themeOf(teams.opp ? teams.opp.theme : null).primary,
          homeInk: ezInk(themeOf(teams.me.theme)),
          awayInk: ezInk(themeOf(teams.opp ? teams.opp.theme : null)),
          homeName: teams.me.abbr || '', awayName: teams.opp ? (teams.opp.abbr || '') : '',
          light: c2.light, weather: c2.weather, excite: 0.45,
          tags: false
        });
      } catch (_) {}
    }
    go();
    if (window.requestAnimationFrame) window.requestAnimationFrame(go);
    if (!cv.__wired) {
      cv.__wired = 1;
      if (window.ResizeObserver) { try { new window.ResizeObserver(go).observe(cv); } catch (_) {} }
      window.addEventListener('resize', go);
    }
  }

  function defName(k) {
    var out = k;
    (FR && FR.DEFENSES ? FR.DEFENSES : []).forEach(function (d) { if (d.key === k) out = d.label; });
    return out;
  }

  /* ── STARTING ─────────────────────────────────────────────────────────── */
  function makeStage() {
    var c0 = cond();
    stage = ST.Stage(canvas, {
      /* THE GAME IS PLAYED IN THE WEATHER THE CARD PROMISED. The matchup
         page names a 7:05 kickoff under an overcast sky and then the field
         came up at one in the afternoon in clear sun, because nothing ever
         handed the fixture's conditions to the stage. */
      light: c0.light, weather: c0.weather,
      homeColor: kitFor('me').secondary || '#123326',
      awayColor: kitFor('opp').secondary || '#2a1a2f',
      on: {
        onSnap: function () { SOUND.snap(); buzz('light'); },
        onHandoff: function () { buzz('light'); if (set.mode === 'play' && userHasBall()) padRun(); },
        onThrow: function () { SOUND.kick(); },
        onCatch: function () { SOUND.catch_(); buzz('light'); crowdUp(0.42, 0.16); if (set.mode === 'play' && userHasBall()) padRun(); },
        onScramble: function () { if (set.mode === 'play' && userHasBall()) padRun(); },
        onBreak: function () { SOUND.hit(true); buzz('medium'); crowdUp(0.62, 0.20); },
        onIntercept: function () { SOUND.bad(); },
        onKick: function () { SOUND.kick(); buzz('medium'); },
        onIncomplete: function () {},
        onMove: function () {},
        onEnd: onEnd
      }
    });
    wireFieldTaps();
  }
  function newGame() {
    /* THE WEATHER ON THE CARD IS THE WEATHER ON THE FIELD. The matchup page
       has always named a sky, a temperature and a wind; the engine had never
       heard of any of them, so a gale was a picture. It is worth about ten
       yards of field goal range and the throw over the top — modest, and
       real. */
    game = S.build({ me: teams.me, opponent: teams.opp, home: teams.home !== false,
      week: teams.week || 1, season: teams.season || 1, opponentKey: teams.oppKey,
      weather: cond(), settings: set });
    me = game.meta.user;
    startPlaying();
    if (GM && GM.track) GM.track('gridiron_game_started', { difficulty: set.difficulty, mode: set.mode });
  }
  function resumeGame(rec) {
    game = S.resume(rec, { me: teams.me, opponent: teams.opp, weather: cond() });
    if (!game) { newGame(); return; }
    me = game.meta.user;
    startPlaying();
    if (game.over) finalScreen();
  }
  function startPlaying() {
    milestoned = {};
    pre.hidden = true; gd.hidden = false;
    makeStage();
    syncTools(); paintScore(); say('');
    busy = false;
    setTimeout(function () { stage.resize(); nextCall(); }, 30);
  }

  /* ── BOOT ─────────────────────────────────────────────────────────────── */
  function boot() {
    teams.me = S.teamFromLeague({ key: 'house', city: S.HOUSE.city, name: S.HOUSE.name, abbr: S.HOUSE.abbr,
      theme: S.HOUSE.theme, logo: S.HOUSE.logo, offense: S.HOUSE.offense, defense: S.HOUSE.defense,
      overall: S.HOUSE.overall });
    teams.opp = S.teamFromLeague(S.TEAMS[0]);
    teams.oppKey = S.TEAMS[0].key;
    var rec = S.saved();
    pregame(rec && rec.calls && rec.calls.length > 2 ? rec : null);
    wireTools();
    if (GM && GM.boot) { try { GM.boot('gameday'); } catch (_) {} }
    if (!FR) return;
    Promise.resolve(GM && GM.franchiseReady ? GM.franchiseReady() : null).then(function () {
      var snap = null;
      try { snap = FR.snapshot(); } catch (_) {}
      if (!snap || !snap.franchise || game) return;
      var f = snap.franchise, week = snap.week || {}, ng = snap.next_game || null;
      var prep = FR.prep ? FR.prep(week) : null;
      teams.me = S.teamFromFranchise(f, null, prep);
      if (ng && ng.opponent) {
        teams.opp = { city: ng.opponent.city, name: ng.opponent.name,
          abbr: ng.opponent.abbr || (ng.opponent.name || 'OPP').slice(0, 3).toUpperCase(),
          theme: ng.opponent.theme || 'crimson', logo: ng.opponent.logo || 'shield',
          offense: ng.opponent.offense, defense: ng.opponent.defense,
          overall: ng.opponent.overall || 73, seed: (ng.opponent.city || '') + (ng.opponent.name || '') };
        teams.home = ng.home !== false; teams.week = ng.week || 1;
        teams.season = (snap.season && snap.season.number) || 1;
      }
      return FR.roster().then(function (r) {
        var players = (r && (r.players || r.roster)) || null;
        if (players && players.length) teams.me.players = players;
      }).catch(function () {});
    }).catch(function () {}).then(function () { if (!game) pregame(S.saved()); });
  }
  function wireTools() {
    $('btnArt').onclick = function () {
      set.art = !set.art; S.saveSettings(set); if (stage) stage.setArt(set.art); syncTools(); SOUND.tap();
    };
    $('btnSound').onclick = function () {
      set.sound = !set.sound; S.saveSettings(set); syncTools();
      if (set.sound) SOUND.ambience(0.2); else SOUND.quiet();
    };
    $('btnSet').onclick = settingsOverlay;
    $('btnExit').onclick = function () { location.href = '/games/gameday/'; };
    /* TAP TO SKIP. Anywhere on the field, and only while a sequence is
       actually running — it must never eat a tap meant for a receiver. */
    fieldWrap.addEventListener('pointerdown', function () { if (kickSkip) kickSkip(); }, true);
    window.addEventListener('beforeunload', function () { if (game && !game.over) S.save(game); });
    /* no rubber-banding under the thumbs */
    document.addEventListener('touchmove', function (e) {
      if (e.target.closest && e.target.closest('.deck, .ov-in, .dr-list')) return;
      e.preventDefault();
    }, { passive: false });
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      var v = 'dev';
      try {
        var el = document.querySelector('script[src*="/games/play/play.js"]');
        var m = el && el.src.match(/[?&]v=([A-Za-z0-9._-]+)/);
        if (m) v = m[1];
      } catch (_) {}
      navigator.serviceWorker.register('/games/play/sw.js?v=' + v).catch(function () {});
    });
  }

  boot();
})();
