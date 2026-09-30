#!/usr/bin/env node
/* ============================================================================
   CFB BOARD MARKET AUDIT — READ-ONLY.

   "The board says there is no market" and "the provider says there is" cannot
   both be right, so this reads what the provider actually delivered (the
   Model Lab's append-only quote ledger), what the board actually published
   (football/cfb_terminal/board.json, football/fbs/slate.json) and, when it is
   given one, the season schedule feed, and reports every place they disagree.
   It writes nothing to the repository and changes no state anywhere: its only
   output is the report it prints (or the files named by --md / --json, which
   are expected to live outside the tracked artifacts).

   For the selected week window it reports:
     A  provider events pulled -> events matched to a board game -> board games
        shown with a market, per source
     B  every unmatched provider event with the reason (name, date, id,
        orientation, outside the window), plus every provider team name the
        board's own resolver cannot place
     C  every board game whose Market field differs from the latest consensus
        by 1+ point, or names the other favourite
     D  every game the board flags stale / NO MARKET whose latest quote is under
        60 minutes old (and, separately, under the freshness window)
     E  every board game whose kickoff is outside the selected week, null, or a
        TBD placeholder the schedule feed marks start_time_tbd
     F  every team that appears more than once on the board
     G  the named spot-checks
     H  (--history) the same board across its committed hourly snapshots

   THE REFERENCE MARKET used by C and D is the rule the fix installs, stated
   here so the audit can measure the board against it:
     - spread quotes only; never an alternate, a provider-declared opener or
       close, or a post-kickoff quote;
     - a heartbeat row IS an observation: it is the Lab re-confirming an
       unchanged line, so it counts toward "latest";
     - latest quote per (source, book); provider averages ("consensus") are
       left out whenever a real sportsbook quotes the game;
     - current = captured within --fresh-minutes (default 360, six hours);
     - consensus = median of the current books' home lines;
     - age = now - MAX(observed_at) of the quotes used.

   THE WEEK is Tuesday 00:00 to the next Tuesday 00:00 in America/Chicago,
   the window containing --week-of (default: the board's own build time).

     node tools/football/cfb_board_audit.js [--season 2026]
          [--now ISO] [--week-of YYYY-MM-DD] [--fresh-minutes 360]
          [--schedule path/to/cfb_schedules_2026.csv] [--history]
          [--md FILE] [--json FILE]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
global.window = global.window || global;
const FBS = require(path.join(ROOT, 'football', 'fbs', 'fbs.js'));

function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || String(v).startsWith('--')) ? true : v;
}
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fb; } };
const readJsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); } catch (_) { return []; } };
const ms = (t) => { if (t == null || t === '') return null; const x = Date.parse(t); return isFinite(x) ? x : null; };
const iso = (t) => (t == null ? null : new Date(t).toISOString());
const num = (v) => (v == null || v === '' || !isFinite(+v) ? null : +v);
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const median = (xs) => { const s = xs.filter((x) => x != null).slice().sort((a, b) => a - b); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/* ------------------------------------------------ America/Chicago, no library */
const CHI = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
function chiParts(t) {
  const o = {}; CHI.formatToParts(new Date(t)).forEach((p) => { o[p.type] = p.value; });
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second, wd: o.weekday };
}
function chiOffsetMin(t) { const p = chiParts(t); return (Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(t / 1000) * 1000) / 60000; }
function chiMidnight(y, mo, d) {                 /* UTC ms of 00:00 local on that calendar day */
  let guess = Date.UTC(y, mo - 1, d, 0, 0, 0);
  for (let i = 0; i < 3; i++) guess = Date.UTC(y, mo - 1, d, 0, 0, 0) - chiOffsetMin(guess) * 60000;
  return guess;
}
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function weekWindow(t) {                         /* [Tue 00:00, next Tue 00:00) America/Chicago */
  const p = chiParts(t);
  const back = (WD[p.wd] - 2 + 7) % 7;
  const base = new Date(Date.UTC(p.y, p.mo - 1, p.d - back));
  const from = chiMidnight(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate());
  const nx = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + 7));
  return { from: from, to: chiMidnight(nx.getUTCFullYear(), nx.getUTCMonth() + 1, nx.getUTCDate()) };
}
function chiLabel(t) {
  if (t == null) return '—';
  const p = chiParts(t);
  return p.wd.toUpperCase() + ' ' + String(p.mo).padStart(2, '0') + '/' + String(p.d).padStart(2, '0') + ' '
    + ((p.h % 12) || 12) + ':' + String(p.mi).padStart(2, '0') + (p.h < 12 ? 'a' : 'p') + ' CT';
}

