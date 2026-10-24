/* ===========================================================================
   THE UFC INPUT SNAPSHOT — everything a fights and title-path simulation
   reads, captured once, validated, frozen and hashed BEFORE the first
   simulated fight.

   Where every number comes from:
     history, ratings   model_loop/data/ufc/bouts.csv (the served model's own
                        data: ESPN's scoreboard, every UFC bout since 2014),
                        walked by the port of the served Elo (elo.ts), which
                        must reproduce model_loop/published/ufc/current.json
     schedule           simulator/data/feeds/ufc_bouts.json.gz (ESPN month by
                        month on a GitHub runner): every bout still to come,
                        its card, card order and scheduled rounds; a result
                        newer than bouts.csv is walked too
     champions, ranks   simulator/data/feeds/ufc_rankings.json (ufc.com/rankings;
                        the page's sha256 recorded and checked against the
                        saved page)
     title history      simulator/data/feeds/ufc_champions_wikipedia.html.gz
                        (title_history.ts): each division's title-fight rate,
                        the last title fight, the gaps' shape; matched to the
                        bouts for the champions' record against the Elo and
                        the challengers' last result and rest (the
                        matchmaking rule's measured inputs)
     endings            finish.ts over bouts.csv: finish v decision, rounds
     cross-checks       Wikipedia's incumbents and ESPN's title accolades
                        (simulator/data/feeds/ufc_espn_samples.json.gz) beside
                        ufc.com's champions
     fighter facts      model_loop/data/ufc/fighter_facts.csv (dates of birth
                        and pre-UFC records: the served model's inputs when its
                        configuration reads them, factors.ts)
     market, guard      research/clv/openers/ufc (DraftKings' latest no-vig
                        price per bout) and docs/model-loop/ufc/guard.json:
                        every booked bout's disagreement verdict (guard.ts)
     model record       docs/model-loop/ufc/study/comparison.json: the served
                        model, 1.1.0 and the closing line on the same bouts
   The snapshot's `data` is canonical and content-hashed (input_hash); `meta`
   carries what does not change a result. No network or database call
   happens here or after.
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { hashCanonical, sha256Hex } from '../../core/canonical.ts';
import { REPO, loadServedBouts, loadCurrent, servedVersion, walk, checkReproduction, sortBouts, emptyState, codeIdentity, FINAL, round4, attachChampions, loadTitleChampions, TITLE_BOUTS_CSV,
  factorsFor, loadFighterFacts, computeFactors, versionConfig, FIGHTER_FACTS_CSV, COMPARE_VERSION, type Bout, type EloState, type ReproductionCheck, type EloConfig, type WalkRow, type BoutFacts } from './elo.ts';
import { loadGuardConfig, latestQuotes, marketFor, explain, assess, evidenceFor, GUARD_JSON, type GuardVerdict, type Market } from './guard.ts';
import { parseTitleHistory, divisionRates, normalisedGaps, type DivisionRates, type DivisionHistory } from './title_history.ts';
import { priorOf } from './elo.ts';
import { finishStudy, baseRate, studyRoundDist, dev, DIVISIONS, type FinishStudy } from './finish.ts';
import { UFC_2026, type UfcConfig } from './config.ts';

export const UFC_INPUT_SCHEMA = 'edgedesk_sim_ufc_input_v1';
const DAY = 86400000;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** ufc.com division names -> the canonical (ESPN) names */
export const UFCCOM_DIVISION: Record<string, string> = {
  Flyweight: 'Flyweight', Bantamweight: 'Bantamweight', Featherweight: 'Featherweight', Lightweight: 'Lightweight', Welterweight: 'Welterweight',
  Middleweight: 'Middleweight', 'Light Heavyweight': 'Light Heavyweight', Heavyweight: 'Heavyweight',
  "Women's Strawweight": 'W Strawweight', "Women's Flyweight": 'W Flyweight', "Women's Bantamweight": 'W Bantamweight'
};
export const DIVISION_LABEL: Record<string, string> = Object.fromEntries(Object.entries(UFCCOM_DIVISION).map(([k, v]) => [v, k]));

