/* ===========================================================================
   EDGEDESK NBA — the research panel (Research → Other → NBA).

     #research/nba[/<game_id>]

   Games   every upcoming game: EdgeDesk's own fair prices for the moneyline,
           spread, total, team totals, alternates, first half and first
           quarter — all read from ONE predictive distribution — then the
           model comparison, the matchup, availability with each player's
           impact, "if he sits" scenarios, the features that moved the
           number, the uncertainty, the reasons to pass, and the market
           beside (never inside) the model, with a price check.
   Props   per-player projections with fair lines from the validated count
           distributions (no prop prices are captured), each stat with its
           walk-forward status from the props record.
   Record  the walk-forward record of every candidate, the comparisons with
           their intervals, the test window and its seal.
   Methods data, licences, the protocol and the limits.

   Every game opens with the matchup graphic football has
   (lib/edgedesk_nba_graphic.js drawn by lib/edgedesk_game_graphic.js):
   EdgeDesk's fair spread, projected score and fair total, set beside the
   book's line when Today's Games holds a recent one. Square or portrait PNG,
   with Download, Share and Copy link.

   Reads committed artifacts only:
     /nba/slate.json  /nba/props_slate.json  /nba/validation/summary.json
     /nba/recent.json  games that have started: the research the slate froze
                       before tip (on demand), so a game keeps its page
     /today/slate.json the price Today's Games captured (ESPN's DraftKings
                       line), the records and the arena, for the graphic
   Nothing here computes a probability or fetches a price, except the price
   check, which is arithmetic on a probability the slate already holds.
   Research, not picks. Value claims are DISABLED until a market test passes.

   Browser: window.EDNbaUI.show(host, { game })
   =========================================================================== */
