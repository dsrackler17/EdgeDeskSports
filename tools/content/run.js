#!/usr/bin/env node
/* ===========================================================================
   The Content Engine's weekly job, and its local tools.

     node tools/content/run.js discover [--network] [--write] [--now ISO] [--json]
         read EdgeDesk's committed research, (--network) the public RSS
         headlines, score the opportunities; print them, or (--write) record
         them through content_engine_opportunity_upsert.
     node tools/content/run.js weekly [--network] [--force] [--now ISO]
         the scheduled run (.github/workflows/content-engine.yml):
           1  a lease for this week's slates (content_engine_job_begin): the
              same week runs once, a crashed run is failed after 30 minutes;
           2  discover, check source freshness, score, record (idempotent on
              each opportunity's key; a dismissed topic stays dismissed);
           3  for at most `drafts_per_run` (default 2) open opportunities above
              the priority floor with no live article for the default
              publisher: write the deterministic draft; if ANTHROPIC_API_KEY
              is set and the database's budget allows, ask Claude to improve
              it (raw HTTPS — this repository has no npm dependencies); keep
              Claude's version only if it passes every check;
           4  check every draft against its research (lib/content_engine.js
              validate); a passing draft goes to the owner's review queue
              (content_engine_article_submit), a failing one stays a draft
              with its reasons logged.
         It never approves, sends or publishes: those doors refuse the service
         role in the database.
     node tools/content/run.js example --out DIR [--league cfb] [--kind weekly_preview] [--ai]
         one article from the current research, written to DIR as Markdown,
         HTML, the SEO sheet and the check report. No database.

   ENVIRONMENT
     SB_URL / EDGD_SB_URL, SB_SERVICE_ROLE / EDGD_SB_SERVICE   the job's door
        into the database (tools/lib/pgrest.js); without them `weekly` says so
        and exits 0, as the other scheduled jobs do
     ANTHROPIC_API_KEY        optional: Claude's editorial pass
     CONTENT_ENGINE_MODEL     optional; defaults to claude-opus-5-5
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const CE = require(path.join(__dirname, '..', '..', 'lib', 'content_engine.js'));
const ART = require(path.join(__dirname, 'artifacts.js'));
const PGR = require(path.join(__dirname, '..', 'lib', 'pgrest.js'));

const UA = 'EdgeDeskContentEngine/1.0 (+https://edgedesksports.com)';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

function arg(name, dflt) { const i = process.argv.indexOf('--' + name); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt; }
function flag(name) { return process.argv.indexOf('--' + name) > 0; }

/* ── the feeds, from a host with ordinary egress ────────────────────────── */
async function fetchFeeds(leagues, o) {
  o = o || {};
  const f = o.fetch || fetch;
  const items = [], problems = [];
  for (const feed of CE.FEEDS.filter((x) => leagues.indexOf(x.league) >= 0)) {
    if (o.spend && !(await o.spend('fetch'))) { problems.push({ feed: feed.id, reason: 'budget_exhausted' }); break; }
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await f(feed.url, { headers: { 'user-agent': UA, accept: 'application/rss+xml, application/xml, text/xml' }, signal: ctl.signal });
      if (!r.ok) { problems.push({ feed: feed.id, reason: 'http_' + r.status }); continue; }
      CE.news.parseFeed((await r.text()).slice(0, 2000000), feed, new Date().toISOString()).forEach((it) => items.push(it));
    } catch (e) { problems.push({ feed: feed.id, reason: e && e.name === 'AbortError' ? 'timeout' : 'network' }); }
    finally { clearTimeout(t); }
  }
  return { items, problems };
}

/* ── one Claude call, raw HTTPS (no dependencies in this repository) ───── */
async function callClaude(req, o) {
  const f = o.fetch || fetch;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), o.timeoutMs || 150000);
  try {
    const r = await f('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': o.key, 'anthropic-version': '2023-06-01', 'anthropic-beta': FALLBACK_BETA },
      body: JSON.stringify({ model: o.model, max_tokens: req.max_tokens, system: req.system, messages: req.messages, output_config: req.output_config, fallbacks: 'default' })
    });
    const text = await r.text();
    if (!r.ok) { const e = new Error('anthropic ' + r.status + ': ' + text.slice(0, 200)); e.status = r.status; throw e; }
    return JSON.parse(text);
  } finally { clearTimeout(t); }
}

