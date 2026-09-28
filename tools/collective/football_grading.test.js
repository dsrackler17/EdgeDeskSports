#!/usr/bin/env node
/* ===========================================================================
   football-v2 — the one grader, tested case by case.

   Every case the audit asked for: the six cover cases, the two pick-direction
   cases, pick'em, the half points, big favourites, underdogs, neutral sites,
   kickoff moves, post-lock edits, missing close / probability / fair spread,
   postponed, cancelled, overtime, and the close selector's "6:57 is the
   close, not a snapshot at exactly 7:00" rule. The vector tables are shared
   with the SQL parity suite (football_grading_sql.test.js).

   Run: node tools/collective/football_grading.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const G = require(path.join(__dirname, '..', '..', 'lib', 'football_grading.js'));
const V = require('./fixtures/football_v2_vectors.js');

let pass = 0, fail = 0;
const fails = [];
function chk(name, cond, detail) {
  if (cond) pass++;
  else { fail++; fails.push({ name, detail }); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---- the cover ---------------------------------------------------------- */
V.COVER.forEach(([label, hs, as, close, cover, m]) => {
  const r = G.atsCover(hs, as, close);
  chk('cover: ' + label, r && r.cover === cover && r.ats_margin_home === m && r.actual_margin === hs - as, r);
});
chk('cover: a missing close is null, never a default', G.atsCover(24, 14, null) === null);
chk('cover: a missing score is null', G.atsCover(null, 14, -7) === null);
chk('cover: a string close is read as its number', G.atsCover(24, 14, '-7').cover === 'home');

/* ---- the side ----------------------------------------------------------- */
V.SIDE.forEach(([label, ex, fair, close, side, source, edge]) => {
  const d = G.deriveSide(ex, fair, close);
  chk('side: ' + label, d.side === side && d.source === source && d.edge_home === edge, d);
});
V.RESULT.forEach(([label, side, cover, res]) => {
  chk('result: ' + label, G.gradeSide(side, cover) === res);
});

/* ---- neutral site: the stored orientation is the orientation ---------------
   A neutral-site game still has a designated home team in the Collective's
   schedule, and the close, the scores and the model's side are all stated
   against that designation. Swapping the designation must flip every number
   together and leave the same TEAM with the same result. */
(() => {
  const a = G.atsCover(31, 28, -3.5);                /* A designated home, A -3.5 */
  const b = G.atsCover(28, 31, 3.5);                 /* B designated home, B +3.5 */
  const ra = G.gradeSide('home', a.cover);           /* the model is on A */
  const rb = G.gradeSide('away', b.cover);           /* the same model, the same team */
  chk('neutral site: swapping the designated home flips every number and not the result',
    ra === rb && ra === 'loss', { a, b, ra, rb });
  const da = G.deriveSide(null, -6, -3.5), db = G.deriveSide(null, 6, 3.5);
  chk('neutral site: the derived side follows the team, not the label',
    da.side === 'home' && db.side === 'away', { da, db });
})();

/* ---- end to end, one model on one game ----------------------------------- */
V.MODEL_GAME.forEach(c => {
  const game = Object.assign({ game_id: 'g1', sport: 'NFL', season: 2026, kickoff_at: V.KICK }, c.game);
  const close = c.close === null ? null : { home_spread: c.close, source: 'collective_odds', book: 'consensus',
    observed_at: '2026-09-13T18:57:00Z', snapshot_id: 's1' };
  const t = G.gradeModelGame({ game, close, versions: JSON.parse(JSON.stringify(c.versions)), model_id: 'm1' });
  const bad = Object.keys(c.expect).filter(k => !eq(t[k], c.expect[k]));
  chk('grade: ' + c.label, !bad.length, bad.map(k => `${k}: got ${JSON.stringify(t[k])} want ${JSON.stringify(c.expect[k])}`));
  chk('grade: ' + c.label + ' — carries the grading version', t.grading_version === 'football-v2');
});

