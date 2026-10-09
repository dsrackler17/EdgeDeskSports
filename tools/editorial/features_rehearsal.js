#!/usr/bin/env node
/* ===========================================================================
   THE PRODUCTION-LIKE REHEARSAL for EdgeDesk's own features.

     node tools/editorial/features_rehearsal.js [--out FILE] [--keep]

   Nothing here touches the repository or any real service. It
     1  copies the whole site to a scratch directory (everything but .git);
     2  installs the database on a throwaway PostgreSQL (the real migrations,
        in order) with an owner, and drives the job as the service role
        through the same RPC doors the workflow uses;
     3  runs a real week from the committed research: Monday in the default
        DRY RUN (nothing may be written), the owner switching to AUTO, then
        Monday, Wednesday and Friday at the publish hour;
     4  runs the real site build (tools/articles/build_articles.js) and the
        SEO audit (--check: any error fails) in the copy;
     5  serves the copy and opens every published feature, the features hub
        and the research hub in Chromium: no page error, nothing wider than a
        phone at 390 px, the one call to action, structured data that parses,
        a page view sent, and an engaged reader sent only after 30 seconds and
        half the page;
     6  writes a report (--out) of what passed and what did not.
   Exit 0 only if every step passed.
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const SRC = path.join(__dirname, '..', '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const OUT = arg('out', null);

const results = [];
function step(name, ok, detail) { results.push({ name, ok: !!ok, detail: detail == null ? null : String(detail).slice(0, 600) }); console.log((ok ? '  ok  ' : '  ✗   ') + name + (detail && !ok ? ' — ' + String(detail).slice(0, 300) : '')); return ok; }

(async () => {
  const started = Date.now();
  /* 1 · the copy */
  const COPY = fs.mkdtempSync(path.join(os.tmpdir(), 'edgedesk-rehearsal-'));
  fs.cpSync(SRC, COPY, { recursive: true, filter: (s) => !/[\/\\](\.git|node_modules)([\/\\]|$)/.test(s.slice(SRC.length)) });
  step('the site is copied to a scratch directory', fs.existsSync(path.join(COPY, 'lib', 'content_engine.js')), COPY);
  const r = (p) => require(path.join(COPY, p));
  const PG = r('tools/personal/_pg.js');
  const PGR = r('tools/lib/pgrest.js');
  const { sqlVal } = r('tools/growth/_rpc_shim.js');
  const JOB = r('tools/editorial/features.js');
  const STORE = r('tools/articles/store.js');
  const MODEL = r('tools/articles/article_model.js');

  /* 2 · the database */
  const db = PG.start('rehearsal');
  if (db.skip) { step('a PostgreSQL to rehearse on', false, db.skip); return finish(COPY, started); }
  try {
    ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql', 'funnel.sql', 'site_articles.sql', 'newsletter.sql',
      'growth_engine.sql', 'growth_outbound.sql', 'content_engine.sql', 'first_party_funnel.sql'].forEach((f) => db.applyFileAtomic(path.join(COPY, 'supabase', f)));
    step('the migrations install in order, on a fresh database', true);
    const OWNER = '00000000-0000-0000-0000-0000000000f1';
    db.sql(`insert into auth.users (id, email, email_confirmed_at) values (${PG.lit(OWNER)}, 'owner@rehearsal.test', now());
            insert into public.affiliate_admins (user_id) values (${PG.lit(OWNER)}); select growth_outbound.grant_owner('owner@rehearsal.test');`);
    const SB = 'https://rehearsal.supabase.test', KEY = 'rehearsal-service-key';
    const client = PGR.client({ url: SB, key: KEY }, async (url, init) => {
      const fn = String(url).split('/rpc/')[1], args = JSON.parse(init.body || '{}');
      try { const o = db.service(`select public.${fn}(${Object.entries(args).map(([k, v]) => k + ' => ' + sqlVal(v)).join(', ')});`); return new Response(o === '' ? 'null' : o, { status: 200 }); }
      catch (e) { return new Response(JSON.stringify({ message: String(e.sqlMessage || e.message).slice(0, 300) }), { status: 400 }); }
    }, { retries: 0 });
    const logs = [];
    const go = (iso) => JOB.run({ now: Date.parse(iso), db: client, ifDue: true, log: (l) => logs.push(l) });

    /* 3 · the week */
    const before = STORE.loadFeatures().length;
    const m0 = await go('2026-10-05T12:30:00Z');
    step('Monday 7:30 CT, dry run (the default): built and gated, nothing written', m0.mode === 'dry_run' && m0.results[0] && m0.results[0].status === 'dry_run' && STORE.loadFeatures().length === before,
      JSON.stringify(m0.results));
    step('… the dry run is on record for the owner, with its twelve gates', db.sql(`select status || '|' || jsonb_array_length(gates) from content_engine.first_party where id = 'feature-2026-10-05-weekend-review';`) === 'dry_run|12');
    db.as(OWNER, `select public.content_engine_fp_settings_save('{"fp_mode":"auto"}'::jsonb);`);
    const runs = [];
    for (const t of ['2026-10-05T13:00:00Z', '2026-10-07T12:30:00Z', '2026-10-09T12:30:00Z']) runs.push(await go(t));
    const published = STORE.loadFeatures().filter((x) => x.status === 'published');
    runs.forEach((x, i) => step(['Monday', 'Wednesday', 'Friday'][i] + ' in auto: ' + (x.results[0] ? x.results[0].status : 'nothing') + (x.results[0] && x.results[0].failed && x.results[0].failed.length ? ' (gates failed: ' + x.results[0].failed.join(', ') + ')' : ''),
      x.results[0] && x.results[0].status === 'published', JSON.stringify(x.results)));
    step('three features published this week, no more', published.length === 3 && db.sql(`select count(*) from content_engine.first_party where status = 'published';`) === '3');
    step('every published record passes the article model’s own checks', published.every((x) => MODEL.publishable(x).ok));
    step('the console never printed an article’s text', published.every((x) => logs.join('\n').indexOf(x.title) < 0));
    const again = await go('2026-10-09T14:30:00Z');
    step('a later run the same morning publishes nothing twice', again.published.length === 0);

    /* 4 · the site build and the SEO audit, in the copy */
    let build = '';
    try { build = execFileSync(process.execPath, ['tools/articles/build_articles.js', '--now', '2026-10-09T15:00:00Z'], { cwd: COPY, encoding: 'utf8' }); step('the site build runs', /3 feature\(s\)/.test(build), build.split('\n').slice(-2).join(' ')); }
    catch (e) { step('the site build runs', false, e.stdout || e.message); }
    const exists = (p) => fs.existsSync(path.join(COPY, p));
    published.forEach((x) => step('page written: /articles/' + x.slug + '/', exists('articles/' + x.slug + '/index.html')));
    step('the features hub is written', exists('articles/features/index.html'));
    const sm = fs.readFileSync(path.join(COPY, 'sitemap-articles.xml'), 'utf8');
    step('the sitemap lists every feature and the features hub', published.every((x) => sm.indexOf(x.canonical_url) >= 0) && sm.indexOf('https://edgedesksports.com/articles/features/') >= 0);
    const pj = JSON.parse(fs.readFileSync(path.join(COPY, 'articles', 'data', 'published.json'), 'utf8'));
    step('the published index carries them as features (no game id)', pj.articles.filter((a) => a.type === 'feature').length === 3 && pj.articles.filter((a) => a.type === 'feature').every((a) => a.game_id === null && a.title));
    step('every game article that was published is still published', pj.articles.filter((a) => a.type !== 'feature').length === JSON.parse(fs.readFileSync(path.join(SRC, 'articles', 'data', 'published.json'), 'utf8')).articles.length);
    let audit = '';
    try { audit = execFileSync(process.execPath, ['tools/seo/audit.js', '--check'], { cwd: COPY, encoding: 'utf8' }); step('the SEO audit passes (--check: no errors)', true, audit.split('\n').slice(-3).join(' ')); }
    catch (e) { step('the SEO audit passes (--check: no errors)', false, (e.stdout || '') + (e.stderr || '')); }
    try {
      const rep = r('tools/seo/audit.js').run(COPY);
      const fp = (rep.pages || []).filter((p) => published.some((x) => p.url === x.canonical_url));
      step('the audit saw every feature: served, crawlable, indexable, canonical, structured data', fp.length === 3 && fp.every((p) => p.served && p.crawlable && p.indexable && (!p.errors || !p.errors.length)), JSON.stringify(fp.map((p) => ({ url: p.url, errors: p.errors, warnings: p.warnings }))).slice(0, 600));
    } catch (e) { step('the audit report is readable', false, e.message); }

    /* 5 · in a browser */
    let pw = null;
    try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
    if (!pw) step('a browser to check the pages in', false, 'playwright is not installed');
    else {
      const srv = http.createServer((req, res) => {
        let u = decodeURIComponent(req.url.split('?')[0]);
        let f = path.join(COPY, u);
        if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
        if (!fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); }
        const ext = path.extname(f);
        res.writeHead(200, { 'content-type': { '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' }[ext] || 'text/html' });
        res.end(fs.readFileSync(f));
      });
      await new Promise((ok) => srv.listen(0, ok));
      const base = 'http://127.0.0.1:' + srv.address().port;
      let browser;
      try { browser = await pw.chromium.launch({ headless: true }); }
      catch (e) {
        const exe = ['/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((x) => fs.existsSync(x) && fs.statSync(x).isFile());
        browser = await pw.chromium.launch({ headless: true, executablePath: exe });
      }
      try {
        for (const x of published.concat([{ slug: 'features', title: 'hub' }])) {
          for (const width of [1280, 390]) {
            const ctx = await browser.newContext({ viewport: { width, height: 900 } });
            const page = await ctx.newPage();
            const errors = [], tracked = [];
            page.on('pageerror', (e) => errors.push(String(e)));
            await page.route(/googletagmanager|fonts\.g/, (rt) => rt.abort());
            await page.route(/supabase\.co\/rest\/v1\/rpc\//, (rt) => { tracked.push({ url: rt.request().url(), body: rt.request().postData() || '' }); rt.fulfill({ status: 200, body: '{}', contentType: 'application/json' }); });
            if (width === 1280 && x.slug !== 'features') await page.clock.install();
            await page.goto(base + '/articles/' + x.slug + '/');
            await page.waitForTimeout(400);
            const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            const info = await page.evaluate(() => ({ ctas: document.querySelectorAll('[data-ed-cta]').length, research: !!document.querySelector('[data-ed-cta="feature_research"]'),
              ld: Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map((s) => { try { return JSON.parse(s.textContent)['@type']; } catch (e) { return 'BAD'; } }), h1: document.querySelectorAll('h1').length }));
            const label = x.slug === 'features' ? 'the features hub' : '“' + x.title + '”';
            step(label + ' at ' + width + ' px: no page error, nothing overflows', !errors.length && over <= 1, JSON.stringify({ errors, over }));
            if (width === 1280) {
              step(label + ': one h1, structured data parses, the research call to action', info.h1 === 1 && info.ld.indexOf('BAD') < 0 && info.research && (x.slug === 'features' || info.ctas === 1), JSON.stringify(info));
              if (x.slug !== 'features') {
                /* the tracker batches a page view for 1.2 s; the clock is ours */
                await page.clock.fastForward(2000); await page.waitForTimeout(200);
                step(label + ': a page view is sent', tracked.some((t) => /ed_track/.test(t.url) && /public_page_view/.test(t.body)));
                const before2 = tracked.filter((t) => /article_engaged/.test(t.body)).length;
                await page.mouse.wheel(0, 20000); await page.clock.fastForward(10000);
                const early = tracked.filter((t) => /article_engaged/.test(t.body)).length;
                await page.clock.fastForward(30000); await page.mouse.wheel(0, 100); await page.waitForTimeout(300);
                const late = tracked.filter((t) => /article_engaged/.test(t.body)).length;
                step(label + ': an engaged reader is sent after 30 seconds and half the page, not before', before2 === 0 && early === 0 && late === 1, JSON.stringify({ before2, early, late }));
              }
            }
            await ctx.close();
          }
        }
        /* a reader with Global Privacy Control */
        const ctx = await browser.newContext();
        await ctx.addInitScript(() => { Object.defineProperty(navigator, 'globalPrivacyControl', { get: () => true }); });
        const page = await ctx.newPage(); const tracked = [];
        await page.route(/googletagmanager|fonts\.g/, (rt) => rt.abort());
        await page.route(/supabase\.co\/rest\/v1\/rpc\//, (rt) => { tracked.push(rt.request().postData() || ''); rt.fulfill({ status: 200, body: '{}', contentType: 'application/json' }); });
        await page.clock.install();
        await page.goto(base + '/articles/' + published[0].slug + '/');
        await page.mouse.wheel(0, 20000); await page.clock.fastForward(45000); await page.mouse.wheel(0, 100); await page.waitForTimeout(300);
        step('Global Privacy Control: no engagement is measured, and GA is not loaded', !tracked.some((t) => /article_engaged/.test(t)) && !(await page.evaluate(() => typeof window.gtag === 'function')));
        await ctx.close();
        const hub = await browser.newPage();
        await hub.goto(base + '/articles/');
        const hubHtml = await hub.content();
        step('the research hub links this week’s features', hubHtml.indexOf('/articles/features/') >= 0 && published.every((x) => hubHtml.indexOf('/articles/' + x.slug + '/') >= 0));
        await hub.close();
      } finally { await browser.close(); srv.close(); }
    }
  } catch (e) {
    step('the rehearsal reached its end', false, e && e.stack || e);
  } finally { db.stop(); }
  finish(COPY, started);
})();

function finish(COPY, started) {
  const ok = results.every((x) => x.ok);
  const md = ['# EdgeDesk features — production-like rehearsal', '', 'Run ' + new Date().toISOString() + ' in ' + Math.round((Date.now() - started) / 1000) + ' s, on a copy of the site and a throwaway database.', '',
    '**Result: ' + (ok ? 'every step passed' : results.filter((x) => !x.ok).length + ' step(s) failed') + '**', '']
    .concat(results.map((x) => '- ' + (x.ok ? '✅ ' : '❌ ') + x.name + (x.ok || !x.detail ? '' : '\n  - ' + x.detail.replace(/\n/g, ' '))));
  if (OUT) fs.writeFileSync(OUT, md.join('\n') + '\n');
  console.log((ok ? 'PASS' : 'FAIL') + ' | features rehearsal | ' + results.filter((x) => x.ok).length + ' passed, ' + results.filter((x) => !x.ok).length + ' failed');
  if (argv.indexOf('--keep') < 0) { try { fs.rmSync(COPY, { recursive: true, force: true }); } catch (_) { /* scratch */ } }
  else console.log('kept: ' + COPY);
  process.exit(ok ? 0 : 1);
}
