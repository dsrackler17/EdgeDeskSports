/* ===========================================================================
   COLLEGE FOOTBALL 2026 — the season configuration the simulator runs under.

   Membership is NOT stored here: who is FBS and which conference each team
   plays in this season come from the 2026 schedule feed itself
   (cfbfastR-data schedules, the source football/fbs/ derives the universe
   from), so realignment is read, not remembered. What is stored here is
   every RULE the feed cannot say, each with its source, the sha256 of the
   text that was read, and a verification status:

     VERIFIED    the governing body's own current text was read (URL + sha256)
                 and applies to 2026, as the text states or as the current
                 official page with no later version found
     PRIOR_SEASON  the governing body's text, but published for an earlier
                 season; 2026 not confirmed
     SECONDARY   only secondary reports (press, the conference's member
                 schools' sites, explainers) were readable
     UNKNOWN     no procedure was found; a PROVISIONAL procedure is used and
                 labelled

   Sources were read on 2026-10-23 from GitHub's runners by
   .github/workflows/simulator-cfb-sources.yml (PR #698 runs 39949842833,
   39951782798, 39952191342), or directly where the build environment could
   reach them (two S3-hosted PDFs). CFB_SIMULATOR_NOTES.md §4 quotes them.

   A rule that changes a result and is not VERIFIED blocks publication of
   the outputs it affects (simulator/src/sports/registry.ts, validate.ts).
   =========================================================================== */

export type CfbVerification = 'VERIFIED' | 'PRIOR_SEASON' | 'SECONDARY' | 'UNKNOWN';
export interface CfbSource { url: string; kind: 'primary' | 'secondary'; text_sha256: string | null; read: string }
export interface CfbFact {
  label: string;
  verification: CfbVerification;
  affects_results: boolean;
  sources: CfbSource[];
  verified_by: string | null;
  verified_at: string | null;
  note: string;
}
const RUNNER = 'GitHub runner, simulator-cfb-sources.yml';
const READ = (how: string) => how + ', 2026-10-23';
const VERIFIER = 'Claude Code session 01Hi9WCadY5Nig7NkZLNdNSx (primary text read and quoted in CFB_SIMULATOR_NOTES.md §4; to be confirmed in review)';

export interface ConferenceRule {
  /** the feed's conference label */
  conference: string;
  procedure: string;              // rules.ts PROCEDURES id
  /** where the championship game is played */
  ccg_site: 'neutral' | 'home_of_seed_1';
  ccg_date: string;               // YYYY-MM-DD
  /** games whose result does not count for title-game qualification (by rule) */
  excluded_from_qualification: string;
  fact: CfbFact;
}

const CFP_PROTOCOL: CfbSource = { url: 'https://collegefootballplayoff.com/sports/2016/10/24/selection-committee-protocol', kind: 'primary', text_sha256: '7e6567edada865b8f40b1e0d098b1f425db33bedc2e631568ff2c8c925792075', read: READ(RUNNER) };
const CFP_RELEASE: CfbSource = { url: 'https://collegefootballplayoff.com/news/2026/8/6/sc-aug-2627', kind: 'primary', text_sha256: '6027a9340161bb522f63bc2e8f440a7246754ef1901b44c4f10b7e2eb16ebf36', read: READ(RUNNER) };
const CFP_FORMAT: CfbSource = { url: 'https://collegefootballplayoff.com/sports/2024/5/29/12-team-format', kind: 'primary', text_sha256: '7a515444ae1e58fd1ce91fe938694c571faea1a339dc0749c47b740f04c17413', read: READ(RUNNER) };

