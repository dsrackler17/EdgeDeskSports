/* ===========================================================================
   THE SHARED ENGINE: one interface every sport implements, one runner, one
   aggregate.

   A sport module declares its entities (teams or players), the outcomes it
   records, and the per-run SUM RULES the competition format fixes (exactly
   one division winner per division, seven playoff clubs per conference, one
   champion). The runner calls module.runOne(run) for run = start..end-1; each
   run marks the outcomes each entity achieved in that one simulated season.
   After every run the sum rules are checked, so a broken tiebreaker or
   bracket fails the run the moment it happens instead of averaging into a
   plausible-looking number.

   Counts are integers and are added, never averaged, so a run split over any
   number of workers aggregates to exactly the same numbers.
   =========================================================================== */
import { outcomeStat, type OutcomeStat } from './stats.ts';

export interface EntityDef {
  id: string;
  name: string;
  /** grouping labels the sum rules refer to, e.g. { conference: 'AFC', division: 'AFC East' } */
  groups: Record<string, string>;
}

export interface OutcomeDef {
  key: string;
  label: string;
  /** the tab the outcome belongs to in the reader */
  category: 'division' | 'conference' | 'title' | 'playoffs' | 'seed' | 'round' | 'regular_season' | 'cup' | 'fights' | 'title_path' | 'finish' | 'cut';
  /** provenance of the number: simulated probabilities are Research; a probability that passes
      through an Estimated input (a committee proxy) is Estimated; a fact already decided is Observed */
  provenance: 'Research' | 'Estimated' | 'Observed';
  /** what the number is conditional on, when it is (a stated scenario); absent = unconditional */
  conditional_on?: string;
}

export interface SumRule {
  outcome: string;
  /** group label to partition entities by, or 'league' for all entities */
  by: string;
  /** exactly this many entities per group achieve the outcome in every run */
  perGroup: number;
  /** group labels the rule does not apply to (e.g. independents have no title game) */
  skip?: string[];
}

export interface RunMarks {
  /** set entity e as having achieved outcome o in this run */
  mark(e: number, o: number): void;
  /** add a per-entity value (e.g. regular-season wins x 2) to its histogram */
  value(e: number, bin: number): void;
  /** count a diagnostic event (tiebreak step reached, coin toss, ...) */
  diag(key: string, n?: number): void;
  /** a run-level flag that the validator gates on (e.g. unsupported tiebreak input) */
  flag(key: string): void;
  /** append to the trace when this run is traced */
  trace(event: Record<string, unknown>): void;
  readonly tracing: boolean;
}

export interface SimModule {
  sport: string;
  competition: string;
  season: string;
  entities: EntityDef[];
  outcomes: OutcomeDef[];
  sumRules: SumRule[];
  /** number of histogram bins per entity for value() */
  valueBins: number;
  /** what value() records; absent = regular-season wins x 2 (the NFL, ties as half) */
  value?: { key: string; label: string; divisor: number };
  runOne(run: number, marks: RunMarks): void;
}

export interface Aggregate {
  n: number;
  counts: number[];             // entity-major: counts[e * O + o]
  hist: number[];               // entity-major: hist[e * B + b]
  diags: Record<string, number>;
  flags: Record<string, number>;  // number of runs carrying each flag
  traces: Array<{ run: number; events: Array<Record<string, unknown>> }>;
  violations: Array<{ run: number; rule: string; detail: string }>;
}

export function emptyAggregate(m: SimModule): Aggregate {
  return {
    n: 0,
    counts: new Array(m.entities.length * m.outcomes.length).fill(0),
    hist: new Array(m.entities.length * Math.max(1, m.valueBins)).fill(0),
    diags: {}, flags: {}, traces: [], violations: []
  };
}

/** the sum-rule partitions, computed once */
function partitions(m: SimModule): Array<{ rule: SumRule; o: number; groups: number[][] }> {
  return m.sumRules.map((rule) => {
    const o = m.outcomes.findIndex((x) => x.key === rule.outcome);
    if (o < 0) throw new Error('sum rule names an unknown outcome: ' + rule.outcome);
    const by: Record<string, number[]> = {};
    m.entities.forEach((e, i) => {
      const g = rule.by === 'league' ? 'league' : e.groups[rule.by];
      if (g == null) throw new Error('entity ' + e.id + ' has no group ' + rule.by);
      (by[g] = by[g] || []).push(i);
    });
    return { rule, o, groups: Object.keys(by).filter((k) => !(rule.skip || []).includes(k)).sort().map((k) => by[k]) };
  });
}

export interface RunOptions {
  start: number;
  end: number;
  /** run indices to trace in full (capped by the caller) */
  traceRuns?: number[];
  /** stop on the first sum-rule violation (default true) */
  failFast?: boolean;
}

