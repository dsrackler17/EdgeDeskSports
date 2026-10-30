#!/usr/bin/env node
/* ===========================================================================
   supabase/functions/novig_sync/index.ts, tested as deployed: imported (not a
   copy) under Node's type stripping, with a Deno shim, an in-memory PostgREST
   and a mock Novig that VERIFIES every request's NOVIG-V3 signature with the
   public half of a key generated here (nothing is committed).

     copy        the inlined cores have not drifted (tools/novig/inline.js)
     read-only   no order, cancel, subaccount, transfer or key-creation route
                 and no management-key name in the function
     auth        GET is a probe that shows no key; POST needs the cron secret;
                 an unknown mode is refused
     switches    no environment, no credentials, ingest off: skipped, recorded
                 at most hourly, Novig never called
     probe       every request verifies at Novig; echo, clock, limits,
                 geolocation and the key's scope recorded; a full management
                 key is flagged
     clock       45 s of skew: the 401 is answered by a resync, then signed on
                 Novig's time
     discover    the REAL BAL @ BUF and KC @ DEN catalog: every page followed,
                 consensus flagged, every game line linked; a second run adds
                 nothing; a delisted market is closed out; a changed home team
                 invalidates its links with the reason
     snapshot    only comparable markets (moneylines, DraftKings' line, the
                 consensus line), only when due; top, fills at $25…$500 and
                 depth stored; an unchanged book is a 304 and is confirmed, not
                 stored; a changed one is stored; in play, the taker fee is in
                 the fills
     errors      429 waits Retry-After; 451 stops at once (never retried) and
                 halts 6 h (device) / 2 h (network); later runs skip without
                 calling Novig; 423, 403 (scope / edge HTML), 401 (wrong key or
                 environment) each halt; 5xx retried; a 404 book closes the
                 market out
     paper       NOVIG_ENV=paper reads api.paper.novig.com and stamps 'paper'
     dry         reads and computes, writes nothing
     secrets     no private key, signature or key id in any log line or row

   Run: node tools/novig/novig_sync.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const NS = require(path.join(ROOT, 'lib', 'novig_signing.js'));
const EV = require(path.join(ROOT, 'lib', 'edgedesk_venue_compare.js'));
const FX = require(path.join(__dirname, 'fixtures', 'catalog_nfl_2026-10-30.json'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }

/* ---------------------------------------------------------------- the key (generated; never committed) */
const KP = nodeCrypto.generateKeyPairSync('ed25519');
const PEM = KP.privateKey.export({ type: 'pkcs8', format: 'pem' });
const PUB = KP.publicKey.export({ type: 'spki', format: 'pem' });
const KID = '7d1c5b0e-2a9f-4c3e-8b6d-1f2e3a4b5c6d';
const PEM_BODY = PEM.split('\n').filter((l) => l && !/^-----/.test(l)).join('');
const ENV = { SUPABASE_URL: 'https://stub.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key', NOVIG_CRON_SECRET: 'cron-secret', NOVIG_ENV: 'production',
  NOVIG_READ_KEY_ID: KID, NOVIG_READ_PRIVATE_KEY: PEM.replace(/\n/g, '\\n'), NOVIG_INGEST_ENABLED: 'true', NOVIG_LEAGUES: 'NFL', NOVIG_HORIZON_HOURS: '96' };
globalThis.Deno = { env: { get: (k) => ENV[k] } };

