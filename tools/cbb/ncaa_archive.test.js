#!/usr/bin/env node
/* ===========================================================================
   THE NCAA SEASON ARCHIVE — SHAPING AND THE DERIVED RATES

   Two phases. The first is pure and needs no network: the CSV parser, the
   innings convention, the name repair, the synthetic identity and the merge.
   The second applies the schema to a real PostgreSQL and checks the rates the
   promote computes, because THIS is the source that can finally compute on-base
   and slugging and a wrong formula there would be invisible.

   Every expected number below is worked out by hand in the comment beside it.
   =========================================================================== */
'use strict';
const path = require('path');
const A = require('./ncaa_archive.js');

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d !== undefined ? '  ' + JSON.stringify(d) : '')); } };
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), { got: g, want: w });
const near = (n, g, w) => ok(n, g !== null && g !== undefined && Math.abs(Number(g) - w) < 1e-9, { got: g, want: w });

/* ── the CSV parser ──────────────────────────────────────────────────────── */
console.log('the CSV parser');
const rows = A.parseCsv('a,b,c\n1,2,3\n"x,y",2,3\n"say ""hi""",5,6\n');
eq('three data rows', rows.length, 3);
eq('columns are named', rows[0], { a: '1', b: '2', c: '3' });
/* THE REASON IT IS NOT A SPLIT ON COMMAS: a club or a name may contain one. */
eq('a quoted comma does not split the row', rows[1].a, 'x,y');
eq('a doubled quote is one quote', rows[2].a, 'say "hi"');
eq('a trailing newline does not make a blank row', A.parseCsv('a\n1\n').length, 1);

/* ── innings: thirds written as tenths ───────────────────────────────────── */
console.log('innings are thirds, written as tenths');
eq('a whole innings', A.ipToOuts('7.0'), 21);
eq('one out past seven', A.ipToOuts('7.1'), 22);
eq('two outs past seven', A.ipToOuts('7.2'), 23);
eq('a bare integer', A.ipToOuts('83'), 249);
eq('the upstream example: 83.2 is 251 outs', A.ipToOuts('83.2'), 251);
/* THE ASSERTION THAT MATTERS: the upstream package states that 83.2 + 89.1 is
   173 innings, not 172.3. In outs that is 251 + 268 = 519, and 519 / 3 = 173. */
eq('83.2 + 89.1 is 173 innings exactly', (A.ipToOuts('83.2') + A.ipToOuts('89.1')) / 3, 173);
eq('.3 is not a third of an inning and is refused', A.ipToOuts('7.3'), null);
eq('blank stays unknown', A.ipToOuts(''), null);

/* ── blank is unknown, never zero ────────────────────────────────────────── */
console.log('blank is unknown, never zero');
eq('a blank integer', A.int(''), null);
eq('a null integer', A.int(null), null);
eq('zero is still zero', A.int('0'), 0);
eq('a decimal games figure rounds', A.int('19.0'), 19);
eq('true', A.bool('True'), true);
eq('false', A.bool('False'), false);
eq('a blank boolean is unknown', A.bool(''), null);

/* ── names that arrive inside out ────────────────────────────────────────── */
console.log('names that arrive inside out');
/* This is a real row from the source. Nobody searches for "Jr., Guy Garibay". */
eq('a suffix pushed to the front is put back', A.fixName('Jr., Guy Garibay'), 'Guy Garibay Jr.');
eq('…and III likewise', A.fixName('III, Robert Smith'), 'Robert Smith III');
eq('an ordinary name is untouched', A.fixName('Ryker Waite'), 'Ryker Waite');
/* A GENUINE "Last, First" MUST NOT BE REARRANGED, because this code cannot tell
   which order was meant and guessing would mangle a correct name. */
eq('a non-suffix comma is left alone', A.fixName('Waite, Ryker'), 'Waite, Ryker');
eq('whitespace is collapsed', A.fixName('  Two   Spaces '), 'Two Spaces');
eq('an empty name is nothing', A.fixName('   '), null);

/* ── identity for the rows that have none ────────────────────────────────── */
console.log('identity for the rows that have none');
const sid = A.syntheticId(2021, 'RICE', 'Guy Garibay Jr.');
ok('a synthetic key is marked as one', /^unresolved:/.test(sid), sid);
eq('…and is deterministic', sid, A.syntheticId(2021, 'RICE', 'Guy Garibay Jr.'));
ok('…and cannot collide with a real id', sid.indexOf('n_q') !== 0);
ok('…and distinguishes two clubs', A.syntheticId(2021, 'RICE', 'A B') !== A.syntheticId(2021, 'LSU', 'A B'));
ok('…and two seasons', A.syntheticId(2021, 'RICE', 'A B') !== A.syntheticId(2022, 'RICE', 'A B'));

