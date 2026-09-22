#!/usr/bin/env node
'use strict';

/* ============================================================================
   ENRICH LIVE CFB INJURY ROWS WITH THE SAME PLAYER IDENTITY/USAGE DATA AS NODE.

   Runs AFTER patch_cfb_fixture_availability.js. It never guesses an athlete:
   only a unique team/name match is accepted. Player ratings remain research
   metadata and never enter replacement_quality, so this does not promote the
   unvalidated player-quality layer into pricing.

   To keep the board fast, only teams with a current priced availability row
   have their compact team player file prefetched.
   ========================================================================== */

const fs=require('fs');
const path=require('path');
const ROOT=path.join(__dirname,'..','..');
const FILE=path.join(ROOT,'app.html');
let s=fs.readFileSync(FILE,'utf8');

const MARK='function fbP4InjuryIdentity(teamName,playerName){';
if(s.includes(MARK)
  && s.includes('return fbP4InjuryPlayerEnsure().catch(function(){});')
  && s.includes('replacement_quality_research:')){
  console.log('[cfb-browser-injury-identity] already patched');
  process.exit(0);
}

function replaceOne(oldText,newText,label){
  const n=s.split(oldText).length-1;
  if(n!==1)throw new Error(label+': expected exactly one old anchor, found '+n);
  s=s.replace(oldText,newText);
}

replaceOne(
`function fbP4OfficialForGame(t,gameId){`,
`function fbP4PersonKey(v){
  if(v==null)return null;
  try{v=String(v).trim().toLowerCase().normalize('NFKD').replace(/[\\u0300-\\u036f]/g,'');}
  catch(_){v=String(v).trim().toLowerCase();}
  return v.replace(/[^a-z0-9]+/g,'')||null;
}
function fbP4InjuryTeamFile(teamName){
  var k=fbP4Key(teamName);
  return FB.pq&&FB.pq.teams&&FB.pq.teams[k]?FB.pq.teams[k]:null;
}
function fbP4InjuryIdentity(teamName,playerName){
  var d=fbP4InjuryTeamFile(teamName),nk=fbP4PersonKey(playerName),hit=null,n=0,i,p;
  if(!d||!nk||!d.players)return null;
  for(i=0;i<d.players.length;i++){
    p=d.players[i];
    if(p&&fbP4PersonKey(p.n)===nk){hit=p;n++;}
  }
  return n===1?hit:null;
}
function fbP4InjuryReplacement(teamName,athlete,scoped){
  var d=fbP4InjuryTeamFile(teamName),g,i,p,blocked={};
  if(!d||!athlete||!d.players)return null;
  g=String(athlete.g||athlete.p||'').toUpperCase();
  (scoped||[]).forEach(function(x){
    var st=String(x.status||x.availability_status||'').toUpperCase();
    if(st==='OUT'||st==='DOUBTFUL'||st==='OUT_FIRST_HALF'){
      var k=fbP4PersonKey(x.player_name||x.name);if(k)blocked[k]=1;
    }
  });
  var rows=d.players.filter(function(x){
    return x&&String(x.g||x.p||'').toUpperCase()===g
      && String(x.id||'')!==String(athlete.id||'')
      && !blocked[fbP4PersonKey(x.n)]
      && x.e!=null&&isFinite(x.e);
  }).sort(function(a,b){
    return (+b.e)-(+a.e)||((b.share==null?-1:+b.share)-(a.share==null?-1:+a.share));
  });
  return rows.length?rows[0]:null;
}
/* Load only player files that can affect a current injury row. */
function fbP4InjuryPlayerEnsure(){
  if(!FB.pq||typeof fbPqTeam!=='function'||!window.EDCARD||!window.EDCARD.cavTeam)
    return Promise.resolve([]);
  var need={},ps=[];
  (FB.p4.up||[]).forEach(function(u){
    [[u.g.home_team,u.g.game_id],[u.g.away_team,u.g.game_id]].forEach(function(x){
      var name=x[0],gid=x[1],t=null,q,has=false;
      try{t=window.EDCARD.cavTeam(name);}catch(_){t=null;}
      if(!t)return;
      q=String(t.dataQuality||'NONE').toUpperCase();
      if(q==='NONE'||q==='LIMITED')return;
      (t.players||[]).forEach(function(p){
        if(has)return;
        if(p.game_id!=null&&gid!=null&&String(p.game_id)!==String(gid))return;
        if(FBP4_AVAIL_STATUS[String(p.status||p.availability_status||'').toUpperCase()])has=true;
      });
      if(has)need[fbP4Key(name)]=1;
    });
  });
  Object.keys(need).forEach(function(k){ps.push(fbPqTeam(k));});
  return Promise.all(ps);
}
function fbP4OfficialForGame(t,gameId){`,
'browser injury identity helpers');

replaceOne(
`    out.push({player:p.player_name||p.name||null, position:p.position||null,
      starter:p.depth_role==null?null:/(^|[^0-9])1($|[^0-9])|starter|^qb1|^rb1|^wr1|^lt$|^rt$/i.test(String(p.depth_role)),
      snap_share:null,severity:null,status:st,replacement_quality:null,
      source:p.source_name||t.team_name||null,
      as_of:p.observed_at||t.lastUpdated||null});`,
`    var playerName=p.player_name||p.name||null;
    var athlete=fbP4InjuryIdentity(teamName,playerName);
    var replacement=athlete?fbP4InjuryReplacement(teamName,athlete,scoped):null;
    var role=athlete&&athlete.role!=null?athlete.role:p.depth_role;
    var researchRepl=replacement&&replacement.e!=null&&isFinite(replacement.e)
      ?Math.max(0,Math.min(1,+replacement.e/100)):null;
    out.push({player:playerName,
      athlete_id:athlete?String(athlete.id):null,
      identity_basis:athlete?'unique team/name -> player-layer athlete_id':null,
      identity_confidence:athlete&&athlete.cf!=null&&isFinite(athlete.cf)?+athlete.cf:null,
      player_rating:athlete&&athlete.e!=null&&isFinite(athlete.e)?+athlete.e:null,
      position:(athlete&&(athlete.p||athlete.g))||p.position||null,
      starter:role==null?null:/(^|[^0-9])1($|[^0-9])|starter|^qb1|^rb1|^wr1|^lt$|^rt$/i.test(String(role)),
      snap_share:athlete&&athlete.share!=null&&isFinite(athlete.share)?+athlete.share:null,
      severity:null,status:st,
      replacement_quality:null,
      replacement_quality_research:researchRepl,
      replacement_player_id:replacement?String(replacement.id):null,
      replacement_player:replacement?replacement.n:null,
      replacement_rating:replacement&&replacement.e!=null&&isFinite(replacement.e)?+replacement.e:null,
      source:p.source_name||t.team_name||null,
      as_of:p.observed_at||t.lastUpdated||null});`,
'browser injury row enrichment');

replaceOne(
`    return fbP4TalentMerge(signal).catch(function(){});
  }).then(function(){
    var ids=FB.p4.up.map(function(u){return u.g.game_id;}).filter(Boolean);`,
`    return fbP4TalentMerge(signal).catch(function(){});
  }).then(function(){
    return fbP4InjuryPlayerEnsure().catch(function(){});
  }).then(function(){
    var ids=FB.p4.up.map(function(u){return u.g.game_id;}).filter(Boolean);`,
'preload injury player files');

fs.writeFileSync(FILE,s);
console.log('[cfb-browser-injury-identity] patched app.html');
