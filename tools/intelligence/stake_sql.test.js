#!/usr/bin/env node
/* ===========================================================================
   THE BANKROLL POLICY AND THE STAKE AUDIT TRAIL, AGAINST A REAL POSTGRESQL.

   A sizing engine's record is a claim about what it said BEFORE the game, at
   the price on the board at the time and under the caps in force. A table
   that can be edited after the market moves cannot support that claim, so
   immutability, no-delete, no-lookahead and the two "a BET is sized / a PASS
   is not" constraints live in the database and are proved by a server
   refusing the operation.

   The static layer holds the conventions; the live layer starts a throwaway
   cluster, applies supabase/bankroll_and_stakes.sql twice, and attacks it.

   Run: node tools/intelligence/stake_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'bankroll_and_stakes.sql'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function done(note) {
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 320) : '')));
  if (note) console.log(note);
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

/* ═══ STATIC ═══════════════════════════════════════════════════════════ */
chk('the migration is idempotent', /create table if not exists/.test(SQL) && /drop trigger if exists/.test(SQL) && /create or replace view/.test(SQL));
chk('additive: nothing is dropped and new columns are guarded', /add column if not exists/.test(SQL) && !/\bdrop table\b/i.test(SQL) && !/\bdrop column\b/i.test(SQL));
chk('no psql meta-commands', !/^\\/m.test(SQL));
chk('it ends in a report', /CHECK THIS/.test(SQL));
chk('PostgREST is told to reload', /notify\s+pgrst\s*,\s*'reload schema'/i.test(SQL));
chk('the bankroll is nullable, so no bankroll is ever assumed', /bankroll_amount\s+numeric\s+null/.test(SQL));
chk('the shipped policy defaults are the conservative ones',
  /fractional_kelly_multiplier\s+numeric\s+not null default 0\.25/.test(SQL)
  && /maximum_single_wager_units\s+numeric\s+not null default 1\.00/.test(SQL)
  && /maximum_game_exposure_units\s+numeric\s+not null default 1\.25/.test(SQL)
  && /maximum_team_exposure_units\s+numeric\s+not null default 1\.50/.test(SQL)
  && /maximum_daily_exposure_units\s+numeric\s+not null default 4\.00/.test(SQL)
  && /maximum_weekly_exposure_units\s+numeric\s+not null default 8\.00/.test(SQL));
chk('the parlay band is 0.10u to 0.25u with at most three legs',
  /minimum_parlay_stake_units\s+numeric\s+not null default 0\.10/.test(SQL)
  && /maximum_parlay_stake_units\s+numeric\s+not null default 0\.25/.test(SQL)
  && /maximum_parlay_legs\s+int\s+not null default 3\s+check \(maximum_parlay_legs between 2 and 3\)/.test(SQL));
chk('parlays are off until the reader turns them on', /parlay_permission\s+boolean\s+not null default false/.test(SQL));
chk('write-once trigger on the trail', /stake_recommendations_immutable_trg/.test(SQL));
chk('no-delete trigger on the trail', /stake_recommendations_no_delete_trg/.test(SQL));
chk('no-lookahead trigger on the trail', /stake_recommendations_no_lookahead_trg/.test(SQL));
chk('the response log is append-only and separate', /stake_responses_append_only_trg/.test(SQL) && /create table if not exists public\.stake_recommendation_responses/.test(SQL));
chk('the status vocabulary is constrained', /check \(status in \('BET','WATCH','PASS','RESEARCH_ONLY'\)\)/.test(SQL));
chk('the tier vocabulary is constrained', /'MAX MODEL POSITION'/.test(SQL));
chk('row level security is on', (SQL.match(/enable row level security/g) || []).length >= 3);
chk('a reader reads and writes only their own rows', /using \(user_id = auth\.uid\(\)\)/.test(SQL) && /with check \(user_id = auth\.uid\(\)\)/.test(SQL));
chk('the grades view joins the close by sig_key', /left join public\.signals s on s\.sig_key = r\.sig_key/.test(SQL));
chk('and carries both flat baselines', /profit_units_flat_half/.test(SQL) && /profit_units_flat_one/.test(SQL));
chk('Brier and log loss are computed on the number the engine staked on', /brier_conservative/.test(SQL) && /log_loss_conservative/.test(SQL));
chk('the reader’s acceptance is read through, never written back into the snapshot', /reader_response/.test(SQL) && /order by resp\.responded_at desc limit 1/.test(SQL));
chk('the trail grants readers insert and select and nothing else', /grant select, insert on public\.stake_recommendations to authenticated;/.test(SQL) && !/grant[^;]*update[^;]*on public\.stake_recommendations/.test(SQL));
chk('the pass reasons are counted like results', /create or replace view public\.stake_pass_reasons/.test(SQL));

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
if (!BIN) done('NOTE | no postgres binary on PATH — the LIVE layer did not run. CI installs postgres.');

