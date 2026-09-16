#!/usr/bin/env node
/* ============================================================================
   TEAM IDENTITY PROFILES — football/identity/index.json + football/identity/teams/<key>.json

   WHY. A season average tells the desk how good a team has been; it does not
   tell the desk WHO the team is: what it leans on, what it cannot do, who is
   under centre and who is behind him, whether the line that protects him is
   the line that protected him last year, and whether any of that is changing
   week to week. This job writes one dated profile per FBS team and per NFL
   club from the artifacts the other builds already publish, and it keeps
   three things apart that a prose profile would run together:

     measured      numbers with a sample and a source — copied, never derived
     qualitative   sourced observations (a coaching change, a starter status)
                   with the feed and the date they came from
     inferences    labels EdgeDesk derives from the measured numbers by a
                   stated rule, with the inputs and a confidence beside each

   Every profile carries season, effective dates and the time it was last
   verified against its sources. A previous season's identity never becomes
   this season's: the season is a field, the rule is enforced at read time,
   and the trend block says how the team is changing WITHIN the season it
   describes.

   NOTHING NEW IS COMPUTED except league means for the NFL rates (the engine
   publishes deviations, so the raw per-club rate is re-summed from the same
   team-week rows the engine reads) and the within-season trend deltas.

   Inputs (all committed or cached; a missing one is declared, never faked):
     football/rankings/current.json          FBS unit metric records, units, continuity, talent, ST
     football/rankings/history.json          weekly ETSR and category series (the within-season trend)
     football/players/current.json           scheme labels and tendency z-scores (two-season blend)
     football/players/teams/<key>.json       projected QB room (slot 2 = the backup), OL returning
     football/fbs_epa/qb_epa_<season>.json   QB and team EPA per game (partial coverage, research only)
     football/starters/{cfb,nfl}_<season>.json  projected starter, competition, experience
     football/coaching/continuity.json       head-coach continuity (coordinators unknown)
     football/players/team_talent.json       recruiting composite (research)
     football/availability/current.json      college availability states
     football/injuries/nfl_<season>.json     the official NFL report
     football/data/box/<season>.json         season hurries (pressure short of a sack), ST counts
     football/matchup/profiles_<season>.json play profile with the garbage-time-free view
     football/nfl/slate.json                 NFL engine ratings and ranks
     football/nfl/.cache/...stats_team_week  NFL per-team-week rows (per-game trend, raw rates)
     football/data/cache/nfl_depth_<season>.csv   the depth chart, when the starters build cached it

   Usage
     node tools/football/build_team_identity.js            # writes the artifact
     node tools/football/build_team_identity.js --check    # builds, compares, writes nothing
     node tools/football/build_team_identity.js --season 2026
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'football', 'identity', 'index.json');
const OUT_DIR = path.join(ROOT, 'football', 'identity', 'teams');
const SCHEMA = 'edgedesk_team_identity_v1';
let R = null; try { R = require(path.join(ROOT, 'football', 'data', 'recovery.js')); } catch (_) { R = null; }

function readJson(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return { ok: false, path: rel, error: 'file not present', data: null };
  try { return { ok: true, path: rel, error: null, data: JSON.parse(fs.readFileSync(p, 'utf8')) }; }
  catch (e) { return { ok: false, path: rel, error: String(e.message).slice(0, 120), data: null }; }
}
function readText(rel) { const p = path.join(ROOT, rel); return fs.existsSync(p) ? { ok: true, text: fs.readFileSync(p, 'utf8'), mtime: new Date(fs.statSync(p).mtimeMs).toISOString() } : { ok: false, text: null, mtime: null }; }
function num(v) { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function r1(v) { const n = num(v); return n == null ? null : Math.round(n * 10) / 10; }
function r2(v) { const n = num(v); return n == null ? null : Math.round(n * 100) / 100; }
function r3(v) { const n = num(v); return n == null ? null : Math.round(n * 1000) / 1000; }
function r4(v) { const n = num(v); return n == null ? null : Math.round(n * 10000) / 10000; }
function slug(s) { return String(s == null ? '' : s).toLowerCase().replace(/[’']/g, '').replace(/&/g, ' and ').replace(/\bst\.?\b/g, 'state').replace(/[^a-z0-9]+/g, ''); }
function mean(a) { const v = a.filter((x) => num(x) != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; }
function sd(a) { const v = a.filter((x) => num(x) != null); if (v.length < 3) return null; const m = mean(v); return Math.sqrt(v.reduce((s, x) => s + (x - m) * (x - m), 0) / (v.length - 1)); }
function maxIso(list) { return list.filter(Boolean).sort().slice(-1)[0] || null; }

/* ------------------------------------------------------------------ rules */
/* Inference rules: each derives ONE label from measured inputs by a stated
   test. The rule text is published with the inference so a reader can check
   it, and the confidence is the smaller of the inputs' reliabilities. */
