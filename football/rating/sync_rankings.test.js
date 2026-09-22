#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('./sync_rankings.js');

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (typeof ok === 'function') {
    try { ok = ok(); } catch (e) { detail = String(e && e.stack || e); ok = false; }
  }
  if (ok) { pass++; return; }
  fail++; console.error('FAIL | ' + name + (detail == null ? '' : ' | ' + JSON.stringify(detail).slice(0, 500)));
}
function done() {
  console.log((fail ? 'FAILED ' : 'ALL GREEN ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

const file = path.join(__dirname, '..', 'rankings', 'current.json');
chk('national rankings artifact exists', fs.existsSync(file), file);
if (!fs.existsSync(file)) done();

const src = JSON.parse(fs.readFileSync(file, 'utf8'));
const out = S.buildCompatibility(src);

chk('compatibility schema is the app contract', out.schema === 'edgedesk_rating_v1', out.schema);
chk('it explicitly names the national rankings source',
  out.source_schema === 'edgedesk_national_rankings_v1', out.source_schema);
chk('it covers the identical FBS field',
  out.team_count === src.team_count && out.teams.length === Object.keys(src.teams).length,
  { compat: out.team_count, rankings: src.team_count });
chk('every displayed rating is the source ETSR, not a recomputation', () =>
  out.teams.every(t => src.teams[t.key] && t.rating === Math.round(src.teams[t.key].etsr * 100) / 100));
chk('the number-one ranked source team is still the number-one displayed team', () => {
  const best = Object.values(src.teams).find(t => t.rank === 1);
  return best && out.teams[0].key === best.key && out.teams[0].rating === Math.round(best.etsr * 100) / 100;
});
chk('the adapter carries all completed-game freshness through unchanged',
  out.data_freshness && src.data_freshness
    && out.data_freshness.completed_games === src.data_freshness.completed_games,
  { compat: out.data_freshness, source: src.data_freshness });
chk('the adapter never adds home field to the neutral-field rating',
  out.season_meta[out.season].hfa.hfa === 0, out.season_meta[out.season].hfa);
chk('market prices are explicitly excluded from the power rating',
  out.method.not_included.some(x => /market prices/i.test(x)), out.method.not_included);
chk('every team preserves an auditable component breakdown', () =>
  out.teams.every(t => t.components && t.components.results && t.components.roster
    && t.components.availability && typeof t.confidence === 'number'));
chk('every team states NIL is not measured', () =>
  out.teams.every(t => t.unmeasured.some(x => /NIL/.test(x))));
chk('an unknown availability row never becomes an available injury adjustment', () => {
  const blindSource = Object.values(src.teams).find(t => t.availability && t.availability.rating == null
    && Number(t.availability.unknown_share) > 0);
  if (!blindSource) return true;
  const t = out.teams.find(x => x.key === blindSource.key);
  return t && t.components.availability.available === false
    && t.components.availability.points === 0;
});
chk('when the ETSR scalar is not measured the app contract says so', () => {
  const raw = Object.values(src.teams).find(t => t.scalars && t.scalars.measured === false);
  if (!raw) return true;
  const t = out.teams.find(x => x.key === raw.key);
  return t.unmeasured.some(x => /point-scale calibration/i.test(x))
    && out.calibration.measured === false;
});
chk('conference and program-group metadata survive for filtering', () =>
  out.teams.every(t => t.conference && t.conference_id && t.fbs_group));
chk('the compatibility digest is stable for the same source', () =>
  S.buildCompatibility(src).digest === out.digest);

done();
