/* ===========================================================================
   EdgeDesk Games — the Two-Minute Drill.

   Ten rapid-fire questions about real matchups, two minutes on the clock,
   three lives. The old-school arcade game in the War Room.

   EVERY ANSWER IS CANONICAL. A question is only ever asked when the challenge
   artifact already carries its answer as a field the Power 4 exporter wrote:
   which side EdgeDesk favours, whether it makes the favourite bigger or
   smaller than the book, which roster returns more of its offensive line.
   The browser reads a number it did not compute and asks which of two things
   it says. Nothing here invents a decoy, a distractor or a "close enough".

   A question that would be a coin flip is NOT asked. Each kind declares a
   margin — a favourite of at least a field goal, a continuity gap of at least
   ten points — below which the matchup is skipped for that kind. The drill
   would rather have fewer questions than a guessable one.

   DETERMINISTIC. The day's drill is a pure function of the day key and the
   board, so everyone who plays today answers the same ten in the same order
   and a score is comparable. Free play seeds on the run number instead. No
   Math.random anywhere.

   THE SCORE (drill_v1):
       100 points per correct answer
       + 5 points per whole second left on the clock, only if all ten rounds
         were answered (a run that ends on lives or on the clock keeps its
         answer points and nothing else)
   Lives: three. A wrong answer costs one. Nothing else does.
   =========================================================================== */