/* Improve a deterministic draft with Claude, keeping only a version that
   passes every check. Returns { article, report, generator, notes }. */
async function aiPass(o, a, ctx) {
  const notes = [];
  let objections = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    if (ctx.spend && !(await ctx.spend('llm'))) { notes.push('budget_exhausted'); break; }
    const req = CE.ai.buildRequest(o, { publisher: ctx.publisher, format: a.format, current: a, objections });
    let reply;
    try { reply = await callClaude(req, ctx); } catch (e) { notes.push('api_error ' + (e.status || '')); break; }
    const parsed = CE.ai.parseReply(reply, a);
    if (!parsed.ok) { notes.push(parsed.reason); if (parsed.reason === 'refusal') break; continue; }
    const rep = CE.validate(parsed.article, o, { publisher: ctx.publisher, now: ctx.now, teamLists: ctx.teamLists });
    if (rep.ok) return { article: parsed.article, report: rep, generator: 'claude:' + String(reply.model || ctx.model).slice(0, 60), notes };
    objections = CE.ai.objections(rep);
    notes.push('discarded: ' + objections.join(' | ').slice(0, 300));
  }
  return null;
}

/* ── discovery ──────────────────────────────────────────────────────────── */
async function discoverAll(o) {
  const art = o.art || ART.load();
  const snap = CE.research.fromArtifacts(art, { now: o.now });
  let news = [], feedProblems = [];
  if (o.network) {
    const fr = await fetchFeeds(['cfb', 'nfl'], { fetch: o.fetch, spend: o.spend });
    news = CE.news.match(fr.items, snap); feedProblems = fr.problems;
  }
  let opps = CE.discover(snap, { now: o.now, publisher: o.publisher, news });
  if (o.db) {
    try {
      const ev = await o.db.rpc('public', 'content_engine_search_evidence', { p_terms: opps.map((x) => x.seo && x.seo.primary_keyword).filter(Boolean) });
      if (ev && ev._installed) {
        const gsc = {}; Object.keys(ev).forEach((k) => { if (k[0] !== '_' && ev[k].impressions > 0) gsc[k] = ev[k]; });
        if (Object.keys(gsc).length) opps = CE.discover(snap, { now: o.now, publisher: o.publisher, news, gsc });
      }
    } catch (_) { /* demand stays an estimate */ }
  }
  return { art, snap, news, feedProblems, opps, teamLists: ART.teamLists(art) };
}

function withHash(o) { return Object.assign({}, o, { research_hash: CE.util.hash(JSON.stringify(o.research)) }); }

