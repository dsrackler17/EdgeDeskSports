#!/usr/bin/env node
/* ============================================================================
   FSIE integration with the existing models:
     - the REAL NFL slate builder (tools/football/build_nfl_slate.js) on
       fixture feeds, OFF vs SHADOW: every existing field byte-identical; OFF
       adds no key at all; SHADOW appends `situational` with 0 points applied
     - the adapter's three locks: ACTIVE is refused unless a promotion record,
       points_applied and the ACTIVE mode all agree; FSIE_MODE can only lower
     - the candidate substitutes the model's own pace term (no double count)
     - the simulator shadow: OFF computes nothing; SHADOW conditions on the
       simulator's own margin model and changes no simulator draw
     - isolation: no pricing file of either engine reads the situational layer
   Run: node football/situational/tests/integration.test.js
   ========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('./_harness.js');
const T = H.kit('fsie integration');
const chk = T.chk;
const ROOT = path.join(__dirname, '..', '..', '..');

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'fsie-shadow-'));
process.env.FSIE_SHADOW_DIR = stage;
const A = require('../adapter.js');
const CFG = { targets: { nfl_slate: { mode: 'SHADOW', points_applied: false }, fbs_slate: { mode: 'SHADOW', points_applied: false }, nfl_simulator: { mode: 'SHADOW' }, cfb_simulator: { mode: 'OFF' } } };
const SH = { model_version: 'situational_v1', built_at: '2026-09-16T12:00:00Z', games: { '2026_02_KC_BUF': { as_of: '2026-09-16T12:00:00Z', home: { plays: [55, 64, 74] }, away: { plays: [54, 63, 73] }, game_plays: 127.4, game_plays_dev: 1.4, game_drives: 21.2 } } };

/* ------------------------------------------------------------------ locks */
chk('the committed config defaults every target to SHADOW with no points', (() => { const c = JSON.parse(fs.readFileSync(A.CONFIG_FILE, 'utf8')); return Object.values(c.targets).every((t) => t.mode === 'SHADOW' && t.points_applied === false); })());
chk('no promotion record is committed', !fs.existsSync(A.PROMOTION_FILE));
chk('OFF returns nothing', A.shadowBlock('nfl', 'nfl_slate', '2026_02_KC_BUF', {}, { config: { targets: { nfl_slate: { mode: 'OFF' } } }, shadow: SH }) === null);
const blk = A.shadowBlock('nfl', 'nfl_slate', '2026_02_KC_BUF', { fair_total: 48.2, pace: { input: -0.75, points: -0.069 } }, { config: CFG, shadow: SH });
chk('SHADOW returns a labelled block with 0 points applied', blk && blk.mode === 'SHADOW' && blk.applied_points === 0 && blk.affects_projection === false && A.applied(blk) === 0);
chk('the candidate substitutes the model\'s own pace term: coef x (situational - existing)', Math.abs(blk.candidate.total_points_delta - (-0.069 / -0.75) * (1.4 - -0.75)) < 0.011);
chk('no pace term supplied -> no candidate, and the reason', A.shadowBlock('nfl', 'nfl_slate', '2026_02_KC_BUF', { fair_total: 48 }, { config: CFG, shadow: SH }).candidate === null);
const activeCfg = { targets: { nfl_slate: { mode: 'ACTIVE', points_applied: true } } };
const refused = A.shadowBlock('nfl', 'nfl_slate', '2026_02_KC_BUF', { fair_total: 48.2, pace: { input: -0.75, points: -0.069 } }, { config: activeCfg, shadow: SH, promotion: null });
chk('ACTIVE without a promotion record is refused: 0 points', refused.applied_points === 0 && /REFUSED/.test(refused.label) && refused.locks.validated === false);
const unsigned = A.shadowBlock('nfl', 'nfl_slate', '2026_02_KC_BUF', { fair_total: 48.2, pace: { input: -0.75, points: -0.069 } }, { config: activeCfg, shadow: SH, promotion: { targets: { nfl_slate: { status: 'APPROVED' } } } });
chk('a promotion record without a signer and evidence does not open the lock', unsigned.applied_points === 0);
const opened = A.shadowBlock('nfl', 'nfl_slate', '2026_02_KC_BUF', { fair_total: 48.2, pace: { input: -0.75, points: -0.069 } }, { config: activeCfg, shadow: SH, promotion: { targets: { nfl_slate: { status: 'APPROVED', approved_by: 'owner', evidence: 'study.json' } } } });
chk('only all three locks together apply the candidate', opened.applied_points === opened.candidate.total_points_delta && opened.applied_points !== 0);
process.env.FSIE_MODE = 'SHADOW';
chk('FSIE_MODE=SHADOW lowers an ACTIVE config', A.mode('nfl_slate', { config: activeCfg }) === 'SHADOW');
process.env.FSIE_MODE = 'ACTIVE';
chk('FSIE_MODE cannot raise a mode', A.mode('nfl_slate', { config: CFG }) === 'SHADOW');
delete process.env.FSIE_MODE;

