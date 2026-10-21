const fs=require('fs');const ROOT=require('path').resolve(__dirname,'../../../..');
global.EDFootballParams=require(ROOT+'/football/params.js');const E=require(ROOT+'/football/engine.js');
const s=JSON.parse(fs.readFileSync(ROOT+'/football/nfl/slate.json','utf8'));
const am2p=a=>a<0?(-a)/(-a+100):100/(a+100);
let rows=[];
for(const g of s.games){ if(g.model_status!=='PREDICTED')continue;
  const fair=g.model_home_margin; const sum=g.contributions.spread.reduce((a,t)=>a+t.points,0);
  const q=g.outcome_range; const below=fair-q.p10, above=q.p90-fair;
  const pmf=E.dist.coverProbSpread('nfl',fair,0); const pPmf=pmf.win+0.5*pmf.push;
  const pML=am2p(g.model_fair_home_ml);
  rows.push({id:g.game_id,fair:+fair.toFixed(2),card_sum:+sum.toFixed(2),unattributed:+(fair-sum).toFixed(2),p10:q.p10,p50:q.p50,p90:q.p90,below:+below.toFixed(1),above:+above.toFixed(1),asym:+(above-below).toFixed(1),
    mid80:+((q.p10+q.p90)/2-fair).toFixed(2),p_normal:g.model_home_win_prob,p_pmf:+pPmf.toFixed(4),p_from_ml:+pML.toFixed(4),ref:g.reference_market&&g.reference_market.home_line});
}
console.table(rows);
const mx=k=>Math.max(...rows.map(r=>Math.abs(r[k])));
console.log('max |unattributed|',mx('unattributed'),'max |mid80 - fair|',mx('mid80'),'max |p_normal - p_pmf|',Math.max(...rows.map(r=>Math.abs(r.p_normal-r.p_pmf))).toFixed(4),'max |p_normal-p_ml|',Math.max(...rows.map(r=>Math.abs(r.p_normal-r.p_from_ml))).toFixed(4));
const gaps=rows.filter(r=>r.ref!=null).map(r=>Math.abs(-r.fair-r.ref));console.log('current slate mean |model-ref| ',(gaps.reduce((a,b)=>a+b,0)/gaps.length).toFixed(2),' n>=3:',gaps.filter(x=>x>=3).length,'/',gaps.length);
