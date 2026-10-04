/* ===========================================================================
   EdgeDesk record cards — the Record, as an image anyone can post.
   Browser: window.EDRecordCard. Node: require('./edgedesk_record_card.js').

   THREE STEPS, only the last one touches a canvas:
     content(view)           the words and numbers on the card, from ONE view
                             of the Record page (lib/edgedesk_pnl_ui.js hands
                             in what it already shows: the tab, the period,
                             the graded record, the P&L at the graded price
                             and Verified P&L), or the reason there is no card
     layout(content, fmt)    where each piece goes, as plain draw operations
     draw(canvas, layout)    paints them (browser only)

   THE RULES
     * The card computes nothing. Every number is one the page already
       printed for the same view, from the same kernel (lib/edgedesk_pnl.js).
     * It says how the units were priced. Game picks priced at the close are
       labelled "at the closing price · not Verified P&L", and Verified P&L is
       printed beside them, so the card never passes a closing price off as a
       price EdgeDesk captured.
     * The sample size is always on the card, and "21+" with it.
     * No card for a view with nothing graded.
     * Sized for sharing: X / landscape 1600×900 (16:9, X's in-feed image),
       square 1080×1080, and story 1080×1920.
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EDRecordCard = factory();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var RC = { version: 'edgedesk_record_card/1' };
  RC.FORMATS = {
    x_landscape: { w: 1600, h: 900, label: 'X post' },
    square: { w: 1080, h: 1080, label: 'Square' },
    story: { w: 1080, h: 1920, label: 'Story' }
  };
  RC.SITE = 'edgedesksports.com';
  RC.URL = 'https://edgedesksports.com/record.html';
  RC.HANDLE = '@edgedesksports';
  RC.COLORS = { bg: '#100e0a', panel: '#191510', border: '#332a1b', text: '#f1ebdf', dim: '#a29581', faint: '#6f6553', accent: '#2fa79a', pos: '#76bd3e', neg: '#e26044' };
  RC.FONT = 'Inter, "Helvetica Neue", Arial, sans-serif';
  RC.VIEWS = ['all', 'cfb', 'nfl', 'props'];
  RC.REASON_TEXT = {
    no_view: 'The record has not loaded yet.',
    nothing_graded: 'Nothing is graded in this view yet, so there is no record to share.'
  };

  function num(x) { return typeof x === 'number' && isFinite(x) ? x : null; }
  function int(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  /* +7.87u / −1.49u, with a real minus sign: the page's own format */
  RC.units = function (u) {
    var v = Math.round(u * 100) / 100;
    if (Math.abs(v) < 0.005) v = 0;
    return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2) + 'u';
  };
  RC.pct = function (p) {
    var v = Math.round(p * 10) / 10;
    if (Math.abs(v) < 0.05) v = 0;
    return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1) + '%';
  };
  RC.tone = function (u) { return u > 0.005 ? 'pos' : u < -0.005 ? 'neg' : 'flat'; };
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  /* the date the record stands at, in US Central (one fixed zone, so the card
     reads the same wherever it is made); no time-zone data → UTC */
  var CT = null;
  try { CT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric' }); } catch (_) { CT = null; }
  RC.day = function (iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return null;
    if (CT) { try { return CT.format(new Date(t)); } catch (_) { /* fall through */ } }
    var d = new Date(t);
    return MON[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear();
  };
  /** the public link to this view of the Record */
  RC.link = function (scope) { return RC.URL + (scope && scope !== 'all' && RC.VIEWS.indexOf(scope) >= 0 ? '?view=' + scope : '') + '#pnl'; };

  /* ------------------------------------------------------------ content */
  /**
   * view = {
   *   scope, scope_label, period_label, span, market_label, leans, mode,
   *   record:   { graded, record, win_rate_pct },
   *   graded:   { n, net_units, roi_pct, record, sample_label, at_close, at_entry, unpriced,
   *               markets: [{ type, label, n, net_units, roi_pct, record }] } | null,
   *   verified: { n, net_units, roi_pct, record },
   *   as_of
   * }
   */
  RC.content = function (v) {
    if (!v || !v.record) return { ok: false, reason: 'no_view', message: RC.REASON_TEXT.no_view };
    if (!v.record.graded) return { ok: false, reason: 'nothing_graded', message: RC.REASON_TEXT.nothing_graded };
    var g = v.graded && v.graded.n ? v.graded : null, ver = v.verified || { n: 0 };
    var close = g && g.at_close > 0, entry = g && g.at_entry > 0;
    var c = {
      brand: 'EdgeDesk', kind: 'Record', scope: v.scope || 'all',
      title: v.scope_label || 'All picks',
      sub: [v.period_label, v.span, v.market_label, v.leans ? 'picks + leans' : null].filter(Boolean).join(' · '),
      has_units: !!g,
      headline: g ? RC.units(g.net_units) : v.record.record,
      headline_tone: g ? RC.tone(g.net_units) : 'flat',
      roi: g && num(g.roi_pct) != null ? RC.pct(g.roi_pct) + ' ROI' : null,
      roi_tone: g ? RC.tone(g.roi_pct) : 'flat',
      record: v.record.record,
      record_sub: [num(v.record.win_rate_pct) != null ? (Math.round(v.record.win_rate_pct * 10) / 10).toFixed(1) + '% won' : null, int(v.record.graded) + ' graded pick' + (v.record.graded === 1 ? '' : 's')].filter(Boolean).join(' · '),
      sample: g ? 'n=' + int(g.n) + (g.sample_label ? ' · ' + g.sample_label : '') : null,
      markets: g ? (g.markets || []).filter(function (m) { return m.n; }).slice(0, 4).map(function (m) {
        return { label: m.label, units: RC.units(m.net_units), tone: RC.tone(m.net_units), meta: [num(m.roi_pct) != null ? RC.pct(m.roi_pct) + ' ROI' : null, int(m.n) + ' picks', m.record].filter(Boolean).join(' · ') };
      }) : [],
      basis: null, verified: null, unpriced: null,
      as_of: v.as_of ? 'As of ' + RC.day(v.as_of) : null,
      footer: '21+ · Past results never guarantee future ones',
      site: RC.SITE + '/record.html', link: RC.link(v.scope)
    };
    var stake = v.mode === 'staked' ? 'recorded stakes' : 'flat 1u';
    if (close && entry) c.basis = 'Game picks at the closing price, props at their captured price · ' + stake + ' · not Verified P&L';
    else if (close) c.basis = 'Every pick at the closing price of the line it was graded at · ' + stake + ' · not Verified P&L';
    else if (g) c.basis = 'Every pick at the price captured with it · ' + stake + ' · Verified P&L';
    else c.basis = 'Wins and losses · no pick in this view is priced yet';
    if (close) c.verified = 'Verified P&L (a price EdgeDesk captured at the pick): ' + (ver.n ? RC.units(ver.net_units) + ' over ' + int(ver.n) + ' priced' : 'none settled yet');
    if (g && g.unpriced) c.unpriced = int(g.unpriced) + ' graded pick' + (g.unpriced === 1 ? '' : 's') + ' with no closing price left out';
    return { ok: true, content: c };
  };

  /* the post that goes with the card: under X's 280 characters, a link
     counted as 23 the way X counts every link */
  RC.TWEET_MAX = 280;
  RC.tweetLength = function (t) { return String(t).replace(/https?:\/\/\S+/g, new Array(24).join('x')).length; };
  RC.shareText = function (c) {
    var head = 'EdgeDesk ' + c.title + (c.sub ? ' (' + c.sub + ')' : '') + ': ';
    var body = c.has_units ? c.record + ', ' + c.headline + (c.roi ? ' (' + c.roi + ')' : '') : c.record + ' (' + c.record_sub + ')';
    var how = c.has_units ? (/closing price/.test(c.basis || '') ? ' at the closing price' : ' at captured prices') : '';
    var mk = c.markets.length > 1 ? '\n' + c.markets.map(function (m) { return m.label + ' ' + m.units; }).join(' · ') : '';
    var tail = '\nEvery pick, graded in public: ' + c.link;
    var t = head + body + how + mk + tail;
    if (RC.tweetLength(t) > RC.TWEET_MAX) t = head + body + how + tail;
    if (RC.tweetLength(t) > RC.TWEET_MAX) t = 'EdgeDesk ' + c.title + ': ' + body + tail;
    return t;
  };

  /* ------------------------------------------------------------ layout */
  function fontOf(size, weight) { return (weight || 400) + ' ' + size + 'px ' + RC.FONT; }
  /* Node has no canvas: a width estimate good enough to keep text inside */
  function approx(t, font) {
    var m = /(\d+)px/.exec(font), size = m ? +m[1] : 20, w = /^(\d+)/.exec(font), bold = w && +w[1] >= 700;
    return String(t).length * size * (bold ? 0.6 : 0.54);
  }
  function fit(t, size, weight, maxW, measure, min) {
    var s = size;
    while (s > (min || 10) && measure(t, fontOf(s, weight)) > maxW) s -= 2;
    return s;
  }
  function wrap(t, size, weight, maxW, measure, maxLines) {
    var words = String(t).split(/\s+/), lines = [], cur = '';
    words.forEach(function (w) {
      var next = cur ? cur + ' ' + w : w;
      if (measure(next, fontOf(size, weight)) <= maxW || !cur) cur = next;
      else { lines.push(cur); cur = w; }
    });
    if (cur) lines.push(cur);
    if (maxLines && lines.length > maxLines) { lines = lines.slice(0, maxLines); lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + '…'; }
    return lines;
  }
  RC.layout = function (c, format, measure) {
    var F = RC.FORMATS[format] || RC.FORMATS.x_landscape, W = F.w, H = F.h, K = RC.COLORS, ops = [];
    measure = measure || approx;
    var land = format === 'x_landscape' || !RC.FORMATS[format], story = format === 'story';
    var pad = land ? 72 : 64, inner = W - 2 * pad;
    function tone(t) { return t === 'pos' ? K.pos : t === 'neg' ? K.neg : K.text; }
    function text(t, x, y, size, weight, color, align, maxW, min) {
      var sz = maxW ? fit(t, size, weight, maxW, measure, min || Math.round(size * 0.55)) : size;
      ops.push({ type: 'text', text: String(t), x: x, y: y, size: sz, weight: weight || 400, color: color || K.text, align: align || 'left', font: fontOf(sz, weight) });
      return sz;
    }
    function lines(t, x, y, size, weight, color, maxW, maxLines, lead) {
      wrap(t, size, weight, maxW, measure, maxLines).forEach(function (ln, i) { text(ln, x, y + i * lead, size, weight, color, 'left', maxW); });
      return wrap(t, size, weight, maxW, measure, maxLines).length;
    }
    ops.push({ type: 'rect', x: 0, y: 0, w: W, h: H, fill: K.bg });
    ops.push({ type: 'rect', x: 0, y: 0, w: W, h: 10, fill: K.accent });
    ops.push({ type: 'rect', x: 24, y: 34, w: W - 48, h: H - 58, fill: null, stroke: K.border, r: 22 });

    /* header: the brand, and which record this is */
    var y = pad + 50;
    text(c.brand, pad, y, 40, 800, K.text);
    text(c.kind.toUpperCase(), pad + measure(c.brand, fontOf(40, 800)) + 18, y - 4, 20, 700, K.accent);
    if (land) {
      text(c.title, W - pad, y, 30, 800, K.text, 'right', inner * 0.55);
      if (c.sub) text(c.sub, W - pad, y + 34, 21, 500, K.dim, 'right', inner * 0.55);
    } else {
      y += story ? 130 : 76;
      text(c.title, pad, y, story ? 68 : 46, 800, K.text, 'left', inner, 22);
      if (c.sub) { y += story ? 56 : 38; text(c.sub, pad, y, story ? 30 : 22, 500, K.dim, 'left', inner, 14); }
    }

    /* the headline: units (or, with nothing priced, the record) and the record */
    var big = land ? 150 : story ? 200 : 128;
    y += land ? 210 : story ? 300 : 148;
    var hx = pad;
    var hs = text(c.headline, hx, y, big, 800, tone(c.headline_tone), 'left', land ? inner * 0.58 : inner, 60);
    if (land) {
      /* the record beside the units */
      var rx = pad + inner * 0.62;
      text('RECORD', rx, y - hs * 0.66, 20, 700, K.faint);
      text(c.has_units ? c.record : c.record_sub, rx, y - hs * 0.66 + 74, 64, 800, K.text, 'left', inner * 0.38);
      if (c.has_units) text(c.record_sub, rx, y - hs * 0.66 + 116, 24, 500, K.dim, 'left', inner * 0.38);
      y += 62;
      if (c.roi) text(c.roi, pad, y, 46, 800, tone(c.roi_tone), 'left', inner * 0.58);
      if (c.sample) text(c.sample, pad + (c.roi ? measure(c.roi, fontOf(46, 800)) + 28 : 0), y - 4, 22, 600, K.dim, 'left', inner * 0.58 - (c.roi ? measure(c.roi, fontOf(46, 800)) + 28 : 0));
    } else {
      y += story ? 84 : 56;
      if (c.roi) { text(c.roi, pad, y, story ? 60 : 40, 800, tone(c.roi_tone), 'left', inner * 0.5); }
      if (c.sample) text(c.sample, W - pad, y - 4, story ? 28 : 20, 600, K.dim, 'right', inner * 0.48);
      y += story ? 120 : 66;
      text('RECORD', pad, y - (story ? 56 : 30), story ? 24 : 18, 700, K.faint);
      text(c.has_units ? c.record : c.record_sub, pad, y + (story ? 30 : 22), story ? 88 : 54, 800, K.text, 'left', inner);
      if (c.has_units) { y += story ? 84 : 56; text(c.record_sub, pad, y, story ? 32 : 22, 500, K.dim, 'left', inner); }
    }

    /* how it was priced, Verified P&L beside it, what was left out: ALWAYS on
       the card, so their room above the footer is set aside first */
    var fy = H - pad + 6, ns = story ? 26 : 20, lead = ns + (story ? 12 : 9);
    var notes = [c.basis, c.verified, c.unpriced].filter(Boolean);
    var noteLines = notes.map(function (n) { return wrap(n, ns, 500, inner, measure, 2); });
    var notesH = noteLines.reduce(function (a, l) { return a + l.length * lead + 4; }, 0);
    var notesMax = fy - (story ? 76 : 44) - notesH;

    /* the markets: units, ROI, picks and record, one box each, as tall as the room allows */
    var M = c.markets, ny = y + (story ? 90 : 48);
    if (M.length) {
      var cols = land ? Math.max(M.length, 3) : 2, gap = land ? 22 : 16, bw = (inner - gap * (cols - 1)) / cols;
      var top = y + (land ? 54 : story ? 84 : 36), rows = Math.ceil(M.length / cols);
      var room = notesMax - (story ? 60 : 30) - top - gap * (rows - 1);
      var bh = Math.max(96, Math.min(story ? 230 : 168, room / rows));
      var us = Math.min(story ? 60 : 48, Math.round(bh * 0.36)), ls = story ? 22 : 18, ms = story ? 24 : 18;
      M.forEach(function (m, i) {
        var r = Math.floor(i / cols), bx = pad + (i % cols) * (bw + gap), by = top + r * (bh + gap);
        ops.push({ type: 'rect', x: bx, y: by, w: bw, h: bh, fill: K.panel, stroke: K.border, r: 16 });
        text(m.label.toUpperCase(), bx + 24, by + Math.min(44, Math.round(bh * 0.27)), ls, 700, K.faint, 'left', bw - 48);
        text(m.units, bx + 24, by + Math.round(bh * 0.62), us, 800, tone(m.tone), 'left', bw - 48, 22);
        text(m.meta, bx + 24, by + Math.round(bh * 0.86), ms, 500, K.dim, 'left', bw - 48, 12);
      });
      ny = top + rows * (bh + gap) - gap + (story ? 90 : land ? 52 : 40);
    }
    ny = Math.min(ny, notesMax) + ns;
    noteLines.forEach(function (ls2) {
      ls2.forEach(function (ln, i) { text(ln, pad, ny + i * lead, ns, 500, K.dim, 'left', inner); });
      ny += ls2.length * lead + 4;
    });

    /* footer: when, the 21+ line, and where to see every pick */
    if (c.as_of) text(c.as_of + ' · ' + c.footer, pad, fy, story ? 24 : 20, 500, K.faint, 'left', inner * 0.58);
    else text(c.footer, pad, fy, story ? 24 : 20, 500, K.faint, 'left', inner * 0.58);
    text(c.site, W - pad, fy, story ? 30 : 24, 700, K.text, 'right', inner * 0.4);
    return { width: W, height: H, format: RC.FORMATS[format] ? format : 'x_landscape', ops: ops, bottom_of_notes: ny };
  };

  /* ------------------------------------------------------------ draw */
  RC.draw = function (canvas, L) {
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
  RC.measureWith = function (canvas) {
    var g = canvas.getContext('2d');
    return function (t, font) { g.font = font; return g.measureText(String(t)).width; };
  };
  /** a file name for the image: edgedesk-record-nfl-x_landscape.png */
  RC.fileName = function (c, format) { return 'edgedesk-record-' + (c.scope || 'all') + '-' + (RC.FORMATS[format] ? format : 'x_landscape') + '.png'; };
  return RC;
});
