/* Shared helpers for the CFB suites: the committed fixtures, a league for any
   historical season, and SYNTHETIC leagues built from stated results. */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import type { CfbSnapshot } from '../src/sports/cfb/inputs.ts';
import { sunBeltDivisions } from '../src/sports/cfb/inputs.ts';
import type { FeedGame } from '../src/sports/cfb/engine_adapter.ts';
import { CfbLeague, ConfTable, type CfbTeam, type CfbGame, type SeasonResults } from '../src/sports/cfb/rules.ts';
import { hashCanonical } from '../src/core/canonical.ts';
import { streamFor } from '../src/core/prng.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CFB_FIXTURE = path.join(HERE, '..', 'fixtures', 'cfb_2026_wk7_snapshot.json.gz');
export function cfbFixture(): CfbSnapshot {
  const s = JSON.parse(zlib.gunzipSync(fs.readFileSync(CFB_FIXTURE)).toString('utf8')) as CfbSnapshot;
  if (hashCanonical(s.data) !== s.input_hash) throw new Error('fixture snapshot hash mismatch');
  return s;
}
export function clone<T>(x: T): T { return JSON.parse(JSON.stringify(x)); }

let HIST: FeedGame[] | null = null;
export function history(): FeedGame[] {
  if (HIST) return HIST;
  const d = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(HERE, '..', 'fixtures', 'cfb_history.json.gz'))).toString('utf8'));
  HIST = d.rows.map((r: any[]) => {
    const o: any = {}; d.columns.forEach((c: string, i: number) => { o[c] = r[i]; });
    return { game_id: o.game_id, season: o.season, week: o.week, season_type: o.season_type, start_date: o.start_date, kick: Date.parse(o.start_date) || 0,
      completed: !!o.completed, neutral: !!o.neutral, conference_game: !!o.conference_game, notes: o.notes, venue_id: o.venue_id,
      home: o.home, home_division: o.home_division, home_conference: o.home_conference || '', home_points: o.home_points,
      away: o.away, away_division: o.away_division, away_conference: o.away_conference || '', away_points: o.away_points } as FeedGame;
  });
  return HIST!;
}
export const isCcgRow = (g: FeedGame) => !!g.notes && /championship/i.test(g.notes) && !/playoff|bowl/i.test(g.notes);

/** a historical season's league: FBS teams in their season conferences, conference games before the title games, results as played */
export function seasonLeague(season: number, procedures: Record<string, string>, ineligible: string[] = []) {
  const rows = history().filter((g) => g.season === season);
  const confOf = new Map<string, string>();
  for (const g of rows) { if (g.home_division === 'fbs') confOf.set(g.home, g.home_conference || 'FBS Independents'); if (g.away_division === 'fbs') confOf.set(g.away, g.away_conference || 'FBS Independents'); }
  const names = [...confOf.keys()].sort(), ix = new Map(names.map((n, i) => [n, i]));
  const div = procedures['Sun Belt'] ? sunBeltDivisions(rows, confOf) : new Map<string, string>();
  const teams: CfbTeam[] = names.map((n) => ({ id: n, name: n, conference: confOf.get(n)!, division: div.get(n) || null, ccg_eligible: !ineligible.includes(n), cfp_eligible: true, rating: 0 }));
  const ccg = rows.filter(isCcgRow);
  const ccgDay = new Map<string, string>(); for (const g of ccg) ccgDay.set(confOf.get(g.home)!, g.start_date.slice(0, 10));
  const games: CfbGame[] = [];
  for (const g of rows) {
    if (g.season_type !== 'regular' || isCcgRow(g) || !g.completed) continue;
    const h = g.home_division === 'fbs' ? ix.get(g.home)! : -1, a = g.away_division === 'fbs' ? ix.get(g.away)! : -1;
    if (h < 0 && a < 0) continue;
    const same = h >= 0 && a >= 0 && confOf.get(g.home) === confOf.get(g.away) && confOf.get(g.home) !== 'FBS Independents';
    const conf = g.conference_game && same ? confOf.get(g.home)! : null;
    const day = g.start_date.slice(0, 10);
    games.push({ game_id: g.game_id, week: g.week, kickoff: g.start_date, home: h, away: a, neutral: g.neutral, conf, ccg_counts: !!conf && (!ccgDay.get(conf) || day < ccgDay.get(conf)!),
      before_selection: true, done: true, home_points: g.home_points, away_points: g.away_points, exempt_for_visitor: !g.neutral && g.home === "Hawai'i" });
  }
  const L = new CfbLeague(teams, games, procedures);
  const margin = new Float64Array(games.length); games.forEach((g, k) => { margin[k] = (g.home_points as number) - (g.away_points as number); });
  /* owned data has no SportSource / computer-composite / CFP-ranking value: a distinct placeholder makes any step that
     reaches one SEPARATE (and so be recorded as an external-ranking decision) instead of passing silently to the next */
  const R: SeasonResults = { margin, points: () => ({ home: Float64Array.from(games.map((g) => g.home_points as number)), away: Float64Array.from(games.map((g) => g.away_points as number)) }), surrogate: (t) => -t };
  const actual = new Map<string, string[]>();
  for (const g of ccg) actual.set(confOf.get(g.home)!, [g.home, g.away].sort());
  return { L, R, teams, games, actual, names, ix };
}

