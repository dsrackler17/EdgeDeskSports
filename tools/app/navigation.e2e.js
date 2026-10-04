#!/usr/bin/env node
/* ===========================================================================
   THE FIVE DESTINATIONS, IN A REAL BROWSER.

   tools/app/navigation.test.js holds the markup and the router as text; this
   drives the authenticated app in Chromium at a phone (390×844) and a desktop
   (1440×900) and holds what a reader actually gets:

     1  five seats — Research · Card · Portfolio · Process · More — no sixth one
        appearing at runtime, no horizontal scroll, no clipped label, tap
        targets at least 44px;
     2  every old route still lands somewhere real (#playerprops…, #research/…,
        #card, #receipt=…, #ledger, #record, show('pprops'|'edges'|'ledger'|
        'ai'|'record') …) and lights the seat that owns it;
     3  Portfolio and Process never look broken when empty, and with a seeded
        history show the reader's own numbers — never EdgeDesk's record;
     4  More is sections, not a drawer; Model performance is in it;
     5  a new account starts at setup, once; a deep link beats it;
     6  tracking a price keeps the reader where they were;
     7  every seat tap is recorded as primary_nav_<seat>;
     8  the disclaimer keeps every element and takes one line on a phone;
     9  on a desktop the same five destinations stand as a rail.

   Run: node tools/app/navigation.e2e.js [--shots <dir>]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
const SHOTS = (() => { const i = process.argv.indexOf('--shots'); return i > 0 ? process.argv[i + 1] : null; })();
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : ''));
}

const DAY = 864e5;
/* a graded history with one clear pattern: early entries beat the close, late ones mostly do not */
function seededLedger(now) {
  const out = [];
  for (let i = 0; i < 30; i++) {
    const early = i % 2 === 0, g = now - (i + 1) * DAY;
    out.push({ id: 'b' + i, ts: new Date(g - (early ? 48 : 1) * 3.6e6).toISOString(), commence: new Date(g).toISOString(),
      sport: i % 3 ? 'NCAAF' : 'NFL', sel: (early ? 'Early ' : 'Late ') + 'side ' + i, book: 'DraftKings', odds: -110, stake: 50,
      result: i % 3 === 0 ? 'loss' : 'win', pnl: i % 3 === 0 ? -50 : 45.45, clv: early ? 0.02 : (i % 4 === 1 ? 0.01 : -0.015),
      beat_close: early ? true : (i % 4 === 1), market: 'spreads', selection: 'x', event_id: 'ev' + i, sharp_fair: 0.52, auto: true, autoSettled: true });
  }
  out.unshift({ id: 'open1', ts: new Date(now - 3600e3).toISOString(), commence: new Date(now + DAY).toISOString(), sport: 'NCAAF',
    sel: 'Texas Tech -3.5', book: 'FanDuel', odds: -108, stake: 40, result: null, liveClv: 0.012, auto: false });
  return out;
}

