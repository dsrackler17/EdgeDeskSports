#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk Tennis Lab — rating history snapshots.

   WHY THIS EXISTS. "This player is improving" is only a claim you can check if
   you know what the rating WAS. Without a history table the Lab can compare
   form windows — which is a different and noisier thing — but it cannot draw a
   rating line, and "biggest risers" has nothing to subtract from. Every
   trajectory number in the product ultimately rests on this table.

   THE POINT-IN-TIME RULE, ENFORCED BY CONSTRUCTION. A snapshot dated D must be
   what EdgeDesk would have said on D — nothing from D or later may touch it.
   This builder never recomputes an Elo. It reads tennis.player_match_features,
   whose columns all end `_pre` precisely because they describe what was known
   ENTERING that match, and for each snapshot date takes each player's most
   recent such row with match_date <= D.

   That is leak-free by construction rather than by care: the only values it can
   possibly read are ones the feature builder already proved were knowable
   before a match that had already happened by D. tools/tennis/leakage.test.js
   guards the feature table; this file inherits that guarantee instead of
   creating a second place where it could be broken.

   THE SNAPSHOT GRID. Monthly by default. Denser would multiply 106,887 players
   by the number of dates for a line nobody reads at daily resolution; sparser
   would make a 30-day delta impossible. `--every` changes it, `--from` and
   `--to` bound it, and a re-run overwrites the same (player, date, version)
   rows rather than accumulating duplicates.

   Usage:
     node tools/tennis/build_history.js                     # dry run
     node tools/tennis/build_history.js --commit
     node tools/tennis/build_history.js --from 2015-01-01 --every 30 --commit
     node tools/tennis/build_history.js --tour WTA --commit

   Exit codes: 0 ok · 1 failed
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const PG = require('./lib/pg.js');
const M = require('../../lib/tennis_model.js');
const L = require('../../lib/tennis_lab.js');

const JOB = 'rating_history_build';
const DEFAULT_EVERY_DAYS = 30;
const DEFAULT_LOOKBACK_YEARS = 5;

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--commit') o.commit = true;
    else if (a === '--tour') o.tour = M.normTour(next());
    else if (a === '--from') o.from = next();
    else if (a === '--to') o.to = next();
    else if (a === '--every') o.every = Math.max(1, Number(next()) || DEFAULT_EVERY_DAYS);
    else if (a === '--database') o.database = next();
    else if (a === '--min-sample') o.minSample = Math.max(0, Number(next()) || 0);
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}
const say = (...a) => console.log(...a);
const fail = (...a) => console.error('::error::' + a.join(' '));

