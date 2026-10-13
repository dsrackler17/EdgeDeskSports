#!/usr/bin/env node
'use strict';
/* ===========================================================================
   The imported Quant Data Pack and the engine primitives ported from it.

   Proves: the CSV reader keeps quoted commas, quotes and newlines and never
   turns a blank into 0; engine/quant.js passes every case of the pack's own
   tests/test_quant_math.py (prices, no-vig, EV with push and void, quarter-
   line split settlement, exposures, baseball outs, shrinkage, and the
   fail-closed as-of rule); the verifier passes on the committed pack and
   catches a tampered file, a filled known_at and an invented xG; the
   external-file fetch accepts only the pack's exact bytes. The NHL pack
   (datapack/nhl_v1) passes its own verifier, which catches a backdated
   known_at, an invented xG and a changed lagged feature. The NFL pack
   (datapack/nfl_v1) does too, and its cross-check, crosswalk and research
   reports hold their stated rules.

   Run: node tools/datapack/datapack.test.js
   =========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const CSV = require(path.join(ROOT, 'engine', 'csv.js'));
const Q = require(path.join(ROOT, 'engine', 'quant.js'));
const { fetchExternal } = require('./fetch_external');

let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) { pass++; return; } fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); }
const near = (a, b, e) => Math.abs(a - b) <= (e || 1e-9);
const throws = (f) => { try { f(); return false; } catch (e) { return e.code === 'INVALID'; } };

/* 1. CSV */
const t = CSV.parseCsv('a,b,c\n1,"x, y","he said ""hi"""\n2,"line\nbreak",\r\n');
ok('quoted commas, doubled quotes and newlines survive', t.length === 3 && t[1][1] === 'x, y' && t[1][2] === 'he said "hi"' && t[2][1] === 'line\nbreak' && t[2][2] === '', t);
ok('a blank stays a blank string', CSV.parseCsv('a,b\n,1\n')[1][0] === '');
ok('an unterminated quote is an error, not a guess', (() => { try { CSV.parseCsv('a\n"open\n'); return false; } catch (_) { return true; } })());
ok('toCsv round-trips', JSON.stringify(CSV.parseCsv(CSV.toCsv(['a', 'b'], [{ a: 'x,"y"', b: null }]))) === JSON.stringify([['a', 'b'], ['x,"y"', '']]));

/* 2. engine/quant.js == the pack's tests/test_quant_math.py */
ok('american -> decimal', near(Q.americanToDecimal(-110), 1 + 100 / 110) && Q.americanToDecimal(150) === 2.5);
ok('decimal -> american round-trips', [-300, -110, 100, 150].every((x) => near(Q.decimalToAmerican(Q.americanToDecimal(x)), x)));
ok('invalid American odds throw', [0, 50, -50, NaN].every((x) => throws(() => Q.americanToDecimal(x))));
ok('no-vig', JSON.stringify(Q.proportionalNoVig([1.91, 1.91])) === JSON.stringify([0.5, 0.5]) && near(Q.proportionalNoVig([2.1, 3.2, 3.8]).reduce((a, b) => a + b, 0), 1));
ok('EV with a push', near(Q.expectedProfit(2.0, 0.5, 0.4, 0.1), 0.1) && near(Q.expectedProfit(2.0, 0, 0, 0, 1), 0) && throws(() => Q.expectedProfit(2, 0.6, 0.6)));
ok('quarter-line split settlement', near(Q.expectedSplitProfit(2, 0.2, 0.2, 0.2, 0.2, 0.2), 0) && near(Q.expectedSplitProfit(1.9, 0.5, 0.1, 0, 0.1, 0.3), (0.55) * 0.9 - 0.05 - 0.3));
ok('exposures', Q.safeRatio(1, 0) === null && near(Q.efg(40, 10, 90), 0.5) && near(Q.goalieGsax(3.4, 2), 1.4));
ok('baseball innings are outs', Q.parseBaseballInnings('5.2') === 17 && near(Q.inningsFromOuts(17), 5 + 2 / 3) && throws(() => Q.parseBaseballInnings('5.3')));
ok('shrinkage with no trials is the prior', near(Q.posteriorRate(0, 0, 0.3, 10), 0.3));
const recs = [{ record_id: 'A', revision: 1, known_at: '2024-01-01T10:00:00Z', v: 1 }, { record_id: 'A', revision: 2, known_at: '2024-01-01T12:00:00Z', v: 2 },
  { record_id: 'B', revision: 1, known_at: null, v: 7 }, { record_id: 'C', revision: 1, known_at: '2024-01-02T12:00:00Z', v: 9 }];
