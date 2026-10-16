/* ===========================================================================
   EdgeDesk RESEARCH GRADE UI — the A–F badge on a research board, the letter
   filter, and the expandable Grade Breakdown in a game view.
   docs/research-grade/METHODOLOGY.md

   ONE SOURCE. It reads what the hourly performance job wrote and nothing
   else: /performance/data/grades/live.json (every upcoming game's letter,
   score, caps, flags, dimension scores and explanation) for badges and
   filters, and live_detail.json (every sub-factor and its reason) only when
   a breakdown is shown. It computes no grade: the letter on a board is the
   letter locked in the ledger.

   A board renders a slot (EDGradeUI.slot(key)) wherever a badge belongs; the
   slots fill themselves when the grades arrive and whenever a board re-renders
   (a MutationObserver), so no board waits on this file. A game is found by its
   ledger key ("CFB|401862801") or by the slate id the job matched it to
   ("cfb:espn:401862801"). No entry, no badge: a sport the grade does not
   cover shows nothing rather than a guess.

   WHAT A BADGE SAYS. Research quality — how complete, current, cross-checked
   and reliable EdgeDesk's pregame research is. Not a win probability, not a
   pick, not a betting recommendation. Every badge carries that sentence as its
   tooltip and its accessible name; in the terminal, tapping the badge opens
   the guide's entry (data-ed-term="research-grade").

   Browser only: window.EDGradeUI.
   =========================================================================== */
