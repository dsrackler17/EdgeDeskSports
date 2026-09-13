#!/usr/bin/env node
/* ============================================================================
   THE PUBLISHER — the one and only path from a generated record to a page a
   stranger can open.

   WHY THIS FILE EXISTS. Before it, "publish" was two lines inlined in the
   pregame phase and two more inlined in the postgame phase of run.js:

       if (AUTO || STORE.settings().auto_publish_pregame) {
         rec = AMODEL.publish(rec, NOW);

   Two copies of a decision means two places for it to drift, and neither copy
   checked anything beyond the flag — the quality gate had already run, so the
   publish step itself vouched for nothing. Anything else that ever wanted to
   publish (a backfill, an operator override, a retry) would have been a third
   copy. This is the single authoritative transition, and every caller goes
   through it.

   THE DEFAULT IS PUBLISH. An article that passes generation, factual
   integrity and the quality floor is published without a person. Manual
   review is what happens when a stated condition fires, not what happens by
   default. That inversion is the whole point of this file: the old code held
   EVERYTHING and called the flag "auto-publish off", which is a system that
   generates articles nobody ever reads.

   BLOCKING vs ADVISORY. A blocking condition is one where publishing would
   put something false, broken or duplicated in front of a reader. Everything
   else is a warning: it is recorded, it is visible to the operator, and it
   does NOT stop publication. A meta description eight characters longer than
   preferred has never made an article wrong.

   IDEMPOTENT BY CONSTRUCTION. publish() on an already-published record keeps
   the original published_at, does not touch updated_at unless the document
   actually changed, and returns action 'unchanged'. Two cron runs racing the
   same game produce one article with one publication date.

   VALIDATE, THEN WRITE. Every check runs against the fully assembled record
   BEFORE the status moves, so there is no window in which the store says
   published and the page has no body. The caller writes once, after this
   returns ok.
   ========================================================================== */
'use strict';

const AMODEL = require('../articles/article_model.js');
const QUALITY = require('./quality.js');

/* --------------------------------------------------------------- lifecycle */
/* THE STATE MACHINE. `status` was an arbitrary string with five legal values
   and no rules about moving between them; run.js and generate.js each nudged
   it with their own pair of if-statements. These are the transitions that
   actually make sense, and canTransition() is what enforces them.

     draft          generation is incomplete, or validation has not run yet.
                    NOT "an automated article at rest" — that was the bug.
     ready          validated and publishable; waiting only on its window.
     published      public. The page exists, the sitemap lists it.
     manual_review  a blocking condition a person has to clear. Distinct from
                    draft so that "nobody has looked at this" and "this needs
                    a human" are never the same state.
     archived       withdrawn. Never public again without an explicit move.
     updated        legacy, carried so old records still load. Treated as
                    published everywhere public. */
const STATUS = {
  DRAFT: 'draft', READY: 'ready', READY_TOO_LATE: 'ready_too_late', PUBLISHED: 'published',
  MANUAL_REVIEW: 'manual_review', ARCHIVED: 'archived', UPDATED: 'updated',
};
const ALL_STATUSES = [STATUS.DRAFT, STATUS.READY, STATUS.READY_TOO_LATE, STATUS.PUBLISHED,
  STATUS.MANUAL_REVIEW, STATUS.ARCHIVED, STATUS.UPDATED];

/* A status that a reader can reach. */
const PUBLIC_STATUSES = [STATUS.PUBLISHED, STATUS.UPDATED];
function isPublic(rec) { return !!rec && PUBLIC_STATUSES.indexOf(rec.status) >= 0; }

const TRANSITIONS = {
  draft:          ['draft', 'ready', 'ready_too_late', 'manual_review', 'archived'],
  ready:          ['ready', 'ready_too_late', 'published', 'draft', 'manual_review', 'archived'],
  /* READY_TOO_LATE is a TIMING hold, not a defect: complete, validated
     research that arrived inside the final pregame floor. An operator may
     still force it out, so `published` is reachable; once the game starts it
     simply stays where it is and the game is audited instead. */
  ready_too_late: ['ready_too_late', 'published', 'archived', 'manual_review', 'draft'],
  published:      ['published', 'updated', 'archived', 'draft'],
  updated:        ['updated', 'published', 'archived', 'draft'],
  manual_review:  ['manual_review', 'ready', 'draft', 'published', 'archived'],
  archived:       ['archived', 'draft'],
};
function canTransition(from, to) {
  if (ALL_STATUSES.indexOf(to) < 0) return false;
  const allowed = TRANSITIONS[from] || TRANSITIONS.draft;
  return allowed.indexOf(to) >= 0;
}

function nowIso(now) { return now ? new Date(now).toISOString() : new Date().toISOString(); }
function txt(v) { if (v == null) return null; const s = String(v).replace(/\s+/g, ' ').trim(); return s || null; }

/* -------------------------------------------------------------- the checks */
/* Every reason an article must not go public, each with a stable id so the
   run log and the operator console can name it rather than saying "draft".

   `others` is every OTHER record in the store, used only for the duplicate
   test. Passing it is optional; without it that one check is skipped and says
   so rather than silently passing. */
