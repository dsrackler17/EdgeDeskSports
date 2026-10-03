#!/usr/bin/env node
/* ===========================================================================
   THE MODEL RECORD'S QUOTE LEDGER, end to end, on the committed slates.

   tools/record/quote_ledger.js + football_record.js: every priced pregame
   ESPN reading of every game the model publishes a number on is kept
   (append-only, written on a change and on the heartbeat, never after
   kickoff), for the NFL — matched through nflverse's own ESPN id — as for
   college football; the price lock then prices a pick from those rows when
   they were read at or before the number was published, and a run at a
   later hour never rewrites a lock. The feeds are mocked (TEST data shaped
   like ESPN's scoreboard and nflverse's games.csv); the slates are the
   committed football/nfl/slate.json and football/fbs/slate.json.

   Run: node tools/record/quote_ledger.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const S = require('./football_record_sources.js');
const Q = require('./quote_ledger.js');
const PL = require('./price_lock.js');

let pass = 0, fail = 0;
function chk(label, ok, detail) {
  if (ok) pass++;
  else { fail++; console.log('FAIL | ' + label + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); }
}

/* ---------------------------------------------------------------- units */
const M = { home_line: -3.5, total: 47.5, source: 'espn', book: 'Draft Kings', prices: { home: -110, away: -110, over: -105, under: -115, home_ml: -170, away_ml: 145 } };
const r1 = Q.rowsFromMarket('nfl', '2026_05_AAA_BBB', M, '2026-10-01T12:00:00Z', '2026-10-04T17:00:00Z', { home: 'B', away: 'A' });
chk('one priced reading → a spread, a total and a moneyline row, in the lab\'s quote shape', r1.map((r) => r.market_type).join() === 'spread,total,moneyline'
  && r1[0].home_line === -3.5 && r1[0].price_home === -110 && r1[1].total_points === 47.5 && r1[1].price_under === -115 && r1[2].price_away === 145 && r1.every((r) => r.book === 'draftkings' && r.is_pregame));
chk('a reading at or after kickoff is never a pregame quote', Q.rowsFromMarket('nfl', 'g', M, '2026-10-04T17:00:00Z', '2026-10-04T17:00:00Z').length === 0);
chk('a line with no price is not a price', Q.rowsFromMarket('nfl', 'g', { home_line: -3, total: 44, book: 'DraftKings' }, '2026-10-01T12:00:00Z', '2026-10-04T17:00:00Z').length === 0);
chk('a provider average is not a book', Q.rowsFromMarket('nfl', 'g', Object.assign({}, M, { book: 'consensus' }), '2026-10-01T12:00:00Z', '2026-10-04T17:00:00Z').length === 0);
const at = (h) => new Date(Date.parse('2026-10-01T12:00:00Z') + h * 3600e3).toISOString();
const re = (m, h) => Q.rowsFromMarket('nfl', '2026_05_AAA_BBB', m, at(h), '2026-10-04T17:00:00Z');
chk('written once; the same values an hour later are not written again', Q.select([], r1).length === 3 && Q.select(r1, re(M, 1)).length === 0);
chk('a moved price is written (only its market)', Q.select(r1, re(Object.assign({}, M, { prices: Object.assign({}, M.prices, { home: -115, away: -105 }) }), 1)).map((r) => r.market_type).join() === 'spread');
chk('the 6-hour heartbeat writes an unchanged market again', Q.select(r1, re(M, 6)).length === 3);
chk('inside 3 hours of kickoff the heartbeat is 50 minutes', Q.select(re(M, 74), re(M, 74.9)).length === 3 && Q.select(re(M, 74), re(M, 74.5)).length === 0);
chk('a row read by the price lock as a quote of its game', (PL.index(r1, 'record_quotes')['2026_05_AAA_BBB'] || []).length === 3);

