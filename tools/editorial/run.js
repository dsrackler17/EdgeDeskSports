#!/usr/bin/env node
/* ============================================================================
   THE EDITORIAL PIPELINE — one command, five phases, every step logged.

     node tools/editorial/run.js select            score the slate, pick featured
     node tools/editorial/run.js pregame           snapshot + article for what is due
     node tools/editorial/run.js postgame          audit + article for what has finished
     node tools/editorial/run.js memory            rebuild the research memory
     node tools/editorial/run.js all               all four, in order

   Flags
     --network       allow feed downloads (offline by default, like the rest)
     --auto          publish what passes every check (else generate and hold)
     --game KEY      one game only, e.g. --game NFL:2026_01_NE_SEA
     --force         ignore the idempotency log for the named game
     --narrate       call the language model for connective prose
     --dry           write nothing
     --now ISO       pretend it is another moment (the suite uses this)
     --quiet

   IDEMPOTENT BY CONSTRUCTION, three ways over, because a cron job firing
   twice is not an edge case:
     1. a snapshot's id is a hash of its own content, so re-capturing
        unchanged research writes the same file;
     2. an article's id is derived from the game, so a second run updates one
        record rather than creating a second;
     3. every step writes a line to the run log with a key, and a step that
        already succeeded for that key in this phase is skipped.

   RETRY-SAFE AND RECOVERABLE. Every step is wrapped: a thrown error becomes a
   logged failure on that game and the run continues to the next one. Nothing
   is left half-written, because each step's write is the last thing it does.

   IT NEVER PUBLISHES FABRICATED SUBSTITUTES. Missing odds, a missing
   projection, a postponed game, a box score that is not ready, a provider
   disagreement, a failed narration, a failed quality check — each is a stated
   reason in the run log and a held article, never a filled-in gap.
   ========================================================================== */
'use strict';
const path = require('path');

const ASTORE = require('../articles/store.js');
const AMODEL = require('../articles/article_model.js');
const HOST = require('../articles/research_host.js');
const FEATURED = require('./featured.js');
const SNAP = require('./snapshot.js');
const THESES = require('./theses.js');
const RESULTS = require('./results.js');
const GRADING = require('./grading.js');
const LESSONS = require('./lessons.js');
const QUALITY = require('./quality.js');
const NARRATE = require('./narrate.js');
const GRAPHIC = require('./graphic.js');
const POST = require('./postgame_model.js');
const FETCH = require('./fetch_results.js');
const PUBLISH = require('./publisher.js');
const WINDOWS = require('./windows.js');
const REFRESH = require('./refresh.js');
const STORE = require('./store.js');

function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || v.startsWith('--')) ? true : v;
}
const PHASE = (process.argv[2] && !process.argv[2].startsWith('--')) ? process.argv[2] : 'all';
const NETWORK = !!arg('network', false);
const AUTO = !!arg('auto', false);
const ONLY = arg('game', null);
const FORCE = !!arg('force', false);
const DO_NARRATE = !!arg('narrate', false);
const DRY = !!arg('dry', false);
const QUIET = !!arg('quiet', false);
const IF_DUE = !!arg('if-due', false);
const NOW = arg('now', null) && arg('now', null) !== true
  ? new Date(arg('now', null)).toISOString() : new Date().toISOString();

function log(...a) { if (!QUIET) console.log(...a); }
function pad(s, n) { s = String(s == null ? '' : s); return s + ' '.repeat(Math.max(1, n - s.length)); }

/* -------------------------------------------------------------- the log */
/* One entry per step per game, whatever happened. `ok:false` entries are the
   valuable ones: "why did this game not get an article?" has an answer here
   and nowhere else. */
const RUN_ID = 'run_' + Date.parse(NOW).toString(36);
const entries = [];
function record(step, key, ok, reason, extra) {
  const e = Object.assign({ run: RUN_ID, at: NOW, phase: PHASE, step, key: key || null,
    ok: !!ok, reason: reason || null }, extra || {});
  entries.push(e);
  return e;
}
/* THE RETRY LEDGER, loaded once per run and written once at the end. */
const RETRIES = STORE.loadRetries();
let retriesDirty = false;

/* Every step goes through this, so one game blowing up never takes a run with
   it and the failure is a logged failure rather than a stack trace.

   A THROW IS TREATED AS TRANSIENT. Something that threw — a provider timing
   out, a feed briefly down, a socket reset — gets a bounded backoff and a
   later attempt rather than being retried every fifteen minutes forever or
   dropped on the floor. Five attempts over about nine hours, then it stops
   and says why. A FACTUAL failure never reaches here: the publisher turns
   those into manual_review, which no amount of retrying would clear. */
async function step(name, key, fn) {
  if (key && !FORCE) {
    const gate = STORE.retryDue(RETRIES, key, name, NOW);
    if (!gate.due) {
      record(name, key, true, gate.reason, { skipped: true, retry: true, attempt: gate.attempt });
      return null;
    }
  }
  try {
    const out = await fn();
    if (key && STORE.retryKey(key, name) in RETRIES) {
      STORE.retryCleared(RETRIES, key, name); retriesDirty = true;
    }
    return out;
  } catch (e) {
    const msg = e && e.message ? String(e.message).slice(0, 300) : String(e);
    let note = '';
    if (key) {
      const r = STORE.retryFailed(RETRIES, key, name, msg, NOW);
      retriesDirty = true;
      note = r.exhausted
        ? ' — attempt ' + r.attempt_count + ' of ' + STORE.RETRY_MAX + ', giving up'
        : ' — attempt ' + r.attempt_count + ', next try ' + r.next_retry_at;
    }
    record(name, key, false, 'threw: ' + msg + note, { error: true, transient: true });
    log('  ' + pad('FAILED', 12) + pad(name, 18) + (key || '') + ' — ' + msg + note);
    return null;
  }
}

