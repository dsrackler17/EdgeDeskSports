'use strict';
/* ===========================================================================
   The audit: what the pack's tables can and cannot be trusted for.

   Every check reports counts, not verdicts. A source field whose QA flag is
   null is UNKNOWN, never a pass. Nothing here rewrites a source value; the
   outputs are flags the models read (gameQuality) and a published report
   (published/audit.json).

     games        status, regimes, events, overtime (2 x 20-min halves, 5-min OT)
     boxes        ESPN official box vs NCAA publisher detail; the pack's own
                  discrepancy table cross-checked
     possessions  per-game points vs the official final; possessions vs the
                  box-score proxy and the publisher count; ten identities
     lineups      opening five vs ESPN starters for BOTH reconstructions
                  (possession table, publisher lineup table); minutes from
                  stints vs box minutes; the all-null player_count_error flag
     shots        score_value on misses; made shots vs the box; actor roles
     estimator    the FTA coefficient fitted on 2024-25, checked on 2026
     identity     crosswalk coverage; name-link error rate measured on 2026
   =========================================================================== */
const C = require('./config');
const I = require('./ingest');
const ID = require('./identity');
const U = require('./lib/util');

/* ---------------------------------------------------------------- possessions vs finals */
function possessionGameQuality(P, TG) {
  const sums = new Map(); // game -> {home pts, away pts, n, flagged}
  for (let i = 0; i < P.n; i++) {
    const g = P.game[i];
    if (!sums.has(g)) sums.set(g, { home: P.home[i], away: P.away[i], hp: 0, ap: 0, n: 0, nh: 0, na: 0, unidentified: 0, duplicate: 0, garbage: 0, unknown_off: 0 });
    const s = sums.get(g); s.n++;
    if (P.off_home[i] === 1) { s.nh++; if (P.pts[i] > 0) s.hp += P.pts[i]; } else if (P.off_home[i] === 0) { s.na++; if (P.pts[i] > 0) s.ap += P.pts[i]; } else s.unknown_off++;
    if (P.flags[i] & 1) s.unidentified++;
    if (P.flags[i] & 2) s.duplicate++;
    if (P.garbage[i]) s.garbage++;
  }
  const out = new Map(); const tally = { games: 0, exact: 0, within_3: 0, larger: 0, no_box: 0, swapped_two: 0 };
  for (const [g, s] of sums) {
    tally.games++;
    const rs = TG.byGame.get(g);
    const box = rs && rs.length === 2 ? new Map(rs.map((r) => [r.team, r.pts])) : null;
    if (!box || !box.has(s.home) || !box.has(s.away)) { tally.no_box++; out.set(g, Object.assign(s, { status: 'NO_OFFICIAL_BOX' })); continue; }
    const dh = s.hp - box.get(s.home); const da = s.ap - box.get(s.away);
    s.delta_home = dh; s.delta_away = da;
    if (dh === 0 && da === 0) { s.status = 'EXACT'; tally.exact++; }
    else if (Math.abs(dh) <= 3 && Math.abs(da) <= 3) { s.status = 'WITHIN_3'; tally.within_3++; if (dh === -da && Math.abs(dh) === 2) tally.swapped_two++; }
    else { s.status = 'LARGER'; tally.larger++; }
    out.set(g, s);
  }
  return { byGame: out, tally };
}

