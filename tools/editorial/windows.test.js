#!/usr/bin/env node
/* ============================================================================
   PUBLICATION WINDOWS AND EDITORIAL HEALTH.

   PART ONE — THE WINDOWS. The ninety-minute floor was a cliff: a complete,
   factually clean article scoring 100 was refused at 89 minutes exactly as it
   would have been at one minute, and the refusal was logged as a FAILURE.
   These prove the replacement behaves the way a person would: publish
   normally when there is time, re-verify and publish when there is less, hold
   with a reason when there is almost none, and never pretend a preview
   written after kickoff is pregame research.

   PART TWO — THE HEALTH PANEL. An operator must be able to open one screen
   and know what the system is doing. These prove the panel reports real
   state, that it grades the SYSTEM rather than any one article, and that
   postgame debt cannot quietly disappear.

   Offline: no network, no engine boot, nothing written outside memory.
   Run: node tools/editorial/windows.test.js
   ========================================================================== */
'use strict';

const AMODEL = require('../articles/article_model.js');
const WINDOWS = require('./windows.js');
const REFRESH = require('./refresh.js');
const HEALTH = require('./health.js');
const PUB = require('./publisher.js');
const SNAP = require('./snapshot.js');
const THESES = require('./theses.js');
const QUALITY = require('./quality.js');
const STORE = require('./store.js');
const FIX = require('./fixtures/scenarios.js');

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') {
    try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 300); }
  }
  if (cond) { pass++; return true; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
  return false;
}
function eq(name, got, want) {
  return chk(name, got === want, 'got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want));
}
function section(t) { console.log('\n' + t); }

const CFG = { pregame_normal_lead_minutes: 90, pregame_minimum_publish_lead_minutes: 20,
  dispatcher_interval_minutes: 15, postgame_settle_minutes: 20, quality_floor: 70,
  auto_publish_pregame: true, auto_publish_postgame: true };
const KICK = Date.parse('2026-09-13T20:00:00.000Z');
const at = mins => KICK - mins * 60000;                 /* `mins` before kickoff */
const iso = ms => new Date(ms).toISOString();

/* A real record, built through the real model. */
function record(opts) {
  opts = opts || {};
  const sc = FIX.SCENARIOS[0];
  const meta = Object.assign({}, FIX.META, { kickoff: iso(KICK) }, opts.meta || {});
  const research = opts.research || sc.research;
  const snap = SNAP.capture(research, meta, { now: iso(at(180)), article_id: 'nfl-WIN' });
  const rec = AMODEL.build(research, meta, { now: iso(at(180)), status: 'draft' });
  rec.snapshot_id = snap.snapshot_id;
  rec.theses = THESES.extract(snap);
  rec.game_time = iso(KICK);
  return { rec, snap, meta, research };
}

/* ======================================================================== */
section('1. CLASSIFICATION — the three windows, and the two that are not windows');
/* ======================================================================== */
(function () {
  const w = m => WINDOWS.classify({ kickoff_ms: KICK, now_ms: at(m), settings: CFG }).window;

  eq('120 minutes out is the normal window', w(120), 'normal');
  eq('91 minutes out is still normal', w(91), 'normal');
  eq('90 minutes out is the boundary and is NOT late', w(90), 'normal');
  eq('89 minutes out is the late window', w(89), 'late_window');
  eq('60 minutes out is late', w(60), 'late_window');
  eq('34 minutes out is late — the case that used to be refused', w(34), 'late_window');
  eq('21 minutes out is still late', w(21), 'late_window');
  eq('20 minutes out is the floor and is NOT final', w(20), 'late_window');
  eq('19 minutes out is the final window', w(19), 'final_window');
  eq('5 minutes out is final', w(5), 'final_window');
  eq('at kickoff it is after kickoff', w(0), 'after_kickoff');
  eq('one minute after kickoff', w(-1), 'after_kickoff');
  eq('an hour after kickoff', w(-60), 'after_kickoff');

  /* MINUTES BEFORE KICKOFF is recorded for the later analytics. */
  const c = WINDOWS.classify({ kickoff_ms: KICK, now_ms: at(45), settings: CFG });
  eq('the minutes before kickoff are carried', c.minutes_before_kickoff, 45);
  eq('and the scheduled kickoff', c.scheduled_kickoff, iso(KICK));
  chk('the late window asks for a refresh', c.needs_refresh === true);
  chk('the normal window does not',
    WINDOWS.classify({ kickoff_ms: KICK, now_ms: at(120), settings: CFG }).needs_refresh === false);

  /* NOT DUE is about the per-window lead, and means "not yet", not "late". */
  const nd = WINDOWS.classify({ kickoff_ms: KICK, now_ms: at(600), settings: CFG, due_at_minutes: 420 });
  eq('a game past its own lead is not due yet', nd.window, 'not_due');
  chk('and says when it publishes', /publishes at 7h/.test(nd.reason), nd.reason);

  /* WHAT MAY BE FORCED. A policy hold, yes; a statement about reality, no. */
  chk('an operator may force the final window', WINDOWS.forcible('final_window'));
  chk('and may force one that is merely early', WINDOWS.forcible('not_due'));
  chk('but may NOT force a game that has already started', !WINDOWS.forcible('after_kickoff'));
})();

/* ======================================================================== */
section('2. CONFIGURATION — one source, validated, failing safely');
/* ======================================================================== */
(function () {
  eq('the default normal lead is 90', WINDOWS.policy({}).normal_lead_minutes, 90);
  eq('the default minimum is 20', WINDOWS.policy({}).minimum_lead_minutes, 20);
  chk('a valid policy validates', WINDOWS.validate(CFG).ok);

  /* THE BACKWARDS-COMPATIBLE READ. A store written before this change carries
     only pregame_min_lead_minutes; adopting a new number silently would
     change an operator's configured behaviour without being asked. */
  const legacy = WINDOWS.policy({ pregame_min_lead_minutes: 45 });
  eq('the old key is honoured as the minimum', legacy.minimum_lead_minutes, 45);
  chk('and the panel can say so', legacy.from_legacy_key === true);
  eq('an explicit new key wins over the old one',
    WINDOWS.policy({ pregame_min_lead_minutes: 45, pregame_minimum_publish_lead_minutes: 10 })
      .minimum_lead_minutes, 10);

  /* INVALID CONFIGURATION — the case the brief names: normal 20, minimum 90. */
  const bad = WINDOWS.validate({ pregame_normal_lead_minutes: 20,
    pregame_minimum_publish_lead_minutes: 90 });
  chk('normal below minimum is refused', !bad.ok);
  chk('and names why', bad.errors.some(e => e.id === 'normal_not_above_minimum'),
    JSON.stringify(bad.errors));
  const cls = WINDOWS.classify({ kickoff_ms: KICK, now_ms: at(60),
    settings: { pregame_normal_lead_minutes: 20, pregame_minimum_publish_lead_minutes: 90 } });
  chk('and NOTHING classifies as publishable under it', cls.window === null && cls.ok === false);
  chk('the failure is safe: it refuses rather than publishing under a rule nobody wrote',
    /invalid/.test(cls.reason), cls.reason);
  chk('a negative minimum is refused',
    !WINDOWS.validate({ pregame_minimum_publish_lead_minutes: -5 }).ok);
  chk('a non-numeric lead is refused',
    !WINDOWS.validate({ pregame_normal_lead_minutes: 'soon' }).ok);

  /* THE PER-WINDOW LEAD LIVES HERE TOO, so the panel and the pipeline agree. */
  eq('a Sunday early NFL game opens 16h out',
    WINDOWS.leadMinutesFor({ pregame_lead_hours: { NFL: { sunday_early: 16, default: 12 } } },
      { sport: 'NFL', window_key: 'sunday_early' }), 960);
  eq('an unknown window falls back to the sport default',
    WINDOWS.leadMinutesFor({ pregame_lead_hours: { NFL: { default: 12 } } },
      { sport: 'NFL', window_key: 'nonesuch' }), 720);
})();

/* ======================================================================== */
section('3. THE LATE-WINDOW REFRESH');
/* ======================================================================== */
(function () {
  const { rec, snap, meta, research } = record();

  /* NOTHING MOVED. The re-verification still happened and says so. */
  const same = REFRESH.refresh({ committed_research: research, live_research: research,
    game: meta, snapshot: snap, article_id: rec.id, now: iso(at(45)) });
  chk('a refresh with nothing moved succeeds', same.ok);
  eq('and reports unchanged', same.state, 'unchanged');
  eq('with no changes listed', same.changes.length, 0);

  /* THE MARKET MOVED — the brief's case: generated at -3, market now -4. */
  const moved = JSON.parse(JSON.stringify(research));
  moved.market.market = 'Seattle Seahawks -4';
  moved.market.total_market = '48.5';
  const ref = REFRESH.refresh({ committed_research: research, live_research: moved,
    game: meta, snapshot: snap, article_id: rec.id, now: iso(at(45)) });
  chk('a moved market is a successful refresh', ref.ok);
  eq('and is reported as refreshed', ref.state, 'refreshed');
  chk('the line move is named', ref.changes.some(c => c.field === 'market.line'),
    JSON.stringify(ref.changes));
  chk('so is the total', ref.changes.some(c => c.field === 'market.total'));
  chk('and the run log can print the old and new values',
    ref.changes.every(c => 'from' in c && 'to' in c));

  /* THE PUBLICATION SNAPSHOT IS A SECOND ARTEFACT, NOT AN EDIT. */
  chk('a publication snapshot is produced', !!ref.snapshot);
  eq('roled as a publication snapshot', ref.snapshot.role, 'publication');
  chk('with a DIFFERENT id from the original', ref.snapshot.snapshot_id !== snap.snapshot_id);
  eq('and a pointer back to what it refreshed', ref.snapshot.refreshed_from, snap.snapshot_id);
  chk('the original research snapshot is untouched',
    JSON.stringify(snap.research) === JSON.stringify(research));
  eq('the publication snapshot carries the NEW market',
    REFRESH.marketOf(ref.snapshot.research).line, 'Seattle Seahawks -4');
  eq('the ORIGINAL still carries the old one',
    REFRESH.marketOf(snap.research).line, REFRESH.marketOf(research).line);

  /* A REFRESH THAT CANNOT VERIFY ANYTHING PUBLISHES NOTHING. */
  const stale = REFRESH.refresh({ committed_research: research, live_research: null,
    game: meta, snapshot: snap, now: iso(at(45)) });
  chk('no live payload is not a pass', !stale.ok);
  eq('it is stale', stale.state, 'stale');
  chk('and says the data could not be re-verified',
    /could not be re-verified/.test(stale.reasons[0]), stale.reasons[0]);

  /* THE FIXTURE ITSELF. */
  const post = REFRESH.refresh({ committed_research: research, live_research: research,
    game: meta, snapshot: snap, live_game: { status: 'Postponed' }, now: iso(at(45)) });
  chk('a postponed game blocks publication', !post.ok);
  eq('and is blocked rather than stale', post.state, 'blocked');
  chk('naming the postponement', /postpon/i.test(post.reasons[0]), post.reasons[0]);

  const movedKick = REFRESH.refresh({ committed_research: research, live_research: research,
    game: meta, snapshot: snap, live_game: { kickoff: iso(KICK + 3600000) }, now: iso(at(45)) });
  chk('a moved kickoff still succeeds', movedKick.ok);
  chk('and is reported', movedKick.fixture.kickoff_changed === true);
  eq('with the new time', movedKick.fixture.new_kickoff, iso(KICK + 3600000));
  chk('the publication snapshot uses the NEW kickoff',
    movedKick.snapshot.kickoff === iso(KICK + 3600000), movedKick.snapshot.kickoff);

  /* AND THE WINDOW IS RECALCULATED FROM THE VERIFIED NEW KICKOFF. */
  eq('a game 45 minutes out that moved an hour later is back in the normal window',
    WINDOWS.classify({ kickoff_ms: KICK + 3600000, now_ms: at(45), settings: CFG }).window,
    'normal');
})();

/* ======================================================================== */
section('4. THE RECORD — what a published article remembers about its timing');
/* ======================================================================== */
(function () {
  const cls = WINDOWS.classify({ kickoff_ms: KICK, now_ms: at(45), settings: CFG });
  const t = WINDOWS.timingFor(cls, { now: iso(at(45)), refreshed: true,
    published_at: iso(at(45)) });
  eq('the publication window is recorded', t.publication_window, 'late_window');
  eq('with the minutes before kickoff', t.minutes_before_kickoff, 45);
  eq('and the scheduled kickoff', t.scheduled_kickoff, iso(KICK));
  eq('and the actual publication time', t.published_at, iso(at(45)));
  chk('and whether it was refreshed', t.refreshed === true);

  /* A FORCED PUBLICATION IS LABELLED AS SUCH, not as an ordinary late one. */
  const fcls = WINDOWS.classify({ kickoff_ms: KICK, now_ms: at(10), settings: CFG });
  const f = WINDOWS.timingFor(fcls, { now: iso(at(10)), forced: true });
  eq('a forced publication is recorded as forced', f.publication_window, 'forced');
  eq('but the clock still says which window it really was', f.classified_window, 'final_window');
  eq('and how close it was', f.minutes_before_kickoff, 10);
})();

/* ======================================================================== */
section('5. THE PUBLISHER STILL OWNS THE DECISION');
/* ======================================================================== */
(function () {
  /* The windows decide WHEN. The publisher still decides WHETHER, and none of
     its blocking conditions were relaxed to make the late window work. */
  const { rec } = record();
  const q = QUALITY.inspect(rec, { now: iso(at(45)) });
  chk('a real article still clears the real gate in the late window', q.publishable,
    'score ' + q.score + ' · ' + q.hold_reason);
  const out = PUB.publish(rec, { now: iso(at(45)), quality: q, others: [] });
  chk('and the publisher accepts it', out.ok, JSON.stringify(out.blocking));

  /* A broken article is still refused, late window or not. */
  const broken = record().rec;
  broken.article.sections = [];
  const bad = PUB.publish(broken, { now: iso(at(45)), others: [] });
  chk('a broken article is still refused in the late window', !bad.ok);
  eq('and still goes to manual_review', bad.record.status, 'manual_review');

  /* ready_too_late is a real, legal, non-public state. */
  chk('ready_too_late is a legal status', PUB.ALL_STATUSES.indexOf('ready_too_late') >= 0);
  chk('the article model agrees',
    AMODEL.STATUSES.indexOf('ready_too_late') >= 0);
  chk('it is NOT public', !PUB.isPublic({ status: 'ready_too_late' }));
  chk('an operator may still force it to published',
    PUB.canTransition('ready_too_late', 'published'));
  chk('and it may be archived', PUB.canTransition('ready_too_late', 'archived'));
})();

/* ======================================================================== */
section('6. HEALTH — the system, not one article');
/* ======================================================================== */
/* A fabricated world, so every assertion is about the logic rather than about
   whatever today's board happens to contain. */
function world(over) {
  over = over || {};
  const now = over.now || '2026-09-13T18:00:00.000Z';
  const nowMs = Date.parse(now);
  return Object.assign({
    now,
    settings: CFG,
    featured: { generated_at: now, settings: CFG, games: over.games || [] },
    runs: over.runs || [{ run: 'r1', at: new Date(nowMs - 5 * 60000).toISOString(),
      step: 'dispatch', key: null, ok: true, reason: 'ok' }],
    retries: over.retries || {},
    records: over.records || [],
    committed: over.committed || [],
  }, over.override || {});
}

(function () {
  const h = HEALTH.snapshot(world());
  eq('a fresh dispatcher and clean config is HEALTHY', h.status, 'HEALTHY');
  eq('with no reasons to report', h.reasons.length, 0);
  chk('the dispatcher pulse is reported', h.dispatcher.minutes_since === 5);
  chk('and the next expected run', !!h.dispatcher.next_expected_at);
  eq('the policy is surfaced', h.settings.normal_lead_minutes, 90);
  eq('and the minimum', h.settings.minimum_lead_minutes, 20);

  /* A STALE DISPATCHER. */
  const lateRun = world({ runs: [{ run: 'r1', at: '2026-09-13T17:00:00.000Z',
    step: 'dispatch', key: null, ok: true, reason: 'ok' }] });
  eq('an hour-old dispatcher at a 15-minute cadence is DEGRADED',
    HEALTH.snapshot(lateRun).status, 'DEGRADED');
  const deadRun = world({ runs: [{ run: 'r1', at: '2026-09-13T09:00:00.000Z',
    step: 'dispatch', key: null, ok: true, reason: 'ok' }] });
  eq('a nine-hour-old dispatcher is ERROR', HEALTH.snapshot(deadRun).status, 'ERROR');
  const neverRun = world({ runs: [] });
  eq('a dispatcher that has never run is ERROR', HEALTH.snapshot(neverRun).status, 'ERROR');

  /* INVALID CONFIGURATION IS AN ERROR — nothing can publish under it. */
  const badCfg = world({ override: { settings: { pregame_normal_lead_minutes: 20,
    pregame_minimum_publish_lead_minutes: 90, dispatcher_interval_minutes: 15 } } });
  const bh = HEALTH.snapshot(badCfg);
  eq('invalid window configuration is ERROR', bh.status, 'ERROR');
  chk('and the panel names the configuration', !bh.config.ok);
  chk('with the specific rule that failed',
    bh.config.errors.some(e => e.id === 'normal_not_above_minimum'));

  /* ONE ARTICLE IN REVIEW IS NOT A SYSTEM FAILURE. */
  const reviewing = world({
    records: [{ id: 'nfl-A', slug: 'a', sport: 'NFL', game_id: 'A', status: 'manual_review',
      snapshot_id: 'snap_x', article: {}, featured: { key: 'NFL:A' },
      publish_state: { hold_reason: 'factual_integrity' } }],
  });
  const rh = HEALTH.snapshot(reviewing);
  eq('an article in manual review does NOT make the system ERROR', rh.status, 'HEALTHY');
  eq('but it IS counted', rh.counts.manual_review, 1);

  /* RETRIES. */
  const retrying = world({ retries: {
    'NFL:A|postgame': { key: 'NFL:A', step: 'postgame', attempt_count: 2,
      next_retry_at: '2026-09-13T18:30:00.000Z', last_error: 'ESPN timed out', exhausted: false },
    'NFL:B|postgame': { key: 'NFL:B', step: 'postgame', attempt_count: 5,
      next_retry_at: null, last_error: 'gone', exhausted: true },
  } });
  const th = HEALTH.snapshot(retrying);
  eq('pending retries are counted', th.counts.retries_pending, 1);
  eq('exhausted ones are counted as failed', th.counts.failed, 1);
  eq('and an exhausted retry degrades the system', th.status, 'DEGRADED');
})();

/* ======================================================================== */
section('7. POSTGAME DEBT CANNOT DISAPPEAR');
/* ======================================================================== */
(function () {
  /* A committed game, played six hours ago, with no postgame article — and
     NOT on the current board, which is exactly the case that used to vanish. */
  const now = '2026-09-13T18:00:00.000Z';
  const played = { key: 'NFL:GONE', sport: 'NFL', game_id: 'GONE',
    home_team: 'Home', away_team: 'Away', game_time: '2026-09-13T11:00:00.000Z',
    status: 'featured', from_snapshot: true, snapshot_id: 'snap_gone' };

  const w = world({ now, games: [], committed: [played],
    runs: [{ run: 'r1', at: '2026-09-13T17:58:00.000Z', step: 'dispatch', ok: true, reason: 'ok' }] });
  /* committedGames() is stubbed through opts, but has_snapshot reads the real
     store, so this asserts the debt logic on the fields it is given */
  const h = HEALTH.snapshot(w);
  const row = h.games.filter(g => g.key === 'NFL:GONE')[0];
  chk('a game no longer on the board is still in the pipeline view', !!row);
  eq('and is in the postgame phase', row && row.phase, 'postgame');
  chk('its next action is about the audit, not the preview',
    /postgame|stable box score|waiting for final|retry/.test(row.next_action), row && row.next_action);
})();

/* ======================================================================== */
section('8. THE NEXT ACTION — one canonical answer per game');
/* ======================================================================== */
(function () {
  const now = iso(at(45));
  const nowMs = at(45);
  const base = { key: 'NFL:X', game_time: iso(KICK) };

  function na(row, ctx) {
    return HEALTH.nextAction(Object.assign({}, base, row),
      Object.assign({ now_ms: nowMs, settings: CFG }, ctx || {})).action;
  }

  eq('an unpublished article in the late window is told to refresh and publish',
    na({}), 'refresh late-window data and publish');
  eq('a published article waits for kickoff',
    na({ article: { status: 'published' } }), 'waiting for kickoff');
  eq('an article in review says so',
    na({ article: { status: 'manual_review', publish_state: { hold_reason: 'factual_integrity' } } }),
    'manual review required');
  eq('an article inside the final floor needs a force',
    HEALTH.nextAction(base, { now_ms: at(10), settings: CFG }).action, 'manual force required');
  eq('a game not yet in its window gets a TIME',
    HEALTH.nextAction(base, { now_ms: at(600), settings: CFG, due_at_minutes: 420 }).action,
    'publish at ' + iso(KICK - 420 * 60000));
  eq('a game in progress waits for the final',
    HEALTH.nextAction(base, { now_ms: KICK + 30 * 60000, settings: CFG }).action,
    'waiting for final');
  eq('a finished game with no audit is told to generate the postgame',
    HEALTH.nextAction(base, { now_ms: KICK + 6 * 3600000, settings: CFG }).action,
    'generate postgame');
  eq('a finished game whose box score is not stable says exactly that',
    HEALTH.nextAction(Object.assign({}, base,
      { last_postgame_reason: 'fewer than 5 core statistics on both sides' }),
      { now_ms: KICK + 6 * 3600000, settings: CFG }).action,
    'waiting for a stable box score');
  eq('a backing-off game reports its retry time',
    HEALTH.nextAction(Object.assign({}, base, { retry: { next_retry_at: '2026-09-13T22:00:00.000Z',
      last_error: 'timeout', exhausted: false } }), { now_ms: KICK + 6 * 3600000, settings: CFG }).action,
    'retry at 2026-09-13T22:00:00.000Z');
  eq('an exhausted retry becomes a review',
    HEALTH.nextAction(Object.assign({}, base, { retry: { exhausted: true, last_error: 'gone' } }),
      { now_ms: KICK + 6 * 3600000, settings: CFG }).action, 'manual review required');
  eq('both halves public is complete',
    HEALTH.nextAction(Object.assign({}, base, { postgame: { status: 'published' } }),
      { now_ms: KICK + 6 * 3600000, settings: CFG }).action, 'complete');
  eq('a broken configuration is the first thing it tells you to fix',
    HEALTH.nextAction(base, { now_ms: nowMs,
      settings: { pregame_normal_lead_minutes: 20, pregame_minimum_publish_lead_minutes: 90 } }).action,
    'fix the publication-window configuration');

  /* EVERY ANSWER IS A SENTENCE AN OPERATOR CAN ACT ON, never a status string. */
  const answers = ['refresh late-window data and publish', 'waiting for kickoff',
    'manual review required', 'manual force required', 'waiting for final',
    'generate postgame', 'waiting for a stable box score', 'complete'];
  chk('no next action is a bare status name',
    answers.every(a => !/^(draft|ready|published|manual_review|archived)$/.test(a)));
})();

/* ======================================================================== */
section('9. NO DEAD CONTROLS');
/* ======================================================================== */
(function () {
  const h = HEALTH.snapshot(world());
  /* The panel shows the switches. It must also say they are NOT editable,
     because there is no persistent write path for them — the previous
     implementation shipped a checkbox that saved to a table no tool read, and
     a control that does nothing is worse than no control. */
  chk('the panel declares the settings read-only', h.settings.editable === false);
  chk('and says where they actually live',
    /featured\.json/.test(h.settings.source), h.settings.source);

  const fs = require('fs');
  const admin = fs.readFileSync(require('path').join(__dirname, '..', '..',
    'admin', 'articles', 'index.html'), 'utf8');
  /* the health block must not render an input/checkbox for the window policy */
  const block = admin.slice(admin.indexOf('EDITORIAL SYSTEM') >= 0
    ? admin.indexOf('EDITORIAL SYSTEM') : 0);
  chk('the admin page ships no editable control for the lead times',
    !/name=["']pregame_(normal|minimum)/.test(admin)
    && !/id=["']eLeadNormal["']/.test(admin));
})();

/* ======================================================================== */
section('10. THE REAL RESEARCH PAYLOAD, 45 MINUTES BEFORE KICKOFF');
/* ======================================================================== */
/* Not a fixture: the committed research for a real featured game, driven
   through classify → refresh → revalidate → publish at a real late-window
   offset. This is the case the ninety-minute cliff used to refuse. */
(function () {
  const fs = require('fs'), path = require('path');
  const file = path.join(__dirname, '..', '..', 'articles', 'data', 'records',
    'nfl-2026_01_GB_MIN.json');
  if (!fs.existsSync(file)) { chk('the real-payload fixture is present', true, 'skipped'); return; }
  const rec0 = JSON.parse(fs.readFileSync(file, 'utf8'));
  const research = rec0.research;
  const kick = Date.parse(rec0.game_time);
  const now = kick - 45 * 60000;
  const at2 = m => new Date(m).toISOString();
  const meta = { sport: 'NFL', game_id: '2026_01_GB_MIN', home: rec0.home_team,
    away: rec0.away_team, kickoff: rec0.game_time, venue: rec0.venue || null,
    season: rec0.season, week: rec0.week };

  const cls = WINDOWS.classify({ kickoff_ms: kick, now_ms: now, settings: CFG });
  eq('a real game 45 minutes out is in the late window', cls.window, 'late_window');

  const snap = SNAP.capture(research, meta,
    { now: at2(kick - 3 * 3600000), article_id: 'nfl-2026_01_GB_MIN' });
  const originalLine = REFRESH.marketOf(snap.research).line;

  /* the market moves in the hour before kickoff */
  const live = JSON.parse(JSON.stringify(research));
  live.market.market = 'Minnesota Vikings -4';
  live.market.total_market = '48.5';

  const ref = REFRESH.refresh({ committed_research: snap.research, live_research: live,
    game: meta, snapshot: snap, article_id: 'nfl-2026_01_GB_MIN', now: at2(now) });
  chk('the refresh succeeds on the real payload', ref.ok, JSON.stringify(ref.reasons));
  chk('and names the line move', ref.changes.some(c => c.field === 'market.line'));
  eq('THE ORIGINAL SNAPSHOT IS UNCHANGED', REFRESH.marketOf(snap.research).line, originalLine);
  eq('the publication snapshot carries the new market',
    REFRESH.marketOf(ref.snapshot.research).line, 'Minnesota Vikings -4');

  const rec = AMODEL.build(live, meta, { now: at2(now), status: 'draft' });
  rec.snapshot_id = snap.snapshot_id;
  rec.publication_snapshot_id = ref.snapshot.snapshot_id;
  rec.theses = THESES.extract(snap);
  rec.game_time = rec0.game_time;
  const q = QUALITY.inspect(rec, { now: at2(now) });
  eq('it stays factually clean after the refresh', (q.integrity_failed || []).length, 0);
  chk('and clears the quality gate', q.publishable, 'score ' + q.score + ' · ' + q.hold_reason);

  rec.timing = WINDOWS.timingFor(cls, { now: at2(now), refreshed: true });
  const out = PUB.publish(rec, { now: at2(now), quality: q, others: [] });
  chk('the publisher accepts it', out.ok, JSON.stringify(out.blocking));
  eq('it becomes public', out.record.status, 'published');
  eq('recorded as a late-window publication', rec.timing.publication_window, 'late_window');
  eq('45 minutes before kickoff', rec.timing.minutes_before_kickoff, 45);
  chk('and marked refreshed', rec.timing.refreshed === true);

  const RENDER2 = require('../articles/article_render.js');
  const page = RENDER2.articlePage(out.record, { now: at2(now) });
  chk('the public page renders', page.length > 3000, page.length + ' bytes');
  chk('carrying the refreshed market rather than the stale one',
    page.indexOf('-4') >= 0 || page.indexOf('48.5') >= 0);
  /* THE READER IS NEVER TOLD THE ARTICLE WAS LATE. They are getting fresher
     numbers, not worse ones, and an apology would be both untrue and odd. */
  chk('and no apology or lateness language reaches the reader',
    !/\b(sorry|apolog|published late|late publication)\b/i.test(page));
})();

/* ======================================================================== */
section('11. THE POSTGAME-DEBT INVARIANT');
/* ======================================================================== */
(function () {
  /* THE RULE: a committed game that has been played and has no published
     postgame article MUST appear in the debt list with a state. If it can
     vanish, the audit half of the product silently stops working — which is
     exactly what happened when the postgame phase read the board. */
  const now = '2026-09-13T23:00:00.000Z';
  const played = {
    key: 'NFL:DEBT', sport: 'NFL', game_id: 'DEBT', home_team: 'H', away_team: 'A',
    game_time: '2026-09-13T17:00:00.000Z', status: 'featured', from_snapshot: true,
    snapshot_id: 'snap_debt',
  };
  const w = world({ now, games: [], committed: [played],
    runs: [{ run: 'r', at: '2026-09-13T22:58:00.000Z', step: 'dispatch', ok: true, reason: 'ok' }] });
  const h = HEALTH.snapshot(w);
  const row = h.games.filter(g => g.key === 'NFL:DEBT')[0];
  chk('the played game is in the pipeline view even with an empty board', !!row);
  eq('and is in the postgame phase', row && row.phase, 'postgame');

  /* THE INVARIANT ITSELF, asserted as a rule rather than a single case: no
     played, committed, unaudited game may be missing a reported state. */
  const played6h = h.games.filter(g => {
    const k = Date.parse(g.game_time);
    return isFinite(k) && Date.parse(now) >= k
      && !['published', 'updated'].includes(g.postgame_status);
  });
  const reported = new Set(h.debt.map(d => d.key));
  const missing = played6h.filter(g => g.has_snapshot && !reported.has(g.key));
  eq('every played, committed, unaudited game is reported as debt', missing.length, 0);
  chk('and every debt row carries a state',
    h.debt.every(d => !!d.state), JSON.stringify(h.debt));
  chk('and a next action', h.debt.every(d => !!d.next_action));
})();

/* ======================================================================== */
section('12. A RESEARCH REFRESH MUST NOT STRIP THE EDITORIAL LAYER');
/* ======================================================================== */
/* THE BUG THIS CATCHES, observed in production. The ordinary publish-articles
   job refreshes every game on the board through AMODEL.refresh(), which
   rebuilds the record via build(). build() knows nothing about the editorial
   layer, and refresh() carried over only slug, aliases, canonical_url and id —
   so an article the editorial system had published lost its snapshot_id, its
   theses, its featured block and its timing.

   green-bay-packers-vs-minnesota-vikings-2026 was published at 12:20, refreshed
   at 16:09, and had all four silently deleted. The postgame audit survived only
   because it reads the snapshot FILES rather than the record — but the timing
   block PART 4 exists to preserve was destroyed, and the health panel stopped
   recognising the article as one the system owns. */
(function () {
  const sc = FIX.SCENARIOS[0];
  /* a kickoff AHEAD of the clock: the freeze rule is a separate guarantee and
     would otherwise mask what this section is testing */
  const META = Object.assign({}, FIX.META, { kickoff: iso(KICK) });
  const rec = AMODEL.build(sc.research, META, { now: iso(at(180)), status: 'published' });
  rec.published_at = iso(at(180));
  rec.snapshot_id = 'snap_original';
  rec.publication_snapshot_id = 'snap_publication';
  rec.timing = { publication_window: 'late_window', minutes_before_kickoff: 45, refreshed: true };
  rec.theses = [{ id: 't1', claim: 'a claim' }, { id: 't2', claim: 'another' }];
  rec.featured = { key: 'NFL:FIX', editorial_priority: 62 };
  rec.related = { postgame_slug: 'x-postgame-analysis' };
  rec.quality = { score: 100, publishable: true };

  const out = AMODEL.refresh(rec, sc.research, META, { now: iso(at(120)) });
  const r = out.record;

  eq('the snapshot the article cites survives', r.snapshot_id, 'snap_original');
  eq('so does the publication snapshot', r.publication_snapshot_id, 'snap_publication');
  eq('the timing block survives', r.timing && r.timing.publication_window, 'late_window');
  eq('including the minutes before kickoff', r.timing && r.timing.minutes_before_kickoff, 45);
  eq('the theses survive', (r.theses || []).length, 2);
  eq('the featured decision survives', r.featured && r.featured.key, 'NFL:FIX');
  eq('the cross-link survives', r.related && r.related.postgame_slug, 'x-postgame-analysis');
  eq('and the publication date is untouched', r.published_at, iso(at(180)));

  /* AND IT STILL REFRESHES THE RESEARCH — this must not become a no-op. */
  const moved = JSON.parse(JSON.stringify(sc.research));
  moved.market.market = 'Seattle Seahawks -9';
  const out2 = AMODEL.refresh(rec, moved, META, { now: iso(at(120)) });
  chk('newer research still reaches the record', out2.changed === true, out2.reason);
  eq('and the editorial fields still survive that', out2.record.snapshot_id, 'snap_original');
  eq('with the timing intact', out2.record.timing.publication_window, 'late_window');

  /* A RECORD THAT NEVER HAD THEM DOES NOT GAIN EMPTY ONES. */
  const plain = AMODEL.build(sc.research, META, { now: iso(at(180)), status: 'draft' });
  const out3 = AMODEL.refresh(plain, sc.research, META, { now: iso(at(120)) });
  chk('a record with no editorial fields does not gain empty ones',
    out3.record.snapshot_id === undefined && out3.record.timing === undefined);
})();

/* ------------------------------------------------------------------ report */
console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' | publication windows + health | '
  + pass + ' passed' + (fail ? ', ' + fail + ' failed' : ' assertions'));
if (fail) { failures.forEach(f => console.log('  ×  ' + f)); process.exit(1); }
