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
const core = require('./pnl_core.js');
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
  return { rows, sources, excluded: excluded(root, season) };
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
  const generated = new Date(now).toISOString();
  const ledger = {
    schema: core.LEDGER_SCHEMA, season, generated_at: generated,
    what: 'Every EdgeDesk recommendation with a side, one row each, with its settlement and its profit and loss at the price recorded when it was made. Written by tools/record/pnl_ledger.js; nobody edits it by hand.',
    sources: src.sources,
    rows: M.rows
  };
  const summary = core.summarize(ledger, { generated_at: generated, excluded_sources: src.excluded, integrity_alerts: M.report.integrity_alerts });
  summary.sources = src.sources;
  summary.ledger_file = rel(o.root, lf);
  summary.rows_file = rel(o.root, pf);
  const page = core.pageRows(ledger);
  return { season, ledger, summary, page, report: M.report, files: { ledger: lf, summary: sf, rows: pf }, prev };
}

function main() {
  const o = args(process.argv);
  const B = build(o);
  const q = core.summarize(B.ledger, {}).views.all.data_quality;
  console.log('[pnl] season ' + B.season + ': ' + B.ledger.rows.length + ' rows · added ' + B.report.added + ' · settled ' + B.report.settled + ' · corrected ' + B.report.corrected
    + ' · unchanged ' + B.report.unchanged + (B.report.kept_missing_source ? ' · kept (source missing) ' + B.report.kept_missing_source : ''));
  console.log('[pnl] verified ' + q.verified + ' · pending ' + q.pending + ' · void ' + q.voids + ' · no entry price ' + q.missing_entry_odds + ' · simulated ' + q.simulated_price
    + ' · BET rows ' + B.summary.counts.bets + ' (verified ' + B.summary.counts.verified_bets + ')');
  B.report.integrity_alerts.slice(0, 20).forEach((a) => console.log('[pnl] INTEGRITY ' + a.recommendation_id + ' ' + a.field + ': ledger ' + JSON.stringify(a.ledger) + ' vs source ' + JSON.stringify(a.source) + ' — ' + a.action));
  if (B.report.duplicates_in_sources) console.log('[pnl] ' + B.report.duplicates_in_sources + ' duplicate source rows ignored (one row per recommendation)');
  if (o.check) {
    const sPrev = readJson(B.files.summary), lPrev = B.prev, pPrev = readJson(B.files.rows);
    const differs = (a, b) => !a || JSON.stringify(strip(a)) !== JSON.stringify(strip(b));
    const stale = differs(lPrev, B.ledger) || differs(sPrev, B.summary) || differs(pPrev, B.page);
    console.log(stale ? '[pnl] CHECK: record/pnl is stale — run with --write' : '[pnl] CHECK: record/pnl is current');
    return stale ? 1 : 0;
  }
  if (!o.write) { console.log('[pnl] dry run: nothing written (pass --write)'); return 0; }
  console.log('[pnl] ' + path.basename(B.files.ledger) + ' ' + writeIfChanged(B.files.ledger, B.ledger, { pretty: true, newline: true }));
  console.log('[pnl] ' + path.basename(B.files.rows) + ' ' + writeIfChanged(B.files.rows, B.page));
  console.log('[pnl] summary.json ' + writeIfChanged(B.files.summary, B.summary, { pretty: true, newline: true }));
  return 0;
}

module.exports = { build, load, excluded, args, DECISION_LEDGERS };
if (require.main === module) {
  try { process.exit(main()); } catch (e) { console.error('[pnl] ' + (e.stack || e.message)); process.exit(1); }
}
