#!/usr/bin/env node
/* ===========================================================================
   THE DEPLOYMENT, REHEARSED END TO END.

   tools/billing/deploy_stage.sh is the script deploy-billing.yml runs against
   production. Here it runs, unmodified, as a child process — real bash, real
   psql, real `node tools/billing/prod_probe.js` — against a stand-in for
   everything it talks to:

     the database      a throwaway PostgreSQL holding production's shape BEFORE
                       the migration (tools/billing/_harness.js, preMigration)
     the gateway       a local HTTP server: /functions/v1/<name> runs the
                       SHIPPED function once it has been "deployed",
                       /rest/v1 and /auth/v1 answer from the database
     Management API    /v1/projects/<ref>/functions and /secrets
     `supabase` CLI    a stub on PATH that deploys by loading the function file
                       from the working tree, and sets / unsets secrets
     the website       the repository's own files

   and the stages run in the order the runbook gives, including the ones that
   must REFUSE: deploying a function before the migration, the webhook before
   sync_subscription, the schedule on a project without pg_cron.

   Run: node tools/billing/deploy_stage.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const H = require('./_harness.js');
const PG = require('../personal/_pg.js');

let pass = 0, fail = 0;
const chk = (label, ok, detail) => { if (ok) pass++; else { fail++; console.log('FAIL | ' + label + (detail !== undefined ? '  ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(-1500) : '')); } };

const W = H.world('stage', { preMigration: true, extraFiles: ['site_articles.sql', 'community_posts.sql'] });
if (W.skip) { console.log('NOTE | ' + W.skip + ' — skipped'); process.exit(0); }
const ROOT = PG.ROOT;

/* ── the stand-in for Supabase ─────────────────────────────────────────────── */
const deployed = {};          // name -> { handler, version, at }
const secrets = { STRIPE_SECRET_KEY: 1, STRIPE_WEBHOOK_SECRET: 1, SB_URL: 1, SB_SERVICE_ROLE: 1 };
let fnEnv = Object.assign({}, W.env, { STRIPE_PRICE_ID: '' });   // the price is not set until the stage sets it
function deploy(name) {
  const prev = deployed[name];
  deployed[name] = { handler: H.loadFunction(name, fnEnv, W.route, W.logs), version: prev ? prev.version + 1 : 1, at: new Date().toISOString() };
}
async function readBody(req) { const chunks = []; for await (const c of req) chunks.push(c); return Buffer.concat(chunks).toString('utf8'); }
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://local');
    const body = await readBody(req);
    const send = async (r) => {
      const text = await r.text();
      const hdrs = { 'content-type': 'application/json' };
      if (r.headers && typeof r.headers.get === 'function' && r.headers.get('x-edgedesk-build')) hdrs['x-edgedesk-build'] = r.headers.get('x-edgedesk-build');
      res.writeHead(r.status, hdrs); res.end(text);
    };
    if (url.pathname === '/__cli') {
      const a = body.trim().split(/\s+/);
      if (a[0] === 'functions' && a[1] === 'deploy') deploy(a[2]);
      else if (a[0] === 'functions' && a[1] === 'delete') delete deployed[a[2]];
      else if (a[0] === 'secrets' && a[1] === 'set') {
        const [k, v] = a[2].split('='); secrets[k] = 1; fnEnv[k] = v;
        if (deployed.create_checkout_session) deployed.create_checkout_session.handler = H.loadFunction('create_checkout_session', fnEnv, W.route, W.logs);
      } else if (a[0] === 'secrets' && a[1] === 'unset') {
        delete secrets[a[2]]; fnEnv[a[2]] = '';
        if (deployed.create_checkout_session) deployed.create_checkout_session.handler = H.loadFunction('create_checkout_session', fnEnv, W.route, W.logs);
      } else { res.writeHead(400); res.end('unknown cli ' + body); return; }
      res.writeHead(200); res.end('ok'); return;
    }
    let m;
    if ((m = /^\/functions\/v1\/([a-z_]+)$/.exec(url.pathname))) {
      const d = deployed[m[1]];
      if (!d) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"code":"NOT_FOUND","message":"Requested function was not found"}'); return; }
      const r = await d.handler(new Request('https://db.test' + req.url, { method: req.method, headers: req.headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body }));
      return send(r);
    }
    if (url.pathname.indexOf('/rest/v1/') === 0 || url.pathname.indexOf('/auth/v1/') === 0) {
      return send(await W.rest.fetch('https://db.test' + req.url, { method: req.method, headers: req.headers, body: body || undefined }));
    }
    if ((m = /^\/v1\/projects\/[a-z]+\/(functions|secrets)$/.exec(url.pathname))) {
      if (req.headers.authorization !== 'Bearer mgmt-token') { res.writeHead(401); res.end('{}'); return; }
      const out = m[1] === 'functions'
        ? Object.keys(deployed).map((k) => ({ slug: k, version: deployed[k].version, status: 'ACTIVE', verify_jwt: false, updated_at: deployed[k].at }))
          .concat([{ slug: 'edgedesk_ai', version: 40, status: 'ACTIVE', verify_jwt: true, updated_at: '2026-09-29T20:13:00Z' }])
        : Object.keys(secrets).map((k) => ({ name: k, value: 'sha256-digest-not-the-value' }));
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out)); return;
    }
    if (url.pathname.indexOf('/site') === 0) {
      const p = url.pathname.slice(5) || '/';
      const file = p === '/' ? 'index.html' : p.endsWith('/') ? p.slice(1) + 'index.html' : p.slice(1);
      try { const t = fs.readFileSync(path.join(ROOT, file)); res.writeHead(200); res.end(t); } catch (_) { res.writeHead(404); res.end('nf'); }
      return;
    }
    res.writeHead(404); res.end('no route');
  } catch (e) { res.writeHead(500); res.end(String(e.stack || e)); }
});

