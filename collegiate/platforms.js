'use strict';
/* ===========================================================================
   EdgeDesk collegiate — the two platforms most Division I athletics sites are
   built on, read from the page's own Nuxt data (collegiate/nuxt.js):

     SIDEARM  the pinia store: roster.roster{<hash>: {season, sport, players}},
              roster.seasons{<sport>: [{rosterId, seasonTitle}]}; a player has
              a site-stable playerId (rosterPlayerId changes each season).
     WMT      data['roster-<id>-players-list'] (roster players, each with its
              player: a site-stable id) and data['sport-<slug>-roster'].

   Every roster is normalised to one row shape. We keep only what a model or
   the portal ledger uses: name, number, position, class, height, weight,
   hometown, high school, previous school, bats/throws. Nothing else of a
   student's page (social accounts, majors, biographies, photos) is kept.
   =========================================================================== */
const { nuxtData } = require('./nuxt');

/* split-year sports: a season is labelled "2025-26" and keyed by its end year */
const SPLIT = new Set(['mens-basketball', 'womens-basketball', 'mens-ice-hockey', 'womens-ice-hockey', 'wrestling', 'mens-swimming-and-diving',
  'womens-swimming-and-diving', 'swimming-and-diving', 'womens-gymnastics', 'mens-gymnastics', 'rifle', 'fencing', 'bowling', 'womens-bowling']);

/* "2025-26" -> 2026, "1999-2000" -> 2000, "2026" -> 2026 */
function seasonKey(label) {
  const s = String(label || '').trim();
  let m = s.match(/^(\d{4})\s*[-/]\s*(\d{2}|\d{4})$/);
  if (m) { const a = +m[1]; const b = m[2].length === 4 ? +m[2] : Math.floor(a / 100) * 100 + +m[2]; return b < a ? b + 100 : b; }
  m = s.match(/^(\d{4})$/) || s.match(/\b(\d{4})\b/);
  return m ? +m[1] : null;
}
/* the label a site uses for a season of a sport, when we have not read its own list */
function seasonLabel(sport, season) {
  return SPLIT.has(sport) ? (season - 1) + '-' + String(season).slice(2) : String(season);
}

/* class: FR SO JR SR GR, and whether it says redshirt */
function normClass(short, long, number) {
  const t = String(long || short || '').toLowerCase().replace(/\./g, '').trim();
  const redshirt = /^(r|rs)[- ]|redshirt/.test(t);
  const core = t.replace(/^(r|rs)[- ]|redshirt[- ]?/, '').trim();
  let c = null;
  if (/^(fr|freshman|first[- ]year)/.test(core)) c = 'FR';
  else if (/^(so|sophomore)/.test(core)) c = 'SO';
  else if (/^(jr|junior)/.test(core)) c = 'JR';
  else if (/^(sr|senior)/.test(core)) c = 'SR';
  else if (/^(gr|grad|graduate|5th|6th|fifth|sixth)/.test(core)) c = 'GR';
  else if (number >= 1 && number <= 4) c = ['FR', 'SO', 'JR', 'SR'][number - 1];
  else if (number >= 5) c = 'GR';
  return { class: c, redshirt, class_raw: (long || short || null) };
}
const inches = (ft, inch) => (Number.isFinite(+ft) && +ft > 0 ? +ft * 12 + (+inch || 0) : null);
const clean = (x) => { const s = x == null ? '' : String(x).replace(/\s+/g, ' ').trim(); return s && s !== '-' && !/^(n\/?a|none)$/i.test(s) ? s : null; };

/* bats/throws from whatever field a site labels it with ("B/T", "Bats/Throws") */
function batsThrows(extra) {
  for (const [k, v] of Object.entries(extra || {})) {
    if (!/^(b\s*\/\s*t|bats\s*\/\s*throws)$/i.test(k.trim())) continue;
    const m = String(v || '').toUpperCase().match(/^\s*([LRSB])\s*[/-]\s*([LR])\s*$/);
    if (m) return { bats: m[1] === 'B' ? 'S' : m[1], throws: m[2] };
  }
  return { bats: null, throws: null };
}

function row(o) {
  const bt = batsThrows(o.extra);
  return { pid: String(o.pid), name: clean([o.first, o.last].filter(Boolean).join(' ')), first: clean(o.first), last: clean(o.last),
    jersey: clean(o.jersey), pos: clean(o.pos), class: o.cls.class, redshirt: o.cls.redshirt, class_raw: clean(o.cls.class_raw),
    height_in: o.height_in, weight: Number.isFinite(+o.weight) && +o.weight > 0 ? +o.weight : null,
    hometown: clean(o.hometown), high_school: clean(o.high_school), previous_school: clean(o.previous_school), bats: bt.bats, throws: bt.throws };
}

