#!/usr/bin/env node
/* ============================================================================
   THE GOVERNANCE CHAMPION'S TABLE (football/cfb_production/champion.js) and
   its reader (lib/cfb_champion.js): what the board and the slate build price
   from once a person promotes a model other than V1.

     1 V1 champion        an empty table: nothing anywhere changes
     2 a loop champion    every pregame card of the EXACT promoted version, with
                          its margin, win probability, interval and distribution
     3 exact version      a loop serving another version prices nothing
     4 freshness          an entry is offered only pregame and while fresh
     5 one distribution   the reader's cover is the loop's own (the Lab port),
                          in the engine's convention (win + push + lose = 1)
     6 the guard          a loop version passes the promotion guard only with
                          live evidence on the config it serves and ELIGIBLE

   Run: node football/cfb_production/champion.test.js
   ========================================================================== */
'use strict';
const path = require('path');
const REPO = path.join(__dirname, '..', '..');
const CHB = require('./champion.js');
const CH = require(path.join(REPO, 'lib', 'cfb_champion.js'));
const GOV = require(path.join(REPO, 'football', 'cfb_lab', 'governance.js'));
const PG = require('./promotion.js');

let pass = 0, fail = 0;
function chk(name, ok, detail) { if (ok) pass++; else { fail++; console.log('FAIL | ' + name + (detail !== undefined ? ' | ' + JSON.stringify(detail).slice(0, 300) : '')); } }

const NOW = '2026-10-21T10:00:00.000Z', H = 3600000, at = (h) => new Date(Date.parse(NOW) + h * H).toISOString();
const dist = { sigma: 16.5, mult: [0.001, 0.98, 0.79, 2.79, 1.01, 0.77, 0.96, 2.53, 0.8, 0.37, 1.43], kmax: 100 };
const card = (id, kick, margin, p) => ({ game_id: id, week: 9, home: 'H' + id, away: 'A' + id, home_id: 1, away_id: 2, neutral_site: false, kickoff_utc: kick,
  fair_home_margin: margin, fair_total: 50, home_win_prob: p, components: [{ key: 'home_field', label: 'Home field', points: 2.6 }, { key: 'qb', label: 'Quarterback', points: margin - 2.6 }] });
const loop = (ver) => ({ schema: 'edgedesk_model_loop_cfb_current_v1', model_version: ver, generated_at: at(-2), season: 2026, config_sha256: 'cfg0123456789abcdef', distribution: dist,
  games: [card('g1', at(30), 7.4, 0.66), card('g2', at(54), -3.1, 0.43), card('played', at(-5), 11, 0.75)] });
const role = (mv, r, t) => GOV.roleEvent(mv, mv, r, 'test', 'test', t || '2026-09-27T12:00:00.000Z');
const V1 = 'edgedesk_cfb_p4_v1.0.0', LOOP = 'edgedesk_cfb_loop_v2.0.0';

/* 1 */
const t1 = CHB.build({ roles: [role(V1, 'champion')], now: NOW });
chk('V1 champion: an empty table, so nothing anywhere changes', t1.schema === CH.SCHEMA && t1.champion === V1 && t1.kind === 'V1' && Object.keys(t1.games).length === 0);
const none = CHB.build({ roles: [], now: NOW });
chk('no single champion: an empty table', none.champion === null && Object.keys(none.games).length === 0);

/* 2 */
const promoted = [role(V1, 'champion'), role(LOOP, 'challenger'), role(LOOP, 'champion', '2026-10-21T09:00:00.000Z'), role(V1, 'challenger', '2026-10-21T09:00:00.000Z')];
const t2 = CHB.build({ roles: promoted, now: NOW, loopCurrent: loop('2.0.0') });
const e1 = t2.games.g1;
chk('a loop champion: its pregame cards, the post-kickoff card refused', t2.kind === 'LOOP' && Object.keys(t2.games).sort().join() === 'g1,g2' && !t2.games.played);
chk('an entry carries the champion\'s own numbers and distribution',
  e1.model_version === LOOP && e1.margin === 7.4 && e1.p_home === 0.66 && e1.total === 50 && e1.distribution.kind === 'key_number' && e1.distribution.sigma === 16.5
    && Array.isArray(e1.intervals[80]) && e1.intervals[80][0] < 7.4 && e1.intervals[80][1] > 7.4 && e1.as_of === at(-2) && e1.components.length === 2, e1);

