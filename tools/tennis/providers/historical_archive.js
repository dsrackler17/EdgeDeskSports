#!/usr/bin/env node
/* HistoricalTennisProvider — the Sackmann-format ATP/WTA archive.
   CC BY-NC-SA 4.0: research only. This adapter READS a file; the write is
   tools/tennis/import_archive.js, which is the only thing that should ever
   move 361,000 rows. What lives here is the normalisation contract, so the day
   a licensed historical feed replaces this one, import_archive.js keeps
   working against the same shapes. */
'use strict';
const P = require('./index.js');
const CSV = require('../lib/csv.js');
const M = require('../../../lib/tennis_model.js');

module.exports = P.defineProvider({
  kind: 'historical',
  name: 'sackmann_archive',
  source_key: 'archive',
  credentials: [],
  capabilities: {
    pre_match_features: true,   // Elo, form, fatigue and surface history, computed before each match
    serve_statistics: true,     // per match, POST-match: the record, never a model input
    exact_start_time: false,    // dated to the tournament WEEK, not to first serve
    live_score: false,
    closing_price: false,
    doubles: false              // singles only
  },
  licence_note: 'CC BY-NC-SA 4.0. Non-commercial. Replace with a licensed feed '
              + 'before any paid tennis surface ships; the database refuses to '
              + 'mark this source commercially cleared.',

  /* Async iterator of normalised match rows. One file, one pass, no buffering:
     the caller decides how much of it to hold. */
  async *read(opts) {
    const o = opts || {};
    if (!o.file) throw new Error('historical_archive.read needs {file}');
    for await (const rec of CSV.readRows(o.file, { member: o.member })) {
      const r = CSV.toObject(rec.header, rec.values);
      const v = M.validateRow(r);
      const tour = M.normTour(r.tour);
      yield {
        source_key: 'archive',
        tour: tour,
        source_tourney_id: M.str(r.tourney_id),
        match_num: M.int(r.match_num),
        match_date: M.parseDate(r.tourney_date),
        tourney_name: M.str(r.tourney_name),
        surface: M.surfaceOrUnknown(r.surface),
        level: M.str(r.tourney_level),
        round: M.str(r.round),
        best_of: M.int(r.best_of),
        winner_source_id: M.str(r.winner_id),
        loser_source_id: M.str(r.loser_id),
        winner_name: M.str(r.winner_name),
        loser_name: M.str(r.loser_name),
        score: M.str(r.score),
        minutes: M.int(r.minutes),
        winner_rank: M.plausibleRank(r.winner_rank),
        loser_rank: M.plausibleRank(r.loser_rank),
        retirement: M.parseScore(r.score).retirement,
        walkover: M.parseScore(r.score).walkover,
        source_updated_at: null,
        /* what this source does NOT carry for this row, named rather than
           silently absent */
        unmapped: v.ok ? [] : v.issues.map((i) => i.field),
        raw_ref: { row: rec.index, match_uid: M.str(r.match_uid) }
      };
    }
  },

  /* The provider's own account of what it holds, for the run summary and for
     the AI's "what is missing" answer. */
  describe() {
    return {
      name: 'sackmann_archive',
      coverage: 'ATP and WTA singles, 1968 to the latest published season file',
      grain: 'one row per match, dated to the tournament week',
      not_carried: ['exact first-serve time', 'point-by-point', 'doubles',
                    'in-play state', 'market prices', 'injury or withdrawal reasons'],
      licence: 'CC BY-NC-SA 4.0 (non-commercial)'
    };
  }
});
