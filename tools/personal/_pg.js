'use strict';
/* ===========================================================================
   A THROWAWAY POSTGRESQL for the personal-research and affiliate SQL suites.

   Same approach as tools/intelligence/stake_sql.test.js: find the server
   binaries, initdb a cluster in a temp directory, start it on a private port
   and a private socket, and stop and delete it afterwards. Nothing about an
   existing cluster on this machine is touched.

   On top of that it applies tools/games/sql/supabase_shim.sql — the repo's
   stand-in for Supabase's auth schema and roles — so auth.uid() reads
   request.jwt.claim.sub and a test can act as ANY reader:

       db.as(uid, sql)      runs sql as `authenticated` with auth.uid() = uid
       db.anon(sql)         runs sql as `anon`
       db.service(sql)      runs sql as `service_role` (bypasses RLS)
       db.sql(sql)          runs sql as the superuser

   Every call returns trimmed stdout; a failing statement throws with the
   server's message, which is what the `mustFail` assertions read.

   Without a PostgreSQL binary, start() returns null and the caller skips.
   =========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SHIM = path.join(ROOT, 'tools', 'games', 'sql', 'supabase_shim.sql');

function findPgBin() {
  const cands = [];
  try { cands.push(path.dirname(cp.execSync('command -v pg_ctl', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim())); } catch (_) { /* not on PATH */ }
  try { fs.readdirSync('/usr/lib/postgresql').sort().reverse().forEach((v) => cands.push('/usr/lib/postgresql/' + v + '/bin')); } catch (_) { /* none */ }
  for (const d of cands) if (d && fs.existsSync(path.join(d, 'pg_ctl')) && fs.existsSync(path.join(d, 'initdb'))) return d;
  return null;
}

