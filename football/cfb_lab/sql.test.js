#!/usr/bin/env node
/* ===========================================================================
   THE CFB MODEL LAB CONTRACT (supabase/cfb_lab.sql), AGAINST A REAL POSTGRESQL.

   The lab's record is only worth something if nothing in it can be edited after
   the game, so append-only, no look-ahead, one checkpoint per slot and one
   champion live in triggers and constraints, and are proved here by a server
   refusing the operation. The market rules of METRICS.md §4 are proved by
   reproducing every case of fixtures/market_rules.json — the same file the
   JavaScript copy is held to — exactly.

   The live layer starts a throwaway cluster, applies the Supabase shim
   (anon / authenticated / service_role), applies the contract twice with psql
   and once the way the SQL editor sends it (one string, one round trip), and
   attacks it. supabase/cfb_lab_cron.sql is applied to a server without pg_cron
   (it must report that it skipped, not fail) and to one with a stub pg_cron and
   pg_net (it must schedule the hourly poke, remove an old lines job, and
   dispatch the right request).

   Run: node football/cfb_lab/sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'cfb_lab.sql'), 'utf8');
const CRON = fs.readFileSync(path.join(ROOT, 'supabase', 'cfb_lab_cron.sql'), 'utf8');
const SHIM = fs.readFileSync(path.join(ROOT, 'tools', 'games', 'sql', 'supabase_shim.sql'), 'utf8');
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'market_rules.json'), 'utf8'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function done(note) {
  /* In CI a skipped LIVE layer is a failure: a green check must mean Postgres
     actually ran the functions (.github/workflows/cfb-lab-tests.yml sets it). */
  if (note && /^SKIP/.test(note) && process.env.CFB_LAB_SQL_REQUIRED === '1') { fail++; failures.push({ name: 'Postgres is required here (CFB_LAB_SQL_REQUIRED=1) but ' + note }); }
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
  if (note) console.log(note);
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

/* SCHEMA.md rule 4, restated in node only to cross-check the ids Postgres writes. */
const render = (x) => (x === null || x === undefined ? '' : String(x));
const h = (...parts) => crypto.createHash('sha256').update(parts.map(render).join('|'), 'utf8').digest('hex').slice(0, 24);
const iso = (t) => (t === null || t === undefined ? null : new Date(t).toISOString());
/* quote_id: a sixth part only for provider-declared rows (SCHEMA.md §2) */
const quoteId = (q, key) => 'cfbq_' + h(q.source, q.book, key, q.market_type, iso(q.observed_at),
  ...(q.is_provider_open ? ['provider_open'] : q.is_provider_close ? ['provider_close'] : []));

const TABLES = ['cfb_lab_predictions', 'cfb_lab_market_quotes', 'cfb_lab_market_lines', 'cfb_lab_event_map',
  'cfb_lab_results', 'cfb_lab_evaluations', 'cfb_lab_miss_reviews', 'cfb_lab_model_roles', 'cfb_lab_experiments',
  'cfb_lab_audit_log', 'cfb_lab_partitions', 'cfb_lab_research_queue', 'cfb_lab_reports'];

/* ═══ STATIC ═══════════════════════════════════════════════════════════ */
for (const [name, text] of [['cfb_lab.sql', SQL], ['cfb_lab_cron.sql', CRON]]) {
  const meta = text.split('\n').filter((l) => l.trimStart().startsWith('\\'));
  chk(name + ' has no psql meta-command (the SQL editor cannot run one)', meta.length === 0, meta.slice(0, 3));
  chk(name + ' ends in a report select', /\n(select|with)[\s\S]*;\s*$/i.test(text) && /CHECK THIS/.test(text));
  chk(name + ' drops nothing but triggers, policies and its own jobs',
    !/\bdrop\s+(table|view|schema|function|index|column)\b/i.test(text) && !/\btruncate\b\s+(table\s+)?public\./i.test(text));
}
chk('every table is created idempotently', TABLES.every((t) => new RegExp('create table if not exists public\\.' + t + ' \\(').test(SQL)));
chk('every table is in the append-only / RLS loop', TABLES.every((t) => SQL.includes("'" + t + "'")));
chk('BEFORE UPDATE, DELETE and TRUNCATE triggers are all created',
  /before update on public\.%I for each row/.test(SQL) && /before delete on public\.%I for each row/.test(SQL) && /before truncate on public\.%I for each statement/.test(SQL));
chk('triggers are dropped-if-exists before they are created', /drop trigger if exists %I on public\.%I/.test(SQL));
chk('functions and views are create-or-replace', !/create function/i.test(SQL.replace(/create or replace function/gi, '')) && !/create view/i.test(SQL.replace(/create or replace view/gi, '')));
chk('PostgREST is told to reload', /notify\s+pgrst\s*,\s*'reload schema'/i.test(SQL));
chk('the writer functions are security definer with a pinned search_path',
  ['cfb_lab_ingest_quotes', 'cfb_lab_derive_lines', 'cfb_lab_set_role'].every((f) =>
    new RegExp('function public\\.' + f + '\\([^)]*\\)[\\s\\S]{0,160}security definer\\s+set search_path = pg_catalog, pg_temp').test(SQL)));
chk('the public views run as their owner', /alter view public\.%I set \(security_invoker = false\)/.test(SQL));
chk('the cron file pokes cfb-lab.yml on main with mode, from the editorial token',
  /actions\/workflows\/cfb-lab\.yml\/dispatches/.test(CRON) && /'ref', 'main'/.test(CRON) && /'mode', p_mode/.test(CRON)
  && /edgedesk_gh_token/.test(CRON) && /edgedesk\.gh_token/.test(CRON) && /dsrackler17\/EdgeDeskSports/.test(CRON));
chk('the cron file schedules the hourly poke, unscheduling first', /'cfb_lab_hourly', '7 \* \* \* \*'/.test(CRON)
  && /cron\.unschedule/.test(CRON) && /select public\.cfb_lab_poke\(''hourly''\);/.test(CRON));
chk('and schedules no database-side lines job (the ledger mirror fills cfb_lab_market_lines), only unscheduling an old one',
  !/using 'cfb_lab_lines', '/.test(CRON) && /select cron\.unschedule\(\$1\)' using 'cfb_lab_lines'/.test(CRON));
chk('the fixture carries cases of every kind', FIX.dedupe_cases.length >= 5 && FIX.line_cases.length >= 5 && FIX.hash_cases.length >= 5
  && FIX.dedupe_cases.every((c) => c.why && c.observations.every((o) => o.why && ['written', 'duplicate', 'refused'].includes(o.expect)))
  && FIX.line_cases.every((c) => c.why && Array.isArray(c.expected)));

/* ═══ LIVE ═══════════════════════════════════════════════════════════════ */
function findPgBin() {
  const cands = ['pg_ctl'].concat(
    (() => { try { return fs.readdirSync('/usr/lib/postgresql').sort().reverse().map((v) => '/usr/lib/postgresql/' + v + '/bin/pg_ctl'); } catch (_) { return []; } })());
  for (const c of cands) {
    try {
      cp.execSync(`${c} --version`, { stdio: 'ignore' });
      return c === 'pg_ctl' ? path.dirname(cp.execSync('command -v pg_ctl').toString().trim()) : path.dirname(c);
    } catch (_) { /* keep looking */ }
  }
  return null;
}
const BIN = findPgBin();
if (!BIN) done('SKIP | no postgres binary (pg_ctl) found — the LIVE layer did not run. CI installs postgres.');

const PORT = 56300 + (process.pid % 200);
const asPostgres = process.getuid && process.getuid() === 0;
let HOME;
try {
  HOME = asPostgres ? fs.mkdtempSync('/var/lib/postgresql/cfblab-') : fs.mkdtempSync(path.join(os.tmpdir(), 'cfblab-'));
} catch (e) { done('SKIP | cannot create a cluster directory (' + String(e.message).slice(0, 120) + ') — LIVE layer skipped.'); }
const DATA = path.join(HOME, 'data');
const run = (cmd) => cp.execSync(asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd, { stdio: 'pipe', encoding: 'utf8' });
let started = false;
try {
  if (asPostgres) cp.execSync(`chown -R postgres ${HOME} && chmod 700 ${HOME}`);
  run(`${BIN}/initdb -D ${DATA} -U postgres -A trust -E UTF8 --locale=C`);
  run(`${BIN}/pg_ctl -D ${DATA} -o "-p ${PORT} -k ${HOME} -c listen_addresses=" -l ${HOME}/log start -w -t 30`);
  started = true;
} catch (e) {
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) { /* nothing to clean */ }
  done('SKIP | postgres would not start (' + String(e.message).slice(0, 160) + ') — LIVE layer skipped.');
}

