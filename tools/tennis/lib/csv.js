#!/usr/bin/env node
/* ===========================================================================
   A streaming CSV reader, RFC 4180, with no dependencies.

   WHY THIS EXISTS. This repository installs nothing: every script runs on a
   bare Node. The tennis archive is 361,571 rows of 108 columns, several of
   which are free text (`tourney_name`, `venue_name`, `score`) that quote and
   escape — "Queen's Club", a venue with a comma in it. A split on commas
   would silently shift every column after the first quoted one, and the damage
   would look like a data problem rather than a parser problem.

   It is a GENERATOR over rows, not an array: the full archive does not fit in
   a comfortable heap as 361k objects, and the importer never needs more than
   one chunk at a time.
   =========================================================================== */
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const cp = require('child_process');

/* Parse one CSV line-set from a buffer of text. Returns {rows, rest} where
   `rest` is the trailing partial record (a quoted field may span newlines). */
function parseChunk(text, carry) {
  const rows = [];
  let field = carry ? carry.field : '';
  let row = carry ? carry.row : [];
  let inQuotes = carry ? carry.inQuotes : false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  return { rows, carry: { field, row, inQuotes } };
}

/* Open a source by extension. Plain CSV, gzip, or a member of a zip.
   A .zip needs `unzip`, which is the one external tool this uses and which is
   present everywhere this runs; its absence is reported rather than guessed at. */
function openStream(file, opts) {
  opts = opts || {};
  if (/\.zip$/i.test(file)) {
    const member = opts.member;
    if (!member) throw new Error('a .zip needs --member <path inside the zip>');
    const have = cp.spawnSync('sh', ['-c', 'command -v unzip'], { encoding: 'utf8' }).status === 0;
    if (!have) throw new Error('unzip is not installed; extract the archive first and pass the .csv.gz');
    const child = cp.spawn('unzip', ['-p', file, member], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code) => { if (code !== 0 && err) child.stdout.emit('error', new Error('unzip: ' + err.trim())); });
    return /\.gz$/i.test(member) ? child.stdout.pipe(zlib.createGunzip()) : child.stdout;
  }
  const raw = fs.createReadStream(file);
  return /\.gz$/i.test(file) ? raw.pipe(zlib.createGunzip()) : raw;
}

/* Async iterator over {header, row, values, index}. The header is validated by
   the caller; this only promises that a row has the same arity as the header
   and says so when it does not, because a short row is a source change worth
   seeing rather than a set of trailing nulls. */
async function* readRows(file, opts) {
  opts = opts || {};
  const stream = openStream(file, opts);
  let carry = { field: '', row: [], inQuotes: false };
  let header = null;
  let index = 0;
  let pending = '';
  for await (const buf of stream) {
    pending += buf.toString('utf8');
    /* parse whole-lines only; keep the tail for the next buffer */
    const cut = pending.lastIndexOf('\n');
    if (cut < 0) continue;
    const text = pending.slice(0, cut + 1);
    pending = pending.slice(cut + 1);
    const out = parseChunk(text, carry);
    carry = out.carry;
    for (const cells of out.rows) {
      if (!header) { header = cells.map((h) => h.trim()); continue; }
      if (cells.length === 1 && cells[0] === '') continue;   // blank line
      index++;
      yield { header, values: cells, index };
    }
  }
  if (pending.length || carry.field.length || carry.row.length) {
    const out = parseChunk(pending + '\n', carry);
    for (const cells of out.rows) {
      if (!header) { header = cells.map((h) => h.trim()); continue; }
      if (cells.length === 1 && cells[0] === '') continue;
      index++;
      yield { header, values: cells, index };
    }
  }
}

/* Read only the header, cheaply. Used to validate the source contract before a
   single row is loaded. */
async function readHeader(file, opts) {
  for await (const r of readRows(file, opts)) return r.header;
  /* a file with a header and no rows still has a contract */
  const stream = openStream(file, opts);
  let text = '';
  for await (const buf of stream) {
    text += buf.toString('utf8');
    if (text.indexOf('\n') >= 0) break;
  }
  if (typeof stream.destroy === 'function') stream.destroy();
  const out = parseChunk(text.slice(0, text.indexOf('\n') + 1) || text + '\n', null);
  return out.rows.length ? out.rows[0].map((h) => h.trim()) : null;
}

function toObject(header, values) {
  const o = {};
  for (let i = 0; i < header.length; i++) o[header[i]] = i < values.length ? values[i] : null;
  return o;
}

/* Escape one value for a PostgreSQL COPY ... FROM STDIN in TEXT format. An
   empty string is \N (null) on purpose: the archive writes an absent number as
   an empty cell, and storing '' in a text staging column would make "absent"
   and "the empty string" the same thing two layers later. */
function copyEscape(v) {
  if (v == null) return '\\N';
  const s = String(v);
  if (s === '') return '\\N';
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}
function copyLine(values) {
  return values.map(copyEscape).join('\t') + '\n';
}

module.exports = { readRows, readHeader, toObject, parseChunk, copyEscape, copyLine, openStream };
