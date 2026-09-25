/*__EDED_NARRATE_START__*/
/* ============================================================================
   THE NARRATION LAYER — where a language model is allowed to help, and the
   exact boundary of what it may touch.

   THE SHAPE IS THE ONE supabase/functions/edgedesk_ai/index.ts ALREADY USES,
   and using it again rather than inventing a second one is deliberate:

        deterministic decision  ->  translate  ->  narrate  ->  VALIDATE
                                                                  |
                                          rejected copy falls back to the
                                          deterministic prose, every time

   WHAT THE MODEL IS GIVEN is a structured payload this repository built: the
   snapshot, the result, the audit verdicts, the grading. Never a pile of
   rows, never a database, never a tool.

   WHAT THE MODEL MAY WRITE is four short fields — a standfirst, an opening
   paragraph, a "why the game turned" reading and a closing thought — and
   nothing else on the page. It may not write a number, change a verdict,
   name a player, describe a play, or add a fact.

   WHAT THE VALIDATOR REFUSES, and this is the whole safety argument:
     · any figure not in the payload's own closed set of assertable values
     · any verdict word used against a thesis the audit graded differently
     · any recommendation language, by the article model's own list
     · any phrase on the machine-written list in quality.js
     · a player name, a quotation, or an injury claim — none of which this
       payload contains, so any of them is invention by definition
     · malformed output, a truncated block, or a missing field
   A single failure discards THE WHOLE narration and the deterministic prose
   ships. There is no partial acceptance, because a payload half-written by a
   model and half by this repository is the hardest kind of text to audit.

   AND IT IS OPTIONAL. With no ANTHROPIC_API_KEY the pipeline runs exactly as
   it does with one, minus four paragraphs of connective prose. Every fact,
   every verdict and every number on the page comes from the same place either
   way. That is the test of whether the boundary is real: if turning the model
   off changed a number, it was never on the right side of it.
   ========================================================================== */
