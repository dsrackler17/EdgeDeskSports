var DOW_NAMES=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
var DOW_FULL=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
var DOW_ORDER=[1,2,3,4,5,6,0];              /* read Mon -> Sun */
var DOW_CUTOFF_H=6;                          /* slate day starts 6am ET */

function recSlateDow(iso){
  if(!iso)return null;
  var d=new Date(iso); if(isNaN(d.getTime()))return null;
  var shifted=new Date(d.getTime()-DOW_CUTOFF_H*3600000);
  try{
    var wd=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',weekday:'short'}).format(shifted);
    var i=DOW_NAMES.indexOf(wd); return i<0?null:i;
  }catch(_){ return shifted.getUTCDay(); }
}
function recWilsonLo(k,n){
  if(!n)return null;
  var z=1.96,p=k/n,z2=z*z;
  var lo=(p+z2/(2*n)-z*Math.sqrt((p*(1-p)+z2/(4*n))/n))/(1+z2/n);
  return Math.max(0,Math.min(1,lo));
}
/* The Wilson floor ALONE is not enough protection, and it is worth being
   explicit about why: at 4-for-4 the 95% lower bound is 0.51, which clears a
   bare >0.5 test. Wilson is anti-conservative for tiny n at extreme
   proportions, so a four-row Tuesday that happened to beat the close every
   time would otherwise read as a finding. A day counts as separable only when
   it clears the sample floor AND the Wilson bound. */
function recDowSeparable(a){
  return a.n_clv>=REC_MIN && a.beat_lo!=null && a.beat_lo>0.5;
}
function recMedian(a){
  if(!a.length)return null;
  var b=a.slice().sort(function(x,y){return x-y;}),m=b.length>>1;
  return b.length%2?b[m]:(b[m-1]+b[m])/2;
}
/* one bucket of rows -> the same shape the rest of the dashboard speaks */
function recDowAgg(rows){
  var clvs=[],beat=0,beatN=0,w=0,l=0,units=0,priced=0;
  rows.forEach(function(r){
    if(r.clv!=null){clvs.push(+r.clv); beatN++; if(r.beat_close)beat++;}
    if(r.result==='win')w++;else if(r.result==='loss')l++;
    if(r._profit!=null){units+=r._profit;priced++;}
  });
  var avg=clvs.length?clvs.reduce(function(a,b){return a+b;},0)/clvs.length:null;
  return {n:rows.length, n_clv:clvs.length,
    avg_clv:avg, median_clv:recMedian(clvs),
    beat_rate:beatN?beat/beatN:null, beat_lo:beatN?recWilsonLo(beat,beatN):null,
    w:w, l:l, units:priced?units:null, roi:priced?units/priced*100:null, priced:priced};
}
function recDowRows(){
  var rows=(REC.flt||[]).slice();
  var sp=REC.dow.sport, mk=REC.dow.market;
  if(sp)rows=rows.filter(function(r){return (r.sport_title||'')===sp;});
  if(mk)rows=rows.filter(function(r){return (r.market||'')===mk;});
  return rows;
}
function recDowCell(v,cls){return '<td class="'+(cls||'')+'">'+v+'</td>';}


var REC={flt:[],dow:{sport:'',market:''}};
var REC_MIN=30;
let pass=0,fail=0;
function ok(n,c,d){ if(c){pass++;console.log("  PASS  "+n);} else {fail++;console.log("  FAIL  "+n+"  "+JSON.stringify(d));} }
function row(iso,clv,res,sport,market){
  return {commence_time:iso,clv:clv,beat_close:clv>0,result:res,sport_title:sport,market:market,
          _profit:res==='win'?1.1:res==='loss'?-1:0};
}
const pool=[];
for(let i=0;i<40;i++) pool.push(row("2026-08-12T23:10:00Z",0.025,i%100<57?'win':'loss',"MLB","h2h"));
for(let i=0;i<40;i++) pool.push(row("2026-08-15T20:05:00Z",0.005,i%100<51?'win':'loss',"MLB","h2h"));
for(let i=0;i<4;i++)  pool.push(row("2026-08-11T23:10:00Z",0.09,'win',"MLB","h2h"));
pool.push(row("2026-08-13T05:10:00Z",0.02,'win',"MLB","h2h"));   // 10:10pm PT Wednesday
pool.push(row("2026-08-12T23:10:00Z",-0.05,'loss',"WNBA","h2h"));
pool.push(row(null,0.01,'win',"MLB","h2h"));
REC.flt=pool;

