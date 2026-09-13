#!/usr/bin/env node
/* ============================================================================
   THE EDITORIAL STORE — featured games, snapshots, results, audits, lessons
   and the run log, on disk, in the repository.

   SAME DECISION AS tools/articles/store.js, AND FOR THE SAME REASON. EdgeDesk
   is a static site with no server. Making the repository the store means every
   featured decision is a commit, every snapshot is a file somebody can open
   two months later, and every research lesson is a diff rather than a row in a
   database nobody can reach from a laptop. Supabase carries the same rows
   where it is reachable (supabase/editorial_system.sql) so an operator can
   change a decision from a phone; neither half needs the other to work.

   LAYOUT
     articles/data/editorial/featured.json        one row per scored game
     articles/data/editorial/rivalries.json       the operator-curated list
     articles/data/editorial/snapshots/<id>.json  immutable pregame snapshots
     articles/data/editorial/results/<key>.json   final score + box score
     articles/data/editorial/audits/<key>.json    theses + audit + grading
     articles/data/editorial/lessons.json         the research memory
     articles/data/editorial/reviews.json         model-review candidates
     articles/data/editorial/runs.json            the observability log

   THE ONE RULE THIS FILE ENFORCES ITSELF: a snapshot is written ONCE. Writing
   a second one under the same id with different content is refused, loudly,
   because the entire postgame audit rests on the pregame state not having
   moved. Everything else here is ordinary read/write.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const SNAP = require('./snapshot.js');

const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(ROOT, 'articles', 'data', 'editorial');
const SNAPSHOTS = path.join(DIR, 'snapshots');
const RESULTS = path.join(DIR, 'results');
const AUDITS = path.join(DIR, 'audits');
const FEATURED = path.join(DIR, 'featured.json');
const RIVALRIES = path.join(DIR, 'rivalries.json');
const LESSONS = path.join(DIR, 'lessons.json');
const REVIEWS = path.join(DIR, 'reviews.json');
const RUNS = path.join(DIR, 'runs.json');

/* The run log is a ring: an observability log that grows without bound turns
   into a file nobody opens and a diff nobody reads. */
const RUN_LOG_MAX = 400;

const DEFAULT_SETTINGS = {
  /* editorial_priority at or above this earns a research trail. Per sport,
     because a college Saturday and an NFL Sunday are different slates. */
  thresholds: { NFL: 30, CFB: 35 },
  /* AND A WEEKLY CAP. The floor removes what is not worth a permanent trail;
     the cap is the editorial decision about how much a desk runs in a week.
     Both are here rather than in code so neither needs a deploy to change. */
  weekly_caps: { NFL: 4, CFB: 6 },
  /* how long before kickoff the pregame article is generated, by window. The
     product brief's schedule, expressed in hours of lead time and configurable
     without touching code. */
  pregame_lead_hours: {
    NFL: { thursday_night: 9, sunday_night: 7, monday_night: 7, sunday_early: 16, sunday_late: 16, default: 12 },
    CFB: { saturday_night: 12, saturday_afternoon: 14, saturday_early: 16, friday_night: 10, thursday_night: 9, default: 14 }
  },
  /* and the window inside which a pregame article may still be published */
  pregame_min_lead_minutes: 90,
  /* how long after a final to wait for a provider's box score to settle */
  postgame_settle_minutes: 20,
  /* how many core team statistics must be published on both sides */
  postgame_min_core_metrics: 5,
  /* publish automatically, or generate and hold for a person */
  auto_publish_pregame: false,
  auto_publish_postgame: false,
  /* the quality floor below which nothing publishes automatically */
  quality_floor: 70
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return file;
}
/* A store key is "SPORT:game_id"; a filename cannot carry a colon on every
   filesystem, so one rule converts between them and is used everywhere. */
function fileKey(key) { return String(key).replace(/[^A-Za-z0-9._-]+/g, '_'); }

