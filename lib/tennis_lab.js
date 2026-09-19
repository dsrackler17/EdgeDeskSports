/* ===========================================================================
   EdgeDesk Tennis Lab — the RESEARCH engine.

   lib/tennis_model.js owns the historical record: how an archive row becomes a
   match, what was knowable before it, what a rating means, what a fair price
   is. This file owns the QUESTIONS a researcher actually asks of that record:

     translate   how does a player's strength change by surface, and how much
                 of that difference is signal rather than a thin sample?
     trajectory  is this player improving, declining, stable, returning from
                 inactivity, or playing above/below their established level?
     workload    how much tennis has this player played lately, and does the
                 schedule itself deserve a flag?
     matchup     A against B, on a surface, in an environment, at a format —
                 what does EdgeDesk estimate, what drives it, how confident
                 should anyone be, and what does the model not know?
     compare     two players side by side on the dimensions that decide matches
     comparable  which historical matches resemble this one

   THE RULE THIS FILE EXISTS TO ENFORCE. Every one of those answers is only as
   good as its sample, and a research product that hides the sample is worse
   than one that refuses to answer. So no function here returns a bare number.
   Each returns the number, the sample it rests on, an uncertainty, and the
   list of inputs that were ABSENT — and the absent list is never silently
   turned into zeros. "EdgeDesk does not know this player's serve" and "this
   player never lands a first serve" are different facts and stay different.

   NO ODDS ANYWHERE IN THIS FILE. Not as an input, not as a fallback, not as an
   optional enrichment. The Tennis Lab is a player-intelligence product that
   must work identically whether or not a sportsbook has ever heard of the
   match. Market comparison is a separate, disabled module that reads this
   engine's output — never the other way round.

   RESEARCH, NOT PICKS. Nothing here produces a selection, a stake or a verb.
   =========================================================================== */
