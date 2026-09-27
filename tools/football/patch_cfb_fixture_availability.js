#!/usr/bin/env node
'use strict';

/* ============================================================================
   KEEP THE LEGACY SINGLE-FILE BROWSER IN STEP WITH THE CFB INPUT CONTRACT.

   app.html is intentionally a checked-in static artifact and is several MB.
   The browser still contains a small copy of the request assembly logic. This
   patch is idempotent and narrowly owns one contract: availability evidence
   tied to a fixture may only affect that fixture.

   The Node/offline implementation lives in football/matchup/inputs.js and is
   the source of truth. This patch keeps the legacy browser mirror honest until
   that whole section is extracted into a shared browser module.
   ========================================================================== */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FILE = path.join(ROOT, 'app.html');
let s = fs.readFileSync(FILE, 'utf8');

const MARK = 'function fbP4OfficialForGame(t,gameId){';
/* the fixture id reaches the list; the call may also carry the kickoff the
   list is dated against ({kickoff, now}), which is the same contract, later */
if (s.includes(MARK)
    && /injuries:fbP4Injuries\(g\.home_team,g\.game_id[,)]/.test(s)
    && s.includes("OUT_FIRST_HALF:'questionable'")) {
  console.log('[cfb-browser-availability] already patched');
  process.exit(0);
}

function replaceOne(oldText, newText, label) {
  const n = s.split(oldText).length - 1;
  if (n !== 1) throw new Error(label + ': expected exactly one old anchor, found ' + n);
  s = s.replace(oldText, newText);
}

replaceOne(
`var FBP4_AVAIL_STATUS={OUT:'out',DOUBTFUL:'doubtful',QUESTIONABLE:'questionable',
  GAME_TIME_DECISION:'questionable',DAY_TO_DAY:'questionable',PROBABLE:'probable',
  LIMITED:'probable'};
function fbP4Injuries(teamName){
  var C=window.EDCARD;`,
`var FBP4_AVAIL_STATUS={OUT:'out',DOUBTFUL:'doubtful',QUESTIONABLE:'questionable',
  GAME_TIME_DECISION:'questionable',DAY_TO_DAY:'questionable',
  /* QUESTIONABLE has the engine's measured 0.50 status weight, which is the
     correct half-game representation for OUT_FIRST_HALF. */
  OUT_FIRST_HALF:'questionable',PROBABLE:'probable',LIMITED:'probable'};
function fbP4OfficialForGame(t,gameId){
  var r=t&&t.official_report;
  if(!r||r.ok===false||r.game_id==null||gameId==null)return null;
  return String(r.game_id)===String(gameId)?r:null;
}
function fbP4Injuries(teamName,gameId){
  var C=window.EDCARD;`,
  'availability function header');

replaceOne(
`  var out=[];
  (t.players||[]).forEach(function(p){
    var st=FBP4_AVAIL_STATUS[String(p.availability_status||'').toUpperCase()];
    if(!st) return;                       /* an observation is not a designation */
    out.push({player:p.player_name||null, position:p.position||null,
      /* the SAME starter test the availability layer itself uses, so one
         record does not read as a starter in one place and a backup in
         another; an unknown depth role stays unknown */
      starter:p.depth_role==null?null:/(^|[^0-9])1($|[^0-9])|starter|^qb1|^rb1|^wr1|^lt$|^rt$/i.test(String(p.depth_role)),
      snap_share:null,                    /* no public college feed carries it */
      severity:null,
      status:st,
      replacement_quality:null,           /* nor this */
      source:p.source_name||t.team_name||null,
      as_of:p.observed_at||t.lastUpdated||null});
  });
  return out;
}`,
`  var report=fbP4OfficialForGame(t,gameId);
  var scoped=(t.players||[]).filter(function(p){
    return p.game_id==null||gameId==null||String(p.game_id)===String(gameId);
  });
  var out=[];
  scoped.forEach(function(p){
    var st=FBP4_AVAIL_STATUS[String(p.availability_status||p.status||'').toUpperCase()];
    if(!st) return;
    out.push({player:p.player_name||p.name||null, position:p.position||null,
      starter:p.depth_role==null?null:/(^|[^0-9])1($|[^0-9])|starter|^qb1|^rb1|^wr1|^lt$|^rt$/i.test(String(p.depth_role)),
      snap_share:null,severity:null,status:st,replacement_quality:null,
      source:p.source_name||t.team_name||null,
      as_of:p.observed_at||t.lastUpdated||null});
  });
  if(out.length)return out;
  /* [] means "known clean" to the engine. Only a comprehensive report for
     THIS fixture earns that meaning; historical fixture rows cannot. */
  if(report&&report.comprehensive)return [];
  if(scoped.some(function(p){return p.game_id==null;}))return out;
  return null;
}`,
  'availability flattening');

