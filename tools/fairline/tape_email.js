'use strict';
/* ============================================================================
   THE TAPE — the email. (supabase/fairline_tape.sql, docs/fairline.md)

   One stored Tape, one email. Unlike the trial emails (which quote the board
   as it is at send time), a Tape is a SNAPSHOT of a week that is over: the
   email says exactly what the stored Tape says, in the page's own words
   (lib/edgedesk_fairline_core.js tapeView), so the inbox and the Fairline
   page can never disagree.

   THE COPY RULE is the trial emails' own (tools/lifecycle/templates.js
   copyOk): no pick words, no promise of profit, no urgency device. A Tape
   that fails it is never sent. Every email carries the footer the pipeline
   requires: research, not picks; 21+ and 1-800-GAMBLER; the postal address;
   and a working link that turns The Tape emails off (email/tape/).
   ========================================================================== */
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const C = require(path.join(ROOT, 'lib', 'edgedesk_fairline_core.js'));
const TPL = require(path.join(ROOT, 'tools', 'lifecycle', 'templates.js'));

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

const FONT = '-apple-system,Segoe UI,Inter,Arial,sans-serif';
const FOOT = 'Research, not picks. Fairline measures prices and your own bets; it never tells you what to bet, and numbers can be wrong — every one shows where it came from. 21+ only. If gambling stops being fun, call 1-800-GAMBLER.';

function shell(o) {
  const site = o.site_url || 'https://edgedesksports.com';
  const para = (t) => '<p style="margin:0 0 14px;font:15px/1.6 ' + FONT + ';color:#1d1a15">' + esc(t) + '</p>';
  let html = '<!doctype html><html><body style="margin:0;background:#f4f1ea"><div style="max-width:580px;margin:0 auto;padding:28px 22px;background:#ffffff">'
    + '<p style="margin:0 0 4px;font:700 16px ' + FONT + ';color:#1d1a15">EdgeDesk Fairline · The Tape</p>'
    + '<p style="margin:0 0 18px;font:13px ' + FONT + ';color:#6f6553">' + esc(o.week) + '</p>';
  let text = 'EDGEDESK FAIRLINE · THE TAPE\n' + o.week + '\n\n';
  (o.blocks || []).forEach((b) => {
    if (b.p) { html += para(b.p); text += b.p + '\n\n'; }
    if (b.h) { html += '<p style="margin:18px 0 8px;font:700 12px/1.4 ' + FONT + ';letter-spacing:.08em;text-transform:uppercase;color:#6f6553">' + esc(b.h) + '</p>'; text += b.h.toUpperCase() + '\n'; }
    if (b.rows) {
      html += '<table role="presentation" style="border-collapse:collapse;margin:0 0 16px;font:14px/1.5 ' + FONT + ';color:#1d1a15">'
        + b.rows.map((r) => '<tr><td style="padding:3px 16px 3px 0;color:#6f6553">' + esc(r.k) + '</td><td style="padding:3px 0;font-weight:700">' + esc(r.v) + '</td></tr>').join('')
        + '</table>';
      text += b.rows.map((r) => r.k + ': ' + r.v).join('\n') + '\n\n';
    }
    if (b.list) {
      html += '<ul style="margin:0 0 16px;padding-left:20px;font:14px/1.55 ' + FONT + ';color:#1d1a15">' + b.list.map((i) => '<li style="margin:0 0 8px">' + esc(i) + '</li>').join('') + '</ul>';
      text += b.list.map((i) => '- ' + i).join('\n') + '\n\n';
    }
    if (b.btn) {
      html += '<p style="margin:6px 0 18px"><a href="' + esc(b.btn[0]) + '" style="display:inline-block;background:#2fa79a;color:#042320;font:700 15px ' + FONT + ';text-decoration:none;padding:11px 18px;border-radius:9px">' + esc(b.btn[1]) + '</a></p>';
      text += b.btn[1] + ': ' + b.btn[0] + '\n\n';
    }
  });
  html += '<hr style="border:0;border-top:1px solid #e3ddd0;margin:22px 0 14px">'
    + '<p style="margin:0 0 8px;font:12px/1.6 ' + FONT + ';color:#6f6553">' + esc(FOOT) + '</p>'
    + '<p style="margin:0 0 8px;font:12px/1.6 ' + FONT + ';color:#6f6553">You get The Tape because your EdgeDesk plan includes Fairline. <a href="' + esc(o.unsubscribe) + '" style="color:#2fa79a">Stop The Tape emails</a> (The Tape stays on the Fairline page).</p>'
    + '<p style="margin:0;font:12px/1.6 ' + FONT + ';color:#6f6553">' + esc(o.mailing_address || '') + ' · <a href="' + esc(site) + '/terms.html" style="color:#6f6553">Terms</a> · <a href="' + esc(site) + '/privacy.html" style="color:#6f6553">Privacy</a></p>'
    + '</div></body></html>';
  text += '--\n' + FOOT + '\nYou get The Tape because your EdgeDesk plan includes Fairline. Stop The Tape emails (The Tape stays on the Fairline page): ' + o.unsubscribe + '\n'
    + (o.mailing_address || '') + '\n';
  return { html, text };
}

/* one email, from one claimed delivery (fairline_tape_due) */
function build(msg, ctx) {
  ctx = ctx || {};
  if (!msg || msg.kind !== 'fairline_tape' || !msg.tape) return null;
  const site = ctx.site_url || 'https://edgedesksports.com';
  const v = C.tapeView(msg.tape);
  if (!v) return null;
  const unsub = site + '/email/tape/?t=' + encodeURIComponent(msg.unsubscribe_token || '');
  const blocks = [{ p: v.headline }];
  if (v.lines.length) blocks.push({ rows: v.lines });
  if (v.price) blocks.push({ p: v.price });
  blocks.push({ h: 'Your leaks this week' });
  blocks.push(v.changes.length ? { list: v.changes.map((c) => c.text) } : { p: v.changesNone });
  if (v.changesMore) blocks.push({ p: v.changesMore });
  if (v.best) { blocks.push({ h: 'The best number you got' }); blocks.push({ p: v.best }); }
  blocks.push({ btn: [site + '/fairline/#tape', 'Open The Tape and your leaks'] });
  blocks.push({ p: 'The Tape is a record of your own week, measured against EdgeDesk’s fair price and the closing line. It is not a pick and it never says what to bet next.' });
  const subject = 'The Tape: ' + v.week + (msg.tape.week_stats && msg.tape.week_stats.bets ? ' — ' + C.record(msg.tape.week_stats) : '');
  const body = shell({ blocks, unsubscribe: unsub, site_url: site, mailing_address: ctx.mailing_address, week: 'The week of ' + v.week });
  const check = TPL.copyOk(subject + '\n' + body.text);
  return { subject, html: body.html, text: body.text, unsubscribe: unsub, copy: check };
}

module.exports = { build, FOOT };
