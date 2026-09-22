#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const M = require('./_module.js');
const V = require(path.join(M.ROOT, 'football', 'nfl', 'coaching_staff_validation.js'));
const L = require(path.join(M.ROOT, 'football', 'nfl', 'coaching_staff_ledger.js'));
const W = require('./write_if_changed.js');

const LEDGER = path.join(M.ROOT, 'football', 'nfl', 'coaching_staff_ledger.json');
const OUT = path.join(M.ROOT, 'football', 'nfl', 'coaching_staff_validation.json');

function latestSettledAt(ledger) {
  let latest = null;
  Object.keys((ledger && ledger.settled) || {}).forEach((id) => {
    const rec = ledger.settled[id];
    const t = Date.parse(rec && rec.settled_at || '');
    if (!Number.isFinite(t)) return;
    if (latest == null || t > latest) latest = t;
  });
  return latest == null ? null : new Date(latest).toISOString();
}

function buildReport(ledger) {
  if (!ledger || ledger.schema !== L.SCHEMA || !ledger.settled) {
    throw new Error('NFL coaching ledger is invalid; validation report refused');
  }
  return V.analyze(ledger, { now: latestSettledAt(ledger) });
}

function main() {
  if (!fs.existsSync(LEDGER)) {
    console.log('NFL coaching validation: ledger not present yet; nothing to report');
    return;
  }
  let ledger;
  try {
    ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
  } catch (e) {
    console.error('NFL coaching validation: ledger unreadable: ' + (e && e.message || e));
    process.exit(2);
  }

  let report;
  try {
    report = buildReport(ledger);
  } catch (e) {
    console.error('NFL coaching validation: ' + (e && e.message || e));
    process.exit(2);
  }

  const state = W.writeIfChanged(OUT, report, { pretty: true, newline: true });
  console.log(
    'NFL coaching validation: ' + state +
    ' — ' + report.games_scored + ' frozen games / ' +
    report.seasons_scored.length + ' seasons / ' +
    'status ' + report.status + ' / selected cap none'
  );
}

module.exports = { LEDGER, OUT, latestSettledAt, buildReport };
if (require.main === module) main();
