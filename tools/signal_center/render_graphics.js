#!/usr/bin/env node
/* ===========================================================================
   SIGNAL CENTER GRAPHICS — draw signal graphics as PNG files, with the
   browser's own renderer, and inspect every one.

   The same code the reader's page runs (lib/edgedesk_game_graphic.js and
   lib/edgedesk_signal_graphic.js) in headless Chromium, exactly as
   tools/football/render_game_graphics.js draws matchup graphics. Nothing is
   uploaded and nothing is posted anywhere: files land in --out.

   Each PNG is inspected in the page before it is written:
     metrics   the layout is re-run with the canvas's REAL font metrics and
               EDSignalGraphic.check() must find no text outside the canvas,
               outside its box or below 9 px
     pixels    the canvas is the format's size; the backdrop, the header and
               the RESEARCH NOT PICKS. pill are painted (sampled pixels); a
               stamped graphic carries its band
   and the result is written to <out>/inspection.json.

     node tools/signal_center/render_graphics.js                 every eligible signal the
                                                                  committed sources give today
     node tools/signal_center/render_graphics.js --payloads f.json   payloads from a file
                                                                  (a dry run's run.json)
     --formats square,landscape,portrait   --limit 12   --stamp OUTDATED|WITHDRAWN
     --recap                                the weekly recap too
     --out .cache/signal_graphics           where the PNGs go
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..', '..');
const SG = require(path.join(ROOT, 'lib', 'edgedesk_signal_graphic.js'));

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }
const flag = (n) => process.argv.indexOf('--' + n) > 0;

function loadPlaywright() {
  for (const p of ['playwright', '/opt/node22/lib/node_modules/playwright', '/opt/node-tools/node_modules/playwright']) { try { return require(p); } catch (_) { /* next */ } }
  return null;
}
function serve() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    if (u === '/__signal_render.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><meta charset="utf-8">'
        + '<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@0,600;0,700;0,800;1,800&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">'
        + '<script src="/lib/edgedesk_calc.js"></script><script src="/lib/edgedesk_game_graphic.js"></script><script src="/lib/edgedesk_signal_engine.js"></script><script src="/lib/edgedesk_signal_graphic.js"></script>'
        + '</head><body style="background:#000"></body></html>');
      return;
    }
    const f = path.join(ROOT, u.endsWith('/') ? u + 'index.html' : u);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

/* the payloads: a file, or one evaluation of the committed sources now */
function payloads() {
  const f = arg('payloads', null);
  if (f) { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(j) ? j : (j.signals || j.payloads || []); }
  const S = require('./sources.js'), { evaluate } = require('./evaluate.js');
  const football = S.footballGames(), au = S.audits();
  return evaluate({ football, footballCurrent: S.footballCurrent(), perfGames: S.perfForecastGames(), perfLastCapture: au.perf && au.perf.ledger ? au.perf.ledger.last_capture_at : null,
    quotes: S.perfQuotes(), slateTeams: S.slateTeams(), audits: au, cfbAvailability: S.cfbAvailability(null, football), sourceStates: S.sourceStates(null), now: Date.now() }).signals;
}

/* in the page: draw, re-check with real metrics, sample pixels */
async function drawOne(page, content, format, stamp) {
  return page.evaluate(async ({ content, format, stamp }) => {
    const SG = window.EDSignalGraphic, G = window.EDGameGraphic;
    const fontsLoaded = await G.fontsReady(4000);
    const r = await SG.render(content, format, { stamp: stamp || null, fresh: true });
    const cv = r.canvas, g = cv.getContext('2d');
    const L = SG.layout(Object.assign({}, content, stamp ? { stamp } : {}), format, G.measureWith(cv));
    const problems = SG.check(L);
    const px = (x, y) => Array.from(g.getImageData(Math.round(x), Math.round(y), 1, 1).data);
    const W = cv.width, H = cv.height, F = SG.FORMATS[format];
    const bright = (p) => p[0] + p[1] + p[2] > 300;
    const goldish = (p) => p[0] > 200 && p[1] > 150 && p[2] < 120;
    /* the pill's fill, the header's top band, the backdrop's corners */
    const pill = px(W - 24 - 20, SG.GEO[format].footer - 16), corner = px(W / 2, H - 4), head = px(W / 2, 30);
    let lit = 0, n = 0;
    for (let y = 0; y < H; y += 9) for (let x = 0; x < W; x += 9) { const p = px(x, y); n++; if (bright(p)) lit++; }
    const stampOk = !stamp || (() => { const p = px(12, Math.round(H * 0.44) + 40); return p[0] > 100 && p[2] < 90; })();
    return { url: cv.toDataURL('image/png'), width: W, height: H, size_ok: W === F.w && H === F.h, fonts_loaded: fontsLoaded, problems,
      pill_painted: goldish(pill), backdrop_painted: corner[3] === 255 && corner[0] + corner[1] + corner[2] < 200, header_painted: head[3] === 255,
      lit_share: Math.round(1000 * lit / n) / 1000, stamp_band: stampOk, alt: r.alt, file_name: r.file_name, text_ops: L.ops.filter((o) => o.type === 'text').length };
  }, { content, format, stamp });
}

