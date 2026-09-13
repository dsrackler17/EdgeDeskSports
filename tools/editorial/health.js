#!/usr/bin/env node
/* ============================================================================
   EDITORIAL HEALTH — what the system is doing, computed from real state.

   THE RULE THIS FILE EXISTS TO ENFORCE: the admin page and the orchestrator
   must never disagree about what is happening. So the lifecycle truth is
   derived HERE, once, from the same stores the pipeline writes, and the UI
   renders the answer rather than re-deriving it from status strings. A panel
   that guesses is a panel that lies the first time the pipeline changes.

   Everything below is read from disk:
     articles/data/editorial/featured.json   the board and the settings
     articles/data/editorial/snapshots/      the commitments
     articles/data/editorial/runs.json       what every run did and why
     articles/data/editorial/retries.json    what is backing off
     articles/data/records/                  the articles themselves

   WHAT IT REPORTS
     status        HEALTHY / DEGRADED / ERROR, with the reasons
     counts        published today, waiting, late candidates, review, retries
     pipeline      one row per active or committed game, with a NEXT ACTION
     debt          every completed game that still owes a postgame audit
     stale         anything stuck where it should not be

   HEALTH IS ABOUT THE SYSTEM, NOT ABOUT ONE ARTICLE. A single article in
   manual review is the system working — it found something and said so. That
   must never turn the whole panel red, or the panel stops meaning anything
   and the operator stops looking at it.
   ========================================================================== */
'use strict';

const STORE = require('./store.js');
const ASTORE = require('../articles/store.js');
const AMODEL = require('../articles/article_model.js');
const PUB = require('./publisher.js');
const WINDOWS = require('./windows.js');
const FEATURED = require('./featured.js');

const HEALTH = { HEALTHY: 'HEALTHY', DEGRADED: 'DEGRADED', ERROR: 'ERROR' };

/* How long a thing may sit in a state before it is stuck rather than busy. */
const STALE = {
  dispatcher_missed_ticks: 4,       /* ~1h at a 15-minute cadence → DEGRADED  */
  dispatcher_dead_ticks: 16,        /* ~4h → ERROR                            */
  waiting_stats_minutes: 240,       /* a final with no usable box score after 4h */
  generating_minutes: 60,
  retry_overdue_minutes: 60,
};

function ms(v) { const t = Date.parse(v); return isFinite(t) ? t : null; }
function minsSince(v, nowMs) { const t = ms(v); return t == null ? null : Math.round((nowMs - t) / 60000); }
function sameDay(a, b) { return a && b && new Date(a).toISOString().slice(0, 10) === new Date(b).toISOString().slice(0, 10); }

/* ---------------------------------------------------------- the next action */
/* ONE CANONICAL ANSWER per game, in words an operator can act on. The UI does
   not compute this; it prints it. Returned as { action, reason, at } so a
   caller can render "publish at 14:30" rather than parsing a sentence. */
