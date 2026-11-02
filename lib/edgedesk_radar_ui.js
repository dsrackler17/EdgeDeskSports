/* ===========================================================================
   EdgeDesk PREDICTION RADAR — what a reader sees. EXPERIMENTAL.
   docs/prediction-radar.md

   Renders only. It fetches nothing and decides no access: every number comes
   from a database door (supabase/radar.sql) that already decided who may see
   it, and this module draws what it was given.
     the terminal (app.html, the Overview)  Smart Money Tonight, the trader page
                                            (window.radarData reads, as the reader)
     /radar/ (public, no login)             the leaderboard, the trader pages,
                                            a teaser of the first card
   Both show the Known limitations.

   THE RULES IT DRAWS BY
     - a card leads with one plain sentence ("7 top bettors, $84K, on Chiefs
       -3"), the numbers underneath
     - Experimental and Small sample are TEXT chips, never colour alone
     - the Radar Score is never shown without its components
     - a number the pipeline does not own is not drawn: no fair, no line;
       no price, no movement
     - no "bet now", no "copy trade", no affiliate link, no promise
       (tools/radar/radar_ui.test.js fails on any of them)

   Browser: window.EDRadarUI. Node: require('./edgedesk_radar_ui.js').
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EDRadarUI = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var U = { VERSION: 'edgedesk_radar_ui/1' };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  U.esc = esc;

  /* ------------------------------------------------------------ formats */
  /* dollars: $640, $8.4K, $84K, $1.2M */
  U.money = function (x) {
    x = num(x); if (x == null) return '—';
    var a = Math.abs(x), s = x < 0 ? '−$' : '$';
    if (a >= 1e6) return s + trim((a / 1e6).toFixed(a >= 1e7 ? 0 : 1)) + 'M';
    if (a >= 1e3) return s + trim((a / 1e3).toFixed(a >= 1e4 ? 0 : 1)) + 'K';
    return s + Math.round(a);
  };
  function trim(t) { return t.replace(/\.0$/, ''); }
  /* a Polymarket price is cents on the dollar */
  U.cents = function (p) { p = num(p); return p == null ? '—' : Math.round(p * 100) + '¢'; };
  U.pct = function (x, digits) { x = num(x); if (x == null) return '—'; var v = (x * 100).toFixed(digits == null ? 1 : digits); return (x > 0 ? '+' : x < 0 ? '−' : '') + v.replace('-', '') + '%'; };
  /* a rate is a share, never signed: "51.2%" */
  U.rate = function (x, digits) { x = num(x); return x == null ? '—' : (x * 100).toFixed(digits == null ? 1 : digits) + '%'; };
  U.pp = function (x) { x = num(x); if (x == null) return '—'; return (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(1) + ' pts'; };
  U.signed = function (pt) { pt = num(pt); if (pt == null) return ''; return (pt > 0 ? '+' : pt < 0 ? '-' : '') + trim(String(Math.abs(pt))); };
  var ETF = null;
  try { ETF = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' }); } catch (_) { ETF = null; }
  var EDF = null;
  try { EDF = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' }); } catch (_) { EDF = null; }
  U.when = function (t) { var x = Date.parse(t); return isFinite(x) ? (ETF ? ETF.format(new Date(x)) + ' ET' : new Date(x).toISOString().slice(0, 16).replace('T', ' ') + ' UTC') : ''; };
  U.day = function (t) { var x = Date.parse(t); return isFinite(x) ? (EDF ? EDF.format(new Date(x)) : new Date(x).toISOString().slice(0, 10)) : ''; };
  /* the name a page may show is the database's (radar_display): a public name or a shortened address */
  U.walletLabel = function (w) { return w && w.display ? w.display : (w && w.wallet ? w.wallet.slice(0, 6) + '…' + w.wallet.slice(-4) : 'unknown'); };
  U.polygonscan = function (tx) { return /^0x[0-9a-f]{64}$/.test(String(tx || '')) ? 'https://polygonscan.com/tx/' + tx : null; };

  /* the side, as a reader would say it: "Chiefs", "Chiefs -3", "Over 47.5" */
  function nick(c) {
    var o = String(c.outcome || '').trim(), s = String(c.selection || '').trim();
    if (o && !/^(yes|no)$/i.test(o)) return o;
    return s ? s.split(' ').slice(-1)[0] : 'this side';
  }
  U.sideLabel = function (c) {
    if (!c) return '';
    if (c.market_type === 'totals') return (String(c.selection || c.outcome || '').toLowerCase() === 'under' ? 'Under' : 'Over') + (num(c.point) != null ? ' ' + trim(String(num(c.point))) : '');
    if (c.market_type === 'spreads' && num(c.point) != null) return nick(c) + ' ' + U.signed(c.point);
    return nick(c);
  };
  /* THE SENTENCE every card leads with */
  U.sentence = function (c, noun) {
    var n = num(c && c.n_wallets) || 0;
    noun = noun || 'top bettor';
    return n + ' ' + noun + (n === 1 ? '' : 's') + ', ' + U.money(c && c.dollars) + ', on ' + U.sideLabel(c);
  };
  /* H-RADAR-02's door says which hypothesis is live; its cards come from the featured bettors */
  function v2(r) { return !!(r && r.hypothesis === 'H-RADAR-02'); }
  U.gameLabel = function (c) {
    if (!c || !c.home_team || !c.away_team) return '';
    return c.away_team + ' at ' + c.home_team + (c.commence_time ? ' · ' + U.when(c.commence_time) : '');
  };
  /* EdgeDesk's fair against the price, in one plain line, or why there is none */
  U.agreeLine = function (c) {
    if (c.agrees === true) return 'Smart money agrees with the sharp fair price';
    if (c.agrees === false) return 'Smart money disagrees with the sharp fair price';
    if (num(c.fair) != null && c.fair_current === false) return 'EdgeDesk’s fair price for this side is more than 90 minutes old, so there is no comparison';
    if (num(c.fair) != null && num(c.current_price) == null) return 'No current Polymarket price to compare with EdgeDesk’s fair price';
    return 'EdgeDesk has no fair price at this line, so there is no comparison';
  };
  U.movedLine = function (c) {
    var p = num(c.current_price), m = num(c.moved);
    if (p == null) return 'No current Polymarket price';
    if (m == null) return 'Now ' + U.cents(p) + ' on Polymarket';
    if (c.has_moved !== true) return 'Now ' + U.cents(p) + ' on Polymarket, about where they entered';
    return 'Now ' + U.cents(p) + ' on Polymarket, ' + (m > 0 ? 'up ' : 'down ') + Math.round(Math.abs(m) * 100) + '¢ since they entered';
  };
  function chip(text, cls) { return '<span class="rd-chip' + (cls ? ' ' + cls : '') + '">' + esc(text) + '</span>'; }
  U.experimentalChip = function () { return chip('Experimental', 'exp'); };

  /* ------------------------------------------------------------ one card */
  U.cardHTML = function (c, o) {
    o = o || {};
    var hi = num(c.high_conviction) || 0, other = num(c.other_side_wallets) || 0;
    var ws = (c.wallets || []).map(function (w) {
      return '<li><button type="button" class="rd-w" data-radar-wallet="' + esc(w.wallet) + '">' + esc(U.walletLabel(w)) + '</button>'
        + '<span class="rd-wn">#' + esc(w.rank) + ' · ' + esc(U.money(w.cost)) + (num(w.avg_price) != null ? ' at ' + esc(U.cents(w.avg_price)) : '') + '</span>'
        + (w.high_conviction ? chip(trim(String(num(w.conviction))) + '× usual size', 'conv') : '') + '</li>';
    }).join('');
    return '<article class="rd-card" data-radar-event="' + esc(c.event_id) + '">'
      + '<div class="rd-meta">' + esc(U.gameLabel(c)) + '</div>'
      + '<h3 class="rd-sent">' + esc(U.sentence(c, o.noun)) + '</h3>'
      + '<dl class="rd-nums">'
      + '<div><dt>Their average entry</dt><dd>' + esc(U.cents(c.avg_entry)) + '</dd></div>'
      + '<div><dt>Polymarket now</dt><dd>' + esc(U.cents(c.current_price)) + '</dd></div>'
      + '<div><dt>EdgeDesk fair</dt><dd>' + esc(num(c.fair) != null ? U.cents(c.fair) : '—') + '</dd></div>'
      + '</dl>'
      + '<p class="rd-line">' + esc(U.movedLine(c)) + '.</p>'
      + '<p class="rd-line rd-agree">' + esc(U.agreeLine(c)) + '.</p>'
      + (hi ? '<p class="rd-line">' + chip('High conviction') + ' ' + esc(hi + ' of them ' + (hi === 1 ? 'is' : 'are') + ' at ' + (o.conviction_x || 3) + '× or more their usual size.') + '</p>' : '')
      + (other ? '<p class="rd-line rd-dim">' + esc(other + ' ' + (o.noun || 'top bettor') + (other === 1 ? '' : 's') + ' on the other side (' + U.money(c.other_side_dollars) + ').') + '</p>' : '')
      + (ws ? '<ul class="rd-ws" aria-label="The ' + esc((o.noun || 'top bettor') + 's') + ' on this side">' + ws + '</ul>' : '')
      + '</article>';
  };

  /* ------------------------------------------------------------ one card, v2 (the shared comparison)
     o: { noun, conviction_x, events (the slate), zone, now, sourceTimes }. Every number comes
     from EDResearchCompare.fromRadarCard, the same path the Research Queue compares through. */
  function RCm() { try { return (typeof self !== 'undefined' && self.EDResearchCompare) || (typeof require === 'function' ? require('./edgedesk_research_compare.js') : null); } catch (_) { return null; } }
  function Gm() { try { return (typeof self !== 'undefined' && self.EDGames) || (typeof require === 'function' ? require('./edgedesk_games.js') : null); } catch (_) { return null; } }
  /* a time in the reader's zone, named (the slate's own formatter); ET only when there is no zone */
  U.whenIn = function (t, zone, now) {
    var g = Gm(), x = Date.parse(t);
    if (!isFinite(x)) return '';
    if (!g || !zone) return U.when(t);
    var dk = g.dateKey(x, zone), td = g.today(now == null ? Date.now() : now, zone);
    return (dk === td ? 'Today' : g.relDay(dk, td)) + ' · ' + g.timeText(x, zone);
  };
  U.agoText = function (t, now) { var g = Gm(); return g ? (g.ageText(t, now) || 'time unknown') : ''; };
  U.cardV2HTML = function (c, o) {
    o = o || {};
    var rc = RCm(), now = o.now == null ? Date.now() : o.now;
    if (!rc) return U.cardHTML(c, o);
    var R = rc.fromRadarCard(c, { events: o.events || [], now: now, sourceTimes: o.sourceTimes || null });
    var cmp = R.comparison, W = R.wallets, Q = R.quote, M = R.model, F = M && M.freshness, noun = o.noun || 'top bettor';
    var st = rc.STATUS[cmp.status] || {};
    var game = c.away_team && c.home_team ? c.away_team + ' at ' + c.home_team : '';
    var when = c.commence_time ? U.whenIn(c.commence_time, o.zone, now) : '';
    /* 1 the model */
    var modelV = M && M.prob != null ? rc.centsText(M.prob) : '—';
    var modelS = M && M.prob != null ? (M.label || 'EdgeDesk model') + (F && F.generated_at ? ', built ' + U.agoText(F.generated_at, now) : ', build time not recorded')
      : 'Comparable model unavailable';
    /* 2 the market */
    var mkV = Q ? rc.centsText(Q.price) : '—';
    var mkS = !Q ? 'No current Polymarket price'
      : Q.kind === 'executable_ask' ? 'Best ask' + (Q.size != null ? ', ' + Math.floor(Q.size) + ' shares at it' : ', size not recorded') + ' · ' + U.agoText(Q.observed_at, now)
        : 'Displayed price, not an ask · read ' + U.agoText(Q.ingested_at, now);
    /* 3 what the wallets hold */
    var hold = U.money(W.cost_basis) + ' cost basis';
    var interp = cmp.active ? rc.sentence(cmp) : st.label + '.';
    var tone = st.tone || 'mute';
    var startedNote = R.started ? '<p class="rd-line rd-dim">The game has started: these are pregame numbers, kept as history.</p>' : '';
    /* the detail, behind one disclosure */
    var d = [];
    d.push('<li><b>Holdings.</b> ' + esc((W.n == null ? '—' : W.n) + ' ' + noun + (W.n === 1 ? '' : 's') + ' held this side in Polymarket’s top-100 holder list read ' + (W.holders_at ? U.agoText(W.holders_at, now) + ' (' + U.whenIn(W.holders_at, o.zone, now) + ')' : 'at an unrecorded time')
      + '. ' + U.money(W.cost_basis) + ' is their cost basis (shares × average price paid), not the positions’ value now. Holdings can change between reads; wallets may not be independent people.') + '</li>');
    d.push('<li><b>Average entry ' + esc(rc.centsText(W.avg_entry)) + '.</b> ' + esc('What they paid on average, historically; it is not a price available now' + (R.movement ? '. ' + R.movement.text + ' to the price shown.' : '.')) + '</li>');
    if (W.other_n) d.push('<li>' + esc(W.other_n + ' ' + noun + (W.other_n === 1 ? '' : 's') + ' on the other side (' + U.money(W.other_cost_basis) + ' cost basis).') + '</li>');
    if (M && M.prob != null) d.push('<li><b>Model.</b> ' + esc((M.label || 'EdgeDesk model') + ' (' + (M.source || 'source not stated') + ')' + (F && F.generated_at ? ', built ' + U.whenIn(F.generated_at, o.zone, now) : '') + (F && F.max_age_min ? '; counted current for ' + Math.round(F.max_age_min / 60) + ' h' : '')
      + (F && F.inputs && F.inputs.note ? '; ' + F.inputs.note : '') + (M.tier ? '; validation: ' + String(M.tier).replace(/_/g, ' ').toLowerCase() : '') + (M.validation === 'NOT_TESTED' ? '; never tested against closing prices' : '') + '.') + '</li>');
    else d.push('<li><b>Model.</b> ' + esc('Comparable model unavailable: ' + (cmp.status === 'MODEL_UNAVAILABLE' ? cmp.reason : (M && M.reason ? M.reason.replace(/^Comparable model unavailable: /, '') : 'none'))) + '</li>');
    if (Q) d.push('<li><b>Price.</b> ' + esc(Q.kind === 'executable_ask' ? 'Polymarket best ask ' + rc.centsText(Q.price) + (Q.size != null ? ', ' + Math.floor(Q.size) + ' shares' : ', depth not recorded') + ', quoted ' + U.whenIn(Q.observed_at, o.zone, now) + (Q.fee_per_share != null ? '; taker fee ' + rc.centsText(Q.fee_per_share) + ' a share' : '; fee not recorded')
      : 'Polymarket’s displayed price (an outcome price or midpoint), read by EdgeDesk ' + U.whenIn(Q.ingested_at, o.zone, now) + '. It is not an order-book ask: buying would cost more, and the depth is unknown.') + '</li>');
    var PA = R.past_ask;
    if (PA) d.push('<li><b>Best ask at publication.</b> ' + esc(rc.centsText(PA.price) + (PA.size != null ? ', ' + Math.floor(PA.size) + ' shares' : ', depth not recorded') + ', quoted ' + U.whenIn(PA.observed_at, o.zone, now)
      + (PA.fee_per_share != null ? '; taker fee ' + rc.centsText(PA.fee_per_share) + ' a share' : '; fee not recorded') + '. ' + (PA.freshness && PA.freshness.max_age_min ? 'Past its ' + PA.freshness.max_age_min + '-minute limit' : 'Its quote time is not recorded') + ', so it is not compared and no EV is drawn from it.') + '</li>');
    if (cmp.ev && cmp.ev.value != null) d.push('<li><b>Estimated EV ' + esc(rc.pctText(cmp.ev.value)) + '</b> ' + esc('per $1, ' + cmp.ev.basis + '.') + '</li>');
    else if (cmp.active && cmp.ev) d.push('<li>' + esc('No EV is shown: ' + cmp.ev.reason + '.') + '</li>');
    if (R.reference) d.push('<li><b>Sharp reference.</b> ' + esc(R.reference.label + ' ' + rc.centsText(R.reference.price) + (R.reference.state === 'fresh' ? ', seen ' + U.agoText(R.reference.seen_at, now) : ', ' + (R.reference.age_min == null ? 'time not recorded' : 'last seen ' + U.agoText(R.reference.seen_at, now)) + ': past its ' + R.reference.max_age_min + '-minute limit, so it is not compared')
      + '. A market reference, not EdgeDesk’s model.') + '</li>');
    d.push('<li>' + esc('Wallets and the model favouring the same side is not extra evidence, and the dollars are not a measure of skill.') + '</li>');
    d.push('<li class="rd-calc">' + esc(cmp.calc + (cmp.reason && !cmp.active ? ' · ' + cmp.reason : '')) + '</li>');
    var ws = (c.wallets || []).map(function (w) {
      return '<li><button type="button" class="rd-w" data-radar-wallet="' + esc(w.wallet) + '">' + esc(U.walletLabel(w)) + '</button>'
        + '<span class="rd-wn">#' + esc(w.rank) + ' · ' + esc(U.money(w.cost)) + (num(w.avg_price) != null ? ' at ' + esc(rc.centsText(w.avg_price)) : '') + '</span>'
        + (w.high_conviction ? chip(trim(String(num(w.conviction))) + '× usual size', 'conv') : '') + '</li>';
    }).join('');
    var research = o.researchHref ? o.researchHref(R.slate_event) : null;
    return '<article class="rd-card v2" data-radar-event="' + esc(c.event_id) + '">'
      + '<div class="rd-meta"><b>' + esc(game) + '</b>' + (when ? ' · ' + esc(when) : '') + '</div>'
      + '<h3 class="rd-sent">' + esc(U.sentence(c, o.noun)) + '</h3>'
      + '<p class="rd-hold">' + esc(hold) + ' · held at last read ' + esc(W.holders_at ? U.agoText(W.holders_at, now) : '(time unknown)') + ' · avg entry ' + esc(rc.centsText(W.avg_entry)) + ' (historical)</p>'
      + '<dl class="rd-nums">'
      + '<div><dt>Model fair</dt><dd>' + esc(modelV) + '</dd><small>' + esc(modelS) + '</small></div>'
      + '<div><dt>Polymarket</dt><dd>' + esc(mkV) + '</dd><small>' + esc(mkS) + '</small></div>'
      + '</dl>'
      + '<p class="rd-status ' + esc(tone) + '" role="note"><span class="rd-st-k">' + esc(st.label || cmp.status) + '</span> ' + (cmp.active ? esc(interp) : esc(cmp.reason ? cmp.reason.charAt(0).toUpperCase() + cmp.reason.slice(1) + '.' : '')) + '</p>'
      + startedNote
      + (num(c.high_conviction) ? '<p class="rd-line">' + chip('High conviction') + ' ' + esc(c.high_conviction + ' of them ' + (c.high_conviction === 1 ? 'is' : 'are') + ' at ' + (o.conviction_x || 3) + '× or more their usual size.') + '</p>' : '')
      + '<details class="rd-det"><summary>Details and sources</summary><ul class="rd-dl">' + d.join('') + '</ul>'
      + (ws ? '<ul class="rd-ws" aria-label="The ' + esc(noun + 's') + ' on this side">' + ws + '</ul>' : '') + '</details>'
      + (research ? '<a class="rd-act" href="' + esc(research) + '" data-ov-radar-open="' + esc(R.slate_event) + '">Open game research</a>' : '')
      + '</article>';
  };
  U.diagnostics = function (r, o) {
    var rc = RCm(); if (!rc || !r || !r.cards) return null;
    return rc.diagnostics(r.cards.map(function (c) { return rc.fromRadarCard(c, o || {}).comparison; }));
  };

  /* ------------------------------------------------------------ Smart Money Tonight */
  /* how many qualify today (H-RADAR-02): at most top_wallets, fewer when fewer clear the bar, and the page says so */
  U.featuredLine = function (r) {
    var n = num(r && r.featured), max = num(r && r.top_wallets) || 10;
    if (n == null) return '';
    if (n === 0) return 'No bettor qualifies to be featured yet: none has a positive Radar Score at a follower’s price.';
    return n + ' bettor' + (n === 1 ? ' qualifies' : 's qualify') + ' to be featured today' + (n < max ? ' (at most ' + max + '; fewer qualify when fewer clear the bar)' : ' (the most Radar features)') + '.';
  };
  /* how discovery stands: screened, evaluated, and the wallets set apart, with why */
  U.discoveryLine = function (d) {
    if (!d || num(d.screened) == null) return '';
    var parts = [];
    if (num(d.fully_evaluated)) parts.push(d.fully_evaluated + ' fully evaluated');
    if (num(d.high_frequency)) parts.push(d.high_frequency + ' high-frequency (not followable)');
    if (num(d.insufficient_history)) parts.push(d.insufficient_history + ' with too much history to read in full (ungraded)');
    return 'Radar has screened ' + d.screened + ' wallet' + (d.screened === 1 ? '' : 's') + ' from Polymarket’s 30-day sports board' + (parts.length ? ': ' + parts.join(', ') : '') + '.';
  };
  /* OBSERVED ACTIVITY: what the other evaluated bettors hold, counted. Never a signal, never a name */
  U.observedHTML = function (list, o) {
    var none = !(list || []).length;
    if (none && !(o && o.empty)) return '';
    var items = none ? '' : list.map(function (o) {
      var sides = (o.sides || []).map(function (x) {
        return esc(U.sideLabel({ market_type: o.market_type, outcome: x.outcome, selection: x.selection, point: x.point })) + ' ' + esc(x.n_wallets) + ' (' + esc(U.money(x.dollars)) + ')';
      }).join(' · ');
      return '<li><span class="rd-meta">' + esc(U.gameLabel(o)) + '</span> ' + esc((num(o.n_wallets) || 0) + ' evaluated bettor' + (o.n_wallets === 1 ? '' : 's') + ': ') + sides + '</li>';
    }).join('');
    return '<div class="rd-obs" aria-labelledby="rdObsH"><div class="rd-head"><h3 class="rd-h3" id="rdObsH">Observed activity</h3>' + chip('Observed, not a signal') + '</div>'
      + '<p class="rd-sub">What other bettors Radar has fully evaluated hold on tonight’s games. None of them is featured: their grades did not clear the bar, or their samples are small. This is what they hold, not evidence and not a pick. High-frequency wallets and market makers are left out.</p>'
      + (none ? '<p class="rd-empty">No other evaluated bettor holds a position on tonight’s covered games right now.</p>' : '<ul class="rd-obsl">' + items + '</ul>') + '</div>';
  };
  /* THE SYNC STATE (radar_sync_state()): "pending", "failed" and "no current position" never read alike */
  var SYNC_WHY = { holders_error: 'the latest update of who holds what ended in error', holders_stale: 'the update of who holds what has not succeeded for over 30 minutes',
    grade_error: 'the latest grade ended in error', grade_stale: 'the latest grade is more than 36 hours old' };
  U.syncLine = function (s) {
    if (!s || !s.state || s.state === 'ok') return '';
    if (s.state === 'pending') return 'Sync pending: Radar is still reading its candidates’ complete histories'
      + (num(s.candidates) ? ' (' + (num(s.evaluated) || 0) + ' of ' + s.candidates + ' evaluated so far)' : '')
      + '. The featured bettors and the observed activity appear once the first grade under these rules has finished.';
    return 'Sync failed: ' + (SYNC_WHY[s.reason] || 'Radar’s data is not current') + (s.last_error ? ' (' + s.last_error + ')' : '') + '.'
      + (s.holders_at ? ' Holders last updated ' + U.when(s.holders_at) + '.' : '') + ' What is shown may be out of date.';
  };
  U.tonightHTML = function (r, o) {
    if (!r || r.status === 'disabled' || r.status === 'not_registered' || r.notDeployed) return '';   /* nothing is shown before Radar is on and registered */
    o = o || {};
    var V2 = v2(r), noun = V2 ? 'featured bettor' : 'top bettor', CV = !!o.compare;
    var head = '<div class="rd-head"><h2 class="rd-h2">Smart Money Tonight</h2>' + U.experimentalChip() + '</div>'
      + (CV ? '<p class="rd-sub">Where ' + (V2 ? 'Radar’s featured' : 'top-graded') + ' Polymarket sports bettors hold positions on tonight’s games, beside EdgeDesk’s model and the current price. Information, not a pick. The method is at the end of this section.</p>'
        : V2 ? '<p class="rd-sub">Where Radar’s featured Polymarket sports bettors have real money on tonight’s games. Featured means graded on a complete 90 days at the price a follower would really have paid, with a positive Radar Score: at most ' + esc(r.top_wallets || 10) + '. Information, not a pick.</p>'
        : '<p class="rd-sub">Where the ' + esc(r.top_wallets || 25) + ' best-graded Polymarket sports bettors have real money on tonight\'s games, graded on skill, not just profit. Information, not a pick.</p>');
    var body;
    if (r.status === 'subscribers_only') body = '<p class="rd-empty">Smart Money Tonight is part of the Research Terminal.</p>';
    else if (r.status === 'error') body = '<p class="rd-empty">Smart Money Tonight could not be loaded just now.</p>';
    else {
      var sy = r.sync || null, ss = sy && sy.state, sline = U.syncLine(sy);
      var empty = ss === 'pending' ? ''
        : ss === 'failed' ? '<p class="rd-empty">No card can be shown while the sync is failing.</p>'
        : ss === 'ok' ? '<p class="rd-empty">No ' + (V2 ? 'featured' : 'top-graded') + ' bettor holds a position on tonight’s covered games right now'
          + (sy.holders_at ? ' (holders checked ' + esc(U.when(sy.holders_at)) + ')' : '') + '.</p>'
        : '<p class="rd-empty">No ' + (V2 ? 'featured' : 'top-graded') + ' bettor holds a position on tonight\'s covered games yet.</p>';
      body = (sline ? '<p class="rd-line rd-sync rd-sync-' + esc(ss) + '" role="status">' + esc(sline) + '</p>' : '')
        + (V2 && ss !== 'pending' ? '<p class="rd-line">' + esc(U.featuredLine(r)) + '</p>' : '')
        + (!(r.cards || []).length ? empty
          : '<div class="rd-cards">' + r.cards.map(function (c) {
            var co = { conviction_x: r.conviction_high_x, noun: noun, events: o.events, zone: o.zone, now: o.now, sourceTimes: o.sourceTimes, researchHref: o.researchHref };
            return CV ? U.cardV2HTML(c, co) : U.cardHTML(c, co);
          }).join('') + '</div>');
      var obs = V2 ? U.observedHTML(r.observed, { empty: ss === 'ok' }) : '';
      var disc = V2 && U.discoveryLine(r.discovery) ? '<p class="rd-line rd-dim">' + esc(U.discoveryLine(r.discovery)) + '</p>' : '';
      /* v2: the method and the observed activity fold away, so the cards lead on a phone */
      body += CV ? ((obs ? '<details class="rd-fold"><summary>Observed activity (not a signal)</summary>' + obs + '</details>' : '')
        + '<details class="rd-fold" id="rdHow"><summary>How Smart Money Tonight works</summary>'
        + (V2 ? '<p class="rd-sub">Featured means graded on a complete 90 days at the price a follower would really have paid, with a positive Radar Score: at most ' + esc(r.top_wallets || 10) + '.</p>' : '')
        + '<p class="rd-sub">Model fair is EdgeDesk’s own probability for the exact contract (same game, side, market, line and settlement), shown only while the model is current; otherwise the card says why there is no comparison. The difference is the price minus model fair, in cents, before fees. A wallet holding the same side as the model adds nothing to it.</p>' + disc + '</details>')
        : obs + disc;
    }
    var gAt = r.graded_at || (r.sync && r.sync.graded_at);
    return '<section class="rd-sec" aria-labelledby="rdTonightH">' + head.replace('<h2 class="rd-h2">', '<h2 class="rd-h2" id="rdTonightH">') + body
      + '<p class="rd-foot">' + (gAt ? 'Graded ' + esc(U.day(gAt)) : r.sync && r.sync.state === 'pending' ? 'Not graded yet under these rules' : 'Graded —') + '. Tap a bettor to see their record. ' + U.limitationsLink() + '</p></section>';
  };
  U.limitationsLink = function () { return '<a href="/radar/#limitations" class="rd-a">Known limitations</a>'; };

  /* ------------------------------------------------------------ the score and its parts, always together */
  U.scoreHTML = function (g) {
    if (!g || num(g.radar_score) == null) return '<span class="rd-dim">No Radar Score</span>';
    var p = g.score_parts || {};
    return '<span class="rd-score">' + esc(num(g.radar_score).toFixed(2)) + '</span> '
      + '<span class="rd-parts">= 0.5 × follow ROI ' + esc(U.pct(p.follow_roi)) + ' + 0.3 × CLV ' + esc(U.pct(p.clv_pct)) + ' + 0.2 × ROI ' + esc(U.pct(p.roi)) + ' (each shrunk toward zero by sample)</span>';
  };
  function sampleChip(g) { return g.sample === 'ranked' ? '' : chip('Small sample'); }
  function record(g) { return (num(g.wins) || 0) + '–' + (num(g.losses) || 0) + ((num(g.pushes) || 0) ? '–' + g.pushes : ''); }

  /* ------------------------------------------------------------ the leaderboard */
  U.leaderboardHTML = function (r) {
    if (!r || r.status === 'disabled' || r.status === 'not_registered') return '<p class="rd-empty">Prediction Radar is not live yet. Nothing is shown until it is.</p>';
    if (r.status === 'not_graded') return '<p class="rd-empty">No grading run has finished yet.</p>';
    if (r.status !== 'ok') return '<p class="rd-empty">The leaderboard could not be loaded just now.</p>';
    var rows = (r.rows || []).map(function (g) {
      return '<tr><td class="rd-n">' + esc(g.rank == null ? '—' : g.rank) + '</td>'
        + '<td><button type="button" class="rd-w" data-radar-wallet="' + esc(g.wallet) + '">' + esc(U.walletLabel(g)) + '</button> ' + sampleChip(g) + (g.top_directional ? chip('Featured') : '') + '</td>'
        + '<td>' + esc(g.style) + '</td><td class="rd-n">' + esc(g.graded_bets) + '</td><td class="rd-n">' + esc(record(g)) + '</td>'
        + '<td class="rd-n">' + esc(U.pct(g.roi)) + '</td><td class="rd-n">' + esc(U.pp(g.clv_pp)) + '</td><td class="rd-n">' + esc(U.pct(g.follow5_roi)) + '</td>'
        + '<td>' + U.scoreHTML(g) + '</td></tr>';
    }).join('');
    return '<div class="rd-tablewrap"><table class="rd-table"><caption>Graded on sports game markets: ' + esc(r.min_graded || 50) + ' graded bets to be ranked. Radar Score ' + U.experimentalChip() + '</caption>'
      + '<thead><tr><th scope="col">Rank</th><th scope="col">Bettor</th><th scope="col">Style</th><th scope="col">Graded bets</th><th scope="col">Record</th><th scope="col">ROI</th>'
      + '<th scope="col">CLV</th><th scope="col">Follow ROI (5 min)</th><th scope="col">Radar Score and its parts</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  };

  /* ------------------------------------------------------------ one trader */
  U.traderHTML = function (r) {
    if (!r || r.status === 'disabled' || r.status === 'not_registered') return '<p class="rd-empty">Prediction Radar is not live yet.</p>';
    if (r.status === 'bad_wallet') return '<p class="rd-empty">That is not a Polymarket wallet address.</p>';
    if (r.status === 'not_graded') return '<p class="rd-empty">This wallet has no grade yet.</p>';
    if (r.status !== 'ok') return '<p class="rd-empty">This trader could not be loaded just now.</p>';
    var g = r.grade || {};
    var stat = function (k, v, note) { return '<div><dt>' + esc(k) + '</dt><dd>' + esc(v) + (note ? '<small>' + esc(note) + '</small>' : '') + '</dd></div>'; };
    var hist = (r.history || []).map(function (b) {
      var txs = (b.txs || []).map(function (t, i) { var u = U.polygonscan(t); return u ? '<a class="rd-a" href="' + esc(u) + '" target="_blank" rel="noopener">tx' + (i + 1) + '</a>' : ''; }).join(' ');
      /* a spread's line belongs to one outcome (the market's question names it), so only a total's line is attached here */
      var side = b.market_type === 'totals' ? U.sideLabel({ market_type: 'totals', outcome: b.outcome, selection: b.outcome, point: b.line }) : String(b.outcome || '');
      return '<tr><td>' + esc(U.day(b.game_start_at)) + '</td><td>' + esc(b.question || '') + '</td><td>' + esc(side) + '</td>'
        + '<td class="rd-n">' + esc(U.cents(b.entry_price)) + '</td><td class="rd-n">' + esc(U.money(b.stake)) + '</td>'
        + '<td class="rd-n">' + esc(U.cents(b.follow5_price)) + '</td><td class="rd-n">' + esc(U.cents(b.close_price)) + '</td>'
        + '<td class="rd-n">' + esc(U.pp(b.clv_pp)) + '</td><td>' + esc(b.result) + '</td><td class="rd-n">' + esc(U.money(b.profit)) + '</td><td>' + txs + '</td></tr>';
    }).join('');
    var pos = r.positions_locked ? '<p class="rd-dim">Open positions on games that have not started are in the Research Terminal.</p>'
      : !(r.positions || []).length ? '<p class="rd-dim">No open position on an upcoming covered game.</p>'
        : '<ul class="rd-pos">' + r.positions.map(function (p) {
          return '<li>' + esc(p.question || '') + ' · ' + esc(p.outcome || '') + ' · ' + esc(U.money(p.cost)) + (num(p.avg_price) != null ? ' at ' + esc(U.cents(p.avg_price)) : '') + ' · ' + esc(U.when(p.game_start_at)) + '</li>';
        }).join('') + '</ul>';
    return '<article class="rd-trader">'
      + '<div class="rd-head"><h2 class="rd-h2">' + esc(g.display || U.walletLabel(g)) + '</h2>' + chip(g.style || 'Directional') + sampleChip(g) + '</div>'
      + '<p class="rd-sub rd-mono">' + esc(g.wallet || '') + '</p>'
      + '<dl class="rd-stats">'
      + stat('Record', record(g)) + stat('ROI', U.pct(g.roi)) + stat('CLV', U.pp(g.clv_pp), 'entry against the close')
      + stat('Follow ROI, 5 min', U.pct(g.follow5_roi), 'entering 5 minutes after them') + stat('Follow ROI, 15 min', U.pct(g.follow15_roi))
      + stat('Graded bets', String(g.graded_bets == null ? '—' : g.graded_bets), (g.sample === 'ranked' ? 'rank #' + g.rank : 'a small sample: under ' + (r.min_graded || 50)))
      + '</dl>'
      + '<p class="rd-line">Radar Score ' + U.experimentalChip() + ' ' + U.scoreHTML(g) + '</p>'
      + '<h3 class="rd-h3">Open positions</h3>' + pos
      + '<h3 class="rd-h3">Every graded bet</h3>'
      + (hist ? '<div class="rd-tablewrap"><table class="rd-table"><thead><tr><th scope="col">Game day</th><th scope="col">Market</th><th scope="col">Side</th><th scope="col">Entry</th><th scope="col">Stake</th>'
        + '<th scope="col">Follow (5 min)</th><th scope="col">Close</th><th scope="col">CLV</th><th scope="col">Result</th><th scope="col">P&amp;L</th><th scope="col">On Polygon</th></tr></thead><tbody>' + hist + '</tbody></table></div>'
        : '<p class="rd-dim">No graded bet yet.</p>')
      + '<p class="rd-foot">Every trade links to its transaction on Polygon, so anyone can check it. Public trading data only. ' + U.limitationsLink() + '</p>'
      + '</article>';
  };

  /* ------------------------------------------------------------ How following has done (the Radar record) */
  /* what the registered holdout test found, in its own numbers, passed or not */
  U.findingLine = function (f) {
    if (!f || f.status !== 'complete') return 'The registered test of following the top-graded bettors on past games (H-RADAR-01) has not reported yet.';
    var ci = function (a, fmt) { return a && a[0] != null && a[1] != null ? ' (95% interval ' + fmt(a[0]) + ' to ' + fmt(a[1]) + ')' : ''; };
    return 'H-RADAR-01, the registered test on past games, ' + (f.passed ? 'passed' : 'did not pass') + ' its criteria: followed 5 minutes after entry, '
      + (f.followed == null ? '' : f.followed + ' bets ') + 'beat the close ' + U.rate(f.beat_close_rate) + ' of the time' + ci(f.beat_close_ci, U.rate)
      + ', with a follow ROI of ' + U.pct(f.follow_roi) + ci(f.follow_roi_ci, U.pct) + '.';
  };
  U.recordHTML = function (r) {
    if (!r || r.status !== 'ok') return '';   /* the record is the terminal's: nothing for anyone the database refuses */
    var t = r.totals || {}, graded = num(t.graded) || 0;
    var chips = (r.label === 'H-RADAR-01 PASSED' ? chip('Passed its registered test') : U.experimentalChip())
      + (r.small_sample ? chip('Small sample: ' + graded + ' of ' + (r.min_sample || 200) + ' graded') : '');
    var stat = function (k, v, note) { return '<div><dt>' + esc(k) + '</dt><dd>' + esc(v) + (note ? '<small>' + esc(note) + '</small>' : '') + '</dd></div>'; };
    var rows = (r.recent || []).map(function (c) {
      return '<tr><td>' + esc(U.day(c.commence_time)) + '</td><td>' + esc((c.away_team || '') + ' at ' + (c.home_team || '')) + '</td><td>' + esc(U.sideLabel(c)) + '</td>'
        + '<td class="rd-n">' + esc(U.cents(c.follow_price)) + '</td><td class="rd-n">' + esc(U.cents(c.close_price)) + '</td>'
        + '<td>' + esc(c.result || 'pending') + '</td><td class="rd-n">' + esc(c.roi == null ? '—' : U.pct(c.roi)) + '</td></tr>';
    }).join('');
    var ask = r.priced_at === 'best_ask';
    return '<section class="rd-sec rd-rec" aria-labelledby="rdRecH"><div class="rd-head"><h2 class="rd-h2" id="rdRecH">How following has done</h2>' + chips + '</div>'
      + (ask ? '<p class="rd-sub">Every Smart Money Tonight card is recorded when it is published, at the best ask in Polymarket’s order book then (the price a subscriber could really take), and graded after the game against the close and the result. Nothing is edited. These are Radar\'s own results, not a claim.</p>'
        : '<p class="rd-sub">Every Smart Money Tonight card is recorded when it is published, at the Polymarket price then, and graded after the game against the close and the result. Nothing is edited. These are Radar\'s own results, not a claim.</p>')
      + (graded ? '<dl class="rd-stats">'
        + stat('Record', (num(t.wins) || 0) + '–' + (num(t.losses) || 0) + ((num(t.pushes) || 0) ? '–' + t.pushes : ''), graded + ' graded cards')
        + stat('ROI', U.pct(t.roi), (ask ? 'one unit per card at the best ask, plus the market’s fee' : 'one unit per card at the published price') + '; over ' + graded + ' graded card' + (graded === 1 ? '' : 's') + (r.small_sample ? ', not validated' : ''))
        + stat('Beat the close', U.rate(t.beat_close_rate, 0), (num(t.with_close) || 0) + ' of ' + graded + ' graded with a comparable close')
        + stat('Not graded', String((num(t.pending) || 0) + (num(t.void) || 0)), (num(t.pending) || 0) + ' pending, ' + (num(t.void) || 0) + ' void' + ((num(t.no_close) || 0) ? ', ' + t.no_close + ' without a close' : ''))
        + '</dl>' : '<p class="rd-empty">No card has been graded yet.</p>')
      + (r.hypothesis === 'H-RADAR-02' ? '<p class="rd-line">' + esc('These cards are what H-RADAR-02 tests: a 12-week test at the best ask, with its rules fixed before it starts. Until it passes, nothing here is called evidence.') + '</p>' : '')
      + (num(r.earlier_cards) ? '<p class="rd-line rd-dim">' + esc(r.earlier_cards + ' earlier card' + (r.earlier_cards === 1 ? ' was' : 's were') + ' published under H-RADAR-01’s rules, at the midpoint, and ' + (r.earlier_cards === 1 ? 'is' : 'are') + ' counted apart.') + '</p>' : '')
      + '<p class="rd-line">' + esc(U.findingLine(r.h_radar_01)) + '</p>'
      + (rows ? '<div class="rd-tablewrap"><table class="rd-table"><caption>The latest cards</caption><thead><tr><th scope="col">Game day</th><th scope="col">Game</th><th scope="col">Side</th>'
        + '<th scope="col">Published at</th><th scope="col">Close</th><th scope="col">Result</th><th scope="col">ROI</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '')
      + '<p class="rd-foot">Past results do not predict future results. ' + U.limitationsLink() + '</p></section>';
  };

  /* ------------------------------------------------------------ Known limitations */
  U.LIMITATIONS = [
    'Polymarket’s public data is its international platform. A US reader may not be able to trade the same markets.',
    'A follower never gets the bettor’s entry price. Each card is recorded at the best ask in the order book when it is published (cards from before H-RADAR-02 used the market’s midpoint); a subscriber who acts later may pay more, and the depth at the ask is limited.',
    'Grades follow a bettor 5 minutes after their entry at the midpoint plus 1 cent, because Polymarket keeps no history of the ask, and add the market’s taker fee from its own fee schedule (Polymarket’s formula: rate × price × (1 − price)). A follow on a market whose fee schedule cannot be read is not graded.',
    'High-frequency strategies are never featured: a wallet that trades that often cannot be followed here, however skilled.',
    'Past results do not predict future results.',
    'Some large traders may have information others do not.',
    'Smart Money Tonight reads Polymarket’s top 100 holders of each side, at the board’s own lines, so a top bettor with a small position, or on an alternate line, may not appear.'
  ];
  U.limitationsHTML = function () {
    return '<section class="rd-lim" id="limitations" aria-labelledby="rdLimH"><h2 class="rd-h2" id="rdLimH">Known limitations</h2><ul>'
      + U.LIMITATIONS.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></section>';
  };

  /* ------------------------------------------------------------ style (the terminal's tokens) */
  U.STYLE = [
    '.rd-sec{border:1px solid var(--border);background:var(--surface);border-radius:var(--rad,14px);padding:14px;margin:0 0 16px;min-width:0}',
    '.rd-obs{margin:14px 0 0;padding:12px 0 0;border-top:1px dashed var(--border)}',
    '.rd-obsl{list-style:none;margin:6px 0 0;padding:0;display:grid;gap:6px;font-size:13px;overflow-wrap:anywhere}',
    '.rd-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
    '.rd-h2{font-size:18px;font-weight:800;margin:0;letter-spacing:-.01em;text-transform:none}',
    '.rd-h3{font-size:15px;font-weight:800;margin:16px 0 6px}',
    '.rd-sub{color:var(--dim);font-size:13px;margin:6px 0 10px;line-height:1.45}',
    '.rd-mono{font-family:"JetBrains Mono",monospace;font-size:12px;overflow-wrap:anywhere}',
    '.rd-chip{display:inline-block;font-size:11px;font-weight:700;border:1px solid var(--border);border-radius:7px;padding:2px 7px;color:var(--dim);white-space:nowrap;vertical-align:middle}',
    '.rd-chip.exp{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 55%,var(--border))}',
    '.rd-chip.conv{color:var(--gold)}',
    '.rd-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px}',
    '.rd-card{border:1px solid var(--border);background:var(--surface2);border-radius:var(--rad-s,11px);padding:12px;min-width:0;overflow-wrap:anywhere}',
    '.rd-meta{font-size:12px;color:var(--dim)}',
    '.rd-sent{font-size:17px;font-weight:800;margin:4px 0 8px;line-height:1.3}',
    '.rd-nums{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin:0 0 8px}',
    '.rd-nums div,.rd-stats div{min-width:0}',
    '.rd-nums dt,.rd-stats dt{font-size:11px;color:var(--dim)}',
    '.rd-nums dd,.rd-stats dd{margin:0;font-weight:800;font-variant-numeric:tabular-nums}',
    '.rd-stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;margin:10px 0}',
    '.rd-stats small{display:block;font-weight:500;font-size:11px;color:var(--dim)}',
    '.rd-line{font-size:13px;margin:4px 0;line-height:1.45}',
    '.rd-dim,.rd-empty{color:var(--dim);font-size:13px}',
    '.rd-sync{font-weight:600}.rd-sync-failed{color:var(--neg,#e5534b)}',
    '.rd-ws,.rd-pos{list-style:none;padding:0;margin:8px 0 0;display:grid;gap:4px}',
    '.rd-ws li{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:13px}',
    '.rd-w{background:none;border:0;padding:6px 0;min-height:32px;color:var(--accent);font:inherit;font-weight:700;cursor:pointer;text-align:left}',
    '.rd-wn{color:var(--dim);font-size:12px;font-variant-numeric:tabular-nums}',
    '.rd-a{color:var(--accent)}',
    '.rd-foot{font-size:12px;color:var(--dim);margin:10px 0 0}',
    '.rd-score{font-weight:800;font-variant-numeric:tabular-nums}',
    '.rd-parts{font-size:12px;color:var(--dim)}',
    '.rd-tablewrap{overflow-x:auto;max-width:100%;-webkit-overflow-scrolling:touch}',
    '.rd-table{border-collapse:collapse;width:100%;font-size:13px}',
    '.rd-table caption{text-align:left;color:var(--dim);font-size:12px;padding:0 0 6px}',
    '.rd-table th,.rd-table td{border-bottom:1px solid var(--border);padding:6px 8px;text-align:left;vertical-align:top}',
    '.rd-table th{font-size:11px;color:var(--dim);font-weight:700;white-space:nowrap}',
    '.rd-n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.rd-lim{border:1px solid var(--border);border-radius:var(--rad-s,11px);padding:12px 14px;margin:16px 0}',
    '.rd-lim ul{margin:8px 0 0;padding-left:18px;font-size:13px;line-height:1.5;color:var(--dim)}',
    '.rd-sheet{position:fixed;inset:0;z-index:80;background:rgba(0,0,0,.6);display:flex;justify-content:center;align-items:flex-start;padding:24px 12px;overflow-y:auto}',
    '.rd-sheet-in{background:var(--bg);border:1px solid var(--border);border-radius:var(--rad,14px);padding:16px;max-width:980px;width:100%;min-width:0}',
    '.rd-close{float:right;min-height:40px;min-width:40px;background:var(--surface2);border:1px solid var(--border);border-radius:9px;color:var(--text);font:inherit;cursor:pointer}',
    '@media(max-width:520px){.rd-nums{grid-template-columns:repeat(3,minmax(0,1fr))}.rd-sent{font-size:16px}.rd-sheet{padding:8px}}',
    /* v2 cards (the shared comparison): the collapsed card leads, detail folds away */
    '.rd-card.v2 .rd-meta b{color:var(--text);font-weight:700}',
    '.rd-card.v2 .rd-sent{font-size:16px;margin:4px 0 4px}',
    '.rd-hold{font-size:12px;color:var(--dim);margin:0 0 8px;line-height:1.4}',
    '.rd-card.v2 .rd-nums{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}',
    '.rd-card.v2 .rd-nums dd{font-size:20px}',
    '.rd-card.v2 .rd-nums small{display:block;font-size:11px;color:var(--dim);line-height:1.35;margin-top:2px}',
    '.rd-status{font-size:13px;line-height:1.45;margin:8px 0;padding:8px 10px;border-radius:9px;border:1px solid var(--border);background:var(--surface)}',
    '.rd-status .rd-st-k{display:inline-block;font-weight:800;margin-right:4px}',
    '.rd-status.ok{border-color:color-mix(in srgb,var(--accent) 55%,var(--border))}.rd-status.ok .rd-st-k{color:var(--accent)}',
    '.rd-status.warn{border-color:color-mix(in srgb,var(--warn) 55%,var(--border))}.rd-status.warn .rd-st-k{color:var(--warn)}',
    '.rd-status.mute .rd-st-k{color:var(--text)}',
    '.rd-det,.rd-fold{margin:6px 0 0;font-size:13px}',
    '.rd-det summary,.rd-fold summary{cursor:pointer;min-height:44px;display:flex;align-items:center;color:var(--accent);font-weight:700;list-style-position:inside}',
    '.rd-det summary:focus-visible,.rd-fold summary:focus-visible,.rd-act:focus-visible,.rd-w:focus-visible,.rd-a:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:6px}',
    '.rd-fold{border-top:1px dashed var(--border);margin-top:12px}',
    '.rd-dl{margin:4px 0 0;padding-left:18px;line-height:1.5;color:var(--dim);display:grid;gap:4px}',
    '.rd-dl b{color:var(--text)}',
    '.rd-calc{list-style:none;margin-left:-18px;font:500 11px "JetBrains Mono",monospace;color:var(--faint,var(--dim))}',
    '.rd-act{display:inline-flex;align-items:center;min-height:44px;margin-top:6px;padding:0 14px;border-radius:10px;border:1px solid var(--accent);color:var(--accent);font-weight:700;font-size:13px;text-decoration:none}',
    '@media(max-width:520px){.rd-sec{padding:12px}.rd-cards{grid-template-columns:minmax(0,1fr)}.rd-card.v2 .rd-nums dd{font-size:18px}}'
  ].join('\n');
  U.injectStyle = function (doc) {
    try { if (!doc || doc.getElementById('edgedesk-radar-css')) return; var st = doc.createElement('style'); st.id = 'edgedesk-radar-css'; st.textContent = U.STYLE; doc.head.appendChild(st); } catch (_) { /* unstyled is still readable */ }
  };

  /* ------------------------------------------------------------ the trader sheet (the terminal) */
  /* open a trader in a sheet over the page; load(wallet) answers radar_trader */
  U.openTrader = function (doc, wallet, load) {
    if (!doc || !wallet) return;
    U.injectStyle(doc);
    var old = doc.getElementById('rdSheet'); if (old) old.remove();
    var el = doc.createElement('div');
    el.id = 'rdSheet'; el.className = 'rd-sheet'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', 'Trader');
    el.innerHTML = '<div class="rd-sheet-in"><button type="button" class="rd-close" aria-label="Close">×</button><div class="rd-sheet-body"><p class="rd-dim">Loading…</p></div></div>';
    doc.body.appendChild(el);
    var close = function () { el.remove(); doc.removeEventListener('keydown', onKey); };
    var onKey = function (e) { if (e.key === 'Escape') close(); };
    doc.addEventListener('keydown', onKey);
    el.addEventListener('click', function (e) { if (e.target === el || (e.target.closest && e.target.closest('.rd-close'))) close(); });
    try { el.querySelector('.rd-close').focus(); } catch (_) { /* no focus */ }
    Promise.resolve(load(wallet)).then(function (r) { el.querySelector('.rd-sheet-body').innerHTML = U.traderHTML(r); })
      .catch(function () { el.querySelector('.rd-sheet-body').innerHTML = U.traderHTML({ status: 'error' }); });
  };

  return U;
}));
