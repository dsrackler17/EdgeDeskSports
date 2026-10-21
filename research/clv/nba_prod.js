#!/usr/bin/env node
'use strict';
/* ===========================================================================
   The production NBA engine (edgedesk_nba_v1, nba/model/walkforward.js)
   replayed for the CLV programme: run() is imported and called with the test
   window open; nothing of nba/ is written (main() would rewrite the committed
   record, summary and holdout log). Per game it writes the chosen projected-
   availability candidate's (G_stack_P) mean final margin and total, its home
   win probability and the inputs W1 needs, plus G_stack_C for reference only
   (confirmed availability is post-game; never used for an opener bet).

     node --max-old-space-size=11000 research/clv/nba_prod.js <out.csv>
   ========================================================================== */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const WF = require(path.join(ROOT, 'nba', 'model', 'walkforward.js'));

(async () => {
  const R = await WF.run({ unseal: true });
  const sel = R.W.selection;
  const pick = (id) => R.scored[id] || [];
  const ll = (xs) => xs.reduce((a, x) => a + x.s.ll, 0) / Math.max(1, xs.length);
  const inSel = (x) => x.r.season >= sel[0] && x.r.season <= sel[1];
  const check = {};
  for (const id of ['G_stack_P', 'G_stack_C', 'B_eff']) check[id] = { selection_n: pick(id).filter(inSel).length, selection_ll: +ll(pick(id).filter(inSel)).toFixed(5) };
  const byId = (id) => new Map(pick(id).map((x) => [String(x.r.id), x]));
  const C = byId('G_stack_C');
  const lines = ['game_id,season,date,home_id,away_id,neutral,model_margin,model_total,p_home,eff_m,adj_proj,gp_h,gp_a,c_margin,margin,total_pts'];
  for (const x of pick('G_stack_P')) {
    const r = x.r, f = r.f, c = C.get(String(r.id));
    lines.push([r.id, r.season, r.date, r.home_id != null ? r.home_id : r.home, r.away_id != null ? r.away_id : r.away, r.neutral ? 1 : 0,
      x.s.em.toFixed(4), x.s.et.toFixed(4), x.s.p.toFixed(5), f.eff_m == null ? '' : f.eff_m, f.adj_proj == null ? '' : f.adj_proj,
      f.gp_h, f.gp_a, c ? c.s.em.toFixed(4) : '', r.y.margin, r.y.total].join(','));
  }
  fs.writeFileSync(process.argv[2], lines.join('\n') + '\n');
  fs.writeFileSync(process.argv[2] + '.check.json', JSON.stringify({ check, seasons: R.seasons, W: R.W, lab: R.lab }, null, 1));
  console.log('nba production replay', JSON.stringify(check));
})().catch((e) => { console.error(e); process.exit(1); });
