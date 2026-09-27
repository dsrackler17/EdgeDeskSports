#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk Tennis — the in-memory database the tests drive the pipeline with.

   A thin binding over tools/lib/fake_pgrest.js: the tennis lock is keyed by a
   tour-day (p_lock_key), and these are the tables whose rows the real schema
   gives a bigserial id.
   =========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const { fakePgrest, parseQuery } = require('../lib/fake_pgrest.js');

const SERIAL_TABLES = ['match_snapshots', 'market_captures', 'market_rejections'];

/* THE REQUIRED COLUMNS, READ FROM THE CONTRACT ITSELF. Every column the SQL
   declares `not null` with no default is one a write must carry, whether the
   row is new or already on file (see fake_pgrest.js on why). Parsing the .sql
   rather than listing the columns here means a column added to the contract
   is enforced on the next test run, not on the next production failure. */
const CONTRACTS = ['tennis_live_center.sql', 'tennis_player_directory.sql'];
function requiredColumns() {
  const out = {};
  for (const f of CONTRACTS) {
    let sql = '';
    try { sql = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', f), 'utf8'); } catch (_) { continue; }
    const re = /create table if not exists tennis\.(\w+)\s*\(([\s\S]*?)\n\);/g;
    let m;
    while ((m = re.exec(sql))) {
      const cols = out[m[1]] || (out[m[1]] = []);
      m[2].split('\n').forEach(line => {
        if (/^\s*constraint\b/i.test(line) || /\bdefault\b/i.test(line) || /primary key/i.test(line)) return;
        const c = /^\s*(\w+)\s+[a-z]+.*\bnot null\b/i.exec(line);
        if (c && cols.indexOf(c[1]) < 0) cols.push(c[1]);
      });
    }
  }
  return out;
}
const NOT_NULL = requiredColumns();

function fakeDb(seed) {
  return fakePgrest(seed, { lockArg: 'p_lock_key', serialTables: SERIAL_TABLES, notNull: NOT_NULL });
}

module.exports = { fakeDb, parseQuery, SERIAL_TABLES, NOT_NULL, requiredColumns };