/* ── the stage, as the workflow runs it ───────────────────────────────────── */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-stage-'));
const BIN = path.join(TMP, 'bin');
fs.mkdirSync(BIN);
let PORT = 0;
let ALLOUT = '';
function stage(name, extraEnv) {
  const summary = path.join(TMP, name + '-' + Date.now() + '.md');
  const env = Object.assign({}, process.env, {
    PATH: BIN + ':' + process.env.PATH,
    SB_DB_URL: 'postgresql://postgres@/postgres?host=' + W.db.home + '&port=' + W.db.port,
    SB_URL: 'http://127.0.0.1:' + PORT, SB_SERVICE_ROLE: 'service-key', SB_ANON: 'anon-key',
    SUPABASE_ACCESS_TOKEN: 'mgmt-token', SUPABASE_PROJECT_REF: 'testref', SUPABASE_API: 'http://127.0.0.1:' + PORT,
    SITE_URL: 'http://127.0.0.1:' + PORT + '/site', RUNNER_TEMP: TMP, GITHUB_STEP_SUMMARY: summary,
    BILLING_TRACE_WAIT_S: '0', BILLING_CRON_WAIT_S: '0',
  }, extraEnv || {});
  return new Promise((resolve) => {
    const p = cp.spawn('bash', [path.join(ROOT, 'tools', 'billing', 'deploy_stage.sh'), name], { env, cwd: ROOT });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => { ALLOUT += out; resolve({ code, out, summary: fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : '' }); });
  });
}
const installed = () => W.db.sql("select to_regprocedure('public.my_billing_access()') is not null;") === 't';
const leaks = (text) => {
  const ids = W.q('select id::text as id from auth.users').map((r) => r.id);
  return ids.filter((id) => text.indexOf(id) >= 0).map((id) => 'full id ' + id.slice(0, 8))
    .concat(/tok_[a-z0-9_]{6,}/i.test(text) ? ['a token'] : [], /sha256-digest-not-the-value/.test(text) ? ['a secret value'] : [],
            /[a-z0-9.]{2,}@x\.co\b/i.test(text.replace(/[a-z]\*\*\*@x\.co/gi, '')) ? ['a customer email'] : []);
};

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  PORT = server.address().port;
  fs.writeFileSync(path.join(BIN, 'supabase'), '#!/bin/sh\ncurl -sS -f -X POST --data "$*" http://127.0.0.1:' + PORT + '/__cli >/dev/null\n');
  fs.chmodSync(path.join(BIN, 'supabase'), 0o755);
  try {
    /* production's shape: a paying customer through the OLD webhook's world,
       a hand-made comp_trial, an owner comp */
    const owner = W.user('owner.person@x.co');
    const connor = W.user('connor.like@x.co');
    const paid = W.user('paid.person@x.co');
    W.db.sql(`insert into public.subscriptions (user_id, status, price_id, current_period_end, cancel_at_period_end, stripe_customer_id, stripe_subscription_id) values
      (${PG.lit(owner.id)}, 'active', 'owner_comp', null, false, null, null),
      (${PG.lit(connor.id)}, 'trialing', 'comp_trial', now() + interval '6 days', true, null, null);`);
    const cust = W.stripe.customer('paid.person@x.co', {});
    const sub = W.stripe.subscription(cust.id, 'price_4999', { status: 'active' });
    W.db.sql(`insert into public.subscriptions (user_id, status, price_id, current_period_end, stripe_customer_id, stripe_subscription_id) values
      (${PG.lit(paid.id)}, 'active', 'price_4999', to_timestamp(${sub.current_period_end}), ${PG.lit(cust.id)}, ${PG.lit(sub.id)});`);
    const COLS = ['status', 'price_id', 'current_period_end', 'cancel_at_period_end', 'stripe_customer_id', 'stripe_subscription_id', 'updated_at'];
    const billingOf = (uid) => { const r0 = W.row(uid); return JSON.stringify(r0 && COLS.map((c) => r0[c])); };
    const connorRow = billingOf(connor.id);

    let r = await stage('preflight');
    chk('preflight: passes on clean production-shaped data', r.code === 0 && /Preflight: no FAIL/.test(r.summary), r.out);
    chk('preflight: records what is deployed, and secret NAMES only', /Function secrets present: SB_SERVICE_ROLE, SB_URL, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET/.test(r.summary) &&
      !/sha256-digest/.test(r.out + r.summary), r.summary.slice(0, 800));
    chk('preflight: the frontend probe ran against the live site', /the live site serves this commit's \//.test(r.out));
    chk('preflight: nothing was installed', !installed());

    r = await stage('deploy_sync_subscription');
    chk('a function cannot be deployed before the migration (verification fails first)', r.code !== 0 && !deployed.sync_subscription && /STOP/.test(r.summary), r.out.slice(-600));

    W.db.sql(`update public.subscriptions set stripe_subscription_id = ${PG.lit(sub.id)} where user_id = ${PG.lit(owner.id)};`);
    r = await stage('apply_sql_dry_run');
    chk('a subscription id on two accounts stops the dry run at the preflight', r.code !== 0 && /preflight check\(s\) FAIL/.test(r.summary) && !installed(), r.out.slice(-600));
    W.db.sql(`update public.subscriptions set stripe_subscription_id = null where user_id = ${PG.lit(owner.id)};`);

    r = await stage('apply_sql_dry_run');
    chk('dry run: passes and keeps nothing', r.code === 0 && /DRY RUN/.test(r.out) && !installed(), r.out.slice(-800));

    r = await stage('apply_sql');
    chk('apply_sql: preflight → dry run → commit → verify, all green', r.code === 0 && /COMMITTED/.test(r.out) && installed() && /every check passed/.test(r.summary), r.out.slice(-1200));
    chk('apply_sql: the hand-made comp_trial is byte-for-byte unchanged', billingOf(connor.id) === connorRow);
    const snap = JSON.parse(W.db.sql("select row_to_json(t) from (select label, deployed, summary->>'granting_access' g from billing_ops.snapshots order by id desc limit 1) t;"));
    chk('apply_sql: the snapshot records the deployed function versions (none yet) and the access count', snap.label === 'pre-apply' && Array.isArray(snap.deployed) && snap.g === '3', snap);

    r = await stage('deploy_stripe_webhook');
    chk('the webhook cannot be deployed before sync_subscription', r.code !== 0 && !deployed.stripe_webhook, r.out.slice(-600));

    r = await stage('deploy_sync_subscription');
    chk('deploy_sync_subscription: deployed, serving this build, verify_jwt off, every Phase 6 probe green', r.code === 0 && deployed.sync_subscription &&
      /verify_jwt is off/.test(r.summary) && /── sync: \d+ PASS, \d+ INFO(, 1 SKIP)?$/m.test(r.out) && !/^FAIL/m.test(r.out), r.out.slice(-1500));
    chk('deploy_sync_subscription: the comp_trial is still untouched', billingOf(connor.id) === connorRow);

    r = await stage('deploy_stripe_webhook');
    chk('deploy_stripe_webhook: deployed and verified; no delivery yet is a WARN with the resend instruction', r.code === 0 && deployed.stripe_webhook &&
      /── webhook: 5 PASS/.test(r.out) && /resend a recent event/.test(r.out), r.out.slice(-1500));

    r = await stage('deploy_create_checkout_session', { STRIPE_PRICE_ID_INPUT: 'price_4999' });
    chk('deploy_create_checkout_session: price set, deployed, every Phase 8 probe green', r.code === 0 && deployed.create_checkout_session &&
      /STRIPE_PRICE_ID set/.test(r.summary) && /── checkout: \d+ PASS, \d+ INFO$/m.test(r.out), r.out.slice(-1500));
    r = await stage('deploy_create_checkout_session', { STRIPE_PRICE_ID_INPUT: 'price_x; rm -rf /' });
    chk('a malformed price id input is refused before anything runs with it', r.code !== 0 && /must look like price_/.test(r.summary));

    // a real customer pays through the deployed system (server checkout → Stripe → webhook)
    const buyer = W.user('new.buyer@x.co');
    const co = await W.call('create_checkout_session', 'POST', { kind: 'trial', price_cents: 4999, trial_days: 7 }, buyer.token);
    const done = W.stripe.complete(co.body.session_id, { email: 'new.buyer@x.co', wallet: 'apple_pay' });
    for (const e of done.events) {
      const sig = require('crypto').createHmac('sha256', H.SECRET);
      const raw = JSON.stringify(e); const t = Math.floor(Date.now() / 1000);
      const rr = await deployed.stripe_webhook.handler(new Request('https://db.test/functions/v1/stripe_webhook', { method: 'POST',
        headers: { 'stripe-signature': 't=' + t + ',v1=' + sig.update(t + '.' + raw).digest('hex') }, body: raw }));
      chk('the deployed webhook answers Stripe 200 for ' + e.type, rr.status === 200);
    }
    r = await stage('verify', { SUBJECT_USER_ID: buyer.id, STRIPE_PRICE_ID_INPUT: 'price_4999' });
    chk('verify: postflight, probes, a real delivery traced end to end, and the buyer converged', r.code === 0 &&
      /the delivery traced end to end without an error/.test(r.out) && /── subject: 8 PASS/.test(r.out), r.out.slice(-1500));

    r = await stage('apply_cron');
    chk('apply_cron on a project without pg_cron stops cleanly, after proving a manual sync', r.code !== 0 && /manual reconciliations on record/.test(r.summary) &&
      /the schedule did not apply/.test(r.summary), r.out.slice(-800));

    r = await stage('checkout_kill_switch');
    chk('checkout_kill_switch: STRIPE_PRICE_ID unset, the function answers not_configured (Payment Link fallback)', r.code === 0 && !fnEnv.STRIPE_PRICE_ID &&
      /kill switch/.test(r.out), r.out.slice(-800));
    r = await stage('disable_cron');
    chk('disable_cron is safe on a project without pg_cron', r.code === 0, r.out.slice(-600));
    r = await stage('remove_sync_subscription');
    chk('remove_sync_subscription removes it', r.code === 0 && !deployed.sync_subscription, r.out.slice(-600));
    r = await stage('nonsense');
    chk('an unknown stage is refused', r.code !== 0 && /unknown stage/.test(r.summary));

    const all = fs.readdirSync(TMP).filter((f) => /\.md$/.test(f)).map((f) => fs.readFileSync(path.join(TMP, f), 'utf8')).join('\n');
    const lk = leaks(all + ALLOUT);
    chk('across every stage: no token, secret value, full email or full account id in the logs', lk.length === 0,
      lk.concat((all + ALLOUT).split('\n').filter((l) => W.q('select id::text as id from auth.users').some((u) => l.indexOf(u.id) >= 0)).slice(0, 5)));
  } catch (e) {
    chk('the suite ran to the end', false, String(e.stack || e).slice(0, 1500));
  } finally {
    server.close();
    W.stop();
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'deploy stages — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})();
