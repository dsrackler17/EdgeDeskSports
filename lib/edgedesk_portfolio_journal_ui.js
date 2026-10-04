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
    var rows = item.rows || (item.why ? [['Data used', item.why.data_used], ['Sample size', item.why.sample], ['Period', item.why.period || 'The period shown'],
      ['Comparison group', item.why.comparison], ['Calculation', item.why.calculation], ['Confidence', item.why.confidence], ['Limitations', item.why.limitations]] : []);
    return '<div class="pfo-panel" role="dialog" aria-modal="true" aria-label="' + esc(item.title || 'Why') + '"><div class="pfo-panel-h"><div class="pfo-panel-t">'
      + esc(item.title || ('Why: ' + (item.headline || ''))) + '</div><button class="pfo-x" data-act="why-close" aria-label="Close">×</button></div>'
      + '<dl class="pfo-why-dl">' + rows.filter(function (r) { return r[1]; }).map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>'; }).join('') + '</dl>'
      + (item.why && item.why.positions ? '<div class="pfo-btns"><button class="pfo-btn ghost sm" data-act="drill" data-dim="' + esc(item.why.positions.dim) + '" data-key="' + esc(item.why.positions.key) + '">List the positions</button></div>' : '')
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

  /* ═══ the Process Coach ═══════════════════════════════════════════════ */
  var COACH_PAGES = [['report', 'Process Report'], ['leaks', 'Leaks'], ['strengths', 'Strengths'], ['timing', 'Timing'], ['edge', 'Edge Capture'],
    ['rules', 'Rules'], ['experiments', 'Experiments'], ['film', 'Film Room']];
  function coachNav(sub) {
    return '<nav class="pfo-chips pfo-coachnav" role="tablist" aria-label="Process Coach">' + COACH_PAGES.map(function (p) {
      return '<button class="pfo-chip" role="tab" data-act="coach" data-v="' + p[0] + '" aria-selected="' + (sub === p[0]) + '">' + p[1] + '</button>';
    }).join('') + '</nav>';
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
    return '<section class="pfo-sec"><div class="pfo-sec-h">' + esc(title) + '</div><div class="pfo-tablewrap"><table class="pfo-table"><thead><tr><th></th><th class="r">Positions</th>'
      + '<th class="r">Settled</th><th class="r">P&amp;L</th><th class="r">ROI</th><th class="r">Avg CLV</th><th class="r">Process</th></tr></thead><tbody>'
      + list.map(function (c) {
        var roi = +c.staked > 0 ? +c.pnl / +c.staked : null, clv = +c.clv_n > 0 ? +c.clv_sum / +c.clv_n : null, ps = +c.ps_n > 0 ? +c.ps_sum / +c.ps_n : null;
        return '<tr><th scope="row"><button class="pfo-link" data-act="drill" data-dim="' + esc(dim) + '" data-key="' + esc(c.key) + '">' + esc(X.keyLabel(dim, c.key)) + '</button></th>'
          + '<td class="r">' + c.n + '</td><td class="r">' + c.settled + '</td><td class="r">' + signed(c.pnl) + '</td>'
          + '<td class="r">' + esc(roi == null ? '—' : pct(roi, 1)) + '</td><td class="r">' + (clv == null ? '—' : esc(pct(clv, 2)) + ' <small>n=' + c.clv_n + '</small>')
          + '</td><td class="r">' + (ps == null ? '—' : ps.toFixed(1) + ' <small>n=' + c.ps_n + '</small>') + '</td></tr>';
      }).join('') + '</tbody></table></div><div class="pfo-note">Sample sizes are on every figure; a group under 10 positions is shown but never tested.</div></section>';
  }
  function coachView(st) {
    st = st || {};
    var sub = st.sub || 'report', h = coachNav(sub);
    var sm = st.summary, res = st.analysis, cells = st.cells;
    if (!sm || !cells) return h + '<div class="pfo-empty">Loading your process…</div>';
    if (sub === 'report') {
      h += gradeCard(sm.process, { evidence: sm.evidence });
      h += '<section class="pfo-sec"><div class="pfo-sec-h">Process vs outcome</div>' + matrixTable(X.matrix(sm.matrix)) + '</section>';
      var v = X.variance(sm.process && sm.process.variance);
      if (v) h += '<section class="pfo-sec"><div class="pfo-sec-h">Results vs what the prices implied</div><div class="pfo-note">' + esc(v.text) + '</div></section>';
      if (st.compare) h += changeBlock(st.compare);
      h += insights(X.headlines(res));
      return h;
    }
    if (sub === 'leaks' || sub === 'strengths') {
      var kind = sub === 'leaks' ? 'LEAK' : 'STRENGTH', list = res.findings.filter(function (f) { return f.kind === kind; });
      h += '<div class="pfo-note">Pre-specified comparisons only (' + res.tested + ' tests this period, corrected together for multiple comparisons). A finding needs a process metric to reach Supported; profit alone never does.</div>';
      if (!list.length) return h + '<div class="pfo-none"><b>' + (kind === 'LEAK' ? 'NO RELIABLE LEAK DETECTED' : 'NO RELIABLE STRENGTH DETECTED') + '</b><div class="pfo-note">' + esc(X.headlines(res).none_detail) + '</div></div>';
      return h + list.map(findingRow).join('');
    }
    if (sub === 'timing') {
      return h + breakdownTable(cells, 'timing', 'When you enter, relative to the start') + breakdownTable(cells, 'placed_dow', 'Day you entered')
        + breakdownTable(cells, 'event_dow', 'Day of the event') + breakdownTable(cells, 'hour', 'Time of day you entered')
        + breakdownTable(cells, 'session', 'Position within a session (same day, under 90 minutes apart)') + breakdownTable(cells, 'after', 'After the previous result');
    }
    if (sub === 'edge') {
      var p = sm.process || {}, ev = p.model_ev || {}, clv = p.clv || {}, slip = p.price_slip || {};
      h += '<section class="pfo-sec"><div class="pfo-sec-h">Edge capture</div>';
      if (!(+ev.n) && !(+clv.n)) return h + '<div class="pfo-note">Edge capture needs model probabilities recorded before the event and closing prices. None are recorded in this period.</div></section>';
      h += '<dl class="pfo-dl"><dt>Model edge at entry</dt><dd>' + (+ev.n ? esc(pct(ev.avg, 2)) + ' <small>n=' + ev.n + '</small>' : '—') + '</dd>'
        + '<dt>Closing line value</dt><dd>' + (+clv.n ? esc(pct(clv.avg_pct, 2)) + ' <small>n=' + clv.n + '</small>' : '—') + '</dd>'
        + '<dt>Beat the close</dt><dd>' + (+clv.with_close ? clv.beat + ' of ' + clv.with_close : '—') + '</dd>'
        + '<dt>Price given up between research and entry</dt><dd>' + (+slip.n ? esc(money(slip.given_up)) + ' <small>estimate · n=' + slip.n + '</small>' : '—') + '</dd></dl>';
      if (+ev.n && +clv.n && +ev.avg > 0) h += '<div class="pfo-note">Capture rate (average CLV ÷ average model edge, over different subsets when not every position has both): <b>' + esc(Math.round(100 * clv.avg_pct / ev.avg) + '%') + '</b>. An estimate, not a recorded figure.</div>';
      return h + '</section>' + breakdownTable(cells, 'decision_source', 'By decision source');
    }
    if (sub === 'rules') return h + rulesView(st.rules, sm);
    if (sub === 'experiments') return h + experimentsView(st.experiments, st.expResults);
    if (sub === 'film') return h + filmRoom(st.film);
    return h;
  }
  function changeBlock(cmp) {
    var rows = [['ps', 'Process score'], ['clv', 'Closing line value']].map(function (k) {
      var c = cmp[k[0]]; if (!c || !c.enough) return '<dt>' + k[1] + '</dt><dd class="pfo-mut">not enough positions in both periods to compare</dd>';
      var fmt = function (v) { return k[0] === 'ps' ? v.toFixed(1) : pct(v, 2); };
      return '<dt>' + k[1] + '</dt><dd>' + fmt(c.previous.mean) + ' → <b>' + fmt(c.current.mean) + '</b> <small>n=' + c.previous.n + ' → ' + c.current.n
        + (c.test ? ' · 95% interval of the change ' + fmt(c.test.ci95[0]) + ' to ' + fmt(c.test.ci95[1]) : '') + '</small></dd>';
    }).join('');
    return '<section class="pfo-sec"><div class="pfo-sec-h">Last 30 days vs the 30 before</div><dl class="pfo-dl">' + rows + '</dl></section>';
  }
  function rulesView(rules, sm) {
    var p = (sm && sm.process && sm.process.rules) || {};
    var h = '<section class="pfo-sec"><div class="pfo-sec-h">Your rules</div>'
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
  function experimentsView(list, results) {
    var h = '<section class="pfo-sec"><div class="pfo-sec-h">Process experiments</div>'
      + '<div class="pfo-note">Change one thing for a set period and measure it against the same length of time before. What is measured, on what, and for how long is fixed when you start — so the answer cannot be steered afterwards.</div>';
    h += (list || []).map(function (e) {
      var r = (results || {})[e.id];
      return '<div class="pfo-find"><div class="pfo-find-h"><b>' + esc(e.title) + '</b> <span class="pfo-level ' + (r ? r.status : '') + '">' + esc(r ? r.status.replace('_', ' ') : 'measuring…') + '</span></div>'
        + '<div class="pfo-note">' + esc(e.hypothesis || '') + ' Measured on ' + esc({ CLV: 'closing line value', PROCESS: 'process score', ROI: 'return' }[e.metric]) + ' · '
        + esc(String(e.starts_at).slice(0, 10)) + ' to ' + esc(String(e.ends_at).slice(0, 10)) + ' · at least ' + e.min_sample + ' positions each side.</div>'
        + (r ? '<div class="pfo-note">' + esc(r.text) + '</div>' : '')
        + (e.status === 'ACTIVE' ? '<div class="pfo-btns"><button class="pfo-btn ghost sm" data-act="exp-end" data-id="' + esc(e.id) + '">End now</button></div>' : '') + '</div>';
    }).join('') || '<div class="pfo-note">No experiments yet.</div>';
    h += '<form class="pfo-form" data-form="experiment" novalidate><label class="pfo-field full"><span class="pfo-l">What you will change</span><input name="title" maxlength="120" placeholder="Enter NFL positions at least a day before kickoff"></label>'
      + '<label class="pfo-field full"><span class="pfo-l">What you expect</span><input name="hypothesis" maxlength="500" placeholder="My closing line value improves"></label>'
      + '<label class="pfo-field"><span class="pfo-l">Measured on</span><select name="metric"><option value="CLV">Closing line value</option><option value="PROCESS">Process score</option><option value="ROI">Return</option></select></label>'
      + '<label class="pfo-field"><span class="pfo-l">For (days)</span><input name="days" inputmode="numeric" value="28"></label>'
      + '<label class="pfo-field"><span class="pfo-l">The behaviour, to measure adherence (optional)</span><select name="condition"><option value="">—</option>'
      + Object.keys(X.TIMING_LABEL).filter(function (k) { return k !== 'UNKNOWN'; }).map(function (k) { return '<option value="timing:' + k + '">Timing: ' + esc(X.TIMING_LABEL[k]) + '</option>'; }).join('')
      + '<option value="planned:PLANNED">Planned positions only</option></select></label></form>'
      + '<div class="pfo-btns"><button class="pfo-btn" data-act="exp-add">Start experiment</button></div>';
    return h + '</section>';
  }
  function filmRoom(f) {
    if (!f) return '<div class="pfo-empty">Loading the week…</div>';
    var h = '<section class="pfo-sec"><div class="pfo-sec-h">Weekly Film Room · week of ' + esc(dayLabel(f.week).replace(/, \d+$/, ''))
      + '<span class="pfo-right"><button class="pfo-btn ghost sm" data-act="film-move" data-v="-1">‹ Earlier</button> <button class="pfo-btn ghost sm" data-act="film-move" data-v="1">Later ›</button></span></div>';
    var sm = f.summary || {}, st = sm.settled || {}, pr = sm.process || {};
    h += '<div class="pfo-kpis"><div><div class="pfo-k">P&amp;L</div><div class="pfo-v ' + tone(st.pnl) + '">' + esc(money(st.pnl || 0, true)) + '</div></div>'
      + '<div><div class="pfo-k">Entered</div><div class="pfo-v">' + ((sm.placed && sm.placed.n) || 0) + '</div></div>'
      + '<div><div class="pfo-k">Decision Grade</div><div class="pfo-v">' + esc(pr.letter || '—') + ' <small>n=' + (pr.graded || 0) + '</small></div></div>'
      + '<div><div class="pfo-k">Rule checks</div><div class="pfo-v">' + (pr.rules && +pr.rules.applicable ? pr.rules.followed + '/' + pr.rules.applicable : '—') + '</div></div></div>';
    if (f.prior) {
      var pp = f.prior.process || {};
      h += '<div class="pfo-note">The four weeks before: Decision Grade ' + esc(pp.letter || '—') + ' (n=' + (pp.graded || 0) + '), P&amp;L ' + esc(money((f.prior.settled || {}).pnl || 0, true)) + '.</div>';
    }
    h += '</section>';
    var block = function (title, list, note) {
      return '<section class="pfo-sec"><div class="pfo-sec-h">' + esc(title) + ' <small>' + (list ? list.length : 0) + '</small></div>' + (note ? '<div class="pfo-note">' + esc(note) + '</div>' : '')
        + (list && list.length ? list.map(journalCard).join('') : '<div class="pfo-note">None this week.</div>') + '</section>';
    };
    return h + block('Best decisions', f.best, 'Highest process scores, whatever the result.') + block('Weakest decisions', f.worst, 'Lowest process scores, whatever the result.')
      + block('Won on a poor decision', f.badWins) + block('Lost on a good decision', f.goodLosses) + block('Outside your rules', f.broken)
      + '<section class="pfo-sec"><div class="pfo-sec-h">Review</div><div class="pfo-note">Open any position above and answer one question: <b>would you make this bet again?</b> YES, NO or UNSURE, and a sentence. Your answers build your Mistake and Strength Libraries.</div></section>';
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
    COACH_PAGES: COACH_PAGES, coachView: coachView, matrixTable: matrixTable, breakdownTable: breakdownTable, rulesView: rulesView, ruleFromForm: ruleFromForm,
    experimentsView: experimentsView, filmRoom: filmRoom, preBetPanel: preBetPanel, dayLabel: dayLabel, esc: esc
  };
}));
