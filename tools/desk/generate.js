#!/usr/bin/env node
/* ============================================================================
   GENERATE DESK DRAFTS — the scheduled job and the hand tool are one CLI.

     node tools/desk/generate.js --due                     what is due now, printed
     node tools/desk/generate.js --due --push              …and stored in article_drafts
     node tools/desk/generate.js --type weekly_clv --sport nfl --week 6 --out DIR
     node tools/desk/generate.js --type got_wrong --month 2026-09 --out DIR
     node tools/desk/generate.js --type research_notes --study EXP-001

   WHAT --push DOES, AND DOES NOT. It sends each draft to the service-role door
   public.desk_draft_put(), which appends it to article_drafts (never
   overwriting one) and points the article at it. It does not publish: a
   draft becomes an article only when the owner writes "My take" and presses
   Publish, and the database refuses the press without the take. A draft whose
   body is byte-identical to the newest one for its article is recorded as
   unchanged and adds no row.

   A DRAFT THAT FAILS ITS OWN CHECKS IS NOT PUSHED. Each draft is held to the
   voice rules and re-verified against its sources before it leaves this
   process; a failure is printed with the reason and the run exits non-zero.

   ENVIRONMENT (only for --push)
     SB_URL, SB_SERVICE_ROLE   the same secrets every other job uses
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const D = require('../../lib/edgedesk_desk.js');
const SRC = require('./sources.js');
const G = require('./generators.js');

function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || v.startsWith('--')) ? true : v;
}

/* --------------------------------------------------------------- planning */
/* What is due, from the data alone. Idempotent by design: running it twice
   produces the same drafts, and the database stores a draft only when its
   body changed. */
function plan(S, nowIso) {
  const now = Date.parse(nowIso), jobs = [];
  const sum = S.record_summary && S.record_summary.doc;
  ['nfl', 'cfb'].forEach(sp => {
    const weeks = (sum && sum.sports && sum.sports[sp] && sum.sports[sp].weeks) || [];
    const done = weeks.filter(w => w.graded > 0 && w.graded === w.recorded && w.clv && w.clv.n > 0).map(w => w.week);
    if (done.length) jobs.push({ type: 'weekly_clv', o: { sport: sp, week: Math.max.apply(null, done) } });
  });
  /* the week ahead: the earliest week with most of its games still to play,
     so one leftover Monday night game does not become a whole article */
  /* the slate holds only games still to play, so a week's size comes from
     the model record (every game it recorded that week) where it has one */
  const slate = S.nfl_slate && S.nfl_slate.doc, tally = {};
  ((slate && slate.games) || []).forEach(g => {
    const t = tally[g.week] = tally[g.week] || { all: 0, ahead: 0 };
    t.all++; if (Date.parse(g.kickoff) > now) t.ahead++;
  });
  ((sum && sum.sports && sum.sports.nfl && sum.sports.nfl.weeks) || []).forEach(w => {
    if (tally[w.week]) tally[w.week].all = Math.max(tally[w.week].all, w.recorded || 0);
  });
  const ahead = Object.keys(tally).map(Number).filter(w => tally[w].ahead > 0 && tally[w].ahead * 2 >= tally[w].all).sort((a, b) => a - b);
  if (ahead.length) jobs.push({ type: 'disagreement', o: { sport: 'nfl', week: ahead[0], now: nowIso } });
  const op = S.openers_nfl && S.openers_nfl.doc;
  if (op && op.games) {
    const byWeek = {};
    Object.keys(op.games).forEach(id => { const g = op.games[id]; (byWeek[g.week] = byWeek[g.week] || []).push(g); });
    const closed = Object.keys(byWeek).map(Number).filter(w => byWeek[w].every(g => g.closed));
    if (closed.length) jobs.push({ type: 'line_movement', o: { sport: 'nfl', week: Math.max.apply(null, closed) } });
  }
  const d = new Date(now), prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  jobs.push({ type: 'got_wrong', o: { month: prev.toISOString().slice(0, 7) } });
  const ex = S.cfb_experiments && S.cfb_experiments.doc;
  const ids = Array.from(new Set(((ex && ex.rows) || []).map(r => r.experiment_id))).sort();
  ids.forEach(id => jobs.push({ type: 'research_notes', o: { study: id } }));
  return jobs;
}

/* ------------------------------------------------------------- packaging */
function headCommit() { return SRC.git(['rev-parse', 'HEAD']); }
function bodyHash(d) { return crypto.createHash('sha256').update(d.title + '\n' + d.lead + '\n' + d.body_md).digest('hex'); }
/* The row article_drafts stores. data_snapshot carries every number, the
   query that produced it and the file (with digest and commit) it came from. */
