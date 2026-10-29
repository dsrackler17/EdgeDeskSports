#!/usr/bin/env node
/* ===========================================================================
   supabase/functions/polymarket_sync/index.ts, tested as deployed: imported
   (not a copy) under Node's type stripping, with a Deno shim, writing into
   the SHIPPED supabase/radar.sql on a real PostgreSQL through a PostgREST
   stand-in (tools/radar/_pgrest.js), so every guard, check and append-only
   trigger is the real one. Polymarket is a scripted world built here (a
   SCENARIO, constructed in the shapes the parsers read; the shapes
   themselves are checked against recorded responses in core.test.js); any
   other host fails the suite.

     copy      the inlined core and gateway match lib/ byte for byte
     auth      GET is a probe; POST needs the cron secret; a bad mode is 400
     switch    either half of POLYMARKET_DATA_ENABLED off: skipped, nothing asked
     pool      the leaderboard's top wallets in; a wallet that drops out, out
     wallets   activity since the cursor; only covered trades stored, with
               their hashes; each resolved bet graded once (close, CLV, the
               5- and 15-minute follow); a re-read adds nothing; a history
               over 30 pages is truncated
     grade     one versioned run: ranks by score, the market maker ranked but
               never top-graded, the small sample unranked
     tonight   markets matched to EdgeDesk games once (or pending with a
               reason); holders stored for pool wallets only; names only when
               public; prices; a started game's resolution; the card; the
               Radar record (a warning while radar_record.sql is not applied,
               then each card published once)
     budget    the run's grant is the ceiling: a short grant stops it with a
               DEGRADED alert, and the settlement records what was used
     breaker   six 429s in a row: the breaker opens, the next run is refused
     drift     a row the parsers cannot read is counted and alerted, never stored

   Run: node tools/radar/sync_fn.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const PG = require(path.join(ROOT, 'tools', 'personal', '_pg.js'));
const REST = require(path.join(__dirname, '_pgrest.js'));
const T = PG.kit('radar sync function');
const chk = T.chk, lit = PG.lit;

const ENV = { SUPABASE_URL: 'https://stub.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key', POLYMARKET_SYNC_SECRET: 'cron-secret', POLYMARKET_DATA_ENABLED: 'on', POLYMARKET_SYNC_NO_SERVE: '1' };
globalThis.Deno = { env: { get: (k) => ENV[k] } };
chk('copy: the inlined core and gateway match lib/ (node tools/radar/inline_core.js)', require(path.join(__dirname, 'inline_core.js')).current());

const db = PG.start('radarfn');
if (db.skip) { if (process.env.RADAR_SQL_REQUIRED === '1') chk('environment: ' + db.skip, false); console.log('SKIPPED | ' + db.skip + ' — not verified'); process.exit(T.done()); }

/* ── the scripted Polymarket ─────────────────────────────────────────── */
const NOW = Math.floor(Date.now() / 60000) * 60000, H = 3600e3, MIN = 60e3, DAY = 864e5;   /* whole minutes, as the price history's points are */
const w = (i) => '0x' + String(i).padStart(40, '0');
const cid = (i) => '0x' + crypto.createHash('sha256').update('cond' + i).digest('hex');
const txh = (s) => '0x' + crypto.createHash('sha256').update('tx' + s).digest('hex');
const tok = (c, o) => String(BigInt('0x' + crypto.createHash('sha256').update(c + ':' + o).digest('hex').slice(0, 20)));
const gt = (ms) => new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '+00');   /* Gamma's "2026-10-30 00:15:00+00" */
const POOL = [1, 2, 3, 4, 5, 6].map(w);
const [W1, W2, W3, W4, W5, W6] = POOL;
const OUTSIDER = w(99);
const W7 = w(7);   /* joins the pool late, for the time-budget checks */
/* 60 past NFL games, each a moneyline resolved for its first outcome when g is even */
const PAST = [];
for (let g = 0; g < 60; g++) {
  const c = cid('past' + g), start = NOW - (61 - g) * DAY;
  PAST.push({ c, start, settle: g % 2 === 0 ? ['1', '0'] : ['0', '1'], tokens: [tok(c, 0), tok(c, 1)], slug: 'nfl-aaa-bbb-' + g });
}
const EPL = { c: cid('epl'), start: NOW - 5 * DAY, tokens: [tok(cid('epl'), 0), tok(cid('epl'), 1)] };
const gammaMarket = (m, o) => Object.assign({ id: 'm-' + m.c.slice(2, 8), conditionId: m.c, question: 'Chiefs vs. Raiders', slug: m.slug, outcomes: '["Chiefs", "Raiders"]',
  outcomePrices: JSON.stringify(m.settle || ['0.5', '0.5']), clobTokenIds: JSON.stringify(m.tokens), sportsMarketType: 'moneyline', gameStartTime: gt(m.start),
  closed: !!m.settle, active: !m.settle, umaResolutionStatus: m.settle ? 'resolved' : null, events: [{ id: 'ev-' + m.c.slice(2, 8), slug: m.slug, title: 'Chiefs vs. Raiders', tags: [{ slug: 'nfl', label: 'NFL' }] }] }, o || {});
/* each wallet's activity: W1-W3 buy outcome 0 of every past game 2 h before the start (directional);
   W5 buys BOTH outcomes many times (a market maker); W6 only 10 games (a small sample); W4's history never ends */
