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
        conference: null, dataQuality: 'NONE', lastUpdated: null, players: [], operator_entries: [],
        official_report: null, sources_merged: [], counts: { records: 0, flagged: 0, high: 0, cleared: 0, stale: 0, official: 0 } };
      teams[norm(name) || ('t' + Object.keys(teams).length)] = made;
      return made;
    }

    /* ---- 1. ingested official reports ------------------------------- */
    var reportCount = 0, reportFailed = 0;
    (o.reports || []).forEach(function (r) {
      if (!r || !r.team) return;
      var t = slot(r.team, r.team_id);
      if (!r.ok) {
        /* A FAILED READ IS RECORDED AS A FAILED READ. It never becomes an
           empty report, and it never raises the grade. */
        reportFailed++;
        t.official_report_failed = { source_url: r.source_url, why: r.why, retrieved_at: r.retrieved_at };
        t.sources_merged.push('official report (read failed)');
        return;
      }
      reportCount++;
      t.official_report = {
        conference: r.conference, source_url: r.source_url,
        published_at: r.published_at, retrieved_at: r.retrieved_at,
        scope: r.scope, comprehensive: !!r.comprehensive,
        vocabulary: r.vocabulary || [], game_id: r.game_id || null,
        names: (r.rows || []).length, unparsed: (r.unparsed || []).length,
        ok: true,
        report_of_no_absences: !!r.silence_means_available
      };
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

  return { build: build, gradeOf: gradeOf, normKey: nk, GRADES: GRADES, GRADED: GRADED, isGraded: isGraded, normGrade: normGrade };
});
