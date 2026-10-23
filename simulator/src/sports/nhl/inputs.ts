/* ===========================================================================
   THE NHL INPUT SNAPSHOT — everything a simulation reads, captured once,
   validated, frozen and hashed BEFORE the first simulated season.

   Where every number comes from:
     schedule            sportsdataverse/fastRhockey-nhl-raw season schedule
                         (the NHL's club-schedule feeds; the file
                         hockey/build_slate.js reads), every regular-season
                         game with its designated home club and start time
     completed results   hockey/data/team_games (Observed; committed, built by
                         hockey/ingest/team_games.js from the NHL game feeds):
                         final score (overtime goals and the shootout credit
                         included), 60-minute score and how the game was
                         decided (REG, OT or SO). Each is reconciled with the
                         schedule's final score.
     results not yet     a game the schedule calls final that the team-game
     ingested            table does not have yet is read from its per-game
                         file (fastRhockey-nhl-raw json/final/<id>.json:
                         gameOutcome.lastPeriodType, the final and the
                         period-by-period score). One that cannot be read
                         blocks the simulation: a played game is never
                         simulated.
     playoff state       completed playoff games (team_games type P) and the
                         playoff games on the schedule, kept as played
     game model          the served chosen model (live.json, xg_core) on the
                         ratings frozen at the as-of day: λ for every
                         remaining game (back-to-back flags from the
                         schedule) and for every possible playoff pairing
                         (no back-to-back), exactly the slate's code path
     goalies             hockey/data/confirmed_starters.json entries with a
                         source and time only (config.availability); none is
                         invented
     distribution        score effects and OT/SO parameters (live.json), the
                         60-minute draw decision
                         (simulator/data/nhl_goal_distribution.json)
     strength offsets    simulator/data/nhl_strength_uncertainty.json, σ at
                         the as-of games played

   The snapshot's `data` is canonical and content-hashed (input_hash);
   `meta` carries what does not change a result (build time, feed sizes).
   No network or database call happens after this returns.
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { REPO } from '../nfl/model_adapter.ts';
import { NHL_TEAMS_2027, NHL_2027, type NhlSeasonConfig } from './config.ts';
import { dayNum, hockeyWalkforward } from './history.ts';
import type { NhlTeam } from './rules.ts';
import type { DistParams } from './model_adapter.ts';
import { parseCsv } from '../../core/csv.ts';
import { hashCanonical, sha256Hex } from '../../core/canonical.ts';
import { sigmaAt, STRENGTH_STUDY_FILE } from '../../research/nhl_strength_uncertainty.ts';
import { GOAL_STUDY_FILE } from '../../research/nhl_goal_distribution.ts';

const require = createRequire(import.meta.url);
export const NHL_INPUT_SCHEMA = 'edgedesk_sim_nhl_inputs_v1';
const CACHE = path.join(REPO, 'simulator', '.cache', 'feeds');
export const SCHEDULE_URL = (season: number) => 'https://raw.githubusercontent.com/sportsdataverse/fastRhockey-nhl-raw/main/nhl/schedules/parquet/nhl_schedule_' + season + '.parquet';
export const GAME_JSON_URL = (id: number) => 'https://raw.githubusercontent.com/sportsdataverse/fastRhockey-nhl-raw/main/nhl/json/final/' + id + '.json';
const SCHEDULE_COLUMNS = ['game_id', 'game_type', 'game_date', 'game_time', 'home_team_abbr', 'away_team_abbr', 'home_score', 'away_score', 'game_state', 'venue', 'series_letter', 'playoff_round', 'series_game_number'];

export type Decided = 'REG' | 'OT' | 'SO';
export interface NhlInputGame {
  game_id: number; date: string; start_utc: string | null; home: string; away: string; venue: string | null; state: string | null;
  done: boolean;
  /** Observed: official final (OT goals and the shootout credit included), 60-minute score, how it was decided */
  home_score: number | null; away_score: number | null; reg_home: number | null; reg_away: number | null; decided: Decided | null;
  result_source: 'team_games' | 'game_json' | null;
  /** Research: the served model's expected regulation goals for a remaining game */
  model: null | { lam_home: number; lam_away: number; b2b_home: 0 | 1; b2b_away: 0 | 1; variant: string; goalies: null | { home: number | null; away: number | null; source: string; recorded_at: string } };
}
export interface NhlPlayoffGame { game_id: number; date: string; home: string; away: string; done: boolean; home_score: number | null; away_score: number | null; decided: Decided | null; series_letter: string | null; round: number | null; game: number | null }
export interface NhlInputData {
  schema: string;
  sport: 'nhl'; competition: 'NHL'; season: number; season_label: string;
  config: NhlSeasonConfig;
  teams: NhlTeam[];
  games: NhlInputGame[];
  playoffs: NhlPlayoffGame[];
  as_of: { last_result_date: string | null; ratings_through: string | null; ratings_day: string; completed_games: number; mean_games_played: number };
  model: { model_version: string; chosen: string; params_generated_at: string; glm_train_seasons: number[]; pair_calibration: unknown; ratings_params: unknown; dist: DistParams; pricing: string };
  /** λ for every possible playoff game, home code -> away code -> [λ home, λ away] */
  postseason_pairs: Record<string, Record<string, [number, number]>>;
  strength: { distribution: 'normal'; scale: 'log goal rate, split half to each side'; sigma: number; sigma_ci95: [number, number]; at_games_played: number; checkpoint: string; method: string; source: string; source_sha256: string };
  goal_distribution: { draw_inflation: number; adopted: boolean; source: string; source_sha256: string; tie_bias: Record<string, number | null>; reading: string };
  reconciliation: { compared: number; mismatches: string[]; lagging: Array<{ game_id: number; status: 'RESOLVED' | 'UNRESOLVED'; detail: string }> };
  code_sha256: Record<string, string>;
}
export interface NhlSnapshot {
  schema: string;
  input_hash: string;
  data: NhlInputData;
  meta: { built_at: string; feeds: Array<{ url: string; sha256: string; bytes: number }>; offline: boolean; builder: string };
}

