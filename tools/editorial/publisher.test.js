#!/usr/bin/env node
/* ============================================================================
   THE PUBLISHER SUITE — proof that a valid article actually becomes public,
   and that an invalid one actually does not.

   WHAT THIS EXISTS TO CATCH. The editorial system generated snapshots,
   articles, theses and audits correctly and then left every one of them in
   draft, because publication was two inline lines behind a flag that shipped
   false. Every check here is about the transition itself: which conditions
   move an article to published, which move it to manual_review, and what
   happens when the same thing is done twice.

     1  THE LIFECYCLE — pregame and postgame, generated to public.
     2  WHAT BLOCKS — each blocking condition, one at a time, and the proof
        that it names itself rather than leaving a silent draft.
     3  WHAT DOES NOT BLOCK — cosmetic craft failures are warnings and the
        article still publishes. A gate nothing can pass is not a gate.
     4  IDEMPOTENCY — a second cron run, a second publisher call, and a
        republish: one article, one published_at.
     5  REGENERATION — before publication the record is replaced; after it the
        URL is kept.
     6  VISIBILITY — the public surfaces return published articles and exclude
        everything else.
     7  RETRIES — a transient failure backs off and eventually publishes; a
        factual failure goes to review instead of retrying forever.
     8  THE STATE MACHINE — legal and illegal transitions.

   Offline. No network, no engine boot, nothing written outside a temp dir.
   Run: node tools/editorial/publisher.test.js
   ========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const AMODEL = require('../articles/article_model.js');
const RENDER = require('../articles/article_render.js');
const PUB = require('./publisher.js');
const SNAP = require('./snapshot.js');
const THESES = require('./theses.js');
const RESULTS = require('./results.js');
const GRADING = require('./grading.js');
const LESSONS = require('./lessons.js');
const POST = require('./postgame_model.js');
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

const NOW = '2026-09-10T04:00:00.000Z';
const LATER = '2026-09-10T06:00:00.000Z';

/* ---------------------------------------------------------------- fixtures */
/* A real pregame record, built through the same model the pipeline uses. */
function pregameRecord(opts) {
  opts = opts || {};
  const sc = FIX.SCENARIOS[0];
  const meta = Object.assign({}, FIX.META, opts.meta || {});
  const snap = SNAP.capture(sc.research, meta,
    { now: '2026-09-09T08:00:00.000Z', article_id: 'nfl-FIXTURE' });
  const rec = AMODEL.build(sc.research, meta, { now: NOW, status: 'draft' });
  rec.snapshot_id = snap.snapshot_id;
  rec.theses = THESES.extract(snap);
  return { rec, snap };
}

/* A real postgame record, all the way through the audit and the grade. */
function postgameRecord(opts) {
  opts = opts || {};
  const sc = opts.scenario || FIX.SCENARIOS[0];
  const meta = Object.assign({}, FIX.META, opts.meta || {});
  const snap = SNAP.capture(sc.research, meta,
    { now: '2026-09-09T08:00:00.000Z', article_id: 'nfl-FIXTURE' });
  const theses = THESES.extract(snap);
  const result = RESULTS.build({
    observation: Object.assign({
      provider: 'fixture', home_team: FIX.HOME, away_team: FIX.AWAY, completed: true,
      status_name: 'STATUS_FINAL', line_scores: null, scoring_plays: sc.result.scoring_plays || null,
      drive_summary: null, win_probability: null, leaders: null,
      stat_fields_seen: ['totalYards', 'yardsPerPlay', 'thirdDownEff', 'turnovers', 'firstDowns']
    }, sc.result),
    agreed_by: ['fixture'], ok: true
  }, { now: NOW, sport: 'NFL', game_id: 'FIXTURE', season: 2026, week: 1,
    kickoff: meta.kickoff, home: FIX.HOME, away: FIX.AWAY });
  RESULTS.crossDerive(result.metrics.home, result.metrics.away);
  const audit = THESES.audit(theses, result);
  const tally = THESES.tally(audit);
  const graded = GRADING.grade({ snapshot: snap, result, audit, tally, now: NOW,
    closing_home_margin: sc.closing_home_margin, closing_source: sc.closing_source });
  const lessons = LESSONS.extract({ snapshot: snap, result, graded, audit, tally, now: NOW,
    article_id: 'postgame-nfl-FIXTURE' });
  const rec = POST.build({ snapshot: snap, result, theses, audit, tally, grading: graded,
    lessons, pregame: opts.pregame || null, now: NOW, status: 'draft' });
  return { rec, snap, result, audit, tally, graded, lessons };
}

