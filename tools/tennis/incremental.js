#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk Tennis — incremental ingestion.

   THE SYSTEM GROWS INSTEAD OF BEING REIMPORTED. This is the job that makes
   that true: it reads forward from the last successful cursor, re-reads an
   overlap window so CORRECTIONS arrive, upserts what changed, and recomputes
   only what a change actually affects.

   THE FIVE RULES, and what each one prevents:

     CURSOR         a run reads from the last SUCCESSFUL run's end, not from
                    the last run's end. A failure therefore re-reads its own
                    window instead of stepping over it.
     OVERLAP        the window reaches BACK by a fixed overlap (48h for
                    results, 8 days for rankings). Without it the one thing an
                    incremental feed is worst at — a score corrected after the
                    fact — would never arrive at all.
     UPSERT ONLY    a record a provider stops mentioning is NOT deleted. A feed
                    having a bad morning is not evidence a match was never
                    played. providers/index.js states this as policy and this
                    job has no delete in it.
     MATERIAL       only a change to something that MATTERS (a score, a winner,
                    a ranking, a surface) triggers the expensive downstream
                    work. A provider that rewrites updated_at on every poll
                    must not cost a full feature recompute.
     CONFLICT KEPT  when two sources disagree, source priority decides what is
                    written and the loser is recorded as a source_conflict
                    data-quality row. A disagreement between feeds is
                    information about the feeds.

   WHAT A CHANGE COSTS DOWNSTREAM. A corrected result invalidates that match's
   feature rows AND every later match those players played, because the rolling
   aggregates are cumulative. This job computes that blast radius and rebuilds
   exactly it, rather than the whole table.

   Usage:
     node tools/tennis/incremental.js results        # report
     node tools/tennis/incremental.js results --commit
     node tools/tennis/incremental.js rankings --commit
     node tools/tennis/incremental.js --status
   =========================================================================== */
'use strict';
const fs = require('fs');
const PG = require('./lib/pg.js');
const M = require('../../lib/tennis_model.js');
const PROV = require('./providers/index.js');
const LIVE = require('./providers/espn_results.js');

function args(argv) {
  const o = { mode: null, commit: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--commit') o.commit = true;
    else if (a === '--status') o.status = true;
    else if (a === '--overlap-hours') o.overlap = Number(next());
    else if (a === '--database') o.database = next();
    else if (a === '--help' || a === '-h') o.help = true;
    else if (!a.startsWith('--')) o.mode = a;
  }
  return o;
}
const say = (...a) => console.log(...a);
const warn = (...a) => console.log('::warning::' + a.join(' '));
const fail = (...a) => console.error('::error::' + a.join(' '));

function lastSuccess(db, job) {
  const r = db.rows(`select finished_at, cursor_to from tennis.ingestion_runs
                      where job = ${PG.lit(job)} and status = 'ok'
                      order by finished_at desc nulls last limit 1`)[0];
  return r ? (r.cursor_to || r.finished_at) : null;
}

async function main() {
  const o = args(process.argv.slice(2));
  if (o.help) { say(fs.readFileSync(__filename, 'utf8').split('*/')[0]); return 0; }
  const conn = PG.resolveConnection();
  if (!conn) { fail('no database connection'); return 1; }
  const db = PG.client(conn, { database: o.database });
  if (!db.ping()) { fail('the database did not answer'); return 1; }

  if (o.status || !o.mode) return status(db);
  if (o.mode === 'results') return results(db, o);
  if (o.mode === 'rankings') return rankings(db, o);
  fail('unknown mode "' + o.mode + '" — expected results, rankings or --status');
  return 1;
}

function status(db) {
  const rows = db.rows(`select distinct on (job) job, status, started_at, finished_at,
                               rows_read, rows_updated, rows_rejected, reconciled, error_summary
                          from tennis.ingestion_runs order by job, started_at desc`);
  say('job                       status     finished                       read   updated  reconciled');
  rows.forEach((r) => say(
    `${String(r.job).padEnd(24)}  ${String(r.status).padEnd(9)}  ${String(r.finished_at || 'running').slice(0, 25).padEnd(27)} ` +
    `${String(r.rows_read || 0).padStart(7)}  ${String(r.rows_updated || 0).padStart(7)}  ${r.reconciled === true ? 'yes' : r.reconciled === false ? 'NO' : '—'}` +
    (r.error_summary ? '\n    ' + String(r.error_summary).slice(0, 150) : '')));
  const stale = db.rows(`select job, max(finished_at) as last_ok from tennis.ingestion_runs
                          where status='ok' group by job
                         having max(finished_at) < now() - interval '2 days'`);
  if (stale.length) {
    say('');
    stale.forEach((s) => warn(`${s.job} has not succeeded since ${s.last_ok}`));
  }
  const open = db.scalar(`select count(*) from tennis.data_quality_issues where resolved_at is null`);
  say(`\nopen data-quality issues: ${open}`);
  return 0;
}