export interface UfcFighter {
  id: string; name: string;
  /** the division whose title this fighter can win in a run (sum-rule group): the ranked one, the booked bout's after a move, else 'Other' */
  division: string;
  ranked_division: string | null; rank: number | null; champion: boolean;
  /** ranked in one division, booked in another (the schedule shows the move) */
  moved_from: string | null;
  /** the served Elo after every final through the as-of time (1500 and debut: true when the data hold no bout) */
  rating: number; bouts: number; debut: boolean;
  last_fight: string | null; last_result: 'W' | 'L' | 'D' | null;
  record: { w: number; l: number; d: number };
  /** the date of birth (fighter_facts.csv; null: none on file) and the served model's prior for the fighter (1500 under
      1.0/1.1): what an unbooked title fight is priced from beside the rating (module.ts) */
  dob: string | null; prior: number;
  /** shrunk finish tendencies (logit deviations): as a winner, as a loser (finish.ts) */
  fin_win: number; fin_loss: number;
}
export interface UfcBooked {
  bout_id: string; event_id: string; event: string; start: string; weight_class: string; division: string | null;
  rounds: number; order: number | null; a: string; b: string;
  /** the served Elo's P(a wins), from every final before the bout; the loop's published value when it lists the bout */
  p_a: number; p_a_published: number | null; basis: 'elo' | 'debut';
  title: { division: string; champion: string } | null;
  /** P(finish | a wins), P(finish | b wins), P(round k | finish) */
  finish_if_a: number; finish_if_b: number; round_dist: number[];
  /** the market's latest no-vig price for fighter a (null: none captured), and the disagreement guard's verdict (guard.ts) */
  market: Market | null; guard: GuardVerdict;
  /** the comparison version's price for the same bout (1.1.0, kept runnable), when it is not the served one */
  compare: { version: string; p_a: number } | null;
  /** each fighter's facts at the bout (factors.ts): UFC bouts, days out, age, divisions moved, pre-UFC record */
  facts: { a: { ufc_bouts: number; days_off: number | null; age: number | null; div_step: number | null; pre_w: number | null; pre_l: number | null };
    b: { ufc_bouts: number; days_off: number | null; age: number | null; div_step: number | null; pre_w: number | null; pre_l: number | null } };
}
export interface UfcDivision {
  key: string; label: string; champion: string;
  /** contenders in ufc.com order (ties in the page's order), the champion and fighters who moved out excluded */
  contenders: string[];
  moved_out: Array<{ id: string; to: string }>;
  rate: DivisionRates; mean_gap_days: number | null;
  /** the last booked title fight in the horizon, if any */
  booked_title: string | null;
  /** the first unbooked title fight comes `min_gap` days or more after `start` (the gap drawn conditionally) */
  renewal: { start: string; min_gap_days: number; basis: string };
  finish_5: number; round_dist_5: number[];
}
export interface TitleRecord {
  from: string; matched: number; unmatched: string[];
  /** undisputed title fights with a champion going in and a winner */
  decided: number; champion_won: number; elo_expected_champion_wins: number; log_loss: number; coin_log_loss: number;
  /** the same count split at TITLE_SPLIT: where the champions' edge over the Elo sits in time */
  periods: Array<{ from: string; to: string; decided: number; champion_won: number; elo_expected_champion_wins: number }>;
  challengers: { n: number; coming_off_win: number; coming_off_loss: number; coming_off_draw: number; rest_days: { p10: number; median: number; p90: number } };
}
export interface UfcInputData {
  sport: 'ufc'; season: number; competition: string;
  as_of: string; horizon: { from: string; to: string; days: number }; last_card: string | null;
  fighters: UfcFighter[]; bouts: UfcBooked[]; divisions: UfcDivision[];
  elo: { version: string; status: string; config: EloConfig; config_sha256: string; promoted_at: string; reproduction: ReproductionCheck;
    /** the booked bouts the loop priced: our price equals its published one when no newer final exists */
    published_agree: { listed: number; equal: number; newer_finals: number } };
  gaps: { shape: number; cv: number; n: number; from: string };
  matchmaking: { rule: string; min_rest_days: number };
  finish: { m: number; c: number | null; holdout_log_loss: number; base_only_log_loss: number; constant_log_loss: number; n_holdout: number;
    rounds_holdout: { chosen: number; format_only: number }; base: FinishStudy['base']; no_winner: FinishStudy['no_winner']; by_rounds: FinishStudy['rounds']['by_rounds'] };
  title_record: TitleRecord;
  /** the champion term's latest weekly test (docs/model-loop/ufc/candidates.jsonl, candidate champion_term); null before the first */
  champion_term: { tested_at: string; served_version: string; bonus: number; decision: string; delta: Record<string, number>; ci95: number[]; reason: string } | null;
  rankings: { url: string; fetched_at: string; page_sha256: string; html_sha256: string | null; groupings: number; divisions: number; deduped: number; pound_for_pound: number };
  title_history: { sha256: string; unparsed: string[]; window_years: number };
  cross_checks: { wikipedia: Array<{ division: string; ufc: string; wikipedia: string | null; agree: boolean }>; espn: Array<{ bout_id: string; division: string; holder: string; champion: string; agree: boolean }> };
  name_matching: { matched: number; unmatched: string[]; aliases: string[]; ambiguous: string[] };
  data_checks: { finals_csv: number; finals_feed_only: number; scheduled_feed: number; csv_scheduled_dropped: string[]; late: string[]; double_booked: string[] };
  health: { windows: Array<{ label: string; n: number; log_loss: number; coin: number; brier: number | null; favourite_p: number | null; favourite_won: number | null }>; market: string; record_graded: number;
    /** the 2026-10 study (docs/model-loop/ufc/study/comparison.json): the served model and 1.1.0 against the closing line */
    study: UfcStudy | null };
  /** the disagreement guard (docs/model-loop/ufc/guard.json; the loop's published certification) */
  guard: { threshold_pp: number; certified: boolean; certification_reasons: string[]; with_market: number; disagreements: number;
    /** the loop's verdicts on the bouts it lists, against this copy's */
    agree: { compared: number; same: number; differ: string[] } };
  code: Record<string, string>;
  config: { rules_version: string; horizon_days: number; rate_window_years: number; matchmaking: string; not_modelled: string[] };
}
export interface UfcStudy {
  generated_at: string; base_version: string; promoted: boolean; reasons: string[];
  reference: { name: string; kind: string; timestamped: boolean; matched: number; span: string[]; sha256: string | null };
  test: { window: number[]; n: number; old_log_loss: number; new_log_loss: number; delta_log_loss: number; ci95: number[] | null; delta_brier: number };
  /** per window: 1.1.0 and the selected model on every decided bout, and on the bouts with a closing line beside the line itself */
  windows: Array<{ key: string; label: string; n: number; old: { log_loss: number; brier: number }; new: { log_loss: number; brier: number };
    close_n: number; close_old: { log_loss: number; brier: number }; close_new: { log_loss: number; brier: number }; close: { log_loss: number; brier: number } }>;
  /** favourite-side reliability since 2018 on the bouts with a closing line: bins of [said, won, n] */
  calibration: { old: Array<{ bin: string; n: number; said: number; won: number }>; new: Array<{ bin: string; n: number; said: number; won: number }>; close: Array<{ bin: string; n: number; said: number; won: number }> };
  /** out-of-sample gaps (2021 on) between each model and the close, by size: who the result sided with */
  gaps: { old: any[]; new: any[]; over_threshold_old: any; over_threshold_new: any };
  steps: Array<{ step: string; label: string; decision: string; select_delta: number | null; fit_delta: number | null; chosen: Record<string, unknown> | null; reason: string }>;
}
export interface UfcSnapshot { schema: string; input_hash: string; data: UfcInputData; meta: { built_at: string; builder: string; feeds: Array<{ name: string; sha256: string }> } }

