#!/usr/bin/env node
/* ============================================================================
   KEY NUMBERS, FROM WHAT ACTUALLY HAPPENED — per league, never shared.

     node tools/validation/build_key_numbers.js          # print
     node tools/validation/build_key_numbers.js --write  # football/validation/key_numbers.json

   Reads every final margin in the committed closing-line archives
   (football/pricing/lines_nfl.json, lines_cfb.json), measures each league's
   share of games decided by exactly k points, and derives its key numbers
   with lib/edgedesk_execution.js keyNumbers (a margin is PRIMARY at ≥ 2× the
   league's average mass over 1–21 and ≥ 6%, SECONDARY at ≥ 1.25×).

   The NFL and college football are measured separately: their scoring
   distributions are not the same, and the value of +2.5 → +3 is not the
   value of +8.5 → +9. The per-game value of a half point is read at pricing
   time from THIS game's own outcome distribution (EDQuoteEV / EDExecution);
   this table labels which numbers are keys, and says how many games say so.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const X = require(path.join(ROOT, 'lib', 'edgedesk_execution.js'));
const OUT = path.join(ROOT, 'football', 'validation', 'key_numbers.json');

function r(x, k) { const m = Math.pow(10, k); return Math.round(x * m) / m; }
function league(file, sport) {
  const J = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  const games = (J.games || []).filter((g) => typeof g.margin === 'number' && isFinite(g.margin));
  const abs = {}, byLine = {};
  let ot = 0;
  games.forEach((g) => {
    const a = Math.abs(Math.round(g.margin));
    abs[a] = (abs[a] || 0) + 1;
    if (g.overtime) ot++;
    const hl = g.close && typeof g.close.home_line === 'number' ? Math.abs(g.close.home_line) : null;
    if (hl != null) { const b = hl < 3 ? '0-2.5' : (hl < 7 ? '3-6.5' : (hl < 14 ? '7-13.5' : '14+')); (byLine[b] = byLine[b] || { n: 0, m: {} }).n++; byLine[b].m[a] = (byLine[b].m[a] || 0) + 1; }
  });
  const n = games.length, mass = {};
  for (let k = 0; k <= 45; k++) mass[k] = r((abs[k] || 0) / n, 5);
  const keys = X.keyNumbers(mass);
  const seasons = games.map((g) => g.season).filter((s) => typeof s === 'number');
  const buckets = {};
  Object.keys(byLine).sort().forEach((b) => { const B = byLine[b]; buckets[b] = { n: B.n, top: Object.keys(B.m).map(Number).filter((k) => k > 0).sort((x, y) => B.m[y] - B.m[x]).slice(0, 6).map((k) => ({ margin: k, mass: r(B.m[k] / B.n, 4) })) }; });
  return { sport: sport, source: file + ' (final margins)', n_games: n, seasons: [Math.min.apply(null, seasons), Math.max.apply(null, seasons)], overtime_games: ot,
    abs_margin_mass: mass, key_numbers: keys, by_closing_line: buckets };
}
function build() {
  return { schema: 'edgedesk_key_numbers_v1', generated_by: 'tools/validation/build_key_numbers.js', rule: X.CONFIG.key_rule,
    note: 'Empirical, per league. The decision engine reads each game’s own distribution for the value of a half point; this table only names which margins are keys and how many games support it.',
    leagues: { NFL: league('football/pricing/lines_nfl.json', 'NFL'), CFB: league('football/pricing/lines_cfb.json', 'CFB') } };
}
if (require.main === module) {
  const K = build();
  ['NFL', 'CFB'].forEach((s) => { const L = K.leagues[s]; console.log(s + ' · n=' + L.n_games + ' (' + L.seasons.join('–') + ') · primary ' + L.key_numbers.primary.join(', ') + ' · secondary ' + L.key_numbers.secondary.join(', ') + ' · top ' + L.key_numbers.ranked.slice(0, 6).map((x) => x.margin + ':' + (100 * x.mass).toFixed(1) + '%').join(' ')); });
  if (process.argv.includes('--write')) { fs.writeFileSync(OUT, JSON.stringify(K, null, 1) + '\n'); console.log('wrote ' + path.relative(ROOT, OUT)); }
}
module.exports = { build: build };
