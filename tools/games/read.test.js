#!/usr/bin/env node
/* ===========================================================================
   EDGEDESK FOOTBALL — RESEARCH IQ, ON PROCESS (read_v1)

   The one thing this file has to prove is the one thing that is easy to get
   wrong: the grade cannot see the result. A call is judged on the down, the
   distance, the clock, the look above the field and the men on the roster,
   and on nothing that happened afterwards — so a good read that lost is
   still paid like a good read, and a bad read that broke for eighteen is
   not.

     1  the grade is a pure function of what was visible before the snap
     2  matchup: the call is judged against the look the defence showed
     3  situation: the down, the distance and the clock all move it
     4  personnel: the men you have change what is a good idea
     5  risk: the same call is a different decision in a different place
     6  independence: the same concept four times is not a read
     7  the two worked examples from the brief land where the brief says
     8  the report separates PROCESS from RESULT and names both reads
     9  the page grades before the snap and files the result afterwards

   Run: node tools/games/read.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..', '..');
const R = require(path.join(ROOT, 'games', 'lib', 'gridiron', 'read.js'));
const PLAY = fs.readFileSync(path.join(ROOT, 'games', 'play', 'play.js'), 'utf8');

let pass = 0, fail = 0; const fails = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; fails.push('  ✗ ' + name + (detail ? ' — ' + String(detail).slice(0, 220) : '')); } }
function eq(name, got, want) { chk(name, String(got) === String(want), 'got ' + got + ', want ' + want); }
function has(hay, needle, name) { chk(name || ('it says ' + needle), String(hay).indexOf(needle) >= 0); }

/* a context builder with sensible middles, so each test moves one thing */
function ctx(over) {
  over = over || {};
  const sit = Object.assign({ down: 1, toGo: 10, ball: 40, quarter: 2, clock: 600 }, over.sit || {});
  const ps = Object.assign({ box: 7, blitzing: false, shell: 'Cover 2', safeties: 2, light: false, heavy: false,
    parts: { coverage: { key: over.coverage || 'cover2' } } }, over.preSnap || {});
  const play = Object.assign({ key: 'inside_zone', concept: 'inside', type: 'run', depth: 0 }, over.play || {});
  return R.context({
    sit, preSnap: ps, play, playKey: play.key, formation: 'i_form',
    scoreFor: over.scoreFor == null ? 0 : over.scoreFor,
    scoreAgainst: over.scoreAgainst == null ? 0 : over.scoreAgainst,
    personnel: over.personnel === undefined
      ? { rb: { overall: 78, archetype: 'Workhorse', speed: 80, power: 80 }, qb: { overall: 78, archetype: 'Field General', arm: 80 }, wr: { best: 78 }, ol: 72 }
      : over.personnel,
    recent: over.recent || []
  });
}

/* ── 1. the grade cannot see the result ────────────────────────────────── */
(function pure() {
  const c = ctx({});
  const a = R.grade(c), b = R.grade(c);
  eq('the same context grades the same twice', JSON.stringify(a), JSON.stringify(b));
  chk('the context carries no outcome, and the grade takes none',
    Object.keys(c).every(k => !/yards|outcome|result|touchdown|turnover/.test(k)) && R.grade.length === 1,
    Object.keys(c).join(','));
  const src = fs.readFileSync(path.join(ROOT, 'games', 'lib', 'gridiron', 'read.js'), 'utf8');
  const gradeBody = src.slice(src.indexOf('function grade(c)'), src.indexOf('function iqFor('));
  chk('nothing in the grade reads a result', !/yards|touchdown|turnover|outcome|result/.test(gradeBody));
  /* the same call, two different results, one grade */
  const g = R.grade(c);
  const lost = R.resultScore({ yards: -3 }, c), won = R.resultScore({ yards: 22 }, c);
  chk('the result is scored separately and does not move the grade',
    lost !== won && R.grade(c).total === g.total, lost + ' vs ' + won);
})();

