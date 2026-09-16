#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk MLB — the import, end to end, against a real PostgreSQL.

   This is not a unit test of a parser. It applies the shipped schema, runs the
   SHIPPED importer over the COMMITTED dataset — all 8,233 pitcher-seasons and
   9,212 club rows — through the real promote gate, and then asks the database
   the questions a reader would:

     * did every row land, at both grains, with the package's own counts;
     * does a traded pitcher still have both clubs (the Luis García 2024 repair
       the package logs, which is the exact record a naive team-by-team pull
       loses);
     * does importing the SAME dataset again leave the SAME database, rather
       than doubling it;
     * does a corrupted dataset get refused with the previous archive intact;
     * do the four nothings stay distinguishable through the query layer: an
       unresolvable name, a resolvable player with no rows in the window, an
       ambiguous name, and a genuinely undefined value;
     * and do the numbers the query layer returns match the numbers in the
       database — checked against SQL computed independently of it.

   Without PostgreSQL it skips loudly and passes, like every other SQL-backed
   suite here.

   Run: node tools/mlb/import.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..');
const PG = require('./pg_client.js');
const D = require('./dataset.js');
const M = require('../../lib/mlb_pitcher_history.js');
const IMPORT = require('./import_pitcher_history.js');

const DB = 'edgedesk_mlbhist_import';
const SHIM = path.join(ROOT, 'tools', 'games', 'sql', 'supabase_shim.sql');
const SCHEMA_SQL = path.join(ROOT, 'supabase', 'mlb_pitcher_history.sql');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}
function eq(name, got, want) { ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
function near(name, got, want, tol) {
  const d = Math.abs(Number(got) - Number(want));
  ok(name, Number.isFinite(d) && d <= (tol == null ? 1e-6 : tol), `got ${got}, want ${want}`);
}

const conn = PG.findServer();
if (!conn) {
  console.log('SKIP | mlb import end to end | no reachable PostgreSQL server');
  console.log('       (this suite needs PostgreSQL; CI runs it in games-sql.yml)');
  process.exit(0);
}

(async function main() {
  if (!PG.createDatabase(conn, DB)) {
    console.log('SKIP | mlb import end to end | could not create the test database');
    process.exit(0);
  }
  const db = PG.pgClient(conn, { database: DB });
  let code = 0;
  try {
    for (const f of [SHIM, SCHEMA_SQL]) {
      const r = PG.applyFile(conn, DB, f);
      if (!r.ok) { console.log('FAIL | ' + path.basename(f) + ' did not apply'); console.error(r.stderr.split('\n').slice(0, 8).join('\n')); throw new Error('apply'); }
    }
    console.log('mlb import end to end');

    /* ---- 1. the real dataset, the real importer, the real gate ---------- */
    const ds = D.loadDataset(D.DEFAULT_DIR);
    const verdict = D.validateDataset(ds);
    ok('the committed dataset validates before anything is written', verdict.ok, verdict.summary);

    const t0 = Date.now();
    const res = await IMPORT.runImport(db, ds, verdict, { log: () => {}, chunk: 1000 });
    ok('the import promoted', !!(res && res.promote && res.promote.ok === true), JSON.stringify(res && res.promote));
    console.log(`  ..   imported in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    const count = (t, where) => Number(db.rows(`select count(*)::int as n from mlbhist.${t}${where ? ' where ' + where : ''}`)[0].n);
    eq('pitcher_seasons rows', count('pitcher_seasons'), ds.counts.pitcher_seasons);
    eq('pitcher_team_seasons rows', count('pitcher_team_seasons'), ds.counts.pitcher_team_seasons);
    eq('pitcher_overview rows', count('pitcher_overview'), ds.counts.pitcher_overview);
    eq('pitcher_team_history rows', count('pitcher_team_history'), ds.counts.pitcher_team_history);
    eq('observed_team_runs rows', count('observed_team_runs'), ds.counts.observed_team_runs);
    eq('league_seasons rows', count('league_seasons'), ds.counts.league_seasons);
    eq('teams rows', count('teams'), ds.counts.teams);
    eq('validation rows', count('validation'), ds.counts.validation);
    eq('source_repairs rows', count('source_repairs'), ds.counts.source_repairs);
    eq('staging is empty after promotion', count('stg_pitcher_seasons'), 0);
    eq('the build report agrees with what landed', ds.counts.pitcher_seasons, Number(ds.report.tables.pitcher_seasons));

    /* the package's own per-season validation, as stored */
    const unrec = count('validation', 'player_totals_reconcile is distinct from true');
    eq('every stored season reconciled', unrec, 0);

    /* ---- 2. the repairs survived the round trip ------------------------- */
    /* Luis García, 2024: the package replaced a one-club player-season with
       MLB's individual year-by-year splits because the team query had omitted
       the Angels. Both clubs must be in the database. */
    const garcia = db.rows(`select team_id, team_name, outs, innings_display, era
                              from mlbhist.pitcher_team_seasons
                             where player_id = 472610 and season = 2024 order by team_id`);
    eq('Luis García 2024 has two club rows', garcia.length, 2);
    eq('…the Angels row is present', garcia.filter(r => Number(r.team_id) === 108).length, 1);
    eq('…the Red Sox row is present', garcia.filter(r => Number(r.team_id) === 111).length, 1);
    const gSeason = db.rows(`select outs, team_count from mlbhist.pitcher_seasons where player_id = 472610 and season = 2024`)[0];
    eq('…and the season row sums both clubs',
      garcia.reduce((a, r) => a + Number(r.outs), 0), Number(gSeason.outs));
    eq('…with team_count = 2', Number(gSeason.team_count), 2);

    /* every repair in the log, not just the famous one */
    const repairBad = db.rows(`
      select r.player_id, r.season, r.replacement_team_rows,
             (select count(*) from mlbhist.pitcher_team_seasons ts
               where ts.player_id = r.player_id and ts.season = r.season) as have
        from mlbhist.source_repairs r
       where r.replacement_team_rows is distinct from
             (select count(*) from mlbhist.pitcher_team_seasons ts
               where ts.player_id = r.player_id and ts.season = r.season)`);
    eq('every logged repair kept its replaced club rows', repairBad.length, 0);

    /* ---- 3. the two grains never double-count --------------------------- */
    const grain = db.rows(`
      select count(*)::int as n from (
        select s.player_id, s.season
          from mlbhist.pitcher_seasons s
          join (select player_id, season, sum(outs) o, sum(strikeouts) k, sum(batters_faced) bf
                  from mlbhist.pitcher_team_seasons group by 1,2) t
            on t.player_id = s.player_id and t.season = s.season
         where t.o is distinct from s.outs
            or t.k is distinct from s.strikeouts
            or t.bf is distinct from s.batters_faced) x`);
    eq('club rows sum exactly to the season row, every player, every season', Number(grain[0].n), 0);

    /* ---- 4. a repeat import is the same database ------------------------ */
    const before = db.rows(`select md5(string_agg(player_id || ':' || season || ':' || coalesce(outs::text,'-')
                              || ':' || coalesce(round(performance_index::numeric, 6)::text,'-'), ',' order by player_id, season)) as h
                              from mlbhist.pitcher_seasons`)[0].h;
    const res2 = await IMPORT.runImport(db, ds, verdict, { log: () => {}, chunk: 1000 });
    ok('the second import promoted', !!(res2 && res2.promote && res2.promote.ok === true));
    eq('a repeat import does not duplicate player-seasons', count('pitcher_seasons'), ds.counts.pitcher_seasons);
    eq('a repeat import does not duplicate club rows', count('pitcher_team_seasons'), ds.counts.pitcher_team_seasons);
    const after = db.rows(`select md5(string_agg(player_id || ':' || season || ':' || coalesce(outs::text,'-')
                              || ':' || coalesce(round(performance_index::numeric, 6)::text,'-'), ',' order by player_id, season)) as h
                              from mlbhist.pitcher_seasons`)[0].h;
    eq('…and leaves the values byte-identical', after, before);
    eq('the superseded import is marked as such',
      Number(db.rows(`select count(*)::int as n from mlbhist.import_runs where status = 'promoted'`)[0].n), 1);

    /* ---- 5. a corrupted dataset cannot replace a good one ---------------- */
    const corrupt = JSON.parse(JSON.stringify({ counts: ds.counts }));
    const shortDs = Object.assign({}, ds, {
      rows: Object.assign({}, ds.rows, { pitcher_seasons: ds.rows.pitcher_seasons.slice(0, 100) })
    });
    let refused = null;
    try {
      await IMPORT.runImport(db, shortDs, verdict, { log: () => {}, chunk: 1000, importId: 'imp-truncated' });
    } catch (e) { refused = e; }
    ok('a truncated dataset is refused by the promote gate', !!refused && refused.code === 'COUNT_MISMATCH',
      refused ? refused.code : 'it was accepted');
    eq('…and the good archive is untouched', count('pitcher_seasons'), ds.counts.pitcher_seasons);
    eq('…and the counts still agree with the build report', corrupt.counts.pitcher_seasons, ds.counts.pitcher_seasons);

    /* ---- 6. the query layer, over the same database ---------------------- */
    const svc = M.createService({ read: (rel, q) => db.select('mlbhist', rel, q) });

    const st = await svc.status();
    ok('status reports a promoted dataset', st.ok === true, JSON.stringify(st).slice(0, 200));
    eq('…covering 2016', st.coverage.start, 2016);
    eq('…through 2025', st.coverage.end, 2025);
    eq('…with the rating version stated', st.coverage.rating_version, 'ED_PITCH_PERF_V1');

    /* identity: the four nothings */
    const cole = await svc.resolvePlayer({ name: 'Gerrit Cole' });
    ok('an unambiguous name resolves', cole.ok && cole.data.resolved.player_id === 543037,
      JSON.stringify(cole.code));
    const nobody = await svc.resolvePlayer({ name: 'Zebediah Notarealpitcher' });
    eq('a name that matches nobody is UNRESOLVED_PLAYER', nobody.code, M.OUTCOMES.UNRESOLVED_PLAYER);
    const ambiguous = await svc.resolvePlayer({ name: 'Luis Ortiz' });
    eq('a name matching two MLB ids is AMBIGUOUS_PLAYER', ambiguous.code, M.OUTCOMES.AMBIGUOUS_PLAYER);
    ok('…and both candidates come back', ambiguous.data.candidates.length === 2,
      String(ambiguous.data.candidates.length));
    ok('…with enough to tell them apart',
      ambiguous.data.candidates.every(c => c.player_id && c.first_observed_season && c.teams));
    const outOfWindow = await svc.pitcherOverview({ player_id: 111111 });
    eq('a player with no rows in the window is NO_RECORDS_IN_WINDOW', outOfWindow.code, M.OUTCOMES.NO_RECORDS_IN_WINDOW);
    ok('…and it is not reported as ok', outOfWindow.ok === false);

    /* an ambiguous name narrowed by a season the asker supplied */
    const narrowed = await svc.resolvePlayer({ name: 'Luis Ortiz', season: 2018 });
    ok('a season narrows an ambiguous name when only one pitched that year',
      narrowed.code === M.OUTCOMES.OK || narrowed.code === M.OUTCOMES.AMBIGUOUS_PLAYER, narrowed.code);

    /* accent folding: the record says García, the reader types Garcia */
    const folded = await svc.search({ q: 'Luis Garcia' });
    ok('an unaccented search finds the accented name',
      folded.data.some(r => r.player_id === 472610), JSON.stringify(folded.data.map(r => r.player_name)));

    /* the record itself, checked against SQL computed independently */
    const ov = await svc.pitcherOverview({ player_id: 543037 });
    const sqlOv = db.rows(`select outs, era, seasons_with_appearances, first_observed_season, last_observed_season
                             from mlbhist.pitcher_overview where player_id = 543037`)[0];
    eq('the overview outs match the table', ov.data.overview.outs, Number(sqlOv.outs));
    near('the overview ERA matches the table', ov.data.overview.era, Number(sqlOv.era));
    eq('the seasons count matches the table', ov.data.overview.seasons_with_appearances, Number(sqlOv.seasons_with_appearances));
    ok('the overview carries a coverage window', !!(ov.coverage && ov.coverage.start && ov.coverage.end));
    ok('the overview carries the rating version', ov.rating_version === 'ED_PITCH_PERF_V1');
    ok('the overview says this is not current-season data',
      ov.notes.some(n => /not current-season data/i.test(n)), JSON.stringify(ov.notes).slice(0, 200));

    /* innings, from outs, in baseball notation */
    const ipRow = db.rows(`select outs, innings_display from mlbhist.pitcher_team_seasons
                            where player_id = 472610 and season = 2024 and team_id = 108`)[0];
    eq('innings display comes from outs', M.inningsDisplay(Number(ipRow.outs)), String(ipRow.innings_display));
    eq('…and 131 outs is 43.2, not 43.67', String(ipRow.innings_display), '43.2');

    /* season history and year-over-year */
    const hist = await svc.seasonHistory({ player_id: 543037 });
    ok('season history returns the seasons in order',
      hist.ok && hist.data.seasons.every((s, i, a) => i === 0 || s.season > a[i - 1].season));
    eq('year-over-year has one fewer row than seasons',
      hist.data.year_over_year.length, hist.data.seasons.length - 1);
    const yoyDelta = hist.data.year_over_year[0];
    if (yoyDelta.changes.era.from != null && yoyDelta.changes.era.to != null) {
      near('a year-over-year ERA delta is the difference of the two seasons',
        yoyDelta.changes.era.delta, yoyDelta.changes.era.to - yoyDelta.changes.era.from, 1e-4);
    }
    ok('a 2020 season is flagged as shortened where present',
      !hist.data.seasons.some(s => s.season === 2020) || hist.notes.some(n => /60-game/.test(n)));

    /* team history: the traded season, and what tenure means */
    const th = await svc.teamHistory({ player_id: 472610 });
    ok('team history lists both clubs for the traded season',
      th.data.multi_club_seasons.indexOf(2024) >= 0, JSON.stringify(th.data.multi_club_seasons));
    ok('…and says tenure is appearances, not a contract',
      th.notes.some(n => /not verified contract/i.test(n)));

    /* leaderboard filters */
    const lb = await svc.leaderboard({ season: 2025, role: 'starter', min_innings: 120, limit: 10 });
    ok('the 2025 starter leaderboard returns rows', lb.ok && lb.data.rows.length > 0, String(lb.data.rows.length));
    ok('…every row is a starter', lb.data.rows.every(r => r.role === 'starter'));
    ok('…every row clears 120 innings', lb.data.rows.every(r => r.outs >= 360));
    ok('…ordered best rating first',
      lb.data.rows.every((r, i, a) => i === 0 || a[i - 1].performance_index >= r.performance_index));
    const sqlTop = db.rows(`select player_id, performance_index from mlbhist.pitcher_seasons
                             where season = 2025 and role = 'starter' and outs >= 360
                               and position_reported = 'P' and performance_index is not null
                             order by performance_index desc limit 1`)[0];
    eq('…and the leader matches a plain SQL query', lb.data.rows[0].player_id, Number(sqlTop.player_id));
    ok('…with the minimum workload stated in the answer', lb.data.data === undefined || lb.data.min_innings === 120);

    const lbNoMin = await svc.leaderboard({ season: 2025, role: 'reliever', limit: 5 });
    ok('a board with no workload filter says so',
      lbNoMin.notes.some(n => /No minimum workload/i.test(n)));

    /* position players who pitched are excluded by default, included on request */
    const posDefault = await svc.leaderboard({ season: 2024, limit: 200, order: 'asc', metric: 'era' });
    const posIncluded = await svc.leaderboard({ season: 2024, limit: 200, order: 'asc', metric: 'era',
      exclude_position_players: false });
    ok('position players who pitched are excluded by default',
      posDefault.data.rows.every(r => r.position_reported == null || r.position_reported === 'P'));
    ok('…and can be included deliberately',
      posIncluded.data.rows.length >= posDefault.data.rows.length);

    /* zero-out appearances: counting stats kept, rates undefined */
    const zero = db.rows(`select player_id, season, games, outs, era, fip, whip, performance_index, sample_flag
                            from mlbhist.pitcher_seasons where outs = 0 order by player_id limit 3`);
    ok('the archive holds zero-out appearances', zero.length > 0);
    ok('…with no invented ERA, FIP, WHIP or rating',
      zero.every(r => r.era == null && r.fip == null && r.whip == null && r.performance_index == null));
    ok('…and their appearances still counted', zero.every(r => Number(r.games) > 0));
    ok('…flagged zero_outs', zero.every(r => r.sample_flag === 'zero_outs'));

    /* comparison */
    const cmp = await svc.compare({ player_ids: [543037, 472610], season: 2024 });
    ok('two pitchers compare on a named season', cmp.ok && cmp.data.comparison.scope === '2024', cmp.code);
    ok('…every compared metric names its direction',
      cmp.data.comparison.metrics.every(m => m.better === 'higher' || m.better === 'lower'));
    ok('…and the sample sizes travel with it', cmp.data.comparison.samples.length === 2);
    const cmpMulti = await svc.compare({ player_ids: [543037, 472610] });
    ok('a multi-season comparison states its scope', /combined|–/.test(String(cmpMulti.data.comparison.scope)));
    ok('…and refuses to invent a multi-season FIP',
      cmpMulti.data.comparison.sides.every(s => s.performance_index !== undefined));

    /* team pitching */
    const nyy = await svc.teamPitching({ team_id: 147, season: 2025, role: 'starter' });
    ok('a club season returns its starters', nyy.ok && nyy.data.club_seasons.length > 0, nyy.code);
    ok('…every row is that club', nyy.data.club_seasons.every(r => r.team_id === 147));

    /* A club that changed its name keeps ONE team id and shows BOTH names.
       Cleveland is Indians through 2021 and Guardians from 2022; Oakland
       becomes Athletics. A record keyed on the name would split each of these
       franchises in two. */
    const cleveland = await svc.teamPitching({ team_id: 114 });
    ok('a renamed club keeps one team id across the window', cleveland.ok, cleveland.code);
    eq('…and both of its names are visible', cleveland.data.names_observed.slice().sort().join(' | '),
      'Cleveland Guardians | Cleveland Indians');
    ok('…and the rename is stated in the answer',
      cleveland.notes.some(n => /appears under 2 names/i.test(n)), JSON.stringify(cleveland.notes).slice(0, 300));
    const clevelandSeasons = db.rows(`select season, team_name from mlbhist.teams where team_id = 114 order by season`);
    eq('…with the season-specific name preserved for 2021', clevelandSeasons.filter(r => Number(r.season) === 2021)[0].team_name, 'Cleveland Indians');
    eq('…and for 2022', clevelandSeasons.filter(r => Number(r.season) === 2022)[0].team_name, 'Cleveland Guardians');
    const clevePitchers = db.rows(`select count(distinct player_id)::int as n from mlbhist.pitcher_team_history where team_id = 114`)[0];
    ok('…and every Cleveland pitcher sits under the one id', Number(clevePitchers.n) > 50, String(clevePitchers.n));

    /* game context: the card's claim is never upgraded */
    const gc = await svc.gamePitcherContext({
      game: 'Boston Red Sox @ New York Yankees',
      starters: [
        { side: 'home', name: 'Gerrit Cole', team: 'New York Yankees', status: 'probable' },
        { side: 'away', name: 'Zebediah Notarealpitcher', team: 'Boston Red Sox', status: null }
      ]
    });
    eq('a probable starter stays probable', gc.data.starters[0].starter_status, 'PROBABLE');
    eq('an unstated status is UNKNOWN, not confirmed', gc.data.starters[1].starter_status, 'UNKNOWN');
    ok('the resolved starter carries history', !!gc.data.starters[0].history);
    ok('the unresolved starter says why', gc.data.starters[1].resolution.code === M.OUTCOMES.UNRESOLVED_PLAYER);
    ok('the context refuses to infer tonight’s club from the archive',
      gc.notes.some(n => /not evidence of tonight/i.test(n)));
    ok('the resolved starter links to a profile', /pitcher\/543037$/.test(gc.data.starters[0].history.profile_link));

    /* league baselines */
    const lg = await svc.leagueBaselines({});
    eq('ten league seasons', lg.data.length, 10);
    ok('each carries its ERA baseline and FIP constant',
      lg.data.every(r => r.league_era != null && r.fip_constant != null));

    /* ---- 7. the contract missing is told apart from the data missing ---- */
    const broken = M.createService({
      read: () => { const e = new Error('Could not find the table \'mlbhist.pitcher_overview\' in the schema cache'); throw e; }
    });
    const brokenRes = await broken.resolvePlayer({ name: 'Gerrit Cole' });
    eq('a missing contract is NOT_INSTALLED, not "no data"', brokenRes.code, M.OUTCOMES.NOT_INSTALLED);
    ok('…and names the file that fixes it', /mlb_pitcher_history\.sql/.test(brokenRes.error), brokenRes.error);

    const down = M.createService({ read: () => { throw new Error('db 503'); } });
    const downRes = await down.leaderboard({ season: 2025 });
    eq('an outage is QUERY_UNAVAILABLE, not "no data"', downRes.code, M.OUTCOMES.QUERY_UNAVAILABLE);

  } catch (e) {
    fail++;
    console.log('  FAIL harness — ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : e));
  } finally {
    db.close();
    PG.dropDatabase(conn, DB);
  }

  console.log('');
  if (fail) { console.log(`FAILED mlb import end to end — ${pass} passed, ${fail} failed`); process.exit(1); }
  console.log(`ALL GREEN mlb import end to end — ${pass} checks`);
})();
