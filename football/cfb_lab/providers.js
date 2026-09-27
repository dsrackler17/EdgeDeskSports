/* ============================================================================
   EdgeDesk CFB — external provider policy: timeouts, bounded retries, circuit
   breakers and schema validation (node).   docs/cfb-production/PROVIDERS.md

   Assume every provider fails. This file decides, the same way everywhere:

     POLICIES              per provider: importance (CRITICAL / HIGH_VALUE /
                           OPTIONAL), timeout, retries, rate limit, expected
                           latency, required fields, fallback, stale threshold
     classify(err)         TIMEOUT / NETWORK / RATE_LIMIT / TRANSIENT (retried)
                           vs AUTH / PERMANENT / SCHEMA / UNKNOWN (never retried)
     withRetry(fn, p)      bounded exponential backoff with jitter; only the
                           retryable classes; Retry-After honoured and bounded
     Breaker               CLOSED -> OPEN (after N consecutive failures) ->
                           HALF_OPEN (one trial after the cooldown) -> CLOSED;
                           state is a plain object, persisted by the caller
     fetchJson/fetchText   one call = timeout + retry + breaker + classification
     validate*()           required-field contracts for ESPN, The Odds API, the
                           CFBD line ledger and the cfbfastR schedule. A missing
                           required field REJECTS the element and is logged as a
                           schema incident; nothing missing is ever turned into 0.
   ========================================================================== */
'use strict';

const ERROR = ['TIMEOUT', 'NETWORK', 'RATE_LIMIT', 'TRANSIENT', 'AUTH', 'PERMANENT', 'SCHEMA', 'UNKNOWN'];
const RETRYABLE = new Set(['TIMEOUT', 'NETWORK', 'RATE_LIMIT', 'TRANSIENT']);

