/* ===========================================================================
   THE SERVED UFC FIGHT MODEL, PORTED LINE FOR LINE.

   The model loop serves a walk-forward Elo for UFC bouts
   (model_loop/adapters/ufc/model.py walk(); the served configuration is
   docs/model-loop/ufc/versions.json "current", 1.1.0, EXPERIMENTAL). It is
   Python; the simulator is TypeScript with no runtime dependency, so the
   walk is ported here and PROVEN equal to what the loop published: every
   p_a in model_loop/published/ufc/current.json is reproduced to its four
   published decimals (the run gate model.reproduces, and
   simulator/tests/ufc_elo.test.ts against the Python walk's full-precision
   values too).

   The walk, exactly as model.py has it:
     - bouts in order of (start time, bout id as a string); a bout whose
       start time does not parse is dropped (model.py load);
     - every bout (any status) is priced from the ratings before it:
       e = 1 / (1 + 10^(-(ra - rb) / scale));
     - rating(f, t): 1500 for a fighter never seen; a fighter returning
       after layoff_days or more (whole days since the last ABSORBED bout)
       has layoff_regress of the distance from 1500 removed, and the
       regressed rating is STORED (so a cancelled or scheduled row regresses
       it too, and the regression persists into the next bout);
     - a FINAL bout with a winner (or a draw: both winner flags false) is
       absorbed: s = 1, 0 or 0.5; each side's step is k, times k_new_mult
       while the fighter has fewer than new_bouts absorbed bouts; the
       bout counts and the last-bout times move.
   Nothing about a fighter's later career reaches an earlier bout. The
   served calibration is "none": the price is e itself.

   The champion term (model.py champ_bonus): champ_bonus Elo points added to
   the defending champion's rating for the bout's expectation (and so its
   update) in an undisputed title fight, the champion going in read from
   model_loop/data/ufc/title_bouts.csv exactly as model.py load() reads it.
   The loop tests it every week; while the served configuration has no
   champ_bonus (0), it changes nothing.

   The 2026-10 parameters (model.py _walk_extended; docs/model-loop/ufc/study):
   a configuration that sets any of them takes walkExtended(), the same
   arithmetic in the same order as the Python: each fighter's prior (1500 +
   debut_offset + the pre-UFC record's terms, fixed at the first appearance;
   the stored rating starts there), the rating moved toward the prior by time
   (the step layoff of 1.0/1.1, or the smooth one; the recency half-life) and
   by a division change, then the price-only terms (short-sample shrinkage,
   age, division step, head to head, the champion). The facts it reads
   (age, division step, pre-UFC record) are factors.ts's, from
   model_loop/data/ufc/fighter_facts.csv, the file the loop reads too. With
   none of them set, walk() is the 1.1.0 walk above, unchanged.
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../../core/csv.ts';
import { sha256Hex } from '../../core/canonical.ts';
import { computeFactors, loadFighterFacts, FIGHTER_FACTS_CSV, type BoutFacts, type FighterFact } from './factors.ts';

export const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
export const BOUTS_CSV = 'model_loop/data/ufc/bouts.csv';
export const CURRENT_JSON = 'model_loop/published/ufc/current.json';
export const VERSIONS_JSON = 'docs/model-loop/ufc/versions.json';
export const FINAL = 'STATUS_FINAL';
const DAY_MS = 86400000;

/** the code and parameters a priced UFC bout depends on: hashed into every snapshot */
export const UFC_CODE_FILES = ['model_loop/adapters/ufc/model.py', 'model_loop/adapters/ufc/loop.py', 'model_loop/adapters/ufc/factors.py', 'model_loop/adapters/ufc/guard.py', VERSIONS_JSON,
  'docs/model-loop/ufc/guard.json', 'simulator/src/sports/ufc/elo.ts', 'simulator/src/sports/ufc/factors.ts', 'simulator/src/sports/ufc/guard.ts'];
export function codeIdentity(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of UFC_CODE_FILES) { const p = path.join(REPO, f); out[f] = fs.existsSync(p) ? sha256Hex(fs.readFileSync(p)) : 'missing'; }
  return out;
}

