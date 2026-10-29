#!/usr/bin/env node
/* ============================================================================
   SP+ INGEST — the request, the parse, the team map and the weekly sync,
   on MOCKED CollegeFootballData and MOCKED Supabase responses. No network.

   Run: node football/sp_plus/ingest.test.js
   ========================================================================== */
'use strict';
const C = require('./cfbd.js');
const S = require('./sync.js');

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; return; }
  fail++; console.log('FAIL | ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 400)));
}
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b }); }

const KEY = 'test-cfbd-key-0123456789';
/* a CollegeFootballData /ratings/sp row, in the shape the endpoint documents */
const sp = (team, overall, off, def, extra) => Object.assign({ year: 2026, team, conference: 'Sun Belt', rating: overall, ranking: 1,
  offense: { ranking: 1, rating: off }, defense: { ranking: 1, rating: def }, specialTeams: { rating: 0.4 } }, extra || {});
const PAYLOAD = [
  sp('James Madison', 9.8, 30.1, 20.3),
  sp('Troy', -4.2, 24.0, 28.2),
  sp('Middle Tennessee', -12.6, 21.4, 34.0),
  sp('Kennesaw State', -11.1, 19.9, 31.0),
  sp('Miami', 18.5, 38.0, 19.5),
  sp('Miami (OH)', -3.3, 22.0, 25.3),
  { year: 2026, team: 'nationalAverages', conference: null, rating: 0, offense: { rating: 26.3 }, defense: { rating: 26.3 } }
];
const SLATE = { season: 2026, current_week: { key: '2026:0:09', season: 2026, week: 9, season_type: 'regular' }, games: [] };
const res = (status, body, opts) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null },
  json: async () => { if (opts && opts.notJson) throw new Error('bad json'); return body; },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
function cfbdMock(status, body, opts) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); if (opts && opts.throws) throw opts.throws; return res(status, body, opts); };
  f.calls = calls;
  return f;
}
function dbMock(opts) {
  opts = opts || {};
  const posts = [];
  const f = async (url, init) => {
    const table = /\/rest\/v1\/([a-z_]+)/.exec(url)[1];
    posts.push({ url, table, body: JSON.parse(init.body), headers: init.headers });
    if (opts.missing) return res(404, { code: 'PGRST205', message: 'Could not find the table public.' + table + ' in the schema cache' });
    if (opts.fail) return res(400, { code: '23514', message: 'check constraint' });
    return res(201, '');
  };
  f.posts = posts;
  return f;
}
const db = (f) => ({ url: 'https://sb.test', key: 'service-role-secret', fetch: f, sleep: () => Promise.resolve() });
const NOW = '2026-10-27T15:17:00.000Z';

