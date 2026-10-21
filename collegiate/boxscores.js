'use strict';
/* ===========================================================================
   EdgeDesk collegiate — a baseball box score, read from a school's own site.

   A SIDEARM box score page carries the whole game in its Nuxt data
   (pinia.boxscore): both teams with their NCAA team codes (the ids our
   college baseball record uses), the line score, every pitcher in order of
   appearance with innings, batters faced, strikeouts, walks and pitches,
   every starting batter with lineup spot, position and bats, each player's
   throwing hand, and the game's venue, attendance, scheduled innings,
   doubleheader flag and weather as the official scorer wrote it.

   Kept: what a model can use. The starter of each side is the pitcher with
   order of appearance 1. Weather is kept as written and split only where
   it reads plainly ("69, Mostly Cloudy, N 24 MPH" -> 69 F, Mostly Cloudy,
   wind N 24); anything else stays as written, never guessed.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { nuxtData } = require('./nuxt');

const DATA = path.join(__dirname, 'data');
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return d; } };

const num = (v) => { if (v === '' || v == null) return null; const n = +v; return Number.isFinite(n) ? n : null; };
/* innings pitched "4.1" = 4 innings and 1 out = 13 outs; a ".3" or worse is not an innings value */
function outsOf(ip) {
  const m = String(ip == null ? '' : ip).match(/^(\d+)(?:\.([012]))?$/);
  return m ? +m[1] * 3 + (+m[2] || 0) : null;
}
/* "Last, First" (and "Last,First") read as "First Last" */
const nameOf = (p) => { const n = p.playerFirstLastName || p.checkName || p.name || null; return n && /,/.test(n) ? n.split(',').map((s) => s.trim()).filter(Boolean).reverse().join(' ') : n; };
const hand = (h) => (/^[LRS]$/.test(String(h || '').toUpperCase()) ? String(h).toUpperCase() : /^B$/i.test(String(h || '')) ? 'S' : null);

function weather(w) {
  const raw = w && String(w).trim() && String(w).trim() !== '0' ? String(w).trim() : null;
  if (!raw) return { raw: null, temp_f: null, sky: null, wind_dir: null, wind_mph: null };
  const parts = raw.split(',').map((s) => s.trim());
  const t = parts[0] && /^-?\d{1,3}$/.test(parts[0]) ? +parts[0] : null;
  const wind = raw.match(/\b(N|NE|E|SE|S|SW|W|NW|NNE|ENE|ESE|SSE|SSW|WSW|WNW|NNW|L-R|R-L|IN|OUT|CALM)\b[^,\d]*(\d{1,2})\s*MPH/i);
  const sky = t != null && parts[1] && !/mph/i.test(parts[1]) ? parts[1] : null;
  return { raw, temp_f: t, sky, wind_dir: wind ? wind[1].toUpperCase() : null, wind_mph: wind ? +wind[2] : null };
}

function team(t) {
  const players = t.players || [];
  const pitchers = players.filter((p) => p.pitching).map((p) => ({ order: num(p.pitching.orderOfAppearance), name: nameOf(p), roster_player_id: p.rosterPlayerId || null,
    throws: hand(p.throws), outs: outsOf(p.pitching.inningsPitched), bf: num(p.pitching.battersFaced), k: num(p.pitching.strikeouts), bb: num(p.pitching.walksAllowed),
    h: num(p.pitching.hitsAllowed), r: num(p.pitching.runsAllowed), er: num(p.pitching.earnedRunsAllowed), hr: num(p.pitching.homerunsAllowed), pitches: num(p.pitching.pitches),
    started: p.pitching.gamesStarted === '1' }))
    .sort((a, b) => (a.order == null ? 99 : a.order) - (b.order == null ? 99 : b.order));
  const lineup = players.filter((p) => p.gameStarted === '1' && num(p.spot) >= 1 && num(p.spot) <= 9).map((p) => ({ spot: num(p.spot), name: nameOf(p), roster_player_id: p.rosterPlayerId || null, pos: p.position || null, bats: hand(p.bats) }))
    .sort((a, b) => a.spot - b.spot);
  const ss = t.scoringSummary || {};
  const line = String(ss.scoreByInnings || '').split(',').filter((x) => x !== '').map((x) => (x === 'X' || x === 'x' ? null : num(x)));
  return { code: t.code ? String(t.code) : null, name: t.name || null, runs: num(t.score != null ? t.score : ss.runs), hits: num(ss.hits), errors: num(ss.errors), line,
    starter: pitchers.find((p) => p.order === 1) || pitchers.find((p) => p.started) || null, pitchers, lineup };
}

