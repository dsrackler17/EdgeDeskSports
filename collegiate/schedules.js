'use strict';
/* ===========================================================================
   EdgeDesk collegiate — a school's season schedule and results, read from
   its own schedule page (the page's Nuxt data, collegiate/nuxt.js).

   One row per game, as the school lists it: the date (local, as listed),
   home / away / neutral from the school's side, the opponent as named and
   the opponent's own website (which joins to the registry exactly, no name
   guessing), the score, extra or shortened innings, a doubleheader flag,
   postseason, and the box score's address. A game the school lists as
   cancelled or postponed is kept with that status and no score.

   SIDEARM keeps the games in the page's data (with each opponent's website,
   an exact join to the registry); WMT renders them into the page, and its
   opponents join by name.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const { nuxtData } = require('./nuxt');
const PL = require('./platforms');

const DATA = path.join(__dirname, 'data');
const DAY = 24 * 3600 * 1000;
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return d; } };

const hostOf = (u) => { try { return new URL(/^https?:/.test(u) ? u : 'https://' + u).hostname.toLowerCase().replace(/^www\./, ''); } catch (_) { return null; } };
const cleanOpp = (s) => String(s || '').replace(/^\s*(?:#|no\.\s*)\d+\s+/i, '').replace(/\s+/g, ' ').trim() || null;
/* "7 Inn." -> 7, "10 innings" -> 10; nothing listed -> null (the sport's regulation length) */
const innings = (...notes) => { for (const n of notes) { const m = String(n || '').match(/(\d{1,2})\s*inn/i); if (m) return +m[1]; } return null; };

/* SIDEARM: pinia.schedule.schedules['schedules-<sport>,<season>'].games */
function sidearmSchedule(data) {
  const sch = data && data.pinia && data.pinia.schedule && data.pinia.schedule.schedules;
  if (!sch || typeof sch !== 'object') return null;
  const key = Object.keys(sch).find((k) => sch[k] && Array.isArray(sch[k].games));
  if (!key) return null;
  const s = sch[key];
  const sport = (s.sport && (s.sport.globalSportNameSlug || s.sport.shortName)) || key.replace(/^schedules-/, '').split(',')[0] || null;
  const games = s.games.map((g) => {
    const r = g.result || {};
    const us = r.team_score !== '' && r.team_score != null ? +r.team_score : null;
    const them = r.opponent_score !== '' && r.opponent_score != null ? +r.opponent_score : null;
    const status = g.status === 'C' ? 'cancelled' : g.status === 'P' ? 'postponed' : (us != null && them != null && Number.isFinite(us) && Number.isFinite(them)) ? 'final' : 'scheduled';
    const opp = g.opponent || {};
    return {
      game_key: String(g.id), date: String(g.date || '').slice(0, 10), time: g.time || null,
      site: g.location_indicator === 'H' ? 'H' : g.location_indicator === 'A' ? 'A' : g.location_indicator === 'N' ? 'N' : null,
      opponent: cleanOpp(opp.title), opponent_host: opp.website ? hostOf(opp.website) : null, conference: !!g.conference,
      postseason: g.type === 'P', doubleheader: !!g.is_a_doubleheader, status,
      us: status === 'final' ? us : null, them: status === 'final' ? them : null, outcome: status === 'final' ? (r.status || null) : null,
      innings: innings(r.postscore_info, r.prescore_info), location: g.location || null, event: (g.tournament && g.tournament.title) || null,
      boxscore: (r.boxscore && r.boxscore.url) || null, note: g.noplay_text || null,
    };
  });
  return { platform: 'sidearm', sport, season_label: s.season && s.season.title, school_name: s.school_name || null, games };
}

/* WMT renders a schedule's games into the page (not its data): one .schedule-event-item per game, with the
   venue label (home / away / neutral), a <time datetime>, the opponent's name, and the result as the school
   reads it ("W 10-7": the school's runs first). No opponent website, so the opponent joins by name. */