ok('as-of: the version known at the cutoff', Q.asofVersions(recs, '2024-01-01T11:00:00Z')[0].v === 1);
ok('as-of: unknown known_at never qualifies (fail closed)', Q.asofVersions(recs, '2024-01-01T13:00:00Z').length === 1 && Q.asofVersions(recs, '2024-01-01T13:00:00Z')[0].v === 2 && Q.asofVersions(recs, '2030-01-01T00:00:00Z').every((r) => r.record_id !== 'B'));
ok('as-of: a cutoff without a time zone is refused', throws(() => Q.asofVersions(recs, '2024-01-01T13:00:00')));

/* 3. the verifier on the committed pack */
const { verify } = require('./verify');
const v = verify();
ok('the committed pack verifies', v.status === 'PASSED', v.checks.filter((c) => !c.pass));
ok('42+ tables verified in the repository; NFL 2022 play-by-play is MISSING, not filled', v.summary.verified >= 42 && v.summary.failed === 0 && v.datasets.find((d) => d.file === 'data/nfl/play_by_play_2022.csv.gz').state === 'MISSING');
const committed = JSON.parse(fs.readFileSync(path.join(ROOT, 'datapack', 'quant_v1', 'EDGEDESK_VERIFICATION.json'), 'utf8'));
ok('the committed verification says PASSED', committed.status === 'PASSED' && committed.summary.missing === 1);
const imp = JSON.parse(fs.readFileSync(path.join(ROOT, 'datapack', 'quant_v1', 'IMPORT.json'), 'utf8'));
ok('the import record names the empty upload', imp.source_archives.some((a) => /NFL_2022/.test(a.name) && a.bytes === 0) && imp.excluded_from_git.some((e) => e.reason_code === 'EMPTY_UPLOAD'));
ok('no file larger than 20 MB is committed under datapack/', (function big(dir) { return fs.readdirSync(dir).every((f) => { const p = path.join(dir, f); const s = fs.statSync(p); return s.isDirectory() ? big(p) : s.size < 20e6; }); })(path.join(ROOT, 'datapack')));

