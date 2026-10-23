/* ===========================================================================
   THE FORMAT FACTS A GOLF TOURNAMENT SIMULATION NEEDS, MEASURED FROM HISTORY.

   No cut rule is assumed. Each one is read from what the tours actually did
   (simulator/data/feeds/golf_events.json.gz), and every fact a run uses
   carries how it was determined (inputs.ts records it in the snapshot; the
   gate cut.rule refuses a run whose rule could not be determined):

   measureCut(event)   one finished event: did it have a cut, after which
                       round, and which "top N and ties" counts reproduce
                       exactly who made it. N is an interval [n_lo, n_hi]:
                       every N in it gives the same cut (ties decide how
                       wide it is). A cut that also kept everyone within X
                       strokes of the lead (the 10-shot rule) is detected
                       when top-N-and-ties alone cannot reproduce it.
   tourStandard(tour)  the N contained in the most of a tour's round-2 cuts
                       (2023 on), with how many events contain it and
                       whether the history pins it exactly (one event with
                       n_lo = N and another with n_hi = N): the PGA Tour's,
                       the LPGA's and the DP World Tour's "top 65 and ties"
                       are pinned that way, not taken from a rulebook.
   eventRule(event)    the current event's rule, from (in order): the cut
                       already made (Observed: players marked cut); ESPN's
                       own tournament fields when the feed carries them and
                       history agrees; the event's previous editions
                       (matched by name, or by course and month): no cut in
                       every edition = no cut; otherwise the tour standard
                       when every edition is consistent with it (measured),
                       else the editions' common interval (Estimated, with
                       the interval); an event history has never seen
                       takes the tour standard only with a full field
                       (Estimated); anything else is undetermined.
   rounds              the number of regulation rounds, from the editions
                       (ESPN's tournament field when present); an event
                       never seen takes the tour's most common format,
                       labelled Estimated (and so is every finish it
                       feeds: module.ts).
   playoffs, WDs       measured frequencies, for the reader and the notes.
   =========================================================================== */
import type { HistEvent, Tour } from './model.ts';

export interface EventCut {
  cut: boolean;
  /** the round after which the cut was made */
  round: number | null;
  /** every N in [n_lo, n_hi] reproduces the cut as "top N and ties" */
  n_lo: number | null; n_hi: number | null;
  made: number; missed: number;
  /** the made player's worst total minus the leader's, after the cut round */
  line_to_lead: number | null;
  clean: boolean;
}

const madeIt = (p: HistEvent['players'][number], R: number) =>
  p.status === 'active' || p.status === 'mdf' || p.rounds.some((r) => r.r > R && r.complete) || ((p.status === 'wd' || p.status === 'dq') && p.rounds.some((r) => r.r > R));

/** one finished event's cut, as the rounds and statuses show it */
export function measureCut(e: HistEvent): EventCut {
  const none: EventCut = { cut: false, round: null, n_lo: null, n_hi: null, made: e.players.filter((p) => p.status !== 'wd' && p.status !== 'dq').length, missed: 0, line_to_lead: null, clean: true };
  if (!e.players.some((p) => p.status === 'cut')) return none;
  let fallback: EventCut | null = null;
  for (const R of [2, 3]) {
    if (R >= e.n_rounds) continue;
    const pool = e.players.filter((p) => [1, 2, 3].slice(0, R).every((r) => p.rounds.some((x) => x.r === r && x.complete)))
      .map((p) => ({ p, t: p.rounds.filter((x) => x.r <= R && x.complete).reduce((a, x) => a + x.strokes, 0), made: madeIt(p, R), cut: p.status === 'cut' }))
      .filter((x) => x.made || x.cut);
    const made = pool.filter((x) => x.made), cut = pool.filter((x) => x.cut);
    if (!made.length || !cut.length) continue;
    const L = Math.max(...made.map((x) => x.t)), M = Math.min(...cut.map((x) => x.t)), lead = Math.min(...pool.map((x) => x.t));
    const better = pool.filter((x) => x.t < L).length, atLine = pool.filter((x) => x.t === L).length;
    const out: EventCut = { cut: true, round: R, n_lo: better + 1, n_hi: better + atLine, made: made.length, missed: cut.length, line_to_lead: L - lead, clean: L < M };
    if (out.clean) return out;
    if (!fallback) fallback = out;
  }
  return fallback || { ...none, cut: true, clean: false };
}

