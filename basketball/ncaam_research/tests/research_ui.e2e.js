#!/usr/bin/env node
'use strict';
/* ===========================================================================
   The research pages in a real browser, on the committed published data.

   Every view renders without a script error: teams, a team (ratings, why
   they are good, style, players, scenarios, lineups, games), a player, the
   matchup tool (any two teams, no market), the as-of pregame reports, the
   2026-27 openers, validation, data and method. The scenario control changes
   the team's net rating; the pricing section says "market comparison
   unavailable" while every research section is present; a phone-width
   viewport has no horizontal page scroll.

   Run: node basketball/ncaam_research/tests/research_ui.e2e.js   (SHOTS=dir to save screenshots)
   =========================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
let pass = 0; let fail = 0;
function ok(name, cond, detail) { if (cond) { pass++; return; } fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); }

(async function main() {
  let pw = null;
  try { pw = require('playwright'); } catch (_) { for (const p of ['/opt/node22/lib/node_modules/playwright', '/opt/node-tools/node_modules/playwright']) { try { pw = require(p); break; } catch (e) { /* next */ } } }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const p = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(fs.readFileSync(file));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = 'http://127.0.0.1:' + srv.address().port + '/research/ncaam/index.html';
  let browser;
  try { browser = await pw.chromium.launch({ headless: true }); } catch (e) {
    const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].find((x) => fs.existsSync(x));
    if (!exe) { console.log('SKIPPED: no Chromium'); srv.close(); process.exit(0); }
    browser = await pw.chromium.launch({ headless: true, executablePath: exe });
  }
  const shots = process.env.SHOTS; if (shots) fs.mkdirSync(shots, { recursive: true });
  const errors = [];
  async function page(viewport) {
    const ctx = await browser.newContext({ viewport });
    await ctx.route('**/*', (route) => (route.request().url().startsWith('http://127.0.0.1') ? route.continue() : route.abort()));
    const pg = await ctx.newPage();
    pg.on('pageerror', (e) => errors.push(String(e)));
    pg.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    return pg;
  }
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'basketball/ncaam_research/published/index.json'), 'utf8'));
  const top = idx.teams[0]; const second = idx.teams[1];
  const pg = await page({ width: 1280, height: 900 });
  const go = async (hash, waitFor) => { await pg.goto(base + hash); await pg.waitForSelector(waitFor, { timeout: 20000 }); if (shots) await pg.screenshot({ path: path.join(shots, (hash.replace(/[^a-z0-9]+/gi, '_') || 'teams') + '.png'), fullPage: true }); };

  await go('#/', '#tt table');
  ok('teams view lists every D1 team', (await pg.$$eval('#tt tbody tr', (r) => r.length)) === idx.teams.length);
  ok('model status chips are shown', (await pg.textContent('#view')).includes('Team model: VALIDATED'));
  ok('freshness strip names the data date', (await pg.textContent('#fresh')).includes(idx.data_through.slice(0, 10)));
  await pg.fill('#q', top.short.slice(0, 5)); ok('search filters the table', (await pg.$$eval('#tt tbody tr', (r) => r.length)) < idx.teams.length);

  await go('#/team/' + top.id, '#scen table');
  const tv = await pg.textContent('#view');
  ok('team page has ratings, explanation, style, players, scenarios, lineups and games', ['Net rating', 'What makes them effective', 'Style and skill profile', 'Who makes them good', 'Availability and minutes scenarios', 'Lineups', 'Games, with what the model said before tip'].every((s) => tv.includes(s)));
  ok('descriptive, estimated and conditional labels are distinct', tv.includes('DESCRIPTIVE') && tv.includes('ESTIMATED') && tv.includes('CONDITIONAL'));
  await pg.check('[data-out="0"]');
  ok('marking the top rotation player out changes the net rating (conditional)', /Conditional change in net rating: [−-]/.test(await pg.textContent('#scenout')), await pg.textContent('#scenout'));

  const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'basketball/ncaam_research/published/teams/' + top.id + '.json'), 'utf8'));
  const pl = doc.players[0];
  await go('#/player/' + top.id + '/' + pl.id, '.kv');
  const pv = await pg.textContent('#view');
  ok('player page separates impact, raw on/off, role evidence and minutes', ['Impact per 100', 'Raw on/off', 'Usage and efficiency', 'Minutes and participation'].every((s) => pv.includes(s)) && pv.includes(pl.name));

  await go('#/matchup?h=' + top.id + '&a=' + second.id + '&n=1', '#mrep .tile');
  const mv = await pg.textContent('#mrep');
  ok('matchup report covers baseline, both directions, players, conditions and assumptions', ['Baseline strength', 'offense vs', 'players who matter most', 'What would change the projection', 'Assumptions'].every((s) => mv.includes(s)));
  ok('without odds only the pricing section is empty', mv.includes('MARKET COMPARISON UNAVAILABLE') && mv.includes('Projected score'));

  await go('#/reports', '#view table');
  ok('pregame reports are listed', (await pg.$$eval('#view tbody tr', (r) => r.length)) === idx.matchups.length);
  await go('#/report/' + idx.matchups[0].file.replace('matchups/', '').replace('.json', ''), '.tile');
  ok('an as-of report shows its result after the fact', (await pg.textContent('#view')).includes('Result (after the report)'));
  await go('#/upcoming', '#view table');
  ok('openers carry the carry-forward warning', (await pg.textContent('#view')).includes('Preseason carry-forward'));
  await go('#/validation', 'svg');
  const vv = await pg.textContent('#view');
  ok('validation shows holdout, baselines, player layer, lineups and interactions', ['Holdout: 2025-26', 'Incumbent EdgeDesk points model', 'Does the player layer add anything?', 'Style interaction'].every((s) => vv.includes(s)));
  await go('#/data', '#view table'); ok('data view shows the quarantine and provenance', (await pg.textContent('#view')).includes('Publisher lineup table quarantined') && (await pg.textContent('#view')).includes('Provenance'));
  await go('#/method', '.card'); ok('method view separates public, chosen and unknown', (await pg.textContent('#view')).includes('Unknown'));

  const phone = await page({ width: 390, height: 844 });
  for (const h of ['#/', '#/team/' + top.id]) {
    await phone.goto(base + h); await phone.waitForSelector('#view table', { timeout: 20000 });
    const over = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok('no horizontal page scroll at phone width: ' + h, over <= 1, over);
  }
  ok('no script errors on any view', errors.length === 0, errors.slice(0, 5));
  await browser.close(); srv.close();
  console.log(fail ? `${fail} FAILED, ${pass} passed` : `ALL GREEN (${pass} checks)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
