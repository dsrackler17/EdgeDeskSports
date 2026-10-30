#!/usr/bin/env node
/* ===========================================================================
   What a production deploy of the Novig layer is checked against, from a
   PUBLIC log (.github/workflows/deploy-novig.yml; docs/novig/README.md §10).
   The repository is public, so its Actions logs are too: nothing printed
   here may be a Novig price (that would be the redistribution the display
   gate exists to prevent), a key, a secret or an account identifier.

     node tools/novig/deploy_check.js check --admin <uuid>  | psql -qAt …
         the layer's facts, none of them a price: the tables, RLS, grants,
         policies, indexes, the switches, the cron jobs and the Vault secret's
         presence, rows by environment, the runs, a halt in force, the
         DraftKings tape's newest capture, and what novig_access() and
         novig_compare() give a signed-in reader who is not an admin and the
         admin. Each row reads `n|item|result`; a result that starts
         CHECK THIS fails the workflow.
     node tools/novig/deploy_check.js view --admin <uuid>   | psql -qAt …
         the admin's view as the card reads it (novig_compare for the next
         eight days, novig_history for the first events, the readiness row),
         as one JSON line. It carries prices: it is only ever piped to `seal`.
     node tools/novig/deploy_check.js seal <public key: base64 SPKI DER, RSA>
         reads that output on stdin; a fresh AES-256-GCM key is wrapped with
         RSA-OAEP-SHA256 for the public key; prints NOVIG-SEALED lines.
     node tools/novig/deploy_check.js open <private key PEM file>
         the reverse, on a machine that holds the private half; reads a log.
   Both SQL scripts run as one transaction that is rolled back: nothing is
   written. No dependency: Node's own crypto and zlib.
   =========================================================================== */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const zlib = require('zlib');

const TABLES = ['novig_config', 'novig_config_log', 'novig_events', 'novig_markets', 'novig_book_snapshots', 'novig_book_depth',
  'novig_market_links', 'novig_unmapped', 'novig_sync_runs', 'novig_alerts'];
const VIEWS = ['novig_readiness', 'novig_meta'];
const READERS = ['novig_compare(text, timestamptz, timestamptz, text)', 'novig_history(text)', 'novig_price_gap_summary(timestamptz, timestamptz)',
  'novig_access()', 'novig_can_read()', 'novig_is_operator()'];
/* every index supabase/novig_market_data.sql declares, read from the file itself */
const INDEXES = [...fs.readFileSync(require('path').join(__dirname, '..', '..', 'supabase', 'novig_market_data.sql'), 'utf8')
  .matchAll(/create (?:unique )?index if not exists (\w+)/g)].map((m) => m[1]);
const JOBS = ['novig_prune', 'novig_sync_discover', 'novig_sync_probe', 'novig_sync_snapshot'];
/* a signed-in reader who is nobody's admin and has no subscription */
const NOBODY = '00000000-0000-4000-8000-00000000c0de';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIX = 'NOVIG-SEALED ';

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const arr = (xs) => 'array[' + xs.map(q).join(', ') + ']';
const ok = (cond, otherwise) => `case when ${cond} then 'ok' else 'CHECK THIS: ' || (${otherwise}) end`;
/** the claims auth.uid() reads, in both of the forms Supabase's auth.uid() accepts */
const as = (n, who, uid) => `select ${n}, ${q('as ' + who)}, case when c.a is not null and c.b is not null then 'signed in' end
  from (select set_config('request.jwt.claim.sub', ${q(uid)}, true) a, set_config('request.jwt.claims', ${q(JSON.stringify({ sub: uid, role: 'authenticated' }))}, true) b) c;`;

