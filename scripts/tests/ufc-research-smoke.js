/* ufc-research-smoke.js — behaviour tests for the UFC research module.
 *
 *   python3 -m http.server 8901            # from the repo root
 *   npm i playwright && node scripts/tests/ufc-research-smoke.js
 *
 * No database is involved: each test drives the app's own functions with a
 * fixture and asserts what the user would see. These are the checks that must
 * keep passing for the module to stay honest — that an absent build time is
 * reported as absent, that a failed pipeline run is visible rather than
 * swallowed, that no displayed count is hardcoded, and that consensus prices
 * are never relabelled as CLV.
 */
const { chromium } = require('playwright');
const S = JSON.stringify({access_token:'fake',refresh_token:'fake',expires_at:Math.floor(Date.now()/1000)+7200});
(async()=>{
  const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
  const ctx=await b.newContext({viewport:{width:900,height:1400}});
  await ctx.addInitScript(s=>localStorage.setItem('edgedesk_session',s),S);
  const p=await ctx.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
  await p.goto('http://localhost:8901/app.html',{waitUntil:'domcontentloaded'});
  await p.waitForTimeout(1200);
  const out=[]; const ck=(n,c,d)=>out.push((c?'PASS ':'FAIL ')+n+(c?'':' — '+d));

  // ---- 1. freshness contract -------------------------------------------
  const fresh=await p.evaluate(()=>{
    const m=RESEARCH_MODULES.ufc;
    const r={};
    UFC.meta=null;                       r.noTable   = JSON.stringify(rsFreshness('ufc'));
    UFC.meta={};                         r.emptyMeta = JSON.stringify(rsFreshness('ufc'));
    UFC.meta={built_at:'built recently'};r.garbage   = JSON.stringify(rsFreshness('ufc'));
    UFC.meta={built_at:new Date(Date.now()-2*86400000).toISOString()};
    const f=rsFreshness('ufc');          r.twoDays   = JSON.stringify({p:f.published,stale:f.stale,cad:f.cadence});
    UFC.meta={built_at:new Date(Date.now()-20*86400000).toISOString()};
    const g=rsFreshness('ufc');          r.twentyDays= JSON.stringify({p:g.published,stale:g.stale});
    UFC.meta={last_ingest:new Date(Date.now()-3600000).toISOString()};
    r.fallbackKey = JSON.stringify(rsFreshness('ufc').published);
    return r;
  });
  ck('no meta table -> unpublished', fresh.noTable==='{"published":false}', fresh.noTable);
  ck('empty meta -> unpublished',    fresh.emptyMeta==='{"published":false}', fresh.emptyMeta);
  ck('unparseable stamp -> unpublished, never a fake age', fresh.garbage==='{"published":false}', fresh.garbage);
  ck('2-day-old build -> published, fresh, weekly cadence', fresh.twoDays==='{"p":true,"stale":false,"cad":"weekly"}', fresh.twoDays);
  ck('20-day-old build -> published and STALE', fresh.twentyDays==='{"p":true,"stale":true}', fresh.twentyDays);
  ck('last_ingest works as the fallback key', fresh.fallbackKey==='true', fresh.fallbackKey);

  // ---- 2. the chip and the SLA block ------------------------------------
  const chip=await p.evaluate(()=>{
    const r={};
    UFC.meta=null; rsFreshApply('ufc'); r.none=document.getElementById('ufcFresh').textContent;
    r.noneHTML=rsFreshHTML('ufc');
    UFC.meta={built_at:new Date(Date.now()-3*86400000).toISOString()}; rsFreshApply('ufc');
    r.ok=document.getElementById('ufcFresh').textContent; r.okHTML=rsFreshHTML('ufc');
    UFC.meta={built_at:new Date(Date.now()-30*86400000).toISOString()}; rsFreshApply('ufc');
    r.stale=document.getElementById('ufcFresh').textContent; r.staleHTML=rsFreshHTML('ufc');
    return r;
  });
  ck('unpublished chip still says so', chip.none==='no build time published', chip.none);
  ck('unpublished still renders the SLA-inactive block', /Freshness SLA inactive/.test(chip.noneHTML), 'block gone');
  ck('published chip shows a real age', /^built .* ago$/.test(chip.ok), chip.ok);
  ck('published+fresh renders no warning block', chip.okHTML==='', chip.okHTML.slice(0,80));
  ck('stale chip is prefixed stale', /^stale · built/.test(chip.stale), chip.stale);
  ck('stale renders the past-cadence warning', /past its expected cadence/.test(chip.staleHTML), 'no warning');

  // ---- 3. the pipeline ledger ------------------------------------------
  const led=await p.evaluate(()=>{
    const r={};
    UFC.meta=null; r.none=rsPipelineHTML('ufc');
    UFC.meta={built_at:new Date().toISOString()}; r.noJobs=rsPipelineHTML('ufc');
    UFC.meta={ufcstats_sync_last_run:new Date(Date.now()-3600000).toISOString(),
              ufcstats_sync_last_status:'ok', row_count_ufcstats_sync:'4679'};
    r.ok=rsPipelineHTML('ufc');
    UFC.meta={ufcstats_sync_last_run:new Date(Date.now()-3600000).toISOString(),
              ufcstats_sync_last_status:'error',
              ufc_live_last_run:new Date(Date.now()-60000).toISOString(),
              ufc_live_last_status:'ok'};
    r.bad=rsPipelineHTML('ufc');
    return r;
  });
  ck('no meta -> no ledger block', led.none==='', led.none.slice(0,60));
  ck('meta without job keys -> no ledger block', led.noJobs==='', led.noJobs.slice(0,60));
  ck('a healthy job is listed with its row count', /ufcstats_sync/.test(led.ok)&&/4679 rows written/.test(led.ok)&&/last run ok/.test(led.ok), led.ok.slice(0,200));
  ck('a FAILED job is shown as failed, not hidden', /last run FAILED/.test(led.bad), led.bad.slice(0,200));
  ck('a failure changes the heading', /Pipeline reporting a failure/.test(led.bad), led.bad.slice(0,120));
  ck('a failure explains what the displayed data now is', /whatever the last successful run left behind/.test(led.bad), 'no explanation');
  ck('a healthy job alongside a failed one still shows ok', /ufc_live<\/span> — last run ok/.test(led.bad), led.bad.slice(0,400));

  // ---- 4. hardcoded 4679 must not exist in the app ----------------------
  const hard=await p.evaluate(()=>document.documentElement.innerHTML.indexOf('4679'));
  ck('the fighter count is never hardcoded in the page', hard<0, 'found 4679 at index '+hard);

  // ---- 5. humanised tendency chips -------------------------------------
  const chips=await p.evaluate(()=>{
    UFC.byId={f1:{fighter_id:'f1',s:{primary_style:'Wrestler'},
      d:{finish_rate:0.65,win_streak:16,average_fight_time:671,activity_last365:1}},
      f2:{fighter_id:'f2',d:{finish_rate:0.4,loss_streak:2,average_fight_time:900,activity_last365:3}},
      f3:{fighter_id:'f3'}};
    const strip=h=>h.replace(/<[^>]+>/g,'|').replace(/\|+/g,'|');
    return {a:strip(ufcChips('f1')), b:strip(ufcChips('f2')), c:strip(ufcChips('f3'))};
  });
  ck('finish rate is labelled', /finish rate 65%/.test(chips.a), chips.a);
  ck('win streak reads as a streak', /16-fight win streak/.test(chips.a), chips.a);
  ck('avg fight time keeps its arithmetic and gains a unit', /avg 11 min\/fight/.test(chips.a), chips.a);
  ck('activity is singular for one fight', /1 fight in the last year/.test(chips.a), chips.a);
  ck('activity is plural for three', /3 fights in the last year/.test(chips.b), chips.b);
  ck('a losing streak is named as one', /2-fight losing streak/.test(chips.b), chips.b);
  ck('no shorthand left', !/fin\||W16|11m avg|1\/yr/.test(chips.a), chips.a);
  ck('a fighter with no history still says so', /no DB history/.test(chips.c), chips.c);

  // ---- 6. coverage sentence is computed, not typed ----------------------
  const cov=await p.evaluate(()=>{
    RS_PROBE={};
    const before=RS_DATASETS.ufc.text();
    RS_PROBE={'fighters.dob':'present','fighters.no_contests':'absent',
              'fighter_career_stats.knockdowns':'absent','fighter_career_stats.total_fight_time':'absent'};
    const after=RS_DATASETS.ufc.text();
    const html=rsFieldsHTML('ufc');
    return {before,after,html,cov:JSON.stringify(rsFieldCoverage('ufc'))};
  });
  ck('unprobed coverage says availability is undetermined', /has not been determined yet/.test(cov.before), cov.before);
  ck('probed coverage names the field that IS in the db', /1 more \(dob\) exist/.test(cov.after), cov.after);
  ck('probed coverage names the three that are not', /3 \(record_nc, knockdowns, fight_time\) are absent/.test(cov.after), cov.after);
  ck('the dictionary shows the db verdict per field', /in the database, not read by this app/.test(cov.html)&&/not in the database either/.test(cov.html), 'verdicts missing');
  ck('the dictionary states the fix for each gap', (cov.html.match(/to close it:/g)||[]).length===4, (cov.html.match(/to close it:/g)||[]).length+' fixes');

  // ---- 7. gating language is accurate ----------------------------------
  const gate=await p.evaluate(()=>({
    lim:RESEARCH_MODULES.ufc.limitations().join(' || '),
    shell:ufcLiveShellHTML({event_id:'e',name:'UFC 330',status:'pre',start_time:new Date(Date.now()+86400000).toISOString()},[],'upcoming')
  }));
  ck('model gating names the real reason (no registered model)', /no UFC model is registered/.test(gate.lim), gate.lim);
  ck('CLV gating is separated from model gating', /no closing price is stored per bout/.test(gate.lim), gate.lim);
  ck('consensus is explicitly never called CLV', /[Cc]onsensus is never/.test(gate.lim+gate.shell), 'claim missing');
  ck('the shell no longer claims capture is missing', !/live Pinnacle capture are deployed/.test(gate.shell), 'stale claim still there');

  // ---- 8. mode switch restores the research stamp ----------------------
  const mode=await p.evaluate(async()=>{
    UFC.meta={built_at:new Date(Date.now()-86400000).toISOString()};
    const el=document.getElementById('ufcFresh');
    el.textContent='feed 3 minutes ago';        // what live mode leaves behind
    UFC.mode='live'; await window.ufcSetMode('research');
    return el.textContent;
  });
  ck('leaving live mode repoints the chip at the build time', /^built /.test(mode), mode);


  // ---- 9. the column probe classifies PostgREST's answers correctly -----
  const probe=await p.evaluate(async()=>{
    const mk=(err)=>async()=>{ if(err) throw err; return [{}]; };
    const e400=Object.assign(new Error('db 400'),{status:400,
      body:JSON.stringify({code:'42703',message:'column fighters.dob does not exist'})});
    const e500=Object.assign(new Error('db 500'),{status:500,body:'upstream boom'});
    const e401=Object.assign(new Error('db 401'),{status:401,body:'JWT expired'});
    RS_PROBE={}; const ok   = await rsProbeColumn(mk(null),'fighters','age');
    RS_PROBE={}; const gone = await rsProbeColumn(mk(e400),'fighters','dob');
    RS_PROBE={}; const down = await rsProbeColumn(mk(e500),'fighters','dob');
    RS_PROBE={}; const auth = await rsProbeColumn(mk(e401),'fighters','dob');
    /* an outage must NOT be recorded as "absent" — that would delete a real
       field from the coverage count on a bad network day */
    RS_PROBE={'fighters.dob':'unknown','fighters.no_contests':'unknown',
              'fighter_career_stats.knockdowns':'unknown',
              'fighter_career_stats.total_fight_time':'unknown'};
    const c=rsFieldCoverage('ufc');
    return {ok,gone,down,auth,undet:c.undetermined.length,absent:c.absent.length};
  });
  ck('a readable column probes as present', probe.ok==='present', probe.ok);
  ck('400/42703 probes as absent', probe.gone==='absent', probe.gone);
  ck('a 500 probes as unknown, never absent', probe.down==='unknown', probe.down);
  ck('a 401 probes as unknown, never absent', probe.auth==='unknown', probe.auth);
  ck('unknown counts as undetermined, not as absent', probe.undet===4&&probe.absent===0,
     JSON.stringify(probe));

  console.log(out.join('\n'));
  console.log('\npage errors: '+(errs.length?errs.join(' | '):'none'));
  const f=out.filter(x=>x.startsWith('FAIL')).length;
  console.log(f?('\n'+f+' FAILED'):('\nALL '+out.length+' PASSED'));
  await b.close(); process.exit(f?1:0);
})();