function preflight(rec, opts) {
  opts = opts || {};
  const blocking = [], warnings = [];
  function block(id, ok, why, detail) { if (!ok) blocking.push({ id, why, detail: detail || null }); }
  function warn(id, ok, why, detail) { if (!ok) warnings.push({ id, why, detail: detail || null }); }

  /* ---- the record exists and is the shape we think it is ---- */
  if (!rec || typeof rec !== 'object') {
    return { ok: false, blocking: [{ id: 'no_record', why: 'there is no article record to publish', detail: null }],
      warnings: [], type: null, quality: null };
  }
  const type = AMODEL.typeOf(rec);

  block('archived', rec.status !== STATUS.ARCHIVED,
    'an archived article was withdrawn on purpose and is not republished by a cron job');
  block('operator_hold', !rec.manual_review_required,
    'an operator marked this article as requiring review',
    txt(rec.manual_review_reason));

  /* ---- generation actually finished ---- */
  const a = (rec.article || {});
  block('generation_complete', (a.sections || []).length > 0,
    'the article has no sections, so generation did not finish');
  block('body', ((a.bottom_line && a.bottom_line.paragraphs) || []).length > 0
    || (a.sections || []).length > 0,
    'the article has no body');
  block('title', !!txt(rec.title) && String(rec.title).length > 15,
    'an article needs a headline');
  block('slug', !!rec.slug && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rec.slug),
    'the slug must be lower-case, hyphenated and free of random ids', rec.slug || null);
  block('canonical', !!rec.canonical_url && /^https?:\/\/[^\s]+\/articles\//.test(rec.canonical_url),
    'every article canonicalises to its own clean URL', rec.canonical_url || null);

  /* SEO metadata is required to EXIST, not to be a particular length. A meta
     description slightly over the preferred width is a warning; an article
     with none at all cannot be indexed properly and is blocked. */
  block('seo_description_present', !!txt(rec.seo_description),
    'an article needs a meta description');
  warn('seo_description_length',
    !rec.seo_description || (rec.seo_description.length >= 50 && rec.seo_description.length <= 200),
    'the meta description reads best between 50 and 200 characters',
    rec.seo_description ? rec.seo_description.length + ' characters' : null);

  /* ---- the per-type publication checks the model already owns ---- */
  const verdict = AMODEL.publishable(rec);
  block('model_checks', verdict.ok,
    'the article model refused this record',
    verdict.failed.map(f => f.id).join(', ') || null);

  /* ---- the evidence each type must carry ---- */
  if (type === 'pregame') {
    block('snapshot', !!rec.snapshot_id,
      'a pregame article must cite the immutable snapshot it was built from');
  } else if (type === 'postgame') {
    const res = rec.result || {};
    block('final_data', res.home_score != null && res.away_score != null,
      'a postgame article must carry the final score it audits');
    block('final_completed', res.completed === true,
      'no source called this game final');
    block('snapshot', !!(rec.snapshot && rec.snapshot.snapshot_id),
      'a postgame article must carry the pregame snapshot it audits');
  }

  /* ---- the quality gate: integrity blocks, craft scores ---- */
  const q = opts.quality || QUALITY.inspect(rec, { now: opts.now });
  block('factual_integrity', !(q.integrity_failed || []).length,
    'a factual-integrity check failed',
    (q.integrity_failed || []).map(f => f.id).join(', ') || null);
  block('quality_floor', q.score >= (q.floor != null ? q.floor : 70),
    'the quality score is below the floor',
    q.score + ' < ' + (q.floor != null ? q.floor : 70));
  (q.craft_failed || []).forEach(c => {
    warn('craft_' + (c.id || 'unknown'), false, c.why || 'a craft check failed', c.detail || null);
  });

  /* ---- one published article per game and type ---- */
  /* A second published page for the same game and the same kind of article is
     a duplicate a reader can find, and two URLs competing for the same query.
     Comparing by id as well means re-publishing THIS record never counts as
     its own duplicate. */
  if (Array.isArray(opts.others)) {
    const gid = rec.game_id != null ? String(rec.game_id) : null;
    const dupe = gid ? opts.others.filter(o =>
      o && o.id !== rec.id && isPublic(o)
      && String(o.game_id) === gid && AMODEL.typeOf(o) === type) : [];
    block('no_duplicate', !dupe.length,
      'another article for this game and type is already published',
      dupe.map(d => d.slug).join(', ') || null);
  } else {
    warnings.push({ id: 'duplicate_check_skipped',
      why: 'the caller passed no record list, so the duplicate test could not run', detail: null });
  }

  return { ok: !blocking.length, blocking, warnings, type, quality: q };
}

