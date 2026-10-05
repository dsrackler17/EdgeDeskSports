/* ===========================================================================
   EDGEDESK PORTFOLIO — the Decision Grade, the Calendar, the Journal and the
   Process Coach, as pure renderers (data in, HTML out).
   docs/portfolio-journal.md

   Every figure here arrives from the server's aggregates
   (supabase/portfolio_journal.sql) or from EDPortfolioProcess over them; the
   page never downloads a lifetime to draw any of it. Every claim carries its
   sample, and a WHY that names its data, period, comparison, calculation,
   confidence and limits. Nothing here says BET or DON'T BET, labels the
   reader, or recommends more, larger or faster betting.

   Browser: window.EDPortfolioJournalUI.   Node: require('./edgedesk_portfolio_journal_ui.js').
   =========================================================================== */
(function (root, factory) {
  var req = typeof require === 'function' ? require : null;
  var E = root.EDPortfolio || (req ? req('./edgedesk_portfolio.js') : null);
  var X = root.EDPortfolioProcess || (req ? req('./edgedesk_portfolio_process.js') : null);
  var api = factory(E, X);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EDPortfolioJournalUI = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (E, X) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function n(x) { return x == null || x === '' ? null : Number(x); }
  function str(x) { return x == null ? null : String(x); }
  function tone(x) { return x == null ? '' : 'pfo-' + E.tone(String(x)); }
  function money(x, sign) { return x == null ? '—' : E.money(String(x), sign ? { sign: true } : undefined); }
  function signed(x) { return '<span class="pfo-num ' + tone(x) + '">' + esc(money(x, true)) + '</span>'; }
  function pct(x, digits) { if (x == null || !isFinite(+x)) return '—'; var v = 100 * +x; return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(digits == null ? 1 : digits) + '%'; }
  function plural(k, word) { return k + ' ' + word + (k === 1 ? '' : 's'); }
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var DOW_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  function dayLabel(d) {
    var p = String(d).split('-'); if (p.length < 3) return String(d);
    var dt = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    return DOW_SHORT[(dt.getUTCDay() + 6) % 7] + ' ' + MONTHS[+p[1] - 1].slice(0, 3) + ' ' + (+p[2]) + ', ' + p[0];
  }
  function whyBtn(id, label) { return '<button class="pfo-why" data-act="why" data-id="' + esc(id) + '" aria-label="Why: ' + esc(label || 'how this was calculated') + '">WHY?</button>'; }

  /* ═══ the Decision Grade card ═════════════════════════════════════════ */
  function gradeCard(proc, opts) {
    opts = opts || {};
    if (!proc) return '';
    var graded = +proc.graded || 0, letter = proc.letter, conf = proc.confidence || X.confidence(graded);
    var h = '<section class="pfo-sec pfo-grade" aria-label="Decision Grade"><div class="pfo-sec-h">Decision Grade'
      + '<span class="pfo-right">' + whyBtn('grade', 'the Decision Grade') + '</span></div>';
    if (!graded) {
      return h + '<div class="pfo-grade-row"><div class="pfo-letter none" aria-hidden="true">—</div><div><b>Not graded yet.</b>'
        + '<div class="pfo-note">A Decision Grade needs a price to judge the decision by: a closing price, a model probability recorded before the event, '
        + 'or the price you researched. ' + plural(+proc.n || 0, 'position') + ' in this period; none has one recorded yet. '
        + 'Add a closing price or your decision context from a position\'s journal.</div></div></div></section>';
    }
    /* the engine's evidence rule: no letter below GRADE_MIN graded positions */
    if (graded < GRADE_MIN) {
      return h + '<div class="pfo-grade-row"><div class="pfo-letter none" aria-hidden="true">—</div><div><b>Building.</b>'
        + '<div class="pfo-note">' + graded + ' of ' + plural(+proc.n || 0, 'position') + ' graded. A Decision Grade is given from ' + GRADE_MIN
        + ' graded positions — below that its confidence is “Building” and a letter would mostly reflect chance.</div></div></div>' + (opts.evidence ? evidenceLine(opts.evidence) : '') + '</section>';
    }
    h += '<div class="pfo-grade-row"><div class="pfo-letter ' + esc(String(letter).charAt(0)) + '" aria-label="Grade ' + esc(letter) + '">' + esc(letter) + '</div><div>'
      + '<div class="pfo-grade-score"><b class="pfo-num">' + esc((+proc.score).toFixed(1)) + '</b> / 100 process score</div>'
      + '<div class="pfo-note"><b>' + graded + '</b> of ' + plural(+proc.n || 0, 'position') + ' graded · confidence <b>' + esc(conf) + '</b>'
      + (proc.coverage != null ? ' · average weight of evidence ' + esc((+proc.coverage).toFixed(0)) + '%' : '') + '</div>'
      + '<div class="pfo-note">Graded on the decision — price, timing, sizing, your rules — never on whether it won.</div></div></div>';
    var c = proc.components || {};
    h += '<div class="pfo-comps">' + X.COMPONENTS.map(function (k) {
      var x = c[k] || {}, v = n(x.avg);
      return '<div class="pfo-comp"><div class="pfo-comp-n">' + esc(X.COMPONENT_LABEL[k]) + ' <small>' + X.WEIGHTS[k] + '%</small></div>'
        + (v == null ? '<div class="pfo-comp-v pfo-mut">not recorded</div>'
          : '<div class="pfo-comp-v"><span class="pfo-meter" aria-hidden="true"><i style="width:' + Math.max(2, Math.min(100, v)) + '%"></i></span><b class="pfo-num">' + v.toFixed(1) + '</b> <small>n=' + x.n + '</small></div>')
        + '</div>';
    }).join('') + '</div>';
    if (opts.evidence) h += evidenceLine(opts.evidence);
    return h + '</section>';
  }
  function evidenceLine(ev) {
    if (!ev) return '';
    var t = (+ev.full || 0) + (+ev.partial || 0) + (+ev.result_only || 0);
    if (!t) return '';
    return '<div class="pfo-note">What EdgeDesk knows about these decisions: <b>' + (+ev.full || 0) + '</b> full context · <b>' + (+ev.partial || 0)
      + '</b> partial (market prices, not your reasoning) · <b>' + (+ev.result_only || 0) + '</b> result only. A result-only position is never graded.</div>';
  }

  /* ═══ What's working / What's not ═════════════════════════════════════ */
  function levelBadge(level) { return '<span class="pfo-level ' + esc(level) + '">' + esc(X.LEVEL_LABEL[level] || level) + '</span>'; }
  function findingRow(f) {
    return '<div class="pfo-find ' + (f.kind === 'LEAK' ? 'leak' : 'strength') + '"><div class="pfo-find-h"><b>' + esc(f.headline) + '</b> ' + levelBadge(f.level)
      + whyBtn('f:' + f.id, f.headline) + '</div><div class="pfo-note">' + esc(f.text) + '</div>'
      + (f.impact != null && isFinite(f.impact) && f.metric !== 'ps' ? '<div class="pfo-note">Estimated effect over the money staked in this group: <b>'
        + esc(money(Math.round(f.impact * 100) / 100, true)) + '</b> (an estimate from the averages, not a recorded figure).</div>' : '')
      + '<div class="pfo-btns"><button class="pfo-btn ghost sm" data-act="drill" data-dim="' + esc(f.dim) + '" data-key="' + esc(f.key) + '">See these ' + f.cell.n + ' positions</button></div></div>';
  }
  function insights(hl, opts) {
    opts = opts || {};
    if (!hl) return '';
    var h = '<div class="pfo-split">';
    h += '<section class="pfo-sec"><div class="pfo-sec-h">What\'s working</div>' + (hl.working.length ? hl.working.map(findingRow).join('')
      : '<div class="pfo-note">No strength clears the evidence bar yet.</div>') + '</section>';
    h += '<section class="pfo-sec"><div class="pfo-sec-h">What\'s not</div>' + (hl.not_working.length ? hl.not_working.map(findingRow).join('')
      : '<div class="pfo-none"><b>' + esc(hl.none_text) + '</b><div class="pfo-note">' + esc(hl.none_detail) + '</div></div>') + '</section>';
    return h + '</div>';
  }

  /* ═══ WHY ═════════════════════════════════════════════════════════════ */
  var GRADE_WHY = {
    title: 'How the Decision Grade is calculated',
    rows: [['What it measures', 'The quality of each decision at the moment it was made — never whether it won.'],
      ['Components and weights', 'Closing line value 30% · model edge at entry 20% · price quality 15% · sizing discipline 15% · entry timing 10% · rule adherence 5% · market structure 5%.'],
      ['Missing data', 'A component with no recorded data is left out and the weights of the rest are scaled up to 100%. No points are ever given for data that does not exist.'],
      ['When a position is graded', 'Only with at least one price-based component (closing line value, model edge, price quality or timing) and at least 30% of the weight.'],
      ['Pre-event only', 'A model probability or research price counts only if it was recorded before the event started (or before settlement when no start time is known).'],
      ['Letters', 'A+ 90+ · A 84+ · A− 78+ · B+ 72+ · B 66+ · B− 60+ · C+ 55+ · C 45+ · C− 40+ · D 30+ · F below 30. 50 is the closing price itself.'],
      ['Confidence', 'Building under 10 graded positions · Low 10–29 · Medium 30–99 · High 100+.'],
      ['Limitations', 'Closing prices you enter yourself are your own record. Market structure is a typical margin for the market type, not this market\'s measured margin.']]
  };
  function whyPanel(item) {
    if (!item) return '';
    var w = item.why, g = w && w.group;
    var rows = item.rows || (w ? [['Positions', g ? plural(g.positions, 'position') + ' in the group, ' + g.settled + ' settled' : null],
      ['Date range', w.period || 'The period shown'], ['Data used', w.data_used], ['Sample size', w.sample], ['Comparison group', w.comparison],
      ['P&L', g && g.pnl != null ? money(g.pnl, true) + ' on ' + plural(g.settled, 'settled position') : null],
      ['ROI', g ? (+g.staked > 0 ? pct(E.dec.divRound(g.pnl, g.staked, 6), 2) : 'n/a — nothing in the group has settled') : null],
      ['CLV', g ? (g.clv_n ? pct(g.clv_mean, 2) + ' on average, over the ' + g.clv_n + ' with a closing price' : 'No closing price is recorded for these positions') : null],
      ['Confidence', w.confidence], ['Methodology', w.calculation], ['Limitations', w.limitations]] : []);
    return '<div class="pfo-panel" role="dialog" aria-modal="true" aria-label="' + esc(item.title || 'Why') + '"><div class="pfo-panel-h"><div class="pfo-panel-t">'
      + esc(item.title || ('Why: ' + (item.headline || ''))) + '</div><button class="pfo-x" data-act="why-close" aria-label="Close">×</button></div>'
      + '<dl class="pfo-why-dl">' + rows.filter(function (r) { return r[1]; }).map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>'; }).join('') + '</dl>'
      + (item.why && item.why.positions ? '<div class="pfo-btns"><button class="pfo-btn ghost sm" data-act="drill" data-dim="' + esc(item.why.positions.dim) + '" data-key="' + esc(item.why.positions.key) + '">List the positions</button></div>' : '')
      + (item.journal ? '<div class="pfo-btns"><button class="pfo-btn ghost sm" data-act="journal" data-id="' + esc(item.journal) + '">Open its journal</button></div>' : '')
      + '</div>';
  }

  /* ═══ the platform filter (one combined book, or one platform) ═══════ */
  function platformChips(accounts, current) {
    var seen = {}, list = [];
    (accounts || []).forEach(function (a) { if (!seen[a.platform]) { seen[a.platform] = 1; list.push([a.platform, a.platform_label]); } });
    var opts = [['', 'All platforms'], ['type:SPORTSBOOK', 'Sportsbooks'], ['type:PREDICTION_MARKET', 'Prediction markets']].concat(list);
    return '<div class="pfo-chips pfo-plats" role="group" aria-label="Platform">' + opts.map(function (o) {
      return '<button class="pfo-chip" data-act="platform" data-v="' + esc(o[0]) + '" aria-pressed="' + (String(current || '') === o[0]) + '">' + esc(o[1]) + '</button>';
    }).join('') + '</div>';
  }

  /* ═══ the server-summary hero ═════════════════════════════════════════ */
  function hero(sm, periodLabel) {
    var st = (sm && sm.settled) || {}, pnl = st.pnl == null ? 0 : st.pnl, g = +pnl > 0 ? 1 : +pnl < 0 ? -1 : 0;
    var rec = (+st.wins || 0) + '–' + (+st.losses || 0) + ((+st.pushes || 0) ? '–' + st.pushes : '');
    var open = (sm && sm.open) || {};
    return '<section class="pfo-hero ' + (g > 0 ? 'up' : g < 0 ? 'down' : '') + '" aria-label="Total profit and loss">'
      + '<div class="pfo-hero-ey">Total P&amp;L · ' + esc(periodLabel || 'all time') + ' · by settlement date</div>'
      + '<div class="pfo-big ' + tone(pnl) + '">' + esc(money(pnl, true)) + '</div>'
      + '<div class="pfo-hero-sub">' + plural(+st.n || 0, 'settled position') + ' · ' + plural(+((sm && sm.placed && sm.placed.n) || 0), 'position') + ' entered in the period</div>'
      + '<div class="pfo-kpis">'
      + '<div><div class="pfo-k">ROI</div><div class="pfo-v ' + tone(st.roi) + '">' + esc(st.roi != null ? pct(st.roi, 2) : '—') + '</div></div>'
      + '<div><div class="pfo-k">Capital settled</div><div class="pfo-v">' + esc(money(st.staked || 0)) + '</div></div>'
      + '<div><div class="pfo-k">Open exposure</div><div class="pfo-v">' + esc(money(open.exposure || 0)) + ' <small>' + (+open.n || 0) + ' open</small></div></div>'
      + '<div><div class="pfo-k">Record</div><div class="pfo-v">' + esc(rec) + (+st.cashouts ? ' <small>+' + st.cashouts + ' cash-out</small>' : '') + '</div></div>'
      + '</div></section>'
      + '<div class="pfo-split">' + [['sportsbook', 'Sportsbook P&amp;L'], ['prediction', 'Prediction-market P&amp;L']].map(function (k) {
        var t = st[k[0]] || {};
        return '<section class="pfo-sec"><div class="pfo-sec-h">' + k[1] + '</div><div class="pfo-split-v ' + tone(t.pnl) + '">' + esc(money(t.pnl || 0, true)) + '</div>'
          + '<div class="pfo-split-s">' + plural(+t.n || 0, 'settled position') + (+t.staked > 0 ? ' · ROI ' + esc(pct(+t.pnl / +t.staked, 2)) : '') + '</div></section>';
      }).join('') + '</div>';
  }

  /* ═══ the Calendar ════════════════════════════════════════════════════ */
  var BASIS = [['placed', 'Entered'], ['event', 'Events'], ['settled', 'Settled']];
  /* a day cell's P&L on a phone: whole dollars, then thousands — "+$45",
     "−$1.2k". The cell's label, the desktop cell and the day panel carry the
     exact amount; an ellipsis ("−$10…") would read as a different number. */
  function compactMoney(x) {
    var g = E.dec.sign(x);
    if (!g) return '$0';
    var a = E.dec.str(x).replace(/^-/, ''), sg = g < 0 ? '−' : '+', w = E.dec.round(a, 0);
    if (E.dec.sign(w) === 0) return E.dec.sign(E.dec.round(a, 2)) ? sg + '$' + E.dec.fixed(a, 2) : '<$0.01';
    if (E.dec.cmp(w, '1000') < 0) return sg + '$' + w;
    /* one decimal under ten of a unit, none from ten up: "$1.2k", "$12k", "$1M" */
    var units = [['1000000000', 'B'], ['1000000', 'M'], ['1000', 'k']];
    function scaled(u) { var v = E.dec.divRound(a, u[0], 1); return E.dec.cmp(v, '10') >= 0 ? E.dec.round(v, 0) : v; }
    for (var i = 0; i < units.length; i++) {
      if (E.dec.cmp(w, units[i][0]) < 0) continue;
      var v = scaled(units[i]);
      /* $999,960 reads as $1M, not $1000k */
      if (i > 0 && E.dec.cmp(v, '1000') >= 0) return sg + '$' + scaled(units[i - 1]) + units[i - 1][1];
      return sg + '$' + v + units[i][1];
    }
    return sg + '$' + w;
  }
  /* what settled in the month on screen, from the same day rows the grid
     draws: the total (exact decimals), the record and the up / down days */
  function monthSettled(days, ym) {
    var pnl = [], s = { settled: 0, wins: 0, losses: 0, pushes: 0, up: 0, down: 0 };
    (days || []).forEach(function (r) {
      if (String(r.day).slice(0, 7) !== ym || !(+r.settled > 0)) return;
      s.settled += +r.settled; s.wins += +r.wins || 0; s.losses += +r.losses || 0; s.pushes += +r.pushes || 0;
      var v = r.pnl == null ? '0' : String(r.pnl), g = E.dec.sign(v);
      pnl.push(v); if (g > 0) s.up++; else if (g < 0) s.down++;
    });
    s.pnl = E.dec.sum(pnl);
    return s;
  }
  function monthDays(ym) {
    var y = +ym.slice(0, 4), m = +ym.slice(5, 7), first = new Date(Date.UTC(y, m - 1, 1)), days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    var lead = (first.getUTCDay() + 6) % 7, out = [];
    for (var i = 0; i < lead; i++) out.push(null);
    for (var d = 1; d <= days; d++) out.push(ym + '-' + (d < 10 ? '0' : '') + d);
    while (out.length % 7) out.push(null);
    return out;
  }
  function calendarView(st) {
    st = st || {};
    var ym = st.month, by = {};
    (st.days || []).forEach(function (r) { by[r.day] = r; });
    var y = +ym.slice(0, 4), m = +ym.slice(5, 7);
    var h = '<div class="pfo-filters"><div class="pfo-chips" role="group" aria-label="Show days by">' + BASIS.map(function (b) {
      return '<button class="pfo-chip" data-act="cal-basis" data-v="' + b[0] + '" aria-pressed="' + (st.basis === b[0]) + '">' + b[1] + '</button>';
    }).join('') + '</div><div class="pfo-chips" role="group" aria-label="View">' + [['month', 'Month'], ['week', 'Week'], ['day', 'Day']].map(function (v) {
      return '<button class="pfo-chip" data-act="cal-view" data-v="' + v[0] + '" aria-pressed="' + ((st.view || 'month') === v[0]) + '">' + v[1] + '</button>';
    }).join('') + '</div></div>';
    h += '<div class="pfo-cal-nav"><button class="pfo-btn ghost sm" data-act="cal-move" data-v="-1" aria-label="Previous">‹</button><b>' + esc(MONTHS[m - 1] + ' ' + y)
      + '</b><button class="pfo-btn ghost sm" data-act="cal-move" data-v="1" aria-label="Next">›</button></div>';
    if (st.loading) h += '<div class="pfo-note" role="status">Loading ' + esc(MONTHS[m - 1] + ' ' + y) + '…</div>';
    else if (st.view !== 'day') {
      var ms = monthSettled(st.days, ym);
      h += ms.settled ? '<div class="pfo-cal-sum"><span class="pfo-k">Settled in ' + esc(MONTHS[m - 1]) + '</span> ' + signed(ms.pnl)
        + ' <span class="pfo-mut">· ' + plural(ms.settled, 'position') + ' · ' + ms.wins + '-' + ms.losses + '-' + ms.pushes
        + ' · <span class="pfo-up">' + ms.up + ' up</span> / <span class="pfo-down">' + ms.down + ' down</span> day' + (ms.up + ms.down === 1 ? '' : 's') + '</span></div>'
        : '<div class="pfo-cal-sum pfo-mut">Nothing settled in ' + esc(MONTHS[m - 1] + ' ' + y) + '.</div>';
    }
    h += '<div class="pfo-note">' + ({ placed: 'Each day shows what you <b>entered</b> that day; P&amp;L appears on the day it <b>settled</b>.',
      event: 'Each day shows the <b>events</b> you had exposure to that day, and the stake riding on them.',
      settled: 'Each day shows the P&amp;L that <b>settled</b> that day.' }[st.basis] || '') + ' Days are in ' + esc(st.tz || 'your time zone') + '.</div>';
    var days = st.view === 'week' && st.selected ? weekOf(st.selected) : monthDays(ym);
    if (st.view !== 'day') {
      h += '<div class="pfo-cal" role="grid" aria-label="' + esc(MONTHS[m - 1] + ' ' + y) + '"' + (st.loading ? ' aria-busy="true"' : '') + '>' + DOW_SHORT.map(function (d) { return '<div class="pfo-cal-dow" role="columnheader">' + d + '</div>'; }).join('')
        + days.map(function (d) {
          if (!d) return '<div class="pfo-cal-d empty" aria-hidden="true"></div>';
          var r = by[d] || {}, hasP = +r.placed > 0, hasS = +r.settled > 0, hasE = +r.events > 0;
          var main = st.basis === 'event' ? hasE : st.basis === 'settled' ? hasS : (hasP || hasS);
          return '<button class="pfo-cal-d' + (main ? ' on' : '') + (st.selected === d ? ' sel' : '') + '" data-act="cal-day" data-v="' + d + '" role="gridcell" aria-label="'
            + esc(dayLabel(d) + ': ' + (+r.placed || 0) + ' entered, ' + (+r.events || 0) + ' events, ' + (+r.settled || 0) + ' settled' + (hasS ? ', P&L ' + money(r.pnl, true) : '')) + '">'
            + '<span class="pfo-cal-n">' + (+d.slice(8)) + '</span>'
            + (hasP && st.basis === 'placed' ? '<span class="pfo-cal-p" title="Entered">' + r.placed + ' in</span>' : '')
            + (hasE && st.basis === 'event' ? '<span class="pfo-cal-e" title="Events">' + r.events + ' ev</span>' : '')
            + (hasS && st.basis !== 'event' ? '<span class="pfo-cal-s ' + tone(r.pnl) + '"><span class="pfo-cal-full">' + esc(money(r.pnl, true)) + '</span>'
              + '<span class="pfo-cal-short" aria-hidden="true">' + esc(compactMoney(String(r.pnl))) + '</span></span>' : '')
            + '</button>';
        }).join('') + '</div>';
      h += '<div class="pfo-cal-key"><span class="pfo-cal-p">n in</span> entered that day · <span class="pfo-cal-s pfo-up">$</span> P&amp;L settled that day · <span class="pfo-cal-e">n ev</span> events that day</div>';
    }
    if (st.selected) h += dayDetail(st.selected, st.dayList, st.basis);
    return h;
  }
  function weekOf(d) {
    var p = d.split('-'), dt = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])), dow = (dt.getUTCDay() + 6) % 7, out = [];
    for (var i = 0; i < 7; i++) { var x = new Date(dt.getTime() + (i - dow) * 86400000); out.push(x.toISOString().slice(0, 10)); }
    return out;
  }
  function dayDetail(day, list, basis) {
    var h = '<section class="pfo-sec"><div class="pfo-sec-h">' + esc(dayLabel(day)) + '</div>';
    if (list == null) return h + '<div class="pfo-note">Loading the day…</div></section>';
    var entered = list.filter(function (x) { return x.placed_day === day; }), settled = list.filter(function (x) { return x.settled_day === day; }),
      events = list.filter(function (x) { return x.event_day === day; });
    var groups = [['Entered this day', entered, 'placed'], ['Events this day', events, 'event'], ['Settled this day', settled, 'settled']];
    var any = false;
    groups.forEach(function (g) {
      if (!g[1].length) return; any = true;
      var pnl = g[2] === 'settled' ? g[1].reduce(function (s, x) { return s + (+x.pnl || 0); }, 0) : null;
      h += '<div class="pfo-day-g"><div class="pfo-day-gh">' + esc(g[0]) + ' <small>' + g[1].length + '</small>'
        + (pnl != null ? ' · <span class="' + tone(pnl.toFixed(2)) + '">' + esc(money(pnl.toFixed(2), true)) + '</span>' : '') + '</div>'
        + g[1].map(function (x) { return journalCard(x); }).join('') + '</div>';
    });
    if (!any) h += '<div class="pfo-note">Nothing entered, no events and nothing settled on this day.</div>';
    return h + '</section>';
  }

  /* ═══ one position's journal ══════════════════════════════════════════ */
  var EVIDENCE_LABEL = { FULL_CONTEXT: 'Full context', PARTIAL_CONTEXT: 'Partial context', RESULT_ONLY: 'Result only' };
  function journalCard(x) {
    var j = x.journal || {}, historical = x.evidence === 'RESULT_ONLY' && (x.source === 'CSV' || x.source === 'SYNC');
    var price = x.platform_type === 'PREDICTION_MARKET' ? (x.average_entry_price != null ? E.priceText(String(x.average_entry_price)) : '')
      : (x.odds_american != null ? E.americanText(x.odds_american) : (x.entry_dec != null ? String(x.entry_dec) : ''));
    var h = '<article class="pfo-jcard"><div class="pfo-card-top"><span class="pfo-plat">' + esc(x.platform_label) + '</span><span>'
      + esc([x.sport, E.POSITION_TYPE_LABEL[x.position_type]].filter(Boolean).join(' · ')) + '</span>'
      + '<span class="pfo-ev ' + esc(x.evidence) + '">' + esc(EVIDENCE_LABEL[x.evidence] || '') + '</span></div>'
      + '<div class="pfo-event">' + esc(x.event_name) + '</div><div class="pfo-sel">' + esc(x.selection || x.side || '') + (price ? ' <span class="pfo-num">@ ' + esc(price) + '</span>' : '') + '</div>'
      + '<div class="pfo-jrow">' + (x.stake_amt != null ? '<span>Stake ' + esc(money(x.stake_amt)) + (x.units != null ? ' · ' + esc((+x.units).toFixed(2)) + 'u' : '') + '</span>' : '')
      + (x.stake_type === 'BONUS' ? '<span class="pfo-mut">Bonus bet</span>' : '')
      + '<span>' + esc(X.TIMING_LABEL[x.timing_bucket] || '') + '</span>'
      + (x.status !== 'OPEN' && x.pnl != null ? '<span>P&amp;L ' + signed(x.pnl) + '</span>' : '<span class="pfo-mut">Open</span>') + '</div>';
    if (x.process_score != null) {
      h += '<div class="pfo-jrow"><span>Process <b class="pfo-num">' + esc(x.process_score) + '</b> (' + esc(x.grade) + ')</span>'
        + (x.clv_pct != null ? '<span>CLV ' + esc(pct(x.clv_pct, 2)) + '</span>' : x.clv_points != null ? '<span>CLV ' + esc((+x.clv_points > 0 ? '+' : '') + x.clv_points) + ' pts</span>' : '')
        + (x.model_ev != null ? '<span>Model edge ' + esc(pct(x.model_ev, 1)) + '</span>' : '') + '</div>';
    }
    if (historical && !j.decision_recorded_at) h += '<div class="pfo-note">Historical import · No pre-entry journal available.</div>';
    else if (j.thesis || (j.decision_tags && j.decision_tags.length) || j.planned != null) {
      h += '<div class="pfo-jrow">' + (j.planned != null ? '<span class="pfo-tag">' + (j.planned ? 'PLANNED' : 'UNPLANNED') + '</span>' : '')
        + (j.decision_tags || []).map(function (t) { return '<span class="pfo-tag">' + esc(X.TAG_LABEL[t] || t) + '</span>'; }).join('') + '</div>'
        + (j.thesis ? '<div class="pfo-note">“' + esc(j.thesis) + '”</div>' : '');
    }
    if (x.rules_broken && x.rules_broken.length) h += '<div class="pfo-note pfo-warn">Outside your rule' + (x.rules_broken.length === 1 ? '' : 's') + ': ' + esc(x.rules_broken.join('; ')) + '</div>';
    if (j.would_repeat || j.review_note) h += '<div class="pfo-note">Review: ' + (j.would_repeat ? '<b>' + esc({ YES: 'Would make it again', NO: 'Would not make it again', UNSURE: 'Unsure' }[j.would_repeat]) + '</b>' : '')
      + (j.review_note ? ' — ' + esc(j.review_note) : '') + '</div>';
    return h + '<div class="pfo-card-act"><button class="pfo-btn ghost sm" data-act="journal" data-id="' + esc(x.id) + '">Journal</button></div></article>';
  }
  /* the journal editor: what is recorded is shown and locked; what is not can be recorded once */
  var DECISION_FIELDS = [['research_odds_american', 'Price when you researched it (American)', 'SPORTSBOOK'], ['research_price', 'Price when you researched it ($ per contract)', 'PREDICTION_MARKET'],
    ['research_line', 'Line when you researched it', 'SPORTSBOOK'], ['opening_odds_american', 'Opening price (American)', 'SPORTSBOOK'], ['opening_price', 'Opening price ($)', 'PREDICTION_MARKET'],
    ['model_probability', 'Model probability for your side (0–1)', null], ['model_fair_line', 'Model fair line', 'SPORTSBOOK'], ['thesis', 'Why you entered (your thesis)', null]];
  var CLOSE_FIELDS = [['closing_odds_american', 'Closing price (American)', 'SPORTSBOOK'], ['closing_line', 'Closing line', 'SPORTSBOOK'], ['closing_price', 'Closing price ($ per contract)', 'PREDICTION_MARKET']];
  function journalEditor(j, x) {
    j = j || {}; x = x || {};
    var type = x.platform_type, locked = function (k) { return j[k] != null && j[k] !== ''; };
    var row = function (f) {
      if (f[2] && f[2] !== type) return '';
      var k = f[0];
      if (locked(k)) return '<div class="pfo-field full"><span class="pfo-l">' + esc(f[1]) + '</span><div class="pfo-locked">' + esc(j[k]) + ' <small>recorded '
        + esc(String((k.indexOf('closing') === 0 ? j.closing_recorded_at : k === 'model_probability' ? j.model_recorded_at : k.indexOf('research') === 0 ? j.research_recorded_at : j.decision_recorded_at) || '').slice(0, 16).replace('T', ' ')) + ' — never rewritten</small></div></div>';
      return '<label class="pfo-field' + (k === 'thesis' ? ' full' : '') + '"><span class="pfo-l">' + esc(f[1]) + '</span>' + (k === 'thesis' ? '<textarea name="' + k + '" maxlength="1000"></textarea>'
        : '<input name="' + k + '" inputmode="decimal">') + '</label>';
    };
    var tags = j.decision_tags || [];
    var h = '<form class="pfo-form" data-form="journal" novalidate><div class="pfo-sec-h full">Your decision</div>'
      + '<div class="pfo-note full">Recorded before the event, these grade the decision. Once recorded, a value is never rewritten — that is what makes it a record.</div>';
    h += DECISION_FIELDS.map(row).join('');
    h += '<div class="pfo-field full"><span class="pfo-l">Planned or not</span>' + (j.planned != null ? '<div class="pfo-locked">' + (j.planned ? 'PLANNED' : 'UNPLANNED') + '</div>'
      : '<select name="planned"><option value="">Not recorded</option><option value="true">PLANNED</option><option value="false">UNPLANNED</option></select>') + '</div>';
    h += '<div class="pfo-field full"><span class="pfo-l">Decision tags</span>' + (tags.length ? '<div class="pfo-locked">' + tags.map(function (t) { return esc(X.TAG_LABEL[t] || t); }).join(', ') + '</div>'
      : '<div class="pfo-tagpick">' + X.DECISION_TAGS.map(function (t) { return '<label><input type="checkbox" name="tag:' + t + '"> ' + esc(X.TAG_LABEL[t]) + '</label>'; }).join('') + '</div>') + '</div>';
    h += '<div class="pfo-sec-h full">The close</div>' + CLOSE_FIELDS.map(row).join('')
      + (j.closing_source ? '<div class="pfo-note full">Closing price source: ' + esc({ USER: 'entered by you', PLATFORM: 'the platform', EDGEDESK_CAPTURE: 'EdgeDesk\'s own capture' }[j.closing_source] || j.closing_source) + '.</div>' : '');
    h += '<div class="pfo-sec-h full">Your review (editable)</div>'
      + '<label class="pfo-field"><span class="pfo-l">Would you make this bet again?</span><select name="would_repeat"><option value="">—</option>'
      + ['YES', 'NO', 'UNSURE'].map(function (k) { return '<option value="' + k + '"' + (j.would_repeat === k ? ' selected' : '') + '>' + k + '</option>'; }).join('') + '</select></label>'
      + '<label class="pfo-field"><span class="pfo-l">Library</span><select name="library"><option value="">—</option><option value="MISTAKE"' + (j.library === 'MISTAKE' ? ' selected' : '') + '>Mistake Library</option>'
      + '<option value="STRENGTH"' + (j.library === 'STRENGTH' ? ' selected' : '') + '>Strength Library</option></select></label>'
      + '<label class="pfo-field full"><span class="pfo-l">One sentence on it</span><textarea name="review_note" maxlength="1000">' + esc(j.review_note || '') + '</textarea></label>';
    return h + '</form>';
  }
  /* what the editor sends: only fields not already recorded, only if filled */
  function journalPatch(values, j) {
    j = j || {}; var out = {};
    DECISION_FIELDS.concat(CLOSE_FIELDS).forEach(function (f) {
      var k = f[0], v = values[k];
      if (j[k] != null && j[k] !== '') return;
      if (v == null || String(v).trim() === '') return;
      out[k] = k === 'thesis' ? String(v).trim().slice(0, 1000) : String(v).trim();
    });
    if (j.planned == null && (values.planned === 'true' || values.planned === 'false')) out.planned = values.planned === 'true';
    if (!(j.decision_tags && j.decision_tags.length)) {
      var tags = X.DECISION_TAGS.filter(function (t) { return values['tag:' + t] === true || values['tag:' + t] === 'on'; });
      if (tags.length) out.decision_tags = tags;
    }
    ['would_repeat', 'library'].forEach(function (k) { var v = values[k] || null; if (v !== (j[k] || null)) out[k] = v; });
    var note = values.review_note == null ? null : String(values.review_note).trim() || null;
    if (note !== (j.review_note || null)) out.review_note = note;
    return out;
  }
  function journalIssues(patch) {
    var bad = [];
    ['research_odds_american', 'opening_odds_american', 'closing_odds_american'].forEach(function (k) {
      if (patch[k] != null && !(/^[+-]?\d+$/.test(patch[k]) && Math.abs(+patch[k]) >= 100)) bad.push('American odds are a whole number of at least 100 either way (e.g. -110, +150).');
    });
    ['research_price', 'opening_price', 'closing_price'].forEach(function (k) {
      if (patch[k] != null && !(+patch[k] >= 0 && +patch[k] <= 1)) bad.push('A contract price is between $0.00 and $1.00.');
    });
    if (patch.model_probability != null && !(+patch.model_probability > 0 && +patch.model_probability < 1)) bad.push('A model probability is between 0 and 1 (e.g. 0.55).');
    ['research_line', 'closing_line', 'model_fair_line'].forEach(function (k) { if (patch[k] != null && !isFinite(+patch[k])) bad.push('A line is a number (e.g. -3.5).'); });
    return bad.filter(function (v, i, a) { return a.indexOf(v) === i; });
  }

  /* ═══ the Journal: year → month → week → day folders ═══════════════════ */
  function folderSummary(r) {
    return '<span class="pfo-fold-s">' + (+r.placed || 0) + ' entered · ' + (+r.settled || 0) + ' settled'
      + (r.pnl != null ? ' · <span class="' + tone(r.pnl) + '">' + esc(money(r.pnl, true)) + '</span>' : '')
      + ((+r.wins || +r.losses) ? ' · ' + (+r.wins || 0) + '–' + (+r.losses || 0) : '')
      + (r.process != null ? ' · process ' + esc((+r.process).toFixed(1)) + ' <small>n=' + r.graded + '</small>' : '') + '</span>';
  }
  function journalView(st) {
    st = st || {};
    var years = (st.top || []).filter(function (r) { return r.level === 'year'; }), opened = st.opened || {};
    if (!years.length) return '<div class="pfo-empty"><b>No history yet.</b> Your journal fills in as positions are recorded, imported or synced.</div>';
    var h = '<div class="pfo-note">Entries are filed by the day they were <b>entered</b>; P&amp;L by the day it <b>settled</b>. Times are in ' + esc(st.tz || 'your zone') + '.</div><div class="pfo-folders">';
    years.forEach(function (y) {
      var open = st.openYear === y.year;
      h += '<details class="pfo-fold"' + (open ? ' open' : '') + ' data-r="year" data-v="' + y.year + '"><summary><b>' + y.year + '</b>' + folderSummary(y) + '</summary>';
      if (open) {
        var rows = st.yearRows || null;
        if (!rows) h += '<div class="pfo-note">Loading ' + y.year + '…</div>';
        else {
          rows.filter(function (r) { return r.level === 'month'; }).forEach(function (mo) {
            var mk = 'm:' + y.year + '-' + mo.month;
            h += '<details class="pfo-fold"' + (opened[mk] ? ' open' : '') + ' data-r="fold" data-v="' + esc(mk) + '"><summary><b>' + esc(MONTHS[mo.month - 1]) + '</b>' + folderSummary(mo) + '</summary>';
            rows.filter(function (r) { return r.level === 'week' && r.month === mo.month; }).forEach(function (wk) {
              var wk2 = 'w:' + y.year + '-' + mo.month + ':' + wk.week;
              h += '<details class="pfo-fold"' + (opened[wk2] ? ' open' : '') + ' data-r="fold" data-v="' + esc(wk2) + '"><summary>Week of ' + esc(dayLabel(wk.week).replace(/, \d+$/, '')) + folderSummary(wk) + '</summary>';
              rows.filter(function (r) { return r.level === 'day' && r.month === mo.month && r.week === wk.week; }).forEach(function (d) {
                h += '<button class="pfo-fold-day" data-act="journal-day" data-v="' + esc(d.day) + '"><span>' + esc(dayLabel(d.day)) + '</span>' + folderSummary(d) + '</button>';
              });
              h += '</details>';
            });
            h += '</details>';
          });
        }
      }
      h += '</details>';
    });
    h += '</div>';
    if (st.day) h += dayDetail(st.day, st.dayList, 'placed');
    return h;
  }

  /* ═══ PROCESS — what matters first, the reports behind it ═════════════
     The Process seat answers before it asks: how is my process, what is
     working, what needs attention, what is being measured. The reports —
     Leaks, Strengths, Timing, Edge capture, Rules, Experiments, Process vs
     outcome — sit one step down, under Explore; the weekly retrospective is
     the Film Room. Every grade, pattern, experiment result and decision has
     a WHY that opens its evidence (whyItem).

     No letter is assigned below GRADE_MIN graded positions: the engine's own
     evidence rule (X.MIN.observation, where X.confidence() stops reading
     "Building" and where a group first qualifies for a test). Nothing here
     tells the reader to bet, not bet, or bet differently: a focus is
     something to measure, and the decision stays theirs. */
  var GRADE_MIN = X.MIN.observation;
  var PROCESS_NAV = [['overview', 'Overview'], ['film', 'Film Room'], ['explore', 'Explore']];
  var EXPLORE_PAGES = [
    ['leaks', 'Leaks', 'Groups of positions that grade weaker than the rest'],
    ['strengths', 'Strengths', 'Groups of positions that grade stronger than the rest'],
    ['timing', 'Timing', 'When you enter: before the start, by day, hour and session'],
    ['edge', 'Edge capture', 'Model edge at entry, closing line value, price given up'],
    ['rules', 'Rules', 'Your own rules, and how often positions kept them'],
    ['experiments', 'Experiments', 'A process change, measured against the weeks before'],
    ['outcome', 'Process vs outcome', 'Good and poor decisions against wins and losses']];
  var EXPLORE_TITLE = {};
  EXPLORE_PAGES.forEach(function (p) { EXPLORE_TITLE[p[0]] = p[1]; });
  /* the four dimensions the Overview grades (components of the score) */
  var DIMS = [['price', 'Price quality'], ['timing', 'Timing'], ['sizing', 'Sizing'], ['rules', 'Rule discipline']];
  var DIM_LABEL_OF = {};
  DIMS.forEach(function (d) { DIM_LABEL_OF[d[0]] = d[1]; });
  var DIM_WHY = {
    price: { what: 'How much of the price you researched you kept when you entered.',
      needs: 'a price (or line) you researched, recorded before the event',
      how: '100 when you entered at or better than the price you researched; 10 points off for each 1% given up (25 per point of line given up).',
      base: 'Your own researched price: 100 means nothing was given up.',
      limits: 'Only positions with a researched price recorded before the event are graded; a price recorded afterwards is not credited.' },
    timing: { what: 'Where your entry sat between the prices recorded around it.',
      needs: 'at least two of the opening, researched and closing prices',
      how: '100 when you took the best of the recorded prices, 0 the worst; in between, in proportion.',
      base: 'The opening, researched and closing prices recorded for the same position.',
      limits: 'It compares only the prices that were recorded; a better price that existed but was never recorded is not counted.' },
    sizing: { what: 'Whether the stake stayed within the unit caps you had set when you entered.',
      needs: 'a unit size and a single-position or daily cap on file at entry',
      how: '100 within your caps; for a stake over a cap, 1 point off for each 1% over it.',
      base: 'The caps in force when the position was entered (they are snapshotted, never applied backwards).',
      limits: 'It judges size against your own caps, not against any ideal stake.' },
    rules: { what: 'How many of your own rules each position kept.',
      needs: 'at least one rule in force when the position was entered',
      how: 'Per position, the share of applicable rule checks it kept (0–100); a rule judges only positions entered after you adopted it.',
      base: 'The rules you adopted, in force at the time of entry.',
      limits: 'A check whose data was not recorded is left out rather than counted as kept or broken.' } };
  var LETTER_ORDER = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D', 'F'];
  var GRADE_SCALE = 'A+ 90+ · A 84+ · A− 78+ · B+ 72+ · B 66+ · B− 60+ · C+ 55+ · C 45+ · C− 40+ · D 30+ · F below 30.';
  function navOf(sub) { return sub === 'film' ? 'film' : (!sub || sub === 'overview' || sub === 'report') ? 'overview' : 'explore'; }
  function letterOf(score) { return score == null || !isFinite(+score) ? null : X.gradeLetter(String(score)); }
  function letterChip(l) { return l ? '<b class="pcx-letter g' + esc(String(l).charAt(0)) + '">' + esc(String(l).replace('-', '−')) + '</b>' : ''; }
  function confLabel(c) { return { BUILDING: 'Building', LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High' }[c] || c; }
  function cellOf(cells, dim, key) { return (cells || []).filter(function (c) { return c.dim === dim && String(c.key) === String(key); })[0] || null; }
  function metricText(metric, v) { return v == null || !isFinite(v) ? '—' : metric === 'ps' ? (+v).toFixed(1) : pct(v, 2); }
  function pts(v) { var x = +v; return (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x) + ' pt' + (Math.abs(x) === 1 ? '' : 's'); }
  function shortDay(d) { var p = String(d).split('-'); return p.length < 3 ? String(d) : MONTHS[+p[1] - 1].slice(0, 3) + ' ' + (+p[2]); }
  function weekRange(monday) {
    var a = Date.parse(monday + 'T00:00:00Z'); if (!isFinite(a)) return String(monday);
    var b = new Date(a + 6 * 86400000).toISOString().slice(0, 10);
    return shortDay(monday) + '–' + (b.slice(5, 7) === monday.slice(5, 7) ? String(+b.slice(8, 10)) : shortDay(b));
  }

  /* ── the bar under the heading: three places, one Filter ── */
  function processNav(sub) {
    var cur = navOf(sub);
    return '<nav class="pcx-nav" aria-label="Process">' + PROCESS_NAV.map(function (p) {
      return '<button class="pcx-seg" data-act="coach" data-v="' + p[0] + '"' + (cur === p[0] ? ' aria-current="page"' : '') + '>' + p[1] + '</button>';
    }).join('') + '</nav>';
  }
  /* f.chips: the filters applied, each removable; none applied reads "All activity" */
  function filterBar(f) {
    var chips = (f && f.chips) || [];
    return '<div class="pcx-filterbar"><button class="pfo-btn ghost sm pcx-filter" data-act="filter-open" aria-haspopup="dialog">Filter'
      + (chips.length ? ' <span class="pcx-count">' + chips.length + '</span>' : '') + '</button>'
      + (chips.length ? chips.map(function (c) {
        return '<button class="pcx-chip" data-act="filter-clear" data-v="' + esc(c.k) + '" aria-label="Remove filter: ' + esc(c.label) + '">' + esc(c.label) + ' <span aria-hidden="true">×</span></button>';
      }).join('') : '<span class="pcx-all">All activity</span>') + '</div>';
  }
  /* the Filter sheet: source type, platform (of that type), time */
  function filterSheet(v, platforms) {
    v = v || {};
    var radios = function (name, opts, cur) {
      return '<div class="pcx-opts">' + opts.map(function (o) {
        return '<label class="pcx-opt"><input type="radio" name="' + name + '" value="' + esc(o[0]) + '" data-f="filter"' + (String(cur == null ? '' : cur) === o[0] ? ' checked' : '') + '><span>' + esc(o[1]) + '</span></label>';
      }).join('') + '</div>';
    };
    var plats = (platforms || []).filter(function (p) { return !v.source || !p.type || p.type === v.source; });
    return '<div class="pfo-panel" role="dialog" aria-modal="true" aria-label="Filter Process"><div class="pfo-panel-h"><div class="pfo-panel-t">Filter</div>'
      + '<button class="pfo-x" data-act="close" aria-label="Close">×</button></div><form class="pcx-filterform" data-form="filter" novalidate>'
      + '<fieldset><legend>Source type</legend>' + radios('source', [['', 'All'], ['SPORTSBOOK', 'Sportsbooks'], ['PREDICTION_MARKET', 'Prediction markets']], v.source) + '</fieldset>'
      + (plats.length ? '<fieldset><legend>Platform</legend>' + radios('platform', [['', 'Any platform']].concat(plats.map(function (p) { return [p.key, p.label]; })), v.platform) + '</fieldset>' : '')
      + '<fieldset><legend>Time</legend>' + radios('period', [['7D', 'Last 7 days'], ['30D', 'Last 30 days'], ['YTD', 'This year'], ['ALL', 'All time'], ['CUSTOM', 'Custom']], v.period || 'ALL')
      + (v.period === 'CUSTOM' ? '<div class="pcx-dates"><label><span>From</span><input type="date" name="from" value="' + esc(v.from || '') + '" data-f="filter"></label>'
        + '<label><span>To</span><input type="date" name="to" value="' + esc(v.to || '') + '" data-f="filter"></label></div>' : '') + '</fieldset></form>'
      + (v.error ? '<div class="pfo-err">' + esc(v.error) + '</div>' : '')
      + '<div class="pfo-btns"><button class="pfo-btn" data-act="filter-apply">Apply</button><button class="pfo-btn ghost" data-act="filter-reset">All activity</button></div></div>';
  }

  /* ── OVERVIEW 1: how is my process? ── */
  function processHero(sm) {
    var p = (sm && sm.process) || {}, graded = +p.graded || 0, n = +p.n || 0, building = graded < GRADE_MIN || p.score == null;
    var h = '<section class="pcx-hero' + (building ? ' building' : '') + '" aria-label="How is my process?"><div class="pcx-eyebrow">How is my process?</div>';
    if (!building) {
      h += '<div class="pcx-scorerow"><div class="pcx-score"><span class="pcx-k">Process score</span><span class="pcx-score-n pfo-num">' + Math.round(+p.score) + '</span></div>'
        + letterChip(p.letter) + '<span class="pcx-right">' + whyBtn('score', 'the Process Score') + '</span></div>'
        + '<div class="pcx-sub">' + plural(graded, 'graded position') + (n > graded ? ' of ' + n : '') + ' · confidence ' + esc(confLabel(p.confidence || X.confidence(graded))) + '</div>';
    } else {
      h += '<div class="pcx-scorerow"><div class="pcx-score"><span class="pcx-k">Process profile</span><span class="pcx-building">Building</span></div>'
        + '<span class="pcx-right">' + whyBtn('score', 'why the profile is still building') + '</span></div>'
        + '<div class="pcx-sub"><b>' + graded + '</b> eligible position' + (graded === 1 ? '' : 's') + (n > graded ? ' of ' + n + ' in this period' : '')
        + '. EdgeDesk assigns a Process Score from ' + GRADE_MIN + ' graded positions. A position is graded when it has a price to judge the decision by — '
        + 'a closing price, a model probability recorded before the event, or the price you researched.</div>';
    }
    var dims = DIMS.map(function (d) { var c = (p.components || {})[d[0]] || {}; return { k: d[0], label: d[1], n: +c.n || 0, avg: c.avg == null ? null : +c.avg }; });
    var ready = dims.filter(function (d) { return d.n >= GRADE_MIN && d.avg != null; });
    var pending = dims.filter(function (d) { return !(d.n >= GRADE_MIN && d.avg != null); });
    if (ready.length) {
      h += '<div class="pcx-dims">' + ready.map(function (d) {
        return '<div class="pcx-dim"><span class="pcx-dim-n">' + esc(d.label) + '</span>' + letterChip(letterOf(d.avg)) + whyBtn('dim:' + d.k, d.label) + '</div>';
      }).join('') + '</div>';
    }
    /* progress only for a dimension that has started: four "0/10" say nothing */
    pending = pending.filter(function (d) { return d.n > 0 || ready.length; });
    if (pending.length && (ready.length || graded)) {
      h += '<div class="pcx-note">' + pending.map(function (d) { return esc(d.label) + ' ' + Math.min(d.n, GRADE_MIN) + '/' + GRADE_MIN; }).join(' · ')
        + ' graded — each dimension is graded from ' + GRADE_MIN + '.</div>';
    }
    return h + '</section>';
  }

  /* ── OVERVIEW 2–3: the strongest pattern, the weakest ── */
  function patternCard(kind, f, cells) {
    var c = cellOf(cells, f.dim, f.key) || {}, n = +c.n || f.cell.n, psn = +c.ps_n || 0, clvn = +c.clv_n || 0;
    var grade = psn >= GRADE_MIN ? letterOf(+c.ps_sum / psn) : null, clv = clvn ? +c.clv_sum / clvn : null, good = kind === 'good';
    var label = X.keyLabel(f.dim, f.key);
    return '<section class="pcx-card ' + (good ? 'good' : 'attn') + '" aria-label="' + (good ? 'What\'s working' : 'Needs attention') + '"><div class="pcx-kicker">' + (good ? 'What\'s working' : 'Needs attention') + '</div>'
      + '<div class="pcx-title">' + esc(label) + '</div><div class="pcx-dimlabel">' + esc(X.DIM_LABEL[f.dim] || f.dim) + '</div>'
      + '<div class="pcx-facts"><div><span>Process grade</span>' + (grade ? letterChip(grade) : '<b class="pfo-mut">—</b><small>' + psn + ' graded</small>') + '</div>'
      + '<div><span>Positions</span><b class="pfo-num">' + n + '</b></div>'
      + '<div><span>Avg CLV</span>' + (clv == null ? '<b class="pfo-mut">—</b>' : '<b class="pfo-num ' + tone(clv.toFixed(6)) + '">' + esc(pct(clv, 2)) + '</b><small>n=' + clvn + '</small>') + '</div></div>'
      + '<div class="pcx-line">' + levelBadge(f.level) + ' ' + esc(f.metric_label.charAt(0).toUpperCase() + f.metric_label.slice(1)) + ' ' + esc(metricText(f.metric, f.cell.mean))
      + ' against ' + esc(metricText(f.metric, f.comparison.mean)) + ' for your other ' + f.comparison.n + ' positions.</div>'
      + '<div class="pcx-acts">' + whyBtn('f:' + f.id, label) + '<button class="pfo-link" data-act="drill" data-dim="' + esc(f.dim) + '" data-key="' + esc(f.key) + '">See the ' + n + ' positions</button></div></section>';
  }

  /* ── OVERVIEW 4: what is being measured, or what could be ── */
  function expWeeks(e, now) {
    var s = Date.parse(e.starts_at), en = Date.parse(e.ends_at), wk = 7 * 86400000;
    var total = Math.max(1, Math.round((en - s) / wk)), cur = Math.min(total, Math.max(1, Math.floor(((now || Date.now()) - s) / wk) + 1));
    return { cur: cur, total: total };
  }
  var EXP_METRIC = { CLV: ['clv', 'closing line value'], PROCESS: ['ps', 'process score'], ROI: ['ret', 'return per $1'] };
  function expStatus(r, e) {
    if (!r) return 'Measuring…';
    if (r.reason === 'NEEDS_DATA') return 'Needs more positions: ' + (r.current ? r.current.n : 0) + ' during and ' + (r.baseline ? r.baseline.n : 0) + ' before; each side needs ' + (e.min_sample || 20) + '.';
    if (r.status === 'SUPPORTED') return 'The change is measurable so far: the 95% interval of the difference sits above zero.';
    if (r.status === 'NOT_SUPPORTED') return 'No improvement measured' + (r.ended ? '.' : ' so far.');
    return 'Too close to call so far: the 95% interval of the difference includes zero.';
  }
  function experimentCard(e, r, now) {
    var w = expWeeks(e, now), m = EXP_METRIC[e.metric] || EXP_METRIC.CLV;
    var cur = r && r.current, base = r && r.baseline;
    return '<section class="pcx-card exp" aria-label="Current experiment"><div class="pcx-kicker">Current experiment</div><div class="pcx-title">' + esc(e.title) + '</div>'
      + (e.hypothesis ? '<div class="pcx-dimlabel">' + esc(e.hypothesis) + '</div>' : '')
      + '<div class="pcx-line">Week <b>' + w.cur + '</b> of ' + w.total + ' · measured on ' + esc(m[1]) + '</div>'
      + '<div class="pcx-facts"><div><span>During</span>' + (cur ? '<b class="pfo-num">' + esc(metricText(m[0], cur.mean)) + '</b><small>n=' + cur.n + '</small>' : '<b class="pfo-mut">—</b><small>n=0</small>') + '</div>'
      + '<div><span>Before</span>' + (base ? '<b class="pfo-num">' + esc(metricText(m[0], base.mean)) + '</b><small>n=' + base.n + '</small>' : '<b class="pfo-mut">—</b><small>n=0</small>') + '</div></div>'
      + '<div class="pcx-line">' + esc(expStatus(r, e)) + '</div>'
      + '<div class="pcx-acts">' + whyBtn('exp:' + e.id, e.title) + '<button class="pfo-link" data-act="coach" data-v="experiments">View experiment</button></div>'
      + '<div class="pcx-note">An experiment measures a change in how you decide. It never promises a result.</div></section>';
  }
  /* what is worth measuring next, from the evidence: the weakest pattern
     that clears the bar, else the weakest graded dimension below B */
  function focusOf(st) {
    var hl = st.analysis ? X.headlines(st.analysis, { limit: 1 }) : null, bad = hl && hl.not_working[0];
    if (bad) return { label: X.keyLabel(bad.dim, bad.key), why: 'f:' + bad.id, metric: bad.metric === 'ps' ? 'PROCESS' : bad.metric === 'clv' ? 'CLV' : 'ROI', from: 'pattern' };
    var p = (st.summary && st.summary.process) || {}, weakest = null;
    DIMS.forEach(function (d) {
      var c = (p.components || {})[d[0]] || {};
      if (+c.n >= GRADE_MIN && c.avg != null && +c.avg < 66 && (!weakest || +c.avg < weakest.avg)) weakest = { k: d[0], label: d[1], avg: +c.avg };
    });
    return weakest ? { label: weakest.label, why: 'dim:' + weakest.k, metric: 'PROCESS', from: 'dimension' } : null;
  }
  function focusCard(fc, title) {
    return '<section class="pcx-card focus" aria-label="' + esc(title) + '"><div class="pcx-kicker">' + esc(title) + '</div><div class="pcx-title">' + esc(fc.label) + '</div>'
      + '<div class="pcx-line">Something to measure, not an instruction: change one thing about your ' + esc(fc.label) + (fc.from === 'pattern' ? ' positions' : '') + ' for four weeks, and EdgeDesk compares your '
      + esc((EXP_METRIC[fc.metric] || EXP_METRIC.CLV)[1]) + ' with the four weeks before. What you change is your decision.</div>'
      + '<div class="pcx-acts">' + whyBtn(fc.why, fc.label) + '<button class="pfo-link" data-act="exp-setup" data-v="' + esc(fc.label) + '" data-metric="' + esc(fc.metric) + '">Set up an experiment</button></div></section>';
  }
  function focusBlock(st) {
    var active = (st.experiments || []).filter(function (e) { return e.status === 'ACTIVE'; })[0];
    if (active) return experimentCard(active, (st.expResults || {})[active.id], st.now);
    var fc = focusOf(st);
    if (fc) return focusCard(fc, 'Current focus');
    return '<div class="pcx-quiet">No experiment running. <button class="pfo-link" data-act="coach" data-v="experiments">Experiments ›</button></div>';
  }
  function processOverview(st) {
    var sm = st.summary, h = processHero(sm);
    var hl = X.headlines(st.analysis || { findings: [], tested: 0, total: 0 }, { limit: 1 }), good = hl.working[0], bad = hl.not_working[0];
    if (good || bad) {
      h += '<div class="pcx-pair">' + (good ? patternCard('good', good, st.cells)
        : '<section class="pcx-card quiet"><div class="pcx-kicker">What\'s working</div><div class="pcx-line">No strength clears the evidence bar yet.</div></section>')
        + (bad ? patternCard('attn', bad, st.cells)
          : '<section class="pcx-card quiet"><div class="pcx-kicker">Needs attention</div><div class="pcx-line">No reliable weakness detected.</div></section>') + '</div>';
    } else {
      h += '<section class="pcx-card quiet" aria-label="What\'s working and what needs attention"><div class="pcx-kicker">What\'s working · Needs attention</div>'
        + '<div class="pcx-line"><b>No pattern is strong enough to call yet.</b> ' + esc(hl.none_detail) + '</div><div class="pcx-acts">' + whyBtn('tests', 'how patterns are found') + '</div></section>';
    }
    return h + focusBlock(st);
  }

  /* ── EXPLORE: the reports, one step down ── */
  function exploreLanding(st) {
    var res = st.analysis || { findings: [], tested: 0 }, sm = st.summary || {}, p = sm.process || {};
    var count = function (kind) { var k = res.findings.filter(function (f) { return f.kind === kind; }).length; return k ? plural(k, 'pattern') : 'None reliable · ' + plural(res.tested, 'test'); };
    var clv = p.clv || {}, rules = p.rules || {}, mx = X.matrix(sm.matrix), act = (st.experiments || []).filter(function (e) { return e.status === 'ACTIVE'; }).length;
    var stat = { leaks: count('LEAK'), strengths: count('STRENGTH'),
      timing: ((p.components && p.components.timing && +p.components.timing.n) || 0) + ' graded on timing',
      edge: +clv.n ? 'Avg CLV ' + pct(clv.avg_pct, 2) + ' · n=' + clv.n : 'No closing prices yet',
      rules: +rules.applicable ? rules.followed + ' of ' + rules.applicable + ' checks kept' : (st.rules && st.rules.length ? plural(st.rules.length, 'rule') : 'No rules yet'),
      experiments: st.experiments == null ? '' : act ? act + ' running' : plural(st.experiments.length, 'experiment'),
      outcome: plural(mx.badWins, 'bad win') + ' · ' + mx.goodLosses + ' good loss' + (mx.goodLosses === 1 ? '' : 'es') };
    return '<nav class="pcx-explore" aria-label="Explore your process">' + EXPLORE_PAGES.map(function (x) {
      return '<button class="pcx-xrow" data-act="coach" data-v="' + x[0] + '"><span class="pcx-xt">' + esc(x[1]) + '</span><span class="pcx-xd">' + esc(x[2]) + '</span>'
        + '<span class="pcx-xs">' + esc(stat[x[0]] || '') + '</span><span class="pcx-xa" aria-hidden="true">›</span></button>';
    }).join('') + '</nav><div class="pcx-note">The reports behind the Overview. Every figure carries its sample size; tap WHY on any of them for the evidence.</div>';
  }
  function exploreHead(sub) {
    return '<div class="pcx-subhead"><button class="pfo-link" data-act="coach" data-v="explore">‹ Explore</button><h3>' + esc(EXPLORE_TITLE[sub] || '') + '</h3></div>';
  }
  function matrixTable(mx) {
    var lab = { GOOD: 'Good process', AVERAGE: 'Average', POOR: 'Poor process', UNGRADED: 'Not graded' }, col = { WIN: 'Won', LOSS: 'Lost', OTHER: 'Push / void / cash-out', OPEN: 'Open' };
    return '<div class="pfo-tablewrap"><table class="pfo-table pfo-matrix"><thead><tr><th></th>' + mx.cols.map(function (c) { return '<th>' + col[c] + '</th>'; }).join('') + '</tr></thead><tbody>'
      + mx.rows.map(function (r) {
        return '<tr><th scope="row">' + lab[r] + '</th>' + mx.cols.map(function (c) {
          var x = mx.cells[r + ':' + c], tag = r === 'POOR' && c === 'WIN' ? ' badwin' : r === 'GOOD' && c === 'LOSS' ? ' goodloss' : '';
          return '<td class="r' + tag + '">' + (x.n ? '<button class="pfo-link" data-act="matrix" data-process="' + r + '" data-result="' + c + '">' + x.n + '</button>' + (x.pnl != null ? '<small>' + esc(money(x.pnl, true)) + '</small>' : '') : '<span class="pfo-mut">0</span>') + '</td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>'
      + '<div class="pfo-note"><b>' + mx.badWins + '</b> bad win' + (mx.badWins === 1 ? '' : 's') + ' (won on a poor decision) · <b>' + mx.goodLosses + '</b> good loss' + (mx.goodLosses === 1 ? '' : 'es')
      + ' (lost on a good decision). Good is a process score of 66+, poor under 45.</div>';
  }
  function breakdownTable(cells, dim, title) {
    var list = (cells || []).filter(function (c) { return c.dim === dim; }).sort(function (a, b) { return String(a.key).localeCompare(String(b.key)); });
    if (!list.length) return '';
    return '<section class="pfo-sec"><div class="pfo-sec-h">' + esc(title) + '<span class="pfo-right">' + whyBtn('table:' + dim, title) + '</span></div><div class="pfo-tablewrap"><table class="pfo-table"><thead><tr><th></th><th class="r">Positions</th>'
      + '<th class="r">Settled</th><th class="r">P&amp;L</th><th class="r">ROI</th><th class="r">Avg CLV</th><th class="r">Process</th></tr></thead><tbody>'
      + list.map(function (c) {
        var roi = +c.staked > 0 ? +c.pnl / +c.staked : null, clv = +c.clv_n > 0 ? +c.clv_sum / +c.clv_n : null, ps = +c.ps_n > 0 ? +c.ps_sum / +c.ps_n : null;
        return '<tr><th scope="row"><button class="pfo-link" data-act="drill" data-dim="' + esc(dim) + '" data-key="' + esc(c.key) + '">' + esc(X.keyLabel(dim, c.key)) + '</button></th>'
          + '<td class="r">' + c.n + '</td><td class="r">' + c.settled + '</td><td class="r">' + signed(c.pnl) + '</td>'
          + '<td class="r">' + esc(roi == null ? '—' : pct(roi, 1)) + '</td><td class="r">' + (clv == null ? '—' : esc(pct(clv, 2)) + ' <small>n=' + c.clv_n + '</small>')
          + '</td><td class="r">' + (ps == null ? '—' : ps.toFixed(1) + ' <small>n=' + c.ps_n + '</small>') + '</td></tr>';
      }).join('') + '</tbody></table></div><div class="pfo-note">Sample sizes are on every figure; a group under ' + GRADE_MIN + ' positions is shown but never tested.</div></section>';
  }
  function changeBlock(cmp) {
    var rows = [['ps', 'Process score'], ['clv', 'Closing line value']].map(function (k) {
      var c = cmp[k[0]]; if (!c || !c.enough) return '<dt>' + k[1] + '</dt><dd class="pfo-mut">not enough positions in both periods to compare</dd>';
      var fmt = function (v) { return k[0] === 'ps' ? v.toFixed(1) : pct(v, 2); };
      return '<dt>' + k[1] + '</dt><dd>' + fmt(c.previous.mean) + ' → <b>' + fmt(c.current.mean) + '</b> <small>n=' + c.previous.n + ' → ' + c.current.n
        + (c.test ? ' · 95% interval of the change ' + fmt(c.test.ci95[0]) + ' to ' + fmt(c.test.ci95[1]) : '') + '</small></dd>';
    }).join('');
    return '<section class="pfo-sec"><div class="pfo-sec-h">Last 30 days vs the 30 before<span class="pfo-right">' + whyBtn('compare', 'the comparison') + '</span></div><dl class="pfo-dl">' + rows + '</dl></section>';
  }
  function rulesView(rules, sm) {
    var p = (sm && sm.process && sm.process.rules) || {};
    var h = '<section class="pfo-sec"><div class="pfo-sec-h">Your rules' + (+p.applicable ? '<span class="pfo-right">' + whyBtn('dim:rules', 'rule discipline') + '</span>' : '') + '</div>'
      + '<div class="pfo-note">A rule judges positions entered after you adopt it, never before. To change a rule, retire it and adopt a new one — the old one keeps its history.</div>'
      + (+p.applicable ? '<div class="pfo-note">This period: <b>' + p.followed + '</b> of ' + p.applicable + ' rule checks followed · <b>' + p.positions_broken + '</b> position' + (+p.positions_broken === 1 ? '' : 's')
        + ' outside a rule. <button class="pfo-link" data-act="rules-broken">List them</button></div>' : '');
    h += (rules || []).map(function (r) {
      return '<div class="pfo-row"><div class="pfo-row-n">' + esc(r.label) + '<small>' + (r.active_until ? 'retired ' + esc(String(r.active_until).slice(0, 10)) : 'since ' + esc(String(r.active_from).slice(0, 10))) + '</small></div>'
        + '<div class="pfo-row-v">' + (r.active_until ? '' : '<button class="pfo-btn ghost sm" data-act="rule-retire" data-id="' + esc(r.id) + '">Retire</button>') + '</div></div>';
    }).join('') || '<div class="pfo-note">No rules yet.</div>';
    h += '<form class="pfo-form" data-form="rule" novalidate><label class="pfo-field full"><span class="pfo-l">Add a rule</span><select name="kind">'
      + Object.keys(X.RULE_KINDS).map(function (k) { return '<option value="' + k + '">' + esc(X.RULE_KINDS[k].label.replace(/\{(\w+)\}/g, '…')) + '</option>'; }).join('') + '</select></label>'
      + '<label class="pfo-field"><span class="pfo-l">Number (units, count, hours, edge or min odds)</span><input name="a" inputmode="decimal"></label>'
      + '<label class="pfo-field"><span class="pfo-l">Max odds or sports (comma-separated)</span><input name="b"></label></form>'
      + '<div class="pfo-btns"><button class="pfo-btn" data-act="rule-add">Adopt rule</button></div>';
    return h + '</section>';
  }
  function ruleFromForm(v) {
    var k = v.kind, R = X.RULE_KINDS[k]; if (!R) return { error: 'Choose a rule.' };
    var params = {}, a = String(v.a || '').trim(), b = String(v.b || '').trim();
    if (k === 'MAX_STAKE_UNITS' || k === 'MAX_DAILY_UNITS') { if (!(+a > 0)) return { error: 'Enter the number of units.' }; params.units = +a; }
    if (k === 'MAX_POSITIONS_PER_DAY') { if (!(+a >= 1)) return { error: 'Enter how many positions.' }; params.count = Math.floor(+a); }
    if (k === 'MIN_MODEL_EDGE') { if (!(Math.abs(+a) <= 1) || a === '') return { error: 'Enter the edge as a fraction, e.g. 0.02 for 2%.' }; params.ev = +a; }
    if (k === 'MIN_LEAD_HOURS') { if (!(+a >= 0)) return { error: 'Enter the hours.' }; params.hours = +a; }
    if (k === 'ODDS_BETWEEN') { if (a) params.min = +a; if (b) params.max = +b; if (!a && !b) return { error: 'Enter a minimum, a maximum or both (decimal odds).' }; }
    if (k === 'ONLY_SPORTS') { var sp = b.split(',').map(function (s) { return s.trim().toUpperCase(); }).filter(Boolean); if (!sp.length) return { error: 'List the sports, comma-separated.' }; params.sports = sp; }
    var label = R.label.replace(/\{(\w+)\}/g, function (_, p) { return Array.isArray(params[p]) ? params[p].join(', ') : params[p] == null ? '—' : String(params[p]); });
    return { row: { kind: k, params: params, label: label.slice(0, 120) } };
  }
  function experimentsView(list, results, draft) {
    draft = draft || {};
    var h = '<section class="pfo-sec"><div class="pfo-sec-h">Process experiments</div>'
      + '<div class="pfo-note">Change one thing for a set period and measure it against the same length of time before. What is measured, on what, and for how long is fixed when you start — so the answer cannot be steered afterwards. An experiment measures a change in process; it never promises a result.</div>';
    h += (list || []).map(function (e) {
      var r = (results || {})[e.id];
      return '<div class="pfo-find"><div class="pfo-find-h"><b>' + esc(e.title) + '</b> <span class="pfo-level ' + (r ? r.status : '') + '">' + esc(r ? r.status.replace('_', ' ') : 'measuring…') + '</span>'
        + whyBtn('exp:' + e.id, e.title) + '</div>'
        + '<div class="pfo-note">' + esc(e.hypothesis || '') + ' Measured on ' + esc({ CLV: 'closing line value', PROCESS: 'process score', ROI: 'return' }[e.metric]) + ' · '
        + esc(String(e.starts_at).slice(0, 10)) + ' to ' + esc(String(e.ends_at).slice(0, 10)) + ' · at least ' + e.min_sample + ' positions each side.</div>'
        + (r ? '<div class="pfo-note">' + esc(r.text) + '</div>' : '')
        + (e.status === 'ACTIVE' ? '<div class="pfo-btns"><button class="pfo-btn ghost sm" data-act="exp-end" data-id="' + esc(e.id) + '">End now</button></div>' : '') + '</div>';
    }).join('') || '<div class="pfo-note">No experiments yet.</div>';
    var metric = draft.metric || 'CLV';
    h += '<form class="pfo-form" data-form="experiment" novalidate><label class="pfo-field full"><span class="pfo-l">What you will change</span><input name="title" maxlength="120" value="' + esc(draft.title || '') + '" placeholder="Enter NFL positions at least a day before kickoff"></label>'
      + '<label class="pfo-field full"><span class="pfo-l">What you expect</span><input name="hypothesis" maxlength="500" value="' + esc(draft.hypothesis || '') + '" placeholder="My closing line value improves"></label>'
      + '<label class="pfo-field"><span class="pfo-l">Measured on</span><select name="metric">' + [['CLV', 'Closing line value'], ['PROCESS', 'Process score'], ['ROI', 'Return']].map(function (o) {
        return '<option value="' + o[0] + '"' + (metric === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>'
      + '<label class="pfo-field"><span class="pfo-l">For (days)</span><input name="days" inputmode="numeric" value="28"></label>'
      + '<label class="pfo-field"><span class="pfo-l">The behaviour, to measure adherence (optional)</span><select name="condition"><option value="">—</option>'
      + Object.keys(X.TIMING_LABEL).filter(function (k) { return k !== 'UNKNOWN'; }).map(function (k) { return '<option value="timing:' + k + '">Timing: ' + esc(X.TIMING_LABEL[k]) + '</option>'; }).join('')
      + '<option value="planned:PLANNED">Planned positions only</option></select></label></form>'
      + '<div class="pfo-btns"><button class="pfo-btn" data-act="exp-add">Start experiment</button></div>';
    return h + '</section>';
  }
  function edgeView(sm, cells) {
    var p = (sm && sm.process) || {}, ev = p.model_ev || {}, clv = p.clv || {}, slip = p.price_slip || {};
    var h = '<section class="pfo-sec"><div class="pfo-sec-h">Edge capture<span class="pfo-right">' + whyBtn('edge', 'edge capture') + '</span></div>';
    if (!(+ev.n) && !(+clv.n)) return h + '<div class="pfo-note">Edge capture needs model probabilities recorded before the event and closing prices. None are recorded in this period.</div></section>';
    h += '<dl class="pfo-dl"><dt>Model edge at entry</dt><dd>' + (+ev.n ? esc(pct(ev.avg, 2)) + ' <small>n=' + ev.n + '</small>' : '—') + '</dd>'
      + '<dt>Closing line value</dt><dd>' + (+clv.n ? esc(pct(clv.avg_pct, 2)) + ' <small>n=' + clv.n + '</small>' : '—') + '</dd>'
      + '<dt>Beat the close</dt><dd>' + (+clv.with_close ? clv.beat + ' of ' + clv.with_close : '—') + '</dd>'
      + '<dt>Price given up between research and entry</dt><dd>' + (+slip.n ? esc(money(slip.given_up)) + ' <small>estimate · n=' + slip.n + '</small>' : '—') + '</dd></dl>';
    if (+ev.n && +clv.n && +ev.avg > 0) h += '<div class="pfo-note">Capture rate (average CLV ÷ average model edge, over different subsets when not every position has both): <b>' + esc(Math.round(100 * clv.avg_pct / ev.avg) + '%') + '</b>. An estimate, not a recorded figure.</div>';
    return h + '</section>' + breakdownTable(cells, 'decision_source', 'By decision source');
  }
  function outcomeView(sm, cmp) {
    var h = '<section class="pfo-sec"><div class="pfo-sec-h">Process vs outcome<span class="pfo-right">' + whyBtn('matrix', 'process vs outcome') + '</span></div>' + matrixTable(X.matrix(sm.matrix)) + '</section>';
    var v = X.variance(sm.process && sm.process.variance);
    if (v) h += '<section class="pfo-sec"><div class="pfo-sec-h">Results vs what the prices implied<span class="pfo-right">' + whyBtn('variance', 'results vs prices') + '</span></div><div class="pfo-note">' + esc(v.text) + '</div></section>';
    if (cmp) h += changeBlock(cmp);
    return h;
  }
  function explorePage(sub, st) {
    var sm = st.summary, res = st.analysis, cells = st.cells, h = exploreHead(sub);
    if (sub === 'leaks' || sub === 'strengths') {
      var kind = sub === 'leaks' ? 'LEAK' : 'STRENGTH', list = res.findings.filter(function (f) { return f.kind === kind; });
      h += '<div class="pfo-note">Pre-specified comparisons only (' + res.tested + ' tests this period, corrected together for multiple comparisons). A finding needs a process metric to reach Supported; profit alone never does. '
        + whyBtn('tests', 'how patterns are found') + '</div>';
      if (!list.length) return h + '<div class="pfo-none"><b>' + (kind === 'LEAK' ? 'NO RELIABLE LEAK DETECTED' : 'NO RELIABLE STRENGTH DETECTED') + '</b><div class="pfo-note">' + esc(X.headlines(res).none_detail) + '</div></div>';
      return h + list.map(findingRow).join('');
    }
    if (sub === 'timing') {
      return h + breakdownTable(cells, 'timing', 'When you enter, relative to the start') + breakdownTable(cells, 'placed_dow', 'Day you entered')
        + breakdownTable(cells, 'event_dow', 'Day of the event') + breakdownTable(cells, 'hour', 'Time of day you entered')
        + breakdownTable(cells, 'session', 'Position within a session (same day, under 90 minutes apart)') + breakdownTable(cells, 'after', 'After the previous result');
    }
    if (sub === 'edge') return h + edgeView(sm, cells);
    if (sub === 'rules') return h + rulesView(st.rules, sm);
    if (sub === 'experiments') return h + experimentsView(st.experiments, st.expResults, st.expDraft);
    if (sub === 'outcome') return h + outcomeView(sm, st.compare);
    return h;
  }

  /* ── FILM ROOM: the week, reviewed like game film ── */
  function resultWord(x) {
    return x.status === 'OPEN' ? 'Open' : { WIN: 'Win', LOSS: 'Loss', PUSH: 'Push', VOID: 'Void', CASHOUT: 'Cash-out' }[x.result] || 'Settled';
  }
  function clvOf(x) { return x.clv_pct != null ? pct(x.clv_pct, 2) : x.clv_points != null ? pts(x.clv_points) : null; }
  var COMP_WORD = { clv: 'closing line value', model: 'model edge at entry', price: 'price quality', sizing: 'sizing', timing: 'entry timing', rules: 'rule adherence', market: 'market structure' };
  function compsOf(x) {
    return X.COMPONENTS.map(function (k) { var v = x['s_' + k]; return v == null || !isFinite(+v) ? null : { k: k, v: +v }; }).filter(Boolean);
  }
  /* how the close went, in words, from what was recorded */
  function closeWords(x, beat) {
    var j = x.journal || {};
    if (x.clv_points != null && j.closing_line != null && x.line != null) {
      return 'the line closed at ' + j.closing_line + ' against your ' + x.line + ' (' + pts(x.clv_points) + (+x.clv_points >= 0 ? ' in your favour' : ' against you') + ')';
    }
    if (x.clv_pct != null) {
      return beat ? 'the market closed at a worse price than you took (closing line value ' + pct(x.clv_pct, 2) + ')'
        : 'the market closed at a better price than you took (closing line value ' + pct(x.clv_pct, 2) + ')';
    }
    return null;
  }
  function badWinWords(x) {
    /* market structure is the market type's typical margin, not a choice made on this bet: never a reason */
    var parts = [], low = compsOf(x).filter(function (c) { return c.v < 45 && c.k !== 'clv' && c.k !== 'market'; }).sort(function (a, b) { return a.v - b.v; }).slice(0, 2);
    var close = (x.clv_pct != null && +x.clv_pct < 0) || (x.clv_points != null && +x.clv_points < 0) ? closeWords(x, false) : null;
    if (close) parts.push(close);
    if (low.length) parts.push(low.map(function (c) { return 'its ' + COMP_WORD[c.k] + ' scored ' + c.v.toFixed(0); }).join(' and ') + ' out of 100');
    return 'The position won' + (x.pnl != null ? ' (' + money(x.pnl, true) + ')' : '') + ', but ' + (parts.length ? parts.join(', and ') : 'its process score was ' + x.process_score + ' — under 45, a poor decision') + '.';
  }
  function goodLossWords(x) {
    var parts = [], high = compsOf(x).filter(function (c) { return c.v >= 66 && c.k !== 'clv' && c.k !== 'market'; }).sort(function (a, b) { return b.v - a.v; }).slice(0, 2);
    var close = (x.clv_pct != null && +x.clv_pct > 0) || (x.clv_points != null && +x.clv_points > 0) ? closeWords(x, true) : null;
    if (close) parts.push(close);
    if (high.length) parts.push(high.map(function (c) { return 'its ' + COMP_WORD[c.k] + ' scored ' + c.v.toFixed(0); }).join(' and ') + ' out of 100');
    return 'The position lost' + (x.pnl != null ? ' (' + money(x.pnl, true) + ')' : '') + ', but ' + (parts.length ? parts.join(', and ') : 'its process score was ' + x.process_score)
      + '. EdgeDesk graded the entry positively despite the loss.';
  }
  function decisionCard(x, opts) {
    opts = opts || {};
    var clv = clvOf(x);
    return '<article class="pcx-dec ' + (opts.cls || '') + '">' + (opts.kicker ? '<div class="pcx-kicker">' + esc(opts.kicker) + '</div>' : '')
      + '<div class="pcx-dec-t">' + esc(x.selection || x.side || x.event_name) + '</div><div class="pcx-dec-s">' + esc([x.event_name, x.platform_label].filter(Boolean).join(' · ')) + '</div>'
      + '<div class="pcx-facts"><div><span>Result</span><b>' + esc(resultWord(x)) + '</b>' + (x.status !== 'OPEN' && x.pnl != null ? signed(x.pnl) : '') + '</div>'
      + '<div><span>Process</span>' + (x.grade ? letterChip(x.grade) : '<b class="pfo-mut">not graded</b>') + '</div>'
      + '<div><span>CLV</span>' + (clv ? '<b class="pfo-num">' + esc(clv) + '</b>' : '<b class="pfo-mut">—</b>') + '</div></div>'
      + (opts.explain ? '<div class="pcx-line">' + esc(opts.explain) + '</div>' : '')
      + '<div class="pcx-acts">' + whyBtn('pos:' + x.id, x.selection || x.event_name) + '<button class="pfo-link" data-act="journal" data-id="' + esc(x.id) + '">Journal</button></div></article>';
  }
  /* the week's one sentence: only what its figures support */
  function filmSentence(f) {
    var sm = f.summary || {}, se = sm.settled || {}, pr = sm.process || {}, graded = +pr.graded || 0, settled = +se.n || 0;
    var g = settled ? E.dec.sign(String(se.pnl || 0)) : 0;
    var res = !settled ? 'Nothing settled this week' : g > 0 ? 'You finished up ' + money(se.pnl) : g < 0 ? 'You finished down ' + money(String(se.pnl).replace(/^-/, '')) : 'You finished even';
    if (graded < GRADE_MIN || pr.score == null) return res + '. ' + (graded ? 'Too few graded positions (' + graded + ') to judge the process yet.' : 'No position this week has a price to judge the decision by yet.');
    var band = X.processBand(String(pr.score)), letter = String(pr.letter).replace('-', '−');
    var prior = f.prior && f.prior.process, pl = prior && +prior.graded >= GRADE_MIN && prior.letter ? prior.letter : null;
    var moved = pl && pl !== pr.letter ? (LETTER_ORDER.indexOf(pr.letter) > LETTER_ORDER.indexOf(pl) ? 'fell' : 'rose') : null;
    if (settled && g > 0 && moved === 'fell') return 'You won this week, but your process grade fell (' + pl.replace('-', '−') + ' → ' + letter + ').';
    if (settled && g < 0 && band === 'GOOD') return 'The results were bad. The process wasn’t (' + letter + ').';
    if (settled && g > 0 && band === 'GOOD') return 'Strong results. Strong process (' + letter + ').';
    if (settled && g > 0 && band === 'POOR') return 'You won this week, but the decisions behind it graded poorly (' + letter + ').';
    if (settled && g < 0 && band === 'POOR') return 'Weak results, and the decisions behind them graded poorly (' + letter + ').';
    return res + '; the process graded ' + letter + (moved ? ', ' + (moved === 'fell' ? 'down' : 'up') + ' from ' + pl.replace('-', '−') : '') + '.';
  }
  function reviewCard(x, draft) {
    var j = x.journal || {}, d = draft || {}, cur = d.again || j.would_repeat || '', note = d.note != null ? d.note : (j.review_note || '');
    return '<article class="pcx-review" data-id="' + esc(x.id) + '"><div class="pcx-dec-t">' + esc(x.selection || x.side || x.event_name)
      + ' <small>' + esc(resultWord(x)) + (x.pnl != null ? ' ' + esc(money(x.pnl, true)) : '') + (x.grade ? ' · process ' + esc(String(x.grade).replace('-', '−')) : '') + '</small></div>'
      + '<div class="pcx-before"><span>Before the bet</span>' + (j.thesis ? '“' + esc(j.thesis) + '”' : '<i>No reasoning was recorded before it.</i>') + '</div>'
      + '<div class="pcx-q" id="pcx-q-' + esc(x.id) + '">Would you make this bet again?</div><div class="pcx-yn" role="group" aria-labelledby="pcx-q-' + esc(x.id) + '">'
      + ['YES', 'NO', 'UNSURE'].map(function (k) { return '<button class="pcx-ynb" data-act="review-pick" data-id="' + esc(x.id) + '" data-v="' + k + '" aria-pressed="' + (cur === k) + '">' + k + '</button>'; }).join('') + '</div>'
      + '<label class="pcx-whyin"><span>Why?</span><input name="review_note" data-review="' + esc(x.id) + '" maxlength="280" value="' + esc(note) + '" placeholder="One sentence, for after the result"></label>'
      + '<div class="pcx-acts"><button class="pfo-btn sm" data-act="review-save" data-id="' + esc(x.id) + '"' + (cur ? '' : ' disabled') + '>' + (j.would_repeat ? 'Update reflection' : 'Save reflection') + '</button>'
      + (j.reviewed_at ? '<span class="pcx-saved">Reflection saved ' + esc(String(j.reviewed_at).slice(0, 10)) + '</span>' : '') + '</div></article>';
  }
  function reviewBlock(f, drafts) {
    var list = (f.settledList || []).filter(function (x) { return x.status !== 'OPEN'; });
    if (!list.length) return '';
    var keyOf = function (x) { return x.id; }, priority = {};
    (f.badWins || []).concat(f.goodLosses || []).forEach(function (x) { priority[keyOf(x)] = 1; });
    var todo = list.filter(function (x) { return !(x.journal && x.journal.would_repeat); }).sort(function (a, b) { return (priority[b.id] || 0) - (priority[a.id] || 0); });
    var done = list.length - todo.length;
    var h = '<section class="pcx-sec" aria-label="Review"><div class="pcx-kicker">Review</div>'
      + '<div class="pcx-line">After the result: would you make it again, and why? It is kept as a reflection beside what you recorded before the bet, which never changes.</div>';
    if (!todo.length) return h + '<div class="pcx-quiet">All ' + plural(list.length, 'settled position') + ' this week are reviewed.</div></section>';
    h += todo.slice(0, 3).map(function (x) { return reviewCard(x, (drafts || {})[x.id]); }).join('');
    if (todo.length > 3 || done) h += '<div class="pcx-note">' + (todo.length > 3 ? (todo.length - 3) + ' more to review in the Journal. ' : '') + (done ? done + ' already reviewed.' : '') + '</div>';
    return h + '</section>';
  }
  function filmRoom(f, st) {
    st = st || {};
    if (!f) return '<div class="pfo-empty">Loading the week…</div>';
    var sm = f.summary || {}, se = sm.settled || {}, pr = sm.process || {}, rules = pr.rules || {}, clv = pr.clv || {};
    var placed = (sm.placed && +sm.placed.n) || 0, settled = +se.n || 0, graded = +pr.graded || 0, ready = graded >= GRADE_MIN && pr.score != null;
    var h = '<section class="pcx-film" aria-label="Film Room"><div class="pcx-film-nav"><button class="pfo-btn ghost sm" data-act="film-move" data-v="-1" aria-label="Earlier week">‹</button>'
      + '<div class="pcx-film-h"><div class="pcx-eyebrow">Film Room</div><h3 class="pcx-film-t">Week of ' + esc(weekRange(f.week)) + '</h3></div>'
      + '<button class="pfo-btn ghost sm" data-act="film-move" data-v="1" aria-label="Later week">›</button></div>';
    if (!placed && !settled) return h + '<div class="pcx-quiet">Nothing was entered or settled this week.</div></section>';
    h += '<div class="pcx-kpis"><div><span>Financial result</span>' + (settled ? '<b class="pfo-num ' + tone(se.pnl || 0) + '">' + esc(money(se.pnl || 0, true)) + '</b><small>' + plural(settled, 'settled position') + '</small>'
      : '<b class="pfo-mut">—</b><small>nothing settled</small>') + '</div>'
      + '<div><span>Process grade</span>' + (ready ? letterChip(pr.letter) + '<small>' + graded + ' graded</small>' : '<b class="pcx-building sm">Building</b><small>' + graded + ' of ' + GRADE_MIN + ' graded</small>') + '</div>'
      + '<div><span>Rules followed</span>' + (+rules.applicable ? '<b class="pfo-num">' + rules.followed + ' / ' + rules.applicable + '</b>' : '<b class="pfo-mut">—</b><small>no rule checks</small>') + '</div>'
      + '<div><span>Avg CLV</span>' + (+clv.n ? '<b class="pfo-num ' + tone(clv.avg_pct) + '">' + esc(pct(clv.avg_pct, 2)) + '</b><small>n=' + clv.n + '</small>' : '<b class="pfo-mut">—</b><small>no closing prices</small>') + '</div></div>'
      + '<div class="pcx-verdict"><b>' + esc(filmSentence(f)) + '</b> ' + whyBtn('week', 'this week') + '</div></section>';
    /* each decision once: the bad win and the good loss get their own cards */
    var bw = (f.badWins || [])[0], gl = (f.goodLosses || [])[0], shown = {};
    if (bw) shown[bw.id] = 1; if (gl) shown[gl.id] = 1;
    var worked = (f.best || []).filter(function (x) { return x.process_score != null && +x.process_score >= 66 && !shown[x.id]; }).slice(0, 3);
    var hurt = (f.worst || []).filter(function (x) { return x.process_score != null && +x.process_score < 45 && !shown[x.id]; }).slice(0, 3);
    var any = worked.length || hurt.length || bw || gl;
    /* (with none graded, the sentence above has already said so) */
    if (!ready && graded > 0) {
      h += '<div class="pcx-note">Only ' + plural(graded, 'eligible position') + ' this week. EdgeDesk needs more activity before it can build a reliable Film Room — '
        + 'a week is graded from ' + GRADE_MIN + ' graded positions — so each decision is shown on its own and no pattern is drawn from them.</div>';
    }
    if (worked.length) h += '<section class="pcx-sec" aria-label="What worked"><div class="pcx-kicker">What worked</div>' + worked.map(function (x) { return decisionCard(x, { cls: 'good' }); }).join('') + '</section>';
    if (hurt.length) h += '<section class="pcx-sec" aria-label="What hurt"><div class="pcx-kicker">What hurt</div>' + hurt.map(function (x) { return decisionCard(x, { cls: 'attn' }); }).join('') + '</section>';
    if (bw || gl) {
      h += '<div class="pcx-pair">' + (bw ? decisionCard(bw, { kicker: 'Won on a poor decision', cls: 'badwin', explain: badWinWords(bw) }) : '')
        + (gl ? decisionCard(gl, { kicker: 'Lost on a good decision', cls: 'goodloss', explain: goodLossWords(gl) }) : '') + '</div>';
      h += '<div class="pcx-note">A result is one draw; a decision is graded on the price, timing and size it was made at. Outcome and decision quality are different things.</div>';
    }
    if (!any) {
      var seenAv = {}, avail = (f.settledList || []).concat(f.placedList || []).filter(function (x) { if (seenAv[x.id]) return false; seenAv[x.id] = 1; return true; }).slice(0, 5);
      if (avail.length) h += '<section class="pcx-sec" aria-label="This week\'s positions"><div class="pcx-kicker">This week\'s positions</div>' + avail.map(function (x) { return decisionCard(x); }).join('') + '</section>';
    }
    if ((f.broken || []).length) h += '<div class="pcx-quiet">' + plural(f.broken.length, 'position') + ' outside your rules this week. <button class="pfo-link" data-act="rules-broken">List them</button></div>';
    h += reviewBlock(f, st.reviewDraft);
    var fc = focusOf(st);
    if (fc) {
      h += '<section class="pcx-card focus" aria-label="Next week"><div class="pcx-kicker">Next week</div><div class="pcx-k2">Focus</div><div class="pcx-title">' + esc(fc.label) + '</div>'
        + '<div class="pcx-k2">Experiment</div><div class="pcx-line">Measure it: change one thing about your ' + esc(fc.label) + (fc.from === 'pattern' ? ' positions' : '') + ' for four weeks; EdgeDesk compares your '
        + esc((EXP_METRIC[fc.metric] || EXP_METRIC.CLV)[1]) + ' with the four weeks before. A focus is something to measure — what you do is your decision.</div>'
        + '<div class="pcx-acts">' + whyBtn(fc.why, fc.label) + '<button class="pfo-link" data-act="exp-setup" data-v="' + esc(fc.label) + '" data-metric="' + esc(fc.metric) + '">Set up the experiment</button></div></section>';
    }
    return h;
  }

  /* ── the whole Process page ── */
  function processView(st) {
    st = st || {};
    var sub = st.sub === 'report' || !st.sub ? 'overview' : st.sub, h = processNav(sub) + filterBar(st.filter);
    if (st.error) return h + '<div class="pfo-err">' + esc(st.error) + '</div>';
    if (!st.summary || !st.cells) return h + '<div class="pfo-empty">Loading your process…</div>';
    if (sub === 'overview') return h + processOverview(st);
    if (sub === 'film') return h + filmRoom(st.film, st);
    if (sub === 'explore') return h + exploreLanding(st);
    return h + explorePage(sub, st);
  }

  /* ═══ WHY — the evidence behind every figure on the page ═════════════
     whyItem(id, ctx) → { title, rows: [[label, text]], drill?, journal? }
     Every panel names its sample size, positions, date range, comparison
     group, CLV, P&L and ROI where they apply, confidence, methodology and
     limitations — so the reader can check, and challenge, the number. */
  function moneyRoi(pnl, staked) { return +staked > 0 ? pct(E.dec.divRound(String(pnl), String(staked), 6), 2) : null; }
  function whyItem(id, ctx) {
    ctx = ctx || {};
    var sm = ctx.summary || {}, p = sm.process || {}, se = sm.settled || {}, range = ctx.periodText || 'The period on screen', clv = p.clv || {};
    var clvLine = +clv.n ? pct(clv.avg_pct, 2) + ' on average over the ' + clv.n + ' positions with a closing price' + (+clv.with_close ? '; beat the close on ' + clv.beat + ' of ' + clv.with_close : '') : 'No closing price is recorded in this period';
    var pnlLine = +se.n ? money(se.pnl || 0, true) + ' on ' + plural(+se.n, 'settled position') + ' — for context only; profit and loss are never an input to a grade' : 'Nothing settled in this period';
    var roiLine = moneyRoi(se.pnl || 0, se.staked) ? moneyRoi(se.pnl || 0, se.staked) + ' on the stakes of the settled positions — context only' : 'n/a — nothing settled';
    if (id === 'score' || id === 'grade') {
      var graded = +p.graded || 0, conf = p.confidence || X.confidence(graded);
      return { title: graded >= GRADE_MIN ? 'Why the Process Score is ' + Math.round(+p.score) + ' (' + p.letter + ')' : 'Why the Process profile is still building', rows: [
        ['Sample size', graded + ' graded of ' + plural(+p.n || 0, 'position') + ' in the period'],
        ['Positions', 'A position is graded when it has at least one price to judge the decision by (closing price, a model probability recorded before the event, the price you researched, or the prices around its entry) and at least 30% of the weight. A result-only position is never graded.'],
        ['Date range', range],
        ['Comparison group', '50 is the closing price itself: above 50, your decisions on average beat what the market settled on.'],
        ['CLV', clvLine], ['P&L', pnlLine], ['ROI', roiLine],
        ['Confidence', X.CONFIDENCE_TEXT[conf] || conf],
        ['Threshold', 'No score or letter below ' + GRADE_MIN + ' graded positions: the point where confidence leaves “Building” and where a group first qualifies for a test.'],
        ['Methodology', 'Each decision is scored 0–100 from the prices recorded before it, and the score is the average over graded positions — the details follow.']]
        /* the grade's own method, row for row (GRADE_WHY) */
        .concat(GRADE_WHY.rows.filter(function (r) { return r[0] !== 'Confidence'; })) };
    }
    if (/^dim:/.test(id)) {
      var k = id.slice(4), d = DIM_WHY[k], c = (p.components || {})[k] || {}, nn = +c.n || 0;
      if (!d) return null;
      return { title: DIM_LABEL_OF[k] + (nn >= GRADE_MIN && c.avg != null ? ': ' + letterOf(c.avg) + ' (' + (+c.avg).toFixed(1) + ' of 100)' : ': building'), rows: [
        ['What it measures', d.what],
        ['Sample size', nn + ' position' + (nn === 1 ? '' : 's') + ' with ' + d.needs + (nn < GRADE_MIN ? ' — graded from ' + GRADE_MIN : '')],
        ['Positions', 'Positions placed in the period that have ' + d.needs + '.'],
        ['Date range', range], ['Comparison group', d.base], ['CLV', clvLine], ['P&L', 'Not an input to this dimension. ' + pnlLine.split(' — ')[0]], ['ROI', 'Not an input to this dimension'],
        ['Confidence', X.CONFIDENCE_TEXT[X.confidence(nn)] || ''],
        ['Methodology', d.how + ' The letter is the average on the same scale as the Process Score: ' + GRADE_SCALE],
        ['Limitations', d.limits]] };
    }
    if (/^f:/.test(id)) return ((ctx.analysis && ctx.analysis.findings) || []).filter(function (f) { return 'f:' + f.id === id; })[0] || null;
    if (id === 'tests') {
      var res = ctx.analysis || { tested: 0, total: 0 };
      return { title: 'How patterns are found', rows: [
        ['Sample size', (res.total || 0) + ' positions; ' + (res.tested || 0) + ' tests run this period'],
        ['Positions', 'Every position placed in the period, grouped by pre-specified dimensions: platform, sport, market type, timing, day, hour, price range, stake size, planned, decision tags, after the previous result, session, decision source, and combinations of sport, timing and platform with market type.'],
        ['Date range', range], ['Comparison group', 'Each group against every other position in the same period.'],
        ['CLV', 'Tested per position, over the positions with a closing price'], ['P&L', 'Return per $1 is tested, but a finding on results alone never rises above Developing'], ['ROI', 'As P&L'],
        ['Confidence', 'Observation (10+ positions) · Developing (30+, p < 0.10) · Supported (a process metric, q < 0.10 after correction, effect ≥ 0.2, same direction in both halves) · Strong evidence (100+, q < 0.05, effect ≥ 0.3, confirmed in the most recent 30%).'],
        ['Methodology', 'Welch two-sample t-tests; the Benjamini–Hochberg correction across every test run together; Cohen\'s d for the size of the effect.'],
        ['Limitations', 'An association in your own history, not a cause. The groups are not randomized. A group under 10 positions is never tested.']] };
    }
    if (/^exp:/.test(id)) {
      var e = (ctx.experiments || []).filter(function (x) { return 'exp:' + x.id === id; })[0];
      if (!e) return null;
      var r = (ctx.expResults || {})[e.id] || {}, m = EXP_METRIC[e.metric] || EXP_METRIC.CLV, len = Date.parse(e.ends_at) - Date.parse(e.starts_at);
      var before0 = new Date(Date.parse(e.starts_at) - len).toISOString().slice(0, 10);
      return { title: 'Experiment: ' + e.title, rows: [
        ['What it measures', (e.hypothesis ? e.hypothesis + ' — ' : '') + 'measured on ' + m[1] + ', fixed when it started.'],
        ['Sample size', (r.current ? r.current.n : 0) + ' positions during, ' + (r.baseline ? r.baseline.n : 0) + ' before; each side needs ' + (e.min_sample || 20)],
        ['Positions', 'Every position placed in each window (with the platform filter on screen).'],
        ['Date range', String(e.starts_at).slice(0, 10) + ' to ' + String(e.ends_at).slice(0, 10) + ' (during), against ' + before0 + ' to ' + String(e.starts_at).slice(0, 10) + ' (before)'],
        ['Comparison group', 'The same length of time immediately before the experiment started.'],
        ['CLV', m[0] === 'clv' ? (r.current ? metricText('clv', r.current.mean) + ' during vs ' + (r.baseline ? metricText('clv', r.baseline.mean) : '—') + ' before' : 'Not enough positions yet') : 'Not the measured metric'],
        ['P&L', m[0] === 'ret' ? 'Return per $1 is the measured metric' : 'Not the measured metric'], ['ROI', m[0] === 'ret' && r.current ? metricText('ret', r.current.mean) + ' during' : 'Not the measured metric'],
        ['Result so far', r.text || 'Measuring…'],
        ['Confidence', expStatus(r, e) + (r.test ? ' 95% interval of the difference ' + metricText(m[0], r.test.ci95[0]) + ' to ' + metricText(m[0], r.test.ci95[1]) + '.' : '')],
        ['Methodology', 'A Welch two-sample t-test of the measured metric during the experiment against the period before it. Adherence, when a behaviour was named, is the share of positions in the window that followed it' + (r.adherence != null ? ' (' + Math.round(100 * r.adherence) + '%)' : '') + '.'],
        ['Limitations', 'Before-and-after, not randomized: anything else that changed between the two periods moves the result too. It measures a change in process and never promises a result.']] };
    }
    if (/^pos:/.test(id)) {
      var x = (ctx.rows || {})[id.slice(4)];
      if (!x) return null;
      var comps = compsOf(x), j = x.journal || {};
      return { title: 'Why ' + (x.selection || x.event_name) + (x.grade ? ' graded ' + x.grade : ' is not graded'), journal: x.id, rows: [
        ['Sample size', 'One decision: a single result says little about the decision behind it.'],
        ['Positions', [x.selection, x.event_name, x.platform_label].filter(Boolean).join(' · ')],
        ['Date range', 'Entered ' + (x.placed_day || String(x.placed_at || '').slice(0, 10)) + (x.settled_day ? ' · settled ' + x.settled_day : '') + (x.timing_bucket && X.TIMING_LABEL[x.timing_bucket] ? ' · ' + X.TIMING_LABEL[x.timing_bucket] + ' the start' : '')],
        ['Comparison group', 'Its own recorded prices: the close' + (j.research_odds_american != null || j.research_price != null ? ', the price you researched' : '') + (j.opening_odds_american != null || j.opening_price != null ? ', the opening price' : '') + '.'],
        ['CLV', x.clv_pct != null ? pct(x.clv_pct, 2) + (j.closing_source ? ' (closing price from ' + ({ USER: 'you', PLATFORM: 'the platform', EDGEDESK_CAPTURE: 'EdgeDesk\'s capture' }[j.closing_source] || j.closing_source) + ')' : '')
          : x.clv_points != null ? pts(x.clv_points) + ' on the line' : 'No closing price recorded'],
        ['P&L', x.status === 'OPEN' ? 'Open' : x.pnl != null ? money(x.pnl, true) + ' (' + resultWord(x) + ')' : '—'],
        ['ROI', x.status !== 'OPEN' && x.pnl != null && +x.stake_amt > 0 ? moneyRoi(x.pnl, x.stake_amt) : 'n/a'],
        ['Process score', x.process_score != null ? x.process_score + ' of 100 · ' + x.grade + (x.process_weight != null ? ' · ' + x.process_weight + '% of the weight had data' : '') : 'Not graded: no price to judge the decision by was recorded'],
        ['Components', comps.length ? comps.map(function (c) { return X.COMPONENT_LABEL[c.k] + ' ' + c.v.toFixed(0); }).join(' · ') : 'None recorded'],
        ['Rules', +x.rules_applicable ? x.rules_followed + ' of ' + x.rules_applicable + ' rule checks kept' + (x.rules_broken && x.rules_broken.length ? ' — outside: ' + x.rules_broken.join('; ') : '') : 'No rule in force at entry'],
        ['Confidence', 'A single position: its grade is exact for this decision, but it is one example, not a pattern.'],
        ['Methodology', 'Each component 0–100 from the prices recorded before the event; weighted closing line value 30%, model edge 20%, price 15%, sizing 15%, timing 10%, rules 5%, market structure 5%, with missing components left out. Letters: ' + GRADE_SCALE],
        ['Limitations', 'Prices you entered yourself are your own record. A component with no data is left out, never estimated.']] };
    }
    if (id === 'week') {
      var f = ctx.film || {}, ws = f.summary || {}, wp = ws.process || {}, wse = ws.settled || {}, wc = wp.clv || {}, prior = (f.prior && f.prior.process) || {};
      return { title: 'Why this week reads: “' + filmSentence(f) + '”', rows: [
        ['Sample size', ((ws.placed && ws.placed.n) || 0) + ' entered · ' + (+wse.n || 0) + ' settled · ' + (+wp.graded || 0) + ' graded'],
        ['Positions', 'Positions entered in the week (for the grade and rules) and settled in it (for the result).'],
        ['Date range', 'Week of ' + weekRange(f.week || '') + ', in your time zone'],
        ['Comparison group', 'The four weeks before: process ' + (prior.letter && +prior.graded >= GRADE_MIN ? prior.letter + ' (' + prior.graded + ' graded)' : 'not graded (' + (+prior.graded || 0) + ' graded)') + '.'],
        ['CLV', +wc.n ? pct(wc.avg_pct, 2) + ' on average over ' + wc.n : 'No closing prices this week'],
        ['P&L', +wse.n ? money(wse.pnl || 0, true) : 'Nothing settled'], ['ROI', moneyRoi(wse.pnl || 0, wse.staked) || 'n/a'],
        ['Confidence', X.CONFIDENCE_TEXT[X.confidence(+wp.graded || 0)] || ''],
        ['Methodology', 'The sentence is chosen only from these figures: the result is the sign of the settled P&L; the process is the week\'s grade (good 66+, poor under 45), given only from ' + GRADE_MIN + ' graded positions; “fell” or “rose” compares the letter with the four weeks before when both are graded.'],
        ['Limitations', 'A week is a short window: a few results swing it, and a grade with few positions moves a lot.']] };
    }
    if (id === 'matrix') return { title: 'How process meets outcome', rows: [
      ['Sample size', 'Every position in the period, counted once'], ['Positions', 'Rows: the process band of the decision; columns: what happened.'], ['Date range', range],
      ['Comparison group', 'Good process 66+, average 45–65, poor under 45; ungraded where no price was recorded.'], ['CLV', clvLine], ['P&L', pnlLine], ['ROI', roiLine],
      ['Confidence', 'Counts, not estimates.'], ['Methodology', 'A bad win is a poor-process position that won; a good loss is a good-process position that lost.'],
      ['Limitations', 'A single result is one draw; patterns need many positions.']] };
    if (id === 'variance') { var vv = X.variance(p.variance); return { title: 'Results against what the prices implied', rows: [
      ['Sample size', vv ? vv.n + ' settled wins and losses' : 'None'], ['Positions', 'Settled wins and losses with a decimal price above 1.'], ['Date range', range],
      ['Comparison group', 'The wins the prices you took implied (1 ÷ decimal price, which includes the book\'s margin).'], ['CLV', clvLine], ['P&L', pnlLine], ['ROI', roiLine],
      ['Confidence', vv && vv.z != null ? 'z = ' + vv.z.toFixed(2) : 'n/a'], ['Methodology', 'Actual wins minus implied wins, divided by the standard deviation of a sum of independent wins at those probabilities.'],
      ['Limitations', 'Implied probabilities include the margin, so they slightly overstate the chance of each win.']] }; }
    if (id === 'compare') return { title: 'Last 30 days against the 30 before', rows: [
      ['Sample size', 'Graded positions in each window, shown beside each figure'], ['Positions', 'Positions placed in each 30-day window.'], ['Date range', 'The last 30 days, and the 30 days before them'],
      ['Comparison group', 'The previous 30 days.'], ['CLV', 'Compared when both windows have ' + GRADE_MIN + '+ positions with a closing price'], ['P&L', 'Not compared here'], ['ROI', 'Not compared here'],
      ['Confidence', 'The 95% interval of the change is shown; an interval that includes zero is not a change.'], ['Methodology', 'Welch two-sample t-test between the windows.'],
      ['Limitations', 'Before-and-after comparisons pick up everything that changed between the windows.']] };
    if (id === 'edge') return { title: 'How edge capture is measured', rows: [
      ['Sample size', 'Shown beside each figure (n)'], ['Positions', 'Positions with a model probability recorded before the event, and positions with a closing price.'], ['Date range', range],
      ['Comparison group', 'Model edge: your price against the model\'s probability. CLV: your price against the close.'], ['CLV', clvLine], ['P&L', pnlLine], ['ROI', roiLine],
      ['Confidence', X.CONFIDENCE_TEXT[X.confidence(+clv.n || 0)] || ''], ['Methodology', 'Capture rate = average CLV ÷ average model edge, an estimate when the two are measured on different positions.'],
      ['Limitations', 'A model probability recorded after the start is not credited.']] };
    if (/^table:/.test(id)) { var dim = id.slice(6); return { title: 'How this table is built', rows: [
      ['Sample size', 'Each row shows its own positions, settled positions, and the n behind its CLV and process figures'], ['Positions', 'Positions placed in the period, grouped by ' + (X.DIM_LABEL[dim] || dim).toLowerCase() + '.'],
      ['Date range', range], ['Comparison group', 'The other rows of the table; the tested comparisons are under Leaks and Strengths.'], ['CLV', 'Average per row, over positions with a closing price'],
      ['P&L', 'Settled P&L per row'], ['ROI', 'Settled P&L ÷ the stakes of the settled positions in the row'], ['Confidence', 'A row under ' + GRADE_MIN + ' positions is shown but never tested.'],
      ['Methodology', 'Sums of the positions in each row; averages over the positions that have the figure.'], ['Limitations', 'Descriptive figures, not tests: a difference between rows can be chance.']] }; }
    return null;
  }

  /* ═══ BEFORE YOU ENTER ════════════════════════════════════════════════ */
  var DIM_TEXT = { platform: 'on this platform', sport: 'in this sport', position_type: 'in this market type', timing: 'entered this long before the start',
    odds: 'at this price range', units: 'at this stake size', sport_type: 'in this sport and market', all: 'overall' };
  function preBetPanel(ctx, opts) {
    opts = opts || {};
    if (!ctx) return '';
    var h = '<section class="pfo-prebet" aria-label="Before you enter"><div class="pfo-sec-h">Before you enter</div>';
    var lines = [];
    if (opts.edgedesk) lines.push('<li>EdgeDesk fair price <b>' + esc(opts.edgedesk.fair) + '</b> against the market <b>' + esc(opts.edgedesk.market) + '</b>' + (opts.edgedesk.gap ? ' (gap ' + esc(opts.edgedesk.gap) + ')' : '') + '.</li>');
    if (ctx.model_ev != null) lines.push('<li>At this price, the model probability you entered implies an expected value of <b>' + esc(pct(ctx.model_ev, 1)) + '</b> per $1.</li>');
    var ex = opts.exposure;
    if (ex && ex.n) lines.push('<li>Already open on this event: <b>' + plural(ex.n, 'position') + '</b>, <b>' + esc(money(ex.risk)) + '</b> at risk on ' + esc(ex.platforms.join(', '))
      + (ex.picks.length ? ' (' + esc(ex.picks.join('; ')) + ')' : '') + '.</li>');
    if (ctx.timing_bucket && ctx.timing_bucket !== 'UNKNOWN') lines.push('<li>Timing: <b>' + esc(X.TIMING_LABEL[ctx.timing_bucket]) + '</b> the start.</li>');
    if (ctx.units != null) lines.push('<li>Size: <b>' + esc((+ctx.units).toFixed(2)) + ' units</b>' + (ctx.max_single_units != null ? ' against your ' + esc(ctx.max_single_units) + '-unit cap' : '') + '.</li>');
    if (ctx.max_daily_units != null) lines.push('<li>Already entered today: <b>' + esc((+ctx.today_units || 0).toFixed(2)) + ' units</b> in ' + plural(+ctx.today_count || 0, 'position') + ' · daily cap ' + esc(ctx.max_daily_units) + ' units.</li>');
    (ctx.rules || []).filter(function (r) { return r.verdict === 'BROKEN'; }).forEach(function (r) { lines.push('<li class="pfo-warn">Outside your rule: <b>' + esc(r.label) + '</b>.</li>'); });
    (ctx.history || []).filter(function (c) { return c.dim !== 'all' && +c.settled >= X.MIN.observation; }).forEach(function (c) {
      var roi = +c.staked > 0 ? +c.pnl / +c.staked : null, clv = +c.clv_n > 0 ? +c.clv_sum / +c.clv_n : null, ps = +c.ps_n > 0 ? +c.ps_sum / +c.ps_n : null;
      lines.push('<li>Your last 12 months ' + esc(DIM_TEXT[c.dim] || '') + ' (' + esc(X.keyLabel(c.dim, c.key)) + '): ' + plural(+c.settled, 'settled position')
        + (roi != null ? ', ROI ' + esc(pct(roi, 1)) : '') + (clv != null ? ', average CLV ' + esc(pct(clv, 2)) + ' (n=' + c.clv_n + ')' : '') + (ps != null ? ', process ' + ps.toFixed(1) + ' (n=' + c.ps_n + ')' : '')
        + ' · confidence ' + esc(X.confidence(+c.settled)) + '.</li>');
    });
    if (!lines.length) lines.push('<li>No history yet in a context like this one (groups under ' + X.MIN.observation + ' settled positions are not shown).</li>');
    return h + '<ul class="pfo-prebet-l">' + lines.join('') + '</ul><div class="pfo-note">Context from your own record — the decision is yours.</div></section>';
  }

  return {
    gradeCard: gradeCard, evidenceLine: evidenceLine, insights: insights, findingRow: findingRow, whyPanel: whyPanel, GRADE_WHY: GRADE_WHY,
    platformChips: platformChips, hero: hero, calendarView: calendarView, monthDays: monthDays, compactMoney: compactMoney, monthSettled: monthSettled, weekOf: weekOf, dayDetail: dayDetail,
    journalCard: journalCard, journalEditor: journalEditor, journalPatch: journalPatch, journalIssues: journalIssues, journalView: journalView,
    GRADE_MIN: GRADE_MIN, PROCESS_NAV: PROCESS_NAV, EXPLORE_PAGES: EXPLORE_PAGES, DIMS: DIMS, navOf: navOf,
    processView: processView, coachView: processView, processHero: processHero, processOverview: processOverview, filterBar: filterBar, filterSheet: filterSheet,
    exploreLanding: exploreLanding, explorePage: explorePage, focusOf: focusOf, filmSentence: filmSentence, badWinWords: badWinWords, goodLossWords: goodLossWords,
    reviewCard: reviewCard, whyItem: whyItem, matrixTable: matrixTable, breakdownTable: breakdownTable, rulesView: rulesView, ruleFromForm: ruleFromForm,
    experimentsView: experimentsView, filmRoom: filmRoom, preBetPanel: preBetPanel, dayLabel: dayLabel, esc: esc
  };
}));