/* ==================================================================== */
/* PHASE 1 — SELECT                                                      */
/* ==================================================================== */
/* Score every game on the board and store the rows. An operator's FEATURE,
   UNFEATURE and the two enable switches survive a rescore: featured.js
   applyOverride() is the only thing that may move them. */
async function phaseSelect(host) {
  const prior = STORE.loadFeatured();
  const slate = host.slate();
  /* the research payload for each game, which is where the model-versus-market
     disagreement and each team's own EdgeDesk rank are read from */
  const research = Object.create(null);
  const ranks = ranksFromRankings();
  slate.forEach(entry => {
    try {
      const r = entry.sport === 'NFL'
        ? host.nfl(entry.home_name || entry.home, entry.away_name || entry.away, entry.kickoff_ms)
        : host.cfb(entry.home, entry.away, entry.kickoff_ms);
      if (r) research[entry.sport + ':' + entry.game_id] = r;
    } catch (_) { /* a game the terminal cannot price is scored on its occasion alone */ }
  });

  const rows = FEATURED.scoreSlate(slate, {
    ranks, rivalries: STORE.loadRivalries(), research, slate
  }, { prior: prior.games, now: NOW, thresholds: prior.settings.thresholds,
    caps: prior.settings.weekly_caps });

  const featured = rows.filter(FEATURED.isFeatured);
  if (!DRY) STORE.saveFeatured(rows, { now: NOW });
  record('select', null, true, rows.length + ' scored, ' + featured.length + ' featured',
    { scored: rows.length, featured: featured.length });

  log('\n' + rows.length + ' game(s) scored · ' + featured.length + ' featured');
  featured.slice(0, 20).forEach(g => {
    log('  ' + pad(g.editorial_priority, 7) + pad(g.sport, 5) + pad(g.away_team + ' at ' + g.home_team, 48)
      + (g.window_label || '') + (g.manual_override ? '  [' + g.manual_override + ']' : ''));
    (g.priority_components || []).filter(c => c.points).forEach(c => {
      log('           ' + pad('+' + c.points, 7) + c.label);
    });
  });
  const near = rows.filter(g => !FEATURED.isFeatured(g)).slice(0, 5);
  if (near.length) {
    log('  nearest misses:');
    near.forEach(g => log('    ' + pad(g.editorial_priority, 7) + g.away_team + ' at ' + g.home_team));
  }
  return rows;
}

/* EdgeDesk's OWN ranks, off the committed rankings build. A rank is EdgeDesk's
   and is labelled as EdgeDesk's everywhere it is used; it is never a poll. */
function ranksFromRankings() {
  const out = Object.create(null);
  const j = STORE.readJson(path.join(STORE.ROOT, 'football', 'rankings', 'current.json'), null);
  const teams = (j && j.teams) || null;
  if (!teams) return out;
  Object.keys(teams).forEach(k => {
    const t = teams[k];
    if (t && t.rank != null && t.team) out[FEATURED.teamKey(t.team)] = +t.rank;
  });
  return out;
}

/* ==================================================================== */
/* PHASE 2 — PREGAME                                                     */
/* ==================================================================== */
/* For each featured game inside its lead-time window: capture the snapshot,
   build (or refresh) the article record, extract the theses, run the quality
   gate, and publish or hold. */
