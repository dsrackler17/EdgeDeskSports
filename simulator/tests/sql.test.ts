/* ===========================================================================
   supabase/simulator.sql on a REAL PostgreSQL (tools/personal/_pg.js: a
   throwaway cluster with the Supabase shim's roles and auth.uid()).

   The entitlement rule is installed exactly as production has it after
   billing_hardening.sql: billing_row_grants_access() and what it calls
   (billing_row_in_good_standing(), billing_tier_of_price(), the
   billing_price_tiers table; extracted verbatim from that file) and
   community_is_entitled() delegating to it.

   The publisher under test is the real one (simulator/src/publish/publish.ts)
   talking to the database through a psql-backed adapter, so the same RPCs a
   GitHub Actions job calls over PostgREST are exercised here.

     node simulator/tests/sql.test.ts        (SIM_SQL_REQUIRED=1 in CI)
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { kit } from './_kit.ts';
import { nflFixture, clone } from './_fixture.ts';
import { REPO } from '../src/sports/nfl/model_adapter.ts';
import { nflModule } from '../src/sports/nfl/module.ts';
import { runRange } from '../src/core/engine.ts';
import { buildResults } from '../src/core/results.ts';
import { publishRun, idempotencyKey } from '../src/publish/publish.ts';
import type { SimDb } from '../src/publish/db.ts';
import type { RunOutcome } from '../src/cli/run.ts';
import type { Gate } from '../src/sports/nfl/validate.ts';
import os from 'node:os';
import { execute, parseArgs } from '../src/cli/run.ts';
import { CFB_FIXTURE } from './_cfb.ts';

const require = createRequire(import.meta.url);
const PG = require(path.join(REPO, 'tools', 'personal', '_pg.js'));
const T = kit('simulator SQL layer');
const F = (n: string) => path.join(REPO, 'supabase', n);
const SQL = fs.readFileSync(F('simulator.sql'), 'utf8');

T.chk('the migration copy is the same file', fs.readFileSync(path.join(REPO, 'supabase', 'migrations', '20261023120000_simulator.sql'), 'utf8') === SQL);
T.chk('no psql meta-command in the file', !/^\s*\\/m.test(SQL));
T.chk('the file never grants a client write', !/grant\s+(insert|update|delete|all)[^;]*to\s+(anon|authenticated)/i.test(SQL));
T.chk('no service-role key or secret in the file', !/service_role_key|Bearer\s|eyJhbGci/i.test(SQL));

const db = PG.start('simsql');
if (db.skip) {
  if (process.env.SIM_SQL_REQUIRED === '1') T.chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — the live SQL layer did not run');
  process.exit(T.done());
}
const lit = PG.lit;
const J = (s: string) => JSON.parse(String(s).split('\n').filter(Boolean).pop() as string);
const SUB = '00000000-0000-0000-0000-0000000000aa', NOSUB = '00000000-0000-0000-0000-0000000000bb', LAPSED = '00000000-0000-0000-0000-0000000000cc';
const semi = (q: string) => (q.trim().endsWith(';') ? q : q + ';');
const svc = (q: string): string => db.service(semi(q));
const asU = (u: string, q: string): string => db.as(u, semi(q));
const anonQ = (q: string): string => db.anon(semi(q));
const fails = (fn: () => unknown) => { try { fn(); return null; } catch (e) { return String((e as Error).message); } };

/* the psql-backed SimDb: the same RPC names and argument names PostgREST uses */
const JSONB = new Set(['p', 'p_rows', 'p_error']), UUID = new Set(['p_run', 'p_comparison']);
function pgDb(faults?: { failOnCall?: number; failName?: string }): SimDb & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async rpc(name, args) {
      calls.push(name);
      if (faults && ((faults.failOnCall && calls.length === faults.failOnCall) || faults.failName === name)) throw new Error('INJECTED FAULT at call ' + calls.length + ' (' + name + ')');
      const parts = Object.entries(args).map(([k, v]) => JSONB.has(k) ? lit(JSON.stringify(v)) + '::jsonb' : UUID.has(k) ? lit(String(v)) + '::uuid' : lit(String(v)));
      const out = svc('select to_jsonb(public.' + name + '(' + parts.join(', ') + '));');
      return J(out);
    }
  };
}