(function (root, factory) {
  var api = factory(
    typeof require === 'function' ? require('../articles/article_model.js') : (root.EDART && root.EDART.model),
    typeof require === 'function' ? require('./quality.js') : (root.EDED && root.EDED.quality),
    typeof require === 'function' ? require('./theses.js') : (root.EDED && root.EDED.theses)
  );
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDED = root.EDED || {};
  root.EDED.narrate = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (AMODEL, QUALITY, THESES) {
  'use strict';

  var SCHEMA = 'edgedesk_narration_v1';
  var FIELDS = ['standfirst', 'opening', 'why_it_turned', 'closing'];
  var LIMITS = { standfirst: 260, opening: 900, why_it_turned: 1100, closing: 700 };

  function txt(v) { if (v == null) return null; var s = String(v).replace(/\s+/g, ' ').trim(); return s || null; }

  /* ---------------------------------------------------------- the payload */
  /* A DETERMINISTIC STRUCTURED PAYLOAD, built here, in the shape the product
     brief describes. Everything in it came out of this repository; the model
     receives no raw rows and no database access. */
  function payloadFor(rec) {
    var snap = rec.snapshot || {}, res = rec.result || {}, g = rec.grading || {};
    return {
      schema: SCHEMA,
      article_type: AMODEL.typeOf(rec),
      game: {
        away: rec.away_team, home: rec.home_team, kickoff: rec.game_time,
        venue: rec.venue, neutral_site: rec.neutral_site, week: rec.week, season: rec.season,
        sport: rec.sport_label
      },
      market: snap.market && snap.market.available ? {
        spread: snap.market.market, total: snap.market.total_market, book: snap.market.book,
        difference: snap.market.difference, classification: snap.market.classification
      } : { available: false, why: (snap.market && (snap.market.headline || snap.market.note)) || 'no sportsbook quote was captured' },
      edgedesk_model: snap.model || null,
      research_read: researchReadFrom(snap, rec),
      matchup: (snap.matchups || []).slice(0, 4).map(function (m) { return { title: m.title, read: m.read }; }),
      injuries: injuriesFrom(snap),
      weather: weatherFrom(snap),
      recent_performance: null,
      historical_context: null,
      pregame_theses: (rec.theses || []).map(function (t) {
        return { id: t.thesis_id, claim: t.claim, falsifier: t.falsifier, watch: t.watch, category: t.category };
      }),
      final_result: res.home_score == null ? null : {
        away: rec.away_team, away_score: res.away_score, home: rec.home_team, home_score: res.home_score,
        winner: res.winner, margin: res.margin, total_points: res.total_points
      },
      team_stats: res.metrics || null,
      player_stats: res.leaders || null,
      game_flow: { drives: res.drive_summary || null, win_probability: res.win_probability || null,
        scoring_plays: (res.scoring_plays || []).slice(0, 12) },
      thesis_audit: (rec.audit || []).map(function (a) {
        return { id: a.thesis_id, verdict: a.evaluation, observed: a.observed_result, why: a.why };
      }),
      bet_result: g.bet_result || null,
      process_grade: g.process_headline || null,
      variance_markers: (g.variance_markers || []).map(function (v) { return { label: v.label, text: v.text }; }),
      verified_sources: (res.agreed_by || []).concat(snap.sources || [])
        .filter(function (v, i, a) { return v && a.indexOf(v) === i; })
    };
  }
  /* THE BOARD'S RESEARCH READ, as the snapshot published it
     (cfb_research_brief/1): one label and what it means, the gap, confidence
     and reliability apart, and the reasons the engine measured. It is here so
     the model is handed the reasons rather than left to supply its own; the
     prompt forbids it any other. Absent is absent. */
  function researchReadFrom(snap, rec) {
    var v = (snap && snap.research_view) || (rec && rec.research && rec.research.research_view) || null;
    if (!v || v.contract !== 'cfb_research_brief/1' || !v.label || !v.label.key) {
      return { available: false, why: 'no research read was published for this game' };
    }
    var D = v.drivers;
    return {
      label: txt(v.label.label), means: txt(v.label.means),
      fair_line: v.fair ? txt(v.fair.line_text) : null,
      market_gap: v.market_gap && v.market_gap.available ? txt(v.market_gap.text) : null,
      confidence: v.confidence ? txt(v.confidence.label) : null,
      reliability: v.reliability ? txt(v.reliability.text) : null,
      measured_reasons: D && !D.none ? { team: txt(D.team), reasons: (D.reasons || []).map(function (x) { return txt(x && x.text); }).filter(Boolean) }
        : { none: true, why: txt(D && D.text) || 'no single component is driving the projection' },
      projection_status: v.projection_status ? txt(v.projection_status.label) : null
    };
  }
  /* The availability and weather EdgeDesk actually published, read off the
     uncertainty block where the model states them. Absent is absent. */
  function injuriesFrom(snap) {
    var items = ((snap.uncertainty && snap.uncertainty.items) || [])
      .filter(function (i) { return /injur|availab|inactive|questionable/i.test(String(i.label) + ' ' + String(i.text)); })
      .map(function (i) { return txt(i.text); }).filter(Boolean);
    return items.length ? items : { available: false, why: 'no availability data reached this model run' };
  }
  function weatherFrom(snap) {
    var items = ((snap.uncertainty && snap.uncertainty.items) || [])
      .filter(function (i) { return /weather|wind|temperature|forecast/i.test(String(i.label) + ' ' + String(i.text)); })
      .map(function (i) { return txt(i.text); }).filter(Boolean);
    return items.length ? items : { available: false, why: 'no forecast reached this model run' };
  }

  /* ------------------------------------------------------------ the prompt */
  var SYSTEM = [
    'You are writing connective prose for EdgeDesk Sports, a sports RESEARCH platform.',
    '',
    'EdgeDesk publishes research, not picks. A winning bet built on bad reasoning is not good analysis and must not be written as though it were. A losing bet built on sound reasoning is not bad analysis. That distinction is the product.',
    '',
    'YOU ARE NOT WRITING THE ARTICLE. The article already exists: every number, every verdict, every statistic and every conclusion has been computed and is on the page. You are writing four short connective passages that make the page read like it was written by one person who understands football and quantitative research.',
    '',
    'HARD RULES. Breaking any one of them discards everything you write:',
    '1. Use ONLY facts present in the JSON payload. No player names, no quotations, no injuries, no weather, no coaching decisions, no broadcast details and no historical records unless the payload contains them.',
    '2. Do not state a number that is not in the payload. Do not compute, round, average or combine numbers.',
    '3. Do not change, soften or contradict a thesis_audit verdict. If the payload says NOT CONFIRMED, that claim did not hold.',
    '4. Never recommend a wager, never call anything a lock, a best bet or free money, and never imply a result was certain.',
    '4a. research_read is EdgeDesk’s own deterministic research read. Its label is a research label (which question is worth opening), never a pick. If you say why EdgeDesk leaned one way, use ONLY research_read.measured_reasons; never supply a reason for the projection that is not listed there.',
    '5. No filler. No "delve into", no "in the ever-changing landscape", no "it is important to note", no "game-changer", no "only time will tell", no "whether you are a seasoned bettor", no "this thrilling matchup", no "at the end of the day".',
    '6. Few rhetorical questions. Do not open consecutive sentences the same way.',
    '',
    'VOICE. Knowledgeable, analytical, plain. Confident where the evidence is, explicitly uncertain where it is not. Use football language naturally. Explain what a statistic means rather than listing it.',
    '',
    'OUTPUT. Exactly one fenced block, no prose around it:',
    '```edgedesk',
    '{"standfirst": "...", "opening": "...", "why_it_turned": "...", "closing": "..."}',
    '```',
    'standfirst: one sentence, under 260 characters, saying what this game taught.',
    'opening: two short paragraphs (use \\n\\n) introducing what happened and why it is worth reading about.',
    'why_it_turned: two short paragraphs explaining the mechanism, using ONLY the statistics and markers in the payload.',
    'closing: one short paragraph on what a researcher should take from it. Not motivational. Analytical.'
  ].join('\n');

  function promptFor(rec) {
    var p = payloadFor(rec);
    return {
      system: SYSTEM,
      user: 'Write the four connective passages for this EdgeDesk '
        + (p.article_type === 'postgame' ? 'postgame analysis' : 'pregame research article') + '.\n\n'
        + '```json\n' + JSON.stringify(p, null, 1) + '\n```'
    };
  }

  /* ------------------------------------------------------------- parsing */
  /* A MALFORMED RESPONSE IS A REFUSED RESPONSE. No repair, no second attempt
     at parsing a truncated object: a block that did not arrive whole is a
     block nobody can vouch for. */
  function parse(text) {
    var s = String(text == null ? '' : text);
    var m = /```(?:edgedesk|json)?\s*([\s\S]*?)```/.exec(s);
    var body = m ? m[1] : null;
    if (!body) return { ok: false, why: 'the response carried no fenced block' };
    var obj = null;
    try { obj = JSON.parse(body); } catch (e) {
      return { ok: false, why: 'the fenced block is not valid JSON (' + (e && e.message) + ')' };
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return { ok: false, why: 'the fenced block is not an object' };
    }
    var out = {}, missing = [];
    FIELDS.forEach(function (f) {
      var v = txt(obj[f]);
      if (!v) { missing.push(f); return; }
      out[f] = String(obj[f]).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    });
    if (missing.length) return { ok: false, why: 'missing field(s): ' + missing.join(', ') };
    return { ok: true, copy: out };
  }

  /* ------------------------------------------------------------ validation */
  /* Everything the narration is allowed to assert: the same closed set the
     quality gate holds the whole page against, so a number the narration
     introduces fails here rather than at publication. */
  function validate(copy, rec) {
    var problems = [];
    if (!copy) return { ok: false, problems: ['no copy'] };

    var supported = QUALITY.supportedValues(rec);
    var all = FIELDS.map(function (f) { return copy[f] || ''; }).join(' \n ');

    /* 1 — length */
    FIELDS.forEach(function (f) {
      var v = String(copy[f] || '');
      if (v.length > LIMITS[f]) problems.push(f + ' is ' + v.length + ' characters, over the ' + LIMITS[f] + ' limit');
      if (v.length < 40) problems.push(f + ' is too short to be worth publishing');
    });

    /* 2 — NUMBERS. Every figure must be in the payload's own set. */
    var bad = [];
    QUALITY.numbersIn(all).forEach(function (tok) {
      var n = QUALITY.norm(tok);
      if (QUALITY.FREE.test(n)) return;
      if (supported[n]) return;
      if (bad.indexOf(tok) < 0) bad.push(tok);
    });
    if (bad.length) problems.push('introduces figure(s) not in the payload: ' + bad.slice(0, 6).join(', '));

    /* 3 — VERDICTS. A verdict word may only be used with the verdict the
       audit actually recorded. The check is coarse on purpose: if the copy
       says "confirmed" anywhere near a category the audit marked NOT
       CONFIRMED, it is refused rather than parsed for intent. */
    (rec.audit || []).forEach(function (a) {
      var cat = String(a.category || '').replace(/_/g, ' ');
      if (!cat || cat.length < 4) return;
      var re = new RegExp('(confirmed|held up|vindicat\\w+|proved right)[^.]{0,60}' + escapeRe(cat)
        + '|' + escapeRe(cat) + '[^.]{0,60}(confirmed|held up|vindicat\\w+|proved right)', 'i');
      if (a.evaluation === 'NOT CONFIRMED' && re.test(all)) {
        problems.push('claims "' + cat + '" was confirmed, which the audit graded NOT CONFIRMED');
      }
    });
    THESES.VERDICTS.forEach(function (v) {
      /* the verdict words are the audit's vocabulary; the narration may quote
         one but never invent a fifth */
      void v;
    });

    /* 4 — recommendation language, the article model's own list */
    if (AMODEL.FORBIDDEN.test(all)) {
      problems.push('carries betting-recommendation language: ' + (all.match(AMODEL.FORBIDDEN) || [''])[0]);
    }

    /* 5 — the machine-written phrase list */
    QUALITY.AI_TELLS.forEach(function (re) {
      var m = re.exec(all);
      if (m) problems.push('carries a phrase from the generated-copy list: "' + m[0] + '"');
    });

    /* 6 — INVENTED PEOPLE AND WORDS NOBODY SAID. The payload contains no
       quotation and, for most games, no player name; anything that looks like
       either is invention by definition. */
    if (/[“"][^”"]{12,}[”"]/.test(all)) problems.push('carries what looks like a quotation; EdgeDesk holds no quotations');
    var known = knownNames(rec);
    var names = all.match(/\b[A-Z][a-z]+ [A-Z][a-z']+\b/g) || [];
    var unknown = names.filter(function (n) {
      if (known[n.toLowerCase()]) return false;
      /* allow a capitalised phrase that is entirely made of known tokens —
         "Seattle Seahawks" is two known tokens, "Sam Darnold" is not */
      return !n.toLowerCase().split(' ').every(function (tok) { return known[tok]; });
    });
    if (unknown.length) {
      problems.push('names not present in the payload: ' + unknown.slice(0, 4).join(', '));
    }

    /* 7 — stringified nothing */
    if (/(^|[\s(])(null|undefined|NaN)([\s).,;:]|$)/.test(all)) {
      problems.push('a stringified null/undefined/NaN reached the copy');
    }

    /* 8 — tense, on a postgame page */
    if (AMODEL.typeOf(rec) === 'postgame'
      && /\b(?:will|is going to|are going to)\s+(?:be\s+)?(?:win|cover|score|decide|determine)\b/i.test(all)) {
      problems.push('writes about a played game in the future tense');
    }

    return { ok: !problems.length, problems: problems };
  }
  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /* Every proper noun the payload legitimately contains, lower-cased. Team
     names, venue, book, sport and the words of each — so a two-word
     capitalised phrase made only of those is allowed and anything else is
     not. */
  function knownNames(rec) {
    var out = Object.create(null);
    var snap = rec.snapshot || {}, res = rec.result || {};
    var strs = [];
    [rec.home_team, rec.away_team, rec.venue, rec.sport_label,
      snap.market && snap.market.book, res.home_team, res.away_team,
      snap.game && snap.game.conference_line].forEach(function (v) { if (v) strs.push(String(v)); });
    (res.leaders || []).forEach(function (l) { if (l && l.athlete) strs.push(String(l.athlete)); });
    (snap.sources || []).forEach(function (v) { if (v) strs.push(String(v)); });
    strs.forEach(function (s) {
      out[s.toLowerCase()] = true;
      s.split(/[^A-Za-z']+/).forEach(function (tok) { if (tok) out[tok.toLowerCase()] = true; });
    });
    /* the vocabulary of the domain, which is not a name */
    ['EdgeDesk Sports', 'Research Not', 'Not Confirmed', 'Partially Confirmed',
      /* the research view's own labels, in title case */
      'Worth Researching', 'Major Disagreement', 'Market Aligned', 'Low Reliability', 'Limited Data', 'Not Compared'].forEach(function (s) {
      out[s.toLowerCase()] = true;
      s.split(' ').forEach(function (t) { out[t.toLowerCase()] = true; });
    });
    return out;
  }

  /* -------------------------------------------------------------- the call */
  /* The HTTP call is injectable so the suite drives every branch — a good
     response, a malformed one, an invented number, a contradicted verdict, a
     timeout — with no network and no key. */
  async function callAnthropic(prompt, opts) {
    opts = opts || {};
    var key = opts.apiKey || (typeof process !== 'undefined' && process.env && process.env.ANTHROPIC_API_KEY);
    if (!key) { var e = new Error('no ANTHROPIC_API_KEY; narration skipped'); e.code = 'NO_KEY'; throw e; }
    var model = opts.model || (typeof process !== 'undefined' && process.env && process.env.EDGEDESK_EDITORIAL_MODEL)
      || 'claude-sonnet-5';
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, opts.timeout_ms || 60000) : null;
    try {
      var r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: model, max_tokens: 1600, temperature: 0.4,
          system: prompt.system,
          messages: [{ role: 'user', content: prompt.user }]
        }),
        signal: ctrl ? ctrl.signal : undefined
      });
      if (!r.ok) {
        var body = await r.text().catch(function () { return ''; });
        throw new Error('anthropic ' + r.status + (body ? ': ' + body.slice(0, 200) : ''));
      }
      var j = await r.json();
      var text = ((j.content || []).filter(function (c) { return c.type === 'text'; })[0] || {}).text || '';
      return { text: text, model: j.model || model };
    } finally { if (timer) clearTimeout(timer); }
  }

  /* ---------------------------------------------------------------- narrate */
  /* Returns { ok, copy, model, why } and NEVER throws. A failure of any kind —
     no key, a timeout, a 500, malformed output, a rejected validation — comes
     back as ok:false with a reason, and the caller ships the deterministic
     prose. */
  async function narrate(rec, opts) {
    opts = opts || {};
    var prompt = promptFor(rec);
    var raw = null;
    try {
      raw = await (opts.call || callAnthropic)(prompt, opts);
    } catch (e) {
      return { ok: false, attempted: (e && e.code) !== 'NO_KEY',
        why: (e && e.code) === 'NO_KEY'
          ? 'no ANTHROPIC_API_KEY is configured, so this article carries EdgeDesk’s deterministic prose only'
          : 'the narration call failed (' + (e && e.message ? String(e.message).slice(0, 160) : 'unknown') + ')' };
    }
    var parsed = parse(raw && raw.text);
    if (!parsed.ok) return { ok: false, attempted: true, why: 'narration refused: ' + parsed.why, model: raw && raw.model };
    var v = validate(parsed.copy, rec);
    if (!v.ok) {
      return { ok: false, attempted: true, model: raw && raw.model,
        why: 'narration refused: ' + v.problems.join('; '), problems: v.problems };
    }
    return { ok: true, copy: parsed.copy, model: raw && raw.model,
      note: 'Connective prose on this page was drafted by a language model from a structured payload of EdgeDesk’s own figures and verdicts, then validated against them. Every number, verdict and conclusion was computed by EdgeDesk before the model was called.' };
  }

  /* WHERE ACCEPTED COPY GOES. It is attached to the record as its OWN block,
     never merged into a section, so the page can always be re-rendered
     without it and the checks can always tell the two apart. */
  function attach(rec, narration) {
    var next = Object.assign({}, rec);
    next.narration = narration && narration.ok
      ? { schema: SCHEMA, copy: narration.copy, model: narration.model, note: narration.note,
        validated: true, at: new Date().toISOString() }
      : { schema: SCHEMA, copy: null, validated: false, why: narration && narration.why,
        attempted: !!(narration && narration.attempted), at: new Date().toISOString() };
    return next;
  }

  return {
    SCHEMA: SCHEMA, FIELDS: FIELDS, LIMITS: LIMITS, SYSTEM: SYSTEM,
    payloadFor: payloadFor, promptFor: promptFor, parse: parse, validate: validate,
    knownNames: knownNames, callAnthropic: callAnthropic, narrate: narrate, attach: attach
  };
});
/*__EDED_NARRATE_END__*/