(async () => {
  /* ---------------------------------------------------------------- parse */
  {
    const p = C.parseSp(PAYLOAD, 2026);
    eq(p.rows.length, 6, 'parse: six team rows');
    eq(p.skipped.map((x) => x.team), ['nationalAverages'], 'parse: the national-averages row is skipped, not stored as a team');
    eq(p.rows[0], { source_team: 'James Madison', source_team_id: null, sp_overall: 9.8, sp_off: 30.1, sp_def: 20.3 }, 'parse: overall, offense and defense kept as given');
    eq(p.refusal, null, 'parse: a good payload is not refused');
    const bad = C.parseSp([sp('A', 1, 2, 3), { team: 'B', rating: 'x', offense: { rating: 1 }, defense: { rating: 1 } },
      { team: 'C', rating: 1, offense: {}, defense: { rating: 1 } }, { team: 'D', rating: 1, offense: { rating: 1 } },
      sp('E', 1, 2, 3, { year: 2025 }), sp('F', 150, 2, 3), { rating: 1 }], 2026);
    eq(bad.rows.map((r) => r.source_team), ['A'], 'parse: only the complete row survives');
    eq(bad.rejected.map((r) => r.reason), ['no finite overall rating', 'no finite offense rating', 'no finite defense rating',
      'year 2025 is not 2026', 'a rating outside +/-100', 'no team name'], 'parse: every rejected row says why, none is repaired');
    const dup = C.parseSp([sp('Troy', 1, 2, 3), sp('Troy', 4, 5, 6), sp('Navy', 1, 1, 1)], 2026);
    eq(dup.rows.map((r) => r.source_team), ['Navy'], 'parse: a team listed twice keeps neither copy');
    eq(C.parseSp({ error: 'nope' }, 2026).refusal, 'the payload is not a list of teams', 'parse: a non-list payload is refused');
    eq(C.parseSp([], 2026).refusal, 'no valid team rows in the payload', 'parse: an empty list is refused');
    eq(C.parseSp([sp('Navy', 1, 1, 1, { teamId: 2426 })], 2026).rows[0].source_team_id, '2426', 'parse: a numeric CFBD team id is kept for the identity check');
  }

  /* ----------------------------------------------------------------- hash */
  {
    const p = C.parseSp(PAYLOAD, 2026).rows;
    eq(C.payloadHash(p), C.payloadHash(p.slice().reverse()), 'hash: independent of row order');
    const moved = p.map((r) => Object.assign({}, r)); moved[0].sp_off += 0.1;
    ok(C.payloadHash(moved) !== C.payloadHash(p), 'hash: any rating change changes it');
    ok(/^[0-9a-f]{64}$/.test(C.payloadHash(p)), 'hash: a sha256 hex digest');
  }

  /* ------------------------------------------------- team map (real master) */
  {
    const names = ['James Madison', 'Miami', 'Miami (OH)', "Hawai'i", 'App State', 'UL Monroe', 'Southern Miss', 'Kennesaw State', 'San José State', 'Texas A&M']
      .map((n) => ({ source_team: n, source_team_id: null, sp_overall: 1, sp_off: 1, sp_def: 1 }));
    const m = C.mapTeams(names);
    eq(m.mapped.map((x) => x.team_id), ['jamesmadison', 'miami', 'miamioh', 'hawaii', 'appstate', 'ulmonroe', 'southernmiss', 'kennesawstate', 'sanjosestate', 'texasam'],
      'map: the schedule names, aliases and accents resolve through the identity master');
    eq(m.unmapped, [], 'map: and nothing in that list is left over');
    const odd = C.mapTeams([{ source_team: 'Narnia Tech', sp_overall: 1, sp_off: 1, sp_def: 1 }, { source_team: 'Ohio Bobcats', sp_overall: 1, sp_off: 1, sp_def: 1 }]);
    eq(odd.mapped, [], 'map: an unknown name and a prefix-only name map to nothing');
    eq(odd.unmapped.map((u) => u.source_team), ['Narnia Tech', 'Ohio Bobcats'], 'map: both are logged as unmapped');
    ok(/never guessed/.test(odd.unmapped[1].reason), 'map: a prefix match is refused, and says so', odd.unmapped[1]);
    const clash = C.mapTeams([{ source_team: 'Alabama', source_team_id: '2', sp_overall: 1, sp_off: 1, sp_def: 1 }]);
    eq(clash.mapped, [], 'map: a CFBD id and a name that name different teams map to nothing');
    const twice = C.mapTeams([{ source_team: 'Miami', sp_overall: 1, sp_off: 1, sp_def: 1 }, { source_team: 'Miami (FL)', sp_overall: 2, sp_off: 2, sp_def: 2 }]);
    eq(twice.mapped, [], 'map: two source names on one team: neither is trusted');
    eq(twice.unmapped.length, 2, 'map: and both are logged');
    const byId = C.mapTeams([{ source_team: 'Auburn', source_team_id: '2', sp_overall: 1, sp_off: 1, sp_def: 1 }]);
    eq(byId.mapped.map((x) => [x.team_id, x.how]), [['auburn', 'provider_id:cfbd']], 'map: a CFBD id that agrees with its name maps by id');
  }

  /* --------------------------------------------------------------- request */
  {
    const f = cfbdMock(200, PAYLOAD);
    const r = await C.fetchSp({ season: 2026, key: KEY, fetch: f });
    ok(r.ok && Array.isArray(r.body), 'request: a 200 returns the body');
    eq(f.calls[0].url, 'https://api.collegefootballdata.com/ratings/sp?year=2026', 'request: GET /ratings/sp for the season');
    eq(f.calls[0].init.headers.Authorization, 'Bearer ' + KEY, 'request: the key goes in a Bearer header');
    const nk = cfbdMock(200, PAYLOAD);
    const r0 = await C.fetchSp({ season: 2026, key: '', fetch: nk });
    ok(!r0.ok && /no CFBD_API_KEY/.test(r0.error) && nk.calls.length === 0, 'request: no key, no request', r0);
    const r401 = await C.fetchSp({ season: 2026, key: KEY, fetch: cfbdMock(401, { message: 'Unauthorized' }) });
    eq([r401.ok, r401.status], [false, 401], 'request: an HTTP error is a failure with its status');
    ok(r401.error.indexOf(KEY) < 0, 'request: the error never carries the key');
    const rj = await C.fetchSp({ season: 2026, key: KEY, fetch: cfbdMock(200, null, { notJson: true }) });
    ok(!rj.ok && /not JSON/.test(rj.error), 'request: a non-JSON answer is a failure');
    const rt = await C.fetchSp({ season: 2026, key: KEY, fetch: cfbdMock(0, null, { throws: Object.assign(new Error('x'), { name: 'AbortError' }) }) });
    ok(!rt.ok && /timed out/.test(rt.error), 'request: a timeout is a failure that says so');
  }

  /* ------------------------------------------------------------- the sync */
  const base = () => S.emptyDoc(2026);
  {
    const f = cfbdMock(200, PAYLOAD), d = dbMock();
    const r = await S.run({ now: NOW, slate: SLATE, doc: base(), key: KEY, cfbdFetch: f, db: db(d) });
    eq(r.status, 'OK', 'sync: a good capture is OK');
    const rat = d.posts.filter((p) => p.table === 'cfb_sp_ratings');
    eq(rat.length, 1, 'sync: one insert into cfb_sp_ratings');
    ok(/on_conflict=rating_id/.test(rat[0].url) && /ignore-duplicates/.test(rat[0].headers.prefer), 'sync: insert-only, a re-run is a no-op');
    eq(rat[0].body.length, 6, 'sync: one row per mapped team');
    const row = rat[0].body.find((x) => x.team_id === 'jamesmadison');
    eq([row.season, row.week, row.week_key, row.season_type, row.sp_overall, row.sp_off, row.sp_def, row.captured_at],
      [2026, 9, '2026:0:09', 'regular', 9.8, 30.1, 20.3, NOW], 'sync: the row carries season, week, team, overall/offense/defense and the capture time');
    ok(/^cfbsp_[0-9a-f]{24}$/.test(row.rating_id) && /^cfbss_[0-9a-f]{24}$/.test(row.snapshot_id), 'sync: deterministic ids');
    ok(/SP\+ by ESPN, Bill Connelly/.test(row.source) && /^cfbd-ratings-sp:2026:[0-9a-f]{12}$/.test(row.source_version), 'sync: source and source version recorded');
    const runs = d.posts.filter((p) => p.table === 'cfb_sp_sync_runs');
    eq([runs.length, runs[0].body[0].status, runs[0].body[0].n_mapped], [1, 'OK', 6], 'sync: the attempt is recorded as OK');
    eq(r.doc.snapshot.week_key, '2026:0:09', 'sync: the published file names the captured week');
    eq(r.doc.snapshot.teams_rated, 6, 'sync: and how many teams it rated');
    eq([r.doc.status, r.doc.last_attempt.status], ['OK', 'OK'], 'sync: status OK');
    const text = JSON.stringify(r.doc);
    ok(!/sp_overall|sp_off|sp_def|"rating"/.test(text), 'sync: the published file carries no SP+ rating field');
    ok(['30.1', '20.3', '24', '28.2', '38'].every((v) => text.indexOf(':' + v + ',') < 0 && text.indexOf(':' + v + '}') < 0), 'sync: and none of the rating values');
    ok(text.indexOf(KEY) < 0 && text.indexOf('service-role-secret') < 0, 'sync: and no credential');

    /* the same week again: nothing is fetched */
    const f2 = cfbdMock(200, PAYLOAD);
    const again = await S.run({ now: '2026-10-28T15:17:00.000Z', slate: SLATE, doc: r.doc, key: KEY, cfbdFetch: f2, db: db(dbMock()) });
    eq([again.status, f2.calls.length, again.doc], ['ALREADY_CAPTURED', 0, null], 'sync: a week already captured is not fetched again and nothing is rewritten');

    /* next week, identical numbers: SP+ has not been updated */
    const s10 = { season: 2026, current_week: { key: '2026:0:10', season: 2026, week: 10, season_type: 'regular' }, games: [] };
    const d3 = dbMock();
    const same = await S.run({ now: '2026-11-02T15:17:00.000Z', slate: s10, doc: r.doc, key: KEY, cfbdFetch: cfbdMock(200, PAYLOAD), db: db(d3) });
    eq(same.status, 'UNCHANGED', 'sync: an identical payload for a new week is UNCHANGED');
    eq(d3.posts.filter((p) => p.table === 'cfb_sp_ratings').length, 0, 'sync: and stores no rating row (they would be last week’s numbers under a new week)');
    eq(d3.posts.filter((p) => p.table === 'cfb_sp_sync_runs').map((p) => p.body[0].status), ['UNCHANGED'], 'sync: the attempt is recorded');
    eq([same.doc.snapshot.week_key, same.doc.status], ['2026:0:09', 'UNCHANGED'], 'sync: the published snapshot stays week 9, its status says UNCHANGED');
    ok(/not updated yet for week 2026:0:10/.test(same.doc.last_attempt.reason), 'sync: with the reason');

    /* next week, new numbers */
    const moved = PAYLOAD.map((x) => (x.team === 'Troy' ? Object.assign({}, x, { rating: -6.0 }) : x));
    const nxt = await S.run({ now: '2026-11-02T15:17:00.000Z', slate: s10, doc: r.doc, key: KEY, cfbdFetch: cfbdMock(200, moved), db: db(dbMock()) });
    eq([nxt.status, nxt.doc.snapshot.week_key], ['OK', '2026:0:10'], 'sync: new numbers for a new week are captured');

    /* --force in the same week: a second capture, appended */
    const d5 = dbMock();
    const forced = await S.run({ now: '2026-10-28T09:00:00.000Z', slate: SLATE, doc: r.doc, key: KEY, cfbdFetch: cfbdMock(200, moved), db: db(d5), force: true });
    eq(forced.status, 'OK', 'sync: --force takes a new capture in the same week');
    ok(forced.doc.snapshot.snapshot_id !== r.doc.snapshot.snapshot_id, 'sync: under its own snapshot id, beside the first');
  }

  /* ----------------------------------------------------- failures fail closed */
  {
    const nokey = await S.run({ now: NOW, slate: SLATE, doc: base(), key: '', cfbdFetch: cfbdMock(200, PAYLOAD), db: db(dbMock()) });
    eq([nokey.status, nokey.doc.snapshot], ['FAILED', null], 'fail: no key, nothing published');
    const e500 = await S.run({ now: NOW, slate: SLATE, doc: base(), key: KEY, cfbdFetch: cfbdMock(500, 'oops'), db: db(dbMock()) });
    ok(e500.status === 'FAILED' && /HTTP 500/.test(e500.reason), 'fail: a CFBD error is FAILED with its status', e500.reason);
    const junk = await S.run({ now: NOW, slate: SLATE, doc: base(), key: KEY, cfbdFetch: cfbdMock(200, { message: 'quota' }), db: db(dbMock()) });
    ok(junk.status === 'FAILED' && /refused/.test(junk.reason), 'fail: a payload that fails validation is refused', junk.reason);
    const none = await S.run({ now: NOW, slate: SLATE, doc: base(), key: KEY, cfbdFetch: cfbdMock(200, [sp('Narnia Tech', 1, 1, 1)]), db: db(dbMock()) });
    ok(none.status === 'FAILED' && /no SP\+ team mapped/.test(none.reason), 'fail: no team mapped');
    ok(none.doc.last_attempt && none.doc.last_attempt.status === 'FAILED', 'fail: the failed attempt is written to the published file');
    const nodb = await S.run({ now: NOW, slate: SLATE, doc: base(), key: KEY, cfbdFetch: cfbdMock(200, PAYLOAD), db: {} });
    ok(nodb.status === 'FAILED' && /no database credentials/.test(nodb.reason) && nodb.doc.snapshot === null, 'fail: no database, nothing published (fails closed)');
    const d6 = dbMock({ missing: true });
    const miss = await S.run({ now: NOW, slate: SLATE, doc: base(), key: KEY, cfbdFetch: cfbdMock(200, PAYLOAD), db: db(d6) });
    ok(miss.status === 'FAILED' && /apply supabase\/cfb_sp_plus\.sql/.test(miss.reason) && miss.doc.snapshot === null, 'fail: an unapplied migration says which file to apply', miss.reason);
    const bad = await S.run({ now: NOW, slate: SLATE, doc: base(), key: KEY, cfbdFetch: cfbdMock(200, PAYLOAD), db: db(dbMock({ fail: true })) });
    ok(bad.status === 'FAILED' && /storing the capture failed/.test(bad.reason), 'fail: any other database error fails the run');
    const noweek = await S.run({ now: NOW, slate: { games: [] }, doc: base(), key: KEY, cfbdFetch: cfbdMock(200, PAYLOAD), db: db(dbMock()) });
    ok(noweek.status === 'FAILED' && /no current week/.test(noweek.reason), 'fail: no current week on the slate');
    /* a failure keeps the last good capture where it was */
    const good = await S.run({ now: NOW, slate: SLATE, doc: base(), key: KEY, cfbdFetch: cfbdMock(200, PAYLOAD), db: db(dbMock()) });
    const s10 = { season: 2026, current_week: { key: '2026:0:10', season: 2026, week: 10, season_type: 'regular' }, games: [] };
    const later = await S.run({ now: '2026-11-02T15:17:00.000Z', slate: s10, doc: good.doc, key: KEY, cfbdFetch: cfbdMock(503, 'down'), db: db(dbMock()) });
    eq([later.status, later.doc.snapshot.week_key, later.doc.last_attempt.week_key], ['FAILED', '2026:0:09', '2026:0:10'],
      'fail: week 10 failed; the file still names week 9 as its capture, so no week-10 game can show week 9’s number');
    ok([nokey, e500, junk, none, nodb, miss, bad].every((x) => JSON.stringify(x.doc).indexOf(KEY) < 0), 'fail: no failure message carries the key');
  }

  /* ------------------------------------------------------------ the summary */
  {
    const r = await S.run({ now: NOW, slate: SLATE, doc: base(), key: KEY, cfbdFetch: cfbdMock(200, PAYLOAD.concat([sp('Narnia Tech', 1, 1, 1)])), db: db(dbMock()) });
    const s = S.summary(r);
    ok(/SP\+ sync: OK/.test(s) && /Narnia Tech/.test(s) && s.indexOf(KEY) < 0, 'summary: names the outcome and every unmapped team, and no key', s);
    eq(S.weekKey(2026, 'postseason', 1), '2026:1:01', 'week key: the postseason has its own key');
  }

  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
