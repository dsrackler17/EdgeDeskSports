/* ===========================================================================
   EdgeDesk research cards — the card a signed-in reader shares.
   Browser: window.EDShareCard. Node: require('./edgedesk_share_card.js').

   THREE STEPS, only the last one touches a canvas:
     content(state)          the words and numbers on the card, from ONE
                             research state (lib/edgedesk_personal.js) and
                             nothing else, or the reason there is no card
     layout(content, fmt)    where each piece goes, as plain draw operations
     draw(canvas, layout)    paints them (browser only)

   THE RULES
     * Real current data only. No card for a game with no projection, a game
       that has kicked off, or a research state older than MAX_STATE_AGE_H.
       A missing or stale market quote is printed as missing, never filled in.
     * Research, not picks. Every string passes EDPersonal.copyOk; the card
       carries "Research, not picks." and never a result, a record, a stake or
       an outcome. supabase/personal_research.sql refuses the same words again
       when the card is recorded (share_cards).
     * Sized for sharing: X / landscape 1600×900 (16:9, X's in-feed image) and
       square 1080×1080.
     * Times are US Central ("Thu Oct 1 · 7:00 PM CT"), fixed to
       America/Chicago so the card reads the same wherever it is made.
     * The verdict badge is the game's EXISTING decision (BET / LEAN / WATCH /
       PASS, lib/edgedesk_decision.js), handed in by the caller as
       opts.decision. The card decides nothing: no decision, a decision for
       another game, NO DECISION or a provisional one → no badge.
     * One book count: the state's market.books, in the market note and the
       drivers alike.
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./edgedesk_personal.js'));
  else root.EDShareCard = factory(root.EDPersonal);
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (P) {
  'use strict';
  var SC = { version: 'edgedesk_share_card/1' };
  SC.FORMATS = {
    x_landscape: { w: 1600, h: 900, label: 'X / landscape · 1600×900' },
    square: { w: 1080, h: 1080, label: 'Square · 1080×1080' }
  };
  SC.MAX_STATE_AGE_H = 6;
  SC.TAGLINE = 'Research, not picks.';
  SC.SITE = 'edgedesksports.com';
  SC.COLORS = { bg: '#100e0a', panel: '#191510', border: '#332a1b', text: '#f1ebdf', dim: '#a29581', faint: '#6f6553', accent: '#2fa79a', warn: '#d99a2b' };
  /* the decision tones lib/edgedesk_decision.css prints them in */
  SC.VERDICT_TONE = { BET: '#76bd3e', LEAN: '#2fa79a', WATCH: '#d99a2b', PASS: '#aa9c87' };
  SC.VERDICTS = ['BET', 'LEAN', 'WATCH', 'PASS'];
  SC.FONT = 'Inter, "Helvetica Neue", Arial, sans-serif';
  SC.REASON_TEXT = {
    no_state: 'EdgeDesk holds no research state for this game.',
    no_projection: 'EdgeDesk has no fair line for this game yet, so there is nothing to put on a card.',
    started: 'This game has kicked off. Research cards are made before the game.',
    stale_state: 'EdgeDesk’s research state for this game is more than ' + SC.MAX_STATE_AGE_H + ' hours old. Open the game so the board refreshes, then make the card.',
    copy_rule: 'This card would break EdgeDesk’s research-only wording rules, so it is not made.'
  };

  function num(x) { return (typeof x === 'number' && isFinite(x)) ? x : null; }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  /* deterministic, in UTC: the card must read the same wherever it is made */
  SC.utc = function (iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return null;
    var d = new Date(t);
    return MON[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear() + ' · ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' UTC';
  };
  /* US Central, "Thu Oct 1 · 7:00 PM CT": one fixed zone (America/Chicago,
     daylight time included), so it is as deterministic as UTC was. A runtime
     without time-zone data falls back to UTC rather than guessing an offset. */
  var CT = null;
  try { CT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }); } catch (_) { CT = null; }
  SC.central = function (iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return null;
    if (!CT || typeof CT.formatToParts !== 'function') return SC.utc(iso);
    var p = {};
    CT.formatToParts(new Date(t)).forEach(function (x) { p[x.type] = x.value; });
    return p.weekday + ' ' + p.month + ' ' + p.day + ' · ' + p.hour + ':' + p.minute + ' ' + String(p.dayPeriod || '').toUpperCase() + ' CT';
  };

  /* explain() reasons that are outputs, not inputs (see the drivers below) */
  SC.NOT_INPUT = [/^meaningful model-market disagreement\b/i, /\breliability \(\d+\)$/i, /^stable model inputs\b/i];

  /* THE VERDICT: the decision the engine already made for THIS game, read,
     never made. WAIT reads WATCH (lib/edgedesk_decision_ui.js kind()). No
     decision, one for another game, NO DECISION, or a provisional one (made
     while calibration is still loading) → null, and the card shows nothing. */
  SC.verdictOf = function (d, s) {
    if (!d || !s || d.provisional) return null;
    if (d.game_id == null || String(d.game_id) !== String(s.game_id)) return null;
    if (d.sport && s.sport && String(d.sport).toLowerCase() !== String(s.sport).toLowerCase()) return null;
    var k = d.decision === 'WAIT' ? 'WATCH' : d.decision;
    return SC.VERDICTS.indexOf(k) >= 0 ? k : null;
  };

  SC.content = function (s, opts) {
    opts = opts || {};
    var now = opts.now || Date.now();
    function no(r) { return { ok: false, reason: r, message: SC.REASON_TEXT[r] }; }
    if (!s) return no('no_state');
    var f = s.fair || {}, m = s.market || {}, rel = s.reliability || {};
    if (!s.projected || num(f.home_line) == null) return no('no_projection');
    var ko = Date.parse(s.kickoff_at);
    if (isFinite(ko) && now >= ko) return no('started');
    var at = Date.parse(s.computed_at);
    if (!isFinite(at) || now - at > SC.MAX_STATE_AGE_H * 36e5) return no('stale_state');

    var current = num(m.home_line) != null && !m.stale;
    var gap = current ? num(s.gap && s.gap.points) : null;
    if (current && gap == null) gap = Math.round(Math.abs(f.home_line - m.home_line) * 10) / 10;
    /* the side EdgeDesk's number is more favorable to than the market's,
       from the two lines themselves (a state may not carry gap.toward) */
    var toward = !current || gap == null || gap < 0.05 ? null : (f.home_line < m.home_line ? 'home' : 'away');
    var fairText = f.text || P.favText(s, f.home_line);
    var mktText = current ? (m.text || P.favText(s, m.home_line)) : 'No current market quote';
    /* ONE BOOK COUNT. The state's market.books is the number of distinct
       sportsbooks with a current quote on this spread (app.html
       fbResearchStateOf, from fbP4QuotesFor) — the count the drivers cite.
       The board's source text (market.book, fbP4Market) carries its own
       "N books": the SUM of n_books over every current spreads row, where a
       row is one (side, point), so one book is counted once per side per
       point it quotes, alternates included. That is a count of quotes, not
       books; it is taken out of the text and never printed. */
    var nb = num(m.books), booksText = nb != null ? nb + ' book' + (nb === 1 ? '' : 's') : null;
    var src = m.kind === 'consensus' ? 'consensus reference' : String(m.book || 'captured quote').replace(/\s*·\s*\d+ books?(?=\s*·|\s*$)/i, '');
    if (/^captured consensus\b/i.test(src)) src = src.replace(/^captured consensus\b/i, booksText ? 'consensus of ' + booksText : 'consensus');
    else if (booksText) src = booksText + ' · ' + src;
    var mktMeta = current ? src : 'nothing current to compare';
    var mktAt = current && m.captured_at ? 'captured ' + SC.central(m.captured_at) : null;
    var rs = num(rel.score);
    var relText = rs != null ? String(Math.round(rs)) : 'Not scored';
    var relMeta = rs != null ? (rel.grade ? String(rel.grade).toLowerCase() + ' · 0–100, not a probability' : '0–100, not a probability')
      : (s.sport === 'nfl' ? 'the NFL model publishes no reliability score' : 'not measured for this game');
    /* 2-3 concise research drivers, ACTUAL INPUTS ONLY: the engine's own
       measured terms on the side its fair line favors; without them, the
       state's evidence that is itself an input (EDPersonal.explain: the
       quarterbacks, the availability reports, the market's books and its
       movement). explain() also restates numbers this card prints in its own
       boxes, or reads them as a conclusion: the model-market disagreement
       (the gap box), reliability (the reliability box), projection stability
       and the reading order's sentence. Those are outputs, not inputs, so
       they are not drivers here. Nothing is written that the state lacks, and
       nothing is added to fill a slot. */
    var leanSide = f.home_line < 0 ? 'home' : (f.home_line > 0 ? 'away' : null), leanTeam = leanSide ? s[leanSide] : null;
    var drivers = (s.drivers || []).filter(function (d) { return d && num(d.points) != null && d.points > 0 && d.text; })
      .slice().sort(function (a, b) { return b.points - a.points; }).slice(0, 3)
      .map(function (d) { return (leanTeam ? leanTeam + ': ' : '') + '+' + d.points.toFixed(1) + ' pts ' + d.text; });
    if (drivers.length < 2) {
      var lead = s.priority && s.priority.why_text ? String(s.priority.why_text).replace(/\.$/, '') : null;
      var ex = P.explain(s).why.filter(function (w) { return w !== lead && !SC.NOT_INPUT.some(function (rx) { return rx.test(w); }); })
        .map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); });
      ex.forEach(function (w) { if (drivers.length < 3 && drivers.indexOf(w) < 0) drivers.push(w); });
    }
    drivers = drivers.slice(0, 3).map(function (t) { return t.length > 110 ? t.slice(0, 107) + '…' : t; });
    var verdict = SC.verdictOf(opts.decision, s);
    var c = {
      brand: 'EdgeDesk', kind: 'Research card',
      league: s.sport === 'nfl' ? 'NFL' : (s.sport === 'cfb' ? 'College football' : String(s.sport || '').toUpperCase()),
      matchup: P.matchup(s), kickoff: SC.central(s.kickoff_at),
      verdict: verdict, verdict_label: verdict ? 'Decision' : null,
      fair_label: 'EdgeDesk fair line', fair: fairText,
      market_label: 'Market line', market: mktText, market_meta: mktMeta, market_at: mktAt,
      gap_label: 'Model–market gap', gap: gap != null ? gap.toFixed(1) + ' pts' : '—',
      gap_meta: toward ? 'EdgeDesk more favorable to ' + s[toward] : (gap != null ? 'EdgeDesk and the market agree' : 'no current market'),
      reliability_label: 'Reliability', reliability: relText, reliability_meta: relMeta,
      drivers_label: 'Research drivers', drivers: drivers,
      timestamp: 'EdgeDesk research state · ' + SC.central(s.computed_at),
      tagline: SC.TAGLINE, site: SC.SITE
    };
    var strings = [];
    Object.keys(c).forEach(function (k) { if (Array.isArray(c[k])) strings = strings.concat(c[k]); else if (c[k] != null) strings.push(String(c[k])); });
    if (!strings.every(P.copyOk)) return no('copy_rule');
    return { ok: true, content: c, hash: 'sc1-' + P.hash(JSON.stringify(c)),
      numbers: { fair_home_line: num(f.home_line), market_home_line: current ? num(m.home_line) : null, gap_pts: gap, reliability_score: rs },
      state_hash: s.state_hash || P.stateHash(s), state_computed_at: s.computed_at || null, game_key: s.game_key };
  };

  /* what a reader might post beside the image — the same numbers, no more */
  SC.shareText = function (c, url) {
    if (!c) return '';
    return 'EdgeDesk research — ' + c.matchup + ': fair ' + c.fair + ', market ' + c.market + (c.gap !== '—' ? ' (' + c.gap + ' gap)' : '')
      + ', reliability ' + c.reliability + '. ' + c.tagline + ' ' + (url || c.site);
  };

  /* ------------------------------------------------------------ layout
     measure(text, font) → width in px. The browser passes the canvas's own;
     without one, a conservative average glyph width is used (tests). */
  function approx(text, font) { var px = parseFloat(String(font).match(/(\d+(?:\.\d+)?)px/)[1]); return String(text).length * px * 0.56; }
  function fontOf(size, weight) { return (weight || 400) + ' ' + size + 'px ' + SC.FONT; }
  function fit(text, size, weight, maxW, measure, min) {
    var sz = size;
    while (sz > (min || 14) && measure(text, fontOf(sz, weight)) > maxW) sz -= 2;
    return sz;
  }
  function wrap(text, size, weight, maxW, measure, maxLines) {
    var words = String(text).split(/\s+/), lines = [], cur = '';
    words.forEach(function (w) {
      var t = cur ? cur + ' ' + w : w;
      if (measure(t, fontOf(size, weight)) <= maxW || !cur) cur = t; else { lines.push(cur); cur = w; }
    });
    if (cur) lines.push(cur);
    if (lines.length > maxLines) { lines = lines.slice(0, maxLines); lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + '…'; }
    return lines;
  }
  SC.layout = function (c, format, measure) {
    var F = SC.FORMATS[format] || SC.FORMATS.x_landscape, W = F.w, H = F.h, K = SC.COLORS, ops = [];
    measure = measure || approx;
    var sq = format === 'square', pad = sq ? 64 : 72, inner = W - 2 * pad;
    function text(t, x, y, size, weight, color, align, maxW, min) {
      var sz = maxW ? fit(t, size, weight, maxW, measure, min || Math.round(size * 0.6)) : size;
      ops.push({ type: 'text', text: t, x: x, y: y, size: sz, weight: weight || 400, color: color || K.text, align: align || 'left', font: fontOf(sz, weight) });
      return sz;
    }
    ops.push({ type: 'rect', x: 0, y: 0, w: W, h: H, fill: K.bg });
    ops.push({ type: 'rect', x: 0, y: 0, w: W, h: 10, fill: K.accent });
    ops.push({ type: 'rect', x: 24, y: 34, w: W - 48, h: H - 58, fill: null, stroke: K.border, r: 22 });
    var y = pad + 46;
    text(c.brand, pad, y, 40, 800, K.text);
    text(c.kind.toUpperCase(), pad + measure(c.brand, fontOf(40, 800)) + 18, y - 4, 20, 700, K.accent);
    text(c.league + ' · ' + c.kickoff, W - pad, y, 24, 500, K.dim, 'right', inner / 2);
    /* the game's existing decision, a badge under the header; no decision,
       no badge and no empty row */
    var tone = c.verdict ? SC.VERDICT_TONE[c.verdict] : null;
    if (tone) {
      var vl = c.verdict_label.toUpperCase(), vlw = measure(vl, fontOf(18, 700)), vw = measure(c.verdict, fontOf(24, 800));
      var bx = pad, by = y + 26, bhh = 44, bwid = 20 + 10 + 14 + vlw + 12 + vw + 22;
      ops.push({ type: 'rect', x: bx, y: by, w: bwid, h: bhh, fill: K.panel, stroke: tone, r: 22 });
      ops.push({ type: 'rect', x: bx + 20, y: by + 17, w: 10, h: 10, fill: tone, r: 5 });
      text(vl, bx + 44, by + 29, 18, 700, K.dim);
      text(c.verdict, bx + 44 + vlw + 12, by + 31, 24, 800, tone);
      y += 44;
    }
    y += sq ? 96 : 100;
    text(c.matchup, pad, y, sq ? 64 : 72, 800, K.text, 'left', inner);
    y += sq ? 50 : 56;
    /* the four numbers. Every line of a box's note is drawn, wrapped and never
       cut off, and each row of boxes is as tall as its tallest note; a box's
       time line is one line, sized down to fit its box rather than split. */
    var boxes = [[c.fair_label, c.fair, 'EdgeDesk’s projected spread', K.accent, null], [c.market_label, c.market, c.market_meta, K.text, c.market_at],
      [c.gap_label, c.gap, c.gap_meta, K.text, null], [c.reliability_label, c.reliability, c.reliability_meta, K.text, null]];
    var cols = sq ? 2 : 4, gapX = 22, bw = (inner - gapX * (cols - 1)) / cols, bh = sq ? 190 : 200, nLead = 24;
    /* a note breaks at its " · " joints first, so a phrase like "best at
       Caesars" stays whole; a part too long for one line is word-wrapped */
    function noteLines(t, maxW) {
      var lines = [], cur = '';
      String(t).split(' · ').forEach(function (part) {
        var joined = cur ? cur + ' · ' + part : part;
        if (measure(joined, fontOf(19, 500)) <= maxW) { cur = joined; return; }
        if (cur) lines.push(cur);
        var w = wrap(part, 19, 500, maxW, measure, 99);
        cur = w.pop() || '';
        lines = lines.concat(w);
      });
      if (cur) lines.push(cur);
      return lines;
    }
    var notes = boxes.map(function (b) { return (b[2] ? noteLines(b[2], bw - 48) : []).concat(b[4] ? [b[4]] : []); });
    var rowH = [];
    notes.forEach(function (n, i) { var r = Math.floor(i / cols); rowH[r] = Math.max(rowH[r] || bh, 146 + (n.length - 1) * nLead + 30); });
    var rowY = [y];
    rowH.forEach(function (h, r) { rowY[r + 1] = rowY[r] + h + 22; });
    boxes.forEach(function (b, i) {
      var r = Math.floor(i / cols), cx = pad + (i % cols) * (bw + gapX), cy = rowY[r];
      ops.push({ type: 'rect', x: cx, y: cy, w: bw, h: rowH[r], fill: K.panel, stroke: K.border, r: 16 });
      text(b[0].toUpperCase(), cx + 24, cy + 44, 19, 700, K.faint, 'left', bw - 48);
      /* the box's number stays inside its box however long the team name */
      text(b[1], cx + 24, cy + 108, 46, 800, b[3], 'left', bw - 48, 20);
      notes[i].forEach(function (ln, j) { text(ln, cx + 24, cy + 146 + j * nLead, 19, 500, K.dim, 'left', b[4] && j === notes[i].length - 1 ? bw - 48 : null); });
    });
    y = rowY[rowH.length] + 34;
    var dSize = sq ? 28 : 30, fy = H - pad + 6, room = fy - 52, full = false;
    if (c.drivers.length) { text(c.drivers_label.toUpperCase(), pad, y, 20, 700, K.faint); y += 44; }
    /* a line that would reach the footer is not drawn: the one before it is
       closed with an ellipsis instead, so nothing ever overlaps */
    c.drivers.forEach(function (d) {
      if (full) return;
      wrap(d, dSize, 600, inner - 40, measure, 2).forEach(function (ln, j) {
        if (full) return;
        if (y > room) {
          full = true;
          var last = ops[ops.length - 1];
          if (last && last.type === 'text' && j > 0) last.text = last.text.replace(/\s*\S*$/, '') + '…';
          return;
        }
        if (j === 0) ops.push({ type: 'rect', x: pad, y: y - dSize * 0.62, w: 10, h: 10, fill: K.accent, r: 5 });
        text(ln, pad + 30, y, dSize, 600, K.text);
        y += dSize + 12;
      });
      y += 6;
    });
    text(c.timestamp, pad, fy, 20, 500, K.faint, 'left', inner * 0.55);
    text(c.tagline + '  ·  ' + c.site, W - pad, fy, 24, 700, K.text, 'right', inner * 0.45);
    return { width: W, height: H, format: F === SC.FORMATS.square ? 'square' : 'x_landscape', ops: ops, bottom_of_body: y };
  };

  /* ------------------------------------------------------------ draw */
  SC.draw = function (canvas, L) {
    canvas.width = L.width; canvas.height = L.height;
    var g = canvas.getContext('2d');
    function rr(o) {
      var r = o.r || 0;
      g.beginPath();
      if (g.roundRect && r) g.roundRect(o.x, o.y, o.w, o.h, r); else g.rect(o.x, o.y, o.w, o.h);
      if (o.fill) { g.fillStyle = o.fill; g.fill(); }
      if (o.stroke) { g.strokeStyle = o.stroke; g.lineWidth = 2; g.stroke(); }
    }
    L.ops.forEach(function (o) {
      if (o.type === 'rect') rr(o);
      else { g.font = o.font; g.fillStyle = o.color; g.textAlign = o.align; g.textBaseline = 'alphabetic'; g.fillText(o.text, o.x, o.y); }
    });
    return canvas;
  };
  SC.measureWith = function (canvas) {
    var g = canvas.getContext('2d');
    return function (t, font) { g.font = font; return g.measureText(String(t)).width; };
  };
  return SC;
});
