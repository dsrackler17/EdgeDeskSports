/* ===========================================================================
   EDGEDESK FOOTBALL — RESEARCH IQ (read_v1)

   A good decision can lose. A bad decision can win. Everything else in this
   game already tells you what happened; this file is the only thing that
   tells you whether you were RIGHT TO TRY IT, and it is judged entirely on
   what you could see before the snap.

   THE SHAPE OF IT. Before every call, the page freezes a DECISION CONTEXT:
   the down, the distance, the clock, the score, the field, the call, the
   look the defence is showing, the men you have and the concepts you have
   been leaning on. That object is immutable and the outcome is stored
   somewhere else entirely. `grade()` never sees a result, and cannot: it is
   a pure function of the context, and the test proves the same context
   scores the same whether the play gained forty or lost four.

   THE FIVE THINGS IT ASKS

     MATCHUP FIT        0-30  did the concept attack an actual weakness?
     SITUATIONAL FIT    0-25  did it make sense for this down and this clock?
     PERSONNEL FIT      0-20  did it fit the men you actually have?
     RISK FIT           0-15  was the risk the right size for the moment?
     READ INDEPENDENCE  0-10  was it a decision, or the same call again?

   WHAT IT PAYS. Research IQ comes off the process score and nothing else.
   A call graded in the nineties that lost four yards is still a good read
   and is still paid like one; a call graded in the thirties that broke for
   eighteen is paid almost nothing, and says so kindly. The point is to
   teach, so a bad read is never punished below zero.

   NOTHING HERE DECIDES A PLAY. It grades a decision after the fact and
   before the result; it never changes what the football does.
   =========================================================================== */