function nextAction(row, ctx) {
  ctx = ctx || {};
  const nowMs = ctx.now_ms != null ? ctx.now_ms : Date.now();
  const cfg = ctx.settings || {};
  const rec = row.article || null;
  const kick = ms(row.game_time);

  /* ---- postgame side: the game has been played ---- */
  if (kick != null && nowMs >= kick) {
    if (row.postgame && PUB.isPublic(row.postgame)) {
      return { action: 'complete', reason: 'pregame and postgame are both public', at: null };
    }
    if (row.postgame && row.postgame.status === 'manual_review') {
      return { action: 'manual review required',
        reason: (row.postgame.publish_state && row.postgame.publish_state.hold_reason)
          || 'the postgame article was held', at: null };
    }
    if (row.retry && !row.retry.exhausted && row.retry.next_retry_at) {
      return { action: 'retry at ' + row.retry.next_retry_at,
        reason: row.retry.last_error, at: row.retry.next_retry_at };
    }
    if (row.retry && row.retry.exhausted) {
      return { action: 'manual review required',
        reason: 'retries exhausted: ' + row.retry.last_error, at: null };
    }
    const settle = (cfg.postgame_settle_minutes || 20);
    const since = Math.round((nowMs - kick) / 60000);
    if (since < (3.5 * 60) + settle) {
      return { action: 'waiting for final', reason: 'the game is in progress', at: null };
    }
    if (row.last_postgame_reason && /box score|stat|readiness|core/i.test(row.last_postgame_reason)) {
      return { action: 'waiting for a stable box score', reason: row.last_postgame_reason, at: null };
    }
    return { action: 'generate postgame',
      reason: row.last_postgame_reason || 'the game is final and the audit has not run', at: null };
  }

  /* ---- pregame side: the game is still ahead ---- */
  if (rec && PUB.isPublic(rec)) {
    return { action: 'waiting for kickoff', reason: 'the pregame article is public', at: row.game_time };
  }
  if (rec && rec.status === 'manual_review') {
    return { action: 'manual review required',
      reason: (rec.publish_state && rec.publish_state.hold_reason)
        || (rec.quality && rec.quality.hold_reason) || 'a blocking condition fired', at: null };
  }
  const cls = WINDOWS.classify({ kickoff_ms: kick, now_ms: nowMs, settings: cfg,
    due_at_minutes: ctx.due_at_minutes });
  if (!cls.config_ok) {
    return { action: 'fix the publication-window configuration',
      reason: cls.config_errors.map(e => e.why).join('; '), at: null };
  }
  if (cls.window === WINDOWS.WINDOW.AFTER_KICKOFF) {
    return { action: 'waiting for final',
      reason: 'kickoff has passed; no new pregame article is published', at: null };
  }
  if (cls.window === WINDOWS.WINDOW.FINAL) {
    return { action: 'manual force required',
      reason: cls.reason, at: null };
  }
  if (cls.window === WINDOWS.WINDOW.LATE) {
    return { action: 'refresh late-window data and publish',
      reason: cls.reason, at: null };
  }
  if (cls.window === WINDOWS.WINDOW.NOT_DUE) {
    /* the moment it becomes due: kickoff minus the window's own lead */
    const due = ctx.due_at_minutes != null && kick != null
      ? new Date(kick - ctx.due_at_minutes * 60000).toISOString() : null;
    return { action: due ? 'publish at ' + due : 'wait for the publication window',
      reason: cls.reason, at: due };
  }
  return { action: 'publish now', reason: cls.reason, at: null };
}

