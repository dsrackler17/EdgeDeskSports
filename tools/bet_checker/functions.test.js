#!/usr/bin/env node
/* ===========================================================================
   log_user_bet and grade_user_bets, AS DEPLOYED, AGAINST THE REAL SQL.

   supabase/functions/log_user_bet/index.ts and grade_user_bets/index.ts are
   imported whole (Node's type stripping, a Deno shim) and driven through the
   PostgREST / Supabase Auth stand-in the billing suites use
   (tools/billing/_pgrest.js) over a throwaway PostgreSQL carrying the
   SHIPPED migrations — so what is tested is what ships, against the grants,
   RLS and functions that ship.

     log_user_bet     the caller is the TOKEN's, never the body's; a grade
                      comes back at once; refusals carry their reason and the
                      right status; the free limit answers with an upgrade
                      prompt and still saves; a double submit is one bet; a
                      database that cannot be reached saves nothing and says so
     grade_user_bets  only the cron secret runs it (constant-time compare);
                      a probe proves the secret without grading; a run grades
                      CLV after the close; no token or secret reaches a log

   Run: node tools/bet_checker/functions.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const REST = require(path.join(__dirname, '..', 'billing', '_pgrest.js'));

const T = PG.kit('bet checker functions');
const chk = T.chk;
const lit = PG.lit;
const ROOT = PG.ROOT;
const DB_URL = 'https://db.test';
const H = 3600 * 1000;

const ENV = { SUPABASE_URL: DB_URL, SUPABASE_ANON_KEY: 'anon-key', SUPABASE_SERVICE_ROLE_KEY: 'service-key', BET_CHECKER_CRON_SECRET: 'cron-s3cret' };
globalThis.Deno = { env: { get: (k) => ENV[k] } };
const logs = [];
const ORIGINAL = { log: console.log, warn: console.warn, error: console.error };
['log', 'warn', 'error'].forEach((lv) => { console[lv] = (...a) => { logs.push(a.join(' ')); if (process.env.VERBOSE) ORIGINAL[lv](...a); }; });
const restoreConsole = () => Object.assign(console, ORIGINAL);

(async () => {
  const db = PG.start('bcfn');
  if (db.skip) { restoreConsole(); if (process.env.BET_CHECKER_SQL_REQUIRED === '1') chk('environment: ' + db.skip, false); console.log('SKIPPED | ' + db.skip + ' — not verified'); process.exit(T.done()); }
  let LOG, GRADE;
  try {
    LOG = await import(path.join(ROOT, 'supabase', 'functions', 'log_user_bet', 'index.ts'));
    GRADE = await import(path.join(ROOT, 'supabase', 'functions', 'grade_user_bets', 'index.ts'));
  } catch (e) {
    restoreConsole(); db.stop();
    if (process.env.BET_CHECKER_SQL_REQUIRED === '1') { chk('environment: the deployed functions import (Node 22+ type stripping): ' + (e && e.message), false); process.exit(T.done()); }
    console.log('SKIPPED | the deployed functions could not be imported: ' + (e && e.message) + ' (needs Node 22+ type stripping) — not verified'); process.exit(0);
  }

  try {
    db.sql('create table public.signals (sig_key text primary key, event_id text, sport_key text, sport_title text, commence_time timestamptz, home_team text, away_team text, ' +
      'market text, selection text, point numeric, sharp_fair numeric, best_dec numeric, best_book text, last_seen_at timestamptz, point_is_modal boolean, is_player_prop boolean not null default false, ' +
      'flagged_at timestamptz, closed_at timestamptz, closing_sharp_fair numeric, clv_excluded_reason text, closing_source text, result text, ' +
      'closing_dec numeric, closing_at_observed timestamptz, clv numeric, beat_close boolean);');
    for (const f of ['bankroll_and_stakes.sql', 'bettor_decisions.sql', 'billing.sql', 'stripe_webhook.sql', 'billing_hardening.sql', 'bet_checker.sql']) {
      db.applyFileAtomic(path.join(ROOT, 'supabase', f));
    }
    const sig = (ev, sel, point, fair, market) => db.sql("insert into public.signals (sig_key, event_id, sport_key, commence_time, home_team, away_team, market, selection, point, sharp_fair, last_seen_at, point_is_modal) values (" +
      [lit(ev + '|' + (market || 'spreads') + '|' + sel + '|' + (point == null ? '' : point)), lit(ev), "'americanfootball_nfl'", "now() + interval '2 days'",
       "'Kansas City Chiefs'", "'Buffalo Bills'", lit(market || 'spreads'), lit(sel), point == null ? 'null' : point, fair, "now() - interval '5 minutes'", 'true'].join(', ') + ');');
    sig('ev1', 'Kansas City Chiefs', -3.5, 0.52);
    sig('ev1', 'Buffalo Bills', 3.5, 0.48);
    db.sql("insert into public.signals (sig_key, event_id, sport_key, commence_time, home_team, away_team, market, selection, point, sharp_fair, last_seen_at) values ('ev0|spreads|Dallas Cowboys|-6.5', 'ev0', 'americanfootball_nfl', now() - interval '1 hour', 'Dallas Cowboys', 'New York Giants', 'spreads', 'Dallas Cowboys', -6.5, 0.5, now());");

    const tokens = {};
    const users = {};
    const mk = (n) => {
      const id = '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
      db.sql("insert into auth.users (id, email) values (" + lit(id) + ", 'u" + n + "@x.co');");
      const token = 'tok_' + n + '_' + crypto.randomBytes(4).toString('hex');
      tokens[token] = { id, email: 'u' + n + '@x.co', confirmed: true };
      return { id, token };
    };
    const A = mk(1), B = mk(2);
    const rest = REST.make(db, { serviceKey: 'service-key', anonKey: 'anon-key', tokens });
    let down = false;
    globalThis.fetch = async (url, init) => {
      if (down) throw new Error('connect ECONNREFUSED');
      if (String(url).indexOf(DB_URL) === 0) return rest.fetch(String(url), init);
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    };
    const req = (fn, method, body, headers) => new Request('https://fn.test/functions/v1/' + fn, { method,
      headers: Object.assign({ 'content-type': 'application/json', apikey: 'anon-key' }, headers || {}),
      body: method === 'POST' ? JSON.stringify(body || {}) : undefined });
    const call = async (handler, fn, method, body, headers) => {
      const res = await handler(req(fn, method, body, headers));
      let j = null; try { j = await res.json(); } catch (_) { j = null; }
      return { status: res.status, body: j, headers: res.headers };
    };
    const asUser = (u) => ({ authorization: 'Bearer ' + u.token });
    const key = () => crypto.randomBytes(8).toString('hex');
    const bet = (o) => Object.assign({ event_id: 'ev1', market: 'spread', side: 'home', line: -3.5, odds: 105, book: 'DraftKings', stake_units: 1, client_key: key() }, o || {});

    /* ===================================================================== */
    /* log_user_bet                                                          */
    /* ===================================================================== */
    let r = await call(LOG.handle, 'log_user_bet', 'GET');
    chk('GET is a health probe with the build', r.status === 200 && r.body.build === LOG.BUILD && r.body.configured.database === true && r.headers.get('x-edgedesk-build') === LOG.BUILD, r.body);
    r = await call(LOG.handle, 'log_user_bet', 'OPTIONS');
    chk('CORS preflight answers', r.status === 200 && /authorization/.test(r.headers.get('access-control-allow-headers') || ''));
    r = await call(LOG.handle, 'log_user_bet', 'POST', bet());
    chk('no token: 401, sign in', r.status === 401 && r.body.reason === 'sign_in_required');
    r = await call(LOG.handle, 'log_user_bet', 'POST', bet(), { authorization: 'Bearer anon-key' });
    chk('the anon key is not an account: 401', r.status === 401);

    r = await call(LOG.handle, 'log_user_bet', 'POST', bet({ user_id: B.id, p_user: B.id }), asUser(A));
    chk('a green grade comes back at once', r.status === 200 && r.body.ok && r.body.grade === 'green' && r.body.edge_pct === 3.22 && r.body.fair_price === -108, r.body);
    chk('the bet is the TOKEN\'s, never the body\'s', db.sql('select user_id from public.user_bets where id = ' + lit(r.body.bet.id)) === A.id);
    chk('the card carries what the page draws, and never a flag before kickoff', r.body.bet.market === 'spread' && r.body.bet.team === 'Kansas City Chiefs' &&
      r.body.bet.close_status === 'pending' && r.body.bet.edgedesk_flagged === false && !('entry_sig_key' in r.body.bet), r.body.bet);
    chk('the usage and the thresholds ride along', r.body.usage && r.body.usage.free_grades_used === 1 && r.body.rules && Number(r.body.rules.green_min_edge_pct) === 1.5, r.body);

    const k = key();
    const r1 = await call(LOG.handle, 'log_user_bet', 'POST', bet({ client_key: k, odds: -110 }), asUser(A));
    const r2 = await call(LOG.handle, 'log_user_bet', 'POST', bet({ client_key: k, odds: -110 }), asUser(A));
    chk('a double submit is one bet', r1.body.bet.id === r2.body.bet.id && r2.body.replay === true && r1.body.grade === 'yellow');

    r = await call(LOG.handle, 'log_user_bet', 'POST', bet({ line: -2.5 }), asUser(A));
    chk('no fair at that exact line: saved, ungraded, with the reason, and no price', r.status === 200 && r.body.grade === 'ungraded' && r.body.reason === 'no_fair_price_at_line' && r.body.fair_price === null, r.body);
    r = await call(LOG.handle, 'log_user_bet', 'POST', bet({ event_id: 'ev0', line: -6.5 }), asUser(A));
    chk('a started game: 409 with the database\'s own words', r.status === 409 && r.body.reason === 'game_started' && /started/.test(r.body.message), r.body);
    r = await call(LOG.handle, 'log_user_bet', 'POST', bet({ event_id: 'nowhere' }), asUser(A));
    chk('a game not on the board: 404', r.status === 404 && r.body.reason === 'no_such_game');
    for (const [bad, why] of [[{ market: 'teaser' }, 'market'], [{ side: 'over' }, 'side'], [{ line: null }, 'line'], [{ odds: -50 }, 'odds'], [{ odds: 'abc' }, 'odds text'],
      [{ stake_units: 0 }, 'stake'], [{ client_key: 'x' }, 'client key'], [{ event_id: '' }, 'game']]) {
      r = await call(LOG.handle, 'log_user_bet', 'POST', bet(bad), asUser(A));
      chk('a malformed ' + why + ' is a 400 with a sentence, before the database', r.status === 400 && r.body.reason === 'bad_input' && r.body.message.length > 8, r.body);
    }
    r = await call(LOG.handle, 'log_user_bet', 'POST', bet({ book: 'FanDuel' }), asUser(A));
    chk('a book Bet Checker does not list: refused by the database', r.status === 400 && /Kalshi/.test(r.body.message), r.body);
    r = await call(LOG.handle, 'log_user_bet', 'POST', bet({ market: 'moneyline', side: 'away', line: 3 }), asUser(A));
    chk('a moneyline with no board row at all: saved ungraded (the line is ignored)', r.status === 200 && r.body.bet.line === null && r.body.grade === 'ungraded');

    /* the free limit, through the function */
    for (let i = 0; i < 8; i++) await call(LOG.handle, 'log_user_bet', 'POST', bet(), asUser(A));
    const used = JSON.parse(db.service('select public.bet_checker_usage(' + lit(A.id) + ');'));
    r = await call(LOG.handle, 'log_user_bet', 'POST', bet(), asUser(A));
    chk('the eleventh graded bet of the month: saved, ungraded, upgrade prompt', used.free_grades_used === 10 && r.status === 200 && r.body.upgrade === true &&
      r.body.grade === 'ungraded' && r.body.reason === 'free_limit_reached' && r.body.fair_price === null && r.body.usage.free_remaining === 0, [used, r.body]);

    const nBefore = db.sql('select count(*) from public.user_bets;');
    down = true;
    r = await call(LOG.handle, 'log_user_bet', 'POST', bet(), asUser(A));
    down = false;
    chk('auth unreachable: 401, nothing saved', r.status === 401 && db.sql('select count(*) from public.user_bets;') === nBefore);
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => (String(url).indexOf('/rest/v1/') >= 0 ? Promise.reject(new Error('down')) : realFetch(url, init));
    r = await call(LOG.handle, 'log_user_bet', 'POST', bet(), asUser(A));
    globalThis.fetch = realFetch;
    chk('the database unreachable: 503, nothing saved, and it says so', r.status === 503 && r.body.reason === 'unavailable' && /Nothing was saved/.test(r.body.message) &&
      db.sql('select count(*) from public.user_bets;') === nBefore, r.body);

    /* ===================================================================== */
    /* grade_user_bets                                                       */
    /* ===================================================================== */
    r = await call(GRADE.handle, 'grade_user_bets', 'GET');
    chk('GET is a public health probe: the build, configured, nothing else', r.status === 200 && r.body.build === GRADE.BUILD && r.body.configured.cron_secret === true &&
      Object.keys(r.body).sort().join() === 'build,configured,ok,service', r.body);
    r = await call(GRADE.handle, 'grade_user_bets', 'POST', {});
    chk('no secret: 401', r.status === 401);
    r = await call(GRADE.handle, 'grade_user_bets', 'POST', {}, { 'x-cron-secret': 'cron-s3crex' });
    chk('the wrong secret: 401', r.status === 401);
    r = await call(GRADE.handle, 'grade_user_bets', 'POST', {}, { authorization: 'Bearer ' + A.token });
    chk('a reader\'s token is not the secret: 401', r.status === 401);
    chk('constant-time compare: equal only when equal, never on empty', GRADE.safeEqual('a', 'a') && !GRADE.safeEqual('a', 'b') && !GRADE.safeEqual('', '') && !GRADE.safeEqual('ab', 'a'));
    r = await call(GRADE.handle, 'grade_user_bets', 'POST', { probe: true }, { 'x-cron-secret': 'cron-s3cret' });
    chk('a probe proves the secret and grades nothing', r.status === 200 && r.body.probe === true && db.sql('select count(*) from public.bet_checker_grade_runs;') === '0', r.body);

    /* kickoff passes, close runs, settle grades */
    const gid = db.sql("select id from public.user_bets where user_id = " + lit(A.id) + " and entry_grade = 'green' order by created_at limit 1");
    db.sql("set session_replication_role = replica; update public.user_bets set kickoff = now() - interval '1 hour' where event_id = 'ev1'; " +
      "update public.signals set commence_time = now() - interval '1 hour' where event_id = 'ev1'; set session_replication_role = default;");
    db.sql("update public.signals set closed_at = now(), closing_sharp_fair = 0.55, closing_source = 'live' where sig_key = 'ev1|spreads|Kansas City Chiefs|-3.5';");
    r = await call(GRADE.handle, 'grade_user_bets', 'POST', { source: 'test' }, { 'x-cron-secret': 'cron-s3cret' });
    chk('a run grades: closes captured, and it is on record', r.status === 200 && r.body.ok && r.body.result.closes_captured >= 1 &&
      db.sql("select count(*) from public.bet_checker_grade_runs where source = 'test';") === '1', r.body);
    chk('the green bet now has its CLV: +12.75%', db.sql('select close_status || \'|\' || clv_pct from public.user_bets where id = ' + lit(gid)) === 'captured|12.75');
    r = await call(GRADE.handle, 'grade_user_bets', 'POST', { limit: 'lots' }, { 'x-cron-secret': 'cron-s3cret' });
    chk('a second run: 200, and nothing new captured', r.status === 200 && r.body.result.closes_captured === 0, r.body);
    delete ENV.BET_CHECKER_CRON_SECRET;
    r = await call(GRADE.handle, 'grade_user_bets', 'POST', {}, { 'x-cron-secret': '' });
    chk('a function deployed without its secret refuses every POST, and says why', r.status === 401 && /not set/.test(r.body.reason), r.body);
    ENV.BET_CHECKER_CRON_SECRET = 'cron-s3cret';

    chk('no token, key or secret reached a log line', !logs.some((l) => /tok_\d+_|service-key|cron-s3cret|Bearer /.test(l)), logs.filter((l) => /tok_|service-key|s3cret|Bearer/.test(l)).slice(0, 2));
    chk('both functions are one file each, importing nothing', ['log_user_bet', 'grade_user_bets'].every((n) =>
      !/^\s*import\s/m.test(fs.readFileSync(path.join(ROOT, 'supabase', 'functions', n, 'index.ts'), 'utf8'))));
  } catch (e) {
    chk('the suite ran to the end', false, String(e && e.stack || e).slice(0, 1500));
  } finally {
    db.stop();
    restoreConsole();
  }
  process.exit(T.done());
})();