/* ------------------------------------------------------------- the publish */
/* The one authoritative transition. Returns the record to save and what it
   did; it never writes, so the caller owns the single write and a dry run is
   simply a caller that does not perform it.

     action  'published'   it was not public, now it is
             'unchanged'   already public and the document did not change
             'republished' already public, the document changed, updated_at moved
             'held'        a blocking condition fired; status is manual_review
*/
function publish(rec, opts) {
  opts = opts || {};
  const t = nowIso(opts.now);
  const pre = preflight(rec, opts);

  if (!pre.ok) {
    /* HELD, WITH A REASON — never a silent draft. A blocking condition puts
       the record in manual_review and writes the reasons onto it, so the run
       log, the admin console and the record itself all say the same thing. */
    const held = Object.assign({}, rec);
    const to = canTransition(held.status || STATUS.DRAFT, STATUS.MANUAL_REVIEW)
      ? STATUS.MANUAL_REVIEW : (held.status || STATUS.DRAFT);
    /* An already-published article is NOT yanked offline by a later blocking
       condition — withdrawing a live page is an operator's decision, not a
       cron job's. It keeps its status and the reasons are recorded. */
    held.status = isPublic(rec) ? rec.status : to;
    held.publish_state = {
      ok: false, at: t,
      blocking: pre.blocking.map(b => ({ id: b.id, why: b.why, detail: b.detail })),
      warnings: pre.warnings.map(w => ({ id: w.id, why: w.why, detail: w.detail })),
      hold_reason: pre.blocking.map(b => b.id).join(', '),
    };
    held.updated_at = t;
    return { ok: false, action: 'held', record: held, status: held.status,
      blocking: pre.blocking, warnings: pre.warnings,
      reason: pre.blocking.map(b => b.id + ': ' + b.why).join(' · '), quality: pre.quality };
  }

  /* ---- it passes ---- */
  const already = isPublic(rec);
  const next = Object.assign({}, rec);
  next.status = STATUS.PUBLISHED;
  /* PUBLISHED_AT IS STAMPED ONCE. A republish keeps the original date because
     a reader and a crawler both need to know it is the same document. */
  next.published_at = rec.published_at || t;
  next.publish_state = {
    ok: true, at: t, blocking: [],
    warnings: pre.warnings.map(w => ({ id: w.id, why: w.why, detail: w.detail })),
    hold_reason: null,
  };

  if (already) {
    /* Idempotence: republishing an unchanged document must not move
       updated_at, or every cron run would look like an edit to a crawler.

       THE COMPARISON IS AGAINST WHAT IS STORED, not against the record we
       were handed. Comparing `rec` to `next` compares the input to a copy of
       itself that differs only in the fields stripped below, so it can only
       ever answer "unchanged" — the caller passes the stored version as
       opts.previous. With no previous supplied the conservative answer is
       "unchanged", which leaves updated_at alone rather than inventing an
       edit a crawler would have to re-fetch. */
    const changed = documentChanged(opts.previous || rec, next);
    if (!changed) {
      next.updated_at = rec.updated_at || t;
      return { ok: true, action: 'unchanged', record: next, status: next.status,
        blocking: [], warnings: pre.warnings, quality: pre.quality };
    }
    next.updated_at = t;
    return { ok: true, action: 'republished', record: next, status: next.status,
      blocking: [], warnings: pre.warnings, quality: pre.quality };
  }

  next.updated_at = t;
  return { ok: true, action: 'published', record: next, status: next.status,
    blocking: [], warnings: pre.warnings, quality: pre.quality };
}

/* Did anything a reader would see actually change? publish_state, updated_at
   and the quality block are bookkeeping, not the document. */
function documentChanged(before, after) {
  const strip = r => {
    const c = Object.assign({}, r);
    delete c.publish_state; delete c.updated_at; delete c.quality; delete c.checks;
    delete c.status; delete c.published_at; delete c.retry;
    return JSON.stringify(c);
  };
  return strip(before) !== strip(after);
}

/* ------------------------------------------------------------- withdrawals */
function unpublish(rec, opts) {
  opts = opts || {};
  const t = nowIso(opts.now);
  const next = Object.assign({}, rec);
  next.status = STATUS.DRAFT;
  next.updated_at = t;
  next.publish_state = { ok: false, at: t, blocking: [],
    warnings: [], hold_reason: txt(opts.reason) || 'withdrawn by an operator' };
  return next;
}
function archive(rec, opts) {
  opts = opts || {};
  const t = nowIso(opts.now);
  const next = Object.assign({}, rec);
  next.status = STATUS.ARCHIVED;
  next.updated_at = t;
  return next;
}
/* An operator clearing a manual-review hold. It does NOT publish — it returns
   the record to the pipeline, which re-runs every check on the next pass. */
function clearReview(rec, opts) {
  opts = opts || {};
  const next = Object.assign({}, rec);
  next.manual_review_required = false;
  next.manual_review_reason = null;
  next.status = isPublic(rec) ? rec.status : STATUS.DRAFT;
  next.updated_at = nowIso(opts.now);
  return next;
}

module.exports = {
  STATUS, ALL_STATUSES, PUBLIC_STATUSES, TRANSITIONS,
  isPublic, canTransition, preflight, publish, unpublish, archive, clearReview,
  documentChanged,
};
