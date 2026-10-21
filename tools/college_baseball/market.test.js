#!/usr/bin/env node
'use strict';
/* ===========================================================================
   College baseball prices (college_baseball/market/): the gateway asked only
   when authorised; provider names joined to our teams exactly (a prefix only
   by whole words, and checked against the nickname the registry knows);
   every changed price kept with the snapshot's own time; the first price and
   the last pregame price per book and market; a live price never kept as a
   pregame one; and the model's number taken once, from a live board only.

   Run: node tools/college_baseball/market.test.js
   =========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..');
const Q = require(path.join(ROOT, 'college_baseball/market/quotes.js'));
const FQ = require(path.join(ROOT, 'college_baseball/market/fetch_quotes.js'));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 500) : '')); } };

const schools = JSON.parse(fs.readFileSync(path.join(ROOT, 'collegiate/data/schools.json'), 'utf8')).schools;
const { readCsv } = require(path.join(ROOT, 'engine/csv.js'));
const teamSeasons = readCsv(path.join(ROOT, 'college_baseball/data/teams/team_seasons.csv')).rows.filter((r) => +r.season === 2026);

/* 1. names */
{
  const I = Q.teamIndex({ schools, teamSeasons, division: 1, aliases: { aliases: { 'Miami Hurricanes': { team_id: 415 } } } });
  ok('a school\'s name with its nickname is that team ("Texas A&M Aggies", "Adams St." read as Adams State)', I.resolve('Texas A&M Aggies').id === '697' && I.resolve('Arkansas Razorbacks').id === '31' && I.resolve('Kansas State Wildcats').id === '327' && I.resolve('Kansas Jayhawks').id === '328');
  ok('our name, then the nickname the registry knows or its last words ("LSU Tigers" of "Fighting Tigers")', I.resolve('LSU Tigers').id === '365' && I.resolve('LSU Tigers').via === 'name_prefix' && I.resolve('Ole Miss Rebels').id === '433');
  ok('a prefix is whole words, and another school\'s nickname is refused ("UL Monroe", "Texas Wesleyan Rams", "Georgia Southern Eagles")', !I.resolve('UL Monroe Warhawks').id && !I.resolve('Texas Wesleyan Rams').id && !I.resolve('Georgia Southern Eagles').id && !I.resolve('North Carolina A&T Aggies').id);
  ok('an alias a person wrote is used; an unmatched name says how to add one', I.resolve('Miami Hurricanes').id === '415' && I.resolve('Miami Hurricanes').via === 'alias' && /aliases\.json/.test(Q.teamIndex({ schools, teamSeasons }).resolve('Miami Hurricanes').why));
  const twin = Q.teamIndex({ schools: [{ name: 'Alpha', nickname: 'Owls', baseball_team_id: 1 }, { name: 'Alpha', nickname: 'Owls', baseball_team_id: 2 }] });
  ok('a name two teams share is never used', twin.resolve('Alpha Owls').id === null && /two/.test(twin.resolve('Alpha Owls').why));
  ok('no-vig and conversions', Math.abs(Q.noVig(-150, 130).a - 0.5798) < 0.001 && Q.amToDec(-200) === 1.5 && Q.amToDec(150) === 2.5 && Q.amToDec(50) === null);
}

/* a provider payload (The Odds API v4, as the gateway returns it) */
const ev = (id, home, away, start, books) => ({ id, sport_key: 'baseball_ncaa', commence_time: start, home_team: home, away_team: away,
  bookmakers: books.map(([key, hm, am, line, ov, un]) => ({ key, title: key, last_update: start, markets: [
    { key: 'h2h', outcomes: [{ name: home, price: hm }, { name: away, price: am }] },
    { key: 'totals', outcomes: [{ name: 'Over', price: ov, point: line }, { name: 'Under', price: un, point: line }] }] })) });

