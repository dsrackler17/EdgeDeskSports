/* ===========================================================================
   EdgeDesk player props — ONE PLAYER, COLLEGE THROUGH THE NFL.

   dim_player: one canonical EdgeDesk player per person, stable across seasons.
   bridge:     the college-to-pro link, with its method, confidence and review
               status (workbook sheet 10_CFB_NFL_Bridge).

   THE ID. A college player is `espn:<athlete id>` — the convention
   supabase/cfb_personnel.sql already enforces. ESPN uses one athlete id per
   person across NCAA and NFL, so a pro who played college football in our
   window keeps his college id. A pro with no college record here is
   `espn:<nfl espn id>` when nflverse carries one and nothing else claims it,
   else `gsis:<gsis id>`. Assignments are PINNED in identity/pins.json the first
   time they are made, so a later data change never renames a player; a later
   bridge that joins two pinned ids is recorded as a merge, never a rename.

   THE BRIDGE, in priority order (never name-only):
     manual            identity/overrides.json, reviewed by a person        1.00
     exact_espn_id     nflverse espn_id == the college athlete id, AND the
                       names agree (suffixes folded)                         1.00
     name_college_draft normalised name + college + last college season is
                       the season before the draft year                     0.98
     name_college_position_chronology  (no draft: UDFA) name + college +
                       compatible position + last college season is the
                       season before the rookie season                      0.94 (review)
     name_chronology_position  college unknown on one side: name + position
                       + the same season adjacency                           0.90 (review)
   Two or more candidates at the first step that finds any = AMBIGUOUS: no
   link, a review-queue row naming the candidates. An espn id whose names
   disagree is quarantined, never linked and never merged.
   Production training uses a link only at >= 0.90 or manual_reviewed (Q009).
   =========================================================================== */
'use strict';
const path = require('path');
const io = require('./lib/io.js');
const FI = require('../../../lib/football_identity.js');
const cfbSrc = require('./sources/cfb.js');

const DIR = path.join(__dirname, 'identity');
const PINS = path.join(DIR, 'pins.json');
const OVERRIDES = path.join(DIR, 'overrides.json');
const MERGES = path.join(DIR, 'merges.json');
const CONF = { manual: 1, exact_espn_id: 1, name_college_draft: 0.98, name_college_position_chronology: 0.94, name_chronology_position: 0.9 };
const REVIEW = { name_college_position_chronology: true, name_chronology_position: true };
const PRODUCTION_MIN = 0.9;

