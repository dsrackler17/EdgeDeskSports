'use strict';
/* ===========================================================================
   EdgeDesk college baseball — roster continuity, from the collegiate
   collector (collegiate/data): the share of last season's roster that came
   back, per team and season, read from the rosters each school publishes
   (collegiate/portal.js), joined to our team ids through the registry
   (collegiate/data/schools.json: baseball_team_id, where ncaa.com's name
   and our NCAA record agree).

   A team-season we hold no rosters for has no value (null): the model then
   carries that team exactly as before. The value handed to the model is
   centred on the mean share of the SELECTION seasons, so a team with a
   typical turnover is carried as before and only unusual turnover moves its
   prior. Coverage says how much of Division I the feature can see; the
   learning loop keeps the feature inactive until coverage clears its bar.
   =========================================================================== */
const fs = require('fs');
const path = require('path');

const COLLEGIATE = path.join(__dirname, '..', '..', 'collegiate', 'data');

function load(o) {
  o = o || {};
  const dir = o.dir || COLLEGIATE;
  const ref = o.refSeasons || [2014, 2022];
  const schools = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'schools.json'), 'utf8')).schools || []; } catch (_) { return []; } })();
  const teamOf = new Map(schools.filter((s) => s.baseball_team_id).map((s) => [s.id, String(s.baseball_team_id)]));
  const share = new Map();
  const pdir = path.join(dir, 'portal', 'baseball');
  if (fs.existsSync(pdir)) {
    for (const f of fs.readdirSync(pdir)) {
      if (!/^\d{4}\.json$/.test(f)) continue;
      let doc; try { doc = JSON.parse(fs.readFileSync(path.join(pdir, f), 'utf8')); } catch (_) { continue; }
      for (const t of doc.teams || []) {
        const id = teamOf.get(t.school);
        if (id && t.returning_share != null && t.roster_before >= 15) share.set(doc.season + ':' + id, t.returning_share);
      }
    }
  }
  const refVals = [...share.entries()].filter(([k]) => { const s = +k.split(':')[0]; return s >= ref[0] && s <= ref[1]; }).map(([, v]) => v);
  const mean = refVals.length ? refVals.reduce((a, b) => a + b, 0) / refVals.length : null;
  return {
    n: share.size,
    mean,
    /* centred share, or null where we hold no rosters (or no reference yet) */
    centred: (season, teamId) => { const v = share.get(season + ':' + teamId); return v == null || mean == null ? null : v - mean; },
    raw: (season, teamId) => { const v = share.get(season + ':' + teamId); return v == null ? null : v; },
    /* the share of the given team-seasons that have a value */
    coverage: (teamSeasons) => { if (!teamSeasons.length) return 0; let k = 0; for (const [s, id] of teamSeasons) if (share.has(s + ':' + id)) k++; return k / teamSeasons.length; },
  };
}

module.exports = { load };