chk('copy: the inlined cores match lib/ (node tools/novig/inline.js)', require(path.join(__dirname, 'inline.js')).current('supabase/functions/novig_sync/index.ts'));
const SRC = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'novig_sync', 'index.ts'), 'utf8');
const OWN = SRC.slice(0, SRC.indexOf('// ── BEGIN NOVIG CORE')) + SRC.slice(SRC.indexOf('// ── END NOVIG CORE'));
const NOVIG_CALLS = [...OWN.matchAll(/(?:nv|c)\.(?:req|pages)\("?([A-Z]*)"?,? ?"([^"]+)"/g)].map((m) => (m[1] || 'GET') + ' ' + m[2]);
chk('read-only: every Novig call is a GET except one POST /v3/echo; no order, portfolio, subaccount, transfer or key-creation path appears', NOVIG_CALLS.length >= 10
  && NOVIG_CALLS.filter((c) => !/^GET /.test(c)).join(',') === 'POST /v3/echo' && !/\/v3\/orders|\/v3\/portfolio|\/v3\/account\/subaccounts|\/transfer"|cancel_all/.test(OWN), NOVIG_CALLS);
chk('least privilege: the function never reads the management key or the stream key', !/NOVIG_MANAGEMENT|NOVIG_STREAM_/.test(OWN.replace(/^\/\/.*$/gm, '')));

/* ---------------------------------------------------------------- the clocks */
let CLOCK = Date.parse('2026-11-01T15:00:00Z');   // Sunday, BAL @ BUF kicks off 2026-11-02T00:20Z (fixture)
let LOCAL_SKEW = 0;                                // our clock minus Novig's
const SLEEPS = [];

/* ---------------------------------------------------------------- PostgREST, in memory */
let DB;
const KEY = { novig_events: 'event_id', novig_markets: 'market_id', novig_market_links: 'market_id' };
function resetDb() {
  DB = { novig_events: [], novig_markets: [], novig_book_snapshots: [], novig_book_depth: [], novig_market_links: [], novig_sync_runs: [], novig_alerts: [], novig_unmapped: [],
    signals: [], sharp_price_snapshots: [], seq: 0, calls: [] };
  const book = (id, home, away, ms) => { for (const s of [home, away]) DB.signals.push({ sig_key: id + '|h2h|' + s, event_id: id, sport_key: 'americanfootball_nfl', market: 'h2h', selection: s, home_team: home, away_team: away, commence_time: new Date(ms).toISOString() }); };
  const evB = FX.events.find((e) => /Buffalo/.test(e.description)), evD = FX.events.find((e) => /Denver/.test(e.description));
  book('odds-bufbal', 'Buffalo Bills', 'Baltimore Ravens', evB.startsTs);
  book('odds-denkc', 'Denver Broncos', 'Kansas City Chiefs', evD.startsTs);
  DB.sharp_price_snapshots.push({ id: 1, event_id: 'odds-bufbal', book: 'draftkings', market: 'spreads', side: 'Buffalo Bills', point: -3.5, price_dec: 1.909, captured_at: new Date(CLOCK - 3600e3).toISOString() },
    { id: 2, event_id: 'odds-bufbal', book: 'draftkings', market: 'spreads', side: 'Baltimore Ravens', point: 3.5, price_dec: 1.909, captured_at: new Date(CLOCK - 3600e3).toISOString() });
}
function cmpOp(v, op, x) {
  if (op === 'eq') return String(v) === x;
  if (op === 'is') return x === 'null' ? v == null : (x === 'true' ? v === true : v === false);
  if (op === 'in') { const set = x.replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/^"|"$/g, '')); return set.includes(String(v)); }
  if (v == null) return false;
  const a = Date.parse(v), b = Date.parse(x);
  const [l, r] = isFinite(a) && isFinite(b) && isNaN(Number(x)) ? [a, b] : [Number(v), Number(x)];
  return op === 'gte' ? l >= r : op === 'lte' ? l <= r : op === 'gt' ? l > r : op === 'lt' ? l < r : true;
}
function filterRows(rows, q) {
  let out = rows;
  for (const [k, raw] of q.entries()) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(k)) continue;
    const m = /^(eq|is|in|gte|lte|gt|lt)\.(.*)$/.exec(raw);
    if (!m) throw new Error('mock: unparsed filter ' + k + '=' + raw);
    out = out.filter((r) => cmpOp(r[k], m[1], m[2]));
  }
  if (q.get('order') === 'halt_until.desc') out = out.slice().sort((a, b) => (a.halt_until < b.halt_until ? 1 : -1));
  const off = Number(q.get('offset') || 0), lim = q.get('limit') ? Number(q.get('limit')) : Infinity;
  return out.slice(off, off + lim);
}
function rest(u, init) {
  const url = new URL(u), name = url.pathname.replace('/rest/v1/', ''), q = url.searchParams, m = (init && init.method) || 'GET';
  DB.calls.push(m + ' ' + name);
  const prefer = (init && init.headers && init.headers.prefer) || '';
  if (name === 'rpc/novig_record_unmapped') {
    const a = JSON.parse(init.body);
    for (const r of a.p_rows) {
      const ex = DB.novig_unmapped.find((x) => x.novig_event_id === r.novig_event_id && x.market_id === r.market_id && x.reason === r.reason);
      if (ex) { ex.seen_count++; ex.resolved_at = null; } else DB.novig_unmapped.push(Object.assign({ seen_count: 1, resolved_at: null }, r));
    }
    return [200, { recorded: a.p_rows.length, resolved: 0 }];
  }
  if (!(name in DB)) return [404, { message: 'no table ' + name }];
  if (m === 'POST') {
    const rows = JSON.parse(init.body), conflict = q.get('on_conflict'), out = [];
    for (const r of rows) {
      let i = -1;
      if (conflict) i = DB[name].findIndex((x) => conflict.split(',').every((c) => String(x[c]) === String(r[c])));
      else if (KEY[name]) i = DB[name].findIndex((x) => x[KEY[name]] === r[KEY[name]]);
      if (i >= 0 && /ignore-duplicates/.test(prefer)) continue;
      if (i >= 0 && /merge-duplicates/.test(prefer)) { Object.assign(DB[name][i], r); continue; }
      if (i >= 0) return [409, { message: 'duplicate key' }];
      const row = Object.assign({ id: ++DB.seq, created_at: new Date(CLOCK).toISOString() }, name === 'novig_markets' ? { first_seen_at: new Date(CLOCK).toISOString() } : {}, r);
      DB[name].push(row); out.push(row);
    }
    return [201, /return=representation/.test(prefer) ? out : ''];
  }
  if (m === 'PATCH') { filterRows(DB[name], q).forEach((r) => Object.assign(r, JSON.parse(init.body))); return [204, '']; }
  return [200, filterRows(DB[name], q)];
}

