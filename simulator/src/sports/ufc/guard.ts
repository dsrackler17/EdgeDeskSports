/* ===========================================================================
   THE UFC MARKET DISAGREEMENT GUARD — the simulator's copy of
   model_loop/adapters/ufc/guard.py, applying the same file
   (docs/model-loop/ufc/guard.json) to every booked bout the simulator
   prices, including the cards beyond the loop's 14-day window.

     market   research/clv/openers/ufc/<YYYY-MM>.jsonl: DraftKings' latest
              pregame moneyline for the bout as ESPN shows it (observed_at
              stamped, captured hourly by the clv-openers workflow), the
              margin removed multiplicatively (market.py latest_quotes)
     verdict  |model - market| above threshold_pp: DISAGREES, labelled
              "Model disagrees with market", with the factors that likely
              explain it (factors.ts) and the served version's measured
              record on each (the study's diagnosis of that version)
     signal   allowed only when the loop's published certification
              (current.json guard.certification, from the study) says gaps
              that size beat the closing line; otherwise never

   The run gate guard.agrees checks this copy against the loop's verdicts for
   every bout both list.
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { sha256Hex } from '../../core/canonical.ts';
import type { BoutFacts } from './factors.ts';

export const GUARD_JSON = 'docs/model-loop/ufc/guard.json';
export const OPENERS_DIR = 'research/clv/openers/ufc';
export const STUDY_DIR = 'docs/model-loop/ufc/study';
export const LABEL = 'Model disagrees with market';
const MAX_OVERROUND = 0.15;

export interface GuardConfig { threshold_pp: number; factors: { short_sample_bouts: number; layoff_days: number; age_years: number; age_gap_years: number }; certify: { min_n: number; requires_timestamped_close: boolean; rule: string } }
export function loadGuardConfig(repo: string): { cfg: GuardConfig; sha256: string } {
  const buf = fs.readFileSync(path.join(repo, GUARD_JSON));
  return { cfg: JSON.parse(buf.toString('utf8')), sha256: sha256Hex(buf) };
}

/* ------------------------------------------------------------ the market */
export function americanToProb(o: number): number {
  if (!Number.isFinite(o) || Math.abs(o) < 100) return NaN;
  return o < 0 ? -o / (-o + 100) : 100 / (o + 100);
}
export interface Quote { book: string | null; observed_at: string; ml_home: number; ml_away: number; home_id: string; away_id: string; p_home: number; overround: number; source: string }
/** market.py latest_quotes(): bout id -> the latest two-way quote in the openers ledger (and the files read, hashed) */
export function latestQuotes(repo: string): { quotes: Map<string, Quote>; files: Array<{ name: string; sha256: string }> } {
  const dir = path.join(repo, OPENERS_DIR);
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^20\d\d-\d\d\.jsonl$/.test(f)).sort() : [];
  const events = new Map<string, any>(), latest = new Map<string, any>(), files: Array<{ name: string; sha256: string }> = [];
  for (const f of names) {
    const buf = fs.readFileSync(path.join(dir, f));
    files.push({ name: OPENERS_DIR + '/' + f, sha256: sha256Hex(buf) });
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      const x = JSON.parse(line);
      if (x.kind === 'event') events.set(String(x.cid), x);
      else if (x.kind === 'quote' && x.ml && typeof x.ml === 'object') { const prev = latest.get(String(x.cid)); if (!prev || x.observed_at >= prev.observed_at) latest.set(String(x.cid), x); }
    }
  }
  const quotes = new Map<string, Quote>();
  for (const [cid, q] of latest) {
    const e = events.get(cid);
    if (!e || !e.home || !e.away) continue;
    const qa = americanToProb(Number(q.ml.home)), qb = americanToProb(Number(q.ml.away));
    const ph = qa / (qa + qb), ov = qa + qb - 1;
    if (!Number.isFinite(ph) || !(ov >= 0 && ov <= MAX_OVERROUND)) continue;
    quotes.set(cid, { book: q.book ?? null, observed_at: q.observed_at, ml_home: Number(q.ml.home), ml_away: Number(q.ml.away), home_id: String(e.home.id), away_id: String(e.away.id), p_home: ph, overround: ov,
      source: 'research/clv/openers/ufc (DraftKings via ESPN, captured by the clv-openers workflow)' });
  }
  return { quotes, files };
}
export interface Market { p_a: number; p_b: number; price_a: number; price_b: number; book: string | null; observed_at: string; overround: number; no_vig: 'multiplicative'; source: string }
/** market.py quote_for(): the quote read from fighter a's side, or null when the ids do not match */
export function marketFor(q: Quote | undefined, a: string): Market | null {
  if (!q) return null;
  const r4 = (x: number) => Number(x.toFixed(4));
  const mk = (p: number, pa: number, pb: number): Market => ({ p_a: r4(p), p_b: r4(1 - p), price_a: pa, price_b: pb, book: q.book, observed_at: q.observed_at, overround: r4(q.overround), no_vig: 'multiplicative', source: q.source });
  if (q.home_id === a) return mk(q.p_home, q.ml_home, q.ml_away);
  if (q.away_id === a) return mk(1 - q.p_home, q.ml_away, q.ml_home);
  return null;
}

