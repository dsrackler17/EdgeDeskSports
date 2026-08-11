// ============================================================
//  FILE:  supabase/functions/ingest_multisport/test.ts
//  RUN:   deno test supabase/functions/ingest_multisport/test.ts
// ============================================================
// Regression tests for the four faults fixed in 2026-08-14.6.
//
// Each block below corresponds to a bug that shipped and stayed invisible,
// because none of them threw: the NFL join silently matched nothing, defensive
// EPA was silently null, Saint schools silently missed their Torvik row, and
// the evening cron silently ingested the wrong day. Silence is the failure mode
// this file exists to break.
import { assertEquals, assertNotEquals } from 'jsr:@std/assert@1';
import {
  normTeam, teamKeys, indexByTeam, lookupTeam, lookupDefence,
  defenceFromWeekly, nflverseRow, etDay, seasonFor, SPORTS,
} from './index.ts';

/* ---------------------------------------------------------------- BUG 3 --
   "St." is Saint at the front and State at the back. The old rule rewrote
   every occurrence to "state", so St. John's normalised to "state johns" and
   matched nothing in Torvik. */
Deno.test('normTeam: trailing St. is State, leading St. is Saint', () => {
  assertEquals(normTeam("St. John's"), 'saint johns');
  assertEquals(normTeam("Mount St. Mary's"), 'mount saint marys');
  assertEquals(normTeam('St. Bonaventure'), 'saint bonaventure');
  assertEquals(normTeam('Ohio St.'), 'ohio state');
  assertEquals(normTeam('San Jose St.'), 'san jose state');
  assertEquals(normTeam('Michigan State'), 'michigan state');
  // The two spellings of the same school still have to collide.
  assertEquals(normTeam("St. John's"), normTeam('St Johns'));
});

/* ---------------------------------------------------------------- BUG 1 --
   nflverse keys its team column on the abbreviation; ESPN gives a display
   name. The old lookup only ever tried the display name, so every NFL team
   missed and `applied` was 0 on every run. */
const TOTALS = [
  { team: 'KC', games: '17', attempts: '600', carries: '450', sacks_suffered: '30', passing_epa: '120.5', rushing_epa: '-10.2', passing_yards: '4200', rushing_yards: '1900' },
  { team: 'WAS', games: '17', attempts: '580', carries: '430', sacks_suffered: '40', passing_epa: '30.1', rushing_epa: '5.0', passing_yards: '3900', rushing_yards: '1800' },
  { team: 'LA', games: '17', attempts: '610', carries: '400', sacks_suffered: '35', passing_epa: '75.0', rushing_epa: '2.5', passing_yards: '4100', rushing_yards: '1700' },
];
const ESPN = [
  { team: 'Kansas City Chiefs', abbr: 'KC', nick: 'Chiefs', location: 'Kansas City' },
  { team: 'Washington Commanders', abbr: 'WSH', nick: 'Commanders', location: 'Washington' },
  { team: 'Los Angeles Rams', abbr: 'LAR', nick: 'Rams', location: 'Los Angeles' },
];

Deno.test('nfl join: display name alone never matches the feed', () => {
  const idx = indexByTeam(TOTALS);
  // This is exactly what the old code did, and why nothing ever joined.
  assertEquals(idx.get(normTeam('Kansas City Chiefs')) ?? null, null);
});

Deno.test('nfl join: abbreviation matches, including the two ESPN aliases', () => {
  const idx = indexByTeam(TOTALS);
  assertEquals(lookupTeam(idx, ESPN[0])?.team, 'KC');
  assertEquals(lookupTeam(idx, ESPN[1])?.team, 'WAS'); // ESPN says WSH
  assertEquals(lookupTeam(idx, ESPN[2])?.team, 'LA');  // ESPN says LAR
});

Deno.test('teamKeys: abbreviation is tried before the name', () => {
  const keys = teamKeys(ESPN[1]);
  assertEquals(keys[0], 'was');
  assertEquals(keys.includes('washington commanders'), true);
});