/* ---------------------------------------------------------------- opening fives */
function openingFives(P, PG, X, LT, membership) {
  const starters = new Map(); const starterNames = new Map();
  for (const r of PG.rows) {
    if (r.season !== 2026 || !r.starter) continue;
    const k = r.game_id + ':' + r.team;
    if (!starters.has(k)) { starters.set(k, new Set()); starterNames.set(k, new Set()); }
    starters.get(k).add(r.athlete); starterNames.get(k).add(ID.normName(r.name));
  }
  // possession table: first possession of period 1, mapped through the fingerprint crosswalk (ids, not names)
  const first = new Map();
  for (let i = 0; i < P.n; i++) if (P.period[i] === 1 && (!first.has(P.game[i]) || P.num[i] < P.num[first.get(P.game[i])])) first.set(P.game[i], i);
  const poss = { team_games: 0, all_five: 0, overlap_sum: 0, unmapped_slots: 0 };
  for (const [g, i] of first) {
    for (const side of [0, 1]) {
      const team = side === 0 ? P.home[i] : P.away[i];
      const st = starters.get(g + ':' + team); if (!st || st.size !== 5) continue;
      let ov = 0; let unm = 0;
      for (let k = side * 5; k < side * 5 + 5; k++) { const a = X.athleteOf.get(P.ids[i * 10 + k]); if (a == null) unm++; else if (st.has(a)) ov++; }
      poss.team_games++; poss.overlap_sum += ov; poss.unmapped_slots += unm; if (ov === 5) poss.all_five++;
    }
  }
  // publisher lineup table: names only ("Last, First"), compared by normalised name with the starters' names: a measurement, not a join
  const lt = LT.cols; const firstStint = new Map();
  for (let i = 0; i < LT.n; i++) { const k = lt.contest_id[i] + '|' + lt.team[i]; if (!firstStint.has(k) || lt.start_min[i] < lt.start_min[firstStint.get(k)]) firstStint.set(k, i); }
  const contestToGame = new Map();
  for (let i = 0; i < P.n; i++) if (!contestToGame.has(P.contest[i])) contestToGame.set(P.contest[i], P.game[i]);
  const flip = (s) => { if (s == null) return null; const t = String(s); const j = t.indexOf(','); return ID.normName(j >= 0 ? t.slice(j + 1) + ' ' + t.slice(0, j) : t); };
  const lut = { team_games: 0, all_five: 0, overlap_sum: 0, team_unmapped: 0 };
  for (const [k, i] of firstStint) {
    const g = contestToGame.get(lt.contest_id[i]); if (g == null) continue;
    const team = membership.espnOfNcaaName(2026, lt.team[i]); if (team == null) { lut.team_unmapped++; continue; }
    const st = starterNames.get(g + ':' + team); if (!st || st.size !== 5) continue;
    let ov = 0; for (let s = 1; s <= 5; s++) if (st.has(flip(lt['player_' + s][i]))) ov++;
    lut.team_games++; lut.overlap_sum += ov; if (ov === 5) lut.all_five++;
  }
  const fin = (o) => Object.assign(o, { all_five_share: U.r(o.all_five / o.team_games, 4), mean_overlap: U.r(o.overlap_sum / o.team_games, 3) });
  return { possession_table: fin(poss), publisher_lineup_table: fin(lut) };
}

/* ---------------------------------------------------------------- the lineup table's own flags */
function lineupTableChecks(LT) {
  const c = LT.cols; let nullFlag = 0; let notFive = 0; let zero = 0; let teamYear = {};
  for (let i = 0; i < LT.n; i++) {
    if (c.player_count_error[i] == null) nullFlag++;
    const s = new Set(); for (let k = 1; k <= 5; k++) if (c['player_' + k][i]) s.add(c['player_' + k][i]);
    if (s.size !== 5) notFive++;
    if (!(c.duration_mins[i] > 0)) zero++;
    teamYear[c.team_year[i]] = (teamYear[c.team_year[i]] || 0) + 1;
  }
  return { rows: LT.n, player_count_error_null: nullFlag, rows_without_five_distinct_names: notFive, zero_or_negative_duration: zero, team_year_values: teamYear, note: 'team_year is the publisher\'s calendar-year label (2025 for the 2025-26 season); the season field is the end year' };
}

/* ---------------------------------------------------------------- shots */
function shotChecks(S, TG, PG) {
  const c = S.cols; const t = { rows: S.n, missed_with_positive_score_value: 0, made: 0, free_throw_type_on_miss: 0, primary_actor_missing: 0, by_type: {} };
  const madeFG = new Map(); const madeFT = new Map(); const att3 = new Map(); const shooterFGM = new Map(); const secondOnMade = { made_fg_with_second_actor: 0, made_fg: 0 };
  for (let i = 0; i < S.n; i++) {
    const made = c.scoring_play[i] === 1; const sv = c.score_value[i]; const type = c.type_text[i];
    t.by_type[type] = (t.by_type[type] || 0) + 1;
    if (!made && sv > 0) t.missed_with_positive_score_value++;
    if (!made && type === 'MadeFreeThrow') t.free_throw_type_on_miss++;
    if (made) t.made++;
    if (!(c.athlete_id_1[i] > 0)) t.primary_actor_missing++;
    const k = c.game_id[i] + ':' + c.team_id[i];
    if (type === 'MadeFreeThrow') { if (made) madeFT.set(k, (madeFT.get(k) || 0) + 1); continue; }
    if (sv === 3) att3.set(k, (att3.get(k) || 0) + 1);
    if (made) {
      madeFG.set(k, (madeFG.get(k) || 0) + 1); secondOnMade.made_fg++;
      if (c.athlete_id_2[i] > 0) secondOnMade.made_fg_with_second_actor++;
      if (c.athlete_id_1[i] > 0) { const a = c.game_id[i] + ':' + c.athlete_id_1[i]; shooterFGM.set(a, (shooterFGM.get(a) || 0) + 1); }
    }
  }
  const cmp = { team_games: 0, fgm_equal: 0, ftm_equal: 0, tpa_equal: 0 };
  const shotGames = new Set(); for (let i = 0; i < S.n; i++) shotGames.add(c.game_id[i]);
  for (const r of TG.rows) {
    if (r.season !== 2026 || !shotGames.has(r.game_id)) continue;
    const k = r.game_id + ':' + r.team; cmp.team_games++;
    if ((madeFG.get(k) || 0) === r.fgm) cmp.fgm_equal++;
    if ((madeFT.get(k) || 0) === r.ftm) cmp.ftm_equal++;
    if ((att3.get(k) || 0) === r.tpa) cmp.tpa_equal++;
  }
  const pl = { player_games: 0, fgm_equal: 0 };
  for (const r of PG.rows) { if (r.season !== 2026 || !shotGames.has(r.game_id) || r.dnp) continue; pl.player_games++; if ((shooterFGM.get(r.game_id + ':' + r.athlete) || 0) === r.fgm) pl.fgm_equal++; }
  return {
    counts: t, team_box_agreement: Object.assign(cmp, { fgm_rate: U.r(cmp.fgm_equal / cmp.team_games, 4), ftm_rate: U.r(cmp.ftm_equal / cmp.team_games, 4), three_attempt_rate: U.r(cmp.tpa_equal / cmp.team_games, 4) }),
    player_box_agreement: Object.assign(pl, { fgm_rate: U.r(pl.fgm_equal / pl.player_games, 4) }),
    second_actor: Object.assign(secondOnMade, { share: U.r(secondOnMade.made_fg_with_second_actor / secondOnMade.made_fg, 4) }),
    rules: [
      'score_value is the value of the attempt, not points scored: positive on misses',
      'type_text "MadeFreeThrow" labels missed free throws too; scoring_play is the only made/missed gate',
      'athlete_id_2 is present on some made field goals only; it is not established as the assister and is not used as one',
      'coordinates are not used: the transform and raw court frames are unverified',
    ],
  };
}