export const CFB_2026 = {
  season: 2026,
  sport: 'cfb' as const,
  competition: 'NCAA FBS',
  /** the Selection Day the committee's final ranking is released on: later games are not considered (CFP protocol, "Games Played After Selection Day") */
  selection_day: '2026-12-06',
  cfp: {
    rules: 'CFP-2026' as const,
    fact: {
      label: '2026 CFP format, selection and seeding',
      verification: 'VERIFIED' as CfbVerification, affects_results: true,
      sources: [CFP_PROTOCOL, CFP_RELEASE, CFP_FORMAT],
      verified_by: VERIFIER, verified_at: '2026-10-23',
      note: '12 teams: the ACC, Big Ten, Big 12 and SEC champions; the highest-ranked team from the American, Conference USA, MAC, Mountain West, Pac-12 or Sun Belt; Notre Dame if ranked in the top 12 of the final rankings; the next highest-ranked teams. The four highest-ranked teams are seeds 1-4 with byes; an automatic qualifier ranked outside the top 12 is seeded at the bottom in rank order. 5v12, 6v11, 7v10, 8v9 at the higher seed; quarterfinals 1 v 8/9, 2 v 7/10, 3 v 6/11, 4 v 5/12; semifinals (1) v (4) and (2) v (3) paths; no reseeding. Final rankings on Selection Day, Sunday 2026-12-06; games after it are not considered. First round Dec 18-19 on campus; quarterfinals Dec 30 - Jan 1 (Fiesta, Cotton, Peach, Rose); semifinals Jan 14-15 (Orange, Sugar); national championship Jan 25, 2027, Allegiant Stadium, Las Vegas.'
    }
  },
  conferences: [
    { conference: 'ACC', procedure: 'ACC-2026', ccg_site: 'neutral', ccg_date: '2026-12-05', excluded_from_qualification: 'none',
      fact: { label: 'ACC 2026 championship-game tiebreaker', verification: 'VERIFIED', affects_results: true, verified_by: VERIFIER, verified_at: '2026-10-23',
        sources: [{ url: 'https://s3.amazonaws.com/sidearm.sites/acc.sidearmsports.com/documents/2026/7/15/ACC_Football_Tiebreaker_Policy_Jully_2026.pdf', kind: 'primary', text_sha256: null, read: READ('build environment (file sha256 c5b49646b63487a635370f869e838bcd4c218b5ffc0cf60e4bc15b98db69081b)') },
          { url: 'https://theacc.com/news/2026/7/15/acc-announces-new-football-championship-tiebreaker-policy.aspx', kind: 'primary', text_sha256: '66c26691518bc372fdd14c42ad55c5d6b1c0bcff4a17958b55847cdacd7045c0', read: READ(RUNNER) }],
        note: 'ACC Football Tiebreaker Policy as amended July 1, 2026: the Top Two Teams by conference win percentage, a team with an alternate number of conference games tied when it has the same wins or the same losses; must be postseason-eligible; two teams: head-to-head, SportSource Analytics Team Success Ranking, draw; three or more: record among the tied teams if all are common opponents, else beat-each (placed) / lost-to-each (removed), then the Team Success Ranking, then a draw. Five members (Boston College, Clemson, Florida State, Georgia Tech, North Carolina) play eight conference games in 2026, the other twelve nine.' } },
    { conference: 'Big 12', procedure: 'B12-2024', ccg_site: 'neutral', ccg_date: '2026-12-05', excluded_from_qualification: 'none',
      fact: { label: 'Big 12 championship-game tiebreaker', verification: 'VERIFIED', affects_results: true, verified_by: VERIFIER, verified_at: '2026-10-23',
        sources: [{ url: 'https://s3.amazonaws.com/big12sports.com/documents/2025/11/4/Big_12_Football_2024_Tiebreaker_Policy.pdf', kind: 'primary', text_sha256: null, read: READ('build environment and ' + RUNNER + ' (file sha256 b1eb5c7383f89a986a0472e4be7c21a819b2ade96eb1ed7e254ad7a25ef52f35)') }],
        note: '"Beginning with the 2024 football season with 16 teams": the two best conference win percentages; two teams: head-to-head, common conference opponents, next highest placed common opponent (tied groups taken collectively), combined conference win percentage of conference opponents, total wins in a 12-game season (one FCS win), SportSource Analytics Team Rating Score, coin toss; three or more: record among the tied teams (or a team that beat all others), then the same. No later version was found; the document is hosted on the conference\'s current site (posted 2025-11-04).' } },
    { conference: 'Mid-American', procedure: 'MAC-2025', ccg_site: 'neutral', ccg_date: '2026-12-05', excluded_from_qualification: 'none',
      fact: { label: 'MAC championship-game tiebreaker', verification: 'VERIFIED', affects_results: true, verified_by: VERIFIER, verified_at: '2026-10-23',
        sources: [{ url: 'https://getsomemaction.com/sports/2025/11/12/FB_1112255434.aspx', kind: 'primary', text_sha256: '3be1bdb7c3ade252961f25290b2d45927bfbe4050530863f2c3f488400e1eac3', read: READ(RUNNER) }],
        note: 'Current official page (published 2025-11-12, no season limit stated): conference winning percentage; two teams: head-to-head, all common opponents, SportSource Analytics Team Rating Score, common opponents by order of finish, combined conference win percentage of conference opponents, draw; three or more: combined head-to-head if all are common opponents, else a team that beat each of the others, then the same. "All common opponents" is applied to conference opponents (a stated simplification).' } },
    { conference: 'Sun Belt', procedure: 'SBC-DIV', ccg_site: 'home_of_seed_1', ccg_date: '2026-12-05', excluded_from_qualification: 'none',
      fact: { label: 'Sun Belt division tiebreakers and title-game host', verification: 'VERIFIED', affects_results: true, verified_by: VERIFIER, verified_at: '2026-10-23',
        sources: [{ url: 'https://sunbeltsports.org/sports/2018/8/30/FB_Tie-Breakers.aspx', kind: 'primary', text_sha256: '92233e962c8854d271ba44a2a81eeb83cb60f0bd828efec0783f1e5100d5a4ad', read: READ(RUNNER) }],
        note: 'Current official page: East and West division champions by conference win percentage; division tiebreakers head-to-head, divisional win percentage, next highest in the division, common non-divisional opponents, CFP ranking / computer composite, win percentage against FBS teams, coin toss; an ineligible champion yields to the next team; the champion with the better conference win percentage hosts. Divisions: the 2026 schedule\'s unique round-robin partition (East: App State, Coastal Carolina, Georgia Southern, Georgia State, James Madison, Marshall, Old Dominion; the official page\'s East list reads the same six it shows before truncation).' } },
    { conference: 'SEC', procedure: 'SEC-2024', ccg_site: 'neutral', ccg_date: '2026-12-05', excluded_from_qualification: 'none',
      fact: { label: 'SEC championship-game tiebreaker', verification: 'SECONDARY', affects_results: true, verified_by: null, verified_at: null,
        sources: [{ url: 'https://www.secsports.com/news/2024/08/sec-announces-football-tie-breaking-process', kind: 'primary', text_sha256: 'afd331baef2404275a195e24842dc747e513d0ca92ca17d801b6c836073860de', read: READ(RUNNER + ': only the headline is server-rendered') },
          { url: 'https://www.cbssports.com/college-football/news/sec-football-tiebreakers-heres-how-the-conference-will-circumvent-identical-records-in-divisionless-format/', kind: 'secondary', text_sha256: null, read: READ('search result summaries (ESPN, CBS, On3)') }],
        note: '2024 procedure as reported: head-to-head, record against common conference opponents, record against the highest placed common opponent, cumulative conference win percentage of conference opponents, capped relative total scoring margin (offense capped at 42, defense at 48), random draw. Not verified for 2026 (the SEC moved to nine conference games in 2026; no 2026 text was readable).' } },
    { conference: 'Big Ten', procedure: 'B1G-2024', ccg_site: 'neutral', ccg_date: '2026-12-05', excluded_from_qualification: 'none',
      fact: { label: 'Big Ten championship-game tiebreaker', verification: 'SECONDARY', affects_results: true, verified_by: null, verified_at: null,
        sources: [{ url: 'https://nextgen.bigten.org/api/media/file/f142aa7f-aa37-430b-bf09-8988a6952c0c-2024_Big_Ten_Football_Tiebreaker_-_FINAL_10__72_.pdf', kind: 'primary', text_sha256: null, read: READ(RUNNER + ': HTTP 402, not readable') },
          { url: 'https://www.espn.com/college-football/story/_/id/41003007/big-ten-reveals-football-tiebreakers-18-team-conference', kind: 'secondary', text_sha256: null, read: READ('search result summaries') }],
        note: '2024 procedure as reported: head-to-head, common conference opponents, highest placed common opponent, cumulative conference win percentage of opponents, SportSource Analytics Team Rating Score, random draw. Not verified for 2026.' } },
    { conference: 'American Athletic', procedure: 'AAC-2025', ccg_site: 'home_of_seed_1', ccg_date: '2026-12-05', excluded_from_qualification: 'Army-Navy (played after the championship game)',
      fact: { label: 'American championship-game tiebreaker', verification: 'PRIOR_SEASON', affects_results: true, verified_by: null, verified_at: null,
        sources: [{ url: 'https://theamerican.org/news/2025/11/23/FOOTBALL_Tiebreaker.aspx', kind: 'primary', text_sha256: '354bb73e773cffdd2966ca967c6fb2719c28c8a684ffc0b322566b82298a5c4c', read: READ(RUNNER) },
          { url: 'https://theamerican.org/documents/2025/10/29/25_FB_Tiebreakers.pdf', kind: 'primary', text_sha256: null, read: READ(RUNNER + ': not a readable PDF') }],
        note: '2025 official scenarios page: head-to-head where available; then the highest-ranked team in the CFP rankings advances if it wins its final game; otherwise a composite of computer metrics (SP+, SportSource SOR, ESPN SOR, KPI); the No. 1 seed hosts. No 2026 document was found.' } },
    { conference: 'Mountain West', procedure: 'MW-2024', ccg_site: 'home_of_seed_1', ccg_date: '2026-12-04', excluded_from_qualification: 'none',
      fact: { label: 'Mountain West championship-game tiebreaker', verification: 'SECONDARY', affects_results: true, verified_by: null, verified_at: null,
        sources: [{ url: 'https://www.profootballnetwork.com/cfb/mountain-west-tiebreakers-everything-to-know/', kind: 'secondary', text_sha256: null, read: READ(RUNNER + ': HTTP 403; search result summaries') }],
        note: 'As reported: head-to-head, then the CFP ranking or a composite of computer metrics (SP+, ESPN SOR, KPI, SportSource), then overall win percentage; the higher seed hosts (Boise State hosted in 2024 and 2025 per the feed). No official text was found.' } },
    { conference: 'Conference USA', procedure: 'PROVISIONAL', ccg_site: 'home_of_seed_1', ccg_date: '2026-12-04', excluded_from_qualification: 'none',
      fact: { label: 'Conference USA championship-game tiebreaker', verification: 'UNKNOWN', affects_results: true, verified_by: null, verified_at: null,
        sources: [{ url: 'https://conferenceusa.com/news/2026/4/29/fb-cusa-releases-revised-2026-football-schedule.aspx', kind: 'primary', text_sha256: '29ea92ee685893bd5415ab9396275fefb78958216a5fbdfa4554a51b2670ecd6', read: READ(RUNNER) }],
        note: 'Official: the top two finishers in conference play meet Friday, Dec. 4 (10 teams). No tiebreaker procedure was found; the PROVISIONAL procedure (head-to-head, common opponents, Estimated ranking surrogate, draw) is used and every tie it decides is counted. Host by higher seed (the 2024-2025 feed shows the top team hosting).' } },
    { conference: 'Pac-12', procedure: 'PROVISIONAL', ccg_site: 'home_of_seed_1', ccg_date: '2026-12-04', excluded_from_qualification: 'Week 13 flex games (non-conference by rule)',
      fact: { label: 'Pac-12 championship-game tiebreaker', verification: 'UNKNOWN', affects_results: true, verified_by: null, verified_at: null,
        sources: [{ url: 'https://gobulldogs.com/news/2026/2/11/football-pac-12-announces-2026-football-schedule', kind: 'secondary', text_sha256: 'd6b1a8a394d72e76334dabebd6d90196f75c8a240b4810b30a9e6bec30404d37', read: READ(RUNNER + ' (Fresno State athletics, a member school)') }],
        note: 'Eight members; the title game is hosted by the top team on Dec. 4 and set at the end of Week 12; the Week 13 flex games are non-conference and do not count in the standings (their opponents are not in the feed yet, so they are not simulated). No tiebreaker procedure was found: PROVISIONAL.' } }
  ] as ConferenceRule[],
  /** postseason eligibility the feed cannot say. Every other FBS team is eligible. */
  eligibility: ([
    { team: 'North Dakota State', ccg_eligible: true, cfp_eligible: true,
      fact: { label: 'North Dakota State postseason eligibility (FCS-to-FBS transition)', verification: 'SECONDARY', affects_results: true, verified_by: null, verified_at: null,
        sources: [{ url: 'https://www.ncaa.org/news/di-cabinet-remands-two-semester-mens-soccer-proposal-to-oversight-committee-for-further-review/', kind: 'primary', text_sha256: '367a859cc8b6556a78fdfb702150a8ac9e767b6a2c3cf84df6eaf33ab688c539', read: READ(RUNNER) },
          { url: 'https://www.kfyrtv.com/2026/06/24/north-dakota-state-football-earns-immediate-postseason-eligibility/', kind: 'secondary', text_sha256: '93c23e77a06a0000c625d4b2fbc1bca4d351f4ddc646473d5c3b9f8882ad828f', read: READ(RUNNER) },
          { url: 'https://nevadasportsnet.com/news/reporters/north-dakota-state-footballs-ability-to-play-for-2026-mw-title-to-be-voted-on-this-week', kind: 'secondary', text_sha256: '2c29a003bb3fd6e4570815ce708a061f204608b3fd9a01f99ceea6d867f4e5cf', read: READ(RUNNER) }],
        note: 'NCAA (primary): effective with the 2026 season, teams reclassifying from the FCS are eligible for postseason bowl games. Mountain West title-game eligibility: reported (KFYR) as following from it; the Nevada Sports Net report said the MW title was barred until 2028 unless the NCAA amended the transition penalty, which it did. No Mountain West statement was read.' } },
    { team: 'Sacramento State', ccg_eligible: false, cfp_eligible: true,
      fact: { label: 'Sacramento State MAC title-game eligibility', verification: 'SECONDARY', affects_results: true, verified_by: null, verified_at: null,
        sources: [{ url: 'https://wtop.com/ncaa-football/2026/02/sacramento-state-mens-football-to-join-fbs-mid-american-conference-in-july/', kind: 'secondary', text_sha256: null, read: READ('search result summaries (AP, Feb 2026); the page returned 404 to the runner') }],
        note: 'AP (Feb 2026): not eligible for the MAC championship in its first two seasons in the conference (a membership term, separate from the NCAA bowl rule). The school\'s student paper said otherwise; no MAC statement was read. The run counts how often the opposite assumption would have changed a MAC title-game berth.' } }
  ] as Array<{ team: string; ccg_eligible: boolean; cfp_eligible: boolean; fact: CfbFact }>),
  /** how many runs a rule that is not VERIFIED may decide before its conference's forecast is withheld */
  max_unverified_decided_fraction: 0,
  drift: { mode: 'off' as const },
  availability: {
    mode: 'config' as const,
    file: 'simulator/config/cfb_availability.json',
    rule: 'Only the engine\'s trained primary-quarterback absence (football/cfb_p4 params injury.position_weight.QB) moves a price, and only for a starter listed OUT in simulator/config/cfb_availability.json with a source; every other absence widens nothing and moves nothing (the engine\'s missing-input rule). No return dates are sampled. football/availability/current.json carried no report for any of the 138 teams at the as-of date.'
  }
};
export type CfbSeasonConfig = typeof CFB_2026;

/** every fact that can change a result, labelled */
export function cfbFacts(c: CfbSeasonConfig = CFB_2026): Array<[string, CfbFact]> {
  return ([['CFP', c.cfp.fact]] as Array<[string, CfbFact]>)
    .concat(c.conferences.map((r): [string, CfbFact] => [r.conference, r.fact]))
    .concat(c.eligibility.map((e): [string, CfbFact] => [e.team, e.fact]));
}
export const isCfbVerified = (f: CfbFact) => f.verification === 'VERIFIED' && !!f.verified_by && /^\d{4}-\d{2}-\d{2}$/.test(f.verified_at || '');
