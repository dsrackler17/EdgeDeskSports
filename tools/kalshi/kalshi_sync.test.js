#!/usr/bin/env node
/* ===========================================================================
   supabase/functions/kalshi_sync/index.ts, tested as deployed: imported
   (not a copy) under Node's type stripping, with a Deno shim, a mocked
   Kalshi (both production hosts) and an in-memory PostgREST.

     copy        the inlined lib/football_identity.js has not drifted
     auth        a GET is a probe; a POST needs the cron secret; an unknown
                 mode is refused; `now` is honoured on dry runs only
     discover    the Sports series upserted WITHOUT the operator's `tracked`;
                 a game series missing from the list is DRIFT; ended markets'
                 status and result refreshed
     snapshot    every page of every tracked series; Kalshi's fixed-point
                 strings stored as numbers; one row per market inside the
                 horizon; a market without dollar prices is not snapshotted
                 (DRIFT); a second run appends, never rewrites
     links       DAL @ PHI (code + name, both dates): high, with the card's
                 game id; "New York G" @ "New York J" read by city and
                 initial; a rescheduled game (stale ticker date) matched on
                 the expected end only: medium; a CFB game through the
                 shared identity ("Ohio St." = "Ohio State Buckeyes"), with
                 decoys on the same day left alone; a code/name conflict,
                 a game on no book and two book events for one game left
                 UNMAPPED with their reasons; a missing game id filled later
     alerts      unmapped games settling soon warn at most hourly; one series
                 down is DEGRADED; every series down is a FAILURE; the book
                 unreadable is DEGRADED and links nothing; nothing tracked
                 warns; the external host refusing hands over to the shared
     dry         reads and computes, writes nothing

   Run: node tools/kalshi/kalshi_sync.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }

const ENV = { SUPABASE_URL: 'https://stub.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key', KALSHI_CRON_SECRET: 'cron-secret' };
globalThis.Deno = { env: { get: (k) => ENV[k] } };

chk('copy: the inlined football identity matches lib/football_identity.js (node tools/kalshi/inline_identity.js)', require(path.join(__dirname, 'inline_identity.js')).current());

/* ---------------------------------------------------------------- the world (Monday 2026-10-26, 14:00 ET) */
const NOW = '2026-10-26T18:00:00Z';
const H = 3600e3, at = (h) => new Date(Date.parse(NOW) + h * H).toISOString();
const px = (b, a) => ({ yes_bid_dollars: b, yes_ask_dollars: a, no_bid_dollars: (1 - Number(a)).toFixed(4), no_ask_dollars: (1 - Number(b)).toFixed(4),
  last_price_dollars: b, yes_bid_size_fp: '120.00', yes_ask_size_fp: '80.50', volume_fp: '15234.00', volume_24h_fp: '3021.00', open_interest_fp: '9100.00' });
const mkt = (ev, code, name, endH, prices, extra) => Object.assign({ ticker: ev + '-' + code, event_ticker: ev, market_type: 'binary', yes_sub_title: name, no_sub_title: name,
  rules_primary: 'If ' + name + ' wins the game, then the market resolves to Yes.', open_time: at(-200), close_time: at(endH + 45), expected_expiration_time: at(endH),
  status: 'active', result: '', can_close_early: true }, prices === null ? {} : (prices || px('0.5600', '0.5800')), extra || {});
