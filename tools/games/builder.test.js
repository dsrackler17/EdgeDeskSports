#!/usr/bin/env node
/* ===========================================================================
   The challenge BUILDER.

   The games layer is not allowed to become a second source of truth, so the
   builder's whole job is to run the canonical Power 4 exporter and reshape its
   output. These tests hold that line:

     * it consumes a real exporter CSV and produces a valid artifact
     * it never writes a price the CSV did not contain
     * it refuses to publish an empty or unpriceable board
     * malformed, missing and hostile rows degrade rather than throw
     * the research state on every record agrees with the shipped classifier
     * slugs are unique even when two teams meet twice

   The exporter itself is NOT run here (it downloads a season of schedules);
   the fixture is real exporter output, captured from a real run.

   Run: node tools/games/builder.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') {
    try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 240); }
  }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
}
function eq(name, got, want) {
  chk(name, got === want, 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
}

const ROOT = path.join(__dirname, '..', '..');
const BUILDER = path.join(ROOT, 'games', 'build_challenges.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'slate_sample.csv');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'games-builder-test-'));

global.window = global.window || global;
require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
const RS = require(path.join(ROOT, 'games', 'lib', 'research_state.js'));

/* A REAL csv parse/serialise pair. The exporter quotes any field containing a
   comma (every driver sentence does), so a test that splits a row on ','
   silently misaligns every column after the first quoted one — which is how
   two of these assertions were wrong before they were right. */
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
function qq(v) {
  v = String(v == null ? '' : v);
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
function writeCsv(cols, rows) {
  return [cols.join(',')].concat(rows.map(r => r.map(qq).join(','))).join('\n') + '\n';
}

function build(slatePath, outName) {
  const out = path.join(TMP, outName);
  const r = cp.spawnSync(process.execPath,
    [BUILDER, '--slate', slatePath, '--out', out, '--quiet', '--no-market'],
    { encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr || '', out: out,
    json: r.status === 0 && fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null };
}

/* ---- the happy path, on real exporter output ---------------------------- */
const TABLE = parseCsv(fs.readFileSync(FIXTURE, 'utf8')).filter(r => r.length > 1);
const COLS = TABLE[0];
const ROWS = TABLE.slice(1);            /* parsed cell arrays, never raw strings */
const col = name => COLS.indexOf(name);
const good = build(FIXTURE, 'good.json');

eq('a real exporter slate builds', good.status, 0);
chk('and produces an artifact', !!good.json);
if (good.json) {
  const A = good.json;
  eq('the artifact declares its schema', A.schema, 'edgedesk_games_challenges_v1');
  chk('it records the model that produced the prices', !!A.model_version);
  chk('it records the scoring rule in force', !!A.scoring_version);
  chk('it records the thresholds it classified with', !!A.thresholds);
  eq('it counts what it read', A.counts.games, ROWS.length);
  chk('it says plainly that this is free to play',
    /no real-money wagering/i.test(A.basis));

  /* NO INVENTED NUMBERS: every published price must be the exporter's own
     number, rounded to the tenth the UI shows — and nothing else. */
  const byId = {};
  ROWS.forEach(r => { byId[r[col('game_id')]] = r; });
  chk('every EdgeDesk price is the exporter’s number, rounded to a tenth',
    A.challenges.every(c => {
      const raw = Number(byId[c.game_id][col('model_home_line')]);
      return Math.round(raw * 10) / 10 === c.edgedesk_spread;
    }),
    A.challenges.map(c => c.game_id + ':' + c.edgedesk_spread).join(' '));
  chk('the builder rounds rather than recomputing',
    A.challenges.every(c => Math.abs(Number(byId[c.game_id][col('model_home_line')])
      - c.edgedesk_spread) <= 0.05));
  chk('no challenge carries a market price the CSV did not have',
    A.challenges.every(c => c.market_spread === null));
  chk('a market-less game is honestly stated as such',
    A.challenges.every(c => c.market_spread !== null || c.research_state === 'THIN'
      || c.research_state === 'NO_MARKET'));

  /* the state on every record is the shipped classifier's */
  chk('every research state agrees with the shipped classifier',
    A.challenges.every(c => RS.classify(c.confidence, c.spread_gap).key === c.research_state));

  chk('every challenge has a slug', A.challenges.every(c => !!c.slug));
  chk('slugs are unique', new Set(A.challenges.map(c => c.slug)).size === A.challenges.length);
  chk('slugs are away-then-home',
    A.challenges.every(c => c.slug.indexOf(c.away_team.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-')[0]) === 0));
  chk('every challenge names both teams',
    A.challenges.every(c => c.home_team && c.away_team));
  chk('research factors are capped at four',
    A.challenges.every(c => c.factors.length <= 4));
  chk('every factor is signed', A.challenges.every(c =>
    c.factors.every(f => ['+', '-', '?'].indexOf(f.sign) >= 0)));
  chk('factor text is short enough to read on a phone',
    A.challenges.every(c => c.factors.every(f => f.text.length <= 120)));
  chk('every board states the model is unproven',
    A.challenges.every(c => c.unproven === true));
}

/* ---- it refuses rather than publishing nothing --------------------------- */
(() => {
  const p = path.join(TMP, 'empty.csv');
  fs.writeFileSync(p, writeCsv(COLS, []));
  const r = build(p, 'empty.json');
  eq('an empty slate is refused', r.status, 1);
  chk('and says why', /REFUSING TO WRITE/.test(r.stderr), r.stderr.slice(0, 120));
  chk('and writes no artifact', !fs.existsSync(path.join(TMP, 'empty.json')));
})();

(() => {
  /* every row present, but none of them priced */
  const rows = ROWS.map(r => { const c = r.slice(); c[col('model_home_line')] = ''; return c; });
  const p = path.join(TMP, 'unpriced.csv');
  fs.writeFileSync(p, writeCsv(COLS, rows));
  const r = build(p, 'unpriced.json');
  eq('a slate with no prices is refused rather than shipped blank', r.status, 1);
})();

/* ---- malformed and hostile input ---------------------------------------- */
(() => {
  const p = path.join(TMP, 'ragged.csv');
  fs.writeFileSync(p, writeCsv(COLS, [ROWS[0]]) + ',,,\nnot,a,row\n'
    + ROWS[1].map(qq).join(',') + '\n');
  const r = build(p, 'ragged.json');
  eq('ragged rows do not crash the build', r.status, 0);
  chk('and the good rows still make the board', r.json && r.json.challenges.length >= 1);
})();

(() => {
  const c = ROWS[0].slice();
  c[col('home_team')] = '<script>alert(1)</script>';
  const p = path.join(TMP, 'xss.csv');
  fs.writeFileSync(p, writeCsv(COLS, [c]));
  const r = build(p, 'xss.json');
  eq('a hostile team name does not crash the build', r.status, 0);
  chk('the raw markup is carried as DATA, and escaping is the page’s job',
    r.json && r.json.challenges.length === 1);
  /* the pages escape on render — proven in games.test.js — so the artifact
     itself is allowed to hold the literal text */
})();

(() => {
  const c = ROWS[0].slice();
  c[col('confidence')] = 'NaN';
  const p = path.join(TMP, 'badconf.csv');
  fs.writeFileSync(p, writeCsv(COLS, [c]));
  const r = build(p, 'badconf.json');
  eq('an unreadable confidence does not crash the build', r.status, 0);
  chk('an unreadable confidence becomes THIN DATA, never a trusted number',
    r.json && r.json.challenges[0].confidence === null
    && r.json.challenges[0].research_state === 'THIN');
})();

/* ---- a rematch gets distinct slugs -------------------------------------- */
(() => {
  const a = ROWS[0].slice(), b = ROWS[0].slice();
  b[col('game_id')] = String(Number(a[col('game_id')]) + 1);
  const p = path.join(TMP, 'rematch.csv');
  fs.writeFileSync(p, writeCsv(COLS, [a, b]));
  const r = build(p, 'rematch.json');
  eq('a rematch builds', r.status, 0);
  chk('and the two meetings get different slugs',
    r.json && new Set(r.json.challenges.map(c => c.slug)).size === r.json.challenges.length,
    r.json && r.json.challenges.map(c => c.slug).join(','));
})();

/* ---- determinism --------------------------------------------------------- */
(() => {
  const a = build(FIXTURE, 'det_a.json').json;
  const b = build(FIXTURE, 'det_b.json').json;
  if (a && b) {
    delete a.generated_at; delete b.generated_at;
    eq('two builds of the same slate produce the same board',
      JSON.stringify(a), JSON.stringify(b));
  } else chk('determinism could be checked', false);
})();

/* ---- the builder contains no model logic --------------------------------- */
(() => {
  const src = fs.readFileSync(BUILDER, 'utf8');
  chk('the builder runs the canonical exporter',
    src.indexOf('export_csv.js') >= 0);
  chk('the builder does not implement a rating, projection or pricing model',
    !/function\s+(project|predict|rate|price)[A-Z]/.test(src));
  chk('the builder does not require the engine directly, it shells out to the exporter',
    src.indexOf("require(path.join(HERE, 'engine.js'))") < 0);
  chk('the builder reads its thresholds from the shipped params',
    src.indexOf('research_state.js') >= 0);
  chk('the builder reads roster context from the committed rankings artifact',
    src.indexOf('rankings') >= 0 && src.indexOf('current.json') >= 0);
})();

/* ---- the workflows name credentials that can actually resolve -------------
   A missing secret in GitHub Actions is an empty string, never an error. Both
   games workflows shipped with a `SUPABASE_SERVICE_KEY` that does not exist,
   so they silently ran without the credential they were written to use — the
   challenge board read as anon and the settlement job exited 0 having settled
   nothing. Nothing failed, which is exactly why it went unnoticed. Pin the
   names to the ones this repository actually uses. ------------------------- */
(() => {
  const WF = path.join(ROOT, '.github', 'workflows');
  const ALLOWED = ['SB_SERVICE_ROLE', 'SB_URL', 'COLLECTIVE_ADMIN_REFRESH_TOKEN', 'GITHUB_TOKEN'];
  let files = [];
  try { files = fs.readdirSync(WF).filter(f => /\.ya?ml$/.test(f)); } catch (_) {}
  chk('the workflow directory could be read', files.length > 0, String(files.length));

  files.forEach(f => {
    /* strip comments so a name discussed in prose is not read as a reference */
    const src = fs.readFileSync(path.join(WF, f), 'utf8')
      .split('\n').map(l => l.replace(/(^|\s)#.*$/, '')).join('\n');
    const named = (src.match(/secrets\.[A-Za-z_][A-Za-z0-9_]*/g) || [])
      .map(m => m.slice('secrets.'.length));
    const unknown = named.filter(n => ALLOWED.indexOf(n) < 0);
    chk(f + ' references only credentials this repository defines',
      unknown.length === 0, unknown.join(','));
  });

  /* The suites must run on the pull request, not only after the merge. They
     used to live solely inside games-challenges.yml, which never fires on a
     pull_request, so every games PR merged with zero checks and the suites
     first ran against main — where a failure is already live. */
  (() => {
    const runners = files.filter(f => {
      const src = fs.readFileSync(path.join(WF, f), 'utf8');
      return src.indexOf('games:test') >= 0 && /^\s*pull_request:/m.test(src);
    });
    chk('some workflow runs the games suites on a pull request',
      runners.length > 0, runners.join(',') || 'none');
    runners.forEach(f => {
      const src = fs.readFileSync(path.join(WF, f), 'utf8');
      const on = src.slice(0, src.search(/^jobs:/m) >= 0 ? src.search(/^jobs:/m) : src.length);
      const pr = on.slice(on.indexOf('pull_request:'));
      const cut = pr.search(/\n  [a-z_]+:/);
      const scope = pr.slice(0, cut >= 0 ? cut : pr.length);
      /* Read the list ENTRIES, not the block. A path named in a comment is
         prose, and matching it would let the trigger lose the path while the
         assertion kept passing — which is exactly what happened first. */
      const globs = (scope.match(/^\s*-\s*'([^']+)'/gm) || [])
        .map(l => l.replace(/^\s*-\s*'/, '').replace(/'$/, ''));
      /* the paths that decide whether it triggers must cover what it tests */
      ['games/**', 'tools/games/**', 'package.json'].forEach(g => {
        chk(f + ' triggers on changes to ' + g, globs.indexOf(g) >= 0, globs.join(','));
      });
    });
  })();

  /* Backticks inside a DOUBLE-quoted shell string are command substitution.
     The missing-credential warning shipped with `signals` written that way, so
     the runner tried to execute `signals`, printed "command not found", and
     emitted the annotation with the word silently removed. The step still
     succeeded — a garbled message is not a failure — which is exactly how it
     reached main. Single quotes, or no backticks. */
  files.forEach(f => {
    const bad = [];
    fs.readFileSync(path.join(WF, f), 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*#/.test(line)) return;                 /* a comment is prose */
      if (/"[^"]*`[^"]*"/.test(line)) bad.push(i + 1);
    });
    chk(f + ' has no backticks inside a double-quoted shell string',
      bad.length === 0, 'line(s) ' + bad.join(','));
  });

  ['games-challenges.yml', 'games-settle.yml'].forEach(f => {
    const src = fs.readFileSync(path.join(WF, f), 'utf8');
    chk(f + ' passes the service role to the script',
      src.indexOf('EDGD_SB_SERVICE: ${{ secrets.SB_SERVICE_ROLE }}') >= 0);
    chk(f + ' passes the project URL alongside it, so the key is not orphaned',
      src.indexOf('EDGD_SB_URL: ${{ secrets.SB_URL }}') >= 0);
    chk(f + ' says out loud when the credential is missing, rather than degrading in silence',
      src.indexOf('::warning::SB_SERVICE_ROLE') >= 0);
  });
})();

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
console.log((fail ? 'FAIL' : 'PASS') + ' | games builder | ' + pass + ' passed, ' + fail + ' failed');
failures.forEach(f => console.log('  × ' + f));
process.exit(fail ? 1 : 0);