/* ---------------------------------------------------------------- possession estimator */
function estimatorStudy(TG, PQ) {
  // per team-game: box proxy components vs the publisher's parsed count (NCAA o_poss) and, in 2026, the possession table's count
  const rows = [];
  for (const r of TG.rows) {
    if (!r.o || r.flags.length) continue;
    const base = r.fga - r.orb + r.tov; const ft = r.fta;
    if (![base, ft].every(Number.isFinite)) continue;
    rows.push({ season: r.season, base, ft, pub: r.ncaa && !r.ncaa.quarantined ? r.ncaa.o_poss : null, game: r.game_id, team: r.team, side: r.side });
  }
  const fit = (sel, ref) => { // least squares c in (ref - base) = c * ft
    let sxy = 0; let sxx = 0; for (const x of sel) { const y = ref(x); if (y == null) continue; sxy += (y - x.base) * x.ft; sxx += x.ft * x.ft; } return sxy / sxx;
  };
  const err = (sel, ref, c) => { let s = 0; let a = 0; let n = 0; for (const x of sel) { const y = ref(x); if (y == null) continue; const e = x.base + c * x.ft - y; s += e * e; a += Math.abs(e); n++; } return { n, rmse: U.r(Math.sqrt(s / n), 3), mae: U.r(a / n, 3) }; };
  const train = rows.filter((x) => x.season <= 2025); const test = rows.filter((x) => x.season === 2026);
  const pubRef = (x) => x.pub;
  const counted = new Map();
  for (const [g, s] of PQ.byGame) { if (s.status !== 'EXACT') continue; counted.set(g + ':' + s.home, s.nh); counted.set(g + ':' + s.away, s.na); }
  const cntRef = (x) => (counted.has(x.game + ':' + x.team) ? counted.get(x.game + ':' + x.team) : null);
  const cFit = fit(train, pubRef);
  const out = { fitted_on: '2024-2025 team-games, target = publisher-parsed offensive possessions (NCAA o_poss)', c_fitted: U.r(cFit, 4), compare: {} };
  for (const c of [0.44, 0.475, cFit]) {
    out.compare[String(U.r(c, 4))] = { vs_publisher_2026: err(test, pubRef, c), vs_possession_table_2026: err(test, cntRef, c) };
  }
  return out;
}

/* ---------------------------------------------------------------- RAPM tables */
function rapmChecks(R) {
  const out = {};
  for (const s of C.SEASONS) {
    const rows = R[s]; const zero = rows.filter((r) => !(r.off_poss > 0)).length;
    out[s] = { rows: rows.length, zero_possession_rows: zero, estimands: [...new Set(rows.map((r) => r.estimand))], net_sd: U.r(U.sd(rows.map((r) => r.rapm_net)), 3) };
  }
  const yoy = (a, b, min) => {
    const m = new Map(R[a].map((r) => [r.person_id, r])); const x = []; const y = [];
    for (const r of R[b]) { const p = m.get(r.person_id); if (p && p.off_poss >= min && r.off_poss >= min) { x.push(p.rapm_net); y.push(r.rapm_net); } }
    return { n: x.length, corr: U.r(U.corr(x, y), 3) };
  };
  out.year_over_year = { '2024_to_2025_min500': yoy(2024, 2025, 500), '2025_to_2026_min500': yoy(2025, 2026, 500), '2025_to_2026_min1000': yoy(2025, 2026, 1000) };
  out.rule = 'full-season fits include every game of the season: never a predictor for a game of the same season; a prior only for the next season, after identity checks';
  return out;
}

