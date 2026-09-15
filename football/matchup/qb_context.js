/* ============================================================================
   THE QUARTERBACK, FLATTENED FOR THE ENGINE'S INFORMATION LAYER — once.

   WHY THIS FILE EXISTS. This flattening was written twice: `qbContext()` in
   football/matchup/inputs.js for the offline build, and `fbP4QbContext()` in
   app.html for the browser, each with its own copy of the persistence lookup
   and a comment in both saying they must mirror each other field for field.
   Two implementations of one contract is how the board and the committed
   artifact come to disagree about the same game out of the same files, which
   is the bug football/matchup/inputs.js was created to end one level up.
   So it lives here, once, and both callers load it.

   FOUR SEPARATE STATEMENTS, NEVER COLLAPSED. The engine's information layer
   scores each of these on its own and the flattening must therefore keep
   them apart:

     who he is          an athlete id, corroborated against the CURRENT roster
     that he starts     the evidence class, and the MEASURED rate at which
                        that class of evidence holds
     what he has done   dropbacks, starts, and whether an efficiency history
                        resolved for that same id
     that he can play   EXPLICIT availability evidence, or a COMPREHENSIVE
                        report that names nobody, and nothing else

   `availability_evidence` has three values and the third one is the point:
   NONE is not "available", and no path in this file can turn silence into
   health. A comprehensive conference report that names nobody on a roster IS
   a report of no absences — but only football/availability/policy.js may say
   a source is comprehensive, and only for the games that source covers.

   THE EVIDENCE CLASS is published beside the raw status because the reader
   asked a different question from the engine: CONFIRMED, PROJECTED,
   COMPETITION, LAST_GAME_PROXY, UNKNOWN. A projection is never promoted to a
   confirmation and a well-supported projection is never called unknown.

   Node and browser (UMD).
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  root.EDQbContext = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  /* WHAT KIND OF ANSWER IS THIS. The starter record's `status` is the
     evidence that resolved him; this is what that evidence entitles a reader
     to believe, which is a different sentence and was never published. */
  var CLASSES = {
    ANNOUNCED: { id: 'CONFIRMED', label: 'confirmed starter',
      means: 'an official team or conference source named him for THIS game' },
    DEPTH_CHART: { id: 'PROJECTED', label: 'projected starter (published depth chart)',
      means: 'he leads a published depth chart — a projection with a document behind it, not an announcement' },
    EXPECTED: { id: 'PROJECTED', label: 'projected starter (current reporting)',
      means: 'current attributed reporting supports him — a projection, never a confirmation' },
    PREVIOUS_GAME: { id: 'LAST_GAME_PROXY', label: 'last game’s starter',
      means: 'he opened the team’s most recent completed game. An observation with a source and a '
        + 'timestamp, and the rate at which it holds for the next game is measured rather than assumed' },
    COMPETITION: { id: 'COMPETITION', label: 'open competition',
      means: 'the evidence names more than one player at the same tier and does not settle' },
    UNKNOWN: { id: 'UNKNOWN', label: 'unknown',
      means: 'nothing EdgeDesk can read names a starter for this team' }
  };

  function classOf(rec) {
    var st = String((rec && rec.status) || 'UNKNOWN').toUpperCase();
    var c = CLASSES[st] || CLASSES.UNKNOWN;
    /* A CONFIRMATION IS A TIER-1 FACT, NOT A LABEL. `announced` is set only
       by an official source in football/starters/starters.js; a record that
       reaches ANNOUNCED without it is downgraded here rather than trusted. */
    if (c.id === 'CONFIRMED' && rec && rec.announced !== true) {
      return { id: 'PROJECTED', label: 'projected starter',
        means: 'the record reached the announced tier without an official source flag, so it is read as a '
          + 'projection. A projection is never published as a confirmation' };
    }
    return c;
  }

  /* HOW MANY GAMES IN A ROW, IMMEDIATELY BEFORE THE LAST ONE, THE SAME MAN
     OPENED. Counted exactly as football/starters/calibrate_persistence.js
     counts it when it measures the rate — the predictor and the calibration
     have to be the same quantity or the coefficient is applied to something
     it never saw. */
  function runBefore(rec) {
    var hist = (rec && rec.history) || [];
    if (!hist.length || !rec.player_id) return null;
    var i, last = -1;
    for (i = hist.length - 1; i >= 0; i--) {
      if (hist[i] && hist[i].starter && String(hist[i].starter.player_id) === String(rec.player_id)) { last = i; break; }
    }
    if (last < 0) return null;
    var run = 0;
    for (i = last - 1; i >= 0; i--) {
      var h = hist[i];
      if (h && h.starter && String(h.starter.player_id) === String(rec.player_id)) run++;
      else break;
    }
    return run;
  }

  /* THE MEASURED RATE FOR THIS SITUATION.

     The calibration publishes several conditionings of the same pairs and
     names the one it chose OUT OF SAMPLE in `engine_reads`. This reads that
     field rather than picking; a cell with too little support falls back to
     its band, and a band with too little support returns null so the engine
     declares the reliability unmeasured instead of substituting a constant. */
  function persistenceFor(cal, lastShare, run) {
    if (!cal || !isNum(lastShare)) return null;
    var bands = (cal.by_band || []).slice().sort(function (a, b) { return b.min_share - a.min_share; });
    if (!bands.length) return null;
    var band = null, i;
    for (i = 0; i < bands.length; i++) if (lastShare >= bands[i].min_share) { band = bands[i]; break; }
    if (!band) band = bands[bands.length - 1];

    var reads = cal.engine_reads || 'band';
    var runBands = (cal.run_bands || []).slice().sort(function (a, b) { return b.min_run - a.min_run; });
    var rb = null;
    if (isNum(run) && runBands.length) {
      for (i = 0; i < runBands.length; i++) if (run >= runBands[i].min_run) { rb = runBands[i]; break; }
      if (!rb) rb = runBands[runBands.length - 1];
    }
    if (reads === 'band_x_run' && rb && cal.by_band_and_run) {
      for (i = 0; i < cal.by_band_and_run.length; i++) {
        var c = cal.by_band_and_run[i];
        if (c.band === band.id && c.run === rb.id && c.rate != null) {
          return { band: c.band + '/' + c.run, rate: c.rate, pairs: c.pairs, label: c.label,
            run: run, run_band: rb.id,
            run_label: 'and had opened ' + (run === 0 ? 'none' : run) + ' of the games before it',
            conditioning: 'band_x_run', source: cal.source || null, as_of: cal.generated_at || null };
        }
      }
    }
    if (band.rate == null) return null;
    return { band: band.id, rate: band.rate, pairs: band.pairs, label: band.label,
      run: isNum(run) ? run : null, run_band: rb ? rb.id : null,
      run_label: isNum(run) ? ('and had opened ' + (run === 0 ? 'none' : run) + ' of the games before it') : null,
      conditioning: 'band', source: cal.source || null, as_of: cal.generated_at || null };
  }

  /* rec:  one team's record out of football/starters/cfb_<season>.json
     opts: { persistence, efficiency_history, availability_evidence }
       persistence           the parsed calibration artifact
       efficiency_history    true when an EPA history resolved for THIS id
       availability_evidence 'EXPLICIT' | 'COMPREHENSIVE_SILENCE' | 'NONE' */
  function build(rec, opts) {
    opts = opts || {};
    if (!rec || !rec.player_id) return null;
    var exp = rec.experience || null;
    var comp = rec.competition || null;
    /* his own share of the room's observed dropbacks; a contested room is
       genuinely less certain and the record already says so */
    var share = null, i;
    if (comp && comp.players) {
      for (i = 0; i < comp.players.length; i++) {
        if (String(comp.players[i].player_id) === String(rec.player_id) && isNum(comp.players[i].share)) {
          share = comp.players[i].share; break;
        }
      }
    }
    /* THE LAST GAME HE ACTUALLY OPENED, and what share of it he threw. The
       persistence cells are measured on exactly this quantity, not on the
       season-long competition share — those are different numbers and using
       one where the other was measured would mis-band every team. */
    var hist = (rec.history && rec.history.length) ? rec.history : [];
    var lastShare = null;
    for (i = hist.length - 1; i >= 0; i--) {
      var h = hist[i];
      if (h && h.starter && String(h.starter.player_id) === String(rec.player_id) && isNum(h.starter.share)) {
        lastShare = h.starter.share; break;
      }
    }
    var run = runBefore(rec);
    var cls = classOf(rec);
    var av = opts.availability_evidence || 'NONE';
    return {
      player: rec.player_name || null,
      player_id: rec.player_id,
      status: rec.status || 'UNKNOWN',
      evidence_class: cls.id,
      evidence_label: cls.label,
      evidence_means: cls.means,
      /* the reader-facing distinction the task this file answers demands:
         a confirmation is an official source and nothing else is */
      confirmed: rec.announced === true && String(rec.status).toUpperCase() === 'ANNOUNCED',
      field_state: rec.field_state || null,
      identity_corroborated: rec.identity_corroborated !== false,
      identity_basis: rec.identity_basis || null,
      contested: !!(comp && comp.contested),
      dropback_share: share,
      last_game_share: lastShare,
      consecutive_starts_before_last: run,
      persistence: persistenceFor(opts.persistence, lastShare, run),
      dropbacks: exp && isNum(exp.dropbacks) ? exp.dropbacks : null,
      starts: exp && isNum(exp.starts) ? exp.starts : null,
      seasons_observed: exp && isNum(exp.seasons_observed) ? exp.seasons_observed : null,
      /* MEASURED PERFORMANCE IS A SEPARATE QUESTION FROM WHO STARTS, and a
         separate question again from whether it moves the line. This flag
         answers only the first: did an efficiency history resolve for this
         athlete id. What may be done with it is decided elsewhere. */
      efficiency_history: opts.efficiency_history === true,
      availability_evidence: av === 'EXPLICIT' || av === 'COMPREHENSIVE_SILENCE' ? av : 'NONE',
      availability_why: opts.availability_why || null,
      source: rec.source || null,
      as_of: rec.retrieved_at || null
    };
  }

  return { build: build, persistenceFor: persistenceFor, runBefore: runBefore,
    classOf: classOf, CLASSES: CLASSES };
});
