#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk Tennis Lab — fill the derived research signals.

   WHY THIS IS A SEPARATE BUILDER. tools/tennis/build_ratings.js computes the
   Elo, the power rating and the form windows, and it is the query that once
   took nine minutes and now takes seventeen seconds. Bolting eight more
   aggregates onto it would put that back at risk and make one slow job out of
   two fast ones. This builder runs AFTER it and UPDATEs the columns the Lab
   added, so:

     - the proven rating build is not touched by a single statement
     - the lab signals can be rebuilt alone when a classification rule changes,
       without recomputing every Elo on the tour
     - a failure here leaves the ratings intact and the Lab degraded rather
       than the whole record broken

   WHAT IT COMPUTES, and the rule each one obeys:

     serve / return    the most recent rolling PRE-match figure on file. Null
                       where the archive carried no serve statistics — which is
                       most of the range before 1991. Never zero.
     strength of       the mean opponent Elo over the last 365 days, and over
     schedule          the career. The pair is what makes "improving" honest:
                       a 30-day surge against a softer field is not improvement.
     surface win %     career win rate per surface, for the translator.
     indoor / outdoor  the environment split, computed only where the source
                       actually carried an environment. An event with no
                       environment on file contributes to neither.
     rating deltas     from tennis.rating_history: what the rating was 30 and
                       90 days ago, subtracted from what it is now. No history
                       row, no delta — it is not inferred from form.
     classifications   trajectory and workload, from lib/tennis_lab.js. The
                       library is the single implementation; this job only
                       stores what it returns so a leaderboard does not
                       recompute it 106,887 times per page load.

   NOTHING HERE READS A MATCH'S OWN RESULT TO DESCRIBE THAT MATCH. Every
   aggregate is over completed matches and is written to a "current state"
   table; the point-in-time feature rows are untouched.

   Usage:
     node tools/tennis/build_lab.js                 # dry run, prints the plan
     node tools/tennis/build_lab.js --commit        # write
     node tools/tennis/build_lab.js --tour ATP --commit
     node tools/tennis/build_lab.js --explain       # print query plans

   Exit codes: 0 ok · 1 failed
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const PG = require('./lib/pg.js');
const M = require('../../lib/tennis_model.js');
const L = require('../../lib/tennis_lab.js');

const JOB = 'lab_signals_build';

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--commit') o.commit = true;
    else if (a === '--tour') o.tour = M.normTour(next());
    else if (a === '--database') o.database = next();
    else if (a === '--explain') o.explain = true;
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}
const say = (...a) => console.log(...a);
const fail = (...a) => console.error('::error::' + a.join(' '));

/* ───────────────────────────── the aggregates ─────────────────────────────
   Shaped the same way build_ratings.js learned to shape its own: every
   per-player aggregate is computed ONCE in its own CTE and joined, never as a
   correlated subquery. Against 290k matches the correlated form does not
   finish; this form is one pass per aggregate. */
