/*__EDPROPSDESK_START__*/
/* ============================================================================
   PLAYER PROPS FOR THE AI DESK — deterministic answers over the committed
   player-prop files (football/props/<league>/board.json, games/<id>.json,
   markets/<id>.json, players_index.json). docs/player-props/AI.md

   Answers, from those files and nothing else:
     "Should I bet Puka Nacua over 78.5 receiving yards?"        PROP
     "What is Davante Adams' fair line for receiving yards?"      PROP
     "Research Saquon Barkley rushing yards under 71.5 -108"      PROP (a quote)
     "Is Bijan 71.5 -110 or 74.5 +105 better?"                    COMPARE
     "What does EdgeDesk project for Puka Nacua?"                 PLAYER
     "Best player props today?" / "Any props worth researching?"  BOARD
     "Which props in Rams at Eagles?"                             GAME
     "How does Nacua being out affect Adams?"                     INJURY

   Every number in an answer is a number the files hold or EDProps computed
   from them (EDProps.prepare — the one function the board and the research
   drawer run), so the desk says what the board says. A player the board does
   not carry, a prop EdgeDesk does not model, a name that fits two players, a
   missing or stale price: each is said, never filled in. allowedNumbers()
   and critic() hold any rephrasing to exactly those numbers and to the house
   vocabulary (never "lock", "best bet", "safe bet", "guaranteed").

   Node (module.exports) and the edge function (globalThis.EDPROPSDESK,
   inlined by tools/presentation/inline.js). Needs EDProps.
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
  function side(s) { return s === 'over' ? 'Over' : s === 'under' ? 'Under' : s === 'yes' ? 'Yes' : s === 'no' ? 'No' : '—'; }

  /* ------------------------------------------------------------- the words */
  var PROP_RX = [
    ['rush_rec_yds', /\b(rush(ing)?\s*(\+|and|&)\s*rec(eiving)?|scrimmage)\s*(yards|yds)?\b/],
    ['pass_rush_yds', /\bpass(ing)?\s*(\+|and|&)\s*rush(ing)?\s*(yards|yds)?\b/],
    ['longest_rec', /\blongest\s+(reception|catch|rec)\b/],
    ['longest_rush', /\blongest\s+(rush|run|carry)\b/],
    ['longest_cmp', /\blongest\s+(completion|pass)\b/],
    ['anytime_td', /\b(anytime\s+(td|touchdown)|score\s+(a\s+)?(td|touchdown)|td\s+scorer|touchdown\s+scorer|to\s+score)\b/],
    ['pass_tds', /\b(pass(ing)?\s+(td|tds|touchdowns?)|td\s+passes|touchdown\s+passes|throw\s+(a\s+)?(td|touchdown))\b/],
    ['pass_int', /\b(interceptions?|ints?|picks?\s+thrown)\b/],
    ['pass_cmp', /\b(completions?|comps?)\b/],
    ['pass_att', /\b(pass(ing)?\s+attempts?|pass\s+att|throws|attempts)\b/],
    ['pass_yds', /\b(pass(ing)?\s+(yards|yds|yardage)|throwing\s+yards)\b/],
    ['rush_att', /\b(rush(ing)?\s+attempts?|carries|rush\s+att)\b/],
    ['rush_yds', /\b(rush(ing)?\s+(yards|yds|yardage)|ground\s+yards)\b/],
    ['rec_yds', /\b(rec(eiving)?\s+(yards|yds|yardage)|receiving)\b/],
    ['receptions', /\b(receptions?|catches|recs)\b/],
    ['targets', /\btargets?\b/]
  ];
  var UNMODELED_RX = /\b(tackles?|sacks?|field goals?|kicking points|kicker|defensive interceptions?|punts?|return yards)\b/;
  var PROPS_WORD = /\b(props?|player props?|over\s*\/\s*under|o\/u)\b/;
  var BOARD_RX = /\b(best|top|strongest|favorite|biggest|most interesting|worth (researching|a look|betting)|any)\b[^?]*\bprops?\b|\bprops?\b[^?]*\b(today|tonight|this week|slate|board|worth)\b/;
  var INJ_RX = /\b(out|injur\w*|inactive|ruled out|doesn'?t play|does not play|sits|sitting|miss(es|ing)?|without)\b/;
  var COLLEGE_RX = /\b(college|cfb|ncaa|fbs|ncaaf)\b/;
  var NFL_RX = /\bnfl\b/;
  var BOOKS = { draftkings: /\b(draftkings|dk)\b/, fanduel: /\b(fanduel|fd)\b/, betmgm: /\b(betmgm|mgm)\b/, williamhill_us: /\b(caesars|william hill)\b/, espnbet: /\b(espn ?bet)\b/, fanatics: /\bfanatics\b/, betrivers: /\bbetrivers\b/, pinnacle: /\bpinnacle\b/ };

  function propOf(q) { var s = nk(q); for (var i = 0; i < PROP_RX.length; i++) if (PROP_RX[i][1].test(s)) return PROP_RX[i][0]; return null; }
  /* "over 78.5", "o78.5", "u 6.5", "78.5 -110", "+120", "at DraftKings" */
  function quoteOf(q) {
    var s = nk(q), out = { side: null, line: null, american: null, book: null, quotes: [] };
    var re = /\b(over|under|o|u)\s*(\d{1,3}(?:\.\d)?)\b(?:\s*(?:at\s+)?([+\-]\d{3,4}))?/g, m;
    while ((m = re.exec(s))) out.quotes.push({ side: m[1][0] === 'o' ? 'over' : 'under', line: +m[2], american: m[3] ? +m[3] : null });
    /* "71.5 -110 or 74.5 +105": a line and a price with no side word */
    if (!out.quotes.length) { var re2 = /\b(\d{1,3}\.5)\s+([+\-]\d{3,4})\b/g; while ((m = re2.exec(s))) out.quotes.push({ side: null, line: +m[1], american: +m[2] }); }
    if (out.quotes.length) { out.side = out.quotes[0].side; out.line = out.quotes[0].line; out.american = out.quotes[0].american; }
    if (!num(out.american)) { var mp = s.match(/(^|\s)([+\-]\d{3,4})\b/); if (mp) out.american = +mp[2]; }
    if (/\byes\b/.test(s) && !out.side) out.side = 'yes';
    Object.keys(BOOKS).forEach(function (k) { if (!out.book && BOOKS[k].test(s)) out.book = k; });
    return out;
  }
  /* the players a question names, from the boards' player index:
     [{league, pid, name, team, pos, method}] — an ambiguous name is refused */
  function playersIn(q, index) {
    var Pp = P(); if (!Pp) return { players: [], ambiguous: [] };
    var s = ' ' + nk(q) + ' ', found = [], amb = [], seen = {};
    var byLast = {};
    ['nfl', 'cfb'].forEach(function (L) {
      var ix = index && index[L] && index[L].players ? index[L].players : {};
      Object.keys(ix).forEach(function (pid) {
        var r = ix[pid], n = nk(r[0]); if (!n) return;
        var parts = n.split(' '), last = parts[parts.length - 1];
        var hit = s.indexOf(' ' + n + ' ') >= 0 || Pp.nameVariants(r[0]).some(function (v) { return v.length > 4 && s.indexOf(' ' + v + ' ') >= 0; });
        if (hit && !seen[L + pid]) { seen[L + pid] = 1; found.push({ league: L, pid: pid, name: r[0], slug: r[1], pos: r[2], team: r[3], method: 'NAME' }); }
        if (last.length >= 4) (byLast[last] = byLast[last] || []).push({ league: L, pid: pid, name: r[0], slug: r[1], pos: r[2], team: r[3], method: 'SURNAME' });
      });
    });
    /* a surname alone ("Nacua") resolves only when exactly one player on the
       boards carries it; two is a question back, never a guess */
    Object.keys(byLast).forEach(function (last) {
      if (s.indexOf(' ' + last + ' ') < 0 && s.indexOf(' ' + last + 's ') < 0) return;
      if (found.some(function (f) { return nk(f.name).split(' ').pop() === last; })) return;
      var list = byLast[last];
      if (list.length === 1) found.push(list[0]); else amb.push({ surname: last, candidates: list.slice(0, 6).map(function (x) { return x.name + ' (' + x.team + ' ' + x.pos + ', ' + x.league.toUpperCase() + ')'; }) });
    });
    return { players: found, ambiguous: amb };
  }

  /* ------------------------------------------------------------- intent */
  function classify(q, index) {
    var s = nk(q);
    if (!s || s.length > 400) return null;
    var prop = propOf(q), pl = playersIn(q, index), qt = quoteOf(q);
    var namesPlayer = pl.players.length > 0 || pl.ambiguous.length > 0;
    if (UNMODELED_RX.test(s) && (namesPlayer || PROPS_WORD.test(s))) return { intent: 'UNMODELED', players: pl, prop: null, quote: qt };
    if (!namesPlayer && BOARD_RX.test(s)) return { intent: 'BOARD', players: pl, prop: prop, quote: qt, league: COLLEGE_RX.test(s) ? 'cfb' : (NFL_RX.test(s) ? 'nfl' : null) };
    if (!namesPlayer) return null;
    if (pl.players.length >= 2 && INJ_RX.test(s)) return { intent: 'INJURY', players: pl, prop: prop, quote: qt };
    if (qt.quotes.length >= 2 && pl.players.length >= 1) return { intent: 'COMPARE', players: pl, prop: prop, quote: qt };
    if (prop) return { intent: 'PROP', players: pl, prop: prop, quote: qt };
    if (PROPS_WORD.test(s) || /\b(project(ion|s|ed)?|fair line|expect|outlook|how many)\b/.test(s)) return { intent: 'PLAYER', players: pl, prop: null, quote: qt };
    return null;
  }

  /* --------------------------------------------------------- the pieces */
  function rowFor(board, pid, prop) { var rows = (board && board.rows) || []; for (var i = 0; i < rows.length; i++) if (rows[i].pid === pid && rows[i].prop === prop) return rows[i]; return null; }
  function gameOf(board, gid) { var g = (board && board.games) || []; for (var i = 0; i < g.length; i++) if (g[i].game_id === gid) return g[i]; return null; }
  function matchup(board, row) { var g = gameOf(board, row.gid) || {}; return (g.away_name || g.away || '') + ' @ ' + (g.home_name || g.home || ''); }
  function label(k) { var t = P() && P().propType(k); return t ? t.label : k; }
  function lower(k) { return label(k).toLowerCase().replace(/\btd(s?)\b/g, 'TD$1'); }
  function sentence(t) { t = String(t || '').replace(/\.$/, ''); return t.charAt(0).toLowerCase() + t.slice(1); }
  /* the canonical evaluation: the board's projection, the market file's
     quotes, the board's context — EDProps.prepare, as the drawer runs it */
  function evaluate(files, row, now) {
    var Pp = P(), gf = files.game, mk = files.market || {};
    var rec = null; (gf && gf.projections || []).forEach(function (x) { if (x.projection_id === row.id) rec = x; });
    if (!rec) return null;
    var proj = Pp.hydrate(gf, rec), k = row.gid + '|' + row.pid + '|' + row.prop;
    var quotes = mk.props && mk.props[k] ? mk.props[k] : [];
    var out = Pp.prepare(proj, quotes, { now: now, stages: files.board.stages, cv_norm: files.board.cv_norm, calibration: files.board.calibration, history: mk.history ? mk.history[k] : null, open: mk.open ? mk.open[k] : null });
    return { projection: out.projection, ev: out.evaluation, quotes: quotes };
  }

  /* ---------------------------------------------------------- the answers */
  function propText(files, row, now, qt) {
    var Pp = P(), x = evaluate(files, row, now);
    if (!x) return { text: null };
    var p = x.projection, ev = x.ev, sm = p.summary || {}, c = ev.consensus || {}, rec = ev.recommended || ev.best, fa = ev.fair && ev.fair.at_market;
    var L = [];
    L.push(row.name + ' — ' + lower(row.prop) + ' (' + matchup(files.board, row) + '). ' + (p.stage === 'EXPERIMENTAL' ? 'This market is EXPERIMENTAL: it has not passed EdgeDesk’s validation gates, so it informs but never stakes.' : 'This market is ' + (Pp.STAGE_LABEL[p.stage] || p.stage) + ' (passed its walk-forward gates).'));
    if (p.status !== 'PROJECTED' || !p.dist) { L.push('EdgeDesk has no usable projection for it (' + (p.missing || []).join(', ').toLowerCase().replace(/_/g, ' ') + '), so there is no fair line and no edge to state.'); return { text: L.join(' '), ev: ev, row: row }; }
    var binary = Pp.propType(row.prop) && Pp.propType(row.prop).kind === 'binary';
    if (binary) { var py = Pp.probAt(p.dist, 0.5); L.push('EdgeDesk gives him a ' + pct(py.over) + ' chance to score (fair odds ' + am(Pp.fairAmerican(py.over, 0)) + ').'); }
    else L.push('EdgeDesk projects a mean of ' + f1(sm.mean) + ' and a median of ' + f1(sm.median) + ' (80% of simulated games between ' + sm.p10 + ' and ' + sm.p90 + '). Its fair line is ' + f1(sm.fair_line) + '.');
    if (p.availability && p.availability.status && p.availability.status !== 'ACTIVE') L.push('Availability: ' + p.availability.status + (num(p.availability.p_active) && p.availability.p_active < 1 ? ' (' + pct(p.availability.p_active) + ' historical play-through)' : '') + '; the distribution is conditional on playing.');
    if (!c.books) L.push('No sportsbook price is captured for this prop, so EdgeDesk shows its projection only and claims no expected value.');
    else {
      L.push((binary ? 'Captured by ' + c.books + ' book' + (c.books === 1 ? '' : 's') + (c.freshness ? ' (' + c.freshness.text + ')' : '') + '.' : 'The books’ consensus line is ' + f1(c.consensus_line) + ' (' + c.books + ' book' + (c.books === 1 ? '' : 's') + (c.freshness ? ', ' + c.freshness.text : '') + ').') + (fa && !binary ? ' At that line EdgeDesk has P(Over) ' + pct(fa.p_over) + ' and P(Under) ' + pct(fa.p_under) + ' (fair odds ' + am(fa.fair_over) + ' / ' + am(fa.fair_under) + ')' + (num(c.novig_over) ? ', against a no-vig market of ' + pct(c.novig_over) + ' for the Over.' : '.') : ''));
      if (rec) L.push('Best price for the ' + side(rec.side) + ': ' + side(rec.side) + ' ' + (rec.side === 'yes' || rec.side === 'no' ? '' : f1(rec.line) + ' ') + am(rec.american) + ' at ' + Pp.bookLabel(rec.book) + ', break-even ' + pct(rec.break_even) + ': edge ' + pp(rec.edge_pp) + ', EV ' + spct(rec.ev) + (num(rec.decision_ev) ? ' (' + spct(rec.decision_ev) + ' after the uncertainty haircut)' : '') + '.');
      L.push('EdgeDesk decision: ' + (ev.decision === 'NO_DECISION' ? 'NO DECISION' : ev.decision) + (ev.decision === 'BET' && ev.units ? ' ' + ev.units.toFixed(2) + 'U' : '') + ' — ' + ev.reason + (ev.watch_trigger && ev.watch_trigger.text ? ' It would change at: ' + ev.watch_trigger.text + '.' : ''));
    }
    /* a quote the reader named, priced on the same distribution */
    if (qt && num(qt.line) && (qt.side === 'over' || qt.side === 'under')) {
      /* no price given: the best price a captured book deals at that line and side */
      var atLine = x.quotes.filter(function (q) { return Math.abs(q.line - qt.line) < 1e-9 && num(qt.side === 'over' ? q.over : q.under) && (!qt.book || q.book === qt.book); })
        .sort(function (a, b) { return dec(qt.side === 'over' ? b.over : b.under) - dec(qt.side === 'over' ? a.over : a.under); });
      var bestAt = atLine[0] || null;
      var price = num(qt.american) ? qt.american : (bestAt ? (qt.side === 'over' ? bestAt.over : bestAt.under) : -110);
      var same = rec && rec.side === qt.side && Math.abs(rec.line - qt.line) < 1e-9 && rec.american === price;
      var ps = Pp.priceSide(p.dist, qt.side, qt.line, price);
      if (ps.available && !same) {
        var dealt = x.quotes.some(function (q) { return Math.abs(q.line - qt.line) < 1e-9 && ((qt.side === 'over' ? q.over : q.under) === price) && (!qt.book || q.book === qt.book); });
        var be = Pp.breakEvenLine(p.dist, qt.side, price);
        L.push('Your quote, ' + side(qt.side) + ' ' + f1(qt.line) + ' ' + am(price) + (num(qt.american) ? '' : (bestAt ? ' (the best captured price at that line, ' + Pp.bookLabel(bestAt.book) + ')' : ' (no price given and no book deals that line; priced at −110)')) + (qt.book ? ' at ' + Pp.bookLabel(qt.book) : '') + ': P(win) ' + pct(ps.model_win) + (ps.model_push > 0 ? ' (push ' + pct(ps.model_push) + ')' : '') + ', fair odds ' + am(ps.fair_american) + ', break-even ' + pct(ps.break_even) + ', edge ' + pp(ps.edge_pp) + ', EV ' + spct(ps.ev) + '.' + (num(be) ? ' At that price the zero-EV line is about ' + f1(be) + '.' : '') + (dealt ? '' : ' No captured book is dealing exactly that quote right now, so it is priced as given.'));
      }
    }
    if (ev.why && ev.why.length) L.push('Why: ' + ev.why.slice(0, 3).join('; ') + '.');
    if (ev.risks && ev.risks.length) L.push('What could make it wrong: ' + ev.risks.slice(0, 3).join('; ') + '.');
    if (ev.reliability && num(ev.reliability.score)) L.push('Reliability ' + ev.reliability.score + '/100 — how much the number can be trusted, not the size of the edge.');
    L.push('Research, not picks.');
    return { text: L.join(' '), ev: ev, row: row, projection: p };
  }
  function playerText(board, pid) {
    var rows = board.rows.filter(function (r) { return r.pid === pid && !r.status; });
    if (!rows.length) return null;
    var r0 = rows[0], L = [r0.name + ' (' + matchup(board, r0) + '): EdgeDesk’s fair lines, from its simulated distribution.'];
    rows.forEach(function (r) {
      var pj = r.proj || [];
      L.push(label(r.prop) + ': fair ' + f1(pj[1]) + ' (mean ' + f1(pj[0]) + ')' + (r.mkt ? ', book line ' + f1(r.mkt.line) + (r.px ? ', best ' + side(r.px.side) + ' ' + am(r.px.am) + ' EV ' + spct(r.px.ev) : '') + ', ' + (r.dec ? (r.dec.cls === 'NO_DECISION' ? 'NO DECISION' : r.dec.cls) : 'no decision') : ', no price captured') + (r.stage === 'EXPERIMENTAL' ? ' [experimental]' : '') + '.');
    });
    if (r0.avail) L.push('Availability: ' + r0.avail[0] + '; distributions are conditional on playing.');
    L.push('Research, not picks.');
    return L.join(' ');
  }
  function boardText(boards, league) {
    var Ls = league ? [league] : ['nfl', 'cfb'], L = [], any = false;
    Ls.forEach(function (lg) {
      var b = boards[lg]; if (!b) return;
      var name = lg === 'nfl' ? 'NFL' : 'college football';
      if (!b.market_captured_at) { L.push('No sportsbook player-prop prices are captured for ' + name + ' right now, so EdgeDesk has no prop EV to rank; its ' + (b.counts ? b.counts.projected : b.rows.length) + ' projections and fair lines are on the Props board.'); return; }
      var act = b.rows.filter(function (r) { return r.dec && (r.dec.cls === 'BET' || r.dec.cls === 'LEAN') && r.px; }).sort(function (a, c) { return (c.px.dec_ev || 0) - (a.px.dec_ev || 0); }).slice(0, 5);
      var watch = b.rows.filter(function (r) { return r.dec && r.dec.cls === 'WATCH' && r.px; }).sort(function (a, c) { return (c.px.ev || 0) - (a.px.ev || 0); }).slice(0, 3);
      if (!act.length) L.push('No ' + name + ' prop clears EdgeDesk’s thresholds at the captured prices (' + (b.counts ? b.counts.with_market : 0) + ' priced).');
      else { any = true; L.push(name + ' props that clear a threshold, ranked by risk-adjusted EV: ' + act.map(function (r) { return r.name + ' ' + lower(r.prop) + ' ' + side(r.px.side) + ' ' + f1(r.px.line) + ' ' + am(r.px.am) + ' at ' + P().bookLabel(r.px.book) + ' (' + r.dec.cls + (r.dec.cls === 'BET' && r.dec.units ? ' ' + r.dec.units.toFixed(2) + 'U' : '') + ', EV ' + spct(r.px.ev) + ')'; }).join('; ') + '.'); }
      if (watch.length) L.push('Watch list: ' + watch.map(function (r) { return r.name + ' ' + lower(r.prop) + ' (' + sentence(P().reasonText(r.dec.code)) + ')'; }).join('; ') + '.');
    });
    if (!L.length) return null;
    L.push(any ? 'Each is a research lead with its full distribution on the Props board; an EXPERIMENTAL market never carries units.' : 'Research, not picks.');
    return L.join(' ');
  }
  function injuryText(files, absent, player) {
    var gf = files.game; if (!gf || !gf.teams) return null;
    var t = gf.teams.home && gf.teams.home.team === player.team ? gf.teams.home : gf.teams.away;
    var rd = (t && t.redistribution) || [];
    var d = rd.filter(function (x) { return nk(x.name) === nk(absent.name); })[0];
    if (!d) return absent.name + ' is not listed as absent or uncertain for ' + (t ? t.team : player.team) + ' in EdgeDesk’s current projection, so no redistribution is applied to ' + player.name + '.';
    var mine = (d.recipients || []).filter(function (r) { return nk(r.name) === nk(player.name); })[0];
    var L = [absent.name + ' (' + d.status + (num(d.p_active) && d.p_active < 1 && d.status !== 'OUT' ? ', ' + pct(d.p_active) + ' to play' : '') + ') carries a ' + pct(d.share) + ' ' + (d.kind === 'tgt' ? 'target' : 'carry') + ' share.'];
    L.push(mine ? player.name + ' is planned to receive ' + pct(mine.fraction) + ' of it when ' + absent.name + ' sits.' : player.name + ' is not one of the named recipients of that share.');
    L.push('The plan (' + String(d.confidence).toLowerCase() + ' confidence) never hands the whole share to one teammate; part of it stays unassigned. ' + (d.status === 'OUT' ? 'It is applied in every simulation.' : 'It applies only in the simulations where ' + absent.name + ' does not play.'));
    return L.join(' ');
  }

  /* the one entry point: the files the host read, the question → answer */
  function answer(q, cls, files, now) {
    var Pp = P();
    if (!Pp || !cls) return { text: null };
    if (cls.intent === 'UNMODELED') return { intent: 'UNMODELED', text: 'EdgeDesk does not model that prop type (kicking, defensive and special-teams props are listed as market only), so it has no fair line, probability or edge for it. It models passing, rushing, receiving and touchdown props for NFL and FBS quarterbacks, running backs, receivers and tight ends.' };
    if (cls.intent === 'BOARD') { var bt = boardText(files.boards || {}, cls.league); return { intent: 'BOARD', text: bt }; }
    var pl = cls.players;
    if (!pl.players.length && pl.ambiguous.length) return { intent: 'AMBIGUOUS', text: 'More than one player on EdgeDesk’s prop boards matches "' + pl.ambiguous[0].surname + '": ' + pl.ambiguous[0].candidates.join(', ') + '. Which one do you mean?' };
    var who = pl.players[0], board = files.boards && files.boards[who.league];
    if (!board) return { intent: cls.intent, text: 'EdgeDesk’s ' + who.league.toUpperCase() + ' prop board could not be read right now, so there is no number to give.' };
    if (cls.intent === 'PLAYER') { var t0 = playerText(board, who.pid); return { intent: 'PLAYER', player: who, text: t0 || who.name + ' is in EdgeDesk’s player registry but has no current prop projection on the board.' }; }
    if (cls.intent === 'INJURY') {
      var a = pl.players[0], b = pl.players[1];
      /* the absent one is the name the injury words sit next to */
      /* who is out: "without X", "X is / being / if out|injured|sits", else
         the name nearest BEFORE the injury word */
      var s = nk(q);
      var outOf = function (pl0) { var n = nk(pl0.name), last = n.split(' ').pop(), nm = '(' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '|' + last + ')';
        return new RegExp('\\bwithout\\s+' + nm + '\\b').test(s) || new RegExp('\\b' + nm + 's?\\s+(is\\s+|being\\s+|if\\s+|were\\s+|was\\s+|gets\\s+|goes\\s+)?(out|injured|inactive|ruled out|sits|sitting|misses|missing|doesnt play|does not play)\\b').test(s); };
      var absent = outOf(a) && !outOf(b) ? a : (outOf(b) && !outOf(a) ? b : null);
      if (!absent) { var injAt = s.search(INJ_RX), ia = s.indexOf(nk(a.name).split(' ').pop()), ib = s.indexOf(nk(b.name).split(' ').pop()); absent = (ia < injAt && (ib > injAt || ia > ib)) ? a : b; }
      var player = absent === a ? b : a;
      if (absent.team !== player.team || absent.league !== player.league) return { intent: 'INJURY', text: absent.name + ' and ' + player.name + ' are not teammates on EdgeDesk’s boards, so one does not redistribute to the other.' };
      return { intent: 'INJURY', player: player, need_game: true, text: null, absent: absent };
    }
    var prop = cls.prop || null;
    if (cls.intent === 'COMPARE') {
      if (!prop) { var cand = board.rows.filter(function (r) { return r.pid === who.pid && !r.status; }).map(function (r) { return r.prop; }); prop = cand.indexOf('rush_yds') >= 0 && who.pos === 'RB' ? 'rush_yds' : (cand.indexOf('rec_yds') >= 0 ? 'rec_yds' : cand[0]); }
      return { intent: 'COMPARE', player: who, prop: prop, need_game: true, text: null };
    }
    var row = rowFor(board, who.pid, prop);
    if (!row) return { intent: 'PROP', player: who, text: 'EdgeDesk has no current ' + lower(prop) + ' projection for ' + who.name + (board.rows.some(function (r) { return r.pid === who.pid; }) ? ' (it projects his other props; ask for them by name).' : '.') };
    return { intent: 'PROP', player: who, prop: prop, row: row, need_game: true, text: null };
  }
  /* the second step, once the host has read the game and market files */
  function finish(q, cls, pre, files, now) {
    var Pp = P();
    if (pre.intent === 'PROP') { var r = propText(files, pre.row, now, cls.quote); return { intent: 'PROP', text: r.text, row: pre.row, evaluation: r.ev || null }; }
    if (pre.intent === 'INJURY') return { intent: 'INJURY', text: injuryText(files, pre.absent, pre.player) };
    if (pre.intent === 'COMPARE') {
      var row = rowFor(files.board, pre.player.pid, pre.prop);
      if (!row) return { intent: 'COMPARE', text: 'EdgeDesk has no current ' + lower(pre.prop) + ' projection for ' + pre.player.name + ', so it cannot price either quote.' };
      var x = evaluate(files, row, now);
      if (!x || !x.projection.dist) return { intent: 'COMPARE', text: 'EdgeDesk has no usable distribution for ' + pre.player.name + '’s ' + lower(pre.prop) + '.' };
      var qs = cls.quote.quotes.slice(0, 2).map(function (qq) { return { side: qq.side || 'over', line: qq.line, american: num(qq.american) ? qq.american : -110 }; });
      var cmp = Pp.compareQuotes(x.projection, qs[0], qs[1]);
      var t = function (q2, r2) { return side(q2.side) + ' ' + f1(q2.line) + ' ' + am(q2.american) + ': P(win) ' + pct(r2.model_prob) + (r2.push > 0 ? ' (push ' + pct(r2.push) + ')' : '') + ', fair ' + am(r2.fair_american) + ', break-even ' + pct(r2.break_even) + ', edge ' + pp(r2.edge_pp) + ', EV ' + spct(r2.ev); };
      return { intent: 'COMPARE', text: pre.player.name + ' ' + lower(pre.prop) + ', both priced on EdgeDesk’s one distribution (median ' + f1(x.projection.summary.median) + '). ' + t(qs[0], cmp.a) + '. ' + t(qs[1], cmp.b) + '. ' +
        (cmp.higher_ev ? 'The ' + (cmp.higher_ev === 'a' ? 'first' : 'second') + ' has the higher EV; the ' + (cmp.higher_probability === 'a' ? 'first' : 'second') + ' has the higher probability. ' : '') + cmp.note + ' Research, not picks.' };
    }
    return { intent: pre.intent, text: pre.text };
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
    'Use only the numbers, players and prop types in the answer; never add, round differently, or recalculate one. Never promise an outcome.',
    'Never call anything a lock, a best bet, a safe bet or guaranteed. Keep "Research, not picks." Return only the rewritten answer.'].join(' ');

  return { VERSION: VERSION, SCHEMA: SCHEMA, classify: classify, propOf: propOf, quoteOf: quoteOf, playersIn: playersIn, answer: answer, finish: finish,
    evaluate: evaluate, allowedNumbers: allowedNumbers, critic: critic, NARRATION_CONTRACT: NARRATION_CONTRACT };
});
/*__EDPROPSDESK_END__*/
