#!/usr/bin/env node
'use strict';

/* ============================================================================
   FEED CURRENT TEAM-GAME EFFICIENCY INTO THE LEGACY CFB BROWSER REPLAY.

   The rankings build publishes football/rankings/engine_efficiency.json from
   the same per-team-game play aggregates that feed ETSR. The normal browser
   replay may finish before that small artifact arrives, so the engine exposes
   absorbEfficiencyGame(): it updates only efficiency EWMAs, never score rating
   or scoring state. This patch loads the artifact and applies it in kickoff
   order before the board renders.

   Missing play data is a confidence/context gap, not a reason to fabricate a
   statistic and not a reason to throw away the canonical ETSR projection.
   ========================================================================== */

const fs=require('fs');
const path=require('path');
const ROOT=path.join(__dirname,'..','..');
const FILE=path.join(ROOT,'app.html');
let s=fs.readFileSync(FILE,'utf8');

const MARK='function fbP4EngineEfficiencyLoad(){';
if(s.includes(MARK)
  && s.includes('fbP4ApplyEngineEfficiency();fbP4ApplyCanonicalRating();')
  && s.includes("football/rankings/engine_efficiency.json")){
  console.log('[cfb-browser-efficiency] already patched');
  process.exit(0);
}

function replaceOne(oldText,newText,label){
  const n=s.split(oldText).length-1;
  if(n!==1)throw new Error(label+': expected exactly one old anchor, found '+n);
  s=s.replace(oldText,newText);
}

replaceOne(
`var FBP4_LOAD_TIMEOUT_MS=30000;
function fbP4LoadGuarded(force,signal){`,
`var FBP4_LOAD_TIMEOUT_MS=30000;

/* Current play-level efficiency is published by the rankings build. It is
   intentionally separate from the canonical power rating: ETSR owns the
   neutral-field team mean; this artifact owns matchup identity, OL pressure,
   pace and the information-quality statement. */
var FBP4_EFF={data:null,error:null,at:0,_p:null};
function fbP4EngineEfficiencyLoad(){
  var R=FBP4_EFF;
  if(R.data&&Date.now()-R.at<15*60000)return Promise.resolve(R.data);
  if(R._p)return R._p;
  R._p=fetch('football/rankings/engine_efficiency.json',{cache:'no-cache'})
    .then(function(r){
      if(r.status===404)return null;
      if(!r.ok)throw new Error('engine efficiency '+r.status);
      return r.json();
    }).then(function(j){
      R.data=j;R.error=null;R.at=Date.now();R._p=null;return j;
    }).catch(function(e){
      R.error=String(e&&e.message||e).slice(0,100);R._p=null;return null;
    });
  return R._p;
}

function fbP4ApplyEngineEfficiency(){
  var S=FB.p4,D=FBP4_EFF.data,E=window.EDCfbP4;
  if(!S||!S.state||!S.sched||!E||!E.ingest
      ||typeof E.ingest.absorbEfficiencyGame!=='function')return 0;
  if(!D||D.schema!=='edgedesk_cfb_engine_efficiency_v1'){
    S.efficiencyReplay={games:0,team_rows:0,missing:null,
      error:FBP4_EFF.error||'current play-level efficiency artifact unavailable'};
    S.notes.push('Current play-level efficiency did not load. ETSR still supplies the neutral-field team rating; '
      +'matchup efficiency remains on the trained seed and is labeled stale rather than invented.');
    return 0;
  }
  if(D.season!=null&&S.season!=null&&+D.season!==+S.season){
    S.efficiencyReplay={games:0,team_rows:0,missing:null,
      error:'artifact season '+D.season+' does not match board season '+S.season};
    S.notes.push('Play-level efficiency is for season '+D.season+', not '+S.season
      +'. It is not applied across seasons.');
    return 0;
  }

  var rows=(S.sched.rows||[]).slice().sort(function(a,b){
    return String(a.start_date).localeCompare(String(b.start_date))
      ||String(a.game_id).localeCompare(String(b.game_id));
  });
  var games=0,teamRows=0,missing=0;
  rows.forEach(function(r){
    if(!r.completed||r.game_id==null)return;
    var eg=D.games&&D.games[String(r.game_id)];
    if(!eg||!eg.teams){missing++;return;}
    var hk=fbP4Key(r.home_team),ak=fbP4Key(r.away_team);
    var h=hk&&eg.teams[hk]||null,a=ak&&eg.teams[ak]||null;
    if(!h&&!a){missing++;return;}
    E.ingest.absorbEfficiencyGame(S.state,{
      home:r.home_team,away:r.away_team,
      team_stats:{home:h,away:a}
    });
    games++;if(h)teamRows++;if(a)teamRows++;
  });
  S.efficiencyReplay={
    games:games,team_rows:teamRows,missing:missing,error:null,
    artifact_games:D.games_with_stats||0,
    artifact_team_rows:D.team_game_rows||0,
    measured_features:D.measured_features||[],
    unavailable_features:D.unavailable_features||[]
  };
  S.notes.push('Play-level matchup replay: '+games+' completed game'+(games===1?'':'s')
    +' supplied current efficiency ('+teamRows+' team rows)'
    +(missing?('; '+missing+' completed game'+(missing===1?'':'s')+' still wait on the public play feed'):'')
    +'. Missing EPA-only fields remain unavailable; they are never filled with zero.');
  return games;
}

function fbP4LoadGuarded(force,signal){`,
'insert efficiency loader');

replaceOne(
`  var edr=Promise.resolve(null);
  try{ edr=fbEdrLoad(); }catch(_){}
  return Promise.all([fbP4Load(force,signal),edr]).then(function(v){
    fbP4ApplyCanonicalRating();done();return v;
  },function(e){done();throw e;});`,
`  var edr=Promise.resolve(null),eff=Promise.resolve(null);
  try{ edr=fbEdrLoad(); }catch(_){}
  try{ eff=fbP4EngineEfficiencyLoad(); }catch(_){}
  return Promise.all([fbP4Load(force,signal),edr,eff]).then(function(v){
    fbP4ApplyEngineEfficiency();fbP4ApplyCanonicalRating();done();return v;
  },function(e){done();throw e;});`,
'load guard efficiency join');

fs.writeFileSync(FILE,s);
console.log('[cfb-browser-efficiency] patched app.html');
