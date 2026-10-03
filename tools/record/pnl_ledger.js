#!/usr/bin/env node
/* ===========================================================================
   THE P&L LEDGER — build record/pnl/ from the ledgers the pipelines keep.
   docs/pnl/DESIGN.md · rules in tools/record/pnl_core.js · arithmetic in
   lib/edgedesk_pnl.js

   READS (never writes) the committed, append-only ledgers:
     football/props/<nfl|cfb>/<season>/evaluations.jsonl + results.jsonl
     football/cfb_terminal/decisions/<season>/snapshots.jsonl + evaluations.jsonl
     record/football/<nfl|cfb>_<season>.json
   WRITES
     record/pnl/ledger_<season>.json   every recommendation, one row each, with its
                                       settlement, its P&L status and its corrections
     record/pnl/summary.json           every figure the Record's P&L section prints
     record/pnl/rows_<season>.json     the page's copy of the ledger (columnar)
     record/pnl/stamp.json             a few bytes the open page polls: it changes
                                       only when the rows do, so the Records page
                                       refreshes itself after a settlement run

   EVERY ROW RESOLVES TO ONE STATE (lib/edgedesk_pnl.js record_state):
   PENDING, VERIFIED (settled at a captured price), RECORD_ONLY (a result, no
   usable entry price), VOID or INVALID. A pending row carries WHY
   (pending_reason, pnl_core.pendingReason): upcoming, in progress, awaiting
   the settlement run or the stat feed, missing final, missing player stat,
   settlement job failed, missing mapping — from the settling jobs' own
   diagnostics (football/props/<lg>/settlement.json) and the finals EdgeDesk
   holds (the model record; football/cfb_lab/ledger/<season>/results.jsonl).

   Idempotent: a second run over the same inputs changes nothing (the files
   are rewritten only when a fact moved). A settlement that changed at its
   source updates its row and is logged on it; nothing is ever deleted.

     node tools/record/pnl_ledger.js                 # dry run: prints what would change
     node tools/record/pnl_ledger.js --write         # write record/pnl/
     node tools/record/pnl_ledger.js --check         # exit 1 if the committed files are stale
     options: --season 2026  --now <ISO>  --out record/pnl  --root <dir>
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('./pnl_core.js');
const PNL = require(path.join(__dirname, '..', '..', 'lib', 'edgedesk_pnl.js'));
const { writeIfChanged, strip } = require(path.join(__dirname, '..', 'football', 'write_if_changed.js'));

const ROOT_DEFAULT = path.join(__dirname, '..', '..');
/* every game-decision ledger the build knows; a new league's decision stage
   is one more directory here */
const DECISION_LEDGERS = ['football/cfb_terminal/decisions', 'football/nfl_terminal/decisions'];
const PROP_LEAGUES = ['nfl', 'cfb'];
const RECORD_SPORTS = ['nfl', 'cfb'];

function args(argv) {
  const a = { write: false, check: false, season: null, now: null, out: 'record/pnl', root: ROOT_DEFAULT };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--write') a.write = true;
    else if (k === '--check') a.check = true;
    else if (k === '--season') a.season = Number(argv[++i]);
    else if (k === '--now') a.now = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--root') a.root = path.resolve(argv[++i]);
    else throw new Error('unknown option ' + k);
  }
  return a;
}
function seasonOf(ms) { const d = new Date(ms); return d.getUTCMonth() <= 1 ? d.getUTCFullYear() - 1 : d.getUTCFullYear(); }
function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } }
function rel(root, f) { return path.relative(root, f).split(path.sep).join('/'); }

/* ---------------------------------------------------------------- inputs */
function load(root, season) {
  const records = RECORD_SPORTS.map((s) => ({ sport: s, file: path.join(root, 'record', 'football', s + '_' + season + '.json') }))
    .map((x) => ({ sport: x.sport, file: x.file, L: readJson(x.file) }));
  const events = core.eventIndex(records.map((x) => x.L));
  const rows = [];
  const sources = [];
  PROP_LEAGUES.forEach((lg) => {
    const dir = path.join(root, 'football', 'props', lg, String(season));
    const ef = path.join(dir, 'evaluations.jsonl'), rf = path.join(dir, 'results.jsonl');
    const evals = readJsonl(ef), results = readJsonl(rf);
    if (!evals.length) return;
    const got = core.propRows(lg, evals, results, events, rel(root, ef));
    rows.push(...got);
    sources.push({ source: 'player_props', league: lg.toUpperCase(), file: rel(root, ef), rows: got.length, results_file: rel(root, rf), results: results.length });
  });
  DECISION_LEDGERS.forEach((d) => {
    const dir = path.join(root, d, String(season));
    const sf = path.join(dir, 'snapshots.jsonl'), ef = path.join(dir, 'evaluations.jsonl');
    const snaps = readJsonl(sf);
    if (!snaps.length) return;
    const got = core.decisionRows(snaps, readJsonl(ef), events, rel(root, sf));
    rows.push(...got);
    sources.push({ source: 'bettor_decision', file: rel(root, sf), snapshots: snaps.length, rows: got.length, evaluations_file: rel(root, ef) });
  });
  records.forEach((x) => {
    if (!x.L) return;
    const got = core.modelRecordRows(x.L, rel(root, x.file));
    rows.push(...got);
    sources.push({ source: 'model_record', league: x.sport.toUpperCase(), file: rel(root, x.file), rows: got.length, note: 'no price captured: record-only rows' });
  });
  return { rows, sources, excluded: excluded(root, season), ctx: settlementContext(root, season, events) };
}

