/* ============================================================================
   ONE DEFINITION OF "HOW MUCH DOES EDGEDESK KNOW ABOUT THIS GAME".

   THE BUG THIS FILE CLOSES. A single card was publishing four numbers that
   looked like the same number and were not:

     73%        the engine's information confidence — a WEIGHTED score over
                twelve model inputs, each counted at how well it is known
     48%        the same weighted table over the PRICED measurements — how
                much of what is known the published line actually uses
     11 of 17   the input contract — a COUNT of applicable fields retrieved
     60%        the engine's own internal probe count, a third denominator

   Nothing said they measured different things, so a reader comparing them
   concluded the page was inconsistent. They are consistent; they are four
   different questions, and three of them had no published definition at all.

   So this module is the ONE place any of them is computed or named, and it
   publishes them together with:

     * what each one measures, its denominator, and what it is NOT
     * a FIELD-LEVEL LEDGER: every contract field, its meaning and units, its
       source, when it was observed and when it was retrieved, its freshness
       floor, how its identity was resolved, its state, the engine input it
       feeds, the weight of that input, and THE EXACT NUMBER OF POINTS the
       field is costing the displayed score
     * the fix for each field that is costing points

   THE RULE THIS FILE ENFORCES. A point may only be attributed to one field,
   and every point of the difference between the displayed score and 100 must
   be attributed to some field. `reconciles` is that arithmetic, checked here
   rather than asserted in a comment: if the ledger does not add up, the
   ledger says so instead of the reader discovering it.

   WHAT IT WILL NOT DO. It does not compute a confidence of its own, it does
   not reweight anything, and it cannot raise a score: every number it
   publishes is read out of the engine's own measurements and the contract's
   own states. A field that is STALE, CONFLICTING, FETCH_FAILED or inferred
   is never counted as retrieved, and `verified` is a strictly smaller set
   than `known` for exactly that reason.

   Node and browser (UMD).
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  root.EDConfidence = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var SCHEMA = 'edgedesk_confidence_ledger_v1';

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function r3(x) { return isNum(x) ? Math.round(x * 1000) / 1000 : null; }
  function r2(x) { return isNum(x) ? Math.round(x * 100) / 100 : null; }

  /* --------------------------------------------------------------------
     WHICH CONTRACT FIELD FEEDS WHICH ENGINE INPUT.

     The contract in football/matchup/inputs.js answers "did EdgeDesk go and
     get it". The weight table in params.confidence answers "how much does
     not having it cost". They were never joined, so a reader could see that
     eleven of seventeen fields were filled and had no way to learn that the
     six empty ones were not worth an equal six-seventeenths of the score.

     A field mapped to null feeds no scored input: it is research context or
     a documented gap, and it costs the score nothing. Saying so is the point
     — otherwise a permanently unavailable field reads as a hole in the
     number when it is a hole in the corpus.
     -------------------------------------------------------------------- */
  var FIELD_TO_INPUT = {
    venue_geography: { home: ['venue'], away: ['travel'] },
    weather: { any: ['weather'] },
    roster: { home: ['roster_home'], away: ['roster_away'] },
    availability: { home: ['injuries'], away: ['injuries'] },
    roster_talent: { home: ['roster_home'], away: ['roster_away'] },
    qb_starter: { home: ['qb'], away: ['qb'] },
    qb_availability: { home: ['qb', 'injuries'], away: ['qb', 'injuries'] },
    qb_efficiency_history: { home: ['qb'], away: ['qb'] },
    schedule_context: { home: ['schedule'], away: ['schedule'] },
    off_field: { home: ['offfield_home'], away: ['offfield_away'] },
    team_rating: { home: ['rating'], away: ['rating'] },
    matchup_profile: { any: ['matchup'] },
    recruiting_talent: { any: [] },
    coaching_continuity: { any: [] }
  };

  /* Field meaning and units, so a ledger row is readable without the code.
     `unit` is what the number IS; `means` is the question it answers. */
  var FIELD_META = {
    venue_geography: { unit: 'degrees latitude/longitude, metres of elevation',
      means: 'where the game is played — the coordinates every travel, altitude and forecast join is computed from',
      freshness_hours: null, freshness_basis: 'a stadium does not move; the table is refreshed when the FBS field changes' },
    weather: { unit: '°F, mph, inches of precipitation at kickoff',
      means: 'the conditions at kickoff, matched to the venue coordinates and the kickoff hour',
      freshness_hours: 12, freshness_basis: 'a forecast more than twelve hours old is a different forecast' },
    roster: { unit: 'players, by position group, with prior-season continuity',
      means: 'who is on the roster and who was here last season',
      freshness_hours: 336, freshness_basis: 'rosters move slowly; two weeks is the floor the contract applies' },
    availability: { unit: 'named players with a designated status',
      means: 'who cannot play, from a source that says so',
      freshness_hours: 48, freshness_basis: 'an availability read older than two days predates the practice week' },
    roster_talent: { unit: 'EPIR composite, 0-100, with its own measured confidence',
      means: 'how good the players on that roster are, measured from attributed production',
      freshness_hours: 336, freshness_basis: 'the player layer rebuilds weekly' },
    qb_starter: { unit: 'one athlete id and the evidence class that resolved him',
      means: 'who is expected to start at quarterback, and on what kind of evidence',
      freshness_hours: 168, freshness_basis: 'the resolution is re-derived from the most recent completed game' },
    qb_availability: { unit: 'a designated status for that athlete',
      means: 'whether the expected starter can play',
      freshness_hours: 48, freshness_basis: 'same floor as the availability layer it comes from' },
    qb_efficiency_history: { unit: 'EPA per dropback over career dropbacks',
      means: 'how well that quarterback has actually thrown, measured',
      freshness_hours: 168, freshness_basis: 'the EPA artifact is refreshed weekly during the season' },
    schedule_context: { unit: 'days of rest, consecutive road games, opponent ratings',
      means: 'what the schedule has asked of this team around this game',
      freshness_hours: null, freshness_basis: 'read off the season schedule; it is a fact about fixtures' },
    off_field: { unit: 'sourced public reports, severity x reliability x time decay',
      means: 'public, sourced off-field reporting that changes how well the team is known',
      freshness_hours: 504, freshness_basis: 'signals decay on a measured half-life rather than expiring' },
    recruiting_talent: { unit: '247Sports-style composite team talent, blue-chip ratio',
      means: 'the recruiting pedigree on the roster, as distinct from its measured production',
      freshness_hours: null, freshness_basis: 'a season’s talent composite is published once' },
    team_rating: { unit: 'points of team strength on the engine’s own scale',
      means: 'how good this team is, blended from the trained preseason seed and the in-season update',
      freshness_hours: 336, freshness_basis: 'the rating absorbs a completed game within the weekly rebuild' },
    matchup_profile: { unit: 'per-team-game rate profiles, both sides',
      means: 'the stylistic pairing — what each side does and how the other defends it',
      freshness_hours: 336, freshness_basis: 'profiles rebuild weekly with the play feed' },
    coaching_continuity: { unit: 'head coach and coordinator continuity',
      means: 'whether the staff calling this game is the staff that produced the history',
      freshness_hours: null, freshness_basis: 'changes at known moments, not continuously' }
  };

  /* Which contract states count as what. VERIFIED is deliberately narrow:
     retrieved, current, from a named source, and not inferred. */
  var STATE_MEANING = {
    USABLE: { known: true, verified: true, priced: true, costs_points: false },
    RESEARCH_ONLY: { known: true, verified: true, priced: false, costs_points: false },
    STALE: { known: false, verified: false, priced: false, costs_points: true },
    CONFLICTING: { known: false, verified: false, priced: false, costs_points: true },
    INFERRED: { known: true, verified: false, priced: false, costs_points: true },
    NOT_APPLICABLE: { known: false, verified: false, priced: false, costs_points: false, applicable: false },
    /* NOT_REQUIRED IS NOT AN EXCUSE, IT IS A REASON. No conference filing was
       required for a non-conference fixture, which is true and precise and is
       NOT a statement that EdgeDesk knows who can play. The engine charges for
       that ignorance, so the contract counts it: applicable, not known, and
       costing points, with the reason on the row. Treating it as inapplicable
       is how "nobody had to file" quietly became "nothing is missing". */
    NOT_REQUIRED: { known: false, verified: false, priced: false, costs_points: true },
    NOT_DUE_YET: { known: false, verified: false, priced: false, costs_points: true },
    FETCH_FAILED: { known: false, verified: false, priced: false, costs_points: true },
    UNAVAILABLE: { known: false, verified: false, priced: false, costs_points: true }
  };

  function meaningOf(state) {
    var m = STATE_MEANING[state];
    return m || { known: false, verified: false, priced: false, costs_points: true };
  }

  /* --------------------------------------------------------------------
     THE FOUR NUMBERS, EACH WITH ITS OWN NAME AND DENOMINATOR.
     -------------------------------------------------------------------- */
  function scoreboard(o) {
    o = o || {};
    var summary = o.summary || null;
    return {
      information_confidence: {
        id: 'information_confidence',
        value_pct: isNum(o.confidence) ? Math.round(o.confidence * 10) / 10 : null,
        measures: 'EVIDENCE QUALITY. Each of the engine’s twelve scored inputs, counted at how well EdgeDesk '
          + 'knows it, weighted by the trained weight table.',
        denominator: 'the sum of the trained confidence weights (' + (isNum(o.weight_total) ? r3(o.weight_total) : '?') + ')',
        not_the_same_as: 'a count of fields, and not a probability that the projection is right'
      },
      priced_confidence: {
        id: 'priced_confidence',
        value_pct: isNum(o.confidence_priced) ? Math.round(o.confidence_priced * 10) / 10 : null,
        measures: 'VALIDATED PRICING COVERAGE. The same weighted table over the PRICED measurements — how much of '
          + 'what EdgeDesk knows the published number is allowed to use.',
        denominator: 'the same weight sum',
        not_the_same_as: 'evidence quality. It is always the lower of the two, and the gap IS the unpriced share'
      },
      input_coverage: {
        id: 'input_coverage',
        value_pct: summary && isNum(summary.input_coverage) ? Math.round(summary.input_coverage * 1000) / 10 : null,
        known: summary ? summary.known : null,
        applicable: summary ? summary.applicable : null,
        fields: summary ? summary.fields : null,
        measures: 'INPUT COVERAGE. An unweighted COUNT: applicable contract fields EdgeDesk retrieved, over '
          + 'applicable contract fields. Every field counts once whatever it is worth.',
        denominator: 'applicable contract fields (fields that do not arise here are excluded, never counted as missing)',
        not_the_same_as: 'the weighted confidence above. A cheap field and the quarterback count the same here '
          + 'and do not there'
      },
      priced_input_coverage: {
        id: 'priced_input_coverage',
        value_pct: summary && isNum(summary.priced_coverage) ? Math.round(summary.priced_coverage * 1000) / 10 : null,
        measures: 'the same count restricted to fields the published number prices',
        denominator: 'applicable contract fields',
        not_the_same_as: 'priced_confidence, which is weighted'
      },
      engine_probe_completeness: {
        id: 'engine_probe_completeness',
        value_pct: isNum(o.engine_completeness) ? Math.round(o.engine_completeness * 1000) / 10 : null,
        measures: 'the engine’s OWN internal probe count — how many of its layer probes returned a value. It is '
          + 'a diagnostic of the engine, not a measure of the data supplied to it.',
        denominator: 'the engine’s internal probe list',
        not_the_same_as: 'input coverage; the two have different denominators and will not agree'
      },
      historical_sample: {
        id: 'historical_sample',
        value_pct: isNum(o.sample_sufficiency) ? Math.round(o.sample_sufficiency * 1000) / 10 : null,
        measured_inputs_with_a_sample: o.sample_counted == null ? null : o.sample_counted,
        measured_inputs: o.sample_total == null ? null : o.sample_total,
        measures: 'HISTORICAL SAMPLE SUFFICIENCY. Of the inputs that WERE measured, the share whose measurement '
          + 'publishes the size of the sample behind it — a rate over 10,843 observed pairs and a declared '
          + 'constant both score 1.0 on evidence quality and are not the same kind of number.',
        denominator: 'the scored inputs that returned a measurement at all',
        not_the_same_as: 'coverage of this game’s inputs, and not a statement that the samples are large '
          + 'enough — only that they are counted and published'
      },
      outcome_probability: {
        id: 'outcome_probability',
        value_pct: isNum(o.home_win_prob) ? Math.round(o.home_win_prob * 1000) / 10 : null,
        measures: 'the probability of an OUTCOME. Nothing above is a probability and this is not a confidence.',
        denominator: 'not applicable',
        not_the_same_as: 'every other number on this list. A fully populated dataset does not make an outcome certain'
      },
      why_they_differ: 'These are five denominators and a probability. information_confidence weights the '
        + 'quarterback the same as the whole rating and twenty times the weather; input_coverage counts them '
        + 'equally; engine_probe_completeness counts something else again. They are published together, named, '
        + 'so the difference is readable rather than looking like a fault.'
    };
  }

  /* --------------------------------------------------------------------
     THE LEDGER.

     contract:    the rows football/matchup/inputs.js produced
     information: engine layers.uncertainty.information — one measurement per
                  scored input, each with .available and .confidence
     weights:     params.confidence.weights
     -------------------------------------------------------------------- */
  function ledger(o) {
    o = o || {};
    var contract = o.contract || [];
    var info = o.information || {};
    var W = o.weights || {};
    var now = isNum(o.now) ? o.now : Date.now();
    var keys = [], k;
    for (k in W) if (Object.prototype.hasOwnProperty.call(W, k)) keys.push(k);
    var den = 0;
    keys.forEach(function (x) { den += W[x]; });

    /* --- 1. every scored input: what it is worth and what it scored ----- */
    var inputs = {};
    keys.forEach(function (name) {
      var m = info[name];
      var max = den > 0 ? 100 * W[name] / den : 0;
      var conf = (m && m.available) ? clamp(m.confidence, 0, 1) : 0;
      inputs[name] = {
        input: name, weight: W[name], max_points: r2(max),
        earned_points: r2(max * conf), lost_points: r2(max * (1 - conf)),
        measured: !!(m && m.available), confidence: m && m.available ? r3(m.confidence) : null,
        basis: (m && (m.basis || m.reason)) || null,
        source: (m && m.source) || null,
        as_of: (m && m.as_of) || null,
        fields: []
      };
    });

    /* --- 2. every contract field, mapped onto those inputs ------------- */
    var rows = contract.map(function (c) {
      var map = FIELD_TO_INPUT[c.field] || null;
      var feeds = map ? (map[c.side || 'any'] || map.any || []) : null;
      if (feeds == null) feeds = [];
      feeds = feeds.filter(function (f) { return Object.prototype.hasOwnProperty.call(W, f); });
      var meta = FIELD_META[c.field] || {};
      var mean = meaningOf(c.state);
      var age = isNum(c.age_hours) ? c.age_hours
        : (c.as_of ? (now - Date.parse(c.as_of)) / 3600000 : null);
      var floor = meta.freshness_hours;
      var overdue = (isNum(age) && isNum(floor)) ? age > floor : null;
      return {
        field: c.field,
        side: c.side || null,
        team: c.side === 'home' ? (o.home || null) : (c.side === 'away' ? (o.away || null) : null),
        means: meta.means || null,
        unit: meta.unit || null,
        state: c.state,
        known: !!mean.known,
        verified: !!mean.verified,
        applicable: mean.applicable !== false,
        affects_pricing: !!c.priced,
        source: c.source || null,
        evidence: c.detail || null,
        observed_at: c.observed_at || c.published_at || null,
        retrieved_at: c.as_of || null,
        age_hours: isNum(age) ? Math.round(age * 10) / 10 : null,
        freshness_floor_hours: floor == null ? null : floor,
        freshness_basis: meta.freshness_basis || null,
        past_freshness_floor: overdue,
        identity_resolution: c.identity || null,
        feeds_inputs: feeds.slice(),
        /* filled in below, once every field claiming an input is known */
        weight_share: null, lost_points: null,
        fix: c.fix || null
      };
    });

    /* --- 3. share out each input's lost points across the fields that
             feed it, so every lost point lands on exactly one field ----- */
    var disagreements = [];
    rows.forEach(function (r) {
      r.feeds_inputs.forEach(function (f) { if (inputs[f]) inputs[f].fields.push(r); });
    });
    keys.forEach(function (name) {
      var slot = inputs[name];
      var contributing = slot.fields.filter(function (r) { return r.applicable; });
      /* an input no contract field claims still shows its own loss, under
         the input's name, so nothing disappears from the arithmetic */
      if (!contributing.length) {
        slot.unattributed_lost_points = slot.lost_points;
        /* THE DISAGREEMENT, NAMED. The contract says no applicable field feeds
           this input, and the engine scored it unmeasured and charged for it.
           One of the two is wrong and the reader is entitled to know which
           pair disagrees rather than to find 4 points that belong to nothing.
           This is the "if they are supposed to match, fix the disagreement"
           case, surfaced instead of absorbed. */
        if (slot.lost_points > 0) disagreements.push({
          input: name, lost_points: slot.lost_points,
          contract_says: slot.fields.length
            ? 'every contract field feeding this input is inapplicable here (' 
              + slot.fields.map(function (r) { return r.field + '=' + r.state; }).join(', ') + ')'
            : 'no contract field feeds this input at all',
          engine_says: slot.measured ? 'measured at confidence ' + slot.confidence : 'unmeasured, and charged in full',
          why_it_matters: 'a field the contract excludes from its denominator is still costing the weighted score. '
            + 'Either the contract should count it or the engine should not charge for it; the ledger does not '
            + 'pick, it reports.' });
        return;
      }
      var blockers = contributing.filter(function (r) { return !r.known; });
      var target = blockers.length ? blockers : contributing;
      var each = slot.lost_points / target.length;
      target.forEach(function (r) {
        r.weight_share = r2((r.weight_share || 0) + slot.max_points / contributing.length);
        r.lost_points = r2((r.lost_points || 0) + each);
      });
      contributing.forEach(function (r) {
        if (r.weight_share == null) r.weight_share = r2(slot.max_points / contributing.length);
        if (r.lost_points == null) r.lost_points = 0;
      });
    });
    /* a field feeding nothing scored costs the score nothing, and says so */
    rows.forEach(function (r) {
      if (r.lost_points == null) { r.lost_points = 0; r.weight_share = r.weight_share || 0; }
      /* RETRIEVED IS NOT COMPLETE, and a ledger that did not say so would look
         broken: a roster EdgeDesk holds in full can still leave its layer
         partly unmeasured, and the points that costs belong to that field
         even though the field is USABLE. */
      if (r.known && r.lost_points > 0) {
        r.why_costing = 'this field was retrieved, and the layer it feeds is still only partly measured. What is '
          + 'missing is inside the field, not the field itself — see the input’s own basis';
      }
      if (!r.feeds_inputs.length) {
        r.scored = false;
        r.note = 'this field feeds no scored input: it is research context or a documented corpus gap, and its '
          + 'absence costs the confidence score nothing. It is still published so the reader can see it is missing.';
      } else r.scored = true;
    });

    /* --- 4. the arithmetic, checked -------------------------------------- */
    var totalLost = 0, attributed = 0, unattributed = 0;
    keys.forEach(function (name) {
      totalLost += inputs[name].lost_points;
      if (inputs[name].unattributed_lost_points != null) unattributed += inputs[name].unattributed_lost_points;
    });
    rows.forEach(function (r) { attributed += r.lost_points || 0; });
    /* HOW MUCH OF THIS SCORE RESTS ON A COUNTED SAMPLE. A measurement that
       publishes `n` was fitted or observed over something; one that does not
       is a declared or structural value. Both can be right and they are not
       the same kind of evidence, so the share is published rather than left
       for a reader to discover by opening each basis string. */
    var sampleTotal = 0, sampleCounted = 0;
    keys.forEach(function (name) {
      var m = info[name];
      if (!m || !m.available) return;
      sampleTotal++;
      if (isNum(m.n)) sampleCounted++;
    });

    var displayed = isNum(o.confidence) ? o.confidence : null;
    var reconciles = {
      displayed_confidence_pct: displayed == null ? null : Math.round(displayed * 10) / 10,
      points_lost_total: r2(totalLost),
      points_lost_attributed_to_fields: r2(attributed),
      points_lost_not_attributable_to_a_contract_field: r2(unattributed),
      disagreements: disagreements.length,
      implied_score: displayed == null ? null : r2(100 - totalLost),
      agrees: displayed == null ? null : Math.abs((100 - totalLost) - displayed) < 0.05,
      basis: 'the displayed score plus every lost point must be 100. If `agrees` is false the ledger is wrong and '
        + 'says so here rather than letting a reader discover it.'
    };

    var byLoss = rows.slice().filter(function (r) { return (r.lost_points || 0) > 0; })
      .sort(function (a, b) { return b.lost_points - a.lost_points; });

    return {
      schema: SCHEMA,
      generated_at: new Date(now).toISOString(),
      home: o.home || null, away: o.away || null,
      scoreboard: scoreboard(Object.assign({}, o, {
        sample_sufficiency: sampleTotal ? sampleCounted / sampleTotal : null,
        sample_counted: sampleCounted, sample_total: sampleTotal })),
      inputs: keys.map(function (n) {
        var s = inputs[n];
        return { input: s.input, weight: s.weight, max_points: s.max_points, earned_points: s.earned_points,
          lost_points: s.lost_points, measured: s.measured, confidence: s.confidence, basis: s.basis,
          source: s.source, as_of: s.as_of,
          fed_by: s.fields.map(function (r) { return r.field + (r.side ? ':' + r.side : ''); }),
          unattributed_lost_points: s.unattributed_lost_points == null ? null : s.unattributed_lost_points };
      }),
      fields: rows,
      biggest_gaps: byLoss.slice(0, 8).map(function (r) {
        return { field: r.field + (r.side ? ':' + r.side : ''), team: r.team, state: r.state,
          lost_points: r.lost_points, of_max: r.weight_share, fix: r.fix, evidence: r.evidence };
      }),
      /* where the contract and the weighted score do not describe the same
         game. Empty is the normal state; a non-empty list is a bug in one of
         the two, named rather than absorbed into a rounding. */
      disagreements: disagreements,
      reconciles: reconciles
    };
  }

  /* --------------------------------------------------------------------
     AN OUTCOME PROBABILITY, RENDERED WITHOUT CLAIMING CERTAINTY.

     `Math.round(p * 100)` printed Oregon 100% / Portland State 0% on a
     projection whose own numbers were 0.9977 and 0.0023. Rounding is not the
     problem; rounding ACROSS THE BOUNDARY is: 100% and 0% are the two values
     a model with a continuous margin distribution can never mean, and a
     reader who sees them is being told something the model did not say.

     So an interior probability never renders as either. It is capped at the
     nearest value that still reads as a probability and the text says so,
     and `certain` is true only for a genuine 0 or 1 — which this engine does
     not produce and which, if it ever did, would be visible rather than
     hidden inside a rounding.

     The paired form keeps the two sides complementary: a favourite shown as
     ">99%" has an underdog shown as "<1%", never "0%".
     -------------------------------------------------------------------- */
  function outcomeLabel(p, digits) {
    if (!isNum(p)) return { pct: null, text: null, certain: null, bounded: false };
    var d = isNum(digits) ? digits : 0;
    var f = Math.pow(10, d);
    var pct = Math.round(p * 100 * f) / f;
    if (p >= 1) return { pct: 100, text: '100%', certain: true, bounded: false };
    if (p <= 0) return { pct: 0, text: '0%', certain: true, bounded: false };
    var hi = 100 - 1 / f, lo = 1 / f;
    if (pct >= 100) return { pct: hi, text: '>' + hi + '%', certain: false, bounded: true,
      why: 'the model puts this at ' + (Math.round(p * 1e6) / 1e4) + '%, which is not certainty and is not shown as it' };
    if (pct <= 0) return { pct: lo, text: '<' + lo + '%', certain: false, bounded: true,
      why: 'the model puts this at ' + (Math.round(p * 1e6) / 1e4) + '%, which is not impossibility and is not shown as it' };
    return { pct: pct, text: pct + '%', certain: false, bounded: false };
  }
  /* home probability -> both sides, complementary and never certain */
  function outcomePair(pHome, digits) {
    var h = outcomeLabel(pHome, digits);
    var a = outcomeLabel(isNum(pHome) ? 1 - pHome : null, digits);
    return { home: h, away: a,
      note: h.bounded || a.bounded
        ? 'one side rounds past the boundary, so it is shown bounded: a projection built on a continuous margin '
          + 'distribution cannot mean 100% or 0%'
        : null };
  }

  return { SCHEMA: SCHEMA, ledger: ledger, scoreboard: scoreboard,
    outcomeLabel: outcomeLabel, outcomePair: outcomePair,
    FIELD_TO_INPUT: FIELD_TO_INPUT, FIELD_META: FIELD_META, STATE_MEANING: STATE_MEANING,
    meaningOf: meaningOf };
});
