/*__EDMINE_START__*/
/* ============================================================================
   THE READER'S OWN RESEARCH, FOR THE AI DESK — deterministic answers over the
   reader's watchlist, alerts and journal and the shared slate research state.

     "What changed in my watchlist today?"                     WATCH_CHANGES
     "Which of my watched games became research-grade?"        WATCH_GRADE
     "What's on my watchlist?"                                  WATCH_LIST
     "Which five games are most worth researching?"            TOP5
     "Where is EdgeDesk most different from the market?"       LARGEST_GAP
     "Which games have high disagreement but low reliability?" GAP_LOW_REL
     "Which games improved after QB confirmation?"             QB_IMPROVED
     "How has my CLV looked this month?"                       CLV
     "Show me games where my decisions disagree with EdgeDesk." VERSUS
     "How do my numbers compare with EdgeDesk's?"              MY_NUMBERS
     "Why did this game's reliability change?"                 REL_WHY
     "What are my alerts?"                                     ALERTS

   EVERY FACT IS READ, NONE IS WRITTEN. The reader's rows arrive through the
   caller's own token (row level security decides what exists); the slate's
   research state is the table tools/personal/research_state.js fills from the
   football module itself. Every number in an answer is one of those rows'
   numbers, or a count, difference or average of them (lib/edgedesk_personal.js
   does the arithmetic). When a table is empty, unreadable or silent on the
   question, the answer SAYS SO — it never fills the gap.

   The shape: simple first (a headline and up to five lines), detail behind
   it, then what is missing and where it came from. Research, not picks: the
   copy rule is checked on every answer.
   ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../../../lib/edgedesk_personal.js'));
  else root.EDMINE = factory(root.EDPersonal);
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (P) {
  'use strict';
  var M = { VERSION: 'edgedesk_mine/1', SCHEMA: 'edgedesk_mine_answer/1' };
  function num(x) { return (typeof x === 'number' && isFinite(x)) ? x : null; }
  function plural(n, w, ws) { return n + ' ' + (n === 1 ? w : (ws || w + 's')); }
  function pct(x) { return num(x) == null ? '—' : Math.round(100 * x) + '%'; }
  function signed(v) { v = num(v); return v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(1); }
  function when(iso) { var t = Date.parse(iso); return isFinite(t) ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : ''; }

  /* ------------------------------------------------------------ intent */
  var RX = [
    ['REL_WHY', /why did[^?]{0,80}reliabilit|reliability (change|changed|drop|dropped|jump|jumped|went|go|rise|rose|fall|fell|move|moved)/i],
    ['WATCH_GRADE', /(watch(ed| ?list)[^?]{0,60}research[- ]grade|research[- ]grade[^?]{0,60}watch)/i],
    ['WATCH_CHANGES', /(what|anything)[^?]{0,30}(changed|change|moved|new|happened|updated)[^?]{0,40}(my )?watch ?list|watch ?list[^?]{0,40}(changed|change|moved|new|update)/i],
    ['WATCH_LIST', /(what('s| is)|show|list)[^?]{0,20}(on|in) my watch ?list|my watch ?list\??$/i],
    ['GAP_LOW_REL', /(high|large|big)[^?]{0,15}(disagreement|gap)[^?]{0,40}(low|weak|poor|bad) reliab/i],
    ['QB_IMPROVED', /(improv|reliab)[^?]{0,60}(qb|quarterback)[^?]{0,30}confirm|after (the )?(qb|quarterback)[^?]{0,20}confirm/i],
    ['MY_NUMBERS', /compare my (own )?numbers?|\bmy (own )?(numbers?|fair (lines?|spreads?|totals?))\b[^?]{0,80}(edgedesk|compare|versus|\bvs\b|close|closing|differ|agree)|(edgedesk|close|closing)[^?]{0,60}\bmy (own )?(numbers?|fair (lines?|spreads?|totals?))\b/i],
    ['VERSUS', /(my (own )?(decisions?|bets?|wagers?|picks?)|i )[^?]{0,60}(disagree|against|opposite|differ)[^?]{0,20}edgedesk/i],
    ['CLV', /\bclv\b|closing[- ]line value|beat(ing)? the clos|decision quality|how (have|has|did) my (decisions|bets|wagers|research|process)/i],
    ['TOP5', /(top (5|five)|five games|5 games)[^?]{0,40}(research|worth)|most worth research|games? (should i|to) research|worth researching/i],
    ['LARGEST_GAP', /(most|biggest|largest|widest) (different|disagreement|disagree|gap)|edgedesk (is )?most different|where (does|is) edgedesk (most )?(disagree|differ)/i],
    ['ALERTS', /\bmy alerts?\b|what alerts|recent alerts/i]
  ];
  M.classify = function (q) {
    q = String(q || '');
    if (!q || q.length > 400) return null;
    for (var i = 0; i < RX.length; i++) if (RX[i][1].test(q)) return RX[i][0];
    return null;
  };
  /* what each intent reads (the host turns these into PostgREST reads) */
  M.NEEDS = {
    WATCH_CHANGES: ['watchlist', 'history_watch_24h', 'alerts'], WATCH_GRADE: ['watchlist', 'alerts'], WATCH_LIST: ['watchlist'],
    TOP5: ['top', 'prefs'], LARGEST_GAP: ['slate'], GAP_LOW_REL: ['slate'], QB_IMPROVED: ['watchlist', 'history_watch_7d', 'alerts'],
    CLV: ['journal'], VERSUS: ['journal'], MY_NUMBERS: ['journal'], REL_WHY: ['watchlist', 'slate', 'history_game'], ALERTS: ['alerts']
  };
  M.windowDays = function (q) { return /month|30 days/i.test(q) ? 30 : (/week|7 days/i.test(q) ? 7 : (/season|year|all time|ever/i.test(q) ? null : null)); };

  /* ------------------------------------------------------------ helpers */
  function out(intent, headline, lines, o) {
    o = o || {};
    return { schema: M.SCHEMA, version: M.VERSION, intent: intent, headline: headline, lines: (lines || []).slice(0, 8),
      detail: o.detail || [], missing: o.missing || [], sources: o.sources || [], actions: o.actions || [] };
  }
  function matchup(s) { return s ? (s.away + ' @ ' + s.home) : ''; }
  function lineOf(s, which) {
    var x = s && s[which];
    if (!x) return null;
    return x.text || (num(x.home_line) != null ? P.favText(s, x.home_line) : null);
  }
  function relOf(s) {
    var r = s && s.reliability || {};
    return num(r.score) != null ? 'reliability ' + Math.round(r.score) + (r.grade ? ' (' + String(r.grade).toLowerCase() + ')' : '') : (s && s.sport === 'nfl' ? 'NFL reliability not scored' : 'reliability not measured');
  }
  function gameLine(s) {
    var g = s && s.gap && num(s.gap.points);
    return matchup(s) + ' — EdgeDesk ' + (lineOf(s, 'fair') || '—') + ', market ' + (lineOf(s, 'market') || 'none') + (g != null ? ', gap ' + g.toFixed(1) + ' pts' : '') + ', ' + relOf(s);
  }
  function upcoming(s, now) { var k = s && Date.parse(s.kickoff_at); return !isFinite(k) || k > now; }
  var SRC = {
    watchlist: 'your watchlist (watchlist_games, joined to the shared research state)',
    alerts: 'your research alerts (user_alerts)', journal: 'your research journal (research_journal)',
    slate: 'the slate research state (game_research_state, computed from the football module)',
    history: 'the research state history (game_research_history)'
  };

  /* ------------------------------------------------------------ answers */
  M.answer = function (intent, d, ctx) {
    d = d || {}; ctx = ctx || {};
    var now = ctx.now || Date.now();
    var fn = A[intent];
    if (!fn) return null;
    var o = fn(d, now, ctx);
    o.text = [o.headline].concat(o.lines.map(function (l) { return '• ' + l; })).join('\n');
    o.numbers = M.numbersIn(o.text + ' ' + o.detail.join(' '));
    /* the copy rule is enforced on the way out, whatever the rows said */
    if (!P.copyOk(o.text) || !o.detail.every(P.copyOk)) {
      return out(intent, 'EdgeDesk could not phrase this answer within its research-only wording rules, so it is not shown.', [], { missing: ['copy rule'] });
    }
    return o;
  };
  var A = {};
  function noState(d) { return d.watchlist_error || d.slate_error ? ' The shared research state could not be read just now, so this may be incomplete.' : ''; }

  A.WATCH_LIST = function (d, now) {
    var w = (d.watchlist || []).filter(function (x) { return upcoming(x.state || x, now); });
    if (!w.length) return out('WATCH_LIST', 'Your watchlist has no upcoming games. Tap Watch game on any game and EdgeDesk will track its research state for you.' + noState(d), [], { sources: [SRC.watchlist], actions: ['watchlist'] });
    return out('WATCH_LIST', 'You are watching ' + plural(w.length, 'upcoming game') + '.', w.slice(0, 8).map(function (x) {
      return x.state ? gameLine(x.state) + (x.changed ? ' — changed since your last visit' : '') : ((x.away || '?') + ' @ ' + (x.home || '?') + ' — EdgeDesk has no research state for it yet');
    }), { sources: [SRC.watchlist], actions: ['watchlist'], missing: w.some(function (x) { return !x.state; }) ? ['one or more watched games has no research state on the server yet'] : [] });
  };

  A.WATCH_CHANGES = function (d, now) {
    var w = (d.watchlist || []).filter(function (x) { return x.state && upcoming(x.state, now); });
    if (!(d.watchlist || []).length) return out('WATCH_CHANGES', 'Your watchlist is empty, so there is nothing to report. Watch a game and EdgeDesk will track what changes.', [], { sources: [SRC.watchlist] });
    var since = now - 24 * 36e5, byGame = {};
    (d.history || []).forEach(function (h) { (byGame[h.game_key] = byGame[h.game_key] || []).push(h); });
    var changed = [], detail = [];
    w.forEach(function (x) {
      var hs = (byGame[x.game_key] || []).slice().sort(function (a, b) { return Date.parse(a.computed_at) - Date.parse(b.computed_at); });
      var before = null, after = null;
      hs.forEach(function (h) { var t = Date.parse(h.computed_at); if (t <= since) before = h.state; else if (!after || t >= Date.parse(after.computed_at || 0)) after = h.state; });
      if (!before && hs.length) before = hs[0].state;
      var cur = x.state;
      if (!before || before.state_hash === cur.state_hash) return;
      var ch = P.changes(before, cur, { fair_move_pts: 0.5, market_move_pts: 0.5, reliability_change_pts: 3, diverge_pts: 1 });
      if (!ch.length) return;
      changed.push(matchup(cur) + ': ' + ch.slice(0, 2).map(function (c) { return c.text; }).join(' '));
      ch.slice(2).forEach(function (c) { detail.push(matchup(cur) + ': ' + c.text); });
    });
    var unread = (d.alerts || []).filter(function (a) { return !a.read_at && Date.parse(a.created_at) > since; }).length;
    var head = changed.length
      ? changed.length + ' of your ' + plural(w.length, 'watched game') + ' changed in the last 24 hours.'
      : 'Nothing meaningful changed in your ' + plural(w.length, 'watched game') + ' in the last 24 hours.';
    return out('WATCH_CHANGES', head + (unread ? ' You have ' + plural(unread, 'unread alert') + ' from that period.' : '') + noState(d), changed, {
      detail: detail, sources: [SRC.watchlist, SRC.history, SRC.alerts], actions: ['watchlist', 'alerts'],
      missing: (d.history_error ? ['the change history could not be read, so this compares nothing'] : []) });
  };

  A.WATCH_GRADE = function (d, now) {
    var w = (d.watchlist || []).filter(function (x) { return x.state && upcoming(x.state, now); });
    if (!w.length) return out('WATCH_GRADE', 'None of your watched games has an upcoming research state, so none can be research-grade.' + noState(d), [], { sources: [SRC.watchlist] });
    var became = {};
    (d.alerts || []).forEach(function (a) { if (a.kind === 'research_grade' && Date.parse(a.created_at) > now - 7 * 864e5) became[a.game_key] = a.created_at; });
    var grade = w.filter(function (x) { return x.state.research_grade; });
    var lines = grade.map(function (x) { return gameLine(x.state) + (became[x.game_key] ? ' — became research-grade ' + when(became[x.game_key]) : ''); });
    var not = w.filter(function (x) { return !x.state.research_grade; }).slice(0, 3).map(function (x) {
      return matchup(x.state) + ' is not research-grade: ' + ((x.state.research_grade_reasons || [])[0] || 'it does not clear the research gates');
    });
    return out('WATCH_GRADE', grade.length ? plural(grade.length, 'of your watched games is', 'of your watched games are') + ' research-grade right now' + (Object.keys(became).length ? ', ' + Object.keys(became).length + ' became research-grade this week' : '') + '.'
      : 'None of your ' + plural(w.length, 'watched game') + ' is research-grade right now.', lines, {
      detail: not, sources: [SRC.watchlist, SRC.alerts], actions: ['watchlist'],
      missing: [] });
  };

  A.TOP5 = function (d, now, ctx) {
    var states = (d.top || []).filter(function (s) { return upcoming(s, now); });
    if (d.top_error || !states.length) return out('TOP5', d.top_error ? 'The research priority list could not be read just now, so EdgeDesk will not name games from memory.'
      : 'No game clears the research gates right now: every game either agrees with the market, has no current quote, or rests on data EdgeDesk does not trust. Nothing is forced onto the list.', [], { sources: [SRC.slate] });
    var leagues = (d.prefs && d.prefs.leagues && d.prefs.leagues.length) ? d.prefs.leagues : ['cfb', 'nfl'];
    if (/\bnfl\b/i.test(ctx.question || '')) leagues = ['nfl']; else if (/college|cfb|ncaa/i.test(ctx.question || '')) leagues = ['cfb'];
    var lines = [], detail = [];
    leagues.forEach(function (lg) {
      P.topFive(states, lg, 5).forEach(function (s, i) {
        var ex = P.explain(s);
        lines.push((lg === 'cfb' ? 'CFB' : 'NFL') + ' #' + (i + 1) + ' ' + gameLine(s));
        detail.push(matchup(s) + ' — why: ' + (ex.why.slice(0, 3).join('; ') || '—') + (ex.concerns.length ? '. Possible concern: ' + ex.concerns[0] : '') + '.');
      });
    });
    return out('TOP5', 'The games most worth researching, in EdgeDesk’s research-priority order — ranked by research-worthiness, not by gap, and not a ranking of bets:',
      lines.slice(0, 10), { detail: detail, sources: [SRC.slate], actions: ['top5'] });
  };

  function slateOf(d, now) {
    return (d.slate || []).map(function (r) { return r.state || r; }).filter(function (s) { return s && s.projected && upcoming(s, now); });
  }
  A.LARGEST_GAP = function (d, now) {
    var s = slateOf(d, now).filter(function (x) { return num(x.gap && x.gap.points) != null && x.market && !x.market.stale && num(x.market.home_line) != null; });
    if (!s.length) return out('LARGEST_GAP', 'EdgeDesk has no current model-market comparison to rank right now.' + noState(d), [], { sources: [SRC.slate] });
    s.sort(function (a, b) { return b.gap.points - a.gap.points; });
    return out('LARGEST_GAP', 'Where EdgeDesk differs most from a current market number. The largest gaps come most often from the thinnest data, so read reliability first:',
      s.slice(0, 5).map(function (x) { return gameLine(x) + (x.research_grade ? ' — research-grade' : ' — not research-grade: ' + ((x.research_grade_reasons || [])[0] || 'gates not cleared')); }),
      { sources: [SRC.slate], actions: ['top5'] });
  };
  A.GAP_LOW_REL = function (d, now) {
    var all = slateOf(d, now);
    var s = all.filter(function (x) {
      var g = num(x.gap && x.gap.points), r = num(x.reliability && x.reliability.score);
      return g != null && g >= 3 && ((r != null && r < 70) || x.research_label === 'LOW_RELIABILITY');
    }).sort(function (a, b) { return b.gap.points - a.gap.points; });
    var nfl = all.filter(function (x) { return x.sport === 'nfl'; }).length;
    return out('GAP_LOW_REL', s.length ? plural(s.length, 'game has', 'games have') + ' 3+ points of model-market disagreement on reliability under 70. Treat these gaps as suspect, not exciting:'
      : 'No game on the slate pairs 3+ points of disagreement with reliability under 70.', s.slice(0, 6).map(gameLine), {
      sources: [SRC.slate], missing: nfl ? ['NFL games are not screened: the NFL model publishes no reliability score'] : [] });
  };

  A.QB_IMPROVED = function (d, now) {
    var w = (d.watchlist || []).filter(function (x) { return x.state; });
    var byGame = {};
    (d.history || []).forEach(function (h) { (byGame[h.game_key] = byGame[h.game_key] || []).push(h); });
    var found = [];
    w.forEach(function (x) {
      var hs = (byGame[x.game_key] || []).slice().sort(function (a, b) { return Date.parse(a.computed_at) - Date.parse(b.computed_at); });
      for (var i = 1; i < hs.length; i++) {
        var a = hs[i - 1].state, b = hs[i].state;
        var qa = a && a.qb || {}, qb = b && b.qb || {};
        var flipped = ['home', 'away'].filter(function (k) { return qb[k] && qb[k].confirmed && !(qa[k] && qa[k].confirmed); });
        if (!flipped.length) continue;
        var ra = num(a.reliability && a.reliability.score), rb = num(b.reliability && b.reliability.score);
        found.push(matchup(b) + ': QB confirmed for ' + flipped.map(function (k) { return b[k]; }).join(' and ') + ' at ' + when(hs[i].computed_at)
          + (ra != null && rb != null ? '; reliability ' + Math.round(ra) + ' → ' + Math.round(rb) + (rb > ra ? ' (improved)' : (rb < ra ? ' (declined)' : ' (unchanged)')) : '; reliability not scored'));
        break;
      }
    });
    return out('QB_IMPROVED', found.length ? 'Among your watched games, ' + plural(found.length, 'had a starting quarterback confirmed', 'had starting quarterbacks confirmed') + ' in the last 7 days:'
      : 'None of your ' + plural(w.length, 'watched game') + ' had a starting quarterback confirmed in the last 7 days.', found, {
      sources: [SRC.watchlist, SRC.history], missing: ['this is answered for your watched games, whose change history EdgeDesk reads for you'] });
  };

  A.CLV = function (d, now, ctx) {
    var days = M.windowDays(ctx.question || '');
    var a = P.analytics(d.journal || [], { now: now, since_days: days });
    var span = days ? 'In the last ' + days + ' days' : 'Across your journal';
    var pr = a.process;
    if (d.journal_error) return out('CLV', 'Your research journal could not be read just now, so EdgeDesk will not report your CLV from memory.', [], { sources: [SRC.journal] });
    if (!a.counts.wagered) return out('CLV', span + ' you logged ' + plural(a.counts.total, 'decision') + ' and no wagers, so there is no closing-line value to report.', [], { sources: [SRC.journal], actions: ['quality'] });
    var lines = [plural(a.counts.wagered, 'wager') + ' logged; ' + plural(pr.clv_n, 'has', 'have') + ' been graded against the close.'];
    if (pr.clv_n) lines.push(pr.beat_close + ' of ' + pr.clv_n + ' beat the closing line (' + pct(pr.beat_close_rate) + (pr.beat_close_ci ? ', 95% interval ' + pct(pr.beat_close_ci.lo) + '–' + pct(pr.beat_close_ci.hi) : '') + ').');
    if (pr.avg_clv_points != null) lines.push('Average CLV ' + signed(pr.avg_clv_points) + ' points on ' + plural(pr.clv_points_n, 'spread/total wager') + '.');
    if (pr.avg_clv_price_pp != null) lines.push('Average moneyline CLV ' + signed(pr.avg_clv_price_pp) + ' percentage points on ' + plural(pr.clv_price_n, 'wager') + '.');
    lines.push('Results, counted separately: ' + pr.results.win + '-' + pr.results.loss + '-' + pr.results.push + (pr.results.pending ? ' with ' + pr.results.pending + ' pending' : '') + '. A result is mostly noise; the close is the process measure.');
    var detail = a.by_reliability.filter(function (b) { return b.clv_n; }).map(function (b) {
      return 'Reliability ' + b.key + ' at entry: ' + b.beat_close + ' of ' + b.clv_n + ' beat the close' + (b.avg_clv_points != null ? ', average ' + signed(b.avg_clv_points) + ' pts' : '');
    });
    return out('CLV', span + ', here is how your numbers compared with the closing line:', lines, {
      detail: detail, missing: a.sample_note ? [a.sample_note] : [], sources: [SRC.journal], actions: ['quality'] });
  };

  A.VERSUS = function (d, now) {
    var a = P.analytics(d.journal || [], { now: now }), v = a.versus_edgedesk;
    var n = v.with_edgedesk.n + v.against_edgedesk.n;
    if (!n) return out('VERSUS', 'None of your journal entries has both a side and EdgeDesk’s numbers at decision time, so there is nothing to compare.', [], { sources: [SRC.journal] });
    var share = v.against_edgedesk.n / n;
    var consistent = v.against_edgedesk.n >= 3 && share >= 0.6;
    var head = consistent ? 'Yes — in ' + v.against_edgedesk.n + ' of ' + n + ' decisions with a side, you took the side EdgeDesk’s number did not favour.'
      : 'Not consistently: you went against EdgeDesk’s number in ' + v.against_edgedesk.n + ' of ' + n + ' decisions with a side.';
    var lines = v.against_games.slice(0, 5).map(function (g) { return g.matchup + ' — you took ' + g.selection_team + ', EdgeDesk’s number favoured ' + g.edgedesk_team + (g.beat_close == null ? '' : (g.beat_close ? '; you beat the close' : '; you did not beat the close')); });
    var detail = ['With EdgeDesk’s side: ' + v.with_edgedesk.n + ' decisions, beat the close ' + (v.with_edgedesk.clv_n ? pct(v.with_edgedesk.beat_close_rate) : 'n/a') + '.',
      'Against it: ' + v.against_edgedesk.n + ' decisions, beat the close ' + (v.against_edgedesk.clv_n ? pct(v.against_edgedesk.beat_close_rate) : 'n/a') + '.'];
    return out('VERSUS', head, lines, { detail: detail, sources: [SRC.journal], actions: ['quality'],
      missing: ['EdgeDesk’s side is the side its fair line took against the market on screen when you logged each decision'] });
  };

  /* the reader's own numbers (Compare My Number) beside EdgeDesk's and, once
     it is on file, the close. Distances, never a verdict on either number. */
  A.MY_NUMBERS = function (d) {
    if (d.journal_error) return out('MY_NUMBERS', 'Your research journal could not be read just now, so EdgeDesk will not report your numbers from memory.', [], { sources: [SRC.journal] });
    var list = (d.journal || []).filter(function (e) { return num(e.my_home_line) != null || num(e.my_total) != null; });
    if (!list.length) return out('MY_NUMBERS', 'You have not saved a number of your own yet. Use Compare my number on any game: EdgeDesk sets your fair spread and total beside its own and the market’s, and keeps every number you save.', [], { sources: [SRC.journal], actions: ['journal'] });
    var ns = P.numbersSummary(list);
    var head = 'You have saved ' + plural(ns.n, 'number') + ' of your own (' + plural(ns.spreads, 'spread') + ', ' + plural(ns.totals, 'total') + ')'
      + (ns.avg_apart_from_edgedesk != null ? '; on average your spread sat ' + ns.avg_apart_from_edgedesk.toFixed(1) + ' points from EdgeDesk’s at the time.' : '.');
    var lines = list.slice(0, 5).map(function (e) {
      var s0 = { home: e.home || 'Home', away: e.away || 'Away' }, vc = P.numbersVsClose(e), bits = [];
      if (num(e.my_home_line) != null) bits.push('yours ' + P.favText(s0, e.my_home_line));
      if (num(e.snap_fair_home_line) != null) bits.push('EdgeDesk then ' + P.favText(s0, e.snap_fair_home_line));
      if (num(e.snap_market_home_line) != null) bits.push('market then ' + P.favText(s0, e.snap_market_home_line));
      if (num(e.my_total) != null) bits.push('your total ' + e.my_total);
      if (vc.close_home_line != null && vc.mine != null) bits.push('close ' + P.favText(s0, vc.close_home_line) + ' (yours ' + vc.mine.toFixed(1) + ' from it' + (vc.edgedesk != null ? ', EdgeDesk’s ' + vc.edgedesk.toFixed(1) : '') + ')');
      return (e.away || '?') + ' @ ' + (e.home || '?') + ' — ' + bits.join(', ');
    });
    var detail = ns.graded ? ['Of ' + plural(ns.graded, 'number') + ' with a close on file, yours sat nearer the close in ' + ns.mine_nearer + ', EdgeDesk’s in ' + ns.edgedesk_nearer + ', level in ' + ns.level + '.'] : [];
    return out('MY_NUMBERS', head, lines, { detail: detail, sources: [SRC.journal], actions: ['journal'],
      missing: (ns.sample_note ? [ns.sample_note] : []).concat(['Neither number is declared right: the close is the market’s last word, and one game says little about any number']) });
  };

  A.REL_WHY = function (d, now) {
    var s = d.game_state;
    if (!s) return out('REL_WHY', 'Which game? Open its research card or name one of its teams, and EdgeDesk will read that game’s reliability history.', [], { sources: [SRC.slate] });
    if (s.sport === 'nfl') return out('REL_WHY', 'The NFL model publishes no reliability score, so there is no reliability change to explain for ' + matchup(s) + '.', [], { sources: [SRC.slate] });
    var hs = (d.history || []).slice().sort(function (a, b) { return Date.parse(a.computed_at) - Date.parse(b.computed_at); });
    var last = null;
    for (var i = hs.length - 1; i > 0; i--) {
      var ra = num(hs[i - 1].state && hs[i - 1].state.reliability && hs[i - 1].state.reliability.score);
      var rb = num(hs[i].state && hs[i].state.reliability && hs[i].state.reliability.score);
      if (ra != null && rb != null && Math.round(ra) !== Math.round(rb)) { last = { a: hs[i - 1], b: hs[i], ra: ra, rb: rb }; break; }
    }
    var cur = num(s.reliability && s.reliability.score);
    if (!last) return out('REL_WHY', matchup(s) + ': ' + (cur != null ? 'reliability is ' + Math.round(cur) + ' and EdgeDesk has recorded no change to it' : 'reliability is not measured') + ' in the history it keeps.',
      s.reliability && s.reliability.main_deduction ? ['Current main deduction: ' + s.reliability.main_deduction] : [], { sources: [SRC.history] });
    var along = P.changes(last.a.state, last.b.state, { fair_move_pts: 0.25, market_move_pts: 0.5, reliability_change_pts: 1000, diverge_pts: 1 })
      .filter(function (c) { return c.kind !== 'reliability_change' && c.kind !== 'reliability_min'; }).map(function (c) { return c.text; });
    var lines = ['Reliability moved from ' + Math.round(last.ra) + ' to ' + Math.round(last.rb) + ' at ' + when(last.b.computed_at) + '.'];
    if (along.length) lines.push('What changed in the same update: ' + along.slice(0, 3).join(' '));
    else lines.push('No quarterback, availability, market or fair-line change was recorded in that update; the change came from inputs the state does not itemise (their ages or sources).');
    if (last.b.state.reliability && last.b.state.reliability.main_deduction) lines.push('Main deduction after the change: ' + last.b.state.reliability.main_deduction);
    return out('REL_WHY', 'Why ' + matchup(s) + '’s reliability changed:', lines, { sources: [SRC.history],
      missing: ['EdgeDesk stores each state’s score and main deduction, not its full six-component breakdown, so it cannot attribute the change point by point'] });
  };

  A.ALERTS = function (d, now) {
    var a = (d.alerts || []).slice(0, 6);
    if (!a.length) return out('ALERTS', 'You have no research alerts. They arrive when a watched game’s fair line, market, reliability, quarterback or availability changes past your thresholds.', [], { sources: [SRC.alerts], actions: ['alerts'] });
    return out('ALERTS', 'Your most recent research alerts' + ((d.alerts || []).filter(function (x) { return !x.read_at; }).length ? ' (' + (d.alerts || []).filter(function (x) { return !x.read_at; }).length + ' unread)' : '') + ':',
      a.map(function (x) { return x.title.replace(/ · .*$/, '') + ' — ' + (x.body || '') + ' (' + when(x.created_at) + ')'; }), { sources: [SRC.alerts], actions: ['alerts'] });
  };

  /* which game a REL_WHY question means: the card the reader has open, else a
     team the question names among the reader's watched games and the slate */
  M.resolveGame = function (q, states, rc) {
    states = states || [];
    if (rc && rc.game_id) {
      var hit = states.filter(function (s) { return String(s.game_id) === String(rc.game_id); })[0];
      if (hit) return hit;
    }
    var ql = String(q || '').toLowerCase(), best = null, bestLen = 0;
    states.forEach(function (s) {
      [s.home, s.away].forEach(function (t) { var tl = String(t || '').toLowerCase(); if (tl.length > 3 && ql.indexOf(tl) >= 0 && tl.length > bestLen) { best = s; bestLen = tl.length; } });
    });
    return best;
  };

  /* ------------------------------------------------------------ the critic
     When the host lets a model rephrase, the rephrasing may use only the
     numbers and team names of the deterministic answer, keep the research-only
     wording and stay short. Anything else falls back to EdgeDesk's words. */
  M.numbersIn = function (t) { return (String(t).match(/[+\-−]?\d+(?:\.\d+)?/g) || []).map(function (x) { return Math.abs(parseFloat(x.replace('−', '-'))); }); };
  M.NARRATION_CONTRACT = 'Rephrase the research answer below for a sports bettor, in at most five short sentences. '
    + 'Use ONLY facts, numbers and team names that appear in it; add nothing. Keep every number exactly as written. '
    + 'This is research, not picks: never tell the reader to bet, never use the words lock, guaranteed, smash or must bet, '
    + 'and never state a probability of winning that is not in the text. If the text says something is missing, say so.';
  M.critic = function (prose, o) {
    var f = [];
    if (!prose || !String(prose).trim()) f.push({ code: 'EMPTY' });
    if (!P.copyOk(prose)) f.push({ code: 'COPY_RULE' });
    var allowed = (o && o.numbers) || [];
    M.numbersIn(prose).forEach(function (n) { if (!allowed.some(function (a) { return Math.abs(a - n) < 1e-9; })) f.push({ code: 'INVENTED_NUMBER', detail: n }); });
    if (String(prose).length > 1400) f.push({ code: 'TOO_LONG' });
    return { verdict: f.length ? 'FAIL' : 'PASS', findings: f };
  };
  return M;
});
/*__EDMINE_END__*/
