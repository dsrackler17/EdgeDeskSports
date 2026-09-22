#!/usr/bin/env node
'use strict';

global.window = global.window || global;
require('./params.js');
const E = require('./engine.js');

let pass=0, fail=0;
function chk(name, ok, detail){
  if(typeof ok==='function'){try{ok=!!ok();}catch(e){detail=String(e&&e.stack||e);ok=false;}}
  if(ok){pass++;return;}
  fail++;console.error('FAIL | '+name+(detail==null?'':' | '+JSON.stringify(detail).slice(0,500)));
}
function near(a,b){return typeof a==='number'&&Math.abs(a-b)<1e-9;}
function state(){
  const st=E.newState();
  E.ingest.seasonBreak(st);
  E.ingest.absorbGame(st,{home:'Texas Tech',away:'LSU',home_fbs:true,away_fbs:true,
    neutral_site:true,home_points:31,away_points:24});
  return st;
}

const data={
  schema:'edgedesk_rating_v1',
  source_schema:'edgedesk_national_rankings_v1',
  season:2026,
  generated_at:'2026-09-22T00:00:00Z',
  calibration:{measured:false},
  teams:[
    {team:'Texas Tech',canonical_key:'texastech',rating:9,confidence:0.82,
      components:{availability:{points:-1.25}}},
    {team:'LSU',canonical_key:'lsu',rating:-2,confidence:0.74,
      components:{availability:{points:0}}}
  ]
};

const shadow=state();
const legacy=E.strength.rating(shadow,'texastech',true);
E.ingest.setCanonicalRatings(shadow,data,{strip_availability:true});
chk('unmeasured canonical map is retained for research',
  shadow.canonicalRatingCount===2
    && shadow.canonicalResearchRatings
    && near(shadow.canonicalResearchRatings.texastech.value,10.25),
  shadow.canonicalRatingMeta);
chk('unmeasured ETSR cannot replace the production rating',
  shadow.canonicalRatingActiveCount===0
    && shadow.canonicalRatingMeta.promoted_to_pricing===false
    && near(E.strength.rating(shadow,'texastech',true),legacy),
  {legacy,now:E.strength.rating(shadow,'texastech',true),meta:shadow.canonicalRatingMeta});

const promotedData=JSON.parse(JSON.stringify(data));
promotedData.calibration.measured=true;
const st=state();
E.ingest.setCanonicalRatings(st,promotedData,{strip_availability:true});
chk('measured canonical map activates both teams',
  st.canonicalRatingCount===2&&st.canonicalRatingActiveCount===2,
  st.canonicalRatingMeta);
chk('availability is removed before matchup injury pricing',
  near(E.strength.rating(st,'texastech',true),10.25),
  E.strength.rating(st,'texastech',true));
chk('a team with no current availability penalty is unchanged',
  near(E.strength.rating(st,'lsu',true),-2),E.strength.rating(st,'lsu',true));

const b=E.strength.blendedRating(st,'texastech',true,4);
chk('measured canonical rating bypasses the legacy prior/fresh blend',
  b.canonical===true&&near(b.value,10.25)&&b.prior_weight===0,b);
const p=E.strength.profile(st,'texastech',true);
chk('the interpretable Layer-1 profile publishes the measured canonical number',
  p.rating&&p.rating.available&&near(p.rating.value,10.25)
    &&/canonical/.test(String(p.rating.source)),p.rating);
chk('canonical confidence is carried into the Layer-1 measurement',
  near(p.rating.confidence,0.82),p.rating&&p.rating.confidence);

const st2=state();
E.ingest.setCanonicalRatings(st2,promotedData,{strip_availability:false});
chk('availability stripping is explicit and reversible after promotion',
  near(E.strength.rating(st2,'texastech',true),9),E.strength.rating(st2,'texastech',true));

console.log((fail?'FAILED ':'ALL GREEN ')+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
