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

  /* ── FEEDBACK ─────────────────────────────────────────────────────────── */
  var actx = null;
  function beep(freq, dur, type, gain) {
    if (!set.sound) return;
    try {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      var o = actx.createOscillator(), g = actx.createGain();
      o.type = type || 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(gain == null ? 0.05 : gain, actx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + dur);
      o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + dur);
    } catch (_) {}
  }
  var SOUND = {
    tap: function () { beep(520, 0.05, 'triangle', 0.03); },
    snap: function () { beep(150, 0.10, 'square', 0.05); },
    hit: function () { beep(85, 0.13, 'sawtooth', 0.06); },
    whistle: function () { beep(1500, 0.13, 'sine', 0.035); },
    first: function () { beep(700, 0.10, 'triangle', 0.045); setTimeout(function () { beep(960, 0.13, 'triangle', 0.045); }, 90); },
    td: function () { [523, 659, 784, 1047].forEach(function (f, i) { setTimeout(function () { beep(f, 0.17, 'triangle', 0.055); }, i * 95); }); },
    bad: function () { beep(210, 0.26, 'sawtooth', 0.055); setTimeout(function () { beep(140, 0.3, 'sawtooth', 0.05); }, 150); },
    crowd: function () { beep(300, 0.5, 'sine', 0.02); }
  };
  function buzz(kind) {
    if (!set.haptics || !navigator.vibrate) return;
    try { navigator.vibrate(kind === 'strong' ? [24, 40, 34] : kind === 'medium' ? 18 : 8); } catch (_) {}
  }

  /* ── COLOURS ──────────────────────────────────────────────────────────── */
  function themeOf(key) {
    var t = null;
    (FR && FR.THEMES ? FR.THEMES : []).forEach(function (x) { if (x.key === key) t = x; });
    return t || { primary: '#3fb883', secondary: '#123326', ink: '#06231a' };
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
    sb.innerHTML =
      '<div class="sb-row">'
      + '<div class="sb-team">' + (poss === 'home' ? '<span class="sb-poss"></span>' : '')
        + '<span class="sb-ab">' + esc(h.abbr) + '</span><span class="sb-pts mono">' + game.score.home + '</span></div>'
      + '<div class="sb-mid"><div class="sb-clock">' + G.clockLabel(game) + '</div><div class="sb-q">' + q + '</div></div>'
      + '<div class="sb-team right">' + (poss === 'away' ? '<span class="sb-poss left"></span>' : '')
        + '<span class="sb-ab">' + esc(a.abbr) + '</span><span class="sb-pts mono">' + game.score.away + '</span></div>'
      + '</div><div class="sb-dd">' + tos('home') + dd + tos('away') + '</div>';
  }
  function say(text, big) {
    sayEl.className = 'gd-say' + (big ? ' big' : '');
    sayEl.innerHTML = esc(text || '');
  }

  /* ── PLAY DIAGRAMS for the call sheet ─────────────────────────────────── */
  /* THE PLAY, AS A COACH WOULD SKETCH IT. Small, but big enough to tell a
     four-vertical from a screen without reading the name. */
  function diagram(playKey, formKey) {
    var play = F.play(playKey), form = F.formation(formKey), W = 88, H = 58;
    var cx = W / 2, ly = H * 0.70;
    var kx = 1.62, ky = 1.55;
    var out = '<svg class="pdiag" viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true">'
      + '<line x1="3" y1="' + ly.toFixed(1) + '" x2="' + (W - 3) + '" y2="' + ly.toFixed(1)
      + '" stroke="rgba(255,255,255,.34)" stroke-width="1.2"/>';
    [-5.0, -2.5, 0, 2.5, 5.0].forEach(function (dx) {
      out += '<rect x="' + (cx + dx * kx - 1.5).toFixed(1) + '" y="' + (ly - 4.2).toFixed(1)
        + '" width="3" height="3.2" rx="1" fill="rgba(255,255,255,.55)"/>';
    });
    var spots = form.spots, slot;
    for (slot in spots) {
      if (!spots.hasOwnProperty(slot)) continue;
      var s = spots[slot];
      var x = Math.max(3.5, Math.min(W - 3.5, cx + s[1] * kx * 0.56));
      var y = Math.min(H - 3, ly - s[0] * ky);
      var rk = play.assign && play.assign[slot];
      if (play.type === 'pass' && rk && rk !== 'block' && F.ROUTES[rk]) {
        var r = F.ROUTES[rk], mir = s[1] >= 0 ? 1 : -1, d = 'M' + x.toFixed(1) + ',' + y.toFixed(1);
        r.pts.forEach(function (pt) {
          d += 'L' + Math.max(2, Math.min(W - 2, x + pt[1] * mir * kx * 0.56)).toFixed(1)
            + ',' + Math.max(2, y - pt[0] * ky * 0.70).toFixed(1);
        });
        out += '<path d="' + d + '" fill="none" stroke="#3fb883" stroke-width="1.5" '
          + 'stroke-linecap="round" stroke-linejoin="round"/>';
      }
      out += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="2.2" fill="#e9edf4"/>';
    }
    if (play.type === 'run') {
      var lane = play.concept === 'outside' ? 9 : play.concept === 'gap' ? 4.4 : 1.4;
      out += '<path d="M' + cx + ',' + (ly + 7) + ' Q' + (cx + lane * 0.5).toFixed(1) + ',' + (ly + 1)
        + ' ' + (cx + lane).toFixed(1) + ',' + (ly - 8)
        + '" fill="none" stroke="#f2c744" stroke-width="1.9" stroke-linecap="round"/>'
        + '<path d="M' + (cx + lane - 2).toFixed(1) + ',' + (ly - 6) + 'L' + (cx + lane).toFixed(1)
        + ',' + (ly - 9.5) + 'L' + (cx + lane + 2).toFixed(1) + ',' + (ly - 6) + 'Z" fill="#f2c744"/>';
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
  var OFF_TABS = [['suggested', 'Suggested'], ['run', 'Run'], ['pass', 'Pass'], ['pa', 'Play Action'], ['special', 'Special']];
  var DEF_TABS = [['suggested', 'Suggested'], ['man', 'Man'], ['zone', 'Zone'], ['blitz', 'Blitz'], ['run', 'Run D']];

  function drawerOpen(html) {
    drawer.innerHTML = html;
    drawer.classList.add('open');
  }
  function drawerClose() { drawer.classList.remove('open'); }

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
    var body = '<div class="dr-list">' + list.map(function (p) {
      var forms = F.playForms(p.key, teams.me.offense);
      var fk = forms[0] || p.forms[0];
      return '<button class="dr-play" type="button" data-play="' + esc(p.key) + '" data-form="' + esc(fk) + '">'
        + diagram(p.key, fk)
        + '<span class="dr-txt"><b>' + esc(p.name) + '</b>'
        + '<i>' + esc(F.formation(fk).name) + ' · ' + esc(p.group === 'pa' ? 'Play action' : p.group) + '</i>'
        + '<em>' + esc(p.means) + '</em></span></button>';
    }).join('') + '</div>';
    var extra = sit.down === 4 ? fourthRow(sit) : '';
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
    if ($('drTO')) $('drTO').onclick = function () {
      if (game.timeouts[me] <= 0) { say('No timeouts left.'); return; }
      S.step(game, { type: 'timeout', side: me });
      SOUND.whistle(); paintScore(); say('Timeout, ' + teams.me.abbr + '.');
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
  function padRun() {
    pad.classList.add('on');
    pad.innerHTML =
      '<div class="pd-stick" id="pdStick"><div class="pd-knob" id="pdKnob"></div></div>'
      + '<div class="pd-acts">'
      + '<button class="pd-act" data-act="juke" type="button">Juke</button>'
      + '<button class="pd-act pd-act-b" data-act="truck" type="button">Truck</button>'
      + '</div>';
    wireStick(); wireActs();
  }
  function padDefense() {
    pad.classList.add('on');
    pad.innerHTML =
      '<div class="pd-stick" id="pdStick"><div class="pd-knob" id="pdKnob"></div></div>'
      + '<div class="pd-acts">'
      + '<button class="pd-act" data-act="switch" type="button">Switch</button>'
      + '<button class="pd-act pd-act-b" data-act="dive" type="button">Tackle</button>'
      + '</div>';
    wireStick(); wireActs();
  }
  function padReceivers(list) {
    pad.classList.add('on');
    pad.innerHTML = '<div class="pd-recv" id="pdRecv">' + list.map(function (r, i) {
      return '<button class="pd-r" type="button" data-read="' + i + '">'
        + '<b>' + esc(routeName(r.route)) + '</b><i>' + esc(slotName(r.slot)) + '</i></button>';
    }).join('') + '</div><div class="pd-clock"><span id="pdBar"></span></div>';
    Array.prototype.forEach.call(pad.querySelectorAll('[data-read]'), function (b) {
      b.onclick = function () {
        var i = +b.getAttribute('data-read');
        SOUND.tap(); buzz('light');
        stage.throwTo(i);
        padClear();
      };
    });
    var t0 = Date.now(), bar = $('pdBar');
    (function tickBar() {
      if (!bar || !bar.parentNode) return;
      var u = Math.min(1, (Date.now() - t0) / 2600);
      bar.style.width = (100 - u * 100) + '%';
      bar.style.background = u > 0.7 ? '#e2664b' : u > 0.4 ? '#d9a441' : '#3fb883';
      if (u < 1) requestAnimationFrame(tickBar);
    })();
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

  var stickState = { id: null, cx: 0, cy: 0, r: 44 };
  function wireStick() {
    var el = $('pdStick'), knob = $('pdKnob');
    if (!el) return;
    function down(e) {
      var t = e.changedTouches ? e.changedTouches[0] : e;
      var b = el.getBoundingClientRect();
      stickState.id = e.changedTouches ? t.identifier : 'mouse';
      stickState.cx = b.left + b.width / 2; stickState.cy = b.top + b.height / 2;
      stickState.r = b.width / 2;
      move(e);
      e.preventDefault();
    }
    function move(e) {
      if (stickState.id == null) return;
      var t = e.changedTouches ? find(e.changedTouches) : e;
      if (!t) return;
      var dx = t.clientX - stickState.cx, dy = t.clientY - stickState.cy;
      var m = Math.hypot(dx, dy), r = stickState.r;
      var nx = dx / r, ny = dy / r;
      if (m > r) { nx = dx / m; ny = dy / m; }
      knob.style.transform = 'translate(' + (nx * r * 0.55) + 'px,' + (ny * r * 0.55) + 'px)';
      /* screen down is field backwards */
      if (stage) stage.steer(nx, -ny);
      e.preventDefault();
    }
    function up(e) {
      stickState.id = null;
      knob.style.transform = '';
      if (stage) stage.steer(0, 0);
    }
    function find(list) {
      var i;
      for (i = 0; i < list.length; i++) if (list[i].identifier === stickState.id) return list[i];
      return null;
    }
    el.addEventListener('touchstart', down, { passive: false });
    window.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('touchend', up);
    window.addEventListener('touchcancel', up);
    el.addEventListener('mousedown', down);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }
  function wireActs() {
    Array.prototype.forEach.call(pad.querySelectorAll('[data-act]'), function (b) {
      b.onclick = function () {
        var a = b.getAttribute('data-act');
        if (a === 'switch') { stage.switchDefender(); SOUND.tap(); buzz('light'); return; }
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
    pendingCall = { type: 'play', play: key, formation: formKey, def: defKey, tempo: 'normal' };
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
    stage.lineUp({
      play: playKey, formation: formKey, def: defKey,
      los: sit.ball, firstDown: Math.min(100, sit.ball + sit.toGo), ballX: ballX,
      strong: ps ? ps.strong : 0,
      offUnits: G.unitsOf(offT, game.tick), defUnits: G.unitsOf(defT, game.tick)
    });
    var look = stage.look();
    readEl.hidden = false;
    readEl.innerHTML = '<b>' + esc(look.name) + '</b>' + esc(Math.round(ps.box) + ' in the box · ' + look.coverage
      + (look.blitz ? ' · pressure' : ''));
    say('');
  }
  function doSnap() {
    if (busy || stage.phase() !== 'set') return;
    busy = true;
    readEl.hidden = true;
    SOUND.snap(); buzz('light');
    seenTip('snap');
    var sit = G.situation(game);
    var mine = sit.offense === me;
    padClear();
    stage.snapNow();
    if (set.mode === 'coach' || !mine) {
      if (!mine && set.mode === 'play') padDefense();
    } else if (F.play(pendingCall.play).type === 'pass') {
      var rs = stage.receivers();
      if (rs.length) { padReceivers(rs.slice(0, 4)); seenTip('read'); }
    } else {
      padRun(); seenTip('run');
    }
  }
  function special(call) {
    if (busy) return;
    busy = true; drawerClose(); padClear();
    var r = S.step(game, call);
    var sit = G.situation(game);
    if (r.event === 'punt') { SOUND.whistle(); say('Punt — ' + r.punt.gross + ' yards' + (r.punt.touchback ? ', touchback.' : '.')); }
    else if (r.event === 'fieldgoal') {
      if (r.fg.good) { SOUND.td(); buzz('strong'); bigFlash('GOOD', 'good'); }
      else { SOUND.bad(); buzz('medium'); bigFlash('NO GOOD', 'bad'); }
      say(r.fg.distance + '-yard field goal is ' + (r.fg.good ? 'good.' : 'wide.'));
    } else if (r.event === 'kickoff') say('Kickoff.');
    paintScore();
    setTimeout(function () { busy = false; nextCall(); }, 850);
  }

  /* ── THE STAGE'S CALLBACKS ────────────────────────────────────────────── */
  function resolveNow(input) {
    var call = pendingCall || {};
    call.read = input.read; call.lane = input.lane; call.timing = input.timing;
    var r = S.step(game, call);
    lastResult = r && r.play ? r.play : null;
    return lastResult;
  }
  function onEnd(kind, res) {
    var p = res || lastResult;
    if (p) {
      if (p.sack) { SOUND.bad(); buzz('medium'); bigFlash('SACK', 'bad'); }
      else if (p.turnover === 'interception') { SOUND.bad(); buzz('strong'); bigFlash('INTERCEPTED', 'bad'); }
      else if (p.turnover === 'fumble') { SOUND.bad(); buzz('strong'); bigFlash('FUMBLE', 'bad'); }
      else if (p.touchdown) { SOUND.td(); buzz('strong'); bigFlash('TOUCHDOWN', 'td'); }
      else if (p.firstDown) { SOUND.first(); buzz('medium'); bigFlash('FIRST DOWN', 'first'); }
      else { SOUND.hit(); buzz('light'); }
      say(p.commentary, p.touchdown || !!p.turnover);
      ballX = drift(ballX);
    }
    padClear();
    paintScore();
    var wait = set.speed === 'instant' ? 260 : (p && (p.touchdown || p.turnover)) ? 1500 : 900;
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
  function bigFlash(text, kind) {
    var d = document.createElement('div');
    d.className = 'fx fx-' + kind;
    d.textContent = text;
    fieldWrap.appendChild(d);
    setTimeout(function () { d.classList.add('out'); }, 1000);
    setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 1700);
  }

  /* ── WHOSE CALL IS IT ─────────────────────────────────────────────────── */
  function nextCall() {
    if (game.over) { finalScreen(); return; }
    var sit = G.situation(game);
    paintScore();
    if (sit.phase === 'halftime') { halftimeScreen(); return; }
    if (sit.phase === 'kickoff') {
      padClear(); drawer.classList.remove('open');
      drawerOpen('<div class="dr-grip"></div><div class="dr-row one">'
        + '<button class="btn btn-go" id="drKick" type="button">Kick off</button></div>');
      $('drKick').onclick = function () { drawerClose(); special({ type: 'kickoff' }); };
      return;
    }
    if (sit.phase === 'pat') {
      var mine = game.pendingScore.side === me;
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
      offUnits: G.unitsOf(G.teamOf(game, sit.offense), game.tick),
      defUnits: G.unitsOf(G.teamOf(game, sit.defense), game.tick) });
    readEl.hidden = true;
  }
  function patForThem() {
    var d = game.score[game.pendingScore.side] - game.score[G.other(game.pendingScore.side)];
    var late = game.quarter >= game.cfg.quarters;
    return (late && (d === -2 || d === -5 || d === 1 || d === -10))
      ? { type: 'two', play: 'power', formation: 'goalline', def: 'goal_line_d' } : { type: 'pat' };
  }

  /* ── HALFTIME ─────────────────────────────────────────────────────────── */
  function halftimeScreen() {
    var box = G.boxScore(game), mine = box[me], theirs = box[G.other(me)];
    var rows = [['Total yards', mine.yards, theirs.yards], ['Yards per play', mine.ypp, theirs.ypp],
      ['Rushing', mine.rushYards + ' (' + mine.ypc + ')', theirs.rushYards + ' (' + theirs.ypc + ')'],
      ['Passing', mine.comp + '/' + mine.att + ' · ' + mine.passYards, theirs.comp + '/' + theirs.att + ' · ' + theirs.passYards],
      ['Third down', mine.third, theirs.third], ['Explosive plays', mine.explosive, theirs.explosive],
      ['Sacks', mine.sacks, theirs.sacks], ['Turnovers', mine.turnovers, theirs.turnovers]];
    overlay('<div class="eyebrow">Halftime</div><h2>' + esc(teams.me.abbr) + ' ' + game.score[me] + ' · '
      + esc(teams.opp.abbr) + ' ' + game.score[G.other(me)] + '</h2>'
      + '<table class="box"><thead><tr><th>&nbsp;</th><th>' + esc(teams.me.abbr) + '</th><th>' + esc(teams.opp.abbr)
      + '</th></tr></thead><tbody>' + rows.map(function (r) {
        return '<tr><th>' + esc(r[0]) + '</th><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td></tr>';
      }).join('') + '</tbody></table><h3>One adjustment</h3>'
      + '<div class="adjs">' + G.ADJUSTMENTS.map(function (a) {
          return '<button class="adj" type="button" data-adj="' + esc(a.key) + '">'
            + '<span class="ct">' + (a.side === 'off' ? 'Offence' : 'Defence') + '</span>'
            + '<b>' + esc(a.name) + '</b><em>' + esc(a.means) + '</em></button>';
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

  /* ── THE RECAP ────────────────────────────────────────────────────────── */
  function finalScreen() {
    S.clearSave();
    if (stage) stage.stop();
    var box = G.boxScore(game), them = G.other(me), mine = box[me], theirs = box[them];
    var won = game.score[me] > game.score[them];
    var tp = S.turningPoint(game), potg = G.playerOfGame(game), reasons = S.reasons(box, me, won);
    var rows = [['First downs', mine.firstDowns, theirs.firstDowns], ['Total yards', mine.yards, theirs.yards],
      ['Rushing', mine.rushYards + ' (' + mine.ypc + ')', theirs.rushYards + ' (' + theirs.ypc + ')'],
      ['Passing', mine.comp + '/' + mine.att + ' · ' + mine.passYards, theirs.comp + '/' + theirs.att + ' · ' + theirs.passYards],
      ['Sacks', mine.sacks, theirs.sacks], ['Third down', mine.third, theirs.third],
      ['Fourth down', mine.fourth, theirs.fourth], ['Red zone', mine.redzone, theirs.redzone],
      ['Explosive plays', mine.explosive, theirs.explosive], ['Turnovers', mine.turnovers, theirs.turnovers],
      ['Field goals', mine.fg, theirs.fg], ['Possession', mins(mine.top), mins(theirs.top)]];
    var injuries = (game[me === 'home' ? 'home' : 'away'].injuries || []).filter(function (i) { return i.weeks > 0; });
    overlay('<div class="eyebrow">Final</div>'
      + '<div class="final"><div><div class="t">' + esc(title(teams.me)) + '</div>'
      + '<div class="p' + (won ? ' win' : '') + '">' + game.score[me] + '</div></div>'
      + '<div class="sb-q">' + (game.ot ? 'OT' : 'FT') + '</div>'
      + '<div><div class="t">' + esc(title(teams.opp)) + '</div>'
      + '<div class="p' + (!won && game.score[them] > game.score[me] ? ' win' : '') + '">' + game.score[them] + '</div></div></div>'
      + (reasons.length ? '<h3>' + (won ? 'Why you won' : game.score[me] === game.score[them] ? 'How it finished level' : 'Why you lost')
          + '</h3><ul class="why">' + reasons.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ul>' : '')
      + (tp ? '<h3>Turning point</h3><div class="muted">Q' + tp.q + ' — ' + esc(tp.text) + '</div>' : '')
      + (potg ? '<h3>Player of the game</h3><div class="potg"><div><div class="pn">'
          + esc(potg.position + ' ' + potg.name) + '</div><div class="pl">' + esc(statLine(potg)) + '</div></div></div>' : '')
      + '<h3>Box score</h3><table class="box"><thead><tr><th>&nbsp;</th><th>' + esc(teams.me.abbr) + '</th><th>'
      + esc(teams.opp.abbr) + '</th></tr></thead><tbody>' + rows.map(function (r) {
        return '<tr><th>' + esc(r[0]) + '</th><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td></tr>';
      }).join('') + '</tbody></table>'
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
  function pregame(resumable) {
    pre.hidden = false; gd.hidden = true;
    var opp = teams.opp, mine = teams.me, oppTeam = null;
    S.TEAMS.forEach(function (t) { if (t.abbr === opp.abbr) oppTeam = t; });
    preCard.innerHTML = '<div class="eyebrow">Game Day</div>'
      + '<div class="mu"><div class="mu-team">' + esc(title(mine)) + '</div><div class="mu-vs">VERSUS</div>'
      + '<div class="mu-team">' + esc(title(opp)) + '</div>'
      + '<div class="mu-when">' + esc(F.scheme(mine.offense).name) + ' against ' + esc(defName(opp.defense)) + '</div></div>'
      + '<div class="chips"><span class="chip">Your offence <b>' + esc(F.scheme(mine.offense).name) + '</b></span>'
      + '<span class="chip">Your defence <b>' + esc(defName(mine.defense)) + '</b></span>'
      + '<span class="chip">Their offence <b>' + esc(F.scheme(opp.offense).name) + '</b></span>'
      + '<span class="chip">Their defence <b>' + esc(defName(opp.defense)) + '</b></span></div>'
      + (oppTeam ? '<h3 style="margin-top:18px;font-size:15px">The scouting report</h3>'
          + '<p class="muted" style="margin-top:6px">' + esc(oppTeam.blurb) + '</p>'
          + '<div class="chips"><span class="chip">Rated <b>' + oppTeam.overall + '</b></span>'
          + '<span class="chip">Tendency confidence <b>low</b> — you have not played them yet</span></div>' : '')
      + '<div class="btn-row">'
      + (resumable ? '<button class="btn btn-go" id="btnResume" type="button">Resume — '
          + esc(resumable.show.home + ' ' + resumable.show.score.home + ', ' + resumable.show.away + ' '
            + resumable.show.score.away + ' · Q' + resumable.show.quarter) + '</button>' : '')
      + '<button class="btn ' + (resumable ? '' : 'btn-go') + '" id="btnStart" type="button">'
      + (resumable ? 'Start a new game' : 'Kick off') + '</button>'
      + '<button class="btn btn-ghost" id="btnSet2" type="button">Settings</button>'
      + '<a class="btn btn-ghost" href="/games/gameday/">Back to Game Day</a></div>';
    if ($('btnResume')) $('btnResume').onclick = function () { resumeGame(resumable); };
    $('btnStart').onclick = function () { S.clearSave(); newGame(); };
    $('btnSet2').onclick = settingsOverlay;
  }
  function defName(k) {
    var out = k;
    (FR && FR.DEFENSES ? FR.DEFENSES : []).forEach(function (d) { if (d.key === k) out = d.label; });
    return out;
  }

  /* ── STARTING ─────────────────────────────────────────────────────────── */
  function makeStage() {
    stage = ST.Stage(canvas, {
      resolve: resolveNow,
      homeColor: kitFor('me').secondary || '#123326',
      awayColor: kitFor('opp').secondary || '#2a1a2f',
      on: {
        onSnap: function () {},
        onHandoff: function () { buzz('light'); },
        onThrow: function () { SOUND.tap(); },
        onCatch: function () { SOUND.tap(); buzz('light'); if (set.mode === 'play') padRun(); },
        onScramble: function () { if (set.mode === 'play') padRun(); },
        onIntercept: function () { SOUND.bad(); },
        onIncomplete: function () {},
        onMove: function () {},
        onEnd: onEnd
      }
    });
  }
  function newGame() {
    game = S.build({ me: teams.me, opponent: teams.opp, home: teams.home !== false,
      week: teams.week || 1, season: teams.season || 1, opponentKey: teams.oppKey, settings: set });
    me = game.meta.user;
    startPlaying();
    if (GM && GM.track) GM.track('gridiron_game_started', { difficulty: set.difficulty, mode: set.mode });
  }
  function resumeGame(rec) {
    game = S.resume(rec, { me: teams.me, opponent: teams.opp });
    if (!game) { newGame(); return; }
    me = game.meta.user;
    startPlaying();
    if (game.over) finalScreen();
  }
  function startPlaying() {
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
    $('btnSound').onclick = function () { set.sound = !set.sound; S.saveSettings(set); syncTools(); };
    $('btnSet').onclick = settingsOverlay;
    $('btnExit').onclick = function () { location.href = '/games/gameday/'; };
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
