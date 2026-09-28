#!/usr/bin/env node
/* ============================================================================
   EdgeDesk EV — the PROSPECTIVE NEXT-100 FREEZE (docs/edgedesk-ev/DESIGN.md §65).

   Freezes the first shadow EV version: the engine, the calibrator artifact and
   the policy, by name AND by hash. The terminal build then counts the first
   100 eligible EV reads after the freeze (football/cfb_terminal/build.js
   next100Progress) and grades them; nobody retunes on them while calling them
   a holdout.

     node football/cfb_ev/freeze.js --status     # show the freeze and whether the code still matches it
     node football/cfb_ev/freeze.js --init       # write next100_freeze.json once (refuses if it exists)
     node football/cfb_ev/freeze.js --patch "reason"   # record a code change after the freeze (append-only)

   A change to a frozen file after the freeze must either bump its version or
   be recorded as a PATCH in versions.jsonl, which names the new hash and
   states that no historical read was altered (the tests enforce it).
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..', '..');
const FREEZE = path.join(__dirname, 'next100_freeze.json');
const VERS = path.join(__dirname, 'versions.jsonl');
const FILES = ['lib/edgedesk_ev.js', 'football/cfb_ev/artifacts/cfb_ev_calibration_v1/calibration.json', 'football/cfb_ev/policy/cfb_ev_policy_v1.json'];
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex');

function hashes() { const o = {}; FILES.forEach((f) => { o[f] = sha(f); }); return o; }
function versions() { return fs.existsSync(VERS) ? fs.readFileSync(VERS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; }
/* every frozen file is either unchanged or its current hash is named by a PATCH row */
function drift() {
  if (!fs.existsSync(FREEZE)) return { frozen: false, ok: true, drift: [] };
  const F = JSON.parse(fs.readFileSync(FREEZE, 'utf8')), now = hashes(), V = versions(), out = [];
  Object.keys(F.hashes).forEach((f) => {
    if (now[f] === F.hashes[f]) return;
    const patched = V.some((v) => v.event === 'PATCH' && v.files && v.files[f] === now[f]);
    out.push({ file: f, frozen: F.hashes[f].slice(0, 12), now: now[f].slice(0, 12), recorded_as_patch: patched });
  });
  return { frozen: true, ok: out.every((d) => d.recorded_as_patch), drift: out };
}
function main() {
  const a = process.argv.slice(2);
  if (a[0] === '--init') {
    if (fs.existsSync(FREEZE)) { console.error('next100_freeze.json exists: the freeze is written once'); process.exit(3); }
    const EV = require(path.join(ROOT, 'lib', 'edgedesk_ev.js'));
    const F = {
      schema: 'edgedesk_ev_next100_freeze_v1', plan_id: 'edgedesk_ev_next100_v1', frozen_at: new Date().toISOString(),
      versions: { engine: EV.VERSION, calibrator: 'cfb_ev_calibration_v1', policy: 'cfb_ev_policy_v1', model: 'edgedesk_cfb_p4_v1.0.0' },
      hashes: hashes(),
      population: { n: 100, definition: 'the first 100 distinct (game, selection) EV reads frozen after frozen_at under exactly these versions, with a fresh executable quote and a calibrated probability — every decision status included, so PASS is graded as a counterfactual' },
      metrics: [
        { id: 'probability_calibration', what: 'Brier, log loss, calibration slope and CITL of the calibrated cover probability vs the settled cover (pushes excluded)' },
        { id: 'ev_monotonicity', what: 'CLV and realized ROI by stated calibrated-EV bucket, with n and intervals' },
        { id: 'clv', what: 'line CLV and price CLV at the recorded quote' },
        { id: 'quote_freshness_failures', what: 'reads blocked as STALE QUOTE or PRICE UNAVAILABLE' },
        { id: 'robust_ev', what: 'Pr(EV>0) and the 10th-percentile EV against the realized outcome frequency' },
        { id: 'timing', what: 'BET EARLY later deterioration, WAIT target reached / best later price / close' },
        { id: 'alternates', what: 'each recorded alternate graded at its own price' }
      ],
      rule: 'Nothing is retuned on these 100 reads while they are called a holdout. A change to a frozen file needs a version bump, or a PATCH row in football/cfb_ev/versions.jsonl naming the new hash; either way, no frozen read is ever rewritten.'
    };
    fs.writeFileSync(FREEZE, JSON.stringify(F, null, 1) + '\n');
    fs.appendFileSync(VERS, JSON.stringify({ event: 'FREEZE', plan_id: F.plan_id, at: F.frozen_at, versions: F.versions, files: F.hashes }) + '\n');
    console.log('frozen ' + F.plan_id + ' at ' + F.frozen_at);
    return;
  }
  if (a[0] === '--patch') {
    const reason = a[1];
    if (!reason) { console.error('--patch "reason"'); process.exit(2); }
    const d = drift();
    if (!d.drift.length) { console.log('no drift: nothing to record'); return; }
    fs.appendFileSync(VERS, JSON.stringify({ event: 'PATCH', at: new Date().toISOString(), reason: reason, files: hashes(), changed: d.drift.map((x) => x.file), historical_reads_altered: false }) + '\n');
    console.log('PATCH recorded for ' + d.drift.map((x) => x.file).join(', '));
    return;
  }
  console.log(JSON.stringify(Object.assign({ freeze: fs.existsSync(FREEZE) ? JSON.parse(fs.readFileSync(FREEZE, 'utf8')).plan_id : null }, drift()), null, 1));
}
if (require.main === module) main();
module.exports = { drift, hashes, FILES };
