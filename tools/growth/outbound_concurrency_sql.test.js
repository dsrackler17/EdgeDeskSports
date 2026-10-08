#!/usr/bin/env node
/* ===========================================================================
   PHASE 11 — AT THE SAME INSTANT: the outbound database under real
   concurrency (supabase/growth_outbound.sql).

   Every race here is run for real: separate PostgreSQL sessions, held at a
   gate (an advisory lock) and released together, so they hit the same rows
   in the same instant. What must hold, whoever wins:

     S  SAME DRAFT      eight claims of one approved draft: one send, ever
     C  THE CAP         ten claims against a cap with room for five: five
     A  APPROVALS       two batches over the same drafts in opposite orders:
                        no deadlock, each draft approved once, all or nothing
     T  THE TICK        four ticks at once: one morning-run step, not four
     K  CANDIDATES      two runs recording the same new address: one
                        candidate, neither run refused
     W  WEBHOOK         one Resend event delivered five times at once: applied
                        once, every delivery answered
     O  OPT-OUT         one opt-out link pressed five times at once: one
                        suppression
     M  MATCHING        four matchers at once: each result recorded once, one
                        conversion logged, no error
     X  CLAIM vs REJECT a send claimed while the draft is withdrawn: sent or
                        withdrawn, never both

   Run: node tools/growth/outbound_concurrency_sql.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const crypto = require('crypto');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const SEED = require(path.join(__dirname, '_outbound_seed.js'));
const MORNING = require(path.join(__dirname, '_morning.js'));

const T = PG.kit('growth outbound concurrency SQL');
const chk = T.chk;
const lit = PG.lit;

const db = PG.start('goconc');
if (db.skip) { console.log('NOTE | ' + db.skip + ' — LIVE layer skipped'); process.exit(T.done()); }

const OWNER = '00000000-0000-0000-0000-0000000000a1';
const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const j = (s) => JSON.parse(s);
const one = (sql) => db.sql(sql);
const own = (sql) => j(db.as(OWNER, sql));
const J = (o) => lit(JSON.stringify(o)) + '::jsonb';
const pad = (n) => String(n).padStart(12, '0');
const pid = (n) => '10000000-0000-0000-0000-' + pad(n);
const did = (n) => '20000000-0000-0000-0000-' + pad(n);
const settings = (o) => own(`select public.growth_outbound_settings_update(${J(o)});`);
const hashOf = (d) => one(`select content_hash from growth_outbound.drafts where id = ${lit(d)};`);
const count = (t, where) => +one(`select count(*) from growth_outbound.${t}${where ? ' where ' + where : ''};`);

/* ── the gate ─────────────────────────────────────────────────────────────
   One session holds an exclusive advisory lock; every racer first waits for a
   shared hold of it, then lets go and runs. Releasing the gate releases them
   all at once. Each racer is its own psql session; its last line of output
   is its answer. */
const GATE = 7474;
const claimAs = (uid) => `do $claim$ begin perform set_config('request.jwt.claim.sub', ${lit(uid || '')}, true); end $claim$;\n`;
const wrap = (r) => r.as === 'super' ? r.sql
  : 'begin;\n' + claimAs(r.as === 'anon' ? '' : r.as) + 'set local role ' + (r.as === 'anon' ? 'anon' : 'authenticated') + ';\n' + r.sql + '\ncommit;\n';
function race(racers) {
  const gate = db.background(`select pg_advisory_lock(${GATE}); select pg_sleep(${(0.6 + racers.length * 0.08).toFixed(2)}); select pg_advisory_unlock(${GATE});`);
  db.sleep(0.3);
  const runs = racers.map((r) => db.background(`select pg_advisory_lock_shared(${GATE}); select pg_advisory_unlock_shared(${GATE});\n` + wrap(r)));
  gate.wait(20000);
  return runs.map((x) => {
    const w = x.wait(90000);
    const lines = w.out.split('\n').map((l) => l.trim()).filter((l) => l && l !== 't' && l !== 'BEGIN' && l !== 'COMMIT' && l !== 'DO' && l !== 'SET');
    let answer = null;
    try { answer = JSON.parse(lines[lines.length - 1]); } catch (_) { answer = null; }
    return { code: w.code, out: w.out, answer };
  });
}
const allOk = (rs) => rs.every((r) => r.code === 0);
const errs = (rs) => rs.filter((r) => r.code !== 0).map((r) => r.out.slice(0, 300));

