#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NBA Data Pack (datapack/nba_v1) — independent verification in Node.

   The pack's own scripts (collect.py, player_features.py, core_supplement.py,
   package.py) are never run: the pack is data, not code I execute. Its Parquet
   is read through the engine's own reader (nba/tools/parquet_select.py,
   pyarrow only). Every value in the pack is a string (Python str(), JSON for
   compound cells, None for missing); numbers are parsed here explicitly and
   null stays null, never zero. The checks:

     1. inventory: each table's SHA-256 (of the Parquet bytes), rows and
        column names as sources/inventory.json lists them, and as COVERAGE.json
        repeats them; every column is a string; no table the inventory omits;
     2. known_at is null in every table that carries it (first publication was
        not recorded; a filled known_at would be a backdated claim);
     3. scope: 1,322 final club games, 30 clubs, native season types 2/5/3;
        the NBA Cup final identified by its native competition type (CC / 39)
        and kept out of the regular season; 1,230 regular-season games, 82 per
        club;
     4. detail coverage: exactly the four games COVERAGE.json lists have no
        summary (HTTP 404), the core supplement covers exactly those four, and
        every other game has team and player boxes and play-by-play;
     5. keys: games, team-games, identified player-games and (game, event id)
        unique; the 33 player rows the source gave no athlete id keep a null
        id in player_boxscores and are listed apart in
        unresolved_player_identity_records — never joined, by name or
        otherwise;
     6. scores: period scores sum to every final; the last period scored is
        the one games.parquet states; team box points (2·FGM + 3PM + FTM)
        equal each final; the players' points equal it on every team-game
        without an unidentified row; every game with a summary has
        play-by-play (where its running score falls short of the final, the
        games and the points missing are listed under findings);
     7. subsets: shots_and_free_throws is exactly the shooting plays and
        substitutions exactly the substitution plays of play-by-play, row for
        row (not additional observations);
     8. every measured team and player feature recomputed from the boxes, and
        every prior-5/10/20 lag recomputed with the target game excluded and
        only earlier games used (team lags from measured rows; player lags
        from positive-minute rows only);
     9. the contracts in schemas/ are byte-identical to datapack/quant_v1's,
        and each JSON Schema's properties equal its EMPTY_TEMPLATE header.

   Facts about the data that are not pass/fail (DNP reason mix, minutes
   precision, coordinate ranges, officials per game, the Cup final's identity)
   are reported under `findings`.

   Writes datapack/nba_v1/EDGEDESK_VERIFICATION.json. --check recomputes and
   fails when the result differs from the committed file (time stamp aside) or
   when any check fails.

   Run: node tools/datapack/verify_nba.js [--check]
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
/* EDGEDESK_NBA_PACK points the verifier at a copy (the tamper test in tools/nba/nba.test.js) */
const PACK = process.env.EDGEDESK_NBA_PACK ? path.resolve(process.env.EDGEDESK_NBA_PACK) : path.join(ROOT, 'datapack', 'nba_v1');
const QUANT = path.join(ROOT, 'datapack', 'quant_v1');
const OUT = path.join(PACK, 'EDGEDESK_VERIFICATION.json');
const HELPER = path.join(ROOT, 'nba', 'tools', 'parquet_select.py');
const io = require(path.join(ROOT, 'nba', 'lib', 'io.js'));

const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
const pair = (v) => { const m = /^(\d+)-(\d+)$/.exec(String(v == null ? '' : v)); return m ? [Number(m[1]), Number(m[2])] : [null, null]; };
const close = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)));
const count = (a, f) => { const m = {}; for (const x of a) { const k = f(x); m[k] = (m[k] || 0) + 1; } return m; };
const sorted = (m) => Object.fromEntries(Object.keys(m).sort().map((k) => [k, m[k]]));
const parseJson = (s) => { try { return JSON.parse(s); } catch (_) { return null; } };