async function phasePregame(host) {
  const cfg = STORE.settings();
  const rows = STORE.loadFeatured().games.filter(FEATURED.isFeatured)
    .filter(g => g.pregame_enabled !== false)
    .filter(g => !ONLY || ONLY === true || g.key === ONLY);
  const runs = STORE.loadRuns();
  const nowMs = Date.parse(NOW);
  const articles = ASTORE.loadAll();
  const byId = Object.create(null);
  articles.forEach(a => { byId[a.id] = a; });
  const out = [];

  for (const g of rows) {
    const key = g.key;
    const kick = Date.parse(g.game_time);
    if (!isFinite(kick)) { record('pregame', key, false, 'no usable kickoff time'); continue; }
    const leadH = (kick - nowMs) / 3600000;

    /* THE PUBLICATION WINDOW — see tools/editorial/windows.js. This used to be
       a single 90-minute cliff that recorded a FAILURE for a perfectly good
       article at 89 minutes. There are now three windows, and only one of
       them stops the article existing at all. */
    const cls = WINDOWS.classify({
      kickoff_ms: kick, now_ms: nowMs, settings: cfg, due_at_minutes: leadFor(cfg, g) * 60,
    });
    if (!cls.config_ok) {
      record('pregame', key, false, cls.reason, { config_errors: cls.config_errors });
      continue;
    }
    if (cls.window === WINDOWS.WINDOW.NOT_DUE) {
      record('pregame', key, true, cls.reason, { skipped: true, window: cls.window });
      continue;
    }
    /* AFTER KICKOFF — never a new pregame article, and never a back-dated one.
       The commitment that already exists is preserved and the game stays owed
       an audit; there is simply nothing new to publish. */
    if (cls.window === WINDOWS.WINDOW.AFTER_KICKOFF) {
      record('pregame', key, true, cls.reason,
        { skipped: true, window: cls.window, minutes_before_kickoff: cls.minutes_before_kickoff });
      continue;
    }
    if (!FORCE && STORE.alreadyDone(runs, key, 'pregame_published')) {
      record('pregame', key, true, 'already published in an earlier run', { skipped: true });
      continue;
    }

    const res = await step('pregame', key, async () => {
      /* ---- the research, from the terminal itself ---- */
      const entry = { sport: g.sport, game_id: g.game_id, home: g.home_team, away: g.away_team,
        kickoff: g.game_time, kickoff_ms: kick, venue: g.venue, week: g.week, season: g.season,
        neutral_site: g.neutral_site };
      const research = g.sport === 'NFL'
        ? host.nfl(g.home_team, g.away_team, kick)
        : host.cfb(g.home_team, g.away_team, kick);
      if (!research) {
        record('pregame_snapshot', key, false, 'the research terminal returned no payload for this game');
        return { action: 'held', why: 'no research payload' };
      }
      const meta = AMODEL.gameMetaFrom(research, g.sport, entry);
      if (meta.venue == null) meta.venue = g.venue;
      if (meta.week == null) meta.week = g.week;
      if (meta.season == null) meta.season = g.season;
      if (!meta.neutral_site && g.neutral_site) meta.neutral_site = true;

      /* ---- the snapshot: immutable, content-addressed ---- */
      const id = g.sport.toLowerCase() + '-' + g.game_id;
      const snap = SNAP.capture(research, meta, {
        now: NOW, article_id: id, featured: featuredSummary(g),
        market_source: host.marketSourceFor(g.sport, g.game_id),
        schedule_source: g.sport === 'NFL' ? 'nflverse games.csv' : 'cfbfastR schedules',
        sources: sourceList(host, g),
        generation_version: 'editorial_v1'
      });
      const saved = DRY ? { written: false, reason: 'dry run' } : STORE.saveSnapshot(snap);
      record('pregame_snapshot', key, true, saved.written ? 'captured ' + snap.snapshot_id
        : 'unchanged: ' + snap.snapshot_id, { snapshot_id: snap.snapshot_id });

      /* ---- the article record, through the SAME model the pipeline uses ---- */
      const prior = byId[id] || null;
      const taken = ASTORE.takenSlugs(articles);
      let rec, action;
      if (!prior) {
        rec = AMODEL.build(research, meta, { now: NOW, taken, status: 'draft',
          market_source: host.marketSourceFor(g.sport, g.game_id) });
        action = 'created';
      } else {
        const r = AMODEL.refresh(prior, research, meta, { now: NOW, taken,
          market_source: host.marketSourceFor(g.sport, g.game_id) });
        rec = r.record;
        action = r.changed ? 'updated' : 'unchanged';
      }
      /* the snapshot the article cites, and the theses it commits to */
      rec.snapshot_id = snap.snapshot_id;
      rec.featured = featuredSummary(g);
      rec.theses = THESES.extract(snap);
      rec.hero_image = rec.hero_image || GRAPHIC.forRecord(Object.assign({}, rec,
        { article_type: 'pregame', snapshot: snap })).data_uri;

      /* ---- the gate ---- */
      const q = QUALITY.inspect(rec, { now: NOW });
      rec.quality = { score: q.score, publishable: q.publishable,
        manual_review_required: q.manual_review_required, hold_reason: q.hold_reason,
        integrity_failed: q.integrity_failed, craft_failed: q.craft_failed, at: NOW };
      const verdict = AMODEL.publishable(rec);
      rec.checks = { ok: verdict.ok, failed: verdict.failed.map(f => ({ id: f.id, why: f.why })), at: NOW };
      if (verdict.ok && q.publishable) rec.status = 'ready';
      /* the gate result the publisher will be handed; the late window
         re-runs it below and replaces this */
      let gate = q;

      if (!q.publishable) {
        record('pregame_validation', key, false, q.hold_reason, { score: q.score });
      } else {
        record('pregame_validation', key, true, 'quality ' + q.score, { score: q.score });
      }

      /* ---- THE LATE WINDOW. Between the minimum and the normal lead an
         article is still legitimate pregame research, but the market and the
         availability report are the parts that rot this close in, so they are
         re-verified before it goes out. A refresh that cannot reach anything
         holds the article rather than publishing two-hour-old prices under a
         fresh timestamp. */
      let timing = WINDOWS.timingFor(cls, { now: NOW, refreshed: false });
      if (cls.window === WINDOWS.WINDOW.LATE) {
        const ref = REFRESH.refresh({
          committed_research: snap.research, live_research: research,
          game: meta, snapshot: snap, article_id: id, now: NOW,
          market_source: host.marketSourceFor(g.sport, g.game_id),
          sources: sourceList(host, g), generation_version: 'editorial_late_window',
        });
        if (!ref.ok) {
          record('pregame_refresh', key, false, ref.reasons.join('; '), { state: ref.state });
          rec.publish_state = { ok: false, at: NOW, blocking: [{ id: 'late_window_refresh', why: ref.reasons[0] }],
            warnings: [], hold_reason: 'late_window_refresh' };
          rec.timing = timing;
          if (!DRY) { ASTORE.save(rec); byId[id] = rec; articles.push(rec); }
          return { action: 'held', why: ref.reasons[0], score: q.score, slug: rec.slug,
            window: cls.window };
        }
        /* THE REFRESHED FACTS ARE A SECOND SNAPSHOT, never an edit to the
           first: the original is the analytical commitment the postgame audit
           grades, and it stays exactly as it was. */
        if (ref.snapshot && !DRY) {
          try { STORE.saveSnapshot(ref.snapshot); } catch (e) { /* identical content is a no-op */ }
        }
        rec.publication_snapshot_id = ref.snapshot ? ref.snapshot.snapshot_id : null;
        timing = WINDOWS.timingFor(cls, { now: NOW, refreshed: true });
        record('pregame_refresh', key, true,
          ref.state === 'refreshed' ? ref.reasons.join('; ') : 'time-sensitive data re-verified, unchanged',
          { state: ref.state, changes: ref.changes, publication_snapshot: rec.publication_snapshot_id });

        /* RE-RUN THE GATE ON THE REFRESHED RECORD. The whole point of
           refreshing is that something may have moved, so the integrity and
           quality checks are run again rather than trusted from before. */
        const q2 = QUALITY.inspect(rec, { now: NOW });
        rec.quality = { score: q2.score, publishable: q2.publishable,
          manual_review_required: q2.manual_review_required, hold_reason: q2.hold_reason,
          integrity_failed: q2.integrity_failed, craft_failed: q2.craft_failed, at: NOW };
        gate = q2;
        if (!q2.publishable) {
          record('pregame_validation', key, false,
            'after the late-window refresh: ' + q2.hold_reason, { score: q2.score });
        }
      }
      rec.timing = timing;

      /* ---- THE FINAL WINDOW. Inside the minimum lead nothing publishes
         automatically. This is NOT an error and NOT a failed article: it is
         complete, validated research that arrived too close to kickoff to go
         out honestly on its own. It is kept, its snapshot is kept, the game
         stays owed a postgame audit, and an operator may force it. */
      if (cls.window === WINDOWS.WINDOW.FINAL && !FORCE) {
        rec.status = 'ready_too_late';
        rec.publish_state = { ok: false, at: NOW, blocking: [],
          warnings: [], hold_reason: 'inside final pregame publication floor' };
        record('pregame_window', key, true, cls.reason,
          { window: cls.window, minutes_before_kickoff: cls.minutes_before_kickoff,
            forcible: true, score: q.score });
        if (!DRY) { ASTORE.save(rec); byId[id] = rec; articles.push(rec); }
        return { action: 'ready_too_late', slug: rec.slug, score: q.score, status: rec.status,
          theses: rec.theses.length, window: cls.window, why: cls.reason };
      }
      if (cls.window === WINDOWS.WINDOW.FINAL && FORCE) {
        timing = WINDOWS.timingFor(cls, { now: NOW, refreshed: timing.refreshed, forced: true });
        rec.timing = timing;
        record('pregame_window', key, true,
          'forced by an operator inside the final window (' + cls.minutes_before_kickoff + ' minutes to kickoff)',
          { window: 'forced' });
      }

      /* ---- THE PUBLISHER. One path, and it is the same one the postgame
         half and the backfill use. It re-runs every blocking condition
         against the assembled record and either moves the status to
         published or to manual_review with the condition named — there is
         no branch here that leaves a valid article sitting in draft. */
      const wantAuto = AUTO || STORE.settings().auto_publish_pregame;
      if (!wantAuto) {
        record('pregame_generated', key, true,
          rec.slug + ' — auto-publish is switched off for pregame articles',
          { slug: rec.slug, score: q.score });
        if (!DRY) { ASTORE.save(rec); byId[id] = rec; articles.push(rec); }
        return { action: 'generated', slug: rec.slug, score: q.score, status: rec.status,
          theses: rec.theses.length, why: 'auto-publish off' };
      }
      /* `prior` is the record as stored, so an unchanged republish leaves
         updated_at alone and a real edit moves it. */
      const pub = PUBLISH.publish(rec, { now: NOW, quality: gate, others: articles, previous: prior });
      rec = pub.record;
      if (pub.ok) {
        /* the timing block the later analytics read: which window it went out
           in, how many minutes before kickoff, and whether it was refreshed */
        rec.timing = Object.assign({}, timing, { published_at: rec.published_at });
        record('pregame_published', key, true,
          rec.slug + ' (' + pub.action + ', ' + rec.timing.publication_window + ', '
            + rec.timing.minutes_before_kickoff + 'm before kickoff)',
          { slug: rec.slug, score: q.score, url: rec.canonical_url, action: pub.action,
            window: rec.timing.publication_window,
            minutes_before_kickoff: rec.timing.minutes_before_kickoff });
        action = pub.action;
      } else {
        record('pregame_published', key, false, pub.reason,
          { slug: rec.slug, score: q.score, blocking: pub.blocking.map(b => b.id) });
        action = 'manual_review';
      }
      if (!DRY) { ASTORE.save(rec); byId[id] = rec; articles.push(rec); }
      return { action, slug: rec.slug, score: q.score, status: rec.status,
        theses: rec.theses.length, why: pub.ok ? null : pub.reason };
    });
    if (res) out.push(Object.assign({ key }, res));
  }

  if (!DRY && out.length) ASTORE.saveIndex(ASTORE.loadAll(), { now: NOW });
  log('\nPREGAME · ' + rows.length + ' featured game(s) considered, ' + out.length + ' acted on');
  out.forEach(r => log('  ' + pad(r.action, 11) + pad(r.status || '', 10)
    + pad(r.slug || r.key, 48) + (r.score != null ? 'quality ' + r.score : '')
    + (r.why ? '  — ' + r.why : '')));
  return out;
}

