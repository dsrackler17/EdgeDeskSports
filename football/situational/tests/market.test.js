#!/usr/bin/env node
/* ============================================================================
   FSIE prop markets: consensus lines at a moment, model-vs-market comparisons
   (labelled disagreement, never an edge), flag thresholds, CLV through the
   project's own lib/edgedesk_props.js clv() with a missing close excluded
   (never guessed), outcomes kept apart from CLV, timestamp validity, event
   and player mapping (including provider-name aliases).
   Run: node football/situational/tests/market.test.js
   ========================================================================== */
'use strict';
const H = require('./_harness.js');
const MK = require('../core/market.js');
const MS = require('../core/market_study.js');
const T = H.kit('fsie market');
const chk = T.chk;

const books = {
  dk: { main: [['2026-10-01T10:00:00Z', 33.5, -110, -110], ['2026-10-03T10:00:00Z', 34.5, -115, -105]] },
  fd: { main: [['2026-10-01T12:00:00Z', 33.5, -105, -115]] },
  mgm: { main: [['2026-10-02T09:00:00Z', 34.5, -110, -110]] }
};
const c1 = MK.consensusAt(books, '2026-10-01T12:00:00Z');
chk('consensus at a moment reads each book\'s last line at or before it', c1.line === 33.5 && c1.books === 2 && c1.at === '2026-10-01T12:00:00Z');
chk('the consensus price is the median at the modal line', c1.over === -110 && c1.under === -115);
const c2 = MK.consensusAt(books, null);
chk('the latest consensus moves with the books (modal 34.5)', c2.line === 34.5 && c2.books === 3);
chk('no book before the moment -> no consensus', MK.consensusAt(books, '2026-09-01T00:00:00Z') === null);
chk('first seen and snapshot windows', MK.firstSeen(books) === '2026-10-01T10:00:00Z' && MK.snapshotsAfter(books, '2026-10-01T11:00:00Z', '2026-10-03T00:00:00Z').join() === '2026-10-01T12:00:00Z,2026-10-02T09:00:00Z');

const proj = { mean: 36.1, p10: 27, p50: 36, p90: 45 };
const cmp = MK.compare(proj, c1, { sport: 'nfl', game_id: 'g', player_id: 'p', market: 'pass_att', model_version: 'v', model_as_of: '2026-10-01T09:00:00Z', draws: [30, 34, 35, 36, 38, 40] });
chk('a comparison is a projection disagreement, experimental, with both timestamps', cmp.label === 'projection_disagreement' && cmp.experimental === true && cmp.market_at && cmp.model_as_of && cmp.difference === 2.5);
chk('the over probability is research-only and comes from the draws (5 of 6 draws exceed 33.5)', cmp.p_over_research === 0.8333);
chk('no EV is computed anywhere in a comparison', !('ev' in cmp) && !('edge' in cmp));
chk('flags only at the preregistered thresholds', MK.direction('pass_att', 2.0) === 'over' && MK.direction('pass_att', 1.9) === null && MK.direction('receptions', -0.75) === 'under' && MK.direction('rush_att', 1.4) === null);

const cOver = MK.clvRow('over', { line: 33.5, over: -110, under: -110 }, { line: 34.5, over: -110, under: -110 }, 't1', 't2');
chk('CLV: a line that moved toward the flag is positive line CLV', cOver.available && cOver.line_clv === 1 && cOver.beat_close === true);
const cSame = MK.clvRow('under', { line: 33.5, over: -110, under: -110 }, { line: 33.5, over: -130, under: 110 }, 't1', 't2');
chk('CLV at the same number is priced (cents and no-vig probability)', cSame.available && cSame.price_clv_cents != null && cSame.prob_clv_pp != null && cSame.beat_close === false);
const cMiss = MK.clvRow('over', { line: 33.5, over: -110, under: -110 }, null, 't1', null);
chk('a missing close is excluded with a reason, never guessed', cMiss.available === false && /no pregame close/.test(cMiss.exclusion));
chk('outcomes are separate from CLV', MK.outcome('over', 33.5, 35) === 'WIN' && MK.outcome('under', 33.5, 35) === 'LOSS' && MK.outcome('over', 33, 33) === 'PUSH' && MK.outcome('over', 33.5, null) === null);
const sum = MK.summarize([
  { market: 'pass_att', direction: 'over', clv: cOver, outcome: 'WIN' },
  { market: 'pass_att', direction: 'under', clv: cMiss, outcome: 'VOID' },
  { market: 'pass_att', direction: null }]);
chk('the summary counts comparisons, flags, valid CLV, exclusions by reason and outcomes (incl. VOID)', (() => { const s = sum.pass_att; return s.comparisons === 3 && s.flagged === 2 && s.clv_valid === 1 && s.excluded['no pregame close captured for this prop'] === 1 && s.outcomes.VOID === 1 && s.mean_line_clv === 1; })());

