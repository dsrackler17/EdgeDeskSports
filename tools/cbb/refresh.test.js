#!/usr/bin/env node
/* ===========================================================================
   THE REFRESH PATH.

   This repository has already paid for the lesson this suite exists to hold.
   The MLB offensive refresh step passed a season range and no mode, so the
   importer printed "nothing to do", exited 0, and the job reported success
   having rebuilt nothing and imported nothing. A green job that did no work is
   the one failure an unattended refresh must never be capable of.

   So the workflow's own text is read here, both branches of it, along with
   the season gate that keeps a February-to-June sport from importing an empty
   card every morning for the other seven months.

   Run: node tools/cbb/refresh.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const WF = path.join(ROOT, '.github', 'workflows', 'college-baseball.yml');
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d !== undefined ? '  ' + JSON.stringify(d).slice(0, 240) : '')); } };

const wf = fs.readFileSync(WF, 'utf8');

console.log('the workflow names a mode, every time');
{
  const at = wf.indexOf('Rebuild the card and import it');
  ok('the workflow has a refresh step', at > 0);
  const step = wf.slice(at);
  ok('…which runs the ingest', /node tools\/cbb\/ingest\.js/.test(step));
  /* BOTH BRANCHES. A step that commits on a schedule and says nothing
     otherwise is exactly the hollow step that shipped last time. */
  ok('…commits on a scheduled run', /ARGS="\$ARGS --commit"/.test(step), step.slice(0, 400));
  ok('…and asks for a fetch-and-validate when it is not committing',
    /ARGS="\$ARGS --check"/.test(step), step.slice(0, 400));
  ok('…and refuses to run without credentials',
    /SB_SERVICE_ROLE and SB_URL are not both set/.test(step));
  ok('…passing the shrink override only when it is asked for',
    /inputs\.allow_shrink.*--allow-shrink/s.test(step));
}

console.log('the season gate');
{
  ok('the workflow decides whether there is a season at all', /Decide whether there is a season to refresh/.test(wf));
  ok('…February to June', /MONTH" -ge 2 \] && \[ "\$MONTH" -le 6/.test(wf), 'month window');
  ok('…and says so rather than importing an empty card',
    /Out of season, there is nothing to import/.test(wf));
  /* the refresh must not run on a scheduled out-of-season morning */
  const at = wf.indexOf('Rebuild the card and import it');
  const cond = wf.slice(wf.lastIndexOf('if:', at + 200), at + 400);
  ok('…and the refresh is skipped on those mornings',
    /in_season == 'true'/.test(wf.slice(at, at + 400)) || /in_season == 'true'/.test(cond),
    wf.slice(at, at + 300));
}

console.log('the probes stay on pull requests, where they cost nothing');
{
  ok('the union walk does not run on every scheduled morning',
    /Price the union walk[\s\S]{0,120}if: \$\{\{ github\.event_name == 'pull_request' \}\}/.test(wf), 'walk guard');
  ok('…nor does the coverage probe',
    /Is it all the games[\s\S]{0,120}if: \$\{\{ github\.event_name == 'pull_request' \}\}/.test(wf), 'coverage guard');
}

console.log('the CLI still refuses to guess a mode');
{
  const out = cp.execFileSync(process.execPath, [path.join(ROOT, 'tools', 'cbb', 'ingest.js')],
    { encoding: 'utf8' });
  ok('given no mode it says what to pass', /Pass --check .* or --commit/.test(out), out.slice(0, 160));
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'cbb', 'ingest.js'), 'utf8');
  ok('…and the shrink override is only ever set from the command line',
    /allowShrink: has\('--allow-shrink'\)/.test(src));
  /* PACING IS NOT OPTIONAL. The source answers 200 with an empty slate when
     it is asked in a burst; an unpaced walk would import a hole. */
  ok('the walk paces itself', /await sleep\(PACE\)/.test(src));
  ok('…and the pace is a real delay by default', /arg\('--pace', 120\)/.test(src));
  ok('the union is empty-checked before anything is written',
    /the union is empty; refusing to go further/.test(src));
}

console.log(fail === 0 ? `ALL GREEN ${pass} passed, 0 failed` : `FAILED ${pass} passed, ${fail} failed`);
if (fail === 0) console.log(`PASS | cbb refresh path | ${pass} assertions`);
process.exit(fail === 0 ? 0 : 1);
