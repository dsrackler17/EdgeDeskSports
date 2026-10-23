/* ===========================================================================
   THE COLLEGE FOOTBALL INPUT SNAPSHOT — everything a CFB simulation reads,
   captured once, validated, frozen and hashed BEFORE the first simulated
   season. No network or database call happens after this returns.

   Where every number comes from:
     membership, schedule, results  cfbfastR-data schedules 2026 (Observed):
                         who is FBS and in which conference THIS season, every
                         game (FCS opponents included), neutral flags, final
                         scores of completed games
     late finals         ESPN's public scoreboard, for games the schedule feed
                         has not yet marked completed (finals.ts: event id and
                         both team ids must match; recorded in results_overlay)
     game model          football/cfb_p4 engine, its state replayed cold from
                         the feeds (2018 onward, the walk-forward the calibration
                         study validated: simulator/data/cfb_calibration.json),
                         frozen at the as-of date; every remaining game priced
                         from the frozen state: fair home margin and the
                         engine's own sigma (Research)
     postseason pairs    the same frozen state for every ordered FBS pairing,
                         on a neutral field and at the first team's home
     strength offsets    simulator/data/cfb_strength_uncertainty.json, tau at
                         the as-of week (persistent per team per run)
     availability        simulator/config/cfb_availability.json (primary-QB
                         absences with a source; the engine's trained coefficient)
     rules               config.ts (sources, verification status)
     CFP bracket         simulator/config/cfb_cfp_bracket.json: none, the
                         OBSERVED announced bracket, or a labelled scenario
     committee proxy     simulator/data/cfb_committee_proxy.json (Estimated)
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { REPO, loadCfbEngine, loadSeasonFeed, feedRows, priceBare, cfbCodeIdentity, type FeedGame, type PriceInjury } from './engine_adapter.ts';
import { CFB_2026, type CfbSeasonConfig } from './config.ts';
import { overlayFinals, describeFinals, type ResultsOverlay } from './finals.ts';
import type { CfbTeam, CfbGame } from './rules.ts';
import { hashCanonical, sha256Hex } from '../../core/canonical.ts';

export const CFB_INPUT_SCHEMA = 'edgedesk_sim_cfb_inputs_v1';
const STRENGTH = path.join(REPO, 'simulator', 'data', 'cfb_strength_uncertainty.json');
const CALIBRATION = path.join(REPO, 'simulator', 'data', 'cfb_calibration.json');
const COMMITTEE = path.join(REPO, 'simulator', 'data', 'cfb_committee_proxy.json');
const AVAILABILITY = path.join(REPO, 'simulator', 'config', 'cfb_availability.json');
const BRACKET = path.join(REPO, 'simulator', 'config', 'cfb_cfp_bracket.json');
const LIVE_AVAILABILITY = path.join(REPO, 'football', 'availability', 'current.json');

export interface CfbInputGame extends CfbGame {
  /** Research: the engine's fair home margin, sigma and fair total for an unplayed game */
  model: null | { fair: number; sigma: number; total: number | null; k: number; availability: string[] };
}
export interface PostseasonFeedGame { game_id: string; kind: 'ccg' | 'cfp' | 'bowl'; conference: string | null; round: string | null; kickoff: string; home: number; away: number; neutral: boolean; done: boolean; home_points: number | null; away_points: number | null; notes: string }
export interface CfpBracketConfig { schema: string; season: number; status: 'none' | 'observed' | 'scenario'; label: string; seeds: string[]; source_url: string | null; announced_at: string | null; assumptions: string[] }
export interface AvailabilityEntry { team: string; player: string; athlete_id: string | null; position: string; starter: boolean; status: string; scope: 'rest_of_season' | 'games'; game_ids: string[]; source_url: string; reported_at: string; recorded_by: string }
export interface CfbInputData {
  schema: string;
  sport: 'cfb'; competition: string; season: number;
  config: CfbSeasonConfig;
  teams: CfbTeam[];
  games: CfbInputGame[];
  postseason_feed: PostseasonFeedGame[];
  as_of_week: number;
  latest_result_kickoff: string | null;
  /** finals taken from ESPN where the schedule feed lagged, games not played, and started games neither settles (finals.ts) */
  results_overlay: ResultsOverlay;
  model: { model_version: string; trained_through: number; replay_from: number; pricing_week: number; sigma_total: number; fcs_rating: number };
  /** postseason pairs: [i * T + j] = team i (home/designated) v team j */
  pairs: { neutral_fair: number[]; neutral_sigma: number[]; home_fair: number[]; home_sigma: number[] };
  strength: { distribution: 'normal'; tau_points: number; tau_ci95: [number, number]; as_of_week_used: number; decomposition: string; source: string; source_sha256: string };
  calibration: { source: string; source_sha256: string; model_version: string; frozen_top_buckets: Array<{ bucket: number[]; n: number; predicted: number; won: number; verdict: string }>; live_vs_replay_logit_slope: number };
  availability: { file: string; file_sha256: string | null; entries: AvailabilityEntry[]; live_layer: { file: string; teams_with_records: number | null; generated_at: string | null } };
  cfp_bracket: CfpBracketConfig;
  committee: any | null;
  notre_dame: number;
  code_sha256: Record<string, string>;
  notes: string[];
}
export interface CfbSnapshot {
  schema: string;
  input_hash: string;
  data: CfbInputData;
  meta: { built_at: string; feeds: Array<{ url: string; sha256: string; bytes: number }>; offline: boolean; builder: string };
}