function infer(id, label, rule, inputs, confidence, favours) { return { id, label, rule, inputs, confidence: r2(confidence), favours: favours || null }; }
function zOf(units, id) { const u = units[id]; return u && num(u.z) != null ? u.z : null; }
function relOf(units, id) { const u = units[id]; return u && num(u.reliability) != null ? u.reliability : 0.5; }
function inferencesFor(t, leagueMeans) {
  const out = [], U = t.measured.units || {}, P = t.measured.profile || {}, L = leagueMeans || {};
  const pr = num(P.pass_rate);
  if (pr != null && L.pass_rate != null) {
    if (pr >= L.pass_rate + 0.06) out.push(infer('scheme_pass_heavy', 'pass-heavy offence', 'pass_rate >= league mean + 0.06', { pass_rate: r3(pr), league: r3(L.pass_rate) }, 0.9, 'offence'));
    else if (pr <= L.pass_rate - 0.06) out.push(infer('scheme_run_heavy', 'run-heavy offence', 'pass_rate <= league mean - 0.06', { pass_rate: r3(pr), league: r3(L.pass_rate) }, 0.9, 'offence'));
    else out.push(infer('scheme_balanced', 'balanced run/pass mix', 'pass_rate within 0.06 of the league mean', { pass_rate: r3(pr), league: r3(L.pass_rate) }, 0.9, null));
  }
  const ppg = num(P.plays_per_game);
  if (ppg != null && L.plays_per_game != null) {
    if (ppg >= L.plays_per_game + 5) out.push(infer('tempo_fast', 'fast tempo (play-count proxy)', 'plays_per_game >= league mean + 5; a play count, not seconds per play', { plays_per_game: r1(ppg), league: r1(L.plays_per_game) }, 0.7, 'offence'));
    else if (ppg <= L.plays_per_game - 5) out.push(infer('tempo_slow', 'slow tempo (play-count proxy)', 'plays_per_game <= league mean - 5', { plays_per_game: r1(ppg), league: r1(L.plays_per_game) }, 0.7, 'offence'));
  }
  const ex = zOf(U, 'explosive_pass_rate'), su = zOf(U, 'success_rate');
  if (ex != null && su != null && ex >= 1 && su < 0) out.push(infer('explosive_dependent', 'explosive-dependent passing game', 'explosive_pass_rate z >= 1 and success_rate z < 0: big plays without staying on schedule', { explosive_pass_z: r2(ex), success_z: r2(su) }, Math.min(relOf(U, 'explosive_pass_rate'), relOf(U, 'success_rate')), 'offence'));
  if (ex != null && su != null && su >= 0.8 && ex < 0) out.push(infer('methodical', 'methodical offence: on schedule, few explosives', 'success_rate z >= 0.8 and explosive_pass_rate z < 0', { explosive_pass_z: r2(ex), success_z: r2(su) }, Math.min(relOf(U, 'explosive_pass_rate'), relOf(U, 'success_rate')), 'offence'));
  const sa = zOf(U, 'sack_rate_allowed');
  if (sa != null && sa <= -0.8) out.push(infer('protection_weak', 'protection is a weakness', 'sack_rate_allowed z <= -0.8 (z is direction-corrected: lower sacks allowed is better)', { sack_rate_allowed_z: r2(sa), adjusted: r4(U.sack_rate_allowed.adjusted), league: r4(U.sack_rate_allowed.league) }, relOf(U, 'sack_rate_allowed'), 'defence of the opponent'));
  if (sa != null && sa >= 0.8) out.push(infer('protection_strong', 'protection is a strength', 'sack_rate_allowed z >= 0.8', { sack_rate_allowed_z: r2(sa), adjusted: r4(U.sack_rate_allowed.adjusted), league: r4(U.sack_rate_allowed.league) }, relOf(U, 'sack_rate_allowed'), 'offence'));
  const ds = zOf(U, 'def_sack_rate');
  if (ds != null && ds >= 0.8) out.push(infer('pass_rush_strong', 'the pass rush gets home', 'def_sack_rate z >= 0.8', { def_sack_rate_z: r2(ds), adjusted: r4(U.def_sack_rate.adjusted), league: r4(U.def_sack_rate.league) }, relOf(U, 'def_sack_rate'), 'defence'));
  if (ds != null && ds <= -0.8) out.push(infer('pass_rush_weak', 'the pass rush does not get home', 'def_sack_rate z <= -0.8', { def_sack_rate_z: r2(ds) }, relOf(U, 'def_sack_rate'), 'offence of the opponent'));
  const st = zOf(U, 'def_stuff_rate'), dr = zOf(U, 'def_yards_per_rush');
  if (st != null && dr != null && st >= 0.8 && dr >= 0.5) out.push(infer('run_front_strong', 'the front stops the run', 'def_stuff_rate z >= 0.8 and def_yards_per_rush z >= 0.5', { def_stuff_z: r2(st), def_ypc_z: r2(dr) }, Math.min(relOf(U, 'def_stuff_rate'), relOf(U, 'def_yards_per_rush')), 'defence'));
  const dep = zOf(U, 'def_explosive_pass_allowed');
  if (dep != null && dep <= -0.8) out.push(infer('coverage_leaky_proxy', 'gives up explosive passes (a proxy: coverage is not measured)', 'def_explosive_pass_allowed z <= -0.8', { def_explosive_pass_allowed_z: r2(dep) }, relOf(U, 'def_explosive_pass_allowed'), 'offence of the opponent'));
  const rz = zOf(U, 'rz_success');
  if (rz != null && rz <= -0.8) out.push(infer('finishing_problem', 'moves the ball better than it finishes', 'rz_success z <= -0.8', { rz_success_z: r2(rz) }, relOf(U, 'rz_success'), 'defence of the opponent'));
  const ol = t.measured.ol_continuity;
  if (ol && num(ol.continuity) != null) { if (ol.continuity < 0.4) out.push(infer('ol_new', 'a mostly new offensive line', 'OL roster continuity < 0.40 (share of last season\u2019s group still on the roster; games-started-together is not measured)', { continuity: r3(ol.continuity), experience: r3(ol.experience) }, 0.6, 'defence of the opponent')); else if (ol.continuity >= 0.7) out.push(infer('ol_intact', 'an intact offensive line', 'OL roster continuity >= 0.70', { continuity: r3(ol.continuity), experience: r3(ol.experience) }, 0.6, 'offence')); }
  const co = t.measured.continuity;
  if (co && num(co.rating) != null && co.rating < 35) out.push(infer('roster_turnover_heavy', 'heavy roster turnover', 'continuity rating < 35 (value_continuity, qb_continuity, ol_continuity, starts_continuity, transfer_churn)', { continuity_rating: r1(co.rating) }, 0.7, null));
  const q = t.measured.quarterback;
  if (q && q.competition && q.competition.contested) out.push(infer('qb_contested', 'the quarterback job is contested', 'starter build marks the competition contested (dropback share split)', { players: (q.competition.players || []).slice(0, 2).map((x) => x.player_name + ' ' + Math.round((x.share || 0) * 100) + '%') }, 0.7, null));
  const smp = t.measured.sample;
  if (smp && num(smp.games) != null && smp.games < 4) out.push(infer('small_sample', 'small sample: ' + smp.games + ' game' + (smp.games === 1 ? '' : 's'), 'games < 4; every measured rate is a hypothesis to test', { games: smp.games, garbage_share: r3(smp.garbage_share) }, 1, null));
  return out;
}