/* ── shaping a batting row ───────────────────────────────────────────────── */
console.log('a batting row');
const bat = A.shapeBatting({
  player_id: 'n_q007838', person_id: 'q007838', name: 'Brock Mitchell',
  team: 'AAMU', 'team name': 'Alabama A&M', division: '1', year: '2021',
  age: '', class: 'Fr', g: '19.0', pa: '57', ab: '50', h: '13', '2b': '3',
  '3b': '0', hr: '0', r: '6', rbi: '7', bb: '6', so: '9', hbp: '1', sf: '0',
  sh: '0', gdp: '', sb: '0', cs: '1', qualified: 'False',
});
eq('the season', bat.season, 2021);
eq('the id is the source\'s own', bat.player_id, 'n_q007838');
eq('…and is marked resolved', bat.identity_resolved, true);
eq('at-bats', bat.ab, 50);
eq('doubles — a column the box scores do not have', bat.doubles, 3);
eq('hit-by-pitch — likewise', bat.hbp, 1);
eq('sacrifice flies — likewise', bat.sf, 0);
eq('a blank GDP is unknown, not zero', bat.gdp, null);
eq('games survive the decimal', bat.b_games, 19);
eq('it is a batting row', bat.bats, true);
eq('the qualified flag comes through', bat.qualified_batting, false);

console.log('a batting row with no upstream identity');
const orphan = A.shapeBatting({
  player_id: '', person_id: '', name: 'Jr., Guy Garibay', team: 'RICE',
  'team name': 'Rice', division: '1', year: '2021', g: '40', ab: '120', h: '30',
});
ok('it is kept rather than dropped', orphan !== null);
eq('…marked as unresolved', orphan.identity_resolved, false);
eq('…with its name put back the right way round', orphan.name, 'Guy Garibay Jr.');
ok('…and keyed on season, club and name', /^unresolved:2021:rice:/.test(orphan.player_id), orphan.player_id);
eq('…and its statistics intact', [orphan.ab, orphan.h], [120, 30]);

console.log('a row with nothing to key on at all');
eq('no season is no row', A.shapeBatting({ player_id: 'x', name: 'A B', year: '' }), null);
eq('no name is no row', A.shapeBatting({ player_id: 'x', name: '', year: '2021' }), null);

/* ── shaping a pitching row ──────────────────────────────────────────────── */
console.log('a pitching row');
const pit = A.shapePitching({
  player_id: 'n_q007833', person_id: 'q007833', name: 'Cole Stewart',
  team: 'AAMU', 'team name': 'Alabama A&M', division: '1', year: '2021',
  class: 'Fr', w: '0.0', l: '0.0', g: '6', gs: '0', cg: '0.0', sho: '0.0',
  sv: '0.0', ip: '10.0', tbf: '60', h: '16', r: '19', er: '14', hr: '0',
  bb: '13', hbp: '1', wp: '2', bk: '0', so: '6', qualified: 'False',
});
eq('innings become outs', pit.outs, 30);
eq('batters faced', pit.tbf, 60);
eq('earned runs', pit.er, 14);
eq('it is a pitching row', pit.pitches, true);
ok('and it carries no batting columns', pit.ab === undefined);

/* ── the merge ───────────────────────────────────────────────────────────── */
console.log('the merge');
const merged = A.mergeSeasons(
  [A.shapeBatting({ player_id: 'p1', name: 'Two Way', team: 'X', year: '2025', g: '50', ab: '150', h: '45' }),
   A.shapeBatting({ player_id: 'p2', name: 'Hitter Only', team: 'X', year: '2025', g: '50', ab: '160', h: '40' })],
  [A.shapePitching({ player_id: 'p1', name: 'Two Way', team: 'X', year: '2025', g: '15', ip: '60.1', er: '20', so: '70' }),
   A.shapePitching({ player_id: 'p3', name: 'Pitcher Only', team: 'X', year: '2025', g: '20', ip: '40.0', er: '10', so: '50' })]
);
eq('three players, not four rows', merged.length, 3);
const tw = merged.find((r) => r.player_id === 'p1');
eq('the two-way player is ONE row', [tw.bats, tw.pitches], [true, true]);
eq('…with his batting half', tw.ab, 150);
eq('…and his pitching half', tw.outs, 181);
const ho = merged.find((r) => r.player_id === 'p2');
eq('a hitter who never pitched has no pitching half', [ho.bats, ho.pitches], [true, false]);
eq('…and null, not zero, in the pitching columns', [ho.outs, ho.er], [null, null]);
const po = merged.find((r) => r.player_id === 'p3');
eq('a pitcher who never batted has no batting half', [po.bats, po.pitches], [false, true]);
eq('…and null, not zero, in the batting columns', [po.ab, po.h], [null, null]);
eq('the same player in two seasons is two rows', A.mergeSeasons(
  [A.shapeBatting({ player_id: 'q', name: 'N', team: 'X', year: '2024', ab: '1', h: '1' }),
   A.shapeBatting({ player_id: 'q', name: 'N', team: 'X', year: '2025', ab: '2', h: '1' })], []).length, 2);

