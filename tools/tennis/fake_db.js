#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk Tennis — the in-memory database the tests drive the pipeline with.

   A thin binding over tools/lib/fake_pgrest.js: the tennis lock is keyed by a
   tour-day (p_lock_key), and these are the tables whose rows the real schema
   gives a bigserial id.
   =========================================================================== */
'use strict';

const { fakePgrest, parseQuery } = require('../lib/fake_pgrest.js');

const SERIAL_TABLES = ['match_snapshots', 'market_captures', 'market_rejections'];

function fakeDb(seed) {
  return fakePgrest(seed, { lockArg: 'p_lock_key', serialTables: SERIAL_TABLES });
}

module.exports = { fakeDb, parseQuery, SERIAL_TABLES };
