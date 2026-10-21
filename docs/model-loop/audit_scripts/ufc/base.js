const { run } = require('/home/user/EdgeDeskSports/engine/lab/ufc_elo.js');
const { scored } = run(32);
const ll = (p, y) => -(y ? Math.log(p) : Math.log(1 - p));
const p0 = 252 / 562;
const n = scored.length;
console.log('p0', p0.toFixed(4), 'LL const p0 on scored', (scored.reduce((s, x) => s + ll(p0, x.y), 0) / n).toFixed(5));
// prior-only (expanding) base rate: use base rate of all earlier decisive bouts, which is point-in-time
const { readCsv } = require('/home/user/EdgeDeskSports/engine/csv');
const rows = readCsv('/home/user/EdgeDeskSports/datapack/quant_v1/data/ufc/bouts_2024.csv').rows.sort((a,b)=>a.start_time<b.start_time?-1:a.start_time>b.start_time?1:a.bout_id<b.bout_id?-1:1);
let w=1,t=2; const pit = new Map();
for (const b of rows){ const aw=b.a_winner==='True', bw=b.b_winner==='True'; if(aw===bw) continue; pit.set(b.start_time+'|'+b.fighter_a_id, w/t); w+=aw?1:0; t+=1; }
// match scored by date only approximate: recompute in run order
let w2=1,t2=2, sumLL=0, k=0; const seen=new Map();
for (const b of rows){ const aw=b.a_winner==='True', bw=b.b_winner==='True'; if(aw===bw) continue; const p=w2/t2; if(seen.get(b.fighter_a_id)&&seen.get(b.fighter_b_id)){ sumLL+=ll(p,aw?1:0); k++; } w2+=aw?1:0; t2+=1; seen.set(b.fighter_a_id,true); seen.set(b.fighter_b_id,true);}
console.log('walk-forward base-rate LL on same', k, 'bouts:', (sumLL/k).toFixed(5));