/* ----------------------------------------------- the real NFL builder, parity */
const B = require(path.join(ROOT, 'tools', 'football', 'build_nfl_slate.js'));
const NOW = Date.parse('2026-09-16T12:00:00Z');
const GAMES = [
  'game_id,season,game_type,week,gameday,weekday,gametime,away_team,away_score,home_team,home_score,location,result,total,overtime,old_game_id,gsis,nfl_detail_id,pfr,pff,espn,ftn,away_rest,home_rest,away_moneyline,home_moneyline,spread_line,away_spread_odds,home_spread_odds,total_line,under_odds,over_odds,div_game,roof,surface,temp,wind,away_qb_id,home_qb_id,away_qb_name,home_qb_name,away_coach,home_coach,referee,stadium_id,stadium',
  '2026_01_LA_SF,2026,REG,1,2026-09-10,Thursday,20:15,LA,17,SF,24,Home,7,41,0,,,,,,,,7,7,150,-180,3.5,-110,-110,47.5,-110,-110,1,outdoors,grass,68,5,00-0036355,00-0037834,Matthew Stafford,Brock Purdy,Sean McVay,Kyle Shanahan,,SF01,Levi\'s Stadium',
  '2026_02_KC_BUF,2026,REG,2,2026-09-20,Sunday,13:00,KC,,BUF,,Home,,,,,,,,,,,10,10,120,-140,2.5,-110,-110,49.5,-110,-110,0,outdoors,a_turf,,,00-0033873,00-0034857,Patrick Mahomes,Josh Allen,Andy Reid,Sean McDermott,,BUF00,Highmark Stadium'
].join('\n');
const STW = ['season,week,season_type,team,opponent_team,game_id,completions,attempts,passing_yards,passing_tds,passing_interceptions,sacks_suffered,sack_yards_lost,passing_first_downs,passing_epa,carries,rushing_yards,rushing_tds,rushing_first_downs,rushing_epa,def_sacks,def_interceptions,def_epa',
  '2026,1,REG,SF,LA,2026_01_LA_SF,22,30,260,2,0,1,8,12,6.1,28,120,1,7,2.0,3,1,4.0',
  '2026,1,REG,LA,SF,2026_01_LA_SF,24,36,240,1,1,3,20,10,-1.2,20,80,1,4,-0.5,1,0,-6.0'].join('\n');
const ROSTER = 'season,team,position,depth_chart_position,jersey_number,status,full_name,gsis_id,espn_id\n2026,SF,QB,QB,13,ACT,Brock Purdy,00-0037834,4361741\n2026,LA,QB,QB,9,ACT,Matthew Stafford,00-0036355,12483';
const STORE = path.join(ROOT, 'football', 'venues', 'forecasts.json');
const storeBefore = fs.existsSync(STORE) ? fs.readFileSync(STORE, 'utf8') : null;
async function slate() {
  return B.build({ now: NOW, offline: true, lookahead: 12,
    fetchText: async (u) => (/games\.csv/.test(u) ? GAMES : /stats_team_week/.test(u) ? STW : /roster/.test(u) ? ROSTER : /nfl_stadiums\.json$/.test(u) ? fs.readFileSync(path.join(ROOT, 'football', 'venues', 'nfl_stadiums.json'), 'utf8') : ''),
    coachingSeed: { schema: 'fixture-empty-seed', teams: {} },
    coachingValidation: { schema: 'fixture', status: 'CANDIDATE', affects_projection: false, tuned_cap: 1, selected_cap: 0, selected_reliability_k: 4, verdict: { effect_size: 0, p_value: 1 }, reason: 'fixture' } });
}
/* wall-clock stamps differ between any two builds; everything else must not */
function strip(o) { const c = JSON.parse(JSON.stringify(o)); delete c.generated_at; if (c.pricing) delete c.pricing.built_at; (c.games || []).forEach((g) => { delete g.situational; }); return c; }