/* tamper detection, on a copy */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edq-'));
function copyPack() {
  const dst = path.join(tmp, 'p' + Math.random().toString(36).slice(2));
  fs.cpSync(path.join(ROOT, 'datapack', 'quant_v1'), dst, { recursive: true });
  return dst;
}
function verifyAt(dir) {
  /* the verifier reads fixed paths: run it in a child with the pack swapped in */
  const { execFileSync } = require('child_process');
  const fake = path.join(tmp, 'root' + Math.random().toString(36).slice(2));
  fs.mkdirSync(path.join(fake, 'datapack'), { recursive: true });
  fs.mkdirSync(path.join(fake, 'tools', 'datapack'), { recursive: true });
  fs.mkdirSync(path.join(fake, 'engine'), { recursive: true });
  fs.symlinkSync(dir, path.join(fake, 'datapack', 'quant_v1'));
  fs.copyFileSync(path.join(__dirname, 'verify.js'), path.join(fake, 'tools', 'datapack', 'verify.js'));
  fs.copyFileSync(path.join(ROOT, 'engine', 'csv.js'), path.join(fake, 'engine', 'csv.js'));
  try { return JSON.parse(execFileSync('node', ['-e', 'const r=require(' + JSON.stringify(path.join(fake, 'tools', 'datapack', 'verify.js')) + ').verify();console.log(JSON.stringify(r.checks.filter(c=>!c.pass).map(c=>c.id)))'], { encoding: 'utf8' })); } catch (e) { return ['CRASH ' + e.message]; }
}
{
  const p = copyPack();
  const f = path.join(p, 'data', 'soccer', 'games_historical.csv');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('Arsenal', 'Arsenai'));
  ok('a changed byte fails the SHA-256 check', verifyAt(p).indexOf('csv_counts_sha256') >= 0);
}
{
  const p = copyPack();
  const f = path.join(p, 'data', 'nhl', 'goalie_game_observed_sample.csv');
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines[1] = lines[1].replace(/,,,(\r?)$/, ',2.71,0.3,$1');
  fs.writeFileSync(f, lines.join('\n'));
  const failed = verifyAt(p);
  ok('an invented goalie xG is caught', failed.indexOf('nhl_goalie_xg_gsax_not_invented') >= 0, failed);
}
{
  const p = copyPack();
  const f = path.join(p, 'data', 'nhl', 'games_historical.csv');
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines[1] = lines[1].replace(/,(\r?)$/, ',2024-10-01T23:30:00Z$1');
  fs.writeFileSync(f, lines.join('\n'));
  ok('a backdated known_at is caught', verifyAt(p).indexOf('historical_known_at_blank') >= 0);
}

/* 3b. the NHL data pack (datapack/nhl_v1) */
{
  const V = require('./verify_nhl');
  const r = V.verify();
  ok('NHL pack: the verifier passes every check on the committed pack', r.status === 'PASSED' && r.checks.every((c) => c.pass) && r.summary.verified === 11, r.checks.filter((c) => !c.pass));
  ok('NHL pack: the committed verification is a fresh run (time stamp aside)', (() => { const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'datapack', 'nhl_v1', 'EDGEDESK_VERIFICATION.json'), 'utf8')); delete c.verified_at; const x = JSON.parse(JSON.stringify(r)); delete x.verified_at; return JSON.stringify(c) === JSON.stringify(x); })());
  ok('NHL pack: 32 clubs, 1,312 + 86 games, the Four Nations events excluded and counted', r.findings.schedule_audit.national_team_events_excluded === 7 && r.checks.find((c) => c.id === 'scope_game_types').pass);
  ok('NHL pack: every lagged and measured feature recomputed, the target game excluded', r.checks.find((c) => c.id === 'lagged_features_recomputed_target_excluded').pass && r.checks.find((c) => c.id === 'measured_features_recomputed').pass);
  ok('NHL pack: blocked rows name the defending team natively; every count uses the shooter', r.findings.native_team_vs_shooting_team.blocked_native_is_defending_share > 0.9 && r.findings.native_team_vs_shooting_team.by_event_type.Shot.native_is_defending_team === 0);
  ok('NHL pack: SOG in these boxes is shootout goals, never shots on goal', r.checks.find((c) => c.id === 'sog_is_shootout_goals_never_outside_shootouts').pass && /shootout/.test(r.findings.sog_shootout_goals.note || 'shootout'));
  ok('NHL pack: the two large tables are stored gzipped and verified on their uncompressed bytes', JSON.parse(fs.readFileSync(path.join(ROOT, 'datapack', 'nhl_v1', 'IMPORT.json'), 'utf8')).stored_gzipped.length === 2 && r.datasets.filter((d) => /\.gz$/.test(d.stored_as)).every((d) => d.sha_ok));
  /* tamper, on a copy: a filled known_at, an invented xG and a changed lagged feature are each caught */
  const zlib = require('zlib');
  const tmpN = fs.mkdtempSync(path.join(os.tmpdir(), 'ednhl-'));
  const cp = path.join(tmpN, 'nhl_v1'); fs.cpSync(path.join(ROOT, 'datapack', 'nhl_v1'), cp, { recursive: true });
  const off = path.join(cp, 'data', 'officials.csv'); const ol = fs.readFileSync(off, 'utf8').split('\n'); ol[1] = ol[1].replace(/,(\r?)$/, ',2024-10-04T12:00:00Z$1'); fs.writeFileSync(off, ol.join('\n'));
  const sa = path.join(cp, 'data', 'shot_attempts.csv.gz'); fs.writeFileSync(sa, zlib.gzipSync(zlib.gunzipSync(fs.readFileSync(sa)).toString('utf8').replace('description_keyword_extraction_not_provider_structured_code,,', 'description_keyword_extraction_not_provider_structured_code,0.071,')));
  const lf = path.join(cp, 'data', 'pregame_lagged_research_features.csv'); const ll = fs.readFileSync(lf, 'utf8').split('\n'); const hdr = ll[0].split(','); const ci = hdr.indexOf('corsi_share_prior_10');
  const row = ll.findIndex((l, i) => i > 0 && l.split(',')[ci] && l.split(',')[ci] !== ''); const cells = ll[row].split(','); cells[ci] = String(Number(cells[ci]) + 0.01); ll[row] = cells.join(','); fs.writeFileSync(lf, ll.join('\n'));
  const { execFileSync } = require('child_process');
  let failed = [];
  try { failed = JSON.parse(execFileSync('node', ['-e', 'const r=require(' + JSON.stringify(path.join(__dirname, 'verify_nhl.js')) + ').verify();console.log(JSON.stringify(r.checks.filter(c=>!c.pass).map(c=>c.id)))'], { encoding: 'utf8', env: Object.assign({}, process.env, { EDGEDESK_NHL_PACK: cp }), maxBuffer: 1 << 26 })); } catch (e) { failed = ['CRASH ' + e.message]; }
  ok('NHL pack: a backdated known_at is caught', failed.indexOf('known_at_blank_everywhere') >= 0, failed);
  ok('NHL pack: an invented shot xG is caught', failed.indexOf('xg_never_filled') >= 0, failed);
  ok('NHL pack: a changed lagged feature is caught by the recomputation', failed.indexOf('lagged_features_recomputed_target_excluded') >= 0, failed);
  ok('NHL pack: each changed file fails its SHA-256', failed.indexOf('inventory_sha256_rows_columns') >= 0, failed);
  fs.rmSync(tmpN, { recursive: true, force: true });
}

