/* ===========================================================================
   THE NBA INPUT SNAPSHOT — everything a simulation reads, captured once,
   validated, frozen and hashed BEFORE the first simulated season.

   Where every number comes from:
     schedule, results    nba/data/games/<season>.csv (sportsdataverse/hoopR,
                          ESPN; Observed): the regular season (scope
                          regular_season — every NBA Cup game but the final),
                          dates, venues, neutral sites; completed play-in and
                          playoff games, kept exactly
     game model           the served projected-track model (model_adapter.ts):
                          the point-in-time pass run to the as-of time, every
                          remaining regular-season game priced from its own
                          schedule row (rest, back-to-back, travel, time zone,
                          altitude, home court) and the projected rotation
     postseason           a play-in or playoff game already on the schedule:
                          its real row; every other pairing the format can
                          produce: a schedule-shaped row with the Estimated
                          context of its round and game number
                          (postseason_context.ts), priced on the same pass
     availability         the tracked absences at the as-of time and their
                          return distributions (availability.ts), with the
                          served player model's value of each subset returning
     strength offsets     simulator/data/nba_strength_uncertainty.json, the
                          as-of point's calibrated sigma
   The snapshot's `data` is canonical and content-hashed (input_hash); `meta`
   carries what does not change a result. No network or database call
   happens after this returns.
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO, NBA_CODE_FILES, nbaModules, liveParams, seasonParams, priceRow, frozenPass, type SeasonParams } from './model_adapter.ts';
import { NBA_TEAMS, NBA_2026_27, type NbaSeasonConfig } from './config.ts';
import { rulesFor, type NbaTeam, type Round } from './rules.ts';
import { estimateContexts, contextKeys, contextKey, type ContextTable } from './postseason_context.ts';
import { AppearanceScan, teamGameLog, estimateHazards, returnDistribution, type HazardTable } from './availability.ts';
import { subsetTable, MAX_TRACKED } from '../../research/nba_frozen_forecasts.ts';
import { hazardSeasons } from '../../research/nba_return_hazards.ts';
import { hashCanonical, sha256Hex } from '../../core/canonical.ts';
import type { ReturnDistribution } from '../../core/hooks.ts';

const require = createRequire(import.meta.url);
export const NBA_INPUT_SCHEMA = 'edgedesk_sim_nba_inputs_v1';
export const UNC_FILE = path.join(REPO, 'simulator', 'data', 'nba_strength_uncertainty.json');
export const HAZARD_FILE = path.join(REPO, 'simulator', 'data', 'nba_return_hazards.json');
/** postseasons the Estimated contexts are taken from (the play-in era, its first compressed season excluded) */
export const CONTEXT_SEASONS = [2022, 2023, 2024, 2025, 2026];
/** a club can play at most 2 play-in games and 4 series of 7 */
export const MAX_POSTSEASON_GAMES = 30;

/** a priced game: the chosen model's regulation-margin mean, its pace and the two availability slopes */
export interface GameModel { mu: number; pace: number; s_plr: number; s_adj: number }
export interface NbaInputGame {
  game_id: string; date: string; start_utc: string; home: string; away: string; neutral: boolean; city: string | null;
  done: boolean; home_score: number | null; away_score: number | null;
  model: GameModel | null;
}
export interface NbaPostseasonRow extends NbaInputGame { stage: 'play_in' | 'playoffs' }
export interface TrackedAbsence { player_id: string; name: string | null; games_missed: number; carried: boolean; expected_minutes: number; dist: ReturnDistribution }
export interface NbaInputData {
  schema: string;
  sport: 'nba'; competition: 'NBA'; season: number; season_label: string;
  config: NbaSeasonConfig;
  rules_version: string;
  teams: NbaTeam[];
  as_of: string;
  /** the average club's completed regular-season games at the as-of time */
  as_of_games: number;
  games: NbaInputGame[];
  postseason_rows: NbaPostseasonRow[];
  model: { model_version: string; chosen: string; params_source: string; trained_through: number; calibration: { sd_m: any }; shape: any; ot: any; record_spec_hash: string | null };
  /** contextKey -> home code -> away code -> model */
  postseason_pairs: Record<string, Record<string, Record<string, GameModel>>>;
  postseason_context: ContextTable;
  strength: { distribution: 'normal'; sigma_points: number; sigma_ci95: [number, number]; as_of_games: number; method: string; source: string; source_sha256: string } | null;
  availability: { mode: 'off' | 'return_hazards'; hazards: HazardTable | null; teams: Record<string, { projected: string[]; tracked: TrackedAbsence[]; untracked: number; subsets: { net: number[]; full: number[] } }> };
  integrity: { box_mismatch: number | null; final_mismatch: number | null; stale_scheduled: string[]; placeholder_postseason: string[]; source: string };
  code_sha256: Record<string, string>;
}
export interface NbaSnapshot { schema: string; input_hash: string; data: NbaInputData; meta: { built_at: string; builder: string; pass_seconds: number; params: string } }

