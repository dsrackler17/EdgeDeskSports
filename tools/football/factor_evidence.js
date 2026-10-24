#!/usr/bin/env node
/* ===========================================================================
   WRITE (or check) docs/game-research/FACTORS.md and
   football/game_research/factors.json from the factor evidence registry
   (lib/edgedesk_factor_evidence.js), which reads only the generated model
   and validation files. The page is never edited by hand.

     node tools/football/factor_evidence.js            print the table
     node tools/football/factor_evidence.js --write    write both files
     node tools/football/factor_evidence.js --check    fail if either file is stale
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
global.window = global.window || global;
const FE = require(path.join(ROOT, 'lib', 'edgedesk_factor_evidence.js'));

const MD = path.join(ROOT, 'docs', 'game-research', 'FACTORS.md');
const JS = path.join(ROOT, 'football', 'game_research', 'factors.json');

const reg = FE.load(ROOT);
const md = FE.markdown(reg);
const json = JSON.stringify(reg, null, 1) + '\n';

if (process.argv.includes('--check')) {
  const stale = [[MD, md], [JS, json]].filter(([f, want]) => !fs.existsSync(f) || fs.readFileSync(f, 'utf8') !== want).map(([f]) => path.relative(ROOT, f));
  if (stale.length) { console.error('factor evidence: stale ' + stale.join(', ') + ' — run node tools/football/factor_evidence.js --write'); process.exit(1); }
  console.log('factor evidence: FACTORS.md and factors.json match the generated records (' + Object.keys(reg.factors).length + ' factors)');
} else if (process.argv.includes('--write')) {
  fs.writeFileSync(MD, md);
  fs.writeFileSync(JS, json);
  console.log('factor evidence: wrote ' + path.relative(ROOT, MD) + ' and ' + path.relative(ROOT, JS));
} else process.stdout.write(md);