/* 3c. the NFL data pack (datapack/nfl_v1) and what was built on it */
{
  const V = require('./verify_nfl');
  const r = V.verify();
  ok('NFL pack: the verifier passes every check on the committed pack', r.status === 'PASSED' && r.checks.every((c) => c.pass) && r.summary.verified === 42, r.checks.filter((c) => !c.pass));
  ok('NFL pack: the committed verification is a fresh run (time stamp aside)', (() => { const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'datapack', 'nfl_v1', 'EDGEDESK_VERIFICATION.json'), 'utf8')); delete c.verified_at; const x = JSON.parse(JSON.stringify(r)); delete x.verified_at; return JSON.stringify(c) === JSON.stringify(x); })());
  ok('NFL pack: 2025 and 2026 play-by-play recompute every team-game measure, opportunity cell and label', ['team_game_measures_recomputed_2025_2026', 'player_opportunities_recomputed_2025_2026', 'game_labels_recomputed_2025_2026', 'lagged_features_recomputed_target_excluded'].every((id) => r.checks.find((c) => c.id === id).pass));
  ok('NFL pack: 2026 is labelled PARTIAL, never a complete season', r.findings.current_season.state === 'PARTIAL' && /partial/.test(r.limitations.join(' ')));
  ok('NFL pack: NGS week 0 rows are counted apart from the weekly rows', Object.values(r.findings.ngs_grain).every((g) => g.week_0_rows > 0 && g.weekly_keys_unique));
  ok('NFL pack: injuries carry no publication time and depth snapshots are not announcements', r.checks.find((c) => c.id === 'injuries_have_no_publication_time').pass && /not a proven pregame announcement/.test(r.findings.time.depth_note));
  const xc = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'validation', 'nfl_pack_crosscheck.json'), 'utf8'));
  ok('NFL pack: every pack game 2022-2026 is in games.csv with the same final, spread and total label', xc.labels.matched === xc.labels.pack_games && xc.labels.final_agree === xc.labels.matched && xc.labels.spread_line_agree === xc.labels.matched, xc.labels);
  ok('NFL pack: the live 2026 team-week input tracks the pack\'s play-by-play (pass EPA r ≥ 0.95)', xc.live_input_2026.pass_epa.r >= 0.95 && xc.live_input_2026.in_both > 100, xc.live_input_2026);
  const cw = CSV.readCsv(path.join(ROOT, 'football', 'nfl', 'crosswalk', 'players_2024_2026.csv')).rows;
  ok('NFL pack: the player crosswalk leaves every conflicting id blank and names it', cw.length === xc.identity.players && cw.filter((x) => x.status !== 'OK').length === xc.identity.conflicts && cw.filter((x) => x.status !== 'OK').every((x) => /CONFLICT/.test(x.status)) && new Set(cw.filter((x) => x.pfr_id).map((x) => x.pfr_id)).size === cw.filter((x) => x.pfr_id).length && new Set(cw.filter((x) => x.espn_id).map((x) => x.espn_id)).size === cw.filter((x) => x.espn_id).length);
  const rs = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'validation', 'nfl_pack_research.json'), 'utf8'));
  ok('NFL pack: research is fitted on 2023-24 and scored on 2025-26 with a fixed bar, and claims nothing it did not clear', rs.windows.fit.join() === '2023,2024' && rs.windows.score.join() === '2025,2026' && [rs.carryover.reset_vs_cross, rs.carryover.chosen_decay_vs_cross, rs.qb_change.vs_without].every((t) => t.adds_information === (t.mse_change < 0 && t.ci95[1] < 0)) && /nothing here changes a price/.test(rs.conclusion.join(' ')));
  /* tamper, on a copy: a filled known_at, a changed 2025 team-game measure and a changed lagged feature are each caught */
  const tmpF = fs.mkdtempSync(path.join(os.tmpdir(), 'ednfl-'));
  const cp = path.join(tmpF, 'nfl_v1'); fs.cpSync(path.join(ROOT, 'datapack', 'nfl_v1'), cp, { recursive: true });
  const gl = path.join(cp, 'data', 'game_labels_2022_2026.csv'); const gll = fs.readFileSync(gl, 'utf8').split('\n'); gll[1] = gll[1].replace(/,(\r?)$/, ',2025-09-07T12:00:00Z$1'); fs.writeFileSync(gl, gll.join('\n'));
  const tg = path.join(cp, 'data', 'team_game_advanced_2022_2026.csv'); const tgl = fs.readFileSync(tg, 'utf8').split('\n'); const th = tgl[0].split(','); const pi = th.indexOf('plays');
  const ti = tgl.findIndex((l, i) => i > 0 && l.split(',')[th.indexOf('season')] === '2025'); const tc = tgl[ti].split(','); tc[pi] = String(Number(tc[pi]) + 1); tgl[ti] = tc.join(','); fs.writeFileSync(tg, tgl.join('\n'));
  const lf = path.join(cp, 'data', 'pregame_rolling_features_2022_2026.csv'); const lfl = fs.readFileSync(lf, 'utf8').split('\n'); const lh = lfl[0].split(','); const li = lh.indexOf('off_epa_per_play_prior_10');
  const lr = lfl.findIndex((l, i) => i > 0 && l.split(',')[li] !== ''); const lc = lfl[lr].split(','); lc[li] = String(Number(lc[li]) + 0.01); lfl[lr] = lc.join(','); fs.writeFileSync(lf, lfl.join('\n'));
  const { execFileSync } = require('child_process');
  let failed = [];
  try { failed = JSON.parse(execFileSync('node', ['-e', 'const r=require(' + JSON.stringify(path.join(__dirname, 'verify_nfl.js')) + ').verify();console.log(JSON.stringify(r.checks.filter(c=>!c.pass).map(c=>c.id)))'], { encoding: 'utf8', env: Object.assign({}, process.env, { EDGEDESK_NFL_PACK: cp }), maxBuffer: 1 << 26 })); } catch (e) { failed = ['CRASH ' + e.message]; }
  ok('NFL pack: a backdated known_at is caught', failed.indexOf('known_at_blank_everywhere') >= 0, failed);
  ok('NFL pack: a changed 2025 team-game measure is caught by the play-by-play recomputation', failed.indexOf('team_game_measures_recomputed_2025_2026') >= 0, failed);
  ok('NFL pack: a changed lagged feature is caught by the recomputation', failed.indexOf('lagged_features_recomputed_target_excluded') >= 0, failed);
  fs.rmSync(tmpF, { recursive: true, force: true });
}

