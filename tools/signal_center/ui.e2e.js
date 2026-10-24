#!/usr/bin/env node
/* ===========================================================================
   Signal Center in the real terminal (app.html), in Chromium, against the
   shipped doors: a throwaway PostgreSQL with supabase/signal_center.sql,
   filled by one live worker run over the committed sources (tools/signal_center/
   _stage.js), behind the PostgREST stand-in. No response is hand-written.

     node tools/signal_center/ui.e2e.js [--shots <dir>]   (SC_SQL_REQUIRED=1 in CI)

     seat        Signals is the first of seven seats, labelled, unclipped, 44 px,
                 at 1440 / 768 / 390 / 320; a tap is recorded as primary_nav_signals
     routes      #signals, #signals/<sport>, #signals/s/<id>, #signals/dna,
                 #signals/coverage|alerts|method, and #signal-center (rewritten);
                 back and forward; leaving clears the hash; old routes still land
     landing     a new reader lands on Signal Center when it is live; in shadow
                 mode or when it is not deployed they are handed on to Research;
                 a remembered tab still wins
     full        a Full Access reader sees the numbers that the database holds,
                 filters, sorts, pages, opens the evidence, the Model DNA, the
                 versions, and the graphic drawn from the stored payload (PNG
                 download); Escape returns to the feed with focus kept
     preview     a signed-in reader without Full Access and a signed-out visitor
                 see number-free headlines only; the detail door refuses
     operator    an operator sees shadow signals and the operator actions
     alerts      preferences save through the door; a bell notice opens its signal
     states      not deployed, a failed refresh (stale), an empty filter
     layout      no horizontal scroll at any width; no script error anywhere
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
  const S = await STAGE.stage({ name: 'scui' });
  if (S.skip) {
    if (process.env.SC_SQL_REQUIRED === '1') { console.log('FAIL | PostgreSQL is required here: ' + S.skip); process.exit(1); }
    console.log('NOTE | ' + S.skip + ' — the Signal Center browser suite did not run'); process.exit(0);
  }
  const q = (sql) => S.db.sql(sql).trim();
  const srv = await serve();
  const port = srv.address().port;
  const launch = { headless: true };
  let browser;
  try { browser = await pw.chromium.launch(launch); } catch (_) { browser = await pw.chromium.launch(Object.assign({}, launch, { executablePath: '/opt/pw-browsers/chromium' })); }
  const TOKEN = { sub: 'tok_sub', free: 'tok_free', admin: 'tok_admin', anon: null };

  /* who: sub | free | admin | anon. o.fresh: no saved preferences (a new reader).
     o.prefs: preferences to seed. o.notDeployed: every sc_ door answers 404. */
  async function open(viewport, hash, who, o) {
    o = o || {};
    const ctx = await browser.newContext({ viewport, acceptDownloads: true });
    const tracked = [], calls = [];
    await ctx.addInitScript((x) => {
      try {
        if (sessionStorage.getItem('__e2e_seeded')) return;
        sessionStorage.setItem('__e2e_seeded', '1');
        localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
        localStorage.setItem('edgedesk_decision_onboarded_v1', JSON.stringify('2026-01-01T00:00:00Z'));
        localStorage.setItem('edgedesk_first_run_v1', JSON.stringify({ steps: {}, done_at: '2026-01-01T00:00:00Z' }));
        localStorage.setItem('edgedesk_setup_v1', String(Date.now()));
        if (x.token) localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: x.token, refresh_token: 'e2e', expires_at: Math.floor(Date.now() / 1000) + 86400 * 400,
          user: { id: x.uid, email: x.email, created_at: '2025-01-01T00:00:00Z' } }));
        if (!x.fresh) localStorage.setItem('edgedesk_prefs', JSON.stringify(x.prefs || { lastTab: 'research', lastResearchSub: 'football', rememberTab: true, defaultTab: 'research' }));
      } catch (e) { /* storage */ }
    }, { token: TOKEN[who], uid: who === 'anon' ? null : S.tokens[TOKEN[who]].id, email: who === 'anon' ? null : S.tokens[TOKEN[who]].email, fresh: !!o.fresh, prefs: o.prefs || null });
    await ctx.route('**/*', STAGE.router(S, { tracked, calls, notDeployed: !!o.notDeployed, entitled: who === 'sub' || who === 'admin' }));
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message || e).slice(0, 240)));
    await page.goto(`http://127.0.0.1:${port}/app.html${hash || ''}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.show === 'function' && !!window.EDSignalCenter, null, { timeout: 30000 });
    await page.waitForTimeout(300);
    return { ctx, page, errors, tracked, calls };
  }
  const shot = async (page, name, full) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.waitForTimeout(250); await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: !!full }); } };
  const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  const state = (page) => page.evaluate(() => {
    const views = [...document.querySelectorAll('section.view')].filter((v) => !v.classList.contains('hide')).map((v) => v.id);
    const seat = [...document.querySelectorAll('.bottomnav button.on')].map((b) => b.dataset.v);
    const tab = [...document.querySelectorAll('#scHost .sc-tabs button.on')].map((b) => b.dataset.scView);
    return { views, seat, tab, hash: location.hash };
  });
  const cards = (page) => page.evaluate(() => [...document.querySelectorAll('#scHost .sc-list .sc-card')].map((c) => ({
    head: (c.querySelector('.sc-headline') || {}).textContent || '', sport: (c.querySelector('.sc-c-sport') || {}).textContent || '', label: (c.querySelector('.sc-card-top .sc-chip') || {}).textContent || '',
    locked: c.classList.contains('sc-locked'), text: c.textContent, open: (c.querySelector('[data-sc-open]') || { getAttribute: () => null }).getAttribute('data-sc-open') })));
  const waitCards = (page) => page.waitForSelector('#scHost .sc-list .sc-card, #scHost .sc-quiet', { timeout: 20000 }).catch(() => null);

  const published = +q("select count(*) from public.sc_signals where publication = 'PUBLISHED' and verification_state = 'VERIFIED' and lifecycle = 'ACTIVE' and not fixture;");
  chk('the staged run published signals to read', published > 5, published);
  const shadowN = +q("select count(*) from public.sc_signals where publication = 'SHADOW';");
  const withGfx = q("select s.signal_id from public.sc_signals s where s.publication = 'PUBLISHED' and s.lifecycle = 'ACTIVE' and exists (select 1 from public.sc_graphics g where g.version_id = s.current_version_id and g.status = 'READY') order by s.score desc, s.signal_id limit 1;");
  chk('a published signal has a graphic on file', /^\d+$/.test(withGfx), withGfx);

  try {
    /* ============================================================ the seat, every width */
    for (const vp of [{ width: 1440, height: 900 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
      const W = vp.width;
      const { ctx, page, errors, tracked } = await open(vp, '', 'sub');
      const nav = await page.evaluate(() => {
        const bs = [...document.querySelectorAll('.bottomnav button')].filter((b) => b.offsetParent !== null);
        const clipped = bs.filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.dataset.v);
        return { seats: bs.map((b) => b.dataset.v), labels: bs.map((b) => b.textContent.trim()), aria: bs.map((b) => b.getAttribute('aria-label')), on: bs.filter((b) => b.classList.contains('on')).map((b) => b.dataset.v),
          clipped, minH: Math.min(...bs.map((b) => b.getBoundingClientRect().height)), minW: Math.min(...bs.map((b) => b.getBoundingClientRect().width)) };
      });
      chk(W + ': seven seats, Signal Center first', nav.seats.join(',') === 'signals,research,card,portfolio,process,simulator,more', nav.seats);
      chk(W + ': the seat reads Signals and is named Signal Center', nav.labels[0] === 'Signals' && nav.aria[0] === 'Signal Center', [nav.labels[0], nav.aria[0]]);
      chk(W + ': a returning reader still lands on their remembered Research', nav.on.join() === 'research', nav.on);
      chk(W + ': no seat label is clipped', nav.clipped.length === 0, nav.clipped);
      /* and with the wide fallback face a browser uses when web fonts are blocked (CI's runners) */
      const wide = await page.evaluate(() => {
        const st = document.createElement('style'); st.textContent = ".bottomnav button{font-family:'DejaVu Sans','Verdana',sans-serif!important}"; document.head.appendChild(st);
        const out = [...document.querySelectorAll('.bottomnav button')].filter((b) => b.offsetParent !== null && b.scrollWidth > b.clientWidth + 1).map((b) => b.dataset.v);
        st.remove(); return out;
      });
      chk(W + ': no seat label is clipped in a wide fallback face either', wide.length === 0, wide);
      chk(W + ': every seat is a 44px tap target', nav.minH >= 44 && nav.minW >= 44, [nav.minH, nav.minW]);
      await page.click('.bottomnav button[data-v="signals"]');
      await waitCards(page);
      let st = await state(page);
      chk(W + ': the seat opens Signal Center with its seat lit and its own hash', st.views.join() === 'v-signals' && st.seat.join() === 'signals' && st.hash === '#signals', st);
      await page.waitForTimeout(1400);
      chk(W + ': the tap is recorded as primary_nav_signals', tracked.map((e) => e.event || e.event_name || e.name).indexOf('primary_nav_signals') >= 0, tracked.slice(-4));
      const cs = await cards(page);
      chk(W + ': the feed shows published signals', cs.length > 0 && cs.length <= 25, cs.length);
      chk(W + ': no horizontal scroll on the feed', await noHScroll(page));
      const tgt = await page.evaluate(() => [...document.querySelectorAll('#scHost button, #scHost select, #scHost a.btn, #scHost summary')].filter((b) => b.offsetParent !== null)
        .map((b) => { const r = b.getBoundingClientRect(); return { h: r.height, t: (b.textContent || b.getAttribute('aria-label') || '').trim().slice(0, 30) }; }).filter((x) => x.h < 44));
      chk(W + ': every visible control is at least 44px tall', tgt.length === 0, tgt.slice(0, 6));
      await shot(page, 'feed-' + W);
      /* the detail at every width */
      const id = cs.find((c) => c.open) && cs.find((c) => c.open).open;
      await page.click(`#scHost [data-sc-open="${id}"]`);
      await page.waitForSelector('#sc-detail-h', { timeout: 15000 });
      chk(W + ': no horizontal scroll on the detail', await noHScroll(page));
      await shot(page, 'detail-' + W, true);
      chk(W + ': no script errors', errors.length === 0, errors);
      await ctx.close();
    }

    /* ============================================================ a Full Access reader, in depth */
    {
      const { ctx, page, errors } = await open({ width: 1280, height: 900 }, '#signals', 'sub');
      await waitCards(page);
      let st = await state(page);
      chk('#signals opens the feed directly', st.views.join() === 'v-signals' && st.tab.join() === 'feed' && st.hash === '#signals', st);
      const bar = await page.textContent('#sc-status');
      chk('the status bar says live, and when it last evaluated', /Live/.test(bar) && /Evaluated/.test(bar), bar);
      /* the pulse equals the database */
      const pulse = JSON.parse(q("select public.sc_pulse(24)::text;"));
      const pulseTxt = await page.textContent('#scHost .sc-pulse');
      chk('Research Pulse prints the counts the database holds', pulseTxt.indexOf(String(pulse.published)) >= 0 && pulse.published > 0, { db: pulse.published, txt: pulseTxt.slice(0, 200) });
      let cs = await cards(page);
      chk('Full Access cards are not locked and carry numbers', cs.every((c) => !c.locked) && cs.some((c) => DIGIT_CLAIM.test(c.text)), cs.slice(0, 2).map((c) => c.text.slice(0, 120)));
      /* the first card is the newest published signal, word for word: the
         feed lands on the latest per subject, current and past, by the moment
         each signal describes */
      const newest = q("select headline from public.sc_signals where publication = 'PUBLISHED' and verification_state = 'VERIFIED' and lifecycle in ('ACTIVE', 'EXPIRED') and not fixture order by signal_at desc, signal_id desc limit 1;");
      chk('the first card is the newest published signal, word for word', cs[0] && cs[0].head === newest, { ui: cs[0] && cs[0].head, db: newest });
      /* filters: sport */
      await page.evaluate(() => { const d = document.querySelector('#scHost .sc-filters'); if (d) d.open = true; });
      await page.selectOption('#scHost select[data-sc-filter="sport"]', 'cfb');
      await page.waitForTimeout(900);
      cs = await cards(page);
      st = await state(page);
      chk('the sport filter keeps only that sport, and writes #signals/cfb', cs.length > 0 && cs.every((c) => c.sport === 'College football') && st.hash === '#signals/cfb', { n: cs.length, sports: [...new Set(cs.map((c) => c.sport))], hash: st.hash });
      /* sort: largest verified shift */
      await page.selectOption('#scHost select[data-sc-filter="sort"]', 'shift');
      await page.waitForTimeout(900);
      const shifts = await page.evaluate(() => [...document.querySelectorAll('#scHost .sc-list .sc-card .sc-delta')].map((d) => Math.abs(parseFloat(String(d.textContent).replace('−', '-')))).filter((x) => isFinite(x)));
      chk('sort by largest shift orders the cards by the shift they print', shifts.length > 1 && shifts.every((x, i, a) => i === 0 || a[i - 1] >= x - 1e-9), shifts.slice(0, 8));
      /* an empty filter */
      await page.fill('#scHost input[data-sc-filter="team"]', 'Nowhere Polytechnic');
      await page.dispatchEvent('#scHost input[data-sc-filter="team"]', 'change');
      await page.waitForTimeout(900);
      chk('a filter that matches nothing says so', /No signals match these filters/.test(await page.textContent('#sc-body')));
      await page.click('#scHost [data-sc-act="clear"]');
      await page.waitForTimeout(900);
      st = await state(page);
      chk('Clear filters returns the whole feed and #signals', (await cards(page)).length > 0 && st.hash === '#signals', st);
      /* the filters survive a reload (a per-viewer convenience) */
      await page.selectOption('#scHost select[data-sc-filter="min_label"]', 'Notable');
      await page.waitForTimeout(700);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!window.EDSignalCenter, null, { timeout: 20000 });
      await waitCards(page);
      chk('a chosen filter survives a reload', await page.evaluate(() => (document.querySelector('#scHost select[data-sc-filter="min_label"]') || {}).value) === 'Notable');
      cs = await cards(page);
      chk('…and is applied', cs.length > 0 && cs.every((c) => /Major|Notable/.test(c.label)), [...new Set(cs.map((c) => c.label))]);
      await page.click('#scHost [data-sc-act="clear"]');
      await page.waitForTimeout(700);

      /* the evidence: open the signal with a graphic */
      await page.evaluate((id) => { location.hash = '#signals/s/' + id; }, withGfx);
      await page.waitForSelector('#sc-detail-h', { timeout: 15000 });
      st = await state(page);
      chk('#signals/s/<id> opens the evidence', st.views.join() === 'v-signals' && st.hash === '#signals/s/' + withGfx, st);
      const det = await page.evaluate(() => ({ h: document.getElementById('sc-detail-h').textContent, secs: [...document.querySelectorAll('#scHost .sc-detail section[id], #scHost .sc-detail details[id]')].map((s) => s.id),
        why: (document.querySelector('#sc-why') || {}).textContent || '', timing: (document.querySelector('#sc-timing') || {}).textContent || '', dna: (document.querySelector('#sc-dna') || {}).textContent || '' }));
      const dbHead = q(`select headline from public.sc_signals where signal_id = ${withGfx};`);
      chk('the evidence headline is the stored one', det.h === dbHead, { ui: det.h, db: dbHead });
      chk('every section is there: what, why, timing, model, DNA, uncertainty, history, graphic', ['sc-what', 'sc-why', 'sc-timing', 'sc-model', 'sc-dna', 'sc-unc', 'sc-history', 'sc-graphic'].every((s) => det.secs.indexOf(s) >= 0), det.secs);
      chk('Why names its evidence class', /Why did this change\?/.test(det.why) && /(Confirmed cause|Supported association|Observed|Unexplained movement|Model version change)/.test(det.why), det.why.slice(0, 200));
      chk('Timing keeps every timestamp as its own fact', /Source published/.test(det.timing) && /Detected by Signal Center/.test(det.timing) && /never proves EdgeDesk knew earlier/.test(det.timing));
      chk('Model DNA answers "can I trust it here?"', /Can I trust it here\?/.test(det.dna) || /No Model DNA record/.test(det.dna), det.dna.slice(0, 160));
      chk('focus moves to the signal heading', await page.evaluate(() => document.activeElement && document.activeElement.id === 'sc-detail-h'));
      /* the graphic: drawn from the stored content */
      await page.waitForSelector('#sc-gfx img.sc-gfx-img', { timeout: 20000 });
      const img = await page.evaluate(() => { const i = document.querySelector('#sc-gfx img'); return { w: i.naturalWidth, h: i.naturalHeight, alt: i.alt }; });
      chk('the graphic is drawn at 1080 × 1080 with a text alternative', img.w === 1080 && img.h === 1080 && img.alt.length > 20, img);
      const fmts = await page.$$eval('#scHost [data-sc-fmt]', (b) => b.map((x) => x.textContent));
      chk('three formats are offered', fmts.sort().join() === 'landscape,portrait,square', fmts);
      await page.click('#scHost [data-sc-fmt]:nth-child(2)');
      await page.waitForFunction(() => { const i = document.querySelector('#sc-gfx img'); return i && i.naturalWidth && i.naturalWidth !== i.naturalHeight; }, null, { timeout: 15000 }).catch(() => null);
      const img2 = await page.evaluate(() => { const i = document.querySelector('#sc-gfx img'); return i ? { w: i.naturalWidth, h: i.naturalHeight } : null; });
      chk('another format redraws at its own size', img2 && ((img2.w === 1200 && img2.h === 675) || (img2.w === 1080 && img2.h === 1350)), img2);
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }).catch(() => null), page.click('#scHost [data-sc-act="download"]')]);
      chk('Download PNG saves a named PNG', dl && /^edgedesk-.*\.png$/.test(dl.suggestedFilename()), dl && dl.suggestedFilename());
      /* versions */
      chk('the history lists version 1 as current', /v1/.test(await page.textContent('#sc-history')) && /current/.test(await page.textContent('#sc-history')));
      /* Escape: back to the feed */
      await page.keyboard.press('Escape');
      await waitCards(page);
      await page.waitForTimeout(400);
      st = await state(page);
      chk('Escape returns to the feed', st.tab.join() === 'feed' && /^#signals$/.test(st.hash), st);
      /* forward goes back to the evidence; back again to the feed */
      await page.goForward(); await page.waitForSelector('#sc-detail-h', { timeout: 15000 }).catch(() => null);
      chk('browser forward reopens the evidence', (await state(page)).hash === '#signals/s/' + withGfx);
      await page.goBack(); await waitCards(page); await page.waitForTimeout(300);
      chk('browser back returns to the feed', (await state(page)).tab.join() === 'feed');
      /* keyboard: Tab to a Why button and press Enter */
      await page.focus('#scHost .sc-list [data-sc-open]');
      await page.keyboard.press('Enter');
      chk('Why? opens from the keyboard', !!(await page.waitForSelector('#sc-detail-h', { timeout: 15000 }).catch(() => null)));
      await page.keyboard.press('Escape'); await waitCards(page);

      /* the other views */
      await page.click('#scHost [data-sc-view="dna"]');
      await page.waitForSelector('#scHost .sc-dna', { timeout: 15000 });
      const dnaTxt = await page.textContent('#sc-body');
      chk('Model DNA lists the stored records with their grades', /(Validated|Partial|Early|Experimental|Unvalidated)/.test(dnaTxt) && (await state(page)).hash === '#signals/dna', dnaTxt.slice(0, 160));
      chk('…and never offers raw win rate as quality', /Raw win rate is not a measure of model quality/.test(dnaTxt));
      await page.click('#scHost [data-sc-view="coverage"]');
      await page.waitForSelector('#scHost .sc-cov', { timeout: 10000 });
      const cov = await page.textContent('#sc-body');
      chk('Coverage shows every sport and an honest blocked state', /NFL/.test(cov) && /College football/.test(cov) && /MLB/.test(cov) && /blocked/i.test(cov), cov.slice(0, 200));
      await page.click('#scHost [data-sc-view="method"]');
      await page.waitForSelector('#scHost .sc-tbl', { timeout: 15000 });
      chk('Method prints the scoring specification from the engine (loaded on demand)', /sc_importance_v1/.test(await page.textContent('#sc-body')) && await page.evaluate(() => !!window.EDSignalEngine));
      await page.click('#scHost [data-sc-view="alerts"]');
      await page.waitForSelector('#scHost form[data-sc-prefs]', { timeout: 10000 });
      await page.check('#scHost input[name="sports"][value="nfl"]');
      await page.selectOption('#scHost select[name="min_label"]', 'Major');
      await page.click('#scHost form[data-sc-prefs] button[type="submit"]');
      await page.waitForFunction(() => /Saved/.test((document.getElementById('sc-prefs-msg') || {}).textContent || ''), null, { timeout: 10000 }).catch(() => null);
      const saved = JSON.parse(q(`select json_build_object('min', min_label, 'sports', sports)::text from public.sc_preferences where user_id = '${S.users.SUB}';`));
      chk('alert preferences save through the door', saved.min === 'Major' && saved.sports.indexOf('nfl') >= 0, saved);

      /* a bell notice opens its signal */
      const alert = q(`select id || '|' || (payload->>'href') from public.user_alerts where user_id = '${S.users.SUB}' and payload->>'source' = 'signal_center' order by id limit 1;`);
      chk('the subscriber has a Signal Center notice in the bell', /^\d+\|#signals\/s\/\d+$/.test(alert), alert);
      if (/^\d+\|/.test(alert)) {
        const [aid, href] = alert.split('|');
        await page.evaluate(([a, h]) => window.EDMine && window.EDMine.alertSignal(+a, h), [aid, href]);
        await page.waitForSelector('#sc-detail-h', { timeout: 15000 }).catch(() => null);
        chk('Open in Signal Center opens that signal', (await state(page)).hash === href, await state(page));
        chk('…and marks the notice read', !!q(`select read_at from public.user_alerts where id = ${aid};`));
      }

      /* the old alias */
      await page.evaluate(() => { location.hash = '#signal-center'; });
      await page.waitForTimeout(800);
      st = await state(page);
      chk('#signal-center lands on Signal Center under #signals', st.views.join() === 'v-signals' && st.hash === '#signals', st);
      /* leaving clears the hash; old routes still land */
      await page.click('.bottomnav button[data-v="portfolio"]');
      await page.waitForTimeout(500);
      st = await state(page);
      chk('leaving for Portfolio writes #portfolio', st.views.join() === 'v-portfolio' && st.hash === '#portfolio', st);
      await page.evaluate(() => { location.hash = '#signals/s/' + 1e9; });
      await page.waitForTimeout(1200);
      chk('an unknown signal id says it is not available', /not available/.test(await page.textContent('#sc-body')));
      chk('a full session ran without a script error', errors.length === 0, errors);
      await ctx.close();
    }

    /* ============================================================ preview: signed in, no Full Access
       (a signed-out visitor never reaches the terminal: its login gate sends them
       to the landing page, and the public page /signals/ is their preview —
       tools/signal_center/public.e2e.js) */
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await ctx.route('**/*', STAGE.router(S, {}));
      const page = await ctx.newPage();
      await page.goto(`http://127.0.0.1:${port}/app.html#signals`, { waitUntil: 'domcontentloaded' });
      await page.waitForURL(/index\.html/, { timeout: 15000 }).catch(() => null);
      chk('signed out: the terminal\'s login gate still sends a visitor to the landing page', /\/index\.html/.test(page.url()), page.url());
      await ctx.close();
    }
    for (const who of ['free']) {
      const { ctx, page, errors, calls } = await open({ width: 390, height: 844 }, '#signals', who);
      await waitCards(page);
      const cs = await cards(page);
      chk(who + ': the preview shows signals, locked', cs.length > 0 && cs.every((c) => c.locked), cs.length);
      chk(who + ': no preview card carries a number', cs.every((c) => !DIGIT_CLAIM.test(c.text)), cs.filter((c) => DIGIT_CLAIM.test(c.text)).map((c) => c.text.slice(0, 120)));
      chk(who + ': the preview offers the plans, not a fake number', /See plans|Full Access/.test(await page.textContent('#sc-body')));
      const lim = JSON.parse(q("select value::text from public.sc_config where key = 'free';"));
      chk(who + ': the preview holds at most the configured number of signals', cs.length <= lim.feed_limit, { n: cs.length, limit: lim.feed_limit });
      chk(who + ': the feed door is asked, and answers a preview', calls.some((c) => /sc_feed$/.test(c)), calls);
      const id = q("select signal_id from public.sc_signals where publication = 'PUBLISHED' and lifecycle = 'ACTIVE' order by score desc limit 1;");
      await page.evaluate((i) => { location.hash = '#signals/s/' + i; }, id);
      await page.waitForTimeout(1500);
      const body = await page.textContent('#sc-body');
      chk(who + ': the evidence door does not hand over numbers', !DIGIT_CLAIM.test(body) && (/Full Access|Sign in|not available|See the numbers/.test(body)), body.slice(0, 200));
      chk(who + ': no horizontal scroll', await noHScroll(page));
      await shot(page, 'preview-' + who);
      chk(who + ': no script errors', errors.length === 0, errors);
      await ctx.close();
    }

    /* ============================================================ an operator */
    {
      const { ctx, page, errors } = await open({ width: 1280, height: 900 }, '#signals', 'admin');
      await waitCards(page);
      chk('operator: the status bar names the operator view', /Live/.test(await page.textContent('#sc-status')));
      await page.evaluate(() => { const d = document.querySelector('#scHost .sc-filters'); if (d) d.open = true; const m = document.querySelector('#scHost .sc-more'); if (m) m.open = true; });
      chk('operator: verification and shadow filters are offered', !!(await page.$('#scHost select[data-sc-filter="verification"]')) && !!(await page.$('#scHost input[data-sc-filter="include_shadow"]')));
      if (shadowN > 0) {
        await page.check('#scHost input[data-sc-filter="include_shadow"]');
        await page.waitForTimeout(1000);
        chk('operator: shadow signals appear when asked for, marked SHADOW', /SHADOW/.test(await page.textContent('#sc-body')));
      }
      await page.evaluate((id) => { location.hash = '#signals/s/' + id; }, withGfx);
      await page.waitForSelector('#sc-detail-h', { timeout: 15000 });
      chk('operator: the evidence carries the operator actions', !!(await page.$('#scHost [data-sc-admin="hold"]')) && !!(await page.$('#scHost [data-sc-admin="withdraw"]')));
      page.once('dialog', (d) => d.accept('e2e: checking the hold path'));
      await page.click('#scHost [data-sc-admin="hold"]');
      await page.waitForTimeout(1200);
      chk('operator: hold is applied by the server and audited', q(`select publication from public.sc_signals where signal_id = ${withGfx};`) === 'HELD'
        && +q(`select count(*) from public.sc_signal_events where signal_id = ${withGfx} and kind = 'held';`) === 1);
      await page.click('#scHost [data-sc-admin="publish"]');
      await page.waitForTimeout(1200);
      chk('operator: publish restores it', q(`select publication from public.sc_signals where signal_id = ${withGfx};`) === 'PUBLISHED');
      chk('operator: no script errors', errors.length === 0, errors);
      await ctx.close();
    }
    /* a non-operator cannot use the operator door even by calling it */
    {
      const r = await S.stand.fetch('http://standin/rest/v1/rpc/sc_admin_act', { method: 'POST', headers: { authorization: 'Bearer tok_sub' }, body: JSON.stringify({ p_signal: +withGfx, p_action: 'withdraw', p_reason: 'not mine to withdraw' }) });
      chk('a subscriber calling the operator door is refused by the server', !r.ok && q(`select publication from public.sc_signals where signal_id = ${withGfx};`) === 'PUBLISHED', r.status);
    }

    /* ============================================================ landing */
    {
      let o = await open({ width: 390, height: 844 }, '', 'sub', { fresh: true });
      await waitCards(o.page); await o.page.waitForTimeout(600);
      let st = await state(o.page);
      chk('landing: a new reader lands on Signal Center when it is live', st.views.join() === 'v-signals' && st.seat.join() === 'signals', st);
      await o.ctx.close();
      o = await open({ width: 390, height: 844 }, '', 'sub', { fresh: true, notDeployed: true });
      await o.page.waitForTimeout(1500);
      st = await state(o.page);
      chk('landing: with Signal Center not deployed, a new reader is handed on to Research', st.views.join() === 'v-research' && st.seat.join() === 'research', st);
      chk('landing: …without a script error', o.errors.length === 0, o.errors);
      await o.ctx.close();
      S.db.sql("update public.sc_config set value = '\"shadow\"' where key = 'mode';");
      o = await open({ width: 390, height: 844 }, '', 'free', { fresh: true });
      await o.page.waitForTimeout(1500);
      st = await state(o.page);
      chk('landing: in shadow mode a reader is handed on to Research', st.views.join() === 'v-research', st);
      await o.ctx.close();
      o = await open({ width: 390, height: 844 }, '', 'admin', { fresh: true });
      await waitCards(o.page); await o.page.waitForTimeout(600);
      st = await state(o.page);
      chk('landing: in shadow mode an operator still lands on Signal Center', st.views.join() === 'v-signals', st);
      chk('landing: …and is told it is shadow mode', /Shadow mode/.test(await o.page.textContent('#sc-status')));
      await o.ctx.close();
      S.db.sql("update public.sc_config set value = '\"live\"' where key = 'mode';");
      o = await open({ width: 390, height: 844 }, '', 'sub', { prefs: { lastTab: 'portfolio', rememberTab: true, defaultTab: 'research' } });
      await o.page.waitForTimeout(800);
      chk('landing: a remembered tab still wins', (await state(o.page)).views.join() === 'v-portfolio');
      await o.ctx.close();
      o = await open({ width: 390, height: 844 }, '', 'sub', { prefs: { lastTab: 'signals', rememberTab: true, defaultTab: 'research' } });
      await waitCards(o.page);
      chk('landing: a reader whose last tab was Signals returns to it', (await state(o.page)).views.join() === 'v-signals');
      await o.ctx.close();
    }

    /* ============================================================ states */
    {
      const o = await open({ width: 768, height: 1024 }, '#signals', 'sub', { notDeployed: true });
      await o.page.waitForTimeout(1500);
      const t = await o.page.textContent('#scHost');
      chk('not deployed: says so, and invents nothing', /not deployed yet/.test(t) && /Nothing here is invented/.test(t) && !(await o.page.$('#scHost .sc-card')), t.slice(0, 200));
      await o.page.click('#scHost [data-sc-view="coverage"]');
      chk('not deployed: Coverage still explains what it will read', /College football/.test(await o.page.textContent('#sc-body')));
      await shot(o.page, 'not-deployed');
      chk('not deployed: no script errors', o.errors.length === 0, o.errors);
      await o.ctx.close();
    }
    {
      const o = await open({ width: 768, height: 1024 }, '#signals', 'sub');
      await waitCards(o.page);
      /* the database goes away mid-session: the last good read stays, marked stale */
      await o.ctx.route(/rpc\/sc_/, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"unavailable"}' }));
      await o.page.click('#scHost [data-sc-act="refresh"]');
      await o.page.waitForTimeout(1500);
      const t = await o.page.textContent('#scHost');
      chk('a failed refresh keeps the last good read and says so', /The last refresh failed/.test(t) || /could not be read/.test(t), t.slice(0, 240));
      chk('a failed refresh: no script errors', o.errors.length === 0, o.errors);
      await o.ctx.close();
    }
  } catch (e) {
    chk('the suite ran to the end', false, String(e && e.stack || e).slice(0, 1200));
  } finally {
    await browser.close();
    srv.close();
    S.stop();
  }
  failures.forEach((f) => console.log('FAIL | ' + f));
  console.log((fail ? 'FAILED' : 'ALL GREEN') + ' signal center browser — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
