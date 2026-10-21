#!/usr/bin/env node
/* ============================================================================
   CFB production — THE CHAMPION TABLE (lib/cfb_champion.js reads it).

   The governance champion (football/cfb_lab/governance/model_roles.jsonl) is
   what every CFB surface should price. V1 prices itself (cfb_p4 engine, in
   the page and in the slate build); any other champion is priced from its
   STORED pregame numbers, read through the Model Lab's own adapters
   (football/cfb_lab/models.js), so the board, the lab and the record read a
   challenger the same way. This writes those numbers, per game, to
   football/cfb_production/reports/champion.json:

     V1 champion        an empty table: nothing anywhere changes
     a loop champion    the model loop's served cards (football/cfb/model_loop/
                        current.json) — only while the loop serves EXACTLY the
                        promoted version; a newer loop version is not the
                        champion until a person promotes it, so the table is
                        empty (V1 prices every game) until then
     a V2.x champion    football/cfb_v2/current.json through its own engine
                        (the canonical pure projection), same exact-version rule

   An entry carries the champion's margin, total, win probability, interval,
   components and the distribution it publishes, with as_of (when the champion
   computed it) and kickoff. lib/cfb_champion.js offers an entry only while it
   is pregame and fresh; every other game falls back to V1 and says so.

   Usage: node football/cfb_production/champion.js [--write] [--season 2026]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..', '..');
const G = require(path.join(REPO, 'football', 'cfb_lab', 'ledger.js'));
const GOV = require(path.join(REPO, 'football', 'cfb_lab', 'governance.js'));
const M = require(path.join(REPO, 'football', 'cfb_lab', 'models.js'));
const CHAMP = require(path.join(REPO, 'lib', 'cfb_champion.js'));

const OUT = path.join(__dirname, 'reports', 'champion.json');
const r = (x, d) => (typeof x === 'number' && isFinite(x) ? Math.round(x * Math.pow(10, d)) / Math.pow(10, d) : null);

function kindOf(mv) {
  if (/^edgedesk_cfb_p4_v\d+\.\d+\.\d+$/.test(mv)) return 'V1';
  if (/^edgedesk_cfb_loop_v\d+\.\d+\.\d+$/.test(mv)) return 'LOOP';
  if (/^edgedesk_cfb_v\d+\.\d+\.\d+$/.test(mv)) return 'V2';
  return null;
}

/* opts: { roles (role events), now, loopCurrent, v2Current, slate } for tests */
function build(opts) {
  opts = opts || {};
  const now = opts.now || new Date().toISOString();
  const season = opts.season || new Date(now).getUTCFullYear();
  const events = opts.roles || new G.Store(season, opts.storeOpts).gov('model_roles');
  const champ = GOV.champion(events);
  const base = { schema: CHAMP.SCHEMA, generated_at: now, champion: typeof champ === 'string' ? champ : null, kind: null, source: null, games: {}, note: null };
  if (typeof champ !== 'string') return Object.assign(base, { note: 'governance has no single champion: every surface prices V1' });
  const kind = kindOf(champ);
  base.kind = kind;
  if (kind === 'V1') return Object.assign(base, { note: 'V1 is the champion: every surface prices it with the cfb_p4 engine' });
  if (!kind) return Object.assign(base, { note: 'unrecognised champion version ' + champ + ': V1 prices every game' });
  const ad = kind === 'LOOP' ? M.loopAdapter({ loopCurrent: opts.loopCurrent, slate: opts.slate || { games: [] } })
    : M.v2Adapter('current', { current: opts.v2Current, slate: opts.slate || { games: [] } });
  base.source = kind === 'LOOP' ? 'football/cfb/model_loop/current.json' : 'football/cfb_v2/current.json';
  if (ad.model_version !== champ) {
    return Object.assign(base, { served_version: ad.model_version || null,
      note: 'the champion is ' + champ + ' but ' + base.source + ' serves ' + (ad.model_version || 'nothing readable') + ': V1 prices every game until the served version is promoted or the champion is rolled back' });
  }
  const loopCur = kind === 'LOOP' ? (opts.loopCurrent || M.readJson(path.join(REPO, 'football', 'cfb', 'model_loop', 'current.json'))) : null;
  const D = loopCur && loopCur.distribution;
  for (const [gid, p] of ad.projections) {
    const P = p.pure;
    if (!(typeof P.margin === 'number' && isFinite(P.margin)) || !(typeof P.p_home === 'number' && isFinite(P.p_home))) continue;
    const iv = P.intervals || {};
    base.games[gid] = {
      model_version: p.model_version, label: p.model_label, source: p.source, as_of: p.projection_computed_at, kickoff: p.game.kickoff,
      home: p.game.home, away: p.game.away, margin: r(P.margin, 4), total: r(P.total, 3), p_home: r(P.p_home, 6), sigma: r(P.sigma, 4),
      intervals: { 50: iv[50] || null, 80: iv[80] || null, 95: iv[95] || null },
      distribution: kind === 'LOOP' && D ? { kind: 'key_number', sigma: D.sigma, kmax: D.kmax, mult: D.mult }
        : { kind: 'student_t', sigma: r(P.sigma, 4), t_df: P.t_df == null ? null : P.t_df },
      components: p.components ? Object.keys(p.components).map((k) => ({ key: k, points: r(p.components[k], 4) })) : null,
    };
  }
  base.note = Object.keys(base.games).length + ' games priced by ' + champ + '; every other game falls back to V1';
  return base;
}

function main() {
  const a = process.argv.slice(2), v = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const t = build({ season: v('--season', null) ? Number(v('--season')) : undefined });
  if (a.includes('--write')) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(t, null, 1) + '\n');
  }
  console.log('champion ' + (t.champion || 'none') + ' (' + (t.kind || '?') + '): ' + Object.keys(t.games).length + ' games in the table. ' + t.note);
}
if (require.main === module) main();
module.exports = { build, kindOf, OUT };
