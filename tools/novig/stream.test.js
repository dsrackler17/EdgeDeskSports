#!/usr/bin/env node
/* ===========================================================================
   lib/novig_stream.js (the book channel's state machine) and
   tools/novig/stream_worker.js (on a real socket), against Novig's streaming
   documents (connection.md, book.md, lifecycle.md).

     subscribe   batched under 512 tokens a request (32 markets on book) and
                 the watch limit; what does not fit is reported
     snapshot    Novig's `order` field and REST's `orderId` both load; an
                 outcome with no key is an empty book; the view feeds the
                 executable-price engine
     deltas      next seq applied as one batch (add at the back of its level;
                 remove; a partial fill keeps its queue position); an old seq
                 ignored; a malformed batch changes nothing and resnapshots
     gaps        a skipped seq is buffered, a snapshot requested once, the
                 buffer replayed above the new snapshot's seq
     new market  opened under an event: no snapshot, starts at seq 0, not a gap
     lifecycle   GOLIVE / UNLIVE flip the fee state; GRADE unsubscribes
     errors      SUBSCRIPTION_LIMIT_EXCEEDED and MARKET_NOT_FOUND surfaced
                 with the request they refused
     reconnect   backoff 1 s doubling to 60 s with jitter; after a reconnect
                 every market starts again from its new snapshot; a
                 geolocation close STOPS (never retried)
     read-only   the module sends only subscribe, unsubscribe, snapshot, status
     worker      disabled without its switch and key; on a local socket it
                 signs the upgrade (verified), subscribes, writes changed books
                 as ws_book snapshots, resnapshots a gap, and on a geolocation
                 close stops and records a halt

   Run: node tools/novig/stream.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const nodeCrypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const ST = require(path.join(ROOT, 'lib', 'novig_stream.js'));
const EV = require(path.join(ROOT, 'lib', 'edgedesk_venue_compare.js'));
const NS = require(path.join(ROOT, 'lib', 'novig_signing.js'));
const WK = require(path.join(__dirname, 'stream_worker.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }

const SRC = fs.readFileSync(path.join(ROOT, 'lib', 'novig_stream.js'), 'utf8');
chk('read-only: the module sends only subscribe, unsubscribe, snapshot and status (no place, cancel, cancel_all)', !/\b(place|cancel|cancel_all)\s*:/.test(SRC) && (SRC.match(/send\(\{ nonce: n, (\w+)/g) || []).map((x) => x.split(', ')[1]).sort().join(',') === 'snapshot,status,subscribe,unsubscribe');

function harness(o) {
  const sent = [], events = [];
  const s = ST.create(Object.assign({ send: (m) => sent.push(m), emit: (k, x) => events.push([k, x]), random: () => 0.5 }, o || {}));
  return { s, sent, events };
}

/* ---------------------------------------------------------------- subscribe */
let h = harness();
const ids = Array.from({ length: 70 }, (_, i) => 'm' + i);
let sub = h.s.onOpen(ids, 50);
chk('subscribe: 50 of 70 fit the watch limit, in two requests (32 + 18), each ≤ 512 tokens; 20 reported over', sub.sent.length === 2 && sub.sent[0].markets === 32 && sub.sent[1].markets === 18
  && sub.sent.every((x) => x.tokens <= 512) && sub.overflow.length === 20 && h.events.some((e) => e[0] === 'overflow' && e[1].markets.length === 20));
chk('subscribe: nonces start at 1 and increase; each names markets on book', h.sent[0].nonce === 1 && h.sent[1].nonce === 2 && h.sent[0].subscribe.markets.m0 === 'book');

/* ---------------------------------------------------------------- snapshot and deltas (the docs' Chiefs / Bills book) */
h = harness();
h.s.onOpen(['mk'], 100);
h.s.onMessage({ ts: 1, nonce: 1, subscribed: { markets: { mk: 'book' } }, snapshot: { mk: { eventId: 'ev', book: { seq: 48120, orders: {
  chiefs: [{ order: 'a', price: '0.665', qty: 110 }, { order: 'b', price: '0.660', qty: 250 }], bills: [{ order: 'c', price: '0.340', qty: 90 }] } }, lifecycle: { seq: 3, status: 'OPEN' } } } });
