#!/usr/bin/env node
/* ===========================================================================
   /admin/growth/ — THE OUTBOUND TAB, IN A REAL BROWSER (admin/growth/outbound.js).

   Supabase mocked; the page is the shipped file.

     1  an OWNER sees the Outbound tab; TEST MODE is marked in the header and
        on the tab, with the test inbox; what blocks sending is said in words;
        "sent automatically" is zero; prospects show their emails
     2  raising the daily cap: the dialog states both numbers; declining sends
        NOTHING; accepting sends the confirmation flag with the new value
     3  leaving test mode must be typed (LIVE); anything else sends nothing;
        once live, the header says LIVE
     4  suppressing asks first, then calls the suppress door with the scope
     5  an AFFILIATE ADMIN WHO IS NOT AN OWNER: no tab, no header tag, and the
        only outbound call the page ever makes is growth_outbound_is_owner
     6  an owner demoted mid-session is refused by the database and the tab
        disappears
     7  sign-out removes the tab and the mode tag
     8  at 390 px the tab fits the screen; no page errors anywhere

   Run:  node tools/growth/outbound_console.e2e.js [--shots <dir>]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const SHOTS = args.indexOf('--shots') >= 0 ? args[args.indexOf('--shots') + 1] : null;
const SKEY = 'edgedesk_growth_admin_session';

let pass = 0, fail = 0;
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); }

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
      const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
      const type = p.endsWith('.html') ? 'text/html; charset=utf-8' : p.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
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

const ACTIVATION = { window_days: 90, trials: 0, activated_trials: 0, activation_rate: null, paid_conversions: 0, trial_to_paid_rate: null, activated_to_paid_rate: null,
  activated_paid: 0, not_activated_to_paid_rate: null, not_activated_paid: 0, time_to_activation_hours: {}, states: {}, actions: {}, cohorts: [], settings: { weights: {}, core_kinds: [] } };
const FUNNEL = { touch: 'first', retained_rule: '2+ paid invoices', rows: [], totals: {} };
const SAMPLES = { samples: [], candidates: [] };

function freshSettings() {
  return { automation_enabled: false, test_mode: true, test_inbox: 'owner-test@edgedesk.test', daily_prospect_target: 15, max_sends_per_day: 20, max_test_sends_per_day: 25,
    min_fit_score: 80, min_identity_confidence: 0.9, min_role_confidence: 0.85, min_research_confidence: 0.85, min_email_confidence: 0.9,
    followup_enabled: true, followup_delay_days: 5, final_followup_enabled: false, final_followup_delay_days: 10,
    sender_name: 'Davis', sender_email: 'davis@edgedesksports.com', reply_to_email: null, cta_url: 'https://edgedesksports.com/', business_name: 'EdgeDesk Sports',
    postal_address: null, unsubscribe_url_base: null, discovery_config: {},
    send_blockers: ['postal_address_missing', 'unsubscribe_endpoint_missing'], today: { live_sends: 0, test_sends: 0, cap: 20, test_cap: 25 } };
}
const PROSPECTS = { total: 2, rows: [
  { id: 'p1', full_name: 'Pat Analyst', organization: 'CFB Numbers', prospect_type: 'cfb_analyst', sports_focus: ['CFB'], fit_score: 88, identity_confidence: 0.95, role_confidence: 0.9,
    email_confidence: 0.95, research_confidence: 0.9, email: 'pat@cfbnumbers.test', email_status: 'verified', status: 'ready_for_review', updated_at: '2026-10-05T12:00:00Z', is_test: false, suppressed: false },
  { id: 'pt', full_name: 'TEST PROSPECT', organization: null, prospect_type: 'other', sports_focus: [], fit_score: null, email: 'owner-test@edgedesk.test', email_status: 'verified',
    status: 'ready_for_review', updated_at: '2026-10-05T12:00:00Z', is_test: true, suppressed: false }] };

(async function main() {
  let pw = null;
  try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }
  const site = await serve();
  let browser;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) {
    const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].find((x) => fs.existsSync(x));
    if (exe) browser = await pw.chromium.launch({ headless: true, executablePath: exe }); else { console.log('SKIPPED: no Chromium'); process.exit(0); }
  }
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const BASE = 'http://127.0.0.1:' + site.port;

  /* role: 'owner' | 'admin' ; demoteAfter: number of outbound data calls before the owner is refused */
  async function open(o) {
    const ctx = await browser.newContext({ viewport: o.viewport || { width: 1280, height: 900 } });
    const T = jwt(o.role, nowSec() + 3600);
    await ctx.addInitScript(([k, v]) => { try { if (!sessionStorage.getItem('__seeded')) { localStorage.setItem(k, v); sessionStorage.setItem('__seeded', '1'); } } catch (_) {} },
      [SKEY, JSON.stringify({ access_token: T, refresh_token: 'rt', expires_at: nowSec() + 3600, user: { id: o.role + '-id', email: o.role + '@edgedesk.test' } })]);
    const calls = [];
    let st = freshSettings(), outboundData = 0;
    await ctx.route('**/*', async (route) => {
      const req = route.request(), url = req.url();
      if (url.indexOf('127.0.0.1') >= 0) return route.continue();
      const reply = (s, b) => route.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(b) });
      if (/auth\/v1\/logout/.test(url)) { calls.push(['logout']); return route.fulfill({ status: 204, body: '' }); }
      const m = /rest\/v1\/rpc\/([a-z_]+)/.exec(url);
      if (!m) return route.fulfill({ status: 204, body: '' });
      const name = m[1], body = JSON.parse(req.postData() || '{}');
      calls.push([name, body]);
      if (name === 'growth_is_admin') return reply(200, true);
      if (name === 'growth_admin_activation') return reply(200, ACTIVATION);
      if (name === 'growth_admin_funnel') return reply(200, FUNNEL);
      if (name === 'growth_admin_samples') return reply(200, SAMPLES);
      if (name === 'growth_outbound_is_owner') return reply(200, o.role === 'owner');
      if (name.indexOf('growth_outbound_') === 0) {
        outboundData++;
        if (o.role !== 'owner' || (o.demoteAfter != null && outboundData > o.demoteAfter)) return reply(403, { code: '42501', message: 'outbound owner only' });
        if (name === 'growth_outbound_settings') return reply(200, st);
        if (name === 'growth_outbound_overview') return reply(200, { settings: st, prospects_by_status: { ready_for_review: 2, needs_research: 3 }, drafts_pending_review: 2, drafts_approved_unsent: 0, sends_7d_by_status: {}, suppressions: 1, discovered_today: 4 });
        if (name === 'growth_outbound_prospects') return reply(200, PROSPECTS);
        if (name === 'growth_outbound_suppressions') return reply(200, [{ created_at: '2026-10-05T11:00:00Z', scope: 'address', target: 'no@thanks.test', kind: 'unsubscribe', source: 'owner', reason: 'asked' }]);
        if (name === 'growth_outbound_activity') return reply(200, [{ at: '2026-10-05T11:00:00Z', actor_kind: 'owner', action: 'settings_changed', entity: 'settings', entity_id: '1', detail: { x: 1 } }]);
        if (name === 'growth_outbound_suppress') return reply(200, { ok: true, id: 9, prospects_suppressed: 1, drafts_cancelled: 1 });
        if (name === 'growth_outbound_settings_update') {
          const p = body.p || {};
          if (p.max_sends_per_day > st.max_sends_per_day && !p.confirm_cap_increase) return reply(200, { ok: false, reason: 'cap_increase_needs_confirmation' });
          if (p.test_mode === false && st.test_mode && !p.confirm_live) return reply(200, { ok: false, reason: 'going_live_needs_confirmation' });
          const changed = {};
          Object.keys(p).filter((k) => k.indexOf('confirm_') !== 0).forEach((k) => { changed[k] = { from: st[k], to: p[k] }; st[k] = p[k]; });
          return reply(200, { ok: true, changed, settings: st });
        }
      }
      return reply(404, { code: 'PGRST202', message: 'no such function' });
    });
    const page = await ctx.newPage();
    const errors = [], dialogs = [];
    let answer = [];
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
    page.on('dialog', async (d) => { dialogs.push({ type: d.type(), msg: d.message() }); const a = answer.shift(); if (a === undefined || a === false) await d.dismiss(); else await d.accept(a === true ? undefined : a); });
    await page.goto(BASE + '/admin/growth/', { waitUntil: 'load' });
    await page.waitForSelector('#app:not(.hide)', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500);
    return { ctx, page, calls, errors, dialogs, setAnswers: (a) => { answer = a; }, settings: () => st };
  }
  const visible = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && !e.closest('.hide') && e.getBoundingClientRect().height > 0; }, sel);
  const text = (page, sel) => page.evaluate((s) => (document.querySelector(s) || {}).textContent || '', sel);
  const settle = (page, ms) => page.waitForTimeout(ms || 400);
  const outboundCalls = (calls) => calls.filter((c) => /^growth_outbound_/.test(c[0])).map((c) => c[0]);

  /* ── 1–4. the owner ─────────────────────────────────────────────────── */
  {
    const t = await open({ role: 'owner' });
    chk('1 the owner sees the Outbound tab', await visible(t.page, '#tabBtnOutbound'));
    chk('1 TEST MODE is marked in the header before the tab is even opened', await visible(t.page, '#obModeTag') && /test mode/i.test(await text(t.page, '#obModeTag')));
    chk('1 … and no outbound DATA is loaded until the tab is opened', !outboundCalls(t.calls).some((n) => /overview|prospects|suppressions|activity/.test(n)));
    await t.page.click('#tabBtnOutbound'); await settle(t.page);
    chk('1 the tab opens', await visible(t.page, '#tabOutbound') && !(await visible(t.page, '#actKpis')));
    chk('1 the TEST MODE chip names the test inbox', /TEST MODE — sends go only to owner-test@edgedesk\.test/.test(await text(t.page, '#obChips')));
    chk('1 what blocks sending is said in words', await visible(t.page, '#obBlock') && /postal address/.test(await text(t.page, '#obBlock')) && /opt-out endpoint/.test(await text(t.page, '#obBlock')));
    const k = await text(t.page, '#obKpis');
    chk('1 the morning numbers, and "sent automatically" is zero', /Discovered today4/.test(k) && /Ready for review2/.test(k) && /Sent automatically0/.test(k), k);
    const pr = await text(t.page, '#obProspects');
    chk('1 prospects show their emails and confidence (owner only)', /pat@cfbnumbers\.test/.test(pr) && /0\.95/.test(pr));
    chk('1 a test prospect is marked TEST', /TEST PROSPECT\s*TEST/.test(pr));
    chk('1 suppressions and activity render', /no@thanks\.test/.test(await text(t.page, '#obSupp')) && /settings_changed/.test(await text(t.page, '#obActivity')));
    chk('1 settings render from the database', (await t.page.inputValue('#obf_max_sends_per_day')) === '20' && (await t.page.inputValue('#obf_sender_email')) === 'davis@edgedesksports.com');
    if (SHOTS) await t.page.screenshot({ path: path.join(SHOTS, 'outbound-owner.png'), fullPage: true });

    /* 2. raise the cap: decline, then accept */
    await t.page.fill('#obf_max_sends_per_day', '30');
    t.setAnswers([false]);
    await t.page.click('#obSave'); await settle(t.page);
    chk('2 raising the cap asks, with both numbers', t.dialogs.length === 1 && /from 20 to 30/.test(t.dialogs[0].msg), t.dialogs);
    chk('2 declining sends nothing to the database', !t.calls.some((c) => c[0] === 'growth_outbound_settings_update') && /not confirmed/.test(await text(t.page, '#obSetMsg')));
    t.setAnswers([true]);
    await t.page.click('#obSave'); await settle(t.page);
    const up = t.calls.filter((c) => c[0] === 'growth_outbound_settings_update');
    chk('2 accepting sends the new cap WITH the confirmation flag', up.length === 1 && up[0][1].p.max_sends_per_day === 30 && up[0][1].p.confirm_cap_increase === true, up);
    chk('2 … and says what was saved', /Saved: max_sends_per_day/.test(await text(t.page, '#obSetMsg')));

    /* lowering needs no dialog */
    const before = t.dialogs.length;
    await t.page.fill('#obf_max_sends_per_day', '12'); await t.page.click('#obSave'); await settle(t.page);
    const up2 = t.calls.filter((c) => c[0] === 'growth_outbound_settings_update');
    chk('2 lowering the cap needs no confirmation and sends no flag', t.dialogs.length === before && up2.length === 2 && up2[1][1].p.max_sends_per_day === 12 && !up2[1][1].p.confirm_cap_increase);

    /* 3. leave test mode */
    await t.page.uncheck('#obf_test_mode');
    t.setAnswers(['live']);
    await t.page.click('#obSave'); await settle(t.page);
    chk('3 leaving test mode must be TYPED: "live" (lower case) is not enough, nothing is sent',
      t.calls.filter((c) => c[0] === 'growth_outbound_settings_update').length === 2 && /still in test mode/.test(await text(t.page, '#obSetMsg')));
    t.setAnswers(['LIVE']);
    await t.page.click('#obSave'); await settle(t.page);
    const up3 = t.calls.filter((c) => c[0] === 'growth_outbound_settings_update');
    chk('3 typing LIVE sends test_mode false WITH confirm_live', up3.length === 3 && up3[2][1].p.test_mode === false && up3[2][1].p.confirm_live === true, up3[2]);
    chk('3 once live, the header and the chip say LIVE', /LIVE/.test(await text(t.page, '#obModeTag')) && /LIVE — approved drafts reach real prospects/.test(await text(t.page, '#obChips')));
    if (SHOTS) await t.page.screenshot({ path: path.join(SHOTS, 'outbound-live.png') });

    /* 4. suppress */
    await t.page.fill('#supTarget', 'propslab.test'); await t.page.selectOption('#supScope', 'domain'); await t.page.selectOption('#supKind', 'do_not_contact');
    t.setAnswers([false]);
    await t.page.click('#supAdd'); await settle(t.page);
    chk('4 suppressing asks first; declining sends nothing', !t.calls.some((c) => c[0] === 'growth_outbound_suppress') && /every address at propslab\.test/.test(t.dialogs[t.dialogs.length - 1].msg));
    t.setAnswers([true]);
    await t.page.click('#supAdd'); await settle(t.page);
    const sp = t.calls.filter((c) => c[0] === 'growth_outbound_suppress');
    chk('4 accepting calls the suppress door with the scope and kind', sp.length === 1 && sp[0][1].p_target === 'propslab.test' && sp[0][1].p_scope === 'domain' && sp[0][1].p_kind === 'do_not_contact');
    chk('4 … and reports what it did', /1 prospect\(s\) marked, 1 draft\(s\) cancelled/.test(await text(t.page, '#supMsg')));

    /* 7. sign out */
    await t.page.click('#signOut'); await settle(t.page);
    chk('7 sign-out hides the tab and the mode tag', !(await visible(t.page, '#tabs')) && !(await visible(t.page, '#obModeTag')) && !(await visible(t.page, '#tabOutbound')));
    chk('1-7 no page errors for the owner', t.errors.length === 0, t.errors);
    await t.ctx.close();
  }

  /* ── 5. an affiliate admin who is NOT an owner ─────────────────────── */
  {
    const t = await open({ role: 'admin' });
    chk('5 a non-owner admin gets the growth console', await visible(t.page, '#actKpis'));
    chk('5 … with no Outbound tab and no mode tag', !(await visible(t.page, '#tabs')) && !(await visible(t.page, '#tabBtnOutbound')) && !(await visible(t.page, '#obModeTag')));
    await t.page.evaluate(() => window.EDOutbound.show('outbound')); await settle(t.page);
    chk('5 even forcing the tab from the console shows nothing', !(await visible(t.page, '#tabOutbound')));
    const ob = outboundCalls(t.calls);
    chk('5 the ONLY outbound call ever made is the owner question', ob.length === 1 && ob[0] === 'growth_outbound_is_owner', ob);
    chk('5 no page errors', t.errors.length === 0, t.errors);
    await t.ctx.close();
  }

  /* ── 6. demoted mid-session ─────────────────────────────────────────── */
  {
    const t = await open({ role: 'owner', demoteAfter: 1 });   // the header's settings read passes, then the database refuses
    await t.page.click('#tabBtnOutbound'); await settle(t.page, 600);
    chk('6 a demoted owner is told so and the tab disappears', /no longer an outbound owner/.test(await text(t.page, '#appMsg')) && !(await visible(t.page, '#tabs')) && !(await visible(t.page, '#tabOutbound')));
    chk('6 no page errors', t.errors.length === 0, t.errors);
    await t.ctx.close();
  }

  /* ── 8. a phone ─────────────────────────────────────────────────────── */
  {
    const t = await open({ role: 'owner', viewport: { width: 390, height: 844 } });
    await t.page.click('#tabBtnOutbound'); await settle(t.page);
    const sw = await t.page.evaluate(() => document.documentElement.scrollWidth);
    chk('8 at 390 px the Outbound tab is not wider than the screen', sw <= 391, sw);
    if (SHOTS) await t.page.screenshot({ path: path.join(SHOTS, 'outbound-phone.png'), fullPage: false });
    chk('8 no page errors', t.errors.length === 0, t.errors);
    await t.ctx.close();
  }

  await browser.close(); site.srv.close();
  console.log((fail ? 'FAIL' : 'PASS') + ' — outbound console (browser): ' + pass + '/' + (pass + fail) + ' checks');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL — crashed: ' + (e && e.stack || e)); process.exit(1); });