/* ------------------------------------------------------------- FBS build */
function fbsTeams(inputs, season) {
  const { R: RK, H, PL, EPA, SC, C, TT, AV, BOX, PR, VEN } = inputs;
  const out = {};
  const rankTeams = RK.data && RK.data.teams ? (Array.isArray(RK.data.teams) ? RK.data.teams : Object.values(RK.data.teams)) : [];
  const profiles = {};
  const pl = PR.data && (PR.data.profiles || PR.data.teams) ? (Array.isArray(PR.data.profiles || PR.data.teams) ? PR.data.profiles || PR.data.teams : Object.values(PR.data.profiles || PR.data.teams)) : [];
  pl.forEach((p) => { profiles[p.key || slug(p.team)] = p; });
  /* league means from the profiles, for the scheme rules */
  const LM = { pass_rate: mean(pl.map((p) => p.all_plays && p.all_plays.pass_rate)), plays_per_game: mean(pl.map((p) => p.all_plays && p.all_plays.plays_per_game)) };
  const asOf = RK.data && (RK.data.data_as_of || RK.data.generated_at) || null;
  for (const t of rankTeams) {
    const key = t.key || slug(t.team);
    const perf = t.performance || {};
    const units = {};
    const take = (d, side) => (d && d.used ? d.used : []).forEach((u) => { units[u.id] = { raw: r4(u.raw), adjusted: r4(u.adjusted), delta: r4(u.delta), league: r4(u.league), z: r4(u.z), n: r1(u.n), n_obs: u.n_obs == null ? null : Number(u.n_obs), reliability: r3(u.reliability), w: r4(u.w), side, source: 'football/rankings/current.json', as_of: asOf }; });
    take(perf.offense_detail, 'offense'); take(perf.defense_detail, 'defense');
    const missingUnits = [].concat((perf.offense_detail && perf.offense_detail.missing) || [], (perf.defense_detail && perf.defense_detail.missing) || []).map((m) => (typeof m === 'string' ? m : m && m.id ? m.id + (m.n_obs != null ? ' (n_obs ' + m.n_obs + ' < floor ' + m.floor + ')' : '') : String(m))).slice(0, 12);
    const p = profiles[key] || null, a = p ? p.all_plays || {} : {}, x = p ? p.excluding_garbage_time || {} : {}, al = p ? p.allowed || {} : {};
    const profile = p ? { games: num(p.games), points_for_per_game: p.scoring ? r2(p.scoring.points_for_per_game) : null, points_against_per_game: p.scoring ? r2(p.scoring.points_against_per_game) : null,
      plays_per_game: r2(a.plays_per_game), drives_per_game: r2(a.drives_per_game), pass_rate: r4(a.pass_rate), yards_per_rush: r2(a.yards_per_rush), explosive_pass_rate: r4(a.explosive_pass_rate), explosive_rush_rate: r4(a.explosive_rush_rate), sack_taken_rate: r4(a.sack_taken_rate), third_down_rate: r4(a.third_down_rate), red_zone_trips: num(a.red_zone_trips), red_zone_td_rate: r4(a.red_zone_td_rate), giveaways: num(a.giveaways), takeaways: num(a.takeaways), avg_drive_start_ytg: r1(a.avg_drive_start_ytg),
      excluding_garbage_time: { plays_per_game: r2(x.plays_per_game), pass_rate: r4(x.pass_rate), explosive_pass_rate: r4(x.explosive_pass_rate), explosive_rush_rate: r4(x.explosive_rush_rate), sack_taken_rate: r4(x.sack_taken_rate) },
      allowed: { explosive_pass_rate: r4(al.explosive_pass_rate), explosive_rush_rate: r4(al.explosive_rush_rate), sack_rate: r4(al.sack_rate != null ? al.sack_rate : al.sacks_made_rate), yards_per_rush: r2(al.yards_per_rush) },
      column_gaps: p.team_column_gaps || [], basis: 'raw play counts from the play feed; not opponent-adjusted', source: 'football/matchup/profiles_' + season + '.json', as_of: PR.data.generated_at || null } : null;
    const sch = PL.data && PL.data.scheme ? PL.data.scheme[key] : null;
    const rating = { etsr: r2(t.etsr), rank: t.rank == null ? null : Number(t.rank), confidence: t.confidence ? r3(t.confidence.value) : null, games_used: t.weights ? r2(t.weights.games_used) : null, gates: (t.gates || []).map((g) => g.id).slice(0, 8),
      offense_rating: perf.offense && perf.offense.rating != null ? r2(perf.offense.rating) : (typeof perf.offense === 'number' ? r2(perf.offense) : null), defense_rating: perf.defense && perf.defense.rating != null ? r2(perf.defense.rating) : (typeof perf.defense === 'number' ? r2(perf.defense) : null),
      special_teams: t.special_teams ? { z: r4(t.special_teams.z), rating: r2(t.special_teams.rating), available: !!t.special_teams.available, coverage: r4(t.special_teams.coverage) } : null,
      depth: t.depth ? r2(t.depth.rating) : null, source: 'football/rankings/current.json', as_of: asOf,
      basis: 'ETSR is a neutral-field rating in points against the league mean; home field, rest and availability are not in it.' };
    const teamFile = readJson('football/players/teams/' + key + '.json');
    const qbGroup = teamFile.data && teamFile.data.units && teamFile.data.units.groups ? teamFile.data.units.groups.QB : null;
    const olGroup = teamFile.data && teamFile.data.units && teamFile.data.units.groups ? teamFile.data.units.groups.OL : null;
    const olRet = teamFile.data && teamFile.data.units && teamFile.data.units.returning && teamFile.data.units.returning.by_group ? teamFile.data.units.returning.by_group.OL : null;
    const st = SC.data && SC.data.teams ? SC.data.teams[key] : null;
    const proj = qbGroup && Array.isArray(qbGroup.projected) ? qbGroup.projected : [];
    const backup = proj.filter((r) => r.slot === 2)[0] || null;
    const epaTeam = EPA.data && EPA.data.teams ? EPA.data.teams[key] : null;
    const epaPlayer = st && st.player_id && EPA.data && EPA.data.players ? EPA.data.players[String(st.player_id)] : null;
    const qbEpa = epaPlayer ? (() => {
      const log = (epaPlayer.season_log || []).filter((g) => g.epa_state === 'MEASURED');
      const sum = (arr, f) => arr.reduce((s, g) => s + (num(g[f]) || 0), 0);
      const season2 = log.length ? { games: log.length, dropbacks: sum(log, 'dropbacks'), epa_per_dropback: sum(log, 'dropbacks') ? r4(sum(log, 'epa') / sum(log, 'dropbacks')) : null, sack_rate: sum(log, 'dropbacks') ? r4(sum(log, 'sacks') / sum(log, 'dropbacks')) : null, interception_rate: sum(log, 'attempts') ? r4(sum(log, 'interceptions') / sum(log, 'attempts')) : null } : null;
      const pr2 = epaPlayer.prior || null;
      return { career: pr2 && num(pr2.dropbacks) ? { games: num(pr2.games), dropbacks: num(pr2.dropbacks), epa_per_dropback: r4(pr2.epa_per_dropback), sack_rate: r4(pr2.sack_rate), interception_rate: r4(pr2.interception_rate), through: pr2.observed_through || null } : null,
        season: season2, league_epa_per_dropback: EPA.data.league ? r4(EPA.data.league.epa_per_dropback) : null, source: 'football/fbs_epa/qb_epa_' + season + '.json', observed_through: EPA.data.observations_through || null, basis: 'cfbfastR-data play attribution; research context, not a priced input' };
    })() : null;
    const quarterback = { starter: st ? { name: st.player_name || null, id: st.player_id || null, status: st.status || null, confirmed: !!st.confirmed, announced: !!st.announced, basis: st.basis || null, source: st.source || null, published_at: st.published_at || null, retrieved_at: st.retrieved_at || null } : null,
      backup: backup ? { name: backup.name, id: String(backup.key || '').replace(/^a:/, '') || null, epir: r1(backup.epir), confidence: r2(backup.confidence), basis: 'slot 2 of the projected quarterback room in EdgeDesk\u2019s player build (a research rating, never a start announcement)', source: 'football/players/teams/' + key + '.json', as_of: teamFile.data ? teamFile.data.generated_at || null : null } : null,
      competition: st && st.competition ? { contested: !!st.competition.contested, games: num(st.competition.games), players: (st.competition.players || []).slice(0, 4).map((x) => ({ player_id: x.player_id, player_name: x.player_name, dropbacks: num(x.dropbacks), share: r3(x.share) })) } : null,
      experience: st && st.experience ? { starts: num(st.experience.starts), dropbacks: num(st.experience.dropbacks), seasons_observed: num(st.experience.seasons_observed) } : null,
      room_rating: st && st.room ? r1(st.room.rating) : (qbGroup ? r1(qbGroup.rating) : null), epa: qbEpa };
    const coach = C.data && C.data.by_team ? C.data.by_team[key] : null;
    const coaching = coach ? { hc: coach.hc || null, since_season: num(coach.since_season), tenure_seasons: num(coach.tenure_seasons), new_hc: !!coach.new_hc, previous_hc: coach.previous_hc || null, oc: null, dc: null, unknown: coach.unknown || ['oc', 'dc'], in_season_change: coach.in_season_change || null, source: 'football/coaching/continuity.json', as_of: C.data.generated_at || null } : null;
    const cont = t.continuity ? { rating: r2(t.continuity.rating), raw: r4(t.continuity.raw), components: (t.continuity.components || []).map((c) => ({ id: c.id, value: r4(c.value), w: r4(c.w) })), source: 'football/rankings/current.json', as_of: asOf } : null;
    const olc = olGroup ? { continuity: r3(olGroup.continuity), experience: r3(olGroup.experience), rating: r1(olGroup.rating), confidence: r2(olGroup.confidence), starters_returning: olRet ? olRet.starters_returning : null, count_returning: olRet ? r3(olRet.count_returning) : null, basis: 'roster-headcount share of last season\u2019s group still present; returning starts and games-started-together are NOT measured', source: 'football/players/teams/' + key + '.json', as_of: teamFile.data ? teamFile.data.generated_at || null : null } : (t.units && t.units.OL ? { continuity: r3(t.units.OL.continuity), experience: r3(t.units.OL.experience), rating: r1(t.units.OL.rating), confidence: r2(t.units.OL.confidence), basis: 'roster-headcount share; games-started-together is NOT measured', source: 'football/rankings/current.json', as_of: asOf } : null);
    const av = AV.data && AV.data.teams ? (Array.isArray(AV.data.teams) ? AV.data.teams.find((r) => slug(r.team_name) === key) : AV.data.teams[key]) : null;
    const availability = av ? { state: av.official_report_found ? 'OFFICIAL_REPORT' : (av.counts && av.counts.records ? 'PARTIAL' : 'UNKNOWN'), records: av.counts ? num(av.counts.records) : null, data_quality: av.dataQuality || null, sources_checked: num(av.sources_checked), sources_failed: num(av.sources_failed), players: (av.players || []).slice(0, 12).map((x) => ({ name: x.player_name, position: x.position, status: x.availability_status, source: x.source_name, published_at: x.source_published_at })), source: 'football/availability/current.json', as_of: AV.data.generated_at || null, note: 'UNKNOWN is not healthy' } : null;
    const box = BOX.data && BOX.data.teams ? BOX.data.teams[key] : null;
    const pressure = box ? { hurries: num(box.hurries), sacks: num(box.sacks), tfl: num(box.tfl), team_games: num(box.team_games), basis: 'season totals from the ESPN box (a count of pressures short of a sack; no rate, no per-game series)', gated: BOX.data.coverage && BOX.data.coverage.hurries ? !!BOX.data.coverage.hurries.usable : null, source: 'football/data/box/' + season + '.json', as_of: BOX.data.generated_at || null } : null;
    const tal = TT.data && TT.data.teams ? TT.data.teams[key] : null;
    const talent = { rating: t.talent ? r1(t.talent.rating) : null, components: t.talent ? (t.talent.components || []).map((c) => ({ id: c.id, value: r2(c.value), w: r4(c.w) })) : [], returning: t.talent && t.talent.returning ? { value_continuity: r3(t.talent.returning.value_continuity), roster_continuity: r3(t.talent.returning.roster_continuity) } : null, transfers: t.talent && t.talent.transfers ? { index: r3(t.talent.transfers.index), net_value: r2(t.talent.transfers.net_value), in: num(t.talent.transfers.in), out: num(t.talent.transfers.out), starters_in: num(t.talent.transfers.starters_in), starters_out: num(t.talent.transfers.starters_out) } : null, recruiting: tal ? { composite: r1(tal.talent_composite), rank: num(tal.talent_rank), blue_chip_ratio: r3(tal.blue_chip_ratio), source: 'football/players/team_talent.json', as_of: TT.data.generated_at || null, note: 'research; moves nothing' } : null, source: 'football/rankings/current.json', as_of: asOf };
    const sample = perf.sample ? { games: num(perf.sample.games), fbs_games: num(perf.sample.fbs_games), plays: num(perf.sample.plays), competitive_plays: num(perf.sample.competitive_plays), garbage_share: r3(perf.sample.garbage_share), distinct_opponents: num(perf.sample.distinct_opponents), non_fbs_share: r3(perf.sample.non_fbs_share), opponent_delta: r4(perf.opponent_delta), note: 'strength of schedule is not measured as a number in EdgeDesk\u2019s data; opponent_delta is the net opponent adjustment and the schedule below lists each opponent' } : null;
    /* home venue geography, so a forecast can be fetched for a game the venue build did not cover */
    const ven = (() => { const d = VEN.data && VEN.data.describe ? VEN.data.describe[key] : null; if (!d || d.venue_id == null || !VEN.data.venues) return null; const v = Object.values(VEN.data.venues).find((x) => x && x.venue_id === d.venue_id) || null; return v ? { name: v.name || d.name || null, city: v.city || d.city || null, lat: r4(v.lat), lon: r4(v.lon), tz_name: v.tz_name || d.tz_name || null, dome: !!v.dome, grass: v.grass == null ? null : !!v.grass, elev_m: r1(v.elev), source: 'football/venues/resolved.json', as_of: VEN.data.generated_at || null } : null; })();
    const schedule = { games_played: p && p.opponents ? p.opponents.length : null, opponents: p && p.opponents ? p.opponents.map((g) => ({ game_id: g.game_id, opponent: g.opponent, points_for: num(g.points_for), points_against: num(g.points_against), margin: num(g.points_for) != null && num(g.points_against) != null ? num(g.points_for) - num(g.points_against) : null })) : [], source: 'football/matchup/profiles_' + season + '.json' };
    /* the within-season trend: the weekly rating series and the per-game EPA log */
    const hist = H.data && H.data.teams ? H.data.teams[key] : null;
    const hrows = Array.isArray(hist) ? hist.map((r) => ({ week: num(r.week), label: r.week_label, generated_at: r.generated_at, etsr: r2(r.etsr), rank: num(r.rank), confidence: r3(r.confidence), offense: r.categories && r.categories.offense ? r2(r.categories.offense.value) : null, defense: r.categories && r.categories.defense ? r2(r.categories.defense.value) : null, pass_offense: r.categories && r.categories.pass_offense ? r2(r.categories.pass_offense.value) : null, run_defense: r.categories && r.categories.run_defense ? r2(r.categories.run_defense.value) : null })) : [];
    const gameRows = epaTeam && Array.isArray(epaTeam.offence_log) ? epaTeam.offence_log.map((g) => ({ game_id: g.game_id, kickoff: g.kickoff, opponent: g.opponent_key, off_epa_per_play: r3(g.off_epa_per_play), pass_epa_per_play: r3(g.pass_epa_per_play), rush_epa_per_play: r3(g.rush_epa_per_play), plays: num(g.plays), pass_rate: r3(g.pass_rate) })) : [];
    const first = hrows[0], last = hrows[hrows.length - 1];
    const trend = { basis: 'weekly rating snapshots (football/rankings/history.json) and the per-game team EPA log (football/fbs_epa, partial coverage)', weeks: hrows, games: gameRows,
      early_vs_recent: first && last && hrows.length >= 2 ? { from_week: first.label, to_week: last.label, etsr_delta: r2(last.etsr - first.etsr), rank_delta: last.rank != null && first.rank != null ? last.rank - first.rank : null, offense_delta: last.offense != null && first.offense != null ? r2(last.offense - first.offense) : null, defense_delta: last.defense != null && first.defense != null ? r2(last.defense - first.defense) : null,
        summary: 'rating ' + (last.etsr - first.etsr >= 0 ? 'up ' : 'down ') + Math.abs(r2(last.etsr - first.etsr)) + ' points from ' + first.label + ' to ' + last.label + ' (rank ' + first.rank + ' \u2192 ' + last.rank + ')' + (last.offense != null && first.offense != null ? '; offence ' + (last.offense - first.offense >= 0 ? '+' : '') + r1(last.offense - first.offense) : '') + (last.defense != null && first.defense != null ? ', defence ' + (last.defense - first.defense >= 0 ? '+' : '') + r1(last.defense - first.defense) : '') + '. ' + (hrows.length < 4 ? 'Over ' + hrows.length + ' snapshots this is a hypothesis, not a trend.' : ''), sample_snapshots: hrows.length } : null,
      source: 'football/rankings/history.json', as_of: H.data ? H.data.generated_at || null : null };
    const qual = [];
    if (coach && coach.new_hc) qual.push({ claim: 'new head coach ' + coach.hc + ' (previous: ' + (coach.previous_hc || 'unknown') + ')', kind: 'sourced', source: 'football/coaching/continuity.json (cfbfastR coach feed)', published_at: C.data.generated_at || null });
    if (coach && coach.in_season_change) qual.push({ claim: 'in-season head-coach change: ' + JSON.stringify(coach.in_season_change).slice(0, 120), kind: 'sourced', source: 'football/coaching/continuity.json', published_at: C.data.generated_at || null });
    if (st && st.player_name) qual.push({ claim: 'projected starting quarterback ' + st.player_name + ' \u2014 ' + String(st.status || '').toLowerCase().replace(/_/g, ' ') + (st.confirmed ? ', confirmed' : ', not confirmed') + (st.basis ? ' (' + st.basis + ')' : ''), kind: 'sourced', source: st.source || 'football/starters', published_at: st.published_at || null });
    if (sch && sch.labels) qual.push({ claim: 'player-build scheme read: pace ' + sch.labels.pace + ', identity ' + sch.labels.identity + (sch.labels.front && sch.labels.front.label && sch.labels.front.label !== 'UNKNOWN' ? ', front ' + sch.labels.front.label + (sch.labels.front.guess ? ' (a guess from roster spellings)' : '') : ''), kind: 'derived-by-another-build', source: 'football/players/current.json (two-season blend, \u03bb ' + (sch.blend ? sch.blend.lambda : '?') + ')', published_at: PL.data.generated_at || null });
    (t.gates || []).slice(0, 3).forEach((g) => qual.push({ claim: 'rating gate ' + g.id + ': ' + (g.detail || g.basis || ''), kind: 'sourced', source: 'football/rankings/current.json', published_at: asOf }));
    const rec = { key, team: t.team, league: 'FBS', conference: t.conference || null, season, effective_from: season + '-08-01', effective_to: null,
      verified_at: maxIso([asOf, PR.data && PR.data.generated_at, SC.data && SC.data.generated_at, C.data && C.data.generated_at]),
      sources: ['football/rankings/current.json', 'football/matchup/profiles_' + season + '.json', 'football/starters/cfb_' + season + '.json', 'football/players/teams/' + key + '.json', 'football/coaching/continuity.json'],
      measured: { sample, units, missing_units: missingUnits, profile, rating, quarterback, coaching, ol_continuity: olc, continuity: cont, pressure, availability, talent, schedule, home_venue: ven,
        scheme_tendencies: sch ? { offense: sch.offense || null, defense: sch.defense || null, confidence: r2(sch.confidence), blend: sch.blend || null, source: 'football/players/current.json', as_of: PL.data.generated_at || null, basis: 'two-season blended tendencies from attributed plays; v is the rate, z against the league, n the blended play count' } : null },
      qualitative: qual, inferences: [], trend,
      not_measured: ['coordinators (OC/DC) and their tendencies', 'personnel groupings, concepts, coverage shells, blitz rate, box counts', 'seconds per play (tempo is a play count)', 'snap counts and rotation', 'pressure rate (hurries are a season count)', 'individual offensive-line attribution and games-started-together', 'strength of schedule as a number', 'injuries beyond what the availability layer found (' + (availability ? availability.state : 'not read') + ')'] };
    rec.inferences = inferencesFor(rec, LM);
    out[key] = rec;
  }
  return { teams: out, league_means: LM };
}

