/* ===========================================================================
   EdgeDesk INTELLIGENCE UI — the research engine, made visible.

   What a subscriber sees of the multi-agent research system, inside the
   existing Research screen and The Desk:

     1. ASK EDGEDESK AI      a labelled entry on the Research screen (input,
                             example questions, recent research) that opens
                             The Desk on a real, streamed research run
     2. RESEARCH ACTIVITY    each step the server reports as it happens
                             (finding events, comparing prices, retrieving
                             statistics, verifying injuries, calculating,
                             the adversarial audit, the explanation) — read
                             from the response stream, never from a timer;
                             cancel, timeout, retry and partial results
     3. RESULT CARDS         one card per researched candidate with every
                             field the brief names and expandable evidence
     4. READINESS            five separate states per game (available,
                             research available, market verified, model
                             ready, actionable) and "Why not ready?"
     5. GAME RESEARCH VIEW   one game: numbers, efficiency, availability,
                             mismatches, recent form, weather and venue,
                             disagreement, sources, timestamps — and a
                             "Research with EdgeDesk AI" button that carries
                             the game into the conversation

   Every number shown is one the server or a published artifact holds; the
   page formats, it never computes a probability, a price or an EV. The one
   sum it does (a unit mismatch = one published rating + the opposing one) is
   the same sum the server's MATCHUP_EDGE route makes, labelled as such.

   Browser only: window.EDINTELUI. Reads window.EDREADY, window.EDAI.
   =========================================================================== */
