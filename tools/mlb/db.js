#!/usr/bin/env node
/* The MLB historical pipeline's database door: the shared PostgREST client
   bound to the mlbhist schema, so every job here says db.select('mlbhist', …)
   through the same transport the rest of the estate uses. See tools/lib/pgrest.js. */
'use strict';
const P = require('../lib/pgrest.js');

const SCHEMA = 'mlbhist';
const CONTRACT = 'mlb_pitcher_history.sql';

/* A failure an operator can act on, or null. Until the contract is installed
   every job here fails on its first write, and a raw schema-cache error names
   the symptom rather than the fix. Printed as a GitHub error annotation so it
   lands on the run summary instead of halfway down a log. */
function explain(err) { return P.contractHint(err, CONTRACT); }
function reportFailure(tag, err) {
  const hint = explain(err);
  if (hint) console.error('::error::' + tag + ': ' + hint);
  return !!hint;
}

module.exports = { SCHEMA, CONTRACT, explain, reportFailure, P };
