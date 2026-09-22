#!/usr/bin/env node
'use strict';

/* ============================================================================
   KEEP THE LEGACY BROWSER ON THE CANONICAL CFB TEAM-STRENGTH BACKBONE.

   The Node coverage build and the browser both replay the trained engine for
   scoring/game-count/uncertainty context. Team-strength mean is different:
   after replay, football/rating/current.json supplies the richer national ETSR
   neutral-field backbone. Current availability is stripped from that number
   because the matchup layer prices the actual missing athlete separately.

   Idempotent by design. If app.html moves, fail on the anchor rather than
   quietly shipping two different CFB models.
   ========================================================================== */

const fs=require('fs');
const path=require('path');
const ROOT=path.join(__dirname,'..','..');
const FILE=path.join(ROOT,'app.html');
let s=fs.readFileSync(FILE,'utf8');

const MARK='function fbP4ApplyCanonicalRating(){';
if(s.includes(MARK)
  && s.includes('fbP4ApplyCanonicalRating();done();return v;')
  && s.includes('Canonical FBS power rating did not load')){
  console.log('[cfb-browser-canonical-rating] already patched');
  process.exit(0);
}

function replaceOne(oldText,newText,label){
  const n=s.split(oldText).length-1;
  if(n!==1)throw new Error(label+': expected exactly one old anchor, found '+n);
  s=s.replace(oldText,newText);
}

replaceOne(
`   EDR IS RESEARCH CONTEXT. No bet is priced from it: the Power 4 engine's own
   rating state still produces every line on this board. */`,
`   EDR IS NOW THE TEAM-STRENGTH BACKBONE. The trained engine still owns
   scoring, matchup, venue and uncertainty machinery, but its neutral-field
   Layer-1 team mean is replaced after replay by this current national ETSR.
   Current availability is stripped from ETSR before the game-specific injury
   layer is applied, so one absence cannot be charged twice. */`,
'EDR role comment');

replaceOne(
`  return best;
}
/* ═══ THE MODEL'S MEASURED RECORD, PER CONFERENCE ══════════════════════════`,
`  return best;
}

/* Install the same canonical team-strength mean the weekly coverage build uses.
   Replay remains intact for scoring, game counts and uncertainty; only the
   neutral-field rating mean is replaced. Fail closed if the artifact is absent
   or from another season instead of publishing the legacy score-only fallback. */
function fbP4ApplyCanonicalRating(){
  var S=FB.p4,D=FB.edr&&FB.edr.data,E=window.EDCfbP4;
  if(!S||!S.state)return 0;
  if(!D||!D.teams||!E||!E.ingest||typeof E.ingest.setCanonicalRatings!=='function'){
    if(!S.gate)S.gate='Canonical FBS power rating did not load. EdgeDesk will not publish a fallback line from the legacy score-only replay.';
    return 0;
  }
  if(D.season!=null&&S.season!=null&&+D.season!==+S.season){
    S.gate='Canonical FBS power rating is for season '+D.season+', but this board is '+S.season+'. No projection is published across mismatched seasons.';
    return 0;
  }
  E.ingest.setCanonicalRatings(S.state,D,{
    strip_availability:true,
    source:'EdgeDesk national ETSR · neutral-field pricing backbone'
  });
  var n=S.state.canonicalRatingCount||0;
  var expected=S.uni&&S.uni.counts?S.uni.counts.fbs_teams:null;
  S.canonicalRatingCount=n;
  S.canonicalRatingSource=D.source_schema||D.schema||null;
  if(!n||(expected!=null&&n!==expected)){
    S.gate='Canonical FBS power rating covers '+n+' team'+(n===1?'':'s')
      +(expected!=null?(' but this season has '+expected+' active FBS programs'):'')
      +'. EdgeDesk will not fill the gap with the legacy replay.';
    return 0;
  }
  S.notes.push('Pricing backbone: '+n+' current FBS ETSR ratings on one neutral-field points scale. '
    +'Current availability is removed from that baseline and applied separately by athlete for this matchup.');
  return n;
}
/* ═══ THE MODEL'S MEASURED RECORD, PER CONFERENCE ══════════════════════════`,
'canonical browser helper');

replaceOne(
`          if(!n&&yy===cur)S.notes.push('No completed '+yy+' games in the feed yet — ratings are the trained '
            +P.trained_through_season+' seeds with the learned season carry-over applied, and the preseason '
            +'prior therefore carries most of the weight. The model says so in every card.');`,
`          if(!n&&yy===cur)S.notes.push('No completed '+yy+' games reached the legacy replay yet. That replay still '
            +'supplies scoring and uncertainty context, while the neutral-field team-strength mean comes from the '
            +'current national ETSR artifact once the board load completes.');`,
'no-completed-games note');

replaceOne(
`  /* The rating rides along with the load rather than racing the render.
     It can never fail the board: fbEdrLoad resolves to null on any error and
     the board says the rating could not be read instead of showing nothing. */
  var edr=Promise.resolve(null);`,
`  /* The rating rides along with the load rather than racing the render.
     It is now a REQUIRED pricing input. A missing or wrong-season artifact
     gates projections instead of quietly reviving the legacy score-only mean. */
  var edr=Promise.resolve(null);`,
'load-guard comment');

replaceOne(
`  return Promise.all([fbP4Load(force,signal),edr]).then(done,function(e){done();throw e;});`,
`  return Promise.all([fbP4Load(force,signal),edr]).then(function(v){
    fbP4ApplyCanonicalRating();done();return v;
  },function(e){done();throw e;});`,
'load-guard canonical apply');

fs.writeFileSync(FILE,s);
console.log('[cfb-browser-canonical-rating] patched app.html');
