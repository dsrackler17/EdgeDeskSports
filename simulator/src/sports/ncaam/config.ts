/* ===========================================================================
   NCAAM tournament facts, by season, with their verification status.

   A fact counts as verified only with verification VERIFIED, a named
   verifier and a date (registry.ts isVerified), exactly like the NFL's.
   An UNVERIFIED fact that affects results BLOCKS publication.

   What the simulator needs, and where it comes from:
   - THE OFFICIAL FIELD AND BRACKET (post-Selection Sunday mode): entrants,
     regions, seeds, every slot and its fixed path. It is OBSERVED data,
     supplied as a bracket file (basketball/ncaam_forecast/config/
     brackets/<season>.json) and validated by bracket.ts; nothing here
     invents a pairing, venue or date. For past seasons the bracket is
     reconstructed exactly from the observed games (inputs.ts).
   - THE FORMAT: field size, play-in games, Final Four pairing of regions,
     no reseeding. 2010 (65 teams, one opening-round game) and 2011-2026
     (68 teams, First Four) are OBSERVED in the game data (structural rounds,
     basketball/ncaam_forecast/quality.js). The 2027 format has NOT been
     verified from the NCAA's official source in this build (ncaa.com and
     ncaa.org are unreachable from the build environment, and expansion of
     the field has been under discussion): it blocks 2027 publication until a
     person records its verification.
   - PRE-SELECTION FORECASTS (before the field is announced) need a
     selection-and-seeding proxy. None exists in the repository (no committee
     ranking data, no NET, no seed-list history before 2023) and none is
     invented: pre-selection national-title forecasts are DISABLED.
   - CONFERENCE TOURNAMENTS: the slot engine plays any observed conference
     bracket. Simulating one BEFORE its bracket is set needs each conference's
     2026-27 format, seeding tiebreakers and site rules, none of which is in
     the repository: BLOCKED, per conference, until a verified format table
     exists.
   =========================================================================== */

export interface Fact<T> { value: T; verification: 'VERIFIED' | 'UNVERIFIED' | 'OBSERVED'; affects_results: boolean; verify_by: string; verified_by: string | null; verified_at: string | null; source: string }

export interface NcaaFormat { field_size: number; play_in_games: number; regions: number; reseeding: false; final_four_region_pairs: 'from the official bracket' }

export const NCAAM_2027 = {
  season: 2027,
  label: '2026-27',
  competition: 'NCAA Tournament',
  rules_version: 'NCAAM-BRACKET-SLOTS-v1',
  format: {
    value: { field_size: 68, play_in_games: 4, regions: 4, reseeding: false, final_four_region_pairs: 'from the official bracket' },
    verification: 'UNVERIFIED', affects_results: true,
    verify_by: 'the NCAA\'s official 2027 Division I men\'s basketball championship handbook / bracket announcement (ncaa.org, ncaa.com): field size, number of play-in games, region count',
    verified_by: null, verified_at: null,
    source: 'carried from the 2011-2026 observed format; NOT verified for 2027'
  } as Fact<NcaaFormat>,
  official_bracket: {
    value: { file: 'basketball/ncaam_forecast/config/brackets/2027.json' },
    verification: 'UNVERIFIED', affects_results: true,
    verify_by: 'the official bracket released on Selection Sunday 2027 (entrants, seeds, regions, every pairing and path)',
    verified_by: null, verified_at: null,
    source: 'not yet announced (expected mid-March 2027)'
  } as Fact<{ file: string }>,
  pre_selection: { enabled: false, reason: 'No defensible selection/seeding proxy exists in the repository (no committee-ranking, NET or historical seed-list data before 2023); a guessed field would be presented as a forecast of the official one.' },
  conference_tournaments: { enabled: false, reason: 'No verified 2026-27 conference tournament formats, seeding tiebreakers or site rules are in the repository; an observed conference bracket can be simulated once supplied as a bracket file.' },
  /* within-tournament assumptions, labelled in the reader */
  venue: 'neutral (every NCAA tournament game is at a neutral site; proximity to a team\'s campus is not modelled)',
  drift: { mode: 'off' as const },
  availability: { mode: 'off' as const, reason: 'no owned player-availability feed or return distribution for college basketball' }
};

/** the formats observed in the data, for the historical backtest */
export function observedFormat(season: number): { field_size: number; play_in_games: number } | null {
  if (season === 2020) return null;   // cancelled
  if (season === 2010) return { field_size: 65, play_in_games: 1 };
  if (season >= 2011 && season <= 2026) return { field_size: 68, play_in_games: 4 };
  return null;
}
