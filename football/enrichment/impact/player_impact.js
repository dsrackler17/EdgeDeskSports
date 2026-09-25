/* ============================================================================
   PLAYER AVAILABILITY IMPACT — how much an absence matters, and whether
   EdgeDesk can say how much it costs.

   Two different questions, kept apart:

     IMPORTANCE  how much the ROLE matters: position leverage (the personnel
                 layer's priors, football/personnel/config.js POSITIONS), where
                 he sits in his group's projected order, whether he is a
                 projected starter, and his usage share. Knowable without a
                 player-quality rating. -> absence_importance_score 0-100 and
                 a category:
                   CRITICAL   >= 85   a starting tackle, lead edge, CB1, WR1
                   MAJOR      >= 65   most other starters
                   MEANINGFUL >= 40   the back of the starting group, a RB,
                                      specialists, heavy rotation
                   MINOR      >= 20   rotation
                   DEPTH      <  20   depth
                   UNKNOWN            the player cannot be placed on the
                                      depth order at all
     IMPACT      how much WORSE the team is without him: needs a measured
                 rating for him and his replacement. Read from the personnel
                 impact layer where it rated the absence (impact_status KNOWN);
                 otherwise impact_status UNKNOWN — never zero. An unrated
                 starter is not a replacement-level player.

   THIS MOVES NO NUMBER. The importance scale is a role heuristic built from
   published leverage priors; it has not passed predictive validation, so it
   feeds reliability (uncertainty), the research card and the warnings only.
   ========================================================================== */
'use strict';

const C = require('../config.js');
const S = require('../availability/status.js');

/* roster/source position -> leverage slot */
const POS = { OT: 'OT', T: 'OT', LT: 'OT', RT: 'OT', G: 'IOL', OG: 'IOL', C: 'IOL', IOL: 'IOL', OL: 'OL',
  DE: 'EDGE', EDGE: 'EDGE', OLB: 'OLB', DT: 'DT', NT: 'DT', DL: 'DL', LB: 'LB', ILB: 'LB', MLB: 'LB',
  CB: 'CB', S: 'S', FS: 'S', SS: 'S', SAF: 'S', DB: 'DB', WR: 'WR', TE: 'TE', RB: 'RB', FB: 'RB', HB: 'RB',
  K: 'K', PK: 'K', P: 'P', LS: 'LS', QB: 'QB' };
/* the weight of each seat in a group's projected order: the first seat is
   the group's most-used player; this layer's own taper */
const SLOT_TAPER = { OL: [1, 0.95, 0.9, 0.85, 0.8], FRONT: [1, 0.9, 0.8, 0.7], LB: [1, 0.85, 0.7],
  SECONDARY: [1, 0.9, 0.8, 0.7], WR: [1, 0.85, 0.7], TE: [0.85], RB: [0.8], QB: [1], K: [0.75], P: [0.75] };

function slotWeight(slot) {
  const m = /^([A-Z]+?)(\d*)$/.exec(slot || '');
  if (!m) return 0.7;
  const t = SLOT_TAPER[m[1]];
  if (!t) return 0.7;
  const i = m[2] ? (+m[2] - 1) : 0;
  return t[Math.min(i, t.length - 1)];
}
function categoryOf(score) {
  if (score == null) return 'UNKNOWN';
  const th = { CRITICAL: 85, MAJOR: 65, MEANINGFUL: 40, MINOR: 20 };
  if (score >= th.CRITICAL) return 'CRITICAL';
  if (score >= th.MAJOR) return 'MAJOR';
  if (score >= th.MEANINGFUL) return 'MEANINGFUL';
  if (score >= th.MINOR) return 'MINOR';
  return 'DEPTH';
}

/* importance(p) p: {pos, projected_starter, slot, role, usage_share} */
function importance(p) {
  const slot = POS[String(p.pos || '').toUpperCase()] || null;
  if (!slot) return { score: null, category: 'UNKNOWN', basis: 'position not known, so the role cannot be placed' };
  if (slot === 'QB') return { score: 100, category: 'CRITICAL', basis: 'quarterback: handled by the QB resolver, not here' };
  const lev = (C.POSITION_LEVERAGE[slot] || 1) / C.LEVERAGE_MAX;
  let roleF, basis;
  if (p.projected_starter) { roleF = slotWeight(p.slot); basis = 'projected starter (' + (p.slot || slot) + ')'; }
  else if (p.role && C.ROLE_FACTOR[p.role] != null) { roleF = C.ROLE_FACTOR[p.role] * 0.8; basis = 'projected role ' + p.role.toLowerCase(); }
  else if (p.on_players_file === false) return { score: null, category: 'UNKNOWN', basis: 'not on the players layer’s depth order' };
  else { roleF = C.ROLE_FACTOR.UNKNOWN * 0.8; basis = 'role not projected'; }
  let use = 1;
  if (typeof p.usage_share === 'number' && !p.projected_starter) use = 0.8 + 0.4 * Math.min(1, p.usage_share / 0.5);
  const score = Math.max(0, Math.min(100, Math.round(100 * lev * roleF * use)));
  return { score, category: categoryOf(score), basis: basis + '; position leverage ' + Math.round(lev * 100) + '/100' };
}

