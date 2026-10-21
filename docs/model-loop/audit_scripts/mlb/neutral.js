const path='/home/user/EdgeDeskSports/';
require(path+'mlb/params.js'); const E=require(path+'mlb/engine.js'); const P=globalThis.EDBaseballParams;
function side(name){return {name, offense:{runs_per_game:4.45,games:162}, defense:{runs_allowed_per_game:4.45,games:162}, starter:null, bullpen:null};}
const req={season:2026, league:{runs_per_game:4.45}, home:side('H'), away:side('A'), park:{run_factor:100}, weather:null, market:{}};
const p=E.projectGame(req);
console.log(JSON.stringify(p.model,null,0));
console.log('pRuns',p.model.home_win_prob_runs_only,'pHome',p.model.home_win_prob);
// decompose home edge
const M=P.mlb;
const d=E.dist;
function wp(lh,la,xi){const a=d.runPmf(lh,M.run_dispersion,24),b=d.runPmf(la,M.run_dispersion,24);return d.winProb(a,b,xi);}
const L=4.45;
const base=wp(L,L,0.5);
const withMult=wp(L*1.02,L*0.988,0.5);
const withXi=wp(L*1.02,L*0.988,0.52);
console.log('neutral',base,'+run mult',withMult,'+xi .52',withXi,'+bonus',withXi+0.016);
// tie prob
const a=d.runPmf(L*1.02,2,24),b=d.runPmf(L*0.988,2,24); let t=0; for(let i=0;i<a.length;i++) t+=a[i]*b[i]; console.log('P(tie after 9)',t);
// what a fitted-ish home would give: ratio 1.0103 split, xi 0.50
console.log('empirical-ratio(1.0103) xi .5', wp(L*Math.sqrt(1.0103),L/Math.sqrt(1.0103),0.5));
// run line home -1.5 at neutral
const rl=d.runLineProbs(a,b,-1.5); console.log('home -1.5 cover',rl.cover_fair);
// total quantiles and range
const T=d.totalPmf(a,b); console.log('mean',d.mean(T),'q',d.quantiles(T,[0.1,0.5,0.9]));
let lo=d.quantiles(T,[0.1])[0], hi=d.quantiles(T,[0.9])[0]; let below=0,above=0; for(let k=0;k<T.length;k++){ if(k<lo) below+=T[k]; if(k>hi) above+=T[k]; } console.log('P(T<p10)',below,'P(T>p90)',above,'outside',below+above);
console.log('var total',d.variance(T));