/* ── the weekly run ─────────────────────────────────────────────────────── */
async function weekly(o) {
  const db = o.db, log = o.log || console.log;
  const art = o.art || ART.load();
  const snap0 = CE.research.fromArtifacts(art, { now: o.now });
  const period = [snap0.cfb && snap0.cfb.season || snap0.nfl && snap0.nfl.season, snap0.cfb ? 'cfb-w' + snap0.cfb.week : 'cfb-none', snap0.nfl ? 'nfl-w' + snap0.nfl.week : 'nfl-none'].join('-');
  const begin = await db.rpc('public', 'content_engine_job_begin', { p_job: 'weekly', p_period: period, p_force: !!o.force });
  if (!begin || !begin.ok) { log('content engine: not running (' + (begin && begin.reason) + ') for ' + period); return { ran: false, reason: begin && begin.reason, period }; }
  const run = begin.run_id, settings = begin.settings || {};
  const counts = { opportunities: 0, created: 0, refreshed: 0, refused: 0, drafted: 0, queued_for_review: 0, kept_as_draft: 0, ai_used: 0, ai_discarded: 0, news: 0, feed_problems: 0 };
  const spend = async (provider) => { const r = await db.rpc('public', 'content_engine_spend', { p_provider: provider, p_n: 1 }); return !!(r && r.ok); };
  const note = (kind, detail, ids) => db.rpc('public', 'content_engine_log', Object.assign({ p_kind: kind, p_detail: detail, p_article: null, p_opportunity: null, p_run: run }, ids || {})).catch(() => null);
  try {
    const pubs = await db.rpc('public', 'content_engine_job_publishers', {});
    const publisher = (pubs || []).find((p) => p.slug === settings.default_publisher) || null;
    const d = await discoverAll({ art, now: o.now, network: o.network, fetch: o.fetch, spend, db, publisher });
    counts.news = d.news.length; counts.feed_problems = d.feedProblems.length;
    if (d.feedProblems.length) await note('fetch_failed', { problems: d.feedProblems });
    for (const opp of d.opps) {
      const r = await db.rpc('public', 'content_engine_opportunity_upsert', { p: withHash(opp), p_run: run });
      counts.opportunities++;
      if (r && r.ok) { if (r.created) counts.created++; else counts.refreshed++; } else counts.refused++;
    }
    const targets = await db.rpc('public', 'content_engine_job_targets', { p_publisher: publisher ? publisher.id : null, p_limit: settings.drafts_per_run });
    for (const t of targets || []) {
      const format = (t.formats || [])[0] || (t.league + '_weekly_preview');
      let a = CE.draft(t, { publisher, format, now: o.now });
      let rep = CE.validate(a, t, { publisher, now: o.now, teamLists: d.teamLists });
      if (o.anthropicKey) {
        const ai = await aiPass(t, a, { publisher, now: o.now, teamLists: d.teamLists, spend, key: o.anthropicKey, model: o.model, fetch: o.fetch });
        if (ai) { a = Object.assign({}, ai.article, { generator: ai.generator }); rep = ai.report; counts.ai_used++; }
        else { counts.ai_discarded++; await note('ai_discarded', { opportunity: t.key, reason: 'kept the deterministic draft' }, { p_opportunity: t.id }); }
      }
      const c = await db.rpc('public', 'content_engine_article_create', { p_opportunity: t.id, p_publisher: publisher ? publisher.id : null, p_format: format, p_angle: 'full_slate', p: Object.assign({}, a, { checks: rep }), p_run: run });
      if (!c || !c.ok) { await note('generation_failed', { opportunity: t.key, reason: c && (c.detail || c.reason) }, { p_opportunity: t.id }); continue; }
      if (c.existing) continue;
      counts.drafted++;
      if (rep.ok) {
        const s = await db.rpc('public', 'content_engine_article_submit', { p_id: c.id });
        if (s && s.ok) counts.queued_for_review++; else counts.kept_as_draft++;
      } else {
        counts.kept_as_draft++;
        await note('validation_failed', { failed: rep.failed }, { p_article: c.id, p_opportunity: t.id });
      }
    }
    await db.rpc('public', 'content_engine_job_finish', { p_run: run, p_status: 'done', p_counts: counts, p_error: null });
    log('content engine: ' + period + ' — ' + JSON.stringify(counts));
    return { ran: true, run, period, counts };
  } catch (e) {
    await db.rpc('public', 'content_engine_job_finish', { p_run: run, p_status: 'failed', p_counts: counts, p_error: String(e && e.message || e).slice(0, 1500) }).catch(() => null);
    throw e;
  }
}

