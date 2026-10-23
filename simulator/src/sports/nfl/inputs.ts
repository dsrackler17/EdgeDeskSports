/* ===========================================================================
   THE NFL INPUT SNAPSHOT — everything a simulation reads, captured once,
   validated, frozen and hashed BEFORE the first simulated season.

   Where every number comes from:
     schedule, results   nflverse/nfldata games.csv (Observed), through the
                         board's own football module (app.html, booted in Node
                         by tools/football/build_nfl_slate.js loadBoard — the
                         path the published NFL slate is built by)
     game model          the board's fbNflGameReq + fbPredict for every
                         remaining game: the served edgedesk_nfl_v2 fair home
                         margin and total (Research), with the board's own
                         starter reconciliation against the injury report
     postseason pairs    the same two functions on schedule-shaped rows for
                         every possible postseason pairing (home club's venue,
                         estimated rest from the season config)
     reconciliation      nflverse/nfldata standings.csv: every club's W-L-T and
                         points must equal the results
     strength offsets    simulator/data/nfl_strength_uncertainty.json, the
                         as-of week's calibrated sigma
     scoring tiebreaks   football/validation/linemaker_nfl.json live block
     margin table        the served nfl_params_v2 margin_pmf_by_spread, copied
                         in so a replay prices from the same table

   The snapshot's `data` is canonical and content-hashed (input_hash);
   `meta` carries what does not change a result (build time, feed sizes).
   No network or database call happens after this returns.
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO, loadEngine } from './model_adapter.ts';
import { NFL_TEAMS_2026, NFL_2026, type NflSeasonConfig } from './config.ts';
import { parseCsv, num } from '../../core/csv.ts';
import { canonicalJson, hashCanonical, sha256Hex } from '../../core/canonical.ts';

const require = createRequire(import.meta.url);
export const NFL_INPUT_SCHEMA = 'edgedesk_sim_nfl_inputs_v1';
const CACHE = path.join(REPO, 'simulator', '.cache', 'feeds');
export const STANDINGS_URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/standings.csv';

export interface NflInputGame {
  game_id: string; week: number; gameday: string | null; gametime: string | null;
  home: string; away: string; neutral: boolean; div_game: boolean;
  done: boolean; home_score: number | null; away_score: number | null; overtime: boolean | null;
  /** Research: the served model's fair home margin and total for an unplayed game */
  model: null | { fair_margin: number; fair_total: number; home_win_prob: number; quality: string; warnings: string[]; qb_notes: string[] };
}
export interface PairEntry { m: number; t: number }
export interface NflInputData {
  schema: string;
  sport: 'nfl'; competition: 'NFL'; season: number;
  config: NflSeasonConfig;
  teams: typeof NFL_TEAMS_2026;
  games: NflInputGame[];
  as_of_week: number;
  latest_result_kickoff: string | null;
  model: { model_version: string; config_sha: string; trained_through: number; feature_version: string; margin_pmf_by_spread: Record<string, Record<string, number>> };
  /** postseason fair (home margin m, total t) per context, keyed home code -> away code */
  postseason_pairs: { default: Record<string, Record<string, PairEntry>>; home_off_bye: Record<string, Record<string, PairEntry>>; super_bowl: Record<string, Record<string, PairEntry>> };
  strength: { distribution: 'normal'; sigma_points: number; sigma_ci95: [number, number]; as_of_week: number; method: string; source: string; source_sha256: string };
  points_model: { method: string; status: string; live: any; source: string; source_sha256: string } | null;
  reconciliation: { source: string; source_sha256: string | null; status: 'OK' | 'MISMATCH' | 'UNAVAILABLE'; mismatches: string[]; nflverse_current: Record<string, { div_rank: number | null; seed: number | null }> };
  code_sha256: Record<string, string>;
  board_notes: string[];
}
export interface NflSnapshot {
  schema: string;
  input_hash: string;
  data: NflInputData;
  meta: { built_at: string; feeds: Array<{ url: string; sha256: string; bytes: number }>; offline: boolean; builder: string };
}