export function codeHashes(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of NBA_CODE_FILES) out[f] = sha256Hex(fs.readFileSync(path.join(REPO, f)));
  if (fs.existsSync(UNC_FILE)) out['simulator/data/nba_strength_uncertainty.json'] = sha256Hex(fs.readFileSync(UNC_FILE));
  if (fs.existsSync(HAZARD_FILE)) out['simulator/data/nba_return_hazards.json'] = sha256Hex(fs.readFileSync(HAZARD_FILE));
  return out;
}

/** the calibrated sigma for an as-of point (linear between calibrated points, flat beyond) */
export function sigmaFor(asOfGames: number): NbaInputData['strength'] {
  if (!fs.existsSync(UNC_FILE)) return null;
  const text = fs.readFileSync(UNC_FILE, 'utf8'), unc = JSON.parse(text);
  const pts = (unc.by_as_of as any[]).filter((b) => b.win_total_calibration).sort((a, b) => a.as_of_games - b.as_of_games);
  if (!pts.length) return null;
  /* flat outside the calibrated points, linear between the two that bracket the as-of point */
  let lo = asOfGames <= pts[0].as_of_games ? pts[0] : pts[pts.length - 1], hi = lo;
  for (let i = 0; i + 1 < pts.length; i++) if (asOfGames > pts[i].as_of_games && asOfGames < pts[i + 1].as_of_games) { lo = pts[i]; hi = pts[i + 1]; }
  const exact = pts.find((p) => p.as_of_games === asOfGames); if (exact) { lo = exact; hi = exact; }
  const w = hi.as_of_games === lo.as_of_games ? 0 : Math.min(1, Math.max(0, (asOfGames - lo.as_of_games) / (hi.as_of_games - lo.as_of_games)));
  const lerp = (a: number, b: number) => a + w * (b - a);
  const L = lo.win_total_calibration, H = hi.win_total_calibration;
  return { distribution: 'normal', sigma_points: lerp(L.sigma, H.sigma), sigma_ci95: [lerp(L.sigma_ci95[0], H.sigma_ci95[0]), lerp(L.sigma_ci95[1], H.sigma_ci95[1])], as_of_games: asOfGames,
    method: 'win-total calibration, ' + (hi.as_of_games !== lo.as_of_games ? 'linear between the as-of points ' + lo.as_of_games + ' and ' + hi.as_of_games : 'the as-of point ' + lo.as_of_games + (asOfGames !== lo.as_of_games ? ' (the nearest calibrated point; flat outside 1-61 games)' : '')) + ', return trajectories ON', source: 'simulator/data/nba_strength_uncertainty.json', source_sha256: sha256Hex(text) };
}

export interface BuildOptions {
  config?: NbaSeasonConfig;
  /** the end-year season (default the config's) */
  season?: number;
  /** the as-of time: games that started at or after it are treated as unplayed (default: now, no freeze) */
  asOf?: string | null;
  log?: (s: string) => void;
}

