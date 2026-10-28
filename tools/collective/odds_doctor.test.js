#!/usr/bin/env node
/* Tests for the Collective odds doctor. Offline: the status route and psql are
   stubbed, so what is under test is what the report may print and that every
   statement it sends is wrapped read-only.

   Run: node tools/collective/odds_doctor.test.js                            */
'use strict';
const D = require('./odds_doctor.js');
let pass = 0, fail = 0; const fails = [];
const chk = (name, ok, detail) => ok ? pass++ : (fail++, fails.push({ name, detail }));

/* ---- redaction ------------------------------------------------------------ */
const SERVICE = 'sb_service_' + 'x'.repeat(40);
const DBURL = 'postgresql://postgres.ref:hunter2-very-secret@aws-0.pooler.supabase.com:6543/postgres';
const secrets = [SERVICE, DBURL, 'hunter2-very-secret'];

const cronCmd = "select net.http_post(url := 'https://ref.supabase.co/functions/v1/collective_odds_ingest/v1/ingest?league=nfl', " +
  "headers := jsonb_build_object('x-odds-cron-token', 'a1b2c3d4e5f6', 'Authorization', 'Bearer " + SERVICE + "'))";
const r1 = D.redact(cronCmd, secrets);
chk('the cron token value is removed, its name is kept', !r1.includes('a1b2c3d4e5f6') && r1.includes('x-odds-cron-token'), r1);
chk('the service key is removed', !r1.includes(SERVICE) && !r1.includes('x'.repeat(32)), r1);
chk('the URL path the job calls survives', r1.includes('/functions/v1/collective_odds_ingest/v1/ingest?league=nfl'), r1);

const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ';
chk('a JWT is removed', !D.redact('Authorization: ' + jwt).includes('eyJ'), D.redact('Authorization: ' + jwt));
chk('a connection string loses its password', !D.redact(DBURL).includes('hunter2'), D.redact(DBURL));
chk('an exact secret from the environment is removed even when short of every pattern',
  !D.redact('pw=hunter2-very-secret!', secrets).includes('hunter2'), D.redact('pw=hunter2-very-secret!', secrets));
chk('a key in a query string is removed', !D.redact('https://odds.oddsblaze.com/?key=abc123&league=nfl').includes('abc123'));
chk('a long opaque token is removed', !D.redact('token ' + 'f'.repeat(64)).includes('f'.repeat(32)));
chk('ordinary text passes untouched', D.redact('too_soon: last nfl poll 3600s ago') === 'too_soon: last nfl poll 3600s ago');
chk('a JSON header map loses its values', !D.redact('{"apikey": "zzz-short", "x-odds-cron-token": "tok"}').match(/zzz-short|"tok"/),
  D.redact('{"apikey": "zzz-short", "x-odds-cron-token": "tok"}'));

chk('ingest.cron_token is a secret key', D.secretKey('ingest.cron_token'));
chk('provider.api_key is a secret key', D.secretKey('provider.api_key'));
chk('nfl.enabled is not', !D.secretKey('nfl.enabled'));
chk('provider.default is not', !D.secretKey('provider.default'));

/* ---- read-only ------------------------------------------------------------ */
const w = D.readOnly('select 1;');
chk('every statement runs inside BEGIN TRANSACTION READ ONLY', /begin transaction read only;/.test(w), w);
chk('…and is rolled back, never committed', /rollback;\s*$/.test(w) && !/commit/i.test(w), w);
chk('…under a statement timeout', /statement_timeout = '20s'/.test(w), w);

/* ---- arguments --------------------------------------------------------------- */
const throws = (f) => { try { f(); return false; } catch (_) { return true; } };
chk('--since must be a date (it is interpolated into SQL)', throws(() => D.parseArgs(['--since', "2026-10-18'; drop table x; --"])));
chk('an unknown league is refused', throws(() => D.parseArgs(['--league', 'nhl'])));
chk('defaults: both leagues', JSON.stringify(D.parseArgs([]).leagues) === '["nfl","ncaaf"]');

