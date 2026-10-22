/* ===========================================================================
   EdgeDesk MATCHUP GRAPHIC — the shareable research graphic for one NFL or
   college football game, drawn from one research snapshot.
   Browser: window.EDGameGraphic. Node: require('./edgedesk_game_graphic.js').
   docs/game-research/README.md

   DETERMINISTIC, IN THREE STEPS (only the last touches a canvas)
     content(spec, market)    the words and numbers, from ONE snapshot's
                              graphic spec (EDGameSnapshot.graphicSpec) and,
                              optionally, ONE current market quote
     layout(content, format)  where each piece goes, as plain draw operations
     draw(canvas, layout)     paints them
   No image model, no template per game, nothing typed by hand: the same
   snapshot always gives the same picture, so any historical graphic can be
   drawn again from the history ledger.

   ANOTHER SPORT uses the same template through renderContent(content, key,
   format): its own module builds the content (lib/edgedesk_nhl_graphic.js,
   lib/edgedesk_nba_graphic.js), naming its panels (content.labels), its
   surface ('ice' draws a rink, 'court' a basketball court, not yard lines)
   and a bar colour the dark card shows. Without those fields the picture is
   football's, unchanged.

   THE RULES
     * Every number is the snapshot's own (model) or the quote's own (market),
       already rounded once by lib/edgedesk_calc.js. The graphic computes no
       probability and invents no statistic.
     * The model's spread, total and score print from the spec's display
       block (lib/edgedesk_football_lines.js: half points, PK, whole-number
       scores). A spec recorded before that block existed redraws with the
       numbers it was published with. A sportsbook line prints as received,
       and a model-versus-market gap is the unrounded projection against it.
     * The market panel appears only when the quote is LIVE (fresh, named
       book, capture time). Otherwise the space carries EdgeDesk's own model
       detail. There is never an empty box and never a made-up price.
     * Kalshi (opts.kalshi, EDGameSnapshot.kalshi): where Kalshi's own display
       rule trusted a team's YES mid and the team was resolved onto this
       game's teams, the strip is EDGEDESK vs MARKET: the live book's spread
       and total and each team's win % · ML, EdgeDesk over the market over
       the difference. EdgeDesk's row is unrounded and the market's as
       received, so each difference is the two numbers above it. A side
       without a trusted mid has no column; nothing is derived from the other.
     * Labels say what a number is: a spread is a line, not a win chance; a
       market probability is "no-vig", never "model"; reliability is out of
       100, never a percent; the model moneyline is "a model estimate, not a
       price".
     * Research, not picks: no "bet", "lock" or "play" anywhere; the copy rule
       (EDPersonal.BANNED) is applied to every string.
     * Team identity is presentation: a monogram badge in the team's colours.
       No team logo or helmet is drawn: EdgeDesk holds no licence for them
       (opts.logos is reserved for licensed assets and is off).
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EDGameGraphic = factory();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var G = { VERSION: 'edgedesk_game_graphic/1', TEMPLATE: 'matchup_v1' };
  G.FORMATS = {
    square: { w: 1080, h: 1080, label: 'Square · 1080×1080' },
    portrait: { w: 1080, h: 1350, label: 'Portrait · 1080×1350' }
  };
  G.SITE = 'edgedesksports.com';
  G.TAGLINE = 'RESEARCH NOT PICKS.';
  G.K = {
    bg0: '#040814', bg1: '#0a1636', bg2: '#070d22', panel: 'rgba(8,16,40,0.86)', panel2: 'rgba(14,28,66,0.92)', strip: 'rgba(18,40,92,0.95)',
    cyan: '#2ad4ff', blue: '#3b82f6', magenta: '#e040fb', violet: '#8b5cf6',
    text: '#ffffff', dim: '#c3cfea', faint: '#8693b8', line: 'rgba(130,160,230,0.28)',
    green: '#4ade80', warn: '#fbbf24', fault: '#f87171', gold: '#facc15', ink: '#0b1020'
  };
  G.DISPLAY = '"Barlow Condensed", "Roboto Condensed", "Arial Narrow", Arial, sans-serif';
  G.BODY = 'Inter, "Helvetica Neue", Arial, sans-serif';
  G.BANNED = /(bet this|\blocks?\b|guarantee|\bsmash|must[- ]bet|can'?t lose|best bets?|winning plays?|free money|sure thing)/i;
  G.REASON_TEXT = {
    no_spec: 'EdgeDesk holds no research snapshot for this game.',
    copy_rule: 'This graphic would break EdgeDesk’s research-only wording rules, so it is not made.'
  };
  G.FAULT_TEXT = {
    scores_reconcile: 'PROJECTED SCORES DO NOT MATCH THE SPREAD AND TOTAL',
    headline_scores_within_tolerance: 'ROUNDED SCORES DRIFT FROM THE SPREAD AND TOTAL',
    win_probabilities_sum: 'WIN PROBABILITIES DO NOT ADD TO 100%',
    win_display_sums_100: 'WIN PROBABILITIES DO NOT ADD TO 100%',
    winner_agrees: 'WIN PROBABILITY AND SPREAD NAME DIFFERENT FAVOURITES',
    model_moneyline_restates_probability: 'MODEL MONEYLINE DOES NOT MATCH THE WIN PROBABILITY',
    total_plausible: 'FAIR TOTAL OUTSIDE THE PLAUSIBLE RANGE',
    range_contains_projection: 'OUTCOME RANGE DOES NOT CONTAIN THE PROJECTION',
    ranks_in_range: 'A UNIT RANK FALLS OUTSIDE ITS LEAGUE'
  };
  G.BOOKS = { draftkings: 'DraftKings', fanduel: 'FanDuel', betmgm: 'BetMGM', williamhill_us: 'Caesars', caesars: 'Caesars', espnbet: 'ESPN BET', fanatics: 'Fanatics',
    betrivers: 'BetRivers', hardrockbet: 'Hard Rock Bet', pinnacle: 'Pinnacle', circasports: 'Circa Sports', bovada: 'Bovada', betonlineag: 'BetOnline', lowvig: 'LowVig' };

  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function str(x) { return x == null ? '' : String(x); }
  function up(x) { return str(x).toUpperCase(); }
  function signed(v, dp) { v = num(v); if (v == null) return '—'; if (v === 0) return 'PK'; return (v > 0 ? '+' : '−') + Math.abs(v).toFixed(dp == null ? 1 : dp); }
  /* a sportsbook number as received: at least one decimal, never rounded */
  function exact(v) { var t = String(Math.round(Math.abs(v) * 1000) / 1000); return t.indexOf('.') < 0 ? t + '.0' : t; }
  function signedExact(v) { v = num(v); if (v == null) return '—'; if (v === 0) return 'PK'; return (v > 0 ? '+' : '−') + exact(v); }
  /* a gap in integer tenths, each side rounded half away from zero first,
     exactly as lib/edgedesk_calc.js computes it */
  function t10(x) { return Math.round(Math.floor(Math.abs(x) * 10 + 0.5 + 1e-9) * (x < 0 ? -1 : 1)); }
  function gapOf(a, b) { var v = (t10(a) - t10(b)) / 10; return v === 0 ? 0 : v; }
  G.ROUNDING_NOTE = '½-POINT FAIR LINES · GAPS UNROUNDED';
  function am(v) { v = num(v); return v == null ? '—' : (v > 0 ? '+' : '−') + Math.abs(Math.round(v)); }
  function pct(p) { p = num(p); return p == null ? '—' : Math.round(p * 100) + '%'; }

  var ET = null;
  try { ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short' }); } catch (_) { ET = null; }
  G.stamp = function (iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return null;
    if (!ET || typeof ET.formatToParts !== 'function') return new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    var p = {}; ET.formatToParts(new Date(t)).forEach(function (x) { p[x.type] = x.value; });
    return p.month + ' ' + p.day + ', ' + p.hour + ':' + p.minute + ' ' + str(p.dayPeriod).toUpperCase() + ' ' + (/^E[DS]T$/.test(p.timeZoneName) ? 'ET' : p.timeZoneName);
  };
  /* the time alone ("6:40 PM ET"), for a price taken on the graphic's own day */
  G.clock = function (iso) { var s = G.stamp(iso); return s ? s.replace(/^[A-Z][a-z]{2} \d{1,2}, /, '') : null; };
  function bookName(b) { b = str(b); var k = b.toLowerCase().replace(/[^a-z_]/g, ''); return G.BOOKS[k] || b; }

  /* ================================================================ CONTENT */
  G.content = function (spec, market, opts) {
    opts = opts || {};
    if (!spec || !spec.home || !spec.away) return { ok: false, reason: 'no_spec', message: G.REASON_TEXT.no_spec };
    var M = spec.model || {}, H = spec.home, A = spec.away;
    var leagueLabel = spec.league === 'nfl' ? 'NFL' : 'COLLEGE FOOTBALL';
    var now = num(opts.now) || Date.now(), ko = Date.parse(spec.kickoff);
    var c = {
      template: G.TEMPLATE, league: spec.league, league_label: leagueLabel, week_label: up(spec.week_label || ''),
      snapshot_id: spec.snapshot_id || null,
      away: team(A), home: team(H),
      date: spec.kickoff_text ? up(spec.kickoff_text.date) + (spec.kickoff_text.time ? ' • ' + up(spec.kickoff_text.time) : '') : 'DATE TBA',
      venue: up(spec.venue || ''), context: up(spec.neutral_site ? (spec.context ? spec.context + ' · neutral site' : 'Neutral site') : (spec.context || '')),
      started: isFinite(ko) && now >= ko,
      model_available: !!M.available,
      reason: M.available ? null : (M.reason || 'the model has no projection for this game')
    };
    function team(t) {
      return { name: up(t.name), short: up(t.short || t.name), abbr: up(t.abbr || ''), color: t.color || '#3b4a6b', alt: t.alt_color || '#8aa0c8', on: t.on_color || '#ffffff',
        record: t.record ? '(' + t.record + ')' : '', rank: num(t.poll_rank) != null ? '#' + t.poll_rank : '' };
    }
    if (M.available) {
      var D = M.display || null;
      var fav = D ? D.spread.favorite : M.fair.favorite, favT = fav ? (fav === 'home' ? H : A) : null;
      var hs = D ? { home: String(D.score.home), away: String(D.score.away), whole: true } : (M.headline_scores || { home: String(M.scores.home), away: String(M.scores.away) });
      c.spread_team = favT ? up(favT.short || favT.name) : 'PICK’EM';
      c.spread_value = D ? D.spread.line_text : (fav ? '−' + Math.abs(M.fair.display).toFixed(1) : 'PK');
      c.spread_text = D ? D.spread.text : M.fair.text;
      c.win = { away: M.win_display.away, home: M.win_display.home, away_pct: M.win_display.away_pct, home_pct: M.win_display.home_pct };
      c.fav_side = fav;
      c.scores = { away: hs.away, home: hs.home, whole: hs.whole !== false };
      c.total = D ? D.total.text : M.total.toFixed(1);
      c.points = { away: num(M.scores.away).toFixed(M.scores.decimals === 2 ? 2 : 1), home: num(M.scores.home).toFixed(M.scores.decimals === 2 ? 2 : 1) };
      /* under the fair total: the unrounded total beside a half-point display;
         the reconciled points on a spec published before it */
      c.total_sub = D ? { label: 'UNROUNDED PROJECTION', text: D.total.raw_text + ' PTS' } : { label: 'PROJECTED POINTS', text: null };
      c.fair_ml = { away: am(M.fair_ml.away), home: am(M.fair_ml.home) };
      c.range = M.range80 ? rangeAbbr(M.range80.lo, M.range80.hi, c.away.abbr, c.home.abbr) : null;
      c.range_text = c.range ? c.range.join(' ') : null;
    }
    /* the market strip: a LIVE quote only */
    var mk = market && market.current && market.state === 'LIVE' ? market : null;
    if (mk && M.available) {
      var hl = num(mk.home_line), tot = num(mk.total);
      c.market = {
        title: 'CURRENT MARKET',
        meta: [mk.book ? bookName(mk.book) : (mk.books ? mk.books + ' books' : 'captured quote'), mk.captured_at ? 'captured ' + G.stamp(mk.captured_at) : null].filter(Boolean).join(' · '),
        away_spread: hl != null ? (D ? signedExact(hl === 0 ? 0 : -hl) : signed(hl === 0 ? 0 : -hl)) : null, home_spread: hl != null ? (D ? signedExact(hl) : signed(hl)) : null,
        total: tot != null ? (D ? exact(tot) : tot.toFixed(1)) : null,
        away_ml: num(mk.ml_away) != null ? am(mk.ml_away) : null, home_ml: num(mk.ml_home) != null ? am(mk.ml_home) : null,
        no_vig: null, vs: []
      };
      if (num(mk.ml_home) != null && num(mk.ml_away) != null) {
        var ih = impl(mk.ml_home), ia = impl(mk.ml_away);
        if (ih && ia) c.market.no_vig = { away: pct(ia / (ia + ih)), home: pct(ih / (ia + ih)) };
      }
      if (hl != null && D) {
        /* the unrounded projection against the line as received */
        var sg = gapOf(-M.home_margin, hl), shown = Math.abs(Math.round((num(D.spread.home_line) - hl) * 100) / 100);
        c.market.vs.push(sg === 0 ? 'Spread: EdgeDesk and the market agree' : 'Spread: EdgeDesk ' + Math.abs(sg).toFixed(1) + ' pts toward ' + (sg < 0 ? c.home.abbr : c.away.abbr));
        if (Math.abs(shown - Math.abs(sg)) > 1e-9) c.market.note = G.ROUNDING_NOTE;
      } else if (hl != null) {
        var fair = Math.round(-M.home_margin * 10) / 10, mkt = Math.round(hl * 10) / 10;
        var gap = Math.abs(Math.round(fair * 10) - Math.round(mkt * 10)) / 10;
        c.market.vs.push(gap < 0.05 ? 'Spread: EdgeDesk and the market agree' : 'Spread: EdgeDesk ' + gap.toFixed(1) + ' pts toward ' + (fair < mkt ? c.home.abbr : c.away.abbr));
      }
      if (tot != null && D) {
        var te = num(M.total_exact) != null ? num(M.total_exact) : M.total, tg2 = gapOf(te, tot), tshown = Math.abs(Math.round((num(D.total.value) - tot) * 100) / 100);
        c.market.vs.push(tg2 === 0 ? 'Total: EdgeDesk and the market agree' : 'Total: EdgeDesk ' + Math.abs(tg2).toFixed(1) + ' pts ' + (tg2 > 0 ? 'higher' : 'lower'));
        if (Math.abs(tshown - Math.abs(tg2)) > 1e-9) c.market.note = G.ROUNDING_NOTE;
      } else if (tot != null) {
        var tg = (Math.round(M.total * 10) - Math.round(tot * 10)) / 10;
        c.market.vs.push(tg === 0 ? 'Total: EdgeDesk and the market agree' : 'Total: EdgeDesk ' + Math.abs(tg).toFixed(1) + ' pts ' + (tg > 0 ? 'higher' : 'lower'));
      }
    }
    /* Kalshi: each team's YES mid, already placed on this game's teams, and
       EDGEDESK vs MARKET, the table that sets EdgeDesk beside it: one column
       per market (the live book's spread and total, Kalshi's price for each
       team), three rows (EdgeDesk, the market, the difference). EdgeDesk's
       numbers are its unrounded projection at one decimal and the market's
       are as received, so every difference is the subtraction of the two
       numbers printed above it. */
    var ks = opts.kalshi && opts.kalshi.state === 'OK' && opts.kalshi.current ? opts.kalshi : null;
    if (ks && M.available && (ks.away || ks.home)) {
      var kt = ks.snapshot_at ? G.clock(ks.snapshot_at) : null;
      c.kalshi = { close: !!ks.close, time: kt, away: ks.away ? ks.away.text : null, home: ks.home ? ks.home.text : null };
      var cmp = [], one = function (x) { return (t10(x) / 10).toFixed(1); };
      var fav = function (homeLine, txt) { return homeLine === 0 ? 'PK' : (homeLine > 0 ? c.away.abbr : c.home.abbr) + ' −' + txt(Math.abs(homeLine)); };
      if (mk && num(mk.home_line) != null) {
        var mh = num(mk.home_line), eh = -M.home_margin, sgap = gapOf(eh, mh);
        cmp.push({ head: 'SPREAD', ed: fav(t10(eh) === 0 ? 0 : eh, one), mk: fav(mh, exact),
          diff: sgap === 0 ? 'EVEN' : Math.abs(sgap).toFixed(1) + ' TOWARD ' + (sgap < 0 ? c.home.abbr : c.away.abbr) });
      }
      if (mk && num(mk.total) != null) {
        var mt = num(mk.total), et = num(M.total_exact) != null ? num(M.total_exact) : M.total, tgap = gapOf(et, mt);
        cmp.push({ head: 'TOTAL', ed: one(et), mk: exact(mt), diff: tgap === 0 ? 'EVEN' : Math.abs(tgap).toFixed(1) + (tgap > 0 ? ' HIGHER' : ' LOWER') });
      }
      ['away', 'home'].forEach(function (k) {
        var s = ks[k], pm = M.win_prob ? num(M.win_prob[k]) : null;
        if (!s || pm == null) return;
        var d = (t10(pm * 100) - t10(s.mid * 100)) / 10;
        cmp.push({ head: c[k].abbr + ' WIN % · ML', win: true, ed: one(pm * 100) + '%  ' + c.fair_ml[k], mk: one(s.mid * 100) + '%  ' + am(s.ml),
          diff: d === 0 ? 'EVEN' : Math.abs(d).toFixed(1) + ' PP ' + (d > 0 ? 'HIGHER' : 'LOWER') });
      });
      var src = mk ? (mk.book ? bookName(mk.book) : (mk.books ? mk.books + ' books' : 'captured quote')) : null;
      /* the market row says which market and when: "DRAFTKINGS 7:32 · KALSHI 7:43 PM ET" */
      var bookAt = mk && mk.captured_at ? G.clock(mk.captured_at) : null, mrow = [];
      if (src) mrow.push(up(src) + (bookAt ? ' ' + (kt && bookAt.slice(-5) === kt.slice(-5) ? bookAt.slice(0, -6) : bookAt) : ''));
      mrow.push((ks.close ? 'KALSHI CLOSE' : 'KALSHI') + (kt ? ' ' + kt : ''));
      c.compare = {
        title: mk ? 'EDGEDESK vs MARKET' : 'EDGEDESK vs KALSHI',
        rows: ['EDGEDESK · UNROUNDED', mrow.join(' · '), 'DIFFERENCE · BEFORE FEES'],
        cols: cmp,
        note: [src ? src + (mk.captured_at ? ' ' + G.clock(mk.captured_at) : '') : null,
          ks.close ? 'Kalshi close (its last price before kickoff)' : 'Kalshi YES mid' + (kt ? ' ' + kt : ''),
          'EdgeDesk unrounded, win % with its fair moneyline · differences before Kalshi’s fees'].filter(Boolean).join(' · ')
      };
    }
    function rangeAbbr(lo, hi, aw, hm) {
      function one(v) { var r = Math.round(v); return r === 0 ? 'A TIE' : (r > 0 ? hm : aw) + ' BY ' + Math.abs(r); }
      return [one(lo), 'TO ' + one(hi)];
    }
    function impl(a) { a = num(a); if (a == null || (a > -100 && a < 100)) return null; return a > 0 ? 100 / (a + 100) : -a / (-a + 100); }
    /* without a live quote: EdgeDesk's own detail, only cells that exist */
    if (!c.market && M.available) {
      var cells = [];
      var st = (spec.insights || []).filter(function (i) { return i.family === 'strength'; })[0];
      if (spec.neutral && num(spec.neutral.points) != null) cells.push({ k: 'NEUTRAL-FIELD EDGE', v: [spec.neutral.points < 1.5 ? 'EVEN' : up(spec.neutral.team_short) + ' +' + spec.neutral.points.toFixed(1)], s: 'projection’s team-strength term' });
      if (c.range) cells.push({ k: '80% OUTCOME RANGE', v: c.range, s: 'final margin, 8 in 10 games' });
      cells.push({ k: 'MODEL MONEYLINE', v: [c.away.abbr + ' ' + c.fair_ml.away, c.home.abbr + ' ' + c.fair_ml.home], s: 'model estimate · not a price' });
      var orr = spec.overall_rank;
      if (cells.length < 3 && orr && num(orr.home) != null && num(orr.away) != null) cells.push({ k: orr.label, v: [c.away.abbr + ' #' + orr.away, c.home.abbr + ' #' + orr.home], s: 'of ' + (orr.of || '—') + (spec.league === 'nfl' ? ' NFL teams' : ' FBS teams') });
      c.detail = { title: 'EDGEDESK MODEL DETAIL', note: 'No live sportsbook quote is shown. Every number here is EdgeDesk’s own.', cells: cells.slice(0, 3) };
      void st;
    }
    c.insights = (spec.insights || []).slice(0, 4).map(function (i) { return { icon: i.icon || 'bars', title: up(i.title), text: i.short }; });
    var conf = spec.confidence || {};
    c.confidence = !M.available ? 'RESEARCH LIMITED' : conf.kind === 'reliability' ? (conf.score != null ? 'RELIABILITY ' + Math.round(conf.score) + '/100' + (conf.grade ? ' · ' + up(String(conf.grade).replace(/_/g, ' ')) : '') : 'RELIABILITY NOT SCORED')
      : up(conf.label || 'DATA CHECK');
    var ds = spec.data || {};
    c.status = !M.available ? 'MODEL: NO PROJECTION' : (ds.status === 'FAULT' ? 'DATA FAULT · RESEARCH ONLY' : (ds.status === 'LIMITED' ? 'MODEL: LIMITED DATA · RESEARCH ONLY' : 'MODEL: ACTIVE · RESEARCH ONLY'));
    c.status_tone = !M.available || ds.status === 'FAULT' ? 'fault' : (ds.status === 'LIMITED' ? 'warn' : 'ok');
    c.fault = ds.status === 'FAULT' ? 'DATA FAULT: ' + (G.FAULT_TEXT[str((ds.faults || [])[0]).split(':')[0]] || 'THE PROJECTION FAILED A CONSISTENCY CHECK') : null;
    c.snapshot_line = (c.started ? 'PREGAME SNAPSHOT · ' : 'SNAPSHOT ') + (G.stamp(M.built_at || spec.generated_at) || '') + (c.snapshot_id ? ' · ' + c.snapshot_id : '') + ' · ' + G.SITE;
    c.tagline = G.TAGLINE;
    /* the copy rule over every string on the graphic */
    var strings = [];
    (function walk(v) { if (v == null) return; if (typeof v === 'string') strings.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (typeof v === 'object') Object.keys(v).forEach(function (k) { walk(v[k]); }); })(c);
    if (strings.some(function (t) { return G.BANNED.test(t); })) return { ok: false, reason: 'copy_rule', message: G.REASON_TEXT.copy_rule };
    return { ok: true, content: c };
  };

  /* a sentence a screen reader can read in place of the picture */
  G.altText = function (c) {
    if (!c) return '';
    if (c.alt) return c.alt;
    var s = 'EdgeDesk research graphic: ' + c.away.name + ' at ' + c.home.name + ', ' + c.date + '. ';
    if (!c.model_available) return s + 'No EdgeDesk projection: ' + c.reason + '.';
    s += 'EdgeDesk projects ' + c.away.short + ' ' + c.scores.away + ', ' + c.home.short + ' ' + c.scores.home + '; fair spread ' + c.spread_text + ', fair total ' + c.total
      + '; model win probability ' + c.away.short + ' ' + c.win.away + ', ' + c.home.short + ' ' + c.win.home + '. ';
    if (c.compare && !c.fault) s += (c.compare.title === 'EDGEDESK vs MARKET' ? 'EdgeDesk vs the market' : 'EdgeDesk vs Kalshi') + ' (' + c.compare.note + '): ' + c.compare.cols.map(function (k) {
      return k.head + ' EdgeDesk ' + k.ed.replace(/\s+/g, ' ') + ', ' + c.compare.rows[1] + ' ' + k.mk.replace(/\s+/g, ' ') + ', difference ' + k.diff;
    }).join('; ') + '. ';
    else if (c.market) s += 'Current market (' + c.market.meta + '): ' + c.home.short + ' ' + (c.market.home_spread || '—') + ', total ' + (c.market.total || '—') + '. ';
    if (c.insights.length) s += 'What to watch: ' + c.insights.map(function (i) { return i.text; }).join('; ') + '. ';
    return s + c.confidence + '. Research, not picks.';
  };
  G.fileName = function (c, format) {
    function slug(t) { return str(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
    return 'edgedesk-' + slug(c.away.short) + '-at-' + slug(c.home.short) + '-' + (format || 'square') + '.png';
  };
  /* the cache key: template + snapshot + the market quote shown + format, and
     the Kalshi prices shown (only when there are any: a model-only key is unchanged) */
  G.cacheKey = function (spec, market, format, kalshi) {
    var mk = market && market.current ? [market.state, market.home_line, market.total, market.ml_home, market.ml_away, market.book, market.captured_at].join('/') : 'model-only';
    var parts = [G.VERSION, G.TEMPLATE, spec && spec.snapshot_id, mk, format || 'square'];
    if (kalshi && kalshi.state === 'OK' && kalshi.current) parts.push(['kalshi', kalshi.close ? 'close' : 'pre', kalshi.away ? kalshi.away.mid : '', kalshi.home ? kalshi.home.mid : '', kalshi.snapshot_at].join('/'));
    return parts.join('|');
  };

  /* ================================================================ LAYOUT
     measure(text, font) → px. The browser passes the canvas's own; Node uses
     a conservative estimate per family (tests). */
  function approx(text, font) {
    var px = parseFloat(String(font).match(/(\d+(?:\.\d+)?)px/)[1]);
    var cond = /Barlow|Condensed|Narrow/.test(font), w = /\b(7|8|9)00\b/.test(font) ? 1.04 : 1;
    return String(text).length * px * (cond ? 0.5 : 0.58) * w;
  }
  G.approxMeasure = approx;
  function F(size, weight, display, italic) { return (italic ? 'italic ' : '') + (weight || 400) + ' ' + size + 'px ' + (display ? G.DISPLAY : G.BODY); }
  function fitSize(text, size, weight, display, maxW, measure, min) {
    var sz = size;
    while (sz > (min || 12) && measure(text, F(sz, weight, display)) > maxW) sz -= 1;
    return sz;
  }
  function wrap(text, size, weight, display, maxW, measure, maxLines) {
    var words = str(text).split(/\s+/).filter(Boolean), lines = [], cur = '';
    words.forEach(function (w) {
      var t = cur ? cur + ' ' + w : w;
      if (measure(t, F(size, weight, display)) <= maxW || !cur) cur = t; else { lines.push(cur); cur = w; }
    });
    if (cur) lines.push(cur);
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      var last = lines[maxLines - 1];
      while (last.length > 1 && measure(last + '…', F(size, weight, display)) > maxW) last = last.replace(/\s*\S*$/, '') || last.slice(0, -1);
      lines[maxLines - 1] = last + '…';
    }
    return lines;
  }
  /* the largest size (down to min) at which text wraps into maxLines */
  function fitWrap(text, size, weight, display, maxW, measure, maxLines, min) {
    for (var sz = size; sz >= (min || 12); sz--) {
      var l = wrap(text, sz, weight, display, maxW, measure, 99);
      if (l.length <= maxLines) return { size: sz, lines: l };
    }
    return { size: min || 12, lines: wrap(text, min || 12, weight, display, maxW, measure, maxLines) };
  }

  var GEO = {
    square: { header: 118, teams: [126, 420], badge: { r: 92, y: 250, x: 168 }, nameY: 378, recY: 406, center: { away: 192, at: 234, home: 292, date: 340, venue: 372, ctx: 400 },
      panels: [430, 258], strip: [698, 118], watch: [826, 200], footer: 1053, insightSize: 19, insightLines: 3, watchCols: 4 },
    portrait: { header: 132, teams: [140, 486], badge: { r: 112, y: 286, x: 176 }, nameY: 440, recY: 472, center: { away: 214, at: 262, home: 328, date: 384, venue: 420, ctx: 452 },
      panels: [500, 292], strip: [806, 138], watch: [958, 300], footer: 1300, insightSize: 23, insightLines: 3, watchCols: 2 }
  };

  G.layout = function (c, format, measure) {
    var FMT = G.FORMATS[format] || G.FORMATS.square, W = FMT.w, H = FMT.h, K = G.K, g = GEO[format === 'portrait' ? 'portrait' : 'square'];
    measure = measure || approx;
    var ops = [], P = 24;
    /* width as drawn: the face (italic or not) and any letter spacing */
    function tw(t, size, weight, display, extra) {
      var it = !!(extra && extra.italic), sp = extra && extra.spacing ? extra.spacing : 0;
      return measure(t, F(size, weight, display, it)) + sp * str(t).length;
    }
    function text(t, x, y, size, weight, color, align, maxW, display, min, extra) {
      var sz = size;
      if (maxW) { var lo = min || Math.round(size * 0.55); while (sz > lo && tw(t, sz, weight, display, extra) > maxW) sz -= 1; }
      var o = { type: 'text', text: str(t), x: x, y: y, size: sz, weight: weight || 400, color: color || K.text, align: align || 'left',
        font: F(sz, weight, display), maxW: maxW || null, width: tw(t, sz, weight, display, extra) };
      if (extra) Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
      ops.push(o);
      return o;
    }
    function rect(x, y, w, h, fill, extra) { var o = { type: 'rect', x: x, y: y, w: w, h: h, fill: fill || null }; if (extra) Object.keys(extra).forEach(function (k) { o[k] = extra[k]; }); ops.push(o); return o; }
    function lin(x0, y0, x1, y1, stops) { return { type: 'linear', x0: x0, y0: y0, x1: x1, y1: y1, stops: stops }; }
    function rad(x, y, r, stops) { return { type: 'radial', x0: x, y0: y, r0: 0, x1: x, y1: y, r1: r, stops: stops }; }
    var NEON = function (x, w) { return lin(x, 0, x + w, 0, [[0, K.cyan], [0.55, K.violet], [1, K.magenta]]); };
    function panel(x, y, w, h, title, sub) {
      rect(x, y, w, h, K.panel, { r: 18, stroke: NEON(x, w), lineWidth: 3, glow: { color: 'rgba(64,180,255,0.55)', blur: 18 } });
      if (title) {
        rect(x + 3, y + 3, w - 6, 54, lin(x, y, x, y + 54, [[0, 'rgba(37,99,235,0.55)'], [1, 'rgba(37,99,235,0.15)']]), { r: 15, rTop: true });
        text(title, x + w / 2, y + 40, 30, 800, K.text, 'center', w - 28, true, 18);
      }
      if (sub) text(sub, x + w / 2, y + 74, 15, 600, K.faint, 'center', w - 28, false, 11);
    }

    /* ---- background: night stadium, two light banks, faint yard lines */
    rect(0, 0, W, H, lin(0, 0, 0, H, [[0, K.bg0], [0.45, K.bg1], [1, K.bg2]]));
    rect(0, 0, W, H, rad(110, 40, 420, [[0, 'rgba(160,210,255,0.30)'], [0.35, 'rgba(90,150,255,0.10)'], [1, 'rgba(0,0,0,0)']]));
    rect(0, 0, W, H, rad(W - 110, 40, 420, [[0, 'rgba(160,210,255,0.30)'], [0.35, 'rgba(90,150,255,0.10)'], [1, 'rgba(0,0,0,0)']]));
    ops.push({ type: 'poly', points: [[60, 0], [200, 0], [520, g.teams[1]], [300, g.teams[1]]], fill: lin(0, 0, 0, g.teams[1], [[0, 'rgba(170,215,255,0.10)'], [1, 'rgba(170,215,255,0)']]) });
    ops.push({ type: 'poly', points: [[W - 60, 0], [W - 200, 0], [W - 520, g.teams[1]], [W - 300, g.teams[1]]], fill: lin(0, 0, 0, g.teams[1], [[0, 'rgba(170,215,255,0.10)'], [1, 'rgba(170,215,255,0)']]) });
    /* two banks of floodlights in the top corners */
    [[22, 1], [W - 22, -1]].forEach(function (b) {
      for (var r0 = 0; r0 < 3; r0++) for (var c0 = 0; c0 < 4; c0++) {
        ops.push({ type: 'circle', x: b[0] + b[1] * (c0 * 15), y: 22 + r0 * 15 + c0 * 2, r: 4.2, fill: 'rgba(240,248,255,0.95)', glow: { color: 'rgba(190,225,255,0.95)', blur: 14 } });
      }
    });
    if (c.surface === 'ice') {
      /* a rink seen from above, faint: the centre red line through centre ice */
      var ry = g.teams[1] - 50;
      ops.push({ type: 'line', x0: W / 2 - 160, y0: ry + 10, x1: W / 2 + 160, y1: ry + 10, color: 'rgba(248,113,113,0.07)', width: 5 });
      ops.push({ type: 'circle', x: W / 2, y: ry + 10, r: 66, fill: null, stroke: 'rgba(96,165,250,0.08)', lineWidth: 3 });
    } else if (c.surface === 'court') {
      /* a court seen from above, faint: the half-court line through the centre circle */
      var cy2 = g.teams[1] - 40;
      ops.push({ type: 'line', x0: W / 2 - 240, y0: cy2, x1: W / 2 + 240, y1: cy2, color: 'rgba(251,146,60,0.08)', width: 3 });
      ops.push({ type: 'circle', x: W / 2, y: cy2, r: 72, fill: null, stroke: 'rgba(251,146,60,0.09)', lineWidth: 3 });
      ops.push({ type: 'circle', x: W / 2, y: cy2, r: 24, fill: null, stroke: 'rgba(251,146,60,0.07)', lineWidth: 2 });
    } else {
      for (var yl = 0; yl < 7; yl++) {
        ops.push({ type: 'line', x0: 0, y0: g.teams[1] - 40 + yl * 14, x1: W, y1: g.teams[1] - 40 + yl * 14, color: 'rgba(120,200,160,' + (0.05 - yl * 0.005).toFixed(3) + ')', width: 1 });
      }
    }

    /* ---- header: the EdgeDesk lockup and the league / week label */
    /* the lockup is centred and never reaches the league label, whatever face
       the browser had to fall back to: it shrinks until it fits */
    var tr = W - 100, labW = Math.max(tw(c.league_label, 22, 800, true, { spacing: 3 }), c.week_label ? tw(c.week_label, 22, 800, true, { spacing: 3 }) : 0);
    var maxLock = 2 * (tr - Math.min(labW, 300) - 18 - W / 2);
    var markR = format === 'portrait' ? 46 : 42, wordSize = format === 'portrait' ? 74 : 66, edgeW, deskW, lockW;
    for (;;) {
      edgeW = measure('EDGE', F(wordSize, 800, true, true)) + 4; deskW = measure('DESK', F(wordSize, 800, true, true));
      lockW = markR * 2 + 22 + edgeW + deskW;
      if (lockW <= maxLock || wordSize <= 36) break;
      wordSize -= 2; markR = Math.max(30, Math.round(wordSize * 0.62));
    }
    var lx = (W - lockW) / 2, ly = format === 'portrait' ? 66 : 60;
    ops.push({ type: 'circle', x: lx + markR, y: ly, r: markR, fill: 'rgba(6,12,30,0.95)', stroke: lin(lx, ly - markR, lx + 2 * markR, ly + markR, [[0, K.cyan], [1, K.magenta]]), lineWidth: 6, glow: { color: 'rgba(80,190,255,0.8)', blur: 22 } });
    text('ED', lx + markR, ly + markR * 0.36, Math.round(markR * 0.98), 800, lin(lx, 0, lx + 2 * markR, 0, [[0, K.cyan], [1, K.magenta]]), 'center', null, true, null, { italic: true });
    var wx = lx + markR * 2 + 22;
    text('EDGE', wx, ly + wordSize * 0.25, wordSize, 800, K.text, 'left', null, true, null, { italic: true });
    text('DESK', wx + edgeW, ly + wordSize * 0.25, wordSize, 800, lin(wx + edgeW, 0, wx + edgeW + deskW, 0, [[0, K.cyan], [1, K.magenta]]), 'left', null, true, null, { italic: true });
    text(c.tagline, wx + 4, ly + wordSize * 0.25 + 30, 17, 600, K.dim, 'left', edgeW + deskW, false, 12, { spacing: 5 });
    text(c.league_label, tr, 46, 22, 800, K.text, 'right', 300, true, 14, { spacing: 3 });
    if (c.week_label) text(c.week_label, tr, 74, 22, 800, K.text, 'right', 300, true, 14, { spacing: 3 });
    rect(tr - 110, c.week_label ? 84 : 56, 110, 4, lin(tr - 110, 0, tr, 0, [[0, K.gold], [1, 'rgba(250,204,21,0.2)']]), { r: 2 });

    /* ---- the two teams: monogram badges in team colours, names in the middle */
    function badge(t, cx, cy, r) {
      ops.push({ type: 'circle', x: cx, y: cy, r: r + 12, fill: null, stroke: lin(cx - r, cy - r, cx + r, cy + r, [[0, K.cyan], [1, K.magenta]]), lineWidth: 4, glow: { color: 'rgba(80,190,255,0.7)', blur: 26 } });
      ops.push({ type: 'circle', x: cx, y: cy, r: r, fill: rad(cx - r * 0.35, cy - r * 0.45, r * 1.6, [[0, lighten(t.color, 0.28)], [0.6, t.color], [1, darken(t.color, 0.35)]]), stroke: t.alt, lineWidth: 8 });
      ops.push({ type: 'circle', x: cx, y: cy, r: r - 14, fill: null, stroke: 'rgba(255,255,255,0.18)', lineWidth: 2 });
      var ab = t.abbr || '?';
      text(ab, cx, cy + r * 0.24, Math.round(r * (ab.length <= 3 ? 0.78 : 0.62)), 800, t.on, 'center', r * 1.55, true, 20, { shadow: { color: 'rgba(0,0,0,0.45)', blur: 8 } });
    }
    var bx = g.badge.x, by = g.badge.y, br = g.badge.r;
    badge(c.away, bx, by, br);
    badge(c.home, W - bx, by, br);
    [['away', bx], ['home', W - bx]].forEach(function (s) {
      var t = c[s[0]];
      text((t.rank ? t.rank + ' ' : '') + t.short, s[1], g.nameY, format === 'portrait' ? 32 : 28, 800, K.text, 'center', 300, true, 16);
      if (t.record) text(t.record, s[1], g.recY, format === 'portrait' ? 26 : 22, 600, K.dim, 'center', 240, true, 14);
    });
    var cw = W - 2 * (bx + br + 26);
    text(c.away.name, W / 2, g.center.away, format === 'portrait' ? 70 : 62, 800, K.text, 'center', cw, true, 26, { shadow: { color: 'rgba(0,0,0,0.6)', blur: 10 } });
    text('AT', W / 2, g.center.at, format === 'portrait' ? 34 : 30, 800, K.cyan, 'center', null, true);
    text(c.home.name, W / 2, g.center.home, format === 'portrait' ? 70 : 62, 800, K.text, 'center', cw, true, 26, { shadow: { color: 'rgba(0,0,0,0.6)', blur: 10 } });
    text(c.date, W / 2, g.center.date, format === 'portrait' ? 32 : 28, 700, '#9fd8ff', 'center', cw, true, 16);
    if (c.venue) text(c.venue, W / 2, g.center.venue, format === 'portrait' ? 24 : 22, 600, K.dim, 'center', cw, true, 14);
    if (c.context) text(c.context, W / 2, g.center.ctx, format === 'portrait' ? 22 : 20, 600, K.faint, 'center', cw, true, 13);

    /* ---- the three model panels */
    var py = g.panels[0], ph = g.panels[1], lw = 340, cwid = W - 2 * P - 2 * lw - 24, rx = W - P - lw, cx0 = P + lw + 12;
    /* the panel words: football's unless the content names its own (another sport) */
    var LB = c.labels || {};
    if (c.model_available) {
      panel(P, py, lw, ph, LB.left || 'FAIR SPREAD', LB.left_sub || 'EDGEDESK MODEL · NOT A SPORTSBOOK LINE');
      text(c.spread_team, P + lw / 2, py + 120, 32, 800, K.dim, 'center', lw - 40, true, 16);
      text(c.spread_value, P + lw / 2, py + (format === 'portrait' ? 210 : 196), format === 'portrait' ? 110 : 96, 800, K.text, 'center', lw - 40, true, 40, { shadow: { color: 'rgba(42,212,255,0.45)', blur: 18 } });
      var favWin = c.fav_side ? c.win[c.fav_side] : c.win.home;
      text(favWin + ' MODEL WIN PROBABILITY', P + lw / 2, py + ph - 22, 19, 700, K.green, 'center', lw - 30, false, 12);

      panel(cx0, py, cwid, ph, LB.center || 'PROJECTED SCORE', LB.center_sub || 'EDGEDESK PROJECTION');
      var half = cwid / 2, sy = py + (format === 'portrait' ? 112 : 104), scoreSz = c.scores.whole || c.scores.big ? (format === 'portrait' ? 88 : 74) : 52;
      [['away', cx0 + half / 2], ['home', cx0 + half + half / 2]].forEach(function (s) {
        var t = c[s[0]];
        text(t.abbr, s[1], sy, 24, 800, K.dim, 'center', half - 20, true, 14);
        text(c.scores[s[0]], s[1], sy + (format === 'portrait' ? 84 : 72), scoreSz, 800, K.text, 'center', half - 16, true, 30);
      });
      ops.push({ type: 'line', x0: cx0 + half, y0: sy - 20, x1: cx0 + half, y1: sy + (format === 'portrait' ? 86 : 74), color: K.line, width: 2 });
      /* the win-probability bar, coloured by team, percentages at its ends */
      var barY = py + ph - 50, barX = cx0 + 22, barW = cwid - 44;
      text('WIN PROBABILITY', cx0 + cwid / 2, barY - 8, 14, 700, K.faint, 'center', barW, false, 10, { spacing: 2 });
      rect(barX, barY, barW * c.win.away_pct / 100, 16, c.away.bar || c.away.color, { r: 8, rRight: c.win.away_pct >= 99 ? false : 'none', stroke: 'rgba(255,255,255,0.25)', lineWidth: 1 });
      rect(barX + barW * c.win.away_pct / 100, barY, barW * c.win.home_pct / 100, 16, c.home.bar || c.home.color, { r: 8, rLeft: 'none', stroke: 'rgba(255,255,255,0.25)', lineWidth: 1 });
      text(c.away.abbr + ' ' + c.win.away, barX, barY + 38, 22, 800, c.fav_side === 'away' ? K.green : K.dim, 'left', barW / 2 - 6, true, 12);
      text(c.home.abbr + ' ' + c.win.home, barX + barW, barY + 38, 22, 800, c.fav_side === 'home' ? K.green : K.dim, 'right', barW / 2 - 6, true, 12);

      panel(rx, py, lw, ph, LB.right || 'FAIR TOTAL', LB.right_sub || 'EDGEDESK MODEL · NOT A SPORTSBOOK LINE');
      text(c.total, rx + lw / 2, py + (format === 'portrait' ? 182 : 170), format === 'portrait' ? 110 : 96, 800, K.text, 'center', lw - 40, true, 40, { shadow: { color: 'rgba(224,64,251,0.4)', blur: 18 } });
      var tsub = c.total_sub || { label: 'PROJECTED POINTS', text: null };
      text(tsub.label, rx + lw / 2, py + ph - 52, 15, 700, K.faint, 'center', lw - 30, false, 11, { spacing: 2 });
      text(tsub.text || (c.away.abbr + ' ' + c.points.away + '  ·  ' + c.home.abbr + ' ' + c.points.home), rx + lw / 2, py + ph - 20, 24, 800, K.green, 'center', lw - 30, true, 14);
    } else {
      var nh = g.watch[0] + g.watch[1] - py;
      panel(P, py, W - 2 * P, nh, 'NO EDGEDESK PROJECTION');
      ops.push({ type: 'icon', name: 'alert', x: W / 2 - 32, y: py + 110, size: 64, color: K.warn });
      var nl = fitWrap(c.reason.charAt(0).toUpperCase() + c.reason.slice(1) + '. EdgeDesk shows a research limitation rather than an estimate it cannot support.', 32, 600, false, W - 2 * P - 120, measure, 4, 18);
      nl.lines.forEach(function (l, i) { text(l, W / 2, py + 240 + i * (nl.size + 14), nl.size, 600, K.dim, 'center'); });
      text('No projected score, spread, total or win probability is shown for this game.', W / 2, py + nh - 40, 20, 500, K.faint, 'center', W - 2 * P - 60, false, 12);
    }

    /* ---- the strip: a LIVE market, or EdgeDesk's own detail */
    var sy0 = g.strip[0], sh = g.strip[1], sw = W - 2 * P;
    if (c.fault) {
      rect(P, sy0, sw, sh, 'rgba(60,12,18,0.92)', { r: 16, stroke: K.fault, lineWidth: 3, glow: { color: 'rgba(248,113,113,0.5)', blur: 16 } });
      ops.push({ type: 'icon', name: 'alert', x: P + 26, y: sy0 + sh / 2 - 22, size: 44, color: K.fault });
      text(c.fault, P + 90, sy0 + 44, 28, 800, K.fault, 'left', sw - 120, true, 16);
      var fl = wrap('These numbers failed EdgeDesk’s own consistency checks. Read them as research only until the next snapshot passes.', 18, 500, false, sw - 120, measure, 2);
      fl.forEach(function (l, i) { text(l, P + 90, sy0 + 76 + i * 24, 18, 500, K.dim, 'left'); });
    } else if (c.compare) {
      /* EDGEDESK vs MARKET: a label column, then one column per market; rows
         EdgeDesk, the market, the difference; what each number is, and when, on the last line */
      /* the table takes most of the gaps either side of the strip: a header and three rows */
      var CP = c.compare, sq = format !== 'portrait', ty = sy0 - (sq ? 4 : 6), th = sh + (sq ? 8 : 12);
      rect(P, ty, sw, th, K.panel, { r: 16, stroke: NEON(P, sw), lineWidth: 2, glow: { color: 'rgba(64,180,255,0.35)', blur: 12 } });
      var hy = ty + (sq ? 28 : 32), ry = (sq ? [57, 83, 109] : [66, 98, 130]).map(function (v) { return ty + v; });
      var tone = [K.text, K.dim, K.cyan], lw2 = 290, dx = P + 24 + lw2, dw = sw - 24 - lw2 - 14;
      var cw2 = Math.min(dw / Math.max(CP.cols.length, 1), 250), x0 = dx + (dw - cw2 * CP.cols.length) / 2;
      text(CP.title, P + 24, hy, 22, 800, K.text, 'left', lw2 - 14, true, 14);
      CP.rows.forEach(function (r, i) { text(r, P + 24, ry[i], 16, 700, tone[i], 'left', lw2 - 14, true, 10, { spacing: 1 }); });
      ops.push({ type: 'line', x0: P + 20, y0: hy + 9, x1: W - P - 20, y1: hy + 9, color: K.line, width: 1 });
      CP.cols.forEach(function (col, i) {
        var x = x0 + i * cw2, cx = x + cw2 / 2;
        ops.push({ type: 'line', x0: x, y0: ty + 12, x1: x, y1: ry[2] + 6, color: K.line, width: 2 });
        text(col.head, cx, hy, 13, 700, K.faint, 'center', cw2 - 12, false, 9, { spacing: 2 });
        text(col.ed, cx, ry[0], sq ? 22 : 24, 800, tone[0], 'center', cw2 - 12, true, 12);
        text(col.mk, cx, ry[1], sq ? 22 : 24, 800, tone[1], 'center', cw2 - 12, true, 12);
        text(col.diff, cx, ry[2], sq ? 20 : 22, 800, tone[2], 'center', cw2 - 12, true, 11);
      });
    } else if (c.market) {
      rect(P, sy0, sw, sh, K.panel, { r: 16, stroke: NEON(P, sw), lineWidth: 2, glow: { color: 'rgba(64,180,255,0.35)', blur: 12 } });
      text(c.market.title, P + 24, sy0 + 34, 26, 800, K.text, 'left', 280, true, 16);
      text(c.market.meta, P + 24, sy0 + 58, 15, 600, K.faint, 'left', 330, false, 11);
      /* only the markets the quote carries: no empty column, no dash standing in for a price */
      var cols = [];
      if (c.market.home_spread) cols.push([LB.market_spread || 'SPREAD', c.away.abbr + ' ' + c.market.away_spread, c.home.abbr + ' ' + c.market.home_spread]);
      if (c.market.total) cols.push(['TOTAL', c.market.total, c.market.total_prices || '']);
      if (c.market.away_ml && c.market.home_ml) cols.push(['MONEYLINE', c.away.abbr + ' ' + c.market.away_ml, c.home.abbr + ' ' + c.market.home_ml]);
      var colX = P + 360, colW = (sw - 360 - 300) / Math.max(cols.length, 1);
      cols.forEach(function (col, i) {
        var x = colX + i * colW + colW / 2;
        text(col[0], x, sy0 + 30, 15, 700, K.faint, 'center', colW - 10, false, 10, { spacing: 2 });
        text(col[1], x, sy0 + 62, 24, 800, K.text, 'center', colW - 10, true, 12);
        if (col[2]) text(col[2], x, sy0 + 92, 24, 800, K.text, 'center', colW - 10, true, 12);
      });
      if (c.market.no_vig) text('NO-VIG WIN %  ' + c.away.abbr + ' ' + c.market.no_vig.away + ' · ' + c.home.abbr + ' ' + c.market.no_vig.home, P + 24, sy0 + sh - 18, 15, 700, K.green, 'left', 330, false, 10);
      var vx = W - P - 290;
      ops.push({ type: 'line', x0: vx - 14, y0: sy0 + 16, x1: vx - 14, y1: sy0 + sh - 16, color: K.line, width: 2 });
      text('VS EDGEDESK', vx, sy0 + 30, 15, 700, K.faint, 'left', 270, false, 10, { spacing: 2 });
      c.market.vs.forEach(function (v, i) { text(v, vx, sy0 + 60 + i * 30, 19, 600, K.dim, 'left', 276, false, 11); });
      if (c.market.note) text(c.market.note, vx, sy0 + sh - 8, 12, 700, K.faint, 'left', 276, false, 9, { spacing: 1 });
    } else if (c.detail) {
      rect(P, sy0, sw, sh, K.panel, { r: 16, stroke: NEON(P, sw), lineWidth: 2, glow: { color: 'rgba(64,180,255,0.35)', blur: 12 } });
      text(c.detail.title, P + 24, sy0 + 34, 24, 800, K.text, 'left', 300, true, 14);
      var dn = wrap(c.detail.note, 14, 500, false, 300, measure, 3);
      dn.forEach(function (l, i) { text(l, P + 24, sy0 + 58 + i * 19, 14, 500, K.faint, 'left', 300, false, 10); });
      var n = c.detail.cells.length, cx1 = P + 340, cw1 = (sw - 340) / Math.max(n, 1);
      c.detail.cells.forEach(function (cell, i) {
        var x = cx1 + i * cw1;
        if (i) ops.push({ type: 'line', x0: x, y0: sy0 + 16, x1: x, y1: sy0 + sh - 16, color: K.line, width: 2 });
        text(cell.k, x + cw1 / 2, sy0 + 32, 15, 700, K.faint, 'center', cw1 - 20, false, 10, { spacing: 2 });
        /* one value per line, each fitted to the cell */
        var vs = Array.isArray(cell.v) ? cell.v : [cell.v], vsz = vs.length > 1 ? 26 : 30;
        vs.forEach(function (l, j) { text(l, x + cw1 / 2, sy0 + 66 + j * (vsz + 2) - (vs.length - 1) * 12, vsz, 800, K.text, 'center', cw1 - 20, true, 12); });
        text(cell.s, x + cw1 / 2, sy0 + sh - 16, 14, 500, K.faint, 'center', cw1 - 20, false, 10);
      });
    }

    /* ---- what to watch for: 2-4 measured insights, never filler */
    var wy = g.watch[0], wh = g.watch[1];
    if (c.insights.length) {
      rect(P, wy, sw, wh, K.panel, { r: 18, stroke: lin(P, 0, P + sw, 0, [[0, K.blue], [0.5, K.violet], [1, K.magenta]]), lineWidth: 3, glow: { color: 'rgba(160,90,255,0.45)', blur: 16 } });
      text('WHAT TO WATCH FOR', W / 2, wy + 40, 34, 800, K.text, 'center', sw - 40, true, 18);
      var n2 = c.insights.length, colsN = format === 'portrait' ? (n2 === 4 ? 2 : 1) : n2;
      var rowsN = Math.ceil(n2 / colsN), gw = (sw - 20) / colsN, gh = (wh - 60) / rowsN;
      c.insights.forEach(function (ins, i) {
        var col = i % colsN, row = Math.floor(i / colsN), x = P + 10 + col * gw, y = wy + 56 + row * gh;
        if (col) ops.push({ type: 'line', x0: x, y0: y + 10, x1: x, y1: y + gh - 10, color: K.line, width: 2 });
        if (row) ops.push({ type: 'line', x0: x + 16, y0: y, x1: x + gw - 16, y1: y, color: K.line, width: 1 });
        var iconS = format === 'portrait' ? 40 : 34, tone = [K.blue, K.magenta, K.cyan, K.magenta][i % 4];
        if (format === 'portrait') {
          var oneCol = colsN === 1, maxL = oneCol ? Math.max(1, Math.floor((gh - 58) / (g.insightSize + 7))) : g.insightLines;
          ops.push({ type: 'icon', name: ins.icon, x: x + 22, y: y + 12, size: iconS, color: tone });
          text(ins.title, x + 22 + iconS + 14, y + 42, 26, 800, K.text, 'left', gw - iconS - 60, true, 14);
          /* the largest size whose lines stay inside this cell's row */
          var bl = null;
          for (var szp = g.insightSize; szp >= 15 && !bl; szp--) {
            var capp = Math.min(maxL, Math.max(1, Math.floor((gh - 86) / (szp + 7)) + 1)), tl = wrap(ins.text, szp, 500, false, gw - 50, measure, 99);
            if (tl.length <= capp) bl = { size: szp, lines: tl };
          }
          if (!bl) bl = fitWrap(ins.text, 15, 500, false, gw - 50, measure, Math.max(1, Math.floor((gh - 86) / 22) + 1), 15);
          bl.lines.forEach(function (l, j) { text(l, x + 22, y + 78 + j * (bl.size + 7), bl.size, 500, K.dim, 'left'); });
        } else {
          iconS = 30;
          ops.push({ type: 'icon', name: ins.icon, x: x + gw / 2 - iconS / 2, y: y - 2, size: iconS, color: tone });
          text(ins.title, x + gw / 2, y + iconS + 22, 21, 800, K.text, 'center', gw - 22, true, 13);
          /* as many lines as the panel holds below the title, at the largest size that fits */
          var top2 = y + iconS + 46, room = wy + wh - 10 - top2;
          var b2 = null;
          for (var sz2 = g.insightSize; sz2 >= 14; sz2--) {
            var cap2 = Math.max(1, Math.floor((room + 4) / (sz2 + 4)) + 0);
            var t2 = wrap(ins.text, sz2, 500, false, gw - 26, measure, 99);
            if (t2.length <= Math.min(cap2, g.insightLines + 1)) { b2 = { size: sz2, lines: t2 }; break; }
          }
          if (!b2) b2 = { size: 14, lines: wrap(ins.text, 14, 500, false, gw - 26, measure, Math.max(1, Math.floor((room + 4) / 18))) };
          b2.lines.forEach(function (l, j) { text(l, x + gw / 2, top2 + j * (b2.size + 4), b2.size, 500, K.dim, 'center'); });
        }
      });
    }

    /* ---- footer: what the numbers rest on, the status, the snapshot */
    var fy = g.footer;
    var toneC = c.status_tone === 'fault' ? K.fault : (c.status_tone === 'warn' ? K.warn : K.cyan);
    var co = text(c.confidence, P + 6, fy, 20, 700, K.cyan, 'left', 360, true, 12, { spacing: 1 });
    var cwid2 = Math.min(co.width, 360);
    ops.push({ type: 'line', x0: P + 20 + cwid2, y0: fy - 17, x1: P + 20 + cwid2, y1: fy + 3, color: 'rgba(255,255,255,0.5)', width: 2 });
    text(c.status, P + 34 + cwid2, fy, 20, 700, toneC, 'left', W - 2 * P - cwid2 - 330, true, 11, { spacing: 1 });
    text(c.snapshot_line, P + 6, fy + 22, 13, 500, K.faint, 'left', W - 2 * P - 300, false, 9);
    var pw = 270, phh = 44;
    rect(W - P - pw, fy - 24, pw, phh, lin(0, fy - 24, 0, fy + 20, [[0, '#fde047'], [1, '#eab308']]), { r: 10, glow: { color: 'rgba(250,204,21,0.45)', blur: 14 } });
    text(c.tagline, W - P - pw / 2, fy + 7, 24, 800, K.ink, 'center', pw - 20, true, 14);
    return { width: W, height: H, format: format === 'portrait' ? 'portrait' : 'square', ops: ops };
  };

  /* colour helpers for the badge's lit sphere */
  function rgb(h) { h = str(h).replace('#', ''); if (!/^[0-9a-f]{6}$/i.test(h)) h = '3b4a6b'; return [parseInt(h.substr(0, 2), 16), parseInt(h.substr(2, 2), 16), parseInt(h.substr(4, 2), 16)]; }
  function hx(a) { return '#' + a.map(function (v) { v = Math.max(0, Math.min(255, Math.round(v))); return ('0' + v.toString(16)).slice(-2); }).join(''); }
  function lighten(h, t) { var c = rgb(h); return hx(c.map(function (v) { return v + (255 - v) * t; })); }
  function darken(h, t) { var c = rgb(h); return hx(c.map(function (v) { return v * (1 - t); })); }
  G._lighten = lighten; G._darken = darken;

  /* ================================================================ DRAW */
  function paintOf(g, f) {
    if (!f || typeof f === 'string') return f;
    var gr = f.type === 'radial' ? g.createRadialGradient(f.x0, f.y0, f.r0, f.x1, f.y1, f.r1) : g.createLinearGradient(f.x0, f.y0, f.x1, f.y1);
    f.stops.forEach(function (s) { gr.addColorStop(s[0], s[1]); });
    return gr;
  }
  function roundRect(g, o) {
    var r = o.r || 0, x = o.x, y = o.y, w = o.w, h = o.h;
    var tl = r, tr = r, br = r, bl = r;
    if (o.rTop) { br = 0; bl = 0; }
    if (o.rLeft === 'none') { tl = 0; bl = 0; }
    if (o.rRight === 'none') { tr = 0; br = 0; }
    g.beginPath();
    g.moveTo(x + tl, y); g.lineTo(x + w - tr, y); if (tr) g.arcTo(x + w, y, x + w, y + tr, tr); else g.lineTo(x + w, y);
    g.lineTo(x + w, y + h - br); if (br) g.arcTo(x + w, y + h, x + w - br, y + h, br); else g.lineTo(x + w, y + h);
    g.lineTo(x + bl, y + h); if (bl) g.arcTo(x, y + h, x, y + h - bl, bl); else g.lineTo(x, y + h);
    g.lineTo(x, y + tl); if (tl) g.arcTo(x, y, x + tl, y, tl); else g.lineTo(x, y);
    g.closePath();
  }
  function withGlow(g, glow, fn) {
    g.save();
    if (glow) { g.shadowColor = glow.color; g.shadowBlur = glow.blur; }
    fn();
    g.restore();
  }
  G.ICON = function (g, name, x, y, s, color) {
    g.save(); g.translate(x, y); g.scale(s / 32, s / 32);
    g.fillStyle = color; g.strokeStyle = color; g.lineWidth = 2.6; g.lineJoin = 'round'; g.lineCap = 'round';
    g.shadowColor = color; g.shadowBlur = 10;
    function rr(a, b, w, h, r) { roundRect(g, { x: a, y: b, w: w, h: h, r: r }); g.fill(); }
    switch (name) {
      case 'bars': rr(3, 18, 7, 12, 1.5); rr(12.5, 10, 7, 20, 1.5); rr(22, 2, 7, 28, 1.5); break;
      case 'home': g.beginPath(); g.moveTo(16, 2); g.lineTo(31, 15); g.lineTo(27, 15); g.lineTo(27, 30); g.lineTo(19.5, 30); g.lineTo(19.5, 21); g.lineTo(12.5, 21); g.lineTo(12.5, 30); g.lineTo(5, 30); g.lineTo(5, 15); g.lineTo(1, 15); g.closePath(); g.fill(); break;
      case 'shield': g.beginPath(); g.moveTo(16, 1.5); g.lineTo(29, 6); g.quadraticCurveTo(29, 23, 16, 30.5); g.quadraticCurveTo(3, 23, 3, 6); g.closePath(); g.stroke();
        g.beginPath(); g.moveTo(16, 6); g.lineTo(24.5, 9); g.quadraticCurveTo(24, 20.5, 16, 25.5); g.closePath(); g.fill(); break;
      case 'ball': g.save(); g.translate(16, 16); g.rotate(-Math.PI / 4); g.beginPath(); g.ellipse(0, 0, 14.5, 8.5, 0, 0, Math.PI * 2); g.stroke();
        g.beginPath(); g.moveTo(-6, 0); g.lineTo(6, 0); [-3.5, 0, 3.5].forEach(function (k) { g.moveTo(k, -2.6); g.lineTo(k, 2.6); }); g.stroke(); g.restore(); break;
      case 'run': g.beginPath(); g.arc(21, 5, 3.4, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.moveTo(9, 12); g.lineTo(17, 10); g.lineTo(23, 15); g.lineTo(28, 15); g.moveTo(17, 10); g.lineTo(14, 19); g.lineTo(20, 23); g.lineTo(18, 30); g.moveTo(14, 19); g.lineTo(9, 25); g.lineTo(3, 25); g.stroke();
        g.beginPath(); g.moveTo(1, 11); g.lineTo(6, 11); g.moveTo(0, 16); g.lineTo(5, 16); g.stroke(); break;
      case 'people': [[16, 8, 4.6, 7, 18, 18, 12], [6.5, 11, 3.6, 1, 20, 11, 10], [25.5, 11, 3.6, 20, 20, 11, 10]].forEach(function (p) {
          g.beginPath(); g.arc(p[0], p[1], p[2], 0, Math.PI * 2); g.fill(); rr(p[3], p[4], p[5], p[6], 4.5); }); break;
      case 'bolt': g.beginPath(); g.moveTo(19, 1); g.lineTo(5, 18); g.lineTo(14.5, 18); g.lineTo(12, 31); g.lineTo(27, 13); g.lineTo(17.5, 13); g.closePath(); g.fill(); break;
      case 'cloud': g.beginPath(); g.arc(11, 17, 6.5, Math.PI * 0.5, Math.PI * 1.5); g.arc(17, 10.5, 8, Math.PI, Math.PI * 1.9); g.arc(24, 16.5, 6, Math.PI * 1.45, Math.PI * 0.5); g.closePath(); g.fill();
        g.beginPath(); [10, 16, 22].forEach(function (k) { g.moveTo(k, 26); g.lineTo(k - 2, 31); }); g.stroke(); break;
      case 'alert': g.beginPath(); g.moveTo(16, 2); g.lineTo(31, 29); g.lineTo(1, 29); g.closePath(); g.stroke(); rr(14.6, 11, 2.8, 10, 1.2); g.beginPath(); g.arc(16, 24.6, 1.8, 0, Math.PI * 2); g.fill(); break;
      case 'clock': g.beginPath(); g.arc(16, 16, 13.5, 0, Math.PI * 2); g.stroke(); g.beginPath(); g.moveTo(16, 8); g.lineTo(16, 16); g.lineTo(22, 20); g.stroke(); break;
      case 'helmet': g.beginPath(); g.moveTo(3, 20); g.quadraticCurveTo(2, 4, 17, 3); g.quadraticCurveTo(30, 3, 30, 17); g.lineTo(30, 24); g.lineTo(19, 24); g.lineTo(17, 28); g.lineTo(8, 28); g.quadraticCurveTo(3, 27, 3, 20); g.closePath(); g.fill();
        g.strokeStyle = '#0b1020'; g.shadowBlur = 0; g.lineWidth = 2; g.beginPath(); g.moveTo(21, 15); g.lineTo(31, 15); g.moveTo(24, 15); g.lineTo(24, 24); g.stroke(); break;
      case 'puck': g.beginPath(); g.ellipse(16, 12, 13, 5.5, 0, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.moveTo(3, 12); g.lineTo(3, 20); g.ellipse(16, 20, 13, 5.5, 0, Math.PI, 0, true); g.lineTo(29, 12); g.closePath(); g.fill(); break;
      case 'net': g.beginPath(); g.moveTo(3, 29); g.lineTo(3, 9); g.quadraticCurveTo(3, 3, 9, 3); g.lineTo(23, 3); g.quadraticCurveTo(29, 3, 29, 9); g.lineTo(29, 29); g.stroke();
        g.lineWidth = 1.4; g.beginPath(); [9, 16, 23].forEach(function (k) { g.moveTo(k, 4); g.lineTo(k, 29); }); [10, 17, 24].forEach(function (k) { g.moveTo(4, k); g.lineTo(28, k); }); g.stroke(); break;
      case 'hoop': g.beginPath(); g.arc(16, 16, 13.5, 0, Math.PI * 2); g.stroke();
        g.beginPath(); g.moveTo(2.5, 16); g.lineTo(29.5, 16); g.moveTo(16, 2.5); g.lineTo(16, 29.5);
        g.moveTo(7, 5.5); g.quadraticCurveTo(12.5, 16, 7, 26.5); g.moveTo(25, 5.5); g.quadraticCurveTo(19.5, 16, 25, 26.5); g.stroke(); break;
      default: rr(6, 6, 20, 20, 4);
    }
    g.restore();
  };
  G.draw = function (canvas, L) {
    canvas.width = L.width; canvas.height = L.height;
    var g = canvas.getContext('2d');
    L.ops.forEach(function (o) {
      if (o.type === 'rect') {
        withGlow(g, o.glow, function () {
          roundRect(g, o);
          if (o.fill) { g.fillStyle = paintOf(g, o.fill); g.fill(); }
          if (o.stroke) { g.shadowBlur = o.glow ? o.glow.blur : 0; g.strokeStyle = paintOf(g, o.stroke); g.lineWidth = o.lineWidth || 2; g.stroke(); }
        });
      } else if (o.type === 'circle') {
        withGlow(g, o.glow, function () {
          g.beginPath(); g.arc(o.x, o.y, o.r, 0, Math.PI * 2);
          if (o.fill) { g.fillStyle = paintOf(g, o.fill); g.fill(); }
          if (o.stroke) { g.strokeStyle = paintOf(g, o.stroke); g.lineWidth = o.lineWidth || 2; g.stroke(); }
        });
      } else if (o.type === 'poly') {
        g.beginPath(); o.points.forEach(function (p, i) { if (i) g.lineTo(p[0], p[1]); else g.moveTo(p[0], p[1]); }); g.closePath();
        g.fillStyle = paintOf(g, o.fill); g.fill();
      } else if (o.type === 'line') {
        g.beginPath(); g.moveTo(o.x0, o.y0); g.lineTo(o.x1, o.y1); g.strokeStyle = o.color; g.lineWidth = o.width || 1; g.stroke();
      } else if (o.type === 'icon') {
        G.ICON(g, o.name, o.x, o.y, o.size, o.color);
      } else if (o.type === 'text') {
        g.save();
        g.font = (o.italic ? 'italic ' : '') + o.font;
        g.fillStyle = paintOf(g, o.color);
        g.textAlign = o.align; g.textBaseline = 'alphabetic';
        if ('letterSpacing' in g) g.letterSpacing = (o.spacing || 0) + 'px';
        if (o.shadow) { g.shadowColor = o.shadow.color; g.shadowBlur = o.shadow.blur; }
        g.fillText(o.text, o.x, o.y);
        g.restore();
      }
    });
    return canvas;
  };
  G.measureWith = function (canvas) {
    var g = canvas.getContext('2d');
    return function (t, font) { g.font = font; return g.measureText(String(t)).width; };
  };

  /* ================================================================ BROWSER
     render(): fonts first, then content → layout → draw → PNG, cached by
     G.cacheKey (snapshot id + the market quote shown + format + template), so
     a page view never redraws a graphic it already has and a new snapshot
     draws a new one by itself. */
  var CACHE = {}, ORDER = [], MAX = 24;
  G.fontsReady = function (timeoutMs) {
    if (typeof document === 'undefined' || !document.fonts || !document.fonts.load) return Promise.resolve(false);
    var want = ['800 40px "Barlow Condensed"', 'italic 800 40px "Barlow Condensed"', '700 40px "Barlow Condensed"', '600 40px "Barlow Condensed"', '500 20px Inter', '600 20px Inter', '700 20px Inter'];
    var all = Promise.all(want.map(function (f) { return document.fonts.load(f).catch(function () { return null; }); })).then(function () { return true; });
    return Promise.race([all, new Promise(function (r) { setTimeout(function () { r(false); }, timeoutMs || 2500); })]);
  };
  G.render = function (spec, market, format, opts) {
    opts = opts || {};
    format = G.FORMATS[format] ? format : 'square';
    var key = G.cacheKey(spec, market, format, opts.kalshi);
    if (CACHE[key] && !opts.fresh) return Promise.resolve(CACHE[key]);
    var ct = G.content(spec, market, opts);
    if (!ct.ok) return Promise.reject(ct);
    return paint(ct, key, format);
  };
  /* another sport's content, already built to G.layout's shape (lib/edgedesk_nhl_graphic.js):
     the same layout, canvas, PNG and cache; key names the snapshot, the quote shown and the format */
  G.renderContent = function (c, key, format, opts) {
    opts = opts || {};
    format = G.FORMATS[format] ? format : 'square';
    key = [G.VERSION, key, format].join('|');
    if (CACHE[key] && !opts.fresh) return Promise.resolve(CACHE[key]);
    if (!c) return Promise.reject({ ok: false, reason: 'no_spec', message: G.REASON_TEXT.no_spec });
    return paint({ ok: true, content: c }, key, format);
  };
  function paint(ct, key, format) {
    return G.fontsReady().then(function () {
      var canvas = document.createElement('canvas');
      canvas.width = G.FORMATS[format].w; canvas.height = G.FORMATS[format].h;
      var L = G.layout(ct.content, format, G.measureWith(canvas));
      G.draw(canvas, L);
      return new Promise(function (resolve) {
        if (canvas.toBlob) canvas.toBlob(function (b) { resolve(b); }, 'image/png');
        else resolve(null);
      }).then(function (blob) {
        var out = { key: key, format: format, canvas: canvas, blob: blob, url: blob && typeof URL !== 'undefined' ? URL.createObjectURL(blob) : canvas.toDataURL('image/png'),
          content: ct.content, alt: G.altText(ct.content), file_name: G.fileName(ct.content, format) };
        CACHE[key] = out; ORDER.push(key);
        while (ORDER.length > MAX) { var k = ORDER.shift(), old = CACHE[k]; delete CACHE[k]; if (old && old.blob && typeof URL !== 'undefined') try { URL.revokeObjectURL(old.url); } catch (_) {} }
        return out;
      });
    });
  }
  G._cache = function () { return { keys: ORDER.slice() }; };
  return G;
});
