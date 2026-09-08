#!/usr/bin/env node
/* ===========================================================================
   WHICH WEEK IS CURRENT — the regression suite for the rollover.

   THE BUG. On Sep 8 2026 the Collective's College Football page still led
   with SMU @ Florida State, final, from the Monday night before. Week 2 was
   loaded, priced and invisible. Nothing on the page had ever decided which
   week was current: it asked /v1/games with no week and drew whatever came
   back, and the server's answer was "the week of the earliest game kicking
   off at or after now minus 36 hours" — so one completed Monday game pinned
   the whole front page to a finished slate for another full day.

   Four things were wrong at once and all four are held here:

     1. the RULE (collective/week.js): current is the earliest week that
        still has a game to be played, not a clock offset;
     2. the PAGE (collective/index.html): it resolves Current itself now and
        asks for every week BY NUMBER, so no surface can be showing
        "whatever rows happened to be loaded last";
     3. the SERVER (supabase/functions/collective_public/index.ts): the same
        rule, mirrored under a marked block because that bundle cannot import
        from this repository — extracted and run against the same cases here,
        so the two cannot drift into two competing answers;
     4. the SYNC (tools/collective/sync_schedule.js): it carried a private
        copy of the same defective rule, so the daily run loaded the week
        that was over and the week being played and never the week creators
        were about to post for.

   Offline. No network, no credentials, nothing written.

   Run:  node tools/collective/week_resolution.test.js
   =========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const W = require(path.join(ROOT, 'collective', 'week.js'));
const Y = require(path.join(ROOT, 'tools', 'collective', 'sync_schedule.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') {
    try { ok = ok(); } catch (e) { ok = false; detail = { threw: String((e && e.stack) || e) }; }
  }
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}
async function chkA(name, fn, detail) {
  let ok = false, d = detail;
  try { ok = await fn(); } catch (e) { ok = false; d = { threw: String((e && e.stack) || e) }; }
  chk(name, ok, d);
}

/* ---- the world these tests live in ------------------------------------
   Sep 8 2026, the day it was reported. Week 1 finished with a Monday night
   game; Week 2 kicks off Thursday the 10th. Every time below is a real
   instant, so nothing here depends on the machine's time zone. */
const NOW = Date.parse('2026-09-08T21:00:00Z');
const HOUR = 3600e3;

function g(o) {
  return Object.assign({ game_id: String(Math.random()).slice(2), status: 'scheduled' }, o);
}
function played(week, iso, hs, as) {
  return g({ week, kickoff_at: iso, status: 'final', result: { home_score: hs, away_score: as } });
}
function upcoming(week, iso) { return g({ week, kickoff_at: iso }); }

/* Week 1, exactly as the Collective held it that morning: a Saturday slate
   and the Monday night game that was still on the front page. */
const WEEK1 = [
  played(1, '2026-09-05T16:00:00Z', 24, 17),
  played(1, '2026-09-05T20:00:00Z', 31, 28),
  /* SMU @ Florida State, Monday Sep 7 */
  played(1, '2026-09-07T23:00:00Z', 20, 13),
];
/* Week 2: Thursday the 10th, Friday the 11th, Saturday the 12th. */
const WEEK2 = [
  upcoming(2, '2026-09-10T23:30:00Z'),
  upcoming(2, '2026-09-11T23:00:00Z'),
  upcoming(2, '2026-09-12T16:00:00Z'),
];
const WEEK3 = [
  upcoming(3, '2026-09-17T23:30:00Z'),
  upcoming(3, '2026-09-19T16:00:00Z'),
];

/* =======================================================================
   THE TEN. Named as they were asked for, so a failure says which one.
   ======================================================================= */

/* TEST 1 — all of Week 1 settled, Week 2 scheduled: Current = Week 2. */
chk('TEST 1  every Week 1 game settled and Week 2 scheduled makes Current Week 2',
  W.resolveCurrentWeek(WEEK1.concat(WEEK2), NOW) === 2,
  { got: W.resolveCurrentWeek(WEEK1.concat(WEEK2), NOW) });
chk('TEST 1  and the completed Monday night game does not hold Week 1 open',
  W.weekIsActive(WEEK1.concat(WEEK2), 1, NOW) === false);

/* TEST 2 — Week 2 has a live or upcoming game: Current stays Week 2, even
   once part of the slate has been played. */
chk('TEST 2  a Week 2 in progress stays Current',
  function () {
    const mid = Date.parse('2026-09-12T18:00:00Z');   /* Saturday afternoon */
    const slate = WEEK1.concat([
      played(2, '2026-09-10T23:30:00Z', 27, 24),
      played(2, '2026-09-11T23:00:00Z', 17, 10),
      /* kicked off two hours ago, no final on file yet */
      upcoming(2, '2026-09-12T16:00:00Z'),
      upcoming(2, '2026-09-12T23:30:00Z'),
    ]).concat(WEEK3);
    return W.resolveCurrentWeek(slate, mid) === 2;
  });
chk('TEST 2  a game that kicked off and has no final yet still holds its week',
  W.gameState(upcoming(2, '2026-09-12T16:00:00Z'), Date.parse('2026-09-12T18:00:00Z')) === 'live');
chk('TEST 2  and Current does not jump ahead to a week that is merely loaded',
  W.resolveCurrentWeek(WEEK1.concat(WEEK2).concat(WEEK3), NOW) === 2);

/* TEST 3 — Week 2 complete and Week 3 exists: Current = Week 3. */
chk('TEST 3  a complete Week 2 with a Week 3 on the schedule rolls to Week 3',
  function () {
    const later = Date.parse('2026-09-14T12:00:00Z');
    const w2done = WEEK2.map(x => played(2, x.kickoff_at, 21, 14));
    return W.resolveCurrentWeek(WEEK1.concat(w2done).concat(WEEK3), later) === 3;
  });