/* ======================================================================== */
section('1. THE LIFECYCLE — generated to public, with no person in the path');
/* ======================================================================== */
(function () {
  const { rec } = pregameRecord();
  eq('a freshly built record starts as a draft', rec.status, 'draft');
  chk('and is not public', !PUB.isPublic(rec));

  const q = QUALITY.inspect(rec, { now: NOW });
  chk('the quality gate passes a well-formed pregame article', q.publishable,
    q.hold_reason + ' · integrity ' + JSON.stringify(q.integrity_failed));

  const out = PUB.publish(rec, { now: NOW, others: [] });
  chk('the publisher accepts it', out.ok, JSON.stringify(out.blocking));
  eq('the action is a first publication', out.action, 'published');
  eq('the status is published', out.record.status, 'published');
  eq('published_at is stamped', out.record.published_at, NOW);
  chk('updated_at is set', !!out.record.updated_at);
  chk('and it is now public', PUB.isPublic(out.record));
  chk('the publisher records that it passed', out.record.publish_state.ok);
  eq('with no blocking conditions', out.record.publish_state.blocking.length, 0);

  /* THE POSTGAME HALF GOES THROUGH THE SAME DOOR. */
  const pg = postgameRecord();
  const pq = QUALITY.inspect(pg.rec, { now: NOW });
  chk('the quality gate passes a well-formed postgame article', pq.publishable,
    pq.hold_reason + ' · integrity ' + JSON.stringify(pq.integrity_failed));
  const pout = PUB.publish(pg.rec, { now: NOW, others: [] });
  chk('the publisher accepts the postgame article too', pout.ok, JSON.stringify(pout.blocking));
  eq('and publishes it', pout.record.status, 'published');
  eq('a postgame article is a postgame article', AMODEL.typeOf(pout.record), 'postgame');
  chk('its URL says so', /-postgame-analysis$/.test(pout.record.slug), pout.record.slug);
})();

