#!/usr/bin/env node
'use strict';

global.window=global.window||global;
require('./params.js');
const E=require('./engine.js');

let pass=0,fail=0;
function chk(name,fn,detail){
  let ok=false,why=detail;
  try{ok=!!fn();}catch(e){why=String(e&&e.stack||e);}
  if(ok){pass++;console.log('PASS | '+name);}
  else{fail++;console.error('FAIL | '+name+(why?' | '+why:''));}
}
function near(a,b){return typeof a==='number'&&Math.abs(a-b)<1e-6;}

const W=global.EDCfbP4Params.injury;
const full=W.position_weight.QB;

const out=E.context.injuryImpact([{
  player:'QB1',athlete_id:'1',position:'QB',starter:true,snap_share:0.93,
  status:'out',replacement_quality:null,source:'test'
}],'home');
chk('primary QB OUT gets the full trained absence effect',
  ()=>out.points.available&&near(out.points.value,-full),JSON.stringify(out));

const q=E.context.injuryImpact([{
  player:'QB1',athlete_id:'1',position:'QB',starter:true,snap_share:0.93,
  status:'questionable',source:'test'
}],'home');
chk('questionable primary QB uses the declared status scaler',
  ()=>near(q.points.value,-full*W.status_weight.questionable),JSON.stringify(q));

const backup=E.context.injuryImpact([{
  player:'QB2',athlete_id:'2',position:'QB',starter:false,snap_share:0.07,
  status:'out',source:'test'
}],'home');
chk('backup QB absence does not borrow the primary-QB coefficient',
  ()=>near(backup.points.value,0)&&backup.uncertainty.value>0,JSON.stringify(backup));

const wr=E.context.injuryImpact([{
  player:'WR1',athlete_id:'3',position:'WR',starter:true,snap_share:0.88,
  status:'out',source:'test'
}],'home');
chk('untrained positions move uncertainty, not the mean',
  ()=>near(wr.points.value,0)&&wr.uncertainty.value>0,JSON.stringify(wr));

const dup=E.context.injuryImpact([
  {player:'QB1',athlete_id:'1',position:'QB',starter:true,status:'out',source:'A'},
  {player:'QB1',athlete_id:'1',position:'QB',starter:true,status:'out',source:'B'}
],'home');
chk('duplicate reports cannot stack the same athlete twice',
  ()=>near(dup.points.value,-full),JSON.stringify(dup));

const capped=E.context.injuryImpact([
  {player:'QB1',athlete_id:'1',position:'QB',starter:true,status:'out'},
  {player:'QBX',athlete_id:'9',position:'QB',starter:true,status:'out'}
],'home');
chk('team injury mean is capped at the largest trained effect',
  ()=>near(capped.points.value,-W.max_position_weight),JSON.stringify(capped));

const recovered=E.context.injuryImpact([{
  player:'QB1',athlete_id:'1',position:'QB',starter:true,status:'active'
}],'home');
chk('an ACTIVE status reverses the injury mean to zero',
  ()=>near(recovered.points.value,0),JSON.stringify(recovered));

console.log((fail?'FAILED ':'ALL GREEN ')+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
