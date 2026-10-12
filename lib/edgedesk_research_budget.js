/*__EDBUDGET_START__*/
/* ===========================================================================
   EdgeDesk RESEARCH BUDGET — research on demand, at a cost that is known
   before it is spent.

   ONE FILE, TWO HOSTS (Node requires it; tools/presentation/inline.js copies
   the block into supabase/functions/edgedesk_ai/index.ts).

   THREE LEVELS
     L1 FAST SCREEN   schedules, existing projections, cached quotes, data
                      checks. No external request, no model call.
     L2 TARGETED      the few most interesting discrepancies: availability,
                      lineups, matchups, contradictory evidence — from free and
                      official sources first, under a request budget.
     L3 DEEP          the candidates that survive: research, quantitative
                      re-check, sensitivity, the adversarial audit. Paid search
                      only when a provider is configured AND the operator
                      authorised paid research (EDGEDESK_RESEARCH_PAID_OK=1).
   selectLevel() picks the lowest level that can answer the question, from
   the question, what is on file, the potential value and the expected cost.

   SAFEGUARDS (state is per isolate unless a persistent ledger is wired by the
   host: supabase/research_intel.sql research_usage_claim())
     - per-provider daily and monthly quotas, and a per-user daily cap;
     - a depth budget per level (requests, paid calls, wall time, tokens);
     - single flight: an identical request already running is joined, not
       bought twice; a recently answered one is served from cache;
     - conditional refresh by topic (availability near kickoff refreshes
       faster than a season statistic);
     - a circuit breaker per provider (consecutive failures open it with
       back-off); an open breaker falls back to cached data;
     - a usage log with a cost estimate for every call, cached or not.
   Nothing here makes a request: the host passes the function that does.
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDBUDGET = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var VERSION = 'edgedesk_research_budget_v1';
  var LEVELS = {
    L1: { level: 'L1', label: 'fast screen', requests: 0, paid_calls: 0, ms: 0, tokens: 0, candidates: 0, games: Infinity, ai_calls: 0 },
    L2: { level: 'L2', label: 'targeted research', requests: 4, paid_calls: 0, ms: 2500, tokens: 0, candidates: 0, games: 5, ai_calls: 0 },
    L3: { level: 'L3', label: 'deep adversarial investigation', requests: 8, paid_calls: 2, ms: 6000, tokens: 1500, candidates: 3, games: 5, ai_calls: 1 }
  };
  /* Provider registry: cost per call in USD (an ESTIMATE, labelled so), quotas, freshness. Paid
     providers are listed so the cost of switching them on is visible; none is on by default. */
  var PROVIDERS = {
    signals:            { label: 'EdgeDesk captured prices', cost_usd: 0, paid: false, daily: Infinity, monthly: Infinity, per_user_daily: Infinity },
    nflverse_injuries:  { label: 'nflverse injury report (official, keyless)', cost_usd: 0, paid: false, daily: 500, monthly: 10000, per_user_daily: 60 },
    nfl_metrics:        { label: 'EdgeDesk NFL metrics build (injuries, depth charts)', cost_usd: 0, paid: false, daily: Infinity, monthly: Infinity, per_user_daily: Infinity },
    mlb_cards:          { label: 'EdgeDesk MLB game cards (probable starters)', cost_usd: 0, paid: false, daily: Infinity, monthly: Infinity, per_user_daily: Infinity },
    desk_notes:         { label: 'EdgeDesk desk notes (recorded by a person, with a source)', cost_usd: 0, paid: false, daily: Infinity, monthly: Infinity, per_user_daily: Infinity },
    open_meteo:         { label: 'open-meteo forecast (keyless)', cost_usd: 0, paid: false, daily: 2000, monthly: 40000, per_user_daily: 100 },
    brave_search:       { label: 'Brave Search API (web)', cost_usd: 0.005, cost_basis: 'estimate; check the Brave plan in use', paid: true, daily: 200, monthly: 2000, per_user_daily: 10 },
    perplexity_sonar:   { label: 'Perplexity Sonar API (search-grounded answers)', cost_usd: 0.008, cost_basis: 'estimate from secondary sources (Oct 2026): ~$1/M tokens plus $5–12 per 1,000 requests by search context; the official rate card was not reachable', paid: true, daily: 100, monthly: 1000, per_user_daily: 5 },
    /* Phase 4 search adapters (lib/edgedesk_providers.js); cost_usd is the per-call ESTIMATE the ledger logs — the
       actual cost is computed from each response's usage and reported beside it */
    claude_web_search:  { label: 'Claude web search (official and credible domains)', cost_usd: 0.084, cost_basis: 'estimate: 3 searches ($0.03) + ~10K input and ~700 output tokens on Opus 5.5 list prices; the actual cost is read from each response', paid: true, daily: 300, monthly: 6000, per_user_daily: 5 },
    perplexity_search:  { label: 'Perplexity Search API (raw results)', cost_usd: 0.010, cost_basis: 'estimate: $5 per 1,000 requests as quoted from the pricing page, two queries counted as two to be safe; schema unverified', paid: true, daily: 500, monthly: 10000, per_user_daily: 10 },
    anthropic_narration:{ label: 'Claude narration (optional prose over verified numbers)', cost_usd: 0.004, cost_basis: 'estimate per ~1,500-token turn', paid: true, daily: 2000, monthly: 30000, per_user_daily: 60 }
  };
  /* minutes a cached answer stays fresh, by topic; availability tightens near kickoff */
  var TOPIC_TTL_MIN = { availability: 60, starter: 60, lineup: 45, weather: 120, market: 15, statistic: 720, scheme: 1440, coaching: 1440, venue: 10080, news: 30, other: 240 };

  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  function str(v) { return v == null ? '' : String(v); }
  function dayKey(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function monthKey(ms) { return new Date(ms).toISOString().slice(0, 7); }

  /** The research level a question needs. o: { intent, question, candidates, data_available, potential_value, paid_authorized } */
  function selectLevel(o) {
    o = o || {};
    var q = str(o.question).toLowerCase();
    var deep = /\b(research|investigat\w*|deep|adversarial|audit|dig into|why does (the )?model|matchup advantage|explain the disagreement)\b/.test(q);
    var screen = /\b(slate|list|which games|schedule|what('s| is) on|coverage|couldn'?t be scanned)\b/.test(q) && !deep;
    var why = [], lvl;
    if (o.intent === 'COVERAGE' || o.intent === 'OUTAGE' || o.intent === 'BETS') { lvl = 'L1'; why.push('the answer is on file; no research changes it'); }
    else if (!o.data_available) { lvl = 'L1'; why.push('no priced market is on file, so research could not produce an opportunity'); }
    else if (screen) { lvl = 'L1'; why.push('a screening question'); }
    else if (deep || o.intent === 'RESEARCH_SLATE') { lvl = 'L3'; why.push('the question asks for an investigation and an audit'); }
    else if ((num(o.candidates) || 0) === 0) { lvl = 'L1'; why.push('nothing on the board clears the screen, so deeper research has nothing to test'); }
    else if (o.intent === 'SCAN') { lvl = 'L3'; why.push('a best-bet answer is published only after the top candidates survive research and the audit'); }
    else { lvl = 'L2'; why.push('a targeted check of the leading discrepancies'); }
    var b = Object.assign({}, LEVELS[lvl]);
    if (lvl === 'L3' && !o.paid_authorized) { b.paid_calls = 0; why.push('paid research is not authorised, so L3 uses free and official sources only'); }
    return { level: lvl, budget: b, why: why };
  }

  /** A ledger: quotas, single flight, cache, breaker, usage. o: { now, providers, paid_authorized, configured } */
  function ledger(o) {
    o = o || {};
    var clock = typeof o.now === 'function' ? o.now : function () { return num(o.now) != null ? num(o.now) : Date.now(); };
    var reg = Object.assign({}, PROVIDERS, o.providers || {});
    var counts = {}, flights = {}, cache = {}, breakers = {}, usage = [];
    var turn = { requests: 0, paid_calls: 0, tokens: 0, started: clock() }, turnStart = 0;
    function count(p, key) { var c = counts[p] = counts[p] || {}; return c[key] || 0; }
    function bump(p, key) { var c = counts[p] = counts[p] || {}; c[key] = (c[key] || 0) + 1; }
    function breaker(p) { return breakers[p] = breakers[p] || { failures: 0, open_until: 0, opened: 0 }; }
    /* the log is bounded: a long-lived instance keeps the newest entries, never an unbounded history */
    function log(e) { usage.push(Object.assign({ at: new Date(clock()).toISOString() }, e)); if (usage.length > 1000) { usage.splice(0, 500); turnStart = Math.max(0, turnStart - 500); } }

    /** May this call be made now? → { ok, why } */
    function allow(p, user, budget) {
      var P = reg[p];
      if (!P) return { ok: false, why: 'unknown provider ' + p };
      if (P.paid && !o.paid_authorized) return { ok: false, why: P.label + ' is a paid provider and paid research is not authorised (EDGEDESK_RESEARCH_PAID_OK)' };
      if (o.configured && o.configured[p] === false) return { ok: false, why: P.label + ' is not configured' };
      var b = breaker(p), t = clock();
      if (b.open_until > t) return { ok: false, why: P.label + ' circuit breaker is open for ' + Math.ceil((b.open_until - t) / 1000) + 's after ' + b.failures + ' consecutive failures' };
      var d = dayKey(t), mo = monthKey(t);
      if (count(p, 'd:' + d) >= P.daily) return { ok: false, why: P.label + ' daily quota (' + P.daily + ') is spent' };
      if (count(p, 'm:' + mo) >= P.monthly) return { ok: false, why: P.label + ' monthly quota (' + P.monthly + ') is spent' };
      if (user && count(p, 'u:' + user + ':' + d) >= P.per_user_daily) return { ok: false, why: 'your daily research allowance for ' + P.label + ' (' + P.per_user_daily + ') is spent' };
      if (budget) {
        if (turn.requests >= budget.requests) return { ok: false, why: 'the ' + budget.level + ' request budget (' + budget.requests + ') is spent' };
        if (P.paid && turn.paid_calls >= budget.paid_calls) return { ok: false, why: 'the ' + budget.level + ' paid-call budget (' + budget.paid_calls + ') is spent' };
        if (budget.ms && clock() - turn.started > budget.ms) return { ok: false, why: 'the ' + budget.level + ' time budget (' + budget.ms + ' ms) is spent' };
      }
      return { ok: true, why: null };
    }
    function fresh(key, topic) {
      var h = cache[key]; if (!h) return null;
      var ttl = (TOPIC_TTL_MIN[topic] || TOPIC_TTL_MIN.other) * 60000;
      return clock() - h.at <= ttl ? h : null;
    }
    /**
     * Run fn() under every safeguard. o2: { provider, key, topic, user, budget, timeout_ms }
     * → Promise<{ ok, value, cached, joined, why, stale }>. A refused or failed call falls back
     * to the last cached value (labelled stale) when there is one.
     */
    function call(o2, fn) {
      var p = o2.provider, key = p + '|' + str(o2.key), P = reg[p] || { label: p, cost_usd: 0 };
      var hit = fresh(key, o2.topic);
      if (hit) { log({ provider: p, key: o2.key, outcome: 'CACHE', cached: true, cost_usd: 0 }); return Promise.resolve({ ok: true, value: hit.value, cached: true, joined: false, why: null, stale: false, retrieved_at: new Date(hit.at).toISOString() }); }
      if (flights[key]) { log({ provider: p, key: o2.key, outcome: 'JOINED', cached: false, cost_usd: 0 }); return flights[key].then(function (r) { return Object.assign({}, r, { joined: true }); }); }
      var a = allow(p, o2.user, o2.budget);
      if (!a.ok) {
        var old = cache[key];
        log({ provider: p, key: o2.key, outcome: 'DENIED', why: a.why, cached: !!old, cost_usd: 0 });
        return Promise.resolve({ ok: !!old, value: old ? old.value : null, cached: !!old, joined: false, why: a.why, stale: !!old, retrieved_at: old ? new Date(old.at).toISOString() : null });
      }
      var t = clock(), d = dayKey(t), mo = monthKey(t);
      bump(p, 'd:' + d); bump(p, 'm:' + mo); if (o2.user) bump(p, 'u:' + o2.user + ':' + d);
      turn.requests++; if (P.paid) turn.paid_calls++;
      var timeout = num(o2.timeout_ms) || 4000;
      var run = new Promise(function (resolve) {
        var done = false, timer = setTimeout(function () { if (!done) { done = true; resolve({ ok: false, error: 'timed out after ' + timeout + ' ms' }); } }, timeout);
        Promise.resolve().then(fn).then(function (v) { if (!done) { done = true; clearTimeout(timer); resolve({ ok: true, value: v }); } }, function (e) { if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, error: str(e && e.message || e).slice(0, 160) }); } });
      }).then(function (r) {
        delete flights[key];
        var b = breaker(p);
        if (r.ok) { b.failures = 0; cache[key] = { at: clock(), value: r.value }; log({ provider: p, key: o2.key, outcome: 'OK', cached: false, cost_usd: P.cost_usd || 0, paid: !!P.paid }); return { ok: true, value: r.value, cached: false, joined: false, why: null, stale: false, retrieved_at: new Date(clock()).toISOString() }; }
        b.failures++;
        if (b.failures >= 3) { var back = Math.min(30 * 60000, 60000 * Math.pow(2, b.failures - 3)); b.open_until = clock() + back; b.opened++; }
        var old2 = cache[key];
        log({ provider: p, key: o2.key, outcome: 'ERROR', why: r.error, cached: !!old2, cost_usd: P.cost_usd || 0, paid: !!P.paid });
        return { ok: !!old2, value: old2 ? old2.value : null, cached: !!old2, joined: false, why: r.error, stale: !!old2, retrieved_at: old2 ? new Date(old2.at).toISOString() : null };
      });
      flights[key] = run;
      return run;
    }
    function spendTokens(n, budget) { if (budget && turn.tokens + n > budget.tokens) return false; turn.tokens += n; return true; }
    /* o.turn: only this turn's calls (the ledger outlives a turn; its cache and breakers are shared, its cost line is not) */
    function report(o) {
      var rows = o && o.turn ? usage.slice(turnStart) : usage;
      var cost = rows.reduce(function (s, e) { return s + (e.cost_usd || 0); }, 0);
      var by = {}; rows.forEach(function (e) { var k = e.provider; by[k] = by[k] || { calls: 0, cached: 0, denied: 0, errors: 0, joined: 0, cost_usd: 0 }; if (e.outcome === 'OK') by[k].calls++; if (e.outcome === 'CACHE') by[k].cached++; if (e.outcome === 'DENIED') by[k].denied++; if (e.outcome === 'ERROR') by[k].errors++; if (e.outcome === 'JOINED') by[k].joined++; by[k].cost_usd += e.cost_usd || 0; });
      return { schema: VERSION, turn: { requests: turn.requests, paid_calls: turn.paid_calls, tokens: turn.tokens }, by_provider: by, cost_estimate_usd: Math.round(cost * 10000) / 10000, cost_basis: 'per-call estimates in PROVIDERS; free providers cost nothing', scope: o && o.turn ? 'turn' : 'ledger', log: rows.slice(-60) };
    }
    function newTurn() { turn = { requests: 0, paid_calls: 0, tokens: 0, started: clock() }; turnStart = usage.length; }
    return { allow: allow, call: call, spendTokens: spendTokens, report: report, newTurn: newTurn, breaker: breaker, cache: cache, registry: reg };
  }

  return { VERSION: VERSION, LEVELS: LEVELS, PROVIDERS: PROVIDERS, TOPIC_TTL_MIN: TOPIC_TTL_MIN, selectLevel: selectLevel, ledger: ledger };
});
/*__EDBUDGET_END__*/
