#!/usr/bin/env node
/* ===========================================================================
   NO PATH AROUND THE ODDS GATEWAY — a static guard over the whole repository.

   2026-10-10 (docs/odds-api-incident-2026-10/INCIDENT.md): six call paths held
   the same The Odds API key, each with a private budget, and spent 99,336 of
   100,000 monthly credits in 9.5 days. The fix is ONE gateway
   (supabase/functions/odds_gateway) that holds the key and dispatches nothing
   without a grant from the shared control plane. This suite fails the build
   the moment a second path appears:

     1  only odds_gateway names the provider's API host;
     2  only odds_gateway reads the provider key, under any of its names;
     3  no workflow hands a runner the provider key;
     4  no browser-facing file calls the gateway or the provider;
     5  every former caller now asks the gateway (and says which category);
     6  the emergency stop's patterns cover every function that can spend;
     7  a reader cannot buy odds: Refresh is never forced, capture's untiered
        call is the day tier, and the props cadence is the gateway's.

   Static, so it runs everywhere, offline. Run: node tools/odds/no_bypass.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const failures = [];
const chk = (name, ok, detail) => { if (ok) pass++; else { fail++; failures.push({ name, detail }); } };
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* every file a deployment or a runner could execute or serve */
const SKIP_DIR = new Set(['.git', 'node_modules', '.cache', 'docs', 'parts']);
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
    const rel = d ? d + '/' + e.name : e.name;
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name) && !/fixtures?$/.test(e.name)) walk(rel); continue; }
    if (!/\.(js|mjs|cjs|ts|html|yml|yaml|sql|sh|py)$/.test(e.name)) continue;
    if (/\.test\.(js|ts|mjs)$|(^|\/)test_[^/]*\.ts$|\.e2e\.js$/.test(rel)) continue;   /* suites mock the provider */
    if (fs.statSync(path.join(ROOT, rel)).size > 8 * 1024 * 1024) continue;
    files.push(rel);
  }
})('');
const GATEWAY = 'supabase/functions/odds_gateway/index.ts';
const text = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };

/* ── 1 · the provider host ──────────────────────────────────────────────── */
const hostHits = files.filter((f) => f !== GATEWAY && /api\.the-odds-api\.com/.test(text(f)));
chk('1 · only odds_gateway names api.the-odds-api.com', hostHits.length === 0, hostHits);
chk('1 · and odds_gateway does', /https:\/\/api\.the-odds-api\.com\/v4/.test(read(GATEWAY)));

