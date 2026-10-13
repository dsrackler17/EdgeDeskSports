#!/usr/bin/env node
'use strict';
/* ===========================================================================
   The data pack against the sources each brain is trained on.

     node tools/datapack/crosscheck.js [--offline]     writes datapack/quant_v1/EDGEDESK_CROSSCHECK.json
     node tools/datapack/crosscheck.js --check         the committed result still holds

   The pack (datapack/quant_v1) is a separate retrieval, mostly from ESPN, of
   one season per sport. Each brain trains on a multi-season source. Before a
   brain's record means anything, the two must agree on what happened:

     nhl          hockey/validation/nhl_crosscheck_espn.json (its own job)
     nba, wnba,   pack ESPN games vs basketball/data (sportsdataverse, also
     ncaam, ncaaw ESPN-derived: same game ids) — finals and neutral sites
     epl          pack ESPN 2024-25 vs soccer/data/epl (openfootball, an
                  independent source) — matched by date (±1 day) and clubs
     nfl          pack game labels 2022-24 vs nflverse nfldata games.csv (the
                  football engine's own source) — scores and archived lines
     mlb          pack 2024 is the training source for that season (no second
                  source); its regular season is counted against 30 x 162 / 2
     cfb, college_baseball, ufc, tennis_atp, tennis_wta
                  samples with no second source wired here: counted, flagged
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const { readCsv } = require('../../engine/csv');
const { fetchFile } = require('../../engine/lab/fetch');

const ROOT = path.join(__dirname, '..', '..');
const PACK = path.join(ROOT, 'datapack', 'quant_v1', 'data');
const OUT = path.join(ROOT, 'datapack', 'quant_v1', 'EDGEDESK_CROSSCHECK.json');
const pack = (f) => readCsv(path.join(PACK, f)).rows;

function basketball(league, packDir, season) {
  const I = require(path.join(ROOT, 'basketball', 'ingest.js'));
  const mine = new Map(I.loadGames(league, [season]).map((g) => [g.game_id, g]));
  const p = pack(packDir + '/games_historical.csv');
  const r = { pack_rows: p.length, pack_final: 0, matched: 0, final_agree: 0, neutral_agree: 0, added_from_pack: 0, unmatched: 0, unmatched_examples: [], disagreements: [] };
  for (const g of p) {
    if (g.status !== 'STATUS_FINAL') continue;
    r.pack_final++;
    const m = mine.get(String(g.game_id));
    if (m && m.src === 'P') { r.added_from_pack++; continue; }
    if (!m) { r.unmatched++; if (r.unmatched_examples.length < 5) r.unmatched_examples.push({ id: g.game_id, game: g.away_name + ' at ' + g.home_name, start: g.start_time }); continue; }
    r.matched++;
    if (Number(g.home_score) === m.hs && Number(g.away_score) === m.as) r.final_agree++;
    else if (r.disagreements.length < 10) r.disagreements.push({ id: g.game_id, pack: g.home_score + '-' + g.away_score, source: m.hs + '-' + m.as });
    if ((g.neutral_site === 'True') === (m.neutral === 1)) r.neutral_agree++;
  }
  r.reading = 'Same game ids (both ESPN-derived). matched/final_agree compare the source\'s own rows; added_from_pack are pack games the source lacked, now in the table (src = P). Unmatched pack games are preseason or exhibition events dropped by design.';
  return r;
}

function epl() {
  const { clubKey, loadMatches } = require(path.join(ROOT, 'soccer', 'ingest.js'));
  const mine = loadMatches('epl', [2025]).filter((m) => m.status === 'FINAL');
  const p = pack('soccer/games_historical.csv');
  const r = { pack_rows: p.length, matched: 0, final_agree: 0, unmatched: 0, unmatched_examples: [], disagreements: [], date_shift_days: {} };
  const used = new Set();
  for (const g of p) {
    const h = clubKey(g.home_name), a = clubKey(g.away_name);
    const d = Date.parse(g.start_time.slice(0, 10) + 'T12:00:00Z');
    const m = mine.find((x) => !used.has(x.match_id) && x.home === h && x.away === a && Math.abs(Date.parse(x.date + 'T12:00:00Z') - d) <= 864e5);
    if (!m) { r.unmatched++; if (r.unmatched_examples.length < 8) r.unmatched_examples.push({ game: g.away_name + ' at ' + g.home_name, keys: [h, a], date: g.start_time }); continue; }
    used.add(m.match_id); r.matched++;
    const shift = Math.round((Date.parse(m.date + 'T12:00:00Z') - d) / 864e5); r.date_shift_days[shift] = (r.date_shift_days[shift] || 0) + 1;
    if (Number(g.home_score) === m.hg && Number(g.away_score) === m.ag) r.final_agree++;
    else if (r.disagreements.length < 10) r.disagreements.push({ game: m.match_id, pack: g.home_score + '-' + g.away_score, openfootball: m.hg + '-' + m.ag });
  }
  r.reading = 'Independent sources. ESPN dates are UTC; openfootball dates are local, so an evening kick-off can sit one day apart.';
  return r;
}

async function nfl(o) {
  const src = await fetchFile('https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv', { offline: o.offline, ttlMs: 7 * 86400e3 });
  if (!src.ok) return { state: 'SOURCE_UNAVAILABLE', error: src.error || src.status };
  const g = new Map(readCsv(src.file).rows.map((x) => [x.game_id, x]));
  const p = pack('nfl/game_labels_2022_2024.csv');
  const r = { pack_rows: p.length, matched: 0, final_agree: 0, spread_line_agree: 0, total_line_agree: 0, unmatched: 0, disagreements: [] };
  for (const x of p) {
    const m = g.get(x.game_id);
    if (!m) { r.unmatched++; continue; }
    r.matched++;
    if (x.home_score === m.home_score && x.away_score === m.away_score) r.final_agree++; else if (r.disagreements.length < 10) r.disagreements.push({ id: x.game_id, pack: x.home_score + '-' + x.away_score, nfldata: m.home_score + '-' + m.away_score });
    if (Number(x.spread_line) === Number(m.spread_line)) r.spread_line_agree++;
    if (Number(x.total_line) === Number(m.total_line)) r.total_line_agree++;
  }
  r.source = { url: src.url, sha256: src.sha256 };
  r.reading = 'Both from nflverse. Archived spread and total lines are consensus closing lines without a capture time: they are research labels, never a market test or a "pregame known" price.';
  return r;
}

function counted(f, note) { const p = pack(f); return { rows: p.length, state: 'NO_SECOND_SOURCE', note }; }

async function run(o) {
  o = o || {};
  const hockey = (() => { try { const x = JSON.parse(fs.readFileSync(path.join(ROOT, 'hockey', 'validation', 'nhl_crosscheck_espn.json'), 'utf8')); return { matched: x.games.matched, final_agree: x.results.final_agree, goals_against_agree: x.goalies.goals_against_agree + '/' + x.goalies.goalie_rows, unblocked_attempts_exact: x.unblocked_attempts.exact + '/' + x.unblocked_attempts.team_games, file: 'hockey/validation/nhl_crosscheck_espn.json' }; } catch (_) { return { state: 'NOT_RUN' }; } })();
  const mlbRows = pack('mlb/games_2024.csv');
  return {
    schema: 'edgedesk_datapack_crosscheck_v1',
    sports: {
      nhl: hockey,
      nba: basketball('nba', 'nba', 2025),
      wnba: basketball('wnba', 'wnba', 2024),
      ncaam: basketball('ncaam', 'cbb_men', 2025),
      ncaaw: basketball('ncaaw', 'cbb_women', 2025),
      epl: epl(),
      nfl: await nfl(o),
      mlb: { rows: mlbRows.length, regular_season_final: mlbRows.filter((x) => x.game_type === 'R' && (x.status === 'Final' || x.status === 'Completed Early')).length, expected_regular_season: 2430, state: 'TRAINING_SOURCE_FOR_2024', note: 'the 2024 season of mlb/history comes from this table; no starting pitchers' },
      cfb: counted('cfb/games_historical.csv', '111-game sample; the CFB brain trains on its own sources (football/)'),
      college_baseball: counted('college_baseball/games_historical.csv', 'explicit-date sample; too sparse for a model'),
      ufc: counted('ufc/bouts_2024.csv', 'one year of bout results; see engine/lab/ufc_elo.json'),
      tennis_atp: counted('tennis_atp/matches_sample.csv', 'four query dates; tennis is retired'),
      tennis_wta: counted('tennis_wta/matches_sample.csv', 'four query dates; tennis is retired'),
    },
  };
}

function stable(r) { return JSON.stringify(r, (k, v) => (k === 'sha256' ? undefined : v)); }

if (require.main === module) {
  run({ offline: process.argv.includes('--offline') || process.argv.includes('--check') }).then((r) => {
    for (const [k, v] of Object.entries(r.sports)) console.log('[crosscheck] ' + k.padEnd(16) + ' ' + JSON.stringify(Object.fromEntries(Object.entries(v).filter(([kk]) => !/examples|disagreements|reading|source|note/.test(kk)))));
    if (process.argv.includes('--check')) {
      const old = JSON.parse(fs.readFileSync(OUT, 'utf8'));
      const bad = ['nba', 'wnba', 'ncaam', 'ncaaw'].filter((k) => r.sports[k].final_agree !== r.sports[k].matched || r.sports[k].matched + r.sports[k].added_from_pack < 0.9 * r.sports[k].pack_final);
      if (r.sports.nfl.state !== 'SOURCE_UNAVAILABLE' && r.sports.nfl.final_agree !== r.sports.nfl.matched) bad.push('nfl');
      if (bad.length || stable(old.sports.nba) !== stable(r.sports.nba)) { console.error('[crosscheck --check] FAILED ' + bad.join(',')); process.exit(1); }
      console.log('[crosscheck --check] ok'); return;
    }
    fs.writeFileSync(OUT, JSON.stringify(r, null, 1) + '\n');
  }).catch((e) => { console.error(e && e.stack || e); process.exit(1); });
}
module.exports = { run };
