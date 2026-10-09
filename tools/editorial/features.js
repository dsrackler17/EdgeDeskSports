#!/usr/bin/env node
/* ===========================================================================
   EDGEDESK FEATURES — the Monday / Wednesday / Friday publishing job.

     node tools/editorial/features.js [--if-due] [--now ISO] [--kind K]
                                      [--mode dry_run|off] [--out DIR]
                                      [--github-output FILE]

   RESEARCH → GENERATION → VALIDATION → SCHEDULED → PUBLISHED, or HELD FOR
   REVIEW. Each run, in order:

     0  a feature the database says is published whose record file is missing
        (another job's push race) is written back: publication is durable;
     1  a feature the OWNER APPROVED (content_engine_fp_decide) is published
        if its research is still fresh and no game in it has started;
     2  today's slot (Central Time; lib/content_engine.js firstParty): build
        the article from the committed research, or record why there is
        none; run the twelve gates; then
          mode dry_run  record what WOULD happen (owner-only), publish nothing;
          mode auto     all twelve pass → SCHEDULED until the publish hour,
                        then PUBLISHED; anything less → HELD FOR REVIEW.

   THE DATABASE DECIDES WHAT MAY PUBLISH (supabase/content_engine.sql 6f):
   the mode, the twelve gates or the owner's approval of this exact text, and
   three a week at most. Publishing is writing features/records/<id>.json; the
   site build renders it (tools/articles/build_articles.js). A run with no
   database (no SB credentials) is a dry run, always.

   NOTHING UNPUBLISHED REACHES A PUBLIC PLACE. Held and dry-run articles go to
   the owner-only table; the console prints slots, statuses and gate names,
   never the text. --out writes a full local report for a developer machine.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CE = require(path.join(ROOT, 'lib', 'content_engine.js'));
const ART = require(path.join(ROOT, 'tools', 'content', 'artifacts.js'));
const STORE = require(path.join(ROOT, 'tools', 'articles', 'store.js'));
const FEATURE = require('./feature_model.js');
const PGR = require(path.join(ROOT, 'tools', 'lib', 'pgrest.js'));
const FP = CE.firstParty;

const argv = process.argv.slice(2);
function arg(n, d) { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !/^--/.test(argv[i + 1]) ? argv[i + 1] : d; }
function flag(n) { return argv.indexOf('--' + n) >= 0; }

function textOf(rec) { return [rec.title, rec.standfirst].concat((rec.sections || []).map((s) => (s.heading || '') + '\n' + s.body)).join('\n\n'); }
function gameText(r) {
  const a = r.article || {};
  return [r.title].concat((a.sections || []).map((s) => JSON.stringify(s))).join('\n').replace(/"[a-z_]+":/g, ' ');
}
function weekOfIso(iso) { return iso ? FP.ctWeekOf(Date.parse(iso)) : null; }

/* the week's publisher articles: from the database when there is one; with no
   database, EdgeDesk's own deterministic drafts for the default publisher
   stand in for them (the stricter test: what would be sent if it were) */
function publisherProxies(snap, now) {
  const SR = CE.PUBLISHER_TEMPLATES['stadium-rant'];
  return CE.discover(snap, { now, publisher: SR }).filter((o) => /weekly_preview|upset_watch|postgame_review|conference_race/.test(o.kind))
    .map((o) => ({ label: 'the ' + o.key + ' draft for Stadium Rant', text: CE.draft(o, { publisher: SR, now }).sections.map((s) => s.body).join('\n\n') }));
}