/* ------------------------------------------------------------ the schedule feed */
function parseCsv(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').filter(Boolean);
  if (!lines.length) return [];
  const split = (l) => { const o = []; let c = '', q = false; for (const ch of l) { if (ch === '"') { q = !q; continue; } if (ch === ',' && !q) { o.push(c); c = ''; continue; } c += ch; } o.push(c); return o; };
  const H = split(lines[0]);
  return lines.slice(1).map((l) => { const v = split(l); const o = {}; H.forEach((h, i) => { o[h] = v[i]; }); return o; });
}

/* ---------------------------------------------------------------- the rules */
function isRealBook(b) { return b && String(b).toLowerCase() !== 'consensus'; }
function spreadQuotesFor(rows, kickoff, now) {
  return rows.filter((q) => q.market_type === 'spread' && num(q.home_line) != null && !q.alternate
    && !q.is_provider_open && !q.is_provider_close && q.is_pregame !== false
    && ms(q.observed_at) != null && ms(q.observed_at) <= now && (kickoff == null || ms(q.observed_at) < kickoff));
}
/* the reference market: latest per (source, book) INCLUDING heartbeats, fresh
   within the window, real books over provider averages, median across books */
function referenceMarket(rows, kickoff, now, freshMin) {
  const q = spreadQuotesFor(rows, kickoff, now);
  const by = {};
  q.forEach((x) => {
    const k = x.source + '|' + String(x.book).toLowerCase();
    const cur = by[k];
    if (!cur || ms(x.observed_at) > ms(cur.observed_at) || (ms(x.observed_at) === ms(cur.observed_at) && String(x.quote_id) > String(cur.quote_id))) by[k] = x;
  });
  let latest = Object.values(by);
  if (latest.some((x) => isRealBook(x.book))) latest = latest.filter((x) => isRealBook(x.book));
  const fresh = latest.filter((x) => (now - ms(x.observed_at)) / 60000 <= freshMin);
  const newest = latest.length ? Math.max.apply(null, latest.map((x) => ms(x.observed_at))) : null;
  const newestFresh = fresh.length ? Math.max.apply(null, fresh.map((x) => ms(x.observed_at))) : null;
  return {
    books_seen: latest.length, books_fresh: fresh.length,
    consensus_home_line: fresh.length ? median(fresh.map((x) => +x.home_line)) : null,
    latest_home_line_any: latest.length ? median(latest.map((x) => +x.home_line)) : null,
    newest_age_min: newest == null ? null : Math.round((now - newest) / 60000),
    fresh_age_min: newestFresh == null ? null : Math.round((now - newestFresh) / 60000),
    books: fresh.map((x) => ({ source: x.source, book: x.book, home_line: +x.home_line, price_home: x.price_home, price_away: x.price_away,
      observed_at: x.observed_at, heartbeat: !!x.is_heartbeat }))
  };
}
/* the rule the terminal build applies today (football/cfb_terminal/build.js
   loadLedger + lib/cfb_terminal.js latestPerBook): heartbeats dropped, 180 min */
function boardRuleMarket(rows, kickoff, now) {
  const q = spreadQuotesFor(rows.filter((x) => !x.is_heartbeat), kickoff, now);
  const by = {};
  q.forEach((x) => { const k = String(x.book === 'consensus' ? x.source + ' consensus' : x.book).toLowerCase(); if (!by[k] || ms(x.observed_at) > ms(by[k].observed_at)) by[k] = x; });
  const latest = Object.values(by);
  const fresh = latest.filter((x) => (now - ms(x.observed_at)) / 60000 <= 180);
  const newest = latest.length ? Math.max.apply(null, latest.map((x) => ms(x.observed_at))) : null;
  return { books_fresh: fresh.length, newest_change_age_min: newest == null ? null : Math.round((now - newest) / 60000) };
}
function sideText(home, away, homeLine) {
  if (homeLine == null) return '—';
  if (homeLine === 0) return 'PK';
  return homeLine < 0 ? home + ' ' + r1(homeLine) : away + ' ' + r1(-homeLine);
}
const favOf = (hl) => (hl == null || hl === 0 ? null : (hl < 0 ? 'HOME' : 'AWAY'));

