#!/usr/bin/env node
'use strict';

/* Keep the legacy browser's schedule-stress opponent strength on the same
   canonical ETSR scale as football/matchup/inputs.js. */
const fs=require('fs');
const path=require('path');
const FILE=path.join(__dirname,'..','..','app.html');
let s=fs.readFileSync(FILE,'utf8');

const MARK='function fbP4ScheduleOpponentRating(k){';
if(s.includes(MARK)){
  console.log('[cfb-browser-schedule-rating] already patched');
  process.exit(0);
}
function replaceOne(a,b,label){
  const n=s.split(a).length-1;
  if(n!==1)throw new Error(label+': expected one anchor, found '+n);
  s=s.replace(a,b);
}

replaceOne(
`  var r=(S.state&&S.state.r)||{};
  var prev=i>0?list[i-1]:null,next=(i+1<list.length)?list[i+1]:null;`,
`  function fbP4ScheduleOpponentRating(k){
    var st=S.state||{},cr=st.canonicalRatings||{},lr=st.r||{};
    if(cr[k]&&cr[k].value!=null&&isFinite(cr[k].value))return +cr[k].value;
    return lr[k]!=null&&isFinite(lr[k])?+lr[k]:null;
  }
  var prev=i>0?list[i-1]:null,next=(i+1<list.length)?list[i+1]:null;`,
'schedule rating source');

replaceOne(
`    prev_opp_rating:(prev&&r[prev.oppKey]!=null)?r[prev.oppKey]:null,
    next_opp_rating:(next&&r[next.oppKey]!=null)?r[next.oppKey]:null`,
`    prev_opp_rating:prev?fbP4ScheduleOpponentRating(prev.oppKey):null,
    next_opp_rating:next?fbP4ScheduleOpponentRating(next.oppKey):null`,
'schedule opponent rating reads');

fs.writeFileSync(FILE,s);
console.log('[cfb-browser-schedule-rating] patched app.html');