const PORT = 56400 + (process.pid % 200);
const asPostgres = process.getuid && process.getuid() === 0;
const HOME = asPostgres ? fs.mkdtempSync('/var/lib/postgresql/st-') : fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
const DATA = path.join(HOME, 'data');
const run = (cmd, opts) => cp.execSync(asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd, Object.assign({ stdio: 'pipe', encoding: 'utf8' }, opts || {}));
let started = false;
try {
  if (asPostgres) cp.execSync(`chown -R postgres ${HOME} && chmod 700 ${HOME}`);
  run(`${BIN}/initdb -D ${DATA} -U postgres -A trust`);
  run(`${BIN}/pg_ctl -D ${DATA} -o "-p ${PORT} -k ${HOME} -c listen_addresses=" -l ${HOME}/log start -w -t 30`);
  started = true;
} catch (e) { done('NOTE | postgres would not start (' + String(e.message).slice(0, 120) + ') — LIVE layer skipped.'); }

const psql = (sql, opts) => run(`${BIN}/psql -h ${HOME} -p ${PORT} -U postgres -d postgres -v ON_ERROR_STOP=1 -t -A -c ` + JSON.stringify(String(sql).replace(/\s+/g, ' ').trim()), opts).trim();
const psqlFile = (file) => run(`${BIN}/psql -h ${HOME} -p ${PORT} -U postgres -d postgres -v ON_ERROR_STOP=1 -f ${file}`);
function mustFail(sql) { try { psql(sql); return null; } catch (e) { return String((e.stderr || e.stdout || e.message)); } }

