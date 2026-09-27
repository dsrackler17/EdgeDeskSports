#!/usr/bin/env node
/* ===========================================================================
   Provider policy and contract tests (football/cfb_lab/providers.js,
   docs/cfb-production/PROVIDERS.md).

   - every provider has a complete policy (importance, timeout, retries, rate
     limit, latency, required fields, fallback, stale threshold, breaker);
   - errors are classified: timeout / network / 429 / 5xx are retried with a
     bounded, jittered exponential backoff; auth, schema, malformed and
     permanent 4xx never are; each maps to the shared taxonomy code;
   - the circuit breaker: CLOSED -> OPEN after N consecutive failures, OPEN
     blocks without calling, HALF_OPEN after the cooldown, a success closes it,
     a failed trial re-opens it with a doubled (bounded) cooldown;
   - a call that hangs is aborted by its timeout (chaos: provider timeout);
   - CONTRACT TESTS on representative fixture payloads
     (fixtures/providers/): ESPN pregame / results / schema drift / not JSON,
     The Odds API clean / schema drift / impossible values, the CFBD line
     ledger, the cfbfastR schedule. Drift is rejected and logged; nothing
     missing is ever read as zero;
   - the lab's ESPN fetch runs through the guard (retries, then the breaker).

   Run: node football/cfb_lab/providers.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const P = require('./providers.js');
const MK = require('./market.js');
const ST = require('./settle.js');
const SRC = require(path.join(__dirname, '..', '..', 'tools', 'record', 'football_record_sources.js'));

let pass = 0, fail = 0; const fails = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; fails.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); } }
const FX = (f) => path.join(__dirname, 'fixtures', 'providers', f);
const json = (f) => JSON.parse(fs.readFileSync(FX(f), 'utf8'));
const noSleep = () => Promise.resolve();

(async () => {
  /* ═══ 1. the register ═══════════════════════════════════════════════ */
  const need = ['label', 'importance', 'timeout_ms', 'retries', 'backoff_ms', 'rate_limit', 'expected_latency_ms', 'required', 'fallback', 'stale_h', 'breaker'];
  const names = Object.keys(P.POLICIES);
  chk('every provider documents every policy field', names.every((n) => need.every((k) => P.POLICIES[n][k] != null)), names.filter((n) => need.some((k) => P.POLICIES[n][k] == null)));
  chk('importance is CRITICAL, HIGH_VALUE or OPTIONAL', names.every((n) => ['CRITICAL', 'HIGH_VALUE', 'OPTIONAL'].includes(P.POLICIES[n].importance)));
  chk('the market and the schedule are CRITICAL; weather is OPTIONAL', P.POLICIES.odds_api.importance === 'CRITICAL' && P.POLICIES.espn_scoreboard.importance === 'CRITICAL' && P.POLICIES.weather.importance === 'OPTIONAL');
  chk('retries are bounded (<= 3) and backoff is capped', names.every((n) => P.POLICIES[n].retries <= 3 && P.POLICIES[n].backoff_ms[1] <= 30000));

  /* ═══ 2. classification ═════════════════════════════════════════════ */
  const C = (x) => P.classify(x);
  chk('429 is RATE_LIMIT; 500/502/503/504/408 are TRANSIENT', C(429) === 'RATE_LIMIT' && [500, 502, 503, 504, 408].every((s) => C(s) === 'TRANSIENT'));
  chk('401/403 are AUTH; 400/404/422 are PERMANENT', C(401) === 'AUTH' && C(403) === 'AUTH' && [400, 404, 422].every((s) => C(s) === 'PERMANENT'));
  const abort = new Error('The operation was aborted'); abort.name = 'AbortError';
  chk('an aborted fetch is a TIMEOUT', C(abort) === 'TIMEOUT');
  chk('a reset connection is NETWORK', C(new Error('read ECONNRESET')) === 'NETWORK' && C(new TypeError('fetch failed')) === 'NETWORK');
  chk('a schema error is SCHEMA and never retryable', C(new P.SchemaError('x')) === 'SCHEMA' && !P.retryable('SCHEMA') && !P.retryable('AUTH') && !P.retryable('PERMANENT'));
  chk('an "HTTP 503" message is TRANSIENT, "HTTP 401" AUTH', C(new Error('HTTP 503')) === 'TRANSIENT' && C(new Error('HTTP 401')) === 'AUTH');
  chk('each class maps to the shared taxonomy code', P.taxonomyCode('SCHEMA') === 'PROVIDER_SCHEMA' && P.taxonomyCode('RATE_LIMIT') === 'PROVIDER_RATE_LIMIT'
    && P.taxonomyCode('TIMEOUT') === 'PROVIDER_TRANSIENT' && P.taxonomyCode('AUTH') === 'AUTH' && P.taxonomyCode('PERMANENT') === 'PROVIDER_REJECTED');

  /* ═══ 3. bounded retries ════════════════════════════════════════════ */
  {
    let n = 0; const waits = [];
    const r = await P.withRetry(async () => { n++; if (n < 3) throw new P.ProviderError('HTTP 503', 'TRANSIENT'); return 'ok'; }, { retries: 2, backoff_ms: [1000, 8000] }, { sleep: (ms) => { waits.push(ms); return noSleep(); }, rand: () => 1 });
    chk('a transient 5xx is retried and then succeeds', r.ok && r.value === 'ok' && r.attempts === 3 && n === 3, r);
    chk('backoff is exponential: 1000 then 2000 ms (jitter at its maximum)', JSON.stringify(waits) === '[1000,2000]', waits);
  }
  {
    let n = 0;
    const e = await P.withRetry(async () => { n++; throw new P.ProviderError('HTTP 503', 'TRANSIENT'); }, { retries: 2, backoff_ms: [10, 20] }, { sleep: noSleep }).catch((x) => x);
    chk('retries stop at the bound (1 + 2 attempts) and the error carries its class and history', n === 3 && e.class === 'TRANSIENT' && e.attempts === 3 && e.errors.length === 3, { n, cls: e.class });
  }
  for (const [label, err] of [['401 authentication', new P.ProviderError('HTTP 401', 'AUTH')], ['a schema failure', new P.SchemaError('no events[]')], ['a 422 malformed request', new P.ProviderError('HTTP 422', 'PERMANENT')]]) {
    let n = 0;
    const e = await P.withRetry(async () => { n++; throw err; }, { retries: 3, backoff_ms: [1, 1] }, { sleep: noSleep }).catch((x) => x);
    chk(label + ' is never retried', n === 1 && e.attempts === 1, { n });
  }
  {
    const waits = []; let n = 0;
    await P.withRetry(async () => { n++; if (n === 1) throw new P.ProviderError('HTTP 429', 'RATE_LIMIT', { retryAfter: 120 }); return 1; }, { retries: 2, backoff_ms: [1000, 8000] }, { sleep: (ms) => { waits.push(ms); return noSleep(); } });
    chk('429 honours Retry-After but never beyond the policy cap (120 s -> 8 s)', waits[0] === 8000, waits);
  }
  {
    const w = []; for (let i = 0; i < 6; i++) w.push(P.backoffMs(i, { backoff_ms: [1000, 8000] }, () => 0));
    chk('jitter keeps each wait in [50%, 100%] of the capped exponential', JSON.stringify(w) === '[500,1000,2000,4000,4000,4000]', w);
  }

  /* ═══ 4. circuit breaker ════════════════════════════════════════════ */
  {
    const b = new P.Breaker('odds_api', { breaker: { failures: 3, cooldown_min: 30 } });
    const t0 = '2026-10-01T12:00:00.000Z', at = (m) => new Date(Date.parse(t0) + m * 60000).toISOString();
    b.failure(at(0), new Error('HTTP 503')); b.failure(at(1), new Error('HTTP 503'));
    chk('two failures: still CLOSED', b.s.state === 'CLOSED' && b.allow(at(2)));
    b.failure(at(2), new Error('HTTP 503'));
    chk('the third consecutive failure OPENS it', b.s.state === 'OPEN' && b.s.opened_at === at(2));
    chk('OPEN: calls are refused before the cooldown', !b.allow(at(10)) && !b.allow(at(31)));
    chk('after the cooldown one trial is allowed (HALF_OPEN)', b.allow(at(32)) && b.s.state === 'HALF_OPEN');
    b.failure(at(33), new Error('HTTP 503'));
    chk('a failed trial re-opens it with a doubled cooldown', b.s.state === 'OPEN' && b.s.cooldown_min === 60 && !b.allow(at(80)) && b.allow(at(94)));
    b.success(at(95));
    chk('a success closes it and clears the failure run', b.s.state === 'CLOSED' && b.s.consecutive_failures === 0 && b.s.last_success_at === at(95));
    const saved = JSON.parse(JSON.stringify(b.snapshot()));
    const b2 = new P.Breaker('odds_api', { breaker: { failures: 3, cooldown_min: 30 } }, saved);
    chk('state round-trips through JSON (persisted between hourly runs)', b2.s.state === 'CLOSED' && b2.s.calls === b.s.calls && b2.s.last_error_class === 'TRANSIENT');
    const b3 = new P.Breaker('x', { breaker: { failures: 1, cooldown_min: 30 } });
    b3.failure(at(0), new Error('HTTP 401'));
    chk('repeated authentication failure also opens the breaker (stop hammering)', b3.s.state === 'OPEN' && b3.s.last_error_class === 'AUTH');
  }

  /* ═══ 5. guarded(): timeout, retry, breaker (chaos: provider timeout) ══ */
  {
    const hang = (signal) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }); });
    const r = await P.guarded('t', hang, { policy: { timeout_ms: 30, retries: 1, backoff_ms: [1, 1], breaker: { failures: 2, cooldown_min: 30 } }, sleep: noSleep, now: '2026-10-01T12:00:00.000Z' });
    chk('a provider that hangs is aborted by its timeout, retried once, then reported as TIMEOUT', !r.ok && r.class === 'TIMEOUT' && r.attempts === 2 && r.retries.length === 2, r);
    chk('a failed guarded call is recorded on the breaker', r.breaker.consecutive_failures === 1 && r.breaker.state === 'CLOSED');
    let called = 0;
    const openState = Object.assign(P.newBreakerState(), { state: 'OPEN', opened_at: '2026-10-01T11:50:00.000Z', cooldown_min: 30, last_error: 'HTTP 503', last_error_class: 'TRANSIENT' });
    const r2 = await P.guarded('t', async () => { called++; return 1; }, { policy: { timeout_ms: 30, retries: 1, backoff_ms: [1, 1] }, breakerState: openState, now: '2026-10-01T12:00:00.000Z' });
    chk('with the breaker OPEN the provider is not called at all', !r2.ok && r2.skipped && r2.class === 'CIRCUIT_OPEN' && called === 0, r2);
  }

  /* ═══ 6. contract: ESPN ════════════════════════════════════════════ */
  {
    const pre = P.validateEspnScoreboard(json('espn_scoreboard_pregame.json'), { use: 'quotes', requireDate: true });
    chk('ESPN pregame fixture: every event passes the quotes contract', pre.ok && pre.events.length === 4 && pre.rejected.length === 0, pre.problems);
    const quotes = MK.quotesFromEspn({ events: pre.events }, '2026-10-08T12:00:00.000Z', {});
    const sp = (id) => quotes.find((q) => q.game_id === id && q.market_type === 'spread' && !q.is_provider_open);
    chk('home favourite: TEX -6.5 is home_line -6.5', sp('401900001').home_line === -6.5);
    chk('road favourite: MIA -17.5 at Miami (OH) is home_line +17.5 (never swapped)', sp('401900002').home_line === 17.5, sp('401900002'));
    chk("pick'em: EVEN is home_line 0 (a real zero)", sp('401900003').home_line === 0);
    chk('an in-progress game gives no quote (no live odds)', !quotes.some((q) => q.game_id === '401900004'));
    chk('the declared opener is kept apart (is_provider_open)', quotes.some((q) => q.game_id === '401900001' && q.is_provider_open && q.home_line === -7));
    const drift = P.validateEspnScoreboard(json('espn_scoreboard_schema_drift.json'), { use: 'quotes' });
    const why = Object.fromEntries(drift.rejected.map((x) => [x.id, x.problems.join('; ')]));
    chk('schema drift: an event without team abbreviations is rejected (the line cannot be oriented)', /abbreviation/.test(why['401900010'] || ''), why);
    chk('schema drift: an event without a state is rejected', /state/.test(why['401900011'] || ''));
    chk('schema drift: two home teams are rejected', /exactly one home/.test(why['401900012'] || ''));
    chk('schema drift: the clean events still count', drift.events.some((e) => e.id === '401900013'));
    const res = P.validateEspnScoreboard(json('espn_scoreboard_schema_drift.json'), { use: 'results' });
    chk('schema drift: a FINAL without scores is rejected for settlement', res.rejected.some((x) => x.id === '401800020' && /score missing/.test(x.problems.join(';'))), res.rejected);
    chk('a payload without events[] is rejected whole', !P.validateEspnScoreboard({ leagues: [] }).ok && !P.validateEspnScoreboard(null).ok);
    const refused = [];
    const rd = ST.espnReadings([json('espn_scoreboard_results.json')], refused);
    chk('results fixture: a regulation final', rd['401800001'] && rd['401800001'].status === 'FINAL' && rd['401800001'].home_points === 31 && rd['401800001'].overtime === false);
    chk('results fixture: a double-overtime final keeps the OT score and overtime=true', rd['401800002'] && rd['401800002'].home_points === 45 && rd['401800002'].away_points === 38 && rd['401800002'].overtime === true);
    chk('results fixture: postponed and canceled are recognised (canceled 0-0 is never a FINAL)', rd['401800003'].status === 'POSTPONED' && rd['401800004'].status === 'CANCELED' && rd['401800004'].home_points === null);
    chk('results fixture: a suspended game with completed=true is NOT settled', !rd['401800005'] && refused.some((x) => x.game_id === '401800005' && /not a final state/.test(x.reason)), refused);
    chk('results carry the kickoff ESPN reports (the settlement kickoff authority)', rd['401800001'].kickoff_ts === '2026-10-03T16:00:00.000Z');
  }

  /* ═══ 7. contract: The Odds API (through the capture function) ═══════ */
  {
    process.env.CAPTURE_NO_SERVE = '1';
    globalThis.Deno = globalThis.Deno || { env: { get: (k) => process.env[k] } };
    const CAP = await import(path.join(__dirname, '..', '..', 'supabase', 'functions', 'capture', 'index.ts'));
    const NOWMS = Date.parse('2026-10-08T12:00:00Z'), NOW = new Date(NOWMS).toISOString();
    const clean = P.validateOddsApiEvents(json('odds_api_ncaaf.json'));
    chk('Odds API fixture passes the contract', clean.ok && clean.events.length === 2 && clean.markets_rejected === 0, clean.problems);
    const out = CAP.cfbLabQuotes(json('odds_api_ncaaf.json'), NOW, NOWMS);
    const q = (book, mt, ev) => out.quotes.find((x) => x.book === book && x.market_type === mt && x.provider_event_id === (ev || 'oa_tex_ou'));
    chk('capture: home line -6.5, prices -110/-110 (decimal 1.91)', q('draftkings', 'spread').home_line === -6.5 && q('draftkings', 'spread').price_home === -110);
    chk('capture: road favourite Miami at Miami (OH) is home_line +17.5', q('draftkings', 'spread', 'oa_mia_moh').home_line === 17.5);
    chk('capture: nothing quarantined in a clean payload', out.quarantined.length === 0, out.quarantined);
    const drift = P.validateOddsApiEvents(json('odds_api_ncaaf_schema_drift.json'));
    chk('schema drift: a null spread point, a missing total point, a string price and a missing kickoff are all named',
      drift.markets_rejected === 3 && drift.rejected.length === 1 && drift.problems.some((p) => /point missing/.test(p)) && drift.problems.some((p) => /price missing or not a decimal/.test(p)), drift.problems);
    const dq = CAP.cfbLabQuotes(json('odds_api_ncaaf_schema_drift.json'), NOW, NOWMS);
    chk('capture: a null spread point is SKIPPED, never a pick\'em (Number(null) === 0 is the bug)',
      !dq.quotes.some((x) => x.book === 'draftkings' && x.market_type === 'spread') && dq.skipped['spread point missing (schema: never read as 0)'] === 1, dq.skipped);
    chk('capture: a missing total point is skipped, never a total of 0', !dq.quotes.some((x) => x.market_type === 'total' && x.book === 'fanduel') && !dq.quotes.some((x) => x.total_points === 0));
    chk('capture: an event without a kickoff sends nothing', !dq.quotes.some((x) => x.provider_event_id === 'oa_mia_moh'));
    const bad = CAP.cfbLabQuotes(json('odds_api_ncaaf_impossible.json'), NOW, NOWMS);
    const qr = (book, mt) => bad.quarantined.find((x) => x.book === book && x.market_type === mt);
    chk('capture: a +450 spread is quarantined with SPREAD_OUT_OF_BOUNDS, never sent', qr('draftkings', 'spread') && qr('draftkings', 'spread').reasons.includes('SPREAD_OUT_OF_BOUNDS')
      && !bad.quotes.some((x) => x.book === 'draftkings' && x.market_type === 'spread'), bad.quarantined);
    chk('capture: decimal 1.0 (American 0) is no price at all (never 0)', !bad.quotes.concat(bad.quarantined).some((x) => x.price_home === 0 || x.price_away === 0));
    chk('capture: identical moneyline prices with both sides favoured are quarantined', qr('betmgm', 'moneyline') && qr('betmgm', 'moneyline').reasons.includes('IDENTICAL_SIDE_PRICES'));
    /* the capture copy of the hard rules reproduces every shared case */
    const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'integrity_rules.json'), 'utf8'));
    const mism = FIX.quote_cases.filter((c) => JSON.stringify(CAP.cfbQuoteProblems(c.quote, Date.parse(FIX.now)).slice().sort()) !== JSON.stringify(c.expected.slice().sort()));
    chk('capture cfbQuoteProblems reproduces every shared integrity case (' + FIX.quote_cases.length + ')', mism.length === 0, mism.slice(0, 3).map((c) => [c.why, CAP.cfbQuoteProblems(c.quote, Date.parse(FIX.now))]));
    chk('capture strictNum: null, undefined, "", "abc" and true are not numbers', [null, undefined, '', 'abc', true].every((v) => CAP.strictNum(v) === null) && CAP.strictNum('-3.5') === -3.5 && CAP.strictNum(0) === 0);
  }

  /* ═══ 8. contract: CFBD ledger and cfbfastR ════════════════════════ */
  {
    const rows = fs.readFileSync(FX('cfbd_lines.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    chk('CFBD ledger fixture passes the row contract', rows.every((r) => P.validateCfbdLineRow(r).length === 0));
    const drift = fs.readFileSync(FX('cfbd_lines_schema_drift.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse).map(P.validateCfbdLineRow);
    chk('CFBD drift: no observed_at, a line as text, no line at all are each rejected', /observed_at/.test(drift[0].join()) && /not a number/.test(drift[1].join()) && /no line/.test(drift[2].join()), drift);
    const csv = fs.readFileSync(FX('cfbfastr_schedule.csv'), 'utf8');
    chk('cfbfastR fixture carries every required column', P.validateCfbfastrHeader(csv).length === 0);
    chk('cfbfastR drift: renamed columns are named as missing', P.validateCfbfastrHeader(fs.readFileSync(FX('cfbfastr_schedule_schema_drift.csv'), 'utf8')).join() === 'game_id,home_team,home_points,away_team,away_points', P.validateCfbfastrHeader(fs.readFileSync(FX('cfbfastr_schedule_schema_drift.csv'), 'utf8')));
    const refused = [];
    const cr = ST.cfbfastrReadings(csv, 2026, refused);
    chk('cfbfastR: finals read, an unplayed game has no final, a 0-0 "final" is refused', cr['401800001'].home_points === 31 && !cr['401800003'] && !cr['401800006'] && refused.some((x) => x.game_id === '401800006' && /tied/.test(x.reason)), { cr, refused });
  }

  /* ═══ 9. the lab's ESPN fetch runs through the guard ═══════════════ */
  {
    let calls = 0;
    const flaky = async () => { calls++; if (calls % 2 === 1) { const e = new Error('read ECONNRESET'); throw e; } return JSON.stringify(json('espn_scoreboard_pregame.json')); };
    const pl = await MK.fetchEspn('2026-10-08T12:00:00.000Z', { back: 0, fwd: 1, fetchText: flaky, sleep: noSleep });
    chk('a reset connection is retried and the payload arrives', pl.length === 2 && pl.every((p) => !p.error && p.events.length === 4) && calls === 4, { calls, errs: pl.map((p) => p.error) });
    let c2 = 0;
    const down = async () => { c2++; throw new P.ProviderError('HTTP 503', 'TRANSIENT'); };
    const pl2 = await MK.fetchEspn('2026-10-08T12:00:00.000Z', { back: 0, fwd: 4, fetchText: down, sleep: noSleep });
    chk('ESPN down: bounded retries per date, then the breaker OPENS and later dates are not requested',
      pl2.breaker.state === 'OPEN' && c2 === 9 && pl2.every((p) => p.error) && pl2.slice(3).every((p) => /CIRCUIT_OPEN/.test(p.error)), { c2, br: pl2.breaker.state, e: pl2.map((p) => p.error) });
    const nj = await MK.fetchEspn('2026-10-08T12:00:00.000Z', { back: 0, fwd: 0, fetchText: async () => fs.readFileSync(FX('espn_scoreboard_not_json.txt'), 'utf8'), sleep: noSleep });
    chk('an HTML error page instead of JSON is a SCHEMA failure, not retried', nj[0].error_class === 'SCHEMA' && /SCHEMA/.test(nj[0].error));
    chk('record source: the ESPN scoreboard URL is the one the record uses', /site\.api\.espn\.com/.test(SRC.espnScoreboardUrl('cfb', '20261010')));
  }

  fails.forEach((f) => console.log('FAIL | ' + f));
  console.log((fail ? 'FAILED ' : 'ALL GREEN ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
