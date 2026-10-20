#!/usr/bin/env node
/* ===========================================================================
   WHAT WOULD A DEPLOY LOSE?

   .github/workflows/deploy-collective-public.yml downloads the live
   collective_public before it deploys the repo's copy over it. When the live
   copy matches no committed version, a line-by-line diff of two ~2,000 line
   files mostly shows comments that were reworded and code that moved, and
   says nothing useful about the question that matters: is there CODE running
   in production that the repo copy does not have?

   This answers that. Comments and blank lines are dropped, whitespace is
   collapsed, and every remaining line of the live copy that appears nowhere
   in the repo copy is printed with its line number. An empty list means the
   deploy loses no code; anything listed is what a person has to look at.

   Run: node tools/collective/deployed_drift.js <deployed.ts> <repo.ts>
   =========================================================================== */
'use strict';
const fs = require('fs');

/* Comments out, strings kept: a `//` inside "https://..." is not a comment.
   Template literals are treated as one string, so a nested template inside
   ${ } can confuse it, but both files go through the same pass, so an
   identical line still comes out identical. */
function stripComments(src) {
  let out = '', i = 0, q = null;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (q) {
      out += c;
      if (c === '\\') { out += d === undefined ? '' : d; i += 2; continue; }
      if (c === q) q = null;
      else if (c === '\n' && q !== '`') q = null;
      i++;
      continue;
    }
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const body = src.slice(i, end < 0 ? src.length : end + 2);
      out += body.replace(/[^\n]/g, '');   // keep the line count
      i += body.length;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') q = c;
    out += c;
    i++;
  }
  return out;
}

function codeLines(src) {
  return stripComments(src.replace(/\r\n?/g, '\n')).split('\n')
    .map((l, n) => ({ n: n + 1, s: l.trim().replace(/\s+/g, ' ') }))
    .filter((l) => l.s !== '');
}

function drift(deployedSrc, repoSrc) {
  const have = new Set(codeLines(repoSrc).map((l) => l.s));
  return codeLines(deployedSrc).filter((l) => !have.has(l.s));
}

if (require.main === module) {
  const [a, b] = process.argv.slice(2);
  if (!a || !b) { console.error('usage: deployed_drift.js <deployed.ts> <repo.ts>'); process.exit(64); }
  const lost = drift(fs.readFileSync(a, 'utf8'), fs.readFileSync(b, 'utf8'));
  if (!lost.length) {
    console.log('Every line of code in the deployed copy is also in the repo copy: deploying loses no code.');
  } else {
    console.log(`${lost.length} line(s) of code in the deployed copy appear nowhere in the repo copy` +
      ' (comments and whitespace ignored). Deploying replaces them:');
    lost.slice(0, 400).forEach((l) => console.log(`  ${String(l.n).padStart(5)} | ${l.s.slice(0, 200)}`));
    if (lost.length > 400) console.log(`  … and ${lost.length - 400} more`);
  }
}

module.exports = { stripComments, codeLines, drift };
