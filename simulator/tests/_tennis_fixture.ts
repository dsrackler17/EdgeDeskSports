/* Tennis runs for the reader tests (tennis_ui.test.ts, ui.e2e.ts): the committed feeds' draws and matches when the
   day's data give at least one draw with a known order and the day's matches; otherwise the frozen snapshots in
   fixtures/tennis_snapshots.json (2026-10-23: the Almaty Open and the Japan Women's Open at the semifinals, and 48
   matches), so a day when no draw can be confirmed yet never turns the reader's tests red.
   Regenerate the fixture by writing buildTennisSnapshots({ offline: true }) output in the same shape. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeTennis, type TennisRunOutcome } from '../src/sports/tennis/run.ts';
import { writeTennisSnapshot, type TennisSnapshot } from '../src/sports/tennis/inputs.ts';

export const TENNIS_FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'tennis_snapshots.json');
export function fixtureSnapshots(): TennisSnapshot[] { return JSON.parse(fs.readFileSync(TENNIS_FIXTURE, 'utf8')).snapshots; }

export async function tennisRuns(runs: number, seed: string): Promise<{ runs: TennisRunOutcome[]; source: 'committed feeds' | 'fixture' }> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tennis-runs-'));
  const live = await executeTennis({ season: 2026, runs, seed, workers: 1, snapshot: null, out: path.join(tmp, 'feeds'), traceRuns: [], offline: true }, () => {});
  if (live.runs.some((r) => r.results.run.competition !== 'matches') && live.runs.some((r) => r.results.run.competition === 'matches')) return { runs: live.runs, source: 'committed feeds' };
  const out: TennisRunOutcome[] = [];
  for (const s of fixtureSnapshots()) {
    const f = path.join(tmp, s.data.competition + '.json');
    writeTennisSnapshot(f, s);
    const o = await executeTennis({ season: 2026, runs, seed, workers: 1, snapshot: f, out: path.join(tmp, 'fixture'), traceRuns: [] , offline: true }, () => {});
    out.push(...o.runs);
  }
  return { runs: out, source: 'fixture' };
}
