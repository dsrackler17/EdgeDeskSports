'use strict';
/* ===========================================================================
   EdgeDesk college baseball — the coverage ledger and the data-quality audit.

     node college_baseball/coverage.js           write validation/coverage.json,
                                                 validation/data_quality.json and research/COVERAGE.md
     node college_baseball/coverage.js --check   recompute and fail if the committed files differ

   COVERAGE IS MEASURED, NEVER CLAIMED. Every number below is counted from the
   committed warehouse. Weather and verified market prices are columns of the
   ledger and read zero because nothing authorised supplies them; the zero is
   the finding, not a placeholder.

   The audit implements research/DATA_QUALITY.md: missing games, duplicate
   events, identifiers, home/away and neutral-site disputes, incomplete box
   scores, impossible pitching totals, innings-pitched conversions, earned vs
   total runs, starters, pitcher chronology, rescheduled games and source
   revisions — each counted per season and per source.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('./config');
const W = require('./lib/warehouse');
const K = require('./ingest/common');
const RULES = require('./lib/rules');

function seasonCoverage(season) {
  const games = W.games(season);
  const rep = W.report(season) || {};
  const box = W.teamGames(season); const pit = W.pitchers(season);
  const boxBy = new Map(); for (const t of box) { if (!boxBy.has(t.game_id)) boxBy.set(t.game_id, []); boxBy.get(t.game_id).push(t); }
  const starters = new Map(); for (const p of pit) if (p.starter === 1) { if (!starters.has(p.game_id)) starters.set(p.game_id, new Set()); starters.get(p.game_id).add(p.side); }
  const final = games.filter((g) => g.status === 'FINAL');
  const cov = {
    season,
    scheduled: games.length,
    identified: games.filter((g) => g.home_id && g.away_id).length,
    d1_vs_d1: games.filter((g) => g.home_div === 1 && g.away_div === 1).length,
    vs_non_d1: games.filter((g) => !(g.home_div === 1 && g.away_div === 1)).length,
    final_results: final.length,
    canceled: games.filter((g) => g.status === 'CANCELED').length,
    postponed: games.filter((g) => g.status === 'POSTPONED').length,
    no_result: games.filter((g) => !['FINAL', 'CANCELED', 'POSTPONED'].includes(g.status)).length,
    quarantined: games.filter((g) => g.quality === 'CONFLICT').length,
    verified_multi_source: final.filter((g) => /^VERIFIED/.test(g.quality)).length,
    single_source: final.filter((g) => /^SINGLE_SOURCE/.test(g.quality)).length,
    with_innings_lines: final.filter((g) => g.away_line).length,
    with_play_by_play: games.filter((g) => g.pbp_key).length,
    with_basic_box: final.filter((g) => (boxBy.get(g.game_id) || []).length === 2).length,
    with_complete_player_stats: final.filter((g) => { const b = boxBy.get(g.game_id) || []; return b.length === 2 && b.every((t) => t.box_quality === 'OK'); }).length,
    with_starting_pitchers: final.filter((g) => (starters.get(g.game_id) || new Set()).size === 2).length,
    with_historical_weather: 0,
    with_verified_market_prices: 0,
    eligible_for_rating: games.filter((g) => W.usable(g)).length,
    source_sha256: (rep.sources && rep.sources.schedule && rep.sources.schedule.sha256) || null,
  };
  /* teams whose schedule looks incomplete: a D-I program with far fewer results than its peers */
  const per = new Map();
  for (const g of final) for (const id of [g.home_id, g.away_id]) if (id) per.set(id, (per.get(id) || 0) + 1);
  const d1 = W.teamSeasons().filter((t) => t.season === season && t.division === 1);
  const counts = d1.map((t) => per.get(t.team_id) || 0).sort((a, b) => a - b);
  const median = counts.length ? counts[Math.floor(counts.length / 2)] : 0;
  cov.d1_programs = d1.length;
  cov.median_results_per_program = median;
  cov.programs_below_half_median = d1.filter((t) => (per.get(t.team_id) || 0) < median / 2).map((t) => `${t.name} (${per.get(t.team_id) || 0})`);
  cov.programs_with_no_results = d1.filter((t) => !per.get(t.team_id)).map((t) => t.name);
  /* the last date with a final */
  cov.first_final = final.length ? final[0].date : null; cov.last_final = final.length ? final[final.length - 1].date : null;
  const sorted = final.map((g) => g.date).sort(); cov.first_final = sorted[0] || null; cov.last_final = sorted[sorted.length - 1] || null;
  /* a gap: no final on a date inside the season while scheduled games exist after it */
  const noResultAfter = games.filter((g) => g.status !== 'FINAL' && g.status !== 'CANCELED' && g.status !== 'POSTPONED');
  cov.no_result_date_range = noResultAfter.length ? [noResultAfter.map((g) => g.date).sort()[0], noResultAfter.map((g) => g.date).sort().pop()] : null;
  return cov;
}