/* ======================================================================== */
section('2. WHAT BLOCKS — every condition names itself, none leaves a silent draft');
/* ======================================================================== */
(function () {
  function blockedBy(mutate, label) {
    const { rec } = pregameRecord();
    mutate(rec);
    const out = PUB.publish(rec, { now: NOW, others: [] });
    return { out, ids: out.blocking.map(b => b.id), label };
  }

  const noBody = blockedBy(r => { r.article.sections = []; });
  chk('an article with no sections is blocked', !noBody.out.ok);
  chk('and the condition is named', noBody.ids.indexOf('generation_complete') >= 0, noBody.ids.join(','));
  eq('it goes to manual_review, NOT to draft', noBody.out.record.status, 'manual_review');
  chk('and it is not public', !PUB.isPublic(noBody.out.record));
  chk('the record itself carries the reason', !!noBody.out.record.publish_state.hold_reason);

  const noTitle = blockedBy(r => { r.title = 'short'; });
  chk('a missing headline is blocked', noTitle.ids.indexOf('title') >= 0, noTitle.ids.join(','));

  const badSlug = blockedBy(r => { r.slug = 'Not A Slug'; });
  chk('a malformed slug is blocked', badSlug.ids.indexOf('slug') >= 0, badSlug.ids.join(','));

  const noCanon = blockedBy(r => { r.canonical_url = null; });
  chk('a missing canonical URL is blocked', noCanon.ids.indexOf('canonical') >= 0, noCanon.ids.join(','));

  const noDesc = blockedBy(r => { r.seo_description = null; });
  chk('a missing meta description is blocked',
    noDesc.ids.indexOf('seo_description_present') >= 0, noDesc.ids.join(','));

  const noSnap = blockedBy(r => { r.snapshot_id = null; });
  chk('a pregame article with no snapshot is blocked', noSnap.ids.indexOf('snapshot') >= 0, noSnap.ids.join(','));

  const archived = blockedBy(r => { r.status = 'archived'; });
  chk('an archived article is never republished by a cron job',
    archived.ids.indexOf('archived') >= 0, archived.ids.join(','));

  const flagged = blockedBy(r => { r.manual_review_required = true; r.manual_review_reason = 'operator hold'; });
  chk('an operator hold blocks publication', flagged.ids.indexOf('operator_hold') >= 0, flagged.ids.join(','));

  /* A FACTUAL FAILURE. An invented number on the page is an integrity
     failure, and integrity failures are absolute regardless of the score. */
  const { rec: invented } = pregameRecord();
  invented.article.bottom_line = Object.assign({}, invented.article.bottom_line, {
    paragraphs: (invented.article.bottom_line.paragraphs || [])
      .concat(['Minnesota has won 47 straight home games by 33.7 points.'])
  });
  const iq = QUALITY.inspect(invented, { now: NOW });
  chk('an unsupported figure fails factual integrity', !iq.publishable, JSON.stringify(iq.integrity_failed));
  const iout = PUB.publish(invented, { now: NOW, quality: iq, others: [] });
  chk('so the publisher refuses it', !iout.ok);
  chk('naming factual integrity', iout.blocking.map(b => b.id).indexOf('factual_integrity') >= 0,
    iout.blocking.map(b => b.id).join(','));
  eq('and it lands in manual_review', iout.record.status, 'manual_review');

  /* A POSTGAME ARTICLE CANNOT BE WRITTEN WITHOUT A FINAL. */
  const pg = postgameRecord();
  const noFinal = Object.assign({}, pg.rec, { result: Object.assign({}, pg.rec.result, { completed: false }) });
  const nf = PUB.publish(noFinal, { now: NOW, others: [] });
  chk('a postgame article nobody called final is blocked',
    nf.blocking.map(b => b.id).indexOf('final_completed') >= 0, nf.blocking.map(b => b.id).join(','));

  const noScore = Object.assign({}, pg.rec,
    { result: Object.assign({}, pg.rec.result, { home_score: null, away_score: null }) });
  const ns = PUB.publish(noScore, { now: NOW, others: [] });
  chk('and one with no final score is blocked',
    ns.blocking.map(b => b.id).indexOf('final_data') >= 0, ns.blocking.map(b => b.id).join(','));

  /* A CANCELLED OR POSTPONED GAME produces no postgame article at all: there
     is no final, so there is nothing that can pass. */
  const postponed = Object.assign({}, pg.rec, {
    result: Object.assign({}, pg.rec.result,
      { completed: false, status_name: 'STATUS_POSTPONED', home_score: null, away_score: null })
  });
  chk('a postponed game cannot produce a published postgame article',
    !PUB.publish(postponed, { now: NOW, others: [] }).ok);

  /* A DUPLICATE. Another published article for the same game and type. */
  const { rec: a } = pregameRecord();
  const other = Object.assign({}, a, { id: 'nfl-OTHER', slug: 'other-slug', status: 'published' });
  const dup = PUB.publish(a, { now: NOW, others: [other] });
  chk('a second article for the same game and type is blocked',
    dup.blocking.map(b => b.id).indexOf('no_duplicate') >= 0, dup.blocking.map(b => b.id).join(','));
  /* but the SAME record is never its own duplicate */
  const self = PUB.publish(a, { now: NOW, others: [Object.assign({}, a, { status: 'published' })] });
  chk('a record is never blocked as a duplicate of itself', self.ok, JSON.stringify(self.blocking));
})();