const SUFFIX = /\b(jr|sr|ii|iii|iv|v|vi)\b\.?/g;
function normName(s) {
  let t = String(s == null ? '' : s).toLowerCase();
  try { t = t.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (_) {}
  t = t.replace(/[.'’`]/g, '').replace(/-/g, ' ').replace(SUFFIX, ' ');
  return t.replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function namesAgree(a, b) {
  const x = normName(a), y = normName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  /* "DJ Moore" / "D J Moore", "Gabe Davis" / "Gabriel Davis": same last name and
     first initial, and one first name a prefix of the other */
  const xs = x.split(' '), ys = y.split(' ');
  const lx = xs[xs.length - 1], ly = ys[ys.length - 1];
  if (lx !== ly) return false;
  const fx = xs.slice(0, -1).join(''), fy = ys.slice(0, -1).join('');
  return !!fx && !!fy && (fx.indexOf(fy) === 0 || fy.indexOf(fx) === 0);
}
const POSFAM = { QB: 'QB', RB: 'RB', FB: 'RB', HB: 'RB', TB: 'RB', WR: 'WR', TE: 'TE', ATH: 'ATH' };
function posCompatible(nflPos, cfbPositions) {
  const a = POSFAM[String(nflPos || '').toUpperCase()] || String(nflPos || '').toUpperCase();
  if (!a) return false;
  return Array.from(cfbPositions || []).some((p) => { const b = POSFAM[String(p || '').toUpperCase()] || String(p || '').toUpperCase(); return b === a || b === 'ATH'; });
}

let _reg = null;
function cfbTeamRegistry() {
  if (_reg) return _reg;
  const teams = Array.from(cfbSrc.TEAM.values()).map((t) => ({ id: String(t.espn_team_id), name: t.name, aliases: [t.key] }));
  _reg = FI.buildRegistry('CFB', teams);
  return _reg;
}
/* nflverse lists a transfer's schools in one string ("Kansas State; Virginia;
   North Dakota State"): every school is resolved, the last one first */
function collegeTeamIds(name) {
  if (!name) return [];
  const out = [];
  String(name).split(/\s*;\s*/).reverse().forEach((n) => { const r = FI.resolveTeam(cfbTeamRegistry(), n); if (r.team_id && out.indexOf(r.team_id) < 0) out.push(r.team_id); });
  return out;
}
function collegeTeamId(name) { return collegeTeamIds(name)[0] || null; }
function lastNameOf(s) { const t = normName(s).split(' '); return t[t.length - 1] || ''; }

/* The college registry from the CFB player-game rows of every loaded season. */
function cfbRegistry(cfbSeasons) {
  const reg = new Map();
  cfbSeasons.forEach((s) => {
    s.playerGames.forEach((r) => {
      let a = reg.get(r.source_player_id);
      if (!a) { a = { espn_id: r.source_player_id, names: new Set(), teams: new Map(), positions: new Set(), first: r.season, last: r.season, class_year: null, games: 0 }; reg.set(r.source_player_id, a); }
      if (r.player_name) a.names.add(r.player_name);
      if (!a.teams.has(r.season)) a.teams.set(r.season, new Set());
      a.teams.get(r.season).add(r.team_id);
      if (r.position) a.positions.add(r.position);
      a.first = Math.min(a.first, r.season); a.last = Math.max(a.last, r.season); a.games++;
      if (r.season === a.last && r.class_year != null) a.class_year = r.class_year;
    });
  });
  const byName = new Map();
  reg.forEach((a) => { a.names.forEach((n) => { const k = normName(n); if (!k) return; if (!byName.has(k)) byName.set(k, new Set()); byName.get(k).add(a.espn_id); }); });
  return { byId: reg, byName };
}

function lastTeam(a) { const t = a.teams.get(a.last); return t ? Array.from(t)[0] : null; }
function playedFor(a, teamIds) { const ids = Array.isArray(teamIds) ? teamIds : [teamIds]; let hit = false; a.teams.forEach((set) => { ids.forEach((t) => { if (set.has(t)) hit = true; }); }); return hit; }

/* Bridge ONE nfl player against the college registry. Returns
   {link|null, review|null, quarantine|null}. */
function bridgeOne(p, cfb, overrides) {
  const ov = overrides.get(p.gsis_id);
  if (ov) {
    if (ov.cfb_espn_id === null) return { link: null, review: null, quarantine: null, manual_none: true };
    return { link: { cfb_espn_id: String(ov.cfb_espn_id), method: 'manual', confidence: CONF.manual, manual_reviewed: true, reviewer: ov.reviewed_by || null } };
  }
  /* 1. exact provider id */
  if (p.espn_id && cfb.byId.has(p.espn_id)) {
    const a = cfb.byId.get(p.espn_id);
    const agree = Array.from(a.names).some((n) => namesAgree(n, p.display_name));
    if (agree) return { link: { cfb_espn_id: a.espn_id, method: 'exact_espn_id', confidence: CONF.exact_espn_id, manual_reviewed: false } };
    /* the same provider id under a nickname ("JuJu" / "Julius Brents"): accepted
       only when the LAST name agrees AND the college or the season chronology
       independently confirms it */
    const cols = collegeTeamIds(p.college);
    const lastAgrees = Array.from(a.names).some((n) => lastNameOf(n) && lastNameOf(n) === lastNameOf(p.display_name));
    const confirms = (cols.length && playedFor(a, cols)) || (p.rookie_season != null && a.last === p.rookie_season - 1);
    if (lastAgrees && confirms) return { link: { cfb_espn_id: a.espn_id, method: 'exact_espn_id', confidence: CONF.exact_espn_id, manual_reviewed: false, name_variant: Array.from(a.names).join(' / ') } };
    return { link: null, quarantine: { gsis_id: p.gsis_id, espn_id: p.espn_id, reason: 'ESPN id collision: the college record names ' + Array.from(a.names).join(' / ') + ', the NFL record names ' + p.display_name, candidates: [a.espn_id] } };
  }
  /* 2-4. name-led, never name-only */
  const k = normName(p.display_name);
  const cand = Array.from(cfb.byName.get(k) || []).map((id) => cfb.byId.get(id))
    /* a player cannot appear in the NFL before his last college season */
    .filter((a) => p.rookie_season == null || a.last < p.rookie_season);
  if (!cand.length) return { link: null };
  const cols = collegeTeamIds(p.college);
  const col = cols.length ? cols : null;
  const steps = [];
  if (col && p.draft_year) steps.push({ method: 'name_college_draft', ok: (a) => playedFor(a, col) && a.last === p.draft_year - 1 });
  if (col) steps.push({ method: 'name_college_position_chronology', ok: (a) => playedFor(a, col) && p.rookie_season != null && a.last === p.rookie_season - 1 && posCompatible(p.position, a.positions) });
  if (!col) steps.push({ method: 'name_chronology_position', ok: (a) => p.rookie_season != null && a.last === p.rookie_season - 1 && posCompatible(p.position, a.positions) });
  for (const st of steps) {
    const hits = cand.filter(st.ok);
    if (hits.length === 1) return { link: { cfb_espn_id: hits[0].espn_id, method: st.method, confidence: CONF[st.method], manual_reviewed: false, needs_review: !!REVIEW[st.method] } };
    if (hits.length > 1) return { link: null, review: { gsis_id: p.gsis_id, name: p.display_name, college: p.college, reason: 'AMBIGUOUS: ' + hits.length + ' college players match by ' + st.method, candidates: hits.map((h) => h.espn_id) } };
  }
  /* a name-only candidate is recorded for a person, never linked */
  return { link: null, review: { gsis_id: p.gsis_id, name: p.display_name, college: p.college, reason: 'NAME_ONLY: ' + cand.length + ' college player(s) share the name but college/draft/chronology do not confirm', candidates: cand.map((c) => c.espn_id) } };
}

/* Build dim_player, player_id_map, the bridge, the review queue and the
   quarantine. `nflPlayers` = players.csv rows; `nflSeen` = gsis ids with an
   NFL stat line in the window; `cfbSeasons` = loaded CFB seasons. */
function build(o) {
  const pins = o.pins || io.readJson(PINS, { schema: 'edgedesk_props_identity_pins_v1', nfl: {} });
  const merges = o.merges || io.readJson(MERGES, { schema: 'edgedesk_props_identity_merges_v1', merges: [] });
  const ovList = o.overrides || (io.readJson(OVERRIDES, { overrides: [] }).overrides || []);
  const overrides = new Map(ovList.map((x) => [x.gsis_id, x]));
  const cfb = cfbRegistry(o.cfbSeasons || []);
  const players = new Map();                                   /* player_id -> dim row */
  const idMap = [];
  const bridge = [], review = [], quarantine = [];
  const claimed = new Map();                                   /* espn id -> gsis that claimed it via a bridge */

  /* college players first: espn:<id> */
  cfb.byId.forEach((a) => {
    const pid = 'espn:' + a.espn_id;
    const pos = Array.from(a.positions);
    players.set(pid, { player_id: pid, full_name: Array.from(a.names).slice(-1)[0] || null, birth_date: null, position: pos[pos.length - 1] || null,
      college_last: lastTeam(a), college_last_name: null, nfl_gsis_id: null, nfl_espn_id: null, cfb_espn_id: a.espn_id, pfr_id: null,
      identity_confidence: 1, first_seen_season: a.first, last_seen_season: a.last, cfb_first_season: a.first, cfb_last_season: a.last,
      nfl_first_season: null, nfl_last_season: null, draft_year: null, draft_round: null, draft_pick: null, identity_status: 'cfb_only' });
    idMap.push({ source: 'espn_cfb', source_id: a.espn_id, player_id: pid, method: 'native', confidence: 1 });
  });

  const nflSeen = o.nflSeen || new Set();
  const nflList = (o.nflPlayers || []).filter((p) => nflSeen.has(p.gsis_id) || (o.includeAllNfl && p.gsis_id));
  nflList.forEach((p) => {
    const b = bridgeOne(p, cfb, overrides);
    if (b.quarantine) quarantine.push(Object.assign({ rule_id: 'Q009' }, b.quarantine));
    if (b.review) review.push(b.review);
    let pid = null, conf = 1, status = 'nfl_only';
    if (b.link) {
      const prev = claimed.get(b.link.cfb_espn_id);
      if (prev && prev !== p.gsis_id) {
        /* two pros claim one college player: neither is linked */
        quarantine.push({ rule_id: 'Q009', gsis_id: p.gsis_id, reason: 'two NFL players claim college player espn:' + b.link.cfb_espn_id + ' (also ' + prev + ')', candidates: [b.link.cfb_espn_id] });
        b.link = null;
      } else claimed.set(b.link.cfb_espn_id, p.gsis_id);
    }
    const production = b.link && (b.link.confidence >= PRODUCTION_MIN || b.link.manual_reviewed);
    if (b.link && production) { pid = 'espn:' + b.link.cfb_espn_id; conf = b.link.confidence; status = 'bridged'; }
    /* no bridge: the NFL espn id is only safe when no college player owns it */
    if (!pid) pid = p.espn_id && !cfb.byId.has(p.espn_id) ? 'espn:' + p.espn_id : 'gsis:' + p.gsis_id;
    /* the pin wins: an id once assigned is never silently changed */
    const pinned = pins.nfl[p.gsis_id];
    if (pinned && pinned !== pid) {
      if (status === 'bridged') merges.merges.push({ from_player_id: pinned, to_player_id: pid, gsis_id: p.gsis_id, reason: 'bridged by ' + b.link.method, at: new Date().toISOString() });
      else pid = pinned;
    }
    pins.nfl[p.gsis_id] = pid;
    if (b.link) bridge.push({ player_id: 'espn:' + b.link.cfb_espn_id, cfb_espn_id: b.link.cfb_espn_id, nfl_gsis_id: p.gsis_id, college_team: collegeTeamId(p.college) || null, name_variant: b.link.name_variant || null,
      college_name: p.college || null, draft_year: p.draft_year, draft_round: p.draft_round, draft_pick: p.draft_pick,
      match_method: b.link.method, match_confidence: b.link.confidence, manual_reviewed: !!b.link.manual_reviewed, needs_review: !!b.link.needs_review,
      production_eligible: !!production });
    const row = players.get(pid) || { player_id: pid, cfb_espn_id: null, cfb_first_season: null, cfb_last_season: null, first_seen_season: null, last_seen_season: null, college_last: null };
    Object.assign(row, { full_name: p.display_name, birth_date: p.birth_date, position: p.position || row.position || null, college_last_name: p.college || null,
      college_last: row.college_last || collegeTeamId(p.college), nfl_gsis_id: p.gsis_id, nfl_espn_id: p.espn_id, pfr_id: p.pfr_id,
      identity_confidence: status === 'bridged' ? conf : 1, nfl_first_season: p.rookie_season, nfl_last_season: p.last_season,
      draft_year: p.draft_year, draft_round: p.draft_round, draft_pick: p.draft_pick, identity_status: status, headshot: p.headshot || null });
    row.first_seen_season = [row.cfb_first_season, p.rookie_season].filter((x) => x != null).reduce((m, x) => Math.min(m, x), Infinity);
    row.last_seen_season = [row.cfb_last_season, p.last_season].filter((x) => x != null).reduce((m, x) => Math.max(m, x), -Infinity);
    if (!isFinite(row.first_seen_season)) row.first_seen_season = null;
    if (!isFinite(row.last_seen_season)) row.last_seen_season = null;
    players.set(pid, row);
    idMap.push({ source: 'nfl_gsis', source_id: p.gsis_id, player_id: pid, method: b.link && production ? b.link.method : 'native', confidence: row.identity_confidence });
    if (p.espn_id) idMap.push({ source: 'nfl_espn', source_id: p.espn_id, player_id: pid, method: 'native', confidence: 1 });
    if (p.pfr_id) idMap.push({ source: 'pfr', source_id: p.pfr_id, player_id: pid, method: 'native', confidence: 1 });
  });

  const stats = { players: players.size, cfb_players: cfb.byId.size, nfl_players: nflList.length, bridged: bridge.filter((b) => b.production_eligible).length,
    by_method: bridge.reduce((m, b) => { m[b.match_method] = (m[b.match_method] || 0) + 1; return m; }, {}),
    needs_review: bridge.filter((b) => b.needs_review).length, review_queue: review.length, quarantined: quarantine.length };
  return { players: Array.from(players.values()), idMap, bridge, review, quarantine, pins, merges, stats };
}

/* source id -> player_id lookups for the fact builders */
function resolver(idMap) {
  const m = new Map(idMap.map((x) => [x.source + ':' + x.source_id, x.player_id]));
  return { cfb: (espnId) => m.get('espn_cfb:' + espnId) || null, nfl: (gsis) => m.get('nfl_gsis:' + gsis) || null,
    nflEspn: (id) => m.get('nfl_espn:' + id) || null, pfr: (id) => m.get('pfr:' + id) || null };
}

function savePins(pins, merges) {
  io.writeJson(PINS, Object.assign({ schema: 'edgedesk_props_identity_pins_v1', note: 'NFL gsis id -> EdgeDesk player_id, pinned at first assignment. Never edited by hand: a correction is an entry in overrides.json.' }, pins, { nfl: sortObj(pins.nfl) }), true);
  io.writeJson(MERGES, merges, true);
}
function sortObj(o) { const out = {}; Object.keys(o).sort().forEach((k) => { out[k] = o[k]; }); return out; }

module.exports = { build, bridgeOne, cfbRegistry, resolver, normName, namesAgree, posCompatible, collegeTeamId, savePins, CONF, PRODUCTION_MIN, PINS, OVERRIDES };
