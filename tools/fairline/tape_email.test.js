#!/usr/bin/env node
/* ===========================================================================
   THE TAPE — its words, its email and its sender, offline. (No database: the
   hourly email job runs this before it sends anything.)

     1  the words (lib/edgedesk_fairline_core.js tapeView) from a stored Tape
        (tools/fairline/fixtures/tape.json, written from a real one by
        tape_sql.test.js, which also holds its shape to the SQL's): the
        headline, the numbers, price quality, what changed, the best number;
        a quiet week; a week with only open bets; every best-number case
     2  the email: built from the stored Tape alone, passes the trial emails'
        copy rule, says it is not a pick, carries 21+, 1-800-GAMBLER, the
        postal address and a working link to stop The Tape emails; escapes
        what the reader typed
     3  the copy rule refuses a Tape whose words would break it — and the
        sender never sends it
     4  the sender: nothing without secrets or before the SQL is applied,
        nothing while switched off, one Resend call per claimed Tape with its
        own Idempotency-Key, every row marked, a provider failure marked
        failed, a dry run printing and releasing every row

   Run: node tools/fairline/tape_email.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const C = require(path.join(ROOT, 'lib', 'edgedesk_fairline_core.js'));
const TPL = require(path.join(ROOT, 'tools', 'lifecycle', 'templates.js'));
const MAIL = require('./tape_email.js');
const SENDER = require('./tape_send.js');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); } }
const clone = (o) => JSON.parse(JSON.stringify(o));
const TAPE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tape.json'), 'utf8'));
const TOKEN = 'a'.repeat(64);
const msg = (tape, id) => ({ id: id || 7, kind: 'fairline_tape', email: 'reader@example.com', tape, unsubscribe_token: TOKEN, week_start: tape.week.start });
const CTX = { site_url: 'https://edgedesksports.com', mailing_address: 'Rackler Tech Ventures LLC, 2013 89th St, Lubbock, TX 79423' };

/* ── 1. the words ─────────────────────────────────────────────────────── */
const v = C.tapeView(TAPE);
chk('the week, Monday to Sunday', v.week === 'Oct 19 – Oct 25', v.week);
chk('the headline: the record, the P/L in the week\'s own measure, the close, the open bets',
  v.headline === 'Last week: 1–10 on 11 bets settled, down 8.80 units (one unit a bet). You beat the close on 8 of 10. 1 still open.', v.headline);
const L = Object.fromEntries(v.lines.map((x) => [x.k, x.v]));
chk('the numbers: the record, dollars and units with their coverage, CLV, beat close, price vs fair',
  L.Record === '1–10 (+1 open)' && L['P/L'] === '+$60.00 (1 of 11 bets) · −10.00u (10 of 11 bets)' && L['Avg CLV'] === '+1.00% (10 closes)' &&
  L['Beat close'] === '80% (8 of 10)' && L['Price vs fair'] === '+0.17 pts avg (3 of 12 checked)', L);
chk('price quality counts the unchecked bets and never guesses them',
  v.price === 'Price quality: on the 3 bets checked against EdgeDesk’s fair when you placed them, you averaged +0.17 pts against fair (better than fair); 1 of 3 beat it. The other 9 were never checked, so they are not counted.', v.price);
chk('what changed: the slice that crossed into a Real leak, first', v.changes[0] && v.changes[0].text === 'Spreads reached 16 bets settled, enough for a label: Real leak. This one’s real.' &&
  v.changes[0].label.chip === 'Real leak', v.changes[0]);
chk('…and the one whose label changed', v.changes.some((c) => c.text === 'Totals went from Real edge to Bad luck.'), v.changes.map((c) => c.text));
chk('the best number, with what it was', v.best === 'Best number: Over 44.5 at −105 (DraftKings), Green Bay Packers at Detroit Lions — 2.50 pts better than EdgeDesk’s fair when you placed it.', v.best);
const quiet = clone(TAPE);
quiet.quiet = true; quiet.week_stats = { bets: 0, pending: 0, wins: 0, losses: 0, pushes: 0, cashouts: 0, clv_bets: 0, beat_close: 0, dollars_bets: 0, units_bets: 0 };
quiet.price = { bets: 0, priced: 0, avg_edge_pts: null, better_than_fair: 0, worse_than_fair: 0 }; quiet.best = null; quiet.changes = [];
const vq = C.tapeView(quiet);
chk('a quiet week says so, and nothing else', vq.headline === 'No bets on last week’s games, and nothing changed in your leaks.' && vq.lines.length === 0 &&
  vq.price === null && vq.best === null && vq.changes.length === 0 && /crossed the 15-bet minimum/.test(vq.changesNone), vq);