/* 3 */
const t3 = CHB.build({ roles: promoted, now: NOW, loopCurrent: loop('2.1.0') });
chk('a loop serving another version than the promoted one prices nothing (V1 everywhere) and says why',
  Object.keys(t3.games).length === 0 && /serves edgedesk_cfb_loop_v2\.1\.0/.test(t3.note), t3.note);

/* 4 */
CH.load(t2);
const now = Date.parse(NOW);
chk('the reader offers a fresh pregame entry', CH.entryFor('g1', now) && CH.entryFor('g1', now).margin === 7.4);
chk('… never a stale one, a future-dated one, an unlisted game or a malformed table',
  CH.entryFor('g1', now + 40 * H) === null && CH.entryFor('g1', Date.parse(at(-3))) === null && CH.entryFor('zz', now) === null
    && (CH.load({ schema: 'other', games: { g1: e1 } }), CH.entryFor('g1', now) === null));
CH.load({ schema: CH.SCHEMA, games: { g1: Object.assign({}, e1, { as_of: at(-1), kickoff: at(-2) }), g2: Object.assign({}, e1, { as_of: at(-2), kickoff: at(-1) }) } });
chk('… nor a number computed at or after its kickoff; a pregame number stays the game\'s number once it kicks off',
  CH.entryFor('g1', now) === null && CH.entryFor('g2', now) && CH.entryFor('g2', now).margin === 7.4);
CH.load(t2);

/* 5 */
const M = require(path.join(REPO, 'football', 'cfb_lab', 'models.js'));
const K = M.keyNumberDist(dist), pm = K.pmf(7.4), c = CH.coverMargin(CH.entryFor('g1', now), 3);
let win = 0, push = 0; pm.forEach((q, i) => { const k = i - K.kmax; if (k > 3) win += q; else if (k === 3) push += q; });
chk('cover against a margin line is the loop\'s own distribution, unconditional, summing to 1',
  Math.abs(c.win - win) < 1e-12 && Math.abs(c.push - push) < 1e-12 && Math.abs(c.win + c.push + c.lose - 1) < 1e-12 && c.basis === 'champion:key_number', c);
chk('an entry without a known distribution has no champion cover (the engine keeps its own shape)',
  CH.coverMargin(Object.assign({}, e1, { distribution: { kind: 'student_t', sigma: 16, t_df: 8 } }), 3) === null);
CH.load(null);

/* 6 */
const cur = loop('2.0.0'), want = 'model_loop:2.0.0:' + cur.config_sha256.slice(0, 12);
const roles = GOV.currentRoles([role(V1, 'champion'), role(LOOP, 'challenger')]);
const eligible = { comparison: { promotion: { evaluations: [{ challenger: LOOP, decision: 'ELIGIBLE', ready: true, n: 160, min_n: 150 }] } } };
const g = (o) => PG.guard(LOOP, Object.assign({ roles, tests: { ok: true }, loopCurrent: cur, now: NOW, capturedCalibrations: [want], lab: eligible }, o || {}));
chk('the guard passes a loop version with live evidence on the config it serves and ELIGIBLE', g().ok, g().checks.filter((x) => !x.ok));
chk('… and refuses it without a live capture, on another config, or short of ELIGIBLE',
  !g({ capturedCalibrations: [] }).ok && !g({ capturedCalibrations: [want, 'model_loop:2.0.0:somethingelse'] }).ok
    && !g({ lab: { comparison: { promotion: { evaluations: [{ challenger: LOOP, decision: 'NOT_ELIGIBLE', ready: true, n: 160, min_n: 150 }] } } } }).ok);
chk('… or when the loop serves another version, or the version is a label', !g({ loopCurrent: loop('2.1.0') }).ok && !PG.guard('edgedesk_cfb_loop_latest', { roles, tests: { ok: true } }).ok);

console.log(fail ? `FAILED ${pass} passed, ${fail} failed` : `ALL GREEN ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