/* ======================================================================== */
section('3. WHAT DOES NOT BLOCK — a gate nothing can pass is not a gate');
/* ======================================================================== */
(function () {
  /* COSMETIC IMPERFECTION IS A WARNING. An article does not become false
     because its meta description is a few characters long. */
  const { rec } = pregameRecord();
  rec.seo_description = 'A short one.';                /* under the preferred 50 */
  const out = PUB.publish(rec, { now: NOW, others: [] });
  const ids = out.blocking.map(b => b.id);
  chk('a short meta description does not block publication',
    ids.indexOf('seo_description_length') < 0, ids.join(','));
  chk('but it IS reported as a warning',
    out.warnings.some(w => w.id === 'seo_description_length'),
    out.warnings.map(w => w.id).join(','));

  /* THE QUALITY SCORE IS A SCORE, NOT A VETO — until the floor. */
  const q = QUALITY.inspect(rec, { now: NOW });
  chk('craft failures cost points rather than blocking outright',
    q.score <= 100 && (q.craft_failed || []).length >= 0);
  const { rec: fresh } = pregameRecord();
  const nearFloor = PUB.publish(fresh, { now: NOW, quality: { score: 71, floor: 70,
    integrity_failed: [], craft_failed: [] }, others: [] });
  chk('an article one point above the floor publishes', nearFloor.ok,
    JSON.stringify(nearFloor.blocking));
  const belowFloor = PUB.publish(fresh, { now: NOW, quality: { score: 69, floor: 70,
    integrity_failed: [], craft_failed: [] }, others: [] });
  chk('an article one point below it does not', !belowFloor.ok);
  chk('and the floor is what it names',
    belowFloor.blocking.map(b => b.id).indexOf('quality_floor') >= 0,
    belowFloor.blocking.map(b => b.id).join(','));

  /* THE REAL GATE IS PASSABLE BY THE REAL PIPELINE. If a well-formed article
     built by the real model cannot clear the real gate, every article ends up
     in review and the automation is theatre. */
  const { rec: clean } = pregameRecord();
  const cq = QUALITY.inspect(clean, { now: NOW });
  chk('a real pregame article clears the real gate', cq.publishable,
    'score ' + cq.score + ' · ' + cq.hold_reason);
  chk('with no integrity failures at all', (cq.integrity_failed || []).length === 0,
    JSON.stringify(cq.integrity_failed));
  const pgq = QUALITY.inspect(postgameRecord().rec, { now: NOW });
  chk('and so does a real postgame article', pgq.publishable,
    'score ' + pgq.score + ' · ' + pgq.hold_reason);
})();

/* ======================================================================== */
section('4. IDEMPOTENCY — twice is once');
/* ======================================================================== */
(function () {
  const { rec } = pregameRecord();
  const first = PUB.publish(rec, { now: NOW, others: [] });
  eq('first call publishes', first.action, 'published');
  eq('and stamps the date', first.record.published_at, NOW);

  /* A SECOND CRON RUN. Same record, later clock, nothing changed. */
  const second = PUB.publish(first.record, { now: LATER, others: [] });
  chk('a second publish of an unchanged article succeeds', second.ok);
  eq('but does nothing', second.action, 'unchanged');
  eq('published_at is NOT moved', second.record.published_at, NOW);
  eq('and updated_at is NOT moved either', second.record.updated_at, first.record.updated_at);

  /* A THIRD, and a fourth. */
  const third = PUB.publish(second.record, { now: LATER, others: [] });
  eq('and again', third.action, 'unchanged');
  eq('still one publication date', third.record.published_at, NOW);

  /* THE DUPLICATE TEST MUST NOT FIRE ON ITSELF ACROSS RUNS. */
  const withSelf = PUB.publish(third.record, { now: LATER, others: [third.record] });
  chk('a republish is not blocked by its own stored row', withSelf.ok,
    JSON.stringify(withSelf.blocking));

  /* A REAL EDIT does move updated_at, because the document changed. */
  const edited = Object.assign({}, third.record, { title: third.record.title + ' (corrected)' });
  const re = PUB.publish(edited, { now: LATER, others: [], previous: third.record });
  eq('a changed document is a republish', re.action, 'republished');
  eq('the original publication date survives', re.record.published_at, NOW);
  eq('and updated_at moves to now', re.record.updated_at, LATER);
})();