const text = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
function wmtSchedule(html, data) {
  const h = String(html || '');
  const starts = []; const re = /class="schedule-event-item(?=[ "])/g;
  for (let m; (m = re.exec(h));) starts.push(m.index);
  if (!starts.length) return null;
  const d = data && data.data;
  const view = d && Object.entries(d).find(([k, v]) => /^sport-view-/.test(k) && v && v.slug);
  const bySlug = d && Object.entries(d).find(([k, v]) => /^sport-.+-schedule-by-slug-/.test(k) && v && v.season);
  const games = starts.map((st, i) => {
    const seg = h.slice(st, i + 1 < starts.length ? starts[i + 1] : st + 40000);
    const site = /venue-label--home/.test(seg) ? 'H' : /venue-label--away/.test(seg) ? 'A' : /venue-label--neutral/.test(seg) ? 'N' : null;
    const dt = (seg.match(/datetime="([^"]+)"/) || [])[1] || null;
    const opp = seg.match(/schedule-event-item-team__opponent-name[^>]*>([\s\S]*?)<\/(?:div|span|h\d|p|a)>/);
    const loc = seg.match(/schedule-event-item-team__location[^>]*>([\s\S]*?)<\/(?:div|span|p)>/);
    const res = seg.match(/schedule-event-item-result__label[^>]*>([\s\S]*?)<\/div>/);
    const rt = res ? text(res[1]) : '';
    const sc = rt.match(/\b([WLT])\b[\s\S]*?(\d+)\s*-\s*(\d+)/);
    const box = (seg.match(/href="([^"]*\/boxscore\/\d+)"/) || [])[1] || null;
    const note = text((seg.match(/schedule-event-item-result__text[^>]*>([\s\S]*?)<\/(?:div|span)>/) || [])[1] || '');
    const status = sc ? 'final' : /cancel/i.test(seg) ? 'cancelled' : /postpon/i.test(seg) ? 'postponed' : 'scheduled';
    return { game_key: box ? box.match(/(\d+)$/)[1] : null, date: dt ? dt.slice(0, 10) : null, time: dt ? dt.slice(11, 16) : null, site,
      opponent: opp ? cleanOpp(text(opp[1])) : null, opponent_host: null, conference: null, postseason: null, doubleheader: null, status,
      us: sc ? +sc[2] : null, them: sc ? +sc[3] : null, outcome: sc ? sc[1] : null, innings: innings(note, rt),
      location: loc ? text(loc[1]) || null : null, event: null, boxscore: box, note: note || null };
  }).filter((g) => g.date && g.opponent);
  return { platform: 'wmt', sport: view ? view[1].slug : null, season_label: bySlug ? (bySlug[1].season.name || bySlug[1].season.slug) : null, school_name: null, games };
}

function parseSchedule(html) {
  const data = nuxtData(html);
  if (!data) return null;
  return sidearmSchedule(data) || wmtSchedule(html, data);
}

/* where a season's schedule lives on each platform */
function schedulePath(platform, sport, label) {
  if (platform === 'sidearm') return '/sports/' + sport + '/schedule/' + label;
  if (platform === 'wmt') return '/sports/' + sport + '/schedule/season/' + label;
  return null;
}