let mainRun = '';
try {
  /* ---- the billing rule, as production has it ---- */
  const BH = fs.readFileSync(F('billing_hardening.sql'), 'utf8');
  const r0 = BH.indexOf('create or replace function public.billing_row_in_good_standing('), r1 = BH.indexOf('-- THE ACCESS RULE', r0);
  const i0 = BH.indexOf('create or replace function public.billing_row_grants_access('), i1 = BH.indexOf('$$;', i0) + 3;
  db.sql(`create table public.subscriptions (user_id uuid, status text, price_id text, current_period_end timestamptz);
    ${BH.slice(r0, r1)}
    ${BH.slice(i0, i1)}
    create or replace function public.community_is_entitled(p_user uuid) returns boolean language sql stable security definer set search_path = public, pg_temp as $b$
      select exists (select 1 from public.subscriptions s where s.user_id = p_user and public.billing_row_grants_access(s.status, s.price_id, s.current_period_end, now())); $b$;
    insert into auth.users (id, email) values (${lit(SUB)}, 'sub@x'), (${lit(NOSUB)}, 'free@x'), (${lit(LAPSED)}, 'lapsed@x');
    insert into public.subscriptions values (${lit(SUB)}, 'active', 'price_x', now() + interval '20 days'), (${lit(LAPSED)}, 'past_due', 'price_x', now() - interval '30 days');`);

  /* ---- apply, twice ---- */
  let out = db.applyFile(F('simulator.sql'));
  T.chk('the file applies and every report row says ok', /\bok\b/.test(out) && !/CHECK THIS/.test(out), out.slice(-600));
  out = db.applyFile(F('simulator.sql'));
  T.chk('applying it again changes nothing and still reports ok', !/CHECK THIS/.test(out));

  /* ---- a real run's results ---- */
  const snap = nflFixture();
  const m = nflModule(snap.data, { seed: 77n });
  const agg = runRange(m, { start: 0, end: 300, traceRuns: [0, 1] });
  const results = buildResults({ module: m, agg, seed: 77n, runs: 300, workers: 1, input_hash: snap.input_hash, input_snapshot_at: '2026-10-23T05:00:00.000Z',
    model_version: snap.data.model.model_version, config: snap.data.config, rules_version: snap.data.config.rules_version,
    started_at: '2026-10-23T05:00:01.000Z', finished_at: '2026-10-23T05:00:09.000Z', runtime_ms: 8000, peak_rss_mb: 100 });
  const passing: Gate[] = [{ id: 'test.all_pass', status: 'PASS', blocks: 'none', detail: 'test fixture: every gate cleared' }];
  const outcomeOf = (over: Partial<{ asOf: string; seed: string; gates: Gate[] }>): RunOutcome => {
    const r = clone(results) as any;
    if (over.asOf) r.run.input_snapshot_at = over.asOf;
    if (over.seed) r.run.seed = over.seed;
    return { results: r, gates: over.gates || passing, snapshot: snap, outDir: '', publishable: true };
  };

  /* ---- 1 the CLI's real gates (BLOCKED sport, 300 runs) are refused by the database too ---- */
  {
    const real = outcomeOf({ seed: '1001', gates: [{ id: 'run.count', status: 'FAIL', blocks: 'publication', detail: '300 runs' }, { id: 'sport.active', status: 'FAIL', blocks: 'publication', detail: 'BLOCKED' }] });
    let err = '';
    try { await publishRun(real, { db: pgDb() }); } catch (e) { err = String((e as Error).message); }
    T.chk('a run whose gates block publication is refused by the database even if the client sends it', /gate run\.count blocks publication/.test(err) && /gate sport\.active/.test(err), err);
    T.eq('  ... nothing is published', svc("select count(*) from public.sim_published"), '0');
    T.eq('  ... and the run is kept, failed, with its reasons', svc("select status || ':' || (error_summary ->> 'code') from public.sim_runs where seed = '1001'"), 'failed:publish_verification_failed');
  }
  /* ---- 2 a clean publication ---- */
  const o1 = outcomeOf({ asOf: '2026-10-23T05:00:00Z', seed: '2001' });
  const p1 = await publishRun(o1, { db: pgDb(), chunk: 97 });
  mainRun = p1.run_id;
  T.chk('a passing run publishes', p1.published && p1.status === 'completed', p1);
  T.eq('the pointer names it', svc("select run_id::text from public.sim_published where sport = 'nfl'"), p1.run_id);
  T.eq('every (club, outcome) row is stored', svc(`select count(*) from public.sim_team_results where run_id = ${lit(p1.run_id)}`), String(32 * results.outcomes.length));
  T.eq('the input snapshot is stored by its hash', svc(`select count(*) from public.sim_input_snapshots where input_hash = ${lit(snap.input_hash)}`), '1');
  T.eq('traces stored (capped at 5)', svc(`select count(*) from public.sim_trace_samples where run_id = ${lit(p1.run_id)}`), '2');
  T.chk('stored probabilities equal count / N and MCSE equals sqrt(p(1-p)/N)', svc(`select count(*) from public.sim_team_results where run_id = ${lit(p1.run_id)} and (abs(probability - outcome_count::float8 / n_sims) > 1e-12 or abs(mcse - sqrt(probability*(1-probability)/n_sims)) > 1e-12)`) === '0');

  /* ---- 3 who can read ---- */
  T.chk('anonymous: no table access at all', !!fails(() => anonQ('select count(*) from public.sim_team_results')));
  T.eq('signed in, no subscription: sees no result rows', asU(NOSUB, 'select count(*) from public.sim_current_results'), '0');
  T.eq('signed in, past_due beyond the 21-day grace: sees nothing', asU(LAPSED, 'select count(*) from public.sim_current_results'), '0');
  T.eq('subscriber: sees the published run\'s rows', asU(SUB, 'select count(*) from public.sim_current_results'), String(32 * results.outcomes.length));
  T.eq('subscriber: sees the current run', asU(SUB, 'select run_id::text from public.sim_current_runs'), p1.run_id);
  const status = J(anonQ("select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) from public.sim_public_status() s"));
  T.chk('anyone may read the public status, which carries no probability', status.length === 1 && status[0].published_run_id === p1.run_id && !JSON.stringify(status).includes('probability'), status);
  /* ---- 4 nobody but the job writes ---- */
  T.chk('a subscriber cannot insert a result row', !!fails(() => asU(SUB, `insert into public.sim_team_results (run_id, entity_id, entity_name, outcome, category, n_sims, outcome_count, probability, mcse, wilson_lo, wilson_hi) values (${lit(p1.run_id)}, 'X', 'X', 'win_x', 'title', 1, 1, 1, 0, 0, 1)`)));
  T.chk('a subscriber cannot change a published probability', !!fails(() => asU(SUB, "update public.sim_team_results set probability = 0.99")) && svc(`select count(*) from public.sim_team_results where probability = 0.99`) === '0');
  T.chk('a subscriber cannot call the publication function', !!fails(() => asU(SUB, `select public.sim_publish_run(${lit(p1.run_id)}::uuid)`)));
  T.chk('a subscriber cannot move the pointer', !!fails(() => asU(SUB, `update public.sim_published set run_id = run_id`)));
  T.chk('a subscriber cannot delete a run', !!fails(() => asU(SUB, `delete from public.sim_runs`)));
  T.chk('anon cannot begin a run', !!fails(() => anonQ(`select public.sim_begin_run('{}'::jsonb)`)));
  /* ---- 5 history is frozen ---- */
  T.chk('a completed run cannot be edited, even by the service role', !!fails(() => svc(`update public.sim_runs set n_sims = 1 where run_id = ${lit(p1.run_id)}`)));
  T.chk('a completed run\'s results cannot be edited', !!fails(() => svc(`update public.sim_team_results set probability = 0.5 where run_id = ${lit(p1.run_id)}`)));
  T.chk('results cannot be deleted', !!fails(() => svc(`delete from public.sim_team_results where run_id = ${lit(p1.run_id)}`)));
  T.chk('runs cannot be deleted or truncated', !!fails(() => svc(`delete from public.sim_runs`)) && !!fails(() => svc(`truncate public.sim_runs cascade`)));
  T.chk('the pointer cannot be deleted', !!fails(() => svc(`delete from public.sim_published`)));
  /* ---- 6 idempotent rerun ---- */
  const again = await publishRun(o1, { db: pgDb() });
  T.chk('the same inputs, seed and versions again publish nothing new', again.existing && again.run_id === p1.run_id && !again.published);
  T.eq('  ... still one live run for that key', svc(`select count(*) from public.sim_runs where idempotency_key = ${lit(idempotencyKey(o1))} and status <> 'failed'`), '1');
  /* ---- 7 an interrupted upload: the job dies after the first result chunk ---- */
  {
    const o2 = outcomeOf({ asOf: '2026-10-24T05:00:00Z', seed: '3001' });
    const fdb = pgDb({ failOnCall: 4 });   // begin, snapshot, results#1, results#2 <- dies
    let err = '';
    try { await publishRun(o2, { db: fdb, chunk: 100 }); } catch (e) { err = String((e as Error).message); }
    T.chk('an upload interrupted mid-way raises', /INJECTED FAULT/.test(err), err);
    T.eq('  ... the run is marked failed with the reason', svc("select status || ':' || (error_summary ->> 'code') from public.sim_runs where seed = '3001'"), 'failed:upload_failed');
    T.eq('  ... and the last good run is still the one readers see', asU(SUB, 'select run_id::text from public.sim_current_runs'), p1.run_id);
    T.eq('  ... with all of its rows', asU(SUB, 'select count(*) from public.sim_current_results'), String(32 * results.outcomes.length));
    T.eq('  ... the partial rows of the failed run are invisible to readers', asU(SUB, "select count(*) from public.sim_team_results t join public.sim_runs r using (run_id) where r.seed = '3001'"), '0');
    /* a retry of the same inputs is allowed after a failure, and succeeds */
    const ok = await publishRun(o2, { db: pgDb() });
    T.chk('a retry of the failed inputs publishes (the failed attempt does not block its key)', ok.published && ok.run_id !== p1.run_id);
    T.eq('  ... and becomes the current run', svc("select run_id::text from public.sim_published"), ok.run_id);
    mainRun = ok.run_id;
  }
  /* ---- 8 a publish that never arrives: rows uploaded, the job dies before sim_publish_run ---- */
  {
    const o3 = outcomeOf({ asOf: '2026-10-25T05:00:00Z', seed: '4001' });
    let err = '';
    try { await publishRun(o3, { db: pgDb({ failName: 'sim_publish_run' }) }); } catch (e) { err = String((e as Error).message); }
    T.chk('a job that dies before publishing leaves the pointer alone', /INJECTED FAULT/.test(err) && svc("select run_id::text from public.sim_published") === mainRun);
  }
  /* ---- 9 a database error mid-upload (a row that violates the count/probability rule) ---- */
  {
    const o4 = outcomeOf({ asOf: '2026-10-26T05:00:00Z', seed: '5001' });
    (o4.results.entities[0] as any).outcomes.make_playoffs.probability = 0.123456;  // inconsistent with its count
    let err = '';
    try { await publishRun(o4, { db: pgDb() }); } catch (e) { err = String((e as Error).message); }
    T.chk('a result row whose probability disagrees with its count is refused by the database', /check constraint/i.test(err), err.slice(0, 300));
    T.eq('  ... the run is failed and the pointer unchanged', svc("select status from public.sim_runs where seed = '5001'") + '|' + svc("select run_id::text from public.sim_published"), 'failed|' + mainRun);
  }
  /* ---- 10 a manually short upload (rows missing) is refused at publication ---- */
  {
    const o5 = outcomeOf({ asOf: '2026-10-27T05:00:00Z', seed: '6001' });
    const b = J(svc(`select to_jsonb(public.sim_begin_run(${lit(JSON.stringify({ sport: 'nfl', competition: 'NFL', season: '2026', idempotency_key: idempotencyKey(o5), seed: '6001', prng_version: 'x', n_sims: 300, model_version: 'm', engine_version: 'e', rules_version: 'r', config_hash: o5.results.run.config_hash, input_snapshot_at: '2026-10-27T05:00:00Z', input_ref: 'db:x', input_hash: snap.input_hash, expected: { entities: 32, outcomes: o5.results.outcomes.length, sum_rules: o5.results.sum_rules } }))}::jsonb))`));
    const pub = J(svc(`select to_jsonb(public.sim_publish_run(${lit(b.run_id)}::uuid))`));
    T.chk('publishing a run with no result rows is refused (row counts verified)', pub.published === false && /result rows 0/.test(JSON.stringify(pub.errors)), pub);
    T.eq('  ... pointer unchanged', svc("select run_id::text from public.sim_published"), mainRun);
  }
  /* ---- 11 an older job cannot overwrite newer published results ---- */
  {
    const old = outcomeOf({ asOf: '2026-10-20T05:00:00Z', seed: '7001' });
    const p = await publishRun(old, { db: pgDb() });
    T.chk('a run built from OLDER inputs than the published one is kept as superseded, not shown', !p.published && p.status === 'superseded');
    T.eq('  ... the newer run stays current', svc("select run_id::text from public.sim_published"), mainRun);
  }
  /* ---- 12 concurrency ---- */
  {
    const oc = outcomeOf({ asOf: '2026-10-28T05:00:00Z', seed: '8001' });
    const key = idempotencyKey(oc);
    const begin = (seed: string) => `select to_jsonb(public.sim_begin_run(${lit(JSON.stringify({ sport: 'nfl', competition: 'NFL', season: '2026', idempotency_key: key, seed, prng_version: 'x', n_sims: 300, model_version: 'm', engine_version: 'e', rules_version: 'r', config_hash: oc.results.run.config_hash, input_snapshot_at: '2026-10-28T05:00:00Z', input_ref: 'db:x', input_hash: snap.input_hash, expected: {} }))}::jsonb))`;
    svc(begin('8001'));
    const second = fails(() => svc(begin('8001')));
    T.chk('two jobs with the same inputs: the second is refused while the first runs', !!second && /already in progress/.test(second), second);
    /* a publication waits for the competition's lock: hold it in another session for 2 s */
    const holder = db.background(`begin; select pg_advisory_xact_lock(hashtextextended('sim:nfl:NFL:2026', 0)); select pg_sleep(2); commit;`);
    db.sleep(0.4);
    const t0 = Date.now();
    const o6 = outcomeOf({ asOf: '2026-10-29T05:00:00Z', seed: '9001' });
    const p6 = await publishRun(o6, { db: pgDb() });
    const waited = Date.now() - t0;
    const h = holder.wait(10000);
    T.chk('a publication waits for the competition lock held by another session, then succeeds', h.code === 0 && p6.published && waited >= 1000, { waited, code: h.code });
    mainRun = p6.run_id;
  }
  /* ---- 13 market comparisons: an outage leaves the simulation published ---- */
  {
    const cid = J(svc(`select to_jsonb(public.sim_begin_comparison(${lit(JSON.stringify({ run_id: mainRun, mapping_version: 'test', expected: { edges: 1 } }))}::jsonb))`));
    svc(`select public.sim_fail_comparison(${lit(cid)}::uuid, '{"code":"kalshi_unreachable","message":"HTTP 503"}'::jsonb)`);
    T.eq('a failed market refresh leaves the run published', asU(SUB, 'select run_id::text from public.sim_current_runs'), mainRun);
    T.eq('  ... and no comparison is attached', svc("select coalesce(comparison_id::text, 'none') from public.sim_published"), 'none');
    T.eq('  ... and is recorded as a DEGRADED alert', svc("select count(*) from public.sim_alerts where code = 'market.failed' and severity = 'DEGRADED'"), '1');
    const c2 = J(svc(`select to_jsonb(public.sim_begin_comparison(${lit(JSON.stringify({ run_id: mainRun, mapping_version: 'test', expected: { edges: 2 } }))}::jsonb))`));
    const q = J(svc(`select public.sim_put_quotes(${lit(c2)}::uuid, ${lit(JSON.stringify([{ market_ticker: 'SYN-A', captured_at: '2026-10-29T05:00:00Z', yes_bid: 0.1, yes_ask: 0.12, yes_ask_size: 500 }, { market_ticker: 'SYN-B', captured_at: '2026-10-29T05:00:00Z', yes_bid: 0.3, yes_ask: 0.32, yes_ask_size: 50 }]))}::jsonb)`));
    const edge = (t: string, actionable: boolean, extra: Record<string, unknown> = {}) => ({ market_ticker: t, mapping_id: 'syn-' + t, entity_id: 'BUF', outcome: 'win_super_bowl', settlement_basis: 'SYNTHETIC',
      quote_id: q[t], quote_at: '2026-10-29T05:00:00Z', reference_basis: 'yes_mid', reference_prob: 0.11, research_prob: 0.15, research_mcse: 0.001, exec_quantity: 10, exec_price: 0.12,
      fee_per_contract: 0.01, fee_verified: actionable, exec_cost_prob: 0.13, exec_edge_pp: 2, stale: false, eligible: actionable, actionable, block_reasons: actionable ? [] : ['fee schedule unverified'], ...extra });
    T.chk('an actionable edge without a verified fee is refused by the database', !!fails(() => svc(`select public.sim_put_edges(${lit(c2)}::uuid, ${lit(JSON.stringify([edge('SYN-A', false, { actionable: true })]))}::jsonb)`)));
    svc(`select public.sim_put_edges(${lit(c2)}::uuid, ${lit(JSON.stringify([edge('SYN-A', true), edge('SYN-B', false)]))}::jsonb)`);
    T.eq('  ... unpublished edges are invisible to a subscriber', asU(SUB, 'select count(*) from public.sim_futures_edges'), '0');
    const pc = J(svc(`select to_jsonb(public.sim_publish_comparison(${lit(c2)}::uuid))`));
    T.chk('a complete comparison publishes and snapshots its one actionable flag', pc.published && pc.flags === 1, pc);
    T.eq('  ... the subscriber sees both edges of the current run', asU(SUB, 'select count(*) from public.sim_current_edges'), '2');
    T.eq('  ... a non-subscriber sees none', asU(NOSUB, 'select count(*) from public.sim_current_edges'), '0');
    T.chk('the flag snapshot is immutable', !!fails(() => svc('update public.sim_flag_snapshots set entity_id = \'X\'')) && !!fails(() => svc('delete from public.sim_flag_snapshots')));
    T.chk('published edges are frozen', !!fails(() => svc(`update public.sim_futures_edges set research_prob = 0.9`)));
    const fid = svc('select flag_id from public.sim_flag_snapshots');
    T.chk('a missing close cannot carry a price or a CLV (never a settled 0/1)', !!fails(() => svc(`select public.sim_put_close(${lit(JSON.stringify({ flag_id: Number(fid), close_basis: 'last quote before close', close_window: '60 min', status: 'missing', clv_reference_pp: 5 }))}::jsonb)`)));
    svc(`select public.sim_put_close(${lit(JSON.stringify({ flag_id: Number(fid), close_basis: 'last quote before close', close_window: '60 min', status: 'missing', note: 'no quote in the window' }))}::jsonb)`);
    T.eq('  ... a missing close is recorded as missing', svc('select status from public.sim_closing_observations'), 'missing');
    /* the grader: a flag whose market has closed, with and without a captured quote in the window */
    const c4 = J(svc(`select to_jsonb(public.sim_begin_comparison(${lit(JSON.stringify({ run_id: mainRun, mapping_version: 'test', expected: { edges: 2 } }))}::jsonb))`));
    const q4 = J(svc(`select public.sim_put_quotes(${lit(c4)}::uuid, ${lit(JSON.stringify([
      { market_ticker: 'SYN-C', captured_at: '2026-10-21T05:00:00Z', yes_bid: 0.10, yes_ask: 0.12, yes_ask_size: 500, close_time: '2026-10-22T00:00:00Z' },
      { market_ticker: 'SYN-D', captured_at: '2026-10-21T05:00:00Z', yes_bid: 0.10, yes_ask: 0.12, yes_ask_size: 500, close_time: '2026-10-22T00:00:00Z' },
      { market_ticker: 'SYN-C', captured_at: '2026-10-21T23:30:00Z', yes_bid: 0.16, yes_ask: 0.18, yes_ask_size: 500, close_time: '2026-10-22T00:00:00Z' }]))}::jsonb)`));
    svc(`select public.sim_put_edges(${lit(c4)}::uuid, ${lit(JSON.stringify([edge('SYN-C', true, { quote_id: q4['SYN-C'] }), edge('SYN-D', true, { quote_id: q4['SYN-D'] })]))}::jsonb)`);
    const pub4 = J(svc(`select to_jsonb(public.sim_publish_comparison(${lit(c4)}::uuid))`));
    if (pub4.published) {
      const g = J(svc('select to_jsonb(public.sim_grade_closes(60))'));
      T.chk('the grader records one observed close and one missing close', g.observed >= 1 && g.missing >= 1, g);
      const obs = J(svc("select to_jsonb(o) from public.sim_closing_observations o join public.sim_flag_snapshots f using (flag_id) where f.market_ticker = 'SYN-C'"));
      const miss = svc("select o.status || ':' || coalesce(o.clv_reference_pp::text, 'null') from public.sim_closing_observations o join public.sim_flag_snapshots f using (flag_id) where f.market_ticker = 'SYN-D'");
      T.eq('  ... with no quote inside the window, the close is missing and carries no CLV', miss, 'missing:null');
      T.chk('  ... the observed close is the last captured quote in the window, its CLV in points', obs.status === 'observed' && Math.abs(obs.close_reference_prob - 0.17) < 1e-9 && Math.abs(obs.clv_reference_pp - 6) < 1e-6 && Math.abs(obs.clv_exec_pp - 5) < 1e-6, obs);
      const again = J(svc('select to_jsonb(public.sim_grade_closes(60))'));
      T.chk('  ... grading again adds nothing', again.observed === 0 && again.missing === 0, again);
    } else T.chk('the close-grading comparison published', false, pub4);
    /* a comparison of a run that is no longer current is refused */
    const o7 = outcomeOf({ asOf: '2026-10-30T05:00:00Z', seed: '9101' }), p7 = await publishRun(o7, { db: pgDb() });
    const c3 = J(svc(`select to_jsonb(public.sim_begin_comparison(${lit(JSON.stringify({ run_id: mainRun, mapping_version: 'test', expected: { edges: 0 } }))}::jsonb))`));
    const pc3 = J(svc(`select to_jsonb(public.sim_publish_comparison(${lit(c3)}::uuid))`));
    T.chk('a comparison against a run that is no longer current is refused', pc3.published === false && pc3.reason === 'run_not_current' && p7.published, pc3);
    T.eq('  ... and the new run carries no stale comparison', svc("select coalesce(comparison_id::text, 'none') from public.sim_published"), 'none');
  }
  /* ---- 14 the research registry (the deployed-only tables, as tools/nba/nba_injury_sql.test.js builds them) ---- */
  {
    const reg = JSON.parse(fs.readFileSync(path.join(REPO, 'simulator', 'research', 'registration.json'), 'utf8'));
    T.chk('the registration states T3, EXPERIMENTAL, promotion criteria and limitations before any result', reg.provenance === 'T3' && reg.status === 'EXPERIMENTAL' && reg.result === null
      && reg.promotion_criteria.criteria.length === 4 && reg.spec.known_limitations.length >= 4);
    T.chk('the generated registry file is current', fs.readFileSync(F('simulator_registry.sql'), 'utf8').includes(reg.model_key) && !/^\s*\\/m.test(fs.readFileSync(F('simulator_registry.sql'), 'utf8')));
    T.chk('without the registry the file refuses and registers nothing', !!fails(() => db.applyFile(F('simulator_registry.sql'))));
    db.sql(`create type public.evidence_provenance as enum ('T0', 'T1', 'T2', 'T3');
      create type public.model_status as enum ('experimental', 'validating', 'validated', 'retired');
      create table public.research_models (id uuid primary key default gen_random_uuid(), model_key text unique not null, name text not null, sport text, provenance public.evidence_provenance not null, objective text, created_at timestamptz not null default now());
      create table public.research_model_versions (id bigserial primary key, model_id uuid not null references public.research_models (id), version text not null, status public.model_status not null default 'experimental', training_window daterange, validation_window daterange, holdout_window daterange, objective text, min_sample integer, success_metric text, forking_paths jsonb, promotion_criteria jsonb, spec jsonb, created_at timestamptz not null default now());
      create table public.research_model_results (id bigserial primary key, version_id bigint references public.research_model_versions (id), passed boolean, metrics jsonb, computed_at timestamptz not null default now());
      create view public.research_model_current as select m.model_key, m.name, m.provenance, v.version, v.status, v.training_window, v.validation_window, v.objective, r.passed, r.metrics as holdout_result, v.created_at as updated_at
        from public.research_models m join lateral (select * from public.research_model_versions x where x.model_id = m.id order by x.created_at desc limit 1) v on true
        left join lateral (select * from public.research_model_results y where y.version_id = v.id order by y.computed_at desc limit 1) r on true;`);
    let out = db.applyFile(F('simulator_registry.sql'));
    T.chk('the registration applies and reports ok', !/CHECK THIS/.test(out) && /\bok\b/.test(out), out.slice(-400));
    out = db.applyFile(F('simulator_registry.sql'));
    T.chk('registering twice changes nothing', !/CHECK THIS/.test(out) && svc('select count(*) from public.research_model_versions') === '1' && svc('select count(*) from public.research_models') === '1');
    const row = J(svc("select to_jsonb(x) from (select m.provenance, v.status, v.version, v.min_sample, v.promotion_criteria -> 'criteria' -> 0 ->> 'id' as c1, v.holdout_window::text as hw from public.research_models m join public.research_model_versions v on v.model_id = m.id) x"));
    T.chk('the version row is T3 / experimental / 0.1.0 with its criteria and holdout window', row.provenance === 'T3' && row.status === 'experimental' && row.version === '0.1.0' && row.min_sample === 3 && row.c1 === 'C1_BRIER_VS_NO_UNCERTAINTY' && /2025-09-01/.test(row.hw), row);
    T.eq('no result row is written (nothing is promoted)', svc('select count(*) from public.research_model_results'), '0');
    T.eq('the simulator config names the registered version', svc("select value from public.sim_config where key = 'research_model_version'"), '0.1.0');
  }
  /* ---- 15 status after a failed refresh ---- */
  {
    const st = J(anonQ("select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) from public.sim_public_status() s"))[0];
    T.chk('public status names the published run and the latest attempt separately', !!st.published_run_id && !!st.last_attempt_status, st);
  }
  /* ---- 16 the entitlement fails closed (last: it removes the billing functions) ---- */
  {
    const before = asU(SUB, 'select count(*) from public.sim_current_results');
    db.sql('drop function public.community_is_entitled(uuid);');
    T.eq('without community_is_entitled the subscriber is still entitled through the billing rule itself', asU(SUB, 'select public.sim_viewer_entitled()::text'), 'true');
    T.eq('  ... and a free account still is not', asU(NOSUB, 'select public.sim_viewer_entitled()::text'), 'false');
    db.sql('drop function public.billing_row_grants_access(text, text, timestamptz, timestamptz);');
    T.eq('without either function nobody is entitled (fail closed)', asU(SUB, 'select public.sim_viewer_entitled()::text'), 'false');
    T.chk('  ... and the subscriber reads no result rows', before !== '0' && asU(SUB, 'select count(*) from public.sim_current_results') === '0', before);
    const rep = db.applyFile(F('simulator.sql'));
    T.chk('  ... and the report says CHECK THIS about the missing entitlement function', /CHECK THIS: public\.community_is_entitled\(uuid\) is not installed/.test(rep), rep.slice(-500));
  }
  /* ---- 17 college football: the teams outside any conference title game share the group 'none', which the
         format's title-game sum rules skip. The database refused every CFB publication until it honoured the
         skip (Actions run 39994731070, 2026-10-23: "sum rule ccg_appearance per ccg fails in 1 group(s)"). ---- */
  {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'simsql-cfb-'));
    const o = await execute(parseArgs(['--sport', 'cfb', '--snapshot', CFB_FIXTURE, '--runs', '400', '--workers', '1', '--dry-run', '--out', out]), () => {});
    const ccg = (o.results.sum_rules as any[]).filter((r) => r.by === 'ccg');
    T.chk('the CFB format\'s title-game sum rules skip the group of teams without a title game', ccg.length === 3 && ccg.every((r) => (r.skip || []).includes('none')), ccg);
    T.chk('  ... and that group exists in the run (independents)', (o.results.entities as any[]).some((e) => e.groups.ccg === 'none'));
    const p = await publishRun({ ...o, gates: passing, publishable: true }, { db: pgDb() });
    T.chk('a college football run publishes', p.published && p.status === 'completed', p);
    T.eq('  ... beside the NFL\'s, each sport with its own pointer', svc("select string_agg(sport, ',' order by sport) from public.sim_published"), 'cfb,nfl');
    /* the skip covers only the group it names: the same rules without it are refused */
    const noSkip = clone(o) as RunOutcome;
    (noSkip.results.run as any).seed = String(BigInt(o.results.run.seed) + 1n);
    noSkip.results.sum_rules = (noSkip.results.sum_rules as any[]).map((r) => { const { skip, ...rest } = r; return rest; }) as any;
    let err = '';
    try { await publishRun({ ...noSkip, gates: passing, publishable: true }, { db: pgDb() }); } catch (e) { err = String((e as Error).message); }
    T.chk('  ... a run whose rules do not skip that group is still refused for it', /sum rule ccg_appearance per ccg fails in 1 group/.test(err), err.slice(0, 300));
    T.eq('  ... and the published CFB run is unchanged', svc("select run_id::text from public.sim_published where sport = 'cfb'"), p.run_id);
  }
} catch (e) {
  const msg = String((e as Error).stack || e);
  T.chk("the suite ran to the end", false, msg.split("\n").filter((l) => !/NOTICE/.test(l)).join("\n").slice(0, 2500));
} finally {
  db.stop();
}
process.exit(T.done());
