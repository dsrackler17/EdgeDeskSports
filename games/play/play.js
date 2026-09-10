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
  /* ── ONE NAMED STATE FOR THE PAGE ──────────────────────────────────────
     games/lib/gridiron/flow.js. Every transition below says where the page
     is in the ritual of a snap — LOADING, PRE_GAME, KICKOFF, PLAY_SELECT,
     PRE_SNAP, LIVE_PLAY, PLAY_ENDING, RESULT, TRANSITION, PAT, QUARTER_END,
     HALFTIME, GAME_OVER — and the guards below ask it rather than a flag of
     their own. `busy` is the interaction lock the football holds between the
     snap and the next call; it is set at exactly the transitions that lock
     and released at exactly the ones that unlock. The engine's game object
     remains the only authority on the football itself. */
  var FLOW = window.EDGridironFlow ? window.EDGridironFlow.create() : null;
  function flow(to, why) { if (FLOW) FLOW.set(to, why); }
  try { window.__edFlow = FLOW; } catch (_) {}
  var busy = false, pendingCall = null, ballX = PT.FIELD.half, lastResult = null;
  /* ── RESEARCH IQ (read_v1) ───────────────────────────────────────────────
     Every call you make is frozen before the snap and graded on what you
     could see — never on what happened. READS holds one entry per decision:
     the context, the grade, and (separately, afterwards) what the play did. */
  var RD = window.EDGridironRead || null;
  var READS = [], pendingRead = null;
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
      /* ON A WIDE SCREEN THE SHEET IS A COLUMN BESIDE THE FIELD, not a sheet
         over it, and covers nothing; asked the same question it answered
         with its own height and the camera framed half a field that was
         never hidden. */
      var beside = false;
      try { beside = window.getComputedStyle(drawer).position === 'static'; } catch (_) {}
      var over = (open && !beside) ? Math.max(0, fr.bottom - (h - drawer.offsetHeight)) : 0;
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
    /* IN THE WEATHER THE KICK WILL BE TAKEN IN. Asked on a still day, the
       button offered kicks the engine would then treat as out of range in a
       fifteen-mile-an-hour wind. */
    var k = G.fieldGoal(ou, null, sit.ball, function () { return 0.5; }, false, game.weather);
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
  /* ── THE MOVES, UNDER THE RIGHT THUMB ───────────────────────────────────
     A ball carrier holds SPRINT and taps JUKE, SPIN or STIFF ARM; a defender
     holds SPRINT and taps TACKLE, DIVE or SWITCH. One big button you hold
     and three you tap, in a cluster the thumb can cover without looking. */
  function cluster(hold, taps) {
    pad.classList.add('on');
    pad.innerHTML =
      '<div class="pd-stick" id="pdStick"><div class="pd-ring"></div><div class="pd-knob" id="pdKnob"></div></div>'
      + '<div class="pd-acts pd-cluster">'
      + taps.map(function (t, i) {
          return '<button class="pd-act pd-act-b pd-t' + i + '" data-act="' + t[0] + '" type="button">' + esc(t[1]) + '</button>';
        }).join('')
      + (hold ? '<button class="pd-act pd-act-a pd-hold" data-hold="' + hold[0] + '" type="button">' + esc(hold[1]) + '</button>' : '')
      + '</div>';
    wireStick(); wireActs(); wireHold();
  }
  function padRun() { cluster(['sprint', 'Sprint'], [['juke', 'Juke'], ['spin', 'Spin'], ['stiff', 'Stiff arm']]); }
  function padDefense() { cluster(['sprint', 'Sprint'], [['tackle', 'Tackle'], ['dive', 'Dive'], ['switch', 'Switch']]); }
  /* Dropping back you can still run: the stick and the scramble button stay
     live while the throw badges sit over the receivers. */
  function padPass() { sticks(['scramble', 'Scramble'], null); }
  /* the held button: down is on, up or leaving is off, and a finger that
     wanders off the button lets go */
  var holdOn = false;
  function wireHold() {
    var b = pad.querySelector('[data-hold]');
    if (!b) return;
    function on(e) { holdOn = true; b.classList.add('on'); if (stage) stage.sprint(true); if (e.cancelable) e.preventDefault(); }
    function off() { if (!holdOn) return; holdOn = false; b.classList.remove('on'); if (stage) stage.sprint(false); }
    b.addEventListener('touchstart', on, { passive: false });
    b.addEventListener('mousedown', on);
    ['touchend', 'touchcancel', 'mouseup', 'mouseleave'].forEach(function (ev) { b.addEventListener(ev, off); });
  }
  /* whether the ball is in a hand this user is steering */
  function userHasBall() {
    var sit = game ? G.situation(game) : null;
    return !!sit && sit.offense === me;
  }

  /* a tap on the field is a throw, if it lands on a badge */
  /* ── A TAP IS A THROW; A TAP HELD IS A BULLET ────────────────────────
     The finger lands on the badge and the badge arms — a gold ring grows
     out of it. Let go inside a fifth of a second and it is the ordinary
     football; hold it past that and the ball leaves harder and lower. The
     throw goes on the release, so the hold is something you can see and
     feel (a second light pulse when the bullet is ready) rather than a
     timer you have to trust. Nobody needs five kinds of throw. */
  var HOLD_MS = 220;
  var armed = null, armTimer = null;
  function throwArmed(a) {
    if (!a) return;
    clearTimeout(armTimer);
    if (stage && stage.armTarget) stage.armTarget(-1);
    var kind = (Date.now() - a.at >= HOLD_MS) ? 'bullet' : null;
    if (stage && stage.throwTo(a.idx, kind)) {
      if (kind) { SOUND.kick(); buzz('medium'); } else SOUND.tap();
      padRun();
    }
  }
  function wireFieldTaps() {
    /* A TAP IS ONE TAP. A touch screen fires touchstart and then a synthetic
       mousedown for the same finger, and both were throwing the ball: the
       simulation ignores the second one, but the sound and the buzz fired
       twice and it read as a stutter. */
    var lastTap = 0;
    function down(e) {
      var now = Date.now();
      if (now - lastTap < 400) return;
      /* a replay is skipped by a tap anywhere on it */
      if (stage && stage.replaying && stage.replaying()) { lastTap = now; stage.skipReplay(); if (e.cancelable) e.preventDefault(); return; }
      var t = e.changedTouches ? e.changedTouches[0] : e;
      var b = canvas.getBoundingClientRect();
      var i = stage.hitTarget(t.clientX - b.left, t.clientY - b.top);
      if (i >= 0) {
        lastTap = now;
        armed = { idx: i, at: now };
        stage.armTarget(i);
        buzz('light');
        clearTimeout(armTimer);
        armTimer = setTimeout(function () { if (armed) buzz('light'); }, HOLD_MS);
        if (e.cancelable) e.preventDefault();
      }
    }
    function up() {
      if (!armed) return;
      var a = armed; armed = null;
      throwArmed(a);
    }
    canvas.addEventListener('touchstart', down, { passive: false });
    canvas.addEventListener('mousedown', down);
    window.addEventListener('touchend', up);
    window.addEventListener('touchcancel', up);
    window.addEventListener('mouseup', up);
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
    stickHome();
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

  /* ── THE STICK IS WHERE YOUR THUMB IS ─────────────────────────────────
     A fixed ring 118 pixels across that only answers a touch which STARTED
     inside it is a control you have to look down and aim for, in the middle
     of a play, on a device you are holding in two hands. Miss it and nothing
     happens at all — no feedback, no man moving, just a play going past you.
     That is most of "it is almost impossible to control the guy".

     So the whole bottom-left of the field is the stick. Put a thumb down
     anywhere in it and the ring comes to the thumb; drag from there. It
     goes home when you let go, so it is still a thing you can see and learn.

     It yields to everything that was already there: a receiver badge is a
     throw, a button is a button, and the ring itself still works the old
     way for anyone who aims at it. */
  function stickGrabbable(t) {
    if (!$('pdStick') || !stage) return false;
    var b = fieldWrap.getBoundingClientRect();
    var lx = t.clientX - b.left, ly = t.clientY - b.top;
    if (lx < 0 || ly < 0 || lx > b.width || ly > b.height) return false;
    if (lx > b.width * 0.62 || ly < b.height * 0.34) return false;
    /* a badge over a receiver is a throw, not a joystick */
    var c = canvas.getBoundingClientRect();
    if (stage.hitTarget(t.clientX - c.left, t.clientY - c.top) >= 0) return false;
    return true;
  }
  function stickAt(e, t, cx, cy, r) {
    stickState.id = e.changedTouches ? t.identifier : 'mouse';
    stickState.cx = cx; stickState.cy = cy; stickState.r = r;
    stickMove(e);
    if (e.cancelable) e.preventDefault();
  }
  function stickHome() {
    var el = $('pdStick');
    if (!el) return;
    el.classList.remove('free');
    el.style.left = ''; el.style.bottom = '';
  }
  function wireStick() {
    var el = $('pdStick');
    if (!el) return;
    function down(e) {
      var t = e.changedTouches ? e.changedTouches[0] : e;
      var b = el.getBoundingClientRect();
      stickAt(e, t, b.left + b.width / 2, b.top + b.height / 2, b.width / 2);
    }
    el.addEventListener('touchstart', down, { passive: false });
    el.addEventListener('mousedown', down);
  }
  /* bound once, for the life of the page, like the drag listeners above */
  function floatStick(e) {
    if (gd.hidden || stickState.id != null) return;
    if (e.target && e.target.closest
      && e.target.closest('.pd-act, .pd-snap, .pd-flip, .gd-tools, .drawer, .ov')) return;
    var t = e.changedTouches ? e.changedTouches[0] : e;
    if (!stickGrabbable(t)) return;
    var el = $('pdStick'), host = fieldWrap.getBoundingClientRect();
    var w = el.offsetWidth || 118, h = el.offsetHeight || 118;
    var cx = Math.min(Math.max(t.clientX, host.left + w / 2 + 2), host.right - w / 2 - 2);
    var cy = Math.min(Math.max(t.clientY, host.top + h / 2 + 2), host.bottom - h / 2 - 2);
    el.classList.add('free');
    el.style.left = (cx - host.left - w / 2) + 'px';
    el.style.bottom = (host.bottom - cy - h / 2) + 'px';
    stickAt(e, t, cx, cy, w / 2);
  }
  fieldWrap.addEventListener('touchstart', floatStick, { passive: false });
  fieldWrap.addEventListener('mousedown', floatStick);
  function act(a) {
    if (!stage) return;
    if (a === 'switch') { stage.switchDefender(); SOUND.tap(); buzz('light'); return; }
    if (a === 'scramble') { if (stage.action('scramble')) { SOUND.tap(); buzz('light'); padRun(); } return; }
    if (stage.action(a)) { SOUND.hit(); buzz('medium'); }
  }
  function wireActs() {
    Array.prototype.forEach.call(pad.querySelectorAll('[data-act]'), function (b) {
      /* touchstart rather than click: a tap that waits for the finger to lift
         is a tap that arrives after the tackle */
      var fired = 0;
      var go = function (e) {
        if (Date.now() - fired < 120) return;
        fired = Date.now();
        act(b.getAttribute('data-act'));
        if (e.cancelable) e.preventDefault();
      };
      b.addEventListener('touchstart', go, { passive: false });
      b.addEventListener('mousedown', go);
    });
  }

  /* ── THE KEYBOARD, SECOND ────────────────────────────────────────────────
     A desktop plays the same game: arrows or WASD steer, Space is the snap
     before the ball moves and the sprint after it, J K L are the three taps,
     1–5 throw to the badges in progression order, Tab switches the defender
     and Enter snaps. Bound once, for the life of the page. */
  var KEYS = { held: {}, dirty: false };
  function keySteer() {
    var x = 0, y = 0, h = KEYS.held;
    if (h.ArrowLeft || h.a || h.A) x -= 1;
    if (h.ArrowRight || h.d || h.D) x += 1;
    if (h.ArrowUp || h.w || h.W) y += 1;
    if (h.ArrowDown || h.s || h.S) y -= 1;
    if (stage) stage.steer(x, y);
  }
  function typing(e) {
    var t = e.target, tag = t && t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable);
  }
  window.addEventListener('keydown', function (e) {
    if (gd.hidden || typing(e)) return;
    var k = e.key;
    if (k === 'Escape') { if (ovHost.innerHTML) { closeOverlay(); } else drawerClose(); return; }
    if (!game) return;
    var live = stage && stage.phase() === 'live';
    var onDef = game && G.situation(game).offense !== me;
    if (k === 'Enter' || k === ' ') {
      e.preventDefault();
      if (stage && stage.phase() === 'set' && FLOW && FLOW.can('snap')) { doSnap(); return; }
      if (live && k === ' ') { if (stage) stage.sprint(true); }
      return;
    }
    if (/^[1-5]$/.test(k) && live && !onDef && stage) {
      if (e.repeat) { e.preventDefault(); return; }
      var i = parseInt(k, 10) - 1, list = stage.receivers();
      if (list && list[i] && !armed) { armed = { idx: i, at: Date.now(), key: k }; stage.armTarget(i); }
      e.preventDefault(); return;
    }
    if (k === 'Tab' && live && onDef) { act('switch'); e.preventDefault(); return; }
    if (live && (k === 'j' || k === 'J')) { act(onDef ? 'tackle' : 'juke'); return; }
    if (live && (k === 'k' || k === 'K')) { act(onDef ? 'dive' : 'spin'); return; }
    if (live && (k === 'l' || k === 'L')) { act(onDef ? 'switch' : 'stiff'); return; }
    if (live && (k === 'q' || k === 'Q') && !onDef) { act('scramble'); return; }
    if (/^Arrow|^[wasdWASD]$/.test(k)) { KEYS.held[k] = 1; keySteer(); e.preventDefault(); }
  });
  window.addEventListener('keyup', function (e) {
    var k = e.key;
    if (k === ' ') { if (stage) stage.sprint(false); }
    if (armed && armed.key === k) { var a2 = armed; armed = null; throwArmed(a2); }
    if (KEYS.held[k]) { delete KEYS.held[k]; keySteer(); }
  });

  /* ── CHOOSING ─────────────────────────────────────────────────────────── */
  function choosePlay(key, formKey) {
    if (busy || (FLOW && !FLOW.can('call'))) return;
    flow('PRE_SNAP', 'play chosen');
    SOUND.tap(); buzz('light');
    drawerClose();
    var sit = G.situation(game);
    var defKey = S.aiDefense(game);
    var ps = S.preSnap(game, key, formKey, defKey);
    pendingCall = { type: 'play', play: key, formation: formKey, def: defKey, tempo: tempo };
    captureRead(key, formKey, ps, sit);
    lineUp(key, formKey, defKey, ps, sit);
    padSnap('Snap');
    seenTip('call');
    autoSnap();
  }
  /* ── WHAT YOU COULD SEE WHEN YOU CALLED IT ───────────────────────────────
     Frozen before the snap: the down, the clock, the look above the field,
     the men you have, and what you have been leaning on. The outcome is not
     in here and cannot get in here. */
  function personnelSummary() {
    if (!game) return null;
    var t = G.teamOf(game, me), men = (t && t.players) || [];
    function best(pos) {
      var b = null;
      men.forEach(function (p) {
        if (p.position !== pos) return;
        if ((p.depth || 1) > 1 && pos !== 'WR') return;
        if (!b || (p.overall | 0) > (b.overall | 0)) b = p;
      });
      return b;
    }
    function avg(pos) {
      var t2 = 0, n = 0;
      men.forEach(function (p) { if (p.position === pos && (p.depth || 1) <= 5) { t2 += p.overall | 0; n++; } });
      return n ? Math.round(t2 / n) : 70;
    }
    var rb = best('RB') || {}, qb = best('QB') || {}, wr = best('WR') || {};
    var rr = rb.ratings || {}, qr = qb.ratings || {};
    return {
      rb: { overall: rb.overall | 0, archetype: rb.archetype || '', speed: rr.speed | 0, power: rr.power | 0 },
      qb: { overall: qb.overall | 0, archetype: qb.archetype || '', arm: qr.arm | 0 },
      wr: { best: wr.overall | 0 },
      ol: avg('OL')
    };
  }
  function captureRead(key, formKey, ps, sit) {
    if (!RD || !game || sit.offense !== me) { pendingRead = null; return; }
    var them = G.other(me);
    pendingRead = {
      ctx: RD.context({
        sit: { down: sit.down, toGo: sit.toGo, ball: sit.ball, quarter: sit.quarter, clock: sit.clock },
        preSnap: ps, play: F.play(key) || {}, playKey: key, formation: formKey,
        scoreFor: game.score[me] | 0, scoreAgainst: game.score[them] | 0,
        personnel: personnelSummary(),
        recent: READS.map(function (r) { return r.ctx.concept; }).reverse().slice(0, 8),
        at: Date.now()
      }),
      text: (F.play(key) || {}).name || key
    };
    pendingRead.grade = RD.grade(pendingRead.ctx);
  }
  /* the play is over; the RESULT is filed beside the grade, never inside it */
  function fileRead(res) {
    if (!pendingRead) return null;
    var e = pendingRead; pendingRead = null;
    if (!e.grade) return null;
    e.result = RD.resultScore(res || {}, e.ctx);
    e.yards = (res && res.yards) | 0;
    /* the run's own record travels with the read, so the panel can say WHY
       a sound call came to nothing rather than only that it did */
    e.rush = (res && res.rush) || null;
    e.text = e.text + ' on ' + e.ctx.down + ' & ' + e.ctx.toGo;
    READS.push(e);
    return e;
  }
  function chooseDefense(defKey) {
    if (busy || (FLOW && !FLOW.can('call'))) return;
    flow('PRE_SNAP', 'defence chosen');
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
    autoSnap();
  }
  /* ── THE SNAP THAT MAKES ITSELF ──────────────────────────────────────────
     In Coach mode you pick the call and the ball is snapped for you. The
     timer that does it has to be CANCELLED the moment anything else happens,
     because a play can be over inside its seven hundred milliseconds — and a
     stale one then says hut over the eleven men the page had already lined up
     for the NEXT down. */
  var autoT = null;
  function cancelAuto() { if (autoT) { clearTimeout(autoT); autoT = null; } }
  function autoSnap() {
    cancelAuto();
    if (set.mode !== 'coach') return;
    autoT = setTimeout(function () { autoT = null; doSnap(); }, 700);
  }

  var snapSit = null;
  function lineUp(playKey, formKey, defKey, ps, sit) {
    var offT = G.teamOf(game, sit.offense), defT = G.teamOf(game, sit.defense);
    snapSit = { down: sit.down, toGo: sit.toGo, toGoal: sit.toGoal, offense: sit.offense, quarter: sit.quarter,
                clock: sit.clock, score: { home: game.score.home, away: game.score.away } };
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
      sit: sit, mem: game.mem[sit.offense], weather: game.weather,
      /* the tier sharpens the OTHER side's defence and nothing of yours */
      difficulty: sit.offense === me ? set.difficulty : 'pro'
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
    cancelAuto();
    if (busy || stage.phase() !== 'set' || (FLOW && !FLOW.can('snap'))) return;
    busy = true;
    flow('LIVE_PLAY', 'snap');
    readEl.hidden = true;
    SOUND.snap(); buzz('light');
    /* the place leans in on the snap and settles again on the whistle */
    crowdUp(0.30, 0.20);
    seenTip('snap');
    var sit = G.situation(game);
    var mine = sit.offense === me;
    padClear();
    /* THE GAME MUST NEVER BE ABLE TO STOP. This holds the controls shut until
       the whistle, so a second tap cannot snap the same ball twice — which
       means a snap that could not happen has to give the lock back, and a
       whistle that never comes has to be one anyway. */
    if (!stage.snapNow()) { busy = false; flow('TRANSITION', 'snap refused'); nextCall(); return; }
    armWhistle();
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

  /* ── THE WHISTLE THAT ALWAYS COMES ───────────────────────────────────────
     The simulation blows a play dead after twelve seconds of its own clock
     and cannot run forever. But a lock is not a play: if anything at all goes
     wrong between the tap and the result — a frame loop stopped by a phone
     locking, a stage that never reported back — the game would sit on the
     same down for ever with no way out but a reload. So the page keeps its
     own watch on the snap it is holding, and the whistle goes either way. */
  var whistleT = null;
  function armWhistle() {
    clearWhistle();
    whistleT = setTimeout(function () {
      whistleT = null;
      if (!busy) return;
      /* a tab that went to the background is not a play that hung: the loop
         restarts when it comes back, and the watch is re-armed then */
      if (document.hidden) { whistleT = null; return; }
      try { if (stage && stage.stop) stage.stop(); } catch (_) {}
      busy = false;
      say('');
      paintScore();
      flow('TRANSITION', 'whistle watchdog');
      nextCall();
    }, 22000);
  }
  /* ── A PHONE THAT LOCKED MID-PLAY ────────────────────────────────────────
     The stage stops drawing when the page is hidden, which is right. What was
     wrong is that nothing started it again: the play sat unfinished until the
     watchdog dropped the down on the floor. Coming back restarts the loop and
     re-arms the watch; going away parks it. */
  document.addEventListener('visibilitychange', function () {
    if (!stage) return;
    if (document.hidden) { clearWhistle(); if (stage.sprint) stage.sprint(false); return; }
    var ph = stage.phase && stage.phase();
    if (ph === 'live' || ph === 'dead' || ph === 'set' || ph === 'kick') { try { stage.start(); } catch (_) {} }
    if (busy && ph === 'live') armWhistle();
  });
  function clearWhistle() { if (whistleT) { clearTimeout(whistleT); whistleT = null; } }

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
    flow('TRANSITION', call.type);
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

  /* ── WHAT THE RUN GAME HAS ACTUALLY BEEN DOING (rush_v2) ────────────────
     Commentary that is not counting anything is decoration. This counts the
     real thing — carries stopped at or behind the line, carries that broke,
     and the ones a back rescued from a loss — and says it when the number
     itself is the story. Nothing here is invented: every line is a count of
     plays that happened, and it speaks at most a few times a game so that
     when it does the number means something. */
  var RUN = { stuffs: 0, runs: 0, saved: 0, broke: 0, said: {} };
  function runNote(p) {
    if (!p || !p.rush || p.completion) return;
    var r = p.rush;
    RUN.runs++;
    if (r.stuffed) RUN.stuffs++;
    var beat = (r.contacts || []).some(function (c) { return c.kind === 'broken' || c.kind === 'deflect'; });
    if (beat) RUN.broke++;
    /* met behind the line and still gained: the back rescued it */
    if (beat && r.yards > 2 && r.contact_depth != null && r.contact_depth < 1) RUN.saved++;
    var who = (p.carrier && (p.carrier.last_name || p.carrier.name)) || 'the back';
    if (RUN.stuffs === 3 && !RUN.said.three) {
      RUN.said.three = 1;
      return say('That is the third run they have stopped at or behind the line.');
    }
    if (RUN.saved === 1 && !RUN.said.saved && r.yards >= 4) {
      RUN.said.saved = 1;
      return say(who + ' turned a loss into ' + r.yards + '.');
    }
    if (r.explosive && RUN.stuffs >= 3 && !RUN.said.finally) {
      RUN.said.finally = 1;
      return say('Bottled up all afternoon, and there it goes.');
    }
    if (RUN.runs >= 8 && RUN.stuffs === 0 && !RUN.said.clean) {
      RUN.said.clean = 1;
      return say('Eight carries and the front has not won one of them.');
    }
  }
  function onEnd(kind, res) {
    clearWhistle();
    if (stage && stage.sprint) stage.sprint(false);
    holdOn = false;
    flow('PLAY_ENDING', kind);
    /* the simulation settled it; the engine books it, and only now do down,
       distance, clock and the season move. ONE GAME, ONE TRUTH: whatever mode
       you are in, the play you watched is the play that is booked. Coach Mode
       used to hand the resolver a second, independent draw, so a forty-yard
       run on the grass went into the books as three. */
    var p = (res && res.live) ? commit(res) : commitCoach();
    flow('RESULT', kind);
    /* THE READ IS FILED HERE, and only here: the grade was decided before the
       snap, the result is attached to it afterwards, and the two are never
       allowed to touch. */
    var readEntry = fileRead(p);
    if (readEntry) readBit(readEntry);
    runNote(p);
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
        /* a takeaway gets the broadcast's pull-out, briefly, before the next
           call brings the lens back down onto the new offence */
        setTimeout(function () { shotWide(true, true); }, 380);
        banner({ kind: 'bad', head: p.turnover === 'fumble' ? 'Fumble' : 'Intercepted',
          sub: (p.interceptor ? FRname(p.interceptor) : '')
            + (p.returnYards ? ' · returned ' + p.returnYards : ''), hold: 1500 });
      } else if (p.sack) {
        SOUND.bad(); buzz('medium'); crowdUp(0.75, 0.24);
        banner({ kind: 'bad', head: 'Sack', sub: p.tackler ? FRname(p.tackler) : '', hold: 1150 });
      } else if (p.firstDown) {
        SOUND.first(); buzz('medium'); crowdUp(0.55, 0.22);
        banner({ kind: 'first', head: 'First down', color: myColor, hold: 950 });
      } else {
        /* ── THE HIT ─────────────────────────────────────────────────────
           The simulation says how hard it landed. A square tackle at closing
           speed is a bump on the lens, a stronger pulse in the hand and the
           heavier sound; a drag-down is barely any of those. */
        var force = p.hit ? p.hit.force : 0;
        SOUND.hit(!!p.big || force > 0.72); buzz(force > 0.72 ? 'medium' : 'light');
        if (stage && stage.bump && force > 0.2) stage.bump(0.05 + force * 0.17);
        if (p.big) crowdUp(0.7, 0.22);
        if (force > 0.82 && p.hit.by) say(FRname(p.hit.by) + ' laid him out.');
      }
      setTimeout(function () { SOUND.whistle(); }, 230);
      if (!p.touchdown) resultCard(p);
      try { bigPlay(p, kind); } catch (e) { if (window.console) console.warn('bigPlay', e); }
      /* THE FOOTBALL DOES NOT STOP BECAUSE A CAPTION FAILED. Everything from
         here to the end of this handler is what moves the game on — the
         clock, the score, the next call — and the line above the numbers is
         decoration. One of them threw once, inside this handler, and the game
         stopped dead on the first snap of every game: no next play, no clock,
         nothing to press. Decoration gets a net; the game does not need one. */
      try { milestone(p); } catch (e) { if (window.console) console.warn('milestone', e); }
      try { broadcastBit(p); } catch (e) { if (window.console) console.warn('bit', e); }
      try { driveChip(); } catch (e) { if (window.console) console.warn('drive', e); }
      ballX = drift(ballX);
    }
    padClear();
    paintScore();
    var wait = set.speed === 'instant' ? 260
      : (p && p.touchdown) ? 2200 : (p && p.turnover) ? 1500 : 900;
    var proceed = function () { busy = false; flow('TRANSITION', 'next down'); nextCall(); };
    /* ── THE REPLAY ──────────────────────────────────────────────────────
       Reserved for the plays a broadcast shows again. It runs after the
       graphic has had its moment, off the tape the stage kept, at half
       speed from a low lens; a tap skips it and the game moves on. */
    if (p && replayWorthy(p, kind)) {
      setTimeout(function () {
        var ok = stage && stage.replay && stage.replay({ speed: 0.5, onEnd: function () { replaySkip(false); setTimeout(proceed, 320); } });
        if (!ok) { proceed(); return; }
        replaySkip(true);
        if (GM && GM.track) GM.track('gridiron_replay', { kind: kind, yards: p.yards | 0, touchdown: !!p.touchdown, turnover: p.turnover || null });
      }, Math.max(300, wait - 250));
    } else setTimeout(proceed, wait);
  }
  /* which plays are shown again: a score from distance, any takeaway, a
     fourth-down stand, a huge gain, and the play that took the lead late */
  function replayWorthy(p, kind) {
    if (set.replay === false || set.speed === 'instant' || !stage || !stage.hasReplay || !stage.hasReplay()) return false;
    if (p.touchdown && ((p.yards | 0) >= 20 || p.turnover)) return true;
    if (p.turnover) return true;
    if (snapSit && snapSit.down === 4 && !p.firstDown && !p.touchdown && !p.turnover && !p.punt) return true;
    if ((p.yards | 0) >= 35) return true;
    if (p.touchdown && snapSit && snapSit.quarter >= 4 && snapSit.clock <= 120) {
      var sc = game.pendingScore ? game.pendingScore.side : snapSit.offense;
      var before = snapSit.score[sc] - snapSit.score[G.other(sc)];
      if (before <= 0) return true;
    }
    return false;
  }
  function replaySkip(on) {
    var old = fieldWrap.querySelector('.rp-skip');
    if (old) old.parentNode.removeChild(old);
    if (!on) return;
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'rp-skip'; b.textContent = 'Skip';
    b.addEventListener('click', function () { if (stage && stage.skipReplay) stage.skipReplay(); });
    fieldWrap.appendChild(b);
  }
  /* ── THE BIG PLAY ────────────────────────────────────────────────────
     A score has its own moment and a takeaway its banner. This is the rest
     of what a broadcast puts a graphic on: a fourth-down stand, a huge gain,
     and the man's day so far under it. Short; the football is waiting. */
  function bigPlay(p, kind) {
    if (!game || !p || p.touchdown || p.turnover) return;
    var stand = snapSit && snapSit.down === 4 && !p.firstDown && !p.punt;
    if (stand) {
      var mineStop = snapSit.offense !== me;
      banner({ kind: mineStop ? 'first' : 'bad', eyebrow: 'Fourth down',
        head: snapSit.toGoal <= 5 ? 'Goal-line stand' : 'Stopped', sub: 'Turnover on downs',
        color: kitFor(mineStop ? 'me' : 'opp').primary, hold: 1400 });
      crowdUp(mineStop ? 0.85 : 0.5, 0.3);
      return;
    }
    if ((p.yards | 0) >= 30) {
      var man = p.target || p.carrier, st = man ? game.players[man.uid || man.id] : null;
      banner({ kind: 'good', eyebrow: 'Big play', head: (p.yards | 0) + '-yard ' + (p.completion ? 'catch' : 'run'),
        sub: st ? FRname(man) + ' · ' + dayLine(st) : (man ? FRname(man) : ''),
        color: kitFor(snapSit && snapSit.offense === me ? 'me' : 'opp').primary, hold: 1500 });
    }
  }
  /* a man's day in one line, in the position's own numbers */
  function dayLine(st) {
    if (!st) return '';
    if (st.position === 'QB') return st.pc + '/' + st.pa + ' · ' + st.py + ' YDS' + (st.ptd ? ' · ' + st.ptd + ' TD' : '') + (st.pint ? ' · ' + st.pint + ' INT' : '');
    if (st.position === 'RB') return st.car + ' CAR · ' + st.ry + ' YDS' + (st.rtd ? ' · ' + st.rtd + ' TD' : '') + (st.rec ? ' · ' + st.rec + ' REC' : '');
    if (st.position === 'WR' || st.position === 'TE') return st.rec + ' REC · ' + st.recy + ' YDS' + (st.rectd ? ' · ' + st.rectd + ' TD' : '');
    return st.tkl + ' TKL' + (st.sack ? ' · ' + st.sack + ' SACK' : '') + (st.int ? ' · ' + st.int + ' INT' : '');
  }
  /* ── THE DEAD-BALL BIT ───────────────────────────────────────────────
     Every few ordinary plays the broadcast fills the dead ball with one
     short fact: the man having the day, this drive, third downs, the
     matchup. Never on a play that already has a graphic, never long. */
  var bitCount = 0, bitTurn = 0, shownDrives = 0, saidContext = false;
  /* THE DRIVE, WHEN IT ENDS: how many plays, how many yards, how it ended —
     the chip a broadcast puts up while the units change */
  function driveChip() {
    if (!game || !game.drives || game.drives.length <= shownDrives) return;
    shownDrives = game.drives.length;
    var d = game.drives[game.drives.length - 1];
    if (!d || (d.plays | 0) < 2) return;
    var who = d.side === me ? teams.me.abbr : teams.opp.abbr;
    var el = document.createElement('div');
    el.className = 'drc' + (d.outcome === 'td' || d.outcome === 'fg' ? ' sc' : (d.outcome === 'interception' || d.outcome === 'fumble') ? ' to' : '');
    el.style.setProperty('--bc', kitFor(d.side === me ? 'me' : 'opp').primary || '#f2c744');
    el.innerHTML = '<i>' + esc(who) + ' drive</i><b>' + esc(d.plays) + ' plays · ' + esc(d.yards | 0) + ' yds</b><span>' + esc(driveWord(d.outcome)) + '</span>';
    fieldWrap.appendChild(el);
    var wait = d.outcome === 'td' ? 2500 : 700;
    setTimeout(function () { el.classList.add('on'); }, wait);
    setTimeout(function () { el.classList.add('out'); }, wait + 2600);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, wait + 3100);
  }
  /* ── WHAT THE CALL WAS WORTH ─────────────────────────────────────────────
     Said on the dead ball, and only when the process and the result have
     something to argue about — a good read that lost, or a poor one that
     came off. A call that was sound and worked needs no lecture. */
  var readSaid = 0;
  function readBit(e) {
    if (!RD || !e || !e.grade) return;
    var v = RD.verdict(e.grade, e.result);
    if (!v) return;
    if (v.key === 'both' || v.key === 'neither') return;
    if (readSaid >= 4) return;
    readSaid++;
    var good = v.key === 'process';
    var old = fieldWrap.querySelector('.bit');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var d = document.createElement('div');
    d.className = 'bit bit-read';
    d.style.setProperty('--bc', good ? '#3fb883' : '#f2c744');
    /* ── THE TWO NUMBERS, SIDE BY SIDE (read_v1 × rush_v1) ──────────────
       The whole point of grading the process apart from the result is lost
       if the panel only ever prints one of them. It now prints both, and
       the result in the unit the player actually watched happen — YARDS,
       not the hundred-point score behind it — because "GOOD READ, and it
       lost two" is the sentence this system exists to be able to say, and
       it is a sentence the run game could not produce at all until a carry
       was allowed to go backwards.

       And when the front is what beat him, it says so: a sound call that
       met a defender in the backfield is not a bad call, and a player who
       is told which of the two happened learns something. */
    var yd = e.yards | 0;
    var got = yd === 0 ? 'no gain' : (yd > 0 ? '+' + yd : String(yd)) + (Math.abs(yd) === 1 ? ' yard' : ' yards');
    var why = v.line;
    var rush = e.rush || null;
    if (good && rush && rush.stuffed) {
      why = rush.backfield_contact
        ? 'They were in the backfield before the handoff. The front won it, not the call.'
        : 'The look was right. The front simply won the line.';
    } else if (good && rush && rush.explosive) {
      why = v.line;
    }
    d.innerHTML = '<i>Research IQ</i><b>' + esc(v.head) + '</b>'
      + '<span class="bit-two"><em>Process</em><b>' + esc(e.grade.total) + '</b>'
      + '<em>Result</em><b>' + esc(got) + '</b></span>'
      + '<br>' + esc(why);
    fieldWrap.appendChild(d);
    setTimeout(function () { d.classList.add('out'); }, 2800);
    setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 3200);
    if (GM && GM.track) GM.track('research_read', { total: e.grade.total, band: e.grade.band, result: e.result, verdict: v.key, iq: e.grade.iq });
  }
  /* the round number a man of yours is closing on tonight, if he is close */
  function needsBit(off) {
    if (off !== me || !game) return null;
    var found = null;
    Object.keys(game.players || {}).some(function (k) {
      var m = game.players[k];
      if (m.side !== me || (!m.career && !m.live)) return false;
      var c = m.career || {}, l = m.live || {};
      var tonight = m.position === 'QB' ? (m.py | 0) : m.position === 'RB' ? (m.ry | 0) : (m.position === 'WR' || m.position === 'TE') ? (m.recy | 0) : 0;
      if (tonight < 20) return false;
      var total = (c.yds | 0) + (l.yds | 0) + tonight, nr = nextRound(total);
      if (!nr || nr.left > 60 || milestoned[k + ':needs:' + nr.at]) return false;
      milestoned[k + ':needs:' + nr.at] = 1;
      found = { eyebrow: (m.acq === 'pack' ? 'From the Vault · ' : '') + m.position, text: '<b>' + esc(m.name) + '</b><br>needs ' + esc(nr.left) + ' for ' + esc(nr.at.toLocaleString()) + ' career yards in your hands' };
      return true;
    });
    return found;
  }
  function broadcastBit(p) {
    if (!game || !p || p.touchdown || p.turnover || p.sack || (p.yards | 0) >= 30) return;
    bitCount++;
    if (bitCount % 4 !== 0) return;
    var sit = G.situation(game), off = snapSit ? snapSit.offense : sit.offense;
    var st = game.stats[off] || {}, drive = game.drive, text = null, eyebrow = null;
    var tries = 0;
    while (!text && tries++ < 7) {
      var pick = (bitTurn++) % 7;
      if (pick === 4) {
        var ms = milestoneBit(off);
        if (ms) { eyebrow = ms.eyebrow; text = ms.text; }
      } else if (pick === 5) {
        var nb = needsBit(off);
        if (nb) { eyebrow = nb.eyebrow; text = nb.text; }
      } else if (pick === 6) {
        /* the season, once a game, and only what is true */
        if (!saidContext) {
          var sc = seasonContext();
          if (sc.snap && sc.snap.season && sc.snap.season.label) { saidContext = true; eyebrow = esc(teams.me.abbr) + ' · ' + esc(sc.snap.season.label); text = '<b>' + esc((sc.snap.season.wins | 0) + '–' + (sc.snap.season.losses | 0)) + ' this season</b>' + (sc.snap.reputation && sc.snap.reputation.rank ? '<br>rank ' + esc(sc.snap.reputation.rank) : ''); }
        }
      } else if (pick === 0) {
        var best = null, bestV = 0;
        Object.keys(game.players || {}).forEach(function (k) {
          var m = game.players[k];
          if (m.side !== off) return;
          var v = (m.py || 0) * 0.55 + (m.ry || 0) + (m.recy || 0) + (m.tkl || 0) * 4 + (m.sack || 0) * 25;
          if (v > bestV) { bestV = v; best = m; }
        });
        if (best && bestV >= 45) {
          /* a man who came out of the Vault is announced as one */
          eyebrow = (best.acq === 'pack' && off === me ? 'From the Vault' : (off === me ? teams.me.abbr : teams.opp.abbr)) + ' · ' + best.position;
          text = '<b>' + esc(best.name) + '</b><br>' + esc(dayLine(best));
        }
      } else if (pick === 1) {
        if (drive && drive.side === off && (drive.plays | 0) >= 3) { eyebrow = 'This drive'; text = '<b>' + drive.plays + ' plays, ' + (drive.yards | 0) + ' yards</b>'; }
      } else if (pick === 2) {
        if ((st.thirdAtt | 0) >= 3) { eyebrow = 'Third down'; text = '<b>' + (st.thirdConv | 0) + ' of ' + st.thirdAtt + '</b> today'; }
      } else {
        var box = G.boxScore(game), mine = box[me], theirs = box[G.other(me)];
        if ((mine.yards | 0) + (theirs.yards | 0) >= 120) { eyebrow = 'Total yards'; text = '<b>' + esc(teams.me.abbr) + ' ' + (mine.yards | 0) + '</b> · ' + esc(teams.opp.abbr) + ' ' + (theirs.yards | 0); }
      }
    }
    if (!text) return;
    var old = fieldWrap.querySelector('.bit');
    if (old) old.parentNode.removeChild(old);
    var d = document.createElement('div');
    d.className = 'bit';
    d.style.setProperty('--bc', kitFor(off === me ? 'me' : 'opp').primary || '#f2c744');
    d.innerHTML = '<i>' + esc(eyebrow) + '</i>' + text;
    fieldWrap.appendChild(d);
    setTimeout(function () { d.classList.add('out'); }, 2600);
    setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 3000);
  }
  /* A MILESTONE, CALLED ONCE. The careers your men carry — the simulation's
     and the one in your hands — plus tonight's line: when tonight takes a
     man across a round number the broadcast says so, once. Only your side
     has careers, so only your side is ever called. */
  var MILESTONES = { yds: [500, 1000, 2500, 5000, 10000], td: [5, 10, 25, 50], tkl: [50, 100, 250, 500] };
  function milestoneBit(off) {
    if (off !== me || !game) return null;
    var found = null;
    Object.keys(game.players || {}).some(function (k) {
      var m = game.players[k];
      if (m.side !== me || (!m.career && !m.live)) return false;
      var c = m.career || {}, l = m.live || {};
      var before = {}, tonight = {};
      if (m.position === 'QB') { before.yds = (c.yds | 0) + (l.yds | 0); tonight.yds = m.py | 0; before.td = (c.td | 0) + (l.td | 0); tonight.td = m.ptd | 0; }
      else if (m.position === 'RB') { before.yds = (c.yds | 0) + (l.yds | 0); tonight.yds = m.ry | 0; before.td = (c.td | 0) + (l.td | 0); tonight.td = m.rtd | 0; }
      else if (m.position === 'WR' || m.position === 'TE') { before.yds = (c.yds | 0) + (l.yds | 0); tonight.yds = m.recy | 0; before.td = (c.td | 0) + (l.td | 0); tonight.td = m.rectd | 0; }
      else { before.tkl = (c.tkl | 0) + (l.tkl | 0); tonight.tkl = m.tkl | 0; }
      return Object.keys(before).some(function (stat) {
        return MILESTONES[stat].some(function (line) {
          var key = k + ':' + stat + ':' + line;
          if (milestoned[key] || before[stat] >= line || before[stat] + tonight[stat] < line) return false;
          milestoned[key] = 1;
          found = { eyebrow: (m.acq === 'pack' ? 'Milestone · From the Vault' : 'Milestone'),
            text: '<b>' + esc(m.name) + '</b><br>' + esc(line.toLocaleString() + ' career ' + (stat === 'yds' ? 'yards' : stat === 'td' ? 'touchdowns' : 'tackles') + ' · in your hands') };
          return true;
        });
      });
    });
    return found;
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
    if (p.turnover === 'fumble') return 'Fumble return';
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
    /* PLAIN FOOTBALL ENGLISH. "-2-yard rush" is a spreadsheet cell; a run that
       lost two yards lost two yards, and no gain is no gain. */
    var y = p.yards == null ? 0 : p.yards;
    if (p.sack && p.turnover === 'fumble') line = 'Sacked, and the ball came out';
    else if (p.sack) line = 'Sacked for ' + Math.abs(y);
    else if (p.turnover === 'interception') line = 'Intercepted' + (p.returnYards ? ', returned ' + p.returnYards : '');
    else if (p.turnover === 'fumble') line = 'Fumble' + (y > 0 ? ' after ' + y : '');
    else if (p.incomplete) line = 'Incomplete';
    else if (y < 0) line = 'Lost ' + Math.abs(y) + (p.completion ? ' on the catch' : ' on the ground');
    else if (y === 0) line = 'No gain';
    else if (p.completion) line = y + '-yard catch';
    else line = y + '-yard rush';
    /* ── THE REASON, AND THE MOST SPECIFIC ONE AVAILABLE ──────────────────
       "They had eight in the box" is true of the whole defence; "Wexler held
       the point" is true of the block the run went behind, and it is the one
       a player can do something with next time. Play Mode knows it because
       twenty-two men actually blocked each other, so when it is there it
       wins. */
    var why = '';
    var block = null;
    (p.notes || []).forEach(function (n) {
      if (/held the point|beat the block|came free|beat |blew up the pull|bounce it|broke one in the backfield/.test(n)) block = n;
    });
    if (block) why = block;
    else {
      var c = String(p.commentary || '');
      var cut = c.indexOf(' — ');
      if (cut > 0) why = c.slice(cut + 3);
      else if (p.notes && p.notes.length) why = p.notes[p.notes.length - 1];
    }
    /* ── A STOPPED RUN IS A DEFENSIVE PLAY, AND IT SHOULD READ LIKE ONE ──
       A run that loses a yard used to come up in the same green as one that
       gained eight, with the same shrug of a caption. The whole point of
       giving the front a way into the backfield is that the other side did
       something; the card says so, once, in their colour. */
    var rush = p.rush || null;
    var stuffed = !!(rush && rush.stuffed && !p.completion);
    var d = document.createElement('div');
    d.className = 'res' + (p.big ? ' res-big' : '') + (stuffed ? ' res-stuff' : '');
    d.innerHTML = (who ? '<b>' + esc(who) + '</b>' : '')
      + '<span>' + esc(line) + '</span>'
      + (why ? '<i>' + esc(why.replace(/^[a-z]/, function (m) { return m.toUpperCase(); })) + '</i>' : '')
      + (stuffed ? '<em>' + (rush.tfl ? 'Stuffed · ' + rush.yards + ' yards' : 'Stuffed · no gain') + '</em>'
         : p.big ? '<em>Explosive play</em>' : '');
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
    /* one sequence at a time: a second tap on the button must not leave two
       of them running their own timers over the same field */
    if (kickSkip) { kickSkip(); return; }
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
    flow('QUARTER_END', name);
    SOUND.whistle();
    banner({ kind: 'good', eyebrow: 'Q' + was, head: name,
      sub: teams.me.abbr + ' ' + game.score[me] + '  \u00b7  ' + teams.opp.abbr + ' ' + game.score[G.other(me)],
      color: kitFor('me').primary, hold: 1400 });
  }
  function nextCall() {
    cancelAuto();
    if (game.over) { finalScreen(); return; }
    var sit = G.situation(game);
    paintScore();
    quarterBreak(sit);
    if (sit.phase === 'halftime') { flow('HALFTIME', 'half'); halftimeScreen(); return; }
    if (sit.phase === 'kickoff') {
      flow('KICKOFF', 'kickoff');
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
      flow('PAT', 'try');
      /* the engine clears the pending score the moment the try is taken, and
         a redraw can land on the far side of that; treat a missing one as
         theirs and offer the button that just moves the game on */
      var mine = !!game.pendingScore && game.pendingScore.side === me;
      shotWide(false);
      /* ── AND THE CAMERA COMES BACK OUT OF THE END ZONE ─────────────────
         The lens followed the score in, which is right — and then the try
         was offered over a picture still framed on the back of the end zone
         with half the screen off the side of the field. The try has its own
         formation; show it. */
      patLook(mine);
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
    flow('PLAY_SELECT', 'call sheet');
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
    /* THE ELEVEN WHO ARE JUST STANDING THERE. Between calls the field is not
       empty — it holds the look the page guesses you will see — but that
       formation is a picture and must never be snappable, whatever asks. */
    stage.lineUp({ play: guess.key, formation: gf, def: 'base_3', los: sit.ball, preview: true,
      firstDown: Math.min(100, sit.ball + sit.toGo), ballX: ballX, strong: 0,
      env: G.prepare({ off: G.teamOf(game, sit.offense), def: G.teamOf(game, sit.defense),
        rand: game.aiRand || game.rand, tick: game.tick, playKey: guess.key, formKey: gf,
        defCall: 'base_3', sit: sit, mem: game.mem[sit.offense], weather: game.weather }),
      rand: game.rand,
      offUnits: G.unitsOf(G.teamOf(game, sit.offense), game.tick),
      defUnits: G.unitsOf(G.teamOf(game, sit.defense), game.tick) });
    readEl.hidden = true;
  }
  /* THE TRY, LINED UP. A picture of the eleven who are about to take it,
     from the same lens as every other snap. It is a preview — nothing here
     can be snapped, and the engine settles the try when the button is
     pressed exactly as it always did. */
  function patLook(mine) {
    if (!stage || !stage.lineUp) return;
    var sit = G.situation(game);
    var off = sit.offense, def = sit.defense;
    var los = 85;                             /* the fifteen: a thirty-three yard kick */
    var offT = G.teamOf(game, off), defT = G.teamOf(game, def);
    var play = F.play('power') || F.play('inside_zone');
    var form = (F.playForms(play.key, offT.offense) || [])[0] || play.forms[0];
    stage.setUserSide(off === me ? 'off' : 'def');
    stage.setArt(false);
    stage.teams(kitFor(off === me ? 'me' : 'opp'), kitFor(off === me ? 'opp' : 'me'),
      (off === me ? teams.me : teams.opp).name, (off === me ? teams.opp : teams.me).name,
      off !== me);
    try {
      stage.lineUp({ play: play.key, formation: form, def: 'goal_line_d', los: los, preview: true,
        firstDown: null, ballX: PT.FIELD.half, strong: 0,
        env: G.prepare({ off: offT, def: defT, rand: game.aiRand || game.rand, tick: game.tick,
          playKey: play.key, formKey: form, defCall: 'goal_line_d', sit: sit,
          mem: game.mem[off], weather: game.weather }),
        rand: game.rand,
        offUnits: G.unitsOf(offT, game.tick), defUnits: G.unitsOf(defT, game.tick) });
    } catch (_) {}
    readEl.hidden = true;
    ballX = PT.FIELD.half;
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

  /* ── A STAGED CARD, ONE THING AT A TIME ─────────────────────────────────
     Halftime and the final are told in beats: one card on the screen, a dot
     for each, a tap or a moment moves to the next, Skip goes straight to the
     end. Every card reads the books the engine already wrote; nothing here
     decides anything. The whole run is bounded: a viewer who does nothing is
     through halftime in under twenty seconds. */
  var stagedTimer = null;
  var stagedActive = null;
  function stagedOverlay(o) {
    var stages = (o.stages || []).filter(Boolean), i = 0, done = false;
    /* ONE SEQUENCE AT A TIME. Two of these interleaving on one shared timer
       showed the same beat twice and skipped another; a new sequence cancels
       whatever was running, without playing its ending. */
    if (stagedActive) stagedActive.cancel();
    var self = { cancel: function () { done = true; stop(); if (stagedActive === self) stagedActive = null; } };
    stagedActive = self;
    function stop() { if (stagedTimer) { clearTimeout(stagedTimer); stagedTimer = null; } }
    function finish() { if (done) return; done = true; stop(); if (stagedActive === self) stagedActive = null; if (o.onDone) o.onDone(); }
    function next() { if (done) return; stop(); i++; show(); }
    function show() {
      if (done) return;
      if (i >= stages.length) { finish(); return; }
      var st = stages[i];
      overlay('<div class="stg' + (st.cls ? ' ' + st.cls : '') + '">'
        + '<div class="stg-top"><span class="stg-brand">' + esc(o.brand || 'EdgeDesk') + '</span>'
        + '<span class="stg-dots" aria-hidden="true">' + stages.map(function (_, k) { return '<i class="' + (k < i ? 'was' : k === i ? 'on' : '') + '"></i>'; }).join('') + '</span>'
        + '<button class="stg-skip" type="button" id="stgSkip">' + esc(o.skipLabel || 'Skip') + '</button></div>'
        + (st.eyebrow ? '<div class="stg-eyebrow">' + esc(st.eyebrow) + '</div>' : '')
        + '<div class="stg-body">' + st.html + '</div>'
        + '<div class="stg-foot">' + esc(i < stages.length - 1 ? 'Tap to continue' : (o.lastHint || 'Tap to continue')) + '</div>'
        + '</div>', true);
      var ov = $('ov');
      if (ov) ov.onclick = function (e) { if (e.target && e.target.closest && e.target.closest('a,button')) return; next(); };
      var sk = $('stgSkip');
      if (sk) sk.onclick = function (e) { e.stopPropagation(); finish(); };
      if (o.onStage) { try { o.onStage(st, i); } catch (err) { if (window.console) console.warn('stage', err); } }
      if (st.ms && set.speed !== 'instant') stagedTimer = setTimeout(next, st.ms);
    }
    show();
    self.next = next; self.finish = finish;
    return self;
  }
  /* WHAT THE BROADCAST KNOWS ABOUT THE SEASON, and only what is true: the
     franchise's record and rank from its own snapshot, the record on this
     device from the games played here. Nothing is invented to fill a line. */
  function seasonContext() {
    var snap = null; try { snap = FR && FR.snapshot ? FR.snapshot() : null; } catch (_) {}
    var out = { lines: [], snap: snap };
    if (snap && snap.franchise) {
      var ss = snap.season || {}, rep = snap.reputation || {};
      if (ss.label) out.lines.push(esc(ss.label) + ' · ' + esc((ss.wins | 0) + '–' + (ss.losses | 0)) + (ss.week ? ' · week ' + esc(ss.week) : ''));
      if (rep.rank) out.lines.push('Rank ' + esc(rep.rank) + (rep.to_next ? ' · ' + esc(rep.to_next) + ' to the next' : ''));
      if (snap.next_game && snap.next_game.opponent) out.lines.push('Saturday: ' + esc(FR.matchupLine ? FR.matchupLine(snap.next_game) : ''));
    }
    var rec = null; try { rec = S.readRecord ? S.readRecord() : null; } catch (_) {}
    if (rec && rec.games) out.lines.push(esc(S.recordLine(rec)));
    return out;
  }
  function seasonContextHtml() {
    var c = seasonContext();
    return c.lines.length ? '<div class="stg-ctx">' + c.lines.map(function (l) { return '<span>' + l + '</span>'; }).join('') + '</div>' : '';
  }

  /* ── EDGEDESK HALFTIME ──────────────────────────────────────────────────
     Five beats — the score, the numbers, the men, the biggest play, the one
     thing — then the adjustment, which is the decision the half is for. A
     viewer who does nothing is at the decision in seventeen seconds. */
  function halftimeScreen() {
    shotWide(true);
    var box = G.boxScore(game), mine = box[me], theirs = box[G.other(me)];
    var tp = S.turningPoint(game);
    var stages = [
      { eyebrow: 'Halftime', ms: 3000, html: scoreHead('HT') + seasonContextHtml() },
      { eyebrow: 'Team stats', ms: 4200, html: compare([['Total yards', mine.yards, theirs.yards],
          ['Rushing', mine.rushYards, theirs.rushYards, mine.rushYards + ' (' + mine.ypc + ')', theirs.rushYards + ' (' + theirs.ypc + ')'],
          ['Passing', mine.passYards, theirs.passYards, mine.comp + '/' + mine.att + ' · ' + mine.passYards, theirs.comp + '/' + theirs.att + ' · ' + theirs.passYards],
          ['Explosive plays', mine.explosive, theirs.explosive], ['Sacks', mine.sacks, theirs.sacks], ['Turnovers', mine.turnovers, theirs.turnovers]])
          + '<div class="cmp-note">Yards per play ' + esc(mine.ypp) + ' — ' + esc(theirs.ypp) + ' · Third down ' + esc(mine.third) + ' — ' + esc(theirs.third) + '</div>' },
      { eyebrow: 'Top performers', ms: 3800, html: leaderStrip(box, true) || '<div class="muted">Nobody has separated himself yet.</div>' },
      tp ? { eyebrow: 'Biggest play so far', ms: 3000, html: '<div class="stg-big"><i>Q' + esc(tp.q) + '</i>' + esc(tp.text) + '</div>' } : null,
      { eyebrow: 'One thing', ms: 3200, html: takeaway() || '<div class="muted">Nothing is deciding it yet.</div>' }
    ];
    if (GM && GM.track) GM.track('gridiron_halftime', { score_for: game.score[me], score_against: game.score[G.other(me)] });
    stagedOverlay({ brand: 'EdgeDesk Halftime', stages: stages, skipLabel: 'Skip to the adjustment', onDone: halftimeAdjust });
  }
  function halftimeAdjust() {
    var box = G.boxScore(game), mine = box[me], theirs = box[G.other(me)];
    overlay('<div class="eyebrow">EdgeDesk Halftime</div>' + scoreHead('HT')
      + takeaway()
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
  function leaderStrip(box, bare) {
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
    return (bare ? '' : '<h3>Who is doing it</h3>') + '<div class="ldr">'
      + '<div class="ldr-h"><span class="lk"></span><span class="la">' + esc(teams.me.abbr)
      + '</span><span class="lb">' + esc(teams.opp.abbr) + '</span></div>' + out + '</div>';
  }

  /* ── THE FINAL, IN BEATS ────────────────────────────────────────────────
     FINAL · player of the game · team stats · the turning point · research
     · your franchise (what the server credited) · the season — one card at a
     time, skippable, and then the whole recap with the four doors out. The
     filing with the franchise starts the moment the game ends, so by the time
     its card comes round the answer is usually there. */
  var finalShownFor = null;
  function finalScreen() {
    /* THE FINAL IS SHOWN ONCE PER GAME. Two roads lead here — the last play
       and a resumed record that was already over — and both arriving started
       two broadcasts on top of each other. */
    var fk = game && game.meta ? String(game.meta.seed) + ':' + (game.meta.startedAt || 0) : null;
    if (fk && finalShownFor === fk) return;
    finalShownFor = fk;
    flow('GAME_OVER', 'final');
    S.clearSave();
    /* the last thing the game shows is the place it was played in */
    shotWide(true);
    crowdUp(0.55, 0.45);
    /* the loop is about to stop, so re-frame once by hand or the last frame
       on the screen is the one from the play that ended the game */
    if (stage) { stage.stop(); if (stage.resize) stage.resize(); }
    startFiling();
    var box = G.boxScore(game), them = G.other(me), mine = box[me], theirs = box[them];
    var won = game.score[me] > game.score[them], level = game.score[me] === game.score[them];
    var tp = S.turningPoint(game), potg = G.playerOfGame(game);
    var rec = S.fileResult(game, me);
    var matchup = S.keyMatchup(game, me), coaching = S.coachingImpact(game, me);
    var ctx = seasonContext();
    if (won) { SOUND.td(); buzz('strong'); crowdUp(1, 0.5); }
    var heroHtml = '<div class="fin-hero' + (won ? ' win' : level ? ' level' : ' loss') + '" style="--tc:' + esc(kitFor('me').primary || '#3fb883') + '">'
      + (won ? '<span class="fin-glow"></span>' : '')
      + '<div class="fin-tag">Final' + (game.ot ? ' \u00b7 OT' : '') + '</div>'
      + '<div class="fin-word">' + (won ? 'WIN' : level ? 'TIE' : 'LOSS') + '</div>'
      + '<div class="fin-line">' + esc(title(teams.me)) + ' ' + game.score[me] + ' \u00b7 ' + esc(title(teams.opp)) + ' ' + game.score[them] + '</div>'
      + (rec && rec.games ? '<div class="fin-rec">Record <b>' + esc(rec.w + '\u2013' + rec.l + (rec.t ? '\u2013' + rec.t : '')) + '</b>' + (game.ot ? ' \u00b7 after overtime' : '') + '</div>' : '')
      + '</div>';
    var potgHtml = potg ? '<div class="potg big"><div><div class="pn">' + esc(potg.position + ' ' + potg.name)
        + '<span class="pt">' + esc(potg.side === me ? teams.me.abbr : teams.opp.abbr) + '</span></div>'
        + '<div class="pl">' + esc(statLine(potg)) + '</div>' + careerContext(potg) + '</div></div>' : '';
    var prep = ctx.snap && FR.prep ? FR.prep(ctx.snap.week || {}) : null;
    var rep = RD ? RD.report(READS) : null;
    var researchHtml = (rep ? researchReport(rep) : '')
      + (matchup ? '<div class="stg-kv"><span>Key matchup</span>' + esc(matchup) + '</div>' : '')
      + (coaching ? '<div class="stg-kv"><span>Coaching</span>' + esc(coaching) + '</div>' : '')
      + (prep && prep.preparation != null ? '<div class="stg-kv"><span>Preparation</span>' + esc(prep.preparation | 0) + '% this week — the Price Its, drills and film that set the team up</div>' : '');
    var stages = [
      { eyebrow: 'Final', ms: 3200, cls: won ? 'win' : '', html: heroHtml + seasonContextHtml() },
      potg ? { eyebrow: 'Player of the game', ms: 3600, html: potgHtml } : null,
      { eyebrow: 'Team stats', ms: 4200, html: compare([['Total yards', mine.yards, theirs.yards],
          ['Rushing', mine.rushYards, theirs.rushYards, mine.rushYards + ' (' + mine.ypc + ')', theirs.rushYards + ' (' + theirs.ypc + ')'],
          ['Passing', mine.passYards, theirs.passYards, mine.comp + '/' + mine.att + ' · ' + mine.passYards, theirs.comp + '/' + theirs.att + ' · ' + theirs.passYards],
          ['First downs', mine.firstDowns, theirs.firstDowns], ['Explosive plays', mine.explosive, theirs.explosive], ['Turnovers', mine.turnovers, theirs.turnovers]]) },
      tp ? { eyebrow: 'The turning point', ms: 3200, html: '<div class="stg-big"><i>Q' + esc(tp.q) + '</i>' + esc(tp.text) + '</div>' } : null,
      researchHtml ? { eyebrow: 'Research performance', ms: 3400, html: researchHtml } : null,
      (FR && FR.hasFranchise && FR.hasFranchise()) ? { eyebrow: 'Your franchise', ms: 4600, key: 'franchise', html: '<div id="frStage" class="fr-panel"><div class="muted">Filing the result…</div></div>' } : null,
      (FR && FR.hasFranchise && FR.hasFranchise()) ? { eyebrow: 'The season', ms: 3400, html: seasonImpactHtml(ctx, won) } : null
    ];
    stagedOverlay({ brand: 'EdgeDesk Football', stages: stages, skipLabel: 'Skip to the recap', lastHint: 'Tap for the full recap',
      onStage: function (st) { if (st.key === 'franchise') paintFilingInto('frStage'); },
      onDone: finalRecap });
    if (GM && GM.track) GM.track('gridiron_game_finished', { won: won, score_for: game.score[me],
      score_against: game.score[them], difficulty: set.difficulty, mode: set.mode, plays: game.plays.length });
  }
  /* THE MAN'S CAREER IN YOUR HANDS, under his night: only for your men, only
     what the card carries, and the next round number if it is close */
  function careerContext(st) {
    if (!st || st.side !== me) return '';
    var c = st.career || {}, l = st.live || {}, out = [];
    var gp = (c.games | 0) + (l.games | 0) + 1;
    var yds = (c.yds | 0) + (l.yds | 0) + (st.position === 'QB' ? (st.py | 0) : st.position === 'RB' ? (st.ry | 0) : (st.recy | 0));
    if (gp > 1) out.push(esc(gp) + ' games');
    if (yds > 0) out.push(esc(yds.toLocaleString()) + ' career yards');
    var need = nextRound(yds);
    if (need && need.left <= 150) out.push('needs ' + esc(need.left) + ' for ' + esc(need.at.toLocaleString()));
    if (st.acq === 'pack') out.push('from the Vault');
    return out.length ? '<div class="pc-ctx">' + out.join(' · ') + '</div>' : '';
  }
  function nextRound(v) {
    var marks = [500, 1000, 2500, 5000, 10000], i;
    for (i = 0; i < marks.length; i++) if (v < marks[i]) return { at: marks[i], left: marks[i] - v };
    return null;
  }
  /* ── THE RESEARCH REPORT ─────────────────────────────────────────────────
     Two numbers, side by side, because they are two different things: what
     the calls were worth, and what they returned. The best read of the night
     is not necessarily the play that gained the most. */
  function researchReport(r) {
    if (!r || !r.calls) return '';
    var gap = r.divergence == null ? null : r.divergence;
    var line = gap == null ? ''
      : gap >= 8 ? 'You out-coached the scoreboard: the calls were better than the results.'
      : gap <= -8 ? 'The results flattered the calls tonight.'
      : 'Process and result agreed tonight.';
    return '<div class="rq">'
      + '<div class="rq-two"><div><span>Process score</span><b>' + esc(r.process) + '</b><i>' + esc(r.calls) + ' calls graded</i></div>'
      + '<div><span>Result score</span><b>' + esc(r.result) + '</b><i>' + esc(r.good_reads) + ' good reads</i></div></div>'
      + (line ? '<div class="rq-line">' + esc(line) + '</div>' : '')
      + '<div class="rq-r"><span class="k up">Best read</span><b>' + esc(r.best.text) + '</b>'
      + '<i>' + esc(r.best.label) + ' · ' + esc(r.best.total) + ' · ' + esc(r.best.note) + '</i></div>'
      + (r.worst.total < r.best.total
          ? '<div class="rq-r"><span class="k dn">Worst read</span><b>' + esc(r.worst.text) + '</b>'
            + '<i>' + esc(r.worst.label) + ' · ' + esc(r.worst.total) + ' · ' + esc(r.worst.note) + '</i></div>' : '')
      + '<div class="rq-bars">'
      + rqBar('Matchup recognition', r.matchup) + rqBar('Situational football', r.situational)
      + rqBar('Personnel', r.personnel) + rqBar('Risk', r.risk) + rqBar('Independence', r.independence)
      + '</div>'
      + '<div class="stg-kv"><span>Research IQ</span>+' + esc(r.iq) + ' from the process, whatever the scoreboard did</div>'
      + '</div>';
  }
  function rqBar(name, v) {
    v = Math.max(0, Math.min(100, v | 0));
    return '<div class="rq-b"><span>' + esc(name) + '</span><i><u style="width:' + v + '%"></u></i><b>' + esc(v) + '</b></div>';
  }
  /* WHAT TONIGHT DID TO THE SEASON — the franchise's own record and rank from
     its snapshot, the next fixture, and the live record on this device */
  function seasonImpactHtml(ctx, won) {
    var snap = ctx.snap, html = '';
    if (snap && snap.season) {
      var ss = snap.season;
      html += '<div class="stg-kv"><span>' + esc(ss.label || 'The season') + '</span>' + esc((ss.wins | 0) + '–' + (ss.losses | 0)) + ' · week ' + esc(ss.week | 0) + ' of ' + esc(ss.weeks | 0)
        + '<br><small>Saturday\'s game is the one on the record; tonight was yours to play.</small></div>';
    }
    if (snap && snap.next_game && snap.next_game.opponent) html += '<div class="stg-kv"><span>Saturday</span>' + esc(FR.matchupLine(snap.next_game)) + '</div>';
    if (snap && snap.reputation) html += '<div class="stg-kv"><span>Rank</span>' + esc(snap.reputation.rank | 0) + ' · ' + esc(snap.reputation.to_next | 0) + ' to the next · a Gridiron Cache at every rank</div>';
    return html || '<div class="muted">Found a franchise and the season starts counting.</div>';
  }
  /* ── THE RECAP ────────────────────────────────────────────────────────── */
  function finalRecap() {
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
    overlay(hero + scoreHead(game.ot ? 'OT' : 'FT')
      + compare([['Total yards', mine.yards, theirs.yards],
        ['Rushing', mine.rushYards, theirs.rushYards,
          mine.rushYards + ' (' + mine.ypc + ')', theirs.rushYards + ' (' + theirs.ypc + ')'],
        /* ── WHO WON THE LINE (rush_v1) ────────────────────────────────
           Rushing yards alone cannot tell you whether four a carry was a
           line handing him four clean or a back taking them off people.
           Three rows say it: how far he got before anyone touched him,
           how far after, and how often the front simply won. Compared on
           the stuff count INVERTED, because the side with fewer carries
           stopped is the side that won that row. */
        ['Before contact', mine.rushYBC, theirs.rushYBC,
          mine.rushYBC + ' (' + mine.ybcPerCarry + ')', theirs.rushYBC + ' (' + theirs.ybcPerCarry + ')'],
        ['After contact', mine.rushYAC, theirs.rushYAC,
          mine.rushYAC + ' (' + mine.yacPerCarry + ')', theirs.rushYAC + ' (' + theirs.yacPerCarry + ')'],
        ['Runs stopped', theirs.stuffedRuns, mine.stuffedRuns,
          mine.stuffedRuns + ' (' + mine.stuffRate + '%)', theirs.stuffedRuns + ' (' + theirs.stuffRate + '%)'],
        ['Tackles for loss', mine.tacklesForLoss, theirs.tacklesForLoss],
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
      + '<div id="frPanel" class="fr-panel" hidden></div>'
      + '<h3>Where next</h3><div class="fin-acts">'
      + '<button class="btn btn-go" id="btnAgain" type="button"><b>Next game</b><i>Play again</i></button>'
      + '<a class="btn" href="/games/gameday/"><b>Game Day</b><i>Saturday\'s fixture</i></a>'
      + '<a class="btn" href="/games/roster/"><b>Team</b><i>Lineup and chemistry</i></a>'
      + '<a class="btn" href="/games/packs/"><b>Pack Vault</b><i>What the games earned</i></a>'
      + '<a class="btn" href="' + esc(GM && GM.withAttribution ? GM.withAttribution('/app.html') : '/app.html') + '#research/football"><b>Research</b><i>The real games</i></a>'
      + '</div>', true);
    $('btnAgain').onclick = function () { closeOverlay(); newGame(); };
    paintFilingInto('frPanel');
  }
  /* ── THE GAME YOU HOLD COUNTS ─────────────────────────────────────────
     A finished game is filed with the franchise under its own key — the
     seed and the moment it started — with the score, the yards, the
     touchdowns, the tier the defence was set to, and every man of yours with
     his line in the keys his career already uses. The server checks the
     shape, credits once by its table, weighs it toward the rank, and seals a
     Game Day pack every fifth game at Pro or harder. The panel shows what
     the server said, never what the page hoped. */
  function livePayload() {
    var them = G.other(me), st = game.stats[me] || {}, box = G.boxScore(game), mine = box[me] || {};
    var men = [], seen = {};
    Object.keys(game.players || {}).forEach(function (k) {
      var m = game.players[k];
      if (m.side !== me || !m.uid) return;
      var line = FR.liveLine(m.position, m);
      if (line) { men.push({ id: m.uid, stats: line }); seen[m.uid] = 1; }
    });
    /* the men who started and never touched the ball still played the game */
    ((teams.me && teams.me.players) || []).forEach(function (p) {
      if (!p || !p.id || seen[p.id]) return;
      if ((p.depth | 0) >= 1 && (p.depth | 0) <= (FR.STARTERS[p.position] || 1) && p.status === 'active') men.push({ id: String(p.id), stats: { games: 1 } });
    });
    return { difficulty: set.difficulty, length: set.length, score_for: game.score[me] | 0, score_against: game.score[them] | 0,
      plays: game.plays.length, yards: mine.yards | 0, touchdowns: (st.passTD | 0) + (st.rushTD | 0) + (st.defTD | 0),
      turnovers: (st.ints | 0) + (st.fumblesLost | 0), opponent: title(teams.opp), players: men.slice(0, 60) };
  }
  var FILING = null;
  function startFiling() {
    if (!FR || !FR.recordLiveGame || !FR.hasFranchise || !FR.hasFranchise() || !game || !game.meta) return null;
    var key = String(game.meta.seed) + ':' + (game.meta.startedAt || 0);
    if (FILING && FILING.key === key) return FILING;
    var payload = livePayload();
    FILING = { key: key, payload: payload, est: FR.liveRewards(payload), result: null, done: false };
    FILING.promise = FR.recordLiveGame(key, payload).then(function (r) { FILING.result = r; FILING.done = true; return r; },
      function () { FILING.result = { ok: false }; FILING.done = true; return FILING.result; });
    return FILING;
  }
  function paintFilingInto(id) {
    var panel = $(id), f = startFiling();
    if (!panel) return;
    if (!f) { panel.hidden = true; return; }
    panel.hidden = false;
    if (f.done) { paintFranchisePanel(f.result, f.payload, id); return; }
    panel.innerHTML = '<h3>Your franchise</h3><div class="muted">Filing the result… a game like this is worth about '
      + esc(f.est.xp) + ' XP and ' + esc(f.est.tc) + ' Credits at ' + esc(set.difficulty) + '.</div>';
    f.promise.then(function (r) { if ($(id)) paintFranchisePanel(r, f.payload, id); });
  }
  function paintFranchisePanel(r, payload, id) {
    var panel = $(id || 'frPanel');
    if (!panel) return;
    /* on its own beat the eyebrow already says whose panel this is */
    var html = id === 'frStage' ? '' : '<h3>Your franchise</h3>';
    if (r && r.ok && r.data) {
      var d = r.data, rank = d.rank || {}, gd = d.gameday || {};
      html += (GM && GM.rewardPanel) ? GM.rewardPanel(r) : '';
      if (d.capped) html += '<div class="muted">Today\'s ' + esc(d.gameday && d.gameday.cap || 5) + ' credited games are in. This one counts for the record and the careers, not the Credits.</div>';
      if (!d.already && !d.capped) html += '<div class="fr-line"><b>+' + esc(d.rank_gain | 0) + '</b> toward rank ' + esc((rank.rank | 0) + 1) + ' · ' + esc(rank.to_next | 0) + ' to go · a Gridiron Cache waits at every rank</div>';
      /* THE PACK THIS GAME SEALED, BY NAME. A live game can earn a Game Day
         Pack and a program pack in the same moment; naming the wrong one is
         worse than naming none. */
      if ((d.packs_new | 0) > 0) {
        var sealed = (d.packs_sealed || []).map(function (k) { return k && k.name ? k.name : null; }).filter(Boolean);
        var what = sealed.length ? (sealed.length === 1 ? 'A <b>' + esc(sealed[0]) + '</b> is sealed in the Vault.'
                                                       : esc(sealed.length) + ' packs are sealed in the Vault: <b>' + sealed.map(esc).join('</b>, <b>') + '</b>.')
                                : '<b>' + esc(d.packs_new | 0) + ' pack' + ((d.packs_new | 0) === 1 ? ' is' : 's are') + ' sealed in the Vault.</b>';
        html += '<div class="fr-pack">' + what + ' Earned by the games you played. '
          + (sealed.length > 1 ? '<a class="btn btn-go" href="/games/packs/">Open them in the Vault</a>'
                               : '<a class="btn btn-go" href="/games/packs/">Open it in the Vault</a>') + '</div>';
      }
      else if (gd.per_pack) html += '<div class="fr-line"><b>' + esc(gd.toward | 0) + ' of ' + esc(gd.per_pack) + '</b> live games at Pro or harder toward a Game Day pack'
        + (set.difficulty === 'rookie' ? ' · Rookie games count for the record, not the pack' : '') + '</div>';
      if (d.result && (d.result.men | 0) > 0) html += '<div class="fr-line"><b>' + esc(d.result.men) + '</b> of your men added tonight to the career in your hands</div>';
      var snap = null; try { snap = FR.snapshot(); } catch (_) {}
      var prep = snap && FR.prep ? FR.prep(snap.week || {}) : null;
      if (prep && prep.preparation != null) html += '<div class="fr-line">Preparation <b>' + esc(prep.preparation | 0) + '%</b> this week — the Price Its, drills and film that set the team up</div>';
    } else if (r && r.queued) {
      html += '<div class="muted">Saved here. EdgeDesk could not be reached, so this credits the next time you are online.</div>';
    } else if (r && r.skipped) {
      panel.hidden = true; return;
    } else {
      html += '<div class="muted">This game could not be filed with your franchise' + (r && r.message ? ': ' + esc(r.message) : '.') + '</div>';
    }
    panel.innerHTML = html;
    if (GM && GM.track) GM.track('gridiron_game_filed', { ok: !!(r && r.ok), already: !!(r && r.data && r.data.already), capped: !!(r && r.data && r.data.capped),
      xp: r && r.data && r.data.rewards ? r.data.rewards.xp : null, packs_new: r && r.data ? r.data.packs_new : null, difficulty: set.difficulty });
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

  /* ── THE WHOLE SCREEN ───────────────────────────────────────────
     A football game wants the phone, not a letterbox between an address bar
     and a toolbar. Where the platform has the Fullscreen API this takes it.
     Where it does not — Safari on iPhone has never shipped fullscreen for a
     web page, only for a video — it says so plainly and points at the one
     thing on that phone that genuinely does hand over the whole screen.

     The way OUT is the same control that got you in, it never moves, and it
     turns green while you are in there. Nothing here can put you anywhere
     you cannot leave with one tap. */
  var FULL = (function () {
    var self = {}, root = document.documentElement;
    function current() {
      return document.fullscreenElement || document.webkitFullscreenElement || null;
    }
    /* added to the home screen: the browser has already given up its bars */
    function standalone() {
      try {
        if (root.ownerDocument.defaultView.navigator.standalone === true) return true;
        return !!(window.matchMedia
          && window.matchMedia('(display-mode:standalone),(display-mode:fullscreen)').matches);
      } catch (_) { return false; }
    }
    self.standalone = standalone;
    self.on = function () { return !!current(); };
    self.can = function () {
      /* an iframe without allowfullscreen, and iPhone Safari, both say no —
         one with the flag, the other by never defining the method at all */
      if (document.fullscreenEnabled === false) return false;
      if (document.webkitFullscreenEnabled === false && !document.fullscreenEnabled) return false;
      return !!(root.requestFullscreen || root.webkitRequestFullscreen);
    };
    self.enter = function () {
      try {
        var p = root.requestFullscreen ? root.requestFullscreen({ navigationUI: 'hide' })
          : root.webkitRequestFullscreen ? root.webkitRequestFullscreen() : null;
        if (p && p['catch']) p['catch'](function () { fullTip(); });
      } catch (_) { fullTip(); }
    };
    self.exit = function () {
      try {
        var p = document.exitFullscreen ? document.exitFullscreen()
          : document.webkitExitFullscreen ? document.webkitExitFullscreen() : null;
        if (p && p['catch']) p['catch'](function () {});
      } catch (_) {}
    };
    return self;
  })();

  function isApple() {
    var ua = navigator.userAgent || '', pf = navigator.platform || '';
    if (/iPhone|iPad|iPod/.test(ua) || /iPhone|iPad|iPod/.test(pf)) return true;
    /* an iPad on iPadOS 13+ reports itself as a Mac; a touch count gives it away */
    return /Mac/.test(pf) && (navigator.maxTouchPoints || 0) > 1;
  }

  function toggleFull() {
    SOUND.tap();
    if (FULL.on()) { FULL.exit(); syncTools(); return; }
    if (FULL.can()) { FULL.enter(); return; }
    fullTip();
  }

  /* WHEN THE BROWSER WILL NOT DO IT, SAY SO. A button that appears to do
     nothing is worse than no button; this one tells you exactly why, and on
     an iPhone the three taps that actually work. */
  function fullTip() {
    if (FULL.standalone()) {
      overlay('<div class="eyebrow">Fullscreen</div><h2>You already have the whole screen</h2>'
        + '<p class="tip-p">Game Day is running from your Home Screen, so there are no browser bars '
        + 'left to hide.</p>'
        + '<div class="btn-row"><button class="btn btn-go" id="btnTipOk" type="button">Back to the game</button></div>');
    } else if (isApple()) {
      overlay('<div class="eyebrow">Fullscreen</div><h2>Safari keeps its bars. Your Home Screen does not.</h2>'
        + '<p class="tip-p">Safari on iPhone has never let a web page go fullscreen — only a video. '
        + 'Add Game Day to your Home Screen and it opens with no address bar and no toolbar at all: '
        + 'the whole phone, the same saved game, and it still works with no signal.</p>'
        + '<ol class="tip-steps">'
        + '<li>Tap <b>Share</b> — the square with the arrow coming out of it.</li>'
        + '<li>Scroll down to <b>Add to Home Screen</b>.</li>'
        + '<li>Open <b>Game Day</b> from your Home Screen.</li></ol>'
        + '<div class="btn-row"><button class="btn btn-go" id="btnTipOk" type="button">Got it</button></div>');
    } else {
      overlay('<div class="eyebrow">Fullscreen</div><h2>This browser would not hand it over</h2>'
        + '<p class="tip-p">The request was refused. The game already fills whatever room it is given, '
        + 'so nothing is missing — there is just a browser around it.</p>'
        + '<div class="btn-row"><button class="btn btn-go" id="btnTipOk" type="button">Got it</button></div>');
    }
    $('btnTipOk').onclick = closeOverlay;
  }

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
      + row('Game length', 'Arcade is four two-minute quarters with a full game of snaps in them; the longer settings run a real clock',
          seg('length', ['arcade', 'blitz', 'quick', 'standard'].map(function (k) { return [k, S.LENGTH_LABELS[k] || k]; }), set.length))
      + row('Play art', 'Routes, run paths and blitz arrows before the snap', seg('art', [[true, 'On'], [false, 'Off']], set.art))
      + row('Sound', 'Short cues, no music', seg('sound', [[true, 'On'], [false, 'Off']], set.sound))
      + row('Haptics', 'Where the device supports it', seg('haptics', [[true, 'On'], [false, 'Off']], set.haptics))
      + row('Replays', 'A score, a takeaway, a stand or a huge play, shown again at half speed; a tap skips it', seg('replay', [[true, 'On'], [false, 'Off']], set.replay !== false))
      + '<div class="muted" style="padding-top:12px">Game length applies to the next game you start.</div>'
      + '<div class="muted" style="padding-top:6px">Keyboard: arrows or WASD steer · Space snaps, then sprints · J K L are the three moves · 1–5 throw to a badge, held for a bullet · Tab switches the defender.</div>'
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
    syncFull();
  }
  /* THE FULLSCREEN CONTROLS AGREE WITH THE BROWSER, ALWAYS. There can be two
     of them on screen — the tools row above the field, and the one beside
     Kick off — and you can also leave fullscreen without touching either, with
     Escape or a swipe. So the browser's own event drives this, not the tap. */
  function syncFull() {
    var on = FULL.on();
    Array.prototype.forEach.call(document.querySelectorAll('[data-full]'), function (b) {
      b.setAttribute('aria-pressed', String(on));
      b.setAttribute('title', on ? 'Leave fullscreen' : 'Fullscreen');
      b.setAttribute('aria-label', on ? 'Leave fullscreen' : 'Fullscreen');
    });
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
    flow('PRE_GAME', 'matchup');
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
      /* THE ACTION THAT STARTS A FOOTBALL GAME RIDES THE BOTTOM OF THE
         SCREEN. This card is longer than a phone, so if the only way to
         reach Kick off is to scroll, then anything that stops the page
         scrolling is a game that cannot be started at all — which is exactly
         what happened. It is on screen from the first paint now, whether or
         not anything else on this page behaves. */
      + '<div class="pre-go">'
      + (resumable
          ? '<button class="btn btn-go btn-big" id="btnResume" type="button"><span>Resume</span><i>'
            + esc(resumable.show.home + ' ' + resumable.show.score.home + ' · ' + resumable.show.away + ' '
              + resumable.show.score.away + ' · Q' + resumable.show.quarter) + '</i></button>'
          : '<button class="btn btn-go btn-big" id="btnStart" type="button">Kick off</button>')
      + '<button class="btn btn-ico" id="btnFull2" type="button" data-full aria-pressed="false"'
      + ' title="Fullscreen" aria-label="Fullscreen">⛶</button>'
      + '</div>'
      + '<div class="btn-row">'
      + (resumable ? '<button class="btn btn-big" id="btnStart" type="button">Start a new game</button>' : '')
      + '<button class="btn btn-ghost" id="btnSet2" type="button">Settings</button>'
      + '<a class="btn btn-ghost" href="/games/gameday/">Back to Game Day</a></div>';
    paintPreField();
    /* THE TEAMS SETTLE BEFORE A GAME STARTS. The card paints with the house
       teams while the franchise is still loading; a quick thumb on Resume in
       that window replayed the save against the wrong men, and the replay
       stopped where the calls no longer fit — a full game came back at
       halftime. Both doors wait for the franchise to answer. */
    if ($('btnResume')) $('btnResume').onclick = function () { whenTeams(function () { resumeGame(S.saved() || resumable); }); };
    $('btnStart').onclick = function () { whenTeams(function () { S.clearSave(); newGame(); }); };
    $('btnSet2').onclick = settingsOverlay;
    $('btnFull2').onclick = toggleFull;
    syncFull();
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
    if (stage && stage.destroy) { try { stage.destroy(); } catch (_) {} }
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
        /* a pick: the side that threw it has nobody to steer; the side that
           took it is now carrying, and gets the runner's buttons */
        onIntercept: function () { SOUND.bad(); buzz('medium'); if (set.mode === 'play') { if (!userHasBall()) padRun(); else padClear(); } },
        onFumble: function () { SOUND.hit(true); buzz('strong'); },
        onKick: function () { SOUND.kick(); buzz('medium'); },
        onIncomplete: function () {},
        onMove: function () {},
        onEnd: onEnd
      }
    });
    if (!canvas.__taps) { canvas.__taps = 1; wireFieldTaps(); }
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
    game.meta.startedAt = Date.now();
    me = game.meta.user;
    startPlaying();
    if (GM && GM.track) GM.track('gridiron_game_started', { difficulty: set.difficulty, mode: set.mode });
  }
  function resumeGame(rec) {
    game = S.resume(rec, { me: teams.me, opponent: teams.opp, weather: cond() });
    if (!game) { newGame(); return; }
    me = game.meta.user;
    /* a finished game reaches the final through nextCall, once */
    startPlaying();
  }
  function startPlaying() {
    milestoned = {};
    READS = []; pendingRead = null; readSaid = 0;
    RUN = { stuffs: 0, runs: 0, saved: 0, broke: 0, said: {} };
    pre.hidden = true; gd.hidden = false;
    makeStage();
    syncTools(); paintScore(); say('');
    busy = false;
    flow('TRANSITION', 'game start');
    rotatePrompt();
    setTimeout(function () { stage.resize(); nextCall(); }, 30);
  }
  /* ── ROTATE TO PLAY ──────────────────────────────────────────────────────
     The field is wider than it is tall, and so is a phone on its side. A
     phone held upright still plays — the layout stacks — but it is asked
     once, politely, and it may say no for the rest of the session. */
  function portraitPhone() {
    return window.innerHeight > window.innerWidth && window.innerWidth < 760;
  }
  function rotatePrompt() {
    var seen = false;
    try { seen = sessionStorage.getItem('ed_rotate_ok') === '1'; } catch (_) {}
    if (seen || !portraitPhone()) return;
    var d = document.createElement('div');
    d.className = 'rotate';
    d.innerHTML = '<div class="rt-in"><div class="rt-phone"><span></span></div>'
      + '<b>Rotate your device to play</b>'
      + '<i>The field is wider than it is tall. Turn the phone on its side for the whole picture.</i>'
      + '<button class="btn" type="button" id="rtStay">Play upright anyway</button></div>';
    fieldWrap.appendChild(d);
    function gone() {
      if (d.parentNode) d.parentNode.removeChild(d);
      try { sessionStorage.setItem('ed_rotate_ok', '1'); } catch (_) {}
      window.removeEventListener('resize', onTurn);
    }
    function onTurn() { if (!portraitPhone()) { gone(); if (stage && stage.resize) stage.resize(); } }
    $('rtStay').onclick = gone;
    window.addEventListener('resize', onTurn);
  }

  /* ── BOOT ─────────────────────────────────────────────────────────────── */
  var teamsSettling = null;
  function whenTeams(fn) {
    if (!teamsSettling) { fn(); return; }
    var once = false, go = function () { if (once) return; once = true; teamsSettling = null; fn(); };
    teamsSettling.then(go, go);
  }
  function boot() {
    flow('LOADING', 'boot');
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
    teamsSettling = Promise.resolve(GM && GM.franchiseReady ? GM.franchiseReady() : null).then(function () {
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
        /* THE MEN ON THE CARDS PLAY THE GAME. The RPC answers { ok, data };
           reading the roster off the envelope found nothing, so every Play
           Mode game was played by a roster generated from the seed while the
           cards the user had kept sat in the Vault. */
        var d = r && r.ok ? r.data : (r && r.players ? r : null);
        var players = (d && (d.players || d.roster)) || null;
        if (players && players.length) teams.me.players = players;
      }).catch(function () {});
    }).catch(function () {}).then(function () { teamsSettling = null; if (!game) pregame(S.saved()); });
  }
  function wireTools() {
    $('btnArt').onclick = function () {
      set.art = !set.art; S.saveSettings(set); if (stage) stage.setArt(set.art); syncTools(); SOUND.tap();
    };
    $('btnSound').onclick = function () {
      set.sound = !set.sound; S.saveSettings(set); syncTools();
      if (set.sound) SOUND.ambience(0.2); else SOUND.quiet();
    };
    $('btnFull').onclick = toggleFull;
    $('btnSet').onclick = settingsOverlay;
    $('btnExit').onclick = function () { location.href = '/games/gameday/'; };
    ['fullscreenchange', 'webkitfullscreenchange'].forEach(function (ev) {
      document.addEventListener(ev, syncFull, false);
    });
    syncFull();
    /* TAP TO SKIP. Anywhere on the field, and only while a sequence is
       actually running — it must never eat a tap meant for a receiver. */
    fieldWrap.addEventListener('pointerdown', function (e) {
      if (!kickSkip) return;
      /* the sound and settings controls are still live during a sequence, and
         a tap meant for one of them is not a tap meant to skip it */
      if (e.target && e.target.closest && e.target.closest('.gd-tools')) return;
      kickSkip();
    }, true);
    window.addEventListener('beforeunload', function () { if (game && !game.over) S.save(game); });
    /* ── NO RUBBER-BANDING UNDER THE THUMBS, AND NOTHING ELSE ────────────
       A joystick dragged across a canvas must not drag the page with it. But
       this was cancelling EVERY touchmove on the document from the moment the
       page booted, with an allow-list of three class names — one of which
       (`.deck`) no longer exists, and one of which (`.dr-list`) is not even
       the element that scrolls. So the matchup screen could not be scrolled
       at all: you arrived on a phone, the Kick off button was under the
       browser's own toolbar, and there was no way to reach it. The game was
       unplayable before it started.

       It belongs to the field and to nothing else. The call sheet, the
       overlays and the matchup page are ordinary scrolling content and are
       left alone; the field already carries `touch-action:none` and the body
       `overscroll-behavior:none`, so this is the belt for those braces and
       only over the grass. */
    document.addEventListener('touchmove', function (e) {
      if (gd.hidden) return;
      if (!e.target || !e.target.closest) return;
      if (!e.target.closest('.gd-field')) return;
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
