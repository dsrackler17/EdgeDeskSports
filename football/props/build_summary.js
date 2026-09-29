#!/usr/bin/env node
/* ============================================================================
   PLAYER PROPS — the per-event summary the Research page reads
   (docs/opportunity/DESIGN.md §5).

   The board (football/props/<league>/board.json) is the whole prop universe:
   1-2 MB, every projection, every quote. Research must not download that to
   decide which games have prop research worth opening, so this build folds
   the board into one small file per league:

     football/props/<league>/summary.json
       events.<game_id>   counts (total, priced, evaluated, research grade,
                          BET / LEAN / WATCH / PASS / NO DECISION), the
                          capture state for THAT game (priced, not released,
                          not captured yet, capture failed, capture off), the
                          game context, and the best ≤4 research candidates
                          with their explanation
       top                the league's best research candidates
       correlation        the same-game correlation model (the Card reads it)

   Every figure is read from the board the build already wrote — the
   compact evaluation of each row (the decision, units and exposure caps the
   build froze) — through lib/edgedesk_opportunity.js, the same code the
   page runs. Nothing is priced twice, and the full board is only fetched
   when a reader opens a game's prop research.

     node football/props/build_summary.js [--league nfl|cfb|all] [--write]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('./config.js');
global.window = global.window || global;
require(path.join(C.ROOT, 'lib', 'research_core.js'));
require(path.join(C.ROOT, 'lib', 'edgedesk_vocab.js'));
require(path.join(C.ROOT, 'lib', 'edgedesk_market.js'));
require(path.join(C.ROOT, 'lib', 'edgedesk_decision.js'));
require(path.join(C.ROOT, 'lib', 'edgedesk_bankroll.js'));
require(path.join(C.ROOT, 'lib', 'research_priority.js'));
require(path.join(C.ROOT, 'lib', 'edgedesk_props.js'));
const OPP = require(path.join(C.ROOT, 'lib', 'edgedesk_opportunity.js'));
const M = require('./model.js');

function readJson(p) { try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; } catch (e) { return null; } }

/* the prop model's own script rule, stamped so a page can state the game
   model's sensitivity without importing the model */
const SCRIPT_RULE = { pass_rate_per_pt: M.PARAMS.script_pass_rate_per_pt, source: 'football/props/model.js PARAMS.script_pass_rate_per_pt',
  text: 'dropback rate falls ' + (100 * M.PARAMS.script_pass_rate_per_pt).toFixed(1) + ' pp per point of expected margin' };

function summarize(board, captureState) {
  return OPP.buildSummary(board, { capture_state: captureState || null, script_rule: SCRIPT_RULE });
}
function summaryPath(league) { return path.join(C.ROOT, 'football', 'props', league, 'summary.json'); }

/* build and (optionally) write one league's summary from the files on disk */
function run(league, opts) {
  opts = opts || {};
  const dir = path.join(C.ROOT, 'football', 'props', league);
  const board = opts.board || readJson(path.join(dir, 'board.json'));
  if (!board || !Array.isArray(board.props)) return { league, status: 'NO_BOARD', why: 'no board.json for ' + league };
  const cap = opts.capture_state !== undefined ? opts.capture_state : readJson(path.join(dir, 'capture_state.json'));
  const S = summarize(board, cap);
  let wrote = null;
  if (opts.write) {
    const file = opts.file || summaryPath(league);
    const body = JSON.stringify(S) + '\n';
    let prev = null; try { prev = fs.readFileSync(file, 'utf8'); } catch (e) { prev = null; }
    wrote = prev === body ? 'unchanged' : 'written';
    if (wrote === 'written') { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); }
  }
  return { league, status: 'OK', summary: S, wrote, bytes: Buffer.byteLength(JSON.stringify(S)) };
}

function main() {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const lg = arg('league', 'all'), write = a.indexOf('--write') >= 0;
  const leagues = lg === 'all' ? ['nfl', 'cfb'] : [lg];
  let code = 0;
  leagues.forEach((L) => {
    const r = run(L, { write });
    if (r.status !== 'OK') { console.log('[props summary] ' + L + ': ' + r.why); return; }
    const c = r.summary.counts, caps = {};
    Object.values(r.summary.events).forEach((e) => { caps[e.capture.state] = (caps[e.capture.state] || 0) + 1; });
    console.log('[props summary] ' + L + ': ' + c.events + ' events · ' + c.priced + ' priced · ' + c.evaluated + ' evaluated · ' + c.research_grade + ' research grade · BET ' + c.BET + ' LEAN ' + c.LEAN + ' WATCH ' + c.WATCH
      + ' · capture ' + JSON.stringify(caps) + ' · ' + Math.round(r.bytes / 1024) + ' KB' + (write ? ' · ' + r.wrote : ' (dry run: pass --write)'));
  });
  return code;
}

module.exports = { run, summarize, summaryPath, SCRIPT_RULE };
if (require.main === module) process.exit(main());
