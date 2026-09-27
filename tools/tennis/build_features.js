#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk Tennis — the point-in-time feature builder.

   WHAT IT ADDS. The archive already carries Elo, form, fatigue and surface
   history computed before each match. Three things it does NOT carry, because
   they can only be computed from the match statistics themselves, are added
   here — and they are exactly the three where a leak would be easiest to
   introduce and hardest to see:

     serve_strength_pre   service points won / service points played, over every
                          match this player played BEFORE this one
     return_strength_pre  return points won / return points played, likewise
     sos_elo_pre          the mean pre-match Elo of every opponent faced BEFORE
                          this one — strength of schedule, which is what makes
                          a 70% win rate on the Challenger tour different from
                          70% at Masters level

   THE LEAKAGE BOUNDARY IS A SQL WINDOW FRAME, NOT A CONVENTION.

       rows between unbounded preceding and 1 preceding

   That clause is the whole guarantee. The current row cannot enter its own
   aggregate — not by accident, not after a refactor, not when a new column is
   added. It is checked from the other side too, by tools/tennis/leakage.test.js,
   which recomputes a sample of rows by hand from matches strictly earlier and
   fails on any disagreement.

   THE ORDER IS A TOTAL ORDER. The archive dates a match to its tournament
   WEEK, so hundreds of matches share a date and "the previous row" would
   otherwise be whichever one the planner happened to emit first. Ordering by
   (date, round order, tournament, match number) is both deterministic and
   true to how a draw is actually played: an R32 match really does precede the
   R16 it feeds.

   NULL IS NOT ZERO. A player with no earlier match has no serve strength. The
   column stays null, `missing_fields` names it, and `completeness` falls — so
   the model widens its uncertainty and the research gate can refuse the match
   rather than reading an absent rate as a terrible one.

   Usage:
     node tools/tennis/build_features.js                 # report, write nothing
     node tools/tennis/build_features.js --commit
     node tools/tennis/build_features.js --commit --tour ATP
     node tools/tennis/build_features.js --commit --since 2015-01-01
   =========================================================================== */
'use strict';
const PG = require('./lib/pg.js');
const M = require('../../lib/tennis_model.js');

const JOB = 'feature_build';