export interface EloConfig {
  k: number; k_new_mult: number; new_bouts: number; layoff_days: number; layoff_regress: number; scale: number; calibration: string; champ_bonus?: number;
  /* the 2026-10 parameters (model.py DEFAULTS; every one off at its default) */
  debut_offset?: number; prior_rec?: number; prior_exp?: number; shrink_bouts?: number;
  layoff_mode?: string; layoff_span?: number; layoff_k_mult?: number; half_life_days?: number;
  age_slope?: number; age_knee?: number; age_slope2?: number; age_knee2?: number; young_slope?: number; young_knee?: number;
  div_regress?: number; div_up?: number; div_down?: number; h2h?: number; h2h_decay?: number;
}
/** model.py DEFAULTS: the served config is laid over them */
export const ELO_DEFAULTS: EloConfig = { k: 32, k_new_mult: 1, new_bouts: 3, layoff_days: 365, layoff_regress: 0, scale: 400, calibration: 'none', champ_bonus: 0,
  debut_offset: 0, prior_rec: 0, prior_exp: 0, shrink_bouts: 0, layoff_mode: 'step', layoff_span: 365, layoff_k_mult: 1, half_life_days: 0,
  age_slope: 0, age_knee: 33, age_slope2: 0, age_knee2: 36, young_slope: 0, young_knee: 26, div_regress: 0, div_up: 0, div_down: 0, h2h: 0, h2h_decay: 0.5 };
const EXTENSIONS = ['debut_offset', 'prior_rec', 'prior_exp', 'shrink_bouts', 'half_life_days', 'age_slope', 'age_slope2', 'young_slope', 'div_regress', 'div_up', 'div_down', 'h2h'] as const;
/** model.py extended(): does the configuration use any parameter added after 1.1.0's? */
export function extendedConfig(cfg: EloConfig): boolean {
  return EXTENSIONS.some((k) => Number(cfg[k] || 0) !== 0) || (cfg.layoff_mode || 'step') !== 'step' || Number(cfg.layoff_k_mult ?? 1) !== 1;
}
const REC_CENTRE = Math.log(12.0 / 4.0), EXP_CENTRE = Math.log(13.0);
/** model.py prior_of(): a fighter's starting rating from the record before the data (null: no record on file) */
export function priorOf(cfg: EloConfig, w: number | null, l: number | null): number {
  let mu = 1500.0 + Number(cfg.debut_offset || 0);
  if (w != null && l != null && Number.isFinite(w)) {
    const z = Math.log((w + 2.0) / (l + 2.0));
    mu += Number(cfg.prior_rec || 0) * (z - REC_CENTRE) + Number(cfg.prior_exp || 0) * (Math.log1p(w + l) - EXP_CENTRE);
  }
  return mu;
}
/** model.py age_points() */
export function agePoints(cfg: EloConfig, age: number | null): number {
  if (age == null || !Number.isFinite(age)) return 0.0;
  return Number(cfg.age_slope) * Math.max(0.0, age - Number(cfg.age_knee)) + Number(cfg.age_slope2) * Math.max(0.0, age - Number(cfg.age_knee2))
    + Number(cfg.young_slope) * Math.max(0.0, Number(cfg.young_knee) - age);
}
export const TITLE_BOUTS_CSV = 'model_loop/data/ufc/title_bouts.csv';

export interface ServedVersion { version: string; config: EloConfig; config_sha256: string; status: string; promoted_at: string; evidence: unknown }
/** the version every booked bout is also priced by, beside the served one (kept runnable for comparison: model loop COMPARE_VERSION) */
export const COMPARE_VERSION = '1.1.0';
/** any version's configuration from versions.json (null when it is not there) */
export function versionConfig(version: string): ServedVersion | null {
  const v = JSON.parse(fs.readFileSync(path.join(REPO, VERSIONS_JSON), 'utf8'));
  const x = (v.versions as any[]).find((y) => y.version === version);
  return x ? { version: x.version, config: { ...ELO_DEFAULTS, ...x.config }, config_sha256: x.config_sha256, status: x.status, promoted_at: x.promoted_at, evidence: x.evidence } : null;
}
export function servedVersion(): ServedVersion {
  const v = JSON.parse(fs.readFileSync(path.join(REPO, VERSIONS_JSON), 'utf8'));
  const cur = (v.versions as any[]).find((x) => x.version === v.current);
  if (!cur) throw new Error('docs/model-loop/ufc/versions.json names no current version');
  return { version: cur.version, config: { ...ELO_DEFAULTS, ...cur.config }, config_sha256: cur.config_sha256, status: cur.status, promoted_at: cur.promoted_at, evidence: cur.evidence };
}

