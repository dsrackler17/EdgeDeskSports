#!/usr/bin/env node
/* The tennis pipeline's database door: the shared PostgREST client bound to
   this sport's schema, so every job here says `db.select('tennis', …)` through
   the same transport the rest of the estate uses. See tools/lib/pgrest.js. */
'use strict';
const P = require('../lib/pgrest.js');

const SCHEMA = 'tennis';

module.exports = {
  SCHEMA,
  config: P.config,
  client: P.client,
  inList: P.inList,
  sleep: P.sleep,
  DEFAULT_URL: P.DEFAULT_URL,
  runLedger: (db, job, o) => P.runLedger(db, SCHEMA, job, o),
  writeMeta: (db, entries) => P.writeMeta(db, SCHEMA, entries)
};
