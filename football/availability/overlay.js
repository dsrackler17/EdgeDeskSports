/* ============================================================================
   THE AVAILABILITY LAYER AS EVERY READER SHOULD SEE IT — three sources, one
   view, applied at READ time so it is applied once.

   WHAT IT MERGES, in tier order, highest first:

     1  an INGESTED OFFICIAL REPORT (football/availability/reports/*.json), the
        conference filing the policy registry says exists for this fixture
     2  an OPERATOR CORRECTION (football/availability/operator.json), dated,
        sourced and expiring
     3  the AUTOMATED READ (football/availability/current.json), whatever the
        collectors recovered

   WHY AT READ TIME. The automated sync runs on its own cadence and rewrites
   current.json wholesale; folding the other two into that file would mean a
   sync could silently drop them, and applying them in two places would mean
   applying them twice. One function, called by the offline assembly and by
   the browser, gives every consumer the same answer.

   THE GRADE IS RECOMPUTED, NOT INHERITED. `dataQuality` is what EdgeDesk
   actually knows about a team, so a team whose conference report was ingested
   is OFFICIAL even if every automated collector refused it, and a team with
   nothing but refusals stays LIMITED however many sources were tried. The one
   thing no path here can produce is a team marked healthy because nothing was
   found: only a report the policy calls COMPREHENSIVE, actually read, may say
   that, and it sets `report_of_no_absences` rather than an empty record list.

   Node and browser (UMD).
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  root.EDAvailabilityOverlay = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function nk(s) {
    if (s == null) return null;
    return String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '') || null;
  }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  /* GRADES, from what is actually on file for a team:
       OFFICIAL  a conference filing for this fixture was read
       STRONG    an operator correction or a resolved media report names people
       PARTIAL   something was read and it names people at a weaker tier
       LIMITED   sources were asked and none carried a usable report
       NONE      nothing could be asked                                     */
  /* THE VOCABULARY, IN ONE PLACE. Every consumer that decides what a grade
     MEANS — the offline assembly deciding whether a read reaches the engine,
     the browser, the tests — reads it from here rather than carrying its own
     copy. The copies drifted once: the assembly's test knew STRONG and
     PARTIAL as the graded reads, OFFICIAL was added here, and the first
     ingested conference filing failed the weekly build's suite on four teams
     the layer had actually read best. A grade is GRADED when a source was
     read and what it says can be handed to the engine as a report, empty or
     not; LIMITED and NONE are not reports and are never handed on. */
  var GRADES = ['OFFICIAL', 'STRONG', 'PARTIAL', 'LIMITED', 'NONE'];
  var GRADED = { OFFICIAL: true, STRONG: true, PARTIAL: true };
  function normGrade(q) { return String(q == null ? 'NONE' : q).toUpperCase(); }
  function isGraded(q) { return GRADED[normGrade(q)] === true; }

  /* THE TEAM-LEVEL GRADE: what is on file for the team across every
     fixture. It is the headline the terminal's availability card shows. It is
     NOT the grade of any one game. A team whose conference filed for last
     week is not OFFICIAL for this week. Anything that decides what reaches a
     game's engine request reads gradeFor(t, gameId, …) below. */
  function gradeOf(t) {
    if (t.official_report && t.official_report.ok) return 'OFFICIAL';
    var n = (t.players || []).length;
    var op = (t.operator_entries || []).length;
    if (op && n) return 'STRONG';
    if (op) return 'PARTIAL';
    var had = String(t.dataQuality || t.data_quality || 'NONE').toUpperCase();
    if (n) return had === 'NONE' ? 'PARTIAL' : had;
    return had;
  }

  /* ==== ONE FIXTURE AT A TIME ========================================
     Everything below answers a question about ONE game. The merged team
     record holds every fixture's evidence side by side: an official filing
     for each game it was read for, the operator's dated entries, and the
     automated read's rows. It keeps all of them for audit. The engine may
     only be handed what is about the game it is pricing.

       official report   the filing for THIS game_id, or none. A filing for
                         last week's game says nothing about this one, even
                         when it is the only filing on file.
       a row with a      evidence about that fixture. It counts for its own
       game_id           game and for no other.
       a row without     a team-scoped statement (the automated read, e.g.
       one               ESPN's injury page). It is judged by the
                         availability layer's own freshness ladder against
                         this game's kickoff
                         (availability.js getAvailabilityFreshness), and a
                         HISTORICAL one is refused. A 2020 injury note is not
                         this week's news. Retrieving it again this morning
                         does not make it so.

     The ladder is restated here, not required, because the board loads this
     file without availability.js. availability.test's twin in
     football/matchup/contract.test.js pins the two to the same answer. */
  var H_WEEK = 168, H_GAME_WEEK = 96;
  function tsOf(x) { if (x == null || x === '') return null; var v = Date.parse(String(x)); return isFinite(v) ? v : null; }
  /* the one timestamp a row is judged on: when the source PUBLISHED it, else
     when it was observed. availability.js reads the same two fields */
  function publishedAt(p) { return p ? (p.source_published_at || p.observed_at || null) : null; }
  function freshness(p, o) {
    o = o || {};
    var now = tsOf(o.now) != null ? tsOf(o.now) : (isNum(o.now) ? o.now : Date.now());
    var seen = tsOf(publishedAt(p));
    if (seen == null) return { state: 'HISTORICAL', age_hours: null, reason: 'the report carries no timestamp' };
    var kick = tsOf(o.kickoff);
    var ageH = (now - seen) / 3600000;
    if (kick != null) {
      var beforeKick = (kick - seen) / 3600000;
      if (beforeKick > H_WEEK) return { state: 'HISTORICAL', age_hours: ageH, reason: 'filed more than a week before kickoff' };
      if (beforeKick > H_GAME_WEEK) return { state: 'STALE', age_hours: ageH, reason: 'filed before this game week' };
    }
    if (ageH < 0) return { state: 'LIVE', age_hours: 0, reason: null };
    if (ageH <= 6) return { state: 'LIVE', age_hours: ageH, reason: null };
    if (ageH <= 48) return { state: 'CURRENT', age_hours: ageH, reason: null };
    if (ageH <= 96) return { state: 'AGING', age_hours: ageH, reason: null };
    if (ageH <= H_WEEK) return { state: 'STALE', age_hours: ageH, reason: null };
    return { state: 'HISTORICAL', age_hours: ageH, reason: 'older than a week' };
  }

  /* the filing read for THIS game, or null */
  function officialFor(t, gameId) {
    if (!t || gameId == null) return null;
    var r = t.official_reports && t.official_reports[String(gameId)];
    if (!r && t.official_report && t.official_report.game_id != null
      && String(t.official_report.game_id) === String(gameId)) r = t.official_report;
    return r && r.ok ? r : null;
  }

  /* is this row usable for this fixture, and if not, why not.
     o = { now, kickoff } */
  function judgeRow(p, gameId, o) {
    if (!p) return { use: false, why: 'EMPTY' };
    if (p.game_id != null) {
      if (gameId != null && String(p.game_id) !== String(gameId)) return { use: false, why: 'OTHER_FIXTURE' };
      /* bound to this game by the source that filed it: about this game
         whenever it was filed. How old it is, the contract states as STALE */
      return { use: true, why: null, scope: 'FIXTURE' };
    }
    var f = freshness(p, o);
    if (f.state === 'HISTORICAL') return { use: false, why: 'HISTORICAL', reason: f.reason, freshness: f.state };
    return { use: true, why: null, scope: 'TEAM', freshness: f.state };
  }
  function isHistorical(p, o) { return !!p && p.game_id == null && freshness(p, o).state === 'HISTORICAL'; }

  /* the rows about THIS fixture, and a count of what was refused */
  function fixtureRows(t, gameId, o) {
    var rows = [], refused = { OTHER_FIXTURE: 0, HISTORICAL: 0 };
    ((t && t.players) || []).forEach(function (p) {
      var j = judgeRow(p, gameId, o);
      if (j.use) rows.push(p);
      else if (refused[j.why] != null) refused[j.why]++;
    });
    return { rows: rows, refused: refused };
  }

  /* THE GRADE OF ONE FIXTURE, from what is on file for it. It uses the same
     ladder as gradeOf, over this game's evidence only:
       OFFICIAL  the conference filing for THIS game was read
       STRONG    an operator correction for this game
       …         otherwise the automated read's own grade, over rows that
                 survived the freshness ladder. A read whose only rows were
                 refused as historical grades as if it had named nobody. */
  function gradeFor(t, gameId, o) {
    if (!t) return 'NONE';
    if (officialFor(t, gameId)) return 'OFFICIAL';
    var fx = fixtureRows(t, gameId, o).rows;
    var op = fx.filter(function (p) { return p.source_type === 'OPERATOR'; }).length;
    if (op) return 'STRONG';
    /* the automated read's own grade. A record not built by build() carries
       only dataQuality; OFFICIAL there came from some filing, and a filing
       counts only for its own game (checked above), never as a fallback */
    var had = normGrade(t.automated_grade != null ? t.automated_grade : (t.dataQuality || t.data_quality));
    if (had === 'OFFICIAL') had = 'NONE';
    var auto = fx.filter(function (p) { return p.source_type !== 'OFFICIAL' && p.source_type !== 'OPERATOR'; }).length;
    if (auto) return had === 'NONE' ? 'PARTIAL' : had;
    return had;
  }

  /* the freshest publication among a fixture's rows (the clock the contract
     measures STALE against), else null */
  function publishedOf(rows) {
    var newest = null;
    (rows || []).forEach(function (p) {
      var ts = tsOf(publishedAt(p)) != null ? tsOf(publishedAt(p)) : tsOf(p.retrieved_at);
      if (ts != null && (newest == null || ts > newest)) newest = ts;
    });
    return newest == null ? null : new Date(newest).toISOString();
  }

  /* A DOCUMENT THAT NAMES NOBODY ON EITHER SIDE OF ITS FIXTURE IS NOT A
     REPORT OF NO ABSENCES. The ingester reads a document against one team's
     roster; a page that is not the report at all — a conference homepage, a
     policy announcement, an availability page whose table the browser fills
     in by script — names nobody on it too, and for a conference whose policy
     makes silence mean "available" that became a clean bill of health. It
     did, on every ACC, Big 12 and Big Ten fixture the sync read this season.

     So silence has to be CORROBORATED. A report that names nobody stands
     only when the same document, read for the other side of the same
     fixture, named someone — the document demonstrably lists this game's
     players and simply lists none of ours — or when the parser that read it
     found an explicit statement that this team lists nobody
     (`explicit_none`). Otherwise it becomes what it is: a failed read.
     Applied here, at read time, so it holds for every file already on disk
     as well as every file written from now on, in the build and the board
     alike. */
  function corroborate(reports) {
    var named = {};
    (reports || []).forEach(function (r) {
      if (r && r.ok && (r.rows || []).length) named[String(r.game_id) + '|' + String(r.source_url)] = true;
    });
    return (reports || []).map(function (r) {
      if (!r || !r.ok || (r.rows || []).length || r.explicit_none === true) return r;
      if (named[String(r.game_id) + '|' + String(r.source_url)]) return r;
      var copy = {}, f;
      for (f in r) if (Object.prototype.hasOwnProperty.call(r, f)) copy[f] = r[f];
      copy.ok = false;
      copy.silence_means_available = false;
      copy.uncorroborated = true;
      copy.why = 'the document named nobody on either side of this fixture, so EdgeDesk cannot tell it from a page '
        + 'that is not the report (a homepage, a policy announcement, a table the page fills in by script). It is '
        + 'a failed read, not a report of no absences' + (r.why ? ' — the ingester had said: ' + r.why : '');
      return copy;
    });
  }

  /* o = { current, operator, reports, now, normKey }
       current   the parsed football/availability/current.json (may be null)
       operator  the result of EDAvailabilityOperator.load(store, now)
       reports   an array of ingested report objects (reports.js output)
     Returns { teams, by_key, counts, note }.                               */
  function build(o) {
    o = o || {};
    var now = o.now || Date.now();
    var norm = o.normKey || nk;
    var cur = o.current || null;
    var teams = {};
    var k;

    if (cur && cur.teams) {
      for (k in cur.teams) if (Object.prototype.hasOwnProperty.call(cur.teams, k)) {
        var t = cur.teams[k];
        var copy = {};
        for (var f in t) if (Object.prototype.hasOwnProperty.call(t, f)) copy[f] = t[f];
        copy.players = (t.players || []).slice();
        copy.operator_entries = [];
        copy.official_report = null;
        copy.official_reports = {};
        copy.official_reports_failed = {};
        /* what the automated read itself graded, kept apart from the regrade
           below: a fixture with no filing of its own falls back to it */
        copy.automated_grade = normGrade(t.dataQuality || t.data_quality);
        copy.sources_merged = ['automated read'];
        teams[k] = copy;
      }
    }

    function slot(name, id) {
      var key = norm(name);
      var found = null, kk;
      for (kk in teams) if (Object.prototype.hasOwnProperty.call(teams, kk)) {
        var tt = teams[kk];
        if (id != null && String(tt.team_id) === String(id)) { found = tt; break; }
        if (key && (norm(tt.team_name) === key || norm(tt.team_display) === key)) { found = tt; break; }
      }
      if (found) return found;
      /* a team the automated sync never covered still gets a slot: an
         ingested report about it is evidence whatever the sync did */
      var made = { team_id: id == null ? null : String(id), team_name: name || null, team_display: name || null,
        conference: null, dataQuality: 'NONE', automated_grade: 'NONE', lastUpdated: null, players: [], operator_entries: [],
        official_report: null, official_reports: {}, official_reports_failed: {},
        sources_merged: [], counts: { records: 0, flagged: 0, high: 0, cleared: 0, stale: 0, official: 0 } };
      teams[norm(name) || ('t' + Object.keys(teams).length)] = made;
      return made;
    }

    /* ---- 1. ingested official reports ------------------------------- */
    var reportCount = 0, reportFailed = 0;
    corroborate(o.reports).forEach(function (r) {
      if (!r || !r.team) return;
      var t = slot(r.team, r.team_id);
      if (!r.ok) {
        /* A FAILED READ IS RECORDED AS A FAILED READ. It never becomes an
           empty report, and it never raises the grade. */
        reportFailed++;
        t.official_report_failed = { source_url: r.source_url, why: r.why, retrieved_at: r.retrieved_at };
        if (r.game_id != null) t.official_reports_failed[String(r.game_id)] = t.official_report_failed;
        t.sources_merged.push('official report (read failed)');
        return;
      }
      reportCount++;
      /* ONE SLOT PER FIXTURE. A team with two filings on file (last week's
         and this week's) keeps both, each keyed by the game it was read for.
         `official_report` stays the legacy team-level slot (the last filing
         in file order) for the headline grade and nothing else. */
      t.official_report = {
        conference: r.conference, source_url: r.source_url,
        published_at: r.published_at, retrieved_at: r.retrieved_at,
        scope: r.scope, comprehensive: !!r.comprehensive,
        vocabulary: r.vocabulary || [], game_id: r.game_id || null,
        names: (r.rows || []).length,
        /* a count: the bundle the board reads carries unparsed_n, not the lines */
        unparsed: r.unparsed_n != null ? r.unparsed_n : (r.unparsed || []).length,
        ok: true,
        report_of_no_absences: !!r.silence_means_available
      };
      if (r.game_id != null) t.official_reports[String(r.game_id)] = t.official_report;
      t.sources_merged.push('official report');
      (r.rows || []).forEach(function (row) {
        t.players.push({
          player_name: row.player_name, name: row.player_name, player_id: row.player_id,
          position: row.position, jersey: row.jersey,
          status: row.status, practice_status: row.practice_status, body_part: row.body_part,
          depth_role: null,
          source_type: 'OFFICIAL', source_name: (r.conference || '') + ' availability report',
          source_url: r.source_url,
          source_published_at: r.published_at, observed_at: r.published_at,
          /* an undated filing still has the moment EdgeDesk read it */
          retrieved_at: r.retrieved_at || null,
          tier: 1, game_id: r.game_id || null
        });
      });
    });

    /* ---- 2. operator corrections ------------------------------------ */
    var opCount = 0;
    ((o.operator && o.operator.live) || []).forEach(function (e) {
      if (e.kind !== 'AVAILABILITY') return;
      var t = slot(e.team, null);
      opCount++;
      t.operator_entries.push(e);
      t.sources_merged.push('operator correction');
      t.players.push({
        player_name: e.player, name: e.player, player_id: null,
        position: e.position, jersey: null,
        status: e.status, practice_status: 'NOT_REPORTED', body_part: null, depth_role: null,
        source_type: 'OPERATOR', source_name: e.source_name, source_url: e.source_url,
        source_published_at: e.published_at, observed_at: e.published_at,
        recorded_by: e.recorded_by, tier: e.tier, game_id: e.game_id
      });
    });

    /* ---- 3. regrade -------------------------------------------------- */
    var counts = { official: 0, strong: 0, partial: 0, limited: 0, none: 0, records: 0 };
    for (k in teams) if (Object.prototype.hasOwnProperty.call(teams, k)) {
      var team = teams[k];
      team.dataQuality = gradeOf(team);
      if (!team.counts) team.counts = {};
      team.counts.records = team.players.length;
      counts.records += team.players.length;
      var g = String(team.dataQuality).toLowerCase();
      if (counts[g] != null) counts[g]++;
      /* the freshest OBSERVATION on file, which is not the same as when the
         sync last ran and is what staleness must be measured against */
      var newest = null;
      team.players.forEach(function (p) {
        var ts = Date.parse(p.observed_at || p.source_published_at || '');
        if (isFinite(ts) && (newest == null || ts > newest)) newest = ts;
      });
      team.observed_at = newest == null ? null : new Date(newest).toISOString();
    }

    return { teams: teams, counts: counts,
      merged: { official_reports: reportCount, official_reports_failed: reportFailed, operator_entries: opCount },
      note: 'three sources merged at read time: ingested conference reports, dated operator corrections and the '
        + 'automated collector read. A failed report read is recorded as a failed read and never as a team with '
        + 'no absences; only a report the policy calls comprehensive can say that, and it sets '
        + 'report_of_no_absences.' };
  }

  return { build: build, corroborate: corroborate, gradeOf: gradeOf, normKey: nk, GRADES: GRADES, GRADED: GRADED, isGraded: isGraded, normGrade: normGrade,
    gradeFor: gradeFor, officialFor: officialFor, fixtureRows: fixtureRows, judgeRow: judgeRow,
    isHistorical: isHistorical, freshness: freshness, publishedAt: publishedAt, publishedOf: publishedOf };
});