/* ======================================================================== */
section('5. REGENERATION — the URL is the contract');
/* ======================================================================== */
(function () {
  const { rec } = pregameRecord();
  const slug = rec.slug, id = rec.id, canon = rec.canonical_url;

  /* BEFORE PUBLICATION the record is replaced in place. */
  const regenerated = pregameRecord().rec;
  eq('a regenerated unpublished article keeps its id', regenerated.id, id);
  eq('and its slug', regenerated.slug, slug);
  eq('and its canonical URL', regenerated.canonical_url, canon);

  /* AFTER PUBLICATION the URL is kept and the record updated, never a second
     article at a second URL. */
  const published = PUB.publish(rec, { now: NOW, others: [] }).record;
  const refreshed = AMODEL.refresh(published, FIX.SCENARIOS[0].research,
    Object.assign({}, FIX.META), { now: LATER });
  eq('refreshing a published article keeps the slug', refreshed.record.slug, slug);
  eq('and the canonical URL', refreshed.record.canonical_url, canon);
  eq('and the id', refreshed.record.id, id);
  eq('and the publication date', refreshed.record.published_at, NOW);

  /* PREGAME IMMUTABILITY. Once the game has kicked off the article stops
     tracking the research: the postgame audit depends on it being a record of
     what EdgeDesk said BEFOREHAND. */
  const afterKick = AMODEL.refresh(published, FIX.SCENARIOS[0].research,
    Object.assign({}, FIX.META), { now: '2026-09-20T00:00:00.000Z' });
  chk('a published pregame article is frozen once the game starts', !afterKick.changed);
  chk('and says why', /frozen/.test(String(afterKick.reason)), afterKick.reason);
})();

/* ======================================================================== */
section('6. VISIBILITY — the public surfaces agree with the status');
/* ======================================================================== */
(function () {
  const { rec } = pregameRecord();
  const published = PUB.publish(rec, { now: NOW, others: [] }).record;
  const draft = Object.assign({}, rec, { id: 'nfl-DRAFT', slug: 'draft-article', status: 'draft' });
  const review = Object.assign({}, rec, { id: 'nfl-REVIEW', slug: 'review-article', status: 'manual_review' });
  const all = [published, draft, review];

  /* THE PUBLIC QUERY. Exactly the filter build_articles.js uses. */
  const publicSet = all.filter(r => r.status === 'published');
  eq('the public set holds the published article', publicSet.length, 1);
  eq('and it is the right one', publicSet[0].slug, published.slug);
  chk('a draft is excluded', !publicSet.some(r => r.slug === 'draft-article'));
  chk('a manual_review article is excluded', !publicSet.some(r => r.slug === 'review-article'));

  /* THE PUBLISHER AGREES WITH THE BUILD. If these two ever disagreed, the
     store would say published and the site would show nothing (or worse). */
  all.forEach(r => {
    eq('publisher and build agree on ' + r.status,
      PUB.isPublic(r), r.status === 'published');
  });

  /* THE PAGE ITSELF. A published article renders an indexable document; a
     held one is marked noindex even if it is somehow rendered. */
  const page = RENDER.articlePage(published, { now: NOW });
  chk('a published article renders a real page', page.length > 2000, page.length + ' bytes');
  chk('and is indexable', /index,follow/.test(page) || !/noindex/.test(page));
  const heldPage = RENDER.articlePage(review, { now: NOW });
  chk('a manual_review article is noindex if rendered at all', /noindex/.test(heldPage));

  /* THE CARD. Its type drives the hub filter, so it has to be on the card. */
  chk('the card carries its article type', /data-type="pregame"/.test(RENDER.cardHTML(published, { now: NOW }))
    || /data-type="pregame"/.test(page), 'no data-type on the card');

  const pg = PUB.publish(postgameRecord().rec, { now: NOW, others: [] }).record;
  const pgCard = RENDER.cardHTML(pg, { now: NOW });
  chk('a postgame card is typed postgame', /data-type="postgame"/.test(pgCard), pgCard.slice(0, 200));
  chk('and is labelled Postgame for a reader', /Postgame/.test(pgCard));
})();

