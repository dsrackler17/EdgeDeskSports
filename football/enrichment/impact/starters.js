/* ============================================================================
   PROJECTED STARTERS AND KEY CONTRIBUTORS, from the players layer.

   Coverage is only meaningful against a fixed denominator. The units layer
   (football/players/units.js) projects every position group, but its starter
   counts are not a formation (DL 2, CB 3, S 2, DB 3 — and teams spell the
   secondary as DB on one roster and CB/S on the next). So the denominator is
   a canonical base formation (config.js FORMATION): 11 offense, 11 defense,
   kicker and punter, filled from the units layer's own projected order, the
   front pooled across EDGE/DL and the secondary across CB/S/DB.

   A slot the players layer cannot fill is published as UNFILLED — an unknown
   starter is counted as unknown, never dropped from the denominator.

   player_rating_known follows the personnel layer's rule
   (football/personnel/adapters.js cfbQuality): an EPIR is a measurement only
   when production was measured (career sample > 0 and a positive shrink
   weight). An EPIR of ~52 on an offensive lineman with no production is a
   positional prior, not a rating, and is not counted as known.
   ========================================================================== */
'use strict';

const C = require('../config.js');

function num(x) { return typeof x === 'number' && isFinite(x); }
function measured(p) { return !!(p && num(p.cn) && p.cn > 0 && Array.isArray(p.q) && num(p.q[4]) && p.q[4] > 0); }
function idOf(key) { return key && /^a:/.test(key) ? key.slice(2) : (key || null); }

/* teamFile: football/players/teams/<key>.json */
function project(teamFile) {
  const out = { team: teamFile ? teamFile.key || teamFile.team : null, starters: [], contributors: [], unfilled: [],
    generated_at: teamFile ? teamFile.generated_at : null };
  if (!teamFile || !teamFile.units || !teamFile.units.groups) return Object.assign(out, { missing: 'no players-layer team file' });
  const G = teamFile.units.groups;
  const byId = {};
  (teamFile.players || []).forEach((p) => { if (p && p.id) byId[String(p.id)] = p; });
  const taken = {};
  function rec(pj, group, unit, slotLabel) {
    const id = idOf(pj.key), p = byId[id] || null;
    taken[id] = 1;
    return { player_id: id, name: pj.name || (p && p.n) || null, pos: pj.pos || (p && p.p) || null, group, unit, slot: slotLabel,
      role: pj.role || (p && p.role) || 'UNKNOWN', share: p && num(p.share) ? p.share : null,
      depth_weight: num(pj.effective_weight) ? pj.effective_weight : (num(pj.depth_weight) ? pj.depth_weight : null),
      starter: true, rating_known: measured(p), epir: num(pj.epir) ? pj.epir : null,
      rating_basis: measured(p) ? 'MEASURED_PRODUCTION' : (p ? 'NO_MEASURED_PRODUCTION' : 'NOT_ON_PLAYER_FILE') };
  }
  function pool(groups) {
    const list = [];
    groups.forEach((g) => (G[g] && G[g].projected || []).forEach((pj) => list.push({ pj, g })));
    /* the units layer's own order within a group (slot), then its weight
       across pooled groups */
    return list.sort((a, b) => ((b.pj.effective_weight || b.pj.depth_weight || 0) - (a.pj.effective_weight || a.pj.depth_weight || 0))
      || ((a.pj.slot || 99) - (b.pj.slot || 99)));
  }
  function fill(unit, name, n) {
    const groups = name === 'FRONT' ? C.FRONT_GROUPS : (name === 'SECONDARY' ? C.SECONDARY_GROUPS : [name]);
    const cand = (groups.length > 1 ? pool(groups) : (G[name] && G[name].projected || []).slice()
      .sort((a, b) => (a.slot || 99) - (b.slot || 99)).map((pj) => ({ pj, g: name })))
      .filter((x) => !taken[idOf(x.pj.key)]);
    for (let i = 0; i < n; i++) {
      const x = cand[i];
      if (x) out.starters.push(rec(x.pj, x.g, unit, name + (n > 1 ? i + 1 : '')));
      else out.unfilled.push({ unit, slot: name + (n > 1 ? i + 1 : ''), why: 'the players layer projects fewer than ' + n + ' at ' + name });
    }
  }
  C.FORMATION.offense.forEach(([g, n]) => fill('offense', g, n));
  C.FORMATION.defense.forEach(([g, n]) => fill('defense', g, n));
  C.FORMATION.special.forEach(([g, n]) => fill('special', g, n));
  /* key contributors: the starters plus every projected STARTER / HEAVY
     ROTATION player the formation did not seat */
  out.contributors = out.starters.slice();
  Object.keys(G).forEach((g) => (G[g].projected || []).forEach((pj) => {
    const id = idOf(pj.key);
    if (taken[id] || C.KEY_ROLES.indexOf(pj.role) < 0) return;
    const unit = ['QB', 'RB', 'WR', 'TE', 'OL'].indexOf(g) >= 0 ? 'offense' : (['K', 'P'].indexOf(g) >= 0 ? 'special' : 'defense');
    const r = rec(pj, g, unit, g); r.starter = false;
    out.contributors.push(r);
  }));
  return out;
}

/* player quality coverage for one team: {offense, defense, special, starters,
   key_contributors} each {total, rated, pct, unrated:[...]} */
function coverage(proj) {
  function tally(list, filter) {
    const xs = list.filter(filter || (() => true));
    const rated = xs.filter((p) => p.rating_known).length;
    return { total: xs.length, rated, pct: xs.length ? Math.round(1000 * rated / xs.length) / 10 : null,
      unrated: xs.filter((p) => !p.rating_known).map((p) => ({ player_id: p.player_id, name: p.name, pos: p.pos, slot: p.slot, basis: p.rating_basis })) };
  }
  if (!proj || !proj.starters.length) return { available: false, why: (proj && proj.missing) || 'no projected starters' };
  const unf = (u) => proj.unfilled.filter((x) => x.unit === u).length;
  const off = tally(proj.starters, (p) => p.unit === 'offense');
  const def = tally(proj.starters, (p) => p.unit === 'defense');
  /* an unfilled starter slot is an unrated starter */
  off.total += unf('offense'); def.total += unf('defense');
  off.pct = off.total ? Math.round(1000 * off.rated / off.total) / 10 : null;
  def.pct = def.total ? Math.round(1000 * def.rated / def.total) / 10 : null;
  const st = tally(proj.starters);
  st.total += proj.unfilled.length; st.pct = st.total ? Math.round(1000 * st.rated / st.total) / 10 : null;
  return { available: true, offense: off, defense: def, special: tally(proj.starters, (p) => p.unit === 'special'),
    starters: st, key_contributors: tally(proj.contributors), unfilled: proj.unfilled.length };
}

module.exports = { project, coverage, measured };