let b = h.s.book('mk');
chk('snapshot: Novig\'s `order` field loads; the seq is the snapshot\'s; the view is REST-shaped', b.seq === 48120 && b.orders.chiefs.map((x) => x.orderId).join(',') === 'a,b' && b.orders.bills[0].orderId === 'c' && h.s.lifecycle('mk').status === 'OPEN');
chk('snapshot: the view feeds the executable-price engine (Chiefs at 1 − 0.340)', EV.executableQuote(b, 'chiefs', ['chiefs', 'bills'], {}).top.price === '0.660');
h.s.onMessage({ ts: 2, delta: { mk: { eventId: 'ev', book: { seq: 48121, deltas: [{ kind: 'add', order: 'd', outcome: 'chiefs', price: '0.665', qty: 50 }, { kind: 'remove', order: 'c', reason: 'fill' }] } } } });
b = h.s.book('mk');
chk('delta: the next seq applies as one batch: d joins the BACK of 0.665 (after a), c is gone', b.seq === 48121 && b.orders.chiefs.map((x) => x.orderId).join(',') === 'a,d,b' && b.orders.bills.length === 0);
h.s.onMessage({ ts: 3, delta: { mk: { book: { seq: 48122, deltas: [{ kind: 'remove', order: 'a', reason: 'fill' }, { kind: 'add', order: 'a', outcome: 'chiefs', price: '0.665', qty: 60 }] } } } });
b = h.s.book('mk');
chk('partial fill: remove then add of the remainder keeps its price AND its place at the front of the queue', b.orders.chiefs.map((x) => x.orderId + ':' + x.qty).join(',') === 'a:60,d:50,b:250');
h.s.onMessage({ ts: 4, delta: { mk: { book: { seq: 48122, deltas: [{ kind: 'remove', order: 'b', reason: 'cancel' }] } } } });
chk('stale: a repeated seq is ignored', h.s.book('mk').orders.chiefs.length === 3 && h.s.state.stats.stale === 1);
const before = JSON.stringify(h.s.book('mk'));
h.s.onMessage({ ts: 5, delta: { mk: { book: { seq: 48123, deltas: [{ kind: 'add', order: 'e', outcome: 'bills', price: '0.300', qty: 5 }, { kind: 'remove', order: 'zzz', reason: 'fill' }] } } } });
chk('atomic: a batch that removes an unknown order changes nothing and asks for a snapshot', JSON.stringify(h.s.book('mk')) === before && h.sent.some((m) => m.snapshot && m.snapshot.markets.mk === 'book') && h.s.state.stats.rejected === 1);

/* ---------------------------------------------------------------- gaps */
h = harness();
h.s.onOpen(['g'], 100);
h.s.onMessage({ nonce: 1, snapshot: { g: { book: { seq: 100, orders: { x: [{ order: 'o1', price: '0.50', qty: 10 }], y: [] } } } } });
h.s.onMessage({ delta: { g: { book: { seq: 102, deltas: [{ kind: 'add', order: 'o3', outcome: 'x', price: '0.51', qty: 3 }] } } } });
h.s.onMessage({ delta: { g: { book: { seq: 104, deltas: [{ kind: 'add', order: 'o5', outcome: 'y', price: '0.40', qty: 5 }] } } } });
const snapReqs = h.sent.filter((m) => m.snapshot);
chk('gap: seq 102 after 100 is a gap; one snapshot request, subscriptions unchanged; later deltas buffered', snapReqs.length === 1 && h.s.state.stats.gaps === 1 && h.s.book('g').seq === 100 && h.events.some((e) => e[0] === 'gap' && e[1].expected === 101 && e[1].got === 102));
h.s.onMessage({ nonce: snapReqs[0].nonce, snapshot: { g: { book: { seq: 103, orders: { x: [{ order: 'o1', price: '0.50', qty: 10 }, { order: 'o3', price: '0.51', qty: 3 }], y: [] } } } } });
b = h.s.book('g');
chk('gap: the new snapshot (seq 103) drops buffered deltas at or below it and replays 104', b.seq === 104 && b.orders.y.map((x) => x.orderId).join(',') === 'o5' && b.orders.x.length === 2);

