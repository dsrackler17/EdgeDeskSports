'use strict';
/* ===========================================================================
   A STAGED SIGNAL CENTER for the browser suites: a throwaway PostgreSQL
   (tools/personal/_pg.js) with the project's billing rule, operator list and
   notice table, the Simulator schema and the Signal Center migration, filled
   by ONE live worker run (tools/signal_center/run.js) over the COMMITTED
   sources, behind the PostgREST stand-in (tools/billing/_pgrest.js).

   So a browser test reads what the shipped doors return for the shipped data,
   not a hand-written imitation of a response. The two Simulator runs are test
   rows written into this throwaway database only (they exercise the simulator
   shift path); nothing here is ever written anywhere else.

     const S = await require('./_stage.js').stage({ mode: 'live' });
     S.db, S.stand.fetch, S.tokens, S.users { SUB, NOSUB, ADMIN }, S.stop()
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const PG = require(path.join(ROOT, 'tools', 'personal', '_pg.js'));
const REST = require(path.join(ROOT, 'tools', 'billing', '_pgrest.js'));
const DB = require('./db.js');
const RUN = require('./run.js');
const lit = PG.lit;
const F = (n) => path.join(ROOT, 'supabase', n);

const USERS = {
  SUB: '11111111-1111-4111-8111-111111111111',     // Full Access
  NOSUB: '22222222-2222-4222-8222-222222222222',   // signed in, no subscription
  ADMIN: 'e7e46801-80c4-4f47-b718-4aff211c8d3a'    // billing_is_admin's founding operator
};
const TOKENS = { tok_sub: { id: USERS.SUB, email: 'sub@edgedesk.test' }, tok_free: { id: USERS.NOSUB, email: 'free@edgedesk.test' }, tok_admin: { id: USERS.ADMIN, email: 'op@edgedesk.test' } };
const NOW = Date.parse('2026-10-23T20:30:00Z');

async function stage(o) {
  o = o || {};
  const db = await PG.start(o.name || 'scstage');
  if (db.skip) return { skip: db.skip };
  const slice = (src, a, b) => { const i = src.indexOf(a); if (i < 0) throw new Error('not found: ' + a); return src.slice(i, src.indexOf(b, i) + b.length); };
  const BH = fs.readFileSync(F('billing_hardening.sql'), 'utf8'), PR = fs.readFileSync(F('personal_research.sql'), 'utf8');
  const FU = fs.readFileSync(F('funnel.sql'), 'utf8');
  db.sql(`create table public.subscriptions (user_id uuid, status text, price_id text, current_period_end timestamptz);
    ${slice(BH, 'create or replace function public.billing_row_in_good_standing(', '-- THE ACCESS RULE')}
    ${slice(BH, 'create or replace function public.billing_row_grants_access(', '$$;')}
    ${slice(BH, 'create or replace function public.billing_is_admin()', '$$;')}
    create or replace function public.community_is_entitled(p_user uuid) returns boolean language sql stable security definer set search_path = public, pg_temp as $b$
      select exists (select 1 from public.subscriptions s where s.user_id = p_user and public.billing_row_grants_access(s.status, s.price_id, s.current_period_end, now())); $b$;
    ${slice(PR, 'create or replace function public.edp_copy_ok(p text)', '$$;')}
    ${slice(PR, 'create table if not exists public.user_alerts (', 'grant update (read_at, dismissed_at) on public.user_alerts to authenticated;')}
    ${slice(FU, 'create table if not exists public.user_event_kinds (', '\n);')}
    insert into auth.users (id, email) values (${lit(USERS.SUB)}, 'sub@edgedesk.test'), (${lit(USERS.NOSUB)}, 'free@edgedesk.test'), (${lit(USERS.ADMIN)}, 'op@edgedesk.test');
    insert into public.subscriptions values (${lit(USERS.SUB)}, 'active', 'price_x', now() + interval '20 days');`);
  /* pgcrypto where Supabase keeps it, outside the doors' search_path */
  db.sql('drop extension if exists pgcrypto; create schema if not exists extensions; create extension pgcrypto with schema extensions;');
  db.applyFile(F('simulator.sql'));
  db.applyFile(F('signal_center.sql'));
  /* two published NFL simulator runs in THIS throwaway database (the worker
     suite's shape): the simulator-shift path has something to compare */
  const h = (c) => c.repeat(64);
  const R1 = 'aaaaaaaa-1111-4111-8111-000000000001', R2 = 'aaaaaaaa-1111-4111-8111-000000000002', N = 100000;
  const res = (run, team, name, outcome, count) => `(${lit(run)}, ${lit(team)}, ${lit(name)}, '{}'::jsonb, ${lit(outcome)}, 'playoffs', true, ${count}, ${N}, ${count}::float8 / ${N}, sqrt((${count}::float8 / ${N}) * (1 - ${count}::float8 / ${N}) / ${N}),
     greatest(0, ${count}::float8 / ${N} - 0.01), least(1, ${count}::float8 / ${N} + 0.01), 'wilson_95', ${N}::float8 / ${count}, 'Research')`;
  db.sql(`insert into public.sim_runs (run_id, sport, competition, season, idempotency_key, seed, prng_version, n_sims, model_version, engine_version, rules_version, config_hash, input_snapshot_at, input_ref, input_hash, status, started_at)
    values (${lit(R1)}, 'nfl', 'NFL', '2026', ${lit(h('1'))}, '1', 'pcg', ${N}, 'edgedesk_nfl_v2.1.0', 'sim/0.1', 'nfl_2026', ${lit(h('c'))}, '2026-10-20T10:00:00Z', 'snap1', ${lit(h('a'))}, 'running', now()),
           (${lit(R2)}, 'nfl', 'NFL', '2026', ${lit(h('2'))}, '2', 'pcg', ${N}, 'edgedesk_nfl_v2.1.0', 'sim/0.1', 'nfl_2026', ${lit(h('c'))}, '2026-10-23T10:00:00Z', 'snap2', ${lit(h('b'))}, 'running', now());
    insert into public.sim_team_results (run_id, entity_id, entity_name, entity_groups, outcome, category, applicable, outcome_count, n_sims, probability, mcse, wilson_lo, wilson_hi, interval_method, fair_decimal, provenance) values
      ${res(R1, 'KC', 'Kansas City Chiefs', 'make_playoffs', 71000)}, ${res(R2, 'KC', 'Kansas City Chiefs', 'make_playoffs', 58000)},
      ${res(R1, 'DET', 'Detroit Lions', 'make_playoffs', 55200)}, ${res(R2, 'DET', 'Detroit Lions', 'make_playoffs', 62800)};
    update public.sim_runs set status = 'completed', completed_at = '2026-10-20T11:00:00Z', finished_at = '2026-10-20T11:00:00Z' where run_id = ${lit(R1)};
    update public.sim_runs set status = 'completed', completed_at = '2026-10-23T11:00:00Z', finished_at = '2026-10-23T11:00:00Z' where run_id = ${lit(R2)};
    insert into public.sim_published (sport, competition, season, run_id, input_snapshot_at, published_at, previous_run_id) values ('nfl', 'NFL', '2026', ${lit(R2)}, '2026-10-23T10:00:00Z', '2026-10-23T11:05:00Z', ${lit(R1)});
    update public.sc_config set value = '"live"' where key = 'mode';
    insert into public.sc_preferences (user_id, sports, min_label, notify) values (${lit(USERS.SUB)}, '{nfl,cfb}', 'Routine', true);`);
  /* the stand-in's own service key: a placeholder that never leaves this process */
  const STAND_KEY = ['stage', 'standin', 'key'].join('-');
  const stand = REST.make(db, { serviceKey: STAND_KEY, tokens: TOKENS });
  const client = DB.client({ SB_URL: 'http://standin', SB_SERVICE_ROLE: STAND_KEY }, { fetchImpl: stand.fetch, sleep: async () => {} });
  const quiet = console.log;
  console.log = () => {};
  let run;
  try { run = await RUN.liveRun(client, RUN.committedInputs(ROOT, NOW), { idem: 'stage-1', sha: 'abcdef0', resolver: RUN.teamStyleResolver(ROOT) }); }
  finally { console.log = quiet; }
  /* the mode the suite asked for, set after the run (a run publishes under the mode it began in) */
  if (o.mode && o.mode !== 'live') db.sql(`update public.sc_config set value = ${lit(JSON.stringify(o.mode))}::jsonb where key = 'mode';`);
  return { db, stand, run, users: USERS, tokens: TOKENS, now: NOW, stop: () => db.stop() };
}