/* ------------------------------------------------------------- NFL build */
const NFL_UNITS = ['off_epa_play', 'pass_epa_db', 'rush_epa_att', 'expl_pass', 'expl_rush', 'sack_rate_all', 'pass_rate', 'plays', 'def_epa_play', 'def_pass_epa_db', 'def_rush_epa_att', 'def_expl_pass', 'def_expl_rush', 'sack_rate_made', 'def_qb_hit_rate', 'pts_for', 'pts_against'];
const NFL_LOWER_BETTER = { sack_rate_all: true, def_epa_play: true, def_pass_epa_db: true, def_rush_epa_att: true, def_expl_pass: true, def_expl_rush: true, pts_against: true };
function nflTeams(inputs, season) {
  const { N, SN, INJ, TW, DEPTH } = inputs;
  const out = {};
  const names = {};
  if (N.data && N.data.teams) Object.keys(N.data.teams).forEach((c) => { names[c] = N.data.teams[c].team || c; });
  /* per team-week rows, then per game with the opponent's row for the defensive side */
  const rows = TW.text && R ? R.parseCsv(TW.text, { columns: ['season', 'week', 'team', 'season_type', 'game_id', 'opponent_team', 'attempts', 'sacks_suffered', 'passing_epa', 'passing_20', 'carries', 'rushing_epa', 'rushing_10', 'def_sacks', 'def_qb_hits', 'passing_interceptions', 'sack_fumbles_lost', 'rushing_fumbles_lost', 'receiving_fumbles_lost'] }) : [];
  const byGame = {};
  rows.forEach((r) => { if (num(r.season) !== season) return; (byGame[r.game_id] = byGame[r.game_id] || []).push(r); });
  const games = {};
  const n = (v) => { const x = num(v); return x == null ? NaN : x; };
  Object.keys(byGame).forEach((gid) => {
    const pair = byGame[gid]; if (pair.length !== 2) return;
    pair.forEach((r) => {
      const o = pair.find((x) => x !== r);
      const att = n(r.attempts), car = n(r.carries), sk = n(r.sacks_suffered), db = att + sk, plays = att + car + sk;
      const oatt = n(o.attempts), ocar = n(o.carries), osk = n(o.sacks_suffered), odb = oatt + osk, oplays = oatt + ocar + osk;
      const g = { week: num(r.week), game_id: gid, opponent: r.opponent_team || o.team, plays, dropbacks: db, opp_plays: oplays, opp_dropbacks: odb,
        off_epa_play: plays ? (n(r.passing_epa) + n(r.rushing_epa)) / plays : NaN, pass_epa_db: db ? n(r.passing_epa) / db : NaN, rush_epa_att: car ? n(r.rushing_epa) / car : NaN,
        expl_pass: att ? n(r.passing_20) / att : NaN, expl_rush: car ? n(r.rushing_10) / car : NaN, sack_rate_all: db ? sk / db : NaN, pass_rate: plays ? db / plays : NaN,
        def_epa_play: oplays ? (n(o.passing_epa) + n(o.rushing_epa)) / oplays : NaN, def_pass_epa_db: odb ? n(o.passing_epa) / odb : NaN, def_rush_epa_att: ocar ? n(o.rushing_epa) / ocar : NaN,
        def_expl_pass: oatt ? n(o.passing_20) / oatt : NaN, def_expl_rush: ocar ? n(o.rushing_10) / ocar : NaN, sack_rate_made: odb ? n(r.def_sacks) / odb : NaN, def_qb_hit_rate: odb ? n(r.def_qb_hits) / odb : NaN,
        giveaways: (n(r.passing_interceptions) || 0) + (n(r.sack_fumbles_lost) || 0) + (n(r.rushing_fumbles_lost) || 0) + (n(r.receiving_fumbles_lost) || 0) };
      (games[r.team] = games[r.team] || []).push(g);
    });
  });
  /* season rates per club (sum of counts, not mean of rates) and league means */
  const seasonRates = {};
  Object.keys(games).forEach((code) => {
    const gs = games[code].sort((a, b) => a.week - b.week);
    const S = {}; NFL_UNITS.forEach((u) => { S[u] = null; });
    const tot = (f) => gs.reduce((s, g) => s + (Number.isFinite(g[f]) ? g[f] * (f.indexOf('def_') === 0 || f === 'sack_rate_made' ? 1 : 1) : 0), 0);
    const plays = gs.reduce((s, g) => s + (g.plays || 0), 0), db = gs.reduce((s, g) => s + (g.dropbacks || 0), 0);
    const w = (f, wf) => { let num2 = 0, den = 0; gs.forEach((g) => { if (Number.isFinite(g[f]) && Number.isFinite(g[wf]) && g[wf] > 0) { num2 += g[f] * g[wf]; den += g[wf]; } }); return den ? num2 / den : null; };
    S.off_epa_play = w('off_epa_play', 'plays'); S.pass_epa_db = w('pass_epa_db', 'dropbacks'); S.rush_epa_att = w('rush_epa_att', 'plays'); S.expl_pass = w('expl_pass', 'dropbacks'); S.expl_rush = w('expl_rush', 'plays'); S.sack_rate_all = w('sack_rate_all', 'dropbacks'); S.pass_rate = w('pass_rate', 'plays'); S.plays = gs.length ? plays / gs.length : null;
    S.def_epa_play = w('def_epa_play', 'opp_plays'); S.def_pass_epa_db = w('def_pass_epa_db', 'opp_dropbacks'); S.def_rush_epa_att = w('def_rush_epa_att', 'opp_plays'); S.def_expl_pass = w('def_expl_pass', 'opp_dropbacks'); S.def_expl_rush = w('def_expl_rush', 'opp_plays'); S.sack_rate_made = w('sack_rate_made', 'opp_dropbacks'); S.def_qb_hit_rate = w('def_qb_hit_rate', 'opp_dropbacks');
    seasonRates[code] = { rates: S, games: gs.length, plays, dropbacks: db, giveaways: gs.reduce((s, g) => s + (g.giveaways || 0), 0) };
    void tot;
  });
  const LM = {}, SD = {};
  NFL_UNITS.forEach((u) => { const vals = Object.keys(seasonRates).map((c) => seasonRates[c].rates[u]); LM[u] = mean(vals); SD[u] = sd(vals); });
  const asOf = TW.mtime || (N.data && N.data.generated_at) || null;
  const codes = new Set(Object.keys(names).concat(Object.keys(seasonRates)));
  codes.forEach((code) => {
    const key = code.toLowerCase();
    const sr = seasonRates[code] || null;
    const units = {};
    if (sr) NFL_UNITS.forEach((u) => { const v = sr.rates[u]; if (v == null) return; const z = LM[u] != null && SD[u] ? (v - LM[u]) / SD[u] * (NFL_LOWER_BETTER[u] ? -1 : 1) : null; units[u] = { raw: r4(v), adjusted: null, league: r4(LM[u]), z: r4(z), n: u.indexOf('def_') === 0 || u === 'sack_rate_made' ? null : (u === 'pass_epa_db' || u === 'expl_pass' || u === 'sack_rate_all' ? sr.dropbacks : sr.plays), reliability: sr.games ? r3(Math.min(1, sr.games / 8)) : null, side: u.indexOf('def_') === 0 || u === 'sack_rate_made' ? 'defense' : 'offense', source: 'nflverse stats_team_week_' + season + '.csv (cached feed)', as_of: asOf, basis: 'raw season rate, NOT opponent-adjusted; z against the 32 clubs, direction-corrected' }; });
    const eng = N.data && N.data.teams ? N.data.teams[code] : null;
    const rating = eng ? { engine_ratings: eng.ratings || null, ranks: eng.ranks || null, source: 'football/nfl/slate.json (engine EWMA deviations from the league mean)', as_of: N.data.generated_at || null, basis: 'the engine\u2019s carried, opponent-offset state after this season\u2019s absorbed games; a deviation from the league mean, not a raw rate', etsr: null, rank: eng.ranks && eng.ranks.net_epa ? eng.ranks.net_epa.rank : null, confidence: null } : null;
    const st = SN.data && SN.data.teams ? SN.data.teams[key] : null;
    const depthQbs = DEPTH[code] || null;
    const backup = depthQbs && depthQbs[2] ? { name: depthQbs[2].player_name, id: depthQbs[2].gsis_id || null, basis: 'QB2 on the latest published depth chart', source: 'nflverse depth charts (cached by the starters build)', as_of: depthQbs[2].dt || null } : null;
    const quarterback = { starter: st ? { name: st.player_name || null, id: st.player_id || null, status: st.status || null, confirmed: !!st.confirmed, announced: !!st.announced, basis: st.basis || null, source: st.source || null, published_at: st.published_at || null, retrieved_at: st.retrieved_at || null } : null,
      backup, competition: st && st.competition ? { contested: !!st.competition.contested, games: num(st.competition.games), players: (st.competition.players || []).slice(0, 4).map((x) => ({ player_id: x.player_id, player_name: x.player_name, dropbacks: num(x.dropbacks), share: r3(x.share) })) } : null,
      experience: st && st.experience ? { starts: num(st.experience.starts), dropbacks: num(st.experience.dropbacks), seasons_observed: num(st.experience.seasons_observed) } : null, room_rating: null,
      epa: null, epa_note: 'per-quarterback EPA is not on file for the NFL in this build (the player-week feed is not cached); the club\u2019s passing EPA per dropback stands in' };
    const inj = INJ.data && INJ.data.teams ? INJ.data.teams[code] : null;
    const groups = { OL: [], DL: [], DB: [], LB: [], WR_TE: [], RB: [], QB: [], other: [] };
    const OLr = /^(OT|OG|C|G|T|OL|LT|RT|LG|RG)$/i, DLr = /^(DE|DT|NT|DL|EDGE)$/i, DBr = /^(CB|S|FS|SS|DB|NB)$/i, WRr = /^(WR|TE)$/i, RBr = /^(RB|FB|HB)$/i, LBr = /^(LB|ILB|MLB|OLB)$/i;
    (inj && inj.players ? inj.players : []).forEach((p) => { const pos = String(p.position || '').toUpperCase(), s2 = String(p.status || '').toUpperCase(); if (!/OUT|DOUBTFUL|QUESTIONABLE/.test(s2)) return; const e = { name: p.name, position: pos, status: p.status, practice: p.practice || null, injury: p.injury || null }; if (pos === 'QB') groups.QB.push(e); else if (OLr.test(pos)) groups.OL.push(e); else if (DLr.test(pos)) groups.DL.push(e); else if (DBr.test(pos)) groups.DB.push(e); else if (LBr.test(pos)) groups.LB.push(e); else if (WRr.test(pos)) groups.WR_TE.push(e); else if (RBr.test(pos)) groups.RB.push(e); else groups.other.push(e); });
    const cnt = (re) => (inj && inj.players ? inj.players : []).filter((p) => re.test(String(p.status || ''))).length;
    const availability = inj ? { state: 'OFFICIAL_REPORT', week: num(inj.week), out: num(inj.out) != null ? num(inj.out) : cnt(/^out$/i), doubtful: num(inj.doubtful) != null ? num(inj.doubtful) : cnt(/^doubtful$/i), questionable: num(inj.questionable) != null ? num(inj.questionable) : cnt(/^questionable$/i), by_position_group: groups, source: inj.source || 'nflverse injuries (official report)', as_of: inj.retrieved_at || INJ.data.retrieved_at || null, note: 'players not listed are not on the report, not healthy; replacement quality is not measured' } : null;
    const gs = games[code] ? games[code].slice().sort((a, b) => a.week - b.week) : [];
    const rankOf = (c) => { const t2 = N.data && N.data.teams ? N.data.teams[c] : null; return t2 && t2.ranks && t2.ranks.net_epa ? t2.ranks.net_epa.rank : null; };
    const played = (eng && Array.isArray(eng.results) ? eng.results : []).map((r) => ({ game_id: r.game_id, week: r.week, date: r.date, opponent: r.opponent, opponent_code: r.opponent_code, venue: r.venue, points_for: r.points_for, points_against: r.points_against, margin: r.margin, result: r.result, opponent_rank_now: rankOf(r.opponent_code), opponent_rank_basis: 'engine net-EPA rank of 32, as assessed NOW' }));
    const gameRows = gs.map((g) => ({ week: g.week, game_id: g.game_id, opponent: g.opponent, plays: g.plays, off_epa_play: r3(g.off_epa_play), pass_epa_db: r3(g.pass_epa_db), rush_epa_att: r3(g.rush_epa_att), def_epa_play: r3(g.def_epa_play), sack_rate_all: r3(g.sack_rate_all), sack_rate_made: r3(g.sack_rate_made), giveaways: g.giveaways }));
    const half = Math.floor(gs.length / 2);
    const early = gs.slice(0, half), recent = gs.slice(half);
    const evr = gs.length >= 3 ? (() => { const m1 = mean(early.map((g) => g.off_epa_play)), m2 = mean(recent.map((g) => g.off_epa_play)), d1 = mean(early.map((g) => g.def_epa_play)), d2 = mean(recent.map((g) => g.def_epa_play)); return { from: 'weeks ' + early[0].week + '-' + early[early.length - 1].week, to: 'weeks ' + recent[0].week + '-' + recent[recent.length - 1].week, off_epa_delta: r3(m2 - m1), def_epa_delta: r3(d2 - d1), summary: 'offence EPA/play ' + (m2 - m1 >= 0 ? 'up ' : 'down ') + Math.abs(r3(m2 - m1)) + ', defence EPA/play allowed ' + (d2 - d1 >= 0 ? 'up ' : 'down ') + Math.abs(r3(d2 - d1)) + ' from the first ' + early.length + ' game' + (early.length > 1 ? 's' : '') + ' to the last ' + recent.length + (gs.length < 6 ? '. A hypothesis at this sample.' : '.'), sample_games: gs.length }; })() : null;
    const profile = sr ? { games: sr.games, plays_per_game: r1(sr.rates.plays), pass_rate: r4(sr.rates.pass_rate), explosive_pass_rate: r4(sr.rates.expl_pass), explosive_rush_rate: r4(sr.rates.expl_rush), sack_taken_rate: r4(sr.rates.sack_rate_all), giveaways: sr.giveaways, takeaways: null, red_zone_td_rate: null, third_down_rate: null, excluding_garbage_time: null, allowed: { explosive_pass_rate: r4(sr.rates.def_expl_pass), explosive_rush_rate: r4(sr.rates.def_expl_rush), sack_rate: r4(sr.rates.sack_rate_made) }, basis: 'raw season rates from the team-week feed; no garbage-time split, no red-zone or third-down columns', source: 'nflverse stats_team_week_' + season + '.csv (cached feed)', as_of: asOf } : null;
    const rec = { key, code, team: names[code] || code, league: 'NFL', conference: null, season, effective_from: season + '-09-01', effective_to: null,
      verified_at: maxIso([asOf, N.data && N.data.generated_at, SN.data && SN.data.generated_at, INJ.data && INJ.data.retrieved_at]),
      sources: ['football/nfl/slate.json', 'nflverse stats_team_week_' + season + '.csv', 'football/starters/nfl_' + season + '.json', 'football/injuries/nfl_' + season + '.json'],
      measured: { sample: sr ? { games: sr.games, plays: sr.plays, dropbacks: sr.dropbacks, garbage_share: null, distinct_opponents: new Set(gs.map((g) => g.opponent)).size, note: 'no garbage-time split and no strength-of-schedule number for the NFL in EdgeDesk\u2019s data' } : null,
        units, missing_units: sr ? [] : ['no team-week rows for this club this season'], profile, rating, quarterback, coaching: null, coaching_note: 'coaching continuity is not on file for the NFL (the coach feed covers college only)', ol_continuity: null, ol_note: 'offensive-line continuity is not measured for the NFL', continuity: null, pressure: sr && num(sr.rates.def_qb_hit_rate) != null ? { qb_hit_rate: r4(sr.rates.def_qb_hit_rate), league: r4(LM.def_qb_hit_rate), basis: 'defensive QB hits per opponent dropback (nflverse def_qb_hits); pressures short of a hit are not measured', source: 'nflverse stats_team_week_' + season + '.csv', as_of: asOf } : null, availability, talent: null, schedule: { games_played: played.length || gs.length, opponents: played.length ? played : gs.map((g) => ({ game_id: g.game_id, week: g.week, opponent: g.opponent })), rank_basis: 'engine net-EPA rank of 32, as assessed now (not a rating at the time)', source: played.length ? 'football/nfl/slate.json (nflverse games.csv results)' : 'nflverse stats_team_week_' + season + '.csv' } },
      qualitative: [].concat(st && st.player_name ? [{ claim: 'projected starting quarterback ' + st.player_name + ' \u2014 ' + String(st.status || '').toLowerCase().replace(/_/g, ' ') + (st.confirmed ? ', confirmed' : ', not confirmed'), kind: 'sourced', source: st.source || 'football/starters', published_at: st.published_at || null }] : [], backup ? [{ claim: 'QB2 on the published depth chart: ' + backup.name, kind: 'sourced', source: backup.source, published_at: backup.as_of }] : [], inj && groups.OL.length ? [{ claim: groups.OL.length + ' offensive line' + (groups.OL.length > 1 ? 'men' : 'man') + ' on the injury report: ' + groups.OL.map((x) => x.name + ' (' + x.status + ')').join(', '), kind: 'sourced', source: inj.source || 'nflverse injuries', published_at: inj.retrieved_at || null }] : []),
      inferences: [], trend: { basis: 'per-game team rates from the team-week feed', weeks: [], games: gameRows, early_vs_recent: evr, source: 'nflverse stats_team_week_' + season + '.csv', as_of: asOf },
      not_measured: ['coaching and coordinators', 'offensive-line continuity', 'special teams', 'garbage-time split', 'red-zone and third-down rates', 'per-quarterback EPA', 'strength of schedule as a number', 'snap counts, personnel, coverage'] };
    /* NFL inference rules over the same vocabulary, mapped */
    const U2 = {}; Object.keys(units).forEach((u) => { U2[u] = units[u]; });
    const rec2 = { measured: { units: { explosive_pass_rate: U2.expl_pass, success_rate: U2.off_epa_play, sack_rate_allowed: U2.sack_rate_all, def_sack_rate: U2.sack_rate_made, def_explosive_pass_allowed: U2.def_expl_pass, def_stuff_rate: null, def_yards_per_rush: U2.def_rush_epa_att, rz_success: null }, profile, ol_continuity: null, continuity: null, quarterback, sample: rec.measured.sample } };
    Object.keys(rec2.measured.units).forEach((k) => { if (!rec2.measured.units[k]) delete rec2.measured.units[k]; });
    rec.inferences = inferencesFor(rec2, { pass_rate: LM.pass_rate, plays_per_game: LM.plays });
    out[key] = rec;
  });
  return { teams: out, league_means: LM };
}

