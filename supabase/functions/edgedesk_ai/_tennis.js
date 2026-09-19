// supabase/functions/edgedesk_ai/_tennis.js
// ============================================================================
// EdgeDesk Intelligence — the TENNIS retrieval layer.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE. The assistant may say nothing
// about tennis that it did not read from an approved database call. It does
// not compute a probability, de-vig a price, estimate a rating, or recall a
// result. Every number it quotes came back from one of the five
// security-definer functions the contract exposes:
//
//   tennis.ai_surface_leaders(tour, surface, limit)   who is strongest where
//   tennis.ai_market_disagreement(tour, limit)        model vs market gaps
//   tennis.ai_player_context(player_id)               one player, in full
//   tennis.ai_match_context(match_ref)                one match, in full
//   tennis.ai_data_health()                           what is missing
//
// Each is bounded (a hard row cap in SQL), each carries its own provenance,
// and the two priced ones check tennis.viewer_is_entitled() INSIDE the
// function — so an unentitled reader is answered by the database with no rows,
// not by this file with a redaction. The assistant is told which happened.
//
// WHAT IT MUST NEVER DO, stated so a future edit has to argue with it:
//   - never invent an injury, a withdrawal, a schedule or a start time
//   - never present tournament-week weather as conditions at first serve
//   - never present an indoor event's absent weather as missing data
//   - never quote a rating without the sample and uncertainty beside it
//   - never quote a model number without the model version and its timestamp
//   - never describe a doubles pair as a player
//   - never turn a model/market gap into a recommendation
//
// THE ANSWER CONTRACT. Every tennis answer about a CURRENT match must carry
// five things, and tennisAnswerContract() assembles them from what was
// actually retrieved rather than from what the model remembers:
//   data timestamp · market timestamp · model version · what is missing ·
//   whether the match passes EdgeDesk's research-quality gates.
//
// Research, not picks.
// ============================================================================