/* what the settling jobs say about the rows they have not settled yet, and
   every final EdgeDesk holds — the inputs of pnl_core.pendingReason */
function settlementContext(root, season, events) {
  const props = {}, status = {};
  PROP_LEAGUES.forEach((lg) => {
    const f = path.join(root, 'football', 'props', lg, 'settlement.json');
    const doc = readJson(f);
    if (doc && Number(doc.season) === Number(season)) {
      props[lg.toUpperCase()] = doc;
      status[lg.toUpperCase()] = { file: rel(root, f), checked_at: doc.checked_at || null, dataset_ok: !!(doc.dataset && doc.dataset.ok), started_unsettled: Object.keys(doc.pending || {}).length };
    } else status[lg.toUpperCase()] = { file: rel(root, f), checked_at: null, dataset_ok: null, started_unsettled: null, note: 'no settlement status written yet' };
  });
  const lab = readJsonl(path.join(root, 'football', 'cfb_lab', 'ledger', String(season), 'results.jsonl'));
  return { events, finals: core.finalIndex(events, lab), props, status };
}

/* what is deliberately left out, and why — counted so the page can say so */
function excluded(root, season) {
  const out = [];
  const lab = readJsonl(path.join(root, 'football', 'cfb_lab', 'ledger', String(season), 'evaluations.jsonl'));
  const assumed = lab.filter((x) => x.price_assumed === true && x.ats_result && String(x.origin).toUpperCase() !== 'REPLAY');
  if (lab.length) {
    out.push({ source: 'CFB Model Lab', file: 'football/cfb_lab/ledger/' + season + '/evaluations.jsonl', rows: assumed.length,
      reason: 'research positions graded at an ASSUMED −110 (price_assumed); simulated, so never counted as verified P&L' });
    const replay = lab.filter((x) => String(x.origin).toUpperCase() === 'REPLAY').length;
    if (replay) out.push({ source: 'CFB Model Lab replays', file: 'football/cfb_lab/ledger/' + season + '/evaluations.jsonl', rows: replay, reason: 'backtest replays of past games, not recommendations that existed at the time' });
  }
  const shadow = readJsonl(path.join(root, 'football', 'cfb_decision', String(season), 'decisions.jsonl'));
  if (shadow.length) out.push({ source: 'CFB decision engine (shadow)', file: 'football/cfb_decision/' + season + '/decisions.jsonl', rows: shadow.length, reason: 'a shadow engine under evaluation; its calls are not published EdgeDesk recommendations' });
  return out;
}

function build(o) {
  const now = o.now ? Date.parse(o.now) : Date.now();
  if (!Number.isFinite(now)) throw new Error('bad --now');
  const season = o.season || seasonOf(now);
  const outDir = path.join(o.root, o.out);
  const lf = path.join(outDir, 'ledger_' + season + '.json'), sf = path.join(outDir, 'summary.json'), pf = path.join(outDir, 'rows_' + season + '.json');
  const prev = readJson(lf);
  const src = load(o.root, season);
  const M = core.merge(prev && prev.schema === core.LEDGER_SCHEMA ? prev : null, src.rows, now);
  /* why each pending row is pending, as of this run */
  M.rows.forEach((r) => { const why = core.pendingReason(r, src.ctx, now); if (why) r.pending_reason = why; else delete r.pending_reason; });
  const generated = new Date(now).toISOString();
  const ledger = {
    schema: core.LEDGER_SCHEMA, season, generated_at: generated,
    what: 'Every EdgeDesk recommendation with a side, one row each, with its settlement and its profit and loss at the price recorded when it was made. Written by tools/record/pnl_ledger.js; nobody edits it by hand.',
    sources: src.sources,
    rows: M.rows
  };
  const summary = core.summarize(ledger, { generated_at: generated, excluded_sources: src.excluded, integrity_alerts: M.report.integrity_alerts,
    settlement: { as_of: generated, props: src.ctx.status, finals_known: Object.keys(src.ctx.finals).length } });
  summary.sources = src.sources;
  summary.ledger_file = rel(o.root, lf);
  summary.rows_file = rel(o.root, pf);
  const page = core.pageRows(ledger);
  const stamp = { schema: 'edgedesk_pnl_stamp_v1', season, generated_at: generated, rows: page.rows.length,
    digest: crypto.createHash('sha1').update(JSON.stringify(page.rows)).digest('hex').slice(0, 16) };
  return { season, ledger, summary, page, stamp, report: M.report, files: { ledger: lf, summary: sf, rows: pf, stamp: path.join(outDir, 'stamp.json') }, prev };
}