export async function buildNbaSnapshot(opt: BuildOptions = {}): Promise<NbaSnapshot> {
  const cfg = opt.config || NBA_2026_27;
  const S = opt.season || cfg.season;
  const log = opt.log || (() => {});
  const { D, WF, C } = nbaModules();
  const VEN = require(path.join(REPO, 'nba', 'lib', 'venues.js'));
  const rules = rulesFor(S);
  const freezeAt = opt.asOf ? Date.parse(opt.asOf) : null;
  const nowMs = freezeAt != null ? freezeAt : Date.now();
  const teams = NBA_TEAMS;
  const byId: Record<string, NbaTeam> = {}; teams.forEach((t) => { byId[t.id] = t; });
  const isDone = (g: any) => g.status === 'FINAL' && (freezeAt == null || g.start_ms < freezeAt);

  /* 1 the schedule */
  const raw = D.games([S]);
  const reg = raw.filter((g: any) => g.type === 'R' && g.scope === 'regular_season');
  const known = (g: any) => !!byId[String(g.home_id)] && !!byId[String(g.away_id)];
  /* a postseason game on the schedule before its pairing is set carries placeholder clubs: skipped (counted), never guessed */
  const postAll = raw.filter((g: any) => g.type === 'I' || g.type === 'P').sort((a: any, b: any) => a.start_ms - b.start_ms);
  const placeholders = postAll.filter((g: any) => g.status === 'SCHEDULED' && !isDone(g) && !known(g)).map((g: any) => String(g.game_id));
  const post = postAll.filter((g: any) => !placeholders.includes(String(g.game_id)));
  for (const g of reg.concat(post)) if (!known(g)) throw new Error('unknown club in game ' + g.game_id);
  const homeCity: Record<string, string> = {};
  { const cnt: Record<string, Record<string, number>> = {};
    for (const g of reg) if (!g.neutral && g.city) { const m = (cnt[g.home_id] = cnt[g.home_id] || {}); m[g.city] = (m[g.city] || 0) + 1; }
    for (const t of teams) { const m = cnt[t.id] || {}; const c = Object.keys(m).sort((a, b) => m[b] - m[a])[0]; if (!c || !VEN.geo(c)) throw new Error('no home arena city for ' + t.code); homeCity[t.id] = c; } }
  const doneReg = reg.filter(isDone);
  const asOfGames = Math.round((2 * doneReg.length / teams.length) * 100) / 100;
  const stale = reg.concat(post).filter((g: any) => !isDone(g) && g.status === 'SCHEDULED' && g.start_ms < nowMs - 6 * 3600e3).map((g: any) => g.game_id);

  /* 2 the Estimated postseason contexts and the schedule-shaped rows for every pairing */
  const ctx = estimateContexts(D, teams, CONTEXT_SEASONS);
  const lastRegDay = Math.max(...reg.map((g: any) => Date.parse(g.date + 'T00:00:00Z')));
  const extraGames: any[] = [], extraTg: any[] = [];
  const minDay = Math.ceil((nowMs + 864e5) / 864e5) * 864e5;
  const synId = (k: string, h: string, a: string) => 'sim|' + k + '|' + h + '|' + a;
  const hostsK = (round: Round, n: number) => (round === 'play_in' ? true : rules.home_games[round as Exclude<Round, 'play_in'>].includes(n));
  for (const ck of contextKeys()) {
    const k = contextKey(ck.round, ck.key, ck.game_no), cell = ctx.cells[k];
    const day = Math.max(lastRegDay + cell.day_offset * 864e5, minDay);
    const date = new Date(day).toISOString().slice(0, 10), start = date + 'T23:00:00Z', startMs = Date.parse(start);
    /* the previous game's arena: games 2-7 follow the home pattern; an opener (and a play-in game) is reached from home */
    const prevSameHost = ck.round !== 'play_in' && ck.game_no >= 2 ? hostsK(ck.round, ck.game_no - 1) === hostsK(ck.round, ck.game_no) : null;
    for (const h of teams) for (const a of teams) {
      if (h.id === a.id) continue;
      if ((ck.round === 'finals') !== (h.conference !== a.conference)) continue;
      const id = synId(k, h.id, a.id);
      const here = VEN.geo(homeCity[h.id]);
      extraGames.push({ game_id: id, season: S, type: ck.round === 'play_in' ? 'I' : 'P', date, start_utc: start, start_ms: startMs, avail_ms: startMs + 4 * 3600e3, neutral: 0, bubble: 0,
        home_id: h.id, away_id: a.id, hs: null, as: null, ot: null, status: 'SCHEDULED', scope: ck.round === 'play_in' ? 'play_in' : 'playoffs', city: homeCity[h.id], reg_h: null, reg_a: null });
      for (const [side, t, sc] of [['h', h, cell.home], ['a', a, cell.away]] as Array<[string, NbaTeam, any]>) {
        const prevCity = prevSameHost == null ? homeCity[t.id] : prevSameHost ? homeCity[h.id] : homeCity[a.id];
        const prev = VEN.geo(prevCity);
        extraTg.push({ game_id: id, season: S, date, start_utc: start, team_id: t.id, opp_id: side === 'h' ? a.id : h.id, home: side === 'h' ? 1 : 0, neutral: 0, city: homeCity[h.id],
          travel_km: Math.round(VEN.km(prev, here)), tz_shift: here.tz - prev.tz, alt: here.alt, rest_days: sc.rest_days, b2b: 0, games_7d: sc.games_7d,
          road_streak: side === 'a' ? sc.road_streak : 0, home_streak: side === 'h' ? sc.home_streak : 0, assumed_available_at: new Date(startMs + 4 * 3600e3).toISOString() });
      }
    }
  }

  /* 3 the served pass to the as-of time, the pricing parameters */
  const tuning = JSON.parse(fs.readFileSync(WF.TUNING, 'utf8'));
  let sp: SeasonParams;
  if (S === cfg.season && freezeAt == null) sp = liveParams();
  else { log('rebuilding season ' + S + ' parameters out of sample'); sp = seasonParams(await WF.buildRows(tuning), S, tuning); }
  if (sp.season !== S) throw new Error('the pricing parameters are for season ' + sp.season + ', the snapshot is ' + S);
  D.requireWork(D.seasonList(C.FIRST_SEASON, S), 'nba simulator');
  const t0 = Date.now();
  log('running the served pass to ' + new Date(nowMs).toISOString() + ' (' + extraGames.length + ' schedule-shaped postseason rows)');
  const pass = await frozenPass({ tuning, freezeAt, upTo: S, now: nowMs, extraGames, extraTeamGames: extraTg });
  const passSeconds = (Date.now() - t0) / 1000;
  const rowById = new Map<string, any>(); for (const r of pass.rows) if (r.season === S) rowById.set(String(r.id), r);
  const price = (id: string): GameModel => {
    const row = rowById.get(id); if (!row) throw new Error('the pass produced no row for ' + id);
    const p = priceRow(sp, row); if (!p || !Number.isFinite(p.mu_m)) throw new Error('the served model did not price ' + id);
    const p1 = priceRow(sp, row, { plr_m_proj: row.f.plr_m_proj + 1 }), p2 = priceRow(sp, row, { adj_proj: row.f.adj_proj + 1 });
    return { mu: p.mu_m, pace: row.f.pace, s_plr: p1.mu_m - p.mu_m, s_adj: p2.mu_m - p.mu_m };
  };
  const gameOf = (g: any): NbaInputGame => {
    const done = isDone(g);
    return { game_id: String(g.game_id), date: g.date, start_utc: g.start_utc, home: byId[String(g.home_id)].code, away: byId[String(g.away_id)].code, neutral: !!g.neutral, city: g.city || null,
      done, home_score: done ? g.hs : null, away_score: done ? g.as : null, model: done ? null : price(String(g.game_id)) };
  };
  const games = reg.map(gameOf);
  const postseason_rows: NbaPostseasonRow[] = post.filter((g: any) => isDone(g) || g.status === 'SCHEDULED').map((g: any) => Object.assign(gameOf(g), { stage: (g.type === 'I' ? 'play_in' : 'playoffs') as 'play_in' | 'playoffs' }));
  const pairs: NbaInputData['postseason_pairs'] = {};
  for (const ck of contextKeys()) {
    const k = contextKey(ck.round, ck.key, ck.game_no); const tab: Record<string, Record<string, GameModel>> = (pairs[k] = {});
    for (const h of teams) for (const a of teams) {
      if (h.id === a.id || (ck.round === 'finals') !== (h.conference !== a.conference)) continue;
      (tab[h.code] = tab[h.code] || {})[a.code] = price(synId(k, h.id, a.id));
    }
  }

  /* 4 availability: tracked absences and their return distributions */
  const pm = pass.states.pm;
  const avail: NbaInputData['availability'] = { mode: cfg.availability.mode, hazards: null, teams: {} };
  const players = D.playersMap();
  if (cfg.availability.mode === 'return_hazards') {
    /* the live season reads the committed production table (simulator/data/nba_return_hazards.json, every completed
       season); a historical replay re-estimates on the seasons before it, so it stays out of sample */
    let H: HazardTable;
    if (S === cfg.season && freezeAt == null) {
      if (!fs.existsSync(HAZARD_FILE)) throw new Error('no return-hazard table: run node simulator/src/research/nba_return_hazards.ts');
      H = JSON.parse(fs.readFileSync(HAZARD_FILE, 'utf8')).production as HazardTable;
      if (Math.max(...H.estimation_seasons) >= S) throw new Error('the return-hazard table was fitted on season ' + Math.max(...H.estimation_seasons) + ', not before ' + S);
    } else H = estimateHazards(D, hazardSeasons(S));
    avail.hazards = H;
    const scan = new AppearanceScan();
    for (const tg of teamGameLog(D, [S - 1, S], freezeAt == null ? undefined : freezeAt)) scan.add(tg);
    const remaining: Record<string, number> = {}; for (const g of games) if (!g.done) { remaining[g.home] = (remaining[g.home] || 0) + 1; remaining[g.away] = (remaining[g.away] || 0) + 1; }
    for (const t of teams) {
      const proj: string[] = pm.lastGamePlayers(t.id) || [], regs: string[] = pm.regulars(t.id);
      const abs = scan.absent(t.id, S).filter((a) => !proj.includes(a.p));
      const tracked = abs.slice(0, MAX_TRACKED);
      const horizon = (remaining[t.code] || 0) + MAX_POSTSEASON_GAMES;
      avail.teams[t.code] = { projected: proj.slice().sort(), untracked: abs.length - tracked.length,
        tracked: tracked.map((a) => ({ player_id: a.p, name: (players[a.p] || {}).name || null, games_missed: a.k, carried: a.carried, expected_minutes: Math.round(a.exp_min * 1e4) / 1e4,
          dist: returnDistribution(H, { k: a.k, carried: a.carried, exp_min: a.exp_min }, horizon, 'empirical return hazards, seasons ' + H.estimation_seasons[0] + '-' + H.estimation_seasons[H.estimation_seasons.length - 1] + ' (simulator/src/sports/nba/availability.ts)') })),
        subsets: subsetTable(pm, proj, regs, tracked.map((a) => a.p)) };
    }
  } else for (const t of teams) avail.teams[t.code] = { projected: (pm.lastGamePlayers(t.id) || []).slice().sort(), tracked: [], untracked: 0, subsets: { net: [pm.strength(pm.lastGamePlayers(t.id) || []).net], full: [pm.strength(pm.regulars(t.id)).net] } };

  /* 5 integrity of the season's results (nba/data/manifest.json, written by the ingest) */
  const man = JSON.parse(fs.readFileSync(path.join(REPO, 'nba', 'data', 'manifest.json'), 'utf8'));
  const ms = man.seasons && man.seasons[String(S)];
  const integ = ms && ms.integrity ? ms.integrity : null;
  const live = JSON.parse(fs.readFileSync(WF.LIVE, 'utf8'));
  const data: NbaInputData = {
    schema: NBA_INPUT_SCHEMA, sport: 'nba', competition: 'NBA', season: S, season_label: (S - 1) + '-' + String(S).slice(2),
    config: cfg, rules_version: rules.id, teams, as_of: new Date(nowMs).toISOString(), as_of_games: asOfGames,
    games, postseason_rows,
    model: { model_version: 'edgedesk_nba_v1:' + sp.chosen, chosen: sp.chosen, params_source: sp.source, trained_through: sp.ml.trained_through, calibration: { sd_m: sp.calibration.sd_m }, shape: sp.shape, ot: sp.ot,
      record_spec_hash: S === cfg.season ? live.record_spec_hash || null : null },
    postseason_pairs: pairs, postseason_context: ctx,
    strength: sigmaFor(asOfGames), availability: avail,
    integrity: { box_mismatch: integ ? Number(integ.team_box_points_mismatch) : null, final_mismatch: integ && integ.pbp_final_mismatch != null ? Number(integ.pbp_final_mismatch) : null, stale_scheduled: stale, placeholder_postseason: placeholders, source: 'nba/data/manifest.json seasons.' + S + '.integrity' },
    code_sha256: codeHashes()
  };
  return { schema: NBA_INPUT_SCHEMA, input_hash: hashCanonical(data), data, meta: { built_at: new Date().toISOString(), builder: 'simulator/src/sports/nba/inputs.ts', pass_seconds: passSeconds, params: sp.source } };
}

export function writeSnapshot(file: string, snap: NbaSnapshot): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(snap));
}
export function readSnapshot(file: string): NbaSnapshot {
  const snap = JSON.parse(fs.readFileSync(file, 'utf8')) as NbaSnapshot;
  if (snap.schema !== NBA_INPUT_SCHEMA) throw new Error('not an NBA input snapshot: ' + snap.schema);
  const h = hashCanonical(snap.data);
  if (h !== snap.input_hash) throw new Error('snapshot content hash mismatch: the file was changed after it was built (' + h + ' != ' + snap.input_hash + ')');
  return snap;
}