(function (W) {
  'use strict';
  var FILES = { slate: '/nba/slate.json', props: '/nba/props_slate.json', record: '/nba/validation/summary.json', recent: '/nba/recent.json', today: '/today/slate.json' };
  var STALE_H = 18;
  var S = { host: null, data: {}, err: {}, loading: {}, tab: 'games', open: null, check: { market: 'ml:home', price: '' }, propsGame: 'all', propsStat: 'pts', gfx: { format: 'square', key: null, r: null, err: null, errFor: null } };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  function pct(v, d) { var n = num(v); if (n == null) return '—'; var f = Math.pow(10, d == null ? 1 : d); return (Math.round(n * 100 * f) / f) + '%'; }
  function am(v) { var n = num(v); return n == null ? '—' : (n > 0 ? '+' : '') + Math.round(n); }
  function ln(v) { var n = num(v); if (n == null) return '—'; return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n); }
  function f1(v) { var n = num(v); return n == null ? '—' : (Math.round(n * 10) / 10).toFixed(1); }
  function f2(v) { var n = num(v); return n == null ? '—' : (Math.round(n * 100) / 100).toFixed(2); }
  function sgn(v, d) { var n = num(v); if (n == null) return '—'; var s = (Math.round(n * Math.pow(10, d || 1)) / Math.pow(10, d || 1)).toFixed(d || 1); return (n > 0 ? '+' : n < 0 ? '−' : '') + s.replace('-', ''); }
  function when(iso) { var t = Date.parse(iso); if (!isFinite(t)) return '—'; try { return new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) { return new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; } }
  function ago(iso) { var t = Date.parse(iso); if (!isFinite(t)) return 'unknown'; var h = (Date.now() - t) / 36e5; return h < 1 ? Math.max(1, Math.round(h * 60)) + ' min ago' : h < 48 ? Math.round(h) + ' h ago' : Math.round(h / 24) + ' days ago'; }
  function isStale(iso) { var t = Date.parse(iso); return !isFinite(t) || (Date.now() - t) / 36e5 > STALE_H; }
  function chip(text, cls, title) { return '<span class="xe-chip ' + (cls || '') + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + esc(text) + '</span>'; }
  var STATE_CLS = { OUTCOME_VALIDATED: 'ok2', PROVISIONAL: 'warn', NOT_TESTED: 'none', NOT_CAPTURED: 'none', DISABLED: 'bad', SEALED: 'warn', LIVE: 'ok', CACHED: 'ok2', FRESH: 'ok', STALE: 'bad', UNAVAILABLE: 'bad' };
  function stateChip(s, title) { return chip(String(s || '—').replace(/_/g, ' ').toLowerCase(), STATE_CLS[s] || 'none', title); }
  function banner(kind, html) { return '<div class="xe-banner ' + kind + '" role="' + (kind === 'err' ? 'alert' : 'status') + '">' + html + '</div>'; }
  function p2am(p) { var n = num(p); if (n == null || !(n > 0 && n < 1)) return null; var d = 1 / n; return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)); }
  function abbr(t) { return (t && (t.abbr || t.name)) || '—'; }
  function nameOf(t) { return (t && t.name) || abbr(t); }

  /* ------------------------------------------------------------ data */
  function bust() { var d = new Date(); return '?v=' + d.getUTCFullYear() + (d.getUTCMonth() + 1) + d.getUTCDate() + d.getUTCHours(); }
  function load(key, force) {
    if (S.loading[key]) return S.loading[key];
    if (S.data[key] && !force) return Promise.resolve(S.data[key]);
    S.err[key] = null;
    S.loading[key] = fetch(FILES[key] + bust(), { cache: force ? 'no-cache' : 'default' }).then(function (r) {
      if (!r.ok) throw new Error(FILES[key] + ' answered HTTP ' + r.status);
      return r.json();
    }).then(function (d) { S.data[key] = d; return d; })
      .catch(function (e) { S.err[key] = (e && e.message) || 'could not be read'; return null; })
      .then(function (d) { S.loading[key] = null; return d; });
    return S.loading[key];
  }
  function need() { return S.tab === 'record' ? ['slate', 'record'] : S.tab === 'props' ? ['slate', 'props'] : ['slate']; }
  function refresh() { S.data = {}; return Promise.all(need().map(function (k) { return load(k, true); })).then(render); }

  /* ------------------------------------------------------------ shell */
  function show(host, o) {
    S.host = host || S.host; o = o || {};
    if (o.game != null) { S.open = String(o.game); S.tab = 'games'; }
    if (!S.host) return Promise.resolve();
    render();
    return Promise.all(need().map(function (k) { return load(k); })).then(render);
  }
  function render() {
    var h = S.host; if (!h) return;
    var ks = need(), optional = { props: 1 };
    var errs = ks.filter(function (k) { return S.err[k] && !optional[k]; }), busy = ks.some(function (k) { return !S.data[k] && !S.err[k]; });
    var head = '<div class="xe-head"><div class="xe-title"><h3>NBA</h3><small>EdgeDesk\'s own price for every market, from one distribution — the models, the matchup, who is playing, and the record behind it. Research, not picks.</small></div><div class="xe-grow"></div><button class="xe-btn ghost" data-act="refresh">Refresh</button></div>';
    var tabs = '<div class="xe-ctl"><div class="xe-seg" role="tablist" aria-label="NBA sections">' + [['games', 'Games'], ['props', 'Props'], ['record', 'Record'], ['methods', 'Methods']].map(function (t) { return '<button role="tab" data-tab="' + t[0] + '" class="' + (S.tab === t[0] ? 'on' : '') + '" aria-selected="' + (S.tab === t[0]) + '">' + t[1] + '</button>'; }).join('') + '</div></div>';
    var body;
    if (errs.length) body = banner('err', '<b>The NBA research could not load.</b> ' + esc(errs.map(function (k) { return S.err[k]; }).join('; ')) + '. Nothing is shown in its place. <button class="xe-btn" data-act="refresh">Try again</button>');
    else if (busy) body = '<div class="xe-loading" aria-busy="true">Loading…</div>';
    else body = S.tab === 'record' ? renderRecord() : S.tab === 'props' ? renderProps() : S.tab === 'methods' ? renderMethods() : renderGames();
    h.innerHTML = '<div class="xe nb">' + head + tabs + body + '</div>';
    wire(h);
    if (S.tab === 'games' && S.open && !busy && !errs.length && h.querySelector('#nbGfxImg[hidden]')) gfxDraw();
  }

  /* ------------------------------------------------------------ games */
  function readiness(s) {
    var rec = (s.model && s.model.record) || {}, sel = rec.selection || {};
    return '<section class="xe-ready" aria-label="Readiness">' +
      '<div><span class="xe-k">Model</span> ' + esc(s.model && s.model.label) + ' ' + stateChip(/SEALED/.test(rec.status || '') ? 'SEALED' : 'PROVISIONAL', rec.status) + ' <span class="xe-dim">selection-window log loss ' + (sel.ml_log_loss == null ? '—' : sel.ml_log_loss) + ' vs Elo ' + ((rec.elo_selection || {}).ml_log_loss == null ? '—' : rec.elo_selection.ml_log_loss) + ' · n ' + (sel.n || '—') + '</span></div>' +
      '<div><span class="xe-k">Availability</span> projected from each team\'s previous game · <span class="xe-dim">no injury report or confirmed lineup is in the price</span></div>' +
      '<div><span class="xe-k">Market</span> ' + stateChip((s.games[0] && s.games[0].market && s.games[0].market.status) || 'NOT_CAPTURED') + ' <span class="xe-dim">NBA prices are not requested unless authorised</span></div>' +
      '<div><span class="xe-k">Value claims</span> ' + stateChip(s.value_claims) + ' <span class="xe-dim">' + esc(s.value_reason) + '</span></div></section>';
  }
  /* the open game: on the slate, or started and frozen in recent.json. A
     started game reads the research frozen before tip when there is one
     (the slate keeps a game for three hours after tip and prices it again). */
  function frozenGame(id) {
    var R = S.data.recent;
    return R && R.schema === 'edgedesk_nba_recent_v1' && Array.isArray(R.games) ? R.games.filter(function (x) { return String(x.game_id) === String(id); })[0] || null : null;
  }
  function findGame(id) {
    var s = S.data.slate, g = s && s.games ? s.games.filter(function (x) { return String(x.game_id) === String(id); })[0] : null;
    var f = frozenGame(id);
    if (f && (!g || Date.parse(g.start_utc) <= Date.now())) return { g: f, frozen: f.frozen_at || null };
    return g ? { g: g, frozen: null } : null;
  }
  /* started games not on the slate, from the last 36 hours, newest first */
  function recentShown(s) {
    var R = S.data.recent, now = Date.now(), on = {};
    if (!R || !Array.isArray(R.games)) return [];
    (s.games || []).forEach(function (g) { on[String(g.game_id)] = 1; });
    return R.games.filter(function (g) { var t = Date.parse(g.start_utc); return !on[String(g.game_id)] && isFinite(t) && t <= now && now - t < 36 * 36e5; })
      .sort(function (a, b) { return Date.parse(b.start_utc) - Date.parse(a.start_utc); });
  }
  function renderGames() {
    var s = S.data.slate;
    if (!s || s.schema !== 'edgedesk_nba_slate_v1' || !Array.isArray(s.games)) return banner('err', '<b>Integrity refusal.</b> The NBA slate is not in the expected format. Nothing is shown in its place.');
    var out = '';
    if (isStale(s.generated_at)) out += banner('warn', '<b>Stale prices.</b> The slate was built ' + esc(ago(s.generated_at)) + '. Availability and results may have changed since.');
    if (S.open) {
      var onSlate = s.games.filter(function (x) { return String(x.game_id) === S.open; })[0];
      /* a game not on the slate, or one that has started, may have research frozen before tip */
      if ((!onSlate || Date.parse(onSlate.start_utc) <= Date.now()) && !S.data.recent && !S.err.recent) { load('recent').then(render); return out + '<div class="xe-loading" aria-busy="true">Loading this game’s research…</div>'; }
      var hit = findGame(S.open);
      /* the game leads; data, model and market status fold away under it */
      if (hit) return out + gameDetail(s, hit.g, hit.frozen) + '<details class="xe-sport xe-statusd"><summary><span class="xe-mu">Data, model and market status</span></summary><div class="xe-sbody">' + readiness(s) + '</div></details>';
      out += banner('warn', 'Game ' + esc(S.open) + ' is not on the current slate and EdgeDesk holds no pregame research for it.'); S.open = null;
    }
    out += readiness(s);
    out += '<div class="xe-sechd"><span>Games</span><span class="r">' + esc(s.horizon) + ' · built ' + esc(ago(s.generated_at)) + '</span></div>';
    if (!s.games.length) out += '<div class="xe-empty">No NBA games on the slate. That is a valid result.</div>';
    else out += '<div class="xe-list">' + s.games.map(gameCard).join('') + '</div>';
    var rec = recentShown(s);
    if (rec.length) out += '<div class="xe-sechd"><span>Started · research frozen before tip</span><span class="r">' + rec.length + ' game' + (rec.length === 1 ? '' : 's') + '</span></div><div class="xe-list">' + rec.map(gameCard).join('') + '</div>';
    else if (!S.data.recent && !S.err.recent) load('recent').then(function (d) { if (d && recentShown(s).length) render(); });
    out += '<p class="xe-foot">' + esc(s.settlement) + ' ' + esc(s.license && s.license.sportsdataverse) + ' 21+. Gamble responsibly — 1-800-GAMBLER.</p>';
    return out;
  }
  function gameCard(g) {
    var p = g.price; if (!p) return '';
    var m = p.moneyline, sp = p.spread, t = p.total, homeFav = m.home >= 0.5, U = g.uncertainty || {}, Dg = g.disagreement || {};
    var started = !!g.frozen_at || Date.parse(g.start_utc) <= Date.now();
    var chips = (U.early_season ? chip('early season', 'warn') : '') + (U.rotation_stale ? chip('rotation from last season', 'warn') : '') + (Dg.sd_p_home >= 0.04 ? chip('models disagree', 'warn') : '');
    return '<button class="xe-card xe-game' + (started ? ' xe-started' : '') + '" data-game="' + esc(g.game_id) + '"><span class="xe-mu">' + esc(abbr(g.away)) + ' @ ' + esc(abbr(g.home)) + (window.EDGradeUI ? ' ' + window.EDGradeUI.slot('NBA|' + g.game_id, { term: false }) : '') + '</span><span class="xe-sub">' + (started ? '<b>Started</b> · ' : '') + esc(when(g.start_utc)) + (g.neutral ? ' · neutral site' : '') + '</span>' +
      winBar(g) +
      '<span class="xe-row"><span class="k">ML</span><span class="v num">' + esc(abbr(g.away)) + ' ' + am(m.away_american) + ' · ' + esc(abbr(g.home)) + ' ' + am(m.home_american) + '</span></span>' +
      '<span class="xe-row"><span class="k">Spread</span><span class="v num">' + esc(homeFav ? abbr(g.home) : abbr(g.away)) + ' ' + ln(homeFav ? sp.fair_line_home : -sp.fair_line_home) + '</span><span class="k">Total</span><span class="v num">' + t.fair_line + '</span></span>' +
      '<span class="xe-row"><span class="k">Expected</span><span class="v num">' + esc(abbr(g.away)) + ' ' + f1(p.expected.away) + ' – ' + f1(p.expected.home) + ' ' + esc(abbr(g.home)) + '</span><span class="xe-dim">OT ' + pct(p.p_overtime, 0) + '</span></span>' +
      (chips ? '<span class="xe-chips">' + chips + '</span>' : '') + '</button>';
  }
  function winBar(g) {
    var ph = num(g.price.moneyline.home) || 0.5;
    return '<span class="nb-win" role="img" aria-label="' + esc(abbr(g.away)) + ' ' + pct(1 - ph) + ', ' + esc(abbr(g.home)) + ' ' + pct(ph) + '"><span class="nb-wa" style="width:' + (100 * (1 - ph)).toFixed(1) + '%">' + esc(abbr(g.away)) + ' ' + pct(1 - ph, 0) + '</span><span class="nb-wh" style="width:' + (100 * ph).toFixed(1) + '%">' + pct(ph, 0) + ' ' + esc(abbr(g.home)) + '</span></span>';
  }
  function table(caption, head, rows, cls) { return '<div class="xe-tw"><table class="xe-t ' + (cls || '') + '"><caption>' + caption + '</caption><tr>' + head.map(function (h) { return '<th>' + h + '</th>'; }).join('') + '</tr>' + rows.join('') + '</table></div>'; }

  function gameDetail(s, g, frozen) {
    var p = g.price, m = p.moneyline, H = abbr(g.home), A = abbr(g.away);
    var out = '<button class="xe-btn ghost" data-act="back">← All games</button><section class="xe-detail" aria-label="' + esc(A + ' at ' + H) + '"><h4>' + esc(nameOf(g.away)) + ' @ ' + esc(nameOf(g.home)) + '</h4><div class="xe-sub">' + esc(when(g.start_utc)) + (g.neutral ? ' · neutral site' : '') + ' · priced ' + esc(ago(g.predicted_at)) + ' by ' + esc(g.model) + '</div>';
    if (frozen) out += banner('info', '<b>This game has started.</b> This is the research EdgeDesk froze before tip (' + esc(when(frozen)) + '); nothing on it is recomputed.');
    out += gfxBlock(g, frozen);
    out += winBar(g);
    /* the A–F research grade locked in the performance ledger: the quality of this research, not a side */
    if (window.EDGradeUI) out += frozen || Date.parse(g.start_utc) <= Date.now() ? window.EDGradeUI.breakdown('NBA|' + g.game_id, { started: true }) : window.EDGradeUI.breakdown('NBA|' + g.game_id);
    out += '<div class="nb-kpis">' +
      kpi('Expected score', A + ' ' + f1(p.expected.away) + ' – ' + f1(p.expected.home) + ' ' + H) +
      kpi('Fair moneyline', A + ' ' + am(m.away_american) + ' / ' + H + ' ' + am(m.home_american)) +
      kpi('Fair spread', H + ' ' + ln(p.spread.fair_line_home)) +
      kpi('Fair total', String(p.total.fair_line)) +
      kpi('Margin, 80% range', ln(p.margin_interval_80[0]) + ' to ' + ln(p.margin_interval_80[1]) + ' (' + H + ')') +
      kpi('Overtime', pct(p.p_overtime)) + '</div>';
    /* markets */
    out += '<div class="xe-sechd"><span>Every market, one distribution</span><span class="r">' + esc(p.spread.settles) + '</span></div>';
    out += table('Moneyline <span class="xe-dim">(' + esc(m.settles) + ')</span>', ['', 'Probability', 'Fair'], ['<tr><td>' + esc(A) + '</td><td class="num">' + pct(m.away) + '</td><td class="num">' + am(m.away_american) + '</td></tr>', '<tr><td>' + esc(H) + '</td><td class="num">' + pct(m.home) + '</td><td class="num">' + am(m.home_american) + '</td></tr>']);
    out += table('Spread ladder (' + esc(H) + ' line) <span class="xe-dim">— a fair price excludes the push</span>', ['Line', H + ' covers', 'Push', A + ' covers', 'Fair ' + H, 'Fair ' + A], p.spread.ladder.map(function (x) { var on = x.line_home === p.spread.fair_line_home; return '<tr' + (on ? ' class="on"' : '') + '><td class="num">' + ln(x.line_home) + '</td><td class="num">' + pct(x.win) + '</td><td class="num">' + (x.push ? pct(x.push) : '—') + '</td><td class="num">' + pct(x.lose) + '</td><td class="num">' + am(x.fair_american) + '</td><td class="num">' + am(x.fair == null ? null : p2am(1 - x.fair)) + '</td></tr>'; }));
    out += table('Total ladder', ['Line', 'Over', 'Push', 'Under', 'Fair over', 'Fair under'], p.total.ladder.map(function (x) { var on = x.line === p.total.fair_line; return '<tr' + (on ? ' class="on"' : '') + '><td class="num">' + x.line + '</td><td class="num">' + pct(x.over.win) + '</td><td class="num">' + (x.over.push ? pct(x.over.push) : '—') + '</td><td class="num">' + pct(x.under.win) + '</td><td class="num">' + am(x.over.fair_american) + '</td><td class="num">' + am(x.under.fair_american) + '</td></tr>'; }));
    if (p.team_totals) out += table('Team totals <span class="xe-dim">(' + esc(p.team_totals.settles) + '; read from the joint margin × total)</span>', ['Line', 'Over', 'Fair over', 'Under', 'Fair under'], ['home', 'away'].map(function (k) { var x = p.team_totals[k].main; return '<tr><td>' + esc(k === 'home' ? H : A) + ' ' + x.line + '</td><td class="num">' + pct(x.over.win) + '</td><td class="num">' + am(x.over.fair_american) + '</td><td class="num">' + pct(x.under.win) + '</td><td class="num">' + am(x.under.fair_american) + '</td></tr>'; }));
    ['first_half', 'first_quarter'].forEach(function (k) {
      var x = p[k]; if (!x) return;
      out += table((k === 'first_half' ? 'First half' : 'First quarter') + ' <span class="xe-dim">(' + esc(x.settles) + ')</span>', ['', H, 'Tie', A], [
        '<tr><td>Win (3-way)</td><td class="num">' + pct(x.moneyline_3way.home) + '</td><td class="num">' + pct(x.moneyline_3way.tie) + '</td><td class="num">' + pct(x.moneyline_3way.away) + '</td></tr>',
        '<tr><td>Spread ' + esc(H) + ' ' + ln(x.spread.line_home) + '</td><td class="num">' + pct(x.spread.win) + '</td><td class="num">' + (x.spread.push ? pct(x.spread.push) : '—') + '</td><td class="num">' + pct(x.spread.lose) + '</td></tr>',
        '<tr><td>Total ' + x.total.line + ' (over / under)</td><td class="num">' + pct(x.total.over.win) + '</td><td class="num">' + (x.total.over.push ? pct(x.total.over.push) : '—') + '</td><td class="num">' + pct(x.total.under.win) + '</td></tr>']);
    });
    out += table('Winning margin', ['', '1–5', '6–10', '11–15', '16–20', '21+'], ['home', 'away'].map(function (k) { var b = p.margin_bands[k]; return '<tr><td>' + esc(k === 'home' ? H : A) + '</td>' + Object.keys(b).map(function (q) { return '<td class="num">' + pct(b[q], 0) + '</td>'; }).join('') + '</tr>'; }));
    out += modelsBlock(g);
    out += matchupBlock(g);
    out += availabilityBlock(g);
    out += scenariosBlock(g);
    out += explanationBlock(g);
    out += '<div class="xe-sechd"><span>Uncertainty</span></div><p>Margin sd ' + f1(g.uncertainty.margin_sd) + ' points; rating uncertainty ±' + f1(g.uncertainty.rating_sd_points) + ' points; model disagreement ±' + pct(g.uncertainty.model_disagreement_sd) + ' on the win probability. Total 80% range ' + esc((g.uncertainty.total_interval_80 || []).join('–')) + '.</p>' + (g.uncertainty.notes.length ? '<ul>' + g.uncertainty.notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>' : '');
    out += '<div class="xe-sechd"><span>Reasons to pass</span></div><ul class="nb-pass">' + g.reasons_to_pass.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ul>';
    if (g.decision && g.decision.gates) out += table('Decision: ' + esc(g.decision.decision) + ' <span class="xe-dim">(every gate must pass before a game can be called)</span>', ['Gate', 'State', 'Why'], g.decision.gates.map(function (x) { return '<tr><td>' + esc(x.gate) + '</td><td>' + (x.pass ? 'pass' : '<b>fails</b>') + '</td><td>' + esc(x.why) + '</td></tr>'; }));
    out += marketBlock(g);
    out += priceCheck(g);
    return out + '</section>';
  }
  /* ---- the matchup graphic: the football template (lib/edgedesk_game_graphic.js)
     filled from this game by lib/edgedesk_nba_graphic.js; square or portrait,
     download, share, copy link. Drawn after the page renders, cached by key. ---- */
  var SCRIPTS = { graphic: '/lib/edgedesk_game_graphic.js', nbagfx: '/lib/edgedesk_nba_graphic.js' };
  var scriptP = {};
  function script(k) {
    if (k === 'graphic' && W.EDGameGraphic && W.EDGameGraphic.renderContent) return Promise.resolve(); if (k === 'nbagfx' && W.EDNBAGraphic) return Promise.resolve();
    if (scriptP[k]) return scriptP[k];
    scriptP[k] = new Promise(function (res, rej) { var el = document.createElement('script'); el.src = SCRIPTS[k] + bust(); el.onload = function () { res(); }; el.onerror = function () { scriptP[k] = null; rej(new Error(SCRIPTS[k] + ' could not be loaded')); }; document.head.appendChild(el); });
    return scriptP[k];
  }
  /* Today's Games' event for this game: ESPN's id is the slate's own, and both sides must agree */
  function todayEvent(g) {
    var T = S.data.today;
    if (!T || T.schema !== 'edgedesk_slate/1' || !Array.isArray(T.events)) return null;
    var e = T.events.filter(function (x) { return x && x.id === 'nba:espn:' + g.game_id; })[0];
    return e && e.home && e.away && e.home.abbr === abbr(g.home) && e.away.abbr === abbr(g.away) ? e : null;
  }
  /* the freshest captured price: the games strip's live one when it is on the page, else Today's Games' */
  function quoteFor(g) {
    var best = null, e = todayEvent(g);
    var offer = function (m) { var t = m ? Date.parse(m.captured_at) : NaN; if (isFinite(t) && (!best || t > Date.parse(best.captured_at))) best = m; };
    try { if (W.EDGamesUI && W.EDGamesUI.marketFor) offer(W.EDGamesUI.marketFor('nba', String(g.game_id))); } catch (_) { /* the strip is optional */ }
    if (e && S.data.today.markets) offer(S.data.today.markets[e.id]);
    return best;
  }
  function gfxOpts(g, frozen) {
    var s = S.data.slate || {}, e = todayEvent(g), rec = {}, mk = null;
    if (e) { if (e.home.record) rec[e.home.abbr] = e.home.record; if (e.away.record) rec[e.away.abbr] = e.away.record; }
    if (!frozen) { mk = quoteFor(g); if (mk && !(Date.parse(mk.captured_at) < Date.parse(g.start_utc))) mk = null; }
    var gr = W.EDGradeUI && W.EDGradeUI.entry ? W.EDGradeUI.entry('NBA|' + g.game_id) : null;
    var og = g.decision && g.decision.gates ? g.decision.gates.filter(function (x) { return x.gate === 'outcome record'; })[0] : null;
    return { now: Date.now(), generated_at: frozen || g.predicted_at || s.generated_at, frozen_at: frozen || null, model_id: g.model || (s.model && s.model.chosen) || null,
      records: rec, venue: e ? e.venue : null, market: mk, grade: gr, validation: og ? (og.pass ? 'OUTCOME_VALIDATED' : 'PROVISIONAL') : null };
  }
  function gfxBlock(g, frozen) {
    var F = S.gfx, key = W.EDNBAGraphic ? W.EDNBAGraphic.key(g, gfxOpts(g, frozen)) + '|' + F.format : null, have = F.r && F.key === key;
    var err = F.err && F.errFor === g.game_id + '|' + F.format ? F.err : null;
    return '<section class="xe-gfx" aria-label="Matchup graphic"><figure class="gv-fig" style="aspect-ratio:' + (F.format === 'portrait' ? '1080/1350' : '1/1') + '">'
      + (have ? '<img id="nbGfxImg" src="' + esc(F.r.url) + '" alt="' + esc(F.r.alt) + '">' : (err ? '<div class="gv-empty">The graphic could not be drawn: ' + esc(err) + '. Every number below is unaffected.</div>' : '<div class="gv-skel gv-figskel"></div><img id="nbGfxImg" alt="" hidden>')) + '</figure>'
      + '<div class="gv-fmt" role="group" aria-label="Graphic format">' + ['square', 'portrait'].map(function (f) { return '<button type="button" class="gv-seg' + (F.format === f ? ' on' : '') + '" aria-pressed="' + (F.format === f) + '" data-act="gfx-fmt" data-v="' + f + '">' + (f === 'square' ? 'Square 1080×1080' : 'Portrait 1080×1350') + '</button>'; }).join('') + '</div>'
      + '<div class="gv-acts"><button type="button" class="gv-btn gv-primary" data-act="gfx-dl">Download PNG</button><button type="button" class="gv-btn" data-act="gfx-share">Share</button><button type="button" class="gv-btn" data-act="gfx-copy">Copy link</button></div>'
      + '<div class="gv-msg" id="nbGfxMsg" role="status" aria-live="polite"></div></section>';
  }
  function gfxDraw() {
    var hit = S.open ? findGame(S.open) : null;
    if (!hit) return Promise.resolve(null);
    var g = hit.g, fmt = S.gfx.format;
    /* Today's Games is optional: without it the strip is EdgeDesk's own detail */
    return Promise.all([script('graphic'), script('nbagfx'), load('today')]).then(function () {
      var o = gfxOpts(g, hit.frozen), key = W.EDNBAGraphic.key(g, o) + '|' + fmt;
      if (S.gfx.r && S.gfx.key === key) return S.gfx.r;
      return W.EDNBAGraphic.render(g, o, fmt).then(function (r) {
        S.gfx.r = r; S.gfx.key = key; S.gfx.err = null;
        var im = S.host && S.host.querySelector('#nbGfxImg');
        if (im && String(S.open) === String(g.game_id) && S.gfx.format === fmt) { im.src = r.url; im.alt = r.alt; im.hidden = false; var sk = im.parentNode.querySelector('.gv-figskel'); if (sk) sk.remove(); }
        return r;
      });
    }).catch(function (e) {
      S.gfx.err = (e && (e.message || e.reason)) || String(e); S.gfx.errFor = g.game_id + '|' + fmt;
      var fig = S.host && S.host.querySelector('.xe-gfx .gv-fig'); if (fig) fig.innerHTML = '<div class="gv-empty">The graphic could not be drawn: ' + esc(S.gfx.err) + '. Every number below is unaffected.</div>';
      return null;
    });
  }
  function gfxMsg(t) { var m = S.host && S.host.querySelector('#nbGfxMsg'); if (m) m.textContent = t; }
  function gfxUrl() { try { return location.origin + location.pathname + '#research/nba/' + S.open; } catch (_) { return 'https://edgedesksports.com/app.html#research/nba/' + S.open; } }
  function gfxAct(act, v) {
    if (act === 'gfx-fmt') { S.gfx.format = v === 'portrait' ? 'portrait' : 'square'; render(); return; }
    if (act === 'gfx-copy') { var u = gfxUrl(), Nv = W.navigator; if (Nv && Nv.clipboard && Nv.clipboard.writeText) Nv.clipboard.writeText(u).then(function () { gfxMsg('Link copied: ' + u); }, function () { gfxMsg(u); }); else gfxMsg(u); return; }
    gfxMsg('Drawing the graphic…');
    gfxDraw().then(function (r) {
      if (!r) { gfxMsg('The graphic could not be drawn' + (S.gfx.err ? ': ' + S.gfx.err : '') + '.'); return; }
      if (act === 'gfx-dl') { var a = document.createElement('a'); a.href = r.url; a.download = r.file_name; document.body.appendChild(a); a.click(); a.remove(); gfxMsg('Saved ' + r.file_name + '.'); return; }
      var Nv = W.navigator, file = null, text = 'EdgeDesk research: ' + r.content.away.short + ' at ' + r.content.home.short + ' · fair spread ' + r.content.spread_text + ', total ' + r.content.total + '. Research, not picks.';
      try { if (r.blob && typeof File === 'function') file = new File([r.blob], r.file_name, { type: 'image/png' }); } catch (_) { file = null; }
      gfxMsg('');
      if (Nv && Nv.share && file && Nv.canShare && Nv.canShare({ files: [file] })) return Nv.share({ files: [file], title: 'EdgeDesk research', text: text, url: gfxUrl() }).catch(function () { /* the reader closed the sheet */ });
      if (Nv && Nv.share) return Nv.share({ title: 'EdgeDesk research', text: text, url: gfxUrl() }).catch(function () { /* closed */ });
      gfxAct('gfx-copy'); gfxMsg('Sharing is not available in this browser: the link was copied. Use Download PNG for the image.');
    });
  }
  function kpi(k, v) { return '<div class="nb-kpi"><div class="xe-k">' + esc(k) + '</div><div class="nb-kv num">' + esc(v) + '</div></div>'; }
  function modelsBlock(g) {
    var H = abbr(g.home);
    var rows = g.models.slice().sort(function (a, b) { return (a.selection_ml_log_loss || 9) - (b.selection_ml_log_loss || 9); }).map(function (x) {
      return '<tr' + (x.chosen ? ' class="on"' : '') + '><td>' + esc(x.label) + (x.chosen ? ' <span class="xe-dim">(chosen)</span>' : '') + '</td><td class="num">' + pct(x.p_home) + '</td><td class="num">' + ln(x.fair_spread_home) + '</td><td class="num">' + x.fair_total + '</td><td class="num">' + (x.selection_ml_log_loss == null ? '—' : x.selection_ml_log_loss) + '</td></tr>';
    });
    return '<div class="xe-sechd"><span>Model comparison</span><span class="r">spread of win probabilities ' + pct(g.disagreement.range_p_home && g.disagreement.range_p_home[0]) + '–' + pct(g.disagreement.range_p_home && g.disagreement.range_p_home[1]) + '</span></div>' +
      table('Every candidate, same game <span class="xe-dim">(sorted by held-out selection log loss; lower is better)</span>', ['Model', H + ' wins', 'Fair spread (' + esc(H) + ')', 'Fair total', 'Selection LL'], rows);
  }
  function factorRow(label, h, a, lg, fmt) {
    var bar = function (v) { if (v == null || lg == null) return ''; var d = (v - lg) / Math.max(1e-9, Math.abs(lg)); var w = Math.min(50, Math.abs(d) * 400); return '<span class="nb-dev"><span class="nb-devb ' + (d >= 0 ? 'up' : 'dn') + '" style="width:' + w.toFixed(1) + '%;' + (d >= 0 ? 'left:50%' : 'right:50%') + '"></span></span>'; };
    return '<tr><td>' + esc(label) + '</td><td class="num">' + fmt(h) + bar(h) + '</td><td class="num">' + fmt(a) + bar(a) + '</td><td class="num">' + fmt(lg) + '</td></tr>';
  }
  function matchupBlock(g) {
    var M = g.matchup, H = abbr(g.home), A = abbr(g.away), F = M.four_factors;
    var p1 = function (v) { return v == null ? '—' : (100 * v).toFixed(1) + '%'; };
    var sch = function (x) { return (x.rest_days == null ? '—' : x.rest_days + ' d rest') + (x.back_to_back ? ' · back-to-back' : '') + ' · ' + x.games_in_7 + ' in 7 days' + (x.travel_km ? ' · ' + x.travel_km + ' km travel' : '') + (x.road_trip_game ? ' · road trip game ' + x.road_trip_game : '') + (x.altitude ? ' · at altitude' : ''); };
    return '<div class="xe-sechd"><span>The matchup</span><span class="r">opponent-adjusted, point in time</span></div>' +
      '<p>Expected pace ' + f1(M.pace) + ' possessions (league ' + f1(M.league_pace) + '). ' + esc(H) + ' offence vs ' + esc(A) + ' defence: ' + f1(M.home_offence_vs_away_defence) + ' points per 100; ' + esc(A) + ' offence vs ' + esc(H) + ' defence: ' + f1(M.away_offence_vs_home_defence) + ' (league ' + f1(M.league_efficiency) + ').</p>' +
      table('Four factors, each offence against this defence', ['Factor', H + ' offence', A + ' offence', 'League'], [
        factorRow('Effective FG%', F.home.efg, F.away.efg, F.league.efg, p1), factorRow('Turnovers per possession', F.home.tov, F.away.tov, F.league.tov, p1),
        factorRow('Offensive rebound %', F.home.orb, F.away.orb, F.league.orb, p1), factorRow('Free throws made per FGA', F.home.ftr, F.away.ftr, F.league.ftr, p1), factorRow('Three-point attempt share', F.home.three_rate, F.away.three_rate, F.league.three_rate, p1)]) +
      '<p class="xe-dim">Shooting luck (eFG% above what shot locations predict): ' + esc(H) + ' ' + sgn(100 * (M.shooting_luck.home_offence || 0)) + ' pts on offence, ' + esc(A) + ' ' + sgn(100 * (M.shooting_luck.away_offence || 0)) + '. ' + esc(M.shooting_luck.note) + '.</p>' +
      '<p><span class="xe-k">Schedule</span>' + esc(H) + ': ' + esc(sch(M.schedule.home)) + '<br>' + esc(A) + ': ' + esc(sch(M.schedule.away)) + '</p>';
  }
  function availabilityBlock(g) {
    var side = function (k) {
      var x = g.availability[k], T = abbr(g[k]);
      var rows = x.projected.map(function (p) { return '<tr><td>' + esc(p.name) + (p.on_current_roster === false ? ' <span class="xe-chip warn">left</span>' : '') + '</td><td class="num">' + f1(p.minutes) + '</td><td class="num">' + sgn(p.off) + '</td><td class="num">' + sgn(p.def) + '</td><td class="num">' + sgn(p.impact_pts, 2) + '</td><td class="num">' + pct(p.start_rate, 0) + '</td></tr>'; });
      var absent = x.absent_regulars.length ? '<p><span class="xe-k">Regulars not in the last game</span>' + x.absent_regulars.map(function (p) { return esc(p.name) + ' <span class="xe-dim">(' + f1(p.usual_minutes) + ' min, ' + sgn(p.off + p.def) + '/100)</span>'; }).join(', ') + '</p>' : '';
      var arr = x.arrivals && x.arrivals.length ? '<p><span class="xe-k">On the current roster, not in this projection</span>' + x.arrivals.map(function (p) { return esc(p.name) + ' <span class="xe-dim">(' + f1(p.usual_minutes) + ' min)</span>'; }).join(', ') + '</p>' : '';
      return table(esc(nameOf(g[k])) + ' — ' + esc(x.rotation_source) + ' · net ' + sgn(x.net_per100) + ' per 100', ['Player', 'Exp. min', 'Off /100', 'Def /100', 'Impact (pts)', 'Starts'], rows) + '<p class="xe-dim">Likely starters: ' + esc(x.likely_starters.join(', ')) + '</p>' + absent + arr;
    };
    return '<div class="xe-sechd"><span>Who is playing</span><span class="r">player impact (RAPM) × expected minutes</span></div>' + side('home') + side('away') +
      '<p class="xe-note">Impact is points per game above an average player at this pace: (minutes / 48) × (offence + defence per 100). Minutes of an absent player go to available teammates in proportion to their own; a star\'s absence is what his minutes and impact say, never a fixed number of points.</p>';
  }
  function scenariosBlock(g) {
    var H = abbr(g.home);
    var rows = g.scenarios.map(function (x) { return '<tr><td>' + esc(x.player) + ' <span class="xe-dim">(' + esc(x.team) + ')</span> ' + (x.kind === 'sits' ? 'sits' : 'returns') + '</td><td class="num">' + pct(x.p_home) + '</td><td class="num ' + (x.delta_p_home > 0 ? 'nb-up' : x.delta_p_home < 0 ? 'nb-dn' : '') + '">' + sgn(100 * x.delta_p_home) + '</td><td class="num">' + ln(x.fair_spread_home) + '</td><td class="num">' + x.fair_total + '</td></tr>'; });
    var rs = g.roster_scenario ? '<p><span class="xe-k">' + esc(g.roster_scenario.label) + '</span>' + esc(H) + ' wins ' + pct(g.roster_scenario.p_home) + ' (' + sgn(100 * g.roster_scenario.delta_p_home) + ' pts), fair spread ' + esc(H) + ' ' + ln(g.roster_scenario.fair_spread_home) + ', total ' + g.roster_scenario.fair_total + '. <span class="xe-dim">' + esc(g.roster_scenario.note) + '</span></p>' : '';
    return '<div class="xe-sechd"><span>If he sits</span><span class="r">the same model, availability changed</span></div>' + (rows.length ? table('Scenarios', ['Scenario', H + ' wins', 'Change (pts)', 'Spread (' + esc(H) + ')', 'Total'], rows) : '<div class="xe-empty">No scenario.</div>') + rs;
  }
  function explanationBlock(g) {
    if (!g.explanation || !g.explanation.length) return '';
    var mx = Math.max.apply(null, g.explanation.map(function (x) { return Math.abs(x.points_toward_home); })) || 1;
    var sums = g.explanation.some(function (x) { return x.kind === 'reconciliation'; });
    return '<div class="xe-sechd"><span>What moved the number</span><span class="r">points toward ' + esc(abbr(g.home)) + (sums ? '; the rows add up to the published margin' : ' vs an average matchup (linear model)') + '</span></div><div class="nb-contrib">' + g.explanation.map(function (x) {
      var w = 50 * Math.abs(x.points_toward_home) / mx;
      return '<div class="nb-crow"><span class="nb-cl">' + esc(x.label) + '</span><span class="nb-cbar"><span class="nb-cb ' + (x.points_toward_home >= 0 ? 'up' : 'dn') + '" style="width:' + w.toFixed(1) + '%;' + (x.points_toward_home >= 0 ? 'left:50%' : 'right:50%') + '"></span></span><span class="nb-cv num">' + sgn(x.points_toward_home, 2) + '</span></div>';
    }).join('') + '</div><p class="xe-note">' + (sums
      ? 'The named rows are the linear model\'s coefficient × (this game\'s feature − its training average). The last three rows carry the rest of the linear model, its value at an average matchup and what the other blended models and the calibration add, so every row together is the published margin.'
      : 'Contributions are the linear model\'s coefficient × (this game\'s feature − its training average), so they add up to that model\'s margin; the chosen model blends it with the others.') + '</p>';
  }
  function marketBlock(g) {
    var M = g.market || {};
    if (!M.quotes || !M.quotes.length) return '<div class="xe-sechd"><span>The market</span></div><p>' + stateChip(M.status || 'NOT_CAPTURED') + ' <span class="xe-dim">' + esc(M.reason || M.note || '') + '</span></p>';
    var rows = M.quotes.map(function (q) { return '<tr><td>' + esc(q.book) + '</td><td>' + esc(q.market) + ' ' + esc(q.side) + (q.line != null ? ' ' + ln(q.line) : '') + '</td><td class="num">' + am(q.american) + '</td><td class="num">' + pct(q.break_even) + '</td><td class="num">' + pct(q.model_p) + '</td><td class="num">' + pct(q.market_novig_p) + '</td><td class="num">' + pct(q.ev_vs_model) + '</td><td>' + stateChip(q.freshness, q.age_min + ' min old') + '</td></tr>'; });
    return '<div class="xe-sechd"><span>The market</span><span class="r">' + esc(M.status) + ' · captured ' + esc(ago(M.captured_at)) + '</span></div>' + table('Book prices beside the model <span class="xe-dim">— ' + esc(M.value_reason) + '</span>', ['Book', 'Market', 'Price', 'Break-even', 'Model', 'Market (no-vig)', 'EV vs model', 'Quote'], rows);
  }
  function priceCheck(g) {
    var p = g.price, H = abbr(g.home), A = abbr(g.away);
    var opts = [['ml:home', H + ' moneyline', p.moneyline.home, 0], ['ml:away', A + ' moneyline', p.moneyline.away, 0]];
    p.spread.ladder.forEach(function (x) { opts.push(['sp:' + x.line_home, H + ' ' + ln(x.line_home), x.win, x.push], ['spa:' + x.line_home, A + ' ' + ln(-x.line_home), x.lose, x.push]); });
    p.total.ladder.forEach(function (x) { opts.push(['o:' + x.line, 'Over ' + x.line, x.over.win, x.over.push], ['u:' + x.line, 'Under ' + x.line, x.under.win, x.under.push]); });
    var sel = opts.filter(function (o) { return o[0] === S.check.market; })[0] || opts[0];
    var a = num(S.check.price), res = '';
    if (a != null && Math.abs(a) >= 100) {
      var d = a > 0 ? 1 + a / 100 : 1 + 100 / -a, pw = sel[2], push = sel[3];
      var be = (1 - push) / d, ev = pw * d - (1 - push);
      res = '<div class="xe-pc-res" role="status">Break-even ' + pct(be) + ' · EdgeDesk ' + pct(pw) + (push ? ' (push ' + pct(push) + ')' : '') + ' · EV ' + pct(ev) + ' per unit at ' + am(a) + '. <b>Not a value call:</b> NBA value claims are disabled until the model is tested against closing prices.</div>';
    } else if (S.check.price) res = '<div class="xe-pc-res bad" role="status">Enter an American price such as −135 or +120.</div>';
    return '<div class="xe-k">Check a price</div><form class="xe-pc" data-form="check"><label class="xe-lab">Market <select class="xe-in" name="market">' + opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (o[0] === sel[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select></label><label class="xe-lab">Price <input class="xe-in num" name="price" inputmode="numeric" placeholder="-135" value="' + esc(S.check.price) + '"></label><button class="xe-btn acc" type="submit">Check</button></form>' + res;
  }

  /* ------------------------------------------------------------ props */
  var STAT_LABEL = { pts: 'Points', reb: 'Rebounds', ast: 'Assists', fg3m: 'Threes made', stl: 'Steals', blk: 'Blocks', tov: 'Turnovers', fga: 'FG attempts', fg3a: '3-pt attempts', pra: 'Pts + Reb + Ast', pr: 'Pts + Reb', pa: 'Pts + Ast', ra: 'Reb + Ast' };
  function renderProps() {
    var P = S.data.props;
    if (!P) return banner('warn', '<b>No prop projections yet.</b> ' + esc(S.err.props || 'The props slate has not been built.') + ' Prop prices are not captured; when projections exist they are fair lines from the validated count distributions.');
    if (P.schema !== 'edgedesk_nba_props_slate_v1') return banner('err', '<b>Integrity refusal.</b> The props slate is not in the expected format.');
    var games = P.games || [];
    var gsel = '<div class="xe-seg" role="group" aria-label="Game">' + [['all', 'All games']].concat(games.map(function (g) { return [String(g.game_id), g.label]; })).map(function (x) { return '<button data-pg="' + esc(x[0]) + '" class="' + (S.propsGame === x[0] ? 'on' : '') + '">' + esc(x[1]) + '</button>'; }).join('') + '</div>';
    var ssel = '<div class="xe-seg" role="group" aria-label="Stat">' + Object.keys(STAT_LABEL).map(function (k) { return '<button data-ps="' + k + '" class="' + (S.propsStat === k ? 'on' : '') + '">' + esc(STAT_LABEL[k]) + '</button>'; }).join('') + '</div>';
    var rows = [];
    games.forEach(function (g) {
      if (S.propsGame !== 'all' && String(g.game_id) !== S.propsGame) return;
      g.players.forEach(function (pl) { var x = pl.stats[S.propsStat]; if (!x) return; rows.push('<tr><td>' + esc(pl.name) + ' <span class="xe-dim">' + esc(pl.team) + (pl.played_last_game === false ? ' · missed last game' : '') + '</span></td><td class="num">' + pct(pl.p_plays, 0) + '</td><td class="num">' + f1(pl.minutes) + '</td><td class="num">' + f1(x.mean) + '</td><td class="num">' + x.line + '</td><td class="num">' + pct(x.over) + '</td><td class="num">' + am(x.fair_over) + '</td><td class="num">' + am(x.fair_under) + '</td><td class="num">' + esc((x.p10_p90 || []).join('–')) + '</td></tr>'); });
    });
    var st = (P.status || {})[S.propsStat];
    return '<p class="xe-dim">' + esc(P.note) + '</p><div class="xe-ctl">' + gsel + '</div><div class="xe-ctl">' + ssel + '</div>' +
      (st ? '<p>' + stateChip(st.status, (st.failed || []).join('; ')) + ' <span class="xe-dim">' + esc(STAT_LABEL[S.propsStat]) + ': CRPS ' + st.crps + ' vs season average ' + st.baseline_crps + ', 80% coverage ' + pct(st.coverage_80) + ' on ' + st.n + ' held-out player-games.</span></p>' : '') +
      (rows.length ? table(esc(STAT_LABEL[S.propsStat]) + ' — fair lines, no prop prices captured', ['Player', 'P(plays)', 'Exp. min', 'Mean', 'Line', 'P(over)', 'Fair over', 'Fair under', '80% range'], rows) : '<div class="xe-empty">No players for this filter.</div>') +
      (P.status && P.status.availability ? '<p>' + stateChip(P.status.availability.status, (P.status.availability.failed || []).join('; ')) + ' <span class="xe-dim">P(plays): log loss ' + P.status.availability.log_loss + ' vs ' + P.status.availability.baseline_log_loss + ' for "same as last game", on ' + P.status.availability.n + ' held-out player-games.</span></p>' : '') +
      '<p class="xe-note">Lines are priced as if the player plays; a prop is void if he does not, and P(plays) is the separately validated chance that he does (no injury report is in it). Combined props (P+R+A and the pairs) use the correlated variance between the stats, never independent marginals.</p>';
  }

  /* ------------------------------------------------------------ record */
  function renderRecord() {
    var R = S.data.record;
    if (!R || R.schema !== 'edgedesk_nba_record_summary_v1') return banner('err', '<b>Integrity refusal.</b> The NBA record summary is not in the expected format.');
    var out = '<p>' + esc(R.protocol) + '</p>';
    out += '<p>' + stateChip(R.test_status === 'SEALED' ? 'SEALED' : 'OUTCOME_VALIDATED', R.test_note) + ' <span class="xe-dim">' + esc(R.test_note) + '</span> · leakage audit: ' + R.leakage.checked + ' predictions, ' + R.leakage.violations + ' violations.</p>';
    ['selection', 'test'].forEach(function (wn) {
      var w = R.windows[wn]; if (!w) return;
      if (w.status === 'SEALED') { out += '<div class="xe-sechd"><span>Test window ' + esc((R.window_ranges.test || []).join('–')) + '</span><span class="r">sealed</span></div><p class="xe-dim">Scored once, after every choice is frozen; every unsealing is logged with the specification\'s hash.</p>'; return; }
      out += table((wn === 'selection' ? 'Selection window ' : 'Test window ') + esc((R.window_ranges[wn] || []).join('–')) + ' <span class="xe-dim">(lower is better)</span>', ['Model', 'n', 'ML log loss', 'Brier', 'Cal. slope', 'Margin CRPS', 'Total CRPS', '1H margin CRPS', 'Ref-line MAE model / line'],
        Object.keys(w).map(function (id) { var x = w[id]; var chosen = id === R.choice.P || id === R.choice.C; return '<tr' + (chosen ? ' class="on"' : '') + '><td>' + esc(R.labels[id] || id) + (id === R.choice.P ? ' <span class="xe-dim">(chosen, projected)</span>' : id === R.choice.C ? ' <span class="xe-dim">(chosen, confirmed)</span>' : '') + '</td><td class="num">' + x.n + '</td><td class="num">' + x.ml_log_loss + '</td><td class="num">' + x.brier + '</td><td class="num">' + x.slope + '</td><td class="num">' + x.margin_crps + '</td><td class="num">' + x.total_crps + '</td><td class="num">' + (x.h1_margin_crps == null ? '—' : x.h1_margin_crps) + '</td><td class="num">' + (x.ref_model_mae == null ? '—' : x.ref_model_mae + ' / ' + x.ref_line_mae) + '</td></tr>'; }));
    });
    var c = R.comparisons || {};
    out += '<div class="xe-sechd"><span>Paired comparisons</span><span class="r">date-blocked bootstrap, 95% intervals; negative favours the chosen model</span></div><ul>' + Object.keys(c).map(function (k) { var x = c[k]; return '<li>' + esc(k.replace(/_/g, ' ')) + ': ' + (x.mean_diff > 0 ? '+' : '') + x.mean_diff + ' (' + x.ci95.join(' to ') + ', n ' + x.n + ')' + (x.a_better ? ' — chosen model better' : x.b_better ? ' — comparison better' : ' — not distinguishable') + '</li>'; }).join('') + '</ul>';
    out += '<div class="xe-sechd"><span>Markets</span></div>' + table('Status by market', ['Track', 'Market', 'Status', 'Against the close'], Object.keys(R.markets || {}).reduce(function (a, t) { Object.keys(R.markets[t]).filter(function (k) { return R.markets[t][k] && R.markets[t][k].market; }).forEach(function (k) { var m = R.markets[t][k]; a.push('<tr><td>' + esc(t) + '</td><td>' + esc(m.market) + '</td><td>' + stateChip(m.status, (m.failed || []).join('; ')) + '</td><td>' + stateChip(m.market_status, m.market_reason) + '</td></tr>'); }); return a; }, []));
    out += '<p class="xe-note">' + esc(R.reference_line_note) + '</p>';
    if (R.calibration_bins) out += table('Calibration of the chosen model (' + esc(R.calibration_window) + ')', ['Priced at', 'n', 'Model', 'Observed', '95%'], R.calibration_bins.map(function (b) { return '<tr><td>' + pct(b.lo, 0) + '–' + pct(b.hi, 0) + '</td><td class="num">' + b.n + '</td><td class="num">' + pct(b.mean_p) + '</td><td class="num">' + pct(b.observed) + '</td><td class="num">' + pct(b.wilson_low) + '–' + pct(b.wilson_high) + '</td></tr>'; }));
    if (R.ledger) out += '<div class="xe-sechd"><span>The live ledger</span><span class="r">prices frozen before tip, graded after</span></div><p>' + esc(R.ledger.summary) + '</p>';
    return out;
  }

  /* ------------------------------------------------------------ methods */
  function renderMethods() {
    var s = S.data.slate || {};
    var L = s.license || {};
    return '<div class="xe-sechd"><span>Data</span></div><ul class="xe-refs"><li>' + esc(L.sportsdataverse) + '</li><li>' + esc(L.nba_stats) + '</li><li>' + esc(L.odds) + '</li></ul>' +
      '<div class="xe-sechd"><span>Models</span></div><ul>' +
      '<li><b>A</b> Elo (FiveThirtyEight\'s NBA form) and Glicko (rating deviation), tuned on the selection window.</li>' +
      '<li><b>B</b> Opponent-adjusted efficiency, pace and the four factors (decayed weighted least squares).</li>' +
      '<li><b>C</b> Player impact: regularised adjusted plus-minus on reconstructed lineup stints × expected minutes, with availability.</li>' +
      '<li><b>D</b> A possession simulation with end-game fouling and overtime, anchored to B.</li>' +
      '<li><b>E</b> Ridge regression, ridge logistic and gradient-boosted trees on the point-in-time features.</li>' +
      '<li><b>F</b> A Bayesian dynamic model (Kalman filter) of each team\'s offence and defence, with its uncertainty.</li>' +
      '<li><b>G</b> A stacked ensemble of the above, fitted on out-of-sample predictions only.</li></ul>' +
      '<div class="xe-sechd"><span>Protocol</span></div><p>Every game is predicted 30 minutes before tip from games available by then. Each season\'s calibration is fitted on the three seasons before it; the model is chosen on 2008–2017; the 2018-on test window is sealed and every unsealing is logged. Every market comes from one distribution: a discretised normal reshaped by end-game weights oriented to the favourite, overtime with the favourite\'s measured edge.</p>' +
      '<div class="xe-sechd"><span>Limits</span></div><ul><li>Never tested against a closing market: no licensed archive of timestamped NBA prices exists here.</li><li>No injury report or confirmed lineup is in the published price; a team\'s first game uses last season\'s closing rotation.</li><li>Retrospective data: when a result was first published is unknown; a game is assumed known four hours after tip.</li><li>Prop lines are synthetic calibration probes; no historical prop prices are licensed.</li></ul><p class="xe-note">docs/engine/NBA.md has the full model card.</p>';
  }

  /* ------------------------------------------------------------ events */
  function wire(h) {
    h.onclick = function (e) {
      var t = e.target.closest ? e.target.closest('[data-act],[data-tab],[data-game],[data-pg],[data-ps]') : null; if (!t) return;
      if (t.dataset.act === 'refresh') { refresh(); return; }
      if (t.dataset.act === 'back') { S.open = null; setHash(null); render(); return; }
      if (t.dataset.act && t.dataset.act.indexOf('gfx-') === 0) { gfxAct(t.dataset.act, t.dataset.v); return; }
      if (t.dataset.tab) { S.tab = t.dataset.tab; render(); Promise.all(need().map(function (k) { return load(k); })).then(render); return; }
      if (t.dataset.pg) { S.propsGame = t.dataset.pg; render(); return; }
      if (t.dataset.ps) { S.propsStat = t.dataset.ps; render(); return; }
      if (t.dataset.game) { S.open = t.dataset.game; setHash(S.open); render(); try { h.scrollIntoView({ block: 'start' }); } catch (_) {} }
    };
    h.onsubmit = function (e) {
      var f = e.target; if (!f || f.dataset.form !== 'check') return;
      e.preventDefault(); S.check.market = f.market.value; S.check.price = String(f.price.value || '').trim().replace(/[−–]/g, '-'); render();
    };
  }
  function setHash(game) {
    try { var base = '#research/nba'; var want = game ? base + '/' + game : base; if (location.hash !== want) history.replaceState(null, '', want); } catch (_) {}
    try { if (W.edScreenSet) W.edScreenSet({ panel: 'nba', sport: 'basketball_nba', game_id: game || null }); } catch (_) {}
  }

  W.EDNbaUI = {
    show: show, refresh: refresh,
    hasData: function () { return !!S.data.slate; },
    openGame: function (id) { S.tab = 'games'; S.open = String(id); render(); },
    closeGame: function () { S.open = null; render(); },
    entityOpen: function () { return !!S.open; },
    entityKey: function () { return S.open; },
    freshness: function () { var d = S.data.slate; return { loadedAt: d ? Date.now() : null, builtAt: d ? Date.parse(d.generated_at) : null }; },
    _state: S
  };
})(typeof window !== 'undefined' ? window : this);