(function () {
  'use strict';
  var URL_LIVE = '/performance/data/grades/live.json';
  var URL_DETAIL = '/performance/data/grades/live_detail.json';
  var DASH = '/performance/grades/';
  var LETTERS = ['A', 'B', 'C', 'D', 'F'];
  var INS = 'INSUFFICIENT';
  /* the kernel's own sentence (lib/edgedesk_research_grade.js TOOLTIP); live.json carries it too,
     and tools/performance/grade_ui.test.js fails if the two drift */
  var TOOLTIP = 'Research Grade rates the quality and reliability of EdgeDesk\'s pregame research on this game: the model\'s track record, data completeness, a check against a sportsbook line, matchup clarity and uncertainty. It is not a win probability, not a prediction of who wins and not a betting recommendation. Research, not picks.';
  var DIM_LABEL = { reliability: 'Model reliability & calibration', completeness: 'Data completeness', market: 'Model–market comparison', clarity: 'Matchup clarity', uncertainty: 'Uncertainty' };
  var DIMS = ['reliability', 'completeness', 'market', 'clarity', 'uncertainty'];
  var CAP_TEXT = { CALIBRATION_UNVALIDATED: 'live track record unvalidated', CALIBRATION_EARLY_SIGNAL: 'live track record still early', NO_PREGAME_MARKET: 'no sportsbook line captured', KEY_ROLE_UNKNOWN: 'key-player availability unknown' };
  var FLAG_TEXT = {
    LARGE_MODEL_MARKET_GAP: 'EdgeDesk\'s number is far from the sportsbook line: more often a data problem than an opportunity',
    STALE_MARKET_LINE: 'the sportsbook line on file is more than a day old', NO_PREGAME_MARKET: 'no sportsbook line has been captured for this game yet',
    ODDS_PROVIDER_UNAVAILABLE: 'the feed that carries sportsbook lines was unavailable', BUILD_NEAR_AGE_LIMIT: 'the model build is close to its age limit',
    START_TIME_TBA: 'the start time is to be announced', EARLY_SEASON: 'early season: ratings lean on last season', LEAKAGE_GUARD_QUOTE_DROPPED: 'a line captured after the grade was ignored'
  };
  var GATE_TEXT = {
    SPORT_SUPPORTED: 'sport covered', MODEL_OUTPUT: 'model number published', PREGAME: 'graded before kickoff', INDEPENDENT_MODEL: 'model independent of the market',
    RESEARCH_STATE: 'research state usable', INTEGRITY: 'no integrity conflict', FRESH_BUILD: 'model build fresh', COMPLETENESS_FLOOR: 'enough data', MIN_EVIDENCE: 'enough evidence'
  };
  var STATUS_TEXT = { ok: 'measured', partial: 'partly measured', unavailable: 'missing — no credit', unvalidated: 'unvalidated — excluded, capped', excluded: 'unavailable — excluded, capped', 'n/a': 'does not apply' };

  var S = { live: null, detail: null, loading: null, detailLoading: null, err: null, subs: [], observer: null, opts: { term: true } };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fetchJson(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error(url + ' answered ' + r.status); return r.json(); });
  }
  function emit() { S.subs.slice().forEach(function (fn) { try { fn(); } catch (_) { /* a board's own problem */ } }); hydrate(document); }

  /** Load the live grades once (and again on demand). Resolves even on failure: no grades, no badges. */
  function load(opts) {
    if (opts) Object.keys(opts).forEach(function (k) { S.opts[k] = opts[k]; });
    if (S.loading) return S.loading;
    S.loading = fetchJson(S.opts.url || URL_LIVE).then(function (j) {
      if (!j || j.schema !== 'edgedesk_research_grade_live_v1' || !j.games) throw new Error('the grade file is not in the expected format');
      S.live = j; S.err = null;
    }).catch(function (e) { S.err = String((e && e.message) || e); }).then(function () { observe(); emit(); });
    return S.loading;
  }
  function loadDetail() {
    if (S.detail) return Promise.resolve(S.detail);
    if (S.detailLoading) return S.detailLoading;
    S.detailLoading = fetchJson(S.opts.detailUrl || URL_DETAIL).then(function (j) { S.detail = j && j.games ? j : { games: {} }; return S.detail; })
      .catch(function () { S.detail = { games: {}, failed: true }; return S.detail; });
    return S.detailLoading;
  }
  function onChange(fn) { if (typeof fn === 'function') S.subs.push(fn); }
  function ready() { return !!S.live; }

  /** The ledger key for a sport code and a game id (the boards' own ids). */
  var SPORT_KEY = { nfl: 'NFL', cfb: 'CFB', ncaaf: 'CFB', fbs: 'CFB', nba: 'NBA', nhl: 'NHL', wnba: 'WNBA', ncaab_m: 'NCAAM', ncaam: 'NCAAM', ncaab_w: 'NCAAW', ncaaw: 'NCAAW' };
  function keyFor(sport, id) { var s = SPORT_KEY[String(sport || '').toLowerCase()]; return s && id != null && id !== '' ? s + '|' + id : null; }
  function resolve(key) {
    if (!S.live || !key) return null;
    if (S.live.games[key]) return key;
    var a = S.live.alias && S.live.alias[key];
    return a && S.live.games[a] ? a : null;
  }
  function entry(key) { var k = resolve(key); return k ? S.live.games[k] : null; }
  function letterOf(key) { var e = entry(key); return e ? e.letter : null; }

  /* --------------------------------------------------------------- badge */
  function capWords(e) { return e.cap ? 'capped at ' + e.cap + ' (' + (e.caps || []).map(function (c) { return CAP_TEXT[c] || c.toLowerCase().replace(/_/g, ' '); }).join('; ') + ')' : ''; }
  function badgeLabel(e) {
    if (e.letter === INS) return 'Research grade: not graded (insufficient data). ' + TOOLTIP;
    return 'Research grade ' + e.letter + ', ' + e.score + ' of 100' + (e.cap ? ', ' + capWords(e) : '') + '. ' + TOOLTIP;
  }
  /** The badge for one game, or '' when the game has no grade. opts: { size: 'sm'|'md', score: bool } */
  function badge(key, opts) {
    opts = opts || {};
    var e = entry(key);
    if (!e) return '';
    var ins = e.letter === INS, cls = 'edg-badge edg-l-' + (ins ? 'INS' : e.letter) + (opts.size === 'md' ? ' edg-md' : '') + (e.cap ? ' edg-capped' : '');
    var label = badgeLabel(e);
    var term = S.opts.term && opts.term !== false ? ' data-ed-term="research-grade"' : '';
    return '<span class="' + cls + '" role="img" aria-label="' + esc(label) + '" title="' + esc((ins ? 'Not graded: insufficient data. ' : 'Research grade ' + e.letter + ' (' + e.score + '/100)' + (e.cap ? ', ' + capWords(e) : '') + '. ') + TOOLTIP) + '"' + term + '>'
      + '<span class="edg-k" aria-hidden="true">' + (opts.label === false ? '' : 'RG') + '</span><b aria-hidden="true">' + (ins ? '—' : esc(e.letter)) + '</b>'
      + (opts.score && !ins ? '<small aria-hidden="true">' + esc(e.score) + '</small>' : '') + '</span>';
  }
  /** A placeholder a board renders now; it fills itself when the grades arrive. */
  function slot(key, opts) {
    if (!key) return '';
    opts = opts || {};
    var now = badge(key, opts);
    return '<span class="edg-slot" data-edg-key="' + esc(key) + '"' + (now ? ' data-edg-done="' + esc(key) + '"' : '') + (opts.size ? ' data-edg-size="' + esc(opts.size) + '"' : '') + (opts.score ? ' data-edg-score="1"' : '') + (opts.term === false ? ' data-edg-term="0"' : '') + '>' + now + '</span>';
  }
  function hydrate(root) {
    if (!S.live || !root || !root.querySelectorAll) return;
    var list = root.querySelectorAll('.edg-slot[data-edg-key]');
    for (var i = 0; i < list.length; i++) {
      var el = list[i], k = el.getAttribute('data-edg-key');
      if (el.getAttribute('data-edg-done') === k) continue;
      el.innerHTML = badge(k, { size: el.getAttribute('data-edg-size') || null, score: el.getAttribute('data-edg-score') === '1', term: el.getAttribute('data-edg-term') !== '0' });
      el.setAttribute('data-edg-done', k);
    }
    var bds = root.querySelectorAll('[data-edg-bd]:not([data-edg-bd-done])');
    for (var j = 0; j < bds.length; j++) fillBreakdown(bds[j]);
  }
  function observe() {
    if (S.observer || typeof MutationObserver === 'undefined' || !document.body) return;
    var pending = false;
    S.observer = new MutationObserver(function () {
      if (pending) return;
      pending = true;
      (window.requestAnimationFrame || setTimeout)(function () { pending = false; hydrate(document); });
    });
    S.observer.observe(document.body, { childList: true, subtree: true });
  }

  /* -------------------------------------------------------------- filter */
  /** The letter filter: All, A–F, Not graded. counts: { A: n, … } from the games on the board. */
  function filterHTML(cur, counts, attr) {
    attr = attr || 'data-edg-filter';
    cur = cur || 'all';
    counts = counts || {};
    var opts = [['all', 'All grades']].concat(LETTERS.map(function (l) { return [l, l]; })).concat([[INS, 'Not graded']]);
    return '<div class="edg-filter" role="group" aria-label="Research grade">'
      + '<span class="edg-flab" title="' + esc(TOOLTIP) + '"' + (S.opts.term ? ' data-ed-term="research-grade"' : '') + '>Research grade</span>'
      + opts.map(function (o) {
        var n = o[0] === 'all' ? null : counts[o[0]] || 0;
        return '<button type="button" class="edg-fbtn' + (o[0] !== 'all' && o[0] !== INS ? ' edg-l-' + o[0] : '') + '" ' + attr + '="' + o[0] + '" aria-pressed="' + (cur === o[0]) + '"' + (n === 0 && cur !== o[0] ? ' data-zero="1"' : '') + '>'
          + esc(o[1]) + (n != null ? ' <span class="n">' + n + '</span>' : '') + '</button>';
      }).join('') + '</div>';
  }
  /** Does a game pass the letter filter? 'all' passes everything; a letter passes only games with that grade. */
  function matches(key, f) {
    if (!f || f === 'all') return true;
    var l = letterOf(key);
    return l === f;
  }
  function countLetters(keys) {
    var c = {};
    (keys || []).forEach(function (k) { var l = letterOf(k); if (l) c[l] = (c[l] || 0) + 1; });
    return c;
  }

  /* ----------------------------------------------------------- breakdown */
  function when(iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return '';
    try { return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (_) { return new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; }
  }
  /** The expandable Grade Breakdown for one game. A slot: it fills from live_detail.json when shown. opts: { open } */
  function breakdown(key, opts) {
    opts = opts || {};
    if (!key) return '';
    return '<div class="edg-bd-slot" data-edg-bd="' + esc(key) + '"' + (opts.open ? ' data-edg-open="1"' : '') + (opts.started ? ' data-edg-started="1"' : '') + '>' + (S.live && !entry(key) ? '' : '<p class="edg-note">Loading the research grade…</p>') + '</div>';
  }
  function fillBreakdown(el) {
    var key = el.getAttribute('data-edg-bd');
    var e = entry(key);
    el.setAttribute('data-edg-bd-done', '1');
    if (!e) {
      el.innerHTML = !S.live ? '' : el.getAttribute('data-edg-started') === '1'
        ? '<p class="edg-note">This game has started. The research grade locked before kickoff, and how it held up, is on the <a href="' + DASH + '">Grade Performance</a> record.</p>'
        : '<p class="edg-note">No research grade for this game yet: grades cover upcoming NFL, college football, NBA, NHL, WNBA and college basketball games EdgeDesk projects, and are written hourly.</p>';
      return;
    }
    el.innerHTML = breakdownHTML(key, e, null, el.getAttribute('data-edg-open') === '1');
    loadDetail().then(function (d) { var g = d && d.games ? d.games[resolve(key)] : null; if (g) el.innerHTML = breakdownHTML(key, e, g, el.querySelector('details') ? el.querySelector('details').open : el.getAttribute('data-edg-open') === '1'); });
  }
  /* a sub-factor as live_detail.json stores it: [id, status, score, points, reason], its label once in sub_labels */
  function subOf(x) {
    if (!Array.isArray(x)) return x;
    var lab = (S.detail && S.detail.sub_labels) || {};
    return { id: x[0], status: x[1], score: x[2], points: x[3], detail: x[4], label: lab[x[0]] || String(x[0]).replace(/_/g, ' ') };
  }
  function bar(score) { var s = score == null ? 0 : Math.max(0, Math.min(100, score)); return '<span class="edg-bar" aria-hidden="true"><i style="width:' + s + '%"></i></span>'; }
  function breakdownHTML(key, e, d, open) {
    var ins = e.letter === INS;
    var h = '<details class="edg-bd"' + (open ? ' open' : '') + '><summary><span class="edg-sumrow">' + badge(key, { size: 'md', term: false }) + '<span class="edg-sumtx"><b>Grade Breakdown</b><small>'
      + (ins ? 'Not graded: insufficient data' : e.score + '/100' + (e.cap ? ' · capped at ' + esc(e.cap) : '')) + '</small></span><span class="edg-caret" aria-hidden="true"></span></span></summary><div class="edg-bd-b">';
    h += '<p class="edg-x">' + esc(e.explanation || '') + '</p>';
    h += '<p class="edg-what"><b>What this grade measures.</b> ' + esc(TOOLTIP) + '</p>';
    h += '<div class="edg-dims">';
    DIMS.forEach(function (id) {
      var dd = d && d.dims ? d.dims[id] : null, sc = e.dims && e.dims[id] ? e.dims[id] : [null, 'unavailable'];
      var score = dd ? dd.score : sc[0], status = dd ? dd.status : sc[1];
      h += '<div class="edg-dim"><div class="edg-dh"><span class="edg-dn">' + esc(DIM_LABEL[id]) + ' <small>' + (dd ? dd.weight : '') + (dd ? ' pts' : '') + '</small></span>' + bar(score)
        + '<span class="edg-ds">' + (score == null ? '—' : Math.round(score)) + '</span></div>'
        + '<p class="edg-dst edg-st-' + esc(String(status).replace('/', '')) + '">' + esc(STATUS_TEXT[status] || status) + (dd && dd.points != null && score != null ? ' · ' + dd.points + ' points toward the score' : '') + '</p>';
      if (dd && dd.sub) {
        h += '<ul class="edg-subs">' + dd.sub.map(subOf).map(function (x) {
          return '<li class="edg-st-' + esc(String(x.status).replace('/', '')) + '"><span class="edg-sl">' + esc(x.label) + '</span><span class="edg-sv">' + (x.score == null ? esc(x.status === 'n/a' ? 'n/a' : x.status === 'ok' ? '—' : x.status) : Math.round(x.score)) + '</span><span class="edg-sd">' + esc(x.detail || '') + '</span></li>';
        }).join('') + '</ul>';
      }
      h += '</div>';
    });
    h += '</div>';
    if (e.caps && e.caps.length) h += '<p class="edg-caps"><b>Caps.</b> ' + e.caps.map(function (c) { return esc(CAP_TEXT[c] || c); }).join('; ') + '. A cap is a ceiling no weight can lift.</p>';
    if (ins && d && d.gates && d.gates.length) h += '<p class="edg-caps"><b>Why it is not graded.</b> ' + d.gates.filter(function (g) { return g.pass !== true; }).map(function (g) { return esc((GATE_TEXT[g.id] || g.id) + ': ' + g.detail); }).join('; ') + '.</p>';
    if (e.flags && e.flags.length) h += '<ul class="edg-flags">' + e.flags.map(function (f) { return '<li>' + esc(FLAG_TEXT[f] || f.toLowerCase().replace(/_/g, ' ')) + '</li>'; }).join('') + '</ul>';
    if (e.history && e.history.length > 1) h += '<p class="edg-hist"><b>Grade history before kickoff.</b> ' + e.history.map(function (x) { return esc((x[1] === INS ? 'not graded' : x[1]) + ' · ' + when(x[0])); }).join(' → ') + '</p>';
    var v = S.live || {};
    h += '<p class="edg-meta">Graded ' + esc(when(e.captured_at)) + ' from pregame data only · model ' + esc(e.model || 'n/a') + ' · grade ' + esc(v.grade_version || '') + ' · weights ' + esc(v.weights_version || '') + ' (provisional, not yet validated) · ' + (e.revisions || 1) + ' revision' + ((e.revisions || 1) === 1 ? '' : 's') + ', every one kept.</p>';
    h += '<p class="edg-links"><a href="' + DASH + '">How grades have held up</a> · <a href="' + DASH + '#method">How grades are made</a> · Research, not picks.</p>';
    return h + '</div></details>';
  }

  window.EDGradeUI = {
    TOOLTIP: TOOLTIP, LETTERS: LETTERS, INSUFFICIENT: INS, DASHBOARD: DASH,
    load: load, loadDetail: loadDetail, onChange: onChange, ready: ready, keyFor: keyFor, entry: entry, letterOf: letterOf,
    badge: badge, slot: slot, hydrate: hydrate, filterHTML: filterHTML, matches: matches, countLetters: countLetters, breakdown: breakdown,
    _state: S
  };
})();
