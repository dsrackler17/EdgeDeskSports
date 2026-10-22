#!/usr/bin/env node
/* ===========================================================================
   CFB REFEREE FLAGS (supabase/cfb_refs.sql), AGAINST A REAL POSTGRESQL.

   The card shows a referee's flag tendencies; the rules that keep that honest
   live in the database and are proved here by a server, not by reading SQL:
     - the seed loads all 2,366 games of data/refs/cfb/cfb_ref_game_penalties.csv,
       through the same payload tools/refs/cfb_refs.py sends, and re-seeding
       never undoes the ESPN backfill;
     - the backfill fills only games with no referee, never an
       assignment_conflict game, with source espn / identity espn_referee_role
       and the dataset's conference (never the home team's);
     - a weekly pull only fills what is missing;
     - an assignment's first_observed_at can never be rewritten, a replaced
       referee keeps its row, the current one is the latest observation;
     - the views reproduce the dataset's own summary (cfb_ref_summary.csv) and
       conference baselines (cfb_conference_baselines.csv); refs under 3 games
       have numbers but no rank;
     - anon reads, nobody but service_role writes.

   Starts a throwaway cluster, applies the Supabase shim, applies the file twice
   with psql and once the way the SQL editor sends it (one string).

   Run: node tools/refs/cfb_refs_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'cfb_refs.sql'), 'utf8');
const SHIM = fs.readFileSync(path.join(ROOT, 'tools', 'games', 'sql', 'supabase_shim.sql'), 'utf8');
const DATA = path.join(ROOT, 'data', 'refs', 'cfb');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function done(note) {
  if (note && /^SKIP/.test(note) && process.env.CFB_REFS_SQL_REQUIRED === '1') { fail++; failures.push({ name: 'Postgres is required here (CFB_REFS_SQL_REQUIRED=1) but ' + note }); }
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 600) : '')));
  if (note) console.log(note);
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; continue; }
    if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift();
  return rows.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

/* ═══ STATIC ═══════════════════════════════════════════════════════════ */
const meta = SQL.split('\n').filter((l) => l.trimStart().startsWith('\\'));
chk('cfb_refs.sql has no psql meta-command (the SQL editor cannot run one)', meta.length === 0, meta.slice(0, 3));
chk('cfb_refs.sql ends in a report select', /\n(select|with)[\s\S]*;\s*$/i.test(SQL) && /CHECK THIS/.test(SQL));
chk('cfb_refs.sql drops nothing but triggers and policies',
  !/\bdrop\s+(table|view|schema|function|index|column)\b/i.test(SQL) && !/\btruncate\b\s+(table\s+)?public\./i.test(SQL));
