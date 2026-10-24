#!/usr/bin/env node
/* ===========================================================================
   The Signal Center worker end to end: tools/signal_center/run.js against the
   real migration (supabase/signal_center.sql) and the real Simulator schema
   (supabase/simulator.sql) on PostgreSQL, through the PostgREST stand-in the
   billing suites use (tools/billing/_pgrest.js), over the COMMITTED sources.

     node tools/signal_center/worker.test.js     (SC_SQL_REQUIRED=1 in CI)

     run          a live run completes: signals stored, live sports published, the
                  others in shadow; a simulator shift between two published runs
                  is found, verified by the server, and links to the Simulator
     graphics     every due version gets three graphics drawn from its stored
                  payload (the hashes agree); none fails its checks
     dna          Model DNA is stored; notices reach the subscriber who asked
     idempotent   a second run stores nothing new and draws nothing new
     lease        a run that finds the lease held exits without writing
     outages      a missing layer (NBA injuries, Kalshi) is a recorded note, not a
                  failed run; a 503 is retried; a persistent failure fails the run,
                  is recorded, and the next run recovers
     invalidation a source record that vanishes withdraws its signal, history kept
     undeployed   a database without the migration fails with what to do, not a stack
     secrets      the service key never appears in an error
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const PG = require(path.join(ROOT, 'tools', 'personal', '_pg.js'));
const REST = require(path.join(ROOT, 'tools', 'billing', '_pgrest.js'));
const DB = require('./db.js');
const RUN = require('./run.js');
const T = PG.kit('signal center worker');
const chk = T.chk;
const lit = PG.lit;
const F = (n) => path.join(ROOT, 'supabase', n);
const NOW = Date.parse('2026-10-23T20:30:00Z');

(async () => {
  const db = await PG.start('scworker');
  if (db.skip) {
    if (process.env.SC_SQL_REQUIRED === '1') { console.log('FAIL | PostgreSQL is required here: ' + db.skip); process.exit(1); }
    console.log('NOTE | ' + db.skip + ' — the worker suite did not run'); process.exit(T.done());
  }
  const SUB = '11111111-1111-4111-8111-111111111111', NOSUB = '22222222-2222-4222-8222-222222222222';
  const quiet = console.log;
  try {
    const BH = fs.readFileSync(F('billing_hardening.sql'), 'utf8'), PR = fs.readFileSync(F('personal_research.sql'), 'utf8');
    const slice = (src, a, b) => { const i = src.indexOf(a); return src.slice(i, src.indexOf(b, i) + b.length); };
    db.sql(`create table public.subscriptions (user_id uuid, status text, price_id text, current_period_end timestamptz);
      ${slice(BH, 'create or replace function public.billing_row_grants_access(', '$$;')}
      create or replace function public.community_is_entitled(p_user uuid) returns boolean language sql stable security definer set search_path = public, pg_temp as $b$
        select exists (select 1 from public.subscriptions s where s.user_id = p_user and public.billing_row_grants_access(s.status, s.price_id, s.current_period_end, now())); $b$;
      ${slice(PR, 'create or replace function public.edp_copy_ok(p text)', '$$;')}
      ${slice(PR, 'create table if not exists public.user_alerts (', 'grant select on public.user_alerts to authenticated;')}
      insert into auth.users (id, email) values (${lit(SUB)}, 'sub@x'), (${lit(NOSUB)}, 'free@x');
      insert into public.subscriptions values (${lit(SUB)}, 'active', 'price_x', now() + interval '20 days');`);
    /* pgcrypto where Supabase keeps it, outside the doors' search_path */
    db.sql('drop extension if exists pgcrypto; create schema if not exists extensions; create extension pgcrypto with schema extensions;');
    db.applyFile(F('simulator.sql'));
    const out = db.applyFile(F('signal_center.sql'));
    chk('both migrations apply', !/CHECK THIS/.test(out), out.slice(-400));

    /* two published NFL simulator runs, written the way the Simulator writes them:
       results while running, then completed, then the pointer */
    const h = (c) => c.repeat(64);
    const R1 = 'aaaaaaaa-1111-4111-8111-000000000001', R2 = 'aaaaaaaa-1111-4111-8111-000000000002', N = 100000;
    const res = (run, team, name, outcome, count) => `(${lit(run)}, ${lit(team)}, ${lit(name)}, '{}'::jsonb, ${lit(outcome)}, 'playoffs', true, ${count}, ${N}, ${count}::float8 / ${N}, sqrt((${count}::float8 / ${N}) * (1 - ${count}::float8 / ${N}) / ${N}),
       greatest(0, ${count}::float8 / ${N} - 0.01), least(1, ${count}::float8 / ${N} + 0.01), 'wilson_95', ${N}::float8 / ${count}, 'Research')`;
    db.sql(`insert into public.sim_runs (run_id, sport, competition, season, idempotency_key, seed, prng_version, n_sims, model_version, engine_version, rules_version, config_hash, input_snapshot_at, input_ref, input_hash, status, started_at)
      values (${lit(R1)}, 'nfl', 'NFL', '2026', ${lit(h('1'))}, '1', 'pcg', ${N}, 'edgedesk_nfl_v2.1.0', 'sim/0.1', 'nfl_2026', ${lit(h('c'))}, '2026-10-20T10:00:00Z', 'snap1', ${lit(h('a'))}, 'running', now()),
             (${lit(R2)}, 'nfl', 'NFL', '2026', ${lit(h('2'))}, '2', 'pcg', ${N}, 'edgedesk_nfl_v2.1.0', 'sim/0.1', 'nfl_2026', ${lit(h('c'))}, '2026-10-23T10:00:00Z', 'snap2', ${lit(h('b'))}, 'running', now());
      insert into public.sim_team_results (run_id, entity_id, entity_name, entity_groups, outcome, category, applicable, outcome_count, n_sims, probability, mcse, wilson_lo, wilson_hi, interval_method, fair_decimal, provenance) values
        ${res(R1, 'KC', 'Kansas City Chiefs', 'make_playoffs', 71000)}, ${res(R2, 'KC', 'Kansas City Chiefs', 'make_playoffs', 58000)},
        ${res(R1, 'DET', 'Detroit Lions', 'make_playoffs', 55200)}, ${res(R2, 'DET', 'Detroit Lions', 'make_playoffs', 62800)},
        ${res(R1, 'BUF', 'Buffalo Bills', 'make_playoffs', 80000)}, ${res(R2, 'BUF', 'Buffalo Bills', 'make_playoffs', 80300)};
      update public.sim_runs set status = 'completed', completed_at = '2026-10-20T11:00:00Z', finished_at = '2026-10-20T11:00:00Z' where run_id = ${lit(R1)};
      update public.sim_runs set status = 'completed', completed_at = '2026-10-23T11:00:00Z', finished_at = '2026-10-23T11:00:00Z' where run_id = ${lit(R2)};
      insert into public.sim_published (sport, competition, season, run_id, input_snapshot_at, published_at, previous_run_id) values ('nfl', 'NFL', '2026', ${lit(R2)}, '2026-10-23T10:00:00Z', '2026-10-23T11:05:00Z', ${lit(R1)});
      update public.sc_config set value = '"live"' where key = 'mode';
      insert into public.sc_preferences (user_id, sports, min_label, notify) values (${lit(SUB)}, '{nfl,cfb}', 'Routine', true), (${lit(NOSUB)}, '{}', 'Monitor', true);`);

    const stand = REST.make(db, { serviceKey: 'service-key-xyz' });
    const client = () => DB.client({ SB_URL: 'http://standin', SB_SERVICE_ROLE: 'service-key-xyz' }, { fetchImpl: stand.fetch, sleep: async () => {} });
    const inputs = RUN.committedInputs(ROOT, NOW);
    const opts = { sha: 'abcdef0', resolver: RUN.teamStyleResolver(ROOT) };
    const q = (sql) => db.sql(sql).trim();

    /* ---- the first run ---- */
    console.log = () => {};
    let r1;
    try { r1 = await RUN.liveRun(client(), inputs, Object.assign({ idem: 'run-1' }, opts)); } finally { console.log = quiet; }
    chk('the first run completes', r1 && r1.counts && q("select count(*) from public.sc_runs where status = 'completed';") === '1', r1 && r1.counts);
    chk('it stores signals', r1.counts.inserted > 20, r1.counts);
    chk('live sports publish, others stay in shadow', +q("select count(*) from public.sc_signals where publication = 'PUBLISHED';") > 0 && +q("select count(*) from public.sc_signals where publication = 'PUBLISHED' and sport not in ('nfl','cfb');") === 0);
    chk('every published signal is VERIFIED and not a fixture', q("select count(*) from public.sc_signals where publication = 'PUBLISHED' and (verification_state <> 'VERIFIED' or fixture);") === '0');
    const sims = JSON.parse(q("select coalesce(json_agg(json_build_object('subject', subject_label, 'change', change_pp, 'v', verification_state, 'href', v.payload->'links'->>'simulator')), '[]') from public.sc_signals s join public.sc_signal_versions v on v.version_id = s.current_version_id where s.category = 'SIMULATION_SHIFT';"));
    chk('two simulator shifts (Chiefs −13.0, Lions +7.6); the Bills’ 0.3 pp is not one', sims.length === 2 && sims.some((s) => s.subject === 'Kansas City Chiefs' && +s.change === -13) && sims.some((s) => s.subject === 'Detroit Lions' && +s.change === 7.6), sims);
    chk('…both verified by the server against the published rows, linking to the Simulator', sims.every((s) => s.v === 'VERIFIED' && s.href === '#simulator/nfl') && +q("select count(*) from public.sc_signal_events where kind = 'server_check' and (detail->>'ok')::boolean;") === 2);
    const gStats = JSON.parse(q("select json_build_object('ready', count(*) filter (where status = 'READY'), 'failed', count(*) filter (where status = 'FAILED'), 'mismatch', count(*) filter (where g.payload_sha256 <> v.payload_sha256)) from public.sc_graphics g join public.sc_signal_versions v using (version_id);"));
    chk('graphics: drawn for the due versions, three formats each, from the exact stored payload', gStats.ready > 0 && gStats.ready % 3 === 0 && gStats.mismatch === 0, gStats);
    chk('graphics: none failed its checks', gStats.failed === 0, gStats);
    chk('graphics: only at or above the graphics label', q("select count(*) from public.sc_graphics g join public.sc_signals s using (signal_id) where public.sc_label_rank(s.label) < public.sc_label_rank('Notable');") === '0');
    chk('Model DNA records are stored', +q('select count(*) from public.sc_model_dna;') >= 5);
    chk('the subscriber who asked has notices', +q("select count(*) from public.user_alerts where user_id = " + lit(SUB) + " and payload->>'source' = 'signal_center';") > 0);
    chk('the non-subscriber has none', q("select count(*) from public.user_alerts where user_id = " + lit(NOSUB) + ';') === '0');
    chk('missing layers are recorded notes, not a failed run', +q("select count(*) from public.sc_failures where stage = 'source';") >= 2 && q("select count(*) from public.sc_runs where status = 'failed';") === '0');
    chk('the run counted its database requests under the budget', r1.counts.requests > 5 && r1.counts.requests < DB.MAX_REQUESTS, r1.counts.requests);

    /* ---- the second run: nothing new ---- */
    console.log = () => {};
    let r2;
    try { r2 = await RUN.liveRun(client(), inputs, Object.assign({ idem: 'run-2' }, opts)); } finally { console.log = quiet; }
    chk('a second run over the same sources stores nothing new', r2.counts.inserted === 0 && r2.counts.versioned === 0, r2.counts);
    chk('…and draws nothing new', r2.counts.graphics.generated === 0, r2.counts.graphics);
    chk('…and sends no second notice', r2.counts.notices.sent === 0, r2.counts.notices);

    /* ---- the lease ---- */
    db.sql("insert into public.sc_runs (mode, engine_version, spec_version) values ('live', 'x', 'y');");
    console.log = () => {};
    let r3;
    try { r3 = await RUN.liveRun(client(), inputs, Object.assign({ idem: 'run-3' }, opts)); } finally { console.log = quiet; }
    chk('a run that finds the lease held exits without writing', r3.busy === true);
    db.sql("update public.sc_runs set status = 'failed', finished_at = now(), error = '{}'::jsonb where status = 'running';");

    /* ---- outages ---- */
    stand.fail('rpc/sc_ingest', 2);
    console.log = () => {};
    let r4;
    try { r4 = await RUN.liveRun(client(), inputs, Object.assign({ idem: 'run-4' }, opts)); } finally { console.log = quiet; }
    chk('two 503s from the database are retried and the run completes', r4 && r4.counts && q("select status from public.sc_runs where idempotency_key = 'run-4';") === 'completed');
    stand.fail('rpc/sc_graphics_due', 10);
    console.log = () => {}; console.error = () => {};
    let threw = null;
    try { await RUN.liveRun(client(), inputs, Object.assign({ idem: 'run-5' }, opts)); } catch (e) { threw = e; } finally { console.log = quiet; console.error = quiet; }
    chk('a persistent failure fails the run with a reason', threw && q("select status from public.sc_runs where idempotency_key = 'run-5';") === 'failed' && +q("select count(*) from public.sc_failures where stage = 'run';") === 1);
    stand.fail('rpc/sc_graphics_due', 0);
    console.log = () => {};
    let r6;
    try { r6 = await RUN.liveRun(client(), inputs, Object.assign({ idem: 'run-6' }, opts)); } finally { console.log = quiet; }
    chk('the next run recovers', r6 && q("select status from public.sc_runs where idempotency_key = 'run-6';") === 'completed');

    /* ---- invalidation: a source record vanishes ---- */
    const active = JSON.parse(q("select coalesce(json_agg(x), '[]') from (select json_build_object('key', s.signal_key, 'ev', v.payload->'event'->>'key', 'cur', v.payload->'values'->'current'->>'snapshot_id') x from public.sc_signals s join public.sc_signal_versions v on v.version_id = s.current_version_id where s.category = 'FORECAST_SHIFT' and s.lifecycle = 'ACTIVE' and s.verification_state = 'VERIFIED' order by s.signal_id limit 1) z;"));
    chk('there is an active forecast signal to test with', active.length === 1, active);
    if (active.length) {
      const drop = (g) => g.game.event_key === active[0].ev ? { game: g.game, series: g.series.filter((r) => r.snapshot_id !== active[0].cur) } : g;
      const tampered = Object.assign({}, inputs, { football: inputs.football.map(drop), perfGames: inputs.perfGames.map(drop) });
      console.log = () => {};
      try { await RUN.liveRun(client(), tampered, Object.assign({ idem: 'run-7' }, opts)); } finally { console.log = quiet; }
      chk('a vanished source record withdraws its signal', q('select publication || \',\' || lifecycle || \',\' || verification_state from public.sc_signals where signal_key = ' + lit(active[0].key) + ';') === 'WITHDRAWN,WITHDRAWN,INVALIDATED');
      chk('…keeping every earlier version', +q('select count(*) from public.sc_signal_versions v join public.sc_signals s using (signal_id) where s.signal_key = ' + lit(active[0].key) + ';') >= 2);
    }

    /* ---- a database without the migration: one clear sentence, nothing written ---- */
    const bare = DB.client({ SB_URL: 'http://standin', SB_SERVICE_ROLE: 'service-key-xyz' }, { fetchImpl: async () => ({ ok: false, status: 404,
      text: async () => '{"code":"PGRST202","message":"Could not find the function public.sc_begin_run(p) in the schema cache"}' }), sleep: async () => {} });
    let nd = null;
    console.log = () => {};
    try { await RUN.liveRun(bare, inputs, Object.assign({ idem: 'run-nd' }, opts)); } catch (e) { nd = e; } finally { console.log = quiet; }
    chk('a database without the migration fails the run with what to do, and says nothing was written', nd && nd.notDeployed === true
      && /not deployed here/.test(nd.message) && /nothing was written/.test(nd.message) && /Deploy Signal Center schema/.test(nd.message), nd && nd.message);

    /* ---- the key never leaks ---- */
    const leaky = DB.client({ SB_URL: 'http://standin', SB_SERVICE_ROLE: 'super-secret-key-123' }, { fetchImpl: async () => ({ ok: false, status: 400, text: async () => 'bad request near super-secret-key-123' }), sleep: async () => {} });
    let msg = '';
    try { await leaky.rpc('sc_status', {}); } catch (e) { msg = e.message; }
    chk('the service key is scrubbed from every error', msg && msg.indexOf('super-secret-key-123') < 0 && /\[redacted\]/.test(msg), msg);
    chk('the worker refuses to call a door that is not Signal Center’s', (() => { try { leaky.rpc('sim_publish_run', {}); return false; } catch (e) { return /Signal Center doors only/.test(e.message); } })());
    chk('…or read a table it does not need', (() => { try { leaky.get('subscriptions?select=*'); return false; } catch (e) { return /reads only/.test(e.message); } })());
  } catch (e) {
    console.log = quiet;
    chk('the suite ran to the end', false, String(e && e.stack || e).slice(0, 1500));
  } finally {
    console.log = quiet;
    db.stop();
  }
  process.exit(T.done());
})();
