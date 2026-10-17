/* ===========================================================================
   EdgeDesk GAME RESEARCH VIEW — #game/<nfl|cfb>/<game_id>
   Browser only: window.EDGameView. docs/game-research/README.md

   THE ORDER OF THE PAGE (model first, market last)
     0  status: research · model · market · betting decision, four separate answers
     1  the matchup graphic (lib/edgedesk_game_graphic.js), with Download,
        Share, Copy link, Save, Compare my number, Explore research
     2  the overview: kickoff, projected winner and score, fair spread and
        total, both win probabilities, data confidence, snapshot time
     3  what to watch for: the snapshot's measured insights, in words
     3b the Research Grade Breakdown (lib/edgedesk_grade_ui.js): the A–F grade
        of the research itself, locked in the performance ledger, with every
        part of it explained; absent when the page has no grade module
     4  deep research at three levels: Beginner · Research · Lab
     5  market comparison, only from a current quote; otherwise one plain note
     6  compare a sportsbook price the reader types in (user-entered, unverified)

   WHAT IT READS
     football/game_research/current.json        Layer A, one snapshot per game
     football/game_research/probabilities.json  the snapshot's own probability
                                                sheet, only when a price is checked
     opts.market(league, gid) → Promise<{ market, decision, live }>
                                                Layer B and the existing decision,
                                                supplied by the page (app.html);
                                                its absence touches nothing above it
   Nothing here computes a projection or a probability: the snapshot carries
   the model's numbers, EDGameSnapshot labels them, EDFairLine prices a typed
   quote on the snapshot's own sheet.
   =========================================================================== */
