/* ===========================================================================
   THE LINEMAKER ON THE DESK — team totals and alternate lines, answered from
   the published fair-line sheets (football/linemaker/fair_lines.json) and
   nothing else.

   The full research pipeline declares team totals and alternate lines out of
   scope (_board.js UNSUPPORTED_MARKETS), so a reader asking "what's the Jets
   team total?" or "is Patriots -10.5 at +180 any good?" used to get a refusal.
   This answers it deterministically: the fair number, the probability at the
   number asked about, a price check through lib/edgedesk_fairline.js when a
   price is given, and the status of every probability in plain words.

   What it never does: call a model, invent a number that is not on the
   sheet, call a team-total price VALUE (team totals have never been tested
   at a market number), or answer a question it does not recognise (it
   returns null and the pipeline runs as before).

   Inlined into supabase/functions/edgedesk_ai/index.ts by
   tools/presentation/inline.js (after EDRCORE and EDFAIRLINE). Edit THIS
   file, then run the inliner.
   =========================================================================== */
/*__EDLINESDESK_START__*/
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.EDLinesDesk = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  var VERSION = 1;
  var SCHEMA = 'edgedesk_lines_desk_v1';
  var FEED_SCHEMA = 'edgedesk_fair_lines_v1';
  /* the questions this answers, and only these */
  var GATE = /\bteam[\s-]?totals?\b|\balt(?:ernate)?\.?\s*(?:lines?|spreads?|totals?)\b|\bladder\b|\bhow many points (?:will|do|does|should)\b/i;
  var ALT_TOTAL = /\balt(?:ernate)?\.?\s*totals?\b/i;
  var ALT_SPREAD = /\balt(?:ernate)?\.?\s*(?:lines?|spreads?)\b/i;

  function FL() { var f = root && root.EDFairLine; if (!f && typeof require === 'function') { try { f = require('../../lib/edgedesk_fairline.js'); } catch (_) { f = null; } } return f; }
  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
  function pct(v) { return v == null ? '—' : (Math.round(v * 1000) / 10) + '%'; }
  function am(v) { return v == null ? '—' : (v > 0 ? '+' : '') + Math.round(v); }
  function ln(v) { return v == null ? '—' : (v > 0 ? '+' : '') + v; }

  /** the names a reader may use for a team: the full name, and an NFL club's nickname */
  function aliases(name, league) {
    var n = norm(name), out = [n];
    if (league === 'NFL') { var w = n.split(' '); if (w.length > 1) out.push(w[w.length - 1]); }
    return out.filter(Boolean);
  }
  /** where (if anywhere) a team is named in the question: the earliest index of its longest alias */
  function named(qn, name, league) {
    var best = null;
    aliases(name, league).forEach(function (a) {
      var re = new RegExp('(^| )' + a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '( |$)');
      var m = re.exec(qn);
      if (m && (best == null || a.length > best.len)) best = { at: m.index, len: a.length };
    });
    return best;
  }

  /** the game a question is about: one named in it, else the carried/on-screen subject */
  function resolveGame(q, feed, subject) {
    if (!feed || !Array.isArray(feed.games)) return { game: null, why: 'no fair-line sheets on file' };
    var qn = ' ' + norm(q) + ' ';
    var both = [], one = [];
    feed.games.forEach(function (g) {
      var h = named(qn, g.home, g.league), a = named(qn, g.away, g.league);
      if (h && a) both.push(g); else if (h || a) one.push({ g: g, side: h ? 'home' : 'away', len: (h || a).len });
    });
    if (both.length === 1) return { game: both[0], via: 'named' };
    if (both.length > 1) return { game: null, why: 'that names more than one game on the sheets' };
    /* one team named: the longest match wins (Texas State over Texas); the
       same team on two upcoming weeks means its NEXT game */
    if (one.length) {
      one.sort(function (x, y) { return (y.len - x.len) || String(x.g.kickoff).localeCompare(String(y.g.kickoff)); });
      var top = one.filter(function (x) { return x.len === one[0].len; });
      var teamOf = function (x) { return norm(x.side === 'home' ? x.g.home : x.g.away); };
      var sameTeam = top.every(function (x) { return teamOf(x) === teamOf(top[0]); });
      if (top.length === 1 || sameTeam) return { game: top[0].g, via: 'team', side: top[0].side };
      return { game: null, why: 'that name matches more than one team\u2019s upcoming game' };
    }
    if (subject && subject.game_id) {
      var s = feed.games.filter(function (g) { return String(g.game_id) === String(subject.game_id); })[0];
      if (s) return { game: s, via: subject.from_screen ? 'screen' : 'conversation' };
    }
    return { game: null, why: 'no game is named and none is open' };
  }

  /** what is being asked: the intent, the side or team, and any quoted line and price */
  /* a player prop is the props desk's question, never this one */
  var PLAYER = /\b(rushing|receiving|passing|yards|yds|receptions?|catches|targets?|carries|completions?|interceptions?|touchdowns?|tds?|sacks?|tackles?|props?|player|anytime)\b/i;
  function classify(q, ctx) {
    q = String(q || '');
    if (!GATE.test(q) || PLAYER.test(q)) return null;
    var intent = /\bteam[\s-]?totals?\b|\bhow many points\b/i.test(q) ? 'TEAM_TOTAL' : ALT_TOTAL.test(q) ? 'ALT_TOTAL' : ALT_SPREAD.test(q) ? 'ALT_SPREAD' : (/\b(over|under)\b/i.test(q) ? 'ALT_TOTAL' : 'ALT_SPREAD');
    var price = /(?:^|[\s(@])([+-]\d{3,4})(?![\d.])/.exec(q);
    var ou = /\b(over|under|o|u)\s*(\d{1,3}(?:\.5)?)\b/i.exec(q);
    var spread = /(?:^|\s)([+-]\d{1,2}(?:\.5)?)(?=\s|$|[^\d.])/.exec(q.replace(/([+-]\d{3,4})(?![\d.])/g, ' '));
    var quote = { american: price ? Number(price[1]) : null };
    if (intent === 'TEAM_TOTAL' || intent === 'ALT_TOTAL') { if (ou) { quote.side = /^o/i.test(ou[1]) ? 'over' : 'under'; quote.line = Number(ou[2]); } }
    else if (spread) quote.line = Number(spread[1]);
    return { intent: intent, quote: quote };
  }

  function sideFor(q, g) {
    var qn = ' ' + norm(q) + ' ';
    var h = named(qn, g.home, g.league), a = named(qn, g.away, g.league);
    if (h && !a) return 'home'; if (a && !h) return 'away';
    if (h && a) {
      /* both named: the one written closest before "team total" (or before the line) */
      var k = qn.search(/ team ?totals? | [+-]?\d/);
      if (k >= 0) { var dh = k - h.at, da = k - a.at; if (dh >= 0 && (da < 0 || dh < da)) return 'home'; if (da >= 0) return 'away'; }
    }
    return null;
  }

  function statusLine(m, market) {
    if (!m) return '';
    var s = 'These ' + market + ' probabilities are ' + String(m.status || 'UNCALIBRATED').toLowerCase() + ' against outcomes on seasons the model never saw';
    s += m.tier && m.tier !== 'VALIDATED' ? ', and the model has not shown it beats the closing line here (' + String(m.tier).toLowerCase() + ').' : '.';
    return s;
  }

  /** the answer: deterministic text plus the structured block the panel renders */
  function answer(q, cls, feed, res, now) {
    var F = FL(); if (!F) return null;
    var g = res.game, m = g.markets || {}, md = feed.models && feed.models[g.sport] || null;
    var who = g.away + ' @ ' + g.home, lines = [], block = { schema: SCHEMA, version: VERSION, intent: cls.intent, game_id: g.game_id, sport: g.sport, league: g.league,
      source: 'football/linemaker/fair_lines.json', feed_generated_at: feed.generated_at || null, resolved_via: res.via, rungs: [], price_check: null };
    var built = Date.parse(feed.generated_at), age = isFinite(built) ? (now - built) / 36e5 : null;
    var q2 = cls.quote || {};
    if (cls.intent === 'TEAM_TOTAL') {
      var tt = m.team_total;
      if (!tt) return { text: 'EdgeDesk has no team-total sheet for ' + who + '.', block: block, intent: cls.intent };
      var side = sideFor(q, g) || res.side || null;
      if (!side) {
        lines.push('EdgeDesk’s fair team totals for ' + who + ': ' + g.home + ' ' + tt.home_fair_half + ', ' + g.away + ' ' + tt.away_fair_half + '.');
        lines.push('Middle 80% of outcomes: ' + g.home + ' ' + tt.home_p10 + '–' + tt.home_p90 + ', ' + g.away + ' ' + tt.away_p10 + '–' + tt.away_p90 + ' points.');
      } else {
        var team = side === 'home' ? g.home : g.away, fair = side === 'home' ? tt.home_fair_half : tt.away_fair_half;
        var line = q2.line != null ? q2.line : fair;
        var lad = F.ladder(g, side === 'home' ? 'home_team_total' : 'away_team_total');
        var rung = lad.filter(function (r) { return r.line === line; })[0];
        lines.push('EdgeDesk’s fair team total for ' + team + ' (' + who + ') is ' + fair + '.');
        if (rung) lines.push('At ' + line + ': over ' + pct(rung.over) + (rung.push > 0.0005 ? ', push ' + pct(rung.push) : '') + ', under ' + pct(rung.under) + ' (fair ' + am(rung.over_fair) + ' / ' + am(rung.under_fair) + ').');
        block.rungs = lad.filter(function (r) { return Math.abs(r.line - line) <= 2; });
        if (q2.american != null && q2.side && q2.line != null) {
          var pc = F.priceCheck(g, { market: 'team_total', team: side, side: q2.side, line: q2.line, american: q2.american }, md);
          block.price_check = pc;
          lines.push(priceSentence(team + ' ' + q2.side + ' ' + q2.line + ' at ' + am(q2.american), pc));
        }
      }
      lines.push((block.price_check && block.price_check.verdict !== 'NO_VALUE' ? '' : statusLine(tt, 'team-total') + ' ') + 'No closing team-total line is archived, so these have never been tested at a number the market posted, and EdgeDesk does not call a team-total price VALUE.');
    } else if (cls.intent === 'ALT_TOTAL') {
      var mt = m.total; if (!mt) return { text: 'EdgeDesk has no total sheet for ' + who + '.', block: block, intent: cls.intent };
      var L = q2.line != null ? q2.line : mt.fair_total_half;
      var lt = F.ladder(g, 'total');
      var r2 = lt.filter(function (r) { return r.line === L; })[0];
      lines.push('EdgeDesk’s fair total for ' + who + ' is ' + mt.fair_total_half + '.');
      if (r2) lines.push('At ' + L + ': over ' + pct(r2.over) + (r2.push > 0.0005 ? ', push ' + pct(r2.push) : '') + ', under ' + pct(r2.under) + ' (fair ' + am(r2.over_fair) + ' / ' + am(r2.under_fair) + ').');
      else if (q2.line != null) lines.push(L + ' is outside the published ladder (fair ± 10).');
      block.rungs = lt.filter(function (r) { return Math.abs(r.line - L) <= 3; });
      if (q2.american != null && q2.side && q2.line != null) {
        var pt = F.priceCheck(g, { market: 'total', side: q2.side, line: q2.line, american: q2.american }, md);
        block.price_check = pt; lines.push(priceSentence((q2.side === 'over' ? 'Over ' : 'Under ') + q2.line + ' at ' + am(q2.american), pt));
      }
      if (!block.price_check || block.price_check.verdict === 'NO_VALUE') lines.push(statusLine(mt, 'total'));
    } else {
      var ms = m.spread; if (!ms) return { text: 'EdgeDesk has no spread sheet for ' + who + '.', block: block, intent: cls.intent };
      var sd = sideFor(q, g) || res.side || 'home';
      var team2 = sd === 'home' ? g.home : g.away;
      var fairSide = sd === 'home' ? ms.fair_home_line_half : -ms.fair_home_line_half;
      var lineSide = q2.line != null ? q2.line : fairSide;
      var homeLine = sd === 'home' ? lineSide : -lineSide;
      var ls = F.ladder(g, 'spread');
      var r3 = ls.filter(function (r) { return r.home_line === homeLine; })[0];
      lines.push('EdgeDesk’s fair line for ' + who + ' is ' + team2 + ' ' + ln(fairSide) + '.');
      if (r3) { var cov = sd === 'home' ? r3.home : r3.away, fr = sd === 'home' ? r3.home_fair : r3.away_fair; lines.push('At ' + team2 + ' ' + ln(lineSide) + ': covers ' + pct(cov) + (r3.push > 0.0005 ? ', push ' + pct(r3.push) : '') + ' (fair ' + am(fr) + ').'); }
      else if (q2.line != null) lines.push(team2 + ' ' + ln(lineSide) + ' is outside the published ladder (fair ± 10).');
      block.rungs = ls.filter(function (r) { return Math.abs(r.home_line - homeLine) <= 3; });
      if (q2.american != null && q2.line != null) {
        var ps = F.priceCheck(g, { market: 'spread', side: sd, line: lineSide, american: q2.american }, md);
        block.price_check = ps; lines.push(priceSentence(team2 + ' ' + ln(lineSide) + ' at ' + am(q2.american), ps));
      }
      if (!block.price_check || block.price_check.verdict === 'NO_VALUE') lines.push(statusLine(ms, 'spread'));
    }
    if (age != null && age > 18) lines.push('The sheets were built ' + Math.round(age) + ' hours ago; the projection may have moved since.');
    if (res.via === 'screen') lines.push('(The game open on your screen.)');
    return { text: lines.join(' '), block: block, intent: cls.intent };
  }
  function priceSentence(label, pc) {
    if (!pc) return '';
    if (pc.verdict === 'CANNOT_EVALUATE') return label + ': cannot be evaluated (' + pc.why.join('; ') + ').';
    var head = pc.verdict === 'VALUE' ? 'VALUE' : pc.verdict === 'THIN' ? 'THIN' : 'NO VALUE';
    var base = label + ' is ' + head + ': it needs ' + pct(pc.break_even) + ' and EdgeDesk gives ' + pct(pc.cover_prob) + (pc.expected_roi != null ? ' (' + (pc.expected_roi > 0 ? '+' : '') + pct(pc.expected_roi) + ' per unit)' : '') + '.';
    /* a NO VALUE's only reason is the arithmetic just stated */
    return pc.verdict === 'NO_VALUE' ? base : base + ' ' + pc.why.map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1) + (/[.!?]$/.test(w) ? '' : '.'); }).join(' ');
  }

  return { VERSION: VERSION, SCHEMA: SCHEMA, FEED_SCHEMA: FEED_SCHEMA, GATE: GATE, classify: classify, resolveGame: resolveGame, answer: answer, _named: named, _sideFor: sideFor };
});
/*__EDLINESDESK_END__*/
