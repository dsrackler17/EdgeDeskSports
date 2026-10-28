#!/usr/bin/env node
/* ===========================================================================
   Why did the Collective stop capturing closing lines?

   WHY THIS EXISTS. Every game of NFL week 7, 2026 settled with a final score
   and no captured close, so none of them has an against-the-spread result.
   The last close on file is WAS @ SF (kickoff 2026-10-20 00:15Z). The
   settlement refresh classes all fourteen week-7 games L: the odds feed holds
   snapshots for them, but none inside the final 360 minutes before kickoff.
   So the Collective's own ingest stopped writing prices somewhere between
   2026-10-20 and 2026-10-22. The one production change in that window is the
   Deploy odds gateway run of 2026-10-21 21:51Z, which replaced the dashboard
   copy of collective_odds_ingest with this repository's reconstruction of it
   for the first time. What the ingest has done since is visible only in
   production, so this asks production.

   READ-ONLY. Two halves, either of which runs without the other:
     1. collective_odds_ingest GET /v1/status?league=<l>, with the service
        role. That route reads the feed status, the throttle and the settings
        and returns the function's own diagnosis. It calls no provider and
        spends no credit.
     2. Over psql, inside BEGIN TRANSACTION READ ONLY: the pg_cron jobs that
        poll the ingest, whether the 2026-10-10 emergency stop paused them,
        their recent runs, pg_net's recent answers from the function, the
        ingest's own run log, its snapshot counts by day, and its settings.
   Nothing is written anywhere. Commands, messages and settings pass through
   redact() before they are printed, and a setting whose key names a token,
   secret or key is left out entirely.

   Usage:
     node tools/collective/odds_doctor.js [--since 2026-10-18] [--league nfl,ncaaf]

   Env: EDGD_SB_URL and EDGD_SB_SERVICE (the status route; the same names the
   settle job uses), SB_DB_URL (psql). It exits 1 when either half could not
   be read, so a run that saw nothing is never green.
   =========================================================================== */
'use strict';
const cp = require('child_process');
const fs = require('fs');

const DEFAULT_SINCE = '2026-10-18';
const LEAGUES = new Set(['nfl', 'ncaaf']);

/* ---- never print a credential ------------------------------------------- */
/* Values are removed, names are kept: "the job sends x-odds-cron-token" is
   the diagnosis, the token is not. Exact secrets from the environment are
   removed first, then anything shaped like one. */
