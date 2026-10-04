/*__EDED_LESSONS_START__*/
/* ============================================================================
   RESEARCH LESSONS — turning one game into something the next one can use.

   THE POINT OF THE WHOLE EDITORIAL SYSTEM is not the article. It is this
   file's output: a machine-readable row per finding, per game, that survives
   the week and can be counted at the end of a season. An article nobody reads
   twice is worth something; a question like "which of EdgeDesk's drivers has
   been contradicted most often this year?" being ANSWERABLE is worth more.

   WHAT A LESSON IS
     a category (QB, pressure, pace, market, data_quality, …)
     what EdgeDesk expected
     what actually happened
     what that means, in one sentence a person can act on
     a severity, and whether it warrants looking at the model

   WHAT A LESSON IS NOT, AND THIS IS ENFORCED:
     A lesson NEVER changes a model weight. Not here, not downstream, not by a
     flag this file sets. What it can do is open a MODEL REVIEW CANDIDATE, and
     a candidate is a question with evidence attached, which a person closes.
     One game is a sample of one, and a system that retunes itself on Sunday
     night has replaced a model with a memory of last week.

     So `model_review_required` opens an investigation. Nothing consumes it
     automatically, and reviews.js keeps a candidate open until a human writes
     a disposition on it. That asymmetry — easy to raise, only a person can
     close — is the shape a research memory has to have.

   THE AGGREGATE is the other half, and it is what PART 12 of the product
   brief actually asks for: `memory()` reads every lesson ever stored and
   answers the standing questions — which drivers fail most often, how often a
   winning number came with a broken thesis, where EdgeDesk systematically
   disagrees with the market and whether those disagreements have been worth
   anything.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDED = root.EDED || {};
  root.EDED.lessons = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SCHEMA = 'edgedesk_game_research_lesson_v1';
  var REVIEW_SCHEMA = 'edgedesk_model_review_candidate_v1';

  /* The category vocabulary. Closed, so a season's worth of lessons can be
     counted; extensible by adding a row, which is how a new sport or a new
     model layer joins the memory. */
  var CATEGORIES = [
    'QB', 'passing', 'rushing', 'offensive_line', 'defensive_line', 'pressure',
    'explosiveness', 'efficiency', 'defence', 'scoring', 'situational', 'pace',
    'home_field', 'travel', 'injuries', 'continuity', 'weather', 'special_teams',
    'coaching', 'turnovers', 'market', 'model_baseline', 'matchup', 'data_quality', 'variance'
  ];
  var SEVERITY = ['low', 'medium', 'high'];

  function txt(v) { if (v == null) return null; var s = String(v).replace(/\s+/g, ' ').trim(); return s || null; }
  function num(v) { if (v == null || v === '') return null; var n = +v; return isFinite(n) ? n : null; }
  function cat(c) { return CATEGORIES.indexOf(String(c)) >= 0 ? String(c) : 'matchup'; }

  /* ------------------------------------------------------------ one lesson */
  function lesson(o) {
    return {
      schema: SCHEMA,
      id: o.id,
      game_id: txt(o.game_id),
      sport: txt(o.sport),
      season: num(o.season),
      week: num(o.week),
      article_id: txt(o.article_id),
      snapshot_id: txt(o.snapshot_id),
      thesis_id: txt(o.thesis_id),
      team: txt(o.team),
      opponent: txt(o.opponent),
      category: cat(o.category),
      evaluation: txt(o.evaluation),
      pregame_expectation: txt(o.pregame_expectation),
      actual_result: txt(o.actual_result),
      lesson: txt(o.lesson),
      severity: SEVERITY.indexOf(o.severity) >= 0 ? o.severity : 'low',
      model_review_required: !!o.model_review_required,
      suggested_investigation: txt(o.suggested_investigation),
      /* the bet/process pair this lesson was learned inside, so a query can
         ask "show me lessons from games EdgeDesk won" without a join */
      bet_result: txt(o.bet_result),
      process_grade: txt(o.process_grade),
      created_at: o.created_at || new Date().toISOString()
    };
  }

  /* ----------------------------------------------------------- extraction */
  /* DETERMINISTIC. Reads the audit, the grading record and the snapshot, and
     produces lessons from the cases that actually teach something. A game
     where everything went as expected produces ONE lesson, not fourteen — a
     memory full of "the favourite was better and won" is a memory nobody can
     search. */
  function extract(o) {
    o = o || {};
    var snap = o.snapshot || {}, result = o.result || {}, graded = o.graded || {};
    var audit = o.audit || [];
    var now = o.now ? new Date(o.now).toISOString() : new Date().toISOString();
    var base = {
      game_id: result.game_id || (snap.game && snap.game.game_id),
      sport: result.sport || snap.sport,
      season: result.season != null ? result.season : snap.season,
      week: result.week != null ? result.week : snap.week,
      article_id: o.article_id, snapshot_id: snap.snapshot_id,
      bet_result: graded.bet_headline, process_grade: graded.process_headline,
      created_at: now
    };
    var out = [];
    var home = txt(result.home_team), away = txt(result.away_team);

    /* 1 — EVERY CONTRADICTED CLAIM IS A LESSON, GROUPED BY CATEGORY.
           This is the set that matters most and the set a system built to
           flatter itself would drop.

           One lesson PER CATEGORY, not per thesis. A model that prices
           passing through three separate drivers produces three contradicted
           claims about one thing, and three near-identical rows is both a
           duplicated paragraph on the page and a memory that double-counts
           when the season is totted up. The claims are all carried; the
           lesson is one. */
    var byCategory = Object.create(null);
    audit.filter(function (a) { return a.evaluation === 'NOT CONFIRMED'; }).forEach(function (a) {
      var k = cat(a.category) + '|' + (txt(a.favours_team) || '-');
      (byCategory[k] = byCategory[k] || []).push(a);
    });
    Object.keys(byCategory).forEach(function (k) {
      var group = byCategory[k].slice().sort(function (x, y) { return (num(y.weight) || 0) - (num(x.weight) || 0); });
      var lead = group[0];
      var weight = group.reduce(function (t, a) { return t + (num(a.weight) || 0); }, 0);
      var team = txt(lead.favours_team);
      out.push(lesson(Object.assign({}, base, {
        id: base.game_id + ':contradicted:' + cat(lead.category),
        thesis_id: group.map(function (a) { return a.thesis_id; }).join(' '),
        team: team,
        opponent: team === home ? away : home,
        category: cat(lead.category),
        evaluation: lead.evaluation,
        pregame_expectation: group.length === 1 ? lead.claim
          : group.length + ' published claims said the same thing: ' + group.map(function (a) { return a.claim; }).join(' '),
        actual_result: group.map(function (a) { return a.observed_result; }).filter(Boolean).join(' '),
        lesson: 'EdgeDesk named ' + (team || 'a side') + ' as better in ' + labelFor(lead)
          + ' and the game went the other way'
          + (group.length > 1 ? ', across ' + group.length + ' separate published claims' : '')
          + '. One game does not overturn a season-long rating, but this is the direction to watch: '
          + (lead.why || 'the expected signal did not appear.'),
        severity: weight >= 2 ? 'high' : 'medium',
        model_review_required: weight >= 2,
        suggested_investigation: weight >= 2
          ? 'These claims carried ' + (Math.round(weight * 10) / 10) + ' points of the published number between them and were contradicted. Check whether the same category has been contradicted in other games this season before touching anything.'
          : null
      })));
    });

    /* 2 — WHAT COULD NOT BE GRADED IS ALSO A LESSON, and a more useful one
           than it looks: a driver EdgeDesk cannot check on itself is a hole in
           the platform, and the aggregate below counts them. */
    var blind = audit.filter(function (a) {
      return a.evaluation === 'INCONCLUSIVE' && a.kind !== 'uncertainty'
        && !/model constant/i.test(String(a.why || ''));
    });
    if (blind.length) {
      out.push(lesson(Object.assign({}, base, {
        id: base.game_id + ':unobservable',
        category: 'data_quality',
        evaluation: 'INCONCLUSIVE',
        pregame_expectation: blind.length + ' of the claims in this article rested on '
          + unique(blind.map(function (a) { return a.category; })).join(', ') + '.',
        actual_result: 'None of them could be graded: ' + unique(blind.map(function (a) { return txt(a.why); }).filter(Boolean)).slice(0, 2).join('; ') + '.',
        lesson: 'EdgeDesk prices these games partly on signals it has no way to observe afterwards. That is not an error in the model — it is a gap in the audit, and it means the platform cannot tell, from results alone, whether those parts of the number are earning their weight.',
        severity: blind.length >= 4 ? 'medium' : 'low',
        model_review_required: false,
        suggested_investigation: 'Consider whether a postgame data source exists for ' + unique(blind.map(function (a) { return a.category; })).slice(0, 3).join(', ') + '.'
      })));
    }

    /* 3 — THE PROCESS/RESULT DIVERGENCE, when there is one. The single most
           valuable row in the whole store. */
    var betOut = graded.bet_result && graded.bet_result.spread && graded.bet_result.spread.outcome;
    var pg = graded.process_headline;
    if (betOut === 'win' && pg === 'UNSOUND') {
      out.push(lesson(Object.assign({}, base, {
        id: base.game_id + ':won_wrong',
        category: 'variance',
        evaluation: 'NOT CONFIRMED',
        pregame_expectation: 'The number implied ' + (graded.implied_side && graded.implied_side.line_text) + '.',
        actual_result: 'It graded a win. The reasoning behind it did not hold: ' + (graded.process.reasons || [])[0],
        lesson: 'A winning number built on a reading the game contradicted. Nothing about this result should increase confidence in the mechanism EdgeDesk named, and treating it as confirmation is how a model gets worse while its record gets better.',
        severity: 'high', model_review_required: true,
        suggested_investigation: 'Why did the number land while the mechanism failed? Either the number was right for a reason EdgeDesk has not identified, or it was luck. Both are worth knowing and they are different.'
      })));
    }
    if (betOut === 'loss' && pg === 'SOUND') {
      out.push(lesson(Object.assign({}, base, {
        id: base.game_id + ':lost_right',
        category: 'variance',
        evaluation: 'CONFIRMED',
        pregame_expectation: 'The number implied ' + (graded.implied_side && graded.implied_side.line_text) + '.',
        actual_result: 'It graded a loss, and the reasoning held up: ' + (graded.process.reasons || [])[0],
        lesson: 'A losing number on a read the game supported. This is the result type that should change the least. Over-correcting on it is how a defensible process gets thrown away for a distribution doing what distributions do.',
        severity: 'low', model_review_required: false,
        suggested_investigation: null
      })));
    }

    /* 4 — A MODEL THAT MISSED BY A LOT. The margin and total errors are the
           model's own, against its own published range. */
    var acc = graded.model_accuracy;
    if (acc && acc.available) {
      if (acc.inside_published_range === false) {
        out.push(lesson(Object.assign({}, base, {
          id: base.game_id + ':outside_range',
          category: 'model_baseline',
          evaluation: 'NOT CONFIRMED',
          pregame_expectation: 'The model published an outcome range of ' + acc.range_text + '.',
          actual_result: 'The game finished outside it, at a margin of ' + Math.abs(acc.actual_home_margin) + '.',
          lesson: 'The published range is meant to contain eight results in ten. A miss is expected roughly twice in ten games and is only a problem in aggregate — which is exactly what this store exists to measure.',
          severity: 'medium', model_review_required: false,
          suggested_investigation: 'Count range misses across the season. A rate materially above 20% means the model’s stated uncertainty is too narrow.'
        })));
      }
      if (acc.total_error != null && acc.total_error >= 14) {
        out.push(lesson(Object.assign({}, base, {
          id: base.game_id + ':total_miss',
          category: 'scoring',
          evaluation: 'NOT CONFIRMED',
          pregame_expectation: 'EdgeDesk published a fair total of ' + acc.projected_total + '.',
          actual_result: 'The game finished with ' + acc.actual_total + ' points, an error of ' + acc.total_error + '.',
          lesson: 'A total missed by this much usually means a pace or a finishing assumption was wrong, not that both ratings were. Check which of the two moved.',
          severity: acc.total_error >= 21 ? 'high' : 'medium',
          model_review_required: acc.total_error >= 21,
          suggested_investigation: 'Was the play count or the points per drive the miss? Both are in this game’s result record.'
        })));
      }
    }

    /* 5 — WHAT THE MARKET GOT RIGHT. Credited explicitly, because a research
           platform that never records the market beating it is not keeping a
           record, it is keeping a scrapbook. */
    var mg = audit.filter(function (a) { return a.thesis_id === 'market_gap'; })[0];
    if (mg && (mg.evaluation === 'NOT CONFIRMED' || mg.evaluation === 'PARTIALLY CONFIRMED')) {
      out.push(lesson(Object.assign({}, base, {
        id: base.game_id + ':market_better',
        category: 'market',
        evaluation: mg.evaluation,
        pregame_expectation: mg.claim,
        actual_result: mg.observed_result + ' ' + (mg.why || ''),
        lesson: mg.evaluation === 'NOT CONFIRMED'
          ? 'The market had the better estimate here. EdgeDesk’s disagreement was not information on this game, and the honest reading is that the price already contained what the model thought it had found.'
          : 'EdgeDesk was directionally with the market’s eventual answer but wrong about the size. The market’s number was closer.',
        severity: 'medium',
        model_review_required: false,
        suggested_investigation: 'Track disagreements of this size across the season. The question is not whether one landed; it is whether the class of them has any edge at all.'
      })));
    }
    if (mg && mg.evaluation === 'CONFIRMED') {
      out.push(lesson(Object.assign({}, base, {
        id: base.game_id + ':disagreement_landed',
        category: 'market',
        evaluation: 'CONFIRMED',
        pregame_expectation: mg.claim,
        actual_result: mg.observed_result + ' ' + (mg.why || ''),
        lesson: 'The disagreement landed. One landing proves nothing on its own; the aggregate of them, held against the closing line, is the only thing that would.',
        severity: 'low', model_review_required: false,
        suggested_investigation: null
      })));
    }

    /* 6 — A CLEAN GAME STILL PRODUCES ONE ROW, so the memory knows this game
           was audited and found nothing, rather than having no opinion. */
    if (!out.length) {
      out.push(lesson(Object.assign({}, base, {
        id: base.game_id + ':as_expected',
        category: 'matchup',
        evaluation: 'CONFIRMED',
        pregame_expectation: 'EdgeDesk’s published read of this matchup.',
        actual_result: (o.tally && o.tally.headline) || 'The game was consistent with the pregame research.',
        lesson: 'Nothing in this game contradicted the research. That is a data point, not a validation: the games that teach are the ones that go wrong.',
        severity: 'low', model_review_required: false, suggested_investigation: null
      })));
    }
    return out;
  }

  function labelFor(a) {
    return String(a.category || 'this matchup').replace(/_/g, ' ');
  }
  function unique(a) { return (a || []).filter(function (v, i, arr) { return v != null && arr.indexOf(v) === i; }); }

  /* ---------------------------------------------- model review candidates */
  /* RAISED BY EVIDENCE, CLOSED BY A PERSON. A candidate accumulates the games
     that produced it; it never edits a weight and nothing downstream reads it
     as an instruction. */
  function reviewCandidates(lessons, prior, opts) {
    opts = opts || {};
    var now = opts.now ? new Date(opts.now).toISOString() : new Date().toISOString();
    var byKey = Object.create(null);
    (prior || []).forEach(function (c) { if (c && c.key) byKey[c.key] = JSON.parse(JSON.stringify(c)); });

    (lessons || []).filter(function (l) { return l.model_review_required; }).forEach(function (l) {
      var key = l.sport + ':' + l.category + ':' + (l.thesis_id ? l.thesis_id.split('.')[0] : 'general');
      var c = byKey[key];
      if (!c) {
        c = byKey[key] = {
          schema: REVIEW_SCHEMA, key: key, sport: l.sport, category: l.category,
          question: 'Does EdgeDesk’s ' + String(l.category).replace(/_/g, ' ')
            + ' handling need investigating? Raised by a published article whose claim the game contradicted.',
          status: 'open', opened_at: now, updated_at: now,
          evidence: [], occurrences: 0,
          disposition: null, disposition_note: null, closed_at: null, closed_by: null,
          rule: 'A review candidate is a question with evidence attached. Nothing in this repository changes a model weight from it, and only a person may close one.'
        };
      }
      if (c.status === 'closed' && c.disposition === 'wont_fix') return;   /* respect a person's decision */
      if (!c.evidence.some(function (e) { return e.lesson_id === l.id; })) {
        c.evidence.push({ lesson_id: l.id, game_id: l.game_id, season: l.season, week: l.week,
          team: l.team, expectation: l.pregame_expectation, result: l.actual_result,
          severity: l.severity, at: l.created_at });
        c.occurrences = c.evidence.length;
        c.updated_at = now;
        /* a candidate that keeps recurring says so; it still does not act */
        if (c.occurrences >= 3 && c.status === 'open') {
          c.recurring = true;
          c.note = 'Seen ' + c.occurrences + ' times. A recurring contradiction is worth a real investigation — still by a person, and still against a holdout the fit has never seen.';
        }
        if (c.status === 'closed') { c.status = 'reopened'; c.closed_at = null; }
      }
    });
    return Object.keys(byKey).map(function (k) { return byKey[k]; })
      .sort(function (a, b) { return (b.occurrences || 0) - (a.occurrences || 0); });
  }

  /* --------------------------------------------------- long-term memory */
  /* THE STANDING QUESTIONS, answered from the stored lessons and the stored
     grades. Every figure carries its own n, and a question with too small a
     sample answers "not enough yet" rather than producing a percentage
     somebody would quote. */
  var MIN_N = 8;
  function memory(o) {
    o = o || {};
    var lessons = o.lessons || [], grades = o.grades || [];
    function rate(n, d) { return d >= MIN_N ? Math.round((n / d) * 1000) / 10 : null; }

    /* which drivers fail most often */
    var byCat = Object.create(null);
    lessons.forEach(function (l) {
      var c = byCat[l.category] || (byCat[l.category] = { category: l.category, lessons: 0, contradicted: 0, confirmed: 0, reviews: 0 });
      c.lessons++;
      if (l.evaluation === 'NOT CONFIRMED') c.contradicted++;
      if (l.evaluation === 'CONFIRMED') c.confirmed++;
      if (l.model_review_required) c.reviews++;
    });
    var categories = Object.keys(byCat).map(function (k) {
      var c = byCat[k];
      c.contradiction_rate = rate(c.contradicted, c.lessons);
      return c;
    }).sort(function (a, b) { return b.contradicted - a.contradicted; });

    /* the four quadrants, counted */
    var quad = { right_right: 0, right_wrong: 0, wrong_right: 0, wrong_wrong: 0, untested: 0, ungraded: 0 };
    var clvRows = [], gapRows = [];
    grades.forEach(function (g) {
      var bet = g.bet_result && g.bet_result.spread && g.bet_result.spread.outcome;
      var pg = g.process_headline;
      if (!bet) { quad.ungraded++; }
      else if (pg === 'UNTESTED') quad.untested++;
      else if (bet === 'win' && pg === 'SOUND') quad.right_right++;
      else if (bet === 'win' && pg === 'UNSOUND') quad.right_wrong++;
      else if (bet === 'loss' && pg === 'SOUND') quad.wrong_right++;
      else if (bet === 'loss' && pg === 'UNSOUND') quad.wrong_wrong++;
      if (g.closing_line && g.closing_line.available && g.closing_line.clv_points != null) {
        clvRows.push(g.closing_line.clv_points);
      }
      if (g.implied_side && g.implied_side.available && g.implied_side.gap != null && bet) {
        gapRows.push({ gap: g.implied_side.gap, outcome: bet, side: g.implied_side.side });
      }
    });
    var decided = quad.right_right + quad.right_wrong + quad.wrong_right + quad.wrong_wrong;

    /* does EdgeDesk win for the reasons it says it will? */
    var wins = quad.right_right + quad.right_wrong;
    var losses = quad.wrong_right + quad.wrong_wrong;

    /* where does EdgeDesk systematically disagree, and is the disagreement
       worth anything? Bucketed by the size of the gap, which is the question
       the model's own validation line already asks. */
    var buckets = [
      { label: 'under 2 points', lo: 0, hi: 2 }, { label: '2 to 4 points', lo: 2, hi: 4 },
      { label: '4 to 7 points', lo: 4, hi: 7 }, { label: '7 points or more', lo: 7, hi: Infinity }
    ].map(function (b) {
      var rows = gapRows.filter(function (r) { return r.gap >= b.lo && r.gap < b.hi; });
      var w = rows.filter(function (r) { return r.outcome === 'win'; }).length;
      var l = rows.filter(function (r) { return r.outcome === 'loss'; }).length;
      return { label: b.label, n: rows.length, wins: w, losses: l,
        hit_rate: rate(w, w + l),
        note: (w + l) < MIN_N ? 'not enough graded games in this bucket to say anything' : null };
    });

    var avgClv = clvRows.length >= MIN_N
      ? Math.round((clvRows.reduce(function (a, b) { return a + b; }, 0) / clvRows.length) * 100) / 100 : null;

    return {
      schema: 'edgedesk_research_memory_v1',
      generated_at: o.now ? new Date(o.now).toISOString() : new Date().toISOString(),
      min_sample: MIN_N,
      lessons: lessons.length,
      graded_games: grades.length,
      categories: categories,
      quadrants: quad,
      answers: {
        'Do EdgeDesk’s winning numbers come from the mechanisms it named?':
          wins >= MIN_N ? quad.right_right + ' of ' + wins + ' winning numbers came with a process grade of SOUND ('
            + rate(quad.right_right, wins) + '%). The rest paid without confirming the reasoning.'
            : 'Not enough graded wins yet (' + wins + ' of ' + MIN_N + ').',
        'What share of winning wagers had incorrect reasoning?':
          wins >= MIN_N ? rate(quad.right_wrong, wins) + '% (' + quad.right_wrong + ' of ' + wins + ').'
            : 'Not enough graded wins yet (' + wins + ' of ' + MIN_N + ').',
        'What share of losing wagers still showed a defensible process?':
          losses >= MIN_N ? rate(quad.wrong_right, losses) + '% (' + quad.wrong_right + ' of ' + losses + ').'
            : 'Not enough graded losses yet (' + losses + ' of ' + MIN_N + ').',
        'Which model drivers fail most often?':
          categories.length ? categories.slice(0, 3).map(function (c) {
            return c.category + ' (' + c.contradicted + ' contradicted of ' + c.lessons + ')';
          }).join(', ') : 'No lessons stored yet.',
        'Where does EdgeDesk disagree with the market, and is it worth anything?':
          gapRows.length >= MIN_N ? buckets.filter(function (b) { return b.n; }).map(function (b) {
            return b.label + ': ' + b.n + ' games' + (b.hit_rate != null ? ', ' + b.hit_rate + '% landed' : ', too few to rate');
          }).join('; ') : 'Not enough graded disagreements yet (' + gapRows.length + ' of ' + MIN_N + ').',
        'Has the market moved toward EdgeDesk after publication?':
          avgClv != null ? 'Average ' + (avgClv > 0 ? '+' : '') + avgClv + ' points of line movement toward EdgeDesk’s side across ' + clvRows.length + ' games with a captured close.'
            : 'Not enough games with both a captured quote and a closing line yet (' + clvRows.length + ' of ' + MIN_N + ').'
      },
      disagreement_buckets: buckets,
      clv: { n: clvRows.length, average_points: avgClv },
      /* said here rather than left to a reader, because a research memory that
         reads as a track record is a track record */
      caveat: 'These are counts of EdgeDesk’s own published research against its own published audits. They are a measure of internal consistency and of process, not a betting record, and no figure here is computed on a sample the system considers sufficient unless it says so.',
      decided: decided
    };
  }

  return {
    SCHEMA: SCHEMA, REVIEW_SCHEMA: REVIEW_SCHEMA, CATEGORIES: CATEGORIES, SEVERITY: SEVERITY, MIN_N: MIN_N,
    lesson: lesson, extract: extract, reviewCandidates: reviewCandidates, memory: memory
  };
});
/*__EDED_LESSONS_END__*/
