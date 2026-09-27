#!/usr/bin/env node
/* ===========================================================================
   A full historical week, schedule to settlement, twice (brief §104;
   football/cfb_production/replay_week.js). Deterministic and offline:
   2026 week 3 from the preserved pregame rows, the captured quotes and the
   committed results, through the hourly job's own code in a throwaway ledger.

   Run: node football/cfb_production/replay.test.js
   =========================================================================== */
'use strict';
const RW = require('./replay_week.js');
let pass = 0, fail = 0; const fails = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; fails.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); } }
(async () => {
  const a = await RW.replay(2026, [3]), b = await RW.replay(2026, [3]);
  chk('replay: every game of the week passes the team identity master, no duplicate pair', a.games > 50 && a.schedule.validated === a.games && a.schedule.duplicate_pairs === 0, a.schedule);
  chk('replay: every preserved row is PREDICTED or NOT_PRICED through the canonical service', (a.projection.PREDICTED || 0) + (a.projection.NOT_PRICED || 0) === a.games, a.projection);
  /* OPEN is taken only when a game is first seen more than 72 h out; T72..FINAL always */
  chk('replay: the hourly job took every window at most once for every priced game, nothing after kickoff', a.snapshots.duplicate_windows === 0 && a.snapshots.after_kickoff === 0
    && ['T72', 'T48', 'T24', 'T12', 'T6', 'T2', 'FINAL'].every((k) => a.snapshots.by_checkpoint[k] === a.snapshots.games_snapshotted)
    && (a.snapshots.by_checkpoint.OPEN || 0) <= a.snapshots.games_snapshotted && a.snapshots.games_snapshotted === a.projection.PREDICTED, a.snapshots);
  chk('replay: no BET anywhere (betting disabled)', a.snapshots.bets === 0);
  chk('replay: every snapshot is graded once against its FINAL; a second settlement adds nothing', a.settlement.evaluations === a.snapshots.rows && a.settlement.second_run_added === 0 && a.settlement.never_final_graded === 0, a.settlement);
  chk('replay: the throwaway ledger verifies (ids, hashes, one row per window)', a.ledger_verify.length === 0, a.ledger_verify.slice(0, 3));
  chk('replay: deterministic — two runs write byte-identical ledgers', a.ledger_sha256 === b.ledger_sha256 && JSON.stringify(a.settlement) === JSON.stringify(b.settlement));
  fails.forEach((f) => console.log('FAIL | ' + f));
  console.log((fail ? 'FAILED ' : 'ALL GREEN ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