export interface Standard { tour: Tour; n: number | null; events: number; containing: number; pinned: boolean; pinned_by: { lo: string | null; hi: string | null }; non_standard: string[] }
/** the tour's standard round-2 cut: the N contained in the most clean round-2 cuts */
export function tourStandard(events: HistEvent[], tour: Tour, beforeMs: number = Infinity): Standard {
  const cuts = events.filter((e) => e.league === tour && e.start < beforeMs).map((e) => ({ e, c: measureCut(e) })).filter((x) => x.c.cut && x.c.clean && x.c.round === 2);
  let best: number | null = null, bc = 0;
  for (let n = 20; n <= 100; n++) { const c = cuts.filter((x) => (x.c.n_lo as number) <= n && n <= (x.c.n_hi as number)).length; if (c > bc) { bc = c; best = n; } }
  const lo = best == null ? undefined : cuts.find((x) => x.c.n_lo === best), hi = best == null ? undefined : cuts.find((x) => x.c.n_hi === best);
  return { tour, n: best, events: cuts.length, containing: bc, pinned: !!lo && !!hi, pinned_by: { lo: lo ? lo.e.season + ' ' + lo.e.name : null, hi: hi ? hi.e.season + ' ' + hi.e.name : null },
    non_standard: cuts.filter((x) => best == null || !((x.c.n_lo as number) <= best && best <= (x.c.n_hi as number))).map((x) => x.e.season + ' ' + x.e.name) };
}

/** a name without sponsors' "presented by" clauses, punctuation or a leading "the" */
export function normName(s: string): string {
  return s.toLowerCase().replace(/\b(presented|pres\.?|powered|driven|hosted|supported)\s+by\b.*$/, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/^\s*the\s+/, '').replace(/\s+/g, ' ').trim();
}
/** the event's previous editions: the same tour, and the same name, or the same course within a month of the calendar date */
export function editions(events: HistEvent[], cur: { league: Tour; name: string; course: string | null; start: number; id?: string }): HistEvent[] {
  const n = normName(cur.name), md = (t: number) => { const d = new Date(t); return d.getUTCMonth() * 31 + d.getUTCDate(); };
  return events.filter((e) => e.league === cur.league && e.start < cur.start - 3 * 864e5 && e.id !== cur.id && (normName(e.name) === n
    || (!!cur.course && !!e.course && e.course.toLowerCase() === cur.course.toLowerCase() && Math.abs(md(e.start) - md(cur.start)) <= 31))).sort((a, b) => a.start - b.start);
}

export interface CutRule {
  mode: 'observed' | 'top_n' | 'none' | 'undetermined';
  /** the round after which the cut is made, and the rule: top n and ties, plus everyone within `within` strokes of the lead */
  round: number | null; n: number | null; within: number | null;
  provenance: 'Observed' | 'Research' | 'Estimated' | null;
  /** how it was determined, in words (the snapshot, the gate and the reader show it) */
  source: string;
  editions: Array<{ season: number; name: string; cut: boolean; round: number | null; n_lo: number | null; n_hi: number | null; made: number; line_to_lead: number | null; clean: boolean }>;
  interval: [number, number] | null;
}

/** whether "top n and ties" (plus within-x) reproduces an edition's cut exactly */
function reproduces(e: HistEvent, R: number, n: number, within: number | null): boolean {
  const pool = e.players.filter((p) => [1, 2, 3].slice(0, R).every((r) => p.rounds.some((x) => x.r === r && x.complete)))
    .map((p) => ({ t: p.rounds.filter((x) => x.r <= R && x.complete).reduce((a, x) => a + x.strokes, 0), made: madeIt(p, R), cut: p.status === 'cut' })).filter((x) => x.made || x.cut);
  if (!pool.length) return false;
  const lead = Math.min(...pool.map((x) => x.t));
  return pool.every((x) => { const rank = 1 + pool.filter((y) => y.t < x.t).length; return (rank <= n || (within != null && x.t - lead <= within)) === x.made; });
}