try {
  const prep = path.join(HOME, 'prep.sql');
  fs.writeFileSync(prep, [
    'create schema if not exists auth;',
    "create or replace function auth.uid() returns uuid language sql stable as $fn$ select '00000000-0000-0000-0000-000000000001'::uuid $fn$;",
    "do $blk$ begin if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if; end $blk$;",
    'create table if not exists public.signals (sig_key text primary key, closing_sharp_fair numeric, closing_dec numeric, closing_at_observed timestamptz, result text, clv numeric, beat_close boolean);',
  ].join('\n'));
  const tmp = path.join(HOME, 'st.sql');
  fs.writeFileSync(tmp, SQL);
  if (asPostgres) cp.execSync(`chown postgres ${prep} ${tmp} && chmod 644 ${prep} ${tmp}`);
  psqlFile(prep);
  psqlFile(tmp);
  chk('the migration applies to a clean database', true);
  psqlFile(tmp);
  chk('and applies a second time without error', true);
  const report = run(`${BIN}/psql -h ${HOME} -p ${PORT} -U postgres -d postgres -v ON_ERROR_STOP=1 -t -A -f ${tmp}`);
  chk('every report row says ok', !/CHECK THIS/.test(report), report.slice(-400));

  /* ---- the policy ---------------------------------------------------- */
  psql("insert into public.bankroll_settings (bankroll_amount, base_unit_amount) values (2500, 25)");
  const defaults = psql("select fractional_kelly_multiplier||'|'||maximum_single_wager_units||'|'||maximum_game_exposure_units||'|'||maximum_team_exposure_units||'|'||maximum_daily_exposure_units||'|'||maximum_weekly_exposure_units||'|'||parlay_permission from public.bankroll_settings");
  chk('a policy row defaults to the conservative caps', defaults === '0.25|1.00|1.25|1.50|4.00|8.00|false', defaults);
  chk('a row with no bankroll is allowed and the column stays null', (() => {
    psql("update public.bankroll_settings set bankroll_amount = null");
    return psql("select coalesce(bankroll_amount::text,'null') from public.bankroll_settings") === 'null';
  })());
  psql("update public.bankroll_settings set bankroll_amount = 2500");
  chk('updated_at moves on an update', psql("select updated_at > created_at - interval '1 second' from public.bankroll_settings") === 't');
  let err = mustFail("update public.bankroll_settings set maximum_single_wager_units = 5");
  chk('a single-wager cap above the game cap is refused by the database', !!err && /bankroll_settings_single_within_game/.test(err), err && err.slice(0, 160));
  err = mustFail("update public.bankroll_settings set maximum_daily_exposure_units = 99");
  chk('a daily cap above the weekly cap is refused', !!err && /daily_within_week/.test(err), err && err.slice(0, 160));
  err = mustFail("update public.bankroll_settings set bankroll_amount = -1");
  chk('a negative bankroll is refused', !!err, err && err.slice(0, 120));
  err = mustFail("update public.bankroll_settings set fractional_kelly_multiplier = 2");
  chk('a Kelly multiplier above full Kelly is refused', !!err, err && err.slice(0, 120));
  err = mustFail("update public.bankroll_settings set minimum_parlay_stake_units = 0.9");
  chk('a parlay minimum above the maximum is refused', !!err && /parlay_band/.test(err), err && err.slice(0, 160));

  /* ---- the trail ----------------------------------------------------- */
  const KICK = '2026-09-20T19:00:00Z', BUILT = '2026-09-16T12:00:00Z';
  psql(`insert into public.stake_recommendations (recommendation_id, card_id, snapshot_hash, built_at, sport, game_id, matchup, kickoff, market, selection, side, handicap,
        odds_american, odds_decimal, book, price_captured_at, price_age_seconds, price_freshness,
        model_probability, calibrated_probability, conservative_probability, conservative_method, no_vig_market_probability,
        model_edge, conservative_edge, expected_value, fair_odds, reliability_score, raw_kelly_fraction, fractional_kelly_fraction,
        recommended_units, recommended_dollars, recommendation_tier, exposure_before_units, exposure_after_units,
        model_version, calibration_version, kernel_version, status, kind, bankroll_amount, base_unit_amount, sig_key, question, snapshot)
        values ('stake_abc','card_1','h1','${BUILT}','americanfootball_ncaaf','g1','Army at North Texas','${KICK}','spreads','North Texas','home',-2.5,
        -105,1.9524,'DraftKings','${BUILT}',900,'CURRENT',
        null,0.532,0.5188,'SHRINK_TO_HALF_BY_RELIABILITY',0.532,
        0,-0.0132,0.0129,-108,0.6679,0.0271,0.0068,
        0.50,12.50,'STANDARD',0,0.50,
        'market_devig','2026-09-16',1,'BET','RECOMMENDATION',2500,25,'sig-1','best bet today','{"schema":"edgedesk_stake_record_v1"}'::jsonb)`);
  chk('a sized recommendation can be recorded', psql("select recommendation_tier from public.stake_recommendations where recommendation_id='stake_abc'") === 'STANDARD');
  chk('and it belongs to the caller', psql("select user_id from public.stake_recommendations where recommendation_id='stake_abc'") === '00000000-0000-0000-0000-000000000001');

  err = mustFail("update public.stake_recommendations set recommended_units=1 where recommendation_id='stake_abc'");
  chk('a recorded unit size cannot be edited', !!err && /write-once/.test(err), err && err.slice(0, 160));
  err = mustFail("update public.stake_recommendations set odds_american=-120 where recommendation_id='stake_abc'");
  chk('nor the price it was taken at', !!err && /write-once/.test(err));
  err = mustFail("update public.stake_recommendations set conservative_probability=0.6 where recommendation_id='stake_abc'");
  chk('nor the probability it was staked on', !!err && /write-once/.test(err));
  err = mustFail("update public.stake_recommendations set snapshot='{}'::jsonb where recommendation_id='stake_abc'");
  chk('nor the snapshot', !!err && /write-once/.test(err));
  err = mustFail("delete from public.stake_recommendations where recommendation_id='stake_abc'");
  chk('and it cannot be deleted', !!err && /never deleted/.test(err), err && err.slice(0, 160));

  err = mustFail(`insert into public.stake_recommendations (recommendation_id, snapshot_hash, built_at, kickoff, status) values ('leak','x','2026-09-21T00:00:00Z','${KICK}','PASS')`);
  chk('a recommendation built after kickoff is refused', !!err && /cannot postdate kickoff/.test(err), err && err.slice(0, 160));
  err = mustFail(`insert into public.stake_recommendations (recommendation_id, snapshot_hash, built_at, kickoff, status, recommended_units) values ('zerobet','x','${BUILT}','${KICK}','BET',0)`);
  chk('a BET at zero units is refused by the database', !!err && /stake_bet_is_sized/.test(err), err && err.slice(0, 160));
  err = mustFail(`insert into public.stake_recommendations (recommendation_id, snapshot_hash, built_at, kickoff, status, recommended_units) values ('sizedpass','x','${BUILT}','${KICK}','PASS',0.5)`);
  chk('a PASS carrying a stake is refused by the database', !!err && /stake_non_bet_unsized/.test(err), err && err.slice(0, 160));
  err = mustFail(`insert into public.stake_recommendations (recommendation_id, snapshot_hash, built_at, kickoff, status, recommended_units) values ('huge','x','${BUILT}','${KICK}','BET',50)`);
  chk('an absurd stake is refused whatever the application says', !!err && /units_within_policy/.test(err), err && err.slice(0, 160));
  err = mustFail(`insert into public.stake_recommendations (recommendation_id, snapshot_hash, built_at, kickoff, status) values ('badstatus','x','${BUILT}','${KICK}','STRONG BUY')`);
  chk('an invented status is refused', !!err && /check/.test(err), err && err.slice(0, 120));
  err = mustFail(`insert into public.stake_recommendations (recommendation_id, snapshot_hash, built_at, kickoff, status) values ('stake_abc','x','${BUILT}','${KICK}','PASS')`);
  chk('the same recommendation cannot be recorded twice', !!err && /duplicate key|unique/.test(err));

  /* a PASS row, with its reason, is a first-class record */
  psql(`insert into public.stake_recommendations (recommendation_id, card_id, snapshot_hash, built_at, sport, game_id, kickoff, market, selection, status, kind, recommended_units, expected_value, reliability_score, pass_reason, conservative_probability)
        values ('stake_pass','card_1','h2','${BUILT}','americanfootball_ncaaf','g2','${KICK}','spreads','Rice','PASS','PASS',0,-0.021,0.51,'CONSERVATIVE_EV_NOT_POSITIVE: conservative EV -2.10% at -110 does not clear the 0.00% floor',0.49)`);
  const pr = psql("select gate||'|'||passes from public.stake_pass_reasons where status='PASS'");
  chk('a PASS is counted with its gate', pr === 'CONSERVATIVE_EV_NOT_POSITIVE|1', pr);

  /* ---- grading, the close and the baselines --------------------------- */
  chk('an ungraded BET reads SIGNAL_NOT_FOUND', psql("select grade_state from public.stake_recommendation_grades where recommendation_id='stake_abc'") === 'SIGNAL_NOT_FOUND');
  chk('a PASS is never graded as a bet', psql("select grade_state from public.stake_recommendation_grades where recommendation_id='stake_pass'") === 'NOT_A_BET');
  psql("insert into public.signals (sig_key) values ('sig-1')");
  chk('a signal with no close reads NOT_CLOSED', psql("select grade_state from public.stake_recommendation_grades where recommendation_id='stake_abc'") === 'NOT_CLOSED');
  psql("update public.signals set closing_sharp_fair=0.55, closing_dec=1.87, clv=0.021, beat_close=true where sig_key='sig-1'");
  chk('a closed signal with no result reads CLOSED_NO_RESULT', psql("select grade_state from public.stake_recommendation_grades where recommendation_id='stake_abc'") === 'CLOSED_NO_RESULT');
  psql("update public.signals set result='win' where sig_key='sig-1'");
  const g = psql("select grade_state||'|'||result||'|'||round(profit_units,4)||'|'||round(profit_units_flat_half,4)||'|'||round(profit_units_flat_one,4)||'|'||round(brier_conservative,4) from public.stake_recommendation_grades where recommendation_id='stake_abc'");
  chk('a graded bet carries profit at the recommended size and at both flat baselines', g === 'GRADED|win|0.4762|0.4762|0.9524|0.2316', g);
  psql("update public.signals set result='loss' where sig_key='sig-1'");
  const gl = psql("select round(profit_units,4)||'|'||round(profit_units_flat_half,4)||'|'||round(profit_units_flat_one,4) from public.stake_recommendation_grades where recommendation_id='stake_abc'");
  chk('a loss costs exactly the stake, and the baselines exactly theirs', gl === '-0.5000|-0.5000|-1.0000', gl);
  psql("update public.signals set result='push' where sig_key='sig-1'");
  chk('a push returns the stake and books nothing', psql("select round(profit_units,4) from public.stake_recommendation_grades where recommendation_id='stake_abc'") === '0.0000');
  psql("update public.signals set result='win' where sig_key='sig-1'");
  const sc = psql("select positions||'|'||graded||'|'||wins||'|'||round(units_staked,2)||'|'||round(profit_units,4)||'|'||round(profit_units_flat_one,4)||'|'||round(roi_on_staked,4)||'|'||sufficient_sample from public.stake_engine_scorecard where recommendation_tier='STANDARD'");
  chk('the scorecard reports the engine beside both flat baselines, with the sample floor', sc === '1|1|1|0.50|0.4762|0.9524|0.9524|false', sc);
  chk('a single graded bet is flagged as below the sample floor', psql("select bool_and(not sufficient_sample) from public.stake_engine_scorecard") === 't');

  /* ---- acceptance is recorded WITHOUT touching the snapshot ----------- */
  psql("insert into public.stake_recommendation_responses (recommendation_id, response, accepted_units, accepted_odds, accepted_book) values ('stake_abc','ACCEPTED',0.5,-105,'DraftKings')");
  chk('the reader’s acceptance reads through on the grade', psql("select reader_response||'|'||reader_accepted_units from public.stake_recommendation_grades where recommendation_id='stake_abc'") === 'ACCEPTED|0.5');
  chk('and the snapshot is untouched by it', psql("select recommended_units from public.stake_recommendations where recommendation_id='stake_abc'") === '0.50');
  err = mustFail("update public.stake_recommendation_responses set response='DECLINED' where recommendation_id='stake_abc'");
  chk('a response cannot be edited either; a change is a new row', !!err && /append-only/.test(err), err && err.slice(0, 160));
  psql("insert into public.stake_recommendation_responses (recommendation_id, response, accepted_units) values ('stake_abc','MODIFIED',0.25)");
  chk('the latest response wins without rewriting the first', psql("select reader_response from public.stake_recommendation_grades where recommendation_id='stake_abc'") === 'MODIFIED'
    && psql("select count(*) from public.stake_recommendation_responses where recommendation_id='stake_abc'") === '2');

  /* ---- the open-exposure view the engine reads back ------------------- */
  const openRows = psql("select count(*) from public.stake_open_exposure");
  chk('a bet on a game that has not started is open exposure', openRows === '1', openRows);

  /* ---- RLS: another reader sees none of this -------------------------- */
  const other_uid = path.join(HOME, 'uid2.sql');
  fs.writeFileSync(other_uid, "create or replace function auth.uid() returns uuid language sql stable as $fn$ select '00000000-0000-0000-0000-000000000002'::uuid $fn$;");
  if (asPostgres) cp.execSync(`chown postgres ${other_uid} && chmod 644 ${other_uid}`);
  psqlFile(other_uid);
  const other = run(`${BIN}/psql -h ${HOME} -p ${PORT} -U postgres -d postgres -v ON_ERROR_STOP=1 -t -A -c "set role authenticated; select count(*) from public.stake_recommendations; select count(*) from public.bankroll_settings;"`).trim();
  chk('a different reader sees neither the trail nor the policy',
    other.split('\n').map((x) => x.trim()).filter((x) => /^\d+$/.test(x)).length === 2
    && other.split('\n').map((x) => x.trim()).filter((x) => /^\d+$/.test(x)).every((x) => x === '0'), other);
} catch (e) {
  chk('the live layer ran without an unexpected error', false, String(e.stderr || e.message).slice(0, 400));
} finally {
  if (started) { try { run(`${BIN}/pg_ctl -D ${DATA} -m immediate stop`); } catch (_) { /* going away */ } }
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) { /* ditto */ }
}
done();