/* ── 2. the matchup is judged against the look ─────────────────────────── */
(function matchup() {
  const lightRun = R.grade(ctx({ preSnap: { box: 6, light: true } }));
  const heavyRun = R.grade(ctx({ preSnap: { box: 8.2, heavy: true } }));
  chk('a run at a light box beats the same run at a heavy one', lightRun.matchup > heavyRun.matchup + 8,
    lightRun.matchup + ' vs ' + heavyRun.matchup);
  const P = { play: { key: 'stack', concept: 'inter', type: 'pass', depth: 10 } };
  const heavyPass = R.grade(ctx(Object.assign({ preSnap: { box: 8.2, heavy: true } }, P)));
  const lightPass = R.grade(ctx(Object.assign({ preSnap: { box: 6, light: true } }, P)));
  chk('and a throw against a heavy box beats the same throw against a light one',
    heavyPass.matchup > lightPass.matchup + 8, heavyPass.matchup + ' vs ' + lightPass.matchup);
  const quickVsBlitz = R.grade(ctx({ play: { key: 'quick', concept: 'quick', type: 'pass', depth: 3 }, preSnap: { blitzing: true } }));
  const deepVsBlitz = R.grade(ctx({ play: { key: 'shot', concept: 'shot', type: 'pass', depth: 20 }, preSnap: { blitzing: true, safeties: 2 } }));
  chk('getting it out beats a deep drop when they are coming', quickVsBlitz.matchup > deepVsBlitz.matchup,
    quickVsBlitz.matchup + ' vs ' + deepVsBlitz.matchup);
  const shotOneHigh = R.grade(ctx({ play: { key: 'shot', concept: 'shot', type: 'pass', depth: 20 }, preSnap: { safeties: 1 }, coverage: 'cover3' }));
  const shotQuarters = R.grade(ctx({ play: { key: 'shot', concept: 'shot', type: 'pass', depth: 20 }, preSnap: { safeties: 4 }, coverage: 'cover4' }));
  chk('a shot with one high beats the same shot into quarters', shotOneHigh.matchup > shotQuarters.matchup + 10,
    shotOneHigh.matchup + ' vs ' + shotQuarters.matchup);
})();

/* ── 3. the situation moves it ─────────────────────────────────────────── */
(function situation() {
  const runShort = R.grade(ctx({ sit: { down: 3, toGo: 1 } }));
  const runLong = R.grade(ctx({ sit: { down: 3, toGo: 12 } }));
  chk('a run on third and one beats a run on third and twelve',
    runShort.situational > runLong.situational + 10, runShort.situational + ' vs ' + runLong.situational);
  const reaches = R.grade(ctx({ sit: { down: 3, toGo: 9 }, play: { key: 'dagger', concept: 'inter', type: 'pass', depth: 12 } }));
  const short = R.grade(ctx({ sit: { down: 3, toGo: 9 }, play: { key: 'flat', concept: 'quick', type: 'pass', depth: 2 } }));
  chk('a throw that reaches the sticks beats one that cannot',
    reaches.situational > short.situational + 8, reaches.situational + ' vs ' + short.situational);
  const behindLate = R.grade(ctx({ sit: { down: 1, toGo: 10, quarter: 4, clock: 90 }, scoreFor: 10, scoreAgainst: 17 }));
  const aheadLate = R.grade(ctx({ sit: { down: 1, toGo: 10, quarter: 4, clock: 90 }, scoreFor: 17, scoreAgainst: 10 }));
  chk('running while behind late is worse than running while ahead late',
    aheadLate.situational > behindLate.situational + 8, aheadLate.situational + ' vs ' + behindLate.situational);
})();

/* ── 4. the men you have ───────────────────────────────────────────────── */
(function personnel() {
  const good = R.grade(ctx({ personnel: { rb: { overall: 88, archetype: 'Power Back', speed: 84, power: 90 }, qb: { overall: 70 }, wr: { best: 70 }, ol: 82 } }));
  const bad = R.grade(ctx({ personnel: { rb: { overall: 66, archetype: 'Receiving Back', speed: 74, power: 60 }, qb: { overall: 86 }, wr: { best: 86 }, ol: 62 } }));
  chk('the same run is a better idea behind a better line and back',
    good.personnel > bad.personnel + 8, good.personnel + ' vs ' + bad.personnel);
  const armed = R.grade(ctx({ play: { key: 'shot', concept: 'shot', type: 'pass', depth: 20 },
    personnel: { rb: { overall: 70 }, qb: { overall: 86, archetype: 'Gunslinger', arm: 92 }, wr: { best: 86 }, ol: 78 } }));
  const noodle = R.grade(ctx({ play: { key: 'shot', concept: 'shot', type: 'pass', depth: 20 },
    personnel: { rb: { overall: 70 }, qb: { overall: 70, archetype: 'Game Manager', arm: 68 }, wr: { best: 64 }, ol: 78 } }));
  chk('and a deep shot is a better idea with an arm to throw it',
    armed.personnel > noodle.personnel + 8, armed.personnel + ' vs ' + noodle.personnel);
  chk('with no roster handed in it neither rewards nor punishes',
    R.grade(ctx({ personnel: null })).personnel === Math.round(R.WEIGHTS.personnel * 0.5));
})();

