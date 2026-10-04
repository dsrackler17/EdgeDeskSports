#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk Tennis — settle the public record.

   A published prediction is frozen at publication time. This writes the RESULT
   beside it once the match is final: who won, whether the claim was right, the
   Brier and log-loss contribution, and the closing-line value where a closing
   price exists. It never edits the claim, and the database refuses to let it —
   tennis.freeze_published_record() raises on any attempt to change a
   probability, a price or a model version, and on any attempt to re-settle a
   row that is already settled.

   WHERE THE RESULT COMES FROM. The live pipeline (tools/tennis/live_poll.js)
   marks a match final and names the winner; that is the LiveResultsProvider
   contract, read here through the adapter so a future licensed feed settles the
   record without touching this file.

   WHAT IT WILL NOT DO. It will not settle from a score it had to parse out of a
   string when the pipeline already resolved a winner id. It will not settle a
   match the provider marked final without a winner (a retirement before the
   provider recorded one is common) — that stays open and is counted. It will
   not compute ROI: a record without the price actually available and the sample
   it came from is a number that flatters whoever publishes it.

   Usage:
     node tools/tennis/settle_record.js                # report only
     node tools/tennis/settle_record.js --commit
   =========================================================================== */
'use strict';
const fs = require('fs');
const PG = require('./lib/pg.js');
const M = require('../../lib/tennis_model.js');
const LIVE = require('./providers/espn_results.js');

const JOB = 'record_settle';

