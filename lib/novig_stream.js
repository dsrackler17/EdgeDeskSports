/* ===========================================================================
   EdgeDesk — NOVIG MARKET-DATA STREAM: the book channel, kept exactly.

   docs.novig.com/api/streaming/connection.md, book.md, lifecycle.md (read
   2026-10-30). One websocket (GET /v3/ws, signed like any route, a `trading`
   or `trading::read` key — never `management`) carries every channel. This
   module is the state machine behind it, independent of the transport so it
   can be tested message by message; tools/novig/stream_worker.js gives it a
   socket. It is READ-ONLY: it sends subscribe, unsubscribe, snapshot and
   status, and nothing else (place / cancel / cancel_all do not exist here).

   WHAT IT KEEPS EXACT
   - seq is per market AND per channel (book, lifecycle); never compared
     across connections. A snapshot carries the seq it was taken at; the first
     delta carries the next one.
   - a delta whose seq is the next one is applied as ONE batch (changes that
     happen together arrive together); an old seq is ignored; a skipped seq is
     a GAP: the delta is buffered, a `snapshot` is requested for that market
     (subscriptions unchanged), and when it arrives the buffered deltas at or
     below its seq are dropped and the rest replayed in order.
   - a market that opens under an event subscription arrives with no
     snapshot: its first delta is OPEN and its book starts at seq 0. That is
     not a gap.
   - the book is resting BIDS per outcome, in queue order: `add` joins the
     back of its price level; `remove` (fill or cancel) takes the order out; a
     partial fill is a remove then an add of the remainder at the same price.
     An outcome with no key in a snapshot is an empty book.
   - lifecycle: GOLIVE (resting orders were voided just before; taker fees
     on for WHEN_LIVE), UNLIVE (fees off; not over), START, END, CLOSE
     (stopped accepting orders), GRADE (settled: the market is dropped).
   - after a reconnect every market is subscribed again and starts from its
     new snapshot; nothing from the old connection is trusted.
   - subscribe costs 16 tokens per market on `book`, capped at 512 per
     request, and a connection may watch at most `maxWatchedMarkets` (GET
     /v3/limits): requests are batched under both, the nearest games first,
     and what does not fit is reported, never silently dropped.
   - a close with a 451 geolocation reason STOPS the stream (no reconnect
     loop): Novig warns that repeated 451s can lock the account. Any other
     close reconnects with exponential backoff and jitter.
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.NovigStream = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var COST = { lifecycle: 1, trades: 4, bbo: 8, book: 16 };
  var REQUEST_CAP = 512;
  var GEO = /GEOLOCATION|RESTRICTED_NETWORK_REGION|ANONYMIZED_NETWORK|451/;

  function oidOf(o) { return o && (o.order || o.orderId); }

  /* ------------------------------------------------------------ one market's book */
  function emptyBook() { return { seq: null, orders: {}, byOutcome: {} }; }
  function loadSnapshot(book, snap) {
    book.orders = {}; book.byOutcome = {};
    Object.keys((snap && snap.orders) || {}).forEach(function (outcome) {
      book.byOutcome[outcome] = [];
      (snap.orders[outcome] || []).forEach(function (o) {
        var id = oidOf(o);
        book.orders[id] = { outcome: outcome, price: String(o.price), qty: Number(o.qty) };
        book.byOutcome[outcome].push(id);
      });
    });
    book.seq = Number(snap.seq);
  }
  /** one batch of deltas, atomically: validated first, then applied, so a bad batch changes nothing */
  function applyBookBatch(book, deltas) {
    var orders = Object.assign({}, book.orders), by = {}, removedAt = {};
    Object.keys(book.byOutcome).forEach(function (k) { by[k] = book.byOutcome[k].slice(); });
    for (var i = 0; i < (deltas || []).length; i++) {
      var d = deltas[i], id = oidOf(d);
      if (d.kind === 'add') {
        if (!d.outcome || d.price == null || !(Number(d.qty) > 0)) return { ok: false, reason: 'malformed add' };
        if (orders[id]) return { ok: false, reason: 'add of an order already resting (' + id + ')' };
        orders[id] = { outcome: d.outcome, price: String(d.price), qty: Number(d.qty) };
        var list = by[d.outcome] = by[d.outcome] || [];
        var back = removedAt[id];
        if (back && back.outcome === d.outcome && Number(back.price) === Number(d.price)) {
          /* a partial fill: the remainder keeps its price AND its queue position (book.md) */
          list.splice(Math.min(back.index, list.length), 0, id);
        } else {
          /* a new order joins the back of its price level: after every order at a better or equal price */
          var pm = Number(d.price), at = list.length;
          for (var j = 0; j < list.length; j++) { if (Number(orders[list[j]].price) < pm) { at = j; break; } }
          list.splice(at, 0, id);
        }
        delete removedAt[id];
      } else if (d.kind === 'remove') {
        if (!orders[id]) return { ok: false, reason: 'remove of an unknown order (' + id + ')' };
        var o = orders[id], l = by[o.outcome] || [], ix = l.indexOf(id);
        if (ix >= 0) l.splice(ix, 1);
        removedAt[id] = { outcome: o.outcome, price: o.price, index: ix };
        delete orders[id];
      } else return { ok: false, reason: 'unknown delta kind ' + d.kind };
    }
    book.orders = orders; book.byOutcome = by;
    return { ok: true };
  }
  /** the book in Novig's REST shape ({orders: {outcome: [{orderId, price, qty}]}}), best first */
  function bookView(book, marketId) {
    var out = { marketId: marketId, seq: book.seq, orders: {} };
    Object.keys(book.byOutcome).forEach(function (k) {
      out.orders[k] = book.byOutcome[k].map(function (id) { var o = book.orders[id]; return { orderId: id, price: o.price, qty: o.qty }; });
    });
    return out;
  }

  /* ------------------------------------------------------------ the stream */
  function create(opts) {
    var o = opts || {};
    var send = o.send || function () {};
    var emit = o.emit || function () {};
    var S = { nonce: 0, markets: {}, wanted: [], pending: {}, stats: { snapshots: 0, deltas: 0, gaps: 0, resnapshots: 0, stale: 0, reconnects: 0, rejected: 0, overflow: 0 }, stopped: null, connected: false };

    function nextNonce() { S.nonce += 1; return S.nonce; }
    function market(id) { return S.markets[id] = S.markets[id] || { book: emptyBook(), lifecycle: { seq: null, status: null, live: false }, buffer: [], resyncing: false, eventId: null }; }

    /** subscribe to `ids` on book, nearest first, under the per-request cap and the watch limit */
    function subscribe(ids, maxWatched) {
      var cap = Math.floor(REQUEST_CAP / COST.book);
      var limit = maxWatched == null ? Infinity : Number(maxWatched);
      var room = Math.max(0, limit - Object.keys(S.markets).length - Object.keys(S.pending).reduce(function (n, k) { return n + S.pending[k].markets.length; }, 0));
      var todo = ids.filter(function (id) { return !S.markets[id]; });
      var fit = todo.slice(0, room), over = todo.slice(room);
      if (over.length) { S.stats.overflow += over.length; emit('overflow', { markets: over, limit: limit }); }
      var sent = [];
      for (var i = 0; i < fit.length; i += cap) {
        var chunk = fit.slice(i, i + cap), sel = {};
        chunk.forEach(function (id) { sel[id] = 'book'; });
        var n = nextNonce();
        S.pending[n] = { verb: 'subscribe', markets: chunk };
        send({ nonce: n, subscribe: { markets: sel } });
        sent.push({ nonce: n, markets: chunk.length, tokens: chunk.length * COST.book });
      }
      return { sent: sent, overflow: over };
    }
    function unsubscribe(ids) {
      if (!ids.length) return null;
      var n = nextNonce();
      S.pending[n] = { verb: 'unsubscribe', markets: ids };
      ids.forEach(function (id) { delete S.markets[id]; });
      send({ nonce: n, unsubscribe: ids.map(function (id) { return 'market:' + id; }) });
      return n;
    }
    function requestSnapshot(id) {
      var m = market(id);
      if (m.resyncing) return;
      m.resyncing = true; S.stats.resnapshots++;
      var n = nextNonce(), sel = {}; sel[id] = 'book';
      S.pending[n] = { verb: 'snapshot', markets: [id] };
      send({ nonce: n, snapshot: { markets: sel } });
    }

    function onSnapshot(snap) {
      Object.keys(snap || {}).forEach(function (id) {
        var s = snap[id], m = market(id);
        if (s.eventId) m.eventId = s.eventId;
        if (s.lifecycle) { m.lifecycle.seq = Number(s.lifecycle.seq); m.lifecycle.status = s.lifecycle.status || m.lifecycle.status; }
        if (s.book) {
          loadSnapshot(m.book, s.book);
          S.stats.snapshots++;
          /* replay what was buffered during the gap: drop what the snapshot already covers */
          var buf = m.buffer.filter(function (d) { return d.seq > m.book.seq; }).sort(function (a, b) { return a.seq - b.seq; });
          m.buffer = []; m.resyncing = false;
          buf.forEach(function (d) { onBookDelta(id, d); });
          emit('book', { marketId: id, book: bookView(m.book, id), reason: 'snapshot' });
        }
      });
    }
    function onBookDelta(id, b) {
      var m = market(id), seq = Number(b.seq);
      /* a market that opened under an event subscription: no snapshot, its book starts at 0 */
      if (m.book.seq === null && seq === 1 && !m.resyncing) { m.book.seq = 0; }
      if (m.book.seq === null || m.resyncing) { m.buffer.push(b); if (!m.resyncing) requestSnapshot(id); return; }
      if (seq <= m.book.seq) { S.stats.stale++; return; }
      if (seq > m.book.seq + 1) {
        S.stats.gaps++;
        emit('gap', { marketId: id, expected: m.book.seq + 1, got: seq });
        m.buffer.push(b);
        requestSnapshot(id);
        return;
      }
      var r = applyBookBatch(m.book, b.deltas);
      if (!r.ok) { S.stats.rejected++; emit('gap', { marketId: id, reason: r.reason }); m.buffer.push(b); requestSnapshot(id); return; }
      m.book.seq = seq; S.stats.deltas++;
      emit('book', { marketId: id, book: bookView(m.book, id), reason: 'delta' });
    }
    function onLifecycleDelta(id, l) {
      var m = market(id), seq = Number(l.seq);
      if (m.lifecycle.seq !== null && seq <= m.lifecycle.seq) return;
      m.lifecycle.seq = seq;
      (l.deltas || []).forEach(function (d) {
        if (d.status) m.lifecycle.status = d.status;
        if (d.kind === 'GOLIVE') m.lifecycle.live = true;
        if (d.kind === 'UNLIVE') m.lifecycle.live = false;
        emit('lifecycle', { marketId: id, kind: d.kind, status: m.lifecycle.status, live: m.lifecycle.live });
        if (d.kind === 'GRADE') { emit('settled', { marketId: id }); unsubscribe([id]); }
      });
    }

    /** one message from the socket (already parsed) */
    function onMessage(msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.code && (msg.nonce == null || S.pending[msg.nonce])) {
        var p = msg.nonce != null ? S.pending[msg.nonce] : null;
        if (p) delete S.pending[msg.nonce];
        emit('error', { code: msg.code, message: msg.message || null, request: p ? p.verb : null, markets: p ? p.markets : null });
        if (p && p.verb === 'snapshot') p.markets.forEach(function (id) { if (S.markets[id]) S.markets[id].resyncing = false; });
        return;
      }
      if (msg.nonce != null && S.pending[msg.nonce]) delete S.pending[msg.nonce];
      if (msg.snapshot) onSnapshot(msg.snapshot);
      if (msg.delta) {
        Object.keys(msg.delta).forEach(function (id) {
          var d = msg.delta[id];
          if (!S.markets[id] && !d.lifecycle) return;   /* not ours (an unsubscribed market's tail) */
          if (d.eventId) market(id).eventId = d.eventId;
          if (d.lifecycle) onLifecycleDelta(id, d.lifecycle);
          if (d.book && S.markets[id]) onBookDelta(id, d.book);
        });
      }
    }
    /** the socket opened: every wanted market is subscribed again, from nothing */
    function onOpen(wanted, maxWatched) {
      S.connected = true; S.markets = {}; S.pending = {}; S.nonce = 0;
      S.wanted = wanted || S.wanted;
      return subscribe(S.wanted, maxWatched);
    }
    /** the socket closed: a geolocation close stops; anything else reconnects after backoff */
    function onClose(code, reason) {
      S.connected = false;
      if (GEO.test(String(reason || ''))) { S.stopped = { code: code, reason: String(reason) }; emit('stopped', S.stopped); return { reconnect: false, why: 'geolocation: not retried (Novig: repeated 451s can lock the account)' }; }
      S.stats.reconnects++;
      return { reconnect: true, delay_ms: backoff(S.stats.reconnects, o.random), why: code === 1008 ? 'SLOW_CONSUMER: reconnect and subscribe again' : 'closed (' + code + '): reconnect' };
    }

    return {
      state: S, subscribe: subscribe, unsubscribe: unsubscribe, requestSnapshot: requestSnapshot, onMessage: onMessage, onOpen: onOpen, onClose: onClose,
      book: function (id) { return S.markets[id] ? bookView(S.markets[id].book, id) : null; },
      lifecycle: function (id) { return S.markets[id] ? Object.assign({}, S.markets[id].lifecycle) : null; },
      status: function () { var n = nextNonce(); send({ nonce: n, status: {} }); return n; }
    };
  }
  /** reconnect delay: 1 s doubling to 60 s, ±50% jitter */
  function backoff(attempt, random) {
    var base = Math.min(60000, 1000 * Math.pow(2, Math.max(0, attempt - 1)));
    var r = typeof random === 'function' ? random() : Math.random();
    return Math.round(base * (0.5 + r));
  }

  return { create: create, backoff: backoff, applyBookBatch: applyBookBatch, loadSnapshot: loadSnapshot, emptyBook: emptyBook, bookView: bookView, COST: COST, REQUEST_CAP: REQUEST_CAP };
});
