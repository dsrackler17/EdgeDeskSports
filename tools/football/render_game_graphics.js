#!/usr/bin/env node
/* ===========================================================================
   BATCH-EXPORT THE MATCHUP GRAPHICS — the same renderer the research page
   uses (lib/edgedesk_game_graphic.js), run in headless Chromium, written as
   PNG files for the owner's social posts. docs/game-research/README.md

   No sportsbook strip: the committed snapshot carries no sportsbook price,
   and this tool never makes one up. KALSHI is drawn where Kalshi has a
   trusted price: public.kalshi_card_current is read once with the public key
   the site ships (as anon: Kalshi's prices, no book fair), and each row is
   placed on the game's teams by EDGameSnapshot.kalshi, exactly as the
   research page does. A read that fails draws the model-only graphics and
   says so; --no-kalshi skips the read. A file is named by its snapshot id
   (and the Kalshi snapshot it shows), so a graphic that already exists is
   never drawn again.

   Run:
     node tools/football/render_game_graphics.js                 every pregame game, square
     node tools/football/render_game_graphics.js --league cfb --format both
     node tools/football/render_game_graphics.js --games cfb|401856809,nfl|2026_06_HOU_JAX
     node tools/football/render_game_graphics.js --out ~/Desktop/edgedesk --week 7
     node tools/football/render_game_graphics.js --no-kalshi       model only, no network
   Output: .cache/game_graphics/ by default (ignored by git).
   Env: EDGEDESK_SUPABASE_URL, SUPABASE_ANON_KEY override the site's own.
   Needs Playwright with Chromium (npm install --no-save playwright).
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..', '..');
const GS = require(path.join(ROOT, 'lib', 'edgedesk_game_snapshot.js'));
const SB_URL = (process.env.EDGEDESK_SUPABASE_URL || 'https://iattxbkbufslbauoumga.supabase.co').replace(/\/$/, '');
/* the same public-safe anon key app.html ships to every browser */
const ANON = process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhdHR4YmtidWZzbGJhdW91bWdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2MzY4MDUsImV4cCI6MjA5NzIxMjgwNX0.Mly5G587o5IFRnEigU2wRp9buWEk3dFwH9RNPJK7Uo8';

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : def; }
/* Kalshi's rows for every linked game from a day ago on, keyed sport|game_id; null when the read failed */
async function kalshiRows() {
  const from = new Date(Date.now() - 864e5).toISOString();
  try {
    const r = await fetch(SB_URL + '/rest/v1/kalshi_card_current?select=*&kickoff_at=gte.' + encodeURIComponent(from) + '&order=kickoff_at.asc,market_ticker.asc&limit=2000',
      { headers: { apikey: ANON, authorization: 'Bearer ' + ANON } });
    if (!r.ok) throw new Error('HTTP ' + r.status + (r.status === 404 ? ' (the Kalshi layer is not deployed)' : ''));
    const by = {};
    (await r.json()).forEach((x) => { if (x.game_id != null) (by[x.sport + '|' + x.game_id] = by[x.sport + '|' + x.game_id] || []).push(x); });
    return by;
  } catch (e) {
    console.warn('Kalshi prices could not be read (' + (e && e.message || e) + '): drawing without them');
    return null;
  }
}
/* the Kalshi snapshot a file shows, for its name: a new price is a new file */
function kalshiTag(k) { return k && k.state === 'OK' ? '__kalshi-' + (k.close ? 'close-' : '') + String(k.snapshot_at || '').replace(/[^0-9T]/g, '').slice(0, 13) : ''; }
function loadPlaywright() {
  for (const p of ['playwright', '/opt/node22/lib/node_modules/playwright', '/opt/node-tools/node_modules/playwright']) { try { return require(p); } catch (_) { /* next */ } }
  return null;
}
function serve() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    if (u === '/__render.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><meta charset="utf-8">'
        + '<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@0,600;0,700;0,800;1,800&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">'
        + '<script src="/lib/edgedesk_calc.js"></script><script src="/lib/edgedesk_football_lines.js"></script><script src="/lib/football_identity.js"></script><script src="/lib/edgedesk_game_snapshot.js"></script><script src="/lib/edgedesk_game_graphic.js"></script>'
        + '</head><body style="background:#000"></body></html>');
      return;
    }
    const f = path.join(ROOT, u);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

async function main() {
  const pw = loadPlaywright();
  if (!pw) { console.error('Playwright is not installed: npm install --no-save playwright && npx playwright install chromium'); process.exit(1); }
  const cur = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'game_research', 'current.json'), 'utf8'));
  const out = path.resolve(arg('out', path.join(ROOT, '.cache', 'game_graphics')));
  const fmt = arg('format', 'square'), formats = fmt === 'both' ? ['square', 'portrait'] : [fmt];
  const only = arg('games', null), league = arg('league', null), week = arg('week', null);
  let games = cur.games.filter((g) => !g.started && g.model.available);
  if (only) { const want = only.split(','); games = cur.games.filter((g) => want.indexOf(g.game_key) >= 0); }
  if (league) games = games.filter((g) => g.league === league);
  if (week) games = games.filter((g) => String(g.week) === String(week));
  fs.mkdirSync(out, { recursive: true });
  const kRows = process.argv.indexOf('--no-kalshi') >= 0 || !games.length ? null : await kalshiRows();
  const todo = [];
  let priced = 0;
  games.forEach((g) => {
    /* placed in Node, as the page places them: the browser receives the finished block */
    const k = kRows ? GS.kalshi({ state: 'ok', rows: kRows[g.game_key] || [] }, g) : null;
    if (k && k.state === 'OK') priced++;
    formats.forEach((f) => {
      const file = path.join(out, g.game_key.replace(/[^a-z0-9_-]+/gi, '_') + '__' + g.snapshot_id + kalshiTag(k) + '__' + f + '.png');
      if (!fs.existsSync(file)) todo.push({ g, f, file, k: k && k.state === 'OK' ? k : null });
    });
  });
  console.log(games.length + ' games' + (kRows ? ', ' + priced + ' with a Kalshi price' : '') + ', ' + todo.length + ' graphics to draw (' + (games.length * formats.length - todo.length) + ' already on disk)');
  if (!todo.length) return;
  const srv = await serve();
  const port = srv.address().port;
  const launch = { headless: true };
  /* behind an egress proxy (the fonts come from Google), keep the local
     server off it: Playwright's own proxy option proxies loopback too */
  if (process.env.HTTPS_PROXY) launch.args = ['--proxy-server=' + process.env.HTTPS_PROXY, '--proxy-bypass-list=127.0.0.1;localhost'];
  let browser;
  try { browser = await pw.chromium.launch(launch); }
  catch (_) { browser = await pw.chromium.launch(Object.assign({}, launch, { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })); }
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:' + port + '/__render.html');
  await page.waitForFunction(() => window.EDGameGraphic && window.EDGameSnapshot);
  for (const t of todo) {
    const url = await page.evaluate(async ({ g, f, k }) => {
      const spec = window.EDGameSnapshot.graphicSpec(g);
      const r = await window.EDGameGraphic.render(spec, null, f, { now: Date.parse(g.generated_at), kalshi: k });
      return r.canvas.toDataURL('image/png');
    }, { g: t.g, f: t.f, k: t.k });
    fs.writeFileSync(t.file, Buffer.from(url.split(',')[1], 'base64'));
    console.log('  ' + path.relative(process.cwd(), t.file));
  }
  await browser.close();
  srv.close();
}
main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
