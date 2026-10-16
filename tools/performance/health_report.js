#!/usr/bin/env node
/* ===========================================================================
   LIST WHAT NEEDS A PERSON — the hourly job's last step.

   Reads performance/data/health.json and prints one GitHub annotation per
   item (ERROR and ALERT as errors, WARN as warnings, the rest as notices).
   It ALWAYS exits 0: an alert is a data question (a final not yet posted, two
   sources that disagree, a game the scoreboard names differently), not a
   broken job. A red hourly run would email the owner every hour until a
   source catches up. The run summary (tools/performance/run.js) and
   health.json carry the same list. The run still goes red when the job
   itself breaks: a rule test fails or a ledger chain does not verify.

     node tools/performance/health_report.js [--root <dir>]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

function annotations(h) {
  if (!h || !Array.isArray(h.items)) return ['::warning title=health::performance/data/health.json is missing or unreadable'];
  return h.items.map((i) => {
    const kind = i.level === 'ERROR' || i.level === 'ALERT' ? 'error' : i.level === 'WARN' ? 'warning' : 'notice';
    /* an annotation ends at the first newline */
    return '::' + kind + ' title=' + String(i.check || 'health') + '::' + String(i.detail || '').replace(/\r?\n/g, ' ');
  });
}

function main(argv) {
  const r = argv.indexOf('--root');
  const root = path.resolve(r >= 0 ? argv[r + 1] : path.join(__dirname, '..', '..'));
  let h = null;
  try { h = JSON.parse(fs.readFileSync(path.join(root, 'performance', 'data', 'health.json'), 'utf8')); } catch (_) { /* reported below */ }
  annotations(h).forEach((l) => console.log(l));
  console.log('health: ' + (h && h.status ? h.status : 'unknown') + ' (listed only; this step never fails the run)');
  return 0;
}

module.exports = { annotations };
if (require.main === module) { try { main(process.argv.slice(2)); } catch (e) { console.log('::warning title=health::' + String(e && e.message || e)); } process.exit(0); }