/* ------------------------------------------------------------- the picture */
function snapshot(opts) {
  opts = opts || {};
  const nowIso = opts.now || new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const cfg = opts.settings || STORE.settings();
  const featured = opts.featured || STORE.loadFeatured();
  const runs = opts.runs || STORE.loadRuns();
  const retries = opts.retries || STORE.loadRetries();
  const records = opts.records || ASTORE.loadAll();
  const committed = opts.committed || STORE.committedGames();

  const cfgCheck = WINDOWS.validate(cfg);

  /* ---- the dispatcher's own pulse ---- */
  const dispatchRuns = runs.filter(r => r && (r.step === 'dispatch' || r.step === 'select'
    || r.step === 'pregame' || r.step === 'postgame'));
  const lastRunAt = dispatchRuns.length
    ? dispatchRuns.map(r => r.at).sort().slice(-1)[0] : null;
  const cadence = cfg.dispatcher_interval_minutes || 15;
  const sinceRun = minsSince(lastRunAt, nowMs);
  const nextRunAt = lastRunAt ? new Date(ms(lastRunAt) + cadence * 60000).toISOString() : null;

  /* ---- records this system owns ---- */
  const mine = records.filter(r => r && (r.snapshot_id || AMODEL.typeOf(r) === 'postgame'));
  const byKeyPre = Object.create(null), byKeyPost = Object.create(null);
  mine.forEach(r => {
    const key = (r.featured && r.featured.key)
      || (r.sport && r.game_id ? String(r.sport).toUpperCase() + ':' + r.game_id : null);
    if (!key) return;
    if (AMODEL.typeOf(r) === 'postgame') byKeyPost[key] = r; else byKeyPre[key] = r;
  });

  /* ---- one row per active or committed game ---- */
  const boardRows = featured.games.filter(FEATURED.isFeatured);
  const seen = Object.create(null);
  const games = committed.concat(boardRows)
    .filter(g => g && g.key && !seen[g.key] && (seen[g.key] = true))
    .map(g => {
      const pre = byKeyPre[g.key] || null;
      const post = byKeyPost[g.key] || null;
      const kick = ms(g.game_time);
      const lastPost = runs.filter(r => r && r.key === g.key && /^postgame/.test(r.step || ''))
        .slice(-1)[0] || null;
      const lastAny = runs.filter(r => r && r.key === g.key).slice(-1)[0] || null;
      const retry = retries[STORE.retryKey(g.key, 'postgame')]
        || retries[STORE.retryKey(g.key, 'pregame')] || null;
      const row = {
        key: g.key, sport: g.sport,
        game: (g.away_team || '?') + ' @ ' + (g.home_team || '?'),
        game_time: g.game_time,
        article: pre ? pre.slug : null,
        article_status: pre ? pre.status : null,
        postgame: post ? post.slug : null,
        postgame_status: post ? post.status : null,
        quality: pre && pre.quality ? pre.quality.score : null,
        timing: pre && pre.timing ? pre.timing.publication_window : null,
        minutes_before_kickoff: kick != null ? Math.round((kick - nowMs) / 60000) : null,
        last_action: lastAny ? (lastAny.step + ': ' + String(lastAny.reason || '').slice(0, 80)) : null,
        last_action_at: lastAny ? lastAny.at : null,
        last_postgame_reason: lastPost ? lastPost.reason : null,
        retry: retry || null,
        has_snapshot: !!STORE.researchSnapshot(g.key),
        /* OPERATIONAL METADATA (not public). Everything an operator needs to
           answer "when was this generated, validated and published, what did
           it cite, and which window did it go out in?" without opening a
           record file or a log. */
        detail: pre ? {
          generated_at: pre.generated_at || null,
          validated_at: (pre.quality && pre.quality.at) || (pre.checks && pre.checks.at) || null,
          published_at: pre.published_at || null,
          updated_at: pre.updated_at || null,
          scheduled_kickoff: (pre.timing && pre.timing.scheduled_kickoff) || g.game_time || null,
          minutes_before_kickoff: pre.timing ? pre.timing.minutes_before_kickoff : null,
          publication_window: pre.timing ? pre.timing.publication_window : null,
          refreshed: pre.timing ? !!pre.timing.refreshed : false,
          research_snapshot_id: pre.snapshot_id || null,
          publication_snapshot_id: pre.publication_snapshot_id || null,
          generation_version: (pre.research && pre.research.generation_version)
            || (pre.meta && pre.meta.generation_version) || null,
          model_status: pre.model_status || null,
          canonical_url: pre.canonical_url || null,
          hold_reason: (pre.publish_state && pre.publish_state.hold_reason)
            || (pre.quality && pre.quality.hold_reason) || null,
        } : null,
      };
      const na = nextAction({ key: g.key, game_time: g.game_time, article: pre, postgame: post,
        retry, last_postgame_reason: row.last_postgame_reason },
        { now_ms: nowMs, settings: cfg, due_at_minutes: WINDOWS.leadMinutesFor(cfg, g) });
      row.next_action = na.action;
      row.next_action_reason = na.reason;
      row.next_action_at = na.at;
      /* the phase a reader of the panel cares about */
      row.phase = (kick != null && nowMs >= kick) ? 'postgame' : 'pregame';
      return row;
    });

  /* ---- POSTGAME DEBT. A committed snapshot means the system OWES that game
     an audit. It must never vanish because the board moved on, generation
     failed once, or a cron tick was skipped. */
  const debt = games.filter(g => {
    const kick = ms(g.game_time);
    if (kick == null || nowMs < kick) return false;          /* not played yet */
    if (!g.has_snapshot) return false;                        /* never committed */
    return !(g.postgame_status && ['published', 'updated'].indexOf(g.postgame_status) >= 0);
  }).map(g => {
    let state = 'postgame_due';
    const since = Math.round((nowMs - ms(g.game_time)) / 60000);
    if (since < (3.5 * 60) + (cfg.postgame_settle_minutes || 20)) state = 'waiting_final';
    else if (g.postgame_status === 'manual_review') state = 'manual_review';
    else if (g.retry && !g.retry.exhausted) state = 'retry_pending';
    else if (g.postgame_status) state = 'generating_postgame';
    else if (/box score|stat|readiness|core/i.test(String(g.last_postgame_reason || ''))) state = 'waiting_stats';
    return { key: g.key, game: g.game, sport: g.sport, game_time: g.game_time,
      minutes_since_kickoff: since, state,
      reason: g.last_postgame_reason || g.next_action_reason, next_action: g.next_action };
  });

  /* ---- STALE STATE. Reported, never silently repaired. ---- */
  const stale = [];
  games.forEach(g => {
    const kick = ms(g.game_time);
    if (g.article_status === 'ready' && kick != null && nowMs > kick) {
      stale.push({ key: g.key, id: 'ready_past_kickoff',
        why: 'the article is ready but its game has started, so it can never publish as pregame research' });
    }
    if (g.article_status === 'draft' && g.last_action_at
        && minsSince(g.last_action_at, nowMs) > STALE.generating_minutes) {
      stale.push({ key: g.key, id: 'generating_too_long',
        why: 'still a draft ' + minsSince(g.last_action_at, nowMs) + ' minutes after its last action' });
    }
    if (g.retry && g.retry.next_retry_at && ms(g.retry.next_retry_at) < nowMs
        && minsSince(g.retry.next_retry_at, nowMs) > STALE.retry_overdue_minutes) {
      stale.push({ key: g.key, id: 'retry_overdue',
        why: 'a retry was due ' + minsSince(g.retry.next_retry_at, nowMs) + ' minutes ago and has not run' });
    }
    if (PUB.isPublic(g.article ? { status: g.article_status } : {}) && !g.article) {
      stale.push({ key: g.key, id: 'published_without_route',
        why: 'the record is published but carries no slug, so there is no public page' });
    }
  });
  debt.filter(d => d.state === 'waiting_stats'
      && d.minutes_since_kickoff > STALE.waiting_stats_minutes).forEach(d => {
    stale.push({ key: d.key, id: 'waiting_stats_too_long',
      why: 'final was ' + d.minutes_since_kickoff + ' minutes ago and the box score is still not usable' });
  });

  /* ---- counts, from real state ---- */
  const publishedToday = mine.filter(r => PUB.isPublic(r) && sameDay(r.published_at, nowIso));
  const counts = {
    published_today: publishedToday.length,
    pregame_published_today: publishedToday.filter(r => AMODEL.typeOf(r) === 'pregame').length,
    postgame_published_today: publishedToday.filter(r => AMODEL.typeOf(r) === 'postgame').length,
    waiting_for_window: games.filter(g => g.phase === 'pregame'
      && /publish at|wait for the publication window/.test(g.next_action)).length,
    late_window_candidates: games.filter(g => /refresh late-window/.test(g.next_action)).length,
    waiting_for_kickoff_or_final: games.filter(g => /waiting for (kickoff|final)/.test(g.next_action)).length,
    waiting_for_stats: debt.filter(d => d.state === 'waiting_stats').length,
    generating: mine.filter(r => r.status === 'draft').length,
    ready: mine.filter(r => r.status === 'ready').length,
    ready_too_late: mine.filter(r => r.status === 'ready_too_late').length,
    manual_review: mine.filter(r => r.status === 'manual_review').length,
    retries_pending: Object.keys(retries).filter(k => retries[k] && !retries[k].exhausted).length,
    failed: Object.keys(retries).filter(k => retries[k] && retries[k].exhausted).length,
    postgame_debt: debt.length,
  };

  /* ---- the verdict ---- */
  const reasons = [];
  let status = HEALTH.HEALTHY;
  function degrade(why) { if (status !== HEALTH.ERROR) status = HEALTH.DEGRADED; reasons.push(why); }
  function fail(why) { status = HEALTH.ERROR; reasons.push(why); }

  if (!cfgCheck.ok) {
    fail('the publication-window configuration is invalid: '
      + cfgCheck.errors.map(e => e.why).join('; '));
  }
  if (lastRunAt == null) {
    fail('the dispatcher has never run');
  } else if (sinceRun >= cadence * STALE.dispatcher_dead_ticks) {
    fail('the dispatcher has not run for ' + sinceRun + ' minutes (cadence is ' + cadence + ')');
  } else if (sinceRun >= cadence * STALE.dispatcher_missed_ticks) {
    degrade('the dispatcher last ran ' + sinceRun + ' minutes ago (cadence is ' + cadence + ')');
  }
  if (counts.failed > 0) degrade(counts.failed + ' step(s) have exhausted their retries');
  if (counts.retries_pending > 2) degrade(counts.retries_pending + ' step(s) are backing off');
  if (stale.length) degrade(stale.length + ' record(s) are in a stale state');
  /* DELIBERATELY NOT A DEGRADE: manual_review is the system working. */

  return {
    generated_at: nowIso,
    status, reasons,
    config: { ok: cfgCheck.ok, errors: cfgCheck.errors, policy: cfgCheck.policy },
    dispatcher: {
      last_run_at: lastRunAt, minutes_since: sinceRun,
      cadence_minutes: cadence, next_expected_at: nextRunAt,
    },
    settings: {
      auto_publish_pregame: cfg.auto_publish_pregame !== false,
      auto_publish_postgame: cfg.auto_publish_postgame !== false,
      normal_lead_minutes: cfgCheck.policy.normal_lead_minutes,
      minimum_lead_minutes: cfgCheck.policy.minimum_lead_minutes,
      quality_floor: cfg.quality_floor != null ? cfg.quality_floor : 70,
      /* NOTHING HERE IS EDITABLE FROM THE BROWSER. There is no persistent
         write path for these, so the panel shows them and says where they
         live; a control that saves somewhere the pipeline never reads is the
         exact bug this system already had once. */
      editable: false,
      source: 'articles/data/editorial/featured.json → settings',
    },
    counts, games, debt, stale,
  };
}