/* ---------------------------------------------------------------- end to end */
const NFL = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'nfl', 'slate.json'), 'utf8'));
const FBS = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'fbs', 'slate.json'), 'utf8'));
const espnId = {};
NFL.games.forEach((g, i) => { espnId[g.game_id] = String(990000 + i); });
const csv = ['game_id,season,week,gameday,home_team,away_team,home_score,away_score,spread_line,total_line,home_spread_odds,away_spread_odds,over_odds,under_odds,home_moneyline,away_moneyline,espn']
  .concat(NFL.games.map((g) => [g.game_id, NFL.season, g.week, String(g.kickoff).slice(0, 10), g.home_code || 'HOM', g.away_code || 'AWY', '', '', 3, 45.5, -110, -110, -110, -110, -150, 130, espnId[g.game_id]].join(','))).join('\n');
/* one ESPN event, pregame, a named book's line and prices (TEST DATA) */
function ev(id, home, away, kickoff, hl, o) {
  o = o || {};
  const fav = hl <= 0 ? 'home' : 'away';
  return { id: String(id), date: kickoff, competitions: [{
    status: { type: { state: 'pre', completed: false, name: 'STATUS_SCHEDULED' } },
    competitors: [{ homeAway: 'home', score: '0', team: { abbreviation: 'HOM', displayName: home } }, { homeAway: 'away', score: '0', team: { abbreviation: 'AWY', displayName: away } }],
    odds: [{ provider: { name: o.book || 'DraftKings' }, details: (fav === 'home' ? 'HOM ' : 'AWY ') + (-Math.abs(hl) || 'EVEN'), spread: Math.abs(hl), overUnder: o.total || 47.5,
      overOdds: o.over || -110, underOdds: o.under || -110,
      homeTeamOdds: { favorite: fav === 'home', moneyLine: o.hml || (fav === 'home' ? -160 : 140), spreadOdds: o.hs || -108 },
      awayTeamOdds: { favorite: fav === 'away', moneyLine: o.aml || (fav === 'home' ? 140 : -160), spreadOdds: o.as || -112 } }] }] };
}
let espnNflServed = 0, espnCfbServed = 0;
function mockFetch(prices) {
  return async (url) => {
    if (url === S.URL_NFL) return csv;
    if (/cfbfastR|cfb_schedules/.test(url)) return 'game_id,season,completed,home_team,home_points,away_team,away_points\n';
    const m = /sports\/football\/(nfl|college-football)\/scoreboard\?dates=(\d{8})/.exec(url);
    if (m) {
      const nfl = m[1] === 'nfl', day = m[2];
      const games = (nfl ? NFL.games : FBS.games).filter((g) => S.etDate(g.kickoff) === day && g.model_status === 'PREDICTED');
      if (nfl) espnNflServed++; else espnCfbServed++;
      return JSON.stringify({ events: games.map((g) => ev(nfl ? espnId[g.game_id] : g.game_id, g.home_team, g.away_team, g.kickoff, prices(g))) });
    }
    throw new Error('HTTP 404 (mock)');
  };
}
const realFetch = S.fetchText;
(async function main() {
  const R = require('./football_record.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qledger-'));
  try {
    const nflPub = Date.parse(NFL.generated_at), fbsPub = Date.parse(FBS.generated_at);
    /* RUN A: 30 minutes before the NFL slate was published */
    S.fetchText = mockFetch((g) => (Number(g.model_home_line) <= 0 ? -3.5 : 3.5));
    const tA = new Date(nflPub - 30 * 60e3).toISOString();
    const A = await R.run({ write: true, out: tmp, now: tA });
    const nflFile = path.join(tmp, 'quotes', 'nfl_' + A.season + '.jsonl'), cfbFile = path.join(tmp, 'quotes', 'cfb_' + A.season + '.jsonl');
    const nflRows = Q.read(nflFile), cfbRows = Q.read(cfbFile);
    const nflAhead = Object.values(A.ledgers.nfl.games).filter((e) => Date.parse(e.kickoff) > Date.parse(tA)).length;
    chk('run A: ESPN\'s NFL scoreboard was read for the games ahead', espnNflServed > 0 && nflAhead > 0, [espnNflServed, nflAhead]);
    chk('run A: every NFL game ahead has a priced spread, total and moneyline row, keyed by its nflverse id', nflRows.length === 3 * nflAhead
      && nflRows.every((r) => /^\d{4}_\d{2}_/.test(r.game_id) && r.observed_at === tA && Date.parse(r.observed_at) < Date.parse(r.kickoff_ts)), [nflRows.length, nflAhead]);
    chk('run A: the college games ahead are kept too', cfbRows.length > 0 && cfbRows.every((r) => r.sport === 'CFB' && r.observed_at === tA));
    const lockedNfl = Object.values(A.ledgers.nfl.games).filter((e) => e.pick && e.pick.price_lock && e.pick.price_lock.spread && e.pick.price_lock.spread.status === 'locked');
    chk('run A: the NFL numbers published 30 minutes later are locked at those quotes', lockedNfl.length > 0 && lockedNfl.every((e) => e.pick.price_lock.spread.source === 'record_quotes'
      && e.pick.price_lock.spread.observed_at === tA && Date.parse(e.pick.price_lock.spread.observed_at) <= Date.parse(e.pick.at)), lockedNfl.length);
    const nflGame = lockedNfl[0];
    const cfbMiss = Object.values(A.ledgers.cfb.games).find((e) => e.pick && e.pick.price_lock && Date.parse(e.pick.at) === fbsPub && e.pick.price_lock.spread && e.pick.price_lock.spread.why === 'stale');
    chk('run A: a college number published a day later finds only a stale quote — no price yet, and it says why', !!cfbMiss || fbsPub - Date.parse(tA) <= 6 * 3600e3);

    /* RUN B: 20 minutes before the FBS slate; the NFL market has moved */
    S.fetchText = mockFetch((g) => (Number(g.model_home_line) <= 0 ? -4.5 : 4.5));
    const tB = new Date(fbsPub - 20 * 60e3).toISOString();
    const B = await R.run({ write: true, out: tmp, now: tB });
    const nflRows2 = Q.read(nflFile), cfbRows2 = Q.read(cfbFile);
    chk('run B: the ledgers only grew — nothing written before was touched', nflRows2.slice(0, nflRows.length).every((r, i) => JSON.stringify(r) === JSON.stringify(nflRows[i]))
      && cfbRows2.slice(0, cfbRows.length).every((r, i) => JSON.stringify(r) === JSON.stringify(cfbRows[i])) && nflRows2.length > nflRows.length);
    const g2 = B.ledgers.nfl.games[nflGame.game_id];
    chk('run B: a moved market never rewrites a lock', JSON.stringify(g2.pick.price_lock) === JSON.stringify(nflGame.pick.price_lock), [g2.pick.price_lock.spread, nflGame.pick.price_lock.spread]);
    const lockedCfb = Object.values(B.ledgers.cfb.games).filter((e) => e.pick && e.pick.price_lock && e.pick.price_lock.spread && e.pick.price_lock.spread.status === 'locked' && e.pick.price_lock.spread.source === 'record_quotes');
    chk('run B: college numbers published 20 minutes later are locked at the record\'s own quotes (a miss is looked up again)', lockedCfb.length > 0 && lockedCfb.every((e) => e.pick.price_lock.spread.observed_at === tB), lockedCfb.length);
    /* RUN C: the same hour again — idempotent */
    const C = await R.run({ write: true, out: tmp, now: tB });
    chk('run C: the same readings in the same hour add no row', Q.read(nflFile).length === nflRows2.length && Q.read(cfbFile).length === cfbRows2.length, C.written);
    chk('every stored row is pregame, priced and has a unique id', Q.read(nflFile).concat(Q.read(cfbFile)).every((r) => Date.parse(r.observed_at) < Date.parse(r.kickoff_ts) && (r.price_home != null || r.price_over != null))
      && new Set(Q.read(nflFile).concat(Q.read(cfbFile)).map((r) => r.quote_id)).size === Q.read(nflFile).length + Q.read(cfbFile).length);
  } finally {
    S.fetchText = realFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log((fail ? 'FAILED' : 'ALL GREEN') + ' record quote ledger — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { S.fetchText = realFetch; console.error(e); process.exit(1); });