/* ------------------------------------------------------------------ the audit */
function audit(opts) {
  const season = +opts.season;
  const board = opts.board, slate = opts.slate, lastRun = opts.lastRun || {};
  const now = opts.now;
  const freshMin = opts.freshMin;
  const W = weekWindow(opts.weekOf != null ? opts.weekOf : now);
  const inWeek = (t) => t != null && t >= W.from && t < W.to;

  /* the schedule feed, when given: the only source of start_time_tbd */
  const sched = opts.scheduleRows || null;
  const schedById = {};
  (sched || []).forEach((r) => { schedById[String(r.game_id)] = r; });
  const tbd = (gid) => { const r = schedById[String(gid)]; return r ? /^(true|1|t)$/i.test(String(r.start_time_tbd || '')) : null; };

  /* the universe and resolver the board itself uses */
  const uniRows = (sched && sched.length ? sched : slate.games.map((g) => ({
    game_id: g.game_id, season: g.season, week: g.week, start_date: g.kickoff, completed: false, neutral_site: g.neutral_site,
    home_team: g.home_team, away_team: g.away_team, home_division: g.home_division, away_division: g.away_division,
    home_conference: g.home_conference, away_conference: g.away_conference })))
    .map((r) => Object.assign({}, r, { neutral_site: /^(true|1|t)$/i.test(String(r.neutral_site)), completed: /^(true|1|t)$/i.test(String(r.completed)) }));
  let P = null;
  try { require(path.join(ROOT, 'football', 'cfb_p4', 'params.js')); P = global.EDCfbP4Params; } catch (_) { P = null; }
  const uni = FBS.buildUniverse({ rows: uniRows, season: season, source: sched ? 'cfbfastR schedule' : 'slate.json', params: P,
    knownFbs: (P && P.rating && P.rating.seed_ratings) || null });
  const ix = FBS.teamIndex(uni);

  /* the ledger, every week */
  const base = path.join(ROOT, 'football', 'cfb_lab', 'ledger', String(season), 'quotes');
  const quotes = [];
  (fs.existsSync(base) ? fs.readdirSync(base) : []).filter((f) => /\.jsonl$/.test(f)).sort()
    .forEach((f) => readJsonl(path.join(base, f)).forEach((q) => quotes.push(q)));
  const qByGame = new Map();
  quotes.forEach((q) => { const k = String(q.game_id || ('evt:' + q.source + ':' + q.provider_event_id)); if (!qByGame.has(k)) qByGame.set(k, []); qByGame.get(k).push(q); });

  const rows = board.rows || [];
  const rowById = {}; rows.forEach((r) => { rowById[String(r.game_id)] = r; });
  const slateById = {}; slate.games.forEach((g) => { slateById[String(g.game_id)] = g; });
  const kickOf = (gid) => { const g = slateById[gid] || rowById[gid]; return g ? ms(g.kickoff || g.start_date) : null; };

  /* ----------------------------------------------------------- A. the funnel */
  const sources = {};
  const DAY = 24 * 3600e3;
  quotes.forEach((q) => {
    if (q.market_type !== 'spread') return;
    const t = ms(q.observed_at); if (t == null || t > now || now - t > DAY) return;
    const kick = ms(q.kickoff_ts) != null ? ms(q.kickoff_ts) : kickOf(String(q.game_id));
    const s = sources[q.source] = sources[q.source] || { events: new Set(), matched: new Set(), in_week: new Set() };
    const ev = String(q.provider_event_id || q.game_id);
    const k2 = kickOf(String(q.game_id)) != null ? kickOf(String(q.game_id)) : kick;
    if (!inWeek(k2)) return;
    s.events.add(ev);
    if (q.game_id != null && (slateById[String(q.game_id)] || rowById[String(q.game_id)])) s.matched.add(String(q.game_id));
  });
  const weekRows = rows.filter((r) => inWeek(ms(r.kickoff)) && tbd(r.game_id) !== true);
  const shown = rows.filter((r) => r.status !== 'NO_MARKET' && (r.books || 0) > 0);
  const funnel = Object.keys(sources).sort().map((s) => ({
    source: s, provider_events_pulled_24h: sources[s].events.size, matched_to_board_games: sources[s].matched.size,
    matched_and_shown_with_market: [...sources[s].matched].filter((g) => { const r = rowById[g]; return r && r.status !== 'NO_MARKET' && (r.books || 0) > 0; }).length
  }));
  const oddsApiRows = quotes.filter((q) => q.source === 'odds_api').length;

  /* ------------------------------------------------ C, D: per board game */
  const perGame = rows.map((r) => {
    const gid = String(r.game_id);
    const qs = qByGame.get(gid) || [];
    const kick = ms(r.kickoff);
    const ref = referenceMarket(qs, kick, now, freshMin);
    const rule = boardRuleMarket(qs, kick, now);
    return { r, gid, kick, ref, rule };
  });
  const cDiffs = perGame.filter((x) => x.ref.consensus_home_line != null || num(x.r.market_home_line) != null).map((x) => {
    const bl = num(x.r.market_home_line), cl = x.ref.consensus_home_line;
    const why = [];
    if (bl != null && cl != null && Math.abs(bl - cl) >= 1) why.push('differs by ' + r1(Math.abs(bl - cl)) + ' pts');
    if (bl != null && cl != null && favOf(bl) && favOf(cl) && favOf(bl) !== favOf(cl)) why.push('names the other favourite');
    if (bl != null && cl == null) why.push('the board shows a number but no book is current');
    if (bl == null && cl != null) why.push('the board shows no number but ' + x.ref.books_fresh + ' book(s) are current');
    if (x.r.status === 'NO_MARKET' && cl != null && bl != null) why.push('status NO MARKET while the line is live');
    return { x, why };
  }).filter((d) => d.why.length);

  const dStale = perGame.filter((x) => (x.r.market_stale || x.r.status === 'NO_MARKET') && x.ref.newest_age_min != null);
  const dUnder60 = dStale.filter((x) => x.ref.newest_age_min < 60);
  const dUnderWin = dStale.filter((x) => x.ref.books_fresh > 0);

  /* ------------------------------------------------------- B. unmatched */
  const unmatched = [];
  const seenEv = new Set();
  quotes.forEach((q) => {
    const t = ms(q.observed_at); if (t == null || t > now || now - t > DAY) return;
    const key = q.source + ':' + (q.provider_event_id || q.game_id);
    if (seenEv.has(key)) return; seenEv.add(key);
    const kick = ms(q.kickoff_ts);
    const gid = q.game_id != null ? String(q.game_id) : null;
    const onBoard = gid && rowById[gid];
    if (onBoard) {
      /* matched by id: still check the names and the orientation agree */
      const rh = FBS.resolveTeam(q.home_team, ix), ra = FBS.resolveTeam(q.away_team, ix);
      const bh = FBS.normKey(onBoard.home), ba = FBS.normKey(onBoard.away);
      if (rh && ra && rh.key && ra.key && rh.key === ba && ra.key === bh)
        unmatched.push({ source: q.source, event: q.provider_event_id, teams: q.away_team + ' @ ' + q.home_team, kickoff: kick, reason: 'ORIENTATION: provider home/away are the board game\'s away/home' });
      return;
    }
    const rh = FBS.resolveTeam(q.home_team, ix), ra = FBS.resolveTeam(q.away_team, ix);
    let reason;
    if (!rh || !rh.key) reason = 'NAME MISS: home "' + q.home_team + '" does not resolve' + (rh && rh.ambiguous ? ' (ambiguous ' + rh.ambiguous.join('/') + ')' : '');
    else if (!ra || !ra.key) reason = 'NAME MISS: away "' + q.away_team + '" does not resolve' + (ra && ra.ambiguous ? ' (ambiguous ' + ra.ambiguous.join('/') + ')' : '');
    else {
      const cand = rows.filter((r) => FBS.normKey(r.home) === rh.key && FBS.normKey(r.away) === ra.key);
      const swapped = rows.filter((r) => FBS.normKey(r.home) === ra.key && FBS.normKey(r.away) === rh.key);
      const near = (list) => list.filter((r) => kick == null || Math.abs(ms(r.kickoff) - kick) <= 36 * 3600e3);
      if (near(cand).length) reason = 'ID MISS: teams and kickoff match board game ' + near(cand)[0].game_id + ' but the provider id is ' + gid;
      else if (near(swapped).length) reason = 'ORIENTATION: teams match board game ' + near(swapped)[0].game_id + ' with home/away swapped';
      else if (cand.length) reason = 'DATE MISS: same teams on the board at ' + chiLabel(ms(cand[0].kickoff)) + ', provider kickoff ' + chiLabel(kick);
      else if (!inWeek(kick)) reason = 'OUTSIDE WEEK: provider kickoff ' + chiLabel(kick) + ' is not in the selected week (not a fault)';
      else reason = 'NO BOARD GAME: both teams resolve (' + rh.key + ' / ' + ra.key + ') but no board game has them';
    }
    unmatched.push({ source: q.source, event: q.provider_event_id, teams: q.away_team + ' @ ' + q.home_team, kickoff: kick, reason: reason });
  });
  /* every provider team name the board's resolver cannot place */
  const names = {};
  quotes.forEach((q) => { [q.home_team, q.away_team].forEach((n) => { if (n) names[n] = (names[n] || 0) + 1; }); });
  const nameMisses = Object.keys(names).sort().map((n) => ({ name: n, r: FBS.resolveTeam(n, ix) })).filter((o) => !o.r || !o.r.key)
    .map((o) => ({ name: o.name, rows: names[o.name], why: o.r && o.r.ambiguous ? 'ambiguous: ' + o.r.ambiguous.join(' / ') : 'unresolved' }));

  /* ---------------------------------------------- E. the week window, TBD */
  const outside = rows.filter((r) => !inWeek(ms(r.kickoff)) || ms(r.kickoff) == null || tbd(r.game_id) === true).map((r) => ({
    game_id: r.game_id, teams: r.away + ' @ ' + r.home, kickoff: r.kickoff, shown_as: chiLabel(ms(r.kickoff)), week: r.week,
    why: ms(r.kickoff) == null ? 'NULL kickoff' : (tbd(r.game_id) === true ? 'TBD placeholder (start_time_tbd) ' + (inWeek(ms(r.kickoff)) ? 'inside' : 'outside') + ' the week'
      : 'outside the selected week')
  }));
  const placeholderUtc = rows.filter((r) => /T0[45]:00:00(\.000)?Z$/.test(String(r.kickoff || ''))).length;

  /* ------------------------------------------------------ F. duplicates */
  const teamCount = {};
  rows.forEach((r) => { [r.home, r.away].forEach((t) => { (teamCount[t] = teamCount[t] || []).push(r); }); });
  const dups = Object.keys(teamCount).filter((t) => teamCount[t].length > 1).sort()
    .map((t) => ({ team: t, games: teamCount[t].map((r) => r.away + ' @ ' + r.home + ' (' + chiLabel(ms(r.kickoff)) + ')') }));

  /* --------------------------------------------------------- G. spot checks */
  const SPOT = [['Pittsburgh', 'Virginia Tech'], ['Michigan', 'Minnesota'], ['Alabama', 'Mississippi State'], ['Penn State', 'Northwestern'],
    ['West Virginia', 'Iowa State'], ['North Texas', 'Tulsa'], ['Miami', 'Clemson'], ['Ohio State', 'Iowa'], ['Temple', 'South Florida'],
    ['Marshall', 'James Madison'], ['Purdue', 'Illinois'], ['Virginia', 'Florida State'], ['Kentucky', 'South Carolina'], ['BYU', 'TCU'],
    ['Texas Tech', 'Colorado'], ['San José State', "Hawai'i"], ['Bowling Green', 'Miami (OH)'], ['Georgia', 'Alabama']];
  const spot = SPOT.map(([a, h]) => {
    const x = perGame.find((p) => p.r.away === a && p.r.home === h);
    if (!x) return { game: a + ' @ ' + h, on_board: false };
    const qs = qByGame.get(x.gid) || [];
    const opens = qs.filter((q) => q.market_type === 'spread' && q.is_provider_open).map((q) => q.source + ':' + q.book + ' ' + sideText(h, a, +q.home_line));
    return { game: a + ' @ ' + h, on_board: true, kickoff: chiLabel(x.kick), in_week: inWeek(x.kick) && tbd(x.gid) !== true,
      board_market: x.r.market, board_status: x.r.status, board_books: x.r.books, board_stale: x.r.market_stale, board_price_at: x.r.price_at || null,
      reference: sideText(h, a, x.ref.consensus_home_line), reference_books: x.ref.books_fresh, newest_quote_age_min: x.ref.newest_age_min,
      board_rule_books_fresh: x.rule.books_fresh, newest_change_age_min: x.rule.newest_change_age_min, provider_openers: opens };
  });

  /* ----------------------------------------------------------- the counts */
  const counts = {
    board_rows: rows.length, week_rows_confirmed: weekRows.length,
    board_no_market: rows.filter((r) => r.status === 'NO_MARKET').length,
    board_stale: rows.filter((r) => r.market_stale).length,
    board_market_fault: rows.filter((r) => r.research_label === 'MARKET_FAULT' || /MARKET_FAULT/.test(JSON.stringify(r.research || ''))).length,
    board_research_counts: (board.counts && board.counts.research) || null,
    week_games_with_current_reference_market: perGame.filter((x) => inWeek(x.kick) && tbd(x.gid) !== true && x.ref.books_fresh > 0).length,
    shown_with_market: shown.length,
    kickoff_placeholder_04_05Z: placeholderUtc
  };

  return { generated_at: new Date().toISOString(), as_of: iso(now), season: season, fresh_minutes: freshMin,
    week: { from: iso(W.from), to: iso(W.to), label: chiLabel(W.from) + ' → ' + chiLabel(W.to) },
    inputs: { board_generated_at: board.generated_at, slate_generated_at: slate.generated_at, slate_window: slate.window,
      schedule_rows: sched ? sched.length : 0, ledger_quotes: quotes.length, odds_api_rows_in_ledger: oddsApiRows,
      last_run: { started_at: lastRun.started_at || null, supabase_pull: (lastRun.steps && lastRun.steps.supabase_pull) || null,
        market_supabase: lastRun.steps && lastRun.steps.market && lastRun.steps.market.log ? lastRun.steps.market.log.supabase : null,
        dedupe: lastRun.steps && lastRun.steps.market ? lastRun.steps.market.dedupe : null } },
    counts: counts, funnel: funnel,
    unmatched: unmatched.filter((u) => !/^OUTSIDE WEEK/.test(u.reason)), outside_week_events: unmatched.filter((u) => /^OUTSIDE WEEK/.test(u.reason)).length,
    name_misses: nameMisses,
    market_vs_consensus: cDiffs.map((d) => ({ game_id: d.x.gid, teams: d.x.r.away + ' @ ' + d.x.r.home, board_market: d.x.r.market,
      board_market_home_line: num(d.x.r.market_home_line), reference: sideText(d.x.r.home, d.x.r.away, d.x.ref.consensus_home_line),
      reference_home_line: d.x.ref.consensus_home_line, reference_books: d.x.ref.books_fresh, status: d.x.r.status, why: d.why })),
    false_stale: { under_60_min: dUnder60.map((x) => ({ game_id: x.gid, teams: x.r.away + ' @ ' + x.r.home, status: x.r.status,
      newest_quote_age_min: x.ref.newest_age_min, newest_change_age_min: x.rule.newest_change_age_min, reference: sideText(x.r.home, x.r.away, x.ref.consensus_home_line) })),
      under_window: dUnderWin.length },
    outside_week: outside, duplicates: dups, spot: spot };
}

