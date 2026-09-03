/*__EDPRES_START__*/
/* ============================================================================
   EdgeDesk PRESENTATION LAYER — "deep engine, simple answer".

   ONE FILE, FOUR HOSTS. This exact block is inlined into:
     - supabase/functions/edgedesk_ai/index.ts   (server: builds `presentation`)
     - app.html                                   (browser: decision cards, briefs)
     - brief.html                                 (public share page)
     - record.html                                (public track record of published briefs)
   tools/presentation/presentation_sync.test.js fails if the copies drift.
   The canonical source is supabase/functions/edgedesk_ai/_presentation.js.

   THE ONE RULE
     Nothing here computes, adjusts or overrides a probability, fair price,
     edge, EV, CLV, confidence, score, max-playable, break-even or verdict.
     Every one of those arrives from EdgeDesk's deterministic engine and is
     TRANSLATED into sportsbook language. The American-odds conversion is
     display-only and is never fed back into anything.

     AI copy (headline / why / watch / change trigger / market read) is
     OPTIONAL and VALIDATED. When it is missing or rejected, the templated
     deterministic copy stands. Narration failure never takes the card down.
   ============================================================================ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDPRES = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = 1;
  var VERDICTS = ['BET', 'LEAN', 'WAIT', 'PASS'];
  var VERDICT_RANK = { BET: 0, LEAN: 1, WAIT: 2, PASS: 3 };
  /* Words publisher copy may never carry. Matched case-insensitively. */
  var HYPE = /\b(lock|locks|guaranteed?|guarantees|hammer|hammered|can'?t[- ]miss|cannot miss|free money|ai says|our algorithm guarantees|sure thing|slam[- ]dunk|mortal lock|no[- ]brainer|easy money|100% winner)\b/i;
  /* Words a sports fan cannot be expected to know, and which nothing on a
     public surface defines. AI copy carrying one of these is rejected and the
     deterministic plain-language sentence stands instead. These terms are
     welcome in FULL RESEARCH, which is a different layer with a different
     reader — this gate only guards the five-second view, the publisher brief
     and the share page. */
  var JARGON = /\b(de-?vig(?:ged|ging)?|vigorish|no-?vig|clv|closing[- ]line[- ]value|expected value|\bev\b|pinnacle|sharp(?:er)?[- ](?:market|book|books|fair|reference|money|side)|soft(?:er)? books?|fair (?:line|value|price|odds|probability)|max[- ]playable|market residual|consensus dispersion|liquidity|shin|kelly|overround|steam move|middling|arb(?:itrage)?)\b/i;

  /* ---------------------------------------------------------------- utils */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(v) { if (v == null || v === '') return null; var n = +v; return isFinite(n) ? n : null; }
  function isStr(s) { return typeof s === 'string'; }
  function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function sentence(s) {
    s = clean(s);
    if (!s) return '';
    s = s.charAt(0).toUpperCase() + s.slice(1);
    if (!/[.!?]$/.test(s)) s += '.';
    return s;
  }
  function normVerdict(v) {
    v = String(v == null ? '' : v).toUpperCase().trim();
    if (v === 'NO BET' || v === 'NO SIGNAL') return 'PASS';
    if (v === 'STRONG SIGNAL') return 'BET';
    return VERDICTS.indexOf(v) >= 0 ? v : null;
  }
  function toMs(t) {
    if (t == null || t === '') return null;
    if (typeof t === 'number') return isFinite(t) ? t : null;
    var ms = Date.parse(String(t));
    return isFinite(ms) ? ms : null;
  }

  /* ----------------------------------------------------------- odds (display) */
  /* Decimal -> American. DISPLAY ONLY. The result is never fed back into an
     edge, EV or fair-price calculation — the engine keeps its own numbers. */
  function decToAmerican(dec) {
    var d = num(dec);
    if (d == null || d <= 1) return null;
    return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
  }
  function fmtAmerican(am) {
    var a = num(am);
    if (a == null) return null;
    a = Math.round(a);
    return (a > 0 ? '+' : '') + a;
  }
  /* Sportsbook-native selection: "Texas Tech -3.5", "Over 47.5", "Chiefs ML". */
  function selectionLabel(market, selection, point) {
    var m = String(market == null ? '' : market).toLowerCase().trim();
    var s = clean(selection);
    if (!s) return null;
    var p = num(point);
    if (m === 'totals' || m === 'total') {
      var side = /^over/i.test(s) ? 'Over' : /^under/i.test(s) ? 'Under' : s;
      return p != null ? side + ' ' + p : side;
    }
    if (m === 'spreads' || m === 'spread') {
      if (p == null) return s;
      return s + ' ' + (p > 0 ? '+' : '') + p;
    }
    if (m === 'h2h' || m === 'ml' || m === 'moneyline') return /\bML$/.test(s) ? s : s + ' ML';
    return p != null ? s + ' ' + p : s;
  }
  function marketLabel(market) {
    var m = String(market == null ? '' : market).toLowerCase().trim();
    if (m === 'h2h' || m === 'ml' || m === 'moneyline') return 'Moneyline';
    if (m === 'spreads' || m === 'spread') return 'Spread';
    if (m === 'totals' || m === 'total') return 'Total';
    return market == null ? null : String(market);
  }

  /* --------------------------------------------------- language translation */
  /* Internal terminology -> what an intelligent sportsbook bettor would say.
     Applied ONLY to simple/publisher copy. Full Research keeps the precise
     terms. Longest phrases first so "sharp fair" is not half-replaced. */
  var TERMS = [
    ['pinnacle de-vig fair', 'the sharper market’s fair line'],
    ['pinnacle (sharp reference)', 'the sharper market'],
    ['sharp reference', 'sharper market'],
    ['sharp-confirmed', 'confirmed by the sharper market'],
    ['sharp confirmation', 'confirmation from the sharper market'],
    ['sharp fair', 'sharper market fair line'],
    ['sharp print', 'quote from the sharper market'],
    ['consensus fair', 'the average fair line across books'],
    ['max-playable', 'good to'],
    ['max playable', 'good to'],
    ['market residual', 'the move beyond what the opening difference normally explains'],
    ['data integrity warning', 'some of the underlying data needs verification'],
    ['evidence integrity', 'data check'],
    ['calibration', 'how similar EdgeDesk signals have held up'],
    ['market edge', 'the current price is better than the sharper market suggests'],
    ['closing line value', 'closing line value'],
    ['de-vigged', 'fair'],
    ['de-vig', 'fair'],
    ['falsifier', 'what would break the case'],
    ['thesis', 'case'],
    ['pinnacle', 'the sharper market'],
    ['clv', 'closing line value'],
    ['ev', 'expected value']
  ];
  function translate(term) {
    var t = clean(term).toLowerCase();
    for (var i = 0; i < TERMS.length; i++) if (TERMS[i][0] === t) return TERMS[i][1];
    return term;
  }
  /* TERMS translates internal -> BETTOR. That is the right altitude for Full
     Research and the wrong one for a fan, so PUBLIC_TERMS is a second pass
     applied only on public surfaces: it takes the bettor wording TERMS
     produced and says the same thing without assuming the vocabulary.
     Longest phrases first, same as TERMS. */
  var PUBLIC_TERMS = [
    ['the sharper market’s fair line', 'EdgeDesk’s comparison price'],
    ['sharper market fair line', 'EdgeDesk’s comparison price'],
    ['the average fair line across books', 'the average price across sportsbooks'],
    ['the current price is better than the sharper market suggests', 'the price on offer is better than the rest of the market suggests'],
    ['confirmation from the sharper market', 'a check against EdgeDesk’s benchmark sportsbook'],
    ['confirmed by the sharper market', 'checked against EdgeDesk’s benchmark sportsbook'],
    ['quote from the sharper market', 'the price at EdgeDesk’s benchmark sportsbook'],
    ['the sharper market', 'EdgeDesk’s benchmark sportsbook'],
    ['sharper market', 'EdgeDesk’s benchmark sportsbook'],
    ['closing line value', 'how the price compared with the market’s final number'],
    ['expected value', 'the long-run value in the price'],
    ['sharp level', 'level of agreement'],
    ['fair probability', 'comparison chance'],
    ['fair line', 'comparison price'],
    ['fair price', 'comparison price'],
    ['fair odds', 'comparison price'],
    ['fair value', 'comparison price'],
    ['good to', 'the price limit'],
    ['liquidity', 'money actually available at that price'],
    ['break-even', 'the price where the bet stops being worth it'],
    ['breakeven', 'the price where the bet stops being worth it']
  ];
  function subst(s, table) {
    for (var i = 0; i < table.length; i++) {
      var from = table[i][0], to = table[i][1];
      var re = new RegExp('(^|[^a-z0-9])' + from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=$|[^a-z0-9])', 'gi');
      s = s.replace(re, function (m, pre) { return pre + to; });
    }
    return s;
  }
  /* The public path: bettor translation, then fan translation. */
  function publicText(text) {
    var s = clean(text);
    if (!s) return s;
    return subst(subst(s, TERMS), PUBLIC_TERMS);
  }
  function translateText(text) {
    var s = clean(text);
    if (!s) return s;
    for (var i = 0; i < TERMS.length; i++) {
      var from = TERMS[i][0], to = TERMS[i][1];
      var re = new RegExp('(^|[^a-z0-9])' + from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=$|[^a-z0-9])', 'gi');
      s = s.replace(re, function (m, pre) { return pre + to; });
    }
    return s;
  }

  /* Engine reasons are precise strings; each known shape gets a plain
     sentence. Unknown ones fall through the dictionary. */
  var REASON_MAP = [
    [/^([+-]?[\d.]+%) estimated edge vs (.+)$/i, function (m) { return 'The price on offer is ' + m[1].replace(/^\+/, '') + ' better than EdgeDesk’s comparison price for the same bet.'; }],
    [/pinnacle \(sharp reference\) is quoting this side/i, 'The sportsbook EdgeDesk uses as its benchmark is posting a price on this exact bet, so the comparison is against a live number rather than an estimate.'],
    [/best price is at a us-regulated book/i, 'The best price is at a US-regulated book.'],
    [/^(\d+) books? behind the fair line$/i, function (m) { return m[1] + ' sportsbooks were quoting this game when EdgeDesk looked, so the comparison is not resting on one unusual book.'; }],
    [/corroborated across (\d+) sharp level/i, function (m) { return 'Other sportsbooks are pricing this the same way rather than one book sitting alone.'; }],
    [/beat the close \(clv ([^)]+)\)/i, function (m) { return 'EdgeDesk flagged this at a better price than the market finished at before kickoff.'; }],
    [/best price is offshore/i, 'The best price is at an offshore sportsbook, which is harder to reach and less protected than a US-licensed one.'],
    [/only (\d+) books? quot/i, function (m) { return 'Only ' + m[1] + ' sportsbook' + (m[1] === '1' ? ' was' : 's were') + ' quoting this bet, so the comparison rests on very little.'; }],
    [/priced (\d+)m ago .*verify/i, function (m) { return 'EdgeDesk last saw this price ' + m[1] + ' minutes ago. Check the sportsbook is still showing it.'; }],
    [/stale: last re-priced (\d+)m ago/i, function (m) { return 'EdgeDesk last saw this price ' + m[1] + ' minutes ago. Odds move quickly, so the real number may be worse by now.'; }],
    [/edge this large on a game line is often a stale/i, 'A gap this big is usually a price that is out of date or simply wrong, not a gift. It normally disappears the moment the sportsbook notices.'],
    [/over half the detection edge has already decayed \((\d+)% remains\)/i, function (m) { return 'Most of the gap EdgeDesk originally spotted has already closed. About ' + m[1] + '% of it is left.'; }],
    [/no sharp \(pinnacle\) confirmation on this exact side/i, 'EdgeDesk’s benchmark sportsbook is not posting a price on this exact bet, so the comparison had to be built from the other sportsbooks. That is a weaker check.'],
    [/failed to beat the close \(clv ([^)]+)\)/i, function (m) { return 'The market finished at a better price than the one EdgeDesk flagged, so the number moved the wrong way.'; }],
    [/mlb caveat: lineups are probable/i, 'Lineups here are expected, not confirmed. One late change moves the price.'],
    [/price keeps moving against you: (\d+)% .* past (\S+) the ev/i, function (m) { return 'The value lives in the price. Past ' + m[2] + ' there is nothing left to buy.'; }],
    [/pinnacle never prints this side/i, 'EdgeDesk’s benchmark sportsbook never posts a price on this bet, so the comparison rests entirely on the other sportsbooks.'],
    [/the last capture \((\d+)m ago\) is stale/i, function (m) { return 'EdgeDesk last saw this price ' + m[1] + ' minutes ago, and the real number may be worse by now.'; }],
    [/offshore best price is not actually available/i, 'The offshore price may not really be available to you, or not for much money.'],
    [/edge this large is usually a bad or stale line/i, 'A gap this big is usually a bad or out-of-date price, not a gift. One correction erases it.'],
    [/late scratch or lineup change moves the number/i, 'A late scratch or lineup change would move the price.'],
    [/already failed to beat the close/i, 'The market already moved past this number before kickoff.'],
    [/nothing structural stands out/i, 'Nothing structural stands out against it, which is a reason to treat it normally rather than press.'],
    [/the edge existed at detection \(([^)]+)\) but the current price has moved to ([^,]+), pulling ev below the ([\d.]+%) floor/i,
      function (m) { return 'There was something here at ' + m[1] + ', but the price has moved to ' + m[2] + ' and there is no longer enough in it.'; }],
    [/current price is below fair/i, 'The price on offer is worse than EdgeDesk’s comparison price, so there is nothing to take here.'],
    [/no fair price available to judge this number against/i, 'EdgeDesk has no comparison price on file for this bet, so there is nothing to judge the number against.'],
    [/best price is offshore and only (\d+) books?/i, function (m) { return 'The best price is offshore and only ' + m[1] + ' sportsbook' + (m[1] === '1' ? ' was' : 's were') + ' quoting this bet. That is too thin to trust.'; }],
    [/last re-priced (\d+)m ago\. treat as stale/i, function (m) { return 'EdgeDesk last saw this price ' + m[1] + ' minutes ago. It needs a fresh check at the sportsbook.'; }],
    [/clears the bar with real liquidity: ([+-]?[\d.]+%)/i, function (m) { return 'The price on offer is ' + m[1].replace(/^\+/, '') + ' better than EdgeDesk’s comparison price, at a US-licensed sportsbook.'; }],
    [/positive and qualifying, but with caveats/i, 'The number clears EdgeDesk’s bar, but with caveats worth reading before acting.'],
    [/no fair price is on file yet/i, 'EdgeDesk has no comparison price on file for this bet yet, so there is nothing to judge the number against.'],
    [/qualified on the last number, but it was captured (\d+)m ago/i, function (m) { return 'The price qualified when EdgeDesk last saw it, but that was ' + m[1] + ' minutes ago. A fresh check has to show it is still there.'; }],
    [/a probable starter is still missing/i, 'A probable starter is still missing for this game, and the starter is the single biggest input in the number.']
  ];
  function plainReason(s) {
    var t = clean(s);
    if (!t) return '';
    for (var i = 0; i < REASON_MAP.length; i++) {
      var m = t.match(REASON_MAP[i][0]);
      if (m) { var out = REASON_MAP[i][1]; return typeof out === 'function' ? out(m) : out; }
    }
    return sentence(publicText(t.replace(/\s+[—-]\s+/g, '. ')));
  }

  /* --------------------------------------------------------------- freshness */
  function ageText(min) {
    if (min == null || !isFinite(min)) return null;
    if (min < 1) return 'just now';
    if (min < 60) return Math.round(min) + ' min ago';
    var h = min / 60;
    if (h < 24) return (h < 10 ? (Math.round(h * 10) / 10).toString().replace(/\.0$/, '') : Math.round(h)) + ' h ago';
    return Math.round(h / 24) + ' d ago';
  }
  /* o: { price_at, research_at, now, stale_min (the engine's own limit) } */
  function freshness(o) {
    o = o || {};
    var now = toMs(o.now) != null ? toMs(o.now) : Date.now();
    var limit = num(o.stale_min) != null && num(o.stale_min) > 0 ? num(o.stale_min) : 90;
    var pAt = toMs(o.price_at), rAt = toMs(o.research_at);
    var pAge = pAt != null ? Math.max(0, (now - pAt) / 60000) : (num(o.price_age_min));
    var rAge = rAt != null ? Math.max(0, (now - rAt) / 60000) : (num(o.research_age_min));
    var status = pAge == null ? 'UNKNOWN' : pAge >= limit ? 'STALE' : pAge >= limit / 2 ? 'AGING' : 'CURRENT';
    var warning = status === 'STALE' ? 'This price needs refreshing before it can be used.'
      : status === 'UNKNOWN' ? 'EdgeDesk cannot tell how old this price is.'
      : status === 'AGING' ? 'This price is getting old. Check it is still live.' : null;
    return {
      status: status,
      price_age_min: pAge == null ? null : Math.round(pAge * 10) / 10,
      research_age_min: rAge == null ? null : Math.round(rAge * 10) / 10,
      price_text: pAge == null ? 'Price age unknown' : 'Price updated ' + ageText(pAge),
      research_text: rAge == null ? null : 'Research refreshed ' + ageText(rAge),
      price_captured_at: pAt != null ? new Date(pAt).toISOString() : null,
      limit_min: limit,
      warning: warning
    };
  }

  /* ---------------------------------------------------------------- playable */
  /* The playable threshold is a PRICE the engine owns (max_playable). It is
     never a line threshold, because the engine owns none. */
  function playable(o) {
    o = o || {};
    var v = normVerdict(o.verdict);
    var maxAm = num(o.max_playable_am), needs = num(o.needs_price_am);
    var lim = fmtAmerican(maxAm);
    if (maxAm == null) {
      return { kind: 'NONE', label: null, limit_odds: null,
        text: 'EdgeDesk has no fair price on file, so there is no playable limit yet.' };
    }
    if (v === 'PASS' && needs != null) {
      return { kind: 'NEEDS', label: 'Needs ' + fmtAmerican(needs) + ' or better', limit_odds: fmtAmerican(needs),
        text: 'The current price is past EdgeDesk’s limit. It only becomes a bet again at ' + fmtAmerican(needs) + ' or better.' };
    }
    if (v === 'PASS') {
      return { kind: 'LIMIT', label: 'Limit ' + lim, limit_odds: lim,
        text: 'EdgeDesk’s limit for this number is ' + lim + '. The current price does not qualify.' };
    }
    return { kind: 'GOOD_TO', label: 'Good to ' + lim, limit_odds: lim,
      text: 'EdgeDesk still likes this at ' + lim + '. Past that number the edge is no longer strong enough.' };
  }

  /* ------------------------------------------------------------ price status */
  function priceStatus(o) {
    o = o || {};
    var v = normVerdict(o.verdict);
    var det = num(o.detect_am), cur = num(o.current_am), maxAm = num(o.max_playable_am);
    var edge = num(o.edge), dEdge = num(o.detect_edge), floor = num(o.floor);
    var fr = o.freshness || {};
    if (cur == null) {
      return { kind: 'NO_PRICE', text: 'No current price is on file for this selection.', was: null, now: null };
    }
    var moved = det != null && det !== cur;
    if (v === 'PASS' && dEdge != null && floor != null && dEdge >= floor && edge != null && edge < floor) {
      return { kind: 'PAST_LIMIT', was: 'PLAYABLE', now: 'PASS',
        text: 'Was playable at ' + fmtAmerican(det) + '. Now PASS: the price moved to ' + fmtAmerican(cur) + '.'
          + (maxAm != null ? ' EdgeDesk’s limit was ' + fmtAmerican(maxAm) + '.' : '') };
    }
    if (fr.status === 'STALE') {
      return { kind: 'STALE', text: 'This price needs refreshing before it can be used.', was: null, now: null };
    }
    if (moved) {
      var inside = maxAm != null && v !== 'PASS';
      return { kind: 'MOVED', was: fmtAmerican(det), now: fmtAmerican(cur),
        text: 'Price moved from ' + fmtAmerican(det) + ' to ' + fmtAmerican(cur) + ' since EdgeDesk first flagged it.'
          + (inside ? ' Still inside the limit of ' + fmtAmerican(maxAm) + '.' : '') };
    }
    return { kind: 'HOLDING', was: null, now: fmtAmerican(cur), text: 'The price has held since EdgeDesk flagged it.' };
  }

  /* ---------------------------------------------------------------- integrity */
  function integrityStatus(g) {
    if (!g || !g.verdict) return { status: 'OK', reason: null, reason_plain: null, known: false };
    var v = String(g.verdict).toUpperCase();
    var failed = (g.failed || g.checks || []).filter(function (c) { return c && c.status && String(c.status).toUpperCase() !== 'PASS'; });
    var first = failed[0];
    var reason = first ? (String(first.name || '').replace(/_/g, ' ') + ': ' + clean(first.detail)) : (g.summary || g.headline || null);
    if (reason) reason = publicText(String(reason).slice(0, 260));
    /* The chip may carry the check's own name. The sentence a reader gets does
       not: "identity_chain: two starters are…" is an engine slug glued to a
       fact, and only the fact means anything outside the engine. */
    var plain = first && clean(first.detail) ? publicText(clean(first.detail)).replace(/\.\s*$/, '') : null;
    if (v === 'FAIL') return { status: 'FAILED', reason: reason || 'a data check failed', reason_plain: plain || 'a check on its own data failed', known: true };
    if (v === 'WARNING' || v === 'LOCALIZED') return { status: 'PROVISIONAL', reason: reason || 'some of the underlying data needs verification', reason_plain: plain || 'some of the data behind this needs checking', known: true };
    return { status: 'OK', reason: null, reason_plain: null, known: true };
  }

  /* Availability / data gaps. A missing injury report is NOT "no injuries". */
  function gapSentences(gaps) {
    var out = [];
    (gaps || []).forEach(function (g) {
      var k = String(g && (g.field || g) || '').toLowerCase();
      if (!k) return;
      if (/injur|availab|lineup/.test(k)) out.push('Injury and availability data is not on file. Do not read that as a clean injury report.');
      else if (/weather/.test(k)) out.push('Weather is not on file for this game.');
      else if (/quarterback|qb/.test(k)) out.push('The starting quarterback is not confirmed in EdgeDesk’s data.');
      else if (/starter|pitch/.test(k)) out.push('A probable starter is missing from EdgeDesk’s data.');
      else out.push(publicText(k.replace(/_/g, ' ')) + ' is not on file.');
    });
    var seen = {}, uniq = [];
    out.forEach(function (s) { if (!seen[s]) { seen[s] = 1; uniq.push(s); } });
    return uniq;
  }

  /* ----------------------------------------------------------- availability */
  /* WHO IS PLAYING, and how well EdgeDesk actually knows it.

     Two leagues feed this through ONE shape. The NFL files an official injury
     report and EdgeDesk reads it. College football has no universal report, so
     EdgeDesk builds its own availability layer out of public evidence and
     carries the evidence with it: the source, its confidence, how fresh it is,
     and how much of the field it covers.

     The shape (built by the app, never by this file):
       { status:'ON_FILE'|'NOT_PUBLISHED', source, week, coverage?,
         teams:{ away:{ name, code, filed, dataQuality?, sources_checked?,
                        sources_failed?, official_report_found?, lastUpdated?,
                        players:[{ name, position, status, injury, practice,
                                   confidence?, impact?, source_name?,
                                   source_url?, verified?, contested?,
                                   freshness?, timeline?, observations? }] },
                 home:{ ... } } }

     THE DISTINCTION THIS FILE PROTECTS: "nobody is listed on an official
     report", "EdgeDesk has partial coverage" and "EdgeDesk has no verified
     data" are three different sentences. They are never collapsed, and none of
     them is ever written as "no injuries". */
  var STATUS_RANK = { out: 4, doubtful: 3, game_time_decision: 3, questionable: 2, day_to_day: 2, limited: 1 };
  var STATUS_WORD = { out: 'out', doubtful: 'doubtful', questionable: 'questionable', game_time_decision: 'a game-time decision',
    day_to_day: 'day to day', limited: 'limited', probable: 'probable', expected: 'expected to play', available: 'available' };
  function normTeamName(s) { return normTeam(s); }
  function statusKey(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z]+/g, '_'); }
  function statusWord(s) { var k = statusKey(s); return STATUS_RANK[k] ? k : null; }
  function statusLabel(s) { var k = statusKey(s); return STATUS_WORD[k] || (k ? k.replace(/_/g, ' ') : null); }
  var QUALITY_COPY = {
    STRONG: 'Strong', PARTIAL: 'Partial', LIMITED: 'Limited', NONE: 'None'
  };
  function sideCoverage(tm) {
    if (!tm) return null;
    var q = tm.dataQuality || null;
    if (!q) return null;
    return { quality: q, label: QUALITY_COPY[q] || q, sources_checked: num(tm.sources_checked), sources_failed: num(tm.sources_failed),
      official: !!tm.official_report_found, last_updated: tm.lastUpdated || null };
  }
  /* The one sentence that says how much EdgeDesk knows, for the whole game. */
  function coverageText(av, sides) {
    if (!av) return null;
    if (av.status === 'NOT_PUBLISHED') return 'No verified availability information found' + (av.reason ? ': ' + av.reason : '') + '.';
    var qs = sides.map(function (s) { return s && s.coverage ? s.coverage.quality : null; }).filter(Boolean);
    if (!qs.length) return null;
    var rank = { STRONG: 4, PARTIAL: 3, LIMITED: 2, NONE: 1 };
    var worst = qs.reduce(function (m, q) { return rank[q] < rank[m] ? q : m; }, qs[0]);
    var official = sides.filter(function (s) { return s && s.coverage && s.coverage.official; }).length;
    var checked = sides.reduce(function (n, s) { return n + ((s && s.coverage && s.coverage.sources_checked) || 0); }, 0);
    if (worst === 'NONE') return 'No verified availability information found for this matchup.';
    if (worst === 'LIMITED') return 'Availability coverage: Limited. EdgeDesk checked ' + checked + ' source' + (checked === 1 ? '' : 's') + ' and found no verified availability information for one side. That is not the same as nobody being hurt.';
    if (worst === 'PARTIAL') return 'Availability coverage: Partial. EdgeDesk found verified information for some players, but college football does not have a universal injury-reporting system.';
    return 'Availability coverage: Strong' + (official ? ' · ' + official + ' official source' + (official === 1 ? '' : 's') : '') + '.';
  }
  function availabilitySummary(av) {
    if (!av || av.status !== 'ON_FILE' || !av.teams) return null;
    var sides = [], listed = [], highImpact = [], worst = 0, anyOfficial = false;
    ['away', 'home'].forEach(function (k) {
      var tm = av.teams[k]; if (!tm) return;
      var cov = sideCoverage(tm);
      if (cov && cov.official) anyOfficial = true;
      var ps = (tm.players || []).filter(function (p) { return statusWord(p.status); });
      var counts = { out: 0, doubtful: 0, questionable: 0, other: 0 };
      ps.forEach(function (p) {
        var w = statusWord(p.status);
        if (counts[w] != null) counts[w]++; else counts.other++;
        worst = Math.max(worst, STATUS_RANK[w] || 0);
        var row = { side: k, team: tm.name || tm.code, name: p.name, position: p.position || null, status: w,
          label: statusLabel(p.status), injury: p.injury || null, practice: p.practice || null,
          confidence: p.confidence || null, impact: p.impact || null, source_name: p.source_name || null,
          source_url: p.source_url || null, verified: p.verified == null ? null : !!p.verified,
          contested: !!p.contested, freshness: p.freshness || null,
          timeline: (p.timeline || []).filter(function (x) { return x && x.day && x.practice_status; }),
          observations: p.observations || [] };
        listed.push(row);
        if (String(p.impact || '').toUpperCase() === 'HIGH') highImpact.push(row);
      });
      var bits = [];
      if (counts.out) bits.push(counts.out + ' out');
      if (counts.doubtful) bits.push(counts.doubtful + ' doubtful');
      if (counts.questionable) bits.push(counts.questionable + ' questionable');
      if (counts.other) bits.push(counts.other + ' listed');
      var label = (tm.code || tm.name || '');
      /* Three different sentences, kept apart on purpose. */
      var say;
      if (tm.filed === false) say = 'no report filed yet';
      else if (bits.length) say = bits.join(', ');
      else if (cov && cov.official) say = 'nobody listed on the official report';
      else if (cov && (cov.quality === 'LIMITED' || cov.quality === 'NONE')) say = 'no verified information found';
      else say = 'nobody listed';
      sides.push({ key: k, label: label, text: label + ': ' + say, coverage: cov, counts: counts, filed: tm.filed !== false, name: tm.name || tm.code || '' });
    });
    listed.sort(function (a, b) {
      var ia = a.impact === 'HIGH' ? 2 : a.impact === 'MEDIUM' ? 1 : 0, ib = b.impact === 'HIGH' ? 2 : b.impact === 'MEDIUM' ? 1 : 0;
      if (ia !== ib) return ib - ia;
      return (STATUS_RANK[b.status] || 0) - (STATUS_RANK[a.status] || 0) || String(a.name).localeCompare(String(b.name));
    });
    var cov = coverageText(av, sides);
    return { text: 'Injury report on file (' + (av.source || 'league report') + (av.week ? ', week ' + av.week : '') + '): ' + sides.map(function (s) { return s.text; }).join(' · '),
      sides: sides, listed: listed, high_impact: highImpact, worst: worst, coverage_text: cov, official: anyOfficial,
      last_updated: sides.reduce(function (m, s) { var t2 = s.coverage && s.coverage.last_updated; return (t2 && (!m || String(t2) > String(m))) ? t2 : m; }, null) };
  }
  /* One player, in plain words. Never more than the source said. */
  function playerLine(p) {
    var label = p.label || statusLabel(p.status) || 'on the report';
    var verb = /^(a |the )/.test(label) ? ' is ' : ' is ';
    return p.name + (p.position ? ' (' + p.position + ')' : '') + verb + label
      + (p.injury ? ', ' + String(p.injury).toLowerCase() : '')
      + (p.practice && /did not/i.test(p.practice) ? ', did not practice' : p.practice && /limited/i.test(p.practice) ? ', limited in practice' : '')
      + '.';
  }
  /* The practice trail, only for days a source actually reported. */
  function timelineText(p) {
    if (!p || !p.timeline || !p.timeline.length) return null;
    return p.timeline.map(function (x) { return x.day + ' ' + String(x.practice_status).toLowerCase().replace('dnp', 'did not practice'); }).join(' · ');
  }
  /* How long ago a timestamp was, in the card's own words. */
  function agoText(at) { var ms = toMs(at); if (ms == null) return null; return ageText((Date.now() - ms) / 60000); }
  /* Provenance, for the receipt. */
  function sourceText(p) {
    if (!p) return null;
    var bits = [];
    if (p.source_name) bits.push(p.source_name);
    if (p.confidence) bits.push(String(p.confidence).toLowerCase());
    if (p.freshness && p.freshness !== 'LIVE' && p.freshness !== 'CURRENT') bits.push(String(p.freshness).toLowerCase());
    return bits.length ? bits.join(' · ') : null;
  }

  /* ============================== THE PUBLIC LANGUAGE LAYER ==============================
     LEVEL 1 (decision) and LEVEL 2 (why) copy, for a person who has never
     heard of de-vigging, fair lines, EV, CLV or a sharp book.

     THE RULE HERE IS THE RULE EVERYWHERE: nothing below computes, adjusts or
     overrides a probability, fair price, edge, verdict or threshold. Every
     number arrives from the engine. What changes is only how it is SAID.

     Two things this layer refuses to do, because the engine does not own them:
       · It never states a fair SPREAD or a fair TOTAL. EdgeDesk owns a fair
         PRICE on the line the book is offering, not a line of its own, so a
         spread card compares PRICES on that spread and says so.
       · It never turns a price into a chance of winning. A long price is
         described as "a payout a book posts on a result it sees as unlikely",
         never as a probability, so the card can never be read as a forecast.
     ====================================================================================== */

  /* Each analytical concept, once, with the words the public surfaces use.
     `short` is the label; `simple` is the sentence behind the ⓘ; `guard` is
     the misconception it has to stop. Nothing here is auto-inserted into copy:
     the copy builders below reference these deliberately. */
  var CONCEPTS = {
    edgedesk_comparison: {
      internal_name: 'sharp_fair / fair price',
      short: 'EdgeDesk comparison',
      simple: 'EdgeDesk’s estimate of what this bet should pay, once the sportsbook’s built-in cut is taken out of the prices on the board.',
      detail: 'Every sportsbook price includes a margin for the house. EdgeDesk strips that out across the books quoting the game and lands on one comparison number.',
      guard: 'It is an estimate of a price, not a prediction of who wins.',
      example: 'The book offers +1400. EdgeDesk’s comparison is about +1237. The book is paying more than EdgeDesk expected.'
    },
    benchmark_book: {
      internal_name: 'sharp reference (Pinnacle)',
      short: 'Benchmark sportsbook',
      simple: 'One sportsbook EdgeDesk treats as a reality check, because its prices move quickly when informed money shows up.',
      detail: 'When that book is posting a price on the exact bet, EdgeDesk has a live number to compare against. When it is not, the comparison is built from the other books, which is a weaker check.',
      guard: 'It does not mean that book is right. It means it is the toughest single number to disagree with.'
    },
    price_limit: {
      internal_name: 'max_playable',
      short: 'Price limit',
      simple: 'The worst price at which EdgeDesk still sees enough value. Past it, the same bet is no longer worth it.',
      detail: 'The bet and the price are one thing. Change the price and the answer changes, with nothing else about the game moving.',
      guard: 'It is not a prediction of where the price will go.'
    },
    book_count: {
      internal_name: 'n_books',
      short: 'Books quoting it',
      simple: 'How many sportsbooks were posting a price on this bet when EdgeDesk looked.',
      detail: 'More books means the comparison rests on a crowd rather than on one book with a slow or unusual number.',
      guard: 'It does not mean those books agree with EdgeDesk.'
    },
    beat_the_close: {
      internal_name: 'CLV / closing line value',
      short: 'Price vs the final number',
      simple: 'Whether the price EdgeDesk flagged was better than the price the market settled on right before kickoff.',
      detail: 'Over many calls this is the only honest scoreboard for a research tool: winning one bet can be luck, consistently buying a better number than the market closes at cannot.',
      guard: 'It says nothing about whether that particular bet won.'
    },
    verdict: {
      internal_name: 'display_verdict',
      short: 'The call',
      simple: 'EdgeDesk’s answer on the bet AND the price together: BET, LEAN, WAIT or PASS.',
      detail: 'BET and LEAN mean the price clears the bar. WAIT means something is missing or out of date. PASS means EdgeDesk looked and does not see enough at this price.',
      guard: 'It is a judgement about the price, never a prediction of the result.'
    },
    data_check: {
      internal_name: 'evidence integrity',
      short: 'Data check',
      simple: 'EdgeDesk checking its own inputs before it says anything. If the check fails, no call is published.',
      guard: 'A failed check is not a bad bet. It is EdgeDesk refusing to answer.'
    },
    price_age: {
      internal_name: 'freshness / stale_min',
      short: 'Price age',
      simple: 'When EdgeDesk last saw this price at the sportsbook. Odds move, so an old price may not be there any more.',
      guard: 'An old price is not a wrong price. It is an unconfirmed one.'
    }
  };
  function concept(k) { return CONCEPTS[k] || null; }

  /* What a score is called in this sport. */
  function scoreUnit(sportKey) {
    var k = String(sportKey == null ? '' : sportKey).toLowerCase();
    if (k.indexOf('baseball') === 0) return 'runs';
    if (k.indexOf('icehockey') === 0 || k.indexOf('soccer') === 0) return 'goals';
    return 'points';
  }
  /* Which price pays better. Decimal comparison, so it works across the
     +100 / -100 boundary. DISPLAY ONLY — never fed back into anything. */
  function betterOf(aAm, bAm) {
    var a = americanToDec(aAm), b = americanToDec(bAm);
    if (a == null || b == null) return null;
    if (Math.abs(a - b) < 1e-9) return 0;
    return a > b ? 1 : -1;
  }
  /* The payout, in dollars, straight off the price. Nothing is estimated. */
  function payoutLine(am) {
    var a = num(am);
    if (a == null || a === 0) return null;
    if (a > 0) return 'A $100 bet returns $' + Math.round(a).toLocaleString('en-US') + ' in profit if it wins.';
    return 'You risk $' + Math.round(-a).toLocaleString('en-US') + ' to win $100.';
  }
  /* Which way "better" runs at this price, said once so nobody has to know. */
  function betterHint(am) {
    var a = parseAmerican(am);
    if (a == null) return null;
    return a > 0 ? '“Better” here means a bigger payout — a higher + number.'
                 : '“Better” here means a cheaper price — a − number closer to zero.';
  }

  /* -------- WHAT THE BET ACTUALLY IS, in the words a fan already owns ------ */
  /* o: { market_key, selection_raw, point, home, away, sport_key }
     Short enough to be a headline. The tie/push rule is real and a beginner
     needs it, but it is a footnote, not the sentence — see pushNote(). */
  function betLine(o) {
    o = o || {};
    var m = String(o.market_key == null ? '' : o.market_key).toLowerCase().trim();
    var team = clean(o.selection_raw || '');
    var p = num(o.point);
    var unit = scoreUnit(o.sport_key);
    if (m === 'totals' || m === 'total') {
      if (p == null) return null;
      return (/^over/i.test(team) ? 'More than ' : 'Fewer than ') + p + ' total ' + unit + ', both teams combined';
    }
    if (!team) return null;
    var side = (o.home || o.away) ? sideOf(team, o.home, o.away) : null;
    var opp = side === 'home' ? o.away : side === 'away' ? o.home : null;
    if (m === 'spreads' || m === 'spread') {
      if (p == null) return team + ' with the points';
      if (Math.abs(p) < 1e-9) return team + ' to win outright';
      var whole = Math.abs(p % 1) < 1e-9;
      if (p < 0) {
        var need = Math.abs(p);
        return whole ? team + ' to win by more than ' + need + ' ' + unit
                     : team + ' to win by ' + Math.ceil(need) + ' ' + unit + ' or more';
      }
      return whole ? team + ' to lose by fewer than ' + p + ' ' + unit + ', or win outright'
                   : team + ' to lose by ' + Math.floor(p) + ' ' + unit + ' or fewer, or win outright';
    }
    if (m === 'h2h' || m === 'ml' || m === 'moneyline') return opp ? team + ' to beat ' + opp : team + ' to win';
    return p != null ? team + ' ' + (p > 0 ? '+' : '') + p : team;
  }
  /* The one rule nobody explains to a first-time bettor: a whole-number line
     can land exactly, and the stake comes back. Only ever said when it can
     actually happen. */
  function pushNote(o) {
    o = o || {};
    var m = String(o.market_key == null ? '' : o.market_key).toLowerCase().trim();
    var p = num(o.point);
    var unit = scoreUnit(o.sport_key);
    if (p == null) return null;
    var whole = Math.abs(p % 1) < 1e-9;
    if (m === 'totals' || m === 'total') return whole ? 'If the combined score lands on exactly ' + p + ', the bet is refunded.' : null;
    if (m === 'spreads' || m === 'spread') {
      if (Math.abs(p) < 1e-9) return 'If the game ends level, the bet is refunded.';
      return whole ? 'If the game is decided by exactly ' + Math.abs(p) + ' ' + unit + ', the bet is refunded.' : null;
    }
    return null;
  }
  /* The line to look for at the sportsbook, exactly as it is printed there. */
  function ticketLine(o) {
    o = o || {};
    var mk = marketLabel(o.market_key);
    var sel = selectionLabel(o.market_key, o.selection_raw, o.point);
    if (/^(h2h|ml|moneyline)$/i.test(String(o.market_key || '')) && sel) sel = sel.replace(/\s+ML$/, '');
    if (!mk && !sel) return null;
    return [mk, sel].filter(Boolean).join(' · ');
  }

  /* --------------- WHAT EDGEDESK FOUND: two prices, side by side ---------- */
  /* Only prices are compared, because only a price is owned. On a spread or a
     total the LINE is the sportsbook's and EdgeDesk never proposes its own. */
  function priceCompare(o) {
    o = o || {};
    var cur = parseAmerican(o.current_am), fair = parseAmerican(o.fair_am);
    var bet = o.bet_line || null;
    var edgePct = num(o.edge) != null ? Math.round(num(o.edge) * 1000) / 10 : null;
    if (cur == null) {
      return { have: false, rows: [], sentence: 'No live price is on file for this bet, so there is nothing to compare yet.', detail: null, direction: null };
    }
    var curS = fmtAmerican(cur);
    if (fair == null) {
      return { have: false, direction: null,
        rows: [{ k: 'Your sportsbook', v: curS, note: o.book || null }, { k: 'EdgeDesk comparison', v: 'Not on file', note: null }],
        sentence: 'The price on offer is ' + curS + '. EdgeDesk has no comparison price on file for this bet, so it cannot say whether that is generous or not.',
        detail: null };
    }
    var fairS = fmtAmerican(fair);
    var dir = betterOf(cur, fair);
    var plus = cur > 0;
    var move = dir === 1 ? (plus ? 'is paying more than EdgeDesk expected' : 'is charging less than EdgeDesk expected')
      : dir === -1 ? (plus ? 'is paying less than EdgeDesk expected' : 'is charging more than EdgeDesk expected')
      : 'matches what EdgeDesk expected';
    var diffWord = dir === 1 ? (plus ? 'Paying more than expected' : 'Costing less than expected')
      : dir === -1 ? (plus ? 'Paying less than expected' : 'Costing more than expected')
      : 'The same';
    return {
      have: true, direction: dir === 1 ? 'better' : dir === -1 ? 'worse' : 'same',
      rows: [
        { k: 'Your sportsbook', v: curS, note: o.book || null },
        { k: 'EdgeDesk comparison', v: 'about ' + fairS, note: null },
        { k: 'Difference', v: diffWord, note: null }
      ],
      sentence: (bet ? bet + ' is available at ' + curS + '. ' : 'The price on offer is ' + curS + '. ')
        + 'EdgeDesk’s comparison price for the same bet is about ' + fairS + ', so this sportsbook ' + move + '.',
      detail: edgePct != null ? 'Measured difference: ' + (edgePct > 0 ? edgePct : Math.abs(edgePct)) + '%.' : null
    };
  }

  /* ----------------- THE GUARD: value is not a prediction ----------------- */
  /* Deterministic, from the price alone. A long payout must never be read as
     "EdgeDesk thinks the underdog wins", and a short one must never be read as
     "EdgeDesk thinks the favourite is a good bet". */
  var LONGSHOT_AM = 250;        /* a clear underdog on the moneyline */
  var HEAVY_LONGSHOT_AM = 700;  /* the +1400 shape */
  var LONGSHOT_OTHER_AM = 400;  /* a long price on a spread or a total */
  var HEAVY_FAVOURITE_AM = -250;
  function longShotGuard(o) {
    o = o || {};
    var am = parseAmerican(o.current_am);
    if (am == null) return null;
    var m = String(o.market_key == null ? '' : o.market_key).toLowerCase().trim();
    var ml = (m === 'h2h' || m === 'ml' || m === 'moneyline');
    var team = clean(o.team || '') || 'This side';
    var odds = fmtAmerican(am);
    if (ml && am >= LONGSHOT_AM) {
      var heavy = am >= HEAVY_LONGSHOT_AM;
      return { kind: heavy ? 'HEAVY_UNDERDOG' : 'UNDERDOG',
        text: team + ' is ' + (heavy ? 'a heavy' : 'a clear') + ' underdog here'
          + (o.opponent ? ' against ' + o.opponent : '') + '. EdgeDesk is judging the PRICE, not predicting an upset. '
          + 'A payout like ' + odds + ' is what a sportsbook posts on a result it sees as unlikely — EdgeDesk is only saying that payout looks larger than the rest of the market justifies.' };
    }
    if (!ml && am >= LONGSHOT_OTHER_AM) {
      return { kind: 'LONG_PRICE',
        text: 'This is a long-shot price. A payout like ' + odds + ' is what a sportsbook posts on a result it sees as unlikely. EdgeDesk is judging that payout, not predicting the outcome.' };
    }
    if (ml && am <= HEAVY_FAVOURITE_AM) {
      return { kind: 'FAVOURITE',
        text: team + ' is a strong favourite here, so the payout is small: at ' + odds + ' you risk $' + Math.round(-am) + ' to win $100. '
          + 'EdgeDesk is judging what that costs, not predicting the winner.' };
    }
    return null;
  }

  /* --------------------- THE VERDICT, in plain English -------------------- */
  var VERDICT_PLAIN = {
    BET: { subtitle: 'EdgeDesk likes the price on offer.' },
    LEAN: { subtitle: 'Worth a look, but the case is not strong enough to call it a bet.' },
    WAIT: { subtitle: 'There may be value here, but something still has to be confirmed.' },
    PASS: { subtitle: 'Not worth it at this price.' },
    FAILED: { subtitle: 'EdgeDesk does not trust its own data here, so it is not making a call.' },
    NONE: { subtitle: 'EdgeDesk has no call on file for this bet.' }
  };
  function verdictPlain(o) {
    o = o || {};
    var key = o.suppressed ? 'FAILED' : (VERDICT_PLAIN[o.verdict] ? o.verdict : 'NONE');
    var sub = VERDICT_PLAIN[key].subtitle;
    var label = key === 'FAILED' ? 'DATA CHECK FAILED' : key === 'NONE' ? 'NO CALL' : key;
    var answer;
    if (key === 'FAILED') answer = 'EdgeDesk will not make a call here until a problem with its own data is fixed.';
    else if (key === 'NONE') answer = 'EdgeDesk has nothing on file for this bet.';
    else if (o.no_price) answer = 'No live price on file yet, so there is nothing to judge.';
    else if (key === 'BET') answer = 'The price clears EdgeDesk’s bar right now.';
    else if (key === 'LEAN') answer = 'Something is here, but not enough to call it a bet.';
    else if (key === 'WAIT') answer = o.stale ? 'Interesting price. It needs a fresh check before EdgeDesk trusts it.' : 'Interesting price. Not confirmed yet.';
    else answer = o.needs_odds ? 'It would take ' + o.needs_odds + ' or better to be worth a look.' : 'EdgeDesk looked and does not see enough here.';
    return { key: key, label: label, subtitle: sub, answer: answer };
  }

  /* ---------------------- THE PRICE LIMIT, in plain English --------------- */
  function priceLimitPlain(play) {
    play = play || {};
    var lim = play.limit_odds || null;
    if (play.kind === 'NEEDS') {
      return { label: 'Price needed', value: lim + ' or better', limit_odds: lim, hint: betterHint(lim),
        sentence: 'At the price on offer now, EdgeDesk sees no value. It would take ' + lim + ' or better to change that.' };
    }
    if (play.kind === 'LIMIT') {
      return { label: 'Price limit', value: lim + ' or better', limit_odds: lim, hint: betterHint(lim),
        sentence: 'EdgeDesk’s limit for this bet is ' + lim + '. The price on offer is worse than that, so there is nothing to take.' };
    }
    if (play.kind === 'GOOD_TO') {
      return { label: 'Price limit', value: lim + ' or better', limit_odds: lim, hint: betterHint(lim),
        sentence: 'EdgeDesk still sees value down to ' + lim + '. Worse than that and the value is gone.' };
    }
    return { label: 'Price limit', value: 'Not set', limit_odds: null, hint: null,
      sentence: 'EdgeDesk has no comparison price on file for this bet, so there is no limit yet.' };
  }

  /* ------------------- THE MARKET CHECK, said as what it is --------------- */
  /* has_sharp: the benchmark book is posting a price on THIS EXACT side.
     n_books:   how many sportsbooks were quoting this market at capture.
     Neither is evidence about the teams, and neither is stated as such. */
  function marketCheckPlain(o) {
    o = o || {};
    var lines = [];
    if (o.has_sharp === true) lines.push('The sportsbook EdgeDesk uses as its benchmark is posting a price on this exact bet, so the comparison is against a live number rather than an estimate.');
    else if (o.has_sharp === false) lines.push('EdgeDesk’s benchmark sportsbook is not posting a price on this exact bet, so the comparison had to be built from the other sportsbooks. That is a weaker check.');
    var nb = num(o.n_books);
    if (nb != null) {
      if (nb >= 5) lines.push(nb + ' sportsbooks were quoting this game when EdgeDesk looked, so the comparison is not resting on one unusual book.');
      else if (nb >= 2) lines.push('Only ' + nb + ' sportsbooks were quoting this, which is a thin market. One odd price can pull the comparison around.');
      else if (nb === 1) lines.push('Only one sportsbook was quoting this, so there is nothing to compare it against.');
      else lines.push('No other sportsbook prices were on file for this bet.');
    }
    var ps = o.price_status || {};
    if (ps.kind === 'MOVED' && ps.was && ps.now) lines.push('The price has moved from ' + ps.was + ' to ' + ps.now + ' since EdgeDesk first flagged it.');
    else if (ps.kind === 'PAST_LIMIT') lines.push('The price has moved since EdgeDesk first looked' + (ps.was && ps.now ? ', from ' + ps.was + ' to ' + ps.now : '') + ', and it is now past the point where EdgeDesk sees value.');
    if (o.book && o.trusted === false) lines.push('The best price is at an offshore sportsbook, which is harder to reach and less protected than a US-licensed one.');
    return { lines: lines, text: lines.join(' ') || 'EdgeDesk has no market read on file for this bet.' };
  }

  /* --------------- ENGINE REASONS -> SEMANTIC FACTS -> SENTENCES ---------- */
  /* The engine decides WHICH reasons are true. This decides how each one is
     said, and says it from the packet's own numbers rather than by rewriting
     the engine's string. An unrecognised reason still falls through to
     plainReason(), so a new engine reason degrades to the old behaviour
     instead of disappearing. */
  var REASON_KINDS = [
    [/estimated edge vs/i, 'EDGE_VS_FAIR'],
    [/pinnacle \(sharp reference\) is quoting this side/i, 'SHARP_CONFIRMED'],
    [/best price is at a us-regulated book/i, 'REGULATED'],
    [/^\s*(\d+) books? behind the fair line\s*$/i, 'BOOK_COUNT'],
    [/corroborated across (\d+) sharp level/i, 'CORROBORATED'],
    [/(this signal )?beat the close \(clv/i, 'BEAT_CLOSE'],
    [/failed to beat the close/i, 'MISSED_CLOSE'],
    [/best price is offshore and only (\d+) books?/i, 'OFFSHORE_THIN'],
    [/offshore best price is not actually available/i, 'OFFSHORE_SIZE'],
    [/best price is offshore/i, 'OFFSHORE'],
    [/only (\d+) books? quot/i, 'THIN'],
    [/priced (\d+)m ago/i, 'AGING'],
    [/stale: last re-priced (\d+)m ago/i, 'STALE'],
    [/last re-priced (\d+)m ago\. treat as stale/i, 'STALE'],
    [/the last capture \((\d+)m ago\) is stale/i, 'STALE'],
    [/qualified on the last number, but it was captured (\d+)m ago/i, 'STALE_QUALIFIED'],
    [/edge this large/i, 'TOO_GOOD'],
    [/detection edge has already decayed \((\d+)% remains\)/i, 'DECAYED'],
    [/price keeps moving against you/i, 'PRICE_WINDOW'],
    [/pinnacle never prints this side/i, 'NO_SHARP'],
    [/no sharp \(pinnacle\) confirmation on this exact side/i, 'NO_SHARP'],
    [/mlb caveat: lineups are probable/i, 'LINEUPS'],
    [/late scratch or lineup change/i, 'LINEUPS'],
    [/a probable starter is still missing/i, 'NO_STARTER'],
    [/nothing structural stands out/i, 'NOTHING_STANDS_OUT'],
    [/the edge existed at detection/i, 'PRICE_MOVED_PAST'],
    [/current price is below fair/i, 'BELOW_FAIR'],
    [/no fair price (is on file|available)/i, 'NO_FAIR'],
    [/clears the bar with real liquidity/i, 'CLEARS_BAR'],
    [/positive and qualifying, but with caveats/i, 'QUALIFIES_WITH_CAVEATS']
  ];
  function reasonKind(s) {
    var t = clean(s);
    if (!t) return null;
    for (var i = 0; i < REASON_KINDS.length; i++) {
      var m = t.match(REASON_KINDS[i][0]);
      if (m) return { kind: REASON_KINDS[i][1], m: m };
    }
    return null;
  }
  /* f: the semantic facts pulled off the packet in simpleFromPacket. */
  function plainFor(kind, m, f) {
    f = f || {};
    var cmp = f.compare || {};
    switch (kind) {
      case 'EDGE_VS_FAIR':
      case 'CLEARS_BAR':
        /* priceCompare() has an honest sentence for every state, including
           "no comparison price on file" and "no live price on file", so this
           never falls back to the engine's own wording. */
        return cmp.sentence || null;
      case 'SHARP_CONFIRMED':
        return 'The sportsbook EdgeDesk uses as its benchmark is posting a price on this exact bet, so the comparison is against a live number rather than an estimate.';
      case 'NO_SHARP':
        return 'EdgeDesk’s benchmark sportsbook is not posting a price on this exact bet, so the comparison had to be built from the other sportsbooks. That is a weaker check.';
      case 'REGULATED':
        return 'The best price is at a sportsbook licensed and regulated in the US, so it is a price an ordinary bettor can actually get.';
      case 'BOOK_COUNT':
        return (f.n_books != null ? f.n_books : m[1]) + ' sportsbooks were quoting this game when EdgeDesk looked, so the comparison is not resting on one unusual book.';
      case 'CORROBORATED':
        return 'Other sportsbooks are pricing this the same way rather than one book sitting alone, which makes the gap look less like a single stuck number.';
      case 'BEAT_CLOSE':
        return 'EdgeDesk flagged this at a better price than the market finished at before kickoff.';
      case 'MISSED_CLOSE':
        return 'The market finished at a better price than the one EdgeDesk flagged, so the number moved the wrong way.';
      case 'OFFSHORE':
        return 'The best price is at an offshore sportsbook, which is harder to reach and less protected than a US-licensed one.';
      case 'OFFSHORE_SIZE':
        return 'The offshore price may not really be available to you, or not for much money.';
      case 'OFFSHORE_THIN':
        return 'The best price is offshore and only ' + m[1] + ' sportsbook' + (m[1] === '1' ? ' was' : 's were') + ' quoting this bet. That is too thin to trust.';
      case 'THIN':
        return 'Only ' + m[1] + ' sportsbook' + (m[1] === '1' ? ' was' : 's were') + ' quoting this bet, so the comparison rests on very little.';
      case 'AGING':
        return 'EdgeDesk last saw this price ' + m[1] + ' minutes ago. Check the sportsbook is still showing it.';
      case 'STALE':
        return 'EdgeDesk last saw this price ' + m[1] + ' minutes ago. Odds move quickly, so the real number may be worse by now.';
      case 'STALE_QUALIFIED':
        return 'The price qualified when EdgeDesk last saw it, but that was ' + m[1] + ' minutes ago. A fresh check has to show it is still there.';
      case 'TOO_GOOD':
        return 'A gap this big is usually a price that is out of date or simply wrong, not a gift. It normally disappears the moment the sportsbook notices.';
      case 'DECAYED':
        return 'Most of the gap EdgeDesk originally spotted has already closed. About ' + m[1] + '% of it is left.';
      case 'PRICE_WINDOW':
        return f.limit_odds ? 'The value lives in the price. Past ' + f.limit_odds + ' there is nothing left to buy.' : 'The value lives in the price, and it disappears once the price moves far enough.';
      case 'LINEUPS':
        return 'Lineups here are expected, not confirmed. One late change moves the price.';
      case 'NO_STARTER':
        return 'A probable starter is still missing for this game, and the starter is the single biggest input in the number.';
      case 'NOTHING_STANDS_OUT':
        return 'Nothing structural stands out against it, which is a reason to treat it normally rather than press.';
      case 'PRICE_MOVED_PAST':
        return f.compare && f.compare.have
          ? 'The gap was there when EdgeDesk first looked, but the price has moved since and there is no longer enough in it.'
          : 'The price has moved since EdgeDesk first looked, and there is no longer enough in it.';
      case 'BELOW_FAIR':
        return 'The price on offer is worse than EdgeDesk’s comparison price, so there is nothing to take here.';
      case 'NO_FAIR':
        return 'EdgeDesk has no comparison price on file for this bet, so there is nothing to judge the number against.';
      case 'QUALIFIES_WITH_CAVEATS':
        return 'The number clears EdgeDesk’s bar, but with caveats worth reading before acting.';
      default:
        return null;
    }
  }
  /* One engine reason -> one public sentence. Semantic first, dictionary last. */
  function publicReason(s, f) {
    var rk = reasonKind(s);
    if (rk) {
      var out = plainFor(rk.kind, rk.m, f);
      if (out) return out;
    }
    return plainReason(s);
  }

  /* ------------------------------------------------------------------ SIMPLE */
  /* The client packet shape (askAI / EDAI.packetOf) is the contract:
       { game:{matchup,sport,sport_key,commence,away,home,event_id},
         market, market_key, selection, selection_raw, point,
         prices:{detect,current,fair,fair_src,best_seen,max_playable,pinnacle,book,trusted},
         edge:{detect,current,ev,remaining,floor},
         confirmation:{has_sharp,n_books,n_books_eff,corrob,book,trusted},
         timing:{stale_min,last_seen_at,research_at},
         price_sensitivity:{breakeven,max_playable,needs_price_for_ev},
         deterministic:{verdict,display_verdict,is_wait,wait_reason,confidence,why,score,band,
                        reasons_for,reasons_against,falsifiers} }
     All prices in the packet are ALREADY American (the engine's own display
     transform). Decimal inputs are accepted too and converted for display. */
  function simpleFromPacket(p, ctx) {
    p = p || {}; ctx = ctx || {};
    var det = p.deterministic || {};
    var prices = p.prices || {};
    var ps = p.price_sensitivity || {};
    var edge = p.edge || {};
    var conf = p.confirmation || {};
    var timing = p.timing || {};
    var game = p.game || {};
    var now = toMs(ctx.now) != null ? toMs(ctx.now) : Date.now();

    var engineVerdict = normVerdict(det.verdict);
    var verdict = normVerdict(det.display_verdict) || engineVerdict;
    var integ = integrityStatus(ctx.integrity || p.integrity || null);

    var curAm = num(prices.current) != null ? num(prices.current) : decToAmerican(prices.current_dec);
    var detAm = num(prices.detect) != null ? num(prices.detect) : decToAmerican(prices.detect_dec);
    var fairAm = num(prices.fair) != null ? num(prices.fair) : decToAmerican(prices.fair_dec);
    var maxAm = num(ps.max_playable) != null ? num(ps.max_playable) : (num(prices.max_playable) != null ? num(prices.max_playable) : decToAmerican(prices.max_playable_dec));
    var needsAm = num(ps.needs_price_for_ev);
    var beAm = num(ps.breakeven) != null ? num(ps.breakeven) : fairAm;
    var book = clean(prices.book || conf.book || '') || null;
    var trusted = (prices.trusted != null) ? !!prices.trusted : (conf.trusted != null ? !!conf.trusted : null);

    var marketKey = p.market_key || p.market || null;
    var selectionRaw = p.selection_raw || p.selection || null;
    var selLabel = p.selection_raw ? selectionLabel(marketKey, selectionRaw, p.point) : (p.selection ? clean(p.selection) : null);
    if (selLabel && /^(h2h|ml|moneyline)$/i.test(String(marketKey || '')) && !/\bML$/.test(selLabel)) selLabel += ' ML';
    var mktLabel = marketLabel(marketKey) || (p.market ? String(p.market) : null);

    var priceAt = timing.last_seen_at != null ? toMs(timing.last_seen_at)
      : (num(timing.stale_min) != null ? now - num(timing.stale_min) * 60000 : null);
    var fr = freshness({ price_at: priceAt, research_at: timing.research_at || ctx.research_at || null, now: now,
      stale_min: num(ctx.stale_limit_min) != null ? num(ctx.stale_limit_min) : num(timing.stale_limit_min) });

    var play = playable({ verdict: verdict, max_playable_am: maxAm, needs_price_am: needsAm });
    var pst = priceStatus({ verdict: verdict, detect_am: detAm, current_am: curAm, max_playable_am: maxAm,
      edge: edge.current, detect_edge: edge.detect, floor: edge.floor, freshness: fr });

    /* ---- suppression: integrity FAIL never shows a recommendation ---- */
    var suppressed = false, displayVerdict = verdict;
    if (integ.status === 'FAILED' && (verdict === 'BET' || verdict === 'LEAN')) { suppressed = true; displayVerdict = 'WAIT'; }
    if (verdict == null) { displayVerdict = null; }

    var odds = fmtAmerican(curAm);
    var noPrice = curAm == null;

    /* ---- the public facts every plain sentence is built from ----
       Nothing new is computed here: these are the engine's own numbers,
       arranged so the copy below can be written from FACTS rather than by
       rewriting the engine's strings. */
    var pubBet = betLine({ market_key: marketKey, selection_raw: selectionRaw, point: p.point, home: game.home, away: game.away, sport_key: game.sport_key });
    var pubTicket = ticketLine({ market_key: marketKey, selection_raw: selectionRaw, point: p.point });
    var pubPush = pushNote({ market_key: marketKey, point: p.point, sport_key: game.sport_key });
    var pickSideKey = (selectionRaw && (game.home || game.away)) ? sideOf(selectionRaw, game.home, game.away) : null;
    var opponent = pickSideKey === 'home' ? (game.away || null) : pickSideKey === 'away' ? (game.home || null) : null;
    var compare = priceCompare({ current_am: curAm, fair_am: fairAm, edge: edge.current, book: book, bet_line: pubBet });
    var guard = longShotGuard({ current_am: curAm, market_key: marketKey, team: selectionRaw, opponent: opponent });
    var facts = { compare: compare, n_books: num(conf.n_books), limit_odds: play.limit_odds, bet_line: pubBet, book: book };

    /* ---- deterministic copy ---- */
    var whyRaw = (det.reasons_for || []).slice();
    var why = [];
    whyRaw.forEach(function (r) { var s = publicReason(r, facts); if (s && why.indexOf(s) < 0) why.push(s); });
    if (!why.length && det.why) why.push(publicReason(det.why, facts));
    /* Strongest drivers only: the engine lists them in priority order. */
    why = why.slice(0, 3).map(function (t) { return { text: t, source: 'deterministic', evidence_ids: [] }; });

    var availability = ctx.availability || p.availability || null;
    var avail = availabilitySummary(availability);
    var gapsIn = (ctx.gaps || p.gaps || []).filter(function (g) {
      /* an injury report on file is not a gap; an unpublished one still is */
      var k = String(g && (g.field || g) || '').toLowerCase();
      return !(avail && /injur|availab/.test(k));
    });
    if (availability && availability.status === 'NOT_PUBLISHED' && !gapsIn.some(function (g) { return /injur/.test(String(g && (g.field || g) || '')); })) gapsIn.push('injury_report');
    var gaps = gapSentences(gapsIn);
    if (availability && availability.status === 'NOT_PUBLISHED' && availability.reason) gaps = gaps.map(function (s) { return /injury and availability/i.test(s) ? 'Injury and availability data is not on file: ' + availability.reason + '. Do not read that as a clean injury report.' : s; });
    var against = (det.reasons_against || []).map(function (r) { return publicReason(r, facts); }).filter(Boolean);
    var fals = (det.falsifiers || []).map(function (r) { return publicReason(r, facts); }).filter(Boolean);
    var watchText, changeText;
    if (displayVerdict === 'WAIT' && (det.is_wait || suppressed)) {
      watchText = suppressed ? sentence('EdgeDesk will not publish a call until it fixes a problem with its own data: ' + (integ.reason_plain || 'a check on its own data failed'))
        : (det.wait_reason ? publicReason(det.wait_reason, facts) : 'Something still needs to confirm before this is a decision.');
      changeText = suppressed ? 'A clean data check would restore the decision.'
        : (play.limit_odds
            ? 'A fresh check at the sportsbook showing ' + play.limit_odds + ' or better, with no late lineup surprise, would turn this into a live call.'
            : 'A fresh look at the sportsbook price, or a confirmed lineup, would settle it.');
    } else if (displayVerdict === 'PASS') {
      watchText = det.why ? publicReason(det.why, facts) : 'EdgeDesk does not see enough value at the current price.';
      changeText = needsAm != null ? 'It becomes interesting again at ' + fmtAmerican(needsAm) + ' or better.'
        : (fals[0] || 'A better price would be needed for EdgeDesk to reconsider.');
    } else {
      watchText = against[0] || fals[0] || 'Nothing structural stands out.';
      changeText = fals[0] || 'A worse price would weaken the case.';
    }
    /* An actionable call must carry the availability caveat in its own watch
       line; a PASS or WAIT already leads with a stronger reason, and the gap
       still shows as a flag on the card. */
    if (gaps.length && /injur|availab/i.test(gaps[0]) && !/injur/i.test(watchText)
      && (displayVerdict === 'BET' || displayVerdict === 'LEAN')) watchText = gaps[0] + ' ' + watchText;
    /* A listed player on the side being backed leads the watch line; an
       opponent's absence is a watch line too, said as the opponent's. */
    if (avail && avail.listed.length && (displayVerdict === 'BET' || displayVerdict === 'LEAN' || displayVerdict === 'WAIT')) {
      var pickSide = (selectionRaw && game.home && normTeamName(selectionRaw) === normTeamName(game.home)) ? 'home' : (selectionRaw && game.away && normTeamName(selectionRaw) === normTeamName(game.away)) ? 'away' : null;
      /* The side being backed leads. A high-impact absence outranks a
         questionable rotation player on either side. */
      var material = avail.listed.filter(function (x) { return x.impact === 'HIGH' || x.status === 'out' || x.status === 'doubtful'; });
      var mine = material.filter(function (x) { return pickSide && x.side === pickSide; });
      var theirs = material.filter(function (x) { return !pickSide || x.side !== pickSide; });
      var lead = mine.length ? playerLine(mine[0]) + (mine.length > 1 ? ' ' + (mine.length - 1) + ' more on the same side listed.' : '')
        : (theirs.length ? 'For the other side, ' + playerLine(theirs[0]).charAt(0).toLowerCase() + playerLine(theirs[0]).slice(1) : '');
      if (lead && !/\bis (out|doubtful)\b/i.test(watchText)) watchText = lead + ' ' + watchText;
    }

    var headline;
    if (suppressed) headline = sentence('DATA CHECK FAILED: EdgeDesk will not publish a call until it fixes a problem with its own data: ' + (integ.reason_plain || 'a check on its own data failed'));
    else if (displayVerdict == null) headline = 'EdgeDesk has no decision on file for this selection.';
    else if (noPrice) headline = 'WAIT: no current price is on file for ' + (selLabel || 'this selection') + '.';
    else if (displayVerdict === 'BET') headline = 'BET: ' + selLabel + ' at ' + odds + '.';
    else if (displayVerdict === 'LEAN') headline = 'LEAN: ' + selLabel + ' at ' + odds + '. Positive, with caveats.';
    else if (displayVerdict === 'WAIT') headline = 'WAIT: ' + selLabel + ' at ' + odds + '. Something still needs to confirm.';
    else headline = 'PASS: EdgeDesk does not see enough value in ' + (selLabel || 'this selection') + ' at ' + odds + '.';
    if (noPrice && displayVerdict != null && !suppressed) displayVerdict = 'WAIT';

    var flags = [];
    if (suppressed) flags.push({ kind: 'DATA_CHECK_FAILED', text: 'Data check failed' + (integ.reason ? ': ' + integ.reason : '') });
    else if (integ.status === 'PROVISIONAL') flags.push({ kind: 'PROVISIONAL', text: 'Provisional' + (integ.reason ? ': ' + integ.reason : ': some of the underlying data needs verification') });
    if (fr.status === 'STALE') flags.push({ kind: 'STALE_PRICE', text: 'Price needs refreshing (' + fr.price_text.replace(/^Price updated /, '') + ')' });
    else if (fr.status === 'UNKNOWN' && !noPrice) flags.push({ kind: 'PRICE_AGE_UNKNOWN', text: 'Price age unknown' });
    if (noPrice) flags.push({ kind: 'NO_PRICE', text: 'No current price on file' });
    if (book && trusted === false) flags.push({ kind: 'OFFSHORE', text: 'Best price is at an offshore book' });
    gaps.forEach(function (g) { flags.push({ kind: 'DATA_GAP', text: g.split('. ')[0].replace(/\.$/, '') }); });
    if (avail) flags.push({ kind: 'AVAILABILITY', text: avail.text.replace(/^Injury report on file \([^)]*\): /, 'Availability: '), severity: avail.worst >= 2 ? 'warn' : 'ok' });

    /* ---- LEVEL 1 + LEVEL 2: the same facts, said for someone who has never
       placed a bet. Additive: every field above is untouched, and Full
       Research still reads `engine` and the precise copy. ---- */
    var vp = verdictPlain({ verdict: displayVerdict, suppressed: suppressed, no_price: noPrice,
      stale: fr.status === 'STALE', needs_odds: play.kind === 'NEEDS' ? play.limit_odds : null });
    var limitPlain = suppressed
      ? { label: 'Price limit', value: 'Withheld', limit_odds: null, hint: null,
          sentence: 'EdgeDesk is not publishing a price limit while the data check is failing.' }
      : priceLimitPlain(play);
    /* WAIT is the only state that needs BOTH halves: the thing that would turn
       it into a bet, and the thing that would end it. Everywhere else the
       change trigger IS the kill condition, and printing it twice under two
       headings is how a one-page brief stops being readable. */
    var killsText = (suppressed || displayVerdict !== 'WAIT') ? null
      : (play.limit_odds
          ? 'If the best price on offer gets worse than ' + play.limit_odds + ', the value is gone and there is nothing left to wait for.'
          : (fals[0] || 'A worse price would end it before it ever became a bet.'));
    var marketCheck = marketCheckPlain({ has_sharp: conf.has_sharp, n_books: conf.n_books, price_status: pst, book: book, trusted: trusted });
    var plainWhyHead = suppressed ? 'Why EdgeDesk is not calling it'
      : displayVerdict === 'PASS' ? 'Why EdgeDesk passes'
      : displayVerdict === 'WAIT' ? 'Why EdgeDesk noticed it'
      : 'Why EdgeDesk noticed it';
    var plain = {
      verdict: vp.key === 'FAILED' || vp.key === 'NONE' ? null : vp.key,
      verdict_label: vp.label,
      verdict_subtitle: vp.subtitle,
      answer: vp.answer,
      bet: pubBet || selLabel || null,
      ticket: pubTicket || selLabel || null,
      push_note: pubPush,
      price: odds,
      book: book,
      payout: payoutLine(curAm),
      found: compare,
      guard: guard ? guard.text : null,
      guard_kind: guard ? guard.kind : null,
      why_heading: plainWhyHead,
      why: why.map(function (w) { return w.text; }),
      risk_heading: suppressed ? 'What EdgeDesk cannot check' : displayVerdict === 'WAIT' ? 'Why wait' : displayVerdict === 'PASS' ? 'Why pass' : 'The biggest risk',
      risk: watchText,
      change_heading: displayVerdict === 'WAIT' ? 'What would turn this into a bet' : displayVerdict === 'PASS' ? 'What would bring it back' : 'What would end it',
      change: changeText,
      price_limit: limitPlain,
      kills: killsText,
      market_check: marketCheck.text,
      market_check_lines: marketCheck.lines,
      price_age: fr.price_text,
      price_age_warning: fr.warning
    };

    return {
      version: VERSION,
      available: displayVerdict != null,
      verdict: displayVerdict,
      engine_verdict: engineVerdict,
      display_verdict: displayVerdict,
      suppressed: suppressed,
      headline: headline,
      selection: selLabel,
      selection_raw: selectionRaw,
      market: marketKey,
      market_label: mktLabel,
      line: num(p.point),
      odds: odds,
      odds_format: 'american',
      odds_display: odds ? odds + (book ? ' · ' + book : '') : (book ? '— · ' + book : '—'),
      book: book,
      book_trusted: trusted,
      fair_odds: fmtAmerican(fairAm),
      breakeven_odds: fmtAmerican(beAm),
      playable_to: play,
      price_status: pst,
      why: why,
      watch: { text: watchText, source: 'deterministic' },
      change_trigger: { text: changeText, source: 'deterministic' },
      market_read: { text: marketCheck.text, source: 'deterministic' },
      plain: plain,
      freshness: fr,
      integrity_status: integ.status,
      integrity_reason: integ.reason,
      integrity_reason_plain: integ.reason_plain || null,
      flags: flags,
      gaps: gaps,
      availability: availability ? { status: availability.status, source: availability.source || null, week: availability.week || null,
        summary: avail ? avail.text : null, coverage_text: avail ? avail.coverage_text : coverageText(availability, []),
        listed: avail ? avail.listed.slice(0, 10) : [], high_impact: avail ? avail.high_impact : [], sides: avail ? avail.sides : [],
        official: avail ? avail.official : false, last_updated: avail ? avail.last_updated : null, reason: availability.reason || null } : null,
      confidence: det.confidence || null,
      score: num(det.score),
      copy_source: 'deterministic',
      /* the engine's graded receipt, verbatim (null until the close pipeline grades the row) */
      outcome: p.clv ? outcomeOf({ clv: p.clv.clv, beat_close: p.clv.beat_close, closing: p.clv.closing, result: p.clv.result, closed_at: p.clv.closed_at, graded_at: p.clv.graded_at, entry_am: detAm != null ? detAm : curAm }) : null,
      game: {
        matchup: game.matchup || null, away: game.away || null, home: game.home || null,
        sport_key: game.sport_key || null, sport_label: game.sport || null,
        commence: game.commence || null, event_id: game.event_id || null
      },
      /* the engine's numbers, verbatim, for Full Research and the internal snapshot */
      engine: {
        current_am: curAm, detect_am: detAm, fair_am: fairAm, max_playable_am: maxAm, breakeven_am: beAm,
        needs_price_am: needsAm, edge: num(edge.current), detect_edge: num(edge.detect), ev: num(edge.ev),
        remaining: num(edge.remaining), floor: num(edge.floor), has_sharp: conf.has_sharp == null ? null : !!conf.has_sharp,
        n_books: num(conf.n_books), confidence: det.confidence || null, score: num(det.score), band: det.band || null,
        why: det.why || null, reasons_for: (det.reasons_for || []).slice(), reasons_against: (det.reasons_against || []).slice(),
        falsifiers: (det.falsifiers || []).slice(), is_wait: !!det.is_wait, wait_reason: det.wait_reason || null
      }
    };
  }

  /* marketReadText() used to say "The sharper market is quoting the same side.
     21 books are behind the fair line." Neither sentence means anything to a
     sports fan, so marketCheckPlain() replaced it: same two engine fields,
     said as what they are. */

  /* Board rows (EDAI.buildBoard) carry the same facts under different keys. */
  function packetFromBoardRow(r) {
    if (!r) return null;
    var price = r.price || {}, edge = r.edge || {}, conf = r.confirmation || {}, det = r.deterministic || {};
    return {
      game: { matchup: r.game || null, sport: r.sport || null, commence: r.starts || null, event_id: r.event_id || null },
      market: r.market || null, market_key: r.market_key || r.market || null,
      selection: r.selection || null, selection_raw: r.selection_raw || null, point: r.point,
      prices: { detect: price.detection, current: price.current, fair: price.fair, fair_src: price.fair_src,
        best_seen: price.best_seen, max_playable: price.max_playable, pinnacle: price.pinnacle, book: price.book },
      edge: { detect: edge.detection, current: edge.current, ev: edge.ev, remaining: edge.remaining, floor: edge.floor },
      confirmation: { has_sharp: conf.has_sharp, n_books: conf.n_books, n_books_eff: conf.n_books_eff, corrob: conf.corrob, trusted: conf.trusted_book, book: price.book },
      timing: { stale_min: r.freshness ? r.freshness.stale_min : null },
      price_sensitivity: { breakeven: price.breakeven, max_playable: price.max_playable, needs_price_for_ev: null },
      deterministic: { verdict: det.verdict, display_verdict: det.display_verdict, is_wait: det.is_wait, wait_reason: det.wait_reason,
        confidence: det.confidence, score: det.score, band: det.band, why: det.why,
        reasons_for: det.reasons_for || [], reasons_against: det.reasons_against || [], falsifiers: det.falsifiers || [] }
    };
  }

  /* ------------------------------------------------------------ AI copy gate */
  /* Which numbers the copy may quote: only the ones the engine owns. */
  function knownNumbers(simple) {
    var s = simple || {}, e = s.engine || {};
    var odds = [s.odds, s.fair_odds, s.breakeven_odds, s.playable_to && s.playable_to.limit_odds,
      fmtAmerican(e.detect_am), fmtAmerican(e.needs_price_am)].filter(Boolean);
    var pcts = [e.edge, e.detect_edge, e.ev, e.floor].filter(function (x) { return x != null; }).map(function (x) { return x * 100; });
    if (e.remaining != null) pcts.push(e.remaining * 100);
    return { odds: odds, pcts: pcts };
  }
  function textOk(text, verdict, known, max) {
    var t = clean(text);
    if (!t) return 'empty';
    if (t.length > (max || 200)) return 'too long';
    if (HYPE.test(t)) return 'hype';
    var jg = t.match(JARGON);
    if (jg) return 'jargon “' + jg[0] + '”';
    var vm = t.match(/\b(BET|LEAN|WAIT|PASS)\b(?=[:\s.,!])/g);
    if (vm && verdict) {
      for (var i = 0; i < vm.length; i++) {
        if (vm[i] !== verdict && !/would (pass|wait)|not a bet|no bet/i.test(t)) return 'contradicts verdict';
      }
    }
    var oddsIn = t.match(/[+-]\d{3,4}\b/g) || [];
    for (var j = 0; j < oddsIn.length; j++) if (known.odds.indexOf(oddsIn[j]) < 0) return 'invented price ' + oddsIn[j];
    var pctIn = t.match(/(\d+(?:\.\d+)?)\s?%/g) || [];
    for (var k = 0; k < pctIn.length; k++) {
      var v = parseFloat(pctIn[k]);
      var hit = known.pcts.some(function (p) { return Math.abs(p - v) < 0.06 || Math.abs(Math.round(p) - v) < 0.5 || Math.abs(Math.round(p * 10) / 10 - v) < 0.06; });
      if (!hit) return 'invented percentage ' + pctIn[k];
    }
    return null;
  }
  function validateCopy(copy, simple, opts) {
    opts = opts || {};
    var errors = [], out = {};
    if (!copy || typeof copy !== 'object') return { ok: false, errors: ['no copy'], cleaned: null };
    var verdict = simple && simple.verdict;
    var known = knownNumbers(simple);
    var ids = opts.known_evidence_ids || null;
    function keep(field, text, max) {
      var err = textOk(text, verdict, known, max);
      if (err) { errors.push(field + ': ' + err); return null; }
      return sentence(text);
    }
    if (isStr(copy.headline)) {
      var h = clean(copy.headline);
      if (verdict && h.toUpperCase().indexOf(verdict + ':') !== 0 && h.toUpperCase().indexOf(verdict + ' ') !== 0) errors.push('headline: must start with the verdict');
      else { var hk = keep('headline', h, 160); if (hk) out.headline = hk; }
    }
    if (Array.isArray(copy.why)) {
      var why = [];
      copy.why.slice(0, 3).forEach(function (w, i) {
        var text = isStr(w) ? w : (w && w.text);
        var t = keep('why[' + i + ']', text, 170);
        if (!t) return;
        var ev = (w && Array.isArray(w.evidence_ids)) ? w.evidence_ids.filter(function (x) { return isStr(x) && (!ids || ids.indexOf(x) >= 0); }) : [];
        why.push({ text: t, source: 'ai', evidence_ids: ev });
      });
      if (why.length) out.why = why;
    }
    ['watch', 'change_trigger', 'market_read', 'plain_english', 'biggest_risk'].forEach(function (f) {
      if (isStr(copy[f])) { var t = keep(f, copy[f], f === 'plain_english' ? 420 : 240); if (t) out[f] = t; }
    });
    return { ok: Object.keys(out).length > 0, errors: errors, cleaned: out };
  }
  /* Returns a NEW simple object. The deterministic fields are untouched;
     only translation/copy fields change, and only when they pass the gate. */
  function applyAiCopy(simple, copy, opts) {
    if (!simple) return { simple: simple, accepted: false, rejected: ['no simple'] };
    var v = validateCopy(copy, simple, opts);
    var out = JSON.parse(JSON.stringify(simple));
    if (!v.ok) return { simple: out, accepted: false, rejected: v.errors };
    var c = v.cleaned;
    /* A suppressed or price-less card keeps its deterministic headline: the AI
       may not talk over a data-check failure or a missing price. */
    if (c.headline && !simple.suppressed && simple.price_status.kind !== 'NO_PRICE') out.headline = c.headline;
    if (c.why) {
      /* AI bullets lead; deterministic bullets fill in behind them so a card
         never gets thinner because one AI bullet was rejected. */
      var merged = c.why.slice();
      (simple.why || []).forEach(function (w) {
        if (merged.length >= 3) return;
        var dup = merged.some(function (m) { return m.text.toLowerCase() === w.text.toLowerCase(); });
        if (!dup) merged.push({ text: w.text, source: 'deterministic', evidence_ids: [] });
      });
      out.why = merged.slice(0, 3);
    }
    if (c.watch && !simple.suppressed) out.watch = { text: c.watch, source: 'ai' };
    if (c.change_trigger) out.change_trigger = { text: c.change_trigger, source: 'ai' };
    if (c.market_read) out.market_read = { text: c.market_read, source: 'ai' };
    if (c.plain_english) out.plain_english = { text: c.plain_english, source: 'ai' };
    if (c.biggest_risk && !simple.suppressed) out.biggest_risk = { text: c.biggest_risk, source: 'ai' };
    /* The plain block is the same copy, one layer down. Keep it in step so the
       five-second view and the brief never disagree with the answer above
       them. Only fields the gate accepted move; everything else stays
       deterministic. */
    if (out.plain) {
      out.plain.why = (out.why || []).map(function (w) { return w.text; });
      if (c.watch && !simple.suppressed) out.plain.risk = out.watch.text;
      if (c.biggest_risk && !simple.suppressed) out.plain.risk = out.biggest_risk.text;
      if (c.change_trigger) out.plain.change = out.change_trigger.text;
      if (c.market_read) out.plain.market_check = out.market_read.text;
      if (c.plain_english) out.plain.answer = out.plain_english.text;
    }
    out.copy_source = 'ai';
    out.copy_rejections = v.errors;
    return { simple: out, accepted: true, rejected: v.errors };
  }
  /* The model returns prose plus ONE fenced block. Split them. */
  function parseAiCopyBlock(text) {
    var s = String(text == null ? '' : text);
    var re = /```\s*edgedesk_copy\s*\n([\s\S]*?)```/i;
    var m = s.match(re);
    if (!m) {
      var m2 = s.match(/<edgedesk_copy>([\s\S]*?)<\/edgedesk_copy>/i);
      if (!m2) return { answer: s.trim(), copy: null, error: 'no block' };
      m = m2;
    }
    var copy = null, error = null;
    try { copy = JSON.parse(m[1]); } catch (e) { error = 'bad json'; }
    return { answer: s.replace(m[0], '').trim(), copy: copy, error: error };
  }

  /* -------------------------------------------------------------- explain */
  /* Every one of these answers a question a first-time reader will actually
     have, in words that need no glossary. Surfaced behind "What does this
     mean?" so the card itself stays clean. */
  var EXPLAIN = {
    good_to: function (s) {
      var pl = (s.plain && s.plain.price_limit) || priceLimitPlain(s.playable_to || {});
      return pl.sentence + (pl.hint ? ' ' + pl.hint : '') + ' The bet and the price are one thing: change the price and the answer changes, with nothing about the game moving.';
    },
    price_limit: function (s) { return EXPLAIN.good_to(s); },
    verdict: function (s) {
      if (s.suppressed) return 'A data check failed, so EdgeDesk will not publish a recommendation until it is repaired. That is EdgeDesk refusing to answer, not a bad bet.';
      if (s.verdict === 'BET') return 'BET means the price on offer is good enough by EdgeDesk’s standard right now. It is a judgement about the price, not a prediction of the result.';
      if (s.verdict === 'LEAN') return 'LEAN means there is something here, but not enough to call it a bet.';
      if (s.verdict === 'WAIT') return 'WAIT means something EdgeDesk needs is missing, out of date or unconfirmed. It is not a no.';
      if (s.verdict === 'PASS') return 'PASS means EdgeDesk looked and does not see enough value at this price. A calm no is a good answer.';
      return 'EdgeDesk has no call on file for this bet.';
    },
    price: function (s) {
      var pay = (s.plain && s.plain.payout) || null;
      return 'The call is the bet AND the price together. ' + ((s.plain && s.plain.bet) || s.selection || 'This bet') + ' at ' + (s.odds || 'no price') + ' is the thing being judged; a worse price can turn the same bet into a pass.'
        + (pay ? ' ' + pay : '');
    },
    comparison: function (s) {
      var c = concept('edgedesk_comparison');
      return c.simple + ' ' + c.detail + ' ' + c.guard;
    },
    benchmark: function (s) {
      var c = concept('benchmark_book');
      return c.simple + ' ' + c.detail + ' ' + c.guard;
    },
    book_count: function (s) {
      var c = concept('book_count');
      var n = s.engine && s.engine.n_books;
      return c.simple + (n != null ? ' Here it was ' + n + '.' : '') + ' ' + c.detail + ' ' + c.guard;
    },
    beat_the_close: function () {
      var c = concept('beat_the_close');
      return c.simple + ' ' + c.detail + ' ' + c.guard;
    },
    provisional: function (s) {
      return 'Provisional means some of the data behind this needs checking' + (s.integrity_reason ? ': ' + s.integrity_reason : '') + '. The call stands, but treat it with care.';
    },
    freshness: function (s) {
      return 'Odds move. ' + ((s.freshness && s.freshness.price_text) || 'Price age unknown') + '. ' + ((s.freshness && s.freshness.warning) || 'This one is recent enough to act on.') + ' An old price is not a wrong price — it is an unconfirmed one.';
    },
    book: function (s) {
      if (!s.book) return 'EdgeDesk did not record which sportsbook is offering this price.';
      return s.book + ' is the sportsbook with the best price EdgeDesk found.' + (s.book_trusted === false ? ' It is offshore, which means it is harder to reach and less protected than a US-licensed book.' : '');
    },
    not_a_prediction: function (s) {
      return (s.plain && s.plain.guard) || 'EdgeDesk judges the price on offer against what the rest of the market is charging. It does not predict who wins.';
    }
  };
  function explain(key, simple) {
    var f = EXPLAIN[key];
    return f ? f(simple || {}) : null;
  }

  /* -------------------------------------------------------------- publisher */
  var PRESETS = {
    GAME: { title: 'EdgeDesk Game Brief', kicker: null },
    TNF: { title: 'EdgeDesk Game Brief', kicker: 'Thursday Night Football' },
    SNF: { title: 'EdgeDesk Game Brief', kicker: 'Sunday Night Football' },
    MNF: { title: 'EdgeDesk Game Brief', kicker: 'Monday Night Football' },
    CFB: { title: 'EdgeDesk College Football Brief', kicker: 'College Football' },
    SLATE: { title: 'EdgeDesk Slate Brief', kicker: null }
  };
  function dataCheck(simple) {
    var s = simple || {};
    var status, text;
    if (s.suppressed) { status = 'Data check failed'; text = sentence('EdgeDesk will not publish a call until it fixes a problem with its own data: ' + (s.integrity_reason_plain || s.integrity_reason || 'a check on its own data failed')); }
    else if (s.freshness && s.freshness.status === 'STALE') { status = 'Needs refresh'; text = 'The price on file is stale. Refresh before publishing a number.'; }
    else if (s.integrity_status === 'PROVISIONAL') { status = 'Provisional'; text = s.integrity_reason ? 'Some of the underlying data needs verification: ' + s.integrity_reason : 'Some of the underlying data needs verification.'; }
    else if (s.freshness && s.freshness.status === 'UNKNOWN') { status = 'Provisional'; text = 'EdgeDesk cannot tell how old this price is.'; }
    else { status = 'Current'; text = 'Prices and research are current as of capture.'; }
    return { status: status, text: text, price_captured_at: s.freshness ? s.freshness.price_captured_at : null };
  }
  function callText(s) {
    if (!s || !s.available) return 'No decision on file.';
    if (s.suppressed) return 'DATA CHECK FAILED';
    var v = s.verdict;
    var sel = s.selection || 'this selection';
    if (v === 'PASS') return 'PASS — ' + sel + (s.odds ? ' (' + s.odds + ')' : '');
    if (v === 'WAIT') return 'WAIT — ' + sel + (s.odds ? ' (' + s.odds + ')' : '');
    return v + ' — ' + sel + (s.odds ? ' (' + s.odds + ')' : '');
  }
  /* Article-ready copy, strictly from the simple object. */
  function publisher(simple, ctx) {
    ctx = ctx || {};
    var s = simple || {};
    var preset = PRESETS[ctx.preset] ? ctx.preset : 'GAME';
    var P = PRESETS[preset];
    var v = s.verdict;
    var pl = s.plain || {};
    var whyLines = (s.why || []).map(function (w) { return w.text; });
    if (!whyLines.length) whyLines.push(v === 'PASS' ? 'EdgeDesk does not see enough value at the current price.' : 'EdgeDesk’s current research favors this number.');
    var risk = (s.biggest_risk && s.biggest_risk.text) || (s.watch && s.watch.text) || 'The price could move before kickoff.';
    var change = (s.change_trigger && s.change_trigger.text) || 'A worse price would change the call.';
    var goodTo = s.playable_to || {};
    var limit = pl.price_limit || priceLimitPlain(goodTo);
    var market = (s.market_read && s.market_read.text) || '';
    /* The lede leads with the BET as a football sentence, then the price.
       "Texas Tech to win by 4 points or more at -110" is the same fact as
       "Texas Tech -3.5 at -110" and one of them needs no explaining. */
    var bet = pl.bet || s.selection || 'this bet';
    /* A team name keeps its capital mid-sentence. "More than 47.5 total
       points" does not — it is a description, not a name. */
    var totalish = /^(totals?)$/i.test(String(s.market || '')) || /^(More|Fewer) than /.test(bet);
    var betMid = totalish ? bet.charAt(0).toLowerCase() + bet.slice(1) : bet;
    var lede;
    if (s.suppressed) lede = 'EdgeDesk is withholding a call on this game until a problem with its own data is fixed.';
    else if (!s.available) lede = 'EdgeDesk has no call on file for this game.';
    else if (v === 'BET') lede = 'EdgeDesk’s research favors ' + betMid + ' at ' + s.odds + '.' + (goodTo.limit_odds ? ' The price stays good enough down to ' + goodTo.limit_odds + '.' : '');
    else if (v === 'LEAN') lede = 'EdgeDesk leans toward ' + betMid + ' at ' + s.odds + ', with caveats.' + (goodTo.limit_odds ? ' The price stays good enough down to ' + goodTo.limit_odds + '.' : '');
    else if (v === 'WAIT') lede = 'EdgeDesk is not ready to call ' + betMid + ' at ' + s.odds + '. ' + (pl.answer || 'Something still has to be confirmed.');
    else lede = 'At ' + (s.odds || 'the current price') + ', EdgeDesk passes on ' + betMid + '.' + (goodTo.kind === 'NEEDS' ? ' It would take ' + goodTo.limit_odds + ' or better to change that.' : '');
    return {
      version: VERSION,
      preset: preset,
      title: ctx.title || P.title,
      kicker: ctx.kicker || P.kicker || (s.game && s.game.sport_label) || null,
      event_label: ctx.event_label || (s.game && s.game.away && s.game.home ? s.game.away + ' at ' + s.game.home : (s.game && s.game.matchup) || null),
      when_label: ctx.when_label || null,
      sport_label: ctx.sport_label || (s.game && s.game.sport_label) || null,
      lede: lede,
      call: { verdict: s.suppressed ? 'DATA CHECK FAILED' : (v || null), selection: s.selection, odds: s.odds, book: s.book, text: callText(s) },
      good_to: { label: goodTo.label || null, text: goodTo.text || null, limit_odds: goodTo.limit_odds || null },
      why: whyLines.slice(0, 3),
      biggest_risk: risk,
      change_call: change,
      market_read: market,
      /* LEVEL 1 + LEVEL 2, frozen into the snapshot alongside the precise
         fields so an already-published brief keeps rendering either way. */
      plain: {
        status: s.suppressed ? 'DATA CHECK FAILED' : (v || 'NO CALL'),
        status_line: pl.verdict_subtitle || null,
        answer: pl.answer || null,
        bet: pl.bet || s.selection || null,
        ticket: pl.ticket || s.selection || null,
        push_note: pl.push_note || null,
        price: s.odds || null,
        book: s.book || null,
        payout: pl.payout || null,
        found: pl.found || null,
        guard: pl.guard || null,
        why_heading: pl.why_heading || 'Why EdgeDesk noticed it',
        why: whyLines.slice(0, 3),
        risk_heading: pl.risk_heading || 'The biggest risk',
        risk: risk,
        change_heading: pl.change_heading || 'What would change the call',
        change: change,
        kills: pl.kills || null,
        price_limit: limit,
        market_check: market,
        price_age: pl.price_age || (s.freshness ? s.freshness.price_text : null)
      },
      availability: availabilityBrief(s),
      data_check: dataCheck(s),
      freshness_text: s.freshness ? s.freshness.price_text : null,
      powered_by: 'Powered by EdgeDesk Sports'
    };
  }


  /* The brief's availability section. Written for someone with no betting
     knowledge: who is in doubt, what that means for the game, where it came
     from and how sure EdgeDesk is. It never states a consequence for the
     model, because availability does not move a number here. */
  function availabilityBrief(s) {
    var av = s && s.availability;
    if (!av) return null;
    if (av.status === 'NOT_PUBLISHED') return { headline: 'Availability is unknown', lines: [av.coverage_text || 'No verified availability information found.'], coverage: av.coverage_text || null, players: [], sources: [] };
    /* A snapshot deep-clones its cards, so identity is not a safe key here. */
    function key(p) { return (p.team || '') + '|' + (p.name || ''); }
    var high = (av.high_impact || []).slice(0, 3);
    var seen = {}; high.forEach(function (p) { seen[key(p)] = 1; });
    var rest = (av.listed || []).filter(function (p) { return !seen[key(p)]; }).slice(0, 3);
    var lines = [], sources = [], srcSeen = {};
    function addSource(p) {
      if (!p.source_name) return;
      var k = p.source_name + '|' + (p.confidence || '');
      if (srcSeen[k]) return;
      srcSeen[k] = 1;
      sources.push({ name: p.source_name, url: p.source_url || null, confidence: p.confidence || null });
    }
    high.forEach(function (p) {
      lines.push(sentence(p.team + ' ' + (p.position ? p.position + ' ' : '') + p.name + ' is ' + (p.label || p.status)
        + (p.injury ? ' with a ' + String(p.injury).toLowerCase() + ' issue' : '')
        + (p.practice ? ' and was ' + String(p.practice).replace(/ in practice| participation/gi, '').toLowerCase() + ' in practice' : '')));
      lines.push(sentence(p.status === 'out'
        ? (p.team + ' is without ' + p.name + ' for this game, and EdgeDesk’s number does not adjust for it')
        : ('If ' + p.name.split(' ').slice(-1)[0] + ' cannot go, that is a material change to ' + p.team + '’s side of this game, and EdgeDesk’s number does not adjust for it')));
      addSource(p);
    });
    rest.forEach(function (p) {
      lines.push(sentence(p.team + ' ' + (p.position ? p.position + ' ' : '') + p.name + ' is ' + (p.label || p.status)));
      addSource(p);
    });
    if (!lines.length) lines.push(sentence((av.sides || []).map(function (x) { return x.text; }).join(' · ') || 'Nobody is listed'));
    var headline;
    if (!high.length) headline = (av.listed || []).length ? 'Availability notes' : 'No availability flags';
    else if (high[0].status === 'out') headline = high[0].team + ' is missing its ' + (high[0].position || 'starter');
    else headline = high[0].team + ' ' + (high[0].position || 'player') + ' status is unresolved';
    return { headline: headline, lines: lines, coverage: av.coverage_text || null, players: high.concat(rest), sources: sources };
  }

  /* ----------------------------------------------------------------- slate */
  function rankCards(cards) {
    return (cards || []).slice().sort(function (a, b) {
      var ra = VERDICT_RANK[a.verdict] != null ? VERDICT_RANK[a.verdict] : 9;
      var rb = VERDICT_RANK[b.verdict] != null ? VERDICT_RANK[b.verdict] : 9;
      if (ra !== rb) return ra - rb;
      return (num(b.score) || 0) - (num(a.score) || 0);
    });
  }
  /* mode: 'top' (default, max N BET decisions), 'all' (every BET/LEAN), 'single'. */
  function slate(cards, opts) {
    opts = opts || {};
    var mode = opts.mode || 'top';
    var max = num(opts.max) != null && num(opts.max) > 0 ? Math.floor(num(opts.max)) : 3;
    var all = rankCards((cards || []).filter(function (c) { return c && c.available; }));
    var usable = all.filter(function (c) { return !c.suppressed; });
    var bets = usable.filter(function (c) { return c.verdict === 'BET' && c.freshness.status !== 'STALE'; });
    var counts = { bet: 0, lean: 0, wait: 0, pass: 0, failed: 0 };
    all.forEach(function (c) { if (c.suppressed) counts.failed++; else if (c.verdict === 'BET') counts.bet++; else if (c.verdict === 'LEAN') counts.lean++; else if (c.verdict === 'WAIT') counts.wait++; else counts.pass++; });
    var picks, watch;
    if (mode === 'single') { picks = all.slice(0, 1); }
    else if (mode === 'all') { picks = usable.filter(function (c) { return c.verdict === 'BET' || c.verdict === 'LEAN'; }); }
    else { picks = bets.slice(0, max); }
    var picked = {};
    picks.forEach(function (c) { picked[cardKey(c)] = 1; });
    /* Never pad. The strongest non-BET research sits underneath, labelled. */
    watch = all.filter(function (c) { return !picked[cardKey(c)]; }).slice(0, Math.max(max, 3));
    var noBet = !picks.some(function (c) { return c.verdict === 'BET'; });
    var bestWatch = watch.filter(function (c) { return c.verdict === 'LEAN' || c.verdict === 'WAIT'; })[0] || null;
    return {
      mode: mode, max: max,
      picks: picks, watch: watch,
      no_bet: noBet,
      headline: noBet ? 'NO QUALIFYING BETS' : (picks.length + ' qualifying bet' + (picks.length === 1 ? '' : 's')),
      counts: counts,
      best_price_to_watch: bestWatch ? { selection: bestWatch.selection, odds: bestWatch.odds, book: bestWatch.book, verdict: bestWatch.verdict,
        limit: bestWatch.playable_to && bestWatch.playable_to.label, text: bestWatch.watch && bestWatch.watch.text } : null
    };
  }
  function cardKey(c) {
    return [c.game && c.game.event_id, c.market, c.selection_raw || c.selection, c.line].join('|');
  }

  /* -------------------------------------------------------------- snapshot */
  /* A publisher brief is a SNAPSHOT. It does not change when live odds do.
     `refresh` returns a NEW snapshot with a higher version; the old one is
     untouched, and every public price carries its capture timestamp. */
  function worst(a, b, order) { return order.indexOf(a) >= order.indexOf(b) ? a : b; }
  function snapshot(o) {
    o = o || {};
    var now = toMs(o.now) != null ? toMs(o.now) : Date.now();
    var cards = (o.cards || []).map(function (c) { return JSON.parse(JSON.stringify(c)); });
    var preset = PRESETS[o.preset] ? o.preset : (o.report_type === 'SLATE' ? 'SLATE' : 'GAME');
    var reportType = o.report_type === 'SLATE' ? 'SLATE' : 'GAME';
    var sl = reportType === 'SLATE' ? slate(cards, { mode: o.mode, max: o.max }) : null;
    var primary = reportType === 'SLATE' ? (sl.picks.concat(sl.watch)) : cards.slice(0, 1);
    var pubCards = (reportType === 'SLATE' ? sl.picks : cards.slice(0, 1)).map(function (c, i) {
      return { rank: i + 1, brief: publisher(c, { preset: preset, event_label: c.game && c.game.away && c.game.home ? c.game.away + ' at ' + c.game.home : (c.game && c.game.matchup) || null, when_label: c.game && c.game.commence ? whenLabel(c.game.commence, o.tz) : null, sport_label: o.sport_label || (c.game && c.game.sport_label) || null }) };
    });
    var watchCards = reportType === 'SLATE' ? sl.watch.map(function (c, i) {
      return { rank: i + 1, brief: publisher(c, { preset: preset, event_label: c.game && c.game.away && c.game.home ? c.game.away + ' at ' + c.game.home : (c.game && c.game.matchup) || null, when_label: c.game && c.game.commence ? whenLabel(c.game.commence, o.tz) : null, sport_label: o.sport_label || null }) };
    }) : [];
    var fresh = 'CURRENT', integ = 'OK';
    primary.forEach(function (c) {
      fresh = worst(fresh, c.freshness && c.freshness.status || 'UNKNOWN', ['CURRENT', 'AGING', 'UNKNOWN', 'STALE']);
      integ = worst(integ, c.integrity_status || 'OK', ['OK', 'PROVISIONAL', 'FAILED']);
    });
    var pickN = reportType === 'SLATE' ? sl.picks.length : 1;
    var prices = primary.map(function (c, i) {
      /* Every field the grader needs to find this exact selection again
         after kickoff travels with the price it was published at. */
      return { event_id: c.game && c.game.event_id, matchup: c.game && c.game.matchup, market: c.market_label, market_key: c.market || null,
        selection: c.selection, selection_raw: c.selection_raw || null, line: c.line, odds: c.odds, odds_am: c.engine ? c.engine.current_am : parseAmerican(c.odds),
        book: c.book, captured_at: c.freshness && c.freshness.price_captured_at || null,
        verdict: c.suppressed ? 'DATA CHECK FAILED' : (c.verdict || null), kind: i < pickN ? 'pick' : 'watch', rank: i < pickN ? i + 1 : i - pickN + 1,
        commence: c.game && c.game.commence || null, sport_key: c.game && c.game.sport_key || null, sport_label: c.game && c.game.sport_label || null,
        home: c.game && c.game.home || null, away: c.game && c.game.away || null };
    });
    var eventIds = [];
    primary.forEach(function (c) { var id = c.game && c.game.event_id; if (id && eventIds.indexOf(id) < 0) eventIds.push(id); });
    var P = PRESETS[preset];
    var title = o.title || P.title;
    var first = cards[0];
    var eventLabel = o.event_label || (reportType === 'GAME' && first && first.game ? (first.game.away && first.game.home ? first.game.away + ' at ' + first.game.home : first.game.matchup) : null);
    return {
      version: VERSION,
      version_no: num(o.version_no) || 1,
      parent_key: o.parent_key || null,
      report_key: o.report_key || (reportType + ':' + preset + ':' + (eventIds.join(',') || 'none')),
      report_type: reportType,
      preset: preset,
      sport: o.sport || (first && first.game && first.game.sport_key) || null,
      sport_label: o.sport_label || (first && first.game && first.game.sport_label) || null,
      title: title,
      kicker: o.kicker || P.kicker || null,
      event_label: eventLabel,
      when_label: o.when_label || (reportType === 'GAME' && first && first.game && first.game.commence ? whenLabel(first.game.commence, o.tz) : null),
      generated_at: new Date(now).toISOString(),
      event_ids: eventIds,
      price_snapshot: prices,
      freshness_status: fresh,
      integrity_status: integ,
      public: {
        cards: pubCards,
        watch: watchCards,
        slate: sl ? { headline: sl.headline, no_bet: sl.no_bet, counts: sl.counts, mode: sl.mode, max: sl.max, best_price_to_watch: sl.best_price_to_watch } : null,
        data_status: publicDataStatus(fresh, integ, prices)
      },
      internal: { cards: cards, slate: sl },
      is_public: false,
      share_slug: null
    };
  }
  function publicDataStatus(fresh, integ, prices) {
    var status = integ === 'FAILED' ? 'Data check failed' : fresh === 'STALE' ? 'Needs refresh' : (integ === 'PROVISIONAL' || fresh === 'UNKNOWN') ? 'Provisional' : 'Current';
    var latest = null;
    prices.forEach(function (p) { if (p.captured_at && (!latest || p.captured_at > latest)) latest = p.captured_at; });
    return { status: status, price_captured_at: latest, prices: prices };
  }
  function refresh(prev, o) {
    o = o || {};
    var next = snapshot({
      cards: o.cards, report_type: prev.report_type, preset: prev.preset, mode: o.mode || (prev.internal && prev.internal.slate && prev.internal.slate.mode),
      max: o.max || (prev.internal && prev.internal.slate && prev.internal.slate.max), sport: prev.sport, sport_label: prev.sport_label,
      title: prev.title, kicker: prev.kicker, event_label: o.event_label || prev.event_label, when_label: o.when_label || prev.when_label,
      now: o.now, tz: o.tz, version_no: (num(prev.version_no) || 1) + 1, parent_key: prev.report_key, report_key: prev.report_key
    });
    return next;
  }
  /* Only what is meant to be published. Engine internals never leave. */
  function publicPayload(snap) {
    if (!snap) return null;
    return {
      version: snap.version, version_no: snap.version_no, report_key: snap.report_key, report_type: snap.report_type, preset: snap.preset,
      sport: snap.sport, sport_label: snap.sport_label, title: snap.title, kicker: snap.kicker, event_label: snap.event_label,
      when_label: snap.when_label, generated_at: snap.generated_at, event_ids: snap.event_ids,
      freshness_status: snap.freshness_status, integrity_status: snap.integrity_status,
      cards: snap.public.cards, watch: snap.public.watch, slate: snap.public.slate, data_status: snap.public.data_status
    };
  }
  function whenLabel(iso, tz) {
    var ms = toMs(iso);
    if (ms == null) return null;
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/New_York', weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms)) + ' ET';
    } catch (e) { return new Date(ms).toUTCString(); }
  }
  /* ET calendar facts for primetime resolution. */
  function etParts(iso, tz) {
    var ms = toMs(iso);
    if (ms == null) return null;
    try {
      var f = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/New_York', weekday: 'short', hour: 'numeric', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' });
      var parts = {};
      f.formatToParts(new Date(ms)).forEach(function (p) { parts[p.type] = p.value; });
      var wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts.weekday];
      var hour = parseInt(parts.hour, 10); if (hour === 24) hour = 0;
      return { weekday: wd, hour: hour, date: parts.year + '-' + parts.month + '-' + parts.day, ms: ms };
    } catch (e) { var d = new Date(ms); return { weekday: d.getUTCDay(), hour: d.getUTCHours(), date: d.toISOString().slice(0, 10), ms: ms }; }
  }
  /* kind: TNF | SNF | MNF. rows carry {sport_key, commence_time}. Picks the
     next primetime kickoff by ET weekday and a 7pm+ ET start. Nothing is
     hardcoded: the game is whatever the schedule says it is. */
  function primetime(rows, kind, opts) {
    opts = opts || {};
    var now = toMs(opts.now) != null ? toMs(opts.now) : Date.now();
    var want = { TNF: 4, SNF: 0, MNF: 1 }[kind];
    if (want == null) return null;
    /* Nine days, not seven: the next Thursday game can be a full week plus
       kickoff-hours away, and a horizon that ends at the same clock time on
       the seventh day misses an 8:15 pm ET start on the eighth. */
    var horizon = now + (num(opts.days) || 9) * 86400000;
    var best = null;
    (rows || []).forEach(function (r) {
      if (!r || String(r.sport_key || '').indexOf('americanfootball_nfl') !== 0) return;
      var p = etParts(r.commence_time || r.commence || r.t, opts.tz);
      if (!p || p.weekday !== want || p.hour < 19) return;
      if (p.ms < now - 4 * 3600000 || p.ms > horizon) return;
      if (!best || p.ms < best.ms) best = { ms: p.ms, row: r, date: p.date };
    });
    return best;
  }

  /* ------------------------------------------------------------ renderers */
  /* Four identical "What does this mean?" links explain nothing. Each one says
     which word it is about, so the reader can open the one they are stuck on. */
  var WHAT_LABEL = {
    good_to: 'What does “price limit” mean?',
    price_limit: 'What does “price limit” mean?',
    verdict: 'What does this call mean?',
    price: 'Why is the price part of the call?',
    comparison: 'What is EdgeDesk’s comparison price?',
    benchmark: 'What is the benchmark sportsbook?',
    book_count: 'Why does the number of sportsbooks matter?',
    beat_the_close: 'What does “graded against the close” mean?',
    provisional: 'What does “provisional” mean?',
    freshness: 'Why does the price age matter?',
    book: 'Which sportsbook is this?',
    not_a_prediction: 'Is this a prediction?'
  };
  function whatMeans(key, simple) {
    var t = explain(key, simple);
    if (!t) return '';
    return '<details class="dcard-what"><summary>' + esc(WHAT_LABEL[key] || 'What does this mean?') + '</summary><p>' + esc(t) + '</p></details>';
  }
  /* Availability on the card: who is listed, how sure EdgeDesk is, where it
     came from, and how much of the field it actually covers. */
  function availabilityHTML(av) {
    if (!av) return '';
    if (av.status === 'NOT_PUBLISHED') return av.coverage_text ? '<div class="dcard-h">Availability</div><p class="dcard-avail-none">' + esc(av.coverage_text) + '</p>' : '';
    var h = '<div class="dcard-h">Availability</div>';
    if (av.listed && av.listed.length) {
      h += '<ul class="dcard-avail">' + av.listed.slice(0, 6).map(function (p) {
        var src = sourceText(p), tl = timelineText(p);
        return '<li><b>' + esc(p.name) + '</b>' + (p.position ? ' <span class="pos">' + esc(p.position) + '</span>' : '')
          + ' <span class="st ' + esc(p.status) + '">' + esc(p.label || p.status) + '</span>'
          + (p.impact === 'HIGH' ? ' <span class="imp">high impact</span>' : '')
          + (p.injury ? ' · ' + esc(String(p.injury).toLowerCase()) : '')
          + (p.practice ? ' · ' + esc(String(p.practice).replace(/ in practice| participation/gi, '').toLowerCase()) : '')
          + ' <span class="tm">' + esc(p.team) + '</span>'
          + (tl ? '<div class="tl">' + esc(tl) + '</div>' : '')
          + (src ? '<div class="src">' + (p.source_url ? '<a href="' + esc(p.source_url) + '" target="_blank" rel="noopener">' + esc(src) + '</a>' : esc(src)) + (p.contested ? ' · sources disagree' : '') + '</div>' : '')
          + '</li>';
      }).join('') + '</ul>';
    } else if (av.sides && av.sides.length) {
      h += '<p class="dcard-avail-none">' + esc(av.sides.map(function (s) { return s.text; }).join(' · ')) + '</p>';
    }
    if (av.coverage_text) h += '<p class="dcard-avail-cov">' + esc(av.coverage_text) + (av.last_updated ? ' Updated ' + esc(agoText(av.last_updated) || '') + '.' : '') + '</p>';
    return h;
  }

  /* The watchlist line: the two that matter, or a count. Compact on purpose. */
  function availabilityChip(av) {
    if (!av || av.status !== 'ON_FILE') return null;
    var listed = av.listed || [];
    if (!listed.length) return null;
    var top = listed.slice(0, 2).map(function (p) {
      var who = p.impact === 'HIGH' && p.position ? (p.position + (/^(QB|RB|WR|TE)$/.test(p.position) ? '1' : '')) : (p.position || p.name.split(' ').slice(-1)[0]);
      return who + ' ' + (p.label || p.status);
    });
    var text = top.join(' · ') + (listed.length > 2 ? ' · +' + (listed.length - 2) + ' more' : '');
    return { text: text, warn: listed.some(function (p) { return p.impact === 'HIGH' || p.status === 'out'; }), count: listed.length };
  }

  /* The grid states the price comparison. A why-bullet that repeats it word
     for word is noise, and a market-check line already made as a bullet is
     noise too. Both are dropped at render time so the underlying arrays stay
     whole for Full Research and for the snapshot. */
  function sameish(a, b) {
    return clean(String(a || '')).toLowerCase().replace(/[^a-z0-9 ]/g, '') === clean(String(b || '')).toLowerCase().replace(/[^a-z0-9 ]/g, '');
  }
  function whyMinusFound(list, pl, alsoDrop) {
    var drop = [pl && pl.found && pl.found.sentence].concat(alsoDrop || []).filter(Boolean);
    if (!drop.length) return list || [];
    return (list || []).filter(function (w) {
      var t = typeof w === 'string' ? w : w.text;
      return !drop.some(function (d) { return sameish(t, d); });
    });
  }
  function marketMinusWhy(text, whys) {
    if (!text) return text;
    var said = (whys || []).map(function (w) { return typeof w === 'string' ? w : w.text; });
    var kept = String(text).split(/(?<=\.)\s+/).filter(function (sent) {
      return !said.some(function (w) { return sameish(w, sent); });
    });
    return kept.join(' ');
  }

  /* The 5-second view. opts: { actions:[{label, onclick, primary}], compact, id, show_what } */
  function cardHTML(s, opts) {
    opts = opts || {};
    if (!s) return '';
    var pl = s.plain || {};
    var v = s.suppressed ? 'FAILED' : (s.verdict || 'NONE');
    var vcls = s.suppressed ? 'dc-failed' : s.verdict === 'BET' ? 'dc-bet' : s.verdict === 'LEAN' ? 'dc-lean' : s.verdict === 'WAIT' ? 'dc-wait' : s.verdict === 'PASS' ? 'dc-pass' : 'dc-none';
    var vtext = pl.verdict_label || (s.suppressed ? 'DATA CHECK FAILED' : (s.verdict || 'NO DECISION'));
    var goodTo = s.playable_to || {};
    var limit = pl.price_limit || priceLimitPlain(goodTo);
    var h = '<article class="dcard ' + vcls + (opts.compact ? ' compact' : '') + '"' + (opts.id ? ' id="' + esc(opts.id) + '"' : '') + ' data-verdict="' + esc(v) + '">';
    /* THE FIVE SECONDS. What the call is, what it is on, what it costs, and
       the price past which it stops being the call — in that order, and in
       words that need no glossary. */
    h += '<div class="dcard-hero">'
      + '<div class="dcard-eyebrow">EdgeDesk says</div>'
      + '<div class="dcard-verdict">' + esc(vtext) + '</div>'
      + '<div class="dcard-sel">' + esc(pl.bet || s.selection || '—') + '</div>'
      + '<div class="dcard-price">' + esc(pl.ticket ? pl.ticket + ' · ' : '') + esc(s.odds_display || '—') + '</div>'
      + '<div class="dcard-goodto' + (goodTo.kind === 'NEEDS' ? ' needs' : goodTo.kind === 'NONE' ? ' none' : '') + '">'
      + '<span class="k">' + esc(limit.label) + '</span> '
      + '<b>' + esc(limit.value) + '</b>'
      + '</div>'
      + '</div>';
    if (pl.verdict_subtitle) h += '<p class="dcard-sub">' + esc(pl.verdict_subtitle) + (pl.answer ? ' ' + esc(pl.answer) : '') + '</p>';
    /* The compact strip shows only what changes the decision at a glance:
       a failed check, a provisional read, a stale or missing price. Named
       data gaps stay on the full card, where the watch line explains them. */
    if (s.outcome && s.outcome.text) {
      var oc = s.outcome.result === 'win' ? 'win' : s.outcome.result === 'loss' ? 'loss' : s.outcome.result === 'push' ? 'push' : 'pend';
      h += '<div class="dcard-result ' + oc + '"><span class="k">Result</span> ' + esc(s.outcome.text) + '</div>';
    }
    var flags = (s.flags || []).filter(function (f) { return !opts.compact || f.kind !== 'DATA_GAP'; });
    if (flags.length) {
      h += '<div class="dcard-flags">' + flags.map(function (f) {
        var c = f.kind === 'DATA_CHECK_FAILED' ? 'bad' : (f.kind === 'STALE_PRICE' || f.kind === 'NO_PRICE') ? 'bad' : f.kind === 'AVAILABILITY' ? (f.severity === 'warn' ? 'warn' : 'ok') : 'warn';
        return '<span class="dcard-flag ' + c + '">' + esc(f.text) + '</span>';
      }).join('') + '</div>';
    }
    if (!opts.compact) {
      h += '<div class="dcard-body">';
      /* WHAT EDGEDESK FOUND — two prices, side by side, before a single
         sentence of analysis. This is the whole product in one glance. */
      if (pl.found && pl.found.rows && pl.found.rows.length) {
        h += '<div class="dcard-h">What EdgeDesk found</div>'
          + '<div class="dcard-cmp">' + pl.found.rows.map(function (r) {
            return '<div class="dcard-cmp-r"><span class="k">' + esc(r.k) + '</span><b>' + esc(r.v) + '</b>'
              + (r.note ? '<span class="n">' + esc(r.note) + '</span>' : '') + '</div>';
          }).join('') + '</div>'
          + '<p class="dcard-found">' + esc(pl.found.sentence || '') + '</p>'
          + (pl.payout || pl.push_note ? '<p class="dcard-payout">' + esc([pl.payout, pl.push_note].filter(Boolean).join(' ')) + '</p>' : '');
      }
      /* THE GUARD. A big payout is not a forecast. Said before the reasons,
         because it is the misreading that matters most. */
      if (pl.guard) h += '<div class="dcard-guard"><span class="k">Read this first</span><p>' + esc(pl.guard) + '</p></div>';
      var whyList = whyMinusFound(s.why || [], pl, [s.watch && s.watch.text]);
      h += (whyList.length ? '<div class="dcard-h">' + esc(pl.why_heading || 'Why') + '</div><ul class="dcard-why">'
        + whyList.map(function (w) { return '<li>' + esc(w.text) + '</li>'; }).join('')
        + '</ul>' : '')
        + '<div class="dcard-h">' + esc(pl.risk_heading || (s.verdict === 'WAIT' ? 'Why wait' : s.verdict === 'PASS' ? 'Why pass' : 'The biggest risk')) + '</div>'
        + '<p class="dcard-watch">' + esc(s.watch && s.watch.text || '') + '</p>'
        + (s.change_trigger && s.change_trigger.text ? '<div class="dcard-h">' + esc(pl.change_heading || 'What would change it') + '</div><p class="dcard-change">' + esc(s.change_trigger.text) + '</p>' : '')
        + (pl.kills ? '<div class="dcard-h">What would kill it</div><p class="dcard-change">' + esc(pl.kills) + '</p>' : '')
        + (function () { var mc = marketMinusWhy(pl.market_check, whyList); return mc ? '<div class="dcard-h">Market check</div><p class="dcard-market">' + esc(mc) + '</p>' : ''; })()
        + availabilityHTML(s.availability)
        + '<div class="dcard-fresh' + (s.freshness && s.freshness.status === 'STALE' ? ' bad' : '') + '">' + esc(s.freshness ? s.freshness.price_text : '') + (s.freshness && s.freshness.research_text ? ' · ' + esc(s.freshness.research_text) : '') + '</div>'
        + (opts.show_what !== false ? whatMeans('good_to', s) + whatMeans('verdict', s) + whatMeans('comparison', s) + (pl.guard ? whatMeans('not_a_prediction', s) : '') : '')
        + '</div>';
    } else {
      h += '<div class="dcard-line">' + esc(pl.answer || (s.why && s.why[0] && s.why[0].text) || s.headline || '') + '</div>';
      if (pl.guard) h += '<div class="dcard-guardchip">' + esc(pl.guard.split('. ')[0] + '.') + '</div>';
      var chip = availabilityChip(s.availability);
      if (chip) h += '<div class="dcard-availchip' + (chip.warn ? ' warn' : '') + '">' + esc(chip.text) + '</div>';
    }
    if (opts.actions && opts.actions.length) {
      h += '<div class="dcard-actions">' + opts.actions.map(function (a) {
        return '<button type="button" class="dcard-btn' + (a.primary ? ' primary' : '') + '" onclick="' + esc(a.onclick) + '">' + esc(a.label) + '</button>';
      }).join('') + '</div>';
    }
    return h + '</article>';
  }


  /* One pick on the brief, in the order a reader actually needs it:
       what the call is  ->  what the bet is  ->  what it pays  ->
       what EdgeDesk found  ->  the misreading guard  ->  why  ->
       what could break it  ->  what would change it  ->  the market check.
     A brief published before this layer existed has no `plain` block, so
     every line falls back to the field it used to render. */
  function briefCardHTML(pc, opts) {
    opts = opts || {};
    var b = pc.brief, r = pc.rank;
    var pl = b.plain || null;
    var v = b.call.verdict || 'NONE';
    var vcls = v === 'BET' ? 'dc-bet' : v === 'LEAN' ? 'dc-lean' : v === 'WAIT' ? 'dc-wait' : v === 'PASS' ? 'dc-pass' : 'dc-failed';
    var h = '<section class="edb-pick ' + vcls + '">';
    if (opts && opts.numbered) h += '<div class="edb-rank">#' + r + '</div>';
    if (b.event_label && (opts && opts.showEvent)) h += '<div class="edb-ev">' + esc(b.event_label) + (b.when_label ? ' <span class="edb-when">' + esc(b.when_label) + '</span>' : '') + '</div>';
    h += '<div class="edb-call"><span class="edb-verdict">' + esc(v) + '</span>'
      + '<span class="edb-sel">' + esc((pl && pl.bet) || b.call.selection || '—') + '</span></div>';
    if (pl && pl.status_line) h += '<p class="edb-sub">' + esc(pl.status_line) + ((pl.answer && !opts.hideAnswer) ? ' ' + esc(pl.answer) : '') + '</p>';
    h += '<div class="edb-ticket">' + esc((pl && pl.ticket) || b.call.selection || '') + (b.call.odds ? ' · <b>' + esc(b.call.odds) + '</b>' : '') + (b.call.book ? ' · ' + esc(b.call.book) : '') + '</div>';
    if (pl && pl.price_limit && pl.price_limit.value) {
      h += '<div class="edb-goodto"><span class="k">' + esc(pl.price_limit.label) + '</span> ' + esc(pl.price_limit.value) + '</div>'
        + '<p class="edb-limitnote">' + esc(pl.price_limit.sentence) + (pl.price_limit.hint ? ' ' + esc(pl.price_limit.hint) : '') + '</p>';
    } else if (b.good_to && b.good_to.label) {
      h += '<div class="edb-goodto">' + esc(b.good_to.label) + '</div>';
    }
    if (pl && pl.found && pl.found.rows && pl.found.rows.length) {
      h += '<div class="edb-h">What EdgeDesk found</div>'
        + '<div class="edb-cmp">' + pl.found.rows.map(function (x) {
          return '<div class="edb-cmp-r"><span class="k">' + esc(x.k) + '</span><b>' + esc(x.v) + '</b>' + (x.note ? '<span class="n">' + esc(x.note) + '</span>' : '') + '</div>';
        }).join('') + '</div>'
        + '<p class="edb-found">' + esc(pl.found.sentence || '') + '</p>'
        + (pl.payout || pl.push_note ? '<p class="edb-payout">' + esc([pl.payout, pl.push_note].filter(Boolean).join(' ')) + '</p>' : '');
    }
    if (pl && pl.guard) h += '<div class="edb-guard"><span class="k">Read this first</span><p>' + esc(pl.guard) + '</p></div>';
    var bWhy = whyMinusFound(b.why || [], pl, [b.biggest_risk]);
    if (bWhy.length) h += '<div class="edb-h">' + esc((pl && pl.why_heading) || (v === 'PASS' ? 'Why EdgeDesk passes' : v === 'WAIT' ? 'Waiting for' : 'Why EdgeDesk likes it')) + '</div><ol class="edb-why">'
      + bWhy.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ol>';
    h += '<div class="edb-h">' + esc((pl && pl.risk_heading) || 'The biggest risk') + '</div><p>' + esc(b.biggest_risk) + '</p>';
    if (b.availability) {
      h += '<div class="edb-h">' + esc(b.availability.headline) + '</div>'
        + b.availability.lines.map(function (l) { return '<p>' + esc(l) + '</p>'; }).join('')
        + (b.availability.coverage ? '<p class="edb-avail-cov">' + esc(b.availability.coverage) + '</p>' : '')
        + (b.availability.sources.length ? '<p class="edb-avail-src">Source: ' + b.availability.sources.map(function (x) { return esc(x.name) + (x.confidence ? ' · ' + esc(String(x.confidence).toLowerCase()) : ''); }).join(' · ') + '</p>' : '');
    }
    h += '<div class="edb-h">' + esc((pl && pl.change_heading) || 'What would change the call') + '</div><p>' + esc(b.change_call) + '</p>';
    if (pl && pl.kills) h += '<div class="edb-h">What would kill it</div><p>' + esc(pl.kills) + '</p>';
    var bMarket = marketMinusWhy(b.market_read, bWhy);
    if (bMarket) h += '<div class="edb-h">Market check</div><p>' + esc(bMarket) + '</p>';
    return h + '</section>';
  }

  /* PROGRESSIVE DISCLOSURE, at the bottom of the page rather than beside every
     number. Four words a reader may still want defined, closed by default.
     Definitions come from CONCEPTS so the app, the brief and the share page
     cannot drift apart. */
  var HOWTO_KEYS = ['verdict', 'price_limit', 'edgedesk_comparison', 'benchmark_book', 'book_count', 'price_age'];
  function howToReadHTML() {
    var items = HOWTO_KEYS.map(function (k) {
      var c = CONCEPTS[k === 'price_limit' ? 'price_limit' : k];
      if (!c) return '';
      return '<dt>' + esc(c.short) + '</dt><dd>' + esc(c.simple) + (c.guard ? ' <i>' + esc(c.guard) + '</i>' : '') + '</dd>';
    }).join('');
    if (!items) return '';
    return '<details class="edb-howto"><summary>How to read this brief</summary><dl>' + items
      + '<dt>What this is not</dt><dd>EdgeDesk judges the price on offer against the rest of the betting market. It does not predict who wins, and a call is never a promise. 21+. Gamble responsibly — 1-800-GAMBLER.</dd>'
      + '</dl></details>';
  }

  /* The one-page brief. opts: { public:true } strips nothing (the public
     payload already contains only publishable fields), it only changes chrome. */
  function briefHTML(snap, opts) {
    opts = opts || {};
    if (!snap) return '';
    var pub = snap.public || snap;   /* accepts a full snapshot or a public payload */
    var cards = pub.cards || [], watch = pub.watch || [], sl = pub.slate || null, ds = pub.data_status || {};
    var h = '<article class="edb" data-report="' + esc(snap.report_type || '') + '" data-preset="' + esc(snap.preset || '') + '">';
    h += '<header class="edb-hd"><div class="edb-brand">EdgeDesk</div><h1 class="edb-title">' + esc(snap.title || 'EdgeDesk Brief') + '</h1>'
      + (snap.kicker ? '<div class="edb-kicker">' + esc(snap.kicker) + '</div>' : '')
      + (snap.event_label ? '<div class="edb-event">' + esc(snap.event_label) + '</div>' : '')
      + (snap.when_label ? '<div class="edb-when">' + esc(snap.when_label) + '</div>' : '')
      + '</header>';
    if (snap.report_type === 'SLATE') {
      h += '<div class="edb-slatehead' + (sl && sl.no_bet ? ' nobet' : '') + '">' + esc(sl ? sl.headline : '') + '</div>';
      if (sl && sl.no_bet) h += '<p class="edb-nobet">EdgeDesk looked at every game on this slate and did not find a price worth betting. That is a real answer, not a gap. The closest calls are below, labelled for what they are.</p>';
      cards.forEach(function (pc) { h += briefCardHTML(pc, { numbered: true, showEvent: true }); });
      if (watch.length) {
        h += '<div class="edb-h edb-sec">' + (sl && sl.no_bet ? 'Strongest research (not bets)' : 'Also on the board') + '</div>';
        watch.forEach(function (pc) { h += briefCardHTML(pc, { numbered: false, showEvent: true }); });
      }
      if (sl && sl.best_price_to_watch) {
        var bp = sl.best_price_to_watch;
        h += '<div class="edb-h edb-sec">The one to keep an eye on</div><p class="edb-bpw"><b>' + esc(bp.selection || '') + '</b>' + (bp.odds ? ' at ' + esc(bp.odds) : '') + (bp.limit ? ' · ' + esc(bp.limit) : '') + (bp.text ? '. ' + esc(bp.text) : '') + '</p>';
      }
    } else {
      cards.forEach(function (pc) {
        var b = pc.brief;
        h += '<div class="edb-h edb-sec">The EdgeDesk call</div>';
        h += '<p class="edb-lede">' + esc(b.lede) + '</p>';
        h += briefCardHTML(pc, { numbered: false, showEvent: false, hideAnswer: true });
      });
    }
    if (opts.grades) h += briefResultsHTML(opts.grades);
    h += howToReadHTML();
    h += '<footer class="edb-ft"><div class="edb-h">EdgeDesk data check</div><p><b>' + esc(ds.status || 'Current') + '</b>'
      + (ds.price_captured_at ? ' · Price captured at ' + esc(fmtStamp(ds.price_captured_at)) : '') + '</p>'
      + (ds.prices && ds.prices.length > 1 ? '<ul class="edb-prices">' + ds.prices.map(function (p) { return '<li>' + esc(p.selection || '') + (p.odds ? ' ' + esc(p.odds) : '') + (p.book ? ' · ' + esc(p.book) : '') + (p.captured_at ? ' · captured ' + esc(fmtStamp(p.captured_at)) : '') + '</li>'; }).join('') + '</ul>' : '')
      + '<p class="edb-gen">Generated ' + esc(fmtStamp(snap.generated_at)) + (snap.version_no > 1 ? ' · version ' + snap.version_no : '') + '</p>'
      + '<p class="edb-powered">Powered by EdgeDesk Sports</p></footer>';
    return h + '</article>';
  }
  function fmtStamp(iso) {
    var ms = toMs(iso);
    if (ms == null) return String(iso || '');
    try { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms)) + ' ET'; }
    catch (e) { return new Date(ms).toISOString(); }
  }
  /* Clean semantic HTML for a CMS paste: headings, paragraphs, lists, no classes. */
  function briefCmsHTML(snap) {
    var pub = snap.public || snap, ds = pub.data_status || {};
    var h = '<h1>' + esc(snap.title || 'EdgeDesk Brief') + '</h1>';
    if (snap.kicker) h += '<p><strong>' + esc(snap.kicker) + '</strong></p>';
    if (snap.event_label) h += '<p>' + esc(snap.event_label) + (snap.when_label ? ' · ' + esc(snap.when_label) : '') + '</p>';
    function pick(pc, numbered) {
      var b = pc.brief, pl = b.plain || null, s = '';
      var call = (pl ? (pl.status + ' — ' + pl.bet + (pl.price ? ' (' + pl.price + ')' : '')) : b.call.text);
      if (numbered) s += '<h2>#' + pc.rank + ' ' + esc(call) + (b.event_label ? ' — ' + esc(b.event_label) : '') + '</h2>';
      else { s += '<h2>The EdgeDesk call</h2><p><strong>' + esc(call) + '</strong></p>'; }
      if (pl && pl.status_line) s += '<p><em>' + esc(pl.status_line) + (pl.answer ? ' ' + esc(pl.answer) : '') + '</em></p>';
      if (pl && pl.ticket) s += '<p>At the sportsbook: ' + esc(pl.ticket) + (b.call.odds ? ' · ' + esc(b.call.odds) : '') + (b.call.book ? ' · ' + esc(b.call.book) : '') + '</p>';
      if (pl && pl.price_limit && pl.price_limit.value) s += '<p><strong>' + esc(pl.price_limit.label) + ': ' + esc(pl.price_limit.value) + '</strong> ' + esc(pl.price_limit.sentence) + '</p>';
      else if (b.good_to && b.good_to.label) s += '<p><strong>' + esc(b.good_to.label) + '</strong></p>';
      if (!numbered) s += '<p>' + esc(b.lede) + '</p>';
      if (pl && pl.found && pl.found.rows && pl.found.rows.length) {
        s += '<h3>What EdgeDesk found</h3><ul>' + pl.found.rows.map(function (x) { return '<li>' + esc(x.k) + ': ' + esc(x.v) + (x.note ? ' (' + esc(x.note) + ')' : '') + '</li>'; }).join('') + '</ul>'
          + '<p>' + esc(pl.found.sentence || '') + '</p>' + (pl.payout || pl.push_note ? '<p>' + esc([pl.payout, pl.push_note].filter(Boolean).join(' ')) + '</p>' : '');
      }
      if (pl && pl.guard) s += '<h3>Read this first</h3><p>' + esc(pl.guard) + '</p>';
      var cWhy = whyMinusFound(b.why || [], pl, [b.biggest_risk]);
      if (cWhy.length) s += '<h3>' + esc((pl && pl.why_heading) || (b.call.verdict === 'PASS' ? 'Why EdgeDesk passes' : b.call.verdict === 'WAIT' ? 'Waiting for' : 'Why EdgeDesk likes it')) + '</h3><ol>' + cWhy.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ol>';
      s += '<h3>' + esc((pl && pl.risk_heading) || 'The biggest risk') + '</h3><p>' + esc(b.biggest_risk) + '</p>';
      if (b.availability) { s += '<h3>' + esc(b.availability.headline) + '</h3>' + b.availability.lines.map(function (l) { return '<p>' + esc(l) + '</p>'; }).join('')
        + (b.availability.coverage ? '<p>' + esc(b.availability.coverage) + '</p>' : '')
        + (b.availability.sources.length ? '<p>Source: ' + b.availability.sources.map(function (x) { return esc(x.name) + (x.confidence ? ' · ' + esc(String(x.confidence).toLowerCase()) : ''); }).join(' · ') + '</p>' : ''); }
      s += '<h3>' + esc((pl && pl.change_heading) || 'What would change the call') + '</h3><p>' + esc(b.change_call) + '</p>';
      if (pl && pl.kills) s += '<h3>What would kill it</h3><p>' + esc(pl.kills) + '</p>';
      var cMarket = marketMinusWhy(b.market_read, cWhy);
      if (cMarket) s += '<h3>Market check</h3><p>' + esc(cMarket) + '</p>';
      return s;
    }
    if (snap.report_type === 'SLATE') {
      h += '<h2>' + esc(pub.slate ? pub.slate.headline : '') + '</h2>';
      if (pub.slate && pub.slate.no_bet) h += '<p>EdgeDesk looked at every game on this slate and did not find a price worth betting. That is a real answer, not a gap. The closest calls are below, labelled for what they are.</p>';
      (pub.cards || []).forEach(function (pc) { h += pick(pc, true); });
      if ((pub.watch || []).length) { h += '<h2>' + (pub.slate && pub.slate.no_bet ? 'Strongest research (not bets)' : 'Also on the board') + '</h2>'; pub.watch.forEach(function (pc) { h += pick(pc, true); }); }
    } else {
      (pub.cards || []).forEach(function (pc) { h += pick(pc, false); });
    }
    h += '<h3>EdgeDesk data check</h3><p>' + esc(ds.status || 'Current') + (ds.price_captured_at ? ' · Price captured at ' + esc(fmtStamp(ds.price_captured_at)) : '') + '</p>';
    h += '<p><em>EdgeDesk judges the price on offer against the rest of the betting market. It does not predict who wins. 21+. Gamble responsibly — 1-800-GAMBLER.</em></p>';
    h += '<p><em>Powered by EdgeDesk Sports</em></p>';
    return h;
  }
  /* Article-ready plain text. */
  function briefText(snap, opts) {
    opts = opts || {};
    var pub = snap.public || snap, ds = pub.data_status || {};
    var L = [];
    L.push((snap.title || 'EdgeDesk Brief').toUpperCase());
    if (snap.kicker) L.push(snap.kicker);
    if (snap.event_label) L.push(snap.event_label + (snap.when_label ? ' · ' + snap.when_label : ''));
    L.push('');
    function pick(pc, numbered) {
      var b = pc.brief, pl = b.plain || null;
      var call = pl ? (pl.status + ' — ' + pl.bet + (pl.price ? ' (' + pl.price + ')' : '')) : b.call.text;
      if (numbered) L.push('#' + pc.rank + '  ' + call + (b.event_label ? '  —  ' + b.event_label : ''));
      else { L.push('THE EDGEDESK CALL'); L.push(call); }
      if (pl && pl.status_line) L.push(pl.status_line + (pl.answer ? ' ' + pl.answer : ''));
      if (pl && pl.ticket) L.push('At the sportsbook: ' + pl.ticket + (b.call.odds ? ' · ' + b.call.odds : '') + (b.call.book ? ' · ' + b.call.book : ''));
      if (pl && pl.price_limit && pl.price_limit.value) { L.push((pl.price_limit.label + ': ' + pl.price_limit.value).toUpperCase()); L.push(pl.price_limit.sentence); }
      else if (b.good_to && b.good_to.label) L.push(b.good_to.label.toUpperCase());
      if (!numbered) { L.push(''); L.push(b.lede); }
      if (pl && pl.found && pl.found.rows && pl.found.rows.length) {
        L.push(''); L.push('WHAT EDGEDESK FOUND');
        pl.found.rows.forEach(function (x) { L.push('  ' + x.k + ': ' + x.v + (x.note ? ' (' + x.note + ')' : '')); });
        if (pl.found.sentence) L.push(pl.found.sentence);
        if (pl.payout || pl.push_note) L.push([pl.payout, pl.push_note].filter(Boolean).join(' '));
      }
      if (pl && pl.guard) { L.push(''); L.push('READ THIS FIRST'); L.push(pl.guard); }
      var tWhy = whyMinusFound(b.why || [], pl, [b.biggest_risk]);
      if (tWhy.length) {
        L.push('');
        L.push(String((pl && pl.why_heading) || (b.call.verdict === 'PASS' ? 'Why EdgeDesk passes' : b.call.verdict === 'WAIT' ? 'Waiting for' : 'Why EdgeDesk likes it')).toUpperCase());
        tWhy.forEach(function (w, i) { L.push((i + 1) + '. ' + w); });
      }
      L.push(''); L.push(String((pl && pl.risk_heading) || 'The biggest risk').toUpperCase()); L.push(b.biggest_risk);
      if (b.availability) { L.push(''); L.push(String(b.availability.headline).toUpperCase()); b.availability.lines.forEach(function (l) { L.push(l); });
        if (b.availability.coverage) L.push(b.availability.coverage);
        if (b.availability.sources.length) L.push('Source: ' + b.availability.sources.map(function (x) { return x.name + (x.confidence ? ' · ' + String(x.confidence).toLowerCase() : ''); }).join(' · ')); }
      L.push(''); L.push(String((pl && pl.change_heading) || 'What would change the call').toUpperCase()); L.push(b.change_call);
      if (pl && pl.kills) { L.push(''); L.push('WHAT WOULD KILL IT'); L.push(pl.kills); }
      var tMarket = marketMinusWhy(b.market_read, tWhy);
      if (tMarket) { L.push(''); L.push('MARKET CHECK'); L.push(tMarket); }
      L.push('');
    }
    if (snap.report_type === 'SLATE') {
      L.push(pub.slate ? pub.slate.headline : ''); L.push('');
      if (pub.slate && pub.slate.no_bet) { L.push('EdgeDesk looked at every game on this slate and did not find a price worth betting. That is a real answer, not a gap. The closest calls are below, labelled for what they are.'); L.push(''); }
      (pub.cards || []).forEach(function (pc) { pick(pc, true); });
      if ((pub.watch || []).length) { L.push(pub.slate && pub.slate.no_bet ? 'STRONGEST RESEARCH (NOT BETS)' : 'ALSO ON THE BOARD'); L.push(''); pub.watch.forEach(function (pc) { pick(pc, true); }); }
    } else {
      (pub.cards || []).forEach(function (pc) { pick(pc, false); });
    }
    L.push('EDGEDESK DATA CHECK');
    L.push((ds.status || 'Current') + (ds.price_captured_at ? ' · Price captured at ' + fmtStamp(ds.price_captured_at) : ''));
    if (opts.grades) { var rt = briefResultsText(opts.grades); if (rt) L.push(rt); }
    L.push(''); L.push('EdgeDesk judges the price on offer against the rest of the betting market. It does not predict who wins. 21+. Gamble responsibly — 1-800-GAMBLER.');
    L.push(''); L.push('Powered by EdgeDesk Sports');
    return L.join('\n');
  }

  /* ------------------------------------------------------------- grading */
  /* CLOSE THE LOOP. A published call is graded against the closing line and
     the final score, deterministically, and the result travels with the
     card. Nothing here estimates: the close is the engine's canonical
     closing fair line (signals.closing_sharp_fair), the CLV arithmetic is
     the SAME `fair × decimal − 1` the engine and the public record already
     use, and a result comes from the close pipeline or from a final two
     feeds agreed on. Where a number is missing the grade says so. */
  function americanToDec(am) {
    var a = num(am);
    if (a == null || a === 0 || (a > -100 && a < 100)) return null;
    return a > 0 ? 1 + a / 100 : 1 + 100 / (-a);
  }
  function parseAmerican(s) {
    if (s == null || s === '') return null;
    if (typeof s === 'number') return isFinite(s) ? Math.round(s) : null;
    var m = String(s).trim().match(/^([+\-−]?)\s*(\d{3,5})$/);
    if (!m) return null;
    var v = parseInt(m[2], 10);
    return (m[1] === '-' || m[1] === '−') ? -v : v;
  }
  function probToAmerican(p) {
    var q = num(p);
    if (q == null || q <= 0 || q >= 1) return null;
    return decToAmerican(1 / q);
  }
  /* "Cents": the sportsbook scale on which -100 and +100 are the same point.
     -110 is 10 cents worse than even; +105 is 5 cents better. */
  function centsOf(am) {
    var a = num(am);
    if (a == null) return null;
    return a > 0 ? a - 100 : a + 100;
  }
  /* Positive = the entry price was better than the close. */
  function centsBetween(entryAm, closeAm) {
    var a = centsOf(entryAm), b = centsOf(closeAm);
    if (a == null || b == null) return null;
    return Math.round(a - b);
  }
  function round4(v) { return v == null ? null : Math.round(v * 10000) / 10000; }
  function normResult(r) {
    var s = String(r == null ? '' : r).toLowerCase().trim();
    if (s === 'win' || s === 'won' || s === 'w') return 'win';
    if (s === 'loss' || s === 'lost' || s === 'lose' || s === 'l') return 'loss';
    if (s === 'push' || s === 'void' || s === 'tie' || s === 'p') return 'push';
    return null;
  }
  function normTeam(s) {
    if (s == null) return '';
    var t = String(s).toLowerCase();
    try { t = t.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); } catch (e) {}
    return t.replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
  }
  /* Which side of the game a selection is. Exact after normalisation, then
     a containment that must be UNAMBIGUOUS: "Miami" matching both Miami
     (FL) and Miami (OH) is a null, not a guess. */
  function sideOf(selection, home, away) {
    var s = normTeam(selection), h = normTeam(home), a = normTeam(away);
    if (!s) return null;
    if (h && s === h) return 'home';
    if (a && s === a) return 'away';
    var hIn = h && (h.indexOf(s) >= 0 || s.indexOf(h) >= 0);
    var aIn = a && (a.indexOf(s) >= 0 || s.indexOf(a) >= 0);
    if (hIn && !aIn) return 'home';
    if (aIn && !hIn) return 'away';
    return null;
  }
  /* The outcome of a selection from a final score. Deterministic, and null
     whenever the inputs do not settle it. */
  function outcomeFromScore(o) {
    o = o || {};
    var hs = num(o.home_score), as = num(o.away_score);
    if (hs == null || as == null) return null;
    var m = String(o.market_key || o.market || '').toLowerCase().trim();
    var pt = num(o.point != null ? o.point : o.line);
    var sel = String(o.selection_raw || o.selection || '');
    if (m === 'totals' || m === 'total') {
      if (pt == null) return null;
      var over = /^over\b/i.test(sel), under = /^under\b/i.test(sel);
      if (!over && !under) return null;
      var tot = hs + as;
      if (tot === pt) return 'push';
      return over ? (tot > pt ? 'win' : 'loss') : (tot < pt ? 'win' : 'loss');
    }
    var side = sideOf(sel, o.home, o.away);
    if (!side) return null;
    var mine = side === 'home' ? hs : as, theirs = side === 'home' ? as : hs;
    if (m === 'spreads' || m === 'spread') {
      if (pt == null) return null;
      var adj = mine + pt - theirs;
      if (adj === 0) return 'push';
      return adj > 0 ? 'win' : 'loss';
    }
    if (m === 'h2h' || m === 'ml' || m === 'moneyline') {
      if (mine === theirs) return 'push';
      return mine > theirs ? 'win' : 'loss';
    }
    return null;
  }
  /* Grade one published price against the close and the result.
     o: { odds (American string or number), close_fair_prob, close_best_am,
          close_best_book, closed_at, result, result_source } */
  function gradePick(o) {
    o = o || {};
    var entryAm = parseAmerican(o.odds_am != null ? o.odds_am : o.odds);
    var dec = americanToDec(entryAm);
    var p = num(o.close_fair_prob);
    if (p != null && (p <= 0 || p >= 1)) p = null;
    var closeAm = probToAmerican(p);
    var g = {
      entry_odds: fmtAmerican(entryAm), entry_am: entryAm,
      close_fair_prob: p, close_fair_odds: fmtAmerican(closeAm), close_fair_am: closeAm,
      close_best_odds: o.close_best_am != null ? fmtAmerican(o.close_best_am) : null, close_best_book: o.close_best_book || null,
      /* the SAME book's last pre-kickoff quote, when the ticks table has it */
      close_book_odds: o.close_book_am != null ? fmtAmerican(o.close_book_am) : null, close_book: o.close_book || null,
      close_book_at: o.close_book_at || null, close_book_lead_min: num(o.close_book_lead_min), book_cents: null,
      closed_at: o.closed_at || null,
      clv: null, beat_close: null, cents: null,
      result: normResult(o.result), result_source: null,
      status: 'pending'
    };
    if (g.result) g.result_source = o.result_source || 'close pipeline';
    if (dec != null && p != null) {
      g.clv = round4(p * dec - 1);
      g.beat_close = g.clv > 0;
      g.cents = closeAm != null ? centsBetween(entryAm, closeAm) : null;
    }
    if (entryAm != null && o.close_book_am != null) g.book_cents = centsBetween(entryAm, parseAmerican(o.close_book_am));
    g.status = (g.clv != null && g.result) ? 'graded' : g.clv != null ? 'awaiting_result' : g.result ? 'awaiting_close' : 'pending';
    g.text = resultText(g);
    return g;
  }
  /* "Closed -125. Beat the close by 15 cents. Won." */
  function resultText(g) {
    if (!g) return '';
    var parts = [];
    if (g.close_book_odds) parts.push('Closed ' + g.close_book_odds + ' at ' + (g.close_book || 'the book') + (g.close_fair_odds ? ' (fair ' + g.close_fair_odds + ')' : ''));
    else if (g.close_fair_odds) parts.push('Closed ' + g.close_fair_odds);
    var c = g.book_cents != null ? g.book_cents : g.cents;
    var what = g.book_cents != null ? 'the book’s close' : 'the close';
    if (c != null) parts.push(c > 0 ? 'Beat ' + what + ' by ' + c + ' cent' + (c === 1 ? '' : 's') : c < 0 ? 'Missed ' + what + ' by ' + (-c) + ' cent' + (c === -1 ? '' : 's') : 'Matched ' + what);
    else if (g.beat_close != null) parts.push(g.beat_close ? 'Beat the close' : 'Did not beat the close');
    if (g.result === 'win') parts.push('Won');
    else if (g.result === 'loss') parts.push('Lost');
    else if (g.result === 'push') parts.push('Push');
    if (!parts.length) return g.status === 'awaiting_close' ? 'Final in. Waiting on the closing line.' : 'Waiting on the close.';
    if (g.status === 'awaiting_result' && !g.result) parts.push('Final pending');
    return parts.join('. ') + '.';
  }
  /* The in-app card's receipt: the ENGINE's own graded CLV, beat-close and
     result, verbatim, plus the display-only cents against the entry price.
     Nothing is recomputed; a card with no graded row gets no receipt. */
  function outcomeOf(o) {
    o = o || {};
    if (o.clv == null && !normResult(o.result)) return null;
    var closeAm = probToAmerican(o.closing);
    var g = {
      clv: num(o.clv), beat_close: o.beat_close == null ? (num(o.clv) != null ? num(o.clv) > 0 : null) : !!o.beat_close,
      result: normResult(o.result), entry_odds: fmtAmerican(o.entry_am), close_fair_odds: fmtAmerican(closeAm),
      cents: centsBetween(o.entry_am, closeAm), closed_at: o.closed_at || null, graded_at: o.graded_at || null,
      source: 'engine', status: (num(o.clv) != null && normResult(o.result)) ? 'graded' : num(o.clv) != null ? 'awaiting_result' : 'awaiting_close'
    };
    g.text = resultText(g);
    return g;
  }
  /* Legacy public prices carried only display labels. Recover the raw
     market key and selection so an older brief can still be matched to its
     signal row. Newer snapshots carry the fields outright. */
  function marketKeyOf(label) {
    var m = String(label == null ? '' : label).toLowerCase().trim();
    if (m === 'spread' || m === 'spreads') return 'spreads';
    if (m === 'total' || m === 'totals') return 'totals';
    if (m === 'moneyline' || m === 'ml' || m === 'h2h') return 'h2h';
    return m || null;
  }
  function parseSelectionLabel(label, marketKey) {
    var s = clean(label);
    if (!s) return { selection_raw: null, line: null };
    var mk = marketKeyOf(marketKey);
    var m;
    if (mk === 'totals') { m = s.match(/^(Over|Under)\s+([+\-]?\d+(?:\.\d+)?)$/i); return m ? { selection_raw: m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase(), line: +m[2] } : { selection_raw: s, line: null }; }
    if (mk === 'spreads') { m = s.match(/^(.*?)\s+([+\-]\d+(?:\.\d+)?)$/); return m ? { selection_raw: m[1], line: +m[2] } : { selection_raw: s, line: null }; }
    if (mk === 'h2h') return { selection_raw: s.replace(/\s+ML$/, ''), line: null };
    m = s.match(/^(.*?)\s+([+\-]?\d+(?:\.\d+)?)$/);
    return m ? { selection_raw: m[1], line: +m[2] } : { selection_raw: s, line: null };
  }
  function priceFields(p) {
    p = p || {};
    var mk = p.market_key || marketKeyOf(p.market);
    var parsed = (p.selection_raw != null) ? { selection_raw: p.selection_raw, line: num(p.line) } : parseSelectionLabel(p.selection, mk);
    return {
      event_id: p.event_id || null, market_key: mk, selection_raw: parsed.selection_raw,
      line: num(p.line) != null ? num(p.line) : parsed.line,
      odds_am: num(p.odds_am) != null ? num(p.odds_am) : parseAmerican(p.odds)
    };
  }
  function gradeKey(p) {
    var f = priceFields(p);
    return [f.event_id, f.market_key, f.selection_raw, f.line == null ? '' : f.line].join('|');
  }

  /* ------------------------------------------------------ the record */
  /* Aggregates over graded picks. `picks` are the flat rows the grader
     writes: { verdict, kind, preset, sport_key, sport_label, grade }. A NO
     QUALIFYING BETS brief counts as discipline, never as a gap. */
  var ACTIONABLE = { BET: 1, LEAN: 1 };
  function isCall(pk) { return pk && pk.kind === 'pick' && ACTIONABLE[pk.verdict] === 1; }
  function tally(rows) {
    var t = { n: rows.length, graded: 0, with_close: 0, beat: 0, cents_sum: 0, cents_n: 0, clv_sum: 0, clv_n: 0, win: 0, loss: 0, push: 0, pending: 0 };
    rows.forEach(function (r) {
      var g = r.grade || {};
      if (g.clv != null) { t.with_close++; t.clv_sum += g.clv; t.clv_n++; if (g.beat_close) t.beat++; }
      if (g.cents != null) { t.cents_sum += g.cents; t.cents_n++; }
      if (g.result === 'win') t.win++; else if (g.result === 'loss') t.loss++; else if (g.result === 'push') t.push++;
      if (g.status === 'graded') t.graded++; else t.pending++;
    });
    t.beat_rate = t.with_close ? t.beat / t.with_close : null;
    t.avg_cents = t.cents_n ? Math.round(t.cents_sum / t.cents_n * 10) / 10 : null;
    t.avg_clv = t.clv_n ? round4(t.clv_sum / t.clv_n) : null;
    delete t.cents_sum; delete t.clv_sum; delete t.cents_n; delete t.clv_n;
    return t;
  }
  function flattenPicks(briefs) {
    var out = [];
    (briefs || []).forEach(function (b) {
      (b.picks || []).forEach(function (pk) {
        out.push({ brief_id: b.id, preset: b.preset, report_type: b.report_type, sport_key: pk.sport_key || b.sport, sport_label: pk.sport_label || b.sport_label,
          verdict: pk.verdict, kind: pk.kind, grade: pk.grade, status: pk.status });
      });
    });
    return out;
  }
  function recordSummary(briefs, opts) {
    opts = opts || {};
    var list = (briefs || []).filter(function (b) { return !opts.preset || opts.preset === 'ALL' || b.preset === opts.preset; });
    var picks = flattenPicks(list);
    var calls = picks.filter(isCall);
    var noBet = list.filter(function (b) { return b.no_bet; }).length;
    var byPreset = {};
    list.forEach(function (b) { byPreset[b.preset] = byPreset[b.preset] || { briefs: 0, no_bet: 0, rows: [] }; byPreset[b.preset].briefs++; if (b.no_bet) byPreset[b.preset].no_bet++; });
    calls.forEach(function (c) { if (byPreset[c.preset]) byPreset[c.preset].rows.push(c); });
    Object.keys(byPreset).forEach(function (k) { byPreset[k].calls = tally(byPreset[k].rows); delete byPreset[k].rows; });
    return { briefs: list.length, no_bet_briefs: noBet, calls: tally(calls), research: tally(picks.filter(function (p) { return !isCall(p); })), by_preset: byPreset };
  }
  /* How often each verdict beat the close, by sport. The first real
     feedback on whether the verdict thresholds are set well. */
  function calibration(briefs) {
    var picks = flattenPicks(briefs);
    var cells = {};
    picks.forEach(function (p) {
      var v = p.verdict || 'NONE', s = sportGroup(p.sport_key, p.sport_label);
      var k = v + '|' + s;
      cells[k] = cells[k] || { verdict: v, sport: s, rows: [] };
      cells[k].rows.push(p);
    });
    var order = { BET: 0, LEAN: 1, WAIT: 2, PASS: 3 };
    return Object.keys(cells).map(function (k) { var c = cells[k]; var t = tally(c.rows); t.verdict = c.verdict; t.sport = c.sport; return t; })
      .sort(function (a, b) { var ra = order[a.verdict] != null ? order[a.verdict] : 9, rb = order[b.verdict] != null ? order[b.verdict] : 9; if (ra !== rb) return ra - rb; return a.sport < b.sport ? -1 : a.sport > b.sport ? 1 : 0; });
  }
  function sportGroup(key, label) {
    var k = String(key || '').toLowerCase();
    if (k.indexOf('americanfootball_nfl') === 0) return 'NFL';
    if (k.indexOf('americanfootball_ncaaf') === 0) return 'CFB';
    if (k.indexOf('basketball_nba') === 0) return 'NBA';
    if (k.indexOf('baseball_mlb') === 0) return 'MLB';
    if (k.indexOf('icehockey_nhl') === 0) return 'NHL';
    if (k.indexOf('mma') === 0) return 'MMA';
    if (k.indexOf('tennis') === 0) return 'Tennis';
    if (k.indexOf('soccer') === 0) return 'Soccer';
    return label || (k ? k.split('_')[0].toUpperCase() : 'Other');
  }
  function fmtCents(c) { if (c == null) return '—'; return (c > 0 ? '+' : '') + c; }
  function fmtRate(v) { return v == null ? '—' : Math.round(v * 100) + '%'; }
  function fmtClv(v) { return v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%'; }
  /* The verdict calibration table. Internal: shown in the app's publisher
     desk. Below MIN_CAL rows a cell says so instead of pretending. */
  var MIN_CAL = 20;
  function calibrationHTML(briefs, opts) {
    opts = opts || {};
    var rows = calibration(briefs);
    if (!rows.length) return '<div class="edrec-empty">No published calls have graded yet. The table fills in as briefs settle against the close.</div>';
    var h = '<table class="edrec-cal"><thead><tr><th>Verdict</th><th>Sport</th><th>Rows</th><th>With close</th><th>Beat close</th><th>Avg cents</th><th>Avg CLV</th><th>W-L-P</th></tr></thead><tbody>';
    rows.forEach(function (r) {
      var thin = r.with_close < (num(opts.min) != null ? num(opts.min) : MIN_CAL);
      h += '<tr class="' + (thin ? 'thin' : '') + '"><td class="v ' + esc(String(r.verdict).toLowerCase()) + '">' + esc(r.verdict) + '</td><td>' + esc(r.sport) + '</td><td>' + r.n + '</td><td>' + r.with_close + '</td>'
        + '<td class="' + (r.beat_rate == null ? '' : r.beat_rate >= 0.5 ? 'up' : 'dn') + '">' + fmtRate(r.beat_rate) + '</td>'
        + '<td class="' + (r.avg_cents == null ? '' : r.avg_cents >= 0 ? 'up' : 'dn') + '">' + fmtCents(r.avg_cents) + '</td>'
        + '<td class="' + (r.avg_clv == null ? '' : r.avg_clv >= 0 ? 'up' : 'dn') + '">' + fmtClv(r.avg_clv) + '</td>'
        + '<td>' + r.win + '-' + r.loss + '-' + r.push + (thin ? ' <span class="note">below ' + MIN_CAL + '</span>' : '') + '</td></tr>';
    });
    return h + '</tbody></table>';
  }
  /* One brief's picks with their grades, for the public record page and
     the share page. Pending rows say what they are waiting on. */
  function pickStatusText(pk) {
    var g = pk.grade || {};
    if (g.status === 'graded' || g.status === 'awaiting_result' || g.status === 'awaiting_close') return g.text || resultText(g);
    if (pk.status === 'pending_kickoff') return 'Not kicked off yet.';
    if (pk.status === 'contested') return 'Sources disagree on the result. Not graded.';
    if (pk.status === 'no_close_source') return 'Closing line source not deployed yet.';
    if (pk.status === 'no_odds') return 'Published without a price, so there is nothing to grade against the close.';
    if (pk.status === 'no_signal_row') return 'Kicked off. No closing line captured for this selection.';
    return 'Waiting on the close.';
  }
  function resultHTML(pk) {
    var g = pk.grade || {};
    var cls = g.result === 'win' ? 'win' : g.result === 'loss' ? 'loss' : g.result === 'push' ? 'push' : 'pend';
    var beat = g.cents != null ? (g.cents > 0 ? 'up' : g.cents < 0 ? 'dn' : '') : (g.beat_close === true ? 'up' : g.beat_close === false ? 'dn' : '');
    return '<span class="edrec-res ' + cls + ' ' + beat + '">' + esc(pickStatusText(pk)) + '</span>';
  }
  function briefResultsHTML(entry) {
    if (!entry || !entry.picks || !entry.picks.length) return '';
    var h = '<section class="edb-results"><div class="edb-h edb-sec">How it graded</div><ul class="edb-reslist">';
    entry.picks.forEach(function (pk) {
      h += '<li><span class="edb-resv ' + esc(String(pk.verdict || '').toLowerCase()) + '">' + esc(pk.verdict || '') + '</span> <b>' + esc(pk.selection || '') + '</b>' + (pk.odds ? ' <span class="edb-resodds">' + esc(pk.odds) + (pk.book ? ' · ' + esc(pk.book) : '') + '</span>' : '')
        + (pk.score && pk.score.home_score != null ? ' <span class="edb-resscore">Final ' + esc(pk.score.away || '') + ' ' + pk.score.away_score + ', ' + esc(pk.score.home || '') + ' ' + pk.score.home_score + '</span>' : '')
        + '<div>' + resultHTML(pk) + '</div></li>';
    });
    h += '</ul><p class="edb-resnote">Graded against EdgeDesk’s closing fair line, the same close the public record uses. Prices above are the ones published at the time; nothing was edited after the fact.' + (entry.graded_at ? ' Updated ' + esc(fmtStamp(entry.graded_at)) + '.' : '') + '</p></section>';
    return h;
  }
  function briefResultsText(entry) {
    if (!entry || !entry.picks || !entry.picks.length) return '';
    var L = ['', 'HOW IT GRADED'];
    entry.picks.forEach(function (pk) {
      L.push((pk.verdict || '') + '  ' + (pk.selection || '') + (pk.odds ? ' (' + pk.odds + (pk.book ? ' · ' + pk.book : '') + ')' : '') + '  —  ' + pickStatusText(pk));
    });
    return L.join('\n');
  }

  return {
    VERSION: VERSION, VERDICTS: VERDICTS, HYPE: HYPE, JARGON: JARGON, PRESETS: PRESETS,
    esc: esc, num: num, sentence: sentence, normVerdict: normVerdict,
    decToAmerican: decToAmerican, fmtAmerican: fmtAmerican, selectionLabel: selectionLabel, marketLabel: marketLabel,
    translate: translate, translateText: translateText, publicText: publicText, PUBLIC_TERMS: PUBLIC_TERMS, plainReason: plainReason,
    /* the public language layer */
    CONCEPTS: CONCEPTS, concept: concept, scoreUnit: scoreUnit, betterOf: betterOf, payoutLine: payoutLine, betterHint: betterHint,
    betLine: betLine, pushNote: pushNote, ticketLine: ticketLine, priceCompare: priceCompare, longShotGuard: longShotGuard,
    verdictPlain: verdictPlain, priceLimitPlain: priceLimitPlain, marketCheckPlain: marketCheckPlain,
    reasonKind: reasonKind, publicReason: publicReason, howToReadHTML: howToReadHTML,
    freshness: freshness, ageText: ageText, playable: playable, priceStatus: priceStatus, integrityStatus: integrityStatus,
    gapSentences: gapSentences,
    simpleFromPacket: simpleFromPacket, packetFromBoardRow: packetFromBoardRow,
    validateCopy: validateCopy, applyAiCopy: applyAiCopy, parseAiCopyBlock: parseAiCopyBlock,
    explain: explain, WHAT_LABEL: WHAT_LABEL, publisher: publisher, slate: slate, rankCards: rankCards,
    snapshot: snapshot, refresh: refresh, publicPayload: publicPayload,
    whenLabel: whenLabel, etParts: etParts, primetime: primetime, fmtStamp: fmtStamp,
    cardHTML: cardHTML, briefHTML: briefHTML, briefCmsHTML: briefCmsHTML, briefText: briefText,
    americanToDec: americanToDec, parseAmerican: parseAmerican, probToAmerican: probToAmerican, centsOf: centsOf, centsBetween: centsBetween,
    normResult: normResult, normTeam: normTeam, sideOf: sideOf, outcomeFromScore: outcomeFromScore, gradePick: gradePick, resultText: resultText, outcomeOf: outcomeOf,
    marketKeyOf: marketKeyOf, parseSelectionLabel: parseSelectionLabel, priceFields: priceFields, gradeKey: gradeKey,
    recordSummary: recordSummary, calibration: calibration, sportGroup: sportGroup, isCall: isCall, tally: tally, flattenPicks: flattenPicks,
    availabilitySummary: availabilitySummary, playerLine: playerLine, availabilityHTML: availabilityHTML, availabilityBrief: availabilityBrief, availabilityChip: availabilityChip,
    coverageText: coverageText, timelineText: timelineText, sourceText: sourceText, statusLabel: statusLabel, agoText: agoText,
    calibrationHTML: calibrationHTML, pickStatusText: pickStatusText, resultHTML: resultHTML, briefResultsHTML: briefResultsHTML, briefResultsText: briefResultsText,
    fmtCents: fmtCents, fmtRate: fmtRate, fmtClv: fmtClv
  };
});
/*__EDPRES_END__*/
