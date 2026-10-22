'use strict';
/* ===========================================================================
   EdgeDesk collegiate — a school's season schedule and results, read from
   its own schedule page.

   One row per game, as the school lists it: the date (local, as listed),
   home / away / neutral from the school's side, the opponent as named and
   the opponent's own website (which joins to the registry exactly, no name
   guessing), the score, extra or shortened innings, a doubleheader flag,
   postseason, and the box score's address. A game the school lists as
   cancelled or postponed is kept with that status and no score; one it
   marks as an exhibition is kept and flagged, and never counted a final.

   SIDEARM keeps the games in the page's data (collegiate/nuxt.js), with
   each opponent's website, an exact join to the registry. SIDEARM's older
   sites render one li.sidearm-schedule-game per game, the opponent's
   website beside its name too. WMT renders them into the page in one of
   several themes; its opponents join by name. Where a page lists the date
   without its year ("Feb 13 (Fri)"), the year is the season's (autumn
   games the year before a spring season) and the listed weekday must agree,
   or the game is left undated and not kept.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const { nuxtData } = require('./nuxt');
const PL = require('./platforms');

/* the platforms read and how (a backfill completed with fewer is opened again: collegiate/run.js) */
const READERS = 'sidearm,sidearm_vue,sidearm_legacy,wmt+themes5+sport_path';
const DATA = path.join(__dirname, 'data');
const DAY = 24 * 3600 * 1000;
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return d; } };
const writeJson = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 1) + '\n'); };

const hostOf = (u) => { try { return new URL(/^https?:/.test(u) ? u : 'https://' + u).hostname.toLowerCase().replace(/^www\./, ''); } catch (_) { return null; } };
const cleanOpp = (s) => String(s || '').replace(/^\s*(?:vs\.?|at)\s+/i, '').replace(/^\s*(?:#|no\.\s*)\d+\s+/i, '').replace(/\s*\(DH\)\s*$/i, '').replace(/\s+/g, ' ').trim() || null;
/* "7 Inn.", "10 innings", "(8 INN)"; a note that is only "(10)" right after the score; nothing listed -> null
   (the sport's regulation length) */
const innings = (...notes) => {
  for (const n of notes) { const m = String(n || '').match(/(\d{1,2})\s*inn/i); if (m) return +m[1]; }
  for (const n of notes) { const m = String(n || '').match(/^\s*\((\d{1,2})\)\s*$/); if (m) return +m[1]; }
  return null;
};
const text = (s) => String(s || '').replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;|&#8217;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/* the inner HTML of the first element whose class matches, up to its own closing tag (nested tags of its name counted) */
function element(seg, classRe) {
  const open = new RegExp('<([a-z][a-z0-9]*)\\b[^>]*class="[^"]*' + classRe + '[^"]*"[^>]*>', 'i').exec(seg);
  if (!open) return null;
  const tag = open[1].toLowerCase();
  const re = new RegExp('<(/?)' + tag + '\\b[^>]*>', 'gi');
  re.lastIndex = open.index + open[0].length;
  let depth = 1;
  for (let m; (m = re.exec(seg));) { depth += m[1] ? -1 : 1; if (depth === 0) return seg.slice(open.index + open[0].length, m.index); }
  return seg.slice(open.index + open[0].length);
}

/* "Feb 13" (and its listed weekday) in a season: a spring or split-year sport's autumn games are the year before
   its season, a fall sport's January games the year after; a weekday that disagrees leaves the game undated */
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
function monthDay(md, weekday, season, sport) {
  const m = String(md || '').match(/\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})\b/);
  const mo = m && MONTHS[m[1].toLowerCase()];
  if (!mo || !season) return null;
  const year = PL.FALL.has(sport) ? (mo >= 7 ? season : season + 1) : (mo >= 8 ? season - 1 : season);
  const d = new Date(Date.UTC(year, mo - 1, +m[2]));
  if (d.getUTCMonth() !== mo - 1) return null;
  const wd = String(weekday || '').trim().slice(0, 3).toLowerCase();
  if (wd && WEEKDAYS.includes(wd) && WEEKDAYS[d.getUTCDay()] !== wd) return null;
  return d.toISOString().slice(0, 10);
}
/* "4:00 PM" / "3:00 P.M." -> "16:00"; anything else (TBA, a broadcast name) -> null */
function clock(s) {
  const m = String(s || '').match(/\b(\d{1,2}):(\d{2})\s*([AP])\.?\s*M\.?/i);
  if (!m) return null;
  let h = +m[1] % 12; if (/p/i.test(m[3])) h += 12;
  return String(h).padStart(2, '0') + ':' + m[2];
}

