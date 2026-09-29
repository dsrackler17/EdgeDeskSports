#!/usr/bin/env node
/* ===========================================================================
   The factory → terminal hand-off (football/props/factory/export.js):
   projections keyed by the terminal's own game, player and market ids, never
   by name; the terminal's board narrows what is exported; a compact
   distribution keeps the factory's probabilities at every line.

     node football/props/factory/export.test.js
   =========================================================================== */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const EDP = require('./dist.js');
const X = require('./export.js');

let pass = 0, fail = 0;
function chk(label, fn) { try { fn(); pass++; } catch (e) { fail++; console.log('FAIL | ' + label + ' | ' + (e && e.message)); } }

const table = { probs: [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99], bins: [{ mu_lo: 1, mu_hi: 200, mu_mid: 60, n: 1000, q: [0, 0.35, 0.68, 1.0, 1.32, 1.66, 2.4] }] };
const yd = EDP.roundDist(EDP.dist.continuousFromRatio(74, table, 0, { integer: true }));
const rec = EDP.roundDist(EDP.dist.negBinomPmf(5.2, 9));
const td = EDP.roundDist(EDP.dist.bernoulli(0.41));
function proj(o) {
  const s = EDP.dist.summary(o.dist);
  return Object.assign({ league: 'NFL', game_id: '2026_05_KC_BUF', kickoff_utc: '2026-10-04T17:00:00.000Z', team: 'KC', position: 'TE', player_id: 'espn:15847', player: 'Travis Kelce',
    gsis_id: '00-0030506', espn_id: '15847', feature_version: 'pf1', outcome_tier: 'OUTCOME_VALIDATED', prediction_id: 'pp_x', as_of: '2026-10-01T12:00:00.000Z',
    mean: s.mean, median: s.median, p10: s.p10, p90: s.p90, drivers: [['target share (last 5)', 6.1]] }, o);
}
const scored = { league: 'NFL', season: 2026, generated_at: '2026-10-01T12:00:00.000Z', props: [
  proj({ market_key: 'receiving_yards', model_version: 'nfl_te_receiving_yards_v1.2025', dist: yd }),
  proj({ market_key: 'receptions', model_version: 'nfl_te_receptions_v1.2025', dist: rec }),
  proj({ market_key: 'anytime_td', model_version: 'nfl_te_anytime_td_v1.2025', dist: td }),
  proj({ market_key: 'pass_rush_rec_yards', model_version: 'nfl_te_pass_rush_rec_yards_v1.2025', dist: yd }),
  proj({ market_key: 'receiving_yards', model_version: 'nfl_te_receiving_yards_v1.2025', dist: yd, player_id: 'espn:1', gsis_id: null, espn_id: '1' })
] };
const registry = { models: [{ model_version: 'nfl_te_receiving_yards_v1.2025', outcome_tier: 'OUTCOME_VALIDATED', walk_forward: { folds: 3, mean_mae_skill: 0.12, mean_pit_max_abs_dev: 0.02 } }] };