/* one school's season: the season's own page, parsed and written whole (a read listing under half the finals the last one did is refused) */
async function collectOne(polite, school, sport, season, o) {
  const plat = (o.platforms[school.id] || {}).platform;
  const miss = (code, why, url) => ({ ok: false, school: school.id, sport, season, url: url || null, code, why });
  if (plat !== 'sidearm' && plat !== 'wmt') return miss('PLATFORM_NOT_READ', 'the site\'s platform is not known or not read (the roster collector learns it)');
  const label = (o.labels && o.labels[school.id + '|' + sport + '|' + season]) || PL.seasonLabel(sport, season);
  const url = 'https://' + school.host + schedulePath(plat, sport, label);
  const past = season < o.current(sport);
  const r = await polite.get(url, { ttlMs: past ? 30 * DAY : 12 * 3600 * 1000, noStore: true });
  if (!r.ok) return miss(r.refused ? 'REFUSED' : 'HTTP', (r.error && r.error.message) || 'no answer', url);
  const x = parseSchedule(r.text());
  if (!x) return miss('NO_SCHEDULE', 'the page carries no schedule data', url);
  if (PL.seasonKey(x.season_label) !== season) return miss('SEASON_MISMATCH', 'the page is the ' + x.season_label + ' schedule', url);
  if (x.sport && x.sport !== sport) return miss('SPORT_MISMATCH', 'the page is ' + x.sport, url);
  if (!x.games.length) return miss('EMPTY_SCHEDULE', 'the schedule lists no games', url);
  const file = path.join(o.dataDir, 'schedules', sport, String(season), school.id + '.json');
  const prev = readJson(file, null);
  const finals = x.games.filter((g) => g.status === 'final').length;
  if (prev && prev.finals >= 10 && finals < prev.finals / 2) return miss('SHRUNK', 'this read lists ' + finals + ' finals, the last ' + prev.finals + ': not written', url);
  const head = { schema: 'edgedesk_collegiate_schedule_v1', school: school.id, host: school.host, platform: plat, sport, season, season_label: x.season_label, url,
    first_read: (prev && prev.first_read) || o.today, last_read: o.today, games_listed: x.games.length, finals };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(head, null, 1).replace(/\n}$/, ',\n "games": [\n' + x.games.map((g) => '  ' + JSON.stringify(g)).join(',\n') + '\n ]\n}') + '\n');
  return { ok: true, school: school.id, sport, season, url, games: x.games.length, finals };
}

async function collect(o) {
  const RO = require('./rosters');
  const today = o.today || new Date().toISOString().slice(0, 10);
  const dataDir = o.dataDir || DATA;
  const all = o.schoolsList || RO.loadSchools(dataDir);
  const division = o.division == null ? 1 : o.division;
  const schools = all.filter((s) => s.host && (o.schools ? o.schools.includes(s.id) : (division === 'all' || s.division === division)));
  const polite = o.polite || require('./polite').createPolite({ hosts: [...new Set(schools.map((s) => s.host))], cacheDir: path.join(__dirname, '..', '.cache', 'collegiate'), log: (m) => console.error(m) });
  const ctx = { today, dataDir, labels: readJson(path.join(dataDir, 'season_labels.json'), {}), platforms: readJson(path.join(dataDir, 'platforms.json'), {}), current: (sp) => RO.currentSeason(sp, today) };
  const results = [];
  const queue = schools.slice();
  const lanes = Math.max(1, Math.min(o.lanes || 32, queue.length));
  await Promise.all(Array.from({ length: lanes }, async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      for (const sport of o.sports) for (const season of o.seasons.slice().sort((a, b) => b - a)) {
        const res = await collectOne(polite, s, sport, season, ctx);
        results.push(res);
        if (o.log !== false) console.error((res.ok ? 'ok   ' : 'miss ') + s.id + ' ' + sport + ' schedule ' + season + (res.ok ? '  ' + res.finals + ' finals' : '  ' + res.code + ': ' + res.why));
        if (!res.ok && (res.code === 'REFUSED' || res.code === 'PLATFORM_NOT_READ')) break;
      }
    }
  }));
  const byCode = {};
  for (const r of results) if (!r.ok) byCode[r.code] = (byCode[r.code] || 0) + 1;
  return { schools: schools.length, ok: results.filter((r) => r.ok).length, misses_by_reason: byCode, misses: results.filter((r) => !r.ok) };
}

module.exports = { parseSchedule, sidearmSchedule, schedulePath, collect, collectOne, hostOf, cleanOpp, innings };
