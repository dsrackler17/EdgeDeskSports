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
  /** an assumption every run measures instead (the season is replayed under the opposite assumption, run.eligibility_sensitive):
      while unverified it blocks publication only in a run where it changed a title-game berth */
  measured?: boolean;
}
const RUNNER = 'GitHub runner, simulator-cfb-sources.yml';
const READ = (how: string) => how + ', 2026-10-23';
const VERIFIER = 'Claude Code session 01Hi9WCadY5Nig7NkZLNdNSx (primary text read and quoted in CFB_SIMULATOR_NOTES.md §4; to be confirmed in review)';
/** the facts verified at the repository owner's request (2026-10-23), from official text the source job printed */
const VERIFIER_RUN = (run: string) => 'Claude Code session 01Hi9WCadY5Nig7NkZLNdNSx, at the repository owner\'s request (2026-10-23), from the official text fetched by GitHub Actions run ' + run + ' (Simulator CFB source check); quoted in CFB_SIMULATOR_NOTES.md §4';

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
      fact: { label: 'SEC championship-game tiebreaker', verification: 'VERIFIED', affects_results: true, verified_by: VERIFIER_RUN('39982279610'), verified_at: '2026-10-23',
        sources: [{ url: 'https://www.secsports.com/news/2024/08/sec-announces-football-tie-breaking-process', kind: 'primary', text_sha256: '79c14ed118e4d10acc5aeef81ecd3d3cdb6227f3ea4408dc89d3f7f03ae04671', read: READ(RUNNER + ' (rendered DOM; the served HTML holds only the headline)') },
          { url: 'https://www.cbssports.com/college-football/news/sec-football-tiebreakers-heres-how-the-conference-will-circumvent-identical-records-in-divisionless-format/', kind: 'secondary', text_sha256: null, read: READ('search result summaries (ESPN, CBS, On3)') }],
        note: 'The SEC\'s own release (secsports.com, Aug. 21, 2024), its standing procedure for the divisionless conference: head-to-head among the tied teams, record versus all common conference opponents, record against the highest placed common conference opponent proceeding through the standings, cumulative conference winning percentage of all conference opponents, capped relative total scoring margin versus all conference opponents, random draw; an outright champion hosts; two tied for first both qualify and the two-team procedure sets home/away. The text names the 2024 game; no replacement has been published (the 2025 game was decided under it, and no change came with the nine-game schedule in 2026). Capped margin uses Estimated scores (a stated input).' } },
    { conference: 'Big Ten', procedure: 'B1G-2024', ccg_site: 'neutral', ccg_date: '2026-12-05', excluded_from_qualification: 'none',
      fact: { label: 'Big Ten championship-game tiebreaker', verification: 'VERIFIED', affects_results: true, verified_by: VERIFIER_RUN('39983837569'), verified_at: '2026-10-23',
        sources: [{ url: 'https://web.archive.org/web/20251118003222id_/https://bigten.org/fb/article/blt6104802d94ebe1ab/', kind: 'primary', text_sha256: null, read: READ(RUNNER + ' (the Big Ten\'s own release, "OFFICIAL TIEBREAKING PROCEDURES", Aug. 26, 2024, as archived by the Internet Archive; bigten.org now answers 404; archived page sha256 1cc9c342daa5e230442665bdac403dba3607dd388ab35dacf65e5638cbf67017)') },
          { url: 'https://web.archive.org/web/20251130010718id_/https://bigten.org/fb/article/58967/', kind: 'primary', text_sha256: null, read: READ(RUNNER + ' (the Big Ten\'s 2025 tiebreaker scenarios article, as archived; archived page sha256 b6e764b60555a591124c9c123a9d71d3a53f0598fe880b4f07559bdc98db3692)') },
          { url: 'https://bigten.org/news/2026/8/19/championship-2026-discover-big-ten-football-championship-game-information.aspx', kind: 'primary', text_sha256: null, read: READ(RUNNER + ' (2026 game page: the two best conference records, "tiebreakers will be applied, if necessary")') },
          { url: 'https://nextgen.bigten.org/api/media/file/f142aa7f-aa37-430b-bf09-8988a6952c0c-2024_Big_Ten_Football_Tiebreaker_-_FINAL_10__72_.pdf', kind: 'primary', text_sha256: null, read: READ(RUNNER + ': HTTP 402 to automated readers, and not in the Internet Archive') }],
        note: 'The Big Ten\'s own release (Aug. 26, 2024; read from the Internet Archive\'s copy of bigten.org, which no longer serves it): two teams tied in the conference standings: head-to-head, record against all common conference opponents, record against common opponents with the best conference record proceeding through the order of finish, best cumulative conference winning percentage of all conference opponents, highest SportSource Analytics Team Rating Score after the regular season, random draw. Three or more: the full PDF refuses automated readers and is not archived; the Big Ten\'s own 2025 scenarios article applies head-to-head among the tied teams (skipped when they did not all meet), common opponents, order of finish and opponents\' winning percentage, and a team removed reverts the rest to the two-team procedure, which is what B1G-2024 codes. Its standing procedure for the divisionless conference: the 2026 game page says only that tiebreakers will be applied, and no change has been published.' } },
    { conference: 'American Athletic', procedure: 'AAC-2026', ccg_site: 'home_of_seed_1', ccg_date: '2026-12-05', excluded_from_qualification: 'Army-Navy (played after the championship game)',
      fact: { label: 'American championship-game tiebreaker', verification: 'VERIFIED', affects_results: true, verified_by: VERIFIER_RUN('39982974654'), verified_at: '2026-10-23',
        sources: [{ url: 'https://theamerican.org/documents/2026/9/30/26_FB_Tiebreakers.pdf', kind: 'primary', text_sha256: '803b8343aad6dd045fccc67752812db1755a81efa68ef5676b878ee6cdbf0049', read: READ(RUNNER + ' (the document page embeds the file; file sha256 a9c5c71c52d710bf5d299e86e4ba31839ead3403f510952ce7b93dc217a30205)') },
          { url: 'https://theamerican.org/documents/2025/10/29/25_FB_Tiebreakers.pdf', kind: 'primary', text_sha256: 'f3741cdc168911d6b5db54d42360090142bf1e0ee833f3d0ad47f656e343778f', read: READ(RUNNER + ' (2025 version, compared line by line)') }],
        note: 'The American\'s 2026 Tiebreaker Policies (official PDF, posted 2026-09-30, Section 10; the 2025 text with the SportSource metric renamed and multi-team ties ranked): the two best conference winning percentages; host = the participant with the better conference percentage. Two teams: head-to-head; then CFP-ranked conditions (a ranked team that does not lose its final conference weekend; the higher-ranked of two that win) or a composite of computer metrics (Connelly SP+, SportSource TR116 Team Strength Ranking, ESPN SOR, KPI); common conference opponents; overall winning percentage excluding exempt games; coin toss. Three or more: a mini round robin when all met, else a team that beat all the others; the same ranking and composite conditions; common opponents; overall percentage; a drawing; two left use the two-team procedure.' } },
    { conference: 'Mountain West', procedure: 'MW-2026', ccg_site: 'home_of_seed_1', ccg_date: '2026-12-04', excluded_from_qualification: 'none',
      fact: { label: 'Mountain West championship-game tiebreaker', verification: 'VERIFIED', affects_results: true, verified_by: VERIFIER_RUN('39982974654'), verified_at: '2026-10-23',
        sources: [{ url: 'https://themw.com/documents/2026/10/12/MW_Football_Championship_Tiebreaking_Procedures.pdf', kind: 'primary', text_sha256: 'ac6f140e8715e8bcd2c355d2fc57102cfdef25ceb4a125a3093aa4c8577bd530', read: READ(RUNNER + ' (the document page embeds the file; file sha256 c43d7f855b82f9fe62a7916d22ef85b95d96cbd84c35a456d5dcaf330055a6cb)') },
          { url: 'https://themw.com/documents/2026/10/20/2026_MWFB_Weekly_Release_Week_8.pdf', kind: 'primary', text_sha256: '66fbf30028eb508f9ee97db49e1bb3f800d6902d1a6cdb8403bb2ae7c0cff53f', read: READ(RUNNER + ' (Dec. 4; the eligible team with the best percentage outright hosts)') }],
        note: 'Mountain West Football Championship Tiebreaking Procedures (official PDF, posted 2026-10-12, written for 2026): the two eligible teams with the best conference percentages; the eligible team best outright hosts. CFP-Ranked Team Tiebreaker Immunity first, once, for the original standings tie: the highest-ranked tied team in the CFP ranking of 2026-11-24 advances (and hosts if tied for first) if it wins its final regular-season game after that ranking. Two teams: head-to-head, CFP ranking among tied teams that won their final game else a composite of Connelly SP+, ESPN SOR, KPI and SportSource, overall winning percentage (at most one FCS win), record against the next highest-placed conference team or tied group, common conference opponents, coin toss. Three or more: a mini round robin (a team that beat all others advances, one that lost to all is eliminated, restart), the ranking/composite, overall percentage, next placed team, common opponents, a drawing. The immunity\'s CFP ranking is an Estimated stand-in (the surrogate\'s top 25 among FBS teams).' } },
    { conference: 'Conference USA', procedure: 'CUSA-2024', ccg_site: 'home_of_seed_1', ccg_date: '2026-12-04', excluded_from_qualification: 'none',
      fact: { label: 'Conference USA championship-game tiebreaker', verification: 'VERIFIED', affects_results: true, verified_by: VERIFIER_RUN('39982279610'), verified_at: '2026-10-23',
        sources: [{ url: 'https://conferenceusa.com/documents/2024/9/19/CUSA_FB_Championship_Game_Tiebreaker_Policy.pdf', kind: 'primary', text_sha256: '9c0a3601a049e4248e8d6816b4b15aab308d9cdbe782c8acde78794313fb15e0', read: READ(RUNNER + ' (the document page embeds the file; file sha256 452cb36aecf49bcfc84f300c954a5ef0e4a9904c074cef693b3350c6d49c41cd)') },
          { url: 'https://conferenceusa.com/news/2026/4/29/fb-cusa-releases-revised-2026-football-schedule.aspx', kind: 'primary', text_sha256: '29ea92ee685893bd5415ab9396275fefb78958216a5fbdfa4554a51b2670ecd6', read: READ(RUNNER) }],
        note: 'Conference USA Football Regulations (official PDF, posted 2024-09-19, no season limit; the 2026 schedule release confirms the top two by conference win percentage meet Dec. 4): head-to-head, win percentage against common conference opponents, record against the common opponent(s) with the best conference record proceeding downward (tied groups collectively), average of Connelly SP+, SportSource Analytics, ESPN SOR and KPI rankings, cumulative conference win percentage of conference opponents, coin toss; a broken multi-team tie restarts at step 1; the same criteria pick the host; a team not bowl-eligible does not compete. Three-or-more-team "head-to-head" is read as the record among the tied teams (a stated reading).' } },
    { conference: 'Pac-12', procedure: 'PAC12-2026', ccg_site: 'home_of_seed_1', ccg_date: '2026-12-04', excluded_from_qualification: 'Week 13 flex games (non-conference by rule)',
      fact: { label: 'Pac-12 championship-game tiebreaker', verification: 'VERIFIED', affects_results: true, verified_by: VERIFIER_RUN('39982279610'), verified_at: '2026-10-23',
        sources: [{ url: 'https://pac-12.com/news/2026/9/3/pac-12-announces-commercial-and-operational-updates-ahead-of-its-2026-football-season-kickoff.aspx', kind: 'primary', text_sha256: '4c126ecc4a07ea5ec166467104f3e951956c30efd906f23d65215fca3a07698d', read: READ(RUNNER + ' (rendered DOM)') },
          { url: 'https://gobulldogs.com/news/2026/2/11/football-pac-12-announces-2026-football-schedule', kind: 'secondary', text_sha256: 'd6b1a8a394d72e76334dabebd6d90196f75c8a240b4810b30a9e6bec30404d37', read: READ(RUNNER + ' (Fresno State athletics, a member school)') }],
        note: 'Official 2026 release ("football championship game tiebreaker language for 2026 finalized"): the top two eligible teams after a seven-game conference schedule (weeks 5-12; the Week 13 flex game does not count), hosted by the higher seed on Dec. 4. Two teams: head-to-head (tied for first: both play, the winner is No. 1), next-highest-placed common opponent proceeding through the standings (tied groups collectively), all common conference opponents, highest CFP ranking on the Tuesday before week 13, SportSource Analytics Team Rating Score, coin toss. Three or more: head-to-head among the tied teams if all met, all common conference opponents, next-highest-placed common opponent, combined conference win percentage of conference opponents, SportSource Team Rating Score, coin toss; once one team is seeded the rest restart, and two left use the two-team procedure.' } }
  ] as ConferenceRule[],
  /** postseason eligibility the feed cannot say. Every other FBS team is eligible. */
  eligibility: ([
    { team: 'North Dakota State', ccg_eligible: true, cfp_eligible: true,
      fact: { label: 'North Dakota State postseason eligibility (FCS-to-FBS transition)', verification: 'VERIFIED', affects_results: true, verified_by: VERIFIER_RUN('39982974654'), verified_at: '2026-10-23',
        sources: [{ url: 'https://www.ncaa.org/news/di-cabinet-remands-two-semester-mens-soccer-proposal-to-oversight-committee-for-further-review/', kind: 'primary', text_sha256: '367a859cc8b6556a78fdfb702150a8ac9e767b6a2c3cf84df6eaf33ab688c539', read: READ(RUNNER) },
          { url: 'https://themw.com/documents/2026/10/12/MW_Football_Championship_Tiebreaking_Procedures.pdf', kind: 'primary', text_sha256: 'ac6f140e8715e8bcd2c355d2fc57102cfdef25ceb4a125a3093aa4c8577bd530', read: READ(RUNNER) },
          { url: 'https://gobison.com/sports/2026/2/9/fbs-frequently-asked-questions', kind: 'primary', text_sha256: 'fa8efc88e4575701f2d5f758fac49955678feb0219373ff8657522b2cbe07d8b', read: READ(RUNNER + ' (rendered DOM; North Dakota State athletics, the member institution)') },
          { url: 'https://www.kfyrtv.com/2026/06/24/north-dakota-state-football-earns-immediate-postseason-eligibility/', kind: 'secondary', text_sha256: '93c23e77a06a0000c625d4b2fbc1bca4d351f4ddc646473d5c3b9f8882ad828f', read: READ(RUNNER) }],
        note: 'NCAA Division I Cabinet, June 24, 2026 (primary): effective with the 2026 season, teams reclassifying from the FCS are eligible for postseason bowl games. Mountain West 2026 championship procedures (primary): only a team ineligible under NCAA or Mountain West rules for postseason competition is removed. North Dakota State athletics (the member institution): "Thanks to an NCAA rule change in June 2026, the Bison are immediately eligible for the MW Football Championship Game, College Football Playoff and other bowl games." The February 2026 restriction (no MW title until 2028) was the NCAA transition period that the Cabinet removed.' } },
    { team: 'Sacramento State', ccg_eligible: true, cfp_eligible: true,
      fact: { label: 'Sacramento State MAC title-game eligibility', verification: 'SECONDARY', affects_results: true, measured: true, verified_by: null, verified_at: null,
        sources: [{ url: 'https://hornetsports.com/news/2026/2/16/hornet-football-to-join-the-mac-in-2026.aspx', kind: 'primary', text_sha256: '36e5b99afcd521697d8ce6d85df74659ff00e298e48027c04f1f68128881b43d', read: READ(RUNNER + ' (Sacramento State athletics, February 2026 FAQ)') },
          { url: 'https://www.ncaa.org/news/di-cabinet-remands-two-semester-mens-soccer-proposal-to-oversight-committee-for-further-review/', kind: 'primary', text_sha256: '367a859cc8b6556a78fdfb702150a8ac9e767b6a2c3cf84df6eaf33ab688c539', read: READ(RUNNER) },
          { url: 'https://getsomemaction.com/sports/2025/11/12/FB_1112255434.aspx', kind: 'primary', text_sha256: '3be1bdb7c3ade252961f25290b2d45927bfbe4050530863f2c3f488400e1eac3', read: READ(RUNNER + ' (no eligibility clause)') }],
        note: 'Sacramento State athletics (Feb. 2026): "The NCAA requires a two-year transition period for teams reclassifying from FCS to FBS. The restriction also makes the Hornets ineligible to compete in the MAC championship game for two years." The NCAA removed that restriction for bowls effective 2026 (June 24, 2026), and North Dakota State, in the same position, is now eligible for its title game. No MAC statement on Sacramento State was found, and the MAC procedure has no eligibility clause. Assumed eligible; MEASURED: every run is replayed with Sacramento State ineligible, and publication is held for any run whose MAC title-game pair would differ (0 of 100,000 at week 7: Sacramento State is 0-4 in the MAC).' } },
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
