#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NHL Data Pack (datapack/nhl_v1) — independent verification in Node.

   The pack's own scripts/verify_and_package.py is never run: the pack is data,
   not code I execute. This re-implements its checks and adds the ones its
   CLAUDE_NHL_START_HERE.md asks for:

     1. inventory: every table's SHA-256 (of the uncompressed bytes: the two
        largest are stored gzipped), rows, columns and bytes as COVERAGE.json
        lists them; no CSV the inventory does not list;
     2. known_at is blank in every table (first publication was not recorded,
        so a filled known_at would be a backdated claim);
     3. scope: 32 clubs, national-team events (Four Nations) excluded, game
        type counts, every game final; the broader schedule audited;
     4. keys: games, events, shots and player-games unique; every shot is an
        event of a delivered game with the same native fields;
     5. shots: shooting_team_id is one of the two clubs or blank with method
        "unmapped"; how often the NATIVE team differs from the shooting team
        (blocked attempts); xG never filled; shootout candidates only in
        regular-season period 5+; coordinates flagged unverified;
     6. goals: native final − non-shootout goals is 0, or 1 in a shootout;
        recomputed from the shots;
     7. assists: goals whose role rows carry two assisters while the legacy
        by-role object keeps one;
     8. units: every TOI / PPTOI / SHTOI / ESTOI parsed from mm:ss to the
        seconds shipped; ES + PP + SH = TOI;
     9. native definitions: SOG is shootout goals in these boxes (never shots
        on goal) — checked against the shootout games;
    10. goalies: SA − SV − GA, xG / GSAx / pregame confirmation blank;
    11. every measured team-game feature recomputed from the shots and boxes;
    12. every prior-5/10/20 lagged feature and the schedule features
        recomputed, with the target game excluded;
    13. the schemas are byte-identical to datapack/quant_v1's contracts (or
        listed); JSON Schema properties match each EMPTY_TEMPLATE;
    14. the source manifest: response digests are listed but the raw
        responses were not shipped, so they cannot be re-hashed here.

   Findings that are facts about the data, not pass/fail (blank fields, the
   one team-game with no goalie row, playoff games listing three referees),
   are reported under `findings`.

   Writes datapack/nhl_v1/EDGEDESK_VERIFICATION.json. --check recomputes and
   fails when the result differs from the committed file (the time stamp
   aside) or when any check fails.

   Run: node tools/datapack/verify_nhl.js [--check]
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { eachRow, readCsv } = require('../../engine/csv');

const ROOT = path.join(__dirname, '..', '..');
/* EDGEDESK_NHL_PACK points the verifier at a copy (the tamper tests in datapack.test.js) */
const PACK = process.env.EDGEDESK_NHL_PACK ? path.resolve(process.env.EDGEDESK_NHL_PACK) : path.join(ROOT, 'datapack', 'nhl_v1');
const QUANT = path.join(ROOT, 'datapack', 'quant_v1');
const OUT = path.join(PACK, 'EDGEDESK_VERIFICATION.json');
const NATIONAL = new Set(['47842', '47836', '47838', '47844']); /* Four Nations: Canada, USA, Sweden, Finland */

const r6 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 1e6) / 1e6);
const count = (a, f) => { const m = {}; for (const x of a) { const k = f(x); m[k] = (m[k] || 0) + 1; } return m; };
const sorted = (m) => Object.fromEntries(Object.keys(m).sort().map((k) => [k, m[k]]));

function bytesOf(file) {
  const gz = path.join(PACK, file + '.gz');
  if (fs.existsSync(path.join(PACK, file))) return { buf: fs.readFileSync(path.join(PACK, file)), stored: file };
  if (fs.existsSync(gz)) return { buf: zlib.gunzipSync(fs.readFileSync(gz)), stored: file + '.gz' };
  return null;
}
/** rows as objects (only the columns asked, when given) */
function table(buf, cols) {
  let header = []; let idx = null; const rows = [];
  eachRow(buf.toString('utf8'), (f, r) => {
    if (r === 0) { header = f; idx = (cols || header).map((c) => [c, header.indexOf(c)]); return; }
    if (f.length === 1 && f[0] === '') return;
    const o = {}; for (const [c, i] of idx) o[c] = i >= 0 ? f[i] : undefined; o.__n = f.length; rows.push(o);
  });
  return { header, rows };
}
const toi = (s) => { const m = /^(\d+):(\d\d)$/.exec(s || ''); return m ? +m[1] * 60 + +m[2] : null; };
const num = (v) => (v === '' || v == null ? null : Number(v));
const pyVal = (v) => { const n = Number(v); return v === '' || v == null || !isFinite(n) ? null : n; };

