'use strict';
/* ===========================================================================
   Exhibition games for the college basketball forecasts (men's and women's),
   from the schools' own schedules.

   No feed this repository reads lists an exhibition: the hoopR and wehoop
   schedule files have no preseason row in any season, and ESPN's Division I
   scoreboard listed none on a preseason date. The schools list theirs. The
   collegiate collector (collegiate/schedules.js, plan.json `schedules`) reads
   every Division I school's own schedule page each week, politely, and keeps a
   game the school marks as an exhibition, flagged. This module turns those
   rows into games the forecast can price.

   WHO IS WHO, WITHOUT GUESSING A NAME. A school is the ESPN team whose
   results match its own: each final the school lists for last season or this
   one (never an exhibition) counts for a team that, in the forecast dataset,
   played on that local date (the dataset's own day: UTC - 10 h) and scored
   what the school says it scored, its opponent what the school says they
   did. The best team must match at least MIN_MATCHED finals and MIN_SHARE of
   those the school lists, the runner-up at most half as many, and no other
   school may match the same team; otherwise the school is left unmatched
   and its exhibitions are not priced.
   An opponent is a school by the website the listing names, else (no website,
   or one the registry does not know: a school that moved its site) by its
   name exactly as the registry writes it (after the school's own labels,
   "(Exh.)", "Exhibition", a ranking, come off; "St." and "State" alike). Its
   ESPN team is the one its results match, as above, else the Division I team
   ESPN names exactly as the registry names the school and its teams
   ("Mercyhurst" + "Lakers"). That match also stands over the registry's
   division: a school the registry still has in Division II whose name and
   nickname are a Division I team's this season (Mercyhurst, New Haven) moved
   up. A Division I opponent with no ESPN team is not priced; any other NCAA
   school, or a website and name the registry does not know (an NAIA school),
   is not a Division I team and is priced in the model's pooled non-Division I
   regime, as a counted game against one is.
   A listing whose opponent is the school itself (an intrasquad scrimmage) or
   reads as no school at all ("Red/White Showcase") is not priced.

   AN EXHIBITION IS NEVER A COUNTED GAME. A listing on a day the school's ESPN
   team has a counted game is dropped (the dataset has it). One played between
   two Division I schools is listed by both and priced once, from the listing
   whose start time reads whole.

   TIMES. A school lists the local time ("7 p.m.", "6 p.m. CT"). The zone is the
   one the listing writes, else the state's in the listing's location (the
   home school's city for a home game), else US Eastern; a time that does not
   read (TBA) is noon local. A start not read whole is flagged
   (START_TIME_APPROX).

   Pure functions; the only input read from disk is collegiate/data.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'collegiate', 'data');
const SPORT = { ncaam: 'mens-basketball', ncaaw: 'womens-basketball' };
const MIN_MATCHED = 5;
const MIN_SHARE = 0.6;

/* ------------------------------------------------------------------ time zones */
const TZ = { ET: 'America/New_York', CT: 'America/Chicago', MT: 'America/Denver', AZ: 'America/Phoenix', PT: 'America/Los_Angeles', AK: 'America/Anchorage', HI: 'Pacific/Honolulu' };
/* state (postal code, AP abbreviation or full name) -> zone; a state split by a zone line takes the zone most of its
   schools play in (Texas, Tennessee, Kentucky, Indiana, Florida, Michigan, Kansas, Nebraska, the Dakotas, Oregon, Idaho) */
