#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NFL Data Pack (datapack/nfl_v1) — independent verification in Node.

   The pack's own scripts (verify_and_package.py, build_features.py) are never
   run: the pack is data, not code I execute. Parquet is read through my own
   helpers (tools/datapack/parquet_meta.py for metadata,
   hockey/tools/parquet_select.py for columns), run with `python3 -I`.

   Checks, as the pack's CLAUDE_NFL_START_HERE.md asks:
     1. inventory: every file's SHA-256 against sources/DATA_INVENTORY.json and
        (Parquet) the delivered digest in sources/LOSSLESS_REENCODING.json; rows
        and columns; no data file the inventory does not list;
     2. known_at blank in every derived table (first publication was never
        recorded: a filled known_at would be a backdated claim);
     3. the 2022-24 seed tables are byte-identical to datapack/quant_v1's NFL
        tables (the pack says it re-ships them, not new data);
     4. the new play-by-play: unique (game, play) keys, 372 native columns, game
        counts by type, the 2026 archive's last date (a PARTIAL season);
     5. from that play-by-play, recomputed: every 2025/2026 team-game measure,
        every player opportunity cell and every game label;
     6. every prior-5/10/20 lagged feature recomputed over all five seasons,
        target game excluded; the window crossing a season boundary is measured
        (how many rows lean on last season), not hidden;
     7. grains: NGS week 0 rows are season aggregates (checked against the sum
        of the weeks), never to be pooled with weekly rows; weekly keys unique;
     8. identities: the roster crosswalk GSIS ↔ PFR ↔ ESPN (conflicts counted),
        and how much of each table's ids it covers (snap counts, PFR advanced,
        depth charts, injuries, NGS, play-by-play players);
     9. time: injuries carry no publication time; depth snapshots carry `dt`
        (provider snapshot time, not an announcement); the 2024 and 2025+
        depth schemas differ;
    10. NGS percentage scales (0-1 or 0-100) per column, as delivered;
    11. the contracts byte-identical to datapack/quant_v1's; each JSON Schema
        matches its EMPTY_TEMPLATE; the manifests name only github.com.

   Writes datapack/nfl_v1/EDGEDESK_VERIFICATION.json. --check recomputes and
   fails when the result differs from the committed file (the time stamp
   aside) or when any check fails.

   Run: node tools/datapack/verify_nfl.js [--check]
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readCsv } = require('../../engine/csv');

const ROOT = path.join(__dirname, '..', '..');
/* EDGEDESK_NFL_PACK points the verifier at a copy (the tamper tests in datapack.test.js) */
const PACK = process.env.EDGEDESK_NFL_PACK ? path.resolve(process.env.EDGEDESK_NFL_PACK) : path.join(ROOT, 'datapack', 'nfl_v1');
const QUANT = path.join(ROOT, 'datapack', 'quant_v1');
const OUT = path.join(PACK, 'EDGEDESK_VERIFICATION.json');
const D = (f) => path.join(PACK, 'data', f);

const r6 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 1e6) / 1e6);
const inc = (o, k, n) => { o[k] = (o[k] || 0) + (n == null ? 1 : n); return o; };
const sorted = (m) => Object.fromEntries(Object.keys(m).sort().map((k) => [k, m[k]]));
const num = (v) => (v === '' || v == null ? null : Number(v));
const same = (a, b) => (a == null || a === '' || (typeof a === 'number' && !isFinite(a)) ? b == null || b === '' : b != null && b !== '' && Math.abs(Number(a) - Number(b)) <= 1e-9 * Math.max(1, Math.abs(Number(b))));

const { meta, rows: pq } = require('./parquet');
const pushAll = (a, b) => { for (const x of b) a.push(x); return a; };
const truthy = (v) => v === '1' || v === '1.0' || v === 'true' || v === 'True';

