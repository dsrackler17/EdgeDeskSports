#!/usr/bin/env node
/* ============================================================================
   THE ALTITUDE RE-CHECK — does the committed verdict still hold against the
   home field the engine prices with TODAY?

   The verdict in football/altitude/params.js (2026-10-17) was fitted against
   V1's 4.082-pt league home field. On 2026-10-19 the engine moved to one
   2.8-pt home field (football/cfb_p4/home_field.js, cfb_hfa_unified_v1). The
   README's double-counting argument ("V1 over-credits every home side by
   1.26 pts; at altitude it is already about right") was a statement about
   the old constant, so the question had to be asked again.

   This file does not re-fit anything. It compares two outputs of
   football/altitude/research/run.js — the committed record and a fresh run
   on the current engine — and writes the comparison:

     node football/altitude/research/run.js --data DIR      (in a scratch checkout: it rewrites params.js)
     node football/altitude/research/recheck.js --fresh <scratch>/football/validation/altitude_cfb.json --write

   Output: football/validation/altitude_cfb_recheck.json. It never touches
   params.js: promotion stays with run.js, its gates and a person.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const OUT = path.join(ROOT, 'football', 'validation', 'altitude_cfb_recheck.json');
const GROUPS = ['all non-neutral', 'gain >= 3,000 ft', 'host venue >= 3,000 ft (any visitor)', 'descent >= 3,000 ft'];

function arg(name) { const i = process.argv.indexOf('--' + name); return i < 0 ? null : (process.argv[i + 1] || true); }
function gate(J, id) { return (J.gates || []).filter((g) => g.id === id)[0] || null; }
function group(J, name) {
  const g = (J.subgroups || []).filter((x) => x.group === name)[0];
  return g ? { n: g.n, host_venues: g.host_venues, v1_residual: g.v1_residual.mean, ci95: g.v1_residual.ci95, v1_mae: g.v1_mae } : null;
}
function main3000(J) {
  const c = J.full_sample && J.full_sample.cat_3000, k = c && (c.coefficients || [])[0];
  return k ? { coef: k.ols, se: k.se, ci95: k.ci95, treated: c.treated, n: c.n, wild_p: c.wild_p_main } : null;
}

function recheck(before, after, meta) {
  const r = (J) => group(J, GROUPS[0]);
  return {
    schema: 'edgedesk_cfb_altitude_recheck_v1',
    run_at: after.generated_at,
    question: 'Does the altitude verdict, fitted against the 4.082-pt league home field, still hold against the 2.8-pt home field promoted on 2026-10-19 (football/cfb_p4/home_field.js)?',
    baseline: {
      before: { home_field_pts: 4.082, record_generated_at: before.generated_at },
      after: { home_field_pts: meta.hfa, home_field_version: meta.hfa_version },
      check: 'the all-games V1 residual moved from ' + r(before).v1_residual + ' to ' + r(after).v1_residual + ' pts, so the fresh replay ran on the new home field'
    },
    data: 'sportsdataverse/cfbfastR-data schedules 2001-2025 and betting/csv/cfb_line_odds.csv.gz via football/cfb_p4/research/build_market.py',
    not_run: (after.play_load_seasons && after.play_load_seasons.length) ? null
      : 'the play-load and opponent-pace diagnostics need the research package panel, which is not in the repository; neither can price',
    verdict: { before: before.status, after: after.status, points_applied: after.points_applied, support_state: after.support_state },
    support_text: after.support_text,
    selected: after.selected,
    gates: (after.gates || []).map((g) => ({ id: g.id, before: (gate(before, g.id) || {}).pass, after: g.pass })),
    cat_3000_full_sample: { before: main3000(before), after: main3000(after) },
    confirm_affected: { before: (gate(before, 'G1_promotion_rules_on_affected_games') || {}).evidence, after: (gate(after, 'G1_promotion_rules_on_affected_games') || {}).evidence },
    permutation_p: { before: ((gate(before, 'G4_permutation_placebo') || {}).evidence || {}).p, after: ((gate(after, 'G4_permutation_placebo') || {}).evidence || {}).p },
    venue_holdout: { before: ((gate(before, 'G6_venue_robustness') || {}).evidence || {}).pooled_holdout, after: ((gate(after, 'G6_venue_robustness') || {}).evidence || {}).pooled_holdout },
    residuals: GROUPS.map((n) => ({ group: n, before: group(before, n), after: group(after, n) })),
    reading: [
      'Altitude still moves 0 points: the selected term made the 139 held-out 2022-2025 games it touched slightly worse again, and shuffled altitude labels did as well often enough to fail the placebo.',
      'The double-counting argument has flipped. With 4.082 pts every home side was over-credited and mountain hosts were about right, so an altitude term would have counted twice. With 2.8 pts home sides overall are about right, and mountain hosts facing a 3,000+ ft climb are UNDER-credited by about a point. An altitude term would no longer double count; it would address a real but unproven residual.',
      'Home teams also beat the number by about 2 pts when a mountain visitor DESCENDS 3,000+ ft, which altitude physiology does not predict. Part of the residual may be how mountain programmes are rated, not thin air.'
    ],
    reproduce: 'CFB_P4_DATA=<dir> python3 football/cfb_p4/research/build_market.py <dir>/out && node football/altitude/research/run.js --data <dir> --write (in a scratch checkout) && node football/altitude/research/recheck.js --fresh <scratch>/football/validation/altitude_cfb.json --write'
  };
}

module.exports = { recheck, OUT };

if (require.main === module) {
  const fresh = arg('fresh');
  if (!fresh) { console.error('usage: recheck.js --fresh <path to a fresh altitude_cfb.json> [--write]'); process.exit(2); }
  const before = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'validation', 'altitude_cfb.json'), 'utf8'));
  const after = JSON.parse(fs.readFileSync(path.resolve(String(fresh)), 'utf8'));
  const HF = require(path.join(ROOT, 'football', 'cfb_p4', 'home_field.js'));
  const out = recheck(before, after, { hfa: HF.hfa, hfa_version: HF.version });
  const text = JSON.stringify(out, null, 1) + '\n';
  if (arg('write')) { fs.writeFileSync(OUT, text); console.error('[altitude recheck] wrote ' + path.relative(ROOT, OUT)); }
  else process.stdout.write(text);
}
