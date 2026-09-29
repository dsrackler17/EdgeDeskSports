#!/usr/bin/env node
/* ===========================================================================
   THE TRIAL EMAILS — words and the sender, offline.

     1  each of the four emails builds from the REAL board fixture (the
        public_home_board() answer tools/home/home_sql.test.js saved, and the
        committed football/home/board.json) and passes the copy rule;
     2  the renewal reminder states the charge date and the amount Stripe
        holds (else the plan's price), says how to cancel, carries no research
        teaser and no unsubscribe (it is a billing notice);
     3  the tips carry a working unsubscribe link, the footer carries 21+,
        1-800-GAMBLER and the postal address;
     4  a stale price never appears in an email; a props reader gets props
        first; day 3 counts only what changed since the previous visit;
     5  the copy rule refuses pick words, profit and urgency — and lets the
        product's own refusals through;
     6  the sender: nothing without secrets, nothing while switched off, one
        Resend call per claimed row with an Idempotency-Key per row, every row
        marked, a refused email never sent, a dry run releasing every row.

   Run: node tools/lifecycle/lifecycle.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const H = require(path.join(ROOT, 'lib', 'edgedesk_home.js'));
const X = require(path.join(ROOT, 'lib', 'edgedesk_pricing.js'));
const TPL = require('./templates.js');
const SEND = require('./send.js');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 300) : '')); } }

/* the fixture, with its prices made fresh relative to "now" so the test does
   not age (the page and the emails re-judge ages at read time) */
function freshen(obj, newestAgoMs) {
  const s = JSON.stringify(obj);
  const ts = [...s.matchAll(/"(captured_at|last_success_at|computed_at|model_updated_at|market_updated_at|generated_at)":"([^"]+)"/g)].map((m) => Date.parse(m[2])).filter(isFinite);
  const d = (Date.now() - newestAgoMs) - Math.max(...ts);
  return JSON.parse(s.replace(/"(captured_at|last_success_at|evaluated_at|computed_at|model_updated_at|market_updated_at|as_of|generated_at|summary_at|kickoff_at|kickoff|first_seen_at)":"([^"]+)"/g,
    (m, k, v) => { const t = Date.parse(v); return isFinite(t) ? '"' + k + '":"' + new Date(t + Math.max(d, k.indexOf('kickoff') === 0 ? 0 : d)).toISOString() + '"' : m; }));
}
const RPC = freshen(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'home', 'fixtures', 'public_home_board.json'), 'utf8')), 20 * 60e3);
const STAT = freshen(JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'home', 'board.json'), 'utf8')), 10 * 60e3);
const V = H.build(RPC, STAT, Date.now());
const CTX = { site_url: 'https://edgedesksports.com', mailing_address: 'Rackler Tech Ventures LLC, 2013 89th St, Lubbock, TX 79423' };
const charge = new Date(Date.now() + 2 * 864e5).toISOString();
const base = { id: 7, user_id: 'u', email: 'reader@example.com', unsubscribe_token: 'a'.repeat(64), trial_at: new Date(Date.now() - 864e5).toISOString(), leagues: ['nfl', 'cfb'] };

/* ── 1-3 each email ──────────────────────────────────────────────────────── */
const mails = {};
['trial_welcome', 'trial_day1', 'trial_day3', 'renewal_reminder'].forEach((k) => {
  const m = TPL.build(Object.assign({}, base, { kind: k, charge_at: charge, amount_cents: k === 'renewal_reminder' ? 3999 : null }), V, CTX);
  mails[k] = m;
  chk(k + ' builds', !!m && !!m.subject && m.html.length > 400 && m.text.length > 100);
  chk(k + ' passes the copy rule', m && m.copy.ok, m && m.copy);
  chk(k + ' says research, not picks, 21+ and 1-800-GAMBLER', /Research, not picks/.test(m.text) && /21\+/.test(m.text) && /1-800-GAMBLER/.test(m.text));
  chk(k + ' carries the postal address and the legal links', /2013 89th St, Lubbock, TX 79423/.test(m.text) && /terms\.html/.test(m.html) && /privacy\.html/.test(m.html));
  chk(k + ' escapes what it prints', !/<script/i.test(m.html));
});
chk('the welcome is "Your EdgeDesk terminal is live"', mails.trial_welcome.subject === 'Your EdgeDesk terminal is live');
chk('the welcome names the date the trial ends and promises the reminder', /Your trial runs until/.test(mails.trial_welcome.text) && /We will email you before then with the exact date/.test(mails.trial_welcome.text));
chk('the welcome reads the live board (counts from the database)', /Right now EdgeDesk has \d+ games analyzed/.test(mails.trial_welcome.text), mails.trial_welcome.text.slice(0, 400));
chk('day 1 shows current research, each price with its capture time', /GAME RESEARCH|PLAYER PROP RESEARCH/.test(mails.trial_day1.text) && /captured \d+ (?:min|h) ago\)/.test(mails.trial_day1.text), mails.trial_day1.text.slice(0, 600));
const dateOnly = TPL.dateText(charge).replace(/, \d{4}$/, '');
chk('the reminder\'s subject is the date the trial ends', mails.renewal_reminder.subject === 'Your EdgeDesk trial ends on ' + dateOnly, mails.renewal_reminder.subject);
chk('the reminder states the charge date and the amount Stripe holds', mails.renewal_reminder.text.indexOf('Your card will be charged $39.99 on ' + TPL.dateText(charge)) >= 0, mails.renewal_reminder.text.slice(0, 300));
chk('without Stripe\'s amount it states the plan\'s', TPL.build(Object.assign({}, base, { kind: 'renewal_reminder', charge_at: charge }), V, CTX).text.indexOf('charged ' + X.PRICE_DISPLAY + ' on') >= 0);
chk('the reminder says how to cancel and that cancelling first means no charge', /Settings › Subscription/.test(mails.renewal_reminder.text) && /never charged/.test(mails.renewal_reminder.text));
chk('the reminder is a billing notice: no research teaser, no unsubscribe', !/Game research|Player prop research|EdgeDesk EV/i.test(mails.renewal_reminder.text) && mails.renewal_reminder.unsubscribe === null && /billing notice/.test(mails.renewal_reminder.text));
['trial_welcome', 'trial_day1', 'trial_day3'].forEach((k) =>
  chk(k + ' carries the unsubscribe link for tips', mails[k].unsubscribe === 'https://edgedesksports.com/email/unsubscribe/?t=' + 'a'.repeat(64) && mails[k].html.indexOf(mails[k].unsubscribe) >= 0));
