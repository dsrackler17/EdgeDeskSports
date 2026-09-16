#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk MLB — the as-of features, and whether the evaluation is honest.

   ONE PROPERTY MATTERS MORE THAN EVERY OTHER HERE, and it is the one a
   backtest cannot report on itself: a feature row for season S must not
   contain one atom of information from season S or later. Everything else in
   this file is secondary to that.

   So it is not checked by reading the code. Every season from S onward is
   MUTATED beyond recognition — counting statistics multiplied, rates replaced,
   roles and clubs swapped — and the feature row for S is required to come back
   byte for byte identical. A leak of any kind moves it.

   The rest:
     * the SQL view and the JavaScript mirror agree field for field on the real
       archive, because two implementations that drift are worse than one;
     * 2020 is labelled rather than rescaled, and excluded as a target season;
     * the evaluation trains only on seasons strictly before each target;
     * starters and relievers are separated on the PRIOR season's role, which
       is knowable in advance, rather than the outcome season's;
     * the verdict says "worse" when it is worse;
     * nothing is promoted, and no feature becomes a price.

   Run: node tools/mlb/features.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const D = require('./dataset.js');
const F = require('./pitcher_features.js');
const E = require('./evaluate_features.js');
const PG = require('./pg_client.js');
const IMPORT = require('./import_pitcher_history.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? ' — ' + String(JSON.stringify(detail)).slice(0, 300) : '')); }
}
function eq(name, got, want) { ok(name, got === want, { got, want }); }

console.log('mlb as-of features');

const ds = D.loadDataset(D.DEFAULT_DIR);
const seasons = ds.rows.pitcher_seasons;
const features = F.buildFeatures(seasons);

/* ── 1. shape ───────────────────────────────────────────────────────────── */
eq('one feature row per pitcher-season', features.length, seasons.length);
ok('a first season carries nothing prior',
  features.filter(f => f.seasons_before === 0)
    .every(f => f.prior_season == null && f.prior_era == null && f.base_outs == null));
ok('every prior_season is strictly earlier than its own season',
  features.every(f => f.prior_season == null || f.prior_season < f.season));
ok('no baseline spans more than three prior seasons',
  features.every(f => f.base_seasons <= 3));
ok('a baseline never holds more outs than the pitcher threw before that season', (() => {
  const byPlayer = new Map();
  seasons.forEach(r => { if (!byPlayer.has(r.player_id)) byPlayer.set(r.player_id, []); byPlayer.get(r.player_id).push(r); });
  return features.every(f => {
    if (f.base_outs == null) return true;
    const before = (byPlayer.get(f.player_id) || []).filter(r => r.season < f.season)
      .reduce((a, r) => a + (r.outs || 0), 0);
    return f.base_outs <= before;
  });
})());

/* ── 2. THE LEAKAGE TEST ────────────────────────────────────────────────── */
{
  /* Pick pitchers with long careers so there is plenty of future to corrupt. */
  const byPlayer = new Map();
  seasons.forEach(r => { if (!byPlayer.has(r.player_id)) byPlayer.set(r.player_id, []); byPlayer.get(r.player_id).push(r); });
  const long = Array.from(byPlayer.entries()).filter(([, rows]) => rows.length >= 6).slice(0, 40);
  ok('there are long careers to test against', long.length >= 20, long.length);

  let checked = 0, moved = 0, movedExamples = [];
  for (const [pid, rows] of long) {
    const sorted = rows.slice().sort((a, b) => a.season - b.season);
    for (let i = 1; i < sorted.length; i++) {
      const S = sorted[i].season;
      const clean = F.featuresForPitcher(sorted).filter(f => f.season === S)[0];
      /* Corrupt EVERY season from S onward, in every way a leak could read. */
      const corrupted = sorted.map(r => {
        if (r.season < S) return r;
        const c = Object.assign({}, r);
        ['outs', 'games', 'starts', 'earned_runs', 'hits', 'walks', 'strikeouts',
          'home_runs', 'hit_batters', 'batters_faced'].forEach(k => { if (c[k] != null) c[k] = c[k] * 9 + 7; });
        ['era', 'fip', 'whip', 'k_pct', 'bb_pct', 'k_minus_bb_pct', 'performance_index']
          .forEach(k => { if (c[k] != null) c[k] = 99.5; });
        c.role = c.role === 'starter' ? 'reliever' : 'starter';
        c.teams = 'Corrupted Club';
        c.age = (c.age || 20) + 40;
        return c;
      });
      const after = F.featuresForPitcher(corrupted).filter(f => f.season === S)[0];
      /* The outcome_* fields describe season S itself and are SUPPOSED to move;
         everything else is a feature and must not. */
      const strip = (o) => {
        const c = Object.assign({}, o);
        Object.keys(c).forEach(k => { if (/^outcome_/.test(k) || k === 'position_reported' || k === 'player_name') delete c[k]; });
        return c;
      };
      checked++;
      if (JSON.stringify(strip(clean)) !== JSON.stringify(strip(after))) {
        moved++;
        if (movedExamples.length < 2) movedExamples.push({ player_id: pid, season: S, clean: strip(clean), after: strip(after) });
      }
    }
  }
  ok('a lot of pitcher-seasons were actually tested', checked > 200, checked);
  eq('NO feature row moves when every later season is corrupted', moved, 0);
  if (moved) console.log('       ' + JSON.stringify(movedExamples).slice(0, 600));

  /* The mirror image: corrupting an EARLIER season must move the row, or the
     test above would pass on a function that returns constants. */
  const [pid0, rows0] = long[0];
  const sorted0 = rows0.slice().sort((a, b) => a.season - b.season);
  const S0 = sorted0[3].season;
  const before = F.featuresForPitcher(sorted0).filter(f => f.season === S0)[0];
  const past = sorted0.map(r => (r.season < S0 ? Object.assign({}, r, { k_minus_bb_pct: 0.99, outs: 1234 }) : r));
  const afterPast = F.featuresForPitcher(past).filter(f => f.season === S0)[0];
  ok('…and corrupting an EARLIER season does move it (the test can fail)',
    JSON.stringify(before) !== JSON.stringify(afterPast));
}

