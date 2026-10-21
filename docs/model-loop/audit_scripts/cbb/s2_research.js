'use strict';
/* The research engine (basketball/ncaam_research, frozen selection) on the
   2026 holdout: per-game calibrated predictions, for a model-vs-model comparison
   with the live points-ratings engine. Writes only to the scratchpad. */
const fs = require('fs');
const path = require('path');
const REPO = '/home/user/EdgeDeskSports';
const OUT = path.join(__dirname, 'out');
const WF = require(REPO + '/basketball/ncaam_research/walkforward.js');
const TM = require(REPO + '/basketball/ncaam_research/team_model.js');
(async () => {
  const frozen = JSON.parse(fs.readFileSync(REPO + '/basketball/ncaam_research/selection_frozen.json', 'utf8'));
  const D = await WF.prepare();
  const W = WF.runCandidate(D, frozen.chosen, 'holdout');
  const rows = WF.scored(W.rows, 'D1_D1').filter((r) => r.season === 2026 && r.cal);
  const noRoster = WF.scored(WF.runCandidate(D, Object.assign({}, frozen.chosen, { continuity_slope: 0, transfer_beta: 0 }), 'holdout').rows, 'D1_D1').filter((r) => r.season === 2026 && r.cal);
  const nr = new Map(noRoster.map((r) => [r.game_id, r.cal.margin_mu]));
  const out = rows.map((r) => ({ id: String(r.game_id), start_ms: r.start_ms, home: String(r.home), away: String(r.away), neutral: r.neutral, event: r.event,
    tempo: r.tempo, ppp_h: r.ppp_h, ppp_a: r.ppp_a, raw_margin: r.margin, raw_total: r.total, n_h: r.n_h, n_a: r.n_a, cont_h: r.cont_h, cont_a: r.cont_a,
    margin_mu: r.cal.margin_mu, margin_sd: r.cal.margin_sd, p_home: r.cal.p_home, total_mu: r.cal.total_mu, margin_mu_no_roster: nr.get(r.game_id), y: r.y }));
  fs.writeFileSync(path.join(OUT, 'research_rows.json'), JSON.stringify(out));
  console.log('research rows 2026 D1-v-D1:', out.length);
})().catch((e) => { console.error(e); process.exit(1); });