function signalsSql(tourFilter) {
  const f = tourFilter ? `where r.tour = ${PG.lit(tourFilter)}` : '';
  const FV = PG.lit(M.FEATURE_VERSION);
  return `
with rows as materialized (
  select r.player_id, r.tour, r.match_id, r.match_date, r.won, r.opponent_id, r.surface
    from tennis.player_match_rows r ${f}
),
-- Most recent rolling serve/return figure. One ordered pass, not a subquery
-- per player.
serve as (
  select distinct on (x.player_id)
         x.player_id, f.serve_strength_pre, f.return_strength_pre, f.serve_sample_pre
    from rows x
    join tennis.player_match_features f
      on f.match_id = x.match_id and f.player_id = x.player_id
     and f.feature_version = ${FV}
   where f.serve_strength_pre is not null
   order by x.player_id, x.match_date desc, x.match_id desc
),
-- Strength of schedule: the mean opponent Elo entering each match. Recent and
-- career, so the trajectory rule can compare them.
sos as (
  select x.player_id,
         avg(fo.elo_pre) filter (where x.match_date >= current_date - 365) as sos_recent,
         avg(fo.elo_pre) as sos_career,
         count(fo.elo_pre)::int as sos_n
    from rows x
    join tennis.player_match_features fo
      on fo.match_id = x.match_id and fo.player_id = x.opponent_id
     and fo.feature_version = ${FV}
   group by x.player_id
),
-- Career win rate per surface, for the translator.
surfwin as (
  select player_id,
         avg(case when won then 1.0 else 0.0 end) filter (where surface = 'hard')   as hard_pct,
         avg(case when won then 1.0 else 0.0 end) filter (where surface = 'clay')   as clay_pct,
         avg(case when won then 1.0 else 0.0 end) filter (where surface = 'grass')  as grass_pct,
         avg(case when won then 1.0 else 0.0 end) filter (where surface = 'carpet') as carpet_pct
    from rows group by player_id
),
-- Indoor / outdoor. ONLY where the source carried an environment: a match with
-- none contributes to neither split rather than being assumed outdoor. The Elo
-- here is the mean pre-match Elo in that environment, which is a strength
-- estimate for those conditions, not a separate Elo ladder.
env as (
  select x.player_id,
         avg(fx.elo_pre) filter (where m.environment = 'indoor')  as indoor_elo,
         count(*) filter (where m.environment = 'indoor')::int    as indoor_n,
         avg(fx.elo_pre) filter (where m.environment = 'outdoor') as outdoor_elo,
         count(*) filter (where m.environment = 'outdoor')::int   as outdoor_n
    from rows x
    join tennis.matches m on m.match_id = x.match_id
    left join tennis.player_match_features fx
      on fx.match_id = x.match_id and fx.player_id = x.player_id
     and fx.feature_version = ${FV}
   where m.environment in ('indoor','outdoor')
   group by x.player_id
),
-- Rating movement, from the history table. distinct on picks the snapshot
-- nearest each horizon; no history means no delta, and no delta is written as
-- null rather than as zero.
hist30 as (
  select distinct on (h.player_id) h.player_id, h.power_rating
    from tennis.rating_history h
   where h.as_of <= current_date - 30
   order by h.player_id, h.as_of desc
),
hist90 as (
  select distinct on (h.player_id) h.player_id, h.power_rating
    from tennis.rating_history h
   where h.as_of <= current_date - 90
   order by h.player_id, h.as_of desc
)
select r.player_id, r.tour, r.power_rating, r.elo, r.rating_sample,
       r.form_30d, r.form_90d, r.form_365d, r.form_sample_365d,
       r.matches_7d, r.matches_14d, r.matches_28d, r.rest_days, r.days_since_last_match,
       s.serve_strength_pre, s.return_strength_pre, s.serve_sample_pre,
       so.sos_recent, so.sos_career, so.sos_n,
       sw.hard_pct, sw.clay_pct, sw.grass_pct, sw.carpet_pct,
       e.indoor_elo, e.indoor_n, e.outdoor_elo, e.outdoor_n,
       h30.power_rating as rating_30d_ago,
       h90.power_rating as rating_90d_ago
  from tennis.player_ratings_current r
  left join serve s    on s.player_id = r.player_id
  left join sos so     on so.player_id = r.player_id
  left join surfwin sw on sw.player_id = r.player_id
  left join env e      on e.player_id = r.player_id
  left join hist30 h30 on h30.player_id = r.player_id
  left join hist90 h90 on h90.player_id = r.player_id
 ${tourFilter ? `where r.tour = ${PG.lit(tourFilter)}` : ''}`;
}

const COLS = ['player_id', 'serve_strength', 'return_strength', 'serve_sample',
  'sos_elo_recent', 'sos_elo_career', 'sos_sample',
  'indoor_elo', 'indoor_sample', 'outdoor_elo', 'outdoor_sample',
  'hard_win_pct', 'clay_win_pct', 'grass_win_pct', 'carpet_win_pct',
  'trajectory_class', 'trajectory_direction', 'workload_class',
  'rating_delta_30d', 'rating_delta_90d', 'lab_version'];

/* A value the COPY stream treats as absent. \N is the TEXT-format NULL, and
   using it rather than an empty string is what keeps "not known" out of the
   numeric columns as a zero. */