function args(argv) {
  const o = { commit: false, days: 14 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--commit') o.commit = true;
    else if (a === '--days') o.days = Math.max(1, Number(next()) || 14);
    else if (a === '--database') o.database = next();
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}
const say = (...a) => console.log(...a);
const fail = (...a) => console.error('::error::' + a.join(' '));

async function main() {
  const o = args(process.argv.slice(2));
  if (o.help) { say(fs.readFileSync(__filename, 'utf8').split('*/')[0]); return 0; }
  const conn = PG.resolveConnection();
  if (!conn) { fail('no database connection'); return 1; }
  const db = PG.client(conn, { database: o.database });
  if (!db.ping()) { fail('the database did not answer'); return 1; }

  const open = db.rows(`
    select r.record_id, r.match_ref, r.player_a_id, r.player_b_id, r.prob_a,
           r.market_odds_a_decimal, r.market_prob_a,
           lm.winner_player_id, lm.winner_side, lm.home_player_id, lm.away_player_id,
           lm.status, lm.completed_at, lm.result_type,
           (select c.sharp_fair from tennis.market_captures c
             where c.match_id = r.match_ref and c.side = (case when lm.home_player_id = r.player_a_id then 'home' else 'away' end)
               and c.market_state = 'PRE'
             order by c.capture_at desc limit 1) as closing_fair_a
      from tennis.prediction_record r
      join tennis.live_matches lm on lm.match_id = r.match_ref
     where r.settled_at is null
       and lm.status in ('final','walkover')
       and lm.completed_at >= now() - interval '${o.days} days'
     limit 2000`);

  say(`unsettled published claims with a final result   ${open.length}`);
  const ready = [], noWinner = [];
  open.forEach((r) => {
    const winner = r.winner_player_id ||
      (r.winner_side === 'home' ? r.home_player_id : r.winner_side === 'away' ? r.away_player_id : null);
    if (!winner) { noWinner.push(r); return; }
    if (winner !== r.player_a_id && winner !== r.player_b_id) { noWinner.push(r); return; }
    const outcomeA = winner === r.player_a_id;
    const p = Number(r.prob_a);
    const y = outcomeA ? 1 : 0;
    const brier = M.round((p - y) * (p - y), 6);
    const ll = M.round(-(y * Math.log(Math.max(p, 1e-9)) + (1 - y) * Math.log(Math.max(1 - p, 1e-9))), 6);
    /* CLOSING-LINE VALUE, only where a closing reference actually exists. It
       compares the price EdgeDesk recorded at publication with the market's own
       last fair price, in probability terms. Where no close was captured it is
       NULL and the published record says how often that happens rather than
       quietly averaging over the rows that had one. */
    const closeFair = M.num(r.closing_fair_a);
    const closingProbA = closeFair == null ? null : M.probFromDecimal(closeFair);
    const publishedProbA = M.num(r.market_prob_a);
    const clv = (closingProbA != null && publishedProbA != null)
      ? M.round(closingProbA - publishedProbA, 5) : null;
    ready.push({ record_id: r.record_id, winner, outcomeA, brier, ll, clv,
                 closingProbA, closeFair, beatClose: clv == null ? null : clv > 0,
                 settled_at: r.completed_at, result_type: r.result_type });
  });

  say(`  settleable                                    ${ready.length}`);
  say(`  final but no resolved winner (left open)      ${noWinner.length}`);
  const withClv = ready.filter((r) => r.clv != null).length;
  say(`  with a closing reference                      ${withClv} of ${ready.length}`);

  if (!o.commit) {
    say('\nDRY RUN — nothing written.');
    ready.slice(0, 5).forEach((r) => say(`  ${r.record_id.slice(0, 8)} won=${r.outcomeA} brier=${r.brier} clv=${r.clv == null ? '—' : r.clv}`));
    return 0;
  }
  if (!ready.length) { say('\nnothing to settle.'); return 0; }

  const runId = db.scalar(`insert into tennis.ingestion_runs (job, source_key, build_version, scope, status)
    values (${PG.lit(JOB)}, 'edgedesk', ${PG.lit(M.VERSION)}, ${PG.lit(o.days + 'd')}, 'running') returning run_id`);
  try {
    /* One statement per row on purpose: the immutability trigger raises with a
       message naming the row, and a batch would hide which one. */
    db.transaction(ready.map((r) => `update tennis.prediction_record set
        settled_at = ${PG.lit(r.settled_at)}, winner_id = ${PG.lit(r.winner)},
        outcome_a = ${r.outcomeA}, brier = ${r.brier}, log_loss = ${r.ll},
        clv = ${r.clv == null ? 'null' : r.clv},
        beat_close = ${r.beatClose == null ? 'null' : r.beatClose},
        closing_prob_a = ${r.closingProbA == null ? 'null' : r.closingProbA},
        closing_odds_a_decimal = ${r.closeFair == null ? 'null' : r.closeFair},
        settle_source = 'espn'
      where record_id = '${r.record_id}'::uuid and settled_at is null;`));
    db.exec(`update tennis.research_opportunities set status='settled', updated_at=now()
              where status='open' and match_ref in (${open.map((r) => PG.lit(r.match_ref)).join(',')})`);
    db.exec(`update tennis.ingestion_runs set status='ok', finished_at=now(), reconciled=true,
               rows_read=${open.length}, rows_updated=${ready.length},
               details=${PG.lit(JSON.stringify({ settled: ready.length, no_winner: noWinner.length, with_clv: withClv }))}::jsonb
             where run_id='${runId}'::uuid`);
  } catch (e) {
    db.exec(`update tennis.ingestion_runs set status='error', finished_at=now(),
               error_summary=${PG.lit(String(e.message).slice(0, 900))} where run_id='${runId}'::uuid`);
    fail(e.message); return 1;
  }

  const summary = db.rows(`select model_version, tour, surface, predictions, settled, brier, log_loss,
                                  clv_sample, mean_clv, small_sample
                             from tennis.public_record_summary where settled > 0 order by settled desc limit 8`);
  say(`\n  settled  ${ready.length}`);
  if (summary.length) {
    say('\n  the published record so far:');
    summary.forEach((s) => say(`    ${String(s.tour || '—').padEnd(5)} ${String(s.surface || '—').padEnd(7)} ` +
      `n=${String(s.settled).padStart(5)}  Brier ${s.brier == null ? '—' : Number(s.brier).toFixed(4)}  ` +
      `log loss ${s.log_loss == null ? '—' : Number(s.log_loss).toFixed(4)}  ` +
      `CLV ${s.clv_sample ? Number(s.mean_clv).toFixed(4) + ' over ' + s.clv_sample : 'no closing reference'}` +
      `${s.small_sample ? '   (small sample — under 100 settled)' : ''}`));
  }
  say('\n  No ROI is published. A return figure without the price that was actually');
  say('  available and the sample it came from is not a measurement.');
  return 0;
}
if (require.main === module) main().then((c) => process.exit(c)).catch((e) => { fail(String(e && e.stack || e)); process.exit(1); });
