#!/usr/bin/env node
/* ===========================================================================
   lib/edgedesk_radar.js against what Polymarket really sent. Offline.

   tools/radar/fixtures/ was recorded from radar-sources run 40812412377
   (https://github.com/dsrackler17/EdgeDeskSports/actions/runs/40812412377),
   the live probe on GitHub's runner (tools/radar/fetch_sources.js): each file
   is one response as the probe printed it (arrays cut to their first 3
   items, long strings to 400 characters), with the request, the status, the
   full body's byte count and sha256, and the run. Recorded once, never
   edited: a parser that stops reading one is a parser change, not a fixture
   change.

     leaderboard   the sports leaderboard by volume (v1, camelCase)
     activity      a wallet's page newest first, and the H-RADAR-01 runner's
                   page oldest first in the study window (v2, snake_case)
     markets       resolved markets asked with closed=true, open ones without
     events        NFL (with its player-props event), NHL (totals) and a
                   closed college football game
     prices        a 2025 market's minute price history
     holders       v2 (with average entry) and v1

   Run: node tools/radar/fixtures.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const R = require(path.join(ROOT, 'lib', 'edgedesk_radar.js'));
const V = require(path.join(ROOT, 'research', 'radar', 'run_validation.js'));
const REG = require(path.join(ROOT, 'research', 'radar', 'registration_h_radar_01.json'));
const RULES = REG.spec.rules;
const DIR = path.join(__dirname, 'fixtures');
let pass = 0, fail = 0;
const failures = [];
const chk = (name, ok, detail) => { if (ok) pass++; else { fail++; failures.push({ name, detail }); } };
const F = (n) => JSON.parse(fs.readFileSync(path.join(DIR, n), 'utf8'));
const TX = /^0x[0-9a-f]{64}$/, WALLET = /^0x[0-9a-f]{40}$/, TOKEN = /^\d{20,}$/;

/* ── the recordings ──────────────────────────────────────────────────── */
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
chk('eleven recordings', files.length === 11, files);
for (const f of files) {
  const r = F(f).recorded || {};
  chk(f + ': recorded from the probe run, with its request, status and the full body\'s sha256',
    r.run === 'https://github.com/dsrackler17/EdgeDeskSports/actions/runs/40812412377' && r.status === 200 && /^https:\/\/(data-api|gamma-api|clob)\.polymarket\.com\//.test(r.url)
      && /^[0-9a-f]{64}$/.test(r.body_sha256) && r.body_bytes > 0, r);
}

/* ── the leaderboard ─────────────────────────────────────────────────── */
{
  const pg = R.page(F('leaderboard_sports_all_vol.json').body);
  const rows = pg.rows.map(R.leaderRow);
  chk('leaderboard: a bare array, no next page', pg.rows.length === 3 && pg.next_cursor === null && pg.has_more === false);
  chk('leaderboard: every row names a wallet, its rank, volume and name', rows.every((x) => x && WALLET.test(x.wallet) && x.rank >= 1 && x.volume > 0 && x.name), rows);
  chk('leaderboard: ordered by volume, as asked', rows[0].rank === 1 && rows[0].volume >= rows[1].volume && rows[1].volume >= rows[2].volume, rows.map((x) => x.volume));
}

/* ── activity ────────────────────────────────────────────────────────── */
{
  const owner = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea';
  const pg = R.page(F('activity_page.json').body);
  const rows = pg.rows.map((a) => R.activityRow(a, owner));
  chk('activity: a page with a cursor to the next one', pg.rows.length === 3 && typeof pg.next_cursor === 'string' && pg.next_cursor.length > 20 && pg.has_more === true);
  chk('activity: every row parses (v2 spells it snake_case: transaction_hash, token_id, event_slug)', rows.every((x) => x && x.wallet === owner && TX.test(x.tx_hash) && x.condition_id && x.ts > 1.7e12), rows);
  const trades = rows.filter((x) => x.kind === 'TRADE');
  chk('activity: a trade has its side, price, size, token and dollars', trades.length > 0 && trades.every((t) => (t.side === 'BUY' || t.side === 'SELL') && t.price > 0 && t.price < 1 && t.size > 0 && TOKEN.test(t.token_id) && t.usdc > 0), trades);
  chk('activity: seconds become milliseconds', rows[0].ts === pg.rows[0].timestamp * 1000);

  const rp = R.page(F('activity_runner_page.json').body);
  const rr = rp.rows.map((a) => R.activityRow(a, owner));
  const W = REG.machine.window_dates, T0 = Date.parse(W.training[0] + 'T00:00:00Z'), H1 = Date.parse(W.holdout[1] + 'T00:00:00Z');
  chk('activity (the runner\'s form): oldest first, inside the study window, with a cursor', rr.every((x, i) => x && x.ts >= T0 && x.ts < H1 && (i === 0 || x.ts >= rr[i - 1].ts)) && rp.has_more === true && !!rp.next_cursor, rr.map((x) => x && x.ts));
  chk('activity: a tennis match is not a covered league\'s event (the runner\'s slug filter)', rr.every((x) => !V.LEAGUE_PREFIX.test(String(x.event_slug || '')) || /^(nfl|cfb|ncaaf|college-football|nba|nhl|mlb)-/.test(x.event_slug)), rr.map((x) => x.event_slug));
}