function verify() {
  const checks = [];
  const check = (id, pass, detail) => { checks.push({ id, pass: !!pass, detail: detail == null ? null : detail }); return !!pass; };
  const findings = {};
  const coverage = JSON.parse(fs.readFileSync(path.join(PACK, 'COVERAGE.json'), 'utf8'));
  const IMPORT = JSON.parse(fs.readFileSync(path.join(PACK, 'IMPORT.json'), 'utf8'));

  /* 1. inventory */
  const T = {}; const datasets = [];
  const KEEP = {
    'data/events.csv': ['game_id', 'event_id', 'period', 'clock_native', 'event_type', 'team_id', 'strength_label_native', 'x_native', 'y_native', 'known_at'],
  };
  for (const i of coverage.inventory) {
    const b = bytesOf(i.file);
    const d = { file: i.file, expected_rows: i.rows, expected_sha256: i.sha256 };
    if (!b) { d.state = 'MISSING'; datasets.push(d); continue; }
    d.stored_as = b.stored;
    d.sha_ok = crypto.createHash('sha256').update(b.buf).digest('hex') === i.sha256;
    d.bytes_ok = b.buf.length === i.bytes;
    const t = table(b.buf, KEEP[i.file]);
    T[i.file] = t.rows;
    d.rows = t.rows.length; d.columns = t.header.length;
    d.ragged = t.rows.filter((r) => r.__n !== t.header.length).length;
    d.counts_ok = d.rows === i.rows && d.columns === i.columns && d.ragged === 0;
    const kIdx = t.header.indexOf('known_at');
    d.known_at = kIdx < 0 ? 'NO_COLUMN' : (KEEP[i.file] || t.header).includes('known_at') && t.rows.every((r) => r.known_at === '') ? 'BLANK' : 'FILLED';
    d.state = d.sha_ok && d.bytes_ok && d.counts_ok ? 'VERIFIED' : 'FAILED';
    datasets.push(d);
  }
  const failed = datasets.filter((d) => d.state !== 'VERIFIED');
  check('inventory_sha256_rows_columns', failed.length === 0, failed.map((d) => d.file));
  check('known_at_blank_everywhere', datasets.every((d) => d.known_at !== 'FILLED'), datasets.filter((d) => d.known_at === 'FILLED').map((d) => d.file));
  const listed = new Set(coverage.inventory.map((i) => i.file));
  const unlisted = fs.readdirSync(path.join(PACK, 'data')).map((f) => 'data/' + f.replace(/\.gz$/, '')).filter((f) => /\.csv$/.test(f) && !listed.has(f));
  check('no_unlisted_tables', unlisted.length === 0, unlisted);
  const stored = IMPORT.stored_gzipped.map((s) => s.file).sort();
  check('gzip_storage_declared', JSON.stringify(stored) === JSON.stringify(datasets.filter((d) => /\.gz$/.test(d.stored_as || '')).map((d) => d.file).sort()), stored);

  const games = T['data/games.csv']; const shots = T['data/shot_attempts.csv']; const events = T['data/events.csv'];
  const players = T['data/player_game_boxscores.csv']; const gbox = T['data/goalie_game_boxscores.csv'];
  const gIdx = new Map(games.map((g) => [g.game_id, g]));

  /* 3. scope */
  const clubs = new Set(games.flatMap((g) => [g.home_id, g.away_id]));
  const types = count(games, (g) => g.season_type_native);
  check('scope_32_clubs_national_excluded', clubs.size === 32 && ![...clubs].some((c) => NATIONAL.has(c)), { clubs: clubs.size });
  check('scope_game_types', types['2'] === 1312 && types['3'] === 86 && Object.keys(types).length === 2, types);
  check('scope_all_final', games.every((g) => g.status === 'STATUS_FINAL' && g.result_status === 'STATUS_FINAL'), null);
  const sched = T['data/schedule_all_statuses.csv'];
  const notDelivered = sched.filter((s) => !gIdx.has(s.game_id));
  findings.schedule_audit = {
    rows: sched.length, by_type_status: sorted(count(sched, (s) => s.season_type_native + ':' + s.status)),
    final_club_games_not_delivered: notDelivered.filter((s) => s.status === 'STATUS_FINAL' && s.season_type_native !== '1' && !NATIONAL.has(s.home_id) && !NATIONAL.has(s.away_id)).map((s) => s.game_id),
    national_team_events_excluded: notDelivered.filter((s) => NATIONAL.has(s.home_id) || NATIONAL.has(s.away_id)).length,
    preseason_excluded: notDelivered.filter((s) => s.season_type_native === '1').length,
    note: 'type 1 = preseason, 2 = regular season (with the Four Nations events), 3 = playoffs',
  };
  check('schedule_every_final_club_game_delivered', findings.schedule_audit.final_club_games_not_delivered.length === 0, findings.schedule_audit.final_club_games_not_delivered);

  /* 4. keys */
  const uniq = (rows, f) => new Set(rows.map(f)).size === rows.length;
  check('unique_games', uniq(games, (g) => g.game_id), null);
  check('unique_events', uniq(events, (e) => e.game_id + '|' + e.event_id), null);
  check('unique_shots', uniq(shots, (s) => s.game_id + '|' + s.event_id), null);
  check('unique_player_games', uniq(players, (p) => p.game_id + '|' + p.team_id + '|' + p.player_id), null);
  const evIdx = new Map(events.map((e) => [e.game_id + '|' + e.event_id, e]));
  const orphan = shots.filter((s) => !gIdx.has(s.game_id));
  const notEvent = shots.filter((s) => { const e = evIdx.get(s.game_id + '|' + s.event_id); return !e || ['period', 'clock_native', 'event_type', 'team_id', 'x_native', 'y_native'].some((k) => e[k] !== s[k]); });
  check('shots_are_events_of_delivered_games', orphan.length === 0 && notEvent.length === 0, { orphan: orphan.length, mismatched: notEvent.length });
  findings.event_types = sorted(count(events, (e) => e.event_type));

  /* 5. shots */
  const SHOT = { Shot: 1, Goal: 1, Missed: 1, Blocked: 1 };
  check('shot_event_types', shots.every((s) => SHOT[s.event_type]), sorted(count(shots, (s) => s.event_type)));
  const badTeam = shots.filter((s) => { const g = gIdx.get(s.game_id); return s.shooting_team_id ? ![g.home_id, g.away_id].includes(s.shooting_team_id) || s.shooting_team_mapping_method !== 'boxscore_player_id_lookup' : s.shooting_team_mapping_method !== 'unmapped'; });
  check('shooting_team_is_a_club_or_explicitly_unmapped', badTeam.length === 0, badTeam.length);
  const nonSo = shots.filter((s) => s.is_shootout_candidate !== 'True');
  const unmapped = nonSo.filter((s) => !s.shooting_team_id);
  const status = JSON.parse(fs.readFileSync(path.join(PACK, 'sources', 'FEATURE_BUILD_STATUS.json'), 'utf8'));
  check('unmapped_attempts_match_build_status', unmapped.length === status.unmapped_nonshootout_attempts, { unmapped: unmapped.length, build_status: status.unmapped_nonshootout_attempts });
  const nativeVsShooter = {};
  for (const s of nonSo) {
    if (!s.shooting_team_id || !s.team_id) continue;
    const k = s.event_type; const o = nativeVsShooter[k] || (nativeVsShooter[k] = { n: 0, native_is_shooting_team: 0, native_is_defending_team: 0 });
    o.n++; if (s.team_id === s.shooting_team_id) o.native_is_shooting_team++; else o.native_is_defending_team++;
  }
  const B = nativeVsShooter.Blocked || { n: 0, native_is_defending_team: 0 };
  findings.native_team_vs_shooting_team = { by_event_type: sorted(nativeVsShooter), blocked_native_is_defending_share: r6(B.native_is_defending_team / (B.n || 1)), rule: 'on Blocked rows the native team is usually the defending team but not always, so it cannot say who shot: every count here uses shooting_team_id (resolved from the shooter id)' };
  check('native_team_is_shooting_team_on_unblocked', ['Shot', 'Missed', 'Goal'].every((k) => nativeVsShooter[k] && nativeVsShooter[k].native_is_defending_team === 0), null);
  check('xg_never_filled', shots.every((s) => s.xg === ''), null);
  const soBad = shots.filter((s) => (s.is_shootout_candidate === 'True') !== (+s.period > 4 && gIdx.get(s.game_id).season_type_native === '2'));
  check('shootout_candidates_regular_season_period_5_plus', soBad.length === 0, soBad.length);
  check('coordinates_flagged_unverified', shots.every((s) => s.coordinate_unit === 'unverified_native'), null);
  const xs = shots.map((s) => num(s.x_native)).filter((v) => v != null).sort((a, b) => a - b);
  const ys = shots.map((s) => num(s.y_native)).filter((v) => v != null).sort((a, b) => a - b);
  const q = (a, p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
  findings.coordinates_native = { with_xy: xs.length, without_xy: shots.length - xs.length, x: { min: xs[0], p01: q(xs, 0.01), p99: q(xs, 0.99), max: xs[xs.length - 1] }, y: { min: ys[0], p01: q(ys, 0.01), p99: q(ys, 0.99), max: ys[ys.length - 1] }, unit: 'unverified (hockey/crosscheck/espn.js maps them against the NHL frame)' };
  findings.strength_labels = sorted(count(nonSo, (s) => s.strength_state || '(blank)'));
  findings.shot_type_extracted = { method: 'description keyword (engineered, not a provider code)', counts: sorted(count(nonSo.filter((s) => s.event_type !== 'Blocked'), (s) => s.shot_type || '(none)')) };
  findings.goalie_on_shot = { shots_on_goal: nonSo.filter((s) => s.event_type === 'Shot').length, sog_without_goalie: nonSo.filter((s) => s.event_type === 'Shot' && !s.goalie_id).length, goals_without_goalie: nonSo.filter((s) => s.event_type === 'Goal' && !s.goalie_id).length, rule: 'a missing goalie id does not mean an empty net' };

  /* 6. goals and shootouts */
  const goalsBy = {};
  for (const s of nonSo) if (s.is_goal === 'True' && s.team_id) goalsBy[s.game_id + '|' + s.team_id] = (goalsBy[s.game_id + '|' + s.team_id] || 0) + 1;
  let goalMismatch = 0; const soGames = new Set(); const badDelta = [];
  for (const g of games) {
    const h = goalsBy[g.game_id + '|' + g.home_id] || 0, a = goalsBy[g.game_id + '|' + g.away_id] || 0;
    if (h !== +g.home_nonshootout_goals_from_pbp || a !== +g.away_nonshootout_goals_from_pbp) goalMismatch++;
    const dh = +g.home_final_score_native - h, da = +g.away_final_score_native - a;
    if (dh === 0 && da === 0) continue;
    if (g.season_type_native === '2' && dh + da === 1 && h === a && dh >= 0 && da >= 0) soGames.add(g.game_id); else badDelta.push(g.game_id);
  }
  check('nonshootout_goals_recomputed', goalMismatch === 0, goalMismatch);
  check('final_minus_nonshootout_is_shootout_winner', badDelta.length === 0, badDelta);
  findings.shootouts = { games: soGames.size, rule: 'the native final includes the awarded shootout goal; nonshootout goals are the model target' };
  findings.end_period = sorted(count(games, (g) => g.end_period || '(blank)'));
  findings.neutral_site = games.filter((g) => g.neutral_site === 'True').map((g) => ({ game_id: g.game_id, start: g.start_time, home: g.home_name, away: g.away_name, venue: g.venue_name }));

  /* 7. assists */
  let collapsed = 0, twoAssists = 0;
  for (const s of shots) {
    if (s.is_goal !== 'True') continue;
    let rows = []; let by = {};
    try { rows = JSON.parse(s.participant_role_rows_json || '[]'); by = JSON.parse(s.participants_by_role_json || '{}'); } catch (_) { continue; }
    const nA = rows.filter((r) => r.role === 'assister').length;
    if (nA >= 2) { twoAssists++; if (Object.keys(by).filter((k) => /assist/.test(k)).length < nA) collapsed++; }
  }
  findings.assists = { goals_with_two_assisters: twoAssists, collapsed_in_by_role_object: collapsed, rule: 'read participant_role_rows_json; the by-role object keeps one assister' };

  /* 8. units */
  let toiBad = 0, sumBad = 0, sumN = 0;
  for (const p of players) {
    for (const k of ['TOI', 'PPTOI', 'SHTOI', 'ESTOI']) if (p[k] !== undefined && p[k] !== '' && String(toi(p[k])) !== p[k + '_seconds']) toiBad++;
    if (p.group !== 'goalies' && p.ESTOI_seconds !== '') { sumN++; if (+p.ESTOI_seconds + +p.PPTOI_seconds + +p.SHTOI_seconds !== +p.TOI_seconds) sumBad++; }
  }
  for (const p of gbox) if (p.TOI !== '' && String(toi(p.TOI)) !== p.TOI_seconds) toiBad++;
  check('toi_seconds_parsed_from_mmss', toiBad === 0, toiBad);
  check('toi_es_plus_pp_plus_sh', sumBad === 0, { skater_rows: sumN, mismatched: sumBad });
  findings.player_groups = sorted(count(players, (p) => p.group));
  findings.skaters_per_team_game = sorted(count(Object.values(count(players.filter((p) => p.group !== 'goalies'), (p) => p.game_id + '|' + p.team_id)), (n) => n));

  /* 9. native definitions: SOG = shootout goals */
  const sogPositive = players.filter((p) => p.SOG !== '' && +p.SOG > 0);
  check('sog_is_shootout_goals_never_outside_shootouts', sogPositive.every((p) => soGames.has(p.game_id)), sogPositive.length);
  findings.sog_shootout_goals = { rows_above_zero: sogPositive.length, shootout_games: soGames.size, note: sogPositive.length ? null : 'SOG (shootout goals) is 0 in every row, including the shootout games: the field is not populated, so shootout scorers cannot be read from it' };

  /* 10. goalies */
  const gm = T['data/goalie_game_measured_features.csv'];
  check('goalie_xg_gsax_confirmation_blank', gm.every((g) => g.expected_goals_against === '' && g.gsax === '' && g.pregame_starter_confirmation === ''), null);
  const deltas = count(gbox, (g) => (g.SA === '' || g.SV === '' || g.GA === '' ? 'blank' : String(+g.SA - +g.SV - +g.GA)));
  check('goalie_sa_minus_sv_minus_ga_zero_or_minus_one', Object.keys(deltas).every((k) => k === '0' || k === '-1'), deltas);
  const extraGa = gbox.filter((g) => +g.SA - +g.SV - +g.GA === -1);
  findings.goalie_ga_not_in_sa = { rows: extraGa.length, of_which_toi_under_60_min: extraGa.filter((g) => +g.TOI_seconds < 3600).length, note: 'GA counts one goal that SA does not (most of these goalies were pulled): save rates use SV / SA, never GA' };
  const gHave = new Set(gbox.map((g) => g.game_id + '|' + g.team_id));
  findings.goalie_rows = {
    per_team_game: sorted(count(Object.values(count(gbox, (g) => g.game_id + '|' + g.team_id)), (n) => n)),
    team_games_without_goalie_row: games.flatMap((g) => [g.home_id, g.away_id].filter((t) => !gHave.has(g.game_id + '|' + t)).map((t) => ({ game_id: g.game_id, start: g.start_time, team_id: t, team: t === g.home_id ? g.home_name : g.away_name }))),
    native_starter_flag: sorted(count(gbox, (g) => g.native_starter_flag || '(blank)')),
  };

  /* 11. measured team-game features */
  const box = new Map(T['data/team_game_boxscores.csv'].map((b) => [b.game_id + '|' + b.team_id, b]));
  const byGame = {}; for (const s of nonSo) (byGame[s.game_id] = byGame[s.game_id] || []).push(s);
  const mine = [];
  for (const g of games) {
    const sh = byGame[g.game_id] || [];
    const unknown = sh.filter((s) => !s.shooting_team_id).length;
    for (const [side, other] of [['home', 'away'], ['away', 'home']]) {
      const tid = g[side + '_id'], oid = g[other + '_id'];
      const own = sh.filter((s) => s.shooting_team_id === tid), opp = sh.filter((s) => s.shooting_team_id === oid);
      const ub = (a) => a.filter((s) => s.is_blocked !== 'True').length;
      const sog = (a) => a.filter((s) => s.event_type === 'Shot' || s.event_type === 'Goal').length;
      const ev = (a) => a.filter((s) => s.strength_state === 'Even Strength');
      const gl = (a, reg) => a.filter((s) => s.is_goal === 'True' && (!reg || +s.period <= 3)).length;
      const b = box.get(g.game_id + '|' + tid) || {};
      const r = {
        game_id: g.game_id, team_id: tid, opponent_id: oid, start_time: g.start_time, home_away: side,
        all_nonshootout_attempts_for: own.length, all_nonshootout_attempts_against: opp.length, all_unblocked_for: ub(own), all_unblocked_against: ub(opp),
        sog_from_pbp_for: sog(own), sog_from_pbp_against: sog(opp), all_goals_from_pbp_for: gl(own), all_goals_from_pbp_against: gl(opp),
        regulation_goals_for: gl(own, 1), regulation_goals_against: gl(opp, 1),
        even_strength_native_attempts_for: ev(own).length, even_strength_native_attempts_against: ev(opp).length,
        even_strength_native_unblocked_for: ub(ev(own)), even_strength_native_unblocked_against: ub(ev(opp)),
        shot_team_unmapped_in_game: unknown,
        all_corsi_share_observed: own.length + opp.length ? own.length / (own.length + opp.length) : null,
        all_fenwick_share_observed: ub(own) + ub(opp) ? ub(own) / (ub(own) + ub(opp)) : null,
      };
      for (const k of ['powerPlayGoals', 'powerPlayOpportunities', 'shortHandedGoals', 'faceoffsWon', 'faceoffPercent', 'blockedShots', 'hits', 'takeaways', 'giveaways', 'penalties', 'penaltyMinutes']) r['box_' + k] = pyVal(b[k]);
      r.pp_conversion_observed = r.box_powerPlayGoals != null && r.box_powerPlayOpportunities ? r.box_powerPlayGoals / r.box_powerPlayOpportunities : null;
      r.native_box_shots = pyVal(b.shotsTotal);
      r.sog_reconciliation_delta = r.native_box_shots != null ? r.sog_from_pbp_for - r.native_box_shots : null;
      mine.push(r);
    }
  }
  const same = (a, b) => (a == null || a === '' ? b == null || b === '' : b != null && b !== '' && Math.abs(Number(a) - Number(b)) <= 1e-9 * Math.max(1, Math.abs(Number(b))));
  const mIdx = new Map(gm.length ? T['data/team_game_measured_features.csv'].map((m) => [m.game_id + '|' + m.team_id, m]) : []);
  const measuredBad = {};
  for (const r of mine) {
    const m = mIdx.get(r.game_id + '|' + r.team_id);
    if (!m) { measuredBad.__missing = (measuredBad.__missing || 0) + 1; continue; }
    for (const [k, v] of Object.entries(r)) if (!['start_time', 'home_away', 'opponent_id', 'game_id', 'team_id'].includes(k) && !same(v, m[k])) measuredBad[k] = (measuredBad[k] || 0) + 1;
  }
  check('measured_features_recomputed', Object.keys(measuredBad).length === 0 && mine.length === mIdx.size, measuredBad);
  findings.sog_reconciliation = { team_games: mine.length, pbp_sog_equals_box_shots: mine.filter((r) => r.sog_reconciliation_delta === 0).length, distribution: sorted(count(mine.filter((r) => r.sog_reconciliation_delta != null), (r) => String(r.sog_reconciliation_delta))) };

  /* 12. lagged features */
  const lag = T['data/pregame_lagged_research_features.csv'];
  const lagIdx = new Map(lag.map((l) => [l.game_id + '|' + l.team_id, l]));
  const hist = {}; const lagBad = {}; let leak = 0;
  const order = mine.slice().sort((a, b) => (a.start_time < b.start_time ? -1 : a.start_time > b.start_time ? 1 : a.game_id < b.game_id ? -1 : a.game_id > b.game_id ? 1 : a.team_id < b.team_id ? -1 : 1));
  const METRICS = ['all_nonshootout_attempts_for', 'all_nonshootout_attempts_against', 'all_unblocked_for', 'all_unblocked_against', 'regulation_goals_for', 'regulation_goals_against', 'sog_from_pbp_for', 'sog_from_pbp_against'];
  const SHARES = [['all_nonshootout_attempts_for', 'all_nonshootout_attempts_against', 'corsi_share'], ['all_unblocked_for', 'all_unblocked_against', 'fenwick_share'], ['even_strength_native_attempts_for', 'even_strength_native_attempts_against', 'native_even_strength_corsi_share']];
  for (const r of order) {
    const prior = hist[r.team_id] || (hist[r.team_id] = []);
    const t = Date.parse(r.start_time);
    if (prior.some((p) => !(p.start_time < r.start_time))) leak++;
    const o = { prior_games_available: prior.length };
    o.hours_between_scheduled_starts = prior.length ? (t - Date.parse(prior[prior.length - 1].start_time)) / 3600e3 : null;
    for (const d of [3, 7, 14]) o['games_in_prior_' + d + '_days'] = prior.filter((p) => { const s = (t - Date.parse(p.start_time)) / 1e3; return s > 0 && s <= d * 86400; }).length;
    for (const n of [5, 10, 20]) {
      const sub = prior.slice(-n); o['games_exposure_prior_' + n] = sub.length;
      for (const m of METRICS) o[m + '_pergame_prior_' + n] = sub.length ? sub.reduce((s, p) => s + p[m], 0) / sub.length : null;
      for (const [f, a, name] of SHARES) { const nu = sub.reduce((s, p) => s + p[f], 0); const de = nu + sub.reduce((s, p) => s + p[a], 0); o[name + '_prior_' + n] = de ? nu / de : null; o[name + '_attempts_exposure_prior_' + n] = de; }
    }
    const l = lagIdx.get(r.game_id + '|' + r.team_id);
    if (!l) lagBad.__missing = (lagBad.__missing || 0) + 1;
    else for (const [k, v] of Object.entries(o)) if (!same(v, l[k])) lagBad[k] = (lagBad[k] || 0) + 1;
    prior.push(r);
  }
  check('lagged_features_recomputed_target_excluded', Object.keys(lagBad).length === 0 && leak === 0 && lag.length === mine.length, Object.assign({ prior_not_strictly_earlier: leak }, lagBad));
  check('lagged_quality_label_retrospective', lag.every((l) => l.quality === 'target_excluded_retrospective_publication_unknown'), null);

  /* officials */
  const off = T['data/officials.csv'];
  const offG = {}; for (const o of off) (offG[o.game_id] = offG[o.game_id] || []).push(o);
  findings.officials = {
    rows: off.length, games: Object.keys(offG).length, distinct_referees: new Set(off.filter((o) => o.position === 'Referee').map((o) => o.name)).size,
    referees_listed_per_game: sorted(count(Object.values(offG), (a) => a.filter((o) => o.position === 'Referee').length)),
    three_referees_listed: sorted(count(Object.entries(offG).filter(([, a]) => a.filter((o) => o.position === 'Referee').length === 3), ([id]) => 'type ' + (gIdx.get(id) || {}).season_type_native)),
    games_without_officials: games.filter((g) => !offG[g.game_id]).map((g) => g.game_id),
    note: 'playoff listings can name three referees (ESPN does not say which two worked); no assignment time is recorded, so officials are research only',
  };

  /* 13. schemas */
  const schemaFiles = []; (function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else schemaFiles.push(path.relative(path.join(PACK, 'schemas'), p)); } })(path.join(PACK, 'schemas'));
  const identical = [], differ = [];
  for (const f of schemaFiles.sort()) { const qf = path.join(QUANT, 'schemas', f); (fs.existsSync(qf) && fs.readFileSync(qf).equals(fs.readFileSync(path.join(PACK, 'schemas', f))) ? identical : differ).push(f); }
  check('schemas_match_quant_v1_contracts', differ.every((f) => f === 'feature_catalog.json'), { identical: identical.length, differ });
  const tmplBad = [];
  for (const f of schemaFiles.filter((x) => /\.schema\.json$/.test(x))) {
    const s = JSON.parse(fs.readFileSync(path.join(PACK, 'schemas', f), 'utf8'));
    const tf = path.join(PACK, 'schemas', path.dirname(f), 'templates', path.basename(f).replace('.schema.json', '_EMPTY_TEMPLATE.csv'));
    if (!fs.existsSync(tf)) { tmplBad.push(f + ': no template'); continue; }
    const t = readCsv(tf);
    if (t.rows.length) tmplBad.push(f + ': template has rows');
    if (JSON.stringify(Object.keys(s.properties || {}).sort()) !== JSON.stringify(t.header.slice().sort())) tmplBad.push(f + ': columns differ');
  }
  check('json_schema_matches_empty_template', tmplBad.length === 0, tmplBad);
  const cat = JSON.parse(fs.readFileSync(path.join(PACK, 'schemas', 'feature_catalog.json'), 'utf8'));
  const qcat = new Map(JSON.parse(fs.readFileSync(path.join(QUANT, 'schemas', 'feature_catalog.json'), 'utf8')).map((x) => [x.family + '|' + x.feature, JSON.stringify(x)]));
  const catNew = cat.filter((x) => qcat.get(x.family + '|' + x.feature) !== JSON.stringify(x)).map((x) => x.family + '|' + x.feature);
  check('feature_catalog_subset_of_quant_v1', catNew.length === 0, { entries: cat.length, new_or_changed: catNew });

  /* 14. source manifest */
  const man = JSON.parse(fs.readFileSync(path.join(PACK, 'sources', 'COLLECTION_MANIFEST.json'), 'utf8'));
  const prov = man.cached_response_provenance || [];
  findings.source_manifest = {
    source: man.source, season: man.season, selected_completed_games: man.selected_completed_games, failures: (man.failures || []).length,
    responses_listed: prov.length, responses_with_retrieved_at: prov.filter((p) => p.retrieved_at).length, known_at_recorded: prov.filter((p) => p.known_at).length,
    digests_verifiable_here: 0, reason: 'the raw responses were not shipped (sources/COLLECTION_MANIFEST.json raw_cache_not_shipped); the digests are kept as provenance',
    hosts: sorted(count(prov, (p) => { try { return new URL(p.source_url).host; } catch (_) { return '(none)'; } })),
  };
  check('manifest_matches_delivery', man.selected_completed_games === games.length && man.completed_details === games.length && (man.failures || []).length === 0, { selected: man.selected_completed_games, details: man.completed_details });

  const pass = checks.every((c) => c.pass);
  return {
    schema: 'edgedesk_datapack_verification_v1',
    pack: 'datapack/nhl_v1',
    verified_at: new Date().toISOString(),
    status: pass ? 'PASSED' : 'FAILED',
    summary: { datasets: datasets.length, verified: datasets.filter((d) => d.state === 'VERIFIED').length, failed: failed.length, games: games.length, shot_attempts: shots.length, events: events.length, player_game_rows: players.length, goalie_game_rows: gbox.length, checks: checks.length, checks_passed: checks.filter((c) => c.pass).length },
    checks,
    findings,
    datasets,
    limitations: [
      'Not a point-in-time certification: known_at is blank throughout, so every table is retrospective research data.',
      'Not a licensing certification: ESPN\'s public responses carry no redistribution grant (sources/ACCESS_AND_RIGHTS.md).',
      'Not model validation: the pack ships no trained model, no xG and no bookmaker prices.',
      'One season (2024-25): enough to cross-check my NHL history and to explore; not enough to calibrate a 2026-27 model on its own.',
    ],
  };
}

function stable(r) { const c = JSON.parse(JSON.stringify(r)); delete c.verified_at; return JSON.stringify(c); }

if (require.main === module) {
  const r = verify();
  const checkMode = process.argv.indexOf('--check') >= 0;
  for (const c of r.checks) console.log((c.pass ? 'ok   ' : 'FAIL ') + c.id + (c.pass ? '' : '  ' + JSON.stringify(c.detail).slice(0, 300)));
  console.log(r.status + ' — ' + JSON.stringify(r.summary));
  if (checkMode) {
    let committed = null;
    try { committed = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (_) {}
    if (!committed || stable(committed) !== stable(r)) { console.log('FAIL the committed EDGEDESK_VERIFICATION.json differs from a fresh run'); process.exit(1); }
    process.exit(r.status === 'PASSED' ? 0 : 1);
  }
  fs.writeFileSync(OUT, JSON.stringify(r, null, 2) + '\n');
  console.log('wrote ' + path.relative(ROOT, OUT));
  process.exit(r.status === 'PASSED' ? 0 : 1);
}
module.exports = { verify, toi };