function packageDraft(d, S, nowIso) {
  const prov = SRC.provenance(S, d.sources_used);
  const stamps = prov.map(p => p.generated_at).filter(Boolean).sort();
  return {
    article_key: d.article_key, type: d.type, sport: d.sport, season: d.season, week: d.week, period: d.period,
    slug: d.slug, title: d.title, description: d.description, lead: d.lead, highlights: d.highlights || [],
    reddit_title: d.reddit_title || null, record_link: d.record_link || null,
    generated_body: d.body_md, body_hash: bodyHash(d), generator_version: d.generator_version,
    source_commit: headCommit(), generated_at: nowIso,
    data_as_of: stamps[0] || null,
    data_snapshot: {
      schema: 'edgedesk_desk_snapshot_v1', generated_at: nowIso, data_as_of: stamps[0] || null, newest_source_at: stamps[stamps.length - 1] || null,
      commit: headCommit(), sources: prov, numbers: d.numbers, facts: d.facts,
      checks: { voice: d.voice, verify: { ok: d.verify.ok, checked: d.verify.checked, problems: d.verify.problems } }
    }
  };
}

/* ------------------------------------------------------------------ push */
async function push(row) {
  const url = process.env.SB_URL, key = process.env.SB_SERVICE_ROLE;
  if (!url || !key) throw new Error('--push needs SB_URL and SB_SERVICE_ROLE');
  const r = await fetch(url.replace(/\/+$/, '') + '/rest/v1/rpc/desk_draft_put', {
    method: 'POST',
    headers: { apikey: key, authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    body: JSON.stringify({ p: row })
  });
  const text = await r.text();
  if (!r.ok) throw new Error('desk_draft_put HTTP ' + r.status + ': ' + text.slice(0, 300));
  try { return JSON.parse(text); } catch (_) { return text; }
}

/* ------------------------------------------------------------------- run */
async function main() {
  const nowIso = arg('now', null) ? new Date(arg('now')).toISOString() : new Date().toISOString();
  const S = SRC.loader({ season: Number(arg('season', 2026)) });
  const out = arg('out', null), doPush = !!arg('push', false), quiet = !!arg('quiet', false);
  const log = (...a) => { if (!quiet) console.log(...a); };
  let jobs;
  if (arg('due', false)) jobs = plan(S, nowIso);
  else {
    const type = arg('type', null);
    if (!type) { console.error('usage: --due | --type <' + Object.keys(G.GENERATORS).join('|') + '> [--sport nfl|cfb] [--week N] [--month YYYY-MM] [--study EXP-001]'); process.exit(2); }
    const o = { now: nowIso };
    if (arg('sport', null)) o.sport = arg('sport');
    if (arg('week', null)) o.week = Number(arg('week'));
    if (arg('month', null)) o.month = arg('month');
    if (arg('study', null)) o.study = arg('study');
    if (arg('partial', false)) o.allowPartial = true;
    jobs = [{ type, o }];
  }
  let failed = 0, made = 0, skipped = 0;
  for (const j of jobs) {
    let d;
    try { d = G.generate(j.type, S, j.o); }
    catch (e) {
      if (e.notReady) { skipped++; log('  skip  ' + j.type.padEnd(15) + e.message); continue; }
      failed++; console.error('  FAIL  ' + j.type.padEnd(15) + (e.stack || e.message)); continue;
    }
    /* a stored draft must be traceable to a commit: the job runs on a clean
       checkout, and a draft read from uncommitted files is never stored */
    const loose = doPush ? SRC.provenance(S, d.sources_used).filter(p => !p.commit) : [];
    if (loose.length) {
      failed++;
      console.error('  HELD  ' + d.article_key + '  read from uncommitted file(s): ' + loose.map(p => p.file).join(', '));
      continue;
    }
    if (!d.voice.ok || !d.verify.ok) {
      failed++;
      console.error('  HELD  ' + d.article_key + '  voice: ' + JSON.stringify(d.voice.issues) + '  verify: ' + JSON.stringify(d.verify.problems));
      continue;
    }
    const row = packageDraft(d, S, nowIso);
    made++;
    log('  draft ' + row.article_key.padEnd(44) + String(d.numbers.length).padStart(4) + ' numbers  ' + String(d.verify.checked).padStart(5) + ' checks  ' + row.title);
    if (out) {
      fs.mkdirSync(out, { recursive: true });
      const base = path.join(out, row.article_key.replace(/[:]/g, '__'));
      fs.writeFileSync(base + '.json', JSON.stringify(row, null, 1) + '\n');
      fs.writeFileSync(base + '.md', '# ' + row.title + '\n\n' + row.generated_body);
    }
    if (doPush) {
      try { const res = await push(row); log('        stored: ' + JSON.stringify(res)); }
      catch (e) { failed++; console.error('  PUSH FAILED ' + row.article_key + ': ' + e.message); }
    }
  }
  log('\n' + made + ' draft(s), ' + skipped + ' not due, ' + failed + ' failure(s)');
  process.exit(failed ? 1 : 0);
}

if (require.main === module) main().catch(e => { console.error(e.stack || e); process.exit(1); });
module.exports = { plan, packageDraft, bodyHash };
