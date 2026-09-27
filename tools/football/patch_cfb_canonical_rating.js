#!/usr/bin/env node
'use strict';

/* ============================================================================
   KEEP THE LEGACY BROWSER ON THE SAME ETSR PROMOTION CONTRACT AS NODE.

   football/rating/current.json is the canonical research power rating. Its
   point scale may replace the production Layer-1 mean ONLY when that artifact
   says calibration.measured=true. Until then the trained/replayed CFB engine
   remains the production team-strength source and ETSR is display/audit/shadow
   context.

   This patch upgrades both the original browser and the briefly shipped
   premature "ETSR is the pricing backbone" version.
   ========================================================================== */

const fs=require('fs');
const path=require('path');
const ROOT=path.join(__dirname,'..','..');
const FILE=path.join(ROOT,'app.html');
let s=fs.readFileSync(FILE,'utf8');

const NEW_MARK="mode==='PRICED_CANONICAL'";
if(s.includes('function fbP4ApplyCanonicalRating(){')
  && s.includes(NEW_MARK)
  && s.includes('fbP4ApplyCanonicalRating();done();return v;')){
  console.log('[cfb-browser-canonical-rating] already patched');
  process.exit(0);
}

function replaceOne(oldText,newText,label){
  const n=s.split(oldText).length-1;
  if(n!==1)throw new Error(label+': expected exactly one old anchor, found '+n);
  s=s.replace(oldText,newText);
}
function replaceIf(oldText,newText){
  if(s.includes(oldText))s=s.replace(oldText,newText);
}

replaceIf(
`   EDR IS RESEARCH CONTEXT. No bet is priced from it: the Power 4 engine's own
   rating state still produces every line on this board. */`,
`   EDR IS THE CANONICAL RESEARCH POWER RATING. It is loaded beside the
   production engine and shown on the same neutral-field scale, but it replaces
   the production Layer-1 mean only after its own point-scale calibration is
   measured. Until then the enriched trained/replayed engine prices the game. */`);

replaceIf(
`   EDR IS NOW THE TEAM-STRENGTH BACKBONE. The trained engine still owns
   scoring, matchup, venue and uncertainty machinery, but its neutral-field
   Layer-1 team mean is replaced after replay by this current national ETSR.
   Current availability is stripped from ETSR before the game-specific injury
   layer is applied, so one absence cannot be charged twice. */`,
`   EDR IS THE CANONICAL RESEARCH POWER RATING. It is loaded beside the
   production engine and shown on the same neutral-field scale, but it replaces
   the production Layer-1 mean only after its own point-scale calibration is
   measured. Until then the enriched trained/replayed engine prices the game. */`);

const helper=`function fbP4ApplyCanonicalRating(){
  var S=FB.p4,D=FB.edr&&FB.edr.data,E=window.EDCfbP4;
  if(!S||!S.state)return 0;
  if(!D||!D.teams||!E||!E.ingest||typeof E.ingest.setCanonicalRatings!=='function'){
    S.notes.push('Canonical FBS research power rating did not load. Production pricing remains on the trained/replayed CFB engine; no fallback rating is invented.');
    return 0;
  }
  if(D.season!=null&&S.season!=null&&+D.season!==+S.season){
    S.notes.push('Canonical FBS research power rating is for season '+D.season+', not '+S.season
      +'. It is excluded from this board; production pricing remains on the current-season replay.');
    return 0;
  }
  E.ingest.setCanonicalRatings(S.state,D,{
    strip_availability:true,
    source:'EdgeDesk national ETSR · neutral-field research power rating'
  });
  var n=S.state.canonicalRatingCount||0;
  var active=S.state.canonicalRatingActiveCount||0;
  var expected=S.uni&&S.uni.counts?S.uni.counts.fbs_teams:null;
  S.canonicalRatingCount=n;
  S.canonicalRatingSource=D.source_schema||D.schema||null;
  S.canonicalRatingMode=active>0?'PRICED_CANONICAL':'SHADOW_RESEARCH';
  if(!n||(expected!=null&&n!==expected)){
    S.notes.push('Canonical FBS research rating covers '+n+' team'+(n===1?'':'s')
      +(expected!=null?(' of '+expected+' active FBS programs'):'')
      +'. The incomplete research map is not substituted for the production replay.');
    return n;
  }
  var mode=S.canonicalRatingMode;
  if(mode==='PRICED_CANONICAL'){
    S.notes.push('Measured ETSR promotion is active: '+active+' FBS ratings supply the neutral-field Layer-1 mean. '
      +'Current availability is stripped from that baseline and applied separately for this matchup.');
  }else{
    S.notes.push('Power-rating context: '+n+' current FBS ETSR ratings are loaded in SHADOW_RESEARCH mode. '
      +'Their point-scale calibration is not yet measured, so production pricing remains on the trained/replayed '
      +'engine with current score and efficiency absorption.');
  }
  return n;
}`;

const hs=s.indexOf('function fbP4ApplyCanonicalRating(){');
if(hs>=0){
  const he=s.indexOf('/* ═══ THE MODEL\'S MEASURED RECORD, PER CONFERENCE',hs);
  if(he<0)throw new Error('canonical helper end anchor missing');
  s=s.slice(0,hs)+helper+s.slice(he);
}else{
  replaceOne(
`  return best;
}
/* ═══ THE MODEL'S MEASURED RECORD, PER CONFERENCE ══════════════════════════`,
`  return best;
}

${helper}
/* ═══ THE MODEL'S MEASURED RECORD, PER CONFERENCE ══════════════════════════`,
'canonical helper insertion');
}

replaceIf(
`          if(!n&&yy===cur)S.notes.push('No completed '+yy+' games reached the legacy replay yet. That replay still '
            +'supplies scoring and uncertainty context, while the neutral-field team-strength mean comes from the '
            +'current national ETSR artifact once the board load completes.');`,
`          if(!n&&yy===cur)S.notes.push('No completed '+yy+' games reached the production replay yet. '
            +'The engine therefore remains on its trained prior and learned offseason carry-over; ETSR is separate '
            +'research context until its point-scale calibration is measured.');`);

replaceIf(
`  /* The rating rides along with the load rather than racing the render.
     It is now a REQUIRED pricing input. A missing or wrong-season artifact
     gates projections instead of quietly reviving the legacy score-only mean. */
  var edr=Promise.resolve(null);`,
`  /* The canonical research rating rides along with the load rather than
     racing the render. It is not a required pricing input until its own
     calibration contract promotes it. */
  var edr=Promise.resolve(null);`);

if(s.includes(
`  return Promise.all([fbP4Load(force,signal),edr]).then(done,function(e){done();throw e;});`)){
  s=s.replace(
`  return Promise.all([fbP4Load(force,signal),edr]).then(done,function(e){done();throw e;});`,
`  return Promise.all([fbP4Load(force,signal),edr]).then(function(v){
    fbP4ApplyCanonicalRating();done();return v;
  },function(e){done();throw e;});`);
}

fs.writeFileSync(FILE,s);
console.log('[cfb-browser-canonical-rating] patched app.html');
