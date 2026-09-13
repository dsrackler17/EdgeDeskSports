/*__EDED_THESES_START__*/
/* ============================================================================
   THESES — what EdgeDesk actually claimed, and whether the game bore it out.

   A THESIS IS NOT A PREDICTION OF THE SCORE. It is a falsifiable statement
   about a MECHANISM: "Seattle's pass defence is the better unit here and the
   number leans on that". The point of writing it down before kickoff is that
   afterwards it can be graded on its own terms, separately from whether the
   side covered. That separation is the product.

   EVERY THESIS CARRIES, at the moment it is written:
     claim            what EdgeDesk is saying, in the model's own words
     basis            where in the payload it came from (a path, checkable)
     expected_signal  the metric this should show up in, which SIDE it should
                      favour, and by how much to count
     falsifier        what, specifically, would mean this was wrong
     watch            what a reader can see during the game
     weight           how much of the number rests on it

   AND IS GRADED AFTERWARDS as one of four verdicts:
     CONFIRMED              the signal appeared, on the right side, at size
     PARTIALLY CONFIRMED    the direction was right, the size was not — or one
                            of two required signals appeared
     NOT CONFIRMED          the signal appeared on the WRONG side, or did not
                            appear at all where it should have
     INCONCLUSIVE           the metric was not published for this game, or the
                            sample inside one game cannot separate the cases

   INCONCLUSIVE IS A REAL VERDICT AND IS USED. One game is a sample of one,
   and a thesis about a season-long rate that happens to be true for sixty
   snaps has not been confirmed by them. Where the observation cannot separate
   "right" from "lucky", this says so rather than awarding a tick.

   NOTHING HERE IS WRITTEN BY A LANGUAGE MODEL. Extraction reads the payload;
   grading is arithmetic on the metric vocabulary in results.js. The narration
   layer is given the finished audit and may explain it; it may not alter a
   verdict, and quality.js checks that the verdicts on the page are the
   verdicts in the record.
   ========================================================================== */
