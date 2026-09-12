#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk — supabase/billing.sql, run against a real PostgreSQL.

   These three tables are the signup path's floor, and none of them was ever
   committed: the landing page told the CUSTOMER to "run subscriptions.sql",
   a file that did not exist. The consent write is load-bearing — confirmArl()
   refuses to send anyone to Stripe if it fails, so a table that will not take
   the write ends the funnel rather than degrading it.

   This applies the SHIPPED file unmodified to a throwaway database, twice,
   then attacks it: filing a consent under somebody else's account, rewriting
   or deleting one after the fact, reading another account's rows, and — the
   one that matters most — a browser trying to grant itself a subscription.

   It also applies the file over a PARTIAL, HAND-MADE table holding rows, which
   is the shape a dashboard-built project is actually in. `create table if not
   exists` no-ops there, so every column is added independently; without that
   the migration would appear to succeed and the insert would go on failing.

   supabase/referral_codes.sql rides along, because it adds columns to the same
   `subscriptions` table and its report is read and BELIEVED. Its own suite asks
   whether a number on that report can be wrong: a subscription dropped off it,
   a sale credited to the wrong code, an invoice counted twice, revenue that
   arrived and is on no line at all.

   Same shape and same skip behaviour as tools/games/sql_security.test.js —
   without PostgreSQL it skips loudly and passes, so a bare Node checkout is
   still green. CI runs it with a database.

   Run: node tools/app/billing_sql.test.js
        EDGD_PG="-h 127.0.0.1 -p 5432 -U postgres" node tools/app/billing_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SCHEMA = path.join(ROOT, 'supabase', 'billing.sql');
/* The webhook's ledger depends on billing.sql (it adds columns to
   subscriptions), so the two are applied and tested together — which is also
   the order an operator must run them in. */
const WEBHOOK = path.join(ROOT, 'supabase', 'stripe_webhook.sql');
/* Runs third, and says so itself: its two guards refuse to install over a
   project that has not had the other two. */
const REFERRAL = path.join(ROOT, 'supabase', 'referral_codes.sql');
const COMMUNITY = path.join(ROOT, 'supabase', 'community_posts.sql');
const SHIM = path.join(ROOT, 'tools', 'games', 'sql', 'supabase_shim.sql');
const SUITE = path.join(__dirname, 'sql', 'billing.test.sql');
const REF_SUITE = path.join(__dirname, 'sql', 'referral_codes.test.sql');
const DB = 'edgedesk_billing_sqltest';

const have = (b) => cp.spawnSync('sh', ['-c', 'command -v ' + b], { encoding: 'utf8' }).status === 0;
const psql = (conn, args, o) => cp.spawnSync('psql', conn.concat(args), Object.assign({ encoding: 'utf8' }, o || {}));

function candidates() {
  const out = [];
  if (process.env.EDGD_PG) out.push(process.env.EDGD_PG.split(' '));
  if (process.env.PGHOST) out.push([]);
  out.push(['-h', '/var/tmp/edgpg/sock', '-p', '5433', '-U', 'postgres']);
  out.push(['-h', '127.0.0.1', '-p', '5432', '-U', 'postgres']);
  out.push([]);
  return out;
}
function skip(why) {
  console.log('SKIP | billing SQL | ' + why);
  console.log('       (this suite needs PostgreSQL; CI runs it in games-sql.yml)');
  process.exit(0);
}
if (!have('psql')) skip('psql is not installed');

let conn = null;
for (const c of candidates()) {
  if (psql(c, ['-d', 'postgres', '-tAc', 'select 1']).status === 0) { conn = c; break; }
}
if (!conn) skip('no reachable PostgreSQL server');

function drop() { psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + DB + ' (force)']); }
drop();
const mk = psql(conn, ['-d', 'postgres', '-q', '-c', 'create database ' + DB]);
if (mk.status !== 0) { console.error(mk.stderr); skip('could not create the test database'); }