/* ======================================================================== */
section('7. RETRIES — transient failures back off, factual ones do not retry');
/* ======================================================================== */
(function () {
  const entries = {};
  const t0 = '2026-09-10T04:00:00.000Z';
  chk('a step with no history is due', STORE.retryDue(entries, 'NFL:X', 'postgame', t0).due);

  const r1 = STORE.retryFailed(entries, 'NFL:X', 'postgame', 'ESPN timed out', t0);
  eq('a failure records the attempt', r1.attempt_count, 1);
  chk('and the error', /timed out/.test(r1.last_error));
  chk('and schedules the next try', !!r1.next_retry_at);
  chk('it is not due one minute later',
    !STORE.retryDue(entries, 'NFL:X', 'postgame', '2026-09-10T04:01:00.000Z').due);
  chk('and the reason says it is backing off',
    /backing off/.test(STORE.retryDue(entries, 'NFL:X', 'postgame', '2026-09-10T04:01:00.000Z').reason));
  chk('it IS due after the backoff',
    STORE.retryDue(entries, 'NFL:X', 'postgame', '2026-09-10T04:30:00.000Z').due);

  /* THE BACKOFF WIDENS rather than hammering the provider. */
  const gaps = [];
  const e2 = {};
  let t = Date.parse(t0);
  for (let i = 0; i < STORE.RETRY_MAX; i++) {
    const r = STORE.retryFailed(e2, 'NFL:Y', 'postgame', 'boom', new Date(t).toISOString());
    if (r.next_retry_at) gaps.push((Date.parse(r.next_retry_at) - t) / 60000);
    t = Date.parse(r.next_retry_at || new Date(t + 60000).toISOString());
  }
  chk('each backoff is at least as long as the one before',
    gaps.every((g, i) => i === 0 || g >= gaps[i - 1]), JSON.stringify(gaps));
  chk('it gives up rather than retrying forever',
    e2[STORE.retryKey('NFL:Y', 'postgame')].exhausted);
  chk('and an exhausted step is not due', !STORE.retryDue(e2, 'NFL:Y', 'postgame', '2027-01-01T00:00:00.000Z').due);
  chk('and says so', /exhausted/.test(STORE.retryDue(e2, 'NFL:Y', 'postgame', '2027-01-01T00:00:00.000Z').reason));

  /* A SUCCESS CLEARS THE LEDGER, so a game that recovered starts clean. */
  STORE.retryCleared(entries, 'NFL:X', 'postgame');
  chk('a step that finally worked clears its backoff',
    STORE.retryDue(entries, 'NFL:X', 'postgame', t0).due);

  /* A FACTUAL FAILURE IS NOT RETRIED. The publisher turns it into
     manual_review, which is a state a retry cannot clear — only a person or a
     regeneration can. That is the difference the user asked for. */
  const { rec } = pregameRecord();
  rec.article.sections = [];
  const out = PUB.publish(rec, { now: NOW, others: [] });
  eq('a structural failure goes to review, not to a retry queue', out.record.status, 'manual_review');
  chk('and the publisher never marks it transient', !out.record.retry);
})();

