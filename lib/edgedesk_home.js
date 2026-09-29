/* ===========================================================================
   EdgeDesk home — the landing page's live board, as a view model.

   The landing page reads two small things in parallel (index.html):
     rpc    supabase/home_board.sql public_home_board()  games, counts, times
     stat   football/home/board.json (tools/home/build_home.js)  player props
            and the college game EV
   and this file turns them into what the page prints. It is pure: no DOM, no
   network, and `now` is a parameter, so tools/home/home.test.js runs it in
   Node against fixtures.

   THE RULES IT HOLDS — each is a test:
     * Nothing is invented. A field the data does not carry is null and the
       sentence that needs it is not written. An empty slate is an empty list.
     * Every price is re-judged at VIEW time. A prop captured 20 minutes before
       the file was built may be two hours old when a phone reads it; its age
       is computed now, and past the kernel's 90-minute window it is shown as a
       STALE PRICE, never as current research (the prop kernel's own rule,
       docs/opportunity/DESIGN.md §5).
     * A league's player-prop count is only claimed while that league's capture
       is fresh; otherwise it is left out rather than overstated.
     * Four public words, never a pick: RESEARCH, WATCH, PASS, DATA INCOMPLETE.
       BET / LEAN / WATCH / PASS are the terminal's decision words and stay in
       the terminal; the landing page says whether something is worth
       researching.
     * Model-estimated EV is labelled as such, raw and calibrated EV are never
       merged, and a game EV is always printed with the exact line, price, book
       and capture time it is for.

   Browser: window.EDHome. Node: require('./edgedesk_home.js').
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EDHome = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var VERSION = 'edgedesk_home_v1';
  /* the prop kernel's quote-age windows (football/props/config.js defaults)
     and the research canon's stale-market threshold for a game capture */
  var AGE = { fresh: 15, aging: 30, stale: 90, game_stale: 180, state_stale: 180 };
  var STATUS = {
    RESEARCH: { key: 'RESEARCH', label: 'RESEARCH', tone: 'research', means: 'Clears EdgeDesk’s research gates: worth opening, not a bet.' },
    WATCH: { key: 'WATCH', label: 'WATCH', tone: 'watch', means: 'A real disagreement that has not cleared the gates yet.' },
    PASS: { key: 'PASS', label: 'PASS', tone: 'pass', means: 'EdgeDesk and the market agree, or the price leaves no value.' },
    DATA_INCOMPLETE: { key: 'DATA_INCOMPLETE', label: 'DATA INCOMPLETE', tone: 'incomplete', means: 'Something EdgeDesk needs is missing or stale, and it says what.' }
  };
  var ORDER = { RESEARCH: 0, WATCH: 1, PASS: 2, DATA_INCOMPLETE: 3 };
  /* a capture's book key in the book's own name (lib/edgedesk_personal.js
     BOOKS is the list a reader picks from; caesars is williamhill_us's old key) */
  var BOOK_NAMES = { draftkings: 'DraftKings', fanduel: 'FanDuel', betmgm: 'BetMGM', williamhill_us: 'Caesars', caesars: 'Caesars',
    espnbet: 'ESPN BET', fanatics: 'Fanatics', betrivers: 'BetRivers', hardrockbet: 'Hard Rock Bet', superbook: 'SuperBook',
    circasports: 'Circa Sports', pinnacle: 'Pinnacle', betonlineag: 'BetOnline', lowvig: 'LowVig', bovada: 'Bovada', betus: 'BetUS',
    mybookieag: 'MyBookie', betanysports: 'BetAnySports', novig: 'Novig', prophetx: 'ProphetX', matchbook: 'Matchbook' };
  function bookName(b) { if (!b) return null; var k = String(b).toLowerCase(); return BOOK_NAMES[k] || String(b); }
  /* one minus sign everywhere (the state's own text uses a hyphen) */
  function minus(t) { return t == null ? null : String(t).replace(/(^|[\s(])-(?=\d)/g, '$1\u2212'); }

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function ms(t) { if (t == null) return NaN; var v = t instanceof Date ? t.getTime() : (typeof t === 'number' ? t : Date.parse(t)); return isFinite(v) ? v : NaN; }
  function minutesSince(t, now) { var a = ms(t), b = ms(now == null ? Date.now() : now); return isFinite(a) && isFinite(b) ? Math.max(0, (b - a) / 60000) : null; }
  function ageText(min) {
    if (min == null) return null;
    if (min < 1) return 'just now';
    if (min < 60) return Math.round(min) + ' min ago';
    if (min < 48 * 60) return Math.round(min / 60) + ' h ago';
    return Math.round(min / 1440) + ' d ago';
  }
  /* FRESH ≤15 · AGING ≤30 · STALE ≤90 · EXPIRED beyond (a prop price) */
  function priceState(t, now) {
    var m = minutesSince(t, now);
    if (m == null) return 'UNKNOWN';
    return m <= AGE.fresh ? 'FRESH' : (m <= AGE.aging ? 'AGING' : (m <= AGE.stale ? 'STALE' : 'EXPIRED'));
  }

  /* ------------------------------------------------------------ words */
  var MINUS = '−';
  function sign(v, d) { if (!isNum(v)) return null; var s = Math.abs(v).toFixed(d == null ? 1 : d); return (v > 0 ? '+' : (v < 0 ? MINUS : '')) + s; }
  function american(v) { if (!isNum(v)) return null; return v > 0 ? '+' + Math.round(v) : MINUS + Math.abs(Math.round(v)); }
  function pct(x, d) { return isNum(x) ? (100 * x).toFixed(d == null ? 1 : d) + '%' : null; }
  function signedPct(x, d) { if (!isNum(x)) return null; var s = (100 * Math.abs(x)).toFixed(d == null ? 1 : d); return (x > 0 ? '+' : (x < 0 ? MINUS : '')) + s + '%'; }
  function trim(n) { return isNum(n) ? (Math.round(n * 10) / 10).toString() : null; }
  function one(n) { return isNum(n) ? n.toFixed(1) : null; }
  /* a home-line (negative = home favoured) as a team and a number */
  function teamLine(homeLine, home, away) {
    if (!isNum(homeLine)) return null;
    if (Math.abs(homeLine) < 0.05) return 'PK';
    return homeLine < 0 ? (home + ' ' + MINUS + Math.abs(homeLine).toFixed(1)) : (away + ' ' + MINUS + homeLine.toFixed(1));
  }
  function kickoffText(t, tz) {
    var v = ms(t); if (!isFinite(v)) return null;
    try {
      var o = { weekday: 'short', hour: 'numeric', minute: '2-digit' };
      if (tz) o.timeZone = tz;
      return new Date(v).toLocaleString('en-US', o);
    } catch (e) { return new Date(v).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; }
  }
  /* no lookbehind: older iOS Safari refuses the whole file over one */
  function firstSentence(t) { var s = String(t), m = /^[\s\S]*?\.(?=\s)/.exec(s); return m ? m[0] : s; }
  function leagueLabel(lg) { return lg === 'nfl' ? 'NFL' : (lg === 'cfb' ? 'CFB' : String(lg || '').toUpperCase()); }

  /* ------------------------------------------------------- statuses */
  /* a game's public status: the database already decided it
     (ed_public_status); a market capture that has gone stale since is
     downgraded here, at view time */
  function gameStatus(g, now) {
    var k = g && STATUS[g.status] ? g.status : 'DATA_INCOMPLETE';
    var note = g && g.status_note ? g.status_note : null;
    var m = g && g.market ? minutesSince(g.market.captured_at, now) : null;
    if (k !== 'DATA_INCOMPLETE' && g && g.market && (g.market.stale === true || (m != null && m > AGE.game_stale))) {
      k = 'DATA_INCOMPLETE'; note = 'The last sportsbook price on file is stale.';
    }
    /* a label is never printed over numbers that are not there */
    if (k !== 'DATA_INCOMPLETE' && !(g && g.market && isNum(g.market.home_line))) { k = 'DATA_INCOMPLETE'; note = 'No current sportsbook market has been captured.'; }
    else if (k !== 'DATA_INCOMPLETE' && !(g && g.fair && isNum(g.fair.home_line))) { k = 'DATA_INCOMPLETE'; note = 'EdgeDesk has not priced this game yet.'; }
    return { key: k, label: STATUS[k].label, tone: STATUS[k].tone, note: note || (k === 'DATA_INCOMPLETE' ? 'Some inputs are missing or thin for this game.' : null) };
  }
  /* a prop's public status, from the engine's decision and the price's age NOW */
  function propStatus(p, now) {
    if (!p) return { key: 'DATA_INCOMPLETE', label: STATUS.DATA_INCOMPLETE.label, tone: 'incomplete', note: 'No prop data.' };
    var ps = priceState(p.price && p.price.captured_at, now);
    if (!p.price || !isNum(p.price.american)) return mk('DATA_INCOMPLETE', 'No sportsbook price is on file.');
    if (ps === 'EXPIRED' || ps === 'UNKNOWN') return mk('DATA_INCOMPLETE', 'Stale price: captured ' + (ageText(minutesSince(p.price.captured_at, now)) || 'at an unknown time') + '.');
    var d = String(p.decision || '').toUpperCase();
    if (d === 'NO_DECISION' || d === 'NO DECISION' || !isNum(p.ev)) return mk('DATA_INCOMPLETE', 'EdgeDesk could not evaluate this price.');
    if (d === 'PASS') return mk('PASS', null);
    if (d === 'WATCH') return mk('WATCH', null);
    if (p.research_grade === true && (d === 'BET' || d === 'LEAN')) return mk(ps === 'STALE' ? 'WATCH' : 'RESEARCH', ps === 'STALE' ? 'Price is ageing; re-check it before relying on it.' : null);
    return mk(p.ev > 0 ? 'WATCH' : 'PASS', null);
    function mk(k, n) { return { key: k, label: STATUS[k].label, tone: STATUS[k].tone, note: n, price_state: ps }; }
  }

  /* ------------------------------------------------------- the props */
  function propView(p, now) {
    if (!p || !p.player || !p.market) return null;
    var st = propStatus(p, now), line = p.selection && isNum(p.selection.line) ? p.selection.line : null;
    var proj = p.projection && isNum(p.projection.mean) ? p.projection.mean : null;
    var side = p.selection && p.selection.side ? String(p.selection.side).toLowerCase() : null;
    var diff = isNum(line) && isNum(proj) ? Math.round((proj - line) * 10) / 10 : null;
    var age = minutesSince(p.price && p.price.captured_at, now);
    var modelEstimated = /MODEL-ESTIMATED/i.test(p.probability_label || '') || p.stage === 'EXPERIMENTAL';
    return {
      id: p.id || p.prop_id, prop_id: p.prop_id || null, league: p.league || null, game_key: p.game_key || null,
      matchup: p.matchup || null,
      player: p.player.name || null, team: p.player.team || null, position: p.player.position || null,
      market: p.market.label || p.market.key || null,
      selection: p.selection ? p.selection.text || null : null, side: p.selection ? p.selection.side || null : null,
      line: line, line_text: one(line),
      projection: proj, projection_text: one(proj),
      median_text: p.projection && isNum(p.projection.median) ? trim(p.projection.median) : null,
      range_text: p.projection && isNum(p.projection.p25) && isNum(p.projection.p75) ? trim(p.projection.p25) + '–' + trim(p.projection.p75) : null,
      difference: diff,
      difference_text: diff == null ? null : sign(diff, 1),
      /* does the projection lean the way the selection is priced? An under
         with the projection below the line SUPPORTS the side; the sign alone
         would read it as bad news */
      supports: diff == null || diff === 0 || !side ? null : ((side === 'over' || side === 'yes') ? diff > 0 : (side === 'under' || side === 'no') ? diff < 0 : null),
      odds_text: p.price ? american(p.price.american) : null, book: p.price ? bookName(p.price.book) : null,
      books_at_line: p.price && isNum(p.price.books_at_line) ? p.price.books_at_line : null,
      captured_at: p.price ? p.price.captured_at || null : null, age_min: age, age_text: ageText(age), price_state: st.price_state || priceState(p.price && p.price.captured_at, now),
      probability_text: pct(p.probability), break_even_text: pct(p.break_even), fair_odds_text: american(p.fair_american),
      /* EV is printed only while the price it was computed at is still current */
      ev: st.key === 'DATA_INCOMPLETE' ? null : (isNum(p.ev) ? p.ev : null),
      ev_text: st.key === 'DATA_INCOMPLETE' ? null : signedPct(p.ev),
      ev_raw_text: st.key === 'DATA_INCOMPLETE' ? null : signedPct(p.ev_raw),
      ev_label: modelEstimated ? 'model-estimated' : (p.probability_label ? String(p.probability_label).toLowerCase() : null),
      stage: p.stage || null, confidence: isNum(p.confidence) ? p.confidence : null,
      consensus_text: trim(p.consensus_line), n_books: isNum(p.n_books) ? p.n_books : null,
      research_score: isNum(p.research_score) ? p.research_score : null,
      app_hash: p.prop_id && p.league ? '#playerprops/' + p.league + '/' + encodeURIComponent(p.prop_id) : null,
      why: (p.why || []).slice(0, 3), concerns: (p.concerns || []).slice(0, 3),
      status: st.key, status_label: st.label, tone: st.tone, status_note: st.note
    };
  }
  function byPropOrder(a, b) {
    return (ORDER[a.status] - ORDER[b.status]) || ((b.research_score || 0) - (a.research_score || 0));
  }

  /* ------------------------------------------------------- the games */
  function gameView(g, stat, now, tz) {
    var st = gameStatus(g, now);
    var fair = g.fair || {}, mk = g.market || {};
    var home = g.home || 'Home', away = g.away || 'Away';
    /* the numbers read best with short team names: an NFL game key carries
       both codes (2026_04_PIT_CLE); a college name is short already */
    var codes = g.league === 'nfl' ? /_([A-Z]{2,3})_([A-Z]{2,3})$/.exec(String(g.game_key || '')) : null;
    var sh = codes ? codes[2] : home, sa = codes ? codes[1] : away;
    var fairText = minus((codes ? null : fair.text) || teamLine(fair.home_line, sh, sa));
    var mktText = minus((codes ? null : mk.text) || teamLine(mk.home_line, sh, sa));
    var mAge = minutesSince(mk.captured_at, now);
    var projHome = isNum(fair.total) && isNum(fair.home_line) ? (fair.total - fair.home_line) / 2 : null;
    var projAway = isNum(fair.total) && isNum(fair.home_line) ? (fair.total + fair.home_line) / 2 : null;
    /* the props: the fresher of the research state's block and the static file */
    var sg = stat && stat.props && stat.props.by_game ? stat.props.by_game[g.game_key] : null;
    var items = stat && stat.props ? stat.props.items || {} : {};
    var dbTop = g.props && Array.isArray(g.props.top) ? g.props.top : [];
    var stTop = sg && Array.isArray(sg.top) ? sg.top.map(function (id) { return items[id]; }).filter(Boolean) : [];
    var newest = function (list) { var t = NaN; list.forEach(function (p) { var v = ms(p.price && p.price.captured_at); if (isFinite(v) && !(v <= t)) t = v; }); return t; };
    var src = stTop.length && !(newest(dbTop) > newest(stTop)) ? stTop : dbTop;
    var props = src.map(function (p) { return propView(p, now); }).filter(Boolean).sort(byPropOrder);
    /* the college game EV: its own quote, its own time */
    var ev = stat && stat.game_ev ? stat.game_ev[g.game_key] : null, evView = null;
    if (ev && isNum(ev.calibrated_ev)) {
      var evAge = minutesSince(ev.captured_at, now);
      evView = {
        selection: minus(ev.selection) || null, price_text: american(ev.price), book: bookName(ev.book),
        captured_at: ev.captured_at || null, age_text: ageText(evAge),
        stale: evAge == null || evAge > AGE.game_stale,
        calibrated_text: signedPct(ev.calibrated_ev), raw_text: signedPct(ev.raw_ev),
        calibrated: ev.calibrated_ev, decision: ev.decision || null, reason: ev.decision_reason || null,
        source: ev.probability_source ? String(ev.probability_source).replace(/_/g, ' ') : null
      };
    }
    return {
      game_key: g.game_key, league: g.league, league_label: leagueLabel(g.league), home: home, away: away,
      matchup: away + ' @ ' + home, kickoff_at: g.kickoff_at || null, kickoff_text: kickoffText(g.kickoff_at, tz),
      status: st.key, status_label: st.label, tone: st.tone, status_note: st.note,
      fair_text: fairText, market_text: mktText,
      gap: g.gap && isNum(g.gap.points) ? g.gap.points : null,
      gap_text: g.gap && isNum(g.gap.points) ? g.gap.points.toFixed(1) + ' pts' : null,
      toward: g.gap && g.gap.toward ? (g.gap.toward === 'home' ? home : (g.gap.toward === 'away' ? away : g.gap.toward)) : null,
      market_book: bookName(mk.book), market_age_text: ageText(mAge), market_stale: !!(mk.stale || (mAge != null && mAge > AGE.game_stale)),
      market_kind: mk.kind || null,
      /* a market number with no capture time says what it is instead */
      market_note: mk.kind === 'consensus' ? 'consensus reference, not a captured quote' : (isNum(mk.home_line) && mAge == null ? 'capture time not on file' : null),
      projected_text: isNum(projHome) && isNum(projAway) ? (home + ' ' + Math.round(projHome) + ', ' + away + ' ' + Math.round(projAway)) : null,
      win_prob_text: isNum(g.win_prob_home) ? (g.win_prob_home >= 0.5 ? home + ' ' + pct(g.win_prob_home, 0) : away + ' ' + pct(1 - g.win_prob_home, 0)) : null,
      reliability: g.reliability && isNum(g.reliability.score) ? Math.round(g.reliability.score) : null,
      key_reason: g.key_reason ? minus(String(g.key_reason).replace(/\(([a-z_]+)\)/g, function (m, k) { return BOOK_NAMES[k] ? '(' + BOOK_NAMES[k] + ')' : m; })) : null,
      uncertainty: (g.uncertainty || []).slice(0, 3),
      qb_unconfirmed: !!(g.qb && g.qb.confirmed_both === false),
      props: props,
      props_count: sg && isNum(sg.research_grade) ? sg.research_grade : (g.props && isNum(g.props.count) ? g.props.count : null),
      props_total: sg && isNum(sg.total) ? sg.total : (g.props && isNum(g.props.total) ? g.props.total : null),
      props_empty: g.props && g.props.empty_text ? firstSentence(g.props.empty_text) : null,
      ev: evView,
      state_stale: !!g.state_stale,
      moved: g.movement && isNum(g.movement.spread_moved) ? g.movement.spread_moved : null,
      moved_toward_model: g.movement ? g.movement.toward_model === true : null,
      first_seen_at: g.first_seen_at || null, computed_at: g.computed_at || null,
      /* a signed-out visitor may open a game's research only where an admin
         made it a public sample (growth.sql); the terminal link is the page's
         to add for a subscriber */
      sample_url: g.sample === true && g.game_key ? '/research/sample/?game=' + encodeURIComponent(g.game_key) : null,
      app_hash: g.game_key ? '#research/football/' + (g.league === 'nfl' ? 'nfl|' : '') + encodeURIComponent(String(g.game_key).split('|')[1] || '') : null
    };
  }

  /* ------------------------------------------- the signed-in reader's copy
     A subscriber reads game_research_state directly (RLS lets an entitled
     reader select it), so the first-run screen can see every game, its
     movement and when it was first seen. These three functions turn those
     rows into the SAME shape public_home_board() returns, so one renderer
     serves both — and publicStatus is the SQL rule (ed_public_status) word
     for word; tools/home/home_sql.test.js holds the two equal. */
  var INCOMPLETE_STATUS = ['DATA FAULT', 'NOT PRICED', 'AWAITING DATA', 'THIN DATA', 'STALE QUOTE', 'NO MARKET'];
  var INCOMPLETE_LABEL = ['DATA_FAULT', 'LIMITED_DATA', 'NO_MARKET', 'LOW_RELIABILITY'];
  function publicStatus(projected, status, label, grade, marketLine, marketStale, gap) {
    var st = String(status || '').toUpperCase(), lb = String(label || '').toUpperCase();
    if (!projected) return 'DATA_INCOMPLETE';
    if (INCOMPLETE_STATUS.indexOf(st) >= 0 || INCOMPLETE_LABEL.indexOf(lb) >= 0) return 'DATA_INCOMPLETE';
    if (marketLine == null || marketStale === true) return 'DATA_INCOMPLETE';
    if (grade === true) return 'RESEARCH';
    if (isNum(gap) && gap < 2) return 'PASS';
    if (st === 'AGREEMENT' || lb === 'MARKET_ALIGNED' || lb === 'NEAR_PICKEM') return 'PASS';
    return 'WATCH';
  }
  function incompleteReason(projected, status, marketLine, marketStale) {
    var st = String(status || '').toUpperCase();
    if (!projected || st === 'NOT PRICED') return 'EdgeDesk has not priced this game yet.';
    if (st === 'DATA FAULT') return 'An integrity check flagged the data; the number is held back until it is explained.';
    if (marketLine == null || st === 'NO MARKET') return 'No current sportsbook market has been captured.';
    if (marketStale === true || st === 'STALE QUOTE') return 'The last sportsbook price on file is stale.';
    return 'Some inputs are missing or thin for this game.';
  }
  /* a full opportunity (edgedesk_opportunity/1) → the landing page's slim prop */
  function slimOpp(o) {
    if (!o || !o.player || !o.market) return null;
    var e = o.event || {}, p = o.player || {}, pr = o.price || {}, m = o.model || {}, pj = m.projection || {}, mv = o.market_view || {}, x = o.explanation || {};
    var team = p.team && e.home === p.team ? (e.home_name || p.team) : (p.team && e.away === p.team ? (e.away_name || p.team) : p.team);
    return {
      id: o.id || o.prop_id, prop_id: o.prop_id || null, league: o.league || e.league || null, game_key: e.event_key || null,
      matchup: { home: e.home_name || e.home || null, away: e.away_name || e.away || null, kickoff: e.kickoff || null },
      player: { name: p.name || null, team: team || null, position: p.position || null },
      market: { key: o.market.key || null, label: o.market.label || null },
      selection: o.selection ? { side: o.selection.side || null, line: isNum(o.selection.line) ? o.selection.line : null, text: o.selection.text || null } : null,
      price: { american: isNum(pr.american) ? pr.american : null, book: pr.book_name || pr.book || null, captured_at: pr.captured_at || null, books_at_line: isNum(pr.books_at_line) ? pr.books_at_line : null },
      projection: { mean: isNum(pj.mean) ? pj.mean : null, median: isNum(pj.median) ? pj.median : null, p25: isNum(pj.p25) ? pj.p25 : null, p75: isNum(pj.p75) ? pj.p75 : null },
      probability: isNum(m.probability) ? m.probability : null, fair_american: isNum(m.fair_american) ? m.fair_american : null,
      break_even: isNum(o.break_even) ? o.break_even : null, ev: isNum(o.ev) ? o.ev : null, ev_raw: isNum(o.ev_raw) ? o.ev_raw : null,
      edge_pp: isNum(o.edge_pp) ? o.edge_pp : null, confidence: isNum(o.confidence) ? o.confidence : null,
      decision: o.decision || null, stage: o.stage || null, probability_label: o.probability_label || null,
      consensus_line: isNum(mv.consensus_line) ? mv.consensus_line : null, n_books: isNum(mv.n_books) ? mv.n_books : null,
      research_score: o.research && isNum(o.research.score) ? o.research.score : null, research_grade: o.research ? o.research.grade === true : null,
      why: (x.why || []).slice(0, 3), concerns: (x.concerns || []).slice(0, 3), evaluated_at: o.evaluated_at || null
    };
  }
  /* rows of game_research_state (with state->props, ->fair, ->market, ->gap,
     ->priority, ->movement selected alongside) → public_home_board()'s shape */
  function fromStateRows(rows, now) {
    now = now == null ? Date.now() : ms(now);
    var up = (rows || []).filter(function (r) { var k = ms(r.kickoff_at); return isFinite(k) && k > now && k < now + 8 * 864e5; });
    var games = up.map(function (r) {
      var pub = publicStatus(r.projected, r.status, r.research_label, r.research_grade, r.market_home_line, r.market_stale, isNum(+r.gap_pts) && r.gap_pts != null ? +r.gap_pts : null);
      var props = r.props && typeof r.props === 'object' ? r.props : null, fair = r.fair || {}, mk = r.market || {}, gap = r.gap || {}, pri = r.priority || {};
      return {
        game_key: r.game_key, league: r.sport, home: r.home, away: r.away, kickoff_at: r.kickoff_at, status: pub,
        status_note: pub === 'DATA_INCOMPLETE' ? incompleteReason(r.projected, r.status, r.market_home_line, r.market_stale) : null,
        research_label: r.research_label || null,
        fair: { home_line: r.fair_home_line == null ? null : +r.fair_home_line, total: r.fair_total == null ? null : +r.fair_total, text: fair.text || null },
        market: { home_line: r.market_home_line == null ? null : +r.market_home_line, text: mk.text || null, book: r.market_book || null,
          captured_at: r.market_captured_at || null, stale: r.market_stale, kind: r.market_kind || null, books: mk.books == null ? null : mk.books },
        gap: { points: r.gap_pts == null ? null : +r.gap_pts, toward: gap.toward || null },
        win_prob_home: r.win_prob_home == null ? null : +r.win_prob_home,
        reliability: { score: r.reliability_score == null ? null : +r.reliability_score },
        qb: { confirmed_both: r.qb_confirmed == null ? null : r.qb_confirmed },
        key_reason: r.key_reason ? String(r.key_reason).slice(0, 240) : null,
        uncertainty: Array.isArray(pri.uncertainty) ? pri.uncertainty.slice(0, 3) : [],
        props: props ? { count: props.count, total: props.total_props, priced: props.priced_props, evaluated: props.evaluated_props,
          capture: props.capture ? props.capture.state : null, empty_text: props.empty_text || null,
          top: (props.top_opportunities || []).slice(0, 3).map(slimOpp).filter(Boolean) } : null,
        movement: r.movement || null, first_seen_at: r.first_seen_at || null, computed_at: r.computed_at || null,
        priority_rank: r.priority_rank == null ? null : +r.priority_rank
      };
    });
    var cnt = function (k) { return games.filter(function (g) { return g.status === k; }).length; };
    var times = games.map(function (g) { return ms(g.computed_at); }).filter(isFinite);
    var mkt = up.map(function (r) { return ms(r.market_captured_at); }).filter(function (v) { return isFinite(v) && v <= now; });
    return {
      ok: true, schema: 'edgedesk_home_board/1', as_of: new Date(now).toISOString(),
      counts: { games_analyzed: up.filter(function (r) { return r.projected; }).length, games_on_slate: up.length,
        game_research: cnt('RESEARCH'), watching: cnt('WATCH'), passes: cnt('PASS'), data_incomplete: cnt('DATA_INCOMPLETE') },
      times: { model_updated_at: times.length ? new Date(Math.max.apply(null, times)).toISOString() : null,
        market_updated_at: mkt.length ? new Date(Math.max.apply(null, mkt)).toISOString() : null },
      games: games
    };
  }

  /* ------------------------------------------------------- the board */
  function build(rpc, stat, now, opts) {
    opts = opts || {};
    now = now == null ? Date.now() : ms(now);
    var ok = !!(rpc && rpc.ok);
    var games = ok && Array.isArray(rpc.games) ? rpc.games.map(function (g) { return gameView(g, stat, now, opts.tz); }) : [];
    /* a game the database called RESEARCH or WATCH whose market has gone
       stale since is DATA INCOMPLETE here — and the headline counts follow,
       so the page never says "4 research-grade" over a board showing none */
    var down = { RESEARCH: 0, WATCH: 0, PASS: 0 };
    if (ok && Array.isArray(rpc.games)) rpc.games.forEach(function (g, i) {
      var was = g && STATUS[g.status] ? g.status : 'DATA_INCOMPLETE';
      if (was !== 'DATA_INCOMPLETE' && games[i].status === 'DATA_INCOMPLETE') down[was]++;
    });
    games.sort(function (a, b) { return (ORDER[a.status] - ORDER[b.status]) || ((b.gap || 0) - (a.gap || 0)); });
    /* the prop table: the static file's top, re-judged now, then the games' */
    var seen = {}, props = [];
    var items = stat && stat.props ? stat.props.items || {} : {};
    (stat && stat.props && Array.isArray(stat.props.top) ? stat.props.top : []).forEach(function (id) {
      var v = propView(items[id], now); if (v && !seen[v.id]) { seen[v.id] = true; props.push(v); }
    });
    games.forEach(function (g) { g.props.forEach(function (v) { if (!seen[v.id]) { seen[v.id] = true; props.push(v); } }); });
    props.sort(byPropOrder);

    var c = ok ? (rpc.counts || {}) : {};
    /* player-prop research. A research-grade prop whose price is older than
       30 minutes is shown as WATCH, so a league's summary count is used only
       while its capture is inside that window AND the props printed from it
       still hold up now; otherwise only what is research-grade NOW counts —
       the headline never says 24 over a table of WATCHes */
    var propResearch = null, sc = stat && stat.props ? stat.props.counts || {} : {};
    var liveBy = {};
    props.forEach(function (p) { if (p.status === 'RESEARCH') liveBy[p.league] = (liveBy[p.league] || 0) + 1; });
    ['nfl', 'cfb'].forEach(function (lg) {
      var x = sc[lg], m = x && x.capture ? minutesSince(x.capture.last_success_at, now) : null;
      var n = x && isNum(x.research_grade) && m != null && m <= AGE.aging && liveBy[lg] ? Math.max(x.research_grade, liveBy[lg]) : (liveBy[lg] || 0);
      if (n > 0) propResearch = (propResearch || 0) + n;
    });
    var propsTracked = isNum(sc.total && sc.total.props) ? sc.total.props : (isNum(c.props_tracked) && c.props_tracked > 0 ? c.props_tracked : null);
    var modelAt = ok && rpc.times ? rpc.times.model_updated_at : null;
    var oddsTimes = [ok && rpc.times ? rpc.times.quotes_updated_at : null, ok && rpc.times ? rpc.times.market_updated_at : null,
      ok && rpc.times ? rpc.times.prop_quotes_updated_at : null,
      sc.nfl && sc.nfl.capture ? sc.nfl.capture.last_success_at : null, sc.cfb && sc.cfb.capture ? sc.cfb.capture.last_success_at : null]
      .map(ms).filter(function (v) { return isFinite(v) && v <= now + 60000; });
    var oddsAt = oddsTimes.length ? Math.max.apply(null, oddsTimes) : NaN;
    var modelMin = minutesSince(modelAt, now), oddsMin = isFinite(oddsAt) ? minutesSince(oddsAt, now) : null;
    var updMin = [modelMin, oddsMin].filter(function (v) { return v != null; });
    var pos = function (v) { return isNum(v) && v > 0 ? v : null; };
    var counts = {
      games_analyzed: pos(c.games_analyzed),
      game_research: ok && isNum(c.game_research) ? Math.max(0, c.game_research - down.RESEARCH) : null,
      watching: ok && isNum(c.watching) ? Math.max(0, c.watching - down.WATCH) : null,
      passes: ok && isNum(c.passes) ? Math.max(0, c.passes - down.PASS) : null,
      data_incomplete: ok && isNum(c.data_incomplete) ? c.data_incomplete + down.RESEARCH + down.WATCH + down.PASS : null,
      prop_research: isNum(propResearch) ? propResearch : null,
      props_tracked: pos(propsTracked),
      sportsbook_quotes: pos(c.sportsbook_quotes),
      sportsbooks: pos(c.sportsbooks)
    };
    return {
      ok: ok || props.length > 0,
      live: games.length > 0 || props.length > 0,
      counts: counts,
      times: {
        model_at: modelAt || null, model_text: ageText(modelMin),
        odds_at: isFinite(oddsAt) ? new Date(oddsAt).toISOString() : null, odds_text: ageText(oddsMin),
        updated_text: updMin.length ? ageText(Math.min.apply(null, updMin)) : null,
        /* nothing refreshed in 3 h: the page stops calling itself live */
        stale: updMin.length ? Math.min.apply(null, updMin) > AGE.state_stale : false,
        model_stale: modelMin != null && modelMin > AGE.state_stale
      },
      games: games,
      props: props,
      preview: preview(games, props)
    };
  }

  /* THE HERO: 2-4 live opportunities. Games that deserve research first (with
     their props), then research-grade props of their own. Only RESEARCH and
     WATCH qualify; nothing is promoted to fill the space. */
  function preview(games, props) {
    var out = [], used = {};
    games.forEach(function (g) {
      if (out.length >= 3) return;
      if (g.status === 'RESEARCH' || g.status === 'WATCH') { out.push({ kind: 'game', game: g }); g.props.forEach(function (p) { used[p.id] = true; }); }
    });
    props.forEach(function (p) {
      if (out.length >= 4 || used[p.id]) return;
      if (p.status === 'RESEARCH') { out.push({ kind: 'prop', prop: p }); used[p.id] = true; }
    });
    return out;
  }

  return {
    VERSION: VERSION, AGE: AGE, STATUS: STATUS,
    build: build, gameView: gameView, propView: propView, gameStatus: gameStatus, propStatus: propStatus,
    publicStatus: publicStatus, incompleteReason: incompleteReason, slimOpp: slimOpp, fromStateRows: fromStateRows,
    priceState: priceState, minutesSince: minutesSince, ageText: ageText,
    sign: sign, american: american, pct: pct, signedPct: signedPct, teamLine: teamLine, kickoffText: kickoffText, leagueLabel: leagueLabel,
    bookName: bookName, minus: minus
  };
}));
