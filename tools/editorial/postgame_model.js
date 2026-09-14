/*__EDED_POSTGAME_START__*/
/* ============================================================================
   THE POSTGAME ARTICLE — what happened, what we said, and what we learned.

   IT IS THE SAME KIND OF RECORD AS A PREGAME ARTICLE, deliberately. It has an
   `article_type` of `postgame`, it lives in the same store, it is rendered by
   the same renderer, it appears in the same hubs and the same sitemap, and it
   goes through the same publication checks plus its own. Building a second
   article system beside the first would have meant two stores, two builds,
   two sitemaps and two places for a URL to come from — and the repository's
   own rule is not to do that.

   WHAT IT MAY SAY, AND WHERE EVERY SENTENCE COMES FROM
     the snapshot   what EdgeDesk said before kickoff, verbatim and unedited
     the result     the final score and the box score, from the providers
     the audit      the verdict on each claim, computed in theses.js
     the grading    bet result and process grade, computed in grading.js
     the lessons    computed in lessons.js
   Nothing in this file computes a projection, a verdict or a grade. It
   SELECTS, ORDERS and LABELS, which is the same contract article_model.js
   holds for the pregame half.

   THE ONE RULE THAT OUTRANKS EVERY OTHER: the "what EdgeDesk expected"
   section is read from the snapshot and is NEVER rewritten in the light of
   the result. A postgame article that softened its own pregame thesis would
   be worse than no postgame article at all, and `quality.js` asserts the
   pregame claims on the page are byte-identical to the ones in the snapshot.

   AND THE SECOND RULE: "What EdgeDesk got wrong" is a required section. It is
   not dropped because the number landed. A record that only criticises itself
   in defeat is a marketing asset wearing a lab coat.
   ========================================================================== */
