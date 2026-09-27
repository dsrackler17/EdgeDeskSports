#!/usr/bin/env node
/* ============================================================================
   CFB production — load, latency, index and storage measurement on the REAL
   schema (the CFB contracts + cfb_production.sql) in a throwaway PostgreSQL,
   filled to one full season of synthetic volume shaped like the real ledgers
   (docs/cfb-production/OPERATIONS.md §2-4).

     VOLUME (one season, 20 weeks x 65 FBS games):
       cfb_lab_market_quotes    8 books x 30 kept changes x 65 games x 20 weeks = 312 000 spread quotes
       cfb_decision_snapshots   2 engines x 8 books x 30 quotes x 65 x 20      = 624 000
       cfb_lab_predictions      the real committed ledger, copied to 20 weeks
       cfb_team_week_state      136 teams x 20 weeks x 5 seasons
       cfb_weekly_projections   65 games x 20 weeks x 5 input changes x 5 seasons
     READ PATHS timed (30 runs each; p50 / p95 ms) at rest and while a writer
     mirrors 40 000 decision rows and the lab ingests quotes, with 6 other
     readers running; EXPLAIN (ANALYZE, BUFFERS) of each; bytes per row and the
     projected season / 5-season size of every large table.

     node football/cfb_production/perf.js [--write]   (writes reports/perf.json)
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require('../../tools/personal/_pg.js');
const PR = require('./pgrest.js');

const REPO = path.resolve(__dirname, '..', '..');
const SQL = (f) => path.join(REPO, 'supabase', f + '.sql');

const READS = {
  health: "select count(*) from public.cfb_health('2025-11-15T12:00:00Z')",
  weekly_projections_week: 'select * from public.cfb_weekly_projections_published where season = 2025 and week = 12',
  team_state_week: 'select * from public.cfb_team_week_state_published where season = 2025 and week = 11',
  quotes_latest_per_book: "select distinct on (book) * from public.cfb_lab_market_quotes where game_id = 'g777' and market_type = 'spread' order by book, observed_at desc",
  lab_game_quotes_fn: "select count(*) from public.cfb_lab_game_quotes('g777')",
  decisions_game: "select * from public.cfb_decision_snapshots where game_id = 'g777' order by decided_at desc limit 50",
  decisions_week_summary: 'select status, count(*) from public.cfb_decision_snapshots where season = 2025 and week = 12 group by status',
  lab_predictions_week: 'select * from public.cfb_lab_predictions where season = 2025 and week = 12',
  odds_newest: "select max(observed_at) from public.cfb_lab_market_quotes where source = 'odds_api' and observed_at <= '2025-11-15T12:00:00Z'",
};

function timeQueries(db, reps, label) {
  const out = {};
  for (const [k, q] of Object.entries(READS)) {
    /* every row fetched (FOR ... IN EXECUTE), so the planner cannot skip the work a reader pays for */
    const r = db.sql(`do $t$ declare t0 timestamptz; i int; rec record; begin
      create temp table if not exists perf_t (k text, ms float8);
      for i in 1..${reps} loop t0 := clock_timestamp(); for rec in execute ${PG.lit(q)} loop null; end loop; insert into perf_t values ('${k}', extract(epoch from clock_timestamp() - t0) * 1000); end loop; end $t$;
      select round(percentile_cont(0.5) within group (order by ms)::numeric, 2) || '|' || round(percentile_cont(0.95) within group (order by ms)::numeric, 2) || '|' || round(max(ms)::numeric, 2) from perf_t where k = '${k}';`);
    const [p50, p95, max] = r.split('\n').pop().split('|').map(Number);
    out[k] = { p50_ms: p50, p95_ms: p95, max_ms: max };
  }
  return { label, reps, queries: out };
}

function explain(db) {
  const out = {};
  for (const [k, q] of Object.entries(READS)) {
    const j = JSON.parse(db.sql('explain (analyze, buffers, format json) ' + q).split('\n').join(''));
    const scans = [];
    (function walk(n) { if (/Scan/.test(n['Node Type'])) scans.push(n['Node Type'] + (n['Relation Name'] ? ' ' + n['Relation Name'] : '') + (n['Index Name'] ? ' (' + n['Index Name'] + ')' : '') + ' rows=' + n['Actual Rows']); (n.Plans || []).forEach(walk); })(j[0].Plan);
    out[k] = { execution_ms: j[0]['Execution Time'], scans };
  }
  return out;
}