/* kickoffs: MNF DAL @ PHI 00:15Z Tue; NYG @ NYJ 17:00Z; BUF @ KC moved from Sun (ticker 26OCT25) to Tue 00:15Z; ARI @ LV is on no book */
const NFL_MARKETS = [
  mkt('KXNFLGAME-26OCT26DALPHI', 'DAL', 'Dallas', 9.25, px('0.3800', '0.4000')), mkt('KXNFLGAME-26OCT26DALPHI', 'PHI', 'Philadelphia', 9.25, px('0.6100', '0.6300')),
  mkt('KXNFLGAME-26OCT26NYGNYJ', 'NYG', 'New York G', 2, px('0.4500', '0.4700')), mkt('KXNFLGAME-26OCT26NYGNYJ', 'NYJ', 'New York J', 2, px('0.5300', '0.5500')),
  mkt('KXNFLGAME-26OCT25BUFKC', 'BUF', 'Buffalo', 33.25), mkt('KXNFLGAME-26OCT25BUFKC', 'KC', 'Kansas City', 33.25),
  mkt('KXNFLGAME-26OCT26ARILV', 'ARI', 'Arizona', 9), mkt('KXNFLGAME-26OCT26ARILV', 'LV', 'Las Vegas', 9),
  mkt('KXNFLGAME-26OCT26SFSEA', 'SF', 'San Francisco', 10), mkt('KXNFLGAME-26OCT26SFSEA', 'SEA', 'San Francisco', 10),
  mkt('KXNFLGAME-26NOV26DETGB', 'DET', 'Detroit', 30 * 24), mkt('KXNFLGAME-26NOV26DETGB', 'GB', 'Green Bay', 30 * 24),
];
const CFB_MARKETS = [
  mkt('KXNCAAFGAME-26OCT31TEXOSU', 'TEX', 'Texas', 5 * 24 + 1), mkt('KXNCAAFGAME-26OCT31TEXOSU', 'OSU', 'Ohio St.', 5 * 24 + 1),
  mkt('KXNCAAFGAME-26OCT31USCUCLA', 'USC', 'USC', 5 * 24 + 6), mkt('KXNCAAFGAME-26OCT31USCUCLA', 'UCLA', 'UCLA', 5 * 24 + 6),
  mkt('KXNCAAFGAME-26OCT31ALBYIOWA', 'ALBY', 'University at Albany', 5 * 24 + 2), mkt('KXNCAAFGAME-26OCT31ALBYIOWA', 'IOWA', 'Iowa', 5 * 24 + 2, null),
  mkt('KXNCAAFGAME-26OCT31MSSTUGA', 'MSST', 'Miss. St.', 5 * 24 + 7), mkt('KXNCAAFGAME-26OCT31MSSTUGA', 'UGA', 'Georgia', 5 * 24 + 7),
];
const SIGNALS = [];
const book = (id, sk, home, away, kickH) => { for (const s of [home, away]) SIGNALS.push({ sig_key: id + '|h2h|' + s, event_id: id, sport_key: sk, market: 'h2h', selection: s, home_team: home, away_team: away, commence_time: at(kickH) }); };
book('ev-dalphi', 'americanfootball_nfl', 'Philadelphia Eagles', 'Dallas Cowboys', 6.25);
book('ev-nygnyj', 'americanfootball_nfl', 'New York Jets', 'New York Giants', -1);
book('ev-bufkc', 'americanfootball_nfl', 'Kansas City Chiefs', 'Buffalo Bills', 30.25);
book('ev-sfsea', 'americanfootball_nfl', 'Seattle Seahawks', 'San Francisco 49ers', 7);
book('ev-texosu', 'americanfootball_ncaaf', 'Ohio State Buckeyes', 'Texas Longhorns', 5 * 24 - 2);
book('ev-decoy', 'americanfootball_ncaaf', 'Ohio Bobcats', 'Texas Tech Red Raiders', 5 * 24 - 2);
book('ev-usc-1', 'americanfootball_ncaaf', 'UCLA Bruins', 'USC Trojans', 5 * 24 + 3);
book('ev-usc-2', 'americanfootball_ncaaf', 'UCLA Bruins', 'USC Trojans', 5 * 24 + 3);
book('ev-msuga', 'americanfootball_ncaaf', 'Georgia Bulldogs', 'Mississippi State Bulldogs', 5 * 24 + 4);
const RESEARCH0 = [
  { game_key: 'nfl|2026_08_DAL_PHI', sport: 'nfl', game_id: '2026_08_DAL_PHI', home: 'Philadelphia Eagles', away: 'Dallas Cowboys', kickoff_at: at(6.25) },
  { game_key: 'cfb|401778123', sport: 'cfb', game_id: '401778123', home: 'Ohio State', away: 'Texas', kickoff_at: at(5 * 24 - 2) },
  { game_key: 'cfb|401778999', sport: 'cfb', game_id: '401778999', home: 'Ohio', away: 'Texas Tech', kickoff_at: at(5 * 24 - 2) },
];
const SERIES = [{ ticker: 'KXNFLGAME', title: 'Professional Football Game', category: 'Sports', categories: ['Sports'], tags: ['Football'], frequency: 'custom' },
  { ticker: 'KXNCAAFGAME', title: 'College Football Game', category: 'Sports', categories: ['Sports'], tags: ['Football'], frequency: 'custom' },
  { ticker: 'KXUFCFIGHT', title: 'UFC Fight', category: 'Sports', categories: ['Sports'], tags: null, frequency: 'custom' }];