/* ── 2 · the key, under every name it has had ───────────────────────────── */
const keyRead = /(Deno\.env\.get|process\.env|envGet|env)\s*(\(\s*["'`]|\.|\[\s*["'`])(ODDS_API_KEY|THE_ODDS_API_KEY|ODDS_GATEWAY_PROVIDER_KEY)\b/;
const keyHits = files.filter((f) => f !== GATEWAY && keyRead.test(text(f)));
chk('2 · only odds_gateway reads ODDS_API_KEY / THE_ODDS_API_KEY / ODDS_GATEWAY_PROVIDER_KEY', keyHits.length === 0, keyHits);
chk('2 · no file builds an apiKey= query outside the gateway',
  files.filter((f) => f !== GATEWAY && /[?&]apiKey=\$\{|[?&]apiKey='\s*\+|searchParams\.set\(\s*["']apiKey["']/.test(text(f))).length === 0,
  files.filter((f) => f !== GATEWAY && /[?&]apiKey=\$\{|[?&]apiKey='\s*\+|searchParams\.set\(\s*["']apiKey["']/.test(text(f))));

/* ── 3 · no runner holds the key ────────────────────────────────────────── */
const wf = fs.readdirSync(path.join(ROOT, '.github', 'workflows')).filter((f) => /\.ya?ml$/.test(f));
const wfHits = wf.filter((f) => /secrets\.(ODDS_API_KEY|THE_ODDS_API_KEY|ODDS_GATEWAY_PROVIDER_KEY)\b/.test(read('.github/workflows/' + f)));
chk('3 · no workflow maps the provider key into a runner', wfHits.length === 0, wfHits);
chk('3 · the capture backup scheduler never retries a capture (curl --retry re-ran whole captures after a 504)',
  !read('.github/workflows/capture.yml').split('\n').some((l) => !/^\s*#/.test(l) && /--retry\b/.test(l)));

/* ── 4 · browsers never reach the gateway or the provider ───────────────── */
const browser = files.filter((f) => /\.html$/.test(f) || /^(lib|collective|admin|research|today|games|record)\//.test(f) && /\.(js|html)$/.test(f));
const browserHits = browser.filter((f) => /functions\/v1\/odds_gateway|api\.the-odds-api\.com/.test(text(f)));
chk('4 · no browser-facing file calls odds_gateway or the provider', browserHits.length === 0, browserHits);
chk('4 · the browser reads the feed state through the public odds_feed_status RPC only', /rpc\/odds_feed_status/.test(read('app.html')));

/* ── 5 · every former caller asks the gateway ───────────────────────────── */
const callers = {
  'supabase/functions/capture/index.ts': /\/functions\/v1\/odds_gateway/,
  'supabase/functions/close/index.ts': /category: "close"/,
  'supabase/functions/collective_odds_ingest/index.ts': /category: "collective"/,
  'football/props/capture.js': /category: 'events_index'/,
  'football/cfb_terminal/alternates.js': /category: 'alternates'/,
  'football/props/factory/odds.js': /'historical_props'/,
};
Object.keys(callers).forEach((f) => chk('5 · ' + f + ' asks the gateway', callers[f].test(read(f)) && /odds_gateway/.test(read(f))));
chk('5 · the Node jobs share ONE gateway client', ['football/props/capture.js', 'football/cfb_terminal/alternates.js', 'football/props/factory/odds.js']
  .every((f) => /tools['\/,\s]+lib['\/,\s]+odds_gateway\.js|tools\/lib\/odds_gateway\.js/.test(read(f)) || /'tools', 'lib', 'odds_gateway\.js'/.test(read(f))));
chk('5 · the enrichment build never calls the provider (it reads captured quotes)', !/fetch\(|http\(/.test((read('football/enrichment/providers/market.js').split('const oddsApi')[1] || '').split('const linesArchive')[0]));

/* ── 6 · the emergency stop covers every spender ────────────────────────── */
const STOP = read('supabase/odds_api_emergency_stop.sql');
['capture', 'close', 'collective_odds_ingest', 'props_cron'].forEach((fn) => chk('6 · the emergency stop pauses jobs that call ' + fn, STOP.indexOf("'%/functions/v1/" + fn) >= 0));
const deployedOnly = (read('tools/supabase/download_functions.sh').match(/\b(odds|wta_odds|wta_close|cfb_close|close_backfill|capture_boards|model_conf_odds|ingest_multisport|run_slate|scores_diag)\b/g) || []);
chk('6 · and every deployed-but-unexported odds function the repo knows of', [...new Set(deployedOnly)].every((fn) => STOP.indexOf('/functions/v1/' + fn) >= 0), [...new Set(deployedOnly)]);

/* ── 7 · a reader cannot buy odds ───────────────────────────────────────── */
const PC = read('supabase/functions/props_cron/index.ts');
chk('7 · a reader\'s Refresh never dispatches a FORCED capture', !/force_capture: 'true'/.test(PC) && /force_capture: 'false'/.test(PC));
chk('7 · and is answered from the feed state while the breaker is off', /provider_paused/.test(PC) && /rpc\/odds_feed_status/.test(PC));
const CAP = read('supabase/functions/capture/index.ts');
chk('7 · an untiered capture call (the desk\'s quote refresh) is the DAY tier, narrowed to its sport', /applyCadenceTier\(baseCfg, params\.tier \|\| "day"\)/.test(CAP) && /onlySport/.test(CAP));
chk('7 · capture\'s own prop pass is off by default (the GitHub pipeline is the single prop buyer)', /bool\("CAPTURE_PLAYER_PROPS", false\)/.test(CAP));
const EDP = require(path.join(ROOT, 'lib', 'edgedesk_props.js'));
chk('7 · the props cadence is the gateway\'s: hourly inside 3 h, 2 h inside 24 h, 6 h beyond',
  JSON.stringify(EDP.FRESHNESS.cadence) === JSON.stringify([{ within_h: 3, every_min: 60 }, { within_h: 24, every_min: 120 }, { within_h: null, every_min: 360 }]), EDP.FRESHNESS.cadence);
const PCFG = require(path.join(ROOT, 'football', 'props', 'config.js'));
chk('7 · the prop capture asks for the core markets only by default', JSON.stringify(PCFG.DEFAULT_GROUPS) === JSON.stringify({ nfl: ['core'], cfb: ['core'] }));

failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 500) : '')));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'no path around the odds gateway — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