const NUL = '\\N';
function tsv(v) {
  if (v == null || v === '') return NUL;
  return String(v).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

async function main() {
  const o = args(process.argv.slice(2));
  if (o.help) { say(fs.readFileSync(__filename, 'utf8').split('*/')[0]); return 0; }
  const conn = PG.resolveConnection();
  if (!conn) { fail('no database connection (SUPABASE_DB_URL / DATABASE_URL / EDGD_PG)'); return 1; }
  const db = PG.client(conn, { database: o.database });
  if (!db.ping()) { fail('the database did not answer'); return 1; }

  if (to_missing(db)) return 1;

  say('EdgeDesk Tennis Lab — derived research signals');
  say(`  lab version        ${L.LAB_VERSION}`);
  say(`  feature version    ${M.FEATURE_VERSION}`);
  say(`  mode               ${o.commit ? 'COMMIT' : 'dry run (nothing is written)'}`);
  if (o.tour) say(`  tour               ${o.tour}`);

  if (o.explain) {
    const plan = db.rows(`explain (analyze, buffers, format json) ${signalsSql(o.tour)}`);
    say('\n  query plan:');
    say(JSON.stringify(plan, null, 2).slice(0, 4000));
  }

  const t0 = Date.now();
  const state = db.rows(signalsSql(o.tour));
  const readSeconds = ((Date.now() - t0) / 1000).toFixed(1);
  if (!state.length) {
    say('\n  no rated players on file. Run the import, the feature build and the rating build first.');
    return 0;
  }
  say(`\n  players read       ${state.length.toLocaleString()} in ${readSeconds}s`);

  /* Classify in JS, using the SAME library the page and the AI use. A SQL
     re-implementation of these rules would be a second definition of
     "improving", and the two would drift. */
  const lines = [];
  const tally = { trajectory: {}, workload: {}, serve: 0, sos: 0, indoor: 0, delta: 0 };
  state.forEach((s) => {
    const rating = {
      elo: s.elo,
      form_30d: s.form_30d, form_90d: s.form_90d, form_365d: s.form_365d,
      form_sample_365d: s.form_sample_365d,
      matches_7d: s.matches_7d, matches_14d: s.matches_14d, rest_days: s.rest_days,
      days_since_last_match: s.days_since_last_match,
      sos_elo_recent: s.sos_recent, sos_elo_career: s.sos_career
    };
    const traj = L.trajectory(rating);
    const work = L.workload(rating);
    tally.trajectory[traj.klass] = (tally.trajectory[traj.klass] || 0) + 1;
    tally.workload[work.klass] = (tally.workload[work.klass] || 0) + 1;
    if (s.serve_strength_pre != null) tally.serve++;
    if (s.sos_recent != null) tally.sos++;
    if (s.indoor_n) tally.indoor++;

    /* A delta needs BOTH endpoints. One missing endpoint is not a move of
       zero, it is an unknown move, and the column stays null. */
    const d30 = (s.power_rating != null && s.rating_30d_ago != null)
      ? M.round(Number(s.power_rating) - Number(s.rating_30d_ago), 2) : null;
    const d90 = (s.power_rating != null && s.rating_90d_ago != null)
      ? M.round(Number(s.power_rating) - Number(s.rating_90d_ago), 2) : null;
    if (d30 != null) tally.delta++;

    lines.push([
      tsv(s.player_id),
      tsv(s.serve_strength_pre == null ? null : M.round(Number(s.serve_strength_pre), 4)),
      tsv(s.return_strength_pre == null ? null : M.round(Number(s.return_strength_pre), 4)),
      tsv(s.serve_sample_pre),
      tsv(s.sos_recent == null ? null : M.round(Number(s.sos_recent), 3)),
      tsv(s.sos_career == null ? null : M.round(Number(s.sos_career), 3)),
      tsv(s.sos_n),
      tsv(s.indoor_elo == null ? null : M.round(Number(s.indoor_elo), 3)),
      tsv(s.indoor_n),
      tsv(s.outdoor_elo == null ? null : M.round(Number(s.outdoor_elo), 3)),
      tsv(s.outdoor_n),
      tsv(s.hard_pct == null ? null : M.round(Number(s.hard_pct), 4)),
      tsv(s.clay_pct == null ? null : M.round(Number(s.clay_pct), 4)),
      tsv(s.grass_pct == null ? null : M.round(Number(s.grass_pct), 4)),
      tsv(s.carpet_pct == null ? null : M.round(Number(s.carpet_pct), 4)),
      tsv(traj.klass),
      tsv(traj.direction),
      tsv(work.klass),
      tsv(d30),
      tsv(d90),
      tsv(L.LAB_VERSION)
    ].join('\t'));
  });

  say('\n  classifications');
  Object.keys(tally.trajectory).sort().forEach((k) => {
    say(`    trajectory ${k.padEnd(18)} ${String(tally.trajectory[k]).padStart(7)}`);
  });
  Object.keys(tally.workload).sort().forEach((k) => {
    say(`    workload   ${k.padEnd(18)} ${String(tally.workload[k]).padStart(7)}`);
  });
  say('\n  coverage (absent stays absent — none of these is defaulted to zero)');
  say(`    serve / return      ${pct(tally.serve, state.length)}`);
  say(`    schedule strength, last 365d ${pct(tally.sos, state.length)}`);
  say(`    indoor split         ${pct(tally.indoor, state.length)}`);
  say(`    30-day rating delta  ${pct(tally.delta, state.length)}${tally.delta === 0 ? '  (no rating_history yet — run build_history.js)' : ''}`);

  if (!o.commit) {
    say('\n  dry run: nothing was written. Re-run with --commit.');
    return 0;
  }

  const runId = db.scalar(`insert into tennis.ingestion_runs (job, source_key, status, started_at, details)
    values (${PG.lit(JOB)}, 'edgedesk', 'running', now(),
            jsonb_build_object('lab_version', ${PG.lit(L.LAB_VERSION)},
                               'tour', ${PG.lit(o.tour || 'all')}))
    returning run_id`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edgd-lab-'));
  try {
    const data = path.join(tmp, 'lab.tsv');
    fs.writeFileSync(data, lines.join('\n') + '\n');
    db.script([
      'begin;',
      `create temp table t_lab (${COLS.map((c) => c + ' text').join(', ')}) on commit drop;`,
      `\\copy t_lab (${COLS.join(',')}) from '${data}' with (format text, null '\\N')`,
      /* One UPDATE ... FROM, not a row-per-statement loop. The casts are
         explicit so a malformed value fails the transaction rather than
         silently landing as null. */
      `update tennis.player_ratings_current r set
         serve_strength   = nullif(t.serve_strength, '')::numeric,
         return_strength  = nullif(t.return_strength, '')::numeric,
         serve_sample     = nullif(t.serve_sample, '')::integer,
         sos_elo_recent   = nullif(t.sos_elo_recent, '')::numeric,
         sos_elo_career   = nullif(t.sos_elo_career, '')::numeric,
         sos_sample       = nullif(t.sos_sample, '')::integer,
         indoor_elo       = nullif(t.indoor_elo, '')::numeric,
         indoor_sample    = nullif(t.indoor_sample, '')::integer,
         outdoor_elo      = nullif(t.outdoor_elo, '')::numeric,
         outdoor_sample   = nullif(t.outdoor_sample, '')::integer,
         hard_win_pct     = nullif(t.hard_win_pct, '')::numeric,
         clay_win_pct     = nullif(t.clay_win_pct, '')::numeric,
         grass_win_pct    = nullif(t.grass_win_pct, '')::numeric,
         carpet_win_pct   = nullif(t.carpet_win_pct, '')::numeric,
         trajectory_class = nullif(t.trajectory_class, ''),
         trajectory_direction = nullif(t.trajectory_direction, '')::smallint,
         workload_class   = nullif(t.workload_class, ''),
         rating_delta_30d = nullif(t.rating_delta_30d, '')::numeric,
         rating_delta_90d = nullif(t.rating_delta_90d, '')::numeric,
         lab_version      = nullif(t.lab_version, ''),
         updated_at       = now()
       from t_lab t where t.player_id = r.player_id;`,
      `update tennis.ingestion_runs set status='ok', finished_at=now(), reconciled=true,
         rows_read=${lines.length}, rows_updated=${lines.length}
       where run_id='${runId}'::uuid;`,
      'commit;'
    ], tmp);
  } catch (e) {
    db.exec(`update tennis.ingestion_runs set status='error', finished_at=now(),
               error_summary=${PG.lit(String(e.message).slice(0, 900))} where run_id='${runId}'::uuid`);
    fail(e.message);
    return 1;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }

  db.exec(`insert into tennis.meta (key, value) values ('lab_signals_built', now()::text)
           on conflict (key) do update set value = excluded.value`);
  say(`\n  wrote ${lines.length.toLocaleString()} player signal rows.`);
  return 0;
}
function pct(n, d) {
  return d ? `${String(n).padStart(7)} of ${d.toLocaleString()} (${Math.round((n / d) * 100)}%)` : '0';
}
function to_missing(db) {
  const have = db.scalar(`select count(*)::int from information_schema.columns
     where table_schema='tennis' and table_name='player_ratings_current' and column_name='trajectory_class'`);
  if (Number(have) > 0) return false;
  fail('tennis.player_ratings_current has no lab columns — apply supabase/tennis_lab.sql first');
  return true;
}

if (require.main === module) {
  main().then((c) => process.exit(c)).catch((e) => { fail(e && e.stack || e); process.exit(1); });
}
module.exports = { signalsSql, COLS };
