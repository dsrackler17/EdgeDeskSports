#!/usr/bin/env node
/* ===========================================================================
   /admin/content/ — THE WHOLE FLOW, IN A REAL BROWSER.

   The page is the shipped file, served from this repository, so it reads the
   REAL committed research (football/cfb_terminal, rankings, the NFL slate…).
   Supabase is not mocked away: every /rest/v1/rpc call runs in a throwaway
   PostgreSQL with supabase/content_engine.sql applied (tools/growth/_rpc_shim.js),
   and /functions/v1/content_engine runs the DEPLOYED Edge Function file in
   Node. Only Claude, Resend and the RSS feeds are stubbed. The page's clock is fixed
   at Thursday of CFB Week 6 so the committed slate is in the future.

     1  an owner signs in; a non-owner affiliate admin is turned away
     2  Discover now: research read, a trending headline matched, the
        opportunities scored (estimate labelled) and saved
     3  Write article → outline (SEO brief) → full draft: every hard check
        passes; the SEO brief shows keyword, slug, meta, demand basis
     4  Rewrite with AI: the function's version is checked and saved
     5  Submit for review → the editorial gate runs on the version under
        review: the Week 6 preview is BLOCKED on its two unexplained market
        gaps, Approve is locked; the owner records a written review of each
        (kept with the article), the gate re-runs to WARNING → the five-point
        review → approve this exact version (the gate re-runs first)
     6  Publishing queue: export is locked before approval; after it the
        Markdown carries the UTM-tagged link and the disclaimer. Send: the
        publisher's contact is added under Publishers; a test goes to the
        owner and changes nothing; the real send waits for "ready", names the
        address and asks first, emails the approved article with its files,
        and records it as sent; mark published (URL asked)
     6b Send it yourself: a second article, approved, downloaded as a Word
        file (opened and checked), saved as a PDF (the print view: the clean
        article, the print dialog), then "Mark as sent" with one
        confirmation; nothing is emailed
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
const DX = require(path.join(__dirname, '_docx.js'));

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
    const RESEND = [];
    const nodeFetch = async (input, init) => {
      const url = String(input);
      const viaDb = await SHIM(url, init); if (viaDb) return viaDb;
      if (url === 'https://api.resend.com/emails') {
        RESEND.push({ headers: Object.assign({}, init.headers), body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ id: 're_e2e_' + RESEND.length }), { status: 200 });
      }
      if (url === 'https://www.espn.com/espn/rss/ncf/news') return new Response(RSS, { status: 200 });
      return new Response('unavailable', { status: 503 });
    };
    globalThis.Deno = { env: { get: () => undefined } };
    globalThis.__claude = (req) => {
      const cur = JSON.parse(/CURRENT DRAFT:\n([\s\S]*)$/.exec(String(req.messages[0].content))[1]);
      return { stop_reason: 'end_turn', model: 'claude-opus-5-5', usage: { input_tokens: 9000, output_tokens: 3000 }, content: [{ type: 'text', text: JSON.stringify(Object.assign({}, cur, { standfirst: cur.standfirst + ' Here is what the numbers say.' })) }] };
    };
    const FNM = await import(pathToFileURL(INLINE.TARGET).href);
    const fnCfg = { url: SB, anonKey: ANON, anthropicKey: 'sk-ant-e2e-stub-key-0000', resendKey: 're_e2e_stub_key_0000', model: 'claude-opus-5-5', origins: ['http://127.0.0.1:' + site.port], fetch: nodeFetch, timeoutMs: 5000 };

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
      if (/What did you check\?/.test(m)) return d.accept('Checked the gap: no availability or line news on file explains it; the article states it as unexplained.');
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
    await P.waitForSelector('#rGate .pill.bad');
    const gateText = await P.textContent('#rGate');
    chk('5 the gate ran on this version: BLOCKED on the two unexplained market gaps, with evidence and a fix', /BLOCKED/.test(gateText) && /Ole Miss at Vanderbilt/.test(gateText) && /UCLA at Oregon/.test(gateText) && /Evidence:/.test(gateText) && /Fix:/.test(gateText), gateText.slice(0, 400));
    chk('5 … stored with the version it judged', db.sql(`select gate_verdict || '|' || (gate_hash = content_hash)::text from content_engine.articles where id = '${art.id}';`) === 'BLOCKED|true');
    chk('5 … and Approve is locked', await P.isDisabled('#rApprove'));
    if (SHOTS) await P.screenshot({ path: path.join(SHOTS, '3a-gate-blocked.png'), fullPage: false });
    for (let i = 0; i < 2; i++) {
      await P.click('#rGate button[data-ack]');
      await P.waitForFunction((n) => /Review recorded/.test(document.getElementById('rMsg').textContent) && document.querySelectorAll('#rGate button[data-unack]').length === n, i + 1, { timeout: 30000 });
    }
    chk('5 the owner’s two written reviews are on record, with the note', db.sql(`select count(*) from content_engine.articles a, jsonb_each(a.acks) k where a.id = '${art.id}' and k.key like 'discrepancy:%' and k.value ->> 'note' like 'Checked the gap%';`) === '2');
    await P.waitForSelector('#rGate .pill.warn');
    chk('5 the gate re-ran: WARNING, each gap marked reviewed by the owner', /WARNING/.test(await P.textContent('#rGate')) && /Reviewed by the owner/.test(await P.textContent('#rGate'))
      && db.sql(`select gate_verdict from content_engine.articles where id = '${art.id}';`) === 'WARNING');
    await P.waitForFunction(() => !document.getElementById('rApprove').disabled, null, { timeout: 15000 });
    await P.click('#rApprove');
    await P.waitForFunction(() => /Confirm all five/.test(document.getElementById('rMsg').textContent), null, { timeout: 15000 });
    chk('5 approval refuses an incomplete review', db.sql(`select status from content_engine.articles where id = '${art.id}';`) === 'in_review');
    for (const k of ['source_verification', 'data_freshness', 'model_accuracy', 'seo_review', 'compliance']) await P.check('#rDetail [data-rv="' + k + '"]');
    await P.click('#rApprove');
    await P.waitForFunction(() => /Approved/.test(document.getElementById('rMsg').textContent), null, { timeout: 15000 });
    chk('5 approved, by the owner, for the version on screen', db.sql(`select status || '|' || approved_by::text || '|' || (approved_hash = content_hash)::text from content_engine.articles where id = '${art.id}';`) === 'approved|' + OWNER + '|true');
    if (SHOTS) await P.screenshot({ path: path.join(SHOTS, '3-review.png'), fullPage: false });

    /* 6 · the publisher's contact, then the publishing queue */
    await P.click('.tabs button[data-tab="pubs"]');
    await P.waitForSelector('#pbList button[data-edit]');
    await P.click('#pbList button[data-edit]');
    await P.waitForSelector('#pbAddC');
    await P.click('#pbAddC');
    const crow = P.locator('#pbContacts .crow').last();
    await crow.locator('[data-c=name]').fill('Jordan Editor');
    await crow.locator('[data-c=role]').fill('editor');
    await crow.locator('[data-c=email]').fill('jordan@publisher.example');
    await P.click('#pbAddC');
    const crow2 = P.locator('#pbContacts .crow').last();
    await crow2.locator('[data-c=name]').fill('Pat Writer');
    await crow2.locator('[data-c=email]').fill('Pat@Publisher.example');
    await P.click('#pbSave');
    await P.waitForFunction(() => /Saved/.test(document.getElementById('pbMsg').textContent), null, { timeout: 15000 });
    chk('6 the contact is saved on the publisher (owner-only)', /jordan@publisher\.example/.test(db.sql(`select contacts::text from content_engine.publishers where slug = 'stadium-rant';`)));

    await P.click('.tabs button[data-tab="pub"]');
    await P.waitForSelector('#pCols button[data-open="' + art.id + '"]');
    await P.click('#pCols button[data-open="' + art.id + '"]');
    await P.waitForSelector('#pDetail button[data-q="ready"]');
    chk('6 approved: export unlocked', !(await P.isDisabled('#pDetail button[data-q="md"]')));
    const panel = await P.textContent('#pDetail');
    chk('6 the send panel: To the contact, from the edgedesksports.com sender', /Send to Stadium Rant/.test(panel) && /Jordan Editor — jordan@publisher\.example/.test(panel) && /From Davis <davis@edgedesksports\.com>/.test(panel), panel.slice(0, 600));
    chk('6 … the real send is locked until it is marked ready', await P.isDisabled('#pDetail button[data-q="email"]'));
    chk('6 … the note greets the contact by first name', /^Hi Jordan,/.test(await P.inputValue('#sNote')));
    await P.selectOption('#sTo', 'pat@publisher.example');
    chk('6 … choosing another contact changes the button and the greeting', /^Send to Pat$/.test(await P.textContent('#pDetail button[data-q="email"]')) && /^Hi Pat,/.test(await P.inputValue('#sNote')));
    await P.selectOption('#sTo', 'jordan@publisher.example');

    await P.click('#pDetail button[data-q="emailtest"]');
    await P.waitForFunction(() => /Test sent to/.test((document.getElementById('qMsg') || {}).textContent || ''), null, { timeout: 30000 });
    chk('6 a test goes to the owner only, after asking', RESEND.length === 1 && RESEND[0].body.to[0] === 'owner@edgedesk.test' && dialogs.some((d) => /Send a TEST of/.test(d) && /owner@edgedesk\.test/.test(d)), RESEND.map((e) => e.body.to));
    chk('6 … and changes nothing about the article', db.sql(`select status from content_engine.articles where id = '${art.id}';`) === 'approved' && +db.sql(`select count(*) from content_engine.deliveries where article_id = '${art.id}';`) === 0);

    await P.click('#pDetail button[data-q="ready"]');
    await P.waitForSelector('#pDetail button[data-q="email"]:not([disabled])');
    chk('6 ready to send: the real send unlocks; recording a send made elsewhere stays available', await P.isVisible('#pDetail button[data-q="sent"]'));
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
    if (SHOTS) await P.screenshot({ path: path.join(SHOTS, '4-send.png'), fullPage: false });

    await P.fill('#sSubj', 'College Football Week 6 Predictions — for Stadium Rant');
    await P.click('#pDetail button[data-q="email"]');
    await P.waitForFunction(() => /Recorded as sent/.test((document.getElementById('qMsg') || {}).textContent || ''), null, { timeout: 30000 });
    const em = RESEND[1] || { headers: {}, body: {} };
    chk('6 Send asks first, naming the address', dialogs.some((d) => /^Email “College Football Week 6 Predictions/.test(d) && /Jordan Editor <jordan@publisher\.example>/.test(d)));
    chk('6 … one email to the contact, with the subject as typed, from the sender', RESEND.length === 2 && em.body.to.length === 1 && em.body.to[0] === 'jordan@publisher.example'
      && em.body.subject === 'College Football Week 6 Predictions — for Stadium Rant' && em.body.from === 'Davis <davis@edgedesksports.com>', em.body.to);
    const files = (em.body.attachments || []).map((x) => x.filename);
    chk('6 … the note, the approved article with its tagged link and disclaimer, and four files, the Word copy first', /<p>Hi Jordan,<\/p>/.test(em.body.html || '') && /utm_campaign=ce_stadiumrant_/.test(em.body.html) && /1-800-GAMBLER/.test(em.body.html)
      && files.length === 4 && files.every((f) => f.indexOf(art.slug) === 0) && /\.docx$/.test(files[0]), files);
    chk('6 … with the database’s idempotency key, and no key anywhere on the page', /^edgedesk-content-[0-9a-f]{32}$/.test(em.headers['idempotency-key']) && !/re_e2e_stub_key/.test(await P.content()));
    chk('6 recorded: sent, an email delivery, the send on record', db.sql(`select a.status || '|' || d.method || '|' || s.status from content_engine.articles a join content_engine.deliveries d on d.article_id = a.id join content_engine.sends s on s.article_id = a.id and not s.is_test where a.id = '${art.id}';`) === 'sent|email|sent');
    chk('6 the page shows it sent, with the email in its history', /Sent/.test(await P.textContent('#pDetail')) && /To Jordan Editor <jordan@publisher\.example> · sent/.test(await P.textContent('#pDetail')));
    await P.click('#pDetail button[data-q="published"]');
    await P.waitForFunction(() => /Done/.test((document.getElementById('qMsg') || {}).textContent || ''), null, { timeout: 15000 });
    chk('6 published, with its URL', db.sql(`select status || '|' || published_url from content_engine.articles where id = '${art.id}';`) === 'published|https://www.stadiumrant.com/college-football-week-6-predictions');

    /* 6b · send it yourself: the Word file, then one click */
    await P.click('.tabs button[data-tab="opps"]');
    await P.waitForSelector('#oList .opp');
    const opp2 = db.sql(`select id from content_engine.opportunities where league = 'nfl' and kind = 'weekly_preview' order by priority desc limit 1;`);
    await P.click('#oList button[data-act="write"][data-id="' + opp2 + '"]');
    await P.waitForSelector('#tab-gen:not(.hide)');
    await P.selectOption('#gFormat', 'nfl_weekly_preview');
    await P.click('#gDraft');
    /* the editor still shows the first article until the new draft is saved: wait for THIS one */
    await P.waitForFunction(() => { const t = document.getElementById('eTitle'), e = document.getElementById('eChecks');
      return t && /^NFL Week/.test(t.value) && e && /all hard checks pass/.test(e.textContent); }, null, { timeout: 30000 });
    const art3 = JSON.parse(db.sql(`select to_jsonb(a) from content_engine.articles a where opportunity_id = '${opp2}' order by created_at desc limit 1;`));
    await P.click('#gEditor button[data-act="submit"]');
    await P.waitForFunction(() => /In review/.test(document.getElementById('eMsg').textContent), null, { timeout: 15000 });
    await P.click('.tabs button[data-tab="review"]');
    await P.waitForSelector('#rList button[data-open="' + art3.id + '"]');
    await P.click('#rList button[data-open="' + art3.id + '"]');
    await P.waitForSelector('#rDetail [data-rv]');
    for (const k of ['source_verification', 'data_freshness', 'model_accuracy', 'seo_review', 'compliance']) await P.check('#rDetail [data-rv="' + k + '"]');
    await P.click('#rApprove');
    await P.waitForFunction(() => /Approved/.test(document.getElementById('rMsg').textContent), null, { timeout: 15000 });
    await P.click('.tabs button[data-tab="pub"]');
    await P.waitForSelector('#pCols button[data-open="' + art3.id + '"]');
    await P.click('#pCols button[data-open="' + art3.id + '"]');
    await P.waitForSelector('#pDetail button[data-q="sent"]');
    chk('6b approved: “Send it yourself” offers the Word file and “Mark as sent”, no ready step needed', /Send it yourself/.test(await P.textContent('#pDetail')) && /email it to Jordan from your own inbox/.test(await P.textContent('#pDetail'))
      && await P.isVisible('#pDetail button[data-q="sent"]'));
    if (SHOTS) await P.screenshot({ path: path.join(SHOTS, '5-send-yourself.png'), fullPage: false });
    const [dlw] = await Promise.all([P.waitForEvent('download'), P.locator('#pDetail button[data-q="docx"]').last().click()]);
    chk('6b the download is a .docx named for the article', dlw.suggestedFilename() === art3.slug + '.docx', dlw.suggestedFilename());
    const wbytes = fs.readFileSync(await dlw.path());
    if (SHOTS) fs.writeFileSync(path.join(SHOTS, dlw.suggestedFilename()), wbytes);
    let wfiles = {}, werr = null;
    try { wfiles = DX.unzip(wbytes); } catch (e) { werr = String(e.message); }
    const wparas = wfiles['word/document.xml'] ? DX.paragraphs(wfiles['word/document.xml'].toString('utf8')) : [];
    chk('6b the Word file opens: every part checks out', !werr && Object.keys(wfiles).length === 7 && Object.keys(wfiles).every((n) => DX.wellFormed(wfiles[n].toString('utf8'))), werr);
    chk('6b … the approved article: headline, sections, disclaimer, the editor’s page', wparas[0] && wparas[0].style === 'Title' && wparas[0].text === art3.title
      && wparas.some((x) => x.style === 'Heading2') && wparas.some((x) => /21\+\. Gamble responsibly — 1-800-GAMBLER/.test(x.text)) && wparas.some((x) => x.text === 'For the editor (not for publication)'));
    chk('6b … with the tagged EdgeDesk link live', /Target="https:\/\/edgedesksports\.com\/[^"]*utm_source=stadiumrant&amp;utm_medium=publisher&amp;utm_campaign=ce_stadiumrant_[0-9a-f]{12}/.test(wfiles['word/_rels/document.xml.rels'] ? wfiles['word/_rels/document.xml.rels'].toString('utf8') : ''));
    chk('6b … and the download is logged', +db.sql(`select count(*) from content_engine.events where kind = 'exported' and article_id = '${art3.id}' and detail ->> 'as' = 'docx';`) === 1);
    /* Save as PDF: the print view in its own window (print() counted, not run) */
    await P.evaluate(() => { const o = window.open; window.open = function () { const w = o.apply(window, arguments); if (w) w.print = function () { window.__printed = (window.__printed || 0) + 1; }; return w; }; });
    const [pop] = await Promise.all([P.waitForEvent('popup'), P.locator('#pDetail button[data-q="pdf"]').last().click()]);
    await P.waitForFunction(() => window.__printed === 1, null, { timeout: 10000 });
    const printed = await pop.content();
    chk('6b Save as PDF opens the clean article and the print dialog (Save as PDF)', /<h1>NFL Week 5 Predictions/.test(printed) && /1-800-GAMBLER/.test(printed) && !/<script/i.test(printed)
      && /utm_campaign=ce_stadiumrant_[0-9a-f]{12}/.test(printed) && /Save as PDF/.test(await P.textContent('#qMsg')));
    chk('6b … and is logged', +db.sql(`select count(*) from content_engine.events where kind = 'exported' and article_id = '${art3.id}' and detail ->> 'as' = 'pdf';`) === 1);
    await pop.close();
    const before = RESEND.length;
    await P.click('#pDetail button[data-q="sent"]');
    await P.waitForFunction(() => /Done/.test((document.getElementById('qMsg') || {}).textContent || ''), null, { timeout: 15000 });
    chk('6b “Mark as sent” asks once, then records it: emailed by the owner', dialogs.some((d) => /^Mark “/.test(d) && /as sent to Stadium Rant/.test(d))
      && db.sql(`select a.status || '|' || d.method || '|' || d.note from content_engine.articles a join content_engine.deliveries d on d.article_id = a.id where a.id = '${art3.id}';`) === 'sent|manual_email|sent by the owner: i emailed it myself');
    chk('6b … and EdgeDesk emailed nothing for it', RESEND.length === before && +db.sql(`select count(*) from content_engine.sends where article_id = '${art3.id}';`) === 0);

    /* 7 · performance */
    await P.click('.tabs button[data-tab="perf"]');
    await P.waitForSelector('#perfOut table');
    const perf = await P.textContent('#perfOut');
    chk('7 the article is listed with its campaign code', perf.indexOf(art.campaign_code) >= 0);
    await P.waitForSelector('#scOut table');
    const sc = await P.textContent('#scOut');
    chk('7 the scorecard lists every target with goal, needed-now, actual and status', (sc.match(/(met|on track|behind|not measured)/g) || []).length >= 13
      && /Publisher-ready articles a week/.test(sc) && /Paid subscribers a month \(direct\)/.test(sc) && /Bottleneck:/.test(sc), sc.slice(0, 300));
    chk('7 … production counted from the record: two articles sent', /Sent\s*2/.test(sc.replace(/\s+/g, ' ')) || /Sent2/.test(sc), sc.slice(0, 600));
    chk('7 nothing reads NaN, null or undefined', !/\b(NaN|undefined|null)\b/.test(sc));
    await P.fill('#ccAmt', '0.5'); await P.selectOption('#ccCat', 'ai_billed');
    await P.click('#ccAdd');
    await P.waitForFunction(() => /AI cost, billed \(entered\)\s*\$0\.50/.test(document.getElementById('scOut').textContent), null, { timeout: 15000 });
    chk('7 a billed AI cost is recorded, kept apart from the estimate, and used instead of it', db.sql(`select category || '|' || amount_usd || '|' || basis from content_engine.costs;`) === 'ai_billed|0.50|billed'
      && /AI: billed amounts you entered/.test(await P.textContent('#scOut')));
    chk('7 the three kinds of numbers are named apart', /first-party/.test(await P.textContent('#tab-perf')) && /publisher-reported/i.test(await P.textContent('#tab-perf')) && /Benchmarks/.test(perf));

    /* 8 · settings, phone width, errors */
    await P.click('.tabs button[data-tab="set"]');
    await P.waitForFunction(() => /AI drafting is configured/.test(document.getElementById('aiStatus').textContent), null, { timeout: 15000 });
    chk('8 settings say whether AI is configured (never the key)', !/sk-ant/.test(await P.textContent('#tab-set')));
    await P.waitForSelector('#aiBudget #abBudget');
    const ab = await P.textContent('#aiBudget');
    chk('8 the AI budget: the month’s committed spend from the one call, at list price, against $10', /\$0\.10/.test(ab) && /of \$10\.00/.test(ab) && /not your invoice/.test(ab), ab.slice(0, 300));
    chk('8 … the call is in the ledger, settled with its token counts', db.sql(`select operation || '|' || status || '|' || outcome || '|' || input_tokens || '|' || est_usd from content_engine.ai_calls;`) === 'draft|completed|accepted|9000|0.096000');
    chk('8 … and the KPI strip shows it, labelled an estimate', /AI this month\s*\$0\.10 \/ \$10\.00\s*estimated, not billed/.test(await P.textContent('#kpis')), await P.textContent('#kpis'));
    chk('8 … and whether sending is, with the sender (never the key)', /Send to publisher is configured/.test(await P.textContent('#aiStatus')) && !/re_e2e/.test(await P.textContent('#tab-set'))
      && await P.getAttribute('#sSEmail', 'placeholder') === 'davis@edgedesksports.com', await P.textContent('#aiStatus'));
    await P.setViewportSize({ width: 390, height: 844 });
    await P.click('.tabs button[data-tab="opps"]');
    await P.waitForSelector('#oList .opp');
    const over = await P.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    chk('8 at 390 px nothing overflows horizontally', over <= 1, over);
    if (SHOTS) await P.screenshot({ path: path.join(SHOTS, '6-phone.png'), fullPage: false });
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
