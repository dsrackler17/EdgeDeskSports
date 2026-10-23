/* ===========================================================================
   THE MLB INPUT SNAPSHOT — everything a simulation reads, captured once,
   validated, frozen and hashed BEFORE the first simulated season.

   Two builders produce the same document:
     history   buildMlbHistorySnapshot({ season, asOf }): any morning of a
               committed season (2022-2025: the formats the module
               simulates). Completed games and their starters are Observed
               (Retrosheet; the 2024 table has no starters); later games are
               scheduled; future postseason dates are the Estimated
               calendar (the logs would otherwise reveal series lengths).
     live      statsapi.ts buildMlbLiveSnapshot(): the season in progress
               from MLB's Stats API (schedule, scores, probable pitchers,
               box-score starters). MLB's API is not reachable from the
               build environment; the parser is tested on the real 2024
               schedule response committed in the data pack.

   Where every number comes from:
     results, starters  Observed (games.status final)
     confirmed starters the announced probable pitcher of a scheduled game
     game model         the served MLB lab brain (model_adapter.ts), replayed
                        point-in-time to the as-of morning (Research)
     strength offsets   simulator/data/mlb_strength_uncertainty.json
     rotation           simulator/data/mlb_rotation_study.json
     postseason xi      simulator/data/mlb_game_model_study.json
   The snapshot's `data` is canonical and content-hashed (input_hash);
   `meta` carries what does not change a result (build time, feeds).
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { canonicalJson, hashCanonical, sha256Hex } from '../../core/canonical.ts';
import { MLB_2026, teamsFor, formatFor, type MlbSeasonConfig, type MlbTeam, type MlbFormat, type Round, type CalendarTemplate } from './config.ts';
import { loadRegularSeason, loadPostseason, dayOf, dateOf, REPO, type HistGame } from './history.ts';
import { replay, servedConfig, calibrationFor, modelCodeHashes, type ModelState, type Calibration } from './model_adapter.ts';
import { rotationAt, lastStarts, type RotationParams, type Start } from './rotation.ts';

export const MLB_INPUT_SCHEMA = 'edgedesk_sim_mlb_inputs_v1';
export const DATA_FILES = {
  strength: 'simulator/data/mlb_strength_uncertainty.json',
  rotation: 'simulator/data/mlb_rotation_study.json',
  game_model: 'simulator/data/mlb_game_model_study.json'
};

export interface StarterRef { id: string; status: 'Observed' | 'Confirmed' }
export interface MlbInputGame {
  id: string;
  phase: 'regular' | 'postseason';
  date: string;
  /** 0 a single game; 1 or 2 the game of a doubleheader */
  game_no: number;
  home: string; away: string;
  status: 'final' | 'scheduled';
  home_score: number | null; away_score: number | null;
  starters: { home: StarterRef | null; away: StarterRef | null };
  /** postseason only */
  round: Round | null; series_game: number | null;
  /** a scheduled game whose date the source does not know yet (postponed, not rescheduled): simulated after the last scheduled date */
  date_estimated: boolean;
}
export interface ClubRotation { members: string[]; last_start: string[]; s: number[] }
export interface MlbInputData {
  schema: string;
  sport: 'mlb'; competition: 'MLB'; season: number;
  mode: 'history' | 'live';
  /** the morning the snapshot describes: every game of an earlier date is final */
  as_of: string;
  config: MlbSeasonConfig;
  format: MlbFormat;
  teams: MlbTeam[];
  games: MlbInputGame[];
  regular_season_complete: boolean;
  last_regular_date: string;
  postseason_calendar: { template: CalendarTemplate; source: string };
  model: {
    model_version: string; served_version: string; served_config: Record<string, number>; config_sha256: string; candidate: 'team_park_sp';
    fit_as_of: string; state: ModelState; calibration: Calibration;
    xi_postseason: number; xi_postseason_source: string;
    replacement_s: number; replacement_source: string;
  };
  strength: { distribution: 'normal'; sigma_team: number; sigma_team_ci95: [number, number]; stage: number | 'postseason'; sigma_sp: number; sigma_sp_ci95: [number, number]; method: string; source: string; source_sha256: string };
  rotation: { params: RotationParams; clubs: Record<string, ClubRotation>; method: string; source: string; source_sha256: string };
  pitcher_names: Record<string, string>;
  code_sha256: Record<string, string>;
  notes: string[];
}
export interface MlbSnapshot {
  schema: string;
  input_hash: string;
  data: MlbInputData;
  meta: { built_at: string; feeds: Array<{ url: string; sha256: string; bytes: number }>; offline: boolean; builder: string };
}