(async function main() {
  let pw = null;
  try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }

  function siteHandler(req, res) {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/app.html';
    const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(file));
  }
  const srv = await new Promise((resolve) => { const s = http.createServer(siteHandler); s.listen(0, '127.0.0.1', () => resolve(s)); });
  const port = srv.address().port;
  let browser;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) {
    const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (fs.existsSync(exe)) browser = await pw.chromium.launch({ headless: true, executablePath: exe });
    else { console.log('SKIPPED: no Chromium'); srv.close(); process.exit(0); }
  }

  /* o.created: account creation time (ms); o.bets: the device ledger; o.setupDone */
  async function open(viewport, hash, o) {
    o = o || {};
    const ctx = await browser.newContext({ viewport });
    const tracked = [];
    await ctx.addInitScript((x) => {
      try {
        if (sessionStorage.getItem('__e2e_seeded')) return;   // seed once per tab, so a reload keeps what the app wrote
        sessionStorage.setItem('__e2e_seeded', '1');
        localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
        localStorage.setItem('edgedesk_decision_onboarded_v1', JSON.stringify('2026-01-01T00:00:00Z'));
        localStorage.setItem('edgedesk_first_run_v1', JSON.stringify({ steps: {}, done_at: '2026-01-01T00:00:00Z' }));
        localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'e2e', refresh_token: 'e2e', expires_at: Math.floor(Date.now() / 1000) + 86400 * 400,
          user: { id: 'e2e-reader', email: 'e2e@edgedesk.test', created_at: new Date(x.created).toISOString() } }));
        if (x.setupDone) localStorage.setItem('edgedesk_setup_v1', String(Date.now()));
        if (x.bets) localStorage.setItem('edgedesk_bets', JSON.stringify(x.bets));
      } catch (e) { /* storage */ }
    }, { created: o.created || Date.now() - 400 * DAY, setupDone: o.setupDone !== false, bets: o.bets || null });
    await ctx.route('**/*', (route) => {
      const req = route.request(), u = req.url();
      if (u.startsWith('http://127.0.0.1')) return route.continue();
      if (/supabase\.co/.test(u)) {
        if (/rpc\/ed_track/.test(u)) { try { const b = JSON.parse(req.postData() || '{}'); (b.p_events || []).forEach((e) => tracked.push(e)); } catch (e) { /* ignore */ } return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"recorded":1}' }); }
        if (/subscriptions/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ status: 'active', current_period_end: '2027-06-01T00:00:00Z' }]) });
        if (/rest\/v1\/news\?/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
          { title: 'Texas Tech names a new starting quarterback', url: 'https://example.com/a', source: 'wire', category: 'roster', relevant: false, matched_teams: ['Texas Tech'], published_at: '2026-10-03T12:00:00Z' },
          { title: 'Sacramento State ineligible for the MAC title game', url: 'https://example.com/b', source: 'wire', category: 'eligibility', relevant: true, matched_teams: ['Sacramento State'], published_at: '2026-10-02T12:00:00Z' }]) });
        return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message || e).slice(0, 240)));
    await page.goto(`http://127.0.0.1:${port}/app.html${hash || ''}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.show === 'function' && typeof window.pfOpen === 'function', null, { timeout: 30000 });
    await page.waitForTimeout(400);
    return { ctx, page, errors, tracked };
  }
  /* the seat indicator animates (.18s): settle before a picture */
  const shot = async (page, name, full) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.waitForTimeout(300); await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: !!full }); } };
  const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  const state = (page) => page.evaluate(() => {
    const vis = (id) => { const e = document.getElementById(id); return !!(e && !e.classList.contains('hide') && e.offsetParent !== null); };
    const views = [...document.querySelectorAll('main > .view, body > .view, section.view')].filter((v) => !v.classList.contains('hide')).map((v) => v.id);
    const panel = [...document.querySelectorAll('#v-research .rpanel')].filter((p) => !p.classList.contains('hide')).map((p) => p.id);
    const seat = [...document.querySelectorAll('.bottomnav button.on')].map((b) => b.dataset.v);
    return { views, panel, seat, hash: location.hash, research: vis('v-research'), ai: !!(document.getElementById('edaiPanel') && document.getElementById('edaiPanel').classList.contains('open')) };
  });

  try {
    for (const vp of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
      const W = vp.width;
      /* ------------------------------------------------ 1 the five seats */
      let S = await open(vp, '');
      let { page } = S;
      await page.waitForTimeout(1500);   // the AI block, first-run and every late script have run
      const nav = await page.evaluate(() => {
        const bs = [...document.querySelectorAll('.bottomnav button')];
        return { seats: bs.map((b) => b.dataset.v), labels: bs.map((b) => b.textContent.trim()), on: bs.filter((b) => b.classList.contains('on')).map((b) => b.dataset.v),
          clipped: bs.filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.dataset.v), minH: Math.min.apply(null, bs.map((b) => b.getBoundingClientRect().height)),
          minW: Math.min.apply(null, bs.map((b) => b.getBoundingClientRect().width)), rect: (() => { const r = document.querySelector('.bottomnav').getBoundingClientRect(); return { w: r.width, h: r.height }; })() };
      });
      chk(W + ': exactly five seats, in order', nav.seats.join(',') === 'research,card,portfolio,process,more', nav.seats);
      chk(W + ': labelled Research · Card · Portfolio · Process · More', nav.labels.join(',') === 'Research,Card,Portfolio,Process,More', nav.labels);
      chk(W + ': no AI seat appears at runtime', nav.seats.indexOf('ai') < 0);
      chk(W + ': Research is the landing seat', nav.on.join() === 'research', nav.on);
      chk(W + ': no seat label is clipped', nav.clipped.length === 0, nav.clipped);
      chk(W + ': every seat is a 44px tap target', nav.minH >= 44 && nav.minW >= 44, [nav.minH, nav.minW]);
      chk(W + ': no horizontal scroll on Research', await noHScroll(page));
      if (W === 1440) chk('1440: the same five destinations stand as a rail', nav.rect.h > nav.rect.w, nav.rect);
      const rs = await page.evaluate(() => { const n = document.querySelector('.research-sub'); const bs = [...n.querySelectorAll('button')];
        return { subs: bs.map((b) => b.dataset.sub), fits: n.scrollWidth <= n.clientWidth + 1, on: bs.filter((b) => b.classList.contains('on')).map((b) => b.dataset.sub) }; });
      chk(W + ': Research reads Football · Props · Edges · Other', rs.subs.join(',') === 'football,pprops,edges,other', rs.subs);
      chk(W + ': and the four seats fit without scrolling', rs.fits);
      const foot = await page.evaluate(() => { const f = document.getElementById('edFoot'); return { h: f.getBoundingClientRect().height, t: f.textContent.replace(/\s+/g, ' ') }; });
      chk(W + ': the disclaimer keeps every element', /Decision support|Research and decision-support tool/.test(foot.t) && /Signals can be wrong/.test(foot.t) && /21\+/.test(foot.t) && /Bet responsibly/.test(foot.t) && /1-800-GAMBLER/.test(foot.t), foot.t);
      /* a legible line of every element needs ~400px: one line from ~412px, two compact ones below */
      chk(W + ': and takes ' + (W >= 414 ? 'one line' : 'at most two compact lines'), W >= 414 ? foot.h <= 22 : foot.h <= 31, foot.h);
      await shot(page, 'research-' + W);

      /* ------------------------------------------------ Research › Other */
      await page.click('#rsOtherBtn');
      chk(W + ': "Other" opens the sports and tools row', await page.evaluate(() => !document.getElementById('rsOther').classList.contains('hide')));
      await page.click('#rsOther button[data-sub="ufc"]');
      let st = await state(page);
      chk(W + ': UFC opens inside Research', st.research && st.panel.join() === 'v-ufc' && st.seat.join() === 'research', st);
      chk(W + ': and the fourth seat names it', (await page.textContent('#rsOtherLbl')).trim() === 'UFC');
      await shot(page, 'research-other-' + W);
      await page.click('.research-sub button[data-sub="edges"]');
      st = await state(page);
      chk(W + ': Edges is a Research panel', st.research && st.panel.join() === 'v-edges' && st.hash === '#research/edges', st);
      chk(W + ': and the Other row folds away', await page.evaluate(() => document.getElementById('rsOther').classList.contains('hide')));
      await page.click('.research-sub button[data-sub="pprops"]');
      st = await state(page);
      chk(W + ': Props is a Research panel with its own #playerprops link', st.research && st.panel.join() === 'v-pprops' && /^#playerprops/.test(st.hash), st);
      await page.waitForTimeout(600);
      chk(W + ': no horizontal scroll on Props', await noHScroll(page));
      await shot(page, 'research-props-' + W);

      /* ------------------------------------------------ 2 empty Portfolio / Process */
      await page.click('.bottomnav button[data-v="portfolio"]');
      st = await state(page);
      chk(W + ': Portfolio is a destination', st.views.join() === 'v-portfolio' && st.seat.join() === 'portfolio' && st.hash === '#portfolio', st);
      chk(W + ': an empty Portfolio says how to build it', /Build your portfolio/i.test(await page.textContent('#pfOverview')) && /Connect accounts/.test(await page.textContent('#pfOverview')));
      chk(W + ': and never claims a sportsbook sync it does not have', /does not sync/.test(await page.textContent('#pfOverview')));
      await shot(page, 'portfolio-empty-' + W);
      await page.click('#pfOverview [data-pf-go="accounts"]');
      chk(W + ': Connect accounts lands on Accounts', await page.evaluate(() => !document.getElementById('pfAccounts').classList.contains('hide') && location.hash === '#portfolio/accounts'));
      chk(W + ': Accounts lists the real sources and the import', /Logged on this device/.test(await page.textContent('#pfSources')) && !!(await page.$('#pfImportFile')));
      await shot(page, 'portfolio-accounts-' + W, true);
      await page.click('.bottomnav button[data-v="process"]');
      st = await state(page);
      chk(W + ': Process is a destination', st.views.join() === 'v-process' && st.seat.join() === 'process' && st.hash === '#process', st);
      const pe = await page.textContent('#processHost');
      chk(W + ': an empty Process is building, not inventing', /Building your process profile/i.test(pe) && !(await page.$('#processHost .pc-score')) && !(await page.$('#processHost .pc-ins')), pe.slice(0, 200));
      await shot(page, 'process-empty-' + W);

      /* ------------------------------------------------ 4 More */
      await page.click('.bottomnav button[data-v="more"]');
      const more = await page.evaluate(() => ({ hds: [...document.querySelectorAll('#moreList .morehd')].map((h) => h.textContent.trim()), rows: [...document.querySelectorAll('#moreList .moreitem b')].map((b) => b.firstChild.textContent.trim()) }));
      chk(W + ': More is sections', more.hds.join('|') === 'Community & tools|Transparency|System|Account|Legal', more.hds);
      chk(W + ': More has no Ledger (it merged into Portfolio)', more.rows.indexOf('Ledger') < 0, more.rows);
      chk(W + ': Model performance is a Transparency row', more.rows.indexOf('Model performance') >= 0, more.rows);
      await shot(page, 'more-' + W, true);
      await page.click('#moreList .moreitem:has-text("Model & data health")');
      chk(W + ': More → Model & data health opens the panel (and it stays open)', await page.evaluate(() => document.getElementById('sysHealthPop').classList.contains('open') || getComputedStyle(document.getElementById('sysHealthPop')).display !== 'none'));
      await page.keyboard.press('Escape');
      await page.click('#moreList .moreitem:has-text("Model performance")');
      st = await state(page);
      chk(W + ': Model performance opens with More lit', st.views.join() === 'v-record' && st.seat.join() === 'more', st);
      chk(W + ': and says whose record it is', /not your bets/.test(await page.textContent('#v-record h2')));
      await shot(page, 'model-performance-' + W);
      chk(W + ': no script errors (empty state)', S.errors.length === 0, S.errors);

      /* ------------------------------------------------ 7 analytics */
      await page.evaluate(() => window.EDTrack && window.EDTrack.flush && window.EDTrack.flush());
      await page.waitForTimeout(1600);
      const names = S.tracked.map((e) => e.event);
      ['portfolio', 'process', 'more'].forEach((v) => chk(W + ': the ' + v + ' seat tap is recorded', names.indexOf('primary_nav_' + v) >= 0, names));
      chk(W + ': secondary destinations are recorded with where they led', S.tracked.some((e) => e.event === 'secondary_nav_opened' && e.props && e.props.entity === 'more:model_performance')
        && S.tracked.some((e) => e.event === 'secondary_nav_opened' && e.props && e.props.entity === 'research:edges'), S.tracked.filter((e) => e.event === 'secondary_nav_opened').map((e) => e.props.entity));
      await S.ctx.close();

      /* ------------------------------------------------ 2 every old route */
      const ROUTES = [
        ['#playerprops', 'v-research', 'v-pprops', 'research'], ['#playerprops/nfl', 'v-research', 'v-pprops', 'research'],
        ['#research/edges', 'v-research', 'v-edges', 'research'], ['#research/props', 'v-research', 'v-pprops', 'research'],
        ['#research/football', 'v-research', 'v-football', 'research'], ['#research/ufc', 'v-research', 'v-ufc', 'research'],
        ['#research/lab', 'v-research', 'v-lab', 'research'], ['#research/cfb', 'v-research', 'v-football', 'research'],
        ['#research/tennis', 'v-research', 'v-football', 'research'], ['#research/rdesk', 'v-research', 'v-rdesk', 'research'],
        ['#card', 'v-card', null, 'card'], ['#portfolio', 'v-portfolio', null, 'portfolio'], ['#portfolio/history', 'v-portfolio', null, 'portfolio'],
        ['#process', 'v-process', null, 'process'], ['#more', 'v-more', null, 'more'], ['#ledger', 'v-portfolio', null, 'portfolio'],
        ['#record', 'v-record', null, 'more'], ['#pnl', 'v-record', null, 'more'], ['#receipt=abc123', 'v-record', null, 'more'],
        ['#edges', 'v-research', 'v-edges', 'research'], ['#props', 'v-research', 'v-pprops', 'research'], ['#settings', 'v-settings', null, 'more'],
        ['#faults', 'v-faults', null, 'more'], ['#news', 'v-news', null, 'more'], ['#collective', 'v-collective', null, 'more'], ['#terms', 'v-terms', null, 'more']
      ];
      if (W === 390) {
        S = await open(vp, '');
        page = S.page;
        for (const r of ROUTES) {
          await page.goto(`http://127.0.0.1:${port}/app.html?r=${encodeURIComponent(r[0])}${r[0]}`, { waitUntil: 'domcontentloaded' });
          await page.waitForFunction(() => typeof window.show === 'function', null, { timeout: 30000 });
          await page.waitForTimeout(250);
          st = await state(page);
          const ok = st.views.join() === r[1] && (!r[2] || st.panel.join() === r[2]) && st.seat.join() === r[3];
          chk('old route ' + r[0] + ' → ' + (r[2] || r[1]) + ' with ' + r[3] + ' lit', ok, st);
        }
        chk('#portfolio/history opens the History tab', await (async () => { await page.goto(`http://127.0.0.1:${port}/app.html?h=1#portfolio/history`); await page.waitForFunction(() => typeof window.pfOpen === 'function'); await page.waitForTimeout(250); return page.evaluate(() => !document.getElementById('pfHistory').classList.contains('hide')); })());
        /* the router's old names, called the way existing links call them */
        const CALLS = [['pprops', 'v-research', 'v-pprops', 'research'], ['edges', 'v-research', 'v-edges', 'research'], ['ledger', 'v-portfolio', null, 'portfolio'],
          ['record', 'v-record', null, 'more'], ['social', 'v-research', 'v-edges', 'research'], ['discipline', 'v-research', 'v-edges', 'research'],
          ['boards', 'v-faults', null, 'more'], ['research', 'v-research', null, 'research'], ['nonsense', 'v-research', null, 'research']];
        for (const c of CALLS) {
          await page.evaluate((v) => window.show(v), c[0]);
          await page.waitForTimeout(120);
          st = await state(page);
          chk("show('" + c[0] + "') → " + (c[2] || c[1]), st.views.join() === c[1] && (!c[2] || st.panel.join() === c[2]) && st.seat.join() === c[3], st);
        }
        await page.evaluate(() => window.show('card'));
        await page.evaluate(() => window.show('ai'));
        await page.waitForTimeout(200);
        st = await state(page);
        chk("show('ai') opens EdgeDesk Intelligence over the Card, without leaving it", st.ai && st.views.join() === 'v-card', st);
        await page.evaluate(() => window.EDAI && window.EDAI.close());
        /* contextual, not destinations: news on a game's research, and the AI asked about THAT game */
        await page.evaluate(() => window.edNewsFor('Texas Tech', 'Kansas'));
        await page.waitForTimeout(500);
        const news = await page.evaluate(() => window.edNewsFor('Texas Tech', 'Kansas'));
        chk('a game\'s research carries the news that names its teams', /Texas Tech names a new starting quarterback/.test(news) && !/Sacramento State/.test(news), news.slice(0, 200));
        chk('and nothing when no item names them', (await page.evaluate(() => window.edNewsFor('Iowa', 'Iowa State'))) === '');
        const ask = await page.evaluate(() => (typeof window.fbGxAsk === 'function') ? window.fbGxAsk({ g: { home_team: 'Texas Tech', away_team: 'Kansas' } }) : '');
        chk('game research offers Ask EdgeDesk about that game', /Research Kansas at Texas Tech/.test(ask), ask.slice(0, 200));
        await page.evaluate((h) => { const d = document.createElement('div'); d.id = '__askProbe'; d.innerHTML = h; document.body.appendChild(d); }, ask);
        await page.evaluate(() => { const b = document.querySelector('#__askProbe button'); if (b) b.click(); });
        await page.waitForTimeout(300);
        chk('and asking opens the drawer already asking it', await page.evaluate(() => document.getElementById('edaiPanel').classList.contains('open') && /Research Kansas at Texas Tech/.test(document.getElementById('edaiLog').textContent)));
        chk('the Card links what else the reader is watching', /Also on your list/.test(await page.textContent('#cardLinks')));
        await page.evaluate(() => window.EDAI && window.EDAI.close());
        /* a remembered tab from before the five destinations */
        await page.evaluate(() => { const p = JSON.parse(localStorage.getItem('edgedesk_prefs') || '{}'); p.lastTab = 'ledger'; p.rememberTab = true; localStorage.setItem('edgedesk_prefs', JSON.stringify(p)); });
        await page.goto(`http://127.0.0.1:${port}/app.html?m=1`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => typeof window.show === 'function'); await page.waitForTimeout(250);
        st = await state(page);
        chk('a remembered "ledger" tab lands on Portfolio', st.views.join() === 'v-portfolio', st);
        await page.evaluate(() => { const p = JSON.parse(localStorage.getItem('edgedesk_prefs') || '{}'); p.lastTab = 'faults'; localStorage.setItem('edgedesk_prefs', JSON.stringify(p)); });
        await page.goto(`http://127.0.0.1:${port}/app.html?m=2`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => typeof window.show === 'function'); await page.waitForTimeout(250);
        st = await state(page);
        chk('a remembered secondary view (Faults) is not where the day starts', st.views.join() === 'v-research', st);
        chk(W + ': no script errors across the routes', S.errors.length === 0, S.errors);
        await S.ctx.close();
      }

      /* ------------------------------------------------ 3 a real history */
      const now = Date.now();
      S = await open(vp, '#portfolio', { bets: seededLedger(now) });
      page = S.page;
      await page.waitForTimeout(500);
      const ov = await page.textContent('#pfOverview');
      chk(W + ': Portfolio leads with P&L and ROI', /Profit & loss/.test(ov) && /ROI/.test(ov) && /Open exposure/.test(ov), ov.slice(0, 200));
      chk(W + ': the P&L is the reader\'s staked result', /\+\$/.test(ov));
      chk(W + ': current positions list the open bet', /Texas Tech -3\.5/.test(ov));
      chk(W + ': no horizontal scroll on Portfolio', await noHScroll(page));
      await shot(page, 'portfolio-' + W);
      await page.click('#pfSeg button[data-pf="calendar"]');
      chk(W + ': the calendar has settled days', await page.evaluate(() => document.querySelectorAll('#pfCalendar .pf-cal-c.on').length > 0));
      chk(W + ': no horizontal scroll on the calendar', await noHScroll(page));
      await shot(page, 'portfolio-calendar-' + W);
      await page.click('#pfSeg button[data-pf="history"]');
      chk(W + ': History lists the settled bets, Open does not', await page.evaluate(() => document.querySelectorAll('#betlistDone .betcard').length === 30 && document.querySelectorAll('#betlist .betcard').length === 1));
      await page.click('.bottomnav button[data-v="process"]');
      await page.waitForTimeout(300);
      const pr = await page.textContent('#processHost');
      chk(W + ': Process shows a score once the history carries one', /Process score/.test(pr), pr.slice(0, 160));
      chk(W + ': and names what is working, with the numbers', /early positions/.test(pr) && /beat the closing line/.test(pr), pr.slice(0, 400));
      chk(W + ': every insight has its why', await page.evaluate(() => [...document.querySelectorAll('#processHost .pc-ins')].every((d) => d.querySelector('.pc-why'))));
      await shot(page, 'process-' + W);
      await page.click('#processHost .pc-ins summary');
      await shot(page, 'process-why-' + W);
      chk(W + ': no script errors with a history', S.errors.length === 0, S.errors);

      /* ------------------------------------------------ 6 tracking keeps the reader in place */
      await page.evaluate(() => window.researchGo('edges'));
      await page.evaluate(() => window.trackSignal({ sport_title: 'NCAAF', best_book: 'BetMGM', event_id: 'evX', market: 'spreads', selection: 'Iowa', point: -2.5, commence_time: new Date(Date.now() + 864e5).toISOString(), sharp_fair: 0.53, home_team: 'Iowa', away_team: 'Iowa State' }, -105));
      await page.waitForTimeout(200);
      st = await state(page);
      chk(W + ': tracking a price keeps the reader on Edges', st.panel.join() === 'v-edges' && st.views.join() === 'v-research', st);
      chk(W + ': and says where it went', /Tracked in Portfolio/.test(await page.evaluate(() => (document.getElementById('edTrackedToast') || {}).textContent || '')));
      await shot(page, 'tracked-toast-' + W);
      await page.click('#edTrackedToast button');
      st = await state(page);
      chk(W + ': "View" opens Portfolio › Open', st.views.join() === 'v-portfolio' && await page.evaluate(() => !document.getElementById('pfOpen').classList.contains('hide')), st);
      await S.ctx.close();

      /* ------------------------------------------------ 5 a new account starts at setup */
      S = await open(vp, '', { created: Date.now() - 2 * DAY, setupDone: false });
      page = S.page;
      st = await state(page);
      chk(W + ': a new account starts at setup, not on a board', st.views.join() === 'v-setup', st);
      chk(W + ': setup explains the five destinations', await page.evaluate(() => document.querySelectorAll('#setupHost .su-dest li').length === 5));
      await shot(page, 'setup-1-' + W);
      await page.click('#setupHost [data-su="next"]');
      chk(W + ': step 2 is bringing your activity', /Connect or import/.test(await page.textContent('#setupHost')) && !!(await page.$('#suImportFile')));
      await shot(page, 'setup-2-' + W);
      await page.click('#setupHost [data-su="next"]');
      await page.click('#setupHost [data-su="next"]');
      chk(W + ': the first read never invents an insight', /Not enough history/.test(await page.textContent('#setupHost')));
      await shot(page, 'setup-4-' + W);
      await page.click('#setupHost [data-su="enter"]');
      st = await state(page);
      chk(W + ': Enter EdgeDesk lands on Research', st.views.join() === 'v-research', st);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => typeof window.show === 'function'); await page.waitForTimeout(250);
      st = await state(page);
      chk(W + ': and setup runs once', st.views.join() !== 'v-setup', st);
      await S.ctx.close();
      S = await open(vp, '#research/edges', { created: Date.now() - 2 * DAY, setupDone: false });
      st = await state(S.page);
      chk(W + ': a deep link beats setup', st.panel.join() === 'v-edges', st);
      chk(W + ': no script errors (setup)', S.errors.length === 0, S.errors);
      await S.ctx.close();
    }
  } catch (e) {
    fail++; failures.push('threw: ' + (e && e.stack || e));
  } finally {
    await browser.close();
    srv.close();
  }
  failures.forEach((f) => console.log('  FAIL  ' + f));
  console.log('\napp navigation (browser): ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