/* ── 5. risk is a place as much as a call ──────────────────────────────── */
(function risk() {
  const deepOwnEnd = R.grade(ctx({ sit: { ball: 6 }, play: { key: 'shot', concept: 'shot', type: 'pass', depth: 20 } }));
  const deepMidfield = R.grade(ctx({ sit: { ball: 45 }, play: { key: 'shot', concept: 'shot', type: 'pass', depth: 20 } }));
  chk('a deep drop from your own end is riskier than the same one at midfield',
    deepMidfield.risk > deepOwnEnd.risk, deepMidfield.risk + ' vs ' + deepOwnEnd.risk);
  const chasing = R.grade(ctx({ sit: { quarter: 4, clock: 120, ball: 45 }, scoreFor: 14, scoreAgainst: 21,
    play: { key: 'shot', concept: 'shot', type: 'pass', depth: 20 } }));
  const protecting = R.grade(ctx({ sit: { quarter: 4, clock: 120, ball: 45 }, scoreFor: 21, scoreAgainst: 14,
    play: { key: 'shot', concept: 'shot', type: 'pass', depth: 20 } }));
  chk('the risk the scoreboard asks for is not the same as the risk it forbids',
    chasing.risk > protecting.risk + 4, chasing.risk + ' vs ' + protecting.risk);
})();

/* ── 6. the same call four times is not a read ─────────────────────────── */
(function independent() {
  const fresh = R.grade(ctx({ recent: ['outside', 'quick', 'gap'] }));
  const repeat = R.grade(ctx({ recent: ['inside', 'inside', 'inside', 'inside'] }));
  eq('a varied call sheet keeps the whole ten', fresh.independence, R.WEIGHTS.independence);
  chk('the same concept four times running costs most of it', repeat.independence <= 2, repeat.independence);
  chk('and it is the only part of the grade that looks backwards',
    R.grade(ctx({ recent: ['inside', 'inside', 'inside', 'inside'] })).matchup === fresh.matchup);
})();

/* ── 7. the brief's two examples ───────────────────────────────────────── */
(function examples() {
  /* 3rd & 3, elite interior line, power back, a weak front: Inside Zone */
  const goodCtx = ctx({ sit: { down: 3, toGo: 3, ball: 40 }, preSnap: { box: 6, light: true, safeties: 2 },
    personnel: { rb: { overall: 85, archetype: 'Power Back', power: 88, speed: 80 }, qb: { overall: 74 }, wr: { best: 75 }, ol: 80 },
    recent: ['outside', 'quick', 'gap'] });
  const good = R.grade(goodCtx);
  chk('the brief\'s good read grades in the high eighties or better', good.total >= 82, good.total);
  eq('and reads as a good read', good.label, 'GOOD READ');
  chk('and pays like one even though it lost a yard', good.iq >= 14, good.iq);
  const v1 = R.verdict(good, R.resultScore({ yards: -1 }, goodCtx));
  eq('the verdict on a good read that lost', v1.head, 'GOOD READ');
  has(v1.line, 'the process was sound', 'and it says why');

  /* 3rd & 12, a low-percentage inside run into an elite run defence */
  const badCtx = ctx({ sit: { down: 3, toGo: 12, ball: 35 }, preSnap: { box: 8.2, heavy: true },
    personnel: { rb: { overall: 74, archetype: 'Workhorse', power: 70, speed: 74 }, qb: { overall: 82 }, wr: { best: 84 }, ol: 64 },
    recent: ['inside', 'inside', 'inside', 'inside'] });
  const bad = R.grade(badCtx);
  chk('the brief\'s bad read grades in the low thirties or worse', bad.total <= 40, bad.total);
  chk('and pays almost nothing', bad.iq <= 4, bad.iq);
  chk('but is never punished below zero', bad.iq >= 0, bad.iq);
  const v2 = R.verdict(bad, R.resultScore({ yards: 18 }, badCtx));
  has(v2.head, 'RESULT WORKED', 'the verdict on a bad read that worked');
  has(v2.line, 'low-quality decision', 'and it teaches rather than scolds');
  /* the whole point, in one assertion */
  chk('a good read that lost outscores a bad read that won', good.total > bad.total && good.iq > bad.iq,
    good.total + '/' + good.iq + ' vs ' + bad.total + '/' + bad.iq);
})();