/** one bout as the walk reads it (model_loop/data/ufc/bouts.csv columns) */
export interface Bout {
  bout_id: string; event_id: string; event_name: string; start_time: string; ts: number;
  fighter_a_id: string; fighter_a: string; fighter_b_id: string; fighter_b: string;
  a_winner: boolean; b_winner: boolean; status: string;
  /** the round and clock the bout ended at (finals), and the scheduled rounds (format_json regulation.periods) */
  round: number | null; clock: string | null; periods: number | null; weight_class: string;
  /** the defending champion's id in an undisputed title fight (title_bouts.csv), else absent */
  champ?: string;
}

/** model.py load(): parse, drop unparseable start times, order by (time, bout id) */
export function parseBoutsCsv(text: string): Bout[] {
  const rows: Bout[] = [];
  for (const r of parseCsv(text)) {
    const ts = Date.parse(String(r.start_time || ''));
    if (!Number.isFinite(ts)) continue;
    let periods: number | null = null;
    try { const f = JSON.parse(String(r.format_json || 'null')); periods = f && f.regulation && Number.isInteger(f.regulation.periods) ? f.regulation.periods : null; } catch (_) { periods = null; }
    rows.push({ bout_id: String(r.bout_id), event_id: String(r.event_id || ''), event_name: String(r.event_name || ''), start_time: String(r.start_time), ts,
      fighter_a_id: String(r.fighter_a_id || ''), fighter_a: String(r.fighter_a || ''), fighter_b_id: String(r.fighter_b_id || ''), fighter_b: String(r.fighter_b || ''),
      a_winner: String(r.a_winner).toLowerCase() === 'true', b_winner: String(r.b_winner).toLowerCase() === 'true', status: String(r.status || ''),
      round: r.round != null && r.round !== '' ? Number(r.round) : null, clock: r.clock || null, periods, weight_class: String(r.weight_class || '') });
  }
  return sortBouts(rows);
}
export function sortBouts(rows: Bout[]): Bout[] {
  return rows.sort((a, b) => (a.ts !== b.ts ? a.ts - b.ts : a.bout_id < b.bout_id ? -1 : a.bout_id > b.bout_id ? 1 : 0));
}
export function loadServedBouts(): { bouts: Bout[]; sha256: string; titles_sha256: string | null } {
  const buf = fs.readFileSync(path.join(REPO, BOUTS_CSV));
  const t = loadTitleChampions();
  return { bouts: attachChampions(parseBoutsCsv(buf.toString('utf8')), t.map), sha256: sha256Hex(buf), titles_sha256: t.sha256 };
}
/** model.py title_champions(): bout id -> the champion going in, from title_bouts.csv beside the bouts (empty when absent) */
export function loadTitleChampions(): { map: Map<string, string>; sha256: string | null } {
  const f = path.join(REPO, TITLE_BOUTS_CSV);
  if (!fs.existsSync(f)) return { map: new Map(), sha256: null };
  const buf = fs.readFileSync(f);
  return { map: new Map(parseCsv(buf.toString('utf8')).map((r) => [String(r.bout_id), String(r.champion_id)])), sha256: sha256Hex(buf) };
}
export function attachChampions(bouts: Bout[], map: Map<string, string>): Bout[] {
  for (const b of bouts) { const c = map.get(b.bout_id); if (c) b.champ = c; else delete b.champ; }
  return bouts;
}

/** the walk's ratings at any point: rating, absorbed bouts, last absorbed bout time (ms); the extended walk adds each
    fighter's prior (MU) and each pair's earlier residuals (PAIR, from the lower id's side) */
export interface EloState { R: Map<string, number>; N: Map<string, number>; last: Map<string, number>; MU?: Map<string, number>; PAIR?: Map<string, number[]> }
export function emptyState(): EloState { return { R: new Map(), N: new Map(), last: new Map(), MU: new Map(), PAIR: new Map() }; }

