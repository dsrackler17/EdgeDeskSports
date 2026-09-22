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

if(changed){fs.writeFileSync(file,s);console.log('patched app.html NFL live-feed paths');}
else console.log('app.html NFL live-feed paths already current');
