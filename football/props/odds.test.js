#!/usr/bin/env node
/* ===========================================================================
   Observed prop quotes (football/props/odds.js): The Odds API payloads →
   canonical, observed, team-scoped quotes.

     node football/props/odds.test.js
   =========================================================================== */
'use strict';
const assert = require('assert');
const O = require('./odds.js');
const EDP = require('../../lib/player_props.js');

let pass = 0, fail = 0;
const pending = [];
function chk(label, fn) {
  try { const r = fn(); if (r && typeof r.then === 'function') { pending.push(r.then(() => { pass++; }, (e) => { fail++; console.log('FAIL | ' + label + ' | ' + (e && e.message)); })); return; } pass++; }
  catch (e) { fail++; console.log('FAIL | ' + label + ' | ' + (e && e.message)); }
}

const GAME = { game_id: '2026_05_KC_BUF', season: 2026, kickoff_utc: '2026-10-04T17:00:00.000Z', home_team_id: 'BUF', away_team_id: 'KC' };
const ROSTER = [{ player_id: 'espn:1', name: 'Khalil Shakir', team_id: 'BUF' }, { player_id: 'espn:2', name: 'Travis Kelce', team_id: 'KC' },
  { player_id: 'espn:3', name: 'Josh Allen', team_id: 'BUF' }, { player_id: 'espn:4', name: 'Josh Allen', team_id: 'OTHER' }];
const OBS = '2026-10-03T12:00:00.000Z';
const EVENT = {
  id: 'evt1', home_team: 'Buffalo Bills', away_team: 'Kansas City Chiefs', commence_time: '2026-10-04T17:00:00Z',
  bookmakers: [
    { key: 'draftkings', last_update: '2026-10-03T11:59:00Z', markets: [
      { key: 'player_reception_yds', outcomes: [
        { name: 'Over', description: 'Khalil Shakir', price: -115, point: 54.5 }, { name: 'Under', description: 'Khalil Shakir', price: -105, point: 54.5 },
        { name: 'Over', description: 'Travis Kelce', price: -110, point: 61.5 }, { name: 'Under', description: 'Travis Kelce', price: -110, point: 61.5 },
        { name: 'Over', description: 'Nobody Onthisteam', price: -110, point: 20.5 } ] },
      { key: 'player_reception_yds_alternate', outcomes: [
        { name: 'Over', description: 'Travis Kelce', price: 125, point: 74.5 }, { name: 'Over', description: 'Travis Kelce', price: -190, point: 49.5 },
        { name: 'Over', description: 'Travis Kelce', price: -190, point: 49.5 } ] },
      { key: 'player_anytime_td', outcomes: [ { name: 'Yes', description: 'Travis Kelce', price: 140 }, { name: 'Khalil Shakir', price: 260 } ] },
      { key: 'player_mystery_market', outcomes: [ { name: 'Over', description: 'Travis Kelce', price: -110, point: 1.5 } ] },
      { key: 'player_receptions', outcomes: [ { name: 'Over', description: 'Travis Kelce', price: 50, point: 5.5 } ] } ] },
    { key: 'fanduel', markets: [
      { key: 'player_pass_yds', outcomes: [ { name: 'Over', description: 'Josh Allen', price: -112, point: 262.5 }, { name: 'Under', description: 'Josh Allen', price: -108, point: 262.5 } ] } ] }
  ]
};

const parsed = O.parseEventOdds(EVENT, { game: GAME, roster: ROSTER.filter((p) => p.team_id === 'BUF' || p.team_id === 'KC'), observedAt: OBS, league: 'NFL' });