(function (root, factory) {
  var model = (typeof module !== 'undefined' && module.exports)
    ? require('./tennis_model.js')
    : root.EDTennisModel;
  var api = factory(model);
  root.EDTennisLab = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function (M) {
  'use strict';

  var VERSION      = 'tennis-lab-1.0';
  var LAB_VERSION  = 'tennis-lab-1.0.0';
  var BRIEF_VERSION = 'tennis-brief-1.0.0';

  var num = M.num, int = M.int, str = M.str, round = M.round, clamp = M.clamp;
  var mean = M.mean;

  /* ─────────────────────────── the lab's view modes ───────────────────────
     The dashboard offers nine ways to rank a tour. They are declared here
     rather than in the page so the AI, the SQL and the UI cannot drift into
     three different definitions of "best recent form". */
  var LAB_MODES = [
    { key: 'overall', label: 'Overall',     metric: 'power_rating',
      blurb: 'EdgeDesk power rating across every surface.' },
    { key: 'hard',    label: 'Hard',        metric: 'hard_elo',   surface: 'hard',
      blurb: 'Surface Elo on hard courts, shrunk by hard-court sample.' },
    { key: 'clay',    label: 'Clay',        metric: 'clay_elo',   surface: 'clay',
      blurb: 'Surface Elo on clay, shrunk by clay sample.' },
    { key: 'grass',   label: 'Grass',       metric: 'grass_elo',  surface: 'grass',
      blurb: 'Surface Elo on grass. Grass samples are the thinnest on tour.' },
    { key: 'indoor',  label: 'Indoor',      metric: 'indoor_elo', surface: 'indoor',
      blurb: 'Indoor record. Reported only where the source carried an environment.' },
    { key: 'form',    label: 'Recent form', metric: 'form_90d',
      blurb: '90-day win rate, adjusted for the strength of who was played.' },
    { key: 'serve',   label: 'Serve',       metric: 'serve_strength',
      blurb: 'Rolling serve strength. Absent for matches with no serve statistics.' },
    { key: 'return',  label: 'Return',      metric: 'return_strength',
      blurb: 'Rolling return pressure. Absent where the source carried no return data.' },
    { key: 'workload', label: 'Workload',   metric: 'matches_14d',
      blurb: 'Matches in the last 14 days. A schedule signal, never an injury claim.' }
  ];
  function labMode(key) {
    var k = String(key || 'overall').toLowerCase();
    for (var i = 0; i < LAB_MODES.length; i++) if (LAB_MODES[i].key === k) return LAB_MODES[i];
    return LAB_MODES[0];
  }

  /* ───────────────────────── the documented power scale ───────────────────
     One definition, quoted by the page, the AI and the database. The database
     has its own copy in tennis.power_rating_scale() and lab.test.js fails if
     the two ever drift apart. */
  var POWER_SCALE = {
    version: LAB_VERSION,
    min: 0, max: 100, midpoint: 50,
    sd_points: 10,
    full_sample: M.RATING_FULL_SAMPLE,
    text: 'EdgeDesk power rating, 0-100. 50 is the median rated player on this '
        + 'tour on the day the rating was built. Ten points is about one '
        + 'standard deviation of tour Elo. A player with a thin record is '
        + 'shrunk toward 50 in proportion to what is missing, so the number '
        + 'always carries its sample and its uncertainty beside it. It is a '
        + 'description of the record on file, not a forecast of a match.',
    bands: [
      { min: 75, label: 'Elite',       note: 'top of the tour on this measure' },
      { min: 65, label: 'Strong',      note: 'consistently beats the field' },
      { min: 55, label: 'Above tour',  note: 'better than the median rated player' },
      { min: 45, label: 'Tour level',  note: 'around the tour median' },
      { min: 35, label: 'Below tour',  note: 'loses more than wins at this level' },
      { min: 0,  label: 'Developing',  note: 'thin or weak record on file' }
    ]
  };
  function powerBand(r) {
    var v = num(r);
    if (v == null) return { label: 'Unrated', note: 'no rating on file' };
    for (var i = 0; i < POWER_SCALE.bands.length; i++) {
      if (v >= POWER_SCALE.bands[i].min) return POWER_SCALE.bands[i];
    }
    return POWER_SCALE.bands[POWER_SCALE.bands.length - 1];
  }

  /* ─────────────────────────── uncertainty plumbing ───────────────────────
     Sample -> a 0..1 uncertainty and a +/- band on the rating point scale.

     WHY A BAND AND NOT A CONFIDENCE INTERVAL. A true interval would need the
     posterior of the Elo process, which EdgeDesk does not carry. What it does
     carry is the sample, and the honest thing is to publish a band that is
     explicitly a function of sample size and say so, rather than to dress a
     heuristic up as a frequentist interval. The label says "band", the model
     card says how it is computed, and nothing rounds it away. */
  var BAND_AT_ZERO = 18;   // rating points of uncertainty with nothing on file
  var BAND_FLOOR   = 1.5;  // the band never claims better than this

  /* THE ESTIMATOR'S OWN ERROR — the floor no amount of data buys past.

     Derived from the model's evaluation, not chosen for looks. The baseline
     model scores a log loss near 0.60 and an accuracy near 67% on a held-out
     chronological test set; a Brier score of ~0.21 means the average squared
     error of a published probability is about 0.21, so a typical absolute
     error is on the order of ±0.05 even where every input is present and both
     records are deep. That is the number below, and docs/model-card-tennis.md
     carries the derivation. If a retrain genuinely improves the estimator,
     this constant moves with it — tools/tennis/build_model.js writes the
     measured figure into the model registry and lab.test.js checks the floor
     is not claiming better than the registered evaluation. */
  var MODEL_FLOOR_BAND        = 0.05;
  var MODEL_FLOOR_UNCERTAINTY = 0.10;
  function uncertaintyFromSample(n, full) {
    var k = Math.max(0, int(n) || 0);
    var f = Math.max(1, int(full) || M.RATING_FULL_SAMPLE);
    return round(clamp(1 - (k >= f ? 1 : k / f), 0, 1), 3);
  }
  function ratingBand(n, full) {
    var k = Math.max(0, int(n) || 0);
    var f = Math.max(1, int(full) || M.RATING_FULL_SAMPLE);
    /* 1/sqrt(n) shaped, floored, so 4 matches is visibly wider than 40 and
       400 is not claimed to be twice as certain as 100. */
    var band = BAND_AT_ZERO / Math.sqrt(Math.max(1, k));
    if (k >= f) band = Math.min(band, BAND_AT_ZERO / Math.sqrt(f));
    return round(Math.max(BAND_FLOOR, band), 2);
  }

  /* ───────────────────────────── SURFACE TRANSLATOR ───────────────────────
     How much better or worse is this player on a surface than their own
     baseline? Not "who is best on clay" — that is the leaderboard — but "does
     clay SUIT this player relative to how good they are generally".

     The raw answer is surface_elo - overall_elo. The raw answer is also
     garbage for a player with six clay matches, whose surface Elo has barely
     moved off its seed. So the difference is shrunk toward zero by the surface
     sample, and the un-shrunk number is returned beside it as `raw_delta` so
     nothing is hidden — a reader can see both what the record says and what
     EdgeDesk is willing to claim from it. */
  var SURFACE_FULL_SAMPLE = 25;   // surface matches at which no shrink is applied
  var SURFACE_KEYS = ['hard', 'clay', 'grass', 'carpet'];

  function surfaceTranslation(rating, opts) {
    opts = opts || {};
    var full = Math.max(1, int(opts.full_sample) || SURFACE_FULL_SAMPLE);
    var base = num(rating && rating.elo);
    var out = {
      lab_version: LAB_VERSION,
      baseline_elo: base,
      baseline_sample: int(rating && rating.elo_sample) || 0,
      surfaces: {},
      best: null, worst: null, versatility: null,
      missing: []
    };
    if (base == null) {
      out.missing.push('overall_elo');
      return out;
    }
    var deltas = [];
    SURFACE_KEYS.forEach(function (s) {
      var e = num(rating && rating[s + '_elo']);
      var n = int(rating && rating[s + '_sample']) || 0;
      if (e == null) {
        out.surfaces[s] = { surface: s, elo: null, sample: n, raw_delta: null,
                            adjustment: null, band: null, uncertainty: 1,
                            known: false, note: 'no rated match on this surface' };
        out.missing.push(s + '_elo');
        return;
      }
      var raw = e - base;
      var trust = n >= full ? 1 : n / full;
      var adj = raw * trust;
      var rec = {
        surface: s,
        elo: round(e, 1),
        sample: n,
        raw_delta: round(raw, 1),
        adjustment: round(adj, 1),
        band: ratingBand(n, full),
        uncertainty: uncertaintyFromSample(n, full),
        known: n > 0,
        note: n === 0 ? 'no rated match on this surface'
            : n < full ? ('thin sample: ' + n + ' of ' + full + ' matches, shrunk toward the player baseline')
            : null
      };
      out.surfaces[s] = rec;
      /* Only surfaces with a real sample compete for best/worst. A player with
         one grass win is not "a grass specialist". */
      if (n >= Math.ceil(full / 5)) deltas.push(rec);
    });

    if (deltas.length) {
      deltas.sort(function (a, b) { return b.adjustment - a.adjustment; });
      out.best = deltas[0];
      out.worst = deltas[deltas.length - 1];
      /* Versatility: how little the player's strength moves across surfaces
         they have actually played. Lower spread = more versatile. */
      var spread = deltas.length > 1 ? (deltas[0].adjustment - deltas[deltas.length - 1].adjustment) : null;
      out.versatility = spread == null ? null : {
        spread: round(spread, 1),
        label: spread < 25 ? 'Versatile' : spread < 60 ? 'Balanced' : 'Surface-dependent',
        surfaces_counted: deltas.length
      };
    }
    return out;
  }

  /* ────────────────────────── FORM AND TRAJECTORY LAB ─────────────────────
     Is this player improving, declining or stable — and is the recent record
     supported by anything underneath it?

     THE RULE THAT MAKES THIS NON-TRIVIAL. A winning streak against weak
     opponents is not the same evidence as one against elite competition, and a
     product that ranks them together is actively misleading. So form is always
     read next to `sos_elo` (the average strength of who was actually played)
     and a 30-day surge over a soft schedule is classified as
     `above_sustainable`, not `improving`.

     Classes, and what each one means:
       improving           short-horizon form clearly above the long horizon,
                           against a schedule that is not softer
       declining           short-horizon form clearly below the long horizon
       stable              the horizons agree within noise
       returning           a long gap since the last match; the record on file
                           predates an absence and may not describe the player
       above_sustainable   form is up but the schedule got easier — the record
                           is real, the inference from it is not
       below_ability       form is down but the schedule got harder — the
                           losses may say more about the draw than the player
       unknown             not enough on file to say anything */
  var TRAJECTORY_FULL = 12;        // matches in 365d before a class is asserted
  var RETURNING_DAYS  = 120;       // inactivity that invalidates recent form
  var FORM_DELTA      = 0.08;      // win-rate gap that counts as a real move
  var SOS_DELTA       = 25;        // Elo of schedule change that counts as real

  function trajectory(rating, opts) {
    opts = opts || {};
    var f30 = num(rating && rating.form_30d);
    var f90 = num(rating && rating.form_90d);
    var f365 = num(rating && rating.form_365d);
    var n365 = int(rating && rating.form_sample_365d) || 0;
    var idle = int(rating && rating.days_since_last_match);
    var sosRecent = num(rating && rating.sos_elo_recent);
    var sosCareer = num(rating && rating.sos_elo_career);

    var out = {
      lab_version: LAB_VERSION,
      klass: 'unknown', label: 'Unknown', direction: 0,
      form_30d: f30, form_90d: f90, form_365d: f365,
      sample_365d: n365,
      days_since_last_match: idle,
      schedule_shift: null,
      confidence: 'low',
      missing: [],
      why: []
    };
    if (f30 == null) out.missing.push('form_30d');
    if (f90 == null) out.missing.push('form_90d');
    if (f365 == null) out.missing.push('form_365d');
    if (sosRecent == null || sosCareer == null) out.missing.push('strength_of_schedule');

    /* Inactivity beats everything: a player who has not hit a ball in four
       months has a record, not a current form. Saying "declining" about them
       would be a claim EdgeDesk cannot support. */
    if (idle != null && idle >= RETURNING_DAYS) {
      out.klass = 'returning';
      out.label = 'Returning from inactivity';
      out.confidence = 'low';
      out.why.push('No match on file for ' + idle + ' days. Recent-form numbers describe the record before that gap, not the player today.');
      return out;
    }

    if (n365 < TRAJECTORY_FULL || f90 == null || f365 == null) {
      out.why.push(n365 < TRAJECTORY_FULL
        ? ('Only ' + n365 + ' matches in the last 365 days; EdgeDesk needs ' + TRAJECTORY_FULL + ' before calling a direction.')
        : 'Form horizons are not both on file.');
      return out;
    }

    /* Did the schedule get easier or harder? This is the check that stops a
       soft-draw streak from reading as improvement. */
    if (sosRecent != null && sosCareer != null) {
      var shift = sosRecent - sosCareer;
      out.schedule_shift = {
        delta: round(shift, 1),
        label: shift > SOS_DELTA ? 'harder' : shift < -SOS_DELTA ? 'easier' : 'comparable'
      };
    }
    var easier = out.schedule_shift && out.schedule_shift.label === 'easier';
    var harder = out.schedule_shift && out.schedule_shift.label === 'harder';

    var short = f30 != null ? f30 : f90;
    var delta = short - f365;
    out.direction = Math.abs(delta) < FORM_DELTA ? 0 : (delta > 0 ? 1 : -1);

    if (out.direction > 0 && easier) {
      out.klass = 'above_sustainable';
      out.label = 'Winning, but against a softer draw';
      out.why.push('Recent win rate is ' + pct(short) + ' against ' + pct(f365) + ' over the year, but the average opponent has been '
                 + Math.abs(out.schedule_shift.delta) + ' Elo weaker. The results are real; the improvement may not be.');
    } else if (out.direction < 0 && harder) {
      out.klass = 'below_ability';
      out.label = 'Losing, but against a harder draw';
      out.why.push('Recent win rate is ' + pct(short) + ' against ' + pct(f365) + ' over the year, but the average opponent has been '
                 + Math.abs(out.schedule_shift.delta) + ' Elo stronger. The draw explains part of this.');
    } else if (out.direction > 0) {
      out.klass = 'improving'; out.label = 'Improving';
      out.why.push('Recent win rate ' + pct(short) + ' against ' + pct(f365) + ' over the year, on a comparable or harder schedule.');
    } else if (out.direction < 0) {
      out.klass = 'declining'; out.label = 'Declining';
      out.why.push('Recent win rate ' + pct(short) + ' against ' + pct(f365) + ' over the year, on a comparable or easier schedule.');
    } else {
      out.klass = 'stable'; out.label = 'Stable';
      out.why.push('Recent and long-horizon win rates agree within ' + Math.round(FORM_DELTA * 100) + ' points.');
    }
    out.confidence = n365 >= 30 ? 'high' : n365 >= TRAJECTORY_FULL ? 'medium' : 'low';
    return out;
  }
  function pct(v) { return v == null ? '—' : Math.round(v * 100) + '%'; }

  /* ───────────────────────── SCHEDULE AND FATIGUE LAB ─────────────────────
     Workload classification from documented thresholds.

     WHAT THIS IS NOT. It is not an injury report, it is not a fitness claim,
     and it never says a player is hurt. EdgeDesk has no medical information
     about anyone and inventing it would be the single most harmful thing this
     product could do. A heavy workload is a SCHEDULING observation: this
     player has played a lot of tennis recently, which is a thing a researcher
     may want to weigh. Nothing more. The labels are deliberately about the
     calendar ("Heavy") and not the body ("Tired", "At risk"). */
  var WORKLOAD_RULES = [
    { klass: 'heavy',    label: 'Heavy',    m7_min: 5, note: 'five or more matches in seven days' },
    { klass: 'heavy',    label: 'Heavy',    m14_min: 9, note: 'nine or more matches in fourteen days' },
    { klass: 'elevated', label: 'Elevated', m7_min: 4, note: 'four matches in seven days' },
    { klass: 'elevated', label: 'Elevated', m14_min: 7, note: 'seven or more matches in fourteen days' },
    { klass: 'fresh',    label: 'Fresh',    rest_min: 7, note: 'seven or more days since the last match' },
    { klass: 'normal',   label: 'Normal',   note: 'a routine tour schedule' }
  ];

  function workload(rating, opts) {
    opts = opts || {};
    var m7 = int(rating && rating.matches_7d);
    var m14 = int(rating && rating.matches_14d);
    var rest = int(rating && rating.rest_days);
    var idle = int(rating && rating.days_since_last_match);
    var out = {
      lab_version: LAB_VERSION,
      klass: 'unknown', label: 'Unknown',
      matches_7d: m7, matches_14d: m14, rest_days: rest,
      days_since_last_match: idle,
      rule: null, missing: [], why: [],
      is_injury_claim: false
    };
    if (m7 == null) out.missing.push('matches_7d');
    if (m14 == null) out.missing.push('matches_14d');
    if (rest == null) out.missing.push('rest_days');

    /* A NEGATIVE REST IS NOT A REST — it is a record containing a match dated
       after today, which the archive can produce because its dates are
       tournament-week precise rather than match-exact.

       ONLY THE REST FIGURE IS DISCARDED. An earlier version of this rule
       returned `unknown` outright, and in doing so threw away a perfectly good
       classification: a player with five matches in the last seven days has an
       observable workload whether or not the exact date of the latest one is
       reliable. Suppressing that made the entire fatigue board empty — the
       players with the heaviest schedules were precisely the ones mid-event,
       and therefore precisely the ones whose last match was forward-dated.

       So the rest is nulled, the issue is named, and the match counts still
       classify. */
    if (rest != null && rest < 0) {
      out.rest_days = null;
      rest = null;
      out.missing.push('rest_days');
      out.data_quality = [{ signal: 'future_dated_match', severity: 'medium',
        detail: 'The most recent match on file for this player is dated in the future. '
              + 'The archive dates matches to the tournament week, so an event in progress '
              + 'can look forward-dated. Rest days are reported as unknown rather than as a '
              + 'negative number; the match counts below are unaffected.' }];
      out.why.push(out.data_quality[0].detail);
    }

    /* Unknown is a real answer and is reported as one. Guessing "Normal" from
       missing data would be the silent-zero mistake in a different costume. */
    if (m7 == null && m14 == null && rest == null) {
      out.why.push('No recent-schedule data on file for this player.');
      return out;
    }
    /* A long absence is not a light workload — it is a different state, and
       calling it "Fresh" would imply a readiness EdgeDesk cannot observe. */
    if (idle != null && idle >= RETURNING_DAYS) {
      out.klass = 'unknown'; out.label = 'Unknown (inactive)';
      out.why.push('No match for ' + idle + ' days. Workload signals describe a player in competition; this one has not been.');
      return out;
    }
    for (var i = 0; i < WORKLOAD_RULES.length; i++) {
      var r = WORKLOAD_RULES[i];
      var hit = (r.m7_min != null && m7 != null && m7 >= r.m7_min)
             || (r.m14_min != null && m14 != null && m14 >= r.m14_min)
             || (r.rest_min != null && rest != null && rest >= r.rest_min)
             || (r.m7_min == null && r.m14_min == null && r.rest_min == null);
      if (hit) {
        out.klass = r.klass; out.label = r.label; out.rule = r.note;
        out.why.push('Classified ' + r.label + ': ' + r.note + '.');
        break;
      }
    }
    if (out.klass === 'heavy' || out.klass === 'elevated') {
      out.why.push('This is a schedule observation, not an injury or fitness report. EdgeDesk carries no medical information.');
    }
    return out;
  }

  /* ──────────────────────────── MATCHUP PROJECTION ────────────────────────
     A against B on a surface. The product's centrepiece, and the place where
     it would be easiest to publish false precision.

     HOW THE NUMBER IS MADE. The trained model is a logistic over feature
     DIFFERENCES (lib/tennis_model.js owns it). This function assembles the two
     players' point-in-time inputs into that difference vector, asks the model,
     and then does the three things a bare probability cannot:

       1. ATTRIBUTES it. Each feature's contribution is coefficient x
          difference, so the page can say "surface Elo is doing most of the
          work here" rather than showing an unexplained 0.63.
       2. WIDENS it. Missing inputs and thin samples pull the estimate toward
          50/50 — not by fudging the probability, but by publishing an explicit
          uncertainty and a band, and by refusing to present a confident number
          built on two absent features.
       3. NAMES what is missing, on the card, every time.

     POINT-IN-TIME SAFETY. `as_of` is honoured by the CALLER, which must supply
     ratings computed from matches strictly before that date. This function
     never reaches for data itself; it is pure. tools/tennis/matchup.test.js
     proves the cutoff path by feeding it two different as-of snapshots of the
     same pair and checking the projection moves only in the ways the earlier
     record allows. */
  function projectMatchup(a, b, ctx) {
    ctx = ctx || {};
    var surface = M.normSurface(ctx.surface) || null;
    var env = M.normEnvironment(ctx.environment) || null;
    var bestOf = int(ctx.best_of) === 5 ? 5 : int(ctx.best_of) === 3 ? 3 : null;
    var level = str(ctx.level) || null;
    var coef = (ctx.model && ctx.model.coefficients) || M.SEED_MODEL.coefficients;
    var intercept = num(ctx.model && ctx.model.intercept);
    if (intercept == null) intercept = num(M.SEED_MODEL.intercept) || 0;
    var modelVersion = str(ctx.model && ctx.model.model_version) || M.SEED_MODEL.model_version || M.VERSION;

    var out = {
      lab_version: LAB_VERSION,
      model_version: modelVersion,
      feature_version: (ctx.model && ctx.model.feature_version) || M.FEATURE_VERSION,
      as_of: str(ctx.as_of) || null,
      surface: surface, environment: env, best_of: bestOf, level: level,
      player_a: { player_id: a && a.player_id, name: a && a.full_name },
      player_b: { player_id: b && b.player_id, name: b && b.full_name },
      prob_a: null, prob_b: null,
      drivers: [], missing: [], uncertainty: 1, band: null,
      stability: 'unknown', method: null, why: []
    };
    if (!a || !b) { out.missing.push('player'); out.why.push('Both players must be supplied.'); return out; }
    if (a.player_id && b.player_id && a.player_id === b.player_id) {
      out.missing.push('distinct_players');
      out.why.push('A player cannot be projected against themselves.');
      return out;
    }
    if (a.tour && b.tour && a.tour !== b.tour) {
      out.missing.push('same_tour');
      out.why.push('ATP and WTA players are rated on separate scales and are not comparable. EdgeDesk will not project across tours.');
      return out;
    }

    /* Assemble the two sides' point-in-time inputs and hand them to the MODEL'S
       OWN feature builder.

       WHY THIS DELEGATES RATHER THAN COMPUTING THE DIFFERENCES HERE. The
       scaling in that vector is not cosmetic — d_elo is divided by 100, rest is
       capped at fourteen days before it is differenced, surface experience is
       shrunk toward 50% by a 30-match prior, and elo_x_bo5 is an interaction.
       A second implementation of that arithmetic would drift from the one the
       coefficients were FITTED on, and the studio would quietly disagree with
       the model's own evaluation. So there is one featureVector, in
       lib/tennis_model.js, and this file converts ratings into its input shape
       and reads its output. lab.test.js asserts the two files agree on the
       feature names. */
    var sa = sideInputs(a, surface), sb = sideInputs(b, surface);
    var fv = M.featureVector(sa, sb, { best_of: bestOf, level: level });
    out.missing = fv.missing.slice();
    out.completeness = fv.completeness;

    /* How much of the model's weight actually has data behind it? Counting
       missing FEATURES would treat a coefficient of 0.62 and one of 0.04 as
       equally damaging; counting missing WEIGHT says what a reader needs — how
       much of the reasoning is running blind. */
    var usable = 0, total = 0, absentSet = {};
    fv.missing.forEach(function (n) { absentSet[n] = 1; });
    fv.names.forEach(function (n) {
      var w = Math.abs(num(coef[n]) || 0);
      total += w;
      if (!absentSet[n]) usable += w;
    });
    var coverage = total > 0 ? usable / total : 0;
    out.coverage = round(coverage, 3);

    if (coverage < 0.25) {
      out.why.push('Too little is known about this pair to project a match: only '
                 + Math.round(coverage * 100) + '% of the model’s weight has data behind it.');
      out.method = 'declined';
      out.uncertainty = 1;
      return out;
    }

    /* The model. A missing difference enters as zero, which for a DIFFERENCE
       model is the correct encoding of "no evidence either way" — it is not the
       silent-zero mistake, which would be imputing zero into a LEVEL (claiming
       a player never lands a first serve). featureVector records every such
       feature in `missing`, and this card prints that list. */
    var p = clamp(M.predict(ctx.model || null, fv), 0.02, 0.98);
    out.method = 'model';

    var contribs = [];
    fv.names.forEach(function (n, idx) {
      if (absentSet[n]) return;                     // no data: not a driver
      var c = num(coef[n]) || 0;
      var v = num(fv.values[idx]);
      if (v == null || !isFinite(v)) return;
      var part = c * v;
      if (Math.abs(part) <= 1e-9) return;
      contribs.push({ feature: n, label: featureLabel(n), group: featureGroup(n),
                      a: sa[FEATURE_SOURCE[n]] != null ? sa[FEATURE_SOURCE[n]] : null,
                      b: sb[FEATURE_SOURCE[n]] != null ? sb[FEATURE_SOURCE[n]] : null,
                      difference: round(v, 3), contribution: round(part, 4) });
    });

    /* UNCERTAINTY, AND WHY IT HAS A FLOOR.

       Two sources are easy: how much is missing (`gap`) and how thin the two
       players' records are (`thin`). Both go to zero for two well-sampled
       players with every feature present — and a band of zero would publish
       "92%" as an exact quantity, which is precisely the false precision this
       product exists to refuse.

       There is a third source that never goes to zero: the model is wrong on
       its own test set. It scores a log loss around 0.60 and picks the winner
       about two-thirds of the time. Perfect data about two players does not
       make tennis deterministic. So the band is floored at MODEL_FLOOR_BAND —
       the irreducible error of the estimator itself, not of the inputs — and
       the model card documents where that number comes from. Nothing in the
       lab may publish a projection tighter than the model has earned.

       The uncertainty is PUBLISHED, never baked into the probability. Widening
       the number itself would be a different and unearned claim. */
    var thin = Math.max(
      uncertaintyFromSample(a.rating_sample, M.RATING_FULL_SAMPLE),
      uncertaintyFromSample(b.rating_sample, M.RATING_FULL_SAMPLE)
    );
    var gap = 1 - coverage;
    var dataUncertainty = clamp(0.55 * thin + 0.45 * gap, 0, 1);
    out.data_uncertainty = round(dataUncertainty, 3);
    out.model_floor_band = MODEL_FLOOR_BAND;
    /* The published uncertainty carries the floor too, so a card that reads
       "0% uncertainty" can never be rendered from a real projection. */
    out.uncertainty = round(clamp(Math.max(dataUncertainty, MODEL_FLOOR_UNCERTAINTY), 0, 1), 3);
    out.band = round(clamp(Math.max(0.5 * dataUncertainty, MODEL_FLOOR_BAND), MODEL_FLOOR_BAND, 0.35), 3);
    out.prob_a = round(p, 4);
    out.prob_b = round(1 - p, 4);

    /* Stability: would the answer survive its own uncertainty? If the band
       crosses 50%, the lean is not a finding. */
    var lo = p - out.band, hi = p + out.band;
    out.stability = (lo > 0.5 || hi < 0.5) ? 'stable' : 'unstable';
    out.crosses_even = !(lo > 0.5 || hi < 0.5);

    contribs.sort(function (x, y) { return Math.abs(y.contribution) - Math.abs(x.contribution); });
    out.drivers = contribs.slice(0, 8);

    /* Prose. Deliberately in the vocabulary the brief demands: projects,
       estimates, leans. Never picks, locks or winners. */
    var favName = p >= 0.5 ? (a.full_name || 'Player A') : (b.full_name || 'Player B');
    var dogName = p >= 0.5 ? (b.full_name || 'Player B') : (a.full_name || 'Player A');
    var favP = p >= 0.5 ? p : 1 - p;
    out.favoured = p >= 0.5 ? 'a' : 'b';
    out.why.push('EdgeDesk projects ' + favName + ' at ' + Math.round(favP * 100) + '%'
               + (surface ? ' on ' + surface : '') + (bestOf ? ', best of ' + bestOf : '') + '.');
    if (out.drivers.length) {
      var top = out.drivers.slice(0, 3).map(function (d) { return d.label; });
      out.why.push('Primary research factors: ' + top.join(', ') + '.');
    }
    out.path = dogName + '’s realistic path: ' + counterPath(out.drivers, p >= 0.5 ? 'b' : 'a', dogName);
    if (out.crosses_even) {
      out.why.push('Reasons for uncertainty: the estimate’s own band crosses even money, so this matchup does not lean reliably either way.');
    }
    if (fv.missing.length) {
      out.why.push('Missing from this projection: ' + fv.missing.map(featureLabel).join(', ') + '.');
    }
    return out;
  }

  /* What would have to be true for the underdog. Reads the drivers that run
     AGAINST the favourite and says so plainly — a research product owes the
     other side of the argument, not just the lean. */
  function counterPath(drivers, side, name) {
    var sign = side === 'a' ? 1 : -1;
    var forDog = drivers.filter(function (d) { return d.contribution * sign > 0; });
    if (!forDog.length) {
      return 'nothing in the model currently favours ' + name + '; the path would have to come from something EdgeDesk does not measure — a style matchup, conditions on the day, or a change since the last rated match.';
    }
    return forDog.slice(0, 3).map(function (d) { return d.label.toLowerCase(); }).join(', ')
         + ' already favour ' + name + '; the projection turns if those outweigh the gap in the factors above.';
  }

  /* HOW A MODEL FEATURE IS SHOWN TO A HUMAN.

     The model's feature names are the contract (lib/tennis_model.js owns them).
     These are only the labels and groupings the studio prints beside them, plus
     which input field a driver row should quote back. Keyed on the model's own
     names so a retrain that changes the vector fails loudly in lab.test.js
     rather than silently rendering a driver called "d_sos". */
  var FEATURE_META = {
    d_elo:               { label: 'Overall Elo',            group: 'strength', src: 'elo_pre' },
    d_surface_elo:       { label: 'Surface Elo',            group: 'surface',  src: 'surface_elo_pre' },
    d_rank_log:          { label: 'Official ranking',       group: 'strength', src: 'rank_pre' },
    d_rank_points_log:   { label: 'Ranking points',         group: 'strength', src: 'rank_points_pre' },
    d_form_90:           { label: '90-day form',            group: 'form',     src: 'win_pct_90d_pre' },
    d_form_365:          { label: '365-day form',           group: 'form',     src: 'win_pct_365d_pre' },
    d_rest:              { label: 'Rest days',              group: 'workload', src: 'rest_days_pre' },
    d_workload_14d:      { label: 'Matches in 14 days',     group: 'workload', src: 'matches_14d_pre' },
    d_surface_experience: { label: 'Surface experience',    group: 'surface',  src: 'career_surface_matches_pre' },
    d_age:               { label: 'Age',                    group: 'context',  src: 'age_pre' },
    d_serve_strength:    { label: 'Serve strength',         group: 'serve',    src: 'serve_strength_pre' },
    d_return_strength:   { label: 'Return pressure',        group: 'return',   src: 'return_strength_pre' },
    d_sos:               { label: 'Strength of schedule',   group: 'context',  src: 'sos_elo_pre' },
    best_of_5:           { label: 'Best-of-five format',    group: 'format',   src: null },
    level_weight:        { label: 'Tournament level',       group: 'format',   src: null },
    elo_x_bo5:           { label: 'Elo edge over five sets', group: 'format',  src: 'elo_pre' }
  };
  var FEATURE_SOURCE = (function () {
    var m = {};
    Object.keys(FEATURE_META).forEach(function (k) { m[k] = FEATURE_META[k].src; });
    return m;
  })();
  function featureLabel(name) { return (FEATURE_META[name] && FEATURE_META[name].label) || name; }
  function featureGroup(name) { return (FEATURE_META[name] && FEATURE_META[name].group) || 'other'; }

  /* A CURRENT RATING ROW -> THE POINT-IN-TIME SHAPE featureVector EXPECTS.

     The model was fitted on `tennis.player_match_features`, whose columns end
     in `_pre` because every one of them was true BEFORE the match it describes.
     A live matchup has no such row — the match has not been played — so the
     studio builds the equivalent from the player's CURRENT rating, which is
     itself computed only from completed matches. The naming is kept identical
     so the two paths cannot be confused, and so a reviewer reading either one
     sees the same contract: everything here is knowable before the first ball.

     Null stays null the whole way down. `surface_elo_pre` falls back to overall
     Elo when the surface is unspecified — that is the same surface-agnostic
     question, not a guess at a surface the player has never played. When a
     surface IS specified and the player has no rating on it, the value stays
     null and the feature is reported missing. */
  function sideInputs(p, surface) {
    p = p || {};
    var s = surface && surface !== 'unknown' ? surface : null;
    var sElo = s ? num(p[s + '_elo']) : null;
    var rank = M.plausibleRank(p.official_rank);
    return {
      elo_pre:                    num(p.elo),
      surface_elo_pre:            s ? sElo : num(p.elo),
      win_pct_30d_pre:            num(p.form_30d),
      win_pct_90d_pre:            num(p.form_90d),
      win_pct_365d_pre:           num(p.form_365d),
      matches_7d_pre:             int(p.matches_7d),
      matches_14d_pre:            int(p.matches_14d),
      rest_days_pre:              int(p.rest_days),
      career_surface_win_pct_pre: s ? num(p[s + '_win_pct']) : null,
      career_surface_matches_pre: s ? int(p[s + '_sample']) : null,
      rank_pre:                   rank,
      rank_points_pre:            num(p.official_rank_points),
      age_pre:                    M.plausibleAge(p.latest_age),
      serve_strength_pre:         num(p.serve_strength),
      return_strength_pre:        num(p.return_strength),
      sos_elo_pre:                num(p.sos_elo_recent) != null ? num(p.sos_elo_recent) : num(p.sos_elo_career)
    };
  }

  /* ─────────────────────────── COMPARISON CARD ────────────────────────────
     Two players, side by side, on the dimensions that decide matches. Pure
     presentation of what is on file — no projection, no lean. */
  var COMPARE_ROWS = [
    { key: 'power_rating',   label: 'EdgeDesk power rating', fmt: 'num1',  better: 'high' },
    { key: 'surface_rating', label: 'Surface rating',        fmt: 'num1',  better: 'high' },
    { key: 'official_rank',  label: 'Official ranking',      fmt: 'rank',  better: 'low'  },
    { key: 'form_90d',       label: 'Recent form (90d)',     fmt: 'pct',   better: 'high' },
    { key: 'serve_strength', label: 'Serve strength',        fmt: 'pct',   better: 'high' },
    { key: 'return_strength', label: 'Return pressure',      fmt: 'pct',   better: 'high' },
    { key: 'rest_days',      label: 'Rest days',             fmt: 'int',   better: 'high' },
    { key: 'matches_14d',    label: 'Matches in 14 days',    fmt: 'int',   better: 'none' },
    { key: 'surface_matches', label: 'Surface experience',   fmt: 'int',   better: 'high' },
    { key: 'sos_elo_recent', label: 'Strength of schedule',  fmt: 'num0',  better: 'high' },
    { key: 'matches_on_file', label: 'Career matches',       fmt: 'int',   better: 'high' },
    { key: 'uncertainty',    label: 'Uncertainty',           fmt: 'pct',   better: 'low'  }
  ];

  function compareCard(a, b, opts) {
    opts = opts || {};
    var surface = M.normSurface(opts.surface) || null;
    function val(p, key) {
      if (key === 'surface_rating') return surface ? num(p[surface + '_elo']) : null;
      if (key === 'surface_matches') return surface ? int(p[surface + '_sample']) : null;
      return num(p[key]);
    }
    var rows = COMPARE_ROWS.map(function (r) {
      var va = val(a, r.key), vb = val(b, r.key);
      var edge = null;
      if (va != null && vb != null && r.better !== 'none' && va !== vb) {
        edge = (r.better === 'high') === (va > vb) ? 'a' : 'b';
      }
      return { key: r.key, label: r.label, fmt: r.fmt,
               a: va, b: vb, edge: edge,
               missing: (va == null ? ['a'] : []).concat(vb == null ? ['b'] : []) };
    });
    var counted = rows.filter(function (r) { return r.edge; });
    return {
      lab_version: LAB_VERSION,
      surface: surface,
      player_a: { player_id: a.player_id, name: a.full_name, country: a.country, tour: a.tour },
      player_b: { player_id: b.player_id, name: b.full_name, country: b.country, tour: b.tour },
      rows: rows,
      edges_a: counted.filter(function (r) { return r.edge === 'a'; }).length,
      edges_b: counted.filter(function (r) { return r.edge === 'b'; }).length,
      rows_missing: rows.filter(function (r) { return r.missing.length; }).map(function (r) { return r.label; }),
      note: 'Counts of category edges are a summary of what is on file. They are not a projection and do not sum to a win probability.'
    };
  }

  /* ───────────────────────── HISTORICAL COMPARABLES ───────────────────────
     Which past matches resemble this one? Similarity over the dimensions that
     make a matchup what it is — the Elo gap, the surface, the format, the
     level — never over the result, which is what makes them evidence. */
  function comparability(target, past) {
    var t = target || {}, p = past || {};
    var score = 0, max = 0, why = [];
    function part(w, ok, label) {
      max += w; if (ok) { score += w; why.push(label); }
    }
    var tGap = num(t.elo_gap), pGap = num(p.elo_gap);
    max += 40;
    if (tGap != null && pGap != null) {
      var close = Math.max(0, 1 - Math.abs(tGap - pGap) / 250);
      score += 40 * close;
      if (close > 0.6) why.push('similar rating gap');
    }
    part(25, t.surface && p.surface && t.surface === p.surface, 'same surface');
    part(15, t.best_of && p.best_of && t.best_of === p.best_of, 'same format');
    part(10, t.level && p.level && t.level === p.level, 'same tournament level');
    part(10, t.environment && p.environment && t.environment === p.environment, 'same environment');
    return { score: round(max > 0 ? score / max : 0, 3), reasons: why };
  }

  /* ──────────────────────── RESEARCH BRIEF (NO ODDS) ──────────────────────
     The daily brief must produce something useful with no schedule, no odds
     and no live feed. So it is built in tiers and always lands somewhere:

       scheduled  verified upcoming matches exist -> matches worth researching
       trends     no schedule, but ratings moved -> player trends and model watch
       historical neither -> surface notes and record-level research

     It NEVER invents a fixture. If no verified schedule is on file the brief
     says so in its own header rather than quietly presenting a trend brief as
     a preview of today's play. */
  var BRIEF_SECTIONS = [
    { key: 'matches',     title: 'Matches worth researching' },
    { key: 'trends',      title: 'Player trends' },
    { key: 'surface',     title: 'Surface notes' },
    { key: 'schedule',    title: 'Schedule and fatigue' },
    { key: 'model',       title: 'Model watch' },
    { key: 'uncertainty', title: 'Uncertainty watch' }
  ];

  function briefTier(input) {
    var i = input || {};
    if ((i.scheduled_matches || []).length) return 'scheduled';
    if ((i.movers || []).length || (i.rank_gaps || []).length) return 'trends';
    return 'historical';
  }

  function buildBrief(input, opts) {
    opts = opts || {};
    var i = input || {};
    var tier = briefTier(i);
    var sections = [];
    var note = null;

    if (tier === 'scheduled') {
      sections.push({ key: 'matches', title: 'Matches worth researching',
        items: (i.scheduled_matches || []).slice(0, 8).map(function (m) {
          return { headline: m.player_a_name + ' v ' + m.player_b_name,
                   detail: briefMatchDetail(m), match_ref: m.match_ref,
                   surface: m.surface, starts_at: m.scheduled_at };
        }) });
    } else {
      note = 'No verified schedule is on file, so this is a record and trend brief rather than a preview of upcoming play. '
           + 'EdgeDesk does not invent fixtures.';
    }

    if ((i.movers || []).length) {
      sections.push({ key: 'trends', title: 'Player trends',
        items: (i.movers || []).slice(0, 8).map(function (p) {
          return { headline: p.full_name + ' ' + (p.delta > 0 ? 'up' : 'down') + ' ' + Math.abs(round(p.delta, 1)) + ' rating points',
                   detail: (p.window_days || 30) + '-day move, ' + (p.sample || 0) + ' matches on file, uncertainty '
                         + Math.round((num(p.uncertainty) || 0) * 100) + '%.',
                   player_id: p.player_id };
        }) });
    }
    if ((i.surface_notes || []).length) {
      sections.push({ key: 'surface', title: 'Surface notes',
        items: (i.surface_notes || []).slice(0, 6).map(function (s) {
          return { headline: s.full_name + ': ' + (s.adjustment > 0 ? '+' : '') + round(s.adjustment, 1) + ' on ' + s.surface,
                   detail: s.sample + ' rated matches on this surface. '
                         + (s.adjustment > 0 ? 'Stronger' : 'Weaker') + ' than their own baseline.',
                   player_id: s.player_id };
        }) });
    }
    if ((i.fatigue || []).length) {
      sections.push({ key: 'schedule', title: 'Schedule and fatigue',
        items: (i.fatigue || []).slice(0, 6).map(function (p) {
          return { headline: p.full_name + ' — ' + (p.workload_label || 'Unknown'),
                   detail: (p.matches_7d == null ? 'matches in 7 days unknown' : p.matches_7d + ' matches in 7 days')
                         + ', ' + (p.matches_14d == null ? 'unknown in 14' : p.matches_14d + ' in 14')
                         + '. A schedule observation, not an injury report.',
                   player_id: p.player_id };
        }) });
    }
    if ((i.rank_gaps || []).length) {
      sections.push({ key: 'model', title: 'Model watch',
        items: (i.rank_gaps || []).slice(0, 6).map(function (p) {
          return { headline: p.full_name + ': ranked ' + (p.official_rank == null ? '—' : '#' + p.official_rank)
                           + ', EdgeDesk ' + round(p.power_rating, 1),
                   detail: 'EdgeDesk rates this player ' + (p.gap > 0 ? 'above' : 'below') + ' their official ranking. '
                         + 'Ranking rewards a 52-week points cycle; the rating reads the matches.',
                   player_id: p.player_id };
        }) });
    }
    if ((i.uncertain || []).length) {
      sections.push({ key: 'uncertainty', title: 'Uncertainty watch',
        items: (i.uncertain || []).slice(0, 6).map(function (p) {
          return { headline: p.full_name + ' — ' + Math.round((num(p.uncertainty) || 0) * 100) + '% uncertainty',
                   detail: (p.rating_sample || 0) + ' rated matches on file'
                         + (p.days_since_last_match != null ? ', last match ' + p.days_since_last_match + ' days ago' : '')
                         + '. Read this player’s numbers with the sample in view.',
                   player_id: p.player_id };
        }) });
    }

    return {
      brief_version: BRIEF_VERSION,
      lab_version: LAB_VERSION,
      tour: str(i.tour) || null,
      tier: tier,
      generated_at: str(opts.now) || null,
      data_through: str(i.data_through) || null,
      model_version: str(i.model_version) || null,
      note: note,
      sections: sections.filter(function (s) { return (s.items || []).length; }),
      /* Named so nothing downstream can mistake this for a selection feed. */
      contains_selections: false,
      contains_odds: false
    };
  }
  function briefMatchDetail(m) {
    var bits = [];
    if (m.surface) bits.push(m.surface);
    if (m.best_of) bits.push('best of ' + m.best_of);
    if (m.level) bits.push(M.levelLabel(m.level));
    if (m.prob_a != null) bits.push('EdgeDesk projects ' + Math.round(m.prob_a * 100) + '% / ' + Math.round((1 - m.prob_a) * 100) + '%');
    return bits.join(' · ') || 'Research this matchup in the studio.';
  }

  /* ──────────────────────────── data-quality signals ──────────────────────
     Every surface in the lab shows these. Declared once so "stale" means the
     same number of hours everywhere. */
  var FRESHNESS = { fresh_hours: 36, stale_hours: 168 };
  function freshness(computedAt, now) {
    var t = computedAt ? Date.parse(computedAt) : NaN;
    if (!isFinite(t)) return { state: 'unknown', hours: null, label: 'Freshness unknown' };
    var n = now ? Date.parse(now) : Date.now();
    var h = (n - t) / 3600000;
    var state = h <= FRESHNESS.fresh_hours ? 'fresh' : h <= FRESHNESS.stale_hours ? 'aging' : 'stale';
    return { state: state, hours: round(h, 1),
             label: state === 'fresh' ? 'Current' : state === 'aging' ? 'Aging' : 'Stale' };
  }

  /* The data-quality signals the brief requires be tracked and shown. */
  var QUALITY_SIGNALS = [
    'sample_size', 'missing_ranking', 'missing_surface', 'missing_serve_stats',
    'uncertain_venue', 'weather_unavailable', 'inactive', 'low_surface_experience',
    'stale_source', 'conflicting_identity', 'partial_2026_coverage'
  ];
  function qualitySignals(p, opts) {
    opts = opts || {};
    var out = [];
    var n = int(p && p.rating_sample) || 0;
    if (n < M.RATING_FULL_SAMPLE) out.push({ signal: 'sample_size', severity: n < 10 ? 'high' : 'medium',
      detail: n + ' rated matches on file; ' + M.RATING_FULL_SAMPLE + ' before the rating is fully trusted.' });
    if (num(p && p.official_rank) == null) out.push({ signal: 'missing_ranking', severity: 'low',
      detail: 'No official ranking on file for this player.' });
    var surf = str(opts.surface);
    if (surf && int(p && p[surf + '_sample']) === 0) out.push({ signal: 'low_surface_experience', severity: 'high',
      detail: 'No rated match on ' + surf + '.' });
    if (num(p && p.serve_strength) == null) out.push({ signal: 'missing_serve_stats', severity: 'medium',
      detail: 'No serve statistics on file. The archive carries them only for part of its range.' });
    var idle = int(p && p.days_since_last_match);
    if (idle != null && idle >= RETURNING_DAYS) out.push({ signal: 'inactive', severity: 'high',
      detail: 'No match for ' + idle + ' days.' });
    if (int(p && p.season) === 2026 || opts.partial_season) out.push({ signal: 'partial_2026_coverage', severity: 'low',
      detail: 'The 2026 season is partial in this archive; season totals are incomplete by construction.' });
    return out;
  }

  return {
    VERSION: VERSION,
    LAB_VERSION: LAB_VERSION,
    BRIEF_VERSION: BRIEF_VERSION,
    LAB_MODES: LAB_MODES, labMode: labMode,
    POWER_SCALE: POWER_SCALE, powerBand: powerBand,
    SURFACE_KEYS: SURFACE_KEYS, SURFACE_FULL_SAMPLE: SURFACE_FULL_SAMPLE,
    TRAJECTORY_FULL: TRAJECTORY_FULL, RETURNING_DAYS: RETURNING_DAYS,
    FORM_DELTA: FORM_DELTA, SOS_DELTA: SOS_DELTA,
    WORKLOAD_RULES: WORKLOAD_RULES,
    FEATURE_META: FEATURE_META, featureLabel: featureLabel, featureGroup: featureGroup,
    COMPARE_ROWS: COMPARE_ROWS,
    BRIEF_SECTIONS: BRIEF_SECTIONS,
    FRESHNESS: FRESHNESS, QUALITY_SIGNALS: QUALITY_SIGNALS,
    BAND_AT_ZERO: BAND_AT_ZERO, BAND_FLOOR: BAND_FLOOR,
    MODEL_FLOOR_BAND: MODEL_FLOOR_BAND, MODEL_FLOOR_UNCERTAINTY: MODEL_FLOOR_UNCERTAINTY,
    uncertaintyFromSample: uncertaintyFromSample, ratingBand: ratingBand,
    surfaceTranslation: surfaceTranslation,
    trajectory: trajectory,
    workload: workload,
    projectMatchup: projectMatchup, sideInputs: sideInputs,
    compareCard: compareCard,
    comparability: comparability,
    briefTier: briefTier, buildBrief: buildBrief,
    freshness: freshness, qualitySignals: qualitySignals
  };
});