/* SIDEARM: one game, or null when the page carries no box score */
function sidearmBoxscore(data) {
  const store = data && data.pinia && data.pinia.boxscore && data.pinia.boxscore.boxscore;
  if (!store || typeof store !== 'object') return null;
  const b = Object.values(store).find((x) => x && x.homeTeam && x.visitingTeam);
  if (!b) return null;
  const v = b.venue || {};
  const m = String(v.date || b.gameDate || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return {
    platform: 'sidearm', date: m ? m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0') : null,
    neutral: !!(v.isNeutral || b.isNeutral), conference: !!(v.isALeagueGame || b.isALeagueGame), scheduled_innings: num(v.scheduledInnings),
    doubleheader_game: num(v.doubleHeaderGame) || 0, attendance: num(String(v.attendance || '').replace(/,/g, '')), stadium: v.stadium || null, location: v.location || null,
    weather: weather(v.weather), home: team(b.homeTeam), away: team(b.visitingTeam),
  };
}

function parseBoxscore(html) {
  const data = nuxtData(html);
  if (!data) return null;
  return sidearmBoxscore(data);
}


/* ===========================================================================
   Collecting box scores: every final game with a box score in the schedules
   the collector holds (collegiate/data/schedules/<sport>/<season>/), read
   ONCE: from the home school's site when both schools' schedules are held
   (on a neutral site, the school whose id sorts first), else from the one
   school that lists it. Each read is kept compact (what a model uses), one
   line per game in collegiate/data/boxscores/<sport>/<season>/<school>.jsonl.gz.
   A per-host cap per run keeps a backfill to a few reads a minute per
   school; later runs continue where this one stopped.
   =========================================================================== */

function compact(x) {
  const pit = (p) => [p.name, p.throws, p.outs, p.bf, p.k, p.bb, p.h, p.er, p.pitches];
  const side = (t) => ({ code: t.code, name: t.name, runs: t.runs, hits: t.hits, errors: t.errors, line: t.line,
    starter: t.starter ? pit(t.starter) : null, pitchers: t.pitchers.map(pit), lineup: t.lineup.map((l) => [l.spot, l.name, l.pos, l.bats]) });
  return { date: x.date, neutral: x.neutral, conference: x.conference, scheduled_innings: x.scheduled_innings, doubleheader_game: x.doubleheader_game,
    attendance: x.attendance, weather: x.weather, home: side(x.home), away: side(x.away) };
}
const readLines = (f) => { try { return zlib.gunzipSync(fs.readFileSync(f)).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; } };
const writeLines = (f, rows) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, zlib.gzipSync(rows.map((r) => JSON.stringify(r)).join('\n') + '\n')); };