const doc = X.build(scored, registry, null);
chk('keys are the terminal\'s own ids: game, GSIS player id (NFL), terminal market key', () => {
  assert.ok(doc.rows['2026_05_KC_BUF|00-0030506|rec_yds']); assert.ok(doc.rows['2026_05_KC_BUF|00-0030506|receptions']); assert.ok(doc.rows['2026_05_KC_BUF|00-0030506|anytime_td']);
});
chk('a player with no terminal id is skipped, never matched by name', () => { assert.strictEqual(doc.skipped.no_terminal_id, 1); });
chk('a factory market the terminal does not list is not exported', () => { assert.strictEqual(doc.skipped.market_not_listed, 1); assert.ok(!Object.keys(doc.rows).some((k) => /pass_rush_rec/.test(k))); });
chk('college keys on the ESPN athlete id', () => {
  const c = X.build({ league: 'CFB', season: 2026, generated_at: 'x', props: [proj({ league: 'CFB', game_id: '401871049', market_key: 'rush_yards', model_version: 'cfb_rb_rush_yards_v1.2025', dist: yd, gsis_id: null, espn_id: '4869443', player_id: 'espn:4869443' })] }, null, null);
  assert.ok(c.rows['401871049|4869443|rush_yds']);
});
chk('the terminal board narrows the export to the players it shows', () => {
  const d = X.build(scored, registry, { props: [{ g: '2026_05_KC_BUF', p: 'someone-else', m: 'rec_yds' }] });
  assert.strictEqual(d.n, 0); assert.ok(d.skipped.not_on_board >= 3);
  const d2 = X.build(scored, registry, { props: [{ g: '2026_05_KC_BUF', p: '00-0030506', m: 'rec_yds' }] });
  assert.strictEqual(d2.n, 3, 'every exported market of a shown player, not only the ones it prices today');
});
chk('the model table carries the version, its walk-forward tier and evidence', () => {
  const r = doc.rows['2026_05_KC_BUF|00-0030506|rec_yds'], m = doc.models[r[0]];
  assert.deepStrictEqual(m, ['nfl_te_receiving_yards_v1.2025', 'OUTCOME_VALIDATED', 0.12, 0.02, 3]);
});
chk('a compact distribution keeps the factory\'s probability at every line (within 0.01)', () => {
  const c = doc.rows['2026_05_KC_BUF|00-0030506|rec_yds'][1];
  assert.ok(c.x.length <= 29);
  for (let line = 20.5; line <= 140.5; line += 5) { const a = EDP.dist.probs(yd, line).over, b = EDP.dist.probs(c, line).over; assert.ok(Math.abs(a - b) < 0.01, line + ': ' + a + ' vs ' + b); }
  const cr = doc.rows['2026_05_KC_BUF|00-0030506|receptions'][1];
  for (let line = 0.5; line <= 9.5; line += 1) assert.ok(Math.abs(EDP.dist.probs(rec, line).over - EDP.dist.probs(cr, line).over) < 1e-4);
  assert.strictEqual(doc.rows['2026_05_KC_BUF|00-0030506|anytime_td'][1].p, 0.41);
});
const PUB = path.join(__dirname, 'nfl', 'projections.json');
if (fs.existsSync(PUB)) {
  chk('the committed NFL projections are valid and small', () => {
    const j = JSON.parse(fs.readFileSync(PUB, 'utf8'));
    assert.strictEqual(j.schema, X.SCHEMA); assert.ok(fs.statSync(PUB).size < 1.5e6, 'size');
    Object.keys(j.rows).slice(0, 200).forEach((k) => { const r = j.rows[k]; assert.ok(j.models[r[0]] && EDP.dist.valid(r[1]), k); });
  });
}

/* the database mirror: psql answers a boolean as the text 't' or 'f', and 'f'
   is truthy — a database without supabase/props_factory.sql is skipped (said,
   not failed), never written into table by missing table */
(async function () {
  const DB = require('./db.js');
  const seen = [];
  const fake = { ping: () => true, scalar: (q) => { seen.push(q); return 'f'; }, script: () => { throw new Error('wrote to a database without the contract'); } };
  let r;
  try { r = await DB.sync({ leagues: {} }, { client: fake }); } catch (e) { r = { error: e.message }; }
  chk('a database without the contract is skipped, not failed, and the skip names the fix', () => {
    assert.ok(r && r.skipped && r.not_applied, JSON.stringify(r));
    assert.ok(/props_factory\.sql/.test(r.skipped) && /apply_sql/.test(r.skipped), r.skipped);
  });
  chk('…after asking for the first and the last contract table', () => { assert.ok(/props\.feature_registry/.test(seen[0]) && /props\.fact_prop_quote/.test(seen[0]), seen[0]); });

  console.log((fail ? 'FAILED' : 'ALL GREEN') + ' props factory export — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}());