(async () => {
  process.env.FSIE_MODE = 'OFF'; A.reset();
  const off = await slate();
  delete process.env.FSIE_MODE;
  fs.writeFileSync(path.join(stage, 'nfl.json'), JSON.stringify(SH)); A.reset();
  const sh = await slate();
  chk('the fixture slate built and priced the upcoming game', off.games.some((g) => g.game_id === '2026_02_KC_BUF' && g.model_status === 'PREDICTED'));
  chk('OFF: no row carries a situational key (the row shape is unchanged)', off.games.every((g) => !('situational' in g)));
  chk('SHADOW: the staged game carries the block, with 0 points applied', (() => { const g = sh.games.find((x) => x.game_id === '2026_02_KC_BUF'); return g && g.situational && g.situational.applied_points === 0 && g.situational.mode === 'SHADOW'; })());
  chk('SHADOW: the candidate reads the engine\'s own pace_sum term', (() => { const g = sh.games.find((x) => x.game_id === '2026_02_KC_BUF'); const ps = g.contributions.total.find((c) => c.key === 'pace_sum'); return g.situational.candidate && Math.abs(g.situational.candidate.existing_pace_input - ps.value) < 0.01; })());
  { const a = strip(off), b = strip(sh); const diff = []; (function walk(x, y, p) { if (JSON.stringify(x) === JSON.stringify(y)) return; if (x && y && typeof x === 'object' && typeof y === 'object') { Object.keys(Object.assign({}, x, y)).forEach((k) => walk(x[k], y[k], p + '.' + k)); return; } diff.push(p + ': ' + JSON.stringify(x).slice(0, 80) + ' vs ' + JSON.stringify(y).slice(0, 80)); })(a, b, '');
    chk('OFF and SHADOW publish byte-identical existing outputs (spread, total, probability, contributions, every field)', diff.length === 0, diff.slice(0, 8)); }
  chk('the fixture builds wrote nothing to the committed forecast store', (fs.existsSync(STORE) ? fs.readFileSync(STORE, 'utf8') : null) === storeBefore);

  /* ------------------------------------------------- the simulator shadow */
  const SS = require('../simulator_shadow.js');
  const VM = require('../core/volume_model.js');
  const rows = require('./_synthetic.js').panel(200, 5);
  const P = { model_version: 'test', primary_variant: 'pace_script', team: VM.train('nfl', rows, { lambda: 5 }) };
  const row = { home: rows[0], away: rows[1] };
  const offRun = SS.run('nfl', P, { g1: row }, { config: { targets: { nfl_simulator: { mode: 'OFF' } } }, inputs: { g1: { fair_margin: 3, sigma: 13, fair_total: 45 } } });
  chk('simulator OFF computes nothing', Object.keys(offRun.games).length === 0 && offRun.mode === 'OFF');
  const shRun = SS.run('nfl', P, { g1: row }, { config: { targets: { nfl_simulator: { mode: 'SHADOW' } } }, inputs: { g1: { fair_margin: 3, sigma: 13, fair_total: 45 } }, draws: 800 });
  const gg = shRun.games.g1;
  chk('simulator SHADOW conditions on the simulator\'s own margin model', gg && gg.conditioned_on.fair_home_margin === 3 && gg.conditioned_on.sigma === 13 && gg.simulator_draws_changed === 0);
  chk('simulator SHADOW: possessions and play ranges per team', gg.home.plays[0] <= gg.home.plays[1] && gg.home.plays[1] <= gg.home.plays[2] && gg.game_possessions_mean > 10);
  chk('a wider simulator sigma spreads the scripts more (the margin model really drives it)', (() => {
    const w = SS.run('nfl', P, { g1: row }, { config: { targets: { nfl_simulator: { mode: 'SHADOW' } } }, inputs: { g1: { fair_margin: 3, sigma: 30, fair_total: 45 } }, draws: 800 }).games.g1;
    return w.home.script.garbage > gg.home.script.garbage;
  })());
  void VM;

  /* ------------------------------------------------------------- isolation */
  const PRICING = ['football/engine.js', 'football/nfl_model.js', 'football/params.js', 'football/nfl_params_v2.js', 'football/cfb_p4/engine.js', 'football/cfb_p4/params.js', 'football/rankings/engine_efficiency.js', 'football/matchup/inputs.js', 'football/fbs/fbs.js'];
  chk('no pricing file of either engine reads the situational layer', PRICING.every((f) => !/football\/situational|situational\/adapter|fsieShadow|FSIE/.test(fs.readFileSync(path.join(ROOT, f), 'utf8'))));
  const cov = fs.readFileSync(path.join(ROOT, 'football', 'fbs', 'build_coverage.js'), 'utf8');
  chk('the FBS builder appends the block by spreading the adapter\'s answer (no key when there is none)', /\.\.\.fsieShadow\(m\.id, p\)/.test(cov) && /return b \? \{ situational_shadow: b \} : \{\};/.test(cov));
  const nflb = fs.readFileSync(path.join(ROOT, 'tools', 'football', 'build_nfl_slate.js'), 'utf8');
  chk('the NFL builder appends the block the same way', /\.\.\.fsieShadow\(String\(g\.game_id\), p\)/.test(nflb) && /return b \? \{ situational: b \} : \{\};/.test(nflb));

  /* the committed run log: a stage's timing is never overwritten by a count of the same name */
  const st = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'situational', 'data', 'state.json'), 'utf8'));
  const stages = (st.runs || []).flatMap((r) => Object.keys(r.stages || {}).map((sp) => r.stages[sp]));
  chk('every recorded build stage keeps its timings (ms.total, ms.projections) apart from its counts', stages.length > 0 && stages.every((s) => s.ms && Number.isFinite(s.ms.total) && Number.isFinite(s.ms.projections) && Number.isInteger(s.projections)), JSON.stringify(stages[0]).slice(0, 300));

  /* the scheduled pipeline keeps what its build derived. The market refresh (--offline) reads the derived
     seasons the last build left in football/situational/.cache, and actions/cache saves only when the whole
     job passes: the Supabase copy failing after a good build (2026-10-30 16:50) threw the cache away, and
     every market refresh after it stopped on "no derived season" */
  const W = require(path.join(ROOT, 'tools', 'ci', 'workflows.js'));
  const steps = W.parseYaml(fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'football-situational.yml'), 'utf8')).jobs.run.steps;
  const CACHE = 'football/situational/.cache';
  const onCache = (re) => steps.findIndex((s) => re.test(s.uses || '') && s.with && s.with.path === CACHE);
  const runs = (re) => steps.findIndex((s) => re.test(s.run || ''));
  const restore = onCache(/^actions\/cache\/restore@/), save = onCache(/^actions\/cache\/save@/);
  const lastStage = Math.max(...steps.map((s, i) => (/football\/situational\/run\.js/.test(s.run || '') ? i : -1)));
  chk('the pipeline restores the source cache without tying its save to the whole job', restore >= 0 && onCache(/^actions\/cache@/) < 0);
  chk('it saves the cache after every engine stage, before the commit and the Supabase copy', save > lastStage && lastStage > restore && save < runs(/push_generated\.sh/) && save < runs(/sync_supabase\.js/));
  chk('only when the engine stages passed (a failed build saves nothing)', save >= 0 && !/always\(\)|failure\(\)|cancelled\(\)/.test(steps[save].if || ''));
  chk('under a key the next run restores', save >= 0 && restore >= 0 && String(steps[save].with.key).startsWith(String(steps[restore].with['restore-keys'])));

  fs.rmSync(stage, { recursive: true, force: true });
  process.exit(T.done());
})().catch((e) => { console.error(e); process.exit(1); });