const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const isCcgRow = (g: FeedGame) => !!g.notes && /championship/i.test(g.notes) && !/playoff|bowl/i.test(g.notes);
const isCfpRow = (g: FeedGame) => !!g.notes && /college football playoff/i.test(g.notes);

/** the as-of week rule for tau: the nearest studied as-of week at or below the snapshot's */
export function tauFor(doc: any, asOf: number): { tau: number; ci: [number, number]; week: number } {
  const weeks = Object.keys(doc.by_as_of_week).map(Number).sort((a, b) => a - b);
  const w = weeks.filter((x) => x <= asOf).pop() ?? weeks[0];
  const e = doc.by_as_of_week[w];
  return { tau: e.tau, ci: e.tau_ci95, week: w };
}

export async function buildCfbSnapshot(opt: { offline?: boolean; season?: number; config?: CfbSeasonConfig; now?: number; fetch?: (url: string, init?: any) => Promise<Response> } = {}): Promise<CfbSnapshot> {
  const cfg = opt.config || CFB_2026, season = opt.season || cfg.season, offline = !!opt.offline;
  const eng = loadCfbEngine(), E = eng.E, P = eng.P;
  const replayFrom = season - 8;
  const feeds: Array<{ url: string; sha256: string; bytes: number }> = [];
  const all: FeedGame[] = [];
  let cur: FeedGame[] = [];
  for (let y = replayFrom; y <= season; y++) {
    const f = await loadSeasonFeed(y, offline);
    feeds.push({ url: f.url, sha256: f.sha256, bytes: f.bytes });
    const rows = feedRows(f.text);
    if (y === season) cur = rows;
    all.push(...rows);
  }
  const notes: string[] = [];
  /* 0 finals the schedule feed has not caught up on, settled in place before the replay reads them */
  const fin = await overlayFinals(cur.filter((g) => g.home_division === 'fbs' || g.away_division === 'fbs'), { now: opt.now ?? Date.now(), offline, fetch: opt.fetch });
  feeds.push(...fin.reads.map((r) => ({ url: r.url, sha256: r.sha256, bytes: r.bytes })));
  if (fin.overlay.applied.length) notes.push(fin.overlay.applied.length + ' final(s) the schedule feed had not yet carried were taken from ESPN: ' + describeFinals(fin.overlay) + '.');
  if (fin.overlay.not_played.length) notes.push('Reported postponed or canceled by ESPN, still simulated as scheduled: ' + fin.overlay.not_played.map((g) => g.away + ' @ ' + g.home + ' (' + g.status + ')').join('; ') + '.');
  /* 1 the FBS universe of THIS season, from its own feed */
  const confOf = new Map<string, string>(), nameOf = new Map<string, string>();
  for (const g of cur) for (const side of ['home', 'away'] as const) {
    if (g[side + '_division' as 'home_division'] !== 'fbs') continue;
    const name = g[side], conf = g[side + '_conference' as 'home_conference'] || 'FBS Independents';
    const prev = confOf.get(name);
    if (prev && prev !== conf) throw new Error('feed gives ' + name + ' two conferences: ' + prev + ', ' + conf);
    confOf.set(name, conf); nameOf.set(E.normKey(name), name);
  }
  const names = [...confOf.keys()].sort((a, b) => a.localeCompare(b));
  const ix = new Map<string, number>(); names.forEach((n, i) => ix.set(n, i));
  /* Sun Belt divisions: the season's unique round-robin partition (config.ts) */
  const division = sunBeltDivisions(cur, confOf);
  const elig = new Map(cfg.eligibility.map((e) => [e.team, e]));
  for (const e of cfg.eligibility) if (!ix.has(e.team)) throw new Error('eligibility entry for a team not in the ' + season + ' FBS feed: ' + e.team);
  /* 2 the rating state, replayed cold and frozen after the last completed game */
  const st = E.strength.newState();
  st.r = {}; st.r0 = {}; st.rf = {}; st.n = {}; st.scoring = {}; st.gamesThisSeason = {}; st.eff = {}; st.effMean = {};
  st.lmeanPts = P.rating.league_mean_pts; st.season = replayFrom;
  all.sort((a, b) => (a.kick - b.kick) || (a.season - b.season) || a.game_id.localeCompare(b.game_id));
  let ss = replayFrom, latest: string | null = null, asOf = 0;
  for (const g of all) {
    if (g.season !== ss) { ss = g.season; E.ingest.seasonBreak(st); }
    if (!g.completed) continue;
    E.ingest.absorbGame(st, { home: g.home, away: g.away, home_fbs: g.home_division === 'fbs', away_fbs: g.away_division === 'fbs', neutral_site: g.neutral, home_points: g.home_points, away_points: g.away_points, team_stats: null });
    if (g.season === season) { if (!latest || g.start_date > latest) latest = g.start_date; if (g.season_type === 'regular') asOf = Math.max(asOf, g.week); }
  }
  const week = asOf + 1;
  const teams: CfbTeam[] = names.map((n) => {
    const e = elig.get(n);
    const br = E.strength.blendedRating(st, E.normKey(n), true, week, null);
    return { id: E.normKey(n), name: n, conference: confOf.get(n)!, division: division.get(n) || null,
      ccg_eligible: e ? e.ccg_eligible : true, cfp_eligible: e ? e.cfp_eligible : true, rating: r4(br && Number.isFinite(br.value) ? br.value : NaN) };
  });
  const unrated = teams.filter((t) => !Number.isFinite(t.rating)).map((t) => t.name);
  if (unrated.length) throw new Error('teams without a rating after the replay: ' + unrated.join(', '));
  /* 3 availability (config) */
  const avDoc = fs.existsSync(AVAILABILITY) ? readJson(AVAILABILITY) : { entries: [] };
  const avEntries: AvailabilityEntry[] = avDoc.entries || [];
  for (const a of avEntries) {
    if (!ix.has(a.team)) throw new Error('availability entry for an unknown team: ' + a.team);
    if (!a.source_url || !/^https?:\/\//.test(a.source_url)) throw new Error('availability entry without a source: ' + a.team + ' ' + a.player);
  }
  const injFor = (team: string, gameId: string | null): PriceInjury[] | undefined => {
    const list = avEntries.filter((a) => a.team === team && (a.scope === 'rest_of_season' || (gameId && a.game_ids.includes(gameId))))
      .map((a) => ({ player: a.player, athlete_id: a.athlete_id, position: a.position, starter: a.starter, status: a.status, source: a.source_url }));
    return list.length ? list : undefined;
  };
  /* 4 the games */
  const ccgDate = new Map(cfg.conferences.map((c) => [c.conference, c.ccg_date]));
  const games: CfbInputGame[] = [], postseason: PostseasonFeedGame[] = [];
  const sel = cfg.selection_day;
  for (const g of cur.slice().sort((a, b) => (a.kick - b.kick) || a.game_id.localeCompare(b.game_id))) {
    const h = ix.has(g.home) && g.home_division === 'fbs' ? ix.get(g.home)! : -1, a = ix.has(g.away) && g.away_division === 'fbs' ? ix.get(g.away)! : -1;
    if (h < 0 && a < 0) continue;
    if (isCcgRow(g) || isCfpRow(g) || g.season_type === 'postseason') {
      if (h < 0 || a < 0) continue;
      postseason.push({ game_id: g.game_id, kind: isCfpRow(g) ? 'cfp' : isCcgRow(g) ? 'ccg' : 'bowl', conference: isCcgRow(g) ? teams[h].conference : null, round: g.notes, kickoff: g.start_date,
        home: h, away: a, neutral: g.neutral, done: g.completed, home_points: g.home_points, away_points: g.away_points, notes: g.notes || '' });
      continue;
    }
    const sameConf = h >= 0 && a >= 0 && teams[h].conference === teams[a].conference && teams[h].conference !== 'FBS Independents';
    const conf = g.conference_game && sameConf ? teams[h].conference : null;
    const day = g.start_date.slice(0, 10);
    const ccgOk = !!conf && (!ccgDate.get(conf) || day < (ccgDate.get(conf) as string)) && !(conf === 'Pac-12' && g.week >= 13);
    const done = g.completed;
    let model: CfbInputGame['model'] = null;
    if (!done) {
      const hi = h >= 0 ? injFor(teams[h].name, g.game_id) : undefined, ai = a >= 0 ? injFor(teams[a].name, g.game_id) : undefined;
      const p = priceBare(eng, st, season, week, { home: g.home, away: g.away, home_fbs: h >= 0, away_fbs: a >= 0, neutral: g.neutral, home_conference: g.home_conference, away_conference: g.away_conference },
        hi || ai ? { home: hi, away: ai } : undefined);
      if (p.status !== 'PREDICTED') throw new Error('the engine refused remaining game ' + g.game_id + ' ' + g.away + ' at ' + g.home + ': ' + p.status + ' ' + (p.reason || ''));
      model = { fair: r4(p.fair), sigma: r4(p.sigma), total: p.total == null ? null : r4(p.total), k: (h >= 0 ? 1 : 0) + (a >= 0 ? 1 : 0),
        availability: [...(hi || []).map((x) => g.home + ': ' + x.player + ' ' + x.status), ...(ai || []).map((x) => g.away + ': ' + x.player + ' ' + x.status)] };
    }
    games.push({ game_id: g.game_id, week: g.week, kickoff: g.start_date, home: h, away: a, neutral: g.neutral, conf, ccg_counts: ccgOk, before_selection: day <= sel,
      done, home_points: done ? g.home_points : null, away_points: done ? g.away_points : null,
      exempt_for_visitor: !g.neutral && g.home === "Hawai'i", model });
  }
  /* 5 every ordered postseason pairing, neutral and at the first team's home */
  const T = teams.length, nf = new Array(T * T).fill(0), ns = new Array(T * T).fill(0), hf = new Array(T * T).fill(0), hs = new Array(T * T).fill(0);
  const pw = 16;
  for (let i = 0; i < T; i++) for (let j = 0; j < T; j++) {
    if (i === j) continue;
    const base = { home: teams[i].name, away: teams[j].name, home_fbs: true, away_fbs: true, home_conference: teams[i].conference, away_conference: teams[j].conference };
    const inj = (() => { const hi = injFor(teams[i].name, null), ai = injFor(teams[j].name, null); return hi || ai ? { home: hi, away: ai } : undefined; })();
    const n = priceBare(eng, st, season, pw, { ...base, neutral: true }, inj), hm = priceBare(eng, st, season, pw, { ...base, neutral: false }, inj);
    if (n.status !== 'PREDICTED' || hm.status !== 'PREDICTED') throw new Error('the engine refused postseason pair ' + teams[i].name + ' v ' + teams[j].name);
    nf[i * T + j] = r4(n.fair); ns[i * T + j] = r4(n.sigma); hf[i * T + j] = r4(hm.fair); hs[i * T + j] = r4(hm.sigma);
  }
  /* 6 strength, calibration, committee, bracket */
  const sdoc = readJson(STRENGTH);
  if (sdoc.model_version !== eng.model_version) throw new Error('strength study was fitted for ' + sdoc.model_version + ', the engine is ' + eng.model_version);
  const tf = tauFor(sdoc, asOf);
  const cdoc = readJson(CALIBRATION);
  const top = (cdoc.replay.frozen_fbs_2022_2025.table as any[]).filter((b) => b.n && b.bucket[0] >= 0.9).map((b) => ({ bucket: b.bucket, n: b.n, predicted: b.predicted, won: b.won, verdict: b.verdict }));
  const committee = fs.existsSync(COMMITTEE) ? readJson(COMMITTEE) : null;
  const bracket: CfpBracketConfig = fs.existsSync(BRACKET) ? readJson(BRACKET) : { schema: 'edgedesk_sim_cfb_cfp_bracket_v1', season, status: 'none', label: '', seeds: [], source_url: null, announced_at: null, assumptions: [] };
  if (bracket.status !== 'none') {
    if (bracket.season !== season) throw new Error('cfb_cfp_bracket.json is for ' + bracket.season);
    if (bracket.seeds.length !== 12 || bracket.seeds.some((s) => !ix.has(s)) || new Set(bracket.seeds).size !== 12) throw new Error('cfb_cfp_bracket.json needs 12 distinct FBS team names from the feed');
    if (bracket.status === 'observed' && (!bracket.source_url || !bracket.announced_at)) throw new Error('an observed bracket needs its source_url and announced_at');
    if (bracket.status === 'scenario' && !bracket.assumptions.length) throw new Error('a scenario bracket must state its assumptions');
  }
  const live = fs.existsSync(LIVE_AVAILABILITY) ? readJson(LIVE_AVAILABILITY) : null;
  const pac12Flex = teams.filter((t) => t.conference === 'Pac-12').filter((t) => !games.some((g) => g.week === 13 && (g.home === ix.get(t.name) || g.away === ix.get(t.name)))).map((t) => t.name);
  if (pac12Flex.length) notes.push('Pac-12 Week 13 flex games are not in the feed yet (' + pac12Flex.length + ' teams: opponents set at least six days before): not simulated; they never count in the Pac-12 standings, but they are missing from those teams\' overall records.');
  const data: CfbInputData = {
    schema: CFB_INPUT_SCHEMA, sport: 'cfb', competition: cfg.competition, season, config: cfg, teams, games, postseason_feed: postseason,
    as_of_week: asOf, latest_result_kickoff: latest, results_overlay: fin.overlay,
    model: { model_version: eng.model_version, trained_through: eng.trained_through, replay_from: replayFrom, pricing_week: week, sigma_total: Number(P.distributions.sigma_total), fcs_rating: Number(P.rating.hyperparams.fcs_rating) },
    pairs: { neutral_fair: nf, neutral_sigma: ns, home_fair: hf, home_sigma: hs },
    strength: { distribution: 'normal', tau_points: tf.tau, tau_ci95: tf.ci, as_of_week_used: tf.week, decomposition: sdoc.production.model, source: 'simulator/data/cfb_strength_uncertainty.json', source_sha256: sha256Hex(fs.readFileSync(STRENGTH)) },
    calibration: { source: 'simulator/data/cfb_calibration.json', source_sha256: sha256Hex(fs.readFileSync(CALIBRATION)), model_version: cdoc.model_version, frozen_top_buckets: top, live_vs_replay_logit_slope: cdoc.live_vs_replay_2026.logit_slope_live_on_replay },
    availability: { file: 'simulator/config/cfb_availability.json', file_sha256: fs.existsSync(AVAILABILITY) ? sha256Hex(fs.readFileSync(AVAILABILITY)) : null, entries: avEntries,
      live_layer: { file: 'football/availability/current.json', teams_with_records: live && live.coverage ? live.coverage.with_records : null, generated_at: live ? live.generated_at || null : null } },
    cfp_bracket: bracket, committee,
    notre_dame: ix.has('Notre Dame') ? ix.get('Notre Dame')! : -1,
    code_sha256: cfbCodeIdentity(),
    notes
  };
  return { schema: 'edgedesk_sim_cfb_snapshot_v1', input_hash: hashCanonical(data), data, meta: { built_at: new Date().toISOString(), feeds, offline, builder: 'simulator/src/sports/cfb/inputs.ts' } };
}

/** the Sun Belt's East/West split: the unique partition into two 7-team round robins of the season's conference games */
export function sunBeltDivisions(rows: FeedGame[], confOf: Map<string, string>): Map<string, string> {
  const members = [...confOf.entries()].filter(([, c]) => c === 'Sun Belt').map(([n]) => n).sort();
  const out = new Map<string, string>();
  if (!members.length) return out;
  const played = new Set<string>();
  for (const g of rows) if (g.conference_game && confOf.get(g.home) === 'Sun Belt' && confOf.get(g.away) === 'Sun Belt') { played.add(g.home + '|' + g.away); played.add(g.away + '|' + g.home); }
  const half = members.length / 2;
  if (!Number.isInteger(half)) throw new Error('Sun Belt has an odd number of members');
  const found: string[][] = [];
  const rr = (s: string[]) => s.every((a, i) => s.slice(i + 1).every((b) => played.has(a + '|' + b)));
  const rec = (start: number, pick: string[]) => {
    if (pick.length === half) { const rest = members.filter((m) => !pick.includes(m)); if (rr(pick) && rr(rest)) found.push(pick.slice()); return; }
    for (let i = start; i < members.length; i++) { pick.push(members[i]); rec(i + 1, pick); pick.pop(); }
  };
  rec(1, [members[0]]);
  if (found.length !== 1) throw new Error('Sun Belt divisions: ' + found.length + ' round-robin partitions of the schedule (expected exactly 1)');
  const east = found[0].includes('App State') ? found[0] : members.filter((m) => !found[0].includes(m));
  for (const m of members) out.set(m, east.includes(m) ? 'East' : 'West');
  return out;
}

export function writeSnapshot(file: string, s: CfbSnapshot) { fs.writeFileSync(file, JSON.stringify(s)); }
export function readSnapshot(file: string): CfbSnapshot {
  const text = /\.gz$/.test(file) ? zlib.gunzipSync(fs.readFileSync(file)).toString('utf8') : fs.readFileSync(file, 'utf8');
  const s = JSON.parse(text) as CfbSnapshot;
  if (s.schema !== 'edgedesk_sim_cfb_snapshot_v1' || !s.data || s.data.schema !== CFB_INPUT_SCHEMA) throw new Error('not a CFB snapshot: ' + file);
  if (hashCanonical(s.data) !== s.input_hash) throw new Error('snapshot content does not match its input_hash (edited after it was built?)');
  return s;
}
