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
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../../core/csv.ts';
import { sha256Hex } from '../../core/canonical.ts';

export const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
export const BOUTS_CSV = 'model_loop/data/ufc/bouts.csv';
export const CURRENT_JSON = 'model_loop/published/ufc/current.json';
export const VERSIONS_JSON = 'docs/model-loop/ufc/versions.json';
export const FINAL = 'STATUS_FINAL';
const DAY_MS = 86400000;

/** the code and parameters a priced UFC bout depends on: hashed into every snapshot */
export const UFC_CODE_FILES = ['model_loop/adapters/ufc/model.py', 'model_loop/adapters/ufc/loop.py', VERSIONS_JSON, 'simulator/src/sports/ufc/elo.ts'];
export function codeIdentity(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of UFC_CODE_FILES) { const p = path.join(REPO, f); out[f] = fs.existsSync(p) ? sha256Hex(fs.readFileSync(p)) : 'missing'; }
  return out;
}

export interface EloConfig { k: number; k_new_mult: number; new_bouts: number; layoff_days: number; layoff_regress: number; scale: number; calibration: string; champ_bonus?: number }
/** model.py DEFAULTS: the served config is laid over them */
export const ELO_DEFAULTS: EloConfig = { k: 32, k_new_mult: 1, new_bouts: 3, layoff_days: 365, layoff_regress: 0, scale: 400, calibration: 'none', champ_bonus: 0 };
export const TITLE_BOUTS_CSV = 'model_loop/data/ufc/title_bouts.csv';

export interface ServedVersion { version: string; config: EloConfig; config_sha256: string; status: string; promoted_at: string; evidence: unknown }
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

/** the walk's ratings at any point: rating, absorbed bouts, last absorbed bout time (ms) */
export interface EloState { R: Map<string, number>; N: Map<string, number>; last: Map<string, number> }
export function emptyState(): EloState { return { R: new Map(), N: new Map(), last: new Map() }; }

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
/** model.py walk(): one causal pass over every bout; mutates and returns the state */
export function walk(bouts: Bout[], cfg: EloConfig, S: EloState = emptyState()): { rows: WalkRow[]; state: EloState } {
  if (cfg.calibration !== 'none') throw new Error('the served UFC calibration is "' + cfg.calibration + '": only "none" is ported (model.py calibrate)');
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