/** the current event's cut rule (see the header): `cur` is what the leaderboard shows now */
export function eventRule(events: HistEvent[], cur: { league: Tour; name: string; course: string | null; start: number; id?: string; field: number; any_cut: boolean; period: number; n_rounds: number;
  tournament?: Record<string, unknown> | null; round_complete: (r: number) => boolean }): CutRule {
  const eds = editions(events, cur);
  const ec = eds.map((e) => ({ e, c: measureCut(e) }));
  const edOut = ec.map(({ e, c }) => ({ season: e.season, name: e.name, cut: c.cut, round: c.round, n_lo: c.n_lo, n_hi: c.n_hi, made: c.made, line_to_lead: c.line_to_lead, clean: c.clean }));
  const std = tourStandard(events, cur.league, cur.start);
  const base = { editions: edOut, interval: null as [number, number] | null };
  if (cur.any_cut) return { ...base, mode: 'observed', round: null, n: null, within: null, provenance: 'Observed', source: 'the cut has been made: the leaderboard marks the players who missed it' };
  const T = cur.tournament || {};
  const espnCount = Number((T as any).cutCount), espnRound = Number((T as any).cutRound);
  /* past the cut round with nobody cut: the event has no cut (Observed) */
  const lastCutRound = ec.reduce((m, x) => Math.max(m, x.c.round || 0), 0) || 2;
  if (cur.round_complete(lastCutRound) && cur.period > lastCutRound) return { ...base, mode: 'none', round: null, n: null, within: null, provenance: 'Observed', source: 'round ' + (lastCutRound + 1) + ' has started and nobody is marked cut: no cut' };
  /* the format in force is the latest editions': a latest edition without a cut means no cut (the format changed,
     as when a full-field event became a limited-field one), and older editions with a cut are not used */
  let lastNoCut = -1; ec.forEach((x, i) => { if (!x.c.cut) lastNoCut = i; });
  if (ec.length && lastNoCut === ec.length - 1) {
    let k = ec.length; while (k > 0 && !ec[k - 1].c.cut) k--;
    const used = ec.slice(k);
    return { ...base, mode: 'none', round: null, n: null, within: null, provenance: 'Research', source: 'no cut in ' + (k === 0 ? 'any of the ' : 'the latest ') + used.length + ' previous edition' + (used.length === 1 ? '' : 's') + ' (' + used.map((x) => x.e.season).join(', ') + ')'
      + (k > 0 ? '; earlier editions (' + ec.slice(0, k).map((x) => x.e.season).join(', ') + ') had a cut: the format changed' : '') };
  }
  const clean = ec.slice(lastNoCut + 1).filter((x) => x.c.cut && x.c.clean);
  if (clean.length) {
    const rounds = [...new Set(clean.map((x) => x.c.round))];
    const R = (rounds.length === 1 ? rounds[0] : clean[clean.length - 1].c.round) as number;
    let sameR = clean.filter((x) => x.c.round === R);
    /* the latest editions that agree: a rule that changed (a full field turned into a limited one) is read from the
       editions since the change */
    let lo = -Infinity, hi = Infinity, k = sameR.length;
    while (k > 0) { const c = sameR[k - 1].c; const l2 = Math.max(lo, c.n_lo as number), h2 = Math.min(hi, c.n_hi as number); if (l2 > h2) break; lo = l2; hi = h2; k--; }
    const note = k > 0 ? '; earlier editions (' + sameR.slice(0, k).map((x) => x.e.season).join(', ') + ') had another rule and are not used' : '';
    sameR = sameR.slice(k);
    /* the 10-shot rule: needed only if some edition cannot be reproduced without it */
    const pick = (n: number) => {
      const plain = sameR.every((x) => reproduces(x.e, R, n, null));
      const w10 = !plain && sameR.every((x) => reproduces(x.e, R, n, 10));
      return { n, within: w10 ? 10 : null, ok: plain || w10 };
    };
    if (Number.isFinite(espnCount) && espnCount > 0 && (!Number.isFinite(espnRound) || espnRound === R) && pick(espnCount).ok)
      return { ...base, interval: [lo, hi], mode: 'top_n', round: R, n: espnCount, within: pick(espnCount).within, provenance: 'Research', source: 'ESPN\'s tournament fields state top ' + espnCount + ' after round ' + R + '; consistent with the ' + sameR.length + ' previous edition' + (sameR.length === 1 ? '' : 's') + note };
    if (std.n != null && std.pinned && lo <= std.n && std.n <= hi && pick(std.n).ok) {
      const p = pick(std.n);
      return { ...base, interval: [lo, hi], mode: 'top_n', round: R, n: std.n, within: p.within, provenance: lo === hi || R === 2 ? 'Research' : 'Estimated',
        source: 'top ' + std.n + ' and ties after round ' + R + (p.within ? ' and anyone within ' + p.within + ' strokes of the lead' : '') + ': the tour\'s standard (pinned by ' + std.events + ' cuts since 2023), consistent with every previous edition ('
          + sameR.map((x) => x.e.season + ': any N in ' + x.c.n_lo + '-' + x.c.n_hi).join('; ') + ')' + note };
    }
    /* not the standard: the editions' common interval, at its smallest multiple of 5 (Estimated) */
    let n = lo; for (let k = lo; k <= hi; k++) if (k % 5 === 0) { n = k; break; }
    const p = pick(n);
    return { ...base, interval: [lo, hi], mode: 'top_n', round: R, n, within: p.within, provenance: lo === hi ? 'Research' : 'Estimated',
      source: 'the previous editions are consistent with top N and ties after round ' + R + ' for N from ' + lo + ' to ' + hi + (p.within ? ' (with the ' + p.within + '-shot rule)' : '') + '; the simulation uses ' + n + (lo === hi ? '' : ' (Estimated: the editions cannot tell these apart)') + note };
  }
  if (ec.length) return { ...base, mode: 'undetermined', round: null, n: null, within: null, provenance: null, source: 'the previous editions had a cut, but none reproducible as top N and ties (' + ec.map((x) => x.e.season).join(', ') + ')' };
  /* never seen: the tour standard only for a full field */
  if (std.n != null && std.pinned && cur.field >= 120) return { ...base, mode: 'top_n', round: 2, n: std.n, within: null, provenance: 'Estimated',
    source: 'no previous edition in the history: the tour\'s standard top ' + std.n + ' and ties after round 2 (pinned by ' + std.events + ' cuts since 2023) is assumed for a full field of ' + cur.field };
  return { ...base, mode: 'undetermined', round: null, n: null, within: null, provenance: null, source: 'no previous edition in the history and a limited field of ' + cur.field + ': whether there is a cut cannot be determined' };
}

