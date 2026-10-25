'use strict';
/* ===========================================================================
   MARKET FORESIGHT — the worker's database: PostgREST with the service role.

   SB_URL and SB_SERVICE_ROLE come from the job's environment (GitHub Actions
   secrets), never from a file, a log line or an error message: every error
   text is scrubbed of the key before it is thrown.

   READS are an allowlist: the Kalshi layer (public prices and links) and the
   Collective's games, teams, models, creators and projections. WRITES go only
   to the mf_job_* doors (supabase/market_foresight.sql). Transient failures
   (network, 5xx, 429) are retried at most 3 times with backoff; a 4xx is not.
   A run makes at most MAX_REQUESTS calls, then stops rather than load the
   database. Every list is paged (PAGE rows a call) and bounded.

   KALSHI CACHE. A finished game's pregame snapshots never change (the table
   is append-only and the sync stamps rows with the time it runs), so once
   read after kickoff they are kept in .cache/foresight/kalshi/<ticker>.json
   (Actions cache, never committed) and not asked for again.
   =========================================================================== */
const fs = require('fs');
const path = require('path');

const MAX_REQUESTS = 1500;
const PAGE = 1000;
const MAX_SNAPSHOTS_PER_MARKET = 6000;
const READS = /^(kalshi_game_links|kalshi_markets|kalshi_price_snapshots|kalshi_readiness)\?/;
const COLLECTIVE_READS = /^(games|teams|models|creators|projections)\?/;

function client(env, opts) {
  env = env || process.env;
  opts = opts || {};
  const url = String(env.SB_URL || '').replace(/\/+$/, ''), key = env.SB_SERVICE_ROLE || '';
  if (!opts.fetchImpl && !/^https:\/\/[a-z0-9.-]+$/i.test(url)) throw new Error('SB_URL is not set to an https Supabase URL');
  if (key.length < 8) throw new Error('SB_SERVICE_ROLE is not set');
  const f = opts.fetchImpl || fetch;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const retries = opts.retries == null ? 3 : opts.retries;
  const budget = opts.maxRequests || MAX_REQUESTS;
  const scrub = (s) => String(s).split(key).join('[redacted]');
  let used = 0;
  async function call(method, p, body, profile, always) {
    let last = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      /* closing the run is always allowed: a run that ran out of budget must
         still release its lease and say why */
      if (++used > budget && !always) throw Object.assign(new Error('request budget exhausted (' + budget + ' calls): the run stops rather than load the database'), { budget: true });
      const headers = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'return=representation' };
      if (profile) headers['Accept-Profile'] = profile;
      let res;
      try {
        res = await f((url || 'http://standin') + '/rest/v1/' + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      } catch (e) {
        last = Object.assign(new Error('network error on ' + p.split('?')[0] + ': ' + scrub(e && e.message || e)), { transient: true });
        if (attempt < retries) { await sleep(400 * Math.pow(2, attempt)); continue; }
        throw last;
      }
      const text = await res.text();
      if (res.ok) { try { return text ? JSON.parse(text) : null; } catch (_) { return text; } }
      const transient = res.status >= 500 || res.status === 429;
      last = Object.assign(new Error(p.split('?')[0] + ' answered ' + res.status + ': ' + scrub(text).slice(0, 400)), { status: res.status, transient });
      if (transient && attempt < retries) { await sleep(400 * Math.pow(2, attempt)); continue; }
      throw last;
    }
    throw last;
  }
  return {
    get used() { return used; },
    rpc(name, args) {
      if (!/^mf_job_[a-z_]+$/.test(name)) throw new Error('the worker calls Market Foresight job doors only, not ' + name);
      return call('POST', 'rpc/' + name, args || {}, undefined, name === 'mf_job_finish');
    },
    get(p) {
      if (!READS.test(p)) throw new Error('the worker reads only the layers it needs, not ' + p.split('?')[0]);
      return call('GET', p);
    },
    collective(p) {
      if (!COLLECTIVE_READS.test(p)) throw new Error('the worker reads only the Collective tables it needs, not ' + p.split('?')[0]);
      return call('GET', p, undefined, 'collective');
    }
  };
}

