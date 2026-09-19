#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk Tennis — the daily research brief, with no sportsbook.

   WHAT MAKES THIS DIFFERENT FROM EVERY OTHER DAILY PRODUCT. A brief that needs
   a schedule fails on the Monday after a Slam. A brief that needs odds fails on
   any project without an odds provider — which, for the Tennis Lab, is every
   project. So this one is built in tiers and ALWAYS lands somewhere:

     scheduled   a verified schedule exists  -> matches worth researching
     trends      no schedule, but ratings moved -> player trends, model watch
     historical  neither -> surface notes and record-level research

   AND IT NEVER INVENTS A FIXTURE. If no verified schedule is on file the brief
   says so in its own header rather than quietly presenting a trend brief as a
   preview of today's play. The tier is stored on the row, so a reader — and
   the AI — can always tell which of the three they are looking at.

   NO ODDS, STRUCTURALLY. tennis.research_briefs carries `contains_odds` and
   `contains_selections` as CHECK-constrained columns fixed at false: a brief
   with market content or a selection in it cannot be stored, whatever this
   file does. That is deliberate — the guarantee belongs in the database, not
   in the good intentions of a generator.

   Usage:
     node tools/tennis/build_brief.js --tour ATP              # dry run, prints it
     node tools/tennis/build_brief.js --tour ATP --commit
     node tools/tennis/build_brief.js --all --commit          # both tours
     node tools/tennis/build_brief.js --tour WTA --date 2026-09-19 --commit

   Exit codes: 0 ok · 1 failed
   =========================================================================== */
'use strict';
const fs = require('fs');
const PG = require('./lib/pg.js');
const M = require('../../lib/tennis_model.js');
const L = require('../../lib/tennis_lab.js');

const JOB = 'research_brief_build';

function args(argv) {
  const o = { tours: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--commit') o.commit = true;
    else if (a === '--tour') o.tours.push(M.normTour(next()));
    else if (a === '--all') o.tours = ['ATP', 'WTA'];
    else if (a === '--date') o.date = next();
    else if (a === '--database') o.database = next();
    else if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
  }
  if (!o.tours.length) o.tours = ['ATP'];
  return o;
}
const say = (...a) => console.log(...a);
const fail = (...a) => console.error('::error::' + a.join(' '));

/* Is there a VERIFIED schedule? Two conditions, both required: the feature flag
   says a schedule provider is registered, and there are actually upcoming
   matches on file. Either alone is not enough — a flag with no rows would
   produce an empty "matches worth researching" section, which reads as a
   failure rather than as the honest absence it is. */
function scheduleAvailable(db) {
  const flag = db.scalar(`select enabled from tennis.lab_flags where flag_key = 'live_schedule'`);
  if (String(flag) !== 't' && String(flag) !== 'true') return { ok: false, why: 'no schedule provider is registered' };
  if (!db.scalar(`select to_regclass('tennis.live_matches')`)) {
    return { ok: false, why: 'the live contract is not installed' };
  }
  const n = Number(db.scalar(
    `select count(*) from tennis.live_matches where state = 'scheduled' and scheduled_at > now()`) || 0);
  if (!n) return { ok: false, why: 'no upcoming match is on file' };
  return { ok: true, n: n };
}

function gather(db, tour) {
  const out = { tour: tour };
  const q = (sql) => { try { return db.rows(sql); } catch (e) { return []; } };

  out.movers = q(`select player_id, full_name, delta, sample, uncertainty, window_days
                    from tennis.lab_movers(${PG.lit(tour)}, 'up', 30, 6, 15)
                  union all
                  select player_id, full_name, delta, sample, uncertainty, window_days
                    from tennis.lab_movers(${PG.lit(tour)}, 'down', 30, 6, 15)`);

  out.surface_notes = q(`select player_id, full_name, surface, adjustment, surface_sample as sample
                           from tennis.lab_surface_board(${PG.lit(tour)}, 'clay', 'adjustment', 4, 15)
                         union all
                         select player_id, full_name, surface, adjustment, surface_sample
                           from tennis.lab_surface_board(${PG.lit(tour)}, 'grass', 'adjustment', 3, 10)`);

  out.fatigue = q(`select player_id, full_name, workload_class as workload_label,
                          matches_7d, matches_14d, rest_days
                     from tennis.lab_fatigue_board(${PG.lit(tour)}, 'heavy', 4)
                   union all
                   select player_id, full_name, workload_class, matches_7d, matches_14d, rest_days
                     from tennis.lab_fatigue_board(${PG.lit(tour)}, 'elevated', 4)`);

  out.rank_gaps = q(`select player_id, full_name, official_rank, power_rating, gap
                       from tennis.lab_rank_gap(${PG.lit(tour)}, 'underrated', 5, 20)`);

  /* Uncertainty watch: rated players the reader should NOT read confidently.
     A research brief that only surfaces its most confident numbers is
     advertising, not research. */
  out.uncertain = q(`select player_id, full_name, uncertainty, rating_sample, days_since_last_match
                       from tennis.lab_player_row
                      where tour = ${PG.lit(tour)} and power_rating is not null
                        and rating_sample between 5 and 25
                      order by uncertainty desc nulls last, rating_sample asc
                      limit 5`);

  const health = q(`select data_through, model_version, rating_version from tennis.lab_health`)[0] || {};
  out.data_through = health.data_through || null;
  out.model_version = health.model_version || null;
  return out;
}