/* The provider register. Numbers are operational policy, not model thresholds. */
const POLICIES = {
  espn_scoreboard: {
    label: 'ESPN public scoreboard', importance: 'CRITICAL', timeout_ms: 30000, retries: 2, backoff_ms: [1000, 8000],
    rate_limit: 'unpublished; the lab makes <= 12 calls per hour (one per ET date)', expected_latency_ms: 1500,
    required: ['events[]', 'events[].id', 'competitions[0].date|events[].date', 'competitions[0].status.type.{state,completed,name}',
      'competitions[0].competitors[] with exactly one home and one away', 'competitors[].team.abbreviation (odds orientation)',
      'competitors[].score on a completed game'],
    uses: ['pregame spread/total/moneyline (one book)', 'declared close', 'finals, overtime, postponed/canceled'],
    fallback: 'results: cfbfastR schedule, then the football record file; odds: the CFBD ledger and Odds API quotes',
    stale_h: { odds: '6 h within 48 h of kickoff, else 36 h', schedule: 26 }, breaker: { failures: 3, cooldown_min: 60 } },
  cfbfastr_schedule: {
    label: 'cfbfastR schedule CSV (GitHub raw)', importance: 'HIGH_VALUE', timeout_ms: 60000, retries: 2, backoff_ms: [2000, 16000],
    rate_limit: 'GitHub raw: unauthenticated, generous; one call per hour', expected_latency_ms: 3000,
    required: ['game_id', 'season', 'completed', 'home_points', 'away_points', 'home_team', 'away_team'],
    uses: ['the second result source (a FINAL needs every source that carries the game to agree)'],
    fallback: 'ESPN alone when cfbfastR does not carry the game; nothing is settled on a disagreement',
    stale_h: { results: 48 }, breaker: { failures: 3, cooldown_min: 120 } },
  odds_api: {
    label: 'The Odds API (via the Supabase capture function)', importance: 'CRITICAL', timeout_ms: 20000, retries: 2, backoff_ms: [1000, 8000],
    rate_limit: 'paid quota; x-requests-remaining is reported every run; 429 = quota exhausted (backoff, then the breaker opens)', expected_latency_ms: 1200,
    required: ['id', 'commence_time', 'home_team', 'away_team', 'bookmakers[].key', 'bookmakers[].markets[].key',
      'markets[].outcomes[].name', 'markets[].outcomes[].price (decimal > 1)', 'spreads/totals: outcomes[].point (a number, never null)'],
    uses: ['per-sportsbook spread, total and moneyline with provider last_update'],
    fallback: 'ESPN (one book) and the CFBD consensus; with neither, the market is MARKET_STALE and no BET is possible',
    stale_h: { odds: '6 h within 48 h of kickoff, else 36 h; 3 h for a BET' }, breaker: { failures: 3, cooldown_min: 30 } },
  supabase_rest: {
    label: 'Supabase PostgREST (lab mirror + Odds API pull)', importance: 'HIGH_VALUE', timeout_ms: 30000, retries: 3, backoff_ms: [1000, 10000],
    rate_limit: 'project limits; the lab sends <= 500 rows per request', expected_latency_ms: 800,
    required: ['cfb_lab_market_quotes rows with the ledger columns'],
    uses: ['insert-only mirror of the ledger', 'Odds API quotes captured by the capture function'],
    fallback: 'the repository ledger is complete on its own; the mirror and pull are skipped and reported',
    stale_h: { odds: 'as odds_api' }, breaker: { failures: 3, cooldown_min: 30 } },
  cfbd_api: {
    label: 'CollegeFootballData API (V2 weekly pipeline, Python)', importance: 'CRITICAL', timeout_ms: 60000, retries: 3, backoff_ms: [2000, 30000],
    rate_limit: 'API key tier; the weekly job batches by week', expected_latency_ms: 2500,
    required: ['games: id, season, week, home/away ids, start_date', 'plays: game_id, offense/defense ids, down, distance, yards, ppa', 'lines: game_id, provider, spread, overUnder'],
    uses: ['PBP, schedule, rosters, the consensus line ledger'], owner: 'football/cfb_v2/research/v2/weekly (another hardening scope)',
    fallback: 'hold the weekly update; never advance team state on missing PBP', stale_h: { pbp: 192 }, breaker: { failures: 3, cooldown_min: 60 } },
  availability_sources: {
    label: 'Official availability reports (football/availability)', importance: 'HIGH_VALUE', timeout_ms: 30000, retries: 1, backoff_ms: [1000, 4000],
    rate_limit: 'per conference site; fetched weekly/daily', expected_latency_ms: 3000,
    required: ['team', 'as_of', 'player rows with status'], uses: ['QB and injury certainty'],
    fallback: 'last known status, marked stale; never assumed healthy', stale_h: { injury: 72, qb: 72 }, breaker: { failures: 3, cooldown_min: 240 } },
  weather: {
    label: 'Venue forecast (football/venues)', importance: 'OPTIONAL', timeout_ms: 20000, retries: 1, backoff_ms: [1000, 4000],
    rate_limit: 'free tier; daily', expected_latency_ms: 1000, required: ['venue', 'observed_at', 'forecast hours'],
    uses: ['context only'], fallback: 'omit; never blocks the system', stale_h: { weather: 12 }, breaker: { failures: 5, cooldown_min: 240 } },
};

/* ---------------------------------------------------- classification */
class ProviderError extends Error {
  constructor(message, cls, extra) { super(message); this.name = 'ProviderError'; this.class = cls; Object.assign(this, extra || {}); }
}
class SchemaError extends ProviderError {
  constructor(message, problems) { super(message, 'SCHEMA', { problems: problems || [] }); this.name = 'SchemaError'; }
}
function classify(e) {
  if (e == null) return 'UNKNOWN';
  if (typeof e === 'number') return classifyStatus(e);
  if (e.class && ERROR.includes(e.class)) return e.class;
  if (e.name === 'SchemaError') return 'SCHEMA';
  if (Number.isFinite(e.status)) return classifyStatus(e.status);
  const m = String(e.message || e);
  if (e.name === 'AbortError' || e.name === 'TimeoutError' || /abort|timed? ?out/i.test(m)) return 'TIMEOUT';
  const hs = /HTTP (\d{3})/.exec(m); if (hs) return classifyStatus(Number(hs[1]));
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network/i.test(m)) return 'NETWORK';
  if (/is not valid JSON|Unexpected token|JSON/i.test(m)) return 'SCHEMA';
  return 'UNKNOWN';
}
function classifyStatus(s) {
  if (s === 429) return 'RATE_LIMIT';
  if (s === 408 || s === 425 || (s >= 500 && s <= 599)) return 'TRANSIENT';
  if (s === 401 || s === 403) return 'AUTH';
  if (s >= 400 && s <= 499) return 'PERMANENT';
  return 'UNKNOWN';
}
function retryable(cls) { return RETRYABLE.has(cls); }

