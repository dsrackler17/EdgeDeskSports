'use strict';
/* ===========================================================================
   EdgeDesk college baseball — the one rule for a value claim on the board.

   The board shows edges only once the model has beaten the closing line out
   of sample, by the CLV protocol's own rule (EXPERIMENTS.md, CBASE-H1: a
   forward holdout on prices captured after the model was frozen, read once).
   Until then it shows probabilities only, labelled with the model's outcome
   status, and makes no value claim.

   ENABLED only when ALL hold:
     - college_baseball/validation/market_clv.json says MARKET_VALIDATED
       (research/clv/cbase.py: G7 PASS on at least 500 bets);
     - for the configuration the board is served with (the validated
       config_sha256 is the served version's in docs/model-loop/
       college_baseball/versions.json): a version released later has no
       market record of its own until its own forward test reads;
     - the release gates allow release (validation/release_gates.json; G12,
       the books' settlement rules, among them);
     - the board is LIVE (a replay never claims value).
   Otherwise DISABLED, with every reason.
   =========================================================================== */
const fs = require('fs');
const path = require('path');

const BASE = path.join(__dirname, '..');
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } };

function gate(o) {
  const clv = o.clv || null; const served = o.served || {}; const gates = o.gates || null;
  const reasons = [];
  const st = clv ? clv.status : 'NOT_TESTED';
  if (st !== 'MARKET_VALIDATED') {
    reasons.push(st === 'NOT_TESTED' ? 'no college baseball price has been captured with a model number yet (CBASE-H1 not started)'
      : st === 'CAPTURING' ? 'the forward test against the closing line is capturing (' + (clv.n_bets || 0) + ' bets of the 500 its one read needs)'
        : 'the forward test against the closing line read ' + st);
  } else if (!served.config_sha256 || clv.frozen_config_sha256 !== served.config_sha256) {
    reasons.push('the configuration that beat the closing line (' + String(clv.frozen_config_sha256 || '').slice(0, 12) + ') is not the one served (' + String(served.config_sha256 || '').slice(0, 12) + ')');
  }
  if (!gates || gates.release_allowed !== true) reasons.push('release gates not passed' + (gates && gates.failing && gates.failing.length ? ' (' + gates.failing.join(', ') + ')' : ''));
  if (o.mode !== 'LIVE') reasons.push('the board is a replay');
  return {
    value_claims: reasons.length ? 'DISABLED' : 'ENABLED',
    value_reason: reasons.length ? reasons.join('; ') : 'beat the closing line out of sample (CBASE-H1, ' + clv.n_bets + ' bets), and the release gates pass',
    market_test: { experiment: 'CBASE-H1', status: st, n_bets: clv ? clv.n_bets || 0 : 0, read_at: clv ? clv.read_at || null : null, frozen_config_sha256: clv ? clv.frozen_config_sha256 || null : null },
  };
}

function load(mode, o) {
  o = o || {};
  const v = readJson(o.versionsFile || path.join(BASE, '..', 'docs', 'model-loop', 'college_baseball', 'versions.json'));
  const cur = v && (v.versions || []).find((x) => x.version === v.current);
  return gate({ mode, clv: readJson(o.clvFile || path.join(BASE, 'validation', 'market_clv.json')), served: cur || {}, gates: readJson(o.gatesFile || path.join(BASE, 'validation', 'release_gates.json')) });
}

module.exports = { gate, load };
