/*__EDPROPSDESK_START__*/
/* ============================================================================
   PLAYER PROPS FOR THE AI DESK — deterministic answers over the committed
   Player Props boards (football/props/<league>/board.json, written by
   build_board.js). docs/player-props/DESIGN.md §12.

   Answers, from those files and nothing else:
     "Should I bet Bijan Robinson over 84.5 rushing yards?"      PROP
     "What is Puka Nacua's fair line for receiving yards?"        PROP
     "Research Saquon Barkley rush yards under 71.5 -108"         PROP (a quote)
     "Is Bijan 71.5 -110 or 74.5 +105 better?"                    COMPARE
     "What does EdgeDesk project for Jalen Hurts?"                PLAYER
     "Best player props today?" / "Any props worth a look?"       BOARD
     "How does Drake London being out affect Bijan?"              INJURY

   Every number is one the board holds or EDProps computed from it through
   EDProps.boardEval — the evaluation the build ran and the Props page re-runs
   — so the desk says what the page says. A player the boards do not carry, a
   market EdgeDesk does not project for him, a name that fits two players, a
   missing or stale price: each is said, never filled in. allowedNumbers() and
   critic() hold any rephrasing to exactly those numbers and to the house
   vocabulary (never "lock", "best bet", "safe bet", "guaranteed").

   Node (module.exports) and the edge function (globalThis.EDPROPSDESK,
   inlined by tools/presentation/inline.js after EDProps).
   ========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDPROPSDESK = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var VERSION = 'props_desk_v1';
  var SCHEMA = 'edgedesk_props_desk_v1';
  var P0 = null;
  function P() {
    if (P0) return P0;
    if (typeof require === 'function' && typeof module === 'object' && module && module.exports) { try { P0 = require('../../lib/edgedesk_props.js'); } catch (_) { P0 = null; } }
    return P0 || (root && root.EDProps) || null;
  }
  function num(x) { return typeof x === 'number' && isFinite(x); }
  function nk(s) { var v = String(s == null ? '' : s).toLowerCase(); try { v = v.normalize('NFKD').replace(/[̀-ͯ]/g, ''); } catch (_) {} return v.replace(/[’']/g, '').replace(/[^a-z0-9.+\-\s]/g, ' ').replace(/\s+/g, ' ').trim(); }
  function f1(x) { return num(x) ? (Math.round(x * 10) / 10).toFixed(1) : '—'; }
  function pct(x) { return num(x) ? (100 * x).toFixed(1) + '%' : '—'; }
  function spct(x) { return num(x) ? (x >= 0 ? '+' : '−') + Math.abs(100 * x).toFixed(1) + '%' : '—'; }
  function pp(x) { return num(x) ? (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(1) + ' pp' : '—'; }
  function am(a) { return num(a) ? (a > 0 ? '+' + Math.round(a) : '−' + Math.abs(Math.round(a))) : '—'; }
  function dec(a) { return a > 0 ? 1 + a / 100 : 1 + 100 / -a; }
  function side(s) { return s === 'over' ? 'Over' : s === 'under' ? 'Under' : '—'; }
  /* "EdgeDesk projects …" / "Team implied …" → a clause; names and EdgeDesk keep their capitals */
  function sentence(t) { t = String(t || '').replace(/\.$/, ''); return /^[A-Z][a-z]+(\s|$)/.test(t) && !/^EdgeDesk\b/.test(t) && !/^[A-Z][a-z]+ [A-Z]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t; }

  /* ------------------------------------------------------------- the words */
  var MARKET_RX = [
    ['rush_rec_yds', /\b(rush(ing)?\s*(\+|and|&)\s*rec(eiving)?|scrimmage)\s*(yards|yds)?\b/],
    ['pass_rush_yds', /\bpass(ing)?\s*(\+|and|&)\s*rush(ing)?\s*(yards|yds)?\b/],
    ['rec_long', /\blongest\s+(reception|catch|rec)\b/],
    ['rush_long', /\blongest\s+(rush|run|carry)\b/],
    ['pass_long', /\blongest\s+(completion|pass)\b/],
    ['first_td', /\b(first|1st)\s+(td|touchdown)\b/],
    ['anytime_td', /\b(anytime\s+(td|touchdown)|score\s+(a\s+)?(td|touchdown)|td\s+scorer|touchdown\s+scorer|to\s+score)\b/],
    ['pass_tds', /\b(pass(ing)?\s+(td|tds|touchdowns?)|td\s+passes|touchdown\s+passes|throw\s+(a\s+)?(td|touchdown))\b/],
    ['rush_tds', /\brush(ing)?\s+(td|tds|touchdowns?)\b/],
    ['rec_tds', /\b(rec(eiving)?\s+(td|tds|touchdowns?))\b/],
    ['pass_ints', /\b(interceptions?\s+thrown|ints?\s+thrown|throw\s+(an?\s+)?(int|interception)|interceptions?|ints?)\b/],
    ['pass_cmp', /\b(completions?|comps?)\b/],
    ['pass_att', /\b(pass(ing)?\s+attempts?|pass\s+att|throws|attempts)\b/],
    ['pass_yds', /\b(pass(ing)?\s+(yards|yds|yardage)|throwing\s+yards)\b/],
    ['rush_att', /\b(rush(ing)?\s+attempts?|carries|rush\s+att)\b/],
    ['rush_yds', /\b(rush(ing)?\s+(yards|yds|yardage)|ground\s+yards)\b/],
    ['rec_yds', /\b(rec(eiving)?\s+(yards|yds|yardage)|receiving)\b/],
    ['receptions', /\b(receptions?|catches|recs)\b/],
    ['targets', /\btargets?\b/],
    ['fg_made', /\bfield\s+goals?(\s+made)?\b/],
    ['kicking_pts', /\bkicking\s+points\b/],
    ['tackles_ast', /\b(tackles?(\s*(\+|and)\s*assists?)?)\b/],
    ['sacks', /\bsacks?\b/]
  ];
  var PROPS_WORD = /\b(props?|player props?|over\s*\/\s*under|o\/u)\b/;
  var BOARD_RX = /\b(best|top|strongest|biggest|most interesting|worth (researching|a look|betting)|any)\b[^?]*\bprops?\b|\bprops?\b[^?]*\b(today|tonight|this week|slate|board|worth)\b/;
  var INJ_RX = /\b(out|injur\w*|inactive|ruled out|doesnt play|does not play|sits|sitting|miss(es|ing)?|without)\b/;
  var COLLEGE_RX = /\b(college|cfb|ncaa|fbs|ncaaf)\b/;
  var NFL_RX = /\bnfl\b/;
  /* first names that are also everyday words, places or team names: never a
     player on their own */
  var COMMON_FIRST = {};
  ('will mark grant chase hunter miles justice king major rich love young dallas austin houston jordan tyler lane cash drew deep brandon ' +
   'carolina denver phoenix orlando memphis tennessee cleveland indiana georgia kansas cameron mason max marshall rice price rush ' +
   'bishop dean frank earl guy hope jack john james jake josh chris mike matt nick sam dan joe').split(' ').forEach(function (w) { COMMON_FIRST[w] = 1; });
  var BOOKS = { draftkings: /\b(draftkings|dk)\b/, fanduel: /\b(fanduel|fd)\b/, betmgm: /\b(betmgm|mgm)\b/, williamhill_us: /\b(caesars|william hill)\b/, espnbet: /\b(espn ?bet)\b/, fanatics: /\bfanatics\b/, betrivers: /\bbetrivers\b/, hardrockbet: /\bhard ?rock\b/, pinnacle: /\bpinnacle\b/ };

  function marketOf(q) { var s = nk(q); for (var i = 0; i < MARKET_RX.length; i++) if (MARKET_RX[i][1].test(s)) return MARKET_RX[i][0]; return null; }
  /* "over 84.5", "o84.5", "u 6.5", "84.5 -110", "+120", "at DraftKings" */
  function quoteOf(q) {
    var s = nk(q), out = { side: null, line: null, american: null, book: null, quotes: [] }, m;
    var re = /\b(over|under|o|u)\s*(\d{1,3}(?:\.\d)?)\b(?:\s*(?:at\s+)?([+\-]\d{3,4}))?/g;
    while ((m = re.exec(s))) out.quotes.push({ side: m[1][0] === 'o' ? 'over' : 'under', line: +m[2], american: m[3] ? +m[3] : null });
    if (!out.quotes.length) { var re2 = /\b(\d{1,3}\.5)\s+([+\-]\d{3,4})\b/g; while ((m = re2.exec(s))) out.quotes.push({ side: null, line: +m[1], american: +m[2] }); }
    if (out.quotes.length) { out.side = out.quotes[0].side; out.line = out.quotes[0].line; out.american = out.quotes[0].american; }
    if (!num(out.american)) { var mp = s.match(/(^|\s)([+\-]\d{3,4})\b/); if (mp) out.american = +mp[2]; }
    Object.keys(BOOKS).forEach(function (k) { if (!out.book && BOOKS[k].test(s)) out.book = k; });
    return out;
  }
  /* everyone on the boards, one entry per player (his nearest game) */
  function roster(boards) {
    var out = [], seen = {};
    ['nfl', 'cfb'].forEach(function (L) {
      var b = boards && boards[L]; if (!b || !b.players) return;
      var games = P().boardGames(b);
      Object.keys(b.players).map(function (k) { return b.players[k]; }).sort(function (a, c) { return Date.parse((games[a.g] || {}).kickoff || 0) - Date.parse((games[c.g] || {}).kickoff || 0); })
        .forEach(function (x) { if (!x || !x.id || seen[L + x.id]) return; seen[L + x.id] = 1; out.push({ league: L, pid: x.id, name: x.name, pos: x.pos, team: x.team, g: x.g }); });
    });
    return out;
  }
  /* the players a question names — an ambiguous name is refused, never guessed */
  function playersIn(q, boards) {
    var Pp = P(); if (!Pp) return { players: [], ambiguous: [] };
    var s = ' ' + nk(q) + ' ', found = [], amb = [], byLast = {}, byFirst = {}, seen = {};
    roster(boards).forEach(function (r) {
      var n = nk(r.name); if (!n) return;
      var parts = n.replace(/\b(jr|sr|ii|iii|iv)\.?$/, '').trim().split(' '), last = parts[parts.length - 1], first = parts.length > 1 ? parts[0] : null;
      if (!seen[r.league + r.pid] && (s.indexOf(' ' + n + ' ') >= 0 || s.indexOf(' ' + parts.join(' ') + ' ') >= 0)) { seen[r.league + r.pid] = 1; found.push(r); }
      if (last && last.length >= 4) (byLast[last] = byLast[last] || []).push(r);
      if (first && first.length >= 4 && !COMMON_FIRST[first]) (byFirst[first] = byFirst[first] || []).push(r);
    });
    var named = function (w, list) { return found.some(function (f) { return list.indexOf(f) >= 0 || nk(f.name).split(' ').indexOf(w) >= 0; }); };
    var fits = function (w) { return s.indexOf(' ' + w + ' ') >= 0 || s.indexOf(' ' + w + 's ') >= 0; };
    var who = function (x) { return x.name + ' (' + x.team + ' ' + x.pos + ', ' + x.league.toUpperCase() + ')'; };
    Object.keys(byLast).forEach(function (last) {
      if (!fits(last) || named(last, byLast[last])) return;
      var list = byLast[last];
      if (list.length === 1) found.push(list[0]);
      else amb.push({ surname: last, candidates: list.slice(0, 6).map(who) });
    });
    /* a first name alone ("Bijan") names a player only when no one else on
       the boards shares it and it is not an everyday word or a place */
    Object.keys(byFirst).forEach(function (first) {
      if (!fits(first) || named(first, byFirst[first]) || byLast[first]) return;
      if (byFirst[first].length === 1) found.push(byFirst[first][0]);
    });
    /* order by where each name appears in the question */
    found.sort(function (a, c) { return s.indexOf(nk(a.name).split(' ').pop()) - s.indexOf(nk(c.name).split(' ').pop()); });
    return { players: found, ambiguous: amb };
  }

  /* ------------------------------------------------------------- intent */
  function classify(q, boards) {
    var s = nk(q);
    if (!s || s.length > 400) return null;
    var market = marketOf(q), pl = playersIn(q, boards), qt = quoteOf(q);
    var names = pl.players.length > 0 || pl.ambiguous.length > 0;
    if (!names && BOARD_RX.test(s)) return { intent: 'BOARD', players: pl, market: market, quote: qt, league: COLLEGE_RX.test(s) ? 'cfb' : (NFL_RX.test(s) ? 'nfl' : null) };
    if (!names) return null;
    if (pl.players.length >= 2 && INJ_RX.test(s)) return { intent: 'INJURY', players: pl, market: market, quote: qt };
    if (qt.quotes.length >= 2) return { intent: 'COMPARE', players: pl, market: market, quote: qt };
    if (market) return { intent: 'PROP', players: pl, market: market, quote: qt };
    if (PROPS_WORD.test(s) || /\b(project(ion|s|ed)?|fair line|expect|outlook|how many)\b/.test(s)) return { intent: 'PLAYER', players: pl, market: null, quote: qt };
    return null;
  }

  /* --------------------------------------------------------- the pieces */
  function label(m) { var d = P().MARKETS[m]; return d ? d.label : m; }
  function lower(m) { return label(m).toLowerCase().replace(/\btd(s?)\b/g, 'TD$1'); }
  function rowFor(board, pid, market, g) { var rs = (board && board.props) || []; for (var i = 0; i < rs.length; i++) if (rs[i].p === pid && rs[i].m === market && (!g || rs[i].g === g)) return rs[i]; return null; }
  function matchup(board, g) { var x = P().boardGames(board)[g] || {}; return (x.away_name || x.away || '') + ' @ ' + (x.home_name || x.home || ''); }
  function stageText(board, m) {
    var st = board.stages && board.stages[m];
    if (!st) return '';
    return st.stage === 'EXPERIMENTAL' ? 'This market is EXPERIMENTAL: it has not passed EdgeDesk’s walk-forward validation gates, so a decision on it is capped at LEAN and carries no units.'
      : 'This market is ' + P().STAGE_LABEL[st.stage] + ' (it passed its walk-forward gates).';
  }

  /* the board's exposure caps now (EDProps.boardExposure over every priced
     row re-evaluated at this moment), as the build and the page apply them */
  function keyOf(board, r) { return r.key || r.id || (board.league + '|' + r.g + '|' + r.p + '|' + r.m); }
  function exposureMap(board, now, evs) {
    var E = P(), byKey = {};
    if (evs) evs.forEach(function (x) { byKey[keyOf(board, x.r)] = E.compact(x.ev); });
    else (board.props || []).forEach(function (r) { if (r.p && r.q && r.q.length) { try { byKey[keyOf(board, r)] = E.compact(E.boardEval(board, r, now)); } catch (e) { /* the build's row stands */ } } });
    return E.boardExposure(board, byKey) || {};
  }

  /* ---------------------------------------------------------- the answers */
  function propText(board, row, now, qt) {
    var E = P(), ev = E.boardEval(board, row, now), ctx = E.boardCtx(board, row) || {};
    if (ev.decision === 'BET' && ev.units > 0) ev = E.applyExposure(ev, exposureMap(board, now)[keyOf(board, row)]);
    var inf = ev.informed, c = ev.consensus || {}, ac = ev.at_consensus, cand = ev.candidate, L = [];
    L.push(ctx.name + ' — ' + lower(row.m) + ' (' + matchup(board, row.g) + ').' + (stageText(board, row.m) ? ' ' + stageText(board, row.m) : ''));
    if (!inf) { L.push('EdgeDesk has no usable projection for it (' + (ev.blocker_text || 'no distribution') + '), so there is no fair line and no edge to state.'); return { text: L.join(' '), ev: ev }; }
    var yesno = E.MARKETS[row.m] && E.MARKETS[row.m].yesno;
    if (yesno) { var py = E.probLine(ev._dist.informed, 0.5); L.push('EdgeDesk gives him a ' + pct(py.over) + ' chance (fair odds ' + am(E.fairAmerican(py.over, 0)) + ').'); }
    else L.push('EdgeDesk projects a mean of ' + f1(inf.mean) + ' and a median of ' + f1(inf.median) + ' — its fair line, where Over and Under are even (the middle half of outcomes between ' + f1(inf.p25) + ' and ' + f1(inf.p75) + ')' + (ev.raw && Math.abs(ev.raw.mean - inf.mean) > 0.05 ? '; the raw model alone says ' + f1(ev.raw.mean) + ' before the declared ' + Math.round(100 * ev.market_weight) + '% market blend' : '') + '.');
    var st = ctx.status && ctx.status.status;
    if (st) L.push('Status: ' + st + (ctx.status.practice ? ' (' + ctx.status.practice + ' practice)' : '') + '.');
    if (!ev.n_quotes) L.push('No sportsbook price is captured for this prop, so EdgeDesk shows its projection only and claims no expected value.');
    else if (!c.n_books) {
      /* EDProps' one rule: no captured price is executable, so none is priced;
         the projection above stands, and the last price seen is reference only */
      var ps = ev.price_status || {}, win = E.FRESHNESS ? E.FRESHNESS.executable_max_minutes : 30;
      L.push(ps.state === 'PROVIDER_FAILURE' ? 'The last price check for this game failed and no captured price is current, so EdgeDesk decides nothing on it until prices return.'
        : ps.state === 'MARKET_CLOSED' ? 'The sportsbooks have pulled this market, so EdgeDesk decides nothing on it.'
        : 'No captured price is inside the ' + win + '-minute execution window' + (num(ps.age_minutes) ? ' (the newest is ' + E.ageText(ps.age_minutes) + ')' : '') + ', so EdgeDesk decides nothing on it and waits for a current price.');
    }
    else {
      L.push((yesno ? 'Captured by ' + c.n_books + ' book' + (c.n_books === 1 ? '' : 's') + '.' : 'The books’ consensus line is ' + c.line + ' (' + c.n_books + ' book' + (c.n_books === 1 ? '' : 's') + ').') +
        (ac && !yesno ? ' At that line EdgeDesk has P(Over) ' + pct(ac.over) + ' and P(Under) ' + pct(ac.under) + ' (fair odds ' + am(ac.fair_over) + ' / ' + am(ac.fair_under) + ')' + (num(c.novig_over) ? ', against a no-vig market of ' + pct(c.novig_over) + ' for the Over.' : '.') : ''));
      if (cand) L.push('Best value: ' + E.selectionText(row.m, cand.side, cand.line) + ' ' + am(cand.american) + ' at ' + E.bookName(cand.book) + ': P(win) ' + pct(cand.p_win) + ', fair ' + am(cand.fair_american) + ', edge ' + pp(cand.edge_pp) + ', EV ' + spct(cand.ev) + '.');
    }
    if (ev.n_quotes) L.push('EdgeDesk decision: ' + ev.decision_label + (ev.decision === 'BET' && ev.units ? ' ' + E.unitsText(ev.units) : '') + ' — ' + sentence(ev.caps && ev.caps.length ? ev.caps[ev.caps.length - 1].text : (ev.blocker_text || codeText(ev.code))) + '.' + (ev.trigger && ev.trigger.realistic && ev.trigger.text ? ' It ' + ev.trigger.text + '.' : ''));
    /* the data factory's walk-forward-validated distribution, when the board
       joined one for this prop (EDProps.factoryView): evidence beside the
       decision, never the decision */
    if (row.fx && board.factory && board.factory.state === 'JOINED' && typeof E.factoryView === 'function') {
      var fl = cand ? cand.line : (ac ? ac.line : (yesno ? 0.5 : null)), fs = cand ? cand.side : (ac && ac.over < ac.under ? 'under' : 'over');
      var fv = E.factoryView(row.fx, board.factory, fl, fs, cand ? cand.american : null);
      var tier = fv ? ({ OUTCOME_VALIDATED: 'skill in every fold', OUTCOME_LEAN: 'positive skill on average', RESEARCH: 'research only' }[fv.tier] || 'research only') : null;
      if (fv && num(fv.p_side)) {
        var engP = cand ? cand.p_win : (ac ? (fs === 'over' ? ac.over : ac.under) : (yesno ? E.probLine(ev._dist.informed, 0.5).over : null));
        L.push('The validated model (walk-forward, ' + tier + ') has ' + (yesno ? 'the Yes' : side(fs) + ' ' + fl) + ' at ' + pct(fv.p_side) +
          (num(engP) ? (Math.abs(fv.p_side - engP) < 0.03 ? ', in line with the engine' : ((fv.p_side >= 0.5) === (engP >= 0.5) ? ', the same lean as the engine' : ', against the engine’s ' + pct(engP))) : '') +
          (num(fv.ev) ? ' (EV ' + spct(fv.ev) + ' at ' + am(fv.american) + ')' : '') + '; it is evidence beside the decision, not the decision.');
      } else if (fv && num(fv.median)) {
        L.push('The validated model (walk-forward, ' + tier + ') has a median of ' + f1(fv.median) + ' (80% range ' + f1(fv.p10) + '–' + f1(fv.p90) + ').');
      }
    }
    /* a quote the reader named, priced on the same distribution */
    if (qt && num(qt.line) && (qt.side === 'over' || qt.side === 'under') && !yesno) {
      /* a captured price stands in for a missing one only while it is inside
         the decision window: a stale price is never priced as current */
      var inp = E.boardInput(board, row, now), quotes = inp.quotes;
      var dealt = quotes.filter(function (q) { return q.side === qt.side && Math.abs(q.line - qt.line) < 1e-9 && (!qt.book || q.book === qt.book); });
      var xc = { now: now, kickoff: inp.kickoff, game_status: inp.game_status, market_status: inp.market_status, freshness: board.freshness || null };
      var atLine = dealt.filter(function (q) { return E.isExecutableQuote(q, xc).executable; }).sort(function (a, b) { return dec(b.american) - dec(a.american); });
      var price = num(qt.american) ? qt.american : (atLine[0] ? atLine[0].american : null);
      var same = cand && cand.side === qt.side && Math.abs(cand.line - qt.line) < 1e-9 && cand.american === price;
      if (price == null) L.push((dealt.length ? 'Every captured price for ' + side(qt.side) + ' ' + qt.line + ' is past the execution window' : 'No captured book deals ' + side(qt.side) + ' ' + qt.line) + ', and no price was given, so EdgeDesk will not price it (it never assumes −110).');
      else if (!same) {
        var pr = E.probLine(ev._dist.informed, qt.line), pw = qt.side === 'over' ? pr.over : pr.under, ppush = pr.push, dd = dec(price);
        var evq = pw * (dd - 1) - (1 - pw - ppush), be = 1 / dd, cover = pw / Math.max(1e-9, 1 - ppush);
        L.push('Your quote, ' + side(qt.side) + ' ' + qt.line + ' ' + am(price) + (num(qt.american) ? '' : ' (the best captured price at that line, ' + E.bookName(atLine[0].book) + ')') + (qt.book ? ' at ' + E.bookName(qt.book) : '') + ': P(win) ' + pct(pw) + (ppush > 0 ? ' (push ' + pct(ppush) + ')' : '') + ', fair ' + am(E.fairAmerican(pw, ppush)) + ', break-even ' + pct(be) + ', edge ' + pp(100 * (cover - be)) + ', EV ' + spct(evq) + '.' +
          (atLine.some(function (q) { return q.american === price; }) ? '' : ' No captured book is dealing exactly that price right now, so it is priced as given.'));
      }
    }
    /* the why and the risks are read against a real book line only: the page's
       placeholder line (median + 0.5) is a display default, not a market */
    if (num(c.line) || yesno) {
      var f = E.factsFor({ market: row.m, player: ctx, env: ctx.env, lead: null, league_implied: board.league_implied, line: num(c.line) ? c.line : null,
        consensus_price: cand ? (cand.side === 'over' ? c.over : c.under) : null, hist: null, no_targets: board.sources && board.sources.caps && board.sources.caps.targets === false });
      var fav = cand ? cand.side : (ac && ac.over >= ac.under ? 'over' : 'under'), x = E.explain(ev, f, fav);
      if (x.why && x.why.length) L.push('Why ' + side(fav).toLowerCase() + ': ' + x.why.slice(0, 3).map(sentence).join('; ') + '.');
      if (x.risks && x.risks.length) L.push('What could make it wrong: ' + x.risks.slice(0, 3).map(sentence).join('; ') + '.');
    }
    if (ev.confidence && num(ev.confidence.score)) L.push('Decision confidence ' + ev.confidence.score + '/100 — how much the number can be trusted, not the size of the edge. Probability source: ' + ev.probability_label + '.');
    L.push('Research, not picks.');
    return { text: L.join(' '), ev: ev };
  }
  function codeText(code) {
    var T = { QUALIFIES: 'the price clears EdgeDesk’s edge and EV thresholds', EDGE_BELOW_BET: 'a positive edge below the betting threshold', EDGE_TOO_SMALL: 'the edge is too small to act on', NO_POSITIVE_EV: 'no positive expected value at any captured price',
      MARKET_INFORMED_EV_NEGATIVE: 'positive only on the raw model; negative once the declared market blend is applied', NO_EXECUTABLE_PRICE: 'no price inside the executable band', SIZING_ZERO: 'no stake survives the sizing caps' };
    return T[code] || String(code || '').replace(/_/g, ' ').toLowerCase();
  }
  function playerText(board, who, now) {
    var E = P(), rows = board.props.filter(function (r) { return r.p === who.pid && r.g === who.g; });
    if (!rows.length) return null;
    var L = [who.name + ' (' + matchup(board, who.g) + '): EdgeDesk’s projections for every market it prices him in.'];
    rows.forEach(function (r) {
      var ev = E.boardEval(board, r, now), inf = ev.informed, c = ev.consensus || {}, cand = ev.candidate;
      if (!inf) return;
      L.push(label(r.m) + ': ' + (E.MARKETS[r.m] && E.MARKETS[r.m].yesno ? pct(E.probLine(ev._dist.informed, 0.5).over) + ' chance' : 'median ' + f1(inf.median) + ' (mean ' + f1(inf.mean) + ')') +
        (c.n_books ? ', book line ' + c.line + (cand ? ', best ' + side(cand.side) + ' ' + am(cand.american) + ' EV ' + spct(cand.ev) : '') + ', ' + ev.decision_label : (ev.n_quotes ? ', prices stale' : ', no price captured')) +
        (ev.stage === 'EXPERIMENTAL' ? ' [experimental]' : '') + '.');
    });
    var ctx = E.boardCtx(board, rows[0]) || {};
    if (ctx.status && ctx.status.status) L.push('Status: ' + ctx.status.status + '.');
    L.push('Research, not picks.');
    return L.join(' ');
  }
  function boardText(boards, league, now) {
    var E = P(), Ls = league ? [league] : ['nfl', 'cfb'], L = [], any = false;
    Ls.forEach(function (lg) {
      var b = boards[lg]; if (!b) return;
      var name = lg === 'nfl' ? 'NFL' : 'college football';
      var priced = b.props.filter(function (r) { return r.q && r.q.length && r.p; });
      if (!priced.length) { L.push('No sportsbook player-prop prices are captured for ' + name + ' right now, so EdgeDesk has no prop EV to rank; its projections and fair lines are on the Props page.'); return; }
      var evs = priced.map(function (r) { return { r: r, ev: E.boardEval(b, r, now) }; });
      var xp = exposureMap(b, now, evs);
      evs.forEach(function (x) { var a = xp[keyOf(b, x.r)]; if (a) x.ev = E.applyExposure(x.ev, a); });
      var act = evs.filter(function (x) { return (x.ev.decision === 'BET' || x.ev.decision === 'LEAN') && x.ev.candidate; }).sort(function (a, c) { return (c.ev.value_score || 0) - (a.ev.value_score || 0); }).slice(0, 5);
      var watch = evs.filter(function (x) { return x.ev.decision === 'WATCH' && x.ev.candidate; }).sort(function (a, c) { return (c.ev.candidate.ev || 0) - (a.ev.candidate.ev || 0); }).slice(0, 3);
      var who = function (x) { var ctx = E.boardCtx(b, x.r) || {}; return ctx.name || '—'; };
      if (!act.length) L.push('No ' + name + ' prop clears EdgeDesk’s thresholds at the captured prices (' + priced.length + ' priced).');
      else { any = true; L.push(name + ' props that clear a threshold, ranked by EdgeDesk’s value score: ' + act.map(function (x) { var cd = x.ev.candidate; return who(x) + ' ' + E.selectionText(x.r.m, cd.side, cd.line) + ' ' + am(cd.american) + ' at ' + E.bookName(cd.book) + ' (' + x.ev.decision_label + (x.ev.decision === 'BET' && x.ev.units ? ' ' + E.unitsText(x.ev.units) : '') + ', EV ' + spct(cd.ev) + ')'; }).join('; ') + '.'); }
      if (watch.length) L.push('Watch list: ' + watch.map(function (x) { return who(x) + ' ' + lower(x.r.m) + ' (' + sentence(x.ev.caps && x.ev.caps.length ? x.ev.caps[x.ev.caps.length - 1].text : codeText(x.ev.code)) + ')'; }).join('; ') + '.');
    });
    if (!L.length) return null;
    L.push(any ? 'Each is a research lead with its full distribution on the Props page; an EXPERIMENTAL market never carries units.' : 'Research, not picks.');
    return L.join(' ');
  }
  function injuryText(boards, a, b, q) {
    var E = P(), s = nk(q);
    var outOf = function (pl0) { var n = nk(pl0.name), last = n.split(' ').pop(), nm = '(' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '|' + last + ')';
      return new RegExp('\\bwithout\\s+' + nm + '\\b').test(s) || new RegExp('\\b' + nm + 's?\\s+(is\\s+|being\\s+|if\\s+|were\\s+|was\\s+|gets\\s+|goes\\s+)?(out|injured|inactive|ruled out|sits|sitting|misses|missing|doesnt play|does not play)\\b').test(s); };
    var absent = outOf(a) && !outOf(b) ? a : (outOf(b) && !outOf(a) ? b : a), player = absent === a ? b : a;
    if (absent.league !== player.league || absent.team !== player.team) return absent.name + ' and ' + player.name + ' are not teammates on EdgeDesk’s boards, so one does not move the other’s share.';
    var board = boards[player.league], pr = board ? board.props.find(function (r) { return r.p === player.pid; }) : null;
    var ctx = pr ? E.boardCtx(board, pr) : null;
    if (!ctx) return 'EdgeDesk has no current projection for ' + player.name + '.';
    var hit = (ctx.teammates_out || []).filter(function (t) { return t.id === absent.pid || nk(t.name) === nk(absent.name); });
    var sa = null; (board.props || []).some(function (r) { if (r.p === absent.pid) { sa = E.boardCtx(board, r); return true; } return false; });
    var st = sa && sa.status && sa.status.status ? sa.status.status : null;
    if (!hit.length) return 'EdgeDesk’s current projection does not treat ' + absent.name + ' as out' + (st ? ' (listed ' + st + ')' : ' (no designation on file)') + ', so none of his share is moved to ' + player.name + '. A questionable player’s absence is not simulated in advance: the board re-prices when the status changes.';
    return hit.map(function (t) { return 'EdgeDesk lists ' + t.name + ' as ' + (t.status || 'out') + ', and ' + player.name + '’s projection already carries +' + pct(t.delta) + ' ' + (t.label || 'share') + ' from it'; }).join('; ') + '. The model moves an absent player’s share within the position group by recent usage, not all of it to one teammate; every projection on the board already includes it. Research, not picks.';
  }

  /* the one entry point: the boards the host read, the question → answer */
  function answer(q, cls, boards, now) {
    var E = P();
    if (!E || !cls) return { text: null };
    if (cls.intent === 'BOARD') return { intent: 'BOARD', text: boardText(boards, cls.league, now) };
    var pl = cls.players;
    if (!pl.players.length && pl.ambiguous.length) return { intent: 'AMBIGUOUS', text: 'More than one player on EdgeDesk’s prop boards matches "' + pl.ambiguous[0].surname + '": ' + pl.ambiguous[0].candidates.join(', ') + '. Which one do you mean?' };
    var who = pl.players[0], board = boards[who.league];
    if (!board) return { intent: cls.intent, text: 'EdgeDesk’s ' + who.league.toUpperCase() + ' prop board could not be read right now, so there is no number to give.' };
    if (cls.intent === 'PLAYER') return { intent: 'PLAYER', player: who, text: playerText(board, who, now) || who.name + ' has no current prop projection on the board.' };
    if (cls.intent === 'INJURY') return { intent: 'INJURY', text: injuryText(boards, pl.players[0], pl.players[1], q) };
    var market = cls.market;
    if (cls.intent === 'COMPARE' && !market) { var cand = board.props.filter(function (r) { return r.p === who.pid && r.g === who.g; }).map(function (r) { return r.m; }); market = who.pos === 'RB' && cand.indexOf('rush_yds') >= 0 ? 'rush_yds' : (cand.indexOf('rec_yds') >= 0 ? 'rec_yds' : cand[0]); }
    var row = rowFor(board, who.pid, market, who.g);
    if (!row) {
      var anywhere = boards && Object.keys(boards).some(function (L) { return (boards[L].props || []).some(function (r) { return r.m === market && r.x && r.x.dist; }); });
      return { intent: cls.intent, player: who, text: anywhere ? 'EdgeDesk has no current ' + lower(market) + ' projection for ' + who.name + '.' : 'EdgeDesk does not project ' + lower(market) + ' props on its current boards, so it has no fair line, probability or edge for them.' };
    }
    if (cls.intent === 'COMPARE') {
      var ev = E.boardEval(board, row, now);
      if (!ev._dist) return { intent: 'COMPARE', text: 'EdgeDesk has no usable distribution for ' + who.name + '’s ' + lower(market) + '.' };
      var qs = cls.quote.quotes.slice(0, 2).map(function (x) { return { side: x.side || 'over', line: x.line, american: num(x.american) ? x.american : null, assumed: !x.side }; });
      if (qs.some(function (x) { return x.american == null; })) return { intent: 'COMPARE', text: 'Give both prices to compare the two quotes: EdgeDesk never assumes −110.' };
      var one = function (x) { var pr = E.probLine(ev._dist.informed, x.line), pw = x.side === 'over' ? pr.over : pr.under, pu = pr.push, d0 = dec(x.american); return { pw: pw, pu: pu, ev: pw * (d0 - 1) - (1 - pw - pu), be: 1 / d0, fair: E.fairAmerican(pw, pu), cover: pw / Math.max(1e-9, 1 - pu) }; };
      var A = one(qs[0]), B = one(qs[1]);
      var t = function (x, r0) { return side(x.side) + ' ' + x.line + ' ' + am(x.american) + ': P(win) ' + pct(r0.pw) + (r0.pu > 0 ? ' (push ' + pct(r0.pu) + ')' : '') + ', fair ' + am(r0.fair) + ', break-even ' + pct(r0.be) + ', EV ' + spct(r0.ev); };
      return { intent: 'COMPARE', text: who.name + ' ' + lower(market) + ', both priced on EdgeDesk’s one distribution (median ' + f1(ev.informed.median) + '). ' + t(qs[0], A) + '. ' + t(qs[1], B) + '. The ' + (A.ev >= B.ev ? 'first' : 'second') + ' has the higher EV; the ' + (A.cover >= B.cover ? 'first' : 'second') + ' has the higher probability — the higher-probability quote is not the better one when its price costs more than the extra probability is worth.' + (qs.some(function (x) { return x.assumed; }) ? ' No side was named, so both are read as Overs; say Under to price the other side.' : '') + ' Research, not picks.' };
    }
    var r = propText(board, row, now, cls.quote);
    return { intent: 'PROP', player: who, row: row, text: r.text, evaluation: r.ev };
  }

  /* ----------------------------------------------- what may be rephrased */
  function numbersIn(s) { return (String(s || '').replace(/−/g, '-').match(/[+\-]?\d+(?:\.\d+)?/g) || []).map(function (x) { return String(Math.abs(parseFloat(x))); }); }
  function allowedNumbers(out) { var set = {}; numbersIn(out && out.text).forEach(function (n) { set[n] = 1; }); return set; }
  var BANNED = /\b(lock|locks|best bet|safe bet|sure thing|can'?t lose|guarantee(d)?|free money|max bet|hammer)\b/i;
  function critic(prose, out) {
    var findings = [], allow = allowedNumbers(out);
    numbersIn(prose).forEach(function (n) { if (!allow[n]) findings.push({ code: 'NUMBER_NOT_IN_ANSWER', detail: n }); });
    if (BANNED.test(String(prose || ''))) findings.push({ code: 'BANNED_WORD', detail: String(prose).match(BANNED)[0] });
    if (/\b(will (go|hit|clear|stay)|is going to)\b/i.test(String(prose || ''))) findings.push({ code: 'CERTAINTY', detail: 'an outcome stated as certain' });
    return { verdict: findings.length ? 'FAIL' : 'PASS', findings: findings };
  }
  var NARRATION_CONTRACT = ['You rewrite EdgeDesk’s player-prop research answer for a bettor, plainly and briefly.',
    'Use only the numbers, players and markets in the answer; never add, round differently, or recalculate one. Never promise an outcome.',
    'Never call anything a lock, a best bet, a safe bet or guaranteed. Keep "Research, not picks." Return only the rewritten answer.'].join(' ');

  return { VERSION: VERSION, SCHEMA: SCHEMA, classify: classify, marketOf: marketOf, quoteOf: quoteOf, playersIn: playersIn, answer: answer,
    allowedNumbers: allowedNumbers, critic: critic, NARRATION_CONTRACT: NARRATION_CONTRACT };
});
/*__EDPROPSDESK_END__*/