type Feeds = Array<{ url: string; sha256: string; bytes: number }>;
/** a cached download with bounded retries (transient network errors only); the bytes' sha256 is recorded */
async function fetchBytes(url: string, offline: boolean, feeds: Feeds): Promise<Buffer> {
  const key = path.join(CACHE, url.replace(/[^a-z0-9.]+/gi, '_').slice(-140));
  let buf: Buffer;
  if (offline) {
    if (!fs.existsSync(key)) throw new Error('offline and not cached: ' + url);
    buf = fs.readFileSync(key);
  } else {
    let last: unknown = null;
    buf = Buffer.alloc(0);
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await fetch(url, { redirect: 'follow' });
        if (r.status === 404) throw Object.assign(new Error('HTTP 404 ' + url), { permanent: true });
        if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
        buf = Buffer.from(await r.arrayBuffer()); last = null; break;
      } catch (e) {
        last = e;
        if ((e as any).permanent) break;
        await new Promise((res) => setTimeout(res, 1000 * Math.pow(2, attempt)));
      }
    }
    if (last) throw last;
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(key, buf);
  }
  feeds.push({ url, sha256: sha256Hex(buf), bytes: buf.length });
  return buf;
}

/** the parquet's requested columns as rows (hockey/tools/parquet_select.py, pyarrow) */
function parquetRows(buf: Buffer, columns: string[]): Array<Record<string, string | null>> {
  fs.mkdirSync(CACHE, { recursive: true });
  const tmp = path.join(CACHE, 'tmp_' + sha256Hex(buf).slice(0, 16) + '.parquet');
  fs.writeFileSync(tmp, buf);
  const r = spawnSync('python3', [path.join(REPO, 'hockey', 'tools', 'parquet_select.py'), tmp, '-', columns.join(',')], { maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('could not read the schedule parquet (python3 + pyarrow needed): ' + String(r.stderr || '').slice(0, 300));
  return parseCsv(r.stdout.toString('utf8'));
}

const CODE_FILES = ['hockey/model/distribution.js', 'hockey/model/ratings.js', 'hockey/model/glm.js', 'hockey/model/walkforward.js', 'hockey/ingest/team_games.js',
  'hockey/model/params/live.json', 'hockey/model/params/tuning.json', 'hockey/data/teams.json', 'simulator/data/nhl_strength_uncertainty.json', 'simulator/data/nhl_goal_distribution.json'];
export function codeHashes(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of CODE_FILES) out[f] = sha256Hex(fs.readFileSync(path.join(REPO, f)));
  return out;
}

export interface BuildOptions {
  offline?: boolean;
  season?: number;
  /** tests and replays: use these schedule rows instead of the feed */
  scheduleRows?: Array<Record<string, string | null>>;
  /** tests and replays: only completed games on dates before this are results (an as-of in the past) */
  asOf?: string;
}

export async function buildNhlSnapshot(opt: BuildOptions = {}): Promise<NhlSnapshot> {
  const cfg = NHL_2027;
  const season = opt.season || cfg.season;
  if (season !== cfg.season) throw new Error('no NHL season config for ' + season);
  const offline = !!opt.offline;
  const feeds: Feeds = [];
  const W = hockeyWalkforward();
  const GLM = require(path.join(REPO, 'hockey', 'model', 'glm.js'));
  const live = require(path.join(REPO, 'hockey', 'model', 'params', 'live.json'));
  if (live.for_season !== season) throw new Error('hockey/model/params/live.json is for season ' + live.for_season + ', not ' + season);
  const teams = NHL_TEAMS_2027;
  const codes = new Set(teams.map((t) => t.code));

  /* 1 schedule */
  const rows = opt.scheduleRows || parquetRows(await fetchBytes(SCHEDULE_URL(season), offline, feeds), SCHEDULE_COLUMNS);
  const sched = rows.map((r) => ({
    game_id: Number(r.game_id), type: String(r.game_type || ''), date: String(r.game_date || ''), start_utc: r.game_time || null,
    home: String(r.home_team_abbr || ''), away: String(r.away_team_abbr || ''), venue: r.venue || null, state: r.game_state || null,
    home_score: r.home_score == null ? null : Number(r.home_score), away_score: r.away_score == null ? null : Number(r.away_score),
    series_letter: r.series_letter || null, round: r.playoff_round == null ? null : Number(r.playoff_round), game: r.series_game_number == null ? null : Number(r.series_game_number)
  })).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || String(a.start_utc).localeCompare(String(b.start_utc)) || a.game_id - b.game_id);
  const final = (s: string | null) => /^(FINAL|OFF)$/.test(String(s || ''));
  const asOf = opt.asOf || null;
  const isDone = (x: { date: string; state: string | null }) => final(x.state) && (!asOf || x.date < asOf);

  /* 2 completed results: the team-game table, reconciled with the schedule */
  const seasons: number[] = []; for (let s = 2011; s <= season; s++) seasons.push(s);
  const { rows: tgRows, games: allGames } = W.loadGames(seasons);
  const cur = allGames.filter((g: any) => g.season === season && (!asOf || g.date < asOf));
  const tg = new Map<number, any>(cur.map((g: any) => [g.game_id, g]));
  const mismatches: string[] = [];
  const lagging: NhlInputData['reconciliation']['lagging'] = [];
  const games: NhlInputGame[] = [];
  const playoffs: NhlPlayoffGame[] = [];
  let compared = 0;
  for (const x of sched) {
    if (x.type !== 'R' && x.type !== 'P') continue;
    if (!codes.has(x.home) || !codes.has(x.away)) { mismatches.push(x.game_id + ': club not in the 2026-27 alignment (' + x.home + '-' + x.away + ')'); continue; }
    const t = tg.get(x.game_id);
    let res: Pick<NhlInputGame, 'home_score' | 'away_score' | 'reg_home' | 'reg_away' | 'decided' | 'result_source'> = { home_score: null, away_score: null, reg_home: null, reg_away: null, decided: null, result_source: null };
    if (t) {
      if (t.home !== x.home || t.away !== x.away) mismatches.push(x.game_id + ': team-game clubs ' + t.home + '-' + t.away + ' vs schedule ' + x.home + '-' + x.away);
      if (!final(x.state)) mismatches.push(x.game_id + ': in the team-game table but the schedule state is ' + x.state);
      else if (x.home_score !== t.final_home || x.away_score !== t.final_away) mismatches.push(x.game_id + ': final ' + t.final_home + '-' + t.final_away + ' vs schedule ' + x.home_score + '-' + x.away_score);
      compared++;
      res = { home_score: t.final_home, away_score: t.final_away, reg_home: t.reg_home, reg_away: t.reg_away, decided: t.decided, result_source: 'team_games' };
    } else if (isDone(x)) {
      /* final on the schedule, not yet in the team-game table: its own game file */
      try {
        const j = JSON.parse((await fetchBytes(GAME_JSON_URL(x.game_id), offline, feeds)).toString('utf8'));
        const gi = (j.game_info || [])[0] || {}, box = j.boxscore_raw || {}, ls = j.linescore || {};
        const decided = box.gameOutcome && box.gameOutcome.lastPeriodType;
        const per = (ls.byPeriod || []).filter((p: any) => p.periodDescriptor && p.periodDescriptor.periodType === 'REG');
        const rh = per.reduce((a: number, p: any) => a + Number(p.home), 0), ra = per.reduce((a: number, p: any) => a + Number(p.away), 0);
        const ok = (decided === 'REG' || decided === 'OT' || decided === 'SO') && gi.home_team_abbr === x.home && gi.away_team_abbr === x.away
          && Number(gi.home_score) === x.home_score && Number(gi.away_score) === x.away_score && per.length === 3
          && (decided === 'REG' ? rh !== ra : rh === ra && Math.abs(x.home_score! - x.away_score!) === 1);
        if (!ok) throw new Error('game file disagrees with the schedule or is incomplete (' + decided + ', ' + gi.home_score + '-' + gi.away_score + ', 60-min ' + rh + '-' + ra + ')');
        res = { home_score: x.home_score, away_score: x.away_score, reg_home: rh, reg_away: ra, decided, result_source: 'game_json' };
        lagging.push({ game_id: x.game_id, status: 'RESOLVED', detail: x.date + ' ' + x.away + '@' + x.home + ' ' + x.away_score + '-' + x.home_score + ' ' + decided + ' (game file)' });
      } catch (e) {
        lagging.push({ game_id: x.game_id, status: 'UNRESOLVED', detail: x.date + ' ' + x.away + '@' + x.home + ': ' + String((e as Error).message).slice(0, 200) });
      }
    }
    const done = res.decided != null;
    if (x.type === 'P') {
      playoffs.push({ game_id: x.game_id, date: x.date, home: x.home, away: x.away, done, home_score: res.home_score, away_score: res.away_score, decided: res.decided, series_letter: x.series_letter, round: x.round, game: x.game });
      continue;
    }
    games.push({ game_id: x.game_id, date: x.date, start_utc: x.start_utc, home: x.home, away: x.away, venue: x.venue, state: x.state, done, ...res, model: null });
  }
  /* completed playoff games the schedule does not list */
  for (const t of cur) if (t.type === 'P' && !playoffs.some((p) => p.game_id === t.game_id)) {
    playoffs.push({ game_id: t.game_id, date: t.date, home: t.home, away: t.away, done: true, home_score: t.final_home, away_score: t.final_away, decided: t.decided, series_letter: null, round: null, game: null });
  }
  for (const t of cur) if (t.type === 'R' && !games.some((g) => g.game_id === t.game_id)) mismatches.push(t.game_id + ': completed in the team-game table, not on the schedule');

  /* 3 the served model on ratings frozen at the as-of day */
  const P = W.seasonParams(tgRows, seasons, false);
  const histGames = allGames.filter((g: any) => !asOf || g.date < asOf);
  const { state: rs } = W.ratingsPass(histGames, P, live.ratings, null);
  const done = games.filter((g) => g.done), open = games.filter((g) => !g.done);
  const ratingsThrough = histGames.length ? histGames[histGames.length - 1].date : null;
  const ratingsDay = open.length ? open[0].date : (asOf || games[games.length - 1].date);
  const datesOf = new Map<string, number[]>();
  for (const g of games) for (const t of [g.home, g.away]) { if (!datesOf.has(t)) datesOf.set(t, []); datesOf.get(t)!.push(dayNum(g.date)); }
  const b2b = (team: string, d: number): 0 | 1 => { let best: number | null = null; for (const x of datesOf.get(team) || []) if (x < d) best = x; return best != null && d - best === 1 ? 1 : 0; };
  const chosen = live.model, fit = live.glm[chosen], cal = live.pair_calibration[chosen];
  const confirmed = (() => { try { return JSON.parse(fs.readFileSync(path.join(REPO, 'hockey', 'data', 'confirmed_starters.json'), 'utf8')).starters || {}; } catch (_) { return {}; } })();
  const price = (home: string, away: string, bh: 0 | 1, ba: 0 | 1, goalies: { home: number | null; away: number | null } | null) => {
    const fh = rs.snapshot(home, away, true, ratingsDay, null), fa = rs.snapshot(away, home, false, ratingsDay, null);
    fh.b2b = bh; fh.b2b_opp = ba; fa.b2b = ba; fa.b2b_opp = bh;
    if (goalies) {
      const day = dayNum(ratingsDay);
      if (goalies.away != null) fh.opp_goalie_act = rs.goalieRating(goalies.away, day).rate;
      if (goalies.home != null) fa.opp_goalie_act = rs.goalieRating(goalies.home, day).rate;
      const v = live.confirmed_variant;
      const c = GLM.applyPairCalibration(GLM.predict(live.glm[v], fh), GLM.predict(live.glm[v], fa), live.pair_calibration[v]);
      return { lh: c.lh, la: c.la, variant: v };
    }
    const c = GLM.applyPairCalibration(GLM.predict(fit, fh), GLM.predict(fit, fa), cal);
    return { lh: c.lh, la: c.la, variant: chosen };
  };
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
  for (const g of open) {
    const d = dayNum(g.date), bh = b2b(g.home, d), ba = b2b(g.away, d);
    const c = confirmed[String(g.game_id)];
    const goalies = c && (c.home != null || c.away != null) && c.source && c.recorded_at && (!g.start_utc || Date.parse(c.recorded_at) < Date.parse(g.start_utc))
      ? { home: c.home ?? null, away: c.away ?? null, source: String(c.source), recorded_at: String(c.recorded_at) } : null;
    const p = price(g.home, g.away, bh, ba, goalies);
    g.model = { lam_home: r6(p.lh), lam_away: r6(p.la), b2b_home: bh, b2b_away: ba, variant: p.variant, goalies };
  }
  const pairs: NhlInputData['postseason_pairs'] = {};
  for (const h of teams) { pairs[h.code] = {}; for (const a of teams) if (a.code !== h.code) { const p = price(h.code, a.code, 0, 0, null); pairs[h.code][a.code] = [r6(p.lh), r6(p.la)]; } }

  /* 4 the distribution, the draw decision, the strength sigma */
  const goal = JSON.parse(fs.readFileSync(GOAL_STUDY_FILE, 'utf8'));
  const strength = JSON.parse(fs.readFileSync(STRENGTH_STUDY_FILE, 'utf8'));
  if (strength.model.live_params_sha256 !== sha256Hex(fs.readFileSync(path.join(REPO, 'hockey', 'model', 'params', 'live.json')))) throw new Error('the strength study was calibrated on another hockey/model/params/live.json: re-run simulator/src/research/nhl_strength_uncertainty.ts');
  const meanGp = (2 * done.length) / teams.length;
  const sg = sigmaAt(strength, meanGp);
  const lastResult = done.length ? done.reduce((a, g) => (g.date > a ? g.date : a), done[0].date) : null;
  const data: NhlInputData = {
    schema: NHL_INPUT_SCHEMA, sport: 'nhl', competition: 'NHL', season, season_label: cfg.season_label,
    config: cfg, teams, games, playoffs,
    as_of: { last_result_date: lastResult, ratings_through: ratingsThrough, ratings_day: ratingsDay, completed_games: done.length, mean_games_played: Math.round(meanGp * 1000) / 1000 },
    model: { model_version: 'edgedesk_nhl_v1:' + chosen, chosen, params_generated_at: live.generated_at, glm_train_seasons: live.glm_train_seasons, pair_calibration: cal, ratings_params: live.ratings,
      dist: { effects: live.effects, ot: { format: live.ot.format, k: live.ot.k, so_home: live.ot.so_home }, draw_inflation: goal.decision.production_draw_inflation },
      pricing: 'ratings frozen at ratings_day for every remaining game (the strength study\'s chosen variant: ' + strength.pricing_variant.chosen + '); back-to-back flags from the schedule; playoff pairs without back-to-back' },
    postseason_pairs: pairs,
    strength: { distribution: 'normal', scale: 'log goal rate, split half to each side', sigma: sg.sigma, sigma_ci95: sg.ci95, at_games_played: Math.round(meanGp * 1000) / 1000, checkpoint: sg.checkpoint,
      method: strength.method, source: 'simulator/data/nhl_strength_uncertainty.json', source_sha256: sha256Hex(fs.readFileSync(STRENGTH_STUDY_FILE)) },
    goal_distribution: { draw_inflation: goal.decision.production_draw_inflation, adopted: goal.decision.adopted, source: 'simulator/data/nhl_goal_distribution.json', source_sha256: sha256Hex(fs.readFileSync(GOAL_STUDY_FILE)),
      tie_bias: { selection: goal.windows.selection.served.tie.bias, confirmation: goal.windows.confirmation.served.tie.bias, live: goal.windows.live.served.tie.bias }, reading: goal.decision.reading },
    reconciliation: { compared, mismatches, lagging },
    code_sha256: codeHashes()
  };
  return { schema: NHL_INPUT_SCHEMA, input_hash: hashCanonical(data), data, meta: { built_at: new Date().toISOString(), feeds, offline, builder: 'simulator/src/sports/nhl/inputs.ts' } };
}

export function writeNhlSnapshot(file: string, snap: NhlSnapshot): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(snap);
  fs.writeFileSync(file, file.endsWith('.gz') ? zlib.gzipSync(text, { level: 9 }) : text);
}
export function readNhlSnapshot(file: string): NhlSnapshot {
  const buf = fs.readFileSync(file);
  const snap = JSON.parse((file.endsWith('.gz') ? zlib.gunzipSync(buf) : buf).toString('utf8')) as NhlSnapshot;
  if (snap.schema !== NHL_INPUT_SCHEMA) throw new Error('not an NHL input snapshot: ' + snap.schema);
  const h = hashCanonical(snap.data);
  if (h !== snap.input_hash) throw new Error('snapshot content hash mismatch: the file was changed after it was built (' + h + ' != ' + snap.input_hash + ')');
  return snap;
}