const mig = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations')).filter((f) => /_cfb_refs\.sql$/.test(f));
chk('mirrored once in supabase/migrations/, byte for byte', mig.length === 1
  && fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', mig[0]), 'utf8') === SQL, mig);
chk('tables are created idempotently', ['cfb_ref_game_penalties', 'cfb_ref_assignments'].every((t) => SQL.includes('create table if not exists public.' + t + ' (')));
chk('every view runs as the reader', (SQL.match(/create or replace view public\.\w+ with \(security_invoker = true\)/g) || []).length === 5
  && !/create or replace view public\.\w+ as/.test(SQL));
chk('the writers are security definer with a pinned search_path',
  ['cfb_ref_merge_games', 'cfb_ref_observe_assignments'].every((f) =>
    new RegExp('function public\\.' + f + '\\([^)]*\\)[\\s\\S]{0,120}security definer set search_path = pg_catalog, pg_temp').test(SQL)));
chk('PostgREST is told to reload', /notify\s+pgrst\s*,\s*'reload schema'/i.test(SQL));
chk('policies are select-only', !/create policy[^;]*for (insert|update|delete|all)/i.test(SQL));
chk('the conference comes from the dataset rows, never the home team',
  /referee_source in \('ncaa_listed', 'ncaa_matched_by_date_teams'\)/.test(SQL)
  && !/referee_primary_conf\s*=\s*[^,;]*home_conference/i.test(SQL));

/* ═══ LIVE ═══════════════════════════════════════════════════════════════ */
function findPgBin() {
  const cands = ['pg_ctl'].concat(
    (() => { try { return fs.readdirSync('/usr/lib/postgresql').sort().reverse().map((v) => '/usr/lib/postgresql/' + v + '/bin/pg_ctl'); } catch (_) { return []; } })());
  for (const c of cands) {
    try {
      cp.execSync(`${c} --version`, { stdio: 'ignore' });
      return c === 'pg_ctl' ? path.dirname(cp.execSync('command -v pg_ctl').toString().trim()) : path.dirname(c);
    } catch (_) { /* keep looking */ }
  }
  return null;
}
const BIN = findPgBin();
if (!BIN) done('SKIP | no postgres binary (pg_ctl) found — the LIVE layer did not run. CI installs postgres.');

const PORT = 56500 + (process.pid % 200);
const asPostgres = process.getuid && process.getuid() === 0;
let HOME;
try {
  HOME = asPostgres ? fs.mkdtempSync('/var/lib/postgresql/cfbrefs-') : fs.mkdtempSync(path.join(os.tmpdir(), 'cfbrefs-'));
} catch (e) { done('SKIP | cannot create a cluster directory (' + String(e.message).slice(0, 120) + ') — LIVE layer skipped.'); }
const PGDATA = path.join(HOME, 'data');
const run = (cmd) => cp.execSync(asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd, { stdio: 'pipe', encoding: 'utf8' });
let started = false;
try {
  if (asPostgres) cp.execSync(`chown -R postgres ${HOME} && chmod 700 ${HOME}`);
  run(`${BIN}/initdb -D ${PGDATA} -U postgres -A trust -E UTF8 --locale=C`);
  run(`${BIN}/pg_ctl -D ${PGDATA} -o "-p ${PORT} -k ${HOME} -c listen_addresses=" -l ${HOME}/log start -w -t 30`);
  started = true;
} catch (e) {
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) { /* nothing to clean */ }
  done('SKIP | postgres would not start (' + String(e.message).slice(0, 160) + ') — LIVE layer skipped.');
}
function stop() { if (started) { try { run(`${BIN}/pg_ctl -D ${PGDATA} stop -m immediate`); } catch (_) { /* gone */ } } try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) { /* gone */ } }
process.on('exit', stop);