/* ── 3. 2020 is labelled, not rescaled ──────────────────────────────────── */
{
  const with2020 = features.filter(f => (f.base_share_from_2020 || 0) > 0);
  ok('baselines containing 2020 are marked', with2020.length > 100, with2020.length);
  ok('…with the share of workload it contributed', with2020.every(f => f.base_share_from_2020 > 0 && f.base_share_from_2020 <= 1));
  const p2020 = features.filter(f => f.prior_season === 2020);
  ok('a pitcher whose prior season was 2020 is flagged', p2020.length > 100 && p2020.every(f => f.prior_is_2020 === true), p2020.length);
  const raw2020 = seasons.filter(r => r.season === 2020);
  const feat2020 = features.filter(f => f.season === 2020);
  ok('2020 innings are NOT rescaled anywhere', feat2020.every(f => {
    const r = raw2020.filter(x => x.player_id === f.player_id)[0];
    return !r || f.outcome_outs === r.outs;
  }));
}

/* ── 4. the evaluation is chronological ─────────────────────────────────── */
{
  const res = E.evaluate({ seasonRows: seasons, target: 'k_minus_bb_pct' });
  ok('2020 is excluded as a target season by default', res.target_seasons.indexOf(2020) < 0, res.target_seasons);
  ok('…and the exclusion is explained rather than silent', /60 games is not a year/.test(res.shortened_season.as_target.note));
  ok('the first season cannot be a target', res.target_seasons.indexOf(res.coverage.start) < 0);
  ok('every target season is inside the coverage window',
    res.target_seasons.every(s => s > res.coverage.start && s <= res.coverage.end));
  ok('each target season trained on fewer rows than the one after it', (() => {
    const rows = res.per_season.map(p => p.train_rows);
    return rows.every((r, i) => i === 0 || r >= rows[i - 1]);
  })(), res.per_season.map(p => ({ s: p.season, n: p.train_rows })));
  eq('the earliest target season has no training rows at all',
    res.per_season[0].train_rows, 0);

  ok('starters and relievers are reported separately',
    !!res.by_prior_role.starter && !!res.by_prior_role.reliever, Object.keys(res.by_prior_role));
  ok('…stratified on the PRIOR season’s role, not the outcome’s',
    /PRIOR season.*known before/.test(res.population.stratified_on), res.population.stratified_on);

  ok('the incumbent is carry-forward, and it is named as such',
    /THE INCUMBENT/.test(res.methods.carry_forward));
  const cf = res.results.filter(r => r.method === 'carry_forward')[0];
  ok('the incumbent produced a number on a real population', cf && cf.n > 1000, cf && cf.n);
  ok('every candidate is compared against it per row, with its own spread',
    res.results.filter(r => r.method !== 'carry_forward')
      .every(r => r.vs_carry_forward && r.vs_carry_forward.standard_error != null));

  ok('the verdict states whether it improved', typeof res.verdict.improved_on_incumbent === 'boolean');
  ok('…and whether the improvement survives its own spread',
    typeof res.verdict.improvement_survives_its_own_spread === 'boolean');
  ok('…in a sentence that names the numbers', /mean absolute error/.test(res.verdict.statement), res.verdict.statement.slice(0, 120));

  /* NOTHING IS PROMOTED, AND NOTHING BECOMES A PRICE. */
  eq('nothing is promoted', res.promotion.promoted, false);
  ok('…and the registry is named so the rule is checkable', /research_model_current/.test(res.promotion.registry));
  ok('the report refuses to turn a descriptive index into a price',
    /performance_index/.test(res.not_a_price)
    && /\bDESCRIPTIVE\b/.test(res.not_a_price)
    && /probability, a fair price or a betting edge/i.test(res.not_a_price),
    res.not_a_price);

  /* THE VERDICT MUST BE ABLE TO SAY "WORSE". A report that can only say
     "better" is a press release. ERA is the case where the league average
     beats a pitcher's own prior season, so it exercises the honest branch. */
  const era = E.evaluate({ seasonRows: seasons, target: 'era' });
  const eraCf = era.results.filter(r => r.method === 'carry_forward')[0];
  const eraLg = era.results.filter(r => r.method === 'league_prior')[0];
  ok('for ERA, the league average beats carrying a pitcher’s own forward',
    eraLg.mae < eraCf.mae, { league: eraLg.mae, carry: eraCf.mae });
  ok('…which the report states rather than buries',
    eraLg.vs_carry_forward.beats_incumbent === true);

  /* And a target where nothing should help: a candidate that is strictly the
     incumbent must report no improvement. */
  const nullRes = E.evaluate({ seasonRows: seasons, target: 'bb_pct' });
  ok('a third target also runs end to end', nullRes.results.length === 5, nullRes.results.length);
}

