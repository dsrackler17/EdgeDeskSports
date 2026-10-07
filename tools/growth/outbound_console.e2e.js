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
     9  RESEARCH (Phase 3): a prospect opens into each number beside its bar,
        the gates, the facts with their sources and rivals, the warnings in
        words, and the evidence history ("previously … superseded: why");
        text from the web is shown as text (no markup runs) and only an
        https: source becomes a link (noopener, noreferrer, nofollow)
    10  superseding asks why; no reason sends nothing
    11  adding evidence sends exactly what was typed; a refusal is shown
    12  fit reasons: added resting on evidence, or removed
    13  "not theirs" releases an identifier, with a reason
    14  "needs more research" and "reject" ask first
    15  "have we seen them?" finds the existing record and opens it
    16  adding a prospect sends the email, the URLs one per line, the sports
        and the first fact; a suppressed person is reported, not added
    17  before the Phase 3 SQL is applied (no fit catalogue), a prospect still
        opens; one with no assessment is never shown as clearing the gates

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
const XSS = '<img src=x onerror="window.__pwned=1">';
const DETAIL = { ok: true,
  prospect: { id: 'p1', full_name: 'Pat Analyst', first_name: 'Pat', organization: 'CFB Numbers', job_title: 'Founder', prospect_type: 'cfb_analyst', is_test: false, suppressed: false,
    email: 'pat@cfbnumbers.test', email_status: 'verified', email_confidence: 0.99, identity_confidence: 0.91, role_confidence: 0.35, research_confidence: 0.91, fit_score: 89,
    status: 'ready_for_review', warnings: ['stale:job_title', 'possible_duplicate'], gates: [],
    assessment: { evaluated_at: '2026-10-07T09:00:00Z', gates: [], thresholds: { fit: 80, identity: 0.9, role: 0.85, email: 0.9, research: 0.85 },
      fields: { full_name: { claim: 'Pat Analyst', confidence: 0.91, sources: 2, reasons: [], alternatives: [] },
                job_title: { claim: 'Founder', confidence: 0.35, sources: 1, reasons: ['conflicting_sources', 'single_source'], alternatives: [{ claim: 'Head of Data', confidence: 0.35 }] } },
      email: { kinds: ['own_site', 'owner_verified'] }, research: { from: 'draft_claims' },
      fit: { factors: [{ code: 'quant_analysis', label: 'publishes quantitative sports analysis', points: 18, evidence: [9], confidence: 0.7 },
                       { code: 'touting', label: 'sells picks or promises winnings', points: -40, evidence: [], confidence: null }] } } },
  evidence: [
    { id: 7, field_name: 'job_title', claim: 'Founder', source_url: 'https://cfbnumbers.test/about', source_kind: 'own_site', source_excerpt: 'Founder of CFB Numbers', observed_at: '2026-10-06T00:00:00Z', current: true, claim_confidence: 0.35 },
    { id: 5, field_name: 'job_title', claim: 'Head of Data', source_url: 'https://cfbnumbers.test/about', source_kind: 'own_site', source_excerpt: 'Head of Data', source_published_at: '2024-01-01T00:00:00Z',
      observed_at: '2026-10-01T00:00:00Z', current: false, superseded_at: '2026-10-06T00:00:00Z', superseded_reason: 'replaced by evidence 7', claim_confidence: null },
    { id: 9, field_name: 'project', claim: XSS, source_url: 'javascript:alert(1)', source_kind: 'publication', source_excerpt: XSS, observed_at: '2026-10-06T00:00:00Z', current: true, claim_confidence: 0.55 }],
  identifiers: [{ id: 31, kind: 'email', value: 'pat@cfbnumbers.test', strength: 'strong', first_seen: '2026-10-01T00:00:00Z' },
                { id: 32, kind: 'name_org', value: 'pat analyst|cfb numbers', strength: 'weak', first_seen: '2026-10-01T00:00:00Z' }],
  related: [{ id: 'p2', full_name: 'Ed Itor', organization: 'CFB Numbers', relation: 'possible_duplicate' }],
  drafts: [{ sequence_number: 1, subject: 'Your ratings', status: 'pending_review', claims: [{ evidence_id: 9 }] }], sends: [], activity: [] };