chk('no urgency device anywhere', Object.keys(mails).every((k) => !/\b(?:hurry|last chance|act now|countdown|only \d+ left)\b/i.test(mails[k].text)));

/* ── 4 honesty and personalisation ───────────────────────────────────────── */
const stale = H.build(RPC, freshen(STAT, 5 * 3600e3), Date.now());
const sm = TPL.build(Object.assign({}, base, { kind: 'trial_day1' }), stale, CTX);
chk('a stale prop price never appears in an email', !/Player prop research/i.test(sm.text) && !/EdgeDesk EV/i.test(sm.text), sm.text.slice(0, 500));
const pp = TPL.build(Object.assign({}, base, { kind: 'trial_day1', research_focus: 'player_props' }), V, CTX);
chk('a props reader sees props first', !/Player prop research/i.test(pp.text) || pp.text.indexOf('PLAYER PROP RESEARCH') < pp.text.indexOf('GAME RESEARCH') || pp.text.indexOf('GAME RESEARCH') < 0, pp.text.slice(0, 300));
const since = TPL.pick(V, base, new Date(Date.now() + 3600e3).toISOString());
chk('day 3 counts only what changed after the previous visit', since.all_games === 0 && since.all_props === 0, since);
const d3 = TPL.build(Object.assign({}, base, { kind: 'trial_day3', previous_visit_at: new Date(Date.now() - 2 * 864e5).toISOString() }), V, CTX);
chk('day 3 names the previous visit', /^New on EdgeDesk since /.test(d3.subject) && /Since your last visit \(/.test(d3.text), d3.subject);
chk('an empty board says PASS is normal rather than inventing research', /PASS is a normal answer/.test(TPL.build(Object.assign({}, base, { kind: 'trial_day1' }), H.build({ ok: true, games: [], counts: {}, times: {} }, null, Date.now()), CTX).text));

/* ── 5 the copy rule ─────────────────────────────────────────────────────── */
['Lock of the day', 'our best bet', 'guaranteed', 'free money', 'act now', 'hurry', 'last chance', 'only 3 left', 'profit every week', 'tail this', 'winners'].forEach((w) =>
  chk('the copy rule refuses "' + w + '"', TPL.copyOk('Hello. ' + w + '.').ok === false));
chk('and lets the product\'s own refusals through', TPL.copyOk('Research, not picks. A label is never a pick.').ok === true);

/* ── 6 the sender ────────────────────────────────────────────────────────── */
function fakeRpc(state) {
  return async function (name, body) {
    state.calls.push([name, body]);
    if (name === 'lifecycle_plan') return { ok: true, scheduled: 2 };
    if (name === 'lifecycle_due') return state.due;
    if (name === 'public_home_board') return RPC;
    if (name === 'lifecycle_mark') { state.marks.push(body); return true; }
    throw new Error('unexpected ' + name);
  };
}
function fakeFetch(state, ok) {
  return async function (url, init) {
    state.sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: ok !== false, status: ok === false ? 500 : 200, text: async () => (ok === false ? 'boom' : JSON.stringify({ id: 're_' + state.sent.length })) };
  };
}
const due = (n) => ({ ok: true, sending_enabled: true, from: 'EdgeDesk <research@edgedesksports.com>', reply_to: 'support@edgedesksports.com', site_url: CTX.site_url, mailing_address: CTX.mailing_address,
  messages: Array.from({ length: n }, (x, i) => Object.assign({}, base, { id: 100 + i, kind: i % 2 ? 'renewal_reminder' : 'trial_welcome', charge_at: charge })) });
