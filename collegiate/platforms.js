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

/* fall sports: a site that labels its seasons by academic year ("2026-27") means the fall of the first year */
const FALL = new Set(['football', 'womens-volleyball', 'mens-soccer', 'womens-soccer', 'field-hockey', 'mens-water-polo', 'mens-cross-country', 'womens-cross-country']);

/* "2025-26" -> 2026, "1999-2000" -> 2000, "2026" -> 2026; for a fall sport an academic-year label keys by its
   first year ("2026-27" football is the 2026 season), for every other sport by its end year (a spring season, or a
   split-year sport's) */
function seasonKey(label, sport) {
  const s = String(label || '').trim();
  let m = s.match(/^(\d{4})\s*[-/]\s*(\d{2}|\d{4})$/);
  if (m) {
    const a = +m[1]; let b = m[2].length === 4 ? +m[2] : Math.floor(a / 100) * 100 + +m[2]; if (b < a) b += 100;
    return FALL.has(sport) && b === a + 1 ? a : b;
  }
  m = s.match(/^(\d{4})$/) || s.match(/\b(\d{4})\b/);
  return m ? +m[1] : null;
}
/* the label a site uses for a season of a sport, when we have not read its own list */
function seasonLabel(sport, season) {
  return SPLIT.has(sport) ? (season - 1) + '-' + String(season).slice(2) : String(season);
}
/* every way a site labels that season, the usual first: WMT sites differ (Stanford's baseball 2026 is "2026",
   Virginia's "2025-26", BYU's basketball "2025-2026"), and each one answers the others with a 404 or another season */
function seasonLabels(sport, season) {
  const two = (a) => a + '-' + String(a + 1).slice(2);
  const four = (a) => a + '-' + (a + 1);
  if (SPLIT.has(sport)) return [two(season - 1), four(season - 1)];
  if (FALL.has(sport)) return [String(season), two(season), four(season)];
  return [String(season), two(season - 1), four(season - 1)];
}
/* a page's sport against the one asked for. Sites name a sport by their own code (LSU's WMT site calls baseball
   "bsb") or by its name ("Baseball", "Men's Basketball"); a page is that sport when its code or its name is one of
   the sport's known names. Any other name is another sport's page, never assumed to be this one. */
const SPORT_NAMES = {
  baseball: ['bsb', 'm-basebl', 'mbase', 'base'],
  softball: ['sb', 'sball', 'w-softbl', 'wsoft', 'soft'],
  football: ['fb', 'm-footbl', 'foot'],
  'mens-basketball': ['mbb', 'm-baskbl', 'mbkb', 'mens-basketball', 'basketball-men'],
  'womens-basketball': ['wbb', 'w-baskbl', 'wbkb', 'womens-basketball', 'basketball-women'],
  'womens-volleyball': ['wvb', 'vb', 'w-volley', 'wvball', 'volleyball', 'womens-volleyball'],
  'mens-soccer': ['msoc', 'm-soccer', 'mens-soccer', 'soccer-men'],
  'womens-soccer': ['wsoc', 'w-soccer', 'womens-soccer', 'soccer-women'],
};
const sportSlug = (x) => String(x || '').toLowerCase().replace(/[’']/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
function sportMatches(sport, code, name) {
  const ok = new Set([sport].concat(SPORT_NAMES[sport] || []));
  return [code, name].filter(Boolean).some((x) => ok.has(sportSlug(x)));
}
/* how a label is written: "2026" year, "2025-26" split2, "2025-2026" split4 */
const labelStyle = (label) => (/^\d{4}$/.test(String(label)) ? 'year' : /^\d{4}-\d{2}$/.test(String(label)) ? 'split2' : /^\d{4}-\d{4}$/.test(String(label)) ? 'split4' : null);

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
  const seasons = ((store.seasons && sport && store.seasons[sport]) || []).map((s) => ({ label: s.seasonTitle, season: seasonKey(s.seasonTitle, sport), roster_id: s.rosterId }));
  return { platform: 'sidearm', sport, season_label: label, season: seasonKey(label, sport), roster_id: r.id, players, seasons };
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
    if (Array.isArray(o)) { if (o.length > 1 && o.every((s) => s && typeof s === 'object' && /^\d{4}(-\d{2,4})?$/.test(String(s.name || '')) && s.id != null)) for (const s of o) if (!seen.has(s.name)) { seen.add(s.name); seasons.push({ label: s.name, season: seasonKey(s.name, sport), season_id: s.id }); } else for (const x of o) walk(x, depth + 1); return; }
    for (const v of Object.values(o)) walk(v, depth + 1);
  };
  walk(d, 0);
  const sportName = (sportView && sportView[1].name) || (first && first.sport && first.sport.name) || null;
  return { platform: 'wmt', sport, sport_name: sportName, season_label: label, season: seasonKey(label, sport), roster_id: meta.id || null, players, seasons };
}

/* which platform built a page, from the shape of its data alone (so a page with no roster on it, a sport the
   school does not play or a season not posted yet, still says what the site is): SIDEARM's store has its
   site-config; WMT's stores are its oas-* ones */
function detectPlatform(data) {
  const pinia = data && data.pinia;
  if (pinia && (pinia['oas-config'] || pinia['oas-sports'])) return 'wmt';
  if (data && data.data && Object.keys(data.data).some((k) => /^(i-wmt:|sport-view-)/.test(k))) return 'wmt';
  if (pinia && pinia['site-config']) return 'sidearm';
  return null;
}