/* Kept as an hours-returning wrapper because the log lines print hours; the
   policy itself lives in windows.js so the health panel reads the same one. */
function leadFor(cfg, g) { return WINDOWS.leadMinutesFor(cfg, g) / 60; }
function featuredSummary(g) {
  return { editorial_priority: g.editorial_priority, status: g.status,
    window_label: g.window_label, window_key: g.window_key, national_window: g.national_window,
    stage: g.stage, stage_label: g.stage_label, rivalry_label: g.rivalry_label,
    home_rank: g.home_rank, away_rank: g.away_rank, rank_pool: g.rank_pool,
    model_disagreement: g.model_disagreement, manual_override: g.manual_override,
    components: g.priority_components };
}
function sourceList(host, g) {
  const n = host.notes || {};
  return [
    g.sport === 'NFL' ? 'nflverse games.csv (public, keyless)' : 'cfbfastR schedules (public, keyless)',
    n.rankings && n.rankings.season ? 'EdgeDesk rankings build ' + n.rankings.season + ' ' + n.rankings.week_label : null,
    host.marketSourceFor(g.sport, g.game_id) ? 'a committed sportsbook-quote snapshot' : null
  ].filter(Boolean);
}

/* ==================================================================== */
/* PHASE 3 — POSTGAME                                                    */
/* ==================================================================== */
/* For each featured game whose kickoff is behind us and whose pregame
   snapshot exists: fetch the result, gate on readiness, audit the theses,
   grade result versus process, extract lessons, build the article, gate on
   quality, and publish or hold. */
