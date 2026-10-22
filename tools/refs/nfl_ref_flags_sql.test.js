#!/usr/bin/env node
/* ===========================================================================
   NFL referee flag tendencies on a real PostgreSQL
   (supabase/nfl_ref_flags.sql, data/refs/upsert_refs.py).

     node tools/refs/nfl_ref_flags_sql.test.js            (REFS_SQL_REQUIRED=1 in CI)
     node tools/refs/nfl_ref_flags_sql.test.js --write    rewrite the card fixture

     static     the migration copy is the same file; no psql meta-command; no
                client write is ever granted; every view runs as the reader
     applies    every report row ok (the seed row pending until it runs); a
                second run is harmless
     roles      anon and authenticated read the tables and views and write
                nothing; service_role inserts and updates; no PUBLIC policy
     rules      a penalty row needs its assignment; source is one of three;
                updated_at moves on every write
     seed       data/refs/upsert_refs.py against a stand-in PostgREST that
                runs each request as service_role on this database:
                assignments first, then penalties; 677 assignments and 663
                penalty rows; a second run adds nothing; a wrong key or a
                server error exits 1 and never prints the key
     card       every Week 7 row of nfl_game_ref_context matches
                data/refs/ref_assignments_2026_w7.csv (GB @ DET is Alex Moore,
                CLE @ TEN is Scott Novak); rank of 17; O/U matches
                ref_summary.csv; anon reads it; the committed fixture the
                browser suite serves is the view's own answer
     draft      over the handoff's data/refs/schema.sql: upgraded in place,
                its PUBLIC policies gone
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const T = PG.kit('NFL referee flags (SQL)');
const ROOT = PG.ROOT;
const LAYER_PATH = path.join(ROOT, 'supabase', 'nfl_ref_flags.sql');
const LAYER = fs.readFileSync(LAYER_PATH, 'utf8');
const REFS = path.join(ROOT, 'data', 'refs');
const FIXTURE = path.join(__dirname, 'fixtures', 'nfl_game_ref_context_2026_w7.json');
const WRITE = process.argv.includes('--write');

T.chk('the migration copy is the same file', fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '20261022100000_nfl_ref_flags.sql'), 'utf8') === LAYER);
T.chk('no psql meta-command', !/^\s*\\/m.test(LAYER));
T.chk('the layer never grants a client write', !/grant\s+(insert|update|delete|all)[^;]*to\s+(anon|authenticated)/i.test(LAYER));
T.chk('every view is created to run as the reader', (LAYER.match(/create or replace view/g) || []).length === 3
  && (LAYER.match(/create or replace view public\.\w+ with \(security_invoker = true\) as/g) || []).length === 3);

function csvRows(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const h = lines[0].split(',');
  return lines.slice(1).map((l) => { const c = l.split(','); const o = {}; h.forEach((k, i) => { o[k] = c[i]; }); return o; });
}
function python() {
  for (const p of ['python3', 'python']) { try { cp.execFileSync(p, ['--version'], { stdio: 'ignore' }); return p; } catch (_) { /* next */ } }
  return null;
}

/* A stand-in for PostgREST: just the two calls upsert_refs.py makes, each
   run as service_role on the test database, so the grants are exercised. */