(function (root) {
  'use strict';

  var VERSION = 'read_v1';
  var WEIGHTS = { matchup: 30, situational: 25, personnel: 20, risk: 15, independence: 10 };

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : (d || 0); }

  /* ── THE DECISION CONTEXT ────────────────────────────────────────────────
     Everything the caller could see, and nothing the caller could not. Built
     once, frozen, and kept apart from whatever the play then did. */
  function context(o) {
    o = o || {};
    var sit = o.sit || {}, ps = o.preSnap || {}, play = o.play || {};
    var ctx = {
      version: VERSION,
      at: o.at == null ? null : o.at,
      /* the situation */
      down: num(sit.down, 1), toGo: num(sit.toGo, 10), ball: num(sit.ball, 25),
      quarter: num(sit.quarter, 1), clock: num(sit.clock, 900),
      scoreFor: num(o.scoreFor, 0), scoreAgainst: num(o.scoreAgainst, 0),
      /* the call */
      play: o.playKey || play.key || '', concept: play.concept || '', type: play.type || 'run',
      formation: o.formation || '', depth: num(play.depth, 0),
      /* the look, as the page printed it above the field */
      box: num(ps.box, 7), blitzing: !!ps.blitzing, shell: ps.shell || '',
      coverage: (ps.parts && ps.parts.coverage && ps.parts.coverage.key) || '',
      safeties: num(ps.safeties, 2), light: !!ps.light, heavy: !!ps.heavy,
      /* the men, as a summary the page hands in */
      personnel: o.personnel || null,
      /* what has already been called, most recent first */
      recent: (o.recent || []).slice(0, 8),
      suggested: (o.suggested || []).slice(0, 6)
    };
    ctx.toGoal = clamp(100 - ctx.ball, 0, 100);
    return ctx;
  }

  /* ── 1. MATCHUP FIT ──────────────────────────────────────────────────────
     Did the call go at what the defence was actually giving up? A light box
     is a run's invitation; a heavy one is a throw's. Pressure is beaten by
     getting rid of it or by making them wrong for leaving. Two deep safeties
     say the middle and the run are open; none say the deep shot is. */
  function matchupFit(c) {
    var s = 15, why = [];
    var run = c.type === 'run', pass = c.type === 'pass';
    var quick = c.concept === 'quick' || c.concept === 'screen' || c.concept === 'flat';
    var deep = c.concept === 'shot' || c.concept === 'vert' || c.depth >= 14;
    var inter = c.concept === 'inter' || (c.depth >= 8 && c.depth < 14);

    if (run) {
      if (c.light) { s += 11; why.push('a light box'); }
      else if (c.heavy) { s -= 10; why.push('a heavy box'); }
      if (c.safeties >= 2 && !c.heavy) { s += 4; why.push('two deep and light in front'); }
      if (c.blitzing && (c.concept === 'draw' || c.concept === 'outside' || c.concept === 'option')) {
        s += 6; why.push('pressure run away from');
      } else if (c.blitzing) { s -= 3; }
      if (c.coverage === 'cover0' || c.coverage === 'cover1') { s += 3; why.push('nobody left over the run'); }
    }
    if (pass) {
      if (c.heavy) { s += 10; why.push('a heavy box'); }
      else if (c.light) { s -= 7; why.push('a light box'); }
      if (c.blitzing) {
        if (quick) { s += 11; why.push('pressure beaten by getting it out'); }
        else if (deep) { s -= 6; why.push('a deep drop into pressure'); }
      }
      if (deep && c.safeties <= 1) { s += 9; why.push('one high, or none'); }
      else if (deep && c.safeties >= 4) { s -= 8; why.push('quarters over the top'); }
      if (inter && (c.coverage === 'cover3' || c.coverage === 'cover4')) { s += 6; why.push('the soft area in the zone'); }
      if (quick && c.coverage === 'cover2' && !c.blitzing) { s -= 3; }
    }
    return { score: clamp(Math.round(s), 0, WEIGHTS.matchup), why: why };
  }

  /* ── 2. SITUATIONAL FIT ──────────────────────────────────────────────────
     The down and the distance first; then the clock and the score, which on
     the last drive of a half matter more than anything the defence shows. */
  function situationalFit(c) {
    var s = 13, why = [];
    var run = c.type === 'run', pass = c.type === 'pass';
    var short = c.toGo <= 2, medium = c.toGo > 2 && c.toGo <= 6, long = c.toGo > 6;
    var late = c.quarter >= 4 && c.clock <= 180;
    var down = c.down;

    if (down <= 2) {
      s += 6; /* first and second are for staying on schedule */
      if (down === 2 && long && run && c.concept !== 'draw') { s -= 4; why.push('second and long on the ground'); }
    }
    if (down === 3 || down === 4) {
      if (short && run) { s += 8; why.push('short yardage on the ground'); }
      else if (short && pass && c.depth > 8) { s -= 6; why.push('a deep drop on third and short'); }
      else if (long && pass && c.depth >= c.toGo - 2) { s += 8; why.push('a throw that reaches the sticks'); }
      else if (long && pass && c.depth < c.toGo - 4) { s -= 5; why.push('a throw short of the sticks'); }
      else if (long && run && c.concept !== 'draw') { s -= 8; why.push('a run on third and long'); }
      else if (medium) { s += 4; }
    }
    /* the clock */
    if (late) {
      var behind = c.scoreFor < c.scoreAgainst;
      if (behind && run && c.concept !== 'draw') { s -= 7; why.push('running while behind, late'); }
      if (behind && pass) { s += 5; why.push('the clock says throw'); }
      if (!behind && run) { s += 5; why.push('ahead, with the clock running'); }
    }
    /* the field */
    if (c.toGoal <= 5 && pass && c.depth > c.toGoal + 3) { s -= 5; why.push('a throw past the back of the end zone'); }
    if (c.toGoal <= 3 && run) { s += 4; why.push('inside the three'); }
    if (c.ball <= 5 && pass && c.depth < 0) { s -= 4; why.push('a throw behind the goal line'); }
    return { score: clamp(Math.round(s), 0, WEIGHTS.situational), why: why };
  }

  /* ── 3. PERSONNEL FIT ────────────────────────────────────────────────────
     Did the call use the men who are actually good? A power back behind a
     road-grading line is a different football team from a receiving back
     behind pass protectors, and the call should know which one it is. */
  var RUN_ARCH = { 'Power Back': 1, 'Workhorse': 1, 'Elusive Back': 1 };
  var PASS_ARCH = { 'Gunslinger': 1, 'Field General': 1, 'Improviser': 1 };
  function personnelFit(c) {
    var p = c.personnel;
    if (!p) return { score: Math.round(WEIGHTS.personnel * 0.5), why: [] };
    var s = 10, why = [];
    var run = c.type === 'run', pass = c.type === 'pass';
    var rb = p.rb || {}, qb = p.qb || {}, ol = num(p.ol, 70), wr = p.wr || {};
    if (run) {
      if (num(rb.overall) >= num(qb.overall) + 4) { s += 5; why.push('your back is the better man'); }
      if (ol >= 75) { s += 4; why.push('a line that can move people'); }
      else if (ol <= 66) { s -= 5; why.push('a line that cannot'); }
      if (RUN_ARCH[rb.archetype]) { s += 3; why.push(rb.archetype); }
      if (c.concept === 'outside' && num(rb.speed) >= 85) { s += 3; why.push('the speed to get outside'); }
      if (c.concept === 'inside' && num(rb.power) >= 82) { s += 3; why.push('the power inside'); }
    }
    if (pass) {
      if (num(qb.overall) >= num(rb.overall) + 4) { s += 5; why.push('your quarterback is the better man'); }
      if (PASS_ARCH[qb.archetype]) { s += 3; why.push(qb.archetype); }
      if (num(wr.best) >= 82) { s += 4; why.push('a receiver worth throwing to'); }
      else if (num(wr.best) <= 68 && num(wr.best) > 0) { s -= 4; why.push('nobody to throw to'); }
      if (c.depth >= 14 && num(qb.arm) >= 85) { s += 3; why.push('the arm for it'); }
      else if (c.depth >= 14 && num(qb.arm) > 0 && num(qb.arm) <= 72) { s -= 4; why.push('not the arm for it'); }
      if (c.blitzing && ol <= 68) { s -= 3; why.push('a line that will not hold'); }
    }
    return { score: clamp(Math.round(s), 0, WEIGHTS.personnel), why: why };
  }

  /* ── 4. RISK FIT ─────────────────────────────────────────────────────────
     Risk is not bad. Risk in the wrong place is. A deep shot from your own
     eight while ahead in the fourth is a different decision from the same
     call on their forty-five in the first. */
  function riskFit(c) {
    var s = 11, why = [];
    var deep = c.depth >= 14, ownEnd = c.ball <= 12, lead = c.scoreFor - c.scoreAgainst;
    var late = c.quarter >= 4 && c.clock <= 300;
    if (deep && ownEnd) { s -= 6; why.push('a deep drop from your own end'); }
    if (deep && c.blitzing && ownEnd) { s -= 3; }
    if (late && lead > 0 && lead <= 8 && c.type === 'pass' && c.depth >= 10) { s -= 4; why.push('risk with a lead to protect'); }
    if (late && lead < 0 && c.type === 'pass' && deep) { s += 4; why.push('the risk the scoreboard is asking for'); }
    if (c.down === 4 && c.type === 'run' && c.toGo >= 5) { s -= 4; why.push('fourth and long on the ground'); }
    if (c.down <= 2 && c.toGo <= 3 && !deep) { s += 3; why.push('low risk when you do not need much'); }
    if (c.toGoal <= 10 && !deep) { s += 2; }
    return { score: clamp(Math.round(s), 0, WEIGHTS.risk), why: why };
  }

  /* ── 5. READ INDEPENDENCE ────────────────────────────────────────────────
     A player who calls the same concept every snap is not reading anything,
     however good that concept is. This is the only part that looks at what
     came before, and it looks only at the calls, never at how they went. */
  function independence(c) {
    var r = c.recent || [];
    if (!r.length) return { score: WEIGHTS.independence, why: [] };
    var same = 0, i;
    for (i = 0; i < r.length; i++) { if (r[i] === c.concept) same++; else break; }
    var distinct = {}, n = 0;
    for (i = 0; i < r.length; i++) if (!distinct[r[i]]) { distinct[r[i]] = 1; n++; }
    var s = WEIGHTS.independence;
    if (same >= 4) s -= 8; else if (same === 3) s -= 5; else if (same === 2) s -= 2;
    if (r.length >= 4 && n <= 2) s -= 3;
    if (r.length >= 4 && n >= 4) s += 0;
    var why = [];
    if (same >= 3) why.push('the same concept ' + (same + 1) + ' times running');
    return { score: clamp(Math.round(s), 0, WEIGHTS.independence), why: why };
  }

  /* ── THE GRADE ───────────────────────────────────────────────────────────
     Pure. A context in, a number and a sentence out. No outcome is read,
     because none is passed. */
  var BANDS = [
    { at: 82, key: 'good', label: 'GOOD READ' },
    { at: 66, key: 'sound', label: 'SOUND' },
    { at: 48, key: 'thin', label: 'THIN' },
    { at: 0, key: 'poor', label: 'FORCED' }
  ];
  function grade(c) {
    if (!c) return null;
    var m = matchupFit(c), s = situationalFit(c), p = personnelFit(c), r = riskFit(c), i = independence(c);
    var total = m.score + s.score + p.score + r.score + i.score;
    var band = BANDS[BANDS.length - 1], k;
    for (k = 0; k < BANDS.length; k++) if (total >= BANDS[k].at) { band = BANDS[k]; break; }
    var why = m.why.concat(s.why, p.why, r.why, i.why);
    return {
      version: VERSION,
      matchup: m.score, situational: s.score, personnel: p.score, risk: r.score, independence: i.score,
      total: total, band: band.key, label: band.label,
      why: why, note: noteFor(c, band.key, m, s, p, r, i),
      iq: iqFor(total)
    };
  }
  /* WHAT IT PAYS. Off the process and nothing else, on a curve that keeps a
     poor read worth almost nothing without ever taking anything away. */
  function iqFor(total) { return Math.max(0, Math.round((total - 25) / 3.8)); }

  function noteFor(c, band, m, s, p, r, i) {
    var lead = null;
    if (band === 'good' || band === 'sound') {
      lead = m.why[0] || s.why[0] || p.why[0];
      return lead ? 'You went at ' + lead + '.' : 'A sound call for the down and the look.';
    }
    /* what cost it the most, said once */
    var worst = [[WEIGHTS.matchup - m.score, m.why[0]], [WEIGHTS.situational - s.score, s.why[0]],
                 [WEIGHTS.personnel - p.score, p.why[0]], [WEIGHTS.risk - r.score, r.why[0]],
                 [WEIGHTS.independence - i.score, i.why[0]]]
      .filter(function (x) { return x[1]; }).sort(function (a, b) { return b[0] - a[0]; })[0];
    return worst ? 'The look was showing ' + worst[1] + '.' : 'The look was not asking for that one.';
  }

  /* ── THE RESULT, KEPT SEPARATE ───────────────────────────────────────────
     Scored on its own so the report can put the two side by side. Nothing
     here feeds the grade above; it exists to be COMPARED with it. */
  function resultScore(outcome, c) {
    if (!outcome) return null;
    var y = num(outcome.yards, 0), s = 50;
    var need = c ? c.toGo : 10;
    if (outcome.touchdown) s = 100;
    else if (outcome.turnover) s = 0;
    else if (outcome.sack) s = 18;
    else if (y >= need) s = 82;
    else if (y >= need * 0.6) s = 66;
    else if (y > 0) s = 48;
    else if (y === 0) s = 34;
    else s = 22;
    if (!outcome.turnover && !outcome.touchdown) s = clamp(s + Math.round(clamp(y, -10, 30) * 0.4), 0, 100);
    return clamp(Math.round(s), 0, 100);
  }

  /* WHAT TO SAY when the process and the result disagree. This is the whole
     point of the file, so it is said plainly and without scolding. */
  function verdict(g, res) {
    if (!g) return null;
    var good = g.total >= 66, worked = res != null && res >= 66;
    if (good && worked) return { key: 'both', head: g.label, line: 'Right call, and it worked.' };
    if (good && !worked) return { key: 'process', head: 'GOOD READ', line: 'The result was poor, but the process was sound.' };
    if (!good && worked) return { key: 'result', head: 'RESULT WORKED. PROCESS DIDN\'T.', line: 'It came off, but the look and the situation made it a low-quality decision.' };
    return { key: 'neither', head: g.label, line: g.note };
  }

  /* ── THE REPORT ──────────────────────────────────────────────────────────
     Every graded decision of a game, summed the way a coach would read it:
     what the process was worth, what the results were worth, the best read
     and the worst, and how the two halves of the job went. */
  function report(entries) {
    var list = (entries || []).filter(function (e) { return e && e.grade; });
    if (!list.length) return null;
    function avg(f) { var t = 0, n = 0; list.forEach(function (e) { var v = f(e); if (v != null) { t += v; n++; } }); return n ? Math.round(t / n) : null; }
    var best = list.slice().sort(function (a, b) { return b.grade.total - a.grade.total; })[0];
    var worst = list.slice().sort(function (a, b) { return a.grade.total - b.grade.total; })[0];
    var process = avg(function (e) { return e.grade.total; });
    var result = avg(function (e) { return e.result; });
    return {
      version: VERSION,
      calls: list.length,
      process: process, result: result,
      matchup: Math.round(100 * avg(function (e) { return e.grade.matchup; }) / WEIGHTS.matchup),
      situational: Math.round(100 * avg(function (e) { return e.grade.situational; }) / WEIGHTS.situational),
      personnel: Math.round(100 * avg(function (e) { return e.grade.personnel; }) / WEIGHTS.personnel),
      risk: Math.round(100 * avg(function (e) { return e.grade.risk; }) / WEIGHTS.risk),
      independence: Math.round(100 * avg(function (e) { return e.grade.independence; }) / WEIGHTS.independence),
      iq: list.reduce(function (t, e) { return t + (e.grade.iq | 0); }, 0),
      good_reads: list.filter(function (e) { return e.grade.total >= 66; }).length,
      /* the two that are worth showing, with what they were and what happened */
      best: { text: best.text || '', total: best.grade.total, label: best.grade.label, note: best.grade.note, result: best.result },
      worst: { text: worst.text || '', total: worst.grade.total, label: worst.grade.label, note: worst.grade.note, result: worst.result },
      /* THE HEADLINE. A season of this game is meant to teach that these are
         two different numbers. */
      divergence: (process != null && result != null) ? process - result : null
    };
  }

  var API = { VERSION: VERSION, WEIGHTS: WEIGHTS, BANDS: BANDS,
              context: context, grade: grade, report: report, verdict: verdict,
              resultScore: resultScore, iqFor: iqFor,
              matchupFit: matchupFit, situationalFit: situationalFit,
              personnelFit: personnelFit, riskFit: riskFit, independence: independence };
  root.EDGridironRead = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