/** model.py rating(f, t): the stored rating, regressed toward 1500 after a layoff (and the regression STORED) */
export function rating(S: EloState, cfg: EloConfig, f: string, t: number): number {
  let r = S.R.has(f) ? (S.R.get(f) as number) : 1500;
  const lt = S.last.get(f);
  if (lt !== undefined && cfg.layoff_regress && Math.floor((t - lt) / DAY_MS) >= cfg.layoff_days) {
    r = 1500 + (r - 1500) * (1 - cfg.layoff_regress);
    S.R.set(f, r);
  }
  return r;
}
/** the served price of a bout from two ratings (calibration "none") */
export function expectA(cfg: EloConfig, ra: number, rb: number): number {
  return 1 / (1 + 10 ** (-(ra - rb) / cfg.scale));
}

export interface WalkRow { bout: Bout; p: number; a_bouts: number; b_bouts: number; final: boolean; y: number | null; draw: boolean }
/** model.py walk(): one causal pass over every bout; mutates and returns the state. A configuration with a 2026-10
    parameter needs each bout's facts (computeFactors over the same bouts, in the same order). */
export function walk(bouts: Bout[], cfg: EloConfig, S: EloState = emptyState(), fx: BoutFacts[] | null = null): { rows: WalkRow[]; state: EloState } {
  if (cfg.calibration !== 'none') throw new Error('the served UFC calibration is "' + cfg.calibration + '": only "none" is ported (model.py calibrate)');
  const full = { ...ELO_DEFAULTS, ...cfg };
  if (extendedConfig(full)) return walkExtended(bouts, full, S, fx);
  const rows: WalkRow[] = [];
  for (const b of bouts) {
    const a = b.fighter_a_id, bb = b.fighter_b_id, t = b.ts;
    const ra = rating(S, cfg, a, t), rb = rating(S, cfg, bb, t);
    const cb = cfg.champ_bonus || 0;
    const adj = cb && b.champ ? (b.champ === a ? cb : b.champ === bb ? -cb : 0) : 0;
    const e = expectA(cfg, ra + adj, rb);
    const final = b.status === FINAL;
    const y = final && b.a_winner && !b.b_winner ? 1 : final && b.b_winner && !b.a_winner ? 0 : null;
    const draw = final && !b.a_winner && !b.b_winner;
    const na = S.N.get(a) || 0, nb = S.N.get(bb) || 0;
    rows.push({ bout: b, p: e, a_bouts: na, b_bouts: nb, final, y, draw });
    if (final && (y != null || draw)) {
      const s = draw ? 0.5 : (y as number);
      const ka = cfg.k * (na < cfg.new_bouts ? cfg.k_new_mult : 1);
      const kb = cfg.k * (nb < cfg.new_bouts ? cfg.k_new_mult : 1);
      S.R.set(a, ra + ka * (s - e));
      S.R.set(bb, rb - kb * (s - e));
      S.N.set(a, na + 1);
      S.N.set(bb, nb + 1);
      S.last.set(a, t); S.last.set(bb, t);
    }
  }
  return { rows, state: S };
}

