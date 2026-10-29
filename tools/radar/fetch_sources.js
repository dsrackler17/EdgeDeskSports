#!/usr/bin/env node
/* ===========================================================================
   PREDICTION RADAR — Polymarket's public APIs, read from GitHub's runner.

   The build environment cannot reach Polymarket (its network policy refuses
   all three of Polymarket's API hosts), so this is how the response
   shapes the parsers in lib/edgedesk_radar.js read are checked against the
   real thing. Run by .github/workflows/radar-sources.yml (an integration
   workflow: a live source, never replaced by a mock).

   Each endpoint Radar uses is asked ONCE, through the Radar gateway
   (lib/edgedesk_poly_gateway.js, its own budget of 80 requests), and printed:
   the URL, the HTTP status, the byte count, the sha256 of the body, its shape,
   and the body with every array cut to its first 3 items. The whole bodies
   are written to --out (kept as the run's artifact): tools/radar/fixtures/ is
   recorded from them, by hand, with the run id, and never edited after.

   It FAILS when a parser cannot read what Polymarket sent: a leaderboard with
   no wallet, an activity page with no trade, a market without its tokens, a
   price history without a point, holders without a wallet.

   Run: node tools/radar/fetch_sources.js --out <dir>
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const R = require(path.join(ROOT, 'lib', 'edgedesk_radar.js'));
const G = require(path.join(ROOT, 'lib', 'edgedesk_poly_gateway.js'));

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('--out', path.join(ROOT, 'tools', 'radar', 'out', 'sources'));
fs.mkdirSync(OUT, { recursive: true });

const gw = G.make({ enabled: true, budget: G.fixedBudget(80) });
let failed = 0, n = 0;
const results = [];

function trim(v, depth) {
  depth = depth || 0;
  if (Array.isArray(v)) return v.slice(0, 3).map((x) => trim(x, depth + 1)).concat(v.length > 3 ? ['… ' + (v.length - 3) + ' more'] : []);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = depth > 6 ? '…' : trim(v[k], depth + 1); return o; }
  if (typeof v === 'string' && v.length > 400) return v.slice(0, 400) + '… (' + v.length + ' chars)';
  return v;
}
function shape(v) {
  if (Array.isArray(v)) return 'array(' + v.length + ')' + (v.length && v[0] && typeof v[0] === 'object' ? ' of {' + Object.keys(v[0]).join(', ') + '}' : '');
  if (v && typeof v === 'object') return '{' + Object.keys(v).map((k) => k + (Array.isArray(v[k]) ? '[' + v[k].length + ']' : '')).join(', ') + '}';
  return typeof v;
}
async function ask(label, endpoint, params) {
  const r = await gw.get(endpoint, params);
  const body = r.data == null ? null : JSON.stringify(r.data);
  const sha = body == null ? null : crypto.createHash('sha256').update(body).digest('hex');
  const file = String(++n).padStart(2, '0') + '_' + label.replace(/[^a-z0-9]+/gi, '_') + '.json';
  if (body != null) fs.writeFileSync(path.join(OUT, file), JSON.stringify({ url: r.url, status: r.status, fetched_at: new Date().toISOString(), sha256: sha, body: r.data }, null, 1));
  console.log('\n=== ' + label + '\nGET ' + r.url + '\nstatus ' + r.status + ' · decision ' + r.decision + ' · attempts ' + r.attempts
    + (body != null ? ' · ' + Buffer.byteLength(body) + ' bytes · sha256 ' + sha + ' · file ' + file : '') + (r.reason ? '\nreason ' + r.reason : ''));
  if (r.data != null) { console.log('shape ' + shape(r.data)); console.log(JSON.stringify(trim(r.data), null, 1)); }
  results.push({ label, url: r.url, status: r.status, decision: r.decision, sha256: sha, file: body != null ? file : null });
  return r;
}
function check(label, ok, detail) {
  console.log((ok ? 'CHECK ok   ' : 'CHECK FAIL ') + label + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 600) : ''));
  if (!ok) failed++;
}

(async () => {
  const now = Math.floor(Date.now() / 1000);
  /* 1. the leagues */
  const sp = await ask('gamma sports', 'sports', {});
  check('gamma /sports answers a list', sp.ok && Array.isArray(R.page(sp.data).rows) && R.page(sp.data).rows.length > 0, sp.ok ? shape(sp.data) : sp.decision);
  const leagueRows = sp.ok ? R.page(sp.data).rows : [];
  const want = ['nfl', 'cfb', 'ncaaf', 'nba', 'nhl', 'mlb'];
  const leagues = leagueRows.filter((x) => want.indexOf(String(x.sport || x.slug || x.league || '').toLowerCase()) >= 0);
  console.log('LEAGUES ' + JSON.stringify(leagues.map((x) => ({ sport: x.sport, series: x.series, tags: x.tags }))));

  /* 2. the candidate pool */
  const lb = await ask('leaderboard SPORTS ALL VOL', 'leaderboard', { category: 'SPORTS', timePeriod: 'ALL', orderBy: 'VOL', limit: 50, offset: 0 });
  let pool = lb.ok ? R.page(lb.data).rows.map(R.leaderRow).filter(Boolean) : [];
  check('the sports leaderboard (volume, all time) names wallets', pool.length > 0, { parsed: pool.length, first: pool[0] });
  const lbp = await ask('leaderboard SPORTS ALL PNL', 'leaderboard', { category: 'SPORTS', timePeriod: 'ALL', orderBy: 'PNL', limit: 5, offset: 0 });
  check('the PNL ordering answers too (the registered fallback)', lbp.ok && R.page(lbp.data).rows.map(R.leaderRow).filter(Boolean).length > 0);
  const lbm = await ask('leaderboard SPORTS MONTH VOL offset 50', 'leaderboard', { category: 'SPORTS', timePeriod: 'MONTH', orderBy: 'VOL', limit: 50, offset: 50 });
  check('an offset page answers (the pool is read 50 at a time)', lbm.ok && R.page(lbm.data).rows.map(R.leaderRow).filter(Boolean).length > 0);

  /* 3. one wallet's activity: the busiest of the first few that has sports trades */
  let trades = [], who = null;
  for (const w of pool.slice(0, 4)) {
    const a = await ask('activity ' + w.wallet.slice(0, 8), 'activity', { user: w.wallet, type: 'TRADE,REDEEM,SPLIT,MERGE', limit: 100, sort_direction: 'DESC' });
    const pg = a.ok ? R.page(a.data) : { rows: [] };
    const rows = pg.rows.map((x) => R.activityRow(x, w.wallet)).filter(Boolean);
    console.log('PAGE rows ' + pg.rows.length + ' parsed ' + rows.length + ' next_cursor ' + JSON.stringify(pg.next_cursor) + ' has_more ' + pg.has_more
      + ' kinds ' + JSON.stringify(rows.reduce((o, r) => { o[r.kind] = (o[r.kind] || 0) + 1; return o; }, {})));
    if (rows.some((r) => r.kind === 'TRADE')) { trades = rows; who = w.wallet; break; }
  }
  check('an activity page parses into trades with a transaction hash, a token, a side, a size and a price', trades.filter((t) => t.kind === 'TRADE').length > 0, { wallet: who, trades: trades.length });
  if (who) {
    const a2 = await ask('activity window and cursor', 'activity', { user: who, type: 'TRADE', limit: 5, sort_direction: 'ASC', start: now - 30 * 86400, end: now });
    const pg2 = a2.ok ? R.page(a2.data) : { rows: [] };
    if (pg2.next_cursor) await ask('activity next page (cursor)', 'activity', { user: who, type: 'TRADE', limit: 5, sort_direction: 'ASC', start: now - 30 * 86400, end: now, cursor: pg2.next_cursor });
    await ask('positions CLOSED', 'positions', { user: who, status: 'CLOSED', limit: 5 });
  }

  /* 4. the markets those trades were in */
  const conds = Array.from(new Set(trades.map((t) => t.condition_id))).slice(0, 5);
  let markets = [];
  if (conds.length) {
    const mk = await ask('gamma markets by condition ids', 'markets', { condition_ids: conds, limit: 10 });
    markets = mk.ok ? R.page(mk.data).rows.map((m) => R.marketRow(m)).filter(Boolean) : [];
    check('Gamma answers the markets by condition id, each with two outcomes and two tokens', markets.length > 0 && markets.every((m) => m.outcomes.length >= 2 && m.token_ids.length === m.outcomes.length),
      markets.map((m) => ({ c: m.condition_id.slice(0, 10), league: m.league, type: m.market_type, raw: m.raw_type, start: m.game_start_at && new Date(m.game_start_at).toISOString(), settle: m.settle })));
  }

  /* 5. the game events of the covered leagues, and their market types */
  for (const L of leagues.slice(0, 6)) {
    const sid = String(L.series || '').split(',')[0];
    if (!sid) continue;
    const ev = await ask('gamma events series ' + L.sport, 'events', { series_id: sid, closed: false, limit: 3, order: 'startTime', ascending: true });
    const evs = ev.ok ? R.page(ev.data).rows : [];
    const ms = [];
    evs.forEach((e) => (e.markets || []).forEach((m) => { const x = R.marketRow(m, e); if (x) ms.push({ league: x.league, type: x.market_type, raw: x.raw_type, start: x.game_start_at && new Date(x.game_start_at).toISOString(), outcomes: x.outcomes, line: x.line, q: x.question }); }));
    console.log('EVENTS ' + L.sport + ' ' + evs.length + ' markets ' + JSON.stringify(ms.slice(0, 12)));
  }
  const evt = await ask('gamma events tag nfl', 'events', { tag_slug: 'nfl', closed: false, limit: 3 });
  console.log('TAG nfl events ' + (evt.ok ? R.page(evt.data).rows.length : evt.decision));

  /* 6. a covered game market from the events: price history and holders */
  const live = [];
  for (const L of leagues.slice(0, 6)) {
    const sid = String(L.series || '').split(',')[0];
    if (!sid) continue;
    const ev = await ask('gamma events series ' + L.sport + ' (recently closed)', 'events', { series_id: sid, closed: true, limit: 2, order: 'startTime', ascending: false });
    (ev.ok ? R.page(ev.data).rows : []).forEach((e) => (e.markets || []).forEach((m) => { const x = R.marketRow(m, e); if (x && x.market_type === 'moneyline') live.push(x); }));
    if (live.length) break;
  }
  const target = live[0] || markets.find((m) => m.token_ids.length) || null;
  check('a covered game market was found (moneyline) to read prices and holders on', !!target, target && { q: target.question, league: target.league, settle: target.settle });
  if (target) {
    const t1 = target.game_start_at ? Math.floor(target.game_start_at / 1000) : now;
    const ph = await ask('clob prices-history 1m', 'prices_history', { market: target.token_ids[0], startTs: t1 - 6 * 3600, endTs: t1 + 600, fidelity: 1 });
    const hist = ph.ok ? R.priceHistory(ph.data) : [];
    check('the CLOB price history has points, each a time and a price', hist.length > 0, { points: hist.length, first: hist[0], last: hist[hist.length - 1] });
    const ph2 = await ask('clob prices-history 1m, 8 days', 'prices_history', { market: target.token_ids[0], startTs: t1 - 8 * 86400, endTs: t1 + 600, fidelity: 1 });
    console.log('LONG WINDOW points ' + (ph2.ok ? R.priceHistory(ph2.data).length : ph2.decision));
    const h2 = await ask('holders v2 include_pnl', 'holders', { condition: target.condition_id, include_pnl: true, limit: 20 });
    const hv2 = h2.ok ? R.holderRows(h2.data, target.condition_id) : [];
    const h1 = await ask('holders v1', 'holders_v1', { market: target.condition_id, limit: 20 });
    const hv1 = h1.ok ? R.holderRows(h1.data, target.condition_id) : [];
    check('holders parse into wallets with shares (v2 with average entry, or v1)', hv2.length > 0 || hv1.length > 0, { v2: hv2.slice(0, 3), v1: hv1.slice(0, 3) });
    console.log('HOLDERS v2 parsed ' + hv2.length + ' with avg price ' + hv2.filter((h) => h.avg_price != null).length + ' · v1 parsed ' + hv1.length);
  }

  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({ ran_at: new Date().toISOString(), run: process.env.GITHUB_RUN_ID || null, results, gateway: gw.stats() }, null, 1));
  console.log('\nGATEWAY ' + JSON.stringify(gw.stats()));
  console.log(failed ? 'FAILED radar sources — ' + failed + ' check(s) failed' : 'ALL GREEN radar sources');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAILED radar sources — ' + (e && e.stack || e)); process.exit(1); });