async function main() {
  const db = PG.start('cfbperf');
  if (!db || db.skip) return { skipped: (db && db.skip) || 'no postgres' };
  const rep = { generated_at: new Date().toISOString(), server: null, volume: {}, at_rest: null, under_load: null, explain: null, storage: {} };
  try {
    ['cfb_lab', 'cfb_weekly', 'cfb_personnel', 'cfb_decision', 'cfb_production'].forEach((f) => db.applyFile(SQL(f)));
    rep.server = db.sql("select current_setting('server_version')");
    /* the real Model Lab ledger through the real mirror, then copied across a season */
    process.env.SB_URL = 'http://pgrest.test'; process.env.SB_SERVICE_ROLE = 'k';
    await require('../cfb_lab/sync_supabase.js').sync(2026, { fetch: PR.makeFetch(db), quiet: true, log: require('./log.js').logger({ job: 'perf' }, { sink: () => {} }) });
    db.sql(`insert into public.cfb_lab_predictions
      select (jsonb_populate_record(null::public.cfb_lab_predictions, to_jsonb(p) || jsonb_build_object(
        'prediction_id', 'cfbp_' || lpad(to_hex(n * 100000 + rn), 24, '0'), 'game_id', p.game_id || '_' || n, 'season', 2025, 'week', 1 + (n % 20),
        'kickoff_ts', p.kickoff_ts - make_interval(days => 7 * n + 365), 'prediction_ts', p.prediction_ts - make_interval(days => 7 * n + 365)))).*
        from (select p.*, row_number() over () rn from public.cfb_lab_predictions p where p.origin = 'LIVE' and p.season = 2026) p, generate_series(1, 19) n;`);
    db.sql(`insert into public.cfb_lab_market_quotes (quote_id, game_id, season, week, source, book, market_type, home_line, price_home, price_away, observed_at, kickoff_ts, fingerprint, retrieved_at)
      select 'cfbq_' || lpad(to_hex(g), 24, '0'), 'g' || (g % 1300), 2025, 1 + (g % 1300) / 65, 'odds_api', 'book' || ((g / 1300) % 8), 'spread', -3.5 + (g % 7), -110, -110,
             k - make_interval(mins => 30 + (g / 10400) * 60), k, md5(g::text), k - make_interval(mins => 29 + (g / 10400) * 60)  -- book = (g/1300)%8, change = g/10400
        from generate_series(1, 312000) g, lateral (select timestamptz '2025-08-30 19:30+00' + make_interval(days => 7 * ((g % 1300) / 65)) as k) kk;`);
    db.sql(`insert into public.cfb_decision_snapshots (decision_id, game_id, season, week, book, decided_at, observed_at, kickoff_ts, engine_version, engine_role, policy_version, artifact_version,
             model_version, status, timing, reason_codes, payload)
      select 'cfbd_' || g, 'g' || (g % 1300), 2025, 1 + (g % 1300) / 65, 'book' || ((g / 1300) % 8), k - make_interval(mins => 20 + (g / 20800) * 60), k - make_interval(mins => 21 + (g / 20800) * 60), k,
             case when (g / 10400) % 2 = 0 then 'cfb_decision_engine_v1' else 'cfb_decision_engine_v1_challenger' end, case when (g / 10400) % 2 = 0 then 'CURRENT' else 'CHALLENGER' end,
             'cfb_decision_policy_v1', 'cfb_decision_calibration_v1', 'edgedesk_cfb_v2.1.0', case when g % 11 = 0 then 'LEAN' else 'PASS' end, 'NONE', '{NO_BET_BETTING_DISABLED}', '{}'
        from generate_series(0, 623999) g, lateral (select timestamptz '2025-08-30 19:30+00' + make_interval(days => 7 * ((g % 1300) / 65)) as k) kk;`);
    db.sql(`insert into public.cfb_pipeline_runs (run_id, run_key, season, source_week, target_week, mode, started_at, model_version, feature_version, status, published, payload)
      select 'cfbw_' || lpad(to_hex(s * 100 + w), 24, '0'), 'k', s, w - 1, w, 'weekly', make_timestamptz(s, 9, 1, 10, 5, 0) + make_interval(days => 7 * w), 'edgedesk_cfb_v2.1.0', 'cfb_v2_fv2', 'PUBLISHED', true, '{}'
        from generate_series(2021, 2025) s, generate_series(1, 20) w;
      insert into public.cfb_team_week_state (state_id, team_id, season, week, feature_version, model_version, as_of, overall_mean, overall_sd, state_version, run_id, payload)
      select 'cfbs_' || lpad(to_hex(s * 100000 + w * 1000 + t), 24, '0'), t::text, s, w, 'cfb_v2_fv2', 'edgedesk_cfb_v2.1.0', make_timestamptz(s, 9, 1, 12, 0, 0) + make_interval(days => 7 * w), t % 30 - 15, 3, 1,
             'cfbw_' || lpad(to_hex(s * 100 + w), 24, '0'), '{}'
        from generate_series(2021, 2025) s, generate_series(1, 20) w, generate_series(1, 136) t;
      insert into public.cfb_weekly_projections (projection_id, game_id, season, week, prediction_ts, model_version, feature_version, feature_snapshot_id, input_hash, ens_pred, sigma, p_home_raw, model_mode, run_id, payload)
      select 'cfbj_' || lpad(to_hex(s * 1000000 + w * 10000 + g * 10 + c), 24, '0'), s || '_' || w || '_' || g, s, w, make_timestamptz(s, 9, 1, 12, 0, 0) + make_interval(days => 7 * w, hours => c),
             'edgedesk_cfb_v2.1.0', 'cfb_v2_fv2', 'cfbf_' || lpad(to_hex(s * 1000000 + w * 10000 + g * 10 + c), 24, '0'), 'h' || c, g % 20 - 10, 15.9, 0.5, 'FULL', 'cfbw_' || lpad(to_hex(s * 100 + w), 24, '0'), '{}'
        from generate_series(2021, 2025) s, generate_series(1, 20) w, generate_series(1, 65) g, generate_series(1, 5) c;
      analyze;`);
    for (const t of ['cfb_lab_predictions', 'cfb_lab_market_quotes', 'cfb_decision_snapshots', 'cfb_team_week_state', 'cfb_weekly_projections'])
      rep.volume[t] = +db.sql('select count(*) from public.' + t);
    rep.at_rest = timeQueries(db, 30, 'at rest');
    rep.explain = explain(db);
    /* under load: a writer mirroring decision rows in 2 000-row chunks + lab quote ingestion, and 6 other readers */
    const writer = db.background(`do $w$ declare i int; begin for i in 1..20 loop
        insert into public.cfb_decision_snapshots (decision_id, game_id, season, week, book, decided_at, kickoff_ts, engine_version, engine_role, model_version, status, timing, reason_codes, payload)
        select 'load_' || i || '_' || g, 'h' || i || '_' || g, 2025, 12, 'b', now() - interval '1 hour', now() + interval '1 day', 'e', 'CURRENT', 'm', 'PASS', 'NONE', '{X}', '{}' from generate_series(1, 2000) g;
        perform public.cfb_lab_ingest_quotes(jsonb_build_array(jsonb_build_object('source','odds_api','book','loadbook','game_id','g1','market_type','spread','home_line', -3.5 - (i % 3),
          'price_home',-110,'price_away',-110,'observed_at', now() - make_interval(mins => 100 - i),'kickoff_ts', now() + interval '2 days','season',2025,'week',12)));
      end loop; end $w$;`);
    const readers = [0, 1, 2, 3, 4, 5].map(() => db.background(`do $r$ declare i int; rec record; begin for i in 1..40 loop
        for rec in execute ${PG.lit(READS.decisions_week_summary)} loop null; end loop; for rec in execute ${PG.lit(READS.quotes_latest_per_book)} loop null; end loop; end loop; end $r$;`));
    rep.under_load = timeQueries(db, 30, 'while a writer mirrors 40 000 rows and 6 other readers run');
    const w = writer.wait(180000);
    rep.under_load.writer_output = w.out.slice(0, 300);
    rep.under_load.rows_written = +db.sql("select count(*) from public.cfb_decision_snapshots where decision_id like 'load_%'");
    readers.forEach((r) => r.wait(120000));
    rep.under_load.writer_exit = w.code;
    /* storage: bytes per row and projections */
    for (const t of ['cfb_lab_predictions', 'cfb_lab_market_quotes', 'cfb_decision_snapshots', 'cfb_team_week_state', 'cfb_weekly_projections', 'cfb_audit_log', 'cfb_job_heartbeats', 'cfb_incidents']) {
      const [bytes, rows] = db.sql(`select pg_total_relation_size('public.${t}') || '|' || (select count(*) from public.${t})`).split('|').map(Number);
      rep.storage[t] = { rows, total_bytes: bytes, bytes_per_row: rows ? Math.round(bytes / rows) : null };
    }
  } finally { db.stop(); }
  return rep;
}

module.exports = { READS, main };

if (require.main === module) {
  main().then((rep) => {
    if (process.argv.includes('--write')) fs.writeFileSync(path.join(__dirname, 'reports', 'perf.json'), JSON.stringify(rep, null, 1) + '\n');
    console.log(JSON.stringify({ volume: rep.volume, at_rest: rep.at_rest && rep.at_rest.queries, under_load: rep.under_load && rep.under_load.queries }, null, 1));
    Object.entries(rep.explain || {}).forEach(([k, v]) => console.log(k.padEnd(26) + String(v.execution_ms).padStart(9) + ' ms  ' + v.scans.join('; ')));
    Object.entries(rep.storage || {}).forEach(([k, v]) => console.log(k.padEnd(26) + ' rows ' + v.rows + '  ' + v.bytes_per_row + ' B/row  total ' + Math.round(v.total_bytes / 1048576) + ' MB'));
  }).catch((e) => { console.error(e.stack || e.message); process.exit(1); });
}