/** model.py _walk_extended(): the same arithmetic in the same order */
function walkExtended(bouts: Bout[], P: EloConfig, S: EloState, fx: BoutFacts[] | null): { rows: WalkRow[]; state: EloState } {
  const needs = ['prior_rec', 'prior_exp', 'age_slope', 'age_slope2', 'young_slope', 'div_regress', 'div_up', 'div_down'] as const;
  if (!fx && needs.some((k) => Number(P[k] || 0) !== 0)) throw new Error('this UFC configuration reads each bout\'s facts: pass computeFactors(bouts, facts)');
  if (fx && fx.length !== bouts.length) throw new Error('the facts must be computed over the same bouts, in the same order');
  if (!S.MU) S.MU = new Map();
  if (!S.PAIR) S.PAIR = new Map();
  const MU = S.MU, PAIR = S.PAIR;
  const k = Number(P.k), scale = Number(P.scale), step = (P.layoff_mode || 'step') === 'step';
  const lr = Number(P.layoff_regress), ld = Number(P.layoff_days), ls = Number(P.layoff_span), lk = Number(P.layoff_k_mult);
  const hl = Number(P.half_life_days), sb = Number(P.shrink_bouts), dvr = Number(P.div_regress);
  const dup = Number(P.div_up), ddn = Number(P.div_down), h2h = Number(P.h2h), h2d = Number(P.h2h_decay), cb = Number(P.champ_bonus || 0);
  const useAge = [P.age_slope, P.age_slope2, P.young_slope].some((x) => Number(x) !== 0);
  const rows: WalkRow[] = [];
  const state = (f: string, t: number, F: BoutFacts | null, side: 'a' | 'b'): [number, number, number, boolean] => {
    if (!MU.has(f)) {
      const w = F ? (side === 'a' ? F.pre_w_a : F.pre_w_b) : null, l = F ? (side === 'a' ? F.pre_l_a : F.pre_l_b) : null;
      MU.set(f, priorOf(P, w, w != null ? l : null));
      S.R.set(f, MU.get(f) as number);
    }
    const mu = MU.get(f) as number, n = S.N.get(f) || 0, lt = S.last.get(f);
    let r = S.R.get(f) as number, longOff = false;
    if (lt !== undefined) {
      const days = Math.floor((t - lt) / DAY_MS);
      longOff = days >= ld;
      if (step) {
        if (lr && longOff) { r = 1500.0 + (r - 1500.0) * (1.0 - lr); S.R.set(f, r); }
        if (hl) r = mu + (r - mu) * 0.5 ** (days / hl);
      } else {
        let dev = r - mu;
        if (lr && days > ld) dev *= 1.0 - lr * Math.min(1.0, (days - ld) / ls);
        if (hl) dev *= 0.5 ** (days / hl);
        r = mu + dev;
      }
    }
    const ds = F ? (side === 'a' ? F.div_step_a : F.div_step_b) : null;
    if (dvr && ds) r = mu + (r - mu) * (1.0 - dvr);
    return [r, mu, n, longOff];
  };
  for (let i = 0; i < bouts.length; i++) {
    const b = bouts[i], F = fx ? fx[i] : null;
    const a = b.fighter_a_id, bb = b.fighter_b_id, t = b.ts;
    const [ra, mua, nA, offa] = state(a, t, F, 'a');
    const [rb, mub, nB, offb] = state(bb, t, F, 'b');
    const pa = sb ? mua + (ra - mua) * nA / (nA + sb) : ra;
    const pb = sb ? mub + (rb - mub) * nB / (nB + sb) : rb;
    let adj = 0.0;
    if (useAge && F) adj += agePoints(P, F.age_a) - agePoints(P, F.age_b);
    if ((dup || ddn) && F) for (const [sgn, ds] of [[1.0, F.div_step_a], [-1.0, F.div_step_b]] as Array<[number, number | null]>) if (ds) adj += sgn * (ds > 0 ? dup * ds : ddn * -ds);
    const lo = a < bb ? a : bb, key = a < bb ? a + '|' + bb : bb + '|' + a;
    if (h2h && PAIR.has(key)) {
      let res = 0.0, wgt = 1.0;
      const hist = PAIR.get(key) as number[];
      for (let j = hist.length - 1; j >= 0; j--) { res += wgt * hist[j]; wgt *= h2d; }
      adj += h2h * (a === lo ? res : -res);
    }
    if (cb && b.champ) adj += b.champ === a ? cb : b.champ === bb ? -cb : 0.0;
    const e = 1.0 / (1.0 + 10 ** (-(pa - pb + adj) / scale));
    const final = b.status === FINAL;
    const y = final && b.a_winner && !b.b_winner ? 1 : final && b.b_winner && !b.a_winner ? 0 : null;
    const draw = final && !b.a_winner && !b.b_winner;
    rows.push({ bout: b, p: e, a_bouts: nA, b_bouts: nB, final, y, draw });
    if (final && (y != null || draw)) {
      const s = draw ? 0.5 : (y as number);
      const ka = k * (nA < P.new_bouts ? P.k_new_mult : 1.0) * (offa ? lk : 1.0);
      const kb = k * (nB < P.new_bouts ? P.k_new_mult : 1.0) * (offb ? lk : 1.0);
      S.R.set(a, ra + ka * (s - e));
      S.R.set(bb, rb - kb * (s - e));
      S.N.set(a, nA + 1); S.N.set(bb, nB + 1);
      S.last.set(a, t); S.last.set(bb, t);
      const list = PAIR.get(key) || [];
      list.push(a === lo ? s - e : -(s - e));
      PAIR.set(key, list);
    }
  }
  return { rows, state: S };
}

