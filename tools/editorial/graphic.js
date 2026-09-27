/*__EDED_GRAPHIC_START__*/
/* ============================================================================
   THE ARTICLE HEADER GRAPHIC — EdgeDesk's own brand, and nothing it does not
   own.

   NO TEAM LOGOS, AND THAT IS NOT A TEMPORARY LIMITATION. A club mark is
   somebody else's trademark; EdgeDesk holds no licence for one and a social
   card is exactly where an unlicensed mark travels furthest. So the graphic
   is built from the things this repository does own: the two team NAMES as
   text, the date, EdgeDesk's palette and, on a card that has them, the two
   numbers that are the whole point of the page.

   IT IS AN SVG, WRITTEN BY A PURE FUNCTION, and that is the replaceable part:
   `render()` takes a spec and returns a string, so swapping in a raster
   pipeline, a licensed-logo layer or an entirely different design later means
   replacing one function rather than finding every place a card is made.

   TWO CARDS:
     PREGAME RESEARCH     EDGEDESK -3.8  /  MARKET -1.5
     POSTGAME ANALYSIS    SEA 27 — NE 20  /  WHAT WE LEARNED

   1200x630, because that is what every social preview crops to.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDED = root.EDED || {};
  root.EDED.graphic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var W = 1200, H = 630;
  /* the terminal's palette, from articles.css — one source of brand truth */
  var C = {
    bg: '#100e0a', surface: '#191510', surface2: '#221c15', border: '#332a1b',
    text: '#f1ebdf', dim: '#a29581', faint: '#887e70',
    accent: '#2fa79a', pos: '#76bd3e', neg: '#e26044', warn: '#d99a2b', mdl: '#d274b0'
  };
  var MONO = "'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace";
  var SANS = "'Inter',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif";

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  /* A long team name has to fit. Shrinking the type is better than cutting a
     name in half, and cutting is only reached at a length no real team has. */
  function fit(text, max, base, min) {
    var n = String(text || '').length;
    if (n <= max) return base;
    var size = Math.floor(base * (max / n));
    return Math.max(min, size);
  }
  function clip(text, max) {
    var s = String(text || '');
    return s.length <= max ? s : s.slice(0, max - 1) + '…';
  }

  function dateLabel(iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return null;
    var d = new Date(t);
    var M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return M[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear();
  }

  /* ------------------------------------------------------------ the spec */
  /* Built from the record, never from anything else, so a card cannot carry a
     figure the page does not. */
  function specFor(rec) {
    var isPost = rec.article_type === 'postgame';
    var snap = rec.snapshot || {}, res = rec.result || {}, g = rec.grading || {};
    var base = {
      kind: isPost ? 'postgame' : 'pregame',
      eyebrow: isPost ? 'POSTGAME ANALYSIS' : 'PREGAME RESEARCH',
      sport: rec.sport_label,
      away: rec.away_team, home: rec.home_team,
      date: dateLabel(rec.game_time),
      meta: [rec.week ? 'Week ' + rec.week : null, rec.season ? String(rec.season) : null,
        rec.venue].filter(Boolean).join(' · '),
      left: null, right: null, footer: 'Research, not picks.'
    };
    if (isPost) {
      if (res.home_score != null) {
        base.left = { k: rec.away_team, v: String(res.away_score) };
        base.right = { k: rec.home_team, v: String(res.home_score) };
      }
      base.badge = g.process_headline ? 'PROCESS: ' + g.process_headline : 'WHAT WE LEARNED';
      base.badge_tone = g.process_headline === 'SOUND' ? C.pos
        : g.process_headline === 'UNSOUND' ? C.neg : C.warn;
      base.footer = 'What happened, what we got right, what we learned.';
      return base;
    }
    var model = snap.model || {}, market = snap.market || {};
    /* ONLY WHERE BOTH EXIST. A card showing EdgeDesk's number beside a blank
       where the market's should be reads as a claim about the market. */
    if (model.fair_spread_text) {
      base.left = { k: 'EDGEDESK', v: model.fair_spread_text };
      if (market.available && market.market) base.right = { k: 'MARKET', v: market.market };
      else base.right = { k: 'MARKET', v: 'no quote captured', muted: true };
    } else if (rec.fair_spread_text) {
      base.left = { k: 'EDGEDESK', v: rec.fair_spread_text };
    }
    base.badge = rec.model_status || null;
    base.badge_tone = C.warn;
    return base;
  }

  /* ----------------------------------------------------------- the render */
  /* PURE. spec in, SVG string out. Replace this one function to change the
     entire look, or to hand the job to something else entirely. */
  function render(spec) {
    var s = spec || {};
    var awaySize = fit(s.away, 18, 46, 26);
    var homeSize = fit(s.home, 18, 46, 26);
    var h = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc((s.away || '') + ' at ' + (s.home || '') + ' — ' + (s.eyebrow || '')) + '">';
    h += '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
      + '<stop offset="0" stop-color="' + C.bg + '"/><stop offset="1" stop-color="' + C.surface + '"/></linearGradient></defs>';
    h += '<rect width="' + W + '" height="' + H + '" fill="url(#g)"/>';
    /* the EdgeDesk mark: the same clipped parallelogram the site header uses */
    h += '<path d="M62 52 L102 52 L86 92 L46 92 Z" fill="' + C.pos + '"/>';
    h += '<text x="118" y="84" font-family="' + SANS + '" font-size="30" font-weight="800" fill="' + C.text + '" letter-spacing="-0.5">EdgeDesk</text>';
    h += '<text x="' + (W - 62) + '" y="84" text-anchor="end" font-family="' + MONO + '" font-size="19" font-weight="700" fill="' + C.accent + '" letter-spacing="3">' + esc(s.eyebrow || '') + '</text>';
    h += '<line x1="62" y1="118" x2="' + (W - 62) + '" y2="118" stroke="' + C.border + '" stroke-width="1"/>';

    /* the matchup */
    h += '<text x="62" y="' + (188) + '" font-family="' + SANS + '" font-size="' + awaySize + '" font-weight="750" fill="' + C.text + '">' + esc(clip(s.away, 30)) + '</text>';
    h += '<text x="62" y="' + (188 + 28) + '" font-family="' + MONO + '" font-size="18" fill="' + C.faint + '" letter-spacing="2">AT</text>';
    h += '<text x="62" y="' + (188 + 78) + '" font-family="' + SANS + '" font-size="' + homeSize + '" font-weight="750" fill="' + C.text + '">' + esc(clip(s.home, 30)) + '</text>';

    /* the two numbers */
    var y = 330;
    if (s.left) {
      h += panel(62, y, s.left, s.kind);
      if (s.right) h += panel(62 + 520, y, s.right, s.kind);
    }

    /* the badge */
    if (s.badge) {
      h += '<rect x="62" y="' + (H - 132) + '" rx="9" ry="9" width="' + (18 + String(s.badge).length * 12) + '" height="34" fill="none" stroke="' + (s.badge_tone || C.warn) + '" stroke-width="1.5"/>';
      h += '<text x="' + (62 + 14) + '" y="' + (H - 109) + '" font-family="' + MONO + '" font-size="15" font-weight="700" fill="' + (s.badge_tone || C.warn) + '" letter-spacing="1.5">' + esc(s.badge) + '</text>';
    }

    /* the footer rail */
    h += '<line x1="62" y1="' + (H - 76) + '" x2="' + (W - 62) + '" y2="' + (H - 76) + '" stroke="' + C.border + '" stroke-width="1"/>';
    var foot = [s.sport, s.date, s.meta].filter(Boolean).join('  ·  ');
    h += '<text x="62" y="' + (H - 40) + '" font-family="' + MONO + '" font-size="17" fill="' + C.dim + '">' + esc(clip(foot, 72)) + '</text>';
    h += '<text x="' + (W - 62) + '" y="' + (H - 40) + '" text-anchor="end" font-family="' + SANS + '" font-size="17" font-weight="650" fill="' + C.faint + '">' + esc(s.footer || '') + '</text>';
    h += '</svg>';
    return h;
  }
  function panel(x, y, cell, kind) {
    var big = kind === 'postgame';
    var vSize = big ? 68 : fit(cell.v, 16, 44, 26);
    var colour = cell.muted ? C.faint : (big ? C.text : (cell.k === 'EDGEDESK' ? C.accent : C.dim));
    var h = '<rect x="' + x + '" y="' + y + '" rx="14" ry="14" width="500" height="132" fill="' + C.surface2 + '" stroke="' + C.border + '"/>';
    h += '<text x="' + (x + 26) + '" y="' + (y + 38) + '" font-family="' + MONO + '" font-size="15" font-weight="700" fill="' + C.faint + '" letter-spacing="2.4">' + esc(clip(String(cell.k).toUpperCase(), 26)) + '</text>';
    h += '<text x="' + (x + 26) + '" y="' + (y + 104) + '" font-family="' + MONO + '" font-size="' + vSize + '" font-weight="700" fill="' + colour + '">' + esc(clip(cell.v, 22)) + '</text>';
    return h;
  }

  /* A data: URI, so a record can carry its own card with no asset pipeline,
     no storage bucket and no second thing to deploy. Swap this for a written
     file and a CDN path when there is one; nothing upstream changes. */
  function dataUri(svg) {
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
      .replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29');
  }
  function forRecord(rec) {
    var spec = specFor(rec);
    var svg = render(spec);
    return { spec: spec, svg: svg, data_uri: dataUri(svg), width: W, height: H,
      alt: (rec.away_team || '') + ' at ' + (rec.home_team || '') + ' — ' + spec.eyebrow + ', EdgeDesk Sports' };
  }

  return { W: W, H: H, COLOURS: C, esc: esc, fit: fit, clip: clip, dateLabel: dateLabel,
    specFor: specFor, render: render, dataUri: dataUri, forRecord: forRecord };
});
/*__EDED_GRAPHIC_END__*/