/* -------------------------------------------------------- SIDEARM (legacy) */
/* SIDEARM's older sites render the roster server-side, one li.sidearm-roster-player per player, with a class
   per field (position, height, weight, jersey number, academic year, hometown, high school, previous school,
   custom columns) and the season in the page title ("2027 Baseball Roster - ..."). A player is identified by
   the name slug of his bio link (/roster/<slug>/<id>): the trailing id may be re-issued each season, the slug
   is the site's own name for the player and stays. */
const decodeHtml = (s) => String(s == null ? '' : s).replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&#8217;/g, "'").replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
function legacyField(seg, cls) {
  const re = new RegExp('<span[^>]*class="[^"]*\\b' + cls + '\\b[^"]*"[^>]*>([\\s\\S]*?)</span>', 'g');
  const out = []; for (let m; (m = re.exec(seg));) out.push(decodeHtml(m[1]));
  return out.filter(Boolean);
}
function sidearmLegacyRoster(html, sportHint) {
  const h = String(html || '');
  const starts = []; const re = /<li[^>]*class="sidearm-roster-player[ "][^>]*>/g;
  for (let m; (m = re.exec(h));) starts.push(m.index);
  if (!starts.length) return null;
  const title = decodeHtml((h.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
  const t = title.match(/(\d{4}(?:\s*-\s*\d{2,4})?)\s+([^-]*?)\s*Roster/i);
  const label = t ? t[1].replace(/\s+/g, '') : null;
  const baseballLike = /baseball|softball/i.test((t && t[2]) || '') || /baseball|softball/.test(sportHint || '');
  const players = [];
  starts.forEach((st, i) => {
    const seg = h.slice(st, i + 1 < starts.length ? starts[i + 1] : st + 20000);
    const url = (seg.match(/data-player-url="([^"]+)"/) || seg.match(/href="(\/sports\/[^"]*\/roster\/[^"]+)"/) || [])[1] || '';
    const slug = (url.match(/\/roster\/([^/]+)\/\d+\/?$/) || url.match(/\/roster\/([^/?#]+)/) || [])[1] || null;
    const name = decodeHtml((seg.match(/sidearm-roster-player-name[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/) || [])[1] || '');
    if (!slug || !name) return;
    const pos = legacyField(seg, 'sidearm-roster-player-position-long-short');
    const yr = legacyField(seg, 'sidearm-roster-player-academic-year');
    const ht = (legacyField(seg, 'sidearm-roster-player-height')[0] || '').match(/(\d)\D+(\d{1,2})?/);
    const wt = (legacyField(seg, 'sidearm-roster-player-weight')[0] || '').match(/(\d{2,3})/);
    const extra = {};
    /* a custom column whose value reads exactly as bats/throws, on a baseball or softball roster */
    for (const k of ['custom1', 'custom2', 'custom3']) { const v = legacyField(seg, 'sidearm-roster-player-' + k)[0]; if (v && baseballLike && /^[LRSB]\s*\/\s*[LR]$/i.test(v)) extra['B/T'] = v; }
    const parts = name.split(' ');
    players.push(row({ pid: 'slug:' + slug, first: parts.slice(0, 1).join(' '), last: parts.slice(1).join(' '), jersey: (legacyField(seg, 'sidearm-roster-player-jersey-number')[0] || null),
      pos: pos[pos.length - 1] || pos[0] || null, cls: normClass(yr[0] || null, yr[yr.length - 1] || null, null), height_in: ht ? inches(ht[1], ht[2]) : null, weight: wt ? +wt[1] : null,
      hometown: legacyField(seg, 'sidearm-roster-player-hometown')[0], high_school: legacyField(seg, 'sidearm-roster-player-highschool')[0],
      previous_school: legacyField(seg, 'sidearm-roster-player-previous-school')[0], extra }));
  });
  const seen = new Set();
  const unique = players.filter((p) => (seen.has(p.pid) ? false : (seen.add(p.pid), true)));
  return { platform: 'sidearm_legacy', sport: null, season_label: label, season: seasonKey(label, sportHint), roster_id: null, players: unique, seasons: [] };
}

/* the platform behind any page: the Nuxt platforms by the shape of their data, SIDEARM's older sites by their markup */
function detectPlatformHtml(html) {
  const p = detectPlatform(nuxtData(html));
  if (p) return p;
  const h = String(html || '');
  if (/class="sidearm-|sidearmsports\.com|sidearm_/.test(h.slice(0, 600000))) return 'sidearm_legacy';
  return null;
}

/* a roster page, whichever platform built it; null when the page carries no roster */
function parseRoster(html, sportHint) {
  const data = nuxtData(html);
  if (data) return sidearmRoster(data) || wmtRoster(data);
  return sidearmLegacyRoster(html, sportHint);
}

/* where a season's roster lives on each platform */
function rosterPath(platform, sport, label) {
  if (platform === 'sidearm' || platform === 'sidearm_legacy') return '/sports/' + sport + '/roster/' + label;
  if (platform === 'wmt') return '/sports/' + sport + '/roster/season/' + label;
  return null;
}

module.exports = { parseRoster, detectPlatform, detectPlatformHtml, sidearmRoster, sidearmLegacyRoster, wmtRoster, rosterPath, seasonKey, seasonLabel, seasonLabels, labelStyle, sportMatches, normClass, batsThrows, SPLIT, FALL };
