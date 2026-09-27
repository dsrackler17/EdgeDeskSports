#!/usr/bin/env node
/* ============================================================================
   FETCH A FINISHED GAME — the final score and, more importantly, the box score.

   THE SOURCE CHAIN, tried in order, exactly the way tools/collective/
   settle_finals.js already does it, because a second opinion about which feed
   to trust is the last thing this repository needs:

     1  ESPN summary        the only source that carries TEAM STATISTICS, and
                            the only one that has them minutes after a game.
                            Keyless, public, already trusted here for rosters
                            and scoreboards.
     2  ESPN scoreboard     resolves the provider's event id for a game the
                            schedule feed does not carry one for, and carries
                            the final when the summary is not yet built.
     3  nflverse / cfbfastR the season CSVs this repository already reads.
                            Excellent for a finished week, useless for a
                            finished GAME — they fill on their own cadence.
     4  collective/settled  the committed settlement record. Needs no network
                            at all, so a build with no egress still knows the
                            score even though it will not have a box score and
                            therefore will not publish an article.

   EVERY SOURCE THAT CARRIES THE GAME IS KEPT, and results.reconcile() refuses
   to settle on a disagreement. A wrong final grades a model's record
   permanently and there is no undo.

   OFFLINE BY DEFAULT, like tools/articles/research_host.js: responses are
   cached under football/data/cache/ and a cache miss only reaches the network
   with --network. A miss is REPORTED, never faked into a zero.

     node tools/editorial/fetch_results.js --key NFL:2026_01_NE_SEA --network
     node tools/editorial/fetch_results.js --all --network
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CACHE_DIR = process.env.EDP_CACHE || path.join(ROOT, 'football', 'data', 'cache');
const RESULTS = require('./results.js');

const ESPN_PATH = { NFL: 'football/nfl', CFB: 'football/college-football' };
const URL_NFL_CSV = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const URL_CFB_CSV = y => `https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/schedules/csv/cfb_schedules_${y}.csv`;

function summaryUrl(sport, eventId) {
  return `https://site.api.espn.com/apis/site/v2/sports/${ESPN_PATH[sport]}/summary?event=${encodeURIComponent(eventId)}`;
}
function scoreboardUrl(sport, yyyymmdd) {
  const groups = sport === 'CFB' ? '&groups=80' : '';
  return `https://site.api.espn.com/apis/site/v2/sports/${ESPN_PATH[sport]}/scoreboard?dates=${yyyymmdd}&limit=400${groups}`;
}

function cacheNameFor(url) {
  const base = String(url).replace(/^https?:\/\//, '').replace(/[^A-Za-z0-9._-]/g, '_');
  return 'editorial_' + base.slice(-160);
}

/* ------------------------------------------------------------------ fetch */
/* Cache first, network only when asked, and a refusal is a REPORTED refusal.
   A source this cannot reach is a source the article says it could not
   reach — it is never a zero, an empty box score or an assumed final. */
function makeFetch(opts) {
  const network = !!opts.network;
  const seen = { served: [], refused: [], fetched: [] };
  async function get(url) {
    const cached = path.join(CACHE_DIR, cacheNameFor(url));
    if (fs.existsSync(cached) && !opts.fresh) {
      seen.served.push(url);
      return fs.readFileSync(cached, 'utf8');
    }
    if (!network) { seen.refused.push(url + ' — offline (pass --network)'); return null; }
    try {
      const r = await fetch(url, { redirect: 'follow' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const text = await r.text();
      try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(cached, text); } catch (_) {}
      seen.fetched.push(url);
      return text;
    } catch (e) {
      seen.refused.push(url + ' — ' + (e && e.message));
      return null;
    }
  }
  return [get, seen];
}

/* ----------------------------------------------------------------- helpers */
function ymd(iso) {
  const d = new Date(iso);
  if (!isFinite(+d)) return null;
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}
/* A game's kickoff can sit either side of UTC midnight relative to the US
   calendar day ESPN files it under, so both days are asked for. */
function datesAround(iso) {
  const t = Date.parse(iso);
  if (!isFinite(t)) return [];
  return [ymd(new Date(t - 864e5).toISOString()), ymd(iso), ymd(new Date(t + 864e5).toISOString())]
    .filter((v, i, a) => v && a.indexOf(v) === i);
}
function teamKey(s) {
  if (s == null) return '';
  let t = String(s).trim().toLowerCase();
  try { t = t.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (_) {}
  return t.replace(/[^a-z0-9]+/g, '');
}
/* Two spellings of one team. The feeds carry full names, locations and
   abbreviations; a match on the shorter of the two, with a floor, survives
   that without matching "State" to "Ohio State". */
function sameTeam(a, b) {
  const ka = teamKey(a), kb = teamKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const short = ka.length < kb.length ? ka : kb;
  const long = ka.length < kb.length ? kb : ka;
  /* A SIX-CHARACTER FLOOR ON A CONTAINMENT MATCH, so "state" never matches
     "Ohio State" and "sea" never matches "Seattle". Codes are therefore
     matched exactly, above, and a caller with a code passes the code. */
  return short.length >= 6 && long.indexOf(short) >= 0;
}
function parseCsv(text) {
  const lines = String(text).split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const head = splitCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const cells = splitCsvLine(line);
    const row = {};
    head.forEach((h, i) => { row[h] = cells[i] === undefined || cells[i] === 'NA' ? null : cells[i]; });
    return row;
  });
}
function splitCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/* --------------------------------------------------------- the event id */
/* nflverse's games.csv carries ESPN's own event id in an `espn` column, which
   is the clean join. cfbfastR's game_id IS the ESPN event id. Everything else
   falls back to matching two team names on a scoreboard day, which is the
   join settle_finals.js already uses and the reason it exists. */