(function (root) {
  'use strict';

  var DRILL_VERSION = 'drill_v1';
  var ROUNDS = 10;
  var LIVES = 3;
  var CLOCK_SECONDS = 120;
  var POINTS_PER_CORRECT = 100;
  var POINTS_PER_SECOND_LEFT = 5;

  var CH = root.EDGamesChallenge || (typeof require === 'function' ? require('./challenge.js') : null);

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function tenth(v) { return Math.round(v * 10) / 10; }

  /* "Auburn −9.7" for a HOME spread; the favourite named with its number. */
  function lineText(ch, homeSpread) {
    if (!isNum(homeSpread)) return null;
    var r = tenth(homeSpread);
    if (r === 0) return 'Pick ’em';
    return (r < 0 ? ch.home_team : ch.away_team) + ' −' + Math.abs(r).toFixed(1);
  }
  function favourite(ch, homeSpread) { return homeSpread < 0 ? 'home' : 'away'; }
  function teamOf(ch, side) { return side === 'home' ? ch.home_team : ch.away_team; }

  /* ── the question kinds ──────────────────────────────────────────────────
     Each kind has:
       ok(ch)      may this matchup be asked this question? (canonical field
                   present, and past the kind's margin)
       build(ch)   the question: prompt, two options, the answer's index,
                   and the reveal ("why") in one sentence
     Every option and every answer is derived from the record and nothing
     else. */
  var CTX = function (ch, side, k) {
    var c = ch && ch.context && ch.context[side];
    return c && isNum(c[k]) ? c[k] : null;
  };

  function contextKind(id, field, prompt, tag, minGap, more) {
    return {
      id: id, tag: tag,
      ok: function (ch) {
        var a = CTX(ch, 'away', field), h = CTX(ch, 'home', field);
        return a != null && h != null && Math.abs(a - h) >= minGap;
      },
      build: function (ch) {
        var a = CTX(ch, 'away', field), h = CTX(ch, 'home', field);
        var answer = more ? (a > h ? 0 : 1) : (a < h ? 0 : 1);
        return {
          kind: id, tag: tag, prompt: prompt,
          options: [ch.away_team, ch.home_team],
          answer: answer,
          why: ch.away_team + ' ' + a + '% · ' + ch.home_team + ' ' + h + '%',
          teaches: 'EdgeDesk reads roster continuity from the committed rankings artifact — the same numbers the Price It context table shows.'
        };
      }
    };
  }

  var KINDS = [
    /* who EdgeDesk favours — at least a field goal, so it is a read and not a guess */
    { id: 'favourite', tag: 'THE MODEL',
      ok: function (ch) { return isNum(ch.edgedesk_spread) && Math.abs(ch.edgedesk_spread) >= 3; },
      build: function (ch) {
        var fav = favourite(ch, ch.edgedesk_spread);
        return {
          kind: 'favourite', tag: 'THE MODEL',
          prompt: 'Who does EdgeDesk favour?',
          options: [ch.away_team, ch.home_team],
          answer: fav === 'away' ? 0 : 1,
          why: 'EdgeDesk prices it ' + lineText(ch, ch.edgedesk_spread)
            + (isNum(ch.market_spread) ? ' · market ' + lineText(ch, ch.market_spread) : ''),
          teaches: 'The projection comes out of opponent-adjusted team ratings. It is a research number, not a pick.'
        };
      } },

    /* the favourite against a football threshold: field goal, touchdown, two scores */
    { id: 'threshold', tag: 'PRICE IT',
      ok: function (ch) { return isNum(ch.edgedesk_spread) && Math.abs(ch.edgedesk_spread) >= 1.5 && !!thresholdFor(ch.edgedesk_spread); },
      build: function (ch) {
        var t = thresholdFor(ch.edgedesk_spread), fav = favourite(ch, ch.edgedesk_spread);
        var more = Math.abs(ch.edgedesk_spread) > t.pts;
        return {
          kind: 'threshold', tag: 'PRICE IT',
          prompt: 'EdgeDesk makes ' + teamOf(ch, fav) + ' a favourite by MORE or LESS than ' + t.label + '?',
          options: ['More than ' + t.short, 'Less than ' + t.short],
          answer: more ? 0 : 1,
          why: 'EdgeDesk: ' + lineText(ch, ch.edgedesk_spread)
            + (isNum(ch.market_spread) ? ' · market ' + lineText(ch, ch.market_spread) : ''),
          teaches: 'A spread is a price in points. Learning where a game sits against a field goal or a touchdown is the whole skill of Price It.'
        };
      } },

    /* model versus market: bigger or smaller favourite than the book */
    { id: 'gap', tag: 'MODEL vs MARKET',
      ok: function (ch) {
        if (!isNum(ch.edgedesk_spread) || !isNum(ch.market_spread)) return false;
        if (ch.research_state !== 'REVIEW' && ch.research_state !== 'INVESTIGATE') return false;
        /* the same side must be favoured by both, or "bigger favourite" has no meaning */
        return favourite(ch, ch.edgedesk_spread) === favourite(ch, ch.market_spread)
          && Math.abs(Math.abs(ch.edgedesk_spread) - Math.abs(ch.market_spread)) >= 2;
      },
      build: function (ch) {
        var fav = favourite(ch, ch.market_spread);
        var bigger = Math.abs(ch.edgedesk_spread) > Math.abs(ch.market_spread);
        return {
          kind: 'gap', tag: 'MODEL vs MARKET',
          prompt: 'The book makes ' + teamOf(ch, fav) + ' the favourite. Does EdgeDesk make them a BIGGER or SMALLER one?',
          options: ['Bigger favourite', 'Smaller favourite'],
          answer: bigger ? 0 : 1,
          why: 'EdgeDesk ' + lineText(ch, ch.edgedesk_spread) + ' · market ' + lineText(ch, ch.market_spread)
            + ' · ' + Math.abs(tenth(Math.abs(ch.edgedesk_spread) - Math.abs(ch.market_spread))).toFixed(1) + ' points apart',
          teaches: 'A gap between EdgeDesk and the market is a reason to read the research, not evidence of an edge.'
        };
      } },

    contextKind('ol', 'ol_continuity', 'Which side returns more of its offensive line?', 'ROSTER', 10, true),
    contextKind('production', 'returning_production', 'Which side returns more production from last season?', 'ROSTER', 10, true),
    contextKind('qb', 'qb_continuity', 'Which side has more continuity at quarterback?', 'ROSTER', 15, true),
    contextKind('churn', 'transfer_churn', 'Which roster turned over more through the transfer portal?', 'ROSTER', 5, true)
  ];
  /* churn is a count, not a percentage — fix its "why" line */
  KINDS[KINDS.length - 1].build = (function (inner) {
    return function (ch) {
      var q = inner(ch);
      var a = CTX(ch, 'away', 'transfer_churn'), h = CTX(ch, 'home', 'transfer_churn');
      q.why = ch.away_team + ' ' + a + ' · ' + ch.home_team + ' ' + h + ' — transfer churn as EdgeDesk counts it';
      return q;
    };
  })(KINDS[KINDS.length - 1].build);

  var THRESHOLDS = [
    { pts: 3, label: 'a field goal', short: 'a field goal' },
    { pts: 7, label: 'a touchdown', short: 'a touchdown' },
    { pts: 14, label: 'two touchdowns', short: 'two touchdowns' },
    { pts: 21, label: 'three touchdowns', short: 'three touchdowns' },
    { pts: 28, label: 'four touchdowns', short: 'four touchdowns' },
    { pts: 35, label: 'five touchdowns', short: 'five touchdowns' }
  ];
  /* the nearest football threshold that the spread is clearly on one side of */
  function thresholdFor(homeSpread) {
    var a = Math.abs(homeSpread), best = null, i, d;
    for (i = 0; i < THRESHOLDS.length; i++) {
      d = Math.abs(a - THRESHOLDS[i].pts);
      if (d < 1.5) continue;
      if (!best || d < best.d) best = { d: d, t: THRESHOLDS[i] };
    }
    return best ? best.t : null;
  }

  /* ── seeded order ────────────────────────────────────────────────────────
     mulberry32 over the shared day hash: tiny, deterministic, good enough to
     shuffle a board. */
  function prng(seedStr) {
    var a = CH ? CH.hash(seedStr) : 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(list, rnd) {
    var a = list.slice(), i, j, t;
    for (i = a.length - 1; i > 0; i--) { j = Math.floor(rnd() * (i + 1)); t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  /* Which matchups may be asked at all: the same playability rule the rest
     of Games uses, on the same board. */
  function eligible(pool, nowMs) {
    return (CH ? CH.playable(pool, nowMs) : (pool || [])).filter(function (ch) {
      return ch && ch.game_id != null && ch.home_team && ch.away_team;
    });
  }

  /* ── build a run ─────────────────────────────────────────────────────────
     Ten questions, no matchup twice, kinds interleaved so a run is varied and
     the roster questions do not all land together. Deterministic in
     (seed, board). Returns fewer than ten only when the board cannot supply
     ten — and says so in `short`. */
  function build(pool, seed, nowMs) {
    var rnd = prng(seed || 'drill');
    var live = shuffle(eligible(pool, nowMs), rnd);
    var order = shuffle(KINDS, rnd);
    var used = {}, out = [], k = 0, guard = 0, i;
    /* THE FIRST ROUND IS THE EASY ONE. A cold visitor decides in the first
       five seconds whether this is for them, so round one is always "who does
       EdgeDesk favour" on a matchup priced at two touchdowns or more, when the
       board has one. The order stays deterministic: it is the first such game
       in the seeded shuffle. */
    var opener = null;
    for (i = 0; i < live.length && !opener; i++)
      if (isNum(live[i].edgedesk_spread) && Math.abs(live[i].edgedesk_spread) >= 14 && KINDS[0].ok(live[i])) opener = live[i];
    if (opener) { used[opener.game_id] = true; out.push(finish(KINDS[0].build(opener), opener, 1)); }
    while (out.length < ROUNDS && guard < KINDS.length * 4) {
      var kind = order[k % order.length], found = null;
      for (i = 0; i < live.length; i++) {
        var ch = live[i];
        if (used[ch.game_id]) continue;
        if (!kind.ok(ch)) continue;
        found = ch; break;
      }
      if (found) {
        used[found.game_id] = true;
        out.push(finish(kind.build(found), found, out.length + 1));
        guard = 0;
      } else guard++;
      k++;
    }
    return { version: DRILL_VERSION, seed: seed || 'drill', rounds: out, short: out.length < ROUNDS,
      lives: LIVES, clock: CLOCK_SECONDS };
  }

  /* stamp the matchup identity on a built question so the reveal and the
     research links can find their way back to the board */
  function finish(q, ch, round) {
    q.game_id = String(ch.game_id); q.slug = ch.slug || null;
    q.home_team = ch.home_team; q.away_team = ch.away_team;
    q.kickoff = ch.kickoff || null; q.research_state = ch.research_state || null;
    q.round = round;
    return q;
  }

  function dailySeed(dayKey) { return 'daily:' + dayKey; }
  function freeSeed(dayKey, n) { return 'free:' + dayKey + ':' + (n | 0); }

  /* ── scoring ─────────────────────────────────────────────────────────────
     `answers` is the list of {round, picked} the player produced, in order;
     `clockLeft` the seconds left when the run ended; `ended` why it ended:
     'complete' | 'lives' | 'clock'. Pure, and the only place points exist. */
  function score(run, answers, clockLeft, ended) {
    var correct = 0, misses = [], i, lives = LIVES;
    answers = answers || [];
    for (i = 0; i < answers.length && i < run.rounds.length; i++) {
      var q = run.rounds[i], a = answers[i];
      if (a && a.picked === q.answer) correct++;
      else { misses.push(q.game_id); lives--; }
    }
    var complete = ended === 'complete' && answers.length >= run.rounds.length && lives > 0;
    var secs = Math.max(0, Math.floor(isNum(clockLeft) ? clockLeft : 0));
    var points = correct * POINTS_PER_CORRECT;
    var clockPts = complete ? secs * POINTS_PER_SECOND_LEFT : 0;
    return {
      scoring_version: DRILL_VERSION,
      rounds: run.rounds.length, answered: Math.min(answers.length, run.rounds.length),
      correct: correct, misses: misses, lives_left: Math.max(0, lives),
      points: points, clock_points: clockPts, total: points + clockPts,
      clock_left: complete ? secs : (isNum(clockLeft) ? Math.max(0, Math.floor(clockLeft)) : 0),
      ended: ended || (lives <= 0 ? 'lives' : 'clock'),
      complete: complete
    };
  }

  /* an honest label for a result, never a verdict on the player */
  function grade(res) {
    if (!res) return null;
    if (res.correct >= 10) return { key: 'perfect', label: 'No huddle. Ten for ten.' };
    if (res.correct >= 8) return { key: 'sharp', label: 'Sharp drill.' };
    if (res.correct >= 6) return { key: 'solid', label: 'Solid read.' };
    if (res.correct >= 3) return { key: 'mixed', label: 'Mixed read. The research explains the misses.' };
    return { key: 'rough', label: 'Rough one. Every miss has a why.' };
  }

  var API = {
    DRILL_VERSION: DRILL_VERSION, ROUNDS: ROUNDS, LIVES: LIVES, CLOCK_SECONDS: CLOCK_SECONDS,
    POINTS_PER_CORRECT: POINTS_PER_CORRECT, POINTS_PER_SECOND_LEFT: POINTS_PER_SECOND_LEFT,
    KINDS: KINDS, THRESHOLDS: THRESHOLDS, thresholdFor: thresholdFor,
    eligible: eligible, build: build, dailySeed: dailySeed, freeSeed: freeSeed,
    score: score, grade: grade, lineText: lineText, prng: prng
  };
  root.EDGamesDrill = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
