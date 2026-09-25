/*__EDED_GRADING_START__*/
/* ============================================================================
   RESULT versus PROCESS — two different questions, graded separately.

   THE PRINCIPLE THE WHOLE SYSTEM TURNS ON. A bet that cashed because a corner
   returned a tipped ball ninety yards was not good analysis. A bet that lost
   because a kicker missed from thirty-one was not bad analysis. Every betting
   site in the world conflates those two, because the money is the part the
   reader feels; EdgeDesk separates them on purpose and prints both.

   So this file computes, side by side and never as one number:

     BET RESULT     win / loss / push, on the spread, the total and the
                    moneyline, from the final score and the number EdgeDesk
                    was actually looking at when it published. Arithmetic.
     PROCESS GRADE  whether the reasoning held up, from the thesis audit, the
                    model's own margin and total error, and the variance
                    markers below. Also arithmetic, and deliberately capable
                    of disagreeing with the first one.

   EDGEDESK PUBLISHES RESEARCH, NOT PICKS, and this file is careful about the
   difference. There is no "EdgeDesk's pick". What there is, on a game where a
   sportsbook quote was captured before kickoff, is the side EdgeDesk's own
   number IMPLIED against that quote — and grading that is how a research
   platform keeps itself honest, because a model whose disagreements never
   land is a model with a problem. Every field below is named for what it is:
   `implied_side`, not `pick`.

   VARIANCE MARKERS are the mechanism that lets the two grades disagree
   out loud. A three-turnover swing, a defensive touchdown, an ATS outcome
   that flipped on the last score — each is detected from the provider's own
   payload and named. None of them decides a grade by itself; they are the
   evidence the process paragraph is written from.
   ========================================================================== */
