#!/usr/bin/env node
/* ===========================================================================
   The Novig STREAM worker: lib/novig_stream.js on a real socket, writing
   changed books into the same table the REST sync writes
   (public.novig_book_snapshots, source 'ws_book'). docs/novig/README.md
   §Streaming.

   OFF BY DEFAULT, AND NOT A SUPABASE EDGE FUNCTION. A websocket that has to
   stay open for hours cannot live in an Edge Function (150 s wall clock on
   the Free plan, 400 s on paid: supabase.com/docs/guides/functions/limits),
   and Novig warns that hosted runners with rotating addresses (GitHub
   Actions, serverless platforms) meet 451 RESTRICTED_NETWORK_REGION on and
   off (docs.novig.com/api/errors.md). So this runs only on a persistent
   host with a fixed US address Novig admits, under a process supervisor
   that restarts it, and only with every one of these set:
     NOVIG_STREAM_ENABLED=true
     NOVIG_ENV=production|paper
     NOVIG_STREAM_KEY_ID, NOVIG_STREAM_PRIVATE_KEY   a trading::read key on an
                                    EXISTING subaccount (novig-provision.yml)
     SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
   Until then the REST sync (every 5 minutes) is the source, and the cards
   say "Recently updated", never "Live".

   WHAT IT DOES. Subscribes to the book channel of every active linked
   market whose game is within 48 h (nearest first, under the watch limit
   from GET /v3/limits); keeps each book exact (seq, gaps, resnapshots,
   lifecycle — lib/novig_stream.js); every 15 s writes the books that changed
   (the same row the REST sync writes: top of book, the standard stakes'
   fills, depth; a seq already stored is skipped by the unique index); every
   10 min refreshes the market list and records a run (mode 'stream') with
   its counters and alerts. A geolocation close stops it and halts the REST
   sync too (novig_sync_runs.halt_until); any other close reconnects with
   backoff. Read-only: it never sends place, cancel or cancel_all.

   Run: node tools/novig/stream_worker.js   (no dependency: Node 22's own
   WebSocket, fetch and WebCrypto)
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const NS = require(path.join(ROOT, 'lib', 'novig_signing.js'));
const EV = require(path.join(ROOT, 'lib', 'edgedesk_venue_compare.js'));
const STREAM = require(path.join(ROOT, 'lib', 'novig_stream.js'));

const FLUSH_MS = 15000, REFRESH_MS = 600000, WINDOW_H = 48;

function config(env) {
  const e = env || process.env;
  const missing = ['NOVIG_ENV', 'NOVIG_STREAM_KEY_ID', 'NOVIG_STREAM_PRIVATE_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter((k) => !e[k]);
  if (e.NOVIG_STREAM_ENABLED !== 'true') return { enabled: false, why: 'NOVIG_STREAM_ENABLED is not true: the stream is off (the REST sync is the source)' };
  if (missing.length) return { enabled: false, why: 'missing ' + missing.join(', ') };
  if (e.NOVIG_ENV !== 'production' && e.NOVIG_ENV !== 'paper') return { enabled: false, why: 'NOVIG_ENV must be production or paper' };
  return { enabled: true, env: e.NOVIG_ENV, keyId: e.NOVIG_STREAM_KEY_ID, pem: e.NOVIG_STREAM_PRIVATE_KEY, sbUrl: e.SUPABASE_URL.replace(/\/$/, ''), sbKey: e.SUPABASE_SERVICE_ROLE_KEY };
}

/** the stored row of one book (the shape novig_sync's snapshotOf writes) */
function rowOf(market, book, live, env, at, runId) {
  const ids = (market.outcomes || []).map((o) => o.outcomeId);
  const fee = { coefficient: market.fee_coefficient, makerCredit: market.fee_maker_credit, charged: market.fee_charged };
  const eventStatus = live ? 'OPEN_INGAME' : 'OPEN_PREGAME';
  const top = {}, exec = {};
  for (const id of ids) {
    const bids = EV.levelsOf(book.orders[id]), ob = EV.levelsOf(book.orders[ids.find((x) => x !== id)]);
    top[id] = { bid: bids[0] ? EV.milliStr(bids[0].m) : null, bid_qty: bids[0] ? bids[0].qty : null, ask: ob[0] ? EV.milliStr(1000 - ob[0].m) : null, ask_qty: ob[0] ? ob[0].qty : null };
    const q = EV.executableQuote(book, id, ids, { fee, eventStatus });
    exec[id] = {};
    if (q.ok) for (const s of q.stakes) exec[id][String(s.stake_dollars)] = [s.status, s.contracts || 0, s.total || null, s.payout || null, s.unspent || null, s.vwap || null];
  }
  return { row: { environment: env, market_id: market.market_id, captured_at: at, source: 'ws_book', book_seq: Number(book.seq), event_status: eventStatus, market_status: 'OPEN',
    fee_charged_now: EV.feeCharged(fee, eventStatus).charged, top, exec, levels: null, run_id: runId }, depth: EV.compactDepth(book) };
}

