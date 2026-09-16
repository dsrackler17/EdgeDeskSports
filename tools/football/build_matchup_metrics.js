#!/usr/bin/env node
/* ============================================================================
   THE MATCHUP METRICS ARTIFACT — football/matchup/metrics.json

   WHY. The edge function reads two artifacts (the FBS slate and the
   availability build) and never the rankings build, so every college packet
   declared per-play efficiency "not ingested" while the opponent-adjusted
   success, explosive, sack and stuff rates sat in football/rankings/current.json
   (5 MB, too large to fetch per request). This job writes the compact,
   per-team subset the research desk needs — the same metric records the
   browser's matchupDrivers() reads, plus the play profile, the projected
   starter, coaching continuity and (for the NFL) the official injury report —
   so one HTTP read gives the function what the board already shows.

   NOTHING IS COMPUTED HERE. Every number is copied from an artifact another
   job built, rounded, and stamped with that artifact's own generated_at.

   Inputs (all committed, all optional — a missing one is declared, never
   substituted):
     football/rankings/current.json        per-team metric detail (used[] records)
     football/matchup/profiles_2026.json   pace, pass rate, explosive and sack rates
     football/starters/cfb_2026.json       projected college starter QB
     football/starters/nfl_2026.json       projected NFL starter QB
     football/coaching/continuity.json     head-coach continuity
     football/injuries/nfl_<season>.json   the official NFL injury report

   Usage
     node tools/football/build_matchup_metrics.js            # writes the artifact
     node tools/football/build_matchup_metrics.js --check    # builds, compares, writes nothing
     node tools/football/build_matchup_metrics.js --season 2026
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'football', 'matchup', 'metrics.json');
const SCHEMA = 'edgedesk_matchup_metrics_v1';

function readJson(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return { ok: false, path: rel, error: 'file not present', data: null };
  try { return { ok: true, path: rel, error: null, data: JSON.parse(fs.readFileSync(p, 'utf8')) }; }
  catch (e) { return { ok: false, path: rel, error: String(e.message).slice(0, 120), data: null }; }
}
function r4(v) { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : null; }
function r2(v) { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; }
function slug(s) { return String(s == null ? '' : s).toLowerCase().replace(/[’']/g, '').replace(/&/g, ' and ').replace(/\bst\.?\b/g, 'state').replace(/[^a-z0-9]+/g, ''); }

/** One metric record, compacted to the fields detailIndex()/metricShow() read. */
function compactUsed(u) {
  return { id: u.id, raw: r4(u.raw), adjusted: r4(u.adjusted), delta: r4(u.delta), n: r2(u.n), n_obs: u.n_obs == null ? null : Number(u.n_obs), z: r4(u.z), w: r4(u.w), reliability: r4(u.reliability), league: r4(u.league) };
}
function compactDetail(d) {
  if (!d) return null;
  return { used: (d.used || []).map(compactUsed), missing: (d.missing || []).map((m) => (typeof m === 'string' ? m : m && m.id ? m.id : String(m))).slice(0, 12) };
}