/* ------------------------------------------------------------- featured */
function loadFeatured() {
  const j = readJson(FEATURED, null);
  if (!j) return { schema: 'edgedesk_featured_games_v1', generated_at: null,
    settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), games: [] };
  j.settings = Object.assign({}, DEFAULT_SETTINGS, j.settings || {});
  j.settings.thresholds = Object.assign({}, DEFAULT_SETTINGS.thresholds, j.settings.thresholds || {});
  j.settings.weekly_caps = Object.assign({}, DEFAULT_SETTINGS.weekly_caps, j.settings.weekly_caps || {});
  j.settings.pregame_lead_hours = Object.assign({}, DEFAULT_SETTINGS.pregame_lead_hours, j.settings.pregame_lead_hours || {});
  j.games = Array.isArray(j.games) ? j.games : [];
  return j;
}
function settings() { return loadFeatured().settings; }
function saveFeatured(games, opts) {
  opts = opts || {};
  const prior = loadFeatured();
  const out = {
    schema: 'edgedesk_featured_games_v1',
    generated_at: opts.now ? new Date(opts.now).toISOString() : new Date().toISOString(),
    settings: Object.assign({}, prior.settings, opts.settings || {}),
    counts: {
      scored: games.length,
      featured: games.filter(g => g.status === 'featured').length,
      excluded: games.filter(g => g.status === 'excluded').length,
      manual: games.filter(g => g.manual_override).length
    },
    note: 'Scored by tools/editorial/featured.js. `auto_selected` is what the scorer decided; `manual_override` is what an operator decided, and the operator always wins. Every component of every score is stored beside it so a ranking can be argued with.',
    games: games
  };
  writeJson(FEATURED, out);
  return out;
}
function featuredByKey() {
  const map = Object.create(null);
  loadFeatured().games.forEach(g => { if (g && g.key) map[g.key] = g; });
  return map;
}
function loadRivalries() {
  const j = readJson(RIVALRIES, null);
  return (j && Array.isArray(j.rivalries)) ? j.rivalries : [];
}

/* ------------------------------------------------------------ snapshots */
function snapshotFile(id) { return path.join(SNAPSHOTS, fileKey(id) + '.json'); }
function loadSnapshot(id) { return readJson(snapshotFile(id), null); }
/* WRITE ONCE. A snapshot id is a content hash, so the same research produces
   the same id and the same bytes — writing it again is a no-op and that is
   what makes the capture step idempotent under a cron job that ran twice. An
   id that already exists with DIFFERENT content is a bug somewhere upstream
   and is refused rather than resolved. */
function saveSnapshot(snap) {
  if (!snap || !snap.snapshot_id) throw new Error('a snapshot needs an id');
  const file = snapshotFile(snap.snapshot_id);
  const have = readJson(file, null);
  if (have) {
    if (SNAP.sameContent(have, snap)) return { written: false, reason: 'identical snapshot already stored', file };
    const e = new Error('REFUSED: snapshot ' + snap.snapshot_id
      + ' already exists with different content. A snapshot is immutable by construction; something has changed how it is hashed.');
    e.code = 'SNAPSHOT_IMMUTABLE';
    throw e;
  }
  writeJson(file, snap);
  return { written: true, file };
}
/* The snapshot a game's article was written from — the LATEST captured before
   kickoff, which is the one the article cites. */
function snapshotsFor(key) {
  if (!fs.existsSync(SNAPSHOTS)) return [];
  return fs.readdirSync(SNAPSHOTS).filter(f => f.endsWith('.json'))
    .map(f => readJson(path.join(SNAPSHOTS, f), null))
    .filter(s => s && s.key === key)
    .sort((a, b) => String(a.captured_at).localeCompare(String(b.captured_at)));
}
function latestSnapshot(key) {
  const all = snapshotsFor(key);
  return all.length ? all[all.length - 1] : null;
}

/* -------------------------------------------------------------- results */
function resultFile(key) { return path.join(RESULTS, fileKey(key) + '.json'); }
function loadResult(key) { return readJson(resultFile(key), null); }
function saveResult(res) {
  if (!res || !res.key) throw new Error('a result needs a key');
  writeJson(resultFile(res.key), res);
  return res;
}
function allResults() {
  if (!fs.existsSync(RESULTS)) return [];
  return fs.readdirSync(RESULTS).filter(f => f.endsWith('.json'))
    .map(f => readJson(path.join(RESULTS, f), null)).filter(Boolean);
}

/* --------------------------------------------------------------- audits */
function auditFile(key) { return path.join(AUDITS, fileKey(key) + '.json'); }
function loadAudit(key) { return readJson(auditFile(key), null); }
function saveAudit(a) {
  if (!a || !a.key) throw new Error('an audit needs a key');
  writeJson(auditFile(a.key), a);
  return a;
}
function allAudits() {
  if (!fs.existsSync(AUDITS)) return [];
  return fs.readdirSync(AUDITS).filter(f => f.endsWith('.json'))
    .map(f => readJson(path.join(AUDITS, f), null)).filter(Boolean);
}

