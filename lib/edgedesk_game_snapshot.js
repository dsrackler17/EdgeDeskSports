/* ===========================================================================
   EdgeDesk GAME SNAPSHOT — one NFL or college football game's research, the
   way EdgeDesk's own models see it, before any sportsbook is consulted.
   Browser: window.EDGameSnapshot. Node: require('./edgedesk_game_snapshot.js').
   docs/game-research/README.md

   TWO LAYERS, NEVER MIXED
     Layer A — the EDGEDESK MODEL. fromNfl() / fromCfb() turn the committed
       model artifacts of ONE build into one snapshot: the projected score, the
       fair spread and total, both win probabilities, the model-implied
       moneyline (a mathematical restatement of the win probability, never a
       price), the outcome range, the model's own additive terms, the unit
       rankings and the 3-4 matchup insights those numbers support. It reads
       no sportsbook number, so a market outage cannot touch it. When the
       model itself lacks the data, the snapshot says so (model.available is
       false, with the reason) and nothing is estimated in its place.
     Layer B — the SPORTSBOOK MARKET. market() normalises whatever quote the
       reader's page holds into LIVE / CACHED / STALE / MANUAL / UNAVAILABLE /
       FAULT, with its book and capture time. It is optional context: its
       absence removes the comparison and nothing else.

   THREE SEPARATE ANSWERS (availability())
     research   is there enough football data to analyse the game?
     market     is there a fresh sportsbook quote?
     decision   can an actual market price be evaluated against the model?
   A missing quote moves only the last two.

   THE RULES
     * Every number is the artifact's own, or arithmetic on it through
       lib/edgedesk_calc.js (one rounding policy). Nothing is invented to fill
       a slot: a missing rank, record or driver is omitted, never guessed.
     * Insights are chosen from measured rankings and the model's own terms,
       ordered by how large the measured gap is. No generic copy.
     * checks() holds the snapshot to its own arithmetic: scores reconcile
       with the fair spread and total, the two win probabilities sum to 100%,
       the model moneyline restates the win probability, ranks sit inside
       their league. A failed check is a DATA FAULT shown to the reader.
     * Reliability (CFB, 0-100) is not a probability and is never printed
       with a percent sign; the NFL model publishes no reliability score.
     * A spread-cover probability is never labelled a win probability, and a
       market-implied probability is never labelled a model probability.
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./edgedesk_calc.js'));
  else root.EDGameSnapshot = factory(root.EDCalc);
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (C) {
  'use strict';
  var S = { VERSION: 'edgedesk_game_snapshot/1', SCHEMA: 'edgedesk_game_research_v1' };

  S.CONFIG = {
    max_insights: 4,
    min_insights: 3,
    /* a unit pairing is a mismatch only when the gap covers this share of the league */
    unit_gap_share: 0.2,
    /* a whole-number score line may differ from the exact one by this much (half a point per team) */
    whole_score_tolerance: 1,
    /* a market quote older than this is not LIVE (lib/edgedesk_market_state.js live_minutes) */
    live_minutes: 180,
    cached_minutes: 72 * 60,
    reliability_limited: 60
  };

  S.DEFINITIONS = {
    reliability: 'Reliability is how complete, fresh, internally consistent and stable the information under this college projection is (lib/cfb_reliability.js, docs/football-reliability.md). It is a 0-100 score, not a probability, not the chance the projection is right, and not a betting signal.',
    data_check: 'The NFL model publishes no reliability score. This is the engine’s own input check: both starting quarterbacks named, enough games of team history, and no missing feature.',
    win_prob: 'EdgeDesk’s modelled probability that each team wins the game outright, from the engine’s own margin distribution. It is not a market-implied probability.',
    fair_ml: 'The model moneyline restates EdgeDesk’s win probability as American odds with no margin. It is a mathematical expression of a modelled probability, not a price any sportsbook is offering.',
    fair_spread: 'The point spread at which EdgeDesk’s projection has the two sides even: the projected margin, stated for the favourite.',
    fair_total: 'EdgeDesk’s projected combined points.',
    projected_score: 'Each team’s projected points, split from the fair total and the fair margin so the two always add up to the total and differ by the margin.',
    range80: 'Eight in ten games like this one finish inside this margin range, read off the engine’s own distribution.'
  };

  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function r1(x) { return C.round(x, 1); }
  function r2(x) { return C.round(x, 2); }
  function r4(x) { return C.round(x, 4); }
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function str(x) { return x == null ? '' : String(x); }
  function cap(t) { t = str(t); return t.charAt(0).toUpperCase() + t.slice(1); }
  function possessive(name) { name = str(name); return /s$/i.test(name) ? name + '’' : name + '’s'; }

  /* ------------------------------------------------------------ team identity
     Abbreviations and colours are presentation, never research: NFL from the
     table below (each club's published primary/secondary colours), college
     from the ESPN identity EdgeDesk already holds (the identity table the
     builder passes in). A team with none gets EdgeDesk's neutral steel. */
  S.NFL_TEAMS = {
    ARI: ['ARI', '#97233F', '#FFB612'], ATL: ['ATL', '#A71930', '#000000'], BAL: ['BAL', '#241773', '#9E7C0C'], BUF: ['BUF', '#00338D', '#C60C30'],
    CAR: ['CAR', '#0085CA', '#101820'], CHI: ['CHI', '#0B162A', '#C83803'], CIN: ['CIN', '#FB4F14', '#000000'], CLE: ['CLE', '#311D00', '#FF3C00'],
    DAL: ['DAL', '#003594', '#869397'], DEN: ['DEN', '#FB4F14', '#002244'], DET: ['DET', '#0076B6', '#B0B7BC'], GB: ['GB', '#203731', '#FFB612'],
    HOU: ['HOU', '#03202F', '#A71930'], IND: ['IND', '#002C5F', '#A2AAAD'], JAX: ['JAX', '#006778', '#D7A22A'], KC: ['KC', '#E31837', '#FFB81C'],
    LV: ['LV', '#000000', '#A5ACAF'], LAC: ['LAC', '#0080C6', '#FFC20E'], LA: ['LAR', '#003594', '#FFA300'], LAR: ['LAR', '#003594', '#FFA300'],
    MIA: ['MIA', '#008E97', '#FC4C02'], MIN: ['MIN', '#4F2683', '#FFC62F'], NE: ['NE', '#002244', '#C60C30'], NO: ['NO', '#D3BC8D', '#101820'],
    NYG: ['NYG', '#0B2265', '#A71930'], NYJ: ['NYJ', '#125740', '#FFFFFF'], PHI: ['PHI', '#004C54', '#A5ACAF'], PIT: ['PIT', '#FFB612', '#101820'],
    SF: ['SF', '#AA0000', '#B3995D'], SEA: ['SEA', '#002244', '#69BE28'], TB: ['TB', '#D50A0A', '#34302B'], TEN: ['TEN', '#0C2340', '#4B92DB'],
    WAS: ['WAS', '#5A1414', '#FFB612']
  };
  S.NEUTRAL_COLOR = '#3b4a6b';
  S.NEUTRAL_ALT = '#8aa0c8';
  function hex(c) {
    c = str(c).trim().replace(/^#/, '');
    return /^[0-9a-f]{6}$/i.test(c) ? '#' + c.toLowerCase() : null;
  }
  /* relative luminance (WCAG) of a #rrggbb colour */
  S.luminance = function (c) {
    c = hex(c);
    if (!c) return null;
    var v = [1, 3, 5].map(function (i) {
      var x = parseInt(c.substr(i, 2), 16) / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  };
  /* initials for a team the identity table does not know: never a guess at a
     real abbreviation, only the capitals of its name ("Texas State" → "TS") */
  function initials(name) {
    var w = str(name).replace(/[()'’.]/g, ' ').split(/\s+/).filter(Boolean);
    if (!w.length) return '?';
    if (w.length === 1) return w[0].slice(0, 4).toUpperCase();
    return w.map(function (x) { return x.charAt(0).toUpperCase(); }).join('').slice(0, 4);
  }
  S.teamIdentity = function (league, name, code, idTable) {
    var color = null, alt = null, abbr = null, src = null;
    if (league === 'nfl') {
      var t = S.NFL_TEAMS[str(code).toUpperCase()];
      if (t) { abbr = t[0]; color = t[1]; alt = t[2]; src = 'NFL club colours (EdgeDesk table)'; }
    } else if (idTable) {
      var k = S.teamKey(name), m = idTable[k] || (code ? idTable[str(code)] : null);
      if (m) { abbr = m.abbr || null; color = hex(m.color); alt = hex(m.alt_color); src = m.source || 'ESPN team identity'; }
    }
    color = color || S.NEUTRAL_COLOR;
    alt = alt || S.NEUTRAL_ALT;
    return { abbr: abbr || initials(name), color: color, alt_color: alt, identity_source: src || 'not on file (neutral colours, initials)',
      on_color: S.luminance(color) > 0.45 ? '#0b1020' : '#ffffff' };
  };
  /* the key every football artifact already uses for a team ("Texas A&M" → "texasam") */
  S.teamKey = function (name) { return str(name).toLowerCase().replace(/&/g, '').replace(/[^a-z0-9]/g, ''); };

  /* ------------------------------------------------------------ kickoff */
  var ET = null;
  try { ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short' }); } catch (_) { ET = null; }
  /* "Thu, Oct 15 · 8:00 PM ET" — one fixed zone so a graphic reads the same
     wherever it is made; daylight time is the zone's own. A runtime without
     time-zone data says UTC rather than guessing an offset. */
  S.kickoffText = function (iso, tbd) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return { date: 'Date TBA', time: 'Time TBA', text: 'Date TBA', zone: null };
    var d = new Date(t), p = {};
    if (ET && typeof ET.formatToParts === 'function') ET.formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
    else {
      var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      var hh = d.getUTCHours();
      p = { weekday: DAY[d.getUTCDay()], month: MON[d.getUTCMonth()], day: String(d.getUTCDate()), hour: String(hh % 12 || 12), minute: ('0' + d.getUTCMinutes()).slice(-2), dayPeriod: hh < 12 ? 'AM' : 'PM', timeZoneName: 'UTC' };
    }
    var zone = /^E[DS]T$/.test(p.timeZoneName) ? 'ET' : (p.timeZoneName || 'UTC');
    var date = p.weekday + ', ' + p.month + ' ' + p.day;
    var time = tbd ? 'Time TBA' : (p.hour + ':' + p.minute + ' ' + String(p.dayPeriod || '').toUpperCase() + ' ' + zone);
    return { date: date, time: time, text: date + ' · ' + time, zone: tbd ? null : zone };
  };

  /* ------------------------------------------------------------ the model block */
  function winText(p) {
    if (p == null) return null;
    var v = Math.round(p * 100);
    if (p > 0.99) return '>99%';
    if (p < 0.01) return '<1%';
    return v + '%';
  }
  /* two outcomes shown as whole percents that always add to 100 */
  S.winDisplay = function (pHome) {
    pHome = num(pHome);
    if (pHome == null) return null;
    var h = Math.round(pHome * 100);
    if (pHome > 0.99) return { home: '>99%', away: '<1%', home_pct: 99, away_pct: 1 };
    if (pHome < 0.01) return { home: '<1%', away: '>99%', home_pct: 1, away_pct: 99 };
    h = clamp(h, 1, 99);
    return { home: h + '%', away: (100 - h) + '%', home_pct: h, away_pct: 100 - h };
  };
  /* a probability restated as no-margin American odds */
  S.fairAmerican = function (p) {
    p = num(p);
    if (p == null || p <= 0 || p >= 1) return null;
    var a = p >= 0.5 ? -100 * p / (1 - p) : 100 * (1 - p) / p;
    if (Math.abs(a) > 100000) return null;
    a = Math.round(a);
    if (a > -100 && a < 100) a = a < 0 ? -100 : 100;
    return a;
  };
  /* whole-number scores for a headline (a graphic). Each is the exact
     reconciled score rounded once; when that would tie a game the model does
     not call a tie, or name the other winner, the exact one-decimal scores
     are used instead, so a headline never contradicts the fair line. */
  S.wholeScores = function (sc, margin) {
    if (!sc || !sc.available) return null;
    var h = Math.round(sc.home), a = Math.round(sc.away), m = r1(margin);
    var ok = (m === 0 && h === a) || (m > 0 && h > a) || (m < 0 && a > h);
    if (!ok) return { home: sc.home.toFixed(1), away: sc.away.toFixed(1), whole: false, note: 'shown to one decimal: whole numbers would not name the model’s winner' };
    return { home: String(h), away: String(a), whole: true, note: null };
  };
  function modelBlock(o) {
    var m = num(o.home_margin), t = num(o.total), p = num(o.home_win_prob);
    var out = { available: false, status: o.status || null, reason: o.reason || null, version: o.version || null,
      built_at: o.built_at || null, source: o.source || null };
    if (o.status !== 'PREDICTED' || m == null || t == null || p == null) {
      out.reason = out.reason || (o.status && o.status !== 'PREDICTED' ? 'the model did not project this game (status ' + o.status + ')'
        : (m == null ? 'the projection carries no fair margin' : (t == null ? 'the projection carries no fair total' : 'the projection carries no win probability')));
      return out;
    }
    var names = { home: o.home, away: o.away };
    var fl = C.spread(m, names);
    var sc = C.projectedScores({ home: o.home, away: o.away, home_margin: m, total: t });
    out.available = true;
    out.home_margin = r2(m);
    out.fair = { home_line: fl.book_line_home, text: fl.text, favorite: fl.favorite, favorite_team: fl.favorite_team, near_pickem: fl.near_pickem, display: fl.display };
    out.total = r1(t);
    out.total_exact = r2(t);
    out.scores = { home: sc.home, away: sc.away, decimals: sc.decimals, text: sc.text, note: sc.note };
    out.headline_scores = S.wholeScores(sc, m);
    out.win_prob = { home: r4(p), away: r4(1 - p) };
    out.win_display = S.winDisplay(p);
    var mlH = num(o.fair_home_ml), mlA = num(o.fair_away_ml);
    out.fair_ml = { home: mlH != null ? Math.round(mlH) : S.fairAmerican(p), away: mlA != null ? Math.round(mlA) : S.fairAmerican(1 - p),
      label: 'EdgeDesk model estimate · not a sportsbook price' };
    if (o.range80 && num(o.range80.lo) != null && num(o.range80.hi) != null) {
      var lo = num(o.range80.lo), hi = num(o.range80.hi);
      out.range80 = { lo: r1(lo), hi: r1(hi), text: rangeText(lo, hi, names), basis: o.range80.basis || null };
    }
    if (num(o.sigma) != null) out.sigma = r1(o.sigma);
    out.distribution_basis = o.distribution_basis || null;
    return out;
  }
  /* "Colorado State by 7 to Texas State by 35" from a home-margin range */
  function rangeText(lo, hi, names) {
    function one(v) {
      var r = Math.round(v);
      if (r === 0) return 'a tie';
      return (r > 0 ? names.home : names.away) + ' by ' + Math.abs(r);
    }
    return one(lo) + ' to ' + one(hi);
  }

  /* ------------------------------------------------------------ units
     The measured rankings, one row per unit, both teams on the same metric.
     Rank 1 is the best unit in its league on every row (the artifacts are
     direction-corrected). */
  S.NFL_UNITS = [
    ['overall', 'net_epa', 'Overall efficiency (net EPA/play)'],
    ['offense', 'off_epa_play', 'Offense (EPA/play)'],
    ['defense', 'def_epa_play', 'Defense (EPA/play allowed)'],
    ['pass_offense', 'pass_epa_db', 'Pass offense (EPA/dropback)'],
    ['run_offense', 'rush_epa_att', 'Run offense (EPA/rush)'],
    ['pass_defense', 'def_pass_epa_db', 'Pass defense (EPA/dropback allowed)'],
    ['run_defense', 'def_rush_epa_att', 'Run defense (EPA/rush allowed)'],
    ['pass_protection', 'sack_rate_all', 'Pass protection (sack rate allowed)'],
    ['pass_rush', 'sack_rate_made', 'Pass rush (sack rate)'],
    ['explosive_pass', 'expl_pass', 'Explosive passing'],
    ['explosive_pass_defense', 'def_expl_pass', 'Explosive passes allowed'],
    ['scoring_offense', 'pts_for', 'Scoring offense'],
    ['scoring_defense', 'pts_against', 'Scoring defense']
  ];
  S.CFB_UNITS = [
    ['overall', 'overall', 'EdgeDesk team rating'],
    ['offense', 'offense', 'Offense'],
    ['defense', 'defense', 'Defense'],
    ['run_offense', 'run_offense', 'Run offense'],
    ['pass_offense', 'pass_offense', 'Pass offense'],
    ['run_defense', 'run_defense', 'Run defense'],
    ['pass_defense', 'pass_defense', 'Pass defense'],
    ['special_teams', 'special_teams', 'Special teams'],
    ['qb', 'qb', 'Quarterback room'],
    ['ol', 'ol', 'Offensive line'],
    ['dl', 'dl', 'Defensive line'],
    ['continuity', 'continuity', 'Roster continuity'],
    ['talent', 'talent', 'Roster talent']
  ];
  function unitRows(defs, rankOf) {
    return defs.map(function (d) {
      var h = rankOf('home', d[1]), a = rankOf('away', d[1]);
      if (!h && !a) return null;
      return { key: d[0], home: h, away: a };
    }).filter(Boolean);
  }
  /* a unit row's label, from the league's table (not stored per game) */
  S.unitLabel = function (league, key) {
    var defs = league === 'nfl' ? S.NFL_UNITS : S.CFB_UNITS;
    for (var i = 0; i < defs.length; i++) if (defs[i][0] === key) return defs[i][2];
    return key;
  };

  /* ------------------------------------------------------------ drivers */
  S.NFL_TERM_LABELS = {
    baseline: 'Home field (the model’s fitted intercept)', net_pts: 'Scoring margin', net_epa: 'Overall efficiency (EPA/play)',
    net_pass: 'Passing efficiency', net_rush: 'Rushing efficiency', qb_adj_diff: 'Quarterback adjustment', rest_diff: 'Rest difference',
    div_game: 'Division game', home_short: 'Home team on a short week', away_short: 'Away team on a short week',
    home_off_bye: 'Home team off a bye', away_off_bye: 'Away team off a bye'
  };
  function nflDrivers(g, names) {
    var rows = ((g.contributions && g.contributions.spread) || []).filter(function (c) { return c && num(c.points) != null && Math.abs(c.points) >= 0.05; });
    if (!rows.length) return null;
    var out = rows.map(function (c) {
      var pts = num(c.points);
      return { key: c.key, label: S.NFL_TERM_LABELS[c.key] || c.key, points: r2(Math.abs(pts)), favors: pts > 0 ? 'home' : 'away', favors_team: pts > 0 ? names.home : names.away };
    }).sort(function (a, b) { return b.points - a.points || (a.key < b.key ? -1 : 1); });
    var sum = rows.reduce(function (s, c) { return s + num(c.points); }, 0);
    return { rows: out, reconciles: Math.abs(sum - num(g.model_home_margin)) < 0.05, basis: 'nfl_linear_terms' };
  }
  S.DRIVER_BASIS = {
    nfl_linear_terms: 'The terms of EdgeDesk’s linear NFL spread model (football/engine.js). Quarterback-regime and other post-model adjustments are applied after them, so they need not add up to the final margin.',
    cfb_engine_terms: 'The college engine’s additive terms (football/cfb_p4/engine.js projectGame contributions); they sum exactly to the projected margin.',
    cfb_mismatch: 'The research terminal’s driver breakdown was built from a different projection, so it is not shown with this snapshot.'
  };
  function cfbDrivers(term, slateMargin, names) {
    var why = term && term.why;
    if (!why || !why.available || !why.rows) return null;
    var final = num(why.final_margin);
    /* the terms come from the terminal build; they are used only when that
       build projected the SAME margin as the slate this snapshot is taken from */
    if (final == null || Math.abs(final - slateMargin) > 0.01) return { rows: [], reconciles: false, mismatch: true, basis: 'cfb_mismatch' };
    var out = why.rows.filter(function (r) { return r && r.available !== false && num(r.points) != null && Math.abs(r.points) >= 0.05; }).map(function (r) {
      var side = r.favors === names.home ? 'home' : (r.favors === names.away ? 'away' : null);
      return { key: r.key, label: r.label, points: r2(Math.abs(num(r.points))), favors: side, favors_team: r.favors || null };
    }).sort(function (a, b) { return b.points - a.points || (a.key < b.key ? -1 : 1); });
    return { rows: out, reconciles: why.reconciles === true, basis: 'cfb_engine_terms', unpriced: (why.unpriced || []).slice(0, 6) };
  }

  /* ------------------------------------------------------------ insights
     Candidates are built only from numbers on the snapshot; each carries its
     evidence and a strength in [0, 1] (the share of the league a rank gap
     spans, or the share of the projected margin a term explains). The
     strongest one per family is kept, at most four. */
  S.ICONS = ['bars', 'run', 'ball', 'shield', 'home', 'helmet', 'people', 'bolt', 'cloud', 'alert', 'clock'];
  function teamOf(snap, side) { return side === 'home' ? snap.home.name : snap.away.name; }
  function shortOf(snap, side) { var t = side === 'home' ? snap.home : snap.away; return t.short || t.name; }
  function other(side) { return side === 'home' ? 'away' : 'home'; }
  function unit(snap, key) { var u = (snap.units && snap.units.rows) || []; for (var i = 0; i < u.length; i++) if (u[i].key === key) return u[i]; return null; }
  function rk(x) { return x && num(x.rank) != null ? x.rank : null; }
  S.insights = function (snap) {
    var c = [], N = snap.units ? snap.units.of : null, L = snap.league;
    function push(x) { if (x && x.strength > 0) c.push(x); }
    function pairing(offKey, defKey, family, icon, title, offWord, defWord, minGap) {
      ['home', 'away'].forEach(function (s) {
        var o = unit(snap, offKey), d = unit(snap, defKey);
        if (!o || !d) return;
        var ro = rk(o[s]), rd = rk(d[other(s)]);
        var nO = (o[s] && o[s].of) || N, nD = (d[other(s)] && d[other(s)].of) || N;
        if (ro == null || rd == null || !nO || !nD) return;
        /* the attacker's advantage, in league shares: a top unit meeting a
           bottom unit spans most of the league */
        var adv = (rd / nD) - (ro / nO);
        var A = teamOf(snap, s), B = teamOf(snap, other(s));
        /* strength on strength: both units in the top tenth of the league */
        if (minGap == null && ro / nO <= 0.1 && rd / nD <= 0.1) {
          push({ id: family + '_clash_' + s, family: family, icon: icon, title: 'STRENGTH ON STRENGTH', team: null,
            short: possessive(shortOf(snap, s)) + ' ' + offWord + ' (#' + ro + ') vs ' + possessive(shortOf(snap, other(s))) + ' ' + defWord + ' (#' + rd + ')',
            text: 'Two of the best units in the ' + (L === 'nfl' ? 'league' : 'country') + ' meet: ' + possessive(A) + ' ' + offWord + ' (#' + ro + ' of ' + nO + ') against ' + possessive(B) + ' ' + defWord + ' (#' + rd + ' of ' + nD + ').',
            strength: r4(0.45 - (ro / nO + rd / nD)), evidence: { ranks: [ro, rd], of: [nO, nD], units: [offKey, defKey] } });
          return;
        }
        if (adv < (minGap == null ? S.CONFIG.unit_gap_share : minGap)) return;
        var size = adv >= 0.6 ? 'one of the widest measured gaps in this matchup' : (adv >= 0.4 ? 'a clear measured gap' : 'a measured gap');
        push({ id: family + '_' + s, family: family, icon: icon, title: title, team: s,
          short: possessive(shortOf(snap, s)) + ' ' + offWord + ' (#' + ro + ') vs ' + possessive(shortOf(snap, other(s))) + ' ' + defWord + ' (#' + rd + ')',
          text: possessive(A) + ' ' + offWord + ' (#' + ro + ' of ' + nO + ') faces ' + possessive(B) + ' ' + defWord + ' (#' + rd + ' of ' + nD
            + '): ' + size + ', in ' + possessive(A) + ' favour.',
          strength: r4(clamp(adv, 0, 1)), evidence: { ranks: [ro, rd], of: [nO, nD], units: [offKey, defKey] } });
      });
    }
    pairing('run_offense', 'run_defense', 'run', 'run', 'RUN GAME EDGE', 'run offense', 'run defense');
    pairing('pass_offense', 'pass_defense', 'pass', 'ball', 'PASSING EDGE', 'pass offense', 'pass defense');
    if (L === 'nfl') pairing('pass_rush', 'pass_protection', 'trenches', 'shield', 'PASS RUSH EDGE', 'pass rush', 'pass protection');
    else pairing('ol', 'dl', 'trenches', 'shield', 'LINE OF SCRIMMAGE', 'offensive line', 'defensive line');

    var D = snap.drivers && snap.drivers.rows ? snap.drivers.rows : [], M = snap.model.available ? Math.abs(snap.model.home_margin) : null;
    function term(key) { for (var i = 0; i < D.length; i++) if (D[i].key === key) return D[i]; return null; }
    var ov = unit(snap, 'overall');

    /* TEAM STRENGTH. College: the projection's own team-strength term (its
       neutral-field rating edge, which reconciles to the margin). NFL: the
       overall-efficiency ranks the slate publishes. */
    var rt = L === 'cfb' ? term('rating') : null;
    if (rt && rt.points < 1.5) {
      push({ id: 'strength', family: 'strength', icon: 'bars', title: 'EVEN ON PAPER', team: null,
        short: 'Neutral-field strength within ' + Math.max(rt.points, 0.1).toFixed(1) + ' pts',
        text: 'On a neutral field the projection rates these teams within ' + Math.max(rt.points, 0.1).toFixed(1) + ' points of each other (its opponent-adjusted team-strength term), so venue and matchup decide the number.',
        strength: 0.3, evidence: { points: rt.points, term: 'rating' } });
    } else if (rt && rt.favors) {
      var rkTxt = ov && rk(ov[rt.favors]) != null && rk(ov[other(rt.favors)]) != null ? ' EdgeDesk’s power rankings have them #' + ov[rt.favors].rank + ' and #' + ov[other(rt.favors)].rank + ' of ' + N + '.' : '';
      push({ id: 'strength', family: 'strength', icon: 'bars', title: 'TEAM STRENGTH', team: rt.favors,
        short: shortOf(snap, rt.favors) + ' +' + rt.points.toFixed(1) + ' pts on a neutral field',
        text: rt.favors_team + ' is the stronger team by ' + rt.points.toFixed(1) + ' points on a neutral field (the projection’s opponent-adjusted team-strength term).' + rkTxt,
        strength: r4(clamp(rt.points / Math.max(M || 0, 7), 0, 1) * 0.95), evidence: { points: rt.points, term: 'rating' } });
    } else if (ov && rk(ov.home) != null && rk(ov.away) != null && N) {
      var better = ov.home.rank < ov.away.rank ? 'home' : 'away', w = ov[better], l = ov[other(better)];
      push({ id: 'strength', family: 'strength', icon: 'bars', title: 'TEAM STRENGTH', team: better,
        short: shortOf(snap, better) + ' #' + w.rank + ' vs #' + l.rank + ' in ' + (L === 'nfl' ? 'overall efficiency' : 'team rating'),
        text: teamOf(snap, better) + ' ranks #' + w.rank + ' in ' + (L === 'nfl' ? 'overall efficiency (net EPA per play)' : 'EdgeDesk’s team rating') + '; ' + teamOf(snap, other(better)) + ' ranks #' + l.rank + ' of ' + N + '.',
        strength: r4(clamp((l.rank - w.rank) / N, 0, 1) * 0.9), evidence: { ranks: [w.rank, l.rank], of: N, units: ['overall'] } });
    }

    /* the model's other large terms, and home field when the model prices it */
    D.forEach(function (d) {
      if (!d.favors) return;
      if (d.key === 'hfa' || d.key === 'baseline') {
        if (d.favors !== 'home' || snap.neutral_site) return;
        var hm = snap.model.home_margin, flips = hm > 0 && d.points > hm + 0.05;
        push({ id: 'home_field', family: 'home', icon: 'home', title: flips ? 'HOME FIELD DECIDES IT' : 'HOME FIELD', team: 'home',
          short: shortOf(snap, 'home') + ' +' + d.points.toFixed(1) + ' pts for playing at home' + (flips ? ', more than the projected margin' : ''),
          text: 'Home field is worth ' + d.points.toFixed(1) + ' points to ' + snap.home.name + ' in EdgeDesk’s ' + (L === 'nfl' ? 'NFL spread model (its fitted intercept)' : 'projection (the engine’s home-field term)') + '.'
            + (flips ? ' That is more than the projected margin of ' + hm.toFixed(1) + ': without it, the projection would lean ' + snap.away.name + ' by ' + (d.points - hm).toFixed(1) + '.' : ''),
          strength: r4(clamp(d.points / Math.max(M || 0, 7), 0, 1) * (flips ? 0.8 : 0.6)), evidence: { points: d.points, term: d.key, margin: hm } });
        return;
      }
      if (d.key === 'rating' || d.key === 'net_pts' || d.key === 'net_epa') return; /* that is the strength insight */
      if (d.points < 1) return; /* under a point is not a story */
      var icon = d.key === 'qb' || d.key === 'qb_adj_diff' ? 'helmet' : (d.key === 'net_rush' ? 'run' : (d.key === 'net_pass' ? 'ball' : (d.key === 'rest_diff' || d.key === 'schedule' ? 'clock' : 'bars')));
      push({ id: 'term_' + d.key, family: 'model_' + d.key, icon: icon, title: String(d.label).toUpperCase(), team: d.favors,
        short: d.label + ': +' + d.points.toFixed(1) + ' pts toward ' + shortOf(snap, d.favors),
        text: d.label + ' moves EdgeDesk’s number ' + d.points.toFixed(1) + ' points toward ' + d.favors_team + ', one of the larger terms in the projection.',
        strength: r4(clamp(d.points / Math.max(M || 0, 7), 0, 1) * 0.7), evidence: { points: d.points, term: d.key } });
    });

    /* roster continuity and special teams (college rankings) */
    [['continuity', 'continuity', 'people', 'ROSTER CONTINUITY', 'roster continuity'], ['special_teams', 'special', 'bolt', 'SPECIAL TEAMS', 'special teams']].forEach(function (x) {
      var u = unit(snap, x[0]);
      if (!u || rk(u.home) == null || rk(u.away) == null) return;
      var n = (u.home.of || N), better = u.home.rank < u.away.rank ? 'home' : 'away';
      var share = Math.abs(u.home.rank - u.away.rank) / n;
      if (share < 0.4) return;
      push({ id: x[1], family: x[1], icon: x[2], title: x[3], team: better,
        short: shortOf(snap, better) + ' #' + u[better].rank + ' vs #' + u[other(better)].rank + ' in ' + x[4],
        text: teamOf(snap, better) + ' ranks #' + u[better].rank + ' in ' + x[4] + '; ' + teamOf(snap, other(better)) + ' ranks #' + u[other(better)].rank + ' of ' + n + '.',
        strength: r4(share * 0.55), evidence: { ranks: [u[better].rank, u[other(better)].rank], of: n, units: [x[0]] } });
    });

    /* quarterback: only a real question (no starter named, two sources that
       disagree, a contested job). An unannounced college starter who started
       the last game is the normal state of college football, not an insight. */
    var q = snap.qb || {};
    ['home', 'away'].forEach(function (s) {
      var x = q[s];
      if (!x || x.confirmed) return;
      var st = String(x.status || ''), competition = /COMPETITION|CONTEST/i.test(st) || x.contested === true, conflict = /DISAGREE|CONFLICT/i.test(st);
      if (x.name && !conflict && !competition) return;
      push({ id: 'qb_' + s, family: 'qb', icon: 'helmet', title: competition ? 'QB COMPETITION' : 'QB WATCH', team: null,
        short: !x.name ? possessive(shortOf(snap, s)) + ' starter not named'
          : (competition ? possessive(shortOf(snap, s)) + ' QB job is contested (' + x.name + ' listed)' : possessive(shortOf(snap, s)) + ' starter in question (' + x.name + ' expected)'),
        text: !x.name ? 'No starting quarterback is named for ' + teamOf(snap, s) + ' yet, so the projection carries the team’s usual level.'
          : (competition ? possessive(teamOf(snap, s)) + ' quarterback job is a competition on the latest read; the projection assumes ' + x.name + '.'
            : 'The sources disagree on ' + possessive(teamOf(snap, s)) + ' starting quarterback; the projection assumes ' + x.name + '.'),
        strength: x.name ? 0.35 : 0.2, evidence: { status: x.status || null } });
    });

    /* weather, only from a forecast on file with its time */
    var wx = snap.weather;
    if (wx && wx.material) push({ id: 'weather', family: 'weather', icon: 'cloud', title: 'WEATHER', team: null, short: wx.short, text: wx.text, strength: 0.25,
      evidence: { as_of: wx.as_of } });

    function pick() {
      c.sort(function (a, b) { return b.strength - a.strength || (a.id < b.id ? -1 : 1); });
      var fam = {}, out = [];
      c.forEach(function (x) { if (out.length >= S.CONFIG.max_insights || fam[x.family]) return; fam[x.family] = 1; out.push(x); });
      return out;
    }
    var out = pick();
    /* fewer than three: a second, relaxed pass over the same measured units
       (smaller gaps, and whole offense against whole defense). Still only
       numbers on the snapshot; never filler. */
    if (out.length < S.CONFIG.min_insights) {
      var half = S.CONFIG.unit_gap_share / 2;
      pairing('run_offense', 'run_defense', 'run', 'run', 'RUN GAME', 'run offense', 'run defense', half);
      pairing('pass_offense', 'pass_defense', 'pass', 'ball', 'PASSING GAME', 'pass offense', 'pass defense', half);
      pairing('offense', 'defense', 'offense', 'bars', 'OFFENSE VS DEFENSE', 'offense', 'defense', half);
      out = pick();
    }
    return out;
  };

  /* ------------------------------------------------------------ checks */
  S.checks = function (snap) {
    var items = [], M = snap.model;
    function add(id, ok, detail) { items.push({ id: id, ok: !!ok, detail: detail || null }); }
    if (!M.available) {
      return { ok: false, passed: [], failed: [{ id: 'projection_present', detail: M.reason }] };
    }
    var rc = C.scoresReconcile(M.scores.home, M.scores.away, M.home_margin, M.total, M.scores.decimals);
    add('scores_reconcile', rc.ok, rc.ok ? 'projected scores add to the fair total and differ by the fair margin' : rc.reason);
    var hs = M.headline_scores;
    if (hs && hs.whole) {
      var dh = Number(hs.home) - Number(hs.away), st = Number(hs.home) + Number(hs.away);
      var tol = S.CONFIG.whole_score_tolerance;
      var ok = Math.abs(dh - M.home_margin) <= tol + 1e-9 && Math.abs(st - M.total) <= tol + 1e-9;
      add('headline_scores_within_tolerance', ok, 'whole-number scores ' + hs.home + '–' + hs.away + ' vs fair margin ' + M.home_margin + ' and total ' + M.total + ' (tolerance ±' + tol + ')');
    }
    var ps = M.win_prob.home + M.win_prob.away;
    add('win_probabilities_sum', Math.abs(ps - 1) < 1e-3, 'home ' + M.win_prob.home + ' + away ' + M.win_prob.away);
    var wd = M.win_display;
    add('win_display_sums_100', wd && wd.home_pct + wd.away_pct === 100, wd ? wd.home + ' + ' + wd.away : 'no display');
    var fav = r1(M.home_margin);
    add('winner_agrees', fav === 0 || (fav > 0) === (M.win_prob.home > 0.5), 'fair margin ' + fav + ', home win probability ' + M.win_prob.home);
    var mlOk = true;
    ['home', 'away'].forEach(function (s) {
      var a = M.fair_ml[s];
      if (a == null) return;
      var imp = C.impliedFromAmerican(a);
      if (imp == null || Math.abs(imp - M.win_prob[s]) > 0.01) mlOk = false;
    });
    add('model_moneyline_restates_probability', mlOk, 'model moneyline ' + M.fair_ml.home + ' / ' + M.fair_ml.away);
    add('total_plausible', M.total >= 20 && M.total <= 110, 'fair total ' + M.total);
    if (M.range80) add('range_contains_projection', M.range80.lo < M.range80.hi && M.range80.lo <= M.home_margin + 0.5 && M.home_margin - 0.5 <= M.range80.hi,
      '80% range ' + M.range80.lo + ' to ' + M.range80.hi + ' around a fair margin of ' + M.home_margin);
    var bad = ((snap.units && snap.units.rows) || []).filter(function (u) {
      return ['home', 'away'].some(function (s) { var x = u[s]; return x && (x.rank < 1 || (x.of && x.rank > x.of)); });
    });
    add('ranks_in_range', !bad.length, bad.length ? bad.map(function (u) { return u.key; }).join(', ') : 'every rank sits inside its league');
    /* compact: the ids that passed, and the failures with their detail */
    return { ok: items.every(function (x) { return x.ok; }), passed: items.filter(function (x) { return x.ok; }).map(function (x) { return x.id; }),
      failed: items.filter(function (x) { return !x.ok; }).map(function (x) { return { id: x.id, detail: x.detail }; }) };
  };

  /* the scoring distribution from the probability sheet built on the SAME
     slate (lib/edgedesk_fairline.js): the total's and each team's 80%
     range, the margin's where the sheet publishes one, and the method and
     held-out status of each. A sheet from another projection is ignored. */
  function distribution(s, sh) {
    if (!sh || !s.model.available) return null;
    var c = sh.centres && sh.centres.raw;
    if (!c || Math.abs(num(c.home_margin) - s.model.home_margin) > 0.01 || Math.abs(num(c.total) - s.model.total_exact) > 0.05) return null;
    var M = sh.markets || {}, out = { basis: 'lib/edgedesk_fairline.js on the same slate', markets: {} };
    function meta(k) { var m = M[k]; return m ? { method: m.method || null, status: m.status || null, tier: m.tier || null } : null; }
    if (M.total && num(M.total.total_p10) != null) out.total = { fair: r1(M.total.fair_total), p10: r1(M.total.total_p10), p90: r1(M.total.total_p90), sd: r1(M.total.total_sd) };
    if (M.team_total && num(M.team_total.home_p10) != null) {
      out.home_points = { fair: r1(M.team_total.home_fair), p10: r1(M.team_total.home_p10), p90: r1(M.team_total.home_p90) };
      out.away_points = { fair: r1(M.team_total.away_fair), p10: r1(M.team_total.away_p10), p90: r1(M.team_total.away_p90) };
    }
    if (M.spread && num(M.spread.margin_p10) != null) out.margin = { p10: r1(M.spread.margin_p10), p90: r1(M.spread.margin_p90), sd: r1(M.spread.margin_sd) };
    ['spread', 'total', 'moneyline', 'team_total'].forEach(function (k) { var x = meta(k); if (x) out.markets[k] = x; });
    return out.total || out.home_points || out.margin ? out : null;
  }

  /* ------------------------------------------------------------ assembly */
  function finish(s) {
    s.insights = s.model.available ? S.insights(s) : [];
    s.checks = S.checks(s);
    var faults = s.model.available ? s.checks.failed.map(function (x) { return x.id + (x.detail ? ': ' + x.detail : ''); }) : [];
    var limited = (s.data.warnings || []).length > 0;
    if (!s.model.available) s.data.status = 'UNAVAILABLE';
    else if (faults.length) { s.data.status = 'FAULT'; s.data.faults = faults; }
    else if (limited || (s.confidence.kind === 'reliability' && num(s.confidence.score) != null && s.confidence.score < S.CONFIG.reliability_limited)) s.data.status = 'LIMITED';
    else s.data.status = 'OK';
    /* the id is the content: the same numbers give the same id on every build */
    s.snapshot_id = S.snapshotId(s);
    return s;
  }
  /* the id is the hash of everything the snapshot says, minus the fields a
     build adds around it (its clock, the history trail, whether its sheet
     matched, and the started/frozen marks a game gets after kickoff) */
  S.ID_EXCLUDES = ['snapshot_id', 'generated_at', 'history', 'sources', 'probability_sheet', 'started', 'frozen_at'];
  S.snapshotId = function (s) {
    var body = {}; Object.keys(s).forEach(function (k) { if (S.ID_EXCLUDES.indexOf(k) < 0) body[k] = s[k]; });
    return 'gr1-' + C.fingerprint(body);
  };
  function base(league, o) {
    var k = S.kickoffText(o.kickoff, o.kickoff_tbd);
    return {
      schema: S.SCHEMA, version: S.VERSION, snapshot_id: null, generated_at: o.generated_at || null,
      league: league, game_id: String(o.game_id), game_key: league + '|' + o.game_id,
      season: num(o.season), week: num(o.week), week_label: o.week_label || (num(o.week) != null ? 'Week ' + num(o.week) : null),
      kickoff: o.kickoff || null, kickoff_tbd: !!o.kickoff_tbd, kickoff_text: k,
      venue: o.venue || null, neutral_site: !!o.neutral_site, context: o.context || null,
      home: o.home, away: o.away
    };
  }
  function record(r) {
    if (!r) return null;
    var w = num(r.w), l = num(r.l), t = num(r.t);
    if (r.text) return { text: String(r.text), as_of: r.as_of || null, source: r.source || null };
    if (w == null || l == null) return null;
    return { text: w + '-' + l + (t ? '-' + t : ''), as_of: r.as_of || null, source: r.source || null };
  }
  function side(name, league, code, ctx, rec, poll) {
    var id = S.teamIdentity(league, name, code, ctx.identity);
    /* the short name a graphic line can hold: an NFL club's nickname, a school's name */
    var short = league === 'nfl' ? str(name).split(' ').slice(-1)[0] : name;
    var out = { name: name, short: short, key: S.teamKey(name), code: code || null, abbr: id.abbr, color: id.color, alt_color: id.alt_color, on_color: id.on_color,
      identity_source: id.identity_source, record: record(rec) };
    /* a poll rank only as the feed published it, with its source and time */
    if (poll && num(poll.rank) != null) out.poll_rank = { rank: num(poll.rank), source: poll.source || null, as_of: poll.as_of || null };
    return out;
  }

  /* g: a game from football/nfl/slate.json. ctx: { teams (slate.teams),
     generated_at, source, identity, records{CODE:{w,l,t,as_of}} } */
  S.fromNfl = function (g, ctx) {
    ctx = ctx || {};
    var home = g.home_team, away = g.away_team;
    var recs = ctx.records || {};
    var s = base('nfl', {
      game_id: g.game_id, kickoff: g.kickoff, season: g.season, week: g.week,
      week_label: g.game_type && g.game_type !== 'REG' ? String(g.game_type) : null,
      venue: g.venue, neutral_site: !!(g.contributions && g.contributions.spread && g.contributions.spread.some(function (c) { return c.key === 'baseline' && num(c.points) === 0; })),
      context: g.div_game ? 'Division game' : null, generated_at: ctx.generated_at,
      home: side(home, 'nfl', g.home_code, ctx, recs[g.home_code], (ctx.polls || {}).home), away: side(away, 'nfl', g.away_code, ctx, recs[g.away_code], (ctx.polls || {}).away)
    });
    var range = g.outcome_range && num(g.outcome_range.p10) != null ? { lo: g.outcome_range.p10, hi: g.outcome_range.p90, basis: g.outcome_range.basis } : null;
    s.model = modelBlock({ status: g.model_status, reason: g.model_reason, home: home, away: away, home_margin: g.model_home_margin, total: g.model_fair_total,
      home_win_prob: g.model_home_win_prob, fair_home_ml: g.model_fair_home_ml, fair_away_ml: g.model_fair_away_ml, range80: range,
      sigma: g.outcome_range && g.outcome_range.sigma, distribution_basis: 'the engine’s learned NFL margin distribution (margin PMF by spread)',
      version: g.model_version, built_at: ctx.generated_at, source: ctx.source || 'football/nfl/slate.json' });
    var dq = g.data_quality || {};
    s.confidence = { kind: 'data_check', score: null, grade: dq.status || null,
      label: 'Data check: ' + (dq.status === 'OK' ? 'complete' : (dq.status || 'unknown').toLowerCase()),
      detail: (dq.warnings || []).slice(0, 4) };
    s.data = { status: null, warnings: (dq.warnings || []).slice(0, 6).map(String), faults: [] };
    /* units: the slate's own ranks, one build */
    var T = ctx.teams || {};
    s.units = { of: 32, source: ctx.source || 'football/nfl/slate.json', as_of: ctx.generated_at || null,
      rows: unitRows(S.NFL_UNITS, function (sd, key) {
        var t = T[sd === 'home' ? g.home_code : g.away_code], x = t && t.ranks && t.ranks[key];
        return x && num(x.rank) != null ? { rank: x.rank, of: num(x.of) || 32 } : null;
      }) };
    s.strength = null; /* the NFL slate publishes no neutral-field rating in points */
    s.drivers = nflDrivers(g, { home: home, away: away });
    var st = g.starter_check || {};
    function qb(sd) {
      var x = g[sd + '_starter'], chk = st[sd] || {};
      if (!x) return null;
      var conf = chk.status === 'AGREES' || chk.status === 'RECONCILED' || x.status === 'CONFIRMED';
      return { name: x.player_name || null, status: chk.status || x.status || null, confirmed: !!(x.player_name && conf),
        basis: chk.status === 'AGREES' ? 'schedule feed and depth chart agree' : (chk.status ? 'starter check: ' + String(chk.status).toLowerCase() : null),
        source: x.source || null, as_of: chk.depth_chart && chk.depth_chart.published_at || null };
    }
    s.qb = { home: qb('home'), away: qb('away') };
    var f = g.forecast;
    s.weather = null;
    if (f && !f.dome && String(g.roof || '').toLowerCase() === 'outdoors' && num(f.wind_mph) != null) {
      var wind = num(f.wind_mph), temp = num(f.temp_f), material = wind >= 15 || (temp != null && temp <= 32) || num(f.precip_pct) >= 60;
      s.weather = { material: !!material, short: Math.round(temp) + '°F, wind ' + Math.round(wind) + ' mph' + (f.text ? ', ' + String(f.text).toLowerCase() : ''),
        text: 'Kickoff forecast: ' + Math.round(temp) + '°F with ' + Math.round(wind) + ' mph wind' + (f.text ? ' (' + String(f.text).toLowerCase() + ')' : '') + '.',
        source: f.source || 'forecast', as_of: f.as_of || null };
    }
    s.scenarios = g.scenarios ? Object.keys(g.scenarios).map(function (k) {
      var x = g.scenarios[k];
      return { key: k, home_line: num(x.home_line), delta_home_line: num(x.delta_home_line), total: num(x.total), home_win_prob: num(x.home_win_prob) };
    }) : [];
    /* the slate's nflverse reference line is a market number: it is Layer B and stays out of the snapshot */
    s.distribution = distribution(s, ctx.sheet);
    return finish(s);
  };

  /* g: a game from football/fbs/slate.json. ctx: { terminal (that game in
     football/cfb_terminal/games.json), rankings (current.json teams map),
     rankings_as_of, team_count, identity, records{key:{text,as_of}}, generated_at, source } */
  S.fromCfb = function (g, ctx) {
    ctx = ctx || {};
    var home = g.home_team, away = g.away_team, term = ctx.terminal || null;
    var recs = ctx.records || {};
    var conf = g.is_conference_game && g.home_conference ? g.home_conference + ' conference game'
      : (g.home_conference && g.away_conference ? g.away_conference + ' vs ' + g.home_conference : null);
    var s = base('cfb', {
      game_id: g.game_id, kickoff: g.kickoff, kickoff_tbd: !!g.kickoff_tbd, season: g.season, week: g.week,
      venue: g.venue, neutral_site: !!g.neutral_site, context: conf, generated_at: ctx.generated_at,
      home: side(home, 'cfb', g.home_team_id, ctx, recs[g.home_team_id] || recs[S.teamKey(home)], (ctx.polls || {}).home),
      away: side(away, 'cfb', g.away_team_id, ctx, recs[g.away_team_id] || recs[S.teamKey(away)], (ctx.polls || {}).away)
    });
    var E = term && term.edgedesk && term.edgedesk.available ? term.edgedesk : null;
    var sameRun = !!(E && Math.abs(num(E.home_margin) - num(g.model_home_margin)) <= 0.01 && Math.abs(num(E.fair_total) - num(g.model_fair_total)) <= 0.05);
    var q = sameRun && E.quantiles ? E.quantiles : null;
    s.model = modelBlock({ status: g.model_status, reason: g.model_reason, home: home, away: away, home_margin: g.model_home_margin,
      total: g.model_fair_total, home_win_prob: g.model_home_win_prob, range80: q ? { lo: q.p10, hi: q.p90, basis: E.distribution_basis } : null,
      sigma: sameRun ? E.sigma : null, distribution_basis: sameRun ? E.distribution_basis : null,
      version: g.model_version || (E && E.model_version) || 'edgedesk_cfb_p4', built_at: (g.freshness && g.freshness.model_built_at) || ctx.generated_at,
      source: ctx.source || 'football/fbs/slate.json' });
    var rel = g.reliability || {};
    var score = num(g.reliability_score), grade = g.reliability_grade || rel.grade || null;
    s.confidence = { kind: 'reliability', score: score, grade: grade,
      label: score != null ? 'Reliability ' + Math.round(score) + '/100' + (grade ? ' · ' + String(grade).replace(/_/g, ' ') : '') : 'Reliability not scored',
      main_deduction: rel.main_deduction || (term && term.data_quality && term.data_quality.main_deduction) || null };
    s.data = { status: null, warnings: [], faults: [] };
    if (term && !sameRun) s.data.warnings.push('The research terminal’s detail was built from an earlier projection; its drivers and range are left out of this snapshot.');
    if (score != null && score < S.CONFIG.reliability_limited) s.data.warnings.push('Reliability ' + Math.round(score) + '/100: ' + (s.confidence.main_deduction || 'the inputs under this projection are incomplete'));
    /* units: the ratings build, one as-of */
    var R = ctx.rankings || {}, ofBy = ctx.rank_counts || {};
    s.units = { of: num(ctx.team_count) || null, source: 'football/rankings/current.json', as_of: ctx.rankings_as_of || null, label: ctx.units_label || null,
      rows: unitRows(S.CFB_UNITS, function (sd, key) {
        var t = R[sd === 'home' ? g.home_team_id : g.away_team_id], x = t && t.ranks && t.ranks[key];
        if (!x || x.unranked || num(x.rank) == null) return null;
        return { rank: x.rank, of: num(ofBy[key]) || num(ctx.team_count) || null, value: num(x.value) };
      }) };
    var th = R[g.home_team_id], ta = R[g.away_team_id];
    s.strength = th && ta && num(th.etsr) != null && num(ta.etsr) != null
      ? { neutral_gap: r1(num(th.etsr) - num(ta.etsr)), home_rating: r2(th.etsr), away_rating: r2(ta.etsr),
        basis: 'EdgeDesk team strength ratings (ETSR): their difference is a neutral-field spread; home field is applied by the matchup layer, not the rating' }
      : null;
    if (s.strength && s.strength.neutral_gap < 0) s.strength.neutral_gap = Math.abs(s.strength.neutral_gap);
    s.drivers = sameRun ? cfbDrivers(term, num(g.model_home_margin), { home: home, away: away }) : null;
    var tq = term && term.qb ? term.qb : null;
    function qb(sd) {
      var x = g[sd + '_starter'], t = tq && tq[sd];
      if (!x && !t) return null;
      var name = (x && x.player_name) || (t && t.player) || null;
      var confirmed = !!((x && x.confirmed) || (t && t.confirmed));
      return { name: name, status: (x && x.status) || (t && t.status) || null, confirmed: confirmed, contested: !!(t && t.contested),
        basis: t && t.label ? t.label.replace(/^[^—]*—\s*/, '').replace(/\.\s*$/, '') : null, source: (x && x.source) || (t && t.source) || null,
        as_of: (x && (x.published_at || x.retrieved_at)) || (t && t.as_of) || null };
    }
    s.qb = { home: qb('home'), away: qb('away') };
    s.weather = null;
    s.risks = sameRun && term.risks && term.risks.items ? term.risks.items.filter(function (r) { return r.severity !== 'context'; }).slice(0, 3).map(function (r) {
      var t = str(r.text).replace(/\s+,?\s*\.$/, '.');
      return { severity: r.severity, text: t.length > 220 ? t.slice(0, 217) + '…' : t };
    }) : [];
    s.scenarios = [];
    s.distribution = distribution(s, ctx.sheet);
    return finish(s);
  };

  /* ------------------------------------------------------------ Layer B
     The reader's market, normalised. input:
       { home_line (book convention, negative = home favoured), total,
         ml_home, ml_away, book, books, captured_at, stale, kind, source,
         verified, fault, manual, reference_only }
     State: LIVE (fresh, captured from a named book or consensus) /
     CACHED (≤72 h, not fresh) / STALE (older) / MANUAL (typed by a person) /
     REFERENCE (an untimed reference line, never a price) / FAULT /
     UNAVAILABLE. Only LIVE may be shown as a current market. */
  S.market = function (x, opts) {
    opts = opts || {};
    var now = num(opts.now) || Date.now();
    var out = { state: 'UNAVAILABLE', label: 'Unavailable', current: false, home_line: null, total: null, ml_home: null, ml_away: null,
      book: null, books: null, captured_at: null, age_minutes: null, source: null, verified: false, reason: null };
    if (!x) { out.reason = 'no sportsbook quote is on file for this game'; return out; }
    var hl = num(x.home_line), tot = num(x.total);
    out.home_line = hl; out.total = tot; out.ml_home = num(x.ml_home); out.ml_away = num(x.ml_away);
    out.book = x.book || null; out.books = num(x.books); out.captured_at = x.captured_at || null; out.source = x.source || x.kind || null;
    out.verified = x.verified === true;
    var at = Date.parse(x.captured_at);
    out.age_minutes = isFinite(at) ? Math.max(0, Math.round((now - at) / 60000)) : null;
    if (x.fault) { out.state = 'FAULT'; out.label = 'Market fault'; out.reason = String(x.fault); out.home_line = out.total = out.ml_home = out.ml_away = null; return out; }
    if (hl == null && tot == null && out.ml_home == null) { out.reason = 'no sportsbook quote is on file for this game'; return out; }
    if (x.manual) { out.state = 'MANUAL'; out.label = 'User-entered'; out.reason = 'typed in by a person; never verified'; return out; }
    if (x.reference_only || x.kind === 'reference') { out.state = 'REFERENCE'; out.label = 'Reference line'; out.reason = 'an untimed reference line, not a price any book is offering'; return out; }
    if (!x.stale && out.age_minutes != null && out.age_minutes <= S.CONFIG.live_minutes) { out.state = 'LIVE'; out.label = 'Live'; out.current = true; return out; }
    if (out.age_minutes != null && out.age_minutes <= S.CONFIG.cached_minutes) { out.state = 'CACHED'; out.label = 'Last known (not current)'; out.reason = 'the last captured quote is ' + C.fmt.age(out.age_minutes) + '; it is context, not a current price'; return out; }
    out.state = 'STALE'; out.label = 'Stale'; out.reason = out.age_minutes != null ? 'the last captured quote is ' + C.fmt.age(out.age_minutes) : 'the quote carries no capture time';
    return out;
  };
  /* the research state lib/edgedesk_personal.js already keeps per game → input for market() */
  S.marketFromState = function (st) {
    var m = st && st.market;
    if (!m) return null;
    return { home_line: m.home_line, total: m.total, ml_home: m.ml_home, ml_away: m.ml_away, book: m.book, books: m.books,
      captured_at: m.captured_at, stale: !!m.stale, kind: m.kind, source: m.kind || null,
      reference_only: /reference/i.test(String(m.book || '')) && !m.captured_at };
  };
  /* the model against a CURRENT market only: the displayed gap is the
     difference of the displayed lines (lib/edgedesk_calc.js) */
  S.compareMarket = function (snap, mk) {
    if (!snap || !snap.model.available || !mk || !mk.current) return null;
    var M = snap.model, out = { spread: null, total: null, moneyline: null };
    if (mk.home_line != null) {
      var fair = r1(M.fair.home_line), mkt = r1(mk.home_line), gap = Math.abs(Math.round(fair * 10) - Math.round(mkt * 10)) / 10;
      var toward = gap < 0.05 ? null : (fair < mkt ? 'home' : 'away');
      out.spread = { fair_home_line: fair, market_home_line: mkt, gap: gap, toward: toward, toward_team: toward ? snap[toward].name : null,
        text: gap < 0.05 ? 'EdgeDesk and the market agree on the spread' : 'EdgeDesk’s number is ' + gap.toFixed(1) + ' pts more favourable to ' + snap[toward].name };
    }
    if (mk.total != null) {
      var ft = r1(M.total), mt = r1(mk.total), tg = (Math.round(ft * 10) - Math.round(mt * 10)) / 10;
      out.total = { fair: ft, market: mt, gap: Math.abs(tg), direction: tg > 0 ? 'higher' : (tg < 0 ? 'lower' : 'level'),
        text: tg === 0 ? 'EdgeDesk and the market agree on the total' : 'EdgeDesk’s total is ' + Math.abs(tg).toFixed(1) + ' pts ' + (tg > 0 ? 'higher' : 'lower') + ' than the market’s' };
    }
    if (mk.ml_home != null && mk.ml_away != null) {
      var nv = C.noVigTwoWay(mk.ml_home, mk.ml_away);
      if (nv) out.moneyline = { market_no_vig_home: r4(nv.a), market_no_vig_away: r4(nv.b), overround: r4(nv.overround),
        model_home: M.win_prob.home, model_away: M.win_prob.away, label: 'market win probability with the margin removed (no-vig)' };
    }
    return out;
  };

  /* ------------------------------------------------------------ the three answers */
  /* the decision engine's blocker codes (lib/edgedesk_decision.js) that are
     about the SPORTSBOOK QUOTE, not the model. Any other code (DATA_FAULT,
     DISTRIBUTION_MISSING, IMPOSSIBLE_PROBABILITY, MODEL_VERSION_UNKNOWN,
     INVALID_GAME, EV_SIDE_CONTRADICTION …) is a genuine model or game
     problem and is never softened. */
  S.MARKET_BLOCKERS = { STALE_QUOTE: 'quote', NO_MARKET: 'quote', NO_VALID_QUOTE: 'quote', MARKET_SUSPENDED: 'quote', FRESHNESS_UNKNOWN: 'quote',
    CORRUPTED_ODDS: 'fault', ORIENTATION_FAULT: 'fault' };
  S.isMarketBlocker = function (code) { return Object.prototype.hasOwnProperty.call(S.MARKET_BLOCKERS, String(code || '')); };
  S.marketOnlyDecision = function (d) {
    var c = d && d.blocker_codes ? d.blocker_codes : [];
    return !!(d && d.decision === 'NO_DECISION' && c.length && c.every(S.isMarketBlocker));
  };
  S.marketNoteFor = function (d) {
    var c = d && d.blocker_codes ? d.blocker_codes : [];
    return c.some(function (x) { return S.MARKET_BLOCKERS[x] === 'fault'; })
      ? 'The captured sportsbook data failed an integrity check, so it is not compared. EdgeDesk’s independent matchup projections remain available.'
      : 'Live sportsbook prices are currently unavailable. EdgeDesk’s independent matchup projections remain available.';
  };
  S.availability = function (snap, mk, decision) {
    var M = snap && snap.model, out = {};
    if (!M || !M.available) { out.research = 'UNAVAILABLE'; out.model = 'UNAVAILABLE'; }
    else if (snap.data.status === 'FAULT') { out.research = 'LIMITED'; out.model = 'DATA FAULT'; }
    else if (snap.data.status === 'LIMITED') { out.research = 'LIMITED'; out.model = 'ACTIVE'; }
    else { out.research = 'AVAILABLE'; out.model = 'ACTIVE'; }
    mk = mk || S.market(null);
    out.market = mk.state === 'LIVE' ? 'LIVE' : (mk.state === 'UNAVAILABLE' ? 'UNAVAILABLE' : mk.state);
    var d = decision || null, codes = d && d.blocker_codes ? d.blocker_codes : [];
    if (d && d.decision && d.decision !== 'NO_DECISION') out.decision = 'EVALUATED';
    else if (codes.length && codes.every(S.isMarketBlocker)) out.decision = 'NOT EVALUATED';
    else if (codes.length) out.decision = 'BLOCKED';
    else out.decision = mk.current ? 'NOT EVALUATED' : 'NOT EVALUATED';
    out.decision_label = d && d.decision && d.decision !== 'NO_DECISION' ? (d.label || d.decision) : null;
    out.blocker_codes = codes.slice();
    out.market_note = mk.current ? null
      : (mk.state === 'FAULT' ? 'The captured sportsbook data failed an integrity check, so it is not compared. EdgeDesk’s independent matchup projections remain available.'
        : 'Live sportsbook prices are currently unavailable. EdgeDesk’s independent matchup projections remain available.');
    out.headline = out.research === 'UNAVAILABLE' ? 'Research limited: ' + (M && M.reason ? M.reason : 'the model has no projection for this game')
      : (out.model === 'DATA FAULT' ? 'Data fault: the projection failed its own consistency checks'
        : (out.market === 'LIVE' ? 'Research available · live market for comparison' : 'Research available · market comparison offline'));
    return out;
  };

  /* ------------------------------------------------------------ compare a price
     A reader's own sportsbook number against the snapshot's probability
     sheet (lib/edgedesk_fairline.js, the linemaker's validated pipeline).
     entry: { market: 'spread'|'total'|'moneyline', side: 'home'|'away'|'over'|'under', line, american }
     sheet: the snapshot's own sheet (football/game_research/probabilities.json)
     FL: window.EDFairLine (browser) or require('./edgedesk_fairline.js') */
  S.USER_PRICE_LABEL = 'User-entered, unverified sportsbook quote';
  S.comparePrice = function (snap, sheet, model, entry, FL) {
    var out = { ok: false, label: S.USER_PRICE_LABEL, entry: entry || null, errors: [], notes: [] };
    entry = entry || {};
    var a = num(entry.american), line = num(entry.line), mkt = entry.market;
    if (['spread', 'total', 'moneyline'].indexOf(mkt) < 0) out.errors.push('choose spread, total or moneyline');
    if (a == null || (a > -100 && a < 100)) out.errors.push('American odds are +100 or higher, or -100 or lower (for example -110 or +135)');
    if (mkt === 'spread' && (line == null || Math.abs(line) > 60)) out.errors.push('enter the spread for the team you chose, for example -3.5 or +7');
    if (mkt === 'total' && (line == null || line < 10 || line > 150)) out.errors.push('enter the game total, for example 47.5');
    if ((mkt === 'spread' || mkt === 'total') && line != null && Math.abs(line * 2 - Math.round(line * 2)) > 1e-9) out.errors.push('lines are priced in half points (47, 47.5, 48 …)');
    if (mkt === 'spread' || mkt === 'moneyline') { if (entry.side !== 'home' && entry.side !== 'away') out.errors.push('choose a team'); }
    if (mkt === 'total' && entry.side !== 'over' && entry.side !== 'under') out.errors.push('choose Over or Under');
    if (out.errors.length) return out;
    out.implied = r4(C.impliedFromAmerican(a));
    out.implied_note = 'the break-even probability of this price, margin included';
    if (!snap || !snap.model.available) { out.errors.push('EdgeDesk has no projection for this game, so there is no model probability to compare'); return out; }
    if (!sheet || !FL) { out.errors.push('EdgeDesk’s probability sheet for this game is not available'); return out; }
    var q = { market: mkt, side: entry.side, line: mkt === 'moneyline' ? null : line, american: a };
    var pc = FL.priceCheck(sheet, q, model);
    out.check = pc;
    if (!pc || !pc.probs) { out.errors.push(pc && pc.why && pc.why.length ? pc.why.join('; ') : 'that line is outside what EdgeDesk’s distribution covers'); return out; }
    var M = (sheet.markets || {})[mkt] || {};
    out.ok = true;
    out.model_prob = pc.probs.win;
    out.push_prob = pc.probs.push || 0;
    out.lose_prob = pc.probs.lose;
    out.cover_prob = pc.cover_prob;              /* win given no push */
    out.break_even = pc.break_even;
    out.prob_diff = pc.prob_edge;                /* model cover − break-even, in probability */
    out.fair_american = pc.fair_american;
    out.status = M.status || null;
    out.tier = M.tier || null;
    out.method = M.method || null;
    out.verdict = pc.verdict;
    out.why = (pc.why || []).slice();
    /* EV is shown only where the market's probabilities are CALIBRATED on
       held-out seasons; otherwise the arithmetic is kept out of sight */
    out.ev_validated = M.status === 'CALIBRATED';
    out.ev = out.ev_validated ? pc.expected_roi : null;
    out.ev_withheld = out.ev_validated ? null : 'Expected value is not shown: EdgeDesk’s ' + mkt + ' probabilities are ' + String(M.status || 'not calibrated').toLowerCase()
      + ' on held-out seasons, so an EV figure would look more certain than the model is.';
    out.conservative = pc.band && pc.band.available ? { cover: pc.conservative_cover, edge: pc.conservative_edge, roi: pc.conservative_roi, n: pc.band.n } : null;
    out.prob_label = mkt === 'moneyline' ? 'EdgeDesk model win probability' : (mkt === 'spread' ? 'EdgeDesk model cover probability' : 'EdgeDesk model probability of the ' + entry.side);
    if (mkt === 'spread') out.notes.push('A cover probability is not a win probability: it is the chance this side beats ' + (line > 0 ? '+' : '') + line + ', with a push returned.');
    if (M.tier !== 'VALIDATED') out.notes.push('The model has not shown it beats the closing line in this market (tier ' + (M.tier || 'RESEARCH') + '). This is research arithmetic on a modelled probability, not a betting record.');
    out.notes.push('Research and decision support only. No outcome is guaranteed.');
    return out;
  };
  /* is a probability sheet the one built from this snapshot's projection? */
  S.sheetMatches = function (snap, sheet) {
    if (!snap || !sheet || !snap.model.available) return false;
    var c = sheet.centres && sheet.centres.raw;
    return !!(c && Math.abs(num(c.home_margin) - snap.model.home_margin) <= 0.01 && Math.abs(num(c.total) - snap.model.total_exact) <= 0.05);
  };

  /* ------------------------------------------------------------ the graphic spec
     Everything the matchup graphic prints, and nothing else. The history
     ledger stores this, so any past graphic can be drawn again exactly. */
  S.graphicSpec = function (s) {
    if (!s) return null;
    var M = s.model;
    function team(t) { return { name: t.name, short: t.short || t.name, abbr: t.abbr, color: t.color, alt_color: t.alt_color, on_color: t.on_color, record: t.record ? t.record.text : null, poll_rank: t.poll_rank ? t.poll_rank.rank : null }; }
    return {
      snapshot_id: s.snapshot_id, league: s.league, game_key: s.game_key, season: s.season, week: s.week, week_label: s.week_label,
      kickoff: s.kickoff, kickoff_text: s.kickoff_text, venue: s.venue, neutral_site: s.neutral_site, context: s.context,
      home: team(s.home), away: team(s.away),
      model: M.available ? { available: true, version: M.version, built_at: M.built_at, home_margin: M.home_margin, fair: M.fair, total: M.total,
        scores: M.scores, headline_scores: M.headline_scores, win_prob: M.win_prob, win_display: M.win_display, fair_ml: M.fair_ml, range80: M.range80 || null }
        : { available: false, reason: M.reason, version: M.version, built_at: M.built_at },
      strength: s.strength || null,
      neutral: (function () {
        var d = s.drivers && s.drivers.rows ? s.drivers.rows.filter(function (r) { return r.key === 'rating' && r.favors; })[0] : null;
        return d ? { team: d.favors, team_short: s[d.favors].short || s[d.favors].name, points: d.points } : null;
      })(),
      overall_rank: (function () {
        var u = (s.units && s.units.rows || []).filter(function (r) { return r.key === 'overall'; })[0];
        return u && u.home && u.away ? { home: u.home.rank, away: u.away.rank, of: u.home.of || s.units.of, label: s.league === 'nfl' ? 'OVERALL EFFICIENCY RANK' : 'EDGEDESK POWER RANK' } : null;
      })(),
      insights: (s.insights || []).map(function (i) { return { id: i.id, family: i.family, icon: i.icon, title: i.title, short: i.short, team: i.team }; }),
      confidence: { kind: s.confidence.kind, score: s.confidence.score, grade: s.confidence.grade, label: s.confidence.label },
      data: { status: s.data.status, faults: (s.data.faults || []).slice(0, 3), warnings: (s.data.warnings || []).length }
    };
  };
  S.graphicKey = function (s) { return 'gk1-' + C.fingerprint(S.graphicSpec(s)); };

  /* ------------------------------------------------------------ words */
  /* the plain-language answer a beginner reads first */
  S.beginner = function (snap) {
    var M = snap.model;
    if (!M.available) return { lead: 'EdgeDesk has no projection for this game yet: ' + (M.reason || 'the model lacks the data it needs') + '.', points: [] };
    var fav = M.fair.favorite, favName = fav ? snap[fav].name : null, dog = fav ? snap[other(fav)].name : null;
    var hs = M.headline_scores || { home: M.scores.home, away: M.scores.away };
    var lead = fav
      ? 'EdgeDesk’s model expects ' + favName + ' to beat ' + dog + ' by about ' + Math.abs(M.fair.display).toFixed(1) + ' points (' + snap.home.name + ' ' + hs.home + ', ' + snap.away.name + ' ' + hs.away + '). It gives ' + favName + ' a ' + (fav === 'home' ? M.win_display.home : M.win_display.away) + ' chance to win.'
      : 'EdgeDesk’s model sees this as a coin flip: ' + snap.home.name + ' ' + hs.home + ', ' + snap.away.name + ' ' + hs.away + '.';
    var pts = [];
    pts.push('The model expects about ' + M.total.toFixed(1) + ' total points.');
    if (M.range80) pts.push('Football is noisy: in eight of ten games like this, the final margin lands between ' + M.range80.text + '.');
    (snap.insights || []).slice(0, 3).forEach(function (i) { pts.push(i.text); });
    if (snap.confidence.kind === 'reliability' && snap.confidence.score != null) pts.push('Reliability is ' + Math.round(snap.confidence.score) + ' out of 100: a measure of how complete and fresh the inputs are, not a chance of being right.');
    return { lead: lead, points: pts };
  };
  S.cap = cap;
  return S;
});