/* every row of a list, PAGE at a time, at most `max` */
async function paged(fetchPage, base, max) {
  const out = [];
  for (let offset = 0; offset < (max || 100000); offset += PAGE) {
    const rows = await fetchPage(base + '&limit=' + PAGE + '&offset=' + offset);
    if (!Array.isArray(rows)) break;
    out.push.apply(out, rows);
    if (rows.length < PAGE) break;
  }
  return out;
}
const inList = (xs) => 'in.(' + xs.map((x) => '"' + String(x).replace(/"/g, '') + '"').join(',') + ')';

/* the Kalshi inputs for finished games: links, the markets' rules, and each
   home market's pregame snapshots (cached once final) */
async function kalshi(db, sport, events, nowMs, opts, log) {
  opts = opts || {};
  const ids = Object.keys(events).filter((k) => Date.parse(events[k].kickoff) <= nowMs);
  if (!ids.length) return { links: [], markets: [], snaps: {}, fetched: 0, cached: 0 };
  const earliest = new Date(Math.min.apply(null, ids.map((k) => Date.parse(events[k].kickoff))) - 2 * 86400000).toISOString();
  const links = await paged((p) => db.get(p), 'kalshi_game_links?select=market_ticker,event_ticker,series_ticker,sport,yes_team,opponent,home_team,away_team,kickoff_at,game_id'
    + '&sport=eq.' + sport + '&game_id=not.is.null&kickoff_at=gte.' + encodeURIComponent(earliest) + '&kickoff_at=lte.' + encodeURIComponent(new Date(nowMs).toISOString()) + '&order=kickoff_at.asc,market_ticker.asc', 20000);
  const tickers = Array.from(new Set(links.map((l) => l.market_ticker))).sort();
  const markets = [];
  for (let i = 0; i < tickers.length; i += 50) {
    const rows = await db.get('kalshi_markets?select=ticker,series_ticker,rules_primary&ticker=' + encodeURIComponent(inList(tickers.slice(i, i + 50))));
    if (Array.isArray(rows)) markets.push.apply(markets, rows);
  }
  const snaps = {}; let fetched = 0, cached = 0;
  const dir = opts.cacheDir || null;
  for (const l of links) {
    const kick = Date.parse(l.kickoff_at);
    const file = dir ? path.join(dir, String(l.market_ticker).replace(/[^A-Za-z0-9_.-]/g, '_') + '.json') : null;
    if (file && fs.existsSync(file)) {
      try {
        const c = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (c.kickoff_at === l.kickoff_at && Date.parse(c.read_at) > kick) { snaps[l.market_ticker] = c.snapshots; cached++; continue; }
      } catch (_) { /* a bad cache file is read again */ }
    }
    const from = new Date(kick - 8 * 86400000).toISOString();
    const rows = await paged((p) => db.get(p), 'kalshi_price_snapshots?select=id,ticker,captured_at,yes_bid,yes_ask,no_bid,no_ask,last_price,yes_bid_size,yes_ask_size,volume,open_interest'
      + '&ticker=eq.' + encodeURIComponent(l.market_ticker) + '&captured_at=gte.' + encodeURIComponent(from) + '&captured_at=lt.' + encodeURIComponent(l.kickoff_at)
      + '&order=captured_at.asc,id.asc', MAX_SNAPSHOTS_PER_MARKET);
    if (rows.length >= MAX_SNAPSHOTS_PER_MARKET) log.push({ level: 'warn', code: 'kalshi_snapshots_truncated', ticker: l.market_ticker, message: 'more than ' + MAX_SNAPSHOTS_PER_MARKET + ' pregame snapshots; the earliest are kept' });
    snaps[l.market_ticker] = rows; fetched++;
    if (file) {
      try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify({ ticker: l.market_ticker, kickoff_at: l.kickoff_at, read_at: new Date(nowMs).toISOString(), snapshots: rows })); } catch (_) { /* a cache that cannot be written is only slower */ }
    }
  }
  return { links, markets, snaps, fetched, cached };
}

/* the Collective's rows for the seasons in question */
async function collective(db, sinceIso) {
  const games = await paged((p) => db.collective(p), 'games?select=*&kickoff_at=gte.' + encodeURIComponent(sinceIso) + '&order=kickoff_at.asc,id.asc', 50000);
  const teams = await paged((p) => db.collective(p), 'teams?select=*&order=id.asc', 50000);
  const models = await paged((p) => db.collective(p), 'models?select=*&order=id.asc', 20000);
  const creators = await paged((p) => db.collective(p), 'creators?select=*&order=id.asc', 20000);
  const projections = await paged((p) => db.collective(p), 'projections?select=id,model_id,game_id,received_at,projected_spread,projected_total,home_win_prob,data_origin,resolution_status'
    + '&received_at=gte.' + encodeURIComponent(new Date(Date.parse(sinceIso) - 14 * 86400000).toISOString()) + '&order=received_at.asc,id.asc', 400000);
  return { games, teams, models, creators, projections };
}

module.exports = { client, paged, kalshi, collective, MAX_REQUESTS, PAGE };
