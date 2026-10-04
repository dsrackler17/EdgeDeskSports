#!/usr/bin/env node
/* ===========================================================================
   THE DEPLOYMENT'S OWN SAFETY CHECKS, AGAINST A REAL POSTGRESQL.

   supabase/billing_preflight.sql, billing_snapshot.sql, billing_postflight.sql
   and tools/billing/sql/{preflight,apply,verify,rls_probe}.psql are what
   .github/workflows/deploy-billing.yml runs against production. Each one is a
   claim — "read-only", "masked", "commits only if nothing failed", "catches a
   rewritten row", "catches a writer a reader can call" — and each claim is
   tested here, over production-shaped data, by running the exact files the
   workflow runs, the way it runs them (psql, from the repository root).

   Run: node tools/billing/billing_deploy_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const PG = require('../personal/_pg.js');

const T = PG.kit('billing deploy SQL');
const chk = T.chk;
const lit = PG.lit;
const ROOT = PG.ROOT;
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* ── static: what each file promises about itself ─────────────────────────── */
const PRE = read('supabase/billing_preflight.sql');
const SNAP = read('supabase/billing_snapshot.sql');
const POST = read('supabase/billing_postflight.sql');
const PROBE = read('tools/billing/sql/rls_probe.psql');
const APPLY = read('tools/billing/sql/apply.psql');
const strip = (s) => s.replace(/--.*$/gm, '');
chk('preflight: no psql meta-commands (it is pasted into the SQL editor)', !/^\\/m.test(PRE));
chk('preflight: one statement, nothing that writes',
  !/\b(insert|update|delete|create|alter|drop|grant|revoke|truncate)\b\s/i.test(strip(PRE).replace(/'[^']*'/g, "''")) &&
  (strip(PRE).replace(/'[^']*'/g, "''").match(/;/g) || []).length === 1);
chk('preflight: masked unless the operator asks', /billing\.unmasked/.test(PRE) && /'\*\*\*'/.test(PRE));
chk('snapshot: writes only to billing_ops',
  (strip(SNAP).match(/insert into ([a-z_.]+)/gi) || []).every((m) => /billing_ops\./i.test(m)) &&
  !/(update|delete from)\s+public\./i.test(strip(SNAP)));
chk('postflight: writes only its own check rows', (strip(POST).match(/insert into ([a-z_.]+)/gi) || []).every((m) => /billing_ops\.check_runs/i.test(m)) &&
  !/(update|delete from)\s+public\./i.test(strip(POST)));
chk('the role probe never writes a real row (every write is `where false` or null arguments)',
  !/update public\.subscriptions set (?!status = status where false)/.test(PROBE) && !/delete from public\.subscriptions(?! where false)/.test(PROBE));
chk('apply: one transaction, a lock timeout, and a commit only behind the gate',
  /^begin;/m.test(APPLY) && /lock_timeout/.test(APPLY) && APPLY.indexOf('$gate$') < APPLY.indexOf('\\if :commit') && /rollback;/.test(APPLY));

const db = PG.start('bdsql');
if (db.skip) { console.log('NOTE | ' + db.skip + ' — LIVE layer skipped'); process.exit(T.done()); }

/* psql exactly as the workflow runs it: from the repository root, -A -t with a
   ' | ' separator, ON_ERROR_STOP, notices included (2>&1) */
const asRoot = process.getuid && process.getuid() === 0;
let fileN = 0;
function psql(args, inputText) {
  let f = null;
  if (inputText != null) {
    f = path.join(db.home, 'in' + (fileN++) + '.sql');
    fs.writeFileSync(f, inputText);
    if (asRoot) cp.execSync('chown postgres ' + f);
  }
  const cmd = 'cd ' + ROOT + ' && ' + db.bin + '/psql -h ' + db.home + ' -p ' + db.port + " -U postgres -d postgres -X -A -t -F ' | ' -v ON_ERROR_STOP=1 " +
    args + (f ? ' -f ' + f : '') + ' 2>&1';
  const r = cp.spawnSync('sh', ['-c', asRoot ? 'su postgres -c ' + JSON.stringify(cmd) : cmd], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: r.stdout || '' };
}
const SEP = ' | ';
const rows = (out) => out.split('\n').map((l) => l.split(SEP)).filter((c) => c.length >= 5 && /^\d+$/.test(c[0]) && /^(PASS|FAIL|WARN|INFO)$/.test(c[3]))
  .map((c) => ({ n: +c[0], section: c[1], item: c[2], verdict: c[3], detail: c.slice(4).join(SEP) }));
const postRows = (out) => out.split('\n').map((l) => l.split(SEP)).filter((c) => c.length >= 5 && /^\d+$/.test(c[0]) && /^\d+$/.test(c[1]) && /^(PASS|FAIL|WARN|INFO)$/.test(c[3]))
  .map((c) => ({ run: +c[0], n: +c[1], item: c[2], verdict: c[3], detail: c.slice(4).join(SEP) }));
const byN = (rs) => Object.fromEntries(rs.map((r) => [r.n, r]));
const J = (sql) => JSON.parse(db.sql('select coalesce(json_agg(t), \'[]\'::json) from (' + sql + ') t;') || '[]');
const one = (sql) => J(sql)[0];
const V = (sql) => db.sql(sql);

const users = {};
function user(key, email) {
  // distinct leading characters, as real ids have: the masked form keeps 8 of them
  const id = require('crypto').randomUUID();
  V('insert into auth.users (id, email, email_confirmed_at, created_at) values (' + lit(id) + ', ' + lit(email) +
    ", now() - interval '1 day', now() - interval '" + (30 - Object.keys(users).length) + " days');");
  users[key] = id;
  return id;
}
const BILLING_COLS = 'user_id, status, price_id, current_period_end, cancel_at_period_end, stripe_customer_id, stripe_subscription_id, last_event_id, last_event_at, updated_at';

try {
  ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'subscription_price.sql', 'affiliates.sql',
   'personal_research.sql', 'growth.sql', 'funnel.sql', 'site_articles.sql', 'community_posts.sql']
    .forEach((f) => db.applyFile(path.join(ROOT, 'supabase', f)));

  /* production's shape: a comp, a hand-made comp_trial (the reported customer's
     repair), paying and trialing subscribers, a past_due inside its grace, a
     cancellation, a hand-made 2108 row, a failed checkout delivery, and an
     account that went to checkout and has no row */
  const owner = user('owner', 'owner@x.co');
  const connor = user('connor', 'connor.like@x.co');
  const paid = user('paid', 'paid.person@x.co');
  const trial = user('trial', 'trial.person@x.co');
  const late = user('late', 'late.person@x.co');
  const gone = user('gone', 'gone.person@x.co');
  const hand = user('hand', 'hand.made@x.co');
  const lost = user('lost', 'lost.person@x.co');
  const reader = user('reader', 'plain.reader@x.co');
  V(`insert into public.subscriptions (user_id, status, price_id, current_period_end, cancel_at_period_end, stripe_customer_id, stripe_subscription_id) values
     (${lit(owner)},  'active',   'owner_comp', null, false, null, null),
     (${lit(connor)}, 'trialing', 'comp_trial', now() + interval '6 days', true, null, null),
     (${lit(paid)},   'active',   'price_live', now() + interval '20 days', false, 'cus_paid', 'sub_paid'),
     (${lit(trial)},  'trialing', 'price_live', now() + interval '5 days', false, 'cus_trial', 'sub_trial'),
     (${lit(late)},   'past_due', 'price_live', now() - interval '3 days', false, 'cus_late', 'sub_late'),
     (${lit(gone)},   'canceled', 'price_live', now() - interval '9 days', false, 'cus_gone', 'sub_gone'),
     (${lit(hand)},   'active',   null, '2108-01-01', false, null, null);`);
  V(`update public.subscriptions set last_event_id = 'evt_paid_1', last_event_at = now() - interval '2 hours' where user_id = ${lit(paid)};`);
  V(`insert into public.stripe_events (id, type, stripe_created, customer_id, subscription_id, resolved, payload) values
     ('evt_lost_co', 'checkout.session.completed', now() - interval '2 days', 'cus_lost', 'sub_lost', false,
      ${lit(JSON.stringify({ id: 'evt_lost_co', type: 'checkout.session.completed', livemode: true, data: { object: {
        id: 'cs_live_lost', client_reference_id: null, customer: 'cus_lost', subscription: 'sub_lost', customer_details: { email: 'Lost.Person@Relay.example' } } } }))}::jsonb);`);
  V(`insert into public.billing_consents (user_id, user_email, price_display, billing_period, trial_days) values (${lit(lost)}, 'lost.person@x.co', '$49.99', 'month', 7);`);
  const before = J('select ' + BILLING_COLS + ' from public.subscriptions order by user_id');

  /* ===================================================================== */
  /* 1. PREFLIGHT, BEFORE THE MIGRATION                                    */
  /* ===================================================================== */
  let r = psql('-f tools/billing/sql/preflight.psql');
  chk('preflight runs over production-shaped data', r.code === 0, r.out.slice(-1500));
  let pf = byN(rows(r.out));
  chk('it is a before-state', pf[3] && /before-state/.test(pf[3].detail));
  chk('nothing blocks on clean data', rows(r.out).filter((x) => x.verdict === 'FAIL').length === 0, rows(r.out).filter((x) => x.verdict === 'FAIL'));
  chk('1. counts by status, and how many rows grant access',
    pf[101] && /"active": 3/.test(pf[101].detail) && /"trialing": 2/.test(pf[101].detail) && /granting access now 6/.test(pf[101].detail) &&
    /Stripe-backed 3/.test(pf[101].detail), pf[101]);
  chk('4. the hand-made comp_trial is listed, still valid', pf[104] && /^1 \(still valid 1\)/.test(pf[104].detail) && pf[104].detail.indexOf(connor.slice(0, 8)) >= 0, pf[104]);
  chk('5. owner_comp listed', pf[105] && /^1 /.test(pf[105].detail));
  chk('7. past_due inside its grace', pf[107] && /inside the 21-day grace 1/.test(pf[107].detail));
  chk('10/11. no duplicate ids', pf[110].verdict === 'PASS' && pf[111].verdict === 'PASS');
  chk('13. the failed checkout delivery is reported, masked',
    pf[113].verdict === 'WARN' && /checkout\.session\.completed/.test(pf[113].detail) && /"has_client_reference_id": false/.test(pf[113].detail) &&
    /L\*\*\*@Relay\.example/.test(pf[113].detail) && pf[113].detail.indexOf('Lost.Person@') < 0, pf[113]);
  chk('14–17. constraints, indexes, policies and privileges are listed',
    /subscriptions_pkey/.test(pf[201].detail) && /subscriptions\.subscriptions_pkey/.test(pf[202].detail) &&
    /subscriptions_read/.test(pf[203].detail) && /public\.subscriptions: anon -, authenticated S/.test(pf[204].detail), [pf[201], pf[204]]);
  chk('security: readers cannot write subscriptions, read only their own row', pf[301].verdict === 'PASS' && pf[302].verdict === 'PASS');
  chk('security: service-only tables not exposed, writers closed, search_path pinned',
    pf[303].verdict === 'PASS' && pf[305].verdict === 'PASS' && pf[306].verdict === 'PASS' && pf[307].verdict === 'PASS', [pf[303], pf[305], pf[306]]);
  chk('security: my_billing_access is reported as not installed yet', pf[304].verdict === 'INFO');
  chk('security: community_is_entitled answering for any id is a WARN with the follow-up named',
    pf[308].verdict === 'WARN' && /Follow-up/.test(pf[308].detail));
  chk('integrity: the hand-made 2108 row is flagged (never expires? no — protected, no Stripe subscription)',
    pf[408].verdict === 'WARN' && pf[408].detail.indexOf(hand.slice(0, 8)) >= 0);
  chk('integrity: checkout without a row is the reported failure\'s shape', pf[410].verdict === 'WARN' && /^1 accounts/.test(pf[410].detail));
  chk('masked: no full email and no full account id anywhere in the output',
    !/@x\.co/.test(r.out.replace(/[a-z]\*\*\*@x\.co/g, '')) && Object.values(users).every((id) => r.out.indexOf(id) < 0), r.out.match(/[^\s"]*@x\.co/g));
  chk('the behavioural probe passed before the migration', r.code === 0 && /rls_probe: \d+ passed, 0 failed/.test(r.out), r.out.match(/(FAIL|SKIP).*$/gm));
  const fp1 = pf[501].detail;
  chk('the preflight changed nothing', JSON.stringify(J('select ' + BILLING_COLS + ' from public.subscriptions order by user_id')) === JSON.stringify(before) &&
    one('select count(*)::int n from public.stripe_events').n === 1 && one("select to_regnamespace('billing_ops') is null as none").none === true);

  r = psql('', "set billing.unmasked = 'on';\n" + PRE);
  chk('unmasked on request (the SQL editor, which only the owner sees)', r.code === 0 && r.out.indexOf('connor.like@x.co') >= 0 && r.out.indexOf(connor) >= 0);

  /* the integrity checks that BLOCK: an id on two accounts */
  V(`update public.subscriptions set stripe_subscription_id = 'sub_paid', stripe_customer_id = 'cus_paid' where user_id = ${lit(trial)};`);
  r = psql('-f tools/billing/sql/preflight.psql');
  pf = byN(rows(r.out));
  chk('a subscription id on two accounts FAILS the preflight, with both accounts and a proposed fix',
    pf[111].verdict === 'FAIL' && pf[402].verdict === 'FAIL' && pf[402].detail.indexOf(paid.slice(0, 8)) >= 0 &&
    pf[402].detail.indexOf(trial.slice(0, 8)) >= 0 && /proposed_fix/.test(pf[402].detail), pf[402]);
  chk('so does a customer id on two accounts', pf[110].verdict === 'FAIL' && pf[401].verdict === 'FAIL' && /classification/.test(pf[401].detail));
  V(`update public.subscriptions set stripe_subscription_id = 'sub_trial', stripe_customer_id = 'cus_trial' where user_id = ${lit(trial)};`);

  /* ===================================================================== */
  /* 2. THE GATE REFUSES A BAD MIGRATION — AND ROLLS EVERYTHING BACK       */
  /* ===================================================================== */
  const HARD = path.join(ROOT, 'supabase', 'billing_hardening.sql');
  const realHard = fs.readFileSync(HARD, 'utf8');
  const sabotage = (extra) => {
    fs.writeFileSync(HARD, realHard.replace(/\nnotify pgrst, 'reload schema';/, '\n' + extra + "\nnotify pgrst, 'reload schema';"));
    try { return psql("-v commit=1 -v deployed='{}' -f tools/billing/sql/apply.psql"); }
    finally { fs.writeFileSync(HARD, realHard); }
  };
  r = sabotage("update public.subscriptions set price_id = null where price_id = 'comp_trial';");
  chk('a migration that rewrites a row (the comp_trial) is refused at the gate', r.code !== 0 && /postflight FAILED: .*20 B\. no subscriptions row was rewritten/.test(r.out) &&
    /30 C\. every comp_trial/.test(r.out), r.out.slice(-800));
  chk('and NOTHING was kept: no migration, no snapshot, the row intact',
    one("select to_regprocedure('public.my_billing_access()') is null as none").none === true &&
    one("select to_regnamespace('billing_ops') is null as none").none === true &&
    JSON.stringify(J('select ' + BILLING_COLS + ' from public.subscriptions order by user_id')) === JSON.stringify(before));
  r = sabotage('grant execute on function public.billing_apply_subscription_state(uuid,text,text,text,text,timestamptz,boolean,timestamptz,text,boolean,boolean,text,timestamptz,boolean) to authenticated;');
  chk('a migration that lets a reader call the writer is refused (catalog AND behaviour)',
    r.code !== 0 && /FAIL\s+a reader RAN: select public\.billing_apply_subscription_state/.test(r.out), r.out.slice(-1200));
  chk('and nothing was kept', one("select to_regprocedure('public.my_billing_access()') is null as none").none === true);
  r = sabotage("create policy subscriptions_peek on public.subscriptions for select to authenticated using (true);");
  chk('a policy that lets a reader see every row is refused by the behavioural probe',
    r.code !== 0 && /FAIL\s+a reader CAN see another account/.test(r.out), r.out.slice(-800));

  /* ===================================================================== */
  /* 3. THE DRY RUN, THEN THE REAL ONE                                     */
  /* ===================================================================== */
  r = psql("-v commit=0 -v deployed='{\"stripe_webhook\":{\"version\":7}}' -f tools/billing/sql/apply.psql");
  chk('dry run: every check passes against the data', r.code === 0 && /GATE\s+postflight and access checks passed/.test(r.out) && /DRY RUN/.test(r.out), r.out.slice(-1500));
  let post = postRows(r.out);
  chk('dry run: the postflight printed A–I', [10, 11, 20, 21, 30, 40, 41, 50, 60, 61, 70, 71, 72, 80, 81, 82, 90].every((n) => post.some((x) => x.n === n)), post.map((x) => x.n));
  chk('dry run: the migration\'s own report said ok throughout', !/CHECK THIS/.test(r.out));
  chk('dry run: and it was ALL rolled back',
    one("select to_regprocedure('public.my_billing_access()') is null as none").none === true &&
    one("select to_regnamespace('billing_ops') is null as none").none === true);

  r = psql("-v commit=1 -v deployed='{\"stripe_webhook\":{\"version\":7}}' -f tools/billing/sql/apply.psql");
  chk('apply: committed behind a passing gate', r.code === 0 && /COMMITTED/.test(r.out), r.out.slice(-1500));
  post = byN(postRows(r.out));
  chk('A. installed', post[10].verdict === 'PASS' && post[11].verdict === 'PASS');
  chk('B. no row rewritten, and the paying-users count is the same before and after',
    post[20].verdict === 'PASS' && /unchanged 7/.test(post[20].detail) && post[21].verdict === 'PASS' && /before 6 \(Stripe-backed 3\) · after 6 \(Stripe-backed 3\)/.test(post[21].detail), [post[20], post[21]]);
  chk('C. the comp_trial and the owner_comp keep their meaning',
    post[30].verdict === 'PASS' && post[30].detail.indexOf(connor.slice(0, 8) + '… trialing/comp_trial') >= 0 && /cancel_at_end true → access true/.test(post[30].detail), post[30]);
  chk('D. every business case', post[40].verdict === 'PASS' && /past_due, outside the grace → false/.test(post[40].detail) && post[41].verdict === 'PASS');
  chk('E. community_is_entitled agrees for every account', post[50].verdict === 'PASS', post[50]);
  chk('F. my_billing_access and the decision', post[60].verdict === 'PASS' && post[61].verdict === 'PASS');
  chk('G. writers closed, operator functions guarded, search_path pinned', post[70].verdict === 'PASS' && post[71].verdict === 'PASS' && post[72].verdict === 'PASS', [post[70], post[71], post[72]]);
  chk('H. new records service-only; billing_ops private', post[80].verdict === 'PASS' && post[81].verdict === 'PASS' && post[82].verdict === 'PASS');
  chk('I. the unique index was created and says so', post[90].verdict === 'PASS' && /created/.test(post[90].detail));
  chk('the backfill is reported', /billing_customers 4/.test(post[95].detail), post[95]);
  chk('the rows are byte-for-byte what they were', JSON.stringify(J('select ' + BILLING_COLS + ' from public.subscriptions order by user_id')) === JSON.stringify(before));
  const snap = one("select label, summary, jsonb_array_length(subscriptions) n, deployed from billing_ops.snapshots order by id desc limit 1");
  chk('the snapshot holds every row in full, privately, with the deployed versions',
    snap.label === 'pre-apply' && snap.n === 7 && snap.summary.granting_access === 6 && snap.deployed.stripe_webhook.version === 7 &&
    snap.summary.fingerprint && fp1.indexOf(snap.summary.fingerprint) === 0, snap);
  chk('the snapshot is out of every client\'s reach', db.mustFail(() => db.as(reader, 'select count(*) from billing_ops.snapshots;')) !== null &&
    db.mustFail(() => db.anon('select count(*) from billing_ops.check_runs;')) !== null);

  /* ===================================================================== */
  /* 4. LATER: VERIFY, AND WHAT B TELLS APART                              */
  /* ===================================================================== */
  r = psql('-f tools/billing/sql/verify.psql');
  chk('verify passes after the apply', r.code === 0 && postRows(r.out).every((x) => x.verdict !== 'FAIL') && /rls_probe: \d+ passed, 0 failed/.test(r.out), r.out.slice(-1200));
  chk('and the probe now covers the installed functions', (r.out.match(/PASS\s+refused to a reader/g) || []).length >= 25 &&
    /PASS\s+my_billing_access\(\) answers for the caller, and only the caller/.test(r.out));
  r = psql('-f tools/billing/sql/preflight.psql');
  pf = byN(rows(r.out));
  chk('the preflight now reads the after-state, every security row green',
    /after-state/.test(pf[3].detail) && ['301', '302', '303', '304', '305', '306', '307'].every((n) => pf[n].verdict === 'PASS'), [pf[303], pf[304], pf[305]]);
  chk('and its fingerprint is unchanged by the migration', pf[501].detail === fp1);

  V(`update public.subscriptions set status = 'active', updated_at = now() + interval '1 second' where user_id = ${lit(trial)};`);
  post = byN(postRows(psql('-f tools/billing/sql/verify.psql').out));
  chk('B: a webhook write after the snapshot is a WARN (the application wrote it), not a FAIL', post[20].verdict === 'WARN' && /by the application since the snapshot 1/.test(post[20].detail), post[20]);
  V(`update public.subscriptions set cancel_at_period_end = false where user_id = ${lit(connor)};`);
  r = psql('-f tools/billing/sql/verify.psql');
  post = byN(postRows(r.out));
  chk('B/C: a row changed WITHOUT the application (same updated_at) is a FAIL — and C names the comp',
    post[20].verdict === 'FAIL' && /changed WITHOUT the application 1/.test(post[20].detail) && post[30].verdict === 'FAIL', [post[20], post[30]]);
  V(`update public.subscriptions set cancel_at_period_end = true where user_id = ${lit(connor)};`);

  r = psql('', 'select count(*) from billing_ops.check_runs;');
  chk('every verification run is kept, privately, for the record', +r.out.trim() > 30, r.out);
} catch (e) {
  chk('the suite ran to the end', false, String(e.message || e).slice(0, 1500));
} finally {
  db.stop();
}
process.exit(T.done());