(function (root, factory) {
  var api = factory(
    typeof require === 'function' ? require('./results.js') : (root.EDED && root.EDED.results)
  );
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDED = root.EDED || {};
  root.EDED.theses = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (RESULTS) {
  'use strict';

  var SCHEMA = 'edgedesk_thesis_v1';
  var VERDICTS = ['CONFIRMED', 'PARTIALLY CONFIRMED', 'NOT CONFIRMED', 'INCONCLUSIVE'];

  function num(v) { if (v == null || v === '') return null; var n = +v; return isFinite(n) ? n : null; }
  function txt(v) { if (v == null) return null; var s = String(v).replace(/\s+/g, ' ').trim(); return s || null; }
  function r1(v) { return v == null ? null : Math.round(v * 10) / 10; }

  /* ------------------------------------------------- the driver → metric map */
  /* EdgeDesk's models publish their drivers in prose the engine wrote. Each
     pattern below maps one of those to the OBSERVABLE metric that would show
     it, plus a category for the lesson store. A driver that matches nothing
     still becomes a thesis — it is still a claim EdgeDesk made — but its
     expected signal is null and it grades INCONCLUSIVE with "EdgeDesk holds no
     postgame metric that observes this driver", which is the honest answer and
     also, over a season, a list of exactly which drivers the platform cannot
     check on itself. That list is worth more than a guess. */
  var DRIVER_SIGNALS = [
    { re: /net passing epa|passing epa|pass offence|pass offense|passing game/i,
      metrics: ['yards_per_pass', 'net_pass_yards'], category: 'passing' },
    { re: /quarterback|quarterback adjustment|\bqb\b/i,
      metrics: ['yards_per_pass', 'completion_pct'], category: 'QB' },
    { re: /net epa per play|epa per play|team strength|overall rating|etsr/i,
      metrics: ['yards_per_play'], category: 'efficiency' },
    { re: /rushing|run offence|run offense|run game|yards per carry/i,
      metrics: ['yards_per_rush', 'rush_yards'], category: 'rushing' },
    { re: /explosive/i, metrics: ['yards_per_play'], category: 'explosiveness',
      note: 'no provider in this repository publishes an explosive-play rate for a single game, so this is observed on yards per play, which is a weaker instrument and the verdict says so.' },
    { re: /sack|pressure|pass rush|trench|offensive line|defensive line/i,
      metrics: ['sacks_generated', 'sacks_allowed'], category: 'pressure' },
    { re: /points scored and allowed|scoring rating|combined scoring/i,
      metrics: ['points'], category: 'scoring' },
    { re: /pace|plays per game|tempo/i, metrics: ['total_plays', 'plays_per_minute'], category: 'pace' },
    { re: /special teams|kicking|field goal|punt/i, metrics: [], category: 'special_teams',
      note: 'EdgeDesk publishes no postgame special-teams metric in this build.' },
    { re: /turnover/i, metrics: ['turnover_margin', 'turnovers'], category: 'turnovers' },
    { re: /home field|home advantage|travel|rest/i, metrics: [], category: 'home_field',
      note: 'home advantage is priced into the number and cannot be isolated from one game’s box score.' },
    { re: /talent|continuity|depth|roster/i, metrics: [], category: 'continuity',
      note: 'a roster-construction input does not appear as a single-game statistic.' },
    { re: /baseline|constant/i, metrics: [], category: 'model_baseline',
      note: 'a model constant is not a claim about this game and is not audited as one.' },
    { re: /third down/i, metrics: ['third_down_pct'], category: 'situational' },
    { re: /red zone/i, metrics: ['red_zone_pct'], category: 'situational' },
    { re: /defence|defense|epa allowed/i, metrics: ['yards_per_play'], category: 'defence' }
  ];
  function signalFor(text) {
    var s = String(text || '');
    for (var i = 0; i < DRIVER_SIGNALS.length; i++) {
      if (DRIVER_SIGNALS[i].re.test(s)) return DRIVER_SIGNALS[i];
    }
    return null;
  }

  /* Which side a driver or matchup favours, as a 'home' / 'away' key. The
     payload names a team; the snapshot knows which team is which. */
  function sideOf(teamName, snap) {
    var t = txt(teamName);
    if (!t) return null;
    var h = txt(snap.game && snap.game.home), a = txt(snap.game && snap.game.away);
    if (h && t === h) return 'home';
    if (a && t === a) return 'away';
    /* the payload occasionally carries a short name; fall back to containment,
       and only when exactly one side matches */
    var hIn = h && (h.indexOf(t) >= 0 || t.indexOf(h) >= 0);
    var aIn = a && (a.indexOf(t) >= 0 || t.indexOf(a) >= 0);
    if (hIn && !aIn) return 'home';
    if (aIn && !hIn) return 'away';
    return null;
  }
  function teamOf(side, snap) {
    return side === 'home' ? txt(snap.game && snap.game.home)
      : side === 'away' ? txt(snap.game && snap.game.away) : null;
  }

  function thesis(o) {
    return {
      schema: SCHEMA,
      thesis_id: o.thesis_id,
      kind: o.kind,
      claim: txt(o.claim),
      basis: txt(o.basis),
      source_path: txt(o.source_path),
      category: o.category || 'model',
      weight: o.weight == null ? null : r1(o.weight),
      favours_side: o.favours_side || null,
      favours_team: o.favours_team || null,
      expected_signal: o.expected_signal || null,
      falsifier: txt(o.falsifier),
      watch: txt(o.watch),
      observable: !!(o.expected_signal && o.expected_signal.metrics && o.expected_signal.metrics.length),
      not_observable_why: txt(o.not_observable_why)
    };
  }

  /* ---------------------------------------------------------- extraction */
  /* IN A FIXED ORDER, so two runs on the same snapshot produce the same
     theses with the same ids. The id is the source path, which is stable
     across runs and readable in a database row. */
  function extract(snap, opts) {
    opts = opts || {};
    var out = [];
    if (!snap) return out;
    var model = snap.model || {};
    var home = txt(snap.game && snap.game.home), away = txt(snap.game && snap.game.away);

    /* 1 — THE PRICE ITSELF. The one claim every priced article makes. */
    if (model.priced && model.fair_spread_text) {
      var fav = txt(model.favourite), dog = txt(model.underdog);
      var favSide = sideOf(fav, snap);
      out.push(thesis({
        thesis_id: 'price',
        kind: 'price',
        claim: 'EdgeDesk prices this game at ' + model.fair_spread_text
          + (model.total ? ' with a fair total of ' + model.total : '')
          + ', which makes ' + (fav || 'one side') + ' the better team here by that margin on this field.',
        basis: 'the model’s own fair spread',
        source_path: 'model.fair_spread_text',
        category: 'market',
        weight: Math.abs(num(model.fair_spread) || 0),
        favours_side: favSide, favours_team: fav,
        expected_signal: { metrics: ['margin'], side: favSide, direction: 'high',
          threshold: 0, unit: 'points',
          projected: Math.abs(num(model.fair_spread) || 0),
          note: 'the model’s margin is the centre of a distribution, so the test is the SIGN and the neighbourhood, never the exact number.' },
        falsifier: dog ? dog + ' winning the game outright, or the margin landing on the wrong side of zero.' : 'the margin landing on the wrong side of zero.',
        watch: 'Whether ' + (fav || 'the favourite') + ' is ahead on the scoreboard in a way that looks like ' + model.fair_spread_text + ' rather than a coin flip.'
      }));
    }

    /* 2 — THE DISAGREEMENT. Where EdgeDesk differs from the market, which is
           the reason a research article exists at all. */
    var m = snap.market;
    if (m && m.available && m.difference) {
      var gap = num(String(m.difference).replace(/[^0-9.]/g, ''));
      var mk = marketMargin(m.market, txt(model.favourite), snap);
      out.push(thesis({
        thesis_id: 'market_gap',
        kind: 'market',
        claim: 'EdgeDesk makes it ' + txt(m.model) + ' where the market has ' + txt(m.market)
          + (m.book ? ' at ' + txt(m.book) : '') + ' — a ' + txt(m.difference) + ' disagreement.',
        basis: 'EdgeDesk’s own number against a captured sportsbook quote',
        source_path: 'market.difference',
        category: 'market',
        weight: gap,
        favours_side: sideOf(txt(model.favourite), snap), favours_team: txt(model.favourite),
        expected_signal: { metrics: ['margin'], side: sideOf(txt(model.favourite), snap),
          direction: 'high', threshold: gap, unit: 'points',
          /* THE NUMBER IS CARRIED, NOT RE-READ. The margin the side EdgeDesk
             preferred had to beat is computed here, once, where the structured
             market block is in hand — never parsed back out of the sentence
             above, which is prose and would break the first time the wording
             changed. */
          market_margin: mk.margin, market_text: txt(m.market),
          market_margin_why: mk.why,
          note: 'for the disagreement to have been information rather than noise, the result has to land on EdgeDesk’s side of the MARKET number, not merely on the right side of zero.' },
        falsifier: 'the game landing between the two numbers, or on the market’s side of them — either of which means the market read this matchup better than EdgeDesk did.',
        watch: 'Whether the scoreboard ever reaches the gap between ' + txt(m.market) + ' and ' + txt(m.model) + '.'
      }));
    }

    /* 3 — THE DRIVERS. The engine's own largest published contributions. */
    var drivers = (snap.drivers && snap.drivers.rows) || [];
    drivers.slice(0, 6).forEach(function (d, i) {
      var text = txt(d.text);
      if (!text) return;
      var sig = signalFor(text);
      var side = sideOf(d.favours, snap);
      var pts = Math.abs(num(d.points_n) || 0);
      /* a model constant is not a claim about this game; it is carried as a
         thesis so the audit is complete, but it is never graded */
      var isConstant = /baseline|constant/i.test(text);
      out.push(thesis({
        thesis_id: 'driver.' + i,
        kind: 'driver',
        claim: text + ' — worth ' + txt(d.points) + ' of the EdgeDesk number'
          + (d.favours ? ', in ' + txt(d.favours) + '’s favour.' : '.'),
        basis: 'the engine’s own additive contribution to this price',
        source_path: 'drivers.rows[' + i + ']',
        category: sig ? sig.category : 'model',
        weight: pts,
        favours_side: side, favours_team: txt(d.favours),
        expected_signal: (sig && sig.metrics.length && side && !isConstant)
          ? { metrics: sig.metrics, side: side, direction: 'high', threshold: null, unit: null, note: sig.note || null }
          : null,
        not_observable_why: isConstant
          ? 'a model constant is not a claim about this game and is not graded as one'
          : (sig && sig.note) || (sig && !sig.metrics.length ? 'no single-game statistic in EdgeDesk’s vocabulary observes this driver'
            : (!side ? 'the driver names no side, so there is nothing to test a direction against'
              : 'no single-game statistic in EdgeDesk’s vocabulary observes this driver')),
        falsifier: side
          ? teamOf(side === 'home' ? 'away' : 'home', snap) + ' winning this part of the game instead.'
          : 'the mechanism running the other way.',
        watch: sig && sig.metrics.length
          ? 'Whether ' + (txt(d.favours) || 'the side this favours') + ' is actually ahead on '
            + sig.metrics.map(function (k) { return (RESULTS.METRICS[k] || {}).label || k; }).join(' and ') + '.'
          : null
      }));
    });

    /* 4 — THE MATCHUPS. The model's own unit-versus-unit reads, which is where
           a football reader actually looks. */
    (snap.matchups || []).slice(0, 4).forEach(function (mm, i) {
      var read = txt(mm.read);
      if (!read || !mm.complete) return;
      var sig = signalFor(txt(mm.title) || read);
      /* the payload's `net` is signed toward the model's own convention; the
         read sentence names the side, which is what is trusted here */
      var favTeam = null;
      var fm = /which favours ([^.]+)\.?$/.exec(read);
      if (fm) favTeam = txt(fm[1]);
      var side = sideOf(favTeam, snap);
      out.push(thesis({
        thesis_id: 'matchup.' + i,
        kind: 'matchup',
        claim: read,
        basis: 'the model’s own unit ratings for both sides of this pairing',
        source_path: 'matchups[' + i + ']',
        category: sig ? sig.category : 'matchup',
        weight: Math.abs(num(mm.net) || 0) * 10,
        favours_side: side, favours_team: favTeam,
        expected_signal: (sig && sig.metrics.length && side)
          ? { metrics: sig.metrics, side: side, direction: 'high', threshold: null, unit: null, note: sig.note || null }
          : null,
        not_observable_why: side ? 'no single-game statistic in EdgeDesk’s vocabulary observes this pairing'
          : 'the read does not name a side, so there is no direction to test',
        falsifier: favTeam ? 'the pairing going the other way — ' + favTeam + ' losing the phase it is rated to win.' : null,
        watch: txt(mm.title) ? 'How ' + txt(mm.title).replace(/\s+vs\s+/i, ' handles ') + ' looks on early downs.' : null
      }));
    });

    /* 5 — THE LARGEST MEASURED ADVANTAGE ON EACH SIDE. */
    ['away', 'home'].forEach(function (sideKey) {
      var adv = ((snap.advantages && snap.advantages[sideKey]) || [])[0];
      if (!adv || !adv.text) return;
      var sig = signalFor(txt(adv.k) || txt(adv.text));
      out.push(thesis({
        thesis_id: 'advantage.' + sideKey,
        kind: 'advantage',
        claim: txt(adv.lead) + ' holds the largest measured edge in this matchup: ' + txt(adv.text),
        basis: 'both teams carry a rank in this category, so the gap between them is measured rather than assumed',
        source_path: 'advantages.' + sideKey + '[0]',
        category: sig ? sig.category : 'matchup',
        weight: Math.abs(num(adv.rank_gap) || 0) / 4,
        favours_side: sideKey, favours_team: txt(adv.lead),
        expected_signal: (sig && sig.metrics.length)
          ? { metrics: sig.metrics, side: sideKey, direction: 'high', threshold: null, unit: null, note: sig.note || null }
          : null,
        not_observable_why: 'no single-game statistic in EdgeDesk’s vocabulary observes ' + (txt(adv.k) || 'this category'),
        falsifier: txt(adv.trail) + ' winning that category on the day.',
        watch: 'Whether ' + txt(adv.lead) + '’s edge in ' + (txt(adv.k) || 'that category') + ' shows up in the box score.'
      }));
    });

    /* 6 — THE PRIMARY UNCERTAINTY, as a thesis about what could break the read.
           It is graded like the others: if the thing EdgeDesk worried about is
           what happened, that is a CONFIRMED uncertainty and a real lesson. */
    var items = (snap.uncertainty && snap.uncertainty.items) || [];
    var top = null;
    ['HIGH', 'MEDIUM', 'LOW'].forEach(function (sev) {
      if (!top) top = items.filter(function (x) { return x.sev === sev; })[0] || null;
    });
    if (top) {
      out.push(thesis({
        thesis_id: 'uncertainty.primary',
        kind: 'uncertainty',
        claim: 'The largest stated risk to this read: ' + txt(top.text),
        basis: 'the model’s own highest-severity published uncertainty',
        source_path: 'uncertainty.items[0]',
        category: 'data_quality',
        weight: top.sev === 'HIGH' ? 3 : top.sev === 'MEDIUM' ? 2 : 1,
        favours_side: null, favours_team: null,
        expected_signal: null,
        not_observable_why: 'an uncertainty is graded by whether the result is consistent with it, which is a reading rather than a measurement',
        falsifier: 'the game passing off without the stated gap mattering.',
        watch: txt(top.label) ? 'Anything that turns on ' + txt(top.label) + '.' : null
      }));
    }

    return out;
  }

  /* ------------------------------------------------------------ the audit */
  /* Grade one thesis against the observed game. Deterministic, and every
     verdict carries the arithmetic that produced it. */
  /* "At size" is decided per metric, in results.js, because half a yard per
     play is a large edge and half a sack is nothing. STRONG remains only as
     the documented default for a metric that declares neither bar. */
  var STRONG = 0.25;

  function evaluate(t, result, opts) {
    opts = opts || {};
    var base = {
      thesis_id: t.thesis_id, kind: t.kind, category: t.category, claim: t.claim,
      weight: t.weight, favours_team: t.favours_team, favours_side: t.favours_side,
      expected_signal: t.expected_signal, observed: [], observed_result: null,
      evaluation: 'INCONCLUSIVE', confidence: 'low', why: null
    };
    if (!t.expected_signal || !t.expected_signal.metrics || !t.expected_signal.metrics.length) {
      base.why = t.not_observable_why || 'this claim has no observable single-game signal in EdgeDesk’s metric vocabulary';
      base.observed_result = 'Not observable from the statistics published for this game.';
      return base;
    }
    var side = t.expected_signal.side;
    if (!side) {
      base.why = 'the claim names no side, so there is no direction to grade';
      base.observed_result = 'Not gradeable: the claim names no side.';
      return base;
    }

    /* PRICE and MARKET theses are graded on the scoreboard, which needs its
       own arithmetic: the margin is signed toward one team and compared with
       a threshold rather than with the opponent. */
    if (t.kind === 'price' || t.kind === 'market') {
      return evaluateMargin(t, result, base);
    }

    var hits = [];
    t.expected_signal.metrics.forEach(function (k) {
      var o = RESULTS.observed(result, k);
      hits.push(o);
    });
    base.observed = hits;
    var usable = hits.filter(function (h) { return h.available; });
    if (!usable.length) {
      base.why = hits.map(function (h) { return h.why; }).filter(Boolean)[0]
        || 'the box score for this game published none of the statistics this claim would show up in';
      base.observed_result = 'Not published for this game.';
      base.evaluation = 'INCONCLUSIVE';
      return base;
    }

    /* Did the favoured side actually win each metric, and by how much relative
       to the two sides' own scale? A 0.4-yard edge in yards per play is not
       the same size as a 0.4-sack edge, so the comparison is proportional. */
    var scored = usable.map(function (h) {
      var M = RESULTS.METRICS[h.metric] || {};
      var mine = side === 'home' ? h.home : h.away;
      var theirs = side === 'home' ? h.away : h.home;
      var good = M.better === 'low' ? (mine < theirs) : (mine > theirs);
      var tie = mine === theirs;
      var scale = Math.max(Math.abs(mine), Math.abs(theirs), 1e-9);
      var rel = Math.abs(mine - theirs) / scale;
      return { metric: h.metric, label: h.label, unit: h.unit, mine: mine, theirs: theirs,
        team: teamOfSide(side, result), opponent: teamOfSide(side === 'home' ? 'away' : 'home', result),
        won: !!good && !tie, tie: tie, size: Math.round(rel * 1000) / 1000,
        at_size: !!good && !tie && RESULTS.atSize(h.metric, mine, theirs) };
    });
    base.observed = base.observed.map(function (h) {
      var s = scored.filter(function (x) { return x.metric === h.metric; })[0];
      return s ? Object.assign({}, h, { won: s.won, tie: s.tie, size: s.size, at_size: s.at_size }) : h;
    });

    var won = scored.filter(function (s) { return s.won; }).length;
    var atSize = scored.filter(function (s) { return s.at_size; }).length;
    var lost = scored.filter(function (s) { return !s.won && !s.tie; }).length;
    var n = scored.length;

    if (atSize === n) { base.evaluation = 'CONFIRMED'; base.confidence = 'medium'; }
    else if (won === n) { base.evaluation = 'PARTIALLY CONFIRMED'; base.confidence = 'medium';
      base.why = 'the direction was right on every signal, but none of the gaps was wide enough in one game to call it settled'; }
    else if (won > 0) { base.evaluation = 'PARTIALLY CONFIRMED'; base.confidence = 'low';
      base.why = won + ' of ' + n + ' expected signals went the way EdgeDesk expected'; }
    else if (lost === n) { base.evaluation = 'NOT CONFIRMED'; base.confidence = 'medium';
      base.why = 'every signal this claim rests on went the other way'; }
    else { base.evaluation = 'INCONCLUSIVE'; base.confidence = 'low';
      base.why = 'the signals were level'; }

    /* ONE GAME IS A SAMPLE OF ONE, AND A RATE CLAIM NEEDS MORE THAN THAT.
       A season-long efficiency edge that showed up over fifty snaps is
       evidence, not proof, so a confirmed rate thesis is capped at medium
       confidence and says so in the record rather than on a scoreboard. */
    base.sample_note = 'Graded on one game. A single result can confirm a direction; it cannot establish a rate.';
    base.observed_result = scored.map(function (s) {
      return s.team + ' ' + fmt(s.mine) + ' ' + s.label + ' against ' + s.opponent + ' ' + fmt(s.theirs);
    }).join('; ') + '.';
    return base;
  }

  function fmt(v) { return v == null ? '—' : (Math.round(v * 100) / 100); }
  function teamOfSide(side, result) {
    return side === 'home' ? txt(result.home_team) : txt(result.away_team);
  }

  /* The scoreboard theses. `price` asks only whether the sign was right and
     whether the margin was in the neighbourhood of the projection; `market`
     asks the harder question — did the result land on EdgeDesk's side of the
     MARKET number, which is the only version of "the disagreement was
     information" that means anything. */
  function evaluateMargin(t, result, base) {
    var hs = num(result.home_score), as = num(result.away_score);
    if (hs == null || as == null) {
      base.why = 'no final score'; base.observed_result = 'No final score.';
      return base;
    }
    var side = t.expected_signal.side;
    var mine = side === 'home' ? hs : as, theirs = side === 'home' ? as : hs;
    var margin = mine - theirs;
    var team = teamOfSide(side, result), opp = teamOfSide(side === 'home' ? 'away' : 'home', result);
    base.observed = [{ metric: 'margin', label: 'scoring margin', available: true,
      home: hs - as, away: as - hs, diff: margin }];

    if (t.kind === 'price') {
      var proj = Math.abs(num((t.expected_signal && t.expected_signal.projected)) != null
        ? num(t.expected_signal.projected) : num(t.weight) || 0);
      base.observed_result = team + ' ' + (margin >= 0 ? 'won by ' : 'lost by ') + Math.abs(margin)
        + ' where EdgeDesk projected a ' + (proj ? proj.toFixed(1) + '-point' : '') + ' edge.';
      if (margin > 0 && proj && Math.abs(Math.abs(margin) - proj) <= Math.max(7, proj * 0.5)) {
        base.evaluation = 'CONFIRMED'; base.confidence = 'medium';
        base.why = 'the right side won and the margin landed in the neighbourhood of the projection';
      } else if (margin > 0) {
        base.evaluation = 'PARTIALLY CONFIRMED'; base.confidence = 'medium';
        base.why = 'the side EdgeDesk made better won, but by a margin the projection did not describe';
      } else if (margin === 0) {
        base.evaluation = 'INCONCLUSIVE'; base.why = 'the game ended level';
      } else {
        base.evaluation = 'NOT CONFIRMED'; base.confidence = 'high';
        base.why = opp + ' won the game outright';
      }
      return base;
    }

    /* market */
    var gap = num(t.weight) || 0;
    base.observed_result = team + ' ' + (margin >= 0 ? 'won by ' : 'lost by ') + Math.abs(margin) + '.';
    if (!gap) { base.evaluation = 'INCONCLUSIVE'; base.why = 'no measurable gap between the two numbers'; return base; }
    /* the market number as a margin the favoured side had to beat, carried on
       the thesis since extraction */
    var mk = num(t.expected_signal && t.expected_signal.market_margin);
    if (mk == null) {
      base.evaluation = 'INCONCLUSIVE';
      base.why = (t.expected_signal && t.expected_signal.market_margin_why)
        || 'the captured market number could not be read as a margin, so "EdgeDesk’s side of it" has no arithmetic';
      return base;
    }
    if (margin > mk) {
      base.evaluation = 'CONFIRMED'; base.confidence = 'medium';
      base.why = 'the result landed on EdgeDesk’s side of the market number: ' + team + ' beat a margin of ' + mk;
    } else if (margin === mk) {
      base.evaluation = 'INCONCLUSIVE'; base.confidence = 'medium';
      base.why = 'the result landed exactly on the market number — a push settles nothing about the disagreement';
    } else if (margin > 0) {
      base.evaluation = 'PARTIALLY CONFIRMED'; base.confidence = 'medium';
      base.why = 'the side EdgeDesk preferred won, but did not clear the market number, so the market had the better estimate of the size';
    } else {
      base.evaluation = 'NOT CONFIRMED'; base.confidence = 'high';
      base.why = 'the result landed on the market’s side of the disagreement';
    }
    return base;
  }
  /* THE CAPTURED MARKET SPREAD, re-expressed as "the margin the side EdgeDesk
     preferred had to beat". Read from the structured market block at
     extraction time and stored on the thesis, so the audit never parses a
     sentence. "Seattle Seahawks -1.0" and a model favourite of Seattle means
     Seattle had to win by more than 1; the same quote with New England as the
     model's favourite means New England had to beat a margin of −1, that is,
     lose by less than one point. Both are arithmetic, and both are refused
     rather than guessed at when the quote names neither side. */
  function marketMargin(marketText, favourite, snap) {
    var s = txt(marketText);
    if (!s) return { margin: null, why: 'no captured market number' };
    var mm = /^(.*?)\s*([+-]?\d+(?:\.\d+)?)\s*$/.exec(s);
    if (!mm) return { margin: null, why: 'the captured market quote "' + s + '" is not a team and a number' };
    var named = txt(mm[1]), v = num(mm[2]);
    if (named == null || v == null) return { margin: null, why: 'the captured market quote carries no readable line' };
    var namedSide = sideOf(named, snap), favSide = sideOf(favourite, snap);
    if (!namedSide || !favSide) {
      return { margin: null, why: 'the captured quote names "' + named + '", which does not resolve to either team in this game' };
    }
    /* the quote is written from the named side's perspective: -1.0 means that
       side must win by more than 1. Expressed from the favourite's side, that
       is -v when they are the same team and +v when they are not. */
    return { margin: namedSide === favSide ? -v : v, why: null };
  }

  function audit(theses, result, opts) {
    return (theses || []).map(function (t) { return evaluate(t, result, opts); });
  }

  /* A one-line summary of an audit, for the article, the operator console and
     the long-term memory. */
  function tally(audited) {
    var t = { CONFIRMED: 0, 'PARTIALLY CONFIRMED': 0, 'NOT CONFIRMED': 0, INCONCLUSIVE: 0 };
    (audited || []).forEach(function (a) { if (t[a.evaluation] != null) t[a.evaluation]++; });
    var graded = t.CONFIRMED + t['PARTIALLY CONFIRMED'] + t['NOT CONFIRMED'];
    return {
      counts: t, graded: graded, total: (audited || []).length,
      not_observable: t.INCONCLUSIVE,
      /* deliberately NOT a percentage score. A ratio of confirmations is a
         number people would start optimising, and the whole point of the audit
         is that a thesis can be wrong in a game EdgeDesk won. */
      headline: graded
        ? t.CONFIRMED + ' of ' + graded + ' gradeable claims held up, ' + t['NOT CONFIRMED'] + ' did not'
        : 'no claim in this article could be graded against the statistics published for this game'
    };
  }

  return {
    SCHEMA: SCHEMA, VERDICTS: VERDICTS, DRIVER_SIGNALS: DRIVER_SIGNALS, STRONG: STRONG,
    signalFor: signalFor, sideOf: sideOf, thesis: thesis, marketMargin: marketMargin,
    extract: extract, evaluate: evaluate, audit: audit, tally: tally
  };
});
/*__EDED_THESES_END__*/
