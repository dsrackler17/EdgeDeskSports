#!/usr/bin/env node
/* ============================================================================
   THE EDITORIAL REPORT — what the pipeline did, and for anything it did not
   do, exactly why.

   WHY IT IS A FILE AND NOT A `node -e` STRING IN THE WORKFLOW. It was fifteen
   lines of JavaScript inside a double-quoted shell string inside a YAML block
   scalar, which is three layers of escaping around code nobody could run
   locally or test. It also carried a `\\$GITHUB_STEP_SUMMARY` that bash read
   as a literal dollar, so it wrote its output into a file called
   '$GITHUB_STEP_SUMMARY' in the repository root and the job summary was empty
   on every run since the system shipped.

   THE RULE THIS SERVES. "Held" is never an acceptable answer on its own. Every
   line here names the condition — waiting_window, waiting_stats,
   manual_review with the failing check, retry backing off with the error —
   so the question "why is there no article for this game?" is answered by
   reading, not by guessing.

     node tools/editorial/report.js            the last run, as markdown
     node tools/editorial/report.js --runs 3   the last three runs
     node tools/editorial/report.js --json
   ========================================================================== */
'use strict';

const STORE = require('./store.js');
const ASTORE = require('../articles/store.js');
const AMODEL = require('../articles/article_model.js');
const PUB = require('./publisher.js');

function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || v.startsWith('--')) ? true : v;
}
const WANT_RUNS = Number(arg('runs', 1)) || 1;
const AS_JSON = !!arg('json', false);

function esc(v) { return String(v == null ? '' : v).replace(/\|/g, '/').replace(/\n+/g, ' '); }

function build() {
  const runs = STORE.loadRuns();
  const ids = [];
  for (let i = runs.length - 1; i >= 0 && ids.length < WANT_RUNS; i--) {
    if (runs[i] && runs[i].run && ids.indexOf(runs[i].run) < 0) ids.push(runs[i].run);
  }
  const mine = runs.filter(r => r && ids.indexOf(r.run) >= 0);
  const failed = mine.filter(r => !r.ok);

  /* the articles the system owns, and what state each is actually in */
  const records = ASTORE.loadAll().filter(r => r && (r.snapshot_id || AMODEL.typeOf(r) === 'postgame'));
  const articles = records.map(r => ({
    slug: r.slug,
    type: AMODEL.typeOf(r),
    status: r.status,
    public: PUB.isPublic(r),
    url: r.canonical_url || null,
    published_at: r.published_at || null,
    score: r.quality && r.quality.score != null ? r.quality.score : null,
    hold: (r.publish_state && r.publish_state.hold_reason)
      || (r.quality && r.quality.hold_reason) || null,
  })).sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')));

  const retries = STORE.loadRetries();
  const backoff = Object.keys(retries).map(k => retries[k])
    .filter(e => e && (e.attempt_count || 0) > 0);

  return { ids, steps: mine, failed, articles, backoff };
}

function markdown(d) {
  const L = [];
  L.push('## EdgeDesk editorial — last ' + d.ids.length + ' run(s)');
  L.push('');

  L.push('### Articles the editorial system owns');
  L.push('');
  if (!d.articles.length) {
    L.push('_none yet_');
  } else {
    L.push('| article | type | status | public | quality | held because |');
    L.push('| --- | --- | --- | --- | --- | --- |');
    d.articles.slice(0, 40).forEach(a => L.push('| ' + esc(a.slug) + ' | ' + esc(a.type)
      + ' | ' + esc(a.status) + ' | ' + (a.public ? 'yes' : 'no')
      + ' | ' + (a.score == null ? '—' : a.score)
      + ' | ' + (a.hold ? esc(a.hold) : '—') + ' |'));
  }
  L.push('');

  L.push('### Steps');
  L.push('');
  L.push('| step | game | outcome |');
  L.push('| --- | --- | --- |');
  d.steps.slice(-60).forEach(r => L.push('| ' + esc(r.step) + ' | ' + esc(r.key || '—') + ' | '
    + (r.ok ? '' : '**not ok** — ') + esc(r.reason || 'ok') + ' |'));
  L.push('');

  if (d.backoff.length) {
    L.push('### Retries in flight');
    L.push('');
    L.push('| game | step | attempt | next try | last error |');
    L.push('| --- | --- | --- | --- | --- |');
    d.backoff.forEach(e => L.push('| ' + esc(e.key) + ' | ' + esc(e.step) + ' | '
      + esc(e.attempt_count) + ' | ' + esc(e.exhausted ? 'gave up' : e.next_retry_at)
      + ' | ' + esc(e.last_error) + ' |'));
    L.push('');
  }

  const pub = d.articles.filter(a => a.public).length;
  const held = d.articles.filter(a => a.status === 'manual_review').length;
  L.push(d.steps.length + ' step(s), ' + d.failed.length + ' not ok · '
    + pub + ' article(s) public, ' + held + ' awaiting review.');
  return L.join('\n');
}

if (require.main === module) {
  const d = build();
  console.log(AS_JSON ? JSON.stringify(d, null, 2) : markdown(d));
}

module.exports = { build, markdown };