/* psql reads the script from stdin: no shell quoting, no temp files. */
const PSQL = fs.existsSync(path.join(BIN, 'psql')) ? path.join(BIN, 'psql') : 'psql';
function psql(sql, opts) {
  opts = opts || {};
  const args = ['-X', '-q', '-h', HOME, '-p', String(PORT), '-U', 'postgres', '-d', opts.db || 'postgres', '-v', 'ON_ERROR_STOP=1', '-t', '-A'];
  if (opts.command) args.push('-c', sql);
  else args.push('-f', '-');
  const input = opts.command ? undefined : (opts.role ? 'set role ' + opts.role + ';\n' : '') + sql;
  return cp.execFileSync(PSQL, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 << 20,
    env: Object.assign({}, process.env, { PGCLIENTENCODING: 'UTF8' }) }).trim();
}
function mustFail(sql, opts) { try { psql(sql, opts); return null; } catch (e) { return String(e.stderr || e.stdout || e.message); } }
function qj(sql, opts) { const out = psql(sql, opts); const last = out.split('\n').filter(Boolean).pop(); return last === undefined ? null : JSON.parse(last); }
const J = (o) => '$j$' + JSON.stringify(o) + '$j$::jsonb';
/* insert a JSON object as a row, the way PostgREST does, with recorded_at = now() unless given */
function ins(table, row, opts) {
  return psql(`insert into public.${table} select * from jsonb_populate_record(jsonb_populate_record(null::public.${table}, jsonb_build_object('recorded_at', now())), ${J(row)})`, opts);
}
const failsWith = (err, re) => !!err && re.test(err);

