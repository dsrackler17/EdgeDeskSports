/* ===========================================================================
   A throwaway PostgreSQL for the SQL tests in this folder.

   Lifted from the pattern model_autocreate_sql.test.js and
   member_removal_sql.test.js already use, rather than invented alongside it:
   find a server, initdb a cluster on a per-process port, run the file for
   real, tear it down. Two copies of this had already diverged on the
   run-as-root handling, which is the part that actually breaks in CI.

   THE RULE THIS FOLDER KEEPS, AND SO DOES THIS FILE: if no postgres binary is
   available the suite SAYS SO and the static layer still runs. A skipped
   check that announces itself is honest; one that stays quiet is how a bug
   ships.

   Usage:
     const { findPgBin, startCluster } = require('./pg_harness');
     const BIN = findPgBin();
     if (!BIN) done('NOTE | no postgres ...');
     const pg = startCluster(BIN, 'mtc');   // registers its own cleanup
     pg.psql('-d postgres -q -c "create database x"');
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

function findPgBin() {
  /* TEST-ONLY. The skip path is the branch that runs in CI when postgres is
     absent, which makes it the branch least likely to have ever been
     executed by the person who wrote it. This lets the suites prove their own
     skip path works:  EDGEDESK_NO_PG=1 node tools/collective/<x>_sql.test.js
     must print the NOTE and exit 0. */
  if (process.env.EDGEDESK_NO_PG === '1') return null;

  const cands = ['pg_ctl'].concat(
    (() => {
      try {
        return fs.readdirSync('/usr/lib/postgresql').sort().reverse()
          .map((v) => '/usr/lib/postgresql/' + v + '/bin/pg_ctl');
      } catch (_) { return []; }
    })());
  for (const c of cands) {
    try {
      cp.execSync(`${c} --version`, { stdio: 'ignore' });
      return c === 'pg_ctl'
        ? path.dirname(cp.execSync('command -v pg_ctl').toString().trim())
        : path.dirname(c);
    } catch (_) { /* keep looking */ }
  }
  return null;
}

function startCluster(BIN, tag) {
  /* Distinct per process AND per tag: two of these suites running at once
     must not land on the same port, or the second one silently talks to the
     first one's cluster. */
  const PORT = 55900 + (process.pid % 70)
    + (tag.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 7) * 70;
  const asPostgres = process.getuid && process.getuid() === 0;
  const HOME = asPostgres
    ? fs.mkdtempSync('/var/lib/postgresql/' + tag + '-')
    : fs.mkdtempSync(path.join(os.tmpdir(), tag + '-'));
  const DATA = path.join(HOME, 'data');
  const run = (cmd, opts) =>
    cp.execSync(asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd,
      Object.assign({ stdio: 'pipe', encoding: 'utf8' }, opts || {}));

  let started = false;
  try {
    if (asPostgres) cp.execSync(`chown -R postgres:postgres ${HOME}`);
    run(`${BIN}/initdb -D ${DATA} -A trust -E UTF8`);
    run(`${BIN}/pg_ctl -D ${DATA} -o '-k /tmp -p ${PORT} -c listen_addresses=' -l ${HOME}/pg.log start -w`);
    started = true;
  } catch (e) {
    return { ok: false, why: String((e && e.message) || e).slice(0, 180) };
  }

  function cleanup() {
    try { if (started) run(`${BIN}/pg_ctl -D ${DATA} -m immediate stop`); } catch (_) {}
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) {}
  }
  process.on('exit', cleanup);

  return {
    ok: true,
    /* A file outside the cluster's home is unreadable to the postgres user
       when this runs as root, so it is copied in and made readable first. */
    stage(src) {
      const dst = path.join(HOME, path.basename(src));
      fs.copyFileSync(src, dst);
      if (asPostgres) cp.execSync(`chmod a+r ${dst}`);
      return dst;
    },
    psql(args) {
      try { return { status: 0, out: run(`${BIN}/psql -h /tmp -p ${PORT} ${args} 2>&1`) }; }
      catch (e) {
        return { status: 1, out: String((e.stdout || '') + (e.stderr || '') + e.message) };
      }
    },
  };
}

module.exports = { findPgBin, startCluster };