/*__EDTENNIS_START__*/
(function (root, factory) {
  var api = factory();
  root.EDTennisAI = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var VERSION = "tennis-ai-1.0";

  /* The nine questions this layer was built to answer, each mapped to the
     retrieval it needs. A question that matches none of them still gets the
     core market research every sport gets; it just does not get tennis
     specifics, and the answer says so. */
  var INTENTS = [
    { id: "surface_strength",
      test: /\b(strongest|best|top)\b[^?]*\b(on|at)\b\s*(clay|grass|hard|carpet)|\b(clay|grass|hard)[- ]court\b[^?]*\b(best|strongest|specialist)/i,
      needs: ["surface_leaders"],
      answers: "Who is the strongest player on this surface right now." },
    { id: "disagreement",
      /* order-agnostic on purpose: "model/market disagreement" and "disagrees
         with the market" are the same question written two ways, and the first
         is how the product's own copy phrases it. */
      test: /\b(disagree\w*|mispric\w*|differ\w*)\b|\b(model|edgedesk)\b[^?]{0,40}\b(market|book|price|line)\b[^?]{0,40}\b(gap|disagree\w*|differ\w*|value)\b|\b(gap|value|edge)\b[^?]{0,30}\b(market|book|price|line)\b|\bwhere (is|are) the (gap|value|edge)\b/i,
      needs: ["disagreement"],
      answers: "Which matches show the largest model/market disagreement." },
    { id: "form_sustainable",
      test: /\b(form|streak|run|hot|cold)\b[^?]*\b(sustain|real|hold up|continue|last)|\bis .* form\b/i,
      needs: ["player"],
      answers: "Whether a player's current form is sustainable, given the sample behind it." },
    { id: "surface_effect",
      test: /\b(surface|clay|grass|hard court)\b[^?]*\b(change|matter|affect|swing|difference)/i,
      needs: ["match", "player"],
      answers: "How much this surface changes the matchup." },
    { id: "fatigue",
      test: /\b(fatigue|tired|rest|workload|schedule|travel|back[- ]to[- ]back|turnaround)\b/i,
      needs: ["match", "player"],
      answers: "Whether fatigue or schedule is meaningful here." },
    { id: "market_read",
      test: /\bwhat (does|do) the (market|price|line|book)[a-z ]{0,12}(imply|implies|say|says|think|mean|means)\b|\bimplied (probability|odds|price)\b|\bwhat is the market (saying|pricing)\b/i,
      needs: ["match"],
      answers: "What the market price implies." },
    { id: "why_different",
      test: /\bwhy (is|does) edgedesk\b|\bwhy .* different from the market\b|\bwhat does edgedesk see\b/i,
      needs: ["match"],
      answers: "Why EdgeDesk's number differs from the market's." },
    { id: "whats_missing",
      test: /\bwhat (is|are|information is) missing\b|\bwhat don'?t (you|we) (know|have)\b|\bdata (gap|quality|coverage)\b/i,
      needs: ["health", "match"],
      answers: "What information is missing." },
    { id: "best_to_research",
      test: /\b(best|worth|which|what)\b[^?]{0,40}\b(matches|games|fixtures)\b[^?]{0,40}\b(research|look at|study|today|worth)\b|\bwhat should i (research|look at|study)\b|\bworth researching\b/i,
      needs: ["disagreement", "health"],
      answers: "Which tennis matches are worth researching today." }
  ];

  function classifyTennis(question) {
    var q = String(question == null ? "" : question);
    var hits = INTENTS.filter(function (i) { return i.test.test(q); });
    var needs = {};
    hits.forEach(function (h) { h.needs.forEach(function (n) { needs[n] = true; }); });
    /* a tennis question with no recognised intent still gets the board and the
       health line — enough to say what EdgeDesk holds and what it does not */
    if (!hits.length) { needs.health = true; needs.disagreement = true; }
    return { intents: hits.map(function (h) { return h.id; }),
             answers: hits.map(function (h) { return h.answers; }),
             needs: Object.keys(needs), version: VERSION };
  }

  /* Is this a tennis question at all, and on which tour? Deliberately narrow:
     "Djokovic" is tennis, "match" alone is not. A false positive here would
     route a football question into a tennis retrieval and answer it with
     nothing. */
  var TOUR_WORDS = /\b(atp|wta|tennis|wimbledon|roland[- ]garros|french open|us open tennis|australian open)\b/i;
  var SURFACE_WORDS = /\b(clay|grass|hard court|indoor hard)\b/i;
  function detectTour(question) {
    var q = String(question == null ? "" : question);
    if (/\bwta\b/i.test(q)) return "WTA";
    if (/\batp\b/i.test(q)) return "ATP";
    return null;
  }
  function isTennisQuestion(question, sportKey) {
    if (sportKey && /^tennis/.test(String(sportKey))) return true;
    var q = String(question == null ? "" : question);
    return TOUR_WORDS.test(q) || (SURFACE_WORDS.test(q) && /\b(player|match|seed|serve|rally|set)\b/i.test(q));
  }
  function detectSurface(question) {
    var q = String(question == null ? "" : question).toLowerCase();
    if (/\bclay\b/.test(q)) return "clay";
    if (/\bgrass\b/.test(q)) return "grass";
    if (/\bcarpet\b/.test(q)) return "carpet";
    if (/\bhard\b/.test(q)) return "hard";
    return null;
  }

  /* ── retrieval ────────────────────────────────────────────────────────
     `rpc` is injected: a function (name, args) -> Promise<json>. In the Edge
     Function it POSTs to /rest/v1/rpc/<name> UNDER THE CALLER'S JWT, so the
     entitlement check inside the SQL function sees the real reader. In tests it
     is a fake. Nothing here holds a credential. */
  function evidence(field, value, note, extra) {
    return Object.assign({
      source: "tennis", field: field, value: value,
      status: value == null ? "UNAVAILABLE" : "OK",
      retrieved_at: new Date().toISOString(),
      note: note || null
    }, extra || {});
  }

  async function retrieveTennis(rpc, question, opts) {
    var o = opts || {};
    var plan = classifyTennis(question);
    var tour = o.tour || detectTour(question);
    var surface = o.surface || detectSurface(question);
    var out = { plan: plan, tour: tour, surface: surface, evidence: [],
                entitled: null, failures: [], version: VERSION };

    async function call(name, args, field, note) {
      try {
        var v = await rpc(name, args);
        out.evidence.push(evidence(field, v, note, { rpc: name }));
        return v;
      } catch (e) {
        var msg = String((e && e.message) || e);
        out.failures.push({ rpc: name, error: msg });
        /* A failed read is reported as a failed read. It is never allowed to
           look like an empty result, because "EdgeDesk has no clay leaders" and
           "EdgeDesk could not ask" are different answers. */
        out.evidence.push(evidence(field, null,
          "This retrieval failed and was NOT substituted: " + msg.slice(0, 180), { rpc: name, failed: true }));
        return null;
      }
    }

    var needs = plan.needs;
    if (needs.indexOf("surface_leaders") >= 0) {
      out.leaders = await call("ai_surface_leaders",
        { p_tour: tour, p_surface: surface || "hard", p_limit: 10 },
        "tennis_surface_leaders",
        "Ranked by surface Elo among players with at least 15 matches on that surface. "
        + "A rating below that sample is a gap, not a ranking.");
    }
    if (needs.indexOf("disagreement") >= 0) {
      out.disagreement = await call("ai_market_disagreement", { p_tour: tour, p_limit: 10 },
        "tennis_market_disagreement",
        "Model probability against the market's de-vigged probability, for matches "
        + "generated in the last two days. A gap is a reason to look, not a recommendation.");
      /* The database answers an unentitled caller with zero rows rather than an
         error. That is the paywall, and the assistant must say which happened
         rather than implying EdgeDesk found nothing. */
      if (out.disagreement && out.disagreement.length === 0) out.maybe_unentitled = true;
    }
    if (needs.indexOf("player") >= 0 && o.player_id) {
      out.player = await call("ai_player_context", { p_player_id: o.player_id },
        "tennis_player_context",
        "Rating, surface record, last twenty matches and the licence of the source behind them.");
    }
    if (needs.indexOf("match") >= 0 && o.match_ref) {
      out.match = await call("ai_match_context", { p_match_ref: o.match_ref },
        "tennis_match_context",
        "The fixture, the record either side of it, and — for an entitled reader — "
        + "the model, the market and the open research notes.");
      if (out.match && out.match.entitled === false) out.entitled = false;
      else if (out.match && out.match.entitled === true) out.entitled = true;
    }
    if (needs.indexOf("health") >= 0) {
      out.health = await call("ai_data_health", {}, "tennis_data_health",
        "Coverage, freshness, open data-quality issues, the last ingestion run of "
        + "every job, and the licence of every source.");
    }
    out.contract = tennisAnswerContract(out);
    return out;
  }

  /* ── the answer contract ──────────────────────────────────────────────
     Assembled from what was RETRIEVED. If a field is null here it is because
     nothing came back carrying it, and the assistant is required to say so
     rather than leave it out. */
  function tennisAnswerContract(r) {
    var m = r && r.match;
    var h = (r && r.health && r.health.health) || (m && m.health) || null;
    var pred = m && m.prediction;
    var market = m && m.market && m.market.length ? m.market[0] : null;
    var missing = [];

    if (!h) missing.push("the record health line could not be read");
    if (m && !m.match) missing.push("this match is not on file as an upcoming fixture");
    if (m && m.entitled === false) missing.push("the model price and market are a subscriber surface and were not returned");
    if (pred && pred.missing_inputs && pred.missing_inputs.length)
      pred.missing_inputs.forEach(function (k) { missing.push("model input not available: " + String(k).replace(/^d_/, "").replace(/_/g, " ")); });
    if (m && m.weather && m.weather.usable === false)
      missing.push(m.weather.environment === "indoor"
        ? "weather is not a factor (indoor) and none is stored"
        : "no usable weather for this venue — the reading is a tournament-week profile, not conditions at first serve");
    if (m && !m.weather) missing.push("no weather observation is attached to this event");
    if (r && r.failures && r.failures.length)
      r.failures.forEach(function (f) { missing.push("a retrieval failed and was not substituted: " + f.rpc); });

    var grade = pred ? pred.research_grade : null;
    return {
      data_timestamp: pred ? (pred.feature_snapshot_at || null) : (h ? h.ratings_computed_at : null),
      market_timestamp: market ? market.captured_at : null,
      model_version: pred ? pred.model_version : (h ? h.active_model_version : null),
      missing: missing,
      research_grade: grade,
      passes_research_gates: grade === "research",
      gate_reasons: pred && pred.exclusion_reasons ? pred.exclusion_reasons : [],
      entitled: r ? r.entitled : null,
      /* the sentence the assistant must be able to say, built from the above */
      statement: buildStatement(pred, market, h, grade, missing)
    };
  }

  function buildStatement(pred, market, health, grade, missing) {
    var parts = [];
    if (pred && pred.model_version) parts.push("Model " + pred.model_version);
    else if (health && health.active_model_version) parts.push("Active model " + health.active_model_version);
    else parts.push("No model version is active");
    if (pred && pred.feature_snapshot_at) parts.push("ratings as of " + pred.feature_snapshot_at);
    else if (health && health.ratings_computed_at) parts.push("ratings as of " + health.ratings_computed_at);
    if (market && market.captured_at) parts.push("market price captured " + market.captured_at);
    else parts.push("no market price captured");
    if (grade) parts.push(grade === "research"
      ? "this match passes EdgeDesk's research-quality gates"
      : "this match does NOT pass EdgeDesk's research-quality gates (" + grade + ")");
    if (missing && missing.length) parts.push(missing.length + " thing(s) EdgeDesk does not have");
    return parts.join(" · ");
  }

  /* ── what the assistant is allowed to say ─────────────────────────────
     Handed to the prompt beside the retrieved facts. It is written as
     prohibitions because every one of them is a mistake a language model makes
     by default when it is asked about a sport. */
  var TENNIS_RULES = [
    "Every tennis number you state must appear in the retrieved context. Do not compute, adjust, de-vig or recall one.",
    "A probability or a fair price is EdgeDesk's model output: name the model version and the timestamp of the ratings it read.",
    "A market probability is the MARKET's, never EdgeDesk's, and it is only de-vigged where the retrieval says it was.",
    "A rating is never quoted without its sample and its uncertainty. A player with a thin record is described as thinly known.",
    "Weather in this system is a tournament-WEEK profile for resolved outdoor venues. Never describe it as conditions at first serve. An indoor event has no weather because weather does not apply, not because a reading is missing.",
    "Never invent an injury, a withdrawal, a retirement, a schedule change or a start time. If it is not in the retrieved context, EdgeDesk does not know it.",
    "A doubles pair is a team. Never describe one as a player and never attach a player's record to one.",
    "A gap between EdgeDesk and the market is a reason to research, never a recommendation, a selection or a stake.",
    "If the retrieval came back empty because the reader is not entitled, say that plainly. Do not imply EdgeDesk found nothing.",
    "If a retrieval failed, say it failed. An error is not an empty result.",
    "Say what is missing. Every answer about a current match states the data timestamp, the market timestamp, the model version, what EdgeDesk does not have, and whether the match passes the research-quality gates."
  ];

  /* The block appended to the system prompt for a tennis question. Built from
     the retrieval so it can never describe context that was not fetched. */
  function tennisPromptBlock(r) {
    if (!r) return "";
    var L = [];
    L.push("TENNIS CONTEXT (retrieved from EdgeDesk's database — this is the only tennis information you have):");
    L.push("");
    if (r.leaders) L.push("surface_leaders (" + (r.surface || "hard") + (r.tour ? ", " + r.tour : "") + "): " + JSON.stringify(r.leaders));
    if (r.disagreement) L.push("model_market_disagreement: " + JSON.stringify(r.disagreement));
    if (r.player) L.push("player_context: " + JSON.stringify(r.player));
    if (r.match) L.push("match_context: " + JSON.stringify(r.match));
    if (r.health) L.push("data_health: " + JSON.stringify(r.health));
    if (r.maybe_unentitled) L.push("NOTE: the priced retrieval returned no rows. This reader may not be entitled; say so rather than implying EdgeDesk has nothing.");
    if (r.failures && r.failures.length) L.push("FAILED RETRIEVALS (report these, do not substitute): " + JSON.stringify(r.failures));
    L.push("");
    L.push("ANSWER CONTRACT for this question: " + JSON.stringify(r.contract));
    L.push("");
    L.push("RULES:");
    TENNIS_RULES.forEach(function (x, i) { L.push("  " + (i + 1) + ". " + x); });
    return L.join("\n");
  }

  /* The capability declaration the rest of the engine reads: what tennis HAS,
     and — the part that matters — what it does not. */
  var TENNIS_CAPABILITIES = {
    tennis_atp: {
      schedule: true, market: true, rankings: true,
      tennis_record: true, tennis_rating: true, tennis_surface: true,
      tennis_form: true, tennis_fatigue: true, tennis_h2h: true,
      tennis_model: true, tennis_weather: true,
      /* genuinely absent, and declared so an answer says it rather than guessing */
      tennis_injury: false, tennis_point_by_point: false, tennis_doubles: false,
      tennis_exact_start_time: false,
      starters: false, pitching_season: false, offense: false, bullpen: false,
      park: false, quarterback: false, team_efficiency: false
    }
  };
  TENNIS_CAPABILITIES.tennis_wta = TENNIS_CAPABILITIES.tennis_atp;

  var TENNIS_NEEDS = "Wired. The match record, point-in-time features, the rating layer, "
    + "the model registry, market snapshots and the published record are all in the tennis "
    + "schema and are read through five bounded security-definer functions. What is genuinely "
    + "NOT ingested: injuries and withdrawals (no source), point-by-point (no source), doubles "
    + "ratings (a pair is a team), and exact first-serve times for historical matches (the "
    + "archive dates a match to its tournament week). Say so rather than substituting.";

  return {
    VERSION: VERSION,
    INTENTS: INTENTS,
    TENNIS_RULES: TENNIS_RULES,
    TENNIS_CAPABILITIES: TENNIS_CAPABILITIES,
    TENNIS_NEEDS: TENNIS_NEEDS,
    classifyTennis: classifyTennis,
    isTennisQuestion: isTennisQuestion,
    detectTour: detectTour,
    detectSurface: detectSurface,
    retrieveTennis: retrieveTennis,
    tennisAnswerContract: tennisAnswerContract,
    tennisPromptBlock: tennisPromptBlock
  };
});
/*__EDTENNIS_END__*/
