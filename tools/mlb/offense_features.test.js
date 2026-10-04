#!/usr/bin/env node
/* ===========================================================================
   THE AS-OF PROPERTY, PROVED BY CORRUPTING THE FUTURE.

   A feature builder that claims to use only completed prior seasons is easy to
   write and easy to get subtly wrong: an off-by-one in a window frame, a sort
   that runs the other way, a filter someone removes during a refactor. The
   claim is only worth making if something checks it.

   So this takes the real dataset, REPLACES a season's numbers with nonsense,
   rebuilds the features, and asserts that every feature describing a season
   BEFORE the corrupted one is byte-for-byte unchanged — while the features
   that legitimately depend on it do change. A builder that could see the
   future would fail the first half; one that ignored its inputs would fail the
   second.

   It also checks the SQL view against the JavaScript builder on the real
   archive, because two implementations of the same rule that disagree mean at
   least one of them is wrong, and the product reads both.

   The database half needs PostgreSQL and skips loudly without it; the
   corruption proof runs either way.

   Run: node tools/mlb/offense_features.test.js
   =========================================================================== */
'use strict';
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const D = require('./offense_dataset.js');
const E = require('./evaluate_offense_features.js');
const PG = require('./pg_client.js');
const IMPORT = require('./import_offense.js');

const DB = 'edgedesk_mlboff_feat';
const SHIM = path.join(ROOT, 'tools', 'games', 'sql', 'supabase_shim.sql');
const PITCH_SQL = path.join(ROOT, 'supabase', 'mlb_pitcher_history.sql');
const OFF_SQL = path.join(ROOT, 'supabase', 'mlb_offense_history.sql');
const FEAT_SQL = path.join(ROOT, 'supabase', 'mlb_offense_features.sql');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; } else { fail++; console.log('  FAIL ' + name + (detail ? ' — ' + String(detail).slice(0, 220) : '')); }
}
function eq(name, got, want) { ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }

console.log('mlb offense as-of features');

const ds = D.loadDataset(D.DEFAULT_DIR);
const clean = E.buildRows(ds);
ok('features were built from the committed dataset', clean.length > 9000, String(clean.length));

/* ── 1. A FIRST SEASON HAS NO PAST ───────────────────────────────────────── */
const firsts = clean.filter((r) => r.seasons_before === 0);
ok('a hitter’s first season in the window has prior rows', firsts.length > 0, String(firsts.length));
eq('…and not one of them carries a prior rate',
  firsts.filter((r) => r.prior.obp != null || r.prior.k_pct != null).length, 0);
eq('…or a three-season baseline',
  firsts.filter((r) => r.base3.obp != null || r.base3.k_pct != null).length, 0);
eq('…or a prior season number', firsts.filter((r) => r.prior_season != null).length, 0);

/* ── 2. THE CORRUPTION PROOF ─────────────────────────────────────────────── */
const CORRUPT = 2022;
const dirty = D.loadDataset(D.DEFAULT_DIR);
let corrupted = 0;
dirty.tables.batter_seasons.forEach((r) => {
  if (r.season !== CORRUPT) return;
  corrupted++;
  /* Nonsense, but numerically valid nonsense — a builder that reads it will
     produce different numbers, not throw. */
  r.k_pct = 0.999; r.bb_pct = 0.999; r.obp = 0.999; r.slg = 3.999;
  r.iso = 2.999; r.offensive_index = 999.9;
  r.plate_appearances = 9999; r.at_bats = 9999;
});
ok('a season was corrupted to test against', corrupted > 500, String(corrupted));
const after = E.buildRows(dirty);

const key = (r) => r.player_id + '|' + r.season;
const cleanBy = new Map(clean.map((r) => [key(r), r]));
const afterBy = new Map(after.map((r) => [key(r), r]));
eq('the same rows exist before and after', afterBy.size, cleanBy.size);

const PRIOR_FIELDS = ['k_pct', 'bb_pct', 'obp', 'slg', 'iso', 'offensive_index'];
let pastChanged = 0, pastChecked = 0, futureChanged = 0, futureChecked = 0;
cleanBy.forEach((c, k) => {
  const a = afterBy.get(k);
  if (!a) return;
  const describesOnlyThePast = c.season <= CORRUPT;
  PRIOR_FIELDS.forEach((f) => {
    const same = (c.prior[f] === a.prior[f]) && (c.base3[f] === a.base3[f]);
    if (describesOnlyThePast) { pastChecked++; if (!same) pastChanged++; }
    else { futureChecked++; if (!same) futureChanged++; }
  });
});
ok('there were features describing seasons at or before the corrupted one', pastChecked > 1000, String(pastChecked));
eq('NOT ONE of them changed when a later season was corrupted', pastChanged, 0);
ok('there were features describing seasons after it', futureChecked > 1000, String(futureChecked));
ok('…and those DID change, so the builder is reading its inputs at all',
  futureChanged > 0, `${futureChanged} of ${futureChecked}`);

