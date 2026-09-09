/* ===========================================================================
   EDGEDESK FOOTBALL — THE VAULT.

   Where a pack is opened. Not a button, an array and five cards: a room. The
   screen goes to a dark scouting tunnel, EdgeDesk data lines run behind a
   sealed case, the case takes the pack's own art, a scan line crosses it,
   the case opens, and the men come out as silhouettes you turn over one at a
   time. A premium man does not simply appear — the room dims, a low rumble
   starts, and he is revealed a fact at a time: position, archetype, the one
   rating that defines him, the region, the overall, the outline, the name,
   and then the card.

   ── WHAT THIS FILE IS NOT ─────────────────────────────────────────────────
   It decides NOTHING. Every man in the pack was rolled and written on the
   server before this file ever runs (franchise_pack_open_id); the reveal is
   the reveal of a result that is already true, and a refresh mid-sequence
   finds the same men waiting on the table. There is no fake-out here: the
   clues shown before a reveal are the man's own facts, in a slow order.
   Suspense is theatrical, never deceptive.

   The plan of a reveal (which clues, in which order, how long) is a pure
   function — EDVault.plan(man) — so a test can hold it down without a DOM.
   =========================================================================== */
(function (root) {
  'use strict';

  var PR = root.EDProfile || (typeof require === 'function' ? (function () { try { return require('./gridiron/profile.js'); } catch (_) { return null; } })() : null);

  /* the tiers that get the premium treatment, and the words for each */
  var PREMIUM = { apex: 'APEX REVEAL', legend: 'LEGEND REVEAL', mythic: 'MYTHIC REVEAL' };
  var TIER_RANK = { prospect: 0, starter: 1, impact: 2, prime: 3, elite: 4, apex: 5, legend: 6, mythic: 7 };
  function tierOf(man) {
    if (man && man.tier) return man.tier;
    if (PR && man) return PR.tierOf(man.overall).key;
    return 'starter';
  }
  function tierName(k) {
    if (PR) { var i; for (i = 0; i < PR.TIERS.length; i++) if (PR.TIERS[i].key === k) return PR.TIERS[i].name; }
    return k ? k.charAt(0).toUpperCase() + k.slice(1) : '';
  }

  /* ── THE PLAN OF A REVEAL ────────────────────────────────────────────────
     Pure. Given a man (as the server sent him), the ordered clues a reveal
     shows before his card, and the timing. A Prime man gets a short build;
     an Apex, Legend or Mythic man gets the full progressive sequence. */
  function signature(man) {
    var pf = man && man.profile, r = (man && man.ratings) || {}, best = null, k;
    var labels = PR ? PR.LABELS : {};
    var skip = { version: 1, sta: 1 };
    if (pf) {
      for (k in pf) if (pf.hasOwnProperty(k) && !skip[k] && typeof pf[k] === 'number') {
        if (!best || pf[k] > best.value) best = { key: k, label: labels[k] || k.toUpperCase(), value: pf[k] };
      }
    }
    if (!best) {
      for (k in r) if (r.hasOwnProperty(k) && typeof r[k] === 'number') {
        if (!best || r[k] > best.value) best = { key: k, label: k.toUpperCase(), value: r[k] };
      }
    }
    return best;
  }
  function plan(man, o) {
    o = o || {};
    var tier = tierOf(man), rank = TIER_RANK[tier] || 0;
    var premium = rank >= TIER_RANK.apex;
    var build = rank >= TIER_RANK.prime;
    var sig = signature(man);
    var steps = [];
    if (premium) {
      steps.push({ kind: 'mark', text: PREMIUM[tier] || 'RARE REVEAL', ms: 1100 });
      steps.push({ kind: 'clue', label: 'Position', text: man.position, ms: 900 });
      if (man.archetype) steps.push({ kind: 'clue', label: 'Archetype', text: man.archetype, ms: 900 });
      if (sig) steps.push({ kind: 'clue', label: 'Signature', text: sig.value + ' ' + sig.label, ms: 1000 });
      if (man.hometown) steps.push({ kind: 'clue', label: 'From', text: man.hometown, ms: 800 });
      steps.push({ kind: 'ovr', text: String(man.overall), ms: 1000 });
      steps.push({ kind: 'silhouette', ms: 800 });
      steps.push({ kind: 'name', text: fullName(man), ms: 900 });
      steps.push({ kind: 'card', ms: 0 });
    } else if (build) {
      steps.push({ kind: 'clue', label: 'Position', text: man.position, ms: 550 });
      if (sig) steps.push({ kind: 'clue', label: 'Signature', text: sig.value + ' ' + sig.label, ms: 650 });
      steps.push({ kind: 'ovr', text: String(man.overall), ms: 600 });
      steps.push({ kind: 'card', ms: 0 });
    } else {
      steps.push({ kind: 'card', ms: 0 });
    }
    var total = 0, i;
    for (i = 0; i < steps.length; i++) total += steps[i].ms;
    return { tier: tier, tierName: tierName(tier), premium: premium, build: build, signature: sig, steps: steps, total: total,
             rumble: premium, confetti: rank >= TIER_RANK.legend };
  }
  function fullName(m) { return ((m.first_name || '') + ' ' + (m.last_name || '')).trim() || m.name || ''; }

  /* ── THE PACK'S OWN LOOK ─────────────────────────────────────────────────
     One theme per kind: a colour, a texture word the CSS keys on, a line. */
  var ART = {
    cache:      { hue: '#3fb883', deep: '#0d2a1e', word: 'GRIDIRON', line: 'Drawn around your own team.' },
    rookie:     { hue: '#5c9dff', deep: '#0f1d33', word: 'ROOKIE', line: 'Three young men, where you are thin.' },
    postseason: { hue: '#d9a441', deep: '#2a2010', word: 'POSTSEASON', line: 'A season seen out.' },
    vault:      { hue: '#f2c744', deep: '#2b1e08', word: 'CHAMPIONSHIP', line: 'Four men. Two kept. One of them Prime.' },
    scout:      { hue: '#9d7bff', deep: '#1d1530', word: "SCOUT'S FIND", line: 'Read the real games well.' }
  };
  function artOf(kind) { return ART[kind] || ART.cache; }

  /* ── SOUND ───────────────────────────────────────────────────────────────
     Synthesised, like the game's: nothing downloaded, nothing licensed. A
     scan is a rising sine through a filter, a flip is a short tick, a rare
     reveal is a low rumble that resolves into a chord. Off with the switch. */
  var actx = null;
  function ac() {
    if (!actx) { try { actx = new (root.AudioContext || root.webkitAudioContext)(); } catch (_) { return null; } }
    if (actx.state === 'suspended') { try { actx.resume(); } catch (_) {} }
    return actx;
  }
  function tone(o) {
    var c = ac(); if (!c) return;
    try {
      var t0 = c.currentTime + (o.at || 0), osc = c.createOscillator(), g = c.createGain();
      osc.type = o.type || 'sine';
      osc.frequency.setValueAtTime(o.f, t0);
      if (o.f2) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.f2), t0 + o.d);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.g == null ? 0.05 : o.g), t0 + (o.a || 0.01));
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.d);
      var node = g;
      if (o.lp) { var f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = o.lp; g.connect(f); node = f; }
      osc.connect(g); node.connect(c.destination);
      osc.start(t0); osc.stop(t0 + o.d + 0.02);
    } catch (_) {}
  }
  var SOUND = {
    on: true,
    tick: function () { if (SOUND.on) tone({ f: 880, f2: 660, d: 0.05, type: 'triangle', g: 0.03 }); },
    scan: function () { if (SOUND.on) { tone({ f: 220, f2: 1760, d: 0.9, type: 'sine', g: 0.035, lp: 2400 }); tone({ f: 110, d: 0.9, type: 'sine', g: 0.02 }); } },
    open: function () { if (SOUND.on) { tone({ f: 160, f2: 60, d: 0.35, type: 'sine', g: 0.08 }); tone({ f: 1200, f2: 2400, d: 0.18, type: 'triangle', g: 0.03, at: 0.08 }); } },
    flip: function () { if (SOUND.on) tone({ f: 520, f2: 780, d: 0.09, type: 'triangle', g: 0.04 }); },
    clue: function () { if (SOUND.on) tone({ f: 660, d: 0.12, type: 'sine', g: 0.035 }); },
    rumble: function (secs) {
      if (!SOUND.on) return;
      tone({ f: 48, f2: 56, d: secs || 4, type: 'sine', g: 0.09, a: 0.6, lp: 200 });
      tone({ f: 96, f2: 112, d: secs || 4, type: 'triangle', g: 0.03, a: 0.8, lp: 300 });
    },
    reveal: function (big) {
      if (!SOUND.on) return;
      var notes = big ? [392, 494, 587, 784, 988] : [523, 659, 784];
      notes.forEach(function (f, i) {
        tone({ f: f, d: 0.5, type: 'triangle', g: 0.05, at: i * 0.09 });
        tone({ f: f / 2, d: 0.6, type: 'sine', g: 0.03, at: i * 0.09 });
      });
    }
  };
  var HAPTICS = { on: true, buzz: function (pattern) { if (HAPTICS.on && root.navigator && root.navigator.vibrate) { try { root.navigator.vibrate(pattern); } catch (_) {} } } };

  /* ── THE ROOM ─────────────────────────────────────────────────────────────
     open(o): { host, pack:{kind,name,source,keep,band}, men:[...], odds,
                onKeep(man) -> Promise, onPass() -> Promise, onDone(),
                onReveal(man, plan), track(name, props), esc(fn), cardHtml(man) }
     Returns a handle with close(). */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function open(o) {
    var d = root.document, host = o.host || d.body;
    var pack = o.pack || {}, men = (o.men || []).slice(), art = artOf(pack.art || (pack.kind && pack.kind.indexOf('vault') >= 0 ? 'vault' : 'cache'));
    var keep = pack.keep || 1, kept = 0, flipped = {}, timers = [], closed = false, busy = false;
    var reduce = false;
    try { reduce = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) {}
    SOUND.on = o.sound !== false; HAPTICS.on = o.haptics !== false;

    var el = d.createElement('div');
    el.className = 'vault vault-' + esc(art.word.toLowerCase().replace(/[^a-z]+/g, '-')) + (reduce ? ' vault-still' : '');
    el.style.setProperty('--vh', art.hue); el.style.setProperty('--vd', art.deep);
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', (pack.name || 'Pack') + ' — the Vault');
    el.innerHTML =
      '<canvas class="vt-lines" aria-hidden="true"></canvas>'
      + '<div class="vt-tunnel" aria-hidden="true"></div>'
      + '<div class="vt-top"><span class="vt-eyebrow">EdgeDesk Vault</span>'
      + '<button class="vt-x" type="button" aria-label="Leave the Vault">✕</button></div>'
      + '<div class="vt-stage" id="vtStage">'
      +   '<div class="vt-case" id="vtCase">'
      +     '<div class="vt-case-lid"><span class="vt-word">' + esc(art.word) + '</span><span class="vt-kind">' + esc(pack.name || '') + '</span></div>'
      +     '<div class="vt-case-body"><span class="vt-seal">SEALED</span><span class="vt-scan"></span></div>'
      +   '</div>'
      +   '<div class="vt-under" id="vtUnder">'
      +     '<b>' + esc(pack.name || 'Pack') + '</b><i>' + esc(pack.source || art.line) + '</i>'
      +     (o.odds ? '<span class="vt-odds">' + oddsLine(o.odds) + '</span>' : '')
      +   '</div>'
      +   '<button class="vt-open btn btn-go btn-big" id="vtOpen" type="button">Open</button>'
      +   '<div class="vt-cards" id="vtCards" hidden></div>'
      +   '<div class="vt-reveal" id="vtReveal" hidden></div>'
      +   '<div class="vt-actions" id="vtActs" hidden></div>'
      + '</div>';
    host.appendChild(el);
    try { d.body.classList.add('vault-open'); } catch (_) {}
    var $ = function (id) { return el.querySelector('#' + id); };
    var stage = $('vtStage'), caseEl = $('vtCase'), cards = $('vtCards'), reveal = $('vtReveal'), acts = $('vtActs'), openBtn = $('vtOpen');

    /* the data lines behind the case: a canvas of drifting figures */
    var canvas = el.querySelector('.vt-lines'), ctx = canvas.getContext('2d'), raf = null, lines = [], t0 = 0;
    function sizeCanvas() { canvas.width = Math.floor(el.clientWidth * Math.min(2, root.devicePixelRatio || 1)); canvas.height = Math.floor(el.clientHeight * Math.min(2, root.devicePixelRatio || 1)); }
    function seedLines() {
      lines = [];
      var i, n = reduce ? 0 : 26;
      for (i = 0; i < n; i++) lines.push({ y: Math.random(), speed: 0.02 + Math.random() * 0.06, x: Math.random(), len: 0.08 + Math.random() * 0.22, a: 0.05 + Math.random() * 0.12, fig: figure() });
    }
    function figure() {
      var k = ['SPD', 'ACC', 'AGI', 'STR', 'AWR', 'OVR', 'RTE', 'CTH', 'TCK', 'PRSH'][Math.floor(Math.random() * 10)];
      return k + ' ' + (40 + Math.floor(Math.random() * 60));
    }
    var glow = 0.35, glowTarget = 0.35, dim = 0;
    function frame(ms) {
      raf = root.requestAnimationFrame(frame);
      if (!t0) t0 = ms;
      var dt = Math.min(0.05, (ms - (frame.last || ms)) / 1000); frame.last = ms;
      var w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      glow += (glowTarget - glow) * (1 - Math.pow(0.02, dt));
      var i, L;
      ctx.font = Math.round(h * 0.014) + 'px JetBrains Mono, monospace';
      for (i = 0; i < lines.length; i++) {
        L = lines[i];
        L.x += L.speed * dt; if (L.x > 1.1) { L.x = -L.len; L.y = Math.random(); L.fig = figure(); }
        ctx.strokeStyle = 'rgba(63,184,131,' + (L.a * glow * (1 - dim)) + ')'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(L.x * w, L.y * h); ctx.lineTo((L.x + L.len) * w, L.y * h); ctx.stroke();
        ctx.fillStyle = 'rgba(180,220,200,' + (L.a * 1.4 * glow * (1 - dim)) + ')';
        ctx.fillText(L.fig, (L.x + L.len) * w + 6, L.y * h + 4);
      }
      if (confettiBits.length) drawConfetti(dt);
    }
    var confettiBits = [];
    function confetti(n) {
      var i;
      for (i = 0; i < Math.min(140, n); i++) confettiBits.push({ x: 0.5 + (Math.random() - 0.5) * 0.3, y: 0.35, vx: (Math.random() - 0.5) * 0.9, vy: -0.6 - Math.random() * 0.9, r: Math.random() * 6.28, hue: [art.hue, '#ffffff', '#f2c744', '#5c9dff'][i % 4], life: 2.2 + Math.random() });
    }
    function drawConfetti(dt) {
      var w = canvas.width, h = canvas.height, i, b, keepBits = [];
      for (i = 0; i < confettiBits.length; i++) {
        b = confettiBits[i]; b.life -= dt; if (b.life <= 0) continue;
        b.vy += 1.6 * dt; b.x += b.vx * dt; b.y += b.vy * dt; b.r += dt * 4;
        ctx.save(); ctx.translate(b.x * w, b.y * h); ctx.rotate(b.r); ctx.globalAlpha = Math.min(1, b.life);
        ctx.fillStyle = b.hue; ctx.fillRect(-4, -2, 8, 4); ctx.restore();
        keepBits.push(b);
      }
      confettiBits = keepBits;
    }
    function startLines() { if (raf || reduce) return; sizeCanvas(); seedLines(); raf = root.requestAnimationFrame(frame); }
    function stopLines() { if (raf) { root.cancelAnimationFrame(raf); raf = null; } }
    var onResize = function () { sizeCanvas(); };
    root.addEventListener('resize', onResize);
    startLines();

    function later(fn, ms) { var id = setTimeout(function () { if (!closed) fn(); }, reduce ? Math.min(ms, 120) : ms); timers.push(id); return id; }
    function track(name, props) { if (o.track) { try { o.track(name, props || {}); } catch (_) {} } }

    /* ── THE SEQUENCE ─────────────────────────────────────────────────────
       lights dim → the case activates → a scan line crosses it → the case
       opens → the cards appear as silhouettes */
    function doOpen() {
      if (busy) return; busy = true;
      openBtn.disabled = true; openBtn.classList.add('gone');
      el.classList.add('vt-dim'); glowTarget = 0.9;
      SOUND.tick(); HAPTICS.buzz([12]);
      later(function () { caseEl.classList.add('live'); SOUND.scan(); HAPTICS.buzz([8, 40, 8]); }, 380);
      later(function () { caseEl.classList.add('scanned'); }, 1350);
      later(function () {
        caseEl.classList.add('opened'); SOUND.open(); HAPTICS.buzz([30, 30, 60]);
        track('pack_opened', { kind: pack.kind, size: men.length, keep: keep });
      }, 1750);
      later(function () { showSilhouettes(); }, 2350);
    }
    function showSilhouettes() {
      cards.hidden = false; cards.innerHTML = '';
      cards.classList.add('vt-n' + men.length);
      caseEl.classList.add('away');
      $('vtUnder').classList.add('gone');
      men.forEach(function (m, i) {
        var pl = plan(m), c = d.createElement('button');
        c.type = 'button'; c.className = 'vt-card vt-sil' + (pl.premium ? ' vt-premium' : pl.build ? ' vt-build' : '');
        c.setAttribute('data-i', String(i)); c.setAttribute('aria-label', 'Turn over card ' + (i + 1));
        c.style.animationDelay = (i * 0.12) + 's';
        c.innerHTML = '<span class="vt-sil-body"></span><span class="vt-sil-pos">' + esc(m.position || '') + '</span>'
          + '<span class="vt-sil-tap">Tap to reveal</span>';
        c.addEventListener('click', function () { flip(i, c); });
        cards.appendChild(c);
      });
      busy = false;
      /* a hint for the room: how many to keep */
      acts.hidden = false;
      acts.innerHTML = '<span class="vt-hint">' + esc(men.length) + ' men on the table · keep ' + esc(keep) + '. Turn them over.</span>';
    }
    function flip(i, c) {
      if (busy || flipped[i]) return;
      var m = men[i], pl = plan(m);
      flipped[i] = true; busy = true;
      SOUND.flip(); HAPTICS.buzz([10]);
      track('card_revealed', { kind: pack.kind, tier: pl.tier, overall: m.overall, position: m.position, premium: pl.premium });
      if (o.onReveal) { try { o.onReveal(m, pl); } catch (_) {} }
      if (pl.premium) return premiumReveal(i, c, m, pl);
      if (pl.build) return buildReveal(i, c, m, pl);
      turn(i, c, m, pl);
      later(function () { busy = false; afterFlip(); }, 500);
    }
    /* the card itself takes the place of its silhouette */
    function turn(i, c, m, pl) {
      c.classList.remove('vt-sil'); c.classList.add('vt-turned', 'vt-tier-' + pl.tier);
      c.innerHTML = '<div class="vt-face">' + (o.cardHtml ? o.cardHtml(m) : miniCard(m, pl)) + '</div>';
      c.setAttribute('aria-label', fullName(m) + ', ' + m.position + ', ' + m.overall + ' overall');
    }
    function miniCard(m, pl) {
      var sig = pl.signature;
      return '<div class="vt-mc"><div class="vt-mc-top"><span>' + esc(m.position) + '</span><span class="vt-mc-tier">' + esc(pl.tierName) + '</span></div>'
        + '<div class="vt-mc-ovr">' + esc(m.overall) + '<small>OVR</small></div>'
        + '<div class="vt-mc-name">' + esc(fullName(m)) + '</div>'
        + '<div class="vt-mc-arch">' + esc(m.archetype || '') + (sig ? ' · ' + esc(sig.value) + ' ' + esc(sig.label) : '') + '</div>'
        + (m.hometown ? '<div class="vt-mc-home">' + esc(m.hometown) + '</div>' : '') + '</div>';
    }
    /* a short build for a Prime or Elite man: three clues, then the card */
    function buildReveal(i, c, m, pl) {
      c.classList.add('vt-building');
      var idx = 0;
      function step() {
        var s = pl.steps[idx++];
        if (!s || s.kind === 'card') { turn(i, c, m, pl); SOUND.reveal(false); HAPTICS.buzz([20, 40, 20]); later(function () { busy = false; afterFlip(); }, 450); return; }
        c.innerHTML = '<span class="vt-sil-body"></span><span class="vt-clue"><i>' + esc(s.label || '') + '</i><b>' + esc(s.text) + '</b></span>';
        SOUND.clue();
        later(step, s.ms);
      }
      step();
    }
    /* THE PREMIUM REVEAL. The room goes to black, the rumble starts, and the
       man is told a fact at a time on the big stage before his card lands
       back in the row. */
    function premiumReveal(i, c, m, pl) {
      el.classList.add('vt-black'); dim = 0.7;
      cards.classList.add('vt-hold');
      reveal.hidden = false; reveal.innerHTML = '';
      SOUND.rumble(pl.total / 1000 + 0.5); HAPTICS.buzz([40, 60, 40, 60, 40]);
      var idx = 0;
      function step() {
        var s = pl.steps[idx++];
        if (!s) return;
        if (s.kind === 'card') {
          reveal.classList.add('vt-burst'); SOUND.reveal(true); HAPTICS.buzz([60, 40, 80, 40, 120]);
          if (pl.confetti && !reduce) confetti(120);
          track('rare_pull', { kind: pack.kind, tier: pl.tier, overall: m.overall, position: m.position, name: fullName(m) });
          later(function () {
            reveal.hidden = true; reveal.className = 'vt-reveal';
            el.classList.remove('vt-black'); dim = 0; cards.classList.remove('vt-hold');
            turn(i, c, m, pl); c.classList.add('vt-landed');
            busy = false; afterFlip();
          }, 1500);
          return;
        }
        var html = '';
        if (s.kind === 'mark') html = '<div class="vt-rv-mark">' + esc(s.text) + '</div>';
        else if (s.kind === 'clue') html = '<div class="vt-rv-clue"><i>' + esc(s.label) + '</i><b>' + esc(s.text) + '</b></div>';
        else if (s.kind === 'ovr') html = '<div class="vt-rv-ovr">' + esc(s.text) + '<small>OVR</small></div>';
        else if (s.kind === 'silhouette') html = '<div class="vt-rv-sil"><span></span></div>';
        else if (s.kind === 'name') html = '<div class="vt-rv-name">' + esc(s.text) + '</div>';
        reveal.innerHTML = '<div class="vt-rv-in">' + html + '</div>';
        reveal.className = 'vt-reveal vt-rv-' + s.kind;
        if (s.kind !== 'mark') SOUND.clue();
        if (s.kind === 'ovr') HAPTICS.buzz([30]);
        later(step, s.ms);
      }
      step();
    }
    /* once every card is over, the decision */
    function afterFlip() {
      var all = men.every(function (_, i) { return flipped[i]; });
      if (!all) { acts.innerHTML = '<span class="vt-hint">' + esc(men.filter(function (_, i) { return !flipped[i]; }).length) + ' still face down.</span>'; return; }
      renderActions();
    }
    function renderActions() {
      var left = keep - kept;
      acts.hidden = false;
      if (left <= 0) {
        acts.innerHTML = '<div class="vt-done"><b>' + (kept === 1 ? 'He is yours.' : 'They are yours.') + '</b>'
          + '<span>' + esc(kept) + ' kept · the rest passed over</span></div>'
          + '<div class="btn-row"><button class="btn btn-go" type="button" data-vt="done">Back to the Vault</button>'
          + '<a class="btn" href="/games/roster/">See the roster</a></div>';
        wireActs(); return;
      }
      acts.innerHTML = '<div class="vt-choose"><b>Keep ' + (left === 1 ? 'one' : String(left)) + '.</b><span>Tap a card to keep him'
        + (o.roomFull ? ' — the roster is full, so release someone on the roster first' : '') + '.</span></div>'
        + '<div class="vt-pick">' + men.map(function (m, i) {
            if (m.kept) return '';
            var pl = plan(m);
            return '<button class="btn vt-keep" type="button" data-keep="' + esc(i) + '"' + (o.roomFull ? ' disabled' : '') + '>'
              + 'Keep ' + esc(m.position) + ' ' + esc(fullName(m)) + ' <small>' + esc(m.overall) + ' · ' + esc(pl.tierName) + '</small></button>';
          }).join('') + '</div>'
        + '<div class="btn-row"><button class="btn btn-ghost" type="button" data-vt="pass">Pass on ' + (kept ? 'the rest' : 'the whole pack') + '</button>'
        + (kept ? '<button class="btn" type="button" data-vt="done">Done</button>' : '') + '</div>';
      wireActs();
    }
    function wireActs() {
      Array.prototype.forEach.call(acts.querySelectorAll('[data-keep]'), function (b) {
        b.addEventListener('click', function () {
          if (busy) return; busy = true;
          var i = parseInt(b.getAttribute('data-keep'), 10), m = men[i];
          b.disabled = true; b.textContent = 'Signing…';
          Promise.resolve(o.onKeep ? o.onKeep(m) : { ok: true }).then(function (r) {
            busy = false;
            if (r && r.ok === false) { b.disabled = false; b.textContent = 'Keep ' + m.position + ' ' + fullName(m); acts.insertAdjacentHTML('afterbegin', '<div class="vt-err">' + esc(r.message || 'That did not go through.') + '</div>'); return; }
            m.kept = true; kept++;
            var c = cards.querySelector('[data-i="' + i + '"]'); if (c) c.classList.add('vt-kept');
            track('pack_kept', { kind: pack.kind, tier: plan(m).tier, overall: m.overall, position: m.position });
            SOUND.reveal(false); HAPTICS.buzz([20, 30, 40]);
            if (r && r.keep_left != null) kept = keep - r.keep_left;
            if (kept >= keep) men.forEach(function (x) { if (!x.kept) x.passed = true; });
            renderActions();
          });
        });
      });
      Array.prototype.forEach.call(acts.querySelectorAll('[data-vt]'), function (b) {
        b.addEventListener('click', function () {
          var what = b.getAttribute('data-vt');
          if (what === 'done') { close(); if (o.onDone) o.onDone(); return; }
          if (what === 'pass') {
            if (busy) return; busy = true; b.disabled = true;
            Promise.resolve(o.onPass ? o.onPass() : { ok: true }).then(function (r) {
              busy = false;
              if (r && r.ok === false) { b.disabled = false; return; }
              track('pack_passed', { kind: pack.kind, kept: kept });
              close(); if (o.onDone) o.onDone();
            });
          }
        });
      });
    }
    function close() {
      if (closed) return; closed = true;
      timers.forEach(clearTimeout); stopLines();
      root.removeEventListener('resize', onResize);
      el.classList.add('vt-out');
      try { d.body.classList.remove('vault-open'); } catch (_) {}
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 320);
    }
    openBtn.addEventListener('click', doOpen);
    el.querySelector('.vt-x').addEventListener('click', function () { close(); if (o.onDone) o.onDone(); });
    /* the pack was already open on the table (a refresh mid-reveal): straight to the cards */
    if (o.alreadyOpen) { openBtn.hidden = true; el.classList.add('vt-dim'); caseEl.classList.add('live', 'scanned', 'opened'); later(showSilhouettes, 300); }
    setTimeout(function () { el.classList.add('on'); }, 20);
    return { close: close, el: el, plan: plan };
  }
  function oddsLine(od) {
    if (!od || !od.tiers) return '';
    var order = ['prospect', 'starter', 'impact', 'prime', 'elite', 'apex', 'legend', 'mythic'], out = [];
    order.forEach(function (k) { var v = +od.tiers[k]; if (v > 0) out.push('<em>' + esc(tierName(k)) + ' ' + esc(v) + '%</em>'); });
    var s = 'Odds by tier · OVR ' + esc(od.low) + '–' + esc(od.high) + ': ' + out.join(' ');
    if (od.guarantee) s += ' · one man <b>' + esc(tierName(od.guarantee)) + '+</b> guaranteed';
    if (od.pity && od.pity.active) s += ' · <b>protection active</b>: the ceiling is lifted and a Prime man is guaranteed';
    return s;
  }

  var API = { plan: plan, signature: signature, tierOf: tierOf, tierName: tierName, artOf: artOf, ART: ART, PREMIUM: PREMIUM,
              open: open, oddsLine: oddsLine, SOUND: SOUND, fullName: fullName };
  root.EDVault = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