const PSQL = fs.existsSync(path.join(BIN, 'psql')) ? path.join(BIN, 'psql') : 'psql';
function psql(sql, opts) {
  opts = opts || {};
  const args = ['-X', '-q', '-h', HOME, '-p', String(PORT), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-t', '-A'];
  if (opts.command) args.push('-c', sql);
  else args.push('-f', '-');
  const input = opts.command ? undefined : (opts.role ? 'set role ' + opts.role + ';\n' : '') + sql;
  return cp.execFileSync(PSQL, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 << 20,
    env: Object.assign({}, process.env, { PGCLIENTENCODING: 'UTF8' }) }).trim();
}
function mustFail(sql, opts) { try { psql(sql, opts); return null; } catch (e) { return String(e.stderr || e.stdout || e.message); } }
function qj(sql, opts) { const out = psql(sql, opts); const last = out.split('\n').filter(Boolean).pop(); return last === undefined ? null : JSON.parse(last); }
const lit = (o) => "'" + JSON.stringify(o).replace(/'/g, "''") + "'::jsonb";
const merge = (rows, mode) => qj(`select public.cfb_ref_merge_games(${lit(rows)}, '${mode}')`, { role: 'service_role' });
const observe = (rows) => qj(`select public.cfb_ref_observe_assignments(${lit(rows)})`, { role: 'service_role' });

function reportRows(out) { return out.split('\n').filter((l) => /^\d /.test(l)).map((l) => { const [p, s] = l.split('|'); return { piece: p, state: s }; }); }

try {
  psql(SHIM);
  const r1 = reportRows(psql(SQL));
  const r2 = reportRows(psql(SQL));
  const r3 = reportRows(psql(SQL, { command: true }));
  chk('applies cleanly, twice and as one editor string: 7 report rows each', r1.length === 7 && r2.length === 7 && r3.length === 7, { r1, r3 });
  chk('every report row says ok before the seed, row 7 says pending',
    r3.filter((r) => !/^7 /.test(r.piece)).every((r) => r.state === 'ok') && /^pending/.test((r3.find((r) => /^7 /.test(r.piece)) || {}).state || ''), r3);

  /* ---------------------------------------------------- the seed, as the tool sends it */
  const EMIT = path.join(HOME, 'seed.json');
  cp.execFileSync('python3', ['-I', path.join(ROOT, 'tools', 'refs', 'cfb_refs.py'), 'seed', '--emit', EMIT],
    { stdio: 'pipe', encoding: 'utf8', env: Object.assign({}, process.env, { SB_URL: '', SB_SERVICE_ROLE: '', GITHUB_STEP_SUMMARY: '' }) });
  if (asPostgres) cp.execSync(`chmod 644 ${EMIT}`);
  const payload = JSON.parse(fs.readFileSync(EMIT, 'utf8'));
  chk('the tool emits 2,366 seed rows', payload.seed.length === 2366, payload.seed.length);
  let ins = 0;
  for (let i = 0; i < payload.seed.length; i += 400) ins += merge(payload.seed.slice(i, i + 400), 'seed').inserted;
  chk('seed: 2,366 rows inserted on an empty table', ins === 2366, ins);
  const again = merge(payload.seed.slice(0, 400), 'seed');
  chk('seed again: an upsert on game_id (updates, inserts nothing)', again.inserted === 0 && again.updated === 400, again);
  const bySeason = psql(`select string_agg(season || ':' || n, ',' order by season) from (select season, count(*) n from public.cfb_ref_game_penalties group by 1) x`);
  chk('2024: 919, 2025: 934, 2026: 513', bySeason === '2024:919,2025:934,2026:513', bySeason);
  chk('124 games without a referee, 13 of them assignment_conflict',
    psql(`select count(*) filter (where referee_id is null) || ',' || count(*) filter (where assignment_conflict) from public.cfb_ref_game_penalties`) === '124,13');
  const r4 = reportRows(psql(SQL, { command: true }));
  chk('after the seed every report row says ok', r4.length === 7 && r4.every((r) => r.state === 'ok'), r4);

  /* ---------------------------------------------------- the views reproduce the dataset's summary */
  const summ = parseCsv(fs.readFileSync(path.join(DATA, 'cfb_ref_summary.csv'), 'utf8'));
  const view = JSON.parse(psql(`select coalesce(json_agg(s), '[]') from public.cfb_ref_season_summary s`));
  const v3 = JSON.parse(psql(`select coalesce(json_agg(s), '[]') from public.cfb_ref_baseline_3yr s`));
  const vk = new Map(view.map((r) => [r.season + '|' + r.referee_id, r]));
  const v3k = new Map(v3.map((r) => [r.referee_id, r]));
  /* within a cent: the dataset rounded with pandas (half to even, and a difference
     of two rounded means), the views with Postgres (half up, then the difference) */
  const near = (a, b, tol) => (a === null || a === undefined || a === '') ? (b === null || b === undefined || b === '' || Number.isNaN(Number(b))) : Math.abs(Number(a) - Number(b)) < (tol || 0.006);
  let bad = [];
  summ.forEach((s) => {
    const v = s.window === '2024-2026' ? v3k.get(s.referee_id) : vk.get(s.window + '|' + s.referee_id);
    if (!v) { bad.push(['missing', s.window, s.referee_id]); return; }
    const pairs = [['games', 'games'], ['flags_pg', 'flags_pg'], ['holding_total_pg', 'holding_pg'], ['off_holding_pg', 'off_holding_pg']];
    if (s.window !== '2024-2026') pairs.push(['def_holding_pg', 'def_holding_pg'], ['dpi_pg', 'dpi_pg'], ['penalty_yards_pg', 'penalty_yards_pg'], ['home_minus_away_pg', 'home_minus_away_pg']);
    pairs.forEach(([c, vc]) => { if (!near(v[vc], s[c] === '' ? null : s[c], 0.0101)) bad.push([s.window, s.referee_id, c, s[c], v[vc]]); });
    if ((s.primary_conf || null) !== (v.primary_conf || null)) bad.push([s.window, s.referee_id, 'primary_conf', s.primary_conf, v.primary_conf]);
  });
  chk('per-ref numbers and conference match cfb_ref_summary.csv on all ' + summ.length + ' rows (season and 3-yr)', bad.length === 0 && summ.length === 435, bad.slice(0, 8));
  chk('every season-summary row is in the dataset summary (no extra referee)', view.length === summ.filter((s) => s.window !== '2024-2026').length, [view.length]);

  const base = parseCsv(fs.readFileSync(path.join(DATA, 'cfb_conference_baselines.csv'), 'utf8'));
  bad = [];
  base.forEach((b) => {
    const v = view.find((r) => String(r.season) === b.season && r.primary_conf === b.home_conference);
    if (v && !(near(v.conf_flags_pg, b.flags_pg, 0.0101) && near(v.conf_holding_pg, b.holding_pg, 0.0101))) bad.push([b.season, b.home_conference, b.flags_pg, v.conf_flags_pg, b.holding_pg, v.conf_holding_pg]);
  });
  chk('conference averages match cfb_conference_baselines.csv', bad.length === 0, bad);
  chk('vs conference = his average minus his conference average', view.every((r) => r.conf_flags_pg === null
    || (near(r.flags_vs_conf_pg, Number(r.flags_pg) - Number(r.conf_flags_pg), 0.0101) && near(r.holding_vs_conf_pg, Number(r.holding_pg) - Number(r.conf_holding_pg), 0.0101))),
    view.filter((r) => r.conf_flags_pg !== null && !near(r.flags_vs_conf_pg, Number(r.flags_pg) - Number(r.conf_flags_pg), 0.0101)).slice(0, 3));
  /* The conference and FBS averages are every game's (data/refs/cfb/cfb_schema.sql, and
     cfb_conference_baselines.csv above); cfb_ref_summary.csv's vs-conference column averaged
     only games with a known referee, so it is not compared. */

  const under3 = view.filter((r) => r.games < 3), over3 = view.filter((r) => r.games >= 3);
  chk('under 3 games: numbers shown, no rank', under3.length > 0 && under3.every((r) => r.flags_pg !== null && r.flags_rank_fbs === null && r.flags_rank_in_conf === null), under3.slice(0, 2));
  chk('3+ games: an FBS rank; a conference rank only with a conference', over3.every((r) => r.flags_rank_fbs >= 1 && (r.primary_conf ? r.flags_rank_in_conf >= 1 && r.conf_refs_ranked >= r.flags_rank_in_conf : r.flags_rank_in_conf === null)), over3.filter((r) => !(r.flags_rank_fbs >= 1)).slice(0, 2));
  chk('rank 1 = most flags in the conference', (() => {
    const g = over3.filter((r) => r.season === 2025 && r.primary_conf === 'SEC').sort((a, b) => a.flags_rank_in_conf - b.flags_rank_in_conf);
    return g.length >= 3 && Number(g[0].flags_pg) >= Number(g[g.length - 1].flags_pg) && g[0].conf_refs_ranked === g.length;
  })());

  /* ---------------------------------------------------- reading and writing rights */
  chk('anon reads the game context', psql(`select count(*) > 0 from public.cfb_game_ref_context`, { role: 'anon' }) === 't');
  chk('authenticated reads the game context', psql(`select count(*) > 0 from public.cfb_game_ref_context`, { role: 'authenticated' }) === 't');
  chk('anon cannot insert a game', !!mustFail(`insert into public.cfb_ref_game_penalties (game_id, season) values (1, 2026)`, { role: 'anon' }));
  chk('authenticated cannot update a referee', !!mustFail(`update public.cfb_ref_game_penalties set referee_id = 'x' where game_id = 401635525`, { role: 'authenticated' }));
  chk('anon cannot call the merge', !!mustFail(`select public.cfb_ref_merge_games('[]'::jsonb, 'seed')`, { role: 'anon' }));
  chk('authenticated cannot record an assignment', !!mustFail(`select public.cfb_ref_observe_assignments('[]'::jsonb)`, { role: 'authenticated' }));
  chk('an unknown mode is refused', /unknown mode/.test(mustFail(`select public.cfb_ref_merge_games('[{"game_id":1}]'::jsonb, 'overwrite')`, { role: 'service_role' }) || ''));

  /* ---------------------------------------------------- the ESPN backfill */
  const miss = parseCsv(fs.readFileSync(path.join(DATA, 'cfb_games_missing_referee.csv'), 'utf8'));
  const open = miss.find((m) => m.assignment_conflict === 'False' && m.season === '2026');
  const open2 = miss.filter((m) => m.assignment_conflict === 'False' && m.season === '2026')[1];
  const conflict = miss.find((m) => m.assignment_conflict === 'True');
  const known = psql(`select referee_id || '|' || referee || '|' || referee_primary_conf from public.cfb_ref_game_penalties where referee_primary_conf = 'SEC' and referee_source = 'ncaa_listed' order by game_id limit 1`).split('|');
  const bf = merge([{ game_id: +open.game_id, referee_id: known[0], referee: known[1], referee_primary_conf: 'Big Ten' },
    { game_id: +open2.game_id, referee_id: 'newcfbofficial', referee: 'New Official' },
    { game_id: +conflict.game_id, referee_id: known[0], referee: known[1] },
    { game_id: 401635525, referee_id: 'someoneelse', referee: 'Someone Else' }], 'espn_referee');
  chk('backfill: fills only the two open games (not the conflict, not a game that has a referee)', bf.updated === 2, bf);
  const f1 = psql(`select referee_id || '|' || referee_source || '|' || referee_identity || '|' || coalesce(referee_primary_conf, '-') from public.cfb_ref_game_penalties where game_id = ${open.game_id}`);
  chk('a filled game: source espn, identity espn_referee_role, the dataset conference (the payload\'s is ignored)', f1 === `${known[0]}|espn|espn_referee_role|${known[2]}`, f1);
  chk('a referee new to the dataset gets no conference', psql(`select coalesce(referee_primary_conf, '-') from public.cfb_ref_game_penalties where game_id = ${open2.game_id}`) === '-');
  chk('assignment_conflict rows are left alone', psql(`select coalesce(referee_id, '-') || assignment_conflict from public.cfb_ref_game_penalties where game_id = ${conflict.game_id}`) === '-true');
  chk('a game with an NCAA referee keeps it', psql(`select referee_id || referee_source from public.cfb_ref_game_penalties where game_id = 401635525`) === 'jerrymagallanesncaa_listed');
  const seedOpen = payload.seed.filter((r) => String(r.game_id) === open.game_id);
  merge(seedOpen, 'seed');
  chk('re-seeding (the file still has no referee) does not undo the ESPN fill', psql(`select referee_id || '|' || referee_source from public.cfb_ref_game_penalties where game_id = ${open.game_id}`) === `${known[0]}|espn`);
  chk('the backfilled referee does not enter the conference mapping', psql(`select coalesce(primary_conf, '-') from public.cfb_ref_referees where referee_id = 'newcfbofficial'`) === '-');

  /* ---------------------------------------------------- the Sunday pull */
  const before = psql(`select flags || '|' || coalesce(holding_total::text, '-') || '|' || referee_id from public.cfb_ref_game_penalties where game_id = 401635525`);
  const fin = merge([
    { game_id: 401635525, season: 2024, week: 1, flags: 99, holding_total: 99, referee_id: 'someoneelse', referee: 'X' },
    { game_id: 499000001, season: 2026, week: 8, start_date: '2026-10-24T19:30:00Z', home_team: 'Alpha', away_team: 'Beta',
      home_conference: 'SEC', away_conference: 'SEC', home_points: 24, away_points: 21, flags: 14, penalty_yards: 120,
      home_flags: 8, away_flags: 6, holding_total: 3, off_holding: 2, def_holding: 1, holding_side_unknown: 0, dpi: 1, opi: 0,
      false_start: 2, scrimmage_plays: 140, flags_per_100_plays: 10, pbp_available: true, referee_id: known[0], referee: known[1] }], 'espn_final');
  chk('finals: a new game is inserted, a stored one with nothing missing is unchanged', fin.inserted === 1 && fin.updated === 0, fin);
  chk('finals never rewrite a validated number or referee', psql(`select flags || '|' || coalesce(holding_total::text, '-') || '|' || referee_id from public.cfb_ref_game_penalties where game_id = 401635525`) === before);
  chk('a weekly game carries the ESPN referee with the dataset conference',
    psql(`select referee_source || '|' || referee_identity || '|' || referee_primary_conf from public.cfb_ref_game_penalties where game_id = 499000001`) === `espn|espn_referee_role|${known[2]}`);
  psql(`update public.cfb_ref_game_penalties set holding_total = null where game_id = 499000001`);
  const fill = merge([{ game_id: 499000001, season: 2026, holding_total: 5, flags: 50 }], 'espn_final');
  chk('finals fill only a null column', fill.updated === 1 && psql(`select holding_total || '|' || flags from public.cfb_ref_game_penalties where game_id = 499000001`) === '5|14', fill);

  /* ---------------------------------------------------- assignments keep history */
  const G = 499000100;
  const a1 = observe([{ game_id: G, season: 2026, week: 8, referee_id: known[0], referee: known[1], source: 'espn' }]);
  const t1 = psql(`select first_observed_at from public.cfb_ref_assignments where game_id = ${G} and referee_id = '${known[0]}'`);
  chk('a first observation is new', a1.new === 1 && a1.replaced === 0, a1);
  chk('no assignment yet: the game has no context row ("Assignment not announced")', psql(`select count(*) from public.cfb_game_ref_context where game_id = ${G + 1}`) === '0');
  const ctx1 = JSON.parse(psql(`select row_to_json(c) from public.cfb_game_ref_context c where game_id = ${G}`));
  chk('an assignment: the context names him, his conference, season and 3-yr numbers', ctx1.basis === 'assignment' && ctx1.referee_id === known[0]
    && ctx1.primary_conf === known[2] && ctx1.season_games > 0 && ctx1.y3_games > 0 && !!ctx1.first_observed_at && ctx1.referee === known[1]
    && ctx1.source === 'espn' && ctx1.referee_identity === 'espn_referee_role', ctx1);
  const a2 = observe([{ game_id: G, season: 2026, week: 8, referee_id: known[0], referee: known[1] }]);
  chk('seen again: first_observed_at unchanged, last_observed_at moved', a2.seen_again === 1
    && psql(`select first_observed_at from public.cfb_ref_assignments where game_id = ${G} and referee_id = '${known[0]}'`) === t1
    && psql(`select last_observed_at > first_observed_at from public.cfb_ref_assignments where game_id = ${G} and referee_id = '${known[0]}'`) === 't', a2);
  const a3 = observe([{ game_id: G, season: 2026, week: 8, referee_id: 'jerrymagallanes', referee: 'Jerry Magallanes' }]);
  chk('ESPN changes the referee: the replacement is a new row, the earlier one is kept', a3.new === 1 && a3.replaced === 1
    && psql(`select count(*) from public.cfb_ref_assignments where game_id = ${G}`) === '2', a3);
  const ctx2 = JSON.parse(psql(`select row_to_json(c) from public.cfb_game_ref_context c where game_id = ${G}`));
  chk('the card shows the replacement, with its own first_observed_at, and that it changed', ctx2.referee_id === 'jerrymagallanes' && ctx2.observed_referees === 2
    && ctx2.first_observed_at && ctx2.first_observed_at !== ctx1.first_observed_at, ctx2);
  observe([{ game_id: G, season: 2026, week: 8, referee_id: known[0], referee: known[1] }]);
  chk('back to the first referee: he is current again, his first_observed_at still the first one',
    psql(`select referee_id from public.cfb_ref_assignment_current where game_id = ${G}`) === known[0]
    && psql(`select first_observed_at from public.cfb_ref_assignments where game_id = ${G} and referee_id = '${known[0]}'`) === t1);
  chk('first_observed_at cannot be rewritten (not even by the owner)', /only last_observed_at may change/.test(mustFail(`update public.cfb_ref_assignments set first_observed_at = now() - interval '1 day' where game_id = ${G}`) || ''));
  chk('an observation cannot be deleted', /keeps every observation/.test(mustFail(`delete from public.cfb_ref_assignments where game_id = ${G}`) || ''));
  chk('nor truncated', /keeps every observation/.test(mustFail(`truncate public.cfb_ref_assignments`) || ''));
  chk('last_observed_at never moves backwards', (() => {
    psql(`update public.cfb_ref_assignments set last_observed_at = '2000-01-01' where game_id = ${G} and referee_id = '${known[0]}'`);
    return psql(`select last_observed_at > '2001-01-01' from public.cfb_ref_assignments where game_id = ${G} and referee_id = '${known[0]}'`) === 't';
  })());
  const asg = observe([{ game_id: G + 2, season: 2026, week: 8, referee_id: 'brandnewcrew', referee: 'Brand New' }]);
  const ctx3 = JSON.parse(psql(`select row_to_json(c) from public.cfb_game_ref_context c where game_id = ${G + 2}`));
  chk('a referee with no games: named, conference unavailable, no numbers', asg.new === 1 && ctx3.referee === 'Brand New' && ctx3.primary_conf === null && ctx3.season_games === null, ctx3);
  chk('bad rows are ignored (no game, no season, a non-key referee id)', observe([{ game_id: null, season: 2026, referee_id: 'x' }, { game_id: 5, season: null, referee_id: 'x' }, { game_id: 6, season: 2026, referee_id: 'Not A Key' }]).new === 0);

  /* ---------------------------------------------------- a final game reads its game record */
  const ctx4 = JSON.parse(psql(`select row_to_json(c) from public.cfb_game_ref_context c where game_id = 401635525`));
  chk('a completed game: the game record, NCAA crew chief', ctx4.basis === 'game_record' && ctx4.referee === 'Jerry Magallanes' && ctx4.source === 'ncaa_listed'
    && ctx4.referee_identity === 'inferred_crew_chief' && ctx4.season === 2024 && ctx4.y3_first_season === 2024 && ctx4.y3_last_season === 2026, ctx4);
  const r5 = reportRows(psql(SQL, { command: true }));
  chk('re-applied over live data: still all ok, nothing lost', r5.every((r) => r.state === 'ok')
    && psql(`select count(*) from public.cfb_ref_assignments where game_id = ${G}`) === '2' && psql(`select count(*) from public.cfb_ref_game_penalties`) === '2367', r5);
} catch (e) {
  chk('the live layer ran without an unexpected error', false, String(e.stderr || e.stdout || e.message).slice(0, 1200));
}
done();