(function (root, factory) {
  var api = factory(
    typeof require === 'function' ? require('../articles/article_model.js') : (root.EDART && root.EDART.model),
    typeof require === 'function' ? require('./results.js') : (root.EDED && root.EDED.results)
  );
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDED = root.EDED || {};
  root.EDED.postgame = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (AMODEL, RESULTS) {
  'use strict';

  var SCHEMA = 'edgedesk_postgame_article_v1';
  var SITE = AMODEL.SITE;
  var AUTHOR = AMODEL.AUTHOR;

  function num(v) { if (v == null || v === '') return null; var n = +v; return isFinite(n) ? n : null; }
  function txt(v) { if (v == null) return null; var s = String(v).replace(/\s+/g, ' ').trim(); return s || null; }
  function sentence(s) { s = txt(s); if (!s) return null; if (!/[.!?]$/.test(s)) s += '.'; return s; }
  function list(v, n) {
    if (!Array.isArray(v)) return [];
    var out = [];
    for (var i = 0; i < v.length && (n == null || out.length < n); i++) { var s = txt(v[i]); if (s) out.push(s); }
    return out;
  }

  /* ------------------------------------------------------------- headline */
  function headlineFor(away, home) {
    return away + ' vs. ' + home + ' Postgame Analysis: What Happened, What We Got Right and What We Learned';
  }
  /* A SEARCH RESULT SHOWS ABOUT SIXTY CHARACTERS, and two full club names plus
     a score is already most of that. So the title is the matchup, the score
     and the one thing that distinguishes this page from every other recap —
     that EdgeDesk audits what it said beforehand — and nothing else. */
  function seoTitleFor(o) {
    return (o.away + ' ' + o.away_score + '-' + o.home_score + ' ' + o.home
      + ': EdgeDesk Postgame Thesis Audit').replace(/\s+/g, ' ').trim();
  }
  /* Assembled from figures the record actually carries, in a fixed order, and
     it STOPS when it runs out of room rather than running to three hundred
     characters of tail no search result will ever show. The closing sentence
     is always the same one, so it is reserved before the middle is filled. */
  function seoDescriptionFor(o, g) {
    var tail = ' Research, not picks.';
    var head = o.winner
      ? o.winner + ' beat ' + (o.winner === o.home ? o.away : o.home) + ' '
        + Math.max(o.home_score, o.away_score) + '-' + Math.min(o.home_score, o.away_score) + '.'
      : o.away + ' and ' + o.home + ' finished level at ' + o.home_score + '.';
    var middle = [];
    if (g && g.bet_result && g.bet_result.spread && g.implied_side && g.implied_side.line_text) {
      middle.push('EdgeDesk’s number implied ' + g.implied_side.line_text + ' — '
        + g.bet_result.spread.outcome + '.');
    }
    if (o.tally && o.tally.headline) middle.push(cap(o.tally.headline) + '.');
    if (g && g.process_headline) middle.push('Process grade: ' + g.process_headline + '.');
    var s = head;
    for (var i = 0; i < middle.length; i++) {
      if ((s + ' ' + middle[i] + tail).length > 195) break;
      s += ' ' + middle[i];
    }
    return s + tail;
  }
  function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
  /* THE SLUG IS THE PREGAME SLUG PLUS A SUFFIX. Both articles are about one
     game and a reader who has one URL can guess the other, which is the whole
     point of a before/after pair. */
  function slugFor(pregameSlug, fallback) {
    var base = txt(pregameSlug) || txt(fallback);
    return base ? base + '-postgame-analysis' : null;
  }

  /* ----------------------------------------------------------- the sections */

  function resultSection(rec) {
    var res = rec.result || {}, g = rec.grading || {};
    var cards = [];
    cards.push({ k: 'Final score', score: {
      away: { team: res.away_team, points: String(res.away_score) },
      home: { team: res.home_team, points: String(res.home_score) }
    }, wide: true, lead: true, sub: res.status_name ? null : null });
    if (g.implied_side && g.implied_side.available && g.bet_result && g.bet_result.spread) {
      cards.push({ k: 'Spread result', v: g.bet_result.spread.outcome.toUpperCase(),
        tone: 'status',
        sub: g.implied_side.line_text + ' — ' + (g.bet_result.spread.outcome === 'push'
          ? 'the margin landed exactly on the number'
          : (g.bet_result.spread.cover_margin > 0 ? 'covered by ' + g.bet_result.spread.cover_margin : 'short by ' + Math.abs(g.bet_result.spread.cover_margin)) + ' points') });
    } else {
      cards.push({ k: 'Spread result', absent: true, wide: true,
        why: sentence(g.implied_side && g.implied_side.why) });
    }
    if (g.bet_result && g.bet_result.total) {
      var t = g.bet_result.total;
      cards.push({ k: 'Total result', v: t.outcome.toUpperCase(),
        sub: t.points + ' points against a captured total of ' + t.line
          + (t.outcome === 'push' ? '' : ', ' + t.by + ' points ' + t.direction) });
    }
    if (g.bet_result && g.bet_result.moneyline) {
      cards.push({ k: 'Moneyline', v: g.bet_result.moneyline.outcome.toUpperCase(),
        sub: 'on ' + g.bet_result.moneyline.team });
    }
    if (g.closing_line && g.closing_line.available) {
      cards.push({ k: 'Closing-line value', v: (g.closing_line.clv_points > 0 ? '+' : '') + g.closing_line.clv_points + ' pts',
        sub: g.closing_line.captured_home_margin + ' at capture → ' + g.closing_line.closing_home_margin + ' at the close'
          + (g.closing_line.close_source ? ' (' + g.closing_line.close_source + ')' : '') });
    } else if (g.closing_line) {
      cards.push({ k: 'Closing-line value', absent: true, wide: true, why: sentence(g.closing_line.why) });
    }
    /* THE SEPARATION NOTE LIVES IN THE PROCESS SECTION AND NOWHERE ELSE. It
       used to be here too, which put the same paragraph on the page twice. */
    return { kind: 'snapshot', title: 'The result', cards: cards,
      notes: ['The spread and total columns above grade the side EdgeDesk’s own number implied against the quote it captured before kickoff. EdgeDesk publishes research, not picks: this is how it keeps itself honest, not a record of wagers.'],
      priced: true };
  }

  /* WHAT EDGEDESK EXPECTED — read from the snapshot, unedited. */
  function expectedSection(rec) {
    var s = rec.snapshot || {}, m = s.model || {};
    var cards = [];
    if (m.priced) {
      cards.push({ k: 'EdgeDesk’s pregame number', v: m.fair_spread_text, lead: true,
        sub: 'published ' + (rec.pregame_published_at ? 'on ' + String(rec.pregame_published_at).slice(0, 10) : 'before kickoff') + ' and not edited since' });
      if (m.score) {
        cards.push({ k: 'Projected score', score: m.score, wide: true,
          sub: m.total ? 'from the model’s own margin and a ' + m.total + ' total' : null });
      }
      if (m.total) cards.push({ k: 'EdgeDesk fair total', v: m.total });
      if (m.win_prob) {
        cards.push({ k: 'Pregame win probability', pair: [
          { team: m.win_prob.away, v: m.win_prob.away_pct + '%' },
          { team: m.win_prob.home, v: m.win_prob.home_pct + '%' }
        ] });
      }
      if (m.outcome_range) {
        cards.push({ k: 'Published outcome range', v: m.outcome_range.p10 + ' → ' + m.outcome_range.p90,
          sub: m.outcome_range.basis_team ? 'from ' + m.outcome_range.basis_team + '’s perspective' : null });
      }
    } else {
      cards.push({ k: 'EdgeDesk’s pregame number', absent: true, wide: true,
        why: sentence(m.absent_reason || 'EdgeDesk did not price this matchup') });
    }
    if (s.market && s.market.available) {
      cards.push({ k: 'The market, at capture', v: txt(s.market.market),
        sub: (s.market.book ? txt(s.market.book) + ' · ' : '') + 'the book’s number, not EdgeDesk’s' });
    }
    if (m.status) cards.push({ k: 'Pregame research state', v: m.status, tone: 'status', sub: txt(m.status_note) });
    var acc = (rec.grading && rec.grading.model_accuracy) || null;
    var notes = [];
    notes.push('Every figure in this section is read from the research snapshot captured before kickoff. It has not been edited in the light of the result, and the article system refuses to publish a postgame page whose pregame claims do not match that snapshot exactly.');
    if (acc && acc.available && acc.margin_error != null) {
      notes.push('Against the final: ' + acc.margin_error + ' points of margin error'
        + (acc.total_error != null ? ' and ' + acc.total_error + ' points of total error' : '')
        + (acc.inside_published_range === true ? '. The result landed inside the range the model published.'
          : acc.inside_published_range === false ? '. The result landed OUTSIDE the range the model published.' : '.'));
    }
    return { kind: 'snapshot', title: 'What EdgeDesk expected', cards: cards, notes: notes, priced: true };
  }

  /* WHAT ACTUALLY HAPPENED — the box score, as a comparison table, and only
     the metrics the provider actually published. */
  var STAT_ORDER = [
    'points', 'total_yards', 'yards_per_play', 'total_plays', 'net_pass_yards', 'yards_per_pass',
    'completion_pct', 'rush_yards', 'yards_per_rush', 'first_downs', 'third_down_pct',
    'red_zone_pct', 'turnovers', 'turnover_margin', 'sacks_generated', 'penalties',
    'penalty_yards', 'possession_seconds', 'points_per_drive', 'yards_per_drive', 'plays_per_minute'
  ];
  function fmtStat(metric, v) {
    if (v == null) return null;
    if (metric === 'possession_seconds') {
      var m = Math.floor(v / 60), s = Math.round(v % 60);
      return m + ':' + (s < 10 ? '0' : '') + s;
    }
    var M = RESULTS.METRICS[metric] || {};
    if (M.unit === '%') return (Math.round(v * 10) / 10) + '%';
    if (metric === 'turnover_margin') return (v > 0 ? '+' : '') + v;
    return String(Math.round(v * 100) / 100);
  }
  function happenedSection(rec) {
    var res = rec.result || {};
    var hm = (res.metrics && res.metrics.home) || {}, am = (res.metrics && res.metrics.away) || {};
    var rows = [];
    STAT_ORDER.forEach(function (k) {
      if (hm[k] == null && am[k] == null) return;
      var M = RESULTS.METRICS[k] || {};
      var better = null;
      if (M.better && hm[k] != null && am[k] != null && hm[k] !== am[k]) {
        better = (M.better === 'low') ? (hm[k] < am[k] ? 'h' : 'a') : (hm[k] > am[k] ? 'h' : 'a');
      }
      rows.push({ cat: k, k: M.label || k,
        a: { v: fmtStat(k, am[k]), n: am[k] == null ? null : am[k] },
        h: { v: fmtStat(k, hm[k]), n: hm[k] == null ? null : hm[k] },
        edge: better ? { side: better } : null });
    });
    if (!rows.length) return null;
    return { kind: 'breakdown', title: 'What actually happened',
      cols: [res.away_team, res.home_team],
      groups: [{ title: 'Team statistics', rows: rows }],
      context_label: 'FROM THE BOX SCORE — ' + ((res.agreed_by || []).join(' and ') || res.primary_source)
        + '. Only the statistics the provider published for this game appear; nothing is estimated and a blank is a blank.' };
  }

  /* WHY THE GAME TURNED — the two to four largest observed separations, plus
     the provider's own biggest win-probability swing when it published one. */
  function turnedSection(rec) {
    var res = rec.result || {}, g = rec.grading || {};
    var items = [];
    var hm = (res.metrics && res.metrics.home) || {}, am = (res.metrics && res.metrics.away) || {};
    var candidates = ['turnover_margin', 'yards_per_play', 'third_down_pct', 'sacks_generated',
      'yards_per_pass', 'yards_per_rush', 'red_zone_pct', 'points_per_drive', 'penalty_yards'];
    candidates.forEach(function (k) {
      if (hm[k] == null || am[k] == null) return;
      if (!RESULTS.atSize(k, hm[k], am[k])) return;
      var M = RESULTS.METRICS[k];
      var homeBetter = M.better === 'low' ? hm[k] < am[k] : hm[k] > am[k];
      if (hm[k] === am[k]) return;
      var winner = homeBetter ? res.home_team : res.away_team;
      var loser = homeBetter ? res.away_team : res.home_team;
      items.push({
        sev: 'HIGH', label: M.label,
        text: winner + ' won ' + M.label + ' ' + fmtStat(k, homeBetter ? hm[k] : am[k])
          + ' to ' + fmtStat(k, homeBetter ? am[k] : hm[k]) + ' against ' + loser
          + ' — a separation wide enough in one game to be worth naming.'
      });
    });
    (g.variance_markers || []).forEach(function (v) {
      items.push({ sev: v.severity === 'high' ? 'HIGH' : 'MEDIUM', label: v.label, text: v.text });
    });
    var wp = res.win_probability;
    if (wp && wp.largest_swing && wp.largest_swing.delta != null) {
      items.push({ sev: 'MEDIUM', label: 'The largest single swing',
        text: 'The provider’s own win-probability series moved '
          + Math.abs(Math.round(wp.largest_swing.delta * 1000) / 10) + ' percentage points on one play, from '
          + Math.round(wp.largest_swing.from * 1000) / 10 + '% to ' + Math.round(wp.largest_swing.to * 1000) / 10
          + '% for the home side. That is the provider’s number, not EdgeDesk’s.' });
    }
    if (!items.length) return null;
    return { kind: 'uncertainty', title: 'Why the game turned',
      lede: 'The separations below are the ones wide enough, in a single game, to be worth naming. Everything the two teams did within a normal game-to-game range is deliberately left out: a list of every statistic is not an explanation.',
      items: items.slice(0, 6), unmeasured: [], missing: [] };
  }

  /* THESIS AUDIT — the table that is the product. */
  function auditSection(rec) {
    var audit = rec.audit || [];
    if (!audit.length) return null;
    var order = { 'NOT CONFIRMED': 0, 'CONFIRMED': 1, 'PARTIALLY CONFIRMED': 2, 'INCONCLUSIVE': 3 };
    var rows = audit.slice().sort(function (a, b) {
      var d = (order[a.evaluation] == null ? 9 : order[a.evaluation]) - (order[b.evaluation] == null ? 9 : order[b.evaluation]);
      if (d) return d;
      return (num(b.weight) || 0) - (num(a.weight) || 0);
    }).map(function (a) {
      return {
        thesis_id: a.thesis_id, evaluation: a.evaluation, confidence: a.confidence,
        claim: a.claim, observed: a.observed_result, why: a.why,
        category: a.category, weight: a.weight,
        sample_note: a.sample_note || null
      };
    });
    return { kind: 'thesis_audit', title: 'Thesis audit',
      lede: 'Every claim EdgeDesk published before this game, graded against what the statistics actually show. The wording of each claim is the wording that was published; none of it has been softened.',
      tally: rec.tally || null, rows: rows,
      legend: [
        { k: 'CONFIRMED', v: 'the expected signal appeared, on the right side, at a size one game can support' },
        { k: 'PARTIALLY CONFIRMED', v: 'the direction was right; the size was not, or only some of the expected signals appeared' },
        { k: 'NOT CONFIRMED', v: 'the signal ran the other way' },
        { k: 'INCONCLUSIVE', v: 'the statistics published for this game cannot grade the claim either way' }
      ] };
  }

  /* RESULT VERSUS PROCESS. */
  function processSection(rec) {
    var g = rec.grading || {};
    return { kind: 'process', title: 'Result versus process',
      bet: g.bet_headline, process: g.process_headline,
      verdict: g.verdict && g.verdict.line,
      verdict_key: g.verdict && g.verdict.key,
      reasons: (g.process && g.process.reasons) || [],
      note: g.separation_note,
      questions: [
        { q: 'Did the number land?', a: g.bet_result && g.bet_result.spread
          ? 'On the spread, ' + g.bet_result.spread.outcome + '. ' + (g.implied_side && g.implied_side.line_text
            ? 'EdgeDesk’s own number implied ' + g.implied_side.line_text + ' against the quote it captured.' : '')
          : (g.implied_side && g.implied_side.why) || 'There was no captured market number, so there is nothing to grade.' },
        { q: 'Was the reasoning good?', a: (g.process && g.process.reasons && g.process.reasons[0]) || 'Not gradeable.' },
        { q: 'Did EdgeDesk identify a real edge?', a: g.closing_line && g.closing_line.available
          ? g.closing_line.note
          : (g.closing_line && g.closing_line.why) || 'No closing line is held for this game, so the only real test of an edge cannot be run on it.' },
        { q: 'Did variance decide it?', a: (g.variance_markers || []).length
          ? (g.variance_markers || []).map(function (v) { return v.label; }).join('; ') + '.'
          : 'No high-variance marker was detected in the published statistics for this game.' }
      ] };
  }

  /* WHAT EACH SIDE GOT RIGHT AND WRONG — three panels, and the third one is
     never dropped. */
  function scorecardSection(rec) {
    var audit = rec.audit || [], g = rec.grading || {};
    var confirmed = audit.filter(function (a) { return a.evaluation === 'CONFIRMED'; });
    var wrong = audit.filter(function (a) { return a.evaluation === 'NOT CONFIRMED'; });
    var mg = audit.filter(function (a) { return a.thesis_id === 'market_gap'; })[0];

    var market = [];
    if (mg) {
      if (mg.evaluation === 'NOT CONFIRMED') {
        market.push('The price was closer to the outcome than EdgeDesk’s number was. ' + (mg.why || ''));
      } else if (mg.evaluation === 'PARTIALLY CONFIRMED') {
        market.push('The market had the better estimate of the size. ' + (mg.why || ''));
      } else if (mg.evaluation === 'CONFIRMED') {
        market.push('The market’s number was beaten on this game. One game does not make that a pattern, and EdgeDesk’s own validation line already says this model does not beat the close out of sample.');
      } else {
        market.push(mg.why || 'The disagreement could not be graded on this game.');
      }
    } else {
      market.push('No sportsbook quote was captured before kickoff, so there is nothing to credit the market with or take from it on this game.');
    }
    if (g.closing_line && g.closing_line.available && !g.closing_line.moved_toward_edgedesk) {
      market.push(g.closing_line.note);
    }

    /* TWO FIELDS, NOT ONE GLUED SENTENCE. Joining the claim and the
       observation with a dash produced a list of seven bullets that all began
       "— Seattle Seahawks", which reads as generated text and is not: it is a
       table wearing a sentence. The renderer prints the claim and what was
       observed as two lines. */
    var right = confirmed.map(function (a) { return { claim: a.claim, observed: a.observed_result || null }; });
    if (!right.length) {
      right.push({ claim: 'Nothing EdgeDesk published about this game was confirmed at a size a single game can support. That is the honest answer and it is printed rather than padded.' });
    }
    var got = wrong.map(function (a) {
      return { claim: a.claim, observed: a.observed_result || null, why: a.why || null };
    });
    if (!got.length) {
      /* THE SECTION IS NEVER EMPTY AND NEVER REMOVED. */
      got.push({ claim: 'No published claim was contradicted by the statistics for this game. That is not the same as being right: '
        + ((rec.tally && rec.tally.not_observable) || 0) + ' of the claims in the original article could not be graded at all, '
        + 'and a game that confirms nothing and contradicts nothing has told EdgeDesk very little.' });
    }
    return { kind: 'scorecard', title: 'What each side got right',
      market_title: 'What the market got right',
      market: market.map(function (m) { return typeof m === 'string' ? { claim: m } : m; }),
      right_title: 'What EdgeDesk got right', right: right,
      wrong_title: 'What EdgeDesk got wrong', wrong: got,
      rule: 'This section is published whether the number won or lost. A record that only criticises itself in defeat is not a record.' };
  }

  /* WHAT WE LEARNED / HOW THIS MAKES US BETTER. */
  function lessonsSection(rec) {
    var lessons = rec.lessons || [];
    if (!lessons.length) return null;
    var rows = lessons.slice().sort(function (a, b) {
      var w = { high: 0, medium: 1, low: 2 };
      return (w[a.severity] == null ? 3 : w[a.severity]) - (w[b.severity] == null ? 3 : w[b.severity]);
    }).map(function (l) {
      return { category: l.category, severity: l.severity, expectation: l.pregame_expectation,
        result: l.actual_result, lesson: l.lesson, review: !!l.model_review_required,
        investigation: l.suggested_investigation };
    });
    return { kind: 'lessons', title: 'What we learned',
      lede: 'Each row below is stored as a research record, not only printed here. At the end of a season they are counted: which drivers have been contradicted most often, how often a winning number came with a broken thesis, and whether EdgeDesk’s disagreements with the market have been worth anything. That count is the asset; this article is how it gets written down.',
      rows: rows,
      how_title: 'How this makes the next read better',
      how: howItHelps(rec),
      next_title: 'Next steps',
      next: nextSteps(rec) };
  }

  /* DELIBERATELY NOT MOTIVATIONAL. Each line names a signal, a piece of noise
     or an assumption, and says what to do with it next time. */
  function howItHelps(rec) {
    var out = [];
    var g = rec.grading || {}, audit = rec.audit || [];
    var wrong = audit.filter(function (a) { return a.evaluation === 'NOT CONFIRMED'; });
    var blind = audit.filter(function (a) { return a.evaluation === 'INCONCLUSIVE' && a.kind !== 'uncertainty'; });

    if (g.variance_markers && g.variance_markers.length) {
      out.push('THE NOISE: ' + g.variance_markers.map(function (v) { return v.label.toLowerCase(); }).join(', ')
        + '. Whatever the scoreboard says, none of that is a repeatable property of either team, and weighting it in the next look at these sides would be learning the wrong thing.');
    }
    if (wrong.length) {
      out.push('THE SIGNAL TO RE-EXAMINE: ' + wrong.slice(0, 2).map(function (a) {
        return String(a.category).replace(/_/g, ' ');
      }).join(' and ') + '. EdgeDesk rated it one way and the game showed the other. One result does not settle it — the question is whether the same category has been contradicted before, which is what the research-lesson store is for.');
    }
    if (blind.length) {
      out.push('THE ASSUMPTION THAT CANNOT BE CHECKED: ' + blind.length
        + ' of the claims in the original article rest on signals no box score in this repository publishes. Those parts of the number are carried on faith between one model rebuild and the next, and it is worth knowing which parts those are.');
    }
    if (g.closing_line && g.closing_line.available) {
      out.push('THE LINE MOVEMENT: ' + g.closing_line.note
        + ' Closing-line movement is the only evidence available before a large sample of results arrives, and it is the number to watch rather than the win or the loss.');
    }
    var acc = g.model_accuracy;
    if (acc && acc.available && acc.total_error != null && acc.total_error >= 14) {
      out.push('THE TOTAL: EdgeDesk missed the scoring by ' + acc.total_error
        + ' points. A margin can be right while a total is badly wrong, and they come from different halves of the model — so a total miss is a question about pace and finishing, not about which team is better.');
    }
    if (!out.length) {
      out.push('This game moved little. The read held in direction, nothing was contradicted, and nothing in it justifies changing an assumption. Games like this are the majority and they are recorded rather than written up as insight.');
    }
    return out;
  }
  function nextSteps(rec) {
    var flagged = (rec.lessons || []).filter(function (l) { return l.model_review_required; });
    if (!flagged.length) {
      return ['Nothing in this game opens a model-review candidate. The lessons above are stored and counted; no weight in a production model is changed by a single result, and none is changed here.'];
    }
    return flagged.map(function (l) {
      return 'REVIEW CANDIDATE — ' + String(l.category).replace(/_/g, ' ') + ': ' + (l.suggested_investigation || l.lesson);
    }).concat(['A review candidate is a question with evidence attached, not a change. Nothing in this repository alters a production model weight from one game, and a candidate stays open until a person closes it against a holdout the fit has never seen.']);
  }

  /* WHAT TO CARRY FORWARD — the pregame article's own "what to watch", graded.
     It is the section that closes the loop for a reader who read both. */
  function watchedSection(rec) {
    var snap = rec.snapshot || {};
    var theses = rec.theses || [];
    var watched = theses.filter(function (t) { return txt(t.watch); });
    if (!watched.length) return null;
    var byId = Object.create(null);
    (rec.audit || []).forEach(function (a) { byId[a.thesis_id] = a; });
    return { kind: 'watched', title: 'What we said to watch, and what it showed',
      lede: 'The pregame article asked readers to watch these things during the game. Here is what each one did.',
      rows: watched.slice(0, 6).map(function (t) {
        var a = byId[t.thesis_id] || {};
        return { watch: t.watch, evaluation: a.evaluation || 'INCONCLUSIVE',
          observed: a.observed_result || 'Not observable from the statistics published for this game.' };
      }) };
    void snap;
  }

  /* --------------------------------------------------------- the narration */
  /* VALIDATED CONNECTIVE PROSE, IN ITS OWN BLOCK. It is never merged into a
     section built from the payload, so the page can be re-rendered without it
     at any time and the quality checks can always tell which sentences came
     from where. When narration was not produced — no key, a refused
     validation, a failed call — the sections below simply do not exist and
     the deterministic prose that was always there carries the page. */
  function narrativeSection(rec, which) {
    var n = rec.narration;
    if (!n || !n.validated || !n.copy) return null;
    var body = txt(n.copy[which]);
    if (!body) return null;
    var titles = { opening: 'The short version', why_it_turned: 'Reading the game',
      closing: 'What a researcher takes from it' };
    return { kind: 'narrative', title: titles[which] || 'Reading',
      field: which,
      paragraphs: String(n.copy[which]).split(/\n{2,}/).map(txt).filter(Boolean),
      /* SAID ON THE PAGE, not only in the methodology note. A reader is
         entitled to know which paragraphs a model drafted. */
      label: 'Drafted by a language model from EdgeDesk’s own figures and verdicts, then checked against them. No number, verdict or conclusion in it originated with the model.' };
  }

  /* ------------------------------------------------------- the bottom line */
  /* Assembled from figures already on the page, in a fixed order. No language
     model writes it; narrate.js may add a separate, clearly-labelled reading
     beside it, and the checks compare the two. */
  function bottomLine(rec) {
    var out = [];
    var res = rec.result || {}, g = rec.grading || {}, s = rec.snapshot || {};
    var m = s.model || {};

    var scoreLine = res.winner
      ? res.winner + ' beat ' + (res.winner === res.home_team ? res.away_team : res.home_team)
        + ' ' + Math.max(res.home_score, res.away_score) + '-' + Math.min(res.home_score, res.away_score) + '.'
      : res.away_team + ' and ' + res.home_team + ' finished level at ' + res.home_score + '.';
    if (m.priced && m.fair_spread_text) {
      scoreLine += ' EdgeDesk had published ' + m.fair_spread_text
        + (g.model_accuracy && g.model_accuracy.available && g.model_accuracy.margin_error != null
          ? ', which missed the final margin by ' + g.model_accuracy.margin_error + ' points.' : '.');
    }
    out.push(scoreLine);

    /* THE PAIR, NAMED. The verdict sentence itself is printed once, in the
       result-versus-process section; repeating it verbatim here put the same
       paragraph on the page twice. */
    out.push('Graded separately: the number ' + betPhrase(g) + ', and the reasoning behind it grades '
      + (g.process_headline || 'UNTESTED') + '. '
      + ((g.process && g.process.reasons && g.process.reasons[0]) || '')
      + (g.variance_markers && g.variance_markers.length
        ? ' The result carries ' + g.variance_markers.length + ' variance marker'
          + (g.variance_markers.length > 1 ? 's' : '') + ', named in full above.' : ''));

    if (rec.tally && rec.tally.headline) {
      out.push(rec.tally.headline.charAt(0).toUpperCase() + rec.tally.headline.slice(1)
        + '. ' + (rec.tally.not_observable
          ? rec.tally.not_observable + ' could not be graded against the statistics published for this game.'
          : ''));
    }

    var flagged = (rec.lessons || []).filter(function (l) { return l.model_review_required; });
    out.push(flagged.length
      ? flagged.length + ' model-review candidate' + (flagged.length > 1 ? 's are' : ' is') + ' open from this game. '
        + 'A candidate is a question with evidence attached; no production weight changes because of one Sunday. This is research, not picks.'
      : 'Nothing in this game opens a model-review candidate, and no production weight changes because of one result. This is research, not picks.');

    return out.map(function (x) { return String(x).replace(/\s+/g, ' ').trim(); }).filter(Boolean).slice(0, 4);
  }

  function betPhrase(g) {
    var sp = g.bet_result && g.bet_result.spread;
    if (!sp) return 'was not graded, because no sportsbook quote was captured before kickoff';
    if (sp.outcome === 'push') return 'landed exactly on the captured number';
    return sp.outcome === 'win' ? 'landed' : 'did not land';
  }

  function excerptFor(rec) {
    var res = rec.result || {}, g = rec.grading || {};
    var s = (res.winner
      ? res.winner + ' won ' + Math.max(res.home_score, res.away_score) + '-' + Math.min(res.home_score, res.away_score)
      : res.away_team + ' and ' + res.home_team + ' finished level') + '. '
      + (g.verdict && g.verdict.line ? g.verdict.line : 'EdgeDesk audits its own pregame research against what happened.');
    return s.length > 260 ? s.slice(0, 257).replace(/\s+\S*$/, '') + '…' : s;
  }

  /* ------------------------------------------------------------- the record */
  /* o: { snapshot, result, theses, audit, tally, grading, lessons,
          pregame (the pregame article record), now, status, hero_image } */
  function build(o) {
    o = o || {};
    var snap = o.snapshot, res = o.result, grading = o.grading;
    if (!snap) throw new Error('a postgame article needs the pregame snapshot');
    if (!res) throw new Error('a postgame article needs a game result');
    if (!grading) throw new Error('a postgame article needs a graded result');
    var sport = String(snap.sport || '').toUpperCase();
    var S = AMODEL.SPORTS[sport];
    if (!S) throw new Error('unknown sport for a postgame article: ' + snap.sport);

    var pre = o.pregame || null;
    var now = o.now ? new Date(o.now).toISOString() : new Date().toISOString();
    var home = txt(res.home_team) || txt(snap.game && snap.game.home);
    var away = txt(res.away_team) || txt(snap.game && snap.game.away);
    var id = 'postgame-' + sport.toLowerCase() + '-' + String(snap.game_id);
    var slug = slugFor(pre && pre.slug, AMODEL.slugFor({ away: away, home: home, season: snap.season }));
    var canonical = SITE + '/articles/' + slug;

    var rec = {
      schema: SCHEMA,
      article_type: 'postgame',
      id: id,
      game_id: String(snap.game_id),
      sport: sport, sport_slug: S.slug, sport_label: S.label,
      slug: slug, aliases: [],
      title: headlineFor(away, home),
      seo_title: seoTitleFor({ away: away, home: home, away_score: res.away_score, home_score: res.home_score }),
      excerpt: null, seo_description: null,
      home_team: home, away_team: away,
      venue: txt(snap.game && snap.game.venue),
      neutral_site: !!(snap.game && snap.game.neutral_site),
      conference_line: txt(snap.game && snap.game.conference_line),
      week: num(snap.week), season: num(snap.season),
      game_time: txt(snap.kickoff),
      published_at: o.published_at || null,
      updated_at: now, generated_at: now,
      model_version: txt(snap.model && snap.model.engine),
      model_status: grading.process_headline || null,
      model_status_note: (grading.verdict && grading.verdict.line) || null,
      confidence: null,
      priced: !!(snap.model && snap.model.priced),
      fair_spread_text: txt(snap.model && snap.model.fair_spread_text),
      fair_total: txt(snap.model && snap.model.total),
      hero_image: o.hero_image || null,
      canonical_url: canonical,
      terminal_url: SITE + '/app.html' + S.terminal,
      hub_url: SITE + S.hub,
      status: AMODEL.STATUSES.indexOf(o.status) >= 0 ? o.status : 'draft',
      /* A POSTGAME ARTICLE IS BORN FROZEN. Everything it describes already
         happened; a refresh has nothing to refresh. */
      frozen: true, frozen_at: txt(res.observed_at) || now,
      author: AUTHOR, publisher: AMODEL.ORG,
      research_source: txt(snap.research && snap.research.source),
      market_source: txt(snap.market_source),
      /* the payload halves, all stored, all machine-readable */
      snapshot_id: txt(snap.snapshot_id),
      snapshot: snap,
      result: res,
      theses: o.theses || [],
      audit: o.audit || [],
      tally: o.tally || null,
      grading: grading,
      lessons: o.lessons || [],
      pregame_published_at: pre && pre.published_at,
      related: {
        pregame_slug: pre && pre.slug, pregame_url: pre && pre.canonical_url,
        pregame_title: pre && pre.title, pregame_id: pre && pre.id
      },
      /* the pregame record carries the other half of the link */
      generation_version: SCHEMA
    };
    rec.excerpt = excerptFor(rec);
    rec.seo_description = seoDescriptionFor({
      away: away, home: home, home_score: res.home_score, away_score: res.away_score,
      winner: res.winner, tally: rec.tally
    }, grading);
    rec.article = articleFor(rec);
    return rec;
  }

  /* THE ARTICLE IS DERIVED, exactly as it is for a pregame record: the store
     writes the record without it and rebuilds it on read, so the layout can
     change and every stored article changes with it. */
  function articleFor(rec) {
    var S = AMODEL.SPORTS[rec.sport] || AMODEL.SPORTS.NFL;
    var res = rec.result || {}, g = rec.grading || {};
    var sections = [];
    function push(s) { if (s) sections.push(s); }
    push(resultSection(rec));
    push(narrativeSection(rec, 'opening'));
    push(expectedSection(rec));
    /* WHY EDGEDESK PRICED IT THERE, built from the frozen research inside the
       snapshot rather than from anything current. A postgame page shows the
       pregame call's numbers, so it owes the reader the same two labels the
       pregame page owes: which drivers moved the priced number, and which
       context did not. Omitting them let a page display model pricing with
       nothing saying what was priced and what was only context. */
    if (AMODEL.pricingSection && rec.snapshot && rec.snapshot.research) {
      push(AMODEL.pricingSection(rec.snapshot.research));
    }
    push(happenedSection(rec));
    push(turnedSection(rec));
    push(narrativeSection(rec, 'why_it_turned'));
    push(auditSection(rec));
    push(processSection(rec));
    push(scorecardSection(rec));
    push(watchedSection(rec));
    push(lessonsSection(rec));
    push(narrativeSection(rec, 'closing'));

    /* THE LINKS A POSTGAME PAGE OWES ARE THE PREGAME ONES PLUS ITS OWN, not
       a separate set. This page had its own list, and the first postgame
       article to publish failed the site-wide internal-linking checks
       because of it — no power-ratings link, no cross-sport hub, and the
       standing CTA line missing. The standard set now comes from
       AMODEL.internalLinks() so the two types cannot drift again. */
    var links = [
      rec.related && rec.related.pregame_url
        ? { label: 'Read our original pregame research →', href: rec.related.pregame_url, primary: true } : null,
      { label: 'EdgeDesk’s public record', href: '/record.html' }
    ].filter(Boolean);
    var seen = Object.create(null);
    links.forEach(function (l) { seen[l.href] = true; });
    (AMODEL.internalLinks ? AMODEL.internalLinks(S) : []).forEach(function (l) {
      if (!seen[l.href]) { seen[l.href] = true; links.push(l); }
    });

    return {
      hero: {
        eyebrow: S.label + ' · Postgame analysis',
        headline: rec.title,
        matchup: rec.away_team + ' at ' + rec.home_team,
        when: rec.game_time,
        final: res.home_score != null
          ? { away: { team: rec.away_team, points: res.away_score }, home: { team: rec.home_team, points: res.home_score } }
          : null,
        venue: rec.venue, conference_line: rec.conference_line,
        week: rec.week, season: rec.season,
        status: g.process_headline,
        bet: g.bet_headline,
        confidence: null,
        standfirst: (rec.narration && rec.narration.validated && rec.narration.copy
          && txt(rec.narration.copy.standfirst))
          || (g.verdict && g.verdict.line) || rec.excerpt
      },
      sections: sections,
      bottom_line: { kind: 'bottom_line', title: 'The EdgeDesk bottom line', paragraphs: bottomLine(rec) },
      cta: {
        line: 'Every game EdgeDesk features gets both halves: what it thought, then what it learned.',
        prompt: 'Research the matchup. Then price it.',
        button: 'Open full EdgeDesk research',
        href: SITE + '/app.html' + S.terminal,
        links: links
      },
      footer: {
        source: txt(rec.research_source),
        methodology: methodologyFor(rec),
        disclaimer: 'EdgeDesk publishes research, not betting advice. Nothing on this page is a pick, a wager or a recommendation. 21+. Gamble responsibly — 1-800-GAMBLER.'
      }
    };
  }

  /* PART 15 — the transparency notice, on every postgame page. */
  function methodologyFor(rec) {
    var snap = rec.snapshot || {}, res = rec.result || {};
    return [
      'EdgeDesk is a sports research platform. Its model projections are research estimates, not guarantees, and this article grades them rather than promoting them.',
      'The pregame half of this page is read from a research snapshot captured at ' + (snap.captured_at || 'publication')
        + ' and identified as ' + (snap.snapshot_id || 'an immutable record') + '. It has not been edited since, and the publication checks refuse a page whose pregame claims do not match it.',
      'The postgame half uses the final score and the team statistics published by '
        + ((res.agreed_by || []).join(' and ') || res.primary_source || 'the public feeds this repository reads')
        + (res.observed_at ? ', read at ' + res.observed_at : '') + '. Where a statistic is not published for this game it is left blank rather than estimated.',
      'Market numbers on this page are the sportsbooks’ own, captured at the times stated. They may have moved after publication, and any closing line shown is labelled with its source.',
      (rec.narration && rec.narration.validated)
        ? 'Connective prose in the blocks marked as such was drafted by a language model'
          + (rec.narration.model ? ' (' + rec.narration.model + ')' : '')
          + ' from a structured payload of the figures and verdicts above, then validated against them: a figure, a verdict or a name the payload did not contain would have discarded the whole draft. Every number and every verdict on this page was computed before the model was called.'
        : 'No language model contributed to this page. Every sentence on it was assembled by EdgeDesk’s own code from the research snapshot, the box score and the audit.'
    ].filter(Boolean);
  }

  /* ------------------------------------------------ the publication checks */
  /* The pregame checks that still apply, plus the ones only a postgame article
     can fail. article_model.publishable() runs this through its type registry. */
  function checks(rec) {
    var out = [];
    function chk(id, ok, why) { out.push({ id: id, ok: !!ok, why: why }); }
    var a = (rec && rec.article) || {};
    var res = rec.result || {}, g = rec.grading || {}, snap = rec.snapshot || {};

    chk('slug', !!rec.slug && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rec.slug),
      'the slug must be lower-case, hyphenated and free of random ids');
    chk('postgame_slug', !!rec.slug && /-postgame-analysis$/.test(rec.slug),
      'a postgame article’s URL must say so');
    chk('title', !!rec.title && rec.title.length > 15, 'an article needs a headline');
    chk('description', !!rec.seo_description && rec.seo_description.length >= 50,
      'an article needs a meta description a search result can show');
    chk('canonical', !!rec.canonical_url && rec.canonical_url.indexOf(SITE + '/articles/') === 0,
      'every article canonicalises to its own clean URL');
    chk('teams', !!rec.home_team && !!rec.away_team, 'both teams must be named');
    chk('final_score', num(res.home_score) != null && num(res.away_score) != null,
      'a postgame article without a final score is not a postgame article');
    chk('not_nil_nil', !(res.home_score === 0 && res.away_score === 0),
      '0-0 is a results form nobody filled in, not a football final');
    chk('completed', res.completed === true, 'no source called this game final');
    chk('snapshot', !!snap.snapshot_id && !!snap.research,
      'the postgame article must carry the pregame snapshot it audits');
    chk('snapshot_predates_kickoff',
      !snap.captured_at || !snap.kickoff || Date.parse(snap.captured_at) <= Date.parse(snap.kickoff),
      'the snapshot was captured after kickoff, so it is not a record of what EdgeDesk said beforehand');
    chk('thesis_audit', (rec.audit || []).length > 0 && !!rec.tally,
      'a postgame article must carry the audit of its own pregame claims');
    chk('grading', !!g.process_headline && !!g.verdict,
      'a postgame article must separate the bet result from the process grade');
    chk('wrong_section', (a.sections || []).some(function (s) {
      return s.kind === 'scorecard' && (s.wrong || []).length > 0
        && (s.wrong || []).every(function (w) { return w && w.claim; });
    }), '"What EdgeDesk got wrong" is required whether the number won or lost');
    chk('lessons', (rec.lessons || []).length > 0,
      'a postgame article must produce at least one stored research lesson');
    chk('sections', (a.sections || []).length >= 5,
      'a postgame article with fewer than five sections is a scoreboard, not an analysis');
    chk('bottom_line', ((a.bottom_line && a.bottom_line.paragraphs) || []).length >= 2,
      'the bottom line must actually conclude something');
    chk('stats_present', (res.stat_fields_seen || []).length > 0
      || Object.keys((res.metrics && res.metrics.home) || {}).length > 3,
      'a postgame article may not be written from a scoreboard alone');
    chk('methodology', ((a.footer && a.footer.methodology) || []).length >= 3,
      'the methodology notice is required on a postgame page');

    var flat = AMODEL.flattenText(stripPayload(rec));
    chk('no_recommendation', !AMODEL.FORBIDDEN.test(flat),
      'an EdgeDesk article never carries betting-recommendation language');
    chk('no_stringified_nothing', !/(^|[\s>(])(null|undefined|NaN)([\s<).,;:]|$)/.test(flat),
      'a stringified null/undefined/NaN reached the page');
    return out;
  }
  /* The checks run on the DOCUMENT, not on the stored payload halves: the
     snapshot legitimately contains the word "null" inside a research field
     name, and the audit legitimately quotes a pregame claim. What must be
     clean is what a reader sees. */
  function stripPayload(rec) {
    var c = Object.assign({}, rec);
    delete c.snapshot; delete c.result; delete c.theses; delete c.grading;
    delete c.audit; delete c.lessons; delete c.tally;
    return c;
  }

  function compact(rec) {
    var c = Object.assign({}, rec);
    delete c.article;      /* derived; everything else, narration included, is stored */
    return c;
  }

  /* REGISTERED WITH THE ARTICLE MODEL AT LOAD, which is what makes a postgame
     record a first-class citizen of the one store: article_model.hydrate()
     rebuilds its sections through articleFor() here, and publishable() runs
     checks() here instead of the pregame list. tools/articles/store.js
     requires this file so any Node consumer of the store gets the dispatch,
     and the browser loads both scripts for the same reason. */
  var API = {
    SCHEMA: SCHEMA, STAT_ORDER: STAT_ORDER,
    headlineFor: headlineFor, seoTitleFor: seoTitleFor, seoDescriptionFor: seoDescriptionFor,
    slugFor: slugFor, fmtStat: fmtStat, bottomLine: bottomLine, methodologyFor: methodologyFor,
    build: build, articleFor: articleFor, checks: checks, compact: compact,
    narrativeSection: narrativeSection,
    stripPayload: stripPayload, howItHelps: howItHelps, nextSteps: nextSteps
  };
  if (AMODEL && typeof AMODEL.registerType === 'function') {
    AMODEL.registerType('postgame', API);
  }
  return API;
});
/*__EDED_POSTGAME_END__*/