/* 4. the external fetch: only the pack's exact bytes */
(async function () {
  const packDir = path.join(tmp, 'extpack');
  fs.mkdirSync(packDir);
  const good = Buffer.from('pbp-2023-bytes'); const revised = Buffer.from('pbp-2024-revised');
  fs.writeFileSync(path.join(packDir, 'IMPORT.json'), JSON.stringify({ excluded_from_git: [
    { file: 'data/nfl/a.csv.gz', reason_code: 'SIZE_EXTERNAL', source_url: 'https://github.com/x/a', sha256: crypto.createHash('sha256').update(good).digest('hex') },
    { file: 'data/nfl/b.csv.gz', reason_code: 'SIZE_EXTERNAL', source_url: 'https://github.com/x/b', sha256: crypto.createHash('sha256').update(Buffer.from('original')).digest('hex') },
    { file: 'data/nfl/c.csv.gz', reason_code: 'EMPTY_UPLOAD', source_url: 'https://github.com/x/c', sha256: 'f'.repeat(64) },
  ] }));
  const served = { 'https://github.com/x/a': good, 'https://github.com/x/b': revised, 'https://github.com/x/c': revised };
  const calls = [];
  const client = { get: async (u) => { calls.push(u); return { ok: true, status: 200, body: served[u] }; } };
  const dest = path.join(tmp, 'dest');
  const r = await fetchExternal({ pack: packDir, dest, client });
  const st = Object.fromEntries(r.files.map((x) => [x.file, x.state]));
  ok('matching bytes are stored as the pack file', st['data/nfl/a.csv.gz'] === 'VERIFIED' && fs.existsSync(path.join(dest, 'data/nfl/a.csv.gz')), r.files);
  ok('revised bytes are refused and named, never stored', st['data/nfl/b.csv.gz'] === 'REVISED_AT_SOURCE' && !fs.existsSync(path.join(dest, 'data/nfl/b.csv.gz')));
  ok('a file the upload lacked stays MISSING unless the source serves the exact bytes', st['data/nfl/c.csv.gz'] === 'MISSING' && !fs.existsSync(path.join(dest, 'data/nfl/c.csv.gz')));
  calls.length = 0;
  const r2 = await fetchExternal({ pack: packDir, dest, client });
  ok('a verified copy is not fetched again', calls.indexOf('https://github.com/x/a') < 0 && r2.files[0].from === 'cache');
  const r3 = await fetchExternal({ pack: packDir, dest: path.join(tmp, 'd3'), client: { get: async () => ({ ok: false, error: 'BREAKER_OPEN' }) } });
  ok('a failed fetch says EXTERNAL/MISSING with the reason', r3.files[0].state === 'EXTERNAL' && /BREAKER_OPEN/.test(r3.files[0].reason) && r3.files[2].state === 'MISSING');
  ok('the fetcher registers only the free github.com host', Object.keys(require('./fetch_external').PROVIDERS).join() === 'github_release' && require('./fetch_external').PROVIDERS.github_release.paid === false);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'data pack — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log('FAIL | ' + (e && e.stack || e)); process.exit(1); });