/* ── markets ─────────────────────────────────────────────────────────── */
{
  const closed = R.page(F('gamma_markets_closed.json').body).rows.map((m) => R.marketRow(m));
  chk('markets (closed=true): three resolved game markets, each settled 1/0', closed.length === 3 && closed.every((m) => m && m.closed && m.settle && m.settle.length === 2 && m.settle[0] + m.settle[1] === 1), closed.map((m) => m && m.settle));
  chk('markets: the league from the event\'s tags, or the slug when there are none', closed[0].league === 'mlb' && closed[0].league_source === 'tag' && closed[1].league === 'cfb' && closed[1].league_source === 'slug');
  chk('markets: a 2025 college football market with no sportsMarketType is a moneyline because its question names its two outcomes',
    closed[1].market_type === 'moneyline' && closed[1].type_source === 'question' && closed[1].raw_type === null && closed[1].question === 'Virginia Tech vs. South Carolina', closed[1]);
  chk('markets: every one is a covered game, with its start and its two tokens', closed.every((m) => R.covered(m, RULES) && m.game_start_at > 0 && m.token_ids.length === 2 && m.token_ids.every((t) => TOKEN.test(t))));
  chk('markets: a moneyline has no line (Gamma\'s "spread" is the order book\'s bid-ask spread, not a point)', closed.every((m) => m.line === null), closed.map((m) => m.line));
  const open = R.page(F('gamma_markets_open.json').body).rows.map((m) => R.marketRow(m));
  chk('markets (open): no settlement, the current prices instead', open.length === 3 && open.every((m) => m && !m.closed && m.settle === null && m.last_prices.every((p) => p > 0 && p < 1)), open.map((m) => m && m.last_prices));
  chk('markets: soccer and tennis are not covered leagues', open.every((m) => m.league === null && !R.covered(m, RULES)), open.map((m) => m.event_slug));
}

/* ── events ──────────────────────────────────────────────────────────── */
const fromEvents = (n) => [].concat(...R.page(F(n).body).rows.map((e) => (e.markets || []).map((m) => R.marketRow(m, e))));
{
  const nfl = fromEvents('gamma_events_nfl.json');
  const games = nfl.filter((m) => R.covered(m, RULES)), props = nfl.filter((m) => !R.covered(m, RULES));
  chk('NFL events: moneylines and spreads are covered, each with its start', games.length === 6 && games.every((m) => m.league === 'nfl' && (m.market_type === 'moneyline' || m.market_type === 'spreads') && m.game_start_at > 0));
  chk('NFL events: a spread\'s line is its point', games.filter((m) => m.market_type === 'spreads').map((m) => m.line).join() === '-0.5,-1.5,-1.5,-2.5');
  chk('NFL events: a moneyline has no line', games.filter((m) => m.market_type === 'moneyline').every((m) => m.line === null), games.map((m) => m.line));
  chk('NFL events: the player-props event is NFL, and none of its markets is covered', props.length === 3 && props.every((m) => m.league === 'nfl' && m.market_type === null));
  const nhl = fromEvents('gamma_events_nhl.json');
  const tot = nhl.filter((m) => m.market_type === 'totals');
  chk('NHL events: totals are Over / Under at their line', tot.length === 6 && tot.every((m) => m.outcomes.join() === 'Over,Under' && (m.line === 4.5 || m.line === 5.5)));
  chk('NHL events: a finished game settles (Over at 4.5 won), the others are open', nhl[1].settle.join() === '1,0' && nhl.slice(3).every((m) => m.settle === null));
  const cfb = fromEvents('gamma_events_cfb_closed.json');
  const ml = cfb.find((m) => m.market_type === 'moneyline');
  chk('college football (closed): the moneyline settled for Missouri State', ml && ml.question === 'Sam Houston vs. Missouri State' && ml.league === 'cfb' && ml.settle.join() === '0,1', ml);
  chk('college football: the exact-margin Yes / No markets are not game markets', cfb.filter((m) => /^Exact Margin/.test(m.question)).every((m) => !R.covered(m, RULES)));
}

/* ── prices and holders ──────────────────────────────────────────────── */
{
  const h = R.priceHistory(F('clob_prices_history.json').body);
  chk('prices: {t, p} in seconds become milliseconds, ascending', h.length === 3 && h[0].t === 1747824607000 && h.every((x, i) => i === 0 || x.t > h[i - 1].t) && h.every((x) => x.p === 0.59), h);
  chk('prices: the follow price reads from it (the last point at or before, within 10 minutes)', R.priceAt(h, 1747824700000, 10 * 60000).t === 1747824666000);

  const cond = '0x402afa0213df8a28aceb7f537713095fb1fb36fdb5ece8f28bf74d722b78b23d';
  const v2 = R.holderRows(F('holders_v2.json').body, cond);
  chk('holders v2: wallets, shares, average entry, token and side (3 + 2 as printed)', v2.length === 5 && v2.every((x) => WALLET.test(x.wallet) && x.shares > 0 && x.avg_price > 0 && x.avg_price < 1 && TOKEN.test(x.token_id) && (x.outcome_index === 0 || x.outcome_index === 1)), v2);
  chk('holders v2: the largest holder, 50,000 shares at 0.1882', v2[0].wallet === '0x8a260ebadf8ef07e693dd1b0be120b3330dd73c3' && v2[0].shares === 50000 && v2[0].avg_price === 0.1882 && v2[0].cost === 9410);
  chk('holders: a bio is never read', v2.every((x) => !('bio' in x)) && R.holderRows(F('holders_v1.json').body, cond).every((x) => !('bio' in x)));
  const v1 = R.holderRows(F('holders_v1.json').body, cond);
  chk('holders v1: the same wallets, without an average entry (3 + 1 as printed)', v1.length === 4 && v1[0].wallet === v2[0].wallet && v1[0].shares === 50000 && v1.every((x) => x.avg_price === null && x.cost === null && TOKEN.test(x.token_id)), v1);
  chk('holders: the public-name flag is read in both spellings', v2[0].display_public === true && v1[0].display_public === true);
}

failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 500) : '')));
console.log((fail ? 'FAILED' : 'ALL GREEN') + ' radar fixtures — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