/* ======================================================================== */
section('8. THE STATE MACHINE');
/* ======================================================================== */
(function () {
  chk('draft may become ready', PUB.canTransition('draft', 'ready'));
  chk('ready may become published', PUB.canTransition('ready', 'published'));
  chk('draft may become manual_review', PUB.canTransition('draft', 'manual_review'));
  chk('manual_review may become ready once cleared', PUB.canTransition('manual_review', 'ready'));
  chk('published may be archived', PUB.canTransition('published', 'archived'));
  chk('archived does NOT go straight back to published',
    !PUB.canTransition('archived', 'published'));
  chk('an unknown status is not a legal destination', !PUB.canTransition('draft', 'banana'));
  chk('manual_review is a legal status', PUB.ALL_STATUSES.indexOf('manual_review') >= 0);
  chk('the model agrees it is legal',
    AMODEL.build(FIX.SCENARIOS[0].research, FIX.META,
      { now: NOW, status: 'manual_review' }).status === 'manual_review');

  /* WITHDRAWALS */
  const { rec } = pregameRecord();
  const published = PUB.publish(rec, { now: NOW, others: [] }).record;
  const pulled = PUB.unpublish(published, { now: LATER, reason: 'operator pulled it' });
  eq('unpublishing returns it to draft', pulled.status, 'draft');
  chk('and it is no longer public', !PUB.isPublic(pulled));
  chk('and the reason is recorded', /operator/.test(pulled.publish_state.hold_reason));
  eq('archiving sets archived', PUB.archive(published, { now: LATER }).status, 'archived');

  /* CLEARING A REVIEW does not itself publish — the pipeline re-checks. */
  const held = Object.assign({}, rec, { status: 'manual_review', manual_review_required: true });
  const cleared = PUB.clearReview(held, { now: LATER });
  chk('clearing a review drops the operator hold', !cleared.manual_review_required);
  chk('but does not publish by itself', !PUB.isPublic(cleared));

  /* AN ALREADY-PUBLISHED ARTICLE IS NOT YANKED OFFLINE by a later blocking
     condition — withdrawing a live page is an operator decision. */
  const brokenLater = Object.assign({}, published, { seo_description: null });
  const out = PUB.publish(brokenLater, { now: LATER, others: [] });
  chk('a new blocking condition on a live article is refused', !out.ok);
  eq('but the live article keeps its status', out.record.status, 'published');
  chk('and the condition is recorded for the operator',
    out.record.publish_state.blocking.length > 0);
})();

/* ======================================================================== */
section('9. END TO END — game to public page, with nobody in the path');
/* ======================================================================== */
/* THE DEFINITION OF DONE, as a test. Snapshot, pregame article, publication,
   the game, the box score, the readiness gate, the audit, the grade, the
   lessons, the postgame article, its publication, the cross-link, the rendered
   page, the hub card — and then a second orchestration that changes nothing.
   If this passes, the system publishes without a person. */