/* ---- the lock and kickoff moves ------------------------------------------ */
(() => {
  const at = '2026-09-13T18:45:00Z';
  const orig = G.selectPrediction([{ id: 'p', received_at: at }], '2026-09-13T19:00:00Z');
  const later = G.selectPrediction([{ id: 'p', received_at: at }], '2026-09-13T20:00:00Z');
  const earlier = G.selectPrediction([{ id: 'p', received_at: '2026-09-13T18:10:00Z' }], '2026-09-13T18:30:00Z');
  chk('kickoff moved later: a submission inside the OLD lock is valid under the new one',
    orig.status === 'LATE_SUBMISSION' && later.status === 'OK', { orig, later });
  chk('kickoff moved earlier: a submission that WAS early is late against the real kickoff',
    earlier.status === 'LATE_SUBMISSION', earlier);
  const lk = G.lockAt('2026-09-13T19:00:00Z');
  chk('lock is 30 minutes before kickoff by default', new Date(lk).toISOString() === '2026-09-13T18:30:00.000Z');
  chk('lock minutes are configurable', new Date(G.lockAt('2026-09-13T19:00:00Z', 60)).toISOString() === '2026-09-13T18:00:00.000Z');
  const s = G.selectPrediction([], V.KICK);
  chk('no versions at all: NO_PREDICTION', s.status === 'NO_PREDICTION');
  const tie = G.selectPrediction([{ id: 'b', received_at: '2026-09-13T12:00:00Z', projected_spread: -2 },
    { id: 'a', received_at: '2026-09-13T12:00:00Z', projected_spread: -9 }], V.KICK);
  chk('two versions at the same instant: the id breaks the tie deterministically',
    tie.chosen.id === 'b' && tie.version === 2, tie.chosen);
  const q = G.selectPrediction([{ id: 'q', received_at: '2026-09-13T12:00:00Z', resolution_status: 'quarantined' }], V.KICK);
  chk('an unresolved (quarantined) row is excluded by origin', q.status === 'EXCLUDED_ORIGIN');
})();