(async function () {
  const logs = [];
  let r = await SEND.run({ url: '', key: '', log: (s) => logs.push(s) });
  chk('without the database secrets the sender does nothing and says so', r.status === 'NO_DATABASE' && /not set/.test(logs.join(' ')));
  let st = { calls: [], marks: [], sent: [], due: due(2) };
  r = await SEND.run({ url: 'u', key: 'k', apiKey: '', rpc: fakeRpc(st), fetch: fakeFetch(st), stat: STAT, log: () => {} });
  chk('without RESEND_API_KEY it schedules but claims and sends nothing', r.status === 'NO_PROVIDER' && st.calls.map((c) => c[0]).join() === 'lifecycle_plan' && st.sent.length === 0);
  st = { calls: [], marks: [], sent: [], due: { ok: true, sending_enabled: false, messages: [] } };
  r = await SEND.run({ url: 'u', key: 'k', apiKey: 're_key', rpc: fakeRpc(st), fetch: fakeFetch(st), stat: STAT, log: () => {} });
  chk('while sending is switched off nothing is sent', r.status === 'DISABLED' && st.sent.length === 0);
  st = { calls: [], marks: [], sent: [], due: due(2) };
  r = await SEND.run({ url: 'u', key: 'k', apiKey: 're_key', rpc: fakeRpc(st), fetch: fakeFetch(st), stat: STAT, log: () => {} });
  chk('one Resend call per claimed email', r.sent === 2 && st.sent.length === 2, r);
  chk('each with an Idempotency-Key that is the message row', st.sent.map((s) => s.headers['idempotency-key']).join() === 'edgedesk-lifecycle-100,edgedesk-lifecycle-101');
  chk('from the configured sender, to the reader only', st.sent.every((s) => s.body.from === 'EdgeDesk <research@edgedesksports.com>' && s.body.to.length === 1 && s.body.to[0] === 'reader@example.com'));
  chk('a tip carries List-Unsubscribe; the billing reminder does not', !!st.sent[0].body.headers && /email\/unsubscribe/.test(st.sent[0].body.headers['List-Unsubscribe']) && !st.sent[1].body.headers);
  chk('every row is marked sent with the provider id', st.marks.length === 2 && st.marks.every((m) => m.p_status === 'sent' && /^re_/.test(m.p_provider_id)));
  st = { calls: [], marks: [], sent: [], due: due(1) };
  r = await SEND.run({ url: 'u', key: 'k', apiKey: 're_key', rpc: fakeRpc(st), fetch: fakeFetch(st, false), stat: STAT, log: () => {} });
  chk('a provider error marks the row failed (it is retried, at most three times)', r.failed === 1 && st.marks[0].p_status === 'failed' && /HTTP 500/.test(st.marks[0].p_error));
  st = { calls: [], marks: [], sent: [], due: due(2) };
  r = await SEND.run({ url: 'u', key: 'k', driver: 'console', rpc: fakeRpc(st), fetch: fakeFetch(st), stat: STAT, log: () => {} });
  chk('a dry run prints, sends nothing and releases every row', r.printed === 2 && st.sent.length === 0 && st.marks.every((m) => m.p_status === 'release'));
  const orig = TPL.build;
  TPL.build = function () { const m = orig.apply(this, arguments); m.copy = { ok: false, word: 'lock' }; return m; };
  st = { calls: [], marks: [], sent: [], due: due(1) };
  r = await SEND.run({ url: 'u', key: 'k', apiKey: 're_key', rpc: fakeRpc(st), fetch: fakeFetch(st), stat: STAT, log: () => {} });
  TPL.build = orig;
  chk('an email the copy rule refuses is never sent', r.refused === 1 && st.sent.length === 0 && /copy rule/.test(st.marks[0].p_error));

  const WF = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'lifecycle-email.yml'), 'utf8');
  chk('the workflow runs hourly and on demand', /schedule:/.test(WF) && /cron: '17 \* \* \* \*'/.test(WF) && /workflow_dispatch/.test(WF));
  chk('it tests before it sends', WF.indexOf('lifecycle.test.js') > 0 && WF.indexOf('lifecycle.test.js') < WF.indexOf('tools/lifecycle/send.js'));
  chk('its secrets are the repository\'s existing ones', /secrets\.SB_URL/.test(WF) && /secrets\.SB_SERVICE_ROLE/.test(WF) && /secrets\.RESEND_API_KEY/.test(WF));
  const UN = fs.readFileSync(path.join(ROOT, 'email', 'unsubscribe', 'index.html'), 'utf8');
  chk('the unsubscribe page calls lifecycle_unsubscribe with the token and nothing else', /rpc\/lifecycle_unsubscribe/.test(UN) && /p_token/.test(UN) && /noindex/.test(UN));

  failures.forEach((f) => console.log('FAIL | ' + f));
  console.log((fail ? 'FAILED' : 'ALL GREEN') + ' lifecycle email — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