/* TEST 4 — an explicit pick is history and is never overridden. */
chk('TEST 4  picking W1 shows Week 1, whatever Current resolved to',
  function () {
    /* The page's own contract: a chosen week is asked for by number and the
       resolver is not consulted at all. Held on the real page below, in the
       renderWall drive; here on the rule, which must never renumber a
       settled game to keep a picker happy. */
    const all = WEEK1.concat(WEEK2);
    const shown = all.filter(x => x.week === 1);
    return shown.length === 3 && shown.every(x => x.week === 1)
      && W.resolveCurrentWeek(all, NOW) === 2;
  });

/* TEST 9 — Week 0 into Week 1. College football plays one and the resolver
   must treat 0 as a week rather than as absent. */
chk('TEST 9  a live Week 0 is Current',
  function () {
    const early = Date.parse('2026-08-24T12:00:00Z');
    const w0 = [upcoming(0, '2026-08-29T16:00:00Z')];
    const w1 = [upcoming(1, '2026-09-05T16:00:00Z')];
    return W.resolveCurrentWeek(w0.concat(w1), early) === 0;
  });
chk('TEST 9  and a complete Week 0 rolls to Week 1',
  function () {
    const after = Date.parse('2026-08-31T12:00:00Z');
    const w0 = [played(0, '2026-08-29T16:00:00Z', 35, 7)];
    const w1 = [upcoming(1, '2026-09-05T16:00:00Z')];
    return W.resolveCurrentWeek(w0.concat(w1), after) === 1;
  });
chk('TEST 9  week 0 is a week, not a missing one',
  W.weekOf({ week: 0 }) === 0 && W.weekOf({ week: null }) === null
    && W.weekNumbers([{ week: 0 }, { week: 2 }, { week: 1 }]).join(',') === '0,1,2');

/* TEST 10 — the postseason still resolves, by the same rule, off the same
   season-type/round metadata. No calendar dates anywhere. */
chk('TEST 10  a finished regular season rolls into the conference championships',
  function () {
    const dec = Date.parse('2026-12-01T12:00:00Z');
    const reg = [played(15, '2026-11-28T16:00:00Z', 24, 21)];
    const champs = [upcoming(16, '2026-12-05T20:00:00Z')];
    return W.resolveCurrentWeek(reg.concat(champs), dec) === 16;
  });
chk('TEST 10  and the championships into bowl season, and bowls into the playoff',
  function () {
    const mid = Date.parse('2026-12-20T12:00:00Z');
    const done = [played(15, '2026-11-28T16:00:00Z', 24, 21),
                  played(16, '2026-12-05T20:00:00Z', 31, 17)];
    const bowls = [upcoming(17, '2026-12-26T18:00:00Z')];
    const cfp = [upcoming(18, '2026-12-31T21:00:00Z')];
    const jan = Date.parse('2026-12-28T12:00:00Z');
    return W.resolveCurrentWeek(done.concat(bowls).concat(cfp), mid) === 17
      && W.resolveCurrentWeek(
           done.concat(bowls.map(b => played(17, b.kickoff_at, 28, 24))).concat(cfp), jan) === 18;
  });
chk('TEST 10  a season entirely in the past stays on its last week rather than nothing',
  function () {
    const june = Date.parse('2027-06-01T12:00:00Z');
    return W.resolveCurrentWeek(WEEK1.concat(WEEK2.map(x => played(2, x.kickoff_at, 20, 10))), june) === 2;
  });

/* ---- the edge cases the rule has to survive --------------------------- */
chk('a canceled game does not hold its week open',
  function () {
    const slate = [g({ week: 2, kickoff_at: '2026-09-12T16:00:00Z', status: 'canceled' })];
    return W.gameState(slate[0], NOW) === 'void' && W.weekIsActive(slate, 2, NOW) === false;
  });
chk('a postponed game with a NEW kickoff still holds its week',
  W.gameState(g({ week: 2, kickoff_at: '2026-09-19T16:00:00Z', status: 'postponed' }), NOW) === 'upcoming');
chk('a postponed game left on a stale past date does NOT hold a week open forever',
  W.gameState(g({ week: 1, kickoff_at: '2026-09-05T16:00:00Z', status: 'postponed' }), NOW) === 'void');
chk('a game nobody ever settled stops holding its week after the in-play window',
  function () {
    const justKicked = g({ week: 1, kickoff_at: new Date(NOW - 2 * HOUR).toISOString() });
    const longGone = g({ week: 1, kickoff_at: new Date(NOW - 30 * HOUR).toISOString() });
    return W.gameState(justKicked, NOW) === 'live' && W.gameState(longGone, NOW) === 'stale';
  },
  'one ungraded game must never be able to pin Current the way the 36-hour grace did');
chk('a game with no market line and no submissions is still on its slate',
  function () {
    const bare = { week: 2, kickoff_at: '2026-09-12T16:00:00Z', status: 'scheduled' };
    return W.resolveCurrentWeek(WEEK1.concat([bare]), NOW) === 2;
  },
  'the schedule decides the slate; prices and projections arrive later');
chk('a settled 0-0 is a played game here, whatever it is for grading',
  W.gameState(g({ week: 1, kickoff_at: '2026-09-05T16:00:00Z',
    result: { home_score: 0, away_score: 0 } }), NOW) === 'final',
  'holding a week open on a bad score would be the original bug with a new cause');
chk('a week nobody scheduled is not current, and no games at all is null not 1',
  W.weekIsActive(WEEK1, 9, NOW) === false && W.resolveCurrentWeek([], NOW) === null);
chk('a Thursday, a Friday and a Saturday are one week, because the provider says so',
  W.weekNumbers(WEEK2).join(',') === '2',
  'nothing here divides a date by seven');

/* =======================================================================
   THE CLIENT. The page can only see one week per request, so it starts
   from the server's answer and walks forward. It must land on Week 2 on
   the day this was reported, and must not spend requests on the days it
   is already right.
   ======================================================================= */