function fakeRest(db, KEY) {
  const log = [];
  const S = { failNext: null };
  const srv = http.createServer((req, res) => {
    const m = /^\/rest\/v1\/([a-z_]+)(\?.*)?$/.exec(req.url), table = m ? m[1] : '';
    const send = (status, body, headers) => { res.writeHead(status, Object.assign({ 'content-type': 'application/json' }, headers || {})); res.end(JSON.stringify(body)); };
    if (req.headers.apikey !== KEY || req.headers.authorization !== 'Bearer ' + KEY) return send(401, { message: 'Invalid API key' });
    if (!/^nfl_ref_(assignments|game_penalties)$/.test(table)) return send(404, { code: 'PGRST205', message: 'Could not find the table' });
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      log.push({ method: req.method, table, url: req.url, prefer: req.headers.prefer || '' });
      if (S.failNext && S.failNext.table === table && req.method === 'POST') { const f = S.failNext; S.failNext = null; return send(f.status, { message: f.message }); }
      try {
        if (req.method === 'GET') {
          const n = Number(db.service(`select count(*) from public.${table};`));
          return send(200, [], { 'content-range': n ? '0-0/' + n : '*/0' });
        }
        if (req.method !== 'POST' || !/on_conflict=game_id/.test(req.url) || !/resolution=merge-duplicates/.test(req.headers.prefer || '')) return send(400, { message: 'expected an upsert on game_id' });
        const rows = JSON.parse(raw);
        const cols = Object.keys(rows[0] || {});
        if (!cols.length || rows.some((r) => Object.keys(r).join() !== cols.join())) return send(400, { code: 'PGRST102', message: 'All object keys must match' });
        const list = cols.map((c) => '"' + c + '"').join(', ');
        db.service(`insert into public.${table} (${list}) select ${list} from json_populate_recordset(null::public.${table}, ${PG.lit(JSON.stringify(rows))}::json)
          on conflict (game_id) do update set ${cols.filter((c) => c !== 'game_id').map((c) => '"' + c + '" = excluded."' + c + '"').join(', ')};`);
        return send(201, null);
      } catch (e) { return send(409, { message: String(e.message).split('\n').filter((l) => /ERROR/.test(l)).join(' ') || String(e.message).slice(0, 300) }); }
    });
  });
  return { srv, log, S };
}
function runPy(py, args, env) {
  return new Promise((resolve) => {
    const p = cp.spawn(py, ['-I', path.join(REFS, 'upsert_refs.py')].concat(args), { env: Object.assign({ PATH: process.env.PATH }, env) });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

(async function main() {
  let db = PG.start('refs');
  if (db.skip) {
    if (process.env.REFS_SQL_REQUIRED === '1') T.chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
    console.log('NOTE | ' + db.skip + ' — the LIVE layer did not run'); process.exit(T.done());
  }
  const J = (s) => JSON.parse(String(s).split('\n').filter(Boolean).pop());
  const rows = (q, who) => J((who || db.sql)(`select coalesce(jsonb_agg(x), '[]'::jsonb) from (${q}) x;`));
  const fails = (fn) => db.mustFail(fn);
  let srv = null;
  try {
    /* ---- applies, twice ---- */
    let out = db.applyFile(LAYER_PATH);
    T.chk('applies: rows 1-6 ok, the seed row pending', (out.match(/\|ok$/gm) || []).length === 6 && /7 the seed has run\|pending: run/.test(out) && !/CHECK THIS/.test(out), out);
    out = db.applyFile(LAYER_PATH);
    T.chk('applying it twice is harmless (idempotent)', (out.match(/\|ok$/gm) || []).length === 6 && !/CHECK THIS/.test(out), out);

    /* ---- roles ---- */
    T.chk('anon reads the tables and every view', ['nfl_ref_assignments', 'nfl_ref_game_penalties', 'nfl_ref_season_summary', 'nfl_ref_baseline_3yr', 'nfl_game_ref_context']
      .every((t) => db.anon(`select count(*) from public.${t};`) === '0'));
    T.chk('authenticated reads the card view', db.as('00000000-0000-0000-0000-0000000000aa', 'select count(*) from public.nfl_game_ref_context;') === '0');
    const ins = "insert into public.nfl_ref_assignments (game_id, season, week, referee) values ('2026_09_X_Y', 2026, 9, 'Nobody');";
    T.chk('anon cannot insert', /permission denied/.test(fails(() => db.anon(ins)) || ''));
    T.chk('authenticated cannot insert, update or delete', /permission denied/.test(fails(() => db.as('00000000-0000-0000-0000-0000000000aa', ins)) || '')
      && /permission denied/.test(fails(() => db.as('00000000-0000-0000-0000-0000000000aa', "update public.nfl_ref_assignments set referee = 'x';")) || '')
      && /permission denied/.test(fails(() => db.as('00000000-0000-0000-0000-0000000000aa', 'delete from public.nfl_ref_game_penalties;')) || ''));
    T.chk('anon cannot write through the card view', /permission denied|cannot insert/.test(fails(() => db.anon("insert into public.nfl_game_ref_context (game_id) values ('x');")) || ''));
    T.chk('the only policies are the two reader policies, to anon and authenticated',
      db.sql("select string_agg(tablename || ':' || policyname || ':' || cmd || ':' || roles::text, ' ' order by tablename) from pg_policies where tablename like 'nfl\\_ref\\_%';")
        === 'nfl_ref_assignments:nfl_ref_assignments_read:SELECT:{anon,authenticated} nfl_ref_game_penalties:nfl_ref_game_penalties_read:SELECT:{anon,authenticated}');

    /* ---- rules ---- */
    db.service(ins);
    T.chk('service_role inserts and updates', db.service("update public.nfl_ref_assignments set referee = 'Somebody' where game_id = '2026_09_X_Y' returning referee;") === 'Somebody');
    const t0 = db.sql("select updated_at from public.nfl_ref_assignments where game_id = '2026_09_X_Y';");
    db.sleep(0.05);
    db.service("update public.nfl_ref_assignments set week = 9 where game_id = '2026_09_X_Y';");
    T.chk('updated_at moves on every write', db.sql(`select updated_at > ${PG.lit(t0)}::timestamptz from public.nfl_ref_assignments where game_id = '2026_09_X_Y';`) === 't');
    T.chk('a source outside nflverse / footballzebras / manual is refused', /nfl_ref_assignments_source_known/.test(fails(() => db.service("update public.nfl_ref_assignments set source = 'twitter' where game_id = '2026_09_X_Y';")) || ''));
    T.chk('a penalty row without its assignment is refused (load assignments first)', /foreign key/.test(fails(() => db.service(`insert into public.nfl_ref_game_penalties
        (game_id, season, week, game_type, away_team, home_team, referee, flags, accepted_flags, penalty_yards, home_flags, away_flags, off_holding, def_holding,
         dpi, opi, false_start, roughing_passer, unnecessary_roughness, illegal_contact, illegal_use_of_hands, snaps, holding_total)
        values ('2026_09_A_B', 2026, 9, 'REG', 'A', 'B', 'Nobody', 1,1,1,1,0,0,0,0,0,0,0,0,0,0,150,0);`)) || ''));
    db.sql("delete from public.nfl_ref_assignments where game_id = '2026_09_X_Y';");

    /* ---- seed, through the REST API ---- */
    const py = python();
    if (!py) {
      if (process.env.REFS_SQL_REQUIRED === '1') T.chk('python3 is available for the seed (required in CI)', false);
      console.log('NOTE | no python3 — the seed was loaded with COPY instead of upsert_refs.py');
      db.sql(`copy public.nfl_ref_assignments (game_id, season, week, referee, source) from ${PG.lit(path.join(REFS, 'ref_assignments.csv'))} csv header;`);
    } else {
      const KEY = 'service-role-test-key-7f3a';
      const R = fakeRest(db, KEY);
      srv = R.srv;
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      const env = { SB_URL: 'http://127.0.0.1:' + srv.address().port + '/', SB_SERVICE_ROLE: KEY };

      let r = await runPy(py, [], env);
      const posts = R.log.filter((x) => x.method === 'POST').map((x) => x.table);
      T.chk('seed: exits 0', r.code === 0, r.err || r.out);
      T.chk('seed: every assignment batch before the first penalty batch', posts.length >= 3 && posts.indexOf('nfl_ref_game_penalties') > posts.lastIndexOf('nfl_ref_assignments'), posts);
      T.chk('seed: upserts on game_id with merge-duplicates', R.log.filter((x) => x.method === 'POST').every((x) => /on_conflict=game_id/.test(x.url) && /resolution=merge-duplicates/.test(x.prefer)));
      T.chk('seed: 677 assignments and 663 penalty rows', db.sql('select count(*) from public.nfl_ref_assignments;') === '677' && db.sql('select count(*) from public.nfl_ref_game_penalties;') === '663',
        [db.sql('select count(*) from public.nfl_ref_assignments;'), db.sql('select count(*) from public.nfl_ref_game_penalties;')]);
      T.chk('seed: says what it loaded', /nfl_ref_assignments: upserted 677 rows on game_id; the table holds 677/.test(r.out) && /nfl_ref_game_penalties: upserted 663 rows on game_id; the table holds 663/.test(r.out), r.out);
      const before = db.sql("select md5(string_agg(t::text, '|' order by game_id)) from (select game_id, season, week, referee, source from public.nfl_ref_assignments) t;");
      r = await runPy(py, [], env);
      T.chk('seed: a second run exits 0 and adds nothing', r.code === 0 && db.sql('select count(*) from public.nfl_ref_assignments;') === '677' && db.sql('select count(*) from public.nfl_ref_game_penalties;') === '663'
        && db.sql("select md5(string_agg(t::text, '|' order by game_id)) from (select game_id, season, week, referee, source from public.nfl_ref_assignments) t;") === before, r.err);
      r = await runPy(py, [], Object.assign({}, env, { SB_SERVICE_ROLE: 'wrong-key' }));
      T.chk('seed: a wrong key exits 1 with the server\'s message, and the key is never printed', r.code === 1 && /HTTP 401: .*Invalid API key/.test(r.err) && !/wrong-key|service-role-test-key/.test(r.out + r.err), r);
      R.S.failNext = { table: 'nfl_ref_game_penalties', status: 409, message: 'duplicate key value violates something' };
      r = await runPy(py, [], env);
      T.chk('seed: a refused penalty batch fails loudly (exit 1, the message, the rows)', r.code === 1 && /upserting nfl_ref_game_penalties rows 1-500: HTTP 409: .*duplicate key/.test(r.err), r);
      r = await runPy(py, [], { SB_URL: env.SB_URL });
      T.chk('seed: no key, no request', r.code === 1 && /set SB_URL and SB_SERVICE_ROLE/.test(r.err));
      r = await runPy(py, ['--dry-run'], {});
      T.chk('seed: a dry run needs no credentials and writes nothing', r.code === 0 && /dry run: nothing written/.test(r.out));
    }
    out = db.applyFile(LAYER_PATH);
    T.chk('after the seed every report row is ok', (out.match(/\|ok$/gm) || []).length === 7 && !/CHECK THIS|pending/.test(out), out);

    /* ---- the card view against the handoff's Week 7 slate ---- */
    const W7 = csvRows(path.join(REFS, 'ref_assignments_2026_w7.csv'));
    const view = rows('select * from public.nfl_game_ref_context where season = 2026 and week = 7 order by game_id');
    const by = {}; view.forEach((v) => { by[v.game_id] = v; });
    const MAP = { s26_games: 'season_games', s26_flags_pg: 'season_flags_pg', s26_holding_total_pg: 'season_holding_pg', s26_off_holding_pg: 'season_off_holding_pg',
      s26_flags_vs_league_pg: 'season_flags_vs_league', s26_holding_vs_league_pg: 'season_holding_vs_league', s26_flags_rank: 'flags_rank', s26_holding_rank: 'holding_rank',
      y3_games: 'y3_games', y3_flags_pg: 'y3_flags_pg', y3_holding_total_pg: 'y3_holding_pg', y3_flags_vs_league_pg: 'y3_flags_vs_league', y3_holding_vs_league_pg: 'y3_holding_vs_league' };
    const off = [];
    W7.forEach((w) => {
      const v = by[w.game_id];
      if (!v) { off.push(w.game_id + ' missing'); return; }
      if (v.referee !== w.referee) off.push(w.game_id + ' referee ' + v.referee + ' vs ' + w.referee);
      Object.keys(MAP).forEach((k) => { if (Math.abs(Number(v[MAP[k]]) - Number(w[k])) > 1e-9) off.push(w.game_id + ' ' + k + ' ' + v[MAP[k]] + ' vs ' + w[k]); });
    });
    T.chk('card: all 14 Week 7 games, every number as in ref_assignments_2026_w7.csv', W7.length === 14 && view.length === 14 && off.length === 0, off);
    const gb = by['2026_07_GB_DET'] || {}, cle = by['2026_07_CLE_TEN'] || {};
    T.chk('card: GB @ DET is Alex Moore (18.60 flags, +3.61, 2nd of 17; holding 7.20, +3.19, 1st)', gb.referee === 'Alex Moore' && Number(gb.season_flags_pg) === 18.6 && Number(gb.season_flags_vs_league) === 3.61
      && gb.flags_rank === 2 && Number(gb.season_holding_pg) === 7.2 && Number(gb.season_holding_vs_league) === 3.19 && gb.holding_rank === 1 && gb.season_refs === 17 && gb.source === 'footballzebras', gb);
    T.chk('card: CLE @ TEN is Scott Novak (most flags: 21.33, 1st of 17)', cle.referee === 'Scott Novak' && Number(cle.season_flags_pg) === 21.33 && cle.flags_rank === 1 && cle.season_refs === 17, cle);
    T.chk('card: the 2026 and 3-year league averages (14.99 and 13.11 flags a game)', Number(gb.season_lg_flags_pg) === 14.99 && Number(gb.y3_lg_flags_pg) === 13.11 && gb.y3_first_season === 2024 && gb.y3_last_season === 2026, gb);
    const SUM = csvRows(path.join(REFS, 'ref_summary.csv'));
    const ou = (win, ref) => SUM.filter((s) => s.window === win && s.referee === ref)[0];
    const ouOff = view.filter((v) => { const s = ou('2026', v.referee), y = ou('2024-2026', v.referee);
      return !s || !y || Number(s.overs) !== v.season_overs || Number(s.unders) !== v.season_unders || Number(y.overs) !== v.y3_overs || Number(y.unders) !== v.y3_unders; });
    T.chk('card: the O/U record (season and 3-year) matches ref_summary.csv', ouOff.length === 0, ouOff.slice(0, 2));
    T.chk('card: pushes are counted apart, never as unders', db.sql("select sum(y3_pushes) from (select distinct referee, y3_pushes from public.nfl_game_ref_context) x;") === '3'
      && db.sql('select count(*) from public.nfl_ref_game_penalties where went_over is null;') === '3');
    T.chk('card: anon reads every game\'s row', db.anon('select count(*) from public.nfl_game_ref_context;') === '677' && db.anon("select referee from public.nfl_game_ref_context where game_id = '2026_07_GB_DET';") === 'Alex Moore');
    T.chk('card: a game with no announced assignment has no row', db.anon("select count(*) from public.nfl_game_ref_context where game_id = '2026_08_NYJ_CIN';") === '0');
    const fx = JSON.stringify(view, null, 1) + '\n';
    if (WRITE) { fs.mkdirSync(path.dirname(FIXTURE), { recursive: true }); fs.writeFileSync(FIXTURE, fx); console.log('wrote ' + path.relative(ROOT, FIXTURE)); }
    T.chk('the browser suite\'s fixture is this view\'s Week 7 answer (node tools/refs/nfl_ref_flags_sql.test.js --write)', fs.existsSync(FIXTURE) && fs.readFileSync(FIXTURE, 'utf8') === fx);
  } catch (e) {
    T.chk('the run completed', false, String(e && e.stack || e).slice(0, 800));
  } finally {
    if (srv) srv.close();
    db.stop();
  }

  /* ---- over the handoff draft ---- */
  db = PG.start('refsdraft');
  if (!db.skip) {
    try {
      db.applyFile(path.join(REFS, 'schema.sql'));
      const out = db.applyFile(LAYER_PATH);
      T.chk('draft: the layer applies over data/refs/schema.sql, rows 1-6 ok', (out.match(/\|ok$/gm) || []).length === 6 && !/CHECK THIS/.test(out), out);
      T.chk('draft: its PUBLIC policies are gone, the reader policies in their place',
        db.sql("select string_agg(policyname || ':' || roles::text, ' ' order by policyname) from pg_policies where tablename like 'nfl_ref%';")
          === 'nfl_ref_assignments_read:{anon,authenticated} nfl_ref_game_penalties_read:{anon,authenticated}');
      T.chk('draft: its views now run as the reader and carry the new columns', db.sql("select count(*) from pg_class where relkind = 'v' and relname like 'nfl_%ref%' and reloptions::text like '%security_invoker=true%';") === '3'
        && db.sql("select count(*) from information_schema.columns where table_name = 'nfl_game_ref_context' and column_name = 'season_refs';") === '1');
    } catch (e) {
      T.chk('the draft run completed', false, String(e && e.stack || e).slice(0, 800));
    } finally { db.stop(); }
  }
  process.exit(T.done());
})();