/* ---- the close ------------------------------------------------------------ */
const K = '2026-09-13T19:00:00Z';
function snap(id, at, line, extra) {
  return Object.assign({ snapshot_id: id, source: 'collective_odds', source_event_id: 'ev1', book: 'consensus',
    market_type: 'spread', home_line: line, observed_at: at }, extra || {});
}
(() => {
  const s = [snap('a', '2026-09-13T18:40:00Z', -6.5), snap('b', '2026-09-13T18:50:00Z', -7),
    snap('c', '2026-09-13T18:57:00Z', -7.5), snap('d', '2026-09-13T19:05:00Z', -10)];
  const r = G.selectClose(s, { kickoffAt: K });
  chk('close: 6:40, 6:50, 6:57 -> 6:57 is the close; nothing at exactly 7:00 is required',
    r.close && r.close.snapshot_id === 'c' && r.close.home_spread === -7.5 && r.close.away_spread === 7.5, r);
  chk('close: the in-game 7:05 price is rejected as after kickoff', r.rejected.AFTER_KICKOFF === 1);
  chk('close: lead time is recorded', r.close.lead_minutes === 3);
  chk('close: provenance is preserved (book, source, event id, observed_at, kickoff)',
    r.close.book === 'consensus' && r.close.source === 'collective_odds' && r.close.source_event_id === 'ev1' &&
    r.close.observed_at === '2026-09-13T18:57:00.000Z' && r.close.kickoff_at === '2026-09-13T19:00:00.000Z');
  const shuffled = G.selectClose([s[3], s[1], s[2], s[0]], { kickoffAt: K });
  chk('close: input order does not change the answer', shuffled.close.snapshot_id === 'c');
  const exactly = G.selectClose([snap('k', '2026-09-13T19:00:00Z', -7)], { kickoffAt: K });
  chk('close: a snapshot AT kickoff is not pregame', !exactly.close && exactly.status === 'ONLY_AFTER_KICKOFF');
  const only = G.selectClose([snap('x', '2026-09-13T20:00:00Z', -3)], { kickoffAt: K });
  chk('close: only in-game snapshots -> ONLY_AFTER_KICKOFF, no close', !only.close && only.status === 'ONLY_AFTER_KICKOFF');
  const stale = G.selectClose([snap('s', '2026-09-13T11:00:00Z', -3)], { kickoffAt: K });
  chk('close: a snapshot older than the window is not a close', !stale.close && stale.status === 'ONLY_STALE');
  const wide = G.selectClose([snap('s', '2026-09-13T11:00:00Z', -3)], { kickoffAt: K, windowMinutes: 600 });
  chk('close: the window is configurable', wide.close && wide.close.home_spread === -3);
  const books = G.selectClose([snap('f', '2026-09-13T18:55:00Z', -7, { book: 'fanduel' }),
    snap('d', '2026-09-13T18:55:00Z', -6.5, { book: 'draftkings' })], { kickoffAt: K });
  chk('close: one capture pass, several books -> book priority decides', books.close.book === 'draftkings');
  // EdgeDesk capture stamps every point a pass saw with the pass's instant:
  // at the final pregame instant the line the most books quoted is the close,
  // whatever the snapshot ids happen to sort as.
  const cap = (id, at, line, n) => snap(id, at, line, { source: 'edgedesk_capture', book: 'edgedesk', raw: { n_books: n } });
  const breadth = G.selectClose([cap('a-minority', '2026-09-13T18:50:00Z', -6.5, 1),
    cap('z-majority', '2026-09-13T18:50:00Z', -7, 6)], { kickoffAt: K });
  chk('close: one capture pass, several points -> the point the most books quoted', breadth.close.snapshot_id === 'z-majority' &&
    breadth.close.home_spread === -7, breadth.close);
  const later = G.selectClose([cap('m', '2026-09-13T18:40:00Z', -7, 9), cap('n', '2026-09-13T18:50:00Z', -6.5, 1)], { kickoffAt: K });
  chk('close: breadth never outranks a later observation', later.close.snapshot_id === 'n');
  const flat = G.selectClose([snap('b1', '2026-09-13T18:50:00Z', -7, { n_books: 4 }), snap('a1', '2026-09-13T18:50:00Z', -6.5)], { kickoffAt: K });
  chk('close: n_books is read off the snapshot itself too; a row without it counts 0', flat.close.snapshot_id === 'b1');
  const prio = G.selectClose([snap('e', '2026-09-13T18:58:00Z', -6, { source: 'edgedesk_capture' }),
    snap('o', '2026-09-13T17:00:00Z', -7)], { kickoffAt: K });
  chk("close: the Collective's own feed outranks a fresher first-party capture", prio.close.source === 'collective_odds' && prio.close.home_spread === -7);
  const fall = G.selectClose([snap('e', '2026-09-13T18:58:00Z', -6, { source: 'edgedesk_capture' })], { kickoffAt: K });
  chk('close: a lower-priority source is used when the feed has nothing', fall.close.source === 'edgedesk_capture');
  const legacy = { snapshot_id: 'L', source: 'legacy_results_close', market_type: 'spread', home_line: -7, observed_at: null };
  const untimedOnly = G.selectClose([legacy], { kickoffAt: K });
  chk('close: an untimed published close is used when nothing timed exists', untimedOnly.close.home_spread === -7 && untimedOnly.close.timed === false);
  const timedWins = G.selectClose([legacy, snap('t', '2026-09-13T18:50:00Z', -7.5)], { kickoffAt: K });
  chk('close: a timed pregame snapshot outranks an untimed close', timedWins.close.snapshot_id === 't');
  const flipped = G.selectClose([legacy, snap('t', '2026-09-13T18:50:00Z', 7)], { kickoffAt: K, legacyClose: -7 });
  chk('close: a snapshot that is the exact negative of the published close is an orientation error',
    flipped.close.source === 'legacy_results_close' && flipped.rejected.ORIENTATION_CONFLICT === 1, flipped);
  const away = G.selectClose([snap('w', '2026-09-13T18:50:00Z', null, { away_line: 3 })], { kickoffAt: K });
  chk('close: an away line alone gives the home line by negation', away.close.home_spread === -3);
  const off = G.selectClose([snap('z', '2026-09-13T18:50:00Z', -3, { source: 'cfb_lab_provider_close' })], { kickoffAt: K });
  chk('close: a source that is not configured is never read', !off.close && off.status === 'SOURCE_DISABLED');
  const none = G.selectClose([], { kickoffAt: K });
  chk('close: no snapshots -> NO_SNAPSHOT, never invented', !none.close && none.status === 'NO_SNAPSHOT');
  const tot = G.selectClose([snap('t', '2026-09-13T18:50:00Z', 44.5, { market_type: 'totals' })], { kickoffAt: K });
  chk('close: a totals row is never a spread close', !tot.close && tot.status === 'NO_SPREAD_MARKET');
})();