async function phasePostgame() {
  const cfg = STORE.settings();
  /* WHAT IS OWED AN AUDIT — every game EdgeDesk captured a snapshot for,
     unioned with the featured board.

     The board alone was wrong and silently so: featured.json is rebuilt from
     the CURRENT slate every run, and a played game leaves the slate within a
     day. A game could be featured, get its pregame article published, be
     played, drop off the board, and then never be audited — the postgame
     phase iterated a list the game was no longer on. The snapshot is the
     durable commitment, so it is the authority here; the board only adds
     games that have not been captured yet. An operator's postgame_enabled:
     false still wins over both. */
  const board = STORE.loadFeatured().games.filter(FEATURED.isFeatured);
  const disabled = Object.create(null);
  STORE.loadFeatured().games.forEach(g => {
    if (g && g.postgame_enabled === false) disabled[g.key] = true;
  });
  const seen = Object.create(null);
  const rows = STORE.committedGames().concat(board)
    .filter(g => g && g.key && !seen[g.key] && (seen[g.key] = true))
    .filter(g => !disabled[g.key])
    .filter(g => !ONLY || ONLY === true || g.key === ONLY);
  const runs = STORE.loadRuns();
  const nowMs = Date.parse(NOW);
  const articles = ASTORE.loadAll();
  const byId = Object.create(null);
  articles.forEach(a => { byId[a.id] = a; });
  const out = [];

  for (const g of rows) {
    const key = g.key;
    const kick = Date.parse(g.game_time);
    if (!isFinite(kick) || nowMs < kick) {
      record('postgame', key, true, 'the game has not kicked off yet', { skipped: true });
      continue;
    }
    if (!FORCE && STORE.alreadyDone(runs, key, 'postgame_published')) {
      record('postgame', key, true, 'already published in an earlier run', { skipped: true });
      continue;
    }
    /* THE ORIGINAL ANALYTICAL COMMITMENT, never a later publication snapshot.
       A late-window refresh writes a SECOND snapshot recording what was true
       when the article went public; grading the audit against that instead of
       the original would let EdgeDesk mark its own homework with figures it
       learned after committing. researchSnapshot() is explicit about which
       one this is. */
    const snap = STORE.researchSnapshot(key) || STORE.latestSnapshot(key);
    if (!snap) {
      record('postgame', key, false,
        'no pregame snapshot for this game — there is nothing to audit the result against, and a postgame article without one would be a recap');
      continue;
    }

    const res = await step('postgame', key, async () => {
      /* ---- the result ---- */
      const got = await FETCH.fetchResult({
        sport: g.sport, game_id: g.game_id, home: g.home_team, away: g.away_team,
        kickoff: g.game_time, season: g.season
      }, { network: NETWORK, snapshot: snap });
      got.reconciled.snapshot = snap;

      const ready = RESULTS.readiness(got.reconciled, {
        now: NOW, settle_minutes: cfg.postgame_settle_minutes,
        min_core_metrics: cfg.postgame_min_core_metrics
      });
      if (!ready.ready) {
        record('postgame_readiness', key, false, ready.reasons.join('; '),
          { conflict: !!ready.conflict, missing: ready.missing_metrics });
        return { action: 'waiting', why: ready.reasons[0] };
      }
      record('postgame_readiness', key, true,
        ready.core_metrics_present.length + ' core statistics on both sides', {});

      const result = RESULTS.build(got.reconciled, {
        now: NOW, sport: g.sport, game_id: g.game_id, season: g.season, week: g.week,
        kickoff: g.game_time, home: g.home_team, away: g.away_team,
        source_notes: got.notes
      });
      if (!DRY) STORE.saveResult(result);
      record('postgame_result', key, true,
        result.away_team + ' ' + result.away_score + ' — ' + result.home_team + ' ' + result.home_score
        + ' (' + (result.agreed_by || []).join('+') + ')', {});

      /* ---- the audit and the grade ---- */
      const theses = (byId[g.sport.toLowerCase() + '-' + g.game_id] || {}).theses || THESES.extract(snap);
      const audit = THESES.audit(theses, result);
      const tally = THESES.tally(audit);
      const graded = GRADING.grade({
        snapshot: snap, result, audit, tally, now: NOW,
        closing_home_margin: got.closing && got.closing.home_margin,
        closing_source: got.closing && got.closing.source,
        closing_absent_reason: got.closing && got.closing.absent_reason
      });
      const lessons = LESSONS.extract({
        snapshot: snap, result, graded, audit, tally, now: NOW,
        article_id: 'postgame-' + g.sport.toLowerCase() + '-' + g.game_id
      });
      if (!DRY) {
        STORE.saveAudit({ schema: 'edgedesk_game_audit_v1', key, game_id: g.game_id, sport: g.sport,
          snapshot_id: snap.snapshot_id, audited_at: NOW, theses, audit, tally, grading: graded, lessons });
      }
      record('postgame_audit', key, true, tally.headline + ' · ' + graded.bet_headline
        + ' / ' + graded.process_headline, { bet: graded.bet_headline, process: graded.process_headline });

      /* ---- the article ---- */
      const pre = byId[g.sport.toLowerCase() + '-' + g.game_id] || null;
      let rec = POST.build({ snapshot: snap, result, theses, audit, tally, grading: graded,
        lessons, pregame: pre, now: NOW, status: 'draft' });

      /* ---- the narration, optional and always validated ---- */
      if (DO_NARRATE) {
        const n = await NARRATE.narrate(rec, {});
        rec = NARRATE.attach(rec, n);
        record('postgame_narration', key, !!n.ok, n.ok ? 'accepted (' + (n.model || 'model') + ')' : n.why, {});
        rec.article = POST.articleFor(rec);
      }
      rec.hero_image = GRAPHIC.forRecord(rec).data_uri;

      /* ---- the gate ---- */
      const q = QUALITY.inspect(rec, { now: NOW });
      rec.quality = { score: q.score, publishable: q.publishable,
        manual_review_required: q.manual_review_required, hold_reason: q.hold_reason,
        integrity_failed: q.integrity_failed, craft_failed: q.craft_failed, at: NOW };
      const verdict = AMODEL.publishable(rec);
      rec.checks = { ok: verdict.ok, failed: verdict.failed.map(f => ({ id: f.id, why: f.why })), at: NOW };
      if (verdict.ok && q.publishable) rec.status = 'ready';

      if (!q.publishable || !verdict.ok) {
        record('postgame_validation', key, false,
          q.hold_reason || ('article checks: ' + verdict.failed.map(f => f.id).join(', ')), { score: q.score });
        if (!DRY) ASTORE.save(rec);
        return { action: 'held', why: q.hold_reason || verdict.failed.map(f => f.id).join(', '),
          score: q.score, slug: rec.slug };
      }
      record('postgame_validation', key, true, 'quality ' + q.score, { score: q.score });

      /* ---- the lessons and the review candidates ---- */
      if (!DRY) {
        const l = STORE.saveLessons(lessons, { now: NOW });
        const cands = LESSONS.reviewCandidates(STORE.loadLessons(), STORE.loadReviews(), { now: NOW });
        STORE.saveReviews(cands, { now: NOW });
        record('research_lessons', key, true, l.added + ' new, ' + l.replaced + ' replaced, '
          + cands.filter(c => c.status !== 'closed').length + ' review candidate(s) open',
          { lessons: lessons.length });
      }

      /* ---- THE PUBLISHER, and LINK THE TWO HALVES ---- */
      /* Same single path as the pregame half: the postgame article is not a
         second kind of publication with its own rules. */
      const wantAuto = AUTO || STORE.settings().auto_publish_postgame;
      let pub = { ok: false, action: 'generated', record: rec, blocking: [], warnings: [] };
      if (!wantAuto) {
        record('postgame_generated', key, true,
          rec.slug + ' — auto-publish is switched off for postgame articles',
          { slug: rec.slug, score: q.score });
      } else {
        const storedAll = ASTORE.loadAll();
        const storedPost = storedAll.filter(x => x && x.id === rec.id)[0] || null;
        pub = PUBLISH.publish(rec, { now: NOW, quality: q, others: storedAll, previous: storedPost });
        rec = pub.record;
        if (pub.ok) {
          record('postgame_published', key, true, rec.slug + ' (' + pub.action + ')',
            { slug: rec.slug, score: q.score, url: rec.canonical_url, action: pub.action });
        } else {
          record('postgame_published', key, false, pub.reason,
            { slug: rec.slug, score: q.score, blocking: pub.blocking.map(b => b.id) });
        }
      }
      if (!DRY) {
        ASTORE.save(rec);
        /* the pregame article now points forward. It is frozen against
           RESEARCH changes; a link to its own sequel is not research, and a
           reader who found the pregame page months later should be able to
           reach what happened. */
        if (pre) {
          const next = Object.assign({}, pre);
          next.related = Object.assign({}, next.related || {}, {
            postgame_slug: rec.slug, postgame_url: rec.canonical_url,
            postgame_title: rec.title, postgame_id: rec.id
          });
          next.article = AMODEL.articleFor(next);
          ASTORE.save(next);
          record('link_pregame', key, true, pre.slug + ' → ' + rec.slug, {});
        }
      }
      return { action: wantAuto ? (pub.ok ? pub.action : 'manual_review') : 'generated',
        slug: rec.slug, score: q.score, status: rec.status, why: pub.ok ? null : (pub.reason || null),
        bet: graded.bet_headline, process: graded.process_headline, lessons: lessons.length };
    });
    if (res) out.push(Object.assign({ key }, res));
  }

  if (!DRY && out.length) ASTORE.saveIndex(ASTORE.loadAll(), { now: NOW });
  log('\nPOSTGAME · ' + rows.length + ' committed game(s) considered, ' + out.length + ' acted on');
  out.forEach(r => log('  ' + pad(r.action, 11) + pad(r.slug || r.key, 52)
    + (r.bet ? pad(r.bet + ' / ' + r.process, 22) : '')
    + (r.score != null ? 'quality ' + r.score : '') + (r.why ? '  — ' + r.why : '')));
  return out;
}

