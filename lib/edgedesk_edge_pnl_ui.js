/* ===========================================================================
   EDGEDESK EDGE P&L — the public record's "every flagged edge" P&L section.
   docs/pnl/EDGE_PNL.md · lib/edgedesk_edge_pnl.js (the arithmetic)

   Reads pnl_summary straight from the database with the page's anon key —
   the same way the CLV section above it does — and draws, for all sports or
   one: units won, ROI, W–L–P, the two tiers side by side, the running total
   over time, the closing-price comparison, every flag NOT counted with its
   reason, and the method note. No edit step: what the database says is what
   the page shows.

   EDEdgePnlUI.mount(host, {
     get:  function (path) → Promise<rows>   (record.html's sbGet)
     keep: function (sport_key) → boolean    (EDSPORTS: the current product)
   })
   Every string from the database is escaped or set as text.
   =========================================================================== */
(function (root) {
  'use strict';
  var K = function () { return root.EDEdgePnl; };
  var SUMMARY_COLS = 'grain,breakdown,sport_key,sport_title,tier,market_type,flags,graded,wins,losses,pushes,voids,ungraded_missing_price,'
    + 'ungraded_unsettled,outside_edge_band,units_won,units_risked,close_compared,units_won_at_close,units_won_flag_compared,units_risked_compared,'
    + 'first_game_date,last_game_date,last_computed_at';
  var SERIES = [
    { key: 'all', label: 'All flags', cls: 's1' },
    { key: 'A', label: 'Tier A', cls: 's2' },
    { key: 'B', label: 'Tier B', cls: 's3' },
    { key: 'legacy', label: 'Older flags', cls: 's4' }
  ];
  var PAGE = 1000;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function toneCls(v) { var t = K().tone(v); return t === 'pos' ? 'edp2-pos' : t === 'neg' ? 'edp2-neg' : ''; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function dateShort(d) {
    if (!d) return '';
    var x = new Date(String(d).slice(0, 10) + 'T12:00:00Z');
    return isNaN(x) ? String(d) : x.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }
  function dateLong(d) {
    if (!d) return '';
    var x = new Date(String(d).slice(0, 10) + 'T12:00:00Z');
    return isNaN(x) ? String(d) : x.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  }

  /* PostgREST pages at the project's max-rows; read until a short page */
  function getAll(get, q) {
    var out = [];
    function next(off) {
      return Promise.resolve(get(q + '&limit=' + PAGE + '&offset=' + off)).then(function (b) {
        b = b || []; out = out.concat(b);
        return b.length < PAGE || off > 200000 ? out : next(off + PAGE);
      });
    }
    return next(0);
  }
  function notDeployed(e) {
    var m = String((e && (e.detail || e.message)) || '');
    return (e && e.status === 404) || /PGRST205|42P01|does not exist|Could not find the table|schema cache/i.test(m);
  }

  function mount(host, opts) {
    if (!host || !K()) return null;
    opts = opts || {};
    var S = { host: host, get: opts.get, keep: opts.keep || function () { return true; }, sport: null, all: null, days: null, err: null };
    host.classList.add('edp2');
    host.innerHTML = '<div class="edp2-empty">Loading the profit &amp; loss of every flagged edge…</div>';
    if (typeof S.get !== 'function') { host.innerHTML = '<div class="edp2-empty">This section needs the database reader.</div>'; return S; }
    Promise.all([
      getAll(S.get, 'pnl_summary?select=' + SUMMARY_COLS + '&grain=eq.all&sport_key=not.is.null&order=sport_key.asc'),
      getAll(S.get, 'pnl_summary?select=period_start,sport_key,tier,graded,units_won&grain=eq.day&breakdown=eq.sport%2Btier&order=period_start.asc')
    ]).then(function (r) {
      S.all = r[0]; S.days = r[1]; render(S);
    }).catch(function (e) {
      S.err = e;
      host.innerHTML = notDeployed(e)
        ? '<div class="edp2-empty"><b>Profit &amp; loss for flagged edges is being switched on.</b><br>The table that holds it (supabase/signal_pnl.sql) is not in the database yet. This section shows nothing rather than a number from somewhere else.</div>'
        : '<div class="edp2-empty"><b>This section could not reach its database.</b><br>' + esc(e && e.message) + '<br>It shows nothing rather than something made up.</div>';
    });
    var t = null;
    root.addEventListener && root.addEventListener('resize', function () {
      if (!S.all) return;
      clearTimeout(t); t = setTimeout(function () { var w = host.clientWidth; if (w && w !== S.lastW) drawChart(S); }, 150);
    });
    return S;
  }

  function render(S) {
    var P = K(), v = P.view(S.all, S.days, { keep: S.keep, sport: S.sport });
    S.v = v;
    if (S.sport && !v.sports.some(function (s) { return s.key === S.sport; })) { S.sport = null; return render(S); }
    var t = v.total, h = '';
    /* one row above everything it scopes */
    if (v.sports.length > 1) {
      h += '<div class="edp2-chips" role="group" aria-label="Sport">'
        + '<button type="button" class="edp2-chip' + (S.sport ? '' : ' on') + '" data-sport="" aria-pressed="' + (!S.sport) + '">All sports</button>'
        + v.sports.map(function (s) {
          return '<button type="button" class="edp2-chip' + (S.sport === s.key ? ' on' : '') + '" data-sport="' + esc(s.key) + '" aria-pressed="' + (S.sport === s.key) + '">'
            + esc(s.title) + '<span class="n">' + s.graded + '</span></button>';
        }).join('') + '</div>';
    }
    var scopeName = S.sport ? (v.sports.filter(function (s) { return s.key === S.sport; })[0] || {}).title : null;
    if (!t.flags) {
      h += '<div class="edp2-empty"><b>No flagged edge has reached its close yet' + (scopeName ? ' in ' + esc(scopeName) : '') + '.</b><br>'
        + 'Each one is graded here the moment it settles, at the price it was flagged at. Nothing is drawn from a guess.</div>';
      h += notCounted(t) + method();
      S.host.innerHTML = h; wire(S); return;
    }
    var smp = v.sample;
    h += '<div class="edp2-samplebar' + (smp.warn ? ' warn' : '') + '"><b>' + plural(t.graded, 'graded bet', 'graded bets') + '</b>'
      + (scopeName ? ' in ' + esc(scopeName) : '') + ' · ' + esc(smp.label)
      + (smp.warn ? ' — a short run of results says very little; the closing-line value above is the steadier measure.' : '') + '</div>';
    var up = t.units_won >= 0;
    h += '<div class="edp2-hero"><div class="edp2-big ' + toneCls(t.units_won) + '">' + esc(P.fmtUnits(t.units_won)) + '</div>'
      + '<p class="edp2-say">If you had bet <b>1 unit</b> on every edge EdgeDesk flagged' + (scopeName ? ' in ' + esc(scopeName) : '')
      + ', at the price on the screen when it was flagged, you would be <b>' + (Math.abs(t.units_won) < 0.005 ? 'exactly even' : (up ? 'up ' : 'down ') + Math.abs(Math.round(t.units_won * 100) / 100).toFixed(2) + ' units')
      + '</b> after ' + plural(t.graded, 'bet', 'bets') + '.</p></div>';
    h += '<div class="edp2-kpis">'
      + kpi(P.fmtPct(t.roi_pct), 'ROI', 'units won for every unit risked', toneCls(t.roi_pct))
      + kpi(P.fmtRecord(t), 'Record (W–L–P)', t.win_pct == null ? 'no decided bets yet' : Math.round(t.win_pct) + '% of decided bets won')
      + kpi(String(t.graded), 'Bets graded', t.first_game_date ? dateShort(t.first_game_date) + ' – ' + dateShort(t.last_game_date) : '')
      + kpi(String(t.not_counted), 'Not counted', 'void, missing price or no result yet — see below')
      + '</div>';
    /* BET vs LEAN on this record is Tier A vs Tier B: frozen when flagged */
    h += '<div class="edp2-sh"><h3>Split by how the price was checked</h3><span class="edp2-subh">the tier is fixed the moment the edge is flagged</span></div>'
      + '<div class="edp2-tiers">' + v.tiers.map(function (x) { return tierCard(x); }).join('') + '</div>';
    h += '<div class="edp2-sh"><h3>Running total</h3><span class="edp2-subh">units, game day by game day</span></div>'
      + '<div class="edp2-legend">' + SERIES.filter(function (s) { return seriesOn(v, s.key); }).map(function (s) {
        return '<span><i class="k ' + s.cls + '"></i>' + esc(s.label) + '</span>';
      }).join('') + '</div>'
      + '<div class="edp2-chart" data-chart></div>'
      + table(v);
    h += closeLine(t) + markets(v) + notCounted(t) + method();
    S.host.innerHTML = h;
    wire(S);
    drawChart(S);
  }

  function kpi(v, l, s, cls) {
    return '<div class="edp2-kpi"><div class="v ' + (cls || '') + '">' + esc(v) + '</div><div class="l">' + esc(l) + '</div>' + (s ? '<div class="s">' + esc(s) + '</div>' : '') + '</div>';
  }
  function tierCard(x) {
    var P = K(), smp = P.sampleLabel(x.graded);
    return '<div class="edp2-tier t-' + esc(x.tier.key) + '">'
      + '<div class="edp2-th"><span class="tag">' + esc(x.tier.label) + '</span><span class="nm">' + esc(x.tier.name) + '</span></div>'
      + '<p class="edp2-tb">' + esc(x.tier.blurb) + '</p>'
      + (x.graded ? '<div class="edp2-tn ' + toneCls(x.units_won) + '">' + esc(P.fmtUnits(x.units_won)) + '</div>'
        + '<div class="edp2-tr"><span>ROI <b class="' + toneCls(x.roi_pct) + '">' + esc(P.fmtPct(x.roi_pct)) + '</b></span><span>W–L–P <b>' + esc(P.fmtRecord(x)) + '</b></span>'
        + '<span class="edp2-pill' + (smp.warn ? ' warn' : '') + '">n=' + x.graded + ' · ' + esc(smp.label) + '</span></div>'
        : '<div class="edp2-tn edp2-mut">No graded bet yet</div>')
      + '</div>';
  }
  function seriesOn(v, key) {
    if (key === 'all') return true;
    return v.tiers.some(function (t) { return t.tier.key === key && t.graded > 0; });
  }
  function closeLine(t) {
    var P = K();
    if (!t.close_compared) return '';
    return '<div class="edp2-close"><b>At the closing price instead:</b> the same ' + plural(t.close_compared, 'bet', 'bets') + ' would be '
      + '<b class="' + toneCls(t.units_won_at_close) + '">' + esc(P.fmtUnits(t.units_won_at_close)) + '</b> (ROI ' + esc(P.fmtPct(t.roi_at_close_pct)) + '), against '
      + '<b class="' + toneCls(t.units_won_flag_compared) + '">' + esc(P.fmtUnits(t.units_won_flag_compared)) + '</b> (ROI ' + esc(P.fmtPct(t.roi_flag_compared_pct)) + ') at the price we flagged. '
      + 'For comparison only: nobody could bet the closing price when the edge was flagged.'
      + (t.close_compared < t.graded ? ' ' + plural(t.graded - t.close_compared, 'bet has', 'bets have') + ' no closing book price and are left out of this comparison.' : '') + '</div>';
  }
  function markets(v) {
    var P = K();
    if (v.markets.length < 2) return '';
    return '<div class="edp2-sh"><h3>By bet type</h3></div><div class="edp2-scroll"><table class="edp2-t"><thead><tr><th class="l">Bet type</th><th>Bets</th><th>W–L–P</th><th>Units</th><th>ROI</th></tr></thead><tbody>'
      + v.markets.map(function (m) {
        return '<tr><td class="l">' + esc(m.label) + '</td><td>' + m.graded + '</td><td>' + esc(P.fmtRecord(m)) + '</td><td class="' + toneCls(m.units_won) + '">' + esc(P.fmtUnits(m.units_won))
          + '</td><td class="' + toneCls(m.roi_pct) + '">' + esc(P.fmtPct(m.roi_pct)) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  function notCounted(t) {
    var items = [
      [t.voids, 'void', 'the game or bet was cancelled, so there was no bet'],
      [t.ungraded_missing_price, 'missing the price', 'no price was saved when it was flagged, and EdgeDesk never estimates one'],
      [t.ungraded_unsettled, 'waiting on a result', 'the game has started or finished and the result is not in yet'],
      [t.outside_edge_band, 'outside the edge band', 'flagged at an edge below 0.5% or above 10% — left out here exactly as in the CLV record above']
    ];
    return '<div class="edp2-sh"><h3>Not in these numbers</h3><span class="edp2-subh">counted, never priced</span></div><div class="edp2-nc">'
      + items.map(function (x) { return '<div class="edp2-nci"><div class="n">' + (x[0] || 0) + '</div><div class="l">' + esc(x[1]) + '</div><div class="s">' + esc(x[2]) + '</div></div>'; }).join('')
      + '</div>';
  }
  function method() {
    return '<p class="edp2-method"><b>' + esc(K().METHOD_NOTE) + '</b> ROI is units won divided by units risked; a push hands the stake back, so it is not counted as risked. '
      + 'Read live from the database the moment each game settles; no number on this section is edited by hand.</p>';
  }
  /* the chart's numbers, for anyone who cannot or would rather not read a chart */
  function table(v) {
    var P = K();
    if (!v.series.length) return '';
    var on = SERIES.filter(function (s) { return seriesOn(v, s.key); });
    return '<details class="edp2-tbl"><summary>See the running total as a table</summary><div class="edp2-scroll"><table class="edp2-t"><thead><tr><th class="l">Game day</th><th>Bets</th>'
      + on.map(function (s) { return '<th>' + esc(s.label) + '</th>'; }).join('') + '</tr></thead><tbody>'
      + v.series.slice().reverse().map(function (p) {
        return '<tr><td class="l">' + esc(dateLong(p.date)) + '</td><td>' + p.bets + '</td>' + on.map(function (s) { return '<td class="' + toneCls(p[s.key]) + '">' + esc(P.fmtUnits(p[s.key])) + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table></div></details>';
  }

  function wire(S) {
    Array.prototype.forEach.call(S.host.querySelectorAll('[data-sport]'), function (b) {
      b.addEventListener('click', function () { S.sport = b.getAttribute('data-sport') || null; render(S); });
    });
  }

  /* ------------------------------------------------------------ the chart
     Running total in units: 2px lines (all flags, then each tier), a zero
     line, a crosshair that snaps to the nearest game day and lists every
     series, end labels when they do not collide, arrows on the keyboard. */
  function drawChart(S) {
    var box = S.host.querySelector('[data-chart]'), v = S.v, P = K();
    if (!box || !v) return;
    var ser = v.series;
    if (!ser.length) { box.innerHTML = '<div class="edp2-empty">No graded bet yet. The line starts at the first one.</div>'; return; }
    var on = SERIES.filter(function (s) { return seriesOn(v, s.key); });
    var W = Math.max(300, Math.round(box.clientWidth || 640)), H = W < 480 ? 220 : 260;
    S.lastW = W;
    var padL = 50, padR = W < 480 ? 64 : 78, padT = 14, padB = 30;
    var origin = { date: null, all: 0, A: 0, B: 0, legacy: 0, bets: 0, day: 0 };
    var pts = [origin].concat(ser), n = pts.length - 1;
    var lo = 0, hi = 0;
    pts.forEach(function (p) { on.forEach(function (s) { lo = Math.min(lo, p[s.key]); hi = Math.max(hi, p[s.key]); }); });
    if (hi - lo < 1) { hi += 0.5; lo -= 0.5; }
    var span = hi - lo; lo -= span * 0.08; hi += span * 0.08;
    function X(i) { return padL + (n ? i / n : 0) * (W - padL - padR); }
    function Y(val) { return padT + (hi - val) / (hi - lo) * (H - padT - padB); }
    var step = niceStep((hi - lo) / 5), svg = '';
    svg += '<svg class="edp2-svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" tabindex="0" aria-label="Running total in units over '
      + n + ' game days, ending at ' + esc(P.fmtUnits(ser[ser.length - 1].all)) + ' for all flags. Use the left and right arrow keys to read each game day.">';
    for (var tv = Math.ceil(lo / step) * step; tv <= hi + 1e-9; tv += step) {
      var r = Math.round(tv * 1000) / 1000, y = Y(r);
      svg += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '" class="' + (Math.abs(r) < 1e-9 ? 'edp2-zero' : 'edp2-grid') + '"/>'
        + '<text x="' + (padL - 6) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end" class="edp2-ax">' + esc(axisU(r)) + '</text>';
    }
    [1, Math.ceil(n / 2), n].filter(function (i, k, a) { return i >= 1 && a.indexOf(i) === k; }).forEach(function (i, k, a) {
      var anchor = a.length > 1 && k === 0 ? 'start' : (k === a.length - 1 && a.length > 1 ? 'end' : 'middle');
      svg += '<text x="' + X(i).toFixed(1) + '" y="' + (H - 9) + '" text-anchor="' + anchor + '" class="edp2-ax">' + esc(dateShort(pts[i].date)) + '</text>';
    });
    /* tiers first, all flags on top */
    on.slice().reverse().forEach(function (s) {
      var d = '';
      pts.forEach(function (p, i) { d += (i ? ' L' : 'M') + X(i).toFixed(1) + ' ' + Y(p[s.key]).toFixed(1); });
      svg += '<path d="' + d + '" class="edp2-line ' + s.cls + '"/>';
    });
    var last = pts[n];
    /* end labels only when they separate; otherwise the legend and tooltip carry identity */
    var ends = on.map(function (s) { return { s: s, y: Y(last[s.key]), v: last[s.key] }; }).sort(function (a, b) { return a.y - b.y; });
    var clash = ends.some(function (e, i) { return i && e.y - ends[i - 1].y < 14; });
    ends.forEach(function (e) {
      svg += '<circle cx="' + X(n).toFixed(1) + '" cy="' + e.y.toFixed(1) + '" r="4" class="edp2-end ' + e.s.cls + '"/>';
      if (!clash || e.s.key === 'all') {
        svg += '<text x="' + (X(n) + 8).toFixed(1) + '" y="' + (e.y + 4).toFixed(1) + '" class="edp2-endlab">' + esc(P.fmtUnits(e.v)) + '</text>';
      }
    });
    svg += '<line class="edp2-cross" x1="0" x2="0" y1="' + padT + '" y2="' + (H - padB) + '" visibility="hidden"/>';
    on.forEach(function (s) { svg += '<circle class="edp2-hit ' + s.cls + '" data-k="' + s.key + '" r="4" cx="0" cy="0" visibility="hidden"/>'; });
    svg += '<rect class="edp2-over" x="' + padL + '" y="0" width="' + (W - padL - padR) + '" height="' + H + '"/></svg>';
    box.innerHTML = svg + '<div class="edp2-tip" hidden></div>';
    var el = box.querySelector('svg'), tip = box.querySelector('.edp2-tip'), cross = el.querySelector('.edp2-cross'), cur = null;
    function show(i) {
      i = Math.max(1, Math.min(n, i)); cur = i;
      var p = pts[i], x = X(i);
      cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('visibility', 'visible');
      Array.prototype.forEach.call(el.querySelectorAll('.edp2-hit'), function (c) {
        c.setAttribute('cx', x); c.setAttribute('cy', Y(p[c.getAttribute('data-k')])); c.setAttribute('visibility', 'visible');
      });
      while (tip.firstChild) tip.removeChild(tip.firstChild);
      var hd = document.createElement('div'); hd.className = 'edp2-tip-d'; hd.textContent = dateLong(p.date); tip.appendChild(hd);
      var sb = document.createElement('div'); sb.className = 'edp2-tip-s';
      sb.textContent = P.fmtUnits(p.day) + ' that day · ' + plural(p.bets, 'bet', 'bets') + ' graded so far';
      tip.appendChild(sb);
      on.forEach(function (s) {
        var row = document.createElement('div'); row.className = 'edp2-tip-r';
        var key = document.createElement('i'); key.className = 'k ' + s.cls; row.appendChild(key);
        var val = document.createElement('b'); val.textContent = P.fmtUnits(p[s.key]); row.appendChild(val);
        var nm = document.createElement('span'); nm.textContent = s.label; row.appendChild(nm);
        tip.appendChild(row);
      });
      tip.hidden = false;
      var bw = box.clientWidth || W, tw = tip.offsetWidth || 200, sc = bw / W;
      var left = x * sc + 12; if (left + tw > bw - 4) left = Math.max(4, x * sc - tw - 12);
      tip.style.left = left + 'px'; tip.style.top = Math.max(4, padT * sc) + 'px';
    }
    function hide() { cross.setAttribute('visibility', 'hidden'); Array.prototype.forEach.call(el.querySelectorAll('.edp2-hit'), function (c) { c.setAttribute('visibility', 'hidden'); }); tip.hidden = true; }
    function at(evt) {
      var rc = el.getBoundingClientRect(), cx = (evt.touches ? evt.touches[0].clientX : evt.clientX) - rc.left;
      return Math.round(((cx * (W / rc.width) - padL) / (W - padL - padR)) * n);
    }
    el.addEventListener('pointermove', function (e) { show(at(e)); });
    el.addEventListener('pointerdown', function (e) { show(at(e)); });
    el.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse') hide(); });
    el.addEventListener('blur', hide);
    el.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); show((cur == null ? n : cur) + (e.key === 'ArrowRight' ? 1 : -1)); }
      else if (e.key === 'Home') { e.preventDefault(); show(1); } else if (e.key === 'End') { e.preventDefault(); show(n); } else if (e.key === 'Escape') hide();
    });
  }
  function niceStep(raw) {
    if (!(raw > 0)) return 1;
    var p = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10)), m = raw / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
  }
  function axisU(v) { var r = Math.round(v * 100) / 100; return (r > 0 ? '+' : r < 0 ? '−' : '') + Math.abs(r) + 'u'; }

  root.EDEdgePnlUI = { mount: mount, render: render, SERIES: SERIES };
}(typeof self !== 'undefined' ? self : this));
