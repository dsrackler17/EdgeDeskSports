#!/usr/bin/env node
'use strict';

/* ============================================================================
   ENRICH LIVE CFB INJURY ROWS WITH THE SAME PLAYER IDENTITY/USAGE DATA AS NODE.

   Runs AFTER patch_cfb_fixture_availability.js.

   The browser reads ONE compact artifact:
     football/players/injury_index.json

   It never guesses an athlete. Only a unique team/name match is accepted.
   Athlete identity, starter role and measured snap share may reach the injury
   contract. Player rating and replacement rating remain RESEARCH metadata and
   never enter replacement_quality, so this does not promote the unvalidated
   player-quality layer into pricing.

   The patch is idempotent and can also upgrade the older version that fetched
   individual team files.
   ========================================================================== */

const fs=require('fs');
const path=require('path');
const ROOT=path.join(__dirname,'..','..');
const FILE=path.join(ROOT,'app.html');
let s=fs.readFileSync(FILE,'utf8');

const MARK='function fbP4InjuryIndexEnsure(){';
if(s.includes(MARK)
  && s.includes('return fbP4InjuryIndexEnsure().catch(function(){});')
  && s.includes('replacement_quality_research:')){
  console.log('[cfb-browser-injury-identity] already patched');
  process.exit(0);
}

function replaceOne(oldText,newText,label){
  const n=s.split(oldText).length-1;
  if(n!==1)throw new Error(label+': expected exactly one old anchor, found '+n);
  s=s.replace(oldText,newText);
}

const HELPERS=`function fbP4PersonKey(v){
  if(v==null)return null;
  try{v=String(v).trim().toLowerCase().normalize('NFKD').replace(/[\\u0300-\\u036f]/g,'');}
  catch(_){v=String(v).trim().toLowerCase();}
  return v.replace(/[^a-z0-9]+/g,'')||null;
}
function fbP4InjuryIndexEnsure(){
  var S=FB.p4;
  if(S.injuryIdentityIndex)return Promise.resolve(S.injuryIdentityIndex);
  if(S._injuryIdentityP)return S._injuryIdentityP;
  S._injuryIdentityP=fetch('football/players/injury_index.json?v='+Date.now(),
    {cache:'no-store'}).then(function(r){
      if(!r.ok)throw new Error('HTTP '+r.status);
      return r.json();
    }).then(function(d){
      if(!d||d.schema!=='edgedesk_cfb_injury_identity_v1')
        throw new Error('unexpected injury-identity schema');
      if(d.season!=null&&S.season!=null&&+d.season!==+S.season)
        throw new Error('injury identity index is for season '+d.season+', not '+S.season);
      S.injuryIdentityIndex=d;S._injuryIdentityP=null;
      return d;
    }).catch(function(e){
      S._injuryIdentityP=null;
      S.notes.push('Player identity could not be joined to availability ('+((e&&e.message)||'load failed')
        +'). Injury evidence remains usable, but unresolved rows keep generic starter/snap assumptions.');
      return null;
    });
  return S._injuryIdentityP;
}
function fbP4InjuryTeamIndex(teamName){
  var d=FB.p4&&FB.p4.injuryIdentityIndex,k=fbP4Key(teamName);
  return d&&d.teams&&d.teams[k]?d.teams[k]:null;
}
function fbP4InjuryIdentity(teamName,playerName){
  var d=fbP4InjuryTeamIndex(teamName),nk=fbP4PersonKey(playerName);
  if(!d||!nk||!d.by_name||!Object.prototype.hasOwnProperty.call(d.by_name,nk))return null;
  return d.by_name[nk]||null;
}
function fbP4InjuryReplacement(athlete,scoped){
  var r=athlete&&athlete.replacement?athlete.replacement:null,blocked={},i,p,st,k;
  if(!r)return null;
  for(i=0;i<(scoped||[]).length;i++){
    p=scoped[i]||{};
    st=String(p.status||p.availability_status||'').toUpperCase();
    if(st!=='OUT'&&st!=='DOUBTFUL'&&st!=='OUT_FIRST_HALF')continue;
    k=fbP4PersonKey(p.player_name||p.name);if(k)blocked[k]=1;
  }
  return blocked[fbP4PersonKey(r.n)]?null:r;
}
`;

const oldHelperStart=s.indexOf('function fbP4InjuryTeamFile(teamName){');
if(oldHelperStart>=0){
  const oldHelperEnd=s.indexOf('function fbP4OfficialForGame(t,gameId){',oldHelperStart);
  if(oldHelperEnd<0)throw new Error('older injury identity helper has no official-report anchor');
  s=s.slice(0,oldHelperStart)+HELPERS+s.slice(oldHelperEnd);
}else if(!s.includes(MARK)){
  replaceOne(
    'function fbP4OfficialForGame(t,gameId){',
    HELPERS+'function fbP4OfficialForGame(t,gameId){',
    'injury identity helper insertion');
}

const genericRow=`    out.push({player:p.player_name||p.name||null, position:p.position||null,
      starter:p.depth_role==null?null:/(^|[^0-9])1($|[^0-9])|starter|^qb1|^rb1|^wr1|^lt$|^rt$/i.test(String(p.depth_role)),
      snap_share:null,severity:null,status:st,replacement_quality:null,
      source:p.source_name||t.team_name||null,
      as_of:p.observed_at||t.lastUpdated||null});`;

const enrichedRow=`    var playerName=p.player_name||p.name||null;
    var athlete=fbP4InjuryIdentity(teamName,playerName);
    var replacement=athlete?fbP4InjuryReplacement(athlete,scoped):null;
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
      as_of:p.observed_at||t.lastUpdated||null});`;

if(s.includes(genericRow)){
  replaceOne(genericRow,enrichedRow,'browser injury row enrichment');
}else if(!s.includes('replacement_quality_research:')){
  throw new Error('browser injury row is neither generic nor already enriched');
}

/* Upgrade the old per-team prefetch call if an earlier generated app has it. */
if(s.includes('return fbP4InjuryPlayerEnsure().catch(function(){});')){
  s=s.replace('return fbP4InjuryPlayerEnsure().catch(function(){});',
    'return fbP4InjuryIndexEnsure().catch(function(){});');
}else if(!s.includes('return fbP4InjuryIndexEnsure().catch(function(){});')){
  replaceOne(
`    return fbP4TalentMerge(signal).catch(function(){});
  }).then(function(){
    var ids=FB.p4.up.map(function(u){return u.g.game_id;}).filter(Boolean);`,
`    return fbP4TalentMerge(signal).catch(function(){});
  }).then(function(){
    return fbP4InjuryIndexEnsure().catch(function(){});
  }).then(function(){
    var ids=FB.p4.up.map(function(u){return u.g.game_id;}).filter(Boolean);`,
    'load compact injury identity index');
}

fs.writeFileSync(FILE,s);
console.log('[cfb-browser-injury-identity] patched app.html');