/* ==================================================================== */
/* PHASE 4 — MEMORY                                                      */
/* ==================================================================== */
function phaseMemory() {
  const lessons = STORE.loadLessons();
  const grades = STORE.allAudits().map(a => a && a.grading).filter(Boolean);
  const mem = LESSONS.memory({ lessons, grades, now: NOW });
  if (!DRY) STORE.writeJson(path.join(STORE.DIR, 'memory.json'), mem);
  record('memory', null, true, lessons.length + ' lessons over ' + grades.length + ' graded games', {});
  log('\nRESEARCH MEMORY · ' + lessons.length + ' lesson(s), ' + grades.length + ' graded game(s)');
  Object.keys(mem.answers).forEach(q => log('  ' + q + '\n      ' + mem.answers[q]));
  return mem;
}

/* ==================================================================== */
async function main() {
  log('EdgeDesk editorial pipeline · phase=' + PHASE + ' · ' + NOW
    + (DRY ? ' · DRY RUN' : '') + (NETWORK ? ' · network' : ' · offline'));

  let host = null;
  /* ---- THE DISPATCHER ----------------------------------------------- */
  /* Nothing below this point is cheap: booting the research terminal
     downloads the schedule feeds and the ratings. So when the caller asks
     --if-due we work out OFFLINE, from files already on disk, whether there
     is anything to do, and exit without booting if there is not.

     That is what lets the job run every fifteen minutes instead of every two
     hours. The old two-hour cron meant a deployment that landed at :26 waited
     until :25 of the hour after next before the system noticed it existed,
     and a Sunday-morning game whose window opened at :30 published ninety
     minutes late. A quarter-hourly tick that costs a few milliseconds when
     idle is strictly better than an hourly one that costs a feed download. */
  if (IF_DUE) {
    const due = whatIsDue(NOW);
    if (!due.due) {
      log('nothing is due: ' + due.summary);
      record('dispatch', null, true, 'nothing due — ' + due.summary, { skipped: true });
      if (!DRY) { STORE.appendRuns(entries, { now: NOW }); writeHealth(); }
      return { ok: true, due: false, entries };
    }
    log('due: ' + due.summary);
    record('dispatch', null, true, due.summary, { due: true });
  }

  const needsHost = PHASE === 'select' || PHASE === 'pregame' || PHASE === 'all';
  if (needsHost) {
    host = await step('boot', null, () => HOST.open({ network: NETWORK, quiet: QUIET }));
    if (!host) {
      record('boot', null, false, 'the research terminal would not boot; nothing was generated');
      if (!DRY) {
        STORE.appendRuns(entries, { now: NOW });
        if (retriesDirty) STORE.saveRetries(RETRIES, { now: NOW });
      }
      log('\nthe research terminal would not boot — nothing was generated');
      return { ok: false };
    }
    if (host.notes.refused.length) {
      log('  ' + host.notes.refused.length + ' source(s) not reachable in this run');
      record('sources', null, true, host.notes.refused.length + ' source(s) not reachable',
        { refused: host.notes.refused.slice(0, 8) });
    }
  }

  if (PHASE === 'select' || PHASE === 'all') await phaseSelect(host);
  if (PHASE === 'pregame' || PHASE === 'all') await phasePregame(host);
  if (PHASE === 'postgame' || PHASE === 'all') await phasePostgame();
  if (PHASE === 'backfill') phaseBackfill();
  if (PHASE === 'memory' || PHASE === 'all') phaseMemory();

  if (!DRY) {
    STORE.appendRuns(entries, { now: NOW });
    if (retriesDirty) STORE.saveRetries(RETRIES, { now: NOW });
    writeHealth();
  }
  const failed = entries.filter(e => !e.ok);
  log('\n' + entries.length + ' step(s) logged, ' + failed.length + ' not ok');
  failed.slice(0, 12).forEach(e => log('  ' + pad(e.step, 20) + pad(e.key || '', 30) + e.reason));
  return { ok: true, entries };
}