/* ---------------------------------------------------------------- a market opened under an event subscription */
h = harness();
h.s.onOpen([], 100);
h.s.onMessage({ delta: { nm: { eventId: 'ev2', lifecycle: { seq: 1, deltas: [{ kind: 'OPEN', status: 'OPEN' }] }, book: { seq: 1, deltas: [{ kind: 'add', order: 'q', outcome: 'x', price: '0.45', qty: 9 }] } } } });
chk('new market: no snapshot, first delta OPEN, book from seq 0 — applied, not a gap', h.s.book('nm').seq === 1 && h.s.state.stats.gaps === 0 && h.s.lifecycle('nm').status === 'OPEN');

/* ---------------------------------------------------------------- lifecycle */
h = harness();
h.s.onOpen(['lc'], 100);
h.s.onMessage({ nonce: 1, snapshot: { lc: { book: { seq: 5, orders: { x: [{ order: 'r1', price: '0.6', qty: 1 }] } }, lifecycle: { seq: 2, status: 'OPEN' } } } });
h.s.onMessage({ delta: { lc: { book: { seq: 6, deltas: [{ kind: 'remove', order: 'r1', reason: 'cancel' }] }, lifecycle: { seq: 3, deltas: [{ kind: 'GOLIVE', status: 'OPEN' }] } } } });
chk('lifecycle: GOLIVE (after the voiding removes) turns live on — taker fees apply to WHEN_LIVE markets', h.s.lifecycle('lc').live === true && h.s.book('lc').orders.x.length === 0);
h.s.onMessage({ delta: { lc: { lifecycle: { seq: 4, deltas: [{ kind: 'UNLIVE', status: 'OPEN' }] } } } });
chk('lifecycle: UNLIVE turns it off; the market is not over', h.s.lifecycle('lc').live === false && h.s.lifecycle('lc').status === 'OPEN');
h.s.onMessage({ delta: { lc: { lifecycle: { seq: 5, deltas: [{ kind: 'CLOSE', status: 'CLOSED' }, { kind: 'GRADE', status: 'SETTLED' }] } } } });
chk('lifecycle: CLOSE then GRADE settles the market and unsubscribes it', h.s.book('lc') === null && h.sent.some((m) => m.unsubscribe && m.unsubscribe[0] === 'market:lc') && h.events.some((e) => e[0] === 'settled'));

/* ---------------------------------------------------------------- errors */
h = harness();
h.s.onOpen(['e1', 'e2'], 100);
h.s.onMessage({ code: 'SUBSCRIPTION_LIMIT_EXCEEDED', message: 'too many', nonce: 1 });
chk('errors: a refused subscribe is surfaced with its request and markets', h.events.some((e) => e[0] === 'error' && e[1].code === 'SUBSCRIPTION_LIMIT_EXCEEDED' && e[1].request === 'subscribe' && e[1].markets.length === 2));

/* ---------------------------------------------------------------- reconnect */
chk('backoff: 1 s, 2 s, 4 s … capped at 60 s, ±50% jitter', ST.backoff(1, () => 0.5) === 1000 && ST.backoff(2, () => 0.5) === 2000 && ST.backoff(10, () => 0.5) === 60000 && ST.backoff(1, () => 0) === 500 && ST.backoff(1, () => 1) === 1500);
h = harness();
h.s.onOpen(['r1', 'r2'], 100);
h.s.onMessage({ nonce: 1, snapshot: { r1: { book: { seq: 900, orders: {} } }, r2: { book: { seq: 77, orders: {} } } } });
const c1 = h.s.onClose(1008, 'SLOW_CONSUMER');
chk('reconnect: SLOW_CONSUMER reconnects after backoff', c1.reconnect === true && c1.delay_ms === 1000 && /SLOW_CONSUMER/.test(c1.why));
h.sent.length = 0;
h.s.onOpen(['r1', 'r2'], 100);
chk('reconnect: every market subscribed again and starts from its NEW snapshot (no seq carried across connections)', h.s.book('r1') === null && h.sent.length === 1 && Object.keys(h.sent[0].subscribe.markets).length === 2 && h.sent[0].nonce === 1);
h.s.onMessage({ nonce: 1, snapshot: { r1: { book: { seq: 3, orders: {} } } } });
chk('reconnect: a lower seq on the new connection is accepted from its snapshot', h.s.book('r1').seq === 3);
const c2 = h.s.onClose(1008, 'GEOLOCATION_OUT_OF_BOUNDARY');
chk('geolocation close: the stream STOPS and is never retried', c2.reconnect === false && h.s.state.stopped && /never|not retried/.test(c2.why));