function cachedFetch(offline: boolean, feeds: Array<{ url: string; sha256: string; bytes: number }>) {
  return async (u: string): Promise<string> => {
    const s = String(u || '');
    let text: string;
    if (s.startsWith('/')) {
      const local = path.join(REPO, s.replace(/^\/+/, ''));
      if (!fs.existsSync(local)) throw new Error('local feed missing: ' + s);
      text = fs.readFileSync(local, 'utf8');
    } else {
      const key = path.join(CACHE, s.replace(/[^a-z0-9.]+/gi, '_').slice(-140));
      if (offline) {
        if (!fs.existsSync(key)) throw new Error('offline and not cached: ' + s);
        text = fs.readFileSync(key, 'utf8');
      } else {
        let last: unknown = null;
        text = '';
        for (let attempt = 0; attempt < 4; attempt++) {       /* bounded retry: transient network only */
          try {
            const r = await fetch(s, { redirect: 'follow' });
            if (r.status === 404) throw Object.assign(new Error('HTTP 404 ' + s), { permanent: true });
            if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + s);
            text = await r.text(); last = null; break;
          } catch (e) {
            last = e;
            if ((e as any).permanent) break;
            await new Promise((res) => setTimeout(res, 1000 * Math.pow(2, attempt)));
          }
        }
        if (last) throw last;
        fs.mkdirSync(CACHE, { recursive: true });
        fs.writeFileSync(key, text);
      }
    }
    feeds.push({ url: s, sha256: sha256Hex(text), bytes: text.length });
    return text;
  };
}

const CODE_FILES = ['football/engine.js', 'football/nfl_model.js', 'football/nfl_params_v2.js', 'football/params.js', 'lib/edgedesk_fairline.js', 'lib/research_core.js',
  'football/validation/linemaker_nfl.json', 'football/venues/nfl_stadiums.json', 'tools/football/build_nfl_slate.js', 'tools/football/_module.js', 'simulator/data/nfl_strength_uncertainty.json'];
export function codeHashes(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of CODE_FILES) out[f] = sha256Hex(fs.readFileSync(path.join(REPO, f)));
  /* the football module inside app.html, alone (the rest of the page does not price anything) */
  const M = require(path.join(REPO, 'tools', 'football', '_module.js'));
  out['app.html#football-module'] = sha256Hex(M.moduleSource(REPO).module);
  return out;
}

export interface BuildOptions { offline?: boolean; config?: NflSeasonConfig; standingsText?: string | null }