/* 2. folding captures */
{
  const I = Q.teamIndex({ schools, teamSeasons, division: 1 });
  const start = '2027-02-13T23:00:00Z';
  const e1 = Q.normaliseEvent(ev('e1', 'Arkansas Razorbacks', 'Texas A&M Aggies', start, [['draftkings', -150, 125, 11.5, -110, -110]]), I);
  ok('an event joins both teams and reads the moneyline and the total', e1.home_id === '31' && e1.away_id === '697' && e1.books.draftkings.h2h.home === -150 && e1.books.draftkings.totals.line === 11.5);
  const ux = Q.normaliseEvent(ev('e9', 'Nowhere Tech Owls', 'Texas A&M Aggies', start, [['draftkings', -110, -110, 9.5, -110, -110]]), I);
  ok('an event whose team is not ours is kept as unmatched, with the reason', !!ux.unmatched && /Nowhere Tech Owls/.test(ux.unmatched));
  const st = { events: {} };
  let f = Q.fold(st, [e1], '2027-02-12T15:00:00Z');
  ok('the first sighting is the open, and it is logged', f.observations.length === 2 && st.events.e1.books.draftkings.h2h.open.home === -150);
  f = Q.fold(st, [e1], '2027-02-13T12:00:00Z');
  ok('an unchanged price adds nothing to the log, but is seen later', f.observations.length === 0 && st.events.e1.books.draftkings.h2h.last_at === '2027-02-13T12:00:00Z');
  const e1b = Q.normaliseEvent(ev('e1', 'Arkansas Razorbacks', 'Texas A&M Aggies', start, [['draftkings', -170, 140, 11.5, -105, -115]]), I);
  f = Q.fold(st, [e1b], '2027-02-13T22:40:00Z');
  ok('a changed price is logged with the snapshot\'s time', f.observations.length === 2 && f.observations[0].at === '2027-02-13T22:40:00Z' && f.observations[0].price.home === -170);
  const live = Q.normaliseEvent(ev('e1', 'Arkansas Razorbacks', 'Texas A&M Aggies', start, [['draftkings', -400, 300, 13.5, -110, -110]]), I);
  f = Q.fold(st, [live], '2027-02-13T23:20:00Z');
  const ml = f.finalised.find((r) => r.market === 'h2h');
  ok('a price at or after the first pitch is live and never kept; the event closes at its last pregame price', ml && ml.close.home === -170 && ml.open.home === -150 && ml.close_at === '2027-02-13T22:40:00Z' && ml.close_age_min === 20 && !st.events.e1);
  ok('the closed rows carry both teams, the book and how each team was matched', ml.home_id === '31' && ml.away_id === '697' && ml.book === 'draftkings' && ml.home_via === 'registry' && f.finalised.length === 2);
}