/* ── the example article ────────────────────────────────────────────────── */
async function example(o) {
  const publisher = CE.PUBLISHER_TEMPLATES[o.publisherSlug || 'stadium-rant'] || null;
  const d = await discoverAll({ now: o.now, publisher, network: false });
  const opp = d.opps.find((x) => x.league === (o.league || 'cfb') && x.kind === (o.kind || 'weekly_preview'));
  if (!opp) throw new Error('no ' + (o.league || 'cfb') + ' ' + (o.kind || 'weekly_preview') + ' opportunity in the current research');
  const format = o.format || opp.formats[0];
  let a = CE.draft(opp, { publisher, format, now: o.now });
  let rep = CE.validate(a, opp, { publisher, now: o.now, teamLists: d.teamLists });
  let generator = a.generator;
  if (o.ai && o.anthropicKey) {
    const ai = await aiPass(opp, a, { publisher, now: o.now, teamLists: d.teamLists, key: o.anthropicKey, model: o.model });
    if (ai) { a = ai.article; rep = ai.report; generator = ai.generator; }
  }
  const campaign = CE.campaignCode(publisher && publisher.slug, 'example' + CE.util.hash(opp.key).slice(0, 5));
  const ctx = { publisher, campaign, opportunity: opp, landing: CE.SITE + '/today/' };
  fs.mkdirSync(o.out, { recursive: true });
  const base = path.join(o.out, a.slug);
  fs.writeFileSync(base + '.md', CE.toMarkdown(a, Object.assign({ frontMatter: true }, ctx)));
  fs.writeFileSync(base + '.html', CE.toHtml(a, Object.assign({ standalone: true }, ctx)));
  fs.writeFileSync(base + '.seo.txt', CE.seoSheet(a, opp) + '\n');
  fs.writeFileSync(base + '.docx', CE.toDocx(a, ctx));
  fs.writeFileSync(base + '.checks.json', JSON.stringify({ generator, opportunity: { key: opp.key, priority: opp.priority, scores: opp.scores, demand: opp.demand, sources: opp.sources }, checks: rep }, null, 2) + '\n');
  return { file: base + '.md', words: a.word_count, ok: rep.ok, failed: rep.failed, warned: rep.warned, generator, priority: opp.priority };
}

/* ── CLI ────────────────────────────────────────────────────────────────── */
async function main() {
  const cmd = process.argv[2];
  const now = arg('now') ? Date.parse(arg('now')) : Date.now();
  const anthropicKey = process.env.ANTHROPIC_API_KEY || '';
  const model = process.env.CONTENT_ENGINE_MODEL || 'claude-opus-5-5';
  if (cmd === 'example') {
    const r = await example({ now, out: arg('out', 'content-example'), league: arg('league'), kind: arg('kind'), format: arg('format'), ai: flag('ai'), anthropicKey, model });
    console.log((r.ok ? 'OK' : 'CHECKS FAIL') + ' | ' + r.file + ' | ' + r.words + ' words | priority ' + r.priority + ' | ' + r.generator + (r.failed.length ? ' | failed: ' + r.failed.join(', ') : '') + (r.warned.length ? ' | warnings: ' + r.warned.join(', ') : ''));
    process.exit(r.ok ? 0 : 1);
  }
  const cfg = PGR.config(process.env);
  if (cmd === 'discover') {
    const db = cfg && flag('write') ? PGR.client(cfg) : null;
    const d = await discoverAll({ now, network: flag('network'), db, publisher: CE.PUBLISHER_TEMPLATES['stadium-rant'] });
    if (flag('json')) { console.log(JSON.stringify(d.opps.map((x) => ({ key: x.key, priority: x.priority, title: x.seo.headline, demand: x.demand.basis })), null, 2)); }
    else d.opps.forEach((x) => console.log(String(x.priority).padStart(3) + '  ' + x.league + '  ' + x.kind.padEnd(19) + x.seo.headline));
    if (flag('network')) console.log('headlines matched: ' + d.news.length + (d.feedProblems.length ? ' · feed problems: ' + JSON.stringify(d.feedProblems) : ''));
    if (db) {
      let n = 0;
      for (const x of d.opps) { const r = await db.rpc('public', 'content_engine_opportunity_upsert', { p: withHash(x), p_run: null }); if (r && r.ok) n++; }
      console.log('recorded ' + n + ' of ' + d.opps.length);
    } else if (flag('write')) { console.log('::warning::SB_URL / SB_SERVICE_ROLE are not set: nothing recorded'); }
    return;
  }
  if (cmd === 'weekly') {
    if (!cfg) { console.log('::warning::SB_URL / SB_SERVICE_ROLE are not set: the content engine job did nothing (set them as repository secrets).'); return; }
    await weekly({ db: PGR.client(cfg), now, network: flag('network'), force: flag('force'), anthropicKey, model });
    return;
  }
  console.log('usage: node tools/content/run.js discover|weekly|example [--network] [--write] [--force] [--now ISO] [--out DIR]');
  process.exit(2);
}

if (require.main === module) main().catch((e) => { console.error('content engine: ' + (e && e.stack || e)); process.exit(1); });
module.exports = { weekly, example, discoverAll, fetchFeeds, callClaude, aiPass };
