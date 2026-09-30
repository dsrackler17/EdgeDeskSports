#!/usr/bin/env node
/* ============================================================================
   THE LIVE-BOARD MARKET AUDIT (supabase/audits/cfb_board_market_audit.sql),
   AGAINST A REAL POSTGRESQL.

   The audit is read-only and has to be: it is written to be pasted into the
   production SQL editor. So the first thing proved here is that it runs inside
   a READ ONLY transaction (a server refusing any write is the proof), and that
   the text holds no statement that could write.

   Then it is run against a replica of the board's inputs seeded with one case
   of every failure the board showed on the 2026 week 5 slate:
     - a stale MODAL row outvoting the current line   (Pitt @ VT -6.5 vs -3.5)
     - a provider listing home/away the other way round (WVU @ ISU) and an
       untimed cfb.lines row carrying the other favourite
     - a month-old zombie opener row                  (Miami -7 @ Clemson)
     - an alternate ladder under 'spreads'            (Tulsa -25.5)
     - an event the browser's 5,000-row fetch cuts off
     - a book name the resolver cannot place          ("Cal Golden Bears")
     - Odds API per-book quotes with game_id and season NULL
     - a book naming the other favourite, and one 8+ points off the median
     - a live DraftKings line the board calls NO MARKET
     - a TBD week-6 game on this week's slate, and a team shown twice
   and every one of them must surface in the section that names it.

   The replica's cfb_lab tables are the REAL contract (supabase/cfb_lab.sql),
   the ESPN / CFBD quotes are the committed ledger's own week-5 rows, and the
   schedule is the frozen cfbfastR weeks 5-6 fixture.

   Run: node tools/football/cfb_board_audit_sql.test.js
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const GEN = require(path.join(__dirname, 'cfb_board_audit_sql.js'));
global.window = global.window || global;
const FBS = require(path.join(ROOT, 'football', 'fbs', 'fbs.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function done(note) {
  if (note && /^SKIP/.test(note) && process.env.CFB_BOARD_SQL_REQUIRED === '1') { fail++; failures.push({ name: 'Postgres is required here but ' + note }); }
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 600) : '')));
  if (note) console.log(note);
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

/* ═══ STATIC ═══════════════════════════════════════════════════════════ */
const SQL = fs.readFileSync(GEN.OUT, 'utf8');
chk('the committed audit is exactly what the generator builds (no hand edits, no alias drift)', SQL === GEN.build());
/* comments and string literals out, so a word inside a message is not a statement */
const code = SQL.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n').replace(/'(?:[^']|'')*'/g, "''");
chk('no psql meta-command (the SQL editor cannot run one)', !SQL.split('\n').some((l) => l.trimStart().startsWith('\\')));
chk('one statement: a single terminating semicolon', (code.match(/;/g) || []).length === 1 && /;\s*$/.test(code));
chk('no statement that writes, creates, grants or runs a block',
  !/\b(insert\s+into|update\s+\w+\s+set|delete\s+from|truncate|create\s|drop\s|alter\s|grant\s|revoke\s|do\s+\$|copy\s|vacuum|refresh\s+materialized|call\s)/i.test(code), null);
const A = FBS.TEAM_ALIASES;
const pairs = []; Object.keys(A).forEach((k) => A[k].forEach((a) => pairs.push([k, a])));
chk('every fbs.js TEAM_ALIASES pair is in the audit alias list (' + pairs.length + ')',
  pairs.every(([k, a]) => SQL.includes("('" + k + "', '" + a.replace(/'/g, "''") + "')")));

/* ═══ LIVE ═════════════════════════════════════════════════════════════ */
const PG = require(path.join(ROOT, 'tools', 'personal', '_pg.js'));
const db = PG.start('cfbaudit');
if (!db || db.skip) done('SKIP | ' + ((db && db.skip) || 'no postgres') + ' — the LIVE layer did not run');

const NOW = '2026-09-30T19:36:54Z';
const T = (min) => new Date(Date.parse(NOW) + min * 60000).toISOString();
const J = (o) => '$j$' + JSON.stringify(o) + '$j$';
const h24 = (...p) => crypto.createHash('sha256').update(p.join('|')).digest('hex').slice(0, 24);

try {
  /* the replica of the board's other inputs: the columns app.html reads */
  db.sql(`
    create schema if not exists cfb;
    create table cfb.games (game_id bigint primary key, season int, week int, season_type text, start_date timestamptz,
      start_time_tbd boolean, completed boolean, neutral_site boolean, conference_game boolean, venue text,
      home_id int, home_team text, home_conference text, home_division text, home_points int,
      away_id int, away_team text, away_conference text, away_division text, away_points int);
    create table cfb.lines (game_id bigint, provider text, spread numeric, over_under numeric, home_moneyline int, away_moneyline int);
    create table public.signals (sig_key text primary key, event_id text, sport_key text, sport_title text, market text,
      selection text, point numeric, best_dec numeric, first_best_dec numeric, best_book text, n_books int,
      home_team text, away_team text, commence_time timestamptz, first_seen_at timestamptz, last_seen_at timestamptz,
      point_is_modal boolean, modal_point numeric);`);
  db.applyFile(path.join(ROOT, 'supabase', 'cfb_lab.sql'));

  /* the schedule: frozen cfbfastR weeks 5-6 */
  const SCHED = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'cfb_schedule_2026_wk05_06.json'), 'utf8')).rows;
  db.sql(`insert into cfb.games (game_id, season, week, season_type, start_date, start_time_tbd, completed, neutral_site, conference_game,
      home_team, home_conference, home_division, away_team, away_conference, away_division)
    select (r->>'game_id')::bigint, (r->>'season')::int, (r->>'week')::int, r->>'season_type', (r->>'start_date')::timestamptz,
      upper(r->>'start_time_tbd') = 'TRUE', upper(r->>'completed') = 'TRUE', upper(r->>'neutral_site') = 'TRUE', upper(r->>'conference_game') = 'TRUE',
      r->>'home_team', r->>'home_conference', r->>'home_division', r->>'away_team', r->>'away_conference', r->>'away_division'
    from jsonb_array_elements(${J(SCHED)}::jsonb) r`);
  const gid = (away, home) => { const r = SCHED.find((x) => x.away_team === away && x.home_team === home); if (!r) throw new Error('no game ' + away + ' @ ' + home); return r.game_id; };

  /* the Lab ledger's own week-5 ESPN / CFBD quotes, as they are in production */
  const LEDGER = fs.readFileSync(path.join(ROOT, 'football', 'cfb_lab', 'ledger', '2026', 'quotes', 'week_05.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((q) => Date.parse(q.observed_at) <= Date.parse(NOW));
  const QCOLS = ['quote_id', 'game_id', 'season', 'week', 'source', 'provider_event_id', 'book', 'market_type', 'home_line', 'total_points',
    'price_home', 'price_away', 'price_over', 'price_under', 'observed_at', 'provider_updated_at', 'kickoff_ts', 'is_heartbeat',
    'is_provider_open', 'is_provider_close', 'is_pregame', 'home_team', 'away_team', 'fingerprint', 'retrieved_at'];
  const insQuotes = (rows) => {
    for (let i = 0; i < rows.length; i += 800) {
      db.sql(`insert into public.cfb_lab_market_quotes (${QCOLS.join(', ')})
        select ${QCOLS.join(', ')} from jsonb_populate_recordset(null::public.cfb_lab_market_quotes, ${J(rows.slice(i, i + 800))}::jsonb)`);
    }
  };
  insQuotes(LEDGER);

  /* Odds API per-book quotes exactly as capture forwards them: game_id NULL,
     season NULL, week NULL, provider names lower-cased, home_line = the
     provider's HOME outcome point */
  const oq = [];
  function odds(ev, home, away, kick, book, homeLine, minAgo) {
    const q = { game_id: null, season: null, week: null, source: 'odds_api', provider_event_id: ev, book: book, market_type: 'spread',
      home_line: homeLine, price_home: -110, price_away: -110, observed_at: T(-minAgo), provider_updated_at: T(-minAgo - 2), kickoff_ts: kick,
      is_heartbeat: false, is_provider_open: false, is_provider_close: false, is_pregame: true,
      home_team: home.toLowerCase(), away_team: away.toLowerCase(), retrieved_at: T(-minAgo) };
    q.fingerprint = h24('fp', ev, book, homeLine, q.observed_at);
    q.quote_id = 'cfbq_' + h24(ev, book, q.observed_at);
    oq.push(q);
  }
  const KPITT = '2026-10-02T23:00:00Z', KWVU = '2026-10-03T16:00:00Z', KMICH = '2026-10-03T16:00:00Z';
  ['draftkings', 'fanduel'].forEach((b) => odds('oa_pitt_vt', 'Virginia Tech Hokies', 'Pittsburgh Panthers', KPITT, b, -3.5, 10));
  odds('oa_pitt_vt', 'Virginia Tech Hokies', 'Pittsburgh Panthers', KPITT, 'betmgm', -3, 10);
  /* the provider's own home/away is the schedule's away/home */
  ['draftkings', 'fanduel'].forEach((b) => odds('oa_wvu_isu', 'West Virginia Mountaineers', 'Iowa State Cyclones', KWVU, b, 3.5, 12));
  /* one book naming the other favourite, one 8.5 points off the median */
  ['draftkings', 'betmgm'].forEach((b) => odds('oa_mich_minn', 'Minnesota Golden Gophers', 'Michigan Wolverines', KMICH, b, 5.5, 15));
  odds('oa_mich_minn', 'Minnesota Golden Gophers', 'Michigan Wolverines', KMICH, 'fanduel', 6, 15);
  odds('oa_mich_minn', 'Minnesota Golden Gophers', 'Michigan Wolverines', KMICH, 'bovada', -5.5, 15);
  odds('oa_mich_minn', 'Minnesota Golden Gophers', 'Michigan Wolverines', KMICH, 'mybookieag', 14, 15);
  insQuotes(oq);

  /* the board's captured quotes (public.signals) */
  const sg = [];
  function sig(ev, home, away, kick, market, selection, point, o) {
    o = o || {};
    sg.push({ sig_key: 'sg_' + h24(ev, market, selection, point, o.tag || ''), event_id: ev, sport_key: 'americanfootball_ncaaf', sport_title: 'NCAAF',
      market: market, selection: selection, point: point, best_dec: o.dec || 1.91, first_best_dec: o.dec || 1.91, best_book: o.book || 'draftkings',
      n_books: o.n == null ? 1 : o.n, home_team: home, away_team: away, commence_time: kick,
      first_seen_at: T(-(o.first == null ? 3000 : o.first)), last_seen_at: T(-(o.seen == null ? 5 : o.seen)),
      point_is_modal: !!o.modal, modal_point: null });
  }
  /* Pitt @ VT: yesterday's modal rows still refreshed by one book, the market at -3.5 */
  const pv = ['e_a_pitt_vt', 'Virginia Tech Hokies', 'Pittsburgh Panthers', KPITT];
  sig(...pv, 'spreads', 'Virginia Tech Hokies', -6.5, { modal: true, n: 1, seen: 20 });
  sig(...pv, 'spreads', 'Pittsburgh Panthers', 6.5, { modal: true, n: 1, seen: 20 });
  sig(...pv, 'spreads', 'Virginia Tech Hokies', -3.5, { n: 7 });
  sig(...pv, 'spreads', 'Pittsburgh Panthers', 3.5, { n: 7 });
  sig(...pv, 'spreads', 'Pittsburgh Panthers', 3, { n: 2, dec: 1.95 });
  /* WVU @ ISU listed with home and away the other way round */
  const wv = ['e_b_wvu_isu', 'West Virginia Mountaineers', 'Iowa State Cyclones', KWVU];
  sig(...wv, 'spreads', 'Iowa State Cyclones', -3.5, { n: 6, modal: true });
  sig(...wv, 'spreads', 'West Virginia Mountaineers', 3.5, { n: 6, modal: true });
  /* Miami @ Clemson: a month-old opener row that never went away */
  const mc = ['e_c_miami_clemson', 'Clemson Tigers', 'Miami Hurricanes', '2026-10-03T23:30:00Z'];
  sig(...mc, 'spreads', 'Miami Hurricanes', -7, { n: 1, first: 37184, seen: 37184 });
  sig(...mc, 'spreads', 'Clemson Tigers', 7, { n: 1, first: 37184, seen: 37184 });
  sig(...mc, 'spreads', 'Miami Hurricanes', -16.5, { n: 6, modal: true, seen: 3 });
  sig(...mc, 'spreads', 'Clemson Tigers', 16.5, { n: 6, modal: true, seen: 3 });
  /* North Texas @ Tulsa: an alternate ladder stored under 'spreads' */
  const nt = ['e_d_unt_tulsa', 'Tulsa Golden Hurricane', 'North Texas Mean Green', '2026-10-02T01:00:00Z'];
  sig(...nt, 'spreads', 'Tulsa Golden Hurricane', -1.5, { n: 5, modal: true });
  sig(...nt, 'spreads', 'North Texas Mean Green', 1.5, { n: 5, modal: true });
  [-25.5, -7.5, 3.5].forEach((p) => sig(...nt, 'spreads', 'Tulsa Golden Hurricane', p, { n: 1, dec: 4.2 }));
  [25.5, 7.5, -3.5].forEach((p) => sig(...nt, 'spreads', 'North Texas Mean Green', p, { n: 1, dec: 1.2 }));
  /* a book name the resolver cannot place */
  sig('e_e_cal_unlv', 'UNLV Rebels', 'Cal Golden Bears', '2026-10-03T19:30:00Z', 'spreads', 'UNLV Rebels', -2.5, { n: 4, modal: true });
  sig('e_e_cal_unlv', 'UNLV Rebels', 'Cal Golden Bears', '2026-10-03T19:30:00Z', 'spreads', 'Cal Golden Bears', 2.5, { n: 4, modal: true });
  /* Temple @ USF: the event id that sorts last, so the row cap cuts it */
  const tu = ['e_zzz_temple_usf', 'South Florida Bulls', 'Temple Owls', '2026-10-03T23:30:00Z'];
  sig(...tu, 'h2h', 'South Florida Bulls', null, { n: 6 });
  sig(...tu, 'h2h', 'Temple Owls', null, { n: 6 });
  sig(...tu, 'spreads', 'South Florida Bulls', -6.5, { n: 6, modal: true });
  sig(...tu, 'spreads', 'Temple Owls', 6.5, { n: 6, modal: true });
  db.sql(`insert into public.signals select * from jsonb_populate_recordset(null::public.signals, ${J(sg)}::jsonb)`);

  /* cfb.lines: untimed, and for WVU @ ISU stored the other way round */
  db.sql(`insert into cfb.lines values (${gid('West Virginia', 'Iowa State')}, 'consensus', 2.5, 47.5, null, null),
                                       (${gid('Pittsburgh', 'Virginia Tech')}, 'consensus', -6.5, 50.5, null, null)`);

  /* the audit, as the editor sends it, at the board's build time */
  const cap = sg.filter((r) => r.event_id !== 'e_zzz_temple_usf').length + 2;
  const sqlAt = SQL.replace("now()   as now_ts,", `'${NOW}'::timestamptz as now_ts,`)
    .replace("now()   as week_of,", `'${NOW}'::timestamptz as week_of,`)
    .replace('5000    as app_row_cap,', cap + ' as app_row_cap,');
  chk('the params block was retargeted', sqlAt.includes(`'${NOW}'::timestamptz as now_ts`) && sqlAt.includes(cap + ' as app_row_cap'));

  /* read-only: it must run inside a READ ONLY transaction */
  const ro = db.mustFail(() => db.sql('begin read only;\n' + sqlAt + '\nrollback;'));
  chk('the audit runs inside a READ ONLY transaction', ro === null, ro);
  const out = JSON.parse(db.sql('select coalesce(json_agg(x), \'[]\'::json) from (' + sqlAt.replace(/;\s*$/, '') + ') x') || '[]');
  const rows = (sec) => out.filter((r) => r.section.startsWith(sec));
  const find = (sec, game, re) => rows(sec).find((r) => (game == null || r.game === game) && (!re || re.test([r.detail, r.a, r.b, r.c].join(' | '))));

  chk('PARAMS names the week (Tue 09/29 -> Tue 10/06, Chicago)', /Tue 09\/29 12:00am CT -> Tue 10\/06 12:00am CT/.test((rows('PARAMS')[0] || {}).detail || ''), rows('PARAMS'));
  const fOdds = find('A funnel · lab odds_api');
  chk('A: the Odds API funnel counts the pulled events, none with a game_id, all season NULL',
    fOdds && /pulled 3/.test(fOdds.a) && /with game_id 0/.test(fOdds.b) && /matchable by names 3/.test(fOdds.b) && /season NULL 3/.test(fOdds.b), fOdds);
  const fEspn = find('A funnel · lab espn');
  chk('A: the ESPN funnel sees the ledger\'s week-5 events with their ids', fEspn && /with game_id (\d+)/.test(fEspn.b) && +/with game_id (\d+)/.exec(fEspn.b)[1] >= 50, fEspn);
  const fSig = find('A funnel · signals');
  chk('A: the signals funnel reports pulled / matched / shown', fSig && /pulled 6/.test(fSig.a) && /matched 4/.test(fSig.b) && /shown LIVE \d+ · STALE \d+ · NO MARKET \d+ of \d+ week games/.test(fSig.c), fSig);

  chk('B: the swapped provider listing is an ORIENTATION miss',
    !!find('B unmatched · signals', 'Iowa State Cyclones @ West Virginia Mountaineers', /ORIENTATION/), rows('B unmatched · signals'));
  chk('B: "Cal Golden Bears" is a NAME MISS on the away side', !!find('B unmatched · signals', 'Cal Golden Bears @ UNLV Rebels', /NAME MISS: away "Cal Golden Bears"/));
  chk('B: the event past the row cap is TRUNCATED', !!find('B unmatched · signals', 'Temple Owls @ South Florida Bulls', /TRUNCATED: the browser receives 2 of 4 rows/), rows('B unmatched · signals'));
  chk('B: Odds API quotes with no game_id are ID MISSES that the names would have matched',
    !!find('B unmatched · lab odds_api', 'pittsburgh panthers @ virginia tech hokies', /ID MISS: no game_id and no event-map row; names and kickoff match game 401858245/), rows('B unmatched · lab'));
  chk('B: ... and the swapped one says so', !!find('B unmatched · lab odds_api', 'iowa state cyclones @ west virginia mountaineers', /ID MISS \+ ORIENTATION/));
  chk('B: the unresolved name is listed once', rows('B unresolved name').filter((r) => r.game === 'Cal Golden Bears').length === 1);

  const cPv = find('C market vs latest consensus', 'Pittsburgh @ Virginia Tech');
  chk('C: Pitt @ VT — the board\'s modal -6.5 against a -3.25 consensus',
    cPv && /differs by 3\.3/.test(cPv.detail) && /board LIVE: Virginia Tech -6\.5/.test(cPv.a) && /consensus Virginia Tech -3\.3 \(4 books\)/.test(cPv.b), cPv);
  const cWv = find('C market vs latest consensus', 'West Virginia @ Iowa State');
  chk('C: WVU @ ISU — the untimed cfb.lines row names the other favourite',
    cWv && /names the other favourite/.test(cWv.detail) && /untimed cfb\.lines/.test(cWv.detail) && /West Virginia -2\.5/.test(cWv.a) && /Iowa State -3\.5/.test(cWv.b), cWv);
  const cMi = find('C market vs latest consensus', 'Michigan @ Minnesota');
  chk('C: Michigan @ Minnesota — NO MARKET while books are current, consensus excludes the faulted books',
    cMi && /NO MARKET while books are current/.test(cMi.detail) && /consensus Michigan -5\.5 \(4 books\)/.test(cMi.b), cMi);

  chk('D: WKU @ NMSU — NO MARKET with a DraftKings heartbeat 29 minutes old',
    !!find('D false stale', 'Western Kentucky @ New Mexico State', /lab newest 29 min/), rows('D false stale'));

  chk('E: Georgia @ Alabama (week 6, TBD) is on this week\'s slate as a placeholder time',
    !!find('E slate outside the week', 'Georgia @ Alabama', /TBD kickoff/), rows('E slate outside the week').slice(0, 3));
  chk('E: a confirmed week-6 kickoff is outside the week', !!find('E slate outside the week', 'Iowa State @ BYU', /outside the selected week/));
  chk('E: no week-5 game is reported outside the week', !rows('E slate outside the week').some((r) => /week 5$/.test(r.b)));

  chk('F: Alabama appears twice (this week and the TBD week-6 game)', !!find('F team shown twice', 'Alabama', /Mississippi State/));

  chk('G: the book naming the other favourite is a DATA FAULT', !!find('G data fault · book vs median', 'Michigan @ Minnesota', /odds_api:bovada Minnesota -5\.5/), rows('G data fault · book'));
  chk('G: the book 8.5 points off the median is a DATA FAULT', !!find('G data fault · book vs median', 'Michigan @ Minnesota', /odds_api:mybookieag Michigan -14/));
  chk('G: the month-old Miami -7 rows are zombies', !!find('G data fault · zombie signals rows', 'Miami Hurricanes @ Clemson Tigers', /Miami Hurricanes -7/), rows('G data fault · zombie'));
  chk('G: the Tulsa alternate ladder is flagged', !!find('G data fault · alternate ladder under spreads', 'North Texas Mean Green @ Tulsa Golden Hurricane', /8 distinct spread points/));

  const sMc = find('S spot check', 'Miami @ Clemson');
  chk('S: Miami @ Clemson is LIVE at Miami -16.5 against the current rows', sMc && /board LIVE: Miami -16\.5/.test(sMc.detail), sMc);
  chk('S: Georgia @ Alabama is flagged NOT THIS WEEK', !!find('S spot check', 'Georgia @ Alabama', /NOT THIS WEEK/));
  chk('S: every named game on the slate has a spot-check row', rows('S spot check').length >= 17, rows('S spot check').length);
} catch (e) {
  chk('the live layer ran without an error', false, String(e.sqlMessage || e.message).slice(0, 1200));
} finally {
  db.stop();
}
done();