async function main() {
  const pw = loadPlaywright();
  if (!pw) { console.error('Playwright is not installed: npm install --no-save playwright && npx playwright install chromium'); process.exit(1); }
  const out = path.resolve(arg('out', path.join(ROOT, '.cache', 'signal_graphics')));
  const formats = arg('formats', 'square,landscape,portrait').split(',').filter((f) => SG.FORMATS[f]);
  const limit = +arg('limit', '0') || 0, stamp = arg('stamp', null);
  const all = payloads();
  /* one of each template first, then the rest by score */
  const ok = all.map((p) => ({ p, c: SG.content(p, { version: p.version || 1 }) })).filter((x) => x.c.ok);
  const byKind = {};
  ok.sort((a, b) => b.p.score.total - a.p.score.total).forEach((x) => { (byKind[x.c.content.kind] = byKind[x.c.content.kind] || []).push(x); });
  const order = [];
  const kinds = Object.keys(byKind);
  for (let i = 0; order.length < ok.length; i++) kinds.forEach((k) => { if (byKind[k][i]) order.push(byKind[k][i]); });
  const todo = limit ? order.slice(0, limit) : order;
  if (flag('recap')) { const rc = SG.recap(all, { from: new Date(Date.now() - 7 * 86400e3).toISOString(), to: new Date().toISOString(), now: new Date().toISOString() }); if (rc.ok) todo.push({ p: null, c: rc }); }
  fs.mkdirSync(out, { recursive: true });
  console.log(all.length + ' payloads, ' + ok.length + ' with a template, drawing ' + todo.length + ' × ' + formats.length + ' formats into ' + path.relative(process.cwd(), out));
  const srv = await serve();
  const launch = { headless: true };
  if (process.env.HTTPS_PROXY) launch.args = ['--proxy-server=' + process.env.HTTPS_PROXY, '--proxy-bypass-list=127.0.0.1;localhost'];
  let browser;
  try { browser = await pw.chromium.launch(launch); }
  catch (_) { browser = await pw.chromium.launch(Object.assign({}, launch, { executablePath: '/opt/pw-browsers/chromium' })); }
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:' + srv.address().port + '/__signal_render.html');
  await page.waitForFunction(() => window.EDSignalGraphic && window.EDGameGraphic && window.EDGameGraphic.LAYOUTS.signal_v1);
  const report = { generated_at: new Date().toISOString(), formats, stamp, items: [] };
  let failed = 0;
  for (const t of todo) {
    for (const f of formats) {
      const r = await drawOne(page, t.c.content, f, stamp);
      const file = path.join(out, r.file_name.replace(/\.png$/, '') + (stamp ? '-' + stamp.toLowerCase() : '') + '.png');
      fs.writeFileSync(file, Buffer.from(r.url.split(',')[1], 'base64'));
      const pass = r.size_ok && r.problems.length === 0 && r.pill_painted && r.backdrop_painted && r.header_painted && r.stamp_band;
      if (!pass) failed++;
      delete r.url;
      report.items.push(Object.assign({ file: path.relative(ROOT, file), kind: t.c.content.kind, category: t.c.content.category, signal_key: t.c.content.signal_key || null, format: f, pass }, r));
      console.log((pass ? '  ok   ' : '  FAIL ') + path.relative(process.cwd(), file) + (r.problems.length ? '  ' + JSON.stringify(r.problems.slice(0, 2)) : '') + (r.fonts_loaded ? '' : '  (fallback fonts)'));
    }
  }
  report.summary = { drawn: report.items.length, failed, fonts_loaded: report.items.every((i) => i.fonts_loaded) };
  fs.writeFileSync(path.join(out, 'inspection.json'), JSON.stringify(report, null, 1));
  await browser.close();
  srv.close();
  console.log(report.items.length + ' graphics drawn, ' + failed + ' failed inspection' + (report.summary.fonts_loaded ? '' : ' (some drew with fallback fonts: the web fonts were unreachable)'));
  if (failed) process.exit(1);
}
if (require.main === module) main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
module.exports = { drawOne, serve, loadPlaywright };