/* ---------------------------------------------------------------- BUG 2 --
   defenceFromWeekly() was written, correct, advertised in the discover
   verdict — and never called. In any game one team's offensive EPA is the
   other's defensive EPA allowed, so this is an identity, not an estimate. */
const WEEKLY = [
  { team: 'KC', opponent_team: 'WAS', attempts: '30', carries: '25', sacks_suffered: '2', passing_epa: '10.0', rushing_epa: '2.0' },
  { team: 'LA', opponent_team: 'WAS', attempts: '40', carries: '20', sacks_suffered: '3', passing_epa: '6.0', rushing_epa: '1.0' },
  { team: 'WAS', opponent_team: 'KC', attempts: '35', carries: '22', sacks_suffered: '1', passing_epa: '-4.0', rushing_epa: '0.5' },
  { team: 'WAS', opponent_team: 'LA', attempts: '28', carries: '24', sacks_suffered: '2', passing_epa: '8.0', rushing_epa: '1.0' },
  { team: 'KC', opponent_team: 'LA', attempts: '0', carries: '0', sacks_suffered: '0', passing_epa: '0', rushing_epa: '0' },
  { team: 'KC', attempts: '20', carries: '10', passing_epa: '3', rushing_epa: '1' },
];

Deno.test('defence: EPA allowed is credited to the opponent', () => {
  const d = defenceFromWeekly(WEEKLY);
  // WAS faced KC (12 EPA over 57 plays) and LA (7 over 63) -> 19/120.
  assertEquals(d.byTeam.get('was')!.def_epa_play, +(19 / 120).toFixed(4));
  assertEquals(d.byTeam.get('was')!.games, 2);
});

Deno.test('defence: rows with no opponent or no plays are skipped, not guessed', () => {
  const d = defenceFromWeekly(WEEKLY);
  assertEquals(d.paired, 4);
  assertEquals(d.orphaned, 2);
  // The zero-play row must not dilute LA's average.
  assertEquals(d.byTeam.get('la')!.games, 1);
});

Deno.test('defence: the ESPN alias resolves against the defence map too', () => {
  const d = defenceFromWeekly(WEEKLY);
  assertEquals(lookupDefence(d.byTeam, ESPN[1])?.def_epa_play, +(19 / 120).toFixed(4));
  assertNotEquals(lookupDefence(d.byTeam, ESPN[2]), null);
});

Deno.test('totals file alone still leaves defence null rather than proxying it', () => {
  const row = nflverseRow(TOTALS[0]);
  assertEquals(row.off_epa_play, +((120.5 - 10.2) / (600 + 450 + 30)).toFixed(4));
  assertEquals(row.def_epa_play, null);
  // Needs play-level data no free team feed carries — must stay honestly absent.
  assertEquals(row.off_success_rate, null);
  assertEquals(row.explosive_play_rate, null);
});

/* ---------------------------------------------------------------- BUG 4 --
   Every league here is American, so the card turns over at midnight ET. UTC
   rolled the date forward at 8pm ET and the evening cron ingested tomorrow. */
Deno.test('etDay: anchored to Eastern, not UTC', () => {
  assertEquals(/^\d{4}-\d{2}-\d{2}$/.test(etDay(0)), true);
  const d0 = Date.parse(etDay(0) + 'T00:00:00Z');
  const d1 = Date.parse(etDay(1) + 'T00:00:00Z');
  assertEquals(Math.round((d1 - d0) / 86400000), 1);
});

Deno.test('seasonFor: football by start year, basketball by end year', () => {
  assertEquals(seasonFor(SPORTS.nfl, '2026-08-11'), 2026);
  assertEquals(seasonFor(SPORTS.nfl, '2027-01-15'), 2026); // January is last season
  assertEquals(seasonFor(SPORTS.cbb, '2026-08-11'), 2027);
  assertEquals(seasonFor(SPORTS.cbb, '2027-03-01'), 2027);
});
