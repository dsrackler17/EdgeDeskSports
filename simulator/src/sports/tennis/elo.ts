/* ===========================================================================
   THE TENNIS RATING — a point-in-time Elo per tour, walked over every
   singles match ESPN lists since 2022.

   DATA. simulator/data/feeds/tennis_matches.json.gz (ESPN's public tennis
   scoreboard, fetched on GitHub's runners by simulator/src/cli/
   fetch_sports_data.ts --what tennis): every ATP and WTA singles match, main
   draws and qualifying, with its round, sets and winner. loadMatches keeps a
   match only if it was played to a result (completed or a retirement: a
   ball was struck) between two named players; walkovers, cancellations and
   TBD placeholders are left out, with the counts recorded.

   THE RATING. Each tour separately (men and women never meet). Every player
   starts at 1500. Before a match, side a is expected to win with
        p = 1 / (1 + 10^(-(R_a - R_b) / scale)).
   After it, each rating moves by K_i x (target - expected), where the step
   shrinks with the player's matches on file,
        K_i = k_num / (n_i + k_offset)^k_exp
   (FiveThirtyEight's tennis form), and the target blends the result with
   the share of games won, which says more about the gap than the result
   alone:
        target = (1 - mov_weight) x won + mov_weight x sigmoid(mov_stretch x 12 x (games share - 1/2))
   (a retirement counts as the result only: its score stops early). Every
   parameter is chosen on 2023-2024 and judged on 2025 on by
   simulator/src/research/tennis_elo_study.ts (simulator/data/
   tennis_elo_study.json); nothing about a later match reaches an earlier
   price.

   BEST OF FIVE. The rating is fitted on a mix that is mostly best of three.
   A men's Grand Slam main-draw match is best of five: the price converts
   through the set, solving p = s^2 (3 - 2s) for the chance s of winning a
   set and then P5 = s^3 (1 + 3(1-s) + 6(1-s)^2) (the study measures
   whether this helps on the slams' matches before it is used).
   =========================================================================== */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
export const FEEDS = path.join(REPO, 'simulator', 'data', 'feeds');
export const MATCHES_FILE = path.join(FEEDS, 'tennis_matches.json.gz');
export const STUDY_FILE = path.join(REPO, 'simulator', 'data', 'tennis_elo_study.json');
export const DAY = 864e5;

export type Tour = 'ATP' | 'WTA';
export const TOURS: Tour[] = ['ATP', 'WTA'];
export const TOUR_LABEL: Record<Tour, string> = { ATP: 'ATP Tour (men)', WTA: 'WTA Tour (women)' };

export interface TennisEloConfig { k_num: number; k_offset: number; k_exp: number; mov_weight: number; mov_stretch: number; scale: number; bo5_convert: boolean }
/** FiveThirtyEight's published tennis Elo: the baseline every candidate is compared with */
export const ELO_538: TennisEloConfig = { k_num: 250, k_offset: 5, k_exp: 0.4, mov_weight: 0, mov_stretch: 1, scale: 400, bo5_convert: false };

/** the feed's match row (fetch_sports_data.ts tennisMatchRow) */
export interface FeedMatch {
  id: string; tid: string; tournament: string; tour: string; grouping: string; round: string | null; at: string | null;
  a_id: string; a: string; a_seed: string | null; b_id: string; b: string; b_seed: string | null;
  status: string; result: string | null; winner: 'a' | 'b' | null; sets: Array<[number | null, number | null, number | null, number | null]>;
}
export interface TMatch {
  id: string; tour: Tour; tid: string; tournament: string; round: string; at: number; a: string; b: string; an: string; bn: string;
  /** 1 = a won, 0 = b won */
  y: 0 | 1; retired: boolean; ga: number; gb: number; sets_a: number; sets_b: number; bo: 3 | 5;
}

const SLAMS = /Australian Open|Roland Garros|French Open|Wimbledon|US Open/i;
export const isSlam = (name: string) => SLAMS.test(name) && !/Junior|Wheelchair|Legends/i.test(name);
export const isQualifying = (round: string | null) => /qualif/i.test(round || '');
/** best of five: men's Grand Slam main draws only (the WTA, every qualifying draw and every other event: best of three) */
export function bestOf(tour: string, tournament: string, round: string | null): 3 | 5 {
  return tour === 'ATP' && isSlam(tournament) && !isQualifying(round) ? 5 : 3;
}
export const isPlaceholder = (id: string | null | undefined, name?: string | null) => !id || Number(id) < 0 || /^TBD$/i.test(String(name || '').trim());

/** ESPN lists some early-2022 matches twice under two ids (the same tournament, round and players: 1,277
    extra rows). One row is kept per (tour, tournament, round, pair of players): the lowest id among the
    played ones; a group whose played rows disagree on the winner (11, retirements scored both ways) is
    left out whole. Placeholder (TBD) rows are never grouped. */