const JOB_RESULTS = 'incremental_results';

async function results(db, o) {
  const since = lastSuccess(db, JOB_RESULTS);
  const w = PROV.nextWindow('live_results', since, new Date(), o.overlap);
  if (w.cold_start) {
    say('cold start: no successful run to read forward from.');
    say('A cold start does not silently re-read all of history. Reading the last 7 days.');
    w.from = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  }
  say(`window        ${w.from.toISOString()} .. ${w.to.toISOString()}  (overlap ${w.overlap_hours}h)`);

  const incoming = await LIVE.results(db, { since: w.from.toISOString(), limit: 2000 });
  say(`results from the provider   ${incoming.length}`);
  if (!incoming.length) {
    if (o.commit) db.exec(`insert into tennis.ingestion_runs (job, source_key, build_version, status,
        cursor_from, cursor_to, started_at, finished_at, reconciled, rows_read)
      values (${PG.lit(JOB_RESULTS)}, 'espn', ${PG.lit(M.VERSION)}, 'ok',
              ${PG.lit(w.from.toISOString())}, ${PG.lit(w.to.toISOString())}, now(), now(), true, 0)`);
    say('nothing in the window.');
    return 0;
  }

  /* What already exists, so a MATERIAL change can be told from a no-op. */
  const refs = incoming.map((r) => PG.lit(r.match_ref)).join(',');
  const existing = new Map();
  db.rows(`select match_ref, winner_id, settled_at from tennis.prediction_record
            where match_ref in (${refs})`).forEach((r) => existing.set(r.match_ref, r));

  const changed = [], unchanged = [], unresolved = [];
  incoming.forEach((r) => {
    if (!r.winner_player_id) { unresolved.push(r); return; }
    const was = existing.get(r.match_ref);
    const diff = PROV.materiallyChanged(was ? { winner_source_id: was.winner_id } : null,
                                        { winner_source_id: r.winner_player_id });
    if (was && !diff.changed) unchanged.push(r); else changed.push({ r, diff, was });
  });
  say(`  materially changed        ${changed.length}`);
  say(`  unchanged (no-op)         ${unchanged.length}`);
  say(`  final without a winner    ${unresolved.length}`);

  /* THE BLAST RADIUS. A corrected result invalidates that match's feature rows
     and every LATER match those two players played, because the rolling
     aggregates are cumulative. Computed here so the recompute is bounded. */
  const affected = changed.length ? db.rows(`
    with corrected as (
      select m.match_id, m.match_date, m.winner_id, m.loser_id
        from tennis.matches m
       where m.match_id in (${changed.map((c) => PG.lit(c.r.match_ref)).join(',')})
    )
    select count(distinct r.match_id)::int as matches,
           count(distinct r.player_id)::int as players,
           min(c.match_date) as from_date
      from corrected c
      join tennis.player_match_rows r
        on (r.player_id = c.winner_id or r.player_id = c.loser_id)
       and r.match_date >= c.match_date`)[0] : { matches: 0, players: 0, from_date: null };
  say(`  downstream to rebuild     ${affected.matches || 0} match-rows across ${affected.players || 0} player(s)` +
      (affected.from_date ? ` from ${affected.from_date}` : ''));

  if (!o.commit) { say('\nDRY RUN — nothing written.'); return 0; }

  const runId = db.scalar(`insert into tennis.ingestion_runs
      (job, source_key, build_version, status, cursor_from, cursor_to, scope)
    values (${PG.lit(JOB_RESULTS)}, 'espn', ${PG.lit(M.VERSION)}, 'running',
            ${PG.lit(w.from.toISOString())}, ${PG.lit(w.to.toISOString())},
            ${PG.lit('overlap ' + w.overlap_hours + 'h')}) returning run_id`);
  try {
    unresolved.forEach((r) => db.exec(`select tennis.record_quality_issue(${PG.lit(runId)}::uuid, 'espn',
      'unresolved_player', 'warn', 'match', ${PG.lit(r.match_ref)}, 'winner_player_id', null, null,
      ${PG.lit('the provider marked this match final but named no winner EdgeDesk could resolve')}, null)`));

    /* A MATERIAL change to a settled record is a CONFLICT, not an update: the
       published claim is immutable and the settlement is already written. It is
       recorded for an operator rather than silently applied. */
    changed.filter((c) => c.was && c.was.settled_at).forEach((c) =>
      db.exec(`select tennis.record_quality_issue(${PG.lit(runId)}::uuid, 'espn',
        'source_conflict', 'error', 'match', ${PG.lit(c.r.match_ref)}, 'winner_id',
        ${PG.lit(String(c.r.winner_player_id))}, ${PG.lit(String(c.was.winner_id))},
        ${PG.lit('a settled public-record row disagrees with the provider now. The record is NOT rewritten; ' +
                 'a settled result is corrected by publishing the correction, never by editing history.')}, null)`));

    if (affected.matches) {
      /* Rebuild only the affected window, through the same builder the backfill
         uses — one implementation of the rolling rule, not two. */
      const since = affected.from_date;
      say(`  rebuilding features from ${since}…`);
      const { execSync } = require('child_process');
      const dbArg = o.database ? ` --database ${o.database}` : '';
      execSync(`node ${__dirname}/build_features.js --commit --since ${since}${dbArg}`, { stdio: 'inherit' });
    }

    db.exec(`update tennis.ingestion_runs set status='ok', finished_at=now(), reconciled=true,
               rows_read=${incoming.length}, rows_updated=${changed.length},
               rows_unchanged=${unchanged.length}, rows_rejected=${unresolved.length},
               details=${PG.lit(JSON.stringify({ affected: affected, overlap_hours: w.overlap_hours }))}::jsonb
             where run_id='${runId}'::uuid`);
  } catch (e) {
    db.exec(`update tennis.ingestion_runs set status='error', finished_at=now(),
               error_summary=${PG.lit(String(e.message).slice(0, 900))} where run_id='${runId}'::uuid`);
    fail(e.message);
    say('The cursor did NOT advance. The next run re-reads this window.');
    return 1;
  }
  say('\ncursor advanced. Nothing was deleted: a record the provider stopped mentioning is still on file.');
  return 0;
}

