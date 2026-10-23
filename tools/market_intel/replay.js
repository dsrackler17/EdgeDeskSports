#!/usr/bin/env node
/* ===========================================================================
   EDGEDESK REPLAY, from the committed ledgers. lib/edgedesk_replay.js does the
   work; this file only loads what the repository holds into its shape.

     node tools/market_intel/replay.js --event CFB|401862801 --at 2026-10-16T18:00:00Z [--reveal]
     node tools/market_intel/replay.js --coverage

   Sources (read-only):
     performance/ledger/{forecasts,quotes,results}/<sport>-2026.jsonl
     record/football/{cfb,nfl}_2026.json          first and last pregame numbers, finals
     record/football/quotes/{cfb,nfl}_2026.jsonl  every captured ESPN/DraftKings reading
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const RP = require(path.join(ROOT, 'lib', 'edgedesk_replay.js'));
const SEASON = 2026;
const isNum = (x) => typeof x === 'number' && isFinite(x);
function jsonl(p) { const f = path.join(ROOT, p); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; }

function load() {
  const games = {}, forecasts = [], quotes = [], results = [];
  const game = (k, g) => { if (!games[k]) games[k] = Object.assign({ event_key: k }, g); };
  ['cfb', 'nfl', 'nba', 'nhl', 'wnba'].forEach((sp) => {
    jsonl('performance/ledger/forecasts/' + sp + '-' + SEASON + '.jsonl').forEach((f) => {
      game(f.event_key, { sport: sp, game_id: f.event_id, season: SEASON, kickoff: f.start_utc, home: f.home && f.home.name, away: f.away && f.away.name });
      const fc = f.forecast || {}, ps = fc.projected_score || {};
      forecasts.push({ event_key: f.event_key, published_at: f.model.predicted_at, model_version: f.model.id,
        home_margin: isNum(ps.margin) ? ps.margin : isNum(fc.fair_home_line) ? -fc.fair_home_line : null,
        fair_total: isNum(fc.fair_total) ? fc.fair_total : isNum(fc.expected_total) ? fc.expected_total : null, p_home: isNum(fc.p_home) ? fc.p_home : null,
        source: 'performance/ledger/forecasts/' + sp + '-' + SEASON + '.jsonl#' + f.seq, tier: (f.capture || {}).method === 'ledger_capture' ? 'VERIFIED' : 'RECORDED' });
    });
    jsonl('performance/ledger/quotes/' + sp + '-' + SEASON + '.jsonl').forEach((q) => {
      const base = { event_key: q.event_key, game_id: q.event_key.split('|')[1], season: SEASON, kickoff_ts: q.start_utc, book: q.book, source: q.source, observed_at: q.captured_at || q.observed_at };
      if (q.spread) quotes.push(Object.assign({}, base, { market_type: 'spread', home_line: q.spread.home_point, price_home: q.spread.home_price, price_away: q.spread.away_price }));
      if (q.total) quotes.push(Object.assign({}, base, { market_type: 'total', total_points: q.total.point, price_over: q.total.over, price_under: q.total.under }));
      if (q.moneyline) quotes.push(Object.assign({}, base, { market_type: 'moneyline', price_home: q.moneyline.home, price_away: q.moneyline.away }));
    });
    jsonl('performance/ledger/results/' + sp + '-' + SEASON + '.jsonl').forEach((r) => {
      if (r.state === 'FINAL') results.push({ event_key: r.event_key, home_score: r.home_score, away_score: r.away_score, verified_at: r.verified_at, source: 'performance/ledger/results/' + sp + '-' + SEASON + '.jsonl#' + r.seq });
    });
  });
  ['cfb', 'nfl'].forEach((sp) => {
    const rec = JSON.parse(fs.readFileSync(path.join(ROOT, 'record', 'football', sp + '_' + SEASON + '.json'), 'utf8'));
    Object.values(rec.games).forEach((g) => {
      const k = sp.toUpperCase() + '|' + g.game_id;
      game(k, { sport: sp, game_id: g.game_id, season: SEASON, kickoff: g.kickoff, home: g.home, away: g.away });
      ['first', 'pick'].forEach((w) => { const x = g[w]; if (x && x.at && isNum(x.home_line)) forecasts.push({ event_key: k, published_at: x.at, model_version: x.model_version || g.model_version,
        home_margin: -x.home_line, fair_total: isNum(x.total) ? x.total : null, p_home: isNum(x.home_win_prob) ? x.home_win_prob : null, source: 'record/football/' + sp + '_' + SEASON + '.json#' + g.game_id + '.' + w, tier: 'RECORDED' }); });
      if (g.final && g.final.home_score != null && !results.some((r) => r.event_key === k)) results.push({ event_key: k, home_score: g.final.home_score, away_score: g.final.away_score, verified_at: g.final.at, source: 'record/football/' + sp + '_' + SEASON + '.json' });
    });
    jsonl('record/football/quotes/' + sp + '_' + SEASON + '.jsonl').forEach((q) => quotes.push(Object.assign({}, q, { event_key: sp.toUpperCase() + '|' + q.game_id, season: SEASON })));
  });
  return { games: Object.values(games), forecasts, quotes, results };
}

if (require.main === module) {
  const a = process.argv.slice(2), arg = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const data = load();
  if (a.includes('--coverage')) { console.log(JSON.stringify(RP.coverage(data), null, 1)); process.exit(0); }
  const ev = arg('--event'), at = arg('--at');
  if (!ev || !at) { console.error('usage: replay.js --event CFB|<id> --at <ISO time> [--reveal] | --coverage'); process.exit(2); }
  console.log(JSON.stringify(RP.stateAt(data, ev, at, { reveal: a.includes('--reveal') }), null, 1));
}
module.exports = { load };