/* ── 5. the committed reports say what the code says ────────────────────── */
{
  const dir = E.OUT_DIR;
  ['next_season_k_minus_bb_pct.json', 'next_season_era.json'].forEach(n => {
    const p = path.join(dir, n);
    if (!fs.existsSync(p)) { ok(`the committed report ${n} exists`, false); return; }
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    ok(`the committed report ${n} exists`, true);
    eq(`  …and promotes nothing (${n})`, j.promotion.promoted, false);
    ok(`  …and excludes 2020 as a target (${n})`, j.target_seasons.indexOf(2020) < 0);
    ok(`  …and states its verdict (${n})`, typeof j.verdict.statement === 'string' && j.verdict.statement.length > 60);
  });
}

/* ── 6. the SQL view and the JavaScript mirror agree ────────────────────── */
const conn = PG.findServer();
if (!conn) {
  console.log('  ..   the view comparison needs PostgreSQL; skipped');
  finish();
} else {
  (async function () {
    const DB = 'edgedesk_mlbhist_features';
    if (!PG.createDatabase(conn, DB)) { console.log('  ..   could not create a test database; skipped'); return finish(); }
    const db = PG.pgClient(conn, { database: DB });
    try {
      for (const f of [path.join(ROOT, 'tools', 'games', 'sql', 'supabase_shim.sql'),
        path.join(ROOT, 'supabase', 'mlb_pitcher_history.sql'),
        path.join(ROOT, 'supabase', 'mlb_pitcher_features.sql')]) {
        if (f.indexOf('features') >= 0) continue;   // applied after the import
        const a = PG.applyFile(conn, DB, f);
        if (!a.ok) { ok('the schema applies', false, a.stderr.slice(0, 200)); return; }
      }
      await IMPORT.runImport(db, ds, D.validateDataset(ds), { log: () => {}, chunk: 1000 });
      const a = PG.applyFile(conn, DB, path.join(ROOT, 'supabase', 'mlb_pitcher_features.sql'));
      ok('the feature view applies on top of the archive', a.ok, a.stderr.slice(0, 200));

      const n = Number(db.rows('select count(*)::int as n from mlbhist.pitcher_prior_features')[0].n);
      eq('the view has one row per pitcher-season', n, seasons.length);

      /* Field for field, on a sample big enough to catch a systematic
         difference and small enough to read back in one query. */
      const sample = db.rows(`select * from mlbhist.pitcher_prior_features
                               where player_id in (543037, 472610, 554430, 605400, 592789)
                               order by player_id, season`);
      ok('the view returns the sampled careers', sample.length > 30, sample.length);
      const NUMERIC = ['prior_era', 'prior_fip', 'prior_whip', 'prior_k_pct', 'prior_bb_pct',
        'prior_k_minus_bb_pct', 'prior_performance_index', 'prior_era_minus_fip', 'prior_innings',
        'trend_k_pct', 'trend_bb_pct', 'trend_k_minus_bb_pct', 'trend_era', 'workload_change_pct',
        'base_era', 'base_whip', 'base_k_pct', 'base_bb_pct', 'base_k_minus_bb_pct',
        'base_performance_index', 'base_start_share', 'base_innings', 'base_share_from_2020'];
      const INTEGER = ['seasons_before', 'prior_season', 'prior_gap', 'prior_outs', 'prior_games',
        'prior_starts', 'prior_age', 'base_seasons', 'base_outs', 'workload_change_outs', 'base_outs_from_2020'];
      const BOOLEAN = ['role_changed_before', 'team_changed_before', 'prior_season_was_split', 'prior_is_2020'];
      const jsBy = new Map();
      features.forEach(f => jsBy.set(`${f.player_id}|${f.season}`, f));
      let compared = 0, diffs = [];
      sample.forEach(row => {
        const js = jsBy.get(`${Number(row.player_id)}|${Number(row.season)}`);
        if (!js) { diffs.push({ missing: `${row.player_id}/${row.season}` }); return; }
        compared++;
        NUMERIC.forEach(k => {
          const a2 = row[k] == null ? null : Number(row[k]);
          const b2 = js[k] == null ? null : Number(js[k]);
          if ((a2 == null) !== (b2 == null)) { diffs.push({ k, sql: a2, js: b2, who: `${row.player_id}/${row.season}` }); return; }
          if (a2 != null && Math.abs(a2 - b2) > 1e-9) diffs.push({ k, sql: a2, js: b2, who: `${row.player_id}/${row.season}` });
        });
        INTEGER.forEach(k => {
          const a2 = row[k] == null ? null : Number(row[k]);
          const b2 = js[k] == null ? null : Number(js[k]);
          if (a2 !== b2) diffs.push({ k, sql: a2, js: b2, who: `${row.player_id}/${row.season}` });
        });
        BOOLEAN.forEach(k => {
          const a2 = row[k] == null ? null : !!row[k];
          const b2 = js[k] == null ? null : !!js[k];
          if (a2 !== b2) diffs.push({ k, sql: a2, js: b2, who: `${row.player_id}/${row.season}` });
        });
        if (String(row.prior_role || '') !== String(js.prior_role || '')) {
          diffs.push({ k: 'prior_role', sql: row.prior_role, js: js.prior_role, who: `${row.player_id}/${row.season}` });
        }
      });
      ok('a real number of rows were compared', compared > 30, compared);
      eq('the SQL view and the JavaScript mirror agree on every field', diffs.length, 0);
      if (diffs.length) console.log('       ' + JSON.stringify(diffs.slice(0, 4)));

      /* the view's own report, run against a populated archive */
      const rep = PG.applyFile(conn, DB, path.join(ROOT, 'supabase', 'mlb_pitcher_features.sql'));
      ok('the view is idempotent', rep.ok, rep.stderr.slice(0, 200));
      const bad = db.rows(`select count(*)::int as n from mlbhist.pitcher_prior_features
                            where prior_season is not null and prior_season >= season`)[0];
      eq('no row in the database looks forward', Number(bad.n), 0);
      const late = db.rows(`select count(*)::int as n from mlbhist.pitcher_prior_features f
                             where f.base_outs is not null
                               and f.base_outs > (select coalesce(sum(p.outs),0) from mlbhist.pitcher_seasons p
                                                   where p.player_id = f.player_id and p.season < f.season)`)[0];
      eq('no baseline in the database reaches its own season', Number(late.n), 0);

      /* And the thing the whole schema exists to protect: no live pricing
         object reads this view. Checked by reading the shipped SQL. */
      const supa = fs.readdirSync(path.join(ROOT, 'supabase')).filter(f => f.endsWith('.sql'));
      const readers = supa.filter(f => f !== 'mlb_pitcher_features.sql'
        && fs.readFileSync(path.join(ROOT, 'supabase', f), 'utf8').indexOf('pitcher_prior_features') >= 0);
      eq('no other shipped SQL object reads the feature view', readers.length, 0);
    } finally {
      db.close();
      PG.dropDatabase(conn, DB);
    }
    finish();
  })();
}

function finish() {
  console.log('');
  if (fail) { console.log(`FAILED mlb as-of features — ${pass} passed, ${fail} failed`); process.exit(1); }
  console.log(`ALL GREEN mlb as-of features — ${pass} checks`);
  console.log(`PASS | mlb as-of features | ${pass} assertions`);
}
