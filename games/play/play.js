/* ===========================================================================
   GAME DAY — the page you play on.

   The view layer and nothing more. Every football decision belongs to
   games/lib/gridiron/*: this file asks the session for a game, paints the
   scoreboard, hands the renderer a result to animate, and turns taps into
   calls. If a number appears on this page, something under lib/ computed it.

   THE LOOP, once a game is under way:

       pick a play  →  see the look  →  take the read  →  watch it
             ↑                                                │
             └────────────────  the next down  ───────────────┘

   Two taps a snap in Play Mode, one in Coach Mode. Everything else — the
   fourth-down board, the clock, halftime, the recap — is the same loop with
   a different call sheet.
   =========================================================================== */
(function () {
  'use strict';

  var F = window.EDFootball, G = window.EDGridiron, AI = window.EDGridironAI,
      Auto = window.EDGridironAuto, RD = window.EDGridironRender, S = window.EDGridironSession,
      RO = window.EDRoster, GM = window.EDGames, FR = window.EDFranchise;

  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var gd = $('gd'), pre = $('pre'), preCard = $('preCard'), deck = $('deck'),
      sb = $('sb'), sayEl = $('say'), readEl = $('read'), stage = $('stage'), ovHost = $('ovHost');

  var set = S.settings();
  var game = null, R = null, me = 'home', pending = null, busy = false;
  var teams = { me: null, opp: null };
  var snapAt = 0, tipsSeen = {};
  try { tipsSeen = JSON.parse(localStorage.getItem('ed_gridiron_tips') || '{}'); } catch (_) {}

  /* ── FEEDBACK: sound and haptics, both optional, neither required ─────── */
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
    snap: function () { beep(180, 0.09, 'square', 0.04); },
    tackle: function () { beep(90, 0.14, 'sawtooth', 0.05); },
    whistle: function () { beep(1400, 0.12, 'sine', 0.03); },
    first: function () { beep(700, 0.10, 'triangle', 0.04); setTimeout(function () { beep(940, 0.12, 'triangle', 0.04); }, 90); },
    touchdown: function () { [523, 659, 784, 1047].forEach(function (f, i) { setTimeout(function () { beep(f, 0.16, 'triangle', 0.05); }, i * 90); }); },
    turnover: function () { beep(220, 0.25, 'sawtooth', 0.05); setTimeout(function () { beep(150, 0.3, 'sawtooth', 0.05); }, 140); },
    sack: function () { beep(120, 0.22, 'square', 0.05); }
  };
  function buzz(kind) {
    if (!set.haptics || !navigator.vibrate) return;
    try {
      navigator.vibrate(kind === 'strong' ? [22, 40, 30] : kind === 'medium' ? 18 : 8);
    } catch (_) {}
  }

  /* ── TEAM COLOURS on the field ───────────────────────────────────────── */
  function themeOf(key) {
    var t = null;
    (FR && FR.THEMES ? FR.THEMES : []).forEach(function (x) { if (x.key === key) t = x; });
    return t || { primary: '#3fb883', ink: '#06231a' };
  }
  function paintColours() {
    var mine = themeOf(teams.me.theme), theirs = themeOf(teams.opp.theme);
    if (mine.primary === theirs.primary) theirs = { primary: '#e2664b', ink: '#2a0c08' };
    var w = $('fieldWrap');
    w.style.setProperty('--team-off', mine.primary);
    w.style.setProperty('--team-off-ink', mine.ink);
    w.style.setProperty('--team-def', theirs.primary);
    w.style.setProperty('--ez-home', mine.primary + '33');
    w.style.setProperty('--ez-away', theirs.primary + '33');
  }
  /* the colours swap by who has the ball, so "green is me" is always true */
  function sideColours() {
    var offIsMe = G.situation(game).offense === me;
    var mine = themeOf(teams.me.theme), theirs = themeOf(teams.opp.theme);
    if (mine.primary === theirs.primary) theirs = { primary: '#e2664b', ink: '#2a0c08' };
    var a = offIsMe ? mine : theirs, b = offIsMe ? theirs : mine;
    var w = $('fieldWrap');
    w.style.setProperty('--team-off', a.primary);
    w.style.setProperty('--team-off-ink', a.ink);
    w.style.setProperty('--team-def', b.primary);
  }

  /* ── THE SCOREBOARD ──────────────────────────────────────────────────── */
  function paintScore() {
    var sit = G.situation(game);
    var h = game.home, a = game.away;
    var poss = sit.offense;
    function tos(side) {
      var n = game.timeouts[side], s = '', i;
      for (i = 0; i < 3; i++) s += '<i class="' + (i < n ? 'on' : '') + '"></i>';
      return '<span class="sb-to" aria-label="' + n + ' timeouts">' + s + '</span>';
    }
    var q = game.quarter > game.cfg.quarters ? 'OT' + (game.ot > 1 ? game.ot : '') : 'Q' + game.quarter;
    var yardLine = sit.ball > 50 ? 'OPP ' + (100 - sit.ball) : 'OWN ' + sit.ball;
    if (sit.ball === 50) yardLine = 'MIDFIELD';
    var dd = sit.phase === 'play'
      ? '<b>' + ordinal(sit.down) + ' &amp; ' + (sit.goalToGo ? 'Goal' : sit.toGo) + '</b>'
        + '<span>at ' + yardLine + '</span>'
      : sit.phase === 'kickoff' ? '<b>Kickoff</b>'
      : sit.phase === 'pat' ? '<b>After the touchdown</b>'
      : sit.phase === 'halftime' ? '<b>Halftime</b>' : '<b>Final</b>';
    sb.innerHTML =
      '<div class="sb-row">'
      + '<div class="sb-team">' + (poss === 'home' ? '<span class="sb-poss"></span>' : '')
        + '<span class="sb-ab">' + esc(h.abbr) + '</span>'
        + '<span class="sb-pts mono">' + game.score.home + '</span></div>'
      + '<div class="sb-mid"><div class="sb-clock">' + G.clockLabel(game) + '</div>'
        + '<div class="sb-q">' + q + '</div></div>'
      + '<div class="sb-team right">' + (poss === 'away' ? '<span class="sb-poss left"></span>' : '')
        + '<span class="sb-ab">' + esc(a.abbr) + '</span>'
        + '<span class="sb-pts mono">' + game.score.away + '</span></div>'
      + '</div>'
      + '<div class="sb-dd">' + tos('home') + dd + tos('away') + '</div>';
  }
  function ordinal(n) {
    var t = n % 100, o = n % 10;
    return n + (t >= 11 && t <= 13 ? 'th' : o === 1 ? 'st' : o === 2 ? 'nd' : o === 3 ? 'rd' : 'th');
  }
  function say(text, strong) {
    sayEl.innerHTML = strong ? '<b>' + esc(text) + '</b>' : esc(text);
  }

  /* ── THE DECK ────────────────────────────────────────────────────────── */
  function deckHead(label, right) {
    return '<div class="deck-hd"><span class="deck-eyebrow">' + esc(label) + '</span>'
      + '<span class="deck-sp"></span>' + (right || '') + '</div>';
  }
  function bigButton(id, label, cls) {
    return '<button class="btn ' + (cls || 'btn-go') + '" id="' + id + '" type="button">' + esc(label) + '</button>';
  }

  /* what the situation is worth saying before a call */
  function tells(extra) {
    var sit = G.situation(game), out = [];
    var offIsMe = sit.offense === me;
    var them = offIsMe ? sit.defense : sit.offense;
    var scout = S.scoutRead(game, them);
    out.push('<span class="tell"><b>' + ordinal(sit.down) + ' &amp; '
      + (sit.goalToGo ? 'Goal' : sit.toGo) + '</b></span>');
    if (sit.redzone) out.push('<span class="tell hot">Red zone</span>');
    if (sit.twoMinute) out.push('<span class="tell hot">Two-minute</span>');
    if (scout.runShare != null) {
      out.push('<span class="tell">' + (offIsMe ? 'They blitz' : 'They run')
        + ' <b>' + Math.round(100 * (offIsMe ? (scout.blitzShare || 0) : scout.runShare)) + '%</b>'
        + ' · ' + scout.confidence + ' confidence</span>');
    }
    var fr = G.freshness(G.teamOf(game, sit.offense), offIsMe ? 'OL' : 'DL');
    if (offIsMe && fr < 72) out.push('<span class="tell cold">Line is tiring</span>');
    (extra || []).forEach(function (t) { out.push(t); });
    return '<div class="tells">' + out.join('') + '</div>';
  }

  /* ── OFFENSIVE CALL SHEET ────────────────────────────────────────────── */
  var offTab = 'smart';
  function smartPlays(schemeKey, sit, n) {
    var book = F.playbook(schemeKey), all = [], scored;
    book.forEach(function (g) { g.plays.forEach(function (p) { all.push(p); }); });
    var scheme = F.scheme(schemeKey);
    var lean = AI.passLean(sit, scheme, null);
    scored = all.map(function (p) {
      return { p: p, s: AI.scorePlay(p, sit, scheme, lean, { blitz: 0, deep: 0, stack: 0 },
                                     AI.tier('pro'), game.mem[me]) };
    });
    scored.sort(function (a, b) { return b.s - a.s; });
    /* one from each family where possible, so the shelf is a plan not a list */
    var out = [], seen = {};
    scored.forEach(function (x) {
      if (out.length >= n) return;
      if (seen[x.p.group] && out.length < n - 2) return;
      seen[x.p.group] = 1; out.push(x.p);
    });
    return out;
  }
  function playCard(p) {
    var forms = F.playForms(p.key, teams.me.offense);
    var form = F.formation(forms[0] || p.forms[0]);
    return '<button class="call" type="button" data-play="' + esc(p.key) + '">'
      + '<span class="ct">' + esc(form.name) + '</span>'
      + '<span class="cn">' + esc(p.name) + '</span>'
      + '<span class="cm">' + esc(p.means) + '</span></button>';
  }
  function deckOffense() {
    var sit = G.situation(game);
    var groups = F.playbook(teams.me.offense);
    var tabs = '<button class="deck-tab" data-tab="smart" aria-selected="' + (offTab === 'smart') + '">Sheet</button>'
      + groups.map(function (g) {
        return '<button class="deck-tab" data-tab="' + g.key + '" aria-selected="' + (offTab === g.key) + '">'
          + esc(g.label) + '</button>';
      }).join('');
    var list;
    if (offTab === 'smart') list = smartPlays(teams.me.offense, sit, 6);
    else {
      list = [];
      groups.forEach(function (g) { if (g.key === offTab) list = g.plays; });
    }
    var extra = '';
    if (sit.down === 4) extra = fourthRow(sit);
    else if (sit.quarter >= 3) extra = tempoRow();
    deck.innerHTML = deckHead('Your ball · ' + esc(F.scheme(teams.me.offense).name),
        '<button class="deck-tab" id="btnTO" type="button">Timeout</button>')
      + tells() + '<div class="deck-tabs">' + tabs + '</div>'
      + '<div class="calls">' + list.map(playCard).join('') + '</div>'
      + extra + tipFor('call');
    wireTabs('off');
    wireCalls();
    wireCommon();
  }
  function fourthRow(sit) {
    var ou = G.unitsOf(G.teamOf(game, sit.offense), game.tick);
    var k = G.fieldGoal(ou, null, sit.ball, function () { return 0.5; }, false);
    var inRange = k.distance <= k.range + 4;
    return '<div class="deck-row two">'
      + '<button class="btn" id="btnPunt" type="button">Punt</button>'
      + '<button class="btn' + (inRange ? '' : ' btn-ghost') + '" id="btnFG" type="button"'
        + (inRange ? '' : ' disabled') + '>Field goal · ' + k.distance + ' yds</button>'
      + '</div><div class="deck-note">Fourth down. Pick a play above to go for it'
      + (inRange ? ', or take the points.' : '. The kick is out of his range.') + '</div>';
  }
  function tempoRow() {
    var t = pending && pending.tempo || 'normal';
    return '<div class="deck-note"><b>Tempo</b> · '
      + ['hurry', 'normal', 'grind'].map(function (x) {
          return '<button class="deck-tab" data-tempo="' + x + '" aria-selected="' + (t === x) + '">'
            + (x === 'hurry' ? 'Hurry up' : x === 'grind' ? 'Burn clock' : 'Normal') + '</button>';
        }).join(' ') + '</div>';
  }

  /* ── DEFENSIVE CALL SHEET ────────────────────────────────────────────── */
  function smartDefs(sit, n) {
    var scored = F.DEF_CALLS.map(function (d) {
      var parts = F.defParts(d), s = 0;
      var lean = AI.passLean(sit, F.scheme(teams.opp.offense), null);
      s += (1 - lean) * (parts.front.run * 12 + parts.fit.run * 10 + (parts.front.box - 6.5) * 1.1);
      s += lean * (parts.front.cover * 8 + parts.pressure.rush * 9
        - (parts.coverage.deepMid + parts.coverage.deepOut + parts.coverage.short) * 4);
      if (sit.toGoal <= 8) s += parts.front.box * 1.2;
      return { d: d, s: s };
    });
    scored.sort(function (a, b) { return b.s - a.s; });
    return scored.slice(0, n).map(function (x) { return x.d; });
  }
  var defTab = 'smart';
  function defCard(d) {
    var parts = F.defParts(d);
    return '<button class="call" type="button" data-def="' + esc(d.key) + '">'
      + '<span class="ct">' + esc(parts.front.name) + ' · ' + esc(parts.coverage.name)
        + (parts.pressure.key !== 'none' ? ' · ' + esc(parts.pressure.name) : '') + '</span>'
      + '<span class="cn">' + esc(d.name) + '</span>'
      + '<span class="cm">' + esc(d.means) + '</span></button>';
  }
  function deckDefense() {
    var sit = G.situation(game);
    var list = defTab === 'smart' ? smartDefs(sit, 6) : F.DEF_CALLS;
    deck.innerHTML = deckHead('Their ball · ' + esc(F.scheme(teams.opp.offense).name) + ' offence',
        '<button class="deck-tab" id="btnTO" type="button">Timeout</button>')
      + tells() + '<div class="deck-tabs">'
      + '<button class="deck-tab" data-dtab="smart" aria-selected="' + (defTab === 'smart') + '">Sheet</button>'
      + '<button class="deck-tab" data-dtab="all" aria-selected="' + (defTab === 'all') + '">Everything</button>'
      + '</div>'
      + '<div class="calls">' + list.map(defCard).join('') + '</div>' + tipFor('defense');
    Array.prototype.forEach.call(deck.querySelectorAll('[data-dtab]'), function (b) {
      b.onclick = function () { defTab = b.getAttribute('data-dtab'); SOUND.tap(); deckDefense(); };
    });
    Array.prototype.forEach.call(deck.querySelectorAll('[data-def]'), function (b) {
      b.onclick = function () { chooseDefense(b.getAttribute('data-def')); };
    });
    wireCommon();
  }

  function wireTabs() {
    Array.prototype.forEach.call(deck.querySelectorAll('[data-tab]'), function (b) {
      b.onclick = function () { offTab = b.getAttribute('data-tab'); SOUND.tap(); buzz('light'); deckOffense(); };
    });
    Array.prototype.forEach.call(deck.querySelectorAll('[data-tempo]'), function (b) {
      b.onclick = function () {
        pending = pending || {}; pending.tempo = b.getAttribute('data-tempo');
        SOUND.tap(); deckOffense();
      };
    });
  }
  function wireCalls() {
    Array.prototype.forEach.call(deck.querySelectorAll('[data-play]'), function (b) {
      b.onclick = function () { choosePlay(b.getAttribute('data-play')); };
    });
    if ($('btnPunt')) $('btnPunt').onclick = function () { special({ type: 'punt' }); };
    if ($('btnFG')) $('btnFG').onclick = function () { special({ type: 'fieldgoal' }); };
  }
  function wireCommon() {
    if ($('btnTO')) $('btnTO').onclick = function () {
      var sit = G.situation(game);
      if (game.timeouts[me] <= 0) { say('No timeouts left.'); return; }
      S.step(game, { type: 'timeout', side: me });
      SOUND.whistle(); say('Timeout, ' + teams.me.abbr + '.');
      renderTurn();
    };
  }

  /* ── THE TIPS: teaching through the game, never a wall of modals ─────── */
  var TIPS = {
    call: 'Pick a play. The <b>Sheet</b> is what fits this down and distance — the tabs are your whole book.',
    read: 'Their front is <b>shaded one way</b> — run away from it. On a pass, pick the receiver the coverage leaves open. Both reward being quick.',
    defense: 'Now you defend. Guess run or pass, then pick the call that punishes it.',
    fourth: 'Fourth down. Going for it is right more often than you think inside their forty.'
  };
  function tipFor(key) {
    if (tipsSeen[key] || !TIPS[key]) return '';
    return '<div class="tip" data-tip="' + key + '"><button type="button" aria-label="Dismiss">×</button>'
      + TIPS[key] + '</div>';
  }
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t && t.parentNode && t.parentNode.hasAttribute && t.parentNode.hasAttribute('data-tip')) {
      var k = t.parentNode.getAttribute('data-tip');
      tipsSeen[k] = 1;
      try { localStorage.setItem('ed_gridiron_tips', JSON.stringify(tipsSeen)); } catch (_) {}
      t.parentNode.remove();
    }
  });
  function seenTip(k) {
    tipsSeen[k] = 1;
    try { localStorage.setItem('ed_gridiron_tips', JSON.stringify(tipsSeen)); } catch (_) {}
  }

  /* ── CHOOSING A PLAY: the look, then the read ────────────────────────── */
  function choosePlay(key) {
    if (busy) return;
    SOUND.tap(); buzz('light');
    var sit = G.situation(game);
    var forms = F.playForms(key, teams.me.offense);
    var formKey = forms[0] || F.play(key).forms[0];
    var defKey = S.aiDefense(game);
    pending = { type: 'play', play: key, formation: formKey, def: defKey,
                tempo: (pending && pending.tempo) || 'normal' };
    var ps = S.preSnap(game, key, formKey, defKey);
    sideColours();
    R.setArt(set.art);
    R.preSnap(key, formKey, defKey, sit.ball, Math.min(100, sit.ball + sit.toGo), teams, sit);
    showRead(ps);
    if (set.mode === 'coach') { snapIt(null, null); return; }
    deckRead(ps);
  }
  function showRead(ps) {
    readEl.hidden = false;
    readEl.innerHTML = '<b>' + esc(ps.parts.name) + '</b>'
      + esc(Math.round(ps.box) + ' in the box · ' + ps.shell
        + (ps.blitzing ? ' · pressure' : ''));
  }
  /* the one decision that makes this a game rather than a menu */
  function deckRead(ps) {
    var play = ps.play;
    snapAt = Date.now();
    var body;
    if (play.type === 'pass' && ps.reads.length) {
      var opts = ps.reads.slice(0, 3);
      body = opts.map(function (r, i) {
        var rt = F.ROUTES[r.route];
        return '<button class="call' + (i === 0 ? '' : '') + '" type="button" data-read="' + i + '">'
          + '<span class="ct">' + esc(slotName(r.slot)) + '</span>'
          + '<span class="cn">' + esc(routeName(r.route)) + '</span>'
          + '<span class="cm">' + esc(Math.round(r.depth) + ' yards · ' + zoneWord(rt)) + '</span></button>';
      }).join('');
    } else {
      body = [[-1, 'Left'], [0, 'Middle'], [1, 'Right']].map(function (x) {
        return '<button class="call" type="button" data-lane="' + x[0] + '">'
          + '<span class="ct">Run it</span><span class="cn">' + x[1] + '</span>'
          + '<span class="cm">' + (x[0] === 0 ? 'Straight ahead, whatever they show.'
              : 'Look at the front before you pick.') + '</span></button>';
      }).join('');
    }
    deck.innerHTML = deckHead(play.name + ' · ' + F.formation(pending.formation).name,
        '<button class="deck-tab" id="btnBack" type="button">Change</button>')
      + '<div class="deck-note">They are in <b>' + esc(ps.parts.name) + '</b> — '
      + esc(ps.parts.coverage.means) + '</div>'
      + '<div class="calls">' + body + '</div>'
      + '<div class="deck-row">' + bigButton('btnSnap', 'Snap it', 'btn btn-ghost') + '</div>'
      + tipFor('read');
    seenTip('call');
    Array.prototype.forEach.call(deck.querySelectorAll('[data-read]'), function (b) {
      b.onclick = function () { snapIt(+b.getAttribute('data-read'), null); };
    });
    Array.prototype.forEach.call(deck.querySelectorAll('[data-lane]'), function (b) {
      b.onclick = function () { R.setLane(+b.getAttribute('data-lane') || 1); snapIt(null, +b.getAttribute('data-lane')); };
    });
    $('btnSnap').onclick = function () { snapIt(null, null); };
    $('btnBack').onclick = function () { pending = { tempo: pending.tempo }; readEl.hidden = true; renderTurn(); };
  }
  function slotName(s) {
    return { X: 'X · outside', Z: 'Z · outside', SL: 'Slot', SL2: 'Slot', TE: 'Tight end',
             RB: 'Back', FB: 'Fullback' }[s] || s;
  }
  function routeName(r) {
    return { hitch: 'Hitch', slant: 'Slant', bubble: 'Bubble', flat: 'Flat', arrow: 'Arrow',
      stick: 'Stick', spot: 'Spot', shallow: 'Shallow cross', quickout: 'Quick out', check: 'Check down',
      screen: 'Screen', dig: 'Dig', curl: 'Curl', out: 'Out', cross: 'Cross', sail: 'Sail',
      over: 'Over', whip: 'Whip', go: 'Go', seam: 'Seam', post: 'Post', corner: 'Corner',
      deepcross: 'Deep cross', wheel: 'Wheel' }[r] || r;
  }
  function zoneWord(rt) {
    if (!rt) return '';
    return rt.zone === 'seam' ? 'up the seam' : rt.zone === 'mid' ? 'over the middle'
         : rt.zone === 'flat' ? 'into the flat' : 'outside';
  }

  /* ── THE SNAP ────────────────────────────────────────────────────────── */
  function snapIt(read, lane) {
    if (busy || !pending) return;
    var elapsed = (Date.now() - snapAt) / 1000;
    /* timing: on rhythm inside a second and a half, and it decays from there */
    var timing = set.mode === 'coach' || (read == null && lane == null)
      ? null : Math.max(0, Math.min(1, 1 - (elapsed - 0.35) / 2.2));
    pending.read = read; pending.lane = lane; pending.timing = timing;
    seenTip('read');
    run(pending);
  }
  function special(call) {
    if (busy) return;
    SOUND.tap();
    run(call);
  }
  function chooseDefense(defKey) {
    if (busy) return;
    SOUND.tap(); buzz('light');
    var call = S.aiOffense(game, defKey);
    call.def = defKey;
    var sit = G.situation(game);
    sideColours();
    R.setArt(set.art);
    R.preSnap(call.play, call.formation, defKey, sit.ball, Math.min(100, sit.ball + sit.toGo), teams, sit);
    seenTip('defense');
    setTimeout(function () { run(call); }, set.speed === 'instant' ? 0 : 600);
  }

  function run(call) {
    busy = true;
    readEl.hidden = true;
    var sit = G.situation(game);
    var los = sit.ball, fd = Math.min(100, sit.ball + sit.toGo);
    var r = S.step(game, call);
    pending = { tempo: (call && call.tempo) || 'normal' };
    if (!r.ok) { busy = false; renderTurn(); return; }
    if (r.event === 'punt' || r.event === 'fieldgoal' || r.event === 'kickoff') {
      afterSpecial(r); return;
    }
    if (!r.play) { busy = false; paintScore(); renderTurn(); return; }
    sideColours();
    if (set.speed === 'instant') { finishPlay(r, null); return; }
    R.setSpeed(S.SPEEDS[set.speed] || 1.5);
    say('');
    R.animate(r.play, los, fd, teams, function () { finishPlay(r, null); });
    $('fieldWrap').onclick = function () { R.skip(); };
  }
  function afterSpecial(r) {
    var sit = G.situation(game);
    if (r.event === 'punt') {
      SOUND.whistle();
      say('Punt — ' + r.punt.gross + ' yards' + (r.punt.touchback ? ', touchback.' : '.'));
    } else if (r.event === 'fieldgoal') {
      if (r.fg.good) { SOUND.touchdown(); buzz('strong'); R.flash('touchdown', 'GOOD'); }
      else { SOUND.turnover(); buzz('medium'); R.flash('turnover', 'NO GOOD'); }
      say(r.fg.distance + '-yard field goal is ' + (r.fg.good ? 'good.' : 'wide.'));
    } else {
      say('Kickoff.');
    }
    paintScore();
    setTimeout(function () { busy = false; afterTurn(); }, set.speed === 'instant' ? 60 : 900);
  }

  function finishPlay(r, _) {
    var p = r.play;
    $('fieldWrap').onclick = null;
    /* feedback in the order it happens */
    if (p.sack) { SOUND.sack(); buzz('medium'); R.flash('sack', 'SACK'); }
    else if (p.turnover === 'interception') { SOUND.turnover(); buzz('strong'); R.flash('turnover', 'INTERCEPTED'); }
    else if (p.turnover === 'fumble') { SOUND.turnover(); buzz('strong'); R.flash('turnover', 'FUMBLE'); }
    else if (p.touchdown) { SOUND.touchdown(); buzz('strong'); R.flash('touchdown', 'TOUCHDOWN'); }
    else if (p.firstDown) { SOUND.first(); buzz('medium'); R.flash('first', 'FIRST DOWN'); }
    else { SOUND.tackle(); buzz('light'); }
    say(p.commentary, p.touchdown || !!p.turnover);
    paintScore();
    var wait = set.speed === 'instant' ? 90 : p.touchdown || p.turnover ? 1100 : 620;
    setTimeout(function () { busy = false; afterTurn(); }, wait);
  }

  function afterTurn() {
    var sit = G.situation(game);
    if (game.over) { finalScreen(); return; }
    if (sit.phase === 'halftime') { halftimeScreen(); return; }
    renderTurn();
  }

  /* ── WHOSE CALL IS IT ────────────────────────────────────────────────── */
  function renderTurn() {
    paintScore();
    var sit = G.situation(game);
    sideColours();
    if (sit.phase === 'kickoff') {
      deck.innerHTML = deckHead('Kickoff')
        + '<div class="deck-row">' + bigButton('btnKick', 'Kick off') + '</div>';
      $('btnKick').onclick = function () { special({ type: 'kickoff' }); };
      R.camera(50);
      return;
    }
    if (sit.phase === 'pat') {
      var mine = game.pendingScore.side === me;
      deck.innerHTML = deckHead(mine ? 'Your touchdown' : 'Their touchdown')
        + (mine ? '<div class="deck-row two">'
            + '<button class="btn btn-go" id="btnXP" type="button">Extra point</button>'
            + '<button class="btn" id="btnTwo" type="button">Go for two</button></div>'
            + '<div class="deck-note">Two points from the three, out of a goal-line set.</div>'
          : '<div class="deck-row">' + bigButton('btnXP', 'Continue') + '</div>');
      $('btnXP').onclick = function () {
        if (!mine) { special(patForThem()); return; }
        special({ type: 'pat' });
      };
      if ($('btnTwo')) $('btnTwo').onclick = function () {
        special({ type: 'two', play: 'power', formation: 'goalline', def: S.aiDefense(game) });
      };
      return;
    }
    if (sit.phase !== 'play') return;
    R.preSnapIdle = null;
    if (sit.offense === me || set.mode === 'coach') {
      if (sit.offense === me) deckOffense();
      else deckDefense();
    } else {
      if (set.autoDefense) { chooseDefense(S.aiDefense(game)); return; }
      deckDefense();
    }
    /* line the two teams up so the field is never empty between calls */
    var guessPlay = sit.offense === me ? smartPlays(teams.me.offense, sit, 1)[0]
                                       : F.play('inside_zone');
    var fk = F.playForms(guessPlay.key, sit.offense === me ? teams.me.offense : teams.opp.offense)[0]
             || guessPlay.forms[0];
    R.setArt(false);
    R.preSnap(guessPlay.key, fk, 'base_3', sit.ball, Math.min(100, sit.ball + sit.toGo), teams, sit);
    readEl.hidden = true;
  }
  function patForThem() {
    var d = game.score[game.pendingScore.side] - game.score[G.other(game.pendingScore.side)];
    var late = game.quarter >= game.cfg.quarters;
    var want = late && (d === -2 || d === -5 || d === 1 || d === -10);
    return want ? { type: 'two', play: 'power', formation: 'goalline', def: 'goal_line_d' } : { type: 'pat' };
  }

  /* ── HALFTIME ────────────────────────────────────────────────────────── */
  function halftimeScreen() {
    var box = G.boxScore(game), mine = box[me], theirs = box[G.other(me)];
    var rows = [
      ['Total yards', mine.yards, theirs.yards],
      ['Yards per play', mine.ypp, theirs.ypp],
      ['Rushing', mine.rushYards + ' (' + mine.ypc + ')', theirs.rushYards + ' (' + theirs.ypc + ')'],
      ['Passing', mine.comp + '/' + mine.att + ' · ' + mine.passYards, theirs.comp + '/' + theirs.att + ' · ' + theirs.passYards],
      ['Third down', mine.third, theirs.third],
      ['Explosive plays', mine.explosive, theirs.explosive],
      ['Sacks', mine.sacks, theirs.sacks],
      ['Turnovers', mine.turnovers, theirs.turnovers]
    ];
    overlay('<div class="eyebrow">Halftime</div>'
      + '<h2>' + esc(teams.me.abbr) + ' ' + game.score[me] + ' · '
        + esc(teams.opp.abbr) + ' ' + game.score[G.other(me)] + '</h2>'
      + '<table class="box"><thead><tr><th>&nbsp;</th><th>' + esc(teams.me.abbr) + '</th><th>'
        + esc(teams.opp.abbr) + '</th></tr></thead><tbody>'
      + rows.map(function (r) {
          return '<tr><th>' + esc(r[0]) + '</th><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td></tr>';
        }).join('') + '</tbody></table>'
      + '<h3>One adjustment</h3>'
      + '<div class="calls">' + G.ADJUSTMENTS.map(function (a) {
          return '<button class="call" type="button" data-adj="' + esc(a.key) + '">'
            + '<span class="ct">' + (a.side === 'off' ? 'Offence' : 'Defence') + '</span>'
            + '<span class="cn">' + esc(a.name) + '</span>'
            + '<span class="cm">' + esc(a.means) + '</span></button>';
        }).join('') + '</div>');
    Array.prototype.forEach.call(ovHost.querySelectorAll('[data-adj]'), function (b) {
      b.onclick = function () {
        var key = b.getAttribute('data-adj');
        closeOverlay();
        S.step(game, { type: 'halftime_done', adjust: key,
                       oppAdjust: G.ADJUSTMENTS[(game.aiRand() * G.ADJUSTMENTS.length) | 0].key });
        say('Second half. ' + G.adjustment(key).name + '.');
        renderTurn();
      };
    });
  }

  /* ── THE RECAP ───────────────────────────────────────────────────────── */
  function finalScreen() {
    S.clearSave();
    var box = G.boxScore(game), them = G.other(me);
    var mine = box[me], theirs = box[them];
    var won = game.score[me] > game.score[them];
    var tp = S.turningPoint(game);
    var potg = G.playerOfGame(game);
    var reasons = S.reasons(box, me, won);
    var rows = [
      ['First downs', mine.firstDowns, theirs.firstDowns],
      ['Total yards', mine.yards, theirs.yards],
      ['Rushing', mine.rushYards + ' (' + mine.ypc + ')', theirs.rushYards + ' (' + theirs.ypc + ')'],
      ['Passing', mine.comp + '/' + mine.att + ' · ' + mine.passYards, theirs.comp + '/' + theirs.att + ' · ' + theirs.passYards],
      ['Sacks', mine.sacks, theirs.sacks],
      ['Third down', mine.third, theirs.third],
      ['Fourth down', mine.fourth, theirs.fourth],
      ['Red zone', mine.redzone, theirs.redzone],
      ['Explosive plays', mine.explosive, theirs.explosive],
      ['Turnovers', mine.turnovers, theirs.turnovers],
      ['Field goals', mine.fg, theirs.fg],
      ['Possession', mins(mine.top), mins(theirs.top)]
    ];
    var injuries = (game[me === 'home' ? 'home' : 'away'].injuries || []).filter(function (i) { return i.weeks > 0; });
    overlay('<div class="eyebrow">Final</div>'
      + '<div class="final"><div><div class="t">' + esc(title(teams.me)) + '</div>'
        + '<div class="p' + (won ? ' win' : '') + '">' + game.score[me] + '</div></div>'
      + '<div class="sb-q">' + (game.ot ? 'OT' : 'FT') + '</div>'
      + '<div><div class="t">' + esc(title(teams.opp)) + '</div>'
        + '<div class="p' + (!won && game.score[them] > game.score[me] ? ' win' : '') + '">'
        + game.score[them] + '</div></div></div>'
      + (reasons.length ? '<h3>' + (won ? 'Why you won' : game.score[me] === game.score[them] ? 'How it finished level' : 'Why you lost') + '</h3>'
          + '<ul class="why">' + reasons.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ul>' : '')
      + (tp ? '<h3>Turning point</h3><div class="deck-note" style="padding:0">Q' + tp.q + ' — ' + esc(tp.text) + '</div>' : '')
      + (potg ? '<h3>Player of the game</h3><div class="potg"><div>'
          + '<div class="pn">' + esc(potg.position + ' ' + potg.name) + '</div>'
          + '<div class="pl">' + esc(statLine(potg)) + '</div></div></div>' : '')
      + '<h3>Box score</h3>'
      + '<table class="box"><thead><tr><th>&nbsp;</th><th>' + esc(teams.me.abbr) + '</th><th>'
        + esc(teams.opp.abbr) + '</th></tr></thead><tbody>'
      + rows.map(function (r) {
          return '<tr><th>' + esc(r[0]) + '</th><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td></tr>';
        }).join('') + '</tbody></table>'
      + (injuries.length ? '<h3>Injuries</h3><div class="deck-note" style="padding:0">'
          + injuries.map(function (i) { return esc(i.position + ' ' + i.name + ' — ' + i.kind); }).join('<br>')
          + '</div>' : '')
      + '<h3>Drives</h3><div class="drv">' + game.drives.map(function (d, i) {
          var who = d.side === me ? teams.me.abbr : teams.opp.abbr;
          var cls = d.outcome === 'td' || d.outcome === 'fg' ? 'sc'
                  : (d.outcome === 'interception' || d.outcome === 'fumble') ? 'to' : '';
          return '<div class="' + cls + '">' + esc(who) + ' · ' + d.plays + ' plays, ' + d.yards
            + ' yards · ' + esc(driveWord(d.outcome)) + '</div>';
        }).join('') + '</div>'
      + '<div class="btn-row">'
      + '<button class="btn btn-go" id="btnAgain" type="button">Play again</button>'
      + '<a class="btn btn-ghost" href="/games/gameday/">Back to Game Day</a></div>', true);
    $('btnAgain').onclick = function () { closeOverlay(); newGame(); };
    if (GM && GM.track) GM.track('gridiron_game_finished', {
      won: won, score_for: game.score[me], score_against: game.score[them],
      difficulty: set.difficulty, mode: set.mode, plays: game.plays.length });
  }
  function driveWord(o) {
    return { td: 'touchdown', fg: 'field goal', fg_miss: 'missed field goal', punt: 'punt',
             interception: 'interception', fumble: 'fumble', downs: 'turned it over on downs',
             safety: 'safety' }[o] || o;
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

  /* ── OVERLAYS ────────────────────────────────────────────────────────── */
  function overlay(html, noClose) {
    ovHost.innerHTML = '<div class="ov" id="ov"><div class="ov-in" role="dialog" aria-modal="true">'
      + html + '</div></div>';
    if (!noClose) {
      $('ov').onclick = function (e) { if (e.target.id === 'ov') closeOverlay(); };
    }
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
      return '<div class="setrow"><span class="sl"><b>' + esc(label) + '</b><span>' + esc(sub)
        + '</span></span>' + control + '</div>';
    }
    overlay('<div class="eyebrow">Settings</div><h2>How you want to play</h2>'
      + row('Game speed', 'How long a play takes to watch',
          seg('speed', [['normal', 'Normal'], ['fast', 'Fast'], ['instant', 'Instant']], set.speed))
      + row('Control', 'Play calls the reads; Coach calls both sides and lets the players execute',
          seg('mode', [['play', 'Play'], ['coach', 'Coach']], set.mode))
      + row('Difficulty', 'What the opposing coach sees, not what his players are worth',
          seg('difficulty', AI.TIER_ORDER.map(function (k) { return [k, AI.TIERS[k].name]; }), set.difficulty))
      + row('Quarter length', 'The clock is real; this is how much of it there is',
          seg('length', [['standard', '15:00'], ['quick', '8:00'], ['blitz', '5:00']], set.length))
      + row('Play art', 'Routes, run paths and blitz arrows before the snap',
          seg('art', [[true, 'On'], [false, 'Off']], set.art))
      + row('Defence', 'Call it yourself, or let your coordinator handle it',
          seg('autoDefense', [[false, 'You call it'], [true, 'Auto']], set.autoDefense))
      + row('Sound', 'Short cues, no music', seg('sound', [[true, 'On'], [false, 'Off']], set.sound))
      + row('Haptics', 'Where the device supports it', seg('haptics', [[true, 'On'], [false, 'Off']], set.haptics))
      + '<div class="deck-note" style="padding:12px 0 0">Quarter length only applies to the next game you start.</div>'
      + '<div class="btn-row"><button class="btn btn-go" id="btnDone" type="button">Done</button></div>');
    Array.prototype.forEach.call(ovHost.querySelectorAll('[data-set]'), function (b) {
      b.onclick = function () {
        var k = b.getAttribute('data-set'), v = b.getAttribute('data-val');
        set[k] = v === 'true' ? true : v === 'false' ? false : v;
        S.saveSettings(set);
        if (R) { R.setSpeed(S.SPEEDS[set.speed] || 1.5); R.setArt(set.art); }
        syncTools();
        settingsOverlay();
      };
    });
    $('btnDone').onclick = closeOverlay;
  }
  function syncTools() {
    $('btnArt').setAttribute('aria-pressed', String(!!set.art));
    $('btnSound').setAttribute('aria-pressed', String(!!set.sound));
  }

  /* ── PREGAME ─────────────────────────────────────────────────────────── */
  function pregame(resumable) {
    pre.hidden = false; gd.hidden = true;
    var opp = teams.opp, mine = teams.me;
    var oppTeam = null;
    S.TEAMS.forEach(function (t) { if (t.abbr === opp.abbr) oppTeam = t; });
    preCard.innerHTML =
      '<div class="eyebrow">Game Day</div>'
      + '<div class="mu"><div class="mu-team">' + esc(title(mine)) + '</div>'
      + '<div class="mu-vs">VERSUS</div>'
      + '<div class="mu-team">' + esc(title(opp)) + '</div>'
      + '<div class="mu-when">' + esc(F.scheme(mine.offense).name) + ' against '
      + esc(defName(opp.defense)) + '</div></div>'
      + '<div class="chips">'
      + '<span class="chip">Your offence <b>' + esc(F.scheme(mine.offense).name) + '</b></span>'
      + '<span class="chip">Your defence <b>' + esc(defName(mine.defense)) + '</b></span>'
      + '<span class="chip">Their offence <b>' + esc(F.scheme(opp.offense).name) + '</b></span>'
      + '<span class="chip">Their defence <b>' + esc(defName(opp.defense)) + '</b></span>'
      + '</div>'
      + (oppTeam ? '<h3 style="margin-top:18px;font-size:15px">The scouting report</h3>'
          + '<p style="color:var(--dim);font-size:13.5px;line-height:1.5;margin-top:6px">'
          + esc(oppTeam.blurb) + '</p>'
          + '<div class="chips"><span class="chip">Rated <b>' + (oppTeam.overall) + '</b></span>'
          + '<span class="chip">Tendency confidence <b>low</b> — you have not played them yet</span></div>' : '')
      + '<div class="btn-row">'
      + (resumable ? '<button class="btn btn-go" id="btnResume" type="button">Resume — '
          + esc(resumable.show.home + ' ' + resumable.show.score.home + ', '
              + resumable.show.away + ' ' + resumable.show.score.away
              + ' · Q' + resumable.show.quarter) + '</button>' : '')
      + '<button class="btn ' + (resumable ? '' : 'btn-go') + '" id="btnStart" type="button">'
        + (resumable ? 'Start a new game' : 'Kick off') + '</button>'
      + '<button class="btn btn-ghost" id="btnSet2" type="button">Settings</button>'
      + '<a class="btn btn-ghost" href="/games/gameday/">Back to Game Day</a>'
      + '</div>';
    if ($('btnResume')) $('btnResume').onclick = function () { resumeGame(resumable); };
    $('btnStart').onclick = function () { S.clearSave(); newGame(); };
    $('btnSet2').onclick = settingsOverlay;
  }
  function defName(k) {
    var out = k;
    (FR && FR.DEFENSES ? FR.DEFENSES : []).forEach(function (d) { if (d.key === k) out = d.label; });
    return out;
  }

  /* ── STARTING ────────────────────────────────────────────────────────── */
  function makeRenderer() {
    R = RD.Renderer(stage, { speed: S.SPEEDS[set.speed] || 1.5, art: set.art });
  }
  function newGame() {
    game = S.build({ me: teams.me, opponent: teams.opp, home: teams.home !== false,
                     week: teams.week || 1, season: teams.season || 1,
                     opponentKey: teams.oppKey, settings: set });
    me = game.meta.user;
    startPlaying();
    if (GM && GM.track) GM.track('gridiron_game_started', { difficulty: set.difficulty, mode: set.mode });
  }
  function resumeGame(rec) {
    game = S.resume(rec, { me: teams.me, opponent: teams.opp });
    if (!game) { newGame(); return; }
    me = game.meta.user;
    startPlaying();
    if (game.over) { finalScreen(); return; }
  }
  function startPlaying() {
    pre.hidden = true; gd.hidden = false;
    makeRenderer();
    paintColours();
    syncTools();
    paintScore();
    say('');
    renderTurn();
  }

  /* ── BOOT ────────────────────────────────────────────────────────────── */
  function boot() {
    /* the house match-up first, so the field is playable before any network */
    teams.me = S.teamFromLeague({ key: 'house', city: S.HOUSE.city, name: S.HOUSE.name,
      abbr: S.HOUSE.abbr, theme: S.HOUSE.theme, logo: S.HOUSE.logo, offense: S.HOUSE.offense,
      defense: S.HOUSE.defense, overall: S.HOUSE.overall });
    teams.opp = S.teamFromLeague(S.TEAMS[0]);
    teams.oppKey = S.TEAMS[0].key;
    var rec = S.saved();
    pregame(rec && rec.calls && rec.calls.length > 2 ? rec : null);
    wireTools();
    /* then the franchise, if there is one, and repaint the pregame with it */
    if (GM && GM.boot) { try { GM.boot('gameday'); } catch (_) {} }
    if (!FR) return;
    Promise.resolve(GM && GM.franchiseReady ? GM.franchiseReady() : null)
      .then(function () {
        var snap = null;
        try { snap = FR.snapshot(); } catch (_) {}
        if (!snap || !snap.franchise || game) return;
        var f = snap.franchise, week = snap.week || {}, ng = snap.next_game || null;
        var prep = FR.prep ? FR.prep(week) : null;
        teams.me = S.teamFromFranchise(f, null, prep);
        if (ng && ng.opponent) {
          teams.opp = {
            city: ng.opponent.city, name: ng.opponent.name,
            abbr: ng.opponent.abbr || (ng.opponent.name || 'OPP').slice(0, 3).toUpperCase(),
            theme: ng.opponent.theme || 'crimson', logo: ng.opponent.logo || 'shield',
            offense: ng.opponent.offense, defense: ng.opponent.defense,
            overall: ng.opponent.overall || 73, seed: (ng.opponent.city || '') + (ng.opponent.name || '')
          };
          teams.home = ng.home !== false;
          teams.week = ng.week || 1;
          teams.season = (snap.season && snap.season.number) || 1;
        }
        /* the real roster, when the server has one */
        return FR.roster().then(function (r) {
          var players = (r && (r.players || r.roster)) || null;
          if (players && players.length) teams.me.players = players;
        }).catch(function () {});
      })
      .catch(function () {})
      .then(function () { if (!game) pregame(S.saved()); });
  }
  function wireTools() {
    $('btnArt').onclick = function () {
      set.art = !set.art; S.saveSettings(set); if (R) R.setArt(set.art); syncTools(); SOUND.tap();
    };
    $('btnSound').onclick = function () { set.sound = !set.sound; S.saveSettings(set); syncTools(); };
    $('btnSet').onclick = settingsOverlay;
    $('btnExit').onclick = function () { location.href = '/games/gameday/'; };
    window.addEventListener('beforeunload', function () { if (game && !game.over) S.save(game); });
  }

  /* THE OFFLINE SHELL. Registered at this build's own asset version, so a
     deploy replaces the cached engine rather than living alongside it. */
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