/* Playwright: answer the page's Supabase calls from the stand-in. The bearer
   token decides the role exactly as PostgREST would. */
function router(S, o) {
  o = o || {};
  return async (route) => {
    const req = route.request(), u = req.url();
    if (u.startsWith('http://127.0.0.1')) return route.continue();
    if (!/supabase\.co/.test(u)) return route.fulfill({ status: 204, body: '' });
    const target = new URL(u).pathname;
    if (o.tracked && /rpc\/ed_track/.test(u)) { try { (JSON.parse(req.postData() || '{}').p_events || []).forEach((e) => o.tracked.push(e)); } catch (_) { /* ignore */ } return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"recorded":1}' }); }
    if (o.notDeployed && /\/rpc\/sc_/.test(target)) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"code":"PGRST202","message":"Could not find the function"}' });
    if (/\/rest\/v1\/rpc\/sc_/.test(target) || /\/rest\/v1\/user_alerts/.test(target)) {
      if (o.calls) o.calls.push(req.method() + ' ' + target.replace('/rest/v1/', ''));
      const r = await S.stand.fetch(u.replace(/^https:\/\/[^/]+/, 'http://standin'), { method: req.method(), headers: req.headers(), body: req.postData() || undefined });
      const text = typeof r.text === 'function' ? await r.text() : String(r.body || '');
      return route.fulfill({ status: r.status, contentType: 'application/json', body: text });
    }
    if (/subscriptions/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: o.entitled ? JSON.stringify([{ status: 'active', current_period_end: '2027-06-01T00:00:00Z' }]) : '[]' });
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  };
}

module.exports = { stage, router, USERS, TOKENS, NOW };
