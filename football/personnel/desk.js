/*__EDPERSONNEL_START__*/
/* ============================================================================
   PERSONNEL AVAILABILITY FOR THE AI DESK — deterministic answers over
   football/personnel/current.json.

   Answers, simply, from the committed assessment and nothing else:
     "How much does this injury matter?"            IMPACT
     "How important is the missing left tackle?"    IMPACT (a named slot)
     "Which team is more affected by injuries?"     COMPARE
     "Who replaces this player?"                    REPLACEMENT
     "Are the injuries concentrated in one unit?"   UNIT
     "Does this defense have meaningful losses?"    UNIT (a named side of the ball)
     "What are the injuries for Oklahoma?"          SUMMARY

   Every number in an answer is a number the assessment published, and every
   answer ends by saying EdgeDesk applies no point-spread adjustment because
   the injury coefficient is untrained. The quarterback is not answered here:
   the trained QB layer owns him. Betting questions are left to the desk.

   It also supplies the compact block the research packet carries (so the
   writing model may quote it and the critic may check against it) and a
   critic check that fails prose converting an injury into spread points.

   Node (module.exports) and the edge function (globalThis.EDPERSONNEL,
   inlined by tools/presentation/inline.js).
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDPERSONNEL = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = 'personnel_desk_v1';
  var SCHEMA = 'edgedesk_personnel_desk_v1';
  var NO_ADJUSTMENT = 'EdgeDesk is not applying a point-spread adjustment for it: the injury coefficient has not been trained, so the projection effect is 0.0 points.';

  function num(x) { return typeof x === 'number' && isFinite(x); }
  function nk(s) {
    if (s == null) return '';
    var v = String(s).toLowerCase();
    try { v = v.normalize('NFKD').replace(/[̀-ͯ]/g, ''); } catch (_) {}
    return v.replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function poss(n) { return /s$/i.test(String(n)) ? n + '’' : n + '’s'; }
  function pct(x) { return num(x) ? Math.round(x * 100) + '%' : null; }

  /* ------------------------------------------------------------ intent */
  var RX_PERSONNEL = /\b(injur(y|ies|ed)|hurt|missing|absence|absences|absent|availability|questionable|doubtful|ruled out|personnel|depth chart|backup|replac\w*|fill(s|ing)? in|next man|concentrat\w*|losses|without)\b/i;
  var RX_QB = /\b(qb|qbs|quarterbacks?|signal[- ]caller)\b/i;
  var RX_BETTING = /\b(worth (a )?(bet|betting|a play)|bet|bets|betting|wager\w*|how many units|\d+(\.\d+)? units?|stake|kelly|parlay|moneyline|money line|ml|price|edge|value|safer|safest|(take|lay|play) the|the (over|under)|over\/under|cover(s|ing)?( the)? (spread|number))\b/i;
  var RX_REPLACEMENT = /\b(who (replaces|will replace|would replace|fills in|steps in|takes over|starts in (his|her|their) place|plays instead)|replac(e|es|ement|ing)|next man up|backup|fill(s|ing)? in for|in (his|her|their) place)\b/i;
  var RX_COMPARE = /\b(which|what) (team|side)\b|\bwho\b[^?]*\b(more|most|worse|bigger)\b|\bmore affected\b|\bcompare\b/i;
  var RX_SUMMARY = /\binjury reports?\b|\bwho('s| is| are)( [a-z]+)? (out|hurt|injured|missing|questionable|doubtful)\b|\bany (injur\w*|absences)\b|\blist (the |their )?(injur\w*|absences)\b|\bwhat (are|were) (the |their |his )?(injur\w*|absences)\b/i;
  var RX_IMPACT_WORDS = /\b(matter\w*|impact\w*|important|importance|how much|how big|how bad|how serious|significan\w*)\b/i;
  var RX_UNIT = /\b(concentrat\w*|one unit|same unit|position group|unit|units)\b|\b(defen[cs]e|offen[cs]e|secondary|front|line|linebackers?|receivers?|backfield)\b[^?]*\b(losses|injur\w*|personnel|missing|hurt)\b|\b(losses|injur\w*|personnel)\b[^?]*\b(defen[cs]e|offen[cs]e|secondary|line|linebackers|receivers|backfield)\b/i;

  function classify(q) {
    var s = String(q || '');
    if (!s || !(RX_PERSONNEL.test(s) || RX_SUMMARY.test(s))) return null;
    if (RX_QB.test(s)) return null;          /* the QB layer owns him */
    if (RX_BETTING.test(s)) return null;     /* the desk owns prices */
    if (RX_REPLACEMENT.test(s)) return 'REPLACEMENT';
    if (RX_COMPARE.test(s)) return 'COMPARE';
    if (RX_UNIT.test(s)) return 'UNIT';
    if (RX_SUMMARY.test(s) && !RX_IMPACT_WORDS.test(s)) return 'SUMMARY';
    return 'IMPACT';
  }

  /* --------------------------------------------------- what a phrase names */
  var PHRASES = [
    { rx: /\bleft tackle\b|\blt\b/i, want: { slots: ['OT', 'OL'], labels: ['LT'] } },
    { rx: /\bright tackle\b|\brt\b/i, want: { slots: ['OT', 'OL'], labels: ['RT'] } },
    { rx: /\b(defensive tackle|nose tackle|dt)\b/i, want: { slots: ['DT', 'DL'] } },
    { rx: /\b(offensive )?tackle\b/i, want: { slots: ['OT', 'OL'] } },
    { rx: /\b(guard|center|centre|interior line\w*)\b/i, want: { slots: ['IOL', 'OL'] } },
    { rx: /\b(offensive line\w*|o[- ]?line\w*|lineman|linemen)\b/i, want: { units: ['OFFENSIVE_LINE'] } },
    { rx: /\b(edge|pass rusher|defensive end|de)\b/i, want: { slots: ['EDGE', 'DL', 'OLB'] } },
    { rx: /\b(defensive line\w*|d[- ]?line\w*)\b/i, want: { units: ['DEFENSIVE_FRONT'] } },
    { rx: /\b(corner|cornerback|cb)s?\b/i, want: { slots: ['CB1', 'CB', 'DB'] } },
    { rx: /\b(safety|safeties)\b/i, want: { slots: ['S', 'DB'] } },
    { rx: /\b(secondary|defensive backs?|db)\b/i, want: { units: ['SECONDARY'] } },
    { rx: /\b(linebackers?|lb)\b/i, want: { slots: ['LB', 'OLB'] } },
    { rx: /\b(receivers?|wideouts?|wr)\b/i, want: { slots: ['WR1', 'WR'] } },
    { rx: /\b(tight ends?|te)\b/i, want: { slots: ['TE'] } },
    { rx: /\b(running backs?|tailbacks?|rb)\b/i, want: { slots: ['RB'] } },
    { rx: /\bkicker\b/i, want: { slots: ['K'] } },
    { rx: /\bpunter\b/i, want: { slots: ['P'] } }
  ];

  function allOf(game) {
    var out = [];
    ['home', 'away'].forEach(function (side) {
      var t = game && game[side];
      if (!t) return;
      (t.absences || []).concat(t.unrated || []).forEach(function (a) { out.push({ side: side, team: t, a: a }); });
    });
    return out;
  }
  function byExpected(x, y) {
    var ex = num(x.a.expected_impact) ? x.a.expected_impact : -1, ey = num(y.a.expected_impact) ? y.a.expected_impact : -1;
    var ix = num(x.a.impact_if_absent) ? x.a.impact_if_absent : -1, iy = num(y.a.impact_if_absent) ? y.a.impact_if_absent : -1;
    return ey - ex || iy - ix || String(x.a.player_name).localeCompare(String(y.a.player_name));
  }

  /* the side the question names, if exactly one */
  /* A full name beats a shared word: "Texas State" names Texas State, not
     North Texas. A nickname or id counts only when no full name is present. */
  function sideNamed(q, game) {
    var s = ' ' + nk(q) + ' ', full = [], loose = [];
    ['home', 'away'].forEach(function (side) {
      var t = game && game[side];
      if (!t || !t.team_name) return;
      var n = nk(t.team_name), last = n.split(' ').slice(-1)[0];
      if (s.indexOf(' ' + n + ' ') >= 0) full.push(side);
      else if ((last.length >= 4 && s.indexOf(' ' + last + ' ') >= 0)
        || (t.team_id && s.indexOf(' ' + nk(t.team_id) + ' ') >= 0)) loose.push(side);
    });
    if (full.length) return full.length === 1 ? full[0] : null;
    return loose.length === 1 ? loose[0] : null;
  }

  function target(q, game) {
    var list = allOf(game);
    var side = sideNamed(q, game);
    if (side) list = list.filter(function (x) { return x.side === side; });
    if (!list.length) return null;
    var s = ' ' + nk(q) + ' ';
    /* a named player: full name, or a surname of four letters or more */
    var named = list.filter(function (x) {
      var n = nk(x.a.player_name);
      if (!n) return false;
      if (s.indexOf(' ' + n + ' ') >= 0) return true;
      var last = n.split(' ').filter(function (w) { return !/^(jr|sr|ii|iii|iv)$/.test(w); }).slice(-1)[0] || '';
      return last.length >= 4 && s.indexOf(' ' + last + ' ') >= 0;
    });
    if (named.length) return named.sort(byExpected)[0];
    for (var i = 0; i < PHRASES.length; i++) {
      if (!PHRASES[i].rx.test(q)) continue;
      var w = PHRASES[i].want;
      var hit = list.filter(function (x) {
        if (w.units) return w.units.indexOf(x.a.unit) >= 0;
        if (w.labels && w.labels.some(function (l) { return String(x.a.label || '').indexOf(l) === 0; })) return true;
        return w.slots.indexOf(x.a.slot) >= 0;
      });
      if (hit.length) return hit.sort(byExpected)[0];
    }
    return list.slice().sort(byExpected)[0];
  }

  /* ---------------------------------------------------------- the game */
  function resolveGame(artifact, o) {
    o = o || {};
    var games = (artifact && artifact.games) || {};
    if (o.game_id != null && games[String(o.game_id)]) return games[String(o.game_id)];
    var s = ' ' + nk(o.question) + ' ';
    var ids = Object.keys(games).filter(function (id) {
      var g = games[id];
      return [g.home, g.away].some(function (t) {
        if (!t || !t.team_name) return false;
        var n = nk(t.team_name);
        return s.indexOf(' ' + n + ' ') >= 0 || (o.home && nk(o.home) === n) || (o.away && nk(o.away) === n);
      });
    });
    if (!ids.length) return null;
    var now = num(o.now) ? o.now : null;
    ids.sort(function (a, b) {
      var ka = Date.parse(games[a].kickoff || '') || 0, kb = Date.parse(games[b].kickoff || '') || 0;
      if (now != null) {
        var fa = ka >= now - 4 * 3600e3, fb = kb >= now - 4 * 3600e3;
        if (fa !== fb) return fa ? -1 : 1;
      }
      return ka - kb || (a < b ? -1 : 1);
    });
    /* two different fixtures named: ambiguous, answer nothing */
    var both = ids.filter(function (id) {
      var g = games[id];
      return [g.home, g.away].every(function (t) { return t && t.team_name && s.indexOf(' ' + nk(t.team_name) + ' ') >= 0; });
    });
    return games[(both[0] || ids[0])];
  }

  /* ---------------------------------------------------------- phrasing */
  function who(x) { return x.a.label + ' ' + (x.a.player_name || '') + ' (' + (x.team.team_name || x.side) + ')'; }
  function statusPhrase(a) {
    var s = String(a.status_label || a.injury_status || 'unknown').toLowerCase();
    return num(a.probability_of_absence) && a.probability_of_absence < 1
      ? s + ', ' + pct(a.probability_of_absence) + ' likely to miss'
      : s;
  }
  function driverPhrase(a, oppName) {
    var parts = [], damp = [];
    if (a.gap_basis === 'MEASURED_REPLACEMENT') {
      parts.push('the drop from his ' + a.player_quality + ' rating to ' + poss(a.replacement_player_name || 'the replacement') + ' '
        + a.replacement_quality);
    } else if (a.gap_basis === 'SCALE_REPLACEMENT_LEVEL') {
      parts.push('the drop from his ' + a.player_quality + ' rating to a replacement-level backup'
        + (a.replacement_player_name ? ' (' + a.replacement_player_name + ' is unmeasured)' : ' (no replacement identified)'));
    }
    /* the lean artifact carries the top driver; the full record carries them all */
    var md = a.matchup_driver || (a.matchup_drivers && a.matchup_drivers[0]) || null;
    var z = md && num(md.z) ? Math.round(md.z * 10) / 10 : null;
    var what = (oppName ? poss(oppName) + ' ' : 'the opponent\u2019s ') + (md && md.label ? md.label : 'measured unit')
      + (z != null ? ' (' + (z > 0 ? '+' : '') + z + ' SD, matchup x' + a.matchup_leverage + ')' : ' (matchup x' + a.matchup_leverage + ')');
    if (num(a.matchup_leverage) && a.matchup_leverage >= 1.05) parts.push(what);
    if (num(a.matchup_leverage) && a.matchup_leverage <= 0.95) damp.push(what + ' lowers it');
    if (num(a.unit_concentration_multiplier) && a.unit_concentration_multiplier > 1.001) parts.push('other absences in the ' + String(a.unit_label || 'unit').toLowerCase());
    if (num(a.usage_factor) && a.usage_factor < 0.5) damp.push('a limited role (' + pct(a.usage_factor) + ' usage) holds it down');
    return { up: parts, down: damp };
  }
  function missingPhrase(a) {
    var m = { player_quality: 'no measured player quality', usage: 'no usage evidence', position: 'an unresolved position',
      replacement_quality: 'no replacement bound', rating_scale: 'no rating scale' };
    return (a.missing || []).filter(function (k) { return m[k]; }).map(function (k) { return m[k]; }).join(' and ') || 'insufficient evidence';
  }
  function oppOf(game, side) { var o = game[side === 'home' ? 'away' : 'home']; return o ? o.team_name : null; }
  function teamLine(t) {
    if (!t) return null;
    if (t.status === 'NOT_ASSESSABLE') return (t.team_name || 'One side') + ' is not assessable: no graded availability read reached EdgeDesk for this game, and unknown is not healthy.';
    if (t.status === 'UNRATED_ABSENCES') return (t.team_name || 'One side') + ' has ' + (t.unrated || []).length + ' non-quarterback absence(s) on file that EdgeDesk cannot rate yet (no measured player quality).';
    if (!num(t.impact)) return (t.team_name || 'One side') + ': the rated absences carry no designation, so no expected impact is stated.';
    return (t.team_name || 'One side') + ': ' + t.impact + '/100 (' + t.classification + '), confidence ' + t.confidence + '%.';
  }

  function impactAnswer(q, game) {
    var x = target(q, game);
    if (!x) {
      var lines = [teamLine(game.home), teamLine(game.away)].filter(Boolean);
      return { intent: 'IMPACT', text: 'EdgeDesk has no non-quarterback absence on file for this game. ' + lines.join(' ') + ' ' + NO_ADJUSTMENT, focus: null };
    }
    var a = x.a, opp = oppOf(game, x.side);
    if (!a.rated) {
      return { intent: 'IMPACT', focus: a,
        text: 'EdgeDesk cannot rate the ' + who(x) + ' absence yet (' + statusPhrase(a) + '): ' + missingPhrase(a) + '. '
          + (a.replacement_player_name ? 'The likely replacement is ' + a.replacement_player_name + '. ' : '')
          + 'A missing input is left blank rather than filled, so there is no impact score to quote. ' + NO_ADJUSTMENT };
    }
    var d = driverPhrase(a, opp);
    return { intent: 'IMPACT', focus: a,
      text: 'The ' + who(x) + ' absence grades as ' + a.classification + ' impact (' + a.impact_if_absent + '/100)'
        + (d.up.length ? ' primarily because of ' + d.up.join(' and ') : '') + '. '
        + (d.down.length ? d.down.join('; ').replace(/^./, function (c) { return c.toUpperCase(); }) + '. ' : '')
        + 'He is ' + statusPhrase(a) + (num(a.expected_impact) && a.expected_impact !== a.impact_if_absent ? ', so the probability-weighted impact is ' + a.expected_impact + '/100' : '') + '. '
        + 'The injury system scores it ' + a.impact_if_absent + '/100 with ' + a.confidence + '% confidence. ' + NO_ADJUSTMENT };
  }

  function compareAnswer(game) {
    var c = game.comparison || {};
    var s = (c.statement || 'EdgeDesk cannot compare the two sides.') + ' ' + [teamLine(game.away), teamLine(game.home)].filter(Boolean).join(' ');
    var losses = [];
    ['away', 'home'].forEach(function (side) {
      var t = game[side];
      if (t && t.key_losses && t.key_losses.length) losses.push(t.team_name + ' key losses: ' + t.key_losses.map(function (k) { return k.label + ' ' + k.classification; }).join(', ') + '.');
    });
    return { intent: 'COMPARE', text: s + (losses.length ? ' ' + losses.join(' ') : '') + ' The difference is a measurement, not points. ' + NO_ADJUSTMENT, focus: null };
  }

  function replacementAnswer(q, game) {
    var x = target(q, game);
    if (!x) return { intent: 'REPLACEMENT', text: 'EdgeDesk has no non-quarterback absence on file for this game, so there is no replacement to name. ' + NO_ADJUSTMENT, focus: null };
    var a = x.a;
    if (!a.replacement_player_name) {
      return { intent: 'REPLACEMENT', focus: a,
        text: 'EdgeDesk could not identify a likely replacement for ' + who(x) + ': no depth order for his position group is on file. '
          + 'Confidence is lowered instead of inventing one' + (a.rated ? ' (the absence scores ' + a.impact_if_absent + '/100 at ' + a.confidence + '% confidence).' : '.') + ' ' + NO_ADJUSTMENT };
    }
    var q2 = a.replacement_quality == null ? 'whose own quality is not measured' : 'rated ' + a.replacement_quality + ' against his ' + a.player_quality;
    return { intent: 'REPLACEMENT', focus: a,
      text: 'The likely replacement for ' + who(x) + ' is ' + a.replacement_player_name + ', ' + q2
        + (num(a.replacement_confidence) ? ' (identification confidence ' + pct(a.replacement_confidence) + ', from EdgeDesk’s participation order, not an official depth chart)' : '') + '. '
        + (a.rated ? 'With him playing, the absence grades ' + a.classification + ' (' + a.impact_if_absent + '/100).' : 'The absence itself is not rated: ' + missingPhrase(a) + '.')
        + ' ' + NO_ADJUSTMENT };
  }

  /* "What are the injuries?" — each side's absences, largest first, with
     the class each one grades at; unrated ones say they are unrated. */
  function summaryAnswer(q, game) {
    var side = sideNamed(q, game);
    var out = [];
    (side ? [side] : ['away', 'home']).forEach(function (sd) {
      var t = game[sd];
      if (!t) return;
      var list = allOf(game).filter(function (x) { return x.side === sd; }).sort(byExpected);
      if (t.status === 'NOT_ASSESSABLE' || !list.length) { out.push(teamLine(t)); return; }
      var shown = list.slice(0, 5).map(function (x) {
        var a = x.a;
        return a.label + ' ' + (a.player_name || '') + ' (' + String(a.status_label || a.injury_status || '').toLowerCase() + ', '
          + (a.rated ? a.classification + ' ' + a.impact_if_absent + '/100' : 'unrated') + ')';
      });
      out.push(teamLine(t) + ' Absences: ' + shown.join('; ') + (list.length > 5 ? '; and ' + (list.length - 5) + ' more' : '') + '.');
    });
    return { intent: 'SUMMARY', text: out.join(' ') + ' Quarterbacks are covered by the starter read, not here. ' + NO_ADJUSTMENT, focus: null };
  }

  var DEFENSE_UNITS = ['DEFENSIVE_FRONT', 'LINEBACKERS', 'SECONDARY'];
  var OFFENSE_UNITS = ['OFFENSIVE_LINE', 'RECEIVING', 'BACKFIELD'];
  function unitAnswer(q, game) {
    var side = sideNamed(q, game);
    var filter = /\bdefen[cs]e\b/i.test(q) ? DEFENSE_UNITS : /\boffen[cs]e\b/i.test(q) ? OFFENSE_UNITS : null;
    var sides = side ? [side] : ['away', 'home'];
    var out = [];
    sides.forEach(function (sd) {
      var t = game[sd];
      if (!t) return;
      if (t.status === 'NOT_ASSESSABLE') { out.push(teamLine(t)); return; }
      var units = (t.units || []).filter(function (u) { return !filter || filter.indexOf(u.unit) >= 0; });
      if (!units.length) { out.push((t.team_name || 'One side') + ' has no ' + (filter === DEFENSE_UNITS ? 'defensive ' : filter === OFFENSE_UNITS ? 'offensive ' : '') + 'absence on file.'); return; }
      var top = units[0];
      var meaningful = units.some(function (u) { return u.concern !== 'LOW'; });
      out.push((t.team_name || 'One side') + ': ' + (meaningful ? 'yes — ' : 'no meaningful concentration — ')
        + units.map(function (u) {
          return u.label + ' ' + u.absences + ' absence' + (u.absences === 1 ? '' : 's')
            + ' (' + u.expected_count + ' expected' + (num(u.impact) ? ', ' + u.impact + '/100' : ', unrated') + ', ' + String(u.concern_label || '').toLowerCase() + ')';
        }).join('; ') + '.' + (meaningful ? ' The concentration is in the ' + String(top.label).toLowerCase() + '.' : ''));
    });
    return { intent: 'UNIT', text: out.join(' ') + ' ' + NO_ADJUSTMENT, focus: null };
  }

  /* One answer, or null when the question is not a personnel question. */
  function answer(q, game, opts) {
    opts = opts || {};
    var intent = opts.intent || classify(q);
    if (!intent || !game || !game.home || !game.away) return null;
    var out = intent === 'COMPARE' ? compareAnswer(game)
      : intent === 'REPLACEMENT' ? replacementAnswer(q, game)
      : intent === 'UNIT' ? unitAnswer(q, game)
      : intent === 'SUMMARY' ? summaryAnswer(q, game)
      : impactAnswer(q, game);
    out.schema = SCHEMA; out.version = VERSION;
    out.game_id = game.game_id == null ? null : String(game.game_id);
    out.projection_adjustment = 0;
    return out;
  }

  /* ------------------------------------------------- the packet block */
  function slim(a) {
    return { label: a.label, player: a.player_name, status: a.injury_status, probability_of_absence: a.probability_of_absence,
      impact_if_absent: a.impact_if_absent, classification: a.classification, expected_impact: a.expected_impact,
      confidence: a.confidence, player_quality: a.player_quality, replacement: a.replacement_player_name,
      replacement_quality: a.replacement_quality, replacement_gap: a.replacement_gap, usage_factor: a.usage_factor,
      position_leverage: a.position_leverage, matchup_leverage: a.matchup_leverage,
      unit_concentration_multiplier: a.unit_concentration_multiplier, matchup_driver: a.matchup_driver || null,
      drivers: a.drivers_text, missing: a.missing || [] };
  }
  function teamBlock(t) {
    if (!t) return null;
    return { team: t.team_name, status: t.status, impact: t.impact, classification: t.classification, confidence: t.confidence,
      unit_concern: t.unit_concern ? t.unit_concern.label + ' (' + String(t.unit_concern.concern_label || '').toLowerCase() + ')' : null,
      key_losses: (t.key_losses || []).map(function (k) { return k.label + ' ' + k.player_name + ' ' + k.classification + ' ' + k.impact_if_absent + '/100'; }),
      absences: (t.absences || []).slice(0, 8).map(slim),
      unrated: (t.unrated || []).slice(0, 8).map(function (a) { return { label: a.label, player: a.player_name, status: a.injury_status, replacement: a.replacement_player_name, missing: a.missing || [] }; }),
      note: t.status_note || null };
  }
  function block(game, opts) {
    opts = opts || {};
    if (!game) return null;
    var out = {
      schema: SCHEMA, version: VERSION, game_id: game.game_id == null ? null : String(game.game_id),
      source: 'football/personnel/current.json', generated_at: opts.generated_at || null,
      measurement_only: true, projection_adjustment: 0,
      projection_effect: 'not enabled — the injury impact score is 0-100, not points; the coefficient that would convert it is untrained',
      rules: ['Quote the 0-100 impact and its confidence; never convert it into spread points.',
        'Say the projection adjustment is 0.0 because the injury coefficient has not been trained.',
        'Unrated absences have no score: say what is missing, never call them minor.',
        'The quarterback is covered by the starter layer, not by this block.'],
      home: teamBlock(game.home), away: teamBlock(game.away),
      comparison: game.comparison ? { statement: game.comparison.statement, difference: game.comparison.difference,
        more_affected: game.comparison.more_affected, material: game.comparison.material } : null
    };
    if (opts.question) {
      var ans = answer(opts.question, game);
      if (ans) { out.question_intent = ans.intent; out.answer = ans.text; }
    }
    return out;
  }

  /* ------------------------------------------------------- the critic */
  var RX_POINTS = /\b(injur\w*|absence|absent|missing|personnel|without|out)\b[^.]{0,90}?\b(worth|costs?|moves?|moved|adjust\w*|subtract\w*|knocks?|shifts?|drops?)\b[^.]{0,40}?\b(\d+(?:\.\d+)?)\s*(?:points?|pts)\b/i;
  var RX_POINTS2 = /\b(\d+(?:\.\d+)?)[- ]points?\b[^.]{0,40}\b(for|of) (the )?(injur\w*|absence|personnel)/i;
  var RX_APPLIED = /\b(adjusted|lowered|raised|moved)\b[^.]{0,40}\b(line|spread|projection|number)\b[^.]{0,40}\b(for|because of) (the )?(injur\w*|absence|personnel)/i;
  /* Sentence by sentence, and never about the quarterback: his absence IS
     priced, by the trained QB layer, and saying so is correct. */
  function criticExtras(o) {
    o = o || {};
    var out = [], seen = {};
    String(o.answer || '').split(/(?<=[.!?])\s+|\n+/).forEach(function (sent) {
      if (!sent || RX_QB.test(sent)) return;
      var m = sent.match(RX_POINTS), m2 = m ? null : sent.match(RX_POINTS2);
      var n = m ? parseFloat(m[3]) : (m2 ? parseFloat(m2[1]) : null);
      if (num(n) && n !== 0 && !seen.points) {
        seen.points = true;
        out.push({ code: 'INJURY_POINTS_CLAIM', severity: 'FAIL',
          detail: 'the prose converts a non-QB absence into ' + n + ' point(s); the injury coefficient is untrained and the projection adjustment is 0' });
      }
      if (RX_APPLIED.test(sent) && !seen.applied) {
        seen.applied = true;
        out.push({ code: 'INJURY_ADJUSTMENT_CLAIM', severity: 'FAIL',
          detail: 'the prose says a projection was adjusted for an injury; no personnel adjustment is applied' });
      }
    });
    return out;
  }

  return { VERSION: VERSION, SCHEMA: SCHEMA, NO_ADJUSTMENT: NO_ADJUSTMENT,
    classify: classify, resolveGame: resolveGame, target: target, answer: answer, block: block, criticExtras: criticExtras };
});
/*__EDPERSONNEL_END__*/
