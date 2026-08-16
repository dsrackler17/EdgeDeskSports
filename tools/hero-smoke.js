/* Wiring test: does renderResearchHero actually paint the host and fold the
   movement board? The HTML builders are unit-tested; this proves the plumbing. */
const fs=require('fs'), vm=require('vm');
const src=fs.readFileSync('/home/user/EdgeDeskSports/app.html','utf8');
const re=/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
const blocks=[]; let m,i=0;
while((m=re.exec(src))){ i++; if(m[1].indexOf('selfTest')>=0) blocks.push(m[1]); }

const nodes={};
function mk(id){ return nodes[id]={id, innerHTML:'', _cls:new Set(['disco','hide']),
  classList:{add(c){nodes[id]._cls.add(c);},remove(c){nodes[id]._cls.delete(c);},
             contains(c){return nodes[id]._cls.has(c);},toggle(){}},
  style:{},dataset:{},children:[],appendChild(c){return c;},querySelector(){return null;},
  querySelectorAll(){return [];},setAttribute(){},getAttribute(){return null;},
  addEventListener(){},remove(){},scrollTop:0,scrollHeight:0}; }
mk('todayResearchCta'); mk('discovery');
const store={};
const sb={console,Promise,Date,Math,JSON,isFinite,parseFloat,parseInt,encodeURIComponent,Intl,RegExp,
  Object,Array,String,Number,Boolean,Error,setTimeout,clearTimeout,setInterval,clearInterval,
  document:{getElementById:id=>nodes[id]||null,createElement:()=>mk('tmp'),
    querySelector:()=>null,querySelectorAll:()=>[],addEventListener:()=>{}},
  localStorage:{getItem:k=>(k in store?store[k]:null),setItem:(k,v)=>{store[k]=String(v);},
    removeItem:k=>{delete store[k];},key:j=>Object.keys(store)[j]||null,get length(){return Object.keys(store).length;}},
  fetch:async()=>{throw new Error('no net');},
  SB_URL:'',REAL_FLOOR:0.005,EDGE_MAX_AGE_MIN:90,WX_STALE_H:6,
  GE:{fmtPrice:d=>'x',amToDec:a=>a>=100?1+a/100:1+100/-a,decToAm:d=>d>=2?Math.round((d-1)*100):Math.round(-100/(d-1))},
  sbGet:async()=>[],sbPost:async()=>null,sbGetUfc:async()=>[],sbGetTennis:async()=>[],sbGetCfb:async()=>[],
  mlbLookup:()=>null,loadMlbSched:async()=>{},isTrusted:()=>true,
  selLabel:e=>'',mktLabel:m=>'',evSportLabel:e=>'',whenLabel:()=>'',wxAgeH:()=>0,
  onlyFlagged:r=>r,filterTradeable:r=>({keep:r,dropped:[]}),
  ufcNormName:n=>String(n||'').toLowerCase(),mlbNorm:s=>String(s||'').toLowerCase(),
  MLBG:{},EDGES:[],D5_POOL:[],WX:{}};
sb.window=sb; sb.globalThis=sb; vm.createContext(sb);
blocks.forEach((b,n)=>{ try{ new vm.Script(b,{filename:'b'+n}).runInContext(sb); }
  catch(e){ console.error('LOAD '+n+': '+e.message); process.exit(3); } });

let pass=0,fail=0;
const chk=(t,c)=>{ c?pass++:(fail++,console.log('  FAIL '+t)); };
const V2=sb.EDResearchV2;
const host=nodes.todayResearchCta, disco=nodes.discovery;

/* --- cold: no packet ever written --- */
chk('hasResearched() is false on a cold install', V2.hasResearched()===false);
chk('renderResearchHero() reports it painted', V2.renderResearchHero()===true);
chk('the host shows the first-run hero', /Your first research run/.test(host.innerHTML));
chk('the host does NOT show a fabricated last-run time', !/min ago/.test(host.innerHTML));
disco.classList.remove('hide'); disco.innerHTML='<div>board</div>';
V2.renderResearchHero();
chk('the movement board is folded away before any run', disco.classList.contains('hide'));
chk('the folded board is emptied, not just hidden', disco.innerHTML==='');

/* --- warm: a real packet exists in the store --- */
const pk={id:'EDR-20260816-1',version:2,created_at:Date.now()-4*60000,
  created_at_iso:new Date().toISOString(),outcome:'NO BET',quality_outcome:'NO BET',
  scope:{games_scanned:187,in_window:31,sharp_screened:8,deep_researched:4,finalists:4,
         rejections_recorded:12,rejections_total:183},
  finalists:[],rejections:[],reevaluations:[],data_warnings:[]};
chk('packetSave accepts a real packet', V2.packetSave(pk).ok===true);
chk('hasResearched() flips once a packet exists', V2.hasResearched()===true);
V2.renderResearchHero();
chk('the hero switches to the returning state', /Today/.test(host.innerHTML) && !/Your first research run/.test(host.innerHTML));
chk('the hero shows the measured scan count', host.innerHTML.indexOf('187')>=0);
chk('the hero shows the rejected count', host.innerHTML.indexOf('183')>=0);
chk('the hero carries the NO BET conclusion', /NO BET/.test(host.innerHTML));
/* The hero FOLDS the board before a run; it must never re-fold one that the
   board renderer has since opened, or the grid would vanish on every repaint. */
disco.classList.remove('hide'); disco.innerHTML='<div>board</div>';
V2.renderResearchHero();
chk('an opened board survives a hero repaint', !disco.classList.contains('hide'));
chk('an opened board keeps its content', disco.innerHTML==='<div>board</div>');

console.log((fail?'FAILURES':'ALL GREEN')+' — '+pass+'/'+(pass+fail)+' passed');
process.exit(fail?1:0);
