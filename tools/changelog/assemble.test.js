#!/usr/bin/env node
/* ============================================================================
   tools/changelog/assemble.js — fragments in, CHANGELOG.md out.

   The regression: on 2026-10-26 #799's merge (ffc4047085) resolved a conflict
   at the top of CHANGELOG.md by hand and dropped four entries (#801's matchup
   graphic, #799's own, #797's NHL check, the exhibitions entry), restored by
   three later commits. Section 3 re-enacts it in a temporary repository: two
   branches that both edit the top of CHANGELOG.md conflict; two branches that
   each add a fragment merge cleanly, and the assembled file holds both.

   Run: node tools/changelog/assemble.test.js
   ============================================================================ */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const A = require('./assemble');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { ok = false; detail = String(e && e.stack || e).slice(0, 300); } }
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}
const frag = (name, text) => A.parseFragment(name, text);

/* 1. what a fragment is */
chk('a well-formed fragment parses', frag('2026-10-26-ok.md', '## 2026-10-26 — Headline\n\nBody.\n').problems.length === 0);
chk('the name must be YYYY-MM-DD-slug.md', frag('Fix Stuff.md', '## 2026-10-26 — H\n\nB\n').problems.length === 1);
chk('the first line is "## date — headline", with an em dash', frag('2026-10-26-a.md', '## 2026-10-26 - H\n\nB\n').problems.some((p) => /em dash/.test(p)));
chk('the heading date matches the file name', frag('2026-10-25-a.md', '## 2026-10-26 — H\n\nB\n').problems.some((p) => /differs/.test(p)));
chk('a date that is not a calendar date is refused', frag('2026-02-30-a.md', '## 2026-02-30 — H\n\nB\n').problems.some((p) => /calendar/.test(p)));
chk('one entry per fragment', frag('2026-10-26-a.md', '## 2026-10-26 — H\n\nB\n\n## 2026-10-26 — Another\n\nC\n').problems.some((p) => /one entry/.test(p)));
chk('an entry has a body', frag('2026-10-26-a.md', '## 2026-10-26 — H\n').problems.some((p) => /no body/.test(p)));
chk('a fragment cannot carry the block markers', frag('2026-10-26-a.md', '## 2026-10-26 — H\n\n' + A.END + '\n').problems.some((p) => /markers/.test(p)));
chk('slugs are lowercase words', A.slugify('CFB: the EV check — reads σ again!') === 'cfb-the-ev-check-reads-again');

/* 2. the block */
const doc = (block) => '# Changelog\n\nintro\n\n' + A.START + (block || '\n') + A.END + '\n\n## 2026-10-01 — Old\n\nhistory\n';
const f1 = frag('2026-10-26-a.md', '## 2026-10-26 — A\n\nalpha\n');
const f2 = frag('2026-10-26-b.md', '## 2026-10-26 — B\n\nbeta\n');
const f3 = frag('2026-10-27-c.md', '## 2026-10-27 — C\n\ngamma\n');
const once = A.assemble(doc(), [f1]);
chk('an entry renders inside the block, history untouched', once.includes('<!-- changelog.d/2026-10-26-a.md -->\n## 2026-10-26 — A\n\nalpha') && once.endsWith('## 2026-10-01 — Old\n\nhistory\n') && once.startsWith('# Changelog\n\nintro\n\n'));
const twice = A.assemble(once, [f1, f2]);
chk('a new entry goes on top of its date, the old one keeps its place', twice.indexOf('2026-10-26-b.md') < twice.indexOf('2026-10-26-a.md'));
const thrice = A.assemble(twice, [f1, f2, f3]);
chk('newest date first', thrice.indexOf('2026-10-27-c.md') < thrice.indexOf('2026-10-26-b.md'));
chk('assembling again changes nothing (idempotent)', A.assemble(thrice, [f3, f1, f2]) === thrice);
const edited = A.assemble(thrice, [f1, frag('2026-10-26-b.md', '## 2026-10-26 — B, corrected\n\nbeta\n'), f3]);
chk('editing a fragment edits its entry in place', edited.includes('B, corrected') && edited.indexOf('2026-10-26-b.md') < edited.indexOf('2026-10-26-a.md'));
chk('a deleted fragment leaves the block', !A.assemble(thrice, [f1, f3]).includes('2026-10-26-b.md'));
chk('a file without the markers is an error, not a silent rewrite', (() => { try { A.assemble('# Changelog\n', [f1]); return false; } catch (e) { return /marker/.test(e.message); } })());