/* ------------------------------------------------------------ the factors */
export interface FactorNote { code: string; fighter: string | null; text: string; record: { n: number; model_said: number | null; close_said: number | null; won: number | null } | null }
/** guard.py evidence_for(): the served version's measured record by factor (its diagnosis), or {} */
export function evidenceFor(repo: string, version: string): any {
  const f = path.join(repo, STUDY_DIR, 'diagnosis_' + version + '.json');
  if (!fs.existsSync(f)) return {};
  return JSON.parse(fs.readFileSync(f, 'utf8')).breakdowns || {};
}
function rec(ev: any, group: string, bucket: string): FactorNote['record'] {
  for (const r of ((ev[group] || {}).rows || [])) if (r.bucket === bucket && r.n_close) return { n: r.n_close, model_said: r.model_said_close_subset ?? null, close_said: r.close_said ?? null, won: r.won_close_subset ?? null };
  return null;
}
/** guard.py explain(): the factors present in this bout that the model is known to misread */
export function explain(nameA: string, nameB: string, F: BoutFacts, ev: any, cfg: GuardConfig): FactorNote[] {
  const C = cfg.factors, out: FactorNote[] = [];
  const sides: Array<[string, { n: number; off: number | null; age: number | null; step: number | null; w: number | null; l: number | null }]> = [
    [nameA, { n: F.n_a, off: F.days_off_a, age: F.age_a, step: F.div_step_a, w: F.pre_w_a, l: F.pre_l_a }],
    [nameB, { n: F.n_b, off: F.days_off_b, age: F.age_b, step: F.div_step_b, w: F.pre_w_b, l: F.pre_l_b }]];
  for (const [nm, f] of sides) {
    if (f.n === 0) out.push({ code: 'debut', fighter: nm, text: nm + ' makes a UFC debut: the model has no UFC bout to rate', record: rec(ev, 'debutants', 'one debutant') });
    else if (f.n <= C.short_sample_bouts) {
      const pro = f.w != null && f.l != null ? ' (pro record before the UFC ' + f.w + '-' + f.l + ')' : '';
      out.push({ code: 'short_sample', fighter: nm, text: nm + ' has ' + f.n + ' UFC bout' + (f.n !== 1 ? 's' : '') + ' in the data' + pro + ': a short sample', record: rec(ev, 'ufc_sample', f.n <= 2 ? '1-2' : '3-5') });
    }
  }
  for (const [nm, f] of sides) if (f.off != null && f.off >= C.layoff_days) out.push({ code: 'layoff', fighter: nm, text: nm + ' returns after ' + f.off + ' days out', record: rec(ev, 'layoff', f.off < 540 ? '365-539' : '540+') });
  for (const [nm, f] of sides) if (f.age != null && f.age >= C.age_years) out.push({ code: 'age', fighter: nm, text: nm + ' is ' + f.age.toFixed(1) + ', past ' + C.age_years + ': how much age has taken is where the model and the market most often differ', record: rec(ev, 'age', f.age < 37 ? '35-36' : '37+') });
  const aa = F.age_a, ab = F.age_b;
  if (aa != null && ab != null && Math.abs(aa - ab) >= C.age_gap_years && !out.some((x) => x.code === 'age')) {
    const old = aa > ab ? nameA : nameB;
    out.push({ code: 'age_gap', fighter: old, text: old + ' is ' + Math.abs(aa - ab).toFixed(1) + ' years older', record: rec(ev, 'age', 'older by 5+ years') });
  }
  for (const [nm, f] of sides) if (f.step) {
    const k = Math.abs(f.step);
    out.push({ code: 'weight_change', fighter: nm, text: nm + ' moves ' + (f.step > 0 ? 'up' : 'down') + ' ' + k + ' division' + (k > 1 ? 's' : '') + ': the rating was earned at another weight', record: rec(ev, 'division_change', f.step > 0 ? 'moved up' : 'moved down') });
  }
  if (F.meet) {
    const who = F.meet_last === 1 ? nameA : F.meet_last === 0 ? nameB : null;
    out.push({ code: 'rematch', fighter: who, text: 'a rematch (' + F.meet + ' earlier meeting' + (F.meet > 1 ? 's' : '') + (who ? '; ' + who + ' won the last)' : '; the last had no winner)'), record: rec(ev, 'rematches', "rematch: read from the last meeting's winner") });
  }
  return out;
}

export interface GuardVerdict { status: 'DISAGREES' | 'AGREES' | 'NO_MARKET'; label: string; threshold_pp: number; gap_pp: number | null; signal_allowed: boolean; factors: FactorNote[]; certified: boolean; note: string | null }
/** guard.py assess() */
export function assess(pA: number, market: Market | null, factors: FactorNote[], certified: boolean, cfg: GuardConfig): GuardVerdict {
  const th = cfg.threshold_pp;
  if (!market) return { status: 'NO_MARKET', label: 'No market price on file', threshold_pp: th, gap_pp: null, signal_allowed: false, factors, certified, note: null };
  const gap = 100.0 * (pA - market.p_a), dis = Math.abs(gap) > th;
  return { status: dis ? 'DISAGREES' : 'AGREES', label: dis ? LABEL : 'Model and market agree within the threshold', threshold_pp: th, gap_pp: Math.round(gap * 10) / 10,
    signal_allowed: dis && certified, factors: dis ? factors : [], certified,
    note: dis ? (certified ? 'A gap this size has been certified to beat the closing line.' : "Not an edge: gaps this size have historically resolved in the market's favour, or have not been certified to beat the close.") : null };
}