function start(label) {
  const BIN = findPgBin();
  if (!BIN) return { skip: 'no postgres binary found' };
  const asRoot = process.getuid && process.getuid() === 0;
  const HOME = asRoot ? fs.mkdtempSync('/var/lib/postgresql/' + (label || 'edp') + '-') : fs.mkdtempSync(path.join(os.tmpdir(), (label || 'edp') + '-'));
  const DATA = path.join(HOME, 'data');
  const PORT = 56600 + (process.pid % 300);
  const run = (cmd, opts) => cp.execSync(asRoot ? 'su postgres -c ' + JSON.stringify(cmd) : cmd,
    Object.assign({ stdio: 'pipe', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, opts || {}));
  try {
    if (asRoot) cp.execSync('chown -R postgres ' + HOME + ' && chmod 700 ' + HOME);
    run(BIN + '/initdb -D ' + DATA + ' -U postgres -A trust');
    run(BIN + '/pg_ctl -D ' + DATA + ' -o "-p ' + PORT + ' -k ' + HOME + ' -c listen_addresses=" -l ' + HOME + '/log start -w -t 30');
  } catch (e) {
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    return { skip: 'postgres would not start: ' + String(e.message).slice(0, 160) };
  }

  let n = 0;
  function file(sqlText) {
    const f = path.join(HOME, 'q' + (n++) + '.sql');
    fs.writeFileSync(f, sqlText);
    if (asRoot) cp.execSync('chown postgres ' + f + ' && chmod 644 ' + f);
    return f;
  }
  function psqlFile(f, extra) {
    try {
      return run(BIN + '/psql -h ' + HOME + ' -p ' + PORT + ' -U postgres -d postgres -v ON_ERROR_STOP=1 -X -q -t -A ' + (extra || '') + ' -f ' + f).trim();
    } catch (e) {
      const msg = String((e.stderr || '') + (e.stdout || '') || e.message);
      const err = new Error(msg.trim());
      err.sqlMessage = msg;
      throw err;
    }
  }
  const db = {
    home: HOME, port: PORT, bin: BIN,
    sql(text) { return psqlFile(file(text)); },
    applyFile(p) { return psqlFile(file(fs.readFileSync(p, 'utf8'))); },
    /* the Supabase SQL editor runs a pasted file as ONE transaction, so every
       lock a statement takes is held until the whole file ends */
    applyFileAtomic(p) { return psqlFile(file(fs.readFileSync(p, 'utf8')), '-1'); },
    /* a second session running on its own while the test carries on — what a
       webhook or the hourly job is doing when someone re-runs a file */
    background(text) {
      const f = file(text), out = f + '.out', code = f + '.code', sh = f + '.sh';
      /* a script file, so $? is the psql exit status and not the outer shell's */
      fs.writeFileSync(sh, BIN + '/psql -h ' + HOME + ' -p ' + PORT + ' -U postgres -d postgres -v ON_ERROR_STOP=1 -X -q -t -A -f ' + f
        + ' > ' + out + ' 2>&1\necho $? > ' + code + '\n');
      if (asRoot) cp.execSync('chown postgres ' + sh + ' && chmod 755 ' + sh);
      cp.spawn('sh', ['-c', asRoot ? 'su postgres -c "sh ' + sh + '"' : 'sh ' + sh], { detached: true, stdio: 'ignore' }).unref();
      return {
        wait(ms) {
          const until = Date.now() + (ms || 30000);
          while (!fs.existsSync(code) && Date.now() < until) cp.spawnSync('sleep', ['0.1']);
          const c = fs.existsSync(code) ? +fs.readFileSync(code, 'utf8').trim() : null;
          return { code: c, out: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '' };
        }
      };
    },
    sleep(sec) { cp.spawnSync('sleep', [String(sec)]); },
    applyText(text) { return psqlFile(file(text)); },
    as(uid, text) {
      return psqlFile(file('begin;\n' + claim(uid) + 'set local role authenticated;\n' + text + '\ncommit;\n'));
    },
    anon(text) {
      return psqlFile(file('begin;\n' + claim('') + 'set local role anon;\n' + text + '\ncommit;\n'));
    },
    service(text) {
      return psqlFile(file('begin;\n' + claim('') + 'set local role service_role;\n' + text + '\ncommit;\n'));
    },
    mustFail(fn) { try { fn(); return null; } catch (e) { return String(e.sqlMessage || e.message); } },
    stop() {
      try { run(BIN + '/pg_ctl -D ' + DATA + ' stop -m immediate -w -t 20'); } catch (_) { /* already down */ }
      try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
  };
  /* the shim, plus what a Supabase project grants service_role */
  db.applyFile(SHIM);
  db.sql([
    'create extension if not exists pgcrypto;',
    'alter default privileges for role postgres in schema public grant select, insert, update, delete on tables to service_role;',
    'alter default privileges for role postgres in schema public grant usage, select on sequences to service_role;',
    /* a Supabase project also grants EXECUTE on every new public function to
       the client roles; revoking from PUBLIC alone leaves those grants in place */
    'alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated, service_role;',
    'grant usage on schema public to service_role;'
  ].join('\n'));
  return db;
}

/* the caller's identity for this transaction, printing nothing */
function claim(uid) {
  return 'do $claim$ begin perform set_config(\'request.jwt.claim.sub\', ' + lit(uid) + ', true); end $claim$;\n';
}
function lit(v) { return v == null ? 'NULL' : "'" + String(v).replace(/'/g, "''") + "'"; }

/* a tiny assertion kit, the same shape every suite in this repo prints */
function kit(name) {
  let pass = 0, fail = 0;
  const failures = [];
  return {
    chk(label, ok, detail) { if (ok) pass++; else { fail++; failures.push({ label, detail }); } },
    done(note) {
      failures.forEach((f) => console.log('FAIL | ' + f.label + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
      if (note) console.log(note);
      console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + name + ' — ' + pass + ' passed, ' + fail + ' failed');
      return fail === 0 ? 0 : 1;
    },
    get failed() { return fail; }
  };
}

module.exports = { start, lit, kit, findPgBin, ROOT };