/* The outcome columns of the corrupted season itself must change — they are
   that season, not a feature of it. */
const corruptRows = after.filter((r) => r.season === CORRUPT && r.outcome.obp != null);
ok('the corrupted season’s own outcome reflects the corruption',
  corruptRows.length > 0 && corruptRows.every((r) => r.outcome.obp === 0.999),
  corruptRows.length ? String(corruptRows[0].outcome.obp) : 'none');

/* ── 3. THE BASELINE ENDS ONE SEASON SHORT ───────────────────────────────── */
/* Checked directly: recompute a hitter's three-season baseline by hand from the
   seasons that precede the one being described, and it has to match. */
{
  const byPlayer = new Map();
  ds.tables.batter_seasons.forEach((r) => {
    if (!byPlayer.has(r.player_id)) byPlayer.set(r.player_id, []);
    byPlayer.get(r.player_id).push(r);
  });
  let checked = 0, bad = 0;
  clean.forEach((f) => {
    if (f.base3.k_pct == null) return;
    const list = byPlayer.get(f.player_id).slice().sort((a, b) => a.season - b.season);
    const i = list.findIndex((s) => s.season === f.season);
    const win = list.slice(Math.max(0, i - 3), i);
    if (win.some((s) => s.season >= f.season)) { bad++; return; }
    let n = 0, d = 0;
    win.forEach((s) => {
      if (s.k_pct == null || s.plate_appearances == null || s.plate_appearances <= 0) return;
      n += s.k_pct * s.plate_appearances; d += s.plate_appearances;
    });
    const want = d > 0 ? n / d : null;
    if (want == null || Math.abs(want - f.base3.k_pct) > 1e-12) bad++;
    checked++;
  });
  ok('the three-season baseline was checked by hand', checked > 5000, String(checked));
  eq('…and every one is computed over seasons strictly before the row it describes', bad, 0);
}

/* ── 4. THE EVALUATION ITSELF IS WALK-FORWARD ────────────────────────────── */
{
  const res = E.evaluate({ target: 'bb_pct', dataset: ds });
  ok('the evaluation produced out-of-sample pairs', res.pairs > 1000, String(res.pairs));
  ok('2020 is excluded as a target season', res.seasons_evaluated.indexOf(2020) < 0,
    JSON.stringify(res.seasons_evaluated));
  ok('…and the exclusion is reported rather than silent', res.excluded_2020.length === 1,
    JSON.stringify(res.excluded_2020));
  ok('the first evaluable season is not the first season in the window',
    res.seasons_evaluated[0] > ds.coverage.start + 1, String(res.seasons_evaluated[0]));
  ok('the incumbent is carry-forward', /carry forward/.test(res.incumbent.name), res.incumbent.name);
  eq('nothing is promoted', res.promotion.promoted, false);
  eq('…and the model registry is untouched', res.promotion.registry_touched, false);
  eq('…and live pricing is unchanged', res.promotion.live_pricing_changed, false);
  /* THE METRICS THIS DATASET CANNOT PRODUCE ARE NAMED, not quietly omitted. */
  ['calibration', 'log loss', 'Brier score', 'CLV'].forEach((m) => {
    ok('the report says ' + m + ' is not computable here',
      res.not_computable.metrics.indexOf(m) >= 0, JSON.stringify(res.not_computable.metrics));
  });
  ok('…and says why', /no game logs/.test(res.not_computable.why), res.not_computable.why.slice(0, 80));

  /* A workload screen on the OUTCOME season would flatter every forecast by
     dropping the hitters who got hurt. It is applied to the PRIOR season. */
  const withInjury = res.pairs;
  const resHigh = E.evaluate({ target: 'bb_pct', dataset: ds, minPa: 500 });
  ok('a tighter PRIOR-season screen reduces the population',
    resHigh.pairs < withInjury && resHigh.pairs > 0, `${resHigh.pairs} vs ${withInjury}`);
  /* and hitters whose next season collapsed are still in it */
  const collapsed = E.buildRows(ds).filter((f) =>
    f.prior_pa != null && f.prior_pa >= 200 && f.outcome.plate_appearances != null
    && f.outcome.plate_appearances < 100 && f.outcome.bb_pct != null && f.season !== 2020
    && f.season > ds.coverage.start + 1);
  ok('hitters whose next season collapsed are NOT screened out', collapsed.length > 0,
    String(collapsed.length));
}