/* ── the impossible row ──────────────────────────────────────────────────── */
console.log('the row that cannot be true');
/* Roberto Pena, USF, 2021: 450 at-bats and no games recorded, where the highest
   total among all 32,161 rows that DO record games is 296. */
ok('450 at-bats in a season is refused',
  A.implausible({ season: 2021, ab: 450, h: 106, outs: null }));
eq('296 is not', A.implausible({ season: 2021, ab: 296, h: 90, outs: null }), null);
ok('more hits than at-bats is refused',
  A.implausible({ season: 2025, ab: 10, h: 11, outs: null }));
ok('a season outside the archive is refused',
  A.implausible({ season: 1850, ab: 10, h: 1, outs: null }));
eq('a row with unknowns is not accused',
  A.implausible({ season: 2025, ab: null, h: null, outs: null }), null);

/* ── the pin ─────────────────────────────────────────────────────────────── */
console.log('the source pin');
ok('both files are pinned by content hash',
  /^[0-9a-f]{64}$/.test(A.SOURCES.batting.sha256) && /^[0-9a-f]{64}$/.test(A.SOURCES.pitching.sha256));
ok('the pin names expected row counts too',
  A.SOURCES.batting.rows > 30000 && A.SOURCES.pitching.rows > 30000);
ok('the NCAA cache is the one read, not the FanGraphs one',
  /player_stats_cache_ncaa/.test(A.SOURCES.batting.url)
  && !/player_stats_cache\//.test(A.SOURCES.batting.url), A.SOURCES.batting.url);
ok('the upstream project is credited by name and licence',
  /ncaa_bbStats/.test(A.ATTRIBUTION) && /MIT/.test(A.ATTRIBUTION), A.ATTRIBUTION);

/* ═══ PHASE TWO: THE RATES THE PROMOTE COMPUTES ═══════════════════════════ */
const PG = require('../mlb/pg_client.js');
const DB = require('./db.js');
const ROOT = path.join(__dirname, '..', '..');
const TDB = 'edgedesk_cbb_ncaa';

(async function sqlPhase() {
  const conn = PG.findServer();
  if (!conn) { console.log('SKIP the SQL phase | no reachable PostgreSQL'); return; }
  if (!PG.createDatabase(conn, TDB)) { console.log('SKIP the SQL phase | no test database'); return; }
  const raw = PG.pgClient(conn, { database: TDB });
  try { raw.sql('create role anon nologin; create role authenticated nologin;'); } catch (_) {}
  const r = PG.applyFile(conn, TDB, path.join(ROOT, 'supabase', 'college_baseball.sql'));
  ok('the schema applies', r.ok !== false, r && r.error);
  const db = DB.wrap(raw);

  const COLS = ['season', 'player_id', 'identity_resolved', 'person_id', 'name',
    'team_code', 'team_name', 'division', 'class_year', 'bats', 'b_games', 'pa',
    'ab', 'h', 'doubles', 'triples', 'hr', 'r', 'rbi', 'bb', 'so', 'hbp', 'sf',
    'sh', 'gdp', 'sb', 'cs', 'qualified_batting', 'pitches', 'p_games', 'gs',
    'w', 'l', 'cg', 'sho', 'sv', 'outs', 'tbf', 'p_h', 'p_r', 'er', 'p_hr',
    'p_bb', 'p_hbp', 'wp', 'bk', 'p_so', 'qualified_pitching', 'source',
    'source_sha256'];
  const row = (o) => Object.assign({
    season: 2025, player_id: 'x', identity_resolved: true, person_id: null,
    name: 'A Player', team_code: 'X', team_name: 'Xavier', division: 1,
    class_year: 'Jr', bats: false, b_games: null, pa: null, ab: null, h: null,
    doubles: null, triples: null, hr: null, r: null, rbi: null, bb: null,
    so: null, hbp: null, sf: null, sh: null, gdp: null, sb: null, cs: null,
    qualified_batting: null, pitches: false, p_games: null, gs: null, w: null,
    l: null, cg: null, sho: null, sv: null, outs: null, tbf: null, p_h: null,
    p_r: null, er: null, p_hr: null, p_bb: null, p_hbp: null, wp: null,
    bk: null, p_so: null, qualified_pitching: null, source: 'ncaa_bbStats',
    source_sha256: 'deadbeef',
  }, o);

  const promote = async (id, rows, season) => {
    await db.startRun({ import_id: id, dataset: 'ncaa_seasons', status: 'staging',
      first_season: season || 2025, last_season: season || 2025, seasons: [season || 2025],
      source: A.ATTRIBUTION, source_note: 'test' });
    await db.stageRows('stg_ncaa_player_seasons', COLS, rows, id);
    return db.gate('promote_ncaa_seasons', ['p_import_id', 'p_allow_shrink', 'p_season'],
      { p_import_id: id, p_allow_shrink: false, p_season: season || null });
  };

  console.log('the rates this source can finally compute');
  /* ONE HITTER, WORKED OUT BY HAND.
       AB 100, H 30, 2B 6, 3B 1, HR 4, BB 10, HBP 2, SF 3
     total bases = 30 + 6 + 2*1 + 3*4 = 50
     average     = 30/100                              = .300
     slugging    = 50/100                              = .500
     on-base     = (30 + 10 + 2) / (100 + 10 + 2 + 3)
                 = 42 / 115                            = .365217...
     OPS         = .500 + .365217...                   = .865217...
     isolated    = (6 + 2 + 12) / 100                  = .200   (= SLG - AVG) */
  let v = await promote('n1', [row({ player_id: 'h1', bats: true, b_games: 50,
    pa: 115, ab: 100, h: 30, doubles: 6, triples: 1, hr: 4, bb: 10, hbp: 2, sf: 3,
    r: 20, rbi: 25, so: 18, sb: 5, cs: 1, qualified_batting: true })], 2025);
  ok('the import is accepted', v && v.ok === true, v);
  const h1 = raw.rows("select * from cbb.ncaa_player_seasons where player_id='h1'")[0];
  eq('total bases', Number(h1.total_bases), 50);
  near('batting average is 30 of 100', h1.batting_avg, 0.300);
  near('slugging is 50 total bases over 100 at-bats', h1.slg, 0.500);
  /* THE WHOLE POINT OF THIS SOURCE. The box-score archive could not compute
     this at all, because it has no hit-by-pitch and no sacrifice fly. */
  near('on-base is (H + BB + HBP) over (AB + BB + HBP + SF)', h1.obp, 42 / 115);
  ok('…and it is NOT the (H+BB)/(AB+BB) shortcut that would be a lie',
    Math.abs(Number(h1.obp) - (40 / 110)) > 1e-6, { obp: h1.obp, shortcut: 40 / 110 });
  near('OPS is on-base plus slugging', h1.ops, 0.5 + 42 / 115);
  near('isolated power is slugging minus average', h1.iso, 0.200);

  console.log('a pitcher, worked out by hand');
  /* outs 251 (that is 83.2 innings), ER 25, H 70, BB 20, SO 95, TBF 330
       ERA  = 25 * 27 / 251   = 2.689243...
       WHIP = (70 + 20) * 3 / 251 = 1.075697...
       K/9  = 95 * 27 / 251  = 10.219123...
       K%   = 95 / 330       = .287878... */
  v = await promote('n2', [row({ player_id: 'p1', pitches: true, p_games: 16,
    gs: 15, outs: 251, tbf: 330, p_h: 70, p_bb: 20, p_so: 95, er: 25, p_r: 30,
    w: 8, l: 3, qualified_pitching: true })], 2025);
  ok('the pitching import is accepted', v && v.ok === true, v);
  const p1 = raw.rows("select * from cbb.ncaa_player_seasons where player_id='p1'")[0];
  near('ERA over 251 outs', p1.era, 25 * 27 / 251);
  ok('…and NOT the figure a decimal-innings reading gives',
    Math.abs(Number(p1.era) - (25 * 9 / 83.2)) > 0.01, p1.era);
  near('WHIP', p1.whip, 90 * 3 / 251);
  near('strikeouts per nine', p1.k_per_9, 95 * 27 / 251);
  near('strikeout rate is per batter faced, which this source publishes', p1.k_pct, 95 / 330);

  console.log('a rate with no denominator is null, never zero');
  v = await promote('n3', [row({ player_id: 'z1', bats: true, b_games: 3, ab: 0, h: 0,
    pa: 2, bb: 2, r: 1 })], 2025);
  const z1 = raw.rows("select * from cbb.ncaa_player_seasons where player_id='z1'")[0];
  ok('a hitter with no at-bats has NO average', z1.batting_avg === null, z1.batting_avg);
  ok('…and no slugging', z1.slg === null, z1.slg);
  /* HE DOES HAVE AN ON-BASE FIGURE, and that is correct rather than an
     oversight: two walks in two plate appearances is a 1.000 on-base, because
     the denominator of OBP is not at-bats. */
  near('…but he DOES have an on-base figure, from the walks', z1.obp, 2 / 2);
  ok('a hitter has no ERA', z1.era === null, z1.era);

  console.log('the refusals');
  const before = () => Number(raw.rows('select count(*) n from cbb.ncaa_player_seasons')[0].n);
  const refuse = async (name, rows, season) => {
    const n0 = before();
    const res = await promote('r-' + name, rows, season);
    ok(name + ' is refused', res && res.ok !== true, res);
    eq('…and the archive is untouched', before(), n0);
    return res;
  };
  let res = await refuse('EMPTY_IMPORT', [], 2024);
  eq('…by name', res.refusals[0].refusal, 'EMPTY_IMPORT');
  res = await refuse('DUPLICATE_PLAYER_SEASON',
    [row({ season: 2024, player_id: 'd' }), row({ season: 2024, player_id: 'd' })], 2024);
  ok('…by name', res.refusals.some((x) => x.refusal === 'DUPLICATE_PLAYER_SEASON'), res.refusals);
  res = await refuse('HITS_EXCEED_AB', [row({ season: 2024, player_id: 'e', bats: true, ab: 10, h: 11 })], 2024);
  ok('…by name', res.refusals.some((x) => x.refusal === 'HITS_EXCEED_AB'), res.refusals);
  /* the Roberto Pena refusal */
  res = await refuse('IMPOSSIBLE_AB', [row({ season: 2024, player_id: 'f', bats: true, ab: 450, h: 106 })], 2024);
  ok('…by name', res.refusals.some((x) => x.refusal === 'IMPOSSIBLE_AB'), res.refusals);
  res = await refuse('SEASON_OUT_OF_RANGE', [row({ season: 1850, player_id: 'g' })], 1850);
  ok('…by name', res.refusals.some((x) => x.refusal === 'SEASON_OUT_OF_RANGE'), res.refusals);

  console.log('a row keyed on name is still readable, and says so');
  v = await promote('n4', [row({ season: 2023, player_id: 'unresolved:2023:rice:guy-garibay-jr',
    identity_resolved: false, name: 'Guy Garibay Jr.', team_code: 'RICE',
    bats: true, b_games: 40, ab: 120, h: 36 })], 2023);
  const un = raw.rows("select * from cbb.ncaa_player_seasons where season=2023")[0];
  eq('it is in the archive', un.name, 'Guy Garibay Jr.');
  eq('…flagged as unresolved', un.identity_resolved, false);
  near('…with its average computed like any other', un.batting_avg, 36 / 120);

  console.log('the archive status view');
  const st = raw.rows('select * from cbb.ncaa_archive_status order by season desc');
  ok('it reports a row per season', st.length >= 1, st.length);

  console.log('access');
  const denied = (sql) => {
    try { raw.sql(`set role anon; ${sql}; reset role;`); raw.sql('reset role'); return false; }
    catch (_) { try { raw.sql('reset role'); } catch (__) {} return true; }
  };
  ok('anon may read the archive', !denied('select 1 from cbb.ncaa_player_seasons limit 1'));
  ok('anon may NOT read its staging table', denied('select 1 from cbb.stg_ncaa_player_seasons limit 1'));
  ok('anon may NOT promote an import', denied("select cbb.promote_ncaa_seasons('x')"));
  ok('anon may NOT write a row',
    denied("insert into cbb.ncaa_player_seasons (season,player_id,name) values (2025,'zz','Q')"));

  try { PG.dropDatabase(conn, TDB); } catch (_) {}
})().then(() => {
  console.log(fail ? `FAILED ${pass} passed, ${fail} failed` : `ALL GREEN ${pass} passed, 0 failed`);
  console.log(fail ? `FAIL | cbb ncaa archive | ${fail} failed`
    : `PASS | cbb ncaa archive | ${pass} assertions`);
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.log('FAIL | cbb ncaa archive | ' + ((e && e.stack) || e));
  process.exit(1);
});