/* timestamp validity: the game line known at entry */
const op = { games: { G: { open: { home_line: -3, total: 44, seen_at: '2026-09-29T10:00:00Z' }, latest: { home_line: -3.5, total: 44.5, seen_at: '2026-10-01T10:00:00Z' } } } };
chk('the opener as seen at entry, not the later line', MS.openerAt(op, 'G', '2026-09-30T00:00:00Z').home_margin === 3 && MS.openerAt(op, 'G', '2026-10-02T00:00:00Z').home_margin === 3.5 && MS.openerAt(op, 'G', '2026-09-28T00:00:00Z') === null);

/* event mapping */
const cfbData = { schedule: [
  { game_id: '1', home_name: 'Massachusetts', away_name: 'Eastern Michigan', kickoff_at: '2026-10-03T19:30:00Z' },
  { game_id: '2', home_name: 'Hawaiʻi', away_name: 'San José State', kickoff_at: '2026-10-04T04:00:00Z' },
  { game_id: '3', home_name: 'Miami', away_name: 'Florida State', kickoff_at: '2026-10-04T23:30:00Z' },
  { game_id: '4', home_name: 'Miami (OH)', away_name: 'Ohio', kickoff_at: '2026-10-04T23:30:00Z' }] };
const map = MS.cfbEventMap(cfbData);
chk('provider aliases map (UMass -> Massachusetts)', (map({ home_team: 'UMass Minutemen', away_team: 'Eastern Michigan Eagles', commence_time: '2026-10-03T19:30:00Z' }) || {}).game_id === '1');
chk('accents and okinas fold (Hawaii / San Jose State)', (map({ home_team: 'Hawaii Rainbow Warriors', away_team: 'San Jose State Spartans', commence_time: '2026-10-04T03:59:00Z' }) || {}).game_id === '2');
chk('the longest schedule name wins (Miami (OH) vs Miami)', (map({ home_team: 'Miami (OH) RedHawks', away_team: 'Ohio Bobcats', commence_time: '2026-10-04T23:30:00Z' }) || {}).game_id === '4' && (map({ home_team: 'Miami Hurricanes', away_team: 'Florida State Seminoles', commence_time: '2026-10-04T23:30:00Z' }) || {}).game_id === '3');
chk('a game on another day does not map', map({ home_team: 'UMass Minutemen', away_team: 'Eastern Michigan Eagles', commence_time: '2026-10-10T19:30:00Z' }) === null);
const pm = MS.playerMap('cfb', { player_games: [{ team: '9', player_id: '77', name: 'Luke Weaver' }] });
chk('player names map within the game\'s teams only', pm('9', 'Luke Weaver') === '77' && pm('8', 'Luke Weaver') === null);

/* the existing EdgeDesk forecast: the props model's last pregame 'final' evaluation, joined by game, player and market */
{
  const os = require('os'); const fs = require('fs'); const path = require('path');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fsie-ev-')), 'evaluations.jsonl');
  const ev = (o) => JSON.stringify(Object.assign({ game_id: 'G', player_id: 'P', market: 'receptions', kickoff: '2026-10-04T17:00:00Z' }, o));
  fs.writeFileSync(f, [
    ev({ kind: 'qualified', median: 9, evaluated_at: '2026-10-04T12:00:00Z' }),
    ev({ kind: 'final', median: 4, evaluated_at: '2026-10-03T12:00:00Z' }),
    ev({ kind: 'final', median: 5, evaluated_at: '2026-10-04T16:00:00Z' }),
    ev({ kind: 'final', median: 11, evaluated_at: '2026-10-04T18:00:00Z' }),
    'not json'].join('\n') + '\n');
  const rows = [{ game_id: 'G', player_id: 'P', market: 'receptions', actual: 6, model_median: 7, market_line: 4.5, model_as_of: '2026-10-01T12:00:00Z' },
    { game_id: 'G', player_id: 'Q', market: 'receptions', actual: 2, model_median: 3, market_line: 2.5, model_as_of: '2026-10-01T12:00:00Z' }];
  const x = MS.existingEdgeDesk('nfl', 2026, rows, f);
  const m = x.markets.receptions;
  chk('existing forecast: the last pregame final evaluation is used (not a qualified row, not one after kickoff), only on shared rows', x.available && m.n === 1 && m.existing_props_model_mae === 1 && m.situational_mae === 1 && m.entry_line_mae === 1.5 && m.props_evaluated_hours_after_situational_inputs_median === 76);
  chk('existing forecast: a missing evaluations file is reported, not invented', MS.existingEdgeDesk('nfl', 2026, rows, f + '.missing').available === false);
}

process.exit(T.done());