function redact(s, secrets) {
  let out = String(s == null ? '' : s);
  for (const v of secrets || []) {
    if (typeof v === 'string' && v.length >= 8) out = out.split(v).join('<secret>');
  }
  return out
    .replace(/(postgres(?:ql)?:\/\/[^:/\s@]+:)[^@\s]+@/gi, '$1<redacted>@')
    .replace(/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, '<jwt>')
    .replace(/(bearer\s+)[^\s'"]+/gi, '$1<redacted>')
    .replace(/([?&](?:key|apikey|api_key|token|secret)=)[^&\s'"]+/gi, '$1<redacted>')
    .replace(/(["']?(?:authorization|apikey|x-[\w-]*(?:token|secret|key))["']?\s*(?::|,|=>)\s*["'])[^"']*/gi, '$1<redacted>')
    .replace(/[A-Za-z0-9_+-]{32,}={0,2}/g, (m) => '<redacted:' + m.length + '>');
}

/* A setting whose name says it is a credential is never read out. Any "key"
   counts: ingest.anon_key is public, but the rule is about names, not about
   which credentials happen to be harmless. */
function secretKey(k) {
  return /token|secret|password|passwd|key|credential|private/i.test(String(k));
}

/* ---- psql, read-only ------------------------------------------------------ */
function readOnly(sql) {
  return "set client_min_messages = warning;\nbegin transaction read only;\n" +
    "set local statement_timeout = '20s';\n" + String(sql).trim().replace(/;\s*$/, '') + ";\nrollback;\n";
}

function psqlRunner(url, exec) {
  url = String(url || '').trim();
  if (!url) return null;
  const run = exec || ((input) => cp.execFileSync('psql', [url, '-X', '-v', 'ON_ERROR_STOP=1', '-qAt', '-f', '-'],
    { encoding: 'utf8', input, maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }));
  return {
    json(sql) {
      let out;
      try {
        out = run(readOnly(sql));
      } catch (e) {
        // psql's own words only: the command line carries the connection string
        throw new Error(String((e && e.stderr) || (e && e.message) || 'psql failed').trim().slice(0, 600));
      }
      const line = String(out || '').split('\n').map((l) => l.trim()).filter(Boolean).pop();
      return line ? JSON.parse(line) : null;
    },
  };
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
const q = (id) => {
  if (!IDENT.test(String(id))) throw new Error('refusing identifier ' + JSON.stringify(id));
  return '"' + id + '"';
};
/* jsonb, not json: json_agg puts a newline between rows, and the result is
   read back as one line of psql's unaligned output. */
const agg = (inner, order) => `select coalesce(jsonb_agg(to_jsonb(t)${order ? ' order by ' + order : ''}), '[]'::jsonb) from (${inner}) t`;

/* The jobs that can reach the ingest, whatever their command calls it. */
const JOB_FILTER = "(j.command ilike '%collective_odds%' or j.command ilike '%odds_ingest%' " +
  "or j.jobname ilike '%collective%' or j.jobname ilike '%odds%')";

function sqlCronJobs() {
  return agg(`select j.jobid, j.jobname, j.schedule, j.active, j.command from cron.job j where ${JOB_FILTER}`, 't.jobid');
}
function sqlPaused() {
  return agg('select id, jobid, jobname, schedule, paused_at, paused_reason, resumed_at, resumed_by from public.odds_api_paused_jobs', 't.id');
}
function sqlRunsByDay(since) {
  return agg(`select d.jobid, j.jobname, d.start_time::date as day, d.status, count(*)::int as runs, max(d.start_time) as last
    from cron.job_run_details d join cron.job j on j.jobid = d.jobid
    where d.start_time >= '${since}'::date and ${JOB_FILTER}
    group by 1, 2, 3, 4`, 't.jobid, t.day, t.status');
}
function sqlRunsLatest(since) {
  return agg(`select * from (select d.jobid, j.jobname, d.start_time, d.end_time, d.status, d.return_message,
      row_number() over (partition by d.jobid order by d.start_time desc) as n
    from cron.job_run_details d join cron.job j on j.jobid = d.jobid
    where d.start_time >= '${since}'::date and ${JOB_FILTER}) x where n <= 5`, 't.jobid, t.start_time desc');
}
/* pg_net keeps its answers for hours, not days; whatever is still there is
   the function speaking for itself. Only answers shaped like the ingest's. */
const NET_FILTER = "(r.content ilike '%\"league\"%' and (r.content ilike '%cadence%' or r.content ilike '%run_id%' " +
  "or r.content ilike '%skipped%' or r.content ilike '%\"error\"%'))";
function sqlNetCodes() {
  return agg(`select r.status_code, count(*)::int as n, min(r.created) as first, max(r.created) as last
    from net._http_response r where ${NET_FILTER} group by 1`, 't.status_code');
}
function sqlNetLatest() {
  return agg(`select r.id, r.status_code, r.created, r.timed_out, r.error_msg, left(r.content, 500) as content
    from net._http_response r where ${NET_FILTER} order by r.created desc limit 12`, 't.created desc');
}
function sqlOddsTables() {
  return agg(`select c.relname as table_name, c.reltuples::bigint as est_rows,
      (select jsonb_agg(a.attname order by a.attnum) from pg_attribute a
        where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) as columns
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'odds' and c.relkind in ('r', 'p', 'v', 'm')`, 't.table_name');
}

/* The run log: whichever odds table carries a status and a start time. Only
   the columns named here are read, so an unexpected column is never printed. */
const RUN_COLS = ['id', 'run_id', 'league', 'provider', 'trigger', 'status', 'started_at', 'finished_at',
  'error_code', 'error_message', 'events_seen', 'events_created', 'events_matched', 'snapshots_written',
  'snapshots_unchanged', 'rows_rejected', 'books_requested', 'books_ok', 'books_failed', 'credits_spent',
  'closing_rows', 'games_linked'];
const TIME_COLS = ['observed_at', 'captured_at', 'fetched_at', 'created_at', 'inserted_at', 'polled_at', 'closed_at', 'recorded_at'];

function pickRunTable(tables) {
  return (tables || []).find((t) => /run/i.test(t.table_name) && (t.columns || []).includes('status') &&
    (t.columns || []).includes('started_at')) || null;
}
function pickSnapshotTables(tables) {
  return (tables || []).filter((t) => /snapshot|clos/i.test(t.table_name) &&
    (t.columns || []).some((c) => TIME_COLS.includes(c)));
}
function sqlRunLog(table, since) {
  const cols = RUN_COLS.filter((c) => (table.columns || []).includes(c));
  return agg(`select ${cols.map(q).join(', ')} from odds.${q(table.table_name)}
    where ${q('started_at')} >= '${since}'::date order by ${q('started_at')} desc limit 40`, 't.started_at desc');
}
function sqlRunSummary(table, since) {
  const has = (c) => (table.columns || []).includes(c);
  const lg = has('league') ? q('league') : "'?'";
  const reason = has('error_code') ? q('error_code') : 'null';
  return agg(`select ${q('started_at')}::date as day, ${lg} as league, ${q('status')} as status, ${reason} as error_code,
      count(*)::int as runs, max(${q('started_at')}) as last
    from odds.${q(table.table_name)} where ${q('started_at')} >= '${since}'::date group by 1, 2, 3, 4`,
  't.day, t.league, t.status');
}
function sqlSnapshotsByDay(table, since) {
  const ts = TIME_COLS.find((c) => (table.columns || []).includes(c));
  const lg = (table.columns || []).includes('league') ? q('league') : "'?'";
  return agg(`select ${q(ts)}::date as day, ${lg} as league, count(*)::int as rows, max(${q(ts)}) as last
    from odds.${q(table.table_name)} where ${q(ts)} >= '${since}'::date group by 1, 2`, 't.day, t.league');
}
function sqlSettings(table) {
  const cols = table.columns || [];
  if (!cols.includes('key') || !cols.includes('value')) return null;
  return agg(`select ${q('key')} as key, ${q('value')}::text as value from odds.${q(table.table_name)}`, 't.key');
}

/* THE GATEWAY. Since 2026-10-21 the ingest's The Odds API provider buys only
   through odds_gateway (category `collective`), so its refusals are the
   gateway's. odds_api_budget_state() is a stable read; the config and the
   category are read whole and printed through an allowlist. */
const GATEWAY_COLS = ['odds_api_enabled', 'breaker_reason', 'breaker_changed_at', 'breaker_changed_by', 'monthly_budget',
  'daily_target', 'monthly_reserve', 'plan_monthly_credits', 'provider_requests_used', 'provider_requests_remaining',
  'provider_observed_at', 'provider_observed_source', 'provider_cooldown_until', 'cooldown_reason', 'free_endpoints_enabled'];
const BUDGET_KEYS = ['cycle_start', 'next_reset', 'quota_confirmed', 'provider_used', 'provider_remaining',
  'provider_remaining_effective', 'provider_observed_at', 'monthly_budget', 'spent_cycle', 'spent_today',
  'daily_allowance', 'threshold'];
const CATEGORY_COLS = ['category', 'enabled', 'priority', 'endpoint', 'daily_cap_credits'];
function sqlGatewayConfig() {
  return 'select coalesce((select to_jsonb(c) from public.odds_api_config c where id = 1), \'{}\'::jsonb)';
}
function sqlBudgetState() {
  return 'select public.odds_api_budget_state()';
}
function sqlCategories() {
  return agg("select to_jsonb(c) as row from public.odds_api_categories c where c.category in ('collective', 'featured', 'close')");
}
function sqlGatewayDecisions(since) {
  return agg(`select r.usage_day as day, r.category, r.caller, r.decision, count(*)::int as n,
      coalesce(sum(r.actual_credits), 0)::int as credits, max(r.created_at) as last
    from public.odds_api_requests r where r.created_at >= '${since}'::date
      and (r.category = 'collective' or r.caller ilike '%collective%')
    group by 1, 2, 3, 4`, 't.day, t.category, t.decision');
}
const pick = (obj, keys) => keys.filter((k) => obj && k in obj).map((k) => ({ field: k, value: obj[k] }));

/* ---- the function's own status ------------------------------------------- */
async function fetchStatus(base, key, league, fetchImpl) {
  const url = `${String(base).replace(/\/$/, '')}/functions/v1/collective_odds_ingest/v1/status?league=${encodeURIComponent(league)}`;
  const res = await (fetchImpl || fetch)(url, { headers: { authorization: `Bearer ${key}`, apikey: key } });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (_) { body = { raw: text.slice(0, 800) }; }
  return { http: res.status, body };
}

/* ---- the report ------------------------------------------------------------ */
function table(rows, cols, secrets) {
  if (!rows || rows.length === 0) return '_none_\n';
  const cell = (v) => redact(v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : v), secrets)
    .replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 300);
  return '| ' + cols.join(' | ') + ' |\n|' + cols.map(() => '---').join('|') + '|\n' +
    rows.map((r) => '| ' + cols.map((c) => cell(r[c])).join(' | ') + ' |').join('\n') + '\n';
}

function parseArgs(argv) {
  const a = { since: DEFAULT_SINCE, leagues: ['nfl', 'ncaaf'] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--since') a.since = String(argv[++i] || '');
    else if (argv[i] === '--league') a.leagues = String(argv[++i] || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    else throw new Error('unknown argument ' + argv[i]);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.since)) throw new Error('--since must be YYYY-MM-DD, got ' + JSON.stringify(a.since));
  for (const l of a.leagues) if (!LEAGUES.has(l)) throw new Error('unknown league ' + JSON.stringify(l));
  return a;
}

async function main(env, argv, deps) {
  deps = deps || {};
  const args = parseArgs(argv);
  const secrets = [env.EDGD_SB_SERVICE, env.SB_DB_URL, (String(env.SB_DB_URL || '').match(/:\/\/[^:/]+:([^@]+)@/) || [])[1]];
  const out = [];
  const failed = [];
  const say = (s) => out.push(s);
  const section = (title, fn) => {
    say('\n### ' + title + '\n');
    try { fn(); } catch (e) { failed.push(title); say('**could not read:** ' + redact(e && e.message, secrets) + '\n'); }
  };

  say('## Collective odds doctor (read-only)\n');
  say(`Since ${args.since}. Nothing here writes, and no provider is called.\n`);

  /* 1. the function. A convenience view of the tables the database half reads
     directly, so a refusal here is reported and is a failure only when the
     database half is unread too. The function compares the bearer with its
     own SUPABASE_SERVICE_ROLE_KEY; a GitHub secret in the newer sb_secret_
     format, which PostgREST accepts, is refused here with 401. */
  const statusUnread = [];
  const base = String(env.EDGD_SB_URL || '').trim();
  const key = String(env.EDGD_SB_SERVICE || '').trim();
  if (!base || !key) {
    statusUnread.push('status');
    say('\n### collective_odds_ingest /v1/status\n\n**not read:** EDGD_SB_URL / EDGD_SB_SERVICE are empty.\n');
  } else {
    for (const league of args.leagues) {
      say(`\n### collective_odds_ingest /v1/status?league=${league}\n`);
      try {
        const st = await fetchStatus(base, key, league, deps.fetch);
        if (st.http !== 200) statusUnread.push('status ' + league);
        const b = st.body || {};
        say(`HTTP ${st.http}` + (b.diagnosis ? ` · diagnosis **${redact(b.diagnosis.state, secrets)}**: ${redact(b.diagnosis.detail, secrets)}` +
          (b.diagnosis.fix ? ` Fix: ${redact(b.diagnosis.fix, secrets)}` : '') : '') + '\n');
        say('```json\n' + redact(JSON.stringify(b, null, 2), secrets).slice(0, 6000) + '\n```\n');
      } catch (e) {
        statusUnread.push('status ' + league);
        say('**could not read:** ' + redact(e && e.message, secrets) + '\n');
      }
    }
  }

  /* 2. the database */
  const pg = deps.psql || psqlRunner(env.SB_DB_URL);
  if (!pg) {
    failed.push('database');
    say('\n### database\n\n**not read:** SB_DB_URL is empty.\n');
  } else {
    let jobs = [];
    section('pg_cron jobs that can reach the ingest', () => {
      jobs = pg.json(sqlCronJobs()) || [];
      say(table(jobs.map((j) => ({ ...j, command: redact(j.command, secrets).slice(0, 400) })),
        ['jobid', 'jobname', 'schedule', 'active', 'command'], secrets));
    });
    section('Jobs the odds emergency stop paused', () => {
      say(table(pg.json(sqlPaused()), ['jobid', 'jobname', 'schedule', 'paused_at', 'paused_reason', 'resumed_at', 'resumed_by'], secrets));
    });
    section('Their runs by day (cron.job_run_details)', () => {
      say(table(pg.json(sqlRunsByDay(args.since)), ['jobid', 'jobname', 'day', 'status', 'runs', 'last'], secrets));
    });
    section('Their latest runs', () => {
      say(table(pg.json(sqlRunsLatest(args.since)), ['jobid', 'jobname', 'start_time', 'status', 'return_message'], secrets));
    });
    section("The function's recent answers to pg_net (status codes)", () => {
      say(table(pg.json(sqlNetCodes()), ['status_code', 'n', 'first', 'last'], secrets));
    });
    section("The function's recent answers to pg_net (latest)", () => {
      say(table(pg.json(sqlNetLatest()), ['created', 'status_code', 'timed_out', 'error_msg', 'content'], secrets));
    });
    let tables = [];
    section('odds schema', () => {
      tables = pg.json(sqlOddsTables()) || [];
      say(table(tables.map((t) => ({ table_name: t.table_name, est_rows: t.est_rows })), ['table_name', 'est_rows'], secrets));
    });
    const runs = pickRunTable(tables);
    if (runs) {
      section(`Ingest runs by day (odds.${runs.table_name})`, () => {
        say(table(pg.json(sqlRunSummary(runs, args.since)), ['day', 'league', 'status', 'error_code', 'runs', 'last'], secrets));
      });
      section(`Latest ingest runs (odds.${runs.table_name})`, () => {
        const rows = pg.json(sqlRunLog(runs, args.since)) || [];
        say(table(rows, RUN_COLS.filter((c) => (runs.columns || []).includes(c)), secrets));
      });
    } else if (tables.length) {
      say('\n_No odds table with status and started_at columns: no run log to read._\n');
    }
    for (const t of pickSnapshotTables(tables)) {
      section(`Rows by day (odds.${t.table_name})`, () => {
        say(table(pg.json(sqlSnapshotsByDay(t, args.since)), ['day', 'league', 'rows', 'last'], secrets));
      });
    }
    const st = tables.find((t) => t.table_name === 'settings');
    if (st && sqlSettings(st)) {
      section('odds.settings (credentials omitted)', () => {
        const rows = (pg.json(sqlSettings(st)) || []).filter((r) => !secretKey(r.key))
          .map((r) => ({ key: r.key, value: redact(r.value, secrets).slice(0, 200) }));
        say(table(rows, ['key', 'value'], secrets));
      });
    }
    section('odds_gateway: the switch and the provider quota (public.odds_api_config)', () => {
      say(table(pick(pg.json(sqlGatewayConfig()), GATEWAY_COLS), ['field', 'value'], secrets));
    });
    section('odds_gateway: this cycle (odds_api_budget_state())', () => {
      say(table(pick(pg.json(sqlBudgetState()), BUDGET_KEYS), ['field', 'value'], secrets));
    });
    section('odds_gateway: categories', () => {
      const rows = (pg.json(sqlCategories()) || []).map((r) => r.row || {});
      say(table(rows, CATEGORY_COLS.filter((c) => rows.some((r) => c in r)), secrets));
    });
    section("odds_gateway: the Collective's requests and their decisions", () => {
      say(table(pg.json(sqlGatewayDecisions(args.since)), ['day', 'category', 'caller', 'decision', 'n', 'credits', 'last'], secrets));
    });
  }

  // The status route only restates the tables above, so its refusal fails
  // the run only when there is no database reading to stand in for it.
  if (statusUnread.length && (!pg || failed.length)) failed.unshift(...statusUnread);
  else if (statusUnread.length) say('\n_Status route not read (' + statusUnread.join(', ') + '); the database reading above covers it._\n');
  if (failed.length) say('\n**Not read:** ' + failed.join(', ') + '\n');
  return { text: out.join('\n'), failed };
}

module.exports = { redact, secretKey, readOnly, psqlRunner, parseArgs, pickRunTable, pickSnapshotTables,
  sqlCronJobs, sqlRunsByDay, sqlRunsLatest, sqlRunLog, sqlRunSummary, sqlSnapshotsByDay, sqlSettings,
  sqlGatewayConfig, sqlBudgetState, sqlCategories, sqlGatewayDecisions, fetchStatus, main };

if (require.main === module) {
  main(process.env, process.argv.slice(2)).then(({ text, failed }) => {
    process.stdout.write(text + '\n');
    if (process.env.GITHUB_STEP_SUMMARY) {
      try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n'); } catch (_) {}
    }
    process.exit(failed.length ? 1 : 0);
  }).catch((e) => {
    console.error(redact(e && e.message, [process.env.EDGD_SB_SERVICE, process.env.SB_DB_URL]));
    process.exit(1);
  });
}