/* one SIDEARM game, from the data either generation keeps (the Nuxt store, or the schedule a Vue page is handed) */
function sidearmGame(g) {
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
}

/* SIDEARM: pinia.schedule.schedules['schedules-<sport>,<season>'].games */
function sidearmSchedule(data) {
  const sch = data && data.pinia && data.pinia.schedule && data.pinia.schedule.schedules;
  if (!sch || typeof sch !== 'object') return null;
  const key = Object.keys(sch).find((k) => sch[k] && Array.isArray(sch[k].games));
  if (!key) return null;
  const s = sch[key];
  const sport = (s.sport && (s.sport.globalSportNameSlug || s.sport.shortName)) || key.replace(/^schedules-/, '').split(',')[0] || null;
  return { platform: 'sidearm', sport, sport_name: null, season_label: s.season && s.season.title, school_name: s.school_name || null, seasons: [], games: s.games.map(sidearmGame), undated: 0 };
}

/* a JSON object literal in a page's script, from its opening brace (strings and escapes respected) */
function jsonAt(h, open) {
  let depth = 0, inStr = false, esc = false;
  for (let j = open; j < h.length; j++) {
    const c = h[j];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(h.slice(open, j + 1)); } catch (_) { return null; } } }
  }
  return null;
}

/* SIDEARM's Vue generation (George Mason, Bradley): the page hands its Vue component the season's schedule as a literal
   (`schedule : {...}`), its games in the same shape as the Nuxt store's; the season is its title ("2025 Baseball Schedule") */
