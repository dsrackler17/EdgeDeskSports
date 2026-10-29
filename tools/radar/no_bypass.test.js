#!/usr/bin/env node
/* ===========================================================================
   EVERY RADAR REQUEST TO POLYMARKET GOES THROUGH THE RADAR GATEWAY.

   tools/odds/no_bypass.test.js's rule for The Odds API, applied to
   Polymarket's public hosts (data-api, gamma-api, clob, and the live
   stream ws-live-data, which Radar does not use in v1):

     1 only lib/edgedesk_poly_gateway.js names them, and its verbatim copy in
       supabase/functions/polymarket_sync (between its RADAR GATEWAY markers)
     2 the P&L and rankings hosts are named nowhere in Radar: they carry no
       stability guarantee, so Radar computes P&L itself from trades
     3 no browser-facing Radar file calls Polymarket or polymarket_sync
     4 every Radar runner (the probe, the H-RADAR-01 runner, the job) asks the
       gateway

   PRE-EXISTING, OUTSIDE RADAR, AND LISTED BY NAME: the Portfolio's
   connector reads a reader's OWN public wallet (lib/edgedesk_portfolio_
   connect_core.js, its inlined copy in supabase/functions/portfolio_connect,
   and the SharpSports webhook's platform list). It predates Radar, it is not
   a Radar request, and moving it behind this gateway is its own change
   (docs/prediction-radar.md, open items). Any OTHER file that names a host
   fails this suite.

   Static, offline. Run: node tools/radar/no_bypass.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const failures = [];
const chk = (name, ok, detail) => { if (ok) pass++; else { fail++; failures.push({ name, detail }); } };
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const SKIP_DIR = new Set(['.git', 'node_modules', '.cache', 'docs', 'parts', 'out']);
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(path.join(ROOT, d || '.'), { withFileTypes: true })) {
    const rel = d ? d + '/' + e.name : e.name;
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name) && !/fixtures?$/.test(e.name)) walk(rel); continue; }
    if (!/\.(js|mjs|cjs|ts|html|yml|yaml|sql|sh|py)$/.test(e.name)) continue;
    if (/\.test\.(js|ts|mjs)$|\.e2e\.js$/.test(rel)) continue;
    if (fs.statSync(path.join(ROOT, rel)).size > 8 * 1024 * 1024) continue;
    files.push(rel);
  }
})('');
const HOST = /(data-api|gamma-api|clob|ws-live-data)\.polymarket\.com/;
const GATEWAY = 'lib/edgedesk_poly_gateway.js', FN = 'supabase/functions/polymarket_sync/index.ts';
const PORTFOLIO = ['lib/edgedesk_portfolio_connect_core.js', 'supabase/functions/portfolio_connect/index.ts', 'supabase/functions/sharpsports-webhook/index.ts'];
const GW_BLOCK = /\/\/ ── BEGIN RADAR GATEWAY[^\n]*\n[\s\S]*?\/\/ ── END RADAR GATEWAY ──/;
const text = (f) => { try { return read(f); } catch (_) { return ''; } };
const scan = (f) => (f === FN ? text(f).replace(GW_BLOCK, '') : text(f));

/* 1 */
const hits = files.filter((f) => f !== GATEWAY && PORTFOLIO.indexOf(f) < 0 && HOST.test(scan(f)));
chk('1 · only the Radar gateway names a Polymarket host (the Portfolio\'s own-wallet connector excepted, by name)', hits.length === 0, hits);
chk('1 · and the gateway does, for data-api, gamma-api and clob', /https:\/\/data-api\.polymarket\.com/.test(read(GATEWAY)) && /https:\/\/gamma-api\.polymarket\.com/.test(read(GATEWAY)) && /https:\/\/clob\.polymarket\.com/.test(read(GATEWAY)));
chk('1 · polymarket_sync carries the gateway only inside its markers', GW_BLOCK.test(text(FN)) && !HOST.test(scan(FN)));
chk('1 · the Portfolio exception is still where it says (else remove it from this list)', PORTFOLIO.every((f) => fs.existsSync(path.join(ROOT, f))));

/* 2 */
const RADAR = files.filter((f) => /radar|poly_gateway|polymarket_sync/.test(f));
chk('2 · Radar names no P&L or rankings host', RADAR.filter((f) => /(pnl|user-pnl|rankings?)[-.]api\.polymarket|lb-api\.polymarket/.test(text(f))).length === 0);
chk('2 · (the scan found the Radar files)', RADAR.indexOf(GATEWAY) >= 0 && RADAR.indexOf(FN) >= 0 && RADAR.indexOf('research/radar/run_validation.js') >= 0, RADAR);

/* 3 */
const browser = files.filter((f) => /\.html$/.test(f) || (/^(lib|radar|admin|research|today|performance)\//.test(f) && /\.(js|html)$/.test(f) && f !== GATEWAY && f !== 'lib/edgedesk_radar.js' && !/^research\/radar\//.test(f)));
const bHits = browser.filter((f) => /functions\/v1\/polymarket_sync/.test(text(f)) || (HOST.test(text(f)) && PORTFOLIO.indexOf(f) < 0));
chk('3 · no browser-facing file calls Polymarket or polymarket_sync', bHits.length === 0, bHits);
chk('3 · the grading core names no host (it is loaded by pages)', !HOST.test(read('lib/edgedesk_radar.js')));

/* 4 */
for (const f of ['tools/radar/fetch_sources.js', 'research/radar/run_validation.js']) {
  chk('4 · ' + f + ' asks the gateway', /edgedesk_poly_gateway\.js/.test(read(f)) && /\.get\(/.test(read(f)) && !/\bfetch\(/.test(read(f)));
}
chk('4 · polymarket_sync calls Polymarket only through ctx.gw', !/fetch\([^)]*polymarket/i.test(scan(FN)) && /ctx\.gw\.get\(/.test(read(FN)));

failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 600) : '')));
console.log((fail ? 'FAILED' : 'ALL GREEN') + ' radar no-bypass — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