const STATES = [
  ['AL', 'Ala.', 'Alabama', 'CT'], ['AK', 'Alaska', 'Alaska', 'AK'], ['AZ', 'Ariz.', 'Arizona', 'AZ'], ['AR', 'Ark.', 'Arkansas', 'CT'], ['CA', 'Calif.', 'California', 'PT'],
  ['CO', 'Colo.', 'Colorado', 'MT'], ['CT', 'Conn.', 'Connecticut', 'ET'], ['DE', 'Del.', 'Delaware', 'ET'], ['DC', 'D.C.', 'District of Columbia', 'ET'], ['FL', 'Fla.', 'Florida', 'ET'],
  ['GA', 'Ga.', 'Georgia', 'ET'], ['HI', 'Hawaii', 'Hawaii', 'HI'], ['ID', 'Idaho', 'Idaho', 'MT'], ['IL', 'Ill.', 'Illinois', 'CT'], ['IN', 'Ind.', 'Indiana', 'ET'], ['IA', 'Iowa', 'Iowa', 'CT'],
  ['KS', 'Kan.', 'Kansas', 'CT'], ['KY', 'Ky.', 'Kentucky', 'ET'], ['LA', 'La.', 'Louisiana', 'CT'], ['ME', 'Maine', 'Maine', 'ET'], ['MD', 'Md.', 'Maryland', 'ET'], ['MA', 'Mass.', 'Massachusetts', 'ET'],
  ['MI', 'Mich.', 'Michigan', 'ET'], ['MN', 'Minn.', 'Minnesota', 'CT'], ['MS', 'Miss.', 'Mississippi', 'CT'], ['MO', 'Mo.', 'Missouri', 'CT'], ['MT', 'Mont.', 'Montana', 'MT'], ['NE', 'Neb.', 'Nebraska', 'CT'],
  ['NV', 'Nev.', 'Nevada', 'PT'], ['NH', 'N.H.', 'New Hampshire', 'ET'], ['NJ', 'N.J.', 'New Jersey', 'ET'], ['NM', 'N.M.', 'New Mexico', 'MT'], ['NY', 'N.Y.', 'New York', 'ET'], ['NC', 'N.C.', 'North Carolina', 'ET'],
  ['ND', 'N.D.', 'North Dakota', 'CT'], ['OH', 'Ohio', 'Ohio', 'ET'], ['OK', 'Okla.', 'Oklahoma', 'CT'], ['OR', 'Ore.', 'Oregon', 'PT'], ['PA', 'Pa.', 'Pennsylvania', 'ET'], ['RI', 'R.I.', 'Rhode Island', 'ET'],
  ['SC', 'S.C.', 'South Carolina', 'ET'], ['SD', 'S.D.', 'South Dakota', 'CT'], ['TN', 'Tenn.', 'Tennessee', 'CT'], ['TX', 'Texas', 'Texas', 'CT'], ['UT', 'Utah', 'Utah', 'MT'], ['VT', 'Vt.', 'Vermont', 'ET'],
  ['VA', 'Va.', 'Virginia', 'ET'], ['WA', 'Wash.', 'Washington', 'PT'], ['WV', 'W.Va.', 'West Virginia', 'ET'], ['WI', 'Wis.', 'Wisconsin', 'CT'], ['WY', 'Wyo.', 'Wyoming', 'MT'], ['PR', 'P.R.', 'Puerto Rico', 'ET'],
];
const STATE_TZ = new Map();
for (const [code, ap, name, z] of STATES) for (const k of [code, ap, name, ap.replace(/\./g, '')]) STATE_TZ.set(k.toLowerCase(), TZ[z]);
/** the zone of a listed location ("Abilene, Texas", "Durham, N.C.", "Storrs, CT / Gampel Pavilion"), or null */
function zoneOf(location) {
  const head = String(location || '').split(/\s[\/|]\s|\s-\s/)[0];
  const parts = head.split(',').map((x) => x.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 1; i--) { const z = STATE_TZ.get(parts[i].toLowerCase().replace(/\s+/g, ' ')); if (z) return z; }
  return null;
}
/* the offset (minutes east of UTC) of a zone at an instant */
function offsetMin(zone, ms) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const o = {}; for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return (Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour % 24, +o.minute, +o.second) - ms) / 60000;
}
/** "7 p.m.", "7:30 PM", "19:00", "Noon" -> [hour, minute], or null (TBA, a broadcast name) */
function clockOf(s) {
  const t = String(s || '').trim();
  if (/^noon\b/i.test(t)) return [12, 0];
  let m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\b\.?/i);
  if (m) { let h = +m[1] % 12; if (/p/i.test(m[3])) h += 12; return [h, m[2] ? +m[2] : 0]; }
  m = t.match(/^(\d{1,2}):(\d{2})$/);
  return m && +m[1] < 24 ? [+m[1], +m[2]] : null;
}
/* a zone the listing writes after its time ("6 p.m. CT", "7:00 PM ET") */
const WRITTEN = { E: TZ.ET, C: TZ.CT, M: TZ.MT, P: TZ.PT };
const writtenZone = (time) => { const m = String(time || '').match(/\b([ECMP])[SD]?T\b/); return m ? WRITTEN[m[1]] : null; };
/** a listed local date and time at a location -> { ms, approx } (the zone's offset on that day; noon when no time reads) */
function startOf(date, time, location) {
  const zone = writtenZone(time) || zoneOf(location) || TZ.ET;
  const c = clockOf(time);
  const [y, mo, d] = String(date).split('-').map(Number);
  const wall = Date.UTC(y, mo - 1, d, c ? c[0] : 12, c ? c[1] : 0);
  let ms = wall - offsetMin(zone, wall) * 60000;
  ms = wall - offsetMin(zone, ms) * 60000;          /* the offset at the instant itself (a DST change that day) */
  return { ms, approx: !c || !(writtenZone(time) || zoneOf(location)) };
}