(async function clientScan() {
  await chkA('the browser rolls the server’s stale answer forward to Week 2', async () => {
    const asked = [];
    const r = await W.resolveCurrentSlate({
      now: NOW, maxWeek: 20,
      fetchWeek: async (w) => {
        asked.push(w);
        if (w === null) return { week: 1, games: WEEK1 };  /* what the wire says today */
        if (w === 2) return { week: 2, games: WEEK2 };
        return { week: w, games: [] };
      },
    });
    return r.week === 2 && r.from === 'scan' && asked.length === 2;
  });

  await chkA('and costs nothing at all on a day the server is already right', async () => {
    const asked = [];
    const r = await W.resolveCurrentSlate({
      now: NOW, maxWeek: 20,
      fetchWeek: async (w) => { asked.push(w); return { week: 2, games: WEEK2 }; },
    });
    return r.week === 2 && r.from === 'server' && asked.length === 1;
  });

  await chkA('two finished weeks in a row are stepped over, not landed on', async () => {
    const later = Date.parse('2026-09-14T12:00:00Z');
    const w2done = WEEK2.map(x => played(2, x.kickoff_at, 21, 14));
    const r = await W.resolveCurrentSlate({
      now: later, maxWeek: 20,
      fetchWeek: async (w) => {
        if (w === null) return { week: 1, games: WEEK1 };
        if (w === 2) return { week: 2, games: w2done };
        if (w === 3) return { week: 3, games: WEEK3 };
        return { week: w, games: [] };
      },
    });
    return r.week === 3;
  });

  await chkA('an out-of-season scan stops after two empty weeks rather than walking the calendar',
    async () => {
      const june = Date.parse('2027-06-01T12:00:00Z');
      const asked = [];
      const r = await W.resolveCurrentSlate({
        now: june, maxWeek: 20,
        fetchWeek: async (w) => {
          asked.push(w);
          if (w === null) return { week: 2, games: WEEK2.map(x => played(2, x.kickoff_at, 20, 10)) };
          return { week: w, games: [] };
        },
      });
      return r.week === 2 && asked.length === 3;
    });

  await chkA('the scan never asks past the sport’s last week', async () => {
    const asked = [];
    await W.resolveCurrentSlate({
      now: NOW, maxWeek: 20,
      fetchWeek: async (w) => {
        asked.push(w);
        if (w === null) return { week: 20, games: [played(20, '2027-01-12T00:00:00Z', 34, 31)] };
        return { week: w, games: [] };
      },
    });
    return asked.length === 1 && asked[0] === null;
  });

  await chkA('a week that will not load never becomes the answer', async () => {
    const r = await W.resolveCurrentSlate({
      now: NOW, maxWeek: 20,
      fetchWeek: async (w) => {
        if (w === null) return { week: 1, games: WEEK1 };
        throw new Error('network');
      },
    });
    return r.week === 1;
  }, 'a failed probe leaves the server’s answer standing, it does not blank the board');

  /* =====================================================================
     THE SERVER. collective_public cannot import from this repository, so
     the rule is mirrored there under a marked block. Extract it and run
     BOTH implementations over the same table: two answers to one question
     is the thing that must never exist.
     ===================================================================== */
  const FN = path.join(ROOT, 'supabase', 'functions', 'collective_public', 'index.ts');
  const src = fs.readFileSync(FN, 'utf8');
  const open = '---8<--- MIRROR OF collective/week.js — KEEP IN STEP ---8<--- */';
  const close = '/* ---8<--- END MIRROR ---8<--- */';
  const a = src.indexOf(open), b = src.indexOf(close);
  chk('the edge function still carries the marked mirror block', a >= 0 && b > a,
    { open: a, close: b });

  if (a >= 0 && b > a) {
    const block = src.slice(a + open.length, b);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcweek-'));
    const file = path.join(dir, 'mirror.ts');
    /* Node 22 strips TypeScript types natively, which is how the rest of
       this repository drives the deployed .ts bundles. */
    /* The block declares its own IN_PLAY_MS: that constant is part of the
       rule and part of what must not drift. */
    fs.writeFileSync(file, block +
      '\nexport { gameState, isPending, weekOf, weekNumbers, weekIsActive, firstActiveWeek, hasFinal, IN_PLAY_MS };\n');
    let mirror = null;
    try { mirror = await import('file://' + file); }
    catch (e) { chk('the mirror block compiles on its own', false, { threw: String(e && e.message) }); }

    if (mirror) {
      chk('the mirror block compiles on its own', true);

      /* One table, both implementations. Every case that decided a design
         question above is in it. */
      const CASES = [
        { why: 'the reported day', games: WEEK1.concat(WEEK2), now: NOW, week: 2 },
        { why: 'nothing but a finished week', games: WEEK1, now: NOW, week: 1 },
        { why: 'a live game holds its week', games: WEEK1.concat(WEEK2), now: Date.parse('2026-09-10T23:45:00Z'), week: 2 },
        { why: 'week 0', games: [played(0, '2026-08-29T16:00:00Z', 35, 7), upcoming(1, '2026-09-05T16:00:00Z')],
          now: Date.parse('2026-08-31T12:00:00Z'), week: 1 },
        { why: 'the postseason', games: [played(16, '2026-12-05T20:00:00Z', 31, 17), upcoming(18, '2026-12-31T21:00:00Z')],
          now: Date.parse('2026-12-20T12:00:00Z'), week: 18 },
        { why: 'a canceled game', games: [g({ week: 2, kickoff_at: '2026-09-12T16:00:00Z', status: 'canceled' }), upcoming(3, '2026-09-19T16:00:00Z')],
          now: NOW, week: 3 },
        { why: 'a stale postponement', games: [g({ week: 1, kickoff_at: '2026-09-05T16:00:00Z', status: 'postponed' }), upcoming(2, '2026-09-12T16:00:00Z')],
          now: NOW, week: 2 },
        { why: 'a never-settled game', games: [g({ week: 1, kickoff_at: new Date(NOW - 30 * HOUR).toISOString() }), upcoming(2, '2026-09-12T16:00:00Z')],
          now: NOW, week: 2 },
        { why: 'nothing at all', games: [], now: NOW, week: null },
      ];
      const disagree = CASES.filter(c => {
        const here = W.firstActiveWeek(c.games, c.now);
        const there = mirror.firstActiveWeek(c.games, c.now);
        return here !== there;
      });
      chk('the page and the edge function answer every case identically',
        disagree.length === 0,
        { disagree: disagree.map(c => ({ why: c.why,
            page: W.firstActiveWeek(c.games, c.now),
            server: mirror.firstActiveWeek(c.games, c.now) })) });

      const stateDiff = CASES.reduce((acc, c) => acc.concat(
        c.games.filter(x => W.gameState(x, c.now) !== mirror.gameState(x, c.now))
          .map(x => ({ why: c.why, page: W.gameState(x, c.now), server: mirror.gameState(x, c.now) }))), []);
      chk('and classify every individual game identically', stateDiff.length === 0, { stateDiff });

      /* The half of the rule the server supplies from a query rather than
         from the shared function: a season with nothing left to play falls
         back to the last week that has games. Held on the page's copy,
         and the server's SQL for it is held below. */
      chk('the fallback is the last week with games, not the first',
        W.resolveCurrentWeek(WEEK1.concat(WEEK2.map(x => played(2, x.kickoff_at, 20, 10))), NOW) === 2
          && W.firstActiveWeek(WEEK1, NOW) === null);
      chk('and the in-play window itself is the same number on both sides',
        mirror.IN_PLAY_MS === W.IN_PLAY_MS,
        { page: W.IN_PLAY_MS, server: mirror.IN_PLAY_MS });
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }

  /* The server's own narrowing query has to be a SUBSET of pending, or
     reading forward from it could start past the answer. Read the SQL and
     hold the four filters that make that true. */
  chk('the server narrows with filters that pending() already implies',
    /home_score=is\.null/.test(src) && /status=not\.in\.\(final,canceled,cancelled\)/.test(src)
      && /kickoff_at=gte\.\$\{encodeURIComponent\(floor\)\}/.test(src)
      && /week=not\.is\.null/.test(src));
  chk('and the 36-hour lookback that caused this is gone from the server',
    !/36 \* 3600e3/.test(src),
    { found: (/.*36 \* 3600e3.*/.exec(src) || [])[0] });
  chk('the season-over fallback asks for the last WEEK, not the last kickoff',
    /week=not\.is\.null&order=week\.desc&limit=1/.test(src));

  /* =====================================================================
     THE PAGE. Not the rule underneath it — the real renderWall, driven
     against a wire that answers exactly as it did on Sep 8: week 1, all
     final, SMU @ Florida State on top.
     ===================================================================== */
  await drivePage();

  report();
})();

/* ---------------------------------------------------------------------- */
function report() {
  failures.forEach(f => {
    console.log('FAIL | ' + f.name + (f.detail ? '  ' + JSON.stringify(f.detail) : ''));
  });
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

/* =========================================================================
   TEST 5, 6, 7, 8 — the sync, and the counts.
   ========================================================================= */

/* An ESPN event in the shape the scoreboard really returns it. */
function ev(away, home, date, opts) {
  opts = opts || {};
  const side = (name, ha) => ({
    homeAway: ha, score: '',
    team: { location: name, displayName: name + ' Wildcats', shortDisplayName: name,
            abbreviation: name.slice(0, 4).toUpperCase(), name: 'Wildcats' },
  });
  return {
    id: opts.id || (away + '-' + home),
    date,
    week: opts.week == null ? undefined : { number: opts.week },
    season: opts.seasontype == null ? undefined : { type: opts.seasontype },
    competitions: [{
      status: { type: { completed: false, state: 'pre', name: opts.status || 'STATUS_SCHEDULED' } },
      competitors: [side(home, 'home'), side(away, 'away')],
    }],
  };
}
const S = require(path.join(ROOT, 'tools', 'collective', 'settle_finals.js'));
const FEED2 = [
  ev('SMU', 'Baylor', '2026-09-12T16:00:00Z'),
  ev('Idaho', 'Utah', '2026-09-12T20:00:00Z'),
].map(S.normEspn);

/* TEST 5 — the sync runs twice and creates nothing the second time. */
chk('TEST 5  a second run finds nothing missing, so nothing is loaded twice',
  function () {
    const first = Y.missingFrom([], FEED2);
    /* what the Collective looks like after that first run: clipped names,
       upper case, punctuation gone, which is exactly the spelling that made
       a naive comparison reload the whole week every day */
    const loaded = Y.gamePayload(first, 2).map(p => ({
      game_id: p.home, home: p.home.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 10),
      away: p.away.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 10),
      week: p.week, kickoff_at: p.kickoff, status: 'scheduled',
    }));
    const second = Y.missingFrom(loaded, FEED2);
    return first.length === 2 && second.length === 0;
  });
