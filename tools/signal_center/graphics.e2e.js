#!/usr/bin/env node
/* ===========================================================================
   Signal Center graphics in a real browser: every template, every format,
   drawn by the renderer the reader's page runs, then inspected as an image.

     node tools/signal_center/graphics.e2e.js     (Playwright + Chromium; skips without)

     metrics   the layout re-run with Chromium's real font metrics: no text
               outside the canvas or its box, nothing under 9 px
     pixels    1080×1080 / 1200×675 / 1080×1350; the backdrop, the header and
               the RESEARCH NOT PICKS. pill are painted; a stamped graphic
               carries its band
     png       the bytes are a PNG of the format's exact size (IHDR)
     cache     a stamped and an unstamped drawing of one signal are different
               images, and the same drawing twice is identical
   =========================================================================== */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const PG = require(path.join(ROOT, 'tools', 'personal', '_pg.js'));
const SG = require(path.join(ROOT, 'lib', 'edgedesk_signal_graphic.js'));
const { drawOne, serve, loadPlaywright } = require('./render_graphics.js');
const T = PG.kit('signal center graphics (browser)');
const chk = T.chk;

(async () => {
  const pw = loadPlaywright();
  if (!pw) { console.log('NOTE | Playwright is not installed: the browser suite did not run'); process.exit(process.env.SC_E2E_REQUIRED === '1' ? 1 : T.done()); }
  /* the controlled payloads of the offline suite, written by that suite */
  const fx = path.join(os.tmpdir(), 'sc_graphics_fixtures_' + process.pid + '.json');
  cp.execFileSync(process.execPath, [path.join(__dirname, 'graphics.test.js')], { env: Object.assign({}, process.env, { SC_GRAPHICS_FIXTURES_OUT: fx }), stdio: 'ignore' });
  const payloads = JSON.parse(fs.readFileSync(fx, 'utf8'));
  fs.unlinkSync(fx);
  const contents = payloads.map((p) => SG.content(p, { version: 1 })).filter((r) => r.ok).map((r) => r.content);
  const rc = SG.recap(payloads, { from: '2026-10-16T00:00:00Z', to: '2026-10-23T20:30:00Z', now: '2026-10-23T20:30:00Z' });
  if (rc.ok) contents.push(rc.content);
  chk('every template is represented', ['probability_shift', 'market_disagreement', 'injury_impact', 'simulator_movement', 'reliability_alert', 'weekly_recap'].every((k) => contents.some((c) => c.kind === k)));

  const srv = await serve();
  const launch = { headless: true };
  if (process.env.HTTPS_PROXY) launch.args = ['--proxy-server=' + process.env.HTTPS_PROXY, '--proxy-bypass-list=127.0.0.1;localhost'];
  let browser;
  try { browser = await pw.chromium.launch(launch); } catch (_) { browser = await pw.chromium.launch(Object.assign({}, launch, { executablePath: '/opt/pw-browsers/chromium' })); }
  try {
    const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto('http://127.0.0.1:' + srv.address().port + '/__signal_render.html');
    await page.waitForFunction(() => window.EDSignalGraphic && window.EDGameGraphic && window.EDGameGraphic.LAYOUTS.signal_v1);
    let fontsAll = true;
    for (const c of contents) {
      for (const f of Object.keys(SG.FORMATS)) {
        const r = await drawOne(page, c, f, null);
        fontsAll = fontsAll && r.fonts_loaded;
        const tag = c.kind + ' ' + f;
        chk(tag + ': the format’s exact size', r.size_ok, [r.width, r.height]);
        chk(tag + ': real font metrics, every text inside the canvas and its box', r.problems.length === 0, r.problems.slice(0, 3));
        chk(tag + ': backdrop, header and the RESEARCH NOT PICKS. pill are painted', r.backdrop_painted && r.header_painted && r.pill_painted, r);
        chk(tag + ': the picture has content (not blank, not washed out)', r.lit_share > 0.02 && r.lit_share < 0.6, r.lit_share);
        const buf = Buffer.from(r.url.split(',')[1], 'base64');
        chk(tag + ': the bytes are a PNG of that size', buf.slice(1, 4).toString() === 'PNG' && buf.readUInt32BE(16) === SG.FORMATS[f].w && buf.readUInt32BE(20) === SG.FORMATS[f].h);
      }
    }
    const one = contents[0];
    const a = await drawOne(page, one, 'square', null), b = await drawOne(page, one, 'square', null), w = await drawOne(page, one, 'square', 'WITHDRAWN'), o = await drawOne(page, one, 'square', 'OUTDATED');
    chk('the same graphic draws identically twice', a.url === b.url);
    chk('a WITHDRAWN graphic carries its band and differs from the current one', w.stamp_band && w.url !== a.url && w.problems.length === 0);
    chk('an OUTDATED graphic carries its band', o.stamp_band && o.url !== a.url);
    chk('the page raised no error', errors.length === 0, errors);
    if (!fontsAll) console.log('NOTE | some graphics drew with fallback fonts (the web fonts were unreachable); metrics were checked with what was drawn');
  } catch (e) {
    chk('the browser suite ran to the end', false, String(e && e.stack || e).slice(0, 800));
  } finally {
    await browser.close();
    srv.close();
  }
  process.exit(T.done());
})();
