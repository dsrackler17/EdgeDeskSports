// deno-lint-ignore-file
/*__EDQUANT_START__*/
/* ===========================================================================
   EdgeDesk QUANT DESK — the questions the football desk and the board could
   not answer directly, answered from deterministic services.

   ONE FILE, ONE HOST. This exact block is inlined into
     - supabase/functions/edgedesk_ai/index.ts
   by tools/presentation/inline.js; presentation_sync.test.js fails when the
   copy drifts. Edit THIS file, then `node tools/presentation/inline.js`.

   WHAT IT ROUTES (classify), BEFORE the football desk
     SCAN          "What's the best bet right now?" with no league named, or
                   "across all sports": every sport is scanned (the board),
                   the top candidates are audited (EDAUDIT), and the answer is
                   the best VERIFIED opportunity — or a plain "nothing clears"
                   with the closest candidates and why they failed.
     CONTRACT      "Is Rays at 61¢ positive EV?", "Cleveland +1.5 at 61 cents
                   on Kalshi", "find me a better price than this Kalshi
                   contract": a contract price checked against the market's
                   fair through EDFAIR, fees included, every venue compared.
     PRICE         "Is Guardians -150 a good price?" (no football team named):
                   the same check for a sportsbook price.
     COVERAGE      "Which sports couldn't be scanned?"
     OUTAGE        "If the odds API fails, can you still analyze this game?"
     EXPLAIN_EV    "Explain why this contract has negative EV" (a follow-up).
   Anything else returns null and the existing turns run unchanged.

   THE RULES
     - It computes no probability. Every number comes from EDFAIR (prices,
       fees, EV), EDAUDIT (the second check), EDADAPT (what a sport can be
       priced with) or the captured market the host read.
     - It never says "best across all sports" unless every in-season sport
       was actually evaluated. Otherwise: "best among the markets scanned".
     - PASS is a normal answer. "No verified positive-EV trade currently
       clears the research and execution thresholds" is printed as such, with
       the near misses and the specific reason each one failed.
     - No certainty words, no invented confidence score.
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDQUANT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var VERSION = 'edgedesk_quant_v1';
  var STATE_SCHEMA = 'edgedesk_quant_state_v1';
  var NO_EDGE = 'No verified positive-EV trade currently clears the research and execution thresholds.';

  function F() { if (root.EDFAIR) return root.EDFAIR; if (typeof require === 'function') { try { return require('../../../lib/edgedesk_fairodds.js'); } catch (_) { /* below */ } } throw new Error('EDFAIR must be loaded'); }
  function AG() { if (root.EDAGENTS) return root.EDAGENTS; if (typeof require === 'function') { try { return require('./_agents.js'); } catch (_) { return null; } } return null; }
  function A() { if (root.EDADAPT) return root.EDADAPT; if (typeof require === 'function') { try { return require('../../../lib/edgedesk_sport_adapters.js'); } catch (_) { return null; } } return null; }
  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  function str(v) { return v == null ? '' : String(v); }
  function toMs(v) { if (v == null || v === '') return null; if (typeof v === 'number') return isFinite(v) ? v : null; var t = Date.parse(String(v)); return isFinite(t) ? t : null; }
  function iso(v) { var t = toMs(v); return t == null ? null : new Date(t).toISOString(); }
  function pct(x, d) { return x == null ? '—' : (x * 100).toFixed(d == null ? 1 : d) + '%'; }
  function fmtAm(n) { n = num(n); return n == null ? '—' : (n > 0 ? '+' : '') + Math.round(n); }
  function cents(x) { x = num(x); return x == null ? '—' : (Math.round(x * 10000) / 100).toFixed(2).replace(/\.00$/, '') + '¢'; }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }

  /* ================================================================ */
  /* 1. CLASSIFY                                                       */
  /* ================================================================ */
  var RX = {
    league: /\b(nfl|cfb|ncaaf|college football|fbs|pro football|football|mlb|baseball|nba|wnba|basketball|ncaab|college basketball|nhl|hockey|ufc|mma|soccer|tennis|golf)\b/i,
    football: /\b(nfl|cfb|ncaaf|college football|fbs|pro football|football)\b/i,
    allSports: /\b(all|every|any|across(?: all)?|multi)[- ]?(sports?|leagues?|markets?)\b|\bacross the board\b|\bcross[- ]sport\b/i,
    best: /\b(best|top|strongest|biggest|largest|safest)\b.*\b(bet|bets|play|plays|value|edge|edges|opportunit\w*|underdog|dog|favou?rite|moneyline|ev|price|trade|wager)\b|\bpositive[- ]?ev\b|\+ ?ev\b|\bwhat should i (bet|play|take)\b|\bmost likely to (go )?(under|over)\b|\bshould i bet anything\b/i,
    underdog: /\b(under ?dog|dogs?)\b/i,
    favorite: /\bfavou?rites?\b/i,
    /* which SPORTS were scanned: never the football word "coverage" (pass coverage, man or zone) */
    coverage: /\b(which|what) (sports?|leagues?)\b.*\b(couldn'?t|could not|can'?t|cannot|weren'?t|were not|didn'?t|did not|unable|missing|skipped|scan(ned)?|cover(ed)?|check(ed)?|evaluat(ed|e)|includ(ed|e)|look(ed)? at|support(ed)?)\b|\bcoverage\b.*\b(scan\w*|sports|leagues)\b|\b(scan\w*|sports|leagues)\b.*\bcoverage\b|\bwhat did you (scan|check|cover)\b/i,
    /* an explicit feed failure: a provider word AND a failure word ("ruled out" is injury news, not an outage) */
    outage: /\b(odds|price|pricing|market|sportsbook|line)s?\s*(api|feed|provider|service|data source)\b.*\b(fail\w*|down|offline|unavailable|break\w*|broke|outage|stops?|dies|died)\b|\b(api|feed|provider)\b.*\b(fail\w*|down|offline|outage)\b|\bif (the )?(odds|market|book)\w* (api|feed|provider|service) (are|is|goes|go)? ?(down|offline|unavailable)\b|\bwithout (the )?(odds|market|pricing) (api|feed|data)\b/i,
    /* a named game: "Lions vs Bills", "this game" — a best-bet question about ONE game is not a cross-sport scan */
    namedGame: /\b(this|that) (game|matchup|match|fight|bout)\b|[a-z.]\s+(?:vs\.?|versus|v\.|@)\s+[a-z]/i,
    explainEv: /\b(explain|why)\b.*\b(negative|positive|-|\+)? ?ev\b|\bwhy (is|does) (this|that|it) .*\b(bad|negative|lose|losing|pass)\b|\bexplain (this|that) (contract|price|bet)\b/i,
    contractWords: /\bkalshi\b|\bpoly ?market\b|\bcontracts?\b|\byes\b.*\bat\b|\b\d{1,2}(?:\.\d+)?\s*(?:¢|c\b|cents?\b)|\$\s?0?\.\d{1,2}\b/i,
    betterPrice: /\bbetter price\b|\bcheaper\b|\bbeat (this|that) price\b|\bfind me a better\b|\bshop (this|that)\b/i,
    priceCheck: /\b(is|was)\b.*[+-]\d{3,4}\b.*\b(good|fair|worth|value|positive|bet|price|ev)\b|[+-]\d{3,4}\b.*\b(good|fair|worth|value)\b/i,
    risk: /\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{1,6}(?:\.\d{1,2})?)\b(?!\s*(?:¢|c\b|cents?))/,
    /* the reader's own bet history: "why did I lose money on my bets", "were my parlays profitable" */
    betsSubject: /\b(my|i|i'?ve|me)\b[^?]{0,80}\b(bets?|wagers?|parlays?|singles?|tickets?|betting|bet history|picks)\b|\bmy (roi|p ?& ?l|profit|losses|record)\b/i,
    betsAnalysis: /\b(lost|lose|losing|losses|won|winning|win rate|profit\w*|roi|p ?& ?l|record|history|perform\w*|results?|how (am|did|have) i|where did|why did)\b/i,
    /* a research-and-audit request over a slate: "research every NFL game ... which survive an adversarial audit" */
    researchSlate: /\b(research|investigate|analy[sz]e|go through)\b[^?]{0,60}\b(every|all|each)\b[^?]{0,40}\bgames?\b|\b(largest|biggest|widest)\b[^?]{0,30}\b(verified\s+)?(model[- ]?(versus|vs\.?)[- ]?market|discrepanc\w*|disagreements?)\b|\bsurviv\w* (an |the )?(adversarial )?audit\b/i,
    /* why a game (or the board) is or is not ready: "explain why this game isn't research ready" */
    readiness: /\b(research[- ]ready|readiness|(isn'?t|is not|aren'?t|are not|not) (yet )?(research[- ])?ready|why\b[^?]{0,50}\b(not|n'?t)\b[^?]{0,20}\bready)\b/i,
    /* "which matchup has the biggest offensive advantage?" — unit against unit, from the efficiency ratings */
    matchupEdge: /\b(biggest|largest|best|strongest|most|greatest)\b[^?]{0,40}\b(offensive|defensive|passing|rushing|pass|rush|offense|defense)\b[^?]{0,30}\b(advantage|edge|mismatch)\w*\b|\b(offensive|defensive|unit) mismatch\w*\b/i,
    /* two venues named in one comparison: "compare DraftKings Predictions and Kalshi prices" */
    compareWords: /\bcompare\b|\bcomparison\b|\bversus\b|\bvs\.?\b|\bagainst\b|\bwhich (venue|exchange|book|site) is (cheaper|better)\b/i,
    venues: [['kalshi', /\bkalshi\b/i], ['polymarket', /\bpoly ?market\b/i], ['draftkings_predictions', /\b(draftkings|dk) predictions?\b/i], ['fanduel_predicts', /\bfanduel predicts?\b/i],
      ['robinhood', /\brobinhood\b/i], ['crypto_com', /\bcrypto\.com\b/i], ['novig', /\bnovig\b/i], ['prophetx', /\bprophet ?x\b/i], ['sportsbook', /\b(sportsbooks?|draftkings(?! predictions?)|fanduel(?! predicts?)|betmgm|caesars)\b/i]],
    /* markets the quant desk does not price from a captured moneyline or spread */
    unsupported: [
      ['a total', /\b(?:over|under|o|u)\s*\d+(?:\.\d)?\b(?!\s*(?:%|percent|cents?|¢|c\b))|\bo\/u\b|\btotals?\b|\bteam total\b/i],
      ['a futures market', /\b(world series|super bowl|stanley cup|nba finals|national champion\w*|pennant|make the playoffs|to make the|win totals?|futures?|mvp|cy young|heisman|championship odds)\b|\bto win the (title|championship|division|conference|league|series|cup)\b/i],
      ['a player prop', /\b(props?|strikeouts?|passing yards|rushing yards|receiving yards|yards|touchdowns?|rebounds|assists|home runs?|receptions?|anytime (?:scorer|td|touchdown))\b/i],
      ['a partial-game market', /\b(first (?:half|quarter|period|five|5|inning)|1st (?:half|quarter|period|inning)|f5|nrfi|yrfi|second half|2nd half)\b/i]
    ]
  };
  /**
   * q: the question; o.state: the carried quant state; o.has_board_state: a
   * board follow-up is in flight (leave it to the board).
   */
  /** The league a question names, as an odds-feed key, or null. */
  function sportOf(q) {
    q = str(q);
    if (/\b(nfl|pro football)\b/i.test(q)) return 'americanfootball_nfl';
    if (/\b(cfb|ncaaf|college football|fbs)\b/i.test(q)) return 'americanfootball_ncaaf';
    if (/\b(mlb|baseball)\b/i.test(q)) return 'baseball_mlb';
    if (/\b(ufc|mma)\b/i.test(q)) return 'mma_mixed_martial_arts';
    return null;
  }
  /** The kind of market a question asks about when it is not a moneyline or a spread, else null. */
  function unsupportedMarket(q) {
    q = str(q);
    for (var i = 0; i < RX.unsupported.length; i++) if (RX.unsupported[i][1].test(q)) return RX.unsupported[i][0];
    return null;
  }
  function classify(q, o) {
    q = str(q).trim(); o = o || {};
    var out = { intent: null, question: q, filter: null, risk_dollars: null, price: null, league_named: RX.league.test(q), football_named: RX.football.test(q), all_sports: RX.allSports.test(q), named_game: RX.namedGame.test(q) };
    if (!q || q.length > 400) return out;
    var F_ = F();
    var price = F_.parsePrice(q);
    out.price = price;
    var rm = q.match(RX.risk);
    if (rm && !/\$\s?0?\.\d/.test(rm[0])) out.risk_dollars = num(rm[1].replace(/,/g, ''));
    if (RX.underdog.test(q)) out.filter = 'underdog';
    else if (RX.favorite.test(q)) out.filter = 'favorite';
    var st = sanitizeState(o.state);
    if (RX.coverage.test(q)) { out.intent = 'COVERAGE'; return out; }
    if (RX.readiness.test(q)) { out.intent = 'READINESS'; out.sport = sportOf(q); return out; }
    if (RX.matchupEdge.test(q)) { out.intent = 'MATCHUP_EDGE'; out.sport = sportOf(q); out.unit = /\bpass(ing)?\b/i.test(q) ? 'pass' : /\brush(ing)?\b/i.test(q) ? 'rush' : /\bdefens/i.test(q) ? 'defense' : 'offense'; return out; }
    var vn = RX.venues.filter(function (v) { return v[1].test(q); }).map(function (v) { return v[0]; });
    if (vn.length >= 2 && RX.compareWords.test(q) && !(price.contract && price.contract.price_cents) && price.american == null) { out.intent = 'VENUE_COMPARE'; out.venues = vn; return out; }
    if (RX.betsSubject.test(q) && RX.betsAnalysis.test(q) && !/\b(should|how (much|many)|units?)\b[^?]{0,30}\bbet\b/i.test(q)) { out.intent = 'BETS'; return out; }
    if (RX.researchSlate.test(q)) { out.intent = 'RESEARCH_SLATE'; out.sport = sportOf(q); return out; }
    if (RX.outage.test(q) && /\b(can|could|still|will|do|does|able)\b/i.test(q)) { out.intent = 'OUTAGE'; return out; }
    if (RX.explainEv.test(q) && st && st.contract && !(price.contract && price.contract.price_cents)) { out.intent = 'EXPLAIN_EV'; return out; }
    /* a cents number is a contract price only with something that says so: a venue, the ¢ sign or
       "$0.61", "contract", a YES/NO side, or "cents" in a price question — never "12c" or "my 2 cents" */
    var ct = price.contract;
    var contractContext = !!ct && (!!price.venue || ct.symbol === true || !!price.side || /\bcontracts?\b/i.test(q)
      || (/\d\s*cents?\b/i.test(q) && /\b(ev|worth|value|price|buy|fair|edge|good|bet)\b/i.test(q)));
    if (ct && contractContext && (ct.price_cents || ct.error)) { out.intent = 'CONTRACT'; out.unsupported_market = unsupportedMarket(q); return out; }
    if (RX.betterPrice.test(q) && (price.venue || (st && st.contract))) { out.intent = 'CONTRACT'; out.better_price = true; return out; }
    if (price.venue && /\b(price|worth|ev|value|good|bet|buy)\b/i.test(q)) { out.intent = 'CONTRACT'; return out; }
    if (price.american != null && RX.priceCheck.test(q) && !out.football_named) { out.intent = 'PRICE'; out.unsupported_market = unsupportedMarket(q); return out; }
    if (o.has_board_state) return out;
    if (RX.best.test(q) && (out.all_sports || (!out.league_named && !out.named_game))) { out.intent = 'SCAN'; return out; }
    return out;
  }

  /* ================================================================ */
  /* 2. THE SCAN — the board's candidates, audited, ranked, answered    */
  /* ================================================================ */
  /** Board opportunities and watchlist as the auditor's candidate list, best first, optionally filtered. */
  function candidatesFromBoard(board, filter) {
    var list = [].concat(board && board.opportunities || [], board && board.watchlist || []);
    if (filter) list = list.filter(function (c) { return matchesFilter(c, filter); });
    return list.filter(function (c) { return c && c.quote && c.quote.executable; });
  }
  /** Underdog: getting a price better than even on a moneyline, or points on a spread. Favorite: the reverse. */
  function matchesFilter(c, filter) {
    if (!filter) return true;
    var am = num(c.quote && c.quote.odds_american), line = num(c.line);
    var dog = c.market === 'h2h' ? (am != null && am > 100) : c.market === 'spreads' ? (line != null && line > 0) : null;
    if (dog == null) return false;
    return filter === 'underdog' ? dog : !dog;
  }
  /**
   * The audited answer.
   * o.board (EDBOARD.build), o.audit (EDAUDIT.run), o.coverage (refined, per
   * sport), o.not_covered (EDADAPT.NOT_COVERED), o.risk_dollars, o.filter,
   * o.now, o.evaluate (fn(candidate, audit) → EDFAIR result)
   */
  function scanResult(o) {
    o = o || {};
    var cov = o.coverage || [];
    var inSeasonSports = cov.filter(function (c) { return c.status !== 'OUT_OF_SEASON' && c.status !== 'NOT_SUPPORTED'; });
    var evaluated = cov.filter(function (c) { return c.status === 'EVALUATED'; });
    var notScanned = inSeasonSports.filter(function (c) { return c.status !== 'EVALUATED' && c.status !== 'NO_GAMES' && c.status !== 'NO_ELIGIBLE_GAMES'; });
    var fullCoverage = inSeasonSports.length > 0 && !notScanned.length && evaluated.length > 0;
    var audited = (o.audit && o.audit.audited) || [];
    var inv = o.investigations || null;
    var rows = audited.map(function (r) {
      var ev = o.evaluate ? o.evaluate(r.candidate, r.audit) : null;
      var x = inv ? inv[r.candidate.id] || null : null;
      /* the research chain's evaluation is the one published (it priced the audited fair, after any recalculation) */
      if (x && x.quant && x.quant.evaluation && x.quant.evaluation.ok) ev = x.quant.evaluation;
      /* the board's own verdict is respected: a candidate it withheld is never upgraded here, unless the
         only thing it failed was freshness and the audit replaced the stale price with a fresh read */
      var q = r.candidate.qualification || null;
      var rule = q && q.rules && q.rules[0] ? String(q.rules[0]) : '';
      var corrected = (r.candidate.corrected || []).some(function (x) { return x.field === 'quote'; });
      var withheld = q && q.status !== 'QUALIFIED' && !(/^R2_FRESH/.test(rule) && corrected && r.audit.status === 'CONFIRMED') ? rule || q.status : null;
      return { candidate: r.candidate, audit: r.audit, evaluation: ev, rounds: r.rounds, withheld_by_board: withheld, research: x, classification: x ? x.classification : null };
    });
    var RANK = { VERIFIED_CANDIDATE: 0, WATCHLIST: 1, RESEARCH_REQUIRED: 2, REJECTED: 3, UNVERIFIED: 4 };
    /* ranked by defensible evidence, not payout: the audit class first, then the cushion to break-even, then EV */
    var byEvidence = function (a, b) {
      var ca = a.classification ? RANK[a.classification.classification] : 9, cb = b.classification ? RANK[b.classification.classification] : 9;
      if (ca !== cb) return ca - cb;
      var sa = a.research && a.research.sensitivity && a.research.sensitivity.cushion_pp, sb = b.research && b.research.sensitivity && b.research.sensitivity.cushion_pp;
      if (sa != null && sb != null && sa !== sb) return sb - sa;
      return (num(b.evaluation && b.evaluation.net_ev_per_dollar) || 0) - (num(a.evaluation && a.evaluation.net_ev_per_dollar) || 0);
    };
    /* best verified: with the research chain, only a VERIFIED CANDIDATE (audit CONFIRMED, every professional
       check passed, robust to a one-point error); without it, CONFIRMED and VERIFIED_EDGE. Never one the board withheld. */
    var verified = rows.filter(function (r) { return !r.withheld_by_board && (inv ? (r.classification && r.classification.classification === 'VERIFIED_CANDIDATE') : (r.audit.status === 'CONFIRMED' && r.evaluation && r.evaluation.classification === 'VERIFIED_EDGE')); });
    verified.sort(byEvidence);
    var potential = rows.filter(function (r) { return verified.indexOf(r) < 0 && (inv ? (r.classification && (r.classification.classification === 'WATCHLIST' || r.classification.classification === 'RESEARCH_REQUIRED') && r.evaluation && num(r.evaluation.net_ev_per_dollar) != null && num(r.evaluation.net_ev_per_dollar) > 0) : (r.evaluation && (r.evaluation.classification === 'POTENTIAL_EDGE' || r.evaluation.classification === 'VERIFIED_EDGE'))); });
    potential.sort(byEvidence);
    var nearMiss = rows.filter(function (r) { return verified.indexOf(r) < 0 && potential.indexOf(r) < 0; });
    /* the board's own near misses when nothing was audited: its top non-qualified candidates by edge */
    var boardNear = [];
    if (o.board && Array.isArray(o.board.candidates)) {
      boardNear = o.board.candidates.filter(function (c) { return c.status !== 'QUALIFIED' && (c.ev_per_unit != null || c.edge_pp != null) && (!o.filter || true); })
        .sort(function (a, b) { return (num(b.ev_per_unit) != null ? num(b.ev_per_unit) : (num(b.edge_pp) || -99) / 100) - (num(a.ev_per_unit) != null ? num(a.ev_per_unit) : (num(a.edge_pp) || -99) / 100); })
        .slice(0, 3).map(function (c) { return { matchup: c.matchup, sport: c.sport, market: c.market, selection: c.selection, line: c.line, ev_per_unit: c.ev_per_unit, edge_pp: c.edge_pp, status: c.status, why: c.rule || c.decision || null, freshness: c.freshness }; });
    }
    var best = verified[0] || null;
    var scope = fullCoverage ? 'ALL_IN_SEASON' : 'SCANNED_ONLY';
    return {
      schema: VERSION + ':scan', built_at: iso(o.now), filter: o.filter || null, risk_dollars: o.risk_dollars || null,
      decision: best ? 'BUY' : potential.length ? 'WATCH' : 'PASS',
      final_status: best ? 'VERIFIED CANDIDATE' : potential.length ? 'WATCHLIST' : 'PASS', researched: !!inv,
      best: best, verified_rest: verified.slice(1, 3), potential: potential.slice(0, 3), near_misses: nearMiss.slice(0, 3), board_near_misses: boardNear,
      coverage: cov, coverage_scope: scope, evaluated: evaluated.map(function (c) { return c.label; }), not_scanned: notScanned.map(function (c) { return { sport: c.sport, label: c.label, status: c.status, why: c.why || c.sentence || null }; }),
      not_covered: (o.not_covered || []).map(function (n) { return { label: n.label, why: n.why }; }),
      counts: { sports_evaluated: evaluated.length, sports_in_season: inSeasonSports.length, events: o.board && o.board.eligibility ? o.board.eligibility.counts.eligible : null, markets_evaluated: o.board ? o.board.candidates_considered : null, audited: rows.length, verified: verified.length, potential: potential.length },
      window: o.board && o.board.scope ? o.board.scope.window : null, timezone: o.board && o.board.scope ? o.board.scope.timezone : null,
      audit_trail: o.audit ? o.audit.trail : [], audit_checks: o.audit ? o.audit.checks : []
    };
  }

  function lineOf(c) { if (!c) return ''; var l = num(c.line); return c.market === 'totals' ? (l != null ? ' ' + l : '') : c.market === 'spreads' && l != null ? ' ' + (l > 0 ? '+' : '') + l : c.market === 'h2h' ? ' moneyline' : ''; }
  function marketWord(m) { return m === 'spreads' ? 'spread' : m === 'totals' ? 'total' : m === 'h2h' ? 'moneyline' : str(m); }

  /** One candidate block from the research chain, in the brief's shape. */
  function researchBlock(r, s, heading) {
    var c = r.candidate, x = Object.assign({}, r.research);
    var warn = (r.audit && r.audit.checks || []).filter(function (k) { return k.result === 'WARN' || k.result === 'FAIL'; })[0];
    x.candidate = { matchup: c.matchup, sport: c.sport, sport_label: c.sport_label, market_label: c.selection + lineOf(c), book: c.quote && c.quote.book, kickoff_local: c.kickoff_local };
    x.event = { id: c.game_id, sport: c.sport, home: c.home, away: c.away, kickoff: c.kickoff };
    x.advantage = matchupLine(c);
    var ag = AG();
    var counter = ag ? ag.counterArgument(x) : null;
    if (warn && !/^Not examined/.test(warn.detail)) counter = (counter ? counter + '; ' : '') + 'the audit flagged: ' + warn.detail;
    x.counter = counter;
    return ag.renderCandidate(x, heading);
  }
  function researchTail(s) {
    var out = [];
    var rs = (s.research_summary || null);
    if (rs) out.push('Research: ' + rs.level + ' (' + rs.level_label + ') — ' + rs.findings + ' finding' + (rs.findings === 1 ? '' : 's') + ' from ' + rs.sources + ' source' + (rs.sources === 1 ? '' : 's') + ', ' + rs.conflicts + ' conflict' + (rs.conflicts === 1 ? '' : 's') + (rs.unavailable.length ? '; unavailable: ' + rs.unavailable.join('; ') : '') + '; cost estimate $' + (rs.cost_estimate_usd || 0).toFixed(3) + '.');
    if (s.sources_text) out.push(s.sources_text);
    return out;
  }
  /** The research answer: the best VERIFIED CANDIDATE, or "nothing qualifies" with the strongest candidate and why. */
  function renderResearchScan(s) {
    var out = [];
    var scopeWord = s.coverage_scope === 'ALL_IN_SEASON' ? 'across every in-season sport EdgeDesk covers' : 'among the markets EdgeDesk could scan (' + (s.evaluated.join(', ') || 'none') + ')';
    var filt = s.filter === 'underdog' ? 'UNDERDOG ' : s.filter === 'favorite' ? 'FAVORITE ' : '';
    if (s.best) {
      out.push(researchBlock(s.best, s, 'BEST VERIFIED RESEARCH ' + filt + 'CANDIDATE ' + (s.coverage_scope === 'ALL_IN_SEASON' ? '(all in-season sports scanned)' : '(' + scopeWord + ')')));
    } else {
      out.push(NO_EDGE + (s.coverage_scope === 'ALL_IN_SEASON' ? '' : ' (' + scopeWord + ')'));
      if (s.potential.length) {
        var p0 = s.potential[0];
        out.push('');
        out.push(researchBlock(p0, s, 'STRONGEST ' + filt + 'CANDIDATE — ' + p0.classification.label + ', NOT VERIFIED'));
      }
    }
    var others = [].concat(s.best ? s.verified_rest || [] : s.potential.slice(1), s.near_misses).filter(Boolean);
    if (others.length) {
      out.push('');
      out.push('Other candidates investigated:');
      others.slice(0, 4).forEach(function (p, i) { out.push((i + 1) + '. ' + p.candidate.selection + lineOf(p.candidate) + ' (' + p.candidate.matchup + ') ' + fmtAm(p.candidate.quote.odds_american) + ' — ' + (p.classification ? p.classification.label + ': ' + (p.classification.reasons[0] || '') : p.audit.status + ': ' + p.audit.reason) + '.'); });
    } else if (!s.best && !s.potential.length && s.board_near_misses.length) {
      out.push('');
      out.push('Closest candidates on the board and why they failed:');
      s.board_near_misses.forEach(function (p, i) { out.push((i + 1) + '. ' + p.selection + (p.line != null ? ' ' + p.line : '') + ' ' + marketWord(p.market) + ' (' + p.matchup + '): ' + (p.ev_per_unit != null ? 'EV ' + pct(num(p.ev_per_unit), 2) + ' per $1' : p.edge_pp != null ? 'edge ' + p.edge_pp + ' pp' : 'no EV') + ' — ' + (p.why || p.status) + '.'); });
    }
    out.push('');
    out.push(coverageSentence(s));
    researchTail(s).forEach(function (l) { out.push(l); });
    return out.join('\n');
  }
  /**
   * "Research every NFL game this weekend … which survive an adversarial audit?"
   * o: { sport_label, window, games: [{matchup, kickoff_local, model_line, market_line, gap_points, freshness, model_tier, status}],
   *      investigated: [rows like scanResult rows], coverage_sentence, research_summary, sources_text, not_investigated }
   */
  function renderResearchSlate(o) {
    o = o || {};
    var out = [];
    var survivors = (o.investigated || []).filter(function (r) { return r.classification && r.classification.classification === 'VERIFIED_CANDIDATE' && !r.withheld_by_board; });
    out.push((o.sport_label || 'The slate') + (o.window ? ' — ' + o.window : '') + ': ' + plural((o.games || []).length, 'game') + ' investigated, ' + plural((o.investigated || []).length, 'candidate') + ' taken through research and the adversarial audit, ' + (survivors.length ? plural(survivors.length, 'survivor') : 'none survived') + '.');
    if (o.readiness) out.push(readinessLine(o.readiness));
    out.push('');
    if (survivors.length) out.push('Survived the audit: ' + survivors.map(function (r) { return r.candidate.selection + lineOf(r.candidate) + ' (' + r.candidate.matchup + ')'; }).join('; ') + '.');
    else out.push(NO_EDGE);
    var gaps = (o.games || []).filter(function (g) { return g.gap_points != null; }).sort(function (a, b) { return Math.abs(b.gap_points) - Math.abs(a.gap_points); });
    if (gaps.length) {
      out.push('');
      out.push('Largest model-versus-market discrepancies (EdgeDesk\'s line against the captured market, home side):');
      gaps.slice(0, 6).forEach(function (g, i) { out.push((i + 1) + '. ' + g.matchup + ': model ' + signedLine(g.model_line) + ', market ' + signedLine(g.market_line) + ' — gap ' + Math.abs(g.gap_points) + ' points (' + (g.model_tier || 'unvalidated') + ' model; ' + (g.freshness || 'price age unknown') + ')' + (g.diagnosis ? '. ' + g.diagnosis : '')); });
    }
    (o.investigated || []).forEach(function (r, i) {
      out.push('');
      out.push(researchBlock(r, o, 'CANDIDATE ' + (i + 1) + ' — ' + (r.classification ? r.classification.label : r.audit.status)));
    });
    if ((o.not_investigated || []).length) { out.push(''); out.push('Not taken to the audit: ' + o.not_investigated.slice(0, 6).join('; ') + '.'); }
    out.push('');
    if (o.coverage_sentence) out.push(o.coverage_sentence);
    researchTail(o).forEach(function (l) { out.push(l); });
    return out.join('\n');
  }
  function signedLine(v) { v = num(v); return v == null ? '—' : (v > 0 ? '+' : '') + v; }
  /* ================================================================ */
  /* READINESS, ONE GAME, UNIT MISMATCHES, VENUES                      */
  /* ================================================================ */
  var READY_WORD = { AVAILABLE: 'available', RESEARCH: 'research available', MARKET: 'market verified', MODEL: 'model ready', ACTIONABLE: 'actionable signal' };
  /** "Readiness: 7 available · 7 research available · 2 market verified · 7 model ready · 1 actionable signal." */
  function readinessLine(r) {
    if (!r || !r.counts) return '';
    var c = r.counts, ks = ['AVAILABLE', 'RESEARCH', 'MARKET', 'MODEL', 'ACTIONABLE'];
    var line = 'Readiness: ' + ks.map(function (k) { return c[k] + ' ' + READY_WORD[k]; }).join(' · ') + ' (of ' + c.total + ').';
    var tm = r.top_reason && r.top_reason.MARKET;
    if (tm && c.MARKET < c.total) line += ' Market not verified on ' + plural(c.total - c.MARKET, 'game') + '; most common reason: ' + tm.reason + '.';
    return line;
  }
  function stateWord(st) { return st ? (st.ok ? 'yes' : 'no') : '—'; }
  /** "Explain why games aren't research ready": the five counts, then every game's missing requirements. */
  function renderReadiness(o) {
    o = o || {};
    var out = [], games = o.games || [];
    out.push('WHAT ' + (o.sport_label ? o.sport_label.toUpperCase() + ' ' : '') + 'GAMES ARE READY FOR' + (o.window ? ' — ' + o.window : ''));
    out.push('');
    if (!games.length) { out.push('No pregame games are on EdgeDesk\'s card for this window, so there is nothing to assess.'); return out.join('\n'); }
    out.push(readinessLine(o.readiness));
    out.push('');
    out.push('A game stays researchable with no market and no signal: "not ready to price" is not "not ready to research".');
    out.push('');
    var notReady = games.filter(function (g) { return g.readiness && g.readiness.level !== 'ACTIONABLE'; });
    var ready = games.filter(function (g) { return g.readiness && g.readiness.level === 'ACTIONABLE'; });
    if (ready.length) { out.push('Actionable: ' + ready.map(function (g) { return g.matchup; }).join('; ') + '.'); out.push(''); }
    out.push('Why each game is not fully ready:');
    notReady.slice(0, 12).forEach(function (g, i) {
      var why = (g.why_not || []).filter(function (w) { return !/^Actionable signal/.test(w) || (g.readiness.states.MARKET.ok && g.readiness.states.MODEL.ok); });
      out.push((i + 1) + '. ' + g.matchup + ' — ' + g.readiness.headline + (why.length ? ' Missing: ' + why.join(' ') : ''));
    });
    if (notReady.length > 12) out.push('…and ' + plural(notReady.length - 12, 'more game') + ' with the same kinds of gaps.');
    if (o.coverage_sentence) { out.push(''); out.push(o.coverage_sentence); }
    return out.join('\n');
  }
  /** One game: readiness, the numbers, the disagreement, the findings, its candidates, the sources. */
  function renderGameResearch(o) {
    o = o || {};
    var g = o.game, out = [];
    if (!g) return 'That game is not on EdgeDesk\'s card right now (it may have started, or it is outside the sports EdgeDesk covers), so it cannot be researched here.';
    var rd = g.readiness, S = rd ? rd.states : {};
    out.push('GAME RESEARCH — ' + g.matchup + (g.kickoff_local ? ', ' + g.kickoff_local : ''));
    out.push('');
    out.push('Event: ' + g.matchup + (g.kickoff_local ? ' — ' + g.kickoff_local : ''));
    out.push('Sport: ' + (o.sport_label || g.sport));
    out.push('Readiness: available ' + stateWord(S.AVAILABLE) + ' · research ' + stateWord(S.RESEARCH) + ' · market verified ' + stateWord(S.MARKET) + ' · model ready ' + stateWord(S.MODEL) + ' · actionable ' + stateWord(S.ACTIONABLE));
    out.push('Model projection: ' + (g.model_line != null ? g.home + ' ' + signedLine(g.model_line) + (g.model_total != null ? ', total ' + g.model_total : '') + ' (' + (g.model_tier || 'unvalidated') + ' model)' : 'none on file'));
    out.push('Market: ' + (g.market_line != null ? g.home + ' ' + signedLine(g.market_line) + (g.market_total != null ? ', total ' + g.market_total : '') + ' (' + g.freshness + ')' : 'no market number on file'));
    out.push('Model disagreement: ' + (g.gap_points != null ? Math.abs(g.gap_points) + ' points' + (g.disagreement ? '. ' + g.disagreement.explanation : '') : 'not measurable without both numbers'));
    var f = (g.research && g.research.findings) || [];
    var key = f.filter(function (x) { return (x.topic === 'availability' || x.topic === 'starter') && (x.status === 'OUT' || x.status === 'DOUBTFUL' || x.status === 'QUESTIONABLE' || x.topic === 'starter'); }).slice(0, 6);
    out.push('Key injuries or lineup changes: ' + (key.length ? key.map(function (x) { return x.claim + ' (' + String(x.reliability || '').toLowerCase().replace(/_/g, ' ') + (x.verified ? ', verified' : '') + ')'; }).join('; ') : f.length ? 'none listed as out, doubtful or questionable among ' + plural(f.length, 'finding') : 'no availability source was read for this game'));
    var cf = (g.research && g.research.conflicts) || [];
    if (cf.length) out.push('Conflicting reports: ' + cf.map(function (c) { return c.detail + (c.unresolved ? ' (unresolved)' : ' (resolved by ' + (c.resolution && c.resolution.by || 'source tier') + ')'); }).join('; '));
    if (rd && rd.missing && rd.missing.length) {
      out.push('');
      out.push('Why not ready:');
      (o.why_not || []).forEach(function (w, i) { out.push((i + 1) + '. ' + w); });
    }
    (o.investigated || []).forEach(function (r, i) { out.push(''); out.push(researchBlock(r, o, 'CANDIDATE ' + (i + 1) + ' — ' + (r.classification ? r.classification.label : r.audit.status))); });
    if (!(o.investigated || []).length) { out.push(''); out.push(S.MARKET && S.MARKET.ok ? 'No price on this game cleared the board\'s screen, so nothing reached the adversarial audit.' : 'No price check or audit ran: there is no current market price to check.'); }
    out.push('');
    researchTail(o).forEach(function (l) { out.push(l); });
    return out.join('\n');
  }
  /** "Which matchup has the biggest offensive advantage?" o: { rows: [{matchup, offense, defense, edge, off, def, off_rank, def_rank}], unit, sport_label, source, generated_at, window, missing } */
  function renderMatchupEdges(o) {
    o = o || {};
    var out = [], unit = o.unit === 'pass' ? 'passing' : o.unit === 'rush' ? 'rushing' : o.unit === 'defense' ? 'defensive' : 'offensive';
    out.push('BIGGEST ' + unit.toUpperCase() + ' MISMATCHES' + (o.sport_label ? ' — ' + o.sport_label : '') + (o.window ? ', ' + o.window : ''));
    out.push('');
    if (!(o.rows || []).length) { out.push(o.missing || 'No unit efficiency ratings are on file for these games, so no mismatch can be measured.'); return out.join('\n'); }
    out.push('Measured from EdgeDesk\'s NFL team ratings: one side\'s ' + (o.metric_label || 'EPA per play') + ' rating plus the opposing unit\'s, the same offense-against-defense pairing the projection engine uses. A unit mismatch is matchup context, not a probability and not a bet.');
    out.push('');
    o.rows.slice(0, 6).forEach(function (r, i) {
      out.push((i + 1) + '. ' + r.offense + ' ' + (o.unit === 'defense' ? 'defense' : 'offense') + ' vs ' + r.defense + ' ' + (o.unit === 'defense' ? 'offense' : 'defense') + ' (' + r.matchup + '): ' + (r.edge >= 0 ? '+' : '') + r.edge.toFixed(3) + ' EPA/play — ' + r.offense + ' ' + (r.off_rank ? r.off_rank + ' of ' + r.of : '') + ' on its side, ' + r.defense + ' ' + (r.def_rank ? r.def_rank + ' of ' + r.of : '') + ' on the other.');
    });
    out.push('');
    out.push('Source: ' + (o.source || 'EdgeDesk NFL slate ratings') + (o.generated_at ? ', built ' + String(o.generated_at).slice(0, 16).replace('T', ' ') + ' UTC' : '') + '.' + (o.missing ? ' ' + o.missing : ''));
    return out.join('\n');
  }
  /** "Compare DraftKings Predictions and Kalshi prices": what EdgeDesk holds for each venue, and what it needs. o: { venues: [{key, label, fee, verification, captured, note}] } */
  function renderVenueCompare(o) {
    o = o || {};
    var out = [];
    out.push('COMPARING ' + (o.venues || []).map(function (v) { return v.label.toUpperCase(); }).join(' AND '));
    out.push('');
    (o.venues || []).forEach(function (v) {
      out.push(v.label + ': ' + (v.captured ? 'EdgeDesk captures its prices' : 'EdgeDesk does not capture its live prices') + '; fees: ' + v.fee + ' (' + String(v.verification || 'unknown').toLowerCase() + ').' + (v.note ? ' ' + v.note : ''));
    });
    out.push('');
    var none = (o.venues || []).filter(function (v) { return !v.captured; });
    if (none.length) out.push('No live price from ' + none.map(function (v) { return v.label; }).join(' or ') + ' is on file, so no comparison can be computed and none is invented. Give the two prices for the same outcome — e.g. "Rays YES 46¢ on Kalshi vs 47¢ on DraftKings Predictions" — and EdgeDesk will compare their all-in cost after each venue\'s own fee rule, and say where a fee schedule is not verified.');
    return out.join('\n');
  }

  /** The answer, in the order the brief asks for. */
  function renderScan(s) {
    if (s.researched && AG()) return renderResearchScan(s);
    var out = [];
    var scopeWord = s.coverage_scope === 'ALL_IN_SEASON' ? 'across every in-season sport EdgeDesk covers' : 'among the markets EdgeDesk could scan (' + (s.evaluated.join(', ') || 'none') + ')';
    var filt = s.filter === 'underdog' ? 'UNDERDOG ' : s.filter === 'favorite' ? 'FAVORITE ' : '';
    if (s.best) {
      out.push('BEST VERIFIED ' + filt + 'OPPORTUNITY ' + (s.coverage_scope === 'ALL_IN_SEASON' ? '(all in-season sports scanned)' : '(' + scopeWord + ')'));
      out.push('');
      opportunityLines(s.best, s, 'BUY').forEach(function (l) { out.push(l); });
      out.push('');
      out.push('Why: ' + s.best.evaluation.reasons[0] + ' The audit re-read the price and recomputed it independently: ' + s.best.audit.reason + '.');
    } else {
      out.push(NO_EDGE + (s.coverage_scope === 'ALL_IN_SEASON' ? '' : ' (' + scopeWord + ')'));
      if (s.potential.length) {
        var p0 = s.potential[0];
        out.push('');
        out.push('STRONGEST ' + filt + 'CANDIDATE — POTENTIAL EDGE, NOT VERIFIED');
        out.push('');
        opportunityLines(p0, s, 'WATCH').forEach(function (l) { out.push(l); });
        out.push('Not verified because ' + whyNot(p0) + '.');
        if (s.potential.length > 1) {
          out.push('');
          out.push('Other potential edges:');
          s.potential.slice(1).forEach(function (p, i) { out.push((i + 2) + '. ' + p.candidate.selection + lineOf(p.candidate) + ' (' + p.candidate.matchup + ') ' + fmtAm(p.candidate.quote.odds_american) + ' at ' + (p.candidate.quote.book || 'a captured book') + ': net EV ' + pct(num(p.evaluation.net_ev_per_dollar), 2) + ' per $1, max entry ' + fmtAm(p.evaluation.maximum_entry_price) + ' — ' + whyNot(p) + '.'); });
        }
      }
      var nm = s.near_misses.length ? s.near_misses : [];
      if (nm.length) {
        out.push('');
        out.push('Near misses the audit stopped:');
        nm.forEach(function (p, i) { out.push((i + 1) + '. ' + p.candidate.selection + lineOf(p.candidate) + ' (' + p.candidate.matchup + ') ' + fmtAm(p.candidate.quote.odds_american) + ': ' + p.audit.status + ' — ' + p.audit.reason + '.'); });
      } else if (!s.potential.length && s.board_near_misses.length) {
        out.push('');
        out.push('Closest candidates on the board and why they failed:');
        s.board_near_misses.forEach(function (p, i) { out.push((i + 1) + '. ' + p.selection + (p.line != null ? ' ' + p.line : '') + ' ' + marketWord(p.market) + ' (' + p.matchup + '): ' + (p.ev_per_unit != null ? 'EV ' + pct(num(p.ev_per_unit), 2) + ' per $1' : p.edge_pp != null ? 'edge ' + p.edge_pp + ' pp' : 'no EV') + ' — ' + (p.why || p.status) + '.'); });
      }
    }
    out.push('');
    out.push(coverageSentence(s));
    return out.join('\n');
  }
  /** The independent model's view beside the price's own fair, or why there is none. */
  function independentLine(c, e, cap) {
    var marketFair = fmtAm(e.fair_american_odds) + ' (' + pct(num(e.fair_probability)) + ', ' + (e.fair_source.label || 'sharp no-vig') + ')';
    if (e.fair_source && e.fair_source.kind === 'MODEL') return (cap && cap.may_price ? '' : 'research only — ') + fmtAm(e.fair_american_odds) + ' (' + pct(num(e.fair_probability)) + ', ' + (e.fair_source.label || 'EdgeDesk model') + ', ' + (e.fair_source.tier || 'unvalidated') + ')';
    var mc = c.model_case;
    if (mc && cap && cap.independent_model && (mc.fair_line != null || mc.model_line != null)) {
      var l = function (v) { v = num(v); return v == null ? '—' : c.market === 'totals' ? String(v) : (v > 0 ? '+' : '') + v; };
      return 'EdgeDesk\'s ' + (cap.name || 'model') + ' (' + (mc.tier || cap.tier || 'unvalidated') + ') makes ' + c.selection + ' ' + l(mc.fair_line) + ' (projection ' + l(mc.model_line) + ')' + (num(mc.cover_at_market) != null ? ', covering ' + pct(num(mc.cover_at_market)) + ' at ' + l(c.line) : '') + (mc.tier === 'LEAN' ? ' — break-even history, not a profit record' : mc.tier === 'RESEARCH' ? ' — research only, not a betting probability' : '') + '. The price is judged against the market fair: ' + marketFair;
    }
    return 'unavailable — ' + (cap ? (cap.independent_model && cap.may_price ? 'no ' + (cap.name || 'model') + ' projection is on file for this game' : cap.reason) : 'no model') + '. Market fair: ' + marketFair;
  }
  /** The fields the brief names, for one audited candidate. */
  function opportunityLines(r, s, decision) {
    var c = r.candidate, e = r.evaluation, ad = AD_();
    var cap = ad ? ad.modelCapability(c.sport, c.market) : null;
    var roles = ad && ad.adapterFor(c.sport) ? ad.adapterFor(c.sport).key_roles : [];
    var out = [];
    out.push('Event: ' + c.matchup + (c.kickoff_local ? ' — ' + c.kickoff_local : '') + ' (' + (c.sport_label || c.sport) + ')');
    out.push('Market: ' + c.selection + lineOf(c));
    out.push('Venue: ' + (c.quote.book || 'captured book'));
    out.push('Available price: ' + fmtAm(c.quote.odds_american) + ' (captured ' + (c.quote.captured_at ? ageText(c.quote.captured_at, s.built_at) : 'at an unrecorded time') + '; implies ' + pct(num(e.market_probability)) + ')' + ((c.corrected || []).length ? ' — corrected by the audit from a fresh read' : ''));
    out.push('Independent fair price: ' + independentLine(c, e, cap));
    out.push('Estimated net EV: ' + pct(num(e.net_ev_per_dollar), 2) + ' per $1' + (s.risk_dollars ? ' — about $' + (Math.round(num(e.net_ev_per_dollar) * s.risk_dollars * 100) / 100).toFixed(2) + ' expected on $' + s.risk_dollars : ''));
    out.push('Maximum acceptable entry: ' + fmtAm(e.maximum_entry_price) + ' (the worst price that still clears the ' + pct(num(e.thresholds.ev_floor), 1) + ' floor)');
    out.push('Model reliability: ' + e.calibration_status + (e.calibration_status === 'MARKET_DERIVED' ? ' — the fair comes from the sharp market, not a model; its record is the closing-line ledger' : ''));
    out.push('Primary matchup advantage: ' + matchupLine(c));
    var warn = (r.audit && r.audit.checks || []).filter(function (x) { return x.result === 'WARN'; })[0];
    /* the decision layer's "not examined on this turn" gap, said plainly: the scan judged a price, not a matchup */
    var counter = /^Not examined on this turn/.test(String(c.counter || '')) ? 'The matchup itself was not researched on this turn: the case is the price against the sharp market.' : (c.counter || 'not stated');
    out.push('Biggest risk: ' + (warn ? warn.detail + '.' : counter) + (roles.length ? ' Also: ' + roles[0].why + '.' : ''));
    out.push('Decision: ' + decision);
    return out;
  }
  function AD_() { return A(); }
  function ageText(at, now) { var a = toMs(at), n = toMs(now) != null ? toMs(now) : Date.now(); if (a == null) return 'at an unknown time'; var m = Math.round((n - a) / 60000); return m < 1 ? 'just now' : m < 90 ? m + ' min ago' : Math.round(m / 60) + ' h ago'; }
  function matchupLine(c) {
    var model = (c.reasons || []).filter(function (r) { return r.kind === 'MODEL'; })[0];
    if (c.fair && c.fair.method === 'MODEL_BLEND' && model) return model.text;
    var mc = c.model_case;
    if (mc && num(mc.cover_at_market) != null && num(mc.break_even) != null) return num(mc.cover_at_market) > num(mc.break_even)
      ? 'EdgeDesk\'s projection agrees with the side (' + pct(num(mc.cover_at_market)) + ' to cover against ' + pct(num(mc.break_even)) + ' needed, ' + (mc.tier || 'unvalidated') + ' tier); no unit-level matchup claim is made from it'
      : 'none — EdgeDesk\'s projection does not favour this side (' + pct(num(mc.cover_at_market)) + ' to cover against ' + pct(num(mc.break_even)) + ' needed); the case is the price alone';
    return 'none claimed — this is a price out of line with the sharp market, not a matchup read';
  }
  function whyNot(p) {
    var auditSaid = p.audit && p.audit.status !== 'CONFIRMED';
    /* the audit's own reason leads; EDFAIR's "the audit did not confirm it" cap would only repeat it */
    var binding = (p.evaluation.caps || []).filter(function (x) { return x.binding && !(auditSaid && /^the audit/.test(x.reason)); }).map(function (x) { return x.reason; });
    if (p.withheld_by_board) binding.unshift('the decision layer withheld it (' + p.withheld_by_board + ')');
    if (auditSaid) binding.unshift('the audit ' + p.audit.status.toLowerCase().replace(/_/g, ' ') + ' it: ' + p.audit.reason);
    return binding.slice(0, 2).join('; ') || 'it did not clear every check';
  }
  function coverageSentence(s) {
    var parts = [];
    if (s.evaluated.length) parts.push('Scanned: ' + s.coverage.filter(function (c) { return c.status === 'EVALUATED'; }).map(function (c) { return c.label + (c.eligible != null ? ' (' + plural(c.eligible, 'game') + ')' : ''); }).join(', '));
    var empty = s.coverage.filter(function (c) { return c.status === 'NO_GAMES' || c.status === 'NO_ELIGIBLE_GAMES'; });
    if (empty.length) parts.push('no eligible games: ' + empty.map(function (c) { return c.label; }).join(', '));
    if (s.not_scanned.length) parts.push('NOT scanned: ' + s.not_scanned.map(function (c) { return c.label + ' (' + statusWord(c.status) + ')'; }).join(', '));
    var oos = s.coverage.filter(function (c) { return c.status === 'OUT_OF_SEASON'; });
    if (oos.length) parts.push('out of season: ' + oos.map(function (c) { return c.label; }).join(', '));
    if (s.not_covered.length) parts.push('not covered by EdgeDesk: ' + s.not_covered.map(function (c) { return c.label; }).join(', '));
    var c = s.counts;
    return 'Coverage — ' + parts.join('; ') + '. ' + (c.events != null ? plural(c.events, 'eligible event') + ', ' : '') + (c.markets_evaluated != null ? plural(c.markets_evaluated, 'market') + ' evaluated, ' : '') + plural(c.audited, 'candidate') + ' audited.' + (s.window && s.window.label ? ' Window: ' + s.window.label + '.' : '');
  }
  function statusWord(st) { return st === 'NOT_CAPTURED' ? 'prices not captured' : st === 'RETRIEVAL_FAILED' ? 'read failed' : st === 'NO_PRICES' ? 'games but no captured prices' : st === 'NOT_SUPPORTED' ? 'no data source' : str(st).toLowerCase().replace(/_/g, ' '); }

  /* ================================================================ */
  /* 3. CONTRACT AND PRICE CHECKS                                      */
  /* ================================================================ */
  /**
   * o.evaluation (EDFAIR result for the contract or wager), o.selection,
   * o.game { matchup, sport, sport_label, kickoff }, o.market_quote { book,
   * american, captured_at }, o.compare (EDFAIR.compareVenues), o.capability
   * (EDADAPT.modelCapability), o.context [strings], o.scenario (a second
   * evaluation, e.g. Kalshi fees when no venue was named), o.venue_named
   */
  function renderContract(o) {
    o = o || {};
    var F_ = F();
    var e = o.evaluation;
    var lines = [];
    if (!e || !e.ok) {
      var miss = (o.missing || []).slice();
      if (e && e.error) miss.unshift(e.error.message);
      return 'EdgeDesk did not price that' + (o.game ? ' (' + o.game.matchup + ')' : '') + ': ' + (miss.length ? miss.join('; ') : 'no result') + '. No expected value is quoted without a priced market, a known side and a fair probability.';
    }
    var x = F_.explain(e, { selection: o.selection });
    lines.push(x.headline);
    lines.push('');
    if (o.game) lines.push('Event: ' + o.game.matchup + (o.game.kickoff_local ? ' — ' + o.game.kickoff_local : '') + ' (' + (o.game.sport_label || o.game.sport) + ')');
    x.lines.forEach(function (l) { lines.push(l[0] + ': ' + l[1]); });
    if (o.capability) lines.push('Independent model: ' + (o.capability.may_price ? o.capability.name + ' (' + o.capability.tier + ')' : 'unavailable — ' + o.capability.reason));
    if (o.scenario && o.scenario.ok) lines.push('If this is Kalshi: taker fee ' + cents(o.scenario.expected_fees.per_contract) + ' (' + o.scenario.expected_fees.status.toLowerCase() + ' schedule) → net EV ' + pct(num(o.scenario.net_ev_per_dollar), 2) + ' per $1, maximum entry ' + cents(o.scenario.maximum_entry_price) + '.');
    if (o.compare && o.compare.ranked && o.compare.ranked.length > 1) {
      lines.push('');
      lines.push('Same outcome, every venue on file (all-in cost per $1 of payout):');
      o.compare.ranked.slice(0, 5).forEach(function (r) { lines.push(r.rank + '. ' + r.venue + ' ' + r.entry + ' → ' + r.all_in_cost_cents + '¢' + (r.net_ev_per_dollar != null ? ' (net EV ' + pct(num(r.net_ev_per_dollar), 2) + ')' : '') + (r.fees === 'UNVERIFIED' ? ' [fee schedule unverified]' : '')); });
      if (o.compare.best && o.compare.ranked[0] && o.compare.ranked[0].result.kind !== e.kind) lines.push('A cheaper way to hold the same outcome: ' + o.compare.ranked[0].venue + ' ' + o.compare.ranked[0].entry + ' — check that it settles the same way (overtime, postponement) before switching.');
      (o.compare.not_priced || []).forEach(function (n) { lines.push('Not priced: ' + n.venue + ' — ' + n.why + '.'); });
    }
    if (o.context && o.context.length) { lines.push(''); lines.push('Context (not a probability): ' + o.context.join(' · ')); }
    if (o.missing && o.missing.length) { lines.push(''); lines.push('Missing: ' + o.missing.join('; ') + '.'); }
    return lines.join('\n');
  }

  /** "Why is this contract negative EV?" — the components, in order. */
  function renderExplain(e, selection) {
    if (!e || !e.ok) return 'There is no contract price on this conversation to explain. Ask about one, e.g. "Is Rays at 61¢ positive EV on Kalshi?"';
    var isC = e.kind === 'CONTRACT';
    var parts = [];
    var fair = num(e.fair_probability), price = num(e.entry_price), fee = num(e.expected_fees && e.expected_fees.per_contract), slip = num(e.estimated_slippage && e.estimated_slippage.per_contract), be = num(e.break_even_probability);
    if (isC) {
      parts.push((selection || e.side) + ' at ' + cents(price) + ' costs ' + cents(price) + (fee != null ? ' plus ' + cents(fee) + ' in fees' : ' plus an unknown fee') + (slip ? ' plus ' + cents(slip) + ' slippage' : '') + ', so it breaks even only if it wins ' + (be != null ? pct(be, 1) : 'an unknown share') + ' of the time.');
      parts.push(fair != null ? 'EdgeDesk\'s fair probability is ' + pct(fair, 1) + ' (' + (e.fair_source.label || e.fair_source.kind) + ').' : 'There is no fair probability on file for it.');
      if (fair != null && be != null) parts.push(fair < be ? 'That is ' + pct(be - fair, 1) + ' short of break-even: each contract loses about ' + cents(be - fair) + ' on average (' + pct(num(e.net_ev_per_dollar), 2) + ' per $1).' : 'That is ' + pct(fair - be, 1) + ' above break-even: ' + pct(num(e.net_ev_per_dollar), 2) + ' per $1.');
      if (fair != null && price != null && fee != null && fair > price && fair < be) parts.push('Before fees it would be positive (' + cents(fair - price) + ' a contract); the fee is what turns it negative.');
      parts.push(e.maximum_entry_price != null ? 'It becomes playable at ' + cents(e.maximum_entry_price) + ' or less (fees included).' : 'No price clears the floor against this fair.');
    } else {
      parts.push((selection || 'This side') + ' at ' + fmtAm(e.entry_price) + ' breaks even at ' + pct(be, 1) + '; the fair is ' + pct(fair, 1) + ' (' + (e.fair_source.label || e.fair_source.kind) + '), so the expected value is ' + pct(num(e.net_ev_per_dollar), 2) + ' per $1.');
      parts.push(e.maximum_entry_price != null ? 'It becomes playable at ' + fmtAm(e.maximum_entry_price) + ' or better.' : 'No price clears the floor against this fair.');
    }
    return parts.join(' ');
  }

  /* ================================================================ */
  /* 4. COVERAGE AND OUTAGE                                            */
  /* ================================================================ */
  /** "Which sports couldn't be scanned?" — from the last scan when there is one, else from configuration and a live count. */
  function renderCoverage(o) {
    o = o || {};
    var st = sanitizeState(o.state);
    /* the live read is the fact; a scan carried by the client is used only when that read came back empty,
       and is labelled as the earlier scan it claims to be */
    var live = o.coverage && o.coverage.length ? o.coverage : null;
    var rows = live || (st && st.coverage && st.coverage.length ? st.coverage : []);
    var source = live ? 'EdgeDesk\'s capture configuration and the price rows on file now' : 'the earlier scan this conversation carries (' + (st && st.built_at || 'time unknown') + '); the live read returned nothing';
    var lines = [];
    var bad = rows.filter(function (c) { return c.status !== 'EVALUATED' && c.status !== 'NO_GAMES' && c.status !== 'NO_ELIGIBLE_GAMES' && c.status !== 'OUT_OF_SEASON'; });
    var ok = rows.filter(function (c) { return c.status === 'EVALUATED'; });
    if (!rows.length) return 'EdgeDesk has no scan on this conversation and could not read the price rows to build one.';
    lines.push(bad.length ? 'Not scanned: ' + bad.map(function (c) { return c.label + ' — ' + (c.why || statusWord(c.status)); }).join('; ') + '.' : 'Every in-season sport EdgeDesk supports was scanned.');
    if (ok.length) lines.push('Scanned: ' + ok.map(function (c) { return c.label; }).join(', ') + '.');
    var empty = rows.filter(function (c) { return c.status === 'NO_GAMES' || c.status === 'NO_ELIGIBLE_GAMES'; });
    if (empty.length) lines.push('Read, with no eligible games in the window: ' + empty.map(function (c) { return c.label; }).join(', ') + '.');
    var oos = rows.filter(function (c) { return c.status === 'OUT_OF_SEASON'; });
    if (oos.length) lines.push('Out of season: ' + oos.map(function (c) { return c.label; }).join(', ') + '.');
    var nc = (A() ? A().NOT_COVERED : []);
    if (nc.length) lines.push('Not covered at all: ' + nc.map(function (n) { return n.label + ' (' + n.why + ')'; }).join('; ') + '.');
    lines.push('Source: ' + source + '.');
    return lines.join(' ');
  }
  /**
   * "If the odds API fails, can you still analyze this game?"
   * o.feed { last_captured_at, sports:[{sport,label,last_captured_at}] } (one read), o.game (carried subject), o.now
   */
  function renderOutage(o) {
    o = o || {};
    var now = toMs(o.now) != null ? toMs(o.now) : Date.now();
    var lines = [];
    lines.push('Yes — the matchup analysis does not depend on the odds feed. What stays available: EdgeDesk\'s own projections and fair lines (football), the matchup and unit comparisons, injuries and projected starters, weather and rest, and the last captured prices, each labelled with its capture time (CACHED or STALE), never as live.');
    lines.push('What stops: a current expected value and any BUY decision. A stale price is shown as the last price observed, not one you can bet, and the desk switches to research-only for that market until a fresh capture lands.');
    if (o.feed && o.feed.last_captured_at) {
      var age = Math.round((now - toMs(o.feed.last_captured_at)) / 60000);
      lines.push('Right now the newest captured price is ' + (age < 90 ? age + ' minutes' : Math.round(age / 60) + ' hours') + ' old' + (o.feed.sports && o.feed.sports.length ? ' (' + o.feed.sports.map(function (s) { return s.label + ' ' + ageText(s.last_captured_at, now); }).join(', ') + ')' : '') + '.');
    } else if (o.feed) lines.push('Right now EdgeDesk could not read a captured price at all' + (o.feed.error ? ' (' + o.feed.error + ')' : '') + ', so any answer about value would be research-only.');
    if (o.game) lines.push('For ' + o.game + ': ask for the matchup breakdown and it will be built from the research layer alone, with the market section marked UNAVAILABLE or CACHED.');
    lines.push('Odds requests go through one budgeted gateway (a cache, a daily and monthly allowance, a circuit breaker), so a provider failure degrades answers to research-only rather than retrying without limit.');
    return lines.join(' ');
  }

  /* ================================================================ */
  /* 5. STATE — identifiers and EdgeDesk's own numbers only            */
  /* ================================================================ */
  function stateFrom(o) {
    o = o || {};
    var s = o.scan || null, c = o.contract || null;
    return {
      schema: STATE_SCHEMA, built_at: iso(o.now),
      coverage: s ? s.coverage.map(function (x) { return { sport: x.sport, label: x.label, status: x.status, why: x.why || x.sentence || null, eligible: num(x.eligible) }; }).slice(0, 16) : (o.prev && o.prev.coverage) || [],
      best: s && s.best ? { id: s.best.candidate.id, sport: s.best.candidate.sport, matchup: s.best.candidate.matchup, selection: s.best.candidate.selection, market: s.best.candidate.market, line: num(s.best.candidate.line), odds_american: num(s.best.candidate.quote.odds_american), book: s.best.candidate.quote.book || null } : null,
      contract: c ? { venue: c.venue || null, side: c.side || 'YES', price_cents: num(c.price_cents), american: num(c.american), selection: str(c.selection).slice(0, 80), sport: c.sport || null, game_id: c.game_id ? str(c.game_id).slice(0, 60) : null, market: c.market || null, fair_probability: num(c.fair_probability), fair_kind: c.fair_kind || null, fair_label: c.fair_label ? str(c.fair_label).slice(0, 120) : null, fair_observed_at: iso(c.fair_observed_at) } : (o.prev && o.prev.contract) || null
    };
  }
  function sanitizeState(raw) {
    if (!raw || typeof raw !== 'object' || raw.schema !== STATE_SCHEMA) return null;
    var STATUSES = ['EVALUATED', 'NO_GAMES', 'NO_ELIGIBLE_GAMES', 'NO_PRICES', 'NOT_CAPTURED', 'RETRIEVAL_FAILED', 'OUT_OF_SEASON', 'NOT_SUPPORTED', 'NOT_EVALUATED'];
    var cov = Array.isArray(raw.coverage) ? raw.coverage.filter(function (x) { return x && STATUSES.indexOf(x.status) >= 0; }).map(function (x) { return { sport: str(x.sport).slice(0, 40), label: str(x.label).slice(0, 40), status: x.status, why: x.why ? str(x.why).slice(0, 200) : null, eligible: num(x.eligible) }; }).slice(0, 16) : [];
    var c = raw.contract && typeof raw.contract === 'object' ? raw.contract : null;
    var pc = c ? num(c.price_cents) : null;
    var fp = c ? num(c.fair_probability) : null;
    return {
      schema: STATE_SCHEMA, built_at: iso(raw.built_at), coverage: cov,
      best: raw.best && typeof raw.best === 'object' ? { id: str(raw.best.id).slice(0, 160), sport: str(raw.best.sport).slice(0, 40), matchup: str(raw.best.matchup).slice(0, 120), selection: str(raw.best.selection).slice(0, 80), market: str(raw.best.market).slice(0, 12), line: num(raw.best.line), odds_american: num(raw.best.odds_american), book: raw.best.book ? str(raw.best.book).slice(0, 40) : null } : null,
      contract: c ? { venue: c.venue === 'kalshi' || c.venue === 'polymarket' ? c.venue : null, side: c.side === 'NO' ? 'NO' : 'YES', price_cents: pc != null && pc > 0 && pc < 100 ? pc : null, american: num(c.american), selection: str(c.selection).slice(0, 80), sport: c.sport ? str(c.sport).slice(0, 40) : null, game_id: c.game_id ? str(c.game_id).slice(0, 60) : null, market: c.market ? str(c.market).slice(0, 12) : null,
        /* the carried fair is re-read by the host before it is used; it is kept only to say what was said */
        fair_probability: fp != null && fp > 0 && fp < 1 ? fp : null, fair_kind: ['SHARP_NO_VIG', 'CONSENSUS_NO_VIG', 'MODEL', 'USER'].indexOf(c.fair_kind) >= 0 ? c.fair_kind : null, fair_label: c.fair_label ? str(c.fair_label).slice(0, 120) : null, fair_observed_at: iso(c.fair_observed_at) } : null
    };
  }

  /* ================================================================ */
  /* 6. THE CRITIC — for any prose written over these answers          */
  /* ================================================================ */
  var CERTAINTY = /\b(guarantee|guaranteed|can'?t (lose|miss)|lock|locks|sure thing|free money|will (win|cover|cash)|no[- ]brainer|easy money|risk[- ]free)\b/i;
  /** Fail prose that adds certainty, an unlisted number, or calls a non-verified result verified or best across all sports. */
  function critic(prose, ctx) {
    ctx = ctx || {};
    var f = [];
    var p = str(prose);
    if (CERTAINTY.test(p)) f.push({ code: 'CERTAINTY', detail: (p.match(CERTAINTY) || [])[0] });
    if (/\bverified\b/i.test(p) && ctx.decision !== 'BUY') f.push({ code: 'VERIFIED_WITHOUT_AUDIT', detail: 'the prose calls something verified that the audit did not confirm' });
    if (/\b(across|in) all sports\b|\bbest (bet|play) (anywhere|overall)\b/i.test(p) && ctx.coverage_scope !== 'ALL_IN_SEASON') f.push({ code: 'COVERAGE_OVERCLAIM', detail: 'the prose claims all sports while coverage was partial' });
    var allowed = ctx.allowed_numbers || [];
    var nums = p.match(/[+-]?\d+(?:\.\d+)?%?/g) || [];
    var stray = nums.filter(function (n) { var v = n.replace(/[%+]/g, ''); return !allowed.some(function (a) { return String(a) === v || String(a) === n; }); });
    if (allowed.length && stray.length) f.push({ code: 'UNLISTED_NUMBER', detail: stray.slice(0, 5).join(', ') });
    return { verdict: f.length ? 'FAIL' : 'PASS', findings: f };
  }

  return {
    VERSION: VERSION, STATE_SCHEMA: STATE_SCHEMA, NO_EDGE: NO_EDGE, RX: RX,
    classify: classify, unsupportedMarket: unsupportedMarket, sportOf: sportOf, candidatesFromBoard: candidatesFromBoard, matchesFilter: matchesFilter,
    scanResult: scanResult, renderScan: renderScan, renderResearchScan: renderResearchScan, renderResearchSlate: renderResearchSlate, renderReadiness: renderReadiness, renderGameResearch: renderGameResearch, renderMatchupEdges: renderMatchupEdges, renderVenueCompare: renderVenueCompare, readinessLine: readinessLine, coverageSentence: coverageSentence, lineOf: lineOf, matchupLine: matchupLine,
    renderContract: renderContract, renderExplain: renderExplain, renderCoverage: renderCoverage, renderOutage: renderOutage,
    stateFrom: stateFrom, sanitizeState: sanitizeState, critic: critic
  };
});
/*__EDQUANT_END__*/
