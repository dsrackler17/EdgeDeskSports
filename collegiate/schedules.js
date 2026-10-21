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
   =========================================================================== */
const { nuxtData } = require('./nuxt');

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

function parseSchedule(html) {
  const data = nuxtData(html);
  if (!data) return null;
  return sidearmSchedule(data);
}

module.exports = { parseSchedule, sidearmSchedule, hostOf, cleanOpp, innings };