export function dedupeFeed(rows: FeedMatch[]): { rows: FeedMatch[]; merged: number; conflicting: number } {
  const groups = new Map<string, FeedMatch[]>(), out: FeedMatch[] = [];
  for (const m of rows) {
    if (isPlaceholder(m.a_id, m.a) || isPlaceholder(m.b_id, m.b)) { out.push(m); continue; }
    const k = m.tour + '|' + m.tid + '|' + (m.round || '') + '|' + [m.a_id, m.b_id].sort().join('|');
    (groups.get(k) || groups.set(k, []).get(k)!).push(m);
  }
  let merged = 0, conflicting = 0;
  const winnerId = (m: FeedMatch) => (m.winner === 'a' ? m.a_id : m.winner === 'b' ? m.b_id : null);
  const byId = (x: FeedMatch, z: FeedMatch) => Number(x.id) - Number(z.id);
  for (const g of groups.values()) {
    if (g.length === 1) { out.push(g[0]); continue; }
    merged += g.length - 1;
    const played = g.filter((m) => m.status === 'final' || m.status === 'walkover').sort(byId);
    if (new Set(played.map(winnerId).filter(Boolean)).size > 1) { conflicting++; continue; }
    out.push((played.find((m) => winnerId(m)) || played[0] || g.slice().sort(byId)[0]));
  }
  return { rows: out, merged, conflicting };
}
export function readFeed(file = MATCHES_FILE): { matches: FeedMatch[]; fetched_at: string; tournaments: any[] } {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
}
/** the played singles matches, ordered by (start time, match id); counts of what was left out */
export function loadMatches(feed: { matches: FeedMatch[] }): { matches: TMatch[]; dropped: Record<string, number> } {
  const out: TMatch[] = [], dropped: Record<string, number> = {};
  const drop = (k: string) => { dropped[k] = (dropped[k] || 0) + 1; };
  const dd = dedupeFeed(feed.matches);
  if (dd.merged) dropped['duplicate row (merged)'] = dd.merged;
  if (dd.conflicting) dropped['duplicate rows disagreeing on the winner (groups)'] = dd.conflicting;
  for (const m of dd.rows) {
    if (m.tour !== 'ATP' && m.tour !== 'WTA') { drop('not ATP or WTA'); continue; }
    if (m.status === 'walkover') { drop('walkover'); continue; }
    if (m.status !== 'final') { drop(m.status === 'cancelled' ? 'cancelled' : 'not final'); continue; }
    if (isPlaceholder(m.a_id, m.a) || isPlaceholder(m.b_id, m.b)) { drop('placeholder player'); continue; }
    if (m.winner !== 'a' && m.winner !== 'b') { drop('no winner'); continue; }
    const at = Date.parse(m.at || '');
    if (!Number.isFinite(at)) { drop('no start time'); continue; }
    let ga = 0, gb = 0, sa = 0, sb = 0;
    for (const s of m.sets || []) {
      const x = Number(s[0]), z = Number(s[1]);
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
      ga += x; gb += z;
      if (x > z) sa++; else if (z > x) sb++;
    }
    out.push({ id: String(m.id), tour: m.tour, tid: String(m.tid), tournament: m.tournament, round: m.round || '', at, a: m.tour + ':' + m.a_id, b: m.tour + ':' + m.b_id, an: m.a, bn: m.b,
      y: m.winner === 'a' ? 1 : 0, retired: m.result === 'retirement', ga, gb, sets_a: sa, sets_b: sb, bo: bestOf(m.tour, m.tournament, m.round) });
  }
  out.sort((x, z) => x.at - z.at || (x.id < z.id ? -1 : x.id > z.id ? 1 : 0));
  return { matches: out, dropped };
}

export interface EloState { R: Map<string, number>; N: Map<string, number>; last: Map<string, number> }
export const emptyState = (): EloState => ({ R: new Map(), N: new Map(), last: new Map() });
export const cloneState = (S: EloState): EloState => ({ R: new Map(S.R), N: new Map(S.N), last: new Map(S.last) });

export const expect3 = (cfg: TennisEloConfig, ra: number, rb: number) => 1 / (1 + 10 ** (-(ra - rb) / cfg.scale));
/** the chance of winning a set that makes a best-of-three match p (p = s^2 (3 - 2s)), by bisection */
export function setFromBo3(p: number): number {
  let lo = 0, hi = 1;
  for (let i = 0; i < 60; i++) { const s = (lo + hi) / 2; if (s * s * (3 - 2 * s) < p) lo = s; else hi = s; }
  return (lo + hi) / 2;
}
export const bo5FromSet = (s: number) => s ** 3 * (1 + 3 * (1 - s) + 6 * (1 - s) ** 2);
/** the match price for side a in a match of this format */
export function price(cfg: TennisEloConfig, ra: number, rb: number, bo: 3 | 5): number {
  const p = expect3(cfg, ra, rb);
  return bo === 5 && cfg.bo5_convert ? bo5FromSet(setFromBo3(p)) : p;
}
export function target(cfg: TennisEloConfig, m: TMatch): number {
  if (!cfg.mov_weight || m.retired || m.ga + m.gb <= 0) return m.y;
  const g = m.ga / (m.ga + m.gb);
  return (1 - cfg.mov_weight) * m.y + cfg.mov_weight / (1 + Math.exp(-cfg.mov_stretch * 12 * (g - 0.5)));
}
export interface WalkRow { m: TMatch; p: number; ra: number; rb: number; na: number; nb: number }
/** walk the matches in order, pricing each from the ratings before it, then absorbing it */
export function walk(ms: TMatch[], cfg: TennisEloConfig, S: EloState = emptyState(), onRow?: (r: WalkRow) => void): EloState {
  for (const m of ms) {
    const ra = S.R.get(m.a) ?? 1500, rb = S.R.get(m.b) ?? 1500, na = S.N.get(m.a) || 0, nb = S.N.get(m.b) || 0;
    const e = expect3(cfg, ra, rb);
    if (onRow) onRow({ m, p: m.bo === 5 && cfg.bo5_convert ? bo5FromSet(setFromBo3(e)) : e, ra, rb, na, nb });
    const t = target(cfg, m);
    S.R.set(m.a, ra + cfg.k_num / (na + cfg.k_offset) ** cfg.k_exp * (t - e));
    S.R.set(m.b, rb + cfg.k_num / (nb + cfg.k_offset) ** cfg.k_exp * ((1 - t) - (1 - e)));
    S.N.set(m.a, na + 1); S.N.set(m.b, nb + 1);
    S.last.set(m.a, m.at); S.last.set(m.b, m.at);
  }
  return S;
}