/** the scheduled number of regulation rounds: ESPN's field when present, else the editions' most common (the larger on a tie) */
export function scheduledRounds(events: HistEvent[], cur: { league: Tour; name: string; course: string | null; start: number; id?: string; tournament?: Record<string, unknown> | null; period: number }): { n: number | null; source: string; provenance: 'Research' | 'Estimated' | null } {
  const espn = Number(cur.tournament && (cur.tournament as any).numberOfRounds);
  const eds = editions(events, cur);
  if (Number.isFinite(espn) && espn >= 1 && espn <= 6) return { n: espn, source: 'ESPN\'s tournament field numberOfRounds', provenance: 'Research' };
  if (eds.length) {
    const c: Record<number, number> = {};
    for (const e of eds) c[e.n_rounds] = (c[e.n_rounds] || 0) + 1;
    const top = Math.max(...Object.values(c));
    /* the most common; on a tie the larger (a weather-shortened edition is commoner than a shorter format) */
    const use = Math.max(...eds.filter((e) => c[e.n_rounds] === top).map((e) => e.n_rounds));
    return { n: Math.max(use, cur.period), source: 'the previous editions (' + eds.map((e) => e.season + ': ' + e.n_rounds).join(', ') + ')', provenance: 'Research' };
  }
  /* never seen: the tour's most common format, labelled Estimated */
  const tourEv = events.filter((e) => e.league === cur.league && e.start < cur.start);
  if (tourEv.length >= 20) {
    const c: Record<number, number> = {};
    for (const e of tourEv) c[e.n_rounds] = (c[e.n_rounds] || 0) + 1;
    const [n, k] = Object.entries(c).map(([a, b]) => [Number(a), b]).sort((x, y) => y[1] - x[1])[0];
    return { n: Math.max(n, cur.period), source: 'no previous edition: the tour\'s most common format (' + k + ' of ' + tourEv.length + ' events since 2023 had ' + n + ' rounds)', provenance: 'Estimated' };
  }
  return { n: null, source: 'no previous edition and no ESPN round count', provenance: null };
}

/** how often a tour's events end in a playoff (where the feed shows one) and how often a starter withdraws per round */
export function tourFrequencies(events: HistEvent[], tour: Tour): { events: number; playoffs: number; withdrawals: Array<{ round: number; starters: number; withdrew: number }> } {
  const ev = events.filter((e) => e.league === tour);
  const wd: Array<{ round: number; starters: number; withdrew: number }> = [];
  for (let r = 1; r <= 4; r++) {
    let s = 0, w = 0;
    for (const e of ev) if (e.n_rounds >= r) for (const p of e.players) {
      const started = p.rounds.some((x) => x.r === r), done = p.rounds.some((x) => x.r === r && x.complete);
      if (started) { s++; if (!done && (p.status === 'wd' || p.status === 'dq')) w++; }
    }
    wd.push({ round: r, starters: s, withdrew: w });
  }
  return { events: ev.length, playoffs: ev.filter((e) => e.playoff.length > 1).length, withdrawals: wd };
}
