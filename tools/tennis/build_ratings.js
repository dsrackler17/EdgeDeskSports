#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk Tennis — the current player rating layer.

   WHAT THIS IS. One row per player: overall and per-surface Elo, recent form,
   workload, rest, official ranking, and the EdgeDesk power rating on the
   documented 0-100 scale. It exists so the website never scans 361,000
   matches to draw a player card.

   HOW THE CURRENT ELO IS DERIVED, said plainly. The archive publishes a
   PRE-MATCH Elo on every row and no post-match one. A player's current rating
   is therefore their last match's pre-match Elo advanced by ONE standard Elo
   step against the opponent they actually faced:

       elo_after = elo_before + K * (result - expected),  K = 32

   That is a derivation, not a published figure, and the row says so:
   rating_version carries it, source_key is 'edgedesk', and computed_at is when
   it was done. `--strength <player_strength_latest.csv>` overrides it with the
   archive's own snapshot where one exists, which is preferred when available
   because it is the source's own number rather than ours.

   THE POWER RATING IS SHRUNK, AND THE SHRINKAGE IS THE POINT. A player with
   six matches on file does not get the same 0-100 number as one with six
   hundred at the same Elo: the rating is pulled toward the tour median in
   proportion to what is missing, and `uncertainty` and `rating_sample` travel
   with it so no screen can show the number alone. The rule lives once, in
   lib/tennis_model.js, and the SQL contract quotes the same words back through
   tennis.power_rating_scale().

   Usage:
     node tools/tennis/build_ratings.js                       # report only
     node tools/tennis/build_ratings.js --commit
     node tools/tennis/build_ratings.js --commit --strength player_strength_latest.csv
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const PG = require('./lib/pg.js');
const CSV = require('./lib/csv.js');
const M = require('../../lib/tennis_model.js');

const JOB = 'rating_build';
const K_FACTOR = 32;
const SURFACES = ['hard', 'clay', 'grass', 'carpet'];