/** the served walk's inputs beside the bouts: each bout's facts when the configuration reads them */
export function factorsFor(bouts: Bout[], cfg: EloConfig, facts: Map<string, FighterFact>): BoutFacts[] | null {
  return extendedConfig({ ...ELO_DEFAULTS, ...cfg }) ? computeFactors(bouts, facts) : null;
}
export { loadFighterFacts, computeFactors, FIGHTER_FACTS_CSV, type BoutFacts, type FighterFact };

/** Python round(x, 4) for the published file (ties are measure-zero for these values) */
export const round4 = (x: number): number => Number(x.toFixed(4));

export interface ReproductionCheck {
  file: string; generated_at: string; served_version: string; config_sha256: string;
  published: number; reproduced: number; max_abs_diff: number;
  mismatches: Array<{ bout_id: string; published: number; ported: number | null; why: string }>;
  /** scheduled bouts the walk prices inside the published window that the file does not list (or the reverse) */
  window_missing: string[]; window_extra: string[];
}
/** the port against the loop's published prices: same bouts, same fighters, same bout counts, same p_a to 4 decimals */
export function checkReproduction(rows: WalkRow[], current: any, sv: ServedVersion): ReproductionCheck {
  const by = new Map(rows.map((r) => [r.bout.bout_id, r]));
  const out: ReproductionCheck = { file: CURRENT_JSON, generated_at: String(current.generated_at || ''), served_version: String(current.served && current.served.version || ''),
    config_sha256: String(current.config_sha256 || ''), published: 0, reproduced: 0, max_abs_diff: 0, mismatches: [], window_missing: [], window_extra: [] };
  if (out.served_version !== sv.version) out.mismatches.push({ bout_id: '*', published: NaN, ported: null, why: 'the file was published by ' + out.served_version + ', the served version is ' + sv.version });
  if (out.config_sha256 !== sv.config_sha256) out.mismatches.push({ bout_id: '*', published: NaN, ported: null, why: 'config sha256 differs from versions.json' });
  const listed = new Set<string>();
  for (const b of (current.bouts || []) as any[]) {
    out.published++;
    listed.add(String(b.bout_id));
    const r = by.get(String(b.bout_id));
    if (!r) { out.mismatches.push({ bout_id: b.bout_id, published: b.p_a, ported: null, why: 'not in the data' }); continue; }
    const why: string[] = [];
    if (r.bout.fighter_a_id !== String(b.fighter_a.id) || r.bout.fighter_b_id !== String(b.fighter_b.id)) why.push('fighters differ');
    if (r.a_bouts !== b.fighter_a.ufc_bouts_in_data || r.b_bouts !== b.fighter_b.ufc_bouts_in_data) why.push('bout counts differ (' + r.a_bouts + '/' + r.b_bouts + ' v ' + b.fighter_a.ufc_bouts_in_data + '/' + b.fighter_b.ufc_bouts_in_data + ')');
    if (round4(r.p) !== b.p_a) why.push('p_a differs');
    out.max_abs_diff = Math.max(out.max_abs_diff, Math.abs(r.p - b.p_a));
    if (why.length) out.mismatches.push({ bout_id: b.bout_id, published: b.p_a, ported: round4(r.p), why: why.join('; ') });
    else out.reproduced++;
  }
  /* loop.py refresh: every scheduled bout from the generation time through 14 days later */
  const g = Date.parse(out.generated_at);
  if (Number.isFinite(g)) for (const r of rows) {
    const inWin = r.bout.status === 'STATUS_SCHEDULED' && r.bout.ts >= g && r.bout.ts <= g + 14 * DAY_MS;
    if (inWin && !listed.has(r.bout.bout_id)) out.window_missing.push(r.bout.bout_id);
  }
  for (const id of listed) { const r = by.get(id); if (r && r.bout.status !== 'STATUS_SCHEDULED') out.window_extra.push(id); }
  out.max_abs_diff = Math.round(out.max_abs_diff * 1e9) / 1e9;
  return out;
}
export function loadCurrent(): { doc: any; sha256: string } {
  const buf = fs.readFileSync(path.join(REPO, CURRENT_JSON));
  return { doc: JSON.parse(buf.toString('utf8')), sha256: sha256Hex(buf) };
}