function dateList(from, to, every) {
  const out = [];
  const a = new Date(from + 'T00:00:00Z'), b = new Date(to + 'T00:00:00Z');
  for (let d = new Date(a); d <= b; d.setUTCDate(d.getUTCDate() + every)) {
    out.push(d.toISOString().slice(0, 10));
  }
  /* Always include the end of the range, so the newest snapshot is the one a
     30-day delta is measured against rather than whatever the grid landed on. */
  const last = b.toISOString().slice(0, 10);
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/* One snapshot date. `distinct on` walks each player's matches once and takes
   the latest row at or before the date — a single ordered pass rather than a
   subquery per player, which is the shape that made the rating build tractable
   and is the shape every aggregate in this pipeline now uses. */
function snapshotSql(asOf, tourFilter, minSample) {
  const FV = PG.lit(M.FEATURE_VERSION);
  const tf = tourFilter ? `and f.tour = ${PG.lit(tourFilter)}` : '';
  return `
with latest as (
  select distinct on (f.player_id)
         f.player_id, f.tour, f.elo_pre, f.surface, f.surface_elo_pre, f.rank_pre, f.match_date
    from tennis.player_match_features f
   where f.feature_version = ${FV}
     and f.match_date <= ${PG.lit(asOf)}::date
     ${tf}
   order by f.player_id, f.match_date desc, f.feature_id desc
),
-- the per-surface figure as at the same date, one pass
surf as (
  select distinct on (f.player_id, f.surface)
         f.player_id, f.surface, f.surface_elo_pre
    from tennis.player_match_features f
   where f.feature_version = ${FV}
     and f.match_date <= ${PG.lit(asOf)}::date
     and f.surface in ('hard','clay','grass')
     ${tf}
   order by f.player_id, f.surface, f.match_date desc, f.feature_id desc
),
counts as (
  select f.player_id, count(*)::int as n
    from tennis.player_match_features f
   where f.feature_version = ${FV}
     and f.match_date <= ${PG.lit(asOf)}::date
     ${tf}
   group by f.player_id
)
select l.player_id, l.tour, l.elo_pre, l.rank_pre, c.n,
       max(s.surface_elo_pre) filter (where s.surface = 'hard')  as hard_elo,
       max(s.surface_elo_pre) filter (where s.surface = 'clay')  as clay_elo,
       max(s.surface_elo_pre) filter (where s.surface = 'grass') as grass_elo
  from latest l
  join counts c on c.player_id = l.player_id
  left join surf s on s.player_id = l.player_id
 where c.n >= ${Number(minSample) || 0}
 group by l.player_id, l.tour, l.elo_pre, l.rank_pre, c.n`;
}

const COLS = ['player_id', 'as_of', 'tour', 'elo', 'hard_elo', 'clay_elo', 'grass_elo',
  'power_rating', 'official_rank', 'sample', 'uncertainty', 'rating_version', 'source_key'];
const NUL = '\\N';
const tsv = (v) => (v == null || v === '' ? NUL
  : String(v).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r'));

async function main() {
  const o = args(process.argv.slice(2));
  if (o.help) { say(fs.readFileSync(__filename, 'utf8').split('*/')[0]); return 0; }
  const conn = PG.resolveConnection();
  if (!conn) { fail('no database connection (SUPABASE_DB_URL / DATABASE_URL / EDGD_PG)'); return 1; }
  const db = PG.client(conn, { database: o.database });
  if (!db.ping()) { fail('the database did not answer'); return 1; }
  if (!db.scalar("select to_regclass('tennis.rating_history')")) {
    fail('tennis.rating_history is missing — apply supabase/tennis_lab.sql first');
    return 1;
  }

  const span = db.rows(`select min(match_date)::text as lo, max(match_date)::text as hi,
                               count(*)::int as n from tennis.player_match_features
                         where feature_version = ${PG.lit(M.FEATURE_VERSION)}`)[0];
  if (!span || !span.n) {
    say('no point-in-time features on file. Run the import and tennis:features:build first.');
    return 0;
  }
  const to = o.to || span.hi;
  const defaultFrom = new Date(new Date(to + 'T00:00:00Z').getTime() - DEFAULT_LOOKBACK_YEARS * 365 * 86400000)
    .toISOString().slice(0, 10);
  const from = o.from || (span.lo > defaultFrom ? span.lo : defaultFrom);
  const every = o.every || DEFAULT_EVERY_DAYS;
  const minSample = o.minSample == null ? 5 : o.minSample;
  const dates = dateList(from, to, every);

  say('EdgeDesk Tennis Lab — rating history');
  say(`  feature version    ${M.FEATURE_VERSION}`);
  say(`  rating version     ${M.RATING_VERSION}`);
  say(`  record spans       ${span.lo} .. ${span.hi}  (${Number(span.n).toLocaleString()} feature rows)`);
  say(`  snapshot grid      ${from} .. ${to} every ${every}d  -> ${dates.length} dates`);
  say(`  minimum sample     ${minSample} matches before a player appears`);
  say(`  mode               ${o.commit ? 'COMMIT' : 'dry run (nothing is written)'}`);
  if (o.tour) say(`  tour               ${o.tour}`);

  /* The tour reference for the 0-100 scale is recomputed PER SNAPSHOT, because
     what counted as elite in 1994 is not what counts now. A fixed reference
     would make the history line drift for reasons that have nothing to do with
     the player. */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edgd-hist-'));
  let runId = null;
  let total = 0;
  const lines = [];
  try {
    const t0 = Date.now();
    for (let i = 0; i < dates.length; i++) {
      const d = dates[i];
      const rows = db.rows(snapshotSql(d, o.tour, minSample));
      if (!rows.length) continue;
      const byTour = {};
      rows.forEach((r) => { (byTour[r.tour || 'OTHER'] = byTour[r.tour || 'OTHER'] || []).push(r); });
      Object.keys(byTour).forEach((t) => {
        const pool = byTour[t].map((r) => M.num(r.elo_pre)).filter((v) => v != null);
        const ref = { mean: M.mean(pool), stdev: M.stdev(pool) };
        byTour[t].forEach((r) => {
          const pr = M.powerRating(r.elo_pre, r.n, ref);
          lines.push([
            tsv(r.player_id), tsv(d), tsv(r.tour),
            tsv(r.elo_pre == null ? null : M.round(Number(r.elo_pre), 3)),
            tsv(r.hard_elo == null ? null : M.round(Number(r.hard_elo), 3)),
            tsv(r.clay_elo == null ? null : M.round(Number(r.clay_elo), 3)),
            tsv(r.grass_elo == null ? null : M.round(Number(r.grass_elo), 3)),
            tsv(pr.power_rating), tsv(r.rank_pre), tsv(r.n), tsv(pr.uncertainty),
            tsv(M.RATING_VERSION), tsv('edgedesk')
          ].join('\t'));
          total++;
        });
      });
      if ((i + 1) % 12 === 0 || i === dates.length - 1) {
        say(`    ${d}  ${String(rows.length).padStart(7)} players  (${total.toLocaleString()} rows so far)`);
      }
    }
    say(`\n  snapshots built    ${total.toLocaleString()} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    if (!o.commit) {
      say('\n  dry run: nothing was written. Re-run with --commit.');
      return 0;
    }
    if (!total) { say('  nothing to write.'); return 0; }

    runId = db.scalar(`insert into tennis.ingestion_runs (job, source_key, status, started_at, details)
      values (${PG.lit(JOB)}, 'edgedesk', 'running', now(),
              jsonb_build_object('dates', ${dates.length}, 'every_days', ${every},
                                 'from', ${PG.lit(from)}, 'to', ${PG.lit(to)}))
      returning run_id`);

    const data = path.join(tmp, 'history.tsv');
    fs.writeFileSync(data, lines.join('\n') + '\n');
    db.script([
      'begin;',
      `create temp table t_hist (${COLS.map((c) => c + ' text').join(', ')}) on commit drop;`,
      `\\copy t_hist (${COLS.join(',')}) from '${data}' with (format text, null '\\N')`,
      /* A re-run must UPDATE the same (player, date, version) rather than
         accumulate a second row for the same day — the primary key makes that
         structural, and the conflict clause makes a rebuild idempotent. */
      `insert into tennis.rating_history
         (player_id, as_of, tour, elo, hard_elo, clay_elo, grass_elo, power_rating,
          official_rank, sample, uncertainty, rating_version, source_key, ingestion_run_id)
       select t.player_id, t.as_of::date, t.tour,
              nullif(t.elo,'')::numeric, nullif(t.hard_elo,'')::numeric,
              nullif(t.clay_elo,'')::numeric, nullif(t.grass_elo,'')::numeric,
              nullif(t.power_rating,'')::numeric, nullif(t.official_rank,'')::integer,
              coalesce(nullif(t.sample,'')::integer, 0), nullif(t.uncertainty,'')::numeric,
              t.rating_version, t.source_key, '${runId}'::uuid
         from t_hist t
       on conflict (player_id, as_of, rating_version) do update set
         elo = excluded.elo, hard_elo = excluded.hard_elo, clay_elo = excluded.clay_elo,
         grass_elo = excluded.grass_elo, power_rating = excluded.power_rating,
         official_rank = excluded.official_rank, sample = excluded.sample,
         uncertainty = excluded.uncertainty, computed_at = now(),
         ingestion_run_id = excluded.ingestion_run_id;`,
      `update tennis.ingestion_runs set status='ok', finished_at=now(), reconciled=true,
         rows_read=${total}, rows_inserted=${total} where run_id='${runId}'::uuid;`,
      'commit;'
    ], tmp);
  } catch (e) {
    if (runId) {
      db.exec(`update tennis.ingestion_runs set status='error', finished_at=now(),
                 error_summary=${PG.lit(String(e.message).slice(0, 900))} where run_id='${runId}'::uuid`);
    }
    fail(e.message);
    return 1;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }

  db.exec(`insert into tennis.meta (key, value) values ('rating_history_built', now()::text)
           on conflict (key) do update set value = excluded.value`);
  const chk = db.rows(`select count(*)::int as rows, count(distinct player_id)::int as players,
                              min(as_of)::text as lo, max(as_of)::text as hi
                         from tennis.rating_history`)[0];
  say(`\n  on file now        ${Number(chk.rows).toLocaleString()} rows, ${Number(chk.players).toLocaleString()} players, ${chk.lo} .. ${chk.hi}`);
  say(`  ${L.LAB_VERSION}: run tools/tennis/build_lab.js --commit to turn these into trajectory deltas.`);
  return 0;
}

if (require.main === module) {
  main().then((c) => process.exit(c)).catch((e) => { fail(e && e.stack || e); process.exit(1); });
}
module.exports = { dateList, snapshotSql, COLS };