const open = clone(quiet); open.quiet = false; open.week_stats.pending = 2; open.price.bets = 2;
const vo = C.tapeView(open);
chk('only open bets: no record yet, said plainly', vo.headline === 'No settled bets last week (2 still open).' && /none of last week’s 2 bets was checked/.test(vo.price), vo);
const many = clone(TAPE);
many.changes = Array.from({ length: 9 }, (_, i) => Object.assign({}, TAPE.changes[0], { dim: 'book', val: 'Book ' + i }));
const vm = C.tapeView(many);
chk('a long list says the first six (the database\'s order: real leaks first) and counts the rest',
  vm.changes.length === 6 && vm.changes[0].text.indexOf('Book 0') === 0 && vm.changesMore === '…and 3 more slices changed. Every one is in The Leaks.', vm.changesMore);
chk('…and the email says the same', MAIL.build(msg(many), CTX).text.indexOf('…and 3 more slices changed. Every one is in The Leaks.') > 0 &&
  MAIL.build(msg(many), CTX).text.indexOf('Book 6') < 0);
chk('a short list counts nothing more', v.changesMore === null);
const best = (o) => { const x = clone(TAPE); x.best = Object.assign({}, TAPE.best, o); return C.tapeView(x).best; };
chk('the best number at fair, under fair, and from the close', /right at EdgeDesk’s fair/.test(best({ edge_pts: 0 })) &&
  /^Closest to fair: .* — 0\.40 pts worse than EdgeDesk’s fair\. Every bet you checked was under fair\.$/.test(best({ edge_pts: -0.4 })) &&
  /^Best number: .* — it beat the close by 4\.2%\.$/.test(best({ measure: 'close', clv_pct: 4.2 })) &&
  /^Best close: .* — −0\.5% CLV\. No bet beat the close\.$/.test(best({ measure: 'close', clv_pct: -0.5 })), [best({ edge_pts: -0.4 }), best({ measure: 'close', clv_pct: 4.2 })]);
const words = [v, vq, vo].map((x) => [x.headline, x.price, x.best, x.changesNone].concat(x.changes.map((c) => c.text)).concat(x.lines.map((l) => l.v)).join('\n')).join('\n');
chk('no word the copy rule refuses, anywhere in The Tape\'s words', TPL.copyOk(words).ok, TPL.copyOk(words));
chk('no pick and no instruction to bet', !/\b(you should|bet this|take the|play the|pick of)\b/i.test(words));

/* ── 2. the email ─────────────────────────────────────────────────────── */
const mail = MAIL.build(msg(TAPE), CTX);
chk('it builds, and passes the copy rule', mail && mail.copy.ok, mail && mail.copy);
chk('the subject names the week and the record', mail.subject === 'The Tape: Oct 19 – Oct 25 — 1–10', mail.subject);
chk('it says exactly what the page says: the headline, the numbers, price, changes, best number',
  [v.headline, v.price, v.changes[0].text, v.best, '1–10 (+1 open)'].every((s) => mail.text.indexOf(s) >= 0), mail.text.slice(0, 600));
chk('the link to stop The Tape emails, in the text and the HTML', mail.unsubscribe === 'https://edgedesksports.com/email/tape/?t=' + TOKEN &&
  mail.text.indexOf(mail.unsubscribe) >= 0 && mail.html.indexOf(mail.unsubscribe) >= 0);
chk('the footer: research, not picks; 21+; 1-800-GAMBLER; the postal address; Terms and Privacy',
  ['Research, not picks', '21+', '1-800-GAMBLER', CTX.mailing_address].every((s) => mail.text.indexOf(s) >= 0 && mail.html.indexOf(s) >= 0) &&
  /\/terms\.html/.test(mail.html) && /\/privacy\.html/.test(mail.html));
