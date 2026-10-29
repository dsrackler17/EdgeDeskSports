#!/usr/bin/env node
/* ===========================================================================
   H-RADAR-02's design questions, asked of Polymarket's live APIs from a
   GitHub runner (the build environment cannot reach them) BEFORE anything is
   registered. Read-only: no secret, no database, nothing committed. Every
   request goes through the Radar gateway (lib/edgedesk_poly_gateway.js, a
   budget of 300). It grades nothing and selects no wallet; it answers what
   the owner's H-RADAR-02 spec (2026-10-29) needs to know first:

     Q1 periods  which timePeriod values the sports leaderboard accepts (is
                 there a 90-day window?), and whether an unknown one is
                 refused or silently read as another
     Q2 volume   whether the leaderboard's recent volume is what the wallet
                 traded: its own trades summed over the rolling 1, 7, 30 and
                 90 days and since the UTC week's and month's start
     Q3 window   what reading a wallet's last 90 days newest first costs:
                 activity pages per wallet, for wallets high on the recent and
                 on the all-time leaderboard
     Q4 fees     what a covered game market charges: Gamma's fee fields and
                 the CLOB's fee rate for its tokens
     Q5 prices   what a follower can pay now: the order book's best ask, the
                 CLOB's best price on each side and midpoint, Gamma's bid, ask
                 and last trade, and the price history's last point, side by side

   Prints each answer and FINDINGS (also FINDINGS.json in --out, with every
   body). Fails only when it cannot ask at all (no leaderboard answered).

   Run: node tools/radar/probe_h02.js --out tools/radar/out/h02
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const R = require(path.join(ROOT, 'lib', 'edgedesk_radar.js'));
const G = require(path.join(ROOT, 'lib', 'edgedesk_poly_gateway.js'));

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const OUT = arg('--out', path.join(ROOT, 'tools', 'radar', 'out', 'h02'));
fs.mkdirSync(OUT, { recursive: true });

const gw = G.make({ enabled: true, budget: G.fixedBudget(300) });
const DAY = 86400e3;
const COVERED = /^(nfl|cfb|ncaaf|college-football|nba|nhl|mlb)-/;
const PERIODS = ['DAY', 'WEEK', 'MONTH', 'ALL', 'QUARTER', 'YEAR', '3M', '90D'];
const WINDOW_PAGES = 15;
let n = 0;

const sha = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
function trim(v, depth) {
  depth = depth || 0;
  if (Array.isArray(v)) return v.slice(0, 3).map((x) => trim(x, depth + 1)).concat(v.length > 3 ? ['… ' + (v.length - 3) + ' more'] : []);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = depth > 5 ? '…' : trim(v[k], depth + 1); return o; }
  if (typeof v === 'string' && v.length > 300) return v.slice(0, 300) + '… (' + v.length + ' chars)';
  return v;
}
async function ask(label, endpoint, params, quiet) {
  const r = await gw.get(endpoint, params);
  const file = String(++n).padStart(3, '0') + '_' + label.replace(/[^a-z0-9]+/gi, '_').slice(0, 60) + '.json';
  if (r.data != null) fs.writeFileSync(path.join(OUT, file), JSON.stringify({ url: r.url, status: r.status, fetched_at: new Date().toISOString(), body: r.data }));
  console.log('\n=== ' + label + '\nGET ' + r.url + '\nstatus ' + r.status + ' · decision ' + r.decision + (r.reason ? ' · ' + String(r.reason).slice(0, 200) : ''));
  if (!quiet && r.data != null) console.log('body ' + JSON.stringify(trim(r.data)).slice(0, 1500));
  return r;
}
const num = (x) => (x == null || x === '' || !isFinite(Number(x)) ? null : Number(x));
const round = (x, k) => (x == null ? null : Math.round(x * Math.pow(10, k)) / Math.pow(10, k));

(async () => {
  const now = Date.now();
  const F = { asked_at: new Date(now).toISOString(), periods: [], wallets: [], markets: [] };

  /* ── Q1 the leaderboard's periods ── */
  const boards = {};
  for (const p of PERIODS) {
    const r = await ask('leaderboard SPORTS ' + p + ' VOL', 'leaderboard', { category: 'SPORTS', timePeriod: p, orderBy: 'VOL', limit: 50, offset: 0 });
    const rows = r.ok ? R.page(r.data).rows.map(R.leaderRow).filter(Boolean) : [];
    boards[p] = { status: r.status, ok: r.ok, rows, sha: rows.length ? sha(rows.map((x) => [x.wallet, x.volume])) : null };
  }
  for (const p of PERIODS) {
    const b = boards[p];
    const same = b.sha ? PERIODS.filter((q) => q !== p && boards[q].sha === b.sha) : [];
    F.periods.push({ period: p, status: b.status, wallets: b.rows.length, same_list_as: same,
      top3: b.rows.slice(0, 3).map((x) => ({ wallet: x.wallet, volume: x.volume, pnl: x.pnl })) });
  }
  console.log('\nQ1 PERIODS ' + JSON.stringify(F.periods.map((x) => ({ period: x.period, status: x.status, wallets: x.wallets, same_list_as: x.same_list_as }))));
  if (!PERIODS.some((p) => boards[p].rows.length)) { console.log('\nno leaderboard answered: nothing else can be asked'); process.exit(1); }

  /* ── Q2 and Q3: recent volume against the wallet's own trades, and the cost of a 90-day window ── */
  const picks = [];
  const add = (board, i, source) => { const x = (boards[board] || { rows: [] }).rows[i]; if (x && !picks.some((p) => p.wallet === x.wallet)) picks.push({ source, rank: i + 1, wallet: x.wallet, lb: {} }); };
  add('MONTH', 0, 'MONTH'); add('MONTH', 9, 'MONTH'); add('MONTH', 49, 'MONTH'); add('ALL', 0, 'ALL'); add('ALL', 49, 'ALL');
  for (const p of picks) for (const q of PERIODS) { const x = boards[q].rows.find((y) => y.wallet === p.wallet); if (x) p.lb[q] = x.volume; }
  const start90 = Math.floor((now - 90 * DAY) / 1000), endS = Math.floor(now / 1000);
  const d = new Date(now), weekStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)), monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const spans = { d1: now - DAY, d7: now - 7 * DAY, d30: now - 30 * DAY, d90: now - 90 * DAY, week_to_date: weekStart, month_to_date: monthStart };
  for (const p of picks) {
    let cursor = null, pages = 0, complete = false, ordered = true, prevTs = Infinity, oldest = null;
    const trade = {}, covered = {}, shares = {};
    let rows = 0, trades = 0;
    for (const k of Object.keys(spans)) { trade[k] = 0; covered[k] = 0; shares[k] = 0; }
    for (;;) {
      const r = await ask('activity 90d DESC ' + p.wallet.slice(0, 10) + ' p' + (pages + 1), 'activity',
        { user: p.wallet, type: 'TRADE,REDEEM,SPLIT,MERGE', limit: 1000, sort_direction: 'DESC', start: start90, end: endS, cursor }, true);
      if (!r.ok) break;
      pages++;
      const pg = R.page(r.data);
      for (const a of pg.rows) {
        rows++;
        const ts = num(a.timestamp) != null ? num(a.timestamp) * 1000 : null;
        if (ts == null) continue;
        if (ts > prevTs) ordered = false;
        prevTs = ts; oldest = ts;
        if (String(a.type || '').toUpperCase() !== 'TRADE') continue;
        trades++;
        const usdc = num(a.usdc_size != null ? a.usdc_size : a.usdcSize), sz = num(a.size);
        const isCovered = COVERED.test(String(a.event_slug || a.eventSlug || a.slug || ''));
        for (const k of Object.keys(spans)) if (ts >= spans[k]) { trade[k] += usdc || 0; shares[k] += sz || 0; if (isCovered) covered[k] += usdc || 0; }
      }
      if (!pg.has_more) { complete = true; break; }
      if (pages >= WINDOW_PAGES) break;
      cursor = pg.next_cursor;
    }
    const reached = oldest != null ? (now - oldest) / DAY : null;
    p.window = { pages, complete, rows, trades, newest_first: ordered, oldest_reached_days: round(reached, 1),
      pages_for_90d_estimate: complete ? pages : (reached ? Math.ceil(pages * 90 / reached) : null) };
    const r2 = (o) => { const x = {}; for (const k of Object.keys(o)) x[k] = round(o[k], 2); return x; };
    p.traded_usdc = r2(trade); p.traded_shares = r2(shares); p.covered_league_usdc = r2(covered);
    p.ratio_lb_to_traded = { WEEK_vs_d7: p.lb.WEEK && trade.d7 ? round(p.lb.WEEK / trade.d7, 3) : null, WEEK_vs_wtd: p.lb.WEEK && trade.week_to_date ? round(p.lb.WEEK / trade.week_to_date, 3) : null,
      MONTH_vs_d30: p.lb.MONTH && trade.d30 ? round(p.lb.MONTH / trade.d30, 3) : null, MONTH_vs_mtd: p.lb.MONTH && trade.month_to_date ? round(p.lb.MONTH / trade.month_to_date, 3) : null };
    if (!complete) p.note = 'the 90-day read stopped at ' + WINDOW_PAGES + ' pages: the sums cover only the last ' + round(reached, 1) + ' days';
    F.wallets.push(p);
    console.log('\nQ2/Q3 ' + JSON.stringify(p));
  }

  /* ── Q4 and Q5: fees and the price a follower can pay, on covered games starting soon ── */
  const sp = await ask('gamma sports', 'sports', {});
  const series = {};
  for (const s of sp.ok ? R.page(sp.data).rows : []) {
    const lg = String(s.sport || s.slug || '').toLowerCase();
    if (['nba', 'nhl', 'nfl', 'cfb', 'ncaaf', 'mlb'].indexOf(lg) >= 0) series[lg] = (series[lg] || []).concat(String(s.series || '').split(',').map((x) => x.trim()).filter(Boolean));
  }
  const picked = [];
  for (const lg of ['nba', 'nhl', 'nfl', 'cfb', 'ncaaf']) {
    if (picked.length >= 3 || !series[lg]) continue;
    const ev = await ask('events ' + lg, 'events', { series_id: series[lg][0], closed: false, end_date_min: new Date(now).toISOString(), end_date_max: new Date(now + 3 * DAY).toISOString(), limit: 5 }, true);
    for (const e of ev.ok ? R.page(ev.data).rows : []) {
      for (const raw of e.markets || []) {
        const m = R.marketRow(raw, e);
        if (m && m.market_type && m.token_ids.length === 2 && !m.closed && picked.length < 3 && !picked.some((x) => x.m.market_type === m.market_type && x.m.league === m.league)) picked.push({ m, raw });
      }
    }
  }
  for (const { m, raw } of picked) {
    const tok = m.token_ids[0];
    const gammaFields = {};
    for (const k of Object.keys(raw)) if (/fee|bid|ask|spread|lasttrade|ticksize|minimum|rewards|negrisk/i.test(k)) gammaFields[k] = raw[k];
    const book = await ask('book ' + m.slug, 'book', { token_id: tok });
    const buy = await ask('price BUY ' + m.slug, 'price', { token_id: tok, side: 'BUY' });
    const sell = await ask('price SELL ' + m.slug, 'price', { token_id: tok, side: 'SELL' });
    const mid = await ask('midpoint ' + m.slug, 'midpoint', { token_id: tok });
    const fee = await ask('fee rate ' + m.slug, 'fee_rate', { token_id: tok });
    const hist = await ask('history last hour ' + m.slug, 'prices_history', { market: tok, startTs: Math.floor(now / 1000) - 3600, endTs: Math.floor(now / 1000), fidelity: 1 }, true);
    const levels = (side) => ((book.ok && book.data && book.data[side]) || []).map((x) => ({ p: num(x.price), s: num(x.size) })).filter((x) => x.p != null);
    const bids = levels('bids'), asks = levels('asks');
    const pts = hist.ok ? R.priceHistory(hist.data) : [];
    const rec = {
      league: m.league, type: m.market_type, question: m.question, slug: m.slug, starts: m.game_start_at ? new Date(m.game_start_at).toISOString() : null, outcome: m.outcomes[0],
      gamma: { outcome_price: m.last_prices && m.last_prices[0], fields: gammaFields },
      book: { status: book.status, best_bid: bids.length ? Math.max(...bids.map((x) => x.p)) : null, best_ask: asks.length ? Math.min(...asks.map((x) => x.p)) : null,
        ask_size_at_best: asks.length ? asks.filter((x) => x.p === Math.min(...asks.map((y) => y.p))).reduce((a, x) => a + (x.s || 0), 0) : null,
        levels: { bids: bids.length, asks: asks.length }, keys: book.ok && book.data ? Object.keys(book.data) : null },
      price_buy: { status: buy.status, body: buy.data }, price_sell: { status: sell.status, body: sell.data }, midpoint: { status: mid.status, body: mid.data },
      fee_rate: { status: fee.status, body: fee.data },
      history: { status: hist.status, points: pts.length, last: pts.length ? { at: new Date(pts[pts.length - 1].t).toISOString(), p: pts[pts.length - 1].p } : null }
    };
    F.markets.push(rec);
    console.log('\nQ4/Q5 ' + JSON.stringify(rec));
  }
  if (!picked.length) console.log('\nQ4/Q5: no covered game market starting in the next 3 days was found');

  F.gateway = gw.stats();
  fs.writeFileSync(path.join(OUT, 'FINDINGS.json'), JSON.stringify(F, null, 1));
  console.log('\nFINDINGS ' + JSON.stringify(F));
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