function checkSql(admin) {
  if (!UUID.test(admin || '')) throw new Error('--admin must be the admin account\'s uuid');
  const T = arr(TABLES), TV = arr(TABLES.concat(VIEWS)), R = arr(READERS);
  return `begin;
set local statement_timeout = '60s';
select 1, 'tables: the ten novig_* tables exist', ${ok("count(*) filter (where to_regclass('public.' || t) is null) = 0", "'missing: ' || string_agg(t, ', ') filter (where to_regclass('public.' || t) is null)")}
  from unnest(${T}) t;
select 2, 'RLS: enabled on every novig_* table', ${ok('bool_and(c.relrowsecurity)', "string_agg(c.relname, ', ') filter (where not c.relrowsecurity)")}
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = any(${T});
select 3, 'policies: one select policy per table, to authenticated only', ${ok("count(*) = 10 and bool_and(p.cmd = 'SELECT' and p.roles = array['authenticated']::name[])", "count(*) || ' policies: ' || string_agg(p.tablename || '/' || p.cmd || '/' || p.roles::text, ', ')")}
  from pg_policies p where p.schemaname = 'public' and p.tablename = any(${T});
select 4, 'anon: no privilege on any novig_* table or view', ${ok('count(*) = 0', "string_agg(t || ':' || p, ', ')")}
  from unnest(${TV}) t, unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) p
 where to_regclass('public.' || t) is not null and has_table_privilege('anon', 'public.' || t, p);
select 5, 'authenticated: select only (no insert, update, delete or truncate), and RLS decides the rows', ${ok('count(*) = 0', "string_agg(t || ':' || p, ', ')")}
  from unnest(${TV}) t, unnest(array['insert', 'update', 'delete', 'truncate']) p
 where to_regclass('public.' || t) is not null and has_table_privilege('authenticated', 'public.' || t, p);
select 6, 'anon: may execute none of the readers (compare, history, research summary, access)', ${ok('count(*) = 0', "string_agg(f, ', ')")}
  from unnest(${R}) f where to_regprocedure('public.' || f) is not null and has_function_privilege('anon', 'public.' || f, 'execute');
select 7, 'indexes: every one the layer declares exists', ${ok("count(*) filter (where to_regclass('public.' || i) is null) = 0", "'missing: ' || string_agg(i, ', ') filter (where to_regclass('public.' || i) is null)")} || ' (' || count(*) || ')'
  from unnest(${arr(INDEXES)}) i;
select 8, 'public display', ${ok("public.novig_setting('public_display') = 'off'", "coalesce(public.novig_setting('public_display'), 'null') || ' — it must stay off until Novig''s written permission is on record'")} || ' (off)';
select 9, 'the environment served to readers', ${ok("public.novig_setting('expected_environment') = 'production'", "coalesce(public.novig_setting('expected_environment'), 'null')")} || ' (production)';
select 10, 'cron: the four novig jobs are scheduled and active',
  case when to_regclass('cron.job') is null then 'CHECK THIS: pg_cron is not installed'
       else (select ${ok('count(*) = 4', "count(*) || ' of 4: ' || coalesce(string_agg(jobname || ' ' || schedule, ', '), 'none')")} || ' (' || coalesce(string_agg(jobname || ' ' || schedule, ', ' order by jobname), '') || ')'
               from cron.job where jobname = any(${arr(JOBS)}) and active) end;
select 11, 'Vault: novig_cron_secret exists (its value is never read here)',
  case when to_regclass('vault.secrets') is null and to_regclass('vault.decrypted_secrets') is null then 'CHECK THIS: no Vault'
       when exists (select 1 from vault.decrypted_secrets where name = 'novig_cron_secret') then 'ok' else 'CHECK THIS: not set (run with set_cron_secret)' end;
select 12, 'rows by environment (events · markets · active links · snapshots)',
  'production ' || (select count(*) from public.novig_events where environment = 'production') || ' · ' || (select count(*) from public.novig_markets where environment = 'production')
    || ' · ' || (select count(*) from public.novig_market_links where environment = 'production' and invalidated_at is null) || ' · ' || (select count(*) from public.novig_book_snapshots where environment = 'production')
    || ' | paper ' || (select count(*) from public.novig_events where environment = 'paper') || ' · ' || (select count(*) from public.novig_markets where environment = 'paper')
    || ' · ' || (select count(*) from public.novig_market_links where environment = 'paper' and invalidated_at is null) || ' · ' || (select count(*) from public.novig_book_snapshots where environment = 'paper');
select 13, 'active links by league, market and confidence', coalesce(string_agg(x, ', '), 'none')
  from (select league || ' ' || book_market || ' ' || match_confidence || ' ' || count(*) x from public.novig_market_links
         where invalidated_at is null and environment = 'production' group by league, book_market, match_confidence order by league, book_market, match_confidence) s;
select 14, 'open unmapped markets by reason', coalesce(string_agg(x, ', '), 'none')
  from (select reason || ' ' || count(*) x from public.novig_unmapped where resolved_at is null group by reason order by count(*) desc) s;
select 15, 'snapshots: the newest production book and its age', coalesce(max(captured_at)::text || ' (' || round(extract(epoch from now() - max(captured_at)) / 60) || ' min)', 'none')
  from public.novig_book_snapshots where environment = 'production';
select 16, 'runs: the newest per mode', coalesce(string_agg(x, ', '), 'none')
  from (select distinct on (mode) mode || ' ' || status || coalesce(' (' || skipped_reason || ')', '') || ' at ' || finished_at::text x
          from public.novig_sync_runs order by mode, finished_at desc) s;
select 17, 'no halt in force', coalesce((select 'CHECK THIS: halted until ' || halt_until::text || ' — ' || coalesce(halt_reason, '') from public.novig_sync_runs where halt_until > now() order by finished_at desc limit 1), 'ok');
select 18, 'the DraftKings tape (read, never written): its newest DraftKings capture',
  coalesce((select max(captured_at)::text || ' (' || round(extract(epoch from now() - max(captured_at)) / 3600, 1) || ' h ago)' from public.sharp_price_snapshots where book = 'draftkings'), 'none');
set local role authenticated;
${as(19, 'a signed-in reader who is not an admin', NOBODY)}
select 20, 'that reader: novig_access() says none, and novig_compare(), the snapshots and the runs give no row',
  ${ok("(public.novig_access() ->> 'access') = 'none' and (select count(*) from public.novig_compare()) = 0 and (select count(*) from public.novig_book_snapshots) = 0 and (select count(*) from public.novig_sync_runs) = 0", "public.novig_access()::text")};
${as(21, 'the admin', admin)}
select 22, 'the admin: novig_access() says operator', ${ok("(public.novig_access() ->> 'access') = 'operator'", 'public.novig_access()::text')};
select 23, 'the admin: novig_compare() rows for the next eight days, and none outside production',
  ${ok("count(*) filter (where c -> 'novig' ->> 'environment' is distinct from 'production') = 0", "count(*) filter (where c -> 'novig' ->> 'environment' is distinct from 'production') || ' rows not from production'")} || ' (' || count(*) || ' rows, '
  || count(distinct c ->> 'odds_event_id') || ' events)'
  from public.novig_compare(null, now() - interval '3 hours', now() + interval '8 days', null) c;
select 24, 'the admin: the rows by state (Novig · DraftKings)', coalesce(string_agg(x, ', '), 'none')
  from (select st || ' ' || count(*) x
          from (select coalesce(c -> 'novig' ->> 'state', '?') || ' · ' || coalesce(c -> 'draftkings' ->> 'state', '?') st
                  from public.novig_compare(null, now() - interval '3 hours', now() + interval '8 days', null) c) t group by st order by st) s;
rollback;
`;
}