/* ------------------------------------------------------------------ the schools' schedules */
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } };
/** every school's schedule of one sport and season the collector holds: [{ school, host, games }] */
function loadSchedules(league, season, dataDir) {
  const dir = path.join(dataDir || DATA, 'schedules', SPORT[league], String(season));
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => readJson(path.join(dir, f))).filter((x) => x && Array.isArray(x.games))
    .map((x) => ({ school: x.school, host: x.host || null, games: x.games }));
}

/* ------------------------------------------------------------------ schools -> ESPN teams */
/** each school's ESPN team, from its finals (see the header); `unmatched` says why for every other school
    schedules: [{ school, games }] (any seasons); games: the forecast dataset's rows */
function learnTeams(schedules, games) {
  /* the dataset's finals by local day: day -> [{ id, us, them }] (both sides of each game) */
  const byDay = new Map();
  for (const g of games) {
    if (g.status !== 'FINAL' || !g.day || g.hs == null || g.as == null || !g.home_id || !g.away_id) continue;
    if (!byDay.has(g.day)) byDay.set(g.day, []);
    byDay.get(g.day).push({ id: g.home_id, us: g.hs, them: g.as }, { id: g.away_id, us: g.as, them: g.hs });
  }
  const teams = new Map(); const unmatched = [];
  for (const s of schedules) {
    const finals = s.games.filter((g) => !g.exhibition && g.status === 'final' && g.date && byDay.has(g.date) && Number.isFinite(g.us) && Number.isFinite(g.them));
    const score = new Map();
    for (const g of finals) for (const x of byDay.get(g.date)) if (x.us === g.us && x.them === g.them) score.set(x.id, (score.get(x.id) || 0) + 1);
    const [best, second] = [...score].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const why = !finals.length ? 'no final it lists falls on a day the dataset holds' : !best ? 'no ESPN team has its results'
      : best[1] < MIN_MATCHED ? 'only ' + best[1] + ' of its finals matched' : best[1] < MIN_SHARE * finals.length ? best[1] + ' of ' + finals.length + ' finals matched'
      : second && second[1] * 2 > best[1] ? 'two ESPN teams match (' + best[1] + ', ' + second[1] + ')' : null;
    if (why) unmatched.push({ school: s.school, why }); else teams.set(s.school, { id: best[0], matched: best[1], finals: finals.length });
  }
  /* one ESPN team, one school: a team two schools both match is neither's */
  const count = new Map(); for (const v of teams.values()) count.set(v.id, (count.get(v.id) || 0) + 1);
  for (const [k, v] of [...teams]) if (count.get(v.id) > 1) { teams.delete(k); unmatched.push({ school: k, why: 'its ESPN team also matches another school' }); }
  return { teams, unmatched };
}