/* assess one team's absences for one fixture.
   o: { players: [player_availability] (from the aggregator),
        roster_roles: {player_id: {pos, slot, role, share, starter, rating_known, epir}}  (projected contributors)
        personnel: the personnel layer's team block for this game (rated absences) | null }
   -> { absences: [...], summary } */
function assessTeam(o) {
  const rated = {};
  ((o.personnel && o.personnel.absences) || []).forEach((a) => { if (a && a.player_id) rated[String(a.player_id)] = a; });
  const unratedP = {};
  ((o.personnel && o.personnel.unrated) || []).forEach((a) => { if (a && a.player_id) unratedP[String(a.player_id)] = a; });
  const out = [];
  (o.players || []).forEach((pa) => {
    const pAbs = S.pAbsent(pa.availability_status);
    if (!(S.isAbsent(pa.availability_status) || S.isDoubt(pa.availability_status))) return;
    if (String(pa.position || '').toUpperCase() === 'QB') return;
    const role = pa.player_id ? (o.roster_roles || {})[pa.player_id] : null;
    const imp = importance({ pos: pa.position || (role && role.pos), projected_starter: !!(role && role.starter),
      slot: role && role.slot, role: role ? role.role : null, usage_share: role ? role.share : null,
      on_players_file: role ? true : (o.on_file ? !!o.on_file[pa.player_id] : null) });
    const r = pa.player_id ? rated[pa.player_id] : null;
    const u = pa.player_id ? unratedP[pa.player_id] : null;
    const known = !!(r && typeof r.impact_if_absent === 'number');
    out.push({
      player_id: pa.player_id, player_name: pa.player_name, position: pa.position || (role && role.pos) || null,
      availability_status: pa.availability_status, probability_absent: pAbs,
      projected_starter: !!(role && role.starter), slot: role ? role.slot : null, role: role ? role.role : null,
      usage_share: role && role.share != null ? role.share : null,
      absence_importance_score: imp.score, importance_category: imp.category, importance_basis: imp.basis,
      player_rating_known: !!(role && role.rating_known) || known,
      impact_status: known ? 'KNOWN' : 'UNKNOWN',
      impact_if_absent: known ? r.impact_if_absent : null,
      replacement: r ? { player_id: r.replacement_player_id || null, player_name: r.replacement_player_name || null,
        quality_known: r.replacement_quality != null } : (u ? { player_id: u.replacement_player_id || null, player_name: u.replacement_player_name || null, quality_known: false } : null),
      impact_basis: known ? 'personnel impact layer: measured player quality and replacement gap (research only, not priced)'
        : ('no measured player quality' + (u && u.missing ? ' (' + u.missing.join(', ') + ' missing)' : '') + ' — impact UNKNOWN, not zero'),
      source: pa.source, is_confirmed: pa.is_confirmed
    });
  });
  out.sort((a, b) => (b.absence_importance_score || -1) - (a.absence_importance_score || -1));
  const by = {}; out.forEach((a) => { by[a.importance_category] = (by[a.importance_category] || 0) + 1; });
  const unknownImportant = out.filter((a) => a.impact_status === 'UNKNOWN' && (a.importance_category === 'CRITICAL' || a.importance_category === 'MAJOR'));
  return {
    absences: out,
    summary: {
      absences: out.length, by_category: by,
      known_impact: out.filter((a) => a.impact_status === 'KNOWN').length,
      unknown_impact: out.filter((a) => a.impact_status === 'UNKNOWN').length,
      unknown_impact_important: unknownImportant.length,
      /* the certainty cost the reliability scorer reads for absences whose
         impact is UNKNOWN, weighted by how much the role matters and by how
         likely the absence is. lib/cfb_reliability.js v2 charged 0.5 per
         unrated starter and 0.1 per unrated reserve; the same two rates are
         kept, with "starter" now meaning CRITICAL/MAJOR (it used to mean
         depth rank <= 2, which called three of five starting linemen deep) */
      unknown_impact_cost: Math.round(1000 * out.filter((a) => a.impact_status === 'UNKNOWN').reduce((s, a) => {
        const w = (a.importance_category === 'CRITICAL' || a.importance_category === 'MAJOR') ? 0.5
          : (a.importance_category === 'MEANINGFUL' || a.importance_category === 'UNKNOWN' ? 0.25 : 0.1);
        return s + w;
      }, 0)) / 1000,
      top: out.slice(0, 3).map((a) => ({ player_name: a.player_name, position: a.position, status: a.availability_status,
        category: a.importance_category, impact_status: a.impact_status }))
    }
  };
}

module.exports = { importance, assessTeam, categoryOf, POS };