(function (root) {
  'use strict';
  var V = { VERSION: 'edgedesk_game_view/1' };
  var LEVEL_KEY = 'edgedesk_info_level_v1';
  var S = { el: null, opts: {}, data: null, dataAt: 0, loading: null, probs: null, probsP: null, flP: null,
    league: null, gid: null, format: 'square', level: null, mk: null, mkFor: null, mkP: null, img: null, price: { market: 'spread' }, priceOut: null };

  function GS() { return root.EDGameSnapshot; }
  function FLN() { return root.EDFootballLines || null; }
  function GG() { return root.EDGameGraphic; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function pct1(p) { p = num(p); return p == null ? '—' : (Math.round(p * 1000) / 10).toFixed(1) + '%'; }
  function am(a) { a = num(a); return a == null ? '—' : (a > 0 ? '+' : '') + Math.round(a); }
  function signed(v) { v = num(v); return v == null ? '—' : (v === 0 ? 'PK' : (v > 0 ? '+' : '') + v.toFixed(1)); }
  function store() { try { return root.localStorage || null; } catch (_) { return null; } }
  function levelGet() {
    if (S.level) return S.level;
    try { var v = store() && store().getItem(LEVEL_KEY); v = v ? JSON.parse(v) : null; if (v === 'beginner' || v === 'research' || v === 'lab') return (S.level = v); } catch (_) { /* default */ }
    return (S.level = 'research');
  }
  function levelSet(v) { S.level = v; try { store() && store().setItem(LEVEL_KEY, JSON.stringify(v)); } catch (_) { /* memory only */ } }
  function ago(iso) {
    var t = Date.parse(iso); if (!isFinite(t)) return '';
    var m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'just now'; if (m < 60) return m + ' min ago'; if (m < 48 * 60) return Math.round(m / 60) + ' h ago';
    return Math.round(m / 1440) + ' days ago';
  }
  function stamp(iso) { var g = GG(); return (g && g.stamp(iso)) || (iso ? String(iso).slice(0, 16).replace('T', ' ') + ' UTC' : '—'); }
  function track(name, props) { try { if (S.opts.track) S.opts.track(name, props || {}); } catch (_) { /* never fails the page */ } }

  /* ------------------------------------------------------------ data */
  V.DATA_URL = '/football/game_research/current.json';
  V.PROB_URL = '/football/game_research/probabilities.json';
  V.FAIRLINE_SRC = '/lib/edgedesk_fairline.js?v=20261011lm1';
  function getJson(url) {
    var bucket = Math.floor(Date.now() / (5 * 60000));
    return fetch(url + (url.indexOf('?') >= 0 ? '&' : '?') + 't=' + bucket, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error(url + ' answered ' + r.status);
      return r.json();
    });
  }
  V.load = function (force) {
    if (!force && S.data && Date.now() - S.dataAt < 10 * 60000) return Promise.resolve(S.data);
    if (S.loading) return S.loading;
    S.loading = getJson(S.opts.dataUrl || V.DATA_URL).then(function (d) { S.data = d; S.dataAt = Date.now(); S.loading = null; return d; })
      .catch(function (e) { S.loading = null; throw e; });
    return S.loading;
  };
  V.snapshot = function (league, gid) {
    var key = league + '|' + gid;
    return S.data ? (S.data.games || []).filter(function (g) { return g.game_key === key; })[0] || null : null;
  };
  function loadProbs() {
    if (S.probs) return Promise.resolve(S.probs);
    if (!S.probsP) S.probsP = getJson(S.opts.probUrl || V.PROB_URL).then(function (p) { S.probs = p; return p; }).catch(function (e) { S.probsP = null; throw e; });
    return S.probsP;
  }
  function loadFairLine() {
    if (root.EDFairLine && root.EDFairLine.priceCheck) return Promise.resolve(root.EDFairLine);
    if (!S.flP) S.flP = new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = S.opts.fairlineSrc || V.FAIRLINE_SRC;
      s.onload = function () { root.EDFairLine ? res(root.EDFairLine) : rej(new Error('the pricing library did not load')); };
      s.onerror = function () { S.flP = null; rej(new Error('the pricing library did not load')); };
      document.head.appendChild(s);
    });
    return S.flP;
  }

  /* ------------------------------------------------------------ routing */
  V.mount = function (el, opts) { S.el = el; S.opts = opts || {}; el.addEventListener('click', onClick); el.addEventListener('submit', onSubmit); el.addEventListener('change', onChange); };
  V.parseHash = function (h) {
    var m = String(h || '').match(/^#game\/(nfl|cfb)\/([^?\/]+)(?:\?(.*))?$/);
    if (!m) return null;
    var q = {}; (m[3] || '').split('&').forEach(function (kv) { var p = kv.split('='); if (p[0]) q[p[0]] = decodeURIComponent(p[1] || ''); });
    return { league: m[1], gid: decodeURIComponent(m[2]), format: q.f === 'portrait' ? 'portrait' : 'square' };
  };
  V.hashFor = function (league, gid) { return '#game/' + league + '/' + encodeURIComponent(gid); };
  V.openHash = function (h, o) { var p = V.parseHash(h); if (!p) return false; S.format = p.format; return V.open(p.league, p.gid, o); };
  /* o.fallback: a game with no snapshot goes to the page's own game card
     (opts.missing) instead of an empty page */
  V.open = function (league, gid, o) {
    o = o || {};
    if (S.league !== league || S.gid !== String(gid)) { S.mk = null; S.mkFor = null; S.img = null; S.priceOut = null; S.price = { market: 'spread' }; }
    S.league = league; S.gid = String(gid);
    track('game_research_open', { entity: league + ':' + gid });
    paint();
    return V.load().then(function () {
      if (o.fallback && !V.snapshot(league, gid) && S.opts.missing) { S.opts.missing(league, String(gid)); return; }
      paint(); joinMarket();
    }).catch(function (e) { if (o.fallback && S.opts.missing) { S.opts.missing(league, String(gid)); return; } paintError(e); });
  };

  /* Layer B: asked for, never waited on. The model is on screen first. */
  function joinMarket() {
    var key = S.league + '|' + S.gid;
    if (!S.opts.market || S.mkFor === key) return;
    S.mkFor = key;
    S.mkP = Promise.resolve().then(function () { return S.opts.market(S.league, S.gid); }).then(function (r) {
      if (S.league + '|' + S.gid !== key) return;
      S.mk = r || { market: null, decision: null, live: null, loaded: true };
      paint();
    }).catch(function () { if (S.league + '|' + S.gid === key) { S.mk = { market: null, decision: null, live: null, loaded: true, error: true }; paint(); } });
  }

  /* ------------------------------------------------------------ painting */
  function paintError(e) {
    if (!S.el) return;
    S.el.innerHTML = '<div class="gv"><div class="gv-back"><button type="button" class="gv-link" data-gv-act="back">← Back</button></div>'
      + '<div class="gv-empty"><b>Game research could not load.</b> ' + esc(e && e.message || e) + '. EdgeDesk’s research files are static and usually return on a refresh.'
      + ' <button type="button" class="gv-btn" data-gv-act="retry">Try again</button></div></div>';
  }
  function paint() {
    if (!S.el) return;
    if (!S.data) {
      S.el.innerHTML = '<div class="gv" aria-busy="true"><div class="gv-back"><button type="button" class="gv-link" data-gv-act="back">← Back</button></div>'
        + '<div class="gv-fig gv-skel" style="aspect-ratio:1/1"></div><div class="gv-skel" style="height:120px;margin-top:14px"></div></div>';
      return;
    }
    var s = V.snapshot(S.league, S.gid);
    if (!s) {
      S.el.innerHTML = '<div class="gv"><div class="gv-back"><button type="button" class="gv-link" data-gv-act="back">← Back</button></div>'
        + '<div class="gv-empty"><b>No research snapshot for this game.</b> EdgeDesk keeps snapshots for upcoming NFL and FBS games, and for a day and a half after kickoff. '
        + 'The snapshot list was built ' + esc(ago(S.data.generated_at)) + '.'
        + (S.opts.boardCard ? ' <button type="button" class="gv-btn" data-gv-act="board">Open the football board</button>' : '') + '</div></div>';
      return;
    }
    var X = GS(), mk = S.mk ? X.market(S.mk.market) : null, av = X.availability(s, mk, S.mk && S.mk.decision);
    var h = '<article class="gv" data-gv-key="' + esc(s.game_key) + '">';
    h += '<div class="gv-back"><button type="button" class="gv-link" data-gv-act="back">← Back</button>'
      + '<span class="gv-crumb">' + esc(s.league === 'nfl' ? 'NFL' : 'College football') + (s.week_label ? ' · ' + esc(s.week_label) : '') + '</span></div>';
    h += '<h1 class="gv-title">' + esc(s.away.name) + ' <span>at</span> ' + esc(s.home.name) + '</h1>';
    h += statusStrip(s, av, mk);
    h += graphicBlock(s);
    h += overview(s, av);
    h += watchFor(s);
    h += altitudeSection(s);
    h += gradeSection(s);
    h += deep(s, mk);
    h += marketSection(s, mk, av);
    h += priceSection(s);
    h += '<p class="gv-foot">Research, not picks. EdgeDesk’s numbers are model estimates: they can be wrong, and nothing here guarantees an outcome. 21+ · Bet responsibly · 1-800-GAMBLER.</p>';
    h += '</article>';
    S.el.innerHTML = h;
    drawGraphic(s, mk);
  }

  function chip(k, v, tone) { return '<span class="gv-chip gv-' + tone + '"><span class="gv-ck">' + esc(k) + '</span> ' + esc(v) + '</span>'; }
  function statusStrip(s, av, mk) {
    var mTone = av.market === 'LIVE' ? 'ok' : (av.market === 'FAULT' ? 'bad' : 'mute');
    var mText = !S.mk ? 'checking…' : (av.market === 'UNAVAILABLE' ? 'unavailable' : (mk && mk.label ? mk.label.toLowerCase() : av.market.toLowerCase()));
    return '<div class="gv-status" role="status" aria-label="Research status">'
      + chip('Research', av.research.toLowerCase(), av.research === 'AVAILABLE' ? 'ok' : 'warn')
      + chip('Model', av.model.toLowerCase(), av.model === 'ACTIVE' ? 'ok' : (av.model === 'DATA FAULT' ? 'bad' : 'warn'))
      + chip('Market', mText, mTone)
      + chip('Betting decision', S.mk ? (av.decision_label ? av.decision_label : av.decision.toLowerCase()) : '…', av.decision === 'EVALUATED' ? 'ok' : 'mute')
      + '</div>';
  }

  /* 1 — the graphic and its actions */
  function graphicBlock(s) {
    var started = s.started ? '<div class="gv-note">This game has kicked off. This is the research snapshot EdgeDesk froze before kickoff (' + esc(stamp(s.frozen_at || s.generated_at)) + '); nothing on it is recomputed.</div>' : '';
    return '<section class="gv-sec gv-graphic" aria-label="Matchup graphic">' + started
      + '<figure class="gv-fig" style="aspect-ratio:' + (S.format === 'portrait' ? '1080/1350' : '1/1') + '"><div class="gv-skel gv-figskel"></div><img id="gvImg" alt="" hidden></figure>'
      + '<div class="gv-fmt" role="group" aria-label="Graphic format">'
      + ['square', 'portrait'].map(function (f) { return '<button type="button" class="gv-seg' + (S.format === f ? ' on' : '') + '" aria-pressed="' + (S.format === f) + '" data-gv-act="format" data-gv-v="' + f + '">' + (f === 'square' ? 'Square 1080×1080' : 'Portrait 1080×1350') + '</button>'; }).join('')
      + '</div>'
      + '<div class="gv-acts">'
      + '<button type="button" class="gv-btn gv-primary" data-gv-act="download">Download PNG</button>'
      + '<button type="button" class="gv-btn" data-gv-act="share">Share</button>'
      + '<button type="button" class="gv-btn" data-gv-act="copy">Copy link</button>'
      + (S.opts.starHTML && !s.started ? '<span class="gv-star">' + S.opts.starHTML(s.league, s.game_id, { home: s.home.name, away: s.away.name, kickoff: Date.parse(s.kickoff) }) + '</span>' : '')
      + '<button type="button" class="gv-btn" data-gv-act="compare">Compare my number</button>'
      + '<button type="button" class="gv-btn" data-gv-act="explore">Explore research ↓</button>'
      + '</div><div class="gv-msg" id="gvMsg" role="status" aria-live="polite"></div></section>';
  }
  function graphicMarket(mk) { return mk && mk.current && mk.state === 'LIVE' ? mk : null; }
  function drawGraphic(s, mk) {
    var G = GG(), img = document.getElementById('gvImg');
    if (!G || !img) return;
    var spec = GS().graphicSpec(s), m = graphicMarket(mk), fmt = S.format;
    G.render(spec, m, fmt, { now: Date.now() }).then(function (r) {
      var im = document.getElementById('gvImg');
      if (!im || S.league + '|' + S.gid !== s.game_key || S.format !== fmt) return;
      S.img = r;
      im.src = r.url; im.alt = r.alt; im.hidden = false;
      var sk = im.parentNode.querySelector('.gv-figskel'); if (sk) sk.remove();
    }).catch(function (e) {
      var fig = img.parentNode; if (fig) fig.innerHTML = '<div class="gv-empty">The graphic could not be drawn: ' + esc(e && (e.message || e.reason) || e) + '. Every number below is unaffected.</div>';
    });
  }

  /* 2 — the overview, in the page's own type */
  function overview(s, av) {
    var M = s.model, k = s.kickoff_text || {};
    var h = '<section class="gv-sec" aria-label="Game overview"><h2 class="gv-h">Game overview</h2>';
    h += '<div class="gv-kick">' + esc(k.date || '') + (k.time ? ' · ' + esc(k.time) : '') + (s.venue ? ' · ' + esc(s.venue) : '') + (s.context ? ' · ' + esc(s.context) : '') + (s.neutral_site ? ' · neutral site' : '') + '</div>';
    if (!M.available) {
      return h + '<div class="gv-limit"><b>Research limitation.</b> ' + esc(cap(M.reason || 'the model has no projection for this game')) + '. EdgeDesk does not estimate a number it cannot support, so no projected score, spread, total or win probability is shown.</div></section>';
    }
    /* model.display (lib/edgedesk_football_lines.js) when the snapshot has
       one; a snapshot published before it keeps its own numbers */
    var D = M.display, fav = D ? D.spread.favorite : M.fair.favorite, favName = fav ? s[fav].name : null;
    h += '<div class="gv-grid">'
      + tile('Projected winner', favName ? esc(favName) : 'Even', favName ? esc((fav === 'home' ? M.win_display.home : M.win_display.away)) + ' model win probability' : 'pick’em')
      + (D ? tile('Projected score', esc(s.away.short || s.away.name) + ' ' + esc(D.score.away) + '<br>' + esc(s.home.short || s.home.name) + ' ' + esc(D.score.home), 'whole points · expected points in Research')
        : tile('Projected score', esc(s.away.short || s.away.name) + ' ' + esc(M.scores.away.toFixed(M.scores.decimals)) + '<br>' + esc(s.home.short || s.home.name) + ' ' + esc(M.scores.home.toFixed(M.scores.decimals)), 'adds to the total, differs by the margin'))
      + tile('Fair spread', esc(D ? D.spread.text : M.fair.text), 'EdgeDesk model · not a sportsbook line')
      + tile('Fair total', esc(D ? D.total.text : M.total.toFixed(1)), 'projected combined points')
      + tile('Win probability', esc(s.away.short || s.away.name) + ' ' + esc(M.win_display.away) + '<br>' + esc(s.home.short || s.home.name) + ' ' + esc(M.win_display.home), 'EdgeDesk model, not market-implied')
      + tile('Model moneyline', esc(s.away.abbr) + ' ' + esc(am(M.fair_ml.away)) + '<br>' + esc(s.home.abbr) + ' ' + esc(am(M.fair_ml.home)), 'a restatement of the win probability · not a price')
      + tile(s.confidence.kind === 'reliability' ? 'Reliability' : 'Data check', esc(s.confidence.kind === 'reliability' ? (s.confidence.score != null ? Math.round(s.confidence.score) + '/100' + (s.confidence.grade ? ' · ' + String(s.confidence.grade).replace(/_/g, ' ').toLowerCase() : '') : 'not scored') : s.confidence.label.replace(/^Data check: /, '')),
        '<button type="button" class="gv-link" data-gv-act="define" data-gv-v="' + (s.confidence.kind === 'reliability' ? 'reliability' : 'data_check') + '">What is this?</button>', true)
      + '</div>';
    h += '<div class="gv-def" id="gvDef" hidden></div>';
    h += '<div class="gv-snap">Snapshot ' + esc(stamp(M.built_at || s.generated_at)) + ' · model ' + esc(M.version || '') + ' · <span class="mono">' + esc(s.snapshot_id) + '</span>'
      + (S.data && S.data.generated_at ? ' · checked ' + esc(ago(S.data.generated_at)) : '') + '</div>';
    h += liveDivergence(s);
    if (s.data.status === 'FAULT') h += '<div class="gv-fault"><b>Data fault.</b> This snapshot failed its own consistency checks (' + esc((s.data.faults || []).join('; ')) + '). Read every number as research only until the next snapshot passes.</div>';
    else if ((s.data.warnings || []).length) h += '<div class="gv-warnbox"><b>Data note.</b> ' + s.data.warnings.map(esc).join(' ') + '</div>';
    return h + '</section>';
  }
  function tile(k, v, sub, rawSub) { return '<div class="gv-tile"><div class="gv-k">' + esc(k) + '</div><div class="gv-v">' + v + '</div><div class="gv-s">' + (rawSub ? sub : esc(sub)) + '</div></div>'; }
  function cap(t) { t = String(t || ''); return t.charAt(0).toUpperCase() + t.slice(1); }
  /* the live board can carry newer inputs than the hourly snapshot: say so,
     never blend the two */
  function liveDivergence(s) {
    var L = S.mk && S.mk.live, M = s.model;
    if (!L || !M.available || s.started) return '';
    var dl = num(L.home_line) != null ? Math.abs(num(L.home_line) - M.fair.home_line) : 0, dt = num(L.total) != null ? Math.abs(num(L.total) - M.total) : 0;
    if (dl < 0.25 && dt < 0.25) return '';
    return '<div class="gv-note">The live board currently projects ' + esc(GS() && L.home_line != null ? modelLine(s, L.home_line) : '—') + (L.total != null ? ', total ' + esc(modelTotal(L.total)) : '')
      + ' from inputs that changed after this snapshot. This page keeps the snapshot’s numbers together; the next hourly snapshot will pick the change up.</div>';
  }
  function fav(s, homeLine) { homeLine = num(homeLine); if (homeLine == null) return '—'; if (Math.abs(homeLine) < 0.05) return 'pick’em'; return homeLine < 0 ? s.home.name + ' ' + homeLine.toFixed(1) : s.away.name + ' ' + (-homeLine).toFixed(1); }
  /* a MODEL line or total (book convention for the home team) as a football
     line, and a SPORTSBOOK line exactly as received */
  function modelLine(s, homeLine) { var F = FLN(); homeLine = num(homeLine); return F && homeLine != null ? F.spread(homeLine === 0 ? 0 : -homeLine, { home: s.home.name, away: s.away.name }).text : fav(s, homeLine); }
  function modelTotal(t) { var F = FLN(); return F ? F.total(t).text : (num(t) == null ? '—' : num(t).toFixed(1)); }
  function bookLine(s, homeLine) { var F = FLN(); return F ? F.marketSpread(homeLine, { home: s.home.name, away: s.away.name }).text : fav(s, homeLine); }
  function bookTotal(t) { var F = FLN(); return F ? F.exactTotalText(t) : (num(t) == null ? '—' : num(t).toFixed(1)); }

  /* 3 — what to watch for */
  function watchFor(s) {
    var I = s.insights || [];
    var h = '<section class="gv-sec" aria-label="What to watch for"><h2 class="gv-h">What to watch for</h2>';
    if (!I.length) return h + '<p class="gv-p">' + (s.model.available ? 'No measured matchup gap is large enough to call out for this game.' : 'No insights without a projection: EdgeDesk does not describe a matchup its model cannot price.') + '</p></section>';
    h += '<ul class="gv-ins">' + I.map(function (i) {
      return '<li><span class="gv-ico gv-ico-' + esc(i.icon) + '" aria-hidden="true"></span><div><div class="gv-it">' + esc(i.title) + '</div><p>' + esc(i.text) + '</p><div class="gv-src">' + esc(evidence(s, i)) + '</div></div></li>';
    }).join('') + '</ul>';
    return h + '</section>';
  }
  function evidence(s, i) {
    var e = i.evidence || {};
    if (e.units) return 'Source: ' + (s.units && s.units.label ? s.units.label + ', ' : '') + (s.units ? s.units.source : '') + (s.units && s.units.as_of ? ' · ' + stamp(s.units.as_of) : '');
    if (e.term) return 'Source: the projection’s own ' + (e.term === 'hfa' || e.term === 'baseline' ? 'home-field' : '') + ' term · ' + (s.model.version || '');
    if (e.status) return 'Source: the starter feed (' + e.status.toLowerCase().replace(/_/g, ' ') + ')';
    if (e.as_of) return 'Source: kickoff forecast · ' + stamp(e.as_of);
    return '';
  }

  /* 3a — ALTITUDE & TRAVEL (football/altitude): where the game is played
     against where each team normally plays, the trip, and the record's
     verdict on whether any of it belongs in the number. Every figure is the
     snapshot's; the impact row is the engine's own contribution, so the page
     can never show a point the projection did not move. Absent on a snapshot
     built before the section existed, and on NFL. */
  function altitudeSection(s) {
    var A = s.altitude_travel;
    if (!A || s.league !== 'cfb') return '';
    var f = A.focus === 'home' ? A.home : A.away, o = A.focus === 'home' ? A.away : A.home;
    var ft = function (x) { x = num(x); return x == null ? 'unavailable' : Math.round(x).toLocaleString('en-US') + ' ft'; };
    var sgn = function (x) { x = num(x); return x == null ? 'unavailable' : (x > 0 ? '+' : (x < 0 ? '\u2212' : '')) + Math.abs(Math.round(x)).toLocaleString('en-US') + ' ft'; };
    var SUP = { SUPPORTED: 'Supported', SUGGESTIVE: 'Suggestive, not established', NOT_ESTABLISHED: 'Not established' };
    var h = '<section class="gv-sec gv-alt" aria-label="Altitude and travel">'
      + '<div class="gv-alt-top"><h2 class="gv-h">Altitude &amp; travel</h2><span class="gv-ptag">' + (A.adjustment.applied ? 'In the number' : 'Research only') + '</span></div>';
    if (A.venue) h += '<p class="gv-kick">' + esc(A.venue.name) + (A.neutral_site ? ' \u00b7 neutral site' : '') + '</p>';
    if (!A.venue && !A.usable) {
      return h + '<p class="gv-p">Elevation is unavailable for this game: ' + esc(A.missing.join('; ') || 'no sourced elevation') + '. EdgeDesk never estimates a missing elevation.</p></section>';
    }
    h += '<div class="gv-grid">'
      + tile('Venue', esc(ft(A.venue && A.venue.elev_ft)), 'above sea level')
      + tile(f.team + ' normal', esc(ft(f.usual_elev_ft)), f.usual_venue || 'normal home venue')
      + tile('Elevation change', esc(sgn(f.gain_ft)), A.exposure.label || '')
      + '</div>';
    var trip = [];
    if (num(f.distance_mi) != null && f.distance_mi > 0) trip.push(esc(f.team) + ' travels about ' + Math.round(f.distance_mi).toLocaleString('en-US') + ' miles');
    if (num(f.tz_change_h) != null && f.tz_change_h !== 0) trip.push(Math.abs(f.tz_change_h) + ' time zone' + (Math.abs(f.tz_change_h) === 1 ? '' : 's') + ' ' + (f.tz_change_h < 0 ? 'west' : 'east'));
    if (num(f.rest_days) != null && num(o.rest_days) != null) trip.push('rest ' + f.rest_days + ' days vs ' + o.rest_days);
    if (A.neutral_site) trip.push('neutral site: both teams travel');
    if (trip.length) h += '<p class="gv-p gv-dim">' + trip.join(' \u00b7 ') + '.</p>';
    if (A.interpretation.length) h += '<h3 class="gv-h3">Research interpretation</h3><p class="gv-p">' + A.interpretation.map(esc).join(' ') + '</p>';
    h += '<table class="gv-tbl"><tbody>'
      + row('Statistical support', esc(SUP[A.support.state] || A.support.state) + (A.support.text ? '<div class="gv-s">' + esc(A.support.text.replace(/^[^:]*:\s*/, '').replace(/^./, function (c) { return c.toUpperCase(); })) + '</div>' : ''))
      + row('Validated model adjustment', esc(A.model_label))
      + row('Impact on EdgeDesk\u2019s number', A.adjustment.applied
        ? esc((A.adjustment.applied_points >= 0 ? '+' : '') + A.adjustment.applied_points.toFixed(1) + ' pts')
        : '0.0 pts <span class="gv-s">pending validation</span>')
      + '</tbody></table>';
    var lab = [];
    if (num(A.adjustment.shadow_points) != null && !A.adjustment.applied) lab.push(row('Shadow estimate', esc((A.adjustment.shadow_points >= 0 ? '+' : '') + A.adjustment.shadow_points.toFixed(2) + ' pts toward the home side, NOT in the number')
      + '<div class="gv-s">' + esc(A.adjustment.model || '') + ' \u00b7 ' + esc(A.adjustment.model_version || '') + ' \u00b7 ' + esc(A.adjustment.reason) + '</div>'));
    if (f.ratio != null) lab.push(row('Elevation ratio', esc(f.ratio.toFixed(2) + '\u00d7') + '<div class="gv-s">Descriptive only: a sea-level team reaches 6\u00d7 at a 60 ft venue, so the ratio is not used by the model.</div>'));
    lab.push(row('Acclimatization proxies', esc(f.team + (f.resident_high ? ' plays its home games above 3,000 ft' : ' does not play its home games above 3,000 ft')
      + (f.recent_high_exposure ? '; its previous game was also above 3,000 ft' : '')) + '<div class="gv-s">Schedule proxies only; no training or physiological data exists.</div>'));
    if (A.provenance.length) lab.push(row('Elevation sources', A.provenance.map(esc).join('<br>')));
    if (A.missing.length) lab.push(row('Unavailable', A.missing.map(esc).join('<br>')));
    h += '<details class="gv-alt-lab"><summary>Data and method</summary><table class="gv-tbl"><tbody>' + lab.join('') + '</tbody></table>'
      + '<div class="gv-s">' + esc(A.not_claimed) + ' Method and record: docs/cfb-altitude/BACKTEST.md.</div></details>';
    return h + '</section>';
  }

  /* 3b — the research grade: how complete, current and checked the research is (not a pick) */
  function gradeSection(s) {
    var U = root.EDGradeUI;
    if (!U) return '';
    U.load();
    return '<section class="gv-grade" aria-label="Research grade">' + U.breakdown(U.keyFor(s.league, s.game_id), { started: !!s.started }) + '</section>';
  }

  /* 4 — deep research at three levels */
  function deep(s, mk) {
    var lv = levelGet();
    var h = '<section class="gv-sec" id="gvDeep" aria-label="Deep research"><h2 class="gv-h">Deep research</h2>'
      + '<div class="gv-levels" role="tablist" aria-label="Information level">'
      + [['beginner', 'Beginner'], ['research', 'Research'], ['lab', 'Lab']].map(function (l) {
        return '<button type="button" role="tab" aria-selected="' + (l[0] === lv) + '" class="gv-seg' + (l[0] === lv ? ' on' : '') + '" data-gv-act="level" data-gv-v="' + l[0] + '">' + l[1] + '</button>';
      }).join('') + '</div><div class="gv-lvbody" role="tabpanel">';
    if (lv === 'beginner') h += beginnerBody(s);
    else if (lv === 'lab') h += labBody(s, mk);
    else h += researchBody(s);
    h += '</div>';
    if (S.opts.boardCard) h += '<div class="gv-more"><button type="button" class="gv-link" data-gv-act="board">Open this game’s full card on the football board →</button></div>';
    return h + '</section>';
  }
  function beginnerBody(s) {
    var b = GS().beginner(s), h = '<p class="gv-lead">' + esc(b.lead) + '</p>';
    if (b.points.length) h += '<ul class="gv-bul">' + b.points.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul>';
    var w = whatChanges(s);
    if (w.length) h += '<h3 class="gv-h3">What could change it</h3><ul class="gv-bul">' + w.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul>';
    return h;
  }
  function whatChanges(s) {
    var out = [];
    ['away', 'home'].forEach(function (k) {
      var q = s.qb && s.qb[k];
      if (q && !q.confirmed) out.push(q.name ? s[k].name + '’s starting quarterback is not confirmed (' + q.name + ' is assumed' + (q.basis ? ': ' + q.basis : '') + ').' : 'No starting quarterback is named for ' + s[k].name + '.');
    });
    (s.risks || []).forEach(function (r) { out.push(r.text); });
    if (s.confidence && s.confidence.main_deduction) out.push('Reliability’s main deduction: ' + s.confidence.main_deduction);
    return out.slice(0, 5);
  }
  function rankBar(x, of) { if (!x || !of) return '<span class="gv-na">—</span>'; var w = Math.max(4, Math.round(100 * (1 - (x.rank - 1) / of))); return '<span class="gv-rank">#' + x.rank + '</span><span class="gv-bar"><i style="width:' + w + '%"></i></span>'; }
  function researchBody(s) {
    var M = s.model, h = '';
    if (M.available) {
      h += '<h3 class="gv-h3">The projection</h3><table class="gv-tbl"><tbody>'
        + (M.display ? displayRows(s, M.display)
          : row('Fair spread', esc(M.fair.text) + (M.fair.near_pickem ? ' <span class="gv-tag">near pick’em</span>' : ''))
          + row('Projected margin', esc((M.home_margin >= 0 ? s.home.name : s.away.name) + ' by ' + Math.abs(M.home_margin).toFixed(2)))
          + row('Fair total', esc(M.total.toFixed(1)))
          + row('Projected score', esc(M.scores.text) + (M.scores.note ? '<div class="gv-s">' + esc(M.scores.note) + '</div>' : '')))
        + row('Win probability', esc(s.away.name) + ' ' + pct1(M.win_prob.away) + ' · ' + esc(s.home.name) + ' ' + pct1(M.win_prob.home))
        + row('Model moneyline', esc(s.away.abbr) + ' ' + am(M.fair_ml.away) + ' · ' + esc(s.home.abbr) + ' ' + am(M.fair_ml.home) + '<div class="gv-s">' + esc(GS().DEFINITIONS.fair_ml) + '</div>')
        + (M.range80 ? row('80% outcome range', esc(M.range80.text) + '<div class="gv-s">' + esc(GS().DEFINITIONS.range80) + '</div>') : '')
        + (M.sigma != null ? row('Margin spread (σ)', esc(M.sigma.toFixed(1)) + ' pts') : '')
        + '</tbody></table>';
    }
    var Dn = s.distribution;
    if (Dn && M.available) {
      h += '<h3 class="gv-h3">Scoring distribution</h3><table class="gv-tbl"><tbody>'
        + (Dn.total ? row('Total points', '80% between ' + esc(Dn.total.p10.toFixed(1)) + ' and ' + esc(Dn.total.p90.toFixed(1))) : '')
        + (Dn.away_points ? row(esc(s.away.name) + ' points', '80% between ' + esc(Dn.away_points.p10.toFixed(1)) + ' and ' + esc(Dn.away_points.p90.toFixed(1))) : '')
        + (Dn.home_points ? row(esc(s.home.name) + ' points', '80% between ' + esc(Dn.home_points.p10.toFixed(1)) + ' and ' + esc(Dn.home_points.p90.toFixed(1))) : '')
        + '</tbody></table><div class="gv-s">EdgeDesk model estimates from the probability sheet built on the same run (' + esc(Object.keys(Dn.markets || {}).map(function (k) { var x = Dn.markets[k]; return k.replace('_', ' ') + ' ' + String(x.status || '').toLowerCase(); }).join(' · ')) + ' on held-out seasons). Eight in ten games like this one land inside each range.</div>';
    }
    if (M.available && s.probability_sheet === 'MATCHED') {
      h += '<h3 class="gv-h3">Fair alternate lines</h3><div id="gvAlt"><button type="button" class="gv-btn" data-gv-act="alts">Show EdgeDesk’s fair alternate lines</button>'
        + '<div class="gv-s">Model estimates at each half point, from the same probability sheet. Not sportsbook prices.</div></div>';
    }
    var U = s.units && s.units.rows || [];
    if (U.length) {
      h += '<h3 class="gv-h3">Unit rankings</h3><div class="gv-scroll"><table class="gv-tbl gv-units"><thead><tr><th scope="col">Unit</th><th scope="col">' + esc(s.away.short || s.away.name) + '</th><th scope="col">' + esc(s.home.short || s.home.name) + '</th></tr></thead><tbody>'
        + U.map(function (u) { return '<tr><th scope="row">' + esc(GS().unitLabel(s.league, u.key)) + '</th><td>' + rankBar(u.away, (u.away && u.away.of) || s.units.of) + '</td><td>' + rankBar(u.home, (u.home && u.home.of) || s.units.of) + '</td></tr>'; }).join('')
        + '</tbody></table></div><div class="gv-s">Rank 1 is the best unit in ' + (s.league === 'nfl' ? 'the NFL' : 'FBS') + ' on every row. ' + esc(s.units.source) + (s.units.as_of ? ' · ' + esc(stamp(s.units.as_of)) : '') + '</div>';
    }
    var D = s.drivers && s.drivers.rows || [];
    if (D.length) {
      h += '<h3 class="gv-h3">What moves EdgeDesk’s number</h3><table class="gv-tbl"><tbody>'
        + D.map(function (d) { return row(esc(d.label), '+' + d.points.toFixed(1) + ' pts toward ' + esc(d.favors_team || '—')); }).join('') + '</tbody></table>'
        + '<div class="gv-s">' + esc(GS().DRIVER_BASIS[s.drivers.basis] || '') + '</div>';
    }
    if ((s.scenarios || []).length && M.available) {
      var SC = { home_qb_out: s.home.name + ' quarterback out', away_qb_out: s.away.name + ' quarterback out', home_short_week: s.home.name + ' on a short week', away_short_week: s.away.name + ' on a short week', dome: 'Played indoors', cold_windy: '25°F and 20 mph wind' };
      h += '<h3 class="gv-h3">If one input changes</h3><table class="gv-tbl"><tbody>' + s.scenarios.map(function (x) {
        return row(esc(SC[x.key] || x.key), esc(M.display ? modelLine(s, x.home_line) : fav(s, x.home_line)) + (x.total != null ? ' · total ' + (M.display ? modelTotal(x.total) : x.total.toFixed(1)) : '') + (x.home_win_prob != null ? ' · ' + esc(s.home.abbr) + ' ' + Math.round(x.home_win_prob * 100) + '%' : ''));
      }).join('') + '</tbody></table><div class="gv-s">The engine re-run with one input changed; conditional, not a forecast that it will.</div>';
    }
    /* only the snapshots where a headline number moved */
    var T = (s.history || []).filter(function (t, i, a) {
      if (!i) return true;
      var p = a[i - 1];
      return t.fair_home_line !== p.fair_home_line || t.total !== p.total || Math.round((t.home_win || 0) * 100) !== Math.round((p.home_win || 0) * 100);
    });
    if (T.length > 1) {
      h += '<h3 class="gv-h3">How the number has moved</h3><table class="gv-tbl"><tbody>' + T.slice().reverse().map(function (t) {
        return row(esc(stamp(t.at)), esc(fav(s, t.fair_home_line)) + (t.total != null ? ' · total ' + Number(t.total).toFixed(1) : '') + (t.home_win != null ? ' · ' + esc(s.home.abbr) + ' ' + Math.round(t.home_win * 100) + '%' : ''));
      }).join('') + '</tbody></table><div class="gv-s">The unrounded model numbers, as each snapshot recorded them.</div>';
    }
    return h || '<p class="gv-p">No further research is on file for this game.</p>';
  }
  function row(k, v) { return '<tr><th scope="row">' + k + '</th><td>' + v + '</td></tr>'; }
  /* the projection's rows: the display a reader sees, with the unrounded
     number it came from beside it */
  function displayRows(s, D) {
    var M = s.model, sub = function (t) { return t ? '<div class="gv-s">' + esc(t) + '</div>' : ''; };
    return row('Fair spread', esc(D.spread.text) + (M.fair.near_pickem ? ' <span class="gv-tag">near pick’em</span>' : '') + sub(D.spread.note))
      + row('Projected margin', esc((M.home_margin >= 0 ? s.home.name : s.away.name) + ' by ' + Math.abs(M.home_margin).toFixed(2)) + sub('unrounded'))
      + row('Fair total', esc(D.total.text) + sub('unrounded ' + M.total_exact.toFixed(2)))
      + row(esc(D.score.label), esc(D.score.text) + sub('Expected points: ' + D.score.expected_text) + sub(D.score.note))
      + (D.rounding_note ? '<tr><td colspan="2" class="gv-s">' + esc(D.rounding_note) + ' Comparisons and probabilities use the unrounded numbers.</td></tr>' : '');
  }
  function labBody(s, mk) {
    var M = s.model, D = S.data, h = '';
    h += '<h3 class="gv-h3">Model and inputs</h3><table class="gv-tbl"><tbody>'
      + row('Model', esc(M.version || '—') + (M.source ? ' · ' + esc(M.source) : ''))
      + row('Projection built', esc(stamp(M.built_at)))
      + (M.distribution_basis ? row('Distribution', esc(M.distribution_basis)) : '')
      + Object.keys((D && D.inputs) || {}).filter(function (k) { return D.inputs[k]; }).map(function (k) { var x = D.inputs[k]; return row('Input · ' + esc(k.replace(/_/g, ' ')), '<span class="mono">' + esc(x.file) + '</span> · ' + esc(stamp(x.generated_at)) + (x.week ? ' · ' + esc(x.week) : '')); }).join('')
      + row('Snapshot', '<span class="mono">' + esc(s.snapshot_id) + '</span> · graphic template ' + esc((GG() && GG().TEMPLATE) || ''))
      + row('Probability sheet', esc(s.probability_sheet === 'MATCHED' ? 'built from this snapshot’s projection (lib/edgedesk_fairline.js)' : (s.probability_sheet === 'MISMATCH' ? 'dropped: built from a different projection' : 'none')))
      + '</tbody></table>';
    var ck = s.checks || {};
    h += '<h3 class="gv-h3">Consistency checks</h3><ul class="gv-checks">'
      + (ck.passed || []).map(function (id) { return '<li class="ok">✓ ' + esc(id.replace(/_/g, ' ')) + '</li>'; }).join('')
      + (ck.failed || []).map(function (f) { return '<li class="bad">✗ ' + esc(f.id.replace(/_/g, ' ')) + (f.detail ? ': ' + esc(f.detail) : '') + '</li>'; }).join('') + '</ul>';
    h += '<h3 class="gv-h3">Uncertainty</h3><table class="gv-tbl"><tbody>'
      + row(s.confidence.kind === 'reliability' ? 'Reliability' : 'Data check', esc(s.confidence.label) + (s.confidence.main_deduction ? '<div class="gv-s">Main deduction: ' + esc(s.confidence.main_deduction) + '</div>' : ''))
      + (s.confidence.detail && s.confidence.detail.length ? row('Input warnings', s.confidence.detail.map(esc).join('<br>')) : '')
      + (M.range80 ? row('80% outcome range', esc(M.range80.text)) : '')
      + (s.drivers && s.drivers.unpriced && s.drivers.unpriced.length ? row('Not priced by the model', esc(s.drivers.unpriced.join(', '))) : '')
      + '</tbody></table>';
    var d = S.mk && S.mk.decision;
    h += '<h3 class="gv-h3">Market diagnostics</h3><table class="gv-tbl"><tbody>'
      + row('Market state', esc(mk ? mk.state : (S.mk ? 'UNAVAILABLE' : 'not checked yet')) + (mk && mk.reason ? ' · ' + esc(mk.reason) : ''))
      + (mk && mk.captured_at ? row('Last capture', esc(stamp(mk.captured_at)) + (mk.book ? ' · ' + esc(mk.book) : '') + (mk.age_minutes != null ? ' · ' + esc(mk.age_minutes) + ' min old' : '')) : '')
      + row('Decision engine', d ? esc(d.decision || '—') + (d.blocker_codes && d.blocker_codes.length ? ' · blocker <span class="mono">' + esc(d.blocker_codes.join(', ')) + '</span>' : '') + (d.reason_code ? ' · <span class="mono">' + esc(d.reason_code) + '</span>' : '') : 'no decision on file for this game')
      + (S.mk && S.mk.source ? row('Market source', esc(S.mk.source)) : '')
      + '</tbody></table>';
    h += '<h3 class="gv-h3">Definitions</h3><dl class="gv-dl">' + Object.keys(GS().DEFINITIONS).map(function (k) { return '<dt>' + esc(k.replace(/_/g, ' ')) + '</dt><dd>' + esc(GS().DEFINITIONS[k]) + '</dd>'; }).join('') + '</dl>';
    return h;
  }

  /* 5 — the market, only when a current quote exists */
  function marketSection(s, mk, av) {
    var h = '<section class="gv-sec" id="gvMarket" aria-label="Market comparison"><h2 class="gv-h">Market comparison <span class="gv-opt">optional</span></h2>';
    if (!S.mk) return h + '<p class="gv-p">Checking for a current sportsbook quote… EdgeDesk’s research above does not wait for it.</p></section>';
    if (!mk || !mk.current) {
      h += '<div class="gv-calm"><b>' + esc(av.market_note) + '</b></div>';
      if (mk && (mk.state === 'CACHED' || mk.state === 'STALE' || mk.state === 'REFERENCE') && mk.home_line != null) {
        h += '<p class="gv-p gv-dim">Last known number, for context only: ' + esc(bookLine(s, mk.home_line)) + (mk.total != null ? ', total ' + esc(bookTotal(mk.total)) : '')
          + (mk.captured_at ? ' (' + esc(mk.book || 'captured') + ', ' + esc(ago(mk.captured_at)) + ')' : ' (' + esc(mk.reason || 'untimed reference') + ')') + '. It is not a current price and EdgeDesk does not evaluate it.</p>';
      }
      h += '<p class="gv-p">Have a number from your sportsbook? <button type="button" class="gv-link" data-gv-act="price-focus">Compare it with EdgeDesk’s model ↓</button></p>';
      return h + '</section>';
    }
    var C = GS().compareMarket(s, mk);
    h += '<div class="gv-s">' + esc(mk.book || (mk.books ? mk.books + ' books' : 'captured quote')) + ' · captured ' + esc(stamp(mk.captured_at)) + ' (' + esc(ago(mk.captured_at)) + ')' + (mk.verified ? ' · verified across books' : '') + '</div>';
    h += '<table class="gv-tbl"><thead><tr><th scope="col"></th><th scope="col">EdgeDesk</th><th scope="col">Market</th></tr></thead><tbody>';
    if (C && C.spread) h += '<tr><th scope="row">Spread</th><td>' + esc(C.spread.fair_text) + '</td><td>' + esc(C.spread.market_text) + '</td></tr>';
    if (C && C.total) h += '<tr><th scope="row">Total</th><td>' + esc(C.total.fair_text) + '</td><td>' + esc(C.total.market_text) + '</td></tr>';
    if (C && C.moneyline) h += '<tr><th scope="row">Win probability</th><td>' + esc(s.home.abbr) + ' ' + pct1(C.moneyline.model_home) + ' <span class="gv-s">model</span></td><td>' + esc(s.home.abbr) + ' ' + pct1(C.moneyline.market_no_vig_home) + ' <span class="gv-s">no-vig</span></td></tr>';
    h += '</tbody></table>';
    if (C && C.spread) h += '<p class="gv-p">' + esc(C.spread.text) + '.' + (C.total ? ' ' + esc(C.total.text) + '.' : '') + '</p>';
    if (C && C.spread && C.spread.key) h += '<p class="gv-p gv-key"><span class="gv-tag">Key number</span> ' + esc(C.spread.key.text) + ' <span class="gv-s">' + esc(C.spread.key.detail) + ' ' + esc(C.spread.key.note) + '</span></p>';
    if (C && C.rounding_note) h += '<div class="gv-s">' + esc(C.rounding_note) + '</div>';
    var d = S.mk.decision;
    if (d && d.decision && d.decision !== 'NO_DECISION') h += '<p class="gv-p">The decision layer’s read at this price: <b>' + esc(d.label || d.decision) + '</b>' + (d.reason ? ' — ' + esc(String(d.reason).replace(/[.\s]+$/, '')) : '') + '. Decision support only; see the full card for its gates.</p>';
    else if (d && d.blocker_codes && d.blocker_codes.length) h += '<p class="gv-p gv-dim">The decision layer has not evaluated this price yet. Details are in Lab.</p>';
    return h + '</section>';
  }

  /* 6 — compare a price the reader typed */
  function priceSection(s) {
    var p = S.price, M = s.model, H = s.home, A = s.away;
    var h = '<section class="gv-sec" id="gvPrice" aria-label="Compare my number"><h2 class="gv-h">Compare my number</h2>'
      + '<p class="gv-p">Type a price from your sportsbook. EdgeDesk sets it against its own model probability for this game. ' + '<b>' + esc(GS().USER_PRICE_LABEL) + '</b>: it is never saved or shown as market data.</p>';
    if (!M.available) return h + '<div class="gv-limit">No projection, so there is no model probability to compare a price against.</div></section>';
    h += '<form class="gv-form" data-gv-form="price" novalidate><div class="gv-fmt" role="group" aria-label="Market">'
      + [['spread', 'Spread'], ['total', 'Total'], ['moneyline', 'Moneyline']].map(function (m) { return '<button type="button" class="gv-seg' + (p.market === m[0] ? ' on' : '') + '" aria-pressed="' + (p.market === m[0]) + '" data-gv-act="pmkt" data-gv-v="' + m[0] + '">' + m[1] + '</button>'; }).join('') + '</div>';
    var sideOpts = p.market === 'total' ? [['over', 'Over'], ['under', 'Under']] : [['away', A.name], ['home', H.name]];
    h += '<div class="gv-fields"><label>' + (p.market === 'total' ? 'Side' : 'Team') + '<select name="side">' + sideOpts.map(function (o) { return '<option value="' + o[0] + '"' + (p.side === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select></label>';
    if (p.market !== 'moneyline') h += '<label>' + (p.market === 'total' ? 'Total' : 'Spread') + '<input name="line" inputmode="decimal" autocomplete="off" placeholder="' + (p.market === 'total' ? M.total.toFixed(1).replace(/\.\d$/, '.5') : '-3.5') + '" value="' + esc(p.line == null ? '' : p.line) + '"></label>';
    h += '<label>American odds<input name="american" inputmode="numeric" autocomplete="off" placeholder="-110" value="' + esc(p.american == null ? '' : p.american) + '"></label></div>'
      + '<button type="submit" class="gv-btn gv-primary">Compare with EdgeDesk</button></form>';
    h += '<div id="gvPriceOut" aria-live="polite">' + priceResult(s) + '</div>';
    if (S.opts.compareFair) h += '<p class="gv-p gv-dim">Prefer to compare your own fair line instead of a price? <button type="button" class="gv-link" data-gv-act="compare-fair">Compare my fair number</button> (saved to your journal).</p>';
    return h + '</section>';
  }
  var VERDICT = {
    VALUE: ['Clears break-even on calibrated probabilities', 'ok'],
    THIN: ['Clears break-even only on unproven evidence', 'warn'],
    NO_VALUE: ['Does not clear this price’s break-even', 'mute'],
    CANNOT_EVALUATE: ['Cannot be evaluated', 'mute']
  };
  function priceResult(s) {
    var r = S.priceOut;
    if (!r) return '';
    if (r.loading) return '<p class="gv-p gv-dim">Pricing…</p>';
    if (r.errors && r.errors.length) return '<div class="gv-warnbox">' + r.errors.map(esc).join('<br>') + '</div>';
    var v = VERDICT[r.verdict] || VERDICT.CANNOT_EVALUATE;
    var h = '<div class="gv-pres"><div class="gv-ptag">' + esc(r.label) + '</div>'
      + '<div class="gv-pv gv-' + v[1] + '">' + esc(v[0]) + '</div><table class="gv-tbl"><tbody>'
      + row('Price implies', pct1(r.implied) + '<div class="gv-s">' + esc(r.implied_note) + '</div>')
      + row(esc(r.prob_label), pct1(r.model_prob) + (r.push_prob > 0.0005 ? ' <span class="gv-s">push ' + pct1(r.push_prob) + '</span>' : '') + '<div class="gv-s">' + esc((r.status || '').toLowerCase()) + ' on held-out seasons · method ' + esc(r.method || '—') + '</div>')
      + row('Difference', (r.prob_diff != null ? (r.prob_diff >= 0 ? '+' : '−') + (Math.abs(r.prob_diff) * 100).toFixed(1) + ' pp' : '—') + '<div class="gv-s">EdgeDesk’s probability with ' + (r.entry && r.entry.market === 'moneyline' ? 'ties' : 'pushes') + ' removed, minus the price’s break-even</div>')
      + row('EdgeDesk fair odds', esc(am(r.fair_american)) + '<div class="gv-s">model estimate · not a sportsbook price</div>')
      + row('Expected value', r.ev_validated && r.ev != null ? ((r.ev >= 0 ? '+' : '−') + (Math.abs(r.ev) * 100).toFixed(1) + '% per unit') : '<span class="gv-dim">' + esc(r.ev_withheld) + '</span>')
      + (r.conservative ? row('Held-out check', 'at market numbers, probabilities like this one came true ' + pct1(r.check && r.check.market_tested_cover) + ' (n ' + esc(r.conservative.n) + '); low end ' + pct1(r.conservative.cover)) : '')
      + '</tbody></table>'
      + '<ul class="gv-bul gv-dim">' + (r.why || []).concat(r.notes || []).map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul></div>';
    return h;
  }
  function runPrice(s, form) {
    var f = new FormData(form), p = S.price;
    p.side = f.get('side'); p.line = f.get('line'); p.american = f.get('american');
    var line = p.line == null || p.line === '' ? null : Number(String(p.line).replace(/[^\d.+-]/g, ''));
    var a = p.american == null || p.american === '' ? null : Number(String(p.american).replace(/[^\d+-]/g, ''));
    var entry = { market: p.market, side: p.side, line: line, american: a };
    S.priceOut = { loading: true };
    rerenderPrice(s);
    track('game_research_price_check', { entity: s.league + ':' + s.game_id, market: p.market });
    Promise.all([loadProbs(), loadFairLine()]).then(function (r) {
      var probs = r[0], FL = r[1], sheet = probs && probs.sheets ? probs.sheets[s.game_key] : null;
      var model = probs && probs.models ? probs.models[s.league] : null;
      if (sheet && !GS().sheetMatches(s, sheet)) sheet = null;
      S.priceOut = GS().comparePrice(s, sheet, model, entry, FL);
      rerenderPrice(s);
    }).catch(function (e) {
      S.priceOut = { errors: ['EdgeDesk’s probability sheet could not load (' + (e && e.message || e) + '). Your number was not sent anywhere.'] };
      rerenderPrice(s);
    });
  }
  /* the fair ladder at each half point around EdgeDesk's number, both sides,
     from the snapshot's own sheet (EDFairLine.probabilities) */
  function showAlts(s) {
    var host = document.getElementById('gvAlt'); if (!host) return;
    host.innerHTML = '<p class="gv-p gv-dim">Loading…</p>';
    Promise.all([loadProbs(), loadFairLine()]).then(function (r) {
      var sh = r[0] && r[0].sheets ? r[0].sheets[s.game_key] : null, FL = r[1];
      if (!sh || !GS().sheetMatches(s, sh)) { host.innerHTML = '<p class="gv-p gv-dim">No probability sheet matches this snapshot.</p>'; return; }
      var M = s.model, h = '';
      /* half-point lines around EdgeDesk's number (no pushes), six each side */
      var c = Math.floor(M.fair.home_line) + 0.5, rowsS = [];
      for (var d = -6; d <= 6; d += 1) {
        var hl = c + d, p = FL.probabilities(sh, { market: 'spread', side: 'home', line: hl });
        if (!p || p.error) continue;
        rowsS.push('<tr><th scope="row">' + esc(s.home.abbr) + ' ' + esc(signed(hl)) + ' / ' + esc(s.away.abbr) + ' ' + esc(signed(-hl)) + '</th><td>' + pct1(p.win) + (p.push > 0.0005 ? ' <span class="gv-s">push ' + pct1(p.push) + '</span>' : '') + '</td><td>' + esc(am(FL.fairAmerican(p.win, p.push))) + ' / ' + esc(am(FL.fairAmerican(p.lose, p.push))) + '</td></tr>');
      }
      if (rowsS.length) h += '<div class="gv-scroll"><table class="gv-tbl"><thead><tr><th scope="col">Spread</th><th scope="col">' + esc(s.home.abbr) + ' covers</th><th scope="col">Fair odds</th></tr></thead><tbody>' + rowsS.join('') + '</tbody></table></div>';
      var ct = Math.floor(M.total) + 0.5, rowsT = [];
      for (var e = -6; e <= 6; e += 1) {
        var L = ct + e, q = FL.probabilities(sh, { market: 'total', side: 'over', line: L });
        if (!q || q.error || !(L > 0)) continue;
        rowsT.push('<tr><th scope="row">' + esc(L.toFixed(1)) + '</th><td>' + pct1(q.win) + (q.push > 0.0005 ? ' <span class="gv-s">push ' + pct1(q.push) + '</span>' : '') + '</td><td>' + esc(am(FL.fairAmerican(q.win, q.push))) + ' / ' + esc(am(FL.fairAmerican(q.lose, q.push))) + '</td></tr>');
      }
      if (rowsT.length) h += '<div class="gv-scroll"><table class="gv-tbl"><thead><tr><th scope="col">Total</th><th scope="col">Over</th><th scope="col">Fair odds (over / under)</th></tr></thead><tbody>' + rowsT.join('') + '</tbody></table></div>';
      var mk = sh.markets || {};
      h += '<div class="gv-s">EdgeDesk model estimates, not sportsbook prices. Spread probabilities are ' + esc(String((mk.spread || {}).status || 'uncalibrated').toLowerCase()) + ' and total probabilities ' + esc(String((mk.total || {}).status || 'uncalibrated').toLowerCase()) + ' on held-out seasons; neither market has been shown to beat the closing line.</div>';
      host.innerHTML = h || '<p class="gv-p gv-dim">The sheet carries no ladder for this game.</p>';
      track('game_research_alts', { entity: s.league + ':' + s.game_id });
    }).catch(function (e) { host.innerHTML = '<p class="gv-p gv-dim">The probability sheet could not load (' + esc(e && e.message || e) + ').</p>'; });
  }
  function rerenderPrice(s) { var o = document.getElementById('gvPriceOut'); if (o) o.innerHTML = priceResult(s); }

  /* ------------------------------------------------------------ actions */
  function msg(t, bad) { var m = document.getElementById('gvMsg'); if (m) { m.textContent = t; m.className = 'gv-msg' + (bad ? ' bad' : ''); } }
  V.shareUrl = function (s) {
    var base = (S.opts.shareBase || (root.location ? root.location.origin + root.location.pathname : '')) || 'https://edgedesksports.com/app.html';
    return base + V.hashFor(s.league, s.game_id);
  };
  function withImage(fn) {
    var s = V.snapshot(S.league, S.gid);
    if (S.img && S.img.content && s && S.img.key === GG().cacheKey(GS().graphicSpec(s), graphicMarket(S.mk ? GS().market(S.mk.market) : null), S.format)) return fn(S.img, s);
    msg('Drawing the graphic…');
    return GG().render(GS().graphicSpec(s), graphicMarket(S.mk ? GS().market(S.mk.market) : null), S.format, { now: Date.now() }).then(function (r) { S.img = r; msg(''); return fn(r, s); })
      .catch(function (e) { msg('The graphic could not be drawn: ' + (e && (e.message || e.reason) || e), true); });
  }
  function download() {
    withImage(function (r, s) {
      var a = document.createElement('a'); a.href = r.url; a.download = r.file_name; document.body.appendChild(a); a.click(); a.remove();
      msg('Saved ' + r.file_name + '.'); track('game_graphic_download', { entity: s.league + ':' + s.game_id, format: r.format });
    });
  }
  function share() {
    withImage(function (r, s) {
      var url = V.shareUrl(s), text = 'EdgeDesk research: ' + s.away.name + ' at ' + s.home.name + (s.model.available ? ' · fair ' + (s.model.display ? s.model.display.spread.text + ', total ' + s.model.display.total.text : s.model.fair.text + ', total ' + s.model.total.toFixed(1)) : '') + '. Research, not picks.';
      var file = null;
      try { if (r.blob && typeof File === 'function') file = new File([r.blob], r.file_name, { type: 'image/png' }); } catch (_) { file = null; }
      var N = root.navigator;
      if (N && N.share && file && N.canShare && N.canShare({ files: [file] })) {
        return N.share({ files: [file], title: 'EdgeDesk research', text: text, url: url }).then(function () { track('game_graphic_share', { entity: s.league + ':' + s.game_id, kind: 'native_file' }); }).catch(function () { /* the reader closed the sheet */ });
      }
      if (N && N.share) return N.share({ title: 'EdgeDesk research', text: text, url: url }).then(function () { track('game_graphic_share', { entity: s.league + ':' + s.game_id, kind: 'native_link' }); }).catch(function () { /* closed */ });
      copyLink(); msg('Sharing is not available in this browser: the link was copied. Use Download PNG for the image.');
    });
  }
  function copyLink() {
    var s = V.snapshot(S.league, S.gid); if (!s) return;
    var url = V.shareUrl(s), N = root.navigator;
    if (N && N.clipboard && N.clipboard.writeText) N.clipboard.writeText(url).then(function () { msg('Link copied: ' + url); }).catch(function () { msg(url); });
    else msg(url);
    track('game_research_copy_link', { entity: s.league + ':' + s.game_id });
  }
  function onClick(ev) {
    var b = ev.target.closest('[data-gv-act]'); if (!b || !S.el.contains(b)) return;
    var act = b.getAttribute('data-gv-act'), v = b.getAttribute('data-gv-v'), s = V.snapshot(S.league, S.gid);
    if (act === 'back') { if (S.opts.back) S.opts.back(); else history.back(); return; }
    if (act === 'retry') { V.load(true).then(paint).catch(paintError); return; }
    if (act === 'board') { if (S.opts.boardCard) S.opts.boardCard(S.league, S.gid); return; }
    if (!s) return;
    if (act === 'format') { S.format = v === 'portrait' ? 'portrait' : 'square'; S.img = null; paint(); return; }
    if (act === 'download') return download();
    if (act === 'share') return share();
    if (act === 'copy') return copyLink();
    if (act === 'explore') { var d = document.getElementById('gvDeep'); if (d) d.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    if (act === 'compare' || act === 'price-focus') { var p = document.getElementById('gvPrice'); if (p) { p.scrollIntoView({ behavior: 'smooth', block: 'start' }); var i = p.querySelector('input,select'); if (i) setTimeout(function () { try { i.focus({ preventScroll: true }); } catch (_) { /* */ } }, 350); } return; }
    if (act === 'compare-fair') { if (S.opts.compareFair) S.opts.compareFair(s.league, s.game_id); return; }
    if (act === 'level') { levelSet(v); var y = root.scrollY; paint(); try { root.scrollTo(0, y); } catch (_) { /* */ } track('game_research_level', { entity: s.league + ':' + s.game_id, level: v }); return; }
    if (act === 'pmkt') { S.price = { market: v }; S.priceOut = null; var sec = document.getElementById('gvPrice'); if (sec) { var t = document.createElement('div'); t.innerHTML = priceSection(s); sec.parentNode.replaceChild(t.firstChild, sec); } return; }
    if (act === 'alts') return showAlts(s);
    if (act === 'define') { var dd = document.getElementById('gvDef'); if (dd) { dd.hidden = !dd.hidden; dd.textContent = GS().DEFINITIONS[v] || ''; } return; }
  }
  function onSubmit(ev) {
    var f = ev.target; if (!f || f.getAttribute('data-gv-form') !== 'price') return;
    ev.preventDefault();
    var s = V.snapshot(S.league, S.gid); if (s) runPrice(s, f);
  }
  function onChange(ev) { var f = ev.target && ev.target.form; if (f && f.getAttribute('data-gv-form') === 'price' && ev.target.name === 'side') S.price.side = ev.target.value; }

  V._state = function () { return S; };
  /* the altitude section's HTML for one snapshot, for its test (football/altitude/altitude.test.js) */
  V.altitudeSection = altitudeSection;
  root.EDGameView = V;
})(typeof window !== 'undefined' ? window : this);