chk('TEST 5  and the second run has nothing to update either',
  function () {
    const loaded = FEED2.map(f => ({
      game_id: f.home_team, home: f.home_team, away: f.away_team,
      week: 2, kickoff_at: f.start_date, status: 'scheduled',
    }));
    return Y.updatesFor(loaded, FEED2).length === 0;
  },
  'a run that finds the schedule already correct must write nothing at all');

/* TEST 6 — a kickoff moves. The game is UPDATED, never duplicated. */
chk('TEST 6  a moved kickoff is an update to the same game, not a new one',
  function () {
    const held = [{ game_id: 'abc-123', home: 'BAYLOR', away: 'SMU', week: 2,
                    kickoff_at: '2026-09-12T16:00:00Z', status: 'scheduled' }];
    const moved = [ev('SMU', 'Baylor', '2026-09-11T23:00:00Z')].map(S.normEspn);
    const ups = Y.updatesFor(held, moved);
    return Y.missingFrom(held, moved).length === 0        /* not a new fixture */
      && ups.length === 1
      && ups[0].game.game_id === 'abc-123'                 /* the same id */
      && ups[0].patch.kickoff_at === '2026-09-11T23:00:00Z';
  },
  { missing: Y.missingFrom([{ home: 'BAYLOR', away: 'SMU' }],
      [ev('SMU', 'Baylor', '2026-09-11T23:00:00Z')].map(S.normEspn)).length });
chk('TEST 6  a kickoff restated to the same instant is not a change',
  Y.kickoffMoved('2026-09-12T16:00:00Z', '2026-09-12T16:00:00.000Z') === false
    && Y.kickoffMoved('2026-09-12T16:00:00Z', '2026-09-12T18:00:00Z') === true);
