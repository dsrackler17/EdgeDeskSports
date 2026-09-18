#!/usr/bin/env node
// The parts under supabase/parts are generated from the three contract files.
// A stale part is worse than no part: it would be pasted into the production SQL
// editor and build a schema that no longer matches the repository. This test
// re-runs the splitter over the current sources and fails if what is checked in
// differs, and it proves the splitter never cuts inside a string, a comment or a
// function body.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SPLITTER = path.join(ROOT, 'tools', 'sql', 'split_sql.js');
const PARTS = path.join(ROOT, 'supabase', 'parts');
const LIMIT = 20000;
const SOURCES = ['mlb_pitcher_history', 'mlb_offense_history', 'college_baseball'];

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(detail ? `${name}\n    ${detail}` : name);
}

// ---------------------------------------------------------------- the splitter
// Exercised on hand-written input where the right answer is known by eye, so a
// regression in the tokeniser is caught here rather than by a schema that half
// applied in production.
const { statements } = require('./split_sql.js');

check('a semicolon inside a dollar-quoted body does not end the statement',
  statements("create function f() returns void as $$ begin a; b; end $$ language plpgsql;\nselect 1;\n").length === 2,
  'got ' + statements("create function f() returns void as $$ begin a; b; end $$ language plpgsql;\nselect 1;\n").length + ' statements, expected 2');

check('a named dollar tag is matched by its own tag, not by $$',
  statements("create function f() returns void as $body$ select $$x$$; $body$ language sql;\nselect 1;\n").length === 2);

check('a semicolon inside a single-quoted string does not end the statement',
  statements("select 'a;b';\nselect 2;\n").length === 2);

check("'' inside a string is an escaped quote, not a close and reopen",
  statements("select 'it''s; fine';\nselect 2;\n").length === 2);

check('a semicolon inside a line comment does not end the statement',
  statements("select 1 -- ; not here\n , 2;\nselect 3;\n").length === 2);

check('a semicolon inside a block comment does not end the statement',
  statements("select /* ; */ 1;\nselect 2;\n").length === 2);

check('block comments nest, the way Postgres nests them',
  statements("/* outer /* inner ; */ still comment ; */ select 1;\nselect 2;\n").length === 2);

check('a semicolon inside a quoted identifier does not end the statement',
  statements('select 1 as "a;b";\nselect 2;\n').length === 2);

check('an unterminated dollar quote is refused rather than guessed at', (() => {
  try { statements('select $$ never closed;'); return false; } catch (e) { return /unterminated/.test(e.message); }
})());

check('trailing text with no final semicolon is kept',
  statements('select 1;\nselect 2').length === 2);

// --------------------------------------------------- the checked-in parts
for (const base of SOURCES) {
  const src = path.join(ROOT, 'supabase', base + '.sql');

  check(base + ': source file is present', fs.existsSync(src));
  if (!fs.existsSync(src)) continue;

  const text = fs.readFileSync(src, 'utf8');
  const stmts = statements(text);

  check(base + ': the statements concatenate back to the source byte for byte',
    stmts.join('') === text);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlsplit-'));
  execFileSync(process.execPath, [SPLITTER, src, tmp, String(LIMIT)], { stdio: 'pipe' });
  const fresh = fs.readdirSync(tmp).filter((f) => f.endsWith('.sql')).sort();
  const checkedIn = fs.readdirSync(PARTS)
    .filter((f) => f.startsWith(base + '.part') && f.endsWith('.sql')).sort();

  check(base + ': the checked-in part files are the ones the splitter produces now',
    JSON.stringify(fresh) === JSON.stringify(checkedIn),
    'generated ' + JSON.stringify(fresh) + '\n    checked in ' + JSON.stringify(checkedIn)
      + '\n    regenerate with: npm run sql:split -- supabase/' + base + '.sql supabase/parts ' + LIMIT);

  for (const name of fresh) {
    if (!checkedIn.includes(name)) continue;
    check(base + ': ' + name + ' matches the current source',
      fs.readFileSync(path.join(tmp, name), 'utf8') === fs.readFileSync(path.join(PARTS, name), 'utf8'),
      'regenerate with: npm run sql:split -- supabase/' + base + '.sql supabase/parts ' + LIMIT);
  }

  // Every part must be small enough to survive the dashboard editor, which is the
  // whole reason these exist.
  for (const name of checkedIn) {
    const bytes = Buffer.byteLength(fs.readFileSync(path.join(PARTS, name)));
    check(base + ': ' + name + ' is under the paste limit',
      bytes <= LIMIT + 4096, name + ' is ' + bytes + ' bytes');
  }

  // Reassembling the parts (minus their generated headers) must reproduce the
  // source. This is the guarantee that matters: running the parts in order is
  // running the file.
  const rebuilt = checkedIn.map((name) => {
    const body = fs.readFileSync(path.join(PARTS, name), 'utf8');
    const nl = body.indexOf('\n\n');
    return body.slice(nl + 2);
  }).join('');
  check(base + ': the parts in order hold every statement of the source, in order',
    statements(rebuilt).map((s) => s.trim()).filter(Boolean).join('\n')
      === stmts.map((s) => s.trim()).filter(Boolean).join('\n'));

  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures.length) {
  console.log('FAILED ' + pass + ' passed, ' + failures.length + ' failed');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('ok ' + pass + ' assertions - supabase/parts is in sync with the contract files');