console.log("\nSlate-day bucketing");
const buckets={}; DOW_ORDER.forEach(d=>buckets[d]=[]);
let undated=0;
recDowRows().forEach(r=>{const d=recSlateDow(r.commence_time); if(d==null){undated++;return;} buckets[d].push(r);});
ok("D1 the 10:10pm PT Wednesday game lands on Wednesday, not Thursday", buckets[4].length===0,{thu:buckets[4].length});
ok("D2 Wednesday holds 40 + west-coast + WNBA", buckets[3].length===42, buckets[3].length);
ok("D3 Saturday holds 40", buckets[6].length===40, buckets[6].length);
ok("D4 a null timestamp is excluded, not bucketed", undated===1, undated);

console.log("\nAggregation");
const wed=recDowAgg(buckets[3]), sat=recDowAgg(buckets[6]), tue=recDowAgg(buckets[2]);
ok("D5 Wednesday avg CLV is real", Math.abs(wed.avg_clv-0.0234)<0.002, wed.avg_clv);
ok("D6 Saturday avg CLV is real", Math.abs(sat.avg_clv-0.005)<1e-9, sat.avg_clv);
ok("D7 Wednesday clears the sample floor", wed.n_clv>=REC_MIN, wed.n_clv);
ok("D8 Tuesday does not", tue.n_clv<REC_MIN, tue.n_clv);
ok("D9 a 4-row 100% day is NOT separable, even though Wilson lo clears 0.5",
   recDowSeparable(tue)===false && tue.beat_lo>0.5, {lo:+tue.beat_lo.toFixed(3),n:tue.n_clv});
ok("D10 a 40-row day IS separable", recDowSeparable(wed)===true, {lo:+wed.beat_lo.toFixed(3),n:wed.n_clv});
ok("D11 ROI is computed only over priced rows", wed.priced===wed.n, {priced:wed.priced,n:wed.n});

console.log("\nWeekday vs weekend");
const wd=recDowAgg([1,2,3,4,5].reduce((a,d)=>a.concat(buckets[d]),[]));
const we=recDowAgg([0,6].reduce((a,d)=>a.concat(buckets[d]),[]));
ok("D12 both halves clear the floor", wd.n_clv>=REC_MIN&&we.n_clv>=REC_MIN,{wd:wd.n_clv,we:we.n_clv});
const gap=wd.avg_clv-we.avg_clv;
ok("D13 the weekday edge is detected", gap>0.015, gap);
console.log("     -> weekdays "+(wd.avg_clv*100).toFixed(2)+"% vs weekends "+(we.avg_clv*100).toFixed(2)+"%, gap +"+(gap*100).toFixed(2)+"%");

console.log("\nFilters");
REC.dow.sport="MLB";
ok("D14 the sport filter drops the WNBA row",
   recDowRows().filter(r=>recSlateDow(r.commence_time)===3).length===41);
REC.dow.sport=""; REC.dow.market="spreads";
ok("D15 a market with no rows yields an empty slice", recDowRows().length===0);
REC.dow.market="";

console.log("\nDegenerate input");
ok("D16 an empty bucket is zeros, not NaN",
  (()=>{const a=recDowAgg([]);return a.n===0&&a.avg_clv===null&&a.beat_lo===null&&a.roi===null;})());
ok("D17 median of one", recMedian([0.03])===0.03);
ok("D18 median of an even count", recMedian([1,2,3,4])===2.5);
ok("D19 Wilson of 0/0 is null", recWilsonLo(0,0)===null);
ok("D20 an all-empty pool never claims separability", recDowSeparable(recDowAgg([]))===false);

console.log("\n"+(fail?"FAILURES":"ALL GREEN")+" — "+pass+" passed, "+fail+" failed");
if(fail) process.exit(1);