export function runRange(m: SimModule, opt: RunOptions): Aggregate {
  const E = m.entities.length, O = m.outcomes.length, B = Math.max(1, m.valueBins);
  const agg = emptyAggregate(m);
  const parts = partitions(m);
  const hit = new Uint8Array(E * O);
  const traceSet = new Set(opt.traceRuns || []);
  const failFast = opt.failFast !== false;
  for (let run = opt.start; run < opt.end; run++) {
    hit.fill(0);
    const tracing = traceSet.has(run);
    const events: Array<Record<string, unknown>> = [];
    const runFlags = new Set<string>();
    const marks: RunMarks = {
      mark(e, o) { hit[e * O + o] = 1; },
      value(e, bin) {
        if (!(bin >= 0 && bin < B) || !Number.isInteger(bin)) throw new Error('value bin out of range: ' + bin);
        agg.hist[e * B + bin] += 1;
      },
      diag(key, n) { agg.diags[key] = (agg.diags[key] || 0) + (n == null ? 1 : n); },
      flag(key) { runFlags.add(key); },
      trace(ev) { if (tracing) events.push(ev); },
      tracing
    };
    m.runOne(run, marks);
    for (const p of parts) {
      for (const g of p.groups) {
        let c = 0;
        for (const e of g) c += hit[e * O + p.o];
        if (c !== p.rule.perGroup) {
          agg.violations.push({ run, rule: p.rule.outcome + ' per ' + p.rule.by, detail: 'expected ' + p.rule.perGroup + ', got ' + c });
          if (failFast) throw new Error('run ' + run + ' violates ' + p.rule.outcome + ' per ' + p.rule.by + ': expected ' + p.rule.perGroup + ', got ' + c);
        }
      }
    }
    for (let i = 0; i < hit.length; i++) agg.counts[i] += hit[i];
    for (const f of runFlags) agg.flags[f] = (agg.flags[f] || 0) + 1;
    if (tracing) agg.traces.push({ run, events });
    agg.n++;
  }
  return agg;
}

/** add b into a (both from the same module); order-independent */
export function mergeAggregates(a: Aggregate, b: Aggregate): Aggregate {
  if (a.counts.length !== b.counts.length || a.hist.length !== b.hist.length) throw new Error('mergeAggregates: shape mismatch');
  const out: Aggregate = {
    n: a.n + b.n,
    counts: a.counts.map((x, i) => x + b.counts[i]),
    hist: a.hist.map((x, i) => x + b.hist[i]),
    diags: { ...a.diags }, flags: { ...a.flags },
    traces: a.traces.concat(b.traces).sort((x, y) => x.run - y.run),
    violations: a.violations.concat(b.violations).sort((x, y) => x.run - y.run)
  };
  for (const k of Object.keys(b.diags)) out.diags[k] = (out.diags[k] || 0) + b.diags[k];
  for (const k of Object.keys(b.flags)) out.flags[k] = (out.flags[k] || 0) + b.flags[k];
  return out;
}

export interface EntityResult {
  entity_id: string;
  entity_name: string;
  groups: Record<string, string>;
  outcomes: Record<string, OutcomeStat>;
  /** histogram of the per-entity value (e.g. wins x 2), counts per bin */
  value_hist: number[];
}

export function summarise(m: SimModule, agg: Aggregate): EntityResult[] {
  if (!(agg.n > 0)) throw new Error('summarise: no runs');
  const O = m.outcomes.length, B = Math.max(1, m.valueBins);
  return m.entities.map((e, i) => {
    const outcomes: Record<string, OutcomeStat> = {};
    m.outcomes.forEach((o, j) => { outcomes[o.key] = outcomeStat(agg.counts[i * O + j], agg.n); });
    return { entity_id: e.id, entity_name: e.name, groups: e.groups, outcomes, value_hist: agg.hist.slice(i * B, (i + 1) * B) };
  });
}

/** every sum rule, checked again on the aggregate counts (exact integers) */
export function checkAggregateSums(m: SimModule, agg: Aggregate): string[] {
  const errs: string[] = [];
  const O = m.outcomes.length;
  for (const p of partitions(m)) {
    for (const g of p.groups) {
      let c = 0;
      for (const e of g) c += agg.counts[e * O + p.o];
      if (c !== p.rule.perGroup * agg.n) errs.push(p.rule.outcome + ' per ' + p.rule.by + ': ' + c + ' != ' + p.rule.perGroup + ' x ' + agg.n);
    }
  }
  for (let i = 0; i < agg.counts.length; i++) {
    const c = agg.counts[i];
    if (!Number.isInteger(c) || c < 0 || c > agg.n) errs.push('count out of range at ' + i + ': ' + c);
  }
  return errs;
}
