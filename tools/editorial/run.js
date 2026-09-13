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
/* Every step goes through this, so one game blowing up never takes a run with
   it and the failure is a logged failure rather than a stack trace. */
async function step(name, key, fn) {
  try { return await fn(); }
  catch (e) {
    record(name, key, false, 'threw: ' + (e && e.message ? String(e.message).slice(0, 300) : String(e)),
      { error: true });
    log('  ' + pad('FAILED', 12) + pad(name, 18) + (key || '') + ' — ' + (e && e.message));
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

    /* SCHEDULING. Each window has its own lead time, configurable in
       articles/data/editorial/featured.json without touching code. A game
       further out than its lead is not late — it is not due yet. */
    const want = leadFor(cfg, g);
    if (leadH > want) {
      record('pregame', key, true, 'not due yet: ' + leadH.toFixed(1) + 'h out, this window publishes at ' + want + 'h',
        { skipped: true });
      continue;
    }
    if (leadH * 60 < (cfg.pregame_min_lead_minutes || 90)) {
      record('pregame', key, false, 'too close to kickoff: ' + Math.round(leadH * 60)
        + ' minutes left, the floor is ' + cfg.pregame_min_lead_minutes);
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
      if (rec.status === 'draft' && verdict.ok && q.publishable) rec.status = 'ready';
      if (rec.status === 'ready' && !(verdict.ok && q.publishable)) rec.status = 'draft';

      if (!q.publishable) {
        record('pregame_validation', key, false, q.hold_reason, { score: q.score });
        if (!DRY) { ASTORE.save(rec); byId[id] = rec; }
        return { action: 'held', why: q.hold_reason, score: q.score, slug: rec.slug };
      }
      record('pregame_validation', key, true, 'quality ' + q.score, { score: q.score });

      /* ---- publish, or hold for a person ---- */
      if (AUTO || STORE.settings().auto_publish_pregame) {
        rec = AMODEL.publish(rec, NOW);
        record('pregame_published', key, true, rec.slug, { slug: rec.slug, score: q.score });
        action = 'published';
      } else {
        record('pregame_generated', key, true, rec.slug + ' — held for an operator (auto-publish off)',
          { slug: rec.slug, score: q.score });
      }
      if (!DRY) { ASTORE.save(rec); byId[id] = rec; articles.push(rec); }
      return { action, slug: rec.slug, score: q.score, status: rec.status, theses: rec.theses.length };
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

function leadFor(cfg, g) {
  const byWindow = (cfg.pregame_lead_hours || {})[g.sport] || {};
  return byWindow[g.window_key] != null ? byWindow[g.window_key]
    : (byWindow.default != null ? byWindow.default : 12);
}
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
  const rows = STORE.loadFeatured().games.filter(FEATURED.isFeatured)
    .filter(g => g.postgame_enabled !== false)
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
    const snap = STORE.latestSnapshot(key);
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

      /* ---- publish, and LINK THE TWO HALVES ---- */
      if (AUTO || STORE.settings().auto_publish_postgame) {
        rec = AMODEL.publish(rec, NOW);
        record('postgame_published', key, true, rec.slug, { slug: rec.slug, score: q.score });
      } else {
        record('postgame_generated', key, true, rec.slug + ' — held for an operator (auto-publish off)',
          { slug: rec.slug, score: q.score });
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
      return { action: (AUTO || STORE.settings().auto_publish_postgame) ? 'published' : 'generated',
        slug: rec.slug, score: q.score, status: rec.status,
        bet: graded.bet_headline, process: graded.process_headline, lessons: lessons.length };
    });
    if (res) out.push(Object.assign({ key }, res));
  }

  if (!DRY && out.length) ASTORE.saveIndex(ASTORE.loadAll(), { now: NOW });
  log('\nPOSTGAME · ' + rows.length + ' featured game(s) considered, ' + out.length + ' acted on');
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
  const needsHost = PHASE === 'select' || PHASE === 'pregame' || PHASE === 'all';
  if (needsHost) {
    host = await step('boot', null, () => HOST.open({ network: NETWORK, quiet: QUIET }));
    if (!host) {
      record('boot', null, false, 'the research terminal would not boot; nothing was generated');
      if (!DRY) STORE.appendRuns(entries, { now: NOW });
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
  if (PHASE === 'memory' || PHASE === 'all') phaseMemory();

  if (!DRY) STORE.appendRuns(entries, { now: NOW });
  const failed = entries.filter(e => !e.ok);
  log('\n' + entries.length + ' step(s) logged, ' + failed.length + ' not ok');
  failed.slice(0, 12).forEach(e => log('  ' + pad(e.step, 20) + pad(e.key || '', 30) + e.reason));
  return { ok: true, entries };
}

module.exports = { main, phaseSelect, phasePregame, phasePostgame, phaseMemory,
  leadFor, ranksFromRankings, featuredSummary };

if (require.main === module) {
  main().then(r => process.exit(r && r.ok === false ? 1 : 0)).catch(e => {
    console.error('editorial run failed: ' + (e && e.stack || e));
    process.exit(1);
  });
}