/* ------------------------------------------------------------ retries */
/* Bounded exponential backoff with jitter: attempt i (0-based) waits
   min(max, base * 2^i) scaled into [50%, 100%] by jitter. RATE_LIMIT honours a
   Retry-After (seconds) but never beyond the policy's max. */
function backoffMs(i, policy, rand, retryAfterS) {
  const [base, max] = (policy && policy.backoff_ms) || [1000, 8000];
  if (Number.isFinite(retryAfterS) && retryAfterS >= 0) return Math.min(max, retryAfterS * 1000);
  const d = Math.min(max, base * Math.pow(2, i));
  return Math.round(d * (0.5 + 0.5 * (rand ? rand() : Math.random())));
}
async function withRetry(fn, policy, opts) {
  opts = opts || {};
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const retries = policy && Number.isFinite(policy.retries) ? policy.retries : 2;
  const errors = [];
  for (let i = 0; ; i++) {
    try {
      const value = await fn(i);
      return { ok: true, value, attempts: i + 1, errors };
    } catch (e) {
      const cls = classify(e);
      errors.push({ attempt: i + 1, class: cls, message: String(e && e.message || e).slice(0, 240) });
      if (!retryable(cls) || i >= retries) {
        const err = e instanceof Error ? e : new Error(String(e));
        err.class = cls; err.attempts = i + 1; err.errors = errors;
        throw err;
      }
      const wait = backoffMs(i, policy, opts.rand, cls === 'RATE_LIMIT' ? e.retryAfter : undefined);
      errors[errors.length - 1].wait_ms = wait;
      await sleep(wait);
    }
  }
}

/* ------------------------------------------------------ circuit breaker */
/* state: { state, consecutive_failures, opened_at, last_error, last_error_class,
   last_success_at, last_failure_at, calls, failures }. Persist it as JSON. */
function newBreakerState() {
  return { state: 'CLOSED', consecutive_failures: 0, opened_at: null, cooldown_min: null, last_error: null, last_error_class: null,
    last_success_at: null, last_failure_at: null, calls: 0, failures: 0 };
}
class Breaker {
  constructor(name, policy, state) {
    this.name = name;
    this.cfg = Object.assign({ failures: 3, cooldown_min: 30, max_cooldown_min: 24 * 60 }, (policy && policy.breaker) || {});
    this.s = Object.assign(newBreakerState(), state || {});
  }
  /* may we call now? OPEN -> HALF_OPEN once the cooldown passed */
  allow(now) {
    const t = Date.parse(now);
    if (this.s.state === 'OPEN') {
      const cd = (this.s.cooldown_min || this.cfg.cooldown_min) * 60000;
      if (Number.isFinite(t) && t - Date.parse(this.s.opened_at) >= cd) { this.s.state = 'HALF_OPEN'; return true; }
      return false;
    }
    return true;
  }
  success(now) {
    this.s.calls++; this.s.last_success_at = now; this.s.consecutive_failures = 0;
    this.s.state = 'CLOSED'; this.s.opened_at = null; this.s.cooldown_min = null;
  }
  failure(now, err) {
    this.s.calls++; this.s.failures++; this.s.last_failure_at = now;
    this.s.last_error = String(err && err.message || err).slice(0, 240); this.s.last_error_class = classify(err);
    this.s.consecutive_failures++;
    if (this.s.state === 'HALF_OPEN') {
      /* the trial failed: open again, with a doubled (bounded) cooldown */
      this.s.state = 'OPEN'; this.s.opened_at = now;
      this.s.cooldown_min = Math.min(this.cfg.max_cooldown_min, 2 * (this.s.cooldown_min || this.cfg.cooldown_min));
    } else if (this.s.consecutive_failures >= this.cfg.failures) {
      this.s.state = 'OPEN'; this.s.opened_at = now; this.s.cooldown_min = this.cfg.cooldown_min;
    }
  }
  snapshot() { return Object.assign({ provider: this.name }, this.s); }
}

/* One guarded call: breaker -> timeout -> retry -> classification. `call` is
   (signal, attempt) => Promise<value>. Returns
   { ok, value, attempts, class, error, skipped, breaker }. */
