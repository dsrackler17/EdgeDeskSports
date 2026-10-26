/* ===========================================================================
   EDGEDESK SIMULATOR — UFC fights and title path (registered with
   EDSimUI.registerSport).

   Three tabs, all from the published run (supabase/simulator.sql sim_*):
     Fights        every card on the schedule, bout by bout: each fighter's
                   chance to win (± the simulation's sampling error) with fair
                   decimal and American odds, finish v decision, the round of
                   a finish, and for a title fight the chance of a new
                   champion; beside it the market's price without its margin
                   and the disagreement guard's verdict: a gap over the
                   threshold is "Model disagrees with market", with the
                   factors that likely explain it and no fair odds (never an
                   edge unless the study certified gaps that size)
     Title Path    each division over the horizon: the champion, a booked
                   title fight, and each contender's chance to hold the title
                   at the horizon, to win it, to get a shot, and to beat the
                   champion when given one — Estimated (the matchmaking rule
                   is EdgeDesk's, stated in plain words)
     Model Health  the served Elo's record in plain language, the served model
                   and 1.1.0 against the closing line (log loss, Brier, a
                   calibration chart, how large gaps resolved, the guard's
                   certification, which changes were kept), the champions'
                   record against it by period and the weekly champion-term
                   test, how well the finish model did out of sample

   Per-bout and per-division numbers ride in the run's
   validation_summary.sport_summary (simulator/src/sports/ufc/run.ts
   readerSummary); per-fighter outcomes are the published result rows. Every
   value reaches the page through EDSimUI.esc.

   Browser: registers itself on window.EDSimUI. Node: require() for tests.
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.EDSimUI && root.EDSimUI.registerSport) root.EDSimUI.registerSport('ufc', api.adapter);
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';
  var U = (root && root.EDSimUI) || (typeof require === 'function' ? require('./edgedesk_simulator.js') : null);
  var esc = U.esc, badge = U.badge, cell = U.cell, isNum = U.isNum;
  var DIV_LABEL = { 'W Strawweight': 'Women’s Strawweight', 'W Flyweight': 'Women’s Flyweight', 'W Bantamweight': 'Women’s Bantamweight' };

  /* ------------------------------------------------------------ helpers */
  function divName(k) { return DIV_LABEL[k] || k || '—'; }
  function pct(x, d) { return isNum(x) ? (x * 100).toFixed(d == null ? 1 : d) + '%' : '—'; }
  /* fair American odds from a probability (no margin): -150 for 60%, +150 for 40% */
  function american(p) {
    if (!isNum(p) || p <= 0 || p >= 1) return '—';
    var v = p >= 0.5 ? -100 * p / (1 - p) : 100 * (1 - p) / p;
    return (v > 0 ? '+' : '') + Math.round(v);
  }
  function decimal(p) { return isNum(p) && p > 0 ? (1 / p).toFixed(2) : '—'; }
  /* a simulated share {count, probability, mcse}: "45.6% ±0.7" (the ± is 1.96 x the sampling error) */
  function share(x) {
    if (!x || !isNum(x.probability)) return '—';
    var h = 1.96 * (x.mcse || 0) * 100;
    return pct(x.probability) + (x.count > 0 && x.probability < 1 ? ' ±' + (h < 0.1 ? h.toFixed(2) : h.toFixed(1)) : '');
  }
  function summary(c) { return (c.run && c.run.validation_summary && c.run.validation_summary.sport_summary) || null; }
  function outcomes(c) {
    var by = {};
    (c.results || []).forEach(function (r) { (by[r.entity_id] = by[r.entity_id] || {})[r.outcome] = r; });
    return by;
  }
  function day(iso) { var t = Date.parse(iso || ''); if (!isFinite(t)) return '—'; try { return new Date(t).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); } catch (_) { return String(iso).slice(0, 10); } }
  function rec(r) { return r && isNum(r.w) ? r.w + '-' + r.l + (r.d ? '-' + r.d : '') : '—'; }
  function tag(s, title) { return '<span class="sm-tag"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + esc(s) + '</span>'; }
  function signed(x, d) { return isNum(x) ? (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(d == null ? 1 : d) : '—'; }
  function amTxt(v) { return isNum(v) ? (v > 0 ? '+' : '') + Math.round(v) : '—'; }
  function stamp(iso) { var t = Date.parse(iso || ''); if (!isFinite(t)) return '—'; try { return new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC'; } catch (_) { return String(iso).slice(0, 16); } }
  function disagrees(b) { return !!(b && b.guard && b.guard.status === 'DISAGREES'); }

  /* ------------------------------------------------------------ the guard */
  /** model v market for one bout; a disagreement is labelled with its likely reasons, never shown as an edge */
  function guardBlock(b) {
    var g = b.guard, m = b.market;
    if (!g) return '';
    var line = '<div class="sm-mk sm-small"><b>Model v market</b> · ' + esc(b.a.name) + ': model ' + esc(pct(b.served_p_a))
      + ' · market ' + (m ? esc(pct(m.p_a)) + ' <span class="sm-dim">(no vig; ' + esc(m.book || 'book') + ' ' + esc(amTxt(m.price_a)) + ' / ' + esc(amTxt(m.price_b)) + ', ' + esc(stamp(m.observed_at)) + ')</span>' : '<span class="sm-dim">no price on file</span>')
      + (isNum(g.gap_pp) ? ' · gap ' + esc(signed(g.gap_pp)) + ' pts' : '')
      + (b.compare ? ' <span class="sm-dim">· ' + esc(b.compare.version) + ' said ' + esc(pct(b.compare.p_a)) + '</span>' : '') + '</div>';
    if (g.status !== 'DISAGREES') return line;
    var fs = (g.factors || []).map(function (x) {
      var r = x.record;
      return '<li>' + esc(x.text) + (r && isNum(r.won) ? ' <span class="sm-dim">— since 2018 in bouts like this the model said ' + esc(pct(r.model_said)) + ', the close ' + esc(pct(r.close_said)) + ', and the fighter won ' + esc(pct(r.won)) + ' (' + esc(U.int(r.n)) + ' bouts)</span>' : '') + '</li>';
    }).join('');
    return line + '<div class="sm-guard"><span class="sm-tag sm-dis">' + esc(g.label || 'Model disagrees with market') + '</span> <span class="sm-small">' + esc(g.signal_allowed
      ? 'Gaps this size have been certified to beat the closing line.'
      : 'Not an edge: the model and the market differ by more than ' + g.threshold_pp + ' points, and on gaps that size the closing line has been right far more often than the model.') + '</span>'
      + (fs ? '<div class="sm-small" style="margin-top:4px">What the model likely misreads here:</div><ul class="sm-list sm-small">' + fs + '</ul>'
        : '<div class="sm-dim sm-small" style="margin-top:4px">None of the factors the model is known to misread (a short UFC sample, a long layoff, age, a weight change, a rematch) is present: the market likely knows something the model does not see (style, camp, injuries, short notice).</div>') + '</div>';
  }

  /* ------------------------------------------------------------ Fights */
  function fighterLine(x, win, fin, dec, hideOdds) {
    var bits = [];
    if (x.champion) bits.push(tag('Champion', 'ufc.com champion'));
    else if (isNum(x.rank)) bits.push(tag('#' + x.rank + ' ' + divName(x.ranked_division), 'ufc.com ranking'));
    if (x.debut) bits.push(tag('UFC debut', 'no UFC bout in the data: priced from the served model’s starting rating (since 1.2.0 a prior from the pro record before the UFC; 1500 under 1.0 and 1.1)'));
    var p = win && win.probability;
    return '<tr><td><b>' + esc(x.name) + '</b> ' + bits.join(' ') + '<div class="sm-dim sm-small">UFC record in the data ' + esc(rec(x.record)) + ' · Elo ' + esc(isNum(x.rating) ? x.rating.toFixed(0) : '—') + '</div></td>'
      + '<td class="sm-num"><b>' + esc(share(win)) + '</b>' + (hideOdds ? '<div class="sm-dim sm-small" title="Withheld: the model disagrees with the market by more than the guard allows, so its price is not offered as a fair line">fair odds withheld</div>' : '<div class="sm-dim sm-small" title="Fair decimal and American odds: no margin">' + esc(decimal(p)) + ' · ' + esc(american(p)) + '</div>') + '</td>'
      + '<td class="sm-num">' + esc(share(fin)) + '</td><td class="sm-num">' + esc(share(dec)) + '</td></tr>';
  }
  function boutCard(b) {
    var head = (b.title ? badge('Research') + ' <span class="sm-tag sm-clinch">' + esc(divName(b.title.division)) + ' title</span> ' : badge('Research') + ' ')
      + '<span class="sm-dim">' + esc(divName(b.weight_class)) + ' · ' + esc(b.rounds) + ' rounds' + (b.order === 1 ? ' · main event' : '') + '</span>';
    var rounds = (b.finish_rounds || []).map(function (r, k) { return 'R' + (k + 1) + ' ' + share(r); }).join(' · ');
    var dis = disagrees(b);
    if (dis) head += ' <span class="sm-tag sm-dis">' + esc(b.guard.label || 'Model disagrees with market') + '</span>';
    return '<div class="sm-card' + (dis ? ' sm-card-dis' : '') + '"><div class="sm-small" style="margin-bottom:6px">' + head + '</div>'
      + '<div class="sm-scroll"><table class="sm-tbl"><thead><tr><th>Fighter</th><th title="Share of simulated fights won (± the 95% sampling half-width); below it the fair decimal and American odds (no margin)">Wins · fair odds</th><th title="Wins by a finish (KO/TKO, submission, stoppage: the data do not tell them apart)">By finish</th><th title="Wins on the scorecards (the bout went the distance)">By decision</th></tr></thead><tbody>'
      + fighterLine(b.a, b.a_win, b.a_finish, b.a_decision, dis) + fighterLine(b.b, b.b_win, b.b_finish, b.b_decision, dis) + '</tbody></table></div>'
      + '<div class="sm-small" style="margin-top:6px">Ends in a finish ' + esc(share(b.finish)) + ' · goes the distance ' + esc(share(b.decision)) + '</div>'
      + '<div class="sm-dim sm-small">Finish by round: ' + esc(rounds) + '</div>'
      + (b.new_champion ? '<div class="sm-small"><b>New champion:</b> ' + esc(share(b.new_champion)) + (dis ? ' <span class="sm-dim">· fair odds withheld</span>' : ' · fair ' + esc(decimal(b.new_champion.probability)) + ' (' + esc(american(b.new_champion.probability)) + ')') + '</div>' : '')
      + '<div class="sm-dim sm-small">Served Elo price: ' + esc(b.a.name) + ' ' + esc(pct(b.served_p_a)) + (isNum(b.published_p_a) ? ' (the model loop published ' + esc(pct(b.published_p_a, 2)) + ')' : '') + (b.basis === 'debut' ? ' · a debutant is priced from the model’s starting rating' : '') + '</div>'
      + guardBlock(b) + '</div>';
  }
  function renderFights(c) {
    var S = summary(c); if (!S) return '<div class="sm-card sm-empty">This run carries no fight summary.</div>';
    var cards = S.cards || [];
    if (!cards.length) return '<div class="sm-card sm-empty">No bout is on the schedule.</div>';
    var nr = c.run && c.run.n_sims;
    var all = [].concat.apply([], cards.map(function (cd) { return cd.bouts; }));
    var nDis = all.filter(disagrees).length, nMk = all.filter(function (b) { return b.market; }).length;
    var GA = (S.model_health && S.model_health.guard) || {};
    var intro = '<div class="sm-card"><div class="sm-h">Every booked bout, ' + esc(U.int(nr)) + ' times</div><p class="sm-small">Who wins comes from the served UFC Elo’s price, kept exactly. How it ends — a finish or the scorecards, and the round of a finish — is measured from every UFC bout since 2014: the division, the scheduled rounds and each fighter’s own finish record. The data carry no method, so knockouts and submissions are not told apart. Every simulated fight has a winner: draws and no contests (under 2% of bouts) are left out.</p>'
      + '<p class="sm-small"><b>Model v market.</b> Each bout shows the market’s latest price with its margin removed beside the model’s. Where they differ by more than ' + esc(isNum(GA.threshold_pp) ? GA.threshold_pp : 8) + ' points the bout is labelled <span class="sm-tag sm-dis">Model disagrees with market</span>, with what the model likely misreads, and no fair odds: ' + esc(GA.certified ? 'gaps that size have been certified to beat the closing line.' : 'the model has not been shown to beat the closing line on gaps that size, so a disagreement is a reason to look closer, not an edge.') + ' ' + esc(nMk) + ' of ' + esc(all.length) + ' bouts have a market price; ' + esc(nDis) + ' disagree.</p></div>';
    return intro + cards.map(function (cd) {
      return '<div class="sm-sub"><div class="sm-h" style="margin:4px 0 8px">' + esc(cd.event) + ' <span class="sm-dim sm-small">' + esc(day(cd.date)) + '</span></div>' + cd.bouts.map(boutCard).join('') + '</div>';
    }).join('') + '<div class="sm-foot">Fair odds carry no bookmaker margin. They are an estimate, not a recommendation, and are withheld where the model disagrees with the market. The ± is simulation noise only, never the model’s accuracy (Model Health).</div>';
  }

  /* ------------------------------------------------------------ Title Path */
  function why(x, O) {
    var o = O[x.id] || {};
    if (x.champion) return 'champion';
    if (x.moved_from) return 'booked here, ranked at ' + divName(x.moved_from);
    if (o.title_shot && o.title_shot.outcome_count > 0) return x.booked ? 'booked bout first' : '';
    if (x.last_result === 'L') return 'coming off a loss';
    if (x.last_result === 'D') return 'last bout a draw or no contest';
    return x.booked ? 'booked bout first' : 'behind the contenders ahead';
  }
  /** the weekly test's numbers in plain words (docs/model-loop/ufc/candidates.jsonl delta: logloss, brier, <season>_logloss) */
  function termResult(LT) {
    var d = LT.delta || {}, sg = function (x) { return (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(5); };
    var season = Object.keys(d).filter(function (k) { return /^\d{4}_logloss$/.test(k); })[0];
    if (!isNum(d.logloss)) return '';
    return 'Over every bout since 2016 it moved the log loss by ' + sg(d.logloss) + ' (lower is better; adopting it takes a fall of at least 0.0005)'
      + (season && isNum(d[season]) ? ', and on ' + season.slice(0, 4) + ' alone by ' + sg(d[season]) : '') + '.';
  }
  /** one plain sentence on how the served Elo prices champions, from the run's title record and champion term */
  function champNote(H) {
    var CT = (H && H.champion_term) || {}, per = ((H && H.title_record && H.title_record.periods) || []).filter(function (x) { return x.decided > 0; });
    var gap = function (x) { return x.champion_won - x.elo_expected; }, yr = function (iso) { return String(iso || '').slice(0, 4); };
    var pre = 'Each title fight is priced by the served Elo' + (CT.served_bonus > 0 ? ', with ' + CT.served_bonus + ' extra rating points for the champion.' : '.');
    if (per.length < 2) return pre;
    var a = per[0], b = per[per.length - 1], ga = gap(a), gb = gap(b);
    var recent = Math.abs(gb) <= Math.max(2, 0.05 * b.decided)
      ? 'since ' + yr(b.from) + ' champions have won about as many title fights as it expected (' + b.champion_won + ' of ' + b.decided + ', expected ' + b.elo_expected.toFixed(1) + ')'
      : 'since ' + yr(b.from) + ' champions have won ' + (gb > 0 ? 'more' : 'fewer') + ' title fights than it expected (' + b.champion_won + ' of ' + b.decided + ', expected ' + b.elo_expected.toFixed(1) + ')';
    return pre + ' From ' + yr(a.from) + ' to ' + yr(a.to) + ' champions won ' + a.champion_won + ' of ' + a.decided + ' where it expected ' + a.elo_expected.toFixed(1) + (ga > 0 ? ' — it underrated them then' : '') + '; ' + recent + '.'
      + (CT.served_bonus > 0 ? '' : ' A champion term is tested every week (Model Health) and is adopted only if it improves the prices.');
  }
  function renderTitlePath(c) {
    var S = summary(c); if (!S) return '<div class="sm-card sm-empty">This run carries no title-path summary.</div>';
    var O = outcomes(c), M = S.matchmaking || {}, H = S.horizon || {};
    var intro = '<div class="sm-card"><div class="sm-h">Who becomes champion by ' + esc(day(H.to)) + '? ' + badge('Estimated') + '</div>'
      + '<p class="sm-small">Each division is played forward ' + esc(H.days) + ' days: the booked bouts first (a booked title fight decides the belt), then title fights at the division’s own pace — measured from its undisputed title fights over the last five years, never on a card already announced.</p>'
      + '<p class="sm-small"><b>Who gets the shot (EdgeDesk’s rule, not the UFC’s):</b> the highest-ranked contender who is coming off a win and has rested at least ' + esc(M.min_rest_days) + ' days since their last fight. Ranks start from ufc.com; a booked bout moves its winner to the loser’s place when the loser was ranked higher; a champion who loses waits (coming off a loss); a contender booked in another division counts there. Since 2014, ' + esc(M.challengers ? M.challengers.coming_off_win : '—') + ' of ' + esc(M.challengers ? M.challengers.n : '—') + ' title challengers were coming off a win, after a median ' + esc(M.challengers && M.challengers.rest_days ? M.challengers.rest_days.median : '—') + ' days out.</p>'
      + '<p class="sm-dim sm-small">' + esc(champNote(S.model_health)) + ' Interim belts, vacated titles, injuries and bouts not yet booked are not modelled.</p></div>';
    var divs = (S.divisions || []).map(function (v) {
      var champ = (v.people || []).filter(function (x) { return x.champion; })[0] || { name: '—' };
      var co = O[v.champion] || {};
      var rows = (v.people || []).slice().sort(function (a, b) {
        if (a.champion !== b.champion) return a.champion ? -1 : 1;
        var pa = (O[a.id] || {}).champion_at_horizon, pb = (O[b.id] || {}).champion_at_horizon;
        var d = (pb ? pb.probability : 0) - (pa ? pa.probability : 0);
        return d || ((isNum(a.rank) ? a.rank : 99) - (isNum(b.rank) ? b.rank : 99));
      }).filter(function (x) { var o = O[x.id] || {}; return x.champion || isNum(x.rank) || (o.title_shot && o.title_shot.outcome_count > 0); });
      /* a contender with no title shot in any simulated year is listed apart, with the reason, so the table stays short */
      var live = rows.filter(function (x) { var o = O[x.id] || {}; return x.champion || (o.title_shot && o.title_shot.outcome_count > 0); });
      var out = rows.filter(function (x) { return live.indexOf(x) < 0; });
      rows = live;
      var bk = v.booked_title;
      var bookedLine = bk ? '<div class="sm-small"><b>Booked title fight:</b> ' + esc(champ.name) + ' v ' + esc(((v.people || []).filter(function (x) { return x.id === bk.challenger; })[0] || { name: bk.challenger }).name) + ', ' + esc(day(bk.date)) + ' (' + esc(bk.event) + ') — Fights tab</div>' : '<div class="sm-small">No title fight booked on the cards listed.</div>';
      var r = v.rate || {};
      var pace = '<div class="sm-dim sm-small">' + esc(r.title_fights) + ' undisputed title fights in the five years to ' + esc(r.window ? r.window.to : '—') + ' (Wikipedia); about ' + esc(isNum(v.expected_title_fights) ? v.expected_title_fights.toFixed(1) : '—') + ' title fights expected before the horizon' + (r.interim_fights ? '; ' + esc(r.interim_fights) + ' interim title fight' + (r.interim_fights === 1 ? '' : 's') + ' in that time ' + (r.interim_fights === 1 ? 'is' : 'are') + ' not modelled' : '') + '.</div>';
      var moved = (v.moved_out || []).length ? '<div class="sm-dim sm-small">Ranked here but booked in another division (counted there): ' + v.moved_out.map(function (m) { var p = (S.divisions || []).reduce(function (a, d) { return a || (d.people || []).filter(function (x) { return x.id === m.id; })[0]; }, null); return esc(p ? p.name : m.id) + ' (' + esc(divName(m.to)) + ')'; }).join(', ') + '</div>' : '';
      var table = '<div class="sm-scroll"><table class="sm-tbl"><thead><tr><th>Fighter</th><th title="ufc.com rank">Rank</th><th title="Holds the title at the horizon (the champion: keeps it)">Champion at horizon</th><th title="Wins the title within the horizon (booked or simulated title fight)">Wins the title</th><th title="Fights for the title within the horizon (the champion: defends it at least once)">Title shot</th><th title="Of the simulated title shots, the share won">Beats the champion if given the shot</th><th>Note</th></tr></thead><tbody>'
        + rows.map(function (x) {
          var o = O[x.id] || {}, g = x.beat_champion_given_shot;
          return '<tr><td><b>' + esc(x.name) + '</b>' + (x.champion ? ' ' + tag('C', 'champion today (ufc.com)') : '') + '</td><td class="sm-num">' + esc(x.champion ? 'C' : isNum(x.rank) ? x.rank : '—') + '</td>' + cell(o.champion_at_horizon) + (x.champion ? '<td class="sm-num na">—</td>' : cell(o.win_title)) + cell(o.title_shot)
            + '<td class="sm-num" title="' + esc(g ? U.int(g.count) + ' of ' + U.int(g.of) + ' simulated title shots' : '') + '">' + esc(g ? pct(g.probability) : '—') + '</td><td class="sm-dim sm-small">' + esc(why(x, O)) + '</td></tr>';
        }).join('') + '</tbody></table></div>'
        + (out.length ? '<div class="sm-dim sm-small" style="margin-top:6px"><b>No title shot in any simulated year:</b> ' + out.map(function (x) { return esc(x.name) + (isNum(x.rank) ? ' (#' + esc(x.rank) + ', ' + esc(why(x, O)) + ')' : ' (' + esc(why(x, O)) + ')'); }).join('; ') + '.</div>' : '');
      return '<div class="sm-card"><div class="sm-h">' + esc(divName(v.key)) + ' <span class="sm-dim sm-small">champion ' + esc(champ.name) + ' · keeps it to the horizon ' + esc(co.champion_at_horizon ? U.fmtProb(co.champion_at_horizon).text : '—') + '</span> ' + badge('Estimated') + '</div>'
        + bookedLine + pace + moved + table + '</div>';
    }).join('');
    return intro + divs + '<div class="sm-foot">Every number here passes through the matchmaking rule and the title-fight pace: Estimated, never a forecast of the UFC’s own booking. In each simulated year exactly one fighter per division holds the title at the horizon.</div>';
  }

  /* ------------------------------------------------------------ Model Health */
  function renderHealth(c) {
    var S = summary(c); if (!S || !S.model_health) return '<div class="sm-card sm-empty">This run carries no model record.</div>';
    var H = S.model_health, E = H.elo || {}, T = H.title_record || {}, F = H.finish || {};
    var f3 = function (x) { return isNum(x) ? x.toFixed(3) : '—'; };
    var elo = '<div class="sm-card"><div class="sm-h">The served fight model ' + badge('Observed') + '</div><p class="sm-small">Who wins every simulated fight comes from the model loop’s UFC Elo, version ' + esc(E.version) + ' (' + esc(E.status) + '). The simulator runs a line-for-line copy of it and checks, every run, that the copy reproduces every price the loop published: ' + esc(E.reproduced) + ' of ' + esc(E.published) + ' this run.</p>'
      + '<div class="sm-scroll"><table class="sm-tbl"><thead><tr><th>Bouts</th><th>N</th><th title="Lower is better; a coin scores 0.693">Log loss</th><th>Coin</th><th>Brier</th><th title="The Elo’s average chance for the fighter it favoured">Favourite: said</th><th title="How often that favourite won">Favourite: won</th></tr></thead><tbody>'
      + (H.windows || []).map(function (w) { return '<tr><td>' + esc(w.label) + '</td><td class="sm-num">' + esc(U.int(w.n)) + '</td><td class="sm-num">' + esc(f3(w.log_loss)) + '</td><td class="sm-num">' + esc(f3(w.coin)) + '</td><td class="sm-num">' + esc(f3(w.brier)) + '</td><td class="sm-num">' + esc(pct(w.favourite_p)) + '</td><td class="sm-num">' + esc(pct(w.favourite_won)) + '</td></tr>'; }).join('')
      + '</tbody></table></div><div class="sm-foot">In plain words: the Elo is better than a coin flip, but not by much. The validation and holdout rows are the preregistered backtest of the tuned 1.0.0; every later version is measured against 1.1.0 and the closing line in the next card.</div></div>';
    var CT = H.champion_term || {}, LT = CT.last_test;
    var per = (T.periods || []).filter(function (x) { return x.decided > 0; });
    var tr = '<div class="sm-card"><div class="sm-h">Champions against the Elo ' + badge('Observed') + '</div><p class="sm-small">In the ' + esc(T.decided) + ' undisputed title fights since 2014 with a champion defending and a winner (Wikipedia’s title history matched to the bouts), champions won <b>' + esc(T.champion_won) + '</b>; the Elo expected about <b>' + esc(isNum(T.elo_expected) ? T.elo_expected.toFixed(0) : '—') + '</b>. Its log loss on those fights was ' + esc(f3(T.log_loss)) + ' (a coin: ' + esc(f3(T.coin)) + ').</p>'
      + (per.length ? '<div class="sm-scroll"><table class="sm-tbl"><thead><tr><th>Title fights</th><th>N</th><th>Champions won</th><th title="The sum of the Elo’s chances for the champion">Elo expected</th><th>Champions ahead by</th></tr></thead><tbody>'
        + per.map(function (x) { var g = x.champion_won - x.elo_expected; return '<tr><td>' + esc(String(x.from).slice(0, 4)) + '–' + esc(String(x.to).slice(0, 4)) + '</td><td class="sm-num">' + esc(x.decided) + '</td><td class="sm-num">' + esc(x.champion_won) + '</td><td class="sm-num">' + esc(x.elo_expected.toFixed(1)) + '</td><td class="sm-num">' + esc((g >= 0 ? '+' : '−') + Math.abs(g).toFixed(1)) + '</td></tr>'; }).join('')
        + '</tbody></table></div>' : '')
      + '<p class="sm-small"><b>The champion term.</b> ' + (CT.served_bonus > 0
        ? 'The served Elo gives the champion going in ' + esc(CT.served_bonus) + ' extra rating points in an undisputed title fight; the fight prices and the Title Path both use it.'
        : 'The model loop tests, every week, giving the champion going in ' + esc(LT ? LT.bonus : 100) + ' extra rating points in an undisputed title fight, under the same preregistered rule as every other change (it must lower the log loss over every bout since 2016 by a clear margin and not be worse on the latest full season).'
          + (LT ? ' Latest test, ' + esc(day(String(LT.tested_at).slice(0, 10))) + ': <b>' + esc(LT.decision === 'PASS' ? 'passed' : 'not adopted') + '</b>. ' + esc(termResult(LT)) : '')
          + ' So the served Elo has no champion term, and title fights are priced without one.') + '</p>'
      + '<p class="sm-dim sm-small">' + esc(champNote(H)) + '</p></div>';
    var fin = '<div class="sm-card"><div class="sm-h">How fights end ' + badge('Research') + '</div><p class="sm-small">Since 2014, ' + esc(pct(F.rate_3)) + ' of three-round bouts and ' + esc(pct(F.rate_5)) + ' of five-round bouts with a winner ended in a finish. The finish model (the division, the format and each fighter’s finish record, shrunk toward the division by ' + esc(F.m) + ' bouts) was chosen on 2016–2022 and tested on ' + esc(U.int(F.n_holdout)) + ' later bouts: log loss ' + esc(f3(F.holdout_log_loss)) + ', against ' + esc(f3(F.base_only_log_loss)) + ' for the division and format alone and ' + esc(f3(F.constant_log_loss)) + ' for one rate for all.</p>'
      + '<p class="sm-dim sm-small">Draws and no contests: ' + esc(F.no_winner ? F.no_winner.draws + ' draws and ' + F.no_winner.no_contests + ' no contests in ' + U.int(F.no_winner.finals) + ' bouts (' + pct(F.no_winner.rate) + ')' : '—') + ', not simulated.</p></div>';
    return elo + studyCard(H) + tr + fin;
  }

  /* ------------------------------------------------------------ the study: models against the closing line */
  var SERIES = [{ k: 'close', name: 'Closing line', cls: 'sm-cal-close', dash: '5 3', mark: 'circle' }, { k: 'old', name: '1.1.0', cls: 'sm-cal-old', dash: '', mark: 'square' }, { k: 'new', name: 'Served model', cls: 'sm-cal-new', dash: '', mark: 'diamond' }];
  /** favourite-side reliability: said (x) against won (y), the diagonal for perfect calibration; every point carries its numbers on hover */
  function calibrationSvg(C, newName) {
    var W = 340, Hh = 250, L = 40, R = 86, T = 10, B = 34, lo = 0.45, hi = 1.0;
    var X = function (v) { return L + (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * (W - L - R); };
    var Y = function (v) { return Hh - B - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * (Hh - T - B); };
    var h = '<svg class="sm-cal" viewBox="0 0 ' + W + ' ' + Hh + '" role="img" aria-label="Calibration: the favourite’s stated chance against how often favourites won, for the closing line, 1.1.0 and the ' + esc(newName) + '">';
    [0.5, 0.6, 0.7, 0.8, 0.9, 1.0].forEach(function (v) {
      h += '<line class="sm-cal-grid" x1="' + X(lo) + '" x2="' + X(hi) + '" y1="' + Y(v) + '" y2="' + Y(v) + '"/><text class="sm-cal-ax" x="' + (L - 6) + '" y="' + (Y(v) + 3) + '" text-anchor="end">' + Math.round(v * 100) + '%</text>'
        + '<text class="sm-cal-ax" x="' + X(v) + '" y="' + (Hh - B + 14) + '" text-anchor="middle">' + Math.round(v * 100) + '%</text>';
    });
    h += '<line class="sm-cal-diag" x1="' + X(lo) + '" y1="' + Y(lo) + '" x2="' + X(hi) + '" y2="' + Y(hi) + '"/>'
      + '<text class="sm-cal-ax" x="' + ((L + W - R) / 2) + '" y="' + (Hh - 4) + '" text-anchor="middle">the favourite’s stated chance</text>'
      + '<text class="sm-cal-ax" transform="rotate(-90)" x="' + (-(T + Hh - B) / 2) + '" y="11" text-anchor="middle">favourites won</text>';
    var ends = [];
    SERIES.forEach(function (s) {
      var pts = (C[s.k] || []).filter(function (r) { return isNum(r.said) && isNum(r.won) && r.n >= 10; });
      if (!pts.length) return;
      h += '<polyline class="sm-cal-line ' + s.cls + '"' + (s.dash ? ' stroke-dasharray="' + s.dash + '"' : '') + ' points="' + pts.map(function (r) { return X(r.said).toFixed(1) + ',' + Y(r.won).toFixed(1); }).join(' ') + '"/>';
      pts.forEach(function (r) {
        var x = X(r.said), y = Y(r.won), tip = s.name + ' · favourites at ' + r.bin + ': said ' + pct(r.said) + ', won ' + pct(r.won) + ' (' + U.int(r.n) + ' bouts)';
        var mk = s.mark === 'square' ? '<rect class="sm-cal-pt ' + s.cls + '" x="' + (x - 4) + '" y="' + (y - 4) + '" width="8" height="8" rx="1"/>'
          : s.mark === 'diamond' ? '<path class="sm-cal-pt ' + s.cls + '" d="M' + x + ' ' + (y - 5) + 'L' + (x + 5) + ' ' + y + 'L' + x + ' ' + (y + 5) + 'L' + (x - 5) + ' ' + y + 'Z"/>'
            : '<circle class="sm-cal-pt ' + s.cls + '" cx="' + x + '" cy="' + y + '" r="4"/>';
        h += '<g class="sm-cal-hit">' + mk + '<circle cx="' + x + '" cy="' + y + '" r="10" fill="transparent"><title>' + esc(tip) + '</title></circle></g>';
      });
      var last = pts[pts.length - 1];
      ends.push({ y: Y(last.won), s: s });
    });
    /* direct labels at the right edge, spaced so they never overlap */
    ends.sort(function (a, b) { return a.y - b.y; });
    for (var i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 12) ends[i].y = ends[i - 1].y + 12;
    ends.forEach(function (e) { h += '<text class="sm-cal-lab ' + e.s.cls + '-ink" x="' + (W - R + 8) + '" y="' + (e.y + 4) + '">' + esc(e.s.k === 'new' ? newName : e.s.name) + '</text>'; });
    return h + '</svg>';
  }
  function calTable(C, newName) {
    var bins = {};
    SERIES.forEach(function (s) { (C[s.k] || []).forEach(function (r) { (bins[r.bin] = bins[r.bin] || {})[s.k] = r; }); });
    var cellOf = function (r) { return r ? pct(r.said) + ' / ' + pct(r.won) + ' (' + U.int(r.n) + ')' : '—'; };
    return '<details class="sm-lim"><summary>The calibration numbers (said / won, bouts)</summary><div class="sm-scroll"><table class="sm-tbl"><thead><tr><th>Favourite at</th><th>Closing line</th><th>1.1.0</th><th>' + esc(newName) + '</th></tr></thead><tbody>'
      + Object.keys(bins).sort().map(function (k) { var x = bins[k]; return '<tr><td>' + esc(k) + '</td><td class="sm-num">' + esc(cellOf(x.close)) + '</td><td class="sm-num">' + esc(cellOf(x.old)) + '</td><td class="sm-num">' + esc(cellOf(x.new)) + '</td></tr>'; }).join('')
      + '</tbody></table></div></details>';
  }
  function studyCard(H) {
    var St = H.study, E = H.elo || {}, GA = H.guard || {};
    if (!St) return '<div class="sm-card"><div class="sm-h">Against the closing line</div><p class="sm-small sm-dim">No comparison with closing prices is on file for this run.</p></div>';
    var f3 = function (x) { return isNum(x) ? x.toFixed(3) : '—'; };
    var served = E.version || 'served';
    var newName = St.base_version === served ? 'Selected (not served)' : served;
    var rows = (St.windows || []).map(function (w) {
      return '<tr><td>' + esc(w.label) + '</td><td class="sm-num">' + esc(U.int(w.n)) + '</td><td class="sm-num">' + esc(f3(w.old.log_loss)) + '</td><td class="sm-num">' + esc(f3(w.new.log_loss)) + '</td><td class="sm-num">' + esc(f3(w.old.brier)) + '</td><td class="sm-num">' + esc(f3(w.new.brier)) + '</td>'
        + '<td class="sm-num">' + esc(U.int(w.close_n)) + '</td><td class="sm-num">' + esc(f3(w.close_old.log_loss)) + '</td><td class="sm-num">' + esc(f3(w.close_new.log_loss)) + '</td><td class="sm-num">' + esc(f3(w.close.log_loss)) + '</td><td class="sm-num">' + esc(f3(w.close.brier)) + '</td></tr>';
    }).join('');
    var T = St.test || {};
    var ci4 = T.ci95 ? T.ci95.map(function (x) { return x.toFixed(4); }).join(' to ') : '—';
    var later = (St.lineage || []).filter(function (x) { return x.choice_read_test; }).map(function (x) { return x.version; });
    var head = '<p class="sm-small">' + esc(!St.promoted
      ? 'The selected model did not clear the promotion rule against 1.1.0 (' + (St.reasons || []).join('; ') + '), so 1.1.0 stays served.'
      : St.test_untouched === false
        ? 'The served model (' + served + ') beats 1.1.0 on ' + U.int(T.n) + ' bouts from 2024 on: log loss ' + f3(T.old_log_loss) + ' to ' + f3(T.new_log_loss) + ' (95% interval of the change ' + ci4 + '), Brier ' + signed(T.delta_brier, 4) + '. 2024 on is no longer untouched: ' + later.join(', ') + ' was adopted by the weekly rule, which reads every bout since 2016; its own out-of-sample record is below.'
        : 'The served model (' + served + ') replaced 1.1.0 because it beat it out of sample: on ' + U.int(T.n) + ' bouts from 2024 on, which no choice was made on, log loss fell from ' + f3(T.old_log_loss) + ' to ' + f3(T.new_log_loss) + ' (95% interval of the change ' + ci4 + ') and the Brier score by ' + Math.abs(T.delta_brier || 0).toFixed(4) + '.') + '</p>'
      + '<p class="sm-small">' + esc('Both still trail the closing line by a wide margin. The closing line here is ' + (St.reference.name || 'a public archive') + ': ' + (St.reference.kind || '') + ', matched to ' + U.int(St.reference.matched) + ' bouts (' + (St.reference.span || []).join(' to ') + ').' + (St.reference.timestamped ? '' : ' It is untimestamped (' + (H.market || 'no timestamped closing archive is on file') + '), so it can grade the model but never certify an edge.')) + '</p>';
    var tbl = '<div class="sm-scroll"><table class="sm-tbl"><thead><tr><th>Bouts</th><th>N</th><th title="Lower is better; a coin scores 0.693">1.1.0 log loss</th><th>' + esc(newName) + ' log loss</th><th>1.1.0 Brier</th><th>' + esc(newName) + ' Brier</th><th title="Bouts with a closing line">With a close</th><th>1.1.0</th><th>' + esc(newName) + '</th><th>Closing line</th><th>Close Brier</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    var legend = '<div class="sm-cal-legend sm-small">' + SERIES.map(function (s) { return '<span><i class="' + s.cls + (s.dash ? ' dash' : '') + '"></i>' + esc(s.k === 'new' ? newName : s.name) + '</span>'; }).join('') + '<span><i class="sm-cal-diag-key"></i>perfect calibration</span></div>';
    var chart = '<div class="sm-h" style="margin-top:12px">Calibration since 2018 (bouts with a closing line)</div>' + legend + calibrationSvg(St.calibration || {}, newName) + calTable(St.calibration || {}, newName)
      + '<div class="sm-foot">Each point is a group of bouts by the favourite’s stated chance; on the diagonal, favourites won exactly as often as stated. The closing line reaches further out (it names 80-90% favourites the models rarely do) and stays on the line.</div>';
    var gr = function (rows) {
      return (rows || []).map(function (r) { return '<tr><td>' + esc(r.gap_pp) + ' pts</td><td class="sm-num">' + esc(U.int(r.n)) + '</td><td class="sm-num">' + esc(U.int(r.model_favour)) + '</td><td class="sm-num">' + esc(U.int(r.market_favour)) + '</td><td class="sm-num">' + esc(f3(r.model_log_loss)) + '</td><td class="sm-num">' + esc(f3(r.close_log_loss)) + '</td></tr>'; }).join('');
    };
    var G = St.gaps || {}, ot = G.over_threshold_new || {};
    var gaps = '<div class="sm-h" style="margin-top:12px">When the ' + esc(newName) + ' and the close disagree (2021 on)</div><div class="sm-scroll"><table class="sm-tbl"><thead><tr><th>Gap</th><th>Bouts</th><th title="The result landed on the model’s side of the close">Model’s favour</th><th>Market’s favour</th><th>Model log loss</th><th>Close log loss</th></tr></thead><tbody>' + gr(G.new) + '</tbody></table></div>'
      + '<p class="sm-small">' + esc('Over ' + GA.threshold_pp + ' points: ' + U.int(ot.n) + ' bouts, ' + U.int(ot.model_favour) + ' resolved in the model’s favour and ' + U.int(ot.market_favour) + ' in the market’s. ' + (GA.certified ? 'Certified: gaps that size beat the close.' : 'Not certified as a signal: ' + (GA.certification_reasons || []).join('; ') + '.')) + '</p>';
    var steps = (St.steps || []).map(function (x) {
      return '<tr><td>' + esc(x.label) + '</td><td class="sm-num">' + esc(signed(x.select_delta, 4)) + '</td><td class="sm-dec ' + (x.decision === 'KEPT' ? 'sm-dec-promote' : 'sm-dec-retain') + '">' + esc(x.decision === 'KEPT' ? 'kept' : x.decision === 'NOT TESTED' ? 'not tested' : 'dropped') + '</td></tr>';
    }).join('');
    var stepT = steps ? '<details class="sm-lim"><summary>What was tried, one change at a time (kept only if it lowered 2021-2023 log loss by 0.0005 or more)</summary><div class="sm-scroll"><table class="sm-tbl"><thead><tr><th>Change</th><th title="2021-2023 log loss, against the model before the change; negative is better">Δ log loss</th><th>Decision</th></tr></thead><tbody>' + steps + '</tbody></table></div></details>' : '';
    return '<div class="sm-card"><div class="sm-h">Against the closing line ' + badge('Observed') + '</div>' + head + tbl + chart + gaps + stepT + ageBlock(St.age) + '</div>';
  }
  /* the age study: where each division's decline starts, and whether a curve by division held out of sample */
  function ageBlock(A) {
    if (!A) return '';
    var ad = A.adopted, cand = {};
    (A.candidates || []).forEach(function (c) { cand[c.key] = c; });
    var newName = ad ? ad.version : 'by division';
    var said = function (o, k) { return o ? pct(o[k]) : '—'; };
    var divRows = (A.divisions || []).map(function (d) {
      return '<tr><td>' + esc(d.division) + '</td><td class="sm-num">' + esc(U.int(d.fit_bouts)) + '</td><td class="sm-num">' + esc(d.knee == null ? 'shared (32)' : String(d.knee)) + '</td><td class="sm-num">' + esc(d.slope == null ? 'shared (−15)' : signed(d.slope, 0)) + '</td>'
        + '<td class="sm-num">' + esc(said(d.older, 'base_said')) + '</td><td class="sm-num">' + esc(said(d.older, 'new_said')) + '</td><td class="sm-num">' + esc(d.older ? pct(d.older.won) + ' (' + U.int(d.older.n) + ')' : '—') + '</td></tr>';
    }).join('');
    var cRows = (A.candidates || []).map(function (c) {
      var o = c.oos || {};
      var yrs = Object.keys(o.by_season || {}).map(function (y) { return y + ' ' + signed(o.by_season[y], 4); }).join(', ');
      return '<tr><td>' + esc(c.key.replace(/_/g, ' ')) + (ad && ad.candidate === c.key ? ' (' + esc(ad.version) + ')' : '') + '</td><td class="sm-num">' + esc(signed(c.select_delta, 4)) + '</td><td class="sm-num">' + esc(signed(o.delta_log_loss, 4)) + '</td><td class="sm-num">' + esc(o.ci95 ? o.ci95.map(function (x) { return signed(x, 4); }).join(' to ') : '—') + '</td><td class="sm-small">' + esc(yrs) + '</td></tr>';
    }).join('');
    var a = ad && cand[ad.candidate] && cand[ad.candidate].oos;
    var lead = ad && a
      ? 'Each division with enough bouts got its own age curve, fitted on 2016-2020 alone. ' + ad.version + ' carries it: the weekly rule passed it over every bout since 2016. Out of sample (2021 on, ' + U.int(a.n) + ' bouts) it lowers log loss by ' + Math.abs(a.delta_log_loss).toFixed(4) + ' (95% interval ' + (a.ci95 ? a.ci95.map(function (x) { return signed(x, 4); }).join(' to ') : '—') + '): better, not proven. 2021-2023 alone got worse, so the study’s stricter rule dropped it. The weekly loop retests it, and the shared curve, every week.'
      : 'No age curve by division is served: none cleared the rules.';
    return '<details class="sm-lim"><summary>Age by division (where the decline starts, fitted per division)</summary><p class="sm-small">' + esc(lead) + '</p>'
      + '<div class="sm-scroll"><table class="sm-tbl"><thead><tr><th>Division</th><th title="2016-2020 bouts with both ages">Fit bouts</th><th>Decline from (age)</th><th>Elo a year</th><th title="The older fighter (33+, 3+ years older), every bout since 2016">' + esc(A.base_version) + ' said</th><th>' + esc(newName) + ' said</th><th>Won</th></tr></thead><tbody>' + divRows + '</tbody></table></div>'
      + '<div class="sm-scroll"><table class="sm-tbl"><thead><tr><th>Candidate</th><th title="2021-2023, the study’s keep window">Δ 2021-23</th><th title="Fitted on 2016-2020, so 2021 on is out of sample">Δ 2021 on</th><th>95% interval</th><th>By season</th></tr></thead><tbody>' + cRows + '</tbody></table></div></details>';
  }

  /* ------------------------------------------------------------ the adapter */
  var adapter = {
    defaultTab: 'fights',
    tabLabels: { fights: 'Fights', title_path: 'Title Path', model_health: 'Model Health' },
    load: async function (get, c) {
      var x = await U.loadPublished(get, 'ufc', U.seasonOf('ufc'));
      c.status = x.status; c.entitled = x.entitled;
      if (x.run) { c.run = x.run; c.results = x.results; c.entities = x.entities; c.edges = x.edges; }
    },
    paint: function (ctx) {
      var c = ctx.cache || {}, s = ctx.sport, now = ctx.nowMs || Date.now();
      var gate = U.gateHtml(s, c, now); if (gate) return gate;
      var st = U.deriveState({ sport: s, status: c.status, entitled: c.entitled, run: c.run, loadError: c.error, nowMs: now });
      var v = ctx.tab === 'title_path' ? renderTitlePath(c) : ctx.tab === 'model_health' ? renderHealth(c) : renderFights(c);
      return U.renderMeta(s, c.run, st, now).replace('simulated seasons', 'simulated runs') + v;
    }
  };
  return { adapter: adapter, renderFights: renderFights, renderTitlePath: renderTitlePath, renderHealth: renderHealth, american: american, decimal: decimal, share: share };
});