async function resolveEventId(get, o, notes) {
  if (o.espn_id) return { id: String(o.espn_id), how: 'carried on the schedule row' };
  if (o.sport === 'CFB' && /^\d{6,}$/.test(String(o.game_id))) {
    return { id: String(o.game_id), how: 'the cfbfastR game_id is ESPN’s event id' };
  }
  if (o.sport === 'NFL') {
    const csv = await get(URL_NFL_CSV);
    if (csv) {
      const row = parseCsv(csv).filter(r => String(r.game_id) === String(o.game_id))[0];
      if (row && row.espn) return { id: String(row.espn), how: 'nflverse games.csv `espn` column' };
      if (row) notes.push({ source: 'nflverse', note: 'the schedule row carries no espn id' });
    } else notes.push({ source: 'nflverse', note: 'games.csv not reachable in this run' });
  }
  for (const d of datesAround(o.kickoff)) {
    const text = await get(scoreboardUrl(o.sport, d));
    if (!text) continue;
    let j = null;
    try { j = JSON.parse(text); } catch (_) { continue; }
    const hit = (j.events || []).filter(ev => {
      const comp = (ev.competitions || [])[0] || {};
      const h = (comp.competitors || []).filter(c => c.homeAway === 'home')[0];
      const a = (comp.competitors || []).filter(c => c.homeAway === 'away')[0];
      const hn = h && h.team && (h.team.displayName || h.team.location);
      const an = a && a.team && (a.team.displayName || a.team.location);
      return sameTeam(hn, o.home) && sameTeam(an, o.away);
    })[0];
    if (hit && hit.id != null) return { id: String(hit.id), how: 'matched on the ESPN scoreboard for ' + d };
  }
  return { id: null, how: null };
}

