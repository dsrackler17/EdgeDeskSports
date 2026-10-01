/* ===========================================================================
   EDGEDESK EDGE P&L — the public profit and loss of every flagged edge.
   docs/pnl/GRADES.md · supabase/pnl_grades*.sql

   Reads public.pnl_summary (counts and units only; the database did the
   arithmetic) and renders, for one sport or all of them:
     - All flagged bets, BET and LEAN: units won, ROI, W-L-P, graded count, and
       the same bets at the closing price for comparison;
     - the cumulative units line over time (All / BET / LEAN);
     - what is NOT in the P&L and why: void, missing flag price, waiting on a
       result, a market that cannot be graded, PASS at the flag;
     - month by month, as a table.
   Nothing here prices, grades or estimates anything. Summing rows and dividing
   units by units risked is the only arithmetic on this side.

   BET and LEAN are the labels the board showed AT THE MOMENT IT FLAGGED,
   rebuilt from the frozen flag (supabase/pnl_grades_sync.sql,
   pnl_verdict_at_flag). UNLABELLED is a flag older than those frozen inputs:
   it is in "All flagged bets" and in neither BET nor LEAN.

   Browser: window.EDEdgePnl.mount(host, { get, archive, dropRetired }).
   Node: require('./edgedesk_edge_pnl.js') for the pure parts. ES5.
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EDEdgePnl = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var VERSION = 'edgedesk_edge_pnl_v1';
  var METHOD = '1 unit flat stake at the price when flagged. Pushes = 0. Missing prices are not estimated.';
  var MIN_SAMPLE = 30;
  var BETS = ['BET', 'LEAN', 'UNLABELLED'];
  /* Validated with the dataviz palette checker against this page's surface
     (#191510, dark): lightness band, chroma, adjacent CVD ΔE ≥ 8.4, normal
     vision ΔE ≥ 19.8, contrast ≥ 3:1. Blue = all bets, aqua-green = BET,
     amber = LEAN (the page's own BET green / LEAN amber, stepped so a
     colour-blind reader can tell them apart). */
  var COLOR = { ALL: '#3987e5', BET: '#199e70', LEAN: '#c98500' };
  var NAME = { ALL: 'All flagged bets', BET: 'BET', LEAN: 'LEAN', UNLABELLED: 'Earlier flags' };
  var MEANS = {
    ALL: 'Every flagged edge that was a bet, BET and LEAN together (and any flag from before the labels were frozen).',
    BET: 'EdgeDesk’s strongest call: sharp-confirmed, a 3%+ edge at a US-regulated book with 5+ books behind the price.',
    LEAN: 'A qualified edge with a caveat: a consensus-only fair price, an edge under 3%, an offshore best price or a thinner market.'
  };
  var FIELDS = ['flags', 'graded', 'wins', 'losses', 'pushes', 'units_risked', 'units_won', 'graded_with_close',
    'units_risked_at_close', 'units_won_at_close', 'void', 'ungraded_missing_price', 'ungraded_unsettled',
    'ungraded_unsupported', 'not_a_bet'];

  /* ------------------------------------------------------------- helpers */
  function num(x) { var n = Number(x); return x == null || x === '' || !isFinite(n) ? 0 : n; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function round2(v) { var r = Math.round(v * 100) / 100; return r === 0 ? 0 : r; }
  /** units, 2 decimals, signed: +1.23u / −0.50u / 0.00u */
  function fmtUnits(v) {
    if (v == null || !isFinite(v)) return '—';
    var r = round2(v);
    return (r > 0 ? '+' : r < 0 ? '−' : '') + Math.abs(r).toFixed(2) + 'u';
  }
  function fmtPct(v) {
    if (v == null || !isFinite(v)) return '—';
    var r = Math.round(v * 10) / 10; if (r === 0) r = 0;
    return (r > 0 ? '+' : r < 0 ? '−' : '') + Math.abs(r).toFixed(1) + '%';
  }
  function roi(won, risked) { return risked > 0 ? 100 * won / risked : null; }
  function tone(v) { var r = v == null ? 0 : round2(v); return r > 0 ? 'pos' : r < 0 ? 'neg' : 'flat'; }
  function wlp(a) { return a.wins + '-' + a.losses + '-' + a.pushes; }
  function blank() { var o = {}; FIELDS.forEach(function (f) { o[f] = 0; }); return o; }
  function add(o, r) { FIELDS.forEach(function (f) { o[f] += num(r[f]); }); return o; }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function dateLabel(d, withYear) {
    var p = String(d || '').split('-');
    if (p.length < 3) return String(d || '');
    return MON[+p[1] - 1] + ' ' + (+p[2]) + (withYear ? ', ' + p[0] : '');
  }
  function monthLabel(d) { var p = String(d || '').split('-'); return p.length < 2 ? String(d || '') : MON[+p[1] - 1] + ' ' + p[0]; }
  function sampleNote(n) {
    if (!n) return '';
    if (n < MIN_SAMPLE) return 'n=' + n + ' · too few to read anything into yet';
    if (n < 100) return 'n=' + n + ' · small sample';
    return 'n=' + n;
  }

  /* ------------------------------------------------- pure: the rollups
     rows are pnl_summary rows (one sport × one verdict, market 'ALL'); sport
     '' means every sport in rows. Returns the three cards plus the counts. */
  function aggregate(rows, sport) {
    var by = { BET: blank(), LEAN: blank(), UNLABELLED: blank(), PASS: blank() }, all = blank(), every = blank();
    (rows || []).forEach(function (r) {
      if (sport && r.sport_key !== sport) return;
      if (r.verdict === 'ALL') return;
      if (by[r.verdict]) add(by[r.verdict], r);
      if (BETS.indexOf(r.verdict) >= 0) add(all, r);
      add(every, r);
    });
    function card(a) {
      return {
        graded: a.graded, wins: a.wins, losses: a.losses, pushes: a.pushes,
        units_risked: a.units_risked, units_won: a.units_won, roi_pct: roi(a.units_won, a.units_risked),
        graded_with_close: a.graded_with_close, units_won_at_close: a.units_won_at_close,
        roi_at_close_pct: roi(a.units_won_at_close, a.units_risked_at_close)
      };
    }
    return {
      ALL: card(all), BET: card(by.BET), LEAN: card(by.LEAN), UNLABELLED: card(by.UNLABELLED),
      counts: {
        flags: every.flags, graded: every.graded, void: every.void, missing_price: every.ungraded_missing_price,
        unsettled: every.ungraded_unsettled, unsupported: every.ungraded_unsupported, not_a_bet: every.not_a_bet
      }
    };
  }

  /** the sports present, most graded first */
  function sports(rows) {
    var m = {}, out = [];
    (rows || []).forEach(function (r) {
      if (!r.sport_key || r.sport_key === 'ALL' || r.verdict === 'ALL') return;
      var s = m[r.sport_key] || (m[r.sport_key] = { key: r.sport_key, title: r.sport_title || r.sport_key, graded: 0, flags: 0 });
      s.graded += num(r.graded); s.flags += num(r.flags);
    });
    Object.keys(m).forEach(function (k) { out.push(m[k]); });
    return out.sort(function (a, b) { return b.graded - a.graded || (a.title < b.title ? -1 : 1); });
  }

  /** cumulative units by day: {dates, ALL, BET, LEAN, daily:{ALL,BET,LEAN}} */
  function series(dayRows, sport) {
    var d = {}, has = { BET: false, LEAN: false };
    (dayRows || []).forEach(function (r) {
      if (sport && r.sport_key !== sport) return;
      if (BETS.indexOf(r.verdict) < 0 || !num(r.graded)) return;
      var k = String(r.period_start).slice(0, 10);
      var o = d[k] || (d[k] = { ALL: 0, BET: 0, LEAN: 0, n: 0 });
      var u = num(r.units_won);
      o.ALL += u; o.n += num(r.graded);
      if (r.verdict === 'BET' || r.verdict === 'LEAN') { o[r.verdict] += u; has[r.verdict] = true; }
    });
    var dates = Object.keys(d).sort(), out = { dates: dates, ALL: [], BET: [], LEAN: [], daily: { ALL: [], BET: [], LEAN: [] }, n: [], has: has };
    var c = { ALL: 0, BET: 0, LEAN: 0 };
    dates.forEach(function (k) {
      ['ALL', 'BET', 'LEAN'].forEach(function (s) { c[s] += d[k][s]; out[s].push(c[s]); out.daily[s].push(d[k][s]); });
      out.n.push(d[k].n);
    });
    return out;
  }

  /** month by month (all bets, with BET and LEAN units beside) */
  function months(monthRows, sport) {
    var m = {};
    (monthRows || []).forEach(function (r) {
      if (sport && r.sport_key !== sport) return;
      if (BETS.indexOf(r.verdict) < 0) return;
      var k = String(r.period_start).slice(0, 7);
      var o = m[k] || (m[k] = { month: k, all: blank(), BET: 0, LEAN: 0 });
      add(o.all, r);
      if (r.verdict === 'BET' || r.verdict === 'LEAN') o[r.verdict] += num(r.units_won);
    });
    return Object.keys(m).sort().map(function (k) { return m[k]; }).filter(function (o) { return o.all.graded > 0; });
  }

  /* ------------------------------------------------------- the markup */
  function cardHTML(key, c) {
    var sw = key === 'ALL' || key === 'BET' || key === 'LEAN' ? '<span class="edp-sw" style="background:' + COLOR[key] + '"></span>' : '';
    if (!c.graded) {
      return '<div class="edp-card"><div class="edp-ch">' + sw + esc(NAME[key]) + '</div>' +
        '<div class="edp-u flat">—</div><div class="edp-r">Nothing graded yet</div>' +
        (MEANS[key] ? '<div class="edp-m">' + esc(MEANS[key]) + '</div>' : '') + '</div>';
    }
    var close = c.graded_with_close
      ? 'At the closing price: <b>' + fmtUnits(c.units_won_at_close) + '</b> (ROI ' + fmtPct(c.roi_at_close_pct) + ', ' + c.graded_with_close + ' with a close)'
      : 'No closing price captured for these, so no at-close comparison';
    var sn = sampleNote(c.graded);
    return '<div class="edp-card"><div class="edp-ch">' + sw + esc(NAME[key]) + '</div>' +
      '<div class="edp-u ' + tone(c.units_won) + '">' + fmtUnits(c.units_won) + '</div>' +
      '<div class="edp-r"><b>ROI ' + fmtPct(c.roi_pct) + '</b> · ' + wlp(c) + ' (W-L-P) · ' + c.graded + ' graded</div>' +
      '<div class="edp-c">' + close + '</div>' +
      (sn ? '<div class="edp-n' + (c.graded < MIN_SAMPLE ? ' warn' : '') + '">' + sn + '</div>' : '') +
      (MEANS[key] ? '<div class="edp-m">' + esc(MEANS[key]) + '</div>' : '') + '</div>';
  }

  function headline(a) {
    var c = a.ALL;
    if (!c.graded) return 'No flagged edge has settled with a flag price yet. This fills itself as games finish.';
    var r = round2(c.units_won);
    var dir = r > 0 ? 'up <b class="pos">' + fmtUnits(c.units_won).replace('+', '') + '</b>'
      : r < 0 ? 'down <b class="neg">' + fmtUnits(c.units_won).replace('−', '') + '</b>' : '<b>exactly even</b>';
    return 'Betting 1 unit on every flagged edge at the price we flagged it, you would be ' + dir +
      ' (ROI ' + fmtPct(c.roi_pct) + ') over ' + c.graded + ' settled bet' + (c.graded === 1 ? '' : 's') + '.' +
      (c.graded < MIN_SAMPLE ? ' That is too few bets to tell skill from luck, and the page will keep saying so until it is not.' : '');
  }

  function countsHTML(k) {
    function li(n, what) { return '<li><b>' + n + '</b> ' + what + '</li>'; }
    return '<div class="edp-counts"><div class="edp-ct">Not in the P&amp;L, and why</div><ul>' +
      li(k.void, 'void (no action: the stake came back, so it is counted here, not as a bet)') +
      li(k.missing_price, 'settled without a price frozen at the flag (never estimated, never the close)') +
      li(k.unsettled, 'game played, result not in yet') +
      li(k.unsupported, 'in a market the results feed cannot grade (tennis lines settle in sets, not games)') +
      li(k.not_a_bet, 'flagged, but the board showed PASS at that moment (not a bet)') +
      '</ul></div>';
  }

  function monthsHTML(ms) {
    if (!ms.length) return '';
    var h = '<details class="edp-tbl"><summary>Month by month, as a table</summary><div class="edp-scroll"><table class="edp-t"><thead><tr>' +
      '<th>Month</th><th>Graded</th><th>W-L-P</th><th>Units</th><th>ROI</th><th>BET units</th><th>LEAN units</th></tr></thead><tbody>';
    ms.forEach(function (m) {
      var a = m.all;
      h += '<tr><td>' + monthLabel(m.month) + '</td><td>' + a.graded + '</td><td>' + wlp(a) + '</td>' +
        '<td class="' + tone(a.units_won) + '">' + fmtUnits(a.units_won) + '</td><td>' + fmtPct(roi(a.units_won, a.units_risked)) + '</td>' +
        '<td class="' + tone(m.BET) + '">' + fmtUnits(m.BET) + '</td><td class="' + tone(m.LEAN) + '">' + fmtUnits(m.LEAN) + '</td></tr>';
    });
    return h + '</tbody></table></div></details>';
  }

  /* ------------------------------------------------------- the chart */
  function niceStep(span, target) {
    var raw = span / (target || 4), p = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10)), m = raw / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
  }
  function chartModel(s, w) {
    var keys = ['ALL'];
    if (s.has && s.has.BET) keys.push('BET');
    if (s.has && s.has.LEAN) keys.push('LEAN');
    var H = 240, pl = 48, pr = w >= 560 ? 104 : 14, pt = 14, pb = 28, N = s.dates.length;
    var vals = [0];
    keys.forEach(function (k) { vals = vals.concat(s[k]); });
    var mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
    var step = niceStep((mx - mn) || 1, 4);
    mn = Math.floor(mn / step) * step; mx = Math.ceil(mx / step) * step; if (mx === mn) mx = mn + step;
    return {
      keys: keys, W: w, H: H, pl: pl, pr: pr, pt: pt, pb: pb, N: N, mn: mn, mx: mx, step: step,
      X: function (i) { return pl + (N <= 1 ? (w - pl - pr) / 2 : (i / (N - 1)) * (w - pl - pr)); },
      Y: function (v) { return pt + ((mx - v) / (mx - mn)) * (H - pt - pb); }
    };
  }
  function chartSVG(s, w) {
    var M = chartModel(s, w), h = '', i, v;
    h += '<svg class="edp-svg" width="' + w + '" height="' + M.H + '" viewBox="0 0 ' + w + ' ' + M.H + '" role="img" aria-label="Cumulative units won over time">';
    for (v = M.mn; v <= M.mx + 1e-9; v += M.step) {
      var y = M.Y(v).toFixed(1), z = Math.abs(v) < 1e-9;
      h += '<line x1="' + M.pl + '" x2="' + (w - M.pr) + '" y1="' + y + '" y2="' + y + '" class="' + (z ? 'edp-zero' : 'edp-grid') + '"/>' +
        '<text x="' + (M.pl - 7) + '" y="' + (+y + 3.5) + '" class="edp-ax" text-anchor="end">' + (z ? '0u' : fmtUnits(v).replace(/\.00u$/, 'u')) + '</text>';
    }
    var xt = M.N <= 1 ? [0] : (w >= 560 ? [0, Math.floor((M.N - 1) / 2), M.N - 1] : [0, M.N - 1]);
    xt.forEach(function (ix, j) {
      h += '<text x="' + M.X(ix).toFixed(1) + '" y="' + (M.H - 8) + '" class="edp-ax" text-anchor="' + (xt.length > 1 && j === 0 ? 'start' : (j === xt.length - 1 && xt.length > 1 ? 'end' : 'middle')) + '">' +
        dateLabel(s.dates[ix], j === xt.length - 1) + '</text>';
    });
    M.keys.slice().reverse().forEach(function (k) {
      var d = '';
      for (i = 0; i < M.N; i++) d += (i ? 'L' : 'M') + M.X(i).toFixed(1) + ' ' + M.Y(s[k][i]).toFixed(1);
      if (M.N === 1) d += 'L' + (M.X(0) + 0.1).toFixed(1) + ' ' + M.Y(s[k][0]).toFixed(1);
      h += '<path d="' + d + '" fill="none" stroke="' + COLOR[k] + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
        '<circle cx="' + M.X(M.N - 1).toFixed(1) + '" cy="' + M.Y(s[k][M.N - 1]).toFixed(1) + '" r="4" fill="' + COLOR[k] + '" stroke="#191510" stroke-width="2"/>';
    });
    if (M.pr > 40) {
      /* direct labels at the line ends, pushed apart so they never collide */
      var labs = M.keys.map(function (k) { return { k: k, y: M.Y(s[k][M.N - 1]) }; }).sort(function (a, b) { return a.y - b.y; });
      for (i = 1; i < labs.length; i++) if (labs[i].y - labs[i - 1].y < 14) labs[i].y = labs[i - 1].y + 14;
      labs.forEach(function (l) {
        h += '<text x="' + (M.X(M.N - 1) + 9).toFixed(1) + '" y="' + (l.y + 3.5).toFixed(1) + '" class="edp-dl">' +
          (l.k === 'ALL' ? 'All' : l.k) + ' ' + fmtUnits(s[l.k][M.N - 1]) + '</text>';
      });
    }
    h += '<g class="edp-x" style="display:none"><line class="edp-xl" y1="' + M.pt + '" y2="' + (M.H - M.pb) + '"/>';
    M.keys.forEach(function (k) { h += '<circle data-k="' + k + '" r="4.5" fill="' + COLOR[k] + '" stroke="#191510" stroke-width="2"/>'; });
    h += '</g><rect class="edp-hit" x="' + M.pl + '" y="0" width="' + Math.max(1, w - M.pl - M.pr) + '" height="' + M.H + '" fill="transparent"/></svg>';
    return { svg: h, model: M };
  }
  function legendHTML(s, keys) {
    return '<div class="edp-legend">' + keys.map(function (k) {
      return '<span class="edp-li"><span class="edp-sw" style="background:' + COLOR[k] + '"></span>' + esc(NAME[k]) +
        ' <b>' + fmtUnits(s[k][s[k].length - 1]) + '</b></span>';
    }).join('') + '</div>';
  }

  /* ------------------------------------------------------- the mount */
  function mount(host, opts) {
    if (!host || typeof document === 'undefined') return null;
    opts = opts || {};
    var get = opts.get, keep = opts.archive ? function (r) { return r; } : (opts.dropRetired || function (r) { return r; });
    var st = { sport: '', all: [], day: [], month: [] };
    var ids = { chips: host.querySelector('[data-edp="chips"]'), head: host.querySelector('[data-edp="head"]'), cards: host.querySelector('[data-edp="cards"]'),
      chart: host.querySelector('[data-edp="chart"]'), counts: host.querySelector('[data-edp="counts"]'), table: host.querySelector('[data-edp="table"]') };

    /* every page of a read (PostgREST answers 1000 rows at a time) */
    function all(q) {
      var out = [];
      function page(off) {
        return Promise.resolve(get(q + '&limit=1000&offset=' + off)).then(function (b) {
          if (!b || !b.length) return out;
          out = out.concat(b);
          return b.length < 1000 || off >= 19000 ? out : page(off + 1000);
        });
      }
      return page(0);
    }
    var SEL = 'sport_key,sport_title,verdict,' + FIELDS.join(',');
    function load() {
      return Promise.all([
        all('pnl_summary?select=' + SEL + '&period_type=eq.all&market_type=eq.ALL&sport_key=neq.ALL&verdict=neq.ALL&order=sport_key.asc,verdict.asc'),
        all('pnl_summary?select=period_start,sport_key,verdict,graded,units_won&period_type=eq.day&market_type=eq.ALL&sport_key=neq.ALL&verdict=neq.ALL&graded=gt.0&order=period_start.asc,sport_key.asc,verdict.asc'),
        all('pnl_summary?select=period_start,sport_key,verdict,' + FIELDS.join(',') + '&period_type=eq.month&market_type=eq.ALL&sport_key=neq.ALL&verdict=neq.ALL&order=period_start.asc,sport_key.asc,verdict.asc')
      ]).then(function (r) {
        st.all = keep(r[0]); st.day = keep(r[1]); st.month = keep(r[2]);
        render();
      }).catch(function (e) {
        var missing = e && (e.status === 404 || /pnl_summary|does not exist|42P01|PGRST20[05]/.test(String((e.detail || '') + (e.body || '') + (e.message || ''))));
        ids.cards.innerHTML = '<div class="edrec-empty"><b>' + (missing ? 'The P&amp;L ledger is not deployed yet.' : 'The P&amp;L could not be read right now.') + '</b><br>' +
          (missing ? 'supabase/pnl_grades.sql, pnl_grades_sync.sql and pnl_grades_analytics.sql have not run on this database. '
            : esc(e && e.message) + '. ') + 'Nothing is shown rather than something made up.</div>';
      });
    }

    function render() {
      var sp = sports(st.all);
      if (st.sport && !sp.some(function (s) { return s.key === st.sport; })) st.sport = '';
      ids.chips.innerHTML = sp.length > 1 ? ['<button type="button" class="edrec-chip' + (st.sport ? '' : ' on') + '" data-sport="">All sports</button>']
        .concat(sp.map(function (s) {
          return '<button type="button" class="edrec-chip' + (st.sport === s.key ? ' on' : '') + '" data-sport="' + esc(s.key) + '">' + esc(s.title) + '<span class="n">' + s.graded + '</span></button>';
        })).join('') : '';
      var a = aggregate(st.all, st.sport);
      ids.head.innerHTML = '<p class="edp-head">' + headline(a) + '</p>';
      ids.cards.innerHTML = '<div class="edp-cards">' + cardHTML('ALL', a.ALL) + cardHTML('BET', a.BET) + cardHTML('LEAN', a.LEAN) + '</div>' +
        (a.UNLABELLED.graded ? '<div class="edp-note">' + a.UNLABELLED.graded + ' graded flag' + (a.UNLABELLED.graded === 1 ? ' is' : 's are') +
          ' from before the BET/LEAN inputs were frozen (' + fmtUnits(a.UNLABELLED.units_won) + '). ' +
          (a.UNLABELLED.graded === 1 ? 'It is' : 'They are') + ' in All flagged bets and in neither BET nor LEAN, rather than being given a label after the fact.</div>' : '');
      drawChart();
      ids.counts.innerHTML = countsHTML(a.counts);
      ids.table.innerHTML = monthsHTML(months(st.month, st.sport));
    }

    function drawChart() {
      var s = series(st.day, st.sport);
      if (s.dates.length < 2) {
        ids.chart.innerHTML = s.dates.length ? '<div class="edp-note">One day of results so far. The line draws itself once there is a second.</div>' : '';
        return;
      }
      var w = Math.max(280, Math.floor(ids.chart.clientWidth || host.clientWidth || 700));
      var c = chartSVG(s, w), M = c.model;
      ids.chart.innerHTML = '<div class="edp-chart">' + legendHTML(s, M.keys) + '<div class="edp-plot">' + c.svg + '<div class="edp-tip" style="display:none"></div></div>' +
        '<div class="edp-cap">Cumulative units, 1u flat on every flagged bet, by game date. The dashed line is break-even. Hover or touch the chart for any day.</div></div>';
      var plot = ids.chart.querySelector('.edp-plot'), svg = plot.querySelector('svg'), x = svg.querySelector('.edp-x'),
        xl = svg.querySelector('.edp-xl'), tip = plot.querySelector('.edp-tip'), hit = svg.querySelector('.edp-hit');
      function at(ev) {
        var r = svg.getBoundingClientRect(), p = ev.touches ? ev.touches[0] : ev;
        var px = (p.clientX - r.left) * (M.W / (r.width || M.W));
        var i = M.N <= 1 ? 0 : Math.round(((px - M.pl) / (M.W - M.pl - M.pr)) * (M.N - 1));
        i = Math.max(0, Math.min(M.N - 1, i));
        var cx = M.X(i);
        x.style.display = ''; xl.setAttribute('x1', cx); xl.setAttribute('x2', cx);
        Array.prototype.forEach.call(x.querySelectorAll('circle'), function (el) {
          var k = el.getAttribute('data-k'); el.setAttribute('cx', cx); el.setAttribute('cy', M.Y(s[k][i]));
        });
        tip.innerHTML = '<div class="edp-tt">' + dateLabel(s.dates[i], true) + ' · ' + s.n[i] + ' settled</div>' + M.keys.map(function (k) {
          return '<div class="edp-tr"><span class="edp-sw" style="background:' + COLOR[k] + '"></span>' + esc(NAME[k]) +
            '<b>' + fmtUnits(s[k][i]) + '</b><span class="edp-td">' + (s.daily[k][i] ? fmtUnits(s.daily[k][i]) + ' that day' : '') + '</span></div>';
        }).join('');
        tip.style.display = '';
        var left = cx * ((r.width || M.W) / M.W) + 14, tw = tip.offsetWidth || 200;
        if (left + tw > (r.width || M.W)) left = cx * ((r.width || M.W) / M.W) - tw - 14;
        tip.style.left = Math.max(0, left) + 'px';
      }
      function off() { x.style.display = 'none'; tip.style.display = 'none'; }
      hit.addEventListener('mousemove', at); hit.addEventListener('touchstart', at, { passive: true });
      hit.addEventListener('touchmove', at, { passive: true }); hit.addEventListener('mouseleave', off);
    }

    host.addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest('[data-sport]') : null;
      if (!b) return;
      st.sport = b.getAttribute('data-sport') || '';
      render();
    });
    var rt = null;
    if (typeof window !== 'undefined') window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { if (st.all.length) drawChart(); }, 150); });
    load();
    return { reload: load, state: st };
  }

  return {
    VERSION: VERSION, METHOD: METHOD, COLOR: COLOR, MIN_SAMPLE: MIN_SAMPLE,
    aggregate: aggregate, sports: sports, series: series, months: months,
    fmtUnits: fmtUnits, fmtPct: fmtPct, headline: headline, chartSVG: chartSVG, mount: mount
  };
}));