export async function buildNflSnapshot(opt: BuildOptions = {}): Promise<NflSnapshot> {
  const cfg = opt.config || NFL_2026;
  const offline = !!opt.offline;
  const feeds: Array<{ url: string; sha256: string; bytes: number }> = [];
  const fetchText = cachedFetch(offline, feeds);
  loadEngine();
  const slate = require(path.join(REPO, 'tools', 'football', 'build_nfl_slate.js'));
  const { win, T, S } = await slate.loadBoard({ offline, fetchText });
  if (S.curSeason !== cfg.season) throw new Error('the board is on season ' + S.curSeason + ', the config is for ' + cfg.season);
  const teamCodes = new Set(NFL_TEAMS_2026.map((t) => t.code));
  const divOf: Record<string, string> = {}; NFL_TEAMS_2026.forEach((t) => { divOf[t.code] = t.division; });

  /* the schedule and the model, game by game */
  const games: NflInputGame[] = [];
  let latest: number | null = null;
  for (const u of S.games) {
    const g = u.g;
    if (String(g.game_type || 'REG') !== 'REG') throw new Error('postseason game ' + g.game_id + ' is on the schedule: this version simulates from the regular season only');
    if (!teamCodes.has(g.home_team) || !teamCodes.has(g.away_team)) throw new Error('unknown club in ' + g.game_id);
    const done = g.home_score != null && g.away_score != null;
    const req = T.fbNflGameReq(g);
    let model: NflInputGame['model'] = null;
    if (!done) {
      const p = T.fbPredict('nfl', req, {}, cfg.season);
      if (!p || p.status !== 'PREDICTED' || !Number.isFinite(p.model.fair_spread)) throw new Error('the served model did not price ' + g.game_id + ': ' + (p && (p.status + ' ' + (p.reason || ''))));
      model = { fair_margin: p.model.fair_spread, fair_total: p.model.fair_total, home_win_prob: p.model.home_win_prob, quality: p.data_quality ? p.data_quality.status : 'UNKNOWN',
        warnings: (p.data_quality && p.data_quality.warnings) || [], qb_notes: [req.home_qb_note, req.away_qb_note].filter(Boolean) };
    } else if (u.t && (latest == null || u.t > latest)) latest = u.t;
    games.push({ game_id: g.game_id, week: Number(g.week), gameday: g.gameday || null, gametime: g.gametime || null, home: g.home_team, away: g.away_team,
      neutral: !!req.neutral, div_game: String(g.div_game) === '1', done,
      home_score: done ? Number(g.home_score) : null, away_score: done ? Number(g.away_score) : null,
      overtime: g.overtime == null ? null : String(g.overtime) === '1', model });
  }
  games.sort((a, b) => a.game_id.localeCompare(b.game_id));
  const open = games.filter((g) => !g.done);
  const asOfWeek = open.length ? Math.min(...open.map((g) => g.week)) : cfg.regular_season_weeks + 1;

  /* the postseason pair table, through the board's own request builder */
  const stad = JSON.parse(fs.readFileSync(path.join(REPO, 'football', 'venues', 'nfl_stadiums.json'), 'utf8')).stadiums as any[];
  const SHARED: Record<string, string> = { NYG: 'NYJ', LA: 'LAC' };
  const venueOf = (club: string) => stad.find((s) => s.club === club) || stad.find((s) => s.club === SHARED[club]);
  const pr = (home: string, away: string, ctx: 'default' | 'home_off_bye' | 'super_bowl'): PairEntry => {
    const sb = ctx === 'super_bowl', v = sb ? stad.find((s) => s.name === cfg.super_bowl.value.venue) : venueOf(home);
    if (!v) throw new Error('no venue for ' + (sb ? cfg.super_bowl.value.venue : home));
    const rest = cfg.postseason_rest.value;
    const row = { season: cfg.season, week: sb ? 22 : ctx === 'home_off_bye' ? 20 : 19, game_type: 'POST', gameday: sb ? cfg.super_bowl.value.date : null, gametime: null,
      home_team: home, away_team: away, location: sb ? 'Neutral' : 'Home', stadium: v.name, roof: v.roof, surface: v.surface,
      div_game: divOf[home] === divOf[away] ? 1 : 0, temp: null, wind: null, home_qb_id: null, away_qb_id: null,
      home_rest: sb ? rest.super_bowl : ctx === 'home_off_bye' ? rest.divisional_after_bye : rest.wild_card,
      away_rest: sb ? rest.super_bowl : ctx === 'home_off_bye' ? rest.divisional_after_wild_card : rest.wild_card };
    const req = T.fbNflGameReq(row);
    if (sb && !req.neutral) throw new Error('the Super Bowl row was not read as neutral');
    const p = T.fbPredict('nfl', req, {}, cfg.season);
    if (!p || p.status !== 'PREDICTED' || !Number.isFinite(p.model.fair_spread)) throw new Error('the served model did not price the postseason pair ' + home + '-' + away + ' (' + ctx + ')');
    return { m: p.model.fair_spread, t: p.model.fair_total };
  };
  const pairs: NflInputData['postseason_pairs'] = { default: {}, home_off_bye: {}, super_bowl: {} };
  for (const h of NFL_TEAMS_2026) for (const a of NFL_TEAMS_2026) {
    if (h.code === a.code) continue;
    if (h.conference === a.conference) {
      (pairs.default[h.code] = pairs.default[h.code] || {})[a.code] = pr(h.code, a.code, 'default');
      (pairs.home_off_bye[h.code] = pairs.home_off_bye[h.code] || {})[a.code] = pr(h.code, a.code, 'home_off_bye');
    } else if (h.conference === cfg.super_bowl.value.designated_home) {
      (pairs.super_bowl[h.code] = pairs.super_bowl[h.code] || {})[a.code] = pr(h.code, a.code, 'super_bowl');
    }
  }

  /* reconciliation against nflverse's standings */
  let stText: string | null = opt.standingsText === undefined ? null : opt.standingsText;
  if (opt.standingsText === undefined) { try { stText = await fetchText(STANDINGS_URL); } catch (_) { stText = null; } }
  const recon = reconcile(games, stText, cfg.season);

  /* strength offsets for the as-of week */
  const UNC_FILE = path.join(REPO, 'simulator', 'data', 'nfl_strength_uncertainty.json');
  const uncText = fs.readFileSync(UNC_FILE, 'utf8'), unc = JSON.parse(uncText);
  const PVv = loadEngine().PV;
  if (unc.served_model.config_sha !== PVv.config_sha) throw new Error('the strength-uncertainty study was run on served config ' + unc.served_model.config_sha + ', the board serves ' + PVv.config_sha + ': rerun simulator/src/research/nfl_strength_uncertainty.ts');
  const wk = Math.min(asOfWeek, 17);
  const row = (unc.by_week as any[]).find((b) => b.as_of_week === wk);
  if (!row || !row.win_total_calibration) throw new Error('no calibrated strength sigma for as-of week ' + wk);
  const strength = { distribution: 'normal' as const, sigma_points: row.win_total_calibration.sigma, sigma_ci95: row.win_total_calibration.sigma_ci95 as [number, number], as_of_week: wk,
    method: 'win-total calibration (' + row.win_total_calibration.smoothing + '); cross-check: within-club covariance sigma ' + row.selected.sigma_e + ' ' + JSON.stringify(row.selected.sigma_e_ci95),
    source: 'simulator/data/nfl_strength_uncertainty.json', source_sha256: sha256Hex(uncText) };

  /* points model and margin table */
  const lmText = fs.readFileSync(path.join(REPO, 'football', 'validation', 'linemaker_nfl.json'), 'utf8'), lm = JSON.parse(lmText);
  const PV = loadEngine().PV;
  const data: NflInputData = {
    schema: NFL_INPUT_SCHEMA, sport: 'nfl', competition: 'NFL', season: cfg.season, config: cfg, teams: NFL_TEAMS_2026, games,
    as_of_week: asOfWeek, latest_result_kickoff: latest == null ? null : new Date(latest).toISOString(),
    model: { model_version: PV.model_version, config_sha: PV.config_sha, trained_through: PV.trained_through_season, feature_version: 'nfl_v2:' + PV.config_sha,
      margin_pmf_by_spread: PV.margin_pmf_by_spread },
    postseason_pairs: pairs, strength,
    points_model: { method: lm.live.markets.team_total.method, status: lm.live.markets.team_total.status, live: lm.live, source: 'football/validation/linemaker_nfl.json', source_sha256: sha256Hex(lmText) },
    reconciliation: recon, code_sha256: codeHashes(), board_notes: (S.notes || []).slice()
  };
  void win;
  return { schema: NFL_INPUT_SCHEMA, input_hash: hashCanonical(data), data, meta: { built_at: new Date().toISOString(), feeds, offline, builder: 'simulator/src/sports/nfl/inputs.ts' } };
}

