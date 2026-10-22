/* ===========================================================================
   EdgeDesk NHL MATCHUP GRAPHIC — the football research graphic's template
   (lib/edgedesk_game_graphic.js), filled from one NHL game as
   hockey/slate.json priced it. Browser: window.EDNHLGraphic. Node: require().
   docs/engine/NHL.md §3b

   content(game, opts) → { ok, content } in the shape EDGameGraphic.layout
   draws, so the NHL picture is the football picture: the EdgeDesk lockup, both
   clubs as monogram badges in their colours, three model panels, a market or
   model-detail strip, what to watch for, and the footer.

   THE RULES (the football graphic's, applied to hockey)
     * Every number is the slate's own: the moneyline and its win
       probabilities, the fair total and the expected goals. The projected
       score is each club's expected goals including overtime and the shootout
       goal (regulation expectation + its chance of winning past 60 minutes,
       both the model's), at one decimal, adding to the expected total at one
       decimal. Nothing is re-estimated here.
     * The market strip appears only for a price captured in the last 180
       minutes from a named book, labelled as the reference it is. Otherwise
       the strip is EdgeDesk's own detail: the puck line, overtime and the
       goalies. Never an empty box, never a made-up price.
     * What to watch for is the model's own Shapley decomposition (the
       factors that move the win probability, largest first) and the goalie
       state; each line names its club and its size.
     * Research, not picks: the copy rule (EDGameGraphic.BANNED) runs over
       every string.
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EDNHLGraphic = factory();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var ROOT = typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : {});
  var N = { VERSION: 'edgedesk_nhl_graphic/1', TEMPLATE: 'nhl_matchup_v1', MARKET_LIVE_MIN: 180, WIN_EDGE_PP: 4, TOTAL_EDGE: 0.35 };
  N.BANNED = /(bet this|\blocks?\b|guarantee|\bsmash|must[- ]bet|can'?t lose|best bets?|winning plays?|free money|sure thing)/i;

  /* Team identity is presentation: a monogram in the club's colours (no logo:
     EdgeDesk holds no licence for one). [full name, nickname, fill, ring, text on fill] */
  N.TEAMS = {
    ANA: ['Anaheim Ducks', 'Ducks', '#F47A38', '#B9975B'], BOS: ['Boston Bruins', 'Bruins', '#1C1C1C', '#FFB81C'],
    BUF: ['Buffalo Sabres', 'Sabres', '#003087', '#FFB81C'], CAR: ['Carolina Hurricanes', 'Hurricanes', '#CE1126', '#A4A9AD'],
    CBJ: ['Columbus Blue Jackets', 'Blue Jackets', '#002654', '#CE1126'], CGY: ['Calgary Flames', 'Flames', '#C8102E', '#F1BE48'],
    CHI: ['Chicago Blackhawks', 'Blackhawks', '#CF0A2C', '#E8E8E8'], COL: ['Colorado Avalanche', 'Avalanche', '#6F263D', '#236192'],
    DAL: ['Dallas Stars', 'Stars', '#006847', '#8F8F8C'], DET: ['Detroit Red Wings', 'Red Wings', '#CE1126', '#FFFFFF'],
    EDM: ['Edmonton Oilers', 'Oilers', '#041E42', '#FF4C00'], FLA: ['Florida Panthers', 'Panthers', '#C8102E', '#B9975B'],
    LAK: ['Los Angeles Kings', 'Kings', '#1C1C1C', '#A2AAAD'], MIN: ['Minnesota Wild', 'Wild', '#154734', '#EAAA00'],
    MTL: ['Montréal Canadiens', 'Canadiens', '#AF1E2D', '#192168'], NJD: ['New Jersey Devils', 'Devils', '#CE1126', '#E8E8E8'],
    NSH: ['Nashville Predators', 'Predators', '#FFB81C', '#041E42', '#041E42'], NYI: ['New York Islanders', 'Islanders', '#00539B', '#F47D30'],
    NYR: ['New York Rangers', 'Rangers', '#0038A8', '#CE1126'], OTT: ['Ottawa Senators', 'Senators', '#C52032', '#C2912C'],
    PHI: ['Philadelphia Flyers', 'Flyers', '#F74902', '#E8E8E8'], PIT: ['Pittsburgh Penguins', 'Penguins', '#1C1C1C', '#FCB514'],
    SEA: ['Seattle Kraken', 'Kraken', '#001628', '#99D9D9'], SJS: ['San Jose Sharks', 'Sharks', '#006D75', '#EA7200'],
    STL: ['St. Louis Blues', 'Blues', '#002F87', '#FCB514'], TBL: ['Tampa Bay Lightning', 'Lightning', '#002868', '#E8E8E8'],
    TOR: ['Toronto Maple Leafs', 'Maple Leafs', '#00205B', '#E8E8E8'], UTA: ['Utah Mammoth', 'Mammoth', '#1C1C1C', '#6CACE4'],
    VAN: ['Vancouver Canucks', 'Canucks', '#00205B', '#00843D'], VGK: ['Vegas Golden Knights', 'Golden Knights', '#333F42', '#B4975A'],
    WPG: ['Winnipeg Jets', 'Jets', '#041E42', '#AC162C'], WSH: ['Washington Capitals', 'Capitals', '#C8102E', '#041E42']
  };
  var SEASON_LABEL = { R: 'REGULAR SEASON', P: 'PLAYOFFS', PR: 'PRESEASON' };

  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function str(x) { return x == null ? '' : String(x); }
  function up(x) { return str(x).toUpperCase(); }
  function am(v) { v = num(v); return v == null ? '—' : (v > 0 ? '+' : '−') + Math.abs(Math.round(v)); }
  function one(v) { return (Math.round(v * 10) / 10).toFixed(1); }

  /* whole percents that add to 100 (largest remainder), as the football graphic prints them */
  N.split100 = function (pHome) {
    var h = pHome * 100, a = 100 - h, fh = Math.floor(h), fa = Math.floor(a);
    if (fh + fa < 100) { if (h - fh >= a - fa) fh++; else fa++; }
    return { home: fh, away: fa };
  };
  /* each club's expected goals including overtime and the shootout goal: the
     regulation expectation plus its chance of winning past 60 minutes (one
     goal decides overtime; the shootout winner is credited one). In tenths
     that add to the expected total in tenths. */
  N.projectedGoals = function (g) {
    var P = g.prices || {}, ml = P.moneyline || {}, rg = P.regulation || {}, L = g.lambda || {};
    var lh = num(L.home), la = num(L.away);
    if (lh == null || la == null) return null;
    var eh = lh + Math.max(0, (num(ml.home) || 0) - (num(rg.home) || 0)), ea = la + Math.max(0, (num(ml.away) || 0) - (num(rg.away) || 0));
    var tot = P.total && num(P.total.expected) != null ? num(P.total.expected) : eh + ea;
    var want = Math.round(tot * 10), th = Math.floor(eh * 10), ta = Math.floor(ea * 10);
    while (th + ta < want) { if (eh * 10 - th >= ea * 10 - ta) th++; else ta++; }
    while (th + ta > want) { if (eh * 10 - th < ea * 10 - ta) th--; else ta--; }
    return { home: th / 10, away: ta / 10, exact: { home: eh, away: ea }, total: tot };
  };

  var ET = null;
  try { ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }); } catch (_) { ET = null; }
  N.dateText = function (iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return 'DATE TBA';
    if (!ET || typeof ET.formatToParts !== 'function') return new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    var p = {}; ET.formatToParts(new Date(t)).forEach(function (x) { p[x.type] = x.value; });
    return up(p.weekday + ', ' + p.month + ' ' + p.day) + ' • ' + p.hour + ':' + p.minute + ' ' + up(p.dayPeriod) + ' ET';
  };
  function GG() { if (ROOT.EDGameGraphic) return ROOT.EDGameGraphic; try { return require('./edgedesk_game_graphic.js'); } catch (_) { return null; } }
  function stamp(iso) { var G = GG(); return (G && G.stamp ? G.stamp(iso) : null) || str(iso).slice(0, 16).replace('T', ' ') + ' UTC'; }

  N.team = function (abbr, opts) {
    var T = N.TEAMS[abbr] || [abbr, abbr, '#3b4a6b', '#8aa0c8'], rec = opts && opts.records ? opts.records[abbr] : null;
    return { name: up(T[0]), short: up(T[1]), abbr: up(abbr), color: T[2], alt: T[3], on: T[4] || '#ffffff', bar: lum(T[2]) < 0.08 ? T[3] : T[2], record: rec ? '(' + rec + ')' : '', rank: '' };
  };
  function rgb(h) { h = str(h).replace('#', ''); return /^[0-9a-f]{6}$/i.test(h) ? [0, 2, 4].map(function (i) { return parseInt(h.substr(i, 2), 16) / 255; }) : [0.3, 0.3, 0.4]; }
  function lum(h) { var c = rgb(h).map(function (v) { return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
  function near(a, b) { var x = rgb(a), y = rgb(b); return Math.abs(x[0] - y[0]) + Math.abs(x[1] - y[1]) + Math.abs(x[2] - y[2]) < 0.35; }
  N._lum = lum;

  /* what to watch for: the decomposition's largest factors, each from the side it helps */
  function factorInsight(f, g, H, A) {
    var pp = num(f.pp);
    if (pp == null || Math.abs(pp) < 0.5) return null;
    var helps = pp >= 0 ? H : A, size = Math.abs(pp).toFixed(1) + '%', who = f.side === 'home' ? H : f.side === 'away' ? A : null;
    var ev = f.evidence || {}, vl = ev.vs_league, kind = String(f.key || '').replace(/^(home|away)_/, '');
    var worth = '+' + size + ' win chance for the ' + cap(helps.short);
    if (kind === 'ice') return { icon: 'home', title: 'HOME ICE', text: 'Playing at home: ' + worth };
    if (kind === 'rest' && who) return { icon: 'clock', title: 'REST', text: cap(who.short) + (num(vl) ? ' on a back-to-back: ' : ' rest edge: ') + worth };
    if (kind === 'ev_off' && who && num(vl) != null) return { icon: 'bars', title: '5V5 CHANCE CREATION', text: cap(who.short) + ' create ' + num(vl).toFixed(2) + '× the league’s 5v5 chances: ' + worth };
    if (kind === 'ev_def' && who && num(vl) != null) return { icon: 'shield', title: '5V5 DEFENCE', text: cap(who.short) + ' allow ' + num(vl).toFixed(2) + '× the league’s 5v5 chances: ' + worth };
    if (kind === 'results' && who && Array.isArray(vl) && vl.length >= 2) return { icon: 'net', title: 'RESULTS & FINISHING', text: cap(who.short) + ' score ' + num(vl[0]).toFixed(2) + '× and allow ' + num(vl[1]).toFixed(2) + '× league goals: ' + worth };
    return { icon: 'puck', title: up(str(f.label).split(' (')[0]), text: (who ? cap(who.short) + ': ' : '') + worth };
  }
  function cap(t) { t = str(t).toLowerCase(); return t.replace(/(^|[\s-])([a-zé])/g, function (m, a, b) { return a + b.toUpperCase(); }); }
  function goalieInsight(g, H, A) {
    var G0 = g.goalies || {}, cert = str(G0.certainty);
    var lead = function (side) { var l = (G0[side] || []).slice().sort(function (x, y) { return (num(y.p_start) || 0) - (num(x.p_start) || 0); })[0]; return l ? str(l.name).replace(/^.*\.\s*/, '') : null; };
    var ha = lead('home'), aa = lead('away');
    if (!ha && !aa) return null;
    var pair = (aa ? A.abbr + ' ' + aa : '') + (aa && ha ? ' · ' : '') + (ha ? H.abbr + ' ' + ha : '');
    if (/CONFIRMED/.test(cert) && !/UN/.test(cert)) return { icon: 'shield', title: 'GOALIES', text: 'Confirmed: ' + pair };
    var sc = (G0.scenarios || []).map(function (x) { return num(x.p_home); }).filter(function (x) { return x != null; });
    var lo = sc.length > 1 ? Math.round(Math.min.apply(null, sc) * 100) : null, hi = sc.length > 1 ? Math.round(Math.max.apply(null, sc) * 100) : null;
    var rng = lo != null ? '; ' + H.abbr + ' ' + (lo === hi ? lo + '%' : lo + '–' + hi + '%') + ' across pairings' : '';
    return { icon: 'shield', title: 'GOALIES', text: 'Unconfirmed. Likeliest ' + pair + rng };
  }

  function marketStrip(mk, g, H, A, now) {
    if (!mk || !mk.book) return null;
    var t = Date.parse(mk.captured_at);
    /* the nearest price on file, whatever its age: an older one is the last known market, with its time */
    var start = Date.parse(g.start_utc);
    if (!isFinite(t) || t > now + 5 * 60000 || (isFinite(start) && t >= start)) return null;
    var ml = mk.moneyline || {}, tot = mk.total || {}, pl = mk.puck_line || mk.spread || null, old = now - t > N.MARKET_LIVE_MIN * 60000, edge = [];
    var out = { title: old ? 'LAST KNOWN MARKET' : 'MARKET SNAPSHOT', state: old ? 'STALE' : 'LIVE', meta: mk.book + (mk.source === 'espn_scoreboard' ? ' via ESPN · reference' : '') + ' · ' + stamp(mk.captured_at), vs: [] };
    if (num(ml.home) != null && num(ml.away) != null) {
      out.home_ml = am(ml.home); out.away_ml = am(ml.away);
      var ih = imp(ml.home), ia = imp(ml.away);
      if (ih && ia) {
        var nv = N.split100(ih / (ih + ia));
        out.no_vig = { home: nv.home + '%', away: nv.away + '%' };
        var mine = N.split100(num(g.prices.moneyline.home)), favH = mine.home >= 50;
        var who = favH ? H.abbr : A.abbr;
        out.vs.push('Win %: EdgeDesk ' + who + ' ' + (favH ? mine.home : mine.away) + '% · market ' + (favH ? nv.home : nv.away) + '%');
        var dh = mine.home - nv.home;
        if (Math.abs(dh) >= N.WIN_EDGE_PP) edge.push((dh > 0 ? H.abbr + ' ML ' + am(ml.home) : A.abbr + ' ML ' + am(ml.away)));
      }
    }
    if (num(tot.point) != null) {
      out.total = one(num(tot.point));
      if (num(tot.over) != null && num(tot.under) != null) out.total_prices = 'O ' + am(tot.over) + ' · U ' + am(tot.under);
      out.vs.push('Total: EdgeDesk ' + num(g.prices.total.expected).toFixed(2) + ' goals vs ' + one(num(tot.point)));
      var tg = num(g.prices.total.expected) - num(tot.point);
      if (Math.abs(tg) >= N.TOTAL_EDGE) edge.push((tg > 0 ? 'OVER ' : 'UNDER ') + one(num(tot.point)));
    }
    if (pl && num(pl.home_line) != null && pl.home != null && pl.away != null) {
      out.home_spread = (num(pl.home_line) > 0 ? '+' : '−') + Math.abs(num(pl.home_line)).toFixed(1) + ' ' + am(pl.home);
      out.away_spread = (num(pl.home_line) > 0 ? '−' : '+') + Math.abs(num(pl.home_line)).toFixed(1) + ' ' + am(pl.away);
    }
    if (!out.home_ml && !out.total && !out.home_spread) return null;
    out.note = 'A REFERENCE PRICE · NOT A VERIFIED QUOTE';
    out.edge = edge.length ? edge.join(' · ') : null;
    return out;
  }
  function imp(a) { a = num(a); if (a == null || (a > -100 && a < 100)) return null; return a > 0 ? 100 / (a + 100) : -a / (-a + 100); }

  /**
   * game: one hockey/slate.json game. opts: { now, generated_at (the slate's),
   * model_id, records: { ABBR: 'W-L-OTL' }, market (a captured price: book,
   * captured_at, moneyline, total), grade (lib/edgedesk_grade_ui entry),
   * frozen_at (a started game: the slate that last priced it) }
   */
  N.content = function (g, opts) {
    opts = opts || {};
    if (!g || !g.home || !g.away || !g.prices || !g.prices.moneyline) return { ok: false, reason: 'no_spec', message: 'EdgeDesk holds no NHL price for this game.' };
    var now = num(opts.now) || Date.now(), H = N.team(g.home, opts), A = N.team(g.away, opts);
    if (near(A.bar, H.bar)) A.bar = A.bar === A.alt ? A.color : A.alt;
    if (near(A.bar, H.bar) || lum(A.bar) < 0.03) A.bar = '#9aa6bf';
    var ml = g.prices.moneyline, pH = num(ml.home), wp = N.split100(pH), favH = pH >= 0.5, F = favH ? H : A;
    var goals = N.projectedGoals(g);
    var tot = g.prices.total || {}, start = Date.parse(g.start_utc), started = !!opts.frozen_at || (isFinite(start) && now >= start);
    var c = {
      template: N.TEMPLATE, league: 'nhl', league_label: 'NHL', week_label: SEASON_LABEL[g.type] || '', surface: 'ice',
      snapshot_id: null, away: A, home: H,
      date: N.dateText(g.start_utc), venue: up(g.venue || ''), context: '',
      started: started, model_available: true, reason: null,
      labels: { left: 'FAIR MONEYLINE', center: 'PROJECTED SCORE', center_sub: 'EXPECTED GOALS · OT INCLUDED', right: 'FAIR TOTAL', market_spread: 'PUCK LINE' },
      spread_team: F.short, spread_value: am(favH ? ml.fair_home : ml.fair_away), spread_text: F.abbr + ' ' + am(favH ? ml.fair_home : ml.fair_away),
      win: { away: wp.away + '%', home: wp.home + '%', away_pct: wp.away, home_pct: wp.home }, fav_side: favH ? 'home' : 'away',
      scores: goals ? { away: goals.away.toFixed(1), home: goals.home.toFixed(1), big: true } : { away: '—', home: '—', big: true },
      total: num(tot.fair_line) != null ? one(num(tot.fair_line)) : '—',
      total_sub: { label: 'EXPECTED GOALS', text: num(tot.expected) != null ? num(tot.expected).toFixed(2) + ' GOALS' : null },
      points: goals ? { away: goals.away.toFixed(1), home: goals.home.toFixed(1) } : { away: '—', home: '—' }
    };
    /* the strip: a recent named-book price, or EdgeDesk's own detail */
    c.market = marketStrip(opts.market, g, H, A, now);
    if (c.market && c.market.edge) c.edge = { headline: c.market.edge };
    if (!c.market) {
      var pl = g.prices.puck_line || {}, cells = [];
      cells.push({ k: 'MODEL PUCK LINE', v: favH ? [H.abbr + ' −1.5 ' + am(pl.fair_home_minus_1_5), A.abbr + ' +1.5 ' + am(pl.fair_away_plus_1_5)] : [A.abbr + ' −1.5 ' + am(pl.fair_away_minus_1_5), H.abbr + ' +1.5 ' + am(pl.fair_home_plus_1_5)], s: 'model estimate · not a price' });
      if (num(g.prices.p_overtime) != null) cells.push({ k: 'PAST 60 MINUTES', v: ['OT ' + Math.round(g.prices.p_overtime * 100) + '%', 'SHOOTOUT ' + Math.round((num(g.prices.p_shootout) || 0) * 100) + '%'], s: 'chance the game is tied after regulation' });
      var reg = g.prices.regulation;
      if (reg && num(reg.draw) != null) cells.push({ k: '60-MINUTE RESULT', v: [A.abbr + ' ' + Math.round(reg.away * 100) + '% · TIE ' + Math.round(reg.draw * 100) + '%', H.abbr + ' ' + Math.round(reg.home * 100) + '%'], s: 'regulation only' });
      c.detail = { title: 'EDGEDESK MODEL DETAIL', note: 'No recent sportsbook price is shown. Every number here is EdgeDesk’s own.', cells: cells.slice(0, 3) };
    }
    var fs = ((g.explanation && g.explanation.factors) || []).slice().sort(function (x, y) { return Math.abs(num(y.pp) || 0) - Math.abs(num(x.pp) || 0); });
    var ins = [];
    fs.forEach(function (f) { if (ins.length < 3) { var i = factorInsight(f, g, H, A); if (i) ins.push(i); } });
    var gi = goalieInsight(g, H, A); if (gi) ins.push(gi);
    c.insights = ins.slice(0, 4);
    var gr = opts.grade;
    c.confidence = gr && gr.letter && gr.letter !== 'INSUFFICIENT' ? 'RESEARCH GRADE ' + gr.letter + ' · ' + gr.score + '/100' : 'MONEYLINE: OUTCOME VALIDATED';
    if (!(gr && gr.letter) && opts.validation) c.confidence = 'MONEYLINE: ' + up(str(opts.validation).replace(/_/g, ' '));
    var dq = g.data_quality && (g.data_quality.status || g.data_quality.state);
    c.status = started ? 'PREGAME SNAPSHOT · RESEARCH ONLY' : (/FAULT/i.test(str(dq)) ? 'DATA FAULT · RESEARCH ONLY' : 'MODEL: ACTIVE · RESEARCH ONLY');
    c.status_tone = /FAULT/i.test(str(dq)) ? 'fault' : 'ok';
    c.fault = null;
    var built = opts.frozen_at || opts.generated_at;
    c.snapshot_line = (started ? 'PREGAME SNAPSHOT · ' : 'SNAPSHOT ') + (built ? stamp(built) : '') + (opts.model_id ? ' · ' + opts.model_id : '') + ' · edgedesksports.com';
    c.tagline = 'RESEARCH NOT PICKS.';
    c.alt = 'EdgeDesk research graphic: ' + cap(A.name) + ' at ' + cap(H.name) + ', ' + c.date + '. EdgeDesk projects ' + cap(A.short) + ' ' + c.scores.away + ', ' + cap(H.short) + ' ' + c.scores.home
      + ' (expected goals); fair moneyline ' + c.spread_text + '; model win probability ' + cap(A.short) + ' ' + c.win.away + ', ' + cap(H.short) + ' ' + c.win.home + '; fair total ' + c.total + '. '
      + (c.market ? 'Market snapshot (' + c.market.meta + '): ' + (c.market.home_ml ? H.abbr + ' ' + c.market.home_ml + ', ' + A.abbr + ' ' + c.market.away_ml : '') + (c.market.total ? ', total ' + c.market.total : '') + '. ' : '')
      + (c.insights.length ? 'What to watch: ' + c.insights.map(function (i) { return i.text; }).join('; ') + '. ' : '') + c.confidence + '. Research, not picks.';
    var strings = [];
    (function walk(v) { if (v == null) return; if (typeof v === 'string') strings.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (typeof v === 'object') Object.keys(v).forEach(function (k) { walk(v[k]); }); })(c);
    if (strings.some(function (t) { return N.BANNED.test(t); })) return { ok: false, reason: 'copy_rule', message: 'This graphic would break EdgeDesk’s research-only wording rules, so it is not made.' };
    return { ok: true, content: c };
  };
  /* the cache key: the slate that priced the game, the price shown, the grade */
  N.key = function (g, opts) {
    opts = opts || {};
    var mk = opts.market && opts.market.captured_at ? [opts.market.book, opts.market.captured_at].join('/') : 'model-only';
    return [N.TEMPLATE, g && g.game_id, opts.frozen_at || opts.generated_at || '', mk, opts.grade ? opts.grade.letter + opts.grade.score : '', (opts.records ? JSON.stringify(opts.records) : '')].join('|');
  };
  N.fileName = function (c, format) {
    function slug(t) { return str(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
    return 'edgedesk-nhl-' + slug(c.away.short) + '-at-' + slug(c.home.short) + '-' + (format || 'square') + '.png';
  };
  /* browser: draw it with the football renderer (layout, canvas, PNG, cache) */
  N.render = function (g, opts, format) {
    var G = GG();
    if (!G || !G.renderContent) return Promise.reject({ ok: false, message: 'the graphic renderer is not loaded' });
    var ct = N.content(g, opts);
    if (!ct.ok) return Promise.reject(ct);
    return G.renderContent(ct.content, N.key(g, opts), format, { now: opts && opts.now }).then(function (r) { r.file_name = N.fileName(ct.content, r.format); return r; });
  };
  N.GG = GG;
  return N;
});