/* ---------------------------------------------------------------- the worker on a real socket */
(async () => {
  chk('worker: off without NOVIG_STREAM_ENABLED', WK.config({ NOVIG_ENV: 'production' }).enabled === false && /off/.test(WK.config({}).why));
  chk('worker: off without its key, even when enabled', /NOVIG_STREAM_KEY_ID/.test(WK.config({ NOVIG_STREAM_ENABLED: 'true', NOVIG_ENV: 'production' }).why));
  const kp = nodeCrypto.generateKeyPairSync('ed25519');
  const KID = '3a3a3a3a-3a3a-4a3a-8a3a-3a3a3a3a3a3a';
  const PUBK = await NS.importPublicKey(kp.publicKey.export({ type: 'spki', format: 'pem' }));
  const WS_EVENTS = { upgrade: null, received: [], socket: null };
  const srv = http.createServer();
  const frame = (op, payload) => { const p = Buffer.from(payload); const head = p.length < 126 ? Buffer.from([0x80 | op, p.length]) : Buffer.concat([Buffer.from([0x80 | op, 126]), Buffer.from([p.length >> 8, p.length & 255])]); return Buffer.concat([head, p]); };
  const sendText = (o) => WS_EVENTS.socket.write(frame(1, JSON.stringify(o)));
  srv.on('upgrade', async (req, sock) => {
    const ts = req.headers['novig-timestamp'], sig = req.headers['novig-signature'];
    const s = await NS.stringToSign({ timestamp: ts, method: 'GET', path: req.url, query: '', body: '' });
    WS_EVENTS.upgrade = { key: req.headers['novig-key-id'], verified: await NS.verifyString(s, sig, PUBK), path: req.url };
    const acc = nodeCrypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
    WS_EVENTS.socket = sock;
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) break;
        const op = buf[0] & 15; let len = buf[1] & 127, off = 2;
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
        const masked = buf[1] & 128, mk = masked ? buf.slice(off, off + 4) : null; off += masked ? 4 : 0;
        if (buf.length < off + len) break;
        let pl = buf.slice(off, off + len); if (mk) pl = Buffer.from(pl.map((x, i) => x ^ mk[i % 4]));
        buf = buf.slice(off + len);
        if (op === 1) WS_EVENTS.received.push(JSON.parse(pl.toString()));
      }
    });
    sock.on('error', () => {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const DB = { runs: [], alerts: [], snaps: [], depth: [] };
  const NOW = Date.parse('2026-11-01T18:00:00Z');
  const market = { market_id: 'mkt-1', outcomes: [{ outcomeId: 'kc' }, { outcomeId: 'buf' }], fee_coefficient: '0.06', fee_maker_credit: '0.25', fee_charged: 'WHEN_LIVE', gone_at: null, status: 'OPEN' };
  const fakeFetch = async (u, init) => {
    u = String(u);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => (body === '' ? '' : JSON.stringify(body)) });
    if (u.includes('/v3/limits')) return ok({ maxWatchedMarkets: 1000 });
    const p = u.replace(/^https:\/\/sb\.test\/rest\/v1\//, '');
    if (p.startsWith('novig_market_links')) return ok([{ market_id: 'mkt-1', kickoff_at: new Date(NOW + 3600e3).toISOString() }]);
    if (p.startsWith('novig_markets')) return ok([market]);
    if (p.startsWith('novig_book_snapshots')) { const rows = JSON.parse(init.body).filter((r) => !DB.snaps.some((s) => s.market_id === r.market_id && s.book_seq === r.book_seq)); rows.forEach((r, i) => { r.id = DB.snaps.length + i + 1; }); DB.snaps.push(...rows); return ok(rows); }
    if (p.startsWith('novig_book_depth')) { DB.depth.push(...JSON.parse(init.body)); return ok(''); }
    if (p.startsWith('novig_sync_runs')) { DB.runs.push(...JSON.parse(init.body)); return ok(''); }
    if (p.startsWith('novig_alerts')) { DB.alerts.push(...JSON.parse(init.body)); return ok(''); }
    return { ok: false, status: 404, text: async () => 'unmocked ' + u };
  };
  const logs = [];
  const timers = [];
  const w = WK.startWorker({ config: { enabled: true, env: 'production', keyId: KID, pem: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }), sbUrl: 'https://sb.test', sbKey: 'k' },
    fetch: fakeFetch, now: () => NOW, wsUrl: 'ws://127.0.0.1:' + port, log: (s) => logs.push(s), setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {}, sleep: async () => {} });
  await w.connect();
  const wait = async (cond, ms) => { const t = Date.now(); while (!cond() && Date.now() - t < (ms || 3000)) await new Promise((r) => setTimeout(r, 20)); return cond(); };
  await wait(() => WS_EVENTS.received.length >= 1);
  chk('worker: the upgrade is signed with the stream key and verifies (GET /v3/ws)', WS_EVENTS.upgrade && WS_EVENTS.upgrade.verified === true && WS_EVENTS.upgrade.key === KID && WS_EVENTS.upgrade.path === '/v3/ws', WS_EVENTS.upgrade);
  chk('worker: it subscribes the linked market on book', WS_EVENTS.received[0] && WS_EVENTS.received[0].subscribe && WS_EVENTS.received[0].subscribe.markets['mkt-1'] === 'book', WS_EVENTS.received[0]);
  sendText({ ts: 1, nonce: 1, subscribed: { markets: { 'mkt-1': 'book' } }, snapshot: { 'mkt-1': { eventId: 'e', book: { seq: 10, orders: { buf: [{ order: 'b1', price: '0.385', qty: 20000 }], kc: [{ order: 'k1', price: '0.610', qty: 9000 }] } }, lifecycle: { seq: 1, status: 'OPEN' } } } });
  await wait(() => w.state.book('mkt-1'));
  sendText({ ts: 2, delta: { 'mkt-1': { book: { seq: 11, deltas: [{ kind: 'add', order: 'b2', outcome: 'buf', price: '0.390', qty: 500 }] } } } });
  await wait(() => w.state.book('mkt-1') && w.state.book('mkt-1').seq === 11);
  const n = await w.flush();
  const row = DB.snaps[0];
  chk('worker: the changed book is written once as a ws_book snapshot with its seq, top and fills, plus depth', n === 1 && row.source === 'ws_book' && row.book_seq === 11 && row.top.kc.ask === '0.610' && row.exec.kc['100'][0] === 'FILLED' && DB.depth.length === 1, row);
  chk('worker: nothing changed, nothing written', (await w.flush()) === 0);
  sendText({ ts: 3, delta: { 'mkt-1': { book: { seq: 14, deltas: [] } } } });
  await wait(() => WS_EVENTS.received.some((m) => m.snapshot));
  chk('worker: a gap asks the server for a snapshot of that market', WS_EVENTS.received.some((m) => m.snapshot && m.snapshot.markets['mkt-1'] === 'book'));
  const closeFrame = Buffer.concat([Buffer.from([0x88, 2 + 'GEOLOCATION_OUT_OF_BOUNDARY'.length, 0x03, 0xf0]), Buffer.from('GEOLOCATION_OUT_OF_BOUNDARY')]);
  WS_EVENTS.socket.write(closeFrame);
  WS_EVENTS.socket.end();   /* a server closes TCP after its close frame */
  await wait(() => DB.runs.length > 0, 4000);
  chk('worker: a geolocation close stops it, records a FAILURE and a 6-hour halt (the REST sync halts too)', w.worker.stopped && DB.runs[0] && DB.runs[0].status === 'error' && DB.runs[0].halt_until && DB.alerts.some((a) => a.code === 'geolocation_stream'), { runs: DB.runs, alerts: DB.alerts });
  chk('worker: no key material in its logs or rows', !JSON.stringify(DB).includes('PRIVATE') && !logs.join('\n').includes('PRIVATE'));
  try { WS_EVENTS.socket.destroy(); } catch (_) { /* closed */ }
  srv.close();
  console.log((fail ? 'FAILED' : 'ALL GREEN') + ' novig stream: ' + pass + ' passed, ' + fail + ' failed');
  for (const f of failures) console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 700) : ''));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAILED novig stream: ' + (e && e.stack || e)); process.exit(1); });