/* ---------------------------------------------------------------- SIDEARM */
function sidearmRoster(data) {
  const store = data && data.pinia && data.pinia.roster;
  if (!store || !store.roster || typeof store.roster !== 'object') return null;
  const rosters = Object.values(store.roster).filter((r) => r && Array.isArray(r.players));
  if (!rosters.length) return null;
  const r = rosters[0];
  const sport = (r.sport && (r.sport.globalSportNameSlug || r.sport.shortName)) || null;
  const label = (r.season && (r.season.title || r.season.shortName)) || null;
  /* the custom columns a site shows (e.g. custom1 = "B/T") */
  const custom = {};
  for (const f of r.displayFields || []) if (f && /^custom\d$/.test(String(f.dbField || '').replace(/^rp_/, ''))) custom[String(f.dbField).replace(/^rp_/, '')] = f.title;
  const players = r.players.filter((p) => p && !p.hide && p.playerId != null).map((p) => {
    const extra = {};
    for (const [k, title] of Object.entries(custom)) if (p[k]) extra[title] = p[k];
    return row({ pid: p.playerId, first: p.firstName, last: p.lastName, jersey: p.jerseyNumber, pos: p.positionShort || p.positionLong,
      cls: normClass(p.academicYearShort, p.academicYearLong, p.academicYearNumber), height_in: inches(p.heightFeet, p.heightInches), weight: p.weight,
      hometown: p.hometown, high_school: p.highSchool, previous_school: p.previousSchool, extra });
  });
  const seasons = ((store.seasons && sport && store.seasons[sport]) || []).map((s) => ({ label: s.seasonTitle, season: seasonKey(s.seasonTitle), roster_id: s.rosterId }));
  return { platform: 'sidearm', sport, season_label: label, season: seasonKey(label), roster_id: r.id, players, seasons };
}

/* -------------------------------------------------------------------- WMT */
function wmtRoster(data) {
  const d = data && data.data;
  if (!d || typeof d !== 'object') return null;
  /* the roster players: an array whose members carry a player and a roster id */
  let list = null, rosterMeta = null;
  for (const [k, v] of Object.entries(d)) {
    if (Array.isArray(v) && v.length && v.every((x) => x && x.player && typeof x.player === 'object' && x.roster_id != null)) { list = v; break; }
    if (/^roster-\d+-players-list$/.test(k) && Array.isArray(v)) list = list || v;
  }
  for (const [k, v] of Object.entries(d)) if (/^sport-.+-roster$/.test(k) && v && v.season) rosterMeta = v;
  if (!list && !rosterMeta) return null;
  const first = list && list[0] && list[0].roster;
  const meta = rosterMeta || first || {};
  const sportView = Object.entries(d).find(([k, v]) => /^sport-view-/.test(k) && v && v.slug);
  const sport = (first && first.sport && first.sport.slug) || (sportView && sportView[1].slug) || null;
  const label = meta.season ? meta.season.name || meta.season.slug : null;
  const players = (list || []).filter((x) => x.publication_state == null || x.publication_state === 'published').map((x) => {
    const p = x.player;
    const extra = {};
    for (const f of [].concat(p.profile_field_values || [], x.profile_field_values || [])) if (f && f.profile_field && f.value) extra[f.profile_field.name] = f.value;
    const lvl = x.class_level || p.class_level;
    return row({ pid: p.id, first: p.first_name, last: p.last_name, jersey: x.jersey_number_label != null ? x.jersey_number_label : p.jersey_number_label,
      pos: (x.player_position || p.player_position || {}).abbreviation || (x.player_position || p.player_position || {}).name,
      cls: normClass(lvl && lvl.abbreviation, lvl && lvl.name, null), height_in: inches(x.height_feet != null ? x.height_feet : p.height_feet, x.height_inches != null ? x.height_inches : p.height_inches),
      weight: x.weight != null ? x.weight : p.weight, hometown: p.hometown, high_school: p.high_school, previous_school: p.previous_school, extra });
  });
  /* a season list, where the page carries one: objects named like a season */
  const seasons = [];
  const seen = new Set();
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 4) return;
    if (Array.isArray(o)) { if (o.length > 1 && o.every((s) => s && typeof s === 'object' && /^\d{4}(-\d{2,4})?$/.test(String(s.name || '')) && s.id != null)) for (const s of o) if (!seen.has(s.name)) { seen.add(s.name); seasons.push({ label: s.name, season: seasonKey(s.name), season_id: s.id }); } else for (const x of o) walk(x, depth + 1); return; }
    for (const v of Object.values(o)) walk(v, depth + 1);
  };
  walk(d, 0);
  return { platform: 'wmt', sport, season_label: label, season: seasonKey(label), roster_id: meta.id || null, players, seasons };
}

/* a roster page, whichever platform built it; null when the page carries no roster */
function parseRoster(html) {
  const data = nuxtData(html);
  if (!data) return null;
  return sidearmRoster(data) || wmtRoster(data);
}

/* where a season's roster lives on each platform */
function rosterPath(platform, sport, label) {
  if (platform === 'sidearm') return '/sports/' + sport + '/roster/' + label;
  if (platform === 'wmt') return '/sports/' + sport + '/roster/season/' + label;
  return null;
}

module.exports = { parseRoster, sidearmRoster, wmtRoster, rosterPath, seasonKey, seasonLabel, normClass, batsThrows, SPLIT };