const readJson = (rel: string) => { const text = fs.readFileSync(path.join(REPO, rel), 'utf8'); return { doc: JSON.parse(text), sha256: sha256Hex(text) }; };

/** the season config a history snapshot runs under: the 2026 structure, with the season's own facts marked as history */
export function historyConfig(season: number): MlbSeasonConfig {
  const c = JSON.parse(JSON.stringify(MLB_2026)) as MlbSeasonConfig;
  c.season = season;
  for (const k of ['alignment', 'format', 'tiebreakers', 'world_series_home', 'extra_innings'] as const) {
    (c[k] as any).source = 'History replay of ' + season + ': the rules of config.ts formatFor(' + season + '), held against that season\'s Retrosheet postseason by simulator/tests/mlb_rules_history.test.ts';
    (c[k] as any).verification = 'NOT_APPLICABLE';
  }
  return c;
}

/** the calibrated sigmas for an as-of point: the largest stage the clubs have reached, the last stage after the season */
export function strengthFor(avgGames: number, complete: boolean): MlbInputData['strength'] {
  const { doc, sha256 } = readJson(DATA_FILES.strength);
  const stages = Object.keys(doc.sigma_team_by_stage).map(Number).sort((a, b) => a - b);
  let stage = stages[0];
  for (const s of stages) if (avgGames >= s) stage = s;
  const row = doc.sigma_team_by_stage[String(complete ? stages[stages.length - 1] : stage)];
  if (!row || row.sigma_team == null) throw new Error('no calibrated sigma_team for stage ' + stage);
  return { distribution: 'normal', sigma_team: row.sigma_team, sigma_team_ci95: row.ci95, stage: complete ? 'postseason' : stage, sigma_sp: doc.sigma_sp.value, sigma_sp_ci95: doc.sigma_sp.ci95,
    method: 'win-total calibration of the club offset per stage, with the starter offset from within-pitcher residual covariance' + (complete ? '; after the regular season the last stage (' + stages[stages.length - 1] + ') is carried, not tested' : ''),
    source: DATA_FILES.strength, source_sha256: sha256 };
}

export function rotationParams(): { params: RotationParams; sha256: string } {
  const { doc, sha256 } = readJson(DATA_FILES.rotation);
  return { params: doc.simulator_parameters as RotationParams, sha256 };
}
export function gameModelStudy(): { xi: number; sha256: string; doc: any } {
  const { doc, sha256 } = readJson(DATA_FILES.game_model);
  return { xi: doc.extra_inning_home_rate.used_by_simulator.postseason, sha256, doc };
}

export const SIM_CODE_FILES = ['simulator/src/sports/mlb/rules.ts', 'simulator/src/sports/mlb/rotation.ts', 'simulator/src/sports/mlb/model_adapter.ts'];
export function codeHashes(): Record<string, string> {
  const out = modelCodeHashes();
  for (const f of [...Object.values(DATA_FILES), ...SIM_CODE_FILES]) out[f] = sha256Hex(fs.readFileSync(path.join(REPO, f)));
  return out;
}

/** club rotations at the as-of morning, from every completed start (regular season and postseason) */
export function clubRotations(teams: MlbTeam[], games: MlbInputGame[], M: ModelState): Record<string, ClubRotation> {
  const out: Record<string, ClubRotation> = {};
  const done = games.filter((g) => g.status === 'final').sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.game_no - b.game_no));
  for (const t of teams) {
    const starts: Start[] = [];
    for (const g of done) {
      const sp = g.home === t.code ? g.starters.home : g.away === t.code ? g.starters.away : null;
      if ((g.home === t.code || g.away === t.code) && sp) starts.push({ day: dayOf(g.date), game_no: g.game_no, pitcher: sp.id });
    }
    const members = rotationAt(starts, 5), ls = lastStarts(starts);
    out[t.code] = { members, last_start: members.map((p) => dateOf(ls[p])), s: members.map((p) => (M.pitchers[p] != null ? M.pitchers[p] : 0)) };
  }
  return out;
}