function sidearmVueSchedule(html) {
  const h = String(html || '');
  const m = /\bschedule\s*:\s*\{"id":/.exec(h);
  if (!m) return null;
  const o = jsonAt(h, m.index + m[0].indexOf('{'));
  if (!o || !Array.isArray(o.games)) return null;
  const t = String(o.title || '').match(/(\d{4}(?:\s*-\s*\d{2,4})?)\s+(.*?)\s*Schedule/i);
  const sport = o.sport && (o.sport.global_sport_name_slug || o.sport.shortname) || null;
  return { platform: 'sidearm_legacy', sport, sport_name: t ? t[2].trim() || null : null, season_label: t ? t[1].replace(/\s+/g, '') : null, school_name: o.school_name || null,
    seasons: [], games: o.games.map(sidearmGame), undated: 0 };
}

/* WMT renders a schedule's games into the page (not its data), in one of several themes: one block per game
   (.schedule-event-item at Stanford, Auburn, Virginia and LSU; .schedule-item-block at UCLA, whose page repeats
   every game in a table view, never read twice), each with the venue (a label, a class, or a venue line), the
   date (a <time datetime>, or the month, day and weekday alone), the opponent's name, and the result as the
   school reads it ("W 10-7": the school's runs first) followed by any innings note ("(8 innings)", "12 Inn.",
   "(10)"). No opponent website, so the opponent joins by name. The page's own data names the season, the sport,
   and every season the site keeps (schedule-list-seasons: each label and the slug its pages use). */
const WMT_BLOCKS = [/class="schedule-event-item(?=[ "])/g, /class="schedule-item-block(?=[ "])/g];
function wmtSchedule(html, data, sportHint) {
  const h = String(html || '');
  /* the theme with the most games: a page may carry one game in another theme (Vanderbilt's tournament game) */
  let starts = [];
  for (const re of WMT_BLOCKS) { const at = []; for (let m; (m = re.exec(h));) at.push(m.index); if (at.length > starts.length) starts = at; }
  if (!starts.length) return null;
  const d = (data && data.data) || {};
  const view = Object.entries(d).find(([k, v]) => /^sport-view-/.test(k) && v && v.slug);
  const bySlug = Object.entries(d).find(([k, v]) => /^sport-.+-schedule-by-slug-/.test(k) && v && v.season);
  const byId = Object.entries(d).find(([k, v]) => /^schedule-\d+$/.test(k) && v && v.data && v.data.season);
  const season = (bySlug && bySlug[1].season) || (byId && byId[1].data.season) || null;
  /* a season is known by its name ("2026-27") and reached by its slug, which can differ (Clemson's 2026-27 is /season/2026) */
  const label = season ? season.name || season.slug : null;
  const slug = season ? season.slug || season.name : null;
  const list = Object.entries(d).find(([k, v]) => /^schedule-list-seasons-/.test(k) && Array.isArray(v));
  const seasons = list ? list[1].filter((x) => x && x.value).map((x) => ({ label: String(x.value), name: x.label != null ? String(x.label) : null })) : [];
  const sport = view ? view[1].slug : null;
  const seasonNo = PL.seasonKey(label, sportHint || sport);
  let undated = 0;
  const games = starts.map((st, i) => {
    const seg = h.slice(st, i + 1 < starts.length ? starts[i + 1] : st + 40000);
    const v = seg.match(/schedule-item-block--(home|away|neutral)\b|venue-label--(home|away|neutral)\b|--venue-(home|away|neutral)\b|class="[^"]*__venue(?=[ "])[^"]*"[^>]*>\s*(home|away|neutral)\s*<|venue__type--(home|away|neutral)\b/i);
    /* a theme that marks no venue says "at" for a road game and "vs." for a home or a neutral one: "vs." is left unknown */
    const venue = v ? String(v[1] || v[2] || v[3] || v[4] || v[5]).toLowerCase() : /^at$/i.test(text(element(seg, '__divider(?=[ "])') || '')) ? 'away' : null;
    const dt = (seg.match(/datetime="([^"]+)"/) || [])[1] || null;
    /* no datetime: the month and day (__month-day, or __label at Nebraska) and the weekday (__weekday, or a bare <time>Friday</time>) */
    const md = text(element(seg, 'schedule-event-date__month-day(?=[ "])') || element(seg, 'schedule-event-date__label(?=[ "])') || element(seg, 'schedule-event-date__day(?=[ "])') || '');
    const wd = text(element(seg, 'schedule-event-date__weekday(?=[ "])') || '') || ((seg.match(/<time>\s*(Sun|Mon|Tue|Wed|Thu|Fri|Sat)[a-z]*\s*<\/time>/i) || [])[1] || '');
    const date = dt ? dt.slice(0, 10) : monthDay(md, wd, seasonNo, sportHint || sport);
    if (!date) undated++;
    /* the opponent: its own element, or (Vanderbilt's theme) the heading that reads "vs. #10 TCU" */
    const opp = element(seg, '__opponent-name(?=[ "])') || element(seg, '__opponent(?=[ "])') || element(seg, 'schedule-default-event__name(?=[ "])') || element(seg, 'schedule-item-team__heading(?=[ "])');
    const loc = element(seg, 'schedule-event-location(?=[ "])') || element(seg, '__location(?=[ "])');
    const resHtml = element(seg, 'schedule-event-item-result__label(?=[ "])');
    const rt = resHtml != null ? text(resHtml) : '';
    const sc = rt.match(/\b([WLT])\b[\s\S]*?(\d+)\s*-\s*(\d+)/);
    /* the innings note sits right after the score, before the game's links */
    const resAt = resHtml != null ? seg.indexOf(resHtml) + resHtml.length : -1;
    const after = resAt >= 0 ? text(seg.slice(resAt).split(/schedule-event-links|schedule-event-item-links|Box Score/)[0]) : '';
    const box = (seg.match(/href="([^"]*\/boxscore\/\d+)"/) || [])[1] || null;
    const note = text(element(seg, 'schedule-event-item-result__text(?=[ "])') || '');
    const exhibition = /class="[^"]*(?:schedule-event-exhibition|__exhibition)(?=[ "])/.test(seg);
    const status = sc ? 'final' : /cancel/i.test(rt + ' ' + note) ? 'cancelled' : /postpon/i.test(rt + ' ' + note) ? 'postponed' : 'scheduled';
    return Object.assign({ game_key: box ? box.match(/(\d+)$/)[1] : null, date, time: dt ? dt.slice(11, 16) : clock(text(element(seg, 'schedule-event-date__clock'))),
      site: venue === 'home' ? 'H' : venue === 'away' ? 'A' : venue === 'neutral' ? 'N' : null,
      opponent: opp ? cleanOpp(text(opp)) : null, opponent_host: null, conference: null, postseason: null, doubleheader: null, status,
      us: sc ? +sc[2] : null, them: sc ? +sc[3] : null, outcome: sc ? sc[1] : null, innings: innings(rt.replace(/^[\s\S]*?\d+\s*-\s*\d+/, ''), after, note),
      location: loc ? text(loc) || null : null, event: null, boxscore: box, note: note || null }, exhibition ? { exhibition: true } : {});
  }).filter((g) => g.date && g.opponent);
  return { platform: 'wmt', sport, sport_name: view ? view[1].name || null : null, season_label: label, season_slug: slug, school_name: null, seasons, games, undated };
}

/* SIDEARM's older sites: one li.sidearm-schedule-game per game (data-game-id), its class naming the site
   (sidearm-schedule-home-game / -away-game / -neutral-game); the date as "Feb 13 (Fri)" with the time beside it;
   the opponent's name, linked to its own website; the result ("W," "3-1" "(8 Inn.)", the school's runs first, or
   "Canceled"); a conference marker; "(DH)" on a doubleheader game; the box score's link. The season is the page's
   title ("2026 Baseball Schedule"); a season <select> names every season the site keeps, by the path of its page. */
function sidearmLegacySchedule(html, sportHint, ownHost) {
  const h = String(html || '');
  const starts = []; const re = /<li class="sidearm-schedule-game[ "][^>]*>/g;
  for (let m; (m = re.exec(h));) starts.push({ at: m.index, tag: m[0] });
  if (!starts.length) return null;
  /* the season: the schedule heading when it names one ("2026 Baseball Schedule"), else the page's title */
  const SEASON_TITLE = /(\d{4}(?:\s*-\s*\d{2,4})?)\s+([^-]*?)\s*Schedule/i;
  const heads = [text((h.match(/class="sidearm-schedule-title[^"]*"[^>]*>\s*(?:<[^>]+>\s*)*<h2>([\s\S]*?)<\/h2>/) || [])[1] || ''), text((h.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '')];
  const t = heads.map((x) => x.match(SEASON_TITLE)).find(Boolean) || null;
  const label = t ? t[1].replace(/\s+/g, '') : null;
  const sportName = t ? t[2].trim() || null : null;
  const seasonNo = PL.seasonKey(label, sportHint);
  const seasons = [];
  const sel = h.match(/<select id="sidearm-schedule-select-season"[\s\S]*?<\/select>/);
  if (sel) for (const m of sel[0].matchAll(/value="\/sports\/[^/"]+\/schedule\/([^"/]+)"/g)) seasons.push({ label: m[1], name: m[1] });
  let undated = 0;
  const games = starts.map((s, i) => {
    const seg = h.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : s.at + 30000);
    const cls = (s.tag.match(/class="([^"]*)"/) || [])[1] || '';
    const site = /sidearm-schedule-home-game/.test(cls) ? 'H' : /sidearm-schedule-away-game/.test(cls) ? 'A' : /sidearm-schedule-neutral-game/.test(cls) ? 'N' : null;
    const when = [...(element(seg, 'sidearm-schedule-game-opponent-date(?=[ "])') || '').matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map((m) => text(m[1]));
    const md = (when[0] || '').match(/^([A-Za-z]{3,9}\.?\s+\d{1,2})\s*(?:\(([A-Za-z]{3})[a-z]*\))?/);
    const date = md ? monthDay(md[1], md[2], seasonNo, sportHint) : null;
    if (!date) undated++;
    const nameHtml = element(seg, 'sidearm-schedule-game-opponent-name(?=[ "])') || '';
    const link = nameHtml.match(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    const oppHost = link ? hostOf(link[1]) : null;
    const opponent = cleanOpp(text(link ? link[2] : nameHtml.replace(/<span[^>]*>\s*(?:#|No\.\s*)\d+\s*<\/span>/i, '')));
    const resText = [...(element(seg, 'sidearm-schedule-game-result(?=[ "])') || '').matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map((m) => text(m[1])).filter(Boolean).join(' ');
    const sc = resText.match(/^([WLT])\b,?\s*(\d+)\s*-\s*(\d+)/);
    /* the school's runs come first: a win listed with fewer runs is not a result we can read */
    const agrees = sc && (sc[1] === 'W' ? +sc[2] > +sc[3] : sc[1] === 'L' ? +sc[2] < +sc[3] : +sc[2] === +sc[3]);
    const box = (seg.match(/sidearm-schedule-game-links-boxscore[^>]*>\s*<a[^>]*href="([^"]+)"/) || [])[1] || null;
    const conf = text(element(seg, 'sidearm-schedule-game-conference(?=[ "])') || '');
    const loc = [...(element(seg, 'sidearm-schedule-game-location(?=[ "])') || '').matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map((m) => text(m[1])).filter(Boolean).join(' / ');
    const status = sc && agrees ? 'final' : /cancel/i.test(resText) ? 'cancelled' : /postpon/i.test(resText) ? 'postponed' : 'scheduled';
    return { game_key: (s.tag.match(/data-game-id="(\d+)"/) || [])[1] || null, date, time: clock(when.slice(1).join(' ')), site,
      opponent, opponent_host: oppHost && oppHost !== ownHost ? oppHost : null, conference: !!conf, postseason: null,
      doubleheader: /\(DH\)/i.test(text(nameHtml)), status, us: status === 'final' ? +sc[2] : null, them: status === 'final' ? +sc[3] : null,
      outcome: status === 'final' ? sc[1] : null, innings: status === 'final' ? innings(resText.slice(sc[0].length)) : null, location: loc || null, event: null,
      boxscore: box && /\/boxscore\//.test(box) ? box : null, note: sc && !agrees ? 'result reads ' + resText + ': not kept' : status === 'scheduled' && resText ? resText : null };
  }).filter((g) => g.date && g.opponent);
  return { platform: 'sidearm_legacy', sport: null, sport_name: sportName, season_label: label, school_name: null, seasons, games, undated };
}

function parseSchedule(html, sportHint, ownHost) {
  const data = nuxtData(html);
  if (data) return sidearmSchedule(data) || wmtSchedule(html, data, sportHint);
  return sidearmVueSchedule(html) || sidearmLegacySchedule(html, sportHint, ownHost);
}

/* where a season's schedule lives on each platform */
function schedulePath(platform, sport, label) {
  if (platform === 'sidearm' || platform === 'sidearm_legacy') return '/sports/' + sport + '/schedule/' + label;
  if (platform === 'wmt') return '/sports/' + sport + '/schedule/season/' + label;
  return null;
}
/* a miss worth reporting over another: what a page said beats a 404 of a label it did not use */
const MISS_RANK = { HTTP: 0, NO_PAGE: 0, NO_SCHEDULE: 1, SEASON_MISMATCH: 2, SPORT_MISMATCH: 2, EMPTY_SCHEDULE: 3 };
const better = (a, b) => (!a ? b : (MISS_RANK[b.code] || 0) > (MISS_RANK[a.code] || 0) ? b : a);

/* one school's season: the season's own page, parsed and written whole (a read listing under half the finals the
   last one did is refused). A WMT season is tried under each way WMT sites label it (rosters.seasonLabelsFor), and
   the page itself names the site's own labels for every season it keeps, which are learnt. */
async function collectOne(polite, school, sport, season, o) {
  const RO = require('./rosters');
  const plat = (o.platforms[school.id] || {}).platform;
  const miss = (code, why, url) => ({ ok: false, school: school.id, sport, season, url: url || null, code, why });
  if (!['sidearm', 'sidearm_legacy', 'wmt'].includes(plat)) return miss('PLATFORM_NOT_READ', 'the site\'s platform is not known or not read (the roster collector learns it)');
  const key = school.id + '|' + sport + '|' + season;
  const past = season < o.current(sport);
  const tried = new Set();
  let last = null;
  /* a WMT site's own code for the sport is the one its pages use (LSU: /sports/bsb/...) */
  const sportPath = (plat === 'wmt' && o.labels[school.id + '|' + sport + '|path']) || sport;
  for (let queue = RO.seasonLabelsFor(school, plat, sport, season, o); queue.length;) {
    const label = queue.shift();
    if (tried.has(label)) continue;
    tried.add(label);
    const url = 'https://' + school.host + schedulePath(plat, sportPath, label);
    const r = await polite.get(url, { ttlMs: past ? 30 * DAY : 12 * 3600 * 1000, noStore: true });
    if (!r.ok) { const m = miss(r.refused ? 'REFUSED' : 'HTTP', (r.error && r.error.message) || 'no answer', url); if (r.refused) return m; last = better(last, m); continue; }
    const x = parseSchedule(r.text(), sport, school.host);
    if (!x) { last = better(last, miss('NO_SCHEDULE', 'the page carries no schedule data', url)); continue; }
    /* the page names the site's own slug for every season it keeps, by the season's name: learnt, and this season's tried next if new */
    for (const s of x.seasons || []) { const k = PL.seasonKey(s.name || s.label, sport); if (k) o.labels[school.id + '|' + sport + '|' + k] = s.label; }
    if (x.platform === 'wmt' && x.sport && x.sport !== sport && PL.sportMatches(sport, x.sport, x.sport_name)) o.labels[school.id + '|' + sport + '|path'] = x.sport;
    if (o.labels[key] && !tried.has(o.labels[key])) queue.unshift(o.labels[key]);
    if (PL.seasonKey(x.season_label, sport) !== season) { last = better(last, miss('SEASON_MISMATCH', 'the page is the ' + x.season_label + ' schedule', url)); continue; }
    if ((x.sport || x.sport_name) && !PL.sportMatches(sport, x.sport, x.sport_name)) { last = better(last, miss('SPORT_MISMATCH', 'the page is ' + (x.sport_name || x.sport), url)); continue; }
    if (!x.games.length) { last = better(last, miss('EMPTY_SCHEDULE', 'the schedule lists no games' + (x.undated ? ' (' + x.undated + ' whose date does not read)' : ''), url)); continue; }
    const file = path.join(o.dataDir, 'schedules', sport, String(season), school.id + '.json');
    const prev = readJson(file, null);
    const finals = x.games.filter((g) => g.status === 'final' && !g.exhibition).length;
    if (prev && prev.finals >= 10 && finals < prev.finals / 2) return miss('SHRUNK', 'this read lists ' + finals + ' finals, the last ' + prev.finals + ': not written', url);
    const head = { schema: 'edgedesk_collegiate_schedule_v1', school: school.id, host: school.host, platform: plat, sport, season, season_label: x.season_label, url,
      first_read: (prev && prev.first_read) || o.today, last_read: o.today, games_listed: x.games.length, finals, undated: x.undated || 0 };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(head, null, 1).replace(/\n}$/, ',\n "games": [\n' + x.games.map((g) => '  ' + JSON.stringify(g)).join(',\n') + '\n ]\n}') + '\n');
    if (plat !== 'sidearm') o.labels[key] = label;
    return { ok: true, school: school.id, sport, season, url, games: x.games.length, finals };
  }
  return last || miss('NO_PAGE', 'no page to try');
}

async function collect(o) {
  const RO = require('./rosters');
  const today = o.today || new Date().toISOString().slice(0, 10);
  const dataDir = o.dataDir || DATA;
  const all = o.schoolsList || RO.loadSchools(dataDir);
  const division = o.division == null ? 1 : o.division;
  const schools = all.filter((s) => s.host && (o.schools ? o.schools.includes(s.id) : (division === 'all' || s.division === division)));
  const polite = o.polite || require('./polite').createPolite({ hosts: [...new Set(schools.map((s) => s.host))], cacheDir: path.join(__dirname, '..', '.cache', 'collegiate'), log: (m) => console.error(m) });
  const labelsFile = path.join(dataDir, 'season_labels.json');
  const ctx = { today, dataDir, labels: readJson(labelsFile, {}), platforms: readJson(path.join(dataDir, 'platforms.json'), {}), current: (sp) => RO.currentSeason(sp, today) };
  const results = [];
  const queue = schools.slice();
  const lanes = Math.max(1, Math.min(o.lanes || 32, queue.length));
  await Promise.all(Array.from({ length: lanes }, async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      for (const sport of o.sports) for (const season of o.seasons.slice().sort((a, b) => b - a)) {
        if (o.skip && o.skip(s.id, sport, season)) continue;
        const res = await collectOne(polite, s, sport, season, ctx);
        results.push(res);
        if (o.log !== false) console.error((res.ok ? 'ok   ' : 'miss ') + s.id + ' ' + sport + ' schedule ' + season + (res.ok ? '  ' + res.finals + ' finals' : '  ' + res.code + ': ' + res.why));
        if (!res.ok && (res.code === 'REFUSED' || res.code === 'PLATFORM_NOT_READ')) break;
      }
    }
  }));
  writeJson(labelsFile, ctx.labels);
  const byCode = {};
  for (const r of results) if (!r.ok) byCode[r.code] = (byCode[r.code] || 0) + 1;
  return { schools: schools.length, ok: results.filter((r) => r.ok).length, misses_by_reason: byCode, misses: results.filter((r) => !r.ok) };
}

module.exports = { READERS, parseSchedule, sidearmSchedule, sidearmVueSchedule, wmtSchedule, sidearmLegacySchedule, schedulePath, collect, collectOne, hostOf, cleanOpp, innings, monthDay, element };