async function guarded(name, call, opts) {
  opts = opts || {};
  const policy = opts.policy || POLICIES[name] || {};
  const now = opts.now || new Date().toISOString();
  const br = opts.breaker || new Breaker(name, policy, opts.breakerState);
  if (!br.allow(now)) return { ok: false, skipped: true, class: 'CIRCUIT_OPEN', error: 'circuit OPEN since ' + br.s.opened_at + ' (' + (br.s.last_error_class || 'UNKNOWN') + ': ' + (br.s.last_error || '') + ')', attempts: 0, breaker: br.snapshot() };
  try {
    const r = await withRetry(async (i) => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), policy.timeout_ms || 30000);
      try { return await call(ctl.signal, i); } finally { clearTimeout(timer); }
    }, policy, opts);
    br.success(now);
    return { ok: true, value: r.value, attempts: r.attempts, retries: r.errors, breaker: br.snapshot() };
  } catch (e) {
    br.failure(now, e);
    return { ok: false, class: e.class || classify(e), error: String(e && e.message || e).slice(0, 240), attempts: e.attempts || 1, retries: e.errors || [], breaker: br.snapshot() };
  }
}
async function httpText(url, signal, headers) {
  const res = await fetch(url, { redirect: 'follow', signal, headers: Object.assign({ 'user-agent': 'edgedesk-cfb-lab' }, headers || {}) });
  if (!res.ok) {
    const ra = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
    throw new ProviderError('HTTP ' + res.status, classifyStatus(res.status), { status: res.status, retryAfter: Number.isFinite(ra) ? ra : undefined });
  }
  return res.text();
}

/* ---------------------------------------------------- schema validation */
function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }
function isStr(x) { return typeof x === 'string' && x.trim() !== ''; }
function isTs(x) { return (isStr(x) || isNum(x)) && Number.isFinite(Date.parse(x)); }
function numStr(x) { return isNum(x) || (isStr(x) && /^\s*[+-]?\d+(\.\d+)?\s*$/.test(x)); }

/* ESPN scoreboard: { ok, events (the valid ones), rejected, problems }. A
   payload without events[] is rejected whole. An event missing a required
   field is rejected alone (the others still count). */
function validateEspnScoreboard(json) {
  const out = { provider: 'espn_scoreboard', ok: true, events: [], rejected: [], problems: [] };
  if (!json || typeof json !== 'object' || !Array.isArray(json.events)) { out.ok = false; out.problems.push('payload has no events[] array'); return out; }
  json.events.forEach((ev, i) => {
    const p = [];
    const id = ev && ev.id;
    if (!(isStr(id) || isNum(id))) p.push('event.id missing');
    const comp = ev && Array.isArray(ev.competitions) ? ev.competitions[0] : null;
    if (!comp || typeof comp !== 'object') p.push('competitions[0] missing');
    else {
      if (!isTs(comp.date) && !isTs(ev.date)) p.push('no parseable date');
      const st = comp.status && comp.status.type;
      if (!st || !['pre', 'in', 'post'].includes(st.state)) p.push('status.type.state missing or unknown');
      if (!st || typeof st.completed !== 'boolean') p.push('status.type.completed missing');
      if (!st || !isStr(st.name)) p.push('status.type.name missing');
      const cs = Array.isArray(comp.competitors) ? comp.competitors : [];
      const h = cs.filter((c) => c && c.homeAway === 'home'), a = cs.filter((c) => c && c.homeAway === 'away');
      if (h.length !== 1 || a.length !== 1) p.push('competitors: need exactly one home and one away');
      else {
        [['home', h[0]], ['away', a[0]]].forEach(([s, c]) => {
          if (!c.team || !(isStr(c.team.displayName) || isStr(c.team.location))) p.push(s + ' team name missing');
          if ((comp.odds || []).length && !(c.team && isStr(c.team.abbreviation))) p.push(s + ' team abbreviation missing (odds orientation cannot be checked)');
          if (st && st.completed === true && /FINAL/i.test(String(st.name || '')) && !numStr(c.score)) p.push(s + ' score missing on a completed game');
        });
        if (h[0].team && a[0].team && h[0].team.id != null && String(h[0].team.id) === String(a[0].team.id)) p.push('home and away are the same team id');
      }
    }
    if (p.length) out.rejected.push({ index: i, id: id == null ? null : String(id), problems: p });
    else out.events.push(ev);
  });
  if (out.rejected.length) out.problems.push(out.rejected.length + ' event(s) rejected');
  return out;
}