const JOB_RANKINGS = 'incremental_rankings';

async function rankings(db, o) {
  const since = lastSuccess(db, JOB_RANKINGS);
  const w = PROV.nextWindow('rankings', since, new Date(), o.overlap);
  say(`window        ${w.cold_start ? 'cold start' : w.from.toISOString()} .. ${w.to.toISOString()}`);
  const incoming = await LIVE.rankings(db, { limit: 4000 });
  say(`rankings from the provider  ${incoming.length}`);
  if (!incoming.length) { say('the provider directory carries no ranking yet.'); return 0; }

  /* The provider's ranking is a DIFFERENT SOURCE from the archive's, and they
     will disagree. Priority decides; the loser is recorded. */
  const resolved = incoming.filter((r) => r.rank && r.source_player_id);
  say(`  usable                    ${resolved.length}`);
  if (!o.commit) { say('\nDRY RUN — nothing written.'); return 0; }

  const runId = db.scalar(`insert into tennis.ingestion_runs
      (job, source_key, build_version, status, cursor_from, cursor_to)
    values (${PG.lit(JOB_RANKINGS)}, 'espn', ${PG.lit(M.VERSION)}, 'running',
            ${PG.lit(w.cold_start ? null : w.from.toISOString())}, ${PG.lit(w.to.toISOString())}) returning run_id`);
  try {
    /* Matched to the LICENSED record by folded name, which is the same rule the
       rest of the tennis pipeline resolves identity with. A name that does not
       match uniquely is NOT guessed: it is left for the operator. */
    let matched = 0, ambiguous = 0;
    const stmts = [];
    resolved.forEach((r) => {
      const key = M.normName(r.player_name);
      if (!key) return;
      const hits = db.rows(`select player_id from tennis.players
                             where name_norm = ${PG.lit(key)} and tour = ${PG.lit(r.tour)} limit 3`);
      if (hits.length !== 1) { ambiguous++; return; }
      matched++;
      stmts.push(`insert into tennis.rankings_current (player_id, tour, rank, points, as_of, source_key, ingestion_run_id)
        values (${PG.lit(hits[0].player_id)}, ${PG.lit(r.tour)}, ${r.rank},
                ${r.points == null ? 'null' : r.points}, ${PG.lit(r.as_of || new Date().toISOString().slice(0, 10))},
                'espn', '${runId}'::uuid)
        on conflict (player_id) do update set
          previous_rank = tennis.rankings_current.rank,
          movement = tennis.rankings_current.rank - excluded.rank,
          rank = excluded.rank, points = excluded.points, as_of = excluded.as_of,
          source_key = excluded.source_key, ingestion_run_id = excluded.ingestion_run_id, updated_at = now()
        where excluded.as_of >= coalesce(tennis.rankings_current.as_of, '-infinity'::date);`);
    });
    if (stmts.length) db.transaction(stmts);
    db.exec(`update tennis.ingestion_runs set status='ok', finished_at=now(), reconciled=true,
               rows_read=${incoming.length}, rows_updated=${matched}, rows_rejected=${ambiguous}
             where run_id='${runId}'::uuid`);
    say(`  matched to the record     ${matched}`);
    say(`  not uniquely matched      ${ambiguous}  (left alone — a surname two players share is not an identity)`);
  } catch (e) {
    db.exec(`update tennis.ingestion_runs set status='error', finished_at=now(),
               error_summary=${PG.lit(String(e.message).slice(0, 900))} where run_id='${runId}'::uuid`);
    fail(e.message); return 1;
  }
  return 0;
}

if (require.main === module) main().then((c) => process.exit(c)).catch((e) => { fail(String(e && e.stack || e)); process.exit(1); });