function args(argv) {
  const o = { commit: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--commit') o.commit = true;
    else if (a === '--tour') o.tour = String(next() || '').toUpperCase();
    else if (a === '--since') o.since = next();
    else if (a === '--database') o.database = next();
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}
const say = (...a) => console.log(...a);
const fail = (...a) => console.error('::error::' + a.join(' '));

/* The rolling aggregate, as one statement. Everything is computed in the
   database because the alternative is streaming 723,000 feature rows through
   Node to add three columns to them. */
function buildSql(o) {
  const where = [];
  if (o.tour) where.push(`m.tour = ${PG.lit(o.tour)}`);
  if (o.since) where.push(`m.match_date >= ${PG.lit(o.since)}`);
  const filter = where.length ? 'where ' + where.join(' and ') : '';

  return `
with sides as (
  -- one row per player per match, with THIS match's serve numbers attached.
  -- They are the aggregate's input for LATER matches, never for this one.
  select m.match_id, m.match_date, m.round_order, m.source_tourney_id, m.match_num,
         m.tour, m.surface,
         m.winner_id as player_id, m.loser_id as opponent_id,
         (m.w_1st_won + m.w_2nd_won)::numeric        as sv_won,
         m.w_svpt::numeric                            as sv_pts,
         (m.l_svpt - (m.l_1st_won + m.l_2nd_won))::numeric as rt_won,
         m.l_svpt::numeric                            as rt_pts
    from tennis.matches m
   ${filter}
  union all
  select m.match_id, m.match_date, m.round_order, m.source_tourney_id, m.match_num,
         m.tour, m.surface,
         m.loser_id, m.winner_id,
         (m.l_1st_won + m.l_2nd_won)::numeric,
         m.l_svpt::numeric,
         (m.w_svpt - (m.w_1st_won + m.w_2nd_won))::numeric,
         m.w_svpt::numeric
    from tennis.matches m
   ${filter}
),
with_opp as (
  select s.*, f.elo_pre as opp_elo_pre
    from sides s
    left join tennis.player_match_features f
           on f.match_id = s.match_id and f.player_id = s.opponent_id
          and f.feature_version = ${PG.lit(M.FEATURE_VERSION)}
),
rolled as (
  select match_id, player_id,
         -- THE BOUNDARY: 1 preceding. The current match cannot reach its own row.
         sum(coalesce(sv_won,0)) over w as sv_won_before,
         sum(coalesce(sv_pts,0)) over w as sv_pts_before,
         sum(coalesce(rt_won,0)) over w as rt_won_before,
         sum(coalesce(rt_pts,0)) over w as rt_pts_before,
         count(sv_pts)           over w as serve_matches_before,
         avg(opp_elo_pre)        over w as sos_elo_before,
         count(opp_elo_pre)      over w as sos_sample_before
    from with_opp
  window w as (
    partition by player_id
    order by match_date, coalesce(round_order, 0), source_tourney_id, match_num, match_id
    rows between unbounded preceding and 1 preceding
  )
)
select r.match_id, r.player_id,
       case when r.sv_pts_before >= ${MIN_SERVE_POINTS}
            then round(r.sv_won_before / nullif(r.sv_pts_before,0), 4) end as serve_strength_pre,
       case when r.rt_pts_before >= ${MIN_SERVE_POINTS}
            then round(r.rt_won_before / nullif(r.rt_pts_before,0), 4) end as return_strength_pre,
       nullif(r.serve_matches_before, 0)::int as serve_sample_pre,
       case when r.sos_sample_before >= ${MIN_SOS_SAMPLE}
            then round(r.sos_elo_before, 3) end as sos_elo_pre,
       nullif(r.sos_sample_before, 0)::int as sos_sample_pre
  from rolled r`;
}

/* A serve rate over forty points is noise. Below these samples the column
   stays NULL, because an unreliable number that looks like a measurement is
   worse than an honest gap. */
const MIN_SERVE_POINTS = 150;
const MIN_SOS_SAMPLE = 5;

function main() {
  const o = args(process.argv.slice(2));
  if (o.help) { say(require('fs').readFileSync(__filename, 'utf8').split('*/')[0]); return 0; }
  const conn = PG.resolveConnection();
  if (!conn) { fail('no database connection (SUPABASE_DB_URL / DATABASE_URL / EDGD_PG)'); return 1; }
  const db = PG.client(conn, { database: o.database });
  if (!db.ping()) { fail('the database did not answer'); return 1; }
  if (db.scalar("select case when to_regclass('tennis.player_match_features') is null then 'no' else 'yes' end") !== 'yes') {
    fail('supabase/tennis_record.sql is not installed'); return 1;
  }

  const before = db.rows(`select count(*)::int as rows,
      count(serve_strength_pre)::int as with_serve,
      count(sos_elo_pre)::int as with_sos
    from tennis.player_match_features
    where feature_version = ${PG.lit(M.FEATURE_VERSION)}`)[0];
  say(`feature rows        ${before.rows}`);
  say(`  with serve rate   ${before.with_serve}`);
  say(`  with schedule     ${before.with_sos}`);

  if (!o.commit) {
    const sample = db.rows(buildSql(o) + ' limit 5');
    say('\nDRY RUN — nothing written. A sample of what would be computed:');
    sample.forEach((r) => say('  ' + r.match_id + ' ' + r.player_id +
      ' serve=' + (r.serve_strength_pre == null ? '—' : r.serve_strength_pre) +
      ' return=' + (r.return_strength_pre == null ? '—' : r.return_strength_pre) +
      ' sos=' + (r.sos_elo_pre == null ? '—' : r.sos_elo_pre) +
      ' (n=' + (r.serve_sample_pre || 0) + ')'));
    say('\nRe-run with --commit to write.');
    return 0;
  }

  const runId = db.scalar(`insert into tennis.ingestion_runs
      (job, source_key, build_version, scope, status)
    values (${PG.lit(JOB)}, 'edgedesk', ${PG.lit(M.FEATURE_VERSION)},
            ${PG.lit([o.tour || 'both tours', o.since || 'all dates'].join(' / '))}, 'running')
    returning run_id`);

  try {
    const t0 = Date.now();
    db.exec(`
      with computed as (${buildSql(o)})
      update tennis.player_match_features f set
        serve_strength_pre  = c.serve_strength_pre,
        return_strength_pre = c.return_strength_pre,
        serve_sample_pre    = c.serve_sample_pre,
        sos_elo_pre         = c.sos_elo_pre,
        sos_sample_pre      = c.sos_sample_pre,
        computed_at         = now(),
        ingestion_run_id    = '${runId}'::uuid
      from computed c
      where c.match_id = f.match_id and c.player_id = f.player_id
        and f.feature_version = ${PG.lit(M.FEATURE_VERSION)}`);

    /* Recompute what is missing and how complete the row is, now that three
       more columns may have been filled. The list is derived from the columns
       themselves so it can never drift from what the model actually reads. */
    const inputCols = M.MODEL_INPUTS;
    const missingExpr = inputCols.map((c) => `case when ${c} is null then '${c}' end`).join(', ');
    db.exec(`
      update tennis.player_match_features set
        missing_fields = array_remove(array[${missingExpr}], null),
        completeness = round((${inputCols.length} - cardinality(array_remove(array[${missingExpr}], null)))::numeric
                             / ${inputCols.length}, 3)
      where feature_version = ${PG.lit(M.FEATURE_VERSION)}`);

    const after = db.rows(`select count(*)::int as rows,
        count(serve_strength_pre)::int as with_serve,
        count(return_strength_pre)::int as with_return,
        count(sos_elo_pre)::int as with_sos,
        round(avg(completeness), 3) as mean_completeness
      from tennis.player_match_features
      where feature_version = ${PG.lit(M.FEATURE_VERSION)}`)[0];

    db.exec(`update tennis.ingestion_runs set status='ok', finished_at=now(),
               rows_updated=${after.rows}, reconciled=true,
               details=${PG.lit(JSON.stringify(after))}::jsonb
             where run_id='${runId}'::uuid`);

    say('');
    say(`  rows updated       ${after.rows}  in ${Math.round((Date.now() - t0) / 1000)}s`);
    say(`  with serve rate    ${after.with_serve}  (needs ${MIN_SERVE_POINTS} earlier service points)`);
    say(`  with return rate   ${after.with_return}`);
    say(`  with schedule      ${after.with_sos}  (needs ${MIN_SOS_SAMPLE} earlier opponents)`);
    say(`  mean completeness  ${after.mean_completeness}`);
    say('');
    say('  A null here is a gap, not a zero. The model reads completeness and widens');
    say('  its uncertainty; the research gate refuses a match below ' + M.GATES.minCompleteness + '.');
    return 0;
  } catch (e) {
    db.exec(`update tennis.ingestion_runs set status='error', finished_at=now(),
               error_summary=${PG.lit(String(e.message).slice(0, 900))} where run_id='${runId}'::uuid`);
    fail(e.message);
    return 1;
  }
}

if (require.main === module) process.exit(main());
module.exports = { buildSql, MIN_SERVE_POINTS, MIN_SOS_SAMPLE };