/* a prospect with an approved first email */
function ready(n, name) {
  const [first, last] = name.split(' ');
  const dom = (first + last).toLowerCase() + '.test';
  one(SEED.strong({ id: pid(n), name, org: last + ' Media', email: first.toLowerCase() + '@' + dom, domain: dom, handle: (first + last).toLowerCase() })
    + SEED.draft({ id: did(n), prospect: pid(n), subject: 'Your work, ' + first, body: 'Hi ' + first + ',' }));
  return first.toLowerCase() + '@' + dom;
}
const approve = (d) => own(`select public.growth_outbound_draft_approve(${lit(d)}, ${lit(hashOf(d))});`);

try {
  ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql', 'growth_outbound.sql']
    .forEach((f) => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f)));
  one(`insert into auth.users (id, email, email_confirmed_at, created_at) values ('${OWNER}', 'owner@edgedesk.test', now(), now() - interval '1 year');
       insert into public.affiliate_admins (user_id) values ('${OWNER}');
       select growth_outbound.grant_owner('owner@edgedesk.test');`);
  settings({ postal_address: 'EdgeDesk Sports, 100 Example St, Springfield, IL 62701', test_inbox: 'owner-test@edgedesk.test',
    unsubscribe_url_base: 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/' });
  one(`select growth_outbound.set_webhook_secret(${lit(SECRET)});`);
  one(SEED.liveReady());   // (Phase 13) the opt-out endpoint checked, the webhook proven
  const NAMES = ['Ana Bell', 'Bo Dunn', 'Cy Park', 'Dee Fox', 'Eli Hart', 'Fay Lund', 'Gus Hale', 'Hal Ives', 'Ida Moss', 'Jo Kerr',
    'Kai Lowe', 'Lee Lines', 'Max Nye', 'Ned Orr', 'Ola Reed', 'Pat Quill'];
  const EM = {};
  NAMES.forEach((nm, i) => { EM[i + 1] = ready(i + 1, nm); });
  chk('(setup) sixteen prospects, each with a draft ready for review', count('drafts', `status = 'pending_review'`) === 16);

  /* ══ S. ONE DRAFT, EIGHT CLAIMS ═══════════════════════════════════════ */
  approve(did(1));
  let rs = race(Array.from({ length: 8 }, () => ({ as: OWNER, sql: `select public.growth_outbound_send_claim(${lit(did(1))});` })));
  chk('S eight claims of one draft at once: every one answered, no error', allOk(rs) && rs.every((r) => r.answer && r.answer.ok === true), errs(rs));
  chk('S … and exactly one send exists for it, with one key', count('sends', `draft_id = ${lit(did(1))}`) === 1
    && new Set(rs.map((r) => r.answer.idempotency_key || r.answer.resend_message_id || 'x')).size === 1, rs.map((r) => r.answer));
  chk('S … the others were told it is a retry of the same send', rs.filter((r) => r.answer.retry).length === 7
    && +one(`select attempts from growth_outbound.sends where draft_id = ${lit(did(1))};`) === 8);

  /* ══ C. THE CAP ═══════════════════════════════════════════════════════ */
  [2, 3, 4, 5, 6, 7, 8, 9, 10, 11].forEach((n) => approve(did(n)));
  settings({ max_test_sends_per_day: 6 });
  rs = race([2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => ({ as: OWNER, sql: `select public.growth_outbound_send_claim(${lit(did(n))});` })));
  const won = rs.filter((r) => r.answer && r.answer.ok === true), lost = rs.filter((r) => r.answer && r.answer.ok === false);
  chk('C ten claims at once against a cap with room for five: five sent, five refused, none in error', allOk(rs) && won.length === 5 && lost.length === 5
    && lost.every((r) => /daily test-send cap \(6\) is reached/.test(r.answer.detail || '')), [won.length, lost.length, errs(rs), lost.map((r) => r.answer)]);
  chk('C … and the day holds exactly the cap', count('sends', `is_test and claimed_at >= date_trunc('day', now())`) === 6);
  chk('C … the refused drafts are still approved, ready for tomorrow', count('drafts', `status = 'approved' and id in (${[2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => lit(did(n))).join(',')})`) === 5);

  /* ══ A. TWO BATCHES, OPPOSITE ORDERS ══════════════════════════════════ */
  const item = (n) => ({ draft_id: did(n), content_hash: hashOf(did(n)) });
  let deadlocks = 0, doubled = 0, partial = 0;
  for (const [a, b] of [[12, 13], [14, 15]]) {
    rs = race([{ as: OWNER, sql: `select public.growth_outbound_drafts_approve_batch(${J([item(a), item(b)])}, 2);` },
               { as: OWNER, sql: `select public.growth_outbound_drafts_approve_batch(${J([item(b), item(a)])}, 2);` }]);
    deadlocks += rs.filter((r) => /deadlock/.test(r.out)).length;
    const approvals = +one(`select count(*) from growth_outbound.activity where action = 'draft_approved' and entity_id in (${lit(did(a))}, ${lit(did(b))});`);
    if (approvals > 2) doubled++;
    if (count('drafts', `status = 'approved' and id in (${lit(did(a))}, ${lit(did(b))})`) !== 2) partial++;
    chk('A batches [' + a + ',' + b + '] and [' + b + ',' + a + '] at once: one approves both, the other approves nothing and says why',
      allOk(rs) && rs.filter((r) => r.answer && r.answer.ok === true).length === 1
      && rs.filter((r) => r.answer && r.answer.ok === false && r.answer.reason === 'not_all_approvable').length === 1, [errs(rs), rs.map((r) => r.answer)]);
  }
  chk('A no deadlock, no draft approved twice, never half a batch', deadlocks === 0 && doubled === 0 && partial === 0, { deadlocks, doubled, partial });

  /* ══ T. FOUR TICKS ════════════════════════════════════════════════════ */
  MORNING.install(db);
  settings({ discovery_config: { queries: ['cfb power ratings newsletter'] } });
  // results were matched a minute ago, so no tick matches them now: nothing but the tick itself orders the four
  one(`update growth_outbound.scheduler set conversions_synced_at = now() where id = 1;`);
  rs = race(Array.from({ length: 4 }, () => ({ as: 'super', sql: `select growth_outbound.schedule_tick(${lit(MORNING.BASE)}, now());` })));
  const started = rs.filter((r) => r.answer && r.answer.action === 'started');
  chk('T four ticks at once: every one answered, exactly one step started, one request posted', allOk(rs) && started.length === 1
    && count('research_runs', `started_by = 'schedule' and status = 'running'`) === 1 && +one(`select count(*) from net.calls;`) === 1,
    [errs(rs), rs.map((r) => r.answer)]);
  chk('T … the others say a step is still going', rs.filter((r) => r.answer && r.answer.action === 'idle' && /a scheduled run is still going/.test(r.answer.reason || '')).length === 3,
    rs.map((r) => r.answer));
  one(`update growth_outbound.research_runs set status = 'done', finished_at = now() where status = 'running';
       update growth_outbound.settings set automation_enabled = false where id = 1;`);

  /* ══ K. THE SAME NEW ADDRESS, TWO RUNS ════════════════════════════════ */
  const r1 = own(`select public.growth_outbound_research_begin('discover', '{}'::jsonb);`).run_id;
  const r2 = own(`select public.growth_outbound_research_begin('discover', '{}'::jsonb);`).run_id;
  const ITEMS = [{ url: 'https://newcomer.test/', provider: 'brave', title: 'Newcomer', query: 'cfb models' },
                 { url: 'https://another.test/about', provider: 'brave', title: 'Another', query: 'cfb models' }];
  rs = race([{ as: OWNER, sql: `select public.growth_outbound_candidates_record(${r1}, ${J(ITEMS)});` },
             { as: OWNER, sql: `select public.growth_outbound_candidates_record(${r2}, ${J(ITEMS.slice().reverse())});` }]);
  chk('K two runs record the same new addresses at once: neither is refused', allOk(rs) && rs.every((r) => r.answer && r.answer.ok === true), errs(rs));
  const KURLS = `url in (growth_outbound.canonical_url('https://newcomer.test/'), growth_outbound.canonical_url('https://another.test/about'))`;
  chk('K … each address is one candidate, seen twice', count('candidates', KURLS) === 2
    && one(`select string_agg(times_seen::text, ',' order by url) from growth_outbound.candidates where ${KURLS};`) === '2,2'
    && rs.reduce((a, r) => a + r.answer.new + r.answer.seen_again, 0) === 4, rs.map((r) => r.answer));

  /* ══ W. ONE EVENT, FIVE DELIVERIES ════════════════════════════════════ */
  const S2 = one(`select id from growth_outbound.sends where is_test order by claimed_at offset 1 limit 1;`);
  one(`update growth_outbound.sends set resend_message_id = 're_conc_000001', sent_at = now(), delivery_status = 'sent' where id = ${lit(S2)};`);
  const ts = String(Math.floor(Date.now() / 1000)), evid = 'msg_conc_evt_1';
  const body = JSON.stringify({ type: 'email.delivered', created_at: new Date().toISOString(), data: { email_id: 're_conc_000001' } });
  const sig = 'v1,' + crypto.createHmac('sha256', Buffer.from(SECRET.slice(6), 'base64')).update(evid + '.' + ts + '.' + body, 'utf8').digest('base64');
  rs = race(Array.from({ length: 5 }, () => ({ as: 'anon', sql: `select public.growth_outbound_webhook(${lit(evid)}, ${lit(ts)}, ${lit(sig)}, ${lit(body)});` })));
  chk('W one event delivered five times at once: every delivery answered', allOk(rs) && rs.every((r) => r.answer && r.answer.ok === true), errs(rs));
  chk('W … applied once: one event kept, the send delivered once', count('provider_events', `event_id = ${lit(evid)}`) === 1
    && one(`select delivery_status from growth_outbound.sends where id = ${lit(S2)};`) === 'delivered'
    && rs.filter((r) => r.answer.duplicate).length === 4, rs.map((r) => r.answer));

  /* ══ O. ONE LINK, FIVE PRESSES ════════════════════════════════════════ */
  const tok = one(`select optout_token from growth_outbound.sends where id = ${lit(S2)};`);
  const supBefore = count('suppressions');
  rs = race(Array.from({ length: 5 }, () => ({ as: 'anon', sql: `select public.growth_outbound_optout(${lit(tok)}, true);` })));
  chk('O one opt-out link pressed five times at once: every press answered', allOk(rs) && rs.every((r) => r.answer && r.answer.ok === true), errs(rs));
  chk('O … one suppression, not five', count('suppressions') - supBefore <= 1, count('suppressions') - supBefore);

  /* ══ M. FOUR MATCHERS ═════════════════════════════════════════════════ */
  settings({ test_mode: false, confirm_live: true, max_sends_per_day: 50, confirm_cap_increase: true });
  approve(did(16));
  const c16 = own(`select public.growth_outbound_send_claim(${lit(did(16))});`);
  own(`select public.growth_outbound_send_result(${lit(c16.send_id)}, 're_conc_live_16', null, false);`);
  one(`insert into auth.users (id, email, created_at) values ('30000000-0000-0000-0000-000000000016', ${lit(EM[16])}, now());`);
  rs = race(Array.from({ length: 4 }, () => ({ as: 'super', sql: `select growth_outbound.sync_conversions();` })));
  chk('M four matchers at once: no error', allOk(rs), errs(rs));
  chk('M … the account is recorded once, and the conversion logged once', count('conversions', `prospect_id = ${lit(pid(16))}`) === 1
    && count('activity', `action = 'prospect_converted' and prospect_id = ${lit(pid(16))}`) === 1
    && one(`select status from growth_outbound.prospects where id = ${lit(pid(16))};`) === 'converted',
    [count('conversions', `prospect_id = ${lit(pid(16))}`), count('activity', `action = 'prospect_converted'`)]);

  /* ══ X. CLAIM vs WITHDRAW ═════════════════════════════════════════════ */
  approve(did(14 + 0));   // already approved by A; make sure of one approved, unsent live draft
  const X = one(`select id from growth_outbound.drafts where status = 'approved' and not exists (select 1 from growth_outbound.sends s where s.draft_id = drafts.id)
                  and sequence_number = 1 order by id limit 1;`);
  rs = race([{ as: OWNER, sql: `select public.growth_outbound_send_claim(${lit(X)});` },
             { as: OWNER, sql: `select public.growth_outbound_draft_unapprove(${lit(X)}, 'changed my mind');` }]);
  const sent = count('sends', `draft_id = ${lit(X)}`), st = one(`select status from growth_outbound.drafts where id = ${lit(X)};`);
  chk('X a send claimed while its approval is withdrawn: sent, or withdrawn — never both', allOk(rs)
    && ((sent === 1 && st === 'sent') || (sent === 0 && st === 'pending_review')), [sent, st, errs(rs), rs.map((r) => r.answer)]);

  /* ══ Y. ONE REPLY, MANY EVENTS (2026-10) ═══════════════════════════════ */
  const qEmail = ready(17, 'Quin Rowe');
  approve(did(17));
  const c17 = own(`select public.growth_outbound_send_claim(${lit(did(17))});`);
  own(`select public.growth_outbound_send_result(${lit(c17.send_id)}, 're_conc_live_17', null, false);`);
  const rts = String(Math.floor(Date.now() / 1000));
  const rcvd = (eid) => JSON.stringify({ type: 'email.received', created_at: new Date().toISOString(),
    data: { email_id: eid, from: 'Quin Rowe <' + qEmail + '>', to: ['replies@edgedesksports.com'], subject: 'Re: Your work, Quin' } });
  const delivery = (evid, b) => ({ as: 'anon', sql: `select public.growth_outbound_webhook(${lit(evid)}, ${lit(rts)}, ${lit('v1,' + crypto.createHmac('sha256',
    Buffer.from(SECRET.slice(6), 'base64')).update(evid + '.' + rts + '.' + b, 'utf8').digest('base64'))}, ${lit(b)});` });
  rs = race([1, 2, 3, 4, 5].map((n) => delivery('msg_conc_rcv_a' + n, rcvd('rcv_conc_1')))
    .concat([2, 3, 4].map((n) => delivery('msg_conc_rcv_b' + n, rcvd('rcv_conc_' + n)))));
  chk('Y one reply under five event ids, and three more replies from the same person, all at once: every delivery answered, no error',
    allOk(rs) && rs.every((r) => r.answer && r.answer.ok === true), errs(rs));
  chk('Y … that email recorded once, four replies in all, "replied" logged once, the sequence ended once',
    count('replies', `resend_email_id = 'rcv_conc_1'`) === 1 && count('replies', `prospect_id = ${lit(pid(17))}`) === 4
    && count('activity', `action = 'prospect_replied' and prospect_id = ${lit(pid(17))}`) === 1
    && one(`select status from growth_outbound.prospects where id = ${lit(pid(17))};`) === 'replied'
    && rs.filter((r) => r.answer.outcome === 'reply_duplicate').length === 4,
    [count('replies', `prospect_id = ${lit(pid(17))}`), rs.map((r) => r.answer)]);

  const out = db.applyFileAtomic(path.join(PG.ROOT, 'supabase', 'growth_outbound.sql'));
  chk('the file runs again over all of this, every report row ok', !/CHECK THIS/.test(out), out.split('\n').filter((l) => /CHECK THIS/.test(l)));
} catch (err) {
  chk('suite ran to the end', false, String(err && err.stack || err).slice(0, 3000));
} finally {
  db.stop();
}
process.exit(T.done());