/* ---------------------------------------------------------------- PostgREST, in memory */
let DB;
function resetDb(o) {
  o = o || {};
  DB = { kalshi_series: (o.series || [{ ticker: 'KXNFLGAME', tracked: true }, { ticker: 'KXNCAAFGAME', tracked: true }]).map((x) => Object.assign({}, x)),
    kalshi_link_series: [{ series_ticker: 'KXNFLGAME', sport: 'nfl' }, { series_ticker: 'KXNCAAFGAME', sport: 'cfb' }],
    kalshi_markets: [], kalshi_price_snapshots: [], kalshi_game_links: [], kalshi_sync_runs: [], kalshi_alerts: [],
    signals: SIGNALS.slice(), game_research_state: (o.research || RESEARCH0).slice(), seq: 0, calls: [], down: o.down || {} };
}
const KEY = { kalshi_series: 'ticker', kalshi_markets: 'ticker', kalshi_game_links: 'market_ticker' };
function cmp(v, op, x) {
  if (op === 'eq') return String(v) === x;
  if (op === 'is') return x === 'null' ? v == null : (x === 'true' ? v === true : v === false);
  if (op === 'in' || op === 'not.in') { const set = x.replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/^"|"$/g, '')); const hit = set.includes(String(v)); return op === 'in' ? hit : !hit; }
  const a = Date.parse(v), b = Date.parse(x);
  const [l, r] = isFinite(a) && isFinite(b) ? [a, b] : [v, x];
  if (v == null) return false;
  return op === 'gte' ? l >= r : op === 'lte' ? l <= r : op === 'gt' ? l > r : op === 'lt' ? l < r : true;
}
function filterRows(rows, q) {
  let out = rows;
  for (const [k, raw] of q.entries()) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(k)) continue;
    const m = /^(not\.in|eq|is|in|gte|lte|gt|lt)\.(.*)$/.exec(raw);
    if (!m) throw new Error('mock: unparsed filter ' + k + '=' + raw);
    out = out.filter((r) => cmp(r[k], m[1], m[2]));
  }
  const off = Number(q.get('offset') || 0), lim = q.get('limit') ? Number(q.get('limit')) : Infinity;
  return out.slice(off, off + lim);
}
function rest(u, init) {
  const url = new URL(u), name = url.pathname.replace('/rest/v1/', ''), q = url.searchParams, m = (init && init.method) || 'GET';
  DB.calls.push(m + ' ' + name);
  if (DB.down[name]) return [DB.down[name], { message: 'relation "public.' + name + '" does not exist' }];
  if (!(name in DB)) return [404, { message: 'no table ' + name }];
  const prefer = (init && init.headers && init.headers.prefer) || '';
  if (m === 'POST') {
    const rows = JSON.parse(init.body), key = KEY[name];
    for (const r of rows) {
      const i = key ? DB[name].findIndex((x) => x[key] === r[key]) : -1;
      if (i >= 0 && /ignore-duplicates/.test(prefer)) continue;
      if (i >= 0 && /merge-duplicates/.test(prefer)) { Object.assign(DB[name][i], r); continue; }
      if (i >= 0) return [409, { message: 'duplicate key' }];
      DB[name].push(Object.assign({ id: ++DB.seq, created_at: new Date().toISOString() }, name === 'kalshi_series' ? { tracked: false } : {}, r));
    }
    return [201, ''];
  }
  if (m === 'PATCH') {
    const hit = filterRows(DB[name], q);
    hit.forEach((r) => Object.assign(r, JSON.parse(init.body)));
    return [204, ''];
  }
  return [200, filterRows(DB[name], q)];
}
function resp(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}
/* ---------------------------------------------------------------- Kalshi */
let W;
function resetKalshi(o) { W = Object.assign({ externalStatus: 200, externalDown: false, sharedDown: false, seriesShape: true, failSeries: [], calls: [], pageSize: 7, extraNfl: [] }, o || {}); }
globalThis.fetch = async (u, init) => {
  u = String(u);
  if (u.startsWith(ENV.SUPABASE_URL)) { const [s, b] = rest(u, init); return resp(s, b); }
  const ext = u.startsWith('https://external-api.kalshi.com/trade-api/v2'), sh = u.startsWith('https://api.elections.kalshi.com/trade-api/v2');
  if (!ext && !sh) return resp(404, 'unmocked ' + u);
  W.calls.push((ext ? 'ext ' : 'shared ') + u.replace(/^https:\/\/[^/]+\/trade-api\/v2/, ''));
  if (ext && W.externalDown) throw new TypeError('fetch failed: getaddrinfo ENOTFOUND');
  if (sh && W.sharedDown) throw new TypeError('fetch failed: connection reset');
  if (ext && W.externalStatus !== 200) return resp(W.externalStatus, { error: 'forbidden' });
  const url = new URL(u), p = url.pathname.replace('/trade-api/v2', ''), q = url.searchParams;
  if (p === '/series') return resp(200, W.seriesShape ? { series: q.get('category') === 'Sports' ? SERIES : [] } : { error: 'changed' });
  if (p === '/markets' && q.get('tickers')) {
    const want = q.get('tickers').split(',');
    return resp(200, { markets: want.map((t) => ({ ticker: t, event_ticker: t.replace(/-[A-Z]+$/, ''), status: 'finalized', result: /PHI$/.test(t) ? 'yes' : 'no', yes_sub_title: 'x', expected_expiration_time: at(-1), close_time: at(-1) })), cursor: '' });
  }
  if (p === '/markets') {
    const s = q.get('series_ticker');
    if (q.get('status') !== 'open' || q.get('mve_filter') !== 'exclude') return resp(400, { error: 'invalid status filter' });
    if (W.failSeries.includes(s)) return resp(503, { error: 'unavailable' });
    const all = s === 'KXNFLGAME' ? NFL_MARKETS.concat(W.extraNfl) : s === 'KXNCAAFGAME' ? CFB_MARKETS : [];
    const off = Number(q.get('cursor') || 0), page = all.slice(off, off + W.pageSize), next = off + W.pageSize < all.length ? String(off + W.pageSize) : '';
    return resp(200, { markets: page, cursor: next });
  }
  return resp(404, { error: 'not found' });
};