/* ---------------------------------------------------------------- depth */
function depthChartQbs(season) {
  const out = {};
  try {
    const p = path.join(R ? R.CACHE_DIR : path.join(ROOT, 'football', 'data', 'cache'), 'nfl_depth_' + season + '.csv');
    if (!fs.existsSync(p) || !R) return out;
    const dc = R.parseCsv(fs.readFileSync(p, 'utf8'), { columns: ['dt', 'team', 'player_name', 'gsis_id', 'pos_abb', 'pos_rank'] });
    const latest = {};
    dc.forEach((d) => { if (String(d.pos_abb).toUpperCase() !== 'QB') return; if (!latest[d.team] || String(d.dt) > String(latest[d.team])) latest[d.team] = String(d.dt); });
    dc.forEach((d) => { if (String(d.pos_abb).toUpperCase() !== 'QB' || String(d.dt) !== latest[d.team]) return; const rk = num(d.pos_rank); if (rk == null) return; (out[d.team] = out[d.team] || {})[rk] = { player_name: d.player_name, gsis_id: d.gsis_id, dt: d.dt }; });
  } catch (_) { /* optional */ }
  return out;
}

/* ---------------------------------------------------------------- build */
function build(opts) {
  opts = opts || {};
  const RK = readJson('football/rankings/current.json');
  const season = opts.season || (RK.data && RK.data.season) || new Date().getUTCFullYear();
  const inputs = {
    R: RK, H: readJson('football/rankings/history.json'), PL: readJson('football/players/current.json'), EPA: readJson('football/fbs_epa/qb_epa_' + season + '.json'),
    SC: readJson('football/starters/cfb_' + season + '.json'), SN: readJson('football/starters/nfl_' + season + '.json'), C: readJson('football/coaching/continuity.json'),
    TT: readJson('football/players/team_talent.json'), AV: readJson('football/availability/current.json'), INJ: readJson('football/injuries/nfl_' + season + '.json'),
    BOX: readJson('football/data/box/' + season + '.json'), PR: readJson('football/matchup/profiles_' + season + '.json'), N: readJson('football/nfl/slate.json'), VEN: readJson('football/venues/resolved.json'),
    TW: readText('football/nfl/.cache/https_github.com_nflverse_nflverse_data_releases_download_stats_team_stats_team_week_' + season + '.csv'),
  };
  inputs.DEPTH = depthChartQbs(season);
  const sources = {};
  Object.keys(inputs).forEach((k) => { const v = inputs[k]; if (!v || k === 'DEPTH') return; sources[k] = v.path ? { path: v.path, ok: v.ok, error: v.error, generated_at: v.data && (v.data.generated_at || v.data.retrieved_at || v.data.data_as_of) || null } : { path: 'football/nfl/.cache/stats_team_week_' + season + '.csv', ok: !!v.ok, retrieved_at: v.mtime || null }; });
  sources.DEPTH = { path: 'football/data/cache/nfl_depth_' + season + '.csv', ok: Object.keys(inputs.DEPTH).length > 0, clubs: Object.keys(inputs.DEPTH).length };
  const fbs = RK.ok ? fbsTeams(inputs, season) : { teams: {}, league_means: {} };
  const nfl = nflTeams(inputs, season);
  const teams = Object.assign({}, fbs.teams, nfl.teams);
  const fbsN = Object.keys(fbs.teams).length, nflN = Object.keys(nfl.teams).length;
  return {
    schema: SCHEMA, version: 1, season, generated_at: new Date().toISOString(),
    note: 'One dated identity per team: measured statistics (copied with their sample and source), sourced qualitative observations, and analytical inferences derived by a stated rule. A previous season\u2019s identity never becomes this season\u2019s; the season is a field and the trend block is within-season only.',
    rules: { measured: 'copied from the named artifact; the only arithmetic is the NFL season rate (counts re-summed from the team-week rows) and the trend deltas', qualitative: 'a sourced statement with the feed and the date', inferences: 'a label from a stated test over measured inputs, with the inputs and a confidence', effective: 'effective_from is the season start; effective_to is null while the season is current; verified_at is the newest source read' },
    league_means: { fbs: fbs.league_means, nfl: nfl.league_means },
    sources, counts: { fbs: fbsN, nfl: nflN, fbs_with_units: Object.values(fbs.teams).filter((t) => Object.keys(t.measured.units).length).length, fbs_with_backup_qb: Object.values(fbs.teams).filter((t) => t.measured.quarterback && t.measured.quarterback.backup).length, nfl_with_units: Object.values(nfl.teams).filter((t) => Object.keys(t.measured.units).length).length, nfl_with_backup_qb: Object.values(nfl.teams).filter((t) => t.measured.quarterback && t.measured.quarterback.backup).length, nfl_with_report: Object.values(nfl.teams).filter((t) => t.measured.availability).length },
    teams,
  };
}