function seasonQuality(season) {
  const games = W.games(season); const rep = W.report(season) || {};
  const box = W.teamGames(season); const pit = W.pitchers(season);
  const byId = new Map(games.map((g) => [g.game_id, g]));
  const q = { season, by_quality: {}, problems: rep.problems || [], checks: {} };
  for (const g of games) q.by_quality[g.quality] = (q.by_quality[g.quality] || 0) + 1;
  const ck = (k, n, of, examples) => { q.checks[k] = { n, of, rate: of ? Math.round(n / of * 10000) / 10000 : null, examples: (examples || []).slice(0, 5) }; };
  /* duplicates: same date, same pair, same score, different contest id */
  const sig = new Map(); const dups = [];
  for (const g of games) if (g.status === 'FINAL') {
    const k = [g.date, [g.home_id, g.away_id].sort().join('~'), [g.home_runs, g.away_runs].sort().join('-'), g.dh || ''].join('|');
    if (sig.has(k)) dups.push(g.game_id + '~' + sig.get(k)); else sig.set(k, g.game_id);
  }
  ck('possible_duplicate_events', dups.length, games.length, dups);
  const idCount = new Map(); for (const g of games) idCount.set(g.game_id, (idCount.get(g.game_id) || 0) + 1);
  ck('duplicate_game_ids', [...idCount.values()].filter((n) => n > 1).length, games.length);
  ck('unidentified_program', games.filter((g) => !g.home_id || !g.away_id).length, games.length, games.filter((g) => !g.home_id || !g.away_id).map((g) => `${g.game_id} ${g.home_name} v ${g.away_name}`));
  ck('home_away_conflict_quarantined', games.filter((g) => g.quality === 'CONFLICT').length, games.length, games.filter((g) => g.quality === 'CONFLICT').map((g) => g.game_id));
  ck('host_did_not_bat_last', games.filter((g) => g.bats_last === 'A').length, games.length, games.filter((g) => g.bats_last === 'A').map((g) => g.game_id));
  ck('home_disputed_mirror_copies', games.filter((g) => g.quality === 'VERIFIED_MIRROR').length, games.length);
  ck('neutral_orientation_unconfirmed', games.filter((g) => g.neutral === 1 && g.home_basis === 'FIRST_LISTED').length, games.filter((g) => g.neutral === 1).length);
  ck('pbp_final_disagrees_single_source', games.filter((g) => g.quality === 'SINGLE_SOURCE_PBP_DISAGREES').length, games.filter((g) => g.pbp_key).length);
  const markerMismatch = games.filter((g) => g.status === 'FINAL' && g.innings_marker >= 10 && g.innings_played && g.innings_played !== g.innings_marker);
  ck('extra_innings_marker_vs_innings_played', markerMismatch.length, games.filter((g) => g.innings_marker >= 10).length, markerMismatch.map((g) => `${g.game_id} marker ${g.innings_marker} played ${g.innings_played}`));
  if (box.length) {
    const finals = games.filter((g) => g.status === 'FINAL');
    const boxIds = new Set(box.map((t) => t.game_id));
    ck('final_without_box', finals.filter((g) => !boxIds.has(g.game_id)).length, finals.length, finals.filter((g) => !boxIds.has(g.game_id)).map((g) => g.game_id));
    const failed = box.filter((t) => t.box_quality !== 'OK');
    ck('box_players_do_not_sum_to_total', failed.filter((t) => t.box_quality === 'CHECK_FAILED').length, box.length, failed.map((t) => `${t.game_id} ${t.team_name}: ${t.total_checks}`));
    ck('box_team_unresolved', failed.filter((t) => t.box_quality === 'UNRESOLVED_TEAM').length, box.length);
    ck('invalid_innings_pitched_text', box.filter((t) => /INVALID_IP/.test(t.total_checks || '')).length, box.length);
    ck('pitcher_er_exceeds_runs', pit.filter((p) => p.er != null && p.r != null && p.er > p.r).length, pit.length, pit.filter((p) => p.er > p.r).map((p) => `${p.game_id} ${p.name}`));
    /* impossible pitching totals: outs a staff recorded must fit the innings the opponent batted */
    let impossible = 0; const impEx = [];
    for (const t of box) {
      const g = byId.get(t.game_id); if (!g || g.status !== 'FINAL' || !g.away_line) continue;
      /* home pitchers face the road side (top halves), road pitchers face the home side */
      const facing = t.side === 'H' ? RULES.parseLine(g.bats_last === 'A' ? g.home_line : g.away_line) : RULES.parseLine(g.bats_last === 'A' ? g.away_line : g.home_line);
      const halves = facing.filter((v) => v != null).length;
      if (!halves || t.pit_outs == null) continue;
      if (t.pit_outs > halves * 3 || t.pit_outs < (halves - 1) * 3) { impossible++; impEx.push(`${t.game_id} ${t.team_name} outs ${t.pit_outs} vs ${halves} half-innings`); }
    }
    ck('pitching_outs_do_not_fit_innings', impossible, box.length, impEx);
    /* chronology: the same pitcher in two games on one date, or starting on consecutive days */
    const byPerson = new Map();
    for (const p of pit) { if (!p.person_id) continue; if (!byPerson.has(p.person_id)) byPerson.set(p.person_id, []); byPerson.get(p.person_id).push(p); }
    let sameDay = 0; let b2bStarts = 0; const chronoEx = [];
    for (const [pid, apps] of byPerson) {
      apps.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      for (let i = 1; i < apps.length; i++) {
        if (apps[i].date === apps[i - 1].date && apps[i].game_id !== apps[i - 1].game_id) { sameDay++; chronoEx.push(`${pid} ${apps[i].date}`); }
        if (apps[i].starter && apps[i - 1].starter && apps[i].date && apps[i - 1].date && K.daysBetween(apps[i - 1].date, apps[i].date) === 1) b2bStarts++;
      }
    }
    ck('pitcher_twice_in_one_day', sameDay, pit.length, chronoEx);
    ck('starts_on_consecutive_days', b2bStarts, pit.filter((p) => p.starter).length);
    ck('pitcher_unlinked_to_roster', pit.filter((p) => /^n:/.test(p.person_id || '')).length, pit.length);
    const openers = box.filter((t) => t.starter_outs != null && t.starter_outs <= 3);
    ck('starter_recorded_three_outs_or_fewer', openers.length, box.length);
  }
  /* rescheduled: a postponed game later made up between the same programs */
  const finals = games.filter((g) => g.status === 'FINAL');
  const ppd = games.filter((g) => g.status === 'POSTPONED');
  const madeUp = ppd.filter((p) => finals.some((f) => f.date > p.date && [f.home_id, f.away_id].sort().join() === [p.home_id, p.away_id].sort().join() && K.daysBetween(p.date, f.date) <= 30));
  ck('postponed_made_up_within_30_days', madeUp.length, ppd.length);
  return q;
}