/* ---- one close per game, the same for every model ------------------------- */
(() => {
  const game = { game_id: 'g', kickoff_at: V.KICK, home_score: 27, away_score: 20, status: 'final' };
  const close = G.selectClose([snap('c', '2026-09-13T18:57:00Z', -6.5)], { kickoffAt: V.KICK }).close;
  const models = [
    { model_id: 'A', versions: [{ id: 'a1', received_at: '2026-09-13T10:00:00Z', pick_side: 'home', projected_spread: -9 }] },
    { model_id: 'B', versions: [{ id: 'b1', received_at: '2026-09-13T11:00:00Z', projected_spread: -4 }] },
    { model_id: 'C', versions: [{ id: 'c1', received_at: '2026-09-13T12:00:00Z', projected_spread: -8 }] },
  ];
  const traces = models.map(m => G.gradeModelGame({ game, close, versions: m.versions, model_id: m.model_id }));
  chk('every model on a game is graded against the SAME close row',
    traces.every(t => t.close_snapshot_id === 'c' && t.close_home_spread === -6.5));
  chk('A (explicit home) wins, B (derived away) loses, C (derived home) wins',
    traces[0].ats_result === 'win' && traces[1].ats_result === 'loss' && traces[2].ats_result === 'win',
    traces.map(t => [t.ats_side, t.ats_result]));
  const c = G.consensusGame(traces);
  chk('consensus: majority of eligible sides (2 home, 1 away) -> home, graded on the same close',
    c.side === 'home' && c.n_eligible === 3 && c.ats_result === 'win', c);
  const split = G.consensusGame(traces.slice(0, 2));
  chk('consensus: a dead-even split is no consensus', split.ats_exclusion === 'EVEN_SPLIT' && split.ats_result === null);
  const one = G.consensusGame(traces.slice(0, 1));
  chk('consensus: fewer than two eligible models is no consensus', one.ats_exclusion === 'FEWER_THAN_2');
})();

/* ---- the record, reasons named -------------------------------------------- */
(() => {
  const mk = (res, excl, extra) => Object.assign({ ats_result: res, ats_exclusion: excl, game_state: 'FINAL',
    prediction_status: 'OK', margin_error: 3, brier: 0.1, ats_side_source: res ? 'derived' : null }, extra || {});
  const ts = [mk('win'), mk('win'), mk('loss'), mk('push'), mk(null, 'MISSING_CLOSE'), mk(null, 'MISSING_CLOSE'),
    mk(null, 'NO_ATS_SIDE'), mk(null, 'LATE_SUBMISSION', { prediction_status: 'LATE_SUBMISSION', margin_error: null,
      mae_exclusion: 'LATE_SUBMISSION', brier: null, brier_exclusion: 'LATE_SUBMISSION' })];
  const a = G.aggregateModel(ts);
  chk('record: 2-1-1, n=4, ATS% excludes the push',
    a.wins === 2 && a.losses === 1 && a.pushes === 1 && a.ats_n === 4 && Math.abs(a.ats_pct - 2 / 3) < 1e-6, a);
  chk('record: ungraded rows are named, never losses',
    a.ats_excluded.MISSING_CLOSE === 2 && a.ats_excluded.NO_ATS_SIDE === 1 && a.ats_excluded.LATE_SUBMISSION === 1);
  chk('record: MAE and Brier have their own n', a.mae_n === 7 && a.brier_n === 7 && a.mae === 3);
  chk('record: late submissions are counted', a.late === 1);
})();

