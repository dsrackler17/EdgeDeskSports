/* ===========================================================================
   ESPN'S TENNIS SCOREBOARD, AS THE TENNIS SIMULATION READS IT — one parser
   for the committed feed (simulator/src/cli/fetch_sports_data.ts --what
   tennis) and for a run's live read of today's scoreboards (inputs.ts), so
   a match is the same record either way. The document itself is parsed by
   the repository's tennis adapter (tools/tennis/espn.js parseScoreboard);
   this keeps its singles matches, side a being ESPN's first competitor.
   =========================================================================== */
import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO, type FeedMatch } from './elo.ts';

const require = createRequire(import.meta.url);
export const espnTennis = require(path.join(REPO, 'tools', 'tennis', 'espn.js')) as {
  scoreboardRangeUrl: (tour: string, fromMs: number, toMs: number) => string; scoreboardPlainUrl: (tour: string) => string;
  parseScoreboard: (j: unknown, tour: string) => Array<Record<string, any>>; rankingsUrls: (tour: string) => Array<{ via: string; url: string }>; parseRankings: (j: unknown) => unknown };

/** one singles match, as the tennis simulation reads it (side a = the feed's first competitor) */
export function tennisMatchRow(m: Record<string, any>, t: Record<string, any>) {
  return {
    id: m.provider_match_id, tid: t.provider_tournament_id, tournament: t.name, level: t.level, surface: t.surface, start: t.start_date, end: t.end_date, draw_size: t.draw_size,
    tour: m.tour, grouping: m.grouping, round: m.round, best_of: m.best_of, at: m.scheduled_at, order: m.match_order,
    a_id: m.home_provider_id, a: m.home_name, a_seed: m.home_seed, a_rank: m.home_rank,
    b_id: m.away_provider_id, b: m.away_name, b_seed: m.away_seed, b_rank: m.away_rank,
    status: m.status, result: m.result_type, detail: m.status_detail, winner: m.winner_side === 'home' ? 'a' : m.winner_side === 'away' ? 'b' : null,
    sets: (m.set_scores || []).map((x: any) => [x.home, x.away, x.home_tb, x.away_tb])
  };
}
/** every singles match on a scoreboard document */
export function scoreboardRows(doc: unknown, tour: string): FeedMatch[] {
  const out: FeedMatch[] = [];
  for (const t of espnTennis.parseScoreboard(doc, tour)) for (const m of t.matches) if (!m.is_doubles && m.provider_match_id) out.push(tennisMatchRow(m, t) as unknown as FeedMatch);
  return out;
}
