/* ============================================================================
   ACTIVE DATA RECOVERY — the one door every football retrieval goes through.

   WHAT WENT WRONG WITHOUT IT. The availability sync reported "276 failed
   source reads" because 138 teams x 2 collectors each hit the same dead
   endpoint 276 times, one request per team, no shared knowledge between them.
   A systematic refusal was counted as 276 independent misfortunes, every one
   of them paid for with a network round trip.

   So this module owns four things nothing else may re-implement:

     1  BOUNDED WORK. Every request has a timeout; a whole recovery run has a
        budget in milliseconds and in requests, and it returns what it has
        when the budget is spent rather than running until something gives up.
     2  DEDUPLICATION. The same URL in flight twice is one request. The same
        HOST answering 403 to the first three calls is a host-level circuit
        breaker, not 138 separate failures.
     3  RATE LIMITS AND BACKOFF. Per-host minimum spacing, and retries on
        transient failures only (timeouts, 5xx, 429) with exponential
        backoff. A 403 or a 404 is an ANSWER: it is never retried.
     4  CACHE AND PROVENANCE. Everything read is written to the pipeline's own
        cache directory with the URL, the status and the retrieval time beside
        it, so an artifact can say where each number came from and how old it
        is without the builder having to remember.

   WHAT IT DELIBERATELY DOES NOT DO
   - It does not invent an endpoint. Every URL is supplied by the caller.
   - It does not carry a credential. Nothing here reads a key; a source that
     needs one is the caller's problem and is declared unavailable, not faked.
   - It does not treat retrieved text as anything but data. Callers parse it;
     nothing here evaluates it.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const FC = require(path.join(__dirname, 'feed_cache.js'));

const ROOT = path.join(__dirname, '..', '..');
const CACHE_DIR = process.env.EDP_CACHE || path.join(ROOT, 'football', 'data', 'cache');

/* a status a retry cannot help: the server answered, and that IS the answer */
const TERMINAL = /^(4\d\d)$/;
const RETRYABLE_STATUS = { 408: 1, 425: 1, 429: 1, 500: 1, 502: 1, 503: 1, 504: 1 };

const DEFAULTS = {
  fetch: null,                  /* injected transport; tests drive the real code path */
  timeout_ms: 25000,
  retries: 2,
  backoff_ms: 500,
  host_min_gap_ms: 120,
  host_failure_breaker: 3,      /* consecutive hard failures before a host is cut */
  budget_ms: null,              /* null = no wall-clock budget */
  budget_requests: null
};

function hostOf(url) { try { return new URL(String(url)).host; } catch (_) { return String(url).slice(0, 40); } }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function nowIso() { return new Date().toISOString(); }

/* ------------------------------------------------------------------ session */
/* One recovery run. Create it, use it, read its report. State is per-session
   so a long-lived process (a server) never accumulates a breaker for ever. */