/* -------------------------------------------------------------- lessons */
function loadLessons() {
  const j = readJson(LESSONS, null);
  return (j && Array.isArray(j.lessons)) ? j.lessons : [];
}
/* Lessons are keyed by their own deterministic id, so re-running the postgame
   step on a game replaces that game's rows rather than duplicating them. */
function saveLessons(rows, opts) {
  opts = opts || {};
  const have = loadLessons();
  const byId = Object.create(null);
  have.forEach(l => { if (l && l.id) byId[l.id] = l; });
  let added = 0, replaced = 0;
  (rows || []).forEach(l => {
    if (!l || !l.id) return;
    if (byId[l.id]) replaced++; else added++;
    byId[l.id] = l;
  });
  const all = Object.keys(byId).map(k => byId[k])
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  writeJson(LESSONS, {
    schema: 'edgedesk_game_research_lessons_v1',
    generated_at: opts.now ? new Date(opts.now).toISOString() : new Date().toISOString(),
    count: all.length,
    note: 'Produced by tools/editorial/lessons.js from published postgame audits. NOTHING IN THIS REPOSITORY CHANGES A MODEL WEIGHT FROM THESE ROWS. A lesson may open a model-review candidate in reviews.json; only a person closes one.',
    lessons: all
  });
  return { added, replaced, total: all.length };
}

/* ------------------------------------------------- model-review candidates */
function loadReviews() {
  const j = readJson(REVIEWS, null);
  return (j && Array.isArray(j.candidates)) ? j.candidates : [];
}
function saveReviews(rows, opts) {
  opts = opts || {};
  writeJson(REVIEWS, {
    schema: 'edgedesk_model_review_candidates_v1',
    generated_at: opts.now ? new Date(opts.now).toISOString() : new Date().toISOString(),
    open: (rows || []).filter(c => c.status !== 'closed').length,
    count: (rows || []).length,
    note: 'A candidate is a QUESTION WITH EVIDENCE ATTACHED. It is raised automatically when a published claim carrying real weight is contradicted by a game, and it is closed only by a person writing a disposition on it. No production model weight is changed from this file by anything in this repository.',
    candidates: rows || []
  });
  return rows;
}

/* ------------------------------------------------------------ the run log */
/* ONE LINE PER STEP, so a failure two Sundays ago is still readable. Each
   entry carries the run id, the step, the game, the outcome and the reason —
   which is what an operator needs and is more than most pipelines keep. */
function loadRuns() {
  const j = readJson(RUNS, null);
  return (j && Array.isArray(j.runs)) ? j.runs : [];
}
function appendRuns(entries, opts) {
  opts = opts || {};
  const have = loadRuns();
  const all = have.concat(entries || []).slice(-RUN_LOG_MAX);
  writeJson(RUNS, {
    schema: 'edgedesk_editorial_runs_v1',
    generated_at: opts.now ? new Date(opts.now).toISOString() : new Date().toISOString(),
    kept: all.length, max: RUN_LOG_MAX,
    note: 'The editorial pipeline’s own log, newest last, bounded to the last ' + RUN_LOG_MAX
      + ' entries. Every step every run takes appears here whether it succeeded or not, so "why did this game not get an article?" has an answer.',
    runs: all
  });
  return all.length;
}

/* An idempotency key for one step on one game in one pipeline phase. The run
   log is the lock: a step that has already succeeded for a given key in the
   current phase is not run again, which is what stops a cron job firing twice
   from producing two articles. */
function alreadyDone(runs, key, step, opts) {
  opts = opts || {};
  const since = opts.since ? Date.parse(opts.since) : 0;
  return (runs || []).some(r => r && r.key === key && r.step === step && r.ok
    && (!since || Date.parse(r.at) >= since));
}

module.exports = {
  ROOT, DIR, SNAPSHOTS, RESULTS, AUDITS, FEATURED, RIVALRIES, LESSONS, REVIEWS, RUNS,
  DEFAULT_SETTINGS, RUN_LOG_MAX,
  readJson, writeJson, fileKey,
  loadFeatured, settings, saveFeatured, featuredByKey, loadRivalries,
  snapshotFile, loadSnapshot, saveSnapshot, snapshotsFor, latestSnapshot,
  resultFile, loadResult, saveResult, allResults,
  auditFile, loadAudit, saveAudit, allAudits,
  loadLessons, saveLessons, loadReviews, saveReviews,
  loadRuns, appendRuns, alreadyDone
};