function render(brief) {
  const lines = [];
  lines.push('');
  lines.push(`  ${brief.tour} — ${brief.tier === 'scheduled' ? 'Research brief' : brief.tier === 'trends' ? 'Trends brief' : 'Record brief'}`);
  lines.push(`  ${'─'.repeat(64)}`);
  if (brief.note) lines.push(`  ${brief.note}`);
  brief.sections.forEach((s) => {
    lines.push('');
    lines.push(`  ${s.title.toUpperCase()}`);
    s.items.forEach((it) => {
      lines.push(`    • ${it.headline}`);
      if (it.detail) lines.push(`      ${it.detail}`);
    });
  });
  lines.push('');
  lines.push(`  data through ${brief.data_through || '—'} · model ${brief.model_version || 'none active'}`
           + ` · ${brief.brief_version}`);
  lines.push('  Research, not picks. No sportsbook price was involved in producing this.');
  return lines.join('\n');
}

async function main() {
  const o = args(process.argv.slice(2));
  if (o.help) { say(fs.readFileSync(__filename, 'utf8').split('*/')[0]); return 0; }
  const conn = PG.resolveConnection();
  if (!conn) { fail('no database connection (SUPABASE_DB_URL / DATABASE_URL / EDGD_PG)'); return 1; }
  const db = PG.client(conn, { database: o.database });
  if (!db.ping()) { fail('the database did not answer'); return 1; }
  if (!db.scalar(`select to_regclass('tennis.research_briefs')`)) {
    fail('tennis.research_briefs is missing — apply supabase/tennis_lab.sql first');
    return 1;
  }

  const date = o.date || new Date().toISOString().slice(0, 10);
  const sched = scheduleAvailable(db);
  say('EdgeDesk Tennis — research brief');
  say(`  date               ${date}`);
  say(`  brief version      ${L.BRIEF_VERSION}`);
  say(`  schedule           ${sched.ok ? sched.n + ' upcoming match(es)' : 'NOT available — ' + sched.why}`);
  say(`  mode               ${o.commit ? 'COMMIT' : 'dry run (nothing is written)'}`);

  let wrote = 0;
  for (const tour of o.tours) {
    const input = gather(db, tour);
    /* The scheduled tier is only entered when a schedule is genuinely
       available. Passing an empty array here is what makes the library fall
       through to trends rather than producing an empty preview. */
    input.scheduled_matches = [];
    if (sched.ok) {
      input.scheduled_matches = db.rows(
        `select match_ref, player_a_name, player_b_name, surface, best_of, level, scheduled_at
           from tennis.board_public
          where tour = ${PG.lit(tour)} and scheduled_at > now()
          order by scheduled_at asc limit 8`);
    }
    const brief = L.buildBrief(input, { now: new Date().toISOString() });

    if (!brief.sections.length) {
      say(`\n  ${tour}: nothing on file to write about yet. Import the archive and run the rating, history and signal builds.`);
      continue;
    }
    if (o.json) say(JSON.stringify(brief, null, 2));
    else say(render(brief));

    if (!o.commit) continue;

    const runId = db.scalar(`insert into tennis.ingestion_runs (job, source_key, status, started_at, details)
      values (${PG.lit(JOB)}, 'edgedesk', 'running', now(),
              jsonb_build_object('tour', ${PG.lit(tour)}, 'tier', ${PG.lit(brief.tier)}))
      returning run_id`);
    const briefId = `brief:${tour}:${date}:${brief.tier}`;
    const headline = brief.sections[0] && brief.sections[0].items[0]
      ? brief.sections[0].items[0].headline : `${tour} research`;
    try {
      db.exec(`insert into tennis.research_briefs
        (brief_id, tour, brief_date, tier, headline, body, sections, data_through,
         model_version, brief_version, lab_version, contains_odds, contains_selections, ingestion_run_id)
        values (${PG.lit(briefId)}, ${PG.lit(tour)}, ${PG.lit(date)}::date, ${PG.lit(brief.tier)},
                ${PG.lit(headline)}, ${PG.lit(JSON.stringify({ note: brief.note || null }))}::jsonb,
                ${PG.lit(JSON.stringify(brief.sections))}::jsonb,
                ${brief.data_through ? PG.lit(brief.data_through) + '::date' : 'null'},
                ${brief.model_version ? PG.lit(brief.model_version) : 'null'},
                ${PG.lit(brief.brief_version)}, ${PG.lit(brief.lab_version)},
                false, false, '${runId}'::uuid)
        on conflict (brief_id) do nothing`);
      db.exec(`update tennis.ingestion_runs set status='ok', finished_at=now(), reconciled=true,
                 rows_inserted=1 where run_id='${runId}'::uuid`);
      wrote++;
      say(`\n  stored as ${briefId}`);
    } catch (e) {
      db.exec(`update tennis.ingestion_runs set status='error', finished_at=now(),
                 error_summary=${PG.lit(String(e.message).slice(0, 900))} where run_id='${runId}'::uuid`);
      fail(`${tour}: ${e.message}`);
      return 1;
    }
  }
  if (o.commit) say(`\n  wrote ${wrote} brief(s).`);
  return 0;
}

if (require.main === module) {
  main().then((c) => process.exit(c)).catch((e) => { fail(e && e.stack || e); process.exit(1); });
}
module.exports = { scheduleAvailable, gather, render };