chk('it says The Tape is not a pick', /It is not a pick and it never says what to bet next/.test(mail.text));
chk('it opens The Tape on the page', mail.html.indexOf('https://edgedesksports.com/fairline/#tape') >= 0);
chk('a quiet Tape still builds (the database decides not to send it)', MAIL.build(msg(quiet), CTX).copy.ok);
const evil = clone(TAPE); evil.best.selection = '<img src=x onerror=alert(1)>'; evil.best.platform = 'Book & "Co"';
const em = MAIL.build(msg(evil), CTX);
chk('what the reader typed is escaped in the HTML', em.html.indexOf('<img src=x') < 0 && em.html.indexOf('&lt;img src=x onerror=alert(1)&gt;') >= 0 && em.html.indexOf('Book &amp; &quot;Co&quot;') >= 0);
chk('anything but a Tape builds nothing', MAIL.build({ kind: 'trial_day1' }, CTX) === null && MAIL.build({ kind: 'fairline_tape' }, CTX) === null);

/* ── 3. the copy rule ─────────────────────────────────────────────────── */
const bad = clone(TAPE); bad.best.platform = 'Lock Of The Day Sportsbook';
const bm = MAIL.build(msg(bad), CTX);
chk('a Tape whose words the copy rule refuses is marked refused', bm && bm.copy.ok === false, bm && bm.copy);

/* ── 4. the sender ────────────────────────────────────────────────────── */
function fakeRpc(due) {
  const calls = [];
  const rpc = async (name, body) => {
    calls.push({ name, body });
    if (name === 'fairline_tape_due') { if (due instanceof Error) throw due; return due; }
    if (name === 'fairline_tape_mark') return true;
    throw new Error('unexpected rpc ' + name);
  };
  return { rpc, calls };
}
function fakeFetch(okFor) {
  const sent = [];
  const f = async (url, init) => { sent.push({ url, init, body: JSON.parse(init.body) }); const ok = !okFor || okFor(sent.length);
    return { ok, status: ok ? 200 : 500, text: async () => (ok ? JSON.stringify({ id: 're_' + sent.length }) : 'provider down') }; };
  return { f, sent };
}
const DUE = (msgs) => ({ ok: true, sending_enabled: true, tape_email_enabled: true, from: 'EdgeDesk <research@edgedesksports.com>', reply_to: 'support@edgedesksports.com',
  site_url: CTX.site_url, mailing_address: CTX.mailing_address, messages: msgs });