function meta(file) {
  const r = spawnSync('python3', [HELPER, '--meta', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('parquet meta failed for ' + file + ': ' + r.stderr);
  return JSON.parse(r.stdout);
}
async function load(table, cols) {
  const rows = []; for await (const r of io.parquetRows(path.join(PACK, 'data', table + '.parquet'), cols)) rows.push(r); return rows;
}

async function verify() {
  const checks = []; const findings = {};
  const check = (id, pass, detail) => { checks.push({ id, pass: !!pass, detail: detail == null ? null : detail }); return !!pass; };
  const coverage = JSON.parse(fs.readFileSync(path.join(PACK, 'COVERAGE.json'), 'utf8'));
  const inventory = JSON.parse(fs.readFileSync(path.join(PACK, 'sources', 'inventory.json'), 'utf8'));

  /* 1. inventory */
  const datasets = [];
  for (const t of inventory) {
    const file = path.join(PACK, 'data', t.table + '.parquet');
    const d = { table: t.table, expected_rows: t.rows };
    if (!fs.existsSync(file)) { d.state = 'MISSING'; datasets.push(d); continue; }
    const m = meta(file);
    d.sha_ok = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') === t.sha256;
    d.rows = m.rows; d.columns = m.columns.length;
    d.columns_ok = JSON.stringify(m.columns.map((c) => c.name).sort()) === JSON.stringify(t.columns.slice().sort());
    d.all_strings = m.columns.every((c) => c.type === 'string' || c.type === 'null'); /* an all-null column (known_at) is typed null */
    d.null_typed = m.columns.filter((c) => c.type === 'null').map((c) => c.name);
    const cov = coverage.tables.find((x) => x.table === t.table);
    d.coverage_ok = !!cov && cov.rows === t.rows && cov.sha256 === t.sha256;
    d.state = d.sha_ok && d.rows === t.rows && d.columns_ok && d.all_strings && d.coverage_ok ? 'VERIFIED' : 'FAILED';
    datasets.push(d);
  }
  const failed = datasets.filter((d) => d.state !== 'VERIFIED');
  check('inventory_sha256_rows_columns_strings', failed.length === 0, failed);
  const listed = new Set(inventory.map((t) => t.table + '.parquet'));
  const unlisted = fs.readdirSync(path.join(PACK, 'data')).filter((f) => !listed.has(f));
  check('no_unlisted_tables', unlisted.length === 0, unlisted);
  check('coverage_lists_every_table', coverage.tables.length === inventory.length, { coverage: coverage.tables.length, inventory: inventory.length });

  /* the tables */
  const games = await load('games', ['game_id', 'season', 'season_type', 'scope', 'competition_type', 'notes', 'date', 'home_id', 'away_id', 'home_score', 'away_score', 'last_scoring_period', 'summary_available', 'venue', 'known_at']);
  const G = new Map(games.map((g) => [g.game_id, g]));
  const periods = await load('period_scores', ['game_id', 'team_id', 'period', 'points']);
  const tbox = await load('team_boxscores', ['game_id', 'team_id', 'home_away', 'fieldGoalsMade-fieldGoalsAttempted', 'threePointFieldGoalsMade-threePointFieldGoalsAttempted', 'freeThrowsMade-freeThrowsAttempted', 'offensiveRebounds', 'defensiveRebounds', 'totalTurnovers', 'turnovers', 'teamTurnovers']);
  const pbox = await load('player_boxscores', ['game_id', 'team_id', 'player_id', 'MIN', 'PTS', 'REB', 'AST', 'TO', 'STL', 'BLK', 'OREB', 'DREB', 'PF', '+/-', 'FG', '3PT', 'FT', 'starter', 'did_not_play', 'reason']);
  const tmf = await load('team_measured_features', inventory.find((t) => t.table === 'team_measured_features').columns);
  const tlag = await load('team_pregame_lags', inventory.find((t) => t.table === 'team_pregame_lags').columns);
  const pmf = await load('player_measured_features', inventory.find((t) => t.table === 'player_measured_features').columns);
  const plag = await load('player_pregame_lags', inventory.find((t) => t.table === 'player_pregame_lags').columns);
  const unresolved = await load('unresolved_player_identity_records', ['game_id', 'team_id', 'identity_status', 'did_not_play']);
  const officials = await load('officials', ['game_id', 'order', 'position']);

  /* 2. known_at */
  const knownTables = ['games', 'play_by_play', 'shots_and_free_throws', 'substitutions', 'core_supplement_plays', 'core_supplement_shots'];
  const filled = {};
  for (const t of knownTables) { let n = 0; for await (const r of io.parquetRows(path.join(PACK, 'data', t + '.parquet'), ['known_at'])) if (r.known_at != null) n++; if (n) filled[t] = n; }
  check('known_at_null_everywhere', Object.keys(filled).length === 0, filled);

  /* 3. scope */
  const ctype = (g) => parseJson(g.competition_type) || {};
  const cup = games.filter((g) => ctype(g).abbreviation === 'CC' || ctype(g).id === '39');
  const types = count(games, (g) => g.season_type), scopes = count(games, (g) => g.scope);
  const clubs = new Set(games.flatMap((g) => [g.home_id, g.away_id]));
  const reg = games.filter((g) => g.scope === 'regular_season');
  const perClub = count(reg.flatMap((g) => [g.home_id, g.away_id]), (x) => x);
  check('scope_counts', games.length === coverage.games && JSON.stringify(sorted(types)) === JSON.stringify(sorted(coverage.native_season_type_counts)) && JSON.stringify(sorted(scopes)) === JSON.stringify(sorted(coverage.competition_scope_counts)), { types, scopes });
  check('scope_30_clubs_82_each', clubs.size === 30 && [...clubs].every((c) => Number(c) >= 1 && Number(c) <= 30) && Object.values(perClub).every((n) => n === 82) && reg.length === 1230, { clubs: clubs.size, per_club: sorted(count(Object.values(perClub), (n) => n)) });
  check('cup_final_identified_and_kept_out_of_the_regular_season', cup.length === 1 && cup[0].scope === 'nba_cup_final' && cup[0].season_type === '2', cup.map((g) => ({ game_id: g.game_id, scope: g.scope, competition_type: g.competition_type })));
  check('scope_matches_native_type', games.every((g) => (g.season_type === '3' ? g.scope === 'playoffs' : g.season_type === '5' ? g.scope === 'play_in' : g.season_type === '2' && (g.scope === 'regular_season' || g.scope === 'nba_cup_final'))), null);
  check('games_unique_with_finals', G.size === games.length && games.every((g) => num(g.home_score) != null && num(g.away_score) != null && num(g.home_score) !== num(g.away_score)), null);
  findings.cup_final = cup.map((g) => ({ game_id: g.game_id, date: g.date, home_id: g.home_id, away_id: g.away_id, venue: (parseJson(g.venue) || {}).fullName || null, competition_type: ctype(g) }));
  findings.competition_types = sorted(count(games, (g) => ctype(g).abbreviation || 'none'));

  /* 4. detail coverage */
  const missing = coverage.missing_detail_games.map((x) => x.game_id).sort();
  const noSummary = games.filter((g) => g.summary_available !== 'True').map((g) => g.game_id).sort();
  const boxGames = new Set(tbox.map((r) => r.game_id)), playerGames = new Set(pbox.map((r) => r.game_id));
  const detail = games.filter((g) => g.summary_available === 'True').map((g) => g.game_id);
  check('missing_details_exactly_as_listed', JSON.stringify(noSummary) === JSON.stringify(missing) && JSON.stringify(coverage.core_supplement_game_ids.slice().sort()) === JSON.stringify(missing), { listed: missing, no_summary: noSummary });
  check('every_detail_game_has_boxes', detail.every((g) => boxGames.has(g) && playerGames.has(g)) && missing.every((g) => !boxGames.has(g) && !playerGames.has(g)), { detail: detail.length, team_box_games: boxGames.size, player_box_games: playerGames.size });

  /* 5. keys */
  const tKey = new Set(tbox.map((r) => r.game_id + '|' + r.team_id));
  const idRows = pbox.filter((r) => r.player_id != null), noId = pbox.filter((r) => r.player_id == null);
  const pKey = new Set(idRows.map((r) => r.game_id + '|' + r.player_id));
  check('team_box_two_per_game_unique', tKey.size === tbox.length && tbox.length === 2 * detail.length, { rows: tbox.length });
  check('player_box_unique_where_identified', pKey.size === idRows.length, { rows: pbox.length, with_source_id: idRows.length });
  /* the source sometimes omits an athlete id: those rows stay in player_boxscores with a null id AND are listed apart; they are never joined (by name or otherwise) */
  const noIdKeys = noId.map((r) => r.game_id + '|' + r.team_id).sort(), unKeys = unresolved.map((r) => r.game_id + '|' + r.team_id).sort();
  check('rows_without_source_id_listed_apart', noId.length === coverage.primary_player_rows_missing_source_id && JSON.stringify(noIdKeys) === JSON.stringify(unKeys) && unresolved.every((r) => r.identity_status === 'source_id_missing_do_not_join_by_short_name'), { null_id_rows: noId.length, unresolved_rows: unresolved.length });
  findings.rows_without_source_id = { rows: noId.length, team_games: sorted(count(noId, (r) => r.team_id)), note: 'never joined by name; a null id is not a player' };

  /* 6. scores */
  const pSum = new Map(); const lastP = new Map();
  for (const p of periods) { const k = p.game_id + '|' + p.team_id; pSum.set(k, (pSum.get(k) || 0) + (num(p.points) || 0)); lastP.set(p.game_id, Math.max(lastP.get(p.game_id) || 0, num(p.period))); }
  const badPeriods = games.filter((g) => pSum.get(g.game_id + '|' + g.home_id) !== num(g.home_score) || pSum.get(g.game_id + '|' + g.away_id) !== num(g.away_score)).map((g) => g.game_id);
  check('period_scores_sum_to_finals', badPeriods.length === 0, badPeriods.slice(0, 10));
  check('last_scoring_period_as_stated', games.every((g) => num(g.last_scoring_period) === lastP.get(g.game_id)), null);
  const finalOf = (gid, tid) => { const g = G.get(gid); return tid === g.home_id ? num(g.home_score) : num(g.away_score); };
  const badBox = tbox.filter((r) => { const [fg] = pair(r['fieldGoalsMade-fieldGoalsAttempted']), [th] = pair(r['threePointFieldGoalsMade-threePointFieldGoalsAttempted']), [ft] = pair(r['freeThrowsMade-freeThrowsAttempted']); return 2 * fg + th + ft !== finalOf(r.game_id, r.team_id); }).map((r) => r.game_id + '|' + r.team_id);
  check('team_box_points_equal_finals', badBox.length === 0, badBox.slice(0, 10));
  const ptsBy = new Map(); for (const r of pbox) { const k = r.game_id + '|' + r.team_id; ptsBy.set(k, (ptsBy.get(k) || 0) + (num(r.PTS) || 0)); }
  const badPts = [...tKey].filter((k) => ptsBy.get(k) !== finalOf(k.split('|')[0], k.split('|')[1]));
  const withNoId = new Set(noIdKeys);
  check('player_points_equal_finals_except_unidentified_rows', badPts.every((k) => withNoId.has(k)), badPts.filter((k) => !withNoId.has(k)).slice(0, 10));
  findings.player_points_short_of_final = badPts.map((k) => ({ game_id: k.split('|')[0], team_id: k.split('|')[1], players_sum: ptsBy.get(k), final: finalOf(k.split('|')[0], k.split('|')[1]), note: 'the team-game carries a player row without a source id; the source box loses that line' }));
  const { reasonCat } = require(path.join(ROOT, 'nba', 'ingest', 'season.js'));
  findings.player_rows = { did_not_play_by_category: sorted(count(pbox.filter((r) => r.did_not_play === 'True'), (r) => reasonCat(r.reason))), distinct_dnp_reasons: new Set(pbox.filter((r) => r.did_not_play === 'True').map((r) => r.reason)).size, minutes_formats: sorted(count(pbox, (r) => (r.MIN == null ? 'null' : /:/.test(r.MIN) ? 'mm:ss' : 'whole'))), starters: pbox.filter((r) => r.starter === 'True').length };

  /* 6b, 7. play-by-play (streamed: one hash per row), its two subsets */
  const PBP_COLS = ['game_id', 'sequence', 'event_id', 'period', 'clock', 'type', 'type_id', 'description', 'team_id', 'home_score', 'away_score', 'scoring_play', 'score_value', 'shooting_play', 'points_attempted', 'x_native', 'y_native', 'participants', 'wallclock'];
  const rowHash = (r) => crypto.createHash('sha1').update(JSON.stringify(PBP_COLS.map((c) => r[c]))).digest('base64');
  const pbpHash = new Map(); const evKeys = new Set(); let dupSeq = 0, dupEv = 0, nShoot = 0, nSub = 0, nPbp = 0;
  const lastEv = new Map(); const xs = [], ys = [];
  for await (const r of io.parquetRows(path.join(PACK, 'data', 'play_by_play.parquet'), PBP_COLS)) {
    nPbp++;
    const ks = r.game_id + '|' + r.sequence; if (evKeys.has('s' + ks)) dupSeq++; evKeys.add('s' + ks);
    const ke = r.game_id + '|' + r.event_id; if (pbpHash.has(ke)) dupEv++; pbpHash.set(ke, rowHash(r));
    if (r.shooting_play === 'True') nShoot++;
    if (/substitution/i.test(r.type || '')) nSub++;
    const s = num(r.sequence); const l = lastEv.get(r.game_id) || { s: -1, end: null, maxH: 0, maxA: 0, after: 0 };
    if (s > l.s) l.s = s; l.maxH = Math.max(l.maxH, num(r.home_score) || 0); l.maxA = Math.max(l.maxA, num(r.away_score) || 0);
    if (r.type === 'End Game') l.end = { s, h: num(r.home_score), a: num(r.away_score) };
    lastEv.set(r.game_id, l);
    if (r.x_native != null && xs.length < 400000) { xs.push(num(r.x_native)); ys.push(num(r.y_native)); }
  }
  check('pbp_event_keys_unique', dupEv === 0, { rows: nPbp, duplicate_event_ids: dupEv });
  findings.pbp_sequence_numbers = { duplicate_game_sequences: dupSeq, note: 'sequence numbers repeat inside a game twice; (game_id, event_id) is the key, and order must be rebuilt from period and clock, not sequence alone' };
  const badEnd = detail.filter((g) => { const l = lastEv.get(g); const x = G.get(g); return !l || !l.end || l.end.h !== num(x.home_score) || l.end.a !== num(x.away_score); });
  const badMax = detail.filter((g) => { const l = lastEv.get(g); const x = G.get(g); return !l || l.maxH !== num(x.home_score) || l.maxA !== num(x.away_score); });
  check('pbp_present_for_every_detail_game', lastEv.size === detail.length && detail.every((g) => lastEv.has(g)), { games_with_pbp: lastEv.size });
  /* not pass/fail: the play-by-play misses scoring events in some games (its running score ends short of the final) */
  const shortBy = (g) => { const l = lastEv.get(g), x = G.get(g); return (num(x.home_score) - l.maxH) + (num(x.away_score) - l.maxA); };
  findings.pbp_scoring_incomplete = { games_end_game_score_differs: badEnd.length, games_highest_score_short_of_final: badMax.length, games_without_end_game_event: detail.filter((g) => lastEv.get(g) && !lastEv.get(g).end).length,
    share_of_detail_games: Math.round(1e4 * badMax.length / detail.length) / 1e4, points_missing: sorted(count(badMax.map(shortBy), (n) => n)), games: badMax,
    note: 'the box score and the scoreboard agree with the final; the play-by-play does not always: possessions or points rebuilt from these events must be reconciled to the box, never trusted alone' };
  const late = detail.filter((g) => { const l = lastEv.get(g); return l && l.end && l.s > l.end.s; });
  findings.events_sequenced_after_end_game = { games: late.length, note: 'events recorded after the End Game event carry earlier clocks (late entries / corrections): possessions and stints must be ordered by period and clock, then sequence' };
  for (const [t, want, pred] of [['shots_and_free_throws', nShoot, (r) => r.shooting_play === 'True'], ['substitutions', nSub, (r) => /substitution/i.test(r.type || '')]]) {
    let n = 0, absent = 0, differs = 0, wrongKind = 0;
    for await (const r of io.parquetRows(path.join(PACK, 'data', t + '.parquet'), PBP_COLS)) { n++; const h = pbpHash.get(r.game_id + '|' + r.event_id); if (!h) absent++; else if (h !== rowHash(r)) differs++; if (!pred(r)) wrongKind++; }
    check(t + '_is_exactly_a_pbp_subset', n === want && absent === 0 && differs === 0 && wrongKind === 0, { rows: n, expected: want, not_in_pbp: absent, differs, wrong_kind: wrongKind });
  }
  const range = (a) => a.reduce((r, v) => (v == null ? r : [Math.min(r[0], v), Math.max(r[1], v)]), [Infinity, -Infinity]);
  findings.coordinates = { sampled: xs.length, x_range: range(xs), y_range: range(ys), note: 'native units and orientation unverified (the pack says so); large sentinels were nulled by the pack' };

  /* 8a. team measured features */
  const byTG = new Map(tbox.map((r) => [r.game_id + '|' + r.team_id, r]));
  const recompute = [];
  for (const m of tmf) {
    const g = G.get(m.game_id); const r = byTG.get(m.game_id + '|' + m.team_id); const oid = m.team_id === g.home_id ? g.away_id : g.home_id; const o = byTG.get(m.game_id + '|' + oid);
    const [fg, fga] = pair(r['fieldGoalsMade-fieldGoalsAttempted']), [th, tha] = pair(r['threePointFieldGoalsMade-threePointFieldGoalsAttempted']), [ft, fta] = pair(r['freeThrowsMade-freeThrowsAttempted']);
    const [, ofga] = pair(o['fieldGoalsMade-fieldGoalsAttempted']), [, ofta] = pair(o['freeThrowsMade-freeThrowsAttempted']);
    const orb = num(r.offensiveRebounds), drb = num(r.defensiveRebounds), oorb = num(o.offensiveRebounds), odrb = num(o.defensiveRebounds), to = num(r.totalTurnovers), oto = num(o.totalTurnovers);
    const pts = finalOf(m.game_id, m.team_id), opts = finalOf(m.game_id, oid);
    const poss = ((fga - orb + to + 0.44 * fta) + (ofga - oorb + oto + 0.44 * ofta)) / 2;
    const lp = num(g.last_scoring_period); const dur = lp != null && lp >= 4 ? 48 + 5 * (lp - 4) : null;
    const x = { points: pts, opponent_points: opts, fga, fgm: fg, three_pm: th, three_pa: tha, fta, ftm: ft, off_reb: orb, def_reb: drb, opp_off_reb: oorb, opp_def_reb: odrb, turnovers: to, possessions_proxy: poss,
      off_rating_proxy: poss ? 100 * pts / poss : null, def_rating_proxy: poss ? 100 * opts / poss : null, efg_pct: fga ? (fg + 0.5 * th) / fga : null, tov_pct_proxy: poss ? to / poss : null,
      orb_pct: orb + odrb ? orb / (orb + odrb) : null, drb_pct: drb + oorb ? drb / (drb + oorb) : null, fta_per_fga: fga ? fta / fga : null, three_pa_share: fga ? tha / fga : null,
      scoring_reconciliation_delta: pts - (2 * fg + th + ft), game_minutes_from_period_count: dur, pace_per48_proxy: dur ? 48 * poss / dur : null };
    x.net_rating_proxy = x.off_rating_proxy - x.def_rating_proxy;
    const bad = Object.keys(x).filter((k) => !close(num(m[k]), x[k]));
    if (bad.length || m.scope !== g.scope) recompute.push({ game_id: m.game_id, team_id: m.team_id, fields: bad });
  }
  check('team_measured_features_recomputed', recompute.length === 0 && tmf.length === tbox.length, recompute.slice(0, 5));

  /* 8b. team lags: strictly earlier measured games of the same team */
  const LAG_T = ['points', 'opponent_points', 'possessions_proxy', 'off_rating_proxy', 'def_rating_proxy', 'efg_pct', 'tov_pct_proxy', 'orb_pct', 'drb_pct', 'fta_per_fga', 'three_pa_share', 'pace_per48_proxy'];
  const lagBy = new Map(tlag.map((r) => [r.game_id + '|' + r.team_id, r]));
  const hist = new Map(); const badT = [];
  for (const m of tmf.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.game_id < b.game_id ? -1 : 1))) {
    const h = hist.get(m.team_id) || []; const out = lagBy.get(m.game_id + '|' + m.team_id); const bad = [];
    if (!out) { badT.push({ game_id: m.game_id, team_id: m.team_id, missing: true }); continue; }
    for (const w of [5, 10, 20]) {
      const win = h.slice(-w); if (num(out['prior_' + w + '_games']) !== win.length) bad.push('prior_' + w + '_games');
      if (win.some((a) => !(a.date < m.date))) bad.push('not strictly earlier');
      for (const k of LAG_T) { const v = win.map((a) => num(a[k])).filter((x) => x != null); if (!close(num(out['prior_' + w + '_' + k + '_mean']), v.length ? v.reduce((s, x) => s + x, 0) / v.length : null)) bad.push('prior_' + w + '_' + k); }
    }
    const dd = h.length ? (Date.parse(m.date) - Date.parse(h[h.length - 1].date)) / 864e5 : null;
    if (!close(num(out.days_since_previous_start), dd)) bad.push('days_since_previous_start');
    if (bad.length) badT.push({ game_id: m.game_id, team_id: m.team_id, fields: bad.slice(0, 6) });
    h.push(m); hist.set(m.team_id, h);
  }
  check('team_pregame_lags_recomputed_strictly_prior', badT.length === 0 && tlag.length === tmf.length, badT.slice(0, 5));

  /* 8c. player measured features */
  const mins = (m) => { if (m == null) return null; if (/:/.test(m)) { const [a, b] = m.split(':'); return Number(a) + Number(b) / 60; } const n = Number(m); return isFinite(n) ? n : null; };
  const pmBy = new Map(pmf.map((r) => [r.game_id + '|' + r.player_id, r]));
  const STATMAP = [['PTS', 'points'], ['REB', 'rebounds'], ['AST', 'assists'], ['TO', 'turnovers'], ['STL', 'steals'], ['BLK', 'blocks'], ['OREB', 'off_reb'], ['DREB', 'def_reb'], ['PF', 'fouls'], ['+/-', 'plus_minus']];
  const PER36 = ['points', 'rebounds', 'assists', 'turnovers', 'steals', 'blocks', 'fga', 'three_pa', 'fta'];
  const badPm = []; const calc = [];
  for (const p of pbox) {
    const m = pmBy.get(p.game_id + '|' + p.player_id); if (!m) { badPm.push({ game_id: p.game_id, player_id: p.player_id, missing: true }); continue; }
    const g = G.get(p.game_id); const mn = mins(p.MIN);
    const [fg, fga] = pair(p.FG), [th, tha] = pair(p['3PT']), [ft, fta] = pair(p.FT);
    const x = { minutes_numeric: mn, fgm: fg, fga, three_pm: th, three_pa: tha, ftm: ft, fta };
    for (const [n, k] of STATMAP) x[k] = num(p[n]);
    const den = fga != null && fta != null ? 2 * (fga + 0.44 * fta) : null; x.true_shooting_proxy = x.points != null && den ? x.points / den : null;
    for (const k of PER36) x[k + '_per36'] = x[k] != null && mn ? x[k] * 36 / mn : null;
    const bad = Object.keys(x).filter((k) => !close(num(m[k]), x[k]));
    if (bad.length || m.scope !== g.scope || m.date !== g.date) badPm.push({ game_id: p.game_id, player_id: p.player_id, fields: bad });
    calc.push(Object.assign({ game_id: p.game_id, team_id: p.team_id, player_id: p.player_id, date: g.date }, x));
  }
  check('player_measured_features_recomputed', badPm.length === 0 && pmf.length === pbox.length, badPm.slice(0, 5));

  /* 8d. player lags: prior positive-minute games only, pooled per 36 */
  const plBy = new Map(plag.map((r) => [r.game_id + '|' + r.player_id, r]));
  const past = new Map(); const badPl = [];
  for (const r of calc.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.game_id < b.game_id ? -1 : a.game_id > b.game_id ? 1 : a.player_id < b.player_id ? -1 : 1))) {
    const h = past.get(r.player_id) || []; const out = plBy.get(r.game_id + '|' + r.player_id); const bad = [];
    if (!out) { badPl.push({ game_id: r.game_id, player_id: r.player_id, missing: true }); continue; }
    for (const w of [5, 10, 20]) {
      const win = h.slice(-w);
      if (win.some((a) => !(a.date < r.date) || !(a.minutes_numeric > 0))) bad.push('window holds a current, future or zero-minute game');
      if (num(out['prior_' + w + '_positive_minute_games']) !== win.length) bad.push('prior_' + w + '_positive_minute_games');
      const mm = win.reduce((s, a) => s + a.minutes_numeric, 0); if (!close(num(out['prior_' + w + '_mean_minutes']), win.length ? mm / win.length : null)) bad.push('prior_' + w + '_mean_minutes');
      for (const k of PER36) { const v = win.filter((a) => a[k] != null); const den = v.reduce((s, a) => s + a.minutes_numeric, 0); if (!close(num(out['prior_' + w + '_' + k + '_pooled_per36']), den ? 36 * v.reduce((s, a) => s + a[k], 0) / den : null)) bad.push('prior_' + w + '_' + k); }
      if (num(out['prior_' + w + '_different_team_games']) !== win.filter((a) => a.team_id !== r.team_id).length) bad.push('prior_' + w + '_different_team_games');
    }
    if (bad.length) badPl.push({ game_id: r.game_id, player_id: r.player_id, fields: bad.slice(0, 6) });
    if (r.minutes_numeric != null && r.minutes_numeric > 0) { h.push(r); past.set(r.player_id, h); }
  }
  check('player_pregame_lags_recomputed_positive_minutes_only', badPl.length === 0 && plag.length === pbox.length, badPl.slice(0, 5));

  /* the core supplement covers exactly the four missing games */
  const sup = {};
  for (const t of ['core_supplement_plays', 'core_supplement_shots', 'core_supplement_team_stats', 'core_supplement_player_stats', 'core_supplement_rosters']) { const ids = new Set(); for await (const r of io.parquetRows(path.join(PACK, 'data', t + '.parquet'), ['game_id'])) ids.add(r.game_id); sup[t] = [...ids].sort(); }
  check('core_supplement_covers_exactly_the_missing_games', Object.values(sup).every((ids) => JSON.stringify(ids) === JSON.stringify(missing)), sup);

  /* officials: final-game crews, research only (no assignment time) */
  check('officials_only_on_detail_games', officials.every((o) => playerGames.has(o.game_id)), null);
  findings.officials = { games: new Set(officials.map((o) => o.game_id)).size, per_game: sorted(count(Object.values(count(officials, (o) => o.game_id)), (n) => n)), note: 'officials who worked the game, from the final summary; never proof of a pregame assignment' };

  /* 9. contracts */
  const sch = []; const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(path.join(PACK, 'schemas'))) { const rel = path.relative(path.join(PACK, 'schemas'), f); const q = path.join(QUANT, 'schemas', rel); if (!fs.existsSync(q) || !fs.readFileSync(q).equals(fs.readFileSync(f))) sch.push(rel); }
  check('contracts_identical_to_quant_v1', sch.length === 0, sch);
  const tmpl = [];
  for (const f of walk(path.join(PACK, 'schemas')).filter((x) => /\.schema\.json$/.test(x))) {
    const props = Object.keys(JSON.parse(fs.readFileSync(f, 'utf8')).properties || {});
    const t = path.join(path.dirname(f), 'templates', path.basename(f).replace('.schema.json', '_EMPTY_TEMPLATE.csv'));
    const head = fs.existsSync(t) ? fs.readFileSync(t, 'utf8').split(/\r?\n/)[0].split(',') : null;
    if (!head || JSON.stringify(head) !== JSON.stringify(props)) tmpl.push(path.relative(PACK, f));
  }
  check('templates_match_schema_properties', tmpl.length === 0, tmpl);

  const passed = checks.filter((c) => c.pass).length;
  return { schema: 'edgedesk_datapack_verification_v1', pack: 'datapack/nba_v1', verified_at: new Date().toISOString(), status: passed === checks.length ? 'PASSED' : 'FAILED',
    summary: { datasets: datasets.length, verified: datasets.filter((d) => d.state === 'VERIFIED').length, games: games.length, detail_games: detail.length, play_by_play: nPbp, player_game_rows: pbox.length, checks: checks.length, checks_passed: passed },
    datasets, checks, findings,
    not_executed: ['scripts/collect.py', 'scripts/core_supplement.py', 'scripts/player_features.py', 'scripts/package.py'] };
}

async function main() {
  const v = await verify();
  if (process.argv.includes('--check')) {
    const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;
    const strip = (o) => JSON.stringify(Object.assign({}, o, { verified_at: null }));
    const same = prev && strip(prev) === strip(v);
    if (v.status !== 'PASSED' || !same) { console.error('[verify nba pack --check] FAILED: ' + (v.status !== 'PASSED' ? v.checks.filter((c) => !c.pass).map((c) => c.id).join(', ') : 'differs from the committed EDGEDESK_VERIFICATION.json')); process.exit(1); }
    console.log('[verify nba pack --check] ok: ' + v.summary.checks_passed + '/' + v.summary.checks + ' checks'); return;
  }
  fs.writeFileSync(OUT, JSON.stringify(v, null, 1) + '\n');
  for (const c of v.checks) console.log((c.pass ? 'ok   ' : 'FAIL ') + c.id + (c.pass ? '' : '  ' + JSON.stringify(c.detail).slice(0, 400)));
  console.log('[verify nba pack] ' + v.status + ': ' + v.summary.checks_passed + '/' + v.summary.checks + ' checks, ' + v.summary.verified + '/' + v.summary.datasets + ' tables');
  if (v.status !== 'PASSED') process.exit(1);
}

module.exports = { verify };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