(function (root) {
  'use strict';
  var UI = {};
  var VERSION = 'edgedesk_intel_ui_v1';
  var doc = root.document;

  /* ---------------- small helpers ---------------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  function pct(x, dp) { var n = num(x); return n == null ? '—' : (n * 100).toFixed(dp == null ? 1 : dp) + '%'; }
  function am(x) { var n = num(x); return n == null ? '—' : (n > 0 ? '+' : '') + Math.round(n); }
  function line(v) { var n = num(v); return n == null ? '—' : (n > 0 ? '+' : '') + n; }
  function ago(iso, now) {
    var t = iso ? Date.parse(iso) : NaN; if (!isFinite(t)) return null;
    var m = Math.max(0, Math.round(((now || Date.now()) - t) / 60000));
    return m < 90 ? m + ' min ago' : m < 48 * 60 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' days ago';
  }
  function when(iso) {
    var t = iso ? Date.parse(iso) : NaN; if (!isFinite(t)) return '—';
    try { return new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }); } catch (_) { return new Date(t).toISOString().slice(0, 16).replace('T', ' '); }
  }
  function utc(iso) { return iso ? String(iso).slice(0, 16).replace('T', ' ') + ' UTC' : '—'; }
  function $(id) { return doc ? doc.getElementById(id) : null; }
  var BOARD_SPORT = { americanfootball_nfl: 'nfl', americanfootball_ncaaf: 'p4' };
  var FEED_SPORT = { nfl: 'americanfootball_nfl', p4: 'americanfootball_ncaaf', cfb: 'americanfootball_ncaaf' };
  UI.feedSport = function (s) { return FEED_SPORT[s] || s; };
  UI.boardSport = function (s) { return BOARD_SPORT[s] || s; };

  /* ---------------- 1. ASK EDGEDESK AI ---------------- */
  var EXAMPLES = [
    "What's the best researched opportunity tonight?",
    'Analyze every NFL game this weekend.',
    'Why does EdgeDesk disagree with this spread?',
    'Which matchup has the biggest offensive advantage?',
    'Compare DraftKings Predictions and Kalshi prices.',
    "Explain why this game isn't research ready."
  ];
  UI.EXAMPLES = EXAMPLES;
  var MAX_Q = 400;
  /** A question the server will accept: trimmed, single-spaced, no control characters, 3–400 characters. */
  UI.validate = function (q) {
    var t = String(q == null ? '' : q).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (t.length < 3) return { ok: false, why: 'Type a question first (at least a few words).' };
    if (t.length > MAX_Q) return { ok: false, why: 'That question is ' + t.length + ' characters; the limit is ' + MAX_Q + '. Shorten it a little.' };
    return { ok: true, q: t };
  };
  function histKey() {
    try { var u = typeof root.edUser === 'function' ? root.edUser() : null; return 'edgedesk_intel_recent_' + ((u && (u.sub || u.id)) || 'anon'); } catch (_) { return 'edgedesk_intel_recent_anon'; }
  }
  /** Recent research questions, this browser only (a convenience, never shared). */
  UI.recent = function () { try { var a = JSON.parse(root.localStorage.getItem(histKey()) || '[]'); return Array.isArray(a) ? a.filter(function (x) { return typeof x === 'string'; }).slice(0, 4) : []; } catch (_) { return []; } };
  UI.remember = function (q) {
    try { var a = UI.recent().filter(function (x) { return x !== q; }); a.unshift(q); root.localStorage.setItem(histKey(), JSON.stringify(a.slice(0, 4))); } catch (_) { /* storage unavailable: nothing to remember */ }
    try { paintRecent(); } catch (_) { /* no card mounted */ }
  };
  /* the game view's question: the game itself travels as context (research_context.game), never as team names in
     the text, so the server cannot mistake it for a different named-game route */
  var GAME_Q = 'Research this game: model, market, injuries, the disagreement and the audit.';
  UI.GAME_Q = GAME_Q;
  var CURRENT_GAME = null;   /* the game the reader last opened (the context "this game" / "this spread" refers to) */
  UI.currentGame = function () { return CURRENT_GAME; };
  UI.setCurrentGame = function (g) { CURRENT_GAME = g && g.game_id ? g : null; try { paintContext(); } catch (_) { /* not mounted */ } };

  UI.askCardHTML = function () {
    return '<section class="ia-ask" aria-labelledby="iaAskT">'
      + '<div class="ia-ask-hd"><span class="ia-badge" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2L12 3z"/></svg></span>'
      + '<div><h2 id="iaAskT">Ask EdgeDesk AI</h2><p class="ia-sub">Research any game, price or slate. Every number comes from EdgeDesk’s models and captured prices, and nothing is called verified until it survives an adversarial audit.</p></div></div>'
      + '<form class="ia-form" id="iaForm" novalidate><label class="ia-sr" for="iaQ">Ask EdgeDesk AI a research question</label>'
      + '<textarea id="iaQ" rows="1" maxlength="' + MAX_Q + '" autocomplete="off" enterkeyhint="send" placeholder="Ask a research question…"></textarea>'
      + '<button type="submit" class="ia-go" id="iaGo">Ask</button></form>'
      + '<div class="ia-ctx" id="iaCtx" hidden></div>'
      + '<p class="ia-err" id="iaErr" role="alert" hidden></p>'
      + '<div class="ia-ex" role="list" aria-label="Example questions">' + EXAMPLES.map(function (q) { return '<button type="button" role="listitem" class="ia-chip" data-ia-ask="' + esc(q) + '">' + esc(q) + '</button>'; }).join('') + '</div>'
      + '<div class="ia-recent" id="iaRecent" hidden></div>'
      + '</section>';
  };
  function paintRecent() {
    var el = $('iaRecent'); if (!el) return;
    var r = UI.recent();
    el.hidden = !r.length;
    el.innerHTML = r.length ? '<span class="k">Recent</span>' + r.map(function (q) { return '<button type="button" class="ia-chip ia-chip-r" data-ia-ask="' + esc(q) + '">' + esc(q) + '</button>'; }).join('') : '';
  }
  function paintContext() {
    var el = $('iaCtx'); if (!el) return;
    var g = CURRENT_GAME;
    el.hidden = !g;
    el.innerHTML = g ? 'About <b>' + esc(g.label || g.game_id) + '</b> — "this game" and "this spread" mean this one. <button type="button" class="ia-x" data-ia-clear-game aria-label="Stop asking about this game">Clear</button>' : '';
  }
  function showErr(msg) { var e = $('iaErr'); if (!e) return; e.textContent = msg || ''; e.hidden = !msg; }
  /** Mount the entry card into `host` (static: the board re-rendering never clears what the reader typed). */
  UI.mountAsk = function (host) {
    if (!host || host.getAttribute('data-ia-mounted')) return;
    host.innerHTML = UI.askCardHTML();
    host.setAttribute('data-ia-mounted', '1');
    var ta = $('iaQ');
    if (ta) {
      ta.addEventListener('input', function () { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'; if (ta.value.length) showErr(''); });
      ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitAsk(); } });
    }
    var f = $('iaForm'); if (f) f.addEventListener('submit', function (e) { e.preventDefault(); submitAsk(); });
    paintRecent(); paintContext();
  };
  function submitAsk(text) {
    var ta = $('iaQ');
    var v = UI.validate(text != null ? text : (ta ? ta.value : ''));
    if (!v.ok) { showErr(v.why); if (ta) ta.focus(); return false; }
    showErr('');
    var o = {};
    /* "this game" / "this spread" carry the game the reader opened, when there is one */
    if (CURRENT_GAME && /\b(this|that) (game|spread|matchup|line|total)\b/i.test(v.q)) o.game = CURRENT_GAME;
    if (ta) { ta.value = ''; ta.style.height = 'auto'; }
    UI.ask(v.q, o);
    return true;
  }
  UI.submit = submitAsk;
  /** Ask the research engine (through The Desk, which owns the conversation). */
  UI.ask = function (q, o) {
    o = o || {};
    var v = UI.validate(q);
    if (!v.ok) { showErr(v.why); return false; }
    if (!root.EDAI || typeof root.EDAI.intel !== 'function') { showErr('EdgeDesk AI is still loading — try again in a moment.'); return false; }
    UI.remember(v.q);
    root.EDAI.intel(v.q, o);
    return true;
  };

  /* ---------------- 2. THE RESEARCH STREAM AND ITS ACTIVITY ---------------- */
  /**
   * Read a newline-delimited JSON response; onEvent(ev) for every event as it arrives.
   * → { result, error, fallback, events, partial: {games, audit, coverage} }
   */
  UI.readStream = async function (resp, onEvent) {
    var out = { result: null, error: null, fallback: null, events: [], partial: {} };
    var rd = resp.body && resp.body.getReader ? resp.body.getReader() : null;
    if (!rd) { var txt = await resp.text(); txt.split('\n').forEach(function (l) { handle(l); }); return out; }
    var dec = new TextDecoder(), buf = '';
    function handle(l) {
      if (!l || !l.trim()) return;
      var ev; try { ev = JSON.parse(l); } catch (_) { return; }
      out.events.push(ev);
      if (ev.type === 'result') out.result = ev.payload || null;
      else if (ev.type === 'error') out.error = ev;
      else if (ev.type === 'fallback') out.fallback = ev;
      else if (ev.type === 'progress' && ev.partial) Object.keys(ev.partial).forEach(function (k) { out.partial[k] = ev.partial[k]; });
      try { if (onEvent) onEvent(ev); } catch (_) { /* a display error never stops the read */ }
    }
    for (;;) {
      var r = await rd.read();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      var i; while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
    }
    if (buf.trim()) handle(buf);
    return out;
  };
  var ORDER = ['FIND_EVENTS', 'COMPARE_PRICES', 'RETRIEVE_STATS', 'VERIFY_INJURIES', 'CALCULATE', 'AUDIT', 'EXPLAIN'];
  var LABEL = { FIND_EVENTS: 'Finding relevant events', RETRIEVE_STATS: 'Retrieving statistics', VERIFY_INJURIES: 'Verifying injuries and lineups', COMPARE_PRICES: 'Comparing market prices',
    CALCULATE: 'Calculating probabilities', AUDIT: 'Running the adversarial audit', EXPLAIN: 'Preparing the explanation', READ_HISTORY: 'Reading your recorded bets', ANALYZE_HISTORY: 'Analysing your results',
    SEARCH: 'Searching current reporting', CHALLENGE: 'Challenging the conclusion', LOOKUP: 'Looking it up', MODEL_DESK: 'Asking the model desk' };
  var SEQ = 0;
  /** The live activity block: the request is sent; rows appear and change only as the server reports them. */
  UI.activityHTML = function (q) {
    var id = 'iaAct' + (++SEQ);
    return '<div class="ia-act" id="' + id + '" data-state="running" aria-live="polite">'
      + '<div class="ia-act-hd"><span class="ia-spin" aria-hidden="true"></span><b class="ia-act-t">Researching</b><span class="ia-act-q">' + esc(q) + '</span>'
      + '<button type="button" class="ia-btn ia-btn-s" data-ia-cancel>Cancel</button></div>'
      + '<ol class="ia-steps"><li class="ia-step" data-st="SENT" data-status="done"><span class="ia-dot"></span><span class="ia-step-l">Sending your question</span><span class="ia-step-d">sent</span></li></ol>'
      + '<div class="ia-partial"></div></div>';
  };
  UI.activityApply = function (el, ev) {
    if (!el || !ev) return;
    var ol = el.querySelector('.ia-steps'); if (!ol) return;
    if (ev.type === 'accepted') { var s0 = ol.querySelector('[data-st="SENT"] .ia-step-d'); if (s0) s0.textContent = 'accepted by the research service'; return; }
    /* the plan arrives before any work: what will be read, what it may cost, and which steps cannot run (and why) */
    if (ev.type === 'plan' && ev.plan) {
      var old0 = el.querySelector('.ia-plan'); var ph = UI.planHTML(ev.plan);
      if (old0) old0.outerHTML = ph; else ol.insertAdjacentHTML('beforebegin', ph);
      return;
    }
    if (ev.type !== 'progress' || !ev.stage) return;
    var li = ol.querySelector('[data-st="' + ev.stage + '"]');
    if (!li) {
      li = doc.createElement('li'); li.className = 'ia-step'; li.setAttribute('data-st', ev.stage);
      li.innerHTML = '<span class="ia-dot"></span><span class="ia-step-l"></span><span class="ia-step-d"></span>';
      ol.appendChild(li);
    }
    li.setAttribute('data-status', ev.status || 'running');
    li.querySelector('.ia-step-l').textContent = ev.label || LABEL[ev.stage] || ev.stage;
    li.querySelector('.ia-step-d').textContent = (ev.detail || '') + (ev.t_ms != null && ev.status !== 'running' ? ' · ' + (ev.t_ms < 1000 ? Math.round(ev.t_ms) + ' ms' : (ev.t_ms / 1000).toFixed(1) + ' s') : '');
    if (ev.partial) {
      var pa = el.querySelector('.ia-partial');
      if (pa && ev.partial.games && ev.partial.games.length) pa.innerHTML = '<div class="ia-part"><div class="ia-part-h">Found — EdgeDesk’s line against the market (home side)</div>' + partialGamesHTML(ev.partial.games) + '</div>' + (pa.querySelector('.ia-part-a') ? pa.querySelector('.ia-part-a').outerHTML : '');
      if (pa && ev.partial.audit && ev.partial.audit.length) {
        var a = '<div class="ia-part ia-part-a"><div class="ia-part-h">First audit read (fresh prices)</div><ul>' + ev.partial.audit.map(function (r) { return '<li><b>' + esc(r.selection) + (r.line != null && r.market === 'spreads' ? ' ' + esc(line(r.line)) : '') + '</b> (' + esc(r.matchup) + ') — ' + esc(String(r.status || '').replace(/_/g, ' ')) + ': ' + esc(r.reason || '') + '</li>'; }).join('') + '</ul></div>';
        var old = pa.querySelector('.ia-part-a'); if (old) old.outerHTML = a; else pa.insertAdjacentHTML('beforeend', a);
      }
    }
  };
  function partialGamesHTML(games) {
    return '<div class="ia-scroll"><table class="ia-tbl"><tr><th>Game</th><th>Model</th><th>Market</th><th>Gap</th></tr>' + games.slice(0, 12).map(function (g) {
      return '<tr><td>' + esc(g.matchup) + '</td><td>' + esc(line(g.model_line)) + '</td><td>' + esc(line(g.market_line)) + (g.executable ? '' : ' <span class="ia-dim">ref</span>') + '</td><td>' + (g.gap_points != null ? esc(Math.abs(g.gap_points)) : '—') + '</td></tr>';
    }).join('') + '</table></div>';
  }
  /** End the run: done | cancelled | timeout | error | unavailable. The steps stay, folded, so the reader can see what ran. */
  UI.activityEnd = function (el, state, note) {
    if (!el) return;
    el.setAttribute('data-state', state);
    var t = el.querySelector('.ia-act-t'), c = el.querySelector('[data-ia-cancel]');
    if (c) c.remove();
    var steps = el.querySelectorAll('.ia-step');
    var running = el.querySelectorAll('.ia-step[data-status="running"]');
    if (state !== 'done') for (var i = 0; i < running.length; i++) running[i].setAttribute('data-status', state === 'cancelled' ? 'cancelled' : 'failed');
    var label = state === 'done' ? 'Research activity — ' + (steps.length - 1) + ' step' + (steps.length === 2 ? '' : 's') + (note ? ' · ' + note : '')
      : state === 'cancelled' ? 'Cancelled' + (note ? ' — ' + note : '') : state === 'timeout' ? 'Timed out' + (note ? ' — ' + note : '') : 'Stopped' + (note ? ' — ' + note : '');
    if (t) t.textContent = label;
    var sp = el.querySelector('.ia-spin'); if (sp) sp.remove();
    if (state === 'done') {
      var hd = el.querySelector('.ia-act-hd'), ol = el.querySelector('.ia-steps'), pa = el.querySelector('.ia-partial');
      if (hd && ol) {
        var d = doc.createElement('details'); d.className = 'ia-act-fold';
        var sm = doc.createElement('summary'); sm.textContent = label; d.appendChild(sm); d.appendChild(ol);
        hd.replaceWith(d); if (pa) pa.remove();
      }
    }
  };
  UI.retryHTML = function (msg, actions) {
    return '<div class="ia-fail" role="alert"><p>' + esc(msg) + '</p><p class="ia-fail-b">' + (actions || []).map(function (a) { return '<button type="button" class="ia-btn' + (a.primary ? ' ia-btn-p' : '') + '" ' + a.attr + '>' + esc(a.label) + '</button>'; }).join(' ') + '</p></div>';
  };

  /* ---------------- 3. RESULT CARDS ---------------- */
  var CLASS_CHIP = { VERIFIED_CANDIDATE: ['Verified candidate', 'v'], WATCHLIST: ['Watchlist', 'w'], RESEARCH_REQUIRED: ['Research required', 'p'], REJECTED: ['Rejected', 'x'], UNVERIFIED: ['Unverified', 'u'] };
  function chip(cls) { var c = CLASS_CHIP[cls] || [String(cls || '').replace(/_/g, ' ').toLowerCase(), 'u']; return '<span class="ia-chipcls ia-c-' + c[1] + '">' + esc(c[0]) + '</span>'; }
  function relWord(r) { return String(r || '').toLowerCase().replace(/_/g, ' '); }
  function keyFindings(fs) {
    return (fs || []).filter(function (f) { return (f.topic === 'availability' || f.topic === 'starter') && (f.status === 'OUT' || f.status === 'DOUBTFUL' || f.status === 'QUESTIONABLE' || f.topic === 'starter' || (f.conflicts && f.conflicts.length)); }).slice(0, 6);
  }
  function sourcesOf(fs) {
    var seen = {}, out = [];
    (fs || []).forEach(function (f) { if (!f.source_url || seen[f.source_url]) return; seen[f.source_url] = 1; out.push(f); });
    return out;
  }
  UI.sourcesHTML = function (fs, now) {
    var list = sourcesOf(fs);
    if (!list.length) return '<p class="ia-dim">No source on file for this candidate.</p>';
    return '<ol class="ia-src">' + list.slice(0, 10).map(function (f) {
      var safe = /^https:\/\//.test(f.source_url);
      return '<li>' + (safe ? '<a href="' + esc(f.source_url) + '" target="_blank" rel="noopener noreferrer">' + esc(f.publisher || f.source_url) + '</a>' : esc(f.publisher || f.source_url)) + ' <span class="ia-dim">' + esc(relWord(f.reliability)) + (f.published_at ? ' · published ' + esc(utc(f.published_at)) : '') + ' · retrieved ' + esc(utc(f.retrieved_at)) + '</span></li>';
    }).join('') + '</ol>';
  };
  function kv(k, v, cls) { return '<div class="ia-kv-r' + (cls ? ' ' + cls : '') + '"><dt>' + esc(k) + '</dt><dd>' + v + '</dd></div>'; }
  /* freshness is when a source published a fact, never when EdgeDesk re-read it: a feed re-read a minute ago can
     carry a report from yesterday, and "newest 0 min ago" would say the opposite */
  function freshText(fs) {
    if (!(fs || []).length) return 'no research findings on file';
    var pub = fs.map(function (f) { return Date.parse(f.published_at); }).filter(isFinite).sort(function (a, b) { return b - a; });
    var undated = fs.length - pub.length;
    return fs.length + ' finding' + (fs.length === 1 ? '' : 's')
      + (pub.length ? ', newest published ' + ago(new Date(pub[0]).toISOString()) + (pub.length > 1 && pub[pub.length - 1] !== pub[0] ? ', oldest ' + ago(new Date(pub[pub.length - 1]).toISOString()) : '') : '')
      + (undated ? '; ' + undated + ' with no publication time' : '');
  }
  /* the quote is not current when EDFAIR's own classifier would call it unverified data (STALE or UNKNOWN) */
  function quoteNotCurrent(fq) { return !fq || fq.status === 'STALE' || fq.status === 'UNKNOWN'; }
  /** What a selection's probability is called in its market: a spread covers, a total lands on its side, a moneyline wins. */
  function probWord(c) { return c.market === 'totals' ? String(c.selection || '').toLowerCase() || 'this side' : c.market === 'h2h' ? 'wins' : 'covers'; }
  /** One researched candidate. games: the slate's games (for the model projection of the same game). */
  UI.candidateCardHTML = function (row, games, o) {
    o = o || {};
    if (!row || !row.candidate) return '';
    var c = row.candidate, ev = row.evaluation || {}, r = row.research || {}, cl = row.classification || {}, au = row.audit || {};
    var g = (games || []).filter(function (x) { return String(x.game_id) === String(c.game_id) && (!x.sport || x.sport === c.sport); })[0] || null;
    var fq = ev.data_freshness && ev.data_freshness.quote;
    /* A quote past its limit is not a verified price, and an EV on it is not a current edge: the brief says to mark
       the market comparison unavailable rather than print a number that reads as one. The figures stay in "Model
       calculations", labelled as computed on the stale capture. */
    var stale = ev.ok && quoteNotCurrent(fq);
    var ageNote = fq && fq.age_min != null ? fq.age_min + ' min old' + (fq.ttl_min != null ? ' against a ' + fq.ttl_min + ' min limit' : '') : 'age unknown';
    var price = !ev.ok ? '<span class="ia-dim">not verified</span>'
      : stale ? 'none current <span class="ia-dim">— last captured ' + esc(am(ev.entry_price)) + ' at ' + esc(c.quote && c.quote.book || 'a captured book') + ', ' + esc(ageNote) + ' (implies ' + esc(pct(ev.market_probability)) + ')</span>'
        : '<b>' + esc(am(ev.entry_price)) + '</b> at ' + esc(c.quote && c.quote.book || 'a captured book') + ' <span class="ia-dim">(' + esc(fq ? String(fq.status).toLowerCase() : 'age unknown') + (fq && fq.age_min != null ? ', ' + fq.age_min + ' min old' : '') + '; implies ' + esc(pct(ev.market_probability)) + ')</span>';
    var proj = g && g.model_line != null ? esc(g.home) + ' ' + esc(line(g.model_line)) + (g.model_total != null ? ', total ' + esc(g.model_total) : '') + ' <span class="ia-dim">(' + esc(g.model_tier || 'unvalidated') + ' model)</span>' : (r.model_view ? esc(probWord(c)) + ' ' + esc(pct(r.model_view.probability)) + ' <span class="ia-dim">(' + esc(r.model_view.tier || 'unvalidated') + ' model)</span>' : '<span class="ia-dim">no independent projection for this market</span>');
    var ff = ev.data_freshness && ev.data_freshness.fair;
    var fairAge = r.fair_kind !== 'MODEL' && ff && ff.status === 'STALE' && ff.age_min != null ? ' <span class="ia-dim">(from a sharp price ' + ff.age_min + ' min old)</span>' : '';
    var fair = r.independent_fair_probability != null ? '<b>' + esc(pct(r.independent_fair_probability)) + '</b> <span class="ia-dim">EdgeDesk model (' + esc(r.model_view ? r.model_view.tier : 'validated') + ')</span>'
      : r.fair_probability != null ? '<b>' + esc(pct(r.fair_probability)) + '</b> <span class="ia-dim">' + esc(r.fair_kind === 'MODEL' ? 'EdgeDesk model' : 'sharp market, no-vig — not a model claim') + '</span>' + fairAge + (r.model_view ? ' <span class="ia-dim">· model cross-check ' + esc(pct(r.model_view.probability)) + ' (' + esc(r.model_view.tier || '') + ')</span>' : '')
        : '<span class="ia-dim">unavailable</span>';
    var evTxt = ev.net_ev_per_dollar == null ? '<span class="ia-dim">not computed</span>'
      : stale ? '<span class="ia-dim">unavailable — no current price (on the stale capture it computes to ' + esc(pct(ev.net_ev_per_dollar, 2)) + ' per $1, which is not a current edge)</span>'
        : '<b class="' + (Number(ev.net_ev_per_dollar) > 0 ? 'ia-pos' : 'ia-neg') + '">' + esc(pct(ev.net_ev_per_dollar, 2)) + ' per $1</b>' + (ev.maximum_entry_price != null ? ' <span class="ia-dim">· max price ' + esc(am(ev.maximum_entry_price)) + '</span>' : '');
    var inj = keyFindings(r.findings);
    var injTxt = inj.length ? '<ul class="ia-ul">' + inj.map(function (f) { return '<li>' + esc(f.claim) + ' <span class="ia-dim">(' + esc(relWord(f.reliability)) + (f.verified ? ', verified' : ', not verified') + (f.conflicts && f.conflicts.length ? ', conflicting reports' : '') + ')</span></li>'; }).join('') + '</ul>' : '<span class="ia-dim">' + ((r.findings || []).length ? 'nobody key listed out, doubtful or questionable' : 'no availability source was read') + '</span>';
    var audit = chip(cl.classification) + ' <span class="ia-dim">final status ' + esc(cl.final_status || '—') + '</span>' + (cl.reasons && cl.reasons[0] ? '<div class="ia-why">' + esc(cl.reasons[0]) + '</div>' : '');
    var sec = function (t, body, open) { return body ? '<details class="ia-more"' + (open ? ' open' : '') + '><summary>' + esc(t) + '</summary><div class="ia-more-b">' + body + '</div></details>' : ''; };
    var matchupBody = (r.disagreement ? '<p>' + esc(r.disagreement.explanation || '') + '</p>' + (r.disagreement.causes ? '<div class="ia-scroll"><table class="ia-tbl"><tr><th>Cause</th><th>Assessment</th><th>Evidence</th></tr>' + r.disagreement.causes.map(function (k) { return '<tr><td>' + esc(k.label) + '</td><td>' + esc(String(k.assessment).replace(/_/g, ' ').toLowerCase()) + '</td><td>' + esc((k.evidence || [])[0] || '') + '</td></tr>'; }).join('') + '</table></div>' : '') : '')
      + ((r.findings || []).length ? '<div class="ia-scroll"><table class="ia-tbl"><tr><th>Finding</th><th>Source</th><th>Published</th></tr>' + r.findings.slice(0, 16).map(function (f) { return '<tr><td>' + esc(f.claim) + '</td><td>' + esc(relWord(f.reliability)) + (f.verified ? ' · verified' : '') + '</td><td>' + esc(f.published_at ? utc(f.published_at) : '—') + '</td></tr>'; }).join('') + '</table></div>' : '')
      + ((r.conflicts || []).length ? '<ul class="ia-ul">' + r.conflicts.map(function (x) { return '<li>Conflict: ' + esc(x.detail) + (x.unresolved ? ' — unresolved' + (x.why_unresolved ? ' (' + esc(x.why_unresolved) + ')' : '') : ' — resolved by ' + esc(x.resolution && x.resolution.by || 'source tier')) + '</li>'; }).join('') + '</ul>' : '')
      + ((r.gaps || []).length ? '<ul class="ia-ul">' + r.gaps.map(function (x) { return '<li>Not in the model: ' + esc(x.detail) + '</li>'; }).join('') + '</ul>' : '');
    var calcBody = (stale ? '<p class="ia-dim">Computed on the last captured price, which is stale (' + esc(ageNote) + '): these are not current figures.</p>' : '') + '<dl class="ia-kv">' + kv('Fair probability', esc(pct(r.fair_probability != null ? r.fair_probability : ev.fair_probability, 2)) + ' <span class="ia-dim">' + esc(r.fair_kind === 'MODEL' ? 'model' : 'sharp no-vig') + '</span>')
      + kv('Break-even probability', esc(pct(ev.break_even_probability, 2))) + kv('Net EV', esc(pct(ev.net_ev_per_dollar, 2)) + ' per $1') + kv('Maximum acceptable price', esc(am(ev.maximum_entry_price)))
      + (r.sensitivity && r.sensitivity.available ? kv('If the fair is wrong', esc(r.sensitivity.note || '') + (r.sensitivity.robust ? ' — survives a 1-point error' : ' — a 1-point error erases it')) : '')
      + ((r.adjustments || []).length ? kv('Model adjustments', esc(r.adjustments.map(function (a) { return a.label + ': ' + pct(a.from) + ' → ' + pct(a.to); }).join('; '))) : '')
      + ((r.adjustments_refused || []).length ? kv('Refused adjustments', esc(r.adjustments_refused.map(function (a) { return a.why; }).join('; '))) : '') + '</dl>'
      + (r.sensitivity && r.sensitivity.rows ? '<div class="ia-scroll"><table class="ia-tbl"><tr><th>Fair shift</th><th>Fair</th><th>Net EV per $1</th></tr>' + r.sensitivity.rows.map(function (x) { return '<tr><td>' + esc((x.shift_pp > 0 ? '+' : '') + x.shift_pp) + ' pp</td><td>' + esc(pct(x.fair, 2)) + '</td><td>' + esc(x.net_ev_per_dollar == null ? '—' : pct(x.net_ev_per_dollar, 2)) + '</td></tr>'; }).join('') + '</table></div>' : '');
    var mktBody = '<dl class="ia-kv">' + kv('Price', price) + kv('Sharp no-vig', esc(pct(r.market_no_vig_probability, 2))) + kv('Market implied', esc(pct(ev.market_probability, 2)))
      + (ev.market_liquidity ? kv('Book confirmation', esc(String(ev.market_liquidity.status || '').toLowerCase()) + (ev.market_liquidity.note ? ' — ' + esc(ev.market_liquidity.note) : '')) : '') + '</dl>';
    var auditBody = (r.strategist && r.strategist.checks ? '<div class="ia-scroll"><table class="ia-tbl"><tr><th>Professional check</th><th>Result</th><th>Detail</th></tr>' + r.strategist.checks.map(function (k) { return '<tr><td>' + esc(k.question) + '</td><td class="ia-r-' + esc(k.result) + '">' + esc(k.result) + '</td><td>' + esc(k.detail) + '</td></tr>'; }).join('') + '</table></div>' : '')
      + (au.checks ? '<div class="ia-scroll"><table class="ia-tbl"><tr><th>Audit check</th><th>Result</th><th>Detail</th></tr>' + au.checks.map(function (k) { return '<tr><td>' + esc(k.label) + '</td><td class="ia-r-' + esc(k.result) + '">' + esc(String(k.result).replace(/_/g, ' ')) + '</td><td>' + esc(k.detail) + '</td></tr>'; }).join('') + '</table></div>' : '')
      + '<p class="ia-dim">Audit verdict: ' + esc(au.status || '—') + ' — ' + esc(au.reason || '') + '</p>';
    var boardSp = BOARD_SPORT[c.sport];
    var actions = (boardSp && c.game_id ? '<button type="button" class="ia-btn" data-ia-game="' + esc(boardSp) + '|' + esc(c.game_id) + '">Open game research</button>' : '')
      + (c.game_id ? '<button type="button" class="ia-btn" data-ia-askgame="' + esc(c.sport) + '|' + esc(c.game_id) + '|' + esc(c.matchup) + '">Ask about this game</button>' : '');
    return '<article class="ia-card ia-card-' + esc((CLASS_CHIP[cl.classification] || ['', 'u'])[1]) + '">'
      + '<header class="ia-card-hd"><div><div class="ia-card-t">' + esc(c.selection) + (c.market === 'spreads' && c.line != null ? ' ' + esc(line(c.line)) : c.market === 'h2h' ? ' moneyline' : '') + '</div><div class="ia-card-s">' + esc(c.matchup) + ' · ' + esc(c.sport_label || c.sport) + (c.kickoff_local ? ' · ' + esc(c.kickoff_local) : '') + '</div></div>' + chip(cl.classification) + '</header>'
      /* the Phase 2 answer's fields (event, sport, market and venue are the header and the price), the Phase 3 card's
         additions, every value the server's own; the candidate's text block is folded into this card, so nothing it
         printed may be missing here */
      + '<dl class="ia-kv">' + kv('Actionable now?', UI.actionableHTML(row)) + kv('Research confidence vs. win probability', UI.confidenceHTML(row))
      + kv('Verified market price', price) + kv('Model projection', proj) + kv('Fair probability', fair)
      + kv('Break-even probability', ev.break_even_probability != null ? esc(pct(ev.break_even_probability)) + (stale ? ' <span class="ia-dim">at the stale capture</span>' : '') : '<span class="ia-dim">—</span>') + kv('Estimated net EV', evTxt)
      + kv('Model reliability', esc((r.confidence && r.confidence.model_reliability && r.confidence.model_reliability.label) || '—'))
      + kv('Research freshness', esc(freshText(r.findings)))
      + kv('Why the model disagrees with the market', esc((r.disagreement && r.disagreement.explanation) || 'no model–market comparison for this market'))
      + kv('Primary matchup advantage', esc(row.advantage || 'none claimed'))
      + kv('Key injuries or lineup changes', injTxt) + kv('Strongest counterargument', esc(row.counterargument || '—'))
      + kv('What would invalidate the opportunity', (row.invalidators || []).length ? esc(row.invalidators.join('; ')) : '<span class="ia-dim">—</span>')
      + kv('Audit status', audit) + kv('Supporting sources', UI.sourcesHTML(r.findings)) + '</dl>'
      + sec('Matchup research', matchupBody) + sec('Model calculations', calcBody) + sec('Market comparison', mktBody) + sec('Audit findings', auditBody)
      + (row.evidence ? sec('Evidence — every fact, typed and dated (' + (row.evidence.summary ? row.evidence.summary.total : 0) + ')', UI.evidenceHTML(row.evidence, row.search)) : '')
      + (row.calc ? sec('Calculation checks — inputs, assumptions, recomputation', UI.calcHTML(row.calc)) : '')
      + (row.challenge && row.challenge.questions ? sec('Challenge — the eight questions (' + (row.challenge.unresolved.critical + row.challenge.unresolved.important) + ' unresolved)', UI.challengeHTML(row.challenge)) : '')
      + (actions ? '<div class="ia-card-a">' + actions + '</div>' : '') + '</article>';
  };
  UI.candidateCardsHTML = function (rows, games, o) {
    rows = (rows || []).filter(Boolean);
    if (!rows.length) return '';
    return '<div class="ia-cards">' + rows.map(function (r) { return UI.candidateCardHTML(r, games, o); }).join('') + '</div>';
  };

  /* ---------------- 3b. THE RESEARCH ENGINE'S RECORDS: plan, evidence, calculations, challenge ----------------
     Each renders a record the server built (EDORCH, EDEVIDENCE, EDQVERIFY, EDCHALLENGE); nothing is computed here. */
  var PATH_LABEL = { DATABASE: 'answered from stored data', ENGINE: "EdgeDesk's engines", ENGINE_RESEARCH: "EdgeDesk's engines and free official sources", ENGINE_SEARCH: 'engines plus an external search', MODEL_DESK: 'the model desk, over verified numbers', UNSUPPORTED: 'not a question EdgeDesk covers' };
  UI.planHTML = function (p) {
    if (!p) return '';
    var est = p.estimate || {}, usd = num(est.usd), ms = num(est.ms);
    var steps = (p.steps || []).map(function (x) { return '<li data-plan-st="' + esc(x.stage) + '" class="' + (x.status === 'unavailable' ? 'ia-dim' : '') + '">' + esc(x.label || LABEL[x.stage] || x.stage) + (x.status === 'unavailable' ? ' — <i>will not run: ' + esc(x.why || 'unavailable') + '</i>' : '') + '</li>'; }).join('');
    var ds = (p.datasets || []).slice(0, 6).map(function (d) { return esc(d.label) + (d.freshness ? ' <span class="ia-dim">(' + esc(d.freshness) + ')</span>' : ''); }).join(' · ');
    return '<div class="ia-plan"><div class="ia-plan-h"><b>Plan</b> — ' + esc(PATH_LABEL[p.path] || p.path || '') + ' · '
      + (usd ? 'estimated $' + esc(usd.toFixed(3)) : 'no paid calls') + (ms ? ' · about ' + esc(ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(1) + ' s') : '') + '</div>'
      + (steps ? '<ol class="ia-plan-s">' + steps + '</ol>' : '') + (ds ? '<div class="ia-plan-d">Reads: ' + ds + '</div>' : '') + '</div>';
  };
  UI.planActualHTML = function (rows) {
    rows = rows || [];
    if (!rows.length) return '';
    var word = { done: 'done', skipped: 'skipped', failed: 'failed', running: 'did not finish', not_run: 'planned, not run', unavailable: 'could not run' };
    return '<details class="ia-more"><summary>What ran — the plan against what actually happened (' + rows.filter(function (r) { return r.actual === 'done'; }).length + ' of ' + rows.length + ' steps done)</summary><div class="ia-more-b"><ol class="ia-ul">'
      + rows.map(function (r) { return '<li><b>' + esc(r.label || LABEL[r.stage] || r.stage) + '</b> — ' + esc(word[r.actual] || r.actual) + (r.detail ? ' <span class="ia-dim">(' + esc(String(r.detail).slice(0, 160)) + ')</span>' : '') + '</li>'; }).join('') + '</ol></div></details>';
  };
  var TYPE_LABEL = { CONFIRMED_FACT: 'Confirmed fact', STATISTIC: 'Statistic', EXTERNAL_REPORT: 'External report', HYPOTHESIS: 'Hypothesis', MODEL_ESTIMATE: 'Model estimate', MARKET_QUOTE: 'Market quote' };
  var VER_CLS = { VERIFIED: 'v', CORROBORATED: 'v', SINGLE_SOURCE: 'w', UNVERIFIED: 'u', CONTRADICTED: 'x', SUPERSEDED: 'u' };
  function srcCell(src) {
    if (!src) return '—';
    /* the class the researcher gave the claim (an official report mirrored on a data host is still official), else the domain's tier */
    var cls = src.reliability && src.reliability !== 'UNKNOWN' ? src.reliability : src.tier;
    if (src.url && /^https:\/\//.test(src.url)) return '<a href="' + esc(src.url) + '" target="_blank" rel="noopener noreferrer">' + esc(src.publisher || src.url) + '</a>' + (cls && cls !== 'UNKNOWN' ? ' <span class="ia-dim">' + esc(relWord(cls)) + '</span>' : '');
    return '<code class="ia-ds">' + esc(src.dataset_id || src.url || '') + '</code>';
  }
  /** The evidence ledger: every fact, typed, verified, dated; contradictions and flagged sources named. */
  UI.evidenceHTML = function (L, search) {
    if (!L || !(L.records || []).length) return '<p class="ia-dim">No evidence ledger for this item.</p>';
    var sm = L.summary || {}, bt = sm.by_type || {};
    var head = '<p class="ia-ev-sum">' + Object.keys(bt).map(function (k) { return bt[k] + ' ' + esc((TYPE_LABEL[k] || k).toLowerCase()) + (bt[k] === 1 ? '' : 's'); }).join(' · ')
      + (L.refused ? ' · <span class="ia-dim">' + L.refused + ' refused (no source or no time)</span>' : '') + '</p>'
      + ((sm.contradicted || []).length ? '<p class="ia-ev-x"><b>Contradicted:</b> ' + esc(sm.contradicted.slice(0, 3).join('; ')) + '</p>' : '')
      + ((sm.flagged || []).length ? '<p class="ia-ev-x"><b>Flagged as an attempt to instruct the model, demoted to a hypothesis:</b> ' + sm.flagged.length + ' source' + (sm.flagged.length === 1 ? '' : 's') + '</p>' : '')
      + ((sm.stale || []).length ? '<p class="ia-dim">Stale: ' + esc(sm.stale.slice(0, 3).join('; ')) + '</p>' : '');
    var srch = search && search.provider ? '<p class="ia-dim">External search: ' + esc(search.provider === 'claude_web_search' ? 'Claude web search' : search.provider) + ' — '
      + esc(search.status === 'OK' ? search.findings + ' cited finding' + (search.findings === 1 ? '' : 's') + ', ' + (search.refused || []).length + ' citation' + ((search.refused || []).length === 1 ? '' : 's') + ' refused' + (search.cost_usd ? ', $' + Number(search.cost_usd).toFixed(4) : '') : String(search.status || '').toLowerCase().replace(/_/g, ' ') + (search.why ? ': ' + search.why : '')) + '</p>'
      : search && search.why ? '<p class="ia-dim">' + esc(search.why) + '</p>' : '';
    var rows = (L.records || []).slice(0, 30).map(function (r) {
      var f = r.freshness || {};
      return '<tr><td><span class="ia-evt ia-evt-' + esc(String(r.type || '').toLowerCase()) + '">' + esc(TYPE_LABEL[r.type] || r.type) + '</span></td><td>' + esc(r.claim) + (r.search && r.search.summary_beyond_quote ? ' <span class="ia-dim">(the model said more than this quote)</span>' : '') + '</td><td data-l="Source">' + srcCell(r.source) + '</td>'
        + '<td data-l="Verification"><span class="ia-c-' + (VER_CLS[r.verification] || 'u') + '">' + esc(relWord(r.verification)) + '</span></td><td data-l="Freshness">' + esc(String(f.status || '').toLowerCase()) + (f.age_min != null ? ' <span class="ia-dim">· ' + esc(ago(new Date(Date.now() - f.age_min * 60000).toISOString())) + '</span>' : '') + '</td></tr>';
    }).join('');
    return head + srch + '<div class="ia-scroll"><table class="ia-tbl ia-ev"><tr><th>Type</th><th>Fact</th><th>Source</th><th>Verification</th><th>Freshness</th></tr>' + rows + '</table></div>';
  };
  var CALC_LABEL = { IMPLIED_PROBABILITY: 'Implied probability', NO_VIG: 'No-vig probability', FAIR_ODDS: 'Fair odds', BREAK_EVEN: 'Break-even probability', EXPECTED_VALUE: 'Expected value', PROBABILITY_EDGE: 'Probability edge',
    MAXIMUM_ENTRY_PRICE: 'Maximum entry price', LINE_DISCREPANCY: 'Projection vs market line', MARKET_FRESHNESS: 'Market freshness', CALIBRATION: "The model's measured record", SENSITIVITY: 'If the fair is wrong' };
  /** The calculation ledger: each number, its inputs and sources, its assumptions, and the independent recomputation. */
  UI.calcHTML = function (L) {
    if (!L || !(L.records || []).length) return '<p class="ia-dim">No calculation ledger for this item.</p>';
    var mc = L.market_comparison || {}, v = L.verification || {};
    var head = '<p class="' + (mc.status === 'AVAILABLE' ? '' : 'ia-ev-x') + '"><b>Market comparison:</b> ' + (mc.status === 'AVAILABLE' ? 'available — a verified price is on file' : 'unavailable — ' + esc(mc.why || 'no verified price')) + '</p>'
      + '<p class="ia-dim">' + esc((v.checked || 0) + ' of the computed numbers were recomputed independently: ' + (v.verdict === 'VERIFIED' ? 'all agree' : (v.mismatches || []).length + ' disagree')) + '</p>';
    var rows = L.records.map(function (r) {
      var o = r.output || {}, val = r.status === 'COMPUTED' ? esc(o.display != null ? o.display : String(o.value)) + (o.cover_display ? ' <span class="ia-dim">· cover ' + esc(o.cover_display) + '</span>' : '') : '<span class="ia-dim">unavailable — ' + esc(r.why || '') + '</span>';
      var ck = r.check && r.check.agrees === true ? '<span class="ia-c-v" title="independent recomputation agrees">✓</span>' : r.check && r.check.agrees === false ? '<span class="ia-c-x" title="recomputation disagrees">✗</span>' : '<span class="ia-dim">—</span>';
      var detail = (r.inputs || []).length || (r.assumptions || []).length ? '<details class="ia-calc-d"><summary>inputs and assumptions</summary><ul class="ia-ul">'
        + (r.inputs || []).map(function (i) { return '<li>' + esc(i.name) + ': <b>' + esc(i.value == null ? '—' : String(i.value)) + '</b>' + (i.unit ? ' ' + esc(i.unit) : '') + (i.source ? ' <span class="ia-dim">from ' + esc(i.source) + '</span>' : '') + '</li>'; }).join('')
        + (r.assumptions || []).map(function (a) { return '<li class="ia-dim">Assumes ' + esc(a) + '</li>'; }).join('') + '</ul><p class="ia-dim">' + esc(r.formula || '') + ' · ' + esc(r.version || '') + '</p></details>' : '';
      return '<tr><td>' + esc(CALC_LABEL[r.name] || r.name) + '</td><td>' + val + detail + '</td><td>' + ck + '</td></tr>';
    }).join('');
    return head + '<div class="ia-scroll"><table class="ia-tbl ia-calc"><tr><th>Calculation</th><th>Value</th><th>Check</th></tr>' + rows + '</table></div>';
  };
  var CH_STATUS = { CLEAR: ['clear', 'v'], CONCERN: ['concern', 'w'], UNRESOLVED: ['unresolved', 'x'], UNKNOWN: ['not checked', 'p'], NOT_APPLICABLE: ['not applicable', 'u'] };
  var CH_OUTCOME = { STANDS: 'The conclusion stands: nothing important was left unresolved.', CONFIDENCE_LOWERED: 'Open questions lowered research confidence; the status already reflects them.', DOWNGRADED: 'The challenge lowered the status.', PASS: 'The challenge turned it into a pass.', NOT_RUN: 'The challenge could not run, so nothing is published as verified.' };
  /** The eight questions, each with its answer from the run's own records. */
  UI.challengeHTML = function (ch) {
    if (!ch || !ch.questions) return ch && ch.outcome === 'NOT_RUN' ? '<p class="ia-ev-x">' + esc(CH_OUTCOME.NOT_RUN) + '</p>' : '';
    return '<p>' + esc(CH_OUTCOME[ch.outcome] || '') + (ch.classification && ch.classification.changed ? ' <b>' + esc(relWord(ch.classification.before)) + ' → ' + esc(relWord(ch.classification.after)) + '</b>' : '') + '</p>'
      + '<div class="ia-scroll"><table class="ia-tbl ia-ch"><tr><th>Question</th><th>Answer</th></tr>' + ch.questions.map(function (q) {
        var st = CH_STATUS[q.status] || [String(q.status).toLowerCase(), 'u'];
        return '<tr><td>' + esc(q.question) + '</td><td><span class="ia-c-' + st[1] + '"><b>' + esc(st[0]) + (q.severity && q.status !== 'CLEAR' && q.status !== 'NOT_APPLICABLE' && q.severity !== 'MINOR' ? ' · ' + esc(q.severity.toLowerCase()) : '') + '</b></span> ' + esc(q.answer) + '</td></tr>';
      }).join('') + '</table></div>';
  };
  var CONF_CLS = { HIGH: 'v', MODERATE: 'w', LOW: 'p', INSUFFICIENT: 'x' };
  /** Research confidence (a category, from the challenge) beside the probability of winning (the price's fair): two different things. */
  UI.confidenceHTML = function (row) {
    var ch = row && row.challenge, ev = (row && row.evaluation) || {}, c = ch && ch.confidence;
    var fair = num(ev.fair_probability);
    return (c ? '<span class="ia-chipcls ia-c-' + (CONF_CLS[c.after] || 'u') + '">' + esc(c.after.toLowerCase()) + '</span> research confidence' : '<span class="ia-dim">research confidence not assessed</span>')
      + ' <span class="ia-dim">·</span> ' + (fair != null ? '<b>' + esc(pct(fair)) + '</b> probability of winning <span class="ia-dim">(the fair the price is judged on)</span>' : '<span class="ia-dim">no probability of winning: nothing is priced</span>')
      + '<div class="ia-why">Research confidence is how well the evidence supports the conclusion; it is not a chance of winning, and the two are never combined.' + (c && (c.why || []).length ? ' Lowered by: ' + esc(c.why[0]) : '') + '</div>';
  };
  /** Why this is, or is not, actionable now — from the status, the market comparison and the challenge. */
  UI.actionableHTML = function (row) {
    var cl = (row && row.classification) || {}, mc = row && row.calc && row.calc.market_comparison, ch = row && row.challenge;
    if (cl.classification === 'VERIFIED_CANDIDATE' && !row.withheld_by_board) return '<b class="ia-pos">Yes, at the checked price</b> <span class="ia-dim">— the audit confirmed it on a fresh read' + (ch && ch.outcome === 'STANDS' ? ', and the challenge left nothing important unresolved' : '') + '. Re-check before acting: it is about the price when it was checked.</span>';
    var why = mc && mc.status !== 'AVAILABLE' ? mc.why : (cl.reasons || [])[0] || (ch && ch.questions ? (ch.questions.filter(function (q) { return q.status === 'UNRESOLVED' || q.status === 'UNKNOWN'; })[0] || {}).answer : null) || row.withheld_by_board;
    return '<b class="ia-neg">No</b> <span class="ia-dim">— ' + esc(why || 'it did not clear the audit') + '</span>';
  };
  /** The turn's number check: every probability, price and EV in the answer traced to a calculation. */
  UI.verificationHTML = function (qv) {
    if (!qv || !qv.numbers) return '';
    var n = qv.numbers, ok = qv.verdict === 'VERIFIED' && n.verdict === 'PASS';
    return '<p class="ia-vfy ' + (ok ? 'ia-vfy-ok' : 'ia-vfy-bad') + '">' + (ok ? '✓ ' : '⚠ ') + esc(n.supported + ' of ' + n.checked + ' numbers in this answer trace to a calculation; ' + qv.agreed + ' of ' + qv.checked + ' recomputed independently and agree')
      + (!ok && (n.unsupported || []).length ? esc(' — not traced: ' + n.unsupported.slice(0, 3).map(function (u) { return u.token; }).join(', ')) : '') + (!ok && (qv.mismatches || []).length ? esc(' — disagreeing: ' + qv.mismatches.map(function (m) { return m.name; }).join(', ')) : '') + '</p>';
  };

  /* ---------------- 4. READINESS ---------------- */
  var STATES = ['AVAILABLE', 'RESEARCH', 'MARKET', 'MODEL', 'ACTIONABLE'];
  var SHORT = { AVAILABLE: 'Available', RESEARCH: 'Research', MARKET: 'Market', MODEL: 'Model', ACTIONABLE: 'Signal' };
  function R() { return root.EDREADY || null; }
  function stateDots(a) {
    return '<span class="ia-dots">' + STATES.map(function (k) { var s = a && a.states && a.states[k]; return '<span class="ia-sd ' + (s ? (s.ok ? 'ok' : 'no') : 'na') + '" title="' + esc((R() ? R().LABEL[k] : k) + ': ' + (s ? (s.ok ? 'yes' : 'no') + ' — ' + s.why : 'unknown')) + '">' + esc(SHORT[k]) + '</span>'; }).join('') + '</span>';
  }
  /** A readiness counter strip: five numbers, each with its definition. */
  UI.readinessStripHTML = function (counts, o) {
    o = o || {};
    if (!counts) return '';
    var E = R();
    return '<div class="ia-ready" role="group" aria-label="What EdgeDesk can research">' + STATES.map(function (k) {
      return '<div class="ia-rk ia-rk-' + k.toLowerCase() + '" title="' + esc(E ? E.MEANS[k] : '') + '"><b>' + esc(counts[k] != null ? counts[k] : '—') + '</b><span>' + esc(E ? E.LABEL[k] : k) + '</span></div>';
    }).join('') + '</div>';
  };
  function gameRowHTML(g, a, why, o) {
    o = o || {};
    var sp = o.boardSport || BOARD_SPORT[g.sport] || g.sport, feed = FEED_SPORT[sp] || g.sport;
    var lbl = g.matchup || ((g.away || '') + ' @ ' + (g.home || ''));
    return '<li class="ia-g" data-level="' + esc(a ? a.level : '') + '"><div class="ia-g-t"><b>' + esc(lbl) + '</b><span class="ia-dim">' + esc(g.kickoff_local || when(g.kickoff)) + '</span></div>'
      + stateDots(a)
      /* the headline's bracketed reason is the first "Why not ready?" line, so with that list it is not repeated */
      + '<div class="ia-g-h">' + esc(a ? ((why || []).length ? a.headline.replace(/\s*\(.*\)$/, '') : a.headline) : '') + '</div>'
      + (o.audit ? auditBadge(o.audit) : '')
      + ((why || []).length ? '<details class="ia-why-d"><summary>Why not ready?</summary><ol>' + why.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ol></details>' : '')
      + '<div class="ia-g-a"><button type="button" class="ia-btn ia-btn-s" data-ia-game="' + esc(sp) + '|' + esc(g.game_id) + '">Game research</button>'
      + '<button type="button" class="ia-btn ia-btn-s" data-ia-askgame="' + esc(feed) + '|' + esc(g.game_id) + '|' + esc(lbl) + '">Ask EdgeDesk AI</button></div></li>';
  }
  /** The server's readiness answer (research_slate games with readiness), as a table with "Why not ready?". */
  UI.readinessTableHTML = function (games, summary) {
    games = games || [];
    if (!games.length) return '';
    return (summary && summary.counts ? UI.readinessStripHTML(summary.counts) : '') + '<ul class="ia-glist">' + games.map(function (g) { return gameRowHTML(g, g.readiness, g.why_not || []); }).join('') + '</ul>';
  };
  /**
   * The board's own row → EDREADY input (no audit: the board does not run one; when the reader has asked
   * EdgeDesk AI, the audit verdict it returned for the game is attached from AUDITED).
   */
  var AUDITED = {};
  UI.noteAudits = function (rows) {
    (rows || []).forEach(function (r) {
      if (!r || !r.candidate || !r.classification) return;
      var k = (BOARD_SPORT[r.candidate.sport] || r.candidate.sport) + '|' + r.candidate.game_id, cur = AUDITED[k];
      var rank = { VERIFIED_CANDIDATE: 0, WATCHLIST: 1, RESEARCH_REQUIRED: 2, REJECTED: 3, UNVERIFIED: 4 };
      var c = r.candidate, ev = r.evaluation || {};
      if (!cur || rank[r.classification.classification] < rank[cur.classification]) AUDITED[k] = { classification: r.classification.classification, final_status: r.classification.final_status || null, reason: (r.classification.reasons || [])[0] || null, at: Date.now(),
        sport: c.sport, sport_label: c.sport_label || null, game_id: String(c.game_id), matchup: c.matchup, kickoff_local: c.kickoff_local || null, kickoff: c.kickoff || null, market: c.market, selection: c.selection, line: c.line,
        entry_price: ev.ok ? ev.entry_price : null, book: c.quote && c.quote.book || null, net_ev: ev.net_ev_per_dollar != null ? Number(ev.net_ev_per_dollar) : null, max_price: ev.maximum_entry_price != null ? ev.maximum_entry_price : null,
        fair: r.research && r.research.fair_probability != null ? Number(r.research.fair_probability) : (ev.fair_probability != null ? Number(ev.fair_probability) : null),
        fair_kind: r.research && r.research.fair_kind ? r.research.fair_kind : (c.fair && c.fair.method === 'MODEL_BLEND' ? 'MODEL' : 'SHARP_NO_VIG') };
    });
    try { UI.paintCard(); } catch (_) { /* no Card host on this page */ }
  };
  UI.auditFor = function (sport, gid) { return AUDITED[sport + '|' + gid] || null; };
  function auditBadge(au) {
    if (!au) return '';
    return '<div class="ia-aud">Price audit by EdgeDesk AI: ' + chip(au.classification) + (au.reason ? ' <span class="ia-dim">' + esc(au.reason) + '</span>' : '') + '</div>';
  }
  UI.auditBadgeHTML = auditBadge;
  UI.fromBoardRow = function (r) {
    var p = r.p || {}, m = r.mkt || {}, cs = r.cs || {};
    var C = root.EDCanon;
    var dq = cs.key === 'DATA_FAULT' ? 'FAULT' : (r.sport === 'p4' && cs.key === 'LIMITED_DATA' && p.status === 'PREDICTED' ? 'LIMITED' : null);
    var hasLine = m.spread_line != null;
    var kind = !hasLine ? null : (m.reference_only ? 'LINE_ONLY' : 'PRICE');
    var mstatus = cs.key === 'MARKET_FAULT' ? 'FAULT' : (r.stale || m.stale) ? 'STALE' : 'CURRENT';
    var act = !!(C && C.ACTIONABLE_STATUSES && C.ACTIONABLE_STATUSES.indexOf(cs.key) >= 0);
    return {
      sport: r.sport, game_id: r.gid, home: r.home, away: r.away, kickoff: r.t ? new Date(r.t).toISOString() : null,
      /* the board's numbers are home MARGINS (nflverse: + = home favoured); EDREADY and the page speak betting lines */
      model: { status: p.status || null, home_line: p.model && p.model.fair_spread != null ? -p.model.fair_spread : null, total: p.model ? p.model.fair_total : null, tier: null, data_quality: dq, note: dq ? cs.reason : null },
      market: kind ? { kind: kind, status: kind === 'PRICE' ? mstatus : 'LINE_ONLY', actionable: kind === 'PRICE' && mstatus === 'CURRENT', captured_at: r.at ? new Date(r.at).toISOString() : null, limit_min: null, book: r.book || null, source: r.src || null, note: cs.key === 'MARKET_FAULT' ? cs.reason : null } : null,
      metrics: false,
      /* the board's "actionable" is its own gate (the canonical count above); a price audit EdgeDesk AI ran is shown
         beside it (auditBadge), never folded into the board's count */
      audit: null,
      gate: { actionable: act, status: cs.key || null, why: act ? null : (cs.reason || null) }
    };
  };
  /** The Research screen's readiness panel, from the board's rows. */
  UI.boardReadinessHTML = function (rows, o) {
    o = o || {};
    var E = R(); if (!E || !rows) return '';
    var now = Date.now();
    var items = rows.map(function (r) { var inp = UI.fromBoardRow(r); return { r: r, inp: inp, a: E.assess(inp, { now: now }) }; });
    var sum = E.summarize(items.map(function (x) { return x.a; }));
    var bySport = { nfl: [], p4: [] };
    items.forEach(function (x) { (bySport[x.r.sport] || (bySport[x.r.sport] = [])).push(x); });
    var top = sum.top_reason.MARKET;
    var lead = !items.length ? 'No pregame football games are loaded yet.'
      : 'Every game here can be researched' + (sum.counts.RESEARCH < sum.counts.total ? ' except ' + (sum.counts.total - sum.counts.RESEARCH) : '') + '. '
        + (sum.counts.MARKET < sum.counts.total ? (sum.counts.total - sum.counts.MARKET) + ' of ' + sum.counts.total + ' have no verified market price' + (top ? ' (most often: ' + top.reason + ')' : '') + ', so no signal on them can be checked yet — the research itself is still available.' : 'Every game has a verified market price.');
    var sportBlock = function (key, label) {
      var xs = bySport[key] || []; if (!xs.length) return '';
      var s2 = E.summarize(xs.map(function (x) { return x.a; })).counts;
      xs.sort(function (a, b) { return (a.r.t || 0) - (b.r.t || 0); });
      return '<details class="ia-sport"' + (o.open ? ' open' : '') + '><summary><b>' + esc(label) + '</b> <span class="ia-dim">' + s2.total + ' games · ' + s2.RESEARCH + ' researchable · ' + s2.MARKET + ' market verified · ' + s2.MODEL + ' model ready · ' + s2.ACTIONABLE + ' actionable</span></summary>'
        + '<ul class="ia-glist">' + xs.map(function (x) { return gameRowHTML({ sport: x.r.sport, game_id: x.r.gid, home: x.r.home, away: x.r.away, kickoff: x.inp.kickoff, matchup: (x.r.away || '') + ' @ ' + (x.r.home || '') }, x.a, E.whyNot(x.a), { boardSport: x.r.sport, audit: AUDITED[x.r.sport + '|' + x.r.gid] || null }); }).join('') + '</ul></details>';
    };
    return '<section class="ia-readiness fb-card" aria-labelledby="iaRdT"><div class="ia-rd-hd"><h3 id="iaRdT">What can EdgeDesk research right now?</h3>'
      + '<button type="button" class="ia-btn ia-btn-s" data-ia-ask="Explain why games aren\'t research ready this week">Why are games not ready?</button></div>'
      + UI.readinessStripHTML(sum.counts) + '<p class="ia-rd-lead">' + esc(lead) + '</p>'
      + (function () { var au = items.map(function (x) { return AUDITED[x.r.sport + '|' + x.r.gid]; }).filter(Boolean); if (!au.length) return '';
          var ok = au.filter(function (a) { return a.classification === 'VERIFIED_CANDIDATE'; }).length;
          return '<p class="ia-rd-aud">EdgeDesk AI has audited the price on ' + au.length + ' of these ' + items.length + ' game' + (items.length === 1 ? '' : 's') + ' in this session; ' + ok + ' survived as a verified candidate. The board’s own counts above are unchanged by it.</p>'; })()
      + '<p class="ia-dim ia-rd-def"><b>Research ready</b> (the count above) is a game with both a ready model and a verified market: ' + items.filter(function (x) { return x.a.states.MARKET.ok && x.a.states.MODEL.ok; }).length + ' here. <b>Research available</b> needs a projection or efficiency data. <b>Market verified</b> needs a current captured price from a book, not a reference line. <b>Model ready</b> needs a PREDICTED projection with no data fault. <b>Actionable</b> needs both, a disagreement that clears the research gates, and — before anything is called verified — the adversarial audit EdgeDesk AI runs.</p>'
      + sportBlock('nfl', 'NFL') + sportBlock('p4', 'College football') + '</section>';
  };

  /* ---------------- 4b. THE CARD: WHAT EDGEDESK AI AUDITED, AND HOW IT FARED ---------------- */
  /** The Card's research block: every candidate EdgeDesk AI audited this session, best status first (in memory only:
   *  a verdict is about a price at a moment, so it is not kept past the visit). */
  UI.cardResearchHTML = function () {
    var rank = { VERIFIED_CANDIDATE: 0, WATCHLIST: 1, RESEARCH_REQUIRED: 2, REJECTED: 3, UNVERIFIED: 4 };
    var list = Object.keys(AUDITED).map(function (k) { return AUDITED[k]; }).filter(function (a) { return a && a.selection; })
      .sort(function (a, b) { return (rank[a.classification] - rank[b.classification]) || ((b.net_ev || -9) - (a.net_ev || -9)); });
    var hd = '<div class="ia-cr-hd"><h3>Researched by EdgeDesk AI</h3><button type="button" class="ia-btn ia-btn-s" data-ia-goresearch>Ask EdgeDesk AI</button></div>';
    if (!list.length) return '<section class="ia-cardres" aria-label="Researched by EdgeDesk AI">' + hd + '<p class="ia-dim">Candidates EdgeDesk AI takes through research and the adversarial audit appear here with their status — verified candidate, watchlist, research required or rejected. Ask on the Research screen, for example “Analyze every NFL game this weekend.”</p></section>';
    var ok = list.filter(function (a) { return a.classification === 'VERIFIED_CANDIDATE'; }).length;
    return '<section class="ia-cardres" aria-label="Researched by EdgeDesk AI">' + hd
      + '<p class="ia-dim">' + list.length + ' candidate' + (list.length === 1 ? '' : 's') + ' audited this session; ' + ok + ' survived as a verified candidate. Each verdict is about the price when it was checked — re-ask before acting on it. The EV here is on the fair named beside it, which can differ from the fair the Card’s own decisions above are priced on.</p>'
      + '<ul class="ia-glist">' + list.map(function (a) {
        var bs = BOARD_SPORT[a.sport];
        return '<li class="ia-g"><div class="ia-g-t"><b>' + esc(a.selection) + (a.market === 'spreads' && a.line != null ? ' ' + esc(line(a.line)) : a.market === 'h2h' ? ' moneyline' : '') + '</b>' + chip(a.classification) + '</div>'
          + '<div class="ia-g-h">' + esc(a.matchup) + (a.kickoff_local ? ' · ' + esc(a.kickoff_local) : '') + '</div>'
          + '<dl class="ia-kv ia-kv-c">' + kv('Price checked', a.entry_price != null ? esc(am(a.entry_price)) + (a.book ? ' at ' + esc(a.book) : '') : '<span class="ia-dim">no verified price</span>')
          + kv('Net EV', a.net_ev != null ? '<span class="' + (a.net_ev > 0 ? 'ia-pos' : 'ia-neg') + '">' + esc(pct(a.net_ev, 2)) + ' per $1</span>' + (a.max_price != null ? ' <span class="ia-dim">· max ' + esc(am(a.max_price)) + '</span>' : '') : '<span class="ia-dim">not computed</span>')
          + kv('Fair used', a.fair != null ? esc(pct(a.fair)) + ' <span class="ia-dim">' + (a.fair_kind === 'MODEL' ? 'EdgeDesk model' : 'sharp market, no-vig') + '</span>' : '<span class="ia-dim">—</span>')
          + kv('Checked', esc(ago(new Date(a.at).toISOString()))) + '</dl>'
          + (a.reason ? '<div class="ia-why">' + esc(a.reason) + '</div>' : '')
          + '<div class="ia-g-a">' + (bs ? '<button type="button" class="ia-btn ia-btn-s" data-ia-game="' + esc(bs) + '|' + esc(a.game_id) + '">Game research</button>' : '')
          + '<button type="button" class="ia-btn ia-btn-s" data-ia-askgame="' + esc(a.sport) + '|' + esc(a.game_id) + '|' + esc(a.matchup) + '">Re-check with EdgeDesk AI</button></div></li>';
      }).join('') + '</ul></section>';
  };
  UI.paintCard = function () { var h = $('iaCardHost'); if (h) h.innerHTML = UI.cardResearchHTML(); };

  /* ---------------- 4c. PROCESS: HOW EDGEDESK RESEARCHES ---------------- */
  /** The methodology, validation and verification rules, as the code applies them (static: no number is computed here). */
  UI.methodologyHTML = function () {
    var E = R();
    var states = E ? E.STATES.map(function (k) { return '<li><b>' + esc(E.LABEL[k]) + '</b> — ' + esc(E.MEANS[k]) + '</li>'; }).join('') : '';
    var d = function (t, body, open) { return '<details class="ia-more"' + (open ? ' open' : '') + '><summary>' + esc(t) + '</summary><div class="ia-more-b">' + body + '</div></details>'; };
    return '<section class="ia-method fb-card" aria-labelledby="iaMethT"><h3 id="iaMethT">How EdgeDesk researches</h3>'
      + '<p class="ia-dim">What EdgeDesk AI does when you ask it something, and what it will and will not call verified. Every number it shows comes from EdgeDesk’s engines; no language model writes a probability, a price, an injury or a result.</p>'
      + d('The quantitative method', '<ol class="ia-ul"><li><b>Find the events</b> in the window you asked about, from EdgeDesk’s schedules and projections.</li>'
        + '<li><b>Compare prices</b>: a captured book price with its capture time is a market; a consensus reference line with no book or time is not, and is never priced.</li>'
        + '<li><b>Fair probability</b>: the sharp market’s de-vigged price, or EdgeDesk’s model where its tier allows it to price (below). Break-even comes from the price you would actually pay, fees included where a venue charges them — each venue’s own fee rule, never another’s.</li>'
        + '<li><b>Net EV and the maximum price</b> follow from the fair and the price; a one-point error in the fair is re-run to see whether the edge survives it.</li></ol>', false)
      + d('Model validation', '<ul class="ia-ul"><li><b>VALIDATED</b> — held-out testing supports the model’s probabilities for this sport and market; only then is it called calibrated.</li>'
        + '<li><b>LEAN</b> — partially validated: a break-even history, not a profit record. It may price, and is labelled.</li>'
        + '<li><b>RESEARCH</b> — experimental: shown for context, never used as the price.</li>'
        + '<li>Where the board prices on the sharp market, EdgeDesk’s model is shown as a cross-check, not swapped in.</li></ul>', false)
      + d('Research verification', '<ul class="ia-ul"><li>Every finding carries its source link, publisher, publication and retrieval time, and a reliability class: official, credible journalism, statistical data, speculation, opinion or unknown.</li>'
        + '<li>“Sources say”, “expected to” and “could” make a claim speculation; speculation is never verified.</li>'
        + '<li>When an official report and a newer credible report conflict, the conflict stays unresolved and the candidate is held as research required.</li>'
        + '<li>A finding moves a number only through the engine’s own re-run with one input changed (a quarterback out), never by judgement.</li></ul>', false)
      + d('The adversarial audit and “verified candidate”', '<p>Each priced candidate is re-read on a fresh price and checked by an auditor that can overrule the researcher. It is a <b>verified candidate</b> only when all of these hold: the audit confirms it on the fresh read; every professional check passes; the engine classes it a verified edge; and its EV stays positive with the fair one point lower. Otherwise it is a watchlist, research required or rejected — and the answer says which check stopped it.</p>', false)
      + d('Evidence, calculations and the challenge', '<ul class="ia-ul"><li><b>Every fact is a record</b>: a confirmed fact, a statistic, an external report, a hypothesis, a model estimate or a market quote — with its source, when it was published and read, whether it is verified, corroborated, single-source, contradicted or superseded, and whether it is still fresh for its topic and for how close the game is.</li>'
        + '<li>Text from outside sources is treated as data, never as instructions: anything that tries to instruct the model is flagged and demoted to an unverified hypothesis.</li>'
        + '<li><b>Every number is a calculation record</b> — its formula, inputs and their sources, assumptions and version — recomputed independently; the answer says how many of its numbers trace to a calculation. Without a verified price the market comparison says it is unavailable; nothing is substituted.</li>'
        + '<li><b>Before anything is published, a challenge pass asks eight questions</b>: what contradicts it, whether the statistics are outdated, whether the sample is adequate, whether key players are missing, whether the quote is stale, whether the model is calibrated, whether missing data could explain the edge, and whether it survives other reasonable assumptions. It can only lower a verdict. Research confidence is a category with reasons — never a percentage, and never mixed with the probability of winning.</li></ul>', false)
      + d('What EdgeDesk remembers, and what it does not claim', '<ul class="ia-ul"><li>Each research run is recorded: your question, the plan and what actually ran, the sources, the prices and projections it used, its conclusions and its cost. Results and closing lines are recorded separately, after the game.</li>'
        + '<li>Calibration — Brier score, log loss and closing-line value — is measured on predictions frozen before their games, never on anything decided afterwards.</li>'
        + '<li>EdgeDesk does not learn automatically from results. Measuring a model is not changing it; any change to a model is a separate, reviewed release.</li></ul>', false)
      + d('Readiness: five separate states', '<ul class="ia-ul">' + states + '</ul><p class="ia-dim">A game stays researchable with no market and no signal: “not ready to price” is not “not ready to research”.</p>', false)
      + d('Limits and cost', '<ul class="ia-ul"><li>EdgeDesk AI never requests fresh odds; it reads the prices EdgeDesk has already captured.</li><li>External web search is off unless the operator switches it on; when on, only a cited quote from an allowed source can become evidence, and every call is claimed against a dollar budget first.</li><li>No paid research provider is enabled; every outside source goes through one budget with quotas, caching and a circuit breaker.</li>'
        + '<li>Your daily EdgeDesk AI allowance applies; when it is reached, the Research screen, the Card and every game page keep working.</li><li>Past results describe the past; they do not predict future results.</li></ul>', false)
      + '<p class="ia-meth-a"><button type="button" class="ia-btn ia-btn-p" data-ia-goresearch>Ask EdgeDesk AI on Research</button></p></section>';
  };
  UI.paintMethod = function () { var h = $('iaMethodHost'); if (h && !h.getAttribute('data-ia-painted')) { h.innerHTML = UI.methodologyHTML(); h.setAttribute('data-ia-painted', '1'); } };

  /* ---------------- 5. THE SERVER'S ANSWERS, AS INTERACTIVE RESULTS ---------------- */
  /** Extra result sections for an answer The Desk renders (called by its quant renderer). */
  /* "Is X playing?" — one player's (or one club's starter's) status: the status, each source's own words with its time, any disagreement, the engine's re-run */
  var AV_CLS = { CONFLICTING: 'x', CHANGED: 'x', OUT: 'x', DOUBTFUL: 'w', QUESTIONABLE: 'w', LISTED_STARTER: 'p', PROBABLE: 'p', STARTING: 'p', ACTIVE: 'v', NO_REPORT: 'u', NOT_RESEARCHED: 'u' };
  var AV_WORD = { CONFLICTING: 'sources disagree', CHANGED: 'starter change reported', OUT: 'out', DOUBTFUL: 'doubtful', QUESTIONABLE: 'questionable', LISTED_STARTER: 'listed starter, not confirmed', PROBABLE: 'probable, not confirmed', STARTING: 'listed to start', ACTIVE: 'expected to play', NO_REPORT: 'no report', NOT_RESEARCHED: 'not researched' };
  UI.availabilityHTML = function (a) {
    if (!a) return '';
    var st = a.status || {}, code = String(st.code || ''), who = a.player || a.team || '';
    var h = '<div class="ia-res ia-av"><div class="ia-res-h">' + esc(a.kind === 'MLB_STARTER' ? 'Starting pitcher — ' + (a.team || '') : 'Availability — ' + who) + (a.game ? ' <span class="ia-dim">· ' + esc(a.game.matchup) + '</span>' : '') + '</div>'
      + '<p><span class="ia-c-' + (AV_CLS[code] || 'u') + '">' + esc(AV_WORD[code] || code.toLowerCase().replace(/_/g, ' ')) + '</span> ' + esc(st.text || '') + '</p>';
    if (a.unknown_name) h += '<p class="ia-ev-x">EdgeDesk holds no report on ' + esc(a.unknown_name) + ' and gives no status for them.</p>';
    /* a conflict the status already states is not repeated; a resolved one is shown, with how it was settled */
    if ((a.conflicts || []).length && code !== 'CONFLICTING' && code !== 'CHANGED') h += '<p class="ia-ev-x"><b>Sources disagreed:</b> ' + esc(a.conflicts.slice(0, 3).map(function (c) { return c.detail; }).join('; ')) + '</p>';
    var recs = a.records || [];
    if (recs.length) h += '<div class="ia-scroll"><table class="ia-tbl ia-ev"><tr><th>Source</th><th>What it says</th><th>When</th><th>Freshness</th></tr>' + recs.map(function (r) {
      var f = r.freshness || {};
      var spec = r.type === 'HYPOTHESIS' || /SPECULATION/.test(String(r.source && r.source.reliability || ''));
      return '<tr><td data-l="Source">' + srcCell(r.source) + '</td><td>' + esc(r.claim) + (spec ? ' <span class="ia-dim">(speculation — not counted toward the status)</span>' : '') + '</td><td data-l="When">' + esc(r.published_at ? ago(r.published_at) : (r.retrieved_at ? 'retrieved ' + ago(r.retrieved_at) : '—')) + '</td><td data-l="Freshness">' + esc(f.status ? String(f.status).toLowerCase() : '—') + '</td></tr>';
    }).join('') + '</table></div>';
    else h += '<p class="ia-dim">No source on file names this player for this game.</p>';
    if (a.scenario) h += '<p class="ia-dim">If ' + esc(who) + ' does not play, the engine’s own re-run prices ' + esc(a.game ? a.game.matchup.split(' @ ')[1] : 'the home side') + ' at ' + esc((a.scenario.home_line > 0 ? '+' : '') + a.scenario.home_line) + (a.scenario.base_home_line != null ? ' instead of ' + esc((a.scenario.base_home_line > 0 ? '+' : '') + a.scenario.base_home_line) : '') + ' — a model re-run, not a market price.</p>';
    if (a.game) h += '<div class="ia-g-a"><button type="button" class="ia-btn ia-btn-s" data-ia-askgame="' + esc(a.sport) + '|' + esc(a.game.game_id) + '|' + esc(a.game.matchup) + '">Research this game</button></div>';
    return h + '</div>';
  };
  /* what EdgeDesk does not measure (an uncovered sport, an outcome no one can know, a guarantee): said once, with what it covers */
  UI.unsupportedHTML = function (u) {
    if (!u) return '';
    return '<div class="ia-res ia-un"><div class="ia-res-h">' + esc(u.kind === 'SPORT' ? 'Not covered' : u.kind === 'CERTAINTY' ? 'No guarantees' : 'Not something EdgeDesk can know') + '</div>'
      + '<p class="ia-dim">Nothing was researched and no model was asked.</p>'
      + '<div class="ia-ex"><button type="button" class="ia-chip" data-ia-ask="What\'s the best bet this weekend across all sports?">What\'s the best bet this weekend across all sports?</button></div></div>';
  };
  UI.resultHTML = function (d) {
    if (!d) return '';
    var sl = d.research_slate, gr = d.game_research, sc = d.scan, me = d.matchup_edges, vc = d.venue_compare;
    var h = UI.verificationHTML(d.quant_verification) + UI.planActualHTML(d.research_plan_actual);
    if (d.availability) h += UI.availabilityHTML(d.availability);
    if (d.unsupported) h += UI.unsupportedHTML(d.unsupported);
    if (gr) {
      var gg = gr.game;
      if (gg) {
        h += '<div class="ia-res"><div class="ia-res-h">Readiness — ' + esc(gg.matchup) + '</div>' + stateDots(gg.readiness) + '<p>' + esc(gg.readiness ? gg.readiness.headline : '') + '</p>'
          + ((gg.why_not || []).length ? '<details class="ia-why-d" open><summary>Why not ready?</summary><ol>' + gg.why_not.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ol></details>' : '') + '</div>';
        if (gg.calc) h += '<details class="ia-more"><summary>The projection against the market — calculation checks</summary><div class="ia-more-b">' + UI.calcHTML(gg.calc) + '</div></details>';
        if (gg.evidence) h += '<details class="ia-more"><summary>Evidence on this game — every fact, typed and dated (' + (gg.evidence.summary ? gg.evidence.summary.total : 0) + ')</summary><div class="ia-more-b">' + UI.evidenceHTML(gg.evidence) + '</div></details>';
        if (gg.research && (gg.research.findings || []).length) h += '<details class="ia-more"><summary>Injury, lineup and starter findings (' + gg.research.findings.length + ')</summary><div class="ia-more-b">' + UI.sourcesHTML(gg.research.findings) + '<ul class="ia-ul">' + gg.research.findings.slice(0, 20).map(function (f) { return '<li>' + esc(f.claim) + ' <span class="ia-dim">(' + esc(relWord(f.reliability)) + ')</span></li>'; }).join('') + '</ul></div></details>';
      }
      UI.noteAudits(gr.investigated);
      h += UI.candidateCardsHTML(gr.investigated, gr.games);
    } else if (sl && sl.mode === 'READINESS') {
      h += '<div class="ia-res"><div class="ia-res-h">Game by game</div>' + UI.readinessTableHTML(sl.games, sl.readiness) + '</div>';
    } else if (sl) {
      UI.noteAudits(sl.investigated);
      if ((sl.games || []).length) h += '<details class="ia-more" open><summary>Every game — model, market, readiness (' + sl.games.length + ')</summary><div class="ia-more-b">' + UI.readinessTableHTML(sl.games, sl.readiness) + '</div></details>';
      h += UI.candidateCardsHTML(sl.investigated, sl.games);
    } else if (sc && sc.researched) {
      var rows = [sc.best].concat(sc.verified_rest || [], sc.potential || [], sc.near_misses || []).filter(Boolean);
      UI.noteAudits(rows);
      h += UI.candidateCardsHTML(rows, []);
    }
    if (me && me.rows && me.rows.length) h += '<div class="ia-scroll"><table class="ia-tbl"><tr><th>Unit</th><th>Against</th><th>Game</th><th>Edge</th></tr>' + me.rows.slice(0, 8).map(function (r) { return '<tr><td>' + esc(r.offense) + '</td><td>' + esc(r.defense) + '</td><td>' + esc(r.matchup) + '</td><td>' + esc((r.edge >= 0 ? '+' : '') + Number(r.edge).toFixed(3)) + '</td></tr>'; }).join('') + '</table></div>';
    if (vc && vc.venues) h += '<div class="ia-scroll"><table class="ia-tbl"><tr><th>Venue</th><th>Live prices</th><th>Fee rule</th><th>Status</th></tr>' + vc.venues.map(function (v) { return '<tr><td>' + esc(v.label) + '</td><td>' + (v.captured ? 'captured' : 'not captured') + '</td><td>' + esc(v.fee) + '</td><td>' + esc(String(v.verification || '').toLowerCase()) + '</td></tr>'; }).join('') + '</table></div>';
    return h ? '<div class="ia-results">' + h + '</div>' : '';
  };

  /* ---------------- 6. THE GAME RESEARCH VIEW ---------------- */
  var ART = {};
  function art(path) {
    if (ART[path] && Date.now() - ART[path].at < 5 * 60000) return ART[path].p;
    var p = fetch('/' + path.replace(/^\//, ''), { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
    ART[path] = { at: Date.now(), p: p };
    return p;
  }
  UI._clearArtifacts = function () { ART = {}; };
  function sheetEl() {
    var el = $('igSheet');
    if (!el) {
      el = doc.createElement('div'); el.id = 'igSheet'; el.className = 'ig-sheet'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-labelledby', 'igT'); el.hidden = true;
      el.innerHTML = '<div class="ig-scrim" data-ig-close></div><div class="ig-panel"><header class="ig-hd"><button type="button" class="ia-btn ia-btn-s ig-back" data-ig-close aria-label="Close game research">← Back</button><h2 id="igT">Game research</h2></header><div class="ig-body" id="igBody"></div>'
        + '<footer class="ig-ft"><button type="button" class="ia-btn ia-btn-p ig-ai" id="igAi">Research with EdgeDesk AI</button></footer></div>';
      doc.body.appendChild(el);
    }
    return el;
  }
  UI.closeGame = function () { var el = $('igSheet'); if (el) { el.hidden = true; doc.documentElement.classList.remove('ig-open'); } if (LAST_FOCUS && LAST_FOCUS.focus) { try { LAST_FOCUS.focus(); } catch (_) { /* gone */ } } };
  var LAST_FOCUS = null;
  function sec(title, body, o) { o = o || {}; return '<section class="ig-sec"' + (o.id ? ' id="' + o.id + '"' : '') + '><h3>' + esc(title) + '</h3>' + body + '</section>'; }
  function ratingRow(label, a, b, ka, kb, lowerBetter) {
    var va = a && a.ratings ? num(a.ratings[ka]) : null, vb = b && b.ratings ? num(b.ratings[kb]) : null;
    var ra = a && a.ranks && a.ranks[ka] ? a.ranks[ka].rank + '/' + a.ranks[ka].of : '', rb = b && b.ranks && b.ranks[kb] ? b.ranks[kb].rank + '/' + b.ranks[kb].of : '';
    return '<tr><td>' + esc(label) + '</td><td>' + (va == null ? '—' : esc(va.toFixed(3))) + ' <span class="ia-dim">' + esc(ra) + '</span></td><td>' + (vb == null ? '—' : esc(vb.toFixed(3))) + ' <span class="ia-dim">' + esc(rb) + '</span></td></tr>';
  }
  /**
   * Open one game: o = { sport: 'nfl'|'p4', gid, row (the board's row, optional) }.
   * Reads only what is published: the board row, the NFL slate (ratings, forecast, venue, starters),
   * the injury build, the team identity files (recent games), and the college slate.
   */
  UI.openGame = async function (o) {
    o = o || {};
    var el = sheetEl(), body = $('igBody');
    LAST_FOCUS = doc.activeElement;
    el.hidden = false; doc.documentElement.classList.add('ig-open');
    var row = o.row || (typeof root.fbRowFor === 'function' ? root.fbRowFor(o.sport, o.gid) : null);
    var feed = FEED_SPORT[o.sport] || o.sport;
    var title = row ? (row.away + ' @ ' + row.home) : String(o.gid);
    $('igT').textContent = title;
    UI.setCurrentGame({ sport: feed, game_id: String(o.gid), label: title, board_sport: o.sport });
    body.innerHTML = '<p class="ia-dim ig-loading">Loading what EdgeDesk holds for this game…</p>';
    var aiBtn = $('igAi');
    if (aiBtn) aiBtn.onclick = function () { UI.ask(GAME_Q, { game: { sport: feed, game_id: String(o.gid), label: title }, hint: 'GAME_RESEARCH' }); };
    var E = R();
    var a = row && E ? E.assess(UI.fromBoardRow(row), { now: Date.now() }) : null;
    var parts = [];
    try {
      var nfl = o.sport === 'nfl' ? await art('football/nfl/slate.json') : null;
      var met = o.sport === 'nfl' ? await art('football/matchup/metrics.json') : null;
      var fbs = o.sport === 'p4' ? await art('football/fbs/slate.json') : null;
      var sg = nfl && nfl.games ? nfl.games.filter(function (g) { return String(g.game_id) === String(o.gid); })[0] : null;
      var cg = fbs && fbs.games ? fbs.games.filter(function (g) { return String(g.game_id) === String(o.gid); })[0] : null;
      var H = sg && nfl.teams ? nfl.teams[sg.home_code] : null, A = sg && nfl.teams ? nfl.teams[sg.away_code] : null;
      var kick = row && row.t ? new Date(row.t).toISOString() : (sg && sg.kickoff) || (cg && cg.kickoff) || null;
      var home = row ? row.home : (sg ? sg.home_team : cg ? cg.home_team : ''), away = row ? row.away : (sg ? sg.away_team : cg ? cg.away_team : '');
      /* 1. the game */
      parts.push('<div class="ig-top"><div class="ig-teams">' + esc(away) + ' <span class="ia-dim">@</span> ' + esc(home) + '</div><div class="ia-dim">' + esc(when(kick)) + (sg && sg.venue ? ' · ' + esc(sg.venue) : '') + (o.sport === 'nfl' ? ' · NFL' : ' · College football') + '</div></div>');
      /* 2. readiness */
      if (a) parts.push(sec('Readiness', stateDots(a) + '<p>' + esc(a.headline) + '</p>' + auditBadge(UI.auditFor(o.sport, o.gid)) + (E.whyNot(a).length ? '<details class="ia-why-d"' + (a.level === 'ACTIONABLE' ? '' : ' open') + '><summary>Why not ready?</summary><ol>' + E.whyNot(a).map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ol></details>' : '')));
      /* 3. numbers */
      var p = row && row.p, m = row && row.mkt;
      /* the board row holds home margins (+ = home favoured); the slates hold betting lines (− = home favoured) */
      var mLine = p && p.model && p.model.fair_spread != null ? -p.model.fair_spread : (sg ? sg.model_home_line : cg ? cg.model_home_line : null);
      var mTot = p && p.model ? p.model.fair_total : (sg ? sg.model_fair_total : cg ? cg.model_fair_total : null);
      var mVer = a && a.states && a.states.MARKET.ok;
      /* the board computes its projection live; EdgeDesk AI researches the nightly build. When they differ, both are shown, named */
      var sLine = sg && sg.model_home_line != null ? Number(sg.model_home_line) : null;
      var twoLines = p && p.model && mLine != null && sLine != null && Math.abs(mLine - sLine) >= 0.5;
      var nums = '<dl class="ia-kv">' + kv('Model spread', mLine != null ? esc(home) + ' ' + esc(line(Math.round(mLine * 10) / 10)) + (twoLines ? ' <span class="ia-dim">board, computed live</span><div class="ia-why">Nightly build (what EdgeDesk AI researches): ' + esc(home) + ' ' + esc(line(Math.round(sLine * 10) / 10)) + ', built ' + esc(utc(nfl.generated_at)) + '</div>' : '') : 'none on file')
        + kv('Model total', mTot != null ? esc(Math.round(mTot * 10) / 10) : 'none on file')
        + kv('Market spread', m && m.spread_line != null ? esc(home) + ' ' + esc(line(-m.spread_line)) + ' <span class="ia-dim">' + (mVer ? 'verified · ' + esc(row.book || 'captured') + (row.at ? ', ' + esc(ago(new Date(row.at).toISOString())) : '') : (m.reference_only ? 'reference line — not a price' : 'not current — not verified')) + '</span>' : '<span class="ia-dim">no market spread on file</span>')
        + kv('Market total', m && m.total_line != null ? esc(m.total_line) + ' <span class="ia-dim">' + (mVer ? 'verified' : 'not verified') + '</span>' : '<span class="ia-dim">no market total on file</span>')
        + kv('Model disagreement', row && row.gapS != null ? esc(Math.abs(row.gapS).toFixed(1)) + ' points <span class="ia-dim">' + esc(row.cs ? row.cs.t || '' : '') + '</span>' + (row.cs && row.cs.reason ? '<div class="ia-why">' + esc(row.cs.reason) + '</div>' : '') : '<span class="ia-dim">not measurable without both numbers</span>') + '</dl>';
      parts.push(sec('Model and market', nums));
      /* 4. efficiency + matchup advantages (NFL ratings) */
      if (H && A) {
        parts.push(sec('Offensive and defensive efficiency', '<div class="ia-scroll"><table class="ia-tbl"><tr><th>EPA rating</th><th>' + esc(A.team) + '</th><th>' + esc(H.team) + '</th></tr>'
          + ratingRow('Offense per play', A, H, 'off_epa_play', 'off_epa_play') + ratingRow('Pass per dropback', A, H, 'pass_epa_db', 'pass_epa_db') + ratingRow('Rush per carry', A, H, 'rush_epa_att', 'rush_epa_att')
          + ratingRow('Defense per play allowed', A, H, 'def_epa_play', 'def_epa_play') + ratingRow('Pass defense allowed', A, H, 'def_pass_epa_db', 'def_pass_epa_db') + ratingRow('Rush defense allowed', A, H, 'def_rush_epa_att', 'def_rush_epa_att')
          + '</table></div><p class="ia-dim">EdgeDesk NFL slate ratings (nflverse play-by-play), built ' + esc(utc(nfl.generated_at)) + '. Rank 1 = best for offense; for defense, the rating is what the defense allows.</p>'));
        var mm = function (o2, d2, ko, kd) { var x = num(o2.ratings[ko]), y = num(d2.ratings[kd]); return x == null || y == null ? null : Math.round((x + y) * 1000) / 1000; };
        var adv = [[A, H, 'off_epa_play', 'def_epa_play', 'offense'], [H, A, 'off_epa_play', 'def_epa_play', 'offense'], [A, H, 'pass_epa_db', 'def_pass_epa_db', 'passing'], [H, A, 'pass_epa_db', 'def_pass_epa_db', 'passing'], [A, H, 'rush_epa_att', 'def_rush_epa_att', 'rushing'], [H, A, 'rush_epa_att', 'def_rush_epa_att', 'rushing']]
          .map(function (x) { return { t: x[0].team + ' ' + x[4] + ' vs ' + x[1].team + ' defense', v: mm(x[0], x[1], x[2], x[3]) }; }).filter(function (x) { return x.v != null; }).sort(function (x, y) { return y.v - x.v; });
        parts.push(sec('Matchup advantages', '<ol class="ia-ul">' + adv.slice(0, 4).map(function (x) { return '<li>' + esc(x.t) + ': <b>' + esc((x.v >= 0 ? '+' : '') + x.v.toFixed(3)) + '</b> EPA rating</li>'; }).join('') + '</ol><p class="ia-dim">One side’s rating plus the opposing unit’s — the pairing the projection engine uses. Context, not a probability.</p>'));
      } else if (cg) {
        parts.push(sec('Efficiency', '<dl class="ia-kv">' + kv('Quarterback EPA per play', esc(away) + ' ' + esc(cg.away_qb_epa != null ? Number(cg.away_qb_epa).toFixed(3) : '—') + ' · ' + esc(home) + ' ' + esc(cg.home_qb_epa != null ? Number(cg.home_qb_epa).toFixed(3) : '—'))
          + kv('Projection reliability', esc(cg.reliability_grade || '—') + (cg.reliability_score != null ? ' (' + esc(cg.reliability_score) + ')' : '')) + kv('Data completeness', cg.data_completeness != null ? esc(Math.round(cg.data_completeness * 100)) + '%' : '—') + '</dl><p class="ia-dim">The college build publishes quarterback EPA and the projection, not unit-against-unit ratings.</p>'));
      }
      /* 5. availability */
      if (met && met.nfl && met.nfl.teams && sg) {
        var avail = [[sg.away_code, away], [sg.home_code, home]].map(function (x) {
          var t = met.nfl.teams[x[0]] || {}, inj = (t.injuries && t.injuries.players) || [];
          var st = t.starter ? '<li><b>Starter (QB):</b> ' + esc(t.starter.player_name) + ' <span class="ia-dim">' + esc(t.starter.source || '') + (t.starter.published_at ? ', ' + esc(utc(t.starter.published_at)) : '') + '</span></li>' : '';
          var key = inj.filter(function (pl) { return /out|doubt|question|ir/i.test(pl.status || ''); }).slice(0, 8);
          return '<div class="ig-av"><b>' + esc(x[1]) + '</b><ul class="ia-ul">' + st + (key.length ? key.map(function (pl) { return '<li>' + esc(pl.name) + ' (' + esc(pl.position || '') + ') — ' + esc(pl.status) + (pl.injury ? ', ' + esc(pl.injury) : '') + '</li>'; }).join('') : '<li class="ia-dim">nobody listed out, doubtful or questionable</li>') + '</ul><p class="ia-dim">Official injury report (nflverse), retrieved ' + esc(utc(t.injuries && t.injuries.retrieved_at)) + '.</p></div>';
        }).join('');
        parts.push(sec('Player availability', avail));
      } else if (cg) {
        parts.push(sec('Player availability', '<dl class="ia-kv">' + kv('Starters on file', esc(away) + ': ' + esc((cg.away_starter && (cg.away_starter.player_name || cg.away_starter.name)) || 'not on file') + ' · ' + esc(home) + ': ' + esc((cg.home_starter && (cg.home_starter.player_name || cg.home_starter.name)) || 'not on file')) + '</dl><p class="ia-dim">College availability is operator-entered; no official feed is wired.</p>'));
      }
      /* 6. recent performance (identity files) */
      if (sg) {
        var ids = await Promise.all([art('football/identity/teams/' + String(sg.away_team_id || sg.away_code || '').toLowerCase() + '.json'), art('football/identity/teams/' + String(sg.home_team_id || sg.home_code || '').toLowerCase() + '.json')]);
        var rec = ids.map(function (idf, i) {
          var gs = idf && idf.trend && idf.trend.games ? idf.trend.games.slice(-3) : [];
          return '<div class="ig-av"><b>' + esc(i ? home : away) + '</b>' + (gs.length ? '<div class="ia-scroll"><table class="ia-tbl"><tr><th>Week</th><th>Opp</th><th>Off EPA/play</th><th>Def EPA/play</th></tr>' + gs.map(function (g) { return '<tr><td>' + esc(g.week) + '</td><td>' + esc(g.opponent) + '</td><td>' + esc(g.off_epa_play) + '</td><td>' + esc(g.def_epa_play) + '</td></tr>'; }).join('') + '</table></div>' : '<p class="ia-dim">no recent games on file</p>') + '</div>';
        }).join('');
        parts.push(sec('Recent performance', rec + '<p class="ia-dim">Per-game team rates from the nflverse team-week feed (team identity build).</p>'));
      }
      /* 7. weather and venue */
      var f = sg && sg.forecast;
      if (sg) parts.push(sec('Weather and venue', '<dl class="ia-kv">' + kv('Venue', esc(sg.venue || '—') + ' <span class="ia-dim">' + esc([sg.roof, sg.surface].filter(Boolean).join(' · ')) + '</span>')
        + kv('Forecast', f ? (f.dome ? 'indoors' : esc(f.temp_f != null ? Math.round(f.temp_f) + '°F' : '—') + ', wind ' + esc(f.wind_mph != null ? Math.round(f.wind_mph) + ' mph' : '—') + (f.precip_in ? ', precip ' + esc(f.precip_in) + ' in' : '')) + ' <span class="ia-dim">' + esc(f.source || 'forecast') + ', ' + esc(utc(f.as_of)) + '</span>' : '<span class="ia-dim">no forecast on file yet</span>') + '</dl>'));
      else if (cg) parts.push(sec('Weather and venue', '<dl class="ia-kv">' + kv('Venue', esc(cg.venue || '—') + (cg.neutral_site ? ' <span class="ia-dim">neutral site</span>' : '')) + '</dl>'));
      /* 8. sources and timestamps */
      var src = [];
      if (nfl) src.push(['EdgeDesk NFL slate (projection, ratings, forecast)', nfl.generated_at]);
      if (met) src.push(['NFL injury build (nflverse)', met.generated_at]);
      if (fbs) src.push(['EdgeDesk college slate', fbs.generated_at]);
      if (row && row.at) src.push(['Captured market price (' + (row.book || 'book') + ')', new Date(row.at).toISOString()]);
      parts.push(sec('Research sources and last updated', '<ul class="ia-ul">' + src.map(function (x) { return '<li>' + esc(x[0]) + ' — ' + esc(utc(x[1])) + (x[1] ? ' <span class="ia-dim">(' + esc(ago(x[1])) + ')</span>' : '') + '</li>'; }).join('') + '</ul>'));
      parts.push(sec('Ask about this game', '<div class="ia-ex">' + ['Why does EdgeDesk disagree with this spread?', "Explain why this game isn't research ready.", 'What are the biggest offensive mismatches in this game?'].map(function (q) { return '<button type="button" class="ia-chip" data-ia-askgame-q="' + esc(feed) + '|' + esc(o.gid) + '|' + esc(title) + '|' + esc(q) + '">' + esc(q) + '</button>'; }).join('') + '</div>'));
      body.innerHTML = parts.join('');
    } catch (e) {
      body.innerHTML = parts.join('') + UI.retryHTML('Part of this game’s research could not be loaded (' + String(e && e.message || e).slice(0, 80) + '). What is shown above is what EdgeDesk holds.', [{ label: 'Try again', attr: 'data-ia-game="' + esc(o.sport) + '|' + esc(o.gid) + '"', primary: true }]);
    }
    try { var bk = el.querySelector('.ig-back'); if (bk) bk.focus(); } catch (_) { /* no focus */ }
  };

  /* ---------------- event delegation ---------------- */
  if (doc) {
    doc.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('[data-ia-ask],[data-ia-game],[data-ia-askgame],[data-ia-askgame-q],[data-ig-close],[data-ia-cancel],[data-ia-clear-game],[data-ia-retry],[data-ia-goresearch]') : null;
      if (!t) return;
      if (t.hasAttribute('data-ia-goresearch')) { UI.goResearch(); return; }
      if (t.hasAttribute('data-ia-ask')) {
        var q = t.getAttribute('data-ia-ask');
        var o = {}; if (CURRENT_GAME && /\b(this|that) (game|spread|matchup)\b/i.test(q)) o.game = CURRENT_GAME;
        UI.ask(q, o); return;
      }
      if (t.hasAttribute('data-ia-game')) { var g = t.getAttribute('data-ia-game').split('|'); UI.openGame({ sport: g[0], gid: g[1] }); return; }
      if (t.hasAttribute('data-ia-askgame')) { var a = t.getAttribute('data-ia-askgame').split('|'); UI.ask(GAME_Q, { game: { sport: FEED_SPORT[a[0]] || a[0], game_id: a[1], label: a.slice(2).join('|') }, hint: 'GAME_RESEARCH' }); return; }
      if (t.hasAttribute('data-ia-askgame-q')) { var b = t.getAttribute('data-ia-askgame-q').split('|'); UI.ask(b[3], { game: { sport: FEED_SPORT[b[0]] || b[0], game_id: b[1], label: b[2] } }); return; }
      if (t.hasAttribute('data-ig-close')) { UI.closeGame(); return; }
      if (t.hasAttribute('data-ia-cancel')) { if (root.EDAI && root.EDAI.cancelIntel) root.EDAI.cancelIntel(); return; }
      if (t.hasAttribute('data-ia-clear-game')) { UI.setCurrentGame(null); return; }
      if (t.hasAttribute('data-ia-retry')) { if (root.EDAI && root.EDAI.retryIntel) root.EDAI.retryIntel(); return; }
    });
    doc.addEventListener('keydown', function (e) { if (e.key === 'Escape') { var el = $('igSheet'); if (el && !el.hidden) UI.closeGame(); } });
  }

  /** Take the reader to the Research screen's Ask card and put the cursor in it. */
  UI.goResearch = function () {
    try { if (typeof root.show === 'function') root.show('research'); else root.location.hash = '#research'; } catch (_) { /* stay */ }
    try { var ta = $('iaQ'); if (ta) { ta.scrollIntoView({ block: 'center' }); ta.focus({ preventScroll: true }); } } catch (_) { /* no input yet */ }
  };
  UI.VERSION = VERSION;
  root.EDINTELUI = UI;
})(typeof window !== 'undefined' ? window : globalThis);
/* mount the Ask card as soon as the Research screen exists (static host in app.html) */
(function () {
  if (typeof document === 'undefined') return;
  function mount() {
    try { var h = document.getElementById('iaAskHost'); if (h && window.EDINTELUI) window.EDINTELUI.mountAsk(h); } catch (_) { /* no host on this page */ }
    try { if (window.EDINTELUI) { window.EDINTELUI.paintCard(); window.EDINTELUI.paintMethod(); } } catch (_) { /* no Card or Process host */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
