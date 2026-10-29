#!/usr/bin/env node
/* ============================================================================
   FSIE models and research harness, offline on a synthetic panel:
     team volume   reconciliation on EVERY draw, coherent possessions, ordered
                   intervals, deterministic replay, the script mixture, sport
                   isolation
     players       allocations never exceed the team's own draw, shares sum to
                   at most one per type, availability removes and
                   redistributes, college is "unverified", the starter share
     research      a draft or changed preregistration, changed model code, a
                   second look and a holdout read inside walk-forward are all
                   refused; the criteria judge is mechanical
   Run: node football/situational/tests/model.test.js
   ========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('./_harness.js');
const U = require('../core/util.js');
const VM = require('../core/volume_model.js');
const PM = require('../core/player_model.js');
const R = require('../core/research.js');
const T = H.kit('fsie models');
const chk = T.chk;

const { panel } = require('./_synthetic.js');
const SCR = VM.SCRIPTS;
const rows = panel(500, 11);
const P = VM.train('nfl', rows, { lambda: 5 });
chk('training produces every ablation rung and the market-only baseline', ['situational', 'opponent', 'pace_script', 'formation', 'market_only'].every((k) => P.models[k] && P.models[k].plays && P.models[k].db && P.models[k].drives));
chk('the script table has a share per script, per margin bin, summing to one', P.tables.script_m.bins.every((b) => Math.abs(SCR.reduce((s, k) => s + b[k], 0) - 1) < 1e-3));
chk('trailing teams pass more in the script mixture than leading teams', (() => { const lo = VM.sharesFor(P.tables.script_m, -8), hi = VM.sharesFor(P.tables.script_m, 8); return lo.trailing > hi.trailing && hi.leading > lo.leading; })());
const mu = VM.predictMean(P, rows[0], 'pace_script');
chk('the point estimate reconciles exactly: pass + sacks + rush = plays', Math.abs(mu.pass_att + mu.sacks + mu.rush_att - mu.plays) < 1e-9);
const sim = VM.simulateGame(P, rows[0], rows[1], { variant: 'pace_script', draws: 1500, keep_draws: true, seed: 'test' });
chk('EVERY draw reconciles: pass + sacks + rush = plays, both teams', ['a', 'b'].every((k) => { const d = sim[k].draws; return d.plays.every((p, i) => d.pass_att[i] + d.sacks[i] + d.rush_att[i] === p && d.pass_att[i] >= 0 && d.rush_att[i] >= 0); }));
chk('EVERY draw: the two teams\' possessions differ by at most one', sim.a.draws.drives.every((d, i) => Math.abs(d - sim.b.draws.drives[i]) <= 1));
chk('intervals are ordered P10 <= P50 <= P90', ['a', 'b'].every((k) => ['plays', 'pass_att', 'rush_att', 'drives'].every((m) => sim[k].p10[m] <= sim[k].p50[m] && sim[k].p50[m] <= sim[k].p90[m])));
chk('intervals are not degenerate (P90 - P10 >= 6 plays)', sim.a.p90.plays - sim.a.p10.plays >= 6);
chk('the simulation mean tracks the point estimate (within 2 plays)', Math.abs(sim.a.mean.plays - VM.predictMean(P, rows[0], 'pace_script').plays) < 2);
chk('deterministic replay: same seed, same distribution', JSON.stringify(VM.simulateGame(P, rows[0], rows[1], { variant: 'pace_script', draws: 500, seed: 's' }).a) === JSON.stringify(VM.simulateGame(P, rows[0], rows[1], { variant: 'pace_script', draws: 500, seed: 's' }).a));
chk('a simulator-supplied margin sigma widens the script spread', (() => { const narrow = VM.simulateGame(P, rows[0], rows[1], { draws: 800, seed: 'q', sigma_margin: 2 }); const wide = VM.simulateGame(P, rows[0], rows[1], { draws: 800, seed: 'q', sigma_margin: 30 }); return wide.a.script.garbage > narrow.a.script.garbage; })());
chk('sport isolation: a CFB fit shares no object with the NFL fit', (() => { const c = VM.train('cfb', rows.map((r) => Object.assign({}, r, { sport: 'cfb' })), { lambda: 5 }); return c.sport === 'cfb' && P.sport === 'nfl' && c.models !== P.models && c.scramble === null && P.scramble !== null; })());
chk('the market-only baseline reads no team tendency', (() => { const r2 = JSON.parse(JSON.stringify(rows[0])); r2.T.off.plays_pg.v = 99; return VM.predictMean(P, r2, 'market_only').plays === VM.predictMean(P, rows[0], 'market_only').plays; })());
chk('formation features are 0 where not observed (no imputation)', (() => { const f = VM.featuresFor(rows[0], 'formation', P.tables); return f.db.t_shotgun === 0 && f.db.has_ftn === 0; })());

/* --------------------------------------------------------------- players */
function usageSeason() {
  const tg = [], pg = [];
  for (let g = 0; g < 6; g++) {
    const gid = 'x' + g, k = '2026-09-' + String(10 + g * 7).padStart(2, '0') + 'T17:00:00Z';
    tg.push({ game_id: gid, team: 'T', opp: 'O', season_type: 'REG', kickoff_at: k, week: g + 1, quality: { player_ok: true, volume_ok: true }, counts: { pass_att: 34, designed_rush: 24, scrambles: 2, kneels: 1, dropbacks: 38, plays: 62 } });
    pg.push({ game_id: gid, team: 'T', player_id: 'QB1', name: 'Q One', pass_att: 33, dropbacks: 37, rush_att: 4, designed_rush: 2, scrambles: 2, kneels: 0, targets: 0, receptions: 0, started: true });
    pg.push({ game_id: gid, team: 'T', player_id: 'QB2', name: 'Q Two', pass_att: 1, dropbacks: 1, rush_att: 0, designed_rush: 0, scrambles: 0, kneels: 0, targets: 0, receptions: 0, started: false });
    pg.push({ game_id: gid, team: 'T', player_id: 'RB1', name: 'R One', pass_att: 0, dropbacks: 0, rush_att: 16, designed_rush: 16, scrambles: 0, kneels: 0, targets: 3, receptions: 2, started: false });
    pg.push({ game_id: gid, team: 'T', player_id: 'RB2', name: 'R Two', pass_att: 0, dropbacks: 0, rush_att: 6, designed_rush: 6, scrambles: 0, kneels: 0, targets: 1, receptions: 1, started: false });
    ['W1', 'W2', 'W3'].forEach((w, i) => pg.push({ game_id: gid, team: 'T', player_id: w, name: w, pass_att: 0, dropbacks: 0, rush_att: 0, designed_rush: 0, scrambles: 0, kneels: 0, targets: [10, 7, 5][i], receptions: [7, 4, 3][i], started: false }));
  }
  return { team_games: tg, player_games: pg };
}
const us = usageSeason();
const st = PM.playerStates('nfl', us, null, { append_next: true }).get('NEXT|T');
chk('the next game has a state for every recently active player', st && ['QB1', 'RB1', 'RB2', 'W1', 'W2', 'W3'].every((id) => st.players.some((p) => p.player_id === id)));
chk('shares sum to at most 0.98 per type', ['pass', 'rush', 'target'].every((k) => st.players.reduce((s, p) => s + p.share[k], 0) <= 0.98 + 1e-9));
chk('roles come from usage', st.players.find((p) => p.player_id === 'QB1').role === 'QB' && st.players.find((p) => p.player_id === 'RB1').role === 'RB' && st.players.find((p) => p.player_id === 'W1').role === 'RECEIVER');
const team = { pass_att: 34, rush_att: 27, scrambles: 2, kneels: 1, targeted_ratio: 0.95, starter_share: 0.965 };
const out = PM.applyAvailability('nfl', st.players, (id) => (id === 'RB1' ? 'OUT' : id === 'W2' ? 'DOUBTFUL' : null));
chk('an OUT player is removed and his share redistributed', !out.some((p) => p.player_id === 'RB1') && out.find((p) => p.player_id === 'RB2').share.rush > st.players.find((p) => p.player_id === 'RB2').share.rush);
chk('a DOUBTFUL player keeps a quarter of his share and is flagged', (() => { const w = out.find((p) => p.player_id === 'W2'); return w.availability.status === 'DOUBTFUL' && w.share.target < st.players.find((p) => p.player_id === 'W2').share.target * 0.5; })());
chk('college players are "unverified", never guessed healthy or out', PM.applyAvailability('cfb', st.players, null).every((p) => p.availability.status === 'UNVERIFIED' && p.widen > 1));
const means = PM.projectMeans(team, PM.applyAvailability('nfl', st.players, null), 'nfl');
chk('the starting QB\'s share comes from his starts, shrunk to the starter share', (() => { const q = means.find((m) => m.player_id === 'QB1'); return q.pass_att > 30 && q.pass_att < 34; })());
const tdraws = VM.simulateGame(P, rows[0], rows[1], { draws: 600, keep_draws: true, seed: 'pl' }).a.draws;
const psim = PM.simulatePlayers(Object.assign({}, team, { qb_exit_rate: 0.08 }), tdraws, PM.applyAvailability('nfl', st.players, null), { keep_draws: true, seed: 'p' });
chk('no player draw exceeds his team\'s draw (targets vs pass attempts; QB attempts vs team attempts)', psim.every((ps) => ps.draws.targets.every((t, i) => t <= tdraws.pass_att[i]) && ps.draws.pass_att.every((a, i) => a <= tdraws.pass_att[i]) && ps.draws.receptions.every((r, i) => r <= ps.draws.targets[i])));
chk('joint allocation: on every draw the players\' targets, rushes and pass attempts sum to at most the team\'s', tdraws.pass_att.every((pa, i) => psim.reduce((s, ps) => s + ps.draws.targets[i], 0) <= pa && psim.reduce((s, ps) => s + ps.draws.pass_att[i], 0) <= pa && psim.reduce((s, ps) => s + ps.draws.rush_att[i], 0) <= tdraws.rush_att[i]));
chk('the QB early-exit tail produces low-attempt draws', (() => { const q = psim.find((p) => p.player_id === 'QB1'); return q.pass_att.p10 < q.pass_att.p50 - 5; })());

