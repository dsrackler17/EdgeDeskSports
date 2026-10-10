#!/usr/bin/env node
/* ===========================================================================
   supabase/odds_quota.sql against a real, throwaway PostgreSQL.

   Proves the central request budget does what docs/market-resilience says:
   applies clean, twice and as one transaction; only the service role may
   touch it; RESEARCH_ONLY spends nothing; a key in flight is coalesced; a
   key refreshed inside its interval is cache-fresh; the daily limit holds the
   reserve for critical work; a provider floor holds; a 429 opens the breaker
   with back-off and a HALF_OPEN probe follows the cool-down; exhaustion holds
   every caller until the reset; three timeouts open the breaker; a dead
   caller's request is ABANDONED and still counted; the ledger is append-only;
   status and the rollback work.

   Run: node tools/resilience/odds_quota_sql.test.js   (RESILIENCE_SQL_REQUIRED=1 in CI)
   =========================================================================== */
'use strict';
const path = require('path');
const PG = require('../personal/_pg.js');

const SQL = path.join(__dirname, '..', '..', 'supabase', 'odds_quota.sql');
const ROLLBACK = path.join(__dirname, '..', '..', 'supabase', 'odds_quota_rollback.sql');
let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function done(note) {
  if (note && /^SKIP/.test(note) && process.env.RESILIENCE_SQL_REQUIRED === '1') { fail++; failures.push({ name: 'Postgres required but ' + note }); }
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
  if (note) console.log(note);
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'odds quota SQL — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}
const db = PG.start('oddsquota');
if (!db || db.skip) done('SKIP | ' + ((db && db.skip) || 'no postgres') + ' — the SQL layer did not run');

const J = (s) => JSON.parse(s);
const acq = (caller, key, est, pri, interval) => J(db.service(`select public.odds_quota_acquire(${lit(caller)}, ${lit(key)}, ${est | 0}, ${lit(pri || 'normal')}, null, null, ${interval == null ? 'null' : interval})::text;`));
const settle = (id, status, cost, rem, http) => J(db.service(`select public.odds_quota_settle(${lit(id)}::uuid, ${lit(status)}, ${cost == null ? 'null' : cost}, ${rem == null ? 'null' : rem}, null, ${http == null ? 'null' : http}, null)::text;`));
const status = () => J(db.service(`select public.odds_quota_status()::text;`));
function lit(v) { return v == null ? 'NULL' : "'" + String(v).replace(/'/g, "''") + "'"; }
const reset = () => db.sql(`update public.odds_quota_state set breaker='CLOSED', breaker_reason=null, open_until=null, consecutive_failures=0, quota_exhausted_until=null, provider_remaining=null;`);
const age = (id, secs) => db.sql(`alter table public.odds_quota_requests disable trigger odds_quota_requests_guard_trg;
  update public.odds_quota_requests set acquired_at = acquired_at - make_interval(secs => ${secs}), settled_at = settled_at - make_interval(secs => ${secs}) where request_id = '${id}';
  alter table public.odds_quota_requests enable trigger odds_quota_requests_guard_trg;`);

try {
  const r1 = db.applyFile(SQL);
  chk('applies to a clean database, every report row ok', !/CHECK THIS/.test(r1) && (r1.match(/\|ok/g) || []).length === 10, r1);
  chk('applies a second time, still ok', !/CHECK THIS/.test(db.applyFile(SQL)));
  chk('applies as ONE transaction, still ok', !/CHECK THIS/.test(db.applyFileAtomic(SQL)));

  /* who may call it */
  chk('anon cannot acquire', !!db.mustFail(() => db.anon(`select public.odds_quota_acquire('x','k',1);`)));
  chk('authenticated cannot acquire', !!db.mustFail(() => db.as('00000000-0000-0000-0000-000000000001', `select public.odds_quota_acquire('x','k',1);`)));
  chk('authenticated cannot read the ledger', !!db.mustFail(() => db.as('00000000-0000-0000-0000-000000000001', `select count(*) from public.odds_quota_requests;`)));
  chk('anon cannot read the status', !!db.mustFail(() => db.anon(`select public.odds_quota_status();`)));

  /* a normal acquisition, then a settle with the provider's own numbers */
  let a = acq('capture', 'capture:day', 60, 'normal');
  chk('a first request on a key is allowed', a.allowed === true && a.request_id, a);
  let s = settle(a.request_id, 'OK', 54, 9000, 200);
  chk('settling records the cost and the provider balance', s.settled === true && s.provider_remaining === 9000, s);
  chk('a settled row cannot be settled twice', settle(a.request_id, 'OK', 1, 1, 200).settled === false);
  chk('a settled row is never edited', /never edited/.test(db.mustFail(() => db.service(`update public.odds_quota_requests set cost = 0 where request_id = '${a.request_id}';`)) || ''));
  chk('the ledger is never deleted from', /append-only/.test(db.mustFail(() => db.service(`delete from public.odds_quota_requests;`)) || ''));
  chk('the ledger is never truncated', /append-only/.test(db.mustFail(() => db.sql(`truncate public.odds_quota_requests`)) || ''));

  /* cache-first: the same key inside its interval */
  a = acq('capture', 'capture:day', 60, 'normal');
  chk('the same key inside its 1500 s interval is cache_fresh (no request)', a.allowed === false && a.reason === 'cache_fresh' && a.retry_after, a);
  chk('a caller may ask for a longer interval, never a shorter one', acq('capture', 'capture:day', 60, 'normal', 5).reason === 'cache_fresh');
  const b = acq('close', 'close:americanfootball_ncaaf', 6, 'critical');
  chk('a different key is independent', b.allowed === true, b);
  /* coalescing: an identical request already in flight */
  const c = acq('edgedesk_ai', 'close:americanfootball_ncaaf', 6, 'low');
  chk('an identical request in flight is coalesced, not bought twice', c.allowed === false && c.reason === 'coalesced', c);
  settle(b.request_id, 'OK', 6, 8990, 200);

  /* a dead caller: IN_FLIGHT past the TTL is ABANDONED and still counted */
  const d = acq('capture', 'capture:board', 100, 'low');
  age(d.request_id, 400);
  const before = status().spent_today;
  acq('x', 'other:key', 0, 'normal');
  const ab = db.sql(`select status from public.odds_quota_requests where request_id = '${d.request_id}'`);
  chk('a request in flight past the TTL is closed as ABANDONED', ab === 'ABANDONED', ab);
  chk('an abandoned request still counts its estimate', status().spent_today === before, [before, status().spent_today]);

  /* the daily limit and the reserve */
  db.sql(`update public.odds_quota_config set daily_limit = 300, reserve_credits = 100`);
  const spent = status().spent_today;
  const big = acq('capture', 'capture:near', 300 - 100 - spent + 1, 'normal');
  chk('normal work cannot spend the reserve', big.allowed === false && big.reason === 'reserve_held', big);
  const crit = acq('close', 'close:nfl', 300 - 100 - spent + 1, 'critical');
  chk('critical work may spend the reserve', crit.allowed === true, crit);
  settle(crit.request_id, 'OK', null, 8000, 200);
  const over = acq('close', 'close:mlb', 500, 'critical');
  chk('nothing passes the daily limit, critical included', over.allowed === false && over.reason === 'daily_budget', over);
  db.sql(`update public.odds_quota_config set daily_limit = 100000, reserve_credits = 500, monthly_limit = 100000`);

  /* the provider floor */
  db.sql(`update public.odds_quota_state set provider_remaining = 1050`);
  const fl = acq('capture', 'capture:untiered', 100, 'normal');
  chk('the provider balance minus the estimate below the floor holds the request', fl.allowed === false && fl.reason === 'quota_floor', fl);
  const flc = acq('close', 'close:ncaaf2', 100, 'critical');
  chk('critical work has a lower floor', flc.allowed === true, flc);
  settle(flc.request_id, 'OK', 100, 950, 200);
  reset();

  /* 429: breaker open with back-off, then HALF_OPEN after the cool-down */
  let e = acq('capture', 'capture:k429', 6, 'normal');
  s = settle(e.request_id, 'RATE_LIMITED', 0, null, 429);
  chk('a 429 opens the breaker', s.breaker === 'OPEN' && s.open_until, s);
  let f = acq('close', 'close:after429', 6, 'critical');
  chk('while open, every caller is held (critical too), with a retry time', f.allowed === false && f.reason === 'circuit_open' && f.retry_after, f);
  chk('status reports RATE_LIMITED', status().status === 'RATE_LIMITED', status());
  db.sql(`update public.odds_quota_state set open_until = now() - interval '1 second'`);
  f = acq('close', 'close:probe', 6, 'critical');
  chk('after the cool-down one probe is let through (HALF_OPEN)', f.allowed === true && db.sql(`select breaker from public.odds_quota_state`) === 'HALF_OPEN', f);
  const g2 = acq('capture', 'capture:probe2', 6, 'normal');
  chk('a second request waits while the probe is in flight', g2.allowed === false && g2.reason === 'circuit_half_open_probe_in_flight', g2);
  s = settle(f.request_id, 'RATE_LIMITED', 0, null, 429);
  const st2 = J(db.sql(`select row_to_json(s)::text from public.odds_quota_state s`));
  chk('a failed probe re-opens with a longer back-off', s.breaker === 'OPEN' && st2.consecutive_failures === 2, st2);
  db.sql(`update public.odds_quota_state set open_until = now() - interval '1 second'`);
  f = acq('close', 'close:probe3', 6, 'critical');
  s = settle(f.request_id, 'OK', 6, 7000, 200);
  chk('a successful probe closes the breaker and clears the failures', s.breaker === 'CLOSED' && db.sql(`select consecutive_failures from public.odds_quota_state`) === '0', s);

  /* timeouts: three in a row open the breaker */
  for (let i = 0; i < 3; i++) { const t = acq('capture', 'capture:t' + i, 6, 'normal'); settle(t.request_id, 'TIMEOUT', 0, null, 0); }
  chk('three consecutive timeouts open the breaker', db.sql(`select breaker from public.odds_quota_state`) === 'OPEN');
  chk('status reports OUTAGE', status().status === 'OUTAGE', status());
  reset();

  /* exhaustion: a zero balance holds everyone until the reset */
  e = acq('capture', 'capture:ex', 6, 'normal');
  s = settle(e.request_id, 'OK', 6, 0, 200);
  chk('a zero balance is recorded as QUOTA_EXHAUSTED whatever the HTTP status', s.status === 'QUOTA_EXHAUSTED' && s.quota_exhausted_until, s);
  f = acq('close', 'close:ex2', 1, 'critical');
  chk('exhaustion holds every caller, critical included, until the reset', f.allowed === false && f.reason === 'quota_exhausted', f);
  chk('status reports QUOTA_EXHAUSTED', status().status === 'QUOTA_EXHAUSTED');
  const rs = J(db.service(`select public.odds_quota_reset('all', 'owner')::text;`));
  chk('the owner reset clears the hold', rs.status === 'OK', rs);

  chk('the reset forgets the stale zero balance', db.sql(`select coalesce(provider_remaining::text, 'null') from public.odds_quota_state`) === 'null');
  /* an exhaustion hold that runs out by itself (the monthly renewal) */
  e = acq('capture', 'capture:ex3', 6, 'normal');
  settle(e.request_id, 'OK', 6, 0, 200);
  db.sql(`update public.odds_quota_state set quota_exhausted_until = now() - interval '1 second'`);
  f = acq('close', 'close:after_renewal', 1, 'critical');
  chk('when the hold runs out, requests resume and the stale zero is forgotten', f.allowed === true
    && db.sql(`select coalesce(provider_remaining::text, 'null') from public.odds_quota_state`) === 'null', f);
  settle(f.request_id, 'OK', 1, 19999, 200);

  /* 401: the key was refused */
  e = acq('capture', 'capture:auth', 6, 'normal');
  s = settle(e.request_id, 'AUTH_FAILED', 0, null, 401);
  chk('a 401 opens the breaker for the long back-off', s.breaker === 'OPEN', s);
  reset();

  /* research-only mode: nothing is spent, by anyone */
  db.sql(`update public.odds_quota_config set mode = 'RESEARCH_ONLY'`);
  f = acq('close', 'close:ro', 1, 'critical');
  chk('RESEARCH_ONLY denies every live request', f.allowed === false && f.reason === 'research_only', f);
  chk('status reports DISABLED in research-only mode', status().status === 'DISABLED');
  db.sql(`update public.odds_quota_config set mode = 'LIVE'`);

  /* every attempt, allowed or denied, is in the ledger; the daily view adds them up */
  const denied = +db.sql(`select count(*) from public.odds_quota_requests where status = 'DENIED'`);
  chk('every denial is recorded with its reason', denied >= 10 && db.sql(`select count(*) from public.odds_quota_requests where status = 'DENIED' and reason is null`) === '0', denied);
  chk('the daily view reports credits not spent', +db.sql(`select sum(credits_not_spent) from public.odds_quota_daily`) > 0);
  chk('an unknown settle status is refused', /unknown status/.test(db.mustFail(() => db.service(`select public.odds_quota_settle(gen_random_uuid(), 'MAYBE');`)) || ''));
  chk('the interval is the longest matching prefix', db.sql(`select public.odds_quota_interval('close:americanfootball_ncaaf', '{"close":600,"close:americanfootball_ncaaf":60}'::jsonb)`) === '60'
    && db.sql(`select public.odds_quota_interval('closeout', '{"close":600}'::jsonb)`) === '0');

  /* the rollback removes exactly this file */
  const rb = db.applyFile(ROLLBACK);
  chk('the rollback removes every object', /\|ok/.test(rb) && !/CHECK THIS/.test(rb), rb);
  chk('the file applies again after a rollback', !/CHECK THIS/.test(db.applyFile(SQL)));
} catch (e) {
  chk('the suite ran without an unexpected error', false, String(e.message).slice(0, 600));
} finally {
  db.stop();
}
done();