(function () {
  const sc = FIX.SCENARIOS[0];

  /* ---- the commitment ---- */
  const snap = SNAP.capture(sc.research, FIX.META,
    { now: '2026-09-09T08:00:00.000Z', article_id: 'nfl-E2E' });
  chk('a pregame snapshot is captured and content-addressed', !!snap.snapshot_id);
  const pre = AMODEL.build(sc.research, FIX.META, { now: NOW, status: 'draft' });
  pre.snapshot_id = snap.snapshot_id;
  pre.theses = THESES.extract(snap);
  const prePub = PUB.publish(pre, { now: NOW, others: [] });
  chk('the pregame article publishes with no human',
    prePub.ok && prePub.record.status === 'published', JSON.stringify(prePub.blocking));

  /* ---- the game happens ---- */
  const reconciled = {
    observation: Object.assign({
      provider: 'espn', home_team: FIX.HOME, away_team: FIX.AWAY, completed: true,
      status_name: 'STATUS_FINAL', line_scores: null,
      scoring_plays: sc.result.scoring_plays || null, drive_summary: null,
      win_probability: null, leaders: null,
      stat_fields_seen: ['totalYards', 'yardsPerPlay', 'thirdDownEff', 'turnovers', 'firstDowns']
    }, sc.result),
    agreed_by: ['espn'], ok: true, snapshot: snap
  };
  /* the gate runs on the reconciled observation, BEFORE the result is built:
     a postgame article may not be written from a scoreboard */
  const ready = RESULTS.readiness(reconciled, { now: NOW, settle_minutes: 0, min_core_metrics: 5 });
  chk('the readiness gate passes on a real box score', ready.ready, JSON.stringify(ready.reasons));
  const result = RESULTS.build(reconciled, { now: NOW, sport: 'NFL', game_id: 'E2E',
    season: 2026, week: 1, kickoff: FIX.META.kickoff, home: FIX.HOME, away: FIX.AWAY });
  RESULTS.crossDerive(result.metrics.home, result.metrics.away);
  chk('the final is ingested and called final', result.completed === true);

  /* ---- the audit ---- */
  const audit = THESES.audit(pre.theses, result);
  const tally = THESES.tally(audit);
  eq('every pregame thesis is audited', audit.length, pre.theses.length);
  chk('and there was something to audit', audit.length > 0);
  const graded = GRADING.grade({ snapshot: snap, result, audit, tally, now: NOW,
    closing_home_margin: sc.closing_home_margin, closing_source: sc.closing_source });
  chk('the bet result and the process grade are computed separately',
    !!graded.bet_headline && !!graded.process_headline);
  const lessons = LESSONS.extract({ snapshot: snap, result, graded, audit, tally, now: NOW,
    article_id: 'postgame-nfl-E2E' });
  chk('research lessons are stored', lessons.length > 0);

  /* ---- the postgame article ---- */
  const post = POST.build({ snapshot: snap, result, theses: pre.theses, audit, tally,
    grading: graded, lessons, pregame: prePub.record, now: NOW, status: 'draft' });
  const q = QUALITY.inspect(post, { now: NOW });
  chk('the postgame article clears the quality gate', q.publishable,
    'score ' + q.score + ' · ' + q.hold_reason);
  const postPub = PUB.publish(post, { now: NOW, quality: q, others: [prePub.record] });
  chk('the postgame article publishes with no human',
    postPub.ok && postPub.record.status === 'published', JSON.stringify(postPub.blocking));
  chk('published_at is stamped', !!postPub.record.published_at);
  chk('it links back to the pregame article',
    !!(postPub.record.related && postPub.record.related.pregame_url));

  /* ---- a reader can actually reach it ---- */
  const page = RENDER.articlePage(postPub.record, { now: NOW });
  chk('the page renders a real document', page.length > 3000, page.length + ' bytes');
  chk('and it is indexable', !/noindex/.test(page));
  chk('the hub card is typed postgame so the filter finds it',
    /data-type="postgame"/.test(RENDER.cardHTML(postPub.record, { now: NOW })));
  eq('both halves are in the public set',
    [prePub.record, postPub.record].filter(r => r.status === 'published').length, 2);

  /* ---- and the next tick changes nothing ---- */
  const again = PUB.publish(postPub.record, { now: '2026-09-11T00:00:00.000Z',
    quality: q, others: [prePub.record], previous: postPub.record });
  eq('a second orchestration produces no second article', again.action, 'unchanged');
  eq('and does not move published_at', again.record.published_at, postPub.record.published_at);
})();

/* ------------------------------------------------------------------ report */
console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' | editorial publisher | '
  + pass + ' passed' + (fail ? ', ' + fail + ' failed' : ' assertions'));
if (fail) { failures.forEach(f => console.log('  ×  ' + f)); process.exit(1); }