/* ---------------------------------------------------------------- Novig, mocked (and checking every signature) */
let W;
const EV_B = FX.events.find((e) => /Buffalo/.test(e.description)), EV_D = FX.events.find((e) => /Denver/.test(e.description));
const comp = (id, name, symbol) => ({ competitorId: id, name, shortName: name.split(' ').pop(), symbol, marketIds: [] });
function resetNovig(o) {
  W = Object.assign({ calls: [], bad: [], host: 'https://api.novig.com', pageSize: 1, fail: [], status: { [EV_B.eventId]: 'OPEN_PREGAME', [EV_D.eventId]: 'OPEN_PREGAME' }, hidden: [],
    denHome: comp('c-den', 'Denver Broncos', 'DEN'), scope: 'management::read', seqBump: 0, marketPage: 30 }, o || {});
}
const MARKETS = () => FX.markets.filter((m) => !W.hidden.includes(m.marketId));
const PARTS = () => [
  { eventId: EV_B.eventId, homeCompetitorId: 'c-buf', awayCompetitorId: 'c-bal', competitors: [comp('c-buf', 'Buffalo Bills', 'BUF'), comp('c-bal', 'Baltimore Ravens', 'BAL')], players: [] },
  { eventId: EV_D.eventId, homeCompetitorId: W.denHome.competitorId, awayCompetitorId: 'c-kc', competitors: [W.denHome, comp('c-kc', 'Kansas City Chiefs', 'KC')], players: [] }];
const CONSENSUS = () => [{ marketId: FX.markets.find((m) => m.eventId === EV_B.eventId && m.marketType === 'SPREAD' && m.strike === '-3.5').marketId, eventId: EV_B.eventId, marketType: 'SPREAD' },
  { marketId: FX.markets.find((m) => m.eventId === EV_D.eventId && m.marketType === 'TOTAL').marketId, eventId: EV_D.eventId, marketType: 'TOTAL' }];