function activityFor(user) {
  const rows = [];
  const tr = (m, oi, side, size, price, at, k) => rows.push({ proxy_wallet: user, type: 'TRADE', side, size: String(size), price: String(price), usdc_size: String(size * price),
    timestamp: Math.floor(at / 1000), transaction_hash: txh(user + m.c + oi + side + k), condition_id: m.c, asset: m.tokens[oi], outcome_index: oi,
    outcome: oi ? 'Raiders' : 'Chiefs', title: 'Chiefs vs. Raiders', slug: m.slug, event_slug: m.slug });
  if ([W1, W2, W3, W7].includes(user)) PAST.forEach((m, g) => tr(m, 0, 'BUY', 100 + (user === W1 ? 10 * g : 0), 0.5, m.start - 2 * H, 'a'));
  if (user === W5) PAST.forEach((m) => { for (let k = 0; k < 4; k++) { tr(m, 0, 'BUY', 100, 0.5, m.start - (3 - k * 0.1) * H, 'm' + k); tr(m, 1, 'BUY', 95, 0.5, m.start - (3 - k * 0.1) * H, 'n' + k); } });
  if (user === W6) PAST.slice(0, 10).forEach((m) => tr(m, 1, 'BUY', 50, 0.5, m.start - H, 'b'));
  if (user === W1) rows.push({ proxy_wallet: user, type: 'TRADE', side: 'BUY', size: '10', price: '0.4', timestamp: Math.floor((EPL.start - H) / 1000), transaction_hash: txh('epl'),
    condition_id: EPL.c, asset: EPL.tokens[0], outcome_index: 0, slug: 'epl-ars-che', event_slug: 'epl-ars-che' });
  return rows.sort((a, b) => a.timestamp - b.timestamp);
}
/* each token's price: 0.50 until 1 h 55 m before the start, then 0.55, then 0.58 from 30 minutes before */
function historyFor(token, startTs, endTs) {
  const m = PAST.find((x) => x.tokens.includes(token));
  if (!m) return { history: [] };
  const pts = [];
  for (let t = startTs; t <= endTs; t += 60) {
    const ms = t * 1000;
    const p0 = ms < m.start - 115 * MIN ? 0.5 : ms < m.start - 30 * MIN ? 0.55 : 0.58;
    pts.push({ t, p: m.tokens[0] === token ? p0 : Math.round((1 - p0) * 100) / 100 });
  }
  return { history: pts };
}
/* tonight: KC @ LV in 3 h (on the board), and Patriots vs. Jets in 5 h, whose teams are not the board's */
const LIVE = { c: cid('live-ml'), start: NOW + 3 * H, tokens: [tok(cid('live-ml'), 0), tok(cid('live-ml'), 1)], slug: 'nfl-kc-lv-live' };
const LIVE_TOT = { c: cid('live-tot'), start: NOW + 3 * H, tokens: [tok(cid('live-tot'), 0), tok(cid('live-tot'), 1)], slug: 'nfl-kc-lv-live' };
const ORPHAN = { c: cid('orphan'), start: NOW + 5 * H, tokens: [tok(cid('orphan'), 0), tok(cid('orphan'), 1)], slug: 'nfl-ne-nyj-live' };
/* an alternate total of the same game, at a line the board does not carry; and a game nine days out */
const LIVE_ALT = { c: cid('live-alt'), start: NOW + 3 * H, tokens: [tok(cid('live-alt'), 0), tok(cid('live-alt'), 1)], slug: 'nfl-kc-lv-live' };
const FAR = { c: cid('far'), start: NOW + 9 * DAY, tokens: [tok(cid('far'), 0), tok(cid('far'), 1)], slug: 'nfl-buf-mia-far' };
const BULK = Array.from({ length: 1200 }, (_, i) => { const c = cid('bulk' + i); return { c, start: NOW + 3 * H, tokens: [tok(c, 0), tok(c, 1)], slug: 'nfl-kc-lv-bulk' }; });
const STARTED = { c: cid('started'), start: NOW - 20 * H, tokens: [tok(cid('started'), 0), tok(cid('started'), 1)], slug: 'nfl-den-sea-done', settle: ['1', '0'] };
let scenario = {};
let fake = 0;   /* fake milliseconds the function's clock is ahead of the real one: scenario.costMs per Polymarket request */
const pmCalls = [], strays = [];
function polymarket(url) {
  const u = new URL(url), p = u.pathname, q = (k) => u.searchParams.get(k);
  pmCalls.push(u.host + p + u.search);
  fake += scenario.costMs || 0;
  const ok = (b) => ({ status: 200, body: b });
  if (scenario.rateLimit && scenario.rateLimit.test(p)) return { status: 429, body: { error: 'rate limited' }, headers: { 'retry-after': '1' } };
  if (u.host === 'data-api.polymarket.com' && p === '/v1/leaderboard') {
    const list = (scenario.leaderboard || POOL).map((x, i) => ({ rank: String(i + 1), proxyWallet: x, userName: 'user' + i, vol: 1e6 - i, pnl: 1000 - i, profileImage: '', xUsername: '', verifiedBadge: false }));
    const off = +q('offset'); return ok(list.slice(off, off + +q('limit')));
  }
  if (u.host === 'data-api.polymarket.com' && p === '/v2/activity') {
    const user = q('user');
    /* what the wallet's row says while its run reads it (the attempt mark must be written before the work) */
    if (scenario.watchAttempt === user) scenario.seenAttempt = db.sql(`select coalesce(activity_cursor ->> 'attempts', '-') from public.poly_wallets where wallet = ${lit(user)}`);
    if (user === W4) return ok({ data: [], pagination: { has_more: true, next_cursor: 'c' + Math.random() } });
    let rows = activityFor(user).filter((r) => r.timestamp >= +q('start'));
    if (scenario.drift && user === W1) rows = rows.concat([{ type: 'TRADE', side: 'BUY', size: '1', price: '0.5', timestamp: Math.floor(NOW / 1000), condition_id: PAST[0].c, asset: PAST[0].tokens[0] }]);
    return ok({ data: rows, pagination: { has_more: false, next_cursor: null } });
  }
  if (u.host === 'data-api.polymarket.com' && p === '/v2/holders') {
    const c = q('condition');
    /* as the real one answers (radar-sources run 40812803914) */
    if (q('include_pnl') === 'true' && +q('limit') > 100) return { status: 400, body: { error: 'limit must be at most 100 with include_pnl', code: 'invalid_request', parameter: 'limit', retryable: false } };
    if (c === LIVE.c) return ok({ data: [
      { token_id: LIVE.tokens[0], holders: [
        { proxy_wallet: W1, outcome_index: 0, amount: 1000, avg_price: 0.4, display_username_public: true, name: 'SharpAlice', pseudonym: 'Brisk-Fox', bio: 'never stored' },
        { proxy_wallet: W2, outcome_index: 0, amount: 500, avg_price: 0.44, display_username_public: false, name: 'HiddenBob' },
        { proxy_wallet: OUTSIDER, outcome_index: 0, amount: 9000, avg_price: 0.45, display_username_public: true, name: 'Whale' }] },
      { token_id: LIVE.tokens[1], holders: [{ proxy_wallet: W3, outcome_index: 1, amount: 100, avg_price: 0.6, display_username_public: false }] }] });
    return ok({ data: [] });
  }
  if (u.host === 'gamma-api.polymarket.com' && p === '/sports') return ok([{ id: 1, sport: 'nfl', series: '10187', tags: '1,450' }, { id: 2, sport: 'epl', series: '10188' }]);
  if (u.host === 'gamma-api.polymarket.com' && p === '/events') {
    if (q('series_id') !== '10187') return ok([]);
    /* as the real one answers: a game event's endDate is its start, and end_date_min / end_date_max window on it (radar-sources run 40812803914) */
    const all = [
      { id: 'e-live', slug: LIVE.slug, title: 'Chiefs vs. Raiders', startTime: gt(LIVE.start), endDate: new Date(LIVE.start).toISOString(), tags: [{ slug: 'nfl' }], markets: [
        gammaMarket(LIVE, { outcomePrices: '["0.6", "0.4"]', events: undefined }),
        gammaMarket(LIVE_TOT, { question: 'Chiefs vs. Raiders: O/U 47.5', outcomes: '["Over", "Under"]', sportsMarketType: 'totals', line: 47.5, outcomePrices: '["0.52", "0.48"]', events: undefined }),
        gammaMarket(LIVE_ALT, { question: 'Chiefs vs. Raiders: O/U 50.5', outcomes: '["Over", "Under"]', sportsMarketType: 'totals', line: 50.5, outcomePrices: '["0.4", "0.6"]', events: undefined })] },
      { id: 'e-orphan', slug: ORPHAN.slug, title: 'Patriots vs. Jets', startTime: gt(ORPHAN.start), endDate: new Date(ORPHAN.start).toISOString(), tags: [{ slug: 'nfl' }], markets: [
        gammaMarket(ORPHAN, { question: 'Patriots vs. Jets', outcomes: '["Patriots", "Jets"]', events: undefined })] },
      { id: 'e-far', slug: FAR.slug, title: 'Bills vs. Dolphins', startTime: gt(FAR.start), endDate: new Date(FAR.start).toISOString(), tags: [{ slug: 'nfl' }], markets: [
        gammaMarket(FAR, { question: 'Bills vs. Dolphins', outcomes: '["Bills", "Dolphins"]', events: undefined })] }];
    /* a full slate: the game's alternate totals, as many as a real night carries (production's first run, 2026-10-29) */
    if (scenario.bulk) all.push({ id: 'e-bulk', slug: 'nfl-kc-lv-bulk', title: 'Chiefs vs. Raiders', startTime: gt(LIVE.start), endDate: new Date(LIVE.start).toISOString(), tags: [{ slug: 'nfl' }],
      markets: BULK.slice(0, scenario.bulk).map((m, i) => gammaMarket(m, { question: 'Chiefs vs. Raiders: O/U ' + (60.5 + i), outcomes: '["Over", "Under"]', sportsMarketType: 'totals', line: 60.5 + i, outcomePrices: '["0.5", "0.5"]', events: undefined })) });
    const lo = q('end_date_min') ? Date.parse(q('end_date_min')) : -Infinity, hi = q('end_date_max') ? Date.parse(q('end_date_max')) : Infinity;
    const off = +(q('offset') || 0), lim = +(q('limit') || 100);
    return ok(all.filter((e) => Date.parse(e.endDate) >= lo && Date.parse(e.endDate) <= hi).slice(off, off + lim));
  }
  if (u.host === 'gamma-api.polymarket.com' && p === '/markets') {
    const ids = u.searchParams.getAll('condition_ids');
    const all = PAST.concat([STARTED]).map((m) => gammaMarket(m)).concat([gammaMarket(EPL, { slug: 'epl-ars-che', sportsMarketType: 'moneyline', events: [{ id: 'epl', slug: 'epl-ars-che', tags: [{ slug: 'epl' }] }] })]);
    /* as the real Gamma does (radar-sources run 40811733314): a resolved market
       only when asked with closed=true, an open one only without it */
    return ok(all.filter((m) => ids.includes(m.conditionId) && m.closed === (q('closed') === 'true')));
  }
  if (u.host === 'clob.polymarket.com' && p === '/prices-history') return ok(historyFor(q('market'), +q('startTs'), +q('endTs')));
  strays.push(url);
  return { status: 404, body: 'unscripted ' + url };
}
const resp = (r) => ({ ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: (k) => ((r.headers || {})[k.toLowerCase()] || null) },
  text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)), json: async () => r.body });