/** every club's W-L-T and points must equal nflverse's standings */
export function reconcile(games: NflInputGame[], standingsText: string | null, season: number): NflInputData['reconciliation'] {
  if (!standingsText) return { source: STANDINGS_URL, source_sha256: null, status: 'UNAVAILABLE', mismatches: ['standings could not be read'], nflverse_current: {} };
  const rows = parseCsv(standingsText).filter((r) => num(r.season) === season);
  const rec: Record<string, number[]> = {};
  for (const g of games) {
    if (!g.done) continue;
    const hs = g.home_score as number, as = g.away_score as number;
    for (const [t, f, a] of [[g.home, hs, as], [g.away, as, hs]] as Array<[string, number, number]>) {
      const x = rec[t] || (rec[t] = [0, 0, 0, 0, 0]);
      x[3] += f; x[4] += a;
      if (f > a) x[0]++; else if (f < a) x[1]++; else x[2]++;
    }
  }
  const mism: string[] = [];
  const cur: Record<string, { div_rank: number | null; seed: number | null }> = {};
  for (const t of NFL_TEAMS_2026) {
    const r = rows.find((x) => x.team === t.code);
    const mine = rec[t.code] || [0, 0, 0, 0, 0];
    if (!r) { mism.push(t.code + ': not in standings'); continue; }
    const theirs = [num(r.wins), num(r.losses), num(r.ties), num(r.scored), num(r.allowed)];
    if (canonicalJson(theirs) !== canonicalJson(mine)) mism.push(t.code + ': results ' + mine.join('/') + ' vs standings ' + theirs.join('/'));
    if (r.conf && r.division && r.division !== t.division) mism.push(t.code + ': standings division ' + r.division + ' vs config ' + t.division);
    cur[t.code] = { div_rank: num(r.div_rank), seed: num(r.seed) };
  }
  return { source: STANDINGS_URL, source_sha256: sha256Hex(standingsText), status: mism.length ? 'MISMATCH' : 'OK', mismatches: mism, nflverse_current: cur };
}

export function writeSnapshot(file: string, snap: NflSnapshot): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(snap));
}
export function readSnapshot(file: string): NflSnapshot {
  const snap = JSON.parse(fs.readFileSync(file, 'utf8')) as NflSnapshot;
  if (snap.schema !== NFL_INPUT_SCHEMA) throw new Error('not an NFL input snapshot: ' + snap.schema);
  const h = hashCanonical(snap.data);
  if (h !== snap.input_hash) throw new Error('snapshot content hash mismatch: the file was changed after it was built (' + h + ' != ' + snap.input_hash + ')');
  return snap;
}
