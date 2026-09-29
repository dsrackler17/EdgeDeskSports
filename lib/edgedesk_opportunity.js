/* ===========================================================================
   EDGEDESK OPPORTUNITY — one research-and-decision object for a game market
   and for a player prop, so Research, the Props page, the Card and the AI
   desk read the same thing. docs/opportunity/DESIGN.md

   WHAT THIS FILE IS
     A connecting layer. Every number an opportunity carries was produced by
     an engine that already exists, and this file only reads it:

       game decisions   lib/edgedesk_decision.js   EDDecision.decide (the
                        canonical decision object: decision, units, quote)
       prop decisions   lib/edgedesk_props.js      EDProps.evaluate / compact
                        (probability, EV at the exact price, BET / LEAN /
                        WATCH / PASS / NO DECISION, confidence, units)
       dollars, limits  lib/edgedesk_bankroll.js   EDBankroll
       words            lib/edgedesk_vocab.js      EDVocab.DECISION

     What it adds, each in ONE place:

       calculatePropEV()            the EV arithmetic at an exact price (a
                                    facade over EDProps.expectedValue)
       classifyPropDecision()       the one prop classifier (EDProps.evaluate)
       calculatePropResearchScore() "which prop should a researcher open
                                    first?" — NOT the bet decision
       calculateOpportunityUnits()  the engines' units, then a validation-stage
                                    ceiling for props (never larger)
       getEventPropSummary()        one game's prop picture: counts, capture
       getTopEventProps()           state, the best research candidates
       gameContext() / propGameLink()  the game model beside the prop model
       explainProp()                why a prop is interesting, and concerns,
                                    from structured data only
       card*()                      the Card's saved snapshots, positions,
                                    exposure, same-game correlation, price
                                    moves and the GAME / PLAYER PROP record

   WHAT THIS FILE NEVER DOES
     - price a prop, size a stake above the engine, or classify anything a
       second way: a decision is the engine's, and a stale price at view time
       only takes it DOWN (NO DECISION · STALE_QUOTE, the kernel's own rule);
     - invent a price, a probability, a correlation or a reason. A field the
       data does not carry stays null, and the sentence that needs it is not
       written;
     - feed EdgeDesk's game margin into a player projection. The prop model
       takes its script from the market (football/props/model.js
       environment()); where no market existed it already used EdgeDesk's
       own number. Adding it again would count one signal twice, so the game
       model is shown BESIDE the projection as a labelled sensitivity.

   Browser: window.EDOpportunity (load edgedesk_props.js first).
   Node: require('./edgedesk_opportunity.js').
   Edge function: inlined between the EDOPP markers into
   supabase/functions/edgedesk_ai/index.ts by tools/presentation/inline.js.
   ES5, no other dependencies.
   =========================================================================== */