function stripTimes(a) { return JSON.stringify(a, (k, v) => (k === 'generated_at' ? undefined : v)); }

/** The compact index (one row per team) and one file per team. The edge
    function fetches two team files per game, never the whole set. */
function split(art) {
  const index = { schema: art.schema + '_index', version: art.version, season: art.season, generated_at: art.generated_at, note: art.note, rules: art.rules, league_means: art.league_means, sources: art.sources, counts: art.counts, teams: {} };
  const files = {};
  Object.keys(art.teams).forEach((k) => {
    const t = art.teams[k];
    index.teams[k] = { key: k, team: t.team, league: t.league, conference: t.conference, season: t.season, verified_at: t.verified_at, file: 'football/identity/teams/' + k + '.json', inferences: t.inferences.map((i) => i.label), units: Object.keys(t.measured.units).length, games: t.measured.sample ? t.measured.sample.games : null };
    files[k] = Object.assign({ schema: art.schema, generated_at: art.generated_at }, t);
  });
  return { index, files };
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const si = args.indexOf('--season');
  const art = build({ season: si >= 0 ? Number(args[si + 1]) : null });
  const { index, files } = split(art);
  const c = art.counts;
  const bytes = Object.keys(files).reduce((s, k) => s + JSON.stringify(files[k]).length, 0);
  console.log(`team identity: season ${art.season}, ${c.fbs} FBS teams (${c.fbs_with_units} with unit records, ${c.fbs_with_backup_qb} with a backup QB), ${c.nfl} NFL clubs (${c.nfl_with_units} with unit records, ${c.nfl_with_backup_qb} with a backup QB, ${c.nfl_with_report} with an injury report) \u2014 ${Object.keys(files).length} files, ${Math.round(bytes / 1024)} KB, largest ${Math.round(Math.max.apply(null, Object.keys(files).map((k) => JSON.stringify(files[k]).length)) / 1024)} KB`);
  Object.keys(art.sources).forEach((k) => { const s = art.sources[k]; if (s && s.ok === false) console.log(`  missing input: ${s.path} (${s.error || 'not present'})`); });
  if (check) {
    let prev = null; try { prev = fs.readFileSync(OUT, 'utf8'); } catch (_) { prev = null; }
    const same = prev != null && stripTimes(JSON.parse(prev)) === stripTimes(index);
    console.log(same ? 'CHECK: artifact is current' : 'CHECK: artifact differs from a fresh build');
    process.exit(same ? 0 : 1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  /* remove files for teams no longer built, so a renamed key does not leave a stale twin */
  fs.readdirSync(OUT_DIR).forEach((f) => { if (/\.json$/.test(f) && !files[f.replace(/\.json$/, '')]) fs.unlinkSync(path.join(OUT_DIR, f)); });
  Object.keys(files).forEach((k) => fs.writeFileSync(path.join(OUT_DIR, k + '.json'), JSON.stringify(files[k], null, 0) + '\n'));
  fs.writeFileSync(OUT, JSON.stringify(index, null, 1) + '\n');
  console.log('wrote football/identity/index.json and football/identity/teams/*.json');
}

module.exports = { build, split, inferencesFor, SCHEMA, OUT, OUT_DIR, NFL_UNITS };
if (require.main === module) main();
