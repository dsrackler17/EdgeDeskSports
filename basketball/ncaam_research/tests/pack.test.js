#!/usr/bin/env node
'use strict';
/* ===========================================================================
   The research engine on the real pack (needs python3 + pyarrow; about a
   minute). Proves on the actual tables:

     - every one of the 34 tables matches its inventory hash;
     - one row per ESPN game id; postponed and canceled games are never
       scored; every final has two 20-minute halves plus 5-minute overtimes;
     - D1 membership per season matches the NCAA reference counts exactly,
       and a game against an unmapped team is the separate regime;
     - the fingerprint crosswalk links most players, never one athlete to
       two NCAA ids, and agrees with names where names exist;
     - the 2026 walk-forward never uses a game before it is available;
     - last season's publisher RAPM is the only RAPM a 2026 prior reads;
     - the committed records are consistent with the frozen selection and
       the published documents are complete and finite.

   Run: node basketball/ncaam_research/tests/pack.test.js
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const BASE = path.join(__dirname, '..');
const R = (p) => require(path.join(BASE, p));
let pass = 0; let fail = 0;
function ok(name, cond, detail) { if (cond) { pass++; return; } fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); }

(async () => {
  try { require('child_process').execFileSync('python3', ['-c', 'import pyarrow'], { stdio: 'ignore' }); } catch (e) { console.log('SKIPPED: python3 with pyarrow is required'); process.exit(0); }
  const C = R('config'); const pack = R('lib/pack'); const I = R('ingest'); const ID = R('identity'); const TM = R('team_model'); const PE = R('player_eval'); const CR = require('crypto');

  const inv = pack.manifests().inventory;
  ok('34 tables in the inventory', inv.length === 34, inv.length);
  ok('every table matches its inventory hash', inv.every((r) => { try { pack.verify(r.table); return true; } catch (e) { return false; } }));

  const G = await I.loadGames();
  ok('one row per ESPN game id', G.games.length === new Set(G.games.map((g) => g.game_id)).size);
  const finals = G.games.filter((g) => g.status === 'FINAL');
  ok('finals have two halves, overtimes add five minutes each', finals.filter((g) => g.periods > 0).every((g) => g.minutes === 40 + 5 * g.n_ot && g.n_ot >= 0) && !G.games.some((g) => g.rule_flag));
  ok('postponed and canceled games carry no score-based minutes', G.games.filter((g) => g.status !== 'FINAL').every((g) => g.minutes === null));
  const M = await ID.teamMembership();
  for (const s of C.SEASONS) {
    const n = [...G.teams.values()].filter((t) => t.seasons[s] && t.seasons[s].d1 === true).length;
    ok('D1 teams with games in ' + s + ' match the NCAA reference', n === M.audit.reference_counts[s], { n, ref: M.audit.reference_counts[s] });
  }
  ok('games against unmapped opponents are their own regime', finals.every((g) => g.regime === (g.home_d1 === true && g.away_d1 === true ? 'D1_D1' : (g.home_d1 === true || g.away_d1 === true) ? 'D1_OTHER' : 'OTHER_OTHER')));

  const PG = await I.loadPlayerGames(); const NP = await I.loadNcaaPlayerGames();
  const X = ID.playerCrosswalk(NP.rows, PG.rows);
  ok('the fingerprint crosswalk links over 95% of NCAA players', X.audit.linked / X.audit.ncaa_players > 0.95, X.audit);
  ok('no ESPN athlete is linked to two NCAA ids', new Set([...X.links.values()].map((l) => l.espn_athlete_id)).size === X.links.size);
  ok('linked players agree on name in over 95% of cases (the rest are nicknames, kept by the fingerprints)', X.audit.linked_name_agreement > 0.95);

  const TG = await I.loadTeamGames(); const coef = TM.possessionCoefficient(TG, [2024, 2025]);
  ok('the fitted FTA coefficient is a college value, not the NBA 0.44', coef.c > 0.46 && coef.c < 0.52, coef);
  const frozen = JSON.parse(fs.readFileSync(C.PATHS.frozen, 'utf8'));
  const games = TM.buildGames(G, TG, coef.c); const W = TM.walk(games, frozen.chosen, new TM.Rosters(PG), [2025, 2026]);
  const rows = W.rows.filter((r) => r.season === 2026);
  ok('2026 walk-forward: every input was available before each prediction', rows.length > 6000 && rows.every((r) => r.inputs_known_through == null || r.inputs_known_through < Date.parse(r.predicted_at)));

  const Rp = await I.loadRapm(); const prev = PE.previousSeasonPrior(Rp, 2026);
  const per25 = new Map(Rp[2025].map((r) => [r.person_id, r])); const per26 = new Map(Rp[2026].map((r) => [r.player_id, r]));
  const sample = [...prev.entries()].slice(0, 200);
  ok('a 2026 prior reads the 2025 publisher RAPM, never the 2026 full-season fit', sample.length > 100 && sample.every(([pid, v]) => { const p26 = per26.get(pid); const p25 = per25.get(p26.person_id); return p25 && v.o === p25.orapm && v.d === p25.drapm; }));

  const hash = CR.createHash('sha256').update(JSON.stringify({ chosen: frozen.chosen, rule: frozen.rule })).digest('hex').slice(0, 16);
  ok('the frozen selection is untouched since freezing', hash === frozen.hash);
  const vt = JSON.parse(fs.readFileSync(C.PATHS.outFile('validation_team.json'), 'utf8'));
  ok('the published holdout record belongs to the frozen selection', vt.frozen_hash === frozen.hash && vt.candidates[2026].frozen.n > 5000);

  const idx = JSON.parse(fs.readFileSync(C.PATHS.outFile('index.json'), 'utf8'));
  ok('every D1 team has a published document', idx.teams.length === M.audit.reference_counts[2026] && idx.teams.every((t) => fs.existsSync(C.PATHS.outFile('teams/' + t.id + '.json'))));
  let bad = 0;
  for (const t of idx.teams) {
    const d = JSON.parse(fs.readFileSync(C.PATHS.outFile('teams/' + t.id + '.json'), 'utf8'));
    const nums = [d.rating.net, d.rating.adj_o, d.rating.adj_d, d.rating.tempo, d.rating.sd_net].concat(d.players.map((p) => p.impact.net), d.players.map((p) => p.impact.sd_net));
    if (!nums.every(Number.isFinite)) bad++;
  }
  ok('every published rating and impact is finite', bad === 0, bad);
  ok('without a quotes file the market layer is UNAVAILABLE and says why', fs.existsSync(C.PATHS.quotes) || /UNAVAILABLE/.test(idx.status.market));

  console.log(fail ? `${fail} FAILED, ${pass} passed` : `ALL GREEN (${pass} checks)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
