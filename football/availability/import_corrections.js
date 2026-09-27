#!/usr/bin/env node
/* ===========================================================================
   IMPORT A BATCH OF OPERATOR CORRECTIONS from a CSV — the same narrow door as
   record_correction.js, many entries at once. A person who looked up this
   week's availability (a conference report, a school's release, a coach's
   press conference) fills football/availability/manual/<week>.csv from the
   TEMPLATE and runs:

     node football/availability/import_corrections.js football/availability/manual/2026-w04.csv [--dry-run]

   Every row is validated by operator.js: a row without a named player on the
   roster, a fixture, a source name AND url, a publication time and a recorder
   is REFUSED with its reasons and NOT written; the rest are appended to
   operator.json, which overlay.js merges for every consumer. The file is
   labelled with its rows' outcome so nothing sits inert.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const O = require(path.join(__dirname, 'operator.js'));
const R = require(path.join(__dirname, '..', 'data', 'recovery.js'));
const STORE = path.join(__dirname, 'operator.json');
/** Turn CSV rows into entries and validate each. Pure. */
function importRows(rows, nowMs) {
  const accepted = [], refused = [];
  rows.forEach((r, i) => {
    if (/example row/i.test(String(r.note || ''))) { refused.push({ row: i + 1, reasons: ['template example row'] }); return; }
    const entry = { kind: String(r.kind || '').toUpperCase(), team: r.team || null, player: r.player || null, position: r.position || null, status: r.status ? String(r.status).toUpperCase() : null, confirmed: /^(true|yes|1)$/i.test(String(r.confirmed || '')), game_id: r.game_id ? String(r.game_id) : null, kickoff: r.kickoff || null, expires_at: r.expires_at || null, source_name: r.source_name || null, source_url: r.source_url || null, published_at: r.published_at || null, recorded_by: r.by || r.recorded_by || null, recorded_at: new Date(nowMs).toISOString(), note: r.note || null };
    const v = O.validate(entry, nowMs);
    if (v.ok) accepted.push(entry); else refused.push({ row: i + 1, team: entry.team, player: entry.player, reasons: v.why });
  });
  return { accepted, refused };
}
function main() {
  const args = process.argv.slice(2); const file = args.find((a) => !a.startsWith('--'));
  if (!file) { console.error('usage: node football/availability/import_corrections.js <file.csv> [--dry-run]'); return 2; }
  const rows = R.parseCsv(fs.readFileSync(file, 'utf8'));
  const { accepted, refused } = importRows(rows, Date.now());
  refused.forEach((x) => console.error('[import] row ' + x.row + ' REFUSED' + (x.player ? ' (' + x.team + ' / ' + x.player + ')' : '') + ': ' + x.reasons.join('; ')));
  console.log('[import] ' + accepted.length + ' accepted, ' + refused.length + ' refused' + (args.includes('--dry-run') ? ' (dry run, nothing written)' : ''));
  if (args.includes('--dry-run') || !accepted.length) return refused.length && !accepted.length ? 2 : 0;
  let store; try { store = JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch (_) { store = { schema: O.SCHEMA, entries: [] }; }
  store.entries = (store.entries || []).concat(accepted); fs.writeFileSync(STORE, JSON.stringify(store, null, 1) + '\n');
  console.log('[import] wrote ' + accepted.length + ' entr(ies) to football/availability/operator.json');
  return 0;
}
module.exports = { importRows, STORE };
if (require.main === module) process.exit(main());