const CATALOG = [{ code: 'quant_analysis', label: 'publishes quantitative sports analysis', points: 18, needs_evidence: true },
                 { code: 'touting', label: 'sells picks or promises winnings', points: -40, needs_evidence: false }];
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
        if (name === 'growth_outbound_fit_catalog') return o.noCatalog ? reply(404, { code: 'PGRST202', message: 'Could not find the function' }) : reply(200, CATALOG);
        if (name === 'growth_outbound_prospect') {
          if (body.p_id === 'p1') return reply(200, DETAIL);
          return reply(200, { ok: true, prospect: { id: body.p_id, full_name: null, prospect_type: 'other', status: 'discovered', warnings: [], assessment: { gates: [] } },
            evidence: [], identifiers: [], related: [], drafts: [], sends: [], activity: [] });
        }
        if (name === 'growth_outbound_evidence_add') {
          const ev = (body.p && body.p.evidence) || [];
          if (ev.length && !/^https:/.test(ev[0].source_url)) return reply(200, { ok: false, reason: 'invalid', at: 'evidence 1', detail: 'the source must be a web page (https://…)' });
          return reply(200, { ok: true, prospect_id: body.p_prospect, created: false, evidence_ids: [99], status: 'ready_for_review', warnings: [], possible_duplicates: [] });
        }
        if (name === 'growth_outbound_evidence_supersede') return reply(200, { ok: true, status: 'ready_for_review', warnings: [] });
        if (name === 'growth_outbound_identifier_release') return reply(200, { ok: true, cleared: ['email'], status: 'needs_research' });
        if (name === 'growth_outbound_prospect_set_status') return reply(200, { ok: true, status: body.p_status, drafts_cancelled: 1 });
        if (name === 'growth_outbound_prospect_evaluate') return reply(200, { ok: true, status: 'ready_for_review' });
        if (name === 'growth_outbound_identity_lookup') {
          if (!/[@/.]/.test(body.p_text)) return reply(200, { ok: false, reason: 'not_an_email_or_url' });
          return reply(200, { ok: true, canonical: 'https://x.com/PatAnalyst', suppressed: false,
            keys: [{ kind: 'handle', value: 'x:patanalyst', strength: 'strong', matches: [{ prospect_id: 'p1', full_name: 'Pat Analyst', status: 'ready_for_review', released: false }] }] });
        }
        if (name === 'growth_outbound_prospect_upsert') {
          if (/gone@/.test(body.p && body.p.email)) return reply(200, { ok: false, reason: 'suppressed', prospect_id: null });
          return reply(200, { ok: true, prospect_id: 'p9', created: true, evidence_ids: [100], status: 'discovered', warnings: [], possible_duplicates: [] });
        }
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

  /* ── 9–16. research ─────────────────────────────────────────────────── */
  {
    const t = await open({ role: 'owner' });
    const last = (n) => t.calls.filter((c) => c[0] === n).slice(-1)[0];
    const countOf = (n) => t.calls.filter((c) => c[0] === n).length;
    await t.page.click('#tabBtnOutbound'); await settle(t.page);
    chk('9 no prospect is fetched until one is opened', countOf('growth_outbound_prospect') === 0);
    await t.page.click('[data-open="p1"]'); await settle(t.page, 600);
    chk('9 opening a prospect asks for exactly that one', countOf('growth_outbound_prospect') === 1 && last('growth_outbound_prospect')[1].p_id === 'p1');
    const dt = await text(t.page, '#obDetail');
    chk('9 the detail is shown, every gate clearing', await visible(t.page, '#obDetail') && /Every gate clears/.test(dt), dt.slice(0, 200));
    chk('9 each number beside its bar', /Identity0\.91needs 0\.9/.test(dt) && /Role0\.35aim 0\.85 · a gate only when a draft cites it/.test(dt) && /Fit89needs 80/.test(dt), dt.slice(0, 400));
    chk('9 a weak bar is marked short, a met one passing', await t.page.evaluate(() => !!document.querySelector('#obDetail .kpi.short') && !!document.querySelector('#obDetail .kpi.pass')));
    chk('9 why a fact is not more certain, and its rival claim', /sources disagree; only one independent source/.test(dt) && /Head of Data \(0\.35\)/.test(dt));
    chk('9 warnings in words', /the title or role is old/.test(dt) && /may be the same person as another prospect/.test(dt));
    chk('9 a possible duplicate is named and can be opened', /Possibly the same person as Ed Itor/.test(dt) && await visible(t.page, '#obDetail [data-open="p2"]'));
    chk('9 history: previously, superseded, and why', /previously — superseded 2026-10-06: replaced by evidence 7/.test(dt));
    chk('9 a penalty shows it needs no evidence; a positive reason cites its evidence', /\+18#9/.test(dt) && /-40— \(a penalty needs none\)/.test(dt));
    const xss = await t.page.evaluate(() => ({ pwned: window.__pwned === 1, img: !!document.querySelector('#obDetail img'), js: !!document.querySelector('a[href^="javascript"]') }));
    chk('9 text from the web is shown as text: no markup from it runs', !xss.pwned && !xss.img && dt.indexOf('<img src=x') >= 0, xss);
    chk('9 a non-https source is never a link', !xss.js);
    const a = await t.page.evaluate(() => { const x = document.querySelector('#obDetail a[href="https://cfbnumbers.test/about"]'); return x && [x.target, x.rel]; });
    chk('9 an https source is a link that opens apart, with no referrer', a && a[0] === '_blank' && /noopener/.test(a[1]) && /noreferrer/.test(a[1]) && /nofollow/.test(a[1]), a);
    await t.page.click('[data-open="pt"]'); await settle(t.page, 600);
    chk('9 a prospect the database has not assessed is never shown as clearing the gates', /Not assessed yet/.test(await text(t.page, '#obDetail'))
      && !/Every gate clears/.test(await text(t.page, '#obDetail')));
    await t.page.click('[data-open="p1"]'); await settle(t.page, 600);
    chk('9 an email can be released; the name+organization key cannot', await visible(t.page, '[data-release="31"]') && !(await t.page.$('[data-release="32"]')));
    if (SHOTS) await (await t.page.$('#obDetailWrap')).screenshot({ path: path.join(SHOTS, 'outbound-prospect.png') });

    /* 10. supersede */
    t.setAnswers(['  ']);
    await t.page.click('[data-supersede="7"]'); await settle(t.page);
    chk('10 superseding asks why; no reason sends nothing', countOf('growth_outbound_evidence_supersede') === 0 && /stays on the record as "previously"/.test(t.dialogs.slice(-1)[0].msg));
    t.setAnswers(['the site changed it']);
    await t.page.click('[data-supersede="7"]'); await settle(t.page, 600);
    const sup = last('growth_outbound_evidence_supersede');
    chk('10 with a reason, that observation is superseded, and the prospect re-read', sup && sup[1].p_evidence_id === 7 && sup[1].p_reason === 'the site changed it'
      && countOf('growth_outbound_prospect') === 4, sup);

    /* 11. add evidence */
    await t.page.click('#evAdd'); await settle(t.page);
    chk('11 a claim and its page are both needed; nothing is sent without them', countOf('growth_outbound_evidence_add') === 0 && /both needed/.test(await text(t.page, '#evMsg')));
    await t.page.selectOption('#evField', 'job_title'); await t.page.fill('#evClaim', 'Head of Research');
    await t.page.fill('#evUrl', 'ftp://cfbnumbers.test/x'); await t.page.selectOption('#evKind', 'own_profile'); await t.page.fill('#evQuote', 'Head of Research at CFB Numbers');
    await t.page.fill('#evDate', '2026-09-30');
    await t.page.click('#evAdd'); await settle(t.page);
    const ea = last('growth_outbound_evidence_add');
    chk('11 exactly what was typed is sent, to that prospect', ea && ea[1].p_prospect === 'p1' && JSON.stringify(ea[1].p) === JSON.stringify({ evidence: [{ field_name: 'job_title',
      claim: 'Head of Research', source_url: 'ftp://cfbnumbers.test/x', source_kind: 'own_profile', source_excerpt: 'Head of Research at CFB Numbers', source_published_at: '2026-09-30T00:00:00Z' }] }), ea && ea[1]);
    chk('11 the database\'s refusal is shown', /Not added: the source must be a web page/.test(await text(t.page, '#evMsg')));
    await t.page.fill('#evUrl', 'https://x.com/patanalyst'); await t.page.click('#evAdd'); await settle(t.page, 600);
    chk('11 accepted, the prospect is re-read', countOf('growth_outbound_evidence_add') === 2 && countOf('growth_outbound_prospect') === 5);

    /* 12. fit reasons */
    await t.page.selectOption('#fitCode', 'quant_analysis'); await t.page.selectOption('#fitEv', '9');
    await t.page.click('#fitAdd'); await settle(t.page, 600);
    chk('12 a reason is added resting on the chosen evidence', JSON.stringify(last('growth_outbound_evidence_add')[1].p) === JSON.stringify({ fit_factors: [{ code: 'quant_analysis', evidence: [9] }] }));
    await t.page.selectOption('#fitCode', 'touting'); await t.page.click('#fitDrop'); await settle(t.page, 600);
    chk('12 … or removed', JSON.stringify(last('growth_outbound_evidence_add')[1].p) === JSON.stringify({ fit_factors: [{ code: 'touting', remove: true }] }));
    chk('12 the email address is never offered as fit evidence', !(await t.page.$('#fitEv option[value="31"]')));

    /* 13. release */
    t.setAnswers([false]);
    await t.page.click('[data-release="31"]'); await settle(t.page);
    chk('13 "not theirs" asks first; cancelling sends nothing', countOf('growth_outbound_identifier_release') === 0);
    t.setAnswers(['belongs to the editor']);
    await t.page.click('[data-release="31"]'); await settle(t.page, 600);
    const rl = last('growth_outbound_identifier_release');
    chk('13 with a reason, that identifier is released', rl && rl[1].p_identifier_id === 31 && rl[1].p_reason === 'belongs to the editor', rl);

    /* 14. status */
    t.setAnswers(['confirm the title']);
    await t.page.click('#pdResearch'); await settle(t.page, 600);
    const ss = last('growth_outbound_prospect_set_status');
    chk('14 "needs more research" asks what, then says so to the database', ss && ss[1].p_id === 'p1' && ss[1].p_status === 'needs_research' && ss[1].p_reason === 'confirm the title', ss);
    t.setAnswers([false]);
    await t.page.click('#pdReject'); await settle(t.page);
    chk('14 "reject" asks first; cancelling sends nothing', countOf('growth_outbound_prospect_set_status') === 1);
    await t.page.click('#pdEval'); await settle(t.page, 600);
    chk('14 re-evaluate asks the database, which does the arithmetic', countOf('growth_outbound_prospect_evaluate') === 1);

    /* 15. have we seen them? */
    await t.page.fill('#obLook', 'hello'); await t.page.click('#obLookBtn'); await settle(t.page);
    chk('15 anything but an email or a web address is said to be so', /not an email address or a web address/.test(await text(t.page, '#obLookOut')));
    await t.page.fill('#obLook', 'https://m.twitter.com/PatAnalyst?s=20'); await t.page.press('#obLook', 'Enter'); await settle(t.page);
    const lo = await text(t.page, '#obLookOut');
    chk('15 a tagged mobile link is recognised as Pat, already known', /https:\/\/x\.com\/PatAnalyst/.test(lo) && /Already known: Pat Analyst \(Ready for review, by handle\)/.test(lo), lo);
    const before = countOf('growth_outbound_prospect');
    await t.page.click('#obLookOut [data-open="p1"]'); await settle(t.page, 600);
    chk('15 … and opens their record', countOf('growth_outbound_prospect') === before + 1);

    /* 16. add a prospect */
    await t.page.click('#apAdd'); await settle(t.page);
    chk('16 a prospect needs an email or a URL; nothing is sent without', countOf('growth_outbound_prospect_upsert') === 0 && /recognise again/.test(await text(t.page, '#apMsg')));
    await t.page.fill('#apEmail', 'new@new.test'); await t.page.fill('#apUrls', 'https://x.com/newperson\n https://new.test ');
    await t.page.selectOption('#apType', 'nfl_analyst'); await t.page.fill('#apSports', 'NFL, props');
    await t.page.selectOption('#apField', 'full_name'); await t.page.fill('#apClaim', 'New Person'); await t.page.fill('#apSrc', 'https://new.test/about');
    await t.page.selectOption('#apKind', 'own_site'); await t.page.fill('#apQuote', 'I am New Person');
    await t.page.click('#apAdd'); await settle(t.page, 700);
    const ap = last('growth_outbound_prospect_upsert');
    chk('16 the email, each URL, the sports and the first fact are sent — and no test flag', ap && JSON.stringify(ap[1].p) === JSON.stringify({ email: 'new@new.test',
      urls: ['https://x.com/newperson', 'https://new.test'], prospect_type: 'nfl_analyst', campaign_type: 'customer', sports_focus: ['NFL', 'props'],
      evidence: [{ field_name: 'full_name', claim: 'New Person', source_url: 'https://new.test/about', source_kind: 'own_site', source_excerpt: 'I am New Person' }] }), ap && ap[1]);
    chk('16 it says what happened and opens the new record', /Added\. Status: Discovered\./.test(await text(t.page, '#apMsg')) && last('growth_outbound_prospect')[1].p_id === 'p9');
    await t.page.fill('#apEmail', 'gone@optout.test'); await t.page.click('#apAdd'); await settle(t.page);
    chk('16 a suppressed person is reported, not added', /suppressed/.test(await text(t.page, '#apMsg')));
    chk('9-16 no page errors', t.errors.length === 0, t.errors);
    await t.ctx.close();
  }

  /* ── 17. the page ahead of its migration ─────────────────────────────── */
  {
    const t = await open({ role: 'owner', noCatalog: true });
    await t.page.click('#tabBtnOutbound'); await settle(t.page);
    await t.page.click('[data-open="p1"]'); await settle(t.page, 600);
    chk('17 without the Phase 3 fit catalogue, a prospect still opens', /Pat Analyst/.test(await text(t.page, '#obDetail')) && !/not installed/.test(await text(t.page, '#obDetailMsg')));
    chk('17 no page errors', t.errors.length === 0, t.errors);
    await t.ctx.close();
  }

  /* ── 5. an affiliate admin who is NOT an owner ─────────────────────── */
  {
    const t = await open({ role: 'admin' });
    chk('5 a non-owner admin gets the growth console', await visible(t.page, '#actKpis'));
    chk('5 … with no Outbound tab and no mode tag', !(await visible(t.page, '#tabs')) && !(await visible(t.page, '#tabBtnOutbound')) && !(await visible(t.page, '#obModeTag')));
    await t.page.evaluate(() => { window.EDOutbound.show('outbound'); window.EDOutbound.open('p1'); }); await settle(t.page);
    chk('5 even forcing the tab, or a prospect, from the console shows nothing', !(await visible(t.page, '#tabOutbound')) && !(await visible(t.page, '#obDetailWrap')));
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
    await t.page.click('[data-open="p1"]'); await settle(t.page, 600);
    const sw2 = await t.page.evaluate(() => document.documentElement.scrollWidth);
    chk('8 … nor is an open prospect (its tables scroll inside their card)', sw2 <= 391, sw2);
    if (SHOTS) await t.page.screenshot({ path: path.join(SHOTS, 'outbound-phone.png'), fullPage: false });
    chk('8 no page errors', t.errors.length === 0, t.errors);
    await t.ctx.close();
  }

  await browser.close(); site.srv.close();
  console.log((fail ? 'FAIL' : 'PASS') + ' — outbound console (browser): ' + pass + '/' + (pass + fail) + ' checks');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL — crashed: ' + (e && e.stack || e)); process.exit(1); });