chk('every stored quote is lineage = observed, provider = the-odds-api', () => {
  assert.ok(parsed.quotes.length > 0);
  parsed.quotes.forEach((q) => { assert.strictEqual(q.lineage, 'observed'); assert.strictEqual(q.provider, 'the-odds-api'); });
});
chk('provider labels are normalised: player_reception_yds → receiving_yards, player_pass_yds → pass_yards', () => {
  assert.ok(parsed.quotes.some((q) => q.source_market_key === 'player_reception_yds' && q.market_key === 'receiving_yards'));
  assert.ok(parsed.quotes.some((q) => q.source_market_key === 'player_pass_yds' && q.market_key === 'pass_yards'));
});
chk('alternate markets are the same canonical market, flagged alternate', () => {
  const alt = parsed.quotes.filter((q) => q.source_market_key === 'player_reception_yds_alternate');
  assert.ok(alt.length === 2 && alt.every((q) => q.market_key === 'receiving_yards' && q.is_alt_line && !q.is_main_line));
});
chk('a yes-only anytime TD market, including a player named in the outcome, is read as yes', () => {
  const td = parsed.quotes.filter((q) => q.market_key === 'anytime_td');
  assert.strictEqual(td.length, 2); assert.ok(td.every((q) => q.side === 'yes' && q.line === null));
});
chk('an unmapped provider market is quarantined, never guessed', () => { assert.strictEqual(parsed.refused.UNMAPPED_MARKET, 1); });
chk('a player of neither team is quarantined (team-scoped resolution, no league-wide name match)', () => {
  assert.strictEqual(parsed.refused.UNRESOLVED_PLAYER, 1);
  assert.ok(parsed.quarantined.some((x) => x.source_player_name === 'Nobody Onthisteam'));
});
chk('a price inside -99..99 is refused (Q011)', () => { assert.strictEqual(parsed.refused.Q011, 1); });
chk('a duplicated outcome is refused, never averaged', () => { assert.strictEqual(parsed.refused['duplicate outcome'], 1); });
chk('two players with one name: only the one on a team in this game is considered', () => {
  const r = O.resolvePlayer(ROSTER.filter((p) => p.team_id === 'BUF' || p.team_id === 'KC'), 'Josh Allen');
  assert.strictEqual(r.player_id, 'espn:3');
  const amb = O.resolvePlayer(ROSTER, 'Josh Allen'); assert.strictEqual(amb.player_id, null); assert.ok(/AMBIGUOUS/.test(amb.reason));
});
chk('no-vig comes from the same book, snapshot and line', () => {
  const o = parsed.quotes.find((q) => q.player_id === 'espn:1' && q.side === 'over');
  const u = parsed.quotes.find((q) => q.player_id === 'espn:1' && q.side === 'under');
  const nv = require('../../lib/research_core.js').noVigTwoWay(-115, -105);
  assert.ok(Math.abs(o.no_vig_prob - nv.a) < 1e-12 && Math.abs(u.no_vig_prob - nv.b) < 1e-12);
  const alt = parsed.quotes.find((q) => q.is_alt_line && q.line === 74.5); assert.ok(alt.no_vig_prob == null);
});
chk('minutes to kickoff and the deterministic quote id', () => {
  const q = parsed.quotes[0];
  assert.strictEqual(q.minutes_to_kick, Math.round((Date.parse(GAME.kickoff_utc) - Date.parse(OBS)) / 60000));
  assert.strictEqual(q.quote_id, O.quoteId(q)); assert.ok(/^pq_[0-9a-f]{32}$/.test(q.quote_id));
});
chk('the poll listing names every key each book offered, per player and market', () => {
  const l = parsed.listings.find((x) => x.sportsbook === 'draftkings' && x.player_id === 'espn:2' && x.market_key === 'receiving_yards');
  assert.deepStrictEqual(l.keys, ['over|49.5|1', 'over|61.5|0', 'over|74.5|1', 'under|61.5|0']);
});
chk('change-only: an unchanged price is not appended twice; a moved price is', () => {
  const again = O.parseEventOdds(EVENT, { game: GAME, roster: ROSTER.slice(0, 3), observedAt: '2026-10-03T13:00:00.000Z', league: 'NFL' });
  assert.strictEqual(O.selectNew(parsed.quotes, again.quotes).length, 0);
  const moved = JSON.parse(JSON.stringify(EVENT)); moved.bookmakers[0].markets[0].outcomes[0].price = -125;
  const m = O.parseEventOdds(moved, { game: GAME, roster: ROSTER.slice(0, 3), observedAt: '2026-10-03T14:00:00.000Z', league: 'NFL' });
  assert.strictEqual(O.selectNew(parsed.quotes, m.quotes).length, 1);
});
chk('the captured quotes price cleanly through the kernel', () => {
  const d = EDP.dist.negBinomPmf(5.5, 8);
  const q = { side: 'over', line: 61.5, american_price: -110, lineage: 'observed' };
  const e = EDP.evaluateQuote(EDP.dist.compressCdf([0, 40, 60, 80, 120, 200], [0, 0.2, 0.45, 0.7, 0.93, 1], 20, true), q, {});
  assert.ok(e.ok && e.fair_american != null); void d;
});
chk('capture spends nothing without a key', async () => {
  const r = await O.capture({ leagues: { NFL: { games: [] } } }, 'NFL', { key: null });
  assert.ok(/no ODDS_API_KEY/.test(r.skipped));
});
chk('capture stops at the credit floor and at a 401', async () => {
  const wh = { identity: { players: [] }, leagues: { NFL: { games: [Object.assign({ status: 'scheduled', home_team_name: null, espn_event_id: null }, GAME, { kickoff_utc: new Date(Date.now() + 26 * 3600e3).toISOString() })], playerGames: [] } } };
  const evs = [{ id: 'evt1', home_team: 'Buffalo Bills', away_team: 'Kansas City Chiefs', commence_time: wh.leagues.NFL.games[0].kickoff_utc }];
  const low = await O.capture(wh, 'NFL', { key: 'k', dry_run: true, force: true, getJson: async () => ({ body: evs, remaining: 3 }) });
  assert.ok(/credits below floor/.test(low.stopped || ''), JSON.stringify(low));
  let n = 0;
  const denied = await O.capture(wh, 'NFL', { key: 'k', dry_run: true, force: true, getJson: async () => { n++; if (n === 1) return { body: evs, remaining: 500 }; throw Object.assign(new Error('401'), { status: 401 }); } });
  assert.ok(/provider refused: 401/.test(denied.stopped || ''));
});

Promise.all(pending).then(() => {
  console.log((fail ? 'FAILED' : 'ALL GREEN') + ' props odds — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
});