/* o: { now, db, mode, ifDue, kind, art, out, log, saveFeature, loadFeatures, loadGames } */
async function run(o) {
  const log = o.log || console.log;
  const now = o.now != null ? o.now : Date.now();
  const db = o.db || null;
  const save = o.saveFeature || STORE.saveFeature;
  const loadFeatures = o.loadFeatures || STORE.loadFeatures;
  const loadGames = o.loadGames || STORE.loadAll;
  const week = FP.ctWeekOf(now);
  const state = db ? await db.rpc('public', 'content_engine_fp_state', { p_week: week }) : null;
  const S = Object.assign({}, FP.DEFAULTS, state && state.settings ? state.settings : { mode: 'dry_run' });
  /* a run may only be made MORE careful than the owner's setting, never less */
  let mode = db ? S.mode : 'dry_run';
  if (o.mode === 'dry_run' && mode === 'auto') mode = 'dry_run';
  if (o.mode === 'off') mode = 'off';
  if (o.localAuto && !db) mode = 'auto';          /* tests and the production-like rehearsal only */
  const out = { ran: true, mode, week, slot: null, results: [], published: [], healed: [] };
  if (mode === 'off') { out.ran = false; out.reason = 'first-party publishing is off'; log('features: off'); return out; }

  const record = async (row) => {
    if (!db) return { ok: true, local: true, status: row.status };
    const r = await db.rpc('public', 'content_engine_fp_record', { p: row });
    return r || { ok: false, reason: 'no answer' };
  };
  const feats = loadFeatures();
  const onDisk = new Set(feats.map((r) => r.id));

  /* 0 · durable publication: put back a published record another job's push removed */
  ((state && state.published) || []).forEach((p) => {
    if (onDisk.has(p.id) || !p.article || !p.article.record) return;
    save(Object.assign({}, p.article.record, { status: 'published', published_at: p.published_at, updated_at: p.published_at }));
    out.healed.push(p.id); out.published.push(p.id);
  });

  const art = o.art || ART.load();
  const snap = CE.research.fromArtifacts(art, { now });
  const teamLists = ART.teamLists(art);
  const current = {};
  ['cfb', 'nfl'].forEach((lg) => ((snap[lg] && snap[lg].games) || []).forEach((p) => { current[p.game_id] = p; }));
  const games = loadGames().filter((r) => r.status === 'published');
  const taken = STORE.takenSlugs(games);
  feats.forEach((r) => { taken[r.slug] = r.id; });
  const site = feats.filter((r) => r.status === 'published').map((r) => ({ id: r.id, title: r.title, text: textOf(r) }))
    .concat(games.filter((r) => Date.parse(r.published_at || 0) > now - 21 * 86400000).map((r) => ({ id: r.id, title: r.title, text: gameText(r) })));
  const publisherTexts = state ? (state.publisher_texts || []) : publisherProxies(snap, now);
  const weekRows = (state && state.week) || feats.filter((r) => r.status === 'published' && weekOfIso(r.published_at) === week).map((r) => ({ id: r.id, kind: r.feature_kind, status: 'published' }));
  const publishedThisWeek = weekRows.filter((r) => r.status === 'published').map((r) => ({ id: r.id, kind: r.kind }));
  const baseCtx = { now, current, teamLists, settings: S, publishedThisWeek, site, taken, publisherTexts };

  /* 1 · what the owner approved */
  for (const ap of ((state && state.approved) || [])) {
    const rec = ap.article && ap.article.record, op = ap.article && ap.article.o;
    if (!rec || !op) continue;
    const a = { format: CE.firstParty.KINDS[op.fp_kind].format, base_format: CE.firstParty.KINDS[op.fp_kind].format, title: rec.title, slug: rec.slug, meta_description: rec.seo_description,
      primary_keyword: rec.primary_keyword, standfirst: rec.standfirst, sections: rec.sections, research_as_of: rec.research_as_of };
    const slot = { kind: op.fp_kind, id: rec.id, date: rec.slot_date, label: rec.category, publish_at: new Date(now).toISOString(), window_end: new Date(now + 3600000).toISOString() };
    const g = FP.gates(a, op, Object.assign({}, baseCtx, { slot }));
    /* the owner has judged what needed judging; what time can break still binds */
    const stillBinding = ['freshness', 'schedule', 'hard_checks', 'numbers', 'responsible', 'duplicate_site', 'seo', 'cadence'];
    const broken = g.gates.filter((x) => stillBinding.indexOf(x.key) >= 0 && !x.ok).map((x) => x.key);
    if (broken.length) {
      await record({ id: rec.id, kind: op.fp_kind, slot_date: rec.slot_date, week_of: weekOfIso(rec.generated_at) || week, status: 'skipped', mode: 'owner',
        content_hash: ap.content_hash, reason: 'approved, but no longer publishable: ' + broken.join(', '), failed: broken, gates: g.gates });
      out.results.push({ id: rec.id, kind: op.fp_kind, status: 'skipped', failed: broken });
      continue;
    }
    const pubRec = Object.assign({}, rec, { status: 'published', published_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(), owner_approved: true, gates: g.gates });
    const r = await record({ id: rec.id, kind: op.fp_kind, slot_date: rec.slot_date, week_of: week, status: 'published', mode: 'owner', title: rec.title, slug: rec.slug,
      url: rec.canonical_url, article: { record: pubRec, o: op }, content_hash: ap.content_hash, gates: g.gates, failed: g.failed, ce_verdict: g.ce_gate.verdict });
    if (r.ok) { save(pubRec); out.published.push(rec.id); }
    out.results.push({ id: rec.id, kind: op.fp_kind, status: r.ok ? 'published' : 'refused', reason: r.ok ? 'owner approved' : r.reason });
  }

  /* 2 · today's slot */
  const slot = FP.slot(now, S);
  const kind = o.kind || (slot && slot.kind);
  if (!kind) { log('features: no slot today (' + FP.ctDate(now) + ')' + summary(out)); return out; }
  const sl = slot && slot.kind === kind ? slot : { kind, id: 'feature-' + FP.ctDate(now) + '-' + kind.replace(/_/g, '-'), date: FP.ctDate(now), week, label: FP.KINDS[kind].label,
    publish_at: new Date(now).toISOString(), window_end: new Date(now + 3600000).toISOString() };
  out.slot = { kind, id: sl.id, publish_at: sl.publish_at, window_end: sl.window_end };
  /* --if-due: from two hours before the publish hour to the end of the window */
  if (o.ifDue && slot && (now < Date.parse(slot.publish_at) - 2 * 3600000 || now > Date.parse(slot.window_end))) {
    log('features: ' + kind + ' is not due (publishes ' + slot.publish_at + ')' + summary(out)); return out;
  }
  const prior = weekRows.filter((r) => r.id === sl.id)[0];
  if (prior && (prior.status === 'published' || prior.status === 'rejected' || prior.status === 'approved')) {
    out.results.push({ id: sl.id, kind, status: prior.status, reason: 'already ' + prior.status });
    log('features: ' + sl.id + ' is already ' + prior.status + summary(out)); return out;
  }
  const b = FP.build(kind, snap, { now, kickoff_lead_minutes: S.kickoff_lead_minutes });
  if (!b.ok) {
    await record({ id: sl.id, kind, slot_date: sl.date, week_of: week, status: 'skipped', mode: mode === 'auto' ? 'auto' : 'dry_run', reason: b.reason });
    out.results.push({ id: sl.id, kind, status: 'skipped', reason: b.reason });
    log('features: ' + sl.id + ' skipped — ' + b.reason + summary(out)); return out;
  }
  const g = FP.gates(b.article, b.o, Object.assign({}, baseCtx, { slot: sl }));
  const pastHour = now >= Date.parse(sl.publish_at);
  const verdict = g.ok ? (pastHour ? 'published' : 'scheduled') : 'held';
  const status = mode === 'auto' ? verdict : 'dry_run';
  const rec = FP.record(b.article, b.o, { now, slot: sl, status: status === 'published' ? 'published' : 'draft' });
  rec.gates = g.gates;
  const overlap = g.gates.filter((x) => x.key === 'duplicate_publisher' || x.key === 'duplicate_site').map((x) => ({ key: x.key, detail: x.detail }));
  const op = { fp_kind: b.o.fp_kind, kind: b.o.kind, league: b.o.league, season: b.o.season, week: b.o.week, research: b.o.research, sources: b.o.sources, formats: b.o.formats };
  const r = await record({ id: sl.id, kind, slot_date: sl.date, week_of: week, status, mode: mode === 'auto' ? 'auto' : 'dry_run', title: rec.title, slug: rec.slug, url: rec.canonical_url,
    article: { record: rec, o: op }, content_hash: rec.content_hash, gates: g.gates, failed: g.failed, ce_verdict: g.ce_gate.verdict,
    reason: g.ok ? (status === 'dry_run' ? 'dry run: would be ' + verdict : null) : 'held: ' + g.failed.join(', '), overlap });
  let finalStatus = status;
  if (status === 'published') {
    if (r.ok) { save(rec); out.published.push(rec.id); } else finalStatus = 'refused';
  }
  out.results.push({ id: sl.id, kind, status: finalStatus, would_be: verdict, failed: g.failed, reason: r.ok ? null : r.reason, words: b.article.word_count, ce_verdict: g.ce_gate.verdict });
  if (o.out) {
    fs.mkdirSync(o.out, { recursive: true });
    fs.writeFileSync(path.join(o.out, sl.id + '.report.json'), JSON.stringify({ status: finalStatus, would_be: verdict, gates: g.gates, ce_gate: g.ce_gate, record: rec }, null, 1));
    fs.writeFileSync(path.join(o.out, sl.id + '.html'), FEATURE.page(Object.assign({}, rec, { status: finalStatus === 'published' ? 'published' : 'draft', published_at: rec.published_at || new Date(now).toISOString() }), { noindex: finalStatus !== 'published' }));
  }
  log('features: ' + sl.id + ' → ' + finalStatus + (finalStatus === 'dry_run' ? ' (would be ' + verdict + ')' : '')
    + (g.failed.length ? ' · gates failed: ' + g.failed.join(', ') : ' · all twelve gates pass') + summary(out));
  return out;
}
function summary(out) {
  return (out.published.length ? ' · published: ' + out.published.join(', ') : '') + (out.healed.length ? ' · restored: ' + out.healed.join(', ') : '');
}

async function main() {
  const now = arg('now') ? Date.parse(arg('now')) : Date.now();
  const cfg = PGR.config(process.env);
  if (!cfg) console.log('features: no database credentials — a dry run (nothing is recorded or published)');
  const out = await run({ now, db: cfg ? PGR.client(cfg) : null, mode: arg('mode'), ifDue: flag('if-due'), kind: arg('kind'), out: arg('out') });
  const gh = arg('github-output');
  if (gh) fs.appendFileSync(gh, 'published=' + (out.published.length ? 1 : 0) + '\n');
}
if (require.main === module) main().catch((e) => { console.error('features: ' + (e && e.stack || e)); process.exit(1); });
module.exports = { run, publisherProxies };
