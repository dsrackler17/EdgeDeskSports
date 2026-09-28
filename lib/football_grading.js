/* ===========================================================================
   EdgeDesk Model Collective — FOOTBALL GRADING, version football-v2.

   THE ONE GRADER. Loaded by the browser (window.FootballGrading), by Node
   (require('lib/football_grading.js')) for the settle job, the rebuild and
   the reconciliation tools, and mirrored line for line by the collective.fg2_*
   SQL functions in supabase/migrations/20260928120000_football_grading_v2.sql.
   tools/collective/football_grading_sql.test.js runs the same vectors through
   both and fails on any disagreement, so the page, the job and the database
   cannot grade the same game two ways again.

   Before this file there were four graders: the database's grade_game (a
   stated pick side only), settle_finals.js gradeProjection (a stated pick side
   only), the page's localGrade (a stated side, else a side implied by the
   model's line against the close) and the page's consensus (stated picks
   only). A model that never typed a pick side was graded ATS on the page and
   never in the database, and because the page preferred any database grade it
   received, the same row was graded one way on one game and not at all on the
   next. That is gone: every surface calls these functions or their SQL twins.

   THE SPREAD CONVENTION (canonical, never flipped silently)
   ---------------------------------------------------------
     home_spread < 0   the home team is favoured      (HOME -7)
     home_spread > 0   the home team is the underdog  (HOME +3)
     away_spread       always exactly -home_spread
     actual_margin     home_score - away_score
     ats_margin_home   actual_margin + home_close_spread
       > 0  home covered     < 0  away covered     = 0  push

   THE MODEL'S SIDE
   ----------------
   A side the model SUBMITTED is graded as submitted. With none, the side is
   derived from the model's own fair home spread against the captured close:
     model_edge_home = close_home_spread - model_fair_home_spread
       > 0  HOME   (the model has home stronger than the market does)
       < 0  AWAY
       = 0  no side: the model agrees with the close and names nobody
   Fair HOME -10 into a HOME -7 close: edge +3, HOME.
   Fair HOME -3  into a HOME -7 close: edge -4, AWAY.

   THREE METRICS, THREE SAMPLES
   ----------------------------
     ATS    needs a valid pre-lock prediction, a captured close, a
            determinable side and a final score.
     MAE    |predicted home margin - actual margin|; needs a valid pre-lock
            prediction with a margin and a final. No close needed.
     Brier  (p_home - outcome)^2; needs a valid pre-lock probability and a
            final with a winner. No close needed.
   A game missing what one metric needs is excluded from THAT metric with a
   named reason, never counted as a loss, never folded into another metric.

   THE CAPTURED CLOSE belongs to the GAME, not to a model: selectClose picks
   one official close per event, and every model on the event is graded
   against that one row.
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FootballGrading = factory();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var GRADING_VERSION = 'football-v2';
  var EPS = 1e-9;

  var DEFAULTS = {
    /* collective.lock_minutes(): a game locks 30 minutes before kickoff */
    lockMinutes: 30,
    /* The final-pregame window. A snapshot older than this before kickoff
       is not a close, it is an old price. Configurable per run. */
    closeWindowMinutes: 360,
    /* Two representations of the same fixture may disagree about the
       kickoff (a moved game, a provider in local time). */
    kickoffToleranceMinutes: 36 * 60,
    /* Market sources in the order a close is taken from them. A source not
       listed is never used. `untimed` sources carry no observation time and
       are used only when no timed source has a valid pregame snapshot. */
    sources: [
      { name: 'collective_odds', priority: 1 },
      { name: 'collective_odds_close', priority: 2, untimed: true },
      { name: 'legacy_results_close', priority: 3, untimed: true },
      { name: 'edgedesk_capture', priority: 4 }
    ],
    /* Inside one capture pass, which book's line is the close. */
    bookPriority: ['consensus', 'median', 'pinnacle', 'circa', 'draftkings', 'fanduel',
      'betmgm', 'caesars', 'williamhill_us', 'espnbet', 'bet365', 'pointsbetus', 'betrivers',
      'bovada', 'betonlineag', 'mybookieag', 'lowvig', 'unibet_us', 'wynnbet', 'superbook']
  };

  var FOOTBALL_SPORTS = ['NFL', 'CFB', 'CFB-P4', 'NCAAF'];

  /* Exclusion reasons. Stable strings: the SQL, the API and the page use
     exactly these. */
  var REASON = {
    GAME_CANCELLED: 'GAME_CANCELLED',
    GAME_POSTPONED: 'GAME_POSTPONED',
    GAME_UNFINISHED: 'GAME_UNFINISHED',
    NO_PREDICTION: 'NO_PREDICTION',
    EXCLUDED_ORIGIN: 'EXCLUDED_ORIGIN',
    UNTIMED_SUBMISSION: 'UNTIMED_SUBMISSION',
    LATE_SUBMISSION: 'LATE_SUBMISSION',
    MISSING_CLOSE: 'MISSING_CLOSE',
    NO_ATS_SIDE: 'NO_ATS_SIDE',
    MISSING_FAIR_SPREAD: 'MISSING_FAIR_SPREAD',
    MISSING_PROBABILITY: 'MISSING_PROBABILITY',
    TIE_NO_WINNER: 'TIE_NO_WINNER'
  };

  var REASON_TEXT = {
    GAME_CANCELLED: 'game cancelled',
    GAME_POSTPONED: 'game postponed',
    GAME_UNFINISHED: 'game unfinished',
    NO_PREDICTION: 'no prediction',
    EXCLUDED_ORIGIN: 'backfill or test data',
    UNTIMED_SUBMISSION: 'submission has no server timestamp',
    LATE_SUBMISSION: 'late submission',
    MISSING_CLOSE: 'missing captured close',
    NO_ATS_SIDE: 'no ATS side',
    MISSING_FAIR_SPREAD: 'no projected margin',
    MISSING_PROBABILITY: 'no win probability',
    TIE_NO_WINNER: 'tie, no winner'
  };

  /* ------------------------------------------------------------- numbers */
  function num(v) {
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }
  /* Six decimals, so a float and a numeric agree digit for digit. */
  function r6(x) {
    if (x === null || x === undefined || !isFinite(x)) return null;
    var v = Math.round(x * 1e6) / 1e6;
    return v === 0 ? 0 : v;
  }
  function ms(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var t = Date.parse(v);
    return isFinite(t) ? t : null;
  }
  function iso(t) { return t === null || t === undefined ? null : new Date(t).toISOString(); }

  /* ---------------------------------------------------------------- sides */
  function normSide(v) {
    var s = String(v === null || v === undefined ? '' : v).trim().toLowerCase();
    if (s === 'home' || s === 'h') return 'home';
    if (s === 'away' || s === 'a' || s === 'road' || s === 'visitor') return 'away';
    return null;
  }

  /* --------------------------------------------------------------- the game */
  /* What state a game is in, from its status and its scores. A 0-0 is the
     shape of an empty results form, never a football final. */
  function gameState(g) {
    var st = String((g && g.status) || '').toLowerCase();
    if (/cancel|forfeit/.test(st)) return REASON.GAME_CANCELLED;
    if (/postpon|suspend|delay/.test(st)) return REASON.GAME_POSTPONED;
    var hs = num(g && g.home_score), as = num(g && g.away_score);
    if (hs === null || as === null) return REASON.GAME_UNFINISHED;
    if (hs === 0 && as === 0) return REASON.GAME_UNFINISHED;
    if (hs < 0 || as < 0 || Math.floor(hs) !== hs || Math.floor(as) !== as) return REASON.GAME_UNFINISHED;
    return 'FINAL';
  }

  /* ------------------------------------------------------------ the cover */
  /* The closing-line result for the HOME side. null when anything is
     missing: a missing input is never a default. */
  function atsCover(homeScore, awayScore, homeCloseSpread) {
    var hs = num(homeScore), as = num(awayScore), c = num(homeCloseSpread);
    if (hs === null || as === null || c === null) return null;
    var margin = hs - as;
    var m = r6(margin + c);
    return {
      actual_margin: margin,
      ats_margin_home: m,
      cover: m > 0 ? 'home' : (m < 0 ? 'away' : 'push')
    };
  }

  /* The model's side against a cover. */
  function gradeSide(side, cover) {
    side = normSide(side);
    if (!side || !cover) return null;
    if (cover === 'push') return 'push';
    return side === cover ? 'win' : 'loss';
  }

  /* ----------------------------------------------------- the model's numbers */
  /* The model's fair HOME spread: its stated spread, else the negative of the
     margin its projected scores imply. */
  function fairHomeSpread(p) {
    if (!p) return null;
    var s = num(p.projected_spread);
    if (s !== null) return s;
    var h = num(p.proj_home_score), a = num(p.proj_away_score);
    if (h !== null && a !== null) return r6(-(h - a));
    return null;
  }
  /* The predicted HOME margin for the margin-error metric, by the published
     rule: projected scores when supplied, else the stated spread turned
     around. */
  function predictedHomeMargin(p) {
    if (!p) return null;
    var h = num(p.proj_home_score), a = num(p.proj_away_score);
    if (h !== null && a !== null) return r6(h - a);
    var s = num(p.projected_spread);
    if (s !== null) return r6(-s);
    return null;
  }
  function homeWinProb(p) {
    if (!p) return null;
    var v = num(p.home_win_prob !== undefined ? p.home_win_prob
      : (p.home_win_probability !== undefined ? p.home_win_probability : p.home_ml_prob));
    return (v !== null && v >= 0 && v <= 1) ? v : null;
  }

  /* THE SIDE, one rule for every surface. */
  function deriveSide(explicitSide, fairSpread, closeHomeSpread) {
    var s = normSide(explicitSide);
    if (s) return { side: s, source: 'explicit', edge_home: null };
    var f = num(fairSpread), c = num(closeHomeSpread);
    if (f === null || c === null) return { side: null, source: null, edge_home: null };
    var edge = r6(c - f);
    if (Math.abs(edge) < EPS) return { side: null, source: null, edge_home: 0 };
    return { side: edge > 0 ? 'home' : 'away', source: 'derived', edge_home: edge };
  }

  /* ------------------------------------------------------------- the lock */
  function lockAt(kickoffAt, lockMinutes) {
    var k = ms(kickoffAt);
    if (k === null) return null;
    var m = num(lockMinutes);
    return k - (m === null ? DEFAULTS.lockMinutes : m) * 60000;
  }

  function isLiveOrigin(p) {
    var o = p && p.data_origin, r = p && p.resolution_status;
    if (o !== null && o !== undefined && String(o) !== 'live') return false;
    if (r !== null && r !== undefined && String(r) !== 'resolved') return false;
    return true;
  }

  /* Which of a model's stored versions on one game is graded: the LATEST
     live, resolved version received strictly before the lock. Nothing is
     rewritten; later versions are counted as post-lock edits and ignored.
     `versions` is every row the model ever sent for the game. */
  function selectPrediction(versions, kickoffAt, lockMinutes) {
    var list = (versions || []).filter(Boolean).slice();
    var out = { chosen: null, version: null, n_versions: list.length, n_pre_lock: 0,
      n_post_lock: 0, status: null, lock_at: null };
    var lk = lockAt(kickoffAt, lockMinutes);
    out.lock_at = iso(lk);
    if (!list.length) { out.status = REASON.NO_PREDICTION; return out; }
    list.sort(function (a, b) {
      var ta = ms(a.submitted_at !== undefined ? a.submitted_at : a.received_at);
      var tb = ms(b.submitted_at !== undefined ? b.submitted_at : b.received_at);
      if (ta === null && tb !== null) return 1;
      if (tb === null && ta !== null) return -1;
      if (ta !== tb) return ta - tb;
      return String(a.prediction_id || a.id || '') < String(b.prediction_id || b.id || '') ? -1 : 1;
    });
    var live = [], untimed = 0;
    list.forEach(function (p, i) {
      p.__version = i + 1;
      if (isLiveOrigin(p)) live.push(p);
    });
    if (!live.length) { out.status = REASON.EXCLUDED_ORIGIN; return out; }
    var best = null;
    live.forEach(function (p) {
      var t = ms(p.submitted_at !== undefined ? p.submitted_at : p.received_at);
      if (t === null) { untimed++; return; }
      if (lk !== null && t < lk) { out.n_pre_lock++; best = p; }
      else out.n_post_lock++;
    });
    if (best) {
      out.chosen = best;
      out.version = best.__version;
      out.status = 'OK';
    } else if (untimed && !out.n_post_lock) {
      out.status = REASON.UNTIMED_SUBMISSION;
    } else if (lk === null) {
      out.status = REASON.GAME_UNFINISHED;
    } else {
      out.status = REASON.LATE_SUBMISSION;
    }
    return out;
  }

  /* ------------------------------------------------------- the official close */
  function bookRank(book, prio) {
    var b = String(book || '').toLowerCase();
    var i = (prio || DEFAULTS.bookPriority).indexOf(b);
    return i < 0 ? 999 : i;
  }
  function isSpreadMarket(m) {
    var s = String(m === null || m === undefined ? 'spread' : m).toLowerCase();
    return s === 'spread' || s === 'spreads' || s === 'spread:home' || s === 'point_spread' ||
      s === 'handicap' || s === 'ats';
  }
  function snapHomeLine(s) {
    var h = num(s && s.home_line);
    if (h !== null) return h;
    var a = num(s && s.away_line);
    return a === null ? null : r6(-a);
  }

  /* THE FINAL VALID PREGAME SNAPSHOT.
     - only spread markets with a determinable home line
     - observed strictly before kickoff, and no older than the window
     - sources in configured priority; a source not configured is never read
     - inside a source: the latest observation; one capture pass carrying
       several books is settled by book priority, then snapshot id
     - an untimed source (a close the feed declared, or the close the
       Collective already published) is used only when no timed source has
       a valid snapshot
     - a snapshot whose line is the exact NEGATIVE of the close the
       Collective already published is an orientation error (a home line
       stored as away) and its source is refused for the game
     Never invents, never averages, never reads an in-game price. */
  function selectClose(snapshots, opts) {
    opts = opts || {};
    var kick = ms(opts.kickoffAt);
    var win = num(opts.windowMinutes);
    if (win === null) win = DEFAULTS.closeWindowMinutes;
    var srcList = opts.sources || DEFAULTS.sources;
    var prio = opts.bookPriority || DEFAULTS.bookPriority;
    var legacy = num(opts.legacyClose);
    var srcCfg = {};
    srcList.forEach(function (s) { srcCfg[s.name] = s; });
    var rej = { NOT_SPREAD: 0, BAD_LINE: 0, AFTER_KICKOFF: 0, STALE: 0, UNTIMED: 0,
      SOURCE_DISABLED: 0, ORIENTATION_CONFLICT: 0, NO_KICKOFF: 0 };
    var bySource = {};
    var total = 0;
    (snapshots || []).forEach(function (s) {
      if (!s) return;
      total++;
      if (!isSpreadMarket(s.market_type)) { rej.NOT_SPREAD++; return; }
      var h = snapHomeLine(s);
      if (h === null) { rej.BAD_LINE++; return; }
      var cfg = srcCfg[s.source];
      if (!cfg) { rej.SOURCE_DISABLED++; return; }
      var t = ms(s.observed_at);
      var c = { snap: s, home: h, t: t, rank: bookRank(s.book, prio), timed: t !== null };
      if (t === null) {
        if (!cfg.untimed) { rej.UNTIMED++; return; }
      } else {
        if (kick === null) { rej.NO_KICKOFF++; return; }
        if (t >= kick) { rej.AFTER_KICKOFF++; return; }
        if (t < kick - win * 60000) { rej.STALE++; return; }
      }
      (bySource[s.source] = bySource[s.source] || []).push(c);
    });
    var order = srcList.slice().sort(function (a, b) { return a.priority - b.priority; });
    function pick(cands) {
      return cands.slice().sort(function (a, b) {
        if (a.timed !== b.timed) return a.timed ? -1 : 1;
        if (a.timed && a.t !== b.t) return b.t - a.t;
        if (a.rank !== b.rank) return a.rank - b.rank;
        var ia = String(a.snap.snapshot_id || ''), ib = String(b.snap.snapshot_id || '');
        return ia < ib ? -1 : (ia > ib ? 1 : 0);
      })[0];
    }
    var chosen = null;
    /* timed snapshots first, sources in priority order; an untimed close
       (only ever admitted for an untimed-capable source, above) only when
       no source has a valid timed one */
    [true, false].some(function (wantTimed) {
      return order.some(function (cfg) {
        var cands = (bySource[cfg.name] || []).filter(function (c) { return c.timed === wantTimed; });
        if (!cands.length) return false;
        var best = pick(cands);
        if (legacy !== null && Math.abs(legacy) >= 1 && cfg.name !== 'legacy_results_close' &&
            Math.abs(best.home + legacy) <= 0.5 && Math.abs(best.home - legacy) >= 2) {
          rej.ORIENTATION_CONFLICT += cands.length;
          return false;
        }
        chosen = best;
        return true;
      });
    });
    var status;
    if (chosen) status = 'OK';
    else if (!total) status = 'NO_SNAPSHOT';
    else if (rej.ORIENTATION_CONFLICT) status = 'ORIENTATION_CONFLICT';
    else if (rej.AFTER_KICKOFF && !rej.STALE) status = 'ONLY_AFTER_KICKOFF';
    else if (rej.STALE) status = 'ONLY_STALE';
    else if (rej.SOURCE_DISABLED) status = 'SOURCE_DISABLED';
    else if (rej.NOT_SPREAD === total) status = 'NO_SPREAD_MARKET';
    else status = 'NO_VALID_SNAPSHOT';
    var close = null;
    if (chosen) {
      var s = chosen.snap;
      close = {
        home_spread: chosen.home,
        away_spread: r6(-chosen.home),
        book: s.book || null,
        source: s.source,
        source_event_id: s.source_event_id == null ? null : String(s.source_event_id),
        snapshot_id: s.snapshot_id == null ? null : String(s.snapshot_id),
        observed_at: chosen.t === null ? null : iso(chosen.t),
        kickoff_at: kick === null ? null : iso(kick),
        lead_minutes: (chosen.t === null || kick === null) ? null : r6((kick - chosen.t) / 60000),
        timed: chosen.timed
      };
    }
    return { close: close, status: status, considered: total, rejected: rej };
  }

  /* --------------------------------------------------- one model, one game */
  /* The complete grading trace. Every field a dispute needs, and for each
     metric either a value or the reason there is none. */
  function gradeModelGame(input) {
    input = input || {};
    var g = input.game || {};
    var close = input.close || null;
    var sel = input.selection || selectPrediction(input.versions || [], g.kickoff_at, input.lockMinutes);
    var p = sel.chosen;
    var state = gameState(g);
    var final = state === 'FINAL';
    var hs = final ? num(g.home_score) : null, as = final ? num(g.away_score) : null;
    var margin = final ? hs - as : null;
    var t = {
      grading_version: GRADING_VERSION,
      sport: g.sport || null, season: num(g.season), week: num(g.week),
      game_id: g.game_id == null ? null : String(g.game_id),
      event_label: g.label || ((g.away || '') + ' @ ' + (g.home || '')),
      model_id: input.model_id == null ? null : String(input.model_id),
      prediction_id: p ? String(p.prediction_id || p.id) : null,
      prediction_version: sel.version,
      prediction_versions: sel.n_versions,
      post_lock_versions: sel.n_post_lock,
      submitted_at: p ? iso(ms(p.submitted_at !== undefined ? p.submitted_at : p.received_at)) : null,
      kickoff_at: iso(ms(g.kickoff_at)),
      lock_at: sel.lock_at,
      prediction_status: sel.status,
      fair_home_spread: p ? fairHomeSpread(p) : null,
      predicted_home_margin: p ? predictedHomeMargin(p) : null,
      explicit_side: p ? normSide(p.pick_side) : null,
      ats_side: null, ats_side_source: null, model_edge_home: null,
      close_home_spread: close ? num(close.home_spread) : null,
      close_away_spread: close ? r6(-num(close.home_spread)) : null,
      close_observed_at: close ? close.observed_at || null : null,
      close_book: close ? close.book || null : null,
      close_source: close ? close.source || null : null,
      close_snapshot_id: close ? close.snapshot_id || null : null,
      close_source_event_id: close ? close.source_event_id || null : null,
      game_state: state,
      home_score: hs, away_score: as, actual_margin: margin,
      ats_margin_home: null, cover: null,
      ats_result: null, ats_exclusion: null,
      margin_error: null, mae_exclusion: null,
      home_win_prob: p ? homeWinProb(p) : null, outcome: null,
      brier: null, brier_exclusion: null
    };
    /* the reason shared by every metric when the prediction or the game
       rules the row out */
    var common = null;
    if (!final) common = state;
    else if (sel.status !== 'OK') common = sel.status;

    /* ATS */
    if (common) t.ats_exclusion = common;
    else if (t.close_home_spread === null) t.ats_exclusion = REASON.MISSING_CLOSE;
    else {
      var d = deriveSide(p.pick_side, t.fair_home_spread, t.close_home_spread);
      t.ats_side = d.side; t.ats_side_source = d.source; t.model_edge_home = d.edge_home;
      if (!d.side) t.ats_exclusion = REASON.NO_ATS_SIDE;
      else {
        var cv = atsCover(hs, as, t.close_home_spread);
        t.ats_margin_home = cv.ats_margin_home;
        t.cover = cv.cover;
        t.ats_result = gradeSide(d.side, cv.cover);
      }
    }
    /* even an excluded row states the side it WOULD have had, when both
       numbers exist, so a trace can show what the missing piece cost */
    if (!t.ats_side && p && t.close_home_spread !== null && t.ats_exclusion !== REASON.NO_ATS_SIDE) {
      var d2 = deriveSide(p.pick_side, t.fair_home_spread, t.close_home_spread);
      t.model_edge_home = d2.edge_home;
    }
    if (final && t.close_home_spread !== null && t.cover === null) {
      var cv2 = atsCover(hs, as, t.close_home_spread);
      t.ats_margin_home = cv2.ats_margin_home; t.cover = cv2.cover;
    }

    /* MAE */
    if (common) t.mae_exclusion = common;
    else if (t.predicted_home_margin === null) t.mae_exclusion = REASON.MISSING_FAIR_SPREAD;
    else t.margin_error = r6(Math.abs(t.predicted_home_margin - margin));

    /* Brier */
    if (final) t.outcome = margin > 0 ? 1 : (margin < 0 ? 0 : null);
    if (common) t.brier_exclusion = common;
    else if (t.home_win_prob === null) t.brier_exclusion = REASON.MISSING_PROBABILITY;
    else if (margin === 0) t.brier_exclusion = REASON.TIE_NO_WINNER;
    else t.brier = r6((t.home_win_prob - t.outcome) * (t.home_win_prob - t.outcome));
    return t;
  }

  /* ------------------------------------------------------------ one model */
  function aggregateModel(traces) {
    var a = { wins: 0, losses: 0, pushes: 0, ats_n: 0, ats_graded: 0, ats_pct: null,
      ats_excluded: {}, explicit_side_n: 0, derived_side_n: 0,
      mae: null, mae_n: 0, mae_excluded: {}, brier: null, brier_n: 0, brier_excluded: {},
      model_games: 0, played: 0, valid_predictions: 0, late: 0 };
    var es = 0, bs = 0;
    (traces || []).forEach(function (t) {
      if (!t) return;
      a.model_games++;
      if (t.game_state === 'FINAL') a.played++;
      if (t.prediction_status === 'OK') a.valid_predictions++;
      if (t.prediction_status === REASON.LATE_SUBMISSION) a.late++;
      if (t.ats_result === 'win') a.wins++;
      else if (t.ats_result === 'loss') a.losses++;
      else if (t.ats_result === 'push') a.pushes++;
      if (t.ats_result) {
        if (t.ats_side_source === 'explicit') a.explicit_side_n++;
        else if (t.ats_side_source === 'derived') a.derived_side_n++;
      }
      if (t.ats_exclusion) a.ats_excluded[t.ats_exclusion] = (a.ats_excluded[t.ats_exclusion] || 0) + 1;
      if (t.margin_error !== null && t.margin_error !== undefined) { es += t.margin_error; a.mae_n++; }
      else if (t.mae_exclusion) a.mae_excluded[t.mae_exclusion] = (a.mae_excluded[t.mae_exclusion] || 0) + 1;
      if (t.brier !== null && t.brier !== undefined) { bs += t.brier; a.brier_n++; }
      else if (t.brier_exclusion) a.brier_excluded[t.brier_exclusion] = (a.brier_excluded[t.brier_exclusion] || 0) + 1;
    });
    a.ats_graded = a.wins + a.losses;
    a.ats_n = a.wins + a.losses + a.pushes;
    a.ats_pct = a.ats_graded ? r6(a.wins / a.ats_graded) : null;
    a.mae = a.mae_n ? r6(es / a.mae_n) : null;
    a.brier = a.brier_n ? r6(bs / a.brier_n) : null;
    return a;
  }

  /* Share of the completed games since the model's first submission that it
     posted a valid pre-lock prediction for. */
  function coverage(traces, completedGames) {
    var first = null, have = {};
    (traces || []).forEach(function (t) {
      if (!t || t.prediction_status === REASON.NO_PREDICTION) return;
      var k = ms(t.kickoff_at);
      if (k !== null && (first === null || k < first)) first = k;
      if (t.prediction_status === 'OK') have[t.game_id] = 1;
    });
    if (first === null) return { submitted: 0, slate: 0, pct: null };
    var scope = (completedGames || []).filter(function (g) {
      var k = ms(g.kickoff_at);
      return k !== null && k >= first && gameState(g) === 'FINAL';
    });
    var n = scope.filter(function (g) { return have[String(g.game_id)]; }).length;
    return { submitted: n, slate: scope.length, pct: scope.length ? r6(100 * n / scope.length) : null };
  }

  /* --------------------------------------------------------- the consensus */
  /* The Collective graded as one model, from the SAME traces: the same close,
     the same eligible sides. Fewer than two eligible models or a dead-even
     split is no consensus. */
  function consensusGame(traces) {
    var ats = (traces || []).filter(function (t) { return t && t.ats_result; });
    var out = { game_id: ats.length ? ats[0].game_id : ((traces && traces[0] && traces[0].game_id) || null),
      n_eligible: ats.length, n_home: 0, n_away: 0, side: null, ats_result: null, ats_exclusion: null,
      ml_n: 0, ml_prob_mean: null, ml_pick: null, ml_result: null, ml_exclusion: null };
    ats.forEach(function (t) { if (t.ats_side === 'home') out.n_home++; else if (t.ats_side === 'away') out.n_away++; });
    if (out.n_eligible < 2) out.ats_exclusion = 'FEWER_THAN_2';
    else if (out.n_home === out.n_away) out.ats_exclusion = 'EVEN_SPLIT';
    else {
      out.side = out.n_home > out.n_away ? 'home' : 'away';
      out.ats_result = gradeSide(out.side, ats[0].cover);
    }
    var br = (traces || []).filter(function (t) { return t && t.brier !== null && t.brier !== undefined; });
    out.ml_n = br.length;
    if (br.length < 2) out.ml_exclusion = 'FEWER_THAN_2';
    else {
      var s = 0; br.forEach(function (t) { s += t.home_win_prob; });
      out.ml_prob_mean = r6(s / br.length);
      if (Math.abs(out.ml_prob_mean - 0.5) < EPS) out.ml_exclusion = 'EVEN_SPLIT';
      else {
        out.ml_pick = out.ml_prob_mean > 0.5 ? 'home' : 'away';
        out.ml_result = (out.ml_pick === 'home') === (br[0].outcome === 1) ? 'win' : 'loss';
      }
    }
    return out;
  }
  function consensusRecord(games) {
    var r = { ats: { wins: 0, losses: 0, pushes: 0, n: 0, excluded: {} },
      ml: { wins: 0, losses: 0, n: 0, excluded: {} } };
    (games || []).forEach(function (c) {
      if (!c) return;
      if (c.ats_result === 'win') r.ats.wins++;
      else if (c.ats_result === 'loss') r.ats.losses++;
      else if (c.ats_result === 'push') r.ats.pushes++;
      else if (c.ats_exclusion) r.ats.excluded[c.ats_exclusion] = (r.ats.excluded[c.ats_exclusion] || 0) + 1;
      if (c.ml_result === 'win') r.ml.wins++;
      else if (c.ml_result === 'loss') r.ml.losses++;
      else if (c.ml_exclusion) r.ml.excluded[c.ml_exclusion] = (r.ml.excluded[c.ml_exclusion] || 0) + 1;
    });
    r.ats.n = r.ats.wins + r.ats.losses + r.ats.pushes;
    r.ats.pct = (r.ats.wins + r.ats.losses) ? r6(r.ats.wins / (r.ats.wins + r.ats.losses)) : null;
    r.ml.n = r.ml.wins + r.ml.losses;
    r.ml.pct = r.ml.n ? r6(r.ml.wins / r.ml.n) : null;
    return r;
  }

  /* --------------------------------------------------------- calibration */
  /* Outright probability calibration, independent of ATS. The probability is
     the HOME team's; it is folded onto the side the model favoured, and the
     outcome is whether that side won. Only Brier-eligible rows count, so n
     here always equals the Brier n. */
  var CAL_BUCKETS = [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.0000001]];
  function calibration(traces) {
    var b = CAL_BUCKETS.map(function (x) { return { lo: x[0], hi: Math.min(x[1], 1), n: 0, claimed: 0, hits: 0 }; });
    var n = 0;
    (traces || []).forEach(function (t) {
      if (!t || t.brier === null || t.brier === undefined) return;
      var p = t.home_win_prob, y = t.outcome;
      var q = p >= 0.5 ? p : 1 - p;
      var hit = p >= 0.5 ? y === 1 : y === 0;
      for (var i = 0; i < CAL_BUCKETS.length; i++) {
        if (q >= CAL_BUCKETS[i][0] && q < CAL_BUCKETS[i][1]) {
          b[i].n++; b[i].claimed += q; if (hit) b[i].hits++; n++; break;
        }
      }
    });
    return { n: n, buckets: b.map(function (x) {
      return { lo: x.lo, hi: x.hi, n: x.n, claimed: x.n ? r6(x.claimed / x.n) : null,
        actual: x.n ? r6(x.hits / x.n) : null };
    }) };
  }

  /* --------------------------------------------------------- diagnostics */
  var THRESHOLDS = { market_capture_pct: 95, canonical_match_pct: 99 };
  function pct(a, b) { return b ? r6(100 * a / b) : null; }
  /* One played slate, measured. `games` are the canonical games (with
     scores/status/kickoff), `closes` game_id -> close|null, `traces` every
     model/game trace, `identity` counts from the event linker. */
  function diagnose(input) {
    input = input || {};
    var nowMs = ms(input.now) || Date.now();
    var games = input.games || [], traces = input.traces || [], closes = input.closes || {};
    var id = input.identity || {};
    var predicted = {};
    traces.forEach(function (t) { if (t.prediction_status === 'OK') predicted[t.game_id] = 1; });
    var due = games.filter(function (g) {
      var k = ms(g.kickoff_at), st = gameState(g);
      return k !== null && k < nowMs - 4 * 3600000 && st !== REASON.GAME_CANCELLED && st !== REASON.GAME_POSTPONED;
    });
    var completed = games.filter(function (g) { return gameState(g) === 'FINAL'; });
    var withPred = completed.filter(function (g) { return predicted[String(g.game_id)]; });
    var captured = withPred.filter(function (g) { return closes[String(g.game_id)]; });
    var validRows = traces.filter(function (t) { return t.game_state === 'FINAL' && t.prediction_status === 'OK'; });
    var gradable = validRows.filter(function (t) { return t.close_home_spread !== null && t.ats_side; });
    var graded = validRows.filter(function (t) { return t.ats_result; });
    var gradableUngraded = gradable.filter(function (t) { return !t.ats_result; });
    var maeNoAts = validRows.filter(function (t) {
      return t.margin_error !== null && !t.ats_result && t.close_home_spread !== null &&
        t.ats_exclusion !== REASON.NO_ATS_SIDE;
    });
    var m = {
      completed_games: completed.length,
      completed_games_with_prediction: withPred.length,
      games_with_captured_close: captured.length,
      market_capture_pct: pct(captured.length, withPred.length),
      prediction_coverage_pct: pct(withPred.length, completed.length),
      canonical_match_pct: id.market_events ? pct(id.market_events_matched || 0, id.market_events) : null,
      valid_model_games: validRows.length,
      ats_gradable: gradable.length,
      ats_gradable_pct: pct(gradable.length, validRows.length),
      ats_graded: graded.length,
      ats_graded_pct: pct(graded.length, gradable.length),
      final_score_settlement_pct: pct(due.filter(function (g) { return gameState(g) === 'FINAL'; }).length, due.length),
      duplicate_event_count: id.duplicate_games || 0,
      orphan_snapshot_count: id.orphan_snapshots || 0,
      late_submission_count: traces.filter(function (t) { return t.prediction_status === REASON.LATE_SUBMISSION; }).length,
      gradable_but_ungraded: gradableUngraded.length,
      mae_without_ats_despite_close: maeNoAts.length
    };
    var w = [];
    if (m.market_capture_pct !== null && m.market_capture_pct < THRESHOLDS.market_capture_pct)
      w.push({ level: 'HIGH', code: 'MARKET_CAPTURE_LOW', detail: m.market_capture_pct + '% of completed games with a prediction have a captured close (threshold ' + THRESHOLDS.market_capture_pct + '%)' });
    if (m.canonical_match_pct !== null && m.canonical_match_pct < THRESHOLDS.canonical_match_pct)
      w.push({ level: 'HIGH', code: 'CANONICAL_MATCH_LOW', detail: m.canonical_match_pct + '% of market events resolved to a canonical game (threshold ' + THRESHOLDS.canonical_match_pct + '%)' });
    if (m.gradable_but_ungraded)
      w.push({ level: 'ERROR', code: 'GRADABLE_NOT_GRADED', detail: m.gradable_but_ungraded + ' model-games have a prediction, a close, a side and a final but no ATS grade' });
    if (m.mae_without_ats_despite_close)
      w.push({ level: 'ERROR', code: 'MAE_WITHOUT_ATS', detail: m.mae_without_ats_despite_close + ' model-games carry a margin error and a captured close but no ATS result' });
    if (m.duplicate_event_count)
      w.push({ level: 'HIGH', code: 'DUPLICATE_EVENTS', detail: m.duplicate_event_count + ' games are held under more than one canonical id' });
    if (m.orphan_snapshot_count)
      w.push({ level: 'WARN', code: 'ORPHAN_SNAPSHOTS', detail: m.orphan_snapshot_count + ' market events matched no canonical game' });
    if (m.final_score_settlement_pct !== null && m.final_score_settlement_pct < 100)
      w.push({ level: 'WARN', code: 'FINALS_MISSING', detail: (100 - m.final_score_settlement_pct).toFixed(1) + '% of games past kickoff+4h have no final' });
    return { metrics: m, warnings: w, ok: !w.some(function (x) { return x.level === 'ERROR' || x.level === 'HIGH'; }) };
  }

  return {
    GRADING_VERSION: GRADING_VERSION, DEFAULTS: DEFAULTS, FOOTBALL_SPORTS: FOOTBALL_SPORTS,
    REASON: REASON, REASON_TEXT: REASON_TEXT, THRESHOLDS: THRESHOLDS, CAL_BUCKETS: CAL_BUCKETS,
    num: num, r6: r6, normSide: normSide, gameState: gameState,
    atsCover: atsCover, gradeSide: gradeSide, deriveSide: deriveSide,
    fairHomeSpread: fairHomeSpread, predictedHomeMargin: predictedHomeMargin, homeWinProb: homeWinProb,
    lockAt: lockAt, selectPrediction: selectPrediction, selectClose: selectClose,
    gradeModelGame: gradeModelGame, aggregateModel: aggregateModel, coverage: coverage,
    consensusGame: consensusGame, consensusRecord: consensusRecord,
    calibration: calibration, diagnose: diagnose
  };
});