/* 3. the job */
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbase-market-'));
  const marketRoot = path.join(dir, 'market'); const boardDir = path.join(dir, 'board');
  const versionsFile = path.join(dir, 'versions.json');
  fs.writeFileSync(versionsFile, JSON.stringify({ current: '1.0.0', versions: [{ version: '1.0.0', config_sha256: 'abc123' }] }));
  const board = (date, pit, games) => { fs.mkdirSync(path.join(boardDir, date.slice(0, 4)), { recursive: true }); fs.writeFileSync(path.join(boardDir, date.slice(0, 4), date + '.json'), JSON.stringify({ date, point_in_time: pit, model_version: 'cbase_v1.0.0', generated_at: '2027-02-13T11:30:00Z', games })); };
  const game = (id, h, a, p) => ({ game_id: id, home: { id: h }, away: { id: a }, ml: { p_home: p }, total: { line: 11.5, over: 0.48 } });
  board('2027-02-13', 'PREGAME', [game('ncaa_1', '31', '697', 0.62), game('ncaa_2', '235', '365', 0.55)]);
  board('2027-02-14', 'RETROSPECTIVE', [game('ncaa_3', '703', '700', 0.6)]);
  const seen = [];
  let payload = null;
  const fetchImpl = async (url, init) => { seen.push({ url, body: JSON.parse(init.body), headers: init.headers }); return new Response(JSON.stringify(payload), { status: 200 }); };
  const env = { CBASE_PRICES: 'on', EDGD_SB_URL: 'https://example.supabase.co', EDGD_SB_SERVICE: 'svc' };
  const o = (extra) => Object.assign({ env, fetchImpl, marketRoot, boardDir, versionsFile, teamSeasons }, extra);

  const off = await FQ.run({ env: {}, marketRoot, fetchImpl });
  ok('without CBASE_PRICES=on nothing is asked: DISABLED, with the reason', off.status === 'DISABLED' && seen.length === 0 && /CBASE_PRICES/.test(off.reason));
  const nocred = await FQ.run({ env: { CBASE_PRICES: 'on' }, marketRoot, fetchImpl });
  ok('without gateway credentials nothing is asked: UNAVAILABLE', nocred.status === 'UNAVAILABLE' && seen.length === 0);
  payload = { ok: false, decision: 'denied_sport', reason: 'baseball_ncaa is not enabled', source: 'none', data: null };
  const denied = await FQ.run(o({ now: '2027-02-12T15:00:00Z' }));
  ok('a gateway refusal (the sport row still disabled) is reported, and nothing is kept', denied.status === 'UNAVAILABLE' && /denied_sport/.test(denied.reason) && !fs.existsSync(path.join(marketRoot, '2027')));
  ok('the request is the gateway\'s featured category for baseball_ncaa, through the shared client', seen.length === 1 && /\/functions\/v1\/odds_gateway$/.test(seen[0].url) && seen[0].body.category === 'featured' && seen[0].body.sport_key === 'baseball_ncaa' && seen[0].body.caller === 'cbase_prices' && !('apiKey' in seen[0].body));

  const start1 = '2027-02-13T23:00:00Z', start2 = '2027-02-13T19:00:00Z';
  const data = (p1, p2) => [ev('e1', 'Arkansas Razorbacks', 'Texas A&M Aggies', start1, [['draftkings', p1, 125, 11.5, -110, -110], ['fanduel', -145, 120, 11.5, -112, -108]]),
    ev('e2', 'Florida Gators', 'LSU Tigers', start2, [['draftkings', p2, -105, 12.5, -110, -110]]), ev('e3', 'Nowhere Tech Owls', 'Florida Gators', start2, [['draftkings', 100, -120, 9.5, -110, -110]])];
  payload = { ok: true, decision: 'granted', source: 'provider', fresh: true, fetched_at: '2027-02-13T12:00:00Z', request_id: 'r1', cost: 3, data: data(-150, -115) };
  const r1 = await FQ.run(o({ now: '2027-02-13T12:01:00Z' }));
  const md = path.join(marketRoot, '2027');
  const models = () => Q.readJsonl(path.join(md, 'models.jsonl'));
  ok('a live snapshot: events matched, the unmatched name listed, the prefix match listed for review', r1.status === 'LIVE' && r1.matched === 2 && r1.events === 3 && r1.unmatched_names.some((u) => u.name === 'Nowhere Tech Owls') && r1.matched_by_name_prefix.join() === 'LSU Tigers = 365', r1);
  const obs = zlib.gunzipSync(fs.readFileSync(path.join(md, 'observations', '2027-02-13.jsonl.gz'))).toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
  ok('every first price is logged with the snapshot\'s own time', obs.length === 6 && obs.every((x) => x.at === '2027-02-13T12:00:00Z'));
  ok('the model\'s number is taken from the live board, once per game, with the served configuration', models().length === 2 && models().find((m) => m.game_id === 'ncaa_1').p_home === 0.62 && models().every((m) => m.config_sha256 === 'abc123' && m.captured_at === '2027-02-13T12:01:00Z'));
  ok('the board\'s home side is kept beside the provider\'s', models().find((m) => m.game_id === 'ncaa_2').provider_home_is_ours === true);

  /* the same snapshot again (served from the gateway's cache): nothing new is folded or taken */
  payload = Object.assign({}, payload, { source: 'cache', fresh: false });
  const r2 = await FQ.run(o({ now: '2027-02-13T12:15:00Z' }));
  ok('a snapshot no newer than the last folded adds nothing', r2.status === 'CACHED' && r2.snapshot_new === false && r2.observations_kept === 0 && models().length === 2, r2);

  /* a newer snapshot after game 2 started: game 2 closes at its last pregame price; game 1's moved price is logged */
  payload = { ok: true, decision: 'granted', source: 'provider', fresh: true, fetched_at: '2027-02-13T19:30:00Z', request_id: 'r3', cost: 3, data: data(-170, -400) };
  const r3 = await FQ.run(o({ now: '2027-02-13T19:31:00Z' }));
  const lines = Q.readJsonl(path.join(md, 'lines.jsonl'));
  const g2 = lines.find((x) => x.event_id === 'e2' && x.market === 'h2h');
  ok('an event whose first pitch has passed closes at its last pregame price; the live price is never kept', r3.events_closed === 1 && g2 && g2.close.home === -115 && g2.close_at === '2027-02-13T12:00:00Z' && g2.close_age_min === 420, g2);
  ok('a still-open event\'s changed price is logged', r3.observations_kept === 1 && r3.open_events === 1);
  /* after the first pitch of game 1, with no new snapshot: it is closed by the clock */
  payload = Object.assign({}, payload, { source: 'cache', fresh: false });
  const r4 = await FQ.run(o({ now: '2027-02-13T23:05:00Z' }));
  const g1 = Q.readJsonl(path.join(md, 'lines.jsonl')).filter((x) => x.event_id === 'e1' && x.market === 'h2h');
  ok('a started event closes on the next run even without a new snapshot, per book', r4.events_closed === 1 && g1.length === 2 && g1.find((x) => x.book === 'draftkings').close.home === -170 && g1.find((x) => x.book === 'draftkings').open.home === -150);

  /* a replayed board is never a source of model numbers */
  payload = { ok: true, decision: 'granted', source: 'provider', fresh: true, fetched_at: '2027-02-14T12:00:00Z', cost: 3, data: [ev('e5', 'Texas Longhorns', 'Texas Tech Red Raiders', '2027-02-14T20:00:00Z', [['draftkings', -130, 110, 10.5, -110, -110]])] };
  const r5 = await FQ.run(o({ now: '2027-02-14T12:01:00Z' }));
  ok('a RETROSPECTIVE board gives no model number, and says why', r5.model_numbers_taken === 0 && r5.model_numbers_missing.some((m) => /RETROSPECTIVE/.test(m.why)) && !models().some((m) => m.game_id === 'ncaa_3'), r5.model_numbers_missing);

  /* the guard: the job never reads the provider key nor names the provider */
  const src = fs.readFileSync(path.join(ROOT, 'college_baseball/market/fetch_quotes.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'college_baseball/market/quotes.js'), 'utf8');
  ok('the job holds no provider key and names no provider host', !/ODDS_API_KEY|ODDS_GATEWAY_PROVIDER_KEY|the-odds-api\.com|apiKey/.test(src));

  fs.rmSync(dir, { recursive: true, force: true });

  /* 4. the one rule for a value claim (college_baseball/lib/market_gate.js) */
  {
    const G = require(path.join(ROOT, 'college_baseball/lib/market_gate.js'));
    const served = { config_sha256: 'abc' }; const gatesOk = { release_allowed: true, failing: [] };
    const v = (status, extra) => Object.assign({ status, n_bets: 612, frozen_config_sha256: 'abc', read_at: '2027-05-01T12:00:00Z' }, extra || {});
    ok('no price captured yet: no value claim, and it says why', G.gate({ mode: 'LIVE', served, gates: gatesOk }).value_claims === 'DISABLED' && /not started/.test(G.gate({ mode: 'LIVE', served, gates: gatesOk }).value_reason));
    ok('while the forward test is capturing: none (its count is shown, never its CLV)', G.gate({ mode: 'LIVE', clv: v('CAPTURING', { n_bets: 212 }), served, gates: gatesOk }).value_claims === 'DISABLED' && /212 bets of the 500/.test(G.gate({ mode: 'LIVE', clv: v('CAPTURING', { n_bets: 212 }), served, gates: gatesOk }).value_reason));
    ok('a pass on fewer than 500 bets, a failure, or an inconclusive read: none', ['PASSED_BELOW_MARKET_MINIMUM', 'FAILED', 'INCONCLUSIVE'].every((s) => G.gate({ mode: 'LIVE', clv: v(s), served, gates: gatesOk }).value_claims === 'DISABLED'));
    ok('validated, but for another configuration than the one served: none', G.gate({ mode: 'LIVE', clv: v('MARKET_VALIDATED', { frozen_config_sha256: 'old' }), served, gates: gatesOk }).value_claims === 'DISABLED');
    ok('validated and served, with release gates failing (G12, the books\' settlement rules): none', G.gate({ mode: 'LIVE', clv: v('MARKET_VALIDATED'), served, gates: { release_allowed: false, failing: ['G12'] } }).value_claims === 'DISABLED');
    ok('validated, served, gates passing, on a replayed board: none', G.gate({ mode: 'REPLAY', clv: v('MARKET_VALIDATED'), served, gates: gatesOk }).value_claims === 'DISABLED');
    const on = G.gate({ mode: 'LIVE', clv: v('MARKET_VALIDATED'), served, gates: gatesOk });
    ok('only all of them together enable a value claim', on.value_claims === 'ENABLED' && /612 bets/.test(on.value_reason) && on.market_test.status === 'MARKET_VALIDATED');
    ok('the committed board claims nothing the rule does not allow', G.load('REPLAY').value_claims === 'DISABLED');
  }

  console.log((fail === 0 ? 'ALL GREEN' : 'FAILED') + ' college baseball prices — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})();