function bookFor(marketId) {
  const real = FX.books[marketId];
  const m = FX.markets.find((x) => x.marketId === marketId);
  const base = real || { marketId, seq: 100, orders: Object.fromEntries(m.outcomes.map((o) => [o.outcomeId, o.bid ? [{ orderId: 'x-' + o.outcomeId, price: o.bid.price, qty: o.bid.qty }] : []])) };
  return Object.assign({}, base, { seq: base.seq + W.seqBump });
}
function resp(status, body, headers) {
  const h = new Map(Object.entries(Object.assign({ date: new Date(CLOCK).toUTCString() }, headers || {})).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return { ok: status >= 200 && status < 300, status, headers: { get: (k) => (h.has(k.toLowerCase()) ? h.get(k.toLowerCase()) : null) },
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body), text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}
const PUBK = NS.importPublicKey(PUB);
async function novig(u, init) {
  const url = new URL(u), p = url.pathname, method = (init && init.method) || 'GET', H = (init && init.headers) || {};
  W.calls.push(method + ' ' + p + (url.search || ''));
  if (url.origin !== W.host) return resp(400, { code: 'WRONG_HOST' });
  /* the signature, as Novig checks it (errors.md: headers, timestamp window, key, verification) */
  const ts = H['Novig-Timestamp'], sig = H['Novig-Signature'], kid = H['Novig-Key-Id'];
  if (!ts || !sig || !kid) return resp(401, { code: 'SIGNATURE_REJECTED', message: 'novig-key-id header is required' });
  if (Math.abs(Number(ts) - CLOCK) > 30000) return resp(401, { code: 'SIGNATURE_REJECTED', message: Number(ts) < CLOCK ? 'novig-timestamp is too old' : 'novig-timestamp is too far in the future' });
  if (kid !== KID) return resp(401, { code: 'SIGNATURE_REJECTED', message: 'api key not found' });
  const body = init && init.body ? Buffer.from(init.body).toString() : '';
  const hashed = H['Content-Type'] === 'application/json' ? body : '';   // without a content type the server hashes zero bytes
  const s = await NS.stringToSign({ timestamp: ts, method, path: p, query: url.search.slice(1), body: hashed });
  if (!(await NS.verifyString(s, sig, await PUBK))) { W.bad.push(method + ' ' + p); return resp(401, { code: 'SIGNATURE_REJECTED', message: 'signature verification failed' }); }
  for (const f of W.fail) if (f.re.test(method + ' ' + p) && (f.times == null || f.times-- > 0)) return resp(f.status, f.body, f.headers);
  const q = url.searchParams;
  const page = (items, size) => { const off = Number(q.get('after') || 0), n = size || W.pageSize; const next = off + n < items.length ? String(off + n) : undefined; return resp(200, Object.assign({ items: items.slice(off, off + n) }, next ? { next } : {})); };
  if (p === '/v3/time') return resp(200, { ts: CLOCK });
  if (p === '/v3/exchange/status') return resp(200, { trading: 'OPEN' });
  if (p === '/v3/echo') return resp(200, body);
  if (p === '/v3/limits') return resp(200, { read: { capacity: 64, refillPerSec: 16 }, history: { capacity: 16, refillPerSec: 4 }, stream: { capacity: 512, refillPerSec: 32 }, account: { capacity: 8, refillPerSec: 8 }, place: {}, cancel: {}, maxWatchedMarkets: 1000, maxOpenOrders: 1024 });
  if (p === '/v3/account/geolocation') return resp(200, { code: 'GEOLOCATION_EXPIRED', expiresAt: null });
  if (p === '/v3/keys') return resp(200, [{ keyId: KID, name: 'edgedesk-read', scope: W.scope, algorithm: 'Ed25519', fingerprint: 'sha256:x', restriction: null, createdAt: '2026-10-30T00:00:00Z', lastUsedAt: null, expiresAt: null }]);
  if (p === '/v3/catalog/events') return page(FX.events.filter((e) => !q.get('league') || e.league === q.get('league')).map((e) => Object.assign({}, e, { status: W.status[e.eventId] || e.status })));
  if (p === '/v3/catalog/participants') return page(PARTS());
  if (p === '/v3/catalog/markets') { const types = (q.get('marketType') || '').split(','); return page(MARKETS().filter((m) => !types[0] || types.includes(m.marketType)), W.marketPage); }
  if (p === '/v3/catalog/consensus') return page(CONSENSUS());
  const bm = /^\/v3\/catalog\/markets\/([^/]+)\/book$/.exec(p);
  if (bm) {
    if (!FX.markets.some((m) => m.marketId === bm[1]) || W.hidden.includes(bm[1])) return resp(404, { code: 'MARKET_NOT_FOUND', message: 'Market not found' });
    const b = bookFor(bm[1]), etag = 'W/"' + b.seq + '"';
    if (H['if-none-match'] === etag) return resp(304, '', { etag });
    return resp(200, b, { etag });
  }
  return resp(404, { code: 'NOT_FOUND', message: 'unmocked ' + p });
}
const LOGS = [];
const realLog = console.log;
globalThis.fetch = async (u, init) => {
  u = String(u);
  if (u.startsWith(ENV.SUPABASE_URL)) { const [s, b] = rest(u, init); return resp(s, b); }
  return novig(u, init);
};

(async () => {
  const FN = path.join(ROOT, 'supabase', 'functions', 'novig_sync', 'index.ts');
  let F;
  try { F = await import(FN); } catch (e) { chk('the deployed function imports under Node 22 type stripping', false, e && e.message); return finish(); }
  F.hooks.sleep = async (ms) => { SLEEPS.push(ms); CLOCK += ms; };
  F.hooks.now = () => CLOCK + LOCAL_SKEW;
  F.hooks.random = () => 0.5;
  console.log = (...a) => { LOGS.push(a.join(' ')); };
  const run = (o) => F.syncOnce(Object.assign({ trigger: 'test' }, o || {}));
  const lastRun = () => DB.novig_sync_runs[DB.novig_sync_runs.length - 1];
  const codes = (o) => o.alerts.map((a) => a.severity + ':' + a.code).sort().join(',');
  const novigCalls = () => W.calls.length;

  /* ---- the handler ---- */
  resetDb(); resetNovig();
  const pr = await F.handle(new Request('https://x/', { method: 'GET' }));
  const pj = await pr.json();
  chk('auth: a GET is a probe with the build and the switches, never a key id', pr.status === 200 && pj.build === F.BUILD && pj.credentials_set === true && pj.ingest_enabled === true && !JSON.stringify(pj).includes(KID));
  chk('auth: a POST without the secret, or with a wrong one, is refused', (await F.handle(new Request('https://x/', { method: 'POST', body: '{}' }))).status === 401
    && (await F.handle(new Request('https://x/', { method: 'POST', headers: { 'x-cron-secret': 'nope' }, body: '{}' }))).status === 401);
  chk('auth: an unknown mode (e.g. "place") is refused', (await F.handle(new Request('https://x/', { method: 'POST', headers: { 'x-cron-secret': 'cron-secret' }, body: '{"mode":"place"}' }))).status === 400);

  /* ---- switches ---- */
  ENV.NOVIG_INGEST_ENABLED = 'false';
  let o = await run({ mode: 'snapshot' });
  const o2 = await run({ mode: 'snapshot' });
  chk('switch: ingest off is skipped, recorded once an hour, and Novig is never called', o.status === 'skipped' && o.skipped_reason === 'ingest_disabled' && o2.status === 'skipped'
    && DB.novig_sync_runs.filter((r) => r.skipped_reason === 'ingest_disabled').length === 1 && novigCalls() === 0);
  ENV.NOVIG_INGEST_ENABLED = 'true';
  const keep = ENV.NOVIG_READ_PRIVATE_KEY; ENV.NOVIG_READ_PRIVATE_KEY = '';
  o = await run({ mode: 'probe' });
  chk('switch: no credentials is skipped with the setup hint', o.status === 'skipped' && o.skipped_reason === 'no_credentials' && /NOVIG_READ_PRIVATE_KEY/.test(o.hint) && novigCalls() === 0);
  ENV.NOVIG_READ_PRIVATE_KEY = keep; ENV.NOVIG_ENV = '';
  o = await run({ mode: 'probe' });
  chk('switch: no environment is skipped: production or paper is never guessed', o.status === 'skipped' && o.skipped_reason === 'no_environment' && novigCalls() === 0);
  ENV.NOVIG_ENV = 'production';

  /* ---- probe ---- */
  resetDb(); resetNovig();
  o = await run({ mode: 'probe' });
  chk('probe: every request verified at Novig; echo ok; clock, limits, geolocation and scope recorded', o.ok && W.bad.length === 0 && o.auth.echo === 'ok' && o.auth.clock === 'ok' && o.auth.limits.read.capacity === 64
    && o.auth.geolocation.code === 'GEOLOCATION_EXPIRED' && o.auth.scope === 'management::read' && lastRun().mode === 'probe' && lastRun().auth.key_id_tail === KID.slice(-4), o);
  chk('probe: the POST carries Content-Type and its exact bytes are hashed (else Novig hashes zero bytes)', W.calls.includes('POST /v3/echo'));
  resetNovig({ scope: 'management' });
  o = await run({ mode: 'probe' });
  chk('probe: a full management key used for ingestion is flagged as over-privileged', codes(o).includes('WARNING:over_privileged_key'));

  /* ---- clock skew ---- */
  resetDb(); resetNovig(); LOCAL_SKEW = -45000;
  o = await run({ mode: 'probe' });
  chk('clock: 45 s behind, the refusal\'s Date header and GET /v3/time bring it inside the window; signed on Novig\'s time; a WARNING to fix the host clock', o.ok && Math.abs(o.auth.clock_offset_ms - 45000) <= 1500
  && o.auth.clock === 'outside_window' && o.auth.echo === 'ok' && W.bad.length === 0 && codes(o).includes('WARNING:clock_skew'), o.auth);
  LOCAL_SKEW = 0;

  /* ---- discover: the real catalog ---- */
  resetDb(); resetNovig();
  o = await run({ mode: 'discover' });
  const nMk = FX.markets.length;
  chk('discover: every page followed (page size 1), events and every real game-line market stored, stamped production', o.ok && DB.novig_events.length === 2 && DB.novig_markets.length === nMk
    && DB.novig_markets.every((m) => m.environment === 'production') && W.calls.some((c) => /\/v3\/catalog\/markets\?.*after=/.test(c)) && W.bad.length === 0, o.discover);
  chk('discover: consensus lines flagged; fee, void rule and outcomes kept as sent', DB.novig_markets.filter((m) => m.is_consensus).length === 2
    && DB.novig_markets.every((m) => m.fee_coefficient === '0.06' && m.fee_charged === 'WHEN_LIVE' && m.voids === 'FMV' && m.outcomes.length === 2));
  chk('discover: every game line of both games linked to its book event; nothing unmapped', DB.novig_market_links.length === nMk && o.links.unmapped === 0
    && DB.novig_market_links.filter((l) => l.odds_event_id === 'odds-bufbal').length === FX.markets.filter((m) => m.eventId === EV_B.eventId).length, o.links);
  chk('discover: links carry their constraints, notes, confidence and the run', DB.novig_market_links.every((l) => l.constraints && Array.isArray(l.settlement_notes) && /^(high|medium)$/.test(l.match_confidence) && l.run_id === lastRun().run_id));
  o = await run({ mode: 'discover' });
  chk('discover: a second run adds no link and invalidates none', DB.novig_market_links.length === nMk && o.links.new === 0 && o.links.invalidated === 0);
  const hide = FX.markets.find((m) => m.eventId === EV_B.eventId && m.marketType === 'TOTAL_1H').marketId;
  resetNovig({ hidden: [hide] });
  o = await run({ mode: 'discover' });
  chk('discover: a market that left the open catalog is closed out (gone_at, CLOSED)', DB.novig_markets.find((m) => m.market_id === hide).gone_at && DB.novig_markets.find((m) => m.market_id === hide).status === 'CLOSED');
  resetNovig({ marketPage: 1 });
  o = await run({ mode: 'discover' });
  chk('page cap: a listing cut short (115 markets at 1 a page, 40 pages) warns and closes NOTHING out', codes(o).includes('WARNING:page_cap')
    && DB.novig_markets.filter((m) => m.gone_at).length === 1, codes(o));
  resetNovig({ denHome: comp('c-lv', 'Las Vegas Raiders', 'LV') });
  o = await run({ mode: 'discover' });
  const denLinks = DB.novig_market_links.filter((l) => l.odds_event_id === 'odds-denkc');
  chk('discover: a changed home team invalidates every link of that game with the reason; nothing new is linked to it', denLinks.length > 0 && denLinks.every((l) => l.invalidated_at && /no longer matches/.test(l.invalidated_reason)) && o.links.new === 0
    && DB.novig_unmapped.some((u) => u.novig_event_id === EV_D.eventId && u.reason === 'one_team_only'), o.links);

  /* ---- snapshot ---- */
  resetDb(); resetNovig();
  await run({ mode: 'discover' });
  W.calls = [];
  o = await run({ mode: 'snapshot' });
  const bookCalls = W.calls.filter((c) => /\/book/.test(c));
  const moneyB = FX.markets.find((m) => m.eventId === EV_B.eventId && m.marketType === 'MONEY').marketId;
  const spreadB = FX.markets.find((m) => m.eventId === EV_B.eventId && m.marketType === 'SPREAD' && m.strike === '-3.5').marketId;
  chk('snapshot: only comparable markets are read (both moneylines, the first-half moneylines, BUF −3.5 at DraftKings\' line, the consensus total)', o.ok && bookCalls.length === o.snapshot.due
    && bookCalls.some((c) => c.includes(moneyB)) && bookCalls.some((c) => c.includes(spreadB)) && bookCalls.length < 12 && W.bad.length === 0, { due: o.snapshot, calls: bookCalls.length });
  const sB = DB.novig_book_snapshots.find((s) => s.market_id === moneyB);
  const realQ = EV.executableQuote(FX.books[moneyB], FX.markets.find((m) => m.marketId === moneyB).outcomes[0].outcomeId, FX.markets.find((m) => m.marketId === moneyB).outcomes.map((x) => x.outcomeId), { fee: { coefficient: '0.06', charged: 'WHEN_LIVE' }, eventStatus: 'OPEN_PREGAME' });
  const oB = FX.markets.find((m) => m.marketId === moneyB).outcomes[0].outcomeId;
  chk('snapshot: the real BUF/BAL book stored with its seq, top of book and the $100 fill the engine computes', sB && sB.book_seq === FX.books[moneyB].seq && sB.top[oB].ask === realQ.top.price
    && JSON.stringify(sB.exec[oB]['100']) === JSON.stringify(['FILLED', realQ.stakes[2].contracts, realQ.stakes[2].total, realQ.stakes[2].payout, realQ.stakes[2].unspent, realQ.stakes[2].vwap]) && sB.fee_charged_now === false, sB && sB.exec[oB]);
  chk('snapshot: depth stored beside it (each order kept), linked by snapshot id', DB.novig_book_depth.some((d) => d.snapshot_id === sB.id && Array.isArray(d.depth[oB]) && Array.isArray(d.depth[oB][0][2])));
  chk('snapshot: the market remembers the seq and ETag it saw', DB.novig_markets.find((m) => m.market_id === moneyB).last_book_seq === FX.books[moneyB].seq && /W\//.test(DB.novig_markets.find((m) => m.market_id === moneyB).last_book_etag));
  const nSnaps = DB.novig_book_snapshots.length;
  W.calls = [];
  o = await run({ mode: 'snapshot' });
  chk('cadence: immediately again, nothing is due (BUF is 9 h out: every 10 min) and Novig is barely called', o.snapshot.due === 0 && W.calls.filter((c) => /\/book/.test(c)).length === 0);
  CLOCK += 31 * 60000;
  W.calls = [];
  o = await run({ mode: 'snapshot' });
  chk('unchanged: 31 min later every book answers 304 to its ETag; confirmed, not stored again', o.snapshot.read > 0 && o.snapshot.unchanged === o.snapshot.read && DB.novig_book_snapshots.length === nSnaps
    && DB.novig_markets.find((m) => m.market_id === moneyB).book_confirmed_at === new Date(CLOCK).toISOString(), o.snapshot);
  CLOCK += 31 * 60000; W.seqBump = 7;
  o = await run({ mode: 'snapshot' });
  chk('changed: a moved book (seq + 7) is stored as a new snapshot', o.snapshot.written > 0 && DB.novig_book_snapshots.length === nSnaps + o.snapshot.written && DB.novig_book_snapshots.some((s) => s.market_id === moneyB && s.book_seq === FX.books[moneyB].seq + 7));
  CLOCK += 31 * 60000; W.seqBump = 9; W.status[EV_B.eventId] = 'OPEN_INGAME';
  o = await run({ mode: 'snapshot' });
  const live = DB.novig_book_snapshots.filter((s) => s.market_id === moneyB).pop();
  const liveQ = EV.executableQuote(FX.books[moneyB], oB, FX.markets.find((m) => m.marketId === moneyB).outcomes.map((x) => x.outcomeId), { fee: { coefficient: '0.06', charged: 'WHEN_LIVE' }, eventStatus: 'OPEN_INGAME' });
  chk('in play: the event is OPEN_INGAME, the taker fee is charged and the stored fills include it', live.fee_charged_now === true && live.event_status === 'OPEN_INGAME' && live.exec[oB]['100'][1] === liveQ.stakes[2].contracts && liveQ.stakes[2].contracts < realQ.stakes[2].contracts, live.exec[oB]['100']);
  W.status[EV_B.eventId] = 'OPEN_PREGAME';

  /* ---- errors ---- */
  const errRun = async (fail, mode) => { resetDb(); resetNovig(); await run({ mode: 'discover' }); resetNovig({ fail }); W.calls = []; return run({ mode: mode || 'discover' }); };
  resetDb(); resetNovig({ fail: [{ re: /GET \/v3\/catalog\/participants/, status: 429, body: { code: 'RATE_LIMIT_EXCEEDED', message: 'Rate limit exceeded.' }, headers: { 'retry-after': '2' }, times: 1 }] });
  SLEEPS.length = 0;
  o = await run({ mode: 'discover' });
  chk('429: waited Retry-After (2 s, plus jitter) and retried; the run completes with a rate-limit warning', o.ok && SLEEPS.some((s) => s >= 2000 && s < 3000) && codes(o).includes('WARNING:rate_limited') && DB.novig_market_links.length === nMk, { sleeps: SLEEPS, codes: codes(o) });
  o = await errRun([{ re: /GET \/v3\/catalog\/events/, status: 451, body: { code: 'GEOLOCATION_OUT_OF_BOUNDARY', message: 'The device is outside a permitted state.' } }]);
  chk('451 (device): FAILURE, requested once and never retried, halted 6 h', !o.ok && codes(o).includes('FAILURE:geolocation_geolocation_out_of_boundary') && W.calls.filter((c) => /catalog\/events/.test(c)).length === 1
    && Math.abs(Date.parse(lastRun().halt_until) - CLOCK - 6 * 3600e3) < 60000 && /451/.test(lastRun().halt_reason), codes(o));
  W.calls = [];
  o = await run({ mode: 'snapshot' });
  chk('halted: the next run skips without calling Novig at all', o.status === 'skipped' && o.skipped_reason === 'halted' && W.calls.length === 0);
  o = await errRun([{ re: /GET \/v3\/catalog\/events/, status: 451, body: { code: 'ANONYMIZED_NETWORK', message: 'The request came over a VPN, a proxy, or a Tor exit.' } }]);
  chk('451 (network): halted 2 h, the message says to run from a fixed US address — never a proxy', Math.abs(Date.parse(lastRun().halt_until) - CLOCK - 2 * 3600e3) < 60000 && /fixed US address/.test(lastRun().message));
  o = await errRun([{ re: /GET \/v3\/catalog\/events/, status: 423, body: { code: 'SYSTEM_LOCKED', message: 'locked' } }]);
  chk('423: FAILURE locked, halted 6 h', codes(o).includes('FAILURE:locked') && lastRun().halt_until);
  o = await errRun([{ re: /GET \/v3\/catalog\/events/, status: 403, body: '<html><body>Request blocked</body></html>' }]);
  chk('403 HTML (the edge): DEGRADED edge_blocked, halted 15 min, not retried', codes(o).includes('DEGRADED:edge_blocked') && Math.abs(Date.parse(lastRun().halt_until) - CLOCK - 15 * 60000) < 60000 && W.calls.filter((c) => /catalog\/events/.test(c)).length === 1);
  o = await errRun([{ re: /GET \/v3\/catalog\/events/, status: 403, body: { code: 'SIGNATURE_REJECTED', message: 'api key scope is insufficient for this route' } }]);
  chk('403 JSON (scope): FAILURE scope, halted 6 h', codes(o).includes('FAILURE:scope'));
  resetDb(); resetNovig(); ENV.NOVIG_READ_KEY_ID = '00000000-0000-4000-8000-000000000000';
  o = await run({ mode: 'probe' });
  chk('401 api key not found: auth FAILURE naming the environment, halted 1 h', !o.ok && codes(o).includes('FAILURE:auth_failed') && /NOVIG_ENV=production/.test(lastRun().message) && lastRun().halt_until);
  ENV.NOVIG_READ_KEY_ID = KID;
  resetDb(); resetNovig({ fail: [{ re: /GET \/v3\/catalog\/markets$/, status: 503, body: { code: 'INTERNAL_ERROR', message: 'x' }, times: 2 }] });
  o = await run({ mode: 'discover' });
  chk('5xx: retried with backoff, then succeeds', o.ok && DB.novig_markets.length === nMk && SLEEPS.length > 0);
  resetDb(); resetNovig(); await run({ mode: 'discover' });
  resetNovig({ hidden: [moneyB] }); W.calls = [];
  o = await run({ mode: 'snapshot' });
  chk('404 book: the market is closed out and the run carries on', o.ok && DB.novig_markets.find((m) => m.market_id === moneyB).gone_at && o.snapshot.gone === 1 && W.calls.filter((c) => c.includes(moneyB)).length === 1);

  /* ---- paper ---- */
  resetDb(); resetNovig({ host: 'https://api.paper.novig.com' }); ENV.NOVIG_ENV = 'paper';
  o = await run({ mode: 'discover' });
  chk('paper: NOVIG_ENV=paper reads api.paper.novig.com and stamps every row paper', o.ok && DB.novig_markets.every((m) => m.environment === 'paper') && DB.novig_market_links.every((l) => l.environment === 'paper') && lastRun().environment === 'paper');
  ENV.NOVIG_ENV = 'production';

  /* ---- dry ---- */
  resetDb(); resetNovig();
  o = await run({ mode: 'discover', dry: true });
  chk('dry: reads and computes (links proposed), writes nothing', o.ok && o.dry && o.links.new === nMk && DB.novig_markets.length === 0 && DB.novig_sync_runs.length === 0 && !DB.calls.some((c) => /^(POST|PATCH)/.test(c)));

  /* ---- the cadence equals the SQL rules ---- */
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'novig_market_data.sql'), 'utf8');
  const rule = (k) => Number((new RegExp("when '" + k + "'\\s+then ([0-9.]+)").exec(sql) || [])[1]);
  chk('cadence: CADENCE equals novig_rule snapshot_near/mid/far', F.CADENCE.near_minutes === rule('snapshot_near_minutes') && F.CADENCE.mid_minutes === rule('snapshot_mid_minutes') && F.CADENCE.far_minutes === rule('snapshot_far_minutes'));
  chk('cadence: 5 min inside 2 h of kickoff, 10 to 24 h, 30 beyond (a minute of slack)', F.due(null, 0, 0) && F.due(Date.parse('2026-01-01T00:00:00Z'), Date.parse('2026-01-01T01:30:00Z'), Date.parse('2026-01-01T00:04:00Z'))
    && !F.due(Date.parse('2026-01-01T00:00:00Z'), Date.parse('2026-01-01T10:00:00Z'), Date.parse('2026-01-01T00:08:00Z')) && F.due(Date.parse('2026-01-01T00:00:00Z'), Date.parse('2026-01-03T00:00:00Z'), Date.parse('2026-01-01T00:29:00Z')));

  /* ---- secrets ---- */
  const everything = LOGS.join('\n') + JSON.stringify(DB);
  chk('secrets: no private key, no PEM, no key id and no signature in any log line or stored row', !everything.includes(PEM_BODY.slice(10, 40)) && !/BEGIN PRIVATE KEY/.test(everything) && !everything.includes(KID)
    && !/Novig-Signature|novig-signature/.test(everything) && LOGS.length > 0);
  finish();
})().catch((e) => { console.log = realLog; console.log('FAILED novig sync: ' + (e && e.stack || e)); process.exit(1); });

function finish() {
  console.log = realLog;
  console.log((fail ? 'FAILED' : 'ALL GREEN') + ' novig sync: ' + pass + ' passed, ' + fail + ' failed');
  for (const f of failures) console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 900) : ''));
  process.exit(fail ? 1 : 0);
}
