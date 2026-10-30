#!/usr/bin/env node
/* ===========================================================================
   H-RADAR-02's design questions, asked of Polymarket's live APIs from a
   GitHub runner (the build environment cannot reach them) BEFORE anything is
   registered. Read-only: no secret, no database, nothing committed. Every
   request goes through the Radar gateway (lib/edgedesk_poly_gateway.js, a
   budget of 500). It grades nothing and selects no wallet; it answers what
   the owner's H-RADAR-02 spec (2026-10-29) needs to know first:

     Q1 periods  which timePeriod values the sports leaderboard accepts (is
                 there a 90-day window?), and whether an unknown one is
                 refused or silently read as another
     Q2 volume   whether the leaderboard's recent volume is what the wallet
                 traded: its own trades summed over the rolling 1, 7, 30 and
                 90 days and since the UTC week's and month's start, for
                 wallets ranked 100 to 500 on the 30-day board (its top is
                 high-frequency wallets no read can cover); how deep the
                 board goes; whether it answers for one wallet (user=)
     Q3 window   what reading a wallet's last 90 days newest first costs:
                 activity pages per wallet, for wallets high on the recent and
                 on the all-time leaderboard
     Q4 fees     what a covered game market charges: Gamma's fee fields and
                 the CLOB's fee rate for its tokens
     Q5 prices   what a follower can pay now: the order book's best ask, the
                 CLOB's best price on each side and midpoint, Gamma's bid, ask
                 and last trade, and the price history's last point, side by side
     Q6 screen   for each wallet ranked 1 to 300 on the 30-day board, what one
                 newest-first page of its last 90 days says about its pace and
                 style: actions and position changes (not fills) a day, fills
                 per change, two-sided markets, round trips, sells, splits and
                 merges, the covered-league share. Behaviour only, never
                 performance: the owner's high-frequency rule is set from it

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

const gw = G.make({ enabled: true, budget: G.fixedBudget(500) });
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
  /* the recent board read deeper, 50 a page, to rank 500; and how deep it goes (offset 950). The top of it is
     high-frequency wallets whose 90 days are thousands of pages (run 40975470572), so the volume check is made on
     ranks 100 to 500, whose last 30 days a read can cover */
  const month = boards.MONTH.rows.slice();
  for (let off = 50; off < 500; off += 50) {
    const r = await ask('leaderboard SPORTS MONTH VOL offset ' + off, 'leaderboard', { category: 'SPORTS', timePeriod: 'MONTH', orderBy: 'VOL', limit: 50, offset: off }, true);
    const rows = r.ok ? R.page(r.data).rows.map(R.leaderRow).filter(Boolean) : [];
    if (!rows.length) break;
    month.push(...rows);
  }
  const deep = await ask('leaderboard SPORTS MONTH VOL offset 950', 'leaderboard', { category: 'SPORTS', timePeriod: 'MONTH', orderBy: 'VOL', limit: 50, offset: 950 }, true);
  F.month_board = { read: month.length, distinct: new Set(month.map((x) => x.wallet)).size, offset_950: { status: deep.status, wallets: deep.ok ? R.page(deep.data).rows.length : 0 },
    volume_at: [1, 50, 100, 200, 300, 400, 500].map((k) => ({ rank: k, volume: month[k - 1] ? month[k - 1].volume : null })) };
  console.log('\nMONTH BOARD ' + JSON.stringify(F.month_board));
  const picks = [];
  for (const k of [1, 100, 200, 300, 400, 500]) { const x = month[k - 1]; if (x && !picks.some((p) => p.wallet === x.wallet)) picks.push({ source: 'MONTH', rank: k, wallet: x.wallet, lb: { MONTH: x.volume }, lb_user: {} }); }
  /* can the board answer for one wallet (user=)? If so, its volume in every period can be compared */
  for (const p of picks) for (const q of ['DAY', 'WEEK', 'MONTH', 'ALL']) {
    const r = await ask('leaderboard ' + q + ' user ' + p.wallet.slice(0, 10), 'leaderboard', { category: 'SPORTS', timePeriod: q, orderBy: 'VOL', user: p.wallet, limit: 1, offset: 0 }, true);
    const rows = r.ok ? R.page(r.data).rows.map(R.leaderRow).filter(Boolean) : [];
    p.lb_user[q] = { status: r.status, rows: rows.length, same_wallet: !!(rows[0] && rows[0].wallet === p.wallet), volume: rows[0] ? rows[0].volume : null, rank: rows[0] ? rows[0].rank : null };
    if (rows[0] && rows[0].wallet === p.wallet) p.lb[q] = rows[0].volume;
  }
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
      if (pages >= (p.rank === 1 ? 3 : WINDOW_PAGES)) break;   /* rank 1 is a high-frequency wallet: 3 pages show its pace */
      cursor = pg.next_cursor;
    }
    const reached = oldest != null ? (now - oldest) / DAY : null;
    p.window = { pages, complete, rows, trades, newest_first: ordered, oldest_reached_days: round(reached, 1),
      pages_for_90d_estimate: complete ? pages : (reached ? Math.ceil(pages * 90 / reached) : null) };
    const r2 = (o) => { const x = {}; for (const k of Object.keys(o)) x[k] = round(o[k], 2); return x; };
    p.traded_usdc = r2(trade); p.traded_shares = r2(shares); p.covered_league_usdc = r2(covered);
    p.ratio_lb_to_traded = { DAY_vs_d1: p.lb.DAY && trade.d1 ? round(p.lb.DAY / trade.d1, 3) : null, WEEK_vs_d7: p.lb.WEEK && trade.d7 ? round(p.lb.WEEK / trade.d7, 3) : null, WEEK_vs_wtd: p.lb.WEEK && trade.week_to_date ? round(p.lb.WEEK / trade.week_to_date, 3) : null,
      MONTH_vs_d30: p.lb.MONTH && trade.d30 ? round(p.lb.MONTH / trade.d30, 3) : null, MONTH_vs_mtd: p.lb.MONTH && trade.month_to_date ? round(p.lb.MONTH / trade.month_to_date, 3) : null };
    if (!complete) p.note = 'the 90-day read stopped at ' + WINDOW_PAGES + ' pages: the sums cover only the last ' + round(reached, 1) + ' days';
    F.wallets.push(p);
    console.log('\nQ2/Q3 ' + JSON.stringify(p));
  }

  /* ── Q6 screening: what one newest-first page (the last 90 days, 1,000 actions at most) says about the pace and
     the style of each wallet ranked 1 to SCREEN on the 30-day board. Behaviour only, never performance. A position
     change is a run of fills on one token and one side, each within 10 minutes of the last: fills are not changes ── */
  const SCREEN = 300, quant = (xs, q) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null; };
  F.screen = { wallets: [] };
  for (const x of month.slice(0, SCREEN)) {
    const r = await ask('screen ' + x.wallet.slice(0, 10), 'activity', { user: x.wallet, type: 'TRADE,REDEEM,SPLIT,MERGE', limit: 1000, sort_direction: 'DESC', start: start90, end: endS }, true);
    if (!r.ok) { F.screen.wallets.push({ wallet: x.wallet, rank: month.indexOf(x) + 1, status: r.status }); continue; }
    const pg = R.page(r.data), rows = pg.rows.map((a) => ({ ts: num(a.timestamp) * 1000, type: String(a.type || '').toUpperCase(), side: String(a.side || '').toUpperCase(),
      token: String(a.asset || a.token_id || ''), cond: String(a.condition_id || a.conditionId || ''), oi: num(a.outcome_index != null ? a.outcome_index : a.outcomeIndex),
      usdc: num(a.usdc_size != null ? a.usdc_size : a.usdcSize), covered: COVERED.test(String(a.event_slug || a.eventSlug || a.slug || '')) })).filter((a) => a.ts);
    const trades = rows.filter((a) => a.type === 'TRADE').sort((a, b) => a.ts - b.ts);
    const oldest = rows.length ? Math.min(...rows.map((a) => a.ts)) : now, days = Math.max((now - oldest) / DAY, 1 / 24);
    let changes = 0; const last = {};
    for (const t of trades) { const k = t.token + '|' + t.side; if (!(last[k] != null && t.ts - last[k] <= 10 * 60e3)) changes++; last[k] = t.ts; }
    const markets = {}, tokens = {};
    for (const t of trades) { (markets[t.cond] = markets[t.cond] || { buyOi: {} }); if (t.side === 'BUY' && t.oi != null) markets[t.cond].buyOi[t.oi] = 1; (tokens[t.token] = tokens[t.token] || {})[t.side] = 1; }
    const mk = Object.keys(markets), tk = Object.keys(tokens);
    const w = { wallet: x.wallet, rank: month.indexOf(x) + 1, month_shares: x.volume, rows: rows.length, has_more: pg.has_more, span_days: round(days, 2),
      flag_1000_in_3_days: !!(pg.has_more && days < 3), actions_per_day: round(rows.length / days, 1), changes_per_day: round(changes / days, 1),
      fills_per_change: changes ? round(trades.length / changes, 2) : null, markets_per_day: round(mk.length / days, 1),
      two_sided_share: mk.length ? round(mk.filter((c) => Object.keys(markets[c].buyOi).length > 1).length / mk.length, 3) : null,
      round_trip_share: tk.length ? round(tk.filter((t) => tokens[t].BUY && tokens[t].SELL).length / tk.length, 3) : null,
      sell_share: trades.length ? round(trades.filter((t) => t.side === 'SELL').length / trades.length, 3) : null,
      split_merge: rows.filter((a) => a.type === 'SPLIT' || a.type === 'MERGE').length,
      covered_share: rows.length ? round(rows.filter((a) => a.covered).length / rows.length, 3) : null,
      median_fill_usdc: round(quant(trades.map((t) => t.usdc), 0.5), 2) };
    F.screen.wallets.push(w);
  }
  const sw = F.screen.wallets.filter((w) => w.rows != null), part = (f) => sw.filter(f);
  const dist = (ws, k) => ({ n: ws.length, p10: quant(ws.map((w) => w[k]), 0.1), p50: quant(ws.map((w) => w[k]), 0.5), p90: quant(ws.map((w) => w[k]), 0.9) });
  F.screen.summary = { screened: sw.length, failed: F.screen.wallets.length - sw.length, flagged: part((w) => w.flag_1000_in_3_days).length,
    complete_in_one_page: part((w) => !w.has_more).length, with_covered_trades: part((w) => w.covered_share > 0).length };
  for (const k of ['actions_per_day', 'changes_per_day', 'fills_per_change', 'markets_per_day', 'two_sided_share', 'round_trip_share', 'sell_share', 'covered_share', 'median_fill_usdc'])
    F.screen.summary[k] = { flagged: dist(part((w) => w.flag_1000_in_3_days), k), not_flagged: dist(part((w) => !w.flag_1000_in_3_days), k) };
  console.log('\nQ6 SCREEN ' + JSON.stringify(F.screen.summary));
  for (const w of sw) console.log('Q6 ' + JSON.stringify(w));

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
  console.log('\nFINDINGS ' + JSON.stringify(Object.assign({}, F, { screen: { summary: F.screen.summary, wallets: 'printed above as Q6 lines, and in FINDINGS.json' } })));
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
