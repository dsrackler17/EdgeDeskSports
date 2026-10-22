#!/usr/bin/env node
/* ===========================================================================
   GAME CONTEXT — referees, travel and rest (lib/edgedesk_game_context.js,
   tools/football/game_context.js) and how they reach a snapshot's insights.
   node tools/football/game_context.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const GC = require(path.join(ROOT, 'lib', 'edgedesk_game_context.js'));
const CTX = require(path.join(__dirname, 'game_context.js'));
const GS = require(path.join(ROOT, 'lib', 'edgedesk_game_snapshot.js'));
const B = require(path.join(__dirname, 'build_game_research.js'));

let pass = 0, fail = 0;
function chk(name, ok, detail) { if (ok) pass++; else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); } }

/* ---------------------------------------------------------------- travel */
const gillette = { lat: 42.0909, lon: -71.2643, tz_name: 'America/New_York' }, soldier = { name: 'Soldier Field', lat: 41.8623, lon: -87.6167, tz_name: 'America/Chicago' };
chk('miles: Foxborough to Soldier Field is about 839 miles', Math.abs(GC.miles(gillette.lat, gillette.lon, soldier.lat, soldier.lon) - 839) <= 2, GC.miles(gillette.lat, gillette.lon, soldier.lat, soldier.lon));
chk('miles: a missing coordinate is null, never zero', GC.miles(null, 1, 2, 3) === null);
chk('utcOffset: Chicago in late October is UTC−5, New York UTC−4', GC.utcOffset('America/Chicago', '2026-10-23T00:15:00Z') === -5 && GC.utcOffset('America/New_York', '2026-10-23T00:15:00Z') === -4);
const sfAtl = GC.travel({ kickoff: '2026-10-25T17:00:00Z', venue: { name: 'Mercedes-Benz Stadium', lat: 33.7554, lon: -84.4008, tz_name: 'America/New_York' },
  home: { abbr: 'ATL', name: 'Atlanta Falcons', base: { lat: 33.7554, lon: -84.4008, tz_name: 'America/New_York' }, rest: 7 },
  away: { abbr: 'SF', name: 'San Francisco 49ers', base: { lat: 37.403, lon: -121.97, tz_name: 'America/Los_Angeles' }, rest: 6 } });
chk('travel: a coast-to-coast trip is material and favours the home side', sfAtl.material && sfAtl.favors === 'home' && sfAtl.away.tz_change_h === 3 && sfAtl.away.direction === 'east' && sfAtl.home.miles === 0, sfAtl);
chk('…its line names the trip, the early body clock and the rest gap', /^SF travels 2,1\d\d mi, 3 time zones east; kickoff is 10:00 AM on SF’s body clock; ATL has 1 more day of rest \(SF 6, ATL 7\)\.$/.test(sfAtl.short), sfAtl.short);
chk('…and the page text spells the teams out', /^San Francisco 49ers travels/.test(sfAtl.text) && /favours Atlanta Falcons\.$/.test(sfAtl.text), sfAtl.text);
const shortWeek = GC.travel({ kickoff: '2026-10-23T00:15:00Z', venue: soldier, home: { abbr: 'CHI', base: soldier, rest: 4 }, away: { abbr: 'NE', base: gillette, rest: 4 } });
chk('travel: an 839-mile, one-zone trip on equal rest is not material, and its text names no favourite', !shortWeek.material && !/favours/.test(shortWeek.text) && /both on a short week \(4 days\)/.test(shortWeek.short), shortWeek);
chk('travel: no venue, no block', GC.travel({ kickoff: '2026-10-23T00:15:00Z', venue: null }) === null);

/* ------------------------------------------------------- international venue */
const L = CTX.load({ season: 2026 });
const v = CTX.nflVenue({ venue: 'Stade de France', home_code: 'NO', venue_geography: { name: 'Caesars Superdome', lat: 29.95, lon: -90.08, tz_name: 'America/Chicago' } }, L);
chk('venue: an NFL game abroad is placed at its real stadium, not the home club’s', v && v.international && v.tz_name === 'Europe/Paris' && v.city === 'Paris', v);