/* ------------------------------------------------------------ names */
export function normName(s: string): string {
  const t = String(s || '').replace(/[’‘`´]/g, "'").replace(/ł/g, 'l').replace(/Ł/g, 'L').replace(/ø/g, 'o').replace(/Ø/g, 'O').replace(/đ/g, 'd').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/-/g, ' ').replace(/[^a-z0-9 ]/g, '');
  return t.split(/\s+/).filter(Boolean).join(' ');
}
export const tokenKey = (s: string) => normName(s).split(' ').sort().join(' ');

/* ------------------------------------------------------------ feeds */
function gz(rel: string): Buffer { return zlib.gunzipSync(fs.readFileSync(path.join(REPO, rel))); }
export interface FeedBout { bout_id: string; event_id: string; event: string; date: string; weight_class: string | null; rounds: number | null; order: number | null;
  a_id: string; a: string; b_id: string; b: string; status: string; winner: string | null; end_round: number | null; end_time: string | null }
export function feedToBout(f: FeedBout): Bout {
  const fin = f.status === 'final';
  return { bout_id: String(f.bout_id), event_id: String(f.event_id), event_name: f.event, start_time: f.date, ts: Date.parse(f.date),
    fighter_a_id: String(f.a_id), fighter_a: f.a, fighter_b_id: String(f.b_id), fighter_b: f.b,
    a_winner: fin && f.winner === 'a', b_winner: fin && f.winner === 'b', status: fin ? FINAL : f.status === 'scheduled' ? 'STATUS_SCHEDULED' : 'STATUS_CANCELED',
    round: fin ? f.end_round : null, clock: fin ? f.end_time : null, periods: f.rounds, weight_class: f.weight_class || '' };
}
const cloneState = (S: EloState): EloState => ({ R: new Map(S.R), N: new Map(S.N), last: new Map(S.last), MU: new Map(S.MU || []),
  PAIR: new Map([...(S.PAIR || new Map()).entries()].map(([k, v]) => [k, v.slice()])) });

/** a fighter's last final before t from the walked rows: result and time */
function lastFinals(rows: WalkRow[], upTo: number): Map<string, { ts: number; result: 'W' | 'L' | 'D'; rec: { w: number; l: number; d: number } }> {
  const m = new Map<string, { ts: number; result: 'W' | 'L' | 'D'; rec: { w: number; l: number; d: number } }>();
  for (const r of rows) {
    if (!r.final || r.bout.ts > upTo) continue;
    const b = r.bout;
    for (const side of ['a', 'b'] as const) {
      const id = side === 'a' ? b.fighter_a_id : b.fighter_b_id;
      const won = side === 'a' ? b.a_winner && !b.b_winner : b.b_winner && !b.a_winner, lost = side === 'a' ? b.b_winner && !b.a_winner : b.a_winner && !b.b_winner;
      const x = m.get(id) || { ts: 0, result: 'D' as const, rec: { w: 0, l: 0, d: 0 } };
      x.ts = b.ts; x.result = won ? 'W' : lost ? 'L' : 'D';
      if (won) x.rec.w++; else if (lost) x.rec.l++; else x.rec.d++;
      m.set(id, x);
    }
  }
  return m;
}
function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b), i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

/** the title record's split: before it the champions beat the Elo by 16 wins in 100 fights, after it by about 1 in 87 (2026-10-23) */
export const TITLE_SPLIT = '2021-01-01';
/** the champions' record in undisputed title fights against the served Elo, and the challengers' last result and rest */
export function titleRecord(H: DivisionHistory[], rows: WalkRow[], from: string, asOf: number): TitleRecord {
  const finals = rows.filter((r) => r.final);
  const byDay = new Map<string, WalkRow[]>();
  for (const r of finals) { const d = isoDay(r.bout.ts); (byDay.get(d) || byDay.set(d, []).get(d)!).push(r); }
  const sur = (s: string) => { const t = normName(s).split(' '); return t[t.length - 1]; };
  const asOfDay = isoDay(asOf), split = TITLE_SPLIT > from ? TITLE_SPLIT : from;
  const periods = [{ from, to: isoDay(Date.parse(split + 'T00:00:00Z') - DAY), decided: 0, champion_won: 0, elo_expected_champion_wins: 0 },
    { from: split, to: asOfDay, decided: 0, champion_won: 0, elo_expected_champion_wins: 0 }].filter((x) => x.from <= x.to);
  const out: TitleRecord = { from, matched: 0, unmatched: [], decided: 0, champion_won: 0, elo_expected_champion_wins: 0, log_loss: 0, coin_log_loss: Math.LN2, periods,
    challengers: { n: 0, coming_off_win: 0, coming_off_loss: 0, coming_off_draw: 0, rest_days: { p10: NaN, median: NaN, p90: NaN } } };
  const rest: number[] = [];
  let ll = 0;
  for (const h of H) for (const f of h.fights) {
    if (f.interim || f.champion == null || f.date < from || Date.parse(f.date + 'T00:00:00Z') > asOf) continue;
    const t = Date.parse(f.date + 'T00:00:00Z');
    const cand: WalkRow[] = [];
    for (const k of [-1, 0, 1]) cand.push(...(byDay.get(isoDay(t + k * DAY)) || []));
    const kc = tokenKey(f.champion), kh = tokenKey(f.challenger);
    let hit = cand.find((r) => { const s = new Set([tokenKey(r.bout.fighter_a), tokenKey(r.bout.fighter_b)]); return s.has(kc) && s.has(kh); });
    if (!hit) hit = cand.find((r) => { const s = [sur(r.bout.fighter_a), sur(r.bout.fighter_b)]; return s.includes(sur(f.champion as string)) && s.includes(sur(f.challenger)); });
    if (!hit) { out.unmatched.push(f.division + ' ' + f.date + ' ' + f.champion + ' v ' + f.challenger); continue; }
    out.matched++;
    const champIsA = tokenKey(hit.bout.fighter_a) === kc || (tokenKey(hit.bout.fighter_b) !== kc && sur(hit.bout.fighter_a) === sur(f.champion));
    const pc = champIsA ? hit.p : 1 - hit.p;
    const chId = champIsA ? hit.bout.fighter_b_id : hit.bout.fighter_a_id;
    if (f.result === 'champion_won' || f.result === 'challenger_won') {
      const y = f.result === 'champion_won' ? 1 : 0;
      out.decided++; out.champion_won += y; out.elo_expected_champion_wins += pc;
      const per = periods.find((x) => f.date >= x.from && f.date <= x.to);
      if (per) { per.decided++; per.champion_won += y; per.elo_expected_champion_wins += pc; }
      ll += -Math.log(Math.min(1 - 1e-12, Math.max(1e-12, y ? pc : 1 - pc)));
    }
    /* the challenger's previous final */
    let prev: WalkRow | null = null;
    for (const r of finals) { if (r.bout.ts >= hit.bout.ts) break; if (r.bout.fighter_a_id === chId || r.bout.fighter_b_id === chId) prev = r; }
    if (prev) {
      out.challengers.n++;
      const isA = prev.bout.fighter_a_id === chId;
      const won = isA ? prev.bout.a_winner && !prev.bout.b_winner : prev.bout.b_winner && !prev.bout.a_winner;
      const lost = isA ? prev.bout.b_winner && !prev.bout.a_winner : prev.bout.a_winner && !prev.bout.b_winner;
      if (won) out.challengers.coming_off_win++; else if (lost) out.challengers.coming_off_loss++; else out.challengers.coming_off_draw++;
      rest.push(Math.floor((hit.bout.ts - prev.bout.ts) / DAY));
    }
  }
  out.elo_expected_champion_wins = r6(out.elo_expected_champion_wins);
  for (const x of periods) x.elo_expected_champion_wins = r6(x.elo_expected_champion_wins);
  out.log_loss = out.decided ? r6(ll / out.decided) : NaN;
  out.coin_log_loss = r6(Math.LN2);
  out.challengers.rest_days = { p10: Math.floor(quantile(rest, 0.1)), median: Math.round(quantile(rest, 0.5)), p90: Math.round(quantile(rest, 0.9)) };
  return out;
}

/** ESPN's raw scoreboard: the undisputed title a competitor holds (athlete accolades) on each booked bout */
export function espnAccolades(samples: any): Array<{ bout_id: string; athlete: string; division: string }> {
  const out: Array<{ bout_id: string; athlete: string; division: string }> = [];
  const toDiv = (s: string): string | null => {
    const m = /^UFC (Women's )?([A-Za-z ]+?) Title$/.exec(s.trim());
    if (!m || /interim/i.test(s)) return null;
    const d = (m[1] ? "Women's " : '') + m[2];
    return UFCCOM_DIVISION[d] || null;
  };
  for (const [k, doc] of Object.entries((samples && samples.samples) || {})) {
    if (!/^scoreboard_/.test(k) || !doc) continue;
    for (const ev of ((doc as any).events || [])) for (const c of (ev.competitions || [])) for (const comp of (c.competitors || [])) {
      for (const a of ((comp.athlete && comp.athlete.accolades) || [])) { const d = toDiv(String(a.name || '')); if (d) out.push({ bout_id: String(c.id), athlete: String(comp.id), division: d }); }
    }
  }
  return out;
}

/** the study's comparison (docs/model-loop/ufc/study/comparison.json) as Model Health reads it */
export function studySummary(c: any, sel: any, threshold: number): UfcStudy {
  const W = c.windows || {};
  const m = (x: any) => ({ log_loss: x ? x.log_loss : NaN, brier: x ? x.brier : NaN });
  const labels: Record<string, string> = { since_2018: 'Every bout since 2018', fit: 'Fit 2016-2020 (parameters chosen)', select: 'Select 2021-2023 (features kept or dropped)', test: 'Test 2024 on (read once)', out_of_sample: 'Out of sample, 2021 on' };
  const windows = ['since_2018', 'test', 'select', 'fit'].filter((k) => W[k]).map((k) => {
    const o = W[k].old, n = W[k].new;
    return { key: k, label: labels[k], n: o.all.n, old: m(o.all), new: m(n.all), close_n: o.close_subset.n, close_old: m(o.close_subset.model), close_new: m(n.close_subset.model), close: m(o.close_subset.close) };
  });
  const cal = (x: any[]) => (x || []).map((r) => ({ bin: r.bin, n: r.n, said: r.said, won: r.won }));
  const oos = W.out_of_sample || W.since_2018 || {};
  const over = (side: string) => (oos[side] && oos[side].gaps && oos[side].gaps['over_' + threshold]) || null;
  return {
    generated_at: c.generated_at, base_version: c.base_version, promoted: !!c.promote, reasons: c.reasons || [],
    reference: { name: c.reference && c.reference.name, kind: c.reference && c.reference.kind, timestamped: !!(c.reference && c.reference.timestamped), matched: c.reference ? c.reference.matched : 0,
      span: (c.reference && c.reference.span) || [], sha256: (c.reference && c.reference.sha256) || null },
    test: c.test,
    windows,
    calibration: W.since_2018 ? { old: cal(W.since_2018.old.calibration.model_close_subset), new: cal(W.since_2018.new.calibration.model_close_subset), close: cal(W.since_2018.old.calibration.close) } : { old: [], new: [], close: [] },
    gaps: { old: (oos.old && oos.old.gaps.rows) || [], new: (oos.new && oos.new.gaps.rows) || [], over_threshold_old: over('old'), over_threshold_new: over('new') },
    steps: ((sel && sel.steps) || []).filter((x: any) => x.step !== 'base').map((x: any) => ({ step: x.step, label: x.label, decision: x.decision, select_delta: x.select_delta ?? null, fit_delta: x.fit_delta ?? null, chosen: x.chosen || null, reason: x.reason || '' }))
  };
}

export interface BuildOptions { config?: UfcConfig }
export function buildUfcSnapshot(opt: BuildOptions = {}): UfcSnapshot {
  const C = opt.config || UFC_2026;
  const sv = servedVersion();
  /* 1 the served data, walked exactly as the loop walks it (with the same fighter facts), against what the loop published */
  const served = loadServedBouts();
  const cur = loadCurrent();
  const facts = loadFighterFacts(REPO);
  const servedWalk = walk(served.bouts, sv.config, emptyState(), factorsFor(served.bouts, sv.config, facts.map));
  const reproduction = checkReproduction(servedWalk.rows, cur.doc, sv);
  /* 2 the schedule (and any newer result) from the feed; one row per bout, the feed's when it knows more */
  const feedBuf = gz(C.feeds.bouts);
  const feed = JSON.parse(feedBuf.toString('utf8')) as { bouts: FeedBout[]; fetched_at: string };
  const csvById = new Map(served.bouts.map((b) => [b.bout_id, b]));
  const feedById = new Map(feed.bouts.map((f) => [String(f.bout_id), f]));
  const union: Bout[] = [];
  let finalsFeedOnly = 0;
  const dropped: string[] = [];
  for (const b of served.bouts) {
    const f = feedById.get(b.bout_id);
    if (b.status !== FINAL && f && f.status === 'final') { union.push(feedToBout(f)); finalsFeedOnly++; continue; }
    if (b.status === 'STATUS_SCHEDULED' && (!f || f.status !== 'scheduled')) { dropped.push(b.bout_id); if (f) union.push(feedToBout(f)); continue; }
    union.push(b);
  }
  for (const f of feed.bouts) if (!csvById.has(String(f.bout_id))) { const b = feedToBout(f); if (Number.isFinite(b.ts)) { union.push(b); if (b.status === FINAL) finalsFeedOnly++; } }
  /* the champion going in (title_bouts.csv) on every row, the feed's own rows included: the champion term, when served */
  attachChampions(union, loadTitleChampions().map);
  sortBouts(union);
  const finalsU = union.filter((b) => b.status === FINAL);
  const asOfMs = Math.max(...finalsU.map((b) => b.ts));
  const asOf = new Date(asOfMs).toISOString();
  /* 3 the state at the as-of time (every row up to it, cancelled ones included: the served walk regresses on them too), then
     every later row priced from it: the served price of each booked bout */
  const past = union.filter((b) => b.ts <= asOfMs), future = union.filter((b) => b.ts > asOfMs);
  /* every bout's facts over the whole sequence (causal: a later row never moves an earlier one), split as the walk is */
  const factU = computeFactors(union, facts.map);
  const factOf = new Map(union.map((b, i) => [b.bout_id, factU[i]]));
  const fxPast = factU.slice(0, past.length), fxFut = factU.slice(past.length);
  const W0 = walk(past, sv.config, emptyState(), fxPast);
  const state0 = cloneState(W0.state);
  const W1 = walk(future, sv.config, cloneState(W0.state), fxFut);
  const priced = new Map(W1.rows.map((r) => [r.bout.bout_id, r]));
  /* the comparison version (1.1.0) on the same rows: how each booked bout's price moved */
  const cmpV = sv.version !== COMPARE_VERSION ? versionConfig(COMPARE_VERSION) : null;
  const cmpPriced = new Map<string, number>();
  if (cmpV) { const C0 = walk(past, cmpV.config, emptyState(), fxPast); for (const r of walk(future, cmpV.config, cloneState(C0.state), fxFut).rows) cmpPriced.set(r.bout.bout_id, r.p); }
  const lastF = lastFinals(W0.rows, asOfMs);
  /* 4 rankings: one grouping per division (the page repeats the divisions with empty lists; pound-for-pound lists dropped) */
  const rk = JSON.parse(fs.readFileSync(path.join(REPO, C.feeds.rankings), 'utf8'));
  let htmlSha: string | null = null;
  try { htmlSha = sha256Hex(gz(C.feeds.rankings_html)); } catch (_) { htmlSha = null; }
  const groups = (rk.divisions || []) as Array<{ division: string; champion: { name: string } | null; ranked: Array<{ rank: number; name: string }> }>;
  const seen = new Map<string, { champion: string; ranked: Array<{ rank: number; name: string }> }>();
  let deduped = 0, p4p = 0;
  for (const g of groups) {
    if (/pound/i.test(g.division)) { p4p++; continue; }
    const key = UFCCOM_DIVISION[g.division];
    if (!key) continue;
    if (seen.has(key)) { deduped++; if (g.ranked.length && !seen.get(key)!.ranked.length) seen.get(key)!.ranked = g.ranked; continue; }
    seen.set(key, { champion: g.champion ? g.champion.name : '', ranked: g.ranked || [] });
  }
  /* 5 names -> ESPN ids: aliases, then exact, then word order; ambiguous names take the id with the latest bout */
  const ids = new Map<string, Map<string, number>>();
  const add = (k: string, id: string, ts: number) => { const m = ids.get(k) || ids.set(k, new Map()).get(k)!; m.set(id, Math.max(m.get(id) || 0, ts)); };
  for (const b of union) for (const [id, nm] of [[b.fighter_a_id, b.fighter_a], [b.fighter_b_id, b.fighter_b]] as Array<[string, string]>) { add('n:' + normName(nm), id, b.ts); add('t:' + tokenKey(nm), id, b.ts); }
  const nameOf = new Map<string, string>();
  for (const b of union) { nameOf.set(b.fighter_a_id, b.fighter_a); nameOf.set(b.fighter_b_id, b.fighter_b); }
  const nm: UfcInputData['name_matching'] = { matched: 0, unmatched: [], aliases: [], ambiguous: [] };
  const resolve = (name: string): string | null => {
    const al = C.aliases.find((a) => a.ufc_name === name);
    if (al) { nm.aliases.push(name + ' = ESPN ' + al.espn_name + ' (' + al.espn_id + ')'); nm.matched++; return al.espn_id; }
    const m = ids.get('n:' + normName(name)) || ids.get('t:' + tokenKey(name));
    if (!m) { nm.unmatched.push(name); return null; }
    const best = [...m.entries()].sort((x, y) => y[1] - x[1]);
    if (best.length > 1) nm.ambiguous.push(name + ' (' + best.map((x) => x[0]).join(', ') + '; the latest used)');
    nm.matched++;
    return best[0][0];
  };
  /* 6 the booked bouts: every scheduled bout from the as-of time through the horizon */
  const horizonEnd = Date.parse(isoDay(asOfMs) + 'T00:00:00Z') + C.horizon_days * DAY;
  const feedSched = feed.bouts.filter((f) => f.status === 'scheduled').map(feedToBout).filter((b) => b.ts > asOfMs && b.ts <= horizonEnd);
  sortBouts(feedSched);
  const lastCard = feedSched.length ? isoDay(feedSched[feedSched.length - 1].ts) : null;
  const divChampion = new Map<string, string>();
  const divInfo: Array<{ key: string; champion: string | null; ranked: Array<{ rank: number; id: string | null; name: string }> }> = [];
  for (const key of DIVISIONS) {
    const g = seen.get(key);
    if (!g) { divInfo.push({ key, champion: null, ranked: [] }); continue; }
    const champ = resolve(g.champion);
    if (champ) divChampion.set(key, champ);
    divInfo.push({ key, champion: champ, ranked: g.ranked.map((r) => ({ rank: r.rank, id: resolve(r.name), name: r.name })) });
  }
  /* 7 the finish model and each fighter's tendencies */
  const fs0 = finishStudy(served.bouts.filter((b) => b.ts <= asOfMs), asOfMs);
  const study = fs0.study, m = study.shrink.chosen_m;
  const finCounts = fs0.counts;
  const tend = (id: string) => { const c = finCounts.get(id); return c ? { w: r6(dev(c.wf, c.w, c.ew, m)), l: r6(dev(c.lf, c.l, c.el, m)) } : { w: 0, l: 0 }; };
  const logit = (p: number) => Math.log(p / (1 - p)), logistic = (x: number) => 1 / (1 + Math.exp(-x));
  const pFinish = (division: string, R: number, winner: string, loser: string) => r6(logistic(logit(baseRate(study.base, division, R)) + tend(winner).w + tend(loser).l));
  /* 8 fighters: everyone booked, every champion, every ranked contender. A debutant's rating is the served model's
     starting rating for them: 1500 under 1.0/1.1, the prior from the pre-UFC record when the configuration has one */
  const debutRating = (id: string): number => { const x = facts.map.get(id); return priorOf(sv.config, x ? x.pre_w : null, x && x.pre_w != null ? x.pre_l : null); };
  const F = new Map<string, UfcFighter>();
  const fighter = (id: string, name: string): UfcFighter => {
    let f = F.get(id);
    if (f) return f;
    const lf = lastF.get(id), t = tend(id);
    f = { id, name: nameOf.get(id) || name, division: 'Other', ranked_division: null, rank: null, champion: false, moved_from: null,
      rating: r6(state0.R.has(id) ? (state0.R.get(id) as number) : debutRating(id)), bouts: state0.N.get(id) || 0, debut: !state0.N.get(id),
      last_fight: lf ? new Date(lf.ts).toISOString() : null, last_result: lf ? lf.result : null, record: lf ? lf.rec : { w: 0, l: 0, d: 0 },
      dob: facts.map.get(id) && facts.map.get(id)!.dob != null ? new Date(facts.map.get(id)!.dob as number).toISOString().slice(0, 10) : null,
      prior: r6(state0.MU && state0.MU.has(id) ? (state0.MU.get(id) as number) : debutRating(id)), fin_win: t.w, fin_loss: t.l };
    F.set(id, f);
    return f;
  };
  for (const d of divInfo) {
    if (d.champion) { const f = fighter(d.champion, ''); f.champion = true; f.ranked_division = d.key; f.division = d.key; }
    for (const r of d.ranked) if (r.id) { const f = fighter(r.id, r.name); if (!f.champion) { f.ranked_division = d.key; f.rank = r.rank; f.division = d.key; } }
  }
  /* the disagreement guard: the same file and ledger as the loop, its published certification (guard.ts) */
  const G = loadGuardConfig(REPO), Q = latestQuotes(REPO), ev = evidenceFor(REPO, sv.version);
  const cert = (cur.doc.guard && cur.doc.guard.certification) || { certified: false, reasons: ['the loop has published no certification'] };
  const side = (F0: BoutFacts | undefined, s: 'a' | 'b') => F0 ? { ufc_bouts: s === 'a' ? F0.n_a : F0.n_b, days_off: s === 'a' ? F0.days_off_a : F0.days_off_b, age: s === 'a' ? (F0.age_a == null ? null : r6(F0.age_a)) : (F0.age_b == null ? null : r6(F0.age_b)),
    div_step: s === 'a' ? F0.div_step_a : F0.div_step_b, pre_w: s === 'a' ? F0.pre_w_a : F0.pre_w_b, pre_l: s === 'a' ? F0.pre_l_a : F0.pre_l_b }
    : { ufc_bouts: 0, days_off: null, age: null, div_step: null, pre_w: null, pre_l: null };
  const booked: UfcBooked[] = [];
  const bookedCount = new Map<string, number>();
  for (const fb0 of feedSched) {
    const pr = priced.get(fb0.bout_id);
    /* the walked row's sides (bouts.csv's order when the loop has the bout): p_a is P(that row's fighter a wins) */
    const b = pr ? pr.bout : fb0;
    const fa = fighter(b.fighter_a_id, b.fighter_a), fb = fighter(b.fighter_b_id, b.fighter_b);
    for (const f of [fa, fb]) bookedCount.set(f.id, (bookedCount.get(f.id) || 0) + 1);
    const division = DIVISIONS.includes(b.weight_class) ? b.weight_class : null;
    const ch = division ? divChampion.get(division) : undefined;
    const title = division && ch && (ch === fa.id || ch === fb.id) ? { division, champion: ch } : null;
    const R = b.periods === 5 ? 5 : 3;
    const pub = (cur.doc.bouts || []).find((x: any) => String(x.bout_id) === b.bout_id);
    const pA = pr ? r6(pr.p) : NaN, F0 = factOf.get(b.bout_id);
    const market = marketFor(Q.quotes.get(b.bout_id), b.fighter_a_id);
    const verdict = assess(pA, market, F0 ? explain(fa.name, fb.name, F0, ev, G.cfg) : [], !!cert.certified, G.cfg);
    booked.push({ bout_id: b.bout_id, event_id: b.event_id, event: b.event_name, start: b.start_time, weight_class: b.weight_class, division, rounds: R,
      order: (feedById.get(b.bout_id) || ({} as FeedBout)).order ?? null, a: fa.id, b: fb.id,
      p_a: pA, p_a_published: pub ? pub.p_a : null, basis: pr && Math.min(pr.a_bouts, pr.b_bouts) === 0 ? 'debut' : 'elo', title,
      finish_if_a: pFinish(division || '', R, fa.id, fb.id), finish_if_b: pFinish(division || '', R, fb.id, fa.id), round_dist: studyRoundDist(study, division || '', R),
      market, guard: verdict, compare: cmpV && cmpPriced.has(b.bout_id) ? { version: cmpV.version, p_a: r6(cmpPriced.get(b.bout_id) as number) } : null,
      facts: { a: side(F0, 'a'), b: side(F0, 'b') } });
    /* a ranked contender booked in another division has moved: they can win only that division's title in this run */
    for (const f of [fa, fb]) if (division && f.ranked_division && f.ranked_division !== division && !f.champion) { f.moved_from = f.ranked_division; f.division = division; }
    for (const f of [fa, fb]) if (division && f.division === 'Other') f.division = division;
  }
  /* 9 title history: rates, last title fights, the gaps' shape, the champions' record */
  const wikiBuf = gz(C.feeds.title_history);
  const H = parseTitleHistory(wikiBuf.toString('utf8'));
  const rates = divisionRates(H, isoDay(asOfMs), C.rate_window_years);
  const ng = normalisedGaps(H, C.gap_shape_from, isoDay(asOfMs));
  const gm = ng.gaps.reduce((a, x) => a + x, 0) / ng.gaps.length;
  const gv = ng.gaps.reduce((a, x) => a + (x - gm) ** 2, 0) / (ng.gaps.length - 1);
  const cv = Math.sqrt(gv) / gm, shape = 1 / (cv * cv);
  const record = titleRecord(H, W0.rows, '2014-01-01', asOfMs);
  const minRest = Number.isFinite(record.challengers.rest_days.p10) ? record.challengers.rest_days.p10 : 0;
  const divisions: UfcDivision[] = divInfo.filter((d) => d.champion).map((d) => {
    const rate = rates.find((x) => x.division === d.key)!;
    const champ = d.champion as string;
    const movedOut = d.ranked.filter((r) => r.id && F.get(r.id)!.moved_from === d.key).map((r) => ({ id: r.id as string, to: F.get(r.id as string)!.division }));
    const contenders = d.ranked.filter((r) => r.id && r.id !== champ && !movedOut.some((x) => x.id === r.id)).map((r) => r.id as string);
    const titles = booked.filter((b) => b.title && b.title.division === d.key);
    const lastBooked = titles.length ? titles[titles.length - 1] : null;
    let renewal: UfcDivision['renewal'];
    const cardMs = lastCard ? Date.parse(lastCard + 'T00:00:00Z') : asOfMs;
    if (lastBooked) {
      const s = Date.parse(isoDay(Date.parse(lastBooked.start)) + 'T00:00:00Z');
      renewal = { start: isoDay(s), min_gap_days: Math.max(0, Math.round((cardMs - s) / DAY)), basis: 'after the booked title fight, and not on a card already listed' };
    } else {
      const s = rate.last_title_fight ? Date.parse(rate.last_title_fight + 'T00:00:00Z') : asOfMs;
      renewal = { start: isoDay(s), min_gap_days: Math.max(0, Math.round((Math.max(asOfMs, cardMs) - s) / DAY)), basis: rate.last_title_fight ? 'after the last undisputed title fight (' + rate.last_title_fight + '), no title fight being booked on the cards already listed' : 'no undisputed title fight on record' };
    }
    return { key: d.key, label: DIVISION_LABEL[d.key], champion: champ, contenders, moved_out: movedOut, rate,
      mean_gap_days: rate.per_year > 0 ? r6(365.25 / rate.per_year) : null, booked_title: lastBooked ? lastBooked.bout_id : null, renewal,
      finish_5: r6(baseRate(study.base, d.key, 5)), round_dist_5: studyRoundDist(study, d.key, 5) };
  });
  /* 10 cross-checks */
  const wiki = divisions.map((d) => { const h = H.find((x) => x.division === d.key); const w = h ? h.incumbent : null; return { division: d.key, ufc: F.get(d.champion)!.name, wikipedia: w, agree: !!w && tokenKey(w) === tokenKey(F.get(d.champion)!.name) }; });
  let samples: any = null, samplesSha = '';
  try { const sb = gz(C.feeds.espn_samples); samplesSha = sha256Hex(sb); samples = JSON.parse(sb.toString('utf8')); } catch (_) { samples = null; }
  const espn = espnAccolades(samples).filter((x) => booked.some((b) => b.bout_id === x.bout_id))
    .map((x) => ({ bout_id: x.bout_id, division: x.division, holder: x.athlete, champion: divChampion.get(x.division) || '', agree: divChampion.get(x.division) === x.athlete }));
  /* 11 the served model's record (the loop's own evaluation) */
  const val = JSON.parse(fs.readFileSync(path.join(REPO, 'model_loop', 'published', 'ufc', 'validation.json'), 'utf8'));
  const recJson = JSON.parse(fs.readFileSync(path.join(REPO, 'model_loop', 'published', 'ufc', 'record.json'), 'utf8'));
  const win = (x: any, label: string) => ({ label, n: x.n, log_loss: x.log_loss, coin: x.coin_flip_log_loss, brier: x.brier ?? null, favourite_p: x.favourite_mean_p ?? null, favourite_won: x.favourite_won ?? null });
  const health: UfcInputData['health'] = {
    /* the preregistered validation and holdout scored the tuned configuration (1.0.0); the served version changed only
       the first bouts' step (versions.json) and is scored clean on the live season */
    windows: [win(val.result.confirmation, 'validation 2021-2024 (tuned 1.0.0)'), win(val.result.holdout_2025, 'holdout 2025 (tuned 1.0.0)'), ...(val.result.live_served ? [win(val.result.live_served, '2026 so far (served ' + val.result.live_served.version + ')')] : [])],
    market: (val.markets && val.markets.moneyline && val.markets.moneyline.market_reason) || 'no closing-price archive',
    record_graded: (recJson.bouts || []).length,
    study: null
  };
  /* 11b the 2026-10 study: the served model and 1.1.0 against the closing line (Model Health) */
  const studyFile = path.join(REPO, 'docs', 'model-loop', 'ufc', 'study', 'comparison.json'), selFile = path.join(REPO, 'docs', 'model-loop', 'ufc', 'study', 'selection.json');
  const studyBuf = fs.existsSync(studyFile) ? fs.readFileSync(studyFile) : null;
  health.study = studyBuf ? studySummary(JSON.parse(studyBuf.toString('utf8')), fs.existsSync(selFile) ? JSON.parse(fs.readFileSync(selFile, 'utf8')) : null, G.cfg.threshold_pp) : null;
  /* 11c the guard: this copy, applied to the market the loop published with each bout (the ledger may hold a newer
     quote by now: the displayed verdict uses the latest, the check uses the loop's own), against the loop's verdict */
  const agree = { compared: 0, same: 0, differ: [] as string[] };
  for (const b of booked) {
    const pb = (cur.doc.bouts || []).find((x: any) => String(x.bout_id) === b.bout_id);
    if (!pb || !pb.guard || pb.p_a !== round4(b.p_a)) continue;
    agree.compared++;
    const mine = assess(b.p_a, pb.market && typeof pb.market.p_a === 'number' ? pb.market : null, [], !!cert.certified, G.cfg);
    const okGap = pb.guard.gap_pp == null ? mine.gap_pp == null : mine.gap_pp != null && Math.abs(pb.guard.gap_pp - mine.gap_pp) <= 0.15;
    if (pb.guard.status === mine.status && okGap && pb.guard.signal_allowed === mine.signal_allowed) agree.same++;
    else agree.differ.push(b.bout_id + ' (loop ' + pb.guard.status + ' ' + pb.guard.gap_pp + ', here ' + mine.status + ' ' + mine.gap_pp + ')');
  }
  const guard: UfcInputData['guard'] = { threshold_pp: G.cfg.threshold_pp, certified: !!cert.certified, certification_reasons: cert.reasons || [],
    with_market: booked.filter((b) => b.market).length, disagreements: booked.filter((b) => b.guard.status === 'DISAGREES').length, agree };
  /* 12 the champion term's latest weekly test */
  const candFile = path.join(REPO, 'docs', 'model-loop', 'ufc', 'candidates.jsonl');
  const candBuf = fs.existsSync(candFile) ? fs.readFileSync(candFile) : null;
  const lastTest = candBuf ? candBuf.toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.candidate === 'champion_term').pop() : null;
  const championTerm: UfcInputData['champion_term'] = lastTest ? { tested_at: lastTest.at, served_version: lastTest.served_version, bonus: Number(lastTest.change.how[1]), decision: lastTest.decision,
    delta: lastTest.delta, ci95: lastTest.ci95, reason: lastTest.reason } : null;
  const late = union.filter((b) => b.status === 'STATUS_SCHEDULED' && b.ts < asOfMs).map((b) => b.bout_id);
  const pubAgree = { listed: 0, equal: 0, newer_finals: finalsFeedOnly };
  for (const b of booked) if (b.p_a_published != null) { pubAgree.listed++; if (round4(b.p_a) === b.p_a_published) pubAgree.equal++; }
  const fighters = [...F.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  const data: UfcInputData = {
    sport: 'ufc', season: C.season, competition: C.competition, as_of: asOf,
    horizon: { from: isoDay(asOfMs), to: isoDay(horizonEnd), days: C.horizon_days }, last_card: lastCard,
    fighters, bouts: booked, divisions,
    elo: { version: sv.version, status: sv.status, config: sv.config, config_sha256: sv.config_sha256, promoted_at: sv.promoted_at, reproduction, published_agree: pubAgree },
    gaps: { shape: r6(shape), cv: r6(cv), n: ng.gaps.length, from: C.gap_shape_from },
    matchmaking: { rule: C.matchmaking.value, min_rest_days: minRest },
    finish: { m, c: study.rounds.chosen_c, holdout_log_loss: study.shrink.grid.find((g) => g.m === m)!.holdout_log_loss, base_only_log_loss: study.shrink.base_only.holdout_log_loss,
      constant_log_loss: study.shrink.constant.holdout_log_loss, n_holdout: study.shrink.n_holdout,
      rounds_holdout: { chosen: study.rounds.grid.find((g) => g.c === study.rounds.chosen_c)!.holdout_log_lik, format_only: study.rounds.grid.find((g) => g.c == null)!.holdout_log_lik },
      base: study.base, no_winner: study.no_winner, by_rounds: study.rounds.by_rounds },
    title_record: record,
    champion_term: championTerm,
    rankings: { url: rk.url, fetched_at: rk.fetched_at, page_sha256: rk.page_sha256, html_sha256: htmlSha, groupings: groups.length, divisions: seen.size, deduped, pound_for_pound: p4p },
    title_history: { sha256: sha256Hex(wikiBuf), unparsed: H.flatMap((h) => h.unparsed), window_years: C.rate_window_years },
    cross_checks: { wikipedia: wiki, espn },
    name_matching: nm,
    data_checks: { finals_csv: served.bouts.filter((b) => b.status === FINAL).length, finals_feed_only: finalsFeedOnly, scheduled_feed: feedSched.length, csv_scheduled_dropped: dropped, late,
      double_booked: [...bookedCount.entries()].filter(([, n]) => n > 1).map(([id]) => id) },
    health,
    guard,
    code: codeIdentity(),
    config: { rules_version: C.rules_version, horizon_days: C.horizon_days, rate_window_years: C.rate_window_years, matchmaking: C.matchmaking.value, not_modelled: C.not_modelled }
  };
  return { schema: UFC_INPUT_SCHEMA, input_hash: hashCanonical(data), data,
    meta: { built_at: new Date().toISOString(), builder: 'simulator/src/sports/ufc/inputs.ts',
      feeds: [{ name: 'model_loop/data/ufc/bouts.csv', sha256: served.sha256 }, { name: 'model_loop/published/ufc/current.json', sha256: cur.sha256 }, { name: C.feeds.bouts, sha256: sha256Hex(fs.readFileSync(path.join(REPO, C.feeds.bouts))) },
        { name: C.feeds.rankings, sha256: sha256Hex(fs.readFileSync(path.join(REPO, C.feeds.rankings))) }, { name: C.feeds.title_history, sha256: sha256Hex(fs.readFileSync(path.join(REPO, C.feeds.title_history))) },
        ...(served.titles_sha256 ? [{ name: TITLE_BOUTS_CSV, sha256: served.titles_sha256 }] : []), ...(candBuf ? [{ name: 'docs/model-loop/ufc/candidates.jsonl', sha256: sha256Hex(candBuf) }] : []),
        ...(samplesSha ? [{ name: C.feeds.espn_samples, sha256: samplesSha }] : []),
        ...(facts.sha256 ? [{ name: FIGHTER_FACTS_CSV, sha256: facts.sha256 }] : []), { name: GUARD_JSON, sha256: G.sha256 }, ...Q.files,
        ...(studyBuf ? [{ name: 'docs/model-loop/ufc/study/comparison.json', sha256: sha256Hex(studyBuf) }] : [])] } };
}

export function writeUfcSnapshot(file: string, snap: UfcSnapshot): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(snap));
}
export function readUfcSnapshot(file: string): UfcSnapshot {
  const snap = JSON.parse(fs.readFileSync(file, 'utf8')) as UfcSnapshot;
  if (snap.schema !== UFC_INPUT_SCHEMA) throw new Error('not a UFC input snapshot: ' + snap.schema);
  const h = hashCanonical(snap.data);
  if (h !== snap.input_hash) throw new Error('snapshot content hash mismatch: the file was changed after it was built (' + h + ' != ' + snap.input_hash + ')');
  return snap;
}