/* ==================================================================== */
/* PHASE 5 — BACKFILL                                                    */
/* ==================================================================== */
/* Run everything the editorial system already generated through the
   publisher once.

   WHY IT IS NEEDED ONCE. The pipeline generated articles for weeks with
   publication switched off, so the store holds complete, validated records
   sitting at `ready` that a reader has never been able to reach. Flipping the
   switch only helps the NEXT game; these need walking through the same door.

   WHY IT IS NOT "PUBLISH EVERYTHING". A pregame preview for a game that has
   already kicked off is worthless to a reader and dishonest to publish under
   today's date — the whole point of a pregame article is that it predates the
   game. Those are skipped with the reason stated, not published to make the
   numbers look better. A postgame audit has no such expiry: it is a record of
   what happened, and it is worth publishing whenever it is ready. */
function phaseBackfill() {
  const cfg = STORE.settings();
  const nowMs = Date.parse(NOW);
  const all = ASTORE.loadAll();
  /* the records this system owns: anything carrying a snapshot, plus every
     postgame article */
  const mine = all.filter(r => r && (r.snapshot_id || AMODEL.typeOf(r) === 'postgame'))
    .filter(r => !ONLY || ONLY === true || (r.featured && r.featured.key === ONLY));
  const out = [];

  for (const rec of mine) {
    const key = (rec.featured && rec.featured.key) || rec.id;
    if (PUBLISH.isPublic(rec)) {
      record('backfill', key, true, rec.slug + ' is already public', { skipped: true });
      continue;
    }
    if (rec.status === 'archived') {
      record('backfill', key, true, rec.slug + ' was archived on purpose', { skipped: true });
      continue;
    }
    const type = AMODEL.typeOf(rec);
    if (type === 'pregame') {
      const kick = Date.parse(rec.game_time);
      if (!isFinite(kick)) {
        record('backfill', key, false, rec.slug + ': no usable kickoff time');
        continue;
      }
      const cls = WINDOWS.classify({ kickoff_ms: kick, now_ms: nowMs, settings: cfg });
      if (cls.window === WINDOWS.WINDOW.AFTER_KICKOFF) {
        record('backfill', key, true, rec.slug
          + ': the game kicked off ' + Math.abs(cls.minutes_before_kickoff)
          + ' minutes ago — a preview published after its own game is worthless, so it is left unpublished',
          { skipped: true, window: cls.window });
        continue;
      }
      if (cls.window === WINDOWS.WINDOW.FINAL && !FORCE) {
        record('backfill', key, true, rec.slug + ': ' + cls.reason,
          { skipped: true, window: cls.window, forcible: true });
        continue;
      }
      /* a backfill cannot reach the research terminal (it runs offline), so it
         never publishes into the late window on stale prices — that needs the
         refresh, which needs the terminal */
      if (cls.window === WINDOWS.WINDOW.LATE && !FORCE) {
        record('backfill', key, true, rec.slug
          + ': in the late window, which needs a live refresh the backfill cannot do — the next pipeline run will handle it',
          { skipped: true, window: cls.window });
        continue;
      }
    }
    const q = QUALITY.inspect(rec, { now: NOW });
    const pub = PUBLISH.publish(rec, { now: NOW, quality: q, others: all, previous: rec });
    if (pub.ok) {
      record('backfill', key, true, pub.record.slug + ' published (' + pub.action + ')',
        { slug: pub.record.slug, url: pub.record.canonical_url, score: q.score });
      out.push({ key, slug: pub.record.slug, action: pub.action, score: q.score });
    } else {
      record('backfill', key, false, pub.record.slug + ': ' + pub.reason,
        { slug: pub.record.slug, blocking: pub.blocking.map(b => b.id) });
      out.push({ key, slug: pub.record.slug, action: 'manual_review', why: pub.reason });
    }
    if (!DRY) ASTORE.save(pub.record);
  }
  if (!DRY && out.length) ASTORE.saveIndex(ASTORE.loadAll(), { now: NOW });
  log('\nBACKFILL · ' + mine.length + ' editorial record(s) considered, ' + out.length + ' acted on');
  out.forEach(r => log('  ' + pad(r.action, 14) + pad(r.slug, 52)
    + (r.score != null ? 'quality ' + r.score : '') + (r.why ? '  — ' + r.why : '')));
  return out;
}