(async () => {
  const FN = path.join(ROOT, 'supabase', 'functions', 'kalshi_sync', 'index.ts');
  let F;
  try { F = await import(FN); } catch (e) { console.log('SKIP | kalshi sync | the deployed function could not be imported: ' + (e && e.message) + ' (needs Node 22+ type stripping)'); process.exit(0); }
  F.hooks.sleep = async () => {};
  const run = (o) => F.syncOnce(Object.assign({ now: NOW, trigger: 'test' }, o || {}));
  const lastRun = () => DB.kalshi_sync_runs[DB.kalshi_sync_runs.length - 1];
  const linkOf = (t) => DB.kalshi_game_links.find((l) => l.market_ticker === t);
  const codes = (o) => o.alerts.map((a) => a.severity + ':' + a.code).sort().join(',');

  /* ---- auth ---- */
  resetDb(); resetKalshi();
  const probe = await F.handle(new Request('https://x/', { method: 'GET' }));
  const pj = await probe.json();
  chk('auth: a GET is a public probe with the build and the linker version', probe.status === 200 && pj.build === F.BUILD && pj.linker === F.LINKER_VERSION);
  chk('auth: a POST without the secret is refused', (await F.handle(new Request('https://x/', { method: 'POST', body: '{}' }))).status === 401);
  chk('auth: a POST with a wrong secret is refused', (await F.handle(new Request('https://x/', { method: 'POST', headers: { 'x-cron-secret': 'nope' }, body: '{}' }))).status === 401);
  chk('auth: an unknown mode is refused', (await F.handle(new Request('https://x/', { method: 'POST', headers: { 'x-cron-secret': 'cron-secret' }, body: '{"mode":"everything"}' }))).status === 400);
  const hres = await F.handle(new Request('https://x/', { method: 'POST', headers: { 'x-cron-secret': 'cron-secret' }, body: JSON.stringify({ mode: 'discover', now: '2020-01-01T00:00:00Z', source: 'supabase_cron' }) }));
  chk('auth: with the secret it runs; `now` is ignored on a run that writes (no backdated record)', hres.status === 200 && Date.parse(lastRun().started_at) > Date.parse('2026-01-01') && lastRun().trigger === 'cron' && lastRun().mode === 'discover');

  /* ---- pure helpers ---- */
  chk('dates: the event ticker’s date', F.tickerDate('KXNFLGAME-26OCT26DALPHI') === '2026-10-26' && F.tickerDate('KXNCAAFGAME-25AUG30ALBYIOWA') === '2025-08-30' && F.tickerDate('KXNFLGAME-XYZ') === null);
  chk('dates: a Monday-night 00:15Z kickoff is Monday in Eastern time', F.etDate(Date.parse('2026-10-27T00:15:00Z')) === '2026-10-26');
  chk('numbers: fixed-point strings', F.num('0.5600') === 0.56 && F.num('15234.00') === 15234 && F.num('') === null && F.num('x') === null);
  const club = F.nflClubOf({ ticker: 'KXNFLGAME-26JAN25LASEA-LA', event_ticker: 'KXNFLGAME-26JAN25LASEA', yes_sub_title: 'Los Angeles R' });
  chk('teams: the Rams as "LA" and "Los Angeles R" agree (two readings: strong)', club.club === 'LAR' && club.strong === true, club);
  chk('teams: Jacksonville’s "JAC" is the Jaguars', F.nflClubOf({ ticker: 'E-JAC', event_ticker: 'E', yes_sub_title: 'Jacksonville' }).club === 'JAX');

  /* ---- discover ---- */
  resetDb({ series: [{ ticker: 'KXNFLGAME', tracked: true }] }); resetKalshi();
  DB.kalshi_markets.push({ ticker: 'KXNFLGAME-26OCT19DALPHI-PHI', event_ticker: 'KXNFLGAME-26OCT19DALPHI', series_ticker: 'KXNFLGAME', status: 'active', expected_expiration_time: at(-150), result: null },
    { ticker: 'KXNFLGAME-26OCT26DALPHI-PHI', event_ticker: 'KXNFLGAME-26OCT26DALPHI', series_ticker: 'KXNFLGAME', status: 'active', expected_expiration_time: at(9), result: null });
  let o = await run({ mode: 'discover' });
  chk('discover: an ok run with every Sports series', o.ok && o.status === 'ok' && lastRun().series_found === 3 && DB.kalshi_series.length === 3, o);
  chk('discover: the operator’s tracked switch is never sent (or changed)', DB.kalshi_series.find((s) => s.ticker === 'KXNFLGAME').tracked === true
    && DB.kalshi_series.find((s) => s.ticker === 'KXUFCFIGHT').tracked === false && W.calls.some((c) => /\/series\?category=Sports/.test(c)));
  chk('discover: a null tags list is stored as an empty one', Array.isArray(DB.kalshi_series.find((s) => s.ticker === 'KXUFCFIGHT').tags) && DB.kalshi_series.find((s) => s.ticker === 'KXUFCFIGHT').tags.length === 0);
  const ended = DB.kalshi_markets.find((m) => m.ticker === 'KXNFLGAME-26OCT19DALPHI-PHI');
  chk('discover: an ended market’s status and result are refreshed; an upcoming one is not asked for', ended.status === 'finalized' && ended.result === 'yes'
    && W.calls.some((c) => /tickers=KXNFLGAME-26OCT19DALPHI-PHI(&|$)/.test(c)) && !W.calls.some((c) => /tickers=[^&]*26OCT26/.test(c)));
  resetDb(); resetKalshi({ seriesShape: false });
  o = await run({ mode: 'discover' });
  chk('discover: a series list without `series` is DRIFT and writes nothing', o.status === 'warn' && codes(o) === 'DRIFT:series_shape' && DB.kalshi_series.length === 2, codes(o));
  resetDb(); resetKalshi();
  DB.kalshi_link_series.push({ series_ticker: 'KXNFLGAMEOLD', sport: 'nfl' });
  o = await run({ mode: 'discover' });
  chk('discover: a game-winner series missing from Kalshi’s list is DRIFT, named', codes(o) === 'DRIFT:link_series_missing' && /KXNFLGAMEOLD/.test(o.alerts[0].message));

  /* ---- snapshot + links ---- */
  resetDb(); resetKalshi();
  o = await run({ mode: 'snapshot' });
  const r1 = lastRun();
  chk('snapshot: every page of both tracked series read (7 a page)', W.calls.filter((c) => /series_ticker=KXNFLGAME&/.test(c)).length === 2 && r1.markets_seen === 20, [W.calls, r1]);
  chk('snapshot: one row per market inside the 8-day horizon; the Thanksgiving game and the price-less market are not snapshotted',
    r1.markets_snapshotted === 17 && r1.markets_beyond_horizon === 2 && DB.kalshi_price_snapshots.length === 17 && !DB.kalshi_price_snapshots.some((s) => /DETGB|ALBYIOWA-IOWA/.test(s.ticker)), r1);
  chk('snapshot: every market’s metadata is kept, the far ones too', DB.kalshi_markets.length === 20 && DB.kalshi_markets.some((m) => m.ticker === 'KXNFLGAME-26NOV26DETGB-DET'));
  const s = DB.kalshi_price_snapshots.find((x) => x.ticker === 'KXNFLGAME-26OCT26DALPHI-PHI');
  chk('snapshot: Kalshi’s strings stored as numbers, stamped with the run', s.yes_bid === 0.61 && s.yes_ask === 0.63 && s.no_bid === 0.37 && s.volume === 15234 && s.open_interest === 9100 && s.yes_ask_size === 80.5
    && Date.parse(s.captured_at) === Date.parse(NOW) && s.run_id === r1.run_id && s.minutes_to_close === (9.25 + 45) * 60, s);
  chk('snapshot: a market without dollar prices is DRIFT, named', o.alerts.some((a) => a.code === 'market_shape' && a.severity === 'DRIFT' && /KXNCAAFGAME \(1 of 8\)/.test(a.message)));
  chk('snapshot: the run is warn (drift), not an error', o.ok && r1.status === 'warn', r1);

  let l = linkOf('KXNFLGAME-26OCT26DALPHI-PHI');
  chk('link: DAL @ PHI — high, the book’s Philadelphia Eagles h2h row, the card’s game id', l && l.match_confidence === 'high' && l.yes_team === 'Philadelphia Eagles' && l.opponent === 'Dallas Cowboys'
    && l.odds_event_id === 'ev-dalphi' && l.odds_sig_key === 'ev-dalphi|h2h|Philadelphia Eagles' && l.game_id === '2026_08_DAL_PHI' && l.game_key === 'nfl|2026_08_DAL_PHI'
    && l.kickoff_at === at(6.25) && l.sport === 'nfl' && /date:ticker_date\+expected_end/.test(l.match_method), l);
  chk('link: the DAL side is Dallas', linkOf('KXNFLGAME-26OCT26DALPHI-DAL').yes_team === 'Dallas Cowboys' && linkOf('KXNFLGAME-26OCT26DALPHI-DAL').odds_sig_key === 'ev-dalphi|h2h|Dallas Cowboys');
  l = linkOf('KXNFLGAME-26OCT26NYGNYJ-NYG');
  chk('link: "New York G" @ "New York J" — the Giants and the Jets, kept apart; no research row, so no game id yet', l && l.yes_team === 'New York Giants' && linkOf('KXNFLGAME-26OCT26NYGNYJ-NYJ').yes_team === 'New York Jets'
    && l.match_confidence === 'high' && l.game_id === null && /city_initial/.test(l.match_method), l);
  l = linkOf('KXNFLGAME-26OCT25BUFKC-KC');
  chk('link: a rescheduled game (the ticker still says Sunday) matched on the expected end only: medium', l && l.match_confidence === 'medium' && l.odds_event_id === 'ev-bufkc' && /date:expected_end$/.test(l.match_method)
    && l.match_detail.ticker_date === '2026-10-25' && l.match_detail.book_et_date === '2026-10-27', l);
  l = linkOf('KXNCAAFGAME-26OCT31TEXOSU-OSU');
  chk('link: CFB "Ohio St." is the Ohio State Buckeyes (never the Ohio Bobcats), "Texas" the Longhorns (never Texas Tech), with the card’s CFBD id',
    l && l.yes_team === 'Ohio State Buckeyes' && linkOf('KXNCAAFGAME-26OCT31TEXOSU-TEX').yes_team === 'Texas Longhorns' && l.odds_event_id === 'ev-texosu' && l.game_id === '401778123' && l.match_confidence === 'high' && l.sport === 'cfb', l);
  chk('link: nothing is linked to the decoy', !DB.kalshi_game_links.some((x) => x.odds_event_id === 'ev-decoy'));
  const um = Object.fromEntries((r1.details.unmapped || []).map((u) => [u.event_ticker, u.reason]));
  chk('unmapped: a game on no book, a code/name conflict, two book events for one game and a one-market event are left unmapped with their reasons',
    um['KXNFLGAME-26OCT26ARILV'] === 'no_book_event' && um['KXNFLGAME-26OCT26SFSEA'] === 'team_conflict' && um['KXNCAAFGAME-26OCT31USCUCLA'] === 'ambiguous_book_event'
    && um['KXNCAAFGAME-26OCT31ALBYIOWA'] === 'no_book_event' && !linkOf('KXNFLGAME-26OCT26ARILV-ARI') && !linkOf('KXNCAAFGAME-26OCT31USCUCLA-USC'), um);
  const ms = (r1.details.unmapped || []).find((u) => u.event_ticker === 'KXNCAAFGAME-26OCT31MSSTUGA');
  chk('unmapped: a game the book carries with one name unresolved ("Miss. St.") is one_team_matched, naming the book\u2019s game — not "no book"',
    ms && ms.reason === 'one_team_matched' && /Mississippi State Bulldogs @ Georgia Bulldogs/.test(JSON.stringify(ms.detail)) && !linkOf('KXNCAAFGAME-26OCT31MSSTUGA-UGA'), ms);
  const uc = r1.details.unmapped_counts || {};
  chk('unmapped: every reason counted, the ones to look at listed first', uc.no_book_event === 2 && uc.team_conflict === 1 && uc.ambiguous_book_event === 1 && uc.one_team_matched === 1
    && r1.details.unmapped.slice(0, 3).every((u) => u.reason !== 'no_book_event'), uc);
  chk('unmapped: the run counts the unmapped markets and the new links', r1.links_new === 8 && r1.unmapped_markets === 10 && DB.kalshi_game_links.length === 8, r1);
  const ua = o.alerts.find((a) => a.code === 'unmapped_markets');
  chk('unmapped: a priced game settling within 30 hours that could not be matched is a WARNING naming it; a game no book prices is not (the far Thanksgiving game neither)',
    ua && ua.severity === 'WARNING' && /KXNFLGAME-26OCT26SFSEA/.test(ua.message) && !/ARILV/.test(ua.message) && !/DETGB/.test(ua.message)
    && r1.details.unmapped_soon_actionable === 1 && r1.details.unmapped_soon_unpriced === 1, [ua, r1.details.unmapped_soon_actionable, r1.details.unmapped_soon_unpriced]);

  /* ---- the second run: appends, never rewrites; fills a game id; warns at most hourly ---- */
  DB.game_research_state.push({ game_key: 'nfl|2026_08_NYG_NYJ', sport: 'nfl', game_id: '2026_08_NYG_NYJ', home: 'New York Jets', away: 'New York Giants', kickoff_at: at(-1) });
  DB.kalshi_alerts.forEach((a) => { a.created_at = new Date(Date.parse(NOW) - 600e3).toISOString(); });
  const before = JSON.stringify(DB.kalshi_game_links.filter((x) => x.game_id));
  o = await run({ mode: 'snapshot', now: at(5 / 60) });
  chk('second run: the snapshots are appended (34 rows), none rewritten', DB.kalshi_price_snapshots.length === 34 && DB.kalshi_price_snapshots.filter((x) => Date.parse(x.captured_at) === Date.parse(NOW)).length === 17);
  chk('second run: no link is written twice', DB.kalshi_game_links.length === 8 && lastRun().links_new === 0 && DB.calls.filter((c) => c === 'POST kalshi_game_links').length === 1);
  chk('second run: the Giants-Jets game id is filled, once, and the other links are untouched', linkOf('KXNFLGAME-26OCT26NYGNYJ-NYG').game_id === '2026_08_NYG_NYJ' && linkOf('KXNFLGAME-26OCT26NYGNYJ-NYJ').game_id === '2026_08_NYG_NYJ'
    && lastRun().game_ids_filled === 2 && JSON.stringify(DB.kalshi_game_links.filter((x) => x.game_id && !/NYGNYJ/.test(x.market_ticker))) === before);
  chk('second run: the unmapped warning is not repeated within the hour', !o.alerts.some((a) => a.code === 'unmapped_markets'));

  /* ---- degradation and failure ---- */
  resetDb(); resetKalshi({ failSeries: ['KXNCAAFGAME'] });
  o = await run({ mode: 'snapshot' });
  chk('one series down: DEGRADED, a warn run, the other series still snapshotted and linked', o.ok && lastRun().status === 'warn' && o.alerts.some((a) => a.severity === 'DEGRADED' && a.code === 'series_failed' && /KXNCAAFGAME/.test(a.message))
    && DB.kalshi_price_snapshots.length === 10 && linkOf('KXNFLGAME-26OCT26DALPHI-PHI') && lastRun().series_failed.length === 1, codes(o));
  resetDb(); resetKalshi({ failSeries: ['KXNFLGAME', 'KXNCAAFGAME'] });
  o = await run({ mode: 'snapshot' });
  chk('every series down: a FAILURE, an error run, nothing written', !o.ok && lastRun().status === 'error' && o.alerts.some((a) => a.severity === 'FAILURE' && a.code === 'kalshi_unreachable')
    && DB.kalshi_price_snapshots.length === 0 && DB.kalshi_alerts.some((a) => a.code === 'kalshi_unreachable' && a.run_id === lastRun().run_id), codes(o));
  resetDb(); resetKalshi({ externalDown: true, sharedDown: true });
  o = await run({ mode: 'discover' });
  chk('Kalshi unreachable on both hosts at discover: a FAILURE and an error run', !o.ok && lastRun().status === 'error' && codes(o) === 'FAILURE:discover_error' && /could not be reached/.test(lastRun().message), codes(o));
  resetDb(); resetKalshi({ externalStatus: 403 });
  o = await run({ mode: 'snapshot' });
  chk('the external host refuses (403): the shared host serves, and the run says which', o.ok && lastRun().details.host === 'api.elections.kalshi.com' && DB.kalshi_price_snapshots.length === 17
    && W.calls.some((c) => /^shared \/markets/.test(c)), lastRun().details);
  resetDb({ down: { signals: 404 } }); resetKalshi();
  o = await run({ mode: 'snapshot' });
  chk('the book unreadable: DEGRADED, the snapshots kept, nothing linked, every event unmapped with the reason', lastRun().status === 'warn' && o.alerts.some((a) => a.code === 'book_events_unreadable' && a.severity === 'DEGRADED')
    && DB.kalshi_price_snapshots.length === 17 && DB.kalshi_game_links.length === 0 && (lastRun().details.unmapped || []).every((u) => u.reason === 'book_events_unreadable'), codes(o));
  resetDb({ down: { game_research_state: 404 } }); resetKalshi();
  o = await run({ mode: 'snapshot' });
  chk('the research state unreadable: a WARNING; links made without the card’s id', o.alerts.some((a) => a.code === 'research_state_unreadable' && a.severity === 'WARNING')
    && linkOf('KXNFLGAME-26OCT26DALPHI-PHI').game_id === null && DB.kalshi_game_links.length === 8, codes(o));
  resetDb({ series: [{ ticker: 'KXNFLGAME', tracked: false }] }); resetKalshi();
  o = await run({ mode: 'snapshot' });
  chk('nothing tracked: a warn run with a WARNING that says what to do; Kalshi is not called', lastRun().status === 'warn' && codes(o) === 'WARNING:no_tracked_series' && /tracked = true/.test(o.alerts[0].message) && W.calls.length === 0);
  resetDb({ down: { kalshi_price_snapshots: 500 } }); resetKalshi();
  o = await run({ mode: 'snapshot' });
  chk('a database write failing is a FAILURE (snapshot_error), not a quiet success', !o.ok && lastRun().status === 'error' && codes(o) === 'FAILURE:snapshot_error', codes(o));

  /* ---- dry ---- */
  resetDb(); resetKalshi();
  o = await run({ mode: 'snapshot', dry: true });
  chk('dry: reads and computes (links proposed, unmapped named), writes nothing', o.ok && o.dry && o.links.length === 8 && o.unmapped.length === 5 && o.sample.length > 0
    && DB.kalshi_price_snapshots.length === 0 && DB.kalshi_markets.length === 0 && DB.kalshi_game_links.length === 0 && DB.kalshi_sync_runs.length === 0 && !DB.calls.some((c) => /^(POST|PATCH)/.test(c)), o);

  console.log((fail ? 'FAILED' : 'ALL GREEN') + ' kalshi sync: ' + pass + ' passed, ' + fail + ' failed');
  for (const f of failures) console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 700) : ''));
  process.exit(fail ? 1 : 0);
})();
