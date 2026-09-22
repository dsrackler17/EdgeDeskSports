#!/usr/bin/env node
'use strict';
const fs=require('fs'),path=require('path');
const file=path.join(__dirname,'..','..','app.html');
let s=fs.readFileSync(file,'utf8');

function replaceOne(oldText,newText,label){
  if(s.includes(newText)) return false;
  const i=s.indexOf(oldText);
  if(i<0) throw new Error('app.html patch anchor missing: '+label);
  if(s.indexOf(oldText,i+oldText.length)>=0) throw new Error('app.html patch anchor ambiguous: '+label);
  s=s.slice(0,i)+newText+s.slice(i+oldText.length);
  return true;
}

let changed=false;
changed=replaceOne(
  "function FB_URL_STW(y){return 'https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_'+y+'.csv';}",
  "function FB_URL_STW(y){return '/football/nfl/stats_team_week_'+y+'.csv';}",
  'FB_URL_STW'
)||changed;

changed=replaceOne(
  "        return fbFetchText(FB_URL_STW(y2),signal).then(function(t){return fbCsv(t);}).catch(function(){S.notes.push('stats_team_week_'+y2+' not published yet — '+y2+' results not absorbed into ratings');return [];});",
  "        return fbFetchText(FB_URL_STW(y2),signal).then(function(t){return fbCsv(t);}).catch(function(e){S.notes.push('stats_team_week_'+y2+' unavailable ('+((e&&e.message)||'load failed')+') — '+y2+' results not absorbed into ratings');return [];});",
  'team-week warning'
)||changed;

changed=replaceOne(
  "      if(!absorbed&&maxSeason>st.seededThrough)S.notes.push('No completed '+maxSeason+' games yet — ratings are the trained '+st.seededThrough+' seeds with the learned season carry-over applied.');",
  "      if(!absorbed&&maxSeason>st.seededThrough){if(toAbsorb.length)S.notes.push(toAbsorb.length+' completed '+maxSeason+' game'+(toAbsorb.length===1?'':'s')+' found, but none could be absorbed because team-week stats were unavailable or unmatched — ratings remain the trained '+st.seededThrough+' seeds with the learned season carry-over applied.');else S.notes.push('No completed '+maxSeason+' games yet — ratings are the trained '+st.seededThrough+' seeds with the learned season carry-over applied.');}",
  'zero-absorbed warning'
)||changed;

changed=replaceOne(
  "      if(!Object.keys(sig).length)S.notes.push('No captured NFL quotes in this window (offseason, or capture has not priced NFL yet); nflverse reference numbers shown where published are a consensus close, not a bettable price.');",
  "      if(!Object.keys(sig).length)S.notes.push('Live sportsbook prices are not available for this NFL window yet. EdgeDesk can still show its model and nflverse consensus reference lines, but those reference lines may not be currently bettable. Check your sportsbook before acting on a number.');",
  'NFL live-price notice'
)||changed;

changed=replaceOne(
  "        return fbFetchText(FB_URL_STW(y2),signal).then(function(t){return fbCsv(t);}).catch(function(e){S.notes.push('stats_team_week_'+y2+' unavailable ('+((e&&e.message)||'load failed')+') — '+y2+' results not absorbed into ratings');return [];});",
  "        return fbFetchText(FB_URL_STW(y2),signal).then(function(t){return fbCsv(t);}).catch(function(e){S.notes.push('NFL team stats are temporarily unavailable, so some recent completed games are not included in the ratings yet. EdgeDesk is keeping the last trusted ratings instead of guessing and will update automatically when the feed returns.');return [];});",
  'friendly team-week warning'
)||changed;

changed=replaceOne(
  "      if(!absorbed&&maxSeason>st.seededThrough){if(toAbsorb.length)S.notes.push(toAbsorb.length+' completed '+maxSeason+' game'+(toAbsorb.length===1?'':'s')+' found, but none could be absorbed because team-week stats were unavailable or unmatched — ratings remain the trained '+st.seededThrough+' seeds with the learned season carry-over applied.');else S.notes.push('No completed '+maxSeason+' games yet — ratings are the trained '+st.seededThrough+' seeds with the learned season carry-over applied.');}",
  "      if(!absorbed&&maxSeason>st.seededThrough){if(toAbsorb.length)S.notes.push('Recent NFL games were found, but their team stats have not finished syncing into the ratings yet. EdgeDesk is keeping the last trusted ratings until the data is complete.');else S.notes.push('The '+maxSeason+' NFL season has not produced a completed game for the ratings yet. EdgeDesk starts from last season\\'s trained ratings with the normal offseason carry-over until real '+maxSeason+' results are available.');}",
  'friendly no-absorb warning'
)||changed;

changed=replaceOne(
  "        if(S.qbs.length&&S.qbSource!=='nflverse')S.notes.push('QB rosters: nflverse roster_'+maxSeason+'.csv '+(S.qbError?('unavailable ('+S.qbError+')'):'not yet checked')+' — showing '+(S.qbSource==='cache'?('the last successful sync from '+ago(S.qbUpdatedAt)):('the bundled '+fbQbSeedDate()+' snapshot'))+'. Roster membership only; no starter is inferred from it.');",
  "        if(S.qbs.length&&S.qbSource!=='nflverse')S.notes.push('The live NFL QB roster update could not load, so EdgeDesk is showing '+(S.qbSource==='cache'?('the last successful roster sync from '+ago(S.qbUpdatedAt)):('its saved '+fbQbSeedDate()+' roster snapshot'))+'. This only affects the roster display; EdgeDesk does not guess who is starting.');",
  'friendly QB roster warning'
)||changed;

if(changed){fs.writeFileSync(file,s);console.log('patched app.html NFL live-feed paths');}
else console.log('app.html NFL live-feed paths already current');