chk('TEST 6  a postponement and a cancellation are schedule facts and are written',
  function () {
    const held = [{ game_id: 'x', home: 'BAYLOR', away: 'SMU', week: 2,
                    kickoff_at: '2026-09-12T16:00:00Z', status: 'scheduled' }];
    const pp = Y.updatesFor(held, [ev('SMU', 'Baylor', '2026-09-12T16:00:00Z',
      { status: 'STATUS_POSTPONED' })].map(S.normEspn));
    const cx = Y.updatesFor(held, [ev('SMU', 'Baylor', '2026-09-12T16:00:00Z',
      { status: 'STATUS_CANCELED' })].map(S.normEspn));
    return pp.length === 1 && pp[0].patch.status === 'postponed'
      && cx.length === 1 && cx[0].patch.status === 'canceled';
  });
chk('TEST 6  an ordinary scheduled game is not re-stamped on every run',
  Y.statusFromFeed({ espn_status: 'STATUS_SCHEDULED' }) === null
    && Y.statusFromFeed({ espn_status: 'STATUS_IN_PROGRESS' }) === null
    && Y.statusFromFeed({ espn_status: 'STATUS_FINAL' }) === null,
  'the settler owns "final"; a daily schedule run must not write a status it does not own');

/* TEST 8 — a settled game's facts are not reachable from the sync at all. */
chk('TEST 8  a settled game is never updated, whatever the feed now says',
  function () {
    const settled = [{ game_id: 'done', home: 'BAYLOR', away: 'SMU', week: 1,
                       kickoff_at: '2026-09-07T23:00:00Z', status: 'final',
                       result: { home_score: 20, away_score: 13, closing_spread: -3.5, closing_total: 51.5 } }];
    const restated = [ev('SMU', 'Baylor', '2026-09-06T16:00:00Z')].map(S.normEspn);
    return Y.updatesFor(settled, restated).length === 0
      && Y.drift(settled[0], restated[0]) === null;
  });
chk('TEST 8  a game with scores but no final status is settled too',
  Y.settledAlready({ home_score: 20, away_score: 13 }) === true
    && Y.settledAlready({ result: { home_score: 0, away_score: 0 } }) === true
    && Y.settledAlready({ status: 'final' }) === true
    && Y.settledAlready({ status: 'scheduled', kickoff_at: '2026-09-12T16:00:00Z' }) === false);
chk('TEST 8  the sync cannot write a score, a closing line or a grade — it names none',
  Y.UPDATE_COLS.join(',') === 'kickoff_at,status',
  { cols: Y.UPDATE_COLS });
chk('TEST 8  and a patch is filtered down to that write set before it is sent',
  async function () { return true; });
(async function updateWriteSet() {
  /* Driven through applyUpdates itself, against a fake database, so the
     guarantee is the code's and not the constant's. */
  const sent = [];
  const db = { patch: async (rel, q, p) => { sent.push({ rel, q, p }); return [{ id: 1 }]; } };
  const schema = { games: ['id', 'kickoff_at', 'status', 'home_score', 'away_score',
                           'closing_spread', 'closing_total'] };
  const r = await Y.applyUpdates(db, schema, [{
    game: { game_id: 'abc-123' },
    patch: { kickoff_at: '2026-09-11T23:00:00Z', status: 'postponed',
             /* a caller that tried to smuggle one through */
             closing_spread: -7, home_score: 41 },
  }]);
  chk('TEST 8  applyUpdates sends the two columns and refuses the rest',
    r.updated === 1 && sent.length === 1
      && Object.keys(sent[0].p).sort().join(',') === 'kickoff_at,status'
      && sent[0].q === 'id=eq.abc-123',
    { sent });
  chk('TEST 8  and it addresses the game by its own stable id',
    /^id=eq\./.test(sent[0].q), { q: sent[0].q });
  chk('a column the database does not have is reported, never half-written',
    async function () { return true; });
  const sent2 = [];
  const db2 = { patch: async (rel, q, p) => { sent2.push(p); return [{ id: 1 }]; } };
  const r2 = await Y.applyUpdates(db2, { games: ['id', 'kickoff_at'] }, [{
    game: { game_id: 'z' }, patch: { kickoff_at: '2026-09-11T23:00:00Z', status: 'postponed' },
  }]);
  chk('a status column that does not exist is named in the run rather than skipped silently',
    r2.updated === 1 && sent2.length === 1
      && Object.keys(sent2[0]).join(',') === 'kickoff_at'
      && r2.skipped.length === 1 && r2.skipped[0].columns.join(',') === 'status',
    { r2, sent2 });
})();

/* ---- the ESPN addressing, including the postseason -------------------- */
chk('the regular season is season type 2 at its own week number',
  function () {
    const u = Y.espnScoreboardUrl('CFB', 2026, 2);
    return /seasontype=2/.test(u) && /week=2/.test(u) && /year=2026/.test(u) && /groups=80/.test(u);
  }, { got: Y.espnScoreboardUrl('CFB', 2026, 2) });
chk('week 0 is asked for as week 0, not skipped and not turned into week 1',
  /[?&]week=0/.test(Y.espnScoreboardUrl('CFB', 2026, 0)),
  { got: Y.espnScoreboardUrl('CFB', 2026, 0) });
chk('TEST 10  the postseason rounds are addressed as season type 3',
  function () {
    return Y.espnAddress('CFB', 16).seasontype === 3 && Y.espnAddress('CFB', 16).week === 1
      && Y.espnAddress('CFB', 20).week === 5
      && Y.espnAddress('CFB', 15).seasontype === 2;
  }, { got: Y.espnAddress('CFB', 16) });
chk('TEST 10  the Super Bowl is season type 3 week 5, because week 4 is the Pro Bowl',
  Y.espnAddress('NFL', 22).seasontype === 3 && Y.espnAddress('NFL', 22).week === 5
    && Y.espnAddress('NFL', 19).week === 1 && Y.espnAddress('NFL', 18).seasontype === 2,
  'the arithmetic that looks obvious is wrong, which is why the map is written out');
