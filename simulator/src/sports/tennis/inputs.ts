/* ===========================================================================
   THE TENNIS INPUT SNAPSHOTS — everything a draw simulation (or the day's
   match prices) reads, captured once, validated, frozen and hashed before
   the first simulated match.

   Where every number comes from:
     results, schedule   ESPN's scoreboard: the history feed (simulator/data/
                         feeds/tennis_matches.json.gz) with today's tour
                         scoreboards laid over it, read live on GitHub's
                         runners or from the committed tennis_current.json.gz
                         with --offline or when the live read fails
                         (meta.source; older than config.max_feed_age_hours
                         never publishes: run.ts results.current)
     ratings             elo.ts walk over every match played before the
                         as-of time, with the study's parameters
                         (simulator/data/tennis_elo_study.json)
     the draw's order    Wikipedia's draw article (wiki_draw.ts), confirmed
                         against ESPN line by line (drawFromArticle); else,
                         from the semifinals on, ESPN's own listing
                         (drawFromLateRounds)
     rankings            ESPN's ATP and WTA rankings (tennis_rankings.json),
                         shown beside a player, never an input to a price
   The snapshot's `data` is canonical and content-hashed (input_hash); `meta`
   carries what does not change a result.
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { hashCanonical, sha256Hex } from '../../core/canonical.ts';
import { REPO, FEEDS, MATCHES_FILE, STUDY_FILE, readFeed, loadMatches, walk, price, bestOf, isPlaceholder, dedupeFeed, isQualifying, emptyState, TOUR_LABEL,
  type FeedMatch, type TennisEloConfig, type Tour } from './elo.ts';
import { isMainRound, roundLevels } from './draw.ts';
import { parseWikiDraw, type WikiLine } from './wiki_draw.ts';
import { scoreboardRows, espnTennis } from './espn.ts';
import { exactReach, type TennisPlayer, type TennisDraw, type TennisResult, type TennisModuleData } from './module.ts';
import { TENNIS_2026 } from './config.ts';

export const TENNIS_INPUT_SCHEMA = 'edgedesk_sim_tennis_input_v1';
export const CURRENT_FILE = path.join(FEEDS, 'tennis_current.json.gz');
export const DRAWS_FILE = path.join(FEEDS, 'tennis_draws.json.gz');
export const RANKINGS_FILE = path.join(FEEDS, 'tennis_rankings.json');
export const BACKTEST_FILE = path.join(REPO, 'simulator', 'data', 'tennis_backtest.json');
export const TENNIS_CODE_FILES = ['simulator/src/sports/tennis/elo.ts', 'simulator/src/sports/tennis/draw.ts', 'simulator/src/sports/tennis/wiki_draw.ts', 'simulator/src/sports/tennis/module.ts',
  'simulator/src/sports/tennis/inputs.ts', 'simulator/src/sports/tennis/espn.ts', 'simulator/src/sports/tennis/config.ts', 'simulator/data/tennis_elo_study.json', 'simulator/data/tennis_backtest.json'];
export function codeIdentity(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of TENNIS_CODE_FILES) { const p = path.join(REPO, f); out[f] = fs.existsSync(p) ? sha256Hex(fs.readFileSync(p)) : 'missing'; }
  return out;
}
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const gz = (f: string) => JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString('utf8'));
const readJson = (f: string) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);

/* ------------------------------------------------------------ names */
export function normName(s: string): string {
  return String(s || '').replace(/[’‘`´]/g, "'").replace(/ł/g, 'l').replace(/ø/g, 'o').replace(/đ/g, 'd').replace(/ß/g, 'ss').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/-/g, ' ').replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean).join(' ');
}
const tokenKey = (s: string) => normName(s).split(' ').sort().join(' ');
/** a Wikipedia line's player among ESPN's (id -> name): the same name, the same words in any order, or the same surname and first initial; unique only */
export function matchName(name: string, label: string | null, espn: Map<string, string>): string | null {
  const n = normName(name), tk = tokenKey(name);
  const by = (f: (x: string) => boolean) => { const hits = [...espn].filter(([, v]) => f(v)).map(([k]) => k); return hits.length === 1 ? hits[0] : null; };
  const exact = by((v) => normName(v) === n); if (exact) return exact;
  const tok = by((v) => tokenKey(v) === tk); if (tok) return tok;
  const parts = n.split(' '), sur = parts[parts.length - 1], ini = parts[0][0];
  const si = by((v) => { const p = normName(v).split(' '); return p[p.length - 1] === sur && p[0][0] === ini; }); if (si) return si;
  if (label) { const l = normName(label).split(' '); const ls = l[l.length - 1], li = l[0][0]; return by((v) => { const p = normName(v).split(' '); return p[p.length - 1] === ls && p[0][0] === li; }); }
  return null;
}

/* ------------------------------------------------------------ the draw's order */
export interface DrawOrder { lines: Array<string | null>; first_level: number; source: 'wikipedia' | 'espn_late_rounds'; article: { title: string; revid: number | null } | null;
  matched: number; filled_from_espn: string[]; byes: number; reason: null; wiki?: WikiLine[] }
export type DrawFail = { reason: string; tried: string[] };
interface Ctx { main: FeedMatch[]; ids: Map<string, string>; levels: Map<string, number>; global: Map<string, string> }
const sideId = (m: FeedMatch, s: 'a' | 'b') => (isPlaceholder(s === 'a' ? m.a_id : m.b_id, s === 'a' ? m.a : m.b) ? null : m.tour + ':' + (s === 'a' ? m.a_id : m.b_id));
const winnerId = (m: FeedMatch) => (m.winner === 'a' ? sideId(m, 'a') : m.winner === 'b' ? sideId(m, 'b') : null);
const decidedMatch = (m: FeedMatch) => (m.status === 'final' || m.status === 'walkover') && !!winnerId(m);

/** Wikipedia's lines, confirmed against ESPN: >= 90% of ESPN's main-draw players named on a line; a player ESPN puts
    opposite a placed player goes on that player's sibling line (a qualifier the article had not named yet, a lucky
    loser replacing a withdrawal); every listed match must then fit the lines */
export function drawFromArticle(lines: WikiLine[], c: Ctx): DrawOrder | { reason: string } {
  const L = lines.length;
  if (L < 4 || (L & (L - 1)) !== 0) return { reason: L + ' lines' };
  const first = 7 - Math.log2(L);
  const BYE = '#bye';
  /* the article is confirmed only by ESPN's own players: at least half the draw's must be listed */
  const entrants = lines.filter((l) => !l.bye).length;
  if (c.ids.size < entrants / 2) return { reason: 'ESPN lists ' + c.ids.size + ' of its ' + entrants + ' players so far: the article cannot be confirmed yet' };
  /* a named player ESPN has not listed yet in this draw is found among the tour's players by name (unique only) */
  const at: Array<string | null> = lines.map((l) => (l.bye ? BYE : l.name ? matchName(l.name, l.label, c.ids) ?? matchName(l.name, null, c.global) : null));
  const placedOnce = new Set<string>(); for (const id of at) if (id && id !== BYE) { if (placedOnce.has(id)) return { reason: 'a player on two lines (' + c.ids.get(id) + ')' }; placedOnce.add(id); }
  const matched = [...placedOnce].filter((id) => c.ids.has(id)).length;
  if (matched < 0.9 * c.ids.size) return { reason: 'only ' + matched + ' of ' + c.ids.size + ' ESPN players are on its lines' };
  const lineOf = () => new Map(at.map((id, i) => [id, i] as [string | null, number]).filter(([id]) => id && id !== BYE) as Array<[string, number]>);
  const filled: string[] = [];
  /* fill from ESPN's listed matches, lowest round first, until nothing moves */
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    const pos = lineOf();
    for (const m of c.main.slice().sort((x, z) => c.levels.get(x.round!.trim())! - c.levels.get(z.round!.trim())!)) {
      const a = sideId(m, 'a'), b = sideId(m, 'b'), lv = c.levels.get(m.round!.trim())!;
      if (!a || !b || lv < first) continue;
      const pa = pos.get(a), pb = pos.get(b);
      if (pa != null && pb != null) continue;
      if (pa == null && pb == null) continue;
      const [known, other, x] = pa != null ? [a, b, pa] : [b, a, pb!];
      const width = lv - first, block = (x >> width) ^ 1, lo = block << width, hi = lo + (1 << width);
      const free: number[] = [];
      for (let i = lo; i < hi; i++) if (at[i] !== BYE && (at[i] == null || !c.ids.has(at[i]!))) free.push(i);
      /* a line whose named player never appears in ESPN's draw (withdrew) is free too */
      if (!free.length) for (let i = lo; i < hi; i++) if (at[i] !== BYE && at[i] && !c.main.some((q) => sideId(q, 'a') === at[i] || sideId(q, 'b') === at[i])) free.push(i);
      if (free.length === 1) { at[free[0]] = other; filled.push(c.ids.get(other) + ' (line ' + (free[0] + 1) + ', opposite ' + c.ids.get(known) + ')'); pos.set(other, free[0]); moved = true; }
    }
    if (!moved) break;
  }
  const pos = lineOf();
  const missing = [...c.ids.keys()].filter((id) => !pos.has(id));
  if (missing.length) return { reason: missing.length + ' ESPN players not placed (' + missing.slice(0, 3).map((id) => c.ids.get(id)).join(', ') + ')' };
  /* every listed match fits: its players in one match of its round, from different halves of it */
  for (const m of c.main) {
    const a = sideId(m, 'a'), b = sideId(m, 'b'), lv = c.levels.get(m.round!.trim())!;
    if (!a || !b) continue;
    const xa = pos.get(a)!, xb = pos.get(b)!, sh = lv - first + 1;
    if (lv < first || xa >> sh !== xb >> sh || (xa >> (sh - 1)) === (xb >> (sh - 1))) return { reason: 'the ' + m.round + ' match ' + c.ids.get(a) + ' v ' + c.ids.get(b) + ' does not fit the lines' };
  }
  const unknown = at.filter((x) => x == null).length;
  if (unknown) return { reason: unknown + ' lines with no player yet (qualifiers not placed)' };
  return { lines: at.map((x) => (x === BYE ? null : x)), first_level: first, source: 'wikipedia', article: null, matched, filled_from_espn: filled, byes: at.filter((x) => x === BYE).length, reason: null, wiki: lines };
}
/** from the semifinals on, ESPN's listing is the draw: both semifinals with their players (or the final) */
export function drawFromLateRounds(c: Ctx): DrawOrder | { reason: string } {
  const at = (lv: number) => c.main.filter((m) => c.levels.get(m.round!.trim()) === lv);
  const sf = at(5), f = at(6);
  const full = (ms: FeedMatch[]) => ms.every((m) => sideId(m, 'a') && sideId(m, 'b'));
  if (sf.length === 2 && full(sf)) {
    const lines = [sideId(sf[0], 'a'), sideId(sf[0], 'b'), sideId(sf[1], 'a'), sideId(sf[1], 'b')];
    return { lines, first_level: 5, source: 'espn_late_rounds', article: null, matched: 4, filled_from_espn: [], byes: 0, reason: null };
  }
  if (f.length === 1 && full(f)) return { lines: [sideId(f[0], 'a'), sideId(f[0], 'b')], first_level: 6, source: 'espn_late_rounds', article: null, matched: 2, filled_from_espn: [], byes: 0, reason: null };
  return { reason: 'the semifinals are not both listed with their players' };
}

/* ------------------------------------------------------------ the snapshots */
export interface TennisDrawData extends TennisModuleData {
  sport: 'tennis'; kind: 'draw'; season: number; competition: string; tour: Tour; tour_label: string; as_of: string; source: string;
  tournament: { id: string; name: string; start: string | null; end: string | null };
  order: { source: string; article: { title: string; revid: number | null } | null; matched: number; filled_from_espn: string[]; byes: number; lines: number; tried: string[]; not_yet_in_espn: string[] };
  players: Array<TennisPlayer & { rank: number | null; out: boolean }>;
  scheduled: Array<{ match_id: string | null; level: number; index: number; round: string; at: string | null; a: string; b: string; p_a: number }>;
  rounds: Record<string, number>;
  elo: { config: TennisEloConfig; version: string; config_sha256: string };
  model: TennisModelSummary;
  exact: Record<string, number[]>;
  data_checks: { main_matches: number; decided: number; walkovers: number; retirements: number; live: number; history_fetched_at: string; history_matches: number };
  code: Record<string, string>;
}
export interface TennisMatchesData {
  sport: 'tennis'; kind: 'matches'; season: number; competition: 'matches'; as_of: string; source: string;
  matches: Array<{ id: string; tid: string; tournament: string; tour: Tour; round: string; qualifying: boolean; at: string | null; bo: 3 | 5;
    a: { id: string; name: string; rating: number; n: number; seed: string | null; rank: number | null }; b: { id: string; name: string; rating: number; n: number; seed: string | null; rank: number | null }; p_a: number }>;
  elo: { config: TennisEloConfig; version: string; config_sha256: string };
  model: TennisModelSummary;
  code: Record<string, string>;
}
export type TennisInputData = TennisDrawData | TennisMatchesData;
export interface TennisSnapshot { schema: string; input_hash: string; data: TennisInputData; meta: { built_at: string; builder: string; source: string; feeds: Array<{ name: string; sha256: string }> } }
export interface TennisModelSummary { study_generated_at: string; holdout: Record<string, { n: number; log_loss: number; elo_538: number; coin: number }>; ece: number; backtest: Record<string, any> | null; tune: string; holdout_window: string }

export function modelSummary(study: any, backtest: any): TennisModelSummary {
  const h: TennisModelSummary['holdout'] = {};
  for (const t of ['ATP', 'WTA']) { const x = study.holdout[t]; h[t] = { n: x.chosen.n, log_loss: x.chosen.log_loss, elo_538: x.elo_538.log_loss, coin: x.coin_log_loss }; }
  const bt: Record<string, any> | null = backtest ? Object.fromEntries(['ATP', 'WTA'].map((t) => [t, backtest.tours[t] ? { draws: backtest.tours[t].draws, champion_log_loss: backtest.tours[t].champion_log_loss, favourite_won: backtest.tours[t].favourite_won,
    calibration: backtest.tours[t].calibration } : null])) : null;
  return { study_generated_at: study.generated_at, holdout: h, ece: study.ece_bins_30, backtest: bt, tune: study.windows.tune, holdout_window: study.windows.holdout };
}
export const eloVersion = (cfg: TennisEloConfig) => 'tennis-elo-' + sha256Hex(JSON.stringify(cfg)).slice(0, 8);

/** today's scoreboards: live (GitHub's runners) or the committed copy */
export async function currentScoreboards(offline: boolean): Promise<{ docs: Record<string, unknown>; as_of: string; source: string }> {
  const committed = gz(CURRENT_FILE);
  if (!offline) {
    try {
      const docs: Record<string, unknown> = {};
      for (const tour of ['atp', 'wta']) {
        const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 20000);
        const r = await fetch(espnTennis.scoreboardPlainUrl(tour), { signal: ctl.signal });
        clearTimeout(t);
        if (!r.ok) throw new Error(tour + ' HTTP ' + r.status);
        docs[tour] = await r.json();
      }
      return { docs, as_of: new Date().toISOString(), source: 'live ESPN scoreboards (site.api.espn.com)' };
    } catch (e) { return { docs: committed.scoreboards, as_of: committed.fetched_at, source: 'committed tennis_current.json.gz (the live read failed: ' + String((e as Error).message).slice(0, 80) + ')' }; }
  }
  return { docs: committed.scoreboards, as_of: committed.fetched_at, source: 'committed tennis_current.json.gz' };
}

export async function buildTennisSnapshots(opt: { offline?: boolean; log?: (s: string) => void; nowMs?: number } = {}): Promise<{ snapshots: TennisSnapshot[]; skipped: Array<{ draw: string; reason: string }> }> {
  const study = readJson(STUDY_FILE);
  if (!study) throw new Error('no tennis Elo study (simulator/data/tennis_elo_study.json; node simulator/src/research/tennis_elo_study.ts)');
  const backtest = readJson(BACKTEST_FILE);
  const cfg: TennisEloConfig = study.chosen;
  const feed = readFeed();
  const sb = await currentScoreboards(!!opt.offline);
  /* the history with today's scoreboards laid over it (a live row replaces the feed's row of the same match) */
  const rows = new Map<string, FeedMatch>(feed.matches.map((m) => [String(m.id), m]));
  let liveRows = 0;
  for (const tour of ['atp', 'wta']) if (sb.docs[tour]) for (const r of scoreboardRows(sb.docs[tour], tour)) { rows.set(String(r.id), r); liveRows++; }
  const all = dedupeFeed([...rows.values()]).rows;
  const asOfMs = Date.parse(sb.as_of);
  const { matches } = loadMatches({ matches: all });
  const S = walk(matches.filter((m) => m.at < asOfMs), cfg, emptyState());
  const version = eloVersion(cfg), cfgSha = sha256Hex(JSON.stringify(cfg));
  const elo = { config: cfg, version, config_sha256: cfgSha };
  const model = modelSummary(study, backtest);
  const rk = readJson(RANKINGS_FILE);
  const rank = new Map<string, number>();
  for (const [tour, v] of Object.entries((rk && rk.rankings) || {})) for (const p of (v as any).parsed || []) rank.set(tour.toUpperCase() + ':' + p.provider_athlete_id, p.rank);
  const drawsFeed = fs.existsSync(DRAWS_FILE) ? gz(DRAWS_FILE) : { draws: [] };
  const current = gz(CURRENT_FILE);
  const code = codeIdentity();
  const feeds = [{ name: 'simulator/data/feeds/tennis_matches.json.gz', sha256: sha256Hex(fs.readFileSync(MATCHES_FILE)) }, { name: 'simulator/data/feeds/tennis_current.json.gz', sha256: sha256Hex(fs.readFileSync(CURRENT_FILE)) },
    ...(fs.existsSync(DRAWS_FILE) ? [{ name: 'simulator/data/feeds/tennis_draws.json.gz', sha256: sha256Hex(fs.readFileSync(DRAWS_FILE)) }] : []), ...(rk ? [{ name: 'simulator/data/feeds/tennis_rankings.json', sha256: sha256Hex(fs.readFileSync(RANKINGS_FILE)) }] : [])];
  const meta = { built_at: new Date().toISOString(), builder: 'simulator/src/sports/tennis/inputs.ts', source: sb.source, feeds };
  const R = (id: string) => S.R.get(id) ?? 1500, N = (id: string) => S.N.get(id) || 0;
  const snapshots: TennisSnapshot[] = [], skipped: Array<{ draw: string; reason: string }> = [];
  const seal = (data: TennisInputData): TennisSnapshot => ({ schema: TENNIS_INPUT_SCHEMA, input_hash: hashCanonical(data), data, meta });
  /* every player each tour's history names (id -> latest name): a Wikipedia line ESPN has not listed yet */
  const tourPlayers = new Map<Tour, Map<string, string>>([['ATP', new Map()], ['WTA', new Map()]]);
  for (const m of all) if (m.tour === 'ATP' || m.tour === 'WTA') for (const s of ['a', 'b'] as const) { const id = sideId(m, s); if (id) tourPlayers.get(m.tour)!.set(id, s === 'a' ? m.a : m.b); }
  /* the draws: every ATP or WTA singles main draw of a tournament in progress or within two weeks */
  const soon: Array<{ id: string; name: string; tour: string; start: string; end: string }> = current.tournaments || [];
  for (const t of soon) {
    for (const tour of (t.tour === 'MIXED' ? ['ATP', 'WTA'] : [t.tour]) as Tour[]) {
      const key = tour.toLowerCase() + '-' + t.id;
      const mine = all.filter((m) => m.tid === t.id && m.tour === tour);
      const main = mine.filter((m) => isMainRound(m.round) && m.status !== 'cancelled');
      if (!main.length) { skipped.push({ draw: key + ' ' + t.name, reason: 'no main-draw match listed yet' }); continue; }
      const { level, reason: lr } = roundLevels(main.map((m) => m.round!));
      if (lr) { skipped.push({ draw: key + ' ' + t.name, reason: 'its rounds: ' + lr }); continue; }
      if (main.some((m) => m.round === 'Final' && decidedMatch(m))) { skipped.push({ draw: key + ' ' + t.name, reason: 'finished' }); continue; }
      const ids = new Map<string, string>();
      for (const m of main) for (const s of ['a', 'b'] as const) { const id = sideId(m, s); if (id) ids.set(id, s === 'a' ? m.a : m.b); }
      const c: Ctx = { main, ids, levels: level, global: tourPlayers.get(tour)! };
      /* the draw's order: an article confirmed by ESPN, else the late rounds */
      const tried: string[] = [];
      let order: DrawOrder | null = null;
      for (const d of (drawsFeed.draws || []).filter((x: any) => x.tournament === t.id && x.tour === tour.toLowerCase())) {
        const arts = d.articles || (d.wikitext ? [{ title: d.title, revid: d.revid, wikitext: d.wikitext }] : []);
        for (const a of arts) {
          const w = parseWikiDraw(a.wikitext);
          if (!w.lines.length) { tried.push(a.title + ': ' + w.reason); continue; }
          const o = drawFromArticle(w.lines, c);
          if ('lines' in o) { order = { ...o, article: { title: a.title, revid: a.revid ?? null } }; break; }
          tried.push(a.title + ': ' + (w.reason && w.empty ? w.reason : o.reason));
        }
        if (order) break;
      }
      if (!order) { const o = drawFromLateRounds(c); if ('lines' in o) order = o; else tried.push('ESPN alone: ' + o.reason); }
      if (!order) { skipped.push({ draw: key + ' ' + t.name, reason: 'no draw order: ' + tried.join(' | ') }); continue; }
      const L = order.lines.length, first = order.first_level;
      /* results at their nodes */
      const pos = new Map(order.lines.map((id, i) => [id, i] as [string | null, number]).filter(([id]) => id) as Array<[string, number]>);
      const results: TennisResult[] = [];
      for (const m of main) {
        const lv = level.get(m.round!.trim())!, w = winnerId(m);
        if (lv < first || !decidedMatch(m) || !w || !pos.has(w)) continue;
        results.push({ level: lv, index: pos.get(w)! >> (lv - first + 1), winner: w, match_id: String(m.id), walkover: m.status === 'walkover', retired: m.result === 'retirement' });
      }
      const seedOf = new Map<string, string | null>();
      for (const m of main) { if (sideId(m, 'a')) seedOf.set(sideId(m, 'a')!, m.a_seed || seedOf.get(sideId(m, 'a')!) || null); if (sideId(m, 'b')) seedOf.set(sideId(m, 'b')!, m.b_seed || seedOf.get(sideId(m, 'b')!) || null); }
      const lost = new Set<string>(); for (const m of main) if (decidedMatch(m)) { const w = winnerId(m); for (const s of ['a', 'b'] as const) { const id = sideId(m, s); if (id && id !== w) lost.add(id); } }
      const wl = order.wiki || [];
      const players = order.lines.map((id, i) => ({ id, i })).filter((x) => x.id).map(({ id, i }) => ({ id: id!, name: ids.get(id!) || tourPlayers.get(tour)!.get(id!) || id!,
        seed: seedOf.get(id!) ?? (wl[i] && /^\d+$/.test(String(wl[i].seed)) ? String(wl[i].seed) : null), entry: wl[i] && /^(Q|WC|LL|PR|SE|Alt)$/i.test(String(wl[i].seed)) ? String(wl[i].seed).toUpperCase() : null, rating: r6(R(id!)), n: N(id!), line: i, country: null as string | null,
        rank: rank.get(id!) ?? null, out: lost.has(id!) }));
      const bo = bestOf(tour, t.name, 'Round 1');
      const draw: TennisDraw = { lines: order.lines, first_level: first, results, bo };
      const md: TennisModuleData = { competition: key, season: TENNIS_2026.season, players, draw, elo: { config: cfg } };
      /* the matches whose two players are known and not yet decided */
      const dec = new Map(results.map((r) => [r.level + ':' + r.index, r.winner]));
      const scheduled: TennisDrawData['scheduled'] = [];
      let cur: Array<string | null | '?'> = order.lines.slice();
      for (let lv = first; lv <= 6; lv++) {
        const nxt: Array<string | null | '?'> = [];
        for (let j = 0; j < cur.length / 2; j++) {
          const a = cur[2 * j], b = cur[2 * j + 1], w = dec.get(lv + ':' + j);
          if (!w && a && b && a !== '?' && b !== '?') {
            const em = main.find((m) => level.get(m.round!.trim()) === lv && new Set([sideId(m, 'a'), sideId(m, 'b')]).has(a) && new Set([sideId(m, 'a'), sideId(m, 'b')]).has(b));
            scheduled.push({ match_id: em ? String(em.id) : null, level: lv, index: j, round: [...level].find(([, x]) => x === lv)?.[0] || 'level ' + lv, at: em ? em.at : null, a, b, p_a: r6(price(cfg, R(a), R(b), bo)) });
          }
          nxt.push(w || (a === null ? b : b === null ? a : '?'));
        }
        cur = nxt;
      }
      const exact = Object.fromEntries([...exactReach(md)].map(([id, v]) => [id, v.map(r6)]));
      const data: TennisDrawData = {
        ...md, sport: 'tennis', kind: 'draw', tour, tour_label: TOUR_LABEL[tour], as_of: sb.as_of, source: sb.source,
        tournament: { id: t.id, name: t.name, start: t.start || null, end: t.end || null },
        order: { source: order.source, article: order.article, matched: order.matched, filled_from_espn: order.filled_from_espn, byes: order.byes, lines: L, tried, not_yet_in_espn: players.filter((p) => !ids.has(p.id)).map((p) => p.name) },
        players, scheduled, rounds: Object.fromEntries(level), elo, model, exact,
        data_checks: { main_matches: main.length, decided: main.filter(decidedMatch).length, walkovers: main.filter((m) => m.status === 'walkover').length, retirements: main.filter((m) => m.result === 'retirement').length,
          live: main.filter((m) => m.status === 'live').length, history_fetched_at: feed.fetched_at, history_matches: matches.length },
        code
      };
      snapshots.push(seal(data));
      if (opt.log) opt.log('tennis ' + key + ' ' + t.name + ': ' + L + ' lines from ' + order.source + (order.article ? ' (' + order.article.title + ')' : '') + ', ' + results.length + ' results, ' + scheduled.length + ' matches ready');
    }
  }
  /* the day's matches: every scheduled singles match (main draws and qualifying) with both players known, in the next three days */
  const horizon = asOfMs + 3 * 864e5;
  const sched = all.filter((m) => (m.status === 'scheduled' || m.status === 'live') && (m.tour === 'ATP' || m.tour === 'WTA') && sideId(m, 'a') && sideId(m, 'b') && Date.parse(m.at || '') <= horizon && Date.parse(m.at || '') >= asOfMs - 864e5);
  const side = (m: FeedMatch, s: 'a' | 'b') => { const id = sideId(m, s)!; return { id, name: s === 'a' ? m.a : m.b, rating: r6(R(id)), n: N(id), seed: (s === 'a' ? m.a_seed : m.b_seed) || null, rank: rank.get(id) ?? null }; };
  const md: TennisMatchesData = {
    sport: 'tennis', kind: 'matches', season: TENNIS_2026.season, competition: 'matches', as_of: sb.as_of, source: sb.source,
    matches: sched.sort((x, z) => String(x.at).localeCompare(String(z.at)) || String(x.id).localeCompare(String(z.id))).map((m) => {
      const bo = bestOf(m.tour, m.tournament, m.round);
      return { id: String(m.id), tid: m.tid, tournament: m.tournament, tour: m.tour as Tour, round: m.round || '', qualifying: isQualifying(m.round), at: m.at, bo, a: side(m, 'a'), b: side(m, 'b'), p_a: r6(price(cfg, R(sideId(m, 'a')!), R(sideId(m, 'b')!), bo)) };
    }),
    elo, model, code
  };
  if (md.matches.length) snapshots.push(seal(md)); else skipped.push({ draw: 'matches', reason: 'no scheduled singles match with both players known in the next three days' });
  if (opt.log) opt.log('tennis: ' + snapshots.length + ' snapshots (' + liveRows + ' rows from ' + sb.source + '); skipped ' + skipped.map((s) => s.draw + ': ' + s.reason).join(' | '));
  return { snapshots, skipped };
}

export function writeTennisSnapshot(file: string, snap: TennisSnapshot): void { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(snap)); }
export function readTennisSnapshot(file: string): TennisSnapshot {
  const snap = JSON.parse(fs.readFileSync(file, 'utf8')) as TennisSnapshot;
  if (snap.schema !== TENNIS_INPUT_SCHEMA) throw new Error('not a tennis input snapshot: ' + snap.schema);
  if (hashCanonical(snap.data) !== snap.input_hash) throw new Error('tennis snapshot hash mismatch');
  return snap;
}