(function (root, factory) {
  var api = factory(
    typeof require === 'function' ? require('./results.js') : (root.EDED && root.EDED.results)
  );
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDED = root.EDED || {};
  root.EDED.grading = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (RESULTS) {
  'use strict';

  var SCHEMA = 'edgedesk_result_vs_process_v1';

  function num(v) { if (v == null || v === '') return null; var n = +v; return isFinite(n) ? n : null; }
  function txt(v) { if (v == null) return null; var s = String(v).replace(/\s+/g, ' ').trim(); return s || null; }
  function r1(v) { return v == null ? null : Math.round(v * 10) / 10; }

  /* ------------------------------------------------------ the market line */
  /* "Seattle Seahawks -1.0" -> { team, point }. One reader, used everywhere,
     and it returns null rather than a guess when the text is not that shape. */
  function parseLine(text) {
    var s = txt(text);
    if (!s) return null;
    var m = /^(.*?)\s*([+-]?\d+(?:\.\d+)?)\s*$/.exec(s);
    if (!m) return null;
    var team = txt(m[1]), point = num(m[2]);
    if (!team || point == null) return null;
    return { team: team, point: point };
  }
  function sideOf(team, home, away) {
    var t = txt(team);
    if (!t) return null;
    if (txt(home) === t) return 'home';
    if (txt(away) === t) return 'away';
    var hIn = home && (String(home).indexOf(t) >= 0 || t.indexOf(String(home)) >= 0);
    var aIn = away && (String(away).indexOf(t) >= 0 || t.indexOf(String(away)) >= 0);
    if (hIn && !aIn) return 'home';
    if (aIn && !hIn) return 'away';
    return null;
  }

  /* --------------------------------------------------------- bet outcomes */
  /* THE SAME ARITHMETIC THE PUBLIC RECORD ALREADY USES. A spread grades on
     margin + point; equality is a push and is never rounded away. */
  function gradeSpread(o) {
    var hs = num(o.home_score), as = num(o.away_score);
    var point = num(o.point);
    if (hs == null || as == null || point == null || !o.side) return null;
    var mine = o.side === 'home' ? hs : as, theirs = o.side === 'home' ? as : hs;
    var adj = mine + point - theirs;
    return { outcome: adj === 0 ? 'push' : (adj > 0 ? 'win' : 'loss'),
      cover_margin: r1(adj), side: o.side, point: point };
  }
  function gradeTotal(o) {
    var hs = num(o.home_score), as = num(o.away_score), line = num(o.line);
    if (hs == null || as == null || line == null || !o.side) return null;
    var tot = hs + as;
    if (tot === line) return { outcome: 'push', points: tot, line: line, side: o.side, by: 0, direction: 'level' };
    var over = o.side === 'over';
    return { outcome: over ? (tot > line ? 'win' : 'loss') : (tot < line ? 'win' : 'loss'),
      points: tot, line: line, side: o.side,
      /* always the DISTANCE from the line, with the direction said separately,
         so a reader never has to work out what a negative "by" meant */
      by: r1(Math.abs(tot - line)), direction: tot > line ? 'over' : 'under' };
  }
  function gradeMoneyline(o) {
    var hs = num(o.home_score), as = num(o.away_score);
    if (hs == null || as == null || !o.side) return null;
    var mine = o.side === 'home' ? hs : as, theirs = o.side === 'home' ? as : hs;
    return { outcome: mine === theirs ? 'push' : (mine > theirs ? 'win' : 'loss'), side: o.side };
  }

  /* --------------------------------------------------- the implied side */
  /* Where EdgeDesk's own number sat relative to the captured quote. On a game
     with no captured quote there IS no implied side and this returns one that
     says so — which is the correct answer, not a gap to fill. */
  function impliedSide(snapshot) {
    var model = (snapshot && snapshot.model) || {};
    var m = (snapshot && snapshot.market) || null;
    if (!model.priced) {
      return { available: false, why: 'EdgeDesk did not price this game, so its number implied nothing about the market’s.' };
    }
    if (!m || !m.available) {
      return { available: false, why: 'No sportsbook quote was captured before kickoff, so there is no market number for EdgeDesk’s to be measured against. The model’s own projection is still graded below; the bet columns are not.' };
    }
    /* the RAW model line when the snapshot carries one: a near pick'em is
       displayed at a one-point floor, and the floor must not manufacture a
       lean or a gap. Older snapshots only carry `model`, which was raw. */
    var mk = parseLine(m.market), md = parseLine(m.model_raw || m.model);
    if (!mk || !md) {
      return { available: false, why: 'The captured quote could not be read as a team and a number, so no implied side is claimed.' };
    }
    var home = snapshot.game && snapshot.game.home, away = snapshot.game && snapshot.game.away;
    var mkSide = sideOf(mk.team, home, away), mdSide = sideOf(md.team, home, away);
    if (!mkSide || !mdSide) {
      return { available: false, why: 'The captured quote names a team that does not resolve to either side of this game.' };
    }
    /* both numbers, expressed as the HOME margin the home side must beat */
    var mkHome = mkSide === 'home' ? mk.point : -mk.point;
    var mdHome = mdSide === 'home' ? md.point : -md.point;
    /* EdgeDesk's number being MORE negative for home means EdgeDesk rates home
       higher than the market does, so its number leans home */
    var lean = mdHome < mkHome ? 'home' : mdHome > mkHome ? 'away' : null;
    if (!lean) {
      return { available: false, why: 'EdgeDesk and the market landed on the same number, so nothing was implied either way.' };
    }
    var leanTeam = lean === 'home' ? txt(home) : txt(away);
    /* the price that side was available at, from the captured quote */
    var takePoint = lean === 'home' ? mkHome : -mkHome;
    return {
      available: true,
      side: lean, team: leanTeam,
      point: r1(takePoint),
      line_text: leanTeam + ' ' + (takePoint > 0 ? '+' : '') + r1(takePoint),
      book: txt(m.book),
      market_home_margin: r1(mkHome),
      model_home_margin: r1(mdHome),
      gap: r1(Math.abs(mdHome - mkHome)),
      why: 'EdgeDesk’s own number sat ' + r1(Math.abs(mdHome - mkHome)) + ' points toward ' + leanTeam
        + ' of the quote EdgeDesk captured' + (m.book ? ' at ' + txt(m.book) : '')
        + '. That is what the disagreement implied. It was published as research, not as a recommendation to bet it.'
    };
  }
  function impliedTotalSide(snapshot) {
    var m = (snapshot && snapshot.market) || null;
    var model = (snapshot && snapshot.model) || {};
    if (!m || !m.available || !m.total_market || !model.total) {
      return { available: false, why: 'EdgeDesk published no fair total, or no sportsbook total was captured.' };
    }
    var mk = num(m.total_market), md = num(model.total);
    if (mk == null || md == null || mk === md) {
      return { available: false, why: mk === md ? 'EdgeDesk and the market landed on the same total.' : 'The captured total could not be read as a number.' };
    }
    return { available: true, side: md > mk ? 'over' : 'under', line: mk, model_total: md,
      gap: r1(Math.abs(md - mk)),
      why: 'EdgeDesk’s fair total of ' + md + ' sat ' + r1(Math.abs(md - mk))
        + ' points ' + (md > mk ? 'above' : 'below') + ' the captured total of ' + mk + '.' };
  }

  /* ------------------------------------------------------ closing-line value */
  /* THE ONLY REAL PROOF A SIGNAL WAS INFORMATION, and EdgeDesk's own README
     already says so about its CLV ledger. Expressed in POINTS of line
     movement on the spread, in the direction EdgeDesk's number leaned, because
     a spread that moved from -1 to -3 toward the side EdgeDesk preferred is
     the market arriving where EdgeDesk already was. A closing line that is not
     held stays null; it is never estimated from the result. */
  function closingLineValue(o) {
    var implied = o.implied;
    if (!implied || !implied.available) {
      return { available: false, why: 'no implied side, so there is nothing to measure line movement against' };
    }
    var close = num(o.closing_home_margin);
    if (close == null) {
      return { available: false, why: txt(o.closing_absent_reason)
        || 'no closing line was captured for this game, so closing-line value cannot be computed. It is not estimated from the result.' };
    }
    var open = num(implied.market_home_margin);
    if (open == null) return { available: false, why: 'the captured pre-publication quote could not be read as a margin' };
    /* movement, signed toward the side EdgeDesk leaned */
    var moveHome = open - close;          /* positive = the line moved toward home */
    var toward = implied.side === 'home' ? moveHome : -moveHome;
    return {
      available: true,
      captured_home_margin: r1(open),
      closing_home_margin: r1(close),
      close_source: txt(o.closing_source),
      movement_points: r1(Math.abs(open - close)),
      moved_toward_edgedesk: toward > 0,
      clv_points: r1(toward),
      note: toward > 0
        ? 'The line moved ' + r1(Math.abs(toward)) + ' points toward the side EdgeDesk’s number leaned before kickoff. That is the market arriving where EdgeDesk already was, and over many games it is the only evidence that a disagreement carried information.'
        : toward < 0
          ? 'The line moved ' + r1(Math.abs(toward)) + ' points AWAY from the side EdgeDesk’s number leaned. The market went the other way.'
          : 'The line did not move between the captured quote and the close.'
    };
  }

  /* -------------------------------------------------------- variance markers */
  /* Things that decide football games without telling you anything about which
     team is better. Each is detected from the provider's own payload; each is
     named; none of them, alone, changes a grade. */
  function varianceMarkers(result, snapshot, bets) {
    var out = [];
    var hm = (result.metrics && result.metrics.home) || {};
    var am = (result.metrics && result.metrics.away) || {};

    var tm = num(hm.turnover_margin);
    if (tm != null && Math.abs(tm) >= 3) {
      var win = tm > 0 ? txt(result.home_team) : txt(result.away_team);
      out.push({ key: 'turnover_swing', severity: 'high',
        label: 'A ' + Math.abs(tm) + '-turnover swing',
        text: win + ' won the turnover battle by ' + Math.abs(tm)
          + '. Turnover margin is the least repeatable thing in football: it moves scoreboards hard and predicts almost nothing about the next meeting, so a result built on it says less about either team than the scoreline suggests.' });
    } else if (tm != null && Math.abs(tm) === 2) {
      out.push({ key: 'turnover_edge', severity: 'medium',
        label: 'A two-turnover edge',
        text: (tm > 0 ? txt(result.home_team) : txt(result.away_team)) + ' won the turnover battle by two, which is worth roughly a touchdown of scoreboard on average and is largely noise game to game.' });
    }

    var dh = num(hm.defensive_tds) || 0, da = num(am.defensive_tds) || 0;
    if (dh + da > 0) {
      out.push({ key: 'defensive_td', severity: 'high',
        label: (dh + da) + ' defensive touchdown' + (dh + da > 1 ? 's' : ''),
        text: 'A defensive score puts points on the board that no offensive rating predicted and no offensive rating should be graded on.' });
    }

    /* an ATS outcome that flipped on the last score */
    var flip = atsFlip(result, bets);
    if (flip && flip.flipped) {
      out.push({ key: 'late_ats_flip', severity: 'high',
        label: 'The spread result changed on the final score',
        text: 'Before the last scoring play of the game the spread graded ' + flip.before
          + '; it finished ' + flip.after + '. A number that moves on a score taken in the last minutes of a decided game is a scoreboard event, not a matchup one.' });
    }

    /* a blowout: the second half of a decided game is a different game */
    var margin = num(result.margin);
    if (margin != null && margin >= 21) {
      out.push({ key: 'blowout', severity: 'medium',
        label: 'A ' + margin + '-point margin',
        text: 'Once a game is this far apart both teams stop playing the game they were rated on — the leader runs clock, the trailer throws — so late-game rates describe the situation rather than either team.' });
    }

    /* special-teams and return scores, from the scoring plays the provider
       published; nothing is inferred when it published none */
    var sp = result.scoring_plays;
    if (Array.isArray(sp)) {
      var returns = sp.filter(function (p) {
        return /return|kickoff|punt|interception|fumble|blocked|safety/i.test(String(p.text || '') + ' ' + String(p.scoring_type || ''));
      });
      if (returns.length) {
        out.push({ key: 'nonoffensive_score', severity: 'medium',
          label: returns.length + ' non-offensive or return score' + (returns.length > 1 ? 's' : ''),
          text: 'Points that arrived without an offensive drive. They count the same on the scoreboard and belong to a different distribution from the one the model prices.' });
      }
    }

    /* a one-score game: the model was never tested */
    if (margin != null && margin <= 3) {
      out.push({ key: 'one_score', severity: 'medium',
        label: 'A ' + margin + '-point game',
        text: 'A game this close is decided inside the noise of any projection. Whichever way it fell, it is weak evidence about either team.' });
    }
    return out;
  }

  /* Would the spread have graded differently before the last scoring play?
     Needs the provider's running scores; returns null when they are absent
     rather than guessing at a sequence. */
  function atsFlip(result, bets) {
    var sp = result && result.scoring_plays;
    if (!Array.isArray(sp) || sp.length < 2) return null;
    if (!bets || !bets.spread || !bets.spread.side || bets.spread.point == null) return null;
    var last = null;
    for (var i = sp.length - 1; i >= 0; i--) {
      if (sp[i].home_score != null && sp[i].away_score != null) { last = i; break; }
    }
    if (last == null || last === 0) return null;
    var prev = null;
    for (var j = last - 1; j >= 0; j--) {
      if (sp[j].home_score != null && sp[j].away_score != null) { prev = sp[j]; break; }
    }
    if (!prev) return null;
    var before = gradeSpread({ home_score: prev.home_score, away_score: prev.away_score,
      side: bets.spread.side, point: bets.spread.point });
    var after = gradeSpread({ home_score: result.home_score, away_score: result.away_score,
      side: bets.spread.side, point: bets.spread.point });
    if (!before || !after) return null;
    return { flipped: before.outcome !== after.outcome, before: before.outcome, after: after.outcome };
  }

  /* ------------------------------------------------------- model accuracy */
  function modelAccuracy(snapshot, result) {
    var model = (snapshot && snapshot.model) || {};
    var hs = num(result.home_score), as = num(result.away_score);
    if (!model.priced || hs == null || as == null) {
      return { available: false, why: model.priced ? 'no final score' : 'EdgeDesk did not price this game' };
    }
    /* the model's fair spread, expressed as the home margin it projected —
       from the raw text, never the near-pick'em display floor */
    var md = parseLine(model.fair_spread_raw_text || model.fair_spread_text);
    var home = snapshot.game && snapshot.game.home, away = snapshot.game && snapshot.game.away;
    var mdSide = md ? sideOf(md.team, home, away) : null;
    var projHome = (md && mdSide) ? (mdSide === 'home' ? -md.point : md.point) : null;
    var actualHome = hs - as;
    var totalModel = num(model.total_n != null ? model.total_n : model.total);
    var actualTotal = hs + as;
    var inRange = null, range = model.outcome_range;
    if (range && range.p10 != null && range.p90 != null && range.basis_team) {
      var basisSide = sideOf(range.basis_team, home, away);
      if (basisSide) {
        var basisMargin = basisSide === 'home' ? actualHome : -actualHome;
        var lo = num(range.p10), hi = num(range.p90);
        if (lo != null && hi != null) inRange = basisMargin >= Math.min(lo, hi) && basisMargin <= Math.max(lo, hi);
      }
    }
    return {
      available: true,
      projected_home_margin: projHome == null ? null : r1(projHome),
      actual_home_margin: actualHome,
      margin_error: projHome == null ? null : r1(Math.abs(actualHome - projHome)),
      right_side: projHome == null ? null : ((projHome > 0 && actualHome > 0) || (projHome < 0 && actualHome < 0)),
      projected_total: totalModel == null ? null : r1(totalModel),
      actual_total: actualTotal,
      total_error: totalModel == null ? null : r1(Math.abs(actualTotal - totalModel)),
      projected_score: model.score
        ? { away: num(model.score.away && model.score.away.points), home: num(model.score.home && model.score.home.points) }
        : null,
      inside_published_range: inRange,
      range_text: range && range.p10 != null ? range.p10 + ' → ' + range.p90 + (range.basis_team ? ' (' + range.basis_team + ')' : '') : null
    };
  }

  /* ------------------------------------------------------- the process grade */
  /* FOUR STATES, and each one is a sentence rather than a score:

       SOUND         the mechanism EdgeDesk named is the mechanism that
                     decided the game, whatever the scoreboard did
       MIXED         part of it held and part of it did not
       UNSOUND       the game was decided by something EdgeDesk said would
                     not decide it, or the mechanism ran the other way
       UNTESTED      the result does not separate the cases — a one-score game,
                     a turnover-driven scoreline, or a box score too thin to
                     grade the claims on

     It reads the thesis audit and the variance markers and nothing else. It
     never reads the bet result, which is the entire point. */
  function processGrade(o) {
    var audit = o.audit || [];
    var variance = o.variance || [];
    var acc = o.accuracy || {};
    var reasons = [];

    /* THE PROCESS GRADE IS COMPUTED FROM THE MECHANISM CLAIMS ONLY, and
       excluding the other two is the single most important line in this file.

       A `price` thesis says "this side is better by this much" and a `market`
       thesis says "our number is better than the book's". Both are graded on
       the scoreboard — they ARE the bet result, in longer words. Counting
       them here would fold the result back into the process grade, and the
       two would then agree by construction on every game, which is precisely
       the conflation this whole system exists to undo. A game EdgeDesk lost
       would never be allowed a SOUND process, and a game it won could never
       be called UNSOUND.

       So: drivers, matchups and measured advantages decide the process grade.
       The price and the market claim keep their verdicts, appear in the audit
       table, and are reported as what they are — the result. */
    var mech = audit.filter(function (a) { return a.kind !== 'price' && a.kind !== 'market'; });
    var confirmed = mech.filter(function (a) { return a.evaluation === 'CONFIRMED'; }).length;
    var partial = mech.filter(function (a) { return a.evaluation === 'PARTIALLY CONFIRMED'; }).length;
    var wrong = mech.filter(function (a) { return a.evaluation === 'NOT CONFIRMED'; }).length;
    var graded = confirmed + partial + wrong;

    if (!graded) {
      return { grade: 'UNTESTED',
        reasons: ['None of the mechanism EdgeDesk named before kickoff could be graded against the statistics published for this game. The scoreboard is not evidence about a mechanism nobody could observe.'],
        confirmed: 0, partial: 0, wrong: 0, graded: 0,
        basis: 'the drivers, matchups and measured advantages only — never the price or the market claim, which are the result in longer words' };
    }

    var heavyVariance = variance.filter(function (v) { return v.severity === 'high'; });
    if (heavyVariance.length) {
      reasons.push('The result carries ' + heavyVariance.length + ' high-variance marker'
        + (heavyVariance.length > 1 ? 's' : '') + ' — ' + heavyVariance.map(function (v) { return v.label.toLowerCase(); }).join(', ')
        + ' — so the scoreboard is weaker evidence than it looks.');
    }

    var share = confirmed / graded;
    var wrongShare = wrong / graded;
    var grade;
    if (wrongShare >= 0.5) {
      grade = 'UNSOUND';
      reasons.unshift(wrong + ' of ' + graded + ' gradeable claims went the other way. The read of this matchup was wrong in its mechanism, not only in its number.');
    } else if (share >= 0.5 && wrong === 0) {
      grade = 'SOUND';
      reasons.unshift(confirmed + ' of ' + graded + ' gradeable claims held up and none was contradicted. The game was decided by the things EdgeDesk said would decide it.');
    } else if (confirmed + partial > wrong) {
      grade = 'MIXED';
      reasons.unshift(confirmed + ' claim' + (confirmed === 1 ? '' : 's') + ' held up, ' + partial + ' held up in direction only and '
        + wrong + ' did not. Parts of the read were right and parts were not.');
    } else {
      grade = 'UNSOUND';
      reasons.unshift('More of EdgeDesk’s claims were contradicted than held up.');
    }

    /* a heavily variance-driven game cannot promote a read to SOUND, and it
       does not condemn one either: it makes the evidence thin in both
       directions, which is what UNTESTED means */
    if (heavyVariance.length >= 2 && grade !== 'UNSOUND') {
      grade = 'UNTESTED';
      reasons.push('With this much of the scoreline arriving from outside the matchup, the result does not separate a good read from a lucky one.');
    }

    if (acc.available && acc.margin_error != null) {
      reasons.push('EdgeDesk projected a ' + (acc.projected_home_margin > 0 ? 'home' : 'away') + ' margin of '
        + Math.abs(acc.projected_home_margin) + ' and the game finished '
        + Math.abs(acc.actual_home_margin) + ' the ' + (acc.actual_home_margin > 0 ? 'home' : 'away') + ' way — '
        + acc.margin_error + ' points of margin error'
        + (acc.inside_published_range === true ? ', inside the range the model published.'
          : acc.inside_published_range === false ? ', OUTSIDE the range the model published.' : '.'));
    }

    return { grade: grade, reasons: reasons, confirmed: confirmed, partial: partial, wrong: wrong,
      graded: graded, high_variance: heavyVariance.length,
      basis: 'the drivers, matchups and measured advantages only — never the price or the market claim, which are the result in longer words' };
  }

  /* ---------------------------------------------------------- the verdict */
  /* The four quadrants, said in words, and said the same way every time so a
     reader learns to look for them. */
  var QUADRANT = {
    'win|SOUND': {
      key: 'right_for_the_right_reason',
      line: 'The number landed and the reasoning behind it held up. That is the case EdgeDesk is trying to produce, and it is the only one of the four where the result is evidence the process works.'
    },
    'win|MIXED': {
      key: 'right_partly_for_the_right_reason',
      line: 'The number landed, and some of the reasoning behind it held up. Take the result; do not take it as confirmation of the parts that did not.'
    },
    'win|UNSOUND': {
      key: 'right_for_the_wrong_reason',
      line: 'THE NUMBER LANDED AND THE REASONING DID NOT. This is the most dangerous result on this page, because it pays and teaches nothing. Nothing below should be read as EdgeDesk having understood this game.'
    },
    'win|UNTESTED': {
      key: 'right_untested',
      line: 'The number landed, in a game whose scoreline came largely from outside the matchup. That is a result, not a verification.'
    },
    'loss|SOUND': {
      key: 'wrong_for_the_right_reason',
      line: 'The number did not land and the reasoning did. That is the case a bettor should be least upset about: the read was defensible and the distribution went the other way. Nothing here needs changing yet.'
    },
    'loss|MIXED': {
      key: 'wrong_partly_for_the_right_reason',
      line: 'The number did not land and the reasoning half held. There is something here to investigate without concluding the model is broken.'
    },
    'loss|UNSOUND': {
      key: 'wrong_for_the_wrong_reason',
      line: 'The number did not land and the reasoning did not either. This is the case that should change something, and the lessons below say what.'
    },
    'loss|UNTESTED': {
      key: 'wrong_untested',
      line: 'The number did not land, in a game the statistics cannot grade the reasoning on. It goes in the record and teaches little.'
    },
    'push|SOUND': { key: 'push_sound', line: 'The spread pushed. The reasoning held up, which is the part worth keeping.' },
    'push|MIXED': { key: 'push_mixed', line: 'The spread pushed and the reasoning half held.' },
    'push|UNSOUND': { key: 'push_unsound', line: 'The spread pushed and the reasoning did not hold.' },
    'push|UNTESTED': { key: 'push_untested', line: 'The spread pushed in a game that tested nothing.' }
  };

  function verdictFor(betOutcome, processGradeKey) {
    var q = QUADRANT[String(betOutcome) + '|' + String(processGradeKey)];
    if (q) return q;
    return { key: 'ungraded',
      line: 'No sportsbook quote was captured before publication, so there is no bet result to separate from the process. The reasoning is graded on its own below, which is the half that compounds.' };
  }

  /* ------------------------------------------------------------- the whole */
  /* snapshot + result + audit -> the graded record the postgame article and
     the lesson store both read. */
  function grade(o) {
    o = o || {};
    var snapshot = o.snapshot, result = o.result;
    if (!snapshot || !result) throw new Error('grading needs a pregame snapshot and a game result');
    var audit = o.audit || [];
    var tally = o.tally || null;

    var implied = impliedSide(snapshot);
    var impliedTotal = impliedTotalSide(snapshot);
    var hs = num(result.home_score), as = num(result.away_score);

    var bets = { spread: null, total: null, moneyline: null };
    if (implied.available) {
      bets.spread = gradeSpread({ home_score: hs, away_score: as, side: implied.side, point: implied.point });
      bets.moneyline = gradeMoneyline({ home_score: hs, away_score: as, side: implied.side });
      if (bets.spread) { bets.spread.team = implied.team; bets.spread.line_text = implied.line_text; }
      if (bets.moneyline) bets.moneyline.team = implied.team;
    }
    if (impliedTotal.available) {
      bets.total = gradeTotal({ home_score: hs, away_score: as, side: impliedTotal.side, line: impliedTotal.line });
    }

    var variance = varianceMarkers(result, snapshot, bets);
    var accuracy = modelAccuracy(snapshot, result);
    var proc = processGrade({ audit: audit, tally: tally, variance: variance, accuracy: accuracy });
    var clv = closingLineValue({ implied: implied,
      closing_home_margin: o.closing_home_margin,
      closing_source: o.closing_source,
      closing_absent_reason: o.closing_absent_reason });
    var verdict = verdictFor(bets.spread ? bets.spread.outcome : null, proc.grade);

    return {
      schema: SCHEMA,
      game_id: String(result.game_id || (snapshot.game && snapshot.game.game_id)),
      sport: txt(result.sport) || txt(snapshot.sport),
      snapshot_id: txt(snapshot.snapshot_id),
      graded_at: o.now ? new Date(o.now).toISOString() : new Date().toISOString(),
      final: { home_team: txt(result.home_team), away_team: txt(result.away_team),
        home_score: hs, away_score: as, margin: num(result.margin), total_points: num(result.total_points),
        winner: txt(result.winner) },
      implied_side: implied,
      implied_total: impliedTotal,
      bet_result: bets,
      /* the single word a reader is looking for, and the one this system
         refuses to let stand alone */
      bet_headline: bets.spread
        ? (bets.spread.outcome === 'push' ? 'PUSH' : bets.spread.outcome.toUpperCase())
        : 'NOT GRADED',
      closing_line: clv,
      model_accuracy: accuracy,
      process: proc,
      process_headline: proc.grade,
      variance_markers: variance,
      verdict: verdict,
      /* said once, on every postgame article, because it is the product */
      separation_note: 'The bet result and the process grade above are computed separately and are allowed to disagree. A winning number with a broken thesis is recorded as exactly that.'
    };
  }

  return {
    SCHEMA: SCHEMA, QUADRANT: QUADRANT,
    parseLine: parseLine, sideOf: sideOf,
    gradeSpread: gradeSpread, gradeTotal: gradeTotal, gradeMoneyline: gradeMoneyline,
    impliedSide: impliedSide, impliedTotalSide: impliedTotalSide,
    closingLineValue: closingLineValue, varianceMarkers: varianceMarkers, atsFlip: atsFlip,
    modelAccuracy: modelAccuracy, processGrade: processGrade, verdictFor: verdictFor,
    grade: grade
  };
});
/*__EDED_GRADING_END__*/