/* The Odds API /odds response (decimal prices). Same shape of verdict; an
   outcome missing `point` on spreads/totals, a non-numeric price, or a
   price <= 1 rejects that MARKET (never a zero line). */
function validateOddsApiEvents(arr) {
  const out = { provider: 'odds_api', ok: true, events: [], rejected: [], problems: [], markets_rejected: 0 };
  if (!Array.isArray(arr)) { out.ok = false; out.problems.push('payload is not an array'); return out; }
  arr.forEach((ev, i) => {
    const p = [];
    if (!ev || !isStr(ev.id)) p.push('id missing');
    if (!ev || !isTs(ev.commence_time)) p.push('commence_time missing or unparseable');
    if (!ev || !isStr(ev.home_team) || !isStr(ev.away_team)) p.push('home_team / away_team missing');
    if (ev && isStr(ev.home_team) && ev.home_team === ev.away_team) p.push('home_team equals away_team');
    if (!ev || !Array.isArray(ev.bookmakers)) p.push('bookmakers[] missing');
    if (p.length) { out.rejected.push({ index: i, id: ev && ev.id ? String(ev.id) : null, problems: p }); return; }
    const books = [];
    ev.bookmakers.forEach((bk) => {
      if (!bk || !isStr(bk.key) || !Array.isArray(bk.markets)) { out.markets_rejected++; out.problems.push(ev.id + ': bookmaker without key or markets'); return; }
      const mk = [];
      bk.markets.forEach((m) => {
        const mp = [];
        if (!m || !['spreads', 'totals', 'h2h'].includes(m.key)) { return; }   /* a market we do not read is ignored, not an error */
        if (!Array.isArray(m.outcomes) || m.outcomes.length < 2) mp.push('fewer than two outcomes');
        else m.outcomes.forEach((o) => {
          if (!o || !isStr(o.name)) mp.push('outcome name missing');
          if (!o || !isNum(o.price) || !(o.price > 1)) mp.push('outcome price missing or not a decimal price > 1');
          if ((m.key === 'spreads' || m.key === 'totals') && (!o || !isNum(o.point))) mp.push('outcome point missing (never read as 0)');
        });
        if (m && m.last_update != null && !isTs(m.last_update)) mp.push('last_update unparseable');
        if (mp.length) { out.markets_rejected++; out.problems.push(ev.id + '/' + bk.key + '/' + m.key + ': ' + [...new Set(mp)].join('; ')); }
        else mk.push(m);
      });
      books.push(Object.assign({}, bk, { markets: mk }));
    });
    out.events.push(Object.assign({}, ev, { bookmakers: books }));
  });
  if (out.rejected.length) out.problems.push(out.rejected.length + ' event(s) rejected');
  return out;
}

/* One row of the V2 pipeline's CFBD line ledger (shadow/<season>/lines.jsonl). */
function validateCfbdLineRow(x) {
  const p = [];
  if (!x || !(isStr(x.game_id) || isNum(x.game_id))) p.push('game_id missing');
  if (!x || !isTs(x.observed_at)) p.push('observed_at missing');
  ['current_home_line', 'open_home_line', 'total_current', 'total_open'].forEach((k) => { if (x && x[k] != null && !isNum(x[k])) p.push(k + ' is not a number'); });
  if (x && x.current_home_line == null && x.total_current == null && x.open_home_line == null && x.total_open == null) p.push('no line at all');
  return p;
}
/* The cfbfastR schedule CSV: the header must carry every required column. */
function validateCfbfastrHeader(text) {
  const head = String(text || '').split('\n')[0] || '';
  const cols = head.split(',').map((c) => c.replace(/^"|"$/g, '').trim());
  return POLICIES.cfbfastr_schedule.required.filter((c) => !cols.includes(c));
}

/* A schema incident, as it is logged in last_run.json and provider_health.json. */
function incident(provider, kind, detail, now) {
  return { at: now || new Date().toISOString(), provider, error_class: kind, detail: Array.isArray(detail) ? detail.slice(0, 20) : detail };
}

module.exports = {
  ERROR, POLICIES, ProviderError, SchemaError, classify, classifyStatus, retryable, backoffMs, withRetry,
  Breaker, newBreakerState, guarded, httpText,
  validateEspnScoreboard, validateOddsApiEvents, validateCfbdLineRow, validateCfbfastrHeader, incident,
};