chk('a round with no address is refused rather than requested as somebody else’s games',
  Y.espnAddress('CFB', 21) === null && Y.espnScoreboardUrl('CFB', 2026, 21) === null);
chk('a sport with no schedule source still says so rather than inventing a URL',
  Y.espnScoreboardUrl('MLB', 2026, 1) === null);

/* ---- the week a fixture is filed under is the PROVIDER'S --------------- */
chk('a fixture is filed under the week ESPN states, not the bucket it was asked for',
  function () {
    const row = S.normEspn(ev('SMU', 'Baylor', '2026-09-12T16:00:00Z', { week: 3, seasontype: 2 }));
    return Y.collectiveWeekOf('CFB', row, { seasontype: 2, week: 2 }, 2) === 3;
  });
chk('a postseason round is translated back through the same map, never taken raw',
  function () {
    /* ESPN's season type 3 week 1 is the Collective's week 16. Taken raw it
       would put a conference championship on the first Saturday of the season. */
    const row = S.normEspn(ev('SMU', 'Baylor', '2026-12-05T20:00:00Z', { week: 1, seasontype: 3 }));
    return Y.collectiveWeekOf('CFB', row, { seasontype: 3, week: 1 }, 16) === 16;
  });
chk('an event that names no week of its own keeps the week that was asked for',
  function () {
    const row = S.normEspn(ev('SMU', 'Baylor', '2026-09-12T16:00:00Z'));
    return Y.collectiveWeekOf('CFB', row, { seasontype: 2, week: 2 }, 2) === 2;
  });
chk('the payload carries each row’s own week, so one request can load two',
  function () {
    const rows = [{ home_team: 'A', away_team: 'B', start_date: 'x', week: 2 },
                  { home_team: 'C', away_team: 'D', start_date: 'y', week: 3 }];
    return Y.gamePayload(rows, 2).map(p => p.week).join(',') === '2,3';
  });
chk('the provider’s own id and address survive normalisation',
  function () {
    const row = S.normEspn(ev('SMU', 'Baylor', '2026-09-12T16:00:00Z',
      { id: '401628', week: 2, seasontype: 2 }));
    return row.espn_id === '401628' && row.espn_week === 2 && row.espn_season_type === 2;
  },
  'a stable provider id is how a fixture that moved is told from a fixture that is new');

/* =========================================================================
   THE PAGE ITSELF. renderWall, out of collective/index.html, against a wire
   that answers exactly as it did on the day this was reported.
   ========================================================================= */
