'use strict';
const REPO = '/home/user/EdgeDeskSports';
const fs = require('fs');
const WF = require(REPO + '/basketball/ncaam_research/walkforward.js');
(async () => {
  const frozen = JSON.parse(fs.readFileSync(REPO + '/basketball/ncaam_research/selection_frozen.json', 'utf8'));
  const D = await WF.prepare();
  const W = WF.runCandidate(D, frozen.chosen, 'holdout');
  for (const s of [2024, 2025, 2026]) { const st = W.states[s].state; console.log(s, 'eta (pts/100 poss, per side) %s  mu %s tau %s -> HCA pts approx 2*eta*tau/100 = %s', st.eta.toFixed(3), st.mu.toFixed(2), st.tau.toFixed(2), (2 * st.eta * st.tau / 100).toFixed(2)); }
})();