function main() {
  const o = args(process.argv);
  const B = build(o);
  const q = core.summarize(B.ledger, {}).views.all.data_quality;
  console.log('[pnl] season ' + B.season + ': ' + B.ledger.rows.length + ' rows · added ' + B.report.added + ' · settled ' + B.report.settled + ' · corrected ' + B.report.corrected
    + ' · unchanged ' + B.report.unchanged + (B.report.kept_missing_source ? ' · kept (source missing) ' + B.report.kept_missing_source : '')
    + ' · prices locked ' + B.report.price_locked + (B.report.lock_kept ? ' · locks kept past their source ' + B.report.lock_kept : ''));
  console.log('[pnl] verified ' + q.verified + ' · pending ' + q.pending + ' · void ' + q.voids + ' · no entry price ' + q.missing_entry_odds + ' · simulated ' + q.simulated_price
    + ' · BET rows ' + B.summary.counts.bets + ' (verified ' + B.summary.counts.verified_bets + ')');
  const V = B.summary.verified, vc = V.views.all.staked;
  console.log('[pnl] VERIFIED P&L: ' + vc.priced + ' priced of ' + vc.graded + ' graded (' + vc.record_only + ' record only) · net ' + PNL.fmtUnits(vc.net_units) + ' · risked ' + (vc.risked_units == null ? '—' : vc.risked_units.toFixed(2) + 'u')
    + ' · ROI ' + PNL.fmtPct(vc.roi_pct, 2, true) + ' · reconciles ' + (V.reconcile.ok ? 'yes' : 'NO') + ' · audit errors ' + V.audit.errors);
  const st = B.summary.states, rec = B.summary.record.all;
  console.log('[pnl] states: ' + ['PENDING', 'VERIFIED', 'RECORD_ONLY', 'VOID', 'INVALID'].map((k) => k + ' ' + st[k]).join(' · ') + ' (of ' + st.total + ')');
  console.log('[pnl] graded record ' + rec.record + ' over ' + rec.graded + ' (' + rec.verified + ' verified, ' + rec.record_only + ' record only)');
  console.log('[pnl] pending: ' + (B.summary.pending_reasons.reasons.map((x) => x.key + ' ' + x.n).join(' · ') || 'none'));
  if (!B.summary.integrity.ok) Object.keys(B.summary.integrity.checks).forEach((k) => B.summary.integrity.checks[k].failed.forEach((f) => console.log('[pnl] INTEGRITY FAILED ' + k + ': ' + f.label + ' — expected ' + JSON.stringify(f.expected) + ', got ' + JSON.stringify(f.got))));
  B.report.integrity_alerts.slice(0, 20).forEach((a) => console.log('[pnl] INTEGRITY ' + a.recommendation_id + ' ' + a.field + ': ledger ' + JSON.stringify(a.ledger) + ' vs source ' + JSON.stringify(a.source) + ' — ' + a.action));
  if (B.report.duplicates_in_sources) console.log('[pnl] ' + B.report.duplicates_in_sources + ' duplicate source rows ignored (one row per recommendation)');
  if (o.check) {
    const sPrev = readJson(B.files.summary), lPrev = B.prev, pPrev = readJson(B.files.rows), tPrev = readJson(B.files.stamp);
    const differs = (a, b) => !a || JSON.stringify(strip(a)) !== JSON.stringify(strip(b));
    const stale = differs(lPrev, B.ledger) || differs(sPrev, B.summary) || differs(pPrev, B.page) || differs(tPrev, B.stamp);
    console.log(stale ? '[pnl] CHECK: record/pnl is stale — run with --write' : '[pnl] CHECK: record/pnl is current');
    return stale ? 1 : 0;
  }
  if (!o.write) { console.log('[pnl] dry run: nothing written (pass --write)'); return 0; }
  console.log('[pnl] ' + path.basename(B.files.ledger) + ' ' + writeIfChanged(B.files.ledger, B.ledger, { pretty: true, newline: true }));
  console.log('[pnl] ' + path.basename(B.files.rows) + ' ' + writeIfChanged(B.files.rows, B.page));
  console.log('[pnl] summary.json ' + writeIfChanged(B.files.summary, B.summary, { pretty: true, newline: true }));
  console.log('[pnl] stamp.json ' + writeIfChanged(B.files.stamp, B.stamp, { pretty: true, newline: true }));
  /* a disagreement between the page's figures is an internal error: the
     files are written (they are the evidence), the run fails loudly */
  if (!B.summary.integrity.ok) { console.error('[pnl] the integrity checks failed — see above'); return 2; }
  if (B.summary.verified.audit.errors || !B.summary.verified.reconcile.ok) { console.error('[pnl] the Verified P&L audit failed: ' + JSON.stringify(B.summary.verified.audit.by_check) + ' reconcile ' + JSON.stringify(B.summary.verified.reconcile)); return 2; }
  return 0;
}

module.exports = { build, load, excluded, settlementContext, args, DECISION_LEDGERS };
if (require.main === module) {
  try { process.exit(main()); } catch (e) { console.error('[pnl] ' + (e.stack || e.message)); process.exit(1); }
}
