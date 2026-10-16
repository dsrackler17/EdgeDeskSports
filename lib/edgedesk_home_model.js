/* ===========================================================================
   EdgeDesk landing page — A MODEL YOU CAN FOLLOW, SHOWN ON REAL GAMES.

   The landing page's #model section: up to three of this week's real games
   exactly as a subscriber's research page shows them, read from
   football/game_research/landing.json (written by the hourly research build,
   tools/football/build_game_research.js landingFor):

     the graphic       lib/edgedesk_game_graphic.js render(), the same
                       deterministic Canvas drawing the research page
                       downloads, from lib/edgedesk_game_snapshot.js
                       graphicSpec(); downloadable as a PNG
     three levels      Beginner (GS.beginner), Research (the projection, what
                       to watch for, what the model does not know yet) and
                       Lab (version, snapshot, checks, calibration status)
     your number       GS.comparePrice on the game's own probability sheet
                       (lib/edgedesk_fairline.js priceCheck): EdgeDesk's
                       probability beside the typed price's break-even, EV
                       only where the market is CALIBRATED, labelled a
                       user-entered, unverified quote, never stored

   Layer A only: no sportsbook price is read or shown here. Nothing loads
   until the section nears the screen. Without script, or when the file or a
   library cannot be read, the markup's example stays, and says it is one.

   It also reads /record/football/summary.json for one count: how many of
   EdgeDesk's pregame football numbers have been graded this season.

   The page calls init({track, funnel, wait}) once, with its own GA and
   funnel senders. The pure parts (pick, view, unknowns, compare, graded) run
   in Node for tools/presentation/landing_model.test.js.

   Browser: window.EDHomeModel. Node: require('./edgedesk_home_model.js').
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) root.EDHomeModel = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';
  var X = {}, ctx = {}, WAIT = 8000;
  var doc = root && root.document;
  X.DATA = '/football/game_research/landing.json';
  X.RECORD = '/record/football/summary.json';
  X.CSS = '/lib/edgedesk_home_model.css?v=20261016lp1';
  X.V = '20261016lp1';
  /* the research page's own libraries, in dependency order */
  X.LIBS = ['/lib/research_core.js?v=20260925p', '/lib/edgedesk_calc.js?v=20261008i', '/lib/edgedesk_fairline.js?v=20261011lm1',
    '/lib/edgedesk_game_snapshot.js?v=20261016gr1', '/lib/edgedesk_game_graphic.js?v=20261016gr1'];
  X.FONT = 'https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@0,600;0,700;0,800;1,800&display=swap';
  X.LEVELS = ['beginner', 'research', 'lab'];

  function $(id) { return doc ? doc.getElementById(id) : null; }
  function e(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  function GS() { return root.EDGameSnapshot || (typeof require === 'function' ? require('./edgedesk_game_snapshot.js') : null); }
  function FL() { return root.EDFairLine || (typeof require === 'function' ? require('./edgedesk_fairline.js') : null); }
  function signed(v) { v = num(v); if (v == null) return '—'; if (Math.abs(v) < 0.05) return 'PK'; return (v > 0 ? '+' : '−') + Math.abs(v).toFixed(1); }
  function am(v) { v = num(v); return v == null ? '—' : (v > 0 ? '+' : '−') + Math.abs(Math.round(v)); }
  function pct1(p) { p = num(p); return p == null ? '—' : (p * 100).toFixed(1) + '%'; }
  function lower(s) { return String(s || '').toLowerCase(); }
  function when(iso) {
    var t = Date.parse(iso); if (!isFinite(t)) return '';
    try { return new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
    catch (err) { return new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; }
  }

  /* ---- which games: the file's, still before kickoff ------------------ */
  X.pick = function (L, now) {
    if (!L || !L.games || !L.games.length) return [];
    return L.games.filter(function (g) {
      var s = g && g.snapshot;
      return s && s.model && s.model.available && g.sheet && Date.parse(s.kickoff) > now && (L.models || {})[s.league];
    });
  };

  /* ---- what the model does not know yet --------------------------------
     The research page's own fields, in plain words: a starting quarterback
     nobody has announced, an availability report not filed yet, a weather
     forecast the projection has not read. Only the clause before the dash of
     a flagged risk is kept (the detail lives on the research page). */
  X.unknowns = function (s) {
    var out = [];
    ['away', 'home'].forEach(function (sd) {
      var q = s.qb && s.qb[sd], t = s[sd] && (s[sd].short || s[sd].name);
      if (!q) out.push(t + ': no starting quarterback named for this game yet' + (s.league === 'nfl' ? '; the projection carries the team’s usual level.' : '.'));
      else if (q.contested) out.push(t + ': the starting quarterback is contested between sources (' + q.name + ' is carried).');
      else if (!q.confirmed && q.name) out.push(t + ': ' + q.name + ' is carried as the starter (' + q.basis + '), not confirmed.');
    });
    (s.risks || []).forEach(function (r) {
      var first = String(r.text || '').split(/\s+—\s+/)[0].replace(/[.\s]+$/, '');
      if (first && first.length <= 120 && out.indexOf(first + '.') < 0) out.push(first + '.');
    });
    if (s.league === 'nfl' && !s.weather) out.push('No game-day forecast is in this projection yet.');
    return out.slice(0, 4);
  };

  /* ---- the three levels, as words and rows ---------------------------- */
  X.view = function (g, models) {
    var G = GS(), s = g.snapshot, M = s.model, sheet = g.sheet, mk = (sheet && sheet.markets) || {};
    var b = G.beginner(s);
    var fav = M.fair && M.fair.favorite, hs = M.headline_scores || M.scores || {};
    var rows = [
      ['Projected score', s.away.name + ' ' + hs.away + ', ' + s.home.name + ' ' + hs.home],
      ['Fair spread', fav ? s[fav].name + ' ' + signed(-Math.abs(M.fair.display)) : 'Pick’em'],
      ['Fair total', num(M.total) != null ? M.total.toFixed(1) : '—'],
      ['Chance to win', s.away.short + ' ' + M.win_display.away + ' · ' + s.home.short + ' ' + M.win_display.home],
      ['Model moneyline', s.away.short + ' ' + am(M.fair_ml && M.fair_ml.away) + ' · ' + s.home.short + ' ' + am(M.fair_ml && M.fair_ml.home) + ' (an estimate, not a price)']
    ];
    if (M.range80 && M.range80.text) rows.push(['80% of games like this', 'the margin lands between ' + M.range80.text]);
    var watch = (s.insights || []).slice(0, 4).map(function (i) { return { title: i.title, text: i.text }; });
    var moved = (s.history || []).filter(function (h) { return num(h.fair_home_line) != null; });
    var trail = moved.length >= 2 ? 'EdgeDesk’s line this week: ' + moved.slice(-4).map(function (h) { return s.home.short + ' ' + signed(h.fair_home_line); }).join(' → ') + '.' : null;
    var st = function (k) { var x = mk[k]; return x ? lower(x.status) + (x.tier ? ', ' + lower(x.tier) + ' tier' : '') : 'not priced'; };
    var ck = s.checks || {};
    var lab = [
      ['Model', (M.version || 'EdgeDesk model') + (M.built_at ? ' · run ' + when(M.built_at) : '')],
      ['Snapshot', s.snapshot_id + (s.generated_at ? ' · ' + when(s.generated_at) : '')],
      ['Consistency checks', (num(ck.passed) != null ? ck.passed + ' passed' : '—') + (ck.failed && ck.failed.length ? ', ' + ck.failed.length + ' failed' : ', none failed')],
      [s.confidence && s.confidence.kind === 'reliability' ? 'Reliability' : 'Data check', s.confidence && s.confidence.label ? s.confidence.label : s.data.status],
      ['Spread probabilities', st('spread')],
      ['Total probabilities', st('total')],
      ['Moneyline probabilities', st('moneyline')]
    ];
    return {
      key: g.game_key, league: s.league, title: s.away.name + ' @ ' + s.home.name,
      tab: (s.away.abbr || s.away.short) + ' @ ' + (s.home.abbr || s.home.short),
      sub: [s.league === 'nfl' ? 'NFL' : 'College football', s.kickoff_text && (s.kickoff_text.text || (typeof s.kickoff_text === 'string' ? s.kickoff_text : null)), s.venue, s.context]
        .filter(function (x) { return x && typeof x === 'string'; }).join(' · '),
      why: g.chosen_because || null,
      beginner: b, rows: rows, watch: watch, unknowns: X.unknowns(s), trail: trail, lab: lab,
      home: { name: s.home.name, short: s.home.short }, away: { name: s.away.name, short: s.away.short },
      fair_home_line: M.fair && M.fair.home_line, total: M.total
    };
  };

  /* ---- the public record: pregame football numbers graded this season --- */
  X.graded = function (R) {
    var sp = R && R.sports, n = 0, any = false;
    if (!sp) return null;
    Object.keys(sp).forEach(function (k) { var c = sp[k] && sp[k].counts; if (c && num(c.graded) != null) { n += c.graded; any = true; } });
    return any && n > 0 ? { n: n, season: R.season || null } : null;
  };

  /* ---- your number against EdgeDesk's: the research page's price check -- */
  X.compare = function (g, models, entry) {
    var s = g.snapshot;
    return GS().comparePrice(s, g.sheet, (models || {})[s.league], entry, FL());
  };
  /* the price check's closing line is the research page's; this page's own
     footer already says research, not picks */
  X.NOTE_DROP = /^Research and decision support only\./;
  X.compareWords = function (r, v, entry) {
    if (!r.ok) return { ok: false, text: (r.errors || []).join(' · ') || 'That price could not be checked.' };
    var side = entry.market === 'total' ? (entry.side === 'over' ? 'Over ' : 'Under ') + entry.line
      : (entry.side === 'home' ? v.home.name : v.away.name) + (entry.market === 'spread' ? ' ' + signed(entry.line) : ' moneyline');
    var rows = [
      ['Your price', side + ' at ' + am(entry.american)],
      ['Break-even for that price', pct1(r.implied)],
      [r.prob_label, pct1(entry.market === 'moneyline' ? r.model_prob : r.cover_prob != null ? r.cover_prob : r.model_prob) + (r.push_prob > 0.0005 ? ' (push ' + pct1(r.push_prob) + ')' : '')],
      ['Difference', r.prob_diff == null ? '—' : (r.prob_diff >= 0 ? '+' : '−') + Math.abs(r.prob_diff * 100).toFixed(1) + ' pts'],
      ['EdgeDesk’s fair odds', am(r.fair_american)]
    ];
    if (r.ev_validated && r.ev != null) rows.push(['Expected value (calibrated market)', (r.ev >= 0 ? '+' : '−') + Math.abs(r.ev * 100).toFixed(1) + '%']);
    return { ok: true, rows: rows, status: r.status, withheld: r.ev_withheld, notes: (r.notes || []).filter(function (n) { return !X.NOTE_DROP.test(n); }), label: r.label };
  };

  /* ======================================================================
     THE BROWSER
     ====================================================================== */
  var S = { L: null, games: [], cur: 0, level: 'beginner', views: {}, used: {} };
  function track(n, p) { try { if (ctx.track) ctx.track(n, p || {}); } catch (err) {} }
  function funnel(n, p) { try { if (ctx.funnel) ctx.funnel(n, p || {}); } catch (err) {} }
  function script(src) {
    return new Promise(function (res, rej) {
      var el = doc.createElement('script'); el.src = src; el.async = false;
      el.onload = function () { res(); }; el.onerror = function () { rej(new Error('could not load ' + src)); };
      doc.head.appendChild(el);
    });
  }
  function libs() {
    if (root.EDGameSnapshot && root.EDGameGraphic && root.EDFairLine) return Promise.resolve();
    if (!doc.querySelector('link[data-ed-font="graphic"]')) {
      var l = doc.createElement('link'); l.rel = 'stylesheet'; l.href = X.FONT; l.setAttribute('data-ed-font', 'graphic'); doc.head.appendChild(l);
    }
    return X.LIBS.reduce(function (p, src) { return p.then(function () { return script(src); }); }, Promise.resolve());
  }
  /* resolves null on a failed, late or unreadable read (the page's own deadline) */
  function getJson(url) {
    var p = root.fetch(url, { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
    return ctx.wait ? ctx.wait(p, WAIT) : p;
  }
  function fail(why) {
    var body = $('mdBody'), foot = $('mdFoot');
    if (body) { body.classList.remove('loading'); body.classList.add('ill'); }
    if (foot) foot.innerHTML = '<b>The live games couldn’t be loaded just now</b> (' + e(why) + '), so this is the example. <a class="lnk" href="/research/sample/" data-cta="model_sample">Open a full sample game</a>.';
  }
  function cur() { return S.games[S.cur]; }
  function viewOf(g) { return S.views[g.game_key] || (S.views[g.game_key] = X.view(g, S.L.models)); }

  function tabs() {
    var t = $('mdTabs'); if (!t) return;
    t.innerHTML = S.games.map(function (g, i) {
      var v = viewOf(g);
      return '<button type="button" role="tab" id="mdTab' + i + '" aria-selected="' + (i === S.cur) + '" aria-controls="mdBody" data-md-game="' + i + '" class="mdt' + (i === S.cur ? ' on' : '') + '">'
        + '<b>' + e(v.tab) + '</b><small>' + e(v.league === 'nfl' ? 'NFL' : 'CFB') + '</small></button>';
    }).join('');
  }
  function levelHtml(v) {
    var L = S.level, h = '';
    if (L === 'beginner') {
      h = '<p class="md-lead">' + e(v.beginner.lead) + '</p><ul class="md-pts">' + v.beginner.points.map(function (p) { return '<li>' + e(p) + '</li>'; }).join('') + '</ul>';
    } else if (L === 'research') {
      h = '<dl class="md-rows">' + v.rows.map(function (r) { return '<div><dt>' + e(r[0]) + '</dt><dd>' + e(r[1]) + '</dd></div>'; }).join('') + '</dl>';
      if (v.watch.length) h += '<p class="md-k">What to watch for</p><ul class="md-watch">' + v.watch.map(function (w) { return '<li><b>' + e(w.title) + '</b><span>' + e(w.text) + '</span></li>'; }).join('') + '</ul>';
      h += '<p class="md-k">What the model doesn’t know yet</p>' + (v.unknowns.length
        ? '<ul class="md-pts md-unk">' + v.unknowns.map(function (u) { return '<li>' + e(u) + '</li>'; }).join('') + '</ul>'
        : '<p class="md-p">Nothing flagged for this game. Late news after this snapshot still is not in it.</p>');
      if (v.trail) h += '<p class="md-p">' + e(v.trail) + '</p>';
    } else {
      h = '<dl class="md-rows">' + v.lab.map(function (r) { return '<div><dt>' + e(r[0]) + '</dt><dd>' + e(r[1]) + '</dd></div>'; }).join('') + '</dl>'
        + '<p class="md-p">Calibrated means probabilities like these came true about as often as stated on seasons the model never saw. No market has yet been shown to beat the closing line; the research page and <a class="lnk" href="/record.html" data-cta="model_record">the public record</a> say so on every number.</p>';
    }
    return h;
  }
  function compareHtml(v) {
    var hl = num(v.fair_home_line), half = function (x) { return Math.round(x * 2) / 2; };
    var line = hl == null ? '' : signed(half(hl)).replace('−', '-').replace('PK', '0');
    return '<form class="md-cmp" id="mdCmp" novalidate>'
      + '<p class="md-k">Compare your number</p>'
      + '<div class="md-cmp-in">'
      + '<label><span>Market</span><select id="mdMk"><option value="spread">Spread</option><option value="total">Total</option><option value="moneyline">Moneyline</option></select></label>'
      + '<label><span>Side</span><select id="mdSide"></select></label>'
      + '<label id="mdLineL"><span>Line</span><input id="mdLine" type="text" inputmode="decimal" autocomplete="off" value="' + e(line) + '"></label>'
      + '<label><span>Odds</span><input id="mdOdds" type="text" inputmode="numeric" autocomplete="off" value="-110"></label>'
      + '<button type="submit" class="btn ghost">Check</button>'
      + '</div><div id="mdCmpOut" class="md-cmp-out" aria-live="polite"><p class="md-p">Type any line and American odds a sportsbook offers you. EdgeDesk prices it with this game’s own probability sheet.</p></div>'
      + '<p class="md-s">' + e(GS().USER_PRICE_LABEL) + '. Nothing you type is stored or sent.</p></form>';
  }
  function sideOptions() {
    var v = viewOf(cur()), mk = ($('mdMk') || {}).value || 'spread', sel = $('mdSide'); if (!sel) return;
    var opts = mk === 'total' ? [['over', 'Over'], ['under', 'Under']] : [['home', v.home.short], ['away', v.away.short]];
    sel.innerHTML = opts.map(function (o) { return '<option value="' + o[0] + '">' + e(o[1]) + '</option>'; }).join('');
    var L = $('mdLine'), LL = $('mdLineL');
    if (LL) LL.hidden = mk === 'moneyline';
    if (L) {
      var half = function (x) { return Math.round(x * 2) / 2; };
      if (mk === 'total' && num(v.total) != null) L.value = String(half(v.total));
      else if (mk === 'spread' && num(v.fair_home_line) != null) L.value = String(half(v.fair_home_line));
    }
    var O = $('mdOdds'); if (O && mk === 'moneyline' && O.value === '-110') O.value = '+150';
    if (O && mk !== 'moneyline' && O.value === '+150') O.value = '-110';
  }
  function runCompare(ev) {
    if (ev) ev.preventDefault();
    var g = cur(), v = viewOf(g), out = $('mdCmpOut'); if (!out) return;
    var mk = $('mdMk').value, side = $('mdSide').value;
    var lineRaw = String($('mdLine').value).replace('−', '-').replace(/^\+/, ''), oddsRaw = String($('mdOdds').value).replace('−', '-').replace(/^\+/, '');
    var entry = { market: mk, side: side, line: mk === 'moneyline' ? null : (lineRaw === '' ? null : Number(lineRaw)), american: oddsRaw === '' ? null : Number(oddsRaw) };
    var r = X.compare(g, S.L.models, entry), w = X.compareWords(r, v, entry);
    if (!w.ok) { out.innerHTML = '<p class="md-err" role="alert">' + e(w.text) + '</p>'; return; }
    out.innerHTML = '<dl class="md-rows">' + w.rows.map(function (x) { return '<div><dt>' + e(x[0]) + '</dt><dd>' + e(x[1]) + '</dd></div>'; }).join('') + '</dl>'
      + (w.withheld ? '<p class="md-s">' + e(w.withheld) + '</p>' : '')
      + '<p class="md-s">' + e(w.notes.join(' ')) + '</p>';
    track('model_demo_compare', { market: mk, league: v.league });
    if (!S.used.compare) { S.used.compare = 1; funnel('tool_used', { entity: 'compare_home' }); }
  }
  function graphic(g) {
    var fig = $('mdFig'); if (!fig) return;
    var spec = GS().graphicSpec(g.snapshot);
    root.EDGameGraphic.render(spec, null, 'square').then(function (r) {
      if (cur() !== g) return;
      fig.innerHTML = '<img src="' + e(r.url) + '" width="1080" height="1080" alt="' + e(r.alt) + '">'
        + '<figcaption><a class="btn ghost" id="mdDl" href="' + e(r.url) + '" download="' + e(r.file_name) + '" data-cta="model_graphic_download">Download this graphic</a>'
        + '<span>The matchup graphic every game gets, drawn from EdgeDesk’s numbers. Download it, share it.</span></figcaption>';
    }).catch(function (err) {
      if (cur() !== g) return;
      fig.innerHTML = '<p class="md-p">The graphic couldn’t be drawn here (' + e(err && (err.message || err.reason) || err) + '). The research page draws it for every game.</p>';
    });
  }
  function paint() {
    var g = cur(), v = viewOf(g), body = $('mdBody'); if (!body) return;
    body.classList.remove('loading', 'ill');
    tabs();
    body.innerHTML = '<div class="md-grid">'
      + '<figure class="md-fig" id="mdFig"><div class="md-ph" aria-hidden="true"></div></figure>'
      + '<div class="md-side">'
      + '<div class="md-gh"><b>' + e(v.title) + '</b><span>' + e(v.sub) + '</span>' + (v.why ? '<small>Real game · ' + e(v.why) + '</small>' : '<small>Real game</small>') + '</div>'
      + '<div class="md-lv" role="tablist" aria-label="How deep to go">' + X.LEVELS.map(function (l) {
          return '<button type="button" role="tab" aria-selected="' + (l === S.level) + '" data-md-level="' + l + '" class="' + (l === S.level ? 'on' : '') + '">' + (l === 'beginner' ? 'Beginner' : l === 'research' ? 'Research' : 'Lab') + '</button>';
        }).join('') + '</div>'
      + '<div class="md-level" id="mdLevel">' + levelHtml(v) + '</div>'
      + compareHtml(v)
      + '</div></div>';
    sideOptions();
    graphic(g);
    var foot = $('mdFoot');
    if (foot) foot.innerHTML = 'EdgeDesk’s own numbers for real games, as of ' + e(when(S.L.generated_at)) + ', drawn by the same code as the research terminal. No sportsbook price is read or shown here. Research, not picks.';
  }
  function bind() {
    var sec = $('model'); if (!sec) return;
    sec.addEventListener('click', function (ev) {
      var t = ev.target && ev.target.closest ? ev.target.closest('[data-md-game],[data-md-level]') : null;
      if (!t) return;
      if (t.hasAttribute('data-md-game')) {
        var i = +t.getAttribute('data-md-game'); if (i === S.cur || !S.games[i]) return;
        S.cur = i; paint(); track('model_demo_game', { league: viewOf(cur()).league });
      } else {
        S.level = t.getAttribute('data-md-level');
        var box = $('mdLevel'); if (box) box.innerHTML = levelHtml(viewOf(cur()));
        [].forEach.call(sec.querySelectorAll('[data-md-level]'), function (b) { var on = b.getAttribute('data-md-level') === S.level; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
        track('model_demo_level', { level: S.level });
      }
    });
    sec.addEventListener('change', function (ev) { if (ev.target && ev.target.id === 'mdMk') sideOptions(); });
    sec.addEventListener('submit', function (ev) { if (ev.target && ev.target.id === 'mdCmp') runCompare(ev); });
  }
  function count(L) {
    var c = L.counts || {}, el = $('mdCount');
    if (el && num(c.model_available) > 0) el.textContent = 'Each of the ' + c.model_available + ' NFL and FBS games EdgeDesk is projecting now';
  }
  function graded() {
    getJson(X.RECORD).then(function (R) {
      var g = X.graded(R), el = $('mdGraded');
      if (!g || !el) return;
      el.textContent = ' (' + g.n.toLocaleString('en-US') + ' games so far' + (g.season ? ' in ' + g.season : ' this season') + ')';
      el.hidden = false;
    });
  }
  X.start = function () {
    if (S.started) return; S.started = true;
    Promise.all([libs(), getJson(X.DATA)]).then(function (r) {
      var L = r[1];
      if (!L) throw new Error('the games file did not arrive');
      if (L.schema !== 'edgedesk_game_research_landing_v1') throw new Error('the games file is not one this page reads');
      S.L = L; S.games = X.pick(L, Date.now());
      if (!S.games.length) throw new Error('no game before kickoff right now');
      bind(); paint(); count(L);
      track('model_demo_view', { games: S.games.length });
    }).catch(function (err) { fail(err && err.message || String(err)); });
    graded();
  };
  X.init = function (c) {
    ctx = c || {};
    var sec = $('model'); if (!sec || !doc) return;
    /* the demo's styles arrive while the reader is still above it */
    if (!doc.querySelector('link[data-ed-css="model"]')) {
      var l = doc.createElement('link'); l.rel = 'stylesheet'; l.href = X.CSS; l.setAttribute('data-ed-css', 'model'); doc.head.appendChild(l);
    }
    if ('IntersectionObserver' in root) {
      var io = new root.IntersectionObserver(function (es) { for (var i = 0; i < es.length; i++) if (es[i].isIntersecting) { io.disconnect(); X.start(); return; } }, { rootMargin: '700px 0px' });
      io.observe(sec);
    } else X.start();
  };
  return X;
});