function md(cov, qual) {
  const L = [];
  L.push('# Coverage ledger (generated)', '', 'Generated by `node college_baseball/coverage.js` from the committed warehouse. Do not edit by hand.', '');
  L.push('| Season | Scheduled | Identified | Final | Quarantined | Multi-source verified | Innings lines | Play-by-play | Basic box | Complete player stats | Starters | Weather | Market | Eligible | Last final |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const c of cov) L.push(`| ${c.season} | ${c.scheduled} | ${c.identified} | ${c.final_results} | ${c.quarantined} | ${c.verified_multi_source} | ${c.with_innings_lines} | ${c.with_play_by_play} | ${c.with_basic_box} | ${c.with_complete_player_stats} | ${c.with_starting_pitchers} | ${c.with_historical_weather} | ${c.with_verified_market_prices} | ${c.eligible_for_rating} | ${c.last_final} |`);
  L.push('', '## Missing and incomplete', '');
  for (const c of cov) {
    const bits = [];
    if (c.no_result) bits.push(`${c.no_result} scheduled contests without a result${c.no_result_date_range ? ` (${c.no_result_date_range[0]} → ${c.no_result_date_range[1]})` : ''}`);
    if (c.canceled) bits.push(`${c.canceled} canceled`);
    if (c.postponed) bits.push(`${c.postponed} postponed`);
    if (c.programs_with_no_results.length) bits.push(`programs with no results: ${c.programs_with_no_results.slice(0, 8).join(', ')}${c.programs_with_no_results.length > 8 ? '…' : ''}`);
    if (c.programs_below_half_median.length) bits.push(`${c.programs_below_half_median.length} D-I programs with fewer than half the median results (${c.median_results_per_program})`);
    L.push(`- **${c.season}**: ${bits.join('; ') || 'none beyond cancellations'}`);
  }
  L.push('', '## Data-quality checks (rate per applicable record)', '');
  const keys = [...new Set(qual.flatMap((q) => Object.keys(q.checks)))];
  L.push('| Check | ' + qual.map((q) => q.season).join(' | ') + ' |');
  L.push('|---|' + qual.map(() => '---').join('|') + '|');
  for (const k of keys) L.push(`| ${k} | ` + qual.map((q) => (q.checks[k] ? `${q.checks[k].n}` : '·')).join(' | ') + ' |');
  L.push('');
  return L.join('\n');
}

function build() {
  const cov = []; const qual = [];
  for (let s = C.SEASONS.first; s <= C.SEASONS.last; s++) { cov.push(seasonCoverage(s)); qual.push(seasonQuality(s)); }
  const totals = {};
  for (const k of Object.keys(cov[0])) if (typeof cov[0][k] === 'number' && k !== 'season' && k !== 'median_results_per_program') totals[k] = cov.reduce((a, c) => a + (c[k] || 0), 0);
  return {
    coverage: { schema: 'edgedesk_cbase_coverage_v1', generated_from: 'college_baseball/data', seasons: cov, totals,
      notes: ['weather and market columns are zero because no authorised source supplies them (research/SOURCES.md)', '2023: the source carries results only through 2023-03-28 for most programs; later contests are listed without results'] },
    quality: { schema: 'edgedesk_cbase_quality_v1', seasons: qual },
    markdown: md(cov, qual),
  };
}

function main() {
  const out = build();
  const files = [[C.PATHS.coverage, JSON.stringify(out.coverage, null, 1) + '\n'], [C.PATHS.quality, JSON.stringify(out.quality, null, 1) + '\n'], [path.join(C.PATHS.research, 'COVERAGE.md'), out.markdown]];
  if (process.argv.includes('--check')) {
    const drift = files.filter(([f, t]) => !fs.existsSync(f) || fs.readFileSync(f, 'utf8') !== t).map(([f]) => f);
    if (drift.length) { console.error('coverage drift: ' + drift.join(', ')); process.exit(1); }
    console.log('coverage: committed files reproduce'); return;
  }
  for (const [f, t] of files) K.writeIfChanged(f, t);
  const t = out.coverage.totals;
  console.log(`coverage: ${t.scheduled} contests, ${t.final_results} final, ${t.quarantined} quarantined, ${t.with_basic_box} with box, ${t.with_play_by_play} with pbp, ${t.eligible_for_rating} eligible`);
}

if (require.main === module) main();
module.exports = { build, seasonCoverage, seasonQuality };
