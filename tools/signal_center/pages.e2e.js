#!/usr/bin/env node
/* ===========================================================================
   Signal Center's two standalone pages, in Chromium, against the shipped doors
   (tools/signal_center/_stage.js: the migration on PostgreSQL, one live worker
   run over the committed sources, the PostgREST stand-in):

     node tools/signal_center/pages.e2e.js [--shots <dir>]   (SC_SQL_REQUIRED=1 in CI)

     /signals/          the public preview: anonymous doors only; live, shadow
                        and not-deployed states; the pulse equals the database;
                        no current number reaches the page; example graphics of
                        passed events are drawn and stamped; phone to desktop
     /admin/signals/    the operator console: the server decides who is an
                        operator; mode switch; the queue; hold and publish;
                        the graphic drawn from its stored content, downloaded,
                        approved and revoked (a record only); the weekly recap;
                        runs and failures
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const STAGE = require('./_stage.js');
const { serve, loadPlaywright } = require('./render_graphics.js');

const SHOTS = (() => { const i = process.argv.indexOf('--shots'); return i > 0 ? process.argv[i + 1] : null; })();
let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : ''));
}
const DIGIT_CLAIM = /\d+(\.\d+)?\s*(pp|%|percentage point)/i;

(async function main() {
  const pw = loadPlaywright();
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }
  const S = await STAGE.stage({ name: 'scpages' });
  if (S.skip) {
    if (process.env.SC_SQL_REQUIRED === '1') { console.log('FAIL | PostgreSQL is required here: ' + S.skip); process.exit(1); }
    console.log('NOTE | ' + S.skip + ' — the Signal Center pages suite did not run'); process.exit(0);
  }
  const q = (sql) => S.db.sql(sql).trim();
  const srv = await serve();
  const port = srv.address().port;
  let browser;
  try { browser = await pw.chromium.launch({ headless: true }); } catch (_) { browser = await pw.chromium.launch({ headless: true, executablePath: '/opt/pw-browsers/chromium' }); }
  async function open(url, viewport, o) {
    o = o || {};
    const ctx = await browser.newContext({ viewport, acceptDownloads: true });
    const calls = [];
    if (o.token) await ctx.addInitScript((t) => { try { localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: t.token, refresh_token: 'e2e', expires_at: Math.floor(Date.now() / 1000) + 86400, user: { id: t.uid, email: t.email } })); } catch (_) { /* storage */ } },
      { token: o.token, uid: S.tokens[o.token].id, email: S.tokens[o.token].email });
    await ctx.route('**/*', STAGE.router(S, { calls, notDeployed: !!o.notDeployed }));
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message || e).slice(0, 240)));
    await page.goto(`http://127.0.0.1:${port}${url}`, { waitUntil: 'domcontentloaded' });
    return { ctx, page, errors, calls };
  }
  const shot = async (page, name, full) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.waitForTimeout(250); await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: !!full }); } };
  const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

  /* one published signal with a graphic becomes a passed event, so the public
     page has an example to draw (this throwaway database only) */
  const exId = q("select s.signal_id from public.sc_signals s where s.publication = 'PUBLISHED' and s.lifecycle = 'ACTIVE' and exists (select 1 from public.sc_graphics g where g.version_id = s.current_version_id and g.status = 'READY' and g.format = 'square') order by s.score desc, s.signal_id limit 1;");
  chk('a published signal with a graphic exists to stand in as a passed event', /^\d+$/.test(exId), exId);

  try {
    /* ============================================================ /signals/ */
    for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
      const W = vp.width;
      const { ctx, page, errors, calls } = await open('/signals/', vp);
      await page.waitForFunction(() => !/Loading/.test(document.getElementById('spState').textContent) && !/Loading/.test(document.getElementById('spPulse').textContent), null, { timeout: 15000 }).catch(() => null);
      await page.waitForTimeout(400);
      const st = await page.textContent('#spState');
      chk(W + ': /signals/ says it is live, and when it last evaluated', /Live/.test(st) && /last evaluated/.test(st), st);
      const pulse = JSON.parse(q('select public.sc_pulse(24)::text;'));
      const kp = await page.$$eval('#spPulse .sp-kpi b', (b) => b.map((x) => +x.textContent));
      chk(W + ': the pulse prints the counts the database holds', kp[0] === pulse.published && kp[1] === pulse.major, { ui: kp.slice(0, 2), db: [pulse.published, pulse.major] });
      const sigs = await page.$$eval('#spFeed .sp-sig', (a) => a.map((x) => x.textContent));
      const lim = JSON.parse(q("select value::text from public.sc_config where key = 'free';")).feed_limit;
      chk(W + ': the preview holds published signals, at most the configured few', sigs.length > 0 && sigs.length <= lim, { n: sigs.length, lim });
      chk(W + ': no current number reaches the page', sigs.every((t) => !DIGIT_CLAIM.test(t)) && !DIGIT_CLAIM.test(await page.textContent('#spFeed')), sigs.filter((t) => DIGIT_CLAIM.test(t)));
      chk(W + ': only the three anonymous doors are called', calls.length > 0 && calls.every((c) => /rpc\/(sc_status|sc_pulse|sc_public_feed)$/.test(c)), calls);
      chk(W + ': no horizontal scroll', await noHScroll(page));
      const small = await page.evaluate(() => [...document.querySelectorAll('main a.btn, main button')].filter((b) => b.offsetParent !== null && b.getBoundingClientRect().height < 44).map((b) => b.textContent.trim().slice(0, 30)));
      chk(W + ': its buttons are 44px tall', small.length === 0, small);
      await shot(page, 'public-' + W, true);
      chk(W + ': no script errors', errors.length === 0, errors);
      await ctx.close();
    }
    /* examples: a passed event's stored graphic, drawn and stamped */
    if (/^\d+$/.test(exId)) {
      S.db.sql(`update public.sc_signals set lifecycle = 'EXPIRED', event_at = now() - interval '5 days' where signal_id = ${exId};`);
      const { ctx, page, errors } = await open('/signals/', { width: 1280, height: 900 });
      const img = await page.waitForSelector('#spExGrid img', { timeout: 20000 }).catch(() => null);
      const dims = img ? await img.evaluate((i) => ({ w: i.naturalWidth, h: i.naturalHeight, alt: i.alt })) : null;
      chk('/signals/: an example graphic of a passed event is drawn from its stored content', dims && dims.w === 1080 && dims.h === 1080 && dims.alt.length > 20, dims);
      chk('/signals/: …under its "not current research" note', /not current research/.test(await page.textContent('#spExamples')));
      await shot(page, 'public-examples', true);
      chk('/signals/ examples: no script errors', errors.length === 0, errors);
      await ctx.close();
      S.db.sql(`update public.sc_signals set lifecycle = 'ACTIVE', event_at = now() + interval '2 days' where signal_id = ${exId};`);
    }
    /* shadow mode, and not deployed */
    {
      S.db.sql("update public.sc_config set value = '\"shadow\"' where key = 'mode';");
      let o = await open('/signals/', { width: 390, height: 844 });
      await o.page.waitForFunction(() => !/Loading/.test(document.getElementById('spState').textContent), null, { timeout: 15000 }).catch(() => null);
      chk('/signals/ in shadow mode says so, and invents nothing', /Shadow mode/.test(await o.page.textContent('#spState')) && /nothing is invented/.test(await o.page.textContent('#spState')));
      await o.ctx.close();
      S.db.sql("update public.sc_config set value = '\"live\"' where key = 'mode';");
      o = await open('/signals/', { width: 390, height: 844 }, { notDeployed: true });
      await o.page.waitForFunction(() => /being prepared/.test(document.getElementById('spState').textContent), null, { timeout: 15000 }).catch(() => null);
      chk('/signals/ not deployed: "being prepared", and nothing is invented', /being prepared/.test(await o.page.textContent('#spState')) && (await o.page.$$('#spFeed .sp-sig')).length === 0);
      chk('/signals/ not deployed: no script errors', o.errors.length === 0, o.errors);
      await o.ctx.close();
    }

    /* ============================================================ /admin/signals/ */
    {
      /* signed out: the sign-in gate, nothing else */
      const o = await open('/admin/signals/', { width: 1280, height: 900 });
      await o.page.waitForTimeout(500);
      chk('console signed out: only the sign-in gate shows', await o.page.isVisible('#gate') && !(await o.page.isVisible('#app')));
      await o.ctx.close();
    }
    {
      /* a subscriber who is not an operator: the server says no */
      const o = await open('/admin/signals/', { width: 1280, height: 900 }, { token: 'tok_sub' });
      await o.page.waitForSelector('#denied:not(.hide)', { timeout: 15000 }).catch(() => null);
      chk('console as a non-operator: "not an operator", no controls', /not an operator/.test(await o.page.textContent('#denied')) && !(await o.page.isVisible('#ops')));
      chk('console as a non-operator: no operator door was called', o.calls.every((c) => !/sc_admin_/.test(c)), o.calls);
      await o.ctx.close();
    }
    for (const vp of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      const W = vp.width;
      const { ctx, page, errors } = await open('/admin/signals/', vp, { token: 'tok_admin' });
      await page.waitForSelector('#queue tbody tr', { timeout: 20000 });
      chk(W + ': console: the mode box says live and names the sports', /Live/.test(await page.textContent('#modeBox')) && /nfl/.test(await page.textContent('#modeBox')));
      const kp = await page.$$eval('#kpis .kpi', (k) => k.map((x) => [x.querySelector('i').textContent, +x.querySelector('b').textContent]));
      const dbPub = +q("select count(*) from public.sc_signals where publication = 'PUBLISHED';"), dbShadow = +q("select count(*) from public.sc_signals where publication = 'SHADOW';");
      chk(W + ': console: the counts are the database’s', kp[0][1] === dbPub && kp[1][1] === dbShadow, { ui: kp.slice(0, 2), db: [dbPub, dbShadow] });
      const rows = await page.$$eval('#queue tbody tr', (r) => r.length);
      chk(W + ': console: the queue lists signals, shadow ones included', rows >= Math.min(50, dbPub + dbShadow) && /SHADOW/.test(await page.textContent('#queue')) === (dbShadow > 0), rows);
      chk(W + ': console: no horizontal page scroll (tables scroll in their own box)', await noHScroll(page));
      await shot(page, 'admin-' + W);
      if (W !== 1280) { chk(W + ': console: no script errors', errors.length === 0, errors); await ctx.close(); continue; }

      /* review the signal with a graphic */
      await page.selectOption('#qSort', 'score');
      await page.waitForTimeout(800);
      await page.evaluate((id) => window.review && window.review(+id), exId);
      await page.waitForSelector('#gfxView img', { timeout: 20000 });
      const g = await page.evaluate(() => { const i = document.querySelector('#gfxView img'); return { w: i.naturalWidth, h: i.naturalHeight }; });
      chk('console: the stored graphic is drawn from its content', g.w > 0 && (g.w === 1080 || g.w === 1200), g);
      const [d1] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }).catch(() => null), page.click('#gDl')]);
      chk('console: Download PNG saves a named PNG', d1 && /\.png$/.test(d1.suggestedFilename()), d1 && d1.suggestedFilename());
      const gid = q(`select graphic_id from public.sc_graphics g join public.sc_signals s on s.current_version_id = g.version_id where s.signal_id = ${exId} and g.status = 'READY' order by g.format = 'square' desc, g.graphic_id limit 1;`);
      page.once('dialog', (d) => d.accept());
      await page.click('#gApprove');
      await page.waitForTimeout(1200);
      const appr = q(`select string_agg(external_approval, ',') from public.sc_graphics where signal_id = ${exId} and external_approval = 'APPROVED';`);
      chk('console: approving records APPROVED for that one graphic, with an audit event', appr === 'APPROVED' && +q(`select count(*) from public.sc_signal_events where signal_id = ${exId} and kind = 'graphic_approved';`) === 1, { appr, gid });
      chk('console: …and states that nothing is posted', /Nothing is posted|No job posts it/.test(await page.textContent('#selBox')));
      await page.click('#gRevoke');
      await page.waitForTimeout(1200);
      chk('console: revoking records REVOKED', +q(`select count(*) from public.sc_graphics where signal_id = ${exId} and external_approval = 'REVOKED';`) === 1);
      /* hold and publish */
      page.once('dialog', (d) => d.accept('e2e: console hold'));
      await page.click('#selInfo [data-act="hold"]');
      await page.waitForTimeout(1200);
      chk('console: hold is applied by the server', q(`select publication from public.sc_signals where signal_id = ${exId};`) === 'HELD');
      await page.click('#selInfo [data-act="publish"]');
      await page.waitForTimeout(1200);
      chk('console: publish restores it', q(`select publication from public.sc_signals where signal_id = ${exId};`) === 'PUBLISHED');
      await page.click('#selInfo [data-act="preview_on"]');
      await page.waitForTimeout(1000);
      chk('console: pinning to the free preview is recorded', q(`select public_preview from public.sc_signals where signal_id = ${exId};`) === 't' && /free preview/.test(await page.textContent('#selInfo')));
      await page.click('#selInfo [data-act="preview_off"]');
      await page.waitForTimeout(1000);
      /* the weekly recap */
      await page.click('#rGo');
      await page.waitForSelector('#rView img', { timeout: 25000 }).catch(() => null);
      const rc = await page.evaluate(() => { const i = document.querySelector('#rView img'); return i ? { w: i.naturalWidth, h: i.naturalHeight, alt: i.alt } : null; });
      chk('console: the weekly recap is drawn from published, verified signals', rc && rc.w === 1080 && rc.h === 1080 && /weekly research recap/i.test(rc.alt), rc || await page.textContent('#rMsg'));
      const [d2] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }).catch(() => null), page.click('#rDl')]);
      chk('console: the recap downloads as a PNG', d2 && /^edgedesk-.*recap.*\.png$/.test(d2.suggestedFilename()), d2 && d2.suggestedFilename());
      await shot(page, 'admin-review', true);
      /* runs and failures */
      chk('console: the run is listed', /completed/.test(await page.textContent('#runs')));
      const openFails = +q('select count(*) from public.sc_failures where resolved_at is null;');
      if (openFails > 0) {
        await page.click('#fails [data-resolve]');
        await page.waitForTimeout(1000);
        chk('console: resolving a failure records it', +q('select count(*) from public.sc_failures where resolved_at is null;') === openFails - 1);
      }
      /* the mode switch */
      await page.check('#mShadow');
      await page.click('#modeGo');
      await page.waitForTimeout(1200);
      chk('console: switching to shadow is saved and logged', q("select value#>>'{}' from public.sc_config where key = 'mode';") === 'shadow' && +q("select count(*) from public.sc_config_log where key = 'mode';") >= 1);
      await page.check('#mLive');
      page.once('dialog', (d) => d.accept());
      await page.click('#modeGo');
      await page.waitForTimeout(1200);
      chk('console: switching back to live asks first, then saves', q("select value#>>'{}' from public.sc_config where key = 'mode';") === 'live');
      chk('console: no script errors', errors.length === 0, errors);
      await ctx.close();
    }
  } catch (e) {
    chk('the suite ran to the end', false, String(e && e.stack || e).slice(0, 1200));
  } finally {
    await browser.close();
    srv.close();
    S.stop();
  }
  failures.forEach((f) => console.log('FAIL | ' + f));
  console.log((fail ? 'FAILED' : 'ALL GREEN') + ' signal center pages — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