/* which games to read, and from which school: [{ school, host, season, game_key, url }] */
function plan(dataDir, sport, seasons, schools, platforms) {
  const byId = new Map(schools.map((s) => [s.id, s]));
  const byHost = new Map(schools.map((s) => [s.host, s.id]));
  const out = [];
  for (const season of seasons) {
    const dir = path.join(dataDir, 'schedules', sport, String(season));
    if (!fs.existsSync(dir)) continue;
    const held = new Map();
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) { const d = readJson(path.join(dir, f), null); if (d && byId.has(d.school)) held.set(d.school, d); }
    for (const [sid, d] of held) {
      if ((platforms[sid] || {}).platform !== 'sidearm') continue;
      for (const g of d.games || []) {
        if (g.status !== 'final' || !g.boxscore) continue;
        const opp = g.opponent_host ? byHost.get(g.opponent_host) : null;
        const oppReads = opp && held.has(opp) && (platforms[opp] || {}).platform === 'sidearm';
        /* the other school reads it when it is home, or (neutral) sorts first */
        if (oppReads && (g.site === 'A' || (g.site === 'N' && opp < sid))) continue;
        out.push({ school: sid, host: byId.get(sid).host, season, game_key: g.game_key, url: 'https://' + byId.get(sid).host + g.boxscore });
      }
    }
  }
  return out;
}

async function collect(o) {
  const RO = require('./rosters');
  const today = o.today || new Date().toISOString().slice(0, 10);
  const dataDir = o.dataDir || DATA;
  const sport = o.sport || 'baseball';
  const all = o.schoolsList || RO.loadSchools(dataDir);
  const division = o.division == null ? 1 : o.division;
  const schools = all.filter((s) => s.host && (division === 'all' || s.division === division));
  const platforms = readJson(path.join(dataDir, 'platforms.json'), {});
  const todo = plan(dataDir, sport, o.seasons, schools, platforms);
  /* what is already held */
  const heldKeys = new Map();
  const fileOf = (season, school) => path.join(dataDir, 'boxscores', sport, String(season), school + '.jsonl.gz');
  const keysOf = (season, school) => { const k = season + '|' + school; if (!heldKeys.has(k)) heldKeys.set(k, new Set(readLines(fileOf(season, school)).map((r) => r.game_key))); return heldKeys.get(k); };
  const pending = todo.filter((t) => !keysOf(t.season, t.school).has(t.game_key));
  const polite = o.polite || require('./polite').createPolite({ hosts: [...new Set(schools.map((s) => s.host))], cacheDir: path.join(__dirname, '..', '.cache', 'collegiate'), log: (m) => console.error(m) });
  const perHost = o.perHost || 100;
  const byHost = new Map();
  for (const t of pending) { if (!byHost.has(t.host)) byHost.set(t.host, []); byHost.get(t.host).push(t); }
  const results = [];
  const queue = [...byHost.values()];
  const lanes = Math.max(1, Math.min(o.lanes || 64, queue.length));
  await Promise.all(Array.from({ length: lanes }, async () => {
    for (let list = queue.shift(); list; list = queue.shift()) {
      const bySeason = new Map();
      for (const t of list.slice(0, perHost)) {
        const r = await polite.get(t.url, { ttlMs: 30 * 24 * 3600 * 1000, noStore: true });
        if (!r.ok) { results.push({ ok: false, code: r.refused ? 'REFUSED' : 'HTTP', t }); if (r.refused) break; continue; }
        const x = parseBoxscore(r.text());
        if (!x || !x.home.code || !x.away.code) { results.push({ ok: false, code: 'NO_BOXSCORE', t }); continue; }
        const k = t.season + '|' + t.school;
        if (!bySeason.has(k)) bySeason.set(k, []);
        bySeason.get(k).push(Object.assign({ game_key: t.game_key, school: t.school, url: t.url, read_at: today }, compact(x)));
        results.push({ ok: true, t });
      }
      /* write what this host gave, whatever happens to the others */
      for (const [k, rows] of bySeason) {
        const [season, school] = k.split('|');
        const f = fileOf(season, school);
        writeLines(f, readLines(f).concat(rows));
      }
    }
  }));
  const byCode = {};
  for (const r of results) if (!r.ok) byCode[r.code] = (byCode[r.code] || 0) + 1;
  return { planned: todo.length, pending: pending.length, ok: results.filter((r) => r.ok).length, left: pending.length - results.filter((r) => r.ok).length, misses_by_reason: byCode };
}

module.exports = { parseBoxscore, sidearmBoxscore, outsOf, weather, compact, plan, collect, readLines };