replaceOne(
`injuries:fbP4Injuries(g.home_team),news:null,coaching:null,schedule:fbP4SchedCtx(g,'home')},
      away:{conference:g.away_conference,roster:FB.p4.roster[ak]||null,
        qb:null,qb_context:fbP4QbContext(g.away_team),
        injuries:fbP4Injuries(g.away_team),news:null,coaching:null,schedule:fbP4SchedCtx(g,'away')}`,
`injuries:fbP4Injuries(g.home_team,g.game_id),news:null,coaching:null,schedule:fbP4SchedCtx(g,'home')},
      away:{conference:g.away_conference,roster:FB.p4.roster[ak]||null,
        qb:null,qb_context:fbP4QbContext(g.away_team),
        injuries:fbP4Injuries(g.away_team,g.game_id),news:null,coaching:null,schedule:fbP4SchedCtx(g,'away')}`,
  'browser request calls');

replaceOne(
`var side=x[0],isFbs=x[1],name=x[2],list=fbP4Injuries(name),t=null;`,
`var side=x[0],isFbs=x[1],name=x[2],list=fbP4Injuries(name,g.game_id),t=null,report=null;`,
  'browser contract call');

replaceOne(
`    try{ t=C&&C.cavTeam?C.cavTeam(name):null; }catch(_){ t=null; }
    if(list&&list.length)`,
`    try{ t=C&&C.cavTeam?C.cavTeam(name):null; }catch(_){ t=null; }
    report=fbP4OfficialForGame(t,g.game_id);
    if(list&&list.length)`,
  'browser contract report');

replaceOne(
`    else if(list)K.push(fbP4CRow('availability',side,(avAge!=null&&avAge>FBP4_STALE_H.availability)?'STALE':'USABLE',
      {source:'EdgeDesk college availability layer',as_of:fbP4AvailAsOf(),
        detail:'the sources were read and named nobody \\u2014 a report of no absences, '
          +'which is not the same as no report'}));
    else if(!isFbs)`,
`    else if(list&&report&&report.comprehensive)K.push(fbP4CRow('availability',side,(avAge!=null&&avAge>FBP4_STALE_H.availability)?'STALE':'USABLE',
      {source:'official conference availability report',as_of:report.retrieved_at||fbP4AvailAsOf(),
        detail:'the comprehensive official report for THIS game was read and names nobody unavailable \\u2014 '
          +'a report of no absences, which is not the same as no report'}));
    else if(list)K.push(fbP4CRow('availability',side,(avAge!=null&&avAge>FBP4_STALE_H.availability)?'STALE':'USABLE',
      {source:'EdgeDesk college availability layer',as_of:fbP4AvailAsOf(),
        detail:'the current unscoped sources were read and named nobody; no fixture-specific comprehensive '
          +'filing establishes a clean roster, so this is not described as one'}));
    else if(report)K.push(fbP4CRow('availability',side,'RESEARCH_ONLY',
      {source:'official conference availability report',as_of:report.retrieved_at||fbP4AvailAsOf(),
        detail:'the official report for THIS game was read, but its scope is not comprehensive and it names no '
          +'priced absence. Silence therefore remains unknown rather than becoming a clean injury report'}));
    else if(!isFbs)`,
  'browser contract empty-report meaning');

fs.writeFileSync(FILE, s);
console.log('[cfb-browser-availability] patched app.html');