/* ---- calibration ------------------------------------------------------------ */
(() => {
  const ts = [
    { brier: 0.09, home_win_prob: 0.7, outcome: 1 }, { brier: 0.49, home_win_prob: 0.3, outcome: 1 },
    { brier: 0.04, home_win_prob: 0.2, outcome: 0 }, { brier: null, home_win_prob: 0.9, outcome: 1 },
  ];
  const c = G.calibration(ts);
  chk('calibration: n equals the Brier-eligible rows only', c.n === 3);
  const b = c.buckets.find(x => x.lo === 0.7);
  chk('calibration: a 30% home probability is a 70% away claim, folded onto the favourite',
    b.n === 2 && b.actual === 0.5 && Math.abs(b.claimed - 0.7) < 1e-9, c.buckets);
  const b2 = c.buckets.find(x => x.lo === 0.8);
  chk('calibration: 20% home that lost is an 80% away claim that won', b2.n === 1 && b2.actual === 1);
})();

/* ---- diagnostics ------------------------------------------------------------- */
(() => {
  const games = [1, 2, 3, 4].map(i => ({ game_id: 'g' + i, kickoff_at: '2026-09-13T19:00:00Z', home_score: 20, away_score: 10, status: 'final' }));
  const trace = (gid, withClose, graded) => ({ game_id: gid, game_state: 'FINAL', prediction_status: 'OK',
    close_home_spread: withClose ? -3 : null, ats_side: withClose ? 'home' : null, ats_result: graded ? 'win' : null,
    margin_error: 2, ats_exclusion: withClose ? (graded ? null : null) : 'MISSING_CLOSE' });
  const d = G.diagnose({ now: '2026-09-20T00:00:00Z', games,
    closes: { g1: {}, g2: {} }, traces: [trace('g1', true, true), trace('g2', true, false), trace('g3', false), trace('g4', false)],
    identity: { market_events: 100, market_events_matched: 97, duplicate_games: 1, orphan_snapshots: 3 } });
  const codes = d.warnings.map(w => w.level + ':' + w.code);
  chk('diagnostics: 50% capture is a HIGH warning', codes.indexOf('HIGH:MARKET_CAPTURE_LOW') >= 0, codes);
  chk('diagnostics: 97% canonical match is a HIGH warning', codes.indexOf('HIGH:CANONICAL_MATCH_LOW') >= 0);
  chk('diagnostics: a gradable model-game with no grade is an ERROR', codes.indexOf('ERROR:GRADABLE_NOT_GRADED') >= 0);
  chk('diagnostics: MAE graded while ATS is missing despite a close is an ERROR', codes.indexOf('ERROR:MAE_WITHOUT_ATS') >= 0);
  chk('diagnostics: duplicates and orphans are reported', codes.indexOf('HIGH:DUPLICATE_EVENTS') >= 0 && codes.indexOf('WARN:ORPHAN_SNAPSHOTS') >= 0);
  chk('diagnostics: the metrics are stated', d.metrics.market_capture_pct === 50 && d.metrics.ats_gradable === 2 && d.metrics.ats_graded === 1);
  chk('diagnostics: not ok', d.ok === false);
  const clean = G.diagnose({ now: '2026-09-20T00:00:00Z', games: games.slice(0, 1), closes: { g1: {} },
    traces: [trace('g1', true, true)], identity: { market_events: 10, market_events_matched: 10 } });
  chk('diagnostics: a clean slate is ok with no warnings', clean.ok && !clean.warnings.length, clean);
})();

if (fail) {
  fails.forEach(f => console.log('FAIL | ' + f.name + (f.detail ? '  ' + JSON.stringify(f.detail) : '')));
  console.log(`FAILED ${pass} passed, ${fail} failed`);
  process.exit(1);
}
console.log(`ALL GREEN ${pass} passed, 0 failed`);
