/* ===========================================================================
   EDGEDESK SIGNAL ENGINE — what changed in EdgeDesk's research, by how much,
   how sure we are of it, and why (or that we do not know why).
   docs/signal-center/METHODOLOGY.md

   Pure and deterministic. Every function here takes records EdgeDesk already
   stores (the game research history, the performance ledger, the published
   simulator runs, the availability reports, the model audits) and returns
   signal PAYLOADS. It reads no clock (the caller passes `now`), no network
   and no file. The same inputs give the same signals, the same keys and the
   same version hashes, byte for byte, so a re-run, a retry or a second worker
   can never create a duplicate.

   A SIGNAL is one material change in one comparable quantity:
     FORECAST_SHIFT            the same model, the same outcome, two snapshots
     MARKET_DIVERGENCE         the model and a named-book quote, same outcome
     MARKET_CONVERGENCE        a divergence that has since closed
     LINE_MOVEMENT             the same book's de-vigged price, two captures
     SIMULATION_SHIFT          two published simulator runs, same outcome
     INJURY_IMPACT             a source-dated availability designation
     MODEL_RELIABILITY_WARNING an audit finding, with its statistic and sample
     DATA_QUALITY_WARNING      a source that is stale, failed or incomplete
   Categories this engine cannot support honestly (ROSTER_MOVEMENT where no
   source is wired, MODEL_DISAGREEMENT, HISTORICAL_ANOMALY) are declared in
   lib/edgedesk_signal_registry.js as unavailable, never approximated.

   THE RULES THIS FILE KEEPS (docs/signal-center/METHODOLOGY.md §1)
     - no number is invented: a missing input gives no signal, with a reason;
     - two numbers are compared only when they answer the same question
       (same event, outcome, model identity, market definition);
     - a model-version change is labelled as one, never as sports news;
     - "why" is graded on an evidence ladder; a cause is CONFIRMED only when a
       controlled computation isolates it, and none of the sources wired today
       is one, so this engine never emits CONFIRMED_CAUSE on its own;
     - Monte Carlo error is sampling error only, and is labelled so;
     - the importance score ranks what to read first. It is not a
       probability, it is not validated against outcomes, and it says
       nothing about profit.

   Browser: window.EDSignalEngine. Node: require('./edgedesk_signal_engine.js').
   ES5, no dependencies beyond lib/edgedesk_calc.js (rounding, no-vig,
   canonical JSON and the fingerprint).
   =========================================================================== */