export interface Assemble {
  season: number; mode: 'history' | 'live'; asOf: string; config: MlbSeasonConfig; teams: MlbTeam[]; games: MlbInputGame[];
  state: ModelState; calibration: Calibration; fitAsOf: string; names: Record<string, string>; notes: string[];
}
export function assemble(x: Assemble): MlbInputData {
  const format = formatFor(x.season);
  const reg = x.games.filter((g) => g.phase === 'regular');
  const complete = reg.every((g) => g.status === 'final');
  const lastReg = reg.reduce((m, g) => (g.date > m ? g.date : m), '0000-00-00');
  const served = servedConfig();
  const gm = gameModelStudy(), rp = rotationParams();
  const per: Record<string, number> = {}; for (const g of reg) if (g.status === 'final') { per[g.home] = (per[g.home] || 0) + 1; per[g.away] = (per[g.away] || 0) + 1; }
  const avg = x.teams.reduce((a, t) => a + (per[t.code] || 0), 0) / x.teams.length;
  const { doc: st } = readJson(DATA_FILES.strength);
  const named = new Set<string>();
  for (const g of x.games) for (const s of [g.starters.home, g.starters.away]) if (s) named.add(s.id);
  const rot = clubRotations(x.teams, x.games, x.state);
  for (const c of Object.values(rot)) c.members.forEach((m) => named.add(m));
  const names: Record<string, string> = {};
  for (const id of [...named].sort()) if (x.names[id]) names[id] = x.names[id];
  const games = x.games.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.game_no - b.game_no || (a.id < b.id ? -1 : 1)));
  return {
    schema: MLB_INPUT_SCHEMA, sport: 'mlb', competition: 'MLB', season: x.season, mode: x.mode, as_of: x.asOf, config: x.config, format, teams: x.teams, games,
    regular_season_complete: complete, last_regular_date: lastReg,
    postseason_calendar: { template: x.config.postseason_calendar.value, source: 'Estimated (' + x.config.postseason_calendar.source + ')' },
    model: { model_version: 'edgedesk_mlb_lab_brain/' + served.version, served_version: served.version, served_config: served.config, config_sha256: served.config_sha256, candidate: 'team_park_sp',
      fit_as_of: x.fitAsOf, state: x.state, calibration: x.calibration,
      xi_postseason: gm.xi, xi_postseason_source: DATA_FILES.game_model + ' extra_inning_home_rate.standard_pooled (sha256 ' + gm.sha256.slice(0, 16) + ')',
      replacement_s: st.replacement_starter.s, replacement_source: DATA_FILES.strength + ' replacement_starter' },
    strength: strengthFor(avg, complete),
    rotation: { params: rp.params, clubs: rot, method: 'last five distinct starters; regular season: oldest rested; postseason: best rested of the top ' + rp.params.postseason_rotation_size + ' by s; departures and spot starts measured 2018-2023', source: DATA_FILES.rotation, source_sha256: rp.sha256 },
    pitcher_names: names, code_sha256: codeHashes(), notes: x.notes
  };
}

export function finalize(data: MlbInputData, meta: Omit<MlbSnapshot['meta'], 'built_at'>): MlbSnapshot {
  canonicalJson(data);
  return { schema: MLB_INPUT_SCHEMA, input_hash: hashCanonical(data), data, meta: { built_at: new Date().toISOString(), ...meta } };
}

/* ---------------- history (backtest and fixture) snapshots ---------------- */
export interface HistoryOptions {
  season: number; asOf: string;
  /** games before this date (and on/after asOf) carry their actual starters as Confirmed */
  confirmThrough?: string;
  /** a frozen state already replayed to this as-of morning (the research replay's capture), instead of replaying again */
  model?: { state: ModelState; calibration: Calibration };
}