function verify() {
  const checks = []; const findings = {};
  const check = (id, pass, detail) => { checks.push({ id, pass: !!pass, detail: detail == null ? null : detail }); return !!pass; };
  const inventory = JSON.parse(fs.readFileSync(path.join(PACK, 'sources', 'DATA_INVENTORY.json'), 'utf8'));
  const lossless = new Map(JSON.parse(fs.readFileSync(path.join(PACK, 'sources', 'LOSSLESS_REENCODING.json'), 'utf8')).map((x) => [x.file, x]));

  /* 1. inventory */
  const parquetFiles = inventory.filter((i) => /\.parquet$/.test(i.file)).map((i) => path.join(PACK, i.file)).filter((f) => fs.existsSync(f));
  const M = meta(parquetFiles);
  const datasets = []; const csvCache = {};
  for (const i of inventory) {
    const abs = path.join(PACK, i.file); const d = { file: i.file, expected_rows: i.rows, expected_sha256: i.sha256 };
    if (!fs.existsSync(abs)) { d.state = 'MISSING'; datasets.push(d); continue; }
    const buf = fs.readFileSync(abs); const sha = crypto.createHash('sha256').update(buf).digest('hex');
    d.sha_ok = sha === i.sha256 && buf.length === i.bytes;
    if (/\.parquet$/.test(i.file)) {
      const m = M[abs]; d.rows = m.rows; d.columns = m.columns;
      const l = lossless.get(i.file); d.lossless_digest_ok = l ? l.delivered_sha256 === sha && l.status === 'lossless_value_equality_verified' : null;
      d.known_at = m.fields.some((f) => f[0] === 'known_at') ? 'COLUMN_PRESENT' : 'NO_COLUMN';
    } else {
      const t = readCsv(abs); csvCache[i.file] = t.rows; d.rows = t.rows.length; d.columns = t.header.length;
      d.known_at = t.header.indexOf('known_at') < 0 ? 'NO_COLUMN' : t.rows.every((r) => r.known_at === '') ? 'BLANK' : 'FILLED';
    }
    d.counts_ok = d.rows === i.rows && d.columns === i.columns;
    d.state = d.sha_ok && d.counts_ok && d.lossless_digest_ok !== false ? 'VERIFIED' : 'FAILED';
    datasets.push(d);
  }
  const failed = datasets.filter((d) => d.state !== 'VERIFIED');
  check('inventory_sha256_rows_columns', failed.length === 0, failed.map((d) => d.file));
  check('parquet_lossless_digests', datasets.filter((d) => /\.parquet$/.test(d.file)).every((d) => d.lossless_digest_ok === true), datasets.filter((d) => d.lossless_digest_ok === false).map((d) => d.file));
  const listed = new Set(inventory.map((i) => i.file));
  const unlisted = fs.readdirSync(path.join(PACK, 'data')).map((f) => 'data/' + f).filter((f) => !listed.has(f));
  check('no_unlisted_data_files', unlisted.length === 0, unlisted);
  check('known_at_blank_everywhere', datasets.every((d) => d.known_at !== 'FILLED' && d.known_at !== 'COLUMN_PRESENT'), datasets.filter((d) => d.known_at === 'FILLED').map((d) => d.file));

  /* 3. the 2022-24 seeds are the earlier pack's tables */
  const SEEDS = [['game_labels_historical_seed_2022_2024.csv', 'game_labels_2022_2024.csv'], ['player_game_opportunities_historical_seed_2022_2024.csv', 'player_game_opportunities_2022_2024.csv'], ['team_game_advanced_historical_seed_2022_2024.csv', 'team_game_advanced_2022_2024.csv']];
  const seedDiff = SEEDS.filter(([a, b]) => !fs.existsSync(path.join(QUANT, 'data', 'nfl', b)) || !fs.readFileSync(D(a)).equals(fs.readFileSync(path.join(QUANT, 'data', 'nfl', b)))).map((x) => x[0]);
  check('seeds_identical_to_quant_v1', seedDiff.length === 0, seedDiff);

  /* 4-5. play-by-play: keys, counts, and every derived 2025/2026 row recomputed */
  const PBP_COLS = ['game_id', 'play_id', 'game_date', 'season', 'season_type', 'week', 'home_team', 'away_team', 'home_score', 'away_score', 'spread_line', 'total_line', 'posteam', 'defteam', 'epa', 'play_type', 'qb_kneel', 'qb_spike', 'pass_attempt', 'sack', 'rush_attempt', 'qb_scramble', 'complete_pass', 'cpoe', 'receiver_player_id', 'rusher_player_id', 'passer_player_id', 'receiving_yards', 'rushing_yards', 'passing_yards'];
  const mineTG = new Map(); const mineOpp = new Map(); const mineLabels = new Map(); const pbpFacts = {};
  for (const f of ['play_by_play_2025.parquet', 'play_by_play_2026.parquet']) {
    const rows = pq(D(f), PBP_COLS);
    const keys = new Set(rows.map((r) => r.game_id + '|' + r.play_id));
    const games = new Map(); for (const r of rows) if (!games.has(r.game_id)) games.set(r.game_id, r);
    pbpFacts[f] = { plays: rows.length, unique_keys: keys.size === rows.length, columns: (M[D(f)] || {}).columns, games: games.size, by_type: sorted([...games.values()].reduce((o, g) => inc(o, g.season_type), {})), first_date: [...games.values()].map((g) => g.game_date).sort()[0], last_date: [...games.values()].map((g) => g.game_date).sort().slice(-1)[0], weeks: [...new Set([...games.values()].map((g) => +g.week))].sort((a, b) => a - b) };
    for (const g of games.values()) mineLabels.set(g.game_id, g);
    for (const r of rows) {
      if (!r.posteam || r.epa === '' || (r.play_type !== 'pass' && r.play_type !== 'run')) continue;
      if (truthy(r.qb_kneel) || truthy(r.qb_spike)) continue;
      const k = r.game_id + '|' + r.posteam;
      const t = mineTG.get(k) || { game_id: r.game_id, team_id: r.posteam, opponent_id: r.defteam, plays: 0, epa_sum: 0, successful_plays: 0, dropbacks: 0, pass_epa_sum: 0, designed_rushes: 0, rush_epa_sum: 0, sacks: 0, completions: 0, pass_attempts: 0, cpoe_sum: 0, cpoe_passes: 0 };
      const epa = +r.epa, drop = truthy(r.pass_attempt) || truthy(r.sack), dr = truthy(r.rush_attempt) && !truthy(r.qb_scramble);
      t.plays++; t.epa_sum += epa; if (epa > 0) t.successful_plays++;
      if (drop) { t.dropbacks++; t.pass_epa_sum += epa; } if (dr) { t.designed_rushes++; t.rush_epa_sum += epa; }
      t.sacks += num(r.sack) || 0; t.completions += num(r.complete_pass) || 0; t.pass_attempts += num(r.pass_attempt) || 0;
      if (r.cpoe !== '') { t.cpoe_sum += +r.cpoe; t.cpoe_passes++; }
      mineTG.set(k, t);
      const add = (id, stat, v) => { if (!id) return; const kk = r.game_id + '|' + id + '|' + stat; mineOpp.set(kk, (mineOpp.get(kk) || 0) + v); };
      if (truthy(r.pass_attempt)) { add(r.receiver_player_id, 'targets', 1); add(r.passer_player_id, 'pass_attempts', 1); if (r.passing_yards !== '') add(r.passer_player_id, 'passing_yards', +r.passing_yards); }
      if (truthy(r.complete_pass)) { add(r.receiver_player_id, 'receptions', 1); if (r.receiving_yards !== '') add(r.receiver_player_id, 'receiving_yards', +r.receiving_yards); }
      if (truthy(r.rush_attempt)) { add(r.rusher_player_id, 'carries', 1); if (r.rushing_yards !== '') add(r.rusher_player_id, 'rushing_yards', +r.rushing_yards); }
    }
  }
  /* yards cells exist only where the play type had the player; a group of all-null yards sums to 0 in the pack */
  findings.play_by_play = pbpFacts;
  check('pbp_unique_keys_and_372_columns', Object.values(pbpFacts).every((p) => p.unique_keys && p.columns === 372), pbpFacts);
  const p25 = pbpFacts['play_by_play_2025.parquet'], p26 = pbpFacts['play_by_play_2026.parquet'];
  check('pbp_game_counts', p25.by_type.REG === 272 && p25.by_type.POST === 13 && p26.by_type.REG === 79 && !p26.by_type.POST, { 2025: p25.by_type, 2026: p26.by_type });
  findings.current_season = { season: 2026, games_in_archive: p26.games, weeks: p26.weeks, last_game_date: p26.last_date, state: 'PARTIAL', note: 'the 2026 archive ends at week ' + p26.weeks[p26.weeks.length - 1] + ' (' + p26.last_date + '): a partial current season, never called complete' };

  const tga = csvCache['data/team_game_advanced_2022_2026.csv'];
  for (const t of mineTG.values()) { const o = mineTG.get(t.game_id + '|' + t.opponent_id); t.def_plays = o ? o.plays : null; t.def_epa_allowed_sum = o ? o.epa_sum : null; t.def_successes_allowed = o ? o.successful_plays : null; }
  const tgaIdx = new Map(tga.map((r) => [r.game_id + '|' + r.team_id, r]));
  const tgBad = {}; let tgMissing = 0;
  for (const [k, t] of mineTG) {
    const r = tgaIdx.get(k); if (!r) { tgMissing++; continue; }
    const derived = { off_epa_per_play: t.epa_sum / t.plays, off_success_rate: t.successful_plays / t.plays, pass_epa_per_dropback: t.dropbacks ? t.pass_epa_sum / t.dropbacks : null, rush_epa_per_designed_rush: t.designed_rushes ? t.rush_epa_sum / t.designed_rushes : null, def_epa_allowed_per_play: t.def_plays ? t.def_epa_allowed_sum / t.def_plays : null };
    for (const [c, v] of Object.entries(Object.assign({}, t, derived))) if (!['game_id', 'team_id', 'opponent_id'].includes(c) && !same(v, r[c])) inc(tgBad, c);
  }
  const newTG = tga.filter((r) => +r.season >= 2025);
  check('team_game_measures_recomputed_2025_2026', Object.keys(tgBad).length === 0 && tgMissing === 0 && newTG.length === mineTG.size, Object.assign({ recomputed: mineTG.size, rows_2025_2026: newTG.length, missing: tgMissing }, tgBad));

  const opp = csvCache['data/player_game_opportunities_2022_2026.csv'].filter((r) => +r.season >= 2025);
  let oppBad = 0; const oppSeen = new Set();
  for (const r of opp) { const k = r.game_id + '|' + r.player_id + '|' + r.stat; oppSeen.add(k); const v = mineOpp.get(k); if (!same(v == null ? 0 : v, r.value)) oppBad++; }
  const oppExtra = [...mineOpp.keys()].filter((k) => !oppSeen.has(k)).length;
  check('player_opportunities_recomputed_2025_2026', oppBad === 0 && oppExtra === 0, { cells: opp.length, mismatched: oppBad, missing_in_pack: oppExtra });
  const labels = csvCache['data/game_labels_2022_2026.csv'];
  const labBad = labels.filter((l) => +l.season >= 2025).filter((l) => { const g = mineLabels.get(l.game_id); return !g || ['home_team', 'away_team', 'season_type', 'game_date'].some((c) => g[c] !== l[c]) || ['home_score', 'away_score', 'spread_line', 'total_line', 'week'].some((c) => !same(num(g[c]), l[c])); }).length;
  check('game_labels_recomputed_2025_2026', labBad === 0 && labels.filter((l) => +l.season >= 2025).length === mineLabels.size && new Set(labels.map((l) => l.game_id)).size === labels.length, { mismatched: labBad });

  /* 6. lagged features, all five seasons */
  const lag = csvCache['data/pregame_rolling_features_2022_2026.csv'];
  const lagIdx = new Map(lag.map((l) => [l.game_id + '|' + l.team_id, l]));
  const byTeam = {}; for (const r of tga) (byTeam[r.team_id] = byTeam[r.team_id] || []).push(r);
  const PAIRS = [['epa_sum', 'plays', 'off_epa_per_play'], ['successful_plays', 'plays', 'success_rate'], ['pass_epa_sum', 'dropbacks', 'pass_epa_per_dropback'], ['rush_epa_sum', 'designed_rushes', 'rush_epa_per_designed_rush'], ['def_epa_allowed_sum', 'def_plays', 'def_epa_allowed_per_play'], ['def_successes_allowed', 'def_plays', 'def_success_allowed_rate'], ['sacks', 'dropbacks', 'sack_rate'], ['cpoe_sum', 'cpoe_passes', 'cpoe']];
  const lagBad = {}; let leak = 0; const crossing = { 5: 0, 10: 0, 20: 0 }; let firstWeeks = 0;
  for (const rows of Object.values(byTeam)) {
    rows.sort((a, b) => (a.game_date < b.game_date ? -1 : a.game_date > b.game_date ? 1 : a.game_id < b.game_id ? -1 : 1));
    rows.forEach((r, k) => {
      const l = lagIdx.get(r.game_id + '|' + r.team_id); if (!l) { inc(lagBad, '__missing'); return; }
      for (const w of [5, 10, 20]) {
        const sub = rows.slice(Math.max(0, k - w), k);
        if (sub.some((p) => !(p.game_date < r.game_date))) leak++;
        if (sub.some((p) => p.season !== r.season)) crossing[w]++;
        if (!same(sub.length, l['games_observed_prior_' + w])) inc(lagBad, 'games_observed_prior_' + w);
        for (const [n, d, name] of PAIRS) {
          const nv = sub.filter((p) => p[n] !== ''); const dv = sub.filter((p) => p[d] !== '');
          const N = nv.length ? nv.reduce((s, p) => s + +p[n], 0) : null, Dn = dv.length ? dv.reduce((s, p) => s + +p[d], 0) : null;
          if (!same(Dn, l[name + '_exposure_prior_' + w])) inc(lagBad, name + '_exposure_prior_' + w);
          if (!same(N != null && Dn ? N / Dn : null, l[name + '_prior_' + w])) inc(lagBad, name + '_prior_' + w);
        }
      }
      if (rows[k - 1] && rows[k - 1].season !== r.season) firstWeeks++;
    });
  }
  check('lagged_features_recomputed_target_excluded', Object.keys(lagBad).length === 0 && leak === 0 && lag.length === tga.length, Object.assign({ prior_not_strictly_earlier: leak }, lagBad));
  findings.lag_window_crosses_seasons = { rows: lag.length, rows_whose_prior_5_reaches_last_season: crossing[5], prior_10: crossing[10], prior_20: crossing[20], team_season_openers: firstWeeks, rule: 'the pack\'s windows run straight across the offseason; football/nfl/research/pack_research.js measures whether that helps or hurts' };

  /* 7. grains: NGS week 0 is a season aggregate */
  const ngs = {};
  for (const [f, stat] of [['ngs_passing.parquet', 'attempts'], ['ngs_receiving.parquet', 'targets'], ['ngs_rushing.parquet', 'rush_attempts']]) {
    const rows = pq(D(f), ['season', 'season_type', 'week', 'player_gsis_id', stat]);
    const weekly = rows.filter((r) => r.week !== '0'), season = rows.filter((r) => r.week === '0');
    const wkKeys = new Set(weekly.map((r) => r.season + '|' + r.season_type + '|' + r.week + '|' + r.player_gsis_id));
    const sums = {}; for (const r of weekly) if (r.season_type === 'REG') inc(sums, r.season + '|' + r.player_gsis_id, +r[stat] || 0);
    const s0 = season.filter((r) => r.season_type === 'REG');
    const eq = s0.filter((r) => sums[r.season + '|' + r.player_gsis_id] === +r[stat]).length;
    ngs[f] = { rows: rows.length, week_0_rows: season.length, weekly_rows: weekly.length, weekly_keys_unique: wkKeys.size === weekly.length, week_0_equals_sum_of_weeks: eq, week_0_reg_rows_compared: s0.length, stat };
  }
  findings.ngs_grain = ngs;
  check('ngs_weekly_keys_unique_and_week0_separate', Object.values(ngs).every((x) => x.weekly_keys_unique && x.week_0_rows > 0), ngs);

  /* 8. identities: the roster crosswalk and its coverage */
  const ROSTER_IDS = ['season', 'week', 'team', 'gsis_id', 'pfr_id', 'espn_id', 'full_name', 'position'];
  const roster = [];
  for (const y of [2024, 2025, 2026]) for (const k of ['roster_', 'roster_weekly_']) pushAll(roster, pq(D(k + y + '.parquet'), ROSTER_IDS));
  const g2p = new Map(), p2g = new Map(), g2e = new Map(), e2g = new Map(); const gsisAll = new Set();
  const add = (m, a, b) => { if (!a || !b) return; if (!m.has(a)) m.set(a, new Set()); m.get(a).add(b); };
  for (const r of roster) { if (r.gsis_id) gsisAll.add(r.gsis_id); add(g2p, r.gsis_id, r.pfr_id); add(p2g, r.pfr_id, r.gsis_id); add(g2e, r.gsis_id, r.espn_id); add(e2g, r.espn_id, r.gsis_id); }
  const conflicts = (m) => [...m.values()].filter((s) => s.size > 1).length;
  const nameOf = new Map(); for (const r of roster) if (r.gsis_id && !nameOf.has(r.gsis_id)) nameOf.set(r.gsis_id, r.full_name + ' (' + r.position + ')');
  const examples = (m, label) => [...m.entries()].filter(([, s]) => s.size > 1).map(([k, s]) => ({ kind: label, id: k, partners: [...s].sort(), names: label.indexOf('gsis_to') === 0 ? [nameOf.get(k)] : [...s].sort().map((g) => nameOf.get(g)) }));
  const cover = (ids, m) => { const u = [...new Set(ids.filter(Boolean))]; return { distinct_ids: u.length, mapped: u.filter((x) => m(x)).length, share: u.length ? r6(u.filter((x) => m(x)).length / u.length) : null }; };
  const snapIds = []; const advIds = []; const injIds = []; const depthG = []; const depthE = [];
  for (const y of [2024, 2025, 2026]) {
    pushAll(snapIds, pq(D('snap_counts_' + y + '.parquet'), ['pfr_player_id']).map((r) => r.pfr_player_id));
    for (const k of ['def', 'pass', 'rec', 'rush']) pushAll(advIds, pq(D('advstats_week_' + k + '_' + y + '.parquet'), ['pfr_player_id']).map((r) => r.pfr_player_id));
    pushAll(injIds, pq(D('injuries_' + y + '.parquet'), ['gsis_id']).map((r) => r.gsis_id));
    const dc = pq(D('depth_charts_' + y + '.parquet'), y === 2024 ? ['gsis_id'] : ['gsis_id', 'espn_id']);
    pushAll(depthG, dc.map((r) => r.gsis_id)); if (y > 2024) pushAll(depthE, dc.map((r) => r.espn_id));
  }
  const pbpPlayers = []; for (const f of ['play_by_play_2025.parquet', 'play_by_play_2026.parquet']) for (const r of pq(D(f), ['passer_player_id', 'rusher_player_id', 'receiver_player_id'])) pbpPlayers.push(r.passer_player_id, r.rusher_player_id, r.receiver_player_id);
  const ngsIds = []; for (const f of ['ngs_passing.parquet', 'ngs_receiving.parquet', 'ngs_rushing.parquet']) pushAll(ngsIds, pq(D(f), ['season', 'player_gsis_id']).filter((r) => +r.season >= 2024).map((r) => r.player_gsis_id));
  findings.identity = {
    roster_rows: roster.length, gsis_ids: gsisAll.size, gsis_with_pfr: [...g2p.keys()].length, gsis_with_espn: [...g2e.keys()].length,
    conflicts: { gsis_to_several_pfr: conflicts(g2p), pfr_to_several_gsis: conflicts(p2g), gsis_to_several_espn: conflicts(g2e), espn_to_several_gsis: conflicts(e2g) },
    coverage: {
      snap_counts_pfr: cover(snapIds, (x) => p2g.has(x)), pfr_advanced_pfr: cover(advIds, (x) => p2g.has(x)), injuries_gsis: cover(injIds, (x) => gsisAll.has(x)),
      depth_charts_gsis: cover(depthG, (x) => gsisAll.has(x)), depth_charts_espn: cover(depthE, (x) => e2g.has(x)), pbp_players_gsis: cover(pbpPlayers, (x) => gsisAll.has(x)), ngs_2024_on_gsis: cover(ngsIds, (x) => gsisAll.has(x)),
    },
    conflict_examples: examples(g2p, 'gsis_to_several_pfr').concat(examples(g2e, 'gsis_to_several_espn'), examples(e2g, 'espn_to_several_gsis'), examples(p2g, 'pfr_to_several_gsis')),
    rule: 'join through these id pairs, never names; an id with several partners is a source conflict (two players sharing an ESPN id, one player with two PFR ids): it is left out of the crosswalk, never guessed',
  };
  const nConf = Object.values(findings.identity.conflicts).reduce((a, b) => a + b, 0);
  check('identity_conflicts_few_and_enumerated', nConf === findings.identity.conflict_examples.length && nConf <= 0.005 * gsisAll.size, findings.identity.conflicts);

  /* 9. time */
  const injFields = (M[D('injuries_2025.parquet')] || {}).fields || [];
  const d24 = ((M[D('depth_charts_2024.parquet')] || {}).fields || []).map((f) => f[0]), d25 = ((M[D('depth_charts_2025.parquet')] || {}).fields || []).map((f) => f[0]);
  findings.time = {
    injuries_timestamp_columns: injFields.map((f) => f[0]).filter((c) => /date|time|_at$|dt/.test(c)),
    injuries_note: 'season, week and status only: no publication time, so a report cannot be placed before a kickoff',
    depth_2024_columns: d24, depth_2025_columns: d25,
    depth_dt_span: { 2025: ((M[D('depth_charts_2025.parquet')] || {}).spans || {}).dt, 2026: ((M[D('depth_charts_2026.parquet')] || {}).spans || {}).dt },
    depth_note: 'the 2024 depth chart is weekly (week, game_type); 2025+ are timestamped provider snapshots (dt) — context, not a proven pregame announcement',
  };
  check('injuries_have_no_publication_time', findings.time.injuries_timestamp_columns.length === 0, findings.time.injuries_timestamp_columns);
  check('depth_schemas_differ_and_are_recorded', JSON.stringify(d24) !== JSON.stringify(d25) && d25.indexOf('dt') >= 0 && d24.indexOf('week') >= 0, null);

  /* 10. NGS percentage scales */
  const pctScale = {};
  for (const f of ['ngs_passing.parquet', 'ngs_receiving.parquet', 'ngs_rushing.parquet']) {
    const cols = ((M[D(f)] || {}).fields || []).map((x) => x[0]).filter((c) => /percent|pct|share/.test(c));
    if (!cols.length) continue;
    const rows = pq(D(f), cols);
    for (const c of cols) { const v = rows.map((r) => num(r[c])).filter((x) => x != null); if (!v.length) continue; const mx = Math.max(...v), mn = Math.min(...v); pctScale[f.replace('.parquet', '') + '.' + c] = { min: r6(mn), max: r6(mx), scale: mx > 1.5 ? '0-100' : '0-1' }; }
  }
  findings.ngs_percent_scales = pctScale;

  /* 11. contracts and manifests */
  const schemaFiles = []; (function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else schemaFiles.push(path.relative(path.join(PACK, 'schemas'), p)); } })(path.join(PACK, 'schemas'));
  const differ = schemaFiles.filter((f) => f !== 'feature_catalog.json' && !(fs.existsSync(path.join(QUANT, 'schemas', f)) && fs.readFileSync(path.join(QUANT, 'schemas', f)).equals(fs.readFileSync(path.join(PACK, 'schemas', f)))));
  check('contracts_identical_to_quant_v1', differ.length === 0, differ);
  const tmplBad = [];
  for (const f of schemaFiles.filter((x) => /\.schema\.json$/.test(x))) {
    const s = JSON.parse(fs.readFileSync(path.join(PACK, 'schemas', f), 'utf8'));
    const tf = path.join(PACK, 'schemas', path.dirname(f), 'templates', path.basename(f).replace('.schema.json', '_EMPTY_TEMPLATE.csv'));
    if (!fs.existsSync(tf)) { tmplBad.push(f + ': no template'); continue; }
    const t = readCsv(tf); if (t.rows.length) tmplBad.push(f + ': template has rows');
    if (JSON.stringify(Object.keys(s.properties || {}).sort()) !== JSON.stringify(t.header.slice().sort())) tmplBad.push(f + ': columns differ');
  }
  check('json_schema_matches_empty_template', tmplBad.length === 0, tmplBad);
  const hosts = {};
  for (const f of ['DOWNLOAD_MANIFEST.json', 'RELEASE_ASSET_DISCOVERY.json']) { const text = fs.readFileSync(path.join(PACK, 'sources', f), 'utf8'); for (const m of text.match(/https?:\/\/[^"\s]+/g) || []) inc(hosts, new URL(m).host); }
  findings.manifest_hosts = sorted(hosts);
  check('manifests_name_only_github', Object.keys(hosts).every((h) => h === 'github.com' || /\.github\.com$|githubusercontent\.com$/.test(h)), hosts);

  const pass = checks.every((c) => c.pass);
  return {
    schema: 'edgedesk_datapack_verification_v1', pack: 'datapack/nfl_v1', verified_at: new Date().toISOString(), status: pass ? 'PASSED' : 'FAILED',
    summary: { datasets: datasets.length, verified: datasets.filter((d) => d.state === 'VERIFIED').length, failed: failed.length, new_plays: p25.plays + p26.plays, new_games: p25.games + p26.games, team_game_rows: tga.length, checks: checks.length, checks_passed: checks.filter((c) => c.pass).length },
    checks, findings, datasets,
    limitations: [
      'Not a point-in-time certification: known_at is blank; EPA and CPOE are nflfastR model outputs that can be refit after the fact.',
      'Not a licensing certification: nflverse is CC-BY-4.0; upstream sources (NGS, PFR, ESPN) keep their own terms.',
      'Not model validation and not prices: spread_line / total_line are historical labels, not executable quotes.',
      'The 2026 season is partial (the archive ends ' + p26.last_date + ').',
    ],
  };
}

function stable(r) { const c = JSON.parse(JSON.stringify(r)); delete c.verified_at; return JSON.stringify(c); }

if (require.main === module) {
  const r = verify();
  const checkMode = process.argv.indexOf('--check') >= 0;
  for (const c of r.checks) console.log((c.pass ? 'ok   ' : 'FAIL ') + c.id + (c.pass ? '' : '  ' + JSON.stringify(c.detail).slice(0, 400)));
  console.log(r.status + ' — ' + JSON.stringify(r.summary));
  if (checkMode) {
    let committed = null; try { committed = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (_) {}
    if (!committed || stable(committed) !== stable(r)) { console.log('FAIL the committed EDGEDESK_VERIFICATION.json differs from a fresh run'); process.exit(1); }
    process.exit(r.status === 'PASSED' ? 0 : 1);
  }
  fs.writeFileSync(OUT, JSON.stringify(r, null, 2) + '\n');
  console.log('wrote ' + path.relative(ROOT, OUT));
  process.exit(r.status === 'PASSED' ? 0 : 1);
}
module.exports = { verify };