function viewSql(admin) {
  if (!UUID.test(admin || '')) throw new Error('--admin must be the admin account\'s uuid');
  return `begin;
set local statement_timeout = '60s';
set local role authenticated;
${as(0, 'the admin', admin)}
with c as (select c from public.novig_compare(null, now() - interval '3 hours', now() + interval '8 days', null) c),
     ev as (select distinct c ->> 'odds_event_id' e, (c ->> 'kickoff_at') k from c order by 2, 1 limit 8)
select jsonb_build_object('generated_at', now(), 'access', public.novig_access(),
  'rows', coalesce((select jsonb_agg(c) from c), '[]'::jsonb),
  'history', coalesce((select jsonb_object_agg(e, (select coalesce(jsonb_agg(h), '[]'::jsonb) from public.novig_history(e) h)) from ev), '{}'::jsonb),
  'readiness', (select to_jsonb(r) from public.novig_readiness r limit 1))::text;
rollback;
`;
}

/** seal: the last JSON line of `text`, gzipped, AES-256-GCM, its key wrapped with RSA-OAEP-SHA256 */
function seal(text, publicKeyB64) {
  const line = String(text).split('\n').map((l) => l.trim()).filter((l) => /^\{/.test(l)).pop();
  if (!line) throw new Error('no JSON line to seal');
  JSON.parse(line);
  const pub = crypto.createPublicKey({ key: Buffer.from(String(publicKeyB64).trim(), 'base64'), format: 'der', type: 'spki' });
  if (pub.asymmetricKeyType !== 'rsa' || pub.asymmetricKeyDetails.modulusLength < 3072) throw new Error('the report key must be an RSA public key of at least 3072 bits');
  const key = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(zlib.gzipSync(Buffer.from(line))), c.final()]);
  const wrapped = crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
  const blob = Buffer.from(JSON.stringify({ v: 1, k: wrapped.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') })).toString('base64');
  const out = [];
  for (let i = 0; i < blob.length; i += 3000) out.push(PREFIX + blob.slice(i, i + 3000));
  return out;
}

/** open: the NOVIG-SEALED lines anywhere in `log` (a GitHub log prefixes each with a timestamp) */
function open(log, privateKeyPem) {
  const blob = String(log).split('\n').map((l) => { const i = l.indexOf(PREFIX); return i < 0 ? '' : l.slice(i + PREFIX.length).trim(); }).join('');
  if (!blob) throw new Error('no ' + PREFIX.trim() + ' line');
  const s = JSON.parse(Buffer.from(blob, 'base64').toString());
  const key = crypto.privateDecrypt({ key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(s.k, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(s.iv, 'base64'));
  d.setAuthTag(Buffer.from(s.tag, 'base64'));
  return JSON.parse(zlib.gunzipSync(Buffer.concat([d.update(Buffer.from(s.ct, 'base64')), d.final()])).toString());
}

if (require.main === module) {
  const cmd = process.argv[2], arg = (n) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : undefined; };
  const stdin = () => fs.readFileSync(0, 'utf8');
  try {
    if (cmd === 'check') process.stdout.write(checkSql(arg('admin')));
    else if (cmd === 'view') process.stdout.write(viewSql(arg('admin')));
    else if (cmd === 'seal') console.log(seal(stdin(), process.argv[3]).join('\n'));
    else if (cmd === 'open') console.log(JSON.stringify(open(stdin(), fs.readFileSync(process.argv[3], 'utf8'))));
    else { console.log('usage: deploy_check.js check|view --admin <uuid> | seal <base64 SPKI> | open <private key PEM file>'); process.exit(2); }
  } catch (e) { console.log('FAILED: ' + e.message); process.exit(1); }
}

module.exports = { checkSql, viewSql, seal, open, TABLES, INDEXES, NOBODY };