/* ---------------------------------------------------------------- research */
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsie-res-'));
  const draft = JSON.parse(fs.readFileSync(R.PREREG, 'utf8')); draft.status = 'draft';
  R.withPrereg(draft);
  await T.achk('the holdout refuses a draft preregistration', async () => { try { await R.holdout('nfl', { research_dir: tmp }); return false; } catch (e) { return /not frozen/.test(e.message); } });
  const frozen = JSON.parse(JSON.stringify(draft)); frozen.status = 'frozen'; frozen.code_fingerprint = R.codeFingerprint(); frozen.content_sha256 = R.preregContentSha(frozen);
  R.withPrereg(frozen);
  chk('a frozen preregistration with the current code passes the freeze check', R.checkFrozen().ok);
  const edited = JSON.parse(JSON.stringify(frozen)); edited.sports.nfl.ridge_lambda = 1;
  R.withPrereg(edited);
  chk('an edit after the freeze is caught', !R.checkFrozen().ok && /content changed/.test(R.checkFrozen().why));
  const stale = JSON.parse(JSON.stringify(frozen)); stale.code_fingerprint.files['core/volume_model.js'] = 'x'; stale.code_fingerprint.sha256 = 'y'; stale.content_sha256 = R.preregContentSha(stale);
  R.withPrereg(stale);
  chk('changed model code after the freeze is caught, by file', !R.checkFrozen().ok && /core\/volume_model\.js/.test(R.checkFrozen().why));
  R.withPrereg(frozen);
  fs.writeFileSync(path.join(tmp, 'holdout_nfl.json'), '{}');
  await T.achk('a second look at the holdout is refused', async () => { try { await R.holdout('nfl', { research_dir: tmp }); return false; } catch (e) { return /evaluated once/.test(e.message); } });
  await T.achk('production parameters are refused before the holdout', async () => { try { await R.productionFit('cfb', { research_dir: tmp }); return false; } catch (e) { return /holdout has not been evaluated/.test(e.message); } });
  const leak = JSON.parse(JSON.stringify(frozen)); leak.sports.nfl.seasons.validation = [2024, 2025];
  R.withPrereg(leak);
  await T.achk('walk-forward refuses to read the holdout season', async () => { try { await R.walkForward('nfl', { cache_dir: tmp }); return false; } catch (e) { return /may not read the holdout/.test(e.message); } });
  R.withPrereg(null);
  /* the judge */
  const crit = frozen.sports.nfl.promotion_criteria;
  const good = { primary_variant: 'pace_script', n_team_games: 570, team: { paired: {}, metrics: {}, coverage: {} }, players: { coverage: {} } };
  ['plays', 'pass_att', 'rush_att'].forEach((t) => {
    good.team.paired[t] = { pace_script_vs_season_avg: { mae_diff: -0.5, ci95: [-0.7, -0.3] }, pace_script_vs_recent_weighted: { mae_diff: -0.3, ci95: [-0.5, -0.1] }, pace_script_vs_market_only: { mae_diff: -0.2, pct_change: -1, ci95: [-0.3, -0.1] } };
    good.team.metrics[t] = { pace_script: { bias: 0.1 } }; good.team.coverage[t] = { p10_p90: 0.8 };
  });
  ['pass_att', 'rush_att', 'targets', 'receptions'].forEach((m) => { good.players[m] = { evaluated: 3000, metrics: { model: { bias: 0.1 } }, paired: { model_vs_season_avg: { ci95: [-0.2, -0.1] }, model_vs_recent_weighted: { ci95: [-0.2, -0.1] } } }; good.players.coverage[m] = { p10_p90: 0.8 }; });
  const j1 = R.judge('nfl', crit, good);
  chk('the judge passes a result that meets every criterion', j1.team_passed && j1.player_passed);
  const bad = JSON.parse(JSON.stringify(good)); bad.team.paired.plays.pace_script_vs_season_avg.ci95 = [-0.4, 0.05]; bad.players.coverage.targets.p10_p90 = 0.95;
  const j2 = R.judge('nfl', crit, bad);
  chk('one CI crossing zero fails the team result; one coverage outside the band fails the player result', !j2.team_passed && !j2.player_passed && j2.team.find((c) => c.id === 'beats_season_avg').pass === false);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(T.done());
})();