const quietLog = () => {};
(async () => {
  let r = await SENDER.run({ key: '', url: 'https://x', log: quietLog, rpc: fakeRpc(DUE([])).rpc });
  chk('without the service role it does nothing', r.status === 'NO_DATABASE');
  let k = fakeRpc(DUE([msg(TAPE)]));
  r = await SENDER.run({ key: 'svc', apiKey: '', url: 'https://x', log: quietLog, rpc: k.rpc });
  chk('without the provider key it claims nothing and sends nothing', r.status === 'NO_PROVIDER' && k.calls.length === 0);
  const notThere = new Error('fairline_tape_due HTTP 404'); notThere.status = 404;
  r = await SENDER.run({ key: 'svc', apiKey: 'k', url: 'https://x', log: quietLog, rpc: fakeRpc(notThere).rpc });
  chk('before fairline_tape.sql is applied it says so and sends nothing', r.status === 'NOT_INSTALLED');
  const down = new Error('fairline_tape_due HTTP 500'); down.status = 500;
  chk('any other database failure is a failure', await SENDER.run({ key: 'svc', apiKey: 'k', url: 'https://x', log: quietLog, rpc: fakeRpc(down).rpc }).then(() => false, () => true));
  r = await SENDER.run({ key: 'svc', apiKey: 'k', url: 'https://x', log: quietLog, rpc: fakeRpc({ ok: true, sending_enabled: false, messages: [] }).rpc });
  chk('the pipeline switched off: nothing', r.status === 'DISABLED');
  r = await SENDER.run({ key: 'svc', apiKey: 'k', url: 'https://x', log: quietLog, rpc: fakeRpc({ ok: true, sending_enabled: true, tape_email_enabled: false, messages: [] }).rpc });
  chk('The Tape\'s own switch off: nothing', r.status === 'DISABLED');

  k = fakeRpc(DUE([msg(TAPE, 11), msg(quiet, 12)]));
  let F = fakeFetch();
  r = await SENDER.run({ key: 'svc', apiKey: 'k', url: 'https://x', log: quietLog, rpc: k.rpc, fetch: F.f });
  chk('one Resend call per claimed Tape', r.sent === 2 && F.sent.length === 2 && F.sent.every((s) => s.url === 'https://api.resend.com/emails'), r);
  chk('each with its own Idempotency-Key, never a trial email\'s', F.sent.map((s) => s.init.headers['idempotency-key']).join() === 'edgedesk-lifecycle-fairline-tape-11,edgedesk-lifecycle-fairline-tape-12');
  chk('…from the pipeline\'s sender, with List-Unsubscribe and its kind', F.sent[0].body.from === 'EdgeDesk <research@edgedesksports.com>' && F.sent[0].body.reply_to === 'support@edgedesksports.com' &&
    F.sent[0].body.headers['List-Unsubscribe'] === '<https://edgedesksports.com/email/tape/?t=' + TOKEN + '>' && F.sent[0].body.tags[0].value === 'fairline_tape' &&
    F.sent[0].body.to[0] === 'reader@example.com', F.sent[0].body.headers);
  chk('every row marked sent, with the provider id', k.calls.filter((c) => c.name === 'fairline_tape_mark').map((c) => c.body.p_id + ':' + c.body.p_status + ':' + c.body.p_provider_id).join() === '11:sent:re_1,12:sent:re_2');

  k = fakeRpc(DUE([msg(TAPE, 21)])); F = fakeFetch(() => false);
  r = await SENDER.run({ key: 'svc', apiKey: 'k', url: 'https://x', log: quietLog, rpc: k.rpc, fetch: F.f });
  chk('a provider failure is marked failed, with the error (it is retried, at most three attempts)', r.failed === 1 &&
    k.calls.some((c) => c.name === 'fairline_tape_mark' && c.body.p_status === 'failed' && /HTTP 500/.test(c.body.p_error)));

  k = fakeRpc(DUE([msg(bad, 31), msg(TAPE, 32)])); F = fakeFetch();
  r = await SENDER.run({ key: 'svc', apiKey: 'k', url: 'https://x', log: quietLog, rpc: k.rpc, fetch: F.f });
  chk('a refused Tape is never sent, and is marked failed with the word; the others still go', r.refused === 1 && r.sent === 1 && F.sent.length === 1 &&
    k.calls.some((c) => c.name === 'fairline_tape_mark' && c.body.p_id === 31 && c.body.p_status === 'failed' && /copy rule refused/.test(c.body.p_error)));

  k = fakeRpc(DUE([msg(TAPE, 41), msg(TAPE, 42)])); F = fakeFetch();
  const lines = [];
  r = await SENDER.run({ key: 'svc', apiKey: '', url: 'https://x', dryRun: true, log: (s) => lines.push(s), rpc: k.rpc, fetch: F.f });
  chk('a dry run prints, sends nothing and releases every row', r.printed === 2 && F.sent.length === 0 &&
    k.calls.filter((c) => c.name === 'fairline_tape_mark').every((c) => c.body.p_status === 'release') && lines.some((l) => /Subject: The Tape: /.test(l)) &&
    !lines.some((l) => /reader@example\.com/.test(l)), r);

  /* the workflow runs this before the sender, and the sender only after it */
  const WF = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'lifecycle-email.yml'), 'utf8');
  chk('the hourly email job tests The Tape before it sends it, and the send waits on that test',
    /run: node tools\/fairline\/tape_email\.test\.js/.test(WF) && /id: tape_test/.test(WF) && /steps\.tape_test\.outcome == 'success'/.test(WF) &&
    WF.indexOf('run: node tools/fairline/tape_email.test.js') < WF.indexOf('node tools/fairline/tape_send.js --dry-run'));

  failures.forEach((f) => console.log('FAIL | ' + f));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'fairline tape email — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log('FAIL | the suite ran: ' + (e && e.stack || e)); process.exit(1); });