try {
  /* ---------------------------------------------------------------- apply */
  psql(SHIM);
  const r1 = psql(SQL);
  chk('the contract applies to a clean database', true);
  chk('and every report row says ok', r1.split('\n').filter((l) => l.includes('|')).length >= 20 && !/CHECK THIS/.test(r1), r1.split('\n').filter((l) => /CHECK THIS/.test(l)));
  const r2 = psql(SQL);
  chk('it applies a second time without error, still all ok', !/CHECK THIS/.test(r2), r2.split('\n').filter((l) => /CHECK THIS/.test(l)));
  const r3 = psql(SQL, { command: true });
  chk('and a third time as ONE string in one round trip (the SQL editor), still all ok', !/CHECK THIS/.test(r3) && /\|ok$/m.test(r3), r3.slice(-300));
  chk('the report has a row per table plus the checks', (r2.match(/\|ok$/gm) || []).length === 25, (r2.match(/\|ok$/gm) || []).length);

  /* the pre-split parts (supabase/parts), pasted one at a time in order, build the same contract */
  const PARTS = path.join(ROOT, 'supabase', 'parts');
  const parts = fs.readdirSync(PARTS).filter((f) => /^cfb_lab\.part\d+-of-\d+\.sql$/.test(f)).sort();
  if (parts.length) {
    psql(`create database cfb_parts`, { command: true });
    psql(SHIM, { db: 'cfb_parts' });
    let lastOut = '';
    for (const f of parts) lastOut = psql(fs.readFileSync(path.join(PARTS, f), 'utf8'), { db: 'cfb_parts', command: true });
    chk('the ' + parts.length + ' parts in supabase/parts, pasted in order, end in the same all-ok report', (lastOut.match(/\|ok$/gm) || []).length === 25 && !/CHECK THIS/.test(lastOut), lastOut.slice(-300));
  }

  /* ---------------------------------------------------- rendering and ids */
  const lit = (p) => (p === null ? 'null::text' : typeof p === 'number' ? `public.cfb_lab_num(${p}::numeric)` : typeof p === 'boolean' ? `'${p}'::text` : `'${String(p).replace(/'/g, "''")}'::text`);
  for (const c of FIX.hash_cases) {
    const arr = 'array[' + c.parts.map(lit).join(', ') + ']::text[]';
    const got = psql(`select json_build_object('h', public.cfb_lab_h(variadic ${arr}), 'r', array_to_string(${arr}, '|', ''))`);
    const o = JSON.parse(got);
    chk('cfb_lab_h reproduces hash case ' + JSON.stringify(c.parts), o.h === c.expected && o.r === c.rendered, { got: o, want: c.expected });
  }
  for (const c of FIX.num_cases) {
    const got = psql(`select public.cfb_lab_num('${c.input}'::numeric)`);
    chk('cfb_lab_num(' + c.input + ') = ' + c.expected, got === c.expected, got);
  }
  for (const c of FIX.ts_cases) {
    const got = psql(`select public.cfb_lab_ts('${c.input}'::timestamptz)`);
    chk('cfb_lab_ts(' + c.input + ') = ' + c.expected, got === c.expected, got);
  }
  for (const c of FIX.median_cases) {
    const got = psql(`select public.cfb_lab_median(array[${c.values.join(',')}]::numeric[])`);
    chk('cfb_lab_median(' + JSON.stringify(c.values) + ') = ' + c.expected, (got === '' ? null : Number(got)) === c.expected, got);
  }
  for (const c of FIX.price_median_cases) {
    const got = psql(`select public.cfb_lab_median_price(array[${c.prices.map((p) => (p === null ? 'null' : p)).join(',')}]::int[])`);
    chk('cfb_lab_median_price(' + JSON.stringify(c.prices) + ') = ' + c.expected, (got === '' ? null : Number(got)) === c.expected, got);
  }

  /* ---------------------------------------------- quote de-duplication */
  const expectedKey = (o) => (o.expect_game_id !== undefined ? o.expect_game_id : o.game_id);
  for (const c of FIX.dedupe_cases) {
    const tag = 'dedupe [' + c.why.slice(0, 48) + '…]';
    for (const m of c.event_map || []) {
      ins('cfb_lab_event_map', Object.assign({ map_id: 'cfbx_' + h(m.source, m.provider_event_id, m.game_id) }, m), { role: 'service_role' });
    }
    /* 1. the whole case as ONE batch, rolled back afterwards */
    const out = psql(`begin;
      select public.cfb_lab_ingest_quotes(${J(c.observations)});
      select coalesce(json_agg(json_build_object('k', source || '|' || book || '|' || market_type || '|' || public.cfb_lab_ts(observed_at),
               'hb', is_heartbeat, 'g', game_id) order by observed_at, source, book, market_type), '[]'::json)
        from public.cfb_lab_market_quotes where recorded_at = now();
      rollback;`, { role: 'service_role' }).split('\n').filter(Boolean);
    const res = JSON.parse(out[0]), rows = JSON.parse(out[1]);
    const want = { written: 0, duplicate: 0, refused: 0 };
    c.observations.forEach((o) => { want[o.expect]++; });
    chk(tag + ' as one batch: written / duplicates / refused', res.received === c.observations.length && res.written === want.written
      && res.duplicates === want.duplicate && res.refused === want.refused, { got: res, want });
    const wantRows = c.observations.filter((o) => o.expect === 'written')
      .map((o) => JSON.stringify([o.source + '|' + o.book + '|' + o.market_type + '|' + iso(o.observed_at), !!o.heartbeat, expectedKey(o)])).sort();
    const gotRows = rows.map((r) => JSON.stringify([r.k, r.hb, r.g])).sort();
    chk(tag + ' as one batch: exactly the expected rows, heartbeats and game ids', JSON.stringify(gotRows) === JSON.stringify(wantRows), { gotRows, wantRows });

    /* 2. one observation at a time, in the order listed */
    for (const o of c.observations) {
      const lines = psql(`select public.cfb_lab_ingest_quotes(${J([o])});
        select json_build_object('quote_id', quote_id, 'fingerprint', fingerprint, 'g', game_id, 'hb', is_heartbeat)
          from public.cfb_lab_market_quotes order by recorded_at desc, quote_id limit 1;`, { role: 'service_role' }).split('\n').filter(Boolean);
      const r = JSON.parse(lines[0]);
      const got = r.written === 1 ? 'written' : r.duplicates === 1 ? 'duplicate' : r.refused === 1 ? 'refused' : 'none';
      chk(tag + ' ' + o.observed_at + ' ' + o.source + '/' + o.book + '/' + o.market_type + ' -> ' + o.expect + ' (' + o.why + ')', got === o.expect, r);
      if (got === 'written' && o.expect === 'written') {
        const row = JSON.parse(lines[1]);
        const key = expectedKey(o) !== null && expectedKey(o) !== undefined ? expectedKey(o) : o.provider_event_id;
        const qid = quoteId(o, key);
        const fp = h(o.home_line, o.total_points, o.price_home, o.price_away, o.price_over, o.price_under);
        chk(tag + ' ' + o.observed_at + ': quote_id and fingerprint follow SCHEMA.md rule 4 (after event-map resolution)', row.quote_id === qid && row.fingerprint === fp, { row, qid, fp });
        if (o.heartbeat !== undefined) chk(tag + ' ' + o.observed_at + ': is_heartbeat = ' + o.heartbeat, row.hb === o.heartbeat, row);
        if (o.expect_game_id !== undefined) chk(tag + ' ' + o.observed_at + ': game_id resolved to ' + o.expect_game_id, row.g === o.expect_game_id, row);
        if (o.expect_quote_id !== undefined) chk(tag + ' ' + o.observed_at + ': quote_id = ' + o.expect_quote_id, row.quote_id === o.expect_quote_id, row);
      }
    }
  }
  const forged = qj(`select public.cfb_lab_ingest_quotes(${J([{ source: 'espn', book: 'espnbet', game_id: 'fx_forged', market_type: 'spread', home_line: -1,
    price_home: -110, price_away: -110, observed_at: '2025-11-01T12:00:00.000Z', kickoff_ts: '2025-11-02T12:00:00.000Z',
    quote_id: 'cfbq_' + '0'.repeat(24), fingerprint: 'not-a-fingerprint', is_heartbeat: true }])})`, { role: 'service_role' });
  const forgedRow = qj(`select json_build_object('q', quote_id, 'f', fingerprint, 'hb', is_heartbeat) from public.cfb_lab_market_quotes where game_id = 'fx_forged'`);
  chk('a supplied quote_id, fingerprint and is_heartbeat are ignored: the ingest computes them', forged.written === 1 && forgedRow
    && forgedRow.q === 'cfbq_' + h('espn', 'espnbet', 'fx_forged', 'spread', '2025-11-01T12:00:00.000Z')
    && forgedRow.f === h(-1, null, -110, -110, null, null) && forgedRow.hb === false, forgedRow);
  const junk = qj(`select public.cfb_lab_ingest_quotes('[1, "x", {"observed_at": "not a time", "source": "espn"}]'::jsonb)`, { role: 'service_role' });
  chk('garbage in a batch is refused item by item, with reasons, never an error', junk.received === 3 && junk.refused === 3 && junk.refusals.length === 3, junk);
  chk('a non-array is an error', failsWith(mustFail(`select public.cfb_lab_ingest_quotes('{}'::jsonb)`, { role: 'service_role' }), /must be a JSON array/));

  /* ---------------------------------------------------------- openers/closes */
  const prediction = (over) => {
    const p = Object.assign({
      ledger_version: 'cfb_lab_ledger_v1', origin: 'LIVE', game_id: 'pr_g1', season: 2025, week: 6, season_type: 'regular',
      home_team: 'Alabama', away_team: 'Georgia', home_id: '333', away_id: '61', neutral_site: false,
      kickoff_ts: '2025-10-04T19:30:00.000Z', prediction_ts: '2025-10-03T19:30:00.000Z',
      checkpoint_type: 'T24', is_first_snapshot: false, official_families: ['OFFICIAL'],
      model_version: 'lab_m2', model_label: 'V2', model_role: 'champion',
      pure_home_margin: 3.5, fair_spread_home_line: -3.5, fair_spread_display: 'ALA -3.5',
      home_win_probability: 0.6, away_win_probability: 0.4, prediction_sigma: 14.2, t_df: 8,
      interval_50_low: -5, interval_50_high: 12, interval_80_low: -15, interval_80_high: 22, interval_95_low: -24, interval_95_high: 31,
      data_quality_status: 'GREEN', data_quality_issues: [], status: 'LEAN', decision_class: 'LEAN', decision_source: 'engine:v2',
      side: 'HOME', recommended_line: -3.5, recommended_price: -110, stake_units: 0, bet_enabled: false, near_miss: false,
      inputs_ref: { quote_ids: [] }, row_hash: 'f'.repeat(64),
    }, over);
    if (!over || over.hours_to_kickoff === undefined) p.hours_to_kickoff = Math.round((Date.parse(p.kickoff_ts) - Date.parse(p.prediction_ts)) / 3600) / 1000;
    if (!over || over.prediction_id === undefined) p.prediction_id = 'cfbp_' + h(...[p.model_version, p.game_id, p.checkpoint_type, iso(p.prediction_ts)].concat(p.origin && p.origin !== 'LIVE' ? [p.origin] : []));
    return p;
  };
  for (const c of FIX.line_cases) {
    if (c.quotes.length) {
      psql(`do $t$
        declare e jsonb; r public.cfb_lab_market_quotes;
        begin
          for e in select * from jsonb_array_elements(${J(c.quotes)}) loop
            r := jsonb_populate_record(null::public.cfb_lab_market_quotes, e);
            r.fingerprint := public.cfb_lab_h(public.cfb_lab_num(r.home_line), public.cfb_lab_num(r.total_points),
              public.cfb_lab_num(r.price_home), public.cfb_lab_num(r.price_away), public.cfb_lab_num(r.price_over), public.cfb_lab_num(r.price_under));
            r.quote_id := 'cfbq_' || case
              when r.is_provider_open then public.cfb_lab_h(r.source, r.book, coalesce(r.game_id, r.provider_event_id), r.market_type, public.cfb_lab_ts(r.observed_at), 'provider_open')
              when r.is_provider_close then public.cfb_lab_h(r.source, r.book, coalesce(r.game_id, r.provider_event_id), r.market_type, public.cfb_lab_ts(r.observed_at), 'provider_close')
              else public.cfb_lab_h(r.source, r.book, coalesce(r.game_id, r.provider_event_id), r.market_type, public.cfb_lab_ts(r.observed_at)) end;
            r.retrieved_at := coalesce(r.retrieved_at, r.observed_at);
            r.recorded_at := now();
            insert into public.cfb_lab_market_quotes values (r.*);
          end loop;
        end $t$;`);
    }
    if (c.register_with_prediction) {
      ins('cfb_lab_predictions', prediction({ game_id: c.game_id, kickoff_ts: c.kickoff_ts, prediction_ts: iso(Date.parse(c.kickoff_ts) - 30 * 3600e3),
        checkpoint_type: 'T48', official_families: ['MIDWEEK_MODEL'], model_version: 'lab_registrar', model_role: 'candidate' }), { role: 'service_role' });
    }
  }
  chk('a close cannot be derived for a time in the future', failsWith(mustFail(`select public.cfb_lab_derive_lines(now() + interval '1 day')`, { role: 'service_role' }), /in the future/));
  /* a game that kicked off one hour ago is not due yet */
  psql(`select public.cfb_lab_ingest_quotes(jsonb_build_array(jsonb_build_object('source','espn','book','espnbet','game_id','fx_recent',
          'market_type','spread','home_line',-3,'price_home',-110,'price_away',-110,'observed_at',now() - interval '2 hours','kickoff_ts',now() - interval '1 hour')))`, { role: 'service_role' });
  /* a quote written before its provider event was mapped counts once the event is mapped (SQL-only) */
  const late = (line, at) => ({ source: 'odds_api', book: 'fanduel', provider_event_id: 'oa_late', market_type: 'spread', home_line: line,
    price_home: -110, price_away: -110, observed_at: at, kickoff_ts: '2025-11-22T20:00:00.000Z' });
  const lt1 = qj(`select public.cfb_lab_ingest_quotes(${J([late(-2.5, '2025-11-20T12:00:00.000Z')])})`, { role: 'service_role' });
  ins('cfb_lab_event_map', { map_id: 'cfbx_' + h('odds_api', 'oa_late', 'fx_late'), source: 'odds_api', provider_event_id: 'oa_late', game_id: 'fx_late',
    method: 'teams_and_kickoff', confidence: 0.9, created_at: '2025-11-21T00:00:00.000Z', supersedes: null }, { role: 'service_role' });
  const lt2 = qj(`select public.cfb_lab_ingest_quotes(${J([late(-3, '2025-11-22T18:00:00.000Z')])})`, { role: 'service_role' });
  chk('an unmapped quote is stored with game_id null, and the next one resolves through the new map row', lt1.written === 1 && lt2.written === 1
    && psql(`select string_agg(coalesce(game_id, '-'), ',' order by observed_at) from public.cfb_lab_market_quotes where provider_event_id = 'oa_late'`) === '-,fx_late');
  const d1 = qj(`select public.cfb_lab_derive_lines(now())`, { role: 'service_role' });
  chk('cfb_lab_derive_lines runs as the service role and derives every due game', d1 && d1.games >= FIX.line_cases.length && d1.rows_written > 0, d1);
  chk('a game less than three hours past kickoff is left for a later run', psql(`select count(*) from public.cfb_lab_market_lines where game_id = 'fx_recent'`) === '0');
  const d2 = qj(`select public.cfb_lab_derive_lines(now())`, { role: 'service_role' });
  chk('a second run derives nothing: lines are write-once', d2 && d2.rows_written === 0 && d2.games === 0, d2);

  const lateLines = qj(`select json_object_agg(kind || ' ' || book, cfb_lab_num(home_line) || ' @ ' || coalesce(public.cfb_lab_ts(observed_at), '-'))
      from public.cfb_lab_market_lines where game_id = 'fx_late'`);
  chk('the per-book OPEN of a game includes quotes written before its event was mapped', lateLines
    && lateLines['OPEN odds_api:fanduel'] === '-2.5 @ 2025-11-20T12:00:00.000Z' && lateLines['CLOSE odds_api:fanduel'] === '-3 @ 2025-11-22T18:00:00.000Z'
    && lateLines['OPEN CONSENSUS'] === '-2.5 @ 2025-11-20T12:00:00.000Z' && lateLines['CLOSE CONSENSUS'] === '-3 @ 2025-11-22T18:00:00.000Z', lateLines);
  const FIELDS = ['kind', 'book', 'market_type', 'home_line', 'total_points', 'price_home', 'price_away', 'quality', 'n_books', 'best_line_home', 'best_line_away', 'observed_at'];
  const norm = (l) => JSON.stringify(FIELDS.map((k) => (l[k] === undefined ? null : l[k])));
  for (const c of FIX.line_cases) {
    const tag = 'lines ' + c.game_id + ' [' + c.why.slice(0, 40) + '…]';
    const got = qj(`select coalesce(json_agg(json_build_object('line_id', line_id, 'kind', kind, 'book', book, 'market_type', market_type,
        'home_line', home_line, 'total_points', total_points, 'price_home', price_home, 'price_away', price_away, 'quality', quality,
        'n_books', n_books, 'best_line_home', best_line_home, 'best_line_away', best_line_away, 'observed_at', public.cfb_lab_ts(observed_at),
        'rule_version', rule_version, 'quote_ids', quote_ids, 'kickoff_ts', public.cfb_lab_ts(kickoff_ts))), '[]'::json)
        from public.cfb_lab_market_lines where game_id = '${c.game_id}'`);
    const gotN = got.map(norm).sort(), wantN = c.expected.map(norm).sort();
    chk(tag + ': exactly the expected set of lines', JSON.stringify(gotN) === JSON.stringify(wantN),
      { missing: wantN.filter((w) => !gotN.includes(w)), unexpected: gotN.filter((g) => !wantN.includes(g)) });
    chk(tag + ': every line_id is cfbl_ + h(game_id, kind, book, market_type, rule_version)', got.every((l) =>
      l.rule_version === (l.kind === 'OPEN' ? 'cfb_lab_open_v1' : 'cfb_lab_close_v1')
      && l.line_id === 'cfbl_' + h(c.game_id, l.kind, l.book, l.market_type, l.rule_version)), got.map((l) => [l.line_id, l.kind, l.book]));
    chk(tag + ': every line carries the game kickoff and the quotes it used', got.every((l) => l.kickoff_ts === iso(c.kickoff_ts)
      && (l.quality === 'MISSING' ? l.quote_ids.length === 0 : l.quote_ids.length === l.n_books)));
  }

  /* ------------------------------------------------------------ model roles */
  const role = (m, label, r, reason) => qj(`select public.cfb_lab_set_role(${m === null ? 'null' : `'${m}'`}, ${label === null ? 'null' : `'${label}'`}, '${r}', '${reason}', 'daniel')`, { role: 'service_role' });
  const s1 = role('lab_m1', 'V1', 'champion', 'the incumbent');
  chk('set_role writes a champion', s1.changed === true && s1.audit_event_type === 'MODEL_PROMOTED', s1);
  const s1b = role('lab_m1', 'V1', 'champion', 'again');
  chk('setting the role a model already holds writes nothing', s1b.changed === false, s1b);
  const s2 = role('lab_m2', 'V2', 'champion', 'promotion evaluation passed');
  chk('promoting a second champion demotes the first in the same call', s2.changed === true && JSON.stringify(s2.demoted) === '["lab_m1"]', s2);
  const cur = qj(`select json_object_agg(model_version, role) from public.cfb_lab_current_roles`);
  chk('there is exactly one champion, and the old one is a challenger', cur.lab_m2 === 'champion' && cur.lab_m1 === 'challenger'
    && psql(`select count(*) from public.cfb_lab_current_roles where role = 'champion'`) === '1', cur);
  const aud = qj(`select json_agg(event_type || ':' || subject order by created_at, event_type) from public.cfb_lab_audit_log`);
  chk('each role change is in the audit log (promotion, demotion, promotion)', JSON.stringify(aud) === JSON.stringify(['MODEL_PROMOTED:lab_m1', 'ROLE_CHANGED:lab_m1', 'MODEL_PROMOTED:lab_m2']), aud);
  const s3 = role('lab_m1', null, 'retired', 'superseded');
  chk('retiring writes MODEL_RETIRED and keeps the label', s3.audit_event_type === 'MODEL_RETIRED'
    && psql(`select model_label from public.cfb_lab_current_roles where model_version = 'lab_m1'`) === 'V1', s3);
  const s4 = role('lab_m3', 'V2.1', 'candidate', 'registered');
  chk('any other role change is ROLE_CHANGED', s4.audit_event_type === 'ROLE_CHANGED', s4);
  chk('role and audit event ids are cfbg_ + 24 hex, and a role event supersedes the model\'s previous one',
    psql(`select bool_and(event_id ~ '^cfbg_[0-9a-f]{24}$') from public.cfb_lab_model_roles`) === 't'
    && psql(`select bool_and(event_id ~ '^cfbg_[0-9a-f]{24}$') from public.cfb_lab_audit_log`) === 't'
    && psql(`select count(*) from public.cfb_lab_model_roles r where r.model_version = 'lab_m1' and r.role = 'challenger'
               and r.supersedes = (select event_id from public.cfb_lab_model_roles where model_version = 'lab_m1' and role = 'champion')`) === '1');
  let err = mustFail(`insert into public.cfb_lab_model_roles (event_id, model_version, role, effective_at, actor) values ('cfbg_${'a'.repeat(24)}', 'lab_m3', 'champion', now(), 'someone')`, { role: 'service_role' });
  chk('a second champion written directly is refused', failsWith(err, /cannot become champion while lab_m2 is champion/), err && err.slice(0, 200));
  chk('an unknown role is refused', failsWith(mustFail(`select public.cfb_lab_set_role('lab_m3', null, 'king', 'x', 'daniel')`, { role: 'service_role' }), /role must be/));
  chk('a role change needs an actor', failsWith(mustFail(`select public.cfb_lab_set_role('lab_m3', null, 'challenger', 'x', null)`, { role: 'service_role' }), /actor is required/));
  chk('a signed-in reader cannot change a role', failsWith(mustFail(`select public.cfb_lab_set_role('lab_m3', null, 'champion', 'x', 'me')`, { role: 'authenticated' }), /permission denied/));

  /* ------------------------------------------------ predictions and grading */
  const P = prediction({});
  ins('cfb_lab_predictions', P, { role: 'service_role' });
  chk('a valid OFFICIAL prediction is recorded by the service role', psql(`select count(*) from public.cfb_lab_predictions where prediction_id = '${P.prediction_id}'`) === '1');
  /* a VERIFIED 7+ snapshot carries its verified gap and shows in the Model
     Lab's major-disagreement view, beside the raw gap */
  const PV = prediction({ game_id: 'pr_gv', checkpoint_type: 'T6', official_families: [], prediction_ts: '2025-10-04T13:00:00.000Z',
    prediction_id: 'cfbp_' + 'ab'.repeat(12), model_market_gap: 9.5, current_spread: 6, disagreement_version: 'cfb_disagreement/1',
    disagreement_status: 'VERIFIED_MAJOR_DISAGREEMENT', disagreement_tier: 'MAJOR_7', verified_market_gap: 9.5, calibrated_market_gap: 8.8,
    disagreement_root_cause: 'VALID_MODEL_DISAGREEMENT', disagreement_checks: { failed: [], incomplete: [] } });
  ins('cfb_lab_predictions', PV, { role: 'service_role' });
  chk('a VERIFIED 9.5-pt snapshot is recorded with its verified gap',
    psql(`select verified_market_gap || '|' || disagreement_status from public.cfb_lab_predictions where prediction_id = '${PV.prediction_id}'`) === '9.500|VERIFIED_MAJOR_DISAGREEMENT');
  chk('and appears in cfb_lab_major_disagreements with the raw gap beside it',
    psql(`select raw_market_gap || '|' || verified_market_gap from public.cfb_lab_major_disagreements where prediction_id = '${PV.prediction_id}'`) === '9.500|9.500');
  const tryPred = (over) => mustFail(`insert into public.cfb_lab_predictions select * from jsonb_populate_record(jsonb_populate_record(null::public.cfb_lab_predictions, jsonb_build_object('recorded_at', now())), ${J(prediction(over))})`, { role: 'service_role' });
  const bad = [
    ['a prediction taken after kickoff', { checkpoint_type: 'T2', official_families: [], prediction_ts: '2025-10-04T20:00:00.000Z', hours_to_kickoff: 0.5 }, /cfb_lab_pred_pregame|cfb_lab_pred_hours/],
    ['a prediction taken exactly at kickoff', { checkpoint_type: 'T2', official_families: [], prediction_ts: '2025-10-04T19:30:00.000Z' }, /cfb_lab_pred_pregame|cfb_lab_pred_hours/],
    ['a future-dated LIVE prediction', { game_id: 'pr_future', kickoff_ts: iso(Date.now() + 3 * 86400e3), prediction_ts: iso(Date.now() + 86400e3), checkpoint_type: 'T48', official_families: [] }, /in the future/],
    ['hours_to_kickoff that disagrees with the two timestamps', { checkpoint_type: 'T12', official_families: [], prediction_ts: '2025-10-04T09:30:00.000Z', hours_to_kickoff: 12.5 }, /cfb_lab_pred_hours/],
    ['a fair line whose sign disagrees with the margin', { checkpoint_type: 'T12', official_families: [], prediction_ts: '2025-10-04T09:30:00.000Z', fair_spread_home_line: 3.5 }, /cfb_lab_pred_sign/],
    ['a win probability of 1.2', { checkpoint_type: 'T12', official_families: [], prediction_ts: '2025-10-04T09:30:00.000Z', home_win_probability: 1.2, away_win_probability: -0.2 }, /cfb_lab_pred_prob_range/],
    ['a win probability of exactly 0', { checkpoint_type: 'T12', official_families: [], prediction_ts: '2025-10-04T09:30:00.000Z', home_win_probability: 0, away_win_probability: 1 }, /cfb_lab_pred_prob_range/],
    ['win probabilities that do not sum to 1', { checkpoint_type: 'T12', official_families: [], prediction_ts: '2025-10-04T09:30:00.000Z', home_win_probability: 0.6, away_win_probability: 0.5 }, /cfb_lab_pred_prob_sum/],
    ['a sigma of 0', { checkpoint_type: 'T12', official_families: [], prediction_ts: '2025-10-04T09:30:00.000Z', prediction_sigma: 0 }, /cfb_lab_pred_sigma/],
    ['a 50% interval wider than the 80%', { checkpoint_type: 'T12', official_families: [], prediction_ts: '2025-10-04T09:30:00.000Z', interval_50_low: -20 }, /cfb_lab_pred_interval_nesting/],
    ['an 80% interval outside the 95%', { checkpoint_type: 'T12', official_families: [], prediction_ts: '2025-10-04T09:30:00.000Z', interval_80_high: 40 }, /cfb_lab_pred_interval_nesting/],
    ['an interval whose low is above its high', { checkpoint_type: 'T12', official_families: [], prediction_ts: '2025-10-04T09:30:00.000Z', interval_95_low: 40 }, /cfb_lab_pred_interval_order|cfb_lab_pred_interval_nesting/],
    ['the OFFICIAL family on a T48 snapshot', { checkpoint_type: 'T48', prediction_ts: '2025-10-02T19:30:00.000Z', official_families: ['OFFICIAL', 'MIDWEEK_MODEL'] }, /cfb_lab_pred_official/],
    ['the OFFICIAL family on a REPLAY T24', { origin: 'REPLAY', official_families: ['OFFICIAL'] }, /cfb_lab_pred_official/],
    ['the OFFICIAL family on a GIT_RECONSTRUCTED T24', { origin: 'GIT_RECONSTRUCTED', official_families: ['OFFICIAL'] }, /cfb_lab_pred_official/],
    ['a family that does not exist', { checkpoint_type: 'T12', prediction_ts: '2025-10-04T09:30:00.000Z', official_families: ['BEST_MODEL'] }, /cfb_lab_pred_families/],
    ['a second LIVE T24 for the same game and model', { prediction_ts: '2025-10-03T20:30:00.000Z' }, /cfb_lab_pred_checkpoint_slot/],
    ['a prediction_id that is not cfbp_ + 24 hex', { checkpoint_type: 'T12', official_families: [], prediction_ts: '2025-10-04T09:30:00.000Z', prediction_id: 'cfbp_NOT-HEX' }, /cfb_lab_pred_id_format/],
    ['a stake without bet_enabled', { checkpoint_type: 'T12', official_families: [], prediction_ts: '2025-10-04T09:30:00.000Z', decision_class: 'BET', status: 'BET', stake_units: 1 }, /cfb_lab_pred_stake/],
    ['a negative stake', { checkpoint_type: 'T12', official_families: [], prediction_ts: '2025-10-04T09:30:00.000Z', bet_enabled: true, stake_units: -1 }, /cfb_lab_pred_stake/],
    ['an unknown decision class', { checkpoint_type: 'T12', official_families: [], prediction_ts: '2025-10-04T09:30:00.000Z', decision_class: 'STRONG BET' }, /cfb_lab_pred_decision_class/],
    ['an unknown checkpoint', { checkpoint_type: 'T36', official_families: [], prediction_ts: '2025-10-04T09:30:00.000Z' }, /cfb_lab_pred_checkpoint/],
    ['an unknown origin', { origin: 'BACKFILL', checkpoint_type: 'T12', official_families: [], prediction_ts: '2025-10-04T09:30:00.000Z' }, /cfb_lab_pred_origin/],
    /* the major-disagreement verdict: a verified gap exists only on a VERIFIED
       7+ snapshot and is exactly the raw gap; nothing else can carry one */
    ['an unknown disagreement status (the retired MAJOR_DISAGREEMENT)', { checkpoint_type: 'T12', official_families: [], prediction_ts: '2025-10-04T09:30:00.000Z', model_market_gap: 9, disagreement_status: 'MAJOR_DISAGREEMENT' }, /cfb_lab_pred_disagreement_status/],
    ['a verified gap on an INVESTIGATE snapshot', { checkpoint_type: 'T12', official_families: [], prediction_ts: '2025-10-04T09:30:00.000Z', model_market_gap: 9, disagreement_status: 'INVESTIGATE', verified_market_gap: 9 }, /cfb_lab_pred_verified_gap/],
    ['a verified gap that is not the raw gap', { checkpoint_type: 'T12', official_families: [], prediction_ts: '2025-10-04T09:30:00.000Z', model_market_gap: 9, disagreement_status: 'VERIFIED_MAJOR_DISAGREEMENT', verified_market_gap: 11 }, /cfb_lab_pred_verified_gap/],
    ['a verified gap under 7 points', { checkpoint_type: 'T12', official_families: [], prediction_ts: '2025-10-04T09:30:00.000Z', model_market_gap: 5, disagreement_status: 'VERIFIED_MAJOR_DISAGREEMENT', verified_market_gap: 5 }, /cfb_lab_pred_verified_gap/],
  ];
  for (const [name, over, re] of bad) {
    err = tryPred(over);
    chk('refused: ' + name, failsWith(err, re), err && err.slice(0, 220));
  }
  chk('a GIT_RECONSTRUCTED T24 beside the LIVE T24 is kept (it never occupies the LIVE slot)',
    tryPred({ origin: 'GIT_RECONSTRUCTED', official_families: [], prediction_ts: '2025-10-03T18:00:00.000Z' }) === null);
  chk('a REPLAY T24 beside them too', tryPred({ origin: 'REPLAY', official_families: [], prediction_ts: '2025-10-03T17:00:00.000Z' }) === null);
  chk('ADHOC snapshots may repeat', tryPred({ checkpoint_type: 'ADHOC', official_families: [], prediction_ts: '2025-10-04T10:00:00.000Z' }) === null
    && tryPred({ checkpoint_type: 'ADHOC', official_families: [], prediction_ts: '2025-10-04T11:00:00.000Z' }) === null);
  chk('a stake with bet_enabled is allowed', tryPred({ checkpoint_type: 'T6', official_families: [], prediction_ts: '2025-10-04T15:00:00.000Z', decision_class: 'BET', status: 'BET', bet_enabled: true, stake_units: 1 }) === null);
  chk('a LIVE snapshot stamped a few minutes ahead (clock skew, < 10 min) is allowed', tryPred({ game_id: 'pr_now', kickoff_ts: iso(Date.now() + 86400e3), prediction_ts: iso(Date.now() + 5 * 60e3), checkpoint_type: 'T24' }) === null);

  const result = (over) => {
    const r = Object.assign({ game_id: 'pr_g1', season: 2025, week: 6, status: 'FINAL', home_points: 31, away_points: 24, final_margin: 7, final_total: 55,
      overtime: false, sources: { espn: [31, 24], cfbfastr: [31, 24] }, sources_agree: true, supersedes: null, reason: null }, over);
    if (!over || over.result_id === undefined) r.result_id = 'cfbr_' + h(r.game_id, r.status, r.home_points, r.away_points, r.supersedes);
    return r;
  };
  const R1 = result({});
  ins('cfb_lab_results', R1, { role: 'service_role' });
  const RFAIL = (over) => mustFail(`insert into public.cfb_lab_results select * from jsonb_populate_record(jsonb_populate_record(null::public.cfb_lab_results, jsonb_build_object('recorded_at', now())), ${J(result(over))})`, { role: 'service_role' });
  err = RFAIL({ game_id: 'pr_g9', sources_agree: false });
  chk('refused: a FINAL the sources do not agree on', failsWith(err, /cfb_lab_result_final_agreed/), err && err.slice(0, 200));
  err = RFAIL({ game_id: 'pr_g9', home_points: null });
  chk('refused: a FINAL without both scores', failsWith(err, /cfb_lab_result_final_agreed/), err && err.slice(0, 200));
  err = RFAIL({ game_id: 'pr_g9', final_margin: 6 });
  chk('refused: a FINAL whose margin is not home - away', failsWith(err, /cfb_lab_result_final_derived/), err && err.slice(0, 200));
  err = RFAIL({ home_points: 31, away_points: 27, final_margin: 4, final_total: 58, supersedes: 'cfbr_' + '0'.repeat(24) });
  chk('refused: a correction that supersedes a result that does not exist', failsWith(err, /not an existing result of game pr_g1/), err && err.slice(0, 200));
  err = RFAIL({ game_id: 'pr_g2', supersedes: R1.result_id });
  chk('refused: a correction that supersedes another game\'s result', failsWith(err, /not an existing result of game pr_g2/), err && err.slice(0, 200));
  const R1c = result({ home_points: 31, away_points: 27, final_margin: 4, final_total: 58, supersedes: R1.result_id, reason: 'scoring change' });
  ins('cfb_lab_results', R1c, { role: 'service_role' });
  chk('a correction is a new row and becomes the current result', psql(`select result_id from public.cfb_lab_current_results where game_id = 'pr_g1'`) === R1c.result_id
    && psql(`select count(*) from public.cfb_lab_results where game_id = 'pr_g1'`) === '2');
  const R2 = result({ game_id: 'pr_g2', status: 'POSTPONED', home_points: null, away_points: null, final_margin: null, final_total: null, sources: { espn: 'postponed' } });
  ins('cfb_lab_results', R2, { role: 'service_role' });
  chk('a POSTPONED result needs no score', psql(`select status from public.cfb_lab_current_results where game_id = 'pr_g2'`) === 'POSTPONED');

  /* the public record: champion OFFICIAL LIVE snapshots with a current evaluation, nothing else */
  const evaluation = (pred, over) => {
    const e = Object.assign({ prediction_id: pred.prediction_id, eval_version: 'cfb_lab_eval_v1', result_id: R1c.result_id, evaluated_at: '2025-10-05T12:00:00.000Z',
      game_id: pred.game_id, model_version: pred.model_version, checkpoint_type: pred.checkpoint_type, origin: pred.origin,
      official: pred.checkpoint_type === 'T24' && pred.origin === 'LIVE', season: pred.season, week: pred.week, kickoff_ts: pred.kickoff_ts,
      model_label: pred.model_label, model_role: pred.model_role, hours_to_kickoff: pred.hours_to_kickoff, is_first_snapshot: pred.is_first_snapshot,
      result_status: 'FINAL', final_home_points: 31, final_away_points: 27, final_margin: 4, final_total: 58, overtime: false, void: false,
      margin_error: 0.5, abs_margin_error: 0.5, squared_margin_error: 0.25, winner_correct: true, brier_win: 0.16, log_loss_win: 0.5108, p_home: 0.6, home_won: 1,
      in_interval_50: true, in_interval_80: true, in_interval_95: true, tie_vs_open: false, tie_vs_close: false,
      decision_class: pred.decision_class, side: pred.side, graded_line: pred.recommended_line, graded_price: -110, price_assumed: false,
      ats_result: 'WIN', units: 0, stake_units: 0, hypothetical_units: 0.909, clv_points: 1, positive_clv: true, process_quality: 'GOOD', outcome_quadrant: 'GOOD_PROCESS_WIN' }, over);
    e.evaluation_id = 'cfbe_' + h(e.prediction_id, e.eval_version, e.result_id, e.close_line_id === undefined ? null : e.close_line_id);
    return e;
  };
  ins('cfb_lab_evaluations', evaluation(P, { eval_version: 'cfb_lab_eval_v0', result_id: R1.result_id, evaluated_at: '2025-10-05T06:00:00.000Z', abs_margin_error: 3.5, final_away_points: 24 }), { role: 'service_role' });
  ins('cfb_lab_evaluations', evaluation(P), { role: 'service_role' });
  const P48 = prediction({ checkpoint_type: 'T48', prediction_ts: '2025-10-02T19:30:00.000Z', official_families: ['EARLY_MODEL', 'MIDWEEK_MODEL'], is_first_snapshot: true });
  const Pch = prediction({ model_version: 'lab_m3', model_label: 'V2.1', model_role: 'challenger' });
  const Prp = prediction({ origin: 'REPLAY', official_families: [], prediction_ts: '2025-10-03T17:00:00.000Z' });   /* recorded above */
  const Pg2 = prediction({ game_id: 'pr_g2', home_team: 'Texas', away_team: 'Oklahoma', decision_class: 'PASS', side: null, recommended_line: null, recommended_price: null, status: 'PASS' });
  const Pg3 = prediction({ game_id: 'pr_g3', home_team: 'Ohio State', away_team: 'Michigan' });
  for (const p of [P48, Pch, Pg2, Pg3]) ins('cfb_lab_predictions', p, { role: 'service_role' });
  for (const p of [P48, Pch, Prp]) ins('cfb_lab_evaluations', evaluation(p, { abs_margin_error: 9 }), { role: 'service_role' });
  ins('cfb_lab_evaluations', evaluation(Pg2, { result_id: R2.result_id, result_status: 'POSTPONED', void: true, final_home_points: null, final_away_points: null,
    final_margin: null, final_total: null, margin_error: null, abs_margin_error: null, squared_margin_error: null, brier_win: null, in_interval_80: null,
    ats_result: 'VOID', clv_points: null, positive_clv: null }), { role: 'service_role' });

  const pub = qj(`select json_agg(to_jsonb(r) order by r.game_id) from public.cfb_lab_public_record r`, { role: 'anon' });
  chk('anon reads the public record: one row per champion OFFICIAL LIVE snapshot with an evaluation', pub && pub.length === 2
    && pub[0].game_id === 'pr_g1' && pub[1].game_id === 'pr_g2', pub && pub.map((r) => r.game_id));
  const COLS = ['season', 'week', 'game_id', 'kickoff_ts', 'home_team', 'away_team', 'model_version', 'fair_spread_home_line', 'home_win_probability',
    'final_home_points', 'final_away_points', 'abs_margin_error', 'brier_win', 'in_interval_80', 'decision_class', 'side', 'recommended_line', 'ats_result', 'clv_points'];
  chk('and exactly the published columns, no internal field', pub && JSON.stringify(Object.keys(pub[0]).sort()) === JSON.stringify(COLS.slice().sort()), pub && Object.keys(pub[0]));
  chk('the record carries the NEWEST evaluation of the snapshot (the corrected result)', pub && Number(pub[0].abs_margin_error) === 0.5 && pub[0].final_away_points === 27, pub && pub[0]);
  chk('a champion snapshot with no evaluation yet is not public', !pub.some((r) => r.game_id === 'pr_g3'));
  const sum = qj(`select json_agg(to_jsonb(s) order by s.season nulls last) from public.cfb_lab_public_summary s`, { role: 'anon' });
  chk('anon reads the public summary: per season and overall, VOID counted only in n', sum && sum.length === 2 && sum[0].season === 2025 && sum[1].season === null
    && sum.every((s) => s.n === 2 && s.n_settled === 1 && s.n_void === 1 && Number(s.mae) === 0.5 && Number(s.rmse) === 0.5 && Number(s.brier) === 0.16
      && Number(s.coverage_80) === 1 && s.research_positions === 1 && s.ats_wins === 1 && s.ats_losses === 0 && s.ats_pushes === 0
      && Number(s.mean_clv) === 1 && Number(s.positive_clv_share) === 1 && s.sample_label === 'small sample'), sum);
  chk('official_predictions is the T24 LIVE rows', psql(`select count(*) from public.cfb_lab_official_predictions`) === String(
    Number(psql(`select count(*) from public.cfb_lab_predictions where checkpoint_type = 'T24' and origin = 'LIVE'`))));
  chk('current_evaluations holds one row per prediction', psql(`select count(*) = count(distinct prediction_id) from public.cfb_lab_current_evaluations`) === 't');

  /* the governance tables that have no writer function */
  const G = (...p) => 'cfbg_' + h(...p);
  ins('cfb_lab_experiments', { event_id: G('experiments', 'exp_001', 'CREATED'), experiment_id: 'exp_001', event: 'CREATED', experiment_name: 'shrink QB prior',
    baseline_model: 'lab_m2', challenger_model: 'lab_m3', hypothesis: 'MAE falls', change: 'qb prior 0.6 -> 0.5', scope: 'SINGLE_CHANGE', start_date: '2026-09-27',
    evaluation_window: '150 common games', metrics: { primary: 'mae' }, status: 'RUNNING', result: null, actor: 'daniel', created_at: '2026-09-27T12:00:00.000Z' }, { role: 'service_role' });
  ins('cfb_lab_partitions', { event_id: G('partitions', 'live_observation_pool', 2026), pool: 'live_observation_pool', season: 2026, week_from: 5, week_to: 16,
    origin_scope: 'LIVE', effective_at: '2026-09-27T00:00:00.000Z', reason: 'the lab goes live', actor: 'daniel' }, { role: 'service_role' });
  ins('cfb_lab_research_queue', { event_id: 'rq_' + h('disagreement_error', 'OPENED'), item_key: 'disagreement_error', event: 'OPENED', title: 'disagreement predicts error',
    evidence: { buckets: [1, 2] }, n: 40, effect: 1.2, effect_se: 0.5, created_at: '2026-09-27T12:00:00.000Z' }, { role: 'service_role' });
  ins('cfb_lab_reports', { report_id: 'weekly_2026_05', kind: 'weekly', season: 2026, week: 5, generated_at: '2026-09-27T12:00:00.000Z', body: { n: 0 } }, { role: 'service_role' });
  ins('cfb_lab_miss_reviews', { review_id: 'cfbm_' + h(P.prediction_id, 'UNKNOWN', 'auto:cfb_lab_miss_v1', null), prediction_id: P.prediction_id, game_id: 'pr_g1',
    model_version: 'lab_m2', severity: 10, predicted_margin: 3.5, actual_margin: 14, market_close_home_line: -4.5, abs_error: 10.5, close_abs_error: 9.5,
    evidence: { components: { a: 1 } }, classification: 'UNKNOWN', classified_by: 'auto:cfb_lab_miss_v1', rationale: null, created_at: '2025-10-05T12:00:00.000Z', supersedes: null }, { role: 'service_role' });
  err = mustFail(`insert into public.cfb_lab_experiments (event_id, experiment_id, event) values ('exp-1', 'exp_002', 'CREATED')`, { role: 'service_role' });
  chk('refused: a governance event id that is not cfbg_ + 24 hex', failsWith(err, /cfb_lab_experiment_event_id_format/), err && err.slice(0, 200));
  err = mustFail(`insert into public.cfb_lab_miss_reviews (review_id, prediction_id, game_id, model_version, classification, classified_by) values ('cfbm_${'b'.repeat(24)}', 'p', 'g', 'm', 'BAD_LUCK', 'me')`, { role: 'service_role' });
  chk('refused: a miss classification that is not in the list', failsWith(err, /cfb_lab_miss_class/), err && err.slice(0, 200));

  /* lines: a CLOSE before kickoff + 3 h, however it is written */
  const k1 = FIX.line_cases[0].kickoff_ts;
  err = mustFail(`insert into public.cfb_lab_market_lines (line_id, game_id, kind, book, market_type, quality, rule_version, derived_at)
    values ('cfbl_${'c'.repeat(24)}', '${FIX.line_cases[0].game_id}', 'CLOSE', 'early_book', 'spread', 'MISSING', 'cfb_lab_close_v1', '${iso(Date.parse(k1) + 2 * 3600e3)}')`, { role: 'service_role' });
  chk('refused: a CLOSE derived two hours after kickoff (the kickoff is known from the quotes)', failsWith(err, /before kickoff .* \+ 3 hours/), err && err.slice(0, 200));
  err = mustFail(`insert into public.cfb_lab_market_lines (line_id, game_id, kind, book, market_type, quality, rule_version, derived_at, kickoff_ts)
    values ('cfbl_${'d'.repeat(24)}', 'unknown_game', 'CLOSE', 'CONSENSUS', 'spread', 'MISSING', 'cfb_lab_close_v1', now(), now() - interval '1 hour')`, { role: 'service_role' });
  chk('refused: a CLOSE for an unknown game whose own kickoff_ts is one hour ago', failsWith(err, /before kickoff/), err && err.slice(0, 200));
  chk('a CLOSE for a game whose kickoff nobody knows is not blocked', mustFail(`insert into public.cfb_lab_market_lines (line_id, game_id, kind, book, market_type, quality, rule_version, derived_at)
    values ('cfbl_${'e'.repeat(24)}', 'unknown_game_2', 'CLOSE', 'CONSENSUS', 'spread', 'MISSING', 'cfb_lab_close_v1', now())`, { role: 'service_role' }) === null);
  err = mustFail(`insert into public.cfb_lab_market_lines (line_id, game_id, kind, book, market_type, quality, rule_version, derived_at)
    values ('cfbl_${'f'.repeat(24)}', 'g', 'MIDDLE', 'CONSENSUS', 'spread', 'OBSERVED', 'x', now())`, { role: 'service_role' });
  chk('refused: a line kind other than OPEN / CLOSE', failsWith(err, /cfb_lab_line_kind/), err && err.slice(0, 200));

  /* quotes written around the function */
  err = mustFail(`insert into public.cfb_lab_market_quotes (quote_id, game_id, source, book, market_type, home_line, observed_at, kickoff_ts, fingerprint)
    values ('cfbq_${'1'.repeat(24)}', 'g', 'espn', 'espnbet', 'spread', -3, '2025-10-04T19:30:00Z', '2025-10-04T19:30:00Z', 'x')`, { role: 'service_role' });
  chk('refused: a pregame quote observed at kickoff, written directly', failsWith(err, /cfb_lab_quote_pregame_before_kickoff/), err && err.slice(0, 200));
  err = mustFail(`insert into public.cfb_lab_market_quotes (quote_id, game_id, source, book, market_type, home_line, observed_at, fingerprint, is_provider_close, is_pregame)
    values ('cfbq_${'2'.repeat(24)}', 'g', 'espn', 'espnbet', 'spread', -3, '2025-10-04T20:30:00Z', 'x', true, true)`, { role: 'service_role' });
  chk('refused: a provider close that claims to be pregame, written directly', failsWith(err, /cfb_lab_quote_pregame_flag/), err && err.slice(0, 200));

  /* ------------------------------------------------------ append-only, all 13 */
  for (const t of TABLES) {
    const n = Number(psql(`select count(*) from public.${t}`));
    chk(t + ' has rows to attack', n > 0, n);
    err = mustFail(`update public.${t} set recorded_at = recorded_at`);
    chk(t + ': UPDATE is refused, even for the owner', failsWith(err, /append-only: rows are never updated/), err && err.slice(0, 160));
    err = mustFail(`delete from public.${t}`);
    chk(t + ': DELETE is refused, even for the owner', failsWith(err, /append-only: rows are never deleted/), err && err.slice(0, 160));
    err = mustFail(`truncate public.${t}`);
    chk(t + ': TRUNCATE is refused, even for the owner', failsWith(err, /append-only: it is never truncated/), err && err.slice(0, 160));
    err = mustFail(`update public.${t} set recorded_at = recorded_at`, { role: 'service_role' });
    chk(t + ': the service role cannot UPDATE', failsWith(err, /permission denied|append-only/), err && err.slice(0, 160));
    err = mustFail(`delete from public.${t}`, { role: 'service_role' });
    chk(t + ': the service role cannot DELETE', failsWith(err, /permission denied|append-only/), err && err.slice(0, 160));
    chk(t + ': the row count did not move', Number(psql(`select count(*) from public.${t}`)) === n);

    err = mustFail(`select count(*) from public.${t}`, { role: 'anon' });
    chk(t + ': anon cannot read it', failsWith(err, /permission denied/), err && err.slice(0, 160));
    let out = null;
    try { out = psql(`select count(*) from public.${t}`, { role: 'authenticated' }); } catch (e) { out = String(e.stderr || e.message); }
    chk(t + ': a signed-in reader can read it', out === String(n), out);
    err = mustFail(`insert into public.${t} default values`, { role: 'authenticated' });
    chk(t + ': a signed-in reader cannot insert', failsWith(err, /permission denied/), err && err.slice(0, 160));
  }
  for (const v of ['cfb_lab_current_roles', 'cfb_lab_official_predictions', 'cfb_lab_current_results', 'cfb_lab_current_evaluations', 'cfb_lab_consensus_now']) {
    err = mustFail(`select count(*) from public.${v}`, { role: 'anon' });
    chk(v + ': anon cannot read it', failsWith(err, /permission denied/), err && err.slice(0, 160));
    chk(v + ': a signed-in reader can', mustFail(`select count(*) from public.${v}`, { role: 'authenticated' }) === null);
  }
  chk('anon cannot call the quote writer', failsWith(mustFail(`select public.cfb_lab_ingest_quotes('[]'::jsonb)`, { role: 'anon' }), /permission denied/));
  chk('nor can a signed-in reader', failsWith(mustFail(`select public.cfb_lab_ingest_quotes('[]'::jsonb)`, { role: 'authenticated' }), /permission denied/));
  chk('nor derive lines', failsWith(mustFail(`select public.cfb_lab_derive_lines(now())`, { role: 'authenticated' }), /permission denied/));
  const cn = qj(`select json_agg(to_jsonb(c)) from public.cfb_lab_consensus_now c where c.game_id = '${FIX.line_cases[0].game_id}' and c.market_type = 'spread'`, { role: 'authenticated' });
  chk('consensus_now: the latest quote per source/book and the median home line, provider averages left out',
    cn && cn.length === 1 && Number(cn[0].median_home_line) === -4.25 && cn[0].n_books === 4, cn);

  /* ------------------------------------------------------------------ cron */
  const c1 = psql(CRON);
  chk('cfb_lab_cron.sql applies on a server without pg_cron or pg_net, and says it skipped', /pg_cron\|CHECK THIS\|not available here: skipped/.test(c1)
    && /pg_net\|CHECK THIS\|not available here: skipped/.test(c1) && /job cfb_lab_hourly\|CHECK THIS\|skipped/.test(c1)
    && /supabase\/cfb_lab\.sql is applied\|ok/.test(c1), c1);
  chk('and a second time', /skipped/.test(psql(CRON)));
  const pk = qj(`select public.cfb_lab_poke('hourly')`);
  chk('the poke reports a missing token instead of succeeding', pk.ok === false && pk.action === 'no_token', pk);
  chk('no client role may call the poke', failsWith(mustFail(`select public.cfb_lab_poke('hourly')`, { role: 'anon' }), /permission denied/)
    && failsWith(mustFail(`select public.cfb_lab_poke('hourly')`, { role: 'authenticated' }), /permission denied/));

  psql(`create database cfb_bare`, { command: true });
  err = mustFail(CRON, { db: 'cfb_bare' });
  chk('cfb_lab_cron.sql refuses to run before cfb_lab.sql', failsWith(err, /needs supabase\/cfb_lab\.sql first/), err && err.slice(0, 200));

  psql(`create database cfb_stub`, { command: true });
  psql(SHIM, { db: 'cfb_stub' });
  psql(SQL, { db: 'cfb_stub' });
  psql(`create schema cron;
    create table cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text, active boolean not null default true);
    create function cron.schedule(p_name text, p_schedule text, p_command text) returns bigint language sql as $f$
      insert into cron.job (jobname, schedule, command) values (p_name, p_schedule, p_command)
      on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid $f$;
    create function cron.unschedule(p_name text) returns boolean language sql as $f$ delete from cron.job where jobname = p_name returning true $f$;
    create schema net;
    create table net.calls (id bigserial primary key, url text, body jsonb, params jsonb, headers jsonb, timeout_ms int);
    create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000)
      returns bigint language sql as $f$ insert into net.calls (url, body, params, headers, timeout_ms) values (url, body, params, headers, timeout_milliseconds) returning id $f$;
    insert into cron.job (jobname, schedule, command) values ('cfb_lab_lines', '*/15 * * * *', 'select public.cfb_lab_derive_lines(now());');`, { db: 'cfb_stub' });
  psql(CRON, { db: 'cfb_stub' });
  const c2 = psql(CRON, { db: 'cfb_stub' });
  chk('with pg_cron and pg_net present, the hourly poke is scheduled and no lines job is (report ok)', /job cfb_lab_hourly\|ok\|schedule 7 \* \* \* \*, active/.test(c2)
    && /no database-side lines job \(cfb_lab_lines\): lines come from the ledger mirror\|ok\|not scheduled/.test(c2) && /pg_cron\|ok/.test(c2) && /pg_net\|ok/.test(c2), c2);
  const jobs = qj(`select json_agg(json_build_object('n', jobname, 's', schedule, 'c', command) order by jobname) from cron.job`, { db: 'cfb_stub' });
  chk('an earlier install\'s cfb_lab_lines job is removed, and re-running keeps exactly one hourly job', jobs.length === 1
    && jobs[0].n === 'cfb_lab_hourly' && jobs[0].s === '7 * * * *' && jobs[0].c === "select public.cfb_lab_poke('hourly');", jobs);
  const pk2 = qj(`set edgedesk.gh_token = 'ghp_test_token'; select public.cfb_lab_poke('hourly');`, { db: 'cfb_stub' });
  const call = qj(`select to_jsonb(c) from net.calls c order by id desc limit 1`, { db: 'cfb_stub' });
  chk('with a token the poke dispatches cfb-lab.yml on main with mode=hourly', pk2.ok === true && pk2.action === 'dispatched'
    && call.url === 'https://api.github.com/repos/dsrackler17/EdgeDeskSports/actions/workflows/cfb-lab.yml/dispatches'
    && JSON.stringify(call.body) === JSON.stringify({ ref: 'main', inputs: { mode: 'hourly' } })
    && call.headers.authorization === 'Bearer ghp_test_token' && call.headers.accept === 'application/vnd.github+json', { pk2, call });
  chk('cfb_lab_derive_lines is still there to run by hand', qj(`select public.cfb_lab_derive_lines(now())`, { db: 'cfb_stub' }).games === 0);
} catch (e) {
  chk('the live layer ran without an unexpected error', false, String(e.stderr || e.message).slice(0, 600));
} finally {
  if (started) { try { run(`${BIN}/pg_ctl -D ${DATA} -m immediate stop`); } catch (_) { /* going away */ } }
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) { /* ditto */ }
}
done();