/* ------------------------------------------------------------------ history */
function historySnapshots() {
  let list = [];
  try { list = cp.execSync('git log --format=%H -- football/cfb_terminal/board.json', { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean); } catch (_) { return []; }
  return list.map((h) => { try { return { commit: h.slice(0, 7), board: JSON.parse(cp.execSync('git show ' + h + ':football/cfb_terminal/board.json', { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })) }; } catch (_) { return null; } }).filter(Boolean);
}

/* ------------------------------------------------------------------ markdown */
function toMarkdown(A, hist) {
  const L = [];
  const p = (s) => L.push(s == null ? '' : s);
  const tbl = (head, rows) => { p('| ' + head.join(' | ') + ' |'); p('|' + head.map(() => '---').join('|') + '|'); rows.forEach((r) => p('| ' + r.map((c) => String(c == null ? '—' : c).replace(/\|/g, '/')).join(' | ') + ' |')); p(); };
  p('# CFB board market audit (read-only)');
  p();
  p('As of **' + A.as_of + '** (the board build) · week **' + A.week.label + '** (America/Chicago, Tue→Tue) · freshness window **' + A.fresh_minutes + ' min**.');
  p('Inputs: board built ' + A.inputs.board_generated_at + ', slate built ' + A.inputs.slate_generated_at + ' (window ' + (A.inputs.slate_window && A.inputs.slate_window.lookahead_days) + ' days), '
    + A.inputs.ledger_quotes + ' ledger quotes, ' + A.inputs.schedule_rows + ' schedule rows.');
  p();
  p('## Counts');
  tbl(['measure', 'value'], Object.keys(A.counts).filter((k) => k !== 'board_research_counts').map((k) => [k, A.counts[k]]));
  if (A.counts.board_research_counts) tbl(['research label (board)', 'n'], Object.keys(A.counts.board_research_counts).map((k) => [k, A.counts.board_research_counts[k]]));
  p('## A. Provider events → matched → shown with a market (quotes seen in the last 24 h, kickoff in the week)');
  tbl(['source', 'provider events pulled', 'matched to board games', 'matched and shown with a market'], A.funnel.map((f) => [f.source, f.provider_events_pulled_24h, f.matched_to_board_games, f.matched_and_shown_with_market]));
  p('Odds API rows in the ledger: **' + A.inputs.odds_api_rows_in_ledger + '**. Last Lab run ' + A.inputs.last_run.started_at + ': supabase_pull ' + JSON.stringify(A.inputs.last_run.supabase_pull)
    + ', market.supabase ' + JSON.stringify(A.inputs.last_run.market_supabase) + ', dedupe ' + JSON.stringify(A.inputs.last_run.dedupe) + '.');
  p();
  p('## B. Unmatched provider events (' + A.unmatched.length + '; ' + A.outside_week_events + ' more are outside the week and not faults)');
  if (A.unmatched.length) tbl(['source', 'event', 'teams', 'kickoff', 'reason'], A.unmatched.map((u) => [u.source, u.event, u.teams, chiLabel(u.kickoff), u.reason]));
  else p('None in the ledger.'), p();
  p('Provider team names the board resolver cannot place: **' + A.name_misses.length + '**' + (A.name_misses.length ? '' : '.'));
  if (A.name_misses.length) tbl(['name', 'rows', 'why'], A.name_misses.map((n) => [n.name, n.rows, n.why]));
  p();
  p('## C. Market field vs the latest consensus (|Δ| ≥ 1, other favourite, or a live line hidden) — ' + A.market_vs_consensus.length + ' games');
  tbl(['game', 'board Market', 'status', 'latest consensus', 'books', 'why'], A.market_vs_consensus.map((d) => [d.teams, d.board_market, d.status, d.reference, d.reference_books, d.why.join('; ')]));
  p('## D. Flagged stale / NO MARKET with a quote under 60 minutes old — ' + A.false_stale.under_60_min.length + ' games (' + A.false_stale.under_window + ' inside the ' + A.fresh_minutes + '-min window)');
  tbl(['game', 'status', 'newest quote (min)', 'newest CHANGE row (min)', 'latest consensus'], A.false_stale.under_60_min.map((x) => [x.teams, x.status, x.newest_quote_age_min, x.newest_change_age_min, x.reference]));
  p('## E. Board games outside the selected week, NULL, or TBD — ' + A.outside_week.length + ' games');
  tbl(['game', 'kickoff (UTC)', 'shown as', 'week', 'why'], A.outside_week.map((o) => [o.teams, o.kickoff, o.shown_as, o.week, o.why]));
  p('## F. Teams on the board more than once — ' + A.duplicates.length);
  tbl(['team', 'games'], A.duplicates.map((d) => [d.team, d.games.join('<br>')]));
  p('## G. Spot checks');
  tbl(['game', 'kickoff', 'in week', 'board Market', 'status', 'books (board)', 'latest consensus', 'books (ref)', 'newest quote (min)', 'newest change (min)', 'price_at', 'provider opener'],
    A.spot.map((s) => s.on_board ? [s.game, s.kickoff, s.in_week, s.board_market, s.board_status, s.board_books, s.reference, s.reference_books, s.newest_quote_age_min, s.newest_change_age_min, s.board_price_at, (s.provider_openers || []).join(', ')]
      : [s.game, '—', '—', 'NOT ON BOARD', '—', '—', '—', '—', '—', '—', '—', '—']));
  if (hist && hist.length) {
    p('## H. The same board across its committed snapshots');
    tbl(['commit', 'built', 'rows', 'NO_MARKET', 'priced'], hist.map((h) => [h.commit, h.board.generated_at, h.board.counts.total, h.board.counts.NO_MARKET, h.board.counts.total - h.board.counts.NO_MARKET]));
    const flips = {};
    hist.slice().sort((a, b) => String(a.board.generated_at).localeCompare(String(b.board.generated_at))).forEach((h) => h.board.rows.forEach((r) => {
      const k = r.away + ' @ ' + r.home; (flips[k] = flips[k] || []).push(r.status === 'NO_MARKET' ? '·' : 'M'); }));
    const flappers = Object.keys(flips).filter((k) => /M·|·M/.test(flips[k].join(''))).sort();
    p('Games that flipped between priced (M) and NO MARKET (·) across snapshots with no line change needed: **' + flappers.length + '**');
    p();
    tbl(['game', 'sequence (oldest → newest)'], flappers.map((k) => [k, flips[k].join('')]));
  }
  return L.join('\n');
}

/* --------------------------------------------------------------------- main */
function main() {
  const season = +(arg('season', 2026));
  const board = readJson(path.join(ROOT, 'football', 'cfb_terminal', 'board.json'), null);
  const slate = readJson(path.join(ROOT, 'football', 'fbs', 'slate.json'), null);
  if (!board || !slate) { console.error('board.json or slate.json missing'); process.exit(2); }
  const lastRun = readJson(path.join(ROOT, 'football', 'cfb_lab', 'reports', String(season), 'last_run.json'), {});
  const now = ms(arg('now', null)) || ms(board.generated_at) || Date.now();
  const wo = arg('week-of', null);
  const schedPath = arg('schedule', path.join(ROOT, 'football', 'fbs', '.cache', 'cfb_schedules_' + season + '.csv'));
  const scheduleRows = fs.existsSync(schedPath) ? parseCsv(fs.readFileSync(schedPath, 'utf8')) : null;
  const A = audit({ season, board, slate, lastRun, now, freshMin: +(arg('fresh-minutes', 360)),
    weekOf: wo ? ms(wo + 'T18:00:00Z') : null, scheduleRows });
  const hist = arg('history', false) ? historySnapshots() : null;
  const md = toMarkdown(A, hist);
  const mdOut = arg('md', null), jsonOut = arg('json', null);
  if (mdOut) fs.writeFileSync(mdOut, md + '\n');
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(Object.assign({}, A, { history: hist ? hist.map((h) => ({ commit: h.commit, generated_at: h.board.generated_at, counts: h.board.counts })) : null }), null, 1));
  if (!mdOut && !jsonOut) console.log(md);
}

if (require.main === module) main();
module.exports = { audit, weekWindow, chiLabel, referenceMarket, boardRuleMarket, parseCsv };
