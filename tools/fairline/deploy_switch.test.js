#!/usr/bin/env node
/* ===========================================================================
   Deploy Fairline's last step, "The Tape's email switch", run as shipped.

   The step's own bash, read out of .github/workflows/deploy-fairline.yml,
   runs against a real PostgreSQL that carries fairline_tape_settings as
   supabase/fairline_tape.sql creates it. Before 2026-10-29 the step read
   psql's answer as "t\nUPDATE 1" and compared it with "true", so it failed
   on every run, after the UPDATE had already committed: the owner's run that
   day set the switch on and reported failure.

     on / off      the switch is set, the step passes and says so
     the pipeline  a warning only when the switch is on and the email
                   pipeline's own switch (lifecycle_settings) is off
     no row        fairline_tape.sql not applied: the step fails, naming it

   Run: node tools/fairline/deploy_switch.test.js
        (FAIRLINE_SQL_REQUIRED=1 makes a missing PostgreSQL a failure)
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));

const ROOT = PG.ROOT;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); }
}

/* the step's `run: |` block, exactly as the workflow carries it */
function stepScript(yml, name) {
  const lines = yml.split('\n');
  const at = lines.findIndex((l) => l.trim() === '- name: ' + name);
  if (at < 0) return null;
  let i = at + 1;
  while (i < lines.length && !/^\s+run: \|\s*$/.test(lines[i])) {
    if (/^\s+- name: /.test(lines[i])) return null;
    i++;
  }
  if (i >= lines.length) return null;
  const indent = lines[i].indexOf('run:');
  const body = [];
  for (i++; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() !== '' && l.search(/\S/) <= indent) break;
    body.push(l.slice(indent + 2));
  }
  return body.join('\n').trim() + '\n';
}

const YML = read('.github/workflows/deploy-fairline.yml');
const SCRIPT = stepScript(YML, "The Tape's email switch");
chk('the workflow carries the step, with its script', !!SCRIPT && /fairline_tape_settings/.test(SCRIPT), SCRIPT && SCRIPT.slice(0, 200));
/* the stand-in below is the table fairline_tape.sql creates */
const TAPE = read('supabase/fairline_tape.sql');
chk('fairline_tape_settings is still one row with a boolean email_enabled (the stand-in matches it)',
  /create table if not exists public\.fairline_tape_settings \(\s*id\s+int primary key default 1 check \(id = 1\),\s*email_enabled\s+boolean not null default false,\s*updated_at\s+timestamptz not null default now\(\)\s*\);/.test(TAPE));
chk('lifecycle_settings.sending_enabled is still the email pipeline\'s switch',
  /create table if not exists public\.lifecycle_settings \(/.test(read('supabase/lifecycle_email.sql')) && /sending_enabled/.test(read('supabase/lifecycle_email.sql')));

const db = PG.start('flswitch');
if (db.skip) {
  if (process.env.FAIRLINE_SQL_REQUIRED === '1') chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  else console.log('NOTE | ' + db.skip + ' — the step did not run');
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'Deploy Fairline email switch — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

/* run the step's bash as the runner would: psql on PATH, PGURL in the env */
const PGURL = 'postgresql://postgres@localhost/postgres?host=' + encodeURIComponent(db.home) + '&port=' + db.port;
function runStep(want) {
  const f = path.join(db.home, 'step' + Date.now() + Math.random().toString(36).slice(2) + '.sh');
  fs.writeFileSync(f, SCRIPT);
  const r = cp.spawnSync('bash', [f], { encoding: 'utf8',
    env: Object.assign({}, process.env, { PATH: db.bin + ':' + process.env.PATH, PGURL, WANT: want, PGCONNECT_TIMEOUT: '10' }) });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const sw = () => db.sql('select email_enabled from public.fairline_tape_settings where id = 1');

try {
  db.sql(`create table public.fairline_tape_settings (
      id int primary key default 1 check (id = 1),
      email_enabled boolean not null default false,
      updated_at timestamptz not null default now());
    insert into public.fairline_tape_settings (id) values (1);
    create table public.lifecycle_settings (id int primary key default 1, sending_enabled boolean not null default false);
    insert into public.lifecycle_settings (id) values (1);`);

  let r = runStep('on');
  chk('on: the step passes, and the switch is on', r.code === 0 && sw() === 't', r);
  chk('it says so, and names the pipeline\'s own switch', /The Tape's email switch: on\. The pipeline's own switch \(lifecycle_settings\.sending_enabled\): f\./.test(r.out), r.out);
  chk('with the pipeline off, it warns that nothing sends yet', /::warning::The pipeline's switch is off/.test(r.out), r.out);

  db.sql('update public.lifecycle_settings set sending_enabled = true;');
  r = runStep('on');
  chk('on again, with the pipeline on: passes, no warning', r.code === 0 && sw() === 't' && !/::warning::/.test(r.out), r);

  r = runStep('off');
  chk('off: the step passes, and the switch is off', r.code === 0 && sw() === 'f' && /The Tape's email switch: off\./.test(r.out), r);

  db.sql('delete from public.fairline_tape_settings;');
  r = runStep('on');
  chk('no settings row (fairline_tape.sql not applied): the step fails, naming the file', r.code !== 0 &&
    /::error::fairline_tape_settings was not updated \(is fairline_tape\.sql applied\?\)/.test(r.out), r);

  db.sql('drop table public.fairline_tape_settings;');
  r = runStep('off');
  chk('no settings table: the step fails', r.code !== 0, r);
} catch (e) {
  chk('the step ran without an unexpected error', false, String(e && e.stack || e).slice(0, 1200));
} finally {
  db.stop();
}
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'Deploy Fairline email switch — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