/* ── 8. the report keeps the two apart ─────────────────────────────────── */
(function report() {
  const entries = [];
  const mk = (over, yards) => {
    const c = ctx(over), g = R.grade(c);
    entries.push({ ctx: c, grade: g, result: R.resultScore({ yards }, c), text: (over.play && over.play.key) || 'inside_zone' });
  };
  mk({ sit: { down: 3, toGo: 3 }, preSnap: { box: 6, light: true }, recent: ['outside', 'quick', 'gap'],
       personnel: { rb: { overall: 85, archetype: 'Power Back', power: 88, speed: 80 }, qb: { overall: 74 }, wr: { best: 75 }, ol: 80 } }, -1); /* good read, bad result */
  mk({ sit: { down: 3, toGo: 12 }, preSnap: { box: 8.2, heavy: true }, recent: ['inside', 'inside', 'inside', 'inside'] }, 18); /* bad read, good result */
  mk({ sit: { down: 1, toGo: 10 }, play: { key: 'stack', concept: 'inter', type: 'pass', depth: 10 }, preSnap: { box: 8, heavy: true } }, 9);
  const r = R.report(entries);
  eq('the report grades every call', r.calls, 3);
  chk('process and result are two different numbers', r.process !== r.result, r.process + ' vs ' + r.result);
  chk('the best read is the best DECISION, not the best result',
    r.best.total >= 82 && r.best.result < 66, r.best.total + '/' + r.best.result);
  chk('and the worst read is the worst decision, whatever it gained',
    r.worst.total <= 40 && r.worst.result >= 66, r.worst.total + '/' + r.worst.result);
  chk('the four halves of the job are reported out of a hundred each',
    [r.matchup, r.situational, r.personnel, r.risk, r.independence].every(v => v >= 0 && v <= 100),
    [r.matchup, r.situational, r.personnel, r.risk, r.independence].join('/'));
  chk('the IQ is the sum of what the process earned', r.iq === entries.reduce((t, e) => t + e.grade.iq, 0), r.iq);
  chk('and the divergence says which way it went', r.divergence === r.process - r.result, r.divergence);
  chk('no calls, no report', R.report([]) === null && R.report(null) === null);
})();

/* ── 9. the page grades before the snap and files the result after ─────── */
(function page() {
  has(PLAY, 'captureRead(key, formKey, ps, sit)', 'the page freezes the context when the call is made');
  has(PLAY, 'pendingRead.grade = RD.grade(pendingRead.ctx);', 'and grades it there, before the snap');
  has(PLAY, 'var readEntry = fileRead(p);', 'the result is filed afterwards');
  chk('the grade is not touched when the result arrives',
    /function fileRead\(res\) \{[\s\S]{0,420}e\.result = RD\.resultScore/.test(PLAY)
    && !/fileRead[\s\S]{0,400}RD\.grade\(/.test(PLAY));
  has(PLAY, 'function researchReport(r)', 'the final screen reports on it');
  has(PLAY, 'Process score', 'with the process');
  has(PLAY, 'Result score', 'and the result');
  has(PLAY, 'Best read', 'and the best read');
  has(PLAY, 'Worst read', 'and the worst');
  has(PLAY, 'Matchup recognition', 'and how the matchups were read');
  has(PLAY, 'Situational football', 'and how the situations were played');
  has(PLAY, "READS = []; pendingRead = null; readSaid = 0;", 'a new game starts a new record of reads');
  chk('the broadcast only speaks up when process and result disagree',
    /if \(v\.key === 'both' \|\| v\.key === 'neither'\) return;/.test(PLAY));
})();

if (fails.length) console.log(fails.join('\n'));
console.log('\nRESEARCH IQ — the read, not the result\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