function build(opts) {
  opts = opts || {};
  const season = opts.season || null;
  const R = readJson('football/rankings/current.json');
  const P = readJson('football/matchup/profiles_' + (season || (R.data && R.data.season) || new Date().getUTCFullYear()) + '.json');
  const SC = readJson('football/starters/cfb_' + (season || (R.data && R.data.season) || new Date().getUTCFullYear()) + '.json');
  const SN = readJson('football/starters/nfl_' + (season || (R.data && R.data.season) || new Date().getUTCFullYear()) + '.json');
  const C = readJson('football/coaching/continuity.json');
  const INJ = readJson('football/injuries/nfl_' + (season || (R.data && R.data.season) || new Date().getUTCFullYear()) + '.json');
  const seasonOut = season || (R.data && R.data.season) || null;

  const sources = {};
  for (const [k, v] of Object.entries({ rankings: R, profiles: P, starters_cfb: SC, starters_nfl: SN, coaching: C, nfl_injuries: INJ })) {
    sources[k] = { path: v.path, ok: v.ok, error: v.error, generated_at: v.data && (v.data.generated_at || v.data.retrieved_at || v.data.data_as_of) || null,
      week: v.data && (v.data.week != null ? v.data.week : v.data.latest_week != null ? v.data.latest_week : null), versions: v.data && v.data.versions || null };
  }

  const teams = {};
  const rankTeams = R.data && R.data.teams ? (Array.isArray(R.data.teams) ? R.data.teams : Object.values(R.data.teams)) : [];
  for (const t of rankTeams) {
    const key = t.key || slug(t.team);
    const perf = t.performance || {};
    teams[key] = {
      key, team: t.team, conference: t.conference || null, league: 'FBS',
      rating: {
        etsr: r2(t.etsr), rank: t.rank == null ? null : Number(t.rank), available: t.available !== false,
        confidence: t.confidence ? r4(t.confidence.value) : null,
        games_used: t.weights ? r2(t.weights.games_used) : null,
        performance_weight: t.weights ? r4(t.weights.performance) : null,
        gates: (t.gates || []).map((g) => g.id).slice(0, 8),
        net_z: r4(perf.net_z),
        offense_rating: perf.offense && perf.offense.rating != null ? r2(perf.offense.rating) : (typeof perf.offense === 'number' ? r2(perf.offense) : null),
        defense_rating: perf.defense && perf.defense.rating != null ? r2(perf.defense.rating) : (typeof perf.defense === 'number' ? r2(perf.defense) : null),
        source: 'football/rankings/current.json', as_of: R.data.data_as_of || R.data.generated_at || null,
      },
      performance: {
        offense_detail: compactDetail(perf.offense_detail), defense_detail: compactDetail(perf.defense_detail),
        sub_units: Object.fromEntries(Object.entries(perf.sub_units || {}).map(([k, v]) => [k, { z: r4(v.z), rating: r2(v.rating), used: (v.used || []).map(compactUsed) }])),
        sample: perf.sample || null, reliability: r4(perf.reliability),
      },
      special_teams: t.special_teams ? { z: r4(t.special_teams.z), rating: r2(t.special_teams.rating), available: !!t.special_teams.available, coverage: r4(t.special_teams.coverage) } : null,
      home_field: t.home_field ? { in_base_rating: !!t.home_field.in_base_rating, points: r2(t.home_field.points != null ? t.home_field.points : t.home_field.value) } : null,
      continuity: t.continuity ? { rating: r2(t.continuity.rating), raw: r4(t.continuity.raw), components: (t.continuity.components || []).map((c) => ({ id: c.id, value: r4(c.value), w: r4(c.w) })) } : null,
      depth: t.depth ? { rating: r2(t.depth.rating) } : null,
      availability_summary: t.availability ? { rating: t.availability.rating == null ? null : r2(t.availability.rating), out_share: r4(t.availability.out_share), unknown_share: r4(t.availability.unknown_share), records: t.availability.records == null ? null : Number(t.availability.records) } : null,
      profile: null, starter: null, coaching: null,
    };
  }
  /* play profiles */
  const profiles = P.data && (P.data.profiles || P.data.teams) ? (Array.isArray(P.data.profiles || P.data.teams) ? P.data.profiles || P.data.teams : Object.values(P.data.profiles || P.data.teams)) : [];
  for (const pr of profiles) {
    const key = pr.key || slug(pr.team);
    const a = pr.all_plays || {}, x = pr.excluding_garbage_time || {}, al = pr.allowed || {};
    const prof = {
      games: pr.games == null ? null : Number(pr.games),
      points_for_per_game: pr.scoring ? r2(pr.scoring.points_for_per_game) : null, points_against_per_game: pr.scoring ? r2(pr.scoring.points_against_per_game) : null,
      plays_per_game: r2(a.plays_per_game), drives_per_game: r2(a.drives_per_game), pass_rate: r4(a.pass_rate),
      yards_per_rush: r2(a.yards_per_rush), explosive_pass_rate: r4(a.explosive_pass_rate), explosive_rush_rate: r4(a.explosive_rush_rate),
      sack_taken_rate: r4(a.sack_taken_rate), third_down_rate: r4(a.third_down_rate), red_zone_td_rate: r4(a.red_zone_td_rate),
      giveaways: a.giveaways == null ? null : Number(a.giveaways), takeaways: a.takeaways == null ? null : Number(a.takeaways),
      excluding_garbage_time: { plays_per_game: r2(x.plays_per_game), pass_rate: r4(x.pass_rate), explosive_pass_rate: r4(x.explosive_pass_rate), explosive_rush_rate: r4(x.explosive_rush_rate), sack_taken_rate: r4(x.sack_taken_rate) },
      allowed: { explosive_pass_rate: r4(al.explosive_pass_rate), explosive_rush_rate: r4(al.explosive_rush_rate), sack_rate: r4(al.sack_rate != null ? al.sack_rate : al.sacks_made_rate), yards_per_rush: r2(al.yards_per_rush) },
      column_gaps: Object.keys(pr.team_column_gaps || {}).slice(0, 8),
      source: P.path, as_of: P.data.generated_at || null,
    };
    /* Only programmes the rankings build rates: the profile feed carries every
       team that appears in a play, FCS included, and a profile with no rating
       beside it is not something the desk can compare. */
    if (teams[key]) teams[key].profile = prof;
  }
  /* projected starters */
  const starterOf = (rec, src) => rec ? ({
    position: rec.position || 'QB', player_name: rec.player_name || null, player_id: rec.player_id || null,
    status: rec.status || 'UNKNOWN', announced: !!rec.announced, confirmed: !!rec.confirmed,
    availability: rec.availability ? { state: rec.availability.state || 'UNKNOWN', evidence: rec.availability.evidence || null, why: rec.availability.why || null } : null,
    basis: rec.basis || null, source: rec.source || src, published_at: rec.published_at || null, retrieved_at: rec.retrieved_at || null,
  }) : null;
  const cfbStarters = SC.data && SC.data.teams ? (Array.isArray(SC.data.teams) ? SC.data.teams : Object.values(SC.data.teams)) : [];
  for (const rec of cfbStarters) {
    const key = rec.team_id || slug(rec.team);
    if (teams[key]) teams[key].starter = starterOf(rec, SC.path);
  }
  /* coaching */
  const byTeam = C.data && C.data.by_team ? C.data.by_team : {};
  for (const [key, rec] of Object.entries(byTeam)) {
    if (!teams[key]) continue;
    teams[key].coaching = { hc: rec.hc || null, since_season: rec.since_season == null ? null : Number(rec.since_season), tenure_seasons: rec.tenure_seasons == null ? null : Number(rec.tenure_seasons),
      new_hc: rec.new_hc, new_oc: rec.new_oc, new_dc: rec.new_dc, known: rec.known || [], unknown: rec.unknown || [], in_season_change: rec.in_season_change, source: C.path, as_of: C.data.generated_at || null };
  }

  /* NFL: starters and the official injury report, keyed by club code */
  const nfl = { teams: {}, source_note: 'NFL ratings and projections are published in football/nfl/slate.json; this block carries the starter and the official injury report per club.' };
  const nflStarters = SN.data && SN.data.teams ? (Array.isArray(SN.data.teams) ? SN.data.teams : Object.entries(SN.data.teams).map(([k, v]) => Object.assign({ team_id: k }, v))) : [];
  for (const rec of nflStarters) {
    const code = String(rec.team || rec.team_id || '').toUpperCase();
    if (!code) continue;
    nfl.teams[code] = nfl.teams[code] || { code, starter: null, injuries: null };
    nfl.teams[code].starter = starterOf(rec, SN.path);
  }
  const injTeams = INJ.data && INJ.data.teams ? INJ.data.teams : {};
  for (const [code0, rec] of Object.entries(injTeams)) {
    const code = String(code0).toUpperCase();
    const players = (rec.players || []).map((p) => ({ name: p.name, position: p.position, status: p.status, injury: p.injury || null, practice: p.practice || null }));
    const count = (s) => players.filter((p) => String(p.status || '').toLowerCase() === s).length;
    nfl.teams[code] = nfl.teams[code] || { code, starter: null, injuries: null };
    nfl.teams[code].injuries = { week: rec.week == null ? null : Number(rec.week), game_type: rec.game_type || null, players, out: count('out'), doubtful: count('doubtful'), questionable: count('questionable'),
      source: INJ.data.source || INJ.path, published: !!INJ.data.published, retrieved_at: INJ.data.retrieved_at || null, official: true };
  }

  return {
    schema: SCHEMA, version: 1, season: seasonOut, generated_at: new Date().toISOString(),
    note: 'Compact, per-team copy of what other builds published. Nothing computed here. The metric records under performance.* are the ones EDINTEL.matchupDrivers() pairs; a z above zero is better FOR THAT UNIT on every metric.',
    sources, counts: { fbs_teams: Object.keys(teams).length, with_metrics: Object.values(teams).filter((t) => t.performance && t.performance.offense_detail && t.performance.offense_detail.used.length).length,
      with_profile: Object.values(teams).filter((t) => t.profile).length, with_starter: Object.values(teams).filter((t) => t.starter).length, with_coaching: Object.values(teams).filter((t) => t.coaching).length,
      nfl_clubs: Object.keys(nfl.teams).length, nfl_with_injuries: Object.values(nfl.teams).filter((t) => t.injuries).length },
    teams, nfl,
  };
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const si = args.indexOf('--season');
  const season = si >= 0 ? Number(args[si + 1]) : null;
  const art = build({ season });
  const text = JSON.stringify(art) + '\n';
  const kb = Math.round(text.length / 1024);
  console.log(`metrics: ${art.counts.fbs_teams} FBS teams (${art.counts.with_metrics} with metric detail, ${art.counts.with_profile} with a profile, ${art.counts.with_starter} with a starter, ${art.counts.with_coaching} with coaching), ${art.counts.nfl_clubs} NFL clubs (${art.counts.nfl_with_injuries} with an injury report) — ${kb} KB`);
  for (const [k, s] of Object.entries(art.sources)) if (!s.ok) console.log(`  source ${k}: ${s.error} (${s.path})`);
  if (check) {
    if (!fs.existsSync(OUT)) { console.log('CHECK: artifact not present'); process.exit(1); }
    const cur = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    const same = JSON.stringify(Object.assign({}, cur, { generated_at: null })) === JSON.stringify(Object.assign({}, art, { generated_at: null }));
    console.log(same ? 'CHECK: artifact is current' : 'CHECK: artifact differs from a fresh build');
    process.exit(same ? 0 : 1);
  }
  fs.writeFileSync(OUT, text);
  console.log('wrote ' + path.relative(ROOT, OUT));
}
module.exports = { build, SCHEMA, OUT, compactUsed };
if (require.main === module) main();