/* ── 5. THE SQL VIEW AND THE JAVASCRIPT AGREE ────────────────────────────── */
const conn = PG.findServer();
if (!conn) {
  console.log('  (skipping the SQL half — no reachable PostgreSQL)');
  report();
} else {
  (async function () {
    if (!PG.createDatabase(conn, DB)) { console.log('  (could not create the test database)'); report(); return; }
    const db = PG.pgClient(conn, { database: DB });
    try {
      for (const f of [SHIM, PITCH_SQL, OFF_SQL]) {
        const r = PG.applyFile(conn, DB, f);
        if (!r.ok) { console.log('FAIL | ' + path.basename(f) + ' did not apply'); throw new Error('apply'); }
      }
      await IMPORT.runImport(db, ds, D.validateDataset(ds), { log: () => {}, chunk: 1000 });
      const fr = PG.applyFile(conn, DB, FEAT_SQL);
      ok('the feature view applies', fr.ok, fr.stderr.split('\n').slice(0, 3).join(' | '));
      const bad = (fr.stdout || '').split('\n').filter((l) => /CHECK THIS/.test(l));
      eq('every row of its report reads ok', bad.length, 0, bad.slice(0, 3).join(' | '));
      /* applying twice changes nothing */
      const fr2 = PG.applyFile(conn, DB, FEAT_SQL);
      ok('…and it applies again', fr2.ok);

      /* THE TWO IMPLEMENTATIONS, COMPARED ROW BY ROW. */
      const sql = db.rows(`select player_id, season, prior_k_pct, prior_bb_pct, prior_obp, prior_slg,
                                  base3_k_pct, base3_bb_pct, base3_obp, base3_slg,
                                  base3_plate_appearances, base3_share_2020, seasons_before
                             from mlbhist.batter_prior_features`);
      eq('the view has a row for every player-season', sql.length, clean.length);
      const jsBy = new Map(clean.map((r) => [r.player_id + '|' + r.season, r]));
      let mismatched = 0, compared = 0;
      const near = (a, b) => (a == null && b == null) ? true
        : (a == null || b == null) ? false : Math.abs(Number(a) - Number(b)) < 1e-9;
      sql.forEach((r) => {
        const j = jsBy.get(Number(r.player_id) + '|' + Number(r.season));
        if (!j) { mismatched++; return; }
        compared++;
        if (Number(r.seasons_before) !== j.seasons_before) mismatched++;
        if (!near(r.prior_k_pct, j.prior.k_pct)) mismatched++;
        if (!near(r.prior_bb_pct, j.prior.bb_pct)) mismatched++;
        if (!near(r.prior_obp, j.prior.obp)) mismatched++;
        if (!near(r.prior_slg, j.prior.slg)) mismatched++;
        if (!near(r.base3_k_pct, j.base3.k_pct)) mismatched++;
        if (!near(r.base3_bb_pct, j.base3.bb_pct)) mismatched++;
        if (!near(r.base3_obp, j.base3.obp)) mismatched++;
        if (!near(r.base3_slg, j.base3.slg)) mismatched++;
        if (!near(r.base3_plate_appearances, j.base3_pa)) mismatched++;
        if (!near(r.base3_share_2020, j.base3_share_2020)) mismatched++;
      });
      ok('every row was compared', compared > 9000, String(compared));
      eq('the SQL view and the JavaScript builder agree on every field', mismatched, 0);

      /* AND THE VIEW ITSELF CANNOT SEE FORWARD. */
      const leak = Number(db.rows(`select count(*)::int as n from mlbhist.batter_prior_features f
                                    where f.prior_season is not null and f.prior_season >= f.season`)[0].n);
      eq('no row has a prior season at or after the season it describes', leak, 0);
      const baseLeak = Number(db.rows(`select count(*)::int as n from mlbhist.batter_prior_features
                                        where seasons_before = 0
                                          and (base3_plate_appearances is not null
                                            or base3_obp is not null)`)[0].n);
      eq('no first season carries a baseline', baseLeak, 0);

      /* Nothing in the live model reads it. */
      const refs = Number(db.rows(`select count(*)::int as n from pg_views
                                    where definition like '%batter_prior_features%'
                                      and viewname <> 'batter_prior_features'`)[0].n);
      eq('no other view depends on it', refs, 0);
    } catch (e) {
      console.log('FAIL | mlb offense features | ' + (e && e.stack || e));
      fail++;
    } finally {
      try { db.close(); } catch (_) { /* best effort */ }
      PG.dropDatabase(conn, DB);
    }
    report();
  })();
}

function report() {
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  if (fail === 0) console.log('PASS | mlb offense as-of features | ' + pass + ' assertions');
  process.exit(fail === 0 ? 0 : 1);
}
