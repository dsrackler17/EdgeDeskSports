#!/usr/bin/env node
/* ===========================================================================
   REPLAY — nothing after the replay time leaks in, and the result stays in
   its own block until asked for. lib/edgedesk_replay.js

   Part 1 is SYNTHETIC (one invented game). Part 2 replays every committed
   2026 football game with captured quotes one hour before kickoff and checks
   the same rules on real records.

   Run: node tools/market_intel/replay.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const RP = require(path.join(ROOT, 'lib', 'edgedesk_replay.js'));
const LOAD = require(path.join(ROOT, 'tools', 'market_intel', 'replay.js'));

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function section(t) { console.log('· ' + t); }

section('synthetic: the time rules');
{
  const K = '2026-10-24T19:00:00Z', T = Date.parse(K), at = (h) => new Date(T - h * 3600000).toISOString();
  const q = (line, h) => ({ event_key: 'CFB|S1', game_id: 'S1', season: 2026, kickoff_ts: K, book: 'DraftKings', source: 'espn', market_type: 'spread', home_line: line, price_home: -110, price_away: -110, observed_at: at(h), home_team: 'A', away_team: 'B' });
  const data = {
    games: [{ event_key: 'CFB|S1', sport: 'cfb', game_id: 'S1', season: 2026, kickoff: K, home: 'A', away: 'B' }],
    forecasts: [{ event_key: 'CFB|S1', published_at: at(48), model_version: 'm_v1', home_margin: 7, fair_total: 50, p_home: 0.7 },
      { event_key: 'CFB|S1', published_at: at(6), model_version: 'm_v1', home_margin: 9, fair_total: 51, p_home: 0.75 }],
    quotes: [q(-3, 40), q(-5, 10), q(-8, 2)],
    results: [{ event_key: 'CFB|S1', home_score: 30, away_score: 20, verified_at: new Date(T + 5 * 3600000).toISOString() }]
  };
  const s = RP.stateAt(data, 'CFB|S1', at(8));
  chk('the forecast known at the time is the one published before it, not the later revision', s.forecast.home_margin === 7 && s.revisions === 1, s.forecast);
  chk('a quote captured after the replay time is withheld and counted', s.withheld_after_at.quotes === 1 && s.withheld_after_at.forecasts === 1, s.withheld_after_at);
  chk('every timeline entry is at or before the replay time', s.timeline.every((e) => Date.parse(e.at) <= Date.parse(at(8))), s.timeline);
  chk('the timeline says captured, never posted', s.timeline.filter((e) => e.kind === 'QUOTE_CAPTURED').length === 2 && /captured times are when EdgeDesk saw a price/.test(s.rule));
  chk('the market findings are the ones that could be read then (moved 2 points toward the model)', s.findings.some((f) => f.type === 'MARKET_CONVERGENCE'), s.findings.map((f) => f.type));
  chk('the result is withheld by default', s.result.state === 'WITHHELD');
  const r1 = RP.stateAt(data, 'CFB|S1', at(8), { reveal: true });
  chk('asked to reveal before the final was known: NOT_YET_KNOWN, no score', r1.result.state === 'NOT_YET_KNOWN' && r1.result.home_score === undefined, r1.result);
  const r2 = RP.stateAt(data, 'CFB|S1', new Date(T + 6 * 3600000).toISOString(), { reveal: true });
  chk('after the final was verified, revealed in its own block', r2.result.state === 'REVEALED' && r2.result.home_score === 30 && r2.state === 'STARTED');
  const early = RP.stateAt(data, 'CFB|S1', at(60));
  chk('before any record existed: NO_HISTORY with the reason, never a reconstruction', early.state === 'NO_HISTORY' && /begin/.test(early.why), early);
  chk('an unknown game is UNKNOWN_EVENT', RP.stateAt(data, 'CFB|NOPE', at(8)).state === 'UNKNOWN_EVENT');
  chk('no time: NO_TIME', RP.stateAt(data, 'CFB|S1', null).state === 'NO_TIME');
}

section('the committed 2026 football ledgers, one hour before every kickoff');
{
  const data = LOAD.load();
  const cov = RP.coverage(data);
  chk('the coverage windows are reported for every source', cov.forecasts.records > 0 && cov.quotes.records > 0 && cov.results.records > 0 && cov.quotes.from && cov.forecasts.from, cov);
  const games = data.games.filter((g) => (g.sport === 'cfb' || g.sport === 'nfl') && data.quotes.some((q) => q.event_key === g.event_key));
  let leaks = 0, revealed = 0, n = 0, withForecast = 0;
  games.forEach((g) => {
    const at = new Date(Date.parse(g.kickoff) - 3600000).toISOString();
    const s = RP.stateAt(data, g.event_key, at, { reveal: true });
    if (s.state === 'NO_HISTORY' || s.state === 'UNKNOWN_EVENT') return;
    n++;
    if (s.forecast) withForecast++;
    if (s.timeline.some((e) => Date.parse(e.at) > Date.parse(at))) leaks++;
    if (s.forecast && Date.parse(s.forecast.published_at) > Date.parse(at)) leaks++;
    if (s.result.state === 'REVEALED') revealed++;
  });
  chk('every committed football game with quotes replays (' + n + ')', n > 100, n);
  chk('in none of them does anything after the replay time appear', leaks === 0, leaks);
  chk('an hour before kickoff, no result is ever revealed', revealed === 0, revealed);
  chk('most replays carry an EdgeDesk number published before the replay time', withForecast / n > 0.9, [withForecast, n]);
}

failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 600) : '')));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'replay — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