function startWorker(deps) {
  const d = Object.assign({ now: () => Date.now(), setTimer: setInterval, clearTimer: clearInterval, WebSocket: globalThis.WebSocket, fetch: globalThis.fetch, log: (s) => console.log(s), random: Math.random, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }, deps || {});
  const cfg = d.config || config();
  if (!cfg.enabled) { d.log('novig stream: ' + cfg.why); return { stopped: true, why: cfg.why }; }
  const host = NS.hostFor(cfg.env), wsHost = host.replace(/^https:/, 'wss:');
  const db = async (p, init) => {
    const r = await d.fetch(cfg.sbUrl + '/rest/v1/' + p, Object.assign({}, init, { headers: Object.assign({ apikey: cfg.sbKey, authorization: 'Bearer ' + cfg.sbKey, 'content-type': 'application/json' }, (init && init.headers) || {}) }));
    const t = await r.text(); if (!r.ok) throw new Error('db ' + r.status + ' ' + p.split('?')[0] + ': ' + t.slice(0, 200)); return t ? JSON.parse(t) : null;
  };
  const W = { runId: (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(d.now()), markets: {}, dirty: new Set(), ws: null, signer: null, alerts: [], startedAt: new Date(d.now()).toISOString(), stopped: null, timers: [] };
  const alert = (severity, code, message, detail) => { W.alerts.push({ severity, code, message: String(message).slice(0, 600), detail: detail || null }); d.log('novig stream ' + severity + ' ' + code + ': ' + message); };
  const st = STREAM.create({
    send: (m) => { if (W.ws && W.ws.readyState === 1) W.ws.send(JSON.stringify(m)); },
    random: d.random,
    emit: (kind, x) => {
      if (kind === 'book') W.dirty.add(x.marketId);
      else if (kind === 'gap') alert('WARNING', 'stream_gap', 'seq gap on ' + x.marketId + (x.reason ? ' (' + x.reason + ')' : ': expected ' + x.expected + ', got ' + x.got) + '; resnapshot requested');
      else if (kind === 'overflow') alert('WARNING', 'stream_overflow', x.markets.length + ' market(s) did not fit the watch limit (' + x.limit + ')');
      else if (kind === 'error') alert(x.code === 'RATE_LIMIT_EXCEEDED' ? 'WARNING' : 'DEGRADED', 'stream_error', (x.request || 'request') + ' refused: ' + x.code + (x.message ? ' ' + x.message : ''));
      else if (kind === 'settled') { delete W.markets[x.marketId]; }
    },
  });
  async function wanted() {
    const now = d.now();
    const links = await db('novig_market_links?select=market_id,kickoff_at&environment=eq.' + cfg.env + '&invalidated_at=is.null&kickoff_at=gte.' + encodeURIComponent(new Date(now - 6 * 3600e3).toISOString())
      + '&kickoff_at=lte.' + encodeURIComponent(new Date(now + WINDOW_H * 3600e3).toISOString()) + '&order=kickoff_at&limit=2000');
    const ids = links.map((l) => l.market_id);
    const out = [];
    for (let i = 0; i < ids.length; i += 150) {
      const ms = await db('novig_markets?select=market_id,outcomes,fee_coefficient,fee_maker_credit,fee_charged,gone_at,status&market_id=in.(' + ids.slice(i, i + 150).map((x) => '"' + x + '"').join(',') + ')');
      for (const m of ms) if (!m.gone_at && (!m.status || m.status === 'OPEN')) { W.markets[m.market_id] = m; out.push(m.market_id); }
    }
    return ids.filter((id) => out.includes(id));
  }
  async function signed(method, p) {
    W.signer = W.signer || await NS.importPrivateKey(cfg.pem);
    return NS.signRequest({ host, keyId: cfg.keyId, signer: W.signer, method, path: p, query: '', nowMs: d.now() });
  }
  async function flush() {
    const ids = [...W.dirty]; W.dirty.clear();
    if (!ids.length) return 0;
    const at = new Date(d.now()).toISOString(), rows = [], depth = {};
    for (const id of ids) {
      const b = st.book(id), m = W.markets[id];
      if (!b || !m || b.seq == null) continue;
      const r = rowOf(m, b, !!(st.lifecycle(id) || {}).live, cfg.env, at, W.runId);
      rows.push(r.row); depth[id + '|' + r.row.book_seq] = r.depth;
    }
    if (!rows.length) return 0;
    const ins = await db('novig_book_snapshots?on_conflict=environment,market_id,source,book_seq', { method: 'POST', body: JSON.stringify(rows), headers: { prefer: 'return=representation,resolution=ignore-duplicates' } }) || [];
    if (ins.length) await db('novig_book_depth', { method: 'POST', body: JSON.stringify(ins.map((s) => ({ snapshot_id: s.id, market_id: s.market_id, captured_at: s.captured_at, depth: depth[s.market_id + '|' + s.book_seq] }))), headers: { prefer: 'return=minimal' } });
    return ins.length;
  }
  async function record(status, extra) {
    const s = st.state.stats;
    const run = Object.assign({ run_id: W.runId, build: 'novig_stream_worker@2026-10-30.1', trigger: 'stream', mode: 'stream', environment: cfg.env, status, started_at: W.startedAt,
      finished_at: new Date(d.now()).toISOString(), details: Object.assign({ stats: s, watched: Object.keys(st.state.markets).length }, extra || {}) }, extra && extra.halt_until ? { halt_until: extra.halt_until, halt_reason: extra.halt_reason } : {});
    try {
      await db('novig_sync_runs', { method: 'POST', body: JSON.stringify([run]), headers: { prefer: 'return=minimal' } });
      if (W.alerts.length) await db('novig_alerts', { method: 'POST', body: JSON.stringify(W.alerts.map((a) => Object.assign({ run_id: W.runId }, a))), headers: { prefer: 'return=minimal' } });
    } catch (e) { d.log('novig stream: the run could not be recorded: ' + e.message); }
    W.alerts = []; W.runId = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(d.now()); W.startedAt = new Date(d.now()).toISOString();
  }
  async function connect() {
    let maxWatched = null;
    try {
      const l = await signed('GET', '/v3/limits');
      const r = await d.fetch(l.url, { headers: Object.assign({ accept: 'application/json', 'user-agent': 'edgedesk-stream/1.0' }, l.headers) });
      if (r.ok) maxWatched = (await r.json()).maxWatchedMarkets || null;
      else if (r.status === 451 || r.status === 423 || r.status === 401) { const t = await r.text(); return stop(r.status, 'GET /v3/limits answered ' + r.status + ' ' + t.slice(0, 160)); }
    } catch (e) { d.log('novig stream: limits unread (' + e.message + ')'); }
    const ids = await wanted();
    const s = await signed('GET', '/v3/ws');
    const ws = W.ws = new d.WebSocket((d.wsUrl || wsHost) + '/v3/ws', { headers: Object.assign({ 'user-agent': 'edgedesk-stream/1.0' }, s.headers) });
    ws.onopen = () => { const sub = st.onOpen(ids, maxWatched); d.log('novig stream: connected; ' + ids.length + ' market(s) wanted, ' + sub.sent.length + ' subscribe request(s)'); };
    ws.onmessage = (ev) => { try { st.onMessage(JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString())); } catch (e) { alert('DRIFT', 'stream_message', 'a message could not be read: ' + e.message); } };
    ws.onerror = () => {};
    ws.onclose = async (ev) => {
      if (W.stopped) return;
      const r = st.onClose(ev.code, ev.reason);
      if (!r.reconnect) return stop(451, 'the stream was closed for geolocation (' + ev.reason + '): not retried');
      alert('WARNING', 'stream_disconnect', 'closed ' + ev.code + (ev.reason ? ' ' + ev.reason : '') + ': reconnecting in ' + Math.round(r.delay_ms / 1000) + ' s');
      await d.sleep(r.delay_ms);
      if (!W.stopped) connect().catch((e) => alert('DEGRADED', 'stream_reconnect', e.message));
    };
  }
  async function stop(status, why) {
    W.stopped = { status, why };
    alert('FAILURE', status === 451 ? 'geolocation_stream' : 'stream_stopped', why);
    for (const t of W.timers) d.clearTimer(t);
    try { if (W.ws) W.ws.close(1000, 'stopping'); } catch (_) { /* closed */ }
    const halt = status === 451 || status === 423 ? new Date(d.now() + 6 * 3600e3).toISOString() : null;
    await record('error', halt ? { halt_until: halt, halt_reason: status + ' (stream): ' + why.slice(0, 200) } : {});
    return { stopped: true, why };
  }
  W.timers.push(d.setTimer(() => { flush().catch((e) => alert('DEGRADED', 'stream_write', e.message)); }, FLUSH_MS));
  W.timers.push(d.setTimer(async () => {
    try {
      const ids = await wanted();
      const gone = Object.keys(st.state.markets).filter((id) => !ids.includes(id));
      st.unsubscribe(gone); st.subscribe(ids);
      await record(W.alerts.some((a) => a.severity === 'DEGRADED') ? 'warn' : 'ok');
    } catch (e) { alert('DEGRADED', 'stream_refresh', e.message); }
  }, REFRESH_MS));
  return { connect, flush, record, stop, state: st, worker: W };
}

if (require.main === module) {
  const w = startWorker();
  if (w.stopped) process.exit(0);
  w.connect().catch((e) => { console.log('novig stream: ' + e.message); process.exit(1); });
  const bye = () => { w.flush().finally(() => w.record('ok').finally(() => process.exit(0))); };
  process.on('SIGTERM', bye); process.on('SIGINT', bye);
}
module.exports = { config, rowOf, startWorker };