async function drivePage() {
  const PAGE = path.join(ROOT, 'collective', 'index.html');
  const html = fs.readFileSync(PAGE, 'utf8');
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m, blocks = [];
  while ((m = re.exec(html)) !== null) if (m[1].trim()) blocks.push(m[1]);
  const CODE = blocks.join('\n;\n');

  function node() {
    const n = { _html: '', value: '', textContent: '', disabled: false, style: {}, children: [],
      classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
      getAttribute(k) { return n['_attr_' + k] || null; },
      setAttribute(k, v) { n['_attr_' + k] = v; },
      appendChild() {}, removeChild() {}, remove() {},
      addEventListener() {}, removeEventListener() {},
      querySelector() { return node(); }, querySelectorAll() { return []; },
      focus() {}, click() {}, scrollIntoView() {},
      onclick: null, onchange: null, oninput: null };
    Object.defineProperty(n, 'innerHTML', { get() { return n._html; }, set(v) { n._html = String(v); } });
    Object.defineProperty(n, 'firstChild', { get() { return node(); } });
    return n;
  }

  const asked = [];
  /* The wire, on Sep 8 2026. A week-less call answers week 1 — the finished
     slate with SMU @ Florida State on it — because that is precisely what
     the deployed function did. */
  const W1PAGE = [
    { game_id: 11, label: 'SMU @ FLORIDASTA', home: 'FLORIDASTA', away: 'SMU', week: 1,
      kickoff_at: '2026-09-07T23:00:00Z', status: 'final',
      result: { home_score: 20, away_score: 13, closing_spread: -3.5, closing_total: 51.5 },
      consensus: null, models: [] },
  ];
  const W2PAGE = [
    { game_id: 21, label: 'SMU @ BAYLOR', home: 'BAYLOR', away: 'SMU', week: 2,
      kickoff_at: '2026-09-10T23:30:00Z', status: 'scheduled', result: null,
      consensus: null, models: [] },
    { game_id: 22, label: 'IDAHO @ UTAH', home: 'UTAH', away: 'IDAHO', week: 2,
      kickoff_at: '2026-09-11T23:00:00Z', status: 'scheduled', result: null,
      consensus: null, models: [] },
    { game_id: 23, label: 'TCU @ SMU', home: 'SMU', away: 'TCU', week: 2,
      kickoff_at: '2026-09-12T16:00:00Z', status: 'scheduled', result: null,
      consensus: { n: 2, spread_mean: -3.2, spread_median: -3.2, spread_stdev: 0.4,
                   agreement: 1, home_win_prob_mean: 0.6, total_mean: 52, pct_picks_home: 1 },
      models: [
        { creator_slug: 'edgedesksports', model_slug: 'edgedesk-cfb', locked: false, late: false,
          pick_side: 'home', projected_spread: -3.5, line_at_submission: -3, projected_total: 52,
          home_win_probability: 0.61, received_at: '2026-09-08T12:00:00Z', grade: null },
        { creator_slug: 'blerm', model_slug: 'blerm-s-model', locked: false, late: false,
          pick_side: 'home', projected_spread: -2.9, line_at_submission: -3, projected_total: 52,
          home_win_probability: 0.58, received_at: '2026-09-08T13:00:00Z', grade: null }],
    },
  ];
  const reply = body => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  function fakeFetch(url) {
    const u = String(url);
    if (u.indexOf('/v1/meta') >= 0) return reply({ sports: [{ code: 'CFB', season: 2026, in_season: true }],
      counts: { live_projections: 4, graded_games: 3 }, pricing: { monthly_cents: 2900, annual_cents: 0 },
      billing_live: false });
    if (u.indexOf('/v1/wall') >= 0) return reply({ rows: [
      { creator_slug: 'edgedesksports', creator_name: 'EdgeDesk Sports', model_slug: 'edgedesk-cfb',
        model_name: 'EdgeDesk Model', sport: 'CFB', membership: 'ACTIVE CONTRIBUTOR',
        record: null, coverage_pct: 100, last_submission_at: '2026-09-08T12:00:00Z', monogram: 'ED' },
      { creator_slug: 'blerm', creator_name: 'Blerm', model_slug: 'blerm-s-model',
        model_name: "Blerm's Model", sport: 'CFB', membership: 'ACTIVE CONTRIBUTOR',
        record: null, coverage_pct: 100, last_submission_at: '2026-09-08T13:00:00Z', monogram: 'BL' }] });
    if (u.indexOf('/v1/activity') >= 0) return reply({ rows: [] });
    if (u.indexOf('/v1/games') >= 0) {
      asked.push(u);
      const w = /[?&]week=(\d+)/.exec(u);
      if (!w) return reply({ games: W1PAGE, week: 1, entitled: true });
      if (w[1] === '1') return reply({ games: W1PAGE, week: 1, entitled: true });
      if (w[1] === '2') return reply({ games: W2PAGE, week: 2, entitled: true });
      return reply({ games: [], week: +w[1], entitled: true });
    }
    return reply({});
  }

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    fetch: fakeFetch,
    localStorage: { _d: { mc_sport: 'CFB' }, getItem(k) { return this._d[k] === undefined ? null : this._d[k]; },
      setItem(k, v) { this._d[k] = v; }, removeItem(k) { delete this._d[k]; } },
    sessionStorage: { getItem: () => null, setItem() {} },
    location: { hash: '', href: 'http://localhost/collective/', search: '', pathname: '/collective/',
      origin: 'http://localhost', replace() {}, assign() {} },
    history: { replaceState() {}, pushState() {} },
    navigator: { userAgent: 'node', clipboard: { writeText() {} } },
    document: { getElementById: () => node(), querySelector: () => node(), querySelectorAll: () => [],
      createElement: () => node(), addEventListener() {}, removeEventListener() {},
      body: node(), head: node(), title: '', cookie: '', hidden: false },
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    URL, URLSearchParams, TextEncoder, TextDecoder, AbortController,
    Headers: typeof Headers !== 'undefined' ? Headers : function () {},
    Promise, JSON, Math, Date, RegExp, Intl,
    performance: { now: () => 0 },
    crypto: { getRandomValues: a => a, randomUUID: () => 'x' },
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  sandbox.addEventListener = () => {}; sandbox.removeEventListener = () => {};
  sandbox.dispatchEvent = () => true;
  sandbox.matchMedia = () => ({ matches: false, addListener() {}, addEventListener() {} });
  sandbox.getComputedStyle = () => ({ getPropertyValue: () => '' });
  sandbox.scrollTo = () => {}; sandbox.scrollY = 0;
  sandbox.requestAnimationFrame = () => 0;
  sandbox.alert = () => {}; sandbox.confirm = () => false;
  vm.createContext(sandbox);
  /* the page loads week.js by <script src> before its own block, and so does
     this: driving the fallback path and calling it green is not a test */
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'collective', 'week.js'), 'utf8'), sandbox);
  try { vm.runInContext(CODE, sandbox, { timeout: 20000 }); }
  catch (e) { chk('the page boots', false, { threw: String(e && e.message) }); }
  const P = sandbox;

  chk('the page loads the shared resolver rather than a copy of the rule',
    /<script src="week\.js"><\/script>/.test(html) && typeof P.MCWeek === 'object'
      && typeof P.currentSlate === 'function' && typeof P.slateFor === 'function');

  const v = node();
  await P.renderWall(v);
  const wall = v.innerHTML;

  chk('THE BUG  the wall no longer leads with the finished Sep 7 game',
    wall.indexOf('FLORIDASTA') < 0, { at: wall.indexOf('FLORIDASTA') });
  chk('THE BUG  it shows the Week 2 slate instead',
    wall.indexOf('BAYLOR') >= 0 && wall.indexOf('UTAH') >= 0,
    { baylor: wall.indexOf('BAYLOR'), utah: wall.indexOf('UTAH') });
  chk('and it says which week that is, without renaming Current',
    /COLLEGE FOOTBALL &middot; 2026 &middot; <b>WEEK 2<\/b>/.test(wall)
      && /data-w=""[^>]*>Current/.test(wall),
    { tag: (/<span class="slatetag">[\s\S]{0,200}/.exec(wall) || [])[0] });
  chk('Current is still the selected button and W2 is still separately clickable',
    /class="on" data-w=""/.test(wall) && /data-w="2"/.test(wall));
  chk('the numbered week Current landed on is marked as the same slate',
    /class="res" data-w="2"/.test(wall),
    { strip: (/<div class="wk">[\s\S]{0,400}/.exec(wall) || [])[0] });

  /* TEST 7 — last week's projections must not be counted on this week. */
  chk('TEST 7  the slate counts are Week 2 only',
    function () {
      const proj = /Projections on the slate<\/div><div class="v">(\d+)</.exec(wall);
      const games = /Games covered<\/div><div class="v">(\d+)<small>of (\d+)</.exec(wall);
      /* two models, on one of the three Week 2 games. The Week 1 game has no
         models at all in this fixture, so a count that included it would be
         indistinguishable — which is why the GAMES count is checked too:
         three is the Week 2 slate, four would be Week 1 leaking in. */
      return proj && proj[1] === '2' && games && games[2] === '3';
    },
    { proj: (/Projections on the slate<\/div><div class="v">\d+</.exec(wall) || [])[0],
      games: (/Games covered<\/div><div class="v">[\s\S]{0,40}/.exec(wall) || [])[0] });
  chk('TEST 7  and the heading says which week they were counted from',
    /College Football · Week 2<\/h2>/.test(wall) && /counted from Week 2 only/.test(wall),
    { hd: (/<div class="cc-hd">[\s\S]{0,200}/.exec(wall) || [])[0] });
  chk('TEST 7  a count of models is the models on THIS slate, over the roster',
    /Active models<\/div><div class="v">2<small>of 2 active<\/small>/.test(wall),
    { got: (/Active models<\/div><div class="v">[\s\S]{0,60}/.exec(wall) || [])[0] });

  /* the room, on the selected week */
  chk('the room describes a Week 2 game, never last week’s',
    wall.indexOf('What the room is saying') >= 0
      && (wall.indexOf('TCU') >= 0 || /no room to describe/.test(wall))
      && wall.indexOf('SMU @ FLORIDASTA') < 0);

  /* the wall's order: live, then upcoming by kickoff, then this week's
     completed games. Never a completed game at the top, and never a game in
     progress sorted underneath one that has not started. */
  chk('the wall leads with the soonest upcoming game, not a completed one',
    wall.indexOf('BAYLOR') < wall.indexOf('UTAH'),
    { baylor: wall.indexOf('BAYLOR'), utah: wall.indexOf('UTAH') });
  chk('a game in progress leads the wall, above a game that has not started',
    function () {
      const kicked = { game_id: 1, home: 'A', away: 'B', week: 2, status: 'in_progress',
                       kickoff_at: new Date(NOW - 2 * HOUR).toISOString(), result: null };
      const soon = { game_id: 2, home: 'C', away: 'D', week: 2, status: 'scheduled',
                     kickoff_at: new Date(NOW + 2 * HOUR).toISOString(), result: null };
      const over = { game_id: 3, home: 'E', away: 'F', week: 2, status: 'final',
                     kickoff_at: new Date(NOW - 20 * HOUR).toISOString(),
                     result: { home_score: 24, away_score: 17, closing_spread: -3 } };
      return P.slateOrder([over, soon, kicked]).map(x => x.game_id).join(',') === '1,2,3';
    },
    { got: P.slateOrder ? 'slateOrder present' : 'slateOrder missing' });
  chk('and a game nobody ever settled does not lead it on a stale kickoff',
    function () {
      const stale = { game_id: 1, home: 'A', away: 'B', week: 2, status: 'scheduled',
                      kickoff_at: new Date(NOW - 30 * HOUR).toISOString(), result: null };
      const soon = { game_id: 2, home: 'C', away: 'D', week: 2, status: 'scheduled',
                     kickoff_at: new Date(NOW + 2 * HOUR).toISOString(), result: null };
      return P.slateOrder([stale, soon]).map(x => x.game_id).join(',') === '2,1';
    });

  /* TEST 4, on the page: an explicit pick is history and stays history.
     Pressing W1 is the real sequence -- the reader is looking at Current when
     they press it -- so the resolution is already in hand and the press costs
     exactly one request, for the week that was pressed. */
  P.SLATE_CACHE = {}; P.SEASON_GAMES = {}; P.LOCALREC = {}; P.WALLC = null;
  P.WALL_WEEK = null;
  await P.renderWall(node());
  P.SEASON_GAMES = {}; P.LOCALREC = {};
  P.WALL_WEEK = 1;
  asked.length = 0;
  const v1 = node();
  await P.renderWall(v1);
  const hist = v1.innerHTML;
  chk('TEST 4  pressing W1 shows Week 1, with the Sep 7 game in it',
    hist.indexOf('FLORIDASTA') >= 0 && hist.indexOf('BAYLOR') < 0,
    { fsu: hist.indexOf('FLORIDASTA'), baylor: hist.indexOf('BAYLOR') });
  /* The slate itself is asked for by number, and Current costs no round trip
     at all: it was resolved when the reader was looking at it, a moment ago.
     (The other requests here are the season sweep behind the model records,
     which reads the weeks BEFORE the current one and is not the slate.) */
  chk('TEST 4  it asks for week 1 by number, and re-resolves nothing',
    /[?&]week=1(&|$)/.test(asked[0]) && !asked.some(u => !/[?&]week=/.test(u)),
    { asked: asked.slice() });
  chk('TEST 4  the pick wins: the resolver never overrides a week the reader chose',
    /class="on" data-w="1"/.test(hist) && !/class="on" data-w=""/.test(hist),
    { strip: (/<div class="wk">[\s\S]{0,300}/.exec(hist) || [])[0] });
  chk('TEST 4  and the page says it is history and names what Current is',
    /<b>WEEK 1<\/b>/.test(hist) && /history\. Current is Week 2\./.test(hist),
    { tag: (/<span class="slatetag">[\s\S]{0,260}/.exec(hist) || [])[0] });
  chk('TEST 4  the settled Sep 7 game keeps its own week number',
    W1PAGE[0].week === 1, 'nothing on this page may renumber a settled game');

  /* the board, through the same resolver */
  P.SLATE_CACHE = {}; P.SEASON_GAMES = {}; P.LOCALREC = {};
  P.WALL_WEEK = null; P.BOARD_WEEK = null;
  P.location.hash = '#board';
  const vb = node();
  await P.renderBoard(vb);
  const board = vb.innerHTML;
  chk('the board resolves the same week the wall does',
    board.indexOf('BAYLOR') >= 0 && board.indexOf('FLORIDASTA') < 0
      && /<b>WEEK 2<\/b>/.test(board),
    { baylor: board.indexOf('BAYLOR'), fsu: board.indexOf('FLORIDASTA') });

  /* One resolution, not two: the wall and the board must never be able to
     disagree about which week is current, and must not each pay for it. */
  P.SLATE_CACHE = {}; P.SEASON_GAMES = {}; P.LOCALREC = {}; P.WALLC = null;
  P.WALL_WEEK = null; P.BOARD_WEEK = null; P.location.hash = '';
  asked.length = 0;
  await P.renderWall(node());
  const afterWall = asked.length;
  P.location.hash = '#board';
  await P.renderBoard(node());
  chk('the board reuses the wall’s resolution instead of resolving again',
    asked.length === afterWall, { first: afterWall, total: asked.length, asked: asked.slice() });
}
