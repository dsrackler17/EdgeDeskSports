/* ============================================================================
   WHO ACTUALLY PUBLISHES AN AVAILABILITY REPORT, AND FOR WHICH GAMES.

   WHY THIS FILE EXISTS. Every part of this repository that touched college
   availability said the same sentence — "college football has no universal
   injury report" — and drew from it a conclusion that stopped being true in
   2025. It has no LEAGUE-WIDE report. It now has CONFERENCE reports, and they
   are not the same thing in three ways that matter:

     SCOPE       every published policy covers CONFERENCE games only. A Power
                 Four team hosting an FCS opponent files nothing, and no
                 amount of retrying will produce a report that was never
                 required. That is a different state from a source refusing.
     VOCABULARY  the Big Ten files probable / questionable / doubtful / out /
                 out (first half). Conference USA and the Mountain West file
                 only OUT and QUESTIONABLE. A player absent from a Big Ten
                 report is reported available; a player absent from a CUSA
                 report is merely not out. Reading both as "healthy" is the
                 error this file exists to stop.
     CADENCE     three days out and daily (SEC, Big 12), two nights out (ACC),
                 four filings a week (Big Ten), two days out (Mountain West).
                 A report that is not due yet is not a report that is missing.

   SCOPE HAS ONE EXCEPTION. The Mid-American Conference requires its schools to
  file for EVERY game they play, conference or not (applies_to ALL_GAMES), and
  its non-conference filings cover the MAC school's side only.

  AND NOT EVERY CONFERENCE HAS ONE. Where no policy could be verified the
   entry says UNVERIFIED and carries no URL. That is deliberately NOT the same
   record as "this conference publishes nothing": one is a gap in EdgeDesk's
   research and the other is a fact about the conference, and collapsing them
   is how an empty read becomes a clean bill of health.

   EVERY URL AND EVERY RULE HERE CARRIES ITS SOURCE. Nothing in this file was
   inferred from a conference's name or from what a sibling conference does.

   Node and browser (UMD).
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  root.EDAvailabilityPolicy = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var SCHEMA = 'edgedesk_cfb_availability_policy_v1';

  /* Verified 2026-09-15 from the conferences' own published policies and from
     the wire reports announcing them. `verified_at` is when EdgeDesk last
     checked the policy itself, NOT when a report was last read. */
  var VERIFIED_AT = '2026-09-15';

  var CONFERENCES = [
    {
      id: 'sec', name: 'Southeastern Conference', aliases: ['SEC'],
      state: 'PUBLISHED',
      report_url: 'https://www.secsports.com/fbreports',
      archive_url: 'https://www.secsports.com/fbreports-archive',
      /* the page embeds HD Intelligence's public report; the table is read
         from there (football/availability/hdi.js) */
      platform: 'hdintelligence', platform_code: 'SEC',
      policy_url: 'https://www.secsports.com/availability-reporting-policy',
      applies_to: 'CONFERENCE_GAMES',
      comprehensive: true,
      statuses: ['AVAILABLE', 'PROBABLE', 'QUESTIONABLE', 'DOUBTFUL', 'OUT'],
      first_filing_hours_before_kickoff: 72,
      final_filing_minutes_before_kickoff: 90,
      cadence: 'filed three days before a conference game and updated daily until 90 minutes before kickoff',
      source: 'https://www.secsports.com/availability-reporting-policy',
      verified_at: VERIFIED_AT
    },
    {
      id: 'bigten', name: 'Big Ten Conference', aliases: ['Big Ten', 'B1G'],
      state: 'PUBLISHED',
      report_url: 'https://bigten.org/fb/availability-reports/',
      archive_url: null,
      policy_url: 'https://bigten.org/fb/article/60284/',
      platform: 'hdintelligence', platform_code: 'B10',
      applies_to: 'CONFERENCE_GAMES',
      comprehensive: true,
      /* OUT_FIRST_HALF is new for 2026 and is NOT "out": it is a player who
         is unavailable for two quarters and available after them. Flattening
         it to OUT would over-price the absence; flattening it to available
         would under-price it. It is carried as its own designation. */
      /* game day swaps the midweek set for GAME-TIME DECISION, OUT and OUT
         (1ST HALF) */
      statuses: ['AVAILABLE', 'PROBABLE', 'QUESTIONABLE', 'DOUBTFUL', 'OUT', 'OUT_FIRST_HALF', 'GAME_TIME_DECISION'],
      first_filing_hours_before_kickoff: 72,
      final_filing_minutes_before_kickoff: 120,
      cadence: 'four filings a week for conference games — three days, two days and the night before at 8pm ET, '
        + 'then two hours before kickoff',
      /* The 2026 policy's own start date. A week-2 Big Ten game has no report
         because none was required, which the contract must say rather than
         reporting a failed read. */
      effective_from: '2026-09-19',
      source: 'https://bigten.org/fb/article/60284/',
      verified_at: VERIFIED_AT
    },
    {
      id: 'acc', name: 'Atlantic Coast Conference', aliases: ['ACC'],
      state: 'PUBLISHED',
      report_url: 'https://theacc.com/sports/2025/8/28/availability-reporting-football.aspx',
      archive_url: 'https://theacc.com/sports/2025/8/28/availability-reporting-football-archive.aspx',
      platform: 'hdintelligence', platform_code: 'ACC',
      policy_url: 'https://theacc.com/sports/2025/8/28/availability-reporting.aspx',
      applies_to: 'CONFERENCE_GAMES',
      comprehensive: true,
      /* the ACC's own policy page lists five pre-game-day statuses:
         available, probable, questionable, doubtful, out */
      statuses: ['AVAILABLE', 'PROBABLE', 'QUESTIONABLE', 'DOUBTFUL', 'OUT'],
      first_filing_hours_before_kickoff: 48,
      final_filing_minutes_before_kickoff: 120,
      cadence: 'filed two nights before a conference game, again the night before, and two hours before kickoff',
      source: 'https://theacc.com/sports/2025/8/28/availability-reporting.aspx',
      verified_at: VERIFIED_AT
    },
    {
      id: 'big12', name: 'Big 12 Conference', aliases: ['Big 12', 'Big XII'],
      state: 'PUBLISHED',
      /* no conference page was found that embeds the report; the platform's
         own public view is the page a reader can open */
      report_url: 'https://app.hdintelligence.com/?source=B12&sport=Football&conf=B12&type=report',
      archive_url: null,
      policy_url: 'https://big12sports.com/documents/2025/8/19/2025_Big_12_Conference_Player_Availability_Reporting_Policy.pdf',
      platform: 'hdintelligence', platform_code: 'B12',
      applies_to: 'CONFERENCE_GAMES',
      comprehensive: true,
      statuses: ['AVAILABLE', 'PROBABLE', 'QUESTIONABLE', 'DOUBTFUL', 'OUT'],
      first_filing_hours_before_kickoff: 72,
      final_filing_minutes_before_kickoff: 90,
      cadence: 'filed daily from three days before a conference game, with a final report 90 minutes before kickoff',
      source: 'https://big12sports.com/news/2025/8/13/general-big-12-conference-to-begin-player-availability-reporting-for-football-womens-and-mens-basketball.aspx',
      verified_at: VERIFIED_AT
    },
    {
      id: 'mountainwest', name: 'Mountain West Conference', aliases: ['Mountain West', 'MW', 'MWC'],
      state: 'PUBLISHED',
      report_url: 'https://themw.com/sports/2026/8/21/football_reports.aspx',
      archive_url: null,
      policy_url: 'https://themw.com/sports/2026/8/21/football_reports.aspx',
      applies_to: 'CONFERENCE_GAMES',
      /* NOT comprehensive in the Big Ten sense: only two designations are
         filed, so the report names who is out or doubtful and says nothing at
         all about everybody else. A player's absence from it is not a
         statement that he is available. */
      comprehensive: false,
      statuses: ['QUESTIONABLE', 'OUT'],
      first_filing_hours_before_kickoff: 48,
      final_filing_minutes_before_kickoff: 180,
      cadence: 'filed two days before a conference game with an update three hours before kickoff',
      source: 'https://themw.com/sports/2026/8/21/football_reports.aspx',
      verified_at: VERIFIED_AT
    },
    {
      id: 'conferenceusa', name: 'Conference USA', aliases: ['C-USA', 'CUSA'],
      state: 'PUBLISHED',
      report_url: 'https://conferenceusa.com/sports/2025/8/23/FB_0823254134.aspx',
      archive_url: null,
      policy_url: 'https://conferenceusa.com/sports/2025/8/23/FB_0823254134.aspx',
      applies_to: 'CONFERENCE_GAMES',
      comprehensive: false,
      statuses: ['QUESTIONABLE', 'OUT'],
      first_filing_hours_before_kickoff: null,
      final_filing_minutes_before_kickoff: null,
      cadence: 'filed under the conference availability policy; only OUT and QUESTIONABLE are designated',
      source: 'https://conferenceusa.com/sports/2025/8/23/FB_0823254134.aspx',
      verified_at: VERIFIED_AT
    },
    {
      id: 'sunbelt', name: 'Sun Belt Conference', aliases: ['Sun Belt'],
      state: 'PUBLISHED',
      report_url: 'https://sunbeltsports.org/news/2025/8/11/football-availability-report-new.aspx',
      archive_url: null,
      policy_url: 'https://sunbeltsports.org/news/2025/8/11/football-availability-report-new.aspx',
      applies_to: 'CONFERENCE_GAMES',
      /* The conference publishes a football availability report; EdgeDesk has
         not verified whether every designation or only absences are filed, so
         it is read as SELECTED until an ingested report settles it. Claiming
         comprehensiveness EdgeDesk has not checked is the error this file
         refuses. */
      comprehensive: false,
      statuses: [],
      first_filing_hours_before_kickoff: null,
      final_filing_minutes_before_kickoff: null,
      cadence: 'a weekly football availability report is published; the filing schedule has not been verified',
      source: 'https://sunbeltsports.org/news/2025/8/11/football-availability-report-new.aspx',
      verified_at: VERIFIED_AT
    },
    {
      id: 'american', name: 'American Athletic Conference', aliases: ['American', 'AAC', 'The American', 'American Conference'],
      state: 'PUBLISHED',
      report_url: 'https://theamerican.org/sports/2026/8/6/football_player_availability.aspx',
      archive_url: 'https://theamerican.org/sports/2026/9/3/football_player_availability_archive.aspx',
      /* the page (linked as "Availability Reports" from the conference's
         football navigation) embeds HD Intelligence's public report under
         the code "American"; football/availability/probe_sources.js read it
         from the page on 2026-09-25 */
      platform: 'hdintelligence', platform_code: 'American',
      policy_url: 'https://theamerican.org/sports/2026/8/6/football_player_availability.aspx',
      /* the week's table and the season's archive carry conference games
         only (Army-Temple, Navy-UAB; Army-USF, Navy-FAU) */
      applies_to: 'CONFERENCE_GAMES',
      /* COMPREHENSIVE, AS FILED: the Army-Temple game-day listing
         (2026-09-25) designates every player on both rosters — Army 166
         available, 14 exempt, 7 questionable, 4 out; Temple 106 available,
         7 out, 3 questionable */
      comprehensive: true,
      statuses: ['AVAILABLE', 'QUESTIONABLE', 'OUT', 'OUT_FIRST_HALF'],
      /* ONE filing, on game day: the archive's only report day is "Game
         Day", and the listing is published two hours before kickoff (13:00
         CT for Army-Temple's 15:00 CT kickoff) */
      first_filing_hours_before_kickoff: 2,
      final_filing_minutes_before_kickoff: 120,
      cadence: 'a single game-day report for each conference game, published two hours before kickoff',
      source: 'https://theamerican.org/sports/2026/8/6/football_player_availability.aspx',
      verified_at: '2026-09-25'
    },
    {
      id: 'midamerican', name: 'Mid-American Conference', aliases: ['MAC', 'Mid-American'],
      state: 'PUBLISHED',
      /* linked exactly so, doubled extension and all, as "Student-Athlete
         Availability Reports" from the conference's football navigation; the
         single-".aspx" form answers HTTP 500 (probe, 2026-09-25) */
      report_url: 'https://getsomemaction.com/sports/2026/7/28/FB_0728265050.aspx.aspx',
      archive_url: 'https://getsomemaction.com/sports/2026/8/27/FB_0728265055.aspx.aspx',
      platform: 'hdintelligence', platform_code: 'MAC',
      policy_url: 'https://www.espn.com/college-football/story/_/id/40953213/mac-adopts-player-availability-report-football-games',
      /* EVERY GAME A MEMBER PLAYS, not only conference games. The 2026
         archive carries MAC schools' filings against Ohio State, Nebraska,
         Holy Cross, Colgate and thirty other non-conference opponents, and
         the week's table carries a one-team entry for each MAC school's
         non-conference game (Toledo v San Diego State, Western Michigan v
         Boise State, Central Michigan at Miami, ...). Only the MAC school's
         side is filed: the opponent is covered by its own conference's policy
         or not at all. */
      applies_to: 'ALL_GAMES',
      /* NOT CLAIMED. Every MAC listing on the table when this was checked was
         still "Report Pending", and the archive keeps designated players
         only, so EdgeDesk has not seen whether a MAC listing designates the
         whole roster. A listing is judged on its own when it is read: one
         that designates the roster is a comprehensive filing
         (reports.js fromListing). The conference is not assumed to be. */
      comprehensive: false,
      /* the conference's own declared order on its published table */
      statuses: ['AVAILABLE', 'QUESTIONABLE', 'OUT', 'OUT_FIRST_HALF'],
      /* ONE filing, on game day (the archive's only report day), published
         an hour before kickoff (the table's 11:00 ET entry for a noon ET
         kickoff, and so on through the day) */
      first_filing_hours_before_kickoff: 1,
      final_filing_minutes_before_kickoff: 60,
      cadence: 'a single game-day report for every game a MAC school plays, published an hour before kickoff',
      source: 'https://getsomemaction.com/sports/2026/7/28/FB_0728265050.aspx.aspx',
      verified_at: '2026-09-25'
    },
    {
      id: 'pac12', name: 'Pac-12 Conference', aliases: ['Pac-12', 'PAC-12', 'Pac 12'],
      state: 'PUBLISHED',
      report_url: 'https://pac-12.com/news/2026/9/11/2026-football-reports.aspx',
      /* NOT A PLATFORM: the page's own script renders this file (read by the
         probe, 2026-09-25) — games, each with an update time and the
         reported players of each side (football/availability/pac12.js) */
      platform: 'pac12-feed', platform_code: null,
      data_url: 'https://sbcautostorage.blob.core.windows.net/availability-reports/pac12-football/prod/report.json',
      archive_url: null,
      policy_url: 'https://pac-12.com/news/2026/9/11/2026-football-reports.aspx',
      /* The conference also reports a non-conference game "only when the
         opponent and opponent's conference participate". It does not say
         which opponents count, and on 2026-09-25 — the day before San Diego
         State at Toledo and Boise State at Western Michigan, whose
         conference files for every game — the feed carried no game at all.
         So no non-conference game is taken to require a Pac-12 report until
         one is seen in the feed. */
      applies_to: 'CONFERENCE_GAMES',
      /* SELECTED: the page lists reported players only, and prints "No
         reported players." for a team with none. A player's absence from it
         is not a statement that he is available. */
      comprehensive: false,
      /* No report had been filed when this was verified (conference play
         begins 2026-10-03), so the words the feed uses are not known yet. A
         word the reader does not map is quarantined, never guessed. */
      statuses: [],
      first_filing_hours_before_kickoff: 72,
      final_filing_minutes_before_kickoff: 120,
      cadence: 'filed three, two and one day before a conference game (each by 7 p.m. PT) and no later than two '
        + 'hours before kickoff',
      source: 'https://pac-12.com/news/2026/9/11/2026-football-reports.aspx',
      verified_at: '2026-09-25'
    },
    {
      id: 'independent', name: 'FBS Independents', aliases: ['Independent', 'FBS Independents', 'Independents'],
      state: 'NO_CONFERENCE_POLICY',
      report_url: null, archive_url: null, policy_url: null,
      applies_to: null, comprehensive: false, statuses: [],
      cadence: null,
      why: 'an independent has no conference to file with. Any availability report for one of these programmes comes '
        + 'from the school itself and is registered per school, never inherited from a conference.',
      verified_at: VERIFIED_AT
    }
  ];

  var BY_ID = {};
  var BY_ALIAS = {};
  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ''); }
  CONFERENCES.forEach(function (c) {
    BY_ID[c.id] = c;
    BY_ALIAS[norm(c.name)] = c;
    (c.aliases || []).forEach(function (a) { BY_ALIAS[norm(a)] = c; });
  });

  /* A conference name from any feed -> its policy, or null when EdgeDesk has
     never looked at that conference. null is not "no policy"; the caller must
     say UNREGISTERED rather than inventing one. */
  function forConference(name) {
    var k = norm(name);
    if (!k) return null;
    if (BY_ALIAS[k]) return BY_ALIAS[k];
    /* a feed spelling that contains the registered name, e.g. "Big 12
       Conference" vs "Big 12" — matched on the normalised prefix only, never
       on a loose substring that could pull "American" out of "Mid-American" */
    var keys = Object.keys(BY_ALIAS), i;
    for (i = 0; i < keys.length; i++) {
      if (keys[i].length >= 4 && (k === keys[i] || k.indexOf(keys[i]) === 0)) return BY_ALIAS[keys[i]];
    }
    return null;
  }

  /* WHAT THE POLICY SAYS ABOUT ONE GAME. This is the question the contract
     needs and the one nothing in this repository could previously answer:
     is an official availability report REQUIRED for this specific fixture,
     and if so, is it due yet?

     game: { home_conference, away_conference, is_conference_game, kickoff }
     side: 'home' | 'away'
     now:  ms                                                              */
  function forGame(game, side, now) {
    game = game || {};
    var confName = side === 'away' ? game.away_conference : game.home_conference;
    var pol = forConference(confName);
    var kickoff = game.kickoff ? Date.parse(game.kickoff) : NaN;
    var hoursOut = isFinite(kickoff) && isFinite(now) ? (kickoff - now) / 3600000 : null;
    if (!pol) {
      return { state: 'UNREGISTERED', conference: confName || null, required: false, due: null,
        why: confName
          ? 'EdgeDesk has not researched an availability-reporting policy for ' + confName
            + '; that is an open question, not a finding that none exists'
          : 'no conference is recorded for this side, so no conference policy can be looked up' };
    }
    if (pol.state !== 'PUBLISHED') {
      return { state: pol.state, conference: pol.name, policy: pol, required: false, due: null,
        why: pol.why || 'no published conference availability policy' };
    }
    var conferenceGame = game.is_conference_game === true
      || (game.home_conference && game.away_conference
        && norm(game.home_conference) === norm(game.away_conference));
    /* ALL_GAMES: the conference requires its members to file for every game
       they play (the MAC), so a non-conference fixture is covered on the
       member's side */
    if (pol.applies_to === 'CONFERENCE_GAMES' && !conferenceGame) {
      return { state: 'NOT_REQUIRED_FOR_THIS_GAME', conference: pol.name, policy: pol, required: false, due: null,
        why: pol.name + ' requires an availability report for CONFERENCE games only, and this is a non-conference '
          + 'fixture. No report was filed because none was required — which is not the same as a report '
          + 'EdgeDesk could not read, and is not evidence that anybody is healthy' };
    }
    if (pol.effective_from && isFinite(kickoff) && kickoff < Date.parse(pol.effective_from)) {
      return { state: 'BEFORE_POLICY_START', conference: pol.name, policy: pol, required: false, due: null,
        why: pol.name + '’s 2026 reporting begins ' + pol.effective_from + ', after this kickoff' };
    }
    var firstDue = pol.first_filing_hours_before_kickoff;
    var due = (firstDue == null || hoursOut == null) ? null : (hoursOut <= firstDue);
    return {
      state: due === false ? 'NOT_DUE_YET' : 'REQUIRED',
      conference: pol.name, policy: pol, required: true, due: due,
      hours_to_kickoff: hoursOut == null ? null : Math.round(hoursOut * 10) / 10,
      report_url: pol.report_url,
      comprehensive: !!pol.comprehensive,
      statuses: (pol.statuses || []).slice(),
      why: due === false
        ? pol.name + ' requires a report for this game but the first filing is not due until '
          + firstDue + ' hours before kickoff'
        : pol.name + ' requires an availability report for this game: ' + pol.cadence
    };
  }

  /* Whether a report from this conference, naming nobody for a team, is a
     statement that the team has no absences. Only a COMPREHENSIVE policy can
     say that; a conference that files only OUT and QUESTIONABLE has told you
     nothing about the rest of the roster. */
  function silenceMeansAvailable(pol) {
    return !!(pol && pol.state === 'PUBLISHED' && pol.comprehensive);
  }

  return {
    SCHEMA: SCHEMA, CONFERENCES: CONFERENCES, VERIFIED_AT: VERIFIED_AT,
    forConference: forConference, forGame: forGame,
    silenceMeansAvailable: silenceMeansAvailable, norm: norm,
    published: function () { return CONFERENCES.filter(function (c) { return c.state === 'PUBLISHED'; }); }
  };
});
