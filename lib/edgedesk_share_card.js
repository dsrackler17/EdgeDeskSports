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
    /* the side EdgeDesk's number is more favourable to than the market's,
       from the two lines themselves (a state may not carry gap.toward) */
    var toward = !current || gap == null || gap < 0.05 ? null : (f.home_line < m.home_line ? 'home' : 'away');
    var fairText = f.text || P.favText(s, f.home_line);
    var mktText = current ? (m.text || P.favText(s, m.home_line)) : 'No current market quote';
    var mktMeta = current ? [m.kind === 'consensus' ? 'consensus reference' : (m.book || 'captured quote'), m.captured_at ? 'captured ' + SC.utc(m.captured_at) : null].filter(Boolean).join(' · ') : 'nothing current to compare';
    var rs = num(rel.score);
    var relText = rs != null ? String(Math.round(rs)) : 'Not scored';
    var relMeta = rs != null ? (rel.grade ? String(rel.grade).toLowerCase() + ' · 0–100, not a probability' : '0–100, not a probability')
      : (s.sport === 'nfl' ? 'the NFL model publishes no reliability score' : 'not measured for this game');
    /* 2-3 concise research drivers: the engine's own measured terms on the
       side its fair line favours; without them, the state's own research
       reasons (EDPersonal.explain). Nothing is written that the state lacks. */
    var leanSide = f.home_line < 0 ? 'home' : (f.home_line > 0 ? 'away' : null), leanTeam = leanSide ? s[leanSide] : null;
    var drivers = (s.drivers || []).filter(function (d) { return d && num(d.points) != null && d.points > 0 && d.text; })
      .slice().sort(function (a, b) { return b.points - a.points; }).slice(0, 3)
      .map(function (d) { return (leanTeam ? leanTeam + ': ' : '') + '+' + d.points.toFixed(1) + ' pts ' + d.text; });
    if (drivers.length < 2) {
      var ex = P.explain(s).why.map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); });
      ex.forEach(function (w) { if (drivers.length < 3 && drivers.indexOf(w) < 0) drivers.push(w); });
    }
    drivers = drivers.slice(0, 3).map(function (t) { return t.length > 110 ? t.slice(0, 107) + '…' : t; });
    var c = {
      brand: 'EdgeDesk', kind: 'Research card',
      league: s.sport === 'nfl' ? 'NFL' : (s.sport === 'cfb' ? 'College football' : String(s.sport || '').toUpperCase()),
      matchup: P.matchup(s), kickoff: SC.utc(s.kickoff_at),
      fair_label: 'EdgeDesk fair line', fair: fairText,
      market_label: 'Market line', market: mktText, market_meta: mktMeta,
      gap_label: 'Model–market gap', gap: gap != null ? gap.toFixed(1) + ' pts' : '—',
      gap_meta: toward ? 'EdgeDesk more favourable to ' + s[toward] : (gap != null ? 'EdgeDesk and the market agree' : 'no current market'),
      reliability_label: 'Reliability', reliability: relText, reliability_meta: relMeta,
      drivers_label: 'Research drivers', drivers: drivers,
      timestamp: 'EdgeDesk research state · ' + SC.utc(s.computed_at),
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
    function text(t, x, y, size, weight, color, align, maxW) {
      var sz = maxW ? fit(t, size, weight, maxW, measure, Math.round(size * 0.6)) : size;
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
    y += sq ? 96 : 100;
    text(c.matchup, pad, y, sq ? 64 : 72, 800, K.text, 'left', inner);
    y += sq ? 50 : 56;
    /* the four numbers */
    var boxes = [[c.fair_label, c.fair, 'EdgeDesk’s projected spread', K.accent], [c.market_label, c.market, c.market_meta, K.text],
      [c.gap_label, c.gap, c.gap_meta, K.text], [c.reliability_label, c.reliability, c.reliability_meta, K.text]];
    var cols = sq ? 2 : 4, gapX = 22, bw = (inner - gapX * (cols - 1)) / cols, bh = sq ? 190 : 200;
    boxes.forEach(function (b, i) {
      var cx = pad + (i % cols) * (bw + gapX), cy = y + Math.floor(i / cols) * (bh + 22);
      ops.push({ type: 'rect', x: cx, y: cy, w: bw, h: bh, fill: K.panel, stroke: K.border, r: 16 });
      text(b[0].toUpperCase(), cx + 24, cy + 44, 19, 700, K.faint, 'left', bw - 48);
      text(b[1], cx + 24, cy + 108, 46, 800, b[3], 'left', bw - 48);
      wrap(b[2] || '', 19, 500, bw - 48, measure, 2).forEach(function (ln, j) { text(ln, cx + 24, cy + 146 + j * 24, 19, 500, K.dim); });
    });
    y += (sq ? 2 : 1) * (bh + 22) + 34;
    text(c.drivers_label.toUpperCase(), pad, y, 20, 700, K.faint);
    y += 44;
    var dSize = sq ? 28 : 30, fy = H - pad + 6, room = fy - 52, full = false;
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
