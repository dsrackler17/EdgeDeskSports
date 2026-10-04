/* ===========================================================================
   EdgeDesk PROCESS — what the reader's own history says about how they decide.

   Portfolio answers "what happened?". This answers "why might it be
   happening?", and only as far as the history can carry it.

   THE ONE MEASURE: did the position beat the closing line? It is the same
   yes/no for a price tracked from an edge (CLV in price), a spread placed
   from the Card (CLV in points) and anything else graded against a close, so
   sources can be pooled without converting units. Results are noise at these
   sample sizes and never drive an insight here.

   NOTHING IS MANUFACTURED.
     * below MIN_PROFILE graded positions there is no score and no insight —
       the page says what it is building and what each step unlocks;
     * a group is compared only with MIN_GROUP graded positions on BOTH sides
       of the comparison;
     * a difference becomes an insight only when it is at least MIN_GAP
       (10 percentage points) AND a two-proportion z of at least Z_SHOW; it is
       labelled "clear" only at the 95% level, "early" otherwise.

   Pure: no DOM, no storage, no network. Browser: window.EDProcess.
   Node: require('./edgedesk_process.js'). Input is EDPortfolio.collect()'s
   positions. Held by tools/app/portfolio_process.test.js.
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EDProcess = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var VERSION = 'edgedesk_process_v1';
  var MIN_EDGE = 10;        // graded positions before an edge-capture read
  var MIN_PROFILE = 20;     // graded positions before a score or any insight
  var MIN_GROUP = 8;        // graded positions in a group AND in its complement
  var MIN_GAP = 0.10;       // beat-rate difference before anything is said
  var Z_SHOW = 1.0;         // smallest two-proportion z that is mentioned at all
  var Z_CLEAR = 1.96;       // "clear" at the 95% level

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function pc(x) { return isNum(x) ? Math.round(x * 100) + '%' : '—'; }
  function wilson(k, n) {
    if (!n) return null;
    var z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
    return { lo: Math.max(0, (c - m) / d), hi: Math.min(1, (c + m) / d) };
  }

  /* ---------------------------------------------------------------- groups
     Each family splits the graded history one way. A position that cannot be
     placed in a family (no game time, no fair price at entry) is simply not in
     that family's comparison — it is never assigned a guessed bucket. */
  function hoursBefore(p) {
    var t = Date.parse(p.ts), g = Date.parse(p.commence);
    if (!isFinite(t) || !isFinite(g)) return null;
    return (g - t) / 3.6e6;
  }
  var FAMILIES = [
    { id: 'timing', title: 'Timing', note: 'when you entered, against the game’s start',
      key: function (p) { var h = hoursBefore(p); if (h == null) return null; return h >= 24 ? 'early' : h >= 3 ? 'sameday' : h >= 0 ? 'late' : 'live'; },
      label: { early: 'Early (a day or more before)', sameday: 'Same day (3–24 hours before)', late: 'Late (final 3 hours)', live: 'After the start' },
      phrase: { early: 'early positions (a day or more before the game)', sameday: 'same-day positions (3–24 hours before)', late: 'late positions (the final three hours)', live: 'positions entered after the start' } },
    { id: 'sport', title: 'Sport', note: 'by league',
      key: function (p) { return p.sport || null; }, label: {}, phrase: {}, word: function (k) { return k; } },
    { id: 'market', title: 'Market', note: 'spread, total, moneyline, prop',
      key: function (p) { return p.market || null; }, label: {}, phrase: {}, word: function (k) { return String(k).toLowerCase(); } },
    { id: 'price', title: 'Price at entry', note: 'your price against EdgeDesk’s sharp fair line when you logged it',
      key: function (p) { return p.entryEdge == null ? null : p.entryEdge >= 0 ? 'above' : 'below'; },
      label: { above: 'At or better than fair', below: 'Worse than fair' },
      phrase: { above: 'positions taken at or better than the fair price', below: 'positions taken at a price worse than fair' } },
    { id: 'range', title: 'EdgeDesk range', note: 'Card bets: your price against EdgeDesk’s playable range',
      key: function (p) { return p.range || null; },
      label: { inside: 'Inside EdgeDesk’s range', outside: 'Outside EdgeDesk’s range' },
      phrase: { inside: 'Card bets placed inside EdgeDesk’s playable range', outside: 'Card bets placed outside EdgeDesk’s playable range' } }
  ];
  function labelOf(f, k) { return f.label[k] || k; }
  function phraseOf(f, k) { return f.phrase[k] || ((f.word ? f.word(k) : k) + ' positions'); }

  function tally(list) {
    var n = 0, k = 0, price = [], pts = [];
    list.forEach(function (p) {
      if (p.beat_close == null) return;
      n++; if (p.beat_close) k++;
      if (p.clv && p.clv.kind === 'price') price.push(p.clv.v);
      if (p.clv && p.clv.kind === 'points') pts.push(p.clv.v);
    });
    function avg(a) { return a.length ? a.reduce(function (s, v) { return s + v; }, 0) / a.length : null; }
    return { n: n, beat: k, rate: n ? k / n : null, ci: wilson(k, n), avg_clv_price: avg(price), clv_price_n: price.length, avg_clv_points: avg(pts), clv_points_n: pts.length };
  }
  function zTwo(a, b) {
    if (!a.n || !b.n) return 0;
    var p = (a.beat + b.beat) / (a.n + b.n), se = Math.sqrt(p * (1 - p) * (1 / a.n + 1 / b.n));
    return se > 0 ? (a.rate - b.rate) / se : 0;
  }

  function groups(graded) {
    var out = [];
    FAMILIES.forEach(function (f) {
      var by = {};
      graded.forEach(function (p) { var k = f.key(p); if (k == null) return; (by[k] = by[k] || []).push(p); });
      var placed = Object.keys(by).reduce(function (s, k) { return s.concat(by[k]); }, []);
      var rows = Object.keys(by).map(function (k) {
        var t = tally(by[k]);
        var rest = tally(placed.filter(function (p) { return f.key(p) !== k; }));
        var comparable = t.n >= MIN_GROUP && rest.n >= MIN_GROUP;
        return Object.assign({ family: f.id, key: k, label: labelOf(f, k), phrase: phraseOf(f, k), rest: rest, comparable: comparable,
          diff: comparable ? t.rate - rest.rate : null, z: comparable ? zTwo(t, rest) : null }, t);
      }).sort(function (a, b) { return b.n - a.n; });
      if (rows.length) out.push({ id: f.id, title: f.title, note: f.note, rows: rows, placed: placed.length });
    });
    return out;
  }

  function insightOf(r) {
    var dir = r.diff > 0 ? 'working' : 'costing';
    var strength = Math.abs(r.z) >= Z_CLEAR ? 'clear' : 'early';
    var text = 'Your ' + r.phrase + ' beat the closing line ' + pc(r.rate) + ' of the time, against ' + pc(r.rest.rate) + ' for the rest of your history.';
    var why = r.n + ' graded in this group, ' + r.rest.n + ' outside it. '
      + (strength === 'clear' ? 'The gap is clear at the 95% level.' : 'An early pattern: real enough to watch, not yet strong enough to act on alone.');
    return { kind: dir, strength: strength, family: r.family, key: r.key, label: r.label, phrase: r.phrase, text: text, why: why, n: r.n, rate: r.rate, rest_rate: r.rest.rate, diff: r.diff, z: r.z };
  }

  /* ---------------------------------------------------------------- profile */
  function profile(positions, opts) {
    var now = (opts && opts.now) || Date.now();
    var all = positions || [];
    var graded = all.filter(function (p) { return p.beat_close != null; });
    var t = tally(graded);
    var state = !all.length ? 'empty' : graded.length < MIN_PROFILE ? 'building' : 'ready';
    var G = groups(graded);
    var ins = [];
    if (state === 'ready') {
      G.forEach(function (g) {
        g.rows.forEach(function (r) {
          if (r.comparable && Math.abs(r.diff) >= MIN_GAP && Math.abs(r.z) >= Z_SHOW) ins.push(insightOf(r));
        });
      });
      ins.sort(function (a, b) { return Math.abs(b.z) - Math.abs(a.z); });
    }
    /* the same group can surface twice (its complement is the other side of a
       two-way split); keep the stronger statement of each split */
    var seenFam2 = {};
    ins = ins.filter(function (x) {
      var g = G.filter(function (y) { return y.id === x.family; })[0];
      if (g && g.rows.length === 2) { if (seenFam2[x.family]) return false; seenFam2[x.family] = 1; }
      return true;
    });
    var working = ins.filter(function (x) { return x.kind === 'working'; }).slice(0, 2);
    var costing = ins.filter(function (x) { return x.kind === 'costing'; }).slice(0, 2);
    var weekAgo = now - 7 * 864e5;
    var wk = all.filter(function (p) { var x = Date.parse(p.ts); return isFinite(x) && x >= weekAgo && x <= now; });
    var wkGraded = tally(all.filter(function (p) { var x = Date.parse(p.commence || p.ts); return p.beat_close != null && isFinite(x) && x >= weekAgo && x <= now; }));
    var focus;
    if (state === 'empty') focus = { text: 'Bring your history into Portfolio. Process reads it from there.', action: 'portfolio' };
    else if (state === 'building') focus = { text: 'Grade ' + (MIN_PROFILE - graded.length) + ' more position' + (MIN_PROFILE - graded.length === 1 ? '' : 's') + ' against the close to unlock your process score and the first comparisons.', action: 'portfolio' };
    else if (costing.length) focus = { text: 'Examine your ' + costing[0].phrase + ': ' + pc(costing[0].rate) + ' beat the close, against ' + pc(costing[0].rest_rate) + ' everywhere else. Ask what is different about how you choose or time them.', insight: costing[0] };
    else if (working.length) focus = { text: 'Keep doing what works — your ' + working[0].phrase + ' — and keep logging, so the next pattern has the sample to show.', insight: working[0] };
    else focus = { text: 'Nothing in your history differs from your own average by enough to call yet. Keep logging; comparisons sharpen with every graded position.' };
    var unlocks = [
      { need: MIN_EDGE, have: graded.length, done: graded.length >= MIN_EDGE, what: 'Edge capture — how often your prices beat the close, and by how much' },
      { need: MIN_PROFILE, have: graded.length, done: graded.length >= MIN_PROFILE, what: 'Process score, what’s working and what’s costing you' },
      { need: MIN_GROUP * 2, have: graded.length, done: G.some(function (g) { return g.rows.some(function (r) { return r.comparable; }); }), what: 'Timing, sport, market and price comparisons — ' + MIN_GROUP + ' graded in a group and ' + MIN_GROUP + ' outside it' }
    ];
    return {
      version: VERSION, as_of: new Date(now).toISOString(), state: state,
      counts: { positions: all.length, graded: graded.length, open: all.filter(function (p) { return !p.result; }).length },
      score: state === 'ready' ? { value: Math.round(t.rate * 100), rate: t.rate, ci: t.ci, n: t.n } : null,
      edge: graded.length >= MIN_EDGE ? t : null, so_far: t,
      working: working, costing: costing, focus: focus, groups: G,
      week: { logged: wk.length, graded: wkGraded.n, beat: wkGraded.beat, rate: wkGraded.rate },
      unlocks: unlocks,
      thresholds: { MIN_EDGE: MIN_EDGE, MIN_PROFILE: MIN_PROFILE, MIN_GROUP: MIN_GROUP, MIN_GAP: MIN_GAP, Z_SHOW: Z_SHOW, Z_CLEAR: Z_CLEAR }
    };
  }

  /* ------------------------------------------------------------- rendering */
  function signed(x, dp, unit) { if (!isNum(x)) return '—'; return (x > 0 ? '+' : '') + x.toFixed(dp) + (unit || ''); }
  function insightHTML(x, i) {
    return '<details class="pc-ins ' + x.kind + '"><summary><span class="pc-tag ' + x.strength + '">' + (x.strength === 'clear' ? 'Clear' : 'Early pattern') + '</span>'
      + '<span class="pc-txt">' + esc(x.text) + '</span><span class="pc-why-b">Why?</span></summary>'
      + '<div class="pc-why">' + esc(x.why) + ' Beating the close means your price was better than the market’s final number — the measure of a good entry, separate from whether the bet won.'
      + ' <button type="button" class="pf-link" data-pc-open="' + esc(x.family) + '">See the ' + esc(x.family) + ' table ›</button></div></details>';
  }
  function tableHTML(g) {
    return '<details class="pc-deep" data-pc-fam="' + esc(g.id) + '"><summary><b>' + esc(g.title) + '</b><span>' + esc(g.note) + '</span></summary>'
      + '<div class="pc-tbl"><div class="pc-tr h"><span>Group</span><span>Graded</span><span>Beat close</span><span>Avg CLV</span></div>'
      + g.rows.map(function (r) {
        var clv = r.clv_price_n ? signed(r.avg_clv_price * 100, 1, '%') : (r.clv_points_n ? signed(r.avg_clv_points, 1, ' pts') : '—');
        return '<div class="pc-tr"><span>' + esc(r.label) + '</span><span>' + r.n + '</span><span>' + (r.n ? pc(r.rate) : '—') + (r.n && r.n < MIN_GROUP ? ' <i>thin</i>' : '') + '</span><span>' + clv + '</span></div>';
      }).join('') + '</div><div class="pc-note">A group is compared with the rest of your history only once both have ' + MIN_GROUP + ' graded positions.</div></details>';
  }
  function pageHTML(P, extra) {
    extra = extra || {};
    var h = '';
    if (P.state === 'empty' || P.state === 'building') {
      var pctDone = Math.min(100, Math.round(P.counts.graded / MIN_PROFILE * 100));
      h += '<div class="pc-build"><div class="pf-ey">Building your process profile</div>'
        + '<div class="pf-t">EdgeDesk needs more history before it can identify reliable patterns in how you decide.</div>'
        + '<div class="pc-bar" role="progressbar" aria-valuemin="0" aria-valuemax="' + MIN_PROFILE + '" aria-valuenow="' + P.counts.graded + '" aria-label="Graded positions toward your process profile"><i style="width:' + pctDone + '%"></i></div>'
        + '<div class="pc-bar-l">' + P.counts.graded + ' of ' + MIN_PROFILE + ' positions graded against the closing line'
        + (P.counts.positions > P.counts.graded ? ' · ' + (P.counts.positions - P.counts.graded) + ' more waiting on a close or without one' : '') + '</div>'
        + '<div class="pc-h">Available now</div><div class="pc-kpis">'
        + '<div class="pf-kpi"><div class="v">' + P.counts.positions + '</div><div class="l">Positions in Portfolio</div></div>'
        + '<div class="pf-kpi"><div class="v">' + P.counts.graded + '</div><div class="l">Graded against the close</div></div>'
        + '<div class="pf-kpi"><div class="v">' + (P.so_far.n ? P.so_far.beat + ' of ' + P.so_far.n : '—') + '</div><div class="l">Beat the close so far</div><div class="n">' + (P.so_far.n ? 'too few to read as a pattern' : 'nothing graded yet') + '</div></div>'
        + '</div><div class="pc-h">What unlocks</div><ul class="pc-unl">'
        + P.unlocks.map(function (u) { return '<li class="' + (u.done ? 'done' : '') + '"><b>' + (u.done ? 'Unlocked' : u.need + ' graded') + '</b><span>' + esc(u.what) + '</span></li>'; }).join('')
        + '</ul><div class="pc-note">Nothing on this page is estimated to fill the gap. A position is graded once the closing line for it is captured; positions logged by hand without a linked game cannot be graded against a close.</div>'
        + '<div class="pf-acts"><button type="button" class="btn" data-nav="portfolio">' + (P.state === 'empty' ? 'Build your portfolio' : 'Open Portfolio') + '</button></div></div>';
      if (P.edge) h += edgeHTML(P);
      h += journalHTML(extra.journal);
      return h + methodHTML();
    }
    var s = P.score;
    h += '<div class="pc-score"><div class="pc-score-v">' + s.value + '</div><div class="pc-score-t"><b>Process score</b><span>' + s.n + ' graded positions · '
      + 'the share whose price beat the closing line' + (s.ci ? ' (95% range ' + pc(s.ci.lo) + '–' + pc(s.ci.hi) + ')' : '') + '. Above 50 means more of your entries beat the market’s final number than did not.</span></div></div>';
    h += '<div class="pc-sec"><div class="pc-h">What’s working</div>' + (P.working.length ? P.working.map(insightHTML).join('') : '<div class="pf-none">No part of your history beats your own average by enough to call yet.</div>') + '</div>';
    h += '<div class="pc-sec"><div class="pc-h">What’s costing you</div>' + (P.costing.length ? P.costing.map(insightHTML).join('') : '<div class="pf-none">No part of your history trails your own average by enough to call yet.</div>') + '</div>';
    h += '<div class="pc-sec"><div class="pc-h">This week</div><div class="pc-week">' + P.week.logged + ' logged · ' + P.week.graded + ' graded'
      + (P.week.graded ? ' · ' + P.week.beat + ' beat the close' : '') + '</div></div>';
    h += '<div class="pc-sec pc-focus"><div class="pc-h">Next focus</div><div class="pc-focus-t">' + esc(P.focus.text) + '</div></div>';
    h += '<div class="pc-h pc-dd">Go deeper</div>' + edgeHTML(P) + P.groups.map(tableHTML).join('') + journalHTML(extra.journal) + methodHTML();
    return h;
  }
  function edgeHTML(P) {
    var e = P.edge; if (!e) return '';
    return '<details class="pc-deep" data-pc-fam="edge"><summary><b>Edge capture</b><span>how often and by how much your prices beat the close</span></summary>'
      + '<div class="pc-kpis"><div class="pf-kpi"><div class="v">' + pc(e.rate) + '</div><div class="l">Beat the close</div><div class="n">' + e.beat + ' of ' + e.n + (e.ci ? ' · 95% range ' + pc(e.ci.lo) + '–' + pc(e.ci.hi) : '') + '</div></div>'
      + (e.clv_price_n ? '<div class="pf-kpi"><div class="v">' + signed(e.avg_clv_price * 100, 2, '%') + '</div><div class="l">Average CLV, price</div><div class="n">' + e.clv_price_n + ' tracked prices</div></div>' : '')
      + (e.clv_points_n ? '<div class="pf-kpi"><div class="v">' + signed(e.avg_clv_points, 1, ' pts') + '</div><div class="l">Average CLV, points</div><div class="n">' + e.clv_points_n + ' Card spreads</div></div>' : '')
      + '</div></details>';
  }
  function journalHTML(j) {
    if (!j) return '';
    return '<details class="pc-deep" data-pc-fam="journal"><summary><b>Decision journal</b><span>passes, leans and wagers you logged on game research</span></summary>'
      + '<div class="pc-note">' + (j.total ? j.total + ' decisions logged · ' + j.wagered + ' wagered · ' + j.passed + ' passed' + (j.graded ? ' · ' + j.beat + ' of ' + j.graded + ' graded wagers beat the close' : '') : 'No journal entries yet. Use “Log decision” on any game to record a pass, a lean or a wager.') + '</div>'
      + '<button type="button" class="pf-link" data-pc-journal="1">Open decision quality ›</button></details>';
  }
  function methodHTML() {
    return '<div class="pc-meth">How is this calculated? Every figure is your own positions from Portfolio, graded against the closing line EdgeDesk captured. '
      + '<button type="button" class="pf-link" data-nav="methodology">Methodology ›</button></div>';
  }

  return { VERSION: VERSION, FAMILIES: FAMILIES, MIN_EDGE: MIN_EDGE, MIN_PROFILE: MIN_PROFILE, MIN_GROUP: MIN_GROUP, MIN_GAP: MIN_GAP, Z_SHOW: Z_SHOW, Z_CLEAR: Z_CLEAR,
    wilson: wilson, tally: tally, groups: groups, profile: profile, pageHTML: pageHTML, insightHTML: insightHTML };
}));
