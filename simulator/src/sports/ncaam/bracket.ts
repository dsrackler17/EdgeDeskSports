/* ===========================================================================
   A FIXED BRACKET, AS SLOTS.

   Every game of a single-elimination tournament is a slot with two inputs;
   an input is a team (an entrant) or the winner of an earlier slot. That one
   shape covers the NCAA tournament (First Four slots feeding first-round
   slots, fixed regional paths, Final Four pairings by region, NO reseeding)
   and a conference tournament with byes (a seeded team enters at a later
   slot). A completed game is a slot with its observed winner fixed; a
   no-contest walkover is a completed slot too (its winner advanced).

   validateBracket refuses anything that is not a tree with one champion slot,
   every entrant entering exactly once, every slot used exactly once, rounds
   that only move forward and completed winners that are one of the slot's
   two teams.
   =========================================================================== */

export type SlotInput = { team: string } | { winnerOf: string };

export interface Slot {
  id: string;
  /** round key, ordered by `rounds` in the bracket (e.g. FF, R64, R32, S16, E8, F4, NC) */
  round: string;
  /** region label for regional rounds (null for national rounds) */
  region: string | null;
  a: SlotInput;
  b: SlotInput;
  /** observed winner of a completed game (Observed); absent while unplayed */
  winner?: string;
  /** provenance of `winner`: a played game or a no-contest walkover */
  result_kind?: 'played' | 'walkover';
  /** scheduled tip-off, when known (never invented) */
  start_utc?: string | null;
}

export interface Bracket {
  competition: string;
  season: string;
  /** rounds in play order */
  rounds: string[];
  slots: Slot[];
  /** entrants: team id -> { region, seed (null if unverified) } */
  entrants: Record<string, { region: string | null; seed: number | null }>;
  source: string;
  provenance: 'Observed' | 'Estimated';
}

export function isTeam(x: SlotInput): x is { team: string } { return (x as any).team != null; }

/** play order: every slot after the slots that feed it (stable by round, then id) */
export function playOrder(b: Bracket): Slot[] {
  const r = new Map(b.rounds.map((k, i) => [k, i]));
  return b.slots.slice().sort((x, y) => (r.get(x.round)! - r.get(y.round)!) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

export function validateBracket(b: Bracket): string[] {
  const errs: string[] = [];
  const rIdx = new Map(b.rounds.map((k, i) => [k, i]));
  const byId = new Map<string, Slot>();
  for (const s of b.slots) {
    if (byId.has(s.id)) errs.push('duplicate slot ' + s.id);
    byId.set(s.id, s);
    if (!rIdx.has(s.round)) errs.push('slot ' + s.id + ' has unknown round ' + s.round);
  }
  const fedBy = new Map<string, string>(); const entered = new Map<string, string>();
  for (const s of b.slots) {
    for (const inp of [s.a, s.b]) {
      if (isTeam(inp)) {
        if (!(inp.team in b.entrants)) errs.push('slot ' + s.id + ' names team ' + inp.team + ' that is not an entrant');
        if (entered.has(inp.team)) errs.push('team ' + inp.team + ' enters twice (' + entered.get(inp.team) + ', ' + s.id + ')');
        entered.set(inp.team, s.id);
      } else {
        const src = byId.get(inp.winnerOf);
        if (!src) { errs.push('slot ' + s.id + ' reads the winner of unknown slot ' + inp.winnerOf); continue; }
        if (fedBy.has(inp.winnerOf)) errs.push('the winner of ' + inp.winnerOf + ' is used twice');
        fedBy.set(inp.winnerOf, s.id);
        if (rIdx.get(src.round)! >= rIdx.get(s.round)!) errs.push('slot ' + s.id + ' (' + s.round + ') is fed by ' + src.id + ' (' + src.round + '), which is not an earlier round');
      }
    }
  }
  for (const t of Object.keys(b.entrants)) if (!entered.has(t)) errs.push('entrant ' + t + ' never enters the bracket');
  const roots = b.slots.filter((s) => !fedBy.has(s.id));
  if (roots.length !== 1) errs.push('expected exactly one championship slot, found ' + roots.length);
  /* completed winners must be one of the two teams that can reach the slot */
  const reach = new Map<string, Set<string>>();
  const teamsOf = (s: Slot): Set<string> => {
    if (reach.has(s.id)) return reach.get(s.id)!;
    const out = new Set<string>();
    for (const inp of [s.a, s.b]) { if (isTeam(inp)) out.add(inp.team); else { const src = byId.get(inp.winnerOf); if (src) for (const t of teamsOf(src)) out.add(t); } }
    reach.set(s.id, out); return out;
  };
  for (const s of b.slots) if (s.winner != null && !teamsOf(s).has(s.winner)) errs.push('slot ' + s.id + ' winner ' + s.winner + ' cannot reach it');
  /* a completed slot's inputs must be determined: a fixed winner downstream of an unplayed slot is incoherent */
  for (const s of b.slots) {
    if (s.winner == null) continue;
    for (const inp of [s.a, s.b]) if (!isTeam(inp)) { const src = byId.get(inp.winnerOf); if (src && src.winner == null) errs.push('slot ' + s.id + ' is completed but its input ' + src.id + ' is not'); }
  }
  return errs;
}

export interface PlayedGame { slot: string; round: string; region: string | null; home: string; away: string; winner: string; fixed: boolean; p_home: number | null }

/** play every slot in order; resolve(slot, a, b) returns the winner of an open game */
export function playBracket(b: Bracket, order: Slot[], resolve: (s: Slot, a: string, b: string) => { winner: string; p: number }): { winners: Map<string, string>; games: PlayedGame[]; champion: string } {
  const winners = new Map<string, string>(); const games: PlayedGame[] = [];
  const who = (x: SlotInput): string => (isTeam(x) ? x.team : (winners.get(x.winnerOf) as string));
  for (const s of order) {
    const a = who(s.a), c = who(s.b);
    if (a == null || c == null) throw new Error('slot ' + s.id + ' played before its inputs');
    if (s.winner != null) { winners.set(s.id, s.winner); games.push({ slot: s.id, round: s.round, region: s.region, home: a, away: c, winner: s.winner, fixed: true, p_home: null }); continue; }
    const r = resolve(s, a, c);
    if (r.winner !== a && r.winner !== c) throw new Error('slot ' + s.id + ' resolved to a team that is not playing');
    winners.set(s.id, r.winner); games.push({ slot: s.id, round: s.round, region: s.region, home: a, away: c, winner: r.winner, fixed: false, p_home: r.p });
  }
  const root = order[order.length - 1];
  return { winners, games, champion: winners.get(root.id) as string };
}

/** per round: the number of slots (each produces exactly one winner and holds two entrants) */
export function slotsPerRound(b: Bracket): Record<string, number> {
  const o: Record<string, number> = {}; for (const r of b.rounds) o[r] = 0; for (const s of b.slots) o[s.round]++; return o;
}