export function buildMlbHistorySnapshot(opt: HistoryOptions): MlbSnapshot {
  const { season } = opt;
  const fmt = formatFor(season);
  if (fmt.id !== 'MLB-2022') throw new Error('history snapshots are built for MLB-2022 seasons (2022 onward), not ' + season);
  const asDay = dayOf(opt.asOf), confDay = opt.confirmThrough ? dayOf(opt.confirmThrough) : asDay;
  const teams = teamsFor(season);
  const reg = loadRegularSeason(season);
  const post = loadPostseason().games.filter((g) => g.season === season);
  const games: MlbInputGame[] = [];
  const ref = (id: string | null, status: StarterRef['status']): StarterRef | null => (id ? { id, status } : null);
  for (const g of reg.games) {
    const d = dayOf(g.date), done = d < asDay, conf = !done && d < confDay;
    games.push({ id: g.id, phase: 'regular', date: g.date, game_no: g.game_no, home: g.home, away: g.away, status: done ? 'final' : 'scheduled',
      home_score: done ? g.hs : null, away_score: done ? g.as : null,
      starters: { home: done ? ref(g.sp_home, 'Observed') : conf ? ref(g.sp_home, 'Confirmed') : null, away: done ? ref(g.sp_away, 'Observed') : conf ? ref(g.sp_away, 'Confirmed') : null },
      round: null, series_game: null, date_estimated: false });
  }
  for (const g of post) {
    const d = dayOf(g.date); if (d >= confDay) continue;
    const done = d < asDay;
    games.push({ id: g.home + g.date.replace(/-/g, '') + '-' + g.round + g.series_game, phase: 'postseason', date: g.date, game_no: 0, home: g.home, away: g.away,
      status: done ? 'final' : 'scheduled', home_score: done ? g.hs : null, away_score: done ? g.as : null,
      starters: { home: ref(g.sp_home, done ? 'Observed' : 'Confirmed'), away: ref(g.sp_away, done ? 'Observed' : 'Confirmed') },
      round: g.round, series_game: g.series_game, date_estimated: false });
  }
  /* the served model, replayed point-in-time to the as-of morning (regular-season games only) */
  const all: HistGame[] = []; for (let s = 2010; s <= season; s++) all.push(...loadRegularSeason(s).games);
  const lastReg = reg.games[reg.games.length - 1].date;
  const stop = Math.min(asDay, dayOf(lastReg) + 1);
  let state: ModelState, calibration: Calibration;
  if (opt.model) { state = opt.model.state; calibration = opt.model.calibration; }
  else { const r = replay(all, { params: servedConfig().config, stopAt: stop }); state = r.final as ModelState; calibration = calibrationFor(season, all, r.raw); }
  const names = JSON.parse(fs.readFileSync(path.join(REPO, 'mlb', 'history', 'data', 'pitchers.json'), 'utf8'));
  const notes = ['History replay of ' + season + ' as of the morning of ' + opt.asOf + ': completed results and starters Observed (Retrosheet), later games scheduled, future postseason dates Estimated.'];
  if (season === 2024) notes.push('The 2024 game table has no starting pitchers: every starter of 2024 is unknown and priced at the replacement level.');
  if (reg.dropped.length) notes.push('Dropped ' + reg.dropped.length + ' duplicate rows of the 2024 table (a suspended game resumed on a later date): ' + reg.dropped.join(', '));
  const data = assemble({ season, mode: 'history', asOf: opt.asOf, config: historyConfig(season), teams, games, state, calibration, fitAsOf: dateOf(stop), names, notes });
  return finalize(data, { feeds: [{ url: 'mlb/history/data/' + season + '.csv', sha256: reg.sha256, bytes: 0 }, { url: 'simulator/fixtures/mlb_postseason_2012_2025.json', sha256: loadPostseason().sha256, bytes: 0 }], offline: true, builder: 'simulator/src/sports/mlb/inputs.ts buildMlbHistorySnapshot' });
}

export function writeSnapshot(file: string, snap: MlbSnapshot): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(snap));
}
export function readSnapshot(file: string): MlbSnapshot {
  const raw = fs.readFileSync(file);
  return checkSnapshot(JSON.parse((file.endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString('utf8')) as MlbSnapshot);
}
export function checkSnapshot(snap: MlbSnapshot): MlbSnapshot {
  if (snap.schema !== MLB_INPUT_SCHEMA) throw new Error('not an MLB input snapshot: ' + snap.schema);
  const h = hashCanonical(snap.data);
  if (h !== snap.input_hash) throw new Error('snapshot content hash mismatch: the file was changed after it was built (' + h + ' != ' + snap.input_hash + ')');
  return snap;
}