/* ------------------------------------------------------- SYNTHETIC leagues */
export interface SynthGame { h: string; a: string; m: number; conf?: boolean; hp?: number; ap?: number; fcs?: boolean; atHawaii?: boolean }
/** a SYNTHETIC conference: teams (optionally with divisions), games (home, away, home margin) */
export function synth(conference: string, procedure: string, teams: Array<string | [string, string]>, games: SynthGame[],
  opt: { ineligible?: string[]; surrogate?: Record<string, number>; seed?: bigint } = {}) {
  const list = teams.map((t) => (Array.isArray(t) ? t : [t, null]) as [string, string | null]);
  const T: CfbTeam[] = list.map(([n, d]) => ({ id: n, name: n, conference, division: d, ccg_eligible: !(opt.ineligible || []).includes(n) && !/^F/.test(n), cfp_eligible: true, rating: 0 }));
  const ix = new Map(T.map((t, i) => [t.name, i]));
  const G: CfbGame[] = games.map((g, k) => {
    const h = g.fcs && !ix.has(g.h) ? -1 : ix.get(g.h)!, a = g.fcs && !ix.has(g.a) ? -1 : ix.get(g.a)!;
    if (h === undefined || a === undefined) throw new Error('synthetic game names an unknown team: ' + g.h + ' v ' + g.a);
    const conf = g.conf === false || h < 0 || a < 0 ? null : conference;
    return { game_id: 'S' + k, week: 1 + k, kickoff: '2026-09-01', home: h, away: a, neutral: false, conf, ccg_counts: !!conf, before_selection: true, done: true,
      home_points: g.hp ?? null, away_points: g.ap ?? null, exempt_for_visitor: !!g.atHawaii };
  });
  const L = new CfbLeague(T, G, { [conference]: procedure });
  const margin = Float64Array.from(games.map((g) => g.m));
  const pts = games.every((g) => g.hp != null) ? { home: Float64Array.from(games.map((g) => g.hp as number)), away: Float64Array.from(games.map((g) => g.ap as number)) } : null;
  const R: SeasonResults = { margin, points: () => pts, surrogate: (t) => (opt.surrogate ? opt.surrogate[T[t].name] ?? 0 : 0) };
  const ctx = { rng: streamFor(opt.seed ?? 7n, 0, 4), diag: () => {}, flag: () => {}, trace: () => {} };
  const table = () => new ConfTable(L, 0, R, ctx);
  const names = (xs: number[]) => xs.map((t) => T[t].name);
  return { L, R, table, names, ix };
}
/** `n` wins (or losses) for `team` against fresh filler teams of the same conference. Fillers are postseason-INELIGIBLE
    (pass them to synth's `ineligible`): a filler that beat a team would otherwise lead the standings at 1-0. */
export function filler(team: string, wins: number, losses: number, tag: string): { teams: string[]; games: SynthGame[] } {
  const teams: string[] = [], games: SynthGame[] = [];
  for (let i = 0; i < wins + losses; i++) {
    const f = 'F' + tag + i; teams.push(f);
    games.push({ h: team, a: f, m: i < wins ? 7 : -7 });
  }
  return { teams, games };
}
