#!/usr/bin/env node
/* ===========================================================================
   /admin/content/ — THE WHOLE FLOW, IN A REAL BROWSER.

   The page is the shipped file, served from this repository, so it reads the
   REAL committed research (football/cfb_terminal, rankings, the NFL slate…).
   Supabase is not mocked away: every /rest/v1/rpc call runs in a throwaway
   PostgreSQL with supabase/content_engine.sql applied (tools/growth/_rpc_shim.js),
   and /functions/v1/content_engine runs the DEPLOYED Edge Function file in
   Node. Only Claude and the RSS feeds are stubbed. The page's clock is fixed
   at Thursday of CFB Week 6 so the committed slate is in the future.

     1  an owner signs in; a non-owner affiliate admin is turned away
     2  Discover now: research read, a trending headline matched, the
        opportunities scored (estimate labelled) and saved
     3  Write article → outline (SEO brief) → full draft: every hard check
        passes; the SEO brief shows keyword, slug, meta, demand basis
     4  Rewrite with AI: the function's version is checked and saved
     5  Submit for review → the five-point review → approve this exact version
     6  Publishing queue: export is locked before approval; after it the
        Markdown carries the UTM-tagged link and the disclaimer; record the
        send (method asked); mark published (URL asked)
     7  Performance lists the article with its campaign code; nothing claims a
        measurement it does not have
     8  at 390 px nothing overflows; no page errors anywhere

   Run: node tools/content/content_engine.e2e.js [--shots DIR]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { register } = require('node:module');
const { pathToFileURL } = require('node:url');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const { rpcShim } = require(path.join(__dirname, '..', 'growth', '_rpc_shim.js'));
const INLINE = require(path.join(__dirname, 'inline.js'));

const ROOT = PG.ROOT;
const args = process.argv.slice(2);
const SHOTS = args.indexOf('--shots') >= 0 ? args[args.indexOf('--shots') + 1] : null;
const SB = 'https://iattxbkbufslbauoumga.supabase.co';
const SKEY = 'edgedesk_content_admin_session';
const ANON = /var SB_KEY = "([^"]+)"/.exec(fs.readFileSync(path.join(ROOT, 'admin', 'content', 'index.html'), 'utf8'))[1];
const FIXED = new Date('2026-10-08T17:30:00Z');

let pass = 0, fail = 0;
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); }

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
      const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
      const type = p.endsWith('.html') ? 'text/html; charset=utf-8' : p.endsWith('.js') ? 'text/javascript; charset=utf-8' : p.endsWith('.json') ? 'application/json' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type }); res.end(fs.readFileSync(file));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}
function jwt(tag, expSec) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return b({ alg: 'HS256' }) + '.' + b({ sub: tag, exp: expSec, role: 'authenticated' }) + '.sig' + tag;
}
const nowSec = () => Math.floor(Date.now() / 1000);
const OWNER = '00000000-0000-0000-0000-0000000000e1', ADMIN = '00000000-0000-0000-0000-0000000000e2';
const T_OWNER = jwt('owner', nowSec() + 7200), T_ADMIN = jwt('admin', nowSec() + 7200);

const RSS = `<?xml version="1.0"?><rss><channel>
  <item><title>Alabama, Georgia set for SEC showdown in Tuscaloosa</title><link>https://www.espn.com/college-football/story/_/id/2/alabama-georgia</link>
    <pubDate>Thu, 08 Oct 2026 14:00:00 GMT</pubDate><description>The two programs meet Saturday night.</description></item></channel></rss>`;

(async function main() {
  let pw = null;
  try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }
  const db = PG.start('contente2e');
  if (db.skip) { console.log('SKIPPED: ' + db.skip); process.exit(0); }
  const site = await serve();
  let browser;
  try {
    ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql', 'growth_outbound.sql', 'content_engine.sql']
      .forEach((f) => db.applyFileAtomic(path.join(ROOT, 'supabase', f)));
    db.sql(`insert into auth.users (id, email, email_confirmed_at) values ('${OWNER}', 'owner@edgedesk.test', now()), ('${ADMIN}', 'admin@edgedesk.test', now());
            insert into public.affiliate_admins (user_id) values ('${OWNER}'), ('${ADMIN}');
            select growth_outbound.grant_owner('owner@edgedesk.test');`);

    /* the Edge Function, as deployed, in Node */
    register(pathToFileURL(path.join(__dirname, '..', 'growth', '_stubs', 'hooks.mjs')));
    chk('the function carries the core verbatim', !INLINE.drifted());
    const SHIM = rpcShim(db, { url: SB, users: { [T_OWNER]: { id: OWNER, email: 'owner@edgedesk.test' }, [T_ADMIN]: { id: ADMIN, email: 'admin@edgedesk.test' } } });
    const nodeFetch = async (input, init) => {
      const url = String(input);
      const viaDb = await SHIM(url, init); if (viaDb) return viaDb;
      if (url === 'https://www.espn.com/espn/rss/ncf/news') return new Response(RSS, { status: 200 });
      return new Response('unavailable', { status: 503 });
    };
    globalThis.Deno = { env: { get: () => undefined } };
    globalThis.__claude = (req) => {
      const cur = JSON.parse(/CURRENT DRAFT:\n([\s\S]*)$/.exec(String(req.messages[0].content))[1]);
      return { stop_reason: 'end_turn', model: 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify(Object.assign({}, cur, { standfirst: cur.standfirst + ' Here is what the numbers say.' })) }] };
    };
    const FNM = await import(pathToFileURL(INLINE.TARGET).href);
    const fnCfg = { url: SB, anonKey: ANON, anthropicKey: 'sk-ant-e2e-stub-key-0000', model: 'claude-opus-5-5', origins: ['http://127.0.0.1:' + site.port], fetch: nodeFetch, timeoutMs: 5000 };

    try { browser = await pw.chromium.launch({ headless: true }); }
    catch (e) {
      const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].find((x) => fs.existsSync(x));
      if (exe) browser = await pw.chromium.launch({ headless: true, executablePath: exe }); else { console.log('SKIPPED: no Chromium'); process.exit(0); }
    }
    if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
    const BASE = 'http://127.0.0.1:' + site.port;

    async function open(who, viewport) {
      const ctx = await browser.newContext({ viewport: viewport || { width: 1360, height: 950 }, acceptDownloads: true });
      await ctx.clock.setFixedTime(FIXED);
      const tok = who === 'owner' ? T_OWNER : T_ADMIN;
      const uid = who === 'owner' ? OWNER : ADMIN;
      await ctx.addInitScript(([k, v]) => { try { if (!sessionStorage.getItem('__seeded')) { localStorage.setItem(k, v); sessionStorage.setItem('__seeded', '1'); } } catch (_) {} },
        [SKEY, JSON.stringify({ access_token: tok, refresh_token: 'rt', expires_at: nowSec() + 7200, user: { id: uid, email: who + '@edgedesk.test' } })]);
      const calls = [];
      await ctx.route('**/*', async (route) => {
        const req = route.request(), url = req.url();
        if (url.startsWith(BASE)) return route.continue();
        if (url.startsWith(SB + '/rest/v1/rpc/')) {
          calls.push(url.split('/rpc/')[1]);
          const r = await SHIM(url, { method: 'POST', headers: { authorization: req.headers().authorization }, body: req.postData() || '{}' });
          return route.fulfill({ status: r.status, contentType: 'application/json', body: await r.text() });
        }
        if (url.startsWith(SB + '/functions/v1/content_engine')) {
          calls.push('fn:' + JSON.parse(req.postData() || '{}').action);
          const r = await FNM.handle(new Request(url, { method: req.method(), headers: req.headers(), body: req.method() === 'POST' ? req.postData() : undefined }), fnCfg);
          return route.fulfill({ status: r.status, contentType: 'application/json', body: await r.text() });
        }
        if (/auth\/v1\/logout/.test(url)) return route.fulfill({ status: 204, body: '' });
        return route.fulfill({ status: 200, contentType: 'text/css', body: '' }); /* fonts and the rest of the web */
      });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      return { ctx, page, calls, errors };
    }

    /* 1 · a non-owner is turned away */
    const adm = await open('admin');
    await adm.page.goto(BASE + '/admin/content/');
    await adm.page.waitForSelector('#gMsg:not(:empty)', { timeout: 15000 });
    chk('1 a non-owner sees the gate, not the app', await adm.page.isHidden('#app') && /not a Content Engine owner/.test(await adm.page.textContent('#gMsg')));
    chk('1 … and the page asked nothing but the owner check', adm.calls.every((c) => c === 'content_engine_is_owner'), adm.calls);
    await adm.ctx.close();

    /* 1 · the owner */
    const o = await open('owner');
    const P = o.page;
    const dialogs = [];
    P.on('dialog', async (d) => {
      const m = d.message(); dialogs.push(m);
      if (/How did you send it/.test(m)) return d.accept('manual_email');
      if (/note for the record/.test(m)) return d.accept('sent by the owner, e2e');
      if (/published article’s URL/.test(m)) return d.accept('https://www.stadiumrant.com/college-football-week-6-predictions');
      return d.accept();
    });
    await P.goto(BASE + '/admin/content/');
    await P.waitForSelector('#app:not(.hide)', { timeout: 15000 });
    chk('1 the owner is in', await P.isVisible('#kpis .kpi'));

    /* 2 · discover */
    await P.click('#dGo');
    await P.waitForFunction(() => /opportunities: \d+ new/.test(document.getElementById('dMsg').textContent), null, { timeout: 120000 });
    const dmsg = await P.textContent('#dMsg');
    chk('2 discovery read the research and saved the opportunities', /CFB week 6/.test(dmsg) && /NFL week 5/.test(dmsg), dmsg);
    chk('2 the trending feed was read through the function', /headlines read/.test(dmsg) && o.calls.indexOf('fn:trending') >= 0, dmsg);
    await P.waitForSelector('#oList .opp');
    const listText = await P.textContent('#oList');
    chk('2 the queue shows the CFB Week 6 preview', /College Football Week 6 Predictions/.test(listText));
    chk('2 demand is labelled an estimate', /demand: estimate/.test(listText));
    chk('2 the headline became a trending opportunity with its source', +db.sql(`select count(*) from content_engine.opportunities where kind = 'trending_story' and sources::text like '%espn.com/college-football/story%';`) === 1);
    if (SHOTS) await P.screenshot({ path: path.join(SHOTS, '1-opportunities.png'), fullPage: false });

    /* 3 · write it */
    const oppId = db.sql(`select id from content_engine.opportunities where key = 'cfb:2026:w6:weekly_preview';`);
    await P.click('#oList button[data-act="write"][data-id="' + oppId + '"]');
    await P.waitForSelector('#tab-gen:not(.hide)');
    await P.selectOption('#gFormat', 'cfb_weekly_preview');
    await P.click('#gOutline');
    await P.waitForSelector('#gOutlineOut:not(.hide)');
    const brief = await P.textContent('#gOutlineOut');
    chk('3 the SEO brief: keyword, slug, meta, demand basis, links', /college football week 6 predictions/.test(brief) && /college-football-week-6-predictions/.test(brief) && /ESTIMATE/.test(brief) && /Today’s Games/.test(brief));
    await P.click('#gDraft');
    await P.waitForSelector('#gEditor:not(.hide) #eChecks', { timeout: 30000 });
    chk('3 the draft is saved and every hard check passes', /all hard checks pass/.test(await P.textContent('#eChecks')), await P.textContent('#eChecks'));
    const art = JSON.parse(db.sql(`select to_jsonb(a) from content_engine.articles a order by created_at desc limit 1;`));
    chk('3 … as a draft for Stadium Rant, created by the owner', art.status === 'draft' && art.created_by === 'owner' && /^ce_stadiumrant_/.test(art.campaign_code));
    chk('3 the preview shows the disclaimer and the tagged link', /1-800-GAMBLER/.test(await P.textContent('#ePreview')) && /utm_campaign=ce_stadiumrant_/.test(await P.innerHTML('#ePreview')));
    if (SHOTS) await P.screenshot({ path: path.join(SHOTS, '2-editor.png'), fullPage: false });

    /* 4 · AI rewrite */
    await P.click('#gEditor button[data-act="aiall"]');
    await P.waitForFunction(() => /passed every check and was saved/.test(document.getElementById('eMsg').textContent), null, { timeout: 60000 });
    const art2 = JSON.parse(db.sql(`select to_jsonb(a) from content_engine.articles a where id = '${art.id}';`));
    chk('4 the AI version was checked and saved as a new revision', art2.revision === 2 && /^claude:/.test(art2.generator) && /what the numbers say/.test(art2.standfirst));

    /* 5 · review and approve */
    await P.click('#gEditor button[data-act="submit"]');
    await P.waitForFunction(() => /In review/.test(document.getElementById('eMsg').textContent), null, { timeout: 15000 });
    await P.click('.tabs button[data-tab="review"]');
    await P.waitForSelector('#rList button[data-open]');
    await P.click('#rList button[data-open]');
    await P.waitForSelector('#rDetail [data-rv]');
    chk('5 the review shows the sources, the model numbers and the export preview', /EdgeDesk research/.test(await P.textContent('#rDetail')) && /Model numbers to verify/.test(await P.textContent('#rDetail')));
    await P.click('#rApprove');
    await P.waitForFunction(() => /Confirm all five/.test(document.getElementById('rMsg').textContent), null, { timeout: 15000 });
    chk('5 approval refuses an incomplete review', db.sql(`select status from content_engine.articles where id = '${art.id}';`) === 'in_review');
    for (const k of ['source_verification', 'data_freshness', 'model_accuracy', 'seo_review', 'compliance']) await P.check('#rDetail [data-rv="' + k + '"]');
    await P.click('#rApprove');
    await P.waitForFunction(() => /Approved/.test(document.getElementById('rMsg').textContent), null, { timeout: 15000 });
    chk('5 approved, by the owner, for the version on screen', db.sql(`select status || '|' || approved_by::text || '|' || (approved_hash = content_hash)::text from content_engine.articles where id = '${art.id}';`) === 'approved|' + OWNER + '|true');
    if (SHOTS) await P.screenshot({ path: path.join(SHOTS, '3-review.png'), fullPage: false });

    /* 6 · publishing queue */
    await P.click('.tabs button[data-tab="pub"]');
    await P.waitForSelector('#pCols button[data-open="' + art.id + '"]');
    await P.click('#pCols button[data-open="' + art.id + '"]');
    await P.waitForSelector('#pDetail button[data-q="ready"]');
    chk('6 approved: export unlocked', !(await P.isDisabled('#pDetail button[data-q="md"]')));
    await P.click('#pDetail button[data-q="ready"]');
    await P.waitForSelector('#pDetail button[data-q="sent"]');
    const [dl] = await Promise.all([P.waitForEvent('download'), P.click('#pDetail button[data-q="md"]')]);
    const md = fs.readFileSync(await dl.path(), 'utf8');
    chk('6 the Markdown export: front matter, headline, sections', /^---\ntitle: "College Football Week 6 Predictions/.test(md) && /## How to read these numbers/.test(md) && /### No\. 6 Georgia at No\. 11 Alabama/.test(md), md.slice(0, 300));
    chk('6 … the UTM-tagged EdgeDesk link and the disclaimer', /utm_source=stadiumrant&utm_medium=publisher&utm_campaign=ce_stadiumrant_[0-9a-f]{12}/.test(md) && /21\+\. Gamble responsibly — 1-800-GAMBLER/.test(md));
    chk('6 … and no pick language', !/best bet|lock of|guarantee|our pick/i.test(md));
    if (SHOTS) fs.writeFileSync(path.join(SHOTS, 'export.md'), md);
    const [dl2] = await Promise.all([P.waitForEvent('download'), P.click('#pDetail button[data-q="html"]')]);
    const html = fs.readFileSync(await dl2.path(), 'utf8');
    chk('6 the HTML export is a clean, standalone document with no script', /^<!doctype html>/.test(html) && !/<script/i.test(html) && /<h2>How to read these numbers<\/h2>/.test(html));
    chk('6 each export is logged', +db.sql(`select count(*) from content_engine.events where kind = 'exported' and article_id = '${art.id}';`) === 2);
    await P.click('#pDetail button[data-q="sent"]');
    await P.waitForFunction(() => /Done/.test((document.getElementById('qMsg') || {}).textContent || ''), null, { timeout: 15000 });
    chk('6 record as sent asks how, and records it', dialogs.some((d) => /How did you send it/.test(d)) && db.sql(`select method || '|' || note from content_engine.deliveries where article_id = '${art.id}';`) === 'manual_email|sent by the owner, e2e');
    await P.click('#pDetail button[data-q="published"]');
    await P.waitForFunction(() => /Done/.test((document.getElementById('qMsg') || {}).textContent || ''), null, { timeout: 15000 });
    chk('6 published, with its URL', db.sql(`select status || '|' || published_url from content_engine.articles where id = '${art.id}';`) === 'published|https://www.stadiumrant.com/college-football-week-6-predictions');

    /* 7 · performance */
    await P.click('.tabs button[data-tab="perf"]');
    await P.waitForSelector('#perfOut table');
    const perf = await P.textContent('#perfOut');
    chk('7 the article is listed with its campaign code', perf.indexOf(art.campaign_code) >= 0);
    chk('7 the three kinds of numbers are named apart', /first-party/.test(await P.textContent('#tab-perf')) && /publisher-reported/i.test(await P.textContent('#tab-perf')) && /Benchmarks/.test(perf));

    /* 8 · settings, phone width, errors */
    await P.click('.tabs button[data-tab="set"]');
    await P.waitForFunction(() => /AI drafting is configured/.test(document.getElementById('aiStatus').textContent), null, { timeout: 15000 });
    chk('8 settings say whether AI is configured (never the key)', !/sk-ant/.test(await P.textContent('#tab-set')));
    await P.setViewportSize({ width: 390, height: 844 });
    await P.click('.tabs button[data-tab="opps"]');
    await P.waitForSelector('#oList .opp');
    const over = await P.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    chk('8 at 390 px nothing overflows horizontally', over <= 1, over);
    if (SHOTS) await P.screenshot({ path: path.join(SHOTS, '4-phone.png'), fullPage: false });
    chk('8 no page errors', o.errors.length === 0, o.errors);
    await o.ctx.close();
  } catch (e) {
    chk('the suite reached its end — ' + String(e && e.stack || e).slice(0, 800), false);
  } finally {
    if (browser) await browser.close();
    site.srv.close();
    db.stop();
    console.log((fail ? 'FAIL' : 'PASS') + ' | content engine e2e | ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
  }
})();
