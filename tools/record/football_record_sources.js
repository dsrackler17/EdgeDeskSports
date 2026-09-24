/* ===========================================================================
   WHERE THE FOOTBALL MODEL RECORD READS THE MARKET, THE CLOSE AND THE FINAL.

   Public, keyless feeds only, every one of them already trusted elsewhere in
   this repository:

     NFL  nflverse/nfldata games.csv — the consensus spread and total (the
          line while the game is ahead, the CLOSE once the result is posted)
          and the final score. The same feed the board and the slate read.
     CFB  ESPN's scoreboard (the one tools/collective/settle_finals.js reads
          every hour): the book line ESPN carries while the game is ahead,
          the line it froze at kickoff once the game is final, and the final
          score, keyed by the ESPN event id the FBS slate already uses as its
          game_id. cfbfastR's schedule CSV is a second, independent final:
          when both carry a game they must agree or nothing is settled.

   Nothing here touches `signals`, the edges record, or any credential. The
   parsers are pure and are what the tests drive; the fetchers are thin.
   =========================================================================== */
'use strict';
const path = require('path');
const { parseCsv } = require(path.join(__dirname, '..', '..', 'football', 'data', 'recovery.js'));

const URL_NFL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const URL_CFB_SCHED = (y) => `https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/schedules/csv/cfb_schedules_${y}.csv`;
const ESPN_BASE = { nfl: 'football/nfl', cfb: 'football/college-football' };
const espnScoreboardUrl = (sport, yyyymmdd) => `https://site.api.espn.com/apis/site/v2/sports/${ESPN_BASE[sport]}/scoreboard?dates=${yyyymmdd}&limit=400${sport === 'cfb' ? '&groups=80' : ''}`;
const espnSummaryUrl = (sport, id) => `https://site.api.espn.com/apis/site/v2/sports/${ESPN_BASE[sport]}/summary?event=${encodeURIComponent(id)}`;

