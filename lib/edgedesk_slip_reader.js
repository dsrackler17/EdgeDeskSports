/* ===========================================================================
   EDGEDESK PORTFOLIO — bet slip screenshots.
   docs/sportsbook-sync-providers.md § Screenshot import

   A screenshot of a bet slip becomes a FILLED-IN FORM, never a saved bet.
     1. ocr(file)   reads the text in the reader's own browser with
                    Tesseract.js (Apache-2.0), loaded only when the reader
                    picks a screenshot. The image is never uploaded; only
                    Tesseract's code and its English model are downloaded
                    from public CDNs. It costs nothing per slip.
     2. read(text)  finds what a slip states — the book, the event, the
                    selection, the market type, American odds, the stake,
                    the status, the payout, the bet id and when it was placed
                    — each field only where the text actually says it.
     3. The Portfolio opens its own "Record a sportsbook bet" form with those
        values, says which fields were not found or were guessed, and saves
        nothing until the reader presses Save. Saving is the ordinary manual
        path: the same validation, the derived P&L, and the bet id kept as
        the position's external id, so the same bet imported later from the
        book's CSV, or recorded twice, is refused as a duplicate.

   NEVER GUESSED: an amount without a label saying what it is; a status when
   the slip names two; a date that only reads day-first. A field not found
   is left empty for the reader. ACCURACY IS NOT CLAIMED: OCR misreads, and
   every book lays its slip out differently — hence the review.

   Browser: window.EDSlipReader.   Node: require('./edgedesk_slip_reader.js').
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EDSlipReader = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  /* exact version, from jsDelivr; loaded on first use only. The integrity hash is
     of dist/tesseract.min.js in the npm package tesseract.js@5.1.1 (jsDelivr serves
     it byte for byte), so an altered file is refused by the browser. Tesseract then
     loads its own worker and engine from jsDelivr at the same version. */
  var TESSERACT_SRC = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  var TESSERACT_SRI = 'sha384-GJqSu7vueQ9qN0E9yLPb3Wtpd7OrgK8KmYzC8T1IysG1bcvxvIO4qtYR/D3A991F';
  var MAX_BYTES = 10 * 1024 * 1024;
  var IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

  var BOOKS = [[/draft\s*kings|\bdk\s*sportsbook/i, 'draftkings'], [/fan\s*duel/i, 'fanduel'], [/bet\s*mgm/i, 'betmgm'],
    [/caesars/i, 'williamhill_us'], [/bet\s*365/i, 'bet365'], [/bet\s*rivers/i, 'betrivers'], [/fanatics/i, 'fanatics'],
    [/espn\s*bet|the\s*score\s*bet/i, 'espnbet'], [/hard\s*rock/i, 'hardrockbet']];
  var LEAGUES = [['NFL', 'Football'], ['NCAAF', 'Football'], ['CFB', 'Football'], ['NBA', 'Basketball'], ['WNBA', 'Basketball'], ['NCAAB', 'Basketball'],
    ['MLB', 'Baseball'], ['NHL', 'Hockey'], ['MLS', 'Soccer'], ['EPL', 'Soccer'], ['UFC', 'MMA'], ['PGA', 'Golf'], ['ATP', 'Tennis'], ['WTA', 'Tennis']];
  var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  /* the labels a slip puts beside an amount */
  var LABELS = [
    ['payout', /\b(?:total\s+payout|potential\s+payout|to\s+pay|payout|paid|returned|total\s+return)\b/ig],
    ['towin', /\bto\s+win\b/ig],
    ['stake', /\b(?:total\s+wager|wager(?:ed)?|stake|risk(?:ed)?|bet\s+amount|amount\s+wagered)\b/ig]
  ];
  var MONEY = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?/g;

  function clean(text) {
    return String(text || '').replace(/[−‒–—]/g, '-').replace(/[‘’]/g, '\'').replace(/ /g, ' ');
  }
  function linesOf(text) { return clean(text).split(/\r?\n/).map(function (l) { return l.replace(/\s+/g, ' ').trim(); }).filter(Boolean); }
  function money(m) { return m[1].replace(/,/g, '') + '.' + (m[2] || '00'); }
  function moneyIn(line) { var out = [], m; MONEY.lastIndex = 0; while ((m = MONEY.exec(line))) out.push({ at: m.index, end: m.index + m[0].length, value: money(m) }); return out; }
  function onlyMoney(line) { var t = line.replace(MONEY, '').replace(/[\s:.]/g, ''); return !t && moneyIn(line).length === 1; }
  function labelsIn(line) {
    var out = [];
    LABELS.forEach(function (L) {
      var m; L[1].lastIndex = 0;
      while ((m = L[1].exec(line))) {
        /* "to win" is not the stake's "win"; "potential payout" is a payout label */
        if (out.some(function (o) { return m.index >= o.at && m.index < o.end; })) continue;
        out.push({ kind: L[0], at: m.index, end: m.index + m[0].length });
      }
    });
    return out.sort(function (a, b) { return a.at - b.at; });
  }
  /* Each label takes the amount beside it. A slip prints "Wager $100.00 To Pay
     $190.91" or "$100.00 WAGER $190.91 TOTAL PAYOUT": a line that starts with
     an amount pairs each label with the amount before it, any other line with
     the amount after it. A label alone on its line takes the amount alone on
     the line above or below — above when the slip's first lone amount comes
     before its first lone label. */
  function labelledAmounts(lines) {
    var got = {}, usedLine = {};
    var lone = function (l) { return labelsIn(l).length && !moneyIn(l).length && l.replace(/[^a-z]/gi, '').length < 25; };
    var firstMoney = -1, firstLabel = -1;
    lines.forEach(function (l, i) { if (firstMoney < 0 && onlyMoney(l)) firstMoney = i; if (firstLabel < 0 && lone(l)) firstLabel = i; });
    var above = firstMoney >= 0 && firstLabel >= 0 && firstMoney < firstLabel;
    lines.forEach(function (line, i) {
      var labs = labelsIn(line);
      if (!labs.length) return;
      var amts = moneyIn(line), used = {}, amountFirst = amts.length && amts[0].at < labs[0].at;
      labs.forEach(function (L, j) {
        if (got[L.kind]) return;
        var stop = j + 1 < labs.length ? labs[j + 1].at : Infinity, from = j > 0 ? labs[j - 1].end : -1;
        var after = amts.filter(function (a) { return !used[a.at] && a.at >= L.end && a.at < stop; })[0];
        var before = amts.filter(function (a) { return !used[a.at] && a.end <= L.at && a.at > from; }).pop();
        var pick = amountFirst ? (before || after) : (after || before);
        if (!pick && !amts.length) {
          var up = i > 0 && !usedLine[i - 1] && onlyMoney(lines[i - 1]) ? i - 1 : -1, down = lines[i + 1] && !usedLine[i + 1] && onlyMoney(lines[i + 1]) ? i + 1 : -1;
          var at = above ? (up >= 0 ? up : down) : (down >= 0 ? down : up);
          if (at >= 0) { usedLine[at] = 1; pick = moneyIn(lines[at])[0]; }
        }
        if (pick) { used[pick.at] = 1; got[L.kind] = pick.value; }
      });
    });
    return got;
  }
  function oddsIn(line) {
    var out = [], re = /(^|[\s(])([+-]\d{3,5})(?![\d.,])/g, m;
    while ((m = re.exec(line))) { var n = +m[2]; if (Math.abs(n) >= 100) out.push({ value: n > 0 ? '+' + n : String(n), at: m.index + m[1].length }); }
    if (/(^|\s)(even|evens|ev)(\s|$)/i.test(line)) out.push({ value: '+100', at: line.search(/(even|evens|ev)\b/i) });
    return out;
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function clock(h, mi, ap) {
    h = +h; mi = +mi;
    if (ap) { ap = ap.toLowerCase().charAt(0); if (h === 12) h = 0; if (ap === 'p') h += 12; }
    return h > 23 || mi > 59 ? null : pad(h) + ':' + pad(mi);
  }
  /* a date-time as the slip prints it → 'YYYY-MM-DDTHH:MM' (the form's local time); month-first only */
  function dateIn(line) {
    var m = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:,?\s+(?:at\s+)?(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]\.?m\.?)?)?/i.exec(line), y, mo, d, t = '12:00', timed = false;
    if (m) { mo = +m[1]; d = +m[2]; y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; if (m[4]) { t = clock(m[4], m[5], m[6]); timed = true; } }
    else {
      m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?:,?\s*(?:at\s+)?(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]\.?m\.?)?)?/i.exec(line);
      if (!m) return null;
      mo = MONTHS[m[1].toLowerCase()]; d = +m[2]; y = +m[3];
      if (m[4]) { t = clock(m[4], m[5], m[6]); timed = true; }
    }
    if (!t || mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
    return { value: y + '-' + pad(mo) + '-' + pad(d) + 'T' + t, timed: timed };
  }
  var NOT_A_SELECTION = /\$|\b(wager|stake|payout|to pay|to win|paid|returned|placed|bet\s*id|ticket|receipt|odds|cash\s*out|share|reuse|my bets|settled|open bets|boost)\b/i;
  var STATUS_ONLY = /^(won|win|lost|loss|push|void|open|pending|settled|cashed out)$/i;
  var MARKET_ONLY = /^(alternate\s+)?(spread|point spread|run line|puck line|moneyline|money line|total|totals|total points|over\/under|player props?|parlay|same game parlay|sgp\+?|single|straight( bet)?|\d+\s*-?\s*leg\s+(same game\s+)?parlay|\d+\s*pick\s+parlay)(\s+betting)?$/i;

  function read(text, opts) {
    opts = opts || {};
    var lines = linesOf(text), all = lines.join('\n'), found = [], warnings = [], v = {};
    if (!lines.length) return { values: {}, found: [], missing: ['everything'], warnings: ['No text was found in the image.'] };
    /* the book */
    var book = null;
    BOOKS.some(function (b) { if (b[0].test(all)) { book = b[1]; return true; } return false; });
    if (book) { v.platform = book; found.push('platform'); }
    else if (opts.platform) { v.platform = opts.platform; warnings.push('The screenshot does not name the sportsbook; it is set to the one you chose.'); }
    /* the market type */
    var type = null;
    if (/\b(same\s*game\s*parlay|sgp\+?)\b/i.test(all)) type = 'SAME_GAME_PARLAY';
    else if (/\bparlay\b|\b\d+\s*-?\s*(leg|pick)\b/i.test(all)) type = 'PARLAY';
    else if (/\b(passing|rushing|receiving|yards|touchdowns?|anytime|rebounds|assists|strikeouts|receptions|three\s*pointers|threes|shots on goal|player)\b/i.test(all)) type = 'PLAYER_PROP';
    else if (/\b(point\s*spread|spread|run\s*line|puck\s*line|handicap)\b/i.test(all)) type = 'SPREAD';
    else if (/\b(total|over|under|o\/u)\b/i.test(all)) type = 'TOTAL';
    else if (/\b(money\s*line|moneyline)\b/i.test(all)) type = 'MONEYLINE';
    if (type) { v.position_type = type; found.push('position_type'); }
    /* the event: "A @ B", "A vs B", "A at B" on a line of its own */
    var ev = null;
    lines.some(function (l) {
      if (/\$/.test(l) || oddsIn(l).length) return false;
      var m = /^(.{2,60}?)\s+(@|vs\.?|v\.?|at)\s+(.{2,60})$/i.exec(l);
      if (m && /[a-z]{2}/i.test(m[1]) && /[a-z]{2}/i.test(m[3]) && !/\b(placed|pm|am)\b/i.test(l)) { ev = m[1].trim() + (/^(@|at)$/i.test(m[2]) ? ' @ ' : ' vs ') + m[3].trim(); return true; }
      return false;
    });
    if (ev) { v.event_name = ev; found.push('event_name'); }
    /* the league, where the slip prints one */
    LEAGUES.some(function (L) { if (new RegExp('\\b' + L[0] + '\\b').test(all)) { v.league = L[0]; v.sport = L[1]; return true; } return false; });
    /* the selection(s): text lines that are not labels, amounts, dates, the event or the book */
    var picks = lines.filter(function (l) {
      if (l.length < 3 || l.length > 90 || !/[a-z]{3}/i.test(l) || NOT_A_SELECTION.test(l) || STATUS_ONLY.test(l) || MARKET_ONLY.test(l) || dateIn(l)) return false;
      if (ev && l.replace(/\s+/g, ' ') === ev) return false;
      if (/^(.{2,60}?)\s+(@|vs\.?|v\.?|at)\s+(.{2,60})$/i.test(l)) return false;
      return !BOOKS.some(function (b) { return b[0].test(l) && l.replace(b[0], '').replace(/\b(sportsbook|sports|casino|app)\b/ig, '').replace(/[^a-z]/gi, '').length < 4; });
    }).map(function (l) { return l.replace(/(^|\s)[+-]\d{3,5}(?![\d.])/g, ' ').replace(/\s+/g, ' ').trim(); }).filter(Boolean);
    if (picks.length) {
      var parlay = type === 'PARLAY' || type === 'SAME_GAME_PARLAY';
      v.selection = parlay ? picks.slice(0, 12).join('; ') : picks[0];
      found.push('selection');
      if (parlay && picks.length > 1) warnings.push('Each leg was read as one line of the selection; check them against the slip.');
      /* a spread's or a total's line, from the selection itself */
      if (!parlay) {
        var tot = /\b(over|under|o|u)\s*(\d{1,3}(?:\.\d)?)\b/i.exec(v.selection), spr = /(?:^|\s)([+-]\d{1,2}(?:\.\d)?)(?=\s|$)/.exec(v.selection);
        if (tot) { v.line = tot[2]; found.push('line'); if (!type) { v.position_type = 'TOTAL'; found.push('position_type'); } }
        else if (spr && Math.abs(+spr[1]) < 100) { v.line = spr[1]; found.push('line'); if (!type) { v.position_type = 'SPREAD'; found.push('position_type'); } }
      }
    }
    if (!v.position_type) { v.position_type = 'MONEYLINE'; warnings.push('The market type was not printed; it is set to Moneyline — change it if that is wrong.'); }
    /* American odds: the one labelled "odds", else the first printed */
    var oddsLine = lines.filter(function (l) { return /\bodds\b/i.test(l) && oddsIn(l).length; })[0];
    var allOdds = [];
    lines.forEach(function (l) { oddsIn(l).forEach(function (o) { allOdds.push(o.value); }); });
    var odds = oddsLine ? oddsIn(oddsLine)[0].value : allOdds[0];
    if (odds) { v.odds = odds; found.push('odds'); if (!oddsLine && allOdds.length > 1 && allOdds.some(function (o) { return o !== odds; })) warnings.push('More than one price is printed (' + allOdds.slice(0, 4).join(', ') + '); the first is used — for a parlay, use its combined odds.'); }
    /* amounts, only where a label says what they are */
    var amts = labelledAmounts(lines);
    if (amts.stake) { v.stake = amts.stake; found.push('stake'); }
    /* the status: the one the slip names; two different ones are left to the reader (a parlay with a lost leg lost) */
    var s = all.replace(/\bto\s+win\b/ig, ' ').replace(/\bcash\s*out\b/ig, ' ');
    var named = [];
    if (/\bcashed\s*out\b/i.test(s)) named.push('CASHED_OUT');
    if (/\b(void(ed)?|cancell?ed|refunded)\b/i.test(s)) named.push('VOID');
    if (/\bpush(ed)?\b/i.test(s)) named.push('PUSH');
    if (/\bwon\b/i.test(s)) named.push('WON');
    if (/\blost\b/i.test(s)) named.push('LOST');
    var status = null;
    if (named.length === 1) status = named[0];
    else if (named.length > 1 && (type === 'PARLAY' || type === 'SAME_GAME_PARLAY') && named.indexOf('LOST') >= 0 && named.indexOf('CASHED_OUT') < 0) status = 'LOST';
    else if (named.length > 1) warnings.push('The slip names more than one result (' + named.join(', ').toLowerCase().replace(/_/g, ' ') + '); choose the ticket\'s own.');
    else if (/\b(open|pending|unsettled|in\s*progress|live)\b/i.test(s)) status = 'OPEN';
    if (status) { v.status = status; found.push('status'); } else { v.status = 'OPEN'; if (!named.length) warnings.push('No result was printed, so it is recorded as open.'); }
    if (v.status !== 'OPEN' && amts.payout) { v.reported_payout = amts.payout; found.push('reported_payout'); }
    else if (v.status === 'WON' && amts.towin && v.stake) { v.reported_payout = (Math.round((+v.stake + +amts.towin) * 100) / 100).toFixed(2); found.push('reported_payout'); }
    if (v.status === 'CASHED_OUT' && !v.reported_payout) warnings.push('A cashed-out bet needs the amount the book paid.');
    /* a bonus bet risks no cash */
    if (/\b(bonus\s*bet|free\s*bet|site\s*credit)\b/i.test(all)) { v.stake_type = 'BONUS'; found.push('stake_type'); }
    if (/\bprofit\s*boost|\bboost(ed)?\b/i.test(all)) warnings.push('The slip mentions a boost: the odds above should be the boosted ones.');
    /* the bet id */
    var idm = /\b(?:bet\s*id|ticket\s*(?:id|#|no\.?|number)?|receipt(?:\s*id)?|bet\s*#|id)\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9/_-]{5,60})/i.exec(all);
    if (idm && /\d/.test(idm[1])) { v.external_position_id = idm[1]; found.push('external_position_id'); }
    /* when it was placed: the "placed" line, else the first date with a time */
    var placed = null;
    lines.some(function (l, i) { if (!/\bplaced\b/i.test(l)) return false; placed = dateIn(l) || (lines[i + 1] && dateIn(lines[i + 1])); return !!placed; });
    if (!placed) lines.some(function (l) { var d = dateIn(l); if (d && d.timed) { placed = d; return true; } return false; });
    if (placed) { v.placed_at = placed.value; found.push('placed_at'); if (!placed.timed) warnings.push('The slip gives the date it was placed but not the time; noon is used.'); }
    if (placed && opts.now && Date.parse(placed.value) > opts.now + 86400000) { warnings.push('The date read is in the future; check it.'); }
    var need = ['platform', 'event_name', 'selection', 'odds', 'stake', 'placed_at'];
    return { values: v, found: found, missing: need.filter(function (k) { return !v[k]; }), warnings: warnings };
  }

  /* ── the browser half: load Tesseract once, prepare the image, read it ── */
  var loading = null;
  function loadTesseract(win) {
    if (win.Tesseract) return Promise.resolve(win.Tesseract);
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var s = win.document.createElement('script');
      s.src = TESSERACT_SRC; s.integrity = TESSERACT_SRI; s.async = true; s.crossOrigin = 'anonymous';
      s.onload = function () { win.Tesseract ? resolve(win.Tesseract) : reject(new Error('OCR did not load')); };
      s.onerror = function () { loading = null; reject(new Error('OCR could not be downloaded')); };
      win.document.head.appendChild(s);
    });
    return loading;
  }
  function checkFile(file) {
    if (!file) return 'Choose a screenshot.';
    if (IMAGE_TYPES.indexOf(String(file.type || '').toLowerCase()) < 0) return 'That is not a PNG, JPEG or WebP image.';
    if (file.size > MAX_BYTES) return 'That image is over 10 MB.';
    return null;
  }
  /* dark-mode slips read better inverted; small ones read better enlarged */
  function prepare(win, file) {
    return new Promise(function (resolve) {
      var url = win.URL.createObjectURL(file), img = new win.Image();
      img.onload = function () {
        try {
          var k = img.naturalWidth < 1000 ? 2 : 1, c = win.document.createElement('canvas');
          c.width = img.naturalWidth * k; c.height = img.naturalHeight * k;
          var g = c.getContext('2d'); g.drawImage(img, 0, 0, c.width, c.height);
          var d = g.getImageData(0, 0, c.width, c.height), px = d.data, sum = 0, n = 0;
          for (var i = 0; i < px.length; i += 64) { sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]; n++; }
          if (n && sum / n < 110) { for (var j = 0; j < px.length; j += 4) { px[j] = 255 - px[j]; px[j + 1] = 255 - px[j + 1]; px[j + 2] = 255 - px[j + 2]; } g.putImageData(d, 0, 0); }
          resolve(c);
        } catch (_) { resolve(file); } finally { win.URL.revokeObjectURL(url); }
      };
      img.onerror = function () { win.URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }
  async function ocr(win, file, onProgress) {
    var bad = checkFile(file);
    if (bad) throw new Error(bad);
    var T = await loadTesseract(win);
    var input = await prepare(win, file);
    var r = await T.recognize(input, 'eng', { logger: function (m) { if (onProgress && m && typeof m.progress === 'number') onProgress(m.status || '', m.progress); } });
    return { text: (r && r.data && r.data.text) || '', confidence: r && r.data ? r.data.confidence : null };
  }

  return { read: read, ocr: ocr, checkFile: checkFile, dateIn: dateIn, oddsIn: oddsIn, labelledAmounts: function (t) { return labelledAmounts(linesOf(t)); },
    TESSERACT_SRC: TESSERACT_SRC, TESSERACT_SRI: TESSERACT_SRI, MAX_BYTES: MAX_BYTES, IMAGE_TYPES: IMAGE_TYPES };
}));
