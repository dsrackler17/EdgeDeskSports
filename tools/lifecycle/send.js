#!/usr/bin/env node
/* ============================================================================
   THE TRIAL EMAIL SENDER (supabase/lifecycle_email.sql, tools/lifecycle/
   templates.js). Run hourly by .github/workflows/lifecycle-email.yml.

     1  lifecycle_plan()      schedule whatever is due to exist (idempotent)
     2  lifecycle_due(25)     CLAIM what is due now, re-checked against the
                              reader's state (cancelled, opted out, bounced,
                              charge date moved → skipped with the reason)
     3  the board, once       public_home_board() and football/home/board.json
                              (this checkout) through lib/edgedesk_home.js
     4  each email            built from the board NOW, refused if its words
                              fail the copy rule, sent through Resend with an
                              Idempotency-Key per message row (a retry after a
                              lost response cannot deliver twice)
     5  lifecycle_mark()      sent / failed

   Nothing is sent while lifecycle_settings.sending_enabled is false (the
   default): step 2 returns nothing. Without its secrets it exits 0 and says
   what is missing — a missing key is a setup step, not an outage.

   Environment
     SB_URL (or EDGD_SB_URL)                     the Supabase project URL (defaults to the site's)
     SB_SERVICE_ROLE (or EDGD_SB_SERVICE)        service role (the RPCs are service-role only)
     RESEND_API_KEY                              the email provider
     LIFECYCLE_DRIVER=console                    print instead of sending (and mark nothing)

     node tools/lifecycle/send.js [--dry-run] [--limit 25]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const H = require(path.join(ROOT, 'lib', 'edgedesk_home.js'));
const TPL = require('./templates.js');

const DEFAULT_URL = 'https://iattxbkbufslbauoumga.supabase.co';
function env(k, alt) { return (process.env[k] || (alt ? process.env[alt] : '') || '').trim(); }
function arg(a, k, d) { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; }

function client(url, key, fetchImpl) {
  const f = fetchImpl || globalThis.fetch;
  return async function rpc(name, body) {
    const r = await f(url + '/rest/v1/rpc/' + name, { method: 'POST', headers: { apikey: key, authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    const t = await r.text();
    if (!r.ok) { const e = new Error(name + ' HTTP ' + r.status + ': ' + t.slice(0, 200)); e.status = r.status; throw e; }
    return t ? JSON.parse(t) : null;
  };
}

async function sendResend(msg, cfg, fetchImpl) {
  const f = fetchImpl || globalThis.fetch;
  const r = await f('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + cfg.apiKey, 'content-type': 'application/json', 'idempotency-key': 'edgedesk-lifecycle-' + msg.row_id },
    body: JSON.stringify({ from: cfg.from, to: [msg.to], reply_to: cfg.reply_to || undefined, subject: msg.subject, html: msg.html, text: msg.text,
      headers: msg.unsubscribe ? { 'List-Unsubscribe': '<' + msg.unsubscribe + '>' } : undefined,
      tags: [{ name: 'kind', value: msg.kind }] })
  });
  const t = await r.text();
  let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { j = null; }
  if (!r.ok) return { ok: false, error: 'HTTP ' + r.status + ': ' + t.slice(0, 200) };
  return { ok: true, id: j && j.id ? j.id : null };
}

async function run(o) {
  o = o || {};
  const log = o.log || ((s) => console.log(s));
  const url = (o.url || env('SB_URL', 'EDGD_SB_URL') || DEFAULT_URL).replace(/\/$/, ''), key = o.key || env('SB_SERVICE_ROLE', 'EDGD_SB_SERVICE');
  const apiKey = o.apiKey != null ? o.apiKey : env('RESEND_API_KEY');
  const driver = o.driver || env('LIFECYCLE_DRIVER') || (o.dryRun ? 'console' : 'resend');
  if (!url || !key) { log('lifecycle: SB_SERVICE_ROLE is not set — nothing to do.'); return { status: 'NO_DATABASE' }; }
  if (driver === 'resend' && !apiKey) { log('lifecycle: RESEND_API_KEY is not set — nothing is sent (the plan still runs).'); }
  const rpc = o.rpc || client(url, key, o.fetch);
  const plan = await rpc('lifecycle_plan', {});
  log('lifecycle: plan scheduled ' + (plan && plan.scheduled) + ' new email(s)');
  if (driver === 'resend' && !apiKey) return { status: 'NO_PROVIDER', plan };
  const due = await rpc('lifecycle_due', { p_limit: o.limit || 25 });
  if (!due || due.sending_enabled === false) { log('lifecycle: sending is switched off in /admin/funnel/ — nothing claimed.'); return { status: 'DISABLED', plan }; }
  const msgs = due.messages || [];
  if (!msgs.length) { log('lifecycle: nothing due.'); return { status: 'OK', sent: 0, plan }; }
  /* the board, once, for every email in this run */
  let pub = null, stat = null;
  try { pub = await rpc('public_home_board', {}); } catch (e) { log('lifecycle: the board RPC failed (' + e.message + '); emails go without live research.'); }
  try { stat = o.stat !== undefined ? o.stat : JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'home', 'board.json'), 'utf8')); } catch (e) { stat = null; }
  const view = (pub && pub.ok) || stat ? H.build(pub && pub.ok ? pub : null, stat, o.now || Date.now()) : null;
  const res = { status: 'OK', sent: 0, failed: 0, refused: 0, printed: 0, plan };
  for (const m of msgs) {
    const mail = TPL.build(m, view, { site_url: due.site_url, mailing_address: due.mailing_address });
    if (!mail) { await rpc('lifecycle_mark', { p_id: m.id, p_status: 'failed', p_error: 'unknown kind' }); res.failed++; continue; }
    if (!mail.copy.ok) {
      /* a word the copy rule refuses is a bug in the template, never shipped */
      await rpc('lifecycle_mark', { p_id: m.id, p_status: 'failed', p_error: 'copy rule refused "' + mail.copy.word + '"' });
      res.refused++; log('lifecycle: REFUSED ' + m.kind + ' #' + m.id + ' — the copy rule caught "' + mail.copy.word + '"'); continue;
    }
    const out = { row_id: m.id, kind: m.kind, to: m.email, subject: mail.subject, html: mail.html, text: mail.text, unsubscribe: mail.unsubscribe };
    if (driver === 'console') {
      log('--- ' + m.kind + ' #' + m.id + ' → ' + m.email.replace(/^(.).*(@.*)$/, '$1…$2') + '\nSubject: ' + mail.subject + '\n' + mail.text);
      res.printed++;
      /* a dry run claims nothing for good: the rows go back to pending */
      await rpc('lifecycle_mark', { p_id: m.id, p_status: 'release' });
      continue;
    }
    const r = await sendResend(out, { apiKey, from: due.from, reply_to: due.reply_to }, o.fetch);
    await rpc('lifecycle_mark', { p_id: m.id, p_status: r.ok ? 'sent' : 'failed', p_provider_id: r.id || null, p_error: r.ok ? null : r.error });
    if (r.ok) res.sent++; else { res.failed++; log('lifecycle: FAILED ' + m.kind + ' #' + m.id + ' — ' + r.error); }
  }
  log('lifecycle: ' + JSON.stringify({ sent: res.sent, failed: res.failed, refused: res.refused, printed: res.printed }));
  return res;
}

if (require.main === module) {
  const a = process.argv.slice(2);
  run({ dryRun: a.indexOf('--dry-run') >= 0, limit: +arg(a, 'limit', 25) || 25 })
    .then((r) => { process.exit(r && r.refused ? 1 : 0); })
    .catch((e) => { console.error('lifecycle: ' + (e && e.message || e)); process.exit(1); });
}
module.exports = { run, client, sendResend };