/* ── the database ────────────────────────────────────────────────────── */
const SUB = '00000000-0000-4000-8000-000000000002';
const J = (q) => JSON.parse(db.sql("select coalesce(json_agg(t), '[]'::json) from (" + q + ') t;') || '[]');
const V = (q) => db.sql(q);
let rest;
(async () => {
  try {
    V(`create table public.signals (sig_key text primary key, event_id text, sport_key text, commence_time timestamptz, home_team text, away_team text,
         market text, selection text, point numeric, sharp_fair numeric, last_seen_at timestamptz);
       create or replace function public.has_active_sub() returns boolean language sql stable as $$ select auth.uid() = ${lit(SUB)}::uuid $$;
       insert into auth.users (id, email) values (${lit(SUB)}, 's@x.co');`);
    const s = (k, m, sel, pt, fair) => `(${lit(k)}, 'ev1', 'americanfootball_nfl', now() + interval '3 hours', 'Las Vegas Raiders', 'Kansas City Chiefs', ${lit(m)}, ${lit(sel)}, ${pt == null ? 'null' : pt}, ${fair}, now() - interval '5 minutes')`;
    V('insert into public.signals values ' + [s('k1', 'h2h', 'Kansas City Chiefs', null, 0.62), s('k2', 'h2h', 'Las Vegas Raiders', null, 0.38), s('k3', 'totals', 'Over', 47.5, 0.5), s('k4', 'totals', 'Under', 47.5, 0.5)].join(', ') + ';');
    db.applyFileAtomic(path.join(ROOT, 'supabase', 'radar.sql'));
    rest = REST.make(db);
    let longestRest = 0;
    globalThis.fetch = async (url, init) => {
      url = String(url);
      /* as Deno's fetch does: its request URI holds at most 65,534 bytes, and a longer one is refused "Invalid URL" */
      const href = new URL(url).href;
      if (href.length > 65534) throw new TypeError('Invalid URL: ' + href.slice(0, 120));
      if (url.startsWith(ENV.SUPABASE_URL + '/rest/v1/')) { longestRest = Math.max(longestRest, href.length); return rest.fetch(url, init); }
      if (/\.polymarket\.com\//.test(url)) return resp(polymarket(url));
      strays.push(url);
      return resp({ status: 404, body: 'stray' });
    };
    let F;
    try { F = await import(path.join(ROOT, 'supabase', 'functions', 'polymarket_sync', 'index.ts')); }
    catch (e) { chk('the shipped function imports under Node\'s type stripping (Node 22+)', false, e && e.message); throw e; }
    F.hooks.sleep = async () => {};
    F.hooks.now = () => Date.now() + fake;
    const post = (body, secret) => F.handle(new Request('https://fn.local/polymarket_sync', { method: 'POST', headers: { 'x-cron-secret': secret == null ? 'cron-secret' : secret }, body: JSON.stringify(body) }));
    const go = async (mode) => (await post({ mode })).json();

    /* ── auth ── */
    const probe = await (await F.handle(new Request('https://fn.local/', { method: 'GET' }))).json();
    chk('GET is a health probe (build only)', probe.ok === true && /^polymarket_sync@/.test(probe.build) && probe.core === 'edgedesk_radar/1');
    chk('POST without the cron secret is 401', (await post({ mode: 'pool' }, '')).status === 401 && (await post({ mode: 'pool' }, 'wrong')).status === 401);
    chk('an unknown mode is 400', (await post({ mode: 'everything' })).status === 400);

    /* ── the switch ── */
    const off = await go('pool');
    chk('the database switch off: skipped, nothing asked of Polymarket', off.status === 'skipped' && /database: off/.test(off.message) && pmCalls.length === 0, off.message);
    db.service("update public.radar_config set value = 'on', note = 'test' where key = 'POLYMARKET_DATA_ENABLED';");
    ENV.POLYMARKET_DATA_ENABLED = 'off';
    const off2 = await go('pool');
    chk('the function\'s own switch off: skipped too', off2.status === 'skipped' && /function: off/.test(off2.message) && pmCalls.length === 0);
    ENV.POLYMARKET_DATA_ENABLED = 'on';
    chk('a skipped run is recorded', V("select count(*) from public.poly_sync_runs where status = 'skipped'") === '2');

    /* ── pool ── */
    const p1 = await go('pool');
    chk('pool: the top wallets are in, by leaderboard rank', p1.status === 'ok' && V('select count(*) from public.poly_wallets where in_pool') === '6'
      && V(`select pool_rank from public.poly_wallets where wallet = ${lit(W3)}`) === '3', p1);
    chk('pool: the run settled its grant', V('select count(*) from public.poly_api_settlements') === '1' && V('select used from public.poly_api_settlements') === String(p1.details.gateway.requests));
    scenario.leaderboard = POOL.slice(0, 5);
    await go('pool');
    chk('pool: a wallet the leaderboard no longer names leaves the pool', V(`select in_pool from public.poly_wallets where wallet = ${lit(W6)}`) === 'f' && V('select count(*) from public.poly_wallets where in_pool') === '5');
    scenario.leaderboard = POOL;
    await go('pool');

    /* ── wallets ── */
    const before = pmCalls.length;
    const wa = await go('wallets');
    chk('wallets: three wallets a run, least recently read first', wa.details.wallets.length === 3 && wa.details.wallets.map((x) => x.wallet).join() === [W1, W2, W3].join(), wa.details.wallets);
    chk('wallets: only covered trades are stored (the EPL trade is not)', V(`select count(*) from public.poly_trades where wallet = ${lit(W1)}`) === '60'
      && V(`select count(*) from public.poly_trades where condition_id = ${lit(EPL.c)}`) === '0');
    chk('wallets: every stored trade keeps its transaction hash', V("select count(*) from public.poly_trades where tx_hash !~ '^0x[0-9a-f]{64}$'") === '0');
    chk('wallets: the markets they traded are stored, resolutions with them', V('select count(*) from public.poly_markets where settle is not null') >= '60');
    chk('wallets: Gamma is asked for resolved markets with closed=true, and for the rest without it (it answers each only so)',
      pmCalls.slice(before).some((u) => /\/markets\?.*closed=true/.test(u)) && pmCalls.slice(before).some((u) => /\/markets\?.*closed=false/.test(u))
      && V(`select count(*) from public.poly_markets where condition_id = ${lit(EPL.c)}`) === '1');
    const bets = J(`select * from public.poly_bets where wallet = ${lit(W1)} order by entry_at`);
    chk('wallets: 60 resolved bets graded once each', bets.length === 60, bets.length);
    const b0 = bets[0];
    /* entry 2 h before the start at 0.50; at +5 min (1 h 55 m before) the price is 0.55; the close (30 min before) 0.58 */
    chk('wallets: the close is the last price before the start (0.58), CLV +8 pp', Number(b0.close_price) === 0.58 && Number(b0.clv_pp) === 8, b0);
    chk('wallets: the 5-minute follow price 0.55, the 15-minute too', Number(b0.follow5_price) === 0.55 && Number(b0.follow15_price) === 0.55);
    chk('wallets: a win follows at 1 / 0.55 - 1, a loss at -1', Math.abs(Number(b0.follow5_roi) - (1 / 0.55 - 1)) < 1e-5 && Number(bets[1].follow5_roi) === -1);
    const priceReads = pmCalls.slice(before).filter((u) => /prices-history\?/.test(u)).map((u) => { const q = new URL('https://' + u).searchParams; return (+q.get('endTs') - +q.get('startTs')) / 60; });
    chk('wallets: each of the three wallets\' 60 bets, held two hours, is read in two short stretches (360 reads), the follow\'s and the close\'s (at most 62 minutes each), never its whole history',
      priceReads.length === 360 && priceReads.every((m) => m <= 62), { reads: priceReads.length, longest: Math.max(...priceReads) });
    chk('wallets: the cursor is kept', V(`select (activity_cursor ->> 'ts_s')::bigint > 0 from public.poly_wallets where wallet = ${lit(W1)}`) === 't');
    const wb = await go('wallets');
    chk('wallets: the next run reads the next three', wb.details.wallets.map((x) => x.wallet).join() === [W4, W5, W6].join());
    /* at most 10 activity pages a run (a production run with a whole 30-page history ran out of compute, HTTP 546) */
    const w4pages = [wb.details.wallets.find((x) => x.wallet === W4).pages];
    for (let i = 0; i < 4 && V(`select activity_synced_at is null from public.poly_wallets where wallet = ${lit(W4)}`) === 't'; i++) w4pages.push(((await go('wallets')).details.wallets.find((x) => x.wallet === W4) || {}).pages);
    chk('wallets: a history that never ends is read 10 pages a run, cut at 30 in all and marked truncated', V(`select history_truncated from public.poly_wallets where wallet = ${lit(W4)}`) === 't'
      && w4pages.join() === '10,10,10', w4pages);
    const wc = await go('wallets');
    chk('wallets: nobody is due again within 20 hours', wc.details.wallets.length === 0);
    const tradesBefore = V('select count(*) from public.poly_trades'), betsBefore = V('select count(*) from public.poly_bets');
    V(`update public.poly_wallets set activity_synced_at = now() - interval '2 days', activity_cursor = null where wallet = ${lit(W1)}`);
    await go('wallets');
    chk('wallets: reading a wallet again from the start adds nothing (trades once, bets once)', V('select count(*) from public.poly_trades') === tradesBefore && V('select count(*) from public.poly_bets') === betsBefore);
    /* a wallet whose stored bets already fill a grade still has its NEW bets graded: the cap is per run (the
       newest first), not per wallet. Shown with the cap at 60, W1's stored count: three new games follow. */
    const rules60 = Object.assign(JSON.parse(V('select public.radar_rules()')), { max_bets_per_wallet: 60 });
    V(`create or replace function public.radar_rules() returns jsonb language sql immutable as $r$ select ${lit(JSON.stringify(rules60))}::jsonb $r$;`);
    for (let g = 0; g < 3; g++) { const c = cid('new' + g); PAST.push({ c, start: NOW - (30 - g) * H, settle: ['1', '0'], tokens: [tok(c, 0), tok(c, 1)], slug: 'nfl-new-' + g }); }
    V(`update public.poly_wallets set activity_synced_at = now() - interval '2 days' where wallet = ${lit(W1)}`);
    await go('wallets');
    chk('wallets: a wallet with a full grade of stored bets still has its three new bets graded', V(`select count(*) from public.poly_bets where wallet = ${lit(W1)}`) === '63',
      V(`select count(*) from public.poly_bets where wallet = ${lit(W1)}`));
    db.applyFileAtomic(path.join(ROOT, 'supabase', 'radar.sql'));   /* radar_rules() as shipped again */
    chk('(radar_rules() is the shipped one again)', JSON.parse(V('select public.radar_rules()')).max_bets_per_wallet === 150);
    chk('no request left for a host that is not Polymarket or the database', strays.length === 0, strays.slice(0, 3));

    /* ── grade ── */
    const gr = await go('grade');
    chk('grade: one run over the pool', gr.status === 'ok' && V('select count(*) from public.poly_grade_runs') === '1' && V('select wallets from public.poly_grade_runs') === '6', gr);
    const G1 = J('select wallet, rank, sample, style, top_directional, graded_bets, history_truncated from public.poly_wallet_grades order by rank nulls last, wallet');
    const gOf = (x) => G1.find((g) => g.wallet === x) || {};
    chk('grade: W1-W3 ranked, directional and top-graded', [W1, W2, W3].every((x) => gOf(x).sample === 'ranked' && gOf(x).style === 'Directional' && gOf(x).top_directional), G1);
    chk('grade: the wallet that buys both sides all night is a Market Maker, and never top-graded', gOf(W5).style === 'Market Maker' && gOf(W5).top_directional === false, gOf(W5));
    chk('grade: 10 bets is a small sample, unranked', gOf(W6).sample === 'small_sample' && gOf(W6).rank === null);
    chk('grade: the truncated wallet is never top-graded', gOf(W4).history_truncated === true && gOf(W4).top_directional === false);

    /* ── tonight ── */
    V(`insert into public.radar_config (key, value, note) values ('registry_ref:H-RADAR-01', 'test', 'stands in for supabase/radar_registry.sql, tested in radar_sql.test.js');`);
    db.service(`insert into public.poly_markets (condition_id, question, league, market_type, outcomes, token_ids, game_start_at, event_ref) values
      (${lit(STARTED.c)}, 'Seahawks vs. Broncos', 'nfl', 'moneyline', '["Seahawks","Broncos"]'::jsonb, ${lit(JSON.stringify(STARTED.tokens))}::jsonb, now() - interval '20 hours', 'done');`);
    db.service(`update public.poly_markets set event_id = 'ev-done', sport_key = 'americanfootball_nfl', match_status = 'mapped', sides = '[{"selection":"Seattle Seahawks"},{"selection":"Denver Broncos"}]'::jsonb where condition_id = ${lit(STARTED.c)};`);
    const tn = await go('tonight');
    chk('tonight: the moneyline and the total are matched to the board\'s game', V(`select event_id from public.poly_markets where condition_id = ${lit(LIVE.c)}`) === 'ev1'
      && V(`select event_id from public.poly_markets where condition_id = ${lit(LIVE_TOT.c)}`) === 'ev1', tn);
    const sides = JSON.parse(V(`select sides from public.poly_markets where condition_id = ${lit(LIVE.c)}`));
    chk('tonight: each side carries the board\'s fair at that line', sides[0].sig_key === 'k1' && sides[1].sig_key === 'k2' && sides[0].selection === 'Kansas City Chiefs');
    chk('tonight: the total\'s Over and Under too', JSON.parse(V(`select sides from public.poly_markets where condition_id = ${lit(LIVE_TOT.c)}`)).map((x) => x.sig_key).join() === 'k3,k4');
    chk('tonight: a game whose teams are not the board\'s nearby game stays pending, with its reason, and is warned about (it starts within 12 hours)',
      V(`select match_status || ':' || match_reason from public.poly_markets where condition_id = ${lit(ORPHAN.c)}`) === 'pending:team_unresolved' && tn.alerts.some((a) => a.code === 'unmapped_markets' && a.severity === 'WARNING'));
    const evCalls = pmCalls.filter((u) => /gamma-api\.polymarket\.com\/events\?/.test(u)), hoCalls = pmCalls.filter((u) => /\/v2\/holders\?/.test(u));
    chk('tonight: open events are asked in a window around the next games, a few a page (one unwindowed page of 100 NFL events was 48 MB)',
      evCalls.length > 0 && evCalls.every((u) => /end_date_min=/.test(u) && /end_date_max=/.test(u) && +new URL('https://' + u).searchParams.get('limit') <= 10)
      && V(`select count(*) from public.poly_markets where condition_id = ${lit(FAR.c)}`) === '0', evCalls);
    chk('tonight: holders are asked 100 at most (Gamma refuses more with include_pnl)', hoCalls.length > 0 && hoCalls.every((u) => /[?&]limit=100(&|$)/.test(u)), hoCalls);
    chk('tonight: holders only for markets at the board\'s own lines (the alternate total at 50.5 has no fair to compare with)',
      V(`select event_id from public.poly_markets where condition_id = ${lit(LIVE_ALT.c)}`) === 'ev1' && !hoCalls.some((u) => u.indexOf(LIVE_ALT.c) >= 0)
      && hoCalls.some((u) => u.indexOf(LIVE.c) >= 0) && hoCalls.some((u) => u.indexOf(LIVE_TOT.c) >= 0), hoCalls);
    chk('tonight: holders are stored for pool wallets only (the outsider is not)', V(`select count(*) from public.poly_holder_snapshots where condition_id = ${lit(LIVE.c)}`) === '3'
      && V(`select count(*) from public.poly_holder_snapshots where wallet = ${lit(OUTSIDER)}`) === '0');
    chk('tonight: a name is stored only when the wallet made it public; no bio', V(`select display_name || ':' || display_public from public.poly_wallets where wallet = ${lit(W1)}`) === 'SharpAlice:true'
      && V(`select coalesce(display_name, '-') || ':' || display_public from public.poly_wallets where wallet = ${lit(W2)}`) === '-:false'
      && !/never stored/.test(V("select coalesce(string_agg(t::text, ''), '') from public.poly_wallets t")));
    chk('tonight: each outcome\'s price is kept', V(`select price from public.poly_price_snapshots where token_id = ${lit(LIVE.tokens[0])}`) === '0.6');
    chk('tonight: a started game\'s market gets its resolution', V(`select settle::text from public.poly_markets where condition_id = ${lit(STARTED.c)}`) === '[1, 0]');
    const card = JSON.parse(db.as(SUB, 'select public.radar_tonight();'));
    chk('tonight: the subscriber\'s card — 2 top wallets on the Chiefs, $620, smart money agrees with the fair (0.62 vs 0.60)', card.status === 'ok' && card.cards.length === 1
      && card.cards[0].n_wallets === 2 && Number(card.cards[0].dollars) === 620 && card.cards[0].agrees === true && card.cards[0].other_side_wallets === 1, card);
    chk('tonight: without radar_record.sql the run warns that nothing is being recorded, and goes on', tn.alerts.some((a) => a.code === 'record_not_installed' && a.severity === 'WARNING'), tn.alerts);
    db.applyFileAtomic(path.join(ROOT, 'supabase', 'radar_record.sql'));
    const tn2 = await go('tonight');
    chk('tonight: with it, the card is published to the record once, at the price then', tn2.details.cards_published === 1 && V('select count(*) from public.radar_cards') === '1'
      && V('select follow_price from public.radar_cards') === '0.6', tn2.details);
    const tn3 = await go('tonight');
    chk('tonight: the next run publishes nothing new for the same game and side', tn3.details.cards_published === 0 && V('select count(*) from public.radar_cards') === '1');

    /* ── a full slate (production's first tonight run failed "Invalid URL": every market's id in one lookup) ── */
    scenario.bulk = 1200;
    longestRest = 0;
    const big = await go('tonight');
    scenario.bulk = 0;
    chk('tonight: a full slate of 1,200 more markets is stored and looked up in chunks, every database URL within fetch\'s 65,534 bytes',
      big.status !== 'error' && V("select count(*) from public.poly_markets where slug = 'nfl-kc-lv-bulk' and event_id = 'ev1'") === '1200' && longestRest > 0 && longestRest <= 65534,
      { status: big.status, message: big.message, longestRest });

    /* ── time: a wallets run answers within Supabase's 150 s request limit (production's first one did not, 2026-10-29) ── */
    scenario.costMs = 4000;   /* every Polymarket request takes 4 s */
    scenario.leaderboard = POOL.concat([W7]);
    await go('pool');
    const runs7 = [];
    for (let i = 0; i < 14; i++) {
      const f0 = fake, r = await go('wallets');
      runs7.push({ s: (fake - f0) / 1000, status: r.status, wallets: (r.details.wallets || []).map((x) => x.wallet.slice(-1) + ':' + x.status + ':' + x.graded).join() });
      if (V(`select activity_synced_at is not null from public.poly_wallets where wallet = ${lit(W7)}`) === 't') break;
    }
    chk('time: a new wallet too big for one run is graded over several, each run within its time budget (75 s, plus the bet in flight: far under the 150 s limit)',
      runs7.length > 1 && runs7.every((r) => r.status !== 'error' && r.s <= 83) && V(`select count(*) from public.poly_bets where wallet = ${lit(W7)}`) === '63', runs7);
    chk('time: a run that stops early says so, and leaves the wallet due for the next', /^7:partial:\d+$/.test(runs7[0].wallets) && /^7:done:\d+$/.test(runs7[runs7.length - 1].wallets), runs7);
    scenario.costMs = 10000;   /* 10 s a page: time runs out after 8 pages, before the 10-page cap */
    V(`update public.poly_wallets set activity_synced_at = null, activity_cursor = null, history_truncated = false where wallet = ${lit(W4)}`);
    const w4a = await go('wallets'), p4a = ((w4a.details.wallets || []).find((x) => x.wallet === W4) || {}).pages;
    chk('time: an activity read cut by time keeps its place and its page count, and is not called truncated yet',
      p4a > 0 && p4a < 10 && V(`select activity_synced_at is null and not history_truncated and (activity_cursor ->> 'first_pages')::int = ${p4a || 0} from public.poly_wallets where wallet = ${lit(W4)}`) === 't', { p4a, row: V(`select activity_cursor::text from public.poly_wallets where wallet = ${lit(W4)}`) });
    const p4 = [p4a];
    for (let i = 0; i < 6 && V(`select activity_synced_at is null from public.poly_wallets where wallet = ${lit(W4)}`) === 't'; i++) p4.push(((await go('wallets')).details.wallets.find((x) => x.wallet === W4) || {}).pages);
    chk('time: the next runs read the rest of the 30 pages, and only then mark the history truncated',
      p4.reduce((a, b) => a + b, 0) === 30 && V(`select history_truncated and activity_synced_at is not null from public.poly_wallets where wallet = ${lit(W4)}`) === 't', p4);
    scenario.costMs = 0;
    scenario.leaderboard = POOL;
    await go('pool');

    /* ── a wallet whose run died part way (out of compute, HTTP 546: production, 16:38 UTC) never blocks the rest ── */
    const crash = (wallet, ago, attempts) => V(`update public.poly_wallets set activity_synced_at = null, activity_cursor = jsonb_build_object('attempt_at', now() - interval '${ago}', 'attempts', ${attempts}) where wallet = ${lit(wallet)}`);
    crash(W5, '2 minutes', 1);
    V(`update public.poly_wallets set activity_synced_at = null where wallet = ${lit(W6)}`);
    const k1 = await go('wallets'), k1w = (k1.details.wallets || []).map((x) => x.wallet);
    chk('crash: a wallet whose run died minutes ago is set aside, and the next wallet is read instead (it does not block the queue)',
      !k1w.includes(W5) && k1w.includes(W6) && (k1.details.skipped || []).includes(W5) && k1.alerts.some((a) => a.code === 'wallet_skipped' && a.severity === 'WARNING'), { k1w, skipped: k1.details.skipped, alerts: k1.alerts.map((a) => a.code) });
    crash(W5, '20 minutes', 1);
    scenario.watchAttempt = W5;
    const k2 = await go('wallets');
    scenario.watchAttempt = null;
    chk('crash: after 15 minutes it is read again, its attempt marked before the work starts (2nd attempt), and a finished run clears the mark',
      (k2.details.wallets || []).some((x) => x.wallet === W5 && x.status === 'done') && scenario.seenAttempt === '2'
      && V(`select activity_cursor ? 'attempt_at' or activity_cursor ? 'attempts' from public.poly_wallets where wallet = ${lit(W5)}`) === 'f', { seen: scenario.seenAttempt, k2: k2.details.wallets });
    crash(W5, '2 hours', 3);
    const k3 = await go('wallets');
    chk('crash: a wallet whose runs died three times is read only once a day', !(k3.details.wallets || []).some((x) => x.wallet === W5) && (k3.details.skipped || []).includes(W5), k3.details);
    crash(W5, '25 hours', 3);
    const k4 = await go('wallets');
    chk('crash: …and is read again a day later', (k4.details.wallets || []).some((x) => x.wallet === W5), k4.details);

    /* ── budget ── */
    V('update public.poly_api_days set granted = 39997');
    const short = await go('tonight');
    chk('budget: a 3-request grant stops the run with a DEGRADED alert, and it is a warning, not a crash', short.status === 'warn' && short.alerts.some((a) => a.code === 'poly_budget_exhausted'), short.alerts);
    chk('budget: the settlement records what was used, never more than granted', V('select used from public.poly_api_settlements order by grant_id desc limit 1') === '3');
    V('update public.poly_api_days set granted = 0, used = 0');

    /* ── breaker ── */
    scenario.rateLimit = /\/v2\/holders/;
    const br = await go('tonight');
    chk('breaker: six 429s in a row open it; the run says so', br.details.gateway.breaker === true && br.alerts.some((a) => a.code === 'poly_breaker_open'), br.details.gateway);
    const after = await go('tonight');
    chk('breaker: the next run is refused by the gateway, nothing asked', after.status === 'skipped' && /denied_breaker/.test(after.message), after.message);
    scenario.rateLimit = null;
    V("update public.poly_api_days set breaker_until = null, granted = 0, used = 0");

    /* ── drift ── */
    scenario.drift = true;
    V(`update public.poly_wallets set activity_synced_at = now() - interval '2 days' where wallet = ${lit(W1)}`);
    const dr = await go('wallets');
    chk('drift: a trade without its transaction hash is counted and alerted, never stored', dr.alerts.some((a) => a.code === 'activity_unreadable') && V("select count(*) from public.poly_trades where tx_hash is null") === '0');

    /* ── dry ── */
    const runs = V('select count(*) from public.poly_sync_runs');
    const dry = await (await post({ mode: 'pool', dry: true })).json();
    chk('a dry run writes nothing (not even its run row)', dry.dry === true && V('select count(*) from public.poly_sync_runs') === runs);

    chk('every Polymarket request was one of the gateway\'s endpoints', pmCalls.every((u) => /^(data-api\.polymarket\.com\/(v1\/leaderboard|v2\/activity|v2\/holders)|gamma-api\.polymarket\.com\/(sports|events|markets)|clob\.polymarket\.com\/prices-history)\?/.test(u) || /gamma-api\.polymarket\.com\/sports$/.test(u)),
      pmCalls.filter((u) => !/(v1\/leaderboard|v2\/activity|v2\/holders|\/sports|\/events|\/markets|prices-history)/.test(u)).slice(0, 3));
  } catch (e) {
    chk('the suite ran to the end', false, String(e && e.stack || e).slice(0, 1500));
  } finally {
    db.stop();
  }
  process.exit(T.done());
})();
