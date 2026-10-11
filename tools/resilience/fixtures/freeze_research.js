#!/usr/bin/env node
'use strict';
/* ===========================================================================
   FREEZE the market-resilience scenario games as a HISTORICAL TEST FIXTURE
   (tools/resilience/resilience.test.js and research_snapshots_sql.test.js,
   docs/market-resilience/README.md)

   Every scenario is written around UCF @ Oklahoma State (401856824, kickoff
   2026-10-10 16:00Z) four hours before kickoff, plus one projected,
   decision-evaluated game without a regime change. Pinning the build's clock
   was not enough: the committed slate itself moves on after Saturday, and the
   suite had nothing to stand on (2026-10-11). This builds the terminal once,
   at that clock, and keeps exactly those two research objects.

   Run it from a checkout whose committed artifacts still carry the game
   (main at fafef03, #546's merge, with the current code on top):
     node tools/resilience/fixtures/freeze_research.js    (already run 2026-10-11)
   =========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..', '..', '..');

const OUT = path.join(__dirname, 'research_2026_10_10.json.gz');
const NOW = '2026-10-10T12:00:00.000Z';
const OSU_ID = '401856824';
/* a projected, decision-evaluated game without a regime change: S1's market */
function isPlain(o) {
  return o.week_scope !== 'FUTURE_WEEK' && o.edgedesk.available && !(o.edgedesk.regime && (o.edgedesk.regime.home || o.edgedesk.regime.away))
    && !!o.decision_status && o.decision_status.key !== 'NO_DECISION';
}

function main() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'resil-freeze-'));
  cp.execFileSync(process.execPath, [path.join(ROOT, 'football', 'cfb_terminal', 'build.js'), '--out', out, '--now', NOW], { stdio: 'ignore' });
  const G = JSON.parse(fs.readFileSync(path.join(out, 'games.json'), 'utf8'));
  fs.rmSync(out, { recursive: true, force: true });
  const osu = G.games[OSU_ID];
  const plain = Object.values(G.games).find(isPlain);
  if (!osu || !plain) throw new Error('this checkout no longer carries the scenario games: ' + JSON.stringify({ osu: !!osu, plain: !!plain }));
  const doc = {
    schema: 'edgedesk_resilience_fixture_v1',
    kind: 'HISTORICAL TEST FIXTURE — two research objects from football/cfb_terminal/build.js --now ' + NOW + ', as the committed artifacts stood on 2026-10-10.',
    frozen_at: new Date().toISOString(), now: G.generated_at, terminal_schema: G.schema, inputs_sha256: G.inputs_sha256,
    osu_id: OSU_ID, plain_id: plain.game_id,
    games: { [OSU_ID]: osu, [plain.game_id]: plain },
  };
  fs.writeFileSync(OUT, zlib.gzipSync(JSON.stringify(doc), { level: 9 }));
  console.log('wrote ' + path.relative(ROOT, OUT) + ' (' + fs.statSync(OUT).size + ' bytes; plain = ' + plain.game_id + ')');
}
if (require.main === module) main();
module.exports = { OUT, NOW, OSU_ID, isPlain };
