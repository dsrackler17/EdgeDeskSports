'use strict';
/* ===========================================================================
   EdgeDesk college baseball — run the adversarial auditor; promote or refuse.

     node college_baseball/audit.js              run every check, write validation/audit.json
     node college_baseball/audit.js --promote    and, only if no CRITICAL check failed,
                                                 record this model version as production
     node college_baseball/audit.js --check      fail (exit 1) if any critical check fails

   PRODUCTION IS THE LAST VALIDATED VERSION. params/production.json changes
   only through --promote with a clean critical audit; a failed audit leaves
   the previous production record untouched and appends the refusal, with
   every failing check, to research/audit_log.jsonl (append-only).
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('./config');
const A = require('./lib/audit');
const REG = require('./lib/registry');
const K = require('./ingest/common');

const LOG = path.join(C.PATHS.research, 'audit_log.jsonl');

function hashFiles(files) { const h = crypto.createHash('sha256'); for (const f of files) if (fs.existsSync(f)) h.update(fs.readFileSync(f)); return h.digest('hex'); }

function main() {
  const res = A.run();
  const now = new Date().toISOString();
  res.generated_at = now;
  K.writeJson(C.PATHS.audit, res);
  for (const c of res.checks) console.log(`${c.status.padEnd(4)} ${c.critical ? '[critical] ' : ''}${c.id}`);
  console.log(res.summary);
  const evidence = [C.PATHS.walkforward, C.PATHS.pitcherEval, C.PATHS.distEval, C.PATHS.simEval, path.join(C.PATHS.params, 'team_tuning.json'), path.join(C.PATHS.params, 'constants.json')];
  const fingerprint = hashFiles(evidence);
  if (process.argv.includes('--promote')) {
    const prev = fs.existsSync(C.PATHS.production) ? JSON.parse(fs.readFileSync(C.PATHS.production, 'utf8')) : null;
    const entry = { at: now, model_version: C.MODEL_VERSION, chosen: res.chosen, evidence_sha256: fingerprint, code: REG.gitCommit() };
    if (!res.promotion_allowed) {
      entry.action = 'PROMOTION_REFUSED'; entry.failures = res.checks.filter((c) => c.critical && c.status === 'FAIL').map((c) => ({ id: c.id, threshold: c.threshold, evidence: c.evidence }));
      entry.production_kept = prev ? prev.model_version + ' (' + prev.evidence_sha256.slice(0, 12) + ')' : 'none';
      fs.appendFileSync(LOG, JSON.stringify(entry) + '\n');
      console.log('promotion REFUSED; production kept: ' + entry.production_kept);
      process.exitCode = 2;
    } else {
      entry.action = 'PROMOTED'; entry.previous = prev ? { model_version: prev.model_version, evidence_sha256: prev.evidence_sha256 } : null; entry.warnings = res.checks.filter((c) => c.status === 'WARN').map((c) => c.id);
      fs.appendFileSync(LOG, JSON.stringify(entry) + '\n');
      K.writeJson(C.PATHS.production, Object.assign({ schema: 'edgedesk_cbase_production_v1', note: 'the last model version whose audit had no critical failure; research prices only — release gates decide what may be shown as more than research' }, entry));
      console.log('promoted ' + C.MODEL_VERSION + ' (' + fingerprint.slice(0, 12) + ')');
    }
  }
  require('./release_gates').refreshResearch();
  if (process.argv.includes('--check') && !res.promotion_allowed) process.exit(1);
}

if (require.main === module) main();