/* ------------------------------------------------------------------ opponents */
/* a name as the registry writes it, and as a school lists it once its own labels come off */
const normName = (x) => String(x || '').toLowerCase().replace(/&/g, ' and ').replace(/['’.]/g, '').replace(/\bst\b/g, 'state').replace(/[^a-z0-9]+/g, ' ').trim();
/* "(Exh.)", "(EXH)", "(Ex.)", "(ex)", "(exhib.)", "(Exhibition)", "(E)"; " - Exhibition"; "Exhibition " or "Exh: " in front; a ranking */
const EXH_WORD = '(?:e|ex|exh|exhib|exhibition)\\.?';
const bareName = (x) => String(x || '').replace(new RegExp('\\s*\\(' + EXH_WORD + '\\)?\\s*$', 'i'), '').replace(new RegExp('\\s+-\\s*' + EXH_WORD + '\\s*$', 'i'), '')
  .replace(/^\s*(?:exhibition|exh\.?)\s*(?::|-)?\s+/i, '').replace(/^\s*(?:#\d+(?:\/\d+)?|no\.\s*\d+)\s+/i, '').trim();
/** registry lookups: by website host, and by name (a name two schools share is no one's) */
function registryIndex(registry) {
  const byHost = new Map(); const byName = new Map();
  for (const s of registry) {
    for (const h of [s.host, s.registry_host]) if (h) byHost.set(h, s);      /* its site, and the one a correction replaced */
    for (const n of new Set([s.name, s.full_name, s.ncaa_name].filter(Boolean).map(normName))) byName.set(n, byName.has(n) && byName.get(n) !== s ? null : s);
  }
  return { byHost, byName };
}
/** the season's Division I ESPN teams by name ("Mercyhurst Lakers"; a name two teams share is no one's)
    teams: the dataset's teams.json map (id -> { name }); d1: the season's Division I ids */
function espnIndex(teams, d1) {
  const out = new Map();
  for (const id of d1 || []) { const n = normName(((teams || {})[id] || {}).name); if (n) out.set(n, out.has(n) ? null : id); }
  return out;
}
/* the Division I ESPN team a registry school's name and nickname are, or null */
const espnByName = (E, s) => { const ids = new Set([s.name, s.ncaa_name].filter(Boolean).map((n) => E.get(normName(n + ' ' + (s.nickname || '')))).filter(Boolean)); return ids.size === 1 ? [...ids][0] : null; };

/* ------------------------------------------------------------------ exhibitions */
const gameId = (league, date, a, b) => '9' + String(BigInt('0x' + crypto.createHash('sha256').update([league, date, a, b].join('|')).digest('hex').slice(0, 15)) % 10n ** 17n).padStart(17, '0');

/** the exhibitions to price, as dataset-shaped games: scheduled, starting inside [fromMs, toMs), both sides known;
    `skipped` says why every other exhibition listed in the window was left out
    o: { season, fromMs, toMs, d1: Set of the season's Division I ESPN ids, teams (teams.json map), dataDir, schools (registry list) } */
function exhibitions(league, games, o) {
  const season = o.season;
  const now = loadSchedules(league, season, o.dataDir);
  const out = { games: [], skipped: [], schools_read: now.length, schools_matched: 0, unmatched: [] };
  if (!now.length) return out;
  const prev = loadSchedules(league, season - 1, o.dataDir);
  const merged = new Map();
  for (const x of prev.concat(now)) { if (!merged.has(x.school)) merged.set(x.school, { school: x.school, games: [] }); merged.get(x.school).games.push(...x.games); }
  const { teams, unmatched } = learnTeams([...merged.values()], games);
  out.schools_matched = teams.size; out.unmatched = unmatched;
  /* the collector's registry with its host corrections applied (collegiate/rosters.loadSchools) */
  const registry = o.schools || require('../collegiate/rosters').loadSchools(o.dataDir || DATA, { learnt: false });
  const R = registryIndex(registry);
  const E = espnIndex(o.teams, o.d1);
  /* a counted game the dataset holds, by ESPN team and local day */
  const counted = new Set();
  for (const g of games) if (g.season === season && g.day) for (const id of [g.home_id, g.away_id]) counted.add(id + '|' + g.day);
  const seen = new Map();
  for (const s of now) {
    const me = teams.get(s.school);
    const self = registry.find((r) => r.id === s.school) || {};
    for (const x of s.games) {
      if (!x.exhibition || !x.date) continue;
      const t = startOf(x.date, x.time, x.location);
      if (!(t.ms >= o.fromMs && t.ms < o.toMs)) continue;
      const skip = (why) => out.skipped.push({ school: s.school, date: x.date, opponent: x.opponent || null, why });
      if (x.status !== 'scheduled') { skip('listed ' + x.status); continue; }
      if (!me) { skip('the school is not matched to an ESPN team'); continue; }
      if (!o.d1.has(me.id)) { skip('the school\'s ESPN team is not Division I this season'); continue; }
      /* the opponent: by website, else by its registry name; a website and name the registry does not know is no NCAA school */
      const listedName = bareName(x.opponent);
      const reg = (x.opponent_host && R.byHost.get(x.opponent_host)) || R.byName.get(normName(listedName)) || null;
      if ((x.opponent_host && (x.opponent_host === s.host || x.opponent_host === self.host)) || (reg && reg.id === s.school)) { skip('an intrasquad game'); continue; }
      if (!x.opponent_host && !reg) { skip('the opponent reads as no school'); continue; }
      /* its ESPN team: the one its results match, else the Division I team named as the school and its teams are */
      let oppId = null;
      if (reg) {
        const ot = teams.get(reg.id);
        oppId = ot ? (o.d1.has(ot.id) ? ot.id : null) : espnByName(E, reg);
        if (!oppId && reg.division === 1) { skip('a Division I opponent not matched to an ESPN team'); continue; }
      }
      if (oppId === me.id) { skip('an intrasquad game'); continue; }
      if (counted.has(me.id + '|' + x.date) || (oppId && counted.has(oppId + '|' + x.date))) { skip('a counted game the dataset holds that day'); continue; }
      const other = oppId || 'x-' + ((reg && reg.id) || x.opponent_host || normName(listedName).replace(/ /g, '-')).slice(0, 40);
      const key = [x.date].concat([me.id, other].sort()).join('|');
      const prior = seen.get(key);                                    /* two Division I schools list the same game: priced once, */
      if (prior && !(prior.start_approx && !t.approx)) continue;      /* from the listing whose start reads whole */
      const home = x.site === 'A' ? other : me.id, away = x.site === 'A' ? me.id : other;
      const oppName = oppId ? null : listedName || (reg && reg.name) || null;   /* the name the school lists ("UIS"), not the registry's abbreviation */
      const game = { game_id: gameId(league, x.date, home, away), season, season_type: 1, status: 'SCHEDULED', start_utc: new Date(t.ms).toISOString().replace(/\.000Z$/, 'Z'), start_ms: t.ms,
        day: x.date, neutral: x.site === 'N' ? 1 : 0, conf_game: 0, event: 'exhibition', home_id: home, away_id: away,
        home_d1: home === me.id || home === oppId ? 1 : 0, away_d1: away === me.id || away === oppId ? 1 : 0,
        home_name: home === other ? oppName : null, away_name: away === other ? oppName : null, quarantine: [], exhibition: true, start_approx: t.approx,
        source: { school: s.school, host: s.host, game_key: x.game_key || null, listed: { date: x.date, time: x.time || null, site: x.site, opponent: x.opponent || null, location: x.location || null } } };
      if (prior) out.games[out.games.indexOf(prior)] = game; else out.games.push(game);
      seen.set(key, game);
    }
  }
  out.games.sort((a, b) => a.start_ms - b.start_ms || (a.game_id < b.game_id ? -1 : 1));
  return out;
}

module.exports = { SPORT, MIN_MATCHED, MIN_SHARE, zoneOf, clockOf, startOf, offsetMin, loadSchedules, learnTeams, registryIndex, espnIndex, normName, bareName, exhibitions, gameId };