let code = 0;
try {
  psql(conn, ['-d', DB, '-q', '-c',
    "create schema if not exists auth; create extension if not exists pgcrypto;"]);
  for (const f of [SHIM, SCHEMA, WEBHOOK, REFERRAL]) {
    const r = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', f]);
    if (r.status !== 0) {
      console.log('FAIL | billing SQL | ' + path.basename(f) + ' did not apply');
      console.error((r.stderr || '').trim().split('\n').slice(0, 12).join('\n'));
      throw new Error('apply');
    }
  }
  /* The shipped file ends in a report of its own. Every row must say ok —
     a migration you cannot verify from its own output is one you have to
     trust, and that is exactly what this repository refuses to do. */
  const rep = psql(conn, ['-d', DB, '-tA', '-F', '|', '-f', SCHEMA]);
  const bad = (rep.stdout || '').split('\n')
    .filter((l) => /^\d+\|/.test(l) && !/\|ok/.test(l));
  if (bad.length) {
    console.log('FAIL | billing SQL | the migration report is not all ok');
    bad.forEach((l) => console.log('     | ' + l));
    throw new Error('report');
  }
  /* Applying it twice must be indistinguishable from applying it once. */
  psql(conn, ['-d', DB, '-tA', '-F', '|', '-f', WEBHOOK]);
  const twice = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', SCHEMA]);
  psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', WEBHOOK]);
  if (twice.status !== 0) {
    console.log('FAIL | billing SQL | the file is not idempotent — a second run failed');
    console.error((twice.stderr || '').trim().split('\n').slice(0, 12).join('\n'));
    throw new Error('idempotent');
  }

  /* The referral file's own report, and its own second run. */
  const refRep = psql(conn, ['-d', DB, '-tA', '-F', '|', '-f', REFERRAL]);
  const refBad = (refRep.stdout || '').split('\n')
    .filter((l) => /^\d+\|/.test(l) && !/\|ok/.test(l));
  if (refRep.status !== 0 || refBad.length) {
    console.log('FAIL | billing SQL | referral_codes.sql did not report all ok');
    refBad.forEach((l) => console.log('     | ' + l));
    console.error((refRep.stderr || '').trim().split('\n').slice(0, 8).join('\n'));
    throw new Error('report');
  }

  /* THE THIRD COPY OF pgEntitled(). The report's `still_active` restates a rule
     that app.html and community_posts.sql already state, and three copies is
     three chances to drift. Rather than writing a FOURTH copy here, the shipped
     definition is lifted out of community_posts.sql and applied on its own —
     if the two ever disagree about who has access, referral_entitlement_agrees()
     says so and this fails. */
  const csrc = fs.readFileSync(COMMUNITY, 'utf8');
  const a = csrc.indexOf('create or replace function public.community_is_entitled');
  const b = csrc.indexOf('$$;', a);
  if (a < 0 || b < 0) {
    console.log('FAIL | billing SQL | could not find community_is_entitled in ' + path.basename(COMMUNITY));
    throw new Error('suite');
  }
  const ent = psql(conn, ['-d', DB, '-q', '-v', 'ON_ERROR_STOP=1', '-c', csrc.slice(a, b + 3)]);
  if (ent.status !== 0) {
    console.log('FAIL | billing SQL | the shipped community_is_entitled would not apply');
    console.error((ent.stderr || '').trim().split('\n').slice(0, 8).join('\n'));
    throw new Error('suite');
  }

  const r = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-f', SUITE]);
  const out = (r.stdout || '') + (r.stderr || '');
  let passed = (out.match(/NOTICE:\s+ok\s/g) || []).length;
  if (r.status !== 0 || /FAIL:/.test(out)) {
    console.log('FAIL | billing SQL | ' + passed + ' passed before the failure');
    console.error(out.split('\n').filter((l) => /FAIL|ERROR/.test(l)).slice(0, 8).join('\n'));
    throw new Error('suite');
  }
  if (passed < 18) {
    console.log('FAIL | billing SQL | only ' + passed + ' assertions ran — the suite exited early');
    throw new Error('short');
  }

  /* The referral report, attacked. Runs on the same database, after the suite
     above, so it sees a realistic table rather than an empty one. */
  const rr = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-f', REF_SUITE]);
  const rout = (rr.stdout || '') + (rr.stderr || '');
  const rpassed = (rout.match(/NOTICE:\s+ok\s/g) || []).length;
  if (rr.status !== 0 || /FAIL:/.test(rout)) {
    console.log('FAIL | billing SQL | referral report | ' + rpassed + ' passed before the failure');
    console.error(rout.split('\n').filter((l) => /FAIL|ERROR/.test(l)).slice(0, 8).join('\n'));
    throw new Error('suite');
  }
  if (rpassed < 28) {
    console.log('FAIL | billing SQL | referral report | only ' + rpassed +
      ' assertions ran — the suite exited early');
    throw new Error('short');
  }
  passed += rpassed;

  /* With rows on the table and the shipped predicate installed, the migration's
     own row 11 is now a real comparison rather than "nothing to compare". */
  const agree = psql(conn, ['-d', DB, '-tA', '-c', 'select public.referral_entitlement_agrees()']);
  if (!/^ok/.test((agree.stdout || '').trim())) {
    console.log('FAIL | billing SQL | the report and the paywall disagree about who has access');
    console.log('     | ' + (agree.stdout || agree.stderr || '').trim());
    throw new Error('suite');
  }
  if (/not installed/.test(agree.stdout || '')) {
    console.log('FAIL | billing SQL | the entitlement cross-check did not actually run');
    throw new Error('suite');
  }
  passed += 1;
  /* THE SHAPE A DASHBOARD-BUILT PROJECT IS ACTUALLY IN. A partial, hand-made
     table holding rows: `create table if not exists` no-ops against it, so
     unless every column is added independently the migration reports success
     and the insert goes on failing — which is the exact production symptom
     this file exists to end. Caught here once already. */
  const LEG = DB + '_legacy';
  psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + LEG + ' (force)']);
  psql(conn, ['-d', 'postgres', '-q', '-c', 'create database ' + LEG]);
  try {
    psql(conn, ['-d', LEG, '-q', '-v', 'ON_ERROR_STOP=1', '-f', SHIM]);
    psql(conn, ['-d', LEG, '-q', '-c',
      "insert into auth.users(id,email) values ('11111111-1111-1111-1111-111111111111','old@x.co');" +
      "create table public.billing_consents (id uuid primary key default gen_random_uuid()," +
      " created_at timestamptz default now()," +
      " user_id uuid not null references auth.users(id) on delete cascade, user_email text);" +
      "insert into public.billing_consents(user_id,user_email)" +
      " values ('11111111-1111-1111-1111-111111111111','old@x.co');" +
      "create table public.subscriptions (user_id uuid primary key references auth.users(id), status text);" +
      /* A stripe_events left over from an earlier attempt at wiring the webhook.
         This is the real shape that broke the first production run: create-table
         no-ops, the index on created_at then dies on a column that was never
         added, and the whole migration rolls back. */
      "create table public.stripe_events (id text primary key, payload jsonb);" +
      "insert into public.stripe_events(id,payload) values ('evt_old','{\"a\":1}');"]);
    const rep = psql(conn, ['-d', LEG, '-tA', '-F', '|', '-f', SCHEMA]);
    psql(conn, ['-d', LEG, '-v', 'ON_ERROR_STOP=1', '-q', '-f', WEBHOOK]);
    const bad = (rep.stdout || '').split('\n').filter((l) => /^\d+\|/.test(l) && !/\|ok/.test(l));
    if (bad.length) {
      console.log('FAIL | billing SQL | applying over a partial hand-made table left it incomplete');
      bad.forEach((l) => console.log('     | ' + l));
      throw new Error('legacy');
    }
    const kept = psql(conn, ['-d', LEG, '-tA', '-c',
      "select (select count(*) from public.billing_consents)::text || ',' ||" +
      " (select count(*) from information_schema.columns where table_name='billing_consents'" +
      "   and column_name='offer_text')::text || ',' ||" +
      " (select count(*) from public.stripe_events)::text || ',' ||" +
      " (select count(*) from information_schema.columns where table_name='stripe_events'" +
      "   and column_name in ('created_at','type','resolved','applied','note'))::text"]);
    const [rows, col, evRows, evCols] = (kept.stdout || '').trim().split(',');
    if (rows !== '1' || col !== '1') {
      console.log('FAIL | billing SQL | legacy rows=' + rows + ' offer_text=' + col + ' (want 1,1)');
      throw new Error('legacy-rows');
    }
    /* The stripe_events half. Its absence is what took the first real run down. */
    if (evRows !== '1' || evCols !== '5') {
      console.log('FAIL | billing SQL | a hand-made stripe_events was not upgraded: rows=' +
        evRows + ' (want 1), columns added=' + evCols + ' (want 5)');
      throw new Error('legacy-rows');
    }
    passed += 4;
  } finally {
    psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + LEG + ' (force)']);
  }

  console.log('PASS | billing SQL | ' + passed + ' assertions against a real PostgreSQL');
} catch (e) {
  /* A harness that swallows its own errors is a harness that reports green for
     the wrong reason. Say what broke. */
  if (!/^(apply|report|idempotent|suite|short|legacy|legacy-rows)$/.test(String(e && e.message)))
    console.error('harness error: ' + (e && e.stack || e));
  code = 1;
} finally {
  drop();
}
process.exit(code);