/* ------------------------------------------------------- the observations */
async function observe(o, opts) {
  opts = opts || {};
  const [get, seen] = makeFetch(opts);
  const notes = [];
  const observations = [];
  let finalSeenAt = null;

  /* 1 & 2 — ESPN */
  const ev = await resolveEventId(get, o, notes);
  if (ev.id) {
    notes.push({ source: 'espn', note: 'event id ' + ev.id + ' (' + ev.how + ')' });
    const text = await get(summaryUrl(o.sport, ev.id));
    if (text) {
      let j = null;
      try { j = JSON.parse(text); } catch (e) { notes.push({ source: 'espn_summary', error: 'unparseable JSON' }); }
      if (j) {
        const obs = RESULTS.normalizeSummary(j, { event_id: ev.id });
        if (obs && obs.home_score != null) {
          observations.push(obs);
          notes.push({ source: 'espn_summary', note: (obs.stat_fields_seen || []).length + ' box-score fields' });
        } else if (obs) {
          notes.push({ source: 'espn_summary', note: 'the summary carries no final score yet' });
        }
      }
    } else notes.push({ source: 'espn_summary', note: 'not reachable in this run' });
  } else {
    notes.push({ source: 'espn', note: 'no event id could be resolved for this game' });
  }
  /* the scoreboard, which carries a completed flag the summary does not
     always expose, and a status the readiness gate needs */
  for (const d of datesAround(o.kickoff)) {
    const text = await get(scoreboardUrl(o.sport, d));
    if (!text) continue;
    let j = null;
    try { j = JSON.parse(text); } catch (_) { continue; }
    const hit = (j.events || []).filter(e2 => (ev.id && String(e2.id) === ev.id)
      || matchesTeams(e2, o))[0];
    if (!hit) continue;
    const comp = (hit.competitions || [])[0] || {};
    const st = (comp.status && comp.status.type) || {};
    const side = ha => (comp.competitors || []).filter(c => c.homeAway === ha)[0] || {};
    const h = side('home'), a = side('away');
    const done = st.completed === true && !/POSTPONED|CANCEL|SUSPEND|FORFEIT/i.test(String(st.name || ''));
    observations.push(RESULTS.fromScore({
      provider: 'espn_scoreboard', event_id: hit.id != null ? String(hit.id) : null,
      home_team: (h.team && (h.team.displayName || h.team.location)) || o.home,
      away_team: (a.team && (a.team.displayName || a.team.location)) || o.away,
      home_score: h.score, away_score: a.score, completed: done,
      status_name: st.name || st.description
    }));
    if (done && !finalSeenAt) finalSeenAt = hit.date && comp.status && comp.status.displayClock ? null : null;
    notes.push({ source: 'espn_scoreboard', note: (st.name || 'unknown status') + ' on ' + d });
    break;
  }

  /* 3 — the season CSVs */
  if (o.sport === 'NFL') {
    const csv = await get(URL_NFL_CSV);
    if (csv) {
      const row = parseCsv(csv).filter(r => String(r.game_id) === String(o.game_id))[0];
      if (row && row.home_score != null && row.away_score != null) {
        observations.push(RESULTS.fromScore({ provider: 'nflverse',
          home_team: o.home, away_team: o.away,
          home_score: row.home_score, away_score: row.away_score, completed: true }));
        notes.push({ source: 'nflverse', note: 'final carried' });
      }
    }
  } else if (o.sport === 'CFB' && o.season) {
    const csv = await get(URL_CFB_CSV(o.season));
    if (csv) {
      const row = parseCsv(csv).filter(r => String(r.game_id) === String(o.game_id))[0];
      if (row && row.home_points != null && row.away_points != null
        && String(row.completed).toUpperCase() === 'TRUE') {
        observations.push(RESULTS.fromScore({ provider: 'cfbfastR',
          home_team: row.home_team || o.home, away_team: row.away_team || o.away,
          home_score: row.home_points, away_score: row.away_points, completed: true }));
        notes.push({ source: 'cfbfastR', note: 'final carried' });
      }
    }
  }

  /* 4 — the committed settlement record, which needs no network at all */
  const settled = settledRecord(o);
  if (settled) {
    observations.push(RESULTS.fromScore(Object.assign({ provider: 'collective settlement record' }, settled)));
    notes.push({ source: 'collective/settled', note: 'final carried' });
  }

  return { observations, notes, fetch_log: seen, event_id: ev.id, final_seen_at: finalSeenAt,
    closing: closingFrom(o, settled) };
}
function matchesTeams(ev, o) {
  const comp = (ev.competitions || [])[0] || {};
  const h = (comp.competitors || []).filter(c => c.homeAway === 'home')[0];
  const a = (comp.competitors || []).filter(c => c.homeAway === 'away')[0];
  return sameTeam(h && h.team && (h.team.displayName || h.team.location), o.home)
    && sameTeam(a && a.team && (a.team.displayName || a.team.location), o.away);
}

/* The committed settlement record, read straight off disk. It carries the
   Collective's OWN captured closing line as well as the score, which is the
   only closing number this repository holds for a football game. */