/* ---------------------------------------------------------------- officials */
const rows = [];
const refs = { Heavy: 16, Middle: 13, Light: 10 };
Object.keys(refs).forEach((r) => { for (let i = 0; i < 20; i++) rows.push({ referee: r, season: i < 5 ? 2026 : 2025, flags: refs[r] + (i % 3) - 1, total: r === 'Light' ? 50 : 40, total_line: 45 }); });
const T = GC.refTable(rows, { season: 2026 });
const heavy = GC.officials('Heavy', T), light = GC.officials('Light', T);
chk('officials: ranks by three-season flags per game (most = #1)', heavy.rank === 1 && light.rank === 3 && heavy.of === 3, [heavy.rank, light.rank]);
chk('…the most-flagged crew says so, against the league average', /^Heavy crew: \d+\.\d flags\/g, most in the league \(\+3\.0 vs league\); his games 0-20 O\/U\.$/.test(heavy.short), heavy.short);
chk('…a referee’s over/under record is counted from the closing totals on file', light.ou.overs === 20 && light.ou.unders === 0 && heavy.ou.unders === 20);
chk('…a tier’s measured over rate leans the way its games went', light.tier === 'low' && light.lean === 'over' && heavy.lean === 'under' && light.tier_over.over_pct === 100, [light.tier_over, heavy.tier_over]);
chk('officials: an unassigned game has no block; an unknown referee is named without numbers', GC.officials(null, T) === null && GC.officials('Nobody', T).known === false);
const eck = L.assign['2026_07_NE_CHI'];
chk('officials: the committed week-7 assignment for NE at CHI is on file', eck && eck.referee === 'Alan Eck', eck);

/* ---------------------------------------------------------------- college crews */
const base = [{ season: 2026, home_conference: 'SEC', games: 30, flags_pg: 14 }, { season: 2026, home_conference: 'Big Ten', games: 30, flags_pg: 10 }, { season: 2026, home_conference: 'Pac-12', games: 2, flags_pg: 20 }];
const sec = GC.cfbCrew({ conference: 'SEC', baselines: base, season: 2026 });
chk('college: the home conference’s crews against all FBS crews (tiny samples left out)', sec && sec.flags_pg === 14 && sec.vs_league === 2 && sec.rank === 1 && sec.of === 2 && !sec.referee, sec);
chk('college: an assigned referee with numbers wins over the conference', GC.cfbCrew({ conference: 'SEC', baselines: base, season: 2026, referee: { referee: 'Jane Doe', flags_pg: 9, games: 20 } }).referee === 'Jane Doe');

/* ---------------------------------------------------------------- snapshots */
const R = B.build({ now: '2026-10-22T13:00:00Z', history: {}, previous: null });
const ne = R.current.games.find((g) => g.game_key === 'nfl|2026_07_NE_CHI');
chk('snapshot: NE at CHI carries its referee, its trip and the consensus line, apart from the model', ne && ne.officials && ne.officials.referee === 'Alan Eck' && ne.travel && ne.travel.away.miles > 800 && ne.consensus && ne.consensus.home_line === -3, ne && [ne.officials, ne.consensus]);
chk('…the NFL referee always earns a place in What to watch for', R.current.games.filter((g) => g.league === 'nfl' && g.officials && g.officials.known && g.model.available).every((g) => g.insights.some((i) => i.family === 'officials')));
chk('…a material trip always earns a place too', R.current.games.filter((g) => g.travel && g.travel.material && g.model.available).every((g) => g.insights.some((i) => i.family === 'travel')));
const cfb = R.current.games.filter((g) => g.league === 'cfb' && g.model.available);
chk('snapshot: college games carry the edge signals the slate measures (altitude, QB efficiency, regime change, model agreement)', ['altitude', 'qb_play', 'coaching', 'models'].every((f) => cfb.some((g) => g.insights.some((i) => i.family === f))));
chk('snapshot: college games carry their conference crews and travel', cfb.filter((g) => g.officials).length > cfb.length / 2 && cfb.filter((g) => g.travel).length > cfb.length / 2);
chk('snapshot: the insight list never repeats a family and holds at most six', R.current.games.every((g) => g.insights.length <= 6 && new Set(g.insights.map((i) => i.family)).size === g.insights.length));
chk('snapshot: the reserve flag is internal, never published', R.current.games.every((g) => g.insights.every((i) => !('reserve' in i))));
const sp = GS.graphicSpec(ne);
chk('graphic spec: carries the consensus line for the edge strip', sp.consensus && sp.consensus.total === 50.5);

console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' | game context (referees, travel, rest) | ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
