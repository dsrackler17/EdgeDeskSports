#!/usr/bin/env node
/* ===========================================================================
   supabase/personal_research.sql, AGAINST A REAL POSTGRESQL, AS REAL READERS.

   The watchlist, the alerts and the journal are private. "RLS is on" is a
   claim; this proves it by acting as reader A, as reader B reaching for A's
   rows, as anon, and as the service role the jobs use — and it proves the
   journal's information set cannot be edited by anyone after it is saved,
   even after the shared research state it was taken from has moved on.

   Run: node tools/personal/personal_sql.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const PG = require('./_pg.js');

const T = PG.kit('personal research SQL');
const chk = T.chk;
const FILE = path.join(PG.ROOT, 'supabase', 'personal_research.sql');
const fs = require('fs');
const SQL = fs.readFileSync(FILE, 'utf8');

/* ── STATIC: the folder's conventions ──────────────────────────────────── */
chk('no psql meta-commands', !/^\\/m.test(SQL));
chk('idempotent create statements', /create table if not exists/.test(SQL) && /create or replace function/.test(SQL));
chk('additive: nothing is dropped', !/\bdrop table\b/i.test(SQL) && !/\bdrop column\b/i.test(SQL));
chk('it ends in a report', /CHECK THIS/.test(SQL) && /order by 1;\s*$/.test(SQL));
chk('PostgREST is told to reload', /notify pgrst, 'reload schema'/.test(SQL));
chk('every personal table is keyed to auth.uid()', (SQL.match(/user_id = auth\.uid\(\)/g) || []).length >= 12);

const db = PG.start('personal');
if (db.skip) { console.log('NOTE | ' + db.skip + ' — LIVE layer skipped'); process.exit(T.done()); }

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const DAY = 86400000;
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const KICK = iso(2 * DAY);

function state(over) {
  return Object.assign({ schema: 'edgedesk_research_state/1', game_key: 'cfb|401862779', sport: 'cfb', game_id: '401862779',
    home: 'Florida', away: 'Ole Miss', kickoff_at: KICK, fair: { home_line: -1.7 }, market: { home_line: 2.5 },
    gap: { points: 4.2 }, reliability: { score: 88 } }, over || {});
}
function upsertState(hash, fair, rel, computedAt) {
  const st = state({ fair: { home_line: fair }, reliability: { score: rel } });
  return db.service(`insert into public.game_research_state (game_key, sport, game_id, home, away, kickoff_at, status, projected,
      fair_home_line, market_home_line, gap_pts, reliability_score, research_grade, qb_confirmed, priority_eligible, key_reason,
      state, state_hash, computed_at)
    values ('cfb|401862779','cfb','401862779','Florida','Ole Miss','${KICK}','RESEARCH',true,
      ${fair}, 2.5, ${Math.abs(fair - 2.5)}, ${rel}, true, true, true, 'Model flips the market favorite.',
      ${PG.lit(JSON.stringify(st))}::jsonb, '${hash}', '${computedAt || new Date().toISOString()}')
    on conflict (game_key) do update set fair_home_line = excluded.fair_home_line, reliability_score = excluded.reliability_score,
      state = excluded.state, state_hash = excluded.state_hash, computed_at = excluded.computed_at;`);
}

