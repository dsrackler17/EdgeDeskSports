/* ===========================================================================
   Build simulator/fixtures/nfl_history.json.gz — the REAL historical fixture
   the NFL rules engine is tested against.

   Source (public, keyless): nflverse/nfldata
     data/games.csv      every game: season, type, week, teams, final score
     data/standings.csv  every club-season: record, points, SOV, SOS, the
                         final division rank and the playoff seed

   For each season 2002-2025 the fixture keeps the regular-season results,
   the postseason games (who hosted whom, per round) and each club's
   standings row. The test recomputes the standings, the division ranks and
   the seeds from the results alone and must reproduce the published ones.

     node simulator/src/research/build_nfl_history_fixture.ts [--games FILE] [--standings FILE]
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { parseCsv, num } from '../core/csv.ts';
import { sha256Hex } from '../core/canonical.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', '..', 'fixtures', 'nfl_history.json.gz');
const URLS = {
  games: 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv',
  standings: 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/standings.csv'
};

async function get(name: 'games' | 'standings', file: string | undefined): Promise<{ text: string; url: string }> {
  if (file) return { text: fs.readFileSync(file, 'utf8'), url: URLS[name] + ' (local copy ' + path.basename(file) + ')' };
  const r = await fetch(URLS[name]);
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + URLS[name]);
  return { text: await r.text(), url: URLS[name] };
}

async function main() {
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const G = await get('games', arg('--games')), S = await get('standings', arg('--standings'));
  const games = parseCsv(G.text), standings = parseCsv(S.text);
  const seasons: Record<string, unknown> = {};
  for (let y = 2002; y <= 2025; y++) {
    const st = standings.filter((r) => num(r.season) === y);
    const gs = games.filter((r) => num(r.season) === y);
    const reg = gs.filter((r) => r.game_type === 'REG');
    if (st.length !== 32) throw new Error(y + ': standings has ' + st.length + ' clubs');
    if (reg.some((r) => r.home_score == null || r.away_score == null)) throw new Error(y + ': a regular-season game has no score');
    seasons[String(y)] = {
      teams: st.map((r) => ({ code: r.team, conference: r.conf, division: r.division, wins: num(r.wins), losses: num(r.losses), ties: num(r.ties),
        scored: num(r.scored), allowed: num(r.allowed), sov: num(r.sov), sos: num(r.sos), div_rank: num(r.div_rank), seed: num(r.seed), playoff: r.playoff })),
      regular: reg.map((r) => [r.game_id, num(r.week), r.home_team, r.away_team, num(r.home_score), num(r.away_score)]),
      postseason: gs.filter((r) => r.game_type !== 'REG').map((r) => [r.game_id, r.game_type, r.home_team, r.away_team, num(r.home_score), num(r.away_score), r.location])
    };
  }
  const doc = {
    schema: 'edgedesk_sim_nfl_history_fixture_v1',
    built_at: new Date().toISOString(),
    provenance: 'Observed: nflverse/nfldata, public. Final standings rows (div_rank, seed) are the published values the rules engine must reproduce.',
    sources: [
      { name: 'games.csv', url: G.url, sha256: sha256Hex(G.text), bytes: G.text.length },
      { name: 'standings.csv', url: S.url, sha256: sha256Hex(S.text), bytes: S.text.length }
    ],
    seasons
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, zlib.gzipSync(JSON.stringify(doc), { level: 9 }));
  console.log('wrote ' + path.relative(process.cwd(), OUT) + ' (' + fs.statSync(OUT).size + ' bytes, 24 seasons)');
}
main().catch((e) => { console.error(e); process.exit(2); });
