#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk Tennis — verify a multi-part dataset upload against its manifest.

   WHY THIS EXISTS. The archive arrives as fourteen compressed parts because no
   single upload can carry 120 MB. Fourteen files is fourteen chances for one to
   go missing, arrive truncated, or be uploaded twice — and the failure mode of
   importing thirteen of fourteen parts is the worst kind: everything succeeds,
   every total reconciles against what was READ, and the record is quietly
   missing three years of one tour forever. Nothing downstream would ever say so.

   So the manifest is checked BEFORE anything is imported, and the check is
   mechanical:

     PRESENT      every part in the manifest has a file
     INTACT       its sha256 matches — not its name, not its size, its BYTES
     COMPLETE     its row count matches, counted by decompressing it
     ONE SCHEMA   all parts carry the same 108 columns in the same order
     RECONCILED   the parts' rows sum to the manifest's declared total

   A duplicate upload of the same part is fine and is reported as such: the same
   bytes twice is the same part, and the importer reads one of them.

   It refuses to guess. A part whose sha256 does not match is named and the
   verification fails, because a truncated gzip usually still decompresses.

   Usage:
     node tools/tennis/verify_parts.js --manifest <manifest.json|manifest.csv> --dir <dir>
     node tools/tennis/verify_parts.js --manifest ... --dir ... --json
     node tools/tennis/verify_parts.js --manifest ... --dir ... --quick   # skip row counts

   Exit codes: 0 verified · 1 a part is missing or invalid · 2 bad arguments
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const CSV = require('./lib/csv.js');
const M = require('../../lib/tennis_model.js');

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--manifest') o.manifest = next();
    else if (a === '--dir') o.dir = next();
    else if (a === '--json') o.json = true;
    else if (a === '--quick') o.quick = true;
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}
const say = (...a) => console.log(...a);
const fail = (...a) => console.error('::error::' + a.join(' '));