function session(opts) {
  const cfg = Object.assign({}, DEFAULTS, opts || {});
  const started = Date.now();
  const inflight = new Map();          /* url -> Promise */
  const hostGate = new Map();          /* host -> {next_at, fails} */
  const log = [];
  let requests = 0, bytes = 0;

  function budgetLeft() {
    if (cfg.budget_ms == null) return Infinity;
    return cfg.budget_ms - (Date.now() - started);
  }
  function exhausted() {
    if (cfg.budget_requests != null && requests >= cfg.budget_requests) return 'request budget spent';
    if (budgetLeft() <= 0) return 'time budget spent';
    return null;
  }
  function gateFor(host) {
    let g = hostGate.get(host);
    if (!g) { g = { next_at: 0, fails: 0, cut: null }; hostGate.set(host, g); }
    return g;
  }

  /* One URL. Returns {ok, status, text, url, retrieved_at, from, error, attempts}. */
  async function get(url, o) {
    o = o || {};
    const key = String(url) + '|' + (o.range || '');
    if (inflight.has(key)) return inflight.get(key);
    const p = (async function () {
      const host = hostOf(url);
      const g = gateFor(host);
      const out = { ok: false, status: null, text: null, url: String(url), host: host,
        retrieved_at: null, from: 'network', error: null, attempts: 0, bytes: 0 };

      if (g.cut) { out.error = 'host circuit open: ' + g.cut; out.from = 'breaker'; log.push(entry(out)); return out; }
      const spent = exhausted();
      if (spent) { out.error = spent; out.from = 'budget'; log.push(entry(out)); return out; }

      const tries = Math.max(1, (o.retries == null ? cfg.retries : o.retries) + 1);
      let wait = o.backoff_ms == null ? cfg.backoff_ms : o.backoff_ms;
      for (let attempt = 1; attempt <= tries; attempt++) {
        const gap = g.next_at - Date.now();
        if (gap > 0) await sleep(Math.min(gap, 2000));
        g.next_at = Date.now() + cfg.host_min_gap_ms;
        out.attempts = attempt;
        requests++;
        const budget = budgetLeft();
        const to = Math.max(1000, Math.min(o.timeout_ms == null ? cfg.timeout_ms : o.timeout_ms,
          budget === Infinity ? Infinity : budget));
        try {
          const headers = Object.assign({ 'user-agent': 'EdgeDesk-football-sync (+https://edgedesksports.com)' }, o.headers || {});
          if (o.range) headers.range = o.range;
          const r = await (o.fetch || cfg.fetch || globalThis.fetch)(String(url), {
            headers: headers, redirect: 'follow', signal: AbortSignal.timeout(to)
          });
          out.status = r.status;
          if (!r.ok && !(o.range && r.status === 206)) {
            if (RETRYABLE_STATUS[r.status] && attempt < tries) { await sleep(wait); wait *= 2; continue; }
            out.error = 'HTTP ' + r.status;
            if (TERMINAL.test(String(r.status))) { g.fails++; if (g.fails >= cfg.host_failure_breaker) g.cut = 'HTTP ' + r.status + ' x' + g.fails; }
            log.push(entry(out)); return out;
          }
          out.text = await r.text();
          out.bytes = out.text.length; bytes += out.bytes;
          out.ok = true; out.retrieved_at = nowIso();
          g.fails = 0;
          log.push(entry(out)); return out;
        } catch (e) {
          out.error = String((e && e.name === 'TimeoutError') ? ('timeout after ' + to + 'ms') : ((e && e.message) || e)).slice(0, 160);
          if (attempt < tries && budgetLeft() > wait) { await sleep(wait); wait *= 2; continue; }
          g.fails++;
          if (g.fails >= cfg.host_failure_breaker) g.cut = out.error;
          log.push(entry(out)); return out;
        }
      }
      log.push(entry(out)); return out;
    })();
    inflight.set(key, p);
    try { return await p; } finally { inflight.delete(key); }
  }

  function entry(out) {
    return { url: out.url, host: out.host, status: out.status, ok: out.ok, from: out.from,
      attempts: out.attempts, bytes: out.bytes, error: out.error, at: out.retrieved_at || nowIso() };
  }

  /* A cached read with the pipeline's own freshness rule. `season` decides
     whether the cache entry is permanent or volatile (feed_cache.js). */
  async function cached(url, cacheName, o) {
    o = o || {};
    const file = path.join(CACHE_DIR, cacheName);
    const min = o.min_bytes || 0;
    if (!o.force && FC.usable(file, cacheName, o.season, min)) {
      let st = null; try { st = fs.statSync(file); } catch (_) { /* raced */ }
      if (st) return { ok: true, status: 200, text: fs.readFileSync(file, 'utf8'), url: String(url),
        host: hostOf(url), retrieved_at: new Date(st.mtimeMs).toISOString(), from: 'cache', error: null, attempts: 0, bytes: st.size };
    }
    const r = await get(url, o);
    if (r.ok && r.text != null && r.text.length > min) {
      try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(file, r.text); } catch (_) { /* cache is a convenience */ }
      return r;
    }
    /* THE FALLBACK THAT IS NOT A LIE. A stale cache is served when the network
       refuses, and it comes back labelled stale with its own age, so the
       caller can report "stale" rather than "fresh" or "missing". */
    try {
      const st = fs.statSync(file);
      if (st.size > min) return { ok: true, status: r.status, text: fs.readFileSync(file, 'utf8'), url: String(url),
        host: hostOf(url), retrieved_at: new Date(st.mtimeMs).toISOString(), from: 'stale-cache',
        error: r.error || 'refetch failed; served the previous download', attempts: r.attempts, bytes: st.size };
    } catch (_) { /* nothing cached */ }
    return r;
  }

  /* Ordered providers for ONE logical field. The first that answers wins and
     the answer records WHICH provider produced it; every refusal above it is
     kept, because "the primary refused and the fallback answered" is a
     different state from "the primary answered". */
  async function firstOf(providers, o) {
    o = o || {};
    const tried = [];
    for (const p of (providers || [])) {
      const r = p.cache ? await cached(p.url, p.cache, Object.assign({}, o, p.opts || {}))
        : await get(p.url, Object.assign({}, o, p.opts || {}));
      if (r.ok && (!p.accept || p.accept(r))) {
        return { ok: true, provider: p.name, result: r, tried: tried,
          fell_back: tried.length > 0, from: r.from };
      }
      tried.push({ provider: p.name, url: p.url, status: r.status, error: r.error || (p.accept ? 'answered but failed the caller\'s acceptance check' : null) });
    }
    return { ok: false, provider: null, result: null, tried: tried, fell_back: false, from: null };
  }

  function report() {
    const hosts = {};
    hostGate.forEach(function (g, h) { hosts[h] = { consecutive_failures: g.fails, circuit_open: g.cut || null }; });
    const failures = log.filter(function (l) { return !l.ok; });
    /* SYSTEMATIC vs INCIDENTAL, because they need different responses and the
       old report gave them the same one. */
    const byError = {};
    failures.forEach(function (f) { const k = f.host + ' ' + (f.status || f.error); byError[k] = (byError[k] || 0) + 1; });
    return {
      started_at: new Date(started).toISOString(), elapsed_ms: Date.now() - started,
      requests: requests, bytes: bytes,
      ok: log.filter(function (l) { return l.ok; }).length,
      failed: failures.length,
      from_cache: log.filter(function (l) { return l.from === 'cache'; }).length,
      from_stale_cache: log.filter(function (l) { return l.from === 'stale-cache'; }).length,
      hosts: hosts,
      /* SYSTEMATIC means "one cause, counted many times" — the 276-failure
         report that was really two dead endpoints. A host whose breaker
         tripped is systematic however few requests reached it, because the
         breaker is precisely what stopped it being counted 138 times. */
      failure_groups: Object.keys(byError).map(function (k) {
        var host = k.split(' ')[0];
        var g = hostGate.get(host);
        return { signature: k, count: byError[k], systematic: byError[k] >= 3 || !!(g && g.cut) };
      }).sort(function (a, b) { return b.count - a.count; }),
      budget: { ms: cfg.budget_ms, requests: cfg.budget_requests, exhausted: exhausted() }
    };
  }

  return { get: get, cached: cached, firstOf: firstOf, report: report, config: cfg, log: log };
}

/* --------------------------------------------------------------------- CSV */
/* One parser, because three builders each had their own and they disagreed
   about quoted newlines. */
function parseCsv(text, opts) {
  opts = opts || {};
  const rows = []; let row = [], field = '', q = false;
  const s = String(text == null ? '' : text);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift() || [];
  const keep = opts.columns ? new Set(opts.columns) : null;
  const want = keep ? head.map(function (h) { return keep.has(h); }) : null;
  return rows.filter(function (r) { return r.length > 1; }).map(function (r) {
    const o = {};
    for (let i = 0; i < head.length; i++) { if (want && !want[i]) continue; o[head[i]] = r[i] === undefined ? '' : r[i]; }
    return o;
  });
}
const NA = v => (v == null || v === '' || v === 'NA' || v === 'NaN') ? null : v;
const NUM = v => { const x = NA(v); if (x == null) return null; const n = +x; return isFinite(n) ? n : null; };

module.exports = { session, parseCsv, NA, NUM, CACHE_DIR, DEFAULTS, hostOf };