async function run() {
  const G = await I.loadGames(); const TG = await I.loadTeamGames(); const PG = await I.loadPlayerGames(); const NP = await I.loadNcaaPlayerGames();
  const P = await I.loadPossessions(); const LT = await I.loadLineupTable(); const S = await I.loadShots(); const R = await I.loadRapm();
  const packAudit = await I.loadPackAudit(); const M = await ID.teamMembership();
  const X = ID.playerCrosswalk(NP.rows, PG.rows);
  const PQ = possessionGameQuality(P, TG);

  const ot = {}; for (const g of G.games) if (g.status === 'FINAL') { const k = g.season + ':' + (g.n_ot == null ? 'unknown' : g.n_ot); ot[k] = (ot[k] || 0) + 1; }
  const minutesCheck = { team_games: 0, within_1: 0 };
  for (const r of TG.rows) { if (!r.ncaa || r.ncaa.mins == null) continue; const g = G.byId.get(r.game_id); if (!g || g.minutes == null) continue; minutesCheck.team_games++; if (Math.abs(r.ncaa.mins - g.minutes) <= 1) minutesCheck.within_1++; }
  // our discrepancy list vs the pack's
  const ours = new Set(TG.rows.filter((r) => r.ncaa && r.ncaa.quarantined).map((r) => r.game_id + ':' + r.team));
  const theirs = new Set(packAudit.map((r) => r.espn_game_id + ':' + r.espn_team_id));
  const both = [...ours].filter((k) => theirs.has(k)).length;

  const slotStats = { possessions: P.n, any_unidentified: 0, duplicate_player: 0, unknown_offense: 0, garbage: 0, transition: 0 };
  for (let i = 0; i < P.n; i++) { if (P.flags[i] & 1) slotStats.any_unidentified++; if (P.flags[i] & 2) slotStats.duplicate_player++; if (P.flags[i] & 4) slotStats.unknown_offense++; if (P.garbage[i]) slotStats.garbage++; if (P.transition[i]) slotStats.transition++; }

  // name-based person links: error rate measured on 2026 against the fingerprint chain
  const nameLinks26 = ID.personToEspnByName(2026, R[2026], PG.rows, M);
  let agree = 0; let disagree = 0; let unverifiable = 0;
  for (const [person, l] of nameLinks26.links) {
    const viaFp = X.athleteOf.get(l.player_id);
    if (viaFp == null) unverifiable++; else if (viaFp === l.athlete) agree++; else disagree++;
  }

  return {
    report: {
      schema: 'edgedesk_ncaam_audit_v1',
      games: { stats: G.stats, overtime_by_season: ot, ncaa_minutes_vs_period_count: Object.assign(minutesCheck, { share: U.r(minutesCheck.within_1 / minutesCheck.team_games, 4) }), regulation: '2 x 20-minute halves; overtime 5 minutes; periods 3+ are overtimes' },
      membership: M.audit,
      boxes: { by_season: TG.audit, pairs: TG.pairs, broken_pairs: TG.broken_pairs, pack_discrepancy_table: { rows: packAudit.length, ours: ours.size, in_both: both }, rule: 'ESPN box is the official count; an NCAA detail row that disagrees is quarantined, never substituted' },
      player_boxes: { espn: PG.audit, ncaa_2026: NP.audit },
      possessions: { slots: slotStats, reconciliation: PQ.tally, name_conflicts: P.name_conflicts.length, rule: 'possession points that disagree with the official final keep their flag; player models are refitted without them as a sensitivity' },
      lineups: { opening_five_vs_espn_starters: openingFives(P, PG, X, LT, M), publisher_lineup_table: lineupTableChecks(LT) },
      shots: shotChecks(S, TG, PG),
      possession_estimator: estimatorStudy(TG, PQ),
      rapm_tables: rapmChecks(R),
      identity: {
        player_crosswalk_2026: X.audit,
        quarantine_reasons: U.countBy(X.quarantine, (q) => q.reason),
        name_based_person_links_2026: Object.assign(nameLinks26.audit, { verified_against_fingerprints: { agree, disagree, unverifiable, error_rate: U.r(disagree / Math.max(1, agree + disagree), 4) } }),
      },
    },
    PQ, X, M,
  };
}

module.exports = { run, possessionGameQuality, openingFives, shotChecks, estimatorStudy, lineupTableChecks };