function args(argv) {
  const o = { commit: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--commit') o.commit = true;
    else if (a === '--strength') o.strength = next();
    else if (a === '--tour') o.tour = String(next() || '').toUpperCase();
    else if (a === '--database') o.database = next();
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}
const say = (...a) => console.log(...a);
const fail = (...a) => console.error('::error::' + a.join(' '));

/* The latest state per player, straight from the record. Everything here is a
   count or a last-value over stored matches; nothing is projected.

   WHY THIS IS SHAPED THE WAY IT IS. The obvious version of this query — a
   correlated subquery per player for the surface splits — is O(n^2) and it was
   measured, not guessed: against 290,280 matches and 106,887 players it did not
   finish inside NINE MINUTES, because a `(select json_agg(...) from surface_last
   where player_id = lf.player_id)` in the SELECT list re-scans a materialised
   CTE once per output row. Pre-aggregating the surface splits into their own
   CTE and LEFT JOINing it turns 106,887 scans into one hash join.

   The two window functions it used to need are gone for the same reason: a
   `distinct on` over an ordered scan and a plain GROUP BY do the same work
   without sorting the whole join twice at a 4MB work_mem. */
function stateSql(tourFilter) {
  const f = tourFilter ? `where tour = ${PG.lit(tourFilter)}` : '';
  const SURF = `('hard','clay','grass','carpet')`;
  return `
-- THE FORM WINDOWS ARE ANCHORED TO THE RECORD, NOT TO THE WALL CLOCK.
--
-- as_of is the latest match date on file. On a live system fed by a current
-- results provider that IS today, and nothing changes. On an archive it is the
-- archive's own end, and that is the difference between a useful answer and no
-- answer at all: the supplied ATP/WTA archive ends 2026-05-25, so against
-- current_date every single one of 15,515 players had a null 30- and 90-day
-- form and every one classified "returning from inactivity". Two of the Lab's
-- views rendered nothing, and the numbers that did survive described a window
-- in which no tennis had been played.
--
-- "30-day form as at the end of the record" is a real statement about a
-- historical archive. "30-day form as at today" over a record that stops in May
-- is a statement about nothing. The anchor is stored on every rating row as
-- form_as_of and the page prints it, so the reader is never left to assume it
-- means today — which is the brief's rule about labelling historical and
-- current information, applied to the thing most likely to be misread.
with as_of as (select coalesce(max(match_date), current_date) as d from tennis.matches),
rows as materialized (select * from tennis.player_match_rows ${f}),
last_match as (
  select distinct on (r.player_id)
         r.player_id, r.tour, r.match_id, r.match_date, r.won, r.opponent_id, r.surface
    from rows r
   order by r.player_id, r.match_date desc, r.match_id desc
),
last_feat as (
  select lm.player_id, lm.tour, lm.match_date, lm.won, lm.surface as last_surface,
         f.elo_pre, f.surface_elo_pre,
         fo.elo_pre as opp_elo_pre, fo.surface_elo_pre as opp_surface_elo_pre
    from last_match lm
    left join tennis.player_match_features f
           on f.match_id = lm.match_id and f.player_id = lm.player_id
          and f.feature_version = ${PG.lit(M.FEATURE_VERSION)}
    left join tennis.player_match_features fo
           on fo.match_id = lm.match_id and fo.player_id = lm.opponent_id
          and fo.feature_version = ${PG.lit(M.FEATURE_VERSION)}
),
-- how many matches on each surface: a plain GROUP BY, not a window over a join
surface_counts as (
  select player_id, surface, count(*)::int as n
    from rows where surface in ${SURF}
   group by player_id, surface
),
-- The most recent PRE-match surface Elo on each surface, AND THE OVERALL ELO
-- FROM THE SAME ROW. One ordered pass.
--
-- The paired baseline is the whole point. A surface rating is as of the
-- player's last match ON THAT SURFACE; the overall rating is as of their last
-- match ANYWHERE. For a player whose surface mix shifted late in their career
-- those are different points in it, and subtracting one from the other
-- measures the gap between two career moments rather than a surface
-- preference. That produced a translator board headed by Andy Murray as the
-- tour's biggest clay specialist — his clay ladder stopped updating while his
-- overall kept falling through a hard-court decline.
--
-- Both figures come off the same feature row, so the difference is a single
-- point in time by construction.
surface_elo as (
  select distinct on (r.player_id, r.surface)
         r.player_id, r.surface, f.surface_elo_pre as elo_pre, f.elo_pre as base_pre
    from rows r
    join tennis.player_match_features f
      on f.match_id = r.match_id and f.player_id = r.player_id
     and f.feature_version = ${PG.lit(M.FEATURE_VERSION)}
   where r.surface in ${SURF}
   order by r.player_id, r.surface, r.match_date desc, r.match_id desc
),
-- pre-aggregated ONCE, then joined. This is the line that took the job from
-- "did not finish in nine minutes" to seconds.
surface_agg as (
  select c.player_id,
         json_agg(json_build_object('surface', c.surface, 'elo', e.elo_pre,
                                    'base', e.base_pre, 'n', c.n)) as surfaces
    from surface_counts c
    left join surface_elo e on e.player_id = c.player_id and e.surface = c.surface
   group by c.player_id
),
form as (
  select player_id,
         count(*)::int as matches_all,
         count(*) filter (where match_date >= (select d from as_of) - 30)::int  as m30,
         count(*) filter (where match_date >= (select d from as_of) - 90)::int  as m90,
         count(*) filter (where match_date >= (select d from as_of) - 365)::int as m365,
         count(*) filter (where match_date >= (select d from as_of) - 7)::int   as m7,
         count(*) filter (where match_date >= (select d from as_of) - 14)::int  as m14,
         count(*) filter (where match_date >= (select d from as_of) - 28)::int  as m28,
         avg(case when won then 1.0 else 0.0 end) filter (where match_date >= (select d from as_of) - 30)  as f30,
         avg(case when won then 1.0 else 0.0 end) filter (where match_date >= (select d from as_of) - 90)  as f90,
         avg(case when won then 1.0 else 0.0 end) filter (where match_date >= (select d from as_of) - 365) as f365,
         max(match_date) as last_match_date,
         (select d from as_of) as form_as_of
    from rows group by player_id
)
select lf.player_id, lf.tour,
       lf.elo_pre, lf.opp_elo_pre, lf.won, lf.surface_elo_pre, lf.opp_surface_elo_pre, lf.last_surface,
       fo.matches_all, fo.m7, fo.m14, fo.m28, fo.m30, fo.m90, fo.m365,
       fo.f30, fo.f90, fo.f365, fo.last_match_date, fo.form_as_of,
       rk.rank as official_rank, rk.points as official_rank_points, rk.as_of as official_rank_as_of,
       sa.surfaces
  from last_feat lf
  join form fo on fo.player_id = lf.player_id
  left join surface_agg sa on sa.player_id = lf.player_id
  left join tennis.rankings_current rk on rk.player_id = lf.player_id`;
}

/* One Elo step. Documented above; K is a constant of this build, not a tuned
   parameter, and it is stored in rating_version so a rating can always be
   traced to the rule that produced it. */
function advanceElo(before, oppBefore, won) {
  const e = M.num(before);
  if (e == null) return null;
  const o = M.num(oppBefore);
  if (o == null || won == null) return M.round(e, 3);
  const expected = 1 / (1 + Math.pow(10, (o - e) / 400));
  return M.round(e + K_FACTOR * ((won ? 1 : 0) - expected), 3);
}

/* The archive's own latest strength snapshot, when supplied. Preferred over
   our derivation because it is the source's number; the row records which was
   used through rating_version. */
async function readStrength(file) {
  const by = new Map();
  for await (const rec of CSV.readRows(file)) {
    const r = CSV.toObject(rec.header, rec.values);
    const tour = M.normTour(r.tour);
    const pid = M.playerKey(tour, M.str(r.player_id), 'archive');
    by.set(pid, { elo: M.num(r.elo_pre), surface_elo: M.num(r.surface_elo_pre),
                  as_of: M.parseDate(r.as_of_date) });
  }
  return by;
}

async function main() {
  const o = args(process.argv.slice(2));
  if (o.help) { say(fs.readFileSync(__filename, 'utf8').split('*/')[0]); return 0; }
  const conn = PG.resolveConnection();
  if (!conn) { fail('no database connection (SUPABASE_DB_URL / DATABASE_URL / EDGD_PG)'); return 1; }
  const db = PG.client(conn, { database: o.database });
  if (!db.ping()) { fail('the database did not answer'); return 1; }

  const strength = o.strength ? await readStrength(o.strength) : null;
  if (strength) say(`strength snapshot   ${strength.size} players from ${path.basename(o.strength)}`);

  const state = db.rows(stateSql(o.tour));
  if (!state.length) { say('no rated players: the record is empty. Import the archive first.'); return 0; }
  say(`players with a record  ${state.length}`);

  /* The tour's own Elo distribution is the reference the 0-100 scale is drawn
     against, and it is recomputed every build rather than hard-coded: what
     counts as elite drifts, and a fixed reference would make the scale lie
     slowly. Only ACTIVE players count toward it — including everyone who ever
     played would put the median somewhere in 1974. */
  const byTour = {};
  state.forEach((s) => {
    const t = s.tour || 'OTHER';
    (byTour[t] = byTour[t] || []).push(s);
  });
  const ref = {};
  Object.keys(byTour).forEach((t) => {
    const active = byTour[t].filter((s) => s.m365 > 0 && s.elo_pre != null).map((s) => Number(s.elo_pre));
    const pool = active.length >= 30 ? active : byTour[t].filter((s) => s.elo_pre != null).map((s) => Number(s.elo_pre));
    ref[t] = { mean: M.mean(pool), stdev: M.stdev(pool), n: pool.length };
    say(`  ${t} reference       mean ${M.round(ref[t].mean, 1)} sd ${M.round(ref[t].stdev, 1)} over ${ref[t].n} player(s)`);
  });

  const COLS = ['player_id', 'tour', 'elo', 'hard_elo', 'clay_elo', 'grass_elo', 'carpet_elo',
    'elo_sample', 'hard_sample', 'clay_sample', 'grass_sample', 'carpet_sample',
    'form_30d', 'form_90d', 'form_365d', 'form_sample_365d',
    'matches_7d', 'matches_14d', 'matches_28d', 'rest_days',
    'official_rank', 'official_rank_points', 'official_rank_as_of',
    'power_rating', 'power_rating_surface', 'rating_sample', 'uncertainty',
    'last_match_date', 'days_since_last_match', 'active', 'rating_version', 'source_key', 'form_as_of'];

  const lines = [];
  let usedSnapshot = 0, derived = 0;
  const today = new Date();
  state.forEach((s) => {
    const tour = s.tour || 'OTHER';
    const snap = strength ? strength.get(s.player_id) : null;
    let elo, version;
    if (snap && snap.elo != null) { elo = M.round(snap.elo, 3); usedSnapshot++; version = M.RATING_VERSION + '+snapshot'; }
    else { elo = advanceElo(s.elo_pre, s.opp_elo_pre, s.won); derived++; version = M.RATING_VERSION + '+elo_step_k' + K_FACTOR; }

    const surf = {};
    (s.surfaces || []).forEach((x) => { if (x && x.surface) surf[x.surface] = x; });
    /* The surface Elo of the surface the player LAST played on is advanced by
       the same step; the others are the last pre-match figure on that surface,
       which is what the record actually knows. */
    function surfaceElo(name) {
      const x = surf[name];
      if (!x || x.elo == null) return null;
      if (name === s.last_surface) return advanceElo(x.elo, s.opp_surface_elo_pre, s.won);
      return M.round(Number(x.elo), 3);
    }
    function surfaceN(name) { return surf[name] ? Number(surf[name].n) : 0; }

    const sample = Number(s.matches_all || 0);
    const pr = M.powerRating(elo, sample, ref[tour]);
    const prSurface = {};
    SURFACES.forEach((sf) => {
      const e = surfaceElo(sf), n = surfaceN(sf);
      if (e == null) return;
      const p = M.powerRating(e, n, ref[tour]);
      /* baseline_elo: the player's OVERALL Elo at the same match this surface
         figure came from, so the translator can difference two numbers from one
         moment rather than from two different points in a career. */
      const x = surf[sf];
      prSurface[sf] = { power_rating: p.power_rating, uncertainty: p.uncertainty, sample: n,
                        baseline_elo: (x && x.base != null) ? M.round(Number(x.base), 3) : null };
    });

    /* MEASURED FROM THE RECORD'S END, not from the wall clock — the same
       anchor the form windows use. On a live feed the two are the same day. On
       an archive that stops in May, measuring from today makes every player
       "inactive for four months", which describes the dataset's staleness
       rather than the player and empties the fatigue lab of the very players
       it exists to show. `form_as_of` is stored beside it so a reader always
       knows which day "since" is counted from. */
    const asOf = s.form_as_of ? new Date(s.form_as_of + 'T00:00:00Z') : today;
    const last = s.last_match_date ? new Date(s.last_match_date + 'T00:00:00Z') : null;
    const daysSince = last ? Math.max(0, Math.floor((asOf - last) / 86400000)) : null;
    /* Rest days from the last match on file. It is a fact about the record,
       not about a schedule EdgeDesk does not hold. */
    const restDays = daysSince;

    lines.push(CSV.copyLine([
      s.player_id, tour, elo,
      surfaceElo('hard'), surfaceElo('clay'), surfaceElo('grass'), surfaceElo('carpet'),
      sample, surfaceN('hard'), surfaceN('clay'), surfaceN('grass'), surfaceN('carpet'),
      s.f30 == null ? null : M.round(Number(s.f30), 4),
      s.f90 == null ? null : M.round(Number(s.f90), 4),
      s.f365 == null ? null : M.round(Number(s.f365), 4),
      s.m365 || 0, s.m7 || 0, s.m14 || 0, s.m28 || 0, restDays,
      s.official_rank, s.official_rank_points, s.official_rank_as_of,
      pr.power_rating, JSON.stringify(prSurface), pr.sample, pr.uncertainty,
      s.last_match_date, daysSince,
      daysSince != null && daysSince <= 548 ? 't' : 'f',
      version, 'edgedesk', s.form_as_of || null
    ]));
  });

  say(`  ratings computed     ${lines.length}  (${usedSnapshot} from the source snapshot, ${derived} derived by one Elo step)`);

  if (!o.commit) {
    const top = state.filter((s) => s.elo_pre != null && s.m365 > 0)
      .sort((a, b) => Number(b.elo_pre) - Number(a.elo_pre)).slice(0, 5);
    say('\nDRY RUN — nothing written. The five highest-rated active players would be:');
    top.forEach((s) => say('  ' + s.player_id + '  elo ' + M.round(Number(s.elo_pre), 1) +
      '  power ' + M.powerRating(s.elo_pre, s.matches_all, ref[s.tour || 'OTHER']).power_rating +
      '  (n=' + s.matches_all + ')'));
    say('\nRe-run with --commit to write.');
    return 0;
  }

  const runId = db.scalar(`insert into tennis.ingestion_runs (job, source_key, build_version, scope, status)
    values (${PG.lit(JOB)}, 'edgedesk', ${PG.lit(M.RATING_VERSION)},
            ${PG.lit(o.tour || 'both tours')}, 'running') returning run_id`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edgd-tennis-ratings-'));
  const f = path.join(tmp, 'ratings.tsv');
  fs.writeFileSync(f, lines.join(''));
  try {
    db.script([
      '\\set ON_ERROR_STOP on', 'begin;',
      'create temp table t_ratings (like tennis.player_ratings_current including defaults) on commit drop;',
      `\\copy t_ratings (${COLS.join(',')}) from '${f}' with (format text, null '\\N')`,
      `insert into tennis.player_ratings_current (${COLS.join(',')}, ingestion_run_id, computed_at)
         select ${COLS.join(',')}, '${runId}'::uuid, now() from t_ratings
       on conflict (player_id) do update set
         ${COLS.filter((c) => c !== 'player_id').map((c) => `${c} = excluded.${c}`).join(', ')},
         ingestion_run_id = excluded.ingestion_run_id, computed_at = now(), updated_at = now();`,
      `update tennis.ingestion_runs set status='ok', finished_at=now(), reconciled=true,
         rows_read=${lines.length}, rows_updated=${lines.length},
         details=jsonb_build_object('snapshot_used', ${usedSnapshot}, 'derived', ${derived})
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

  db.exec(`insert into tennis.meta (key, value) values ('ratings_built', now()::text)
           on conflict (key) do update set value = excluded.value`);

  const top = db.rows(`select p.full_name, r.tour, r.power_rating, r.uncertainty, r.rating_sample, r.clay_elo
     from tennis.player_ratings_current r join tennis.players p on p.player_id = r.player_id
    where r.active order by r.power_rating desc nulls last limit 5`);
  say('\n  highest power ratings on file:');
  top.forEach((t) => say(`    ${String(t.power_rating).padStart(6)}  ±${t.uncertainty}  n=${String(t.rating_sample).padStart(4)}  ${t.tour}  ${t.full_name}`));
  say('\n  ' + M.ratingScaleText().split('. ')[0] + '.');
  return 0;
}

if (require.main === module) main().then((c) => process.exit(c)).catch((e) => { fail(String(e && e.stack || e)); process.exit(1); });
module.exports = { advanceElo, stateSql, K_FACTOR };
