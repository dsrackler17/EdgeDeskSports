/* ============================================================================
   EdgeDesk CFB — the explanation fact boundary (brief §90-91).
   docs/cfb-production/SECURITY.md §5.

   An LLM may EXPLAIN a CFB prediction. It may not decide one, change one, or
   add to one. This file is the whole boundary, ES5 so the browser, node and the
   Deno edge function can all load it:

     cfbFacts(src)              the ONLY facts an explanation may use, built
                                from the stored canonical prediction (a Model
                                Lab snapshot row, or the V2 pure projection +
                                decision): teams, kickoff, model version, fair
                                line, margin, win probability, interval, the
                                market line and its status, the OFFICIAL
                                decision, each quarterback's status (CONFIRMED
                                only when the source says so), data quality and
                                degraded modes. Nothing else crosses.
     buildPrompt(facts)         system + user text: restate only these facts,
                                state uncertainty, no tools, no browsing, no
                                number that is not in the facts
     auditExplanation(t, facts) the refusal rules: a BET claim on a non-BET, a
                                status word that is not the official one, "QB
                                confirmed" when the status is not CONFIRMED, a
                                number not in the facts, a reversed side, a
                                metric the facts do not carry, promise language,
                                a degraded prediction presented without its
                                uncertainty
     render(facts)              the deterministic explanation (always passes
                                its own audit): what is shown when the LLM's text
                                is refused
     explain(facts, llm)        llm(prompt) -> text; audited; refused text is
                                replaced by render(facts). The status, the side
                                and every number come from `facts`, never from
                                the model's text.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EDCfbExplain = api;
}(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var VERSION = 'cfb_explanation_boundary_v1';
  var STATUSES = ['BET', 'LEAN', 'RESEARCH', 'PASS', 'NO BET'];
  /* metrics an explanation may name only when the facts carry them */
  var METRICS = [
    [/\bEPA\b|expected points added/i, 'epa'], [/success rate/i, 'success_rate'], [/\bSP\+|\bSP plus\b/i, 'sp_plus'],
    [/\bFPI\b/i, 'fpi'], [/\bELO\b/i, 'elo'], [/\bATS record\b|\bagainst the spread record\b|\b\d+-\d+ ATS\b/i, 'ats_record'],
    [/\bCLV\b|closing line value/i, 'clv'], [/sharp money|sharps\b|steam move|reverse line movement/i, 'sharp_money'],
    [/public (money|betting|percentage|%)|% of (the )?(bets|money|tickets)/i, 'public_betting'],
    [/\bhandle\b/i, 'handle'], [/havoc rate|explosive play rate|red zone (efficiency|rate)/i, 'advanced_unit'],
    [/injur(y|ies|ed)\b/i, 'injuries'], [/weather|wind|rain|snow/i, 'weather']
  ];
  var PROMISE = [/guarantee/i, /\block\b/i, /risk[- ]?free/i, /can'?t lose/i, /sure thing/i, /free money/i, /\bcertain(ly)? (to )?(win|cover)\b/i];
  var BET_CLAIM = [/\b(best|strong|great|top) (bet|play)\b/i, /\bhammer\b/i, /\bmax play\b/i, /\b(we|i|edgedesk) (like|love|recommend|back)\b/i,
    /\brecommend(ed|s)?\b(?![^.]*\bnot\b)/i, /\b(bet|play|take|back|wager on) (the )?[A-Z][A-Za-z.&'() -]{1,40} ?[+-]\d/, /\bofficial (bet|play|pick)\b/i, /\bis a bet\b/i];
  var QB_CONFIRMED = /\b(confirmed|announced|named (the |as )?(the )?start(er|ing)|will start|is starting|officially starting|set to start|gets the start)\b/i;
  var UNCERTAINTY = /\buncertain|uncertainty|limited|stale|incomplete|unavailable|not confirmed|unconfirmed|unknown|degraded|missing|caution|could be wrong|may be\b/i;

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function num(x) { if (x === null || x === undefined || x === '' || typeof x === 'boolean') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function r(x, k) { if (!isNum(x)) return null; var m = Math.pow(10, k == null ? 2 : k); return Math.round(x * m) / m; }
  function esc(s) { return String(s == null ? '' : s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /* ----------------------------------------------------------- the facts */
  var STATUS_OF = { BET: 'BET', LEAN: 'LEAN', RESEARCH: 'RESEARCH', REVIEW: 'RESEARCH', PASS: 'PASS', NOT_PRICED: 'PASS', NO_BET: 'NO BET' };
  function qbStatus(x) {
    if (!x) return { status: 'UNKNOWN', name: null };
    var st = String(x.status || '');
    if (x.confirmed === true || /CONFIRMED|ANNOUNCED/i.test(st)) return { status: 'CONFIRMED', name: x.player_name || null };
    if (/PREVIOUS_GAME|PROBABLE|EXPECTED/i.test(st)) return { status: 'PROBABLE', name: x.player_name || null };
    if (/UNSETTLED|CONTESTED|QUESTIONABLE|DOUBTFUL|OUT/i.test(st)) return { status: 'UNSETTLED', name: x.player_name || null };
    return { status: 'UNKNOWN', name: x.player_name || null };
  }
  /* src: a Model Lab snapshot row (preferred: it is the stored canonical
     prediction), or { pure, decision, card, qb, data_quality, market } */
  function cfbFacts(src) {
    src = src || {};
    var row = src.prediction_id ? src : null;
    var pure = src.pure || {};
    var dec = src.decision || {};
    var f = { version: VERSION, game: {}, model: {}, market: null, decision: {}, qb: {}, data_quality: {}, degraded: [], allowed_metrics: {} };
    f.game = { home: row ? row.home_team : (pure.home || null), away: row ? row.away_team : (pure.away || null), kickoff: row ? row.kickoff_ts : (pure.kickoff || null),
      neutral_site: row ? !!row.neutral_site : !!pure.neutral_site, week: row ? row.week : (pure.week || null), season: row ? row.season : (pure.season || null) };
    var margin = row ? num(row.pure_home_margin) : num(pure.projected_margin);
    var pHome = row ? num(row.home_win_probability) : num(pure.home_win_prob);
    f.model = { model_version: row ? row.model_version : (pure.model_version || null), home_margin: r(margin, 1),
      fair_line_display: row ? row.fair_spread_display : (pure.fair_spread_display || null), home_win_probability: r(pHome, 3),
      interval_80: row && isNum(num(row.interval_80_low)) ? [r(num(row.interval_80_low), 1), r(num(row.interval_80_high), 1)]
        : (pure.intervals && pure.intervals.p80 ? [r(pure.intervals.p80[0], 1), r(pure.intervals.p80[1], 1)] : null) };
    var hl = row ? num(row.current_spread) : (src.market ? num(src.market.home_line) : null);
    if (isNum(hl)) {
      var mi = row && row.inputs_ref && row.inputs_ref.market_integrity;
      f.market = { home_line: hl, as_of: row ? row.market_as_of : (src.market && src.market.as_of) || null,
        books: row ? row.sportsbook_count : (src.market && src.market.books) || null, stale: row ? !!row.market_stale : !!(src.market && src.market.stale),
        actionable_status: mi ? mi.actionable_status : (src.market && src.market.actionable_status) || null,
        gap: row ? r(num(row.model_market_gap), 1) : (isNum(margin) ? r(margin + hl, 1) : null) };
    }
    var status = row ? (row.decision_class === 'PASS' || !row.decision_class ? 'PASS' : row.decision_class) : (STATUS_OF[dec.status] || 'PASS');
    if (row && row.decision_class) status = row.decision_class;
    f.decision = { status: status, side: row ? row.side || null : dec.side || null, line: row ? num(row.recommended_line) : num(dec.line_for_side),
      price: row ? num(row.recommended_price) : num(dec.price), cover_probability: row ? r(num(row.cover_probability), 3) : r(num(dec.cover_probability || dec.decision_cover_probability), 3),
      reason: row ? (row.pass_reason || row.decision_reason || null) : ((dec.reasons || [])[0] || null), bet_enabled: row ? !!row.bet_enabled : !!dec.bet_enabled };
    var qbx = (row && row.inputs_ref && row.inputs_ref.qb_expected) || src.qb || {};
    f.qb = { home: qbStatus(qbx.home), away: qbStatus(qbx.away) };
    var dq = row ? { status: row.data_quality_status, issues: (row.data_quality_issues || []).map(function (c) { return c.check + ':' + c.status; }) } : (src.data_quality || { status: null, issues: [] });
    f.data_quality = dq;
    if (dq.status === 'RED' || dq.status === 'YELLOW') f.degraded.push('data quality ' + dq.status);
    if (f.qb.home.status !== 'CONFIRMED' || f.qb.away.status !== 'CONFIRMED') f.degraded.push('a starting quarterback is not confirmed');
    if (f.market && f.market.actionable_status && f.market.actionable_status !== 'ACTIONABLE') f.degraded.push('market ' + f.market.actionable_status);
    if (!f.market) f.degraded.push('no market line');
    (src.allowed_metrics || []).forEach(function (m) { f.allowed_metrics[m] = true; });
    f.numbers = allowedNumbers(f);
    return f;
  }
  function allowedNumbers(f) {
    var xs = [];
    var add = function (x) { if (isNum(x)) { xs.push(x); xs.push(-x); xs.push(Math.abs(x)); } };
    add(f.model.home_margin); add(r(f.model.home_margin, 0)); add(Math.round(Math.abs(f.model.home_margin || 0) * 2) / 2);
    if (isNum(f.model.home_win_probability)) { add(r(100 * f.model.home_win_probability, 1)); add(r(100 * (1 - f.model.home_win_probability), 1)); add(r(100 * f.model.home_win_probability, 0)); add(r(100 * (1 - f.model.home_win_probability), 0)); }
    (f.model.interval_80 || []).forEach(add); add(80);
    if (f.market) { add(f.market.home_line); add(f.market.gap); add(f.market.books); }
    add(f.decision.line); add(f.decision.price);
    if (isNum(f.decision.cover_probability)) { add(r(100 * f.decision.cover_probability, 1)); add(r(100 * f.decision.cover_probability, 0)); }
    add(f.game.week); add(f.game.season);
    var m = /(-?\d+(\.\d+)?)/.exec(f.model.fair_line_display || ''); if (m) add(Number(m[1]));
    return xs;
  }

  /* ---------------------------------------------------------- the prompt */
  function buildPrompt(facts) {
    var system = [
      'You explain one EdgeDesk college football prediction to a reader. You are not deciding anything.',
      'Use ONLY the facts in the FACTS block. Do not browse, search, call tools, or use outside knowledge about injuries, weather, news or betting markets.',
      'Every number you write must appear in FACTS exactly (rounded to its shown precision). Do not compute new numbers.',
      'The official decision is ' + facts.decision.status + '. Use that word and no other status word. Never call a non-BET a bet, a play, a pick or a recommendation.',
      'A quarterback is "confirmed" only if FACTS says CONFIRMED for him. Otherwise say his status is ' + 'not confirmed.',
      'Name no metric (EPA, success rate, SP+, CLV, public money, injuries, weather...) that FACTS does not carry.',
      'State the uncertainty plainly' + (facts.degraded.length ? ': ' + facts.degraded.join('; ') + '.' : '.'),
      'Never promise an outcome. An edge is an expected value and any single game can lose.',
      'Home margin is from the home team\'s side: positive means the home team is expected to win by that many. A home line of -7 means the home team is favoured by 7.'
    ].join('\n');
    var user = 'FACTS (' + VERSION + '):\n' + JSON.stringify({ game: facts.game, model: facts.model, market: facts.market, decision: facts.decision, qb: facts.qb,
      data_quality: facts.data_quality, degraded: facts.degraded }, null, 1) + '\n\nWrite at most four sentences.';
    return { system: system, user: user, tools: [], version: VERSION };
  }

  /* ----------------------------------------------------------- the audit */
  function auditExplanation(text, facts) {
    var t = String(text || ''), issues = [];
    var add = function (code, sev, detail) { issues.push({ code: code, severity: sev, detail: detail }); };
    var st = facts.decision.status;
    PROMISE.forEach(function (re) { if (re.test(t)) add('PROMISE_LANGUAGE', 'FAIL', 'forbidden promise: ' + re); });
    if (st !== 'BET') {
      BET_CLAIM.forEach(function (re) { if (re.test(t)) add('BET_CLAIM_NOT_OFFICIAL', 'FAIL', 'claims a bet while the official decision is ' + st + ': ' + re); });
      if (/\bBET\b/.test(t.replace(/NO BET/g, ''))) add('BET_CLAIM_NOT_OFFICIAL', 'FAIL', 'the word BET appears while the official decision is ' + st);
    }
    /* status words are UPPERCASE in EdgeDesk copy ("pass defense" is football) */
    STATUSES.filter(function (w) { return w !== 'BET' && w !== st; }).forEach(function (w) {
      if (new RegExp('\\b' + esc(w) + '\\b').test(t)) add('STATUS_MISMATCH', 'FAIL', 'names status ' + w + '; the official decision is ' + st);
    });
    if (st === 'BET' && /\bNO BET\b/.test(t)) add('STATUS_MISMATCH', 'FAIL', 'says NO BET; the official decision is BET');
    ['home', 'away'].forEach(function (side) {
      var q = facts.qb[side], team = facts.game[side];
      if (q.status === 'CONFIRMED') return;
      var names = [team, q.name].filter(Boolean).map(esc).join('|');
      /* judged clause by clause: "Mateer is confirmed, but the Texas QB is not" names two players */
      var sentences = t.split(/(?<=[.!?;])\s+|,\s*(?:but|and|while|whereas)?\s*|\s+(?:but|while|whereas)\s+/i);
      sentences.forEach(function (s) {
        var mentions = /\b(QB|quarterback|starter|under center)\b/i.test(s) || (q.name && new RegExp(esc(q.name), 'i').test(s));
        /* "not confirmed", "unconfirmed", "isn't confirmed" are the honest statement, not a claim */
        var claim = s.replace(/\b(not|never|isn't|is not|has not been|hasn't been|yet to be|un)\s*(been\s+)?(confirmed|announced|named)\b/gi, ' ');
        if (mentions && QB_CONFIRMED.test(claim) && (!names || new RegExp(names, 'i').test(claim) || !facts.game.home || /\bboth\b/i.test(claim)))
          add('QB_CONFIRMED_CLAIM', 'FAIL', side + ' quarterback is ' + q.status + ', the text says confirmed: "' + s.slice(0, 120) + '"');
      });
    });
    var allowed = facts.numbers || [];
    var re = /([+-]?\d+(?:\.\d+)?)\s*(%|percent|pts|points|point)?/g, m;
    /* dates, clock times, the model version and identifier-like tokens ("v2.1.0") are not claims */
    var cleaned = t.split(facts.model.model_version || '\u0000').join(' ')
      .replace(/\b(19|20)\d\d-\d\d-\d\d(T[\d:.]+Z?)?/g, ' ').replace(/\b\d{1,2}:\d\d\b/g, ' ')
      .replace(/[A-Za-z_]+\d[\w.]*/g, ' ');
    while ((m = re.exec(cleaned))) {
      var v = Number(m[1]);
      if (!isFinite(v)) continue;
      var tol = m[2] && /%|percent/.test(m[2]) ? 0.15 : 0.051;
      if (!allowed.some(function (a) { return Math.abs(a - v) <= tol; })) add('NUMBER_NOT_IN_FACTS', 'FAIL', 'the number ' + m[0].trim() + ' is not in the facts');
    }
    METRICS.forEach(function (x) { if (x[0].test(t) && !facts.allowed_metrics[x[1]]) add('UNSUPPORTED_METRIC', 'FAIL', 'names ' + x[1] + ', which the facts do not carry'); });
    /* a side named with a line: its sign must match the facts */
    var fav = isNum(facts.model.home_margin) ? (facts.model.home_margin > 0 ? 'home' : (facts.model.home_margin < 0 ? 'away' : null)) : null;
    if (fav && facts.game.home && facts.game.away) {
      var dog = fav === 'home' ? 'away' : 'home';
      var fairAbs = Math.round(Math.abs(facts.model.home_margin) * 2) / 2;
      var reDog = new RegExp(esc(facts.game[dog]) + '(?![A-Za-z(])\\s*(?:is\\s+)?(?:favou?red\\s+by\\s+|by\\s+)?-\\s?(\\d+(?:\\.\\d)?)', 'i');
      var md = reDog.exec(t);
      if (md && Math.abs(Number(md[1]) - fairAbs) <= 0.5) add('SIDE_REVERSED', 'FAIL', 'names ' + facts.game[dog] + ' as the favourite by ' + md[1] + '; the model favours ' + facts.game[fav]);
      if (new RegExp(esc(facts.game[dog]) + '(?![A-Za-z(])[^.]{0,40}\\b(is|are) (the )?favou?rite', 'i').test(t)) add('SIDE_REVERSED', 'FAIL', 'calls ' + facts.game[dog] + ' the favourite; the model favours ' + facts.game[fav]);
    }
    if (facts.degraded.length && !UNCERTAINTY.test(t)) add('UNCERTAINTY_NOT_STATED', 'FAIL', 'the prediction is degraded (' + facts.degraded.join('; ') + ') and the text does not say so');
    return { ok: !issues.some(function (i) { return i.severity === 'FAIL'; }), issues: issues, version: VERSION };
  }

  /* ------------------------------------------------ deterministic text */
  function pct(p) { return isNum(p) ? r(100 * p, 1) + '%' : 'unknown'; }
  function signed(x) { return isNum(x) ? (x > 0 ? '+' : '') + x : '—'; }
  function render(facts) {
    var g = facts.game, m = facts.model, d = facts.decision, s = [];
    var fav = isNum(m.home_margin) ? (m.home_margin > 0 ? g.home : (m.home_margin < 0 ? g.away : null)) : null;
    s.push('EdgeDesk\'s ' + (m.model_version || 'model') + ' projects ' + (fav ? fav + ' by ' + Math.abs(m.home_margin) : (isNum(m.home_margin) ? 'a pick\'em' : 'no margin'))
      + ' (a home margin of ' + signed(m.home_margin) + ' for ' + (g.home || 'the home team') + '; fair line ' + (m.fair_line_display || '—') + '), with a '
      + pct(m.home_win_probability) + ' home win probability.');
    if (facts.market) s.push('The market home line is ' + signed(facts.market.home_line) + (facts.market.actionable_status && facts.market.actionable_status !== 'ACTIONABLE' ? ' and is ' + facts.market.actionable_status.replace('MARKET_', '').toLowerCase() : '') + '.');
    else s.push('No market line is available.');
    var sideTeam = d.side === 'HOME' ? g.home : (d.side === 'AWAY' ? g.away : null);
    s.push('Official decision: ' + d.status + (d.status === 'BET' && sideTeam ? ' on ' + sideTeam + ' ' + signed(d.line) : '') + (d.reason && d.status !== 'BET' ? ' (' + d.reason.replace(/[0-9]+(\.[0-9]+)?/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) + ')' : '') + '.');
    var qbNote = ['home', 'away'].filter(function (x) { return facts.qb[x].status !== 'CONFIRMED'; }).map(function (x) { return g[x] + ' quarterback status is ' + facts.qb[x].status.toLowerCase(); });
    if (facts.degraded.length) s.push('Uncertainty: ' + (qbNote.length ? qbNote.join('; ') + '; ' : '') + facts.degraded.filter(function (x) { return !/quarterback/.test(x); }).join('; ') + (facts.degraded.length ? '.' : ''));
    s.push('This is a probability, not a promise: any single game can go either way.');
    return s.join(' ').replace(/;\s*\./g, '.').replace(/:\s*\./g, '.');
  }

  /* ------------------------------------------------------------- explain */
  /* llm(prompt) -> Promise<string>. The prompt carries no tools. Refused text
     is replaced by the deterministic rendering, and the answer's status, side
     and numbers always come from `facts`. */
  function explain(facts, llm) {
    var prompt = buildPrompt(facts);
    var fallback = function (why) { return { text: render(facts), source: 'deterministic', refused: why || null, status: facts.decision.status, side: facts.decision.side, version: VERSION }; };
    if (typeof llm !== 'function') return Promise.resolve(fallback(null));
    return Promise.resolve().then(function () { return llm(prompt); }).then(function (text) {
      var a = auditExplanation(text, facts);
      return a.ok ? { text: String(text), source: 'llm', refused: null, status: facts.decision.status, side: facts.decision.side, audit: a, version: VERSION } : fallback(a.issues);
    }, function (e) { return fallback([{ code: 'LLM_ERROR', severity: 'FAIL', detail: String(e && e.message || e).slice(0, 160) }]); });
  }

  return { VERSION: VERSION, cfbFacts: cfbFacts, buildPrompt: buildPrompt, auditExplanation: auditExplanation, render: render, explain: explain, qbStatus: qbStatus };
}));
