#!/usr/bin/env node
/* ============================================================================
   THE TAPE SENDER (supabase/fairline_tape.sql, tools/fairline/tape_email.js).
   Run hourly by .github/workflows/lifecycle-email.yml, after the trial
   emails: the existing email pipeline, its provider and its sender
   (tools/lifecycle/send.js client() and sendResend()).

     1  fairline_tape_due(25)   CLAIM the Tapes built and not yet emailed,
                                re-checked against the reader NOW (opted out,
                                bounced, no longer Fairline, too late, a
                                quiet week → skipped with the reason)
     2  each email              built from the STORED Tape, refused if its
                                words fail the copy rule, sent through Resend
                                with an Idempotency-Key per delivery row
                                ('edgedesk-lifecycle-fairline-tape-<id>', never
                                a trial email's key), so a retry after a lost
                                response cannot deliver twice
     3  fairline_tape_mark()    sent / failed

   The Tape is BUILT by pg_cron on Monday morning (fairline_tape_cron.sql),
   not here. Nothing is sent while either switch is off:
   lifecycle_settings.sending_enabled (the pipeline's) or
   fairline_tape_settings.email_enabled (The Tape's, off by default) — step 1
   returns nothing. Without its secrets, or before fairline_tape.sql is
   applied, it says so and sends nothing: a setup step, not an outage.

   Environment: as tools/lifecycle/send.js (SB_URL, SB_SERVICE_ROLE,
   RESEND_API_KEY; LIFECYCLE_DRIVER=console prints instead of sending).

     node tools/fairline/tape_send.js [--dry-run] [--limit 25]
   ========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const SEND = require(path.join(ROOT, 'tools', 'lifecycle', 'send.js'));
const TAPE = require('./tape_email.js');

const DEFAULT_URL = 'https://iattxbkbufslbauoumga.supabase.co';
function env(k, alt) { return (process.env[k] || (alt ? process.env[alt] : '') || '').trim(); }
function arg(a, k, d) { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; }

async function run(o) {
  o = o || {};
  const log = o.log || ((s) => console.log(s));
  const url = (o.url || env('SB_URL', 'EDGD_SB_URL') || DEFAULT_URL).replace(/\/$/, ''), key = o.key || env('SB_SERVICE_ROLE', 'EDGD_SB_SERVICE');
  const apiKey = o.apiKey != null ? o.apiKey : env('RESEND_API_KEY');
  const driver = o.driver || env('LIFECYCLE_DRIVER') || (o.dryRun ? 'console' : 'resend');
  if (!url || !key) { log('tape: SB_SERVICE_ROLE is not set — nothing to do.'); return { status: 'NO_DATABASE' }; }
  if (driver === 'resend' && !apiKey) { log('tape: RESEND_API_KEY is not set — nothing is sent.'); return { status: 'NO_PROVIDER' }; }
  const rpc = o.rpc || SEND.client(url, key, o.fetch);
  let due;
  try { due = await rpc('fairline_tape_due', { p_limit: o.limit || 25 }); }
  catch (e) {
    /* PostgREST answers 404 for a function that does not exist yet */
    if (e && e.status === 404) { log('tape: fairline_tape.sql is not applied here — nothing to send.'); return { status: 'NOT_INSTALLED' }; }
    throw e;
  }
  if (!due || due.sending_enabled === false) { log('tape: the email pipeline is switched off in /admin/funnel/ — nothing claimed.'); return { status: 'DISABLED' }; }
  if (due.tape_email_enabled === false) { log('tape: The Tape emails are switched off (fairline_tape_settings.email_enabled) — nothing claimed.'); return { status: 'DISABLED' }; }
  const msgs = due.messages || [];
  if (!msgs.length) { log('tape: nothing due.'); return { status: 'OK', sent: 0 }; }
  const res = { status: 'OK', sent: 0, failed: 0, refused: 0, printed: 0 };
  for (const m of msgs) {
    const mail = TAPE.build(m, { site_url: due.site_url, mailing_address: due.mailing_address });
    if (!mail) { await rpc('fairline_tape_mark', { p_id: m.id, p_status: 'failed', p_error: 'not a Tape' }); res.failed++; continue; }
    if (!mail.copy.ok) {
      /* a word the copy rule refuses is a bug in the words, never shipped */
      await rpc('fairline_tape_mark', { p_id: m.id, p_status: 'failed', p_error: 'copy rule refused "' + mail.copy.word + '"' });
      res.refused++; log('tape: REFUSED #' + m.id + ' — the copy rule caught "' + mail.copy.word + '"'); continue;
    }
    if (driver === 'console') {
      log('--- fairline_tape #' + m.id + ' → ' + String(m.email).replace(/^(.).*(@.*)$/, '$1…$2') + '\nSubject: ' + mail.subject + '\n' + mail.text);
      res.printed++;
      /* a dry run claims nothing for good: the rows go back to pending */
      await rpc('fairline_tape_mark', { p_id: m.id, p_status: 'release' });
      continue;
    }
    const r = await SEND.sendResend({ row_id: 'fairline-tape-' + m.id, kind: 'fairline_tape', to: m.email, subject: mail.subject, html: mail.html, text: mail.text,
      unsubscribe: mail.unsubscribe }, { apiKey, from: due.from, reply_to: due.reply_to }, o.fetch);
    await rpc('fairline_tape_mark', { p_id: m.id, p_status: r.ok ? 'sent' : 'failed', p_provider_id: r.id || null, p_error: r.ok ? null : r.error });
    if (r.ok) res.sent++; else { res.failed++; log('tape: FAILED #' + m.id + ' — ' + r.error); }
  }
  log('tape: ' + JSON.stringify({ sent: res.sent, failed: res.failed, refused: res.refused, printed: res.printed }));
  return res;
}

if (require.main === module) {
  const a = process.argv.slice(2);
  run({ dryRun: a.indexOf('--dry-run') >= 0, limit: +arg(a, 'limit', 25) || 25 })
    .then((r) => { process.exit(r && r.refused ? 1 : 0); })
    .catch((e) => { console.error('tape: ' + (e && e.message || e)); process.exit(1); });
}
module.exports = { run };
