/* ===========================================================================
   MARKET FORESIGHT — the page shell (/foresight/). The renderers are
   lib/edgedesk_foresight_ui.js (pure, tested in Node); the numbers come only
   through the anonymous doors of supabase/market_foresight.sql:
     mf_status()            mode, methodology, last run, coverage (no forecast)
     mf_overview(filters)   summaries, venue timing, the T3 check
     mf_games_list(...)     games, keyset paged
     mf_game(sport, event)  one game (the full timeline only with Full Access)
     mf_model(...)          one model's complete record, keyset paged
   A signed-in reader's own session token is sent when it is present and
   current, so the database can decide Full Access; nothing here grants it.

   Routes (query string, shareable): /foresight/            the overview
                                     ?game=<sport>:<event>  a game
                                     ?model=<source>:<key>  a model's record
   =========================================================================== */
(function () {
  'use strict';
  var SB_URL = 'https://iattxbkbufslbauoumga.supabase.co';
  var SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhdHR4YmtidWZzbGJhdW91bWdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2MzY4MDUsImV4cCI6MjA5NzIxMjgwNX0.Mly5G587o5IFRnEigU2wRp9buWEk3dFwH9RNPJK7Uo8';
  var U = window.EDForesightUI;
  var $ = function (id) { return document.getElementById(id); };
  var esc = U.esc;
  var REASONS = null, STATUS = null, METHOD = null;

  /* ---------------------------------------------------------------- data */
  function token() {
    try {
      var s = JSON.parse(localStorage.getItem('edgedesk_session') || 'null');
      if (s && s.access_token && (!s.expires_at || s.expires_at * 1000 > Date.now() + 30000)) return s.access_token;
    } catch (_) { /* no session */ }
    return null;
  }
  function timeout(p, ms) { return Promise.race([p, new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, ms); })]); }
  function call(name, args, bearer) {
    return timeout(fetch(SB_URL + '/rest/v1/rpc/' + name, { method: 'POST', headers: { apikey: SB_KEY, authorization: 'Bearer ' + bearer, 'content-type': 'application/json' }, body: JSON.stringify(args || {}) })
      .then(function (r) { return r.text().then(function (t) { if (!r.ok) { var e = new Error('db ' + r.status); e.status = r.status; e.body = t; throw e; } return t ? JSON.parse(t) : null; }); }), 15000);
  }
  /* the reader's token when it is current; a rejected token falls back to anonymous */
  function rpc(name, args) {
    var t = token();
    if (!t) return call(name, args, SB_KEY);
    return call(name, args, t).catch(function (e) { if (e && e.status === 401) return call(name, args, SB_KEY); throw e; });
  }
  function notDeployed(e) { return e && (e.status === 404 || /PGRST202|Could not find the function|does not exist/i.test(String(e.body || ''))); }
  function state(html, kind) { var el = $('mf-status'); el.innerHTML = html; el.className = 'mf-status' + (kind ? ' ' + kind : ''); }
  function errText(e) { return e && e.message === 'timeout' ? 'the database did not answer in time' : 'the database answered ' + (e && e.status || 'an error'); }
  function sec(id, title, body, note) { return '<section class="mf-sec" aria-labelledby="' + id + '"><h2 id="' + id + '">' + esc(title) + '</h2>' + (note ? '<p class="note">' + note + '</p>' : '') + body + '</section>'; }

  /* ---------------------------------------------------------------- the methodology panel */
  function renderMethod(M) {
    if (!M) return;
    var mv = M.movement, fr = M.freshness, st = M.statistics, ll = M.lead_lag;
    var defs = Object.keys(mv.definitions).map(function (k) { return '<div><dt>' + esc(k.replace(/_/g, ' ')) + '</dt><dd>' + esc(mv.definitions[k]) + '</dd></div>'; }).join('');
    var ex = Object.keys(M.selection.exclusion_reasons).map(function (k) { return '<li><code>' + esc(k) + '</code> — ' + esc(M.selection.exclusion_reasons[k]) + '</li>'; }).join('');
    var digest = STATUS && STATUS.methodology ? '<p class="note">The database holds this version with sha256 <code>' + esc(STATUS.methodology.sha256) + '</code>, frozen ' + esc(STATUS.methodology.frozen_at || M.frozen_at) + '.</p>' : '';
    $('mf-method').innerHTML = '<p>' + esc(M.question) + ' Version <b>' + esc(M.version) + '</b>, frozen ' + esc(M.frozen_at) + ' before any measurement was computed. A changed rule is a new version, and earlier versions keep their results. Read the whole file: <a href="/research/foresight/methodology/mf-v1.json">mf-v1.json</a> (<a href="/research/foresight/methodology/FROZEN.json">digests</a>).</p>' + digest
      + '<h3>The unit</h3><p>' + esc(M.selection.unit) + '. ' + esc(M.selection.revisions) + '. ' + esc(M.selection.eligibility_is_forecast_side_only) + '.</p>'
      + '<h3>Definitions</h3><dl class="mf-defs">' + defs + '</dl>'
      + '<h3>Thresholds</h3><ul class="mf-list"><li>A qualifying move: ' + esc(mv.threshold.spread) + ' pts on spreads, ' + esc(mv.threshold.total) + ' pts on totals, ' + esc(mv.threshold.moneyline * 100) + ' probability points on win probability. ' + esc(mv.persistence) + '.</li>'
      + '<li>Disagreement below ' + esc(mv.min_disagreement.spread) + ' pts / ' + esc(mv.min_disagreement.moneyline * 100) + ' pp is “agreed at publication”: counted, never dropped.</li>'
      + '<li>Fixed horizons after publication: ' + esc(mv.horizons_minutes.map(function (m) { return U.dur(m); }).join(', ')) + '.</li>'
      + '<li>Baseline M0: ' + esc(fr.baseline) + '.</li><li>Close C: ' + esc(fr.close.definition) + ' — DraftKings within ' + esc(fr.close.draftkings_max_minutes_before_kickoff) + ' minutes of kickoff, Kalshi within ' + esc(fr.close.kalshi_max_minutes_before_kickoff) + '; ' + esc(fr.close.otherwise) + '.</li>'
      + '<li>Timing: ' + esc(M.timing.change_interval) + '. ' + esc(M.timing.ordering) + '. ' + esc(M.timing.missing) + '.</li></ul>'
      + '<h3>Prices</h3><ul class="mf-list"><li>' + esc(M.prices.sportsbook_devig.method) + '; ' + esc(M.prices.sportsbook_devig.otherwise) + '.</li><li>Kalshi: ' + esc(M.prices.kalshi.metric_quote) + ', ' + esc(M.prices.kalshi.mid_requires) + '. ' + esc(M.prices.kalshi.last_trade) + '. ' + esc(M.prices.kalshi.fees) + '.</li>'
      + '<li>Settlement: ' + esc(M.contracts.settlement.rule) + '. Kalshi: ' + esc(M.contracts.settlement.profiles.kalshi_game_winner.verification) + '.</li></ul>'
      + '<h3>Venue lead–lag</h3><p>' + esc(ll.move) + ' ' + esc(ll.pairing) + '. ' + esc(ll.ordering) + '. A label needs ' + esc(ll.label.min_resolved_pairs) + ' resolved pairs and ' + esc(ll.label.rule.replace(/^a venue is labelled .* only when /, '')) + '. ' + esc(ll.context) + '.</p>'
      + '<h3>Collective consensus</h3><p>' + esc(M.consensus.members) + '. Evaluated ' + esc(M.consensus.evaluation_offsets_minutes_before_kickoff.map(function (m) { return U.dur(m); }).join(', ')) + ' before kickoff with at least ' + esc(M.consensus.min_contributors) + ' contributors; ' + esc(M.consensus.center) + '. ' + esc(M.consensus.independence) + '.</p>'
      + '<h3>Uncertainty</h3><p>' + esc(st.proportions) + '; ' + esc(st.means_and_medians) + '. No interval below n = ' + esc(st.min_n_for_interval) + '; below n = ' + esc(st.min_n_for_summary) + ' a summary reads “insufficient evidence”. ' + esc(st.no_composite_score) + '.</p>'
      + '<h3>Why a unit is not measured</h3><ul class="mf-list mf-small">' + ex + '</ul>'
      + '<p class="note">' + esc(M.isolation) + '</p>';
  }

  /* ---------------------------------------------------------------- the overview */
  var FILTERS = { sport: '', market: '', venue: '', source: '', model_key: '', window: 'all', bucket: 'all' };
  var GAMES = { from: '', to: '', next: null, items: [] };
  function filterRow(models) {
    var opt = function (v, t, cur) { return '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(t) + '</option>'; };
    return '<div class="filters mf-filters" role="group" aria-label="Filters for every table below">'
      + '<div><label class="fl" for="f-window">Games played</label><select id="f-window">' + opt('all', 'Whole record', FILTERS.window) + opt('30d', 'Last 30 days', FILTERS.window) + opt('7d', 'Last 7 days', FILTERS.window) + '</select></div>'
      + '<div><label class="fl" for="f-sport">Sport</label><select id="f-sport">' + opt('', 'All sports', FILTERS.sport) + opt('nfl', 'NFL', FILTERS.sport) + opt('cfb', 'College football', FILTERS.sport) + '</select></div>'
      + '<div><label class="fl" for="f-market">Market</label><select id="f-market">' + opt('', 'All markets', FILTERS.market) + opt('spread', 'Spread', FILTERS.market) + opt('total', 'Total', FILTERS.market) + opt('moneyline', 'Win probability', FILTERS.market) + '</select></div>'
      + '<div><label class="fl" for="f-venue">Venue</label><select id="f-venue">' + opt('', 'Both venues', FILTERS.venue) + opt('draftkings', 'DraftKings', FILTERS.venue) + opt('kalshi', 'Kalshi', FILTERS.venue) + '</select></div>'
      + '<div><label class="fl" for="f-source">Source</label><select id="f-source">' + opt('', 'All sources', FILTERS.source) + opt('edgedesk', 'EdgeDesk models', FILTERS.source) + opt('collective', 'Model Collective', FILTERS.source) + opt('collective_consensus', 'Collective consensus', FILTERS.source) + '</select></div>'
      + '<div><label class="fl" for="f-model">Model</label><select id="f-model">' + opt('', 'All models', FILTERS.model_key) + models.map(function (m) { return opt(m.key, m.label, FILTERS.model_key); }).join('') + '</select></div>'
      + '<div><label class="fl" for="f-bucket">Published before kickoff</label><select id="f-bucket">' + opt('all', 'Any time', FILTERS.bucket) + opt('<6h', 'Under 6 h', FILTERS.bucket) + opt('6-24h', '6–24 h', FILTERS.bucket) + opt('24-72h', '24–72 h', FILTERS.bucket) + opt('>72h', 'Over 72 h', FILTERS.bucket) + '</select></div>'
      + '</div>';
  }
  var MODELS = null;
  function overview() {
    var view = $('mf-view');
    view.classList.add('mf-busy');
    var f = {};
    Object.keys(FILTERS).forEach(function (k) { if (FILTERS[k]) f[k] = FILTERS[k]; });
    return rpc('mf_overview', { p_filters: f }).then(function (ov) {
      if (ov.locked) return locked();
      if (!MODELS) {
        var seen = {}; MODELS = [];
        ov.summaries.forEach(function (s) { if (!seen[s.model_key]) { seen[s.model_key] = 1; MODELS.push({ key: s.model_key, label: s.model_label }); } });
        MODELS.sort(function (a, b) { return a.label < b.label ? -1 : 1; });
      }
      var models = ov.summaries.filter(function (s) { return s.source !== 'collective_consensus' && s.measured > 0; });
      var idle = ov.summaries.filter(function (s) { return s.source !== 'collective_consensus' && !s.measured; });
      var cons = ov.summaries.filter(function (s) { return s.source === 'collective_consensus' && s.measured > 0 && s.model_version === 'equal_weight_mean'; });
      var consMed = ov.summaries.filter(function (s) { return s.source === 'collective_consensus' && s.measured > 0 && s.model_version === 'median'; });
      var cnt = ov.counts || {};
      view.innerHTML = sec('h-cov', 'Coverage and freshness', U.coverageHTML(ov.coverage), 'What was actually observed, how often, and how recently. Every figure is the collector’s real cadence, not its intended schedule.')
        + filterRow(MODELS)
        + '<p class="mf-counts" aria-live="polite">' + esc((cnt.games || 0) + ' finished games · ' + (cnt.units || 0) + ' forecast–venue units · ' + (cnt.measured || 0) + ' measured · ' + (cnt.pending_games || 0) + ' games not yet played') + '</p>'
        + sec('h-models', 'Model observations', U.summaryTableHTML(models, { caption: 'Model observations' }) + U.unmeasuredHTML(idle, REASONS),
          'One row per model version, sport, market and venue, never pooled across them. “Closes closer” counts forecasts that disagreed with the market at publication and whose close ended nearer the forecast (Wilson 95% interval from n = 10). Convergence and directional movement are in points or probability points, with event-resampled 95% intervals. Misses are counted, not dropped. There is no combined score.')
        + sec('h-cons', 'Collective consensus against the close', U.summaryTableHTML(cons, { caption: 'Collective consensus (equal-weight mean)', empty: 'No consensus has been measured. It needs at least three Collective models to have published by the evaluation time, and the Collective must be connected to this record.' })
          + (consMed.length ? '<details class="mf-det"><summary>The same, with the median of the contributing models</summary>' + U.summaryTableHTML(consMed, { caption: 'Collective consensus (median)' }) + '</details>' : ''),
          'An equal-weight mean of the Collective models that had published by each evaluation time, one vote per model, with the median beside it. It is measured by the same rules as any model. Contributing models are not assumed to be independent.')
        + sec('h-ll', 'Venue lead–lag', U.leadLagHTML(ov.lead_lag), 'Which tracked venue’s comparable price change was observed first, when the two change intervals do not overlap.')
        + sec('h-inc', 'Does disagreement carry information beyond the market? (T3, research)', U.incrementalHTML(ov.incremental),
          'A chronological holdout check: does F − M0 predict later movement beyond the market at publication and its recent movement? Nothing is fitted on the holdout. This is experimental research, never a claim.')
        + sec('h-games', 'Games', '<div class="filters mf-filters mf-gf"><div><label class="fl" for="g-from">From (date)</label><input type="text" id="g-from" placeholder="YYYY-MM-DD" inputmode="numeric" value="' + esc(GAMES.from) + '"></div><div><label class="fl" for="g-to">To (date)</label><input type="text" id="g-to" placeholder="YYYY-MM-DD" inputmode="numeric" value="' + esc(GAMES.to) + '"></div></div><div id="mf-games"></div><button type="button" class="btn ghost" id="mf-more" hidden>Load more games</button>',
          'Open a game to see what each source showed, and when.');
      view.classList.remove('mf-busy');
      ['window', 'sport', 'market', 'venue', 'source', 'model', 'bucket'].forEach(function (k) {
        $('f-' + k).addEventListener('change', function (e) { FILTERS[k === 'model' ? 'model_key' : k] = e.target.value; overview(); });
      });
      ['from', 'to'].forEach(function (k) {
        $('g-' + k).addEventListener('change', function (e) { var v = e.target.value.trim(); if (v && !/^\d{4}-\d\d-\d\d$/.test(v)) { e.target.setAttribute('aria-invalid', 'true'); return; } e.target.removeAttribute('aria-invalid'); GAMES[k] = v; games(true); });
      });
      $('mf-more').addEventListener('click', function () { games(false); });
      return games(true);
    }).catch(function (e) { view.classList.remove('mf-busy'); state('Could not load the measurements: ' + esc(errText(e)) + '. <button type="button" class="btn ghost" id="mf-retry">Try again</button>', 'warn'); var b = $('mf-retry'); if (b) b.onclick = boot; });
  }
  function games(reset) {
    if (reset) { GAMES.next = null; GAMES.items = []; }
    var f = {};
    if (FILTERS.sport) f.sport = FILTERS.sport;
    if (FILTERS.model_key) f.model_key = FILTERS.model_key;
    if (GAMES.from) f.from = GAMES.from + 'T00:00:00-04:00';
    if (GAMES.to) f.to = GAMES.to + 'T23:59:59-04:00';
    return rpc('mf_games_list', { p_filters: f, p_cursor: GAMES.next, p_limit: 30 }).then(function (r) {
      if (r.locked) return;
      GAMES.items = GAMES.items.concat(r.items || []);
      GAMES.next = r.next;
      $('mf-games').innerHTML = U.gamesListHTML(GAMES.items);
      $('mf-more').hidden = !r.next;
    }).catch(function (e) { $('mf-games').innerHTML = '<p class="mf-empty">Could not load games: ' + esc(errText(e)) + '.</p>'; });
  }
  function locked() {
    var st = STATUS || {};
    var why = st.mode === 'shadow' ? 'Market Foresight is <b>in review</b>: the first runs are visible to operators only while they are checked. Coverage and freshness are shown below; measurements appear here when it goes live.' : 'Market Foresight is switched off.';
    state(why, 'warn');
    $('mf-view').innerHTML = st.coverage && st.coverage.length ? sec('h-cov', 'Coverage and freshness', U.coverageHTML(st.coverage)) : '';
  }

  /* ---------------------------------------------------------------- a game */
  var PANELS = [];
  function game(sport, eventId) {
    return rpc('mf_game', { p_sport: sport, p_event_id: eventId }).then(function (r) {
      if (r.locked) return locked();
      if (!r.found) { state('This game is not in the record. Only games EdgeDesk recorded prices or forecasts for, and that have kicked off, are measured. <a href="/foresight/">Back to the overview</a>.', 'warn'); return; }
      var g = r.game, units = r.units || [];
      document.title = g.away + ' at ' + g.home + ' — Market Foresight | EdgeDesk';
      $('mf-title').textContent = g.away + ' at ' + g.home;
      $('mf-lede').textContent = (U.SPORT[g.sport] || g.sport) + ' · kickoff ' + U.time(g.kickoff) + (g.state === 'VOID' ? ' · postponed or cancelled: nothing is measured' : '') + '. Every forecast and price EdgeDesk recorded for this game, and what the frozen rules make of them.';
      $('mf-crumbs').innerHTML = '<a href="/articles/">Research</a> › <a href="/foresight/">Market Foresight</a> › <span aria-current="page">' + esc(g.away + ' at ' + g.home) + '</span>';
      state('Computed ' + esc(U.time(r.computed_at)) + ' under ' + esc(r.methodology) + '. ' + (r.full_access ? 'Full timeline shown.' : 'Findings and coverage shown; the full timeline (every observation with raw prices) is available with <a href="/#pricing">Full Access</a>.'));
      var byMk = { spread: [], total: [], moneyline: [] };
      units.forEach(function (u) { (byMk[u.market] = byMk[u.market] || []).push(u); });
      $('mf-claims').open = false;
      var find = ['spread', 'total', 'moneyline'].filter(function (m) { return byMk[m].length; }).map(function (m) {
        var done = byMk[m].filter(function (u) { return u.status === 'measured'; }), not = byMk[m].filter(function (u) { return u.status !== 'measured'; });
        return '<h3>' + esc(U.MARKET[m]) + '</h3>' + (done.length ? '<ul class="mf-units">' + done.map(function (u) { return U.unitHTML(u, REASONS); }).join('') + '</ul>' : '<p class="mf-empty">No forecast was measured in this market.</p>')
          + (not.length ? '<details class="mf-det"><summary>' + esc(not.length) + ' not measured in this market — show each and why</summary><ul class="mf-units">' + not.map(function (u) { return U.unitHTML(u, REASONS); }).join('') + '</ul></details>' : '');
      }).join('') || '<p class="mf-empty">No forecast for this game reached a venue comparison.</p>';
      var html = sec('h-find', 'What the records show', find, 'Plain language from the frozen rules. Each forecast is measured once: its first eligible publication per model version. Revisions are drawn on the timeline and never substituted.');
      if (r.full_access) {
        PANELS = U.panelsFor(g, units);
        var tl = PANELS.map(function (p, i) {
          return '<figure class="mf-panel"><figcaption><b>' + esc(U.MARKET[p.market]) + '</b> <small>' + esc(p.axis) + '</small></figcaption>' + U.legendHTML(p)
            + '<div class="mf-plot" tabindex="0" data-panel="' + i + '" aria-label="' + esc(U.MARKET[p.market] + ' timeline. Use the left and right arrow keys to step through observations; the readout says what each source showed at that moment.') + '">' + U.timelineSVG(p) + '</div></figure>';
        }).join('') || '<p class="mf-empty">No venue series or forecast to draw.</p>';
        html += sec('h-tl', 'Timeline', tl, 'Flat steps are observed quotes. A tinted band means the value changed somewhere inside it; a grey band is a coverage gap where nothing is known. Forecasts are drawn from their publication onward, never before. Hover or use the arrow keys for a readout of every source at that moment.');
        var nEv = PANELS.reduce(function (a, p) { return a + p.series.reduce(function (b, s) { return b + s.segments.length + (s.gaps || []).length; }, 0) + p.forecasts.reduce(function (c, f) { return c + f.marks.length; }, 0); }, 0);
        html += sec('h-ev', 'Event table', '<details class="mf-det" id="mf-evd"><summary>Every observation and forecast in time order (' + esc(nEv) + ' rows)</summary>' + U.eventTableHTML(g, PANELS) + '</details>', 'The same records as the timeline, readable without a chart.');
      } else {
        html += sec('h-tl', 'Coverage for this game', coverageList(g), 'The full timeline, with every observation and its raw prices, is available with Full Access.');
      }
      html += sec('h-ll', 'Venue timing for this game', gameLeadLag(g, r.full_access));
      html += sec('h-fc', 'Forecasts on record', forecastList(g));
      if ((g.consensus || []).length) html += sec('h-cons', 'Collective consensus, as of each evaluation time', consensusList(g));
      $('mf-view').innerHTML = html;
      attachPanels();
    }).catch(function (e) { state('Could not load this game: ' + esc(errText(e)) + '.', 'warn'); });
  }
  function coverageList(g) {
    var ks = Object.keys(g.series || {});
    if (!ks.length) return '<p class="mf-empty">No venue observations for this game.</p>';
    return '<ul class="mf-list">' + ks.map(function (k) {
      var s = g.series[k];
      return '<li><b>' + esc(U.VENUE[s.venue] + ' · ' + U.MARKET[s.market]) + '</b>: ' + esc(s.n_observations) + ' observations from ' + esc(U.time(s.first_at)) + ' to ' + esc(U.time(s.last_at))
        + ' · median ' + esc(U.dur(s.cadence && s.cadence.median_minutes)) + ' between them · ' + esc((s.gaps || []).length) + ' coverage gap(s) · close ' + esc(s.close && s.close.ok ? 'valid (' + U.dur(s.close.minutes_before_kickoff) + ' before kickoff)' : 'not valid' + (s.close && s.close.reason ? ' (' + String(s.close.reason).replace(/_/g, ' ') + ')' : '')) + '</li>';
    }).join('') + '</ul>';
  }
  function gameLeadLag(g, full) {
    var L = g.lead_lag || {};
    if (L.status === 'NOT_BOTH_VENUES') return '<p class="mf-empty">Not measured: ' + esc(L.reason) + '.</p>';
    if (L.status === 'BLOCKED') return '<p class="mf-state warn">Not measured: ' + esc(String(L.reason || '').replace(/_/g, ' ')) + '. ' + esc(L.detail || '') + '</p>';
    if (L.locked) return '<p class="note">' + esc(L.n_pairs) + ' paired move(s); the pairs are listed with Full Access.</p>';
    if (!L.pairs) return '<p class="mf-empty">Not measured.</p>';
    var rows = L.pairs.map(function (p) {
      return '<tr><th scope="row">' + esc(p.dir > 0 ? 'toward the home team' : 'toward the away team') + '</th><td>' + esc(U.time(p.a.lo) + ' – ' + U.time(p.a.hi)) + '</td><td>' + esc(U.time(p.b.lo) + ' – ' + U.time(p.b.hi)) + '</td><td>'
        + esc(p.order === 'LEADER' ? 'First observed: ' + U.VENUE_SHORT[p.leader] + ' (' + U.dur(p.lead_minutes[0]) + ' to ' + U.dur(p.lead_minutes[1]) + ' earlier)' : (p.order === 'TIE' ? 'Tie' : 'Unresolved at available sampling resolution')) + '</td></tr>';
    }).join('');
    var um = (L.unmatched || []).map(function (m) { return esc(U.VENUE_SHORT[m.venue] + ' ' + (m.dir > 0 ? 'up' : 'down') + ' move ' + U.time(m.lo) + ' – ' + U.time(m.hi) + ': ' + (m.status === 'UNMATCHED' ? 'no same-direction move by the other venue within 3 h' : 'the other venue had a coverage gap')); }).join('<br>');
    return (rows ? '<div class="mf-tw"><table class="tbl mf-tbl"><caption class="mf-vh">Paired venue moves</caption><thead><tr><th scope="col">Move</th><th scope="col">DraftKings interval</th><th scope="col">Kalshi interval</th><th scope="col">Ordering</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '<p class="mf-empty">No paired moves.</p>')
      + (um ? '<p class="note">' + um + '</p>' : '') + '<p class="note">Observed temporal precedence between two tracked venues only.</p>';
  }
  function forecastList(g) {
    var fs = g.forecasts || [];
    if (!fs.length) return '<p class="mf-empty">No forecast on record for this game.</p>';
    return '<div class="mf-tw"><table class="tbl mf-tbl"><caption class="mf-vh">Forecasts on record</caption><thead><tr><th scope="col">Published</th><th scope="col">Model</th><th scope="col">Spread</th><th scope="col">Total</th><th scope="col">Home win</th><th scope="col">Timing evidence</th></tr></thead><tbody>'
      + fs.map(function (f) {
        var iss = Object.keys(f.issues || {}).filter(function (k) { return f.issues[k]; });
        return '<tr><th scope="row">' + esc(U.time(f.published_at)) + '</th><td>' + esc(f.model_label) + ' <small>' + esc(f.model_version) + '</small></td><td>' + esc(U.line(f.values.spread)) + '</td><td>' + esc(U.pts(f.values.total)) + '</td><td>' + esc(U.pct(f.values.moneyline)) + '</td>'
          + '<td><small>' + esc(String(f.evidence).replace(/_/g, ' ')) + (iss.length ? ' · not eligible: ' + esc(iss.map(function (k) { return U.MARKET[k] + ' (' + U.reason(f.issues[k], REASONS) + ')'; }).join('; ')) : '') + '</small></td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  function consensusList(g) {
    return '<ul class="mf-list">' + g.consensus.map(function (c) {
      return '<li><b>' + esc(U.dur(c.offset_minutes)) + ' before kickoff</b> (' + esc(U.time(c.tau)) + '): ' + ['spread', 'total', 'moneyline'].map(function (mk) {
        var x = c.markets[mk];
        if (!x) return '';
        return esc(U.MARKET[mk]) + ' ' + (x.status === 'OK' ? esc(U.value(mk, x.mean) + ' mean, ' + U.value(mk, x.median) + ' median, ' + x.n + ' models, spread of views ±' + (mk === 'moneyline' ? U.pct(x.sd) : U.pts(x.sd)) + (x.shared_families && x.shared_families.length ? ', shared families recorded' : '')) : esc(x.n + ' model(s): too few for a consensus'));
      }).filter(Boolean).join(' · ') + '</li>';
    }).join('') + '</ul>';
  }

  /* the readout: every source at the pointer's instant (or the keyboard's) */
  function attachPanels() {
    var tip = $('mf-tip');
    Array.prototype.forEach.call(document.querySelectorAll('.mf-plot'), function (el) {
      var panel = PANELS[+el.getAttribute('data-panel')], G = U.geometry(panel), svg = el.querySelector('svg'), cross = svg.querySelector('.mf-cross');
      var times = [];
      panel.series.forEach(function (s) { s.segments.forEach(function (g) { times.push(Date.parse(g.first_at), Date.parse(g.last_at)); }); });
      panel.forecasts.forEach(function (f) { f.marks.forEach(function (m) { times.push(Date.parse(m.at)); }); });
      times = times.filter(function (t) { return t >= G.d.t0 && t <= G.d.t1; }).sort(function (a, b) { return a - b; }).filter(function (t, i, a) { return !i || t !== a[i - 1]; });
      var idx = -1;
      function show(t, cx, cy) {
        var lines = U.stateLines(panel, U.stateAt(panel, t));
        tip.textContent = '';
        lines.forEach(function (l, i) { var d = document.createElement(i === 0 ? 'b' : 'div'); d.textContent = l; tip.appendChild(d); });
        tip.hidden = false;
        var px = G.x(t);
        cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
        var r = svg.getBoundingClientRect();
        var left = cx === undefined ? r.left + px / G.W * r.width : cx, top = cy === undefined ? r.top + 20 : cy;
        var w = Math.min(340, window.innerWidth - 24);
        tip.style.left = Math.max(12, Math.min(left + 14, window.innerWidth - w - 12)) + 'px';
        tip.style.top = Math.max(12, Math.min(top + 14, window.innerHeight - tip.offsetHeight - 12)) + 'px';
      }
      function hide() { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); }
      svg.addEventListener('pointermove', function (e) {
        var r = svg.getBoundingClientRect(), px = (e.clientX - r.left) / r.width * G.W;
        if (px < G.L || px > G.W - G.R) { hide(); return; }
        show(G.t(px), e.clientX, e.clientY);
      });
      svg.addEventListener('pointerleave', hide);
      el.addEventListener('blur', hide);
      el.addEventListener('keydown', function (e) {
        if (!times.length) return;
        if (e.key === 'ArrowRight') idx = Math.min(times.length - 1, idx + 1);
        else if (e.key === 'ArrowLeft') idx = Math.max(0, idx < 0 ? 0 : idx - 1);
        else if (e.key === 'Home') idx = 0;
        else if (e.key === 'End') idx = times.length - 1;
        else if (e.key === 'Escape') { hide(); return; }
        else return;
        e.preventDefault();
        show(times[idx]);
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('.mf-show'), function (b) {
      b.addEventListener('click', function () {
        var li = b.closest('.mf-unit'), mk = li.getAttribute('data-market');
        var i = -1;
        PANELS.forEach(function (p, j) { if (p.market === mk) i = j; });
        var el = document.querySelector('.mf-plot[data-panel="' + i + '"]');
        if (!el) return;
        var G = U.geometry(PANELS[i]), hl = el.querySelector('.mf-hl');
        var a = Math.max(G.L, G.x(li.getAttribute('data-lo'))), z = Math.min(G.W - G.R, Math.max(G.x(li.getAttribute('data-hi')), a + 2));
        hl.innerHTML = '<rect class="mf-hlr" x="' + a + '" y="' + G.T + '" width="' + (z - a) + '" height="' + G.ph + '"></rect>';
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.focus({ preventScroll: true });
      });
    });
  }

  /* ---------------------------------------------------------------- a model */
  var MODEL = { next: null, units: [] };
  function model(source, key, version) {
    var f = { source: source, model_key: key };
    if (version) f.model_version = version;
    return rpc('mf_model', { p_filters: f, p_cursor: MODEL.next, p_limit: 100 }).then(function (r) {
      if (r.locked) return locked();
      if (!r.found) { state('This model has no published record here. It may not be listed for publication. <a href="/foresight/">Back to the overview</a>.', 'warn'); return; }
      if (!MODEL.units.length) {
        $('mf-claims').open = false;
        document.title = r.model_label + ' — Market Foresight | EdgeDesk';
        $('mf-title').textContent = r.model_label;
        $('mf-lede').textContent = (U.SOURCE[r.source] || r.source) + ' · versions ' + (r.versions || []).join(', ') + ' · ' + r.counts.units + ' forecast–venue units, ' + r.counts.measured + ' measured, ' + r.counts.excluded + ' not measured (each with its reason). Every eligible forecast is here, misses and no-move cases included.';
        $('mf-crumbs').innerHTML = '<a href="/articles/">Research</a> › <a href="/foresight/">Market Foresight</a> › <span aria-current="page">' + esc(r.model_label) + '</span>';
        state('Methodology ' + esc(r.methodology) + '. Separate measurements, never a combined grade. This page does not rank, promote or grade the model.');
        var all = (r.summaries || []).filter(function (s) { return s.horizon_bucket === 'all'; }), buckets = (r.summaries || []).filter(function (s) { return s.horizon_bucket !== 'all'; });
        $('mf-view').innerHTML = sec('h-m', 'Measurements', U.summaryTableHTML(all, { noModel: true, caption: 'Measurements by sport, market and venue' }))
          + (buckets.length ? '<details class="mf-det"><summary>By how long before kickoff the forecast was published</summary>' + U.summaryTableHTML(buckets, { noModel: true, caption: 'By forecast horizon' }) + '</details>' : '')
          + sec('h-rec', 'Complete record', '<div id="mf-rec"></div><button type="button" class="btn ghost" id="mf-more" hidden>Load more</button>', 'Newest first. Links open each game’s timeline.')
          + sec('h-share', 'Share and embed', '<p><label class="fl" for="mf-link">Link to this record</label><input type="text" id="mf-link" readonly value="' + esc(location.origin + location.pathname + location.search) + '"></p>'
            + '<p><label class="fl" for="mf-embed">Embed (a compact summary that links to this complete record)</label><textarea id="mf-embed" class="mf-code" readonly rows="3">' + esc(U.embedSnippet(r.source, r.model_key)) + '</textarea></p><button type="button" class="btn ghost" id="mf-copy">Copy embed code</button>');
        $('mf-more').addEventListener('click', function () { model(source, key, version); });
        $('mf-copy').addEventListener('click', function () { var t = $('mf-embed'); t.select(); try { navigator.clipboard.writeText(t.value); } catch (_) { document.execCommand('copy'); } $('mf-copy').textContent = 'Copied'; });
      }
      MODEL.units = MODEL.units.concat(r.units || []);
      MODEL.next = r.next;
      $('mf-rec').innerHTML = U.modelUnitsHTML(MODEL.units, REASONS);
      $('mf-more').hidden = !r.next;
    }).catch(function (e) { state('Could not load this record: ' + esc(errText(e)) + '.', 'warn'); });
  }

  /* ---------------------------------------------------------------- boot */
  function boot() {
    state('Loading…');
    fetch('/research/foresight/methodology/mf-v1.json', { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (M) { METHOD = M; REASONS = M && M.selection && M.selection.exclusion_reasons; renderMethod(M); }).catch(function () { /* the link stays */ });
    rpc('mf_status').then(function (st) {
      STATUS = st;
      if (METHOD) renderMethod(METHOD);
      if (st.mode === 'off') { state('Market Foresight is switched off.', 'warn'); $('mf-view').innerHTML = ''; return; }
      $('mf-chips').innerHTML = U.statusHTML(st, Date.now());
      if (!st.reader || !st.reader.can_read) return locked();
      state(st.last_run ? 'Every number below comes from records EdgeDesk stored at the time, computed under ' + esc(st.methodology ? st.methodology.version : 'the frozen methodology') + '.' : 'Nothing has been computed yet.');
      var q = new URLSearchParams(location.search), g = q.get('game'), m = q.get('model');
      if (g && g.indexOf(':') > 0) return game(g.slice(0, g.indexOf(':')), g.slice(g.indexOf(':') + 1));
      if (m && m.indexOf(':') > 0) return model(m.slice(0, m.indexOf(':')), m.slice(m.indexOf(':') + 1), q.get('v'));
      return overview();
    }).catch(function (e) {
      if (notDeployed(e)) { state('Market Foresight is built but its database layer has not been deployed yet, so there are no measurements to show. The methodology below is already frozen.', 'warn'); return; }
      state('Could not reach the record: ' + esc(errText(e)) + '. <button type="button" class="btn ghost" id="mf-retry">Try again</button>', 'warn');
      var b = $('mf-retry'); if (b) b.onclick = boot;
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