(function (root, factory) {
  var calc = (typeof module === 'object' && module.exports) ? require('./edgedesk_calc.js') : root.EDCalc;
  var api = factory(calc);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) root.EDSignalEngine = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (C) {
  'use strict';
  if (!C) throw new Error('edgedesk_signal_engine needs lib/edgedesk_calc.js loaded first');

  var E = { VERSION: 'edgedesk_signal_engine/1', SCHEMA: 'edgedesk_signal_v1' };

  /* ================================================================ helpers */
  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function ms(t) { if (t === null || t === undefined || t === '') return null; var x = typeof t === 'number' ? t : Date.parse(t); return isFinite(x) ? x : null; }
  function iso(t) { var x = ms(t); return x === null ? null : new Date(x).toISOString(); }
  function str(x) { return x === null || x === undefined ? '' : String(x); }
  function lc(x) { return str(x).toLowerCase(); }
  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
  function minutesBetween(a, b) { var A = ms(a), B = ms(b); return A === null || B === null ? null : (B - A) / 60000; }
  /* the true detection time: a replay evaluates at a past instant (ctx.now)
     but its findings were detected when the replay ran (ctx.detected_at) */
  function nowOf(ctx) { return (ctx && (ctx.detected_at || ctx.now)) || null; }
  /* a probability as a percentage at the display precision (one decimal) */
  function pct1(p) { return C.round(100 * p, 1); }
  /* a displayed change: the difference OF THE DISPLAYED values, in tenths
     (lib/edgedesk_calc.js policy 2), so a reader can reproduce it */
  function ppChange(prevP, curP) { return (Math.round(pct1(curP) * 10) - Math.round(pct1(prevP) * 10)) / 10 || 0; }
  function fmtPct(p) { return C.fmt.prob(p, 1); }
  /* a time a reader reads: Eastern, the way every EdgeDesk page prints it
     ("Oct 20, 2:08 PM ET"); machine timestamps stay ISO in values/timestamps */
  var ETF = null;
  try { ETF = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short' }); } catch (e) { ETF = null; }
  function when(t) {
    var x = ms(t);
    if (x === null) return 'an unknown time';
    if (!ETF || typeof ETF.formatToParts !== 'function') return new Date(x).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    var q = {}; ETF.formatToParts(new Date(x)).forEach(function (y) { q[y.type] = y.value; });
    return q.month + ' ' + q.day + ', ' + q.hour + ':' + q.minute + ' ' + String(q.dayPeriod || '').toUpperCase() + ' ' + (/^E[DS]T$/.test(q.timeZoneName) ? 'ET' : q.timeZoneName);
  }
  E.when = when;
  /* book and source names as a reader knows them */
  var BOOKS = { draftkings: 'DraftKings', fanduel: 'FanDuel', betmgm: 'BetMGM', caesars: 'Caesars', williamhillus: 'Caesars', espnbet: 'ESPN BET', fanatics: 'Fanatics', betrivers: 'BetRivers', pinnacle: 'Pinnacle', circasports: 'Circa Sports', bovada: 'Bovada' };
  var SOURCES = { espn_scoreboard: 'the ESPN scoreboard', espn: 'ESPN', cfbd: 'CollegeFootballData', odds_api: 'The Odds API' };
  E.bookName = function (b) { var k = lc(b).replace(/[^a-z]/g, ''); return BOOKS[k] || (b ? String(b) : null); };
  E.sourceName = function (s) { return SOURCES[s] || (s ? String(s).replace(/_/g, ' ') : null); };
  /* how unusual: "the largest of 41" rather than "larger than 100% of 41" */
  function rarityWords(r) {
    if (!r || r.value === null || r.value === undefined) return null;
    if (r.value >= 0.995) return 'the largest of ' + r.reference_n + ' earlier comparable moves';
    return 'larger than ' + Math.floor(r.value * 100) + '% of ' + r.reference_n + ' earlier comparable moves';
  }
  E.rarityWords = rarityWords;
  function fmtPP(x) { return C.fmt.pp(x); }
  function sortBy(a, f) { return a.slice().sort(function (x, y) { var p = f(x), q = f(y); return p < q ? -1 : (p > q ? 1 : 0); }); }
  E._ppChange = ppChange;

  /* Research, not picks: the words no signal, headline or graphic may carry.
     The same rule as supabase/personal_research.sql edp_copy_ok() and
     lib/edgedesk_game_graphic.js BANNED, plus the claims this product must
     never make (an edge, a guarantee, a lock, value). */
  E.BANNED = /(bet this|\blocks?\b|guarantee|\bsmash|must[- ]bet|can'?t lose|best bets?|winning plays?|free money|sure thing|\bedge\b|value play|\+ev\b|positive[- ]ev|profitable|hammer)/i;
  E.copyOk = function (s) { return s === null || s === undefined || !E.BANNED.test(String(s)); };

  /* ============================================================ vocabulary */
  E.CATEGORIES = {
    FORECAST_SHIFT: { label: 'Forecast Shift', kind: 'probability', notify_kind: 'fair_move' },
    MARKET_DIVERGENCE: { label: 'Market Divergence', kind: 'gap', notify_kind: 'diverge' },
    MARKET_CONVERGENCE: { label: 'Market Convergence', kind: 'gap', notify_kind: 'converge' },
    LINE_MOVEMENT: { label: 'Line Movement', kind: 'probability', notify_kind: 'market_move' },
    SIMULATION_SHIFT: { label: 'Simulation Shift', kind: 'probability', notify_kind: 'fair_move' },
    INJURY_IMPACT: { label: 'Injury Impact', kind: 'status', notify_kind: 'injury_change' },
    ROSTER_MOVEMENT: { label: 'Roster Movement', kind: 'status', notify_kind: 'injury_change' },
    MODEL_DISAGREEMENT: { label: 'Model Disagreement', kind: 'gap', notify_kind: 'diverge' },
    MODEL_RELIABILITY_WARNING: { label: 'Model Reliability Warning', kind: 'audit', notify_kind: 'reliability_change' },
    HISTORICAL_ANOMALY: { label: 'Historical Anomaly', kind: 'probability', notify_kind: 'fair_move' },
    DATA_QUALITY_WARNING: { label: 'Data Quality Warning', kind: 'source', notify_kind: 'reliability_change' }
  };

  /* The evidence ladder (METHODOLOGY.md §4). `rank` orders the feed's
     "highest evidence quality" sort; `weight` feeds the importance score. */
  E.EVIDENCE = {
    CONFIRMED_CAUSE: { rank: 4, weight: 1.0, label: 'Confirmed cause', means: 'A controlled computation changed one input and isolated its effect on this number.' },
    SUPPORTED_ASSOCIATION: { rank: 3, weight: 0.6, label: 'Supported association', means: 'A verified, source-dated event happened between the two snapshots. It is associated with the change; its share of the change has not been isolated.' },
    OBSERVED: { rank: 3, weight: 0.6, label: 'Observed', means: 'What is shown is on record, from named sources, at stated times. Nothing here establishes why.' },
    UNEXPLAINED: { rank: 1, weight: 0.25, label: 'Unexplained movement', means: 'The records do not establish why the number moved. EdgeDesk does not know yet.' },
    MODEL_VERSION_CHANGE: { rank: 0, weight: 0.1, label: 'Model version change', means: 'The model itself changed between the two snapshots. The movement reflects a methodology change, not new sports information.' }
  };

  E.VERIFICATION = {
    VERIFIED: 'Every number in this signal was re-read from its source record and every comparability check passed.',
    UNVERIFIED: 'At least one check failed. An unverified signal never appears in the verified feed.',
    INVALIDATED: 'A later evaluation could not reproduce this signal from its sources. It is withdrawn, and its history is kept.'
  };

  /* ===================================================== the scoring spec */
  E.SPEC = {
    /* v2 (2026-10-24): v1's components, weights and labels, plus the
       backfill rule below. A new id re-versions every stored signal once
       (E.materialUpdate: methodology), so a signal stored under v1 is
       re-scored by the rule its backfilled siblings follow */
    id: 'sc_importance_v2',
    adopted: '2026-10-24',
    scale: '0 to 100',
    claim: 'A transparent, rules-based ranking of what to read first. It is not a probability, it has not been validated against outcomes, and it says nothing about whether a bet would be profitable.',
    components: {
      magnitude: { weight: 0.35, rule: 'min(1, |change| / full_scale_pp) for the category (a full-scale move scores 1)' },
      rarity: { weight: 0.25, rule: 'the share of earlier comparable changes (same league, same category, recorded before this one) that were smaller; null and scored 0 when fewer than min_reference earlier changes exist' },
      evidence: { weight: 0.15, rule: 'the evidence class weight: confirmed cause 1, supported association / observed 0.6, unexplained 0.25, model version change 0.1' },
      freshness: { weight: 0.10, rule: '1 when the newest source record is inside 180 minutes of detection, falling linearly to 0 at 72 hours (lib/edgedesk_market_state.js windows)' },
      reliability: { weight: 0.10, rule: 'the model audit grade: VALIDATED 1, PARTIAL 0.6, EARLY 0.4, UNVALIDATED 0.25, EXPERIMENTAL 0.25, unknown 0' },
      relevance: { weight: 0.05, rule: '1 when the event starts inside 7 days of detection (or is a season outcome still open), 0.5 when later, 0 once it has started' }
    },
    penalties: {
      data_limited: { points: 10, rule: 'a source record is flagged LIMITED' },
      source_time_unknown: { points: 10, rule: 'a source carries no publication or capture time' },
      methodology_change: { points: 15, rule: 'the model version changed between the two records: the movement is methodology, not news' },
      small_reference: { points: 0, rule: 'rarity is unavailable: noted, scored 0 (no separate deduction)' }
    },
    labels: [
      { min: 70, label: 'Major' },
      { min: 50, label: 'Notable' },
      { min: 30, label: 'Routine' },
      { min: 0, label: 'Monitor' }
    ],
    thresholds: {
      /* game win probability, same model version, consecutive snapshots.
         Empirical basis (METHODOLOGY.md §3): 2026 non-zero same-version moves
         had a median of 2.0 pp (NFL) and 0.95 pp (CFB), 95th percentiles of
         7.5 pp and 11.2 pp. A 3.0 pp floor sits near the 70th percentile of
         NFL moves and the 80th of CFB's. */
      forecast_shift: { floor_pp: 3.0, full_scale_pp: 10, min_reference: 30 },
      /* model minus de-vigged moneyline. Empirical basis: on the 2026-10-23
         football board the median absolute gap was 4.2 pp (NFL) and 5.0 pp
         (CFB), the 90th percentile 9.5 and 10.7; an 8 pp floor flags the top
         fifth of a normal board, never half of it. */
      market_divergence: { floor_pp: 8.0, full_scale_pp: 20, quote_live_minutes: 180, model_max_age_minutes: 36 * 60, min_reference: 10 },
      market_convergence: { from_floor_pp: 8.0, to_pp: 4.0 },
      line_movement: { floor_pp: 4.0, full_scale_pp: 12, min_reference: 30, max_gap_hours: 30 },
      /* a published run against the run it replaced. |z| uses both runs'
         Monte Carlo standard errors (independent seeds: the simulator seeds
         from the input hash, simulator/src/cli/run.ts). z >= 4 keeps the
         chance of one sampling-noise signal across ~500 outcome tests per
         run near 3%; at 100,000 runs the 3 pp floor is far above noise. */
      simulation_shift: { floor_pp: 3.0, full_scale_pp: 15, min_z: 4, min_n_sims: 10000, min_reference: 30 },
      injury: { horizon_days: 7, positions_cfb: ['QB'] },
      reliability: { min_bucket_n: 20, min_gap_pp: 5.0, min_market_n: 20 },
      data_quality: { research_max_age_minutes: 180, ledger_max_age_minutes: 360 },
      relevance_days: 7
    },
    reliability_grades: { VALIDATED: 1, PARTIAL: 0.6, EARLY: 0.4, UNVALIDATED: 0.25, EXPERIMENTAL: 0.25 },
    /* found after the fact: scored at its own record's time, never re-scored
       as stale for having been found late, and marked "found in the ledger
       later" (it was never shown at the time) */
    backfill: { after_minutes: 180, rule: 'a change found more than 180 minutes after its source record is scored as of that record (freshness and relevance at that moment) and marked as found in the ledger later; its detection time is still the true one' }
  };

  /* ================================================================ identity */
  /* signal_key: what the signal IS (category, subject, outcome and the exact
     records compared). The same comparison always gets the same key. */
  E.signalKey = function (identity) { return 'sc1-' + C.fingerprint(identity); };
  /* version_hash: everything a reader is shown, minus what depends only on
     WHEN it was evaluated: the run, the detection time, the score (its
     freshness and relevance decay with the clock), the relevance text and
     the ages. An unchanged re-evaluation hashes equal, an hour later too. */
  /* backfilled and scored_as_of depend on when a change was first found:
     the database keeps the first answer (sc_signals.backfilled, signal_at) */
  var VOLATILE = { detected_at: 1, run_id: 1, fixture_note: 1, score: 1, relevance: 1, quote_age_minutes: 1, model_age_minutes: 1, age_minutes: 1, version_hash: 1, backfilled: 1, scored_as_of: 1 };
  function stripVolatile(v) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(stripVolatile);
    var o = {};
    Object.keys(v).forEach(function (k) { if (!VOLATILE[k] && v[k] !== undefined) o[k] = stripVolatile(v[k]); });
    return o;
  }
  E.versionHash = function (payload) { return 'sv1-' + C.fingerprint(stripVolatile(payload)); };

  /* ================================================================ scoring */
  function labelFor(total) {
    for (var i = 0; i < E.SPEC.labels.length; i++) if (total >= E.SPEC.labels[i].min) return E.SPEC.labels[i].label;
    return 'Monitor';
  }
  E.labelFor = labelFor;
  /* rarity: the share of earlier comparable changes that were smaller.
     `reference` is a sorted ascending array of earlier absolute changes. */
  E.rarity = function (absChange, reference, minRef) {
    if (!reference || reference.length < (minRef || 30)) return { value: null, reference_n: reference ? reference.length : 0, note: 'fewer than ' + (minRef || 30) + ' earlier comparable changes: rarity not scored' };
    var lo = 0, hi = reference.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (reference[mid] < absChange) lo = mid + 1; else hi = mid; }
    return { value: C.round(lo / reference.length, 3), reference_n: reference.length, note: null };
  };
  function freshnessOf(sourceAt, detectedAt) {
    var m = minutesBetween(sourceAt, detectedAt);
    if (m === null) return null;
    if (m <= 180) return 1;
    if (m >= 72 * 60) return 0;
    return C.round(1 - (m - 180) / (72 * 60 - 180), 3);
  }
  function relevanceOf(eventAt, detectedAt, open) {
    if (open) return 1;
    var m = minutesBetween(detectedAt, eventAt);
    if (m === null) return null;
    if (m <= 0) return 0;
    return m <= E.SPEC.thresholds.relevance_days * 1440 ? 1 : 0.5;
  }
  /* score(x): x = { abs_change_pp, full_scale_pp, rarity, evidence_class,
     source_at, detected_at, reliability_grade, event_at, season_open,
     flags: [...] } -> the stored score object, every component explained */
  E.score = function (x) {
    var S = E.SPEC.components, comps = [], penalties = [];
    function add(id, value, note) {
      var w = S[id].weight, v = value === null || value === undefined ? null : C.round(clamp01(value), 3);
      comps.push({ id: id, value: v, weight: w, points: v === null ? 0 : C.round(100 * w * v, 1), rule: S[id].rule, note: note || null });
    }
    add('magnitude', isNum(x.abs_change_pp) && x.full_scale_pp ? x.abs_change_pp / x.full_scale_pp : null);
    add('rarity', x.rarity ? x.rarity.value : null, x.rarity ? x.rarity.note : 'no reference distribution');
    var ev = E.EVIDENCE[x.evidence_class];
    add('evidence', ev ? ev.weight : null, ev ? ev.label : 'evidence class missing');
    var fr = freshnessOf(x.source_at, x.detected_at);
    add('freshness', fr, fr === null ? 'source time unknown' : null);
    var rg = E.SPEC.reliability_grades[x.reliability_grade];
    add('reliability', rg === undefined ? null : rg, x.reliability_grade ? 'model audit grade ' + x.reliability_grade : 'no model audit on file');
    add('relevance', relevanceOf(x.event_at, x.detected_at, x.season_open), null);
    (x.flags || []).forEach(function (f) {
      if (f === 'DATA_LIMITED') penalties.push({ id: 'data_limited', points: E.SPEC.penalties.data_limited.points, rule: E.SPEC.penalties.data_limited.rule });
      if (f === 'SOURCE_TIME_UNKNOWN') penalties.push({ id: 'source_time_unknown', points: E.SPEC.penalties.source_time_unknown.points, rule: E.SPEC.penalties.source_time_unknown.rule });
      if (f === 'MODEL_VERSION_CHANGE') penalties.push({ id: 'methodology_change', points: E.SPEC.penalties.methodology_change.points, rule: E.SPEC.penalties.methodology_change.rule });
    });
    var total = comps.reduce(function (s, c) { return s + c.points; }, 0) - penalties.reduce(function (s, p) { return s + p.points; }, 0);
    total = C.round(Math.max(0, Math.min(100, total)), 1);
    var missing = comps.filter(function (c) { return c.value === null; }).map(function (c) { return c.id; });
    return {
      spec: E.SPEC.id, total: total, label: labelFor(total), components: comps, penalties: penalties, missing: missing,
      explanation: 'Score ' + total + ' of 100 (' + labelFor(total) + '): ' + comps.filter(function (c) { return c.points > 0; }).map(function (c) { return c.id + ' ' + c.points; }).join(', ')
        + (penalties.length ? '; minus ' + penalties.map(function (p) { return p.id + ' ' + p.points; }).join(', ') : '')
        + (missing.length ? '. Not scored (no input): ' + missing.join(', ') + '.' : '.'),
      claim: E.SPEC.claim
    };
  };

  /* ============================================================ verification */
  function verification(checks) {
    var failed = checks.filter(function (c) { return !c.ok; });
    return { state: failed.length ? 'UNVERIFIED' : 'VERIFIED', checks: checks, failed: failed.map(function (c) { return c.id; }), means: E.VERIFICATION[failed.length ? 'UNVERIFIED' : 'VERIFIED'] };
  }
  function check(id, ok, detail) { return { id: id, ok: !!ok, detail: detail || null }; }
  function probOk(p) { return isNum(p) && p > 0 && p < 1; }
  E.verification = verification;

  /* ================================================================ payload */
  /* finish(): the one place a payload is assembled, scored, keyed and copy-
     checked. A payload that breaks the copy rule is refused, not softened. */
  /* the free preview's words: what happened, with no paid number in it
     (win probabilities, simulator probabilities and market prices are Full
     Access research; facts from public reports and public audits are not) */
  E.publicHeadline = function (p) {
    var team = p.subject && p.subject.label, lg = String(p.league || p.sport || '').toUpperCase();
    switch (p.category) {
      case 'FORECAST_SHIFT': return p.subtype === 'model_version_change' ? team + ': forecast changed with a model update' : 'EdgeDesk’s ' + lg + ' forecast moved toward ' + team;
      case 'MARKET_DIVERGENCE': return 'EdgeDesk and ' + ((p.market && p.market.book) || 'the market') + ' disagree on ' + team;
      case 'MARKET_CONVERGENCE': return 'EdgeDesk and ' + ((p.market && p.market.book) || 'the market') + ' have converged on ' + team;
      case 'LINE_MOVEMENT': return ((p.market && p.market.book) || 'The market') + ' moved toward ' + team;
      case 'SIMULATION_SHIFT': return team + ': ' + (p.outcome && p.outcome.label ? p.outcome.label.replace(team + ' ', '') : 'season') + ' outlook ' + (p.values && p.values.change_pp > 0 ? 'rose' : 'fell') + ' in the Simulator';
      default: return p.headline;
    }
  };
  function finish(p, scoreInput, ctx) {
    p.schema = E.SCHEMA;
    p.public_headline = E.publicHeadline(p);
    p.public_summary = p.evidence ? p.evidence.label + ': ' + p.evidence.means : null;
    p.engine_version = E.VERSION;
    p.spec_version = E.SPEC.id;
    /* point in time (E.SPEC.backfill): a change found more than
       after_minutes after its source record is a backfill. It is scored as of
       that record, which is what the hourly evaluation would have scored when
       the record appeared, and it says it was found later. detected_at stays
       the true detection time (a replay evaluates at a past instant but was
       detected now: ctx.detected_at). */
    var detected = nowOf(ctx);
    var lag = minutesBetween(scoreInput.source_at, detected);
    var late = lag !== null && lag > E.SPEC.backfill.after_minutes;
    var asOf = late ? scoreInput.source_at : detected;
    p.detected_at = iso(detected);
    if (p.timestamps) { p.timestamps.detected_at = iso(detected); p.timestamps.scored_as_of = iso(asOf); }
    p.backfilled = late;
    p.score = E.score(Object.assign({ detected_at: asOf }, scoreInput));
    p.signal_key = E.signalKey(p.identity);
    if (ctx.fixture) p.fixture = true;
    p.version_hash = E.versionHash(p);
    var words = [p.headline, p.public_headline, p.summary, p.relevance, p.evidence && p.evidence.summary].concat((p.evidence && p.evidence.items || []).map(function (i) { return i.text; }));
    var bad = words.filter(function (w) { return !E.copyOk(w); });
    if (bad.length) throw new Error('signal copy breaks the research-not-picks rule: ' + JSON.stringify(bad[0]));
    return p;
  }
  E._finish = finish;

  /* ================================================== forecast shifts (games)
     series: one game's snapshots, any order:
       { snapshot_id, at (recorded), built_at, p_home, model_id, model_version,
         data_status ('OK'|'LIMITED'|'UNAVAILABLE'), inputs: {...} }
     game: { sport, league, season, event_key, event_at, home:{name,abbr},
             away:{name,abbr}, research_href, source:{id,label,ref} }
     ctx:  { now, reference: {<league>: sorted earlier |Δ| list} (optional),
             reliability: {<model_version>: grade}, fixture }
     Returns { signals, moves } where moves are every same-version non-zero
     consecutive change (the distribution the next run's rarity reads). */
  E.forecastShifts = function (series, game, ctx) {
    ctx = ctx || {};
    var T = E.SPEC.thresholds.forecast_shift;
    var rows = sortBy((series || []).filter(function (r) { return r && ms(r.at) !== null; }), function (r) { return ms(r.at); });
    var signals = [], moves = [], first = null;
    var refAll = (ctx.reference && ctx.reference[game.league]) || null;
    for (var i = 0; i < rows.length; i++) {
      var c = rows[i];
      if (c.data_status === 'UNAVAILABLE' || !probOk(c.p_home)) continue;
      if (!first) first = c;
      /* the previous comparable snapshot: the latest earlier one with a number */
      var p = null;
      for (var j = i - 1; j >= 0; j--) { if (rows[j].data_status !== 'UNAVAILABLE' && probOk(rows[j].p_home)) { p = rows[j]; break; } }
      if (!p) continue;
      var sameModel = p.model_version === c.model_version && p.model_id === c.model_id;
      var d = ppChange(p.p_home, c.p_home), ad = Math.abs(d);
      if (sameModel && ad > 0) moves.push({ league: game.league, at: c.at, abs_pp: ad });
      if (ad < T.floor_pp) continue;
      /* the rarity reference is point-in-time: only moves recorded before this one */
      var ref = refAll ? refAll.filter(function (m) { return ms(m.at) < ms(c.at); }).map(function (m) { return m.abs_pp; }).sort(function (a, b) { return a - b; }) : null;
      signals.push(forecastShiftSignal(p, c, first, game, ctx, sameModel, ref));
    }
    return { signals: signals, moves: moves };
  };

  function inputChanges(p, c) {
    var out = [], a = p.inputs || {}, b = c.inputs || {};
    function diff(field, label, fa, fb, verified) {
      if (str(fa) !== str(fb)) out.push({ field: field, label: label, from: fa === undefined ? null : fa, to: fb === undefined ? null : fb, verified: !!verified });
    }
    diff('home_record', 'home record', a.home_record, b.home_record, true);
    diff('away_record', 'away record', a.away_record, b.away_record, true);
    diff('home_rank', 'home poll rank', a.home_rank, b.home_rank, true);
    diff('away_rank', 'away poll rank', a.away_rank, b.away_rank, true);
    diff('home_overall_rank', 'home efficiency rank', a.home_overall_rank, b.home_overall_rank, false);
    diff('away_overall_rank', 'away efficiency rank', a.away_overall_rank, b.away_overall_rank, false);
    diff('kickoff', 'kickoff time', a.kickoff, b.kickoff, true);
    diff('venue', 'venue', a.venue, b.venue, true);
    diff('availability', 'availability inputs', a.availability, b.availability, true);
    diff('built_at', 'model run', a.built_at, b.built_at, false);
    diff('fair_home_line', 'fair spread (home)', a.fair_home_line, b.fair_home_line, false);
    diff('total', 'fair total', a.total, b.total, false);
    return out;
  }
  E._inputChanges = inputChanges;

  function forecastShiftSignal(p, c, first, game, ctx, sameModel, ref) {
    var T = E.SPEC.thresholds.forecast_shift;
    var dHome = ppChange(p.p_home, c.p_home);
    /* the subject is the team the movement favours, so the change reads as a
       rise; the payload keeps both sides */
    var side = dHome > 0 ? 'home' : 'away';
    var team = game[side];
    var prevP = side === 'home' ? p.p_home : 1 - p.p_home, curP = side === 'home' ? c.p_home : 1 - c.p_home;
    var change = ppChange(prevP, curP);
    var changes = inputChanges(p, c);
    var verifiedEvents = changes.filter(function (x) { return x.verified && x.field !== 'kickoff' && x.field !== 'venue'; });
    var cls, summary, items = [];
    if (!sameModel) {
      cls = 'MODEL_VERSION_CHANGE';
      summary = 'The model changed between these snapshots (' + (p.model_version || '?') + ' to ' + (c.model_version || '?') + '). The movement reflects the new methodology, not new information about the game.';
    } else if (verifiedEvents.length) {
      cls = 'SUPPORTED_ASSOCIATION';
      summary = 'Between the two snapshots ' + verifiedEvents.map(function (x) { return 'the ' + x.label + ' changed from ' + (x.from === null ? 'none' : x.from) + ' to ' + (x.to === null ? 'none' : x.to); }).join('; ')
        + '. These are source-dated facts recorded with the snapshot. How much of the ' + fmtPP(change) + ' change each one explains has not been isolated.';
    } else {
      cls = 'UNEXPLAINED';
      summary = 'The model was re-run' + (p.inputs && c.inputs && p.inputs.built_at !== c.inputs.built_at ? ' (' + when(p.inputs.built_at) + ' and ' + when(c.inputs.built_at) + ')' : '')
        + ' and the probability moved, but the snapshots do not record which input changed. EdgeDesk does not know yet why this number moved.';
    }
    /* a time reads as a time (Eastern); the machine value stays in input_changes */
    var shown = function (x, v) { return v === null ? 'none' : ((x.field === 'built_at' || x.field === 'kickoff') && ms(v) !== null ? when(v) : v); };
    changes.forEach(function (x) { items.push({ kind: x.verified ? 'event' : 'model_input', text: x.label + ': ' + shown(x, x.from) + ' to ' + shown(x, x.to), verified: x.verified, at: c.at, source: game.source && game.source.label }); });
    var checks = [
      check('same_event', true, game.event_key),
      check('same_outcome', true, 'win probability, ' + (game.settles || 'as the model defines it')),
      check('probabilities_in_range', probOk(p.p_home) && probOk(c.p_home), [p.p_home, c.p_home]),
      check('ordered_in_time', ms(p.at) < ms(c.at), [p.at, c.at]),
      check('pregame', game.event_at ? ms(c.at) < ms(game.event_at) : true, [c.at, game.event_at]),
      check('model_identity_recorded', !!(c.model_version && p.model_version), [p.model_version, c.model_version]),
      check('distinct_snapshots', p.snapshot_id !== c.snapshot_id, [p.snapshot_id, c.snapshot_id]),
      check('source_consistent', c.consistent !== false && p.consistent !== false, 'summary probability equals the snapshot spec')
    ];
    var flags = [];
    if (p.data_status === 'LIMITED' || c.data_status === 'LIMITED') flags.push('DATA_LIMITED');
    if (!sameModel) flags.push('MODEL_VERSION_CHANGE');
    /* a move across a version change is not comparable with same-version
       moves: it gets no rarity at all */
    var rarity = sameModel ? E.rarity(Math.abs(change), ref, T.min_reference) : { value: null, reference_n: 0, note: 'not compared: the model version changed' };
    var cum = first && first.snapshot_id !== c.snapshot_id && first.model_version === c.model_version
      ? { since: first.at, snapshot_id: first.snapshot_id, from_pct: pct1(side === 'home' ? first.p_home : 1 - first.p_home), change_pp: ppChange(side === 'home' ? first.p_home : 1 - first.p_home, curP) } : null;
    var payload = {
      category: 'FORECAST_SHIFT', subtype: sameModel ? 'same_model' : 'model_version_change',
      sport: game.sport, league: game.league, season: game.season,
      event_kind: 'game',
      subject: { kind: 'team', key: game.sport + ':' + lc(team.abbr || team.name), label: team.name, side: side },
      event: { key: game.event_key, label: game.away.name + ' at ' + game.home.name, at: iso(game.event_at), home: game.home, away: game.away, neutral: !!game.neutral },
      teams: [lc(game.home.name), lc(game.away.name), lc(game.home.abbr), lc(game.away.abbr)].filter(Boolean),
      market_type: 'moneyline',
      outcome: { id: side + '_win', label: team.name + ' win', definition: game.settles || 'game winner as the model defines it' },
      identity: { c: 'FORECAST_SHIFT', e: game.event_key, o: 'win', m: c.model_id || null, prev: p.snapshot_id, cur: c.snapshot_id },
      headline: (sameModel ? team.name + ' win probability up ' + fmtPP(change).replace(/^\+/, '') + ' to ' + fmtPct(curP) : team.name + ': ' + fmtPP(change) + ' after a model version change'),
      values: {
        unit: 'probability',
        previous: { value: C.round(prevP, 4), display: fmtPct(prevP), at: iso(p.at), snapshot_id: p.snapshot_id, model_version: p.model_version, built_at: iso(p.built_at) },
        current: { value: C.round(curP, 4), display: fmtPct(curP), at: iso(c.at), snapshot_id: c.snapshot_id, model_version: c.model_version, built_at: iso(c.built_at) },
        change_pp: change, change_display: fmtPP(change),
        relative_change: C.round((curP - prevP) / prevP, 4),
        interval_hours: C.round(minutesBetween(p.at, c.at) / 60, 2),
        home_change_pp: dHome,
        cumulative: cum,
        distribution: { reference_n: rarity.reference_n, rarity: rarity.value, basis: 'non-zero same-version consecutive moves, ' + game.league.toUpperCase() + ', recorded before this snapshot', note: rarity.note }
      },
      model: { id: c.model_id || null, version: c.model_version || null, previous_version: p.model_version || null, built_at: iso(c.built_at), status: ctx.model_status ? ctx.model_status[c.model_version] || null : null },
      timestamps: { event_at: iso(game.event_at), source_published_at: iso(c.at), calculated_at: iso(c.built_at), recorded_at: iso(c.at), detected_at: iso(ctx.now) },
      evidence: { class: cls, label: E.EVIDENCE[cls].label, means: E.EVIDENCE[cls].means, summary: summary, items: items, input_changes: changes,
        attribution: 'No controlled re-run is available for this model: a cause is never marked confirmed.' },
      verification: verification(checks),
      quality: { flags: flags, data_status: [p.data_status || null, c.data_status || null] },
      reliability: { grade: ctx.reliability ? ctx.reliability[c.model_version] || null : null },
      sources: [{ id: game.source && game.source.id, label: game.source && game.source.label, ref: game.source && game.source.ref, records: [p.snapshot_id, c.snapshot_id] }],
      links: { research: game.research_href || null, simulator: game.simulator_href || null },
      relevance: relevanceText(game, nowOf(ctx), Math.abs(change), rarity),
      summary: 'EdgeDesk’s ' + game.league.toUpperCase() + ' model moved ' + fmtPP(change) + ' toward ' + team.name + ' (' + fmtPct(prevP) + ' to ' + fmtPct(curP) + ') between ' + when(p.at) + ' and ' + when(c.at) + '.'
    };
    return finish(payload, { abs_change_pp: Math.abs(change), full_scale_pp: T.full_scale_pp, rarity: rarity, evidence_class: cls, source_at: c.at, reliability_grade: payload.reliability.grade, event_at: game.event_at, flags: flags }, ctx);
  }

  function relevanceText(game, now, absChange, rarity) {
    var parts = [];
    if (game.event_at) {
      var m = minutesBetween(now, game.event_at);
      parts.push(m === null ? 'Start time unknown.' : (m <= 0 ? 'The game has started; this is history.' : 'Starts in ' + (m < 2880 ? C.round(m / 60, 1) + ' hours' : Math.round(m / 1440) + ' days') + '.'));
    }
    if (rarity && rarity.value !== null) parts.push('This move is ' + rarityWords(rarity) + '.');
    else if (rarity) parts.push('Too few earlier moves on record to say how unusual this is.');
    return parts.join(' ');
  }

  /* ====================================================== market divergence
     row: { game (as forecastShifts), model: { p_home, at, snapshot_id,
            model_id, model_version, built_at, data_status, validation },
            quote: { book, source, captured_at, observed_at, moneyline:{home,away} },
            kalshi: optional { yes_mid_home, captured_at, ticker } }
     ctx: { now, board_gaps: {<league>: [|gap| of every comparable game on
            this board, this run]}, reliability }
     Returns { signals, gaps (every comparable gap, signalled or not), refused } */
  E.marketDivergence = function (rows, ctx) {
    ctx = ctx || {};
    var T = E.SPEC.thresholds.market_divergence;
    var signals = [], gaps = [], refused = [];
    var evaluated = (rows || []).map(function (r) { return Object.assign({ eval: evalGap(r, ctx) }, r); });
    var board = {};
    evaluated.forEach(function (r) { if (r.eval.ok) (board[r.game.league] = board[r.game.league] || []).push(Math.abs(r.eval.gap_pp)); });
    Object.keys(board).forEach(function (k) { board[k].sort(function (a, b) { return a - b; }); });
    evaluated.forEach(function (r) {
      if (!r.eval.ok) { refused.push({ event_key: r.game && r.game.event_key, reason: r.eval.reason }); return; }
      gaps.push({ event_key: r.game.event_key, league: r.game.league, gap_pp: r.eval.gap_pp, model_snapshot: r.model.snapshot_id, quote_at: r.quote.captured_at });
      if (Math.abs(r.eval.gap_pp) < T.floor_pp) return;
      var ref = (board[r.game.league] || []).filter(function (x, i, a) { return true; });
      signals.push(divergenceSignal(r, r.eval, ref, ctx));
    });
    return { signals: signals, gaps: gaps, refused: refused };
  };

  function namesAgree(a, b) {
    if (!a || !b) return false;
    if (a.abbr && b.abbr && lc(a.abbr) === lc(b.abbr)) return true;
    var x = lc(a.name).replace(/[^a-z0-9 ]/g, ''), y = lc(b.name).replace(/[^a-z0-9 ]/g, '');
    if (!x || !y) return false;
    return x === y || y.indexOf(x + ' ') === 0 || x.indexOf(y + ' ') === 0;
  }
  E._namesAgree = namesAgree;

  function evalGap(r, ctx) {
    var T = E.SPEC.thresholds.market_divergence;
    if (!r || !r.game || !r.model || !r.quote) return { ok: false, reason: 'missing model or quote' };
    if (!probOk(r.model.p_home)) return { ok: false, reason: 'no model probability' };
    if (r.model.data_status === 'UNAVAILABLE') return { ok: false, reason: 'model data unavailable' };
    var ml = r.quote.moneyline || {};
    var nv = C.noVigTwoWay(ml.home, ml.away);
    if (!nv) return { ok: false, reason: 'the moneyline pair is not a two-way market (' + ml.home + ' / ' + ml.away + ')' };
    if (nv.overround < 0 || nv.overround > 0.12) return { ok: false, reason: 'implausible overround ' + C.round(nv.overround, 3) };
    var qAge = minutesBetween(r.quote.captured_at, ctx.now);
    if (qAge === null) return { ok: false, reason: 'quote capture time unknown' };
    if (qAge > T.quote_live_minutes) return { ok: false, reason: 'quote is ' + Math.round(qAge) + ' min old (live window ' + T.quote_live_minutes + ' min): not a current price' };
    if (qAge < -5) return { ok: false, reason: 'quote captured in the future' };
    var mAge = minutesBetween(r.model.at, ctx.now);
    if (mAge === null || mAge > T.model_max_age_minutes) return { ok: false, reason: 'model snapshot is not current' };
    if (r.game.event_at && ms(r.game.event_at) <= ms(ctx.now)) return { ok: false, reason: 'the game has started' };
    /* orientation: by team names when the quote carries them; otherwise the
       join that attached the quote to this event must say it is oriented */
    var basis;
    if (r.quote.home && r.quote.away) {
      if (namesAgree(r.game.home, r.quote.away) && namesAgree(r.game.away, r.quote.home) && !namesAgree(r.game.home, r.quote.home)) return { ok: false, reason: 'orientation: the quote lists the teams the other way round' };
      if (!namesAgree(r.game.home, r.quote.home)) return { ok: false, reason: 'orientation: the quote’s home team does not match the model’s' };
      if (!namesAgree(r.game.away, r.quote.away)) return { ok: false, reason: 'orientation: the quote’s away team does not match the model’s' };
      basis = 'team names agree (abbreviation or name)';
    } else if (r.quote.oriented_by) {
      basis = r.quote.oriented_by;
    } else return { ok: false, reason: 'orientation unknown: the quote carries no team names and no oriented join' };
    var gap = ppChange(nv.a, r.model.p_home);
    return { ok: true, market_home: nv.a, overround: nv.overround, gap_pp: gap, quote_age_minutes: Math.round(qAge), model_age_minutes: Math.round(mAge), orientation_basis: basis };
  }
  E._evalGap = evalGap;

  function divergenceSignal(r, ev, boardRef, ctx) {
    var T = E.SPEC.thresholds.market_divergence;
    var g = r.game, side = ev.gap_pp > 0 ? 'home' : 'away', team = g[side], book = E.bookName(r.quote.book) || 'the book';
    var modelP = side === 'home' ? r.model.p_home : 1 - r.model.p_home;
    var mktP = side === 'home' ? ev.market_home : 1 - ev.market_home;
    var gap = ppChange(mktP, modelP);
    var others = boardRef.slice();
    var idx = others.indexOf(Math.abs(ev.gap_pp)); if (idx >= 0) others.splice(idx, 1);
    var rarity = E.rarity(Math.abs(gap), others, T.min_reference);
    rarity.basis = 'the other comparable ' + g.league.toUpperCase() + ' games on this board';
    var val = r.model.validation || {};
    var items = [
      { kind: 'model', text: 'EdgeDesk ' + (r.model.model_version || 'model') + ': ' + fmtPct(modelP) + ' for ' + team.name + ' (snapshot ' + (r.model.snapshot_id || '?') + ', ' + when(r.model.at) + ')', verified: true, at: iso(r.model.at) },
      { kind: 'market', text: book + ' moneyline ' + C.fmt.american(r.quote.moneyline.home) + ' / ' + C.fmt.american(r.quote.moneyline.away) + ', de-vigged (multiplicative) to ' + fmtPct(mktP) + ' for ' + team.name + ', captured ' + when(r.quote.captured_at) + ' via ' + (E.sourceName(r.quote.source) || 'an unknown source'), verified: true, at: iso(r.quote.captured_at) }
    ];
    if (val.market_test) items.push({ kind: 'audit', text: 'Market test for this model: ' + val.market_test + (val.value_claims === false ? ' (EdgeDesk makes no value claim on it)' : ''), verified: true, at: null });
    /* inputs the snapshot records (a starter check, for football): context a
       researcher should see, never presented as the reason for the gap */
    ((r.context && r.context.qb) || []).forEach(function (q) {
      items.push({ kind: 'context', text: 'Model input: ' + q.team + ' quarterback ' + q.name + ', starter check ' + lc(q.status || 'unknown').replace(/_/g, ' ') + (q.basis ? ' (' + q.basis + ')' : '') + (q.source ? ', ' + q.source : '') + (q.as_of ? ', as of ' + when(q.as_of) : ''), verified: true, at: q.as_of || null, source: q.source || null });
    });
    var checks = [
      check('same_event', true, g.event_key),
      check('same_outcome', true, 'game winner (' + (g.settles || 'moneyline settlement') + ') vs the book’s two-way moneyline'),
      check('orientation', !!ev.orientation_basis, ev.orientation_basis),
      check('quote_live', ev.quote_age_minutes <= T.quote_live_minutes, ev.quote_age_minutes + ' min'),
      check('two_way_market', ev.overround >= 0 && ev.overround <= 0.12, C.round(ev.overround, 4)),
      check('pregame', !g.event_at || ms(ctx.now) < ms(g.event_at), g.event_at),
      check('model_identity_recorded', !!r.model.model_version, r.model.model_version)
    ];
    var consensus = E.consensus(g, [
      { id: 'edgedesk', label: 'EdgeDesk model', group: 'edgedesk', p_home: r.model.p_home, at: r.model.at, version: r.model.model_version, kind: 'model' },
      { id: 'book', label: (r.quote.book || 'Book') + ' (de-vigged)', group: 'market', p_home: ev.market_home, at: r.quote.captured_at, kind: 'market' }
    ].concat(r.kalshi && probOk(r.kalshi.p_home) ? [{ id: 'kalshi', label: 'Kalshi (mid, before fees)', group: 'market', p_home: r.kalshi.p_home, at: r.kalshi.captured_at, kind: 'market' }] : [])
      .concat((r.others || []).filter(function (o) { return probOk(o.p_home); })));
    var payload = {
      category: 'MARKET_DIVERGENCE', subtype: 'model_vs_book',
      sport: g.sport, league: g.league, season: g.season, event_kind: 'game',
      subject: { kind: 'team', key: g.sport + ':' + lc(team.abbr || team.name), label: team.name, side: side },
      event: { key: g.event_key, label: g.away.name + ' at ' + g.home.name, at: iso(g.event_at), home: g.home, away: g.away, neutral: !!g.neutral },
      teams: [lc(g.home.name), lc(g.away.name), lc(g.home.abbr), lc(g.away.abbr)].filter(Boolean),
      market_type: 'moneyline',
      outcome: { id: side + '_win', label: team.name + ' win', definition: g.settles || 'game winner' },
      identity: { c: 'MARKET_DIVERGENCE', e: g.event_key, o: 'win', m: r.model.model_id || null, snap: r.model.snapshot_id, book: lc(r.quote.book) },
      headline: 'EdgeDesk ' + fmtPct(modelP) + ' vs ' + book + ' ' + fmtPct(mktP) + ' on ' + team.name + ' (' + fmtPP(gap) + ')',
      values: {
        unit: 'probability',
        previous: { value: C.round(mktP, 4), display: fmtPct(mktP), at: iso(r.quote.captured_at), role: 'market', book: r.quote.book, american: { home: r.quote.moneyline.home, away: r.quote.moneyline.away }, overround: C.round(ev.overround, 4), devig: 'multiplicative' },
        current: { value: C.round(modelP, 4), display: fmtPct(modelP), at: iso(r.model.at), role: 'model', snapshot_id: r.model.snapshot_id, model_version: r.model.model_version },
        change_pp: gap, change_display: fmtPP(gap), gap_home_pp: ev.gap_pp,
        distribution: { reference_n: rarity.reference_n, rarity: rarity.value, basis: rarity.basis, note: rarity.note }
      },
      market: { book: book, source: r.quote.source || null, source_label: E.sourceName(r.quote.source), captured_at: iso(r.quote.captured_at), observed_at: iso(r.quote.observed_at), age_minutes: ev.quote_age_minutes, moneyline: r.quote.moneyline, no_vig_home: C.round(ev.market_home, 4), overround: C.round(ev.overround, 4), devig_method: 'multiplicative (lib/edgedesk_calc.js noVigTwoWay)' },
      model: { id: r.model.model_id || null, version: r.model.model_version || null, built_at: iso(r.model.built_at), validation: val },
      timestamps: { event_at: iso(g.event_at), source_published_at: iso(r.quote.captured_at), calculated_at: iso(r.model.built_at || r.model.at), recorded_at: iso(r.model.at), detected_at: iso(ctx.now) },
      evidence: { class: 'OBSERVED', label: E.EVIDENCE.OBSERVED.label, means: E.EVIDENCE.OBSERVED.means,
        summary: 'EdgeDesk’s model and ' + book + ' disagree by ' + fmtPP(gap) + ' on ' + team.name + '. A disagreement is a question to research, not a betting opportunity: '
          + (val.market_test === 'TESTED_BEHIND' ? 'in its backtest this model was behind the closing market.' : (val.market_test === 'NOT_TESTED' ? 'this model has never been tested against the closing market.' : 'the model’s record against the market is in Model DNA.')),
        items: items, attribution: 'Signal Center does not say which number is right.' },
      consensus: consensus,
      verification: verification(checks),
      quality: { flags: r.model.data_status === 'LIMITED' ? ['DATA_LIMITED'] : [], quote_age_minutes: ev.quote_age_minutes, model_age_minutes: ev.model_age_minutes },
      reliability: { grade: ctx.reliability ? ctx.reliability[r.model.model_version] || null : null },
      sources: [g.source || null, { id: 'quote', label: book + ' via ' + (E.sourceName(r.quote.source) || '?'), ref: r.quote.ref || null, records: [iso(r.quote.captured_at)] }].filter(Boolean),
      links: { research: g.research_href || null, simulator: g.simulator_href || null },
      relevance: relevanceText(g, nowOf(ctx), Math.abs(gap), rarity),
      summary: 'EdgeDesk ' + fmtPct(modelP) + ', ' + book + ' ' + fmtPct(mktP) + ' (no-vig) for ' + team.name + ', a ' + fmtPP(gap) + ' disagreement. Not a betting recommendation.'
    };
    return finish(payload, { abs_change_pp: Math.abs(gap), full_scale_pp: T.full_scale_pp, rarity: rarity, evidence_class: 'OBSERVED', source_at: r.quote.captured_at, reliability_grade: payload.reliability.grade, event_at: g.event_at, flags: payload.quality.flags }, ctx);
  }

  /* ===================================================== market convergence
     prior: the last stored divergence payload per event (from the database);
     gaps: this run's comparable gaps (marketDivergence().gaps), by event. A
     convergence is a stored divergence of at least from_floor_pp whose gap is
     now at most to_pp, same model version, same book. */
  E.marketConvergence = function (prior, rows, ctx) {
    ctx = ctx || {};
    var T = E.SPEC.thresholds.market_convergence;
    var byEvent = {};
    (rows || []).forEach(function (r) { if (r && r.game) byEvent[r.game.event_key] = r; });
    var out = [];
    (prior || []).forEach(function (d) {
      if (!d || d.category !== 'MARKET_DIVERGENCE' || !d.values) return;
      var r = byEvent[d.event && d.event.key];
      if (!r) return;
      var ev = evalGap(r, ctx);
      if (!ev.ok) return;
      if (Math.abs(d.values.gap_home_pp) < T.from_floor_pp) return;
      if (lc(E.bookName(r.quote.book)) !== lc(d.market && d.market.book)) return;
      if (r.model.model_version !== (d.model && d.model.version)) return;
      if (Math.abs(ev.gap_pp) > T.to_pp) return;
      var g = r.game, side = d.subject.side, team = g[side];
      var oldGap = d.values.change_pp, newGap = ppChange(side === 'home' ? ev.market_home : 1 - ev.market_home, side === 'home' ? r.model.p_home : 1 - r.model.p_home);
      var modelMoved = ppChange(d.values.current.value, side === 'home' ? r.model.p_home : 1 - r.model.p_home);
      var mktMoved = ppChange(d.values.previous.value, side === 'home' ? ev.market_home : 1 - ev.market_home);
      var who = Math.abs(modelMoved) > Math.abs(mktMoved) ? 'mostly the model' : (Math.abs(mktMoved) > Math.abs(modelMoved) ? 'mostly the market' : 'both equally');
      var checks = [check('same_event', true, g.event_key), check('same_book', true, r.quote.book), check('same_model_version', true, r.model.model_version), check('quote_live', true, ev.quote_age_minutes + ' min')];
      var payload = {
        category: 'MARKET_CONVERGENCE', subtype: 'gap_closed', sport: g.sport, league: g.league, season: g.season, event_kind: 'game',
        subject: d.subject, event: d.event, teams: d.teams, market_type: 'moneyline', outcome: d.outcome,
        identity: { c: 'MARKET_CONVERGENCE', from: d.signal_key, snap: r.model.snapshot_id, q: iso(r.quote.captured_at) },
        headline: 'EdgeDesk and ' + (E.bookName(r.quote.book) || 'the market') + ' now ' + fmtPP(newGap).replace(/^\+/, '') + ' apart on ' + team.name + ' (was ' + fmtPP(oldGap).replace(/^\+/, '') + ')',
        values: { unit: 'gap_pp', previous: { value: oldGap, display: fmtPP(oldGap), at: d.values.current.at, signal_key: d.signal_key }, current: { value: newGap, display: fmtPP(newGap), at: iso(ctx.now) }, change_pp: C.round(newGap - oldGap, 1), change_display: fmtPP(C.round(newGap - oldGap, 1)), model_moved_pp: modelMoved, market_moved_pp: mktMoved },
        market: { book: E.bookName(r.quote.book), captured_at: iso(r.quote.captured_at), moneyline: r.quote.moneyline, no_vig_home: C.round(ev.market_home, 4) },
        model: { id: r.model.model_id || null, version: r.model.model_version, snapshot_id: r.model.snapshot_id },
        timestamps: { event_at: iso(g.event_at), source_published_at: iso(r.quote.captured_at), calculated_at: iso(r.model.at), recorded_at: iso(r.model.at), detected_at: iso(ctx.now) },
        evidence: { class: 'OBSERVED', label: E.EVIDENCE.OBSERVED.label, means: E.EVIDENCE.OBSERVED.means, summary: 'The gap closed by ' + fmtPP(C.round(Math.abs(oldGap) - Math.abs(newGap), 1)).replace(/^\+/, '') + '; ' + who + ' moved (model ' + fmtPP(modelMoved) + ', market ' + fmtPP(mktMoved) + ').', items: [], attribution: 'Movement is measured, not explained.' },
        verification: verification(checks), quality: { flags: [] },
        reliability: { grade: ctx.reliability ? ctx.reliability[r.model.model_version] || null : null },
        sources: [g.source || null].filter(Boolean), links: { research: g.research_href || null },
        relevance: relevanceText(g, nowOf(ctx), Math.abs(oldGap - newGap), null),
        summary: 'A ' + fmtPP(oldGap) + ' disagreement on ' + team.name + ' is now ' + fmtPP(newGap) + '.'
      };
      out.push(finish(payload, { abs_change_pp: Math.abs(oldGap - newGap), full_scale_pp: 20, rarity: null, evidence_class: 'OBSERVED', source_at: r.quote.captured_at, reliability_grade: payload.reliability.grade, event_at: g.event_at, flags: [] }, ctx));
    });
    return out;
  };

  /* ========================================================== line movement
     quotes: one event's captures from one book, any order:
       { book, source, captured_at, moneyline:{home,away}, ref }
     Compares consecutive captures of the SAME book (never two books). */
  E.lineMovement = function (quotes, game, ctx) {
    ctx = ctx || {};
    var T = E.SPEC.thresholds.line_movement;
    var rows = sortBy((quotes || []).filter(function (q) { return q && ms(q.captured_at) !== null && C.noVigTwoWay(q.moneyline && q.moneyline.home, q.moneyline && q.moneyline.away); }), function (q) { return ms(q.captured_at); });
    var signals = [], moves = [];
    var refAll = (ctx.reference && ctx.reference[game.league]) || null;
    for (var i = 1; i < rows.length; i++) {
      var p = rows[i - 1], c = rows[i];
      if (lc(p.book) !== lc(c.book)) continue;
      if (ms(c.captured_at) === ms(p.captured_at)) continue;
      if (game.event_at && ms(c.captured_at) >= ms(game.event_at)) continue;
      var a = C.noVigTwoWay(p.moneyline.home, p.moneyline.away), b = C.noVigTwoWay(c.moneyline.home, c.moneyline.away);
      var dH = ppChange(a.a, b.a), ad = Math.abs(dH);
      if (ad > 0) moves.push({ league: game.league, at: c.captured_at, abs_pp: ad });
      if (ad < T.floor_pp) continue;
      if (minutesBetween(p.captured_at, c.captured_at) > T.max_gap_hours * 60) continue;
      var side = dH > 0 ? 'home' : 'away', team = game[side];
      var prevP = side === 'home' ? a.a : a.b, curP = side === 'home' ? b.a : b.b, ch = ppChange(prevP, curP);
      var ref = refAll ? refAll.filter(function (m) { return ms(m.at) < ms(c.captured_at); }).map(function (m) { return m.abs_pp; }).sort(function (x, y) { return x - y; }) : null;
      var rarity = E.rarity(ad, ref, T.min_reference);
      var checks = [check('same_book', true, c.book), check('same_event', true, game.event_key), check('ordered_in_time', ms(p.captured_at) < ms(c.captured_at)), check('pregame', true), check('two_way_market', true)];
      var payload = {
        category: 'LINE_MOVEMENT', subtype: 'moneyline', sport: game.sport, league: game.league, season: game.season, event_kind: 'game',
        subject: { kind: 'team', key: game.sport + ':' + lc(team.abbr || team.name), label: team.name, side: side },
        event: { key: game.event_key, label: game.away.name + ' at ' + game.home.name, at: iso(game.event_at), home: game.home, away: game.away },
        teams: [lc(game.home.name), lc(game.away.name), lc(game.home.abbr), lc(game.away.abbr)].filter(Boolean),
        market_type: 'moneyline', outcome: { id: side + '_win', label: team.name + ' win', definition: 'the book’s two-way moneyline' },
        identity: { c: 'LINE_MOVEMENT', e: game.event_key, book: lc(c.book), prev: iso(p.captured_at), cur: iso(c.captured_at) },
        headline: (E.bookName(c.book) || 'The book') + ' moved toward ' + team.name + ': ' + fmtPct(prevP) + ' to ' + fmtPct(curP) + ' (no-vig)',
        values: { unit: 'probability', previous: { value: C.round(prevP, 4), display: fmtPct(prevP), at: iso(p.captured_at), american: p.moneyline }, current: { value: C.round(curP, 4), display: fmtPct(curP), at: iso(c.captured_at), american: c.moneyline }, change_pp: ch, change_display: fmtPP(ch), interval_hours: C.round(minutesBetween(p.captured_at, c.captured_at) / 60, 2), distribution: { reference_n: rarity.reference_n, rarity: rarity.value, note: rarity.note, basis: 'earlier same-book moneyline moves, ' + game.league.toUpperCase() } },
        market: { book: E.bookName(c.book), source: c.source || null, source_label: E.sourceName(c.source), captured_at: iso(c.captured_at), moneyline: c.moneyline, devig_method: 'multiplicative' },
        model: { id: null, version: null },
        timestamps: { event_at: iso(game.event_at), source_published_at: iso(c.captured_at), calculated_at: null, recorded_at: iso(c.observed_at || c.captured_at), detected_at: iso(ctx.now) },
        evidence: { class: 'OBSERVED', label: E.EVIDENCE.OBSERVED.label, means: E.EVIDENCE.OBSERVED.means, summary: 'The same book’s de-vigged price moved ' + fmtPP(ch) + ' toward ' + team.name + ' between two captures. Why the market moved is not on record.', items: [], attribution: 'A price move is never read as information about the game.' },
        verification: verification(checks), quality: { flags: [] }, reliability: { grade: null },
        sources: [{ id: 'quotes', label: (E.bookName(c.book) || 'book') + ' via ' + (E.sourceName(c.source) || '?'), ref: c.ref || null, records: [iso(p.captured_at), iso(c.captured_at)] }],
        links: { research: game.research_href || null }, relevance: relevanceText(game, nowOf(ctx), ad, rarity),
        summary: (E.bookName(c.book) || 'The book') + ' moved ' + fmtPP(ch) + ' toward ' + team.name + '.'
      };
      signals.push(finish(payload, { abs_change_pp: ad, full_scale_pp: T.full_scale_pp, rarity: rarity, evidence_class: 'OBSERVED', source_at: c.captured_at, reliability_grade: null, event_at: game.event_at, flags: [] }, ctx));
    }
    return { signals: signals, moves: moves };
  };

  /* ======================================================== simulator shifts
     pair: { sport, competition, season, previous: run, current: run }
       run: { run_id, model_version, rules_version, engine_version, n_sims,
              input_snapshot_at, completed_at, published_at, validation_summary }
     results: { previous: [rows], current: [rows] }
       row: { entity_id, entity_name, outcome, probability, mcse, provenance, applicable }
     ctx: { now, outcomes: {<outcome>: label}, reference: [{at, abs_pp}], href } */
  E.SIM_OUTCOMES = {
    nfl: { make_playoffs: 'playoff', win_division: 'division title', win_conference: 'conference title', win_super_bowl: 'Super Bowl' },
    cfb: { cfp_field: 'College Football Playoff field', conf_champion: 'conference title', national_champion: 'national title' },
    nhl: { make_playoffs: 'playoff', win_division: 'division title', win_conference: 'conference title', win_stanley_cup: 'Stanley Cup' },
    nba: { make_playoffs: 'playoff', win_division: 'division title', win_conference: 'conference title', win_title: 'NBA title' },
    mlb: { make_playoffs: 'playoff', win_division: 'division title', win_pennant: 'pennant', win_world_series: 'World Series' },
    wnba: { win_title: 'WNBA title' }
  };
  E.simulationShifts = function (pair, results, ctx) {
    ctx = ctx || {};
    var T = E.SPEC.thresholds.simulation_shift;
    var out = { signals: [], moves: [], refused: [] };
    if (!pair || !pair.previous || !pair.current) { out.refused.push({ reason: 'no previous published run to compare with' }); return out; }
    var P = pair.previous, Q = pair.current;
    if (!(num(P.n_sims) >= T.min_n_sims && num(Q.n_sims) >= T.min_n_sims)) { out.refused.push({ reason: 'a run has fewer than ' + T.min_n_sims + ' simulations' }); return out; }
    if (ms(P.input_snapshot_at) !== null && ms(Q.input_snapshot_at) !== null && ms(Q.input_snapshot_at) < ms(P.input_snapshot_at)) { out.refused.push({ reason: 'the current run’s inputs are older than the previous run’s' }); return out; }
    var sameModel = P.model_version === Q.model_version && P.rules_version === Q.rules_version;
    var labels = ctx.outcomes || E.SIM_OUTCOMES[pair.sport] || {};
    var prev = {};
    (results.previous || []).forEach(function (r) { prev[r.entity_id + '|' + r.outcome] = r; });
    var cfb = (Q.validation_summary && Q.validation_summary.cfb) || null;
    (results.current || []).forEach(function (c) {
      if (!labels[c.outcome]) return;
      var p = prev[c.entity_id + '|' + c.outcome];
      if (!p) return; /* an outcome that exists on one side only is a format change, not a shift */
      if (c.applicable === false || p.applicable === false) return;
      if (!isNum(num(c.probability)) || !isNum(num(p.probability))) return;
      var pc = num(c.probability), pp = num(p.probability);
      var ch = ppChange(pp, pc), ad = Math.abs(ch);
      var se = Math.sqrt(Math.pow(num(p.mcse) || 0, 2) + Math.pow(num(c.mcse) || 0, 2));
      var z = se > 0 ? (pc - pp) / se : null;
      if (ad > 0 && sameModel) out.moves.push({ at: Q.completed_at || Q.published_at, abs_pp: ad, outcome: c.outcome });
      if (ad < T.floor_pp) return;
      if (z !== null && Math.abs(z) < T.min_z) return;
      if (p.provenance !== c.provenance) { out.refused.push({ entity: c.entity_id, outcome: c.outcome, reason: 'provenance changed (' + p.provenance + ' to ' + c.provenance + '): a methodology change, not compared' }); return; }
      var ref = (ctx.reference || []).filter(function (m) { return m.outcome === c.outcome && ms(m.at) < ms(Q.completed_at || Q.published_at); }).map(function (m) { return m.abs_pp; }).sort(function (a, b) { return a - b; });
      var rarity = E.rarity(ad, ref, T.min_reference);
      var estimated = c.provenance === 'Estimated';
      var cls = sameModel ? 'SUPPORTED_ASSOCIATION' : 'MODEL_VERSION_CHANGE';
      var inputsMoved = P.input_snapshot_at !== Q.input_snapshot_at;
      var summary = !sameModel
        ? 'The simulator’s model or rules changed between the runs (' + P.model_version + '/' + P.rules_version + ' to ' + Q.model_version + '/' + Q.rules_version + '). The movement reflects that change.'
        : (inputsMoved ? 'The run’s inputs moved from ' + when(P.input_snapshot_at) + ' to ' + when(Q.input_snapshot_at) + ' (results played and ratings updated since). Which result moved this team’s number has not been isolated.' : 'Both runs read the same inputs; the change is sampling noise beyond the threshold or an engine change.');
      if (sameModel && !inputsMoved) cls = 'UNEXPLAINED';
      var label = labels[c.outcome];
      var checks = [
        check('same_competition', true, pair.sport + ' ' + pair.competition + ' ' + pair.season),
        check('same_outcome_definition', p.outcome === c.outcome && p.provenance === c.provenance, c.outcome),
        check('beyond_sampling_noise', z === null ? false : Math.abs(z) >= T.min_z, z === null ? 'no Monte Carlo error recorded' : 'z = ' + C.round(z, 1)),
        check('published_runs', true, [P.run_id, Q.run_id]),
        check('ordered_inputs', ms(P.input_snapshot_at) === null || ms(Q.input_snapshot_at) >= ms(P.input_snapshot_at), [P.input_snapshot_at, Q.input_snapshot_at]),
        check('enough_simulations', num(Q.n_sims) >= T.min_n_sims && num(P.n_sims) >= T.min_n_sims, [P.n_sims, Q.n_sims])
      ];
      var payload = {
        category: 'SIMULATION_SHIFT', subtype: c.outcome, sport: pair.sport, league: pair.sport, season: pair.season, event_kind: 'season',
        subject: { kind: 'team', key: pair.sport + ':' + lc(c.entity_id), label: c.entity_name || c.entity_id, entity_id: c.entity_id },
        event: { key: pair.sport + '|' + pair.competition + '|' + pair.season, label: pair.competition + ' ' + pair.season, at: null },
        teams: [lc(c.entity_name), lc(c.entity_id)].filter(Boolean),
        market_type: 'season_outcome',
        outcome: { id: c.outcome, label: (c.entity_name || c.entity_id) + ' ' + label, definition: label + ' probability from the published simulator run' + (estimated ? ' (Estimated)' : ''), provenance: c.provenance || null },
        identity: { c: 'SIMULATION_SHIFT', s: pair.sport, comp: pair.competition, season: pair.season, ent: c.entity_id, o: c.outcome, prev: P.run_id, cur: Q.run_id },
        headline: (c.entity_name || c.entity_id) + ' ' + label + ' probability ' + (ch > 0 ? 'up ' : 'down ') + fmtPP(Math.abs(ch)).replace(/^\+/, '') + ' to ' + fmtPct(pc) + (estimated ? ' (estimated)' : ''),
        values: {
          unit: 'probability',
          previous: { value: C.round(pp, 4), display: fmtPct(pp), at: iso(P.completed_at || P.published_at), run_id: P.run_id, mcse: num(p.mcse), n_sims: num(P.n_sims), model_version: P.model_version, input_snapshot_at: iso(P.input_snapshot_at) },
          current: { value: C.round(pc, 4), display: fmtPct(pc), at: iso(Q.completed_at || Q.published_at), run_id: Q.run_id, mcse: num(c.mcse), n_sims: num(Q.n_sims), model_version: Q.model_version, input_snapshot_at: iso(Q.input_snapshot_at) },
          change_pp: ch, change_display: fmtPP(ch), relative_change: pp > 0 ? C.round((pc - pp) / pp, 4) : null,
          z: z === null ? null : C.round(z, 2),
          sampling_note: 'Monte Carlo error (±' + C.round(1.96 * se * 100, 2) + ' pp at 95% for the difference) measures simulation sampling only. It is not the forecast’s total uncertainty.',
          distribution: { reference_n: rarity.reference_n, rarity: rarity.value, note: rarity.note, basis: 'earlier published-run changes for this outcome' }
        },
        model: { id: 'simulator:' + pair.sport, version: Q.model_version, previous_version: P.model_version, rules_version: Q.rules_version, engine_version: Q.engine_version, status: 'EXPERIMENTAL (T3 research model)' },
        simulation: { competition: pair.competition, season: pair.season, previous_run: P.run_id, current_run: Q.run_id, n_sims: [num(P.n_sims), num(Q.n_sims)], seeds: 'independent (seeded from each run’s input hash)', provenance: c.provenance || null, cfp_mode: cfb ? cfb.cfp_mode || null : null, cfp_mode_reason: cfb ? cfb.cfp_mode_reason || null : null,
          estimated_note: estimated ? (pair.sport === 'cfb' ? 'Estimated: CFP selection and seeding come from a committee proxy fitted to past committee choices. It is not the committee.' : 'Estimated: this outcome depends on a modelled step, not an observed rule.') : null },
        timestamps: { event_at: null, source_published_at: iso(Q.published_at || Q.completed_at), calculated_at: iso(Q.completed_at), recorded_at: iso(Q.published_at || Q.completed_at), input_snapshot_at: iso(Q.input_snapshot_at), detected_at: iso(ctx.now) },
        evidence: { class: cls, label: E.EVIDENCE[cls].label, means: E.EVIDENCE[cls].means, summary: summary, items: [{ kind: 'run', text: 'Previous run ' + P.run_id + ' (inputs ' + when(P.input_snapshot_at) + ', ' + P.n_sims + ' simulations); current run ' + Q.run_id + ' (inputs ' + when(Q.input_snapshot_at) + ', ' + Q.n_sims + ' simulations)', verified: true, at: iso(Q.completed_at) }], attribution: 'Paired (common random number) reruns are not available: the two runs use independent seeds.' },
        verification: verification(checks), quality: { flags: [] },
        reliability: { grade: 'EXPERIMENTAL' },
        sources: [{ id: 'sim', label: 'EdgeDesk Simulator (published runs)', ref: 'public.sim_team_results', records: [P.run_id, Q.run_id] }],
        links: { simulator: ctx.href || ('#simulator/' + pair.sport), research: null },
        relevance: 'Season outcome, still open. ' + (rarity.value !== null ? 'This change is ' + rarityWords(rarity) + '.' : 'Too few earlier published runs to say how unusual this is.'),
        summary: (c.entity_name || c.entity_id) + ': ' + label + ' ' + fmtPct(pp) + ' to ' + fmtPct(pc) + ' between published runs.'
      };
      out.signals.push(finish(payload, { abs_change_pp: ad, full_scale_pp: T.full_scale_pp, rarity: rarity, evidence_class: cls, source_at: Q.published_at || Q.completed_at, reliability_grade: 'EXPERIMENTAL', season_open: true, flags: [] }, ctx));
    });
    return out;
  };

  /* ============================================================== injuries
     rows: designations from ONE source family for ONE team, any order:
       { sport, team:{name,abbr}, player:{id,name,position}, status,
         report:{id, type, published_at, retrieved_at, source_url, source},
         game:{event_key, event_at, label, home, away} }
     A signal is a designation that DIFFERS from the same player's previous
     designation in an earlier report (or a first listing), for a game that
     had not started when the report was published. Only positions the
     caller declares in scope are read (CFB: quarterbacks). No model effect is
     printed unless the caller passes one that was actually computed. */
  var STATUS_RANK = { AVAILABLE: 0, PROBABLE: 1, GAME_TIME_DECISION: 2, QUESTIONABLE: 2, DOUBTFUL: 3, OUT_FIRST_HALF: 3, OUT: 4 };
  E.STATUS_LABEL = { AVAILABLE: 'available', PROBABLE: 'probable', QUESTIONABLE: 'questionable', GAME_TIME_DECISION: 'a game-time decision', DOUBTFUL: 'doubtful', OUT_FIRST_HALF: 'out for the first half', OUT: 'out', UNKNOWN: 'unknown' };
  E.injuryChanges = function (rows, ctx) {
    ctx = ctx || {};
    var out = [];
    var bySubject = {};
    (rows || []).forEach(function (r) {
      if (!r || !r.player || !r.report || !STATUS_RANK.hasOwnProperty(r.status)) return;
      if (ctx.positions && ctx.positions.indexOf(r.player.position) < 0) return;
      var k = r.sport + '|' + lc(r.team.abbr || r.team.name) + '|' + (r.player.id || lc(r.player.name));
      (bySubject[k] = bySubject[k] || []).push(r);
    });
    Object.keys(bySubject).sort().forEach(function (k) {
      var list = sortBy(bySubject[k].filter(function (r) { return ms(r.report.published_at) !== null; }), function (r) { return ms(r.report.published_at); });
      for (var i = 0; i < list.length; i++) {
        var c = list[i], p = i > 0 ? list[i - 1] : null;
        if (p && p.status === c.status) continue;
        if (!p && STATUS_RANK[c.status] === 0) continue;
        if (c.game && c.game.event_at && ms(c.report.published_at) >= ms(c.game.event_at)) continue;
        out.push(injurySignal(p, c, ctx));
      }
    });
    return out;
  };
  function injurySignal(p, c, ctx) {
    var worse = !p || STATUS_RANK[c.status] > STATUS_RANK[p.status];
    var g = c.game || {};
    var effect = ctx.effects ? ctx.effects[c.sport + '|' + (c.player.id || lc(c.player.name)) + '|' + (g.event_key || '')] || null : null;
    var checks = [
      check('source_dated', ms(c.report.published_at) !== null, c.report.published_at),
      check('named_source', !!(c.report.source_url || c.report.source), c.report.source_url || c.report.source),
      check('pregame', !g.event_at || ms(c.report.published_at) < ms(g.event_at), [c.report.published_at, g.event_at]),
      check('player_identified', !!(c.player.id || c.player.name), c.player.id || c.player.name)
    ];
    var statusText = E.STATUS_LABEL[c.status] || lc(c.status);
    var items = [{ kind: 'fact', text: c.player.name + (c.player.position ? ' (' + c.player.position + ')' : '') + ' listed ' + statusText + ' on the ' + (c.report.type || 'availability') + ' report published ' + when(c.report.published_at) + '.', verified: true, at: iso(c.report.published_at), source: c.report.source_url || c.report.source }];
    if (p) items.push({ kind: 'fact', text: 'Previous designation: ' + (E.STATUS_LABEL[p.status] || lc(p.status)) + ' (report published ' + when(p.report.published_at) + ').', verified: true, at: iso(p.report.published_at), source: p.report.source_url || p.report.source });
    var effText = effect ? 'Estimated model effect (' + effect.model + ', ' + effect.status + '): ' + fmtPP(effect.change_pp) + ' on ' + effect.team + '’s win probability, from a computation that changed only this availability input.' : 'No model effect is calculated for this designation: EdgeDesk’s ' + c.sport.toUpperCase() + ' model has no per-player availability computation that isolates it.';
    var payload = {
      category: 'INJURY_IMPACT', subtype: lc(c.status), sport: c.sport, league: c.sport, season: c.season || null, event_kind: 'player',
      subject: { kind: 'player', key: c.sport + ':player:' + (c.player.id || lc(c.player.name)), label: c.player.name, team: c.team.name, position: c.player.position || null },
      event: { key: g.event_key || null, label: g.label || null, at: iso(g.event_at), home: g.home || null, away: g.away || null },
      teams: [lc(c.team.name), lc(c.team.abbr)].filter(Boolean),
      market_type: 'availability',
      outcome: { id: 'availability', label: c.player.name + ' availability', definition: 'the designation on the team’s published availability report' },
      identity: { c: 'INJURY_IMPACT', s: c.sport, pl: c.player.id || lc(c.player.name), rep: c.report.id || iso(c.report.published_at), st: c.status, e: g.event_key || null },
      headline: c.player.name + (c.player.position ? ' (' + c.player.position + ', ' : ' (') + c.team.name + ') listed ' + statusText + (p ? ', was ' + (E.STATUS_LABEL[p.status] || lc(p.status)) : ''),
      values: { unit: 'status', previous: p ? { value: p.status, display: E.STATUS_LABEL[p.status] || p.status, at: iso(p.report.published_at) } : { value: null, display: 'not listed', at: null }, current: { value: c.status, display: statusText, at: iso(c.report.published_at) }, change_pp: effect ? effect.change_pp : null, change_display: effect ? fmtPP(effect.change_pp) : null, direction: worse ? 'worse' : 'better' },
      facts_vs_estimates: { facts: items.map(function (i) { return i.text; }), estimate: effect ? effText : null },
      model: { id: effect ? effect.model : null, version: effect ? effect.version : null, effect_calculated: !!effect },
      timestamps: { event_at: iso(g.event_at), source_published_at: iso(c.report.published_at), calculated_at: effect ? iso(effect.computed_at) : null, recorded_at: iso(c.report.retrieved_at), detected_at: iso(ctx.now) },
      evidence: { class: effect && effect.isolated ? 'CONFIRMED_CAUSE' : 'OBSERVED', label: E.EVIDENCE[effect && effect.isolated ? 'CONFIRMED_CAUSE' : 'OBSERVED'].label, means: E.EVIDENCE[effect && effect.isolated ? 'CONFIRMED_CAUSE' : 'OBSERVED'].means, summary: effText, items: items, attribution: effect ? 'The estimate is the model’s; the designation is the team’s.' : 'A designation is a fact about availability, not a forecast change.' },
      verification: verification(checks), quality: { flags: [] }, reliability: { grade: effect ? 'EXPERIMENTAL' : null },
      sources: [{ id: 'availability', label: c.report.source || 'availability report', ref: c.report.source_url || null, records: [c.report.id || null] }],
      links: { research: g.research_href || null },
      relevance: g.event_at ? relevanceText(g, nowOf(ctx), 0, null) : '',
      summary: c.player.name + ' (' + c.team.name + ') is listed ' + statusText + '.' + (p ? ' Previously ' + (E.STATUS_LABEL[p.status] || lc(p.status)) + '.' : '')
    };
    var mag = effect && isNum(effect.change_pp) ? Math.abs(effect.change_pp) : (STATUS_RANK[c.status] >= 3 ? 4 : 2);
    return finish(payload, { abs_change_pp: mag, full_scale_pp: 10, rarity: null, evidence_class: payload.evidence.class, source_at: c.report.published_at, reliability_grade: payload.reliability.grade, event_at: g.event_at, flags: [] }, ctx);
  }

  /* ===================================================== reliability warnings
     dna: Model DNA records (lib/edgedesk_model_dna.js). A warning is an audit
     finding with its statistic, its sample and its window, never "bad model". */
  E.reliabilityWarnings = function (dnaRecords, ctx) {
    ctx = ctx || {};
    var T = E.SPEC.thresholds.reliability, out = [];
    (dnaRecords || []).forEach(function (d) {
      if (!d || !d.live) return;
      var L = d.live;
      (L.calibration || []).forEach(function (b) {
        if (!(b.n >= T.min_bucket_n) || b.inside_interval !== false) return;
        var gap = C.round(100 * (b.mean_predicted - b.observed), 1);
        if (Math.abs(gap) < T.min_gap_pp) return;
        var dir = gap > 0 ? 'high' : 'low';
        out.push(reliabilitySignal(d, 'calibration_band', {
          headline: d.label + ': forecasts in the ' + Math.round(b.from * 100) + '–' + Math.round(b.to * 100) + '% band ran ' + fmtPP(Math.abs(gap)).replace(/^\+/, '') + ' ' + dir,
          stat: { measure: 'mean predicted minus observed win rate', value_pp: gap, band: [b.from, b.to], n: b.n, mean_predicted: b.mean_predicted, observed: b.observed, wilson_95: [b.wilson_low, b.wilson_high] },
          summary: 'In ' + b.n + ' graded games where the model said ' + Math.round(b.from * 100) + '–' + Math.round(b.to * 100) + '%, it averaged ' + fmtPct(b.mean_predicted) + ' and the observed rate was ' + fmtPct(b.observed) + ' (95% interval ' + fmtPct(b.wilson_low) + ' to ' + fmtPct(b.wilson_high) + '). The model’s average falls outside that interval.',
          implication: 'Read probabilities in this band with that bias in mind until the sample grows.', key: 'band:' + b.from + '-' + b.to, magnitude: Math.abs(gap)
        }, ctx));
      });
      var M = L.market && L.market.moneyline;
      /* the audit's own sample state decides: a TOO_EARLY comparison is a
         count, not a finding */
      if (M && M.n >= T.min_market_n && M.sample_state && M.sample_state !== 'TOO_EARLY' && isNum(M.model_brier) && isNum(M.market_brier) && M.model_brier > M.market_brier) {
        var dB = C.round(M.model_brier - M.market_brier, 4);
        out.push(reliabilitySignal(d, 'behind_market', {
          headline: d.label + ': Brier score ' + M.model_brier + ' vs the market’s ' + M.market_brier + ' on the same ' + M.n + ' games',
          stat: { measure: 'Brier score, winner (lower is better)', model: M.model_brier, market: M.market_brier, difference: dB, n: M.n, sample_state: M.sample_state },
          summary: 'On the same ' + M.n + ' verified games the de-vigged pregame market forecast the winner better than the model (Brier ' + M.market_brier + ' vs ' + M.model_brier + '). Sample state: ' + lc(M.sample_state || 'unknown').replace(/_/g, ' ') + '.',
          implication: 'A model–market disagreement for this model starts from a record of the market being more accurate.', key: 'behind_market', magnitude: Math.min(10, dB * 400)
        }, ctx));
      }
      if (d.serving && d.serving.live_graded === 0 && d.serving.version) {
        out.push(reliabilitySignal(d, 'no_live_record', {
          headline: d.label + ': the version now serving (' + d.serving.version + ') has no graded live games yet',
          stat: { measure: 'graded live games for the serving version', n: 0, version: d.serving.version },
          summary: 'Every live statistic on file belongs to an earlier version. The serving version’s live record starts at zero; its backtest is the only evidence for it so far.',
          implication: 'Treat live performance figures as describing the earlier version.', key: 'no_live:' + d.serving.version, magnitude: 3
        }, ctx));
      }
    });
    return out;
  };
  function reliabilitySignal(d, sub, x, ctx) {
    var checks = [check('audit_on_file', !!d.source, d.source), check('sample_reported', x.stat && x.stat.n !== undefined, x.stat && x.stat.n), check('window_reported', !!(d.live && d.live.window), d.live && d.live.window)];
    var payload = {
      category: 'MODEL_RELIABILITY_WARNING', subtype: sub, sport: d.sport, league: d.sport, season: null, event_kind: 'model',
      subject: { kind: 'model', key: 'model:' + d.model_key, label: d.label },
      event: { key: null, label: null, at: null },
      teams: [], market_type: 'moneyline',
      outcome: { id: 'winner', label: 'game winner forecasts', definition: 'graded pregame winner forecasts' },
      identity: { c: 'MODEL_RELIABILITY_WARNING', m: d.model_key, sub: sub, k: x.key, audit: d.evaluated_at },
      headline: x.headline,
      values: { unit: 'audit', previous: { value: null, display: null, at: null }, current: { value: x.stat.value_pp !== undefined ? x.stat.value_pp : x.stat.difference !== undefined ? x.stat.difference : x.stat.n, display: null, at: iso(d.evaluated_at) }, change_pp: x.stat.value_pp !== undefined ? x.stat.value_pp : null, change_display: x.stat.value_pp !== undefined ? fmtPP(x.stat.value_pp) : null, statistic: x.stat },
      model: { id: d.model_key, version: d.live && d.live.version || null, label: d.label },
      timestamps: { event_at: null, source_published_at: iso(d.evaluated_at), calculated_at: iso(d.evaluated_at), recorded_at: iso(d.evaluated_at), detected_at: iso(ctx.now) },
      evidence: { class: 'OBSERVED', label: E.EVIDENCE.OBSERVED.label, means: E.EVIDENCE.OBSERVED.means, summary: x.summary, items: [{ kind: 'audit', text: 'Evaluation window ' + (d.live && d.live.window ? when(d.live.window.from) + ' to ' + when(d.live.window.to) : 'unknown'), verified: true, at: iso(d.evaluated_at) }], attribution: x.implication },
      research_implication: x.implication,
      verification: verification(checks), quality: { flags: [] }, reliability: { grade: d.grade || null },
      sources: [{ id: 'audit', label: 'EdgeDesk model audit', ref: d.source, records: [d.evaluated_at] }],
      links: { research: null, dna: '#signals/dna/' + d.model_key },
      relevance: 'Applies to every forecast this model makes until the audit changes.',
      summary: x.summary
    };
    return finish(payload, { abs_change_pp: x.magnitude, full_scale_pp: 10, rarity: null, evidence_class: 'OBSERVED', source_at: d.evaluated_at, reliability_grade: d.grade || null, season_open: true, flags: [] }, ctx);
  }

  /* ======================================================= data quality
     sources: [{ id, label, sport, state ('ok'|'stale'|'failed'|'limited'),
                 generated_at, max_age_minutes, note, ref }] */
  E.dataQuality = function (sources, ctx) {
    ctx = ctx || {};
    var out = [];
    (sources || []).forEach(function (s) {
      if (!s) return;
      var age = minutesBetween(s.generated_at, ctx.now);
      var stale = age !== null && s.max_age_minutes && age > s.max_age_minutes;
      var bad = s.state && s.state !== 'ok';
      if (!stale && !bad && age !== null) return;
      var issue = age === null ? 'time_unknown' : (bad ? s.state : 'stale');
      var ageText = age === null ? 'of unknown age' : C.fmt.age(age);
      var checks = [check('source_read', true, s.ref), check('age_measured', age !== null, age === null ? 'no generated_at' : 'generated_at ' + iso(s.generated_at))];
      var payload = {
        category: 'DATA_QUALITY_WARNING', subtype: issue, sport: s.sport || 'all', league: s.sport || 'all', season: null, event_kind: 'source',
        subject: { kind: 'source', key: 'source:' + s.id, label: s.label },
        event: { key: null, label: null, at: null }, teams: [], market_type: null,
        outcome: { id: 'freshness', label: s.label + ' freshness', definition: 'age of the newest record against its refresh window' },
        identity: { c: 'DATA_QUALITY_WARNING', src: s.id, issue: issue, gen: iso(s.generated_at) },
        /* stable words: the age itself is shown live by the reader from the
           timestamps, so the same stale record keeps the same version */
        headline: s.label + (issue === 'stale' ? ' has not refreshed since ' + when(s.generated_at) + ' (refresh window ' + Math.round(s.max_age_minutes / 60 * 10) / 10 + ' h)' : (issue === 'time_unknown' ? ' carries no generation time' : ' reports ' + issue)),
        values: { unit: 'minutes', previous: { value: s.max_age_minutes || null, display: s.max_age_minutes ? s.max_age_minutes + ' min window' : null, at: null }, current: { value: null, display: null, at: iso(s.generated_at), age_minutes: age === null ? null : Math.round(age) }, change_pp: null, change_display: null },
        model: { id: null, version: null },
        timestamps: { event_at: null, source_published_at: iso(s.generated_at), calculated_at: null, recorded_at: iso(s.generated_at), detected_at: iso(ctx.now) },
        evidence: { class: 'OBSERVED', label: E.EVIDENCE.OBSERVED.label, means: E.EVIDENCE.OBSERVED.means, summary: (s.note || (s.label + ' was last generated ' + (s.generated_at ? when(s.generated_at) : 'at an unknown time') + '.')) + ' Signals that read it are scored down for freshness until it recovers.', items: [], attribution: 'A stale source is never shown as live.' },
        verification: verification(checks), quality: { flags: age === null ? ['SOURCE_TIME_UNKNOWN'] : [], age_minutes: age === null ? null : Math.round(age) }, reliability: { grade: null },
        sources: [{ id: s.id, label: s.label, ref: s.ref || null, records: [iso(s.generated_at)] }],
        links: {}, relevance: 'Affects every signal that reads this source.',
        summary: s.label + ' was last generated ' + (s.generated_at ? when(s.generated_at) : 'at an unknown time') + '.'
      };
      out.push(finish(payload, { abs_change_pp: age === null ? 5 : Math.min(10, (age - (s.max_age_minutes || 0)) / 60), full_scale_pp: 10, rarity: null, evidence_class: 'OBSERVED', source_at: ctx.now, reliability_grade: null, season_open: true, flags: payload.quality.flags }, ctx));
    });
    return out;
  };

  /* ===================================================== consensus breaker
     refs: [{ id, label, group, p_home, at, version, kind }]. `group` names
     the shared inputs: two references in one group are not independent
     opinions. No consensus number is computed: no ensemble of these sources
     has been validated out of sample (METHODOLOGY.md §6). */
  E.consensus = function (game, refs) {
    var ok = (refs || []).filter(function (r) { return r && probOk(r.p_home); });
    if (!ok.length) return { available: false, reason: 'no compatible forecasts' };
    var ps = ok.map(function (r) { return r.p_home; });
    var lo = Math.min.apply(null, ps), hi = Math.max.apply(null, ps);
    var groups = {};
    ok.forEach(function (r) { (groups[r.group || r.id] = groups[r.group || r.id] || []).push(r.id); });
    var shared = Object.keys(groups).filter(function (g) { return groups[g].length > 1; });
    return {
      available: true,
      outcome: (game && game.home ? game.home.name : 'home') + ' win',
      references: ok.map(function (r) { return { id: r.id, label: r.label, kind: r.kind || null, group: r.group || r.id, p_home: C.round(r.p_home, 4), display: fmtPct(r.p_home), at: iso(r.at), version: r.version || null }; }),
      range: { lo: C.round(lo, 4), hi: C.round(hi, 4), width_pp: C.round(100 * (hi - lo), 1) },
      independent_groups: Object.keys(groups).length,
      correlation_note: shared.length ? 'References in the same group (' + shared.join(', ') + ') share inputs and are not independent opinions.' : 'Each reference is its own group; market references still share public information.',
      consensus: null,
      consensus_note: 'No consensus number is shown: no combination of these sources has been validated out of sample, so an average would be a claim EdgeDesk cannot support.'
    };
  };

  /* ========================================================= update rules
     Does a re-evaluation of an existing signal (same key) deserve a new
     version? A corrected source or a changed verification always does; for
     a divergence, a gap that moved less than 2 pp, or a fresher capture of
     the same price, does not. */
  E.materialUpdate = function (prev, next) {
    if (!prev) return { update: true, reason: 'initial' };
    if (!next) return { update: false, reason: 'nothing new' };
    if (prev.version_hash === next.version_hash) return { update: false, reason: 'identical' };
    if ((prev.verification && prev.verification.state) !== (next.verification && next.verification.state)) return { update: true, reason: 'verification changed' };
    if (prev.engine_version !== next.engine_version || prev.spec_version !== next.spec_version) return { update: true, reason: 'methodology version changed' };
    if (next.category === 'MARKET_DIVERGENCE') {
      var a = prev.values && prev.values.change_pp, b = next.values && next.values.change_pp;
      if (isNum(a) && isNum(b) && Math.abs(a - b) < 2) return { update: false, reason: 'gap moved less than 2 pp' };
      return { update: true, reason: 'gap moved' };
    }
    if (next.category === 'DATA_QUALITY_WARNING') return { update: false, reason: 'the same stale record' };
    return { update: true, reason: 'evidence or scoring changed' };
  };

  /* ===================================================== feed projections */
  /* the columns the database stores beside the payload (for filters, sorts
     and cursors), derived here so the worker and the tests agree */
  E.rowOf = function (p) {
    return {
      signal_key: p.signal_key, version_hash: p.version_hash, category: p.category, subtype: p.subtype || null,
      sport: p.sport, league: p.league, season: p.season === null || p.season === undefined ? null : String(p.season),
      event_kind: p.event_kind, subject_key: p.subject.key, subject_label: p.subject.label, outcome_id: p.outcome.id,
      event_key: p.event.key || null, event_at: p.event.at || null, teams: p.teams || [], market_type: p.market_type || null,
      headline: p.headline, public_headline: p.public_headline, change_pp: isNum(p.values && p.values.change_pp) ? p.values.change_pp : null,
      evidence_class: p.evidence.class, evidence_rank: E.EVIDENCE[p.evidence.class] ? E.EVIDENCE[p.evidence.class].rank : 0,
      verification_state: p.verification.state, score: p.score.total, label: p.score.label,
      rarity: p.values && p.values.distribution ? p.values.distribution.rarity : null,
      reliability_grade: p.reliability ? p.reliability.grade : null,
      model_version: p.model ? p.model.version || null : null,
      source_at: p.timestamps.source_published_at || null,
      fixture: !!p.fixture
    };
  };

  return E;
});