/* The manifest, from either shape it ships in. */
function readManifest(file) {
  const raw = fs.readFileSync(file, 'utf8');
  if (/\.json$/i.test(file) || raw.trim().startsWith('{')) {
    const j = JSON.parse(raw);
    return { parts: j.parts, rows: j.rows,
             files: (j.files || []).map((f) => ({
               part: Number(f.part), file: f.file, tour: f.tour, years: f.years,
               rows: Number(f.rows), columns: Number(f.columns),
               bytes: Number(f.bytes), sha256: String(f.sha256).toLowerCase() })) };
  }
  const lines = raw.split('\n').filter((l) => l.trim());
  const head = lines[0].split(',').map((h) => h.trim());
  const ix = {}; head.forEach((h, i) => { ix[h] = i; });
  const files = lines.slice(1).map((l) => {
    const c = l.split(',');
    return { part: Number(c[ix.part]), file: c[ix.file], tour: c[ix.tour], years: c[ix.years],
             rows: Number(c[ix.rows]), columns: Number(c[ix.columns]),
             bytes: Number(c[ix.bytes]), sha256: String(c[ix.sha256] || '').trim().toLowerCase() };
  });
  return { parts: files.length, rows: files.reduce((a, f) => a + f.rows, 0), files };
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

/* Count the data rows and read the header. The whole point is to decompress:
   a truncated gzip often still produces bytes, so only a full read proves a
   part is whole. */
async function inspect(file) {
  let rows = 0, header = null;
  for await (const r of CSV.readRows(file)) { if (!header) header = r.header; rows++; }
  if (!header) header = await CSV.readHeader(file);
  return { rows, header };
}

/* Match uploaded files to manifest entries BY CONTENT, not by name. A host that
   prefixes an upload with a random id (which is what happens here) would defeat
   a name match, and a name is not evidence of anything anyway. */
async function index(dir) {
  const out = new Map();          // sha256 -> [paths]
  const entries = fs.readdirSync(dir).filter((f) => /\.csv(\.gz)?$/i.test(f));
  for (const f of entries) {
    const p = path.join(dir, f);
    if (!fs.statSync(p).isFile()) continue;
    const h = await sha256(p);
    if (!out.has(h)) out.set(h, []);
    out.get(h).push(p);
  }
  return out;
}

async function main() {
  const o = args(process.argv.slice(2));
  if (o.help || !o.manifest || !o.dir) {
    say(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
    return o.help ? 0 : 2;
  }
  if (!fs.existsSync(o.manifest)) { fail('no such manifest: ' + o.manifest); return 2; }
  if (!fs.existsSync(o.dir)) { fail('no such directory: ' + o.dir); return 2; }

  const man = readManifest(o.manifest);
  const byHash = await index(o.dir);

  const report = { manifest: path.basename(o.manifest), dir: o.dir,
                   declared_parts: man.parts, declared_rows: man.rows,
                   parts: [], duplicates: [], unexpected: [],
                   present: 0, missing: 0, invalid: 0, counted_rows: 0, verified: false };

  const claimed = new Set();
  for (const f of man.files) {
    const hit = byHash.get(f.sha256);
    const row = { part: f.part, file: f.file, tour: f.tour, years: f.years,
                  declared_rows: f.rows, declared_bytes: f.bytes, status: null,
                  path: null, actual_rows: null, actual_columns: null, note: null };
    if (!hit) {
      /* Is a file with that NAME there, but with different bytes? That is a
         different and more alarming failure than absence. */
      const named = fs.readdirSync(o.dir).filter((x) => x.endsWith(f.file));
      if (named.length) {
        row.status = 'CORRUPT';
        row.path = path.join(o.dir, named[0]);
        row.note = 'a file with this name is present but its sha256 does not match the manifest';
        report.invalid++;
      } else {
        row.status = 'MISSING';
        row.note = 'no file in this directory has this checksum';
        report.missing++;
      }
      report.parts.push(row);
      continue;
    }
    claimed.add(f.sha256);
    row.path = hit[0];
    if (hit.length > 1) {
      report.duplicates.push({ part: f.part, file: f.file, copies: hit.length,
                               paths: hit.map((p) => path.basename(p)) });
      row.note = hit.length + ' identical copies uploaded; one is read';
    }
    const bytes = fs.statSync(hit[0]).size;
    if (f.bytes && bytes !== f.bytes) {
      row.status = 'CORRUPT';
      row.note = 'byte size ' + bytes + ' does not match the manifest\'s ' + f.bytes;
      report.invalid++;
      report.parts.push(row);
      continue;
    }
    if (o.quick) {
      row.status = 'INTACT';
      report.present++;
      report.counted_rows += f.rows;      // declared, not counted — --quick says so
      report.parts.push(row);
      continue;
    }
    let got;
    try { got = await inspect(hit[0]); }
    catch (e) {
      row.status = 'CORRUPT';
      row.note = 'could not be decompressed and read: ' + String(e.message).slice(0, 120);
      report.invalid++;
      report.parts.push(row);
      continue;
    }
    row.actual_rows = got.rows;
    row.actual_columns = got.header ? got.header.length : 0;
    row.header = got.header;
    if (f.rows && got.rows !== f.rows) {
      row.status = 'SHORT';
      row.note = 'holds ' + got.rows + ' rows, the manifest declares ' + f.rows;
      report.invalid++;
    } else if (f.columns && row.actual_columns !== f.columns) {
      row.status = 'SHAPE';
      row.note = 'holds ' + row.actual_columns + ' columns, the manifest declares ' + f.columns;
      report.invalid++;
    } else {
      row.status = 'VERIFIED';
      report.present++;
      report.counted_rows += got.rows;
    }
    report.parts.push(row);
  }

  for (const [h, paths] of byHash) {
    if (!claimed.has(h)) report.unexpected.push({ sha256: h, files: paths.map((p) => path.basename(p)) });
  }

  /* ONE SCHEMA across every part. Concatenating files whose columns differ in
     ORDER would silently shift every value after the first difference. */
  const headers = report.parts.filter((p) => p.header).map((p) => ({ part: p.part, h: p.header.join(',') }));
  const schemas = [...new Set(headers.map((x) => x.h))];
  report.schema_consistent = schemas.length <= 1;
  if (!report.schema_consistent) {
    report.schema_note = 'parts do not share one column order: ' +
      schemas.map((s, i) => 'shape ' + (i + 1) + ' in part(s) ' +
        headers.filter((x) => x.h === s).map((x) => x.part).join(',')).join(' | ');
  }
  if (headers.length) {
    const cols = headers[0].h.split(',');
    report.columns = cols.length;
    report.missing_required = M.REQUIRED_COLUMNS.filter((c) => cols.indexOf(c) < 0);
  }

  report.rows_reconcile = !o.quick && report.counted_rows === man.rows;
  report.verified = report.missing === 0 && report.invalid === 0 &&
                    report.schema_consistent !== false &&
                    (!report.missing_required || report.missing_required.length === 0) &&
                    (o.quick || report.rows_reconcile);

  if (o.json) { say(JSON.stringify(report, null, 2)); return report.verified ? 0 : 1; }

  /* ── the report a person reads ─────────────────────────────────────── */
  say('manifest    : ' + report.manifest + '  (' + man.parts + ' parts, ' + man.rows.toLocaleString() + ' rows declared)');
  say('directory   : ' + o.dir);
  say('');
  say('  part  tour  years        declared      counted  status');
  say('  ----  ----  ---------  ----------  -----------  ------');
  report.parts.forEach((p) => {
    say('  ' + String(p.part).padStart(4) + '  ' + String(p.tour || '').padEnd(4) + '  ' +
        String(p.years || '').padEnd(9) + '  ' + String(p.declared_rows || 0).padStart(10) + '  ' +
        String(p.actual_rows == null ? '—' : p.actual_rows).padStart(11) + '  ' + p.status +
        (p.note ? '\n        ' + p.note : ''));
  });
  say('');
  if (report.duplicates.length) {
    say('  duplicate uploads (harmless — the same bytes twice is the same part):');
    report.duplicates.forEach((d) => say('    part ' + d.part + ' × ' + d.copies));
    say('');
  }
  if (report.unexpected.length) {
    say('  files in this directory that are in no manifest entry:');
    report.unexpected.forEach((u) => say('    ' + u.files.join(', ') + '  (sha256 ' + u.sha256.slice(0, 16) + '…)'));
    say('');
  }
  say('  ── reconciliation ─────────────────────────────────────────');
  say('  parts declared         ' + String(man.parts).padStart(10));
  say('  parts verified         ' + String(report.present).padStart(10));
  say('  parts MISSING          ' + String(report.missing).padStart(10));
  say('  parts INVALID          ' + String(report.invalid).padStart(10));
  say('  rows declared          ' + String(man.rows).padStart(10));
  say('  rows counted           ' + String(o.quick ? '(skipped)' : report.counted_rows).padStart(10));
  say('  one column order       ' + String(report.schema_consistent ? 'yes (' + report.columns + ' columns)' : 'NO').padStart(10));
  if (report.schema_note) say('    ' + report.schema_note);
  if (report.missing_required && report.missing_required.length)
    say('  MISSING REQUIRED COLUMNS: ' + report.missing_required.join(', '));
  say('');

  if (report.verified) {
    say('  VERIFIED — all ' + man.parts + ' parts present, intact, and reconciling to ' +
        man.rows.toLocaleString() + ' rows.');
    say('  Safe to import.');
    return 0;
  }

  const missing = report.parts.filter((p) => p.status === 'MISSING');
  const bad = report.parts.filter((p) => ['CORRUPT', 'SHORT', 'SHAPE'].indexOf(p.status) >= 0);
  fail('NOT VERIFIED — the dataset is incomplete. Nothing should be imported from it.');
  say('');
  if (missing.length) {
    say('  MISSING, by name — re-upload exactly these:');
    missing.forEach((p) => {
      const f = man.files.find((x) => x.part === p.part);
      say('    part ' + p.part + '  ' + p.file);
      say('              ' + p.declared_rows.toLocaleString() + ' rows · ' +
          p.declared_bytes.toLocaleString() + ' bytes · sha256 ' + f.sha256);
    });
  }
  if (bad.length) {
    say('  INVALID — present but does not match the manifest:');
    bad.forEach((p) => say('    part ' + p.part + '  ' + p.file + '  (' + p.status + ': ' + p.note + ')'));
  }
  say('');
  say('  Why this matters: importing ' + report.present + ' of ' + man.parts + ' parts would SUCCEED.');
  say('  Every total would reconcile against what was read, and the record would be');
  say('  permanently missing ' + (man.rows - report.counted_rows).toLocaleString() +
      ' matches with nothing downstream ever saying so.');
  return 1;
}

if (require.main === module) main().then((c) => process.exit(c)).catch((e) => { fail(String(e && e.stack || e)); process.exit(1); });
module.exports = { readManifest, inspect, index };