/*__EDOPP_START__*/
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EDOpportunity = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  var VERSION = 'edgedesk_opportunity_v1';
  var SCHEMA = 'edgedesk_opportunity/1';
  var SUMMARY_SCHEMA = 'edgedesk_prop_summary_v1';
  var ENTRY_SCHEMA = 'edgedesk_card_entry/1';

  /* ------------------------------------------------------------ deps */
  function dep(name, file) {
    if (root && root[name]) return root[name];
    if (typeof require === 'function') { try { return require(file); } catch (e) { return null; } }
    return null;
  }
  function PR() { var p = dep('EDProps', './edgedesk_props.js'); if (!p) throw new Error('EDOpportunity needs lib/edgedesk_props.js (EDProps) loaded first'); return p; }
  function DEC() { return dep('EDDecision', './edgedesk_decision.js'); }
  function BANK() { return dep('EDBankroll', './edgedesk_bankroll.js'); }
  function VOC() { return dep('EDVocab', './edgedesk_vocab.js'); }

  /* ---------------------------------------------------------- helpers */
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function r(x, d) { if (!isNum(x)) return null; var p = Math.pow(10, d == null ? 3 : d); var v = Math.round(x * p) / p; return v === 0 ? 0 : v; }
  function ms(t) { if (t == null || t === '') return null; if (typeof t === 'number') return isFinite(t) ? t : null; var v = Date.parse(t); return isFinite(v) ? v : null; }
  function iso(t) { var v = ms(t); return v == null ? null : new Date(v).toISOString(); }
  function copy(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.keys(o).forEach(function (k) { deepFreeze(o[k]); }); } return o; }
  function hash(parts) {
    var s = typeof parts === 'string' ? parts : JSON.stringify(parts), h = 0x811c9dc5, i;
    for (i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul ? Math.imul(h, 16777619) >>> 0 : (h * 16777619) >>> 0; }
    return ('00000000' + h.toString(16)).slice(-8);
  }
  function lineText(v) { if (!isNum(v)) return '—'; if (Math.abs(v) < 1e-9) return 'PK'; var s = String(Math.round(v * 10) / 10).replace(/\.0$/, ''); return (v > 0 ? '+' : '') + s; }
  function priceText(a) { return isNum(a) ? (a > 0 ? '+' + Math.round(a) : String(Math.round(a))) : '—'; }
  function pctText(x, dp) { return isNum(x) ? (x >= 0 ? '+' : '−') + Math.abs(100 * x).toFixed(dp == null ? 1 : dp) + '%' : '—'; }
  function probText(x, dp) { return isNum(x) ? (100 * x).toFixed(dp == null ? 1 : dp) + '%' : '—'; }
  function ppText(x, dp) { return isNum(x) ? (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(dp == null ? 1 : dp) + ' pp' : '—'; }
  function unitsText(u) { return isNum(u) ? (Math.round(u * 100) / 100).toFixed(2) + 'U' : '—'; }
  function f1(x) { return isNum(x) ? (Math.abs(x) >= 20 ? x.toFixed(1) : x.toFixed(2).replace(/0$/, '')) : '—'; }
  function andList(a) { return a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]; }

  /* ================================================================ IDENTITY
     The canonical event is '<league>|<game_id>' — the research state's
     game_key (lib/edgedesk_personal.js) and the prop board's game id are
     the same schedule id (nflverse for the NFL, ESPN for college), so a
     game and its props join on the id, never on a displayed team name.
     The sportsbook's own event id rides along as provider_event_id. */
  function leagueOf(x) { var s = String(x == null ? '' : x).toLowerCase(); return s === 'p4' || s === 'fbs' || s === 'ncaaf' || s === 'cfb' ? 'cfb' : s === 'nfl' ? 'nfl' : null; }
  function eventKey(league, gameId) { var lg = leagueOf(league); return lg && gameId != null && gameId !== '' ? lg + '|' + String(gameId) : null; }
  function splitKey(k) { var s = String(k || ''), i = s.indexOf('|'); return i < 0 ? null : { league: leagueOf(s.slice(0, i)), game_id: s.slice(i + 1) }; }

  /* ================================================================== RULES
     Every threshold is an existing EdgeDesk number (named); only the
     research-score WEIGHTS and the research-grade floor are new, and they
     order reading, never money. */
  function decisionConfig() {
    var P = PR();
    return P.decisionConfig ? P.decisionConfig() : { thresholds: P.DECISION_FALLBACK.thresholds, sizing: P.DECISION_FALLBACK.sizing };
  }
  var RULES = {
    version: 'opportunity_rules_v1',
    validation_state: 'CONSERVATIVE_DEFAULT_UNVALIDATED',
    research: {
      /* the weights of the prop research score (0-100) */
      weights: { ev: 20, edge: 15, confidence: 20, market: 15, disagreement: 10, decision: 20 },
      /* how much each decision says "look here" */
      decision_part: { BET: 1, LEAN: 0.75, WATCH: 0.5, PASS: 0, NO_DECISION: 0 },
      /* full credit at: EV and edge at the engine's STRONG thresholds
         (EDDecision thresholds.strong), four two-sided books (EDProps
         valueScore's liquidity basis), EDProps.CONFIG.strong_disagreement_pp */
      market_full_books: 4,
      /* the kernel's own discounts (EDProps valueScore / caps), applied only
         at the kernel's cap thresholds so confidence is not charged twice */
      factor: { aging: 0.85, stale: 0.5, thin_sample: 0.6, role_unstable: 0.75, availability: 0.7 },
      penalty: { price_anomaly: 15, tail_alternate: 10, single_book: 10, qb_unresolved: 10, low_completeness: 5 },
      low_completeness: 0.5,
      /* research grade: a fresh, priced prop whose decision is BET, LEAN or
         WATCH, with positive EV, at least the engine's LEAN edge
         (EDDecision thresholds.lean.min_edge_pp), decision confidence at or
         above the kernel's floor (EDProps CONFIG.caps.min_confidence), and a
         score that clears this floor */
      grade_min: 60
    },
    /* how many props a game card lists before "View all" */
    card_props: 4,
    /* the prop signal in the game reading order (lib/research_priority.js
       reads these through the candidate; see propSignal()) */
    summary_top: 4, league_top: 10,
    /* a saved Card position has MOVED when its line changed or the price
       moved at least this many cents (EDDecision leagues.NFL
       watch_trigger_cents) */
    price_move_cents: 10,
    /* the prop model's own script rule, read from the summary when the build
       stamps it (football/props/model.js PARAMS.script_pass_rate_per_pt) */
    research_gap_pts: 2       /* lib/research_priority.js RESEARCH_GAP */
  };

  /* ============================================================== DECISIONS */
  var KEYS = ['BET', 'LEAN', 'WATCH', 'PASS', 'NO_DECISION'];
  var RANK = { NO_DECISION: -1, PASS: 0, WATCH: 1, LEAN: 2, BET: 3 };
  function decisionKey(d) { var k = String(d || '').toUpperCase().replace(/ /g, '_'); return k === 'WAIT' || k === 'WATCHING' ? 'WATCH' : (RANK[k] != null ? k : 'NO_DECISION'); }
  function decisionWords(d) {
    var k = decisionKey(d), V = VOC(), dv = V && V.DECISION ? V.DECISION[k] : null;
    return { key: k, label: dv ? dv.label : k.replace('_', ' '), tone: dv ? dv.tone : ({ BET: 'bet', LEAN: 'lean', WATCH: 'watch', PASS: 'pass' })[k] || 'none' };
  }

  /* ============================================================ SERVICES */
  /* the EV of one exact price from a win (and push) probability */
  function calculatePropEV(pWin, american, pPush) {
    var P = PR(), d = P.toDecimal(american), push = isNum(pPush) ? pPush : 0;
    if (d == null || !isNum(pWin)) return null;
    var ev = P.expectedValue(pWin, american, push), be = 1 / d, side = pWin / Math.max(1e-9, 1 - push);
    return { ev: r(ev, 4), decimal: r(d, 6), break_even: r(be, 4), probability: r(side, 4), p_win: r(pWin, 4), p_push: r(push, 4),
      edge_pp: r(100 * (side - be), 2), fair_american: P.fairAmerican(pWin, push) };
  }
  /* THE prop classifier. There is one: EDProps.evaluate (Layer A: can it be
     evaluated; Layer B: BET / LEAN / WATCH / PASS with every cap). */
  function classifyPropDecision(prop, opts) { return PR().evaluate(prop, opts); }
  function classifyBoardRow(board, row, now) { return PR().boardEval(board, row, now); }

  /* the price's age judged NOW, and whether it may still be acted on: both
     EDProps' one rule (quoteFreshness / isExecutableQuote), never a copy */
  function freshness(at, now) { return PR().freshnessOf({ captured_at: at }, now); }
  function windowMinutes() { var P = PR(); return P && P.FRESHNESS ? P.FRESHNESS.executable_max_minutes : 30; }

  /* A decision made at build time is re-judged at view time for the two
     things time alone changes: the price aged past the decision window, or
     the game kicked off. Only ever DOWN, and the numbers stay on the object
     (labelled) so the reader sees what was last seen. */
  function refresh(o, now) {
    if (!o || o.type !== 'PLAYER_PROP') return o;
    var t = ms(now) || Date.now();
    var kick = o.event ? ms(o.event.kickoff) : null;
    var x = null;
    if (o.price && o.price.captured_at) {
      x = PR().isExecutableQuote({ captured_at: o.price.captured_at, american: o.price.american, line: o.selection ? o.selection.line : null }, { now: t, kickoff: o.event ? o.event.kickoff : null });
      o.price.fresh = x.state; o.price.age_minutes = x.age_minutes; o.price.executable = x.executable;
    }
    var why = null;
    if (kick != null && t >= kick) why = ['GAME_STARTED', 'The game has started: pregame props are closed.'];
    else if (o.price && o.decision !== 'NO_DECISION' && (!o.price.captured_at || (x && !x.executable)))
      why = ['STALE_QUOTE', 'The price EdgeDesk evaluated is ' + (isNum(o.price.age_minutes) ? Math.round(o.price.age_minutes) + ' minutes' : 'of unknown') + ' old: past the ' + windowMinutes() + '-minute execution window. Wait for a current price.'];
    if (why) {
      if (o.decision !== 'NO_DECISION' && !o.evaluated) o.evaluated = { decision: o.decision, decision_label: o.decision_label, tone: o.tone, code: o.code, reason: o.reason, units: o.units };
      if (o.evaluated) o.evaluated_decision = o.evaluated.decision;
      o.decision = 'NO_DECISION'; o.code = why[0]; o.reason = why[1]; o.units = 0; o.stale = why[0] === 'STALE_QUOTE';
      if (o.blockers.indexOf(why[0]) < 0) o.blockers.push(why[0]);
      var w = decisionWords('NO_DECISION'); o.decision_label = w.label; o.tone = w.tone;
    }
    return o;
  }

  /* ====================================================== PROP → OPPORTUNITY
     From one board row (football/props/<lg>/board.json) and its compact
     evaluation — the build's (row.e) or the page's re-priced one — never a
     second evaluation of the same thing. */
  function booksAt(row, side, line) {
    var s = side === 'over' ? 'o' : 'u', b = {};
    (row.q || []).forEach(function (a) { if (a[2] === s && Math.abs(a[1] - line) < 1e-9) b[a[0]] = 1; });
    return Object.keys(b).length;
  }
  var CODE_TEXT = {
    QUALIFIES: 'The price clears EdgeDesk’s edge and EV thresholds.',
    EDGE_BELOW_BET: 'A positive edge below the betting threshold.',
    EDGE_TOO_SMALL: 'The edge is too small to act on.',
    NO_POSITIVE_EV: 'No positive expected value at any captured price.',
    MARKET_INFORMED_EV_NEGATIVE: 'Positive only on the raw model; negative once the declared market blend is applied.',
    NO_EXECUTABLE_PRICE: 'No price inside the executable band.',
    SIZING_ZERO: 'No stake survives the sizing caps.',
    AVAILABILITY_PENDING: 'The player’s status is unresolved: wait for the final status.',
    QB_UNRESOLVED: 'The starting quarterback is unconfirmed after a change.',
    PRICE_ANOMALY: 'An extreme EV no second book corroborates: verify the price first.',
    LOW_CONFIDENCE: 'Decision confidence is below the betting floor.',
    THIN_SAMPLE: 'Fewer than three games of this season’s data.',
    ROLE_UNSTABLE: 'The player’s role has moved sharply over recent games.',
    TAIL_ALTERNATE: 'An alternate line beyond EdgeDesk’s median.',
    ONE_SIDED_MARKET: 'No book deals both sides: there is no no-vig anchor.',
    NO_MARKET_ANCHOR: 'No two-sided consensus anchors the market-informed projection.',
    SINGLE_BOOK: 'Only one sportsbook is quoting this player.',
    STAGE_EXPERIMENTAL: 'This market has not passed EdgeDesk’s validation gates: it informs, it never stakes.',
    PLAYER_EXPOSURE: 'EdgeDesk already stakes this player’s other props up to the 1U player cap.',
    CORRELATED_EXPOSURE: 'This game’s correlated prop stake is at its cap.'
  };
  /* "Over 38.5 rushing yards" / "Anytime TD" / "No Anytime TD" */
  function propSelText(mk, side, line) {
    var m = PR().MARKETS[mk]; if (!m || !side) return null;
    if (m.yesno) return (side === 'over' ? '' : 'No ') + m.label;
    return (side === 'over' ? 'Over ' : 'Under ') + (isNum(line) ? String(line) : '—') + ' ' + m.label.toLowerCase();
  }
  function codeText(code) { var P = PR(); return CODE_TEXT[code] || (P.BLOCK_TEXT && P.BLOCK_TEXT[code]) || String(code || '').replace(/_/g, ' ').toLowerCase(); }

  function fromPropRow(board, row, opts) {
    opts = opts || {};
    var P = PR(), e = opts.compact || row.e || {}, lg = leagueOf(board.league);
    var now = ms(opts.now) != null ? ms(opts.now) : Date.now();
    var g = P.boardGames(board)[row.g] || {}, pl = P.boardCtx(board, row) || {}, x = row.x || {};
    var mk = P.MARKETS[row.m] || { label: row.m, cat: null };
    var c = e.cand || null, cons = e.cons || null, inf = e.inf || null, raw = e.raw || null;
    var side = c ? c[0] : null, line = c ? c[1] : null, american = c ? c[2] : null, book = c ? c[3] : null;
    var m = c ? calculatePropEV(c[4], american, c[5] || 0) : null;
    var st = pl.status || {};
    var stage = board.stages && board.stages[row.m] ? board.stages[row.m].stage : null;
    var words = decisionWords(e.d);
    var o = {
      schema: SCHEMA, engine: VERSION, type: 'PLAYER_PROP', sport: lg ? lg.toUpperCase() : null, league: lg,
      event: { event_key: eventKey(lg, row.g), game_id: String(row.g), provider_event_id: g.event_id || null, home: g.home || null, away: g.away || null,
        home_name: g.home_name || null, away_name: g.away_name || null, kickoff: g.kickoff || null, status: g.status || null },
      player: { id: row.p || null, name: pl.name || row.name || null, team: pl.team || null, opp: pl.opp || null, position: pl.pos || null,
        status: st.status || null, practice: st.practice || null, injury: st.injury || null, report_on_file: st.on_file === true ? true : st.on_file === false ? false : null,
        sample_games: num(x.sg), prior_games: num(x.pg), role_stability: num(x.rs), completeness: num(x.cp),
        qb_change: !!x.qc, qb_unconfirmed: !!x.qu, teammate_uncertain: !!x.tu },
      market: { kind: 'player_prop', key: row.m, label: mk.label, category: mk.cat, yesno: !!mk.yesno },
      selection: side ? { side: side, line: line, text: propSelText(row.m, side, line), short: P.selectionText(row.m, side, line) } : null,
      price: c ? { american: american, book: book, book_name: P.bookName(book), captured_at: c[11] || null, age_minutes: null, fresh: null, alt: !!c[10],
        books_at_line: booksAt(row, side, line) } : null,
      model: { probability: m ? m.probability : null, p_win: m ? m.p_win : null, p_push: m ? m.p_push : null, fair_american: c ? c[9] : null,
        projection: inf ? { mean: inf[0], median: inf[1], p25: inf[2], p75: inf[3] } : null, raw_mean: raw ? raw[0] : null,
        fair_line: inf ? inf[1] : null, market_implied_mean: isNum(e.mm) ? e.mm : null },
      market_view: cons ? { consensus_line: cons[0], over: cons[1], under: cons[2], novig_over: cons[3],
        novig_side: isNum(cons[3]) && side ? r(side === 'under' ? 1 - cons[3] : cons[3], 4) : null,
        n_books: cons[4], n_two_sided: cons[5], interpolated: !!cons[6] } : null,
      break_even: m ? m.break_even : null, ev: c ? c[6] : null, ev_raw: c ? c[7] : null, edge_pp: c ? c[8] : null,
      disagreement_toward_pp: isNum(e.dp) && side ? r(side === 'under' ? -e.dp : e.dp, 2) : null,
      confidence: num(e.cf), decision: words.key, decision_label: words.label, tone: words.tone, code: e.c || null, reason: codeText(e.c),
      units: num(e.u) || 0, engine_units: num(e.u) || 0, tier: e.t || null,
      caps: (e.caps || []).slice(), warnings: (e.w || []).slice(), blockers: (e.b || []).slice(),
      exposure_cap: e.xp ? { code: e.xp[0], from_units: e.xp[1], text: e.xp[2] } : null,
      probability_source: board.probability ? board.probability.source : 'model_estimated',
      probability_label: board.probability ? board.probability.label : 'MODEL-ESTIMATED (UNVALIDATED CALIBRATION)',
      stage: stage,
      movement: row.mv ? { text: row.mv.text || null, line_move: num(row.mv.line_move) } : null,
      evaluated_at: iso(opts.evaluated_at) || iso(board.generated_at) || iso(now)
    };
    o.key = 'prop|' + lg + '|' + row.g + '|' + (row.p || 'name:' + (row.name || '?')) + '|' + row.m + '|' + (side || '-');
    o.prop_id = row.key || row.id || (lg + '|' + row.g + '|' + row.p + '|' + row.m);
    o.id = 'opp_' + hash([o.key, line, american, book, o.decision, o.evaluated_at]);
    refresh(o, now);
    var U = calculateOpportunityUnits(o); o.units = U.units; o.unit_caps = U.caps;
    o.research = calculatePropResearchScore(o, { game_state: opts.game_state || null });
    if (opts.explain !== false && opts.ev) o.explanation = explainProp(o, { ev: opts.ev, board: board, row: row, context: opts.context || gameContext(g, opts.game_state, board) , script_rule: opts.script_rule });
    return o;
  }

  /* ====================================================== GAME → OPPORTUNITY
     From the canonical decision object (EDDecision.decide / decisions.json). */
  var MARKET_LABEL = { spread: 'Spread', total: 'Total', moneyline: 'Moneyline', player_prop: 'Player prop' };
  function gameSelText(q, mt) {
    if (!q) return null;
    var sd = String(q.side || '');
    if (mt === 'total') return sd.charAt(0).toUpperCase() + sd.slice(1) + ' ' + (isNum(q.line) ? String(Math.round(q.line * 10) / 10) : '—');
    return (q.team || sd) + (mt === 'moneyline' ? ' ML' : ' ' + lineText(q.line));
  }
  function fromGameDecision(d, opts) {
    opts = opts || {};
    if (!d) return null;
    var lg = leagueOf(d.sport || d.league), mt = d.market_type || 'spread', k = decisionKey(d.decision);
    var q = k === 'BET' && d.bet_price ? d.bet_price : (d.reference_quote || d.bet_price || null);
    var w = decisionWords(k);
    var ev = q && isNum(q.decision_ev) ? q.decision_ev : (isNum(d.decision_ev_pct) ? d.decision_ev_pct / 100 : null);
    var o = {
      schema: SCHEMA, engine: VERSION, type: 'GAME', sport: lg ? lg.toUpperCase() : null, league: lg,
      event: { event_key: eventKey(lg, d.game_id), game_id: String(d.game_id), provider_event_id: d.market && d.market.event_id || (d.quote && d.quote.event_id) || null,
        home: d.home || null, away: d.away || null, home_name: d.home || null, away_name: d.away || null, kickoff: d.kickoff || null },
      market: { kind: mt, key: mt, label: MARKET_LABEL[mt] || mt },
      selection: q ? { side: q.side || null, team: q.team || null, line: num(q.line), text: gameSelText(q, mt) } : null,
      price: q ? { american: num(q.odds), book: q.book || null, book_name: q.book || null, captured_at: q.captured_at || null, age_minutes: num(q.quote_age_minutes), fresh: null } : null,
      model: { probability: q ? (isNum(q.decision_cover) ? q.decision_cover : num(q.cover_probability)) : num(d.probability), fair_american: q ? num(q.fair_odds) : null,
        fair_line: num(d.model_fair_line), fair_text: d.model_fair_text || null },
      market_view: { consensus_line: num(d.consensus_market_line), consensus_text: d.consensus_text || null, gap_pts: num(d.model_market_gap) },
      break_even: q ? num(q.break_even_probability) : num(d.break_even), ev: r(ev, 4), edge_pp: isNum(d.edge_pp) ? d.edge_pp : (q ? num(q.edge_pp) : null),
      confidence: num(d.decision_confidence), reliability: num(d.reliability_score),
      decision: w.key, decision_label: w.label, tone: w.tone, code: d.action_reason_code || null, reason: d.action_reason_text || null,
      units: w.key === 'BET' ? (num(d.recommended_units) || 0) : 0, engine_units: num(d.recommended_units) || 0, tier: d.tier || d.strength || null,
      caps: (d.caps || []).map(function (c) { return c && c.code ? c.code : c; }), warnings: (d.warnings || []).map(function (c) { return c && c.code ? c.code : c; }),
      blockers: (d.blocker_codes || []).slice(), probability_source: d.probability_source || null, probability_label: d.probability_source_label || null,
      decision_id: d.decision_id || null, playable: d.playable ? d.playable.short || null : null,
      evaluated_at: iso(d.evaluated_at) || iso(opts.now) || new Date().toISOString()
    };
    o.key = 'game|' + lg + '|' + d.game_id + '|' + mt + '|' + ((q && q.side) || '-');
    o.id = 'opp_' + hash([o.key, o.selection && o.selection.line, o.price && o.price.american, o.decision, o.evaluated_at]);
    var U = calculateOpportunityUnits(o); o.units = U.units; o.unit_caps = U.caps;
    return o;
  }

  /* ================================================================= UNITS
     GAME: the decision engine's units, unchanged (it already applied its
     tiers, the probability-source cap, quarter-Kelly and every cap).
     PLAYER PROP: the prop kernel's units (tiers, MODEL-ESTIMATED 0.25U cap,
     quarter-Kelly, single book, material uncertainty, player and game
     exposure caps), then a ceiling from the market's VALIDATION STAGE, so a
     prop never sizes above a game market until its own grading earns it:
       EXPERIMENTAL      0U (the kernel caps it at LEAN)
       TRACKING          the model-estimated cap
       RESEARCH GRADE    the partially-calibrated cap
       PRODUCTION        the probability source's own cap
     Always rounded DOWN onto the engine's grid; never above it. */
  function stageCap(stage, source) {
    var S = decisionConfig().sizing || {}, C = S.source_caps || {};
    if (stage === 'EXPERIMENTAL') return 0;
    if (stage === 'TRACKING') return isNum(C.model_estimated) ? C.model_estimated : 0.25;
    if (stage === 'RESEARCH_GRADE') return isNum(C.partially_calibrated) ? C.partially_calibrated : 0.5;
    if (stage === 'PRODUCTION') return isNum(C[source]) ? C[source] : (isNum(C.model_estimated) ? C.model_estimated : 0.25);
    return isNum(C.model_estimated) ? C.model_estimated : 0.25;   /* no stage on file: the most conservative staked cap */
  }
  function floorGrid(u) { var g = decisionConfig().sizing.grid || [0.25, 0.5, 0.75, 1], best = 0; g.forEach(function (x) { if (x <= u + 1e-9 && x > best) best = x; }); return best; }
  function calculateOpportunityUnits(o) {
    var caps = [];
    if (!o || decisionKey(o.decision) !== 'BET') return { units: 0, caps: caps, basis: 'only a BET carries units' };
    var u = num(o.engine_units != null ? o.engine_units : o.units) || 0;
    if (o.type !== 'PLAYER_PROP') return { units: floorGrid(u), caps: caps, basis: 'EDDecision units' };
    var sc = stageCap(o.stage, o.probability_source);
    if (sc < u) { caps.push({ code: 'VALIDATION_STAGE', units: sc, text: 'The ' + String(o.stage || 'unstaged').toLowerCase().replace('_', ' ') + ' stage caps a prop stake at ' + unitsText(sc) + '.' }); u = sc; }
    var max = decisionConfig().sizing.max_units || 1;
    return { units: floorGrid(Math.min(u, max)), caps: caps, basis: 'EDProps units, capped by the market’s validation stage' };
  }

  /* ========================================================= RESEARCH SCORE
     "What should a researcher open first?" 0-100, NOT a probability, an
     edge or a bet decision. A weighted blend of what the engines already
     measured, discounted by what could make the number wrong. Every part
     is returned so the order is debuggable. */
  function calculatePropResearchScore(o, ctx) {
    ctx = ctx || {};
    var R = RULES.research, T = decisionConfig().thresholds, P = PR(), W = R.weights;
    var out = { score: 0, grade: false, parts: {}, factors: {}, penalties: {}, reasons: [], rule: 'opportunity research score v1' };
    if (!o || o.type !== 'PLAYER_PROP') return out;
    var d = decisionKey(o.evaluated_decision || o.decision);
    var fresh = o.price ? o.price.fresh : null;
    var parts = {
      ev: isNum(o.ev) ? clamp(o.ev / T.strong.min_ev, 0, 1) : 0,
      edge: isNum(o.edge_pp) ? clamp(o.edge_pp / T.strong.min_edge_pp, 0, 1) : 0,
      confidence: isNum(o.confidence) ? clamp(o.confidence / 100, 0, 1) : 0,
      market: o.market_view && isNum(o.market_view.n_two_sided) ? clamp(o.market_view.n_two_sided / R.market_full_books, 0, 1) : 0,
      disagreement: isNum(o.disagreement_toward_pp) && o.disagreement_toward_pp > 0 ? clamp(o.disagreement_toward_pp / P.CONFIG.strong_disagreement_pp, 0, 1) : 0,
      decision: R.decision_part[d] || 0
    };
    var base = 0; Object.keys(W).forEach(function (k) { base += W[k] * parts[k]; });
    var F = {}, f = 1, pl = o.player || {};
    if (fresh === 'AGING') F.freshness = R.factor.aging;
    else if (fresh !== 'FRESH') F.freshness = R.factor.stale;
    if (o.price && o.price.executable === false) F.freshness = 0;
    if (isNum(pl.sample_games) && pl.sample_games < P.CONFIG.caps.min_games) F.sample = R.factor.thin_sample;
    if (isNum(pl.role_stability) && pl.role_stability < P.CONFIG.caps.role_stability) F.role = R.factor.role_unstable;
    var sts = String(pl.status || '').toUpperCase();
    if (sts === 'OUT') F.availability = 0;
    else if (sts === 'QUESTIONABLE' || sts === 'DOUBTFUL') F.availability = R.factor.availability;
    /* the game's data reliability, where the research view scores it
       (college): the research order's own trust factors */
    var gs = ctx.game_state, rel = gs && gs.reliability ? gs.reliability : null;
    var RP = dep('EDResearchPriority', './research_priority.js');
    if (rel && rel.tier && RP && RP.TRUST && RP.TRUST.reliability[rel.tier] != null && RP.TRUST.reliability[rel.tier] < 1) F.game_reliability = RP.TRUST.reliability[rel.tier];
    Object.keys(F).forEach(function (k) { f *= F[k]; });
    var pen = {}, capCodes = (o.caps || []).map(function (c) { return c && c.code ? c.code : c; });
    if (capCodes.indexOf('PRICE_ANOMALY') >= 0) pen.price_anomaly = R.penalty.price_anomaly;
    if (capCodes.indexOf('TAIL_ALTERNATE') >= 0) pen.tail_alternate = R.penalty.tail_alternate;
    if (o.market_view && isNum(o.market_view.n_books) && o.market_view.n_books < 2) pen.single_book = R.penalty.single_book;
    if (capCodes.indexOf('QB_UNRESOLVED') >= 0 || pl.qb_unconfirmed) pen.qb_unresolved = R.penalty.qb_unresolved;
    if (isNum(pl.completeness) && pl.completeness < R.low_completeness) pen.low_completeness = R.penalty.low_completeness;
    var p = 0; Object.keys(pen).forEach(function (k) { p += pen[k]; });
    out.parts = {}; Object.keys(parts).forEach(function (k) { out.parts[k] = r(parts[k], 3); });
    out.factors = F; out.penalties = pen; out.base = r(base, 1); out.factor = r(f, 3);
    out.score = r(Math.max(0, base * f - p), 1);
    var priced = !!(o.price && isNum(o.price.american));
    if (!priced) out.reasons.push('no sportsbook price');
    if ((fresh !== 'FRESH' && fresh !== 'AGING') || (o.price && o.price.executable === false)) out.reasons.push('price not executable');
    if (!(isNum(o.ev) && o.ev > 0)) out.reasons.push('no positive EV');
    else if (!(isNum(o.edge_pp) && o.edge_pp >= T.lean.min_edge_pp)) out.reasons.push('edge below ' + T.lean.min_edge_pp + ' pp');
    if (!(isNum(o.confidence) && o.confidence >= P.CONFIG.caps.min_confidence)) out.reasons.push('confidence below ' + P.CONFIG.caps.min_confidence);
    if (['BET', 'LEAN', 'WATCH'].indexOf(decisionKey(o.decision)) < 0) out.reasons.push('decision ' + decisionKey(o.decision).replace('_', ' '));
    if (out.score < R.grade_min) out.reasons.push('score below ' + R.grade_min);
    out.grade = !out.reasons.length;
    return out;
  }

  /* ============================================================ GAME CONTEXT
     One object per event: what the game model and the market expect, and
     what surrounds the game, from the prop board's game row (the same row
     the projection read) and, when the page has one, the research state
     (lib/edgedesk_personal.js). A field neither carries is listed as not
     available rather than filled. */
  var CONTEXT_NOT_AVAILABLE = ['game-script probability', 'team pass-rate expectation', 'offensive / defensive efficiency ranks', 'OL status', 'coaching tendencies'];
  function isEdgeSource(s) { return /edgedesk/i.test(String(s || '')); }
  function gameContext(g, state, board) {
    if (!g && !state) return null;
    g = g || {}; state = state || null;
    var lg = leagueOf((board && board.league) || (state && state.sport));
    var m = g.market || {}, e = g.edgedesk || {};
    var mkt = isNum(m.home_margin) ? { home_margin: m.home_margin, total: num(m.total), home_implied: num(m.home_implied), away_implied: num(m.away_implied),
      source: m.source || null, is_market: !isEdgeSource(m.source), home_ml: num(m.home_ml), away_ml: num(m.away_ml) } : null;
    var edge = isNum(e.home_margin) ? { home_margin: r(e.home_margin, 2), total: num(e.total),
      home_points: isNum(e.total) ? r(e.total / 2 + e.home_margin / 2, 1) : null, away_points: isNum(e.total) ? r(e.total / 2 - e.home_margin / 2, 1) : null, source: e.source || null } : null;
    var o = {
      event_key: eventKey(lg, g.game_id || (state && state.game_id)), league: lg,
      home: g.home || null, away: g.away || null, home_name: g.home_name || (state && state.home) || null, away_name: g.away_name || (state && state.away) || null,
      kickoff: g.kickoff || (state && state.kickoff_at) || null, venue: g.venue || null, roof: g.roof || null, surface: g.surface || null,
      edgedesk: edge, market: mkt,
      gap: edge && mkt && mkt.is_market ? { margin_pts: r(edge.home_margin - mkt.home_margin, 2), total_pts: isNum(edge.total) && isNum(mkt.total) ? r(edge.total - mkt.total, 2) : null } : null,
      script: g.script || null, pace: g.pace || null, weather: g.weather || null, starters: g.starters || null,
      reliability: state && state.reliability && state.reliability.scored ? { score: state.reliability.score, grade: state.reliability.grade, tier: state.reliability.tier } : null,
      qb: state ? state.qb || null : null, injuries: state ? state.injuries || null : null,
      priority: state && state.priority ? { eligible: !!state.priority.eligible, score: state.priority.score, rank: state.priority.rank, why: state.priority.why_text } : null,
      not_available: CONTEXT_NOT_AVAILABLE.slice()
    };
    return o;
  }

  /* THE GAME MODEL BESIDE THE PROP MODEL. The projection's script is the
     market's (or, with no market, already EdgeDesk's). When EdgeDesk's game
     model disagrees with that script by the research threshold, this says
     how far the prop model's OWN script rule would move this player's team
     volume — a labelled sensitivity, never added to the projection. */
  var VOLUME_PASS = { pass_att: 1, pass_cmp: 1, pass_yds: 1, pass_rush_yds: 1, rec_yds: 1, receptions: 1, targets: 1 };
  var VOLUME_RUSH = { rush_att: 1, rush_yds: 1 };
  var SCORING = { anytime_td: 1, pass_tds: 1, rush_tds: 1, rec_tds: 1, tds_over: 1, first_td: 1, fg_made: 1, kicking_pts: 1 };
  function propGameLink(o, ctx, env, rule) {
    var out = { available: false, kind: null, direction: null, text: null };
    if (!o || o.type !== 'PLAYER_PROP' || !ctx || !o.player || !o.player.team) return out;
    if (!ctx.edgedesk) { out.text = 'No EdgeDesk game projection is on file for this game.'; return out; }
    var home = ctx.home === o.player.team, team = o.player.team, tn = (home ? ctx.home_name : ctx.away_name) || team;
    var eM = home ? ctx.edgedesk.home_margin : -ctx.edgedesk.home_margin;
    env = env || {};
    if (isEdgeSource(env.source)) {
      out.available = true; out.kind = 'IN_PROJECTION';
      out.text = 'The projection’s game script already comes from EdgeDesk’s game model (no sportsbook spread on file): ' + tn + ' ' + (eM >= 0 ? 'by ' + f1(eM) : 'as a ' + f1(-eM) + '-point underdog') + ', total ' + f1(ctx.edgedesk.total) + '. It is not counted twice.';
      return out;
    }
    var pM = num(env.margin), pT = num(env.total);
    if (pM == null) { out.text = 'The projection’s game script is not on file for this player.'; return out; }
    var dM = eM - pM, dT = isNum(ctx.edgedesk.total) && isNum(pT) ? ctx.edgedesk.total - pT : null, gapMin = RULES.research_gap_pts;
    out.available = true; out.edgedesk_margin = r(eM, 1); out.projection_margin = r(pM, 1); out.delta_margin = r(dM, 1); out.delta_total = r(dT, 1);
    if (Math.abs(dM) < gapMin && (dT == null || Math.abs(dT) < gapMin)) {
      out.kind = 'ALIGNED'; out.direction = 'NEUTRAL';
      out.text = 'EdgeDesk’s game model and the market script the projection uses agree within ' + gapMin + ' points (' + tn + ' ' + lineText(-eM) + ' vs ' + lineText(-pM) + ').';
      return out;
    }
    out.kind = 'SENSITIVITY';
    var plays = ctx.pace && isNum(ctx.pace[home ? 'home' : 'away']) ? ctx.pace[home ? 'home' : 'away'] : null;
    var rate = rule && isNum(rule.pass_rate_per_pt) ? rule.pass_rate_per_pt : null;
    var dDrop = plays != null && rate != null ? -rate * dM * plays : null;
    var dImp = dT != null ? (dT + dM) / 2 : dM / 2;
    var m = o.market.key, effect = null, what = null;
    /* a volume market moves with the script (dropbacks / designed runs), a
       scoring market with implied points; a volume market is never read off
       implied points (the two can point opposite ways), and without the
       model's rule on hand no size or direction is claimed */
    if (VOLUME_PASS[m]) { if (dDrop != null) { effect = dDrop; what = 'about ' + (dDrop >= 0 ? '+' : '−') + Math.abs(dDrop).toFixed(1) + ' dropbacks for ' + tn; } }
    else if (VOLUME_RUSH[m]) { if (dDrop != null) { effect = -dDrop; what = 'about ' + (-dDrop >= 0 ? '+' : '−') + Math.abs(dDrop).toFixed(1) + ' designed runs for ' + tn; } }
    else if (SCORING[m]) { effect = dImp; what = (dImp >= 0 ? '+' : '−') + Math.abs(dImp).toFixed(1) + ' implied points for ' + tn; }
    var scriptWords = dM < 0 ? 'EdgeDesk projects ' + tn + ' playing from behind more often than the market does' : 'EdgeDesk projects ' + tn + ' in a stronger game position than the market does';
    out.text = scriptWords + ' (EdgeDesk ' + lineText(-eM) + ', market ' + lineText(-pM) + (dT != null && Math.abs(dT) >= 0.5 ? '; total ' + f1(ctx.edgedesk.total) + ' vs ' + f1(pT) : '') + ').';
    if (effect != null && Math.abs(effect) >= 0.05) {
      var up = o.selection && o.selection.side === 'over';
      out.direction = (effect > 0) === up ? 'SUPPORTS' : 'CONFLICTS';
      out.effect = r(effect, 2);
      out.text += ' By the prop model’s own script rule that is ' + what + ' — it ' + (out.direction === 'SUPPORTS' ? 'supports' : 'cuts against') + ' the ' + (up ? 'over' : 'under') + '. A sensitivity only: the projection uses the market’s script.';
    } else out.direction = 'NEUTRAL';
    return out;
  }

  /* ============================================================= EXPLAIN
     WHY THIS PROP IS INTERESTING / CONCERNS — sentences from structured data
     only: the kernel's own explain() for the prop facts, the game link, the
     market's depth and the decision's caps. Nothing is written for a fact
     the data does not carry. */
  function explainProp(o, x) {
    x = x || {};
    var P = PR(), why = [], concerns = [];
    if (!o || o.type !== 'PLAYER_PROP') return { why: why, concerns: concerns };
    var side = o.selection ? o.selection.side : null, ev = x.ev, b = x.board, row = x.row;
    if (o.model && o.model.projection && o.selection && !o.market.yesno && isNum(o.selection.line)) {
      var pm = o.model.projection.mean, agrees = side === 'over' ? pm > o.selection.line : pm < o.selection.line;
      if (agrees) why.push('EdgeDesk projects ' + f1(pm) + ' (median ' + f1(o.model.projection.median) + ') against a ' + o.selection.line + ' line.');
    }
    if (isNum(o.model && o.model.probability) && isNum(o.break_even))
      why.push('Fair probability ' + probText(o.model.probability) + ' vs break-even ' + probText(o.break_even) + ' at ' + priceText(o.price && o.price.american) + '.');
    if (isNum(o.disagreement_toward_pp) && Math.abs(o.disagreement_toward_pp) >= 1)
      (o.disagreement_toward_pp > 0 ? why : concerns).push('EdgeDesk sits ' + ppText(o.disagreement_toward_pp) + ' from the no-vig market on the ' + (side || '') + ' at the consensus line.');
    var link = propGameLink(o, x.context, row && b ? (P.boardCtx(b, row) || {}).env : null, x.script_rule);
    if (link.available && link.text) {
      if (link.direction === 'SUPPORTS') why.push(link.text);
      else if (link.direction === 'CONFLICTS') concerns.push(link.text);
    }
    if (ev && b && row && side) {
      var f = P.boardFacts ? P.boardFacts(b, row, { line: o.selection.line, consensus_price: o.market_view ? (side === 'over' ? o.market_view.over : o.market_view.under) : null }) : null;
      if (f) {
        var k = P.explain(ev, f, side);
        (k.why || []).forEach(function (t) { if (!/^EdgeDesk projects/.test(t) && why.indexOf(t) < 0) why.push(t); });
        (k.risks || []).forEach(function (t) { if (concerns.indexOf(t) < 0) concerns.push(t); });
      }
    }
    var nb = o.price ? o.price.books_at_line : null;
    if (isNum(nb) && nb >= 1) (nb >= 3 ? why : concerns).push((nb === 1 ? 'Only 1 sportsbook posts ' : nb + ' sportsbooks post ') + (o.selection ? o.selection.text : 'this line') + '.');
    if (link.available && link.kind === 'IN_PROJECTION') why.push(link.text);
    (o.caps || []).forEach(function (c) { var code = c && c.code ? c.code : c, t = (c && c.text) || CODE_TEXT[code]; if (t && concerns.indexOf(t) < 0) concerns.push(t); });
    if (o.stage === 'EXPERIMENTAL') { var st = 'Market stage EXPERIMENTAL: it informs research and never carries units.'; if (concerns.indexOf(st) < 0) concerns.push(st); }
    if (o.stale) concerns.unshift(o.reason);
    concerns.push('Probability source: ' + (o.probability_label || 'MODEL-ESTIMATED (UNVALIDATED CALIBRATION)') + '.');
    return { why: why.slice(0, 6), concerns: concerns.slice(0, 6), game_link: link };
  }

  /* ========================================================= CAPTURE STATE
     Why a game has no priced props — told apart, never guessed:
       PRICED           at least one prop carries a captured price
       NOT_RELEASED     EdgeDesk asked, and no book has posted player markets
       NOT_CAPTURED_YET outside the capture window (or never polled): nobody
                        asked yet, so "not released" would be a guess
       CAPTURE_FAILED   the capture pipeline errored for this game / league
       CAPTURE_OFF      capture is not running for this league */
  var CAPTURE_TEXT = {
    PRICED: null,
    NOT_RELEASED: 'Sportsbooks have not released enough player markets for this game yet. EdgeDesk projections are available.',
    NOT_CAPTURED_YET: 'EdgeDesk has not asked the sportsbooks for this game’s player props yet (prices are captured inside {h} hours of kickoff). EdgeDesk projections are available.',
    CAPTURE_FAILED: 'The sportsbook capture pipeline encountered an error for this game, so player-prop pricing is unavailable. This is not the same as markets not being released.',
    CAPTURE_OFF: 'Sportsbook player-prop capture is not running for this league, so no prop is priced. EdgeDesk projections are available.'
  };
  function eventCaptureState(g, cap, capState, nPriced) {
    g = g || {}; cap = cap || {}; capState = capState || {};
    var h = num(cap.window_h != null ? cap.window_h : capState.window_h) || 96;
    function out(state) { return { state: state, text: CAPTURE_TEXT[state] ? CAPTURE_TEXT[state].replace('{h}', h) : null, status: cap.status || null, reason: cap.reason || null, window_h: h }; }
    if (nPriced > 0) return out('PRICED');
    var ev = g.event_id || null;
    var req = ev ? (capState.requests || []).filter(function (q) { return q.event_id === ev; })[0] : null;
    if (req && (req.error || (isNum(req.http) && req.http >= 400))) return out('CAPTURE_FAILED');
    if (cap.status === 'ERROR') return out('CAPTURE_FAILED');
    if (cap.status === 'NOT_RUN' || (!cap.status && !capState.last_run)) return out('CAPTURE_OFF');
    var polled = ev && capState.polled_at && capState.polled_at[ev];
    if (req && isNum(req.outcomes) && req.outcomes === 0) return out('NOT_RELEASED');
    if (polled) return out('NOT_RELEASED');
    return out('NOT_CAPTURED_YET');
  }

  /* ============================================================== SUMMARIES
     The per-event aggregation the Research page reads instead of the raw
     prop universe (football/props/<lg>/summary.json, written by
     football/props/build_summary.js right after the board). */
  function propsOfEvent(board, gid) { var id = String(gid); return (board.props || []).filter(function (x) { return String(x.g) === id; }); }
  function byResearch(a, b) {
    return ((b.research && b.research.grade ? 1 : 0) - (a.research && a.research.grade ? 1 : 0))
      || ((b.research ? b.research.score : 0) - (a.research ? a.research.score : 0))
      || ((RANK[b.decision] || 0) - (RANK[a.decision] || 0))
      || ((b.ev || -9) - (a.ev || -9))
      || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  }
  /* every priced, mapped prop of one event as an opportunity (cheap: reads
     the compact evaluation; no distribution is priced) */
  function eventOpportunities(board, gid, opts) {
    opts = opts || {};
    var out = [];
    propsOfEvent(board, gid).forEach(function (row) {
      if (!row.p || !row.q || !row.q.length) return;
      var e = (opts.evals && opts.evals[row.key || row.id || (board.league + '|' + row.g + '|' + row.p + '|' + row.m)]) || row.e;
      if (!e || !e.cand) return;
      out.push(fromPropRow(board, row, { compact: e, now: opts.now, game_state: opts.game_state, explain: false }));
    });
    return out.sort(byResearch);
  }
  function getTopEventProps(board, gid, n, opts) {
    opts = opts || {};
    var list = eventOpportunities(board, gid, opts).filter(function (o) { return o.research.grade; });
    return list.slice(0, n == null ? RULES.card_props : n);
  }
  function getEventPropSummary(board, gid, opts) {
    opts = opts || {};
    var P = PR(), g = P.boardGames(board)[String(gid)];
    if (!g) return null;
    var rows = propsOfEvent(board, gid), now = ms(opts.now) != null ? ms(opts.now) : Date.now();
    var opps = eventOpportunities(board, gid, opts);
    var counts = { BET: 0, LEAN: 0, WATCH: 0, PASS: 0, NO_DECISION: 0 };
    opps.forEach(function (o) { counts[o.decision] = (counts[o.decision] || 0) + 1; });
    var grade = opps.filter(function (o) { return o.research.grade; });
    var nPriced = rows.filter(function (x) { return x.q && x.q.length; }).length;
    var ctx = gameContext(g, opts.game_state, board);
    var top = grade.slice(0, opts.top == null ? RULES.summary_top : opts.top);
    /* the top candidates carry their full explanation: one kernel pass each */
    top = top.map(function (o) {
      var row = rows.filter(function (x) { return (x.key || x.id || (board.league + '|' + x.g + '|' + x.p + '|' + x.m)) === o.prop_id || (x.p === o.player.id && x.m === o.market.key); })[0];
      var ev = null; try { ev = row ? P.boardEval(board, row, ms(opts.evaluated_at) || now) : null; } catch (e) { ev = null; }
      var full = fromPropRow(board, row, { compact: (opts.evals && opts.evals[o.prop_id]) || row.e, now: now, ev: ev, context: ctx, game_state: opts.game_state, script_rule: opts.script_rule, evaluated_at: opts.evaluated_at });
      return full;
    });
    return {
      event_key: eventKey(board.league, gid), game_id: String(gid), league: leagueOf(board.league), provider_event_id: g.event_id || null,
      home: g.home, away: g.away, home_name: g.home_name || g.home, away_name: g.away_name || g.away, kickoff: g.kickoff, status: g.status,
      capture: eventCaptureState(g, board.capture, opts.capture_state, nPriced),
      total_props: rows.length, projected_props: rows.filter(function (x) { return x.p && x.x && x.x.dist; }).length, priced_props: nPriced,
      evaluated_props: opps.length, research_grade_count: grade.length,
      bet_count: counts.BET, lean_count: counts.LEAN, watch_count: counts.WATCH, pass_count: counts.PASS, no_decision_count: counts.NO_DECISION,
      top_score: grade.length ? grade[0].research.score : null,
      top_opportunities: top, more: Math.max(0, grade.length - top.length),
      game_context: ctx
    };
  }
  /* the whole league's summary file */
  function buildSummary(board, opts) {
    opts = opts || {};
    var P = PR(), at = ms(board.generated_at) || Date.now();
    var o = { now: opts.now != null ? opts.now : at, evaluated_at: board.generated_at, capture_state: opts.capture_state || null, script_rule: opts.script_rule || null };
    var events = {}, all = [];
    (board.games || []).forEach(function (g) {
      var s = getEventPropSummary(board, g.game_id, o);
      if (!s) return;
      /* stated once for the file, not per game */
      if (s.game_context) { delete s.game_context.not_available; ['reliability', 'qb', 'injuries', 'priority'].forEach(function (k) { if (s.game_context[k] == null) delete s.game_context[k]; }); }
      events[String(g.game_id)] = s;
      eventOpportunities(board, g.game_id, o).forEach(function (x) { if (x.research.grade) all.push(x); });
    });
    all.sort(byResearch);
    var tops = all.slice(0, RULES.league_top).map(function (x) {
      var s = events[x.event.game_id], hit = s ? s.top_opportunities.filter(function (y) { return y.key === x.key; })[0] : null;
      return hit || x;
    });
    var counts = { events: Object.keys(events).length, props: (board.props || []).length, priced: 0, evaluated: 0, research_grade: all.length, BET: 0, LEAN: 0, WATCH: 0, PASS: 0, NO_DECISION: 0 };
    Object.keys(events).forEach(function (k) { var s = events[k]; counts.priced += s.priced_props; counts.evaluated += s.evaluated_props; counts.BET += s.bet_count; counts.LEAN += s.lean_count; counts.WATCH += s.watch_count; counts.PASS += s.pass_count; counts.NO_DECISION += s.no_decision_count; });
    return {
      schema: SUMMARY_SCHEMA, engine: VERSION, rules: RULES.version, league: leagueOf(board.league), season: board.season,
      generated_at: board.generated_at, board_schema: board.schema, source: 'football/props/' + leagueOf(board.league) + '/board.json',
      probability: board.probability || null, market_weight: board.market_weight,
      capture: board.capture ? { status: board.capture.status, reason: board.capture.reason, why: board.capture.why, last_success_at: board.capture.last_success_at, last_run: board.capture.last_run, window_h: board.capture.window_h } : null,
      script_rule: opts.script_rule || null,
      research_rule: RULES.research,
      context_not_available: CONTEXT_NOT_AVAILABLE.slice(),
      correlation: board.correlation || null,
      counts: counts, top: tops, events: events
    };
  }
  /* read one event out of a published summary, re-judged NOW (a price that
     aged past the window since the build drops out of research grade) */
  function eventFromSummary(summary, gid, now, state) {
    if (!summary || !summary.events) return null;
    var s = summary.events[String(gid)];
    if (!s) return null;
    var o = reopenEvent(s, now, state);
    o.summary_generated_at = summary.generated_at;
    return o;
  }
  /* an event summary (or a research state's props block) re-judged at t */
  function reopenEvent(s, now, state) {
    if (!s) return null;
    var o = copy(s), t = ms(now) || Date.now();
    o.top_opportunities = (o.top_opportunities || []).map(function (x) { return reopen(x, t, state); });
    var live = o.top_opportunities.filter(function (x) { return x.research && x.research.grade; });
    o.research_grade_now = live.length ? live.length + (o.more || 0) : 0;
    o.top_score_now = live.length ? live[0].research.score : null;
    o.stale_now = o.top_opportunities.length > 0 && !live.length;
    return o;
  }
  /* the props block a research state carries (edgedesk_research_state/1
     .props): the event summary's counts, capture state and best candidates,
     small enough for game_research_state */
  function stateProps(ev) {
    if (!ev) return null;
    var slim = function (x) { var o = copy(x); if (o.explanation) { o.explanation = { why: (o.explanation.why || []).slice(0, 4), concerns: (o.explanation.concerns || []).slice(0, 3) }; } return o; };
    var sig = propSignal(ev);
    return { schema: 'edgedesk_state_props/1', event_key: ev.event_key, game_id: ev.game_id, league: ev.league,
      count: sig ? sig.count : 0, top_score: sig ? sig.top_score : null, text: sig ? sig.text || null : null,
      total_props: ev.total_props, priced_props: ev.priced_props, evaluated_props: ev.evaluated_props,
      bet_count: ev.bet_count, lean_count: ev.lean_count, watch_count: ev.watch_count,
      capture: ev.capture || null, more: ev.more || 0, empty_text: emptyText(ev), summary_generated_at: ev.summary_generated_at || null,
      top_opportunities: (ev.top_opportunities || []).filter(function (x) { return x.research && x.research.grade; }).slice(0, RULES.summary_top).map(slim) };
  }
  function reopen(x, t, state) {
    var o = copy(x);
    if (o.evaluated) { o.decision = o.evaluated.decision; o.decision_label = o.evaluated.decision_label; o.tone = o.evaluated.tone; o.code = o.evaluated.code; o.reason = o.evaluated.reason; delete o.evaluated; delete o.evaluated_decision; delete o.stale;
      o.blockers = (o.blockers || []).filter(function (b) { return b !== 'STALE_QUOTE' && b !== 'GAME_STARTED'; }); }
    refresh(o, t);
    var U = calculateOpportunityUnits(o); o.units = U.units;
    o.research = calculatePropResearchScore(o, { game_state: state || null });
    return o;
  }
  function topFromSummary(summary, n, now) {
    if (!summary) return [];
    var t = ms(now) || Date.now();
    return (summary.top || []).map(function (x) { return reopen(x, t); }).filter(function (x) { return x.research.grade; }).sort(byResearch).slice(0, n == null ? 5 : n);
  }

  /* ================================================ THE PROP SIGNAL (ORDER)
     What lib/research_priority.js reads on a game candidate: the QUALITY of
     the best research-grade prop (its research score), and how many there
     are — the count is shown, never scored, so a game with many props does
     not outrank one with a better single prop. */
  function propSignal(ev) {
    if (!ev) return null;
    var live = (ev.top_opportunities || []).filter(function (x) { return x.research && x.research.grade; });
    var count = live.length ? live.length + (ev.more || 0) : 0;
    if (!count) return { count: 0, top_score: null, evaluated: ev.evaluated_props || 0, priced: ev.priced_props || 0, capture: ev.capture ? ev.capture.state : null };
    var best = live[0];
    return { count: count, top_score: best.research.score, evaluated: ev.evaluated_props || 0, priced: ev.priced_props || 0, capture: ev.capture ? ev.capture.state : null,
      best: { player: best.player.name, selection: best.selection ? best.selection.text : null, market: best.market.label, ev: best.ev, confidence: best.confidence, decision: best.decision },
      text: count + ' player prop' + (count === 1 ? ' meets' : 's meet') + ' EdgeDesk’s research threshold; strongest: ' + best.player.name + ' ' + (best.selection ? best.selection.text : best.market.label) + ' (EV ' + pctText(best.ev) + ', confidence ' + (best.confidence == null ? '—' : best.confidence) + ').' };
  }
  /* how many props the engine evaluated: 0 is a count, not a missing field
     (only a summary built before evaluated_props existed reads the priced count) */
  function evaluatedCount(ev) { return !ev ? 0 : isNum(ev.evaluated_props) ? ev.evaluated_props : (ev.priced_props || 0); }
  /* priced, yet none evaluated: every quote was past the execution window when
     the summary was built, or its player had no projection to price */
  function pricedNotEvaluated(ev) { return !!ev && isNum(ev.evaluated_props) && ev.evaluated_props === 0 && (ev.priced_props || 0) > 0; }
  /* the one-line empty state for a game's props, by what actually happened */
  function emptyText(ev) {
    if (!ev) return 'No player props for this game are on the current board.';
    var c = ev.capture || {};
    if (c.state && c.state !== 'PRICED') return c.text;
    if (ev.stale_now) return 'The player-prop prices EdgeDesk evaluated for this game are past the ' + windowMinutes() + '-minute execution window. Nothing is ranked on an old price; the projections stand while the prices refresh.';
    if (pricedNotEvaluated(ev)) return 'None of the ' + ev.priced_props + ' priced props could be evaluated when the summary was built: a price past the ' + windowMinutes() + '-minute execution window, or a player without a projection, is not evaluated.';
    return evaluatedCount(ev) + ' props evaluated. No player props currently meet EdgeDesk’s research threshold. This is a valid result.';
  }

  /* ================================================================ THE CARD
     The Card holds two kinds of position in ONE bankroll:
       engine   EdgeDesk's live game decision (one per game), as today
       saved    an opportunity the reader added — a game market or a player
                prop — frozen at the moment it was added (price, line, book,
                probability, EV, decision, units). A later market move never
                rewrites it: the current state is read beside it. */
  function cardEntry(o, opts) {
    opts = opts || {};
    if (!o || !o.key) return null;
    var at = iso(opts.now) || new Date().toISOString();
    var snap = copy(o); delete snap.explanation;
    var e = {
      schema: ENTRY_SCHEMA, entry_id: 'ce_' + hash([o.key, o.id, at]), opportunity_id: o.id, key: o.key, type: o.type, sport: o.sport, league: o.league,
      event_key: o.event ? o.event.event_key : null, game_id: o.event ? o.event.game_id : null, kickoff: o.event ? o.event.kickoff : null,
      home: o.event ? (o.event.home_name || o.event.home) : null, away: o.event ? (o.event.away_name || o.event.away) : null,
      market: o.market ? o.market.key : null, market_label: o.market ? o.market.label : null, category: o.market ? o.market.category || null : null,
      player_id: o.player ? o.player.id : null, player_name: o.player ? o.player.name : null, team: o.player ? o.player.team : (o.selection ? o.selection.team || null : null),
      position: o.player ? o.player.position : null, prop_type: o.type === 'PLAYER_PROP' ? o.market.key : null,
      side: o.selection ? o.selection.side : null, line: o.selection ? o.selection.line : null, selection: o.selection ? o.selection.text : null,
      american: o.price ? o.price.american : null, book: o.price ? o.price.book : null, captured_at: o.price ? o.price.captured_at : null,
      probability: o.model ? o.model.probability : null, ev: o.ev, edge_pp: o.edge_pp, confidence: o.confidence,
      decision: o.decision, units: o.decision === 'BET' ? (o.units || 0) : 0, code: o.code, probability_source: o.probability_source, stage: o.stage || null,
      saved_at: at, evaluated_at: o.evaluated_at, snapshot: snap
    };
    return deepFreeze(e);
  }
  /* dedupe: one engine game decision per game and market; a saved game entry
     for the same game and market takes its row, with the engine's current
     decision read beside it */
  function positionKey(x) {
    if (x.type === 'PLAYER_PROP') return x.key;
    return 'game|' + (x.league || leagueOf(x.sport)) + '|' + x.game_id + '|' + (x.market || 'spread');
  }
  /* a position carries exactly the fields EDBankroll.exposure reads
     (decision, recommended_units, game_id, sport, kickoff, side — a team
     NAME for by_team —, market_type, tier, calibrated_ev_pct); side_key is
     the home / away orientation the correlation reads */
  function positionOfEntry(e, current) {
    var pos = { pos_key: positionKey(e), source: 'saved', type: e.type, sport: e.sport, league: e.league, game_id: e.game_id, event_key: e.event_key,
      kickoff: e.kickoff, home: e.home, away: e.away, decision: e.decision, recommended_units: e.decision === 'BET' ? e.units : 0,
      market_type: e.type === 'PLAYER_PROP' ? 'player_prop' : (e.market || 'spread'), category: e.category,
      side: e.type === 'PLAYER_PROP' ? null : (e.team || e.side), side_key: e.type === 'PLAYER_PROP' ? null : e.side,
      team: e.team, entry: e, current: current || null, tier: e.snapshot ? e.snapshot.tier : null,
      calibrated_ev_pct: isNum(e.ev) ? r(100 * e.ev, 2) : null };
    return pos;
  }
  function positionOfDecision(d) {
    var o = fromGameDecision(d);
    return { pos_key: positionKey({ type: 'GAME', league: o.league, game_id: o.event.game_id, market: o.market.key }), source: 'engine', type: 'GAME', sport: d.sport, league: o.league,
      game_id: String(d.game_id), event_key: o.event.event_key, kickoff: d.kickoff, home: d.home, away: d.away, decision: o.decision,
      recommended_units: o.decision === 'BET' ? (num(d.recommended_units) || 0) : 0, market_type: o.market.key, side: d.side || null, side_key: d.side_key || (o.selection ? o.selection.side : null),
      team: o.selection ? o.selection.team : null, tier: d.tier || d.strength || null, calibrated_ev_pct: d.calibrated_ev_pct, decision_obj: d, current: o, entry: null };
  }
  /* engine decisions (already filtered to pregame by the caller) and the
     reader's saved entries, one row per game market / prop */
  function cardPositions(decisions, entries, now) {
    var byKey = {}, order = [];
    (decisions || []).forEach(function (d, i) {
      if (!d) return;
      var p = positionOfDecision(d);
      if (byKey[p.pos_key]) p.pos_key += '#' + i;      /* two engine rows never merge */
      order.push(p.pos_key); byKey[p.pos_key] = p;
    });
    (entries || []).forEach(function (e) {
      if (!e) return;
      var k = positionKey(e), prev = byKey[k];
      var p = positionOfEntry(e, prev && prev.source === 'engine' ? prev.current : null);
      if (prev && prev.source === 'engine') p.decision_obj = prev.decision_obj;
      if (!prev) order.push(k);
      byKey[k] = p;
    });
    return order.map(function (k) { return byKey[k]; });
  }
  function isOpen(p, now) { var ko = ms(p.kickoff); return ko == null || ko > (ms(now) || Date.now()); }

  /* ---- filters: the existing ones plus type, market and prop category */
  var PROP_CATEGORY = { passing: 'PASSING', rushing: 'RUSHING', receiving: 'RECEIVING', touchdowns: 'TD', combined: 'COMBINED', other: 'OTHER' };
  var FILTERS = {
    all: function () { return true; },
    bets: function (p) { return p.decision === 'BET'; }, leans: function (p) { return p.decision === 'LEAN'; },
    watching: function (p) { return p.decision === 'WATCH'; }, pass: function (p) { return p.decision === 'PASS'; },
    none: function (p) { return p.decision === 'NO_DECISION'; },
    nfl: function (p) { return String(p.sport).toUpperCase() === 'NFL'; }, cfb: function (p) { return String(p.sport).toUpperCase() === 'CFB'; },
    games: function (p) { return p.type === 'GAME'; }, props: function (p) { return p.type === 'PLAYER_PROP'; },
    spread: function (p) { return p.type === 'GAME' && p.market_type === 'spread'; }, ml: function (p) { return p.type === 'GAME' && p.market_type === 'moneyline'; },
    total: function (p) { return p.type === 'GAME' && p.market_type === 'total'; },
    passing: function (p) { return p.type === 'PLAYER_PROP' && p.category === 'passing'; }, rushing: function (p) { return p.type === 'PLAYER_PROP' && p.category === 'rushing'; },
    receiving: function (p) { return p.type === 'PLAYER_PROP' && (p.category === 'receiving' || p.category === 'combined'); },
    td: function (p) { return p.type === 'PLAYER_PROP' && p.category === 'touchdowns'; }
  };
  [0.25, 0.5, 0.75, 1].forEach(function (u) { FILTERS['u' + Math.round(u * 100)] = function (p) { return p.decision === 'BET' && Math.abs((p.recommended_units || 0) - u) < 1e-9; }; });
  function passesFilter(p, f) { var fn = FILTERS[f] || FILTERS.all; return fn(p); }

  /* ---- same-game correlation. MEASURED: two props, the correlation model
     football/props/correlation.js fitted (signed by side). STRUCTURAL: a game
     market with a prop, by the prop model's own script rule — a direction,
     never a number. Otherwise the two only share the game environment. */
  function legOf(p) { var e = p.entry; return { g: p.game_id, p: e ? e.player_id : null, team: e ? e.team : null, pos: e ? e.position : null, m: e ? e.market : null, side: e ? e.side : null }; }
  function gameSideOf(p) {
    var e = p.entry, d = p.decision_obj, s = e ? e.side : (p.side_key || (d ? (d.side_key || (d.reference_quote && d.reference_quote.side)) : null));
    return { market: p.market_type, side: s, team: e ? e.team : (d ? d.side : null) };
  }
  function structural(gp, pp, homeTeam) {
    var m = pp.entry ? pp.entry.market : null, up = pp.entry && pp.entry.side === 'over';
    var gs = gameSideOf(gp), cat = pp.category;
    if (!m || !gs.side) return null;
    if (gs.market === 'total') {
      if (!(VOLUME_PASS[m] || VOLUME_RUSH[m] || SCORING[m] || cat === 'combined')) return null;
      var over = gs.side === 'over';
      return { kind: 'STRUCTURAL', same: over === up, text: 'Game ' + (over ? 'over' : 'under') + ' and ' + (up ? 'an over' : 'an under') + ' on a volume or scoring prop ' + (over === up ? 'move together' : 'offset') + '.' };
    }
    if (gs.market === 'spread' || gs.market === 'moneyline') {
      /* which team the game position is on, as the prop's team code or not */
      var gTeamIsHome = gs.side === 'home', propHome = pp.entry && homeTeam != null ? pp.entry.team === homeTeam : null;
      if (propHome == null) return null;
      var sameTeam = gTeamIsHome === propHome;
      var dir = null;
      if (VOLUME_RUSH[m]) dir = sameTeam ? 1 : -1;
      else if (VOLUME_PASS[m]) dir = sameTeam ? -1 : 1;
      else if (SCORING[m]) dir = sameTeam ? 1 : -1;
      if (dir == null) return null;
      var together = (dir > 0) === up;
      return { kind: 'STRUCTURAL', same: together, text: (sameTeam ? 'The same team’s ' : 'The opponent’s ') + (VOLUME_RUSH[m] ? 'rushing volume' : VOLUME_PASS[m] ? 'passing volume' : 'scoring') + (together ? ' rises' : ' falls') + ' with this game position’s script (the prop model’s script rule).' };
    }
    return null;
  }
  function correlation(positions, models, homeOf) {
    models = models || {};
    var byGame = {};
    (positions || []).forEach(function (p) { if (!p.event_key) return; (byGame[p.event_key] = byGame[p.event_key] || []).push(p); });
    var out = [];
    Object.keys(byGame).forEach(function (k) {
      var ps = byGame[k]; if (ps.length < 2) return;
      var model = models[ps[0].league] || null, pairs = [], P = PR();
      for (var i = 0; i < ps.length; i++) for (var j = i + 1; j < ps.length; j++) {
        var a = ps[i], b = ps[j], rel = null;
        if (a.type === 'PLAYER_PROP' && b.type === 'PLAYER_PROP') {
          var la = legOf(a), lb = legOf(b), rho = model ? P.selCorr(model, la, lb) : 0;
          rel = rho ? { kind: 'MEASURED', rho: r(rho, 2), same: rho > 0, text: 'Measured same-game correlation ρ ' + (rho > 0 ? '+' : '') + r(rho, 2) + ' (' + (rho > 0 ? 'they tend to win together' : 'they tend to offset') + ').' }
            : { kind: 'SHARED_GAME', same: null, text: 'No measured correlation for this pair; they share the game environment.' };
        } else if (a.type !== b.type) {
          var gp = a.type === 'GAME' ? a : b, pp = a.type === 'GAME' ? b : a;
          rel = structural(gp, pp, homeOf ? homeOf(k) : null) || { kind: 'SHARED_GAME', same: null, text: 'They share the game environment.' };
        } else {
          var sa = gameSideOf(a), sb = gameSideOf(b);
          rel = { kind: 'SAME_GAME', same: sa.market === sb.market ? sa.side === sb.side : null, text: sa.market === sb.market && sa.side !== sb.side ? 'Opposite sides of the same market offset each other.' : 'Two positions on the same game outcome.' };
        }
        pairs.push({ a: a.pos_key, b: b.pos_key, relation: rel });
      }
      var bets = ps.filter(function (p) { return p.decision === 'BET' && (p.recommended_units || 0) > 0; });
      var units = r(bets.reduce(function (s, p) { return s + (p.recommended_units || 0); }, 0), 2);
      var offset = pairs.some(function (x) { return x.relation.same === false; }), measured = pairs.filter(function (x) { return x.relation.kind === 'MEASURED'; }).length;
      var name = (ps[0].away && ps[0].home) ? ps[0].away + ' @ ' + ps[0].home : k;
      out.push({ event_key: k, matchup: name, n_positions: ps.length, n_bets: bets.length, units: units, pairs: pairs, offsetting: offset, measured_pairs: measured,
        text: (bets.length ? 'You have ' + unitsText(units) + ' tied to ' + name + ' across ' + bets.length + ' BET' + (bets.length === 1 ? '' : 's') + '. ' : name + ' carries ' + ps.length + ' positions on your Card. ')
          + 'These positions share game-script dependency' + (offset ? '; some offset each other' : '') + '. ' + unitsText(units) + ' is the gross exposure if they all move together. Research information about shared risk, not a forecast.' });
    });
    return out.sort(function (a, b) { return b.units - a.units || (a.event_key < b.event_key ? -1 : 1); });
  }

  /* ---- exposure: EDBankroll's, over games AND props, plus the type split
     and the same-game correlation. Nothing is reduced here: the reader's
     own limits hold a position only when the reader turned them on. */
  function cardExposure(positions, settings, opts) {
    opts = opts || {};
    var B = BANK(), now = opts.now;
    var open = (positions || []).filter(function (p) { return isOpen(p, now); });
    var ex = B ? B.exposure(open, settings, { tz_offset_minutes: opts.tz_offset_minutes }) : (function () {
      /* no EDBankroll (the edge function): the committed BETs, summed */
      var bs = open.filter(function (p) { return p.decision === 'BET' && (p.recommended_units || 0) > 0; });
      return { total_units: r(bs.reduce(function (a, p) { return a + p.recommended_units; }, 0), 2), total_dollars: null, n_bets: bs.length, correlation_notes: [], by_game: {}, unit: null };
    })();
    var bets = open.filter(function (p) { return p.decision === 'BET' && (p.recommended_units || 0) > 0; });
    var by = { GAME: 0, PLAYER_PROP: 0 };
    bets.forEach(function (p) { by[p.type] = r((by[p.type] || 0) + p.recommended_units, 2); });
    var unit = B ? B.unitValue(settings).unit : null;
    if (ex.n_bets == null) ex.n_bets = bets.length;
    ex.by_type = { GAME: { units: by.GAME, dollars: unit == null ? null : r(by.GAME * unit, 2) }, PLAYER_PROP: { units: by.PLAYER_PROP, dollars: unit == null ? null : r(by.PLAYER_PROP * unit, 2) } };
    /* the reader's saved positions and every staked BET — never the engine's
       PASS / NO DECISION rows every game carries */
    ex.correlated = correlation(open.filter(function (p) { return p.source === 'saved' || (p.decision === 'BET' && (p.recommended_units || 0) > 0); }), opts.models || {}, opts.homeOf);
    /* the bankroll's generic SAME_GAME note is replaced by the correlated
       exposure for a game this layer explains */
    var explained = {}; ex.correlated.forEach(function (c) { var s = splitKey(c.event_key); if (s) explained[s.game_id] = 1; });
    ex.correlation_notes = (ex.correlation_notes || []).filter(function (n) { return !(n.game_id != null && explained[String(n.game_id)] && (n.code === 'SAME_GAME' || n.code === 'OPPOSITE_SIDES_SAME_GAME')); });
    return ex;
  }
  function groupByGame(positions, now) {
    var g = {}, order = [];
    (positions || []).forEach(function (p) {
      var k = p.event_key || ('?|' + p.game_id);
      if (!g[k]) { g[k] = { event_key: k, matchup: (p.away && p.home) ? p.away + ' @ ' + p.home : k, sport: p.sport, kickoff: p.kickoff, game: [], props: [], units: 0 }; order.push(k); }
      (p.type === 'PLAYER_PROP' ? g[k].props : g[k].game).push(p);
      if (p.decision === 'BET' && isOpen(p, now)) g[k].units = r(g[k].units + (p.recommended_units || 0), 2);
    });
    return order.map(function (k) { return g[k]; }).sort(function (a, b) { return (ms(a.kickoff) || 9e15) - (ms(b.kickoff) || 9e15) || (a.event_key < b.event_key ? -1 : 1); });
  }

  /* ---- PRICE MOVED: the saved snapshot against the market now. The saved
     line, price and EV are never edited; the current EV is its own number. */
  function priceMove(entry, current, opts) {
    opts = opts || {};
    if (!entry || !current) return { comparable: false, text: current ? null : 'The current market for this position is not loaded.' };
    var P = PR(), out = { comparable: true, moved: false, material: false, saved: { line: entry.line, american: entry.american, book: entry.book, ev: entry.ev, decision: entry.decision, text: entry.selection ? entry.selection + ' ' + priceText(entry.american) : null } };
    var cur = null;
    if (entry.type === 'PLAYER_PROP') {
      /* current: the same side at the saved line, else the main line on the side (the kernel's ladder) */
      var ev = current.ladder ? current : null;
      if (ev) {
        var rungs = (ev.ladder || []).filter(function (x) { return x.side === entry.side; });
        /* the same line; else the nearest line on that side (an alternate is
           compared with an alternate, never with the main line far away) */
        var pick = rungs.slice().sort(function (a, b) { return Math.abs(a.line - entry.line) - Math.abs(b.line - entry.line) || (b.main ? 1 : 0) - (a.main ? 1 : 0); })[0] || null;
        if (pick) cur = { line: pick.line, american: pick.american, book: pick.book, ev: pick.ev, decision: ev.decision, text: propSelText(entry.market, entry.side, pick.line) + ' ' + priceText(pick.american) };
        if (ev._dist && ev._dist.informed && isNum(entry.line) && isNum(entry.american)) {
          var pr = P.probLine(ev._dist.informed, entry.line), pw = entry.side === 'over' ? pr.over : pr.under;
          out.ev_at_saved_price_now = r(P.expectedValue(pw, entry.american, pr.push), 4);
        }
        out.current_decision = ev.decision;
      } else if (current.selection && current.price) {
        cur = current.selection.side === entry.side ? { line: current.selection.line, american: current.price.american, book: current.price.book, ev: current.ev, decision: current.decision, text: current.selection.text + ' ' + priceText(current.price.american) } : null;
        out.current_decision = current.decision;
      }
    } else {
      var c = current;   /* a GAME opportunity (fromGameDecision) */
      if (c && c.selection && c.selection.side === entry.side) cur = { line: c.selection.line, american: c.price ? c.price.american : null, book: c.price ? c.price.book : null, ev: c.ev, decision: c.decision, text: c.selection.text + ' ' + priceText(c.price && c.price.american) };
      out.current_decision = c ? c.decision : null;
    }
    out.current = cur;
    if (!cur) { out.comparable = false; out.text = 'No current price on the saved side.'; return out; }
    var dLine = isNum(cur.line) && isNum(entry.line) ? r(cur.line - entry.line, 2) : null;
    var dc = P.toDecimal(cur.american), ds = P.toDecimal(entry.american), cents = dc != null && ds != null ? r((dc - ds) * 100, 1) : null;
    out.line_move = dLine; out.price_move_cents = cents;
    out.moved = (dLine != null && Math.abs(dLine) > 1e-9) || (cents != null && Math.abs(cents) > 1e-9) || (cur.book && entry.book && cur.book !== entry.book && (dLine || cents));
    out.material = (dLine != null && Math.abs(dLine) >= 0.5) || (cents != null && Math.abs(cents) >= (opts.cents || RULES.price_move_cents));
    out.current_ev = cur.ev;
    out.text = out.material ? 'PRICE MOVED · Saved ' + (out.saved.text || '—') + ' · Current ' + cur.text + (isNum(cur.ev) ? ' (EV now ' + pctText(cur.ev) + ')' : '') : (out.moved ? 'Minor price change since saved.' : 'Unchanged since saved.');
    return out;
  }

  /* ---- the record, kept apart by TYPE: a game market's accuracy and a
     prop's are different models and never one number */
  function gradePropEntry(entry, results) {
    if (!entry || entry.type !== 'PLAYER_PROP') return null;
    var P = PR(), res = (results || []).filter(function (x) { return String(x.game_id) === String(entry.game_id) && x.player_id === entry.player_id && x.market === entry.market && (x.result === 'VOID' || isNum(x.value)); })[0];
    if (!res) return null;
    var s = res.result === 'VOID' && !isNum(res.value) ? { result: 'VOID', reason: res.reason || null } : P.settle(entry.market, entry.line, entry.side, { played: true, value: res.value });
    var won = P.unitsWon ? P.unitsWon(s.result, entry.american, entry.units) : null;
    return { result: s.result, value: isNum(res.value) ? res.value : null, units_won: isNum(won) ? r(won, 3) : null, graded_at: res.graded_at || res.settled_at || null };
  }
  function summarize(rows) {
    var g = rows.filter(function (x) { return x.grade && (x.grade.result === 'WIN' || x.grade.result === 'LOSS' || x.grade.result === 'PUSH'); });
    var w = 0, l = 0, p = 0, risked = 0, won = 0, evs = [], clv = [];
    g.forEach(function (x) {
      if (x.grade.result === 'WIN') w++; else if (x.grade.result === 'LOSS') l++; else p++;
      var u = x.units || 0; risked += u; if (isNum(x.grade.units_won)) won += x.grade.units_won;
      if (isNum(x.ev)) evs.push(x.ev); if (x.grade && isNum(x.grade.clv)) clv.push(x.grade.clv);
    });
    var avg = function (a) { return a.length ? r(a.reduce(function (s, v) { return s + v; }, 0) / a.length, 4) : null; };
    return { n: g.length, wins: w, losses: l, pushes: p, units_risked: r(risked, 2), units_won: r(won, 2), roi: risked > 0 ? r(won / risked, 4) : null,
      avg_ev_at_decision: avg(evs), avg_clv: avg(clv), sample: g.length < 50 ? 'descriptive only (under 50 settled)' : 'sample' };
  }
  function recordSplit(entries) {
    var all = (entries || []).filter(Boolean);
    var by = function (f) { return summarize(all.filter(f)); };
    var out = { ALL: by(function () { return true; }), GAME: by(function (x) { return x.type === 'GAME'; }), PLAYER_PROP: by(function (x) { return x.type === 'PLAYER_PROP'; }), by_category: {}, by_sport: {} };
    all.forEach(function (x) { if (x.type === 'PLAYER_PROP' && x.category) out.by_category[x.category] = 1; if (x.sport) out.by_sport[x.sport] = 1; });
    Object.keys(out.by_category).forEach(function (c) { out.by_category[c] = by(function (x) { return x.type === 'PLAYER_PROP' && x.category === c; }); });
    Object.keys(out.by_sport).forEach(function (s) { out.by_sport[s] = { GAME: by(function (x) { return x.sport === s && x.type === 'GAME'; }), PLAYER_PROP: by(function (x) { return x.sport === s && x.type === 'PLAYER_PROP'; }) }; });
    out.note = 'Game markets and player props are separate models: their results are never pooled into one accuracy figure.';
    return out;
  }

  /* =============================================================== THE DESK
     Deterministic answers for the AI desk (supabase/functions/edgedesk_ai):
     every number is one the summary or the reader's Card carries. */
  function norm(s) { return String(s || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
  var MATCHUP_ASK = /\b(what|which|anything|where)\b.*\b(research|worth (looking|researching)|look at|investigate|study)\b|\bresearch\b.*\b(in|for|on)\b.*\b(vs\.?|versus|v\.?|@|at|and)\b/;
  var CARD_ASK = /\b(on|in) my card\b|\bmy card'?s\b|\bmy (card )?exposure\b|\bcard exposure\b|\bmy (saved|card) (bets|positions|opportunities|props)\b/;
  function classifyAsk(q, hasCard) {
    var s = norm(q);
    if (!s) return null;
    if (hasCard && CARD_ASK.test(s) && !/\b(build|make|create|give me|generate)\b/.test(s)) return 'CARD';
    if (MATCHUP_ASK.test(s)) return 'MATCHUP';
    return null;
  }
  /* find the event a question names, by the teams on each summary's own
     game rows (display names, codes and the last word of a name) */
  /* a team's names: the full name, the nickname (last word) and the place
     (the rest) — never a generic word on its own ("State", "Tech", "New") */
  var GENERIC = { state: 1, tech: 1, new: 1, city: 1, north: 1, south: 1, east: 1, west: 1, central: 1, southern: 1, northern: 1, eastern: 1, western: 1, university: 1, college: 1, international: 1, am: 1, the: 1, team: 1, game: 1, san: 1, los: 1, las: 1, st: 1 };
  function nameKeys(n) {
    var s = norm(n), w = s.split(' '), k = [s];
    if (w.length > 1) { k.push(w[w.length - 1]); k.push(w.slice(0, -1).join(' ')); }
    return k.filter(function (x) { return x && x.length >= 3 && !GENERIC[x]; });
  }
  function findEvent(summaries, q) {
    var s = ' ' + norm(q) + ' ', hits = [];
    Object.keys(summaries || {}).forEach(function (lg) {
      var S = summaries[lg]; if (!S || !S.events) return;
      Object.keys(S.events).forEach(function (gid) {
        var e = S.events[gid], sc = 0;
        [[e.home_name, e.home], [e.away_name, e.away]].forEach(function (t) {
          var ks = nameKeys(t[0]).concat(t[1] ? [norm(t[1])] : []), ok = ks.some(function (k) { return k.length >= 3 && s.indexOf(' ' + k + ' ') >= 0; });
          if (ok) sc++;
        });
        if (sc) hits.push({ league: lg, game_id: gid, score: sc, kick: ms(e.kickoff) || 9e15 });
      });
    });
    hits.sort(function (a, b) { return b.score - a.score || a.kick - b.kick; });
    if (!hits.length) return null;
    if (hits.length > 1 && hits[0].score === hits[1].score && hits[0].score < 2) return { ambiguous: hits.slice(0, 3) };
    return hits[0];
  }
  function matchupAnswer(summaries, q, opts) {
    opts = opts || {};
    var hit = findEvent(summaries, q), now = opts.now;
    if (!hit) return null;
    if (hit.ambiguous) {
      var names = hit.ambiguous.map(function (h) { var e = summaries[h.league].events[h.game_id]; return (e.away_name || e.away) + ' @ ' + (e.home_name || e.home); });
      return { intent: 'MATCHUP', ambiguous: true, text: 'That could be more than one game on EdgeDesk’s boards: ' + andList(names) + '. Name both teams and EdgeDesk will say what is worth researching.' };
    }
    var S = summaries[hit.league], ev = eventFromSummary(S, hit.game_id, now, opts.state || null), c = ev.game_context || {}, L = [];
    var name = (ev.away_name || ev.away) + ' @ ' + (ev.home_name || ev.home);
    L.push(name + ' (' + hit.league.toUpperCase() + ').');
    /* GAME */
    var st = opts.state, gtxt = null;
    if (st && st.priority && st.priority.eligible && st.priority.why_text) gtxt = st.priority.why_text + (st.gap && isNum(st.gap.points) ? ' EdgeDesk and the market are ' + st.gap.points.toFixed(1) + ' points apart on the spread.' : '');
    else if (c.gap && isNum(c.gap.margin_pts) && c.market && c.market.is_market) {
      var gp = Math.abs(c.gap.margin_pts);
      gtxt = gp >= RULES.research_gap_pts ? 'EdgeDesk disagrees with the spread by ' + gp.toFixed(1) + ' points (EdgeDesk ' + (c.home_name || c.home) + ' ' + lineText(-c.edgedesk.home_margin) + ', market ' + lineText(-c.market.home_margin) + ' — ' + (c.market.source || 'market') + ').'
        : 'EdgeDesk and the market agree on the spread within ' + RULES.research_gap_pts + ' points (' + gp.toFixed(1) + '): no game-market disagreement to research.';
    } else if (c.edgedesk && c.market && !c.market.is_market) gtxt = 'No sportsbook spread is on file for this game, so there is no model-market disagreement to measure. EdgeDesk has ' + (c.home_name || c.home) + ' ' + lineText(-c.edgedesk.home_margin) + '.';
    else gtxt = 'EdgeDesk has no game-market comparison on file for this game.';
    L.push('GAME — ' + gtxt);
    /* PLAYER PROPS */
    var live = (ev.top_opportunities || []).filter(function (x) { return x.research && x.research.grade; });
    if (!live.length) L.push('PLAYER PROPS — ' + emptyText(ev));
    else {
      var n = live.length + (ev.more || 0);
      L.push('PLAYER PROPS — ' + (n === 1 ? 'One player market meets' : n + ' player markets meet') + ' EdgeDesk’s research threshold (' + ev.evaluated_props + ' priced props evaluated):');
      live.slice(0, 3).forEach(function (o, i) {
        var ex = o.explanation || {};
        L.push((i + 1) + '. ' + o.player.name + ' ' + o.selection.text + ' ' + priceText(o.price.american) + ' at ' + o.price.book_name
          + ' — EdgeDesk ' + (o.market.yesno ? '' : 'projection ' + f1(o.model.projection && o.model.projection.mean) + ', ') + 'fair probability ' + probText(o.model.probability) + ' vs break-even ' + probText(o.break_even) + ', EV ' + pctText(o.ev) + ', confidence ' + (o.confidence == null ? '—' : o.confidence) + ', ' + o.decision_label + (o.decision === 'BET' && o.units ? ' ' + unitsText(o.units) : '') + '.'
          + (ex.why && ex.why.length > 2 ? ' Why: ' + ex.why.slice(2, 4).join(' ') : '') + (ex.concerns && ex.concerns.length ? ' Concern: ' + ex.concerns[0] : ''));
      });
    }
    L.push('Prices are the captured sportsbook quotes as of ' + (ev.summary_generated_at || 'the last build') + '; props are ' + (S.probability ? S.probability.label : 'MODEL-ESTIMATED (UNVALIDATED CALIBRATION)') + '. Research, not picks.');
    return { intent: 'MATCHUP', league: hit.league, game_id: hit.game_id, event_key: eventKey(hit.league, hit.game_id), text: L.join('\n'), event: ev };
  }
  /* the reader's Card, as the client sent it: saved entries + the engine's
     BETs, never a price the Card does not hold */
  function cardAnswer(card, opts) {
    opts = opts || {};
    var entries = (card && card.entries) || [], decisions = (card && card.decisions) || [];
    var pos = cardPositions(decisions, entries, opts.now);
    if (!pos.length) return { intent: 'CARD', text: 'Your EdgeDesk Card has no positions yet. Add a game market or a player prop from Research, a matchup or the Props page and it appears here with its price frozen at the moment you added it.' };
    var ex = cardExposure(pos, card.settings || null, { now: opts.now, models: opts.models || {} });
    var open = pos.filter(function (p) { return isOpen(p, opts.now); });
    var rank = function (p) { var e = p.entry ? p.entry : null, c = p.current; var ev = e ? e.ev : (c ? c.ev : null); return (RANK[p.decision] || 0) * 10 + (isNum(ev) ? ev : 0); };
    var top = open.filter(function (p) { return p.decision === 'BET' || p.decision === 'LEAN'; }).sort(function (a, b) { return rank(b) - rank(a); }).slice(0, 5);
    var L = ['Your Card: ' + ex.n_bets + ' BET' + (ex.n_bets === 1 ? '' : 's') + ', ' + unitsText(ex.total_units) + ' total exposure (games ' + unitsText(ex.by_type.GAME.units) + ', player props ' + unitsText(ex.by_type.PLAYER_PROP.units) + ').'];
    if (!top.length) L.push('No position on your Card is a BET or LEAN right now.');
    top.forEach(function (p, i) {
      var e = p.entry, c = p.current;
      var sel = e ? (e.type === 'PLAYER_PROP' ? e.player_name + ' ' + (e.selection || e.market_label) : e.selection) : (c && c.selection ? c.selection.text : '—');
      var price = e ? e.american : (c && c.price ? c.price.american : null), book = e ? e.book : (c && c.price ? c.price.book : null), ev = e ? e.ev : (c ? c.ev : null);
      L.push((i + 1) + '. ' + (p.type === 'PLAYER_PROP' ? 'PROP ' : 'GAME ') + sel + (isNum(price) ? ' ' + priceText(price) : '') + (book ? ' (' + book + ')' : '') + ' — ' + decisionWords(p.decision).label + (p.decision === 'BET' ? ' ' + unitsText(p.recommended_units) : '') + (isNum(ev) ? ', EV at decision ' + pctText(ev) : '') + (e ? ' (saved ' + String(e.saved_at).slice(0, 16).replace('T', ' ') + ' UTC)' : ' (EdgeDesk’s live decision)') + '.');
    });
    ex.correlated.slice(0, 2).forEach(function (c) { L.push('CORRELATED EXPOSURE — ' + c.text); });
    L.push('Saved prices are frozen at the time you added them; current prices are on the Card. Research, not picks.');
    return { intent: 'CARD', text: L.join('\n'), exposure: { total_units: ex.total_units, by_type: ex.by_type, n_bets: ex.n_bets } };
  }

  return {
    VERSION: VERSION, SCHEMA: SCHEMA, SUMMARY_SCHEMA: SUMMARY_SCHEMA, ENTRY_SCHEMA: ENTRY_SCHEMA, RULES: RULES, CAPTURE_TEXT: CAPTURE_TEXT, CODE_TEXT: CODE_TEXT,
    leagueOf: leagueOf, eventKey: eventKey, splitKey: splitKey, decisionKey: decisionKey, decisionWords: decisionWords,
    /* the shared services (docs/opportunity/DESIGN.md §3) */
    calculatePropEV: calculatePropEV, classifyPropDecision: classifyPropDecision, classifyBoardRow: classifyBoardRow,
    calculatePropResearchScore: calculatePropResearchScore, calculateOpportunityUnits: calculateOpportunityUnits,
    getEventPropSummary: getEventPropSummary, getTopEventProps: getTopEventProps,
    fromPropRow: fromPropRow, fromGameDecision: fromGameDecision, refresh: refresh, freshness: freshness, stageCap: stageCap, codeText: codeText,
    gameContext: gameContext, propGameLink: propGameLink, explainProp: explainProp, eventCaptureState: eventCaptureState,
    eventOpportunities: eventOpportunities, buildSummary: buildSummary, eventFromSummary: eventFromSummary, reopenEvent: reopenEvent, stateProps: stateProps, topFromSummary: topFromSummary,
    propSignal: propSignal, emptyText: emptyText, evaluatedCount: evaluatedCount, pricedNotEvaluated: pricedNotEvaluated, propSelText: propSelText,
    cardEntry: cardEntry, cardPositions: cardPositions, positionKey: positionKey, passesFilter: passesFilter, FILTERS: Object.keys(FILTERS),
    correlation: correlation, cardExposure: cardExposure, groupByGame: groupByGame, priceMove: priceMove, isOpen: isOpen,
    gradePropEntry: gradePropEntry, recordSplit: recordSplit,
    classifyAsk: classifyAsk, findEvent: findEvent, matchupAnswer: matchupAnswer, cardAnswer: cardAnswer,
    text: { line: lineText, price: priceText, pct: pctText, prob: probText, pp: ppText, units: unitsText, num: f1 }
  };
}));
/*__EDOPP_END__*/
