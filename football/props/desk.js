/*__EDPROPS_START__*/
/* ============================================================================
   PLAYER PROPS FOR THE AI DESK — deterministic answers over the published
   player-prop research (football/props/published/*).

     "Why does EdgeDesk like this WR over 72.5?"              PROP
     "Is Travis Kelce over 61.5 receiving yards at -115 good?" PROP (a line and price)
     "What's Josh Allen's passing yards projection?"          PROP
     "Best player props today?" / "any NFL prop edges"        PROP_BOARD

   Every number in an answer is a number the board or the research card
   published, or one computed from the published distribution by the shared
   kernel (lib/player_props.js) at the line and price the reader named. It
   says what the MODEL sees, what the MARKET sees, why they differ, the
   supporting factors, the risks and what would invalidate the edge — and,
   when no sportsbook line was captured, that there is no market, never a
   guessed one. Research, not picks.

   It runs BEFORE the game desk: "over 225.5 passing yards" is a player's
   line, and the game desk would otherwise read "over" as the game total.
   ========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EDPROPS = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';
  var VERSION = 'edgedesk_props_desk_v1';
  var SCHEMA = 'edgedesk_props_desk_block_v1';

  function K() {
    var k = root && root.EDProps;
    if (!k && typeof require === 'function' && typeof module === 'object') { try { k = require('../../lib/player_props.js'); } catch (e) { k = null; } }
    return k;
  }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function pct(x, d) { return isNum(x) ? (100 * x).toFixed(d == null ? 1 : d) + '%' : 'n/a'; }
  function spct(x) { return isNum(x) ? (x >= 0 ? '+' : '') + (100 * x).toFixed(1) + '%' : 'n/a'; }
  function am(a) { return isNum(a) ? (a > 0 ? '+' : '') + Math.round(a) : 'n/a'; }
  function n1(x) { return isNum(x) ? (Math.round(x * 10) / 10).toString() : 'n/a'; }
  function norm(s) { var t = String(s == null ? '' : s).toLowerCase(); try { t = t.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) {} return t.replace(/[.'’`]/g, '').replace(/-/g, ' ').replace(/\b(jr|sr|ii|iii|iv)\b/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }

  /* ------------------------------------------------------------ intent */
  var MARKET_WORDS = [
    ['pass_rush_rec_yards', /\b(pass(ing)?\s*\+\s*rush(ing)?\s*\+\s*rec(eiving)?|total (scrimmage|offense) yards)\b/],
    ['pass_rush_yards', /\b(pass(ing)?\s*(\+|and|&)\s*rush(ing)?\s*y(ar)?ds)\b/],
    ['rush_rec_yards', /\b(rush(ing)?\s*(\+|and|&)\s*rec(eiving)?\s*y(ar)?ds|scrimmage yards)\b/],
    ['receptions_rush_attempts', /\b(receptions?\s*(\+|and|&)\s*(carries|rush attempts))\b/],
    ['pass_longest_completion', /\blongest (completion|pass)\b/],
    ['longest_reception', /\blongest (reception|catch)\b/],
    ['longest_rush', /\blongest (rush|run|carry)\b/],
    ['pass_yards', /\b(pass(ing)?\s*y(ar)?ds|passing)\b/],
    ['pass_tds', /\b(pass(ing)?\s*(td|tds|touchdowns?))\b/],
    ['pass_completions', /\bcompletions?\b/],
    ['pass_attempts', /\b(pass(ing)? attempts?|pass att)\b/],
    ['pass_interceptions', /\b(interceptions?|ints?|picks)\b/],
    ['receiving_yards', /\b(rec(eiving)?\s*y(ar)?ds|receiving)\b/],
    ['receptions', /\b(receptions?|catches)\b/],
    ['targets', /\btargets?\b/],
    ['receiving_tds', /\b(receiving (td|tds|touchdowns?))\b/],
    ['rush_attempts', /\b(rush(ing)? attempts?|carries)\b/],
    ['rush_tds', /\b(rush(ing)? (td|tds|touchdowns?))\b/],
    ['rush_yards', /\b(rush(ing)?\s*y(ar)?ds|rushing)\b/],
    ['anytime_td', /\b(anytime (td|touchdown)|score a (td|touchdown)|td scorer|to score)\b/]
  ];
  var PROP_WORDS = /\b(player props?|props?\b|prop bets?|over|under|alt(ernate)? lines?|o\d|u\d)\b/;
  var BOARD_WORDS = /\b(best|top|any|which|biggest|strongest)\b[^?]*\b(player )?props?\b|\bprop (edges?|value|board)\b/;
  function classify(q) {
    var s = ' ' + String(q || '').toLowerCase() + ' ';
    if (s.length > 402) return null;
    var market = null;
    for (var i = 0; i < MARKET_WORDS.length; i++) if (MARKET_WORDS[i][1].test(s)) { market = MARKET_WORDS[i][0]; break; }
    var line = null, side = null, price = null;
    var ml = /\b(over|under|o|u)\s*(\d{1,3}(?:\.\d)?)\b/.exec(s);
    if (ml) { side = ml[1][0] === 'o' ? 'over' : 'under'; line = Number(ml[2]); }
    var mp = /(^|[\s(@,])([+-]\d{3,4})\b/.exec(s);
    if (mp) price = Number(mp[2]);
    if (/\b(anytime|to score|td scorer)\b/.test(s)) { market = 'anytime_td'; side = /\b(no|not)\b/.test(s) ? 'no' : 'yes'; }
    var board = BOARD_WORDS.test(s);
    var league = /\b(nfl|pro)\b/.test(s) ? 'NFL' : (/\b(cfb|college|ncaa[f]?)\b/.test(s) ? 'CFB' : null);
    if (board && !market) return { intent: 'PROP_BOARD', league: league };
    if (!market && !(PROP_WORDS.test(s) && line != null)) return null;
    /* a game total or spread question is not a player prop: "over 47.5" with
       "total"/"points"/"spread" and no player market word stays with the desk */
    if (!market && /\b(total|points|spread|moneyline|ml)\b/.test(s)) return null;
    return { intent: 'PROP', market: market, side: side, line: line, price: price, league: league };
  }

  /* ------------------------------------------------------------ resolve */
  /* the players a question names, from the boards' rows: a full name, or a
     last name that is unique on the board */
  function findPlayer(boards, q) {
    var s = ' ' + norm(q) + ' ';
    var byId = {}, all = [];
    (boards || []).forEach(function (b) { (b && b.rows || []).forEach(function (r) { var k = r.player_id; if (!byId[k]) { byId[k] = { player_id: k, player: r.player, league: b.league, rows: [] }; all.push(byId[k]); } byId[k].rows.push(r); }); });
    var full = all.filter(function (p) { var n = norm(p.player); return n && s.indexOf(' ' + n + ' ') >= 0; });
    if (full.length === 1) return { player: full[0] };
    if (full.length > 1) return { ambiguous: full.map(function (p) { return p.player + ' (' + p.league + ')'; }) };
    var last = {};
    all.forEach(function (p) { var parts = norm(p.player).split(' '); var ln = parts[parts.length - 1]; if (ln && ln.length > 2 && s.indexOf(' ' + ln + ' ') >= 0) (last[ln] = last[ln] || []).push(p); });
    var keys = Object.keys(last);
    if (keys.length === 1 && last[keys[0]].length === 1) return { player: last[keys[0]][0], by: 'last name' };
    if (keys.length) return { ambiguous: [].concat.apply([], keys.map(function (k) { return last[k].map(function (p) { return p.player + ' (' + p.league + ')'; }); })) };
    return null;
  }
  function pickRow(player, intent) {
    var rows = player.rows.slice();
    if (intent.market) { var m = rows.filter(function (r) { return r.market === intent.market; }); if (m.length) return m[0]; return { missing_market: intent.market, available: rows.map(function (r) { return r.market; }) }; }
    rows.sort(function (a, b) { return ((b.focus && b.focus.cev) || -1) - ((a.focus && a.focus.cev) || -1); });
    return rows[0];
  }

  /* ------------------------------------------------------------ answer */
  function marketLabel(k) { var M = K(); return M ? M.marketLabel(k) : String(k); }
  function answer(q, intent, prop, opts) {
    opts = opts || {};
    var M = K(), m = prop.model || {}, mk = prop.market, f = prop.focus, ex = prop.explain || {};
    var facts = [80];                                   /* the "80% range" the text names */
    var add = function (x) { if (isNum(x)) facts.push(x); return x; };
    var lines = [];
    var lab = marketLabel(prop.market_key);
    lines.push(prop.player + ' — ' + lab + ' (' + prop.matchup + ', ' + prop.league + ').');
    /* MODEL */
    var mTxt = 'Model: EdgeDesk projects ' + n1(add(m.mean)) + ' (median ' + n1(add(m.median)) + ', 80% range ' + n1(add(m.p10)) + ' to ' + n1(add(m.p90)) + ')';
    if (isNum(m.ref_line)) mTxt += '; P(over ' + add(m.ref_line) + ') ' + pct(add(m.over_prob)) + ', fair ' + am(add(m.fair_over)) + ' / under ' + am(add(m.fair_under));
    else if (prop.family === 'bern' || prop.market_key === 'anytime_td') mTxt += '; P(yes) ' + pct(add(m.over_prob)) + ', fair ' + am(add(m.fair_over));
    lines.push(mTxt + '.');
    /* the reader's own line and price, priced from the same distribution */
    var ask = null;
    if (M && m.dist && (intent.line != null || intent.price != null || intent.side)) {
      var side = intent.side || (m.dist.t === 'bern' ? 'yes' : 'over');
      var line = intent.line != null ? intent.line : (f && isNum(f.line) ? f.line : (mk && isNum(mk.consensus_line) ? mk.consensus_line : m.ref_line));
      var price = intent.price != null ? intent.price : (f && f.side === side && f.line === line ? f.american : null);
      if (m.dist.t === 'bern' || isNum(line)) {
        var sp = M.sideProbs(m.dist, side, m.dist.t === 'bern' ? null : line);
        if (sp) {
          var cover = sp.win + sp.loss > 0 ? sp.win / (sp.win + sp.loss) : null;
          var fair = M.evaluateQuote(m.dist, { side: side, line: line, american_price: price || -110, lineage: 'observed' }, {}).fair_american;
          ask = { side: side, line: line, price: price, prob: cover, push: sp.push, fair: fair };
          var t = 'At ' + side + (m.dist.t === 'bern' ? '' : ' ' + add(line)) + ': model probability ' + pct(add(cover)) + (sp.push > 0 ? ' (push ' + pct(add(sp.push)) + ')' : '') + ', fair price ' + am(add(fair));
          if (isNum(price)) {
            var e = M.evaluateQuote(m.dist, { side: side, line: line, american_price: price, lineage: 'observed' }, {});
            if (e.ok) { add(price); add(e.implied_prob); add(e.ev); t += '; at ' + am(price) + ' the break-even is ' + pct(e.implied_prob) + ' and the expected return is ' + spct(e.ev) + ' per unit'; ask.ev = e.ev; }
          }
          lines.push(t + '.');
        }
      }
    }
    /* MARKET */
    if (mk && isNum(mk.consensus_line)) {
      lines.push('Market: ' + add(mk.book_count) + ' book' + (mk.book_count === 1 ? '' : 's') + ', consensus ' + add(mk.consensus_line) + (isNum(mk.consensus_over_prob) ? ' with a no-vig over probability of ' + pct(add(mk.consensus_over_prob)) : '') +
        (mk.best_over_price ? '; best over ' + am(add(mk.best_over_price.american)) + ' at ' + mk.best_over_price.sportsbook : '') + (mk.best_under_price ? ', best under ' + am(add(mk.best_under_price.american)) + ' at ' + mk.best_under_price.sportsbook : '') + '.');
      if (prop.movement && prop.movement.available && isNum(prop.movement.line_move) && prop.movement.line_move !== 0) lines.push('The line has moved ' + (prop.movement.line_move > 0 ? '+' : '') + add(prop.movement.line_move) + ' since the first capture; EdgeDesk does not treat movement as predictive.');
    } else if (mk && mk.binary) {
      lines.push('Market: ' + add(mk.book_count) + ' book(s), no-vig yes probability ' + pct(add(mk.consensus_over_prob)) + '.');
    } else {
      lines.push('Market: no observed sportsbook line has been captured for this prop, so there is no market probability, edge or EV to report — only the model.');
    }
    /* EDGE */
    if (f) {
      add(f.line); add(f.american); add(f.model_prob); add(f.market_prob); add(f.edge_vs_market); add(f.ev); add(f.conservative_ev); add(f.fair_american);
      lines.push('Edge: the best-value quote is ' + f.side + (isNum(f.line) ? ' ' + f.line : '') + ' ' + am(f.american) + ' at ' + f.sportsbook + ' — model ' + pct(f.model_prob) + ' vs market ' + pct(f.market_prob) +
        ' (' + spct(f.edge_vs_market) + '), fair ' + am(f.fair_american) + ', EV ' + spct(f.ev) + ' (conservative ' + spct(f.conservative_ev) + '). Label: ' + (prop.decision ? prop.decision.decision : 'PASS') + '.');
    }
    /* WHY / SUPPORT / RISKS / INVALIDATORS — from the published explanation only */
    var drv = (prop.drivers || []).slice(0, 3);
    drv.forEach(function (d) { add(d.value); add(d.pct); });
    if (drv.length) lines.push('Why the model sits where it does: ' + drv.map(function (d) { return d.text; }).join('; ') + '.');
    if (ex.risks && ex.risks.length) lines.push('Risks: ' + ex.risks.slice(0, 3).join(' '));
    if (ex.invalidators && ex.invalidators.length) lines.push('What would invalidate it: ' + ex.invalidators.slice(0, 2).join(' '));
    var c = prop.confidence || {}, dq = prop.data_quality || {};
    lines.push('Confidence ' + (isNum(c.score) ? add(c.score) : 'unknown') + (c.grade ? ' (' + c.grade + ')' : '') + ', data quality ' + (isNum(dq.score) ? add(dq.score) : 'unknown') +
      '; model ' + m.model_version + ', outcome tier ' + m.outcome_tier + ', market tier ' + m.market_tier + '. Research, not picks.');
    if (intent.side && ask && isNum(ask.ev) && ask.ev <= 0) lines.splice(1, 0, 'Short answer: at that price EdgeDesk does NOT see value — the model makes it ' + pct(ask.prob) + ' against a break-even above that.');
    else if (intent.side && ask && isNum(ask.ev) && ask.ev > 0) lines.splice(1, 0, 'Short answer: at that price the model sees positive expected value (' + spct(ask.ev) + '), with the caveats below.');
    return { text: lines.join('\n'), facts: facts, ask: ask, prop_id: prop.id };
  }
  function boardAnswer(boards, intent) {
    var rows = [];
    (boards || []).forEach(function (b) { if (!intent.league || b.league === intent.league) (b.rows || []).forEach(function (r) { rows.push(r); }); });
    var priced = rows.filter(function (r) { return r.focus && isNum(r.focus.cev); }).sort(function (a, b) { return b.focus.cev - a.focus.cev; });
    if (!rows.length) return { text: 'No player-prop board is published' + (intent.league ? ' for ' + intent.league : '') + ' right now.', facts: [] };
    if (!priced.length) return { text: 'EdgeDesk has ' + rows.length + ' player-prop projections on the board' + (intent.league ? ' (' + intent.league + ')' : '') + ', but no observed sportsbook line has been captured for any of them, so there is no market, edge or EV to rank. Open a player in Research › Props to see the model distribution; nothing is presented as a price. Research, not picks.', facts: [rows.length] };
    var top = priced.slice(0, 5), facts = [];
    var text = 'Strongest priced props by conservative expected value (research, not picks):\n' + top.map(function (r, i) {
      facts.push(r.focus.line, r.focus.am, r.focus.model, r.focus.market, r.focus.ev, r.focus.cev, r.conf);
      return (i + 1) + '. ' + r.player + ' ' + marketLabel(r.market) + ' ' + r.focus.side + (isNum(r.focus.line) ? ' ' + r.focus.line : '') + ' ' + am(r.focus.am) + ' (' + r.focus.book + '): model ' + pct(r.focus.model) + ' vs market ' + pct(r.focus.market) + ', EV ' + spct(r.focus.ev) + ', conservative ' + spct(r.focus.cev) + ', confidence ' + (isNum(r.conf) ? r.conf : 'n/a') + ', ' + (r.decision || 'PASS') + '.';
    }).join('\n') + '\nEvery label is capped at LEAN until the market calibration of these models is validated on observed quotes.';
    return { text: text, facts: facts };
  }

  /* ------------------------------------------------------------ packet + critic */
  function block(prop) {
    var m = prop.model || {};
    return { schema: SCHEMA, version: VERSION, prop_id: prop.id, player: prop.player, market_key: prop.market_key, league: prop.league, game_id: prop.game_id,
      model: { mean: m.mean, median: m.median, p10: m.p10, p90: m.p90, ref_line: m.ref_line, over_prob: m.over_prob, fair_over: m.fair_over, model_version: m.model_version, outcome_tier: m.outcome_tier, market_tier: m.market_tier },
      market: prop.market ? { consensus_line: prop.market.consensus_line, consensus_over_prob: prop.market.consensus_over_prob, book_count: prop.market.book_count } : null,
      focus: prop.focus || null, confidence: prop.confidence ? prop.confidence.score : null, data_quality: prop.data_quality ? prop.data_quality.score : null,
      drivers: (prop.drivers || []).slice(0, 5).map(function (d) { return d.text; }) };
  }
  /* every number > 1 in the prose must be a published fact (rounded as printed) */
  function critic(text, facts) {
    var allowed = [];
    (facts || []).forEach(function (x) { if (isNum(x)) { allowed.push(x, Math.round(x * 10) / 10, Math.round(x), Math.abs(x), Math.round(Math.abs(x) * 10) / 10, Math.round(x * 1000) / 10, Math.round(Math.abs(x) * 1000) / 10); } });
    var bad = [];
    String(text || '').replace(/-?\d+(\.\d+)?/g, function (tok) {
      var v = Math.abs(Number(tok));
      if (!isFinite(v) || v <= 10 || (v >= 1990 && v <= 2100)) return tok;
      if (!allowed.some(function (a) { return Math.abs(Math.abs(a) - v) < 0.051; })) bad.push(tok);
      return tok;
    });
    return { ok: bad.length === 0, unsupported: bad };
  }

  /* the published artifacts are packed (lib/player_props.js › wire) and are
     unpacked with the kernel itself, so the desk reads what the page reads */
  function expandBoard(b) { var k = K(); return k && k.wire ? k.wire.expandBoard(b) : b; }
  function expandCard(card, market) { var k = K(); return k && k.wire ? k.wire.expandCard(card, market) : []; }

  return { VERSION: VERSION, SCHEMA: SCHEMA, expandBoard: expandBoard, expandCard: expandCard, classify: classify, findPlayer: findPlayer, pickRow: pickRow, answer: answer, boardAnswer: boardAnswer, block: block, critic: critic, norm: norm };
});
/*__EDPROPS_END__*/
