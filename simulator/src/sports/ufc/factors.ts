/* ===========================================================================
   POINT-IN-TIME FACTS BEFORE EVERY BOUT — the port of
   model_loop/adapters/ufc/factors.py (one causal pass in the walk's order).

   Per fighter, fixed facts from model_loop/data/ufc/fighter_facts.csv (both
   the loop and this port read the same file, so a price depends on nothing
   the two could read differently): the date of birth, and the professional
   record before the fighter's first bout in the data (ESPN's record as of a
   stated time less every later result in the data; see factors.py for what
   that cannot see).

   Per bout and side: the age at the bout (whole days / 365.25, as Python's
   Timedelta.days), the divisions moved since the last absorbed bout at a
   standard weight (+ up, - down; men's and women's apart), the pre-data
   record, the UFC wins and losses in the data before the bout; per bout:
   earlier absorbed meetings of the two and fighter a's result in the
   latest. The walk (elo.ts) reads the age, the division step, the records;
   the guard (guard.ts) reads them all.
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { parseCsv } from '../../core/csv.ts';
import { sha256Hex } from '../../core/canonical.ts';
import type { Bout } from './elo.ts';

export const FIGHTER_FACTS_CSV = 'model_loop/data/ufc/fighter_facts.csv';
const DAY = 86400000;
/** factors.py DIVISIONS: [gender, order] */
export const DIVISION_ORDER: Record<string, [string, number]> = {
  Flyweight: ['M', 0], Bantamweight: ['M', 1], Featherweight: ['M', 2], Lightweight: ['M', 3], Welterweight: ['M', 4], Middleweight: ['M', 5],
  'Light Heavyweight': ['M', 6], Heavyweight: ['M', 7], 'W Strawweight': ['W', 0], 'W Flyweight': ['W', 1], 'W Bantamweight': ['W', 2], 'W Featherweight': ['W', 3]
};

export interface FighterFact { dob: number | null; pre_w: number | null; pre_l: number | null; pre_source: string }
export function parseFighterFacts(text: string): Map<string, FighterFact> {
  const m = new Map<string, FighterFact>();
  const n = (v: unknown): number | null => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  for (const r of parseCsv(text)) {
    const dob = r.date_of_birth ? Date.parse(String(r.date_of_birth).slice(0, 10) + 'T00:00:00Z') : NaN;
    m.set(String(r.fighter_id), { dob: Number.isFinite(dob) ? dob : null, pre_w: n(r.pre_w), pre_l: n(r.pre_l), pre_source: String(r.pre_source || '') });
  }
  return m;
}
export function loadFighterFacts(repo: string): { map: Map<string, FighterFact>; sha256: string | null } {
  const f = path.join(repo, FIGHTER_FACTS_CSV);
  if (!fs.existsSync(f)) return { map: new Map(), sha256: null };
  const buf = fs.readFileSync(f);
  return { map: parseFighterFacts(buf.toString('utf8')), sha256: sha256Hex(buf) };
}

export interface BoutFacts {
  n_a: number; n_b: number; days_off_a: number | null; days_off_b: number | null;
  age_a: number | null; age_b: number | null; div_step_a: number | null; div_step_b: number | null;
  pre_w_a: number | null; pre_l_a: number | null; pre_w_b: number | null; pre_l_b: number | null;
  /** UFC wins and losses in the data before the bout (decisions with a winner) */
  uw_a: number; ul_a: number; uw_b: number; ul_b: number;
  meet: number; meet_last: number | null;
}
/** factors.py compute(): one row per bout, in the bouts' order (which must be the walk's) */
export function computeFactors(bouts: Bout[], facts: Map<string, FighterFact>): BoutFacts[] {
  const n = new Map<string, number>(), last = new Map<string, number>(), lastDiv = new Map<string, [string, number]>(), meets = new Map<string, Array<string | null>>();
  const uw = new Map<string, number>(), ul = new Map<string, number>();
  const out: BoutFacts[] = [];
  for (const b of bouts) {
    const a = b.fighter_a_id, bb = b.fighter_b_id, t = b.ts, dn = DIVISION_ORDER[b.weight_class];
    const side = (f: string) => {
      const lt = last.get(f), F = facts.get(f), ld = lastDiv.get(f);
      return { n: n.get(f) || 0, off: lt === undefined ? null : Math.floor((t - lt) / DAY),
        age: F && F.dob != null ? Math.floor((t - F.dob) / DAY) / 365.25 : null,
        step: ld && dn && ld[0] === dn[0] ? dn[1] - ld[1] : null, w: F ? F.pre_w : null, l: F ? F.pre_l : null };
    };
    const A = side(a), B = side(bb);
    const key = a < bb ? a + '|' + bb : bb + '|' + a;
    const hist = meets.get(key) || [];
    const lastW = hist.length ? hist[hist.length - 1] : undefined;
    out.push({ n_a: A.n, n_b: B.n, days_off_a: A.off, days_off_b: B.off, age_a: A.age, age_b: B.age, div_step_a: A.step, div_step_b: B.step,
      pre_w_a: A.w, pre_l_a: A.l, pre_w_b: B.w, pre_l_b: B.l, uw_a: uw.get(a) || 0, ul_a: ul.get(a) || 0, uw_b: uw.get(bb) || 0, ul_b: ul.get(bb) || 0, meet: hist.length,
      meet_last: lastW === undefined ? null : lastW === null ? 0.5 : lastW === a ? 1 : 0 });
    const final = b.status === 'STATUS_FINAL';
    const y = final && b.a_winner && !b.b_winner ? 1 : final && b.b_winner && !b.a_winner ? 0 : null;
    const draw = final && !b.a_winner && !b.b_winner;
    if (final && (y != null || draw)) {
      for (const f of [a, bb]) { n.set(f, (n.get(f) || 0) + 1); last.set(f, t); if (dn) lastDiv.set(f, dn); }
      hist.push(draw ? null : y === 1 ? a : bb);
      if (!draw) { const win = y === 1 ? a : bb, lose = y === 1 ? bb : a; uw.set(win, (uw.get(win) || 0) + 1); ul.set(lose, (ul.get(lose) || 0) + 1); }
      meets.set(key, hist);
    }
  }
  return out;
}