try {
  let out = db.applyFile(FILE);
  chk('the migration applies to a clean database', true);
  chk('every report row says ok', !/CHECK THIS/.test(out), out.slice(-600));
  out = db.applyFile(FILE);
  chk('and applies a second time without error, still all ok', !/CHECK THIS/.test(out));

  db.sql(`insert into auth.users (id, email) values ('${A}','a@example.com'), ('${B}','b@example.com');`);

  /* ── the shared research state ─────────────────────────────────────── */
  upsertState('h1', -1.7, 76);
  chk('the service role writes the shared state', db.sql(`select count(*) from public.game_research_state`) === '1');
  chk('a new state is appended to the history by trigger', db.sql(`select count(*) from public.game_research_history`) === '1');
  upsertState('h1', -1.7, 76);
  chk('the same state again appends nothing', db.sql(`select count(*) from public.game_research_history`) === '1');
  let err = db.mustFail(() => db.as(A, `insert into public.game_research_state (game_key, sport, game_id, state, state_hash, computed_at)
    values ('cfb|1','cfb','1','{}','x',now());`));
  chk('a reader cannot write the shared state', !!err && /permission denied|row-level security/.test(err), err && err.slice(0, 200));
  err = db.mustFail(() => db.anon(`select count(*) from public.game_research_state;`));
  chk('anon cannot read the shared state', !!err && /permission denied/.test(err));
  chk('a signed-in reader reads it (no paywall function installed)', db.as(A, `select count(*) from public.game_research_state;`) === '1');

  /* ── preferences ──────────────────────────────────────────────────────── */
  db.as(A, `insert into public.user_preferences (leagues, books, interests, onboarding_status) values ('{nfl,cfb,cfb}','{draftkings,fanduel}','{clv,reliability}','completed');`);
  chk('preferences persist, deduplicated and sorted',
    db.as(A, `select leagues::text || '|' || books::text || '|' || onboarding_status || '|' || (onboarding_completed_at is not null) from public.user_preferences;`)
      === '{cfb,nfl}|{draftkings,fanduel}|completed|true');
  err = db.mustFail(() => db.as(B, `insert into public.user_preferences (leagues) values ('{nba}');`));
  chk('a league the product does not offer is refused', !!err && /unknown league/.test(err), err && err.slice(0, 200));
  err = db.mustFail(() => db.as(B, `insert into public.user_preferences (interests) values ('{picks}');`));
  chk('an interest outside the list is refused', !!err && /user_prefs_interests_valid/.test(err));
  err = db.mustFail(() => db.as(B, `insert into public.user_preferences (user_id, leagues) values ('${A}', '{nfl}');`));
  chk('B cannot write preferences for A', !!err && /row-level security|duplicate key/.test(err), err && err.slice(0, 200));
  chk('B cannot read A\'s preferences', db.as(B, `select count(*) from public.user_preferences;`) === '0');
  db.as(A, `insert into public.alert_preferences (gap_min_pts, reliability_min) values (2.5, 85);`);
  chk('alert thresholds are stored as set', db.as(A, `select gap_min_pts || '|' || reliability_min || '|' || scope from public.alert_preferences;`) === '2.5|85|watchlist');
  err = db.mustFail(() => db.as(A, `update public.alert_preferences set gap_min_pts = 40;`));
  chk('an out-of-range threshold is refused', !!err && /alert_prefs_ranges/.test(err));

  /* ── the watchlist ────────────────────────────────────────────────────── */
  db.as(A, `insert into public.watchlist_games (game_key, home, away, kickoff_at) values ('cfb|401862779','Florida','Ole Miss','${KICK}');`);
  chk('a reader stars a game', db.as(A, `select count(*) from public.watchlist_games;`) === '1');
  err = db.mustFail(() => db.as(A, `insert into public.watchlist_games (game_key) values ('cfb|401862779');`));
  chk('a duplicate watchlist row is refused by the database', !!err && /watchlist_games_one_per_game|duplicate key/.test(err));
  chk('the page\'s upsert path is a no-op on a duplicate',
    db.as(A, `insert into public.watchlist_games (game_key) values ('cfb|401862779') on conflict (user_id, game_key) do nothing; select count(*) from public.watchlist_games;`) === '1');
  err = db.mustFail(() => db.as(A, `insert into public.watchlist_games (game_key) values ('cfb|not a key; drop table x');`));
  chk('a malformed game key is refused', !!err && /watchlist_games_shape/.test(err));
  chk('B does not see A\'s watchlist', db.as(B, `select count(*) from public.watchlist_games;`) === '0');
  chk('B cannot delete A\'s watchlist row', db.as(B, `with d as (delete from public.watchlist_games returning 1) select count(*) from d;`) === '0'
    && db.as(A, `select count(*) from public.watchlist_games;`) === '1');
  err = db.mustFail(() => db.as(B, `insert into public.watchlist_games (user_id, game_key) values ('${A}','nfl|2026_04_NYJ_CHI');`));
  chk('B cannot add a game to A\'s watchlist', !!err && /row-level security/.test(err));
  err = db.mustFail(() => db.anon(`select count(*) from public.watchlist_games;`));
  chk('anon cannot read any watchlist', !!err && /permission denied/.test(err));
  err = db.mustFail(() => db.as(A, `update public.watchlist_games set game_key = 'cfb|999';`));
  chk('a watchlist row cannot be re-pointed at another game', !!err && /permission denied/.test(err));

  db.as(A, `update public.watchlist_games w set last_seen_at = now(), seen_hash = 'h1';`);
  chk('the watchlist view joins the shared state and reports no change after a visit',
    db.as(A, `select changed || '|' || coalesce(reliability_score::text,'') || '|' || fair_home_line from public.my_watchlist;`) === 'false|76|-1.7');
  upsertState('h2', -3.1, 86);
  chk('a new state for a watched game reads as changed', db.as(A, `select changed from public.my_watchlist;`) === 't');
  chk('and both states are in the history', db.sql(`select count(*) from public.game_research_history where game_key = 'cfb|401862779';`) === '2');
  chk('B\'s view of the watchlist is empty', db.as(B, `select count(*) from public.my_watchlist;`) === '0');

  /* ── alerts ───────────────────────────────────────────────────────────── */
  err = db.mustFail(() => db.as(A, `insert into public.user_alerts (user_id, kind, title, dedupe_key) values ('${A}','fair_move','x','k');`));
  chk('a reader cannot create an alert', !!err && /permission denied/.test(err));
  db.service(`insert into public.user_alerts (user_id, game_key, kind, title, body, dedupe_key) values
    ('${A}','cfb|401862779','reliability_change','Reliability increased from 76 to 86','QB status confirmed.','reliability_change|cfb|401862779|86');`);
  chk('the service role creates an alert', db.as(A, `select count(*) from public.user_alerts;`) === '1');
  chk('the same condition again is absorbed, not duplicated',
    db.service(`insert into public.user_alerts (user_id, kind, title, dedupe_key) values ('${A}','reliability_change','Reliability increased from 76 to 86','reliability_change|cfb|401862779|86')
      on conflict (user_id, dedupe_key) do nothing; select count(*) from public.user_alerts;`) === '1');
  err = db.mustFail(() => db.service(`insert into public.user_alerts (user_id, kind, title, dedupe_key) values ('${A}','gap_min','LOCK OF THE WEEK — bet this now','t1');`));
  chk('tout language is refused by the database', !!err && /user_alerts_shape/.test(err));
  err = db.mustFail(() => db.service(`insert into public.user_alerts (user_id, kind, title, dedupe_key) values ('${A}','gap_min','Guaranteed edge','t2');`));
  chk('"guaranteed" is refused too', !!err && /user_alerts_shape/.test(err));
  chk('B does not see A\'s alert', db.as(B, `select count(*) from public.user_alerts;`) === '0');
  db.as(A, `update public.user_alerts set read_at = now();`);
  chk('A marks an alert read', db.as(A, `select count(*) from public.user_alerts where read_at is not null;`) === '1');
  err = db.mustFail(() => db.as(A, `update public.user_alerts set title = 'edited';`));
  chk('an alert\'s words cannot be edited by the reader', !!err && /permission denied/.test(err));
  chk('B cannot mark A\'s alert read', db.as(B, `with u as (update public.user_alerts set dismissed_at = now() returning 1) select count(*) from u;`) === '0');

  /* ── the journal ──────────────────────────────────────────────────────── */
  const snap = JSON.stringify({ schema: 'edgedesk_research_state/1', fair: { home_line: -3.1 }, reliability: { score: 86 } });
  db.as(A, `insert into public.research_journal (game_key, home, away, kickoff_at, decision, market_type, selection, sportsbook, line, price_american, stake,
      snap_fair_home_line, snap_market_home_line, snap_gap_pts, snap_reliability_score, snap_model_version, snapshot, snapshot_hash,
      created_at, clv_points, result, user_id)
    values ('cfb|401862779','Florida','Ole Miss','${KICK}','wagered','spread','home','DraftKings',2.5,-110,50,
      -3.1, 2.5, 5.6, 86, 'cfb_p4/2026.09', ${PG.lit(snap)}::jsonb, 'snaphash1',
      '2020-01-01T00:00:00Z', 9.9, 'win', '${A}');`);
  const row = db.as(A, `select (created_at > now() - interval '1 minute') || '|' || coalesce(clv_points::text,'null') || '|' || coalesce(result,'null')
      || '|' || (server_state is not null) || '|' || server_state_hash || '|' || after_kickoff from public.research_journal;`);
  chk('the server stamps the time, ignores a pre-filled close and grade, and copies the shared state', row === 'true|null|null|true|h2|false', row);
  db.as(A, `update public.research_journal set notes = 'Liked the QB news.';`);
  chk('notes are the reader\'s to edit', db.as(A, `select notes from public.research_journal;`) === 'Liked the QB news.');
  err = db.mustFail(() => db.as(A, `update public.research_journal set snap_fair_home_line = -9;`));
  chk('the fair line at decision time cannot be edited by the reader', !!err && /permission denied|write-once/.test(err));
  err = db.mustFail(() => db.service(`update public.research_journal set snap_reliability_score = 99;`));
  chk('nor by the service role: the information set is write-once for everybody', !!err && /write-once/.test(err), err && err.slice(0, 200));
  err = db.mustFail(() => db.service(`update public.research_journal set snapshot = '{}'::jsonb;`));
  chk('the snapshot JSON is write-once too', !!err && /write-once/.test(err));
  err = db.mustFail(() => db.as(A, `update public.research_journal set clv_points = 3;`));
  chk('a reader cannot write their own CLV', !!err && /permission denied/.test(err));

  /* the model moves on: the entry must not */
  upsertState('h3', -6.4, 64);
  const after = db.as(A, `select snap_fair_home_line || '|' || snap_reliability_score || '|' || (snapshot->'fair'->>'home_line') || '|' || server_state_hash from public.research_journal;`);
  chk('SNAPSHOT INTEGRITY: a later model change leaves the entry exactly as it was', after === '-3.1|86|-3.1|h2', after);

  db.service(`update public.research_journal set close_home_line = 1.0, close_captured_at = now(), close_source = 'game_research_history',
      clv_points = 1.5, beat_close = true, home_score = 27, away_score = 24, result = 'win', graded_at = now();`);
  chk('the grading job writes the close and the grade', db.as(A, `select clv_points || '|' || beat_close || '|' || result from public.research_journal;`) === '1.5|true|win');
  chk('B cannot read A\'s journal', db.as(B, `select count(*) from public.research_journal;`) === '0');
  err = db.mustFail(() => db.as(A, `insert into public.research_journal (game_key, decision, market_type, selection, snapshot, snapshot_hash)
      values ('cfb|401862779','wagered','spread','home','{}','x');`));
  chk('a wager with no line is refused', !!err && /research_journal_wager_complete/.test(err));
  err = db.mustFail(() => db.as(A, `insert into public.research_journal (game_key, decision, snapshot, snapshot_hash) values ('cfb|401862779','smashed','{}','x');`));
  chk('an invented decision is refused', !!err && /research_journal_shape/.test(err));
  err = db.mustFail(() => db.as(A, `insert into public.research_journal (game_key, decision, market_type, selection, price_american, snapshot, snapshot_hash)
      values ('cfb|401862779','wagered','moneyline','home',50,'{}','x');`));
  chk('an impossible American price is refused', !!err && /research_journal_shape/.test(err));
  db.as(A, `insert into public.research_journal (game_key, decision, notes, snapshot, snapshot_hash) values ('nfl|2026_04_NYJ_CHI','passed','no price worth it','{}','p1');`);
  chk('a pass is a first-class entry', db.as(A, `select count(*) from public.research_journal where decision = 'passed';`) === '1');
  chk('a reader may delete their own entry', db.as(A, `with d as (delete from public.research_journal where decision = 'passed' returning 1) select count(*) from d;`) === '1');
  chk('B cannot delete A\'s entries', db.as(B, `with d as (delete from public.research_journal returning 1) select count(*) from d;`) === '0');

  /* ── entitlement: with the paywall's function installed ───────────────── */
  db.sql(`create or replace function public.community_is_entitled(p_user uuid) returns boolean language sql stable as $$ select p_user = '${A}'::uuid $$;`);
  chk('with the paywall installed, an entitled reader reads the shared state', db.as(A, `select count(*) from public.game_research_state;`) === '1');
  chk('and a reader without a subscription does not', db.as(B, `select count(*) from public.game_research_state;`) === '0');

  /* ── proof metrics ───────────────────────────────────────────────────── */
  const pm = JSON.parse(db.anon(`select public.edgedesk_proof_metrics();`));
  chk('the proof metrics are counts of real rows', pm.games_on_slate === 1 && pm.games_analyzed === 1 && pm.research_grade === 1 && pm.qb_confirmed === 1, pm);
  chk('and carry no user count, accuracy or profit', !('users' in pm) && !('accuracy' in pm) && !('roi' in pm) && !('profit' in pm));
  chk('a metric with nothing behind it is simply absent', !('active_market_quotes' in pm));
  db.sql(`create table public.signals (sig_key text primary key, sport_key text, commence_time timestamptz, last_seen_at timestamptz);
          create table public.book_quotes (sig_key text, book_key text);
          insert into public.signals values ('s1','americanfootball_ncaaf', now() + interval '1 day', now()), ('s2','americanfootball_nfl', now() + interval '1 day', now() - interval '2 days');
          insert into public.book_quotes values ('s1','draftkings'), ('s1','fanduel'), ('s2','betmgm');`);
  const pm2 = JSON.parse(db.anon(`select public.edgedesk_proof_metrics();`));
  chk('with the capture tables present, quotes and books are counted from them', pm2.active_market_quotes === 1 && pm2.books_represented === 2, pm2);
} catch (e) {
  chk('the live suite ran without an unexpected error', false, String(e.message).slice(0, 800));
} finally {
  db.stop();
}
process.exit(T.done());
