/*__EDPERSONAL_START__*/
/* ===========================================================================
   EdgeDesk personal research layer — the ONE place the watchlist, the
   research-condition alerts, the Top-5 explanations, the decision journal's
   snapshot and grade, and the reader's decision-quality analytics are
   computed. Research, not picks.

   It computes NO projection, fair line, win probability, reliability,
   research label or status. Every one of those arrives on a RESEARCH STATE
   that the football module in app.html built from the board's own readers
   (window.fbResearchStates → fbResearchStateOf), and every number this file
   prints is one of that state's numbers, or arithmetic between two of them
   (a difference, an average, a count). A value the state does not carry
   stays null and is never filled in.

   Browser: window.EDPersonal. Node: require('./edgedesk_personal.js').
   Edge function: inlined between the EDPERSONAL start/end markers.
   Uses lib/research_core.js (EDResearch) for the line convention, CLV and
   key numbers, so no odds helper is duplicated here.

   THE RESEARCH STATE (schema edgedesk_research_state/1)
     game_key        '<league>|<schedule id>'  e.g. 'cfb|401862779'
     sport, game_id, season, week, home, away, kickoff_at (ISO)
     status          the board's own status label (fbP4StatusFor /
                     fbNflResearchState), verbatim
     projected       the engine returned PREDICTED
     fair            {home_line, text, total, model_version, projected_at}
     market          {home_line, text, total, kind:'live'|'consensus', book,
                      captured_at, stale, books, age_h, ml_home, ml_away}
     gap             {points, normalized, toward:'home'|'away'|null}
     win_prob_home
     reliability     {score 0-100|null, grade, tier, scored, main_deduction,
                      stability}  — CFB only; NFL publishes none (scored:false)
     research_label  the CFB research view's label key, or null
     qb              {home:{name,status,confirmed}, away:{…}, confirmed_both,
                      unknown, source}
     injuries        {home:{known, out:[], doubtful:[], questionable:[]},
                      away:{…}, source, as_of}
     movement        {spread_moved, toward_model, h2h_pp}
     drivers         [{text, points}] the engine's largest terms (CFB view)
     flags, qualifiers, warnings
     priority        {eligible, reasons, score, rank, why_code, why_text,
                      uncertainty:[]}  lib/research_priority.js, unchanged
     key_reason      the one sentence a reader sees first
     research_grade  see researchGrade() below
     computed_at

   COMPARE MY NUMBER (compareNumber) sets a reader's own fair spread and total
   beside EdgeDesk's and the market's and says, from the state's own fields,
   where they agree, where they differ and which of EdgeDesk's MEASURED inputs
   the difference runs through. It declares neither number right.
   PERSONAS (personaPlan) only reorder the desk; nothing is ever hidden.
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var rc = null;
    try { rc = require('./research_core.js'); } catch (_) { rc = null; }
    module.exports = factory(rc);
  } else root.EDPersonal = factory(null);
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (RC0) {
  'use strict';
  var P = { version: 'edgedesk_personal/1', SCHEMA: 'edgedesk_research_state/1' };
  var G = typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : {});
  function RC() { return RC0 || G.EDResearch || null; }

  function num(x) { return (typeof x === 'number' && isFinite(x)) ? x : null; }
  function r1(x) { return x == null ? null : Math.round(x * 10) / 10; }
  function r3(x) { return x == null ? null : Math.round(x * 1000) / 1000; }
  function has(list, k) { return !!list && list.indexOf(k) >= 0; }
  function str(x, max) { if (x == null) return null; var s = String(x); return s.length > (max || 200) ? s.slice(0, max || 200) : s; }
  P.num = num; P.r1 = r1;

  /* ------------------------------------------------------------ vocabulary */
  P.LEAGUES = [{ key: 'cfb', label: 'College Football' }, { key: 'nfl', label: 'NFL' }];
  P.DECISIONS = ['researching', 'passed', 'leaned', 'wagered'];
  P.DECISION_LABEL = { researching: 'Researching', passed: 'Passed', leaned: 'Leaned', wagered: 'Wagered' };
  P.MARKET_TYPES = ['spread', 'total', 'moneyline'];
  P.INTERESTS = [
    { key: 'model_vs_market', label: 'Model vs market' },
    { key: 'matchup', label: 'Matchup research' },
    { key: 'line_movement', label: 'Line movement' },
    { key: 'reliability', label: 'Reliability' },
    { key: 'clv', label: 'CLV tracking' },
    { key: 'ai', label: 'AI research' },
    { key: 'all', label: 'All of the above' }
  ];
  /* "What best describes how you research?" — one answer, stored on
     user_preferences.persona (supabase/personal_research.sql checks the same
     five keys). It decides what the desk shows FIRST; every section stays. */
  P.PERSONAS = [
    { key: 'model_builder', label: 'I build my own numbers', spotlight: 'compare',
      note: 'Compare My Number is first: set your number beside EdgeDesk’s and the market’s, and see which measured inputs the difference runs through.' },
    { key: 'researcher', label: 'I research games before betting', spotlight: 'top5',
      note: 'Top 5 Games to Research is first: the games most worth your time, ranked by research-worthiness, not by gap.' },
    { key: 'market_comparer', label: 'I compare markets and prices', spotlight: 'watchlist',
      note: 'Your watchlist is first, with market-move and key-number alerts: where the market moves against EdgeDesk’s number.' },
    { key: 'creator', label: 'I create betting content', spotlight: 'share',
      note: 'Share research cards is first: a clean card of EdgeDesk’s number, the market and the evidence, sized for X.' },
    { key: 'process_improver', label: 'I want to improve my process', spotlight: 'quality',
      note: 'My decision quality is first: your journal graded against the close, process and result kept apart.' }
  ];
  P.personaOf = function (key) { return P.PERSONAS.filter(function (x) { return x.key === key; })[0] || null; };
  /* The desk's section order. Every plan holds every section: the persona
     moves one to the front, it never removes one. */
  P.DESK_SECTIONS = ['top5', 'watchlist', 'changes', 'quality', 'compare', 'share'];
  P.personaPlan = function (persona) {
    var pe = P.personaOf(persona);
    var top = ['top5', 'watchlist'], bottom = ['changes', 'quality', 'compare', 'share'];
    if (pe && pe.spotlight !== 'top5') {
      top = [pe.spotlight].concat(top.filter(function (k) { return k !== pe.spotlight; }));
      bottom = bottom.filter(function (k) { return k !== pe.spotlight; });
    }
    return { persona: pe ? pe.key : null, spotlight: pe ? pe.spotlight : null, note: pe ? pe.note : null, top: top, bottom: bottom };
  };

  /* THE SPORTSBOOKS a reader can pick: exactly the keys the capture function
     recognises (supabase/functions/capture/index.ts BOOK_TIER), labelled.
     tools/personal/personal_ui.test.js fails if the two lists drift. */
  P.BOOKS = [
    { key: 'draftkings', label: 'DraftKings' }, { key: 'fanduel', label: 'FanDuel' }, { key: 'betmgm', label: 'BetMGM' },
    { key: 'williamhill_us', label: 'Caesars' }, { key: 'espnbet', label: 'ESPN BET' }, { key: 'fanatics', label: 'Fanatics' },
    { key: 'betrivers', label: 'BetRivers' }, { key: 'hardrockbet', label: 'Hard Rock Bet' }, { key: 'superbook', label: 'SuperBook' },
    { key: 'circasports', label: 'Circa Sports' }, { key: 'pinnacle', label: 'Pinnacle' }, { key: 'betonlineag', label: 'BetOnline' },
    { key: 'lowvig', label: 'LowVig' }, { key: 'bovada', label: 'Bovada' }, { key: 'betus', label: 'BetUS' },
    { key: 'mybookieag', label: 'MyBookie' }, { key: 'betanysports', label: 'BetAnySports' }, { key: 'novig', label: 'Novig' },
    { key: 'prophetx', label: 'ProphetX' }, { key: 'matchbook', label: 'Matchbook' }
  ];
  /* the thresholds this layer reads, each one an existing EdgeDesk number */
  P.RESEARCH_GAP = 2;          /* lib/research_priority.js RESEARCH_GAP */
  P.ELEVATED_GAP = 7;          /* lib/research_priority.js ELEVATED_GAP */
  P.STRONG_RELIABILITY = 80;   /* lib/cfb_reliability.js STRONG grade */
  P.LOW_RELIABILITY = 60;      /* lib/cfb_research_view.js limited bar */

  /* THE COPY RULE. Research, not picks. The same list the database enforces
     on alert copy (supabase/personal_research.sql edp_copy_ok). */
  P.BANNED = /(bet this|\blocks?\b|guarantee|\bsmash|must[- ]bet|can'?t lose|best bets?|winning plays?|free money|sure thing)/i;
  P.copyOk = function (t) { return t == null || !P.BANNED.test(String(t)); };

  /* -------------------------------------------------------------- lines */
  function signed(v) { return v === 0 ? 'PK' : (v > 0 ? '+' : '') + v.toFixed(1); }
  /* a team's line from a home line (negative = home favoured) */
  P.teamLine = function (s, team, homeLine) {
    var l = num(homeLine);
    if (l == null || !s) return null;
    return team === s.home ? l : (l === 0 ? 0 : -l);
  };
  /* "Florida -2.5", stated for the favourite; "pick'em" at zero */
  P.favText = function (s, homeLine) {
    var l = num(homeLine);
    if (l == null || !s) return null;
    if (l === 0) return 'pick’em';
    return l < 0 ? s.home + ' ' + signed(l) : s.away + ' ' + signed(-l);
  };
  P.teamText = function (s, team, homeLine) {
    var v = P.teamLine(s, team, homeLine);
    return v == null ? null : team + ' ' + signed(v);
  };
  P.gameKey = function (sport, gid) {
    var sp = String(sport || '').toLowerCase() === 'p4' ? 'cfb' : String(sport || '').toLowerCase();
    return sp + '|' + String(gid);
  };
  P.matchup = function (s) { return s ? (s.away + ' @ ' + s.home) : ''; };

  /* ------------------------------------------------------ the state itself */
  var HASH_FIELDS = function (s) {
    var q = s.qb || {}, inj = s.injuries || {}, m = s.market || {}, f = s.fair || {}, rel = s.reliability || {};
    function qb(x) { return x ? [x.name || '', x.status || '', x.confirmed ? 1 : 0].join('/') : ''; }
    function injd(x) { return x ? [x.known ? 1 : 0, (x.out || []).length, (x.doubtful || []).length, (x.questionable || []).length,
      (x.out || []).slice().sort().join(',')].join('/') : ''; }
    return [s.game_key, s.status, s.projected ? 1 : 0, r1(num(f.home_line)), r1(num(f.total)), r1(num(m.home_line)), r1(num(m.total)),
      m.stale ? 1 : 0, r3(num(s.win_prob_home)), num(rel.score) == null ? '' : Math.round(rel.score), rel.grade || '',
      s.research_label || '', s.research_grade ? 1 : 0, qb(q.home), qb(q.away), injd(inj.home), injd(inj.away),
      s.priority && s.priority.eligible ? 1 : 0].join('|');
  };
  /* FNV-1a, 32-bit, over the fields a reader would call a change. Not over
     computed_at or a quote's age: a state that only got older is the same
     state. */
  P.hash = function (text) {
    var h = 0x811c9dc5, s = String(text);
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
    return ('0000000' + h.toString(16)).slice(-8);
  };
  P.stateHash = function (s) { return s ? 'rs1-' + P.hash(HASH_FIELDS(s)) : null; };

  /* RESEARCH-GRADE: the game clears every gate of the "games worth
     researching" order (lib/research_priority.js eligibility — a projection,
     a current market, no data fault, no thin data, no stale quote, something
     to explain) AND, where a league scores reliability, the research view does
     not call it LOW RELIABILITY or LIMITED DATA. Nothing else. */
  P.researchGrade = function (s) {
    var why = [];
    if (!s) return { grade: false, reasons: ['no research state'] };
    var pr = s.priority || {};
    if (!pr.eligible) (pr.reasons || ['does not clear the research gates']).forEach(function (r) { why.push(r); });
    if (s.research_label === 'LOW_RELIABILITY') why.push('reliability is under the bar EdgeDesk trusts');
    if (s.research_label === 'LIMITED_DATA') why.push('data is too limited to compare with the market');
    return { grade: why.length === 0, reasons: why };
  };

  P.normalizeState = function (x) {
    if (!x || typeof x !== 'object' || !x.game_key) return null;
    var s = JSON.parse(JSON.stringify(x));
    s.schema = P.SCHEMA;
    s.fair = s.fair || {}; s.market = s.market || {}; s.gap = s.gap || {}; s.reliability = s.reliability || { scored: false };
    s.qb = s.qb || {}; s.injuries = s.injuries || {}; s.movement = s.movement || {}; s.priority = s.priority || { eligible: false };
    s.flags = s.flags || []; s.qualifiers = s.qualifiers || []; s.warnings = (s.warnings || []).slice(0, 8);
    if (num(s.fair.home_line) != null && num(s.market.home_line) != null && num(s.gap.points) == null)
      s.gap.points = r1(Math.abs(s.fair.home_line - s.market.home_line));
    var rg = P.researchGrade(s);
    s.research_grade = rg.grade;
    s.research_grade_reasons = rg.reasons;
    s.state_hash = P.stateHash(s);
    return s;
  };

  /* the columns game_research_state lifts out of a state */
  P.stateRow = function (s) {
    var f = s.fair || {}, m = s.market || {}, rel = s.reliability || {}, q = s.qb || {}, pr = s.priority || {};
    return {
      game_key: s.game_key, sport: s.sport, game_id: String(s.game_id), season: num(s.season), week: num(s.week),
      home: str(s.home, 80), away: str(s.away, 80), kickoff_at: s.kickoff_at || null, status: str(s.status, 40),
      projected: !!s.projected, fair_home_line: num(f.home_line), fair_total: num(f.total), model_version: str(f.model_version, 80),
      market_home_line: num(m.home_line), market_total: num(m.total), market_kind: m.kind || null, market_book: str(m.book, 80),
      market_captured_at: m.captured_at || null, market_stale: m.stale == null ? null : !!m.stale,
      gap_pts: num(s.gap && s.gap.points), normalized_gap: num(s.gap && s.gap.normalized), win_prob_home: num(s.win_prob_home),
      reliability_score: num(rel.score), reliability_grade: str(rel.grade, 40), research_label: str(s.research_label, 40),
      research_grade: !!s.research_grade, qb_confirmed: q.confirmed_both == null ? null : !!q.confirmed_both,
      qb_unknown: q.unknown == null ? null : !!q.unknown, priority_eligible: !!pr.eligible, priority_score: num(pr.score),
      priority_rank: num(pr.rank), priority_why: str(pr.why_text, 300), key_reason: str(s.key_reason, 400),
      state: s, state_hash: s.state_hash || P.stateHash(s), computed_at: s.computed_at || new Date().toISOString()
    };
  };

  /* ------------------------------------------------------ what changed
     Each change is a fact between two states, worded neutrally. The same
     function feeds "changed since your last visit", the alert engine and
     the desk's "what changed in my watchlist". */
  P.ALERT_DEFAULTS = {
    enabled: true, scope: 'watchlist',
    reliability_min: 80, on_reliability_min: true,
    gap_min_pts: 3, on_gap_min: true,
    on_qb_confirmed: true, on_injury_change: true,
    market_move_pts: 1, on_market_move: true, on_key_number: true,
    fair_move_pts: 1, on_fair_move: true,
    converge_pts: 1, on_converge: true,
    diverge_pts: 1.5, on_diverge: true,
    on_research_grade: true,
    reliability_change_pts: 8, on_reliability_change: true,
    email_digest: false
  };
  P.ALERT_RANGES = {
    reliability_min: [0, 100], gap_min_pts: [0.5, 21], market_move_pts: [0.5, 14], fair_move_pts: [0.25, 14],
    converge_pts: [0, 7], diverge_pts: [0.5, 14], reliability_change_pts: [1, 50]
  };
  P.alertPrefs = function (x) {
    var o = {}, k;
    for (k in P.ALERT_DEFAULTS) o[k] = P.ALERT_DEFAULTS[k];
    if (x) for (k in P.ALERT_DEFAULTS) if (x[k] != null) o[k] = typeof P.ALERT_DEFAULTS[k] === 'number' ? +x[k] : x[k];
    return o;
  };
  P.validateAlertPrefs = function (x) {
    var errs = [], o = P.alertPrefs(x);
    Object.keys(P.ALERT_RANGES).forEach(function (k) {
      var r = P.ALERT_RANGES[k], v = o[k];
      if (!(typeof v === 'number' && isFinite(v) && v >= r[0] && v <= r[1])) errs.push(k + ' must be between ' + r[0] + ' and ' + r[1]);
    });
    if (o.scope !== 'watchlist' && o.scope !== 'leagues') errs.push('scope must be watchlist or leagues');
    return { ok: errs.length === 0, errors: errs, value: o };
  };

  function injList(x) { return x ? (x.out || []).concat(x.doubtful || []) : []; }
  function injSummary(team, x) {
    if (!x || !x.known) return team + ': no availability report on file';
    var parts = [];
    if ((x.out || []).length) parts.push((x.out || []).length + ' out');
    if ((x.doubtful || []).length) parts.push((x.doubtful || []).length + ' doubtful');
    if ((x.questionable || []).length) parts.push((x.questionable || []).length + ' questionable');
    return team + ': ' + (parts.length ? parts.join(', ') : 'nobody listed on a report that is on file');
  }
  P.injurySummary = injSummary;

  /* opts: thresholds (alert prefs shape). Returns change events in a fixed
     order, each {kind, text, from, to, severity, tag}. */
  P.changes = function (prev, cur, opts) {
    var o = P.alertPrefs(opts), out = [];
    if (!prev || !cur || prev.game_key !== cur.game_key) return out;
    var pf = num(prev.fair && prev.fair.home_line), cf = num(cur.fair && cur.fair.home_line);
    var pm = num(prev.market && prev.market.home_line), cm = num(cur.market && cur.market.home_line);
    var pg = num(prev.gap && prev.gap.points), cg = num(cur.gap && cur.gap.points);
    var pr = num(prev.reliability && prev.reliability.score), cr = num(cur.reliability && cur.reliability.score);
    function push(kind, text, from, to, severity, tag) { out.push({ kind: kind, text: text, from: from, to: to, severity: severity || 'info', tag: tag }); }

    /* the fair line */
    if (pf != null && cf != null && Math.abs(cf - pf) >= o.fair_move_pts) {
      var fav = cf <= 0 ? cur.home : cur.away;
      push('fair_move', fav + ' moved from ' + signed(P.teamLine(cur, fav, pf)) + ' fair to ' + signed(P.teamLine(cur, fav, cf)) + ' fair.',
        pf, cf, 'info', r1(cf));
    }
    /* the market, and the key numbers it crossed */
    if (pm != null && cm != null && Math.abs(cm - pm) >= o.market_move_pts) {
      var mt = cm <= 0 ? cur.home : cur.away;
      var fairTail = cf == null ? '' : (pf != null && Math.abs(cf - pf) < 0.25
        ? ' while EdgeDesk remained ' + P.teamText(cur, mt, cf)
        : ' while EdgeDesk is ' + P.teamText(cur, mt, cf));
      push('market_move', 'Market moved from ' + P.teamText(cur, mt, pm) + ' to ' + P.teamText(cur, mt, cm) + fairTail + '.',
        pm, cm, 'info', r1(cm));
    }
    if (pm != null && cm != null && pm !== cm && RC() && RC().keyNumberCrossings) {
      var kc = (RC().keyNumberCrossings(pm, cm, cur.sport === 'nfl' ? 'NFL' : 'CFB') || []).filter(function (k) { return k.tier === 'primary' && (k.kind === 'crossed' || k.kind === 'onto'); });
      if (kc.length) {
        var kt = cm <= 0 ? cur.home : cur.away;
        push('key_number', 'Market ' + (kc[0].kind === 'onto' ? 'moved onto' : 'crossed') + ' the key number ' + kc[0].key + ': '
          + P.teamText(cur, kt, pm) + ' to ' + P.teamText(cur, kt, cm) + '.', pm, cm, 'info', kc[0].kind + kc[0].key + '/' + r1(cm));
      }
    }
    /* the disagreement */
    if (pg != null && cg != null) {
      if (pg < o.gap_min_pts && cg >= o.gap_min_pts)
        push('gap_min', 'Model-market disagreement is now ' + cg.toFixed(1) + ' points (was ' + pg.toFixed(1) + ').', pg, cg, 'notable', o.gap_min_pts + '/' + r1(cg));
      if (cg < pg && (pg - cg) >= o.diverge_pts && cg <= o.converge_pts)
        push('converge', 'EdgeDesk and the market converged: ' + cg.toFixed(1) + ' points apart (was ' + pg.toFixed(1) + ').', pg, cg, 'info', r1(cg));
      else if (cg > pg && (cg - pg) >= o.diverge_pts)
        push('diverge', 'Model-market disagreement widened from ' + pg.toFixed(1) + ' to ' + cg.toFixed(1) + ' points.', pg, cg, 'info', r1(cg));
    }
    /* quarterbacks */
    var qbConfirmed = [];
    ['home', 'away'].forEach(function (side) {
      var a = prev.qb && prev.qb[side], b = cur.qb && cur.qb[side], team = cur[side];
      if (!b) return;
      if (b.confirmed && !(a && a.confirmed)) qbConfirmed.push(team);
      else if (a && a.name && b.name && a.name !== b.name)
        push('qb_change', team + ' starting quarterback changed from ' + a.name + ' to ' + b.name + '.', a.name, b.name, 'notable', side + '/' + b.name);
    });
    /* reliability — merged with a QB confirmation when both arrive together */
    var relText = null;
    if (pr != null && cr != null && Math.abs(cr - pr) >= o.reliability_change_pts)
      relText = 'Reliability ' + (cr > pr ? 'increased' : 'declined') + ' from ' + Math.round(pr) + ' to ' + Math.round(cr) + '.';
    if (qbConfirmed.length) {
      push('qb_confirmed', 'QB status confirmed for ' + qbConfirmed.join(' and ') + '.' + (relText ? ' ' + relText : ''),
        null, qbConfirmed.join(','), 'notable', qbConfirmed.join(',') + '/' + (cr == null ? '' : Math.round(cr)));
    }
    if (relText && !qbConfirmed.length)
      push('reliability_change', relText, pr, cr, cr < pr ? 'caution' : 'info', Math.round(pr) + '>' + Math.round(cr));
    if (cr != null && (pr == null || pr < o.reliability_min) && cr >= o.reliability_min)
      push('reliability_min', 'Reliability reached ' + Math.round(cr) + ', at or above ' + Math.round(o.reliability_min) + '.', pr, cr, 'info', o.reliability_min + '/' + Math.round(cr));
    /* availability */
    ['home', 'away'].forEach(function (side) {
      var a = prev.injuries && prev.injuries[side], b = cur.injuries && cur.injuries[side], team = cur[side];
      if (!b) return;
      var ak = a && a.known, bk = b.known;
      var al = injList(a).slice().sort().join(','), bl = injList(b).slice().sort().join(',');
      if ((ak !== bk) || (bk && al !== bl)) {
        push('injury_change', 'Availability changed. ' + injSummary(team, b) + (a ? ' (was ' + injSummary(team, a).replace(team + ': ', '') + ').' : '.'),
          null, null, 'notable', side + '/' + P.hash(bl + '|' + (bk ? 1 : 0)));
      }
    });
    /* research-grade */
    if (!!prev.research_grade !== !!cur.research_grade) {
      if (cur.research_grade)
        push('research_grade', 'Now research-grade: it clears every research gate' + (cg != null ? ' with ' + cg.toFixed(1) + ' points of model-market disagreement' : '')
          + (cr != null ? ' and reliability ' + Math.round(cr) : '') + '.', false, true, 'notable', cur.state_hash || P.stateHash(cur));
      else
        push('research_grade_lost', 'No longer research-grade: ' + ((cur.research_grade_reasons || [])[0] || 'it no longer clears the research gates') + '.',
          true, false, 'caution', cur.state_hash || P.stateHash(cur));
    }
    return out;
  };

  /* ---------------------------------------------------------- alerts
     Which of a state change's events a reader asked to hear about.
     ctx: {watched:boolean} — the league-wide scope only ever raises the three
     threshold alerts (research-grade, disagreement, reliability); the rest are
     for games the reader chose to watch. */
  var KIND_PREF = {
    fair_move: 'on_fair_move', market_move: 'on_market_move', key_number: 'on_key_number', gap_min: 'on_gap_min',
    converge: 'on_converge', diverge: 'on_diverge', reliability_min: 'on_reliability_min',
    reliability_change: 'on_reliability_change', qb_confirmed: 'on_qb_confirmed', qb_change: 'on_qb_confirmed',
    injury_change: 'on_injury_change', research_grade: 'on_research_grade', research_grade_lost: 'on_research_grade'
  };
  P.ALERT_KINDS = Object.keys(KIND_PREF);
  var LEAGUE_SCOPE_KINDS = ['research_grade', 'gap_min', 'reliability_min'];
  var ALERT_TITLE = {
    fair_move: 'EdgeDesk fair line moved', market_move: 'Market line moved', key_number: 'Market crossed a key number',
    gap_min: 'Model-market disagreement reached your threshold', converge: 'EdgeDesk and the market converged',
    diverge: 'Model-market disagreement widened', reliability_min: 'Reliability reached your threshold',
    reliability_change: 'Reliability changed', qb_confirmed: 'QB status confirmed', qb_change: 'Starting QB changed',
    injury_change: 'Availability changed', research_grade: 'Game became research-grade', research_grade_lost: 'Game is no longer research-grade'
  };
  P.ALERT_TITLE = ALERT_TITLE;
  P.alertsFor = function (prev, cur, prefs, ctx) {
    var o = P.alertPrefs(prefs), watched = !ctx || ctx.watched !== false;
    if (!o.enabled || !cur) return [];
    /* a game that has kicked off is not researched any more */
    var ko = cur.kickoff_at ? Date.parse(cur.kickoff_at) : null, now = (ctx && ctx.now) || Date.now();
    if (ko != null && isFinite(ko) && now >= ko) return [];
    return P.changes(prev, cur, o).filter(function (ch) {
      if (!o[KIND_PREF[ch.kind]]) return false;
      if (!watched && (o.scope !== 'leagues' || LEAGUE_SCOPE_KINDS.indexOf(ch.kind) < 0)) return false;
      return true;
    }).map(function (ch) {
      var title = ALERT_TITLE[ch.kind] + ' · ' + P.matchup(cur);
      if (title.length > 160) title = title.slice(0, 157) + '…';
      return { game_key: cur.game_key, kind: ch.kind, title: title, body: ch.text.slice(0, 600), severity: ch.severity,
        dedupe_key: (ch.kind + '|' + cur.game_key + '|' + ch.tag).slice(0, 200),
        payload: { from: ch.from, to: ch.to, matchup: P.matchup(cur), kickoff_at: cur.kickoff_at || null,
          state_hash: cur.state_hash || null, computed_at: cur.computed_at || null } };
    }).filter(function (a) { return P.copyOk(a.title) && P.copyOk(a.body); });
  };
  /* no second alert of the same kind for the same game inside the cooldown */
  P.COOLDOWN_HOURS = 3;
  P.cooled = function (alerts, recent, now, hours) {
    var h = (hours == null ? P.COOLDOWN_HOURS : hours) * 36e5, t = now || Date.now();
    var last = {};
    (recent || []).forEach(function (r) {
      var k = r.kind + '|' + r.game_key, at = Date.parse(r.created_at);
      if (isFinite(at) && (!last[k] || at > last[k])) last[k] = at;
    });
    return (alerts || []).filter(function (a) { var at = last[a.kind + '|' + a.game_key]; return !at || (t - at) >= h; });
  };

  /* ---------------------------------------------- why it is worth researching
     Bullets filled ONLY from fields the state carries; a kind of evidence the
     game does not carry is never named. The lead reason is the reading
     order's own sentence (lib/research_priority.js P.why). */
  P.explain = function (s) {
    var why = [], concern = [];
    if (!s) return { why: why, concerns: concern };
    var g = num(s.gap && s.gap.points), rel = s.reliability || {}, rs = num(rel.score), q = s.qb || {}, inj = s.injuries || {};
    var m = s.market || {}, mv = s.movement || {}, pr = s.priority || {};
    if (pr.why_text) why.push(pr.why_text.replace(/\.$/, ''));
    if (g != null && g >= P.RESEARCH_GAP && !/disagree|flips|apart|closer|by more/i.test(pr.why_text || ''))
      why.push('meaningful model-market disagreement (' + g.toFixed(1) + ' points)');
    if (q.confirmed_both) why.push('confirmed QB status on both sides');
    if (rs != null && rs >= P.STRONG_RELIABILITY) why.push((rs >= 90 ? 'very strong' : 'strong') + ' reliability (' + Math.round(rs) + ')');
    if (inj.home && inj.home.known && inj.away && inj.away.known) why.push('availability reports on file for both teams');
    if (m.kind === 'live' && num(m.books) != null && m.books >= 2) why.push('multi-book market confirmation (' + m.books + ' books)');
    else if (m.kind === 'live' && !m.stale) why.push('a captured sportsbook quote' + (m.book ? ' (' + m.book + ')' : ''));
    if (num(mv.toward_model) != null && mv.toward_model >= 1) why.push('the market has moved ' + mv.toward_model.toFixed(1) + ' pts toward EdgeDesk since the open');
    if (rel.stability && rel.stability.tier === 'HIGH') why.push('stable model inputs (projection stability high)');

    if (q.home && !q.home.confirmed) concern.push(s.home + ' starting QB not confirmed' + (q.home.name ? ' (expected ' + q.home.name + ')' : ''));
    if (q.away && !q.away.confirmed) concern.push(s.away + ' starting QB not confirmed' + (q.away.name ? ' (expected ' + q.away.name + ')' : ''));
    if (rel.scored === false || rs == null) concern.push(s.sport === 'nfl' ? 'NFL reliability is not scored; read the data warnings' : 'reliability is not measured for this game');
    else if (rs < 70) concern.push('reliability is ' + Math.round(rs) + (rel.grade ? ' (' + String(rel.grade).toLowerCase() + ')' : ''));
    if (rel.main_deduction && (rs == null || rs < 90)) concern.push('main reliability deduction: ' + String(rel.main_deduction).replace(/\.$/, ''));
    if (g != null && g >= P.ELEVATED_GAP) concern.push('a gap of ' + g.toFixed(1) + ' points is more often missing information than a mispriced market');
    if (m.kind === 'consensus') concern.push('the market number is a consensus reference, not a captured quote');
    if (num(m.age_h) != null && m.age_h >= 12) concern.push('the market quote is ' + Math.round(m.age_h) + ' hours old');
    ['home', 'away'].forEach(function (side) { if (inj[side] && inj[side].known === false) concern.push('no availability report on file for ' + s[side]); });
    if (num(mv.toward_model) != null && mv.toward_model <= -1) concern.push('the market has moved ' + Math.abs(mv.toward_model).toFixed(1) + ' pts away from EdgeDesk since the open');
    var d = (s.drivers || []).filter(function (x) { return num(x.points) != null; });
    var fair = num(s.fair && s.fair.home_line);
    if (d.length && fair != null && Math.abs(fair) >= 1) {
      var top = d.slice().sort(function (a, b) { return Math.abs(b.points) - Math.abs(a.points); })[0];
      if (Math.abs(top.points) >= 0.6 * Math.abs(fair)) concern.push('the projection leans heavily on one input: ' + top.text);
    }
    return { why: why.slice(0, 6), concerns: concern.slice(0, 5) };
  };

  /* Rank a set of states for the "Top 5 games to research" list, per league,
     by the reading order's own score — never by the raw gap. States carry
     priority.score from lib/research_priority.js; this only orders what was
     already scored, with the same deterministic tie-breaks. */
  P.topFive = function (states, league, n) {
    var list = (states || []).filter(function (s) { return s && s.priority && s.priority.eligible && (!league || s.sport === league); });
    list.sort(function (a, b) {
      var ra = num(a.priority.rank), rb = num(b.priority.rank);
      if (ra != null && rb != null && ra !== rb) return ra - rb;
      return (num(b.priority.score) || 0) - (num(a.priority.score) || 0) || String(a.game_key).localeCompare(String(b.game_key));
    });
    return list.slice(0, n == null ? 5 : n);
  };

  /* ------------------------------------------------------------ journal */
  P.validateJournal = function (e) {
    var errs = [];
    if (!e || !e.game_key || !/^[a-z0-9]{2,12}\|[A-Za-z0-9_.:-]{1,64}$/.test(e.game_key)) errs.push('a game is required');
    if (!e || P.DECISIONS.indexOf(e.decision) < 0) errs.push('decision must be researching, passed, leaned or wagered');
    if (e && e.market_type != null && P.MARKET_TYPES.indexOf(e.market_type) < 0) errs.push('market type must be spread, total or moneyline');
    var price = e ? num(e.price_american) : null, line = e ? num(e.line) : null, stake = e ? num(e.stake) : null;
    if (e && e.price_american != null && (price == null || (price > -100 && price < 100) || Math.abs(price) > 100000)) errs.push('odds must be American, like -110 or +150');
    if (e && e.line != null && (line == null || line < -100 || line > 400)) errs.push('line is out of range');
    if (e && e.stake != null && (stake == null || stake < 0 || stake > 1e7)) errs.push('stake must be zero or more');
    if (e && e.notes != null && String(e.notes).length > 4000) errs.push('notes are limited to 4000 characters');
    if (e && e.my_home_line != null && !(num(e.my_home_line) != null && e.my_home_line >= -100 && e.my_home_line <= 100)) errs.push('your spread is out of range');
    if (e && e.my_total != null && !(num(e.my_total) != null && e.my_total >= 0 && e.my_total <= 400)) errs.push('your total is out of range');
    if (e && e.decision === 'wagered') {
      if (e.market_type === 'spread' && !(has(['home', 'away'], e.selection) && line != null)) errs.push('a spread wager needs a side and a line');
      else if (e.market_type === 'total' && !(has(['over', 'under'], e.selection) && line != null)) errs.push('a total wager needs over/under and a number');
      else if (e.market_type === 'moneyline' && !(has(['home', 'away'], e.selection) && price != null)) errs.push('a moneyline wager needs a side and a price');
      else if (!e.market_type) errs.push('a wager needs a market type');
    }
    return { ok: errs.length === 0, errors: errs };
  };
  /* the information set at decision time, from the state on screen */
  P.journalSnapshot = function (s0) {
    if (!s0) return null;
    /* a COPY: the live state object keeps changing on the page, the snapshot
       never does */
    var s = JSON.parse(JSON.stringify(s0));
    var f = s.fair || {}, m = s.market || {}, rel = s.reliability || {};
    var snap = {
      schema: P.SCHEMA, captured_at: new Date().toISOString(), game_key: s.game_key, home: s.home, away: s.away,
      kickoff_at: s.kickoff_at, status: s.status, fair: f, market: m, gap: s.gap || {}, win_prob_home: num(s.win_prob_home),
      reliability: { score: num(rel.score), grade: rel.grade || null, tier: rel.tier || null, scored: !!rel.scored, main_deduction: rel.main_deduction || null },
      research_label: s.research_label || null, research_grade: !!s.research_grade, qb: s.qb || {}, injuries: s.injuries || {},
      movement: s.movement || {}, priority: s.priority || {}, key_reason: s.key_reason || null, state_hash: s.state_hash || P.stateHash(s),
      computed_at: s.computed_at || null
    };
    return {
      snap_fair_home_line: num(f.home_line), snap_fair_total: num(f.total), snap_market_home_line: num(m.home_line),
      snap_market_total: num(m.total), snap_market_book: str(m.book, 80), snap_market_captured_at: m.captured_at || null,
      snap_gap_pts: num(s.gap && s.gap.points), snap_win_prob_home: num(s.win_prob_home), snap_reliability_score: num(rel.score),
      snap_reliability_grade: str(rel.grade, 40), snap_research_label: str(s.research_label, 40), snap_qb: s.qb || null,
      snap_injuries: s.injuries || null, snap_model_version: str(f.model_version, 80),
      snapshot: snap, snapshot_hash: 'js1-' + P.hash(JSON.stringify(snap))
    };
  };
  /* the side EdgeDesk's number takes against the market it was compared to */
  P.edgedeskSide = function (fairHome, marketHome) {
    var f = num(fairHome), m = num(marketHome);
    if (f == null || m == null || Math.abs(f - m) < 1e-9) return null;
    return RC() ? RC().sideVsLine(f, m) : (f < m ? 'home' : 'away');
  };
  /* the win probability of the side a journal entry took, at decision time */
  P.sideWinProb = function (e) {
    var p = num(e.snap_win_prob_home);
    if (p == null || !has(['home', 'away'], e.selection)) return null;
    return e.selection === 'home' ? p : 1 - p;
  };

  /* THE CLOSE: the last market line EdgeDesk held before kickoff, from the
     state history. Nothing captured after kickoff is a close. */
  P.closeFromHistory = function (history, kickoffIso) {
    var ko = Date.parse(kickoffIso);
    if (!isFinite(ko)) return null;
    var best = null;
    (history || []).forEach(function (h) {
      var s = h && (h.state || h), m = s && s.market;
      if (!m || num(m.home_line) == null || m.stale) return;
      var at = Date.parse(m.captured_at || h.computed_at || s.computed_at);
      if (!isFinite(at) || at > ko) return;
      if (!best || at > best.at) best = { at: at, s: s };
    });
    if (!best) return null;
    var m = best.s.market, f = best.s.fair || {};
    return { home_line: m.home_line, total: num(m.total), ml_home: num(m.ml_home), ml_away: num(m.ml_away),
      captured_at: new Date(best.at).toISOString(), source: 'game_research_history' + (m.book ? ' · ' + m.book : ''),
      fair_home_line: num(f.home_line) };
  };

  /* THE GRADE of one journal entry: process (CLV) and result, kept apart. */
  P.gradeEntry = function (e, close, final) {
    var out = { clv_points: null, clv_price: null, beat_close: null, market_moved_toward_edgedesk: null,
      fair_moved_toward_market: null, result: null, note: [] };
    var R = RC();
    if (!e || e.decision !== 'wagered') { out.note.push('not a wager'); return out; }
    if (e.after_kickoff) out.note.push('recorded after kickoff, so there is no pregame close to measure it against');
    var side = e.selection, L = num(e.line);
    if (close && !e.after_kickoff) {
      if (e.market_type === 'spread' && L != null && close.home_line != null && R) {
        var entryHome = R.homeLineFromSide(L, side);
        out.clv_points = R.clvPoints(side, entryHome, close.home_line);
      } else if (e.market_type === 'total' && L != null && num(close.total) != null) {
        out.clv_points = r3(side === 'over' ? close.total - L : L - close.total);
      } else if (e.market_type === 'moneyline' && num(e.price_american) != null && R) {
        var cs = side === 'home' ? close.ml_home : close.ml_away, co = side === 'home' ? close.ml_away : close.ml_home;
        if (num(cs) != null && num(co) != null) out.clv_price = R.clvPrice(e.price_american, cs, co, true);
      }
      var v = out.clv_points != null ? out.clv_points : out.clv_price;
      out.beat_close = v == null ? null : v > 0;
      /* did the market move toward the number EdgeDesk had when the entry was made? */
      var fE = num(e.snap_fair_home_line), mE = num(e.snap_market_home_line), mC = num(close.home_line);
      if (R && fE != null && mE != null && mC != null) {
        var mv = R.movementVsModel(fE, mE, mC);
        out.market_moved_toward_edgedesk = !mv || mv.status === 'flat' || mv.status === 'model_on_line' ? null : mv.status === 'toward_model';
      }
      var fC = num(close.fair_home_line);
      if (fE != null && fC != null && mC != null && Math.abs(fC - fE) >= 0.05)
        out.fair_moved_toward_market = Math.abs(fC - mC) < Math.abs(fE - mC);
    }
    if (final && num(final.home_score) != null && num(final.away_score) != null) {
      var mh = final.home_score - final.away_score, total = final.home_score + final.away_score, x = null;
      if (e.market_type === 'spread' && L != null) x = (side === 'home' ? mh : -mh) + L;
      else if (e.market_type === 'total' && L != null) x = side === 'over' ? total - L : L - total;
      else if (e.market_type === 'moneyline') x = side === 'home' ? mh : -mh;
      if (x != null) out.result = Math.abs(x) < 1e-9 ? 'push' : (x > 0 ? 'win' : 'loss');
    }
    return out;
  };

  /* ---------------------------------------------------------- analytics
     Decision quality, not a scoreboard: CLV and beat-the-close first,
     results counted beside them and never turned into a profit figure. */
  P.relBucket = function (score) {
    var s = num(score);
    if (s == null) return 'not scored';
    if (s >= 90) return '90+'; if (s >= 80) return '80-89'; if (s >= 70) return '70-79'; if (s >= 60) return '60-69';
    return 'under 60';
  };
  var REL_ORDER = ['90+', '80-89', '70-79', '60-69', 'under 60', 'not scored'];
  function clvOf(e) { return num(e.clv_points) != null ? { v: e.clv_points, unit: 'pts' } : (num(e.clv_price) != null ? { v: e.clv_price * 100, unit: 'pp' } : null); }
  function wilson(k, n) {
    if (!n) return null;
    if (RC() && RC().wilson) { var w = RC().wilson(k, n); if (w) return { lo: w.lo != null ? w.lo : w[0], hi: w.hi != null ? w.hi : w[1] }; }
    var z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), s = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
    return { lo: (c - s) / d, hi: (c + s) / d };
  }
  function group(list, keyFn, order) {
    var by = {};
    list.forEach(function (e) { var k = keyFn(e); (by[k] = by[k] || []).push(e); });
    var keys = Object.keys(by);
    if (order) keys.sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); }); else keys.sort();
    return keys.map(function (k) { return Object.assign({ key: k }, summary(by[k])); });
  }
  function summary(list) {
    var pts = [], pp = [], beat = 0, withClv = 0, res = { win: 0, loss: 0, push: 0, void: 0, pending: 0 };
    list.forEach(function (e) {
      if (num(e.clv_points) != null) pts.push(e.clv_points);
      if (num(e.clv_price) != null) pp.push(e.clv_price * 100);
      if (e.beat_close != null) { withClv++; if (e.beat_close) beat++; }
      res[e.result && res[e.result] != null ? e.result : 'pending']++;
    });
    function avg(a) { return a.length ? r3(a.reduce(function (x, y) { return x + y; }, 0) / a.length) : null; }
    return { n: list.length, clv_n: withClv, beat_close: beat, beat_close_rate: withClv ? r3(beat / withClv) : null,
      beat_close_ci: withClv ? wilson(beat, withClv) : null, avg_clv_points: avg(pts), clv_points_n: pts.length,
      avg_clv_price_pp: avg(pp), clv_price_n: pp.length, results: res };
  }
  function isoWeek(ms) {
    var d = new Date(ms); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
    var w1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    return d.getUTCFullYear() + '-W' + ('0' + (1 + Math.round(((d - w1) / 864e5 - 3 + ((w1.getUTCDay() + 6) % 7)) / 7))).slice(-2);
  }
  P.SMALL_SAMPLE = 30;
  P.analytics = function (entries, opts) {
    var now = (opts && opts.now) || Date.now(), sinceDays = opts && opts.since_days;
    var all = (entries || []).filter(function (e) {
      if (!sinceDays) return true;
      var t = Date.parse(e.created_at); return isFinite(t) && now - t <= sinceDays * 864e5;
    });
    var counts = { total: all.length };
    P.DECISIONS.forEach(function (d) { counts[d] = all.filter(function (e) { return e.decision === d; }).length; });
    var wag = all.filter(function (e) { return e.decision === 'wagered'; });
    var gaps = all.map(function (e) { return num(e.snap_gap_pts); }).filter(function (x) { return x != null; });
    var sorted = wag.slice().sort(function (a, b) { return Date.parse(b.created_at) - Date.parse(a.created_at); });
    var graded = sorted.filter(function (e) { return e.beat_close != null; });
    var recent = graded.slice(0, 20), prior = graded.slice(20, 40);
    function avgClv(list) {
      var v = list.map(clvOf).filter(function (x) { return x && x.unit === 'pts'; }).map(function (x) { return x.v; });
      return v.length ? r3(v.reduce(function (a, b) { return a + b; }, 0) / v.length) : null;
    }
    /* weekly series: last 12 ISO weeks that have a graded wager */
    var weeks = {};
    graded.forEach(function (e) { var k = isoWeek(Date.parse(e.created_at)); (weeks[k] = weeks[k] || []).push(e); });
    var series = Object.keys(weeks).sort().slice(-12).map(function (k) { return Object.assign({ week: k }, summary(weeks[k])); });
    /* the reader against EdgeDesk: which side EdgeDesk's number took when the
       entry was made, beside the side the reader took */
    var withEd = [], againstEd = [], noSide = 0;
    all.forEach(function (e) {
      if (!has(['home', 'away'], e.selection) || e.market_type === 'total') { noSide++; return; }
      var ed = P.edgedeskSide(e.snap_fair_home_line, e.snap_market_home_line);
      if (!ed) { noSide++; return; }
      (ed === e.selection ? withEd : againstEd).push(e);
    });
    return {
      as_of: new Date(now).toISOString(),
      counts: counts,
      process: summary(wag),
      avg_gap_at_entry: gaps.length ? r3(gaps.reduce(function (a, b) { return a + b; }, 0) / gaps.length) : null,
      by_reliability: group(wag, function (e) { return P.relBucket(e.snap_reliability_score); }, REL_ORDER),
      by_league: group(wag, function (e) { return String(e.game_key || '').split('|')[0] || 'unknown'; }),
      by_market: group(wag, function (e) { return e.market_type || 'unknown'; }),
      weekly: series,
      trend: { recent_n: recent.length, recent_avg_clv_points: avgClv(recent), prior_n: prior.length, prior_avg_clv_points: avgClv(prior),
        recent_beat_rate: recent.length ? r3(recent.filter(function (e) { return e.beat_close; }).length / recent.length) : null },
      recent: sorted.slice(0, 10).map(function (e) {
        return { entry_id: e.entry_id, game_key: e.game_key, matchup: (e.away || '?') + ' @ ' + (e.home || '?'), created_at: e.created_at,
          market_type: e.market_type, selection: e.selection, line: e.line, price_american: e.price_american,
          clv_points: num(e.clv_points), clv_price: num(e.clv_price), beat_close: e.beat_close == null ? null : !!e.beat_close,
          result: e.result || null, reliability: num(e.snap_reliability_score) };
      }),
      versus_edgedesk: { with_edgedesk: summary(withEd), against_edgedesk: summary(againstEd), no_side: noSide,
        against_games: againstEd.slice(0, 10).map(function (e) {
          var ed = P.edgedeskSide(e.snap_fair_home_line, e.snap_market_home_line);
          function team(side) { return side === 'home' ? (e.home || 'home') : (side === 'away' ? (e.away || 'away') : null); }
          return { game_key: e.game_key, matchup: (e.away || '?') + ' @ ' + (e.home || '?'),
            decision: e.decision, selection: e.selection, selection_team: team(e.selection), edgedesk_side: ed, edgedesk_team: team(ed),
            created_at: e.created_at, beat_close: e.beat_close == null ? null : !!e.beat_close }; }) },
      sample_note: wag.length < P.SMALL_SAMPLE
        ? 'Small sample: ' + wag.length + ' wager' + (wag.length === 1 ? '' : 's') + '. CLV needs a few hundred decisions before it says much.'
        : null
    };
  };

  /* ---------------------------------------------------------- preferences */
  P.validatePrefs = function (p) {
    var errs = [];
    var leagues = (p && p.leagues) || [], books = (p && p.books) || [], interests = (p && p.interests) || [];
    var lk = P.LEAGUES.map(function (l) { return l.key; }), ik = P.INTERESTS.map(function (i) { return i.key; });
    leagues.forEach(function (l) { if (lk.indexOf(l) < 0) errs.push('unknown league ' + l); });
    interests.forEach(function (i) { if (ik.indexOf(i) < 0) errs.push('unknown interest ' + i); });
    books.forEach(function (b) { if (!/^[a-z0-9_]{2,40}$/.test(b)) errs.push('unknown book ' + b); });
    if (books.length > 40) errs.push('too many books');
    return { ok: errs.length === 0, errors: errs };
  };

  /* ---------------------------------------------- questions about the reader
     The browser sends a question that matches this to the research desk
     rather than answering it from whatever card is open; the desk's own
     classifier (supabase/functions/edgedesk_ai/_mine.js) decides what it is. */
  P.PERSONAL_Q = /compare my (own )?numbers?|\bmy (own )?(numbers?|fair (lines?|spreads?|totals?))\b|\b(my|i)\b[^?]{0,60}\b(watch ?list|watched|alerts?|journal|clv|closing line|decisions?|wagers?|bets?)\b|\bwatch(ed| ?list)\b|research[- ]grade|worth research|top (5|five) games|five games|most (different|disagree)|disagreement but low reliab|high (disagreement|gap)[^?]{0,30}low reliab|after (the )?(qb|quarterback) (was )?confirm|reliability (change|drop|jump|went|go|rise|fall|move)|why did[^?]{0,60}reliability/i;

  /* ----------------------------------------------------- compare my number
     THE READER'S NUMBER beside EdgeDesk's and the market's. Every number in
     the answer is the reader's own, one of the state's, or the difference
     between two of them; every input named is one the state carries. The
     words describe; they never rank the reader's number against EdgeDesk's.

     mine: {home_line, total}   home_line: negative = home favoured (the
     convention every *_home_line uses). A reader enters a team and that
     team's number; parseTeamLine turns it into a home line. */
  P.CMP_SAME = 0.5;      /* inside half a point: effectively the same number */
  P.CMP_CLOSE = 1.5;     /* under a point and a half: close */
  P.CMP_MATERIAL = 3;    /* three points or more: a material difference */
  P.NEUTRAL_NOTE = 'Neither number is declared right here. Over many games, the closing line — and your journal’s record against it — is the measure.';
  P.parseLine = function (txt) {
    if (txt == null) return null;
    var t = String(txt).trim().toLowerCase().replace(/−/g, '-');
    if (!t) return null;
    if (/^(pk|pick|pick'?em|pick’em|even)$/.test(t)) return 0;
    if (!/^[+-]?\d{1,3}(\.\d{1,2})?$/.test(t)) return NaN;
    return parseFloat(t);
  };
  P.parseTeamLine = function (s, side, txt) {
    var v = P.parseLine(txt);
    if (v == null || !isFinite(v)) return v;
    if (side !== 'home' && side !== 'away') return NaN;
    var h = side === 'home' ? v : -v;
    return h === 0 ? 0 : h;
  };
  P.validateMyNumbers = function (m) {
    var errs = [], h = m ? m.home_line : null, t = m ? m.total : null;
    if ((h == null) && (t == null)) errs.push('enter your fair spread, your fair total, or both');
    if (h != null && !(typeof h === 'number' && isFinite(h) && h >= -100 && h <= 100)) errs.push('your spread must be a number like -3.5, +7 or PK');
    if (t != null && !(typeof t === 'number' && isFinite(t) && t >= 0 && t <= 400)) errs.push('your total must be a number like 47.5');
    return { ok: errs.length === 0, errors: errs };
  };
  function favOf(h) { return h == null ? null : (h < 0 ? 'home' : (h > 0 ? 'away' : null)); }
  function teamOf(s, side) { return side === 'home' ? s.home : (side === 'away' ? s.away : null); }
  /* "a is 2.5 pts more favourable to Florida than b" */
  function lean(s, a, b) {
    if (a == null || b == null) return null;
    var d = r1(Math.abs(a - b));
    if (d < 0.05) return { pts: 0, side: null, team: null };
    var side = a < b ? 'home' : 'away';
    return { pts: d, side: side, team: teamOf(s, side) };
  }
  function magnitude(pts) {
    if (pts < P.CMP_SAME) return 'effectively the same number';
    if (pts < P.CMP_CLOSE) return 'close';
    if (pts < P.CMP_MATERIAL) return 'a moderate difference';
    return 'a material difference';
  }
  function ptsText(x) { return x.toFixed(1) + (x === 1 ? ' pt' : ' pts'); }
  function vsText(s, l, who, whom) {
    if (!l) return null;
    if (!l.pts) return who + ' and ' + whom + ' are the same number.';
    return who + ' is ' + ptsText(l.pts) + ' more favourable to ' + l.team + ' than ' + whom + '.';
  }
  P.compareNumber = function (s, mine) {
    var out = { ok: false, reasons: [], spread: null, total: null, agrees: [], differs: [], inputs: [], context: [], note: P.NEUTRAL_NOTE };
    if (!s) { out.reasons.push('EdgeDesk holds no research state for this game'); return out; }
    var v = P.validateMyNumbers(mine || {});
    if (!v.ok) { out.reasons = v.errors; return out; }
    out.ok = true; out.game_key = s.game_key; out.matchup = P.matchup(s);
    var f = s.fair || {}, m = s.market || {}, rel = s.reliability || {}, q = s.qb || {}, inj = s.injuries || {};
    var ed = num(f.home_line), mk = m.stale ? null : num(m.home_line), my = num(mine.home_line);
    var edT = num(f.total), mkT = m.stale ? null : num(m.total), myT = num(mine.total);
    if (m.stale && num(m.home_line) != null) out.context.push('The market quote EdgeDesk holds is stale, so the market is left out of the comparison.');
    else if (m.kind === 'consensus') out.context.push('The market number is a consensus reference, not a captured sportsbook quote.');

    /* ---- the spread ---- */
    if (my != null) {
      var sp = out.spread = {
        mine_home: my, edgedesk_home: ed, market_home: mk,
        mine_text: P.favText(s, my), edgedesk_text: ed != null ? (f.text || P.favText(s, ed)) : null,
        market_text: mk != null ? (m.text || P.favText(s, mk)) : null,
        mine_vs_edgedesk: lean(s, my, ed), mine_vs_market: lean(s, my, mk), edgedesk_vs_market: lean(s, ed, mk)
      };
      sp.lines = [vsText(s, sp.mine_vs_edgedesk, 'Your number', 'EdgeDesk’s'), vsText(s, sp.mine_vs_market, 'Your number', 'the market’s'),
        vsText(s, sp.edgedesk_vs_market, 'EdgeDesk’s number', 'the market’s')].filter(Boolean);
      if (ed == null) out.differs.push('EdgeDesk has no fair spread for this game yet, so there is nothing to compare your spread with.');
      else {
        var d = sp.mine_vs_edgedesk.pts, fm = favOf(my), fe = favOf(ed);
        /* who each number makes the favourite */
        if (fm === fe) out.agrees.push(fm ? 'You and EdgeDesk both make ' + teamOf(s, fm) + ' the favourite.' : 'You and EdgeDesk both have it a pick’em.');
        else out.differs.push((fm ? 'You make ' + teamOf(s, fm) + ' the favourite' : 'You have it a pick’em') + '; '
          + (fe ? 'EdgeDesk makes ' + teamOf(s, fe) + ' the favourite.' : 'EdgeDesk has it a pick’em.'));
        /* how far apart */
        if (d < P.CMP_SAME) out.agrees.push('Your spread and EdgeDesk’s are within half a point: ' + magnitude(d) + '.');
        else (d < P.CMP_CLOSE ? out.agrees : out.differs).push('Your spread and EdgeDesk’s are ' + ptsText(d) + ' apart — ' + magnitude(d)
          + '. ' + vsText(s, sp.mine_vs_edgedesk, 'Your number', 'EdgeDesk’s'));
        /* which side of the market each number sits on */
        if (mk != null) {
          var sm = P.edgedeskSide(my, mk), se = P.edgedeskSide(ed, mk), mt = sp.market_text;
          if (sm && sm === se) out.agrees.push('Both numbers sit on the ' + teamOf(s, sm) + ' side of the market (' + mt + ').');
          else if (!sm && !se) out.agrees.push('Both numbers match the market (' + mt + ').');
          else if (!sm) out.differs.push('Your number matches the market (' + mt + '); EdgeDesk’s sits on the ' + teamOf(s, se) + ' side of it.');
          else if (!se) out.differs.push('EdgeDesk’s number matches the market (' + mt + '); yours sits on the ' + teamOf(s, sm) + ' side of it.');
          else out.differs.push('Your number sits on the ' + teamOf(s, sm) + ' side of the market (' + mt + '); EdgeDesk’s sits on the ' + teamOf(s, se) + ' side.');
        } else out.context.push('There is no current market number to place either spread against.');
        /* a key number between the two */
        if (d >= P.CMP_SAME && RC() && RC().keyNumberCrossings) {
          var kc = (RC().keyNumberCrossings(ed, my, s.sport === 'nfl' ? 'NFL' : 'CFB') || []).filter(function (k) { return k.tier === 'primary' && k.kind === 'crossed'; });
          if (kc.length) out.differs.push('The key number ' + kc[0].key + ' lies between your number and EdgeDesk’s; football margins land on it more often than on the numbers around it.');
        }
        /* THE INPUTS the difference runs through */
        out.inputs = P.disagreementInputs(s, my, ed);
      }
    }

    /* ---- the total ---- */
    if (myT != null) {
      var tt = out.total = { mine: myT, edgedesk: edT, market: mkT,
        mine_vs_edgedesk: edT == null ? null : r1(myT - edT), mine_vs_market: mkT == null ? null : r1(myT - mkT),
        edgedesk_vs_market: (edT == null || mkT == null) ? null : r1(edT - mkT) };
      function tl(x, who, whom) { return x == null ? null : (Math.abs(x) < 0.05 ? who + ' and ' + whom + ' are the same total.' : who + ' is ' + ptsText(Math.abs(x)) + ' ' + (x > 0 ? 'higher' : 'lower') + ' than ' + whom + '.'); }
      tt.lines = [tl(tt.mine_vs_edgedesk, 'Your total', 'EdgeDesk’s'), tl(tt.mine_vs_market, 'Your total', 'the market’s'), tl(tt.edgedesk_vs_market, 'EdgeDesk’s total', 'the market’s')].filter(Boolean);
      if (edT == null) out.differs.push('EdgeDesk publishes no fair total for this game, so your total can only be set against the market.');
      else {
        var dt = Math.abs(tt.mine_vs_edgedesk);
        (dt < P.CMP_CLOSE ? out.agrees : out.differs).push('Your total and EdgeDesk’s are ' + (dt < 0.05 ? 'the same' : ptsText(dt) + ' apart — ' + magnitude(dt)) + '.');
        if (mkT != null && dt >= 0.05) {
          var mo = myT > mkT ? 'over' : (myT < mkT ? 'under' : null), eo = edT > mkT ? 'over' : (edT < mkT ? 'under' : null);
          if (mo && mo === eo) out.agrees.push('Both totals sit ' + (mo === 'over' ? 'above' : 'below') + ' the market total (' + mkT + ').');
          else if (mo && eo) out.differs.push('Your total sits ' + (mo === 'over' ? 'above' : 'below') + ' the market total (' + mkT + '); EdgeDesk’s sits ' + (eo === 'over' ? 'above' : 'below') + ' it.');
        }
        if (dt >= P.CMP_SAME) out.inputs.push({ kind: 'total', text: 'EdgeDesk does not itemise its total into measured inputs, so a difference in totals cannot be traced to one of them.' });
      }
    }

    /* ---- what EdgeDesk knew, whichever way the numbers point ---- */
    ['away', 'home'].forEach(function (side) {
      var x = q[side], t = s[side];
      if (!x) return;
      if (!x.confirmed) out.context.push('EdgeDesk’s number uses ' + (x.name || 'an expected starter') + ' at quarterback for ' + t + ', not yet confirmed. If your number assumes a different starter, that input differs.');
    });
    if (q.confirmed_both) out.context.push('Both starting quarterbacks are confirmed in EdgeDesk’s inputs.');
    ['away', 'home'].forEach(function (side) {
      var x = inj[side];
      if (!x) return;
      if (x.known === false) out.context.push('EdgeDesk has no availability report on file for ' + s[side] + '. If your number accounts for absences there, that is an input EdgeDesk does not have.');
      else if (x.known) out.context.push('EdgeDesk’s availability input — ' + injSummary(s[side], x) + '.');
    });
    var rs = num(rel.score);
    if (rs != null) out.context.push('EdgeDesk’s reliability for this game is ' + Math.round(rs) + (rel.grade ? ' (' + String(rel.grade).toLowerCase() + ')' : '')
      + (rel.main_deduction && rs < 90 ? '; its main deduction: ' + String(rel.main_deduction).replace(/\.$/, '') + '.' : '.')
      + (rs < P.LOW_RELIABILITY ? ' With inputs this incomplete, a difference is as often missing information as a different view.' : ''));
    else out.context.push(s.sport === 'nfl' ? 'The NFL model publishes no reliability score for its inputs.' : 'Reliability is not measured for this game.');
    var mv = s.movement || {};
    if (num(mv.toward_model) != null && Math.abs(mv.toward_model) >= 0.5)
      out.context.push('Since the open the market has moved ' + Math.abs(mv.toward_model).toFixed(1) + ' pts ' + (mv.toward_model > 0 ? 'toward' : 'away from') + ' EdgeDesk’s number.');
    var asOf = s.computed_at && isFinite(Date.parse(s.computed_at)) ? new Date(Date.parse(s.computed_at)).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : null;
    if (f.model_version || asOf) out.context.push('EdgeDesk’s numbers: ' + [f.model_version, asOf ? 'as of ' + asOf : null].filter(Boolean).join(', ') + '.');
    out.agrees = out.agrees.filter(P.copyOk); out.differs = out.differs.filter(P.copyOk); out.context = out.context.filter(P.copyOk);
    return out;
  };
  /* The measured inputs a spread difference runs through. EdgeDesk's drivers
     are the engine's own additive terms on the side its fair line favours
     (lib/cfb_research_view.js leanReasons); nothing else is itemised. */
  P.disagreementInputs = function (s, my, ed) {
    var out = [], d = Math.abs(my - ed);
    if (d < P.CMP_SAME) { out.push({ kind: 'none', text: 'There is no material spread difference to trace.' }); return out; }
    var leanSide = favOf(ed), leanTeam = teamOf(s, leanSide);
    var edMore = ed < my ? 'home' : 'away';           /* EdgeDesk is more favourable to this side than you */
    var drivers = (s.drivers || []).filter(function (x) { return x && num(x.points) != null && x.points > 0; })
      .slice().sort(function (a, b) { return b.points - a.points; });
    if (!drivers.length || !leanSide) {
      out.push({ kind: 'unitemised', text: 'This game’s research state carries no itemised breakdown of EdgeDesk’s number'
        + (s.sport === 'nfl' ? ' (the NFL model’s fair line is not published term by term)' : '') + ', so the ' + ptsText(r1(d)) + ' difference cannot be traced to a single measured input.' });
      return out;
    }
    var sum = r1(drivers.reduce(function (a, x) { return a + x.points; }, 0));
    if (edMore === leanSide) {
      /* EdgeDesk credits its favourite with more than you do: its drivers are where */
      var acc = 0, used = [];
      for (var i = 0; i < drivers.length; i++) { used.push(drivers[i]); acc += drivers[i].points; if (acc >= d) break; }
      out.push({ kind: 'drivers', text: 'EdgeDesk’s number is ' + ptsText(r1(d)) + ' more favourable to ' + leanTeam + ' than yours. The measured inputs behind that lean: '
        + used.map(function (x) { return '+' + x.points.toFixed(1) + ' ' + x.text; }).join(', ')
        + (used.length < drivers.length ? ' (of ' + drivers.length + ' itemised terms totalling ' + sum.toFixed(1) + ' pts)' : '') + '.' });
      if (drivers[0].points >= d) out.push({ kind: 'driver_alone', text: 'The largest of them, ' + drivers[0].text + ' (+' + drivers[0].points.toFixed(1) + '), is on its own as large as the whole difference. If your number weighs it less, that is where the difference sits.' });
      else if (acc >= d) out.push({ kind: 'drivers_sum', text: 'No single input is as large as the difference; it takes the ' + used.length + ' largest together (' + r1(acc).toFixed(1) + ' pts) to cover it.' });
      else out.push({ kind: 'drivers_short', text: 'Together the itemised inputs total ' + r1(acc).toFixed(1) + ' of the ' + r1(d).toFixed(1)
        + ' pts; the rest runs through smaller terms EdgeDesk does not list one by one.' });
      out.drivers = used;
    } else {
      /* you credit EdgeDesk's favourite with more than EdgeDesk does */
      out.push({ kind: 'beyond', text: 'Your number is ' + ptsText(r1(d)) + ' more favourable to ' + leanTeam + ' than EdgeDesk’s. EdgeDesk’s measured inputs for ' + leanTeam
        + ' total ' + sum.toFixed(1) + ' pts (' + drivers.slice(0, 3).map(function (x) { return '+' + x.points.toFixed(1) + ' ' + x.text; }).join(', ')
        + '); your number goes further than they do, so the difference lies in something EdgeDesk either weighs less or does not measure.' });
    }
    return out;
  };

  /* Once the close is on file: how far each number was from it. A distance,
     not a verdict — one game says little about either number. */
  P.numbersVsClose = function (e) {
    var c = num(e && e.close_home_line), ct = num(e && e.close_total);
    var my = num(e && e.my_home_line), ed = num(e && e.snap_fair_home_line), mk = num(e && e.snap_market_home_line);
    var myT = num(e && e.my_total), edT = num(e && e.snap_fair_total);
    function dist(a, b) { return a == null || b == null ? null : r1(Math.abs(a - b)); }
    return { close_home_line: c, close_total: ct, mine: dist(my, c), edgedesk: dist(ed, c), market_then: dist(mk, c),
      mine_total: dist(myT, ct), edgedesk_total: dist(edT, ct) };
  };
  P.numbersSummary = function (entries) {
    var list = (entries || []).filter(function (e) { return num(e.my_home_line) != null || num(e.my_total) != null; });
    var graded = list.map(P.numbersVsClose).filter(function (x) { return x.mine != null && x.edgedesk != null; });
    function avg(a) { return a.length ? r3(a.reduce(function (x, y) { return x + y; }, 0) / a.length) : null; }
    var apart = list.map(function (e) { return num(e.my_home_line) != null && num(e.snap_fair_home_line) != null ? Math.abs(e.my_home_line - e.snap_fair_home_line) : null; })
      .filter(function (x) { return x != null; });
    return { n: list.length, spreads: list.filter(function (e) { return num(e.my_home_line) != null; }).length,
      totals: list.filter(function (e) { return num(e.my_total) != null; }).length,
      avg_apart_from_edgedesk: avg(apart), graded: graded.length,
      avg_mine_from_close: avg(graded.map(function (x) { return x.mine; })), avg_edgedesk_from_close: avg(graded.map(function (x) { return x.edgedesk; })),
      mine_nearer: graded.filter(function (x) { return x.mine < x.edgedesk; }).length,
      edgedesk_nearer: graded.filter(function (x) { return x.edgedesk < x.mine; }).length,
      level: graded.filter(function (x) { return x.edgedesk === x.mine; }).length,
      sample_note: graded.length < P.SMALL_SAMPLE ? 'Small sample: ' + graded.length + ' of your numbers have a close on file. A few dozen games say little about any number.' : null };
  };

  /* ---------------------------------------------------------- affiliates */
  P.normCode = function (v) {
    if (v == null) return null;
    var s = String(v).trim().toUpperCase();
    return /^[A-Z0-9_-]{3,32}$/.test(s) ? s : null;
  };
  P.validVisitor = function (v) { return typeof v === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(v); };
  P.money = function (cents, currency) {
    var c = num(cents);
    if (c == null) return '—';
    var s = (Math.abs(c) / 100).toFixed(2);
    return (c < 0 ? '−' : '') + (String(currency || 'USD').toUpperCase() === 'USD' ? '$' : '') + s;
  };

  return P;
});
/*__EDPERSONAL_END__*/