/* ------------------------------------------------------------------- CLI */
function markdown(h) {
  const L = [];
  L.push('EDITORIAL SYSTEM — ' + h.status);
  h.reasons.forEach(r => L.push('  · ' + r));
  L.push('');
  L.push('  dispatcher       ' + (h.dispatcher.last_run_at || 'never')
    + (h.dispatcher.minutes_since != null ? '  (' + h.dispatcher.minutes_since + 'm ago)' : ''));
  L.push('  next expected    ' + (h.dispatcher.next_expected_at || '—'));
  L.push('  pregame auto     ' + (h.settings.auto_publish_pregame ? 'ON' : 'OFF'));
  L.push('  postgame auto    ' + (h.settings.auto_publish_postgame ? 'ON' : 'OFF'));
  L.push('  normal lead      ' + h.settings.normal_lead_minutes + ' min');
  L.push('  minimum lead     ' + h.settings.minimum_lead_minutes + ' min');
  L.push('');
  Object.keys(h.counts).forEach(k => L.push('  ' + k.padEnd(28) + h.counts[k]));
  L.push('');
  L.push('ACTIVE PIPELINE');
  h.games.slice(0, 40).forEach(g => L.push('  ' + String(g.sport).padEnd(4)
    + String(g.game).slice(0, 34).padEnd(35)
    + String(g.phase).padEnd(9)
    + String(g.article_status || g.postgame_status || '—').padEnd(15)
    + String(g.next_action).slice(0, 44)));
  if (h.debt.length) {
    L.push('');
    L.push('POSTGAME DEBT');
    h.debt.forEach(d => L.push('  ' + String(d.state).padEnd(20) + String(d.game).slice(0, 34).padEnd(35)
      + String(d.reason || '').slice(0, 50)));
  }
  if (h.stale.length) {
    L.push('');
    L.push('STALE');
    h.stale.forEach(s => L.push('  ' + String(s.id).padEnd(24) + s.key + ' — ' + s.why));
  }
  return L.join('\n');
}

if (require.main === module) {
  const h = snapshot({});
  const asJson = process.argv.indexOf('--json') >= 0;
  console.log(asJson ? JSON.stringify(h, null, 2) : markdown(h));
}

module.exports = { HEALTH, STALE, nextAction, snapshot, markdown };
