#!/usr/bin/env node
'use strict';
const fs=require('fs'),path=require('path');
const URL=(s)=>`https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_${s}.csv`;
function seasonNow(){const d=new Date();return d.getMonth()<=1?d.getFullYear()-1:d.getFullYear();}
function parseCsv(text){
  const rows=[];let row=[],field='',q=false;
  for(let i=0;i<text.length;i++){const c=text[i];
    if(q){if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else q=false;}else field+=c;continue;}
    if(c==='"')q=true;else if(c===','){row.push(field);field='';}
    else if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field);field='';if(row.length>1||row[0]!=='')rows.push(row);row=[];}
    else field+=c;
  }
  if(field.length||row.length){row.push(field);rows.push(row);}
  const header=rows.shift()||[];
  return {header,rows:rows.map(r=>{const o={};header.forEach((h,i)=>o[h]=r[i]??'');return o;})};
}
function validate(text,season){
  const p=parseCsv(text),req=['season','week','season_type','team','game_id','attempts','carries','sacks_suffered','passing_epa','rushing_epa','passing_20','rushing_10'];
  const miss=req.filter(c=>!p.header.includes(c));if(miss.length)throw new Error('missing columns: '+miss.join(', '));
  const reg=p.rows.filter(r=>String(r.season)===String(season)&&String(r.season_type||'REG').toUpperCase()==='REG'&&r.team&&r.game_id);
  const teams=new Set(reg.map(r=>r.team)),games=new Set(reg.map(r=>r.game_id));
  if(reg.length<2||teams.size<2||games.size<1)throw new Error(`implausible data: ${reg.length} rows / ${teams.size} teams / ${games.size} games`);
  return {rows:reg.length,teams:teams.size,games:games.size};
}
async function main(){
  const a=process.argv.slice(2),v=(k,d)=>{const i=a.indexOf(k);return i>=0&&a[i+1]?a[i+1]:d;};
  const season=parseInt(v('--season',String(seasonNow())),10),out=v('--out',__dirname),file=path.join(out,`stats_team_week_${season}.csv`);
  let text;try{const r=await fetch(URL(season),{redirect:'follow'});if(!r.ok)throw new Error('HTTP '+r.status);text=await r.text();}catch(e){console.error('team-week fetch failed: '+e.message);process.exit(1);}
  let s;try{s=validate(text,season);}catch(e){console.error('team-week refused: '+e.message);process.exit(1);}
  if(!text.endsWith('\n'))text+='\n';
  if(fs.existsSync(file)&&fs.readFileSync(file,'utf8')===text){console.log(`team-week unchanged: ${s.rows} team-games / ${s.games} games / ${s.teams} teams`);return;}
  fs.mkdirSync(out,{recursive:true});fs.writeFileSync(file,text);console.log(`team-week wrote ${file}: ${s.rows} team-games / ${s.games} games / ${s.teams} teams`);
}
if(require.main===module)main();
module.exports={URL,parseCsv,validate};