function num(v) {
  if (v === null || v === undefined || v === '' || v === 'NA' || v === 'NaN') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function int(v) { const n = num(v); return n != null && Number.isInteger(n) ? n : null; }

/* ------------------------------------------------------------------ NFL */
/** games.csv → { game_id: { market, final, espn_id } } for one season.
    spread_line is the HOME margin the market expects (positive = home
    favoured); the record's home_line is its negation. A row with both
    scores is final, and its line is the close. */
function parseNflverse(text, season) {
  const out = {};
  parseCsv(String(text || '')).forEach((r) => {
    if (season != null && String(r.season) !== String(season)) return;
    const sp = num(r.spread_line), tot = num(r.total_line);
    const hs = int(r.home_score), as = int(r.away_score);
    const final = hs != null && as != null;
    const line = sp == null ? null : (sp === 0 ? 0 : -sp);
    const q = (line != null || tot != null) ? { home_line: line, total: tot, source: 'nflverse', book: 'consensus' } : null;
    out[r.game_id] = {
      game_id: r.game_id, home: r.home_team, away: r.away_team, week: num(r.week),
      espn_id: r.espn || null,
      market: final ? null : q,
      close: final ? q : null,
      final: final ? { home_score: hs, away_score: as, source: 'nflverse' } : null,
    };
  });
  return out;
}

/* ------------------------------------------------------------------ CFB */
/** cfbfastR schedule → { game_id: { final } }. `completed` is the feed's own
    word; nothing is inferred from a date or a score. */
function parseCfbSchedule(text, season) {
  const out = {};
  parseCsv(String(text || '')).forEach((r) => {
    if (season != null && String(r.season) !== String(season)) return;
    const done = String(r.completed).toUpperCase() === 'TRUE';
    const hs = int(r.home_points), as = int(r.away_points);
    out[String(r.game_id)] = {
      game_id: String(r.game_id), home: r.home_team, away: r.away_team,
      final: done && hs != null && as != null ? { home_score: hs, away_score: as, source: 'cfbfastR' } : null,
    };
  });
  return out;
}

/* ------------------------------------------------------------------ ESPN */
/* "-3", "+3.5", "PK", "EVEN", "o46.5" → a number (or 0 for a pick'em). */
function parseLineText(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (/^(pk|pick|pick'?em|even)$/i.test(t)) return 0;
  const m = /^[ou]?\s*([+-]?\d+(?:\.\d+)?)$/i.exec(t);
  return m ? Number(m[1]) : null;
}

/**
 * One ESPN odds object → { home_line, total, book } in the record's
 * convention, or null. Three independent readings of the spread, in order
 * of how plainly ESPN states them:
 *   1  `details`: "UGA -3.5" — the favourite's abbreviation and its line
 *   2  `spread` magnitude + which side ESPN marks as the favourite
 *   3  `pointSpread.home.close.line` — the home side's own line
 * The first that reads is used. If another reading disagrees about WHICH
 * SIDE is favoured, the line is dropped: an orientation fault grades the
 * model against the wrong team, and a missing close is the honest answer.
 */
function espnLine(odds, homeAbbr, awayAbbr) {
  if (!odds || typeof odds !== 'object') return null;
  const reads = [];
  const det = odds.details != null ? String(odds.details).trim() : '';
  if (det) {
    if (/^(even|pk|pick'?em)$/i.test(det)) reads.push(0);
    else {
      const m = /^(.+?)\s+([+-]?\d+(?:\.\d+)?)$/.exec(det);
      if (m) {
        const ab = m[1].trim().toUpperCase(), n = -Math.abs(Number(m[2]));
        if (homeAbbr && ab === String(homeAbbr).toUpperCase()) reads.push(n);
        else if (awayAbbr && ab === String(awayAbbr).toUpperCase()) reads.push(-n);
      }
    }
  }
  const sp = num(odds.spread);
  const hf = odds.homeTeamOdds && odds.homeTeamOdds.favorite, af = odds.awayTeamOdds && odds.awayTeamOdds.favorite;
  if (sp != null) {
    if (sp === 0) reads.push(0);
    else if (hf === true && af !== true) reads.push(-Math.abs(sp));
    else if (af === true && hf !== true) reads.push(Math.abs(sp));
  }
  const ps = odds.pointSpread && odds.pointSpread.home;
  const pl = ps && parseLineText((ps.close && ps.close.line) || (ps.current && ps.current.line));
  if (pl != null) reads.push(pl);

  let home_line = reads.length ? reads[0] : null;
  if (home_line != null && reads.some((x) => Math.sign(x) !== Math.sign(home_line) && x !== 0 && home_line !== 0)) home_line = null;
  let total = num(odds.overUnder);
  if (total == null && odds.total && odds.total.over) total = parseLineText((odds.total.over.close && odds.total.over.close.line) || (odds.total.over.current && odds.total.over.current.line));
  if (home_line == null && total == null) return null;
  const book = (odds.provider && odds.provider.name) || null;
  return { home_line, total, source: 'espn', book };
}

function espnCompleted(st) {
  if (!st || st.completed !== true) return false;
  return !/POSTPONED|CANCEL|SUSPEND|FORFEIT/i.test(String(st.name || ''));
}

/** One ESPN competition (from a scoreboard event or a summary header) →
    { id, state, completed, market|close, final }. */
function espnGame(id, comp, oddsList) {
  comp = comp || {};
  const st = (comp.status && comp.status.type) || {};
  const side = (ha) => (comp.competitors || []).find((c) => c.homeAway === ha) || {};
  const home = side('home'), away = side('away');
  const hAb = home.team && home.team.abbreviation, aAb = away.team && away.team.abbreviation;
  const odds = (oddsList && oddsList.length ? oddsList : comp.odds) || [];
  let line = null;
  for (let i = 0; i < odds.length && !line; i++) line = espnLine(odds[i], hAb, aAb);
  const completed = espnCompleted(st);
  const state = st.state || (completed ? 'post' : null);
  const hs = int(home.score), as = int(away.score);
  return {
    id: String(id),
    home: (home.team && (home.team.displayName || home.team.location)) || null,
    away: (away.team && (away.team.displayName || away.team.location)) || null,
    state, completed,
    /* how many odds objects ESPN sent, parsed or not: the run log reports it */
    odds_n: odds.length,
    market: state === 'pre' ? line : null,
    close: completed ? line : null,
    final: completed && hs != null && as != null ? { home_score: hs, away_score: as, source: 'espn' } : null,
  };
}

function parseEspnScoreboard(json) {
  const out = {};
  ((json && json.events) || []).forEach((ev) => {
    if (!ev || ev.id == null) return;
    const comp = (ev.competitions && ev.competitions[0]) || {};
    out[String(ev.id)] = espnGame(ev.id, comp, comp.odds);
  });
  return out;
}

function parseEspnSummary(json, id) {
  const comp = json && json.header && json.header.competitions && json.header.competitions[0];
  if (!comp) return null;
  return espnGame(id || (json.header && json.header.id), comp, (json.pickcenter && json.pickcenter.length) ? json.pickcenter : comp.odds);
}

/* The ESPN scoreboard buckets games by the US Eastern calendar date. */
function etDate(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).replace(/-/g, '');
}

/* ------------------------------------------------------------- fetchers */
async function fetchText(url, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs || 30000);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctl.signal, headers: { 'user-agent': 'edgedesk-football-record' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally { clearTimeout(timer); }
}

module.exports = {
  URL_NFL, URL_CFB_SCHED, espnScoreboardUrl, espnSummaryUrl,
  parseNflverse, parseCfbSchedule, parseEspnScoreboard, parseEspnSummary, espnLine, espnGame, parseLineText, etDate, fetchText,
};
