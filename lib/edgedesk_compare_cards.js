/* ===========================================================================
   EdgeDesk COMPARISON GRAPHICS — shareable cards that show what a line costs
   at DraftKings and at Novig, drawn only from real, attributable data.

   The same pipeline as lib/edgedesk_game_graphic.js: content -> layout (a
   plain list of drawing operations, testable without a canvas) -> draw
   (Canvas 2D) -> PNG (canvas.toBlob). No library, no server.

   TEMPLATES (layout(template, data) -> {ok, ops, w, h, file} or {ok:false, reason})
     price_gap         the same selection at both venues, the effective price
                       improvement and the quote times
     worse_price_cost  what the worse price costs on a win at each stake, at
                       Novig's executable fill (a stake the book cannot fill
                       says so)
     book_hold         DraftKings' margin on a complete two-way market and the
                       proportional no-vig estimate, labelled as an estimate
     edge_upgrade      model probability and version, EV at each venue, the
                       change and the state — ONLY when the model passed the
                       gate (validated, versioned, frozen before the quote,
                       this exact market); otherwise refused
     market_movement   both venues' implied probability over time at their own
                       timestamps, with the lead-lag summary (sequence, not
                       causation)
     todays_gaps       the largest current, executable, comparable gaps, both
                       directions
     why_shopping      real observed examples, including a small gap and one
                       where DraftKings is the better price
   EVERY CARD carries both sources and their observation times, the research
   disclaimer, and — while Novig's display permission is not on record — an
   INTERNAL PREVIEW watermark. A card whose data is missing, stale or not
   comparable is refused with the reason; nothing is filled in.
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDCompareCards = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var W = 1080, H = 1350;
  /* the app's own tokens (app.html :root) */
  var K = { bg: '#100e0a', surface: '#191510', surface2: '#221c15', border: '#332a1b', text: '#f1ebdf', dim: '#aa9c87', faint: '#958a7a',
    accent: '#2fa79a', pos: '#76bd3e', neg: '#e26044', warn: '#d99a2b', gold: '#e3b84d', dk: '#5fae55', nv: '#c79bf2' };
  var DISPLAY = '"Barlow Condensed", "Inter", sans-serif', BODY = '"Inter", system-ui, sans-serif', MONO = '"JetBrains Mono", ui-monospace, monospace';
  /* words a comparison card never prints */
  var BANNED = /\b(lock|guarantee[ds]?|risk[- ]free|free money|sure thing|can't lose|cannot lose)\b/i;
  var CONTENT_MAX = 960;   /* every template's content ends above this: the watermark band and the sources follow */
  var DISCLAIMER = 'Research, not betting advice. A better price is not, by itself, a positive-EV bet. Prices move; quotes are as observed.';
  var TEMPLATES = ['price_gap', 'worse_price_cost', 'book_hold', 'edge_upgrade', 'market_movement', 'todays_gaps', 'why_shopping'];

  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function am(a) { a = num(a); if (a == null) return '—'; var r = Math.round(a); if (r === -100) r = 100; return (r > 0 ? '+' : '') + r; }
  function money(x) { x = num(x); if (x == null) return '—'; return (x < 0 ? '−$' : '$') + Math.abs(x).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function pp(x) { x = num(x); if (x == null) return '—'; return (x > 0 ? '+' : x < 0 ? '−' : '±') + Math.abs(x).toFixed(1) + ' pp'; }
  function pct(x) { x = num(x); return x == null ? '—' : (100 * x).toFixed(1) + '%'; }
  function stamp(iso) {
    var t = Date.parse(iso); if (!isFinite(t)) return null;
    try { return new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET'; }
    catch (_) { return new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; }
  }
  function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60); }

  /* ------------------------------------------------------------ the op list */
  function Ops() { this.ops = []; }
  Ops.prototype.rect = function (x, y, w, h, fill, r) { this.ops.push({ t: 'rect', x: x, y: y, w: w, h: h, fill: fill, r: r || 0 }); return this; };
  Ops.prototype.text = function (s, x, y, o) { this.ops.push(Object.assign({ t: 'text', s: String(s), x: x, y: y, size: 32, color: K.text, font: BODY, weight: 400, align: 'left' }, o || {})); return this; };
  Ops.prototype.line = function (x1, y1, x2, y2, color, w) { this.ops.push({ t: 'line', x1: x1, y1: y1, x2: x2, y2: y2, color: color || K.border, w: w || 2 }); return this; };
  Ops.prototype.poly = function (pts, color, w) { this.ops.push({ t: 'poly', pts: pts, color: color, w: w || 4 }); return this; };

  function frame(o, title, kicker, d) {
    o.rect(0, 0, W, H, K.bg);
    o.rect(0, 0, W, 10, K.accent);
    o.text('EDGEDESK', 64, 92, { font: DISPLAY, size: 40, weight: 700, color: K.accent });
    o.text('RESEARCH', W - 64, 92, { font: DISPLAY, size: 28, weight: 600, color: K.dim, align: 'right' });
    o.text(kicker, 64, 170, { font: DISPLAY, size: 34, weight: 600, color: K.gold });
    o.text(title, 64, 250, { font: DISPLAY, size: title.length <= 16 ? 84 : 64, weight: 700, color: K.text, fit: W - 128 });
    if (d.internal) {
      o.rect(0, H - 372, W, 84, 'rgba(226,96,68,0.18)');
      o.text('INTERNAL PREVIEW — NOT FOR DISTRIBUTION', W / 2, H - 336, { size: 26, weight: 700, color: K.neg, align: 'center' });
      o.text('Novig\'s display permission is not on record', W / 2, H - 302, { size: 20, weight: 600, color: K.neg, align: 'center' });
    }
  }
  function footer(o, d) {
    var y = H - 270;
    o.line(64, y, W - 64, y, K.border, 2);
    var src = (d.sources || []).filter(Boolean);
    /* each source line gets room to wrap once (22 px × 1.25) */
    src.slice(0, 2).forEach(function (s, i) { o.text(s, 64, y + 40 + i * 62, { size: 22, color: K.dim, maxWidth: W - 128 }); });
    o.text(DISCLAIMER, 64, H - 70, { size: 22, color: K.faint, maxWidth: W - 128 });
    o.text('edgedesksports.com', W - 64, H - 30, { size: 22, color: K.faint, align: 'right' });
  }
  function need(d, keys) { var miss = keys.filter(function (k) { var v = k.split('.').reduce(function (a, p) { return a == null ? a : a[p]; }, d); return v === null || v === undefined || v === ''; }); return miss.length ? 'missing ' + miss.join(', ') : null; }
  function sourceLines(d) {
    var out = [];
    if (d.dk_observed_at) out.push('DraftKings: The Odds API via EdgeDesk\'s odds gateway · observed ' + (stamp(d.dk_observed_at) || '—'));
    if (d.novig_observed_at) out.push('Novig: exchange order book (' + (d.novig_environment || 'production') + ') · ' + (d.novig_source === 'ws_book' ? 'streamed' : 'snapshot') + ' ' + (stamp(d.novig_observed_at) || '—'));
    return out;
  }
  function comparableOrWhy(d) {
    if (d.comparable !== true) return 'not a current comparison (' + (d.why || 'a venue is stale, suspended or missing') + ')';
    return null;
  }

  /* ------------------------------------------------------------ the templates */
  var L = {};
  L.price_gap = function (d) {
    var why = need(d, ['selection', 'game', 'dk_american', 'novig_american', 'better', 'dk_observed_at', 'novig_observed_at']) || comparableOrWhy(d);
    if (why) return { ok: false, reason: why };
    var o = new Ops();
    frame(o, 'THE PRICE GAP', d.game, d);
    o.text(d.selection + (d.line != null ? ' ' + d.line : ''), 64, 340, { font: DISPLAY, size: 56, weight: 600, maxWidth: W - 128 });
    o.text(d.market_label || '', 64, 392, { size: 28, color: K.dim });
    [['DRAFTKINGS', d.dk_american, K.dk, 64], ['NOVIG', d.novig_american, K.nv, W / 2 + 16]].forEach(function (v) {
      o.rect(v[3], 440, W / 2 - 80, 300, K.surface, 20);
      o.text(v[0], v[3] + 32, 500, { font: DISPLAY, size: 34, weight: 700, color: v[2] });
      o.text(am(v[1]), v[3] + 32, 640, { font: MONO, size: 120, weight: 700, color: (d.better === 'NOVIG') === (v[0] === 'NOVIG') && d.better !== 'TIE' ? K.pos : K.text });
    });
    var verdict = d.better === 'TIE' ? 'Same price at both venues' : (d.better === 'NOVIG' ? 'Novig' : 'DraftKings') + ' is the better price';
    o.text(verdict, 64, 820, { font: DISPLAY, size: 52, weight: 700, color: d.better === 'TIE' ? K.dim : K.pos });
    o.text('Implied-probability gap ' + pp(d.implied_gap_pp) + (d.stake ? ' · at $' + d.stake + ' ' + (num(d.payout_diff) != null ? money(Math.abs(d.payout_diff)) + ' more on a win' : '') : ''), 64, 880, { size: 30, color: K.text, maxWidth: W - 128 });
    if (d.novig_effective_american != null && d.stake) o.text('Novig at $' + d.stake + ': ' + am(d.novig_effective_american) + ' after walking the book' + (d.top_not_achievable ? ' (top price not available at that size)' : ''), 64, 930, { size: 26, color: K.dim, maxWidth: W - 128 });
    d.sources = sourceLines(d); footer(o, d);
    return { ok: true, ops: o.ops, w: W, h: H, file: 'edgedesk-price-gap-' + slug(d.game + '-' + d.selection) + '.png' };
  };
  L.worse_price_cost = function (d) {
    var why = need(d, ['selection', 'game', 'stakes', 'dk_observed_at', 'novig_observed_at']) || comparableOrWhy(d);
    if (why) return { ok: false, reason: why };
    if (!Array.isArray(d.stakes) || !d.stakes.length) return { ok: false, reason: 'no stake rows' };
    var o = new Ops();
    frame(o, 'WHAT THE WORSE PRICE COSTS', d.game, d);
    o.text(d.selection + (d.line != null ? ' ' + d.line : ''), 64, 340, { font: DISPLAY, size: 52, weight: 600, maxWidth: W - 128 });
    o.text('STAKE', 64, 420, { size: 26, color: K.dim, weight: 700 }); o.text('DRAFTKINGS PAYS', 300, 420, { size: 26, color: K.dk, weight: 700 }); o.text('NOVIG PAYS', 600, 420, { size: 26, color: K.nv, weight: 700 }); o.text('DIFFERENCE', W - 64, 420, { size: 26, color: K.dim, weight: 700, align: 'right' });
    d.stakes.slice(0, 6).forEach(function (s, i) {
      var y = 490 + i * 90;
      o.rect(48, y - 52, W - 96, 76, i % 2 ? K.bg : K.surface, 12);
      o.text('$' + s.stake, 64, y, { font: MONO, size: 34 });
      o.text(money(s.dk_payout), 300, y, { font: MONO, size: 34 });
      o.text(s.novig_status === 'FILLED' ? money(s.novig_payout) : (s.novig_status === 'PARTIAL' ? 'not fillable' : 'no liquidity'), 600, y, { font: MONO, size: 34, color: s.novig_status === 'FILLED' ? K.text : K.warn });
      o.text(s.novig_status === 'FILLED' && num(s.diff) != null ? (s.diff >= 0 ? '+' : '−') + money(Math.abs(s.diff)).replace('−', '') : '—', W - 64, y, { font: MONO, size: 34, align: 'right', color: num(s.diff) > 0 ? K.pos : num(s.diff) < 0 ? K.neg : K.dim });
    });
    o.text('Payout on a win at each venue\'s executable price for that stake (Novig: its order book, walked level by level).', 64, 920, { size: 24, color: K.dim, maxWidth: W - 128 });
    d.sources = sourceLines(d); footer(o, d);
    return { ok: true, ops: o.ops, w: W, h: H, file: 'edgedesk-worse-price-cost-' + slug(d.game + '-' + d.selection) + '.png' };
  };
  L.book_hold = function (d) {
    var why = need(d, ['game', 'market_label', 'sides', 'hold_pct', 'dk_observed_at']);
    if (why) return { ok: false, reason: why };
    if (!Array.isArray(d.sides) || d.sides.length < 2) return { ok: false, reason: 'a hold needs the complete set of outcomes' };
    var o = new Ops();
    frame(o, 'BOOK HOLD', d.game, d);
    o.text(d.market_label, 64, 340, { font: DISPLAY, size: 48, weight: 600 });
    d.sides.forEach(function (s, i) {
      var y = 430 + i * 170;
      o.rect(64, y, W - 128, 140, K.surface, 16);
      o.text(s.name, 96, y + 60, { font: DISPLAY, size: 40, weight: 600, maxWidth: 520 });
      o.text('DraftKings ' + am(s.american) + ' · implied ' + pct(s.implied), 96, y + 108, { size: 28, color: K.dim });
      o.text('no-vig ' + pct(s.no_vig), W - 96, y + 84, { font: MONO, size: 36, align: 'right', color: K.text });
    });
    var y2 = 430 + d.sides.length * 170 + 40;
    o.text('Margin built into these prices: ' + Number(d.hold_pct).toFixed(2) + '%', 64, y2, { font: DISPLAY, size: 50, weight: 700, color: K.gold });
    o.text('The sum of the implied probabilities minus one, for this complete market at one capture. It is the book\'s margin across all outcomes, not what any one bettor is certain to lose. The no-vig figures are an estimate (proportional), not true probabilities.', 64, y2 + 56, { size: 24, color: K.dim, maxWidth: W - 128 });
    d.sources = sourceLines(d); footer(o, d);
    return { ok: true, ops: o.ops, w: W, h: H, file: 'edgedesk-book-hold-' + slug(d.game + '-' + d.market_label) + '.png' };
  };
  L.edge_upgrade = function (d) {
    if (!d.model || !d.model.gate_ok) return { ok: false, reason: 'no validated model probability passed the gate for this exact market (' + ((d.model && d.model.reasons) || ['no model']).join('; ') + '): no EV card is drawn' };
    var why = need(d, ['selection', 'game', 'model.p_win', 'model.version', 'model.tier', 'ev_dk', 'ev_novig', 'state', 'dk_observed_at', 'novig_observed_at']) || comparableOrWhy(d);
    if (why) return { ok: false, reason: why };
    var o = new Ops();
    frame(o, 'EDGE UPGRADE', d.game, d);
    o.text(d.selection + (d.line != null ? ' ' + d.line : ''), 64, 340, { font: DISPLAY, size: 52, weight: 600, maxWidth: W - 128 });
    o.text('Model probability ' + pct(d.model.p_win) + ' · ' + d.model.version + ' (' + d.model.tier + ')', 64, 400, { size: 28, color: K.dim, maxWidth: W - 128 });
    [['EV AT DRAFTKINGS', d.ev_dk, K.dk, 470], ['EV AT NOVIG', d.ev_novig, K.nv, 630]].forEach(function (v) {
      o.rect(64, v[3], W - 128, 130, K.surface, 16);
      o.text(v[0], 96, v[3] + 56, { font: DISPLAY, size: 34, weight: 700, color: v[2] });
      o.text((v[1] >= 0 ? '+' : '−') + Math.abs(v[1] * 100).toFixed(1) + '¢ per $1', W - 96, v[3] + 84, { font: MONO, size: 48, align: 'right', color: v[1] > 0 ? K.pos : K.neg });
    });
    o.text('Change: ' + ((d.ev_novig - d.ev_dk) >= 0 ? '+' : '−') + Math.abs((d.ev_novig - d.ev_dk) * 100).toFixed(1) + '¢ per $1' + (d.stake ? ' · ' + money((d.ev_novig - d.ev_dk) * d.stake) + ' at $' + d.stake : ''), 64, 820, { font: DISPLAY, size: 44, weight: 700 });
    o.text(d.state_label || d.state, 64, 870, { size: 30, color: K.gold });
    o.text('EV = p × net win per $1 − (1 − p), at each venue\'s executable price; the probability is the model\'s, frozen before the quote.', 64, 916, { size: 22, color: K.dim, maxWidth: W - 128 });
    d.sources = sourceLines(d); footer(o, d);
    return { ok: true, ops: o.ops, w: W, h: H, file: 'edgedesk-edge-upgrade-' + slug(d.game + '-' + d.selection) + '.png' };
  };
  L.market_movement = function (d) {
    var why = need(d, ['selection', 'game', 'series']);
    if (why) return { ok: false, reason: why };
    var S = d.series, all = (S.novig || []).concat(S.draftkings || []);
    if ((S.novig || []).length < 2 || (S.draftkings || []).length < 2) return { ok: false, reason: 'each venue needs at least two observations to show movement' };
    var t0 = Math.min.apply(null, all.map(function (x) { return x.t; })), t1 = Math.max.apply(null, all.map(function (x) { return x.t; }));
    var p0 = Math.min.apply(null, all.map(function (x) { return x.p; })) - 0.01, p1 = Math.max.apply(null, all.map(function (x) { return x.p; })) + 0.01;
    var X = function (t) { return 96 + (W - 192) * (t1 === t0 ? 0.5 : (t - t0) / (t1 - t0)); }, Y = function (p) { return 780 - 340 * (p1 === p0 ? 0.5 : (p - p0) / (p1 - p0)); };
    var o = new Ops();
    frame(o, 'MARKET MOVEMENT', d.game, d);
    o.text(d.selection + ' · implied probability', 64, 340, { font: DISPLAY, size: 44, weight: 600, maxWidth: W - 128 });
    o.rect(64, 400, W - 128, 420, K.surface, 16);
    o.text(pct(p1), 84, 436, { size: 22, color: K.faint }); o.text(pct(p0), 84, 806, { size: 22, color: K.faint });
    [['draftkings', K.dk], ['novig', K.nv]].forEach(function (v) { o.poly((S[v[0]] || []).map(function (x) { return [X(x.t), Y(x.p)]; }), v[1], 5); });
    o.text('— DraftKings', 64, 860, { size: 28, color: K.dk, weight: 700 }); o.text('— Novig', 300, 860, { size: 28, color: K.nv, weight: 700 });
    if (d.lead_lag) o.text(d.lead_lag, 64, 900, { size: 22, color: K.dim, maxWidth: W - 128 });
    o.text('Each line is drawn at its own source\'s observation times. Moving first is a sequence, not proof of cause.', 64, 936, { size: 20, color: K.faint, maxWidth: W - 128 });
    d.sources = sourceLines(d); footer(o, d);
    return { ok: true, ops: o.ops, w: W, h: H, file: 'edgedesk-market-movement-' + slug(d.game + '-' + d.selection) + '.png' };
  };
  L.todays_gaps = function (d) {
    var why = need(d, ['rows', 'as_of']);
    if (why) return { ok: false, reason: why };
    var rows = (d.rows || []).filter(function (r) { return r.comparable === true; });
    if (!rows.length) return { ok: false, reason: 'no current, executable, comparable gap to show' };
    rows = rows.slice().sort(function (a, b) { return Math.abs(b.implied_gap_pp) - Math.abs(a.implied_gap_pp); }).slice(0, 5);
    var o = new Ops();
    frame(o, 'TODAY\'S PRICE GAPS', 'As of ' + (stamp(d.as_of) || d.as_of), d);
    o.text('SELECTION', 64, 340, { size: 24, color: K.dim, weight: 700 }); o.text('DK', 640, 340, { size: 24, color: K.dk, weight: 700 }); o.text('NOVIG', 780, 340, { size: 24, color: K.nv, weight: 700 }); o.text('GAP', W - 64, 340, { size: 24, color: K.dim, weight: 700, align: 'right' });
    rows.forEach(function (r, i) {
      var y = 410 + i * 100;
      o.rect(48, y - 54, W - 96, 84, i % 2 ? K.bg : K.surface, 12);
      o.text(r.selection + (r.line != null ? ' ' + r.line : ''), 64, y - 10, { size: 30, weight: 600, maxWidth: 560 });
      o.text(r.game, 64, y + 20, { size: 20, color: K.faint, maxWidth: 560 });
      o.text(am(r.dk_american), 640, y, { font: MONO, size: 32 });
      o.text(am(r.novig_american), 780, y, { font: MONO, size: 32 });
      o.text(pp(r.implied_gap_pp), W - 64, y, { font: MONO, size: 32, align: 'right', color: r.implied_gap_pp > 0 ? K.pos : r.implied_gap_pp < 0 ? K.neg : K.dim });
    });
    o.text('Gap = DraftKings\' implied probability minus Novig\'s best ask (+ means Novig\'s price is better; − means DraftKings\'). Pregame, both quotes current, same side and line.', 64, 890, { size: 22, color: K.dim, maxWidth: W - 128 });
    d.sources = ['DraftKings: The Odds API via EdgeDesk\'s odds gateway · Novig: exchange order book snapshots', 'Each row\'s quotes were observed within their freshness windows as of ' + (stamp(d.as_of) || d.as_of)]; footer(o, d);
    return { ok: true, ops: o.ops, w: W, h: H, file: 'edgedesk-todays-price-gaps.png' };
  };
  L.why_shopping = function (d) {
    var why = need(d, ['examples', 'as_of']);
    if (why) return { ok: false, reason: why };
    var ex = (d.examples || []).filter(function (r) { return r.comparable === true && r.observed === true; });
    if (ex.length < 2) return { ok: false, reason: 'needs at least two real observed comparisons' };
    var o = new Ops();
    frame(o, 'WHY SHOPPING MATTERS', 'Real quotes, observed ' + (stamp(d.as_of) || d.as_of), d);
    ex.slice(0, 3).forEach(function (r, i) {
      var y = 340 + i * 170;
      o.rect(64, y, W - 128, 150, K.surface, 16);
      o.text(r.selection + (r.line != null ? ' ' + r.line : '') + ' · ' + r.game, 96, y + 50, { size: 28, weight: 600, maxWidth: W - 192 });
      o.text('DraftKings ' + am(r.dk_american) + ' · Novig ' + am(r.novig_american) + ' · ' + (r.better === 'TIE' ? 'a tie' : (r.better === 'NOVIG' ? 'Novig' : 'DraftKings') + ' better by ' + pp(Math.abs(r.implied_gap_pp)).replace('+', '')), 96, y + 100, { size: 26, color: r.better === 'DRAFTKINGS' ? K.warn : K.dim, maxWidth: W - 192 });
    });
    o.text('Sometimes the gap is small, and sometimes the sportsbook is the better price. Checking both is the point.', 64, 890, { size: 26, color: K.text, maxWidth: W - 128 });
    d.sources = ['Observed markets, not hypothetical examples: DraftKings (The Odds API) and Novig (order book) as of ' + (stamp(d.as_of) || d.as_of)]; footer(o, d);
    return { ok: true, ops: o.ops, w: W, h: H, file: 'edgedesk-why-shopping-matters.png' };
  };

  function layout(template, data) {
    if (!L[template]) return { ok: false, reason: 'unknown template ' + template };
    var d = Object.assign({}, data || {});
    var r = L[template](d);
    if (r.ok) {
      var bad = r.ops.filter(function (op) { return op.t === 'text' && BANNED.test(op.s); });
      if (bad.length) return { ok: false, reason: 'copy rule: a card may not say "' + bad[0].s.match(BANNED)[0] + '"' };
    }
    return r;
  }

  /* ------------------------------------------------------------ drawing */
  function draw(ops, ctx) {
    ops.forEach(function (op) {
      if (op.t === 'rect') {
        ctx.fillStyle = op.fill;
        if (op.r && ctx.roundRect) { ctx.beginPath(); ctx.roundRect(op.x, op.y, op.w, op.h, op.r); ctx.fill(); }
        else ctx.fillRect(op.x, op.y, op.w, op.h);
      } else if (op.t === 'text') {
        var size = op.size;
        ctx.font = (op.weight || 400) + ' ' + size + 'px ' + op.font;
        /* a one-line title shrinks to fit the measured width (the display face may not have loaded) */
        while (op.fit && size > 24 && ctx.measureText(op.s).width > op.fit) { size -= 2; ctx.font = (op.weight || 400) + ' ' + size + 'px ' + op.font; }
        ctx.fillStyle = op.color; ctx.textAlign = op.align || 'left'; ctx.textBaseline = 'alphabetic';
        if (op.maxWidth) wrap(ctx, op); else ctx.fillText(op.s, op.x, op.y);
      } else if (op.t === 'line') {
        ctx.strokeStyle = op.color; ctx.lineWidth = op.w; ctx.beginPath(); ctx.moveTo(op.x1, op.y1); ctx.lineTo(op.x2, op.y2); ctx.stroke();
      } else if (op.t === 'poly' && op.pts.length) {
        ctx.strokeStyle = op.color; ctx.lineWidth = op.w; ctx.lineJoin = 'round'; ctx.beginPath();
        op.pts.forEach(function (p, i) { if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }); ctx.stroke();
      }
    });
  }
  /* a long line wraps onto following lines at 1.25× its size */
  function wrap(ctx, op) {
    var words = op.s.split(' '), line = '', y = op.y;
    for (var i = 0; i < words.length; i++) {
      var t = line ? line + ' ' + words[i] : words[i];
      if (ctx.measureText(t).width > op.maxWidth && line) { ctx.fillText(line, op.x, y); line = words[i]; y += op.size * 1.25; }
      else line = t;
    }
    if (line) ctx.fillText(line, op.x, y);
  }
  /** layout + draw + PNG; resolves {ok, blob, file} or {ok:false, reason} */
  function render(template, data, opts) {
    var r = layout(template, data);
    if (!r.ok) return Promise.resolve(r);
    var doc = (opts && opts.document) || root.document;
    if (!doc) return Promise.resolve({ ok: false, reason: 'no canvas in this environment' });
    var c = doc.createElement('canvas'); c.width = r.w; c.height = r.h;
    var ctx = c.getContext('2d');
    var fonts = doc.fonts && doc.fonts.ready ? doc.fonts.ready : Promise.resolve();
    return fonts.then(function () {
      draw(r.ops, ctx);
      return new Promise(function (res) { c.toBlob(function (b) { res(b ? { ok: true, blob: b, file: r.file, canvas: c } : { ok: false, reason: 'the PNG could not be encoded' }); }, 'image/png'); });
    });
  }
  function download(template, data, opts) {
    return render(template, data, opts).then(function (r) {
      if (!r.ok) return r;
      var doc = (opts && opts.document) || root.document, url = URL.createObjectURL(r.blob), a = doc.createElement('a');
      a.href = url; a.download = r.file; doc.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      return r;
    });
  }

  return { TEMPLATES: TEMPLATES, W: W, H: H, K: K, CONTENT_MAX: CONTENT_MAX, BANNED: BANNED, DISCLAIMER: DISCLAIMER, layout: layout, draw: draw, render: render, download: download };
});