function settledRecord(o) {
  const codes = o.sport === 'NFL' ? codesFromNflGameId(o.game_id) : null;
  if (codes) o = Object.assign({}, o, {
    home_code: o.home_code || codes.home_code, away_code: o.away_code || codes.away_code,
    season: o.season || codes.season });
  const file = path.join(ROOT, 'collective', 'settled', String(o.sport).toUpperCase() + '_' + o.season + '.json');
  let j = null;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
  const games = (j && j.games) || {};
  const hit = Object.keys(games).map(k => games[k]).filter(g =>
    sameTeam(g.home, o.home_code || o.home) && sameTeam(g.away, o.away_code || o.away)
    && (!o.kickoff || !g.kickoff_at || Math.abs(Date.parse(g.kickoff_at) - Date.parse(o.kickoff)) < 3 * 864e5))[0];
  if (!hit || hit.home_score == null || hit.away_score == null) return null;
  return { home_team: o.home, away_team: o.away,
    home_score: hit.home_score, away_score: hit.away_score, completed: true,
    _closing_spread: hit.closing_spread, _closing_total: hit.closing_total,
    _close_source: hit.close_source };
}
/* THE CLOSING LINE, when one is held, expressed ONE WAY: `home_margin` is the
   margin the HOME side had to beat, so a home favourite is NEGATIVE — the
   same convention grading.impliedSide() uses for `market_home_margin`, which
   is what it is subtracted from.

   The two sources spell it differently and the conversion is stated rather
   than assumed:
     · the Collective's captured close writes the HOME team's own line, so
       "home -3" is stored as -3 and needs no conversion;
     · nflverse's `spread_line` is positive when the home side is favoured, so
       a home favourite of 3 is +3 there and -3 here.
   Getting this backwards would report closing-line value with the sign
   inverted on every game, which is worse than reporting none — so
   tools/editorial/editorial.test.js pins both conversions against a real
   settled game. NEVER estimated: with no captured close the grading record
   says so and closing-line value stays null. */
function closingFrom(o, settled) {
  if (settled && settled._closing_spread != null) {
    return { home_margin: Number(settled._closing_spread),
      total: settled._closing_total == null ? null : Number(settled._closing_total),
      source: 'EdgeDesk Collective captured close (' + (settled._close_source || 'collective') + ')' };
  }
  if (o.nflverse_spread_line != null) {
    return { home_margin: -Number(o.nflverse_spread_line),
      total: o.nflverse_total_line == null ? null : Number(o.nflverse_total_line),
      source: 'nflverse consensus closing line' };
  }
  return { home_margin: null, total: null, source: null,
    absent_reason: 'no closing line is held for this game: the Collective captured none and the schedule feed carries none. Closing-line value is left blank rather than estimated from the result.' };
}

/* The two team CODES an NFL game id already encodes — "2026_01_NE_SEA" is
   away NE at home SEA. The committed settlement record stores codes, not
   display names, so without this the offline join never matches an NFL game.
   Returns null for anything that is not that shape rather than guessing. */
function codesFromNflGameId(gameId) {
  const m = /^(\d{4})_(\d{2})_([A-Z]{2,3})_([A-Z]{2,3})$/.exec(String(gameId || ''));
  return m ? { season: +m[1], week: +m[2], away_code: m[3], home_code: m[4] } : null;
}

/* --------------------------------------------------------------- the whole */
/* One game in, one result record (or a stated refusal) out. */
async function fetchResult(o, opts) {
  opts = opts || {};
  const got = await observe(o, opts);
  const rec = RESULTS.reconcile(got.observations);
  rec.final_seen_at = opts.final_seen_at || got.final_seen_at || null;
  rec.kickoff = o.kickoff;
  rec.snapshot = opts.snapshot || null;
  return { reconciled: rec, notes: got.notes, fetch_log: got.fetch_log,
    event_id: got.event_id, closing: got.closing };
}

module.exports = {
  CACHE_DIR, ESPN_PATH, summaryUrl, scoreboardUrl, cacheNameFor,
  ymd, datesAround, teamKey, sameTeam, parseCsv, splitCsvLine,
  resolveEventId, observe, fetchResult, settledRecord, closingFrom, makeFetch,
  codesFromNflGameId
};

/* ------------------------------------------------------------------- CLI */
if (require.main === module) {
  const arg = (n, fb) => {
    const i = process.argv.indexOf('--' + n);
    if (i < 0) return fb;
    const v = process.argv[i + 1];
    return (v == null || v.startsWith('--')) ? true : v;
  };
  const key = arg('key', null);
  if (!key || key === true) {
    console.error('usage: node tools/editorial/fetch_results.js --key SPORT:game_id --home "X" --away "Y" --kickoff ISO [--season N] [--network]');
    process.exit(1);
  }
  const [sport, gameId] = String(key).split(':');
  fetchResult({ sport: sport, game_id: gameId, home: arg('home', null), away: arg('away', null),
    kickoff: arg('kickoff', null), season: +arg('season', 0) || null },
    { network: !!arg('network', false) })
    .then(out => { console.log(JSON.stringify(out, null, 2)); process.exit(0); })
    .catch(e => { console.error('fetch failed: ' + (e && e.stack || e)); process.exit(1); });
}
