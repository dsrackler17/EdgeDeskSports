#!/usr/bin/env node
/* The tennis pipeline's database door: the shared PostgREST client bound to
   this sport's schema, so every job here says `db.select('tennis', …)` through
   the same transport the rest of the estate uses. See tools/lib/pgrest.js. */
'use strict';
const P = require('../lib/pgrest.js');

const SCHEMA = 'tennis';
const CONTRACT = 'tennis_live_center.sql';

/* A failure an operator can act on, or null. Until the contract is installed
   every tennis job fails on its first read, and a raw schema-cache error names
   the symptom rather than the fix. Printed as a GitHub error annotation so it
   lands on the run summary instead of halfway down a log. */
function explain(err) {
  const hint = P.contractHint(err, CONTRACT);
  if (!hint) return null;
  return hint;
}
function reportFailure(tag, err) {
  const hint = explain(err);
  if (hint) console.error('::error::' + tag + ': ' + hint);
  return !!hint;
}

module.exports = {
  SCHEMA,
  CONTRACT,
  explain,
  reportFailure,
  config: P.config,
  client: P.client,
  inList: P.inList,
  sleep: P.sleep,
  DEFAULT_URL: P.DEFAULT_URL,
  runLedger: (db, job, o) => P.runLedger(db, SCHEMA, job, o),
  writeMeta: (db, entries) => P.writeMeta(db, SCHEMA, entries)
};