/* ---- table discovery reads only named columns -------------------------------- */
const tables = [
  { table_name: 'ingest_runs', columns: ['id', 'league', 'status', 'started_at', 'error_code', 'error_message', 'raw_payload'] },
  { table_name: 'snapshots', columns: ['id', 'event_id', 'observed_at', 'price'] },
  { table_name: 'closing_lines', columns: ['event_id', 'closed_at'] },
  { table_name: 'settings', columns: ['key', 'value'] },
];
const rt = D.pickRunTable(tables);
chk('the run log is the table with status and started_at', rt && rt.table_name === 'ingest_runs');
const runSql = D.sqlRunLog(rt, '2026-10-18');
chk('the run log never selects a column outside the allowlist', !/raw_payload/.test(runSql), runSql);
chk('snapshot and closing tables are found', D.pickSnapshotTables(tables).map((t) => t.table_name).join() === 'snapshots,closing_lines');
chk('an identifier outside [a-z0-9_] is refused', throws(() => D.sqlRunLog({ table_name: 'x"; drop', columns: ['status', 'started_at'] }, '2026-10-18')));

/* ---- the report, end to end on stubs ---------------------------------------- */
(async () => {
  const sent = [];
  const fakePg = {
    json(sql) {
      sent.push(sql);
      if (/from cron\.job j where/.test(sql)) return [{ jobid: 7, jobname: 'collective_odds_nfl', schedule: '27 * * * *', active: true, command: cronCmd }];
      if (/odds_api_paused_jobs/.test(sql)) return [];
      if (/pg_namespace/.test(sql)) return tables;
      if (/from odds\."settings"/.test(sql)) return [{ key: 'ingest.cron_token', value: '"a1b2c3d4e5f6"' }, { key: 'nfl.enabled', value: 'true' }];
      return [];
    },
  };
  const fakeFetch = async (url, init) => ({
    status: 200,
    text: async () => JSON.stringify({ league: /ncaaf/.test(url) ? 'ncaaf' : 'nfl', echoed: init.headers.authorization,
      diagnosis: { state: 'stale', detail: 'Last polled 2026-10-21T21:00:00Z', fix: null } }),
  });
  const env = { EDGD_SB_URL: 'https://ref.supabase.co', EDGD_SB_SERVICE: SERVICE, SB_DB_URL: DBURL };
  const res = await D.main(env, ['--since', '2026-10-18'], { psql: fakePg, fetch: fakeFetch });
  chk('the report reads both halves', res.failed.length === 0, res.failed);
  chk('the report never prints the service key', !res.text.includes(SERVICE), null);
  chk('the report never prints the database password', !res.text.includes('hunter2'), null);
  chk('the report never prints the cron token, from the job or from the settings', !res.text.includes('a1b2c3d4e5f6'), null);
  chk('the report omits the credential setting and keeps the others', !res.text.includes('ingest.cron_token') && res.text.includes('nfl.enabled'));
  chk('the report names the function\'s own diagnosis', res.text.includes('diagnosis **stale**'));
  chk('the report shows the job and its schedule', res.text.includes('collective_odds_nfl') && res.text.includes('27 * * * *'));
  chk('no statement it sent writes anything',
    sent.every((s) => !/\b(insert|update|delete|alter|drop|create|truncate|grant|revoke)\b/i.test(s.replace(/'[^']*'/g, ''))), sent);

  const none = await D.main({}, [], { fetch: fakeFetch });
  chk('with no credential at all it reports both halves unread (a run that saw nothing is not green)',
    none.failed.includes('status') && none.failed.includes('database'), none.failed);

  const bad = await D.main({ EDGD_SB_URL: 'https://ref.supabase.co', EDGD_SB_SERVICE: SERVICE }, ['--league', 'nfl'],
    { fetch: async () => ({ status: 401, text: async () => '{"error":{"code":"invalid_key"}}' }) });
  chk('a refused status call is a failure, not a pass', bad.failed.includes('status nfl'), bad.failed);

  if (fail) { console.error('FAILED ' + pass + ' passed, ' + fail + ' failed'); for (const f of fails) console.error(' - ' + f.name + (f.detail !== undefined ? ' :: ' + JSON.stringify(f.detail).slice(0, 400) : '')); process.exit(1); }
  console.log('ALL GREEN ' + pass + ' passed, 0 failed');
})().catch((e) => { console.error(e); process.exit(1); });