/* The operator console reads this file rather than re-deriving the lifecycle,
   so the panel and the pipeline can never disagree about what is happening. */
function writeHealth() {
  try {
    const HEALTH = require('./health.js');
    STORE.saveHealth(HEALTH.snapshot({ now: NOW }));
  } catch (e) {
    log('  [health] could not write the health snapshot: ' + (e && e.message));
  }
}

/* ==================================================================== */
/* THE DISPATCH DECISION — offline, from files already on disk           */
/* ==================================================================== */
/* Returns what (if anything) this moment owes the pipeline. It reads
   featured.json, the snapshots, the run log and the retry ledger; it opens no
   socket and boots nothing, so it is safe to call every few minutes. */
function whatIsDue(now) {
  const cfg = STORE.settings();
  const nowMs = Date.parse(now);
  const runs = STORE.loadRuns();
  const retries = STORE.loadRetries();
  const featured = STORE.loadFeatured();
  const reasons = [];

  /* SELECT — the board is rescored when the stored decision has gone stale.
     A slate that has not been looked at for six hours may have picked up new
     games, moved kickoffs or moved lines. */
  const staleHours = cfg.select_interval_hours != null ? cfg.select_interval_hours : 6;
  const generatedAt = featured.generated_at ? Date.parse(featured.generated_at) : NaN;
  const selectDue = !isFinite(generatedAt) || (nowMs - generatedAt) / 3600000 >= staleHours;
  if (selectDue) {
    reasons.push(!isFinite(generatedAt) ? 'no featured board yet'
      : 'the board was scored ' + ((nowMs - generatedAt) / 3600000).toFixed(1) + 'h ago');
  }

  /* PREGAME — any featured game inside its publication window that has not
     been published and is not backing off from a failure. */
  const pregame = [];
  featured.games.filter(FEATURED.isFeatured)
    .filter(g => g.pregame_enabled !== false)
    .forEach(g => {
      const kick = Date.parse(g.game_time);
      if (!isFinite(kick)) return;
      const leadH = (kick - nowMs) / 3600000;
      const cls = WINDOWS.classify({ kickoff_ms: kick, now_ms: nowMs, settings: cfg,
        due_at_minutes: leadFor(cfg, g) * 60 });
      /* NORMAL and LATE are both work; NOT_DUE, FINAL and AFTER_KICKOFF are
         not. The late window is the whole point of waking every 15 minutes. */
      if (WINDOWS.AUTO_PUBLISHABLE.indexOf(cls.window) < 0) return;
      if (STORE.alreadyDone(runs, g.key, 'pregame_published')) return;
      if (!STORE.retryDue(retries, g.key, 'pregame', now).due) return;
      pregame.push(g.key);
    });
  if (pregame.length) reasons.push(pregame.length + ' pregame article(s) in window');

  /* POSTGAME — any committed game that has finished, allowing the settle
     delay, and has not been audited. */
  const postgame = [];
  const settleMin = cfg.postgame_settle_minutes || 20;
  STORE.committedGames().forEach(g => {
    const kick = Date.parse(g.game_time);
    if (!isFinite(kick)) return;
    /* a game cannot be final before it has plausibly finished: kickoff plus a
       conservative game length plus the settle delay */
    if (nowMs < kick + (3.5 * 3600000) + settleMin * 60000) return;
    if (STORE.alreadyDone(runs, g.key, 'postgame_published')) return;
    if (!STORE.retryDue(retries, g.key, 'postgame', now).due) return;
    postgame.push(g.key);
  });
  if (postgame.length) reasons.push(postgame.length + ' postgame audit(s) ready');

  const due = selectDue || pregame.length > 0 || postgame.length > 0;
  return {
    due, select: selectDue, pregame, postgame,
    summary: due ? reasons.join('; ') : 'no board rescore, no article in window, no audit ready',
  };
}

module.exports = { main, phaseSelect, phasePregame, phasePostgame, phaseMemory, phaseBackfill,
  leadFor, ranksFromRankings, featuredSummary, whatIsDue };

if (require.main === module) {
  main().then(r => process.exit(r && r.ok === false ? 1 : 0)).catch(e => {
    console.error('editorial run failed: ' + (e && e.stack || e));
    process.exit(1);
  });
}