/* 3. the regression, in git */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-merge-'));
const ENV = Object.assign({}, process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
const git = (args) => execFileSync('git', args, { cwd: tmp, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (rel, t) => { fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true }); fs.writeFileSync(path.join(tmp, rel), t); };
const commitAll = (m) => { git(['add', '-A']); git(['commit', '-q', '-m', m]); };
try {
  git(['init', '-q', '-b', 'main']);
  put('CHANGELOG.md', doc());
  commitAll('base');
  /* the old way: both pull requests put their entry at the top of CHANGELOG.md */
  git(['checkout', '-q', '-b', 'pr799-old']);
  put('CHANGELOG.md', doc().replace('\n\n## 2026-10-01', '\n\n## 2026-10-26 — CFB: the EV plausibility check reads each game\'s width again\n\nfix\n\n## 2026-10-01'));
  commitAll('#799 entry');
  git(['checkout', '-q', 'main']); git(['checkout', '-q', '-b', 'pr801-old']);
  put('CHANGELOG.md', doc().replace('\n\n## 2026-10-01', '\n\n## 2026-10-26 — The matchup graphic on every sport\n\ngraphic\n\n## 2026-10-01'));
  commitAll('#801 entry');
  git(['checkout', '-q', 'main']); git(['merge', '-q', '--no-ff', 'pr801-old', '-m', 'merge #801']);
  const old = spawnSync('git', ['merge', '--no-ff', 'pr799-old', '-m', 'merge #799'], { cwd: tmp, env: ENV, encoding: 'utf8' });
  chk('the old way: two entries at the top of CHANGELOG.md conflict (what #799\'s merge resolved by hand, dropping four)', old.status !== 0 && /CONFLICT/.test(old.stdout + old.stderr), old.stdout + old.stderr);
  spawnSync('git', ['merge', '--abort'], { cwd: tmp, env: ENV });

  /* the new way: each pull request adds its own fragment */
  git(['checkout', '-q', '-b', 'pr799', 'main~1']);
  put('changelog.d/2026-10-26-cfb-ev-width.md', '## 2026-10-26 — CFB: the EV plausibility check reads each game\'s width again\n\nfix\n');
  commitAll('#799 fragment');
  git(['checkout', '-q', '-b', 'pr801', 'main~1']);
  put('changelog.d/2026-10-26-matchup-graphic-every-sport.md', '## 2026-10-26 — The matchup graphic on every sport\n\ngraphic\n');
  commitAll('#801 fragment');
  git(['checkout', '-q', '-b', 'main2', 'main~1']);
  const m1 = spawnSync('git', ['merge', '--no-ff', 'pr801', '-m', 'merge #801'], { cwd: tmp, env: ENV, encoding: 'utf8' });
  const m2 = spawnSync('git', ['merge', '--no-ff', 'pr799', '-m', 'merge #799'], { cwd: tmp, env: ENV, encoding: 'utf8' });
  chk('the new way: two fragments merge with no conflict, in either order', m1.status === 0 && m2.status === 0, m1.stderr + m2.stderr);
  const frags = A.readFragments(tmp);
  const out = A.assemble(fs.readFileSync(path.join(tmp, 'CHANGELOG.md'), 'utf8'), frags);
  chk('… and the assembled changelog holds both entries', /matchup graphic on every sport/.test(out) && /reads each game's width again/.test(out) && frags.length === 2);
} catch (e) {
  chk('the git re-enactment ran', false, String(e && e.stack));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* 4. the repository itself (never "is CHANGELOG.md up to date": a pull request
      adds a fragment that only main renders) */
const repoFrags = A.readFragments(ROOT);
chk('every fragment in changelog.d/ is well formed', repoFrags.every((f) => f.problems.length === 0), repoFrags.filter((f) => f.problems.length).map((f) => f.name + ': ' + f.problems.join('; ')));
chk('CHANGELOG.md carries the block markers, once each', (() => { const t = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'); return t.split(A.START).length === 2 && t.split(A.END).length === 2 && t.indexOf(A.START) < t.indexOf(A.END); })());
chk('CHANGELOG.md assembles from the fragments without error', (() => { A.assemble(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'), repoFrags); return true; })());

failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 500) : '')));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'changelog fragments — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
